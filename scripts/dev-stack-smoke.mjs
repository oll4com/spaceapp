#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { access, readFile, realpath, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { WebSocket } from "ws";
import { loadConfig } from "./dev-stack-config.mjs";

const execute = promisify(execFile);
const checkout = dirname(dirname(fileURLToPath(import.meta.url)));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

export function assertReady(body) {
  assert.equal(body?.ok, true, "API is not ready");
  assert.equal(body.dependencies?.worker, "RUNNING", "Temporal worker must be enabled and running");
  assert.equal(body.dependencies?.cliHost, "RUNNING", "CLI host must be running");
}

export function observeTerminal(url, { cookie, paneId, sessionId, timeoutMs = 90_000 }) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { headers: { cookie }, handshakeTimeout: 15_000 });
    let ready = false, running = false, stdoutBytes = 0, finished = false;
    const timer = setTimeout(() => fail(new Error("OpenCode terminal did not become ready with live stdout")), timeoutMs);
    function fail(error) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      socket.terminate();
      reject(error);
    }
    socket.on("error", () => fail(new Error("OpenCode terminal connection failed")));
    socket.on("close", () => fail(new Error("OpenCode terminal closed before acceptance")));
    socket.on("message", raw => {
      if (finished) return;
      try {
        const frame = JSON.parse(String(raw));
        if (frame.type === "error") throw new Error(`OpenCode terminal error: ${frame.code}`);
        if (frame.type === "ready") {
          assert.equal(frame.paneId, paneId, "Unexpected terminal pane identity");
          assert.equal(frame.sessionId, sessionId, "Unexpected terminal session identity");
          assert.equal(frame.runtimeId, "cli:opencode", "Unexpected terminal runtime identity");
          ready = true;
        }
        if (frame.type === "status") {
          if (["ERROR", "EXITED"].includes(frame.status)) throw new Error(`OpenCode terminal ${frame.status}`);
          running = frame.status === "RUNNING";
        }
        if (frame.type === "output" && frame.stream === "stdout" && typeof frame.data === "string" && frame.data.trim()) {
          stdoutBytes += Buffer.byteLength(frame.data);
        }
        if (ready && running && stdoutBytes > 0) {
          finished = true;
          clearTimeout(timer);
          resolve({ socket, stdoutBytes });
        }
      } catch (error) { fail(error); }
    });
  });
}

async function ownedProcessIds(config) {
  const runtime = JSON.parse(await readFile(join(config.state, "runtime.json"), "utf8"));
  const roots = [runtime.supervisorPid, ...Object.values(runtime.services ?? {})];
  assert(roots.every(pid => Number.isInteger(pid) && pid > 1), "Invalid owned process metadata");
  const { stdout } = await execute("ps", ["-eo", "pid=,ppid="]);
  const pairs = stdout.trim().split("\n").map(line => line.trim().split(/\s+/).map(Number));
  const pids = new Set(roots);
  let previous;
  do {
    previous = pids.size;
    for (const [pid, parent] of pairs) if (pids.has(parent)) pids.add(pid);
  } while (previous !== pids.size);
  return [...pids];
}

export async function exerciseDevStack({ root = checkout, reportPath, timeoutMs = 15 * 60_000 }) {
  assert(reportPath, "Use --report PATH to retain cleanup evidence outside the state directory");
  let config;
  const deadline = Date.now() + timeoutMs;
  while (!config && Date.now() < deadline) {
    try { config = await loadConfig(root); }
    catch (error) { if (error.code !== "ENOENT") throw error; await delay(250); }
  }
  assert(config, "Dev stack did not initialize its owned state");
  const report = resolve(reportPath);
  assert(report !== config.state && !report.startsWith(`${config.state}/`), "Keep the smoke report outside reset-owned state");
  const api = `http://127.0.0.1:${config.ports.api}`;
  let cookie = "", csrf;
  async function request(path, body) {
    const response = await fetch(`${api}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { ...(cookie ? { cookie } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }), ...(csrf ? { [csrf.headerName]: csrf.csrfToken } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30_000)
    });
    // Never print response bodies, cookies, credentials or WebSocket tickets.
    assert(response.ok, `${path} returned HTTP ${response.status}`);
    const session = response.headers.getSetCookie().find(value => value.startsWith("space_session="));
    if (session) cookie = session.split(";")[0];
    return response.json();
  }
  let ready = false;
  while (!ready && Date.now() < deadline) {
    try { assertReady(await request("/readyz?strict=1")); ready = true; }
    catch { await delay(1000); }
  }
  assert(ready, "Dev stack did not become ready with workflows and CLI host enabled");
  const web = await fetch(`http://127.0.0.1:${config.ports.web}`, { signal: AbortSignal.timeout(10_000) });
  assert(web.ok && (await web.text()).includes('<div id="root">'), "Vite did not serve the application");
  assert.equal((await request("/api/setup/status")).setupRequired, true, "Smoke requires a fresh, unclaimed dev stack");
  const token = (await readFile(join(config.state, "secrets/setup-token"), "utf8")).trim();
  const credentials = { email: "dev-stack-smoke@example.test", password: randomBytes(32).toString("hex") };
  // A local reviewer can inspect the same synthetic owner's UI before reset.
  // This file is private, never logged or included in the evidence report.
  await writeFile(join(config.state, "secrets/smoke-owner.json"), JSON.stringify(credentials), { mode: 0o600, flag: "wx" });
  const claimed = await request("/api/setup/claim", { token, ...credentials });
  assert.equal(claimed.isAuthenticated, true, "Owner claim did not authenticate");
  assert.equal(claimed.user?.role, "ADMIN", "Owner claim did not create an administrator");
  assert(cookie, "Owner claim did not set a session cookie");
  csrf = await request("/api/auth/csrf");
  await request("/api/auth/logout", {});
  cookie = ""; csrf = undefined;
  assert.equal((await request("/api/auth/login", credentials)).isAuthenticated, true, "Owner could not sign back in");
  csrf = await request("/api/auth/csrf");
  const rooms = await request("/api/rooms");
  const room = rooms.data.find(entry => entry.name === "Getting Started");
  assert(room, "Getting Started room was not created");
  const panes = await request(`/api/panes?roomId=${encodeURIComponent(room.id)}`);
  const pane = panes.data.find(entry => entry.terminalRuntimeId === "cli:opencode");
  assert(pane, "Getting Started has no OpenCode pane");
  const opened = await request(`/api/panes/${encodeURIComponent(pane.id)}/cli/session`, { runtimeId: "cli:opencode", includeTranscript: false });
  assert(opened.websocket?.token, "OpenCode session has no terminal ticket");
  const query = new URLSearchParams({
    sessionId: opened.session.sessionId, token: opened.websocket.token,
    protocolVersion: "2", browserClientId: randomUUID(), tabLineageId: randomUUID(), pageClientId: randomUUID(),
    clientMode: "INTERACTIVE", initialCols: "100", initialRows: "30"
  });
  const observed = await observeTerminal(`${api.replace(/^http/, "ws")}/api/panes/${encodeURIComponent(pane.id)}/cli/terminal?${query}`, {
    cookie, paneId: pane.id, sessionId: opened.session.sessionId
  });
  try {
    const running = await request(`/api/panes/${encodeURIComponent(pane.id)}/cli/session`, { runtimeId: "cli:opencode", includeTranscript: false });
    assert.equal(running.session.sessionId, opened.session.sessionId, "Starting proof unexpectedly replaced the CLI session");
    assert.equal(running.session.status, "RUNNING", "CLI session is not running");
    assertReady(await request("/readyz?strict=1"));
    const evidence = { ...config, processIds: await ownedProcessIds(config), roomId: room.id, paneId: pane.id, sessionId: opened.session.sessionId, stdoutBytes: observed.stdoutBytes, ownerLogin: true, workerRunning: true, cliRunning: true };
    await writeFile(report, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
    return { passed: true, ownerLogin: true, workerRunning: true, cliRunning: true, stdoutBytes: observed.stdoutBytes };
  } finally { observed.socket.close(); }
}

async function portOpen(port) {
  return new Promise(resolve => {
    const socket = createConnection({ host: "127.0.0.1", port });
    const finish = open => { socket.destroy(); resolve(open); };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.setTimeout(1000, () => finish(false));
  });
}

export async function verifyCleanup(reportPath, root = checkout) {
  const proof = JSON.parse(await readFile(reportPath, "utf8"));
  assert.equal(proof.root, await realpath(root), "Cleanup report belongs to another checkout");
  assert.equal(proof.state, join(proof.root, ".dev-stack"));
  assert.match(proof.project, /^spaceapp-dev-[a-f0-9]{12}$/);
  for (const path of [proof.state, proof.socketRoot]) {
    await assert.rejects(access(path), { code: "ENOENT" }, `Reset left owned state: ${path}`);
  }
  for (const pid of proof.processIds) {
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" }, `Reset left owned process ${pid}`);
  }
  for (const port of Object.values(proof.ports)) assert.equal(await portOpen(port), false, `Reset left port ${port} listening`);
  for (const kind of ["container", "volume", "network"]) {
    const { stdout } = await execute("docker", [kind, "ls", ...(kind === "container" ? ["-a"] : []), "-q", "--filter", `label=com.docker.compose.project=${proof.project}`]);
    assert.equal(stdout.trim(), "", `Reset left a dev-stack ${kind}`);
  }
  return { passed: true, cleaned: true };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  try {
    assert(args.length === 2 && ["--report", "--verify-cleanup"].includes(args[0]), "Usage: node scripts/dev-stack-smoke.mjs --report FILE | --verify-cleanup FILE");
    const result = args[0] === "--report" ? await exerciseDevStack({ reportPath: args[1] }) : await verifyCleanup(args[1]);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`Dev-stack smoke failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}
