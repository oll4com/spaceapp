import { siteSigninKeySchema, siteSigninRecordSchema, type SiteSignin, type SiteSigninInput } from "@space/contracts";
import { createSpacePgPool, type PgPoolLike } from "./space-store.js";
import { rollbackKeepingError } from "./rollback.js";

export interface SiteSigninsRepository {
  get(owner: string, site: string, accountLabel?: string): Promise<SiteSignin | null>;
  list(owner: string): Promise<SiteSignin[]>;
  record(owner: string, input: SiteSigninInput, by: string, at?: string): Promise<SiteSignin>;
  dispose(): Promise<void>;
}
/** Omitted fields preserve known facts. A submitted form is an attempt, never proof of authentication. */
function update(old: SiteSignin | null, raw: SiteSigninInput, by: string, at: string): SiteSignin {
  const { outcome, reason, site, accountLabel, ...changes } = siteSigninRecordSchema.parse(raw);
  const value: SiteSignin = { method: "OTHER", lastSuccessAt: null, lastSuccessBy: null, successCount: 0,
    lastFailureAt: null, lastFailureReason: null, pendingAttempt: null, history: [], ...old, ...changes, site, accountLabel, updatedAt: at };
  if (outcome === "SUCCESS" && old?.pendingAttempt && (!changes.method || changes.method === old.pendingAttempt.method)) {
    // Confirmation adopts the attempted recipe; until this point a failed password attempt cannot replace working SSO.
    value.method = old.pendingAttempt.method ?? "VAULT_LOGIN";
    if (changes.vaultHandle === undefined && old.pendingAttempt.vaultHandle) value.vaultHandle = old.pendingAttempt.vaultHandle;
    if (changes.browserProfileId === undefined && old.pendingAttempt.browserProfileId) value.browserProfileId = old.pendingAttempt.browserProfileId;
  }
  if (outcome === "SUCCESS") { value.lastSuccessAt = at; value.lastSuccessBy = by; value.successCount++; value.pendingAttempt = null; }
  if (outcome === "FAILURE") { value.lastFailureAt = at; value.lastFailureReason = reason ?? null; value.pendingAttempt = null; }
  if (outcome === "PENDING") value.pendingAttempt = { at, by, method: changes.method ?? old?.method ?? "OTHER", vaultHandle: changes.vaultHandle ?? null, browserProfileId: changes.browserProfileId ?? null, usernameLabel: changes.username ?? null };
  // A Vault attempt must not replace a proven SSO recipe until the agent confirms it worked.
  if (outcome === "PENDING" && old) { Object.assign(value, old, { updatedAt: at, pendingAttempt: value.pendingAttempt }); }
  value.history = [...value.history.filter((event) => Date.parse(event.at) > Date.parse(at) - 180 * 86400000),
    { at, by, outcome, changes, reason: reason ?? null }].slice(-100);
  return value;
}
export class InMemorySiteSigninsRepository implements SiteSigninsRepository {
  private rows = new Map<string, SiteSignin>();
  private key(owner: string, site: string, accountLabel = "main") { const key = siteSigninKeySchema.parse({site, accountLabel}); return JSON.stringify([owner, key.site, key.accountLabel]); }
  async get(owner: string, site: string, label = "main") { return structuredClone(this.rows.get(this.key(owner, site, label)) ?? null); }
  async list(owner: string) { return structuredClone([...this.rows].filter(([key]) => JSON.parse(key)[0] === owner).map(([, row]) => row)); }
  async record(owner: string, input: SiteSigninInput, by: string, at = new Date().toISOString()) {
    const parsed = siteSigninRecordSchema.parse(input); const key = this.key(owner, parsed.site, parsed.accountLabel);
    const value = update(this.rows.get(key) ?? null, parsed, by, at); this.rows.set(key, value); return structuredClone(value);
  }
  async dispose() {}
}
export class PostgresSiteSigninsRepository implements SiteSigninsRepository {
  constructor(private pool: PgPoolLike) {}
  static fromConnectionString(url: string) { return new PostgresSiteSigninsRepository(createSpacePgPool(url, {max: 2})); }
  async get(owner: string, site: string, accountLabel = "main") {
    const key = siteSigninKeySchema.parse({site, accountLabel});
    return (await this.pool.query<{record: SiteSignin}>("SELECT record FROM site_sign_ins WHERE owner_user_id=$1 AND site=$2 AND account_label=$3", [owner, key.site, key.accountLabel])).rows[0]?.record ?? null;
  }
  async list(owner: string) { return (await this.pool.query<{record: SiteSignin}>("SELECT record FROM site_sign_ins WHERE owner_user_id=$1 ORDER BY site, account_label", [owner])).rows.map((row) => row.record); }
  async record(owner: string, input: SiteSigninInput, by: string, at = new Date().toISOString()) {
    const parsed = siteSigninRecordSchema.parse(input); const client = await this.pool.connect(); let failed = false;
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [JSON.stringify([owner, parsed.site, parsed.accountLabel])]);
      const old = (await client.query<{record: SiteSignin}>("SELECT record FROM site_sign_ins WHERE owner_user_id=$1 AND site=$2 AND account_label=$3", [owner, parsed.site, parsed.accountLabel])).rows[0]?.record ?? null;
      const value = update(old, parsed, by, at);
      await client.query(`INSERT INTO site_sign_ins(owner_user_id,site,account_label,record,updated_at) VALUES($1,$2,$3,$4::jsonb,$5)
        ON CONFLICT(owner_user_id,site,account_label) DO UPDATE SET record=EXCLUDED.record,updated_at=EXCLUDED.updated_at`, [owner, parsed.site, parsed.accountLabel, JSON.stringify(value), at]);
      await client.query("COMMIT"); return value;
    } catch (error) { const rollback = await rollbackKeepingError(client, error); failed = rollback.failed; throw rollback.error; } finally { client.release?.(failed || undefined); }
  }
  async dispose() { await (this.pool as PgPoolLike & {end?: () => Promise<void>}).end?.(); }
}
