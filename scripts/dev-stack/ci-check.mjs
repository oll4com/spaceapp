#!/usr/bin/env node
// End-to-end check of a running `npm run dev:stack` over HTTP, as CI runs it:
// readiness, owner setup with the one-time token, then an OpenCode pane in the
// Getting Started room started through the from-source CLI host, plus hot reload.
import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import WebSocket from "ws";
import { resolvePorts, resolveStateDir, statePaths } from "./config.mjs";

const ports = resolvePorts();
const paths = statePaths(resolveStateDir());
const base = `http://127.0.0.1:${ports.web}`;
const apiBase = `http://127.0.0.1:${ports.api}`;
let cookie = "";
let csrf = null;

/**
 * Logs a progress step from the CI verification script to stdout.
 *
 * @param {string} message - Step message to print.
 * @returns {void}
 */
function step(message) {
  process.stdout.write(`[dev-stack-check] ${message}\n`);
}

/**
 * Sends an HTTP request to the running dev stack and parses the JSON response.
 *
 * @param {string} method - HTTP method.
 * @param {string} path - Request path or full URL.
 * @param {unknown} [body] - Optional JSON request body.
 * @returns {Promise<any>} Parsed JSON response payload.
 */
async function request(method, path, body) {
  const headers = { accept: "application/json" };
  if (cookie) headers.cookie = cookie;
  if (csrf && method !== "GET") headers[csrf.headerName] = csrf.csrfToken;
  if (body !== undefined) headers["content-type"] = "application/json";
  const url = path.startsWith("http://") ? path : `${base}${path}`;
  const response = await fetch(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000)
  });
  const setCookie = response.headers.getSetCookie?.() ?? [];
  if (setCookie.length > 0) {
    cookie = setCookie.map((value) => value.split(";")[0]).join("; ");
  }
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // Response is not JSON.
  }
  if (!response.ok) {
    throw new Error(`${method} ${path} returned ${response.status}: ${text.slice(0, 500)}`);
  }
  return json;
}

/**
 * Polls `probe` every second until it returns a truthy value or `timeoutMs` elapses.
 *
 * @template T
 * @param {string} label - Description of the condition being awaited.
 * @param {number} timeoutMs - Maximum wait time in milliseconds.
 * @param {() => Promise<T>} probe - Async probe function.
 * @returns {Promise<NonNullable<T>>} Resolved truthy value from `probe`.
 */
async function until(label, timeoutMs, probe) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      const value = await probe();
      if (value) return value;
    } catch (error) {
      last = error;
    }
    await delay(1000);
  }
  throw new Error(`Timed out waiting for ${label}${last ? `: ${last.message}` : ""}.`);
}

const timeoutMs = Number(process.env.SPACE_DEV_CHECK_TIMEOUT_MS) || 900_000;
const apiReady = await until("API /readyz ok", timeoutMs, async () => {
  const body = await request("GET", `${apiBase}/readyz`);
  return body?.ok === true ? body : null;
});
const ready = await until("web /readyz ok", 60_000, async () => {
  const body = await request("GET", "/readyz");
  return body?.ok === true ? body : null;
});
if (
  apiReady.dependencies?.worker !== "RUNNING" ||
  ready.dependencies?.worker !== "RUNNING" ||
  ready.dependencies?.cliHost !== "RUNNING"
) {
  throw new Error(`Readiness without a running worker and CLI host: ${JSON.stringify(ready.dependencies)}`);
}
step(`ready: database ${ready.dependencies.database}, worker ${ready.dependencies.worker}, CLI host ${ready.dependencies.cliHost}`);

const status = await request("GET", "/api/setup/status");
if (!status.setupRequired) {
  throw new Error("Owner setup is already claimed; run npm run dev:stack -- reset first.");
}
const token = (await readFile(paths.setupToken, "utf8")).trim();
const email = "owner@dev-stack.example.com";
const password = randomBytes(18).toString("base64url");
const claim = await request("POST", "/api/setup/claim", { token, email, password });
step(`owner created (${claim.user.email}), starter room ${claim.starterRoomId}`);

// A fresh sign-in, as the owner would do after setup.
cookie = "";
await request("POST", "/api/auth/login", { email, password });
csrf = await request("GET", "/api/auth/csrf");
step("signed in with the owner account");

const rooms = (await request("GET", "/api/rooms")).data ?? [];
const room = rooms.find((candidate) => candidate.id === claim.starterRoomId);
if (!room) {
  throw new Error(`The Getting Started room is missing: ${JSON.stringify(rooms).slice(0, 500)}`);
}
const panes = (await request("GET", `/api/panes?roomId=${encodeURIComponent(room.id)}`)).data ?? [];
const pane = panes.find((candidate) => candidate.terminalRuntimeId === "cli:opencode");
if (!pane) {
  throw new Error(`The Getting Started room has no OpenCode pane: ${JSON.stringify(panes).slice(0, 800)}`);
}
step(`Getting Started room "${room.name}" has pane ${pane.id} (${pane.title})`);

const started = await request("POST", `/api/panes/${encodeURIComponent(pane.id)}/cli/session`, { runtimeId: "cli:opencode" });
step(`CLI session ${started.session.sessionId} requested (${started.session.status})`);
if (!started.websocket) {
  throw new Error("The CLI session response has no terminal ticket.");
}

// The terminal attaches like the browser does; the CLI host launches the process on attach.
const ticket = started.websocket;
const params = new URLSearchParams({
  sessionId: ticket.sessionId,
  token: ticket.token,
  initialCols: "120",
  initialRows: "40"
});
const socket = new WebSocket(
  `ws://127.0.0.1:${ports.web}/api/panes/${encodeURIComponent(ticket.paneId)}/cli/terminal?${params}`,
  { headers: { cookie, origin: base } }
);
let output = "";
socket.on("message", (data) => {
  output += data.toString();
  if (output.length > 4_000_000) output = output.slice(-1_000_000);
});
socket.on("error", (error) => step(`terminal socket error: ${error.message}`));
await until("the terminal socket", 30_000, async () => socket.readyState === WebSocket.OPEN);
const running = await until("a running OpenCode session with terminal output", 180_000, async () => {
  const current = await request("GET", `/api/panes/${encodeURIComponent(pane.id)}/cli/session`);
  return current?.session?.status === "RUNNING" && output.length > 2000 ? current : null;
});
const escapeSequence = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[A-Za-z]`, "g");
const showsOpencode = /opencode/i.test(output.replace(escapeSequence, ""));
step(`pane ${pane.id} is ${running.session.status}; terminal sent ${output.length} bytes${showsOpencode ? " including the OpenCode UI" : ""}`);
socket.close();

/**
 * Verifies that editing a tracked source file triggers a rebuild/restart of the API (and worker
 * when a shared package changes), then restores the original file and waits for the stack to settle.
 *
 * @param {string} file - Repository-relative path to touch.
 * @param {string} label - Human-readable description of the change.
 * @param {boolean} [expectWorkerRestart=false] - Whether to also await a worker restart in the dev-stack log.
 * @returns {Promise<void>}
 */
async function apiStartedAfterEdit(file, label, expectWorkerRestart = false) {
  await delay(3000);
  const before = (
    await until("a ready API before the edit", 180_000, async () => {
      const body = await request("GET", "/readyz");
      return body.ok === true && body.dependencies?.worker === "RUNNING" ? body : null;
    })
  ).apiStartedAt;
  const targetUrl = new URL(`../../${file}`, import.meta.url);
  const original = await readFile(targetUrl, "utf8");
  const logPath = process.env.SPACE_DEV_STACK_LOG;
  let afterStartedAt = before;
  try {
    const logLengthBeforeEdit = expectWorkerRestart && logPath ? (await readFile(logPath, "utf8")).length : 0;
    await writeFile(targetUrl, `${original}// dev-stack hot reload check\n`);
    const after = await until(`the API to restart after ${label}`, 180_000, async () => {
      const body = await request("GET", "/readyz");
      return body.ok === true && body.apiStartedAt !== before ? body : null;
    });
    afterStartedAt = after.apiStartedAt;
    if (expectWorkerRestart && logPath) {
      await until("the worker to restart on the rebuilt package", 120_000, async () => {
        const log = (await readFile(logPath, "utf8")).slice(logLengthBeforeEdit);
        const restart = log.indexOf("restarting worker");
        return restart >= 0 && /state: 'RUNNING'/.test(log.slice(restart));
      });
    }
    step(`${label}: API restarted (${before} -> ${afterStartedAt}) and is ready`);
  } finally {
    const logLengthBeforeRestore = expectWorkerRestart && logPath ? (await readFile(logPath, "utf8")).length : 0;
    await writeFile(targetUrl, original);
    await until(`the API to settle after restoring ${file}`, 180_000, async () => {
      const body = await request("GET", "/readyz");
      return body.ok === true && body.apiStartedAt !== afterStartedAt && body.dependencies?.worker === "RUNNING" ? body : null;
    });
    if (expectWorkerRestart && logPath) {
      await until("the worker to settle after restoring package", 120_000, async () => {
        const log = (await readFile(logPath, "utf8")).slice(logLengthBeforeRestore);
        const restart = log.indexOf("restarting worker");
        return restart >= 0 && /state: 'RUNNING'/.test(log.slice(restart));
      });
    }
  }
}

await apiStartedAfterEdit("apps/api/src/config.ts", "apps/api/src change", false);
await apiStartedAfterEdit("packages/contracts/src/index.ts", "packages/contracts/src change (rebuilt)", true);

const finalReady = await until("/readyz ok after hot reload checks", 60_000, async () => {
  const body = await request("GET", "/readyz");
  return body.ok === true && body.dependencies?.worker === "RUNNING" ? body : null;
});
step(`hot reload verified; /readyz ok, worker ${finalReady.dependencies.worker}`);
process.stdout.write(`${JSON.stringify({ passed: true, roomId: room.id, paneId: pane.id, sessionId: running.session.sessionId })}\n`);
