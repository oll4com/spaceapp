import { createHash, randomBytes } from "node:crypto";
import {
  type VaultAuditEvent, type VaultAuditRecord, type VaultEnrollment, type VaultItemMetadata, type VaultItemRecord, type VaultItemRecordInput, type VaultNoncePurpose,
  type VaultRecovery, newVaultHandle, vaultAuditEventSchema, vaultCanonicalJson, vaultDelegationCertificateSchema, vaultDigest,
  vaultEnrollmentSchema, vaultFillEnvelopesSchema, vaultItemRecordSchema, vaultRecoverySchema, vaultSymmetricEnvelopeSchema,
  vaultInboxKeyRequestSchema, vaultPendingSecretSchema, vaultSignupGrantCertificateSchema, type VaultPendingSecret
} from "@space/contracts";
import { createSpacePgPool, type PgClientLike, type PgPoolLike } from "./space-store.js";

// Vault storage (migration 0218, plan clipboard:vEYtT6-bEN0J step 2, ADR-012). Every input is parsed with the Vault
// contracts, whose schemas hold ciphertext envelopes, public keys and non-secret metadata only, so no plaintext or ARK
// reaches Postgres through here. Every method takes the owner first, and a disabled owner's vault reads as absent.

export class VaultConflictError extends Error {
  constructor(readonly code: "VAULT_EXISTS" | "STALE_EPOCH" | "BAD_DELEGATION" | "NOT_DELEGATED") { super(`Vault: ${code}`); }
}

export interface VaultState extends VaultEnrollment {
  ownerUserId: string; formatVersion: 1; recovery: VaultRecovery | null; epoch: number;
  delegationGeneration: number; auditSeq: number; createdAt: string; updatedAt: string;
  /** The dock's switch: agents and Nous may use this vault (migration 0231). */
  agentAccess: boolean;
}
/** The page a fill landed in: its protection lifts once this page is gone. */
export interface VaultFillTarget {
  targetId: string; origin: string; document: string | null;
  /** Earlier fenced tabs of the same pane that are still open (2026-10-19). */
  also?: Array<{ targetId: string; origin: string; document: string | null }>;
}
export interface VaultAuditEntry { id: string; seq: number; event: VaultAuditRecord; prevHash: string; hash: string; createdAt: string }

const GENESIS = "0".repeat(64);
const iso = (value: Date | string) => value instanceof Date ? value.toISOString() : new Date(value).toISOString();
const json = (value: unknown) => value === null ? null : JSON.stringify(value);
const auditHash = (input: { vaultId: string; ownerUserId: string; seq: number; createdAt: string; event: unknown; prevHash: string }) =>
  createHash("sha256").update(vaultCanonicalJson(input), "utf8").digest("hex");

interface VaultRow {
  id: string; ownerUserId: string; formatVersion: 1; kdf: unknown; passwordEnvelope: unknown; serverShareEnvelope: unknown; unlockPublicKey: string;
  unlockKeyVersion: number; recovery: unknown; epoch: number; delegationGeneration: number; auditSeq: string | number; auditHead: string;
  createdAt: Date | string; updatedAt: Date | string; agentAccess: boolean;
}
const vaultColumns = `v.id, v.owner_user_id AS "ownerUserId", v.format_version AS "formatVersion", v.kdf, v.password_envelope AS "passwordEnvelope",
  v.server_share_envelope AS "serverShareEnvelope", v.unlock_public_key AS "unlockPublicKey", v.unlock_key_version AS "unlockKeyVersion", v.recovery,
  v.epoch, v.delegation_generation AS "delegationGeneration", v.audit_seq AS "auditSeq", v.audit_head AS "auditHead",
  v.created_at AS "createdAt", v.updated_at AS "updatedAt", v.agent_access AS "agentAccess"`;
// An owner whose account is disabled has no vault as far as every caller can tell.
const activeOwnerVault = `FROM vaults v JOIN users u ON u.id = v.owner_user_id AND u.disabled_at IS NULL WHERE v.owner_user_id = $1`;
const fromVaultRow = (row: VaultRow): VaultState => ({
  ...vaultEnrollmentSchema.parse({ vaultId: row.id, kdf: row.kdf, passwordEnvelope: row.passwordEnvelope, serverShareEnvelope: row.serverShareEnvelope,
    unlockPublicKey: row.unlockPublicKey, unlockKeyVersion: row.unlockKeyVersion }),
  ownerUserId: row.ownerUserId, formatVersion: 1, recovery: row.recovery === null ? null : vaultRecoverySchema.parse(row.recovery), epoch: row.epoch,
  delegationGeneration: row.delegationGeneration, auditSeq: Number(row.auditSeq), createdAt: iso(row.createdAt), updatedAt: iso(row.updatedAt),
  agentAccess: row.agentAccess === true
});

interface ItemRow { id: string; label: string; origins: string[]; fieldRoles: string[]; policy: unknown; status: string; keyVersion: number; dekEnvelope: unknown; fields: unknown; history: unknown }
const itemColumns = `i.id, i.label, i.origins, i.field_roles AS "fieldRoles", i.policy, i.status, i.key_version AS "keyVersion", i.dek_envelope AS "dekEnvelope", i.fields, i.history`;
const fromItemRow = (row: ItemRow): VaultItemRecord => vaultItemRecordSchema.parse({
  metadata: { id: row.id, label: row.label, origins: row.origins, fieldRoles: row.fieldRoles, policy: row.policy, status: row.status },
  keyVersion: row.keyVersion, dekEnvelope: row.dekEnvelope, fields: row.fields, history: row.history
});

export class PostgresVaultRepository {
  constructor(private readonly pool: PgPoolLike) {}
  static fromConnectionString(url: string) { return new PostgresVaultRepository(createSpacePgPool(url, { max: 2 })); }

  private async transaction<T>(operation: (client: PgClientLike) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    await client.query("BEGIN");
    try {
      const result = await operation(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release?.();
    }
  }

  private async lock(client: PgClientLike, owner: string): Promise<VaultRow | null> {
    return (await client.query<VaultRow>(`SELECT ${vaultColumns} ${activeOwnerVault} FOR UPDATE OF v`, [owner])).rows[0] ?? null;
  }

  /** Appends to the vault's hash chain inside the caller's transaction (the vault row is locked). */
  private async audit(client: PgClientLike, vault: VaultRow, input: VaultAuditEvent): Promise<{ id: string; seq: number }> {
    const event = vaultAuditEventSchema.parse(input);
    const seq = Number(vault.auditSeq) + 1;
    const createdAt = new Date().toISOString();
    const hash = auditHash({ vaultId: vault.id, ownerUserId: vault.ownerUserId, seq, createdAt, event, prevHash: vault.auditHead });
    const id = newVaultHandle("vault_audit");
    await client.query(`INSERT INTO vault_audit (id, vault_id, owner_user_id, seq, event, prev_hash, hash, created_at) VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8)`,
      [id, vault.id, vault.ownerUserId, seq, JSON.stringify(event), vault.auditHead, hash, createdAt]);
    await client.query(`UPDATE vaults SET audit_seq = $2, audit_head = $3 WHERE id = $1`, [vault.id, seq, hash]);
    vault.auditSeq = seq;
    vault.auditHead = hash;
    return { id, seq };
  }

  async getVault(owner: string): Promise<VaultState | null> {
    const row = (await this.pool.query<VaultRow>(`SELECT ${vaultColumns} ${activeOwnerVault}`, [owner])).rows[0];
    return row ? fromVaultRow(row) : null;
  }

  async enroll(owner: string, input: VaultEnrollment): Promise<VaultState> {
    const enrollment = vaultEnrollmentSchema.parse(input);
    return this.transaction(async (client) => {
      const inserted = await client.query<VaultRow>(`INSERT INTO vaults (id, owner_user_id, format_version, kdf, password_envelope, server_share_envelope,
          unlock_public_key, unlock_key_version, audit_head)
        SELECT $1, $2, 1, $3::jsonb, $4::jsonb, $5::jsonb, $6, $7, $8 FROM users WHERE id = $2 AND disabled_at IS NULL
        ON CONFLICT (owner_user_id) DO NOTHING RETURNING id`,
      [enrollment.vaultId, owner, JSON.stringify(enrollment.kdf), JSON.stringify(enrollment.passwordEnvelope),
        JSON.stringify(enrollment.serverShareEnvelope), enrollment.unlockPublicKey, enrollment.unlockKeyVersion, GENESIS]);
      if (!inserted.rows[0]) throw new VaultConflictError("VAULT_EXISTS");
      const vault = (await this.lock(client, owner))!;
      await this.audit(client, vault, { actor: "OPERATOR", action: "ENROLL", result: "OK" });
      return fromVaultRow(vault);
    });
  }

  /** Password or unlock-key rotation (also after recovery): new envelopes, a new epoch, every outstanding nonce void. */
  async rotateUnlock(owner: string, expectedEpoch: number, input: Omit<VaultEnrollment, "vaultId">, action: "PASSWORD_ROTATE" | "RECOVERY_USE" = "PASSWORD_ROTATE") {
    return this.transaction(async (client) => {
      const vault = await this.lock(client, owner);
      if (!vault) return null;
      const next = vaultEnrollmentSchema.parse({ ...input, vaultId: vault.id });
      if (vault.epoch !== expectedEpoch) throw new VaultConflictError("STALE_EPOCH");
      await client.query(`UPDATE vaults SET kdf = $2::jsonb, password_envelope = $3::jsonb, server_share_envelope = $4::jsonb, unlock_public_key = $5,
          unlock_key_version = $6, epoch = epoch + 1, updated_at = now() WHERE id = $1`,
      [vault.id, JSON.stringify(next.kdf), JSON.stringify(next.passwordEnvelope), JSON.stringify(next.serverShareEnvelope), next.unlockPublicKey, next.unlockKeyVersion]);
      const locked = (await this.lock(client, owner))!;
      await this.audit(client, locked, { actor: "OPERATOR", action, result: "OK" });
      return fromVaultRow(locked);
    });
  }

  async setRecovery(owner: string, recovery: unknown) {
    const parsed = vaultRecoverySchema.parse(recovery);
    return this.transaction(async (client) => {
      const vault = await this.lock(client, owner);
      if (!vault) return false;
      await client.query(`UPDATE vaults SET recovery = $2::jsonb, updated_at = now() WHERE id = $1`, [vault.id, JSON.stringify(parsed)]);
      await this.audit(client, vault, { actor: "OPERATOR", action: "RECOVERY_SET", result: "OK" });
      return true;
    });
  }

  /**
   * The operator's Lock (the only caller): one new epoch voids every capability and nonce. Logout, a disabled user, a removed
   * share and a Browser Host restart do not bump it: the agent-access delegation is meant to outlive the operator's session
   * (one-switch decision 2026-10-18); a disabled user's nonces and fills are refused by the disabled_at checks instead.
   */
  async bumpEpoch(owner: string, reason: string, action: "LOCK" | "EPOCH_BUMP" = "EPOCH_BUMP"): Promise<number | null> {
    return this.transaction(async (client) => {
      const vault = await this.lock(client, owner);
      if (!vault) return null;
      const epoch = (await client.query<{ epoch: number }>(`UPDATE vaults SET epoch = epoch + 1, updated_at = now() WHERE id = $1 RETURNING epoch`, [vault.id])).rows[0]!.epoch;
      await this.audit(client, vault, { actor: "SYSTEM", action, result: "OK", reason });
      return epoch;
    });
  }

  async saveItem(owner: string, input: VaultItemRecordInput): Promise<VaultItemRecord | null> {
    const item = vaultItemRecordSchema.parse(input);
    const { metadata } = item;
    return this.transaction(async (client) => {
      const vault = await this.lock(client, owner);
      if (!vault) return null;
      // A handle belongs to one owner for good: another owner's id is never overwritten.
      const saved = await client.query<ItemRow>(`INSERT INTO vault_items AS i (id, vault_id, owner_user_id, label, origins, field_roles, policy, key_version, dek_envelope, fields, status, history)
        VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9::jsonb, $10::jsonb, $11, $12::jsonb)
        ON CONFLICT (id) DO UPDATE SET label = EXCLUDED.label, origins = EXCLUDED.origins, field_roles = EXCLUDED.field_roles, policy = EXCLUDED.policy,
          key_version = EXCLUDED.key_version, dek_envelope = EXCLUDED.dek_envelope, fields = EXCLUDED.fields, status = EXCLUDED.status, history = EXCLUDED.history, updated_at = now()
        WHERE i.owner_user_id = EXCLUDED.owner_user_id AND i.vault_id = EXCLUDED.vault_id
        RETURNING ${itemColumns}`,
      [metadata.id, vault.id, owner, metadata.label, metadata.origins, metadata.fieldRoles, JSON.stringify(metadata.policy), item.keyVersion,
        JSON.stringify(item.dekEnvelope), JSON.stringify(item.fields), metadata.status, JSON.stringify(item.history)]);
      if (!saved.rows[0]) return null;
      await this.audit(client, vault, { actor: "OPERATOR", action: "ITEM_SAVE", result: "OK", itemId: metadata.id });
      return fromItemRow(saved.rows[0]);
    });
  }

  async getItem(owner: string, id: string): Promise<VaultItemRecord | null> {
    const row = (await this.pool.query<ItemRow>(`SELECT ${itemColumns} FROM vault_items i JOIN users u ON u.id = i.owner_user_id AND u.disabled_at IS NULL
      WHERE i.owner_user_id = $1 AND i.id = $2`, [owner, id])).rows[0];
    return row ? fromItemRow(row) : null;
  }

  /** Metadata only: labels, exact origins, field roles and policy. */
  async listItems(owner: string): Promise<VaultItemMetadata[]> {
    const rows = (await this.pool.query<ItemRow>(`SELECT ${itemColumns} FROM vault_items i JOIN users u ON u.id = i.owner_user_id AND u.disabled_at IS NULL
      WHERE i.owner_user_id = $1 ORDER BY lower(i.label), i.id`, [owner])).rows;
    return rows.map((row) => fromItemRow(row).metadata);
  }

  /** Per item: when it was added and last changed, and how many fills used it (successful FILL audit events). */
  async itemStats(owner: string): Promise<Record<string, { addedAt: string; changedAt: string; uses: number; lastUsedAt: string | null }>> {
    const rows = (await this.pool.query<{ id: string; addedAt: Date | string; changedAt: Date | string; uses: string | number; lastUsedAt: Date | string | null }>(
      `SELECT i.id, i.created_at AS "addedAt", i.updated_at AS "changedAt", count(a.id) AS uses, max(a.created_at) AS "lastUsedAt"
       FROM vault_items i JOIN users u ON u.id = i.owner_user_id AND u.disabled_at IS NULL
       LEFT JOIN vault_audit a ON a.vault_id = i.vault_id AND a.event->>'itemId' = i.id AND a.event->>'action' = 'FILL' AND a.event->>'result' IN ('FILLED', 'SUBMITTED')
       WHERE i.owner_user_id = $1 GROUP BY i.id`, [owner])).rows;
    return Object.fromEntries(rows.map((row) => [row.id, { addedAt: iso(row.addedAt), changedAt: iso(row.changedAt), uses: Number(row.uses), lastUsedAt: row.lastUsedAt ? iso(row.lastUsedAt) : null }]));
  }

  async deleteItem(owner: string, id: string): Promise<boolean> {
    return this.transaction(async (client) => {
      const vault = await this.lock(client, owner);
      if (!vault) return false;
      const deleted = await client.query(`DELETE FROM vault_items WHERE owner_user_id = $1 AND vault_id = $2 AND id = $3`, [owner, vault.id, id]);
      if (((deleted as { rowCount?: number | null }).rowCount ?? 0) === 0) return false;
      await this.audit(client, vault, { actor: "OPERATOR", action: "ITEM_DELETE", result: "OK", itemId: id });
      return true;
    });
  }

  /**
   * Stores a broker-signed delegation as the next generation. The broker verifies its own signature; here the claims must
   * match this owner, vault, epoch and next generation, name only this owner's items, and digest the exact fill envelopes.
   */
  async createDelegation(owner: string, input: { certificate: unknown; keyEnvelope: unknown; fillEnvelopes: unknown; inboxKeyEnvelope?: unknown }) {
    const certificate = vaultDelegationCertificateSchema.parse(input.certificate);
    const keyEnvelope = vaultSymmetricEnvelopeSchema.parse(input.keyEnvelope);
    const inboxKeyEnvelope = input.inboxKeyEnvelope === undefined ? null : vaultSymmetricEnvelopeSchema.parse(input.inboxKeyEnvelope);
    const fillEnvelopes = vaultFillEnvelopesSchema.parse(input.fillEnvelopes);
    const digest = await vaultDigest(fillEnvelopes);
    const { claims } = certificate;
    return this.transaction(async (client) => {
      const vault = await this.lock(client, owner);
      if (!vault) return null;
      const handles = claims.items.map((item) => item.handle);
      const owned = (await client.query<{ id: string }>(`SELECT id FROM vault_items WHERE owner_user_id = $1 AND vault_id = $2 AND id = ANY($3)`, [owner, vault.id, handles])).rows;
      const valid = claims.ownerUserId === owner && claims.vaultId === vault.id && claims.generation === vault.delegationGeneration + 1
        && claims.unlockEpoch === vault.epoch && claims.envelopeDigest === digest && owned.length === new Set(handles).size
        && Object.keys(fillEnvelopes).every((handle) => handles.includes(handle));
      if (!valid) throw new VaultConflictError("BAD_DELEGATION");
      await client.query(`UPDATE vault_delegations SET status = 'REVOKED', key_envelope = NULL, fill_envelopes = NULL, inbox_key_envelope = NULL, revoked_at = now()
        WHERE vault_id = $1 AND status = 'ACTIVE'`, [vault.id]);
      await client.query(`INSERT INTO vault_delegations (id, vault_id, owner_user_id, generation, certificate, key_envelope, fill_envelopes, inbox_key_envelope, status)
        VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb, $8::jsonb, 'ACTIVE')`,
      [claims.certId, vault.id, owner, claims.generation, JSON.stringify(certificate), JSON.stringify(keyEnvelope), JSON.stringify(fillEnvelopes),
        inboxKeyEnvelope ? JSON.stringify(inboxKeyEnvelope) : null]);
      await client.query(`UPDATE vaults SET delegation_generation = $2, updated_at = now() WHERE id = $1`, [vault.id, claims.generation]);
      await this.audit(client, vault, { actor: "OPERATOR", action: "DELEGATE", result: "OK" });
      return { generation: claims.generation };
    });
  }

  async getActiveDelegation(owner: string) {
    const row = (await this.pool.query<{ certificate: unknown; keyEnvelope: unknown; fillEnvelopes: unknown; inboxKeyEnvelope: unknown; generation: number }>(
      `SELECT d.certificate, d.key_envelope AS "keyEnvelope", d.fill_envelopes AS "fillEnvelopes", d.inbox_key_envelope AS "inboxKeyEnvelope", d.generation
       FROM vaults v JOIN users u ON u.id = v.owner_user_id AND u.disabled_at IS NULL
       JOIN vault_delegations d ON d.vault_id = v.id AND d.status = 'ACTIVE' AND d.generation = v.delegation_generation
       WHERE v.owner_user_id = $1`,
      [owner])).rows[0];
    return row ? { generation: row.generation, certificate: vaultDelegationCertificateSchema.parse(row.certificate),
      keyEnvelope: vaultSymmetricEnvelopeSchema.parse(row.keyEnvelope), fillEnvelopes: vaultFillEnvelopesSchema.parse(row.fillEnvelopes),
      inboxKeyEnvelope: row.inboxKeyEnvelope ? vaultSymmetricEnvelopeSchema.parse(row.inboxKeyEnvelope) : null } : null;
  }

  /**
   * A login agents saved, created or changed joins the active delegation (operator request 2026-10-20): the broker's extended
   * certificate (same generation) and that item's new fill envelopes replace the stored ones. "STALE" when the delegation
   * changed since `basedOn` (a new generation, or another extension landed first): the caller asks the broker again.
   */
  async extendDelegation(owner: string, input: { basedOn: string; certificate: unknown; handle: string; fieldEnvelopes: unknown }): Promise<"OK" | "STALE"> {
    const certificate = vaultDelegationCertificateSchema.parse(input.certificate);
    const fields = vaultFillEnvelopesSchema.parse({ [input.handle]: input.fieldEnvelopes })[input.handle]!;
    return this.transaction(async (client) => {
      const vault = await this.lock(client, owner);
      if (!vault) return "STALE";
      const row = (await client.query<{ id: string; certificate: { claims?: { certId?: string } }; fillEnvelopes: Record<string, Record<string, unknown>> }>(
        `SELECT id, certificate, fill_envelopes AS "fillEnvelopes" FROM vault_delegations WHERE vault_id = $1 AND status = 'ACTIVE' AND generation = $2`,
        [vault.id, vault.delegationGeneration])).rows[0];
      const { claims } = certificate;
      if (!row || row.certificate.claims?.certId !== input.basedOn || claims.ownerUserId !== owner || claims.vaultId !== vault.id
        || claims.generation !== vault.delegationGeneration || !claims.items.some((item) => item.handle === input.handle)) return "STALE";
      const fillEnvelopes = { ...row.fillEnvelopes, [input.handle]: { ...row.fillEnvelopes[input.handle], ...fields } };
      await client.query(`UPDATE vault_delegations SET certificate = $2::jsonb, fill_envelopes = $3::jsonb WHERE id = $1`,
        [row.id, JSON.stringify(certificate), JSON.stringify(fillEnvelopes)]);
      return "OK";
    });
  }

  /** Turns the dock's agent-access switch on (the dock then delegates); off is revokeAgentAccess. */
  async enableAgentAccess(owner: string): Promise<boolean> {
    return this.transaction(async (client) => {
      const vault = await this.lock(client, owner);
      if (!vault) return false;
      await client.query(`UPDATE vaults SET agent_access = true, updated_at = now() WHERE id = $1`, [vault.id]);
      await this.audit(client, vault, { actor: "OPERATOR", action: "DELEGATE", result: "OK", reason: "AGENT_ACCESS_ON" });
      return true;
    });
  }

  /** Revoke agent access: the switch goes off, next generation and epoch, delegated envelopes deleted; needs no password. */
  async revokeAgentAccess(owner: string, actor: "OPERATOR" | "SYSTEM" = "OPERATOR") {
    return this.transaction(async (client) => {
      const vault = await this.lock(client, owner);
      if (!vault) return null;
      await client.query(`UPDATE vault_delegations SET status = 'REVOKED', key_envelope = NULL, fill_envelopes = NULL, inbox_key_envelope = NULL, revoked_at = now()
        WHERE vault_id = $1 AND status = 'ACTIVE'`, [vault.id]);
      await client.query(`UPDATE vault_signup_grants SET revoked_at = now() WHERE vault_id = $1 AND revoked_at IS NULL`, [vault.id]);
      const next = (await client.query<{ epoch: number; generation: number }>(`UPDATE vaults SET delegation_generation = delegation_generation + 1,
          epoch = epoch + 1, agent_access = false, updated_at = now() WHERE id = $1 RETURNING epoch, delegation_generation AS generation`, [vault.id])).rows[0]!;
      await this.audit(client, vault, { actor, action: "REVOKE", result: "OK" });
      return next;
    });
  }

  /** A one-time nonce bound to the current epoch (and, for fills, the active delegation's generation). */
  async issueNonce(owner: string, purpose: VaultNoncePurpose, ttlMs: number) {
    if (!(ttlMs > 0 && ttlMs <= 10 * 60_000)) throw new RangeError("Vault nonces live at most 10 minutes.");
    const vault = await this.getVault(owner);
    if (!vault) return null;
    let generation: number | null = null;
    if (purpose === "FILL_USE") {
      const delegation = await this.getActiveDelegation(owner);
      if (!delegation) throw new VaultConflictError("NOT_DELEGATED");
      generation = delegation.generation;
    }
    const nonce = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + ttlMs).toISOString();
    await this.pool.query(`INSERT INTO vault_nonces (nonce, vault_id, owner_user_id, purpose, epoch, generation, expires_at) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [nonce, vault.vaultId, owner, purpose, vault.epoch, generation, expiresAt]);
    return { nonce, epoch: vault.epoch, generation, expiresAt };
  }

  /** Atomic: true once, and only while unexpired, in the same epoch and generation, for an active owner. */
  async consumeNonce(owner: string, nonce: string, purpose: VaultNoncePurpose): Promise<boolean> {
    const result = await this.pool.query(`UPDATE vault_nonces n SET consumed_at = now() FROM vaults v, users u
      WHERE n.nonce = $2 AND n.owner_user_id = $1 AND n.purpose = $3 AND n.consumed_at IS NULL AND n.expires_at > now()
        AND v.id = n.vault_id AND v.owner_user_id = $1 AND v.epoch = n.epoch AND (n.generation IS NULL OR n.generation = v.delegation_generation)
        AND u.id = v.owner_user_id AND u.disabled_at IS NULL`, [owner, nonce, purpose]);
    return ((result as { rowCount?: number | null }).rowCount ?? 0) === 1;
  }

  /** Drops nonces that expired over a day ago (they can never be consumed). */
  async pruneNonces(): Promise<number> {
    const result = await this.pool.query(`DELETE FROM vault_nonces WHERE expires_at < now() - interval '1 day'`);
    return (result as { rowCount?: number | null }).rowCount ?? 0;
  }

  async appendAudit(owner: string, event: VaultAuditEvent): Promise<{ id: string; seq: number } | null> {
    vaultAuditEventSchema.parse(event);
    return this.transaction(async (client) => {
      const vault = await this.lock(client, owner);
      return vault ? this.audit(client, vault, event) : null;
    });
  }

  async listAudit(owner: string, { limit = 50, beforeSeq }: { limit?: number; beforeSeq?: number } = {}): Promise<VaultAuditEntry[]> {
    const rows = (await this.pool.query<{ id: string; seq: string | number; event: unknown; prevHash: string; hash: string; createdAt: Date | string }>(
      `SELECT a.id, a.seq, a.event, a.prev_hash AS "prevHash", a.hash, a.created_at AS "createdAt"
       FROM vault_audit a JOIN users u ON u.id = a.owner_user_id AND u.disabled_at IS NULL
       WHERE a.owner_user_id = $1 AND ($2::bigint IS NULL OR a.seq < $2) ORDER BY a.seq DESC LIMIT $3`,
      [owner, beforeSeq ?? null, Math.min(Math.max(limit, 1), 200)])).rows;
    return rows.map((row) => ({ id: row.id, seq: Number(row.seq), event: vaultAuditEventSchema.parse(row.event), prevHash: row.prevHash, hash: row.hash, createdAt: iso(row.createdAt) }));
  }

  /** Recomputes the whole chain; the first sequence whose link or hash does not match, or null. */
  async verifyAudit(owner: string): Promise<{ ok: boolean; brokenAtSeq: number | null }> {
    const vault = await this.getVault(owner);
    if (!vault) return { ok: false, brokenAtSeq: null };
    const rows = (await this.pool.query<{ seq: string | number; event: unknown; prevHash: string; hash: string; createdAt: Date | string }>(
      `SELECT seq, event, prev_hash AS "prevHash", hash, created_at AS "createdAt" FROM vault_audit WHERE owner_user_id = $1 AND vault_id = $2 ORDER BY seq`,
      [owner, vault.vaultId])).rows;
    let prevHash = GENESIS;
    for (const [index, row] of rows.entries()) {
      const seq = Number(row.seq);
      const expected = auditHash({ vaultId: vault.vaultId, ownerUserId: owner, seq, createdAt: iso(row.createdAt), event: row.event, prevHash });
      if (seq !== index + 1 || row.prevHash !== prevHash || row.hash !== expected) return { ok: false, brokenAtSeq: seq };
      prevHash = row.hash;
    }
    return rows.length === vault.auditSeq ? { ok: true, brokenAtSeq: null } : { ok: false, brokenAtSeq: rows.length + 1 };
  }

  /** Protects a pane's browser for the page a Vault fill lands in (the latest fill's page); the owner check is the caller's. */
  async protectPane(owner: string, paneId: string, fill: VaultFillTarget): Promise<boolean> {
    const result = await this.pool.query(`INSERT INTO vault_protected_panes (pane_id, owner_user_id, fill_target) SELECT $2, $1, $3::jsonb FROM users WHERE id = $1 AND disabled_at IS NULL
      ON CONFLICT (pane_id) DO UPDATE SET fill_target = EXCLUDED.fill_target WHERE vault_protected_panes.owner_user_id = EXCLUDED.owner_user_id`, [owner, paneId, JSON.stringify(fill)]);
    return ((result as { rowCount?: number | null }).rowCount ?? 0) === 1;
  }
  async unprotectPane(owner: string, paneId: string): Promise<boolean> {
    const result = await this.pool.query(`DELETE FROM vault_protected_panes WHERE pane_id = $2 AND owner_user_id = $1`, [owner, paneId]);
    return ((result as { rowCount?: number | null }).rowCount ?? 0) === 1;
  }
  /** Who protects this pane and for which filled page (null for a pane protected by hand before 2026-10-18), or null. */
  async protectedPane(paneId: string): Promise<{ owner: string; fill: VaultFillTarget | null } | null> {
    const row = (await this.pool.query<{ owner: string; fill: VaultFillTarget | null }>(`SELECT owner_user_id AS owner, fill_target AS fill FROM vault_protected_panes WHERE pane_id = $1`, [paneId])).rows[0];
    return row ? { owner: row.owner, fill: row.fill ?? null } : null;
  }

  /** The inbox key: public half for fills, private half sealed under the VRK for the dock. */
  async setInbox(owner: string, input: unknown): Promise<boolean> {
    const inbox = vaultInboxKeyRequestSchema.parse(input);
    const result = await this.pool.query(`UPDATE vaults v SET inbox_public_key = $2, inbox_private_envelope = $3::jsonb, updated_at = now()
      FROM users u WHERE v.owner_user_id = $1 AND u.id = v.owner_user_id AND u.disabled_at IS NULL`, [owner, inbox.publicKey, JSON.stringify(inbox.privateKeyEnvelope)]);
    return ((result as { rowCount?: number | null }).rowCount ?? 0) === 1;
  }
  async getInbox(owner: string): Promise<{ publicKey: string; privateKeyEnvelope: unknown } | null> {
    const row = (await this.pool.query<{ publicKey: string | null; privateKeyEnvelope: unknown }>(`SELECT v.inbox_public_key AS "publicKey", v.inbox_private_envelope AS "privateKeyEnvelope" ${activeOwnerVault}`, [owner])).rows[0];
    return row?.publicKey ? { publicKey: row.publicKey, privateKeyEnvelope: vaultSymmetricEnvelopeSchema.parse(row.privateKeyEnvelope) } : null;
  }

  async addPending(owner: string, input: VaultPendingSecret): Promise<boolean> {
    const pending = vaultPendingSecretSchema.parse(input);
    const vault = await this.getVault(owner);
    if (!vault) return false;
    await this.pool.query(`INSERT INTO vault_pending (id, vault_id, owner_user_id, kind, handle, label, origin, sealed_username, sealed_password, pane_id, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10, $11)`,
    [pending.id, vault.vaultId, owner, pending.kind, pending.handle, pending.label, pending.origin, json(pending.sealedUsername), json(pending.sealedPassword), pending.paneId, pending.createdAt]);
    return true;
  }
  async listPending(owner: string): Promise<VaultPendingSecret[]> {
    const rows = (await this.pool.query<Record<string, unknown> & { createdAt: Date | string }>(`SELECT p.id, p.kind, p.handle, p.label, p.origin, p.sealed_username AS "sealedUsername",
        p.sealed_password AS "sealedPassword", p.pane_id AS "paneId", p.created_at AS "createdAt"
      FROM vault_pending p JOIN users u ON u.id = p.owner_user_id AND u.disabled_at IS NULL WHERE p.owner_user_id = $1 ORDER BY p.created_at`, [owner])).rows;
    return rows.map((row) => vaultPendingSecretSchema.parse({ ...row, createdAt: iso(row.createdAt) }));
  }
  async deletePending(owner: string, id: string): Promise<boolean> {
    const result = await this.pool.query(`DELETE FROM vault_pending WHERE owner_user_id = $1 AND id = $2`, [owner, id]);
    return ((result as { rowCount?: number | null }).rowCount ?? 0) === 1;
  }

  async addSignupGrant(owner: string, certificate: unknown): Promise<boolean> {
    const { claims } = vaultSignupGrantCertificateSchema.parse(certificate);
    return this.transaction(async (client) => {
      const vault = await this.lock(client, owner);
      if (!vault || claims.ownerUserId !== owner || claims.vaultId !== vault.id) return false;
      await client.query(`INSERT INTO vault_signup_grants (id, vault_id, owner_user_id, sites, daily_cap, certificate, created_at, expires_at) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)`,
        [claims.grantId, vault.id, owner, claims.sites, claims.dailyCap, JSON.stringify(certificate), claims.issuedAt, claims.expiresAt]);
      await this.audit(client, vault, { actor: "OPERATOR", action: "SIGNUP_GRANT", result: "OK" });
      return true;
    });
  }
  /** Grants that are neither revoked nor expired, newest first, with their certificates. */
  async listSignupGrants(owner: string) {
    const rows = (await this.pool.query<{ id: string; sites: string[]; dailyCap: number; certificate: unknown; createdAt: Date | string; expiresAt: Date | string }>(
      `SELECT g.id, g.sites, g.daily_cap AS "dailyCap", g.certificate, g.created_at AS "createdAt", g.expires_at AS "expiresAt"
       FROM vault_signup_grants g JOIN users u ON u.id = g.owner_user_id AND u.disabled_at IS NULL
       WHERE g.owner_user_id = $1 AND g.revoked_at IS NULL AND g.expires_at > now() ORDER BY g.created_at DESC`, [owner])).rows;
    return rows.map((row) => ({ id: row.id, sites: row.sites, dailyCap: row.dailyCap, createdAt: iso(row.createdAt), expiresAt: iso(row.expiresAt), revokedAt: null,
      certificate: vaultSignupGrantCertificateSchema.parse(row.certificate) }));
  }
  async revokeSignupGrant(owner: string, id: string): Promise<boolean> {
    return this.transaction(async (client) => {
      const vault = await this.lock(client, owner);
      if (!vault) return false;
      const result = await client.query(`UPDATE vault_signup_grants SET revoked_at = now() WHERE vault_id = $1 AND id = $2 AND revoked_at IS NULL`, [vault.id, id]);
      if (((result as { rowCount?: number | null }).rowCount ?? 0) !== 1) return false;
      await this.audit(client, vault, { actor: "OPERATOR", action: "REVOKE", result: "OK", reason: "SIGNUP_GRANT" });
      return true;
    });
  }

  async dispose() { await (this.pool as PgPoolLike & { end?: () => Promise<void> }).end?.(); }
}
