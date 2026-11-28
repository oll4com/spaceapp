import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { createServer, type Server } from "node:http";
import { NOUS_PROMPT_MAX_CHARS, NOUS_SYSTEM_MAX_CHARS } from "@space/contracts";
import type { CellDriver, CellDriverOp, CellRef, CellTurnRequest } from "./cell-driver.js";

// The cells host's runner (plan clipboard:ZGz1LnD51ELH step 7): exposes one host's CellDriver to the orchestrator as
// POST /v1/cells/<op> {args} -> {result}, with a bearer token. createRemoteCellDriver is the orchestrator's side.
// shortcut: plain HTTP on the private hub link (192.0.2.0/24) with a shared token; put TLS on it before a cells host sits outside that link.

const MAX_BODY = 64 * 1024; // technical bound: every op's args are a few hundred bytes
/** Technical bound: a turn carries Nous's prompt and system prompt (their own bounds in @space/contracts, 4 bytes a char at most). */
const TURN_MAX_BODY = 4 * (NOUS_PROMPT_MAX_CHARS + NOUS_SYSTEM_MAX_CHARS) + MAX_BODY;
/** A headless turn's own limit (wiring.ts TURN_MS is 20 minutes); the remote call waits this plus a minute. */
export const CELL_TURN_MAX_MS = 30 * 60_000;

type Where = { hostId: string | null; objectKey: string | null };
const isStr = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 512;
const isCell = (v: unknown): v is CellRef => {
  const c = v as CellRef;
  return !!c && typeof c === "object" && isStr(c.tenantId) && isStr(c.hostId) && Number.isInteger(c.memMib) && c.memMib > 0;
};
const isWhere = (v: unknown): v is Where => {
  const w = v as Where;
  return !!w && typeof w === "object" && (w.hostId === null || isStr(w.hostId)) && (w.objectKey === null || isStr(w.objectKey));
};
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,159}$/;
export const NOUS_MCP_URL = /^https?:\/\/[A-Za-z0-9.-]+(?::\d{1,5})?\/api\/cli\/nous\/mcp$/;
const TOKEN = /^[A-Za-z0-9._-]{20,1024}$/;
const HEADER_NAME = /^[a-z0-9-]{1,64}$/;
const HEADER_VALUE = /^[\x20-\x7e]{0,512}$/;
const isTurn = (v: unknown): v is CellTurnRequest => {
  const t = v as CellTurnRequest;
  if (!t || typeof t !== "object" || !t.upstream || typeof t.upstream !== "object") return false;
  const { baseUrl, apiKey, headers } = t.upstream;
  return MODEL.test(t.model) && /^(?:none|minimal|low|medium|high|xhigh|max)$/.test(t.effort) && (t.fallbackModel === null || MODEL.test(t.fallbackModel))
    && typeof t.system === "string" && t.system.length <= NOUS_SYSTEM_MAX_CHARS && typeof t.prompt === "string" && t.prompt.trim() !== "" && t.prompt.length <= NOUS_PROMPT_MAX_CHARS
    && Number.isInteger(t.maxTurns) && t.maxTurns >= 1 && t.maxTurns <= 99 && Number.isInteger(t.timeoutMs) && t.timeoutMs >= 10_000 && t.timeoutMs <= CELL_TURN_MAX_MS
    && typeof t.shell === "boolean" && typeof t.mcpUrl === "string" && NOUS_MCP_URL.test(t.mcpUrl) && typeof t.mcpToken === "string" && TOKEN.test(t.mcpToken)
    && typeof baseUrl === "string" && /^https?:\/\/[A-Za-z0-9.-]+(?::\d{1,5})?(?:\/[A-Za-z0-9._~/-]*)?$/.test(baseUrl)
    && typeof apiKey === "string" && /^[\x21-\x7e]{8,512}$/.test(apiKey)
    && (headers === undefined || (!!headers && typeof headers === "object" && Object.entries(headers).every(([k, val]) => HEADER_NAME.test(k) && typeof val === "string" && HEADER_VALUE.test(val))));
};

/** Proves to the hub that an MCP call came through this cell's relay (the hub holds the same runner token): `<cellId>.<hmac>`. */
export const cellProof = (token: string, id: string) => `${id}.${createHmac("sha256", token).update(`space-cell:${id}`).digest("base64url")}`;
/** The hub's side: the cell a relay's x-space-cell header proves, or null. */
export function provenCell(token: string, header: string | string[] | undefined): string | null {
  const id = /^(c-[0-9a-f]{24})\.[A-Za-z0-9_-]{43}$/.exec(typeof header === "string" ? header : "")?.[1];
  if (!id) return null;
  const want = Buffer.from(cellProof(token, id)), given = Buffer.from(header as string);
  return want.length === given.length && timingSafeEqual(want, given) ? id : null;
}

/** Each op's argument shapes, checked before the driver sees them. */
const ARGS: Record<CellDriverOp, (a: unknown[]) => boolean> = {
  create: (a) => a.length === 1 && isCell(a[0]),
  resume: (a) => a.length === 1 && isCell(a[0]),
  pauseAndSnapshot: (a) => a.length === 1 && isCell(a[0]),
  restore: (a) => a.length === 1 && isCell(a[0]),
  waitReady: (a) => a.length === 1 && isCell(a[0]),
  upload: (a) => a.length === 1 && isCell(a[0]),
  syncClock: (a) => a.length === 2 && isCell(a[0]) && Number.isFinite(a[1]),
  download: (a) => a.length === 2 && isCell(a[0]) && isStr(a[1]),
  exportUserData: (a) => a.length === 2 && isStr(a[0]) && isWhere(a[1]),
  destroy: (a) => a.length === 2 && isStr(a[0]) && isWhere(a[1]),
  turn: (a) => a.length === 2 && isCell(a[0]) && isTurn(a[1]),
};

const digest = (s: string) => createHash("sha256").update(s).digest();

export function createCellRunnerServer(driver: CellDriver, token: string): Server {
  if (token.length < 32) throw new Error("The cell runner's token must be at least 32 characters.");
  const want = digest(`Bearer ${token}`);
  return createServer((req, res) => {
    // One connection per op: a pooled socket the server closed while idle fails the next POST, which must not be retried blindly.
    const send = (status: number, body: unknown) => res.writeHead(status, { "content-type": "application/json", connection: "close" }).end(JSON.stringify(body));
    if (!timingSafeEqual(digest(req.headers.authorization ?? ""), want)) return send(401, { error: "unauthorized" });
    const op = /^\/v1\/cells\/([A-Za-z]+)$/.exec(req.url ?? "")?.[1] as CellDriverOp | undefined;
    if (req.method !== "POST" || !op || !Object.hasOwn(ARGS, op)) return send(404, { error: "not found" });
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > (op === "turn" ? TURN_MAX_BODY : MAX_BODY)) {
        send(413, { error: "body too large" });
        req.destroy();
      } else chunks.push(chunk);
    });
    req.on("end", async () => {
      let args: unknown[];
      try {
        args = JSON.parse(Buffer.concat(chunks).toString("utf8")).args;
      } catch {
        return send(400, { error: "bad json" });
      }
      if (!Array.isArray(args) || !ARGS[op](args)) return send(400, { error: `bad args for ${op}` });
      if (!driver[op]) return send(501, { error: `this host's driver has no ${op}` });
      try {
        // The hub hung up (a Stop or its own timeout): a turn still running in the cell ends with it.
        const hangup = new AbortController();
        res.on("close", () => hangup.abort());
        const result = await (driver[op] as (...a: unknown[]) => Promise<unknown>)(...args, ...(op === "turn" ? [hangup.signal] : []));
        send(200, { result: result ?? null });
      } catch (error) {
        send(500, { error: error instanceof Error ? error.message : String(error) });
      }
    });
  });
}

/** The orchestrator's CellDriver: each call goes to the runner of the cell's host (hosts: host id -> runner URL). timeoutMs bounds each
 * call (a cold download of a large snapshot is the slowest). */
export function createRemoteCellDriver(options: { hosts: Record<string, string>; token: string; timeoutMs?: number }): CellDriver {
  const first = Object.keys(options.hosts)[0];
  const call = async (hostId: string | null, op: CellDriverOp, ...args: unknown[]): Promise<never> => callFor(options.timeoutMs ?? 600_000, hostId, op, ...args);
  const callFor = async (timeoutMs: number, hostId: string | null, op: CellDriverOp, ...args: unknown[]): Promise<never> => callWith(AbortSignal.timeout(timeoutMs), hostId, op, ...args);
  const callWith = async (signal: AbortSignal, hostId: string | null, op: CellDriverOp, ...args: unknown[]): Promise<never> => {
    // shortcut: a cold cell (no host) is exported and destroyed through the first host, which reads the cold store; give the cold store its own runner when hosts stop sharing it.
    const url = options.hosts[hostId ?? first ?? ""];
    if (!url) throw new Error(`cell runner ${op}: no runner for host ${hostId}`);
    const res = await fetch(`${url.replace(/\/$/, "")}/v1/cells/${op}`, {
      method: "POST",
      headers: { authorization: `Bearer ${options.token}`, "content-type": "application/json" },
      body: JSON.stringify({ args }),
      signal,
    });
    const body = (await res.json().catch(() => ({}))) as { result?: never; error?: string };
    if (!res.ok) throw new Error(`cell runner ${op}: ${res.status} ${body.error ?? ""}`.trim());
    return body.result as never;
  };
  return {
    create: (cell) => call(cell.hostId, "create", cell),
    resume: (cell) => call(cell.hostId, "resume", cell),
    pauseAndSnapshot: (cell) => call(cell.hostId, "pauseAndSnapshot", cell),
    restore: (cell) => call(cell.hostId, "restore", cell),
    syncClock: (cell, epochMs) => call(cell.hostId, "syncClock", cell, epochMs),
    waitReady: (cell) => call(cell.hostId, "waitReady", cell),
    upload: (cell) => call(cell.hostId, "upload", cell),
    download: (cell, objectKey) => call(cell.hostId, "download", cell, objectKey),
    exportUserData: (tenantId, where) => call(where.hostId, "exportUserData", tenantId, where),
    destroy: (tenantId, where) => call(where.hostId, "destroy", tenantId, where),
    // A Stop aborts the call; the runner sees the request close and ends the turn in the cell.
    turn: (cell, request, signal) => callWith(AbortSignal.any([AbortSignal.timeout(request.timeoutMs + 60_000), ...(signal ? [signal] : [])]), cell.hostId, "turn", cell, request),
  };
}
