import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  VAULT_KDF_DEFAULTS, generateVaultSigningKey, generateVaultTransportKey, joinVaultRootKey, newVaultHandle, openPasswordEnvelope, openRecoveryEnvelope, sealRecoveryEnvelope, openWithVaultPrivateKey,
  sealPasswordEnvelope, sealToVaultPublicKey, sealVaultEnvelope, signVaultMessage, splitVaultRootKey, vaultBase64url, vaultDelegationOperatorMessage,
  vaultDigest, vaultOperatorRequestMessage, vaultRandomBytes, vaultUnlockChallengeMessage, vaultSignupGrantOperatorMessage, type VaultKdfParams, type VaultOperatorSignedKind
} from "@space/contracts";
import { runVaultSignup } from "../src/vault/signup.js";
import { createVaultBroker, createVaultBrokerHttpServer } from "../src/vault/broker-server.js";
import { VaultBrokerRefusedError, createSocketVaultBroker, type VaultBroker } from "../src/vault/broker-client.js";
import { cliBrowserBridgeTokenHeader, issueCliBrowserBridgeToken } from "../src/cli-browser-bridge.js";
import { fixture } from "./support/vault-fakes.js";

// Plan clipboard:vEYtT6-bEN0J step 6, without root and without the Browser Host: the real broker (ARK-derived keys, its own
// HTTP-over-socket protocol) behind the real API routes, driven by the browser's crypto from @space/contracts. Synthetic ARK,
// password and credential only.
const SENTINEL = "SYNTHETIC-e2e-credential";
const PASSWORD = "SYNTHETIC e2e master password";
const b64 = vaultBase64url;
const owner = "user:alice";
const roots: string[] = [];
const closers: Array<() => void> = [];
afterEach(async () => {
  for (const close of closers.splice(0)) close();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
// Stands in for Argon2id (the browser's job, covered in apps/web); the chain is what this test proves.
const kdf = async (password: string, params: VaultKdfParams) => {
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: new Uint8Array(b64.decode(params.salt)), iterations: 1000 }, base, 256));
};
// The dock's unlock-key signature over a key change or delete (Vault review 2026-10-22).
const signed = async (vaultId: string, kind: VaultOperatorSignedKind, body: Record<string, unknown>, key: Uint8Array) =>
  ({ ...body, operatorSignature: await signVaultMessage(key, vaultOperatorRequestMessage(kind, { ownerUserId: owner, vaultId, ...body })) });

describe("Vault end to end: browser crypto, API routes and the real broker", () => {
  it("enrolls, unlocks only with password AND broker, delegates with the operator's signature, and revocation reaches the broker", async () => {
    const root = await mkdtemp(join(tmpdir(), "space-vault-e2e-"));
    roots.push(root);
    const core = await createVaultBroker({ ark: vaultRandomBytes(32), stateDir: join(root, "state") });
    const server = createVaultBrokerHttpServer(core);
    await new Promise<void>((resolve) => server.listen(join(root, "broker.sock"), resolve));
    closers.push(() => server.close());
    const harness = await fixture({ broker: createSocketVaultBroker(join(root, "broker.sock")) });
    const seen: string[] = [];
    try {
      const alice = await harness.session({ id: owner, email: "alice@space.local", role: "OPERATOR" });
      const as = async (method: "GET" | "PUT" | "POST", url: string, payload?: unknown) => {
        const answer = await harness.app.inject({ method, url, headers: alice.headers, payload: payload as never });
        seen.push(answer.body);
        return answer;
      };

      // Enrollment in the "browser".
      const vaultId = newVaultHandle("vault");
      const scope = { ownerUserId: owner, vaultId, keyVersion: 1 };
      const vrk = vaultRandomBytes(32);
      const { passwordShare, serverShare } = splitVaultRootKey(vrk);
      const unlockKey = await generateVaultSigningKey();
      const kdfParams = { ...VAULT_KDF_DEFAULTS, salt: b64.encode(vaultRandomBytes(16)) };
      const transport = (await as("GET", "/api/space-vault/broker")).json();
      const enrolled = await as("POST", "/api/space-vault/enroll", {
        vaultId, kdf: kdfParams, passwordEnvelope: await sealPasswordEnvelope(kdf, PASSWORD, kdfParams, { passwordShare, unlockPrivateKey: unlockKey.privateKey }, scope),
        sealedServerShare: await sealToVaultPublicKey(b64.decode(transport.publicKey), serverShare, scope), unlockPublicKey: b64.encode(unlockKey.publicKey), unlockKeyVersion: 1
      });
      expect(enrolled.statusCode).toBe(201);

      // Unlock: the password opens the signing key, the broker returns its share sealed to the reply key.
      const challenge = (await as("POST", "/api/space-vault/unlock/challenge", {})).json();
      await expect(openPasswordEnvelope(kdf, "wrong password", challenge.kdf, challenge.passwordEnvelope, scope)).rejects.toThrow();
      const secrets = await openPasswordEnvelope(kdf, PASSWORD, challenge.kdf, challenge.passwordEnvelope, scope);
      const reply = await generateVaultTransportKey();
      const replyPublicKey = b64.encode(reply.publicKey);
      const signature = await signVaultMessage(secrets.unlockPrivateKey, vaultUnlockChallengeMessage({ ownerUserId: owner, vaultId, epoch: challenge.epoch, challenge: challenge.challenge, replyPublicKey }));
      const unlocked = (await as("POST", "/api/space-vault/unlock", { challenge: challenge.challenge, replyPublicKey, signature })).json();
      const share = await openWithVaultPrivateKey(reply.privateKey, reply.publicKey, unlocked.sealedServerShare, scope);
      expect(joinVaultRootKey(secrets.passwordShare, share)).toEqual(vrk);
      // A forged signature (another key) gets nothing from the broker.
      const second = (await as("POST", "/api/space-vault/unlock/challenge", {})).json();
      const forged = await signVaultMessage((await generateVaultSigningKey()).privateKey, vaultUnlockChallengeMessage({ ownerUserId: owner, vaultId, epoch: second.epoch, challenge: second.challenge, replyPublicKey }));
      expect((await as("POST", "/api/space-vault/unlock", { challenge: second.challenge, replyPublicKey, signature: forged })).statusCode).toBeGreaterThanOrEqual(400);

      // Recovery (hardening step 14): the recovery key opens the recovery envelope, the broker answers as on unlock, and a
      // new master password replaces the old one under a new epoch, audited as RECOVERY_USE.
      const recoveryKey = vaultRandomBytes(32);
      expect((await as("PUT", "/api/space-vault/recovery", await signed(vaultId, "recovery", { keyVersion: 1, createdAt: new Date().toISOString(), epoch: challenge.epoch,
        envelope: await sealRecoveryEnvelope(recoveryKey, { passwordShare, unlockPrivateKey: unlockKey.privateKey }, scope) }, unlockKey.privateKey))).statusCode).toBe(200);
      const stored = (await as("GET", "/api/space-vault/recovery")).json().recovery;
      await expect(openRecoveryEnvelope(vaultRandomBytes(32), stored.envelope, scope)).rejects.toThrow();
      const recovered = await openRecoveryEnvelope(recoveryKey, stored.envelope, scope);
      const third = (await as("POST", "/api/space-vault/unlock/challenge", {})).json();
      const recoveryReply = await generateVaultTransportKey();
      const recoverySignature = await signVaultMessage(recovered.unlockPrivateKey, vaultUnlockChallengeMessage({ ownerUserId: owner, vaultId, epoch: third.epoch, challenge: third.challenge, replyPublicKey: b64.encode(recoveryReply.publicKey) }));
      const reopened = (await as("POST", "/api/space-vault/unlock", { challenge: third.challenge, replyPublicKey: b64.encode(recoveryReply.publicKey), signature: recoverySignature })).json();
      expect(joinVaultRootKey(recovered.passwordShare, await openWithVaultPrivateKey(recoveryReply.privateKey, recoveryReply.publicKey, reopened.sealedServerShare, scope))).toEqual(vrk);
      const newKdf = { ...VAULT_KDF_DEFAULTS, salt: b64.encode(vaultRandomBytes(16)) };
      const rotated = await as("POST", "/api/space-vault/password", await signed(vaultId, "password", { expectedEpoch: reopened.epoch, kdf: newKdf, recovery: true,
        passwordEnvelope: await sealPasswordEnvelope(kdf, `${PASSWORD}-new`, newKdf, recovered, scope), unlockPublicKey: b64.encode(unlockKey.publicKey), unlockKeyVersion: 1 }, recovered.unlockPrivateKey));
      expect(rotated.json()).toEqual({ epoch: reopened.epoch + 1 });
      const afterRecovery = (await as("POST", "/api/space-vault/unlock/challenge", {})).json();
      await expect(openPasswordEnvelope(kdf, PASSWORD, afterRecovery.kdf, afterRecovery.passwordEnvelope, scope)).rejects.toThrow();
      expect((await openPasswordEnvelope(kdf, `${PASSWORD}-new`, afterRecovery.kdf, afterRecovery.passwordEnvelope, scope)).passwordShare).toEqual(passwordShare);
      expect((await harness.repository.listAudit(owner, { limit: 10 })).map((entry) => entry.event.action)).toContain("RECOVERY_USE");

      // An agent-allowed item, then a delegation the operator signs and the broker certifies.
      const handle = newVaultHandle("vault_item");
      const dek = vaultRandomBytes(32);
      const itemScope = { ...scope, itemId: handle };
      const item = {
        metadata: { id: handle, label: "Synthetic login", origins: ["https://login.example"], fieldRoles: ["PASSWORD"], status: "ACTIVE",
          policy: { agentUse: true, approvalMode: "FULL", submitAllowed: false, maxFillsPerHour: 6, acceptedOriginRisks: [] } },
        keyVersion: 1, history: [], dekEnvelope: await sealVaultEnvelope(vrk, dek, { ...itemScope, purpose: "ITEM_KEY" }),
        fields: { PASSWORD: await sealVaultEnvelope(dek, new TextEncoder().encode(SENTINEL), { ...itemScope, purpose: "ITEM_FIELD", field: "PASSWORD" }) }
      };
      expect((await as("PUT", `/api/space-vault/items/${encodeURIComponent(handle)}`, item)).statusCode).toBe(200);
      const state = (await as("GET", "/api/space-vault/state")).json().vault;
      const fillKey = vaultRandomBytes(32);
      const generation = state.delegationGeneration + 1;
      const fillEnvelopes = { [handle]: { PASSWORD: await sealVaultEnvelope(fillKey, new TextEncoder().encode(SENTINEL), { ...itemScope, purpose: "FILL_FIELD", field: "PASSWORD", generation }) } };
      const items = [{ handle, origins: ["https://login.example"], fields: ["PASSWORD" as const], approvalMode: "FULL" as const, submit: false }];
      const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
      const envelopeDigest = await vaultDigest(fillEnvelopes);
      const operatorSignature = await signVaultMessage(secrets.unlockPrivateKey, vaultDelegationOperatorMessage({ ownerUserId: owner, vaultId, envelopeDigest, generation, unlockEpoch: state.epoch, expiresAt, items }));
      const delegate = (extra: Record<string, unknown> = {}) => as("POST", "/api/space-vault/delegations", {
        items, fillEnvelopes, generation, unlockEpoch: state.epoch, expiresAt, operatorSignature, ...extra });
      const sealedFillKey = await sealToVaultPublicKey(b64.decode(transport.publicKey), fillKey, scope);
      // The broker refuses a signature over anything else (here: another key's).
      const wrong = await signVaultMessage((await generateVaultSigningKey()).privateKey, new TextEncoder().encode("x"));
      expect((await delegate({ sealedFillKey, operatorSignature: wrong })).json().error.code).toBe("VAULT_DELEGATION_REFUSED");
      expect((await delegate({ sealedFillKey })).json()).toEqual({ generation });

      // Agent access is off until the operator turns it on in the dock, so every agent call is BLOCKED.
      const room = (await as("POST", "/api/rooms", { name: "E2E", initialPaneCount: 0 })).json();
      const pane = harness.store.createPane({ roomId: room.id, title: "Claude", mode: "TERMINAL", terminalRuntimeId: "cli:claude" });
      const cli = harness.store.createPaneCliSession({ paneId: pane.id, roomId: room.id, runtimeId: "cli:claude", providerId: "claude", agentId: "claude", status: "RUNNING", purpose: "NORMAL" });
      const token = issueCliBrowserBridgeToken(harness.config, { roomId: room.id, paneId: pane.id, cliSessionId: cli.sessionId })!;
      const agent = await harness.app.inject({ method: "POST", url: "/api/cli/space-vault/fill", headers: { [cliBrowserBridgeTokenHeader]: token, "content-type": "application/json" }, payload: { handle, fields: ["PASSWORD"] } });
      seen.push(agent.body);
      expect(agent.json()).toMatchObject({ status: "BLOCKED" });

      // Revoking through the API raises the broker's own floor: the old certificate gets no capability any more.
      const certificate = (await harness.repository.getActiveDelegation(owner))!.certificate;
      expect((await as("POST", "/api/space-vault/revoke", {})).json()).toMatchObject({ generation: generation + 1 });
      const use = await core.handle("POST", "/v1/use", { ownerUserId: owner, vaultId, certificate, epoch: state.epoch, handle, fields: ["PASSWORD"], submit: false,
        paneId: pane.id, targetId: "t", pageId: "t", frameId: "f", origin: "https://login.example" });
      expect(use.body).toEqual({ error: "GENERATION_RETIRED" });

      // Nothing secret ever crossed the API.
      const all = seen.join("\n");
      for (const secret of [SENTINEL, PASSWORD, b64.encode(vrk), b64.encode(passwordShare), b64.encode(serverShare)]) expect(all).not.toContain(secret);
    } finally {
      await harness.app.close();
    }
  });

  it("signs a sign-up grant in the dock, and a NEW_ACCOUNT fill under it lands in the inbox only while agent access is on", async () => {
    const root = await mkdtemp(join(tmpdir(), "space-vault-e2e-"));
    roots.push(root);
    const core = await createVaultBroker({ ark: vaultRandomBytes(32), stateDir: join(root, "state") });
    const server = createVaultBrokerHttpServer(core);
    await new Promise<void>((resolve) => server.listen(join(root, "broker.sock"), resolve));
    closers.push(() => server.close());
    const broker = createSocketVaultBroker(join(root, "broker.sock"));
    const harness = await fixture({ broker });
    const seen: string[] = [];
    try {
      const alice = await harness.session({ id: owner, email: "alice@space.local", role: "OPERATOR" });
      const as = async (method: "GET" | "PUT" | "POST" | "DELETE", url: string, payload?: unknown) => {
        const answer = await harness.app.inject({ method, url, headers: alice.headers, payload: payload as never });
        seen.push(answer.body);
        return answer;
      };
      const vaultId = newVaultHandle("vault");
      const scope = { ownerUserId: owner, vaultId, keyVersion: 1 };
      const { passwordShare, serverShare } = splitVaultRootKey(vaultRandomBytes(32));
      const unlockKey = await generateVaultSigningKey();
      const kdfParams = { ...VAULT_KDF_DEFAULTS, salt: b64.encode(vaultRandomBytes(16)) };
      const transport = (await as("GET", "/api/space-vault/broker")).json();
      expect((await as("POST", "/api/space-vault/enroll", {
        vaultId, kdf: kdfParams, passwordEnvelope: await sealPasswordEnvelope(kdf, PASSWORD, kdfParams, { passwordShare, unlockPrivateKey: unlockKey.privateKey }, scope),
        sealedServerShare: await sealToVaultPublicKey(b64.decode(transport.publicKey), serverShare, scope), unlockPublicKey: b64.encode(unlockKey.publicKey), unlockKeyVersion: 1
      })).statusCode).toBe(201);
      const inbox = await generateVaultTransportKey();
      await as("PUT", "/api/space-vault/inbox", await signed(vaultId, "inbox", { publicKey: b64.encode(inbox.publicKey), privateKeyEnvelope: await sealVaultEnvelope(vaultRandomBytes(32), inbox.privateKey, { ...scope, purpose: "INBOX_KEY" }),
        epoch: (await as("GET", "/api/space-vault/state")).json().vault.epoch }, unlockKey.privateKey));

      // The dock signs exact sites, a cap and an expiry with the unlock key; the broker certifies, the API stores.
      const epoch = (await as("GET", "/api/space-vault/state")).json().vault.epoch;
      const grantBody = async (sites: string[], dailyCap: number, extra: Record<string, unknown> = {}) => {
        const grant = { grantId: newVaultHandle("vault_grant"), sites, dailyCap, unlockEpoch: epoch, expiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString(), ...extra };
        return { ...grant, operatorSignature: await signVaultMessage(unlockKey.privateKey, vaultSignupGrantOperatorMessage({ ownerUserId: owner, vaultId, ...grant } as never)) };
      };
      expect((await as("POST", "/api/space-vault/signup-grants", await grantBody(["https://*.shop.example"], 3))).statusCode).toBe(422);
      expect((await as("POST", "/api/space-vault/signup-grants", await grantBody(["https://shop.example"], 11))).statusCode).toBe(422);
      expect((await as("POST", "/api/space-vault/signup-grants", await grantBody(["https://shop.example"], 1, { unlockEpoch: epoch + 1 }))).json().error.code).toBe("VAULT_GRANT_REFUSED");
      const forged = { ...await grantBody(["https://shop.example"], 1), operatorSignature: await signVaultMessage((await generateVaultSigningKey()).privateKey, new TextEncoder().encode("x")) };
      expect((await as("POST", "/api/space-vault/signup-grants", forged)).json().error.code).toBe("VAULT_GRANT_REFUSED");
      const body = await grantBody(["https://shop.example"], 1);
      const created = await as("POST", "/api/space-vault/signup-grants", body);
      expect(created.statusCode).toBe(201);
      expect((await as("GET", "/api/space-vault/signup-grants")).json().grants).toEqual([created.json().grant]);
      expect(created.json().grant).toMatchObject({ id: body.grantId, sites: ["https://shop.example"], dailyCap: 1, revokedAt: null });

      // The Browser Host's side, without a page: the host socket alone answers /v1/signup, sealed to the host's own reply key.
      const hostServer = createVaultBrokerHttpServer(core, "host");
      await new Promise<void>((resolve) => hostServer.listen(join(root, "host.sock"), resolve));
      closers.push(() => hostServer.close());
      const host = createSocketVaultBroker(join(root, "host.sock"));
      const reply = await generateVaultTransportKey();
      const asked = (request: { certificate: unknown; ownerUserId: string; vaultId: string; origin: string; paneId: string; roles: Array<"NEW_PASSWORD" | "CONFIRM_PASSWORD">; inboxPublicKey: string }) => ({
        ownerUserId: request.ownerUserId, vaultId: request.vaultId, certificate: request.certificate, origin: request.origin, paneId: request.paneId, roles: request.roles,
        inboxPublicKey: request.inboxPublicKey, replyPublicKey: b64.encode(reply.publicKey), field: { minLength: null, maxLength: null } });
      let typed: string | null = null;
      const fill = async (request: Parameters<Parameters<typeof runVaultSignup>[0]["fill"]>[0]) => {
        // The API's socket never gets the generated password.
        await expect(broker.signup(asked(request))).rejects.toThrow();
        try {
          const sealed = await host.signup(asked(request));
          typed = JSON.parse(new TextDecoder().decode(await openWithVaultPrivateKey(reply.privateKey, reply.publicKey, sealed.sealedFields, scope))).NEW_PASSWORD;
          return { status: "FILLED" as const, reason: null, sealedGenerated: sealed.sealedPassword };
        } catch (error) {
          return { status: "BLOCKED" as const, reason: (error as { reason?: string }).reason ?? "BROKER_REFUSED", sealedGenerated: null };
        }
      };
      const signup = (origin = "https://shop.example") => runVaultSignup({ repository: harness.repository, fill },
        { owner, paneId: "pane:vaultpane1", target: { targetId: "target-1", frameId: "frame-1", origin }, label: "Synthetic shop", username: "synthetic@example.com", roles: ["NEW_PASSWORD"], submit: false });

      // Option B opens nothing by itself: with agent access off the agent's NEW_ACCOUNT call is BLOCKED and nothing waits.
      const room = (await as("POST", "/api/rooms", { name: "E2E grants", initialPaneCount: 0 })).json();
      const pane = harness.store.createPane({ roomId: room.id, title: "Claude", mode: "TERMINAL", terminalRuntimeId: "cli:claude" });
      const cli = harness.store.createPaneCliSession({ paneId: pane.id, roomId: room.id, runtimeId: "cli:claude", providerId: "claude", agentId: "claude", status: "RUNNING", purpose: "NORMAL" });
      const token = issueCliBrowserBridgeToken(harness.config, { roomId: room.id, paneId: pane.id, cliSessionId: cli.sessionId })!;
      const agent = await harness.app.inject({ method: "POST", url: "/api/cli/space-vault/generate-fill", headers: { [cliBrowserBridgeTokenHeader]: token, "content-type": "application/json" },
        payload: { purpose: "NEW_ACCOUNT", label: "Synthetic shop" } });
      seen.push(agent.body);
      expect(agent.json()).toMatchObject({ status: "BLOCKED", auditId: expect.any(String) });
      expect((await as("GET", "/api/space-vault/pending")).json().pending).toEqual([]);

      const signedUp = await signup();
      expect(signedUp).toEqual({ status: "FILLED", reason: null, itemId: expect.stringMatching(/^vault_item:/) });
      const [pending] = (await as("GET", "/api/space-vault/pending")).json().pending;
      expect(pending.handle).toBe(signedUp.itemId);
      expect(pending).toMatchObject({ kind: "NEW_ACCOUNT", label: "Synthetic shop", origin: "https://shop.example", paneId: "pane:vaultpane1" });
      const generated = new TextDecoder().decode(await openWithVaultPrivateKey(inbox.privateKey, inbox.publicKey, pending.sealedPassword, scope));
      expect(typed).toBe(generated);
      expect(new TextDecoder().decode(await openWithVaultPrivateKey(inbox.privateKey, inbox.publicKey, pending.sealedUsername, scope))).toBe("synthetic@example.com");
      expect(await signup()).toEqual({ status: "RATE_LIMITED", reason: "DAILY_CAP" });
      expect(await signup("https://other.example")).toEqual({ status: "BLOCKED", reason: "NO_SIGNUP_GRANT" });

      // Revoking in the dock stops it in the store and in the broker.
      expect((await as("DELETE", `/api/space-vault/signup-grants/${encodeURIComponent(body.grantId)}`)).json()).toEqual({ revoked: true });
      expect((await as("GET", "/api/space-vault/signup-grants")).json().grants).toEqual([]);
      const certificate = (await core.handle("POST", "/v1/signup-grant", { ownerUserId: owner, vaultId, ...body, unlockPublicKey: b64.encode(unlockKey.publicKey),
        serverShareEnvelope: (await harness.repository.getVault(owner))!.serverShareEnvelope })).body;
      expect(certificate).toEqual({ error: "REVOKED" });
      const events = (await as("GET", "/api/space-vault/audit?limit=20")).json().entries.map((entry: { event: { action: string; result: string; reason: string | null } }) => entry.event);
      expect(events.filter((event: { action: string }) => event.action === "GENERATE")).toEqual([expect.objectContaining({ actor: "AGENT", result: "BLOCKED", reason: "AGENT_ACCESS_OFF" })]);

      const all = seen.join("\n");
      for (const secret of [generated, PASSWORD, b64.encode(serverShare)]) expect(all).not.toContain(secret);
    } finally {
      await harness.app.close();
    }
  });

  it("fills a login an agent saved while the Vault is locked, through a re-delegation; an older broker still delegates (operator request 2026-10-20)", async () => {
    const root = await mkdtemp(join(tmpdir(), "space-vault-e2e-"));
    roots.push(root);
    const core = await createVaultBroker({ ark: vaultRandomBytes(32), stateDir: join(root, "state") });
    const server = createVaultBrokerHttpServer(core);
    await new Promise<void>((resolve) => server.listen(join(root, "broker.sock"), resolve));
    closers.push(() => server.close());
    const real = createSocketVaultBroker(join(root, "broker.sock"));
    // A broker installed before 2026-10-20 refuses the inbox key as an unknown field.
    let legacy = true;
    const broker: VaultBroker = { ...real, delegate: (input) => legacy && input.sealedInboxKey ? Promise.reject(new VaultBrokerRefusedError("BAD_REQUEST")) : real.delegate(input) };
    const harness = await fixture({ broker });
    const seen: string[] = [];
    try {
      const alice = await harness.session({ id: owner, email: "alice@space.local", role: "OPERATOR" });
      const as = async (method: "GET" | "PUT" | "POST", url: string, payload?: unknown) => {
        const answer = await harness.app.inject({ method, url, headers: alice.headers, payload: payload as never });
        seen.push(answer.body);
        return answer;
      };
      const vaultId = newVaultHandle("vault");
      const scope = { ownerUserId: owner, vaultId, keyVersion: 1 };
      const vrk = vaultRandomBytes(32);
      const { passwordShare, serverShare } = splitVaultRootKey(vrk);
      const unlockKey = await generateVaultSigningKey();
      const kdfParams = { ...VAULT_KDF_DEFAULTS, salt: b64.encode(vaultRandomBytes(16)) };
      const transport = (await as("GET", "/api/space-vault/broker")).json();
      expect((await as("POST", "/api/space-vault/enroll", {
        vaultId, kdf: kdfParams, passwordEnvelope: await sealPasswordEnvelope(kdf, PASSWORD, kdfParams, { passwordShare, unlockPrivateKey: unlockKey.privateKey }, scope),
        sealedServerShare: await sealToVaultPublicKey(b64.decode(transport.publicKey), serverShare, scope), unlockPublicKey: b64.encode(unlockKey.publicKey), unlockKeyVersion: 1
      })).statusCode).toBe(201);
      const inbox = await generateVaultTransportKey();
      await as("PUT", "/api/space-vault/inbox", await signed(vaultId, "inbox", { publicKey: b64.encode(inbox.publicKey), privateKeyEnvelope: await sealVaultEnvelope(vrk, inbox.privateKey, { ...scope, purpose: "INBOX_KEY" }),
        epoch: (await as("GET", "/api/space-vault/state")).json().vault.epoch }, unlockKey.privateKey));
      const handle = newVaultHandle("vault_item");
      const dek = vaultRandomBytes(32);
      const itemScope = { ...scope, itemId: handle };
      expect((await as("PUT", `/api/space-vault/items/${encodeURIComponent(handle)}`, {
        metadata: { id: handle, label: "Synthetic login", origins: ["https://login.example"], fieldRoles: ["PASSWORD"], status: "ACTIVE",
          policy: { agentUse: true, approvalMode: "FULL", submitAllowed: true, maxFillsPerHour: 60, acceptedOriginRisks: [] } },
        keyVersion: 1, history: [], dekEnvelope: await sealVaultEnvelope(vrk, dek, { ...itemScope, purpose: "ITEM_KEY" }),
        fields: { PASSWORD: await sealVaultEnvelope(dek, new TextEncoder().encode(SENTINEL), { ...itemScope, purpose: "ITEM_FIELD", field: "PASSWORD" }) }
      })).statusCode).toBe(200);
      expect((await as("PUT", "/api/space-vault/agent-access", { enabled: true })).statusCode).toBe(200);
      // The dock's delegation (vault-client's delegateVaultItems), with the inbox key sealed to the broker.
      const delegate = async () => {
        const state = (await as("GET", "/api/space-vault/state")).json().vault;
        const generation = state.delegationGeneration + 1;
        const fillKey = vaultRandomBytes(32);
        const fillEnvelopes = { [handle]: { PASSWORD: await sealVaultEnvelope(fillKey, new TextEncoder().encode(SENTINEL), { ...itemScope, purpose: "FILL_FIELD", field: "PASSWORD", generation }) } };
        const items = [{ handle, origins: ["https://login.example"], fields: ["PASSWORD" as const], approvalMode: "FULL" as const, submit: true }];
        const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
        const operatorSignature = await signVaultMessage(unlockKey.privateKey, vaultDelegationOperatorMessage({ ownerUserId: owner, vaultId, envelopeDigest: await vaultDigest(fillEnvelopes),
          generation, unlockEpoch: state.epoch, expiresAt, items }));
        return as("POST", "/api/space-vault/delegations", { items, fillEnvelopes, generation, unlockEpoch: state.epoch, expiresAt, operatorSignature,
          sealedFillKey: await sealToVaultPublicKey(b64.decode(transport.publicKey), fillKey, scope),
          sealedInboxKey: await sealToVaultPublicKey(b64.decode(transport.publicKey), inbox.privateKey, scope) });
      };
      expect((await delegate()).json()).toEqual({ generation: 1 });
      expect((await harness.repository.getActiveDelegation(owner))!.inboxKeyEnvelope).toBeNull();

      const room = (await as("POST", "/api/rooms", { name: "E2E saved", initialPaneCount: 0 })).json();
      const pane = harness.store.createPane({ roomId: room.id, title: "Claude", mode: "TERMINAL", terminalRuntimeId: "cli:claude" });
      const cli = harness.store.createPaneCliSession({ paneId: pane.id, roomId: room.id, runtimeId: "cli:claude", providerId: "claude", agentId: "claude", status: "RUNNING", purpose: "NORMAL" });
      const token = issueCliBrowserBridgeToken(harness.config, { roomId: room.id, paneId: pane.id, cliSessionId: cli.sessionId })!;
      const agent = async (path: string, payload: Record<string, unknown>) => {
        const answer = await harness.app.inject({ method: "POST", url: `/api/cli/space-vault/${path}`, headers: { [cliBrowserBridgeTokenHeader]: token, "content-type": "application/json" }, payload });
        seen.push(answer.body);
        return answer.json();
      };
      const saveLogin = (password: string) => agent("save", { site: "https://new.example", username: "agent@example.com", password, label: "Synthetic new site" });
      // Under the older broker a saved login waits for the operator's unlock, as before.
      expect(await saveLogin("SYNTHETIC-agent-saved-1")).toMatchObject({ status: "SAVED" });
      expect((await agent("list", {})).items.map((item: { label: string }) => item.label)).toEqual(["Synthetic login"]);

      // With the new broker: the next delegation carries the inbox key, the waiting login joins it, and a new one joins at once.
      legacy = false;
      expect((await delegate()).json()).toEqual({ generation: 2 });
      expect(await saveLogin("SYNTHETIC-agent-saved-2")).toMatchObject({ status: "SAVED" });
      const listed = (await agent("list", {})).items as Array<{ handle: string; label: string; origins: string[] }>;
      expect(listed.map((item) => item.label)).toEqual(["Synthetic login", "Synthetic new site", "Synthetic new site"]);
      expect(listed[2]!.origins).toEqual(["https://new.example"]);
      const fillOf = async (itemHandle: string, origin: string) => {
        const active = (await harness.repository.getActiveDelegation(owner))!;
        const use = await core.handle("POST", "/v1/use", { ownerUserId: owner, vaultId, certificate: active.certificate, epoch: 1, handle: itemHandle, fields: ["PASSWORD"], submit: false,
          paneId: pane.id, targetId: "t", pageId: "t", frameId: "f", origin });
        if (use.status !== 200) return use.body;
        const host = await generateVaultTransportKey();
        const answer = await core.handle("POST", "/v1/fill", { capability: (use.body as { capability: unknown }).capability, keyEnvelope: active.keyEnvelope,
          fieldEnvelopes: active.fillEnvelopes[itemHandle], replyPublicKey: b64.encode(host.publicKey) }, "host");
        return JSON.parse(new TextDecoder().decode(await openWithVaultPrivateKey(host.privateKey, host.publicKey, (answer.body as { sealedFields: unknown }).sealedFields, scope)));
      };
      expect(await fillOf(listed[1]!.handle, "https://new.example")).toEqual({ PASSWORD: "SYNTHETIC-agent-saved-1" });
      expect(await fillOf(listed[2]!.handle, "https://new.example")).toEqual({ PASSWORD: "SYNTHETIC-agent-saved-2" });
      expect(await fillOf(listed[2]!.handle, "https://login.example")).toEqual({ error: "NOT_DELEGATED" });
      expect(await fillOf(handle, "https://login.example")).toEqual({ PASSWORD: SENTINEL });

      // Revoking drops it with the rest.
      const revoked = (await harness.repository.getActiveDelegation(owner))!;
      await as("POST", "/api/space-vault/revoke", {});
      expect((await core.handle("POST", "/v1/delegate-pending", { ownerUserId: owner, vaultId, certificate: revoked.certificate, keyEnvelope: revoked.keyEnvelope,
        inboxKeyEnvelope: revoked.inboxKeyEnvelope, entry: { handle: newVaultHandle("vault_item"), origin: "https://new.example", sealedUsername: null,
          sealedPassword: await sealToVaultPublicKey(inbox.publicKey, new TextEncoder().encode("x"), scope) } })).body).toEqual({ error: "GENERATION_RETIRED" });

      const all = seen.join("\n");
      for (const secret of [SENTINEL, "SYNTHETIC-agent-saved-1", "SYNTHETIC-agent-saved-2", PASSWORD, b64.encode(inbox.privateKey)]) expect(all).not.toContain(secret);
    } finally {
      await harness.app.close();
    }
  });
  it("delegates thousands of logins through the API and the real broker, and agents list them all (no count limit, operator rule 2026-10-20)", async () => {
    const root = await mkdtemp(join(tmpdir(), "space-vault-e2e-"));
    roots.push(root);
    const core = await createVaultBroker({ ark: vaultRandomBytes(32), stateDir: join(root, "state") });
    const server = createVaultBrokerHttpServer(core);
    await new Promise<void>((resolve) => server.listen(join(root, "broker.sock"), resolve));
    closers.push(() => server.close());
    const harness = await fixture({ broker: createSocketVaultBroker(join(root, "broker.sock")) });
    try {
      const alice = await harness.session({ id: owner, email: "alice@space.local", role: "OPERATOR" });
      const as = (method: "GET" | "PUT" | "POST", url: string, payload?: unknown) => harness.app.inject({ method, url, headers: alice.headers, payload: payload as never });
      const vaultId = newVaultHandle("vault");
      const scope = { ownerUserId: owner, vaultId, keyVersion: 1 };
      const { passwordShare, serverShare } = splitVaultRootKey(vaultRandomBytes(32));
      const unlockKey = await generateVaultSigningKey();
      const kdfParams = { ...VAULT_KDF_DEFAULTS, salt: b64.encode(vaultRandomBytes(16)) };
      const transport = (await as("GET", "/api/space-vault/broker")).json();
      expect((await as("POST", "/api/space-vault/enroll", {
        vaultId, kdf: kdfParams, passwordEnvelope: await sealPasswordEnvelope(kdf, PASSWORD, kdfParams, { passwordShare, unlockPrivateKey: unlockKey.privateKey }, scope),
        sealedServerShare: await sealToVaultPublicKey(b64.decode(transport.publicKey), serverShare, scope), unlockPublicKey: b64.encode(unlockKey.publicKey), unlockKeyVersion: 1
      })).statusCode).toBe(201);
      expect((await as("PUT", "/api/space-vault/agent-access", { enabled: true })).statusCode).toBe(200);
      // A large Chrome import: well past the old 200 cap and the API's default 1 MiB body.
      const fillKey = vaultRandomBytes(32);
      const envelope = await sealVaultEnvelope(fillKey, new TextEncoder().encode(SENTINEL), { ...scope, purpose: "FILL_FIELD", field: "PASSWORD", generation: 1 });
      const items = [];
      const fillEnvelopes: Record<string, { PASSWORD: typeof envelope }> = {};
      for (let index = 0; index < 2_000; index += 1) {
        const handle = newVaultHandle("vault_item");
        const origin = `https://site-${index}.example`;
        await harness.repository!.saveItem(owner, { metadata: { id: handle, label: `Synthetic ${index}`, origins: [origin], fieldRoles: ["PASSWORD"], status: "ACTIVE",
          policy: { agentUse: true, approvalMode: "FULL", submitAllowed: true, maxFillsPerHour: 60, acceptedOriginRisks: [] } }, keyVersion: 1, history: [], dekEnvelope: envelope, fields: { PASSWORD: envelope } } as never);
        items.push({ handle, origins: [origin], fields: ["PASSWORD" as const], approvalMode: "FULL" as const, submit: true });
        fillEnvelopes[handle] = { PASSWORD: envelope };
      }
      const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
      const operatorSignature = await signVaultMessage(unlockKey.privateKey, vaultDelegationOperatorMessage({ ownerUserId: owner, vaultId, envelopeDigest: await vaultDigest(fillEnvelopes),
        generation: 1, unlockEpoch: 1, expiresAt, items }));
      const delegated = await as("POST", "/api/space-vault/delegations", { items, fillEnvelopes, generation: 1, unlockEpoch: 1, expiresAt, operatorSignature,
        sealedFillKey: await sealToVaultPublicKey(b64.decode(transport.publicKey), fillKey, scope) });
      expect(delegated.json()).toEqual({ generation: 1 });
      const room = (await as("POST", "/api/rooms", { name: "E2E many", initialPaneCount: 0 })).json();
      const pane = harness.store.createPane({ roomId: room.id, title: "Claude", mode: "TERMINAL", terminalRuntimeId: "cli:claude" });
      const cli = harness.store.createPaneCliSession({ paneId: pane.id, roomId: room.id, runtimeId: "cli:claude", providerId: "claude", agentId: "claude", status: "RUNNING", purpose: "NORMAL" });
      const token = issueCliBrowserBridgeToken(harness.config, { roomId: room.id, paneId: pane.id, cliSessionId: cli.sessionId })!;
      const listed = (await harness.app.inject({ method: "POST", url: "/api/cli/space-vault/list", headers: { [cliBrowserBridgeTokenHeader]: token, "content-type": "application/json" }, payload: {} })).json();
      expect(listed.items).toHaveLength(2_000);
    } finally {
      await harness.app.close();
    }
  }, 60_000);
});
