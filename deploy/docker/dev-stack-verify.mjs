#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { devStackTestOwner } from "./dev-stack-test-fixtures.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const stateRoot = resolve(process.env.SPACE_DEV_STACK_DIR || join(root, ".dev-stack"));
const sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
const activeCliStatuses = new Set(["RUNNING", "READY", "ATTACHED"]);
const failedCliStatuses = new Set(["ERROR", "EXITED", "FAILED"]);

function timeoutFromEnv(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number of milliseconds.`);
  return value;
}

const readyTimeoutMs = timeoutFromEnv("SPACE_DEV_VERIFY_READY_TIMEOUT_MS", 420_000);
const cliTimeoutMs = timeoutFromEnv("SPACE_DEV_VERIFY_CLI_TIMEOUT_MS", 180_000);

async function waitForJson(path, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      return JSON.parse(await readFile(path, "utf8"));
    } catch (error) {
      lastError = error;
      await sleep(250);
    }
  }
  throw new Error(`Timed out waiting for source-stack bootstrap file ${path}: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

const config = await waitForJson(join(stateRoot, "config.json"));
const api = `http://127.0.0.1:${config.ports.api}`;

function firstCookie(response) {
  const values = typeof response.headers.getSetCookie === "function" ? response.headers.getSetCookie() : [];
  return (values[0] || response.headers.get("set-cookie") || "").split(";", 1)[0] || "";
}

async function request(path, { method = "GET", body, cookie, csrf, csrfHeader = "x-space-csrf-token" } = {}) {
  const headers = { accept: "application/json" };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (cookie) headers.cookie = cookie;
  if (csrf) headers[csrfHeader] = csrf;
  const response = await fetch(`${api}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  let payload = null;
  try { payload = text ? JSON.parse(text) : null; } catch { payload = text; }
  if (!response.ok) throw new Error(`${method} ${path} failed (${response.status}): ${text.slice(0, 800)}`);
  return { response, payload };
}

async function waitReady() {
  const deadline = Date.now() + readyTimeoutMs;
  while (Date.now() < deadline) {
    try {
      const { payload } = await request("/readyz");
      if (payload?.ok === true && payload.dependencies?.database === "RUNNING" && payload.dependencies?.worker === "RUNNING" && payload.dependencies?.cliHost === "RUNNING") return payload;
    } catch {}
    await sleep(500);
  }
  throw new Error(`Timed out waiting ${readyTimeoutMs}ms for real source-stack readiness.`);
}

const ready = await waitReady();
console.log(`[dev-stack-verify] PASS readiness database=${ready.dependencies.database} worker=${ready.dependencies.worker} cliHost=${ready.dependencies.cliHost}`);

const setupToken = (await readFile(join(stateRoot, "secrets", "setup-token"), "utf8")).trim();
const { email, password } = devStackTestOwner;
const claimed = await request("/api/setup/claim", {
  method: "POST",
  body: { token: setupToken, email, password }
});
const starterRoomId = claimed.payload?.starterRoomId;
if (typeof starterRoomId !== "string" || !starterRoomId.startsWith("room:")) throw new Error("Owner setup did not return the Getting Started room id.");
if (!firstCookie(claimed.response)) throw new Error("Owner setup succeeded without returning a session cookie.");
console.log(`[dev-stack-verify] PASS owner setup starterRoom=${starterRoomId}`);

const login = await request("/api/auth/login", {
  method: "POST",
  body: { email, password }
});
const cookie = firstCookie(login.response);
if (!cookie || login.payload?.isAuthenticated !== true || login.payload?.user?.role !== "ADMIN") {
  throw new Error("The owner created by setup could not sign in with its configured credentials.");
}
console.log("[dev-stack-verify] PASS owner credentials sign in through /api/auth/login");

const csrfResponse = await request("/api/auth/csrf", { cookie });
const csrf = csrfResponse.payload?.csrfToken;
const csrfHeader = csrfResponse.payload?.headerName || "x-space-csrf-token";
if (typeof csrf !== "string" || !csrf) throw new Error("Authenticated owner session did not return a CSRF token.");

const roomsResponse = await request("/api/rooms", { cookie });
const rooms = Array.isArray(roomsResponse.payload) ? roomsResponse.payload : (roomsResponse.payload?.data ?? []);
const starterRoom = rooms.find((candidate) => candidate?.id === starterRoomId);
if (!starterRoom || typeof starterRoom.name !== "string" || !starterRoom.name.trim()) {
  throw new Error("Could not resolve the Getting Started room name required by the room update contract.");
}

await request(`/api/rooms/${encodeURIComponent(starterRoomId)}`, {
  method: "PATCH",
  cookie,
  csrf,
  csrfHeader,
  body: { name: starterRoom.name, projectPath: root }
});
console.log("[dev-stack-verify] PASS starter room points at the source checkout");

const panesResponse = await request(`/api/panes?roomId=${encodeURIComponent(starterRoomId)}`, { cookie });
const payload = panesResponse.payload;
const panes = Array.isArray(payload) ? payload : (payload?.data ?? payload?.panes ?? []);
const pane = panes.find((candidate) => candidate?.terminalRuntimeId === "cli:opencode" || (candidate?.mode === "TERMINAL" && /OpenCode/i.test(candidate?.title || "")));
if (!pane?.id) throw new Error("Getting Started does not contain an OpenCode terminal pane.");

const started = await request(`/api/panes/${encodeURIComponent(pane.id)}/cli/session`, {
  method: "POST",
  cookie,
  csrf,
  csrfHeader,
  body: { runtimeId: "cli:opencode" }
});
console.log(`[dev-stack-verify] OpenCode start returned status=${started.payload?.session?.status ?? started.payload?.status ?? "unknown"}`);

const sessionView = await request(`/api/panes/${encodeURIComponent(pane.id)}/cli/session`, { cookie });
const sessionId = sessionView.payload?.session?.sessionId ?? started.payload?.session?.sessionId;
const ticket = sessionView.payload?.websocket?.token;
if (typeof sessionId !== "string" || !sessionId || typeof ticket !== "string" || !ticket) {
  throw new Error("OpenCode session did not expose the one-time terminal WebSocket ticket required to attach the UI transport.");
}

const wsUrl = `${api.replace(/^http/, "ws")}/api/panes/${encodeURIComponent(pane.id)}/cli/terminal` +
  `?sessionId=${encodeURIComponent(sessionId)}&token=${encodeURIComponent(ticket)}` +
  `&clientId=${encodeURIComponent(randomUUID())}&initialCols=120&initialRows=32`;
let terminalOutput = "";
let socketError = null;
let socketClosed = null;
const socket = new WebSocket(wsUrl, { headers: { cookie } });
socket.on("message", (data) => {
  let message = null;
  try { message = JSON.parse(data.toString()); } catch { return; }
  if (message?.type === "error") {
    socketError = new Error(`OpenCode terminal server error: ${message.message || message.code || "unknown error"}`);
    return;
  }
  if (message?.type !== "output" || typeof message.data !== "string" || message.data.length === 0) return;
  if (terminalOutput.length < 200_000) terminalOutput += message.data.slice(0, 200_000 - terminalOutput.length);
});
socket.on("error", (error) => { socketError = error; });
socket.on("close", (code, reason) => {
  socketClosed = `code=${code}${reason?.length ? ` reason=${reason.toString()}` : ""}`;
});

await new Promise((resolvePromise, rejectPromise) => {
  socket.once("open", resolvePromise);
  socket.once("error", rejectPromise);
});
console.log(`[dev-stack-verify] terminal transport attached session=${sessionId}`);

let session = null;
const deadline = Date.now() + cliTimeoutMs;
try {
  while (Date.now() < deadline) {
    const current = await request(`/api/panes/${encodeURIComponent(pane.id)}/cli/session`, { cookie });
    session = current.payload?.session ?? current.payload;
    if (failedCliStatuses.has(session?.status)) {
      throw new Error(`OpenCode pane entered ${session.status}: ${session.statusReason || "no reason"}`);
    }
    if (activeCliStatuses.has(session?.status) && terminalOutput.length > 0) break;
    if (socketError) throw new Error(`OpenCode terminal WebSocket failed: ${socketError.message}`);
    if (socketClosed) throw new Error(`OpenCode terminal WebSocket closed before activation (${socketClosed}).`);
    await sleep(500);
  }

  if (!session || !activeCliStatuses.has(session.status)) {
    throw new Error(`OpenCode pane did not become active within ${cliTimeoutMs}ms; last status=${session?.status ?? "missing"}.`);
  }
  if (terminalOutput.length === 0) {
    throw new Error(`OpenCode pane reached ${session.status} but emitted no terminal output within ${cliTimeoutMs}ms.`);
  }
  console.log(`[dev-stack-verify] PASS OpenCode pane active status=${session.status} terminalBytes=${terminalOutput.length}`);
} finally {
  try { socket.close(); } catch {}
}

const finalReady = await request("/readyz");
if (finalReady.payload?.ok !== true) throw new Error("Stack lost readiness after starting OpenCode.");
console.log("[dev-stack-verify] PASS source-stack acceptance");
