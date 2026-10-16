#!/usr/bin/env node
/**
 * ci-gate — the dev stack's end-to-end acceptance gate, over HTTP only.
 *
 * Run against a stack started with `npm run dev:stack`:
 *
 *   node scripts/dev-stack/ci-gate.mjs
 *
 * It waits for /readyz, completes the normal owner setup with the one-time
 * setup token (no dev-login shortcut), signs in with the new owner's
 * credentials, opens the Getting Started room, starts an OpenCode CLI pane
 * through the API and checks that the pane's session is running. Every step
 * prints what it observed; any mismatch exits non-zero with the response
 * body, so a CI transcript shows exactly where the stack fell short.
 *
 * Environment:
 *   DEV_STACK_API_URL     default http://127.0.0.1:5910
 *   DEV_STACK_TOKEN_FILE  default .dev-stack/secrets/setup-token
 *   DEV_STACK_EMAIL       default owner@dev-stack.local
 *   DEV_STACK_PASSWORD    default: generated for this run
 *   DEV_STACK_TIMEOUT_MS  overall readyz wait, default 600000
 */
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

const apiBase = (process.env.DEV_STACK_API_URL ?? "http://127.0.0.1:5910").replace(/\/$/, "");
const tokenFile = process.env.DEV_STACK_TOKEN_FILE ?? ".dev-stack/secrets/setup-token";
const email = process.env.DEV_STACK_EMAIL ?? "owner@dev-stack.local";
const password = process.env.DEV_STACK_PASSWORD ?? `Dev-${randomBytes(12).toString("base64url")}!1`;
const overallTimeoutMs = Number(process.env.DEV_STACK_TIMEOUT_MS ?? 600_000);

const cookies = new Map();
let csrfToken = null;
function cookieHeader() {
  return [...cookies.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
}
function note(message) {
  console.log(`ci-gate: ${message}`);
}
function fail(message, body) {
  console.error(`ci-gate: FAIL ${message}`);
  if (body !== undefined) console.error(typeof body === "string" ? body : JSON.stringify(body, null, 2));
  process.exit(1);
}

async function request(method, path, { body, auth = true } = {}) {
  const response = await fetch(`${apiBase}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(auth && cookies.size > 0 ? { cookie: cookieHeader() } : {}),
      ...(csrfToken && method !== "GET" ? { "x-space-csrf-token": csrfToken } : {})
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000)
  });
  const setCookies = typeof response.headers.getSetCookie === "function" ? response.headers.getSetCookie() : [];
  for (const header of setCookies) {
    const pair = header.split(";")[0];
    const eq = pair.indexOf("=");
    if (eq <= 0) continue;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (value === "" || /expires=Thu, 01 Jan 1970/i.test(header)) cookies.delete(name);
    else cookies.set(name, value);
  }
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* leave json null; callers report the raw text */
  }
  return { status: response.status, json, text };
}

async function waitForReadyz() {
  const deadline = Date.now() + overallTimeoutMs;
  let last = "no answer yet";
  while (Date.now() < deadline) {
    try {
      const { status, json } = await request("GET", "/readyz", { auth: false });
      if (status === 200 && json && json.ok === true) {
        note(`/readyz reports ok: true — ${JSON.stringify(json.dependencies ?? {})}`);
        return;
      }
      last = `HTTP ${status}: ${JSON.stringify(json)}`;
    } catch (error) {
      last = String(error.message ?? error);
    }
    await new Promise((r) => setTimeout(r, 3_000));
  }
  fail(`the stack did not become ready within ${overallTimeoutMs}ms (last: ${last})`);
}

async function main() {
  await waitForReadyz();

  const status = await request("GET", "/api/setup/status", { auth: false });
  if (status.status !== 200 || !status.json) fail("GET /api/setup/status did not answer JSON.", status.text);
  note(`setup status before claim: ${JSON.stringify(status.json)}`);
  if (status.json.setupRequired !== true) fail("setup was already claimed before the gate ran — the gate needs a fresh stack.", status.json);

  const token = readFileSync(tokenFile, "utf8").trim();
  const claim = await request("POST", "/api/setup/claim", {
    auth: false,
    body: { token, email, password }
  });
  if (claim.status !== 200 || !claim.json) fail("POST /api/setup/claim failed.", claim.text);
  const starterRoomId = claim.json.starterRoomId;
  note(`owner claimed: user ${claim.json.user?.id ?? "?"}; starter room ${starterRoomId ?? "?"}`);
  if (!starterRoomId) fail("the claim response carried no starterRoomId.", claim.json);
  if (cookies.size === 0) fail("the claim did not set a session cookie.");

  const after = await request("GET", "/api/setup/status", { auth: false });
  if (after.json?.setupRequired !== false) fail("setup still reports setupRequired after a successful claim.", after.json);
  note("setup status after claim: setupRequired=false.");

  // Prove the normal sign-in path with the credentials just created, from a
  // fresh cookie jar (a second browser signing in). Deliberately NOT a
  // logout-then-login: the API's session tokens are deterministic per
  // second (payload {user, iat, exp} at one-second granularity), so a
  // logout in the same second as the claim would revoke the identical
  // token the login then re-issues.
  cookies.clear();
  const login = await request("POST", "/api/auth/login", { auth: false, body: { email, password } });
  if (login.status !== 200 || cookies.size === 0) fail("sign-in with the new owner's credentials failed.", login.text);
  note(`signed in with the new owner's email and password (cookies: ${[...cookies.keys()].join(", ")}).`);

  const csrf = await request("GET", "/api/auth/csrf");
  if (csrf.status !== 200 || !csrf.json?.csrfToken) fail("GET /api/auth/csrf did not issue a token.", csrf.text);
  csrfToken = csrf.json.csrfToken;
  note("CSRF token obtained for mutating requests.");

  const rooms = await request("GET", "/api/rooms");
  if (rooms.status !== 200 || !rooms.json) fail("GET /api/rooms failed.", rooms.text);
  const roomList = rooms.json.data ?? rooms.json.rooms ?? (Array.isArray(rooms.json) ? rooms.json : []);
  const starter = roomList.find((room) => room.id === starterRoomId);
  if (!starter) fail(`the starter room ${starterRoomId} is not in GET /api/rooms.`, roomList);
  note(`room present: "${starter.name}" (${starter.id})`);
  if (starter.name !== "Getting Started") fail(`the starter room is named "${starter.name}", not "Getting Started".`);

  const pane = await request("POST", "/api/panes", {
    body: { roomId: starterRoomId, title: "OpenCode", mode: "TERMINAL", terminalRuntimeId: "cli:opencode" }
  });
  if (pane.status !== 200 || !pane.json?.id) fail("POST /api/panes (TERMINAL, cli:opencode) failed.", pane.text);
  const paneId = pane.json.id;
  note(`pane created: ${paneId}`);

  const session = await request("POST", `/api/panes/${paneId}/cli/session`, {
    body: { runtimeId: "cli:opencode" }
  });
  if (session.status !== 200) fail("POST /api/panes/:id/cli/session (cli:opencode) failed.", session.text);
  note(`CLI session start answered: ${JSON.stringify(session.json).slice(0, 400)}`);

  // Starting a session only allocates it ("waiting for terminal transport
  // attach"): the CLI process spawns when a terminal client attaches, which
  // is what the web UI does over the pane terminal WebSocket. The gate does
  // the same: fetch a one-time WebSocket ticket from the session resource,
  // attach with the session cookie, hold the socket, and watch the session
  // reach RUNNING while real terminal output flows.
  const sessionView = await request("GET", `/api/panes/${paneId}/cli/session`);
  if (sessionView.status !== 200 || !sessionView.json?.websocket?.token) {
    fail("GET /api/panes/:id/cli/session did not issue a WebSocket ticket.", sessionView.text);
  }
  const sessionId = sessionView.json.session?.sessionId ?? session.json.session?.sessionId;
  const ticket = sessionView.json.websocket.token;
  note(`WebSocket ticket obtained for session ${sessionId}; attaching the terminal transport...`);

  const { default: WebSocket } = await import("ws").catch(() => {
    fail("the gate needs the repo's ws package (run npm ci first) to attach the terminal transport.");
    return {};
  });
  const wsUrl =
    `${apiBase.replace(/^http/, "ws")}/api/panes/${paneId}/cli/terminal` +
    `?sessionId=${encodeURIComponent(sessionId)}&token=${encodeURIComponent(ticket)}` +
    `&clientId=${randomUUID()}&initialCols=120&initialRows=32`;
  let terminalOutput = "";
  let wsError = null;
  let wsClosed = null;
  const socket = new WebSocket(wsUrl, { headers: { cookie: cookieHeader() } });
  socket.on("message", (data) => {
    if (terminalOutput.length < 200_000) terminalOutput += data.toString();
  });
  socket.on("error", (error) => {
    wsError = error;
  });
  socket.on("close", (code, reason) => {
    wsClosed = `code ${code}${reason?.length ? ` (${reason.toString()})` : ""}`;
  });
  await new Promise((resolvePromise, rejectPromise) => {
    socket.once("open", resolvePromise);
    socket.once("error", rejectPromise);
  }).catch((error) => fail(`the terminal WebSocket did not open: ${error.message}`));
  note("terminal transport attached; waiting for the session to report RUNNING...");

  const deadline = Date.now() + 180_000;
  let lastSessionJson = null;
  try {
    while (Date.now() < deadline) {
      const current = await request("GET", `/api/panes/${paneId}/cli/session`);
      if (current.status === 200 && current.json) {
        lastSessionJson = current.json.session ?? current.json;
        const status = lastSessionJson.status;
        if (status === "RUNNING") {
          note(`pane session is RUNNING (session ${lastSessionJson.sessionId ?? sessionId}).`);
          note(`terminal output received: ${terminalOutput.length} bytes through the pane WebSocket.`);
          const snippet = terminalOutput.replace(/[\u0000-\u0008\u000b-\u001f]/g, " ").slice(0, 300);
          if (snippet.trim()) note(`terminal output begins: ${snippet}`);
          note("PASS — owner setup, sign-in, Getting Started room and a running OpenCode pane, all over HTTP.");
          return;
        }
        if (status === "ERROR" || status === "EXITED") {
          fail(`the pane's session died with status ${status} (reason: ${lastSessionJson.statusReason ?? "none given"}).`, lastSessionJson);
        }
      }
      if (wsError) fail(`the terminal WebSocket errored while waiting: ${wsError.message}`);
      await new Promise((r) => setTimeout(r, 3_000));
    }
    fail(
      `the pane's session never reached RUNNING. WebSocket: ${wsClosed ? `closed (${wsClosed})` : "still open"}; ` +
        `frames received: ${terminalOutput.length} bytes: ` +
        `${terminalOutput.replace(/[\u0000-\u0008\u000b-\u001f]/g, " ").slice(0, 600) || "(none)"}`,
      lastSessionJson ?? session.json
    );
  } finally {
    try {
      socket.close();
    } catch {
      /* already closed */
    }
  }
}

await main();
