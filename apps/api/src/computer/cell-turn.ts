import { readFile } from "node:fs/promises";
import { parseNousTurnOutput } from "@space/contracts";
import type { PgClientLike } from "@space/db";
import { signNousToken, verifyNousToken } from "../nous/mcp.js";
import { NousUnavailableError, type NousRunResult } from "../nous/service.js";
import type { CellDriver, CellModelUpstream } from "./cell-driver.js";
import type { CellOrchestrator, WakeResult } from "./cells.js";

// K2 vmTurnBackend (plan clipboard:ZGz1LnD51ELH step 7, Nous decision 27387eef): on the headless hub every Nous turn runs Claude Code in
// the owner's tenant cell. Its MCP calls come back through the runner's relay (cell-relay.ts) with a token bound to {tenant, owner, turn};
// its model calls go through the same relay, which puts the key on host-side, so no key enters the cell.
// Stop ends the in-cell process: the abort closes the runner call, the vsock stream and so the guest's exec (its process group is killed).
// shortcut: no streaming (the answer arrives whole at the end); stream through the vm-agent when the alpha's users need it.
// shortcut: Claude only; another provider is refused until the cell image's other CLIs get their relay env.

/** Well under cells.ts IDLE_TO_SLEEP_MS (3 min): a running turn keeps its cell awake. */
export const CELL_TURN_HEARTBEAT_MS = 60_000;
export const CELL_NO_AI = "Connect an AI to use Nous: add your Anthropic API key in Settings.";

export interface CellTurnDeps {
  pool: PgClientLike;
  provisioner: { ensureTenantCell(tenantId: string): Promise<WakeResult> };
  cells: Pick<CellOrchestrator, "cell">;
  driver: Pick<CellDriver, "turn">;
  /** The tenant's model upstream, read each turn (a rotated key applies at once); null: none connected. */
  upstream(tenantId: string, owner: string): Promise<CellModelUpstream | null>;
}

/** The fields of wiring.ts NousTurnBackend's body a cell turn reads (no import: wiring.ts imports this file). */
interface CellTurnBody { provider?: string; model: string; effort: string; fallbackModel?: string | null; system: string; prompt: string; maxTurns: number;
  timeoutMs: number; shell?: boolean; mcpUrl: string; mcpToken: string }

export function cellTurnBackend(deps: CellTurnDeps, secret: string): (body: CellTurnBody, signal?: AbortSignal) => Promise<NousRunResult> {
  return async (body, signal) => {
    const claims = verifyNousToken(secret, body.mcpToken);
    if (!claims) throw new Error("The turn's token does not verify.");
    if (body.provider && body.provider !== "claude") throw new NousUnavailableError("Nous Computer runs Claude turns only for now: pick a Claude model.");
    const { rows } = await deps.pool.query<{ tenant_id: string | null; kind: string | null }>(
      "SELECT u.tenant_id, t.kind FROM users u LEFT JOIN tenants t ON t.id = u.tenant_id WHERE u.id = $1", [claims.owner]);
    const tenantId = rows[0]?.tenant_id;
    // REV1128-008: every turn in a cell runs as one guest user (root) with its MCP token on the command line, so a shell turn could read another
    // member's token from /proc. Shell runs only in a PERSONAL cell (one user) until each turn has its own guest user (vm-agent and image release).
    const shell = body.shell === true && rows[0]?.kind === "PERSONAL";
    if (!tenantId) throw new NousUnavailableError("This account has no Nous Computer.");
    const upstream = await deps.upstream(tenantId, claims.owner);
    if (!upstream) throw new NousUnavailableError(CELL_NO_AI);
    if (!deps.driver.turn) throw new NousUnavailableError("This hub's cell driver cannot run turns.");
    const { hostId } = await deps.provisioner.ensureTenantCell(tenantId);
    const cell = await deps.cells.cell(tenantId);
    if (!cell) throw new Error(`The cell of ${tenantId} is gone.`);
    const heartbeat = setInterval(() => void deps.provisioner.ensureTenantCell(tenantId).catch(() => undefined), CELL_TURN_HEARTBEAT_MS);
    try {
      const out = await deps.driver.turn({ tenantId, hostId, memMib: cell.memMib }, {
        model: body.model, effort: body.effort, fallbackModel: body.fallbackModel ?? null, system: body.system, prompt: body.prompt, maxTurns: body.maxTurns,
        timeoutMs: body.timeoutMs, shell, mcpUrl: body.mcpUrl, mcpToken: signNousToken(secret, { ...claims, tenant: tenantId }), upstream
      }, signal);
      const parsed = parseNousTurnOutput(out.stdout || out.stderr);
      return { text: parsed.text, isError: parsed.isError, model: body.model, effort: body.effort, ...(parsed.costUsd !== undefined ? { costUsd: parsed.costUsd } : {}), ...(parsed.tokens ? { tokens: parsed.tokens } : {}) } satisfies NousRunResult;
    } finally {
      clearInterval(heartbeat);
    }
  };
}

/**
 * Internal accounts' upstream (Nous decision 27387eef (2)): the tenants in SPACE_CELLS_GATEWAY_TENANTS (comma list) use the region's Nous
 * Gateway key, read each turn from SPACE_CELLS_MODEL_KEY_FILE, at SPACE_CELLS_MODEL_URL. Every other tenant connects its own key (ai-key.ts).
 */
export function cellsGatewayUpstream(env: NodeJS.ProcessEnv): CellTurnDeps["upstream"] {
  const baseUrl = env.SPACE_CELLS_MODEL_URL?.trim(), keyFile = env.SPACE_CELLS_MODEL_KEY_FILE?.trim();
  const internal = new Set((env.SPACE_CELLS_GATEWAY_TENANTS ?? "").split(",").map((id) => id.trim()).filter(Boolean));
  return async (tenantId) => {
    if (!baseUrl || !keyFile || !internal.has(tenantId)) return null;
    const apiKey = (await readFile(keyFile, "utf8").catch(() => "")).trim();
    return apiKey ? { baseUrl, apiKey, headers: { "x-nous-task": "reason" } } : null;
  };
}
