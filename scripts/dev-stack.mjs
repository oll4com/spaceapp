#!/usr/bin/env node
import { execFile } from "node:child_process";
import { chmodSync, existsSync, openSync, closeSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import net from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { composeDefinition, ensureSecrets, initializeState, packageWorkspaces, privateDirectory, privateFile, privateFileStat, readPins, readState, runtimeDirectory, saveState, serviceEnvironment, statePath } from "./dev-stack-state.mjs";
import { isSameProcess, processIdentity, ProcessSupervisor, stopRecords } from "./dev-stack-processes.mjs";

export const root = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), ".."));
const execute = promisify(execFile);
const services = ["cli-host", "worker", "api", "web"];
/**
 * Prefix foreground lifecycle messages so readiness and failures are identifiable in CI transcripts.
 */
const log = (message) => console.log(`[dev:stack] ${message}`);
/**
 * Scope every Compose command to this stack's saved project and private generated definition.
 */
export const composeArgs = (state, args) => ["compose", "--project-directory", state.directory, "-p", state.project, "-f", join(state.directory, "compose.json"), ...args];

/**
 * Send an identity-bound lifecycle request over the private supervisor socket.
 * Reject timeouts, truncated responses and supervisor errors instead of treating silence as success.
 */
export async function requestControl(state, command, timeout = 900_000) {
  return new Promise((resolve, reject) => {
    if (!state?.runtime) return reject(new Error("Stack has no supervisor socket."));
    const socket = net.createConnection(join(state.runtime, "control.sock"));
    let received = "";
    socket.setTimeout(timeout, () => socket.destroy(new Error("Supervisor command timed out.")));
    socket.once("connect", () => socket.write(`${JSON.stringify({ id: state.id, command })}\n`));
    socket.on("data", (chunk) => {
      received += chunk;
      if (received.includes("\n")) {
        socket.end();
        try {
          const response = JSON.parse(received.slice(0, received.indexOf("\n")));
          if (response.error) reject(new Error(response.error)); else resolve(response);
        } catch (error) { reject(error); }
      }
    });
    socket.once("error", reject);
    socket.once("end", () => { if (!received.includes("\n")) reject(new Error("Supervisor closed before responding.")); });
  });
}

/**
 * Require PostgreSQL, enabled Temporal workflows, worker and CLI host in a successful readiness payload.
 */
export function readyResponse(body) {
  return body?.ok === true && body.dependencies?.database === "RUNNING" && body.dependencies?.store === "postgres" && body.dependencies?.temporal === "enabled" && body.dependencies?.worker === "RUNNING" && body.dependencies?.cliHost === "RUNNING";
}

/**
 * Verify full dependency readiness directly through the API and through the Vite proxy.
 */
async function ready(state) {
  for (const port of [state.ports.api, state.ports.web]) {
    const response = await fetch(`http://127.0.0.1:${port}/readyz`, { signal: AbortSignal.timeout(5000) });
    if (!response.ok || !readyResponse(await response.json())) throw new Error(`127.0.0.1:${port}/readyz does not report PostgreSQL, worker and CLI host RUNNING.`);
  }
}

/**
 * Probe every configured loopback binding before startup; report the conflicting service and override.
 */
async function availablePorts(state) {
  for (const [name, port] of Object.entries(state.ports)) await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", () => reject(new Error(`Port ${port} (${name}) is occupied; choose SPACE_DEV_${name.toUpperCase()}_PORT in a new state directory.`)));
    server.listen(port, "127.0.0.1", () => server.close(resolve));
  });
}

/**
 * Prepare private runtime files, seed memory and the isolated OpenCode wrapper.
 * Repair only the local Darwin node-pty helper permission needed to launch a real terminal.
 */
export function prepareFiles(state) {
  // node-pty 1.1.0's published Darwin prebuild can unpack its spawn-helper
  // without an executable bit. Keep the repair limited to this local dependency.
  if (process.platform === "darwin") {
    const helper = join(root, "node_modules/node-pty/prebuilds", `darwin-${process.arch}`, "spawn-helper");
    if (existsSync(helper)) chmodSync(helper, statSync(helper).mode | 0o100);
  }
  // tsx also opens IPC sockets under TMPDIR. A checkout-relative temporary
  // directory can truncate/collide on Linux as well as exceeding macOS limits.
  privateDirectory(state.runtime, "tmp");
  for (const name of ["logs", "bin", "tools", "data/home", "data/memory", "data/workspaces", "data/artifacts", "data/projects", "data/dots", "data/live-voice-logs"]) privateDirectory(state.directory, name);
  for (const [name, legacy] of [["space_memory.md", "gemini_history.md"], ["space_memory_monthly.md", "gemini_history_monthly.md"], ["installation-guide.md", null]]) {
    const destination = join(state.directory, "data/memory", name);
    const previous = legacy && join(state.directory, "data/memory", legacy);
    if (!privateFileStat(destination)) {
      // Upgrade only this stack's old private files; never overwrite edits or read an installed instance.
      privateFile(destination, readFileSync(previous && privateFileStat(previous) ? previous : join(root, "starter-memory", name)));
    } else chmodSync(destination, 0o600);
  }
  /**
   * Quote one executable path as a literal POSIX shell argument, including embedded apostrophes.
   */
  const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
  const wrapper = join(state.directory, "bin/opencode-vscode-parity");
  privateFile(wrapper, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(join(root, "scripts/dev-stack-opencode.mjs"))} ${quote(state.directory)} "$@"\n`, 0o700);
  privateFile(join(state.directory, "compose.json"), `${JSON.stringify(composeDefinition(state), null, 2)}\n`);
}

/**
 * Stop this Compose project, optionally deleting its volumes; retain recovery files on any Docker failure.
 */
async function dockerDown(state, volumes = false) {
  if (!existsSync(join(state.directory, "compose.json"))) throw new Error("Compose recovery file is missing; preserving state.");
  await execute("docker", composeArgs(state, ["down", "--remove-orphans", ...(volumes ? ["--volumes"] : [])]), { timeout: 90_000 });
}

/**
 * Check Docker project labels after cleanup; reject retained containers, networks or requested volumes.
 */
export async function assertDockerRemoved(state, volumes = true) {
  const filter = `label=com.docker.compose.project=${state.project}`;
  for (const args of [["ps", "-aq", "--filter", filter], ["network", "ls", "-q", "--filter", filter], ...(volumes ? [["volume", "ls", "-q", "--filter", filter]] : [])]) {
    const result = await execute("docker", args, { timeout: 15_000 });
    if (result.stdout.trim()) throw new Error(`Docker resources remain for ${state.project}; preserving state.`);
  }
}

/**
 * Ask a live supervisor to stop, or recover saved process trees and containers after a crash.
 * Preserve data and propagate incomplete cleanup so reset cannot erase recovery state.
 */
export async function down(state) {
  if (!state) { log("No dev stack state exists."); return; }
  if (isSameProcess(state.controller)) {
    await requestControl(state, "down");
    for (let i = 0; i < 100 && isSameProcess(state.controller); i++) await delay(100);
    if (isSameProcess(state.controller)) throw new Error("Supervisor did not exit after shutdown; preserving state.");
  } else {
    // Recovery after SIGKILL or a host crash: authenticate saved process identities.
    await stopRecords(state.processes);
    state.processes = [];
    saveState(state);
    if (existsSync(join(state.directory, "compose.json"))) await dockerDown(state);
    rmSync(join(state.directory, "supervisor.lock"), { force: true });
  }
  log("Source processes and containers stopped; data retained.");
}

/**
 * Revalidate ownership, stop services and verify Docker removal before deleting owned state and sockets.
 */
export async function reset(state) {
  if (!state) { log("No dev stack state exists."); return; }
  // Revalidate immediately before any deletion, including the external socket dir.
  readState(root, statePath(root, { SPACE_DEV_STATE_DIR: state.directory }));
  await down(state);
  if (existsSync(join(state.directory, "compose.json"))) await dockerDown(state, true);
  await assertDockerRemoved(state);
  if (state.runtime && existsSync(state.runtime)) {
    runtimeDirectory(state);
    rmSync(state.runtime, { recursive: true });
  }
  rmSync(state.directory, { recursive: true });
  log("Reset verified: no project containers, networks, volumes or managed processes remain.");
}

/**
 * Start the foreground source stack after validating Node, Docker, ownership and available ports.
 * Supervise setup, builds and all services; retain recovery state if shutdown cannot finish.
 */
export async function up(directory) {
  if (process.platform === "win32") throw new Error("Run the source stack inside Windows 11 WSL2, not native Windows.");
  if (Number(process.versions.node.split(".")[0]) !== 22) throw new Error("Use the Node 22 version in .nvmrc, then ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci.");
  if (!existsSync(join(root, "node_modules/tsx/dist/cli.mjs"))) throw new Error("Run ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci first.");
  try {
    await execute("docker", ["compose", "version", "--short"], { timeout: 15_000 });
    await execute("docker", ["info", "--format", "{{.ServerVersion}}"], { timeout: 15_000 });
  } catch { throw new Error("Docker Engine and the Docker Compose plugin are required. Check docker info and docker compose version (Docker Desktop or Colima on macOS)."); }
  const state = initializeState(root, directory);
  state.pins = readPins(root);
  const lockPath = join(directory, "supervisor.lock");
  if (existsSync(lockPath)) {
    const owner = JSON.parse(readFileSync(lockPath, "utf8"));
    if (isSameProcess(owner)) throw new Error("This stack already has a supervisor; use status or down.");
    rmSync(lockPath);
  }
  const lock = openSync(lockPath, "wx", 0o600);
  writeFileSync(lock, JSON.stringify(processIdentity(process.pid)));
  closeSync(lock);
  let supervisor, server, monitor, failure, stopping, rebuilding = false, started = false, cleaned = false;
  const sockets = new Set();
  let finish;
  const finished = new Promise((resolve) => { finish = resolve; });
  /**
   * Serialize shutdown requests, stop managed children and containers, and retain state on cleanup failure.
   */
  const shutdown = (error) => {
    if (stopping) return stopping;
    failure ||= error;
    if (error) console.error(`[dev:stack] ${error.message}`);
    stopping = (async () => {
      clearInterval(monitor);
      try {
        if (supervisor) await supervisor.stop(); else await stopRecords(state.processes);
        if (existsSync(join(directory, "compose.json"))) await dockerDown(state);
        state.processes = [];
        saveState(state);
        cleaned = true;
      } catch (cleanupError) {
        failure ||= cleanupError;
        console.error(`[dev:stack] Cleanup failed: ${cleanupError.message}; recovery state retained. Retry down/reset when Docker is available.`);
      }
      finish();
    })();
    return stopping;
  };
  /**
   * Convert terminal signals into the same serialized cleanup used for child and readiness failures.
   */
  const signalHandler = () => { void shutdown(); };
  process.once("SIGINT", signalHandler);
  process.once("SIGTERM", signalHandler);
  process.once("SIGHUP", signalHandler);
  try {
    await stopRecords(state.processes);
    state.processes = [];
    state.controller = processIdentity(process.pid);
    runtimeDirectory(state);
    const controlPath = join(state.runtime, "control.sock");
    rmSync(controlPath, { force: true });
    const secrets = ensureSecrets(state);
    prepareFiles(state);
    const env = serviceEnvironment(state, secrets);
    supervisor = new ProcessSupervisor(state, secrets, (error) => { void shutdown(error); });
    /**
     * Run supervised build/install tasks with the active Node toolchain ahead of the inherited PATH.
     */
    const runNpm = (name, args) => supervisor.run(name, "npm", args, { env: { ...process.env, PATH: `${dirname(process.execPath)}:${process.env.PATH}` } });
    /**
     * Build workspace dependencies in order and compile the worker, aborting if shutdown has begun.
     */
    const build = async () => {
      log("Building internal packages and the Temporal worker from this checkout...");
      for (const workspace of [...packageWorkspaces, "worker"]) {
        if (stopping) throw new Error("Startup interrupted.");
        await runNpm(`build-${workspace}`, ["run", "build", "-w", `@space/${workspace}`]);
      }
    };
    /**
     * Start CLI host, worker, API watch and Vite, then wait for both direct and proxied readiness.
     */
    const launch = async () => {
      supervisor.start("cli-host", process.execPath, ["packages/cli-host/dist/main.js"], { env });
      supervisor.start("worker", process.execPath, ["apps/worker/dist/worker.js"], { env });
      // tsx watch stays alive after a failed recompile. /readyz monitoring below
      // detects a missing child even when the watch process itself survives.
      supervisor.start("api", process.execPath, ["node_modules/tsx/dist/cli.mjs", "watch", "--clear-screen=false", "apps/api/src/server.ts"], { env });
      supervisor.start("web", process.execPath, [join(root, "node_modules/vite/bin/vite.js"), "--host", "127.0.0.1", "--port", String(state.ports.web), "--strictPort"], { env, cwd: join(root, "apps/web") });
      const deadline = Date.now() + 180_000;
      let lastError;
      while (Date.now() < deadline && !stopping) {
        try { await ready(state); log("API and Vite /readyz: PostgreSQL, worker and CLI host RUNNING."); return; }
        catch (error) { lastError = error; await delay(1000); }
      }
      throw new Error(`Readiness failed: ${lastError?.message ?? "startup interrupted"}; inspect ${directory}/logs.`);
    };
    server = net.createServer((socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
      socket.on("error", () => {});
      socket.setTimeout(900_000, () => socket.destroy());
      let input = "";
      socket.on("data", (chunk) => {
        input += chunk;
        if (input.length > 1024) return socket.destroy();
        if (!input.includes("\n")) return;
        socket.removeAllListeners("data");
        void (async () => {
          try {
            const request = JSON.parse(input.trim());
            if (request.id !== state.id) throw new Error("Wrong stack identity.");
            if (request.command === "down") await shutdown();
            else if (request.command === "status") { socket.end(`${JSON.stringify({ ok: started && !stopping, rebuilding, ports: state.ports, processes: state.processes })}\n`); return; }
            else if (request.command === "rebuild") {
              if (!started || stopping || rebuilding) throw new Error("Another stack operation is in progress.");
              rebuilding = true;
              try { await supervisor.stop(services); await build(); await launch(); }
              catch (error) { await shutdown(error); throw error; }
              finally { rebuilding = false; }
            } else throw new Error("Unknown supervisor command.");
            socket.end(`${JSON.stringify(failure ? { error: failure.message } : { ok: true })}\n`);
          } catch (error) { socket.end(`${JSON.stringify({ error: error.message })}\n`); }
        })();
      });
    });
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(controlPath, resolve); });
    chmodSync(controlPath, 0o600);
    saveState(state);
    // Down may need to recover containers left by a previous killed supervisor.
    await dockerDown(state);
    await availablePorts(state);
    if (stopping) throw new Error("Startup interrupted.");
    log(`Starting digest-pinned PostgreSQL and Temporal (project ${state.project})...`);
    await supervisor.run("docker-up", "docker", composeArgs(state, ["up", "-d", "--wait", "--wait-timeout", "180"]));
    await build();
    const installed = join(directory, "tools/node_modules/opencode-ai/package.json");
    if (!existsSync(installed) || JSON.parse(readFileSync(installed, "utf8")).version !== state.pins.opencode) {
      log(`Installing opencode-ai@${state.pins.opencode} inside the state directory...`);
      await runNpm("install-opencode", ["install", "--prefix", join(directory, "tools"), "--no-audit", "--no-fund", "--package-lock=false", "--save-exact", `opencode-ai@${state.pins.opencode}`]);
    }
    log("Applying database migrations...");
    await supervisor.run("migrations", process.execPath, ["packages/db/dist/migrate.js"], { env });
    if (stopping) throw new Error("Startup interrupted.");
    await launch();
    const setupResponse = await fetch(`http://127.0.0.1:${state.ports.api}/api/setup/status`, { signal: AbortSignal.timeout(5000) });
    if (!setupResponse.ok) throw new Error("Could not read owner setup status.");
    const setup = await setupResponse.json();
    log(`Web: http://127.0.0.1:${state.ports.web} | API: http://127.0.0.1:${state.ports.api}`);
    if (setup.setupRequired) log(`One-time owner setup token: ${secrets.setup}`); else log("Owner already configured; sign in with your existing account.");
    log("Browser/companion services and root features are disabled. OpenCode UI needs no provider account; model inference is not verified.");
    log("API watch and Vite HMR are active. After packages/* or worker edits: npm run dev:stack -- rebuild");
    log("Stop: npm run dev:stack -- down | Remove dev data: npm run dev:stack -- reset");
    started = true;
    let checking = false, unhealthySince = null;
    monitor = setInterval(async () => {
      if (checking || stopping || rebuilding) return;
      checking = true;
      try {
        const status = await execute("docker", composeArgs(state, ["ps", "--all", "--format", "json"]), { timeout: 10_000 });
        const value = status.stdout.trim();
        const containers = value.startsWith("[") ? JSON.parse(value) : value.split("\n").filter(Boolean).map((s) => JSON.parse(s));
        for (const service of ["postgres", "temporal"]) if (!containers.some((c) => c.Service === service && c.State === "running" && c.Health === "healthy")) throw new Error(`${service} Docker service is not healthy.`);
        try { await ready(state); unhealthySince = null; }
        catch (error) {
          unhealthySince ??= Date.now();
          if (Date.now() - unhealthySince > 60_000) throw error;
        }
      } catch (error) { await shutdown(error); }
      finally { checking = false; }
    }, 5000);
    await finished;
  } catch (error) { await shutdown(error); }
  finally {
    process.removeListener("SIGINT", signalHandler);
    process.removeListener("SIGTERM", signalHandler);
    process.removeListener("SIGHUP", signalHandler);
    // Allow down's final response to drain, then close idle control clients.
    await delay(50);
    for (const socket of sockets) socket.destroy();
    if (server) await new Promise((resolve) => server.close(resolve));
    if (cleaned) {
      state.controller = null;
      saveState(state);
      rmSync(lockPath, { force: true });
    }
  }
  if (failure) throw failure;
}

/**
 * Validate the lifecycle subcommand and dispatch it against the selected owned stack directory.
 */
export async function main(args = process.argv.slice(2)) {
  const [command = "up", ...extra] = args;
  if (extra.length || !["up", "down", "reset", "status", "verify", "rebuild", "help", "--help"].includes(command)) throw new Error("Usage: npm run dev:stack -- [up|down|reset|status|verify|rebuild]");
  if (["help", "--help"].includes(command)) { log("up starts the foreground supervisor; down stops; reset deletes only owned dev state; status reports processes; verify checks readiness; rebuild compiles packages and restarts source services."); return; }
  const directory = statePath(root);
  if (command === "up") return up(directory);
  const state = readState(root, directory);
  if (command === "down") return down(state);
  if (command === "reset") return reset(state);
  if (!state) throw new Error("No stack exists in the selected state directory.");
  if (command === "status") {
    let response = { ok: false, ports: state.ports, processes: state.processes.map((p) => ({ name: p.name, running: isSameProcess(p) })) };
    if (isSameProcess(state.controller)) response = await requestControl(state, "status", 5000);
    console.log(JSON.stringify(response, null, 2));
    if (!response.ok) process.exitCode = 1;
  } else if (command === "verify") {
    const status = await requestControl(state, "status", 5000);
    if (!status.ok || status.rebuilding) throw new Error("Stack is not running or is rebuilding.");
    await ready(state);
    log("Verification passed: API and Vite report database, worker and CLI host RUNNING.");
  } else { await requestControl(state, "rebuild"); log("Package rebuild and source service restart completed."); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((error) => { console.error(`[dev:stack] ${error.message}`); process.exitCode = 1; });
