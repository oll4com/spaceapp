// Vault storage on a real, disposable PostgreSQL: migration 0218 applies on top of the full chain; envelopes made by the
// Vault crypto round-trip; no synthetic secret or ARK reaches any table; reads are owner-scoped and a disabled owner has
// no vault; nonces are one-time and die with their epoch or generation; revocation retires delegated envelopes; the audit
// chain detects tampering. Synthetic values only. Skips with a reason when Docker or the image is missing.
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  VAULT_KDF_DEFAULTS, type VaultEnrollment, type VaultItemRecord, generateVaultSigningKey, newVaultHandle, sealServerShare, sealVaultEnvelope,
  signVaultCertificate, splitVaultRootKey, vaultBase64url, vaultDigest, vaultRandomBytes
} from "@space/contracts";
import { PostgresVaultRepository, VaultConflictError } from "../src/vault-repository.js";
import { applyPendingMigrations } from "../src/migration-runner.js";
import { loadMigrations } from "../src/migrations.js";
import { disposablePostgresUnavailableReason, startDisposablePostgres, type DisposablePostgres } from "./support/disposable-postgres.js";

const unavailable = disposablePostgresUnavailableReason();
const SENTINEL = "SYNTHETIC-vault-sentinel-c41d";
const ark = vaultRandomBytes(32);
const encode = new TextEncoder();
const alice = "user:vault-alice";
const bob = "user:vault-bob";
const carol = "user:vault-carol";

async function enrollment(owner: string): Promise<VaultEnrollment> {
  const vaultId = newVaultHandle("vault");
  const scope = { ownerUserId: owner, vaultId, keyVersion: 1 };
  const { passwordShare, serverShare } = splitVaultRootKey(vaultRandomBytes(32));
  const signing = await generateVaultSigningKey();
  return {
    vaultId, kdf: { ...VAULT_KDF_DEFAULTS, salt: vaultBase64url.encode(vaultRandomBytes(16)) },
    // A password-share stand-in: the real one is sealed under the Argon2id key in the browser.
    passwordEnvelope: await sealVaultEnvelope(vaultRandomBytes(32), passwordShare, { ...scope, purpose: "PASSWORD_SHARE" }),
    serverShareEnvelope: await sealServerShare(ark, serverShare, scope),
    unlockPublicKey: vaultBase64url.encode(signing.publicKey), unlockKeyVersion: 1
  };
}

async function item(owner: string, vaultId: string, id = newVaultHandle("vault_item")): Promise<VaultItemRecord> {
  const scope = { ownerUserId: owner, vaultId, keyVersion: 1, itemId: id };
  const dek = vaultRandomBytes(32);
  return {
    metadata: { id, label: "Synthetic login", origins: ["https://example.com"], fieldRoles: ["USERNAME", "PASSWORD"],
      policy: { agentUse: true, approvalMode: "ASSIST", submitAllowed: false, maxFillsPerHour: 6, acceptedOriginRisks: [] }, status: "ACTIVE", googleAccountId: null, loginKey: null, loginPage: null },
    keyVersion: 1, history: [],
    dekEnvelope: await sealVaultEnvelope(vaultRandomBytes(32), dek, { ...scope, purpose: "ITEM_KEY" }),
    fields: {
      USERNAME: await sealVaultEnvelope(dek, encode.encode(`${SENTINEL}-user`), { ...scope, purpose: "ITEM_FIELD", field: "USERNAME" }),
      PASSWORD: await sealVaultEnvelope(dek, encode.encode(SENTINEL), { ...scope, purpose: "ITEM_FIELD", field: "PASSWORD" })
    }
  };
}

describe.skipIf(unavailable !== null)(`vault repository on PostgreSQL${unavailable ? ` (skipped: ${unavailable})` : ""}`, () => {
  let server: DisposablePostgres;
  let pool: pg.Pool;
  let repository: PostgresVaultRepository;

  beforeAll(async () => {
    server = await startDisposablePostgres("vault");
    await server.createDatabase("space_vault");
    pool = server.pool("space_vault", 4);
    const client = await pool.connect();
    try {
      await applyPendingMigrations(client, await loadMigrations());
    } finally {
      client.release();
    }
    for (const user of [alice, bob, carol]) await pool.query("INSERT INTO users(id, email, role) VALUES ($1, $2, 'OPERATOR')", [user, `${user.slice(5)}@space.local`]);
    repository = new PostgresVaultRepository(pool);
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    await server?.stop();
  });

  it("stores envelopes only, scoped to their owner, with nothing secret in any table", async () => {
    const enrolled = await repository.enroll(alice, await enrollment(alice));
    expect(enrolled).toMatchObject({ ownerUserId: alice, epoch: 1, delegationGeneration: 0, auditSeq: 1 });
    await expect(repository.enroll(alice, await enrollment(alice))).rejects.toThrow("VAULT_EXISTS");
    const saved = await item(alice, enrolled.vaultId);
    expect(await repository.saveItem(alice, saved)).toEqual(saved);
    expect(await repository.listItems(alice)).toEqual([saved.metadata]);
    expect(await repository.getItem(bob, saved.metadata.id)).toBeNull();
    // Another owner can neither read nor overwrite the handle.
    const bobVault = await repository.enroll(bob, await enrollment(bob));
    expect(await repository.saveItem(bob, await item(bob, bobVault.vaultId, saved.metadata.id))).toBeNull();
    expect((await repository.getItem(alice, saved.metadata.id))?.dekEnvelope).toEqual(saved.dekEnvelope);
    await expect(repository.saveItem(alice, { ...saved, fields: { PASSWORD: { plaintext: SENTINEL } } } as never)).rejects.toThrow();
    // A changed password keeps the earlier envelope as history until the operator confirms; PENDING round-trips.
    const changed = { ...saved, metadata: { ...saved.metadata, status: "PENDING" as const }, history: [{ fields: saved.fields, replacedAt: "2026-10-17T12:00:00.000Z" }] };
    expect(await repository.saveItem(alice, changed)).toEqual(changed);
    expect((await repository.listItems(alice))[0]?.status).toBe("PENDING");
    expect(await repository.saveItem(alice, saved)).toEqual(saved);
    // A Chrome import's Google account and login key round-trip (migration 0240); null clears them again.
    const mapped = { ...saved, metadata: { ...saved.metadata, googleAccountId: "google_account:work-1", loginKey: "K".repeat(22) } };
    expect(await repository.saveItem(alice, mapped)).toEqual(mapped);
    expect((await repository.listItems(alice))[0]).toMatchObject({ googleAccountId: "google_account:work-1", loginKey: "K".repeat(22) });
    // The bulk read and the login-key lookup (migration 0241's index) are owner-scoped like every read.
    expect(await repository.listItemRecords(alice)).toEqual([mapped]);
    // A login page (migration 0295) is metadata: set by handle with no envelope touched, for its owner only, null clears it.
    expect(await repository.setLoginPage(bob, saved.metadata.id, "https://example.com/login")).toBe(0);
    expect(await repository.setLoginPage(alice, saved.metadata.id, "https://example.com/login")).toBe(1);
    expect(await repository.getItem(alice, saved.metadata.id)).toEqual({ ...mapped, metadata: { ...mapped.metadata, loginPage: "https://example.com/login" } });
    expect(await repository.setLoginPage(alice, saved.metadata.id, null)).toBe(1);
    expect(await repository.listItemRecords(bob)).toEqual([]);
    expect(await repository.itemsByLoginKey(alice, "K".repeat(22))).toEqual([mapped.metadata]);
    expect(await repository.itemsByLoginKey(bob, "K".repeat(22))).toEqual([]);
    // A batch saves in one transaction, each item audited; a batch delete removes only this owner's items.
    const batch = await Promise.all([1, 2, 3].map(() => item(alice, enrolled.vaultId)));
    expect(await repository.saveItems(alice, batch)).toEqual(batch);
    expect(await repository.saveItems(carol, batch)).toBeNull();
    expect(await repository.deleteItems(bob, batch.map((entry) => entry.metadata.id))).toBe(0);
    expect(await repository.deleteItems(alice, [...batch.map((entry) => entry.metadata.id), batch[0]!.metadata.id])).toBe(3);
    expect((await repository.listAudit(alice, { limit: 6 })).map((entry) => entry.event.action)).toEqual(["ITEM_DELETE", "ITEM_DELETE", "ITEM_DELETE", "ITEM_SAVE", "ITEM_SAVE", "ITEM_SAVE"]);
    expect(await repository.saveItem(alice, saved)).toEqual(saved);
    // A successful fill counts as a use of its item; a refused one does not. Times come from the row.
    await repository.appendAudit(alice, { actor: "AGENT", action: "FILL", result: "SUBMITTED", itemId: saved.metadata.id });
    await repository.appendAudit(alice, { actor: "AGENT", action: "FILL", result: "ORIGIN_MISMATCH", reason: "ORIGIN_CHANGED", itemId: saved.metadata.id });
    const stats = (await repository.itemStats(alice))[saved.metadata.id]!;
    expect(stats).toMatchObject({ uses: 1, lastUsedAt: expect.any(String) });
    expect(Date.parse(stats.changedAt)).toBeGreaterThanOrEqual(Date.parse(stats.addedAt));
    expect(await repository.itemStats(bob)).toEqual({});

    const dump = (await pool.query<{ row: string }>(`SELECT row_to_json(t)::text AS row FROM (
      SELECT to_jsonb(v) AS r FROM vaults v UNION ALL SELECT to_jsonb(i) FROM vault_items i UNION ALL SELECT to_jsonb(d) FROM vault_delegations d
      UNION ALL SELECT to_jsonb(n) FROM vault_nonces n UNION ALL SELECT to_jsonb(a) FROM vault_audit a) t`)).rows.map((row) => row.row).join("\n");
    expect(dump).toContain(saved.metadata.id);
    for (const secret of [SENTINEL, Buffer.from(ark).toString("hex"), Buffer.from(ark).toString("base64url"), Buffer.from(ark).toString("base64")]) {
      expect(dump).not.toContain(secret);
    }
  }, 60_000);

  it("fails closed for a disabled owner", async () => {
    await repository.enroll(carol, await enrollment(carol));
    const nonce = (await repository.issueNonce(carol, "UNLOCK_CHALLENGE", 60_000))!;
    await pool.query("UPDATE users SET disabled_at = now() WHERE id = $1", [carol]);
    expect(await repository.getVault(carol)).toBeNull();
    expect(await repository.consumeNonce(carol, nonce.nonce, "UNLOCK_CHALLENGE")).toBe(false);
    expect(await repository.listItems(carol)).toEqual([]);
    expect(await repository.revokeAgentAccess(carol)).toBeNull();
    await pool.query("UPDATE users SET disabled_at = NULL WHERE id = $1", [carol]);
  });

  it("consumes a nonce once, only in its purpose, owner and epoch", async () => {
    const first = (await repository.issueNonce(alice, "UNLOCK_CHALLENGE", 60_000))!;
    expect(await repository.consumeNonce(bob, first.nonce, "UNLOCK_CHALLENGE")).toBe(false);
    expect(await repository.consumeNonce(alice, first.nonce, "REQUEST")).toBe(false);
    expect(await repository.consumeNonce(alice, first.nonce, "UNLOCK_CHALLENGE")).toBe(true);
    expect(await repository.consumeNonce(alice, first.nonce, "UNLOCK_CHALLENGE")).toBe(false);
    const raced = (await repository.issueNonce(alice, "REQUEST", 60_000))!;
    const results = await Promise.all([1, 2, 3, 4].map(() => repository.consumeNonce(alice, raced.nonce, "REQUEST")));
    expect(results.filter(Boolean)).toHaveLength(1);
    const stale = (await repository.issueNonce(alice, "UNLOCK_CHALLENGE", 60_000))!;
    expect(await repository.bumpEpoch(alice, "LOGOUT", "LOCK")).toBe(stale.epoch + 1);
    expect(await repository.consumeNonce(alice, stale.nonce, "UNLOCK_CHALLENGE")).toBe(false);
    const expiring = (await repository.issueNonce(alice, "REQUEST", 1))!;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(await repository.consumeNonce(alice, expiring.nonce, "REQUEST")).toBe(false);
    await expect(repository.issueNonce(alice, "FILL_USE", 60_000)).rejects.toThrow("NOT_DELEGATED");
  });

  it("rotates the unlock envelopes only from the current epoch", async () => {
    const vault = (await repository.getVault(alice))!;
    const { vaultId: _vaultId, ...next } = await enrollment(alice);
    await expect(repository.rotateUnlock(alice, vault.epoch - 1, next)).rejects.toThrow("STALE_EPOCH");
    const rotated = (await repository.rotateUnlock(alice, vault.epoch, next))!;
    expect(rotated).toMatchObject({ vaultId: vault.vaultId, epoch: vault.epoch + 1, unlockPublicKey: next.unlockPublicKey });
  });

  it("stores only a matching next-generation delegation and revocation retires it", async () => {
    const vault = (await repository.getVault(alice))!;
    const [handle] = (await repository.listItems(alice)).map((entry) => entry.id);
    const broker = await generateVaultSigningKey();
    const scope = { ownerUserId: alice, vaultId: vault.vaultId, keyVersion: 1, generation: 1 };
    const fillEnvelopes = { [handle!]: { PASSWORD: await sealVaultEnvelope(vaultRandomBytes(32), encode.encode(SENTINEL), { ...scope, purpose: "FILL_FIELD", itemId: handle!, field: "PASSWORD" }) } };
    const keyEnvelope = await sealVaultEnvelope(vaultRandomBytes(32), vaultRandomBytes(32), { ...scope, purpose: "FILL_KEY" });
    const claims = (overrides: Record<string, unknown> = {}) => ({
      v: 1 as const, kind: "DELEGATION" as const, certId: newVaultHandle("vault_delegation"), ownerUserId: alice, vaultId: vault.vaultId, generation: 1,
      unlockEpoch: vault.epoch, items: [{ handle: handle!, origins: ["https://example.com"], fields: ["PASSWORD" as const], approvalMode: "ASSIST" as const, submit: false }],
      issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3_600_000).toISOString(), ...overrides
    });
    const digest = await vaultDigest(fillEnvelopes);
    const delegate = async (overrides: Record<string, unknown>) => repository.createDelegation(alice,
      { certificate: await signVaultCertificate(broker.privateKey, claims({ envelopeDigest: digest, ...overrides }), 1), keyEnvelope, fillEnvelopes });
    for (const bad of [{ generation: 2 }, { unlockEpoch: vault.epoch - 1 }, { ownerUserId: bob }, { envelopeDigest: await vaultDigest({}) },
      { items: [{ ...claims().items[0]!, handle: newVaultHandle("vault_item") }] }]) {
      await expect(delegate(bad)).rejects.toThrow(VaultConflictError);
    }
    expect(await delegate({})).toEqual({ generation: 1 });
    expect((await repository.getActiveDelegation(alice))?.fillEnvelopes).toEqual(fillEnvelopes);
    expect(await repository.getActiveDelegation(bob)).toBeNull();

    // A login agents save joins the active delegation (operator request 2026-10-20): the extended certificate and that
    // item's envelopes replace the stored ones, only on top of the certificate they were made from and for an item it names.
    const active = (await repository.getActiveDelegation(alice))!;
    expect(active.inboxKeyEnvelope).toBeNull();
    const saved = newVaultHandle("vault_item");
    const savedEnvelope = await sealVaultEnvelope(vaultRandomBytes(32), encode.encode("synthetic"), { ...scope, purpose: "FILL_FIELD", itemId: saved, field: "PASSWORD" });
    const extended = await signVaultCertificate(broker.privateKey, { ...active.certificate.claims, certId: newVaultHandle("vault_delegation"),
      items: [...active.certificate.claims.items, { handle: saved, origins: ["https://new.example"], fields: ["PASSWORD" as const], approvalMode: "FULL" as const, submit: true }] }, 1);
    const extend = (basedOn: string, handle = saved) => repository.extendDelegation(alice, { basedOn, certificate: extended, handle, fieldEnvelopes: { PASSWORD: savedEnvelope } });
    expect(await extend(newVaultHandle("vault_delegation"))).toBe("STALE");
    expect(await extend(active.certificate.claims.certId, newVaultHandle("vault_item"))).toBe("STALE");
    expect(await repository.extendDelegation(bob, { basedOn: active.certificate.claims.certId, certificate: extended, handle: saved, fieldEnvelopes: { PASSWORD: savedEnvelope } })).toBe("STALE");
    expect(await extend(active.certificate.claims.certId)).toBe("OK");
    expect((await repository.getActiveDelegation(alice))!.certificate).toEqual(extended);
    expect((await repository.getActiveDelegation(alice))!.fillEnvelopes).toEqual({ ...fillEnvelopes, [saved]: { PASSWORD: savedEnvelope } });
    expect(await extend(active.certificate.claims.certId)).toBe("STALE");
    const fill = (await repository.issueNonce(alice, "FILL_USE", 60_000))!;
    expect(fill.generation).toBe(1);

    // The dock's switch (migration 0231): on until Revoke agent access turns it off with the delegation.
    expect(await repository.enableAgentAccess(alice)).toBe(true);
    expect(await repository.enableAgentAccess("user:vault-nobody")).toBe(false);
    expect((await repository.getVault(alice))!.agentAccess).toBe(true);
    expect(await repository.revokeAgentAccess(alice)).toEqual({ generation: 2, epoch: vault.epoch + 1 });
    expect((await repository.getVault(alice))!.agentAccess).toBe(false);
    expect(await repository.getActiveDelegation(alice)).toBeNull();
    expect(await repository.consumeNonce(alice, fill.nonce, "FILL_USE")).toBe(false);
    await expect(repository.issueNonce(alice, "FILL_USE", 60_000)).rejects.toThrow("NOT_DELEGATED");
    const retired = (await pool.query(`SELECT key_envelope, fill_envelopes, status FROM vault_delegations WHERE owner_user_id = $1`, [alice])).rows;
    expect(retired).toEqual([{ key_envelope: null, fill_envelopes: null, status: "REVOKED" }]);
    // Re-enabling needs a new generation; the revoked one is never resurrected.
    await expect(delegate({ unlockEpoch: vault.epoch + 1 })).rejects.toThrow(VaultConflictError);
    expect(await delegate({ unlockEpoch: vault.epoch + 1, generation: 3 })).toEqual({ generation: 3 });

    // The inbox key the broker wrapped for a generation (migration 0238) is kept with it and cleared when a newer one replaces it.
    const inboxKeyEnvelope = await sealVaultEnvelope(vaultRandomBytes(32), vaultRandomBytes(48), { ...scope, generation: 4, purpose: "INBOX_KEY" });
    const signedFor = async (generation: number) => signVaultCertificate(broker.privateKey, claims({ envelopeDigest: digest, unlockEpoch: vault.epoch + 1, generation }), 1);
    expect(await repository.createDelegation(alice, { certificate: await signedFor(4), keyEnvelope, fillEnvelopes, inboxKeyEnvelope })).toEqual({ generation: 4 });
    expect((await repository.getActiveDelegation(alice))!.inboxKeyEnvelope).toEqual(inboxKeyEnvelope);
    expect(await repository.createDelegation(alice, { certificate: await signedFor(5), keyEnvelope, fillEnvelopes })).toEqual({ generation: 5 });
    expect((await pool.query(`SELECT generation FROM vault_delegations WHERE owner_user_id = $1 AND inbox_key_envelope IS NOT NULL`, [alice])).rows).toEqual([]);
  });

  it("keeps the inbox key and the logins waiting in it per owner", async () => {
    const inboxEnvelope = await sealVaultEnvelope(vaultRandomBytes(32), vaultRandomBytes(48), { ownerUserId: alice, vaultId: (await repository.getVault(alice))!.vaultId, keyVersion: 1, purpose: "INBOX_KEY" });
    const publicKey = vaultBase64url.encode(vaultRandomBytes(32));
    expect(await repository.setInbox(alice, { publicKey, privateKeyEnvelope: inboxEnvelope })).toBe(true);
    expect(await repository.getInbox(alice)).toEqual({ publicKey, privateKeyEnvelope: inboxEnvelope });
    expect(await repository.getInbox(carol)).toBeNull();
    await expect(repository.setInbox(alice, { publicKey, privateKeyEnvelope: { plaintext: SENTINEL } })).rejects.toThrow();

    const sealed = { v: 1, alg: "X25519-HKDF-A256GCM", purpose: "TRANSPORT", keyVersion: 1, epk: "E".repeat(43), nonce: "N".repeat(16), ct: "C".repeat(40) } as const;
    const pending = { id: newVaultHandle("vault_pending"), kind: "NEW_ACCOUNT" as const, handle: newVaultHandle("vault_item"), label: "Synthetic shop", origin: "https://shop.example",
      sealedUsername: null, sealedPassword: sealed, paneId: "pane:vaultpane1", createdAt: new Date().toISOString(), loginPage: null };
    expect(await repository.addPending(alice, pending)).toBe(true);
    expect(await repository.listPending(alice)).toEqual([pending]);
    expect(await repository.listPending(bob)).toEqual([]);
    expect(await repository.deletePending(bob, pending.id)).toBe(false);
    expect(await repository.deletePending(alice, pending.id)).toBe(true);

    // A saved login without a password (migration 0231).
    const usernameOnly = { ...pending, id: newVaultHandle("vault_pending"), sealedUsername: sealed, sealedPassword: null };
    expect(await repository.addPending(alice, usernameOnly)).toBe(true);
    expect(await repository.listPending(alice)).toEqual([usernameOnly]);
    // A login page set by handle (migration 0295) lands on the waiting login, for its owner only.
    expect(await repository.setLoginPage(bob, usernameOnly.handle, "https://shop.example/login")).toBe(0);
    expect(await repository.setLoginPage(alice, usernameOnly.handle, "https://shop.example/login")).toBe(1);
    expect((await repository.listPending(alice))[0]?.loginPage).toBe("https://shop.example/login");
  });

  it("protects a pane for the page a fill landed in, for one owner only, and forgets it on unprotect", async () => {
    const paneId = "pane:vaultprot01";
    await pool.query(`INSERT INTO rooms (id, name, owner_user_id, trace_id) VALUES ('room:vaultprot01', 'Vault', $1, 'trace:vaultprot01')`, [alice]);
    await pool.query(`INSERT INTO panes (id, room_id, title, mode, status, pane_order) VALUES ($1, 'room:vaultprot01', 'Browser', 'BROWSER', 'IDLE', 0)`, [paneId]);
    const fill = { targetId: "target-1", origin: "https://login.example", document: "doc-1" };
    expect(await repository.protectPane(alice, paneId, fill)).toBe(true);
    expect(await repository.protectPane(bob, paneId, fill)).toBe(false);
    // The next fill's page replaces the first one's.
    expect(await repository.protectPane(alice, paneId, { ...fill, document: "doc-2" })).toBe(true);
    expect(await repository.protectedPane(paneId)).toEqual({ owner: alice, fill: { ...fill, document: "doc-2" } });
    expect(await repository.unprotectPane(bob, paneId)).toBe(false);
    expect(await repository.unprotectPane(alice, paneId)).toBe(true);
    expect(await repository.protectedPane(paneId)).toBeNull();
  });

  it("stores broker-certified sign-up grants per owner, lists only live ones and revokes them one by one or with agent access", async () => {
    const dana = "user:vault-dana";
    await pool.query("INSERT INTO users(id, email, role) VALUES ($1, 'dana@space.local', 'OPERATOR')", [dana]);
    const vault = await repository.enroll(dana, await enrollment(dana));
    const signing = await generateVaultSigningKey();
    const grant = (days: number, owner = dana) => signVaultCertificate(signing.privateKey, { v: 1, kind: "SIGNUP_GRANT", grantId: newVaultHandle("vault_grant"), ownerUserId: owner,
      vaultId: vault.vaultId, sites: ["https://shop.example"], dailyCap: 3, unlockEpoch: 1, issuedAt: new Date(Date.now() - 1000).toISOString(),
      expiresAt: new Date(Date.now() + days * 86_400_000).toISOString() }, 1);
    const live = await grant(30);
    expect(await repository.addSignupGrant(dana, live)).toBe(true);
    expect(await repository.addSignupGrant(dana, await grant(30, alice))).toBe(false);
    expect(await repository.addSignupGrant(alice, await grant(30))).toBe(false);
    await repository.addSignupGrant(dana, await grant(-1));
    const listed = await repository.listSignupGrants(dana);
    expect(listed.map((entry) => entry.id)).toEqual([live.claims.grantId]);
    expect(listed[0]).toMatchObject({ sites: ["https://shop.example"], dailyCap: 3, revokedAt: null, certificate: live });
    expect(await repository.listSignupGrants(alice)).toEqual([]);
    expect(await repository.revokeSignupGrant(alice, live.claims.grantId)).toBe(false);
    expect(await repository.revokeSignupGrant(dana, live.claims.grantId)).toBe(true);
    expect(await repository.revokeSignupGrant(dana, live.claims.grantId)).toBe(false);
    expect(await repository.listSignupGrants(dana)).toEqual([]);
    await repository.addSignupGrant(dana, await grant(30));
    await repository.revokeAgentAccess(dana);
    expect(await repository.listSignupGrants(dana)).toEqual([]);
    expect((await repository.listAudit(dana)).map((entry) => entry.event.action)).toEqual(expect.arrayContaining(["SIGNUP_GRANT", "REVOKE"]));
  });

  it("hands an API key to one of the owner's panes once, deletes its value once written, and voids it after its expiry (operator request 2026-10-22)", async () => {
    const id = newVaultHandle("vault_key");
    const soon = new Date(Date.now() + 3_600_000).toISOString();
    expect(await repository.addHandoffKey(alice, { id, label: "Synthetic service", valueSealed: `sealed:${SENTINEL}`, expiresAt: soon })).toBe(true);
    expect(await repository.addHandoffKey("user:vault-nobody", { id: newVaultHandle("vault_key"), label: "x", valueSealed: "sealed", expiresAt: soon })).toBe(false);
    expect((await repository.listHandoffKeys(alice))[0]).toMatchObject({ id, label: "Synthetic service", hasValue: true, takenAt: null, usedAt: null });
    expect(JSON.stringify(await repository.listHandoffKeys(alice))).not.toContain(SENTINEL);
    expect(await repository.listHandoffKeys(bob)).toEqual([]);
    expect(await repository.takeHandoffKey(bob, id, "pane:keys-a")).toBeNull();
    expect(await repository.takeHandoffKey(alice, id, "pane:keys-a")).toEqual({ label: "Synthetic service", valueSealed: `sealed:${SENTINEL}` });
    // The pane that took it may take it again (a failed write); another pane may not.
    expect(await repository.takeHandoffKey(alice, id, "pane:keys-b")).toBeNull();
    expect(await repository.takeHandoffKey(alice, id, "pane:keys-a")).not.toBeNull();
    expect(await repository.useHandoffKey(alice, id, "pane:keys-b")).toBe(false);
    expect(await repository.useHandoffKey(alice, id, "pane:keys-a")).toBe(true);
    expect((await repository.listHandoffKeys(alice))[0]).toMatchObject({ id, hasValue: false, usedByPaneId: "pane:keys-a" });
    expect(await repository.takeHandoffKey(alice, id, "pane:keys-a")).toBeNull();
    expect((await pool.query(`SELECT value_sealed FROM vault_handoff_keys WHERE id = $1`, [id])).rows[0]).toEqual({ value_sealed: null });
    const expired = newVaultHandle("vault_key");
    await repository.addHandoffKey(alice, { id: expired, label: "Old", valueSealed: "sealed", expiresAt: new Date(Date.now() - 1_000).toISOString() });
    expect(await repository.takeHandoffKey(alice, expired, "pane:keys-a")).toBeNull();
    expect((await repository.listHandoffKeys(alice)).find((key) => key.id === expired)).toMatchObject({ hasValue: false });
    expect((await pool.query(`SELECT value_sealed FROM vault_handoff_keys WHERE id = $1`, [expired])).rows[0]).toEqual({ value_sealed: null });
    // Show and edit (operator request 2026-11-12): the owner's own key while it holds a value; a used or expired one has none.
    expect(await repository.handoffKeySeal(alice, id)).toBeNull();
    expect(await repository.handoffKeySeal(alice, expired)).toBeNull();
    expect(await repository.updateHandoffKey(alice, id, { label: "x", valueSealed: "sealed:new", kept: true })).toBe(false);
    expect(await repository.deleteHandoffKey(bob, id)).toBe(false);
    expect(await repository.deleteHandoffKey(alice, id)).toBe(true);
    // A kept key (migration 0256, operator request 2026-10-26): never expires, every pane of the owner takes it again and again, its value stays.
    const kept = newVaultHandle("vault_key");
    expect(await repository.addHandoffKey(alice, { id: kept, label: "vm221 password", valueSealed: `sealed:${SENTINEL}`, expiresAt: null, kept: true, savedBy: "pane:keys-a" })).toBe(true);
    expect(await repository.handoffKeySeal(alice, kept)).toBe(`sealed:${SENTINEL}`);
    expect(await repository.handoffKeySeal(bob, kept)).toBeNull();
    expect(await repository.updateHandoffKey(bob, kept, { label: "x", valueSealed: "sealed:bob", kept: false })).toBe(false);
    expect(await repository.updateHandoffKey(alice, kept, { label: "vm221 root password", valueSealed: "sealed:new", kept: true })).toBe(true);
    expect(await repository.handoffKeySeal(alice, kept)).toBe("sealed:new");
    expect((await repository.listHandoffKeys(alice)).find((key) => key.id === kept)).toMatchObject({ label: "vm221 root password", kept: true, savedBy: "pane:keys-a" });
    for (const pane of ["pane:keys-a", "pane:keys-b", "pane:keys-a"]) {
      expect(await repository.takeHandoffKey(alice, kept, pane)).not.toBeNull();
      expect(await repository.useHandoffKey(alice, kept, pane)).toBe(true);
    }
    expect((await repository.listHandoffKeys(alice)).find((key) => key.id === kept)).toMatchObject({ hasValue: true, kept: true, savedBy: "pane:keys-a", expiresAt: null, usedByPaneId: "pane:keys-a" });
    expect(await repository.takeHandoffKey(bob, kept, "pane:keys-a")).toBeNull();
  });

  it("keeps a per-vault hash chain that reveals tampering", async () => {
    await expect(repository.appendAudit(alice, { actor: "AGENT", action: "FILL", result: "BLOCKED", reason: SENTINEL })).rejects.toThrow();
    const appended = (await repository.appendAudit(alice, { actor: "AGENT", action: "FILL", result: "ORIGIN_MISMATCH", reason: "ORIGIN_CHANGED", origin: "https://example.com" }))!;
    expect(appended.id).toMatch(/^vault_audit:/);
    expect(await repository.verifyAudit(alice)).toEqual({ ok: true, brokenAtSeq: null });
    expect(await repository.verifyAudit(bob)).toEqual({ ok: true, brokenAtSeq: null });
    expect((await repository.listAudit(alice, { limit: 1 }))[0]).toMatchObject({ seq: appended.seq, event: { action: "FILL", result: "ORIGIN_MISMATCH" } });
    expect(await repository.listAudit(bob)).toHaveLength(1);
    await pool.query(`UPDATE vault_audit SET event = jsonb_set(event, '{result}', '"FILLED"') WHERE owner_user_id = $1 AND seq = $2`, [alice, appended.seq]);
    expect(await repository.verifyAudit(alice)).toEqual({ ok: false, brokenAtSeq: appended.seq });
  });
});
