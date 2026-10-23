#!/usr/bin/env node
/**
 * dev-stack — one-command, from-source development stack (issue #65).
 *
 * Boots the complete SpaceApp stack from this checkout:
 *   - Postgres (pgvector) and Temporal (auto-setup) as digest-pinned
 *     Docker services, bound to loopback-only host ports.
 *   - API (tsx watch), web (Vite HMR), worker and CLI host as supervised
 *     local processes whose output is streamed with per-line [name] prefixes.
 *
 * Commands: up (default), down, reset, status, --help.
 *
 * Acceptance criteria:
 *   - `up` refuses to start when a supervisor is already running, verifies
 *     the digest-pinned images in packages/run-spaceapp/templates/compose.yml
 *     still match the dev-stack-config constants before writing anything,
 *     generates 0600 secrets only once, builds the workspace package chain,
 *     installs the vendored OpenCode CLI at the Dockerfile-pinned version,
 *     generates the opencode-vscode-parity wrapper, runs migrations, waits
 *     for healthy containers and a ready API (GET /readyz -> ok === true),
 *     prints the owner setup token and then blocks while supervising the
 *     children. Node builtins only; no npm dependencies for this script.
 *   - `down` stops the supervisor (SIGTERM, then SIGKILL) and the compose
 *     stack; `reset` also removes the volumes and the state directory.
 *     Neither requires a TTY (CI runs them with stdin </dev/null).
 *   - No hardcoded image digests and no hardcoded OpenCode version: both
 *     come from the dev-stack-config.mjs constants and the repo Dockerfile.
 *   - Signal safety: SIGTERM/SIGINT during setup kills the tracked child and
 *     exits promptly (non-zero); during supervision it stops the children and
 *     exits 0. The supervisor never silently hangs.
 */

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { delimiter as pathDelimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

import {
  DEV_STACK_STATE_DIR, DEV_STACK_PROJECT_NAME, DEV_STACK_BIND_HOST,
  DEV_STACK_POSTGRES_IMAGE, DEV_STACK_TEMPORAL_IMAGE,
  resolveDevStackPorts, buildDevStackComposeYaml,
  parseComposeServiceImage, parseOpencodePackage,
  devStackChildProcessEnv,
} from "./dev-stack-config.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(SCRIPT_PATH), "..");
const STATE_DIR = join(REPO_ROOT, DEV_STACK_STATE_DIR);
const COMPOSE_FILE = join(STATE_DIR, "docker-compose.yml");
const SUPERVISOR_PID_FILE = join(STATE_DIR, "supervisor.pid");
const COMPOSE_ARGS = ["compose", "-p", DEV_STACK_PROJECT_NAME, "-f", COMPOSE_FILE];
const TEMPLATE_COMPOSE_PATH = join(REPO_ROOT, "packages/run-spaceapp/templates/compose.yml");
const REPO_DOCKERFILE_PATH = join(REPO_ROOT, "Dockerfile");

// Mirrors the workspace build chain of the root `check` script.
const WORKSPACE_BUILD_ORDER = [
  "@space/contracts",
  "@space/icons",
  "@space/streaming",
  "@space/opencode-control",
  "@space/memory-graph",
  "@space/browser-host",
  "@space/cli-host",
  "@space/codex-app-server",
  "@space/runtime",
  "@space/db",
  "@space/gateway",
];

const STATE_DIRECTORIES = [
  STATE_DIR,
  join(STATE_DIR, "secrets"),
  join(STATE_DIR, "run"),
  join(STATE_DIR, "bin"),
  join(STATE_DIR, "workspaces"),
  join(STATE_DIR, "providers"),
  join(STATE_DIR, "vendor"),
];

const HEALTH_POLL_INTERVAL_MS = 5_000;
const HEALTH_POLL_TIMEOUT_MS = 300_000;
const READY_POLL_INTERVAL_MS = 2_000;
const READY_POLL_TIMEOUT_MS = 180_000;
const READY_REQUEST_TIMEOUT_MS = 5_000;
const SUPERVISOR_TERM_TIMEOUT_MS = 15_000;
const SUPERVISOR_KILL_GRACE_MS = 5_000;
const STOP_WATCHDOG_MS = 15_000;

const DEFAULT_PORTS = resolveDevStackPorts({});
const ports = resolveDevStackPorts(process.env);

function log(message) {
  process.stdout.write(`dev-stack: ${message}\n`);
}

function fail(message) {
  process.stderr.write(`dev-stack: ${message}\n`);
  process.exit(1);
}

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    if (error.code === "EPERM") return true;
    throw error;
  }
}

async function readSupervisorPid() {
  try {
    const text = await readFile(SUPERVISOR_PID_FILE, "utf8");
    const pid = Number.parseInt(text.trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function dockerBinaryAvailable() {
  for (const directory of (process.env.PATH ?? "").split(pathDelimiter)) {
    if (directory && existsSync(join(directory, "docker"))) {
      return true;
    }
  }
  return false;
}

// The child currently tracked for signal handling during the setup phases.
let currentChild = null;

function trackChild(child) {
  currentChild = child;
  return child;
}

/** Spawn with inherited stdio; reject with an Error naming the command. */
function run(command, args, options = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    let child;
    try {
      child = spawn(command, args, { stdio: "inherit", ...options });
    } catch (error) {
      rejectPromise(new Error(`${command} failed to start: ${error.message}`));
      return;
    }
    trackChild(child);
    const settle = (settlePromise, value) => {
      if (settled) return;
      settled = true;
      if (currentChild === child) currentChild = null;
      settlePromise(value);
    };
    child.once("error", (error) => {
      settle(rejectPromise, new Error(`${command} failed to start: ${error.message}`));
    });
    child.once("exit", (code, signal) => {
      if (code === 0) {
        settle(resolvePromise, undefined);
        return;
      }
      const detail = code !== null && code !== undefined ? `code ${code}` : `signal ${signal}`;
      settle(rejectPromise, new Error(`${command} ${args.join(" ")} exited with ${detail}`));
    });
  });
}

/** Like run(), but captures stdout (stderr still inherited) for polling. */
function runCapturing(command, args, options = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    let stdout = "";
    let child;
    try {
      child = spawn(command, args, { stdio: ["ignore", "pipe", "inherit"], ...options });
    } catch (error) {
      rejectPromise(new Error(`${command} failed to start: ${error.message}`));
      return;
    }
    trackChild(child);
    const settle = (settlePromise, value) => {
      if (settled) return;
      settled = true;
      if (currentChild === child) currentChild = null;
      settlePromise(value);
    };
    if (child.stdout) {
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
    }
    child.once("error", (error) => {
      settle(rejectPromise, new Error(`${command} failed to start: ${error.message}`));
    });
    child.once("exit", (code, signal) => {
      if (code === 0) {
        settle(resolvePromise, stdout);
        return;
      }
      const detail = code !== null && code !== undefined ? `code ${code}` : `signal ${signal}`;
      settle(rejectPromise, new Error(`${command} ${args.join(" ")} exited with ${detail}`));
    });
  });
}

/** Tolerates array, single-object and NDJSON `docker compose ps --format json` output. */
function parseComposePsOutput(text) {
  const trimmed = text.trim();
  if (!trimmed) return [];
  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) return parsed.filter(Boolean);
    return [parsed];
  } catch {
    const records = [];
    for (const line of trimmed.split(/\r?\n/)) {
      const segment = line.trim();
      if (!segment) continue;
      try {
        const parsed = JSON.parse(segment);
        if (Array.isArray(parsed)) records.push(...parsed);
        else records.push(parsed);
      } catch {
        // Ignore non-JSON noise between records.
      }
    }
    return records;
  }
}

// --- supervised children (api, web, worker, cli-host) -----------------------

const children = new Map();
let stopping = false;
let supervisorExitCode = null;
let signalMode = "setup";

function stopChildren(signal = "SIGTERM") {
  if (stopping) return;
  stopping = true;
  for (const child of children.values()) {
    try {
      child.kill(signal);
    } catch {
      // Already gone.
    }
  }
  // Watchdog so the supervisor can never hang on a child that ignores TERM.
  setTimeout(() => {
    for (const child of children.values()) {
      try {
        child.kill("SIGKILL");
      } catch {
        // Already gone.
      }
    }
  }, STOP_WATCHDOG_MS).unref();
}

function maybeExit() {
  if (stopping && children.size === 0) {
    process.exit(supervisorExitCode ?? 0);
  }
}

function handleSignal(signal) {
  if (signalMode !== "supervisor") {
    // Setup phase: kill the tracked child and exit promptly (non-zero) so a
    // follow-up `dev-stack down` can clean up.
    if (currentChild) {
      try {
        currentChild.kill(signal);
      } catch {
        // Already gone.
      }
    }
    process.exit(1);
  }
  if (stopping) {
    // Second signal: force out.
    process.exit(1);
  }
  stopChildren(signal);
}

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => handleSignal(signal));
}

/** Stream a child's output with a per-line `[name] ` prefix, buffering partials. */
function pipePrefixed(stream, prefix, destination) {
  if (!stream) return;
  let buffer = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    buffer += chunk;
    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      destination.write(`${prefix}${buffer.slice(0, newline)}\n`);
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
    }
  });
  stream.on("end", () => {
    if (buffer.length > 0) {
      destination.write(`${prefix}${buffer}\n`);
    }
    buffer = "";
  });
}

function attachSupervised(name, child) {
  children.set(name, child);
  child.once("error", (error) => {
    children.delete(name);
    process.stderr.write(`dev-stack: ${name} failed to start: ${error.message}\n`);
    supervisorExitCode = 1;
    stopChildren();
    maybeExit();
  });
  child.once("exit", (code, signal) => {
    children.delete(name);
    if (!stopping) {
      const detail = code !== null && code !== undefined ? `code ${code}` : `signal ${signal}`;
      process.stderr.write(`dev-stack: ${name} exited unexpectedly (${detail})\n`);
      supervisorExitCode = code || 1;
      stopChildren();
    }
    maybeExit();
  });
}

function spawnSupervised(name, command, args, options) {
  let child;
  try {
    child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], ...options });
  } catch (error) {
    process.stderr.write(`dev-stack: ${name} failed to start: ${error.message}\n`);
    process.exit(1);
  }
  pipePrefixed(child.stdout, `[${name}] `, process.stdout);
  pipePrefixed(child.stderr, `[${name}] `, process.stderr);
  attachSupervised(name, child);
  return child;
}

// --- shared up-flow helpers -------------------------------------------------

function devStackBaseEnv() {
  const env = { ...process.env, NODE_ENV: "development" };
  // dev:stack must not use the dev-login backdoor.
  delete env.SPACE_DEV_LOGIN;
  return env;
}

/** Generate the secret only when missing; always enforce 0600. */
async function ensureSecret(name, byteLength) {
  const path = join(STATE_DIR, "secrets", name);
  if (!existsSync(path)) {
    await writeFile(path, randomBytes(byteLength).toString("hex"), { mode: 0o600 });
  }
  await chmod(path, 0o600);
  return readFile(path, "utf8");
}

async function generateCliWrapper() {
  const template = await readFile(join(REPO_ROOT, "deploy/docker/public-cli-wrapper.sh"), "utf8");
  const wrapper = template
    .split("/var/lib/spaceapp-cli").join(STATE_DIR)
    .split("/app/deploy/docker/").join(`${REPO_ROOT}/deploy/docker/`)
    .replace(
      "set -euo pipefail",
      `set -euo pipefail\nexport PATH="${STATE_DIR}/vendor/opencode/node_modules/.bin:$PATH"`,
    );
  const wrapperPath = join(STATE_DIR, "bin", "opencode-vscode-parity");
  await writeFile(wrapperPath, wrapper, { mode: 0o755 });
  await chmod(wrapperPath, 0o755);
  return wrapperPath;
}

async function waitForHealthyContainers() {
  const services = ["postgres", "temporal"];
  const pending = new Set(services);
  const deadline = Date.now() + HEALTH_POLL_TIMEOUT_MS;
  while (pending.size > 0 && Date.now() < deadline) {
    let output = "";
    try {
      output = await runCapturing("docker", [...COMPOSE_ARGS, "ps", "--format", "json"]);
    } catch {
      // Transient compose failures right after `up -d` are expected; keep polling.
    }
    for (const record of parseComposePsOutput(output)) {
      if (services.includes(record?.Service) && String(record?.Health ?? "").toLowerCase() === "healthy") {
        pending.delete(record.Service);
      }
    }
    if (pending.size > 0) {
      await sleep(HEALTH_POLL_INTERVAL_MS);
    }
  }
  if (pending.size > 0) {
    for (const service of pending) {
      process.stderr.write(`dev-stack: ${service} did not become healthy within ${HEALTH_POLL_TIMEOUT_MS / 1000}s; last log lines:\n`);
      try {
        await run("docker", [...COMPOSE_ARGS, "logs", "--tail=50", service]);
      } catch {
        // The container may not exist at all; the timeout message says enough.
      }
    }
    throw new Error(`docker services did not become healthy: ${[...pending].join(", ")}`);
  }
}

async function waitForApiReady() {
  const url = `http://${DEV_STACK_BIND_HOST}:${ports.api}/readyz`;
  const deadline = Date.now() + READY_POLL_TIMEOUT_MS;
  do {
    if (stopping) {
      throw new Error("a supervised child exited before the API became ready");
    }
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(READY_REQUEST_TIMEOUT_MS) });
      if (response.ok) {
        const body = await response.json();
        if (body?.ok === true) return;
      }
    } catch {
      // Not up yet; keep polling.
    }
    await sleep(READY_POLL_INTERVAL_MS);
  } while (Date.now() < deadline);
  throw new Error(`API did not become ready within ${READY_POLL_TIMEOUT_MS / 1000}s`);
}

// --- commands ---------------------------------------------------------------

async function up() {
  // 1. Preconditions.
  const nodeMajor = Number.parseInt(process.versions.node.split(".")[0], 10);
  if (!Number.isInteger(nodeMajor) || nodeMajor < 20) {
    fail(`Node.js 20 or newer is required (found ${process.versions.node}).`);
  }
  try {
    await run("docker", ["info"], { stdio: "ignore" });
    await run("docker", ["compose", "version"], { stdio: "ignore" });
  } catch {
    fail(
      "Docker (with the compose plugin) is required but not available. Install Docker " +
      "(https://docs.docker.com/get-docker/) and start the Docker daemon, " +
      "then run this command again."
    );
  }

  // 2. Refuse when a supervisor is already running; drop a stale pid file.
  const supervisorPid = await readSupervisorPid();
  if (supervisorPid !== null) {
    if (isProcessAlive(supervisorPid)) {
      fail(`already running (pid ${supervisorPid}); run 'down' first.`);
    }
    await rm(SUPERVISOR_PID_FILE, { force: true });
  }

  // 3. Fail fast when the pinned digests drifted from the run-spaceapp template.
  const templateCompose = await readFile(TEMPLATE_COMPOSE_PATH, "utf8");
  const digestChecks = [
    ["postgres", "postgres", DEV_STACK_POSTGRES_IMAGE],
    ["temporal", "temporal", DEV_STACK_TEMPORAL_IMAGE],
  ];
  for (const [which, service, expectedImage] of digestChecks) {
    const actualImage = parseComposeServiceImage(templateCompose, service);
    if (actualImage !== expectedImage) {
      fail(`${which} image in ${TEMPLATE_COMPOSE_PATH} (${actualImage ?? "missing"}) does not match the digest-pinned constant; refusing to start`);
    }
  }
  const opencodePackage = parseOpencodePackage(await readFile(REPO_DOCKERFILE_PATH, "utf8"));
  if (!opencodePackage) {
    fail(`could not parse the pinned OpenCode CLI package from ${REPO_DOCKERFILE_PATH}; refusing to start`);
  }

  // 4. State directories.
  for (const directory of STATE_DIRECTORIES) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
  }

  // 5. Secrets (generated once, then locked down).
  const postgresPassword = await ensureSecret("postgres-password", 16);
  const sessionSecret = await ensureSecret("session-secret", 32);
  const setupToken = await ensureSecret("setup-token", 24);
  const databaseUrl = `postgres://postgres:${postgresPassword.trim()}@${DEV_STACK_BIND_HOST}:${ports.postgres}/postgres`;

  // 6. Compose file.
  await writeFile(COMPOSE_FILE, buildDevStackComposeYaml({ ports }));

  // 7. Containers.
  log(`starting ${DEV_STACK_PROJECT_NAME} containers (postgres host port ${ports.postgres}, temporal host port ${ports.temporal})...`);
  await run("docker", [...COMPOSE_ARGS, "up", "-d"]);
  log("waiting for postgres and temporal to report healthy...");
  await waitForHealthyContainers();

  // 8. Workspace build chain.
  log("building workspace packages...");
  for (const packageName of WORKSPACE_BUILD_ORDER) {
    log(`building ${packageName}...`);
    await run("npm", ["run", "build", "-w", packageName], { cwd: REPO_ROOT });
  }

  // 9. Vendored OpenCode CLI.
  const opencodeBin = join(STATE_DIR, "vendor", "opencode", "node_modules", ".bin", "opencode");
  if (!existsSync(opencodeBin)) {
    log(`installing ${opencodePackage} into ${join(STATE_DIR, "vendor", "opencode")}...`);
    await run(
      "npm",
      [
        "install",
        "--prefix", join(STATE_DIR, "vendor", "opencode"),
        "--no-audit",
        "--no-fund",
        opencodePackage,
      ],
      { cwd: REPO_ROOT },
    );
  }

  // 10. CLI wrapper.
  const wrapperPath = await generateCliWrapper();
  log(`generated ${wrapperPath}`);

  // 11. Migrations.
  log("running database migrations...");
  await run("npm", ["run", "db:migrate"], {
    cwd: REPO_ROOT,
    env: { ...process.env, SPACE_DATABASE_URL: databaseUrl },
  });

  // 12. Supervised children.
  const tsxBinary = join(REPO_ROOT, "node_modules", ".bin", "tsx");
  if (!existsSync(tsxBinary)) {
    fail(`${tsxBinary} is missing — run 'npm ci' in the repository root first.`);
  }
  const viteBinary = join(REPO_ROOT, "node_modules", ".bin", "vite");
  if (!existsSync(viteBinary)) {
    fail(`${viteBinary} is missing — run 'npm ci' in the repository root first.`);
  }
  const baseEnv = devStackBaseEnv();
  const temporalAddress = `${DEV_STACK_BIND_HOST}:${ports.temporal}`;
  const hostSocket = join(STATE_DIR, "run", "host.sock");

  signalMode = "supervisor";
  spawnSupervised("api", tsxBinary, ["watch", "src/server.ts"], {
    cwd: join(REPO_ROOT, "apps", "api"),
    env: {
      ...baseEnv,
      ...devStackChildProcessEnv(ports).api,
      SPACE_API_HOST: DEV_STACK_BIND_HOST,
      SPACE_RUNTIME_STORE: "postgres",
      SPACE_DATABASE_URL: databaseUrl,
      SPACE_SESSION_SECRET: sessionSecret,
      SPACE_SETUP_TOKEN_FILE: join(STATE_DIR, "secrets", "setup-token"),
      SPACE_TEMPORAL_ADDRESS: temporalAddress,
      SPACE_CLI_ENABLED: "true",
      SPACE_CLI_HOST_SOCKET: hostSocket,
      SPACE_CLI_COMMAND_PATH: join(STATE_DIR, "bin"),
      SPACE_CLI_WORKSPACE_ROOT: join(STATE_DIR, "workspaces"),
    },
  });
  spawnSupervised("web", viteBinary, ["--host", DEV_STACK_BIND_HOST, "--port", String(ports.web)], {
    cwd: join(REPO_ROOT, "apps", "web"),
    env: {
      ...baseEnv,
      ...devStackChildProcessEnv(ports).web,
    },
  });
  spawnSupervised("worker", process.execPath, [join(REPO_ROOT, "apps", "worker", "dist", "worker.js")], {
    cwd: join(REPO_ROOT, "apps", "worker"),
    env: {
      ...baseEnv,
      SPACE_TEMPORAL_ADDRESS: temporalAddress,
      SPACE_DATABASE_URL: databaseUrl,
    },
  });
  spawnSupervised("cli-host", process.execPath, [join(REPO_ROOT, "packages", "cli-host", "dist", "main.js")], {
    cwd: join(REPO_ROOT, "packages", "cli-host"),
    env: {
      ...baseEnv,
      SPACE_CLI_HOST_SOCKET: hostSocket,
    },
  });

  // 13. Readiness.
  try {
    await waitForApiReady();
  } catch (error) {
    supervisorExitCode = 1;
    process.stderr.write(`dev-stack: ${error?.message ?? "API did not become ready"}\n`);
    stopChildren();
    maybeExit();
    return;
  }

  // 14. Ready.
  process.stdout.write(
    [
      "dev-stack: ready",
      `  web: http://${DEV_STACK_BIND_HOST}:${ports.web}`,
      `  api: http://${DEV_STACK_BIND_HOST}:${ports.api}`,
      `  owner setup token: ${setupToken.trim()}`,
      "  claim it with: POST /api/setup/claim  (status: GET /api/setup/status)",
      "",
    ].join("\n"),
  );

  // 15. Block until all children exit (their handlers process.exit()).
  await writeFile(SUPERVISOR_PID_FILE, String(process.pid), { mode: 0o600 });
  await new Promise(() => {});
}

async function stopSupervisorProcess() {
  const pid = await readSupervisorPid();
  if (pid === null || !isProcessAlive(pid)) {
    log("no running supervisor found");
  } else {
    log(`stopping supervisor (pid ${pid})...`);
    process.kill(pid, "SIGTERM");
    const termDeadline = Date.now() + SUPERVISOR_TERM_TIMEOUT_MS;
    while (isProcessAlive(pid) && Date.now() < termDeadline) {
      await sleep(200);
    }
    if (isProcessAlive(pid)) {
      log(`supervisor (pid ${pid}) did not exit; sending SIGKILL...`);
      process.kill(pid, "SIGKILL");
      const killDeadline = Date.now() + SUPERVISOR_KILL_GRACE_MS;
      while (isProcessAlive(pid) && Date.now() < killDeadline) {
        await sleep(200);
      }
    }
  }
  await rm(SUPERVISOR_PID_FILE, { force: true }).catch(() => {});
}

async function composeDown(volumes) {
  if (!dockerBinaryAvailable() || !existsSync(COMPOSE_FILE)) {
    return;
  }
  const args = [...COMPOSE_ARGS, "down"];
  if (volumes) {
    args.push("-v");
  }
  try {
    await run("docker", args);
  } catch (error) {
    process.stderr.write(`dev-stack: warning: docker compose down failed: ${error.message}\n`);
  }
}

async function down() {
  await stopSupervisorProcess();
  await composeDown(false);
  log("stopped");
}

async function reset() {
  await down();
  await composeDown(true);
  if (existsSync(STATE_DIR)) {
    await rm(STATE_DIR, { recursive: true, force: true });
    log(`removed state directory ${STATE_DIR} (including the postgres-data volume contents and local secrets)`);
  }
}

async function probeReadyz() {
  try {
    const response = await fetch(`http://${DEV_STACK_BIND_HOST}:${ports.api}/readyz`, {
      signal: AbortSignal.timeout(READY_REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) return "ok: false";
    const body = await response.json();
    return `ok: ${body?.ok === true}`;
  } catch {
    return "unreachable";
  }
}

async function status() {
  log(`state dir: ${existsSync(STATE_DIR) ? STATE_DIR : "absent"}`);
  const pid = await readSupervisorPid();
  if (pid === null) {
    log("supervisor: not running (no pid file)");
  } else {
    log(`supervisor: pid ${pid} (${isProcessAlive(pid) ? "alive" : "dead"})`);
  }
  if (!dockerBinaryAvailable()) {
    log("docker: unavailable");
  } else if (!existsSync(COMPOSE_FILE)) {
    log("docker compose: not configured (no compose file)");
  } else {
    try {
      const output = await runCapturing("docker", [...COMPOSE_ARGS, "ps", "--format", "json"]);
      const records = parseComposePsOutput(output);
      if (records.length === 0) {
        log("docker compose: no services");
      }
      for (const record of records) {
        log(`docker compose ${record?.Service ?? "?"}: State=${record?.State ?? "?"} Health=${record?.Health ?? "?"}`);
      }
    } catch (error) {
      log(`docker compose ps failed: ${error.message}`);
    }
  }
  log(`readyz: ${await probeReadyz()}`);
}

function buildHelpText() {
  return [
    "Usage:",
    "  npm run dev:stack [-- <command>]",
    "  node scripts/dev-stack.mjs <command>",
    "",
    "Commands:",
    "  up        Start the dev stack (default): digest-pinned Postgres and",
    "            Temporal containers, workspace package builds, the vendored",
    "            OpenCode CLI, database migrations and the supervised API,",
    "            worker, web and CLI host dev servers.",
    "  down      Stop the supervised dev servers and the Docker stack.",
    "  reset     down, then delete the Postgres and Temporal volumes and",
    "            remove the local dev-stack state directory.",
    "  status    Report state directory, supervisor pid, container health",
    "            and API readiness. Always exits 0.",
    "  --help    Show this help.",
    "",
    "Port overrides (everything binds to 127.0.0.1):",
    `  SPACE_DEV_STACK_API_PORT      default ${DEFAULT_PORTS.api}`,
    `  SPACE_DEV_STACK_WEB_PORT      default ${DEFAULT_PORTS.web}`,
    `  SPACE_DEV_STACK_POSTGRES_PORT default ${DEFAULT_PORTS.postgres}`,
    `  SPACE_DEV_STACK_TEMPORAL_PORT default ${DEFAULT_PORTS.temporal}`,
    "",
    `State directory: ${STATE_DIR} (git-ignored; holds generated secrets)`,
    `Compose project: ${DEV_STACK_PROJECT_NAME}`,
    "",
    "Hot reload & rebuilds:",
    "  apps/api/src  -> tsx watch restarts the API automatically",
    "  apps/web/src  -> Vite HMR reloads the browser",
    "  packages/*    -> changes need a rebuild:",
    "                     npm run build -w @space/<name>",
    "                     (e.g. @space/cli-host, @space/db)",
    "  dev-stack's own build chain (run on every up), each as",
    "  `npm run build -w <pkg>`, in this order:",
    `    ${WORKSPACE_BUILD_ORDER.join(" ")}`,
    "",
  ].join("\n");
}

async function main(argv) {
  const command = argv[0] ?? "up";
  if (command === "up") {
    await up();
  } else if (command === "down") {
    await down();
  } else if (command === "reset") {
    await reset();
  } else if (command === "status") {
    await status();
  } else if (command === "--help" || command === "-h") {
    process.stdout.write(buildHelpText());
  } else {
    process.stderr.write(`dev-stack: unknown command: ${command}\n\n${buildHelpText()}`);
    process.exit(2);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`dev-stack: ${error?.message ?? error}\n`);
    process.exit(1);
  }
}
