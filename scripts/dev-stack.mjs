#!/usr/bin/env node
// npm run dev:stack            start the whole SpaceApp from source (foreground, Ctrl-C stops it)
// npm run dev:stack -- down    stop a running dev stack and its containers
// npm run dev:stack -- reset   remove the containers, volumes and state directory this command created
// npm run dev:stack -- status  print the state of a running dev stack
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, watch } from "node:fs";
import { chmod, copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import {
  ensureSecrets, packageForChange, readOpencodeVersion, readServiceImages, renderCliCommand, renderCompose, repoRoot,
  resolvePorts, resolveProjectName, resolveStateDir, serviceEnvironment, starterMemoryFiles, stateDirectories,
  statePaths, verifyProcessIdentity, workspacePackages
} from "./dev-stack/config.mjs";

const color = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code, text) => (color ? `\u001b[${code}m${text}\u001b[0m` : text);
const info = (message) => process.stdout.write(`${paint("36", "[dev-stack]")} ${message}\n`);
const fail = (message) => process.stderr.write(`${paint("31;1", "[dev-stack] ✖")} ${paint("31", message)}\n`);
const bin = (name) => join(repoRoot, "node_modules", ".bin", name);

class DevStackError extends Error {}

function context() {
  const env = process.env;
  if (!env.DOCKER_HOST && !existsSync("/var/run/docker.sock")) {
    const wslDesktopSocket = "/mnt/wsl/docker-desktop/shared-sockets/guest-services/docker.proxy.sock";
    if (existsSync(wslDesktopSocket)) {
      env.DOCKER_HOST = `unix://${wslDesktopSocket}`;
    }
  }
  const stateDir = resolveStateDir(env);
  return { env, ports: resolvePorts(env), project: resolveProjectName(env), paths: statePaths(stateDir) };
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: repoRoot, stdio: "inherit", ...options });
  if (result.error) throw new DevStackError(`${command} could not start: ${result.error.message}`);
  if (result.status !== 0) throw new DevStackError(`${[command, ...args].join(" ")} failed (exit ${result.status ?? result.signal}).`);
  return result;
}

function compose({ project, paths }, args, { password = "unused", ...options } = {}) {
  return run("docker", ["compose", "--project-name", project, "--file", paths.compose, ...args], {
    ...options,
    env: { ...process.env, SPACE_DEV_POSTGRES_PASSWORD: password }
  });
}

async function writeComposeFile(ctx) {
  await mkdir(ctx.paths.stateDir, { recursive: true, mode: 0o700 });
  await writeFile(ctx.paths.compose, renderCompose({ images: readServiceImages(), ports: ctx.ports }), { mode: 0o600 });
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

function processIdentity(pid) {
  if (!pidAlive(pid)) return null;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8").trim();
    const closeParen = stat.lastIndexOf(")");
    if (closeParen !== -1) {
      const rest = stat.slice(closeParen + 1).trim().split(/\s+/);
      const starttime = rest[19];
      const comm = stat.slice(stat.indexOf("(") + 1, closeParen);
      return { pid, comm, starttime };
    }
  } catch { /* not Linux / /proc unavailable */ }
  try {
    const res = spawnSync("ps", ["-o", "lstart=,command=", "-p", String(pid)], { encoding: "utf8" });
    if (res.status === 0 && res.stdout.trim()) {
      return { pid, ps: res.stdout.trim() };
    }
  } catch { /* fallback */ }
  return { pid };
}

function verifyPid(recorded) {
  if (!recorded) return null;
  const pid = typeof recorded === "number" ? recorded : recorded.pid;
  if (!pid || !pidAlive(pid)) return null;
  const current = processIdentity(pid);
  if (!current) return null;
  return verifyProcessIdentity(recorded, current);
}

async function readRunFile(paths) {
  try {
    return JSON.parse(await readFile(paths.runFile, "utf8"));
  } catch {
    return null;
  }
}

function portFree(port) {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () => server.close(() => resolve(true)));
  });
}

function checkPrerequisites() {
  if (process.platform === "win32") {
    throw new DevStackError("Run the dev stack inside WSL2 (Ubuntu) on Windows; see CONTRIBUTING.md.");
  }
  if (!process.env.DOCKER_HOST && !existsSync("/var/run/docker.sock")) {
    const wslDesktopSocket = "/mnt/wsl/docker-desktop/shared-sockets/guest-services/docker.proxy.sock";
    if (existsSync(wslDesktopSocket)) {
      process.env.DOCKER_HOST = `unix://${wslDesktopSocket}`;
    }
  }
  const docker = spawnSync("docker", ["compose", "version"], { stdio: "ignore" });
  if (docker.error || docker.status !== 0) {
    throw new DevStackError("Docker with the compose plugin is required and must be running (docker compose version failed).");
  }
}

async function ensureSocketSupport(ctx) {
  const { paths, project } = ctx;
  const testPath = join(paths.socketDir, `.test-${process.pid}.sock`);
  const works = await new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    try {
      server.listen(testPath, () => {
        server.close(() => {
          rm(testPath, { force: true }).catch(() => {});
          resolve(true);
        });
      });
    } catch {
      resolve(false);
    }
  });
  if (!works) {
    const fallbackDir = join(tmpdir(), `${project}-run`);
    await mkdir(fallbackDir, { recursive: true, mode: 0o700 });
    paths.socketDir = fallbackDir;
    paths.cliHostSocket = join(fallbackDir, "cli-host.sock");
  }
}

async function prepareState(ctx) {
  const { paths } = ctx;
  await mkdir(paths.stateDir, { recursive: true, mode: 0o700 });
  await chmod(paths.stateDir, 0o700);
  // Ignored by git even when SPACE_DEV_STATE_DIR points somewhere else inside the checkout.
  await writeFile(join(paths.stateDir, ".gitignore"), "*\n");
  for (const directory of stateDirectories(paths)) await mkdir(directory, { recursive: true, mode: 0o700 });
  await ensureSocketSupport(ctx);
  for (const name of starterMemoryFiles) {
    const target = join(paths.memory, name);
    if (!existsSync(target)) {
      await copyFile(join(repoRoot, "starter-memory", name), target);
      await chmod(target, 0o600);
    }
  }
  return ensureSecrets(paths);
}

async function installOpencode(paths) {
  const version = readOpencodeVersion();
  const prefix = join(paths.cliVendor, "opencode");
  const manifest = join(prefix, "node_modules", "opencode-ai", "package.json");
  let installed = null;
  try {
    installed = JSON.parse(readFileSync(manifest, "utf8")).version;
  } catch { /* not installed yet */ }
  if (installed !== version) {
    info(`installing opencode-ai@${version} into ${relative(repoRoot, prefix) || prefix}`);
    await mkdir(prefix, { recursive: true, mode: 0o700 });
    await writeFile(join(prefix, "package.json"), `${JSON.stringify({ private: true }, null, 2)}\n`);
    run("npm", ["install", "--prefix", prefix, "--no-audit", "--no-fund", "--save-exact", `opencode-ai@${version}`]);
  }
  const command = join(paths.cliBin, "opencode-vscode-parity");
  await writeFile(command, renderCliCommand({ runtime: "opencode", paths, nodePath: process.execPath }), { mode: 0o700 });
  await chmod(command, 0o700);
}

function buildPackages() {
  info("building workspace packages");
  for (const name of workspacePackages) run("npm", ["run", "build", "--silent", "-w", `@space/${name}`]);
}

// ---------------------------------------------------------------------------------------------
// Supervisor

const children = new Map();
const launchers = new Map();
const restarting = new Set();
let stopping = false;

function pipeLines(stream, name, target, onLine) {
  const label = paint(name === "api" ? "35" : name === "web" ? "32" : name === "worker" ? "33" : "34", `[${name}]`.padEnd(14));
  createInterface({ input: stream }).on("line", (line) => {
    target.write(`${label} ${line}\n`);
    onLine?.(line);
  });
}

function startProcess(name, command, args, { env, cwd = repoRoot, onLine }) {
  launchers.set(name, () => startProcess(name, command, args, { env, cwd, onLine }));
  const child = spawn(command, args, { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  pipeLines(child.stdout, name, process.stdout, onLine);
  pipeLines(child.stderr, name, process.stderr, onLine);
  children.set(name, child);
  child.once("error", (error) => {
    fail(`${name} could not start: ${error.message}`);
    void shutdown(1);
  });
  child.once("exit", (code, signal) => {
    children.delete(name);
    if (restarting.delete(name)) {
      if (!stopping) {
        info(`restarting ${name}`);
        launchers.get(name)();
        void recordChildren();
      }
      return;
    }
    if (!stopping) {
      fail(`${name} exited unexpectedly (${signal ?? `exit ${code}`}). Stopping the dev stack; fix the error above and start it again.`);
      void shutdown(1);
    }
  });
  return child;
}

/** Restarts a process to load a new build; its exit is expected and is not a failure. */
function restartProcess(name) {
  const child = children.get(name);
  if (!child || stopping || restarting.has(name)) return;
  restarting.add(name);
  killGroup(child.pid, "SIGTERM");
  // The Temporal worker drains and stops on SIGTERM but its process can stay alive on open handles.
  setTimeout(() => {
    if (children.get(name) === child) killGroup(child.pid, "SIGKILL");
  }, 3_000).unref();
}

async function recordChildren() {
  if (!shutdownContext || stopping) return;
  const { paths, ports, project } = shutdownContext;
  const childrenRecords = [...children.entries()].map(([name, child]) => ({
    name,
    pid: child.pid,
    ...processIdentity(child.pid)
  }));
  await writeFile(paths.runFile, `${JSON.stringify({
    pid: process.pid,
    supervisor: { pid: process.pid, ...processIdentity(process.pid) },
    ports,
    project,
    socket: paths.cliHostSocket,
    children: childrenRecords
  })}\n`, { mode: 0o600 });
}

function killGroup(pid, signal) {
  try {
    process.kill(-pid, signal);
  } catch {
    try { process.kill(pid, signal); } catch { /* already gone */ }
  }
}

async function stopChildren() {
  const running = [...children.values()];
  for (const child of running) killGroup(child.pid, "SIGTERM");
  const deadline = Date.now() + 10_000;
  while (children.size > 0 && Date.now() < deadline) await delay(100);
  for (const child of children.values()) killGroup(child.pid, "SIGKILL");
}

let shutdownContext = null;
async function shutdown(code) {
  if (stopping) return;
  stopping = true;
  info("stopping processes");
  await stopChildren();
  if (shutdownContext) {
    info("stopping PostgreSQL and Temporal");
    try {
      compose(shutdownContext, ["stop"], { stdio: "ignore" });
    } catch (error) {
      fail(error.message);
    }
    await rm(shutdownContext.paths.runFile, { force: true });
  }
  process.exit(code);
}

async function fetchJson(url, timeoutMs = 5000) {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  return { status: response.status, body: await response.json().catch(() => null) };
}

function describeReadiness(body) {
  if (!body || typeof body !== "object") return "no readiness report";
  const failing = Object.entries(body.checks ?? {})
    .filter(([, check]) => check && typeof check === "object" && check.ok === false)
    .map(([name, check]) => `${name}${check.reason || check.message ? `: ${check.reason ?? check.message}` : ""}`);
  return failing.length > 0 ? failing.join("; ") : JSON.stringify(body).slice(0, 400);
}

async function waitForReady(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    if (stopping) return null;
    try {
      last = await fetchJson(url);
      if (last.status === 200 && last.body?.ok === true) return last.body;
    } catch { /* not listening yet */ }
    await delay(1000);
  }
  throw new DevStackError(`SpaceApp did not become ready within ${Math.round(timeoutMs / 1000)} s (${describeReadiness(last?.body)}).`);
}

function monitorReadiness(url) {
  let healthy = true;
  const timer = setInterval(async () => {
    if (stopping) return;
    let report;
    try {
      report = await fetchJson(url);
    } catch (error) {
      report = { status: 0, body: { error: error.message } };
    }
    const ok = report.status === 200 && report.body?.ok === true;
    if (!ok && healthy) {
      fail(`SpaceApp is NOT ready (/readyz ${report.status || "unreachable"}): ${describeReadiness(report.body)}`);
    } else if (ok && !healthy) {
      info(paint("32", "SpaceApp is ready again (/readyz ok)."));
    }
    healthy = ok;
  }, 5000);
  timer.unref();
}

/**
 * Rebuilds a workspace package when its source changes. The API (tsx watch) and Vite reload
 * on their own when the built files change; the worker and the CLI host are restarted here.
 */
function watchPackages() {
  const queue = new Set();
  let timer = null;
  let building = false;
  const flush = async () => {
    if (building || queue.size === 0 || stopping) return;
    building = true;
    const names = workspacePackages.filter((name) => queue.has(name));
    queue.clear();
    let rebuilt = false;
    for (const name of names) {
      const started = Date.now();
      const result = spawnSync("npm", ["run", "build", "--silent", "-w", `@space/${name}`], { cwd: repoRoot, encoding: "utf8" });
      if (result.status === 0) {
        rebuilt = true;
        info(`rebuilt @space/${name} in ${((Date.now() - started) / 1000).toFixed(1)} s`);
        if (name === "cli-host") restartProcess("cli-host");
      } else {
        fail(`@space/${name} failed to build; the running services keep the previous build.\n${result.stdout}${result.stderr}`);
      }
    }
    building = false;
    if (rebuilt) restartProcess("worker");
    if (queue.size > 0) void flush();
  };
  watch(join(repoRoot, "packages"), { recursive: true }, (_event, file) => {
    const name = file ? packageForChange(join("packages", file.toString())) : null;
    if (!name) return;
    queue.add(name);
    clearTimeout(timer);
    timer = setTimeout(() => void flush(), 300);
  });
}

/** tsc --watch rewrites apps/worker/dist on a source change; the worker then restarts. */
function watchWorkerBuild() {
  let timer = null;
  watch(join(repoRoot, "apps/worker/dist"), { recursive: true }, (_event, file) => {
    if (!file || !file.toString().endsWith(".js")) return;
    clearTimeout(timer);
    timer = setTimeout(() => restartProcess("worker"), 500);
  });
}

async function up(ctx) {
  checkPrerequisites();
  const previous = await readRunFile(ctx.paths);
  const previousPid = previous?.supervisor ? verifyPid(previous.supervisor) : verifyPid(previous?.pid);
  if (previousPid) {
    throw new DevStackError(`A dev stack is already running (pid ${previousPid}). Stop it with npm run dev:stack -- down.`);
  }
  for (const [name, port] of [["web", ctx.ports.web], ["API", ctx.ports.api]]) {
    if (!(await portFree(port))) {
      throw new DevStackError(`Port ${port} for the ${name} is in use. Free it or set SPACE_DEV_${name.toUpperCase()}_PORT.`);
    }
  }
  const secrets = await prepareState(ctx);
  await writeComposeFile(ctx);
  shutdownContext = ctx;
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.once(signal, () => void shutdown(0));
  await writeFile(ctx.paths.runFile, `${JSON.stringify({
    pid: process.pid,
    supervisor: { pid: process.pid, ...processIdentity(process.pid) },
    ports: ctx.ports,
    project: ctx.project,
    socket: ctx.paths.cliHostSocket,
    children: []
  })}\n`, { mode: 0o600 });

  info(`starting PostgreSQL (pgvector) and Temporal (compose project ${ctx.project})`);
  compose(ctx, ["up", "--detach", "--wait", "--quiet-pull"], { password: secrets.postgresPassword });

  buildPackages();
  await installOpencode(ctx.paths);
  const env = { ...process.env, ...serviceEnvironment({ ...ctx, secrets }), NODE_ENV: "development" };
  delete env.SPACE_DEV_POSTGRES_PASSWORD;

  info("running database migrations");
  run(process.execPath, ["packages/db/dist/migrate.js"], { env });
  startProcess("cli-host", process.execPath, ["packages/cli-host/dist/main.js"], { env });
  startProcess("api", bin("tsx"), ["watch", "--clear-screen=false", "src/server.ts"], { env, cwd: join(repoRoot, "apps/api") });
  startProcess("web", bin("vite"), ["--strictPort", "--clearScreen", "false"], { env, cwd: join(repoRoot, "apps/web") });
  // The worker starts immediately if built, or after the first compile of tsc --watch; later compiles restart it.
  let workerStarted = false;
  const launchWorker = () => {
    if (workerStarted || stopping) return;
    workerStarted = true;
    startProcess("worker", process.execPath, ["apps/worker/dist/worker.js"], {
      env,
      onLine: (workerLine) => {
        if (!/state: 'STOPPED'/.test(workerLine) || stopping || restarting.has("worker")) return;
        fail("worker stopped polling Temporal (state STOPPED). Stopping the dev stack; start it again when fixed.");
        void shutdown(1);
      }
    });
    void recordChildren();
    watchWorkerBuild();
  };

  if (existsSync(join(repoRoot, "apps/worker/dist/worker.js"))) {
    launchWorker();
  }

  startProcess("worker-build", bin("tsc"), ["-p", "apps/worker/tsconfig.json", "--watch", "--preserveWatchOutput"], {
    env,
    onLine: (line) => {
      if (!/Watching for file changes/.test(line)) return;
      if (/Found [1-9]\d* errors?/.test(line)) fail("the worker has type errors; it runs the code that was emitted.");
      if (!workerStarted) launchWorker();
    }
  });
  await recordChildren();
  watchPackages();

  const webUrl = `http://127.0.0.1:${ctx.ports.web}`;
  const timeoutMs = Number(process.env.SPACE_DEV_READY_TIMEOUT_MS) || 300_000;
  // The API first, so the web proxy does not log a refused connection every second while it starts.
  await waitForReady(`${env.SPACE_API_ORIGIN}/readyz`, timeoutMs);
  const readyUrl = `${webUrl}/readyz`;
  await waitForReady(readyUrl, 30_000);
  if (stopping) return;
  let setupRequired = true;
  try {
    setupRequired = (await fetchJson(`${webUrl}/api/setup/status`)).body?.setupRequired !== false;
  } catch { /* print the token anyway */ }
  const lines = [
    "",
    paint("32;1", "SpaceApp is running from source."),
    `  Open        ${paint("1", webUrl)}`,
    setupRequired
      ? `  Setup token ${paint("1", secrets.setupToken)}  (one-time: create the owner with it)`
      : "  Owner       already set up; sign in with your owner account",
    `  API         http://127.0.0.1:${ctx.ports.api}   PostgreSQL 127.0.0.1:${ctx.ports.postgres}   Temporal 127.0.0.1:${ctx.ports.temporal}`,
    `  State       ${ctx.paths.stateDir}`,
    "  Stop with Ctrl-C or npm run dev:stack -- down; remove everything with npm run dev:stack -- reset.",
    ""
  ];
  process.stdout.write(`${lines.join("\n")}\n`);
  monitorReadiness(readyUrl);
}

async function down(ctx, { quiet = false } = {}) {
  const state = await readRunFile(ctx.paths);
  const supervisorPid = state?.supervisor ? verifyPid(state.supervisor) : verifyPid(state?.pid);
  if (supervisorPid && supervisorPid !== process.pid) {
    info(`stopping the dev stack (pid ${supervisorPid})`);
    process.kill(supervisorPid, "SIGTERM");
    const deadline = Date.now() + 30_000;
    while (pidAlive(supervisorPid) && Date.now() < deadline) await delay(200);
    if (state.supervisor ? verifyPid(state.supervisor) : (pidAlive(supervisorPid) && verifyPid(state?.pid))) {
      killGroup(supervisorPid, "SIGKILL");
    }
  }
  // Children of a supervisor that was killed outright.
  for (const child of state?.children ?? []) {
    const pid = verifyPid(child);
    if (pid) killGroup(pid, "SIGTERM");
  }
  await delay(state?.children?.length ? 500 : 0);
  for (const child of state?.children ?? []) {
    const pid = verifyPid(child);
    if (pid) killGroup(pid, "SIGKILL");
  }
  if (existsSync(ctx.paths.compose)) compose(ctx, ["stop"], { stdio: quiet ? "ignore" : "inherit" });
  if (state?.socket) {
    await rm(state.socket, { force: true }).catch(() => {});
  }
  await rm(ctx.paths.runFile, { force: true });
  if (!quiet) info("dev stack stopped");
}

async function reset(ctx) {
  checkPrerequisites();
  await down(ctx, { quiet: true });
  await writeComposeFile(ctx);
  info(`removing containers and volumes of compose project ${ctx.project}`);
  compose(ctx, ["down", "--volumes", "--remove-orphans"]);
  info(`removing ${ctx.paths.stateDir}`);
  await rm(ctx.paths.stateDir, { recursive: true, force: true });
  const fallbackDir = join(tmpdir(), `${ctx.project}-run`);
  if (existsSync(fallbackDir)) {
    await rm(fallbackDir, { recursive: true, force: true }).catch(() => {});
  }
  info("dev stack reset");
}

async function status(ctx) {
  const state = await readRunFile(ctx.paths);
  const livePid = state?.supervisor ? verifyPid(state.supervisor) : verifyPid(state?.pid);
  const running = Boolean(livePid);
  info(running ? `running (pid ${livePid}) on http://127.0.0.1:${state.ports.web}` : "not running");
  if (existsSync(ctx.paths.compose)) compose(ctx, ["ps"]);
  process.exitCode = running ? 0 : 3;
}

const commands = { up, down, reset, status };
const name = process.argv[2] ?? "up";
try {
  const command = commands[name];
  if (!command || process.argv.length > 3) {
    throw new DevStackError("Usage: npm run dev:stack [-- up|down|reset|status]");
  }
  await command(context());
} catch (error) {
  if (!(error instanceof DevStackError)) throw error;
  fail(error.message);
  if (name === "up" && shutdownContext) await shutdown(1);
  process.exit(1);
}
