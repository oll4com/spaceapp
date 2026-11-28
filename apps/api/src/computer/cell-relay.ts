import { chmod, chown, rm } from "node:fs/promises";
import { createServer, request as httpRequest, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { request as httpsRequest } from "node:https";
import type { CellModelUpstream } from "./cell-driver.js";

// The cell's only way to the hub and to its model (plan clipboard:ZGz1LnD51ELH step 7, Nous decision 27387eef option a): the guest's
// space-vm-agent forwards 127.0.0.1:5253 over vsock to Firecracker's host socket <jail>/v.sock_5253, where this relay listens as root.
// It passes (1) the hub's Nous MCP calls that carry a running turn's token, to that turn's URL, with the cell's proof (x-space-cell), and
// (2) the turn's model calls, with the real key put on here: the cell holds only a random handle. Cells stay denied to the hub
// (cell-host.ts cellEgressRuleset); everything else answers 404. Bodies stream both ways, nothing is buffered.

export const RELAY_VSOCK_PORT = 5253;
export const RELAY_MODEL_PREFIX = "/model";
const MCP_PATH = "/api/cli/nous/mcp";
/** The model calls Claude Code makes; any other path of the upstream stays closed to the cell. */
const MODEL_ROUTES = new Set(["POST /v1/messages", "POST /v1/messages/count_tokens", "GET /v1/models"]);
const HOP = new Set(["connection", "keep-alive", "proxy-authorization", "proxy-connection", "te", "trailer", "transfer-encoding", "upgrade", "host", "content-length"]);

export interface RelayTurn { handle: string; mcpUrl: string; mcpToken: string; upstream: CellModelUpstream }

const clean = (headers: IncomingHttpHeaders, keepLength: boolean) =>
  Object.fromEntries(Object.entries(headers).filter(([name]) => !HOP.has(name) || (keepLength && name === "content-length"))) as Record<string, string | string[]>;

function forward(req: IncomingMessage, res: ServerResponse, target: URL, headers: Record<string, string | string[]>) {
  const out = (target.protocol === "https:" ? httpsRequest : httpRequest)(target, { method: req.method, headers }, (up) => {
    res.writeHead(up.statusCode ?? 502, clean(up.headers, false));
    up.pipe(res);
  });
  out.on("error", () => (res.headersSent ? res.destroy() : res.writeHead(502, { "content-type": "application/json" }).end('{"error":"upstream unreachable"}')));
  res.on("close", () => out.destroy());
  req.pipe(out);
}

const deny = (res: ServerResponse, status: number) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify({ error: status === 404 ? "not found" : "no running turn" }));

/** Per cell: one relay socket while it has running turns. `proof(cellId)` is cell-runner.ts cellProof with the runner's token. */
export function createCellRelays(options: { proof: (cellId: string) => string }) {
  const cells = new Map<string, { server: Server; path: string; turns: Map<string, RelayTurn>; ready: Promise<void> }>();

  const handler = (cellId: string, turns: Map<string, RelayTurn>) => (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://relay");
    if (url.pathname === MCP_PATH && (req.method === "POST" || req.method === "GET")) {
      const bearer = /^Bearer (\S+)$/.exec(String(req.headers.authorization ?? ""))?.[1];
      const turn = [...turns.values()].find((entry) => entry.mcpToken === bearer);
      if (!turn) return deny(res, 401);
      return forward(req, res, new URL(turn.mcpUrl), { ...clean(req.headers, true), "x-space-cell": options.proof(cellId) });
    }
    const path = url.pathname.startsWith(`${RELAY_MODEL_PREFIX}/`) ? url.pathname.slice(RELAY_MODEL_PREFIX.length) : null;
    if (path === null || !MODEL_ROUTES.has(`${req.method} ${path}`)) return deny(res, 404);
    const presented = String(req.headers["x-api-key"] ?? /^Bearer (\S+)$/.exec(String(req.headers.authorization ?? ""))?.[1] ?? "");
    const turn = turns.get(presented);
    if (!turn) return deny(res, 401);
    const headers = clean(req.headers, true);
    delete headers.authorization;
    forward(req, res, new URL(`${turn.upstream.baseUrl.replace(/\/$/, "")}${path}${url.search}`), { ...headers, ...turn.upstream.headers, "x-api-key": turn.upstream.apiKey });
  };

  async function drop(cellId: string) {
    const cell = cells.get(cellId);
    if (!cell) return;
    cells.delete(cellId);
    cell.server.close();
    cell.server.closeAllConnections();
    await rm(cell.path, { force: true });
  }

  return {
    /** Adds a running turn to the cell's relay, opening its socket (owned by the cell's uid, which Firecracker runs as) on the first; the
     *  returned close removes the turn, and the cell's last turn takes the socket with it. */
    async open(cellId: string, socketPath: string, uid: number, turn: RelayTurn): Promise<() => Promise<void>> {
      let cell = cells.get(cellId);
      if (!cell) {
        const turns = new Map<string, RelayTurn>();
        const server = createServer(handler(cellId, turns));
        const ready = (async () => {
          await rm(socketPath, { force: true });
          await new Promise<void>((resolve, reject) => server.once("error", reject).listen(socketPath, resolve));
          await chown(socketPath, uid, uid);
          await chmod(socketPath, 0o600);
        })();
        cell = { server, path: socketPath, turns, ready };
        cells.set(cellId, cell);
      }
      const opened = cell;
      opened.turns.set(turn.handle, turn);
      try {
        await opened.ready;
      } catch (error) {
        if (cells.get(cellId) === opened) await drop(cellId);
        throw error;
      }
      return async () => {
        opened.turns.delete(turn.handle);
        if (!opened.turns.size && cells.get(cellId) === opened) await drop(cellId);
      };
    },
    /** The cell stops (sleep, destroy): its relay goes with its jail. */
    drop
  };
}
