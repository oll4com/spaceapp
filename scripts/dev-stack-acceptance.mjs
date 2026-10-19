import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { lstat, readFile, utimes, writeFile } from "node:fs/promises";
import net from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { devStackConfig } from "./dev-stack-config.mjs";
import WebSocket from "ws";

const root = fileURLToPath(new URL("../", import.meta.url));
const config = devStackConfig(root, process.env);
try { await lstat(config.state); throw new Error("Acceptance requires a fresh dev-stack state directory; existing state was preserved."); }
catch (error) { if (error.code !== "ENOENT") throw error; }
const child = spawn(process.execPath, ["scripts/dev-stack.mjs"], { cwd: root, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
let log = "", exited = false;
let pendingOutput = "";
for (const stream of [child.stdout, child.stderr]) stream.on("data", chunk => {
  log += chunk.toString(); if (log.length > 2_000_000) log = log.slice(-1_000_000);
  pendingOutput += chunk.toString();
  let newline;
  while ((newline = pendingOutput.indexOf("\n")) >= 0) {
    const line = pendingOutput.slice(0, newline); pendingOutput = pendingOutput.slice(newline + 1);
    // Services already redact their generated secrets. Never echo the owner's
    // one-time token or the Actions masking directive into acceptance evidence.
    if (!line.includes("One-time owner setup token:") && !line.startsWith("::add-mask::")) console.log(line);
  }
});
child.on("exit", () => { exited = true; });
const api = `http://127.0.0.1:${config.ports.api}`;
const web = `http://127.0.0.1:${config.ports.web}`;
let cookie = "", csrf;
async function request(path, body) {
  const response = await fetch(api + path, {
    method: body ? "POST" : "GET", signal: AbortSignal.timeout(30_000),
    headers: { ...(cookie ? { cookie } : {}), ...(body ? { "Content-Type": "application/json", ...(csrf ? { [csrf.headerName]: csrf.csrfToken } : {}) } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  const result = await response.json();
  assert.ok(response.ok, `${path}: HTTP ${response.status} ${result.error?.code ?? ""}`);
  const cookies = response.headers.getSetCookie();
  if (cookies.length) cookie = cookies.map(value => value.split(";")[0]).join("; ");
  return result;
}
function run(args, { capture = false } = {}) {
  return new Promise((resolve, reject) => {
    const commandChild = spawn(args[0], args.slice(1), { cwd: root, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    let output = ""; commandChild.stdout.on("data", chunk => { output += chunk; }); commandChild.stderr.on("data", () => {});
    commandChild.on("error", reject); commandChild.on("close", code => code === 0 ? resolve(capture ? output : undefined) : reject(new Error(`${args[0]} ${args[1]} exited ${code}`)));
  });
}
let failure, terminal;
try {
  for (let attempt = 0; attempt < 600; attempt++) {
    if (exited) throw new Error(`Dev-stack startup exited. ${log.slice(-5000).replace(/One-time owner setup token: .*/g, "[setup token omitted]")}`);
    try { if ((await request("/readyz")).ok && log.includes("Dev stack ready:")) break; } catch { /* Wait for build and services. */ }
    if (attempt === 599) throw new Error("Dev-stack readiness timed out.");
    await delay(1000);
  }
  for (const name of ["postgres-password", "session-secret", "setup-token", "control-token", "database-url", "temporal.env"]) {
    assert.equal((await lstat(join(config.state, "secrets", name))).mode & 0o777, 0o600);
  }
  const status = await request("/api/setup/status"); assert.equal(status.setupRequired, true);
  const token = (await readFile(join(config.state, "secrets/setup-token"), "utf8")).trim();
  const owner = await request("/api/setup/claim", { token, email: "dev-owner@example.invalid", password: randomBytes(24).toString("hex") });
  assert.equal(owner.isAuthenticated, true);
  assert.ok(cookie.startsWith(`space_session_dev_${config.id}=`), "Each checkout has a distinct host-wide session cookie");
  assert.equal((await request("/api/auth/me")).isAuthenticated, true);
  csrf = await request("/api/auth/csrf");
  const panes = await request(`/api/panes?roomId=${encodeURIComponent(owner.starterRoomId)}`);
  const pane = panes.data.find(value => value.terminalRuntimeId === "cli:opencode");
  assert.ok(pane, "Getting Started has an OpenCode pane");
  let session = await request(`/api/panes/${encodeURIComponent(pane.id)}/cli/session`, { runtimeId: "cli:opencode", includeTranscript: true });
  let text = "", terminalError;
  const ticket = session.websocket;
  assert.ok(ticket, "CLI session supplies a terminal ticket");
  terminal = new WebSocket(`${web.replace(/^http/, "ws")}/api/panes/${encodeURIComponent(pane.id)}/cli/terminal?sessionId=${encodeURIComponent(ticket.sessionId)}&token=${encodeURIComponent(ticket.token)}`, { headers: { cookie, origin: web } });
  terminal.on("error", error => { terminalError = error; });
  terminal.on("message", raw => {
    const message = JSON.parse(String(raw));
    if (message.type === "output") text += message.data;
    if (message.type === "error") terminalError = new Error(`Terminal error: ${message.code ?? "unknown"} ${message.message ?? ""}`);
  });
  for (let attempt = 0; attempt < 45; attempt++) {
    if (terminalError) throw terminalError;
    session = await request(`/api/panes/${encodeURIComponent(pane.id)}/cli/session`);
    if (session.session.status === "RUNNING" && text.length > 400 && /opencode|ask anything|ctrl\+p/i.test(text)) break;
    await delay(1000);
  }
  assert.equal(session.session.status, "RUNNING");
  assert.ok(text.length > 400 && /opencode|ask anything|ctrl\+p/i.test(text), "Native OpenCode terminal UI was observed");
  assert.equal((await request("/readyz")).ok, true);
  const apiSource = join(root, "apps/api/src/server.ts"), oldTimes = await lstat(apiSource);
  const beforeReload = log.length;
  try {
    await utimes(apiSource, new Date(), new Date());
    for (let attempt = 0; attempt < 30 && !log.slice(beforeReload).includes("Restarting"); attempt++) await delay(500);
    assert.ok(log.slice(beforeReload).includes("Restarting"), "API watch mode observed a source change");
    await delay(1000);
    for (let attempt = 0; attempt < 60; attempt++) {
      try { if ((await request("/readyz")).ok) break; } catch { /* Watch restart. */ }
      if (attempt === 59) throw new Error("API did not recover after a watched source change");
      await delay(500);
    }
    assert.equal((await request("/api/auth/me")).isAuthenticated, true);
  } finally { await utimes(apiSource, oldTimes.atime, oldTimes.mtime); }
  terminal.terminate(); terminal = undefined;
  const workerPid = Number(/\[dev-stack\] worker supervisor PID (\d+)/.exec(log)?.[1]);
  assert.ok(Number.isSafeInteger(workerPid) && workerPid > 1);
  process.kill(workerPid, "SIGTERM");
  for (let attempt = 0; attempt < 60 && !exited; attempt++) await delay(500);
  assert.ok(exited && log.includes("worker stopped unexpectedly"), "Service failure is reported and stops the supervisor");
  // Simulate a stale record whose PID now belongs to this still-running test.
  // Cleanup must distinguish its birth identity and never signal that process.
  const runningFile = join(config.state, "running.json");
  await writeFile(runningFile, JSON.stringify({ pid: process.pid, identity: "previous supervisor process", project: config.project }), { flag: "wx", mode: 0o600 });
  await run([process.execPath, "scripts/dev-stack.mjs", "down"]);
  await assert.rejects(lstat(runningFile), { code: "ENOENT" });
  console.log(JSON.stringify({ mode: "SOURCE_STACK", platform: process.platform, ownerSetup: true, workflowsReady: true, openCodeTerminal: true, webSocketProxy: true, apiHotReload: true, serviceFailureDetected: true, stalePidRecovered: true, providerTaskExecuted: false, project: config.project }));
} catch (error) { failure = error; }
finally {
  terminal?.terminate();
  try {
    await run([process.execPath, "scripts/dev-stack.mjs", "down"]);
    await run([process.execPath, "scripts/dev-stack.mjs", "reset"]);
    await assert.rejects(lstat(config.state), { code: "ENOENT" });
    assert.equal((await run(["docker", "ps", "-a", "--filter", `label=com.docker.compose.project=${config.project}`, "--format", "{{.ID}}"], { capture: true })).trim(), "");
    assert.equal((await run(["docker", "volume", "ls", "--filter", `label=com.docker.compose.project=${config.project}`, "--format", "{{.Name}}"], { capture: true })).trim(), "");
    for (const port of Object.values(config.ports)) {
      await new Promise((resolve, reject) => { const socket = net.connect(port, "127.0.0.1"); socket.setTimeout(1000, () => socket.destroy()); socket.on("connect", () => { socket.destroy(); reject(new Error(`Port ${port} still has a listener`)); }); socket.on("error", resolve); socket.on("timeout", resolve); });
    }
    for (const match of log.matchAll(/\[dev-stack\] \w+ supervisor PID (\d+)/g)) {
      assert.throws(() => process.kill(Number(match[1]), 0), { code: "ESRCH" }, "Owned service supervisor stopped");
    }
    console.log(JSON.stringify({ cleaned: true, containers: 0, volumes: 0, listeners: 0 }));
  } catch (error) { failure ??= error; }
}
if (failure) { console.error(failure.message); process.exitCode = 1; }
