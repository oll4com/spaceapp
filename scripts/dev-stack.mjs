#!/usr/bin/env node
import { createServer, createConnection } from "node:net";
import { chmod, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import { assertOwnedState, composeArgs, composeDocument, configuration, openCodePackage, prepareState, sourceEnvironment } from "./dev-stack/config.mjs";
import { Processes, ensureMacNodePtySpawnHelper, redact, startWeb, waitForReady } from "./dev-stack/processes.mjs";

const root = await realpath(join(dirname(fileURLToPath(import.meta.url)), ".."));
const config = configuration(root);
let command = process.argv[2] ?? "up";
if (!["up", "down", "reset", "rebuild"].includes(command) || process.argv.length > 3) {
  throw new Error("Usage: npm run dev:stack -- [up|down|reset|rebuild]");
}
if (process.platform === "win32") throw new Error("Use WSL2; the source stack requires Unix sockets and process groups.");
if (Number(process.versions.node.split(".")[0]) !== 22 || Number(process.versions.node.split(".")[1]) < 12) {
  throw new Error("Use the Node 22 version from .nvmrc (>=22.12 <23).");
}

const packages = ["contracts", "icons", "streaming", "opencode-control", "memory-graph", "browser-host", "cli-host", "codex-app-server", "runtime", "db", "gateway"];
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error("Start with npm run dev:stack, so the same npm installation is used for builds.");
const npmRun = (processes, name, args, options) => processes.run(name, process.execPath, [npmCli, ...args], options);

async function build(processes) {
  for (const name of packages) await npmRun(processes, `build:${name}`, ["run", "build", "-w", `@space/${name}`], { cwd: root });
  // The worker's Temporal bundle requires emitted .js files, even in dev.
  await npmRun(processes, "build:worker", ["run", "build", "-w", "@space/worker"], { cwd: root });
  await npmRun(processes, "build:api", ["run", "build", "-w", "@space/api"], { cwd: root });
}

async function requestDown() {
  await assertOwnedState(config);
  const token = await readFile(join(config.state, "secrets", "control-token"), "utf8");
  return new Promise((resolve, reject) => {
    const socket = createConnection(config.control);
    let response = "";
    socket.setTimeout(60_000, () => socket.destroy(new Error("Dev-stack shutdown timed out.")));
    socket.on("connect", () => socket.end(`${token}\n`));
    socket.on("data", (data) => { response += data; });
    socket.on("end", () => response.trim() === "stopped" ? resolve(true) : reject(new Error("Dev-stack shutdown was not acknowledged.")));
    socket.on("error", (error) => {
      if (["ENOENT", "ECONNREFUSED"].includes(error.code)) resolve(false);
      else reject(error);
    });
  });
}

async function removeStaleControlSocket() {
  // Called only while holding this checkout's lock. Never unlink a live server.
  const stale = await new Promise((resolve, reject) => {
    const socket = createConnection(config.control);
    socket.setTimeout(2000, () => socket.destroy(new Error("Cannot determine whether the control socket is in use.")));
    socket.on("connect", () => { socket.destroy(); reject(new Error("A dev-stack control server is already running.")); });
    socket.on("error", error => {
      if (error.code === "ENOENT") resolve(false);
      else if (error.code === "ECONNREFUSED") resolve(true);
      else reject(error);
    });
  });
  if (stale) await rm(config.control, { force: true });
}

async function prepareOpenCode(processes) {
  const spec = openCodePackage(await readFile(join(root, "Dockerfile"), "utf8"));
  const vendor = join(config.state, "opencode");
  const installed = await readFile(join(vendor, "installed-spec"), "utf8").catch(() => "");
  if (installed !== spec) {
    await npmRun(processes, "install:opencode", ["install", "--prefix", vendor, "--no-audit", "--no-fund", "--save-exact", spec], { cwd: root });
    await writeFile(join(vendor, "installed-spec"), spec);
  }
  const wrapper = `#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
const home = ${JSON.stringify(join(config.state, "providers", "opencode"))};
const binary = ${JSON.stringify(join(vendor, "node_modules", ".bin", "opencode"))};
const args = process.argv.slice(2);
if (args[0] === '--run-inner') args.shift();
if (args[0] === 'credential-status') { console.log('READY'); process.exit(0); }
if (args[0] === 'credential-observation') { console.log('OBSERVATION:dev-stack-opencode'); process.exit(0); }
if (args[0] === 'credential-smoke') { console.error('Provider requests are not part of account-free TUI acceptance.'); process.exit(1); }
const env = { ...process.env, HOME: home, TMPDIR: join(home,'tmp'), OPENCODE_DISABLE_AUTOUPDATE: 'true' };
env.TMP = env.TEMP = env.TMPDIR;
delete env.DBUS_SESSION_BUS_ADDRESS;
delete env.XDG_RUNTIME_DIR;
for (const [key, dir] of Object.entries({ XDG_CONFIG_HOME:'config', XDG_DATA_HOME:'data', XDG_CACHE_HOME:'cache', XDG_STATE_HOME:'state' })) {
  env[key] = join(home,dir); mkdirSync(env[key], { recursive:true, mode:0o700 });
}
mkdirSync(env.TMPDIR, { recursive:true, mode:0o700 });
if (!args.some(arg => ['--help','-h','--version','-v'].includes(arg))) args.push('--standalone');
const child = spawn(binary,args,{ env, stdio:'inherit' });
child.on('error', () => process.exit(1));
child.on('exit', (code) => process.exit(code ?? 1));
`;
  await writeFile(join(config.state, "bin", "opencode-vscode-parity"), wrapper, { mode: 0o700 });
}

async function main() {
  if (command === "rebuild") {
    await requestDown();
    command = "up"; // One command rebuilds and restarts every source service.
  }
  if (command === "down" || command === "reset") {
    try { await assertOwnedState(config); } catch (error) { if (error.code === "ENOENT") { console.log("No dev stack state."); return; } throw error; }
    await requestDown();
    // Never touch a live or stale process lock without a successful shutdown.
    try { await readFile(join(config.state, "lock", "pid")); throw new Error("A startup or stale lock remains; inspect it before cleanup."); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    const processes = new Processes();
    try {
      await processes.run("docker:down", "docker", composeArgs(config, "down", "--remove-orphans", ...(command === "reset" ? ["--volumes"] : [])), { cwd: config.state });
      await removeStaleControlSocket();
      await rm(config.hostSocket, { force: true });
      if (command === "reset") { await assertOwnedState(config); await rm(config.state, { recursive: true }); }
    } finally { await processes.stop(); }
    return;
  }

  // Fail before writing state when Docker is absent or its daemon is unreachable.
  const preflight = new Processes();
  try {
    await preflight.run("docker:preflight", "docker", ["compose", "version"], { cwd: root });
    await preflight.run("docker:daemon", "docker", ["info", "--format", "{{.ServerVersion}}"], { cwd: root });
  } finally { await preflight.stop(); }
  const secrets = await prepareState(config);
  const lock = join(config.state, "lock");
  await mkdir(lock); // An atomic lock prevents two invocations sharing the same state/ports.
  await writeFile(join(lock, "pid"), String(process.pid), { mode: 0o600 });
  const processes = new Processes({ secrets: Object.values(secrets) });
  const controller = new AbortController();
  const signal = AbortSignal.any([controller.signal, processes.abort.signal]);
  const clients = new Set();
  const control = createServer({ allowHalfOpen: true }, (socket) => {
    clients.add(socket);
    socket.setTimeout(3000, () => socket.destroy());
    let input = "";
    socket.on("data", (data) => {
      input += data;
      if (input.length > 128) socket.destroy();
      if (input.includes("\n")) {
        if (input.trim() !== secrets["control-token"]) { socket.end("denied\n"); return; }
        socket.setTimeout(0);
        controller.abort(new Error("Requested shutdown."));
      }
    });
    socket.on("error", () => {});
    socket.on("close", () => clients.delete(socket));
  });
  let composeStarted = false;
  let hostStarted = false;
  let controlListening = false;
  let stopPromise;
  signal.addEventListener("abort", () => { stopPromise ??= processes.stop(); }, { once: true });
  const stop = () => controller.abort(new Error("Requested shutdown."));
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
  let cleanupError;
  try {
    await removeStaleControlSocket();
    control.listen(config.control);
    await once(control, "listening");
    controlListening = true;
    await chmod(config.control, 0o600);
    const template = await readFile(join(root, "packages/run-spaceapp/templates/compose.yml"), "utf8");
    await writeFile(join(config.state, "compose.json"), JSON.stringify(composeDocument(config, template), null, 2), { mode: 0o600 });
    console.log("[dev:stack] Building source packages and installing pinned OpenCode.");
    await build(processes);
    await prepareOpenCode(processes);
    await ensureMacNodePtySpawnHelper(root);
    signal.throwIfAborted();
    composeStarted = true;
    console.log("[dev:stack] Starting PostgreSQL and Temporal.");
    await processes.run("docker:up", "docker", composeArgs(config, "up", "--detach", "--wait", "--wait-timeout", "240"), { cwd: config.state });
    await processes.run("temporal:namespace", "docker", composeArgs(config, "exec", "-T", "temporal", "sh", "-ec",
      "temporal operator namespace describe --namespace spaceapp-dev --address temporal:7233 >/dev/null 2>&1 || temporal operator namespace create --namespace spaceapp-dev --address temporal:7233"), { cwd: config.state });
    console.log("[dev:stack] Applying migrations and starting source services.");
    const env = sourceEnvironment(config, secrets);
    await mkdir(env.TMPDIR, { recursive: true, mode: 0o700 });
    await processes.run("migrate", process.execPath, ["packages/db/dist/migrate.js"], { cwd: root, env });
    signal.throwIfAborted();
    processes.start("cli-host", process.execPath, ["packages/cli-host/dist/main.js"], { cwd: root, env }, true);
    hostStarted = true;
    processes.start("worker", process.execPath, ["apps/worker/dist/worker.js"], { cwd: root, env }, true);
    processes.start("api", process.execPath, ["node_modules/tsx/dist/cli.mjs", "watch", "apps/api/src/server.ts"], { cwd: root, env }, true);
    startWeb(processes, root, env);
    await writeFile(join(config.state, "processes.json"), JSON.stringify([...processes.children].filter(r => !r.exited).map(r => ({ name: r.name, pid: r.child.pid }))), { mode: 0o600 });
    console.log("[dev:stack] Waiting for database, worker and CLI-host readiness.");
    await waitForReady(`http://127.0.0.1:${config.ports.web}/readyz`, signal);
    console.log(`\nSpaceApp: http://127.0.0.1:${config.ports.web}\nOne-time owner setup token: ${secrets["setup-token"]}\nOptional browser/companion services are disabled. Ctrl+C or npm run dev:stack -- down stops this stack.`);
    await new Promise((resolve) => { if (signal.aborted) resolve(); else signal.addEventListener("abort", resolve, { once: true }); });
    if (processes.abort.signal.aborted) throw processes.abort.signal.reason;
  } finally {
    await stopPromise;
    await processes.stop();
    if (composeStarted) {
      const cleanup = new Processes({ secrets: Object.values(secrets) });
      if (!controller.signal.aborted) {
        // Preserve useful startup diagnostics before removing failed containers.
        await cleanup.run("docker:diagnostics", "docker", composeArgs(config, "logs", "--no-color", "--tail", "100"), { cwd: config.state }).catch(() => {});
      }
      try { await cleanup.run("docker:down", "docker", composeArgs(config, "down", "--remove-orphans"), { cwd: config.state }); }
      catch (error) { cleanupError = error; }
      finally { await cleanup.stop(); }
    }
    if (controlListening) { control.close(); await rm(config.control, { force: true }); }
    if (hostStarted) await rm(config.hostSocket, { force: true });
    await rm(lock, { recursive: true, force: true });
    await rm(join(config.state, "processes.json"), { force: true });
    for (const socket of clients) socket.end(cleanupError ? "cleanup failed\n" : "stopped\n");
    process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop);
  }
  if (cleanupError) throw cleanupError;
}

main().catch((error) => {
  console.error(`dev:stack failed: ${redact(error.message, [])}`);
  process.exitCode = 1;
});
