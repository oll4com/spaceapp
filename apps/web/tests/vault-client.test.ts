/* @vitest-environment node */
import { describe, expect, it } from "vitest";
import {
  VaultCryptoError, generateVaultTransportKey, openServerShare, openWithVaultPrivateKey, sealServerShare, sealToVaultPublicKey,
  vaultBase64url, vaultItemRecordSchema, vaultRandomBytes, vaultSignupGrantOperatorMessage, vaultDelegationOperatorMessage, vaultDigest, openVaultEnvelope, vaultDelegateRequestSchema, vaultSignupGrantRequestSchema, vaultUnlockChallengeMessage, verifyVaultMessage, type VaultKdfParams,
  vaultOperatorRequestMessage, sealVaultEnvelope, type VaultSymmetricEnvelope
} from "@space/contracts";
import { VAULT_AUTO_LOCK_DEFAULTS, VAULT_AUTO_LOCK_KEY, readVaultAutoLock } from "../src/features/vault/vault-auto-lock.js";
import {
  VaultInboxError, argon2idKdf, changeMasterPassword, confirmVaultItem, recoverVault, decryptVaultItem, encryptVaultItem, importVaultPending, planDuplicateRemoval, setUpVault, signVaultSignupGrant, delegateVaultItems, unlockVault, vaultInboxKey,
  type VaultApi, type VaultInboxApi
} from "../src/features/vault/vault-client.js";

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
    vaultSetRecovery: async (recovery) => { remember(recovery); server.vault = { ...server.vault, recovery }; return { recovery: true }; },
    vaultRecovery: async () => { server.sent.push("GET recovery"); return { recovery: server.vault?.recovery ?? null }; },
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
    // The recovery envelope goes with the unlock key's signature over it, at the vault's epoch (Vault review 2026-10-22).
    const recovery = JSON.parse(server.sent[1]!) as Record<string, unknown> & { operatorSignature: string };
    expect(recovery.epoch).toBe(1);
    expect(await verifyVaultMessage(vaultBase64url.decode(server.vault.unlockPublicKey), vaultOperatorRequestMessage("recovery", { ownerUserId: "user:alice", vaultId: unlocked.vaultId, ...recovery }), recovery.operatorSignature)).toBe(true);
    for (const sent of server.sent) {
      expect(sent).not.toContain(SENTINEL);
      expect(sent).not.toContain(vaultBase64url.encode(unlocked.vrk));
      expect(sent).not.toContain(recoveryKey);
    }
  });

  it("recovers with the recovery key: a new master password, a new epoch, and the old password opens nothing (hardening step 14)", async () => {
    const { client, server } = await harness();
    const { unlocked, recoveryKey } = await setUpVault(client, "user:alice", `${SENTINEL}-old`, fastKdf);
    // A wrong recovery key fails in the browser: no challenge is signed and no unlock or password change is sent.
    const sentBefore = server.sent.length;
    await expect(recoverVault(client, "user:alice", vaultBase64url.encode(vaultRandomBytes(32)), `${SENTINEL}-new`, fastKdf)).rejects.toBeInstanceOf(VaultCryptoError);
    await expect(recoverVault(client, "user:alice", "not-a-key", `${SENTINEL}-new`, fastKdf)).rejects.toBeInstanceOf(VaultCryptoError);
    expect(server.sent.slice(sentBefore).every((sent) => sent === "GET recovery")).toBe(true);
    const recovered = await recoverVault(client, "user:alice", recoveryKey, `${SENTINEL}-new`, fastKdf);
    expect(recovered.vrk).toEqual(unlocked.vrk);
    expect(recovered.epoch).toBe(unlocked.epoch + 1);
    expect(JSON.parse(server.sent.at(-1)!)).toMatchObject({ recovery: true, expectedEpoch: unlocked.epoch });
    await expect(unlockVault(client, "user:alice", `${SENTINEL}-old`, fastKdf)).rejects.toBeInstanceOf(VaultCryptoError);
    expect((await unlockVault(client, "user:alice", `${SENTINEL}-new`, fastKdf)).vrk).toEqual(unlocked.vrk);
    for (const sent of server.sent) { expect(sent).not.toContain(SENTINEL); expect(sent).not.toContain(recoveryKey); }
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
    expect(sent).not.toHaveProperty("sealedInboxKey");
    // With the inbox key, it goes along sealed to the broker only (operator request 2026-10-20: agents never wait for an unlock).
    const inbox = await generateVaultTransportKey();
    await delegateVaultItems({ vaultBroker: client.vaultBroker, vaultDelegate: async (body: any) => { sent = body; return { generation: body.generation }; } } as never, unlocked,
      { records: [allowed], delegationGeneration: 3, inbox });
    expect(vaultDelegateRequestSchema.parse(sent)).toEqual(sent);
    expect(await openWithVaultPrivateKey(transport.privateKey, transport.publicKey, sent.sealedInboxKey, scope)).toEqual(inbox.privateKey);
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
    const { client, server } = await harness();
    const { unlocked } = await setUpVault(client, "user:alice", "master", fastKdf);
    const stored: Record<string, any> = {};
    let inbox: any = null;
    const pending: any[] = [];
    const deleted: string[] = [];
    const api: VaultInboxApi = {
      vaultInbox: async () => ({ inbox }), vaultSetInbox: async (body) => { inbox = body; return { inbox: true }; },
      vaultPending: async () => ({ pending: pending.splice(0) }), vaultDeletePending: async (id) => { deleted.push(id); return { deleted: true }; },
      vaultItem: async (id) => ({ item: vaultItemRecordSchema.parse(stored[id]) }), vaultSaveItem: async (item) => { stored[item.metadata.id] = item; return { item: vaultItemRecordSchema.parse(item) }; },
      vaultItems: async () => ({ items: Object.values(stored).map((record: any) => record.metadata) })
    };
    const key = await vaultInboxKey(api, unlocked);
    expect(inbox.publicKey).toBe(vaultBase64url.encode(key.publicKey));
    expect(JSON.stringify(inbox)).not.toContain(vaultBase64url.encode(key.privateKey));
    expect((await vaultInboxKey(api, unlocked)).privateKey).toEqual(key.privateKey);
    // The key goes with the unlock key's signature (Vault review 2026-10-22); a stored key this Vault cannot open is an error, never silence.
    expect(inbox.epoch).toBe(unlocked.epoch);
    expect(await verifyVaultMessage(vaultBase64url.decode(server.vault.unlockPublicKey), vaultOperatorRequestMessage("inbox", { ownerUserId: "user:alice", vaultId: unlocked.vaultId, ...inbox }), inbox.operatorSignature)).toBe(true);
    const mine = inbox;
    inbox = { ...mine, privateKeyEnvelope: await sealVaultEnvelope(vaultRandomBytes(32), key.privateKey, { ownerUserId: "user:alice", vaultId: unlocked.vaultId, keyVersion: 1, purpose: "INBOX_KEY" }) };
    await expect(vaultInboxKey(api, unlocked)).rejects.toMatchObject({ code: "INBOX_KEY_UNREADABLE" });
    await expect(vaultInboxKey(api, unlocked)).rejects.toBeInstanceOf(VaultInboxError);
    inbox = mine;
    const scope = { ownerUserId: "user:alice", vaultId: unlocked.vaultId, keyVersion: 1 };
    const seal = (text: string) => sealToVaultPublicKey(key.publicKey, new TextEncoder().encode(text), scope);
    const existing = vaultItemRecordSchema.parse(await encryptVaultItem(unlocked, { label: "Mail", origins: ["https://mail.example"], policy, secrets: { USERNAME: "synthetic@example.com", PASSWORD: "SYNTHETIC-old" } }));
    stored[existing.metadata.id] = existing;
    const newHandle = "vault_item:BBBBBBBBBBBBBBBBBBBBBB";
    pending.push({ id: "vault_pending:AAAAAAAAAAAAAAAAAAAAAA", kind: "NEW_ACCOUNT", handle: newHandle, label: "Shop", origin: "https://shop.example", sealedUsername: await seal("synthetic-shop@example.com"), sealedPassword: await seal(`${SENTINEL}-new`), paneId: null, createdAt: "" },
      { id: "vault_pending:CCCCCCCCCCCCCCCCCCCCCC", kind: "CHANGE_PASSWORD", handle: existing.metadata.id, label: "Mail", origin: "https://mail.example", sealedUsername: null, sealedPassword: await seal(`${SENTINEL}-changed`), paneId: null, createdAt: "" },
      { id: "vault_pending:DDDDDDDDDDDDDDDDDDDDDD", kind: "NEW_ACCOUNT", handle: "vault_item:DDDDDDDDDDDDDDDDDDDDDD", label: "Forum", origin: "https://forum.example", sealedUsername: await seal("synthetic-forum"), sealedPassword: null, paneId: null, createdAt: "" });
    expect(await importVaultPending(api, unlocked, key)).toEqual({ imported: 3, unreadable: [] });
    expect(deleted).toHaveLength(3);
    const created = vaultItemRecordSchema.parse(stored[newHandle]);
    expect(created.metadata).toMatchObject({ status: "ACTIVE", policy: { agentUse: true, approvalMode: "FULL", submitAllowed: true } });
    expect(await decryptVaultItem(unlocked, created)).toEqual({ USERNAME: "synthetic-shop@example.com", PASSWORD: `${SENTINEL}-new` });
    expect(await decryptVaultItem(unlocked, vaultItemRecordSchema.parse(stored["vault_item:DDDDDDDDDDDDDDDDDDDDDD"]))).toEqual({ USERNAME: "synthetic-forum" });
    const changedItem = vaultItemRecordSchema.parse(stored[existing.metadata.id]);
    expect(changedItem.metadata.status).toBe("ACTIVE");
    expect((await decryptVaultItem(unlocked, changedItem)).PASSWORD).toBe(`${SENTINEL}-changed`);
    expect((await decryptVaultItem(unlocked, changedItem, changedItem.history[0]!.fields)).PASSWORD).toBe("SYNTHETIC-old");

    // Resets of a site the Vault already holds (2026-10-19: three Braintrust resets made three items): the same site and
    // username update that one login, oldest first, so it ends with the newest password; another username is a new login.
    const reset = (id: string, handle: string, password: string, createdAt: string, username = "synthetic-shop@example.com") => seal(username).then(async (sealedUsername) =>
      ({ id, kind: "NEW_ACCOUNT", handle, label: "Shop", origin: "https://shop.example", sealedUsername, sealedPassword: await seal(password), paneId: null, createdAt }));
    pending.push(await reset("vault_pending:EEEEEEEEEEEEEEEEEEEEEE", "vault_item:EEEEEEEEEEEEEEEEEEEEEE", `${SENTINEL}-third`, "2026-10-19T08:14:00.000Z"),
      await reset("vault_pending:FFFFFFFFFFFFFFFFFFFFFF", "vault_item:FFFFFFFFFFFFFFFFFFFFFF", `${SENTINEL}-second`, "2026-10-19T08:12:00.000Z"),
      await reset("vault_pending:GGGGGGGGGGGGGGGGGGGGGG", "vault_item:GGGGGGGGGGGGGGGGGGGGGG", `${SENTINEL}-other`, "2026-10-19T08:13:00.000Z", "another-shop-user"));
    // A waiting login sealed to a key this inbox does not hold stays waiting and is reported (Vault review 2026-10-22).
    const foreignKey = await generateVaultTransportKey();
    pending.push({ id: "vault_pending:HHHHHHHHHHHHHHHHHHHHHH", kind: "CHANGE_PASSWORD", handle: existing.metadata.id, label: "Mail", origin: "https://mail.example", sealedUsername: null,
      sealedPassword: await sealToVaultPublicKey(foreignKey.publicKey, new TextEncoder().encode(`${SENTINEL}-foreign`), scope), paneId: null, createdAt: "2026-10-19T08:15:00.000Z" });
    expect(await importVaultPending(api, unlocked, key)).toEqual({ imported: 3, unreadable: [{ kind: "CHANGE_PASSWORD", label: "Mail", origin: "https://mail.example" }] });
    expect(deleted).not.toContain("vault_pending:HHHHHHHHHHHHHHHHHHHHHH");
    expect((await decryptVaultItem(unlocked, vaultItemRecordSchema.parse(stored[existing.metadata.id]))).PASSWORD).toBe(`${SENTINEL}-changed`);
    expect(stored["vault_item:EEEEEEEEEEEEEEEEEEEEEE"]).toBeUndefined();
    expect(stored["vault_item:FFFFFFFFFFFFFFFFFFFFFF"]).toBeUndefined();
    const shop = vaultItemRecordSchema.parse(stored[newHandle]);
    expect((await decryptVaultItem(unlocked, shop)).PASSWORD).toBe(`${SENTINEL}-third`);
    expect(shop.history.length).toBe(2);
    expect((await decryptVaultItem(unlocked, vaultItemRecordSchema.parse(stored["vault_item:GGGGGGGGGGGGGGGGGGGGGG"]))).USERNAME).toBe("another-shop-user");
  });

  it("plans duplicate removal: the same site, username and account more than once, the most recently changed copy stays (operator request 2026-10-22)", async () => {
    const { client } = await harness();
    const { unlocked } = await setUpVault(client, "user:alice", "master", fastKdf);
    const make = async (label: string, origins: string[], username: string | undefined, googleAccountId: string | null = null) =>
      vaultItemRecordSchema.parse(await encryptVaultItem(unlocked, { label, origins, policy, googleAccountId, secrets: { ...(username ? { USERNAME: username } : {}), PASSWORD: `${SENTINEL}-${label}` } }));
    const older = await make("Shop old", ["https://shop.example"], "Same@Example.com");
    const newer = await make("Shop new", ["https://shop.example"], "same@example.com");
    const newest = await make("Shop newest", ["https://shop.example", "https://m.shop.example"], "same@example.com ");
    const otherUser = await make("Shop other", ["https://shop.example"], "other@example.com");
    const otherAccount = await make("Shop work", ["https://shop.example"], "same@example.com", "google_account:work");
    const noUsernameA = await make("Wifi A", ["https://router.example"], undefined);
    const noUsernameB = await make("Wifi B", ["https://router.example"], undefined);
    const stats = { [older.metadata.id]: { addedAt: "2026-10-01T00:00:00.000Z", changedAt: "2026-10-05T00:00:00.000Z" }, [newer.metadata.id]: { addedAt: "2026-10-02T00:00:00.000Z", changedAt: "2026-10-10T00:00:00.000Z" },
      [newest.metadata.id]: { addedAt: "2026-10-20T00:00:00.000Z", changedAt: "2026-10-20T00:00:00.000Z" } };
    const plan = await planDuplicateRemoval(unlocked, [older, newer, newest, otherUser, otherAccount, noUsernameA, noUsernameB], stats);
    expect(plan).toEqual({ groups: 1, remove: [newer.metadata.id, older.metadata.id] });
    // A pending copy is not a duplicate of an active one; nothing to remove among distinct logins.
    expect(await planDuplicateRemoval(unlocked, [otherUser, otherAccount, { ...older, metadata: { ...older.metadata, status: "PENDING" } }], stats)).toEqual({ groups: 0, remove: [] });
  });

  it("never auto-locks by default; a choice the operator stored still wins (operator decision 2026-10-19)", () => {
    const store = new Map<string, string>();
    const local = { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => { store.set(key, value); } };
    const previous = (globalThis as { localStorage?: unknown }).localStorage;
    (globalThis as { localStorage?: unknown }).localStorage = local;
    try {
      expect(VAULT_AUTO_LOCK_DEFAULTS).toEqual({ idleMinutes: 0, lockOnHide: false });
      expect(readVaultAutoLock()).toEqual({ idleMinutes: 0, lockOnHide: false });
      local.setItem(VAULT_AUTO_LOCK_KEY, JSON.stringify({ idleMinutes: 5, lockOnHide: true }));
      expect(readVaultAutoLock()).toEqual({ idleMinutes: 5, lockOnHide: true });
    } finally {
      (globalThis as { localStorage?: unknown }).localStorage = previous;
    }
  });

  it("derives keys with Argon2id at the stored parameters", async () => {
    const params = { alg: "argon2id" as const, version: 0x13 as const, memoryKiB: 19_456, iterations: 2, parallelism: 1, keyLength: 32 as const, salt: vaultBase64url.encode(vaultRandomBytes(16)) };
    const first = await argon2idKdf("synthetic master", params);
    expect(first).toHaveLength(32);
    expect(await argon2idKdf("synthetic master", params)).toEqual(first);
    expect(await argon2idKdf("other master", params)).not.toEqual(first);
  }, 60_000);
});
