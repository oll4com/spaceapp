// K1 M6 (plan clipboard:ZGz1LnD51ELH step 17, design p0/k1-tenancy-design.md §2.4): the tenant travels in an AsyncLocalStorage
// context, not in arguments. With SPACE_TENANCY_ENABLED=1 every pool from createSpacePgPool / createDedicatedSpacePgPool sets
// it on the connection before use, as space_app (migration 0408), so row-level security (M4) shows only that tenant's rows.
// Off (the default), nothing here runs and every query is the owner's, as before.
import { AsyncLocalStorage } from "node:async_hooks";
import type pg from "pg";

export const TENANT_LOCAL = "tenant:local";
const tenantContext = new AsyncLocalStorage<{ tenantId: string }>();

export const tenancyEnabled = () => process.env.SPACE_TENANCY_ENABLED === "1";
export const currentTenantId = () => tenantContext.getStore()?.tenantId;
export const withTenant = <T>(tenantId: string, fn: () => T): T => tenantContext.run({ tenantId }, fn);

type TenantClient = pg.PoolClient & { spaceTenant?: string };

/** Sets the context's tenant (space_app) or none (back to the owner) on a checked-out client; a client keeps it until the tenant changes. */
async function scope(client: TenantClient): Promise<void> {
  const tenant = currentTenantId() ?? "";
  if (client.spaceTenant === tenant) return;
  // shortcut: work outside a tenant context (jobs, login, startup) still runs as the owner; tenantDirectory and withTenant in
  // every job (design §3.3) take that away before the cutover (M7).
  await client.query("SELECT set_config('space.tenant_id', $1, false), set_config('role', $2, false)", [tenant, tenant ? "space_app" : "none"]);
  client.spaceTenant = tenant;
}

/** Every checkout of the pool, pool.query included, runs in the caller's tenant. */
export function tenantScopedPool(pool: pg.Pool): pg.Pool {
  const checkout = pool.connect.bind(pool) as () => Promise<pg.PoolClient>;
  const connect = async () => {
    const client = await checkout();
    try {
      await scope(client);
    } catch (error) {
      client.release(error as Error);
      throw error;
    }
    return client;
  };
  pool.connect = connect as typeof pool.connect;
  pool.query = (async (...args: Parameters<pg.PoolClient["query"]>) => {
    const client = await connect();
    try {
      const result = await client.query(...args);
      client.release();
      return result;
    } catch (error) {
      client.release(error as Error);
      throw error;
    }
  }) as typeof pool.query;
  return pool;
}
