import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  generateVaultSigningKey, generateVaultTransportKey, newVaultHandle, openWithVaultPrivateKey, sealToVaultPublicKey,
  sealVaultEnvelope, signVaultMessage, splitVaultRootKey, vaultBase64url, vaultDelegationCertificateSchema, vaultDelegationOperatorMessage,
  vaultDigest, vaultRandomBytes, vaultUnlockChallengeMessage, verifyVaultCertificate, vaultSignupGrantOperatorMessage, vaultSignupGrantCertificateSchema, VAULT_DELEGATION_TECHNICAL_MAX_ITEMS, type VaultFieldRole
} from "@space/contracts";
import { createVaultBroker, createVaultBrokerHttpServer, vaultSocketPosture, type VaultBrokerCore } from "../src/vault/broker-server.js";
import { VaultBrokerRefusedError, createSocketVaultBroker } from "../src/vault/broker-client.js";

// The broker (ADR-012) over its real HTTP-on-unix-socket protocol, driven by the API's own client where it has the call.
// Synthetic ARK and secrets only.
const SENTINEL = "SYNTHETIC-broker-sentinel-password";
const b64 = vaultBase64url;
const roots: string[] = [];
const servers: Array<{ close(): void }> = [];
afterEach(async () => {
  for (const server of servers.splice(0)) server.close();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function start(ark = vaultRandomBytes(32), stateDir?: string, now?: () => Date) {
  const root = await mkdtemp(join(tmpdir(), "space-vault-broker-"));
  roots.push(root);
  const state = stateDir ?? join(root, "state");
  // The move pin is this test user's (as root's on a host) in a folder of its own.
  const movePeerPath = join(root, "pin", "move-peer.json");
  const core = await createVaultBroker({ ark, stateDir: state, ...(now ? { now } : {}), movePeerPath, movePeerOwnerUid: process.getuid!() });
  const socketPath = join(root, "broker.sock");
  const server = createVaultBrokerHttpServer(core);
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  servers.push(server);
  return { ark, state, core, movePeerPath, client: createSocketVaultBroker(socketPath) };
}

async function pin(path: string, peer: VaultBrokerCore, mode = 0o644) {
  await mkdir(dirname(path), { recursive: true, mode: 0o755 });
  await writeFile(path, JSON.stringify({ transportKey: b64.encode(peer.transportPublicKey), signingKey: b64.encode(peer.signingPublicKey) }));
  await chmod(path, mode);
}

// Fills go over the Browser Host's own socket (H2 Option A); everything else over the API's.
const post = async (core: VaultBrokerCore, path: string, body: unknown, channel: "api" | "host" = path === "/v1/fill" ? "host" : "api") => core.handle("POST", path, body, channel);
const owner = "user:alice";

async function enrolled(now?: () => Date) {
  const broker = await start(undefined, undefined, now);
  const vaultId = newVaultHandle("vault");
  const scope = { ownerUserId: owner, vaultId, keyVersion: 1 };
  const { serverShare } = splitVaultRootKey(vaultRandomBytes(32));
  const unlock = await generateVaultSigningKey();
  const unlockPublicKey = b64.encode(unlock.publicKey);
  const transport = await broker.client.transportKey();
  const serverShareEnvelope = await broker.client.sealServerShare({ ...scope, sealedServerShare: await sealToVaultPublicKey(b64.decode(transport.publicKey), serverShare, scope), unlockPublicKey });
  return { ...broker, vaultId, scope, serverShare, unlock, unlockPublicKey, serverShareEnvelope, transport };
}

/** A card (plan clipboard:qf0P640vyLp2): synthetic values, no origins, never submitted. */
const CARD = { CARD_NUMBER: "4242424242424242", CARD_EXPIRY: "12/30", CARD_CVC: SENTINEL, CARDHOLDER_NAME: "Synthetic Alice" };

async function delegation(vault: Awaited<ReturnType<typeof enrolled>>, generation = 1, moreLogins = 0, card = false) {
  const handle = newVaultHandle("vault_item");
  const fillKey = vaultRandomBytes(32);
  const field = (role: VaultFieldRole, text: string) => sealVaultEnvelope(fillKey, new TextEncoder().encode(text), { ...vault.scope, purpose: "FILL_FIELD", itemId: handle, field: role, generation });
  const values: Partial<Record<VaultFieldRole, string>> = card ? CARD : { USERNAME: "synthetic@example.com", PASSWORD: SENTINEL };
  const fillEnvelopes = { [handle]: Object.fromEntries(await Promise.all(Object.entries(values).map(async ([role, text]) => [role, await field(role as VaultFieldRole, text!)]))) };
  const items = [{ handle, origins: card ? [] : ["https://login.example"], fields: Object.keys(values) as VaultFieldRole[], approvalMode: "FULL", submit: false },
    ...Array.from({ length: moreLogins }, (_, index) => ({ handle: newVaultHandle("vault_item"), origins: [`https://site-${index}.example`],
      fields: ["USERNAME", "PASSWORD"] as Array<"USERNAME" | "PASSWORD">, approvalMode: "FULL", submit: false }))];
  const envelopeDigest = await vaultDigest(fillEnvelopes);
  const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
  const operatorSignature = await signVaultMessage(vault.unlock.privateKey, vaultDelegationOperatorMessage({ ownerUserId: owner, vaultId: vault.vaultId, envelopeDigest, generation, unlockEpoch: 1, expiresAt, items }));
  const request = {
    ownerUserId: owner, vaultId: vault.vaultId, generation, unlockEpoch: 1, envelopeDigest, expiresAt, items,
    sealedFillKey: await sealToVaultPublicKey(b64.decode(vault.transport.publicKey), fillKey, vault.scope), operatorSignature,
    unlockPublicKey: vault.unlockPublicKey, serverShareEnvelope: vault.serverShareEnvelope
  };
  return { handle, fillEnvelopes, request };
}

const useRequest = (vault: Awaited<ReturnType<typeof enrolled>>, certificate: unknown, handle: string, overrides: Record<string, unknown> = {}) => ({
  ownerUserId: owner, vaultId: vault.vaultId, certificate, epoch: 1, handle, fields: ["PASSWORD"], submit: false, paneId: "pane:vaultpane1",
  targetId: "target-1", pageId: "target-1", frameId: "frame-1", origin: "https://login.example", ...overrides
});

describe("space-vault-broker", () => {
  it("returns the server share only to the browser that signed the challenge with the enrolled unlock key", async () => {
    const vault = await enrolled();
    const reply = await generateVaultTransportKey();
    const message = { ownerUserId: owner, vaultId: vault.vaultId, epoch: 2, challenge: b64.encode(vaultRandomBytes(32)), replyPublicKey: b64.encode(reply.publicKey) };
    const signature = await signVaultMessage(vault.unlock.privateKey, vaultUnlockChallengeMessage(message));
    const sealed = await vault.client.unlock({ ...message, signature, unlockPublicKey: vault.unlockPublicKey, serverShareEnvelope: vault.serverShareEnvelope });
    expect(await openWithVaultPrivateKey(reply.privateKey, reply.publicKey, sealed, vault.scope)).toEqual(vault.serverShare);
    // Another epoch than the one signed, or a swapped unlock key with its own valid signature: refused.
    await expect(vault.client.unlock({ ...message, epoch: 3, signature, unlockPublicKey: vault.unlockPublicKey, serverShareEnvelope: vault.serverShareEnvelope })).rejects.toBeInstanceOf(VaultBrokerRefusedError);
    const attacker = await generateVaultSigningKey();
    const forged = await signVaultMessage(attacker.privateKey, vaultUnlockChallengeMessage(message));
    await expect(vault.client.unlock({ ...message, signature: forged, unlockPublicKey: b64.encode(attacker.publicKey), serverShareEnvelope: vault.serverShareEnvelope })).rejects.toBeInstanceOf(VaultBrokerRefusedError);
  });

  it("signs a delegation only with the operator's unlock signature and wraps the fill key per generation", async () => {
    const vault = await enrolled();
    const { request } = await delegation(vault);
    const forged = await signVaultMessage((await generateVaultSigningKey()).privateKey, new TextEncoder().encode("anything"));
    await expect(vault.client.delegate({ ...request, operatorSignature: forged })).rejects.toBeInstanceOf(VaultBrokerRefusedError);
    // A signature over other items (here: submit added) does not cover this request.
    await expect(vault.client.delegate({ ...request, items: [{ ...request.items[0]!, submit: true }] })).rejects.toBeInstanceOf(VaultBrokerRefusedError);
    const signed = await vault.client.delegate(request);
    const key = await vault.client.delegationKey();
    expect((await verifyVaultCertificate(b64.decode(key.publicKey), signed.certificate, vaultDelegationCertificateSchema)).items).toEqual(request.items);
    expect(signed.keyEnvelope).toMatchObject({ purpose: "FILL_KEY" });
  });

  it("delegates every login, far past the old 200 cap, over the socket; only the technical bound refuses (operator rule 2026-10-20)", async () => {
    const vault = await enrolled();
    const { handle, request } = await delegation(vault, 1, 1_499);
    // About 300 KB of signed claims each way: above the old 64 KiB socket body.
    const { certificate } = await vault.client.delegate(request);
    const key = await vault.client.delegationKey();
    expect((await verifyVaultCertificate(b64.decode(key.publicKey), certificate, vaultDelegationCertificateSchema)).items).toHaveLength(1_500);
    expect(await vault.client.issueUse(useRequest(vault, certificate, handle) as never)).toMatchObject({ capability: expect.anything() });
    const over = Array.from({ length: VAULT_DELEGATION_TECHNICAL_MAX_ITEMS + 1 }, () => request.items[0]!);
    expect((await post(vault.core, "/v1/delegate", { ...request, items: over })).body).toEqual({ error: "BAD_REQUEST" });
  });

  it("issues one-time use capabilities and releases only the named fields, sealed to the host's key", async () => {
    const vault = await enrolled();
    const { handle, fillEnvelopes, request } = await delegation(vault);
    const { certificate, keyEnvelope } = await vault.client.delegate(request);
    expect((await post(vault.core, "/v1/use", useRequest(vault, certificate, handle, { origin: "https://evil.example" }))).body).toEqual({ error: "NOT_DELEGATED" });
    expect((await post(vault.core, "/v1/use", useRequest(vault, certificate, handle, { origin: "https://sso.login.example" }))).status).toBe(200);
    expect((await post(vault.core, "/v1/use", useRequest(vault, certificate, handle, { submit: true }))).body).toEqual({ error: "NOT_DELEGATED" });
    const host = await generateVaultTransportKey();
    const use = await post(vault.core, "/v1/use", useRequest(vault, certificate, handle));
    expect(use.status).toBe(200);
    const fill = { capability: (use.body as { capability: unknown }).capability, keyEnvelope, fieldEnvelopes: fillEnvelopes[handle], replyPublicKey: b64.encode(host.publicKey) };
    const answer = await post(vault.core, "/v1/fill", fill);
    expect(JSON.stringify(answer.body)).not.toContain(SENTINEL);
    const opened = JSON.parse(new TextDecoder().decode(await openWithVaultPrivateKey(host.privateKey, host.publicKey, (answer.body as { sealedFields: unknown }).sealedFields, vault.scope)));
    expect(opened).toEqual({ PASSWORD: SENTINEL });
    expect((await post(vault.core, "/v1/fill", fill)).body).toEqual({ error: "CAPABILITY_USED" });
  });

  it("fills a card at any clean https checkout, never submitted or generated; a card claim with origins or submit is never signed", async () => {
    const vault = await enrolled();
    const { handle, fillEnvelopes, request } = await delegation(vault, 1, 0, true);
    for (const items of [[{ ...request.items[0]!, origins: ["https://shop.example"] }], [{ ...request.items[0]!, submit: true }]]) {
      expect((await post(vault.core, "/v1/delegate", { ...request, items })).body).toEqual({ error: "BAD_REQUEST" });
    }
    const { certificate, keyEnvelope } = await vault.client.delegate(request);
    const cardUse = (overrides: Record<string, unknown>) => useRequest(vault, certificate, handle, { fields: Object.keys(CARD), origin: "https://checkout.shop.example", ...overrides });
    for (const overrides of [{ origin: "http://shop.example" }, { origin: "https://checkout.shop.example/pay" }, { origin: "https://10.0.0.1" }, { origin: "https://xn--shp-sna.example" },
      { submit: true }, { generate: { roles: ["NEW_PASSWORD"], inboxPublicKey: b64.encode((await generateVaultTransportKey()).publicKey) } }, { fields: ["PASSWORD"] }]) {
      expect((await post(vault.core, "/v1/use", cardUse(overrides))).body, JSON.stringify(overrides)).toEqual({ error: "NOT_DELEGATED" });
    }
    const host = await generateVaultTransportKey();
    const use = await post(vault.core, "/v1/use", cardUse({}));
    expect(use.status).toBe(200);
    const answer = await post(vault.core, "/v1/fill", { capability: (use.body as { capability: unknown }).capability, keyEnvelope, fieldEnvelopes: fillEnvelopes[handle], replyPublicKey: b64.encode(host.publicKey) });
    expect(JSON.stringify(answer.body) + JSON.stringify(use.body)).not.toContain(SENTINEL);
    expect(JSON.parse(new TextDecoder().decode(await openWithVaultPrivateKey(host.privateKey, host.publicKey, (answer.body as { sealedFields: unknown }).sealedFields, vault.scope)))).toEqual(CARD);
  });

  it("keeps its keys and generation floor across a restart, but no outstanding capability", async () => {
    const vault = await enrolled();
    const { handle, fillEnvelopes, request } = await delegation(vault);
    const { certificate, keyEnvelope } = await vault.client.delegate(request);
    const host = await generateVaultTransportKey();
    const use = await post(vault.core, "/v1/use", useRequest(vault, certificate, handle));
    const restarted = await start(vault.ark, vault.state);
    expect(restarted.core.signingPublicKey).toEqual(vault.core.signingPublicKey);
    expect(restarted.core.transportPublicKey).toEqual(vault.core.transportPublicKey);
    expect((await post(restarted.core, "/v1/fill", { capability: (use.body as { capability: unknown }).capability, keyEnvelope, fieldEnvelopes: fillEnvelopes[handle], replyPublicKey: b64.encode(host.publicKey) })).body).toEqual({ error: "CAPABILITY_USED" });
    // Revoking raises the floor: the old certificate, and a delegation reusing its generation, stop working, also after a restart.
    expect(await restarted.client.revoke({ ownerUserId: owner, vaultId: vault.vaultId, generation: 2 })).toEqual({ generation: 2 });
    const again = await start(vault.ark, vault.state);
    expect((await post(again.core, "/v1/use", useRequest(vault, certificate, handle))).body).toEqual({ error: "GENERATION_RETIRED" });
    await expect(again.client.delegate(request)).rejects.toBeInstanceOf(VaultBrokerRefusedError);
    const next = await delegation(vault, 3);
    expect((await again.client.delegate(next.request)).certificate).toBeTruthy();
  });

  it("audits ids and results in a hash chain, never a value or the ARK", async () => {
    const vault = await enrolled();
    const { handle, fillEnvelopes, request } = await delegation(vault);
    const { certificate, keyEnvelope } = await vault.client.delegate(request);
    const host = await generateVaultTransportKey();
    const use = await post(vault.core, "/v1/use", useRequest(vault, certificate, handle));
    await post(vault.core, "/v1/fill", { capability: (use.body as { capability: unknown }).capability, keyEnvelope, fieldEnvelopes: fillEnvelopes[handle], replyPublicKey: b64.encode(host.publicKey) });
    await post(vault.core, "/v1/unlock", { nonsense: true });
    const lines = (await readFile(join(vault.state, "audit.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { op: string; result: string; prev: string; hash: string });
    expect(lines.map((line) => `${line.op}:${line.result}`)).toEqual(["server-share:OK", "delegate:OK", "use:OK", "fill:OK", "unlock:BAD_REQUEST"]);
    for (const [index, line] of lines.entries()) if (index > 0) expect(line.prev).toBe(lines[index - 1]!.hash);
    const text = lines.map((line) => JSON.stringify(line)).join("\n");
    for (const secret of [SENTINEL, Buffer.from(vault.ark).toString("hex"), b64.encode(vault.ark), b64.encode(vault.serverShare)]) expect(text).not.toContain(secret);
  });

  it("a password-changing fill gets no stored field; the audit reads back ops, results and hashes only (hardening steps 15, 16)", async () => {
    const vault = await enrolled();
    const { handle, fillEnvelopes, request } = await delegation(vault);
    const { certificate, keyEnvelope } = await vault.client.delegate(request);
    const host = await generateVaultTransportKey();
    const inbox = await generateVaultTransportKey();
    const use = await post(vault.core, "/v1/use", useRequest(vault, certificate, handle, { generate: { roles: ["NEW_PASSWORD"], inboxPublicKey: b64.encode(inbox.publicKey) } }));
    expect(use.status).toBe(200);
    const answer = await post(vault.core, "/v1/fill", { capability: (use.body as { capability: unknown }).capability, keyEnvelope, fieldEnvelopes: fillEnvelopes[handle], replyPublicKey: b64.encode(host.publicKey) });
    const opened = JSON.parse(new TextDecoder().decode(await openWithVaultPrivateKey(host.privateKey, host.publicKey, (answer.body as { sealedFields: unknown }).sealedFields, vault.scope)));
    expect(opened).toEqual({});
    const audit = await vault.core.handle("GET", "/v1/audit", undefined, "api");
    const body = audit.body as { head: string; total: number; entries: Array<Record<string, string>> };
    expect(body.entries.map((entry) => `${entry.op}:${entry.result}`)).toEqual(["server-share:OK", "delegate:OK", "use:OK", "fill:OK"]);
    expect(body.head).toBe(body.entries.at(-1)!.hash);
    expect(Object.keys(body.entries[0]!).sort()).toEqual(["at", "hash", "op", "result"]);
    expect(JSON.stringify(body)).not.toContain(owner);
    expect((await vault.core.handle("GET", "/v1/audit", undefined, "host")).status).toBe(404);
  });

  // Review 2026-10-17 (reports/2026-10-17-vault-broker-review): one regression test per finding.
  it("H1/M2: the operator signature fixes origins, generation, epoch and expiry", async () => {
    const vault = await enrolled();
    const { request } = await delegation(vault);
    for (const altered of [{ items: [{ ...request.items[0]!, origins: ["https://phish.example"] }] }, { items: [{ ...request.items[0]!, origins: [...request.items[0]!.origins, "https://phish.example"] }] },
      { expiresAt: new Date(Date.now() + 700 * 3_600_000).toISOString() }, { generation: 2 }, { unlockEpoch: 2 }]) {
      await expect(vault.client.delegate({ ...request, ...altered }), JSON.stringify(altered)).rejects.toBeInstanceOf(VaultBrokerRefusedError);
    }
    expect((await vault.client.delegate(request)).certificate).toBeTruthy();
  });

  it("H2 (Option A): a fill answers only on the Browser Host's socket, sealed to that caller's own reply key", async () => {
    const vault = await enrolled();
    const { handle, fillEnvelopes, request } = await delegation(vault);
    const { certificate, keyEnvelope } = await vault.client.delegate(request);
    // The capability names no reply key: the caller on the host socket is the only one who can ask.
    expect((await post(vault.core, "/v1/use", useRequest(vault, certificate, handle, { replyPublicKey: b64.encode(vaultRandomBytes(32)) }))).body).toEqual({ error: "BAD_REQUEST" });
    const use = await post(vault.core, "/v1/use", useRequest(vault, certificate, handle));
    const capability = (use.body as { capability: { claims: Record<string, unknown> } }).capability;
    expect(capability.claims).not.toHaveProperty("replyPublicKey");
    const relay = await generateVaultTransportKey();
    const fill = (replyPublicKey: Uint8Array) => ({ capability, keyEnvelope, fieldEnvelopes: fillEnvelopes[handle], replyPublicKey: b64.encode(replyPublicKey) });
    // Over the API's socket a fill is not served at all (and the capability stays unspent).
    expect(await post(vault.core, "/v1/fill", fill(relay.publicKey), "api")).toEqual({ status: 404, body: { error: "FILL_HOST_ONLY" } });
    const host = await generateVaultTransportKey();
    const answer = await post(vault.core, "/v1/fill", fill(host.publicKey), "host");
    expect(JSON.parse(new TextDecoder().decode(await openWithVaultPrivateKey(host.privateKey, host.publicKey, (answer.body as { sealedFields: unknown }).sealedFields, vault.scope)))).toEqual({ PASSWORD: SENTINEL });
    // The host socket serves nothing else.
    expect((await vault.core.handle("POST", "/v1/use", useRequest(vault, certificate, handle), "host")).status).toBe(404);
  });

  it("needs only the operator-signed delegation for a use: no custody report is read (operator decision 2026-10-18)", async () => {
    const vault = await enrolled();
    const { handle, request } = await delegation(vault);
    const { certificate } = await vault.client.delegate(request);
    const root = await mkdtemp(join(tmpdir(), "space-vault-broker-default-"));
    roots.push(root);
    const real = await createVaultBroker({ ark: vault.ark, stateDir: join(root, "state") });
    expect((await real.handle("POST", "/v1/use", useRequest(vault, certificate, handle))).body).toHaveProperty("capability");
  });
});

describe("space-vault-broker server move without an unlock (operator 20/10, 31/10)", () => {
  it("hands the server share and the active delegation only to the broker root pinned; agents fill there at once", async () => {
    const source = await enrolled();
    const inbox = await generateVaultTransportKey();
    const { handle, fillEnvelopes, request } = await delegation(source);
    const signed = await source.client.delegate({ ...request, sealedInboxKey: await sealToVaultPublicKey(b64.decode(source.transport.publicKey), inbox.privateKey, source.scope) });
    const target = await start();
    const out = { ownerUserId: owner, vaultId: source.vaultId, unlockPublicKey: source.unlockPublicKey, serverShareEnvelope: source.serverShareEnvelope,
      delegation: { certificate: signed.certificate, keyEnvelope: signed.keyEnvelope, inboxKeyEnvelope: signed.inboxKeyEnvelope } };
    // Reaching the socket is not enough: no pin, or a pin others may write, refuses.
    expect((await post(source.core, "/v1/move-out", out)).body).toEqual({ error: "MOVE_NOT_PINNED" });
    await pin(source.movePeerPath, target.core, 0o666);
    expect((await post(source.core, "/v1/move-out", out)).body).toEqual({ error: "MOVE_NOT_PINNED" });
    await pin(source.movePeerPath, target.core);
    const moved = await post(source.core, "/v1/move-out", out);
    expect(moved.status).toBe(200);
    const sealed = moved.body as { sealedServerShare: never; sealedFillKey: never; sealedInboxKey: never };
    // Sealed to the target broker only: another key opens nothing.
    const stranger = await generateVaultTransportKey();
    await expect(openWithVaultPrivateKey(stranger.privateKey, stranger.publicKey, sealed.sealedFillKey, source.scope)).rejects.toThrow();

    // The target rewraps the share under its own ARK; the operator's unlock key opens it there unchanged.
    const serverShareEnvelope = await target.client.sealServerShare({ ...source.scope, sealedServerShare: sealed.sealedServerShare, unlockPublicKey: source.unlockPublicKey });
    const reply = await generateVaultTransportKey();
    const message = { ownerUserId: owner, vaultId: source.vaultId, epoch: 2, challenge: b64.encode(vaultRandomBytes(32)), replyPublicKey: b64.encode(reply.publicKey) };
    const unlocked = await target.client.unlock({ ...message, signature: await signVaultMessage(source.unlock.privateKey, vaultUnlockChallengeMessage(message)), unlockPublicKey: source.unlockPublicKey, serverShareEnvelope });
    expect(await openWithVaultPrivateKey(reply.privateKey, reply.publicKey, unlocked, source.scope)).toEqual(source.serverShare);

    const moveIn = { ownerUserId: owner, vaultId: source.vaultId, certificate: signed.certificate, sealedFillKey: sealed.sealedFillKey, sealedInboxKey: sealed.sealedInboxKey };
    expect((await post(target.core, "/v1/move-in", moveIn)).body).toEqual({ error: "MOVE_NOT_PINNED" });
    await pin(target.movePeerPath, source.core);
    // Only a delegation the pinned source signed: one the target's own peer pin does not name is refused.
    expect((await post(source.core, "/v1/move-in", moveIn)).body).toEqual({ error: "CERTIFICATE_REFUSED" });
    const landed = await post(target.core, "/v1/move-in", moveIn);
    expect(landed.status).toBe(200);
    const there = landed.body as { certificate: { claims: unknown }; keyEnvelope: unknown; inboxKeyEnvelope: unknown };
    expect(there.certificate.claims).toEqual(signed.certificate.claims);
    expect(there.inboxKeyEnvelope).toMatchObject({ purpose: "INBOX_KEY" });
    expect(JSON.stringify([moved.body, landed.body])).not.toContain(SENTINEL);
    // The stored fill envelopes work unchanged on the target; the source's certificate does not.
    expect((await post(target.core, "/v1/use", useRequest(source, signed.certificate, handle))).body).toEqual({ error: "CERTIFICATE_REFUSED" });
    const host = await generateVaultTransportKey();
    const use = await post(target.core, "/v1/use", useRequest(source, there.certificate, handle));
    const answer = await post(target.core, "/v1/fill", { capability: (use.body as { capability: unknown }).capability, keyEnvelope: there.keyEnvelope, fieldEnvelopes: fillEnvelopes[handle], replyPublicKey: b64.encode(host.publicKey) });
    expect(JSON.parse(new TextDecoder().decode(await openWithVaultPrivateKey(host.privateKey, host.publicKey, (answer.body as { sealedFields: unknown }).sealedFields, source.scope)))).toEqual({ PASSWORD: SENTINEL });

    // A revoked delegation never moves.
    await post(source.core, "/v1/revoke", { ownerUserId: owner, vaultId: source.vaultId, generation: 2 });
    expect((await post(source.core, "/v1/move-out", out)).body).toEqual({ error: "REVOKED" });
  });
});

describe("space-vault-broker socket posture (M1, operator decision Option B)", () => {
  async function socketFixture() {
    const { createServer } = await import("node:net");
    const { chmod, writeFile } = await import("node:fs/promises");
    const root = await mkdtemp(join(tmpdir(), "space-vault-socket-"));
    roots.push(root);
    const dir = join(root, "run");
    await (await import("node:fs/promises")).mkdir(dir, { mode: 0o755 });
    await chmod(dir, 0o755);
    const path = join(dir, "broker.sock");
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(path, resolve));
    servers.push(server);
    await chmod(path, 0o660);
    const gid = process.getgid!();
    const groupFile = () => `root:x:0:\nspace-vault-client:x:${gid}:space\n`;
    const posture = (overrides: Record<string, unknown> = {}) => vaultSocketPosture({ path, ownerUid: process.getuid!(), dirOwnerUid: process.getuid!(), groupFile, ...overrides });
    return { root, dir, path, chmod, writeFile, posture };
  }

  it("accepts only the broker's own 0660 socket of group space-vault-client in a directory nobody else can write", async () => {
    const socket = await socketFixture();
    expect(socket.posture()).toEqual({ ok: true, reason: null });
    expect(socket.posture({ ownerUid: 0 }).reason).toBe("SOCKET_OWNER");
    expect(socket.posture({ groupFile: () => `space:x:${process.getgid!()}:\n` }).reason).toBe("SOCKET_GROUP");
    await socket.chmod(socket.path, 0o666);
    expect(socket.posture().reason).toBe("SOCKET_MODE");
    await socket.chmod(socket.path, 0o660);
    await socket.chmod(socket.dir, 0o777);
    expect(socket.posture().reason).toBe("SOCKET_DIR");
    expect(socket.posture({ path: join(socket.root, "missing.sock") }).reason).toBe("SOCKET_MISSING");
    const file = join(socket.root, "plain");
    await socket.writeFile(file, "x");
    expect(socket.posture({ path: file }).reason).toBe("NOT_A_SOCKET");
  });
});

describe("space-vault-broker sign-up grants (NEW_ACCOUNT option B, operator decision 2026-10-18)", () => {
  async function granted(options: { sites?: string[]; dailyCap?: number; days?: number } = {}) {
    let clock = Date.parse("2026-10-18T10:00:00.000Z");
    const vault = await enrolled(() => new Date(clock));
    const grant = { grantId: newVaultHandle("vault_grant"), sites: options.sites ?? ["https://shop.example", "https://accounts.example"], dailyCap: options.dailyCap ?? 2,
      unlockEpoch: 1, expiresAt: new Date(clock + (options.days ?? 30) * 86_400_000).toISOString() };
    const message = vaultSignupGrantOperatorMessage({ ownerUserId: owner, vaultId: vault.vaultId, ...grant });
    const request = (signature: string) => ({ ownerUserId: owner, vaultId: vault.vaultId, ...grant, operatorSignature: signature, unlockPublicKey: vault.unlockPublicKey, serverShareEnvelope: vault.serverShareEnvelope });
    const issued = await post(vault.core, "/v1/signup-grant", request(await signVaultMessage(vault.unlock.privateKey, message)));
    const inbox = await generateVaultTransportKey();
    const reply = await generateVaultTransportKey();
    // The Browser Host's channel: /v1/signup returns plaintext sealed to the caller's key, so it answers only there (H2).
    const signup = (overrides: Record<string, unknown> = {}, channel: "api" | "host" = "host") => vault.core.handle("POST", "/v1/signup", { ownerUserId: owner, vaultId: vault.vaultId, certificate: (issued.body as { certificate: unknown }).certificate,
      origin: "https://shop.example", paneId: "pane:vaultpane1", roles: ["NEW_PASSWORD", "CONFIRM_PASSWORD"], inboxPublicKey: b64.encode(inbox.publicKey), replyPublicKey: b64.encode(reply.publicKey), ...overrides }, channel);
    return { vault, grant, request, message, issued, inbox, reply, signup, advance: (ms: number) => { clock += ms; } };
  }

  it("certifies only a grant the operator's unlock key signed, with the sites, cap and expiry it signed", async () => {
    const { vault, grant, request, message, issued } = await granted();
    expect(issued.status).toBe(200);
    const claims = await verifyVaultCertificate(vault.core.signingPublicKey, (issued.body as { certificate: unknown }).certificate, vaultSignupGrantCertificateSchema, new Date(Date.parse("2026-10-18T10:00:00.000Z")));
    expect(claims).toMatchObject({ kind: "SIGNUP_GRANT", grantId: grant.grantId, sites: ["https://accounts.example", "https://shop.example"], dailyCap: 2, expiresAt: grant.expiresAt });
    const other = await signVaultMessage((await generateVaultSigningKey()).privateKey, message);
    expect((await post(vault.core, "/v1/signup-grant", request(other))).body).toEqual({ error: "OPERATOR_SIGNATURE_REFUSED" });
    // A changed site, cap or expiry no longer matches what was signed.
    const signed = await signVaultMessage(vault.unlock.privateKey, message);
    expect((await post(vault.core, "/v1/signup-grant", { ...request(signed), sites: ["https://evil.example"] })).body).toEqual({ error: "OPERATOR_SIGNATURE_REFUSED" });
    expect((await post(vault.core, "/v1/signup-grant", { ...request(signed), dailyCap: 10 })).body).toEqual({ error: "OPERATOR_SIGNATURE_REFUSED" });
    // A wildcard, http or path site never parses.
    for (const site of ["https://*.example", "http://shop.example", "https://shop.example/signup"]) expect((await post(vault.core, "/v1/signup-grant", { ...request(signed), sites: [site] })).body).toEqual({ error: "BAD_REQUEST" });
    const tooLong = await granted({ days: 91 });
    expect(tooLong.issued.body).toEqual({ error: "EXPIRED" });
  });

  it("generates the password itself, seals it to the inbox and the reply key only, and enforces site, daily cap and expiry", async () => {
    const { vault, inbox, reply, signup, advance, grant } = await granted();
    expect((await signup({}, "api")).body).toEqual({ error: "FILL_HOST_ONLY" });
    const first = await signup();
    expect(first.status).toBe(200);
    const body = first.body as { sealedPassword: unknown; sealedFields: unknown };
    const password = new TextDecoder().decode(await openWithVaultPrivateKey(inbox.privateKey, inbox.publicKey, body.sealedPassword, vault.scope));
    const fields = JSON.parse(new TextDecoder().decode(await openWithVaultPrivateKey(reply.privateKey, reply.publicKey, body.sealedFields, vault.scope)));
    expect(password.length).toBeGreaterThanOrEqual(16);
    expect(fields).toEqual({ NEW_PASSWORD: password, CONFIRM_PASSWORD: password });
    await expect(openWithVaultPrivateKey(reply.privateKey, reply.publicKey, body.sealedPassword, vault.scope)).rejects.toThrow();
    expect((await signup({ origin: "https://shop.example.evil" })).body).toEqual({ error: "ORIGIN_MISMATCH" });
    expect((await signup({ origin: "https://www.shop.example" })).body).toEqual({ error: "ORIGIN_MISMATCH" });
    // The page field's length limit shapes the password; an impossible one spends no use.
    expect((await signup({ field: { minLength: 20, maxLength: 8 } })).body).toEqual({ error: "POLICY_UNSATISFIABLE" });
    const short = (await signup({ field: { minLength: null, maxLength: 12 } })).body as { sealedPassword: unknown };
    expect(new TextDecoder().decode(await openWithVaultPrivateKey(inbox.privateKey, inbox.publicKey, short.sealedPassword, vault.scope))).toHaveLength(12);
    expect((await signup({ origin: "https://accounts.example" })).body).toEqual({ error: "DAILY_CAP" });
    // The next UTC day has a fresh count; after the expiry nothing works.
    advance(86_400_000);
    expect((await signup()).status).toBe(200);
    advance(30 * 86_400_000);
    expect((await signup()).body).toEqual({ error: "EXPIRED" });
    // Each use and each refusal is one audit line, ids and results only.
    const lines = (await readFile(join(vault.state, "audit.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line)).filter((line) => line.op === "signup");
    expect(lines.map((line) => line.result)).toEqual(["OK", "ORIGIN_MISMATCH", "ORIGIN_MISMATCH", "POLICY_UNSATISFIABLE", "OK", "DAILY_CAP", "OK", "EXPIRED"]);
    expect(JSON.stringify(lines)).not.toContain(password);
    expect(JSON.stringify(lines)).not.toContain(grant.sites[0]);
  });

  it("honours a site's stated rules a host merged into the field: its symbols and classes (queue item 37, SuccessFactors 8-18)", async () => {
    const { vault, inbox, signup } = await granted({ dailyCap: 5 });
    const open = async (field: Record<string, unknown>) => {
      const answer = await signup({ field });
      expect(answer.status).toBe(200);
      return new TextDecoder().decode(await openWithVaultPrivateKey(inbox.privateKey, inbox.publicKey, (answer.body as { sealedPassword: unknown }).sealedPassword, vault.scope));
    };
    const plain = await open({ minLength: 8, maxLength: 18, symbols: "" });
    expect(plain).toMatch(/^[A-Za-z0-9]{18}$/);
    const own = await open({ minLength: null, maxLength: 16, symbols: "!_" });
    expect(own).toMatch(/^[A-Za-z0-9!_]{16}$/);
    expect(own).toMatch(/[!_]/);
    expect((await signup({ field: { minLength: null, maxLength: 18, symbols: "a b" } })).body).toEqual({ error: "BAD_REQUEST" });
  });

  it("stops a revoked grant and every grant after revoke-all", async () => {
    const one = await granted();
    expect((await post(one.vault.core, "/v1/signup-revoke", { ownerUserId: owner, vaultId: one.vault.vaultId, grantId: one.grant.grantId })).status).toBe(200);
    expect((await one.signup()).body).toEqual({ error: "REVOKED" });
    const two = await granted();
    expect((await post(two.vault.core, "/v1/revoke", { ownerUserId: owner, vaultId: two.vault.vaultId, generation: 5 })).status).toBe(200);
    expect((await two.signup()).body).toEqual({ error: "REVOKED" });
    // Another owner's request never uses this grant.
    expect((await one.signup({ ownerUserId: "user:bob" })).body).toEqual({ error: "CERTIFICATE_REFUSED" });
  });
});

describe("space-vault-broker grants minted under the delegation (operator request 2026-10-18)", () => {
  it("mints a one-site, one-use, ten-minute grant only under a valid delegation, with no daily cap, and none after a revoke", async () => {
    let clock = Date.now();
    const vault = await enrolled(() => new Date(clock));
    const { certificate } = await vault.client.delegate((await delegation(vault)).request);
    const mint = async (overrides: Record<string, unknown> = {}, channel: "api" | "host" = "api") => (await vault.core.handle("POST", "/v1/signup-auto-grant",
      { ownerUserId: owner, vaultId: vault.vaultId, certificate, origin: "https://shop.example", ...overrides }, channel)).body as { certificate?: unknown; error?: string };
    const inbox = await generateVaultTransportKey();
    const reply = await generateVaultTransportKey();
    const signup = async (grant: unknown, origin = "https://shop.example") => (await vault.core.handle("POST", "/v1/signup", { ownerUserId: owner, vaultId: vault.vaultId,
      certificate: grant, origin, paneId: "pane:vaultpane1", roles: ["NEW_PASSWORD"], inboxPublicKey: b64.encode(inbox.publicKey), replyPublicKey: b64.encode(reply.publicKey) }, "host")).body;

    expect(await mint({}, "host")).toEqual({ error: "NOT_FOUND" });
    const first = (await mint()).certificate;
    expect(await verifyVaultCertificate(vault.core.signingPublicKey, first, vaultSignupGrantCertificateSchema, new Date(clock))).toMatchObject({ sites: ["https://shop.example"], dailyCap: 1 });
    expect(await signup(first, "https://other.example")).toEqual({ error: "ORIGIN_MISMATCH" });
    expect(await signup(first)).toHaveProperty("sealedPassword");
    expect(await signup(first)).toEqual({ error: "DAILY_CAP" });
    for (const origin of ["http://shop.example", "https://shop.example:8443", "https://shop.example/reset"]) expect(await mint({ origin })).toEqual({ error: "ORIGIN_MISMATCH" });
    expect(await mint({ ownerUserId: "user:bob" })).toEqual({ error: "CERTIFICATE_REFUSED" });

    const late = (await mint()).certificate;
    clock += 10 * 60_000 + 1;
    expect(await signup(late)).toEqual({ error: "EXPIRED" });
    const before = (await mint()).certificate;
    // No daily cap any more (operator request 2026-10-20).
    for (let used = 3; used < 25; used += 1) expect(await mint()).toHaveProperty("certificate");

    // Revoking agent access voids the delegation and every grant minted under it.
    expect((await post(vault.core, "/v1/revoke", { ownerUserId: owner, vaultId: vault.vaultId, generation: 2 })).status).toBe(200);
    expect(await mint()).toEqual({ error: "REVOKED" });
    expect(await signup(before)).toEqual({ error: "REVOKED" });
  });
});

describe("space-vault-broker logins agents add join the delegation without an unlock (operator request 2026-10-20)", () => {
  it("fills a saved login and a changed password at once, never at a new site, and stops after a revoke", async () => {
    const vault = await enrolled();
    const inbox = await generateVaultTransportKey();
    const { handle, request } = await delegation(vault);
    // A broker answer carries the inbox key only when the dock sent it.
    expect(await vault.client.delegate(request)).not.toHaveProperty("inboxKeyEnvelope");
    const second = await delegation(vault, 2);
    const signed = await vault.client.delegate({ ...second.request, sealedInboxKey: await sealToVaultPublicKey(b64.decode(vault.transport.publicKey), inbox.privateKey, vault.scope) });
    expect(signed.inboxKeyEnvelope).toMatchObject({ purpose: "INBOX_KEY" });
    const seal = (text: string) => sealToVaultPublicKey(inbox.publicKey, new TextEncoder().encode(text), vault.scope);
    const extend = (certificate: unknown, entry: Record<string, unknown>) => post(vault.core, "/v1/delegate-pending", { ownerUserId: owner, vaultId: vault.vaultId, certificate,
      keyEnvelope: signed.keyEnvelope, inboxKeyEnvelope: signed.inboxKeyEnvelope, entry: { sealedUsername: null, sealedPassword: null, ...entry } });
    const fillWith = async (certificate: unknown, itemHandle: string, fieldEnvelopes: unknown, origin: string) => {
      const host = await generateVaultTransportKey();
      const use = await post(vault.core, "/v1/use", useRequest(vault, certificate, itemHandle, { origin }));
      if (use.status !== 200) return use.body;
      const answer = await post(vault.core, "/v1/fill", { capability: (use.body as { capability: unknown }).capability, keyEnvelope: signed.keyEnvelope, fieldEnvelopes, replyPublicKey: b64.encode(host.publicKey) });
      return JSON.parse(new TextDecoder().decode(await openWithVaultPrivateKey(host.privateKey, host.publicKey, (answer.body as { sealedFields: unknown }).sealedFields, vault.scope)));
    };

    // A login an agent saved: fillable at its own site only, with the password it was saved with.
    const saved = newVaultHandle("vault_item");
    const added = await extend(signed.certificate, { handle: saved, origin: "https://new.example", sealedUsername: await seal("agent@example.com"), sealedPassword: await seal("SYNTHETIC-saved") });
    expect(added.status).toBe(200);
    const { certificate, fieldEnvelopes } = added.body as { certificate: { claims: { items: Array<{ handle: string; origins: string[] }>; generation: number } }; fieldEnvelopes: unknown };
    expect(certificate.claims.generation).toBe(2);
    expect(certificate.claims.items.find((item) => item.handle === saved)).toMatchObject({ origins: ["https://new.example"], fields: ["USERNAME", "PASSWORD"] });
    expect(JSON.stringify(added.body)).not.toContain("SYNTHETIC-saved");
    expect(await fillWith(certificate, saved, fieldEnvelopes, "https://new.example")).toEqual({ PASSWORD: "SYNTHETIC-saved" });
    expect(await fillWith(certificate, saved, fieldEnvelopes, "https://login.example")).toEqual({ error: "NOT_DELEGATED" });

    // A changed password keeps the item's signed site; a username, or a missing password, is refused for an existing item.
    const changed = await extend(certificate, { handle: second.handle, origin: "https://evil.example", sealedPassword: await seal("SYNTHETIC-changed") });
    const after = changed.body as { certificate: { claims: { items: Array<{ handle: string; origins: string[] }> } }; fieldEnvelopes: unknown };
    expect(after.certificate.claims.items.find((item) => item.handle === second.handle)?.origins).toEqual(["https://login.example"]);
    expect(await fillWith(after.certificate, second.handle, after.fieldEnvelopes, "https://login.example")).toEqual({ PASSWORD: "SYNTHETIC-changed" });
    expect((await extend(certificate, { handle: second.handle, origin: "https://login.example", sealedUsername: await seal("other"), sealedPassword: await seal("x") })).body).toEqual({ error: "BAD_ENTRY" });
    expect((await extend(certificate, { handle: newVaultHandle("vault_item"), origin: "https://new.example/path", sealedPassword: await seal("x") })).body).toEqual({ error: "BAD_ENTRY" });
    // An entry sealed to another key, or this delegation's older generation, opens nothing.
    const stranger = await generateVaultTransportKey();
    expect((await extend(certificate, { handle: newVaultHandle("vault_item"), origin: "https://new.example",
      sealedPassword: await sealToVaultPublicKey(stranger.publicKey, new TextEncoder().encode("x"), vault.scope) })).body).toEqual({ error: "ENTRY_REFUSED" });
    expect((await vault.core.handle("POST", "/v1/delegate-pending", {}, "host")).body).toEqual({ error: "NOT_FOUND" });
    expect(handle).not.toBe(second.handle);

    expect((await post(vault.core, "/v1/revoke", { ownerUserId: owner, vaultId: vault.vaultId, generation: 3 })).status).toBe(200);
    expect((await extend(certificate, { handle: newVaultHandle("vault_item"), origin: "https://new.example", sealedPassword: await seal("x") })).body).toEqual({ error: "GENERATION_RETIRED" });
  });
});
