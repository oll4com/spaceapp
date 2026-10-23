#!/usr/bin/env node
// Real Docker/Postgres/Temporal/API/PTY acceptance. Never falls back to a mock.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { once } from "node:events";
import { createInterface } from "node:readline";
import WebSocket from "ws";
import { configuration } from "./dev-stack/config.mjs";
import { redact } from "./dev-stack/processes.mjs";

const root = await realpath(join(dirname(fileURLToPath(import.meta.url)), ".."));
const config = configuration(root);
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error("Run npm run smoke:dev-stack.");
try {
  await readFile(join(config.state, "owner.json"));
  throw new Error("smoke:dev-stack requires a fresh checkout with no .dev-stack state; it creates and destroys its own data.");
} catch (error) { if (error.code !== "ENOENT") throw error; }

const api = `http://127.0.0.1:${config.ports.api}`;
let cookie = "";
let csrf = {};
let socket;
let output = "";
let childExit;
let stopping = false;
const child = spawn(process.execPath, [npmCli, "run", "dev:stack"], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
const ended = new Promise(resolve => child.on("exit", (code) => { childExit = code; resolve(); }));
child.stdout.on("data", data => { output = (output + data).slice(-2_000_000); });
child.stderr.on("data", data => { output = (output + data).slice(-2_000_000); });
for (const stream of [child.stdout, child.stderr]) {
  createInterface({ input: stream }).on("line", line => {
    // Forward only fixed launcher milestones; raw service logs remain buffered/redacted.
    if (line.startsWith("[dev:stack] ")) console.log(line);
  });
}
child.on("error", error => { output += error.message; childExit = 1; });

async function until(check, description, timeout = 90_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (childExit !== undefined && !stopping) throw new Error(`Stack exited (${childExit}) while waiting for ${description}.`);
    if (await check()) return;
    await delay(500);
  }
  throw new Error(`Timed out waiting for ${description}.`);
}

async function request(path, body, anonymous = false) {
  const response = await fetch(`${api}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      "content-type": "application/json", origin: api,
      ...(!anonymous && cookie ? { cookie, ...csrf } : {})
    },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30_000)
  });
  if (!response.ok) throw new Error(`${path} returned ${response.status}: ${(await response.text()).slice(0, 500)}`);
  const setCookie = response.headers.getSetCookie();
  if (setCookie.length) cookie = setCookie.map(c => c.split(";")[0]).filter(c => !c.endsWith("=")).join("; ");
  return response.json();
}

function docker(args) {
  return execFileSync("docker", args, { cwd: root, encoding: "utf8", timeout: 60_000 }).trim();
}

let secrets = [];
let failure;
try {
  await until(async () => {
    try { const r = await fetch(`http://127.0.0.1:${config.ports.web}/readyz`, { signal: AbortSignal.timeout(2000) }); return r.ok && (await r.json()).ok === true; }
    catch { return false; }
  }, "real web/API/database/worker readiness", 15 * 60_000);
  const readiness = await request("/readyz", undefined, true);
  assert.equal(readiness.dependencies.database, "RUNNING");
  assert.equal(readiness.dependencies.worker, "RUNNING");
  assert.equal(readiness.dependencies.temporal, "enabled");
  const setupToken = await readFile(join(config.state, "secrets", "setup-token"), "utf8");
  secrets = await Promise.all(["setup-token", "session-secret", "postgres-password", "control-token"].map(n => readFile(join(config.state, "secrets", n), "utf8")));
  assert.equal((await request("/api/setup/status", undefined, true)).setupRequired, true);
  const credentials = { email: "dev-stack@example.invalid", password: randomBytes(24).toString("hex") };
  secrets.push(credentials.password);
  const owner = await request("/api/setup/claim", { token: setupToken, ...credentials }, true);
  assert.equal(owner.isAuthenticated, true);
  assert.notEqual(owner.user.id, "user:dev-operator");
  assert.equal((await request("/api/auth/login", credentials, true)).isAuthenticated, true);
  const csrfInfo = await request("/api/auth/csrf");
  csrf = { [csrfInfo.headerName]: csrfInfo.csrfToken };
  const starter = await request("/api/setup/starter-room", {});
  assert.equal(starter.room.name, "Getting Started");
  const pane = await request("/api/panes", { roomId: starter.room.id, title: "OpenCode acceptance", mode: "TERMINAL", terminalRuntimeId: "cli:opencode" });
  const session = await request(`/api/panes/${encodeURIComponent(pane.id)}/cli/session`, { runtimeId: "cli:opencode" });
  assert.ok(session.websocket?.token);
  const query = new URLSearchParams({ sessionId: session.session.sessionId, token: session.websocket.token, clientId: randomUUID(), initialCols: "100", initialRows: "30" });
  socket = new WebSocket(`${api.replace("http:", "ws:")}/api/panes/${encodeURIComponent(pane.id)}/cli/terminal?${query}`, { headers: { cookie, origin: api } });
  let terminal = "";
  let terminalError;
  socket.on("message", data => {
    try {
      const message = JSON.parse(data.toString());
      if (message.type === "output") terminal = (terminal + message.data).slice(-1_000_000);
      if (message.type === "error") terminalError = new Error(message.message);
    } catch (error) { terminalError = error; }
  });
  socket.on("error", error => { terminalError = error; });
  await once(socket, "open", { signal: AbortSignal.timeout(30_000) });
  await until(async () => {
    if (terminalError) throw terminalError;
    const current = await request(`/api/panes/${encodeURIComponent(pane.id)}/cli/session`);
    if (["EXITED", "ERROR"].includes(current?.session?.status)) throw new Error("OpenCode terminated before TUI acceptance.");
    return current?.session?.status === "RUNNING" && /opencode/i.test(terminal);
  }, "a RUNNING OpenCode PTY with TUI output");
  console.log("PASS: normal owner claim/login, Getting Started room, real OpenCode terminal.");
  const pids = JSON.parse(await readFile(join(config.state, "processes.json"), "utf8"));
  socket.close(); socket = undefined;
  stopping = true;
  // reset must stop a running supervisor, not merely delete its data.
  execFileSync(process.execPath, [npmCli, "run", "dev:stack", "--", "reset"], { cwd: root, stdio: "pipe", timeout: 90_000 });
  await until(async () => childExit !== undefined, "supervisor exit after reset", 10_000);
  assert.equal(childExit, 0);
  for (const { name, pid } of pids) {
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" }, `${name} leaked its process`);
    assert.throws(() => process.kill(-pid, 0), { code: "ESRCH" }, `${name} leaked a child process group`);
  }
  const filter = `label=com.docker.compose.project=${config.project}`;
  assert.equal(docker(["ps", "--all", "--quiet", "--filter", filter]), "");
  assert.equal(docker(["volume", "ls", "--quiet", "--filter", filter]), "");
  console.log("PASS: reset removed every dev-stack container, volume and source process.");
} catch (error) {
  // Setup tokens are deliberately printed by the interactive launcher. Never echo them in CI.
  console.error(redact(output, secrets).replace(/One-time owner setup token: \S+/g, "One-time owner setup token: [REDACTED]"));
  failure = error;
} finally {
  socket?.terminate();
  stopping = true;
  // A failed launcher can already have exited while retaining its Docker volume
  // and private state. Cleanup must not depend on the launcher still being alive.
  const stateExists = await lstat(config.state).then(() => true, error => {
    if (error.code === "ENOENT") return false;
    throw error;
  });
  if (stateExists) {
    try { execFileSync(process.execPath, [npmCli, "run", "dev:stack", "--", "reset"], { cwd: root, stdio: "pipe", timeout: 90_000 }); }
    catch {
      if (childExit === undefined) child.kill("SIGTERM");
      const cleanupError = new Error("Dev-stack cleanup failed; inspect this checkout's .dev-stack state and Docker resources.");
      console.error(cleanupError.message);
      failure ??= cleanupError;
    }
  }
  if (childExit === undefined) {
    if (!stateExists) child.kill("SIGTERM");
    await Promise.race([ended, delay(10_000)]);
  }
}
if (failure) throw failure;
