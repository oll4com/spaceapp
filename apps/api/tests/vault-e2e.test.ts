import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  VAULT_KDF_DEFAULTS, generateVaultSigningKey, generateVaultTransportKey, joinVaultRootKey, newVaultHandle, openPasswordEnvelope, openWithVaultPrivateKey,
  sealPasswordEnvelope, sealToVaultPublicKey, sealVaultEnvelope, signVaultMessage, splitVaultRootKey, vaultBase64url, vaultDelegationOperatorMessage,
  vaultDigest, vaultRandomBytes, vaultUnlockChallengeMessage, vaultSignupGrantOperatorMessage, type VaultKdfParams
} from "@space/contracts";
import { runVaultSignup } from "../src/vault/signup.js";
import { createVaultBroker, createVaultBrokerHttpServer } from "../src/vault/broker-server.js";
import { createSocketVaultBroker } from "../src/vault/broker-client.js";
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
      await as("PUT", "/api/space-vault/inbox", { publicKey: b64.encode(inbox.publicKey), privateKeyEnvelope: await sealVaultEnvelope(vaultRandomBytes(32), inbox.privateKey, { ...scope, purpose: "INBOX_KEY" }) });

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
      expect(agent.json()).toEqual({ status: "BLOCKED", auditId: expect.any(String) });
      expect((await as("GET", "/api/space-vault/pending")).json().pending).toEqual([]);

      expect(await signup()).toEqual({ status: "FILLED", reason: null });
      const [pending] = (await as("GET", "/api/space-vault/pending")).json().pending;
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
});

