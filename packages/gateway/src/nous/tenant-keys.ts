import { randomBytes, randomUUID } from "node:crypto";
import type pg from "pg";
import { gatewayKeyPrefixLength, hashGatewayApiKey } from "../api-keys.js";

/**
 * Nous Gateway virtual tenant keys (plan clipboard:_0qBSFCftZuD step 3; install plan §3.1): `sk-ngw-<43 base64url chars>`, never
 * mistaken for a Space Gateway `sk-sgw-` key, stored only as the same SHA-256 hash. Identity, plan, region and risk tier come only
 * from the key. One current key per tenant plus at most one in its 24-hour rotation overlap; an incident rotates with no overlap.
 */
export type TenantPlan = "TRIAL" | "PERSONAL" | "PRO" | "ULTRA";
export type RiskTier = "NEW" | "TRUSTED";
export type TenantKeyStatus = "ACTIVE" | "FROZEN" | "REVOKED";

export interface TenantKey {
  id: string;
  tenantId: string;
  keyHash: string;
  keyPrefix: string;
  plan: TenantPlan;
  region: string;
  riskTier: RiskTier;
  status: TenantKeyStatus;
  rotatedFrom: string | null;
  notAfter: Date | null;
  createdAt: Date;
}

export const NGW_KEY_PREFIX = "sk-ngw-";
export const NGW_KEY_CHANGED = "ngw_key_changed";
export const ROTATION_OVERLAP_MS = 24 * 3_600_000;

const fromRow = (row: pg.QueryResultRow): TenantKey => ({
  id: row.id, tenantId: row.tenant_id, keyHash: row.key_hash, keyPrefix: row.key_prefix, plan: row.plan, region: row.region,
  riskTier: row.risk_tier, status: row.status, rotatedFrom: row.rotated_from, notAfter: row.not_after, createdAt: row.created_at
});

/** One transaction with the tenant set for row-level security (SET LOCAL, so a pooled connection never keeps it). */
export async function withTenant<T>(pool: pg.Pool, tenantId: string, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('ngw.tenant_id', $1, true)", [tenantId]);
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

const notify = (client: pg.PoolClient, keyHash: string) => client.query("SELECT pg_notify($1, $2)", [NGW_KEY_CHANGED, keyHash]);
const audit = (client: pg.PoolClient, tenantId: string, actor: string, action: string, keyId: string | null, detail: object = {}) =>
  client.query("INSERT INTO ngw_audit (tenant_id, actor, action, key_id, detail) VALUES ($1, $2, $3, $4, $5)", [tenantId, actor, action, keyId, detail]);

/**
 * Issues a tenant's key, or rotates it when one exists: the current key keeps 24 hours (`not_after`), a key already in its overlap
 * and, with `immediate` (incident, leak, resale signal), the current key too are revoked at once. The plaintext is answered once.
 */
export async function issueTenantKey(pool: pg.Pool, input: {
  tenantId: string; actor: string; plan?: TenantPlan; region?: string; riskTier?: RiskTier; immediate?: boolean; now?: Date;
}): Promise<{ plainKey: string; key: TenantKey }> {
  return withTenant(pool, input.tenantId, async (client) => {
    const now = input.now ?? new Date();
    // Two replicas issuing a tenant's first key at once must not both insert one.
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`ngw-key:${input.tenantId}`]);
    const live = (await client.query("SELECT * FROM ngw_tenant_keys WHERE tenant_id = $1 AND status <> 'REVOKED' ORDER BY created_at DESC",
      [input.tenantId])).rows.map(fromRow);
    const current = live.find((key) => key.notAfter === null) ?? live[0] ?? null;
    const plan = input.plan ?? current?.plan, region = input.region ?? current?.region, riskTier = input.riskTier ?? current?.riskTier;
    if (!plan || !region || !riskTier) throw new Error("A tenant's first key needs its plan, region and risk tier");
    for (const key of live.filter((key) => input.immediate || key !== current)) {
      await client.query("UPDATE ngw_tenant_keys SET status = 'REVOKED', revoked_at = $2 WHERE id = $1", [key.id, now]);
      await notify(client, key.keyHash);
    }
    if (current && !input.immediate) {
      await client.query("UPDATE ngw_tenant_keys SET not_after = $2 WHERE id = $1", [current.id, new Date(now.getTime() + ROTATION_OVERLAP_MS)]);
      await notify(client, current.keyHash);
    }
    const plainKey = `${NGW_KEY_PREFIX}${randomBytes(32).toString("base64url")}`;
    const row = (await client.query(`INSERT INTO ngw_tenant_keys (id, tenant_id, key_hash, key_prefix, plan, region, risk_tier, status, rotated_from, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`, [`ngwkey:${randomUUID()}`, input.tenantId, hashGatewayApiKey(plainKey),
      plainKey.slice(0, gatewayKeyPrefixLength), plan, region, riskTier, current?.status === "FROZEN" ? "FROZEN" : "ACTIVE", current?.id ?? null, now])).rows[0];
    await audit(client, input.tenantId, input.actor, current ? (input.immediate ? "key.rotate_immediate" : "key.rotate") : "key.issue", row.id,
      current ? { rotatedFrom: current.id } : {});
    return { plainKey, key: fromRow(row) };
  });
}

/** Freeze (chargeback, abuse), unfreeze, or revoke every key of a tenant (account deletion); every replica hears it at once. */
export async function setTenantKeyStatus(pool: pg.Pool, tenantId: string, status: TenantKeyStatus, actor: string, reason: string): Promise<number> {
  return withTenant(pool, tenantId, async (client) => {
    const rows = (await client.query(`UPDATE ngw_tenant_keys SET status = $2, revoked_at = CASE WHEN $2 = 'REVOKED' THEN now() ELSE NULL END
      WHERE tenant_id = $1 AND status <> 'REVOKED' RETURNING id, key_hash`, [tenantId, status])).rows;
    for (const row of rows) await notify(client, row.key_hash);
    await audit(client, tenantId, actor, `key.${status.toLowerCase()}`, null, { reason, keys: rows.map((row) => row.id) });
    return rows.length;
  });
}

/** A plan change (upgrade, downgrade) never rotates: the keys' plan and the current period's allowance change in one transaction. */
export async function changeTenantPlan(pool: pg.Pool, input: { tenantId: string; plan: TenantPlan; allowanceMicros: number; actor: string; now?: Date }): Promise<void> {
  await withTenant(pool, input.tenantId, async (client) => {
    const now = input.now ?? new Date();
    const keys = (await client.query("UPDATE ngw_tenant_keys SET plan = $2 WHERE tenant_id = $1 AND status <> 'REVOKED' RETURNING key_hash",
      [input.tenantId, input.plan])).rows;
    await client.query("UPDATE ngw_tenant_period SET allowance_micros = $2 WHERE tenant_id = $1 AND period_start <= $3 AND period_end > $3",
      [input.tenantId, input.allowanceMicros, now]);
    for (const row of keys) await notify(client, row.key_hash);
    await audit(client, input.tenantId, input.actor, "plan.change", null, { plan: input.plan, allowanceMicros: input.allowanceMicros });
  });
}

/** Ops job (a BYPASSRLS role): keys past their rotation overlap become REVOKED. The resolver already refuses them by `not_after`. */
export async function retireOverlappedKeys(ops: pg.Pool, now = new Date()): Promise<number> {
  return (await ops.query("UPDATE ngw_tenant_keys SET status = 'REVOKED', revoked_at = $1 WHERE status <> 'REVOKED' AND not_after <= $1", [now])).rowCount ?? 0;
}

export interface TenantKeyResolver {
  /** The key's record when it may serve now (ACTIVE, inside any overlap), else null. */
  resolve(presentedKey: string): Promise<TenantKey | null>;
  close(): Promise<void>;
}

/**
 * Per replica: keys found by hash are cached for `ttlMs` (5 s); a change NOTIFY drops the entry at once, so the TTL only bounds the
 * worst case. Misses are never cached (random keys must not grow the cache).
 * shortcut: a lost LISTEN connection is not re-opened, the 5 s TTL then bounds staleness; production re-listens on error.
 */
export async function createTenantKeyResolver(pool: pg.Pool, options: { ttlMs?: number; now?: () => number } = {}): Promise<TenantKeyResolver> {
  const ttlMs = options.ttlMs ?? 5_000;
  const now = options.now ?? Date.now;
  const cache = new Map<string, { key: TenantKey; at: number }>();
  const listener = await pool.connect();
  listener.on("notification", (message) => { if (message.payload) cache.delete(message.payload); });
  await listener.query(`LISTEN ${NGW_KEY_CHANGED}`);
  return {
    async resolve(presentedKey) {
      if (!presentedKey.startsWith(NGW_KEY_PREFIX)) return null;
      const hash = hashGatewayApiKey(presentedKey);
      let entry = cache.get(hash);
      if (!entry || now() - entry.at >= ttlMs) {
        const row = (await pool.query("SELECT * FROM ngw_key_by_hash($1)", [hash])).rows[0];
        if (!row) { cache.delete(hash); return null; }
        cache.set(hash, entry = { key: fromRow(row), at: now() });
      }
      const key = entry.key;
      return key.status === "ACTIVE" && (key.notAfter === null || key.notAfter.getTime() > now()) ? key : null;
    },
    async close() {
      await listener.query(`UNLISTEN ${NGW_KEY_CHANGED}`).catch(() => {});
      listener.release();
    }
  };
}
