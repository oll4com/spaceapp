/* @vitest-environment node */
import { describe, expect, it } from "vitest";
import {
  VaultCryptoError, generateVaultTransportKey, openServerShare, openWithVaultPrivateKey, sealServerShare, sealToVaultPublicKey,
  vaultBase64url, vaultItemRecordSchema, vaultRandomBytes, vaultSignupGrantOperatorMessage, vaultDelegationOperatorMessage, vaultDigest, openVaultEnvelope, vaultDelegateRequestSchema, vaultSignupGrantRequestSchema, vaultUnlockChallengeMessage, verifyVaultMessage, type VaultKdfParams,
  type VaultSymmetricEnvelope
} from "@space/contracts";
import { argon2idKdf, changeMasterPassword, confirmVaultItem, decryptVaultItem, encryptVaultItem, importVaultPending, restorePreviousVaultItem, setUpVault, signVaultSignupGrant, delegateVaultItems, unlockVault, vaultInboxKey, type VaultApi, type VaultInboxApi } from "../src/features/vault/vault-client.js";

// Synthetic secrets only. The fake API keeps what the server keeps (ciphertext and public keys); the fake broker does
// what the root-owned broker does, with a synthetic ARK the API side never sees.
const SENTINEL = "SYNTHETIC-dock-sentinel-91aa";
const fastKdf = async (password: string, params: VaultKdfParams) => {
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: new Uint8Array(vaultBase64url.decode(params.salt)), iterations: 1000 }, base, 256));
};

async function harness() {
  const ark = vaultRandomBytes(32);
  const transport = await generateVaultTransportKey();
  const server: { vault?: any; challenge?: string; sent: string[] } = { sent: [] };
  const remember = (body: unknown) => { server.sent.push(JSON.stringify(body)); return body; };
  const client: VaultApi = {
    vaultBroker: async () => ({ publicKey: vaultBase64url.encode(transport.publicKey), keyVersion: 1 }),
    vaultEnroll: async (body: any) => {
      remember(body);
      const scope = { ownerUserId: "user:alice", vaultId: body.vaultId, keyVersion: 1 };
      const share = await openWithVaultPrivateKey(transport.privateKey, transport.publicKey, body.sealedServerShare, scope);
      server.vault = { ...body, epoch: 1, serverShareEnvelope: await sealServerShare(ark, share, scope) };
      return { vaultId: body.vaultId, epoch: 1 };
    },
    vaultSetRecovery: async (recovery) => { remember(recovery); return { recovery: true }; },
    vaultUnlockChallenge: async () => {
      server.challenge = vaultBase64url.encode(vaultRandomBytes(32));
      const { vaultId, passwordEnvelope, kdf, unlockKeyVersion, epoch } = server.vault;
      return { challenge: server.challenge, epoch, expiresAt: "", vaultId, passwordEnvelope: passwordEnvelope as VaultSymmetricEnvelope, kdf, unlockKeyVersion };
    },
    vaultUnlock: async (body) => {
      remember(body);
      const { vaultId, epoch, unlockPublicKey, serverShareEnvelope } = server.vault;
      const message = vaultUnlockChallengeMessage({ ownerUserId: "user:alice", vaultId, epoch, challenge: body.challenge, replyPublicKey: body.replyPublicKey });
      if (body.challenge !== server.challenge || !await verifyVaultMessage(vaultBase64url.decode(unlockPublicKey), message, body.signature)) throw new Error("VAULT_UNLOCK_REFUSED");
      server.challenge = undefined;
      const scope = { ownerUserId: "user:alice", vaultId, keyVersion: 1 };
      const share = await openServerShare(ark, serverShareEnvelope, scope);
      return { sealedServerShare: await sealToVaultPublicKey(vaultBase64url.decode(body.replyPublicKey), share, scope), epoch };
    },
    vaultRotatePassword: async (body: any) => {
      remember(body);
      if (body.expectedEpoch !== server.vault.epoch || body.unlockPublicKey !== server.vault.unlockPublicKey) throw new Error("STALE");
      server.vault = { ...server.vault, kdf: body.kdf, passwordEnvelope: body.passwordEnvelope, epoch: server.vault.epoch + 1 };
      return { epoch: server.vault.epoch };
    }
  };
  return { client, server, ark, transport };
}

const policy = { agentUse: false, approvalMode: "ASSIST" as const, submitAllowed: false, maxFillsPerHour: 6, acceptedOriginRisks: [] };

describe("Vault dock client", () => {
  it("sets up and unlocks with password AND broker share; the server sees only ciphertext", async () => {
    const { client, server } = await harness();
    const { unlocked, recoveryKey } = await setUpVault(client, "user:alice", `${SENTINEL}-master`, fastKdf);
    expect(vaultBase64url.decode(recoveryKey)).toHaveLength(32);
    const again = await unlockVault(client, "user:alice", `${SENTINEL}-master`, fastKdf);
    expect(again.vrk).toEqual(unlocked.vrk);
    await expect(unlockVault(client, "user:alice", "wrong master password", fastKdf)).rejects.toBeInstanceOf(VaultCryptoError);
    for (const sent of server.sent) {
      expect(sent).not.toContain(SENTINEL);
      expect(sent).not.toContain(vaultBase64url.encode(unlocked.vrk));
      expect(sent).not.toContain(recoveryKey);
    }
  });

  it("encrypts items locally, keeps the old password until confirmed, and can restore it", async () => {
    const { client, server } = await harness();
    const { unlocked } = await setUpVault(client, "user:alice", "master", fastKdf);
    const draft = { label: "Synthetic shop", origins: ["https://shop.example"], policy, secrets: { USERNAME: "synthetic@example.com", PASSWORD: `${SENTINEL}-1` } };
    const first = vaultItemRecordSchema.parse(await encryptVaultItem(unlocked, draft));
    expect(JSON.stringify(first)).not.toContain(SENTINEL);
    expect(first.metadata.fieldRoles).toEqual(["USERNAME", "PASSWORD"]);
    expect(await decryptVaultItem(unlocked, first)).toEqual(draft.secrets);
    const changed = vaultItemRecordSchema.parse(await encryptVaultItem(unlocked, { ...draft, secrets: { ...draft.secrets, PASSWORD: `${SENTINEL}-2` } }, first));
    expect(changed.dekEnvelope).toEqual(first.dekEnvelope);
    expect(changed.history).toHaveLength(1);
    expect((await decryptVaultItem(unlocked, changed, changed.history[0]!.fields)).PASSWORD).toBe(`${SENTINEL}-1`);
    expect(vaultItemRecordSchema.parse(confirmVaultItem(changed)).history).toEqual([]);
    const restored = vaultItemRecordSchema.parse(restorePreviousVaultItem(changed));
    expect((await decryptVaultItem(unlocked, restored)).PASSWORD).toBe(`${SENTINEL}-1`);
    // An unchanged password adds no history; another user's keys cannot open the item.
    expect((await encryptVaultItem(unlocked, draft, first)).history).toEqual([]);
    await expect(decryptVaultItem({ ...unlocked, ownerUserId: "user:bob" }, first)).rejects.toBeInstanceOf(VaultCryptoError);
    void server;
  });

  it("signs a sign-up grant with the enrolled unlock key over exactly the chosen sites, cap and expiry", async () => {
    const { client, server } = await harness();
    const { unlocked } = await setUpVault(client, "user:alice", "a master", fastKdf);
    const grant = await signVaultSignupGrant(unlocked, { sites: ["https://shop.example", "https://accounts.example"], dailyCap: 3, days: 30 });
    expect(vaultSignupGrantRequestSchema.parse(grant)).toEqual(grant);
    expect(grant.sites).toEqual(["https://accounts.example", "https://shop.example"]);
    expect(Date.parse(grant.expiresAt) - Date.now()).toBeGreaterThan(29 * 86_400_000);
    const message = (sites: string[]) => vaultSignupGrantOperatorMessage({ ownerUserId: "user:alice", vaultId: unlocked.vaultId, ...grant, sites });
    const key = vaultBase64url.decode(server.vault.unlockPublicKey);
    expect(await verifyVaultMessage(key, message(grant.sites), grant.operatorSignature)).toBe(true);
    expect(await verifyVaultMessage(key, message(["https://evil.example"]), grant.operatorSignature)).toBe(false);
  });

  it("hands every active login not hidden from agents to the broker with submit and a standing expiry, signed over exactly what it sends", async () => {
    const { client, server, transport } = await harness();
    const { unlocked } = await setUpVault(client, "user:alice", "a master", fastKdf);
    const allowed = vaultItemRecordSchema.parse(await encryptVaultItem(unlocked, { label: "Shop", origins: ["https://shop.example"], secrets: { USERNAME: "synthetic@example.com", PASSWORD: SENTINEL },
      policy: { ...policy, agentUse: true, approvalMode: "FULL" } }));
    const notAllowed = vaultItemRecordSchema.parse(await encryptVaultItem(unlocked, { label: "Bank", origins: ["https://bank.example"], secrets: { PASSWORD: "other" }, policy }));
    const pending = vaultItemRecordSchema.parse(await encryptVaultItem(unlocked, { label: "New", origins: ["https://new.example"], status: "PENDING", secrets: { PASSWORD: "p" }, policy: { ...policy, agentUse: true } }));
    let sent: any;
    const done = await delegateVaultItems({ vaultBroker: client.vaultBroker, vaultDelegate: async (body: any) => { sent = body; return { generation: body.generation }; } } as never, unlocked,
      { records: [allowed, notAllowed, pending], delegationGeneration: 2 });
    expect(done).toMatchObject({ generation: 3, count: 1 });
    expect(sent.items).toEqual([{ handle: allowed.metadata.id, origins: ["https://shop.example"], fields: ["USERNAME", "PASSWORD"], approvalMode: "FULL", submit: true }]);
    expect(Date.parse(sent.expiresAt) - Date.now()).toBeGreaterThan(3000 * 86_400_000);
    expect(JSON.stringify(sent)).not.toContain(SENTINEL);
    expect(vaultDelegateRequestSchema.parse(sent)).toEqual(sent);
    const message = vaultDelegationOperatorMessage({ ownerUserId: "user:alice", vaultId: unlocked.vaultId, envelopeDigest: await vaultDigest(sent.fillEnvelopes), generation: 3,
      unlockEpoch: unlocked.epoch, expiresAt: sent.expiresAt, items: sent.items });
    expect(await verifyVaultMessage(vaultBase64url.decode(server.vault.unlockPublicKey), message, sent.operatorSignature)).toBe(true);
    const scope = { ownerUserId: "user:alice", vaultId: unlocked.vaultId, keyVersion: 1 };
    const fillKey = await openWithVaultPrivateKey(transport.privateKey, transport.publicKey, sent.sealedFillKey, scope);
    const field = await openVaultEnvelope(fillKey, sent.fillEnvelopes[allowed.metadata.id].PASSWORD, { ...scope, purpose: "FILL_FIELD", itemId: allowed.metadata.id, field: "PASSWORD", generation: 3 });
    expect(new TextDecoder().decode(field)).toBe(SENTINEL);
    // After a revoke while unlocked the vault's epoch has moved on: the dock signs the current one.
    await delegateVaultItems({ vaultBroker: client.vaultBroker, vaultDelegate: async (body: any) => { sent = body; return { generation: body.generation }; } } as never, unlocked,
      { records: [allowed], delegationGeneration: 3, epoch: unlocked.epoch + 1 });
    expect(sent.unlockEpoch).toBe(unlocked.epoch + 1);
    expect(await verifyVaultMessage(vaultBase64url.decode(server.vault.unlockPublicKey), vaultDelegationOperatorMessage({ ownerUserId: "user:alice", vaultId: unlocked.vaultId,
      envelopeDigest: await vaultDigest(sent.fillEnvelopes), generation: 4, unlockEpoch: unlocked.epoch + 1, expiresAt: sent.expiresAt, items: sent.items }), sent.operatorSignature)).toBe(true);
    // An item hidden from agents (agentUse off) never goes; with nothing to hand over nothing is sent.
    expect(await delegateVaultItems({ vaultBroker: client.vaultBroker, vaultDelegate: async () => { throw new Error("not sent"); } } as never, unlocked, { records: [notAllowed], delegationGeneration: 0 })).toBeNull();
  });

  it("changes the master password without changing the unlock key", async () => {
    const { client } = await harness();
    const { unlocked } = await setUpVault(client, "user:alice", "old master", fastKdf);
    const rotated = await changeMasterPassword(client, unlocked, "new master", fastKdf);
    expect(rotated.epoch).toBe(2);
    expect((await unlockVault(client, "user:alice", "new master", fastKdf)).vrk).toEqual(unlocked.vrk);
    await expect(unlockVault(client, "user:alice", "old master", fastKdf)).rejects.toBeInstanceOf(VaultCryptoError);
  });

  it("adds logins agents saved and applies passwords they changed while locked as ACTIVE items, the old password kept for undo", async () => {
    const { client } = await harness();
    const { unlocked } = await setUpVault(client, "user:alice", "master", fastKdf);
    const stored: Record<string, any> = {};
    let inbox: any = null;
    const pending: any[] = [];
    const deleted: string[] = [];
    const api: VaultInboxApi = {
      vaultInbox: async () => ({ inbox }), vaultSetInbox: async (body) => { inbox = body; return { inbox: true }; },
      vaultPending: async () => ({ pending: pending.splice(0) }), vaultDeletePending: async (id) => { deleted.push(id); return { deleted: true }; },
      vaultItem: async (id) => ({ item: vaultItemRecordSchema.parse(stored[id]) }), vaultSaveItem: async (item) => { stored[item.metadata.id] = item; return { item: vaultItemRecordSchema.parse(item) }; }
    };
    const key = await vaultInboxKey(api, unlocked);
    expect(inbox.publicKey).toBe(vaultBase64url.encode(key.publicKey));
    expect(JSON.stringify(inbox)).not.toContain(vaultBase64url.encode(key.privateKey));
    expect((await vaultInboxKey(api, unlocked)).privateKey).toEqual(key.privateKey);
    const scope = { ownerUserId: "user:alice", vaultId: unlocked.vaultId, keyVersion: 1 };
    const seal = (text: string) => sealToVaultPublicKey(key.publicKey, new TextEncoder().encode(text), scope);
    const existing = vaultItemRecordSchema.parse(await encryptVaultItem(unlocked, { label: "Mail", origins: ["https://mail.example"], policy, secrets: { USERNAME: "synthetic@example.com", PASSWORD: "SYNTHETIC-old" } }));
    stored[existing.metadata.id] = existing;
    const newHandle = "vault_item:BBBBBBBBBBBBBBBBBBBBBB";
    pending.push({ id: "vault_pending:AAAAAAAAAAAAAAAAAAAAAA", kind: "NEW_ACCOUNT", handle: newHandle, label: "Shop", origin: "https://shop.example", sealedUsername: await seal("synthetic-shop@example.com"), sealedPassword: await seal(`${SENTINEL}-new`), paneId: null, createdAt: "" },
      { id: "vault_pending:CCCCCCCCCCCCCCCCCCCCCC", kind: "CHANGE_PASSWORD", handle: existing.metadata.id, label: "Mail", origin: "https://mail.example", sealedUsername: null, sealedPassword: await seal(`${SENTINEL}-changed`), paneId: null, createdAt: "" },
      { id: "vault_pending:DDDDDDDDDDDDDDDDDDDDDD", kind: "NEW_ACCOUNT", handle: "vault_item:DDDDDDDDDDDDDDDDDDDDDD", label: "Forum", origin: "https://forum.example", sealedUsername: await seal("synthetic-forum"), sealedPassword: null, paneId: null, createdAt: "" });
    expect(await importVaultPending(api, unlocked, key)).toBe(3);
    expect(deleted).toHaveLength(3);
    const created = vaultItemRecordSchema.parse(stored[newHandle]);
    expect(created.metadata).toMatchObject({ status: "ACTIVE", policy: { agentUse: true, approvalMode: "FULL", submitAllowed: true } });
    expect(await decryptVaultItem(unlocked, created)).toEqual({ USERNAME: "synthetic-shop@example.com", PASSWORD: `${SENTINEL}-new` });
    expect(await decryptVaultItem(unlocked, vaultItemRecordSchema.parse(stored["vault_item:DDDDDDDDDDDDDDDDDDDDDD"]))).toEqual({ USERNAME: "synthetic-forum" });
    const changedItem = vaultItemRecordSchema.parse(stored[existing.metadata.id]);
    expect(changedItem.metadata.status).toBe("ACTIVE");
    expect((await decryptVaultItem(unlocked, changedItem)).PASSWORD).toBe(`${SENTINEL}-changed`);
    expect((await decryptVaultItem(unlocked, changedItem, changedItem.history[0]!.fields)).PASSWORD).toBe("SYNTHETIC-old");
  });

  it("derives keys with Argon2id at the stored parameters", async () => {
    const params = { alg: "argon2id" as const, version: 0x13 as const, memoryKiB: 19_456, iterations: 2, parallelism: 1, keyLength: 32 as const, salt: vaultBase64url.encode(vaultRandomBytes(16)) };
    const first = await argon2idKdf("synthetic master", params);
    expect(first).toHaveLength(32);
    expect(await argon2idKdf("synthetic master", params)).toEqual(first);
    expect(await argon2idKdf("other master", params)).not.toEqual(first);
  }, 60_000);
});
