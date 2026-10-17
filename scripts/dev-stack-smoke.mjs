#!/usr/bin/env node
// A disposable integration fixture. Never claims the owner's interactive stack.
import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import net from "node:net";
import { join, dirname } from "node:path";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import WebSocket from "ws";
import { assertDockerRemoved, readyResponse, root } from "./dev-stack.mjs";
import { isSameProcess } from "./dev-stack-processes.mjs";

const execute = promisify(execFile);
const label = `smoke-${process.pid}-${randomBytes(4).toString("hex")}`;
const directory = join(root, `.dev-stack-${label}`);
const env = { ...process.env, SPACE_DEV_STATE_DIR: directory, PATH: `${dirname(process.execPath)}:${process.env.PATH}` };
const ports = new Set();
for (const name of ["API", "WEB", "POSTGRES", "TEMPORAL"]) {
  let port;
  do { port = await new Promise((resolve, reject) => { const server = net.createServer(); server.once("error", reject); server.listen(0, "127.0.0.1", () => { const value = server.address().port; server.close(() => resolve(value)); }); }); }
  while (ports.has(port) || [4910, 4911].includes(port));
  ports.add(port);
  env[`SPACE_DEV_${name}_PORT`] = String(port);
}
const origin = `http://127.0.0.1:${env.SPACE_DEV_WEB_PORT}`;
let output = "", exitCode = null, state, cookie = "", csrf = {}, ws;
const child = spawn("npm", ["run", "dev:stack"], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
child.once("error", (error) => { console.error(error.message); exitCode = 1; });
child.once("exit", (code) => { exitCode = code ?? 1; });
for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk) => {
  output += chunk.toString();
  process.stdout.write(chunk.toString().replace(/(setup token: )[^\r\n]+/gi, "$1[redacted]"));
});
const check = (message) => console.log(`[smoke:dev-stack] PASS ${message}`);
async function until(predicate, label, timeout = 900_000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try { const value = await predicate(); if (value) return value; } catch (error) { last = error; }
    if (exitCode !== null) throw new Error(`Stack exited (${exitCode}) while waiting for ${label}. ${last?.message ?? ""}`);
    await delay(500);
  }
  throw new Error(`Timed out waiting for ${label}. ${last?.message ?? ""}`);
}
async function http(path, method = "GET", body) {
  const response = await fetch(`${origin}${path}`, {
    method, headers: { ...(cookie ? { Cookie: cookie } : {}), Origin: origin, ...(method !== "GET" ? csrf : {}), ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(20_000)
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`${method} ${path} returned ${response.status}: ${text.slice(0, 400)}`);
  }
  return response;
}
async function waitReady() {
  await until(async () => {
    const response = await fetch(`${origin}/readyz`, { signal: AbortSignal.timeout(5000) });
    return response.ok && readyResponse(await response.json());
  }, "PostgreSQL, worker and CLI host readiness");
}
async function command(name) { return execute("npm", ["run", "dev:stack", "--", name], { cwd: root, env, timeout: 900_000 }); }

const originalFiles = new Map();
try {
  await waitReady();
  await until(() => output.includes("Stop: npm run dev:stack -- down"), "startup banner", 30_000);
  state = JSON.parse(readFileSync(join(directory, "manifest.json"), "utf8"));
  await command("verify");
  check("non-TTY dev:stack -> API and Vite /readyz with workflows enabled");
  const setupToken = readFileSync(join(directory, "secrets/setup-token"), "utf8").trim();
  const email = `${label}@example.invalid`, password = randomBytes(24).toString("hex");
  const claimed = await http("/api/setup/claim", "POST", { token: setupToken, email, password });
  assert.equal((await claimed.json()).isAuthenticated, true);
  const login = await http("/api/auth/login", "POST", { email, password });
  cookie = login.headers.getSetCookie().find((entry) => entry.startsWith("space_session_dev="))?.split(";")[0];
  assert.ok(cookie, "isolated dev session cookie after real sign-in");
  const token = await (await http("/api/auth/csrf")).json();
  csrf = { [token.headerName]: token.csrfToken };
  check("setup token -> owner claim -> password sign-in -> dev cookie -> CSRF");
  const starter = await (await http("/api/setup/starter-room", "POST")).json();
  assert.equal(starter.room.name, "Getting Started");
  const panes = await (await http(`/api/panes?roomId=${encodeURIComponent(starter.room.id)}`)).json();
  const pane = panes.data.find((entry) => entry.mode === "TERMINAL" && entry.terminalRuntimeId === "cli:opencode");
  assert.ok(pane, "Getting Started room has its OpenCode pane");
  const session = await (await http(`/api/panes/${pane.id}/cli/session`, "POST", { runtimeId: "cli:opencode" })).json();
  assert.ok(session.websocket?.token);
  let terminal = "", attached = false;
  const url = new URL(`${origin.replace("http:", "ws:")}/api/panes/${pane.id}/cli/terminal`);
  url.search = new URLSearchParams({ token: session.websocket.token, sessionId: session.session.sessionId, initialCols: "120", initialRows: "30" }).toString();
  ws = new WebSocket(url, { headers: { Cookie: cookie, Origin: origin } });
  let socketError;
  ws.on("error", (error) => { socketError = error; });
  ws.on("message", (data) => {
    const message = JSON.parse(data.toString());
    if (message.type === "ready") attached = true;
    if (message.type === "output") terminal += message.data;
    if (message.type === "error") socketError = new Error(message.message);
  });
  await until(async () => {
    if (socketError) throw socketError;
    const current = await (await http(`/api/panes/${pane.id}/cli/session`)).json();
    assert.ok(!["EXITED", "ERROR"].includes(current.session.status), "OpenCode must remain alive");
    return attached && ["RUNNING", "IDLE"].includes(current.session.status) && /opencode|Ask anything|Connect provider|switch agent|ctrl\+/i.test(terminal);
  }, "OpenCode terminal UI through the Vite WebSocket proxy", 90_000);
  check(`OpenCode PTY UI is running, received ${terminal.length} terminal bytes (sha256 ${createHash("sha256").update(terminal).digest("hex")})`);
  ws.close();
  ws = null;

  // Edits are restored in finally, including when compilation or polling fails.
  const apiFile = join(root, "apps/api/src/server.ts");
  originalFiles.set(apiFile, readFileSync(apiFile, "utf8"));
  const marker = `dev-stack-api-watch-${label}`;
  writeFileSync(apiFile, `${originalFiles.get(apiFile)}\nconsole.log(${JSON.stringify(marker)});\n`);
  await until(() => readFileSync(join(directory, "logs/api.log"), "utf8").includes(marker), "API watch restart after source edit", 90_000);
  await waitReady();
  check("API source edit restarts the API and returns to readiness");

  const packageFile = join(root, "packages/contracts/src/index.ts");
  originalFiles.set(packageFile, readFileSync(packageFile, "utf8"));
  const packageMarker = `dev-stack-package-rebuild-${label}`;
  writeFileSync(packageFile, `${originalFiles.get(packageFile)}\nconsole.log(${JSON.stringify(packageMarker)});\n`);
  await command("rebuild");
  assert.ok(readFileSync(join(directory, "logs/api.log"), "utf8").includes(packageMarker));
  assert.equal((await (await http("/api/setup/status")).json()).setupRequired, false);
  check("one rebuild command picks up shared package edits and preserves owner state");

  const before = JSON.parse(readFileSync(join(directory, "manifest.json"), "utf8"));
  const worker = before.processes.find((entry) => entry.name === "worker");
  assert.ok(worker && isSameProcess(worker));
  process.kill(worker.pid, "SIGTERM");
  const deadline = Date.now() + 30_000;
  while (exitCode === null && Date.now() < deadline) await delay(200);
  assert.notEqual(exitCode, null, "worker death must stop the supervisor");
  assert.notEqual(exitCode, 0, "worker death must fail the supervisor");
  assert.match(output, /worker exited unexpectedly/);
  for (const record of before.processes) assert.equal(isSameProcess(record), false, record.name);
  check("worker death is named, exits nonzero and stops sibling processes");
} catch (error) {
  // Keep CI failures diagnosable before the disposable fixture is reset.
  // The supervisor already redacts generated secrets from these child logs.
  for (const service of ["api", "worker", "cli-host", "web"]) {
    const path = join(directory, "logs", `${service}.log`);
    if (existsSync(path)) console.error(`[smoke:dev-stack] ${service} log tail:\n${readFileSync(path, "utf8").split("\n").slice(-30).join("\n").replace(/([?&](?:token|ticket)=)[^&\s]+/gi, "$1[redacted]")}`);
  }
  throw error;
} finally {
  if (ws) ws.terminate();
  for (const [path, text] of originalFiles) writeFileSync(path, text);
  if (existsSync(join(directory, "manifest.json"))) {
    state = JSON.parse(readFileSync(join(directory, "manifest.json"), "utf8"));
    const processes = [...state.processes, ...(state.controller ? [state.controller] : [])];
    await command("reset");
    await assertDockerRemoved(state);
    assert.equal(existsSync(directory), false);
    assert.equal(existsSync(state.runtime), false);
    for (const record of processes) assert.equal(isSameProcess(record), false, "cleanup must stop every recorded process");
    check("reset removed owned containers, networks, volumes, socket directory and processes");
  }
}
