#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { chmod, lstat, readFile, realpath, rm } from "node:fs/promises";
import net from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { acquireLock } from "./dev-stack/lock.mjs";
import { createState, readState, removeState, privateWrite, secretNames } from "./dev-stack/state.mjs";
import { applicationEnv, composeConfig, openCodePin, writeWrapper } from "./dev-stack/config.mjs";
import { Processes, assertPortsFree, requestControl, waitFor } from "./dev-stack/processes.mjs";

import { preparePtyHelper } from "./dev-stack/pty.mjs";

process.umask(0o077);
const root = await realpath(join(dirname(fileURLToPath(import.meta.url)), ".."));
const action = process.argv[2] ?? "up";
const node = process.execPath;
if (!/^(up|down|reset|rebuild)$/.test(action) || process.argv.length > 3) throw new Error("Usage: npm run dev:stack -- [up|down|reset|rebuild]");
if (process.platform === "win32") throw new Error("Run the contributor stack inside WSL2.");
const [major, minor] = process.versions.node.split(".").map(Number);
if (major !== 22 || minor < 12) throw new Error("The contributor stack requires Node >=22.12 <23.");

async function main() {
  let acknowledged = false;
  if (action !== "up") {
    const state = await readState(root);
    if (!state) { console.log("No contributor stack exists in this checkout."); return; }
    try { await requestControl(state, action === "reset" ? "down" : action); acknowledged = true; }
    catch (error) {
      if (!["ECONNREFUSED", "ENOENT"].includes(error.code)) throw error;
      if (action === "rebuild") throw new Error("Start dev:stack before rebuilding.", { cause: error });
    }
    if (action === "rebuild") return;
  }
  let lease;
  const deadline = Date.now() + 60_000;
  while (!lease) {
    try { lease = await acquireLock(root); }
    catch (error) {
      if (!acknowledged || error.code !== "EBUSY" || Date.now() >= deadline) throw error;
      await delay(100); // the acknowledged supervisor is finishing its finally block
    }
  }
  // Always observe loss, including during state creation.
  let lockFailure;
  lease.lost.catch((error) => { lockFailure = error; });
  try {
    const state = action === "up" ? await createState(root, process.env) : await readState(root);
    if (lockFailure) throw lockFailure;
    if (state) { await removeLegacyMarker(state); await run(state, lease); }
  } finally { await lease.release(); }
}

async function removeLegacyMarker(state) {
  const marker = join(state.dir, "running");
  let stat;
  try { stat = await lstat(marker); } catch (error) { if (error.code === "ENOENT") return; throw error; }
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Invalid legacy run marker; inspect it manually.");
  let pid;
  try { pid = (await readFile(join(marker, "pid"), "utf8")).trim(); } catch (error) { if (error.code !== "ENOENT") throw error; }
  if (!/^[1-9][0-9]*$/.test(pid ?? "") || !Number.isSafeInteger(Number(pid))) throw new Error("Legacy run marker has no valid PID; inspect it manually before recovery.");
  try { process.kill(Number(pid), 0); }
  catch (error) { if (error.code === "ESRCH") { await rm(marker, { recursive: true }); return; } throw error; }
  throw new Error("Legacy stack PID is still present (possibly reused); stop or inspect it before recovery. No process was killed.");
}

async function run(state, lease) {
  const env = await applicationEnv(state);
  const secrets = await Promise.all(secretNames.map((name) => readFile(join(state.dir, "secrets", name), "utf8")));
  const abort = new AbortController();
  let fatal, stopped;
  const children = new Processes(secrets, (error) => { fatal ??= error; abort.abort(); });
  // Docker alone keeps the caller's context/credential-helper configuration. App children receive only env above.
  const dockerOptions = { cwd: root, env: process.env };
  const composeArgs = ["compose", "--project-name", state.project, "--file", join(state.dir, "compose.json")];
  const compose = (args, timeout) => children.run("docker", "docker", [...composeArgs, ...args], dockerOptions, timeout);
  if (action !== "up") {
    await privateWrite(join(state.dir, "compose.json"), JSON.stringify(await composeConfig(state), null, 2));
    if (action === "reset") { await compose(["down", "--volumes", "--remove-orphans"]); await removeState(state); console.log("Contributor stack reset; owned containers, volume and state removed."); }
    else if (action === "down") { await compose(["stop", "--timeout", "15"]); console.log("Contributor stack stopped."); }
    return;
  }
  let server, readinessTimer;
  async function stop() {
    if (stopped) return stopped;
    stopped = (async () => {
      abort.abort();
      clearInterval(readinessTimer);
      await children.stop();
      const cleanup = new Processes(secrets, () => {});
      await cleanup.run("docker", "docker", [...composeArgs, "stop", "--timeout", "15"], dockerOptions, 60_000);
    })();
    return stopped;
  }
  const onSignal = () => { void stop().catch((error) => { fatal ??= error; }); };
  lease.lost.catch((error) => { fatal ??= error; onSignal(); });
  process.on("SIGINT", onSignal); process.on("SIGTERM", onSignal);
  const options = { cwd: root, env };
  const npm = process.env.npm_execpath;
  if (!npm) throw new Error("Use npm run dev:stack so the selected Node/npm toolchain is explicit.");
  const runNpm = (name, args, timeout) => children.run(name, node, [npm, ...args], options, timeout);
  async function build() {
    for (const name of ["contracts", "icons", "streaming", "opencode-control", "memory-graph", "browser-host", "cli-host", "codex-app-server", "runtime", "db", "gateway", "worker"]) {
      if (abort.signal.aborted) throw new Error("Stack startup cancelled.");
      await runNpm(`build:${name}`, ["run", "build", "-w", `@space/${name}`]);
    }
  }
  let rebuilding = false, runtimeChildren = [];
  const publishReady = () => privateWrite(join(state.dir, "ready.json"), JSON.stringify({ api: env.SPACE_API_ORIGIN, web: `http://127.0.0.1:${state.ports.web}`, project: state.project, pid: process.pid, processPids: { cliHost: runtimeChildren[0].pid, worker: runtimeChildren[1].pid }, managedPids: [...children.children].map((child) => child.pid) }));
  const startCompiled = () => {
    runtimeChildren = [children.start("CLI host", node, ["packages/cli-host/dist/main.js"], options, true),
      children.start("worker", node, ["apps/worker/dist/worker.js"], options, true)];
  };
  try {
    await privateWrite(join(state.dir, "compose.json"), JSON.stringify(await composeConfig(state), null, 2));
    await assertPortsFree(state.ports);
    const controlPath = join(state.sockets, "control.sock");
    try {
      if (!(await lstat(controlPath)).isSocket()) throw new Error("Invalid stack control socket.");
      await rm(controlPath);
    } catch (error) { if (error.code !== "ENOENT") throw error; }
    server = net.createServer((socket) => {
      let data = "";
      socket.setTimeout(300_000, () => socket.destroy());
      socket.on("data", async (chunk) => {
        data += chunk;
        if (data.length > 1024) { socket.destroy(); return; }
        if (!data.endsWith("\n")) return;
        socket.pause();
        try {
          const request = JSON.parse(data);
          if (request.id !== state.id) throw new Error("Wrong stack owner.");
          if (request.action === "down") { await stop(); socket.end('{"ok":true}\n'); }
          else if (request.action === "rebuild") {
            if (rebuilding || !runtimeReady) throw new Error("Stack is starting or already rebuilding.");
            rebuilding = true;
            try { await children.stopChildren(runtimeChildren); await build(); startCompiled(); await waitFor(async () => (await (await fetch(`${env.SPACE_API_ORIGIN}/readyz`, { signal: AbortSignal.timeout(5000) })).json()).ok, "rebuilt runtime", abort.signal); await publishReady(); socket.end('{"ok":true}\n'); } catch (error) { fatal = error; abort.abort(); throw error; } finally { rebuilding = false; }
          } else throw new Error("Unknown stack command.");
        } catch (error) { socket.end(JSON.stringify({ ok: false, error: children.redact(error.message) }) + "\n"); }
      });
    });
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(join(state.sockets, "control.sock"), resolve); });
    await chmod(join(state.sockets, "control.sock"), 0o600);
    await children.run("Docker engine", "docker", ["info"], dockerOptions, 15_000);
    await children.run("Docker Compose", "docker", ["compose", "version"], dockerOptions, 15_000);
    await compose(["up", "--detach", "--wait", "--wait-timeout", "240"], 600_000);
    await build();
    await children.run("migrations", node, ["packages/db/dist/migrate.js"], options);
    const pin = openCodePin(await readFile(join(root, "Dockerfile"), "utf8"));
    let installed;
    try { installed = (await readFile(join(state.dir, "vendor/pin"), "utf8")).trim(); } catch (error) { if (error.code !== "ENOENT") throw error; }
    if (installed !== pin) {
      await runNpm("OpenCode install", ["install", "--prefix", join(state.dir, "vendor"), "--cache", join(state.dir, "npm-cache"), "--prefer-offline", "--no-audit", "--no-fund", "--save-exact", pin], 600_000);
      await privateWrite(join(state.dir, "vendor/pin"), pin);
    }
    await preparePtyHelper(root);
    await writeWrapper(state, env);
    children.start("OpenCode server", join(state.dir, "vendor/node_modules/.bin/opencode"), ["serve", "--hostname", "127.0.0.1", "--port", String(state.ports.opencode)], { cwd: join(state.dir, "workspaces"), env }, true);
    const auth = Buffer.from(`opencode:${env.OPENCODE_SERVER_PASSWORD}`).toString("base64");
    await waitFor(async () => (await fetch(`http://127.0.0.1:${state.ports.opencode}/api/info`, { headers: { Authorization: `Basic ${auth}` }, signal: AbortSignal.timeout(3000) })).ok, "OpenCode server", abort.signal);
    startCompiled();
    children.start("API", node, ["node_modules/tsx/dist/cli.mjs", "watch", "apps/api/src/server.ts"], options, true);
    children.start("Vite", node, [join(root, "node_modules/vite/bin/vite.js"), "--host", "127.0.0.1", "--strictPort"], { cwd: join(root, "apps/web"), env }, true);
    await waitFor(async () => {
      const response = await fetch(`${env.SPACE_API_ORIGIN}/readyz`, { signal: AbortSignal.timeout(5000) });
      return response.ok && (await response.json()).ok === true;
    }, "API/worker readiness", abort.signal);
    await waitFor(async () => (await fetch(`http://127.0.0.1:${state.ports.web}/`, { signal: AbortSignal.timeout(5000) })).ok, "Vite", abort.signal);
    runtimeReady = true;
    let checking = false, failures = 0;
    readinessTimer = setInterval(async () => {
      if (checking || rebuilding || abort.signal.aborted) return;
      checking = true;
      try {
        const response = await fetch(`${env.SPACE_API_ORIGIN}/readyz`, { signal: AbortSignal.timeout(5000) });
        failures = response.ok && (await response.json()).ok ? 0 : failures + 1;
      } catch { failures++; } finally { checking = false; }
      if (failures >= 3) { fatal = new Error("API/dependency readiness failed three consecutive checks."); abort.abort(); }
    }, 5000);
    await publishReady();
    const setup = await (await fetch(`${env.SPACE_API_ORIGIN}/api/setup/status`)).json();
    console.log(`SpaceApp contributor stack ready: http://127.0.0.1:${state.ports.web}`);
    if (setup.setupRequired) console.log(`One-time owner setup token: ${secrets[2]}`);
    console.log("Stop: npm run dev:stack -- down | Remove owned data: npm run dev:stack -- reset");
    if (!abort.signal.aborted) await new Promise((resolve) => abort.signal.addEventListener("abort", resolve, { once: true }));
    if (fatal) throw fatal;
  } catch (error) {
    if (!abort.signal.aborted || fatal) throw fatal ?? error;
  } finally {
    try { await stop(); }
    finally {
      await rm(join(state.dir, "ready.json"), { force: true });
      if (server) await new Promise((resolve) => server.close(resolve));
      process.off("SIGINT", onSignal); process.off("SIGTERM", onSignal);
    }
  }
}
let runtimeReady = false;
try { await main(); } catch (error) { console.error(`dev:stack: ${error.message}`); process.exitCode = 1; }
