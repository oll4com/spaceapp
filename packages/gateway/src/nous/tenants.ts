import type pg from "pg";
import { setTenantKeyStatus, withTenant } from "./tenant-keys.js";

/**
 * Tenant deletion (plan clipboard:_0qBSFCftZuD step 4, K5-deletion; install plan §3.7, DPIA): the keys are revoked first (every replica
 * drops them at once), then the tenant's request logs (`tenant_id`, generated from the ledger id `ngwreq:<tenant>:<uuid>`), usage rows,
 * open reservations and keys are deleted in one transaction. Kept: the billing sums the law requires (`ngw_tenant_period`,
 * `ngw_usage_daily`, `ngw_meter_exports`) and the append-only audit, which records the deletion. Sticky bindings carry no tenant id
 * (their keys are hashes of tenant and session) and expire with the prompt-cache TTL (30 min by default).
 * shortcut: a stream still running when the key is revoked logs after the first pass; the admin route runs a second pass once the
 * longest stream (15 min) has ended, and a replica restart in between leaves those rows to the next deletion run for the tenant.
 */
export async function deleteTenantRows(db: pg.Pool, tenantId: string) {
  return withTenant(db, tenantId, async (client) => {
    const requestLogs = (await client.query("DELETE FROM space_gateway_request_logs WHERE tenant_id = $1", [tenantId])).rowCount ?? 0;
    const usage = (await client.query("DELETE FROM ngw_usage WHERE tenant_id = $1", [tenantId])).rowCount ?? 0;
    const inflight = (await client.query("DELETE FROM ngw_inflight WHERE tenant_id = $1", [tenantId])).rowCount ?? 0;
    await client.query("UPDATE ngw_tenant_period SET reserved_micros = 0 WHERE tenant_id = $1", [tenantId]);
    const keys = (await client.query("DELETE FROM ngw_tenant_keys WHERE tenant_id = $1 AND status = 'REVOKED'", [tenantId])).rowCount ?? 0;
    return { requestLogs, usage, inflight, keys };
  });
}

export async function deleteTenant(db: pg.Pool, tenantId: string, actor: string) {
  const revoked = await setTenantKeyStatus(db, tenantId, "REVOKED", actor, "tenant deleted");
  const deleted = await deleteTenantRows(db, tenantId);
  await withTenant(db, tenantId, (client) => client.query("INSERT INTO ngw_audit (tenant_id, actor, action, detail) VALUES ($1, $2, 'tenant.delete', $3)",
    [tenantId, actor, { revoked, ...deleted }]));
  return { revoked, ...deleted };
}
