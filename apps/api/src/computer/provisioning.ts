import type { PgClientLike } from "@space/db";
import { CellDeletedError, CellSuspendedError, type CellHost, type CellOrchestrator, type WakeResult } from "./cells.js";

// P1 cell provisioning in one EU region (plan clipboard:ZGz1LnD51ELH step 7; K2 design §4.1: the cell is made on the tenant's first
// wake, not at sign-up, so an abandoned sign-up costs nothing). Off unless SPACE_CELLS_REGION and SPACE_CELLS_HOSTS are set: a
// self-hosted SpaceApp has no cells. Not wired into app.ts yet: K2's vmTurnBackend(tenantId) calls ensureTenantCell.

export class CellRegionError extends Error {}
export class CellsConfigError extends Error {}

export interface CellsRegionConfig {
  /** The one region this deployment serves (P1: one EU region); tenants.region must equal it. */
  region: string;
  hosts: CellHost[];
}

/** SPACE_CELLS_REGION=eu, SPACE_CELLS_HOSTS=JSON [{"id":"cells-1","ramMib":131072,"maxAwake":25}]; null when neither is set. */
export function cellsRegionConfig(env: NodeJS.ProcessEnv = process.env): CellsRegionConfig | null {
  const region = env.SPACE_CELLS_REGION?.trim(), rawHosts = env.SPACE_CELLS_HOSTS?.trim();
  if (!region && !rawHosts) return null;
  if (!region || !/^[a-z0-9-]{2,16}$/.test(region)) throw new CellsConfigError("SPACE_CELLS_REGION must be a region code such as eu.");
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawHosts ?? "");
  } catch {
    throw new CellsConfigError("SPACE_CELLS_HOSTS must be a JSON array of {id, ramMib, maxAwake}.");
  }
  if (!Array.isArray(parsed) || parsed.length === 0) throw new CellsConfigError("SPACE_CELLS_HOSTS needs at least one cells host.");
  const hosts = parsed.map((host: Record<string, unknown>, index): CellHost => {
    const { id, ramMib, maxAwake, draining } = host ?? {};
    const positive = (value: unknown) => Number.isInteger(value) && (value as number) > 0;
    if (typeof id !== "string" || !/^[A-Za-z0-9_.-]{1,64}$/.test(id) || !positive(ramMib) || !positive(maxAwake)) {
      throw new CellsConfigError(`SPACE_CELLS_HOSTS[${index}] needs an id and positive integer ramMib and maxAwake.`);
    }
    return { id, ramMib: ramMib as number, maxAwake: maxAwake as number, draining: draining === true };
  });
  if (new Set(hosts.map((host) => host.id)).size !== hosts.length) throw new CellsConfigError("SPACE_CELLS_HOSTS repeats a host id.");
  return { region, hosts };
}

/** The account gate in front of cells.ensureAwake: only an ACTIVE tenant of the served region gets a cell. */
export function createCellProvisioner(options: { pool: PgClientLike; cells: CellOrchestrator; region: string }) {
  const { pool, cells, region } = options;
  return {
    async ensureTenantCell(tenantId: string): Promise<WakeResult> {
      const { rows } = await pool.query<{ status: string; region: string | null }>("SELECT status, region FROM tenants WHERE id = $1", [tenantId]);
      const tenant = rows[0];
      if (!tenant) throw new CellRegionError(`Tenant ${tenantId} does not exist.`);
      if (tenant.region !== region) throw new CellRegionError(`Tenant ${tenantId} is in region ${tenant.region ?? "none"}; this deployment serves ${region}.`);
      if (tenant.status === "DELETING") throw new CellDeletedError(`Tenant ${tenantId} is being deleted.`);
      if (tenant.status !== "ACTIVE") throw new CellSuspendedError(`Tenant ${tenantId} is ${tenant.status}.`);
      return cells.ensureAwake(tenantId);
    }
  };
}
