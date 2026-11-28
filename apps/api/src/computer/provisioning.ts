import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { PgClientLike, PgPoolLike } from "@space/db";
import { createAccountLifecycle } from "./accounts.js";
import { cellId } from "./firecracker-cell-driver.js";
import { createRemoteCellDriver, provenCell } from "./cell-runner.js";
import { createAiKeySeal, createTenantAiKeys } from "./ai-key.js";
import { cellsGatewayUpstream, type CellTurnDeps } from "./cell-turn.js";
import { CellDeletedError, CellSuspendedError, createCellOrchestrator, createPgCellStore, type CellHost, type CellOrchestrator, type WakeResult } from "./cells.js";
import { createGatewayKeyStatus } from "./gateway-key-status.js";

// P1 cell provisioning in one EU region (plan clipboard:ZGz1LnD51ELH step 7; K2 design §4.1: the cell is made on the tenant's first
// wake, not at sign-up, so an abandoned sign-up costs nothing). Off unless SPACE_CELLS_REGION and SPACE_CELLS_HOSTS are set: a
// self-hosted SpaceApp has no cells. nousComputerFromEnv wires the orchestrator and the K4 account lifecycle in server.ts (headless);
// cell-turn.ts (K2's vmTurnBackend) calls ensureTenantCell before and during every turn.

export class CellRegionError extends Error {}
export class CellsConfigError extends Error {}

export interface CellsRegionConfig {
  /** The one region this deployment serves (P1: one EU region); tenants.region must equal it. */
  region: string;
  /** url: the host's space-cell-runner (deploy/space-cell-runner), needed by nousComputerFromEnv. */
  hosts: Array<CellHost & { url?: string }>;
}

/** SPACE_CELLS_REGION=eu, SPACE_CELLS_HOSTS=JSON [{"id":"cells-1","ramMib":131072,"maxAwake":25,"maxBooting":4,"url":"http://192.0.2.231:7231"}]; null when neither is set. */
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
  const hosts = parsed.map((host: Record<string, unknown>, index): CellsRegionConfig["hosts"][number] => {
    const { id, ramMib, maxAwake, maxBooting, draining, url } = host ?? {};
    const positive = (value: unknown) => Number.isInteger(value) && (value as number) > 0;
    if (typeof id !== "string" || !/^[A-Za-z0-9_.-]{1,64}$/.test(id) || !positive(ramMib) || !positive(maxAwake)) {
      throw new CellsConfigError(`SPACE_CELLS_HOSTS[${index}] needs an id and positive integer ramMib and maxAwake.`);
    }
    if (maxBooting !== undefined && !positive(maxBooting)) throw new CellsConfigError(`SPACE_CELLS_HOSTS[${index}].maxBooting must be a positive integer.`);
    if (url !== undefined && (typeof url !== "string" || !/^https?:\/\/[^/\s]+\/?$/.test(url))) throw new CellsConfigError(`SPACE_CELLS_HOSTS[${index}].url must be the runner's http(s)://host:port.`);
    return { id, ramMib: ramMib as number, maxAwake: maxAwake as number, draining: draining === true, ...(maxBooting ? { maxBooting: maxBooting as number } : {}), ...(url ? { url } : {}) };
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

/** Each orchestrator tick sleeps idle cells; a cell idles at most this long past IDLE_TO_SLEEP_MS before its RAM is back. */
export const CELLS_TICK_MS = 30_000;

/**
 * The headless hub's cells and K4 account lifecycle, or null without SPACE_CELLS_REGION/SPACE_CELLS_HOSTS. With cells it needs every
 * host's runner url, SPACE_CELLS_RUNNER_TOKEN_FILE, SPACE_CELLS_AI_KEY_SEAL_FILE (ai-key.ts) and the Nous Gateway admin (SPACE_NOUS_GATEWAY_ADMIN_URL, SPACE_NOUS_GATEWAY_ADMIN_TLS_DIR
 * with ca.pem, cert.pem, key.pem), and refuses to start without them: an account must never close without its gateway keys.
 */
export function nousComputerFromEnv(env: NodeJS.ProcessEnv, pool: PgPoolLike) {
  const config = cellsRegionConfig(env);
  if (!config) return null;
  const missing = [
    ...config.hosts.filter((host) => !host.url).map((host) => `SPACE_CELLS_HOSTS ${host.id}.url`),
    ...["SPACE_CELLS_RUNNER_TOKEN_FILE", "SPACE_CELLS_AI_KEY_SEAL_FILE", "SPACE_NOUS_GATEWAY_ADMIN_URL", "SPACE_NOUS_GATEWAY_ADMIN_TLS_DIR"].filter((name) => !env[name]?.trim())
  ];
  if (missing.length) throw new CellsConfigError(`Nous Computer cells need ${missing.join(", ")}.`);
  const tls = (name: string) => readFileSync(join(env.SPACE_NOUS_GATEWAY_ADMIN_TLS_DIR!, name));
  const token = readFileSync(env.SPACE_CELLS_RUNNER_TOKEN_FILE!, "utf8").trim();
  const driver = createRemoteCellDriver({ hosts: Object.fromEntries(config.hosts.map((host) => [host.id, host.url!])), token });
  const cells = createCellOrchestrator({ driver, store: createPgCellStore(pool), hosts: config.hosts.map(({ url: _url, ...host }) => host) });
  const keys = createGatewayKeyStatus({ url: env.SPACE_NOUS_GATEWAY_ADMIN_URL!, ca: tls("ca.pem"), cert: tls("cert.pem"), key: tls("key.pem") });
  const aiKeys = createTenantAiKeys({ pool, seal: createAiKeySeal(readFileSync(env.SPACE_CELLS_AI_KEY_SEAL_FILE!, "utf8").trim()) });
  const gateway = cellsGatewayUpstream(env);
  // The tenant's own key first; the gateway key only for the internal accounts listed in SPACE_CELLS_GATEWAY_TENANTS.
  const upstream: CellTurnDeps["upstream"] = async (tenantId, owner) => (await aiKeys.upstream(tenantId)) ?? gateway(tenantId, owner);
  const turns: CellTurnDeps = { pool, provisioner: createCellProvisioner({ pool, cells, region: config.region }), cells, driver, upstream };
  /** The hub's check of a turn's MCP call: the relay's proof (the runner token's HMAC) names the tenant's own cell. */
  const cellProven = (tenantId: string, proof: string | string[] | undefined) => provenCell(token, proof) === cellId(tenantId);
  return { cells, lifecycle: createAccountLifecycle({ pool, cells, keys }), aiKeys, turns: { deps: turns, cellProven } };
}
