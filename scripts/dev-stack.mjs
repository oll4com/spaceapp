#!/usr/bin/env node
// npm run dev:stack            start the whole SpaceApp from source (foreground, Ctrl-C stops it)
// npm run dev:stack -- down    stop a running dev stack and its containers
// npm run dev:stack -- reset   remove the containers, volumes and state directory this command created
// npm run dev:stack -- status  print the state of a running dev stack
// npm run dev:stack -- rebuild rebuild workspace packages and the Temporal worker from source
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, watch } from "node:fs";
import { chmod, copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import {
  assertOwnedStateDir,
  assertSafeStateDir,
  ensureSecrets,
  packageForChange,
  readOpencodeVersion,
  readServiceImages,
  renderCliCommand,
  renderCompose,
  repoRoot,
  resolvePorts,
  resolveProjectName,
  resolveStateDir,
  serviceEnvironment,
  starterMemoryFiles,
  stateDirectories,
  stateMarkerContents,
  statePaths,
  verifyProcessIdentity,
  workspacePackages
} from "./dev-stack/config.mjs";

const color = Boolean(process.stdout.isTTY && !process.env.NO_COLOR);

/**
 * Formats text with an ANSI SGR color code when stdout is an interactive color terminal.
 *
 * @param {string} code - ANSI escape sequence code.
 * @param {string} text - Text to format.
 * @returns {string} Formatted string.
 */
function paint(code, text) {
  return color ? `\u001b[${code}m${text}\u001b[0m` : text;
}

/**
 * Writes an informational dev-stack status line to stdout.
 *
 * @param {string} message - Message to print.
 * @returns {void}
 */
function info(message) {
  process.stdout.write(`${paint("36", "[dev-stack]")} ${message}\n`);
}

/**
 * Writes an error line to stderr.
 *
 * @param {string} message - Failure message to print.
 * @returns {void}
 */
function fail(message) {
  process.stderr.write(`${paint("31;1", "[dev-stack] ERROR")} ${paint("31", message)}\n`);
}

/**
 * Resolves a binary inside the root `node_modules/.bin` directory.
 *
 * @param {string} name - Binary name.
 * @returns {string} Absolute path to the binary.
 */
function bin(name) {
  return join(repoRoot, "node_modules", ".bin", name);
}

class DevStackError extends Error {}

/**
 * Builds the runtime execution context (environment, ports, Compose project name, and state paths).
 *
 * @returns {{ env: NodeJS.ProcessEnv, ports: ReturnType<typeof resolvePorts>, project: string, paths: ReturnType<typeof statePaths> }} Execution context.
 */
function context() {
  const env = process.env;
  if (!env.DOCKER_HOST && !existsSync("/var/run/docker.sock")) {
    const wslDesktopSocket = "/mnt/wsl/docker-desktop/shared-sockets/guest-services/docker.proxy.sock";
    if (existsSync(wslDesktopSocket)) {
      env.DOCKER_HOST = `unix://${wslDesktopSocket}`;
    }
  }
  const stateDir = resolveStateDir(env);
  return {
    env,
    ports: resolvePorts(env),
    project: resolveProjectName(env, stateDir),
    paths: statePaths(stateDir)
  };
}

/**
 * Runs a child command synchronously and throws a `DevStackError` on non-zero exit.
 *
 * @param {string} command - Executable name or path.
 * @param {string[]} args - Command-line arguments.
 * @param {import("node:child_process").SpawnSyncOptions} [options={}] - Spawn options.
 * @returns {import("node:child_process").SpawnSyncReturns<string | Buffer>} Spawn result.
 */
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: repoRoot, stdio: "inherit", ...options });
  if (result.error) {
    throw new DevStackError(`${command} could not start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new DevStackError(`${[command, ...args].join(" ")} failed (exit ${result.status ?? result.signal}).`);
  }
  return result;
}

/**
 * Executes a `docker compose` command scoped to the dev-stack project and compose file.
 *
 * @param {{ project: string, paths: ReturnType<typeof statePaths> }} ctx - Execution context.
 * @param {string[]} args - Arguments passed to `docker compose`.
 * @param {{ password?: string, composeFile?: string } & import("node:child_process").SpawnSyncOptions} [options={}] - Execution options.
 * @returns {import("node:child_process").SpawnSyncReturns<string | Buffer>} Spawn result.
 */
function compose({ project, paths }, args, { password = "unused", composeFile = paths.compose, ...options } = {}) {
  return run("docker", ["compose", "--project-name", project, "--file", composeFile, ...args], {
    ...options,
    env: { ...process.env, SPACE_DEV_POSTGRES_PASSWORD: password }
  });
}

/**
 * Writes the generated `compose.yml` file with mode 0600 inside the state directory.
 *
 * @param {ReturnType<typeof context>} ctx - Execution context.
 * @param {string} [targetFile=ctx.paths.compose] - Destination path for the compose file.
 * @returns {Promise<void>}
 */
async function writeComposeFile(ctx, targetFile = ctx.paths.compose) {
  await writeFile(targetFile, renderCompose({ images: readServiceImages(), ports: ctx.ports }), { mode: 0o600 });
  await chmod(targetFile, 0o600);
}

/**
 * Verifies that both `postgres` and `temporal` containers in the dev-stack Compose project
 * have reached the exact `"healthy"` container health state.
 *
 * @param {ReturnType<typeof context>} ctx - Execution context.
 * @param {string} password - Database password for Compose interpolation.
 * @returns {void}
 */
function verifyComposeServicesHealthy(ctx, password) {
  for (const service of ["postgres", "temporal"]) {
    const idResult = compose(ctx, ["ps", "-q", service], {
      password,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8"
    });
    const containerId = String(idResult.stdout ?? "").trim();
    if (!containerId) {
      throw new DevStackError(`Docker Compose service ${service} has no running container.`);
    }
    const inspectResult = run(
      "docker",
      ["inspect", "--format", "{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}", containerId],
      { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" }
    );
    const health = String(inspectResult.stdout ?? "").trim().toLowerCase();
    if (health !== "healthy") {
      throw new DevStackError(`Docker Compose service ${service} is not healthy (state: ${health || "unknown"}).`);
    }
  }
}

/**
 * Checks whether a numeric PID currently exists on the host.
 *
 * @param {number} pid - Process ID to probe.
 * @returns {boolean} True when the process exists.
 */
function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

/**
 * Captures OS-level process identity metadata (`starttime`, `comm`, `ps`) for a live PID.
 *
 * @param {number} pid - Process ID to inspect.
 * @returns {Record<string, unknown> | null} Process identity descriptor or null when not alive.
 */
function processIdentity(pid) {
  if (!Number.isInteger(pid) || pid <= 0 || !pidAlive(pid)) return null;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8").trim();
    const closeParen = stat.lastIndexOf(")");
    if (closeParen !== -1) {
      const rest = stat.slice(closeParen + 1).trim().split(/\s+/);
      const starttime = rest[19];
      const comm = stat.slice(stat.indexOf("(") + 1, closeParen);
      return { pid, comm, starttime };
    }
  } catch {
    // /proc is not available on macOS; fall back to ps below.
  }
  try {
    const res = spawnSync("ps", ["-o", "lstart=,command=", "-p", String(pid)], { encoding: "utf8" });
    if (res.status === 0 && res.stdout.trim()) {
      return { pid, ps: res.stdout.trim() };
    }
  } catch {
    // Ignore ps lookup errors.
  }
  return null;
}

/**
 * Verifies a saved process identity record against the currently running process with that PID.
 *
 * @param {Record<string, unknown> | null | undefined} recorded - Saved identity record from `run.json`.
 * @returns {number | null} Verified PID if still running as the same process, or null.
 */
function verifyPid(recorded) {
  if (!recorded || typeof recorded !== "object") return null;
  const pid = recorded.pid;
  if (!Number.isInteger(pid) || pid <= 0 || !pidAlive(pid)) return null;
  const current = processIdentity(pid);
  if (!current) return null;
  return verifyProcessIdentity(recorded, current);
}

/**
 * Reads and parses the runtime state file (`run.json`) if present.
 *
 * @param {ReturnType<typeof statePaths>} paths - State directory path map.
 * @returns {Promise<Record<string, any> | null>} Parsed run record or null.
 */
async function readRunFile(paths) {
  try {
    return JSON.parse(await readFile(paths.runFile, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Probes whether a TCP port on `127.0.0.1` is free to bind.
 *
 * @param {number} port - Loopback TCP port to test.
 * @returns {Promise<boolean>} True when the port can be bound on `127.0.0.1`.
 */
function portFree(port) {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () => {
      server.close(() => resolve(true));
    });
  });
}

/**
 * Verifies host platform and Docker Compose availability before running stack lifecycle commands.
 *
 * @returns {void}
 */
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

/**
 * Ensures the CLI host Unix domain socket directory supports binding sockets and falls back to `tmpdir()` when needed.
 *
 * @param {ReturnType<typeof context>} ctx - Execution context.
 * @returns {Promise<void>}
 */
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

/**
 * Prepares the `.dev-stack/` state directory, verifies ownership marker, copies starter memory, and ensures mode 0600 secrets.
 *
 * @param {ReturnType<typeof context>} ctx - Execution context.
 * @returns {Promise<{ postgresPassword: string, sessionSecret: string, setupToken: string }>} Generated or loaded secrets.
 */
async function prepareState(ctx) {
  const { paths } = ctx;
  assertSafeStateDir(paths.stateDir);
  await mkdir(paths.stateDir, { recursive: true, mode: 0o700 });
  await chmod(paths.stateDir, 0o700);
  if (!existsSync(paths.marker)) {
    const entries = await readdir(paths.stateDir);
    if (entries.length > 0) {
      throw new DevStackError(`State directory is not empty and is not owned by the dev stack: ${paths.stateDir}`);
    }
    await writeFile(paths.marker, stateMarkerContents, { mode: 0o600 });
  } else {
    await assertOwnedStateDir(paths.stateDir);
  }
  // Ignored by git even when SPACE_DEV_STATE_DIR points somewhere else inside the checkout.
  await writeFile(join(paths.stateDir, ".gitignore"), "*\n");
  for (const directory of stateDirectories(paths)) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
  }
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

/**
 * Installs the Dockerfile-pinned `opencode-ai` package into the state directory and writes the parity wrapper.
 *
 * @param {ReturnType<typeof statePaths>} paths - State directory path map.
 * @returns {Promise<void>}
 */
async function installOpencode(paths) {
  const version = readOpencodeVersion();
  const prefix = join(paths.cliVendor, "opencode");
  const manifest = join(prefix, "node_modules", "opencode-ai", "package.json");
  let installed = null;
  try {
    installed = JSON.parse(readFileSync(manifest, "utf8")).version;
  } catch {
    // Not installed yet.
  }
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

/**
 * Builds all workspace packages in dependency order and builds `@space/worker` so a fresh clone starts cleanly.
 *
 * @returns {void}
 */
function buildPackages() {
  info("building workspace packages");
  for (const name of workspacePackages) {
    run("npm", ["run", "build", "--silent", "-w", `@space/${name}`]);
  }
  run("npm", ["run", "build", "--silent", "-w", "@space/worker"]);
}

// ---------------------------------------------------------------------------------------------
// Supervisor

const children = new Map();
const launchers = new Map();
const restarting = new Set();
let stopping = false;
let shutdownContext = null;
let wroteRunFile = false;

/**
 * Prefixes and forwards each line from a child stream to the parent stream.
 *
 * @param {import("node:stream").Readable} stream - Child stdout or stderr stream.
 * @param {string} name - Managed service name.
 * @param {NodeJS.WriteStream} target - Destination stream (`process.stdout` or `process.stderr`).
 * @param {((line: string) => void) | undefined} onLine - Optional per-line observer callback.
 * @returns {void}
 */
function pipeLines(stream, name, target, onLine) {
  const colorCode = name === "api" ? "35" : name === "web" ? "32" : name === "worker" ? "33" : "34";
  const label = paint(colorCode, `[${name}]`.padEnd(14));
  createInterface({ input: stream }).on("line", (line) => {
    target.write(`${label} ${line}\n`);
    onLine?.(line);
  });
}

/**
 * Spawns and supervises a child process, triggering fail-fast shutdown if it exits unexpectedly.
 *
 * @param {string} name - Logical service name.
 * @param {string} command - Executable path.
 * @param {string[]} args - Command arguments.
 * @param {{ env: NodeJS.ProcessEnv, cwd?: string, onLine?: (line: string) => void }} options - Launch options.
 * @returns {import("node:child_process").ChildProcess} Spawned child process.
 */
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
  // "close" fires after stdout/stderr are drained, so late log lines (e.g. state STOPPED)
  // from a planned restart are still seen while `restarting` contains the name.
  child.once("close", (code, signal) => {
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

/**
 * Restarts a supervised child process to pick up newly built package or worker artifacts.
 *
 * @param {string} name - Managed service name (`worker` or `cli-host`).
 * @returns {void}
 */
function restartProcess(name) {
  const child = children.get(name);
  if (!child || stopping || restarting.has(name)) return;
  restarting.add(name);
  killGroup(child.pid, "SIGTERM");
  // The Temporal worker drains and stops on SIGTERM, but force SIGKILL if open handles keep it alive.
  setTimeout(() => {
    if (children.get(name) === child) killGroup(child.pid, "SIGKILL");
  }, 3_000).unref();
}

/**
 * Persists the supervisor and child process identities into `run.json` with mode 0600.
 *
 * @returns {Promise<void>}
 */
async function recordChildren() {
  if (!shutdownContext || !wroteRunFile || stopping) return;
  const { paths, ports, project } = shutdownContext;
  const childrenRecords = [...children.entries()]
    .map(([name, child]) => {
      const identity = processIdentity(child.pid);
      return identity ? { name, ...identity } : null;
    })
    .filter(Boolean);
  const supervisorIdentity = processIdentity(process.pid) ?? { pid: process.pid, comm: "node" };
  await writeFile(
    paths.runFile,
    `${JSON.stringify({
      pid: process.pid,
      supervisor: supervisorIdentity,
      ports,
      project,
      socket: paths.cliHostSocket,
      children: childrenRecords
    })}\n`,
    { mode: 0o600 }
  );
}

/**
 * Sends a signal to a detached child process group, falling back to the single PID.
 *
 * @param {number | undefined} pid - Target process group leader PID.
 * @param {NodeJS.Signals} signal - Signal to send (`SIGTERM` or `SIGKILL`).
 * @returns {void}
 */
function killGroup(pid, signal) {
  if (!pid) return;
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // Already exited.
    }
  }
}

/**
 * Stops all supervised child processes gracefully with SIGTERM, escalating to SIGKILL on timeout.
 *
 * @returns {Promise<void>}
 */
async function stopChildren() {
  const running = [...children.values()];
  for (const child of running) killGroup(child.pid, "SIGTERM");
  const deadline = Date.now() + 10_000;
  while (children.size > 0 && Date.now() < deadline) {
    await delay(100);
  }
  for (const child of children.values()) killGroup(child.pid, "SIGKILL");
}

/**
 * Shuts down all managed child processes and stops the Docker Compose services before exiting.
 *
 * @param {number} code - Process exit status code (0 for signal stop, non-zero for failure).
 * @returns {Promise<void>}
 */
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
    if (wroteRunFile) {
      await rm(shutdownContext.paths.runFile, { force: true }).catch(() => {});
    }
  }
  process.exit(code);
}

/**
 * Performs an HTTP GET request with a timeout and parses the JSON body.
 *
 * @param {string} url - Target URL.
 * @param {number} [timeoutMs=5000] - Request timeout in milliseconds.
 * @returns {Promise<{ status: number, body: any }>} HTTP status code and parsed JSON body.
 */
async function fetchJson(url, timeoutMs = 5000) {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  return { status: response.status, body: await response.json().catch(() => null) };
}

/**
 * Formats a human-readable summary of failing checks from a `/readyz` response payload.
 *
 * @param {any} body - Parsed `/readyz` JSON payload.
 * @returns {string} Concise failure description.
 */
function describeReadiness(body) {
  if (!body || typeof body !== "object") return "no readiness report";
  const failing = Object.entries(body.checks ?? {})
    .filter(([, check]) => check && typeof check === "object" && check.ok === false)
    .map(([name, check]) => `${name}${check.reason || check.message ? `: ${check.reason ?? check.message}` : ""}`);
  return failing.length > 0 ? failing.join("; ") : JSON.stringify(body).slice(0, 400);
}

/**
 * Polls a `/readyz` endpoint until it returns HTTP 200 with `ok: true`.
 *
 * @param {string} url - Readiness endpoint URL.
 * @param {number} timeoutMs - Maximum wait duration in milliseconds.
 * @returns {Promise<any>} Readiness response payload.
 */
async function waitForReady(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    if (stopping) return null;
    try {
      last = await fetchJson(url);
      if (last.status === 200 && last.body?.ok === true) return last.body;
    } catch {
      // Service is not listening yet.
    }
    await delay(1000);
  }
  throw new DevStackError(`SpaceApp did not become ready within ${Math.round(timeoutMs / 1000)} s (${describeReadiness(last?.body)}).`);
}

/**
 * Continuously polls `/readyz` while the stack runs and logs transitions between ready and degraded states.
 *
 * @param {string} url - Readiness endpoint URL.
 * @returns {void}
 */
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
 * Watches `packages/<name>/src` for edits, queues pending package rebuilds even when a build
 * is already in progress, and restarts the worker (and CLI host when `cli-host` changes).
 *
 * @returns {void}
 */
function watchPackages() {
  const queue = new Set();
  let timer = null;
  let building = false;

  /**
   * Drains all queued package rebuilds sequentially and restarts dependent services.
   *
   * @returns {Promise<void>}
   */
  const flush = async () => {
    if (building || queue.size === 0 || stopping) return;
    building = true;
    let rebuiltAny = false;
    try {
      while (queue.size > 0 && !stopping) {
        const names = workspacePackages.filter((name) => queue.has(name));
        for (const name of names) queue.delete(name);
        for (const name of names) {
          if (stopping) break;
          const started = Date.now();
          const result = spawnSync("npm", ["run", "build", "--silent", "-w", `@space/${name}`], {
            cwd: repoRoot,
            encoding: "utf8"
          });
          if (result.status === 0) {
            rebuiltAny = true;
            info(`rebuilt @space/${name} in ${((Date.now() - started) / 1000).toFixed(1)} s`);
            if (name === "cli-host") restartProcess("cli-host");
          } else {
            fail(`@space/${name} failed to build; the running services keep the previous build.\n${result.stdout}${result.stderr}`);
          }
        }
      }
    } finally {
      building = false;
      if (rebuiltAny && !stopping) restartProcess("worker");
      if (queue.size > 0 && !stopping) void flush();
    }
  };

  watch(join(repoRoot, "packages"), { recursive: true }, (_event, file) => {
    const name = file ? packageForChange(join("packages", file.toString())) : null;
    if (!name) return;
    queue.add(name);
    clearTimeout(timer);
    timer = setTimeout(() => void flush(), 300);
  });
}

/**
 * Watches `apps/worker/dist` so recompilations from `tsc --watch` or `npm run dev:stack -- rebuild`
 * automatically restart the Temporal worker.
 *
 * @returns {void}
 */
function watchWorkerBuild() {
  let timer = null;
  watch(join(repoRoot, "apps/worker/dist"), { recursive: true }, (_event, file) => {
    if (!file || !file.toString().endsWith(".js")) return;
    clearTimeout(timer);
    timer = setTimeout(() => restartProcess("worker"), 500);
  });
}

/**
 * Starts the full SpaceApp stack from source in the foreground.
 *
 * @param {ReturnType<typeof context>} ctx - Execution context.
 * @returns {Promise<void>}
 */
async function up(ctx) {
  checkPrerequisites();
  const previous = await readRunFile(ctx.paths);
  const previousPid = verifyPid(previous?.supervisor);
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
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.once(signal, () => void shutdown(0));
  }
  const supervisorIdentity = processIdentity(process.pid) ?? { pid: process.pid, comm: "node" };
  await writeFile(
    ctx.paths.runFile,
    `${JSON.stringify({
      pid: process.pid,
      supervisor: supervisorIdentity,
      ports: ctx.ports,
      project: ctx.project,
      socket: ctx.paths.cliHostSocket,
      children: []
    })}\n`,
    { mode: 0o600 }
  );
  wroteRunFile = true;

  info(`starting PostgreSQL (pgvector) and Temporal (compose project ${ctx.project})`);
  compose(ctx, ["up", "--detach", "--wait", "--quiet-pull"], { password: secrets.postgresPassword });
  verifyComposeServicesHealthy(ctx, secrets.postgresPassword);

  buildPackages();
  await installOpencode(ctx.paths);
  const env = { ...process.env, ...serviceEnvironment({ ...ctx, secrets }), NODE_ENV: "development" };
  delete env.SPACE_DEV_POSTGRES_PASSWORD;

  info("running database migrations");
  run(process.execPath, ["packages/db/dist/migrate.js"], { env });
  startProcess("cli-host", process.execPath, ["packages/cli-host/dist/main.js"], { env });
  startProcess("api", bin("tsx"), ["watch", "--clear-screen=false", "src/server.ts"], {
    env,
    cwd: join(repoRoot, "apps/api")
  });
  startProcess("web", bin("vite"), ["--strictPort", "--clearScreen", "false"], {
    env,
    cwd: join(repoRoot, "apps/web")
  });

  let workerStarted = false;

  /**
   * Starts the Temporal worker process once its initial build exists and attaches build watching.
   *
   * @returns {void}
   */
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
      if (/Found [1-9]\d* errors?/.test(line)) {
        fail("the worker has type errors; it runs the code that was emitted.");
      }
      if (!workerStarted) launchWorker();
    }
  });
  await recordChildren();
  watchPackages();

  const webUrl = `http://127.0.0.1:${ctx.ports.web}`;
  const timeoutMs = Number(process.env.SPACE_DEV_READY_TIMEOUT_MS) || 300_000;
  // Wait for the API first so Vite proxy does not log connection-refused errors while the API boots.
  await waitForReady(`${env.SPACE_API_ORIGIN}/readyz`, timeoutMs);
  const readyUrl = `${webUrl}/readyz`;
  await waitForReady(readyUrl, 30_000);
  if (stopping) return;
  let setupRequired = true;
  try {
    setupRequired = (await fetchJson(`${webUrl}/api/setup/status`)).body?.setupRequired !== false;
  } catch {
    // Print the setup token if status check fails transiently.
  }
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

/**
 * Stops a running dev stack and its Docker Compose containers while preserving state and volumes.
 *
 * @param {ReturnType<typeof context>} ctx - Execution context.
 * @param {{ quiet?: boolean }} [options={}] - Shutdown options.
 * @returns {Promise<void>}
 */
async function down(ctx, { quiet = false } = {}) {
  const state = await readRunFile(ctx.paths);
  const supervisorPid = verifyPid(state?.supervisor);
  if (supervisorPid && supervisorPid !== process.pid) {
    info(`stopping the dev stack (pid ${supervisorPid})`);
    process.kill(supervisorPid, "SIGTERM");
    const deadline = Date.now() + 30_000;
    while (verifyPid(state?.supervisor) && Date.now() < deadline) {
      await delay(200);
    }
    const stillAlivePid = verifyPid(state?.supervisor);
    if (stillAlivePid) {
      killGroup(stillAlivePid, "SIGKILL");
    }
  }
  // Terminate any leftover children if the supervisor exited uncleanly, verifying identity before each signal.
  for (const child of state?.children ?? []) {
    const pid = verifyPid(child);
    if (pid) killGroup(pid, "SIGTERM");
  }
  await delay(state?.children?.length ? 500 : 0);
  for (const child of state?.children ?? []) {
    const pid = verifyPid(child);
    if (pid) killGroup(pid, "SIGKILL");
  }
  if (existsSync(ctx.paths.compose)) {
    compose(ctx, ["stop"], { stdio: quiet ? "ignore" : "inherit" });
  }
  if (state?.socket) {
    await rm(state.socket, { force: true }).catch(() => {});
  }
  if (existsSync(ctx.paths.runFile)) {
    await rm(ctx.paths.runFile, { force: true }).catch(() => {});
  }
  if (!quiet) info("dev stack stopped");
}

/**
 * Stops the dev stack and removes only the containers, volumes, and state directory created by this command.
 *
 * @param {ReturnType<typeof context>} ctx - Execution context.
 * @returns {Promise<void>}
 */
async function reset(ctx) {
  assertSafeStateDir(ctx.paths.stateDir);
  if (existsSync(ctx.paths.stateDir)) {
    await assertOwnedStateDir(ctx.paths.stateDir);
  }
  checkPrerequisites();
  await down(ctx, { quiet: true });
  info(`removing containers and volumes of compose project ${ctx.project}`);
  if (existsSync(ctx.paths.stateDir)) {
    await writeComposeFile(ctx);
    compose(ctx, ["down", "--volumes", "--remove-orphans"]);
    info(`removing ${ctx.paths.stateDir}`);
    await rm(ctx.paths.stateDir, { recursive: true, force: true });
  } else {
    const tempDir = await mkdtemp(join(tmpdir(), "spaceapp-dev-reset-"));
    try {
      const tempCompose = join(tempDir, "compose.yml");
      await writeComposeFile(ctx, tempCompose);
      compose(ctx, ["down", "--volumes", "--remove-orphans"], { composeFile: tempCompose });
    } finally {
      await rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  }
  const fallbackDir = join(tmpdir(), `${ctx.project}-run`);
  if (existsSync(fallbackDir)) {
    await rm(fallbackDir, { recursive: true, force: true }).catch(() => {});
  }
  info("dev stack reset");
}

/**
 * Prints the current status of the dev stack and its Docker Compose containers.
 *
 * @param {ReturnType<typeof context>} ctx - Execution context.
 * @returns {Promise<void>}
 */
async function status(ctx) {
  const state = await readRunFile(ctx.paths);
  const livePid = verifyPid(state?.supervisor);
  const running = Boolean(livePid);
  info(running ? `running (pid ${livePid}) on http://127.0.0.1:${state.ports.web}` : "not running");
  if (existsSync(ctx.paths.compose)) compose(ctx, ["ps"]);
  process.exitCode = running ? 0 : 3;
}

/**
 * Rebuilds all workspace packages (`packages/*`) and `@space/worker` from source on demand.
 *
 * @returns {Promise<void>}
 */
async function rebuild() {
  buildPackages();
  info("workspace packages and worker rebuilt");
}

const commands = { up, start: up, down, stop: down, reset, status, rebuild };
const name = process.argv[2] ?? "up";
try {
  const command = commands[name];
  if (!command || process.argv.length > 3) {
    throw new DevStackError("Usage: npm run dev:stack [-- up|down|reset|status|rebuild]");
  }
  await command(context());
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
  if ((name === "up" || name === "start") && shutdownContext) {
    await shutdown(1);
  }
  process.exit(1);
}
