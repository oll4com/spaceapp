#!/usr/bin/env node
/**
 * dev-stack — run the full SpaceApp from source with one command.
 *
 *   npm run dev:stack            start everything (Docker data services,
 *                                migrations, API, web, worker, CLI host)
 *   npm run dev:stack -- down    stop everything this command started
 *   npm run dev:stack -- reset   stop it and remove only what it created
 *   npm run dev:stack -- status  show what is running
 *
 * Design notes
 * ------------
 * - The Docker services (PostgreSQL with pgvector, Temporal) use the exact
 *   images pinned by digest in packages/run-spaceapp/templates/compose.yml.
 *   The digests are parsed out of that file at runtime — never copied here —
 *   and a missing or unpinned image fails the start with a clear error.
 * - The pinned opencode-ai version is likewise parsed out of the Dockerfile
 *   and installed into the state directory, never globally.
 * - Everything this command creates lives in one git-ignored state directory
 *   (.dev-stack/): secrets, the rendered compose file, logs, pid records,
 *   the OpenCode install, the `*-vscode-parity` wrapper commands, provider
 *   state, workspaces and the API's data roots.
 * - The stack runs as the repository's isolated "dev" instance
 *   (SPACE_INSTANCE=dev): its own database, Temporal namespace and task
 *   queue, its own CLI host socket and ports that never collide with an
 *   installed SpaceApp on 4910/4911. Every port binds to 127.0.0.1 only.
 * - Secrets are generated per state directory. Files are mode 0600 inside a
 *   0700 directory, are never printed (the one exception is the one-time
 *   owner setup token, which the owner needs to claim the instance) and are
 *   reused — not regenerated — by later starts against the same state.
 */
import { spawn, execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { watch as fsWatch } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const COMPOSE_PROJECT = "spaceapp-dev-stack";
export const DEV_DATABASE_NAME = "spaceapp_dev";
export const DEV_TEMPORAL_NAMESPACE = "spaceapp-dev";
export const DEV_TEMPORAL_TASK_QUEUE = "space-agent-turns-dev";
export const DEFAULT_PORTS = Object.freeze({
  api: 5910,
  web: 5911,
  postgres: 55432,
  temporal: 57233
});
const INSTALL_PORTS = new Set([4910, 4911]);
const SECRET_FILES = ["postgres-password", "session-secret", "setup-token"];

/** Library/app workspaces whose dist output the from-source processes load, in build order. */
export const BUILD_WORKSPACES = Object.freeze([
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
  "@space/worker"
]);

export function repoRoot(fromUrl = import.meta.url) {
  return resolve(dirname(fileURLToPath(fromUrl)), "..");
}

function portFromEnv(env, name, fallback) {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error(`${name} must be an integer TCP port, got "${raw}".`);
  }
  return value;
}

export function resolveConfig(env = process.env, root = repoRoot()) {
  const stateDir = env.SPACE_DEV_STATE_DIR
    ? resolve(env.SPACE_DEV_STATE_DIR)
    : join(root, ".dev-stack");
  const ports = {
    api: portFromEnv(env, "SPACE_DEV_API_PORT", DEFAULT_PORTS.api),
    web: portFromEnv(env, "SPACE_DEV_WEB_PORT", DEFAULT_PORTS.web),
    postgres: portFromEnv(env, "SPACE_DEV_POSTGRES_PORT", DEFAULT_PORTS.postgres),
    temporal: portFromEnv(env, "SPACE_DEV_TEMPORAL_PORT", DEFAULT_PORTS.temporal)
  };
  for (const [name, port] of Object.entries(ports)) {
    if (INSTALL_PORTS.has(port)) {
      throw new Error(
        `SPACE_DEV_${name.toUpperCase()}_PORT=${port} collides with an installed SpaceApp ` +
          "(4910/4911). Pick a different port — isolation from the install is the point of this stack."
      );
    }
  }
  const seen = new Map();
  for (const [name, port] of Object.entries(ports)) {
    if (seen.has(port)) {
      throw new Error(`Dev-stack ports must be distinct: ${seen.get(port)} and ${name} both use ${port}.`);
    }
    seen.set(port, name);
  }
  return { root, stateDir, ports, project: COMPOSE_PROJECT };
}

/**
 * Extract the digest-pinned images for the postgres and temporal services
 * from the run-spaceapp compose template. Fails closed: a service whose
 * image is missing, or not pinned by a full sha256 digest, is an error —
 * the dev stack must never silently run a different image than an install.
 */
export function parsePinnedImages(composeText) {
  const images = {};
  let service = null;
  for (const line of composeText.split("\n")) {
    const serviceMatch = /^ {2}([a-z0-9-]+):\s*$/.exec(line);
    if (serviceMatch) {
      service = serviceMatch[1];
      continue;
    }
    if (/^ {2}\S/.test(line)) service = null;
    const imageMatch = /^ {4}image:\s*(\S+)\s*$/.exec(line);
    if (imageMatch && (service === "postgres" || service === "temporal")) {
      images[service] = imageMatch[1];
    }
  }
  for (const name of ["postgres", "temporal"]) {
    const image = images[name];
    if (!image) throw new Error(`compose template does not declare an image for service "${name}".`);
    if (!/@sha256:[0-9a-f]{64}$/.test(image)) {
      throw new Error(
        `compose template image for "${name}" is not pinned by digest (${image}). ` +
          "The dev stack only runs digest-pinned images; pin it in packages/run-spaceapp/templates/compose.yml first."
      );
    }
  }
  return images;
}

/** Extract the pinned opencode-ai version from the Dockerfile's global install line. */
export function parseOpencodePin(dockerfileText) {
  const match = /opencode-ai@(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/.exec(dockerfileText);
  if (!match) {
    throw new Error("Could not find the pinned opencode-ai version in the Dockerfile.");
  }
  return match[1];
}

/**
 * Generate the per-state-directory secrets, or read the existing ones.
 * Directory mode 0700, file mode 0600, on every call (including reuse), so a
 * state directory created by an older version is tightened in place.
 * Returns the secret values; callers must never print them (setup token
 * excepted — it is the owner's one-time claim credential).
 */
export function ensureSecrets(stateDir) {
  const secretsDir = join(stateDir, "secrets");
  mkdirSync(secretsDir, { recursive: true, mode: 0o700 });
  chmodSync(secretsDir, 0o700);
  const values = {};
  for (const name of SECRET_FILES) {
    const file = join(secretsDir, name);
    if (existsSync(file)) {
      values[name] = readFileSync(file, "utf8").trim();
    } else {
      values[name] = randomBytes(32).toString("hex");
      writeFileSync(file, values[name], { mode: 0o600 });
    }
    chmodSync(file, 0o600);
  }
  return {
    dir: secretsDir,
    postgresPassword: values["postgres-password"],
    sessionSecret: values["session-secret"],
    setupToken: values["setup-token"],
    file: (name) => join(secretsDir, name)
  };
}

export function databaseUrl(cfg, postgresPassword) {
  return `postgres://spaceapp:${postgresPassword}@127.0.0.1:${cfg.ports.postgres}/${DEV_DATABASE_NAME}`;
}

/**
 * Unix socket paths are length-limited (~107 bytes on Linux). Keep the CLI
 * host socket inside the state directory unless that path would be too long
 * (deeply nested checkouts), in which case use a short per-checkout tmp path.
 */
export function cliSocketPath(cfg) {
  const inState = join(cfg.stateDir, "run", "cli-host.sock");
  if (Buffer.byteLength(inState) <= 100) return inState;
  const hash = createHash("sha256").update(cfg.root).digest("hex").slice(0, 12);
  return join(tmpdir(), `spaceapp-dev-${hash}`, "cli-host.sock");
}

/**
 * Render the dev stack's compose file. Only the postgres and temporal
 * services run in Docker; everything else runs from source.
 *
 * Password delivery differs from the install template on purpose. The
 * template mounts the password as a compose secret file — but a compose
 * secret is a bind mount, so the container sees the host file's owner and
 * mode, and a 0600 file owned by the developer is unreadable by the
 * Temporal image's non-root user (PostgreSQL, whose entrypoint starts as
 * root, reads it fine; Temporal gets "Permission denied" and then fails
 * password authentication — verified against the real images). Loosening
 * the file to 0644 would break this stack's secret rule, so the
 * orchestrator reads the 0600 file itself and hands the value to both
 * containers through the Compose process environment. The rendered file
 * therefore contains only the interpolation placeholder — never the
 * password — and the secret on disk stays 0600.
 */
export function renderCompose(cfg, images) {
  return [
    `name: ${cfg.project}`,
    "",
    "services:",
    "  postgres:",
    `    image: ${images.postgres}`,
    "    environment:",
    `      POSTGRES_DB: ${DEV_DATABASE_NAME}`,
    "      POSTGRES_USER: spaceapp",
    "      POSTGRES_PASSWORD: ${SPACEAPP_DEV_POSTGRES_PASSWORD}",
    "    ports:",
    `      - "127.0.0.1:${cfg.ports.postgres}:5432"`,
    "    volumes:",
    "      - postgres-data:/var/lib/postgresql/data",
    "    healthcheck:",
    '      test: ["CMD-SHELL", "pg_isready -U spaceapp -d ' + DEV_DATABASE_NAME + '"]',
    "      interval: 5s",
    "      timeout: 5s",
    "      retries: 24",
    "",
    "  temporal:",
    `    image: ${images.temporal}`,
    "    depends_on:",
    "      postgres:",
    "        condition: service_healthy",
    "    environment:",
    "      DB: postgres12",
    "      DB_PORT: 5432",
    "      POSTGRES_USER: spaceapp",
    "      POSTGRES_SEEDS: postgres",
    "      POSTGRES_PWD: ${SPACEAPP_DEV_POSTGRES_PASSWORD}",
    "      DYNAMIC_CONFIG_FILE_PATH: config/dynamicconfig/docker.yaml",
    "    command:",
    "      - autosetup",
    "    ports:",
    `      - "127.0.0.1:${cfg.ports.temporal}:7233"`,
    "    healthcheck:",
    '      test: ["CMD-SHELL", "temporal operator cluster health --address temporal:7233 >/dev/null && temporal operator namespace describe --namespace default --address temporal:7233 >/dev/null"]',
    "      interval: 10s",
    "      timeout: 10s",
    "      retries: 18",
    "",
    "volumes:",
    "  postgres-data:",
    ""
  ].join("\n");
}

function statePaths(cfg) {
  const s = cfg.stateDir;
  return {
    memory: join(s, "memory"),
    memoryGraph: join(s, "memory-graph"),
    artifacts: join(s, "artifacts"),
    telegram: join(s, "telegram"),
    telegramManifest: join(s, "integrations", "telegram", "thread-ownership.json"),
    workspaces: join(s, "workspaces"),
    bin: join(s, "bin"),
    providers: join(s, "providers"),
    logs: join(s, "logs"),
    run: join(s, "run"),
    appDiagnostics: join(s, "var", "app-diagnostics"),
    maintenanceStateFile: join(s, "var", "maintenance-autopilot", "state.json"),
    streamingSecrets: join(s, "var", "streaming-secrets"),
    demoProjects: join(s, "demos"),
    demoProjectsVar: join(s, "var", "demo-projects"),
    projects: join(s, "projects"),
    personalGit: join(s, "var", "personal-source-control")
  };
}

/** Environment shared by the API and the worker (the isolated dev instance). */
function instanceEnv(cfg, secrets) {
  const p = statePaths(cfg);
  return {
    SPACE_INSTANCE: "dev",
    SPACE_INSTALL_ROOT: cfg.root,
    SPACE_RUNTIME_STORE: "postgres",
    // The isolation guard checks SPACE_API_PORT for every role, worker
    // included: unset reads as the stable 4910 and refuses to start.
    SPACE_API_PORT: String(cfg.ports.api),
    SPACE_DATABASE_URL: databaseUrl(cfg, secrets.postgresPassword),
    SPACE_TEMPORAL_ADDRESS: `127.0.0.1:${cfg.ports.temporal}`,
    SPACE_TEMPORAL_NAMESPACE: DEV_TEMPORAL_NAMESPACE,
    SPACE_TEMPORAL_TASK_QUEUE: DEV_TEMPORAL_TASK_QUEUE,
    SPACEAPP_WORKFLOWS_ENABLED: "true",
    SPACE_MEMORY_ROOT: p.memory,
    SPACE_MEMORY_GRAPH_ROOT: p.memoryGraph,
    SPACE_GEMINI_MEMORY_INDEX_PATH: join(p.memory, "gemini_history.md"),
    SPACE_GEMINI_MEMORY_MONTHLY_PATH: join(p.memory, "gemini_history_monthly.md"),
    SPACE_GEMINI_MEMORY_LOCK_PATH: join(p.memory, ".memory.lock"),
    SPACE_ARTIFACT_ROOT: p.artifacts,
    SPACE_TELEGRAM_SECRET_ROOT: p.telegram,
    SPACE_TELEGRAM_OWNERSHIP_MANIFEST: p.telegramManifest,
    // Every other writable root the API config parks under /opt/spaceapp by
    // default. A from-source checkout cannot write there (on macOS /opt is
    // root-owned and the API dies at boot: AppDiagnosticsService.initialize
    // mkdirs its root eagerly), so the whole set lives in the state dir.
    SPACE_APP_DIAGNOSTICS_ROOT: p.appDiagnostics,
    SPACE_MAINTENANCE_AUTOPILOT_STATE_FILE: p.maintenanceStateFile,
    SPACE_STREAMING_SECRET_ROOT: p.streamingSecrets,
    SPACE_DEMO_PROJECTS_ROOT: p.demoProjects,
    SPACE_DEMO_PROJECTS_VAR_ROOT: p.demoProjectsVar,
    SPACE_PROJECTS_ROOT: p.projects,
    SPACE_PERSONAL_GIT_ROOT: p.personalGit
  };
}

export function buildApiEnv(cfg, secrets) {
  const p = statePaths(cfg);
  return {
    ...instanceEnv(cfg, secrets),
    SPACE_SESSION_SECRET: secrets.sessionSecret,
    SPACE_SETUP_TOKEN_FILE: secrets.file("setup-token"),
    SPACE_DEV_LOGIN: "false",
    SPACE_API_HOST: "127.0.0.1",
    SPACE_API_PORT: String(cfg.ports.api),
    SPACE_API_ORIGIN: `http://127.0.0.1:${cfg.ports.api}`,
    SPACE_WEB_HOST: "127.0.0.1",
    SPACE_WEB_PORT: String(cfg.ports.web),
    SPACE_STARTER_MEMORY_ROOT: join(cfg.root, "starter-memory"),
    SPACE_CLI_ENABLED: "true",
    SPACE_CLI_HOST_SOCKET: cliSocketPath(cfg),
    SPACE_CLI_COMMAND_PATH: p.bin,
    SPACE_CLI_WORKSPACE_ROOT: p.workspaces,
    SPACE_CODEX_HOME: join(p.providers, "codex"),
    SPACE_CODEX_APP_SERVER_HOME: join(p.providers, "codex"),
    SPACE_BROWSER_SESSIONS_ENABLED: "false"
  };
}

export function buildWorkerEnv(cfg, secrets) {
  return { ...instanceEnv(cfg, secrets) };
}

export function buildCliHostEnv(cfg) {
  const p = statePaths(cfg);
  return {
    SPACE_CLI_HOST_SOCKET: cliSocketPath(cfg),
    SPACE_MEMORY_ROOT: p.memory,
    SPACE_CLI_WORKSPACE_ROOT: p.workspaces
  };
}

export function buildWebEnv(cfg) {
  return {
    SPACE_API_PORT: String(cfg.ports.api),
    SPACE_API_ORIGIN: `http://127.0.0.1:${cfg.ports.api}`,
    SPACE_WEB_HOST: "127.0.0.1",
    SPACE_WEB_PORT: String(cfg.ports.web)
  };
}

// ---------------------------------------------------------------------------
// Process and Docker plumbing
// ---------------------------------------------------------------------------

const log = (message) => console.log(`dev-stack: ${message}`);
const fail = (message) => console.error(`dev-stack: ERROR ${message}`);

async function run(command, args, options = {}) {
  const { cwd, env, capture = false } = options;
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd,
      env: env ?? process.env,
      stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit"
    });
    let stdout = "";
    let stderr = "";
    if (capture) {
      child.stdout.on("data", (chunk) => (stdout += chunk));
      child.stderr.on("data", (chunk) => (stderr += chunk));
    }
    child.on("error", rejectPromise);
    child.on("exit", (code, signal) => {
      if (code === 0) resolvePromise({ stdout, stderr });
      else rejectPromise(new Error(`${command} ${args.join(" ")} exited ${code ?? signal}.\n${stderr || stdout}`));
    });
  });
}

async function dockerOk(args, options = {}) {
  try {
    return await run("docker", args, { ...options, capture: true });
  } catch (error) {
    if (options.daemonCheck) {
      throw new Error(
        "Docker is required for the dev stack's PostgreSQL and Temporal services but did not answer. " +
          "Start Docker Desktop (macOS/Windows WSL2) or the Docker daemon / Colima, then retry.\n" +
          String(error.message ?? error)
      );
    }
    throw error;
  }
}

function composeArgs(cfg) {
  return ["compose", "-f", join(cfg.stateDir, "docker-compose.yml"), "-p", cfg.project];
}

/**
 * The environment for docker compose invocations: the rendered compose file
 * interpolates the database password from SPACEAPP_DEV_POSTGRES_PASSWORD,
 * which the orchestrator sources from the 0600 secret file. The value is
 * passed only through the process environment — never written to a file,
 * never printed.
 */
function composeEnv(cfg) {
  const file = join(cfg.stateDir, "secrets", "postgres-password");
  if (!existsSync(file)) return process.env;
  return { ...process.env, SPACEAPP_DEV_POSTGRES_PASSWORD: readFileSync(file, "utf8").trim() };
}

function isAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function killGroup(pid, signal) {
  try {
    process.kill(-pid, signal);
    return true;
  } catch {
    try {
      process.kill(pid, signal);
      return true;
    } catch {
      return false;
    }
  }
}

async function waitFor(predicate, timeoutMs, intervalMs, description) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      if (await predicate()) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`Timed out waiting for ${description}${lastError ? `: ${lastError.message}` : ""}`);
}

async function fetchJson(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error(`${url} answered HTTP ${response.status}`);
  return response.json();
}

function processesFile(cfg) {
  return join(cfg.stateDir, "run", "processes.json");
}

function readProcesses(cfg) {
  try {
    return JSON.parse(readFileSync(processesFile(cfg), "utf8"));
  } catch {
    return [];
  }
}

function writeProcesses(cfg, processes) {
  mkdirSync(join(cfg.stateDir, "run"), { recursive: true });
  writeFileSync(processesFile(cfg), JSON.stringify(processes, null, 2));
}

/**
 * Start one supervised child in its own process group, tee its output to a
 * log file and to this process's stdout with a name prefix. If the child
 * exits while the stack is supposed to be up, that is a loud failure, never
 * a silent hang: the supervisor callback fires.
 */
class Supervisor {
  constructor(cfg, onUnexpectedExit) {
    this.cfg = cfg;
    this.onUnexpectedExit = onUnexpectedExit;
    this.children = new Map();
    this.shuttingDown = false;
    this.silenced = new Set();
  }

  start(name, command, args, { cwd, env }) {
    const logsDir = join(this.cfg.stateDir, "logs");
    mkdirSync(logsDir, { recursive: true });
    const logStream = createWriteStream(join(logsDir, `${name}.log`), { flags: "a" });
    const child = spawn(command, args, {
      cwd,
      env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    const tee = (stream, target) => {
      let buffer = "";
      stream.on("data", (chunk) => {
        logStream.write(chunk);
        buffer += chunk.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) target.write(`[${name}] ${line}\n`);
      });
    };
    tee(child.stdout, process.stdout);
    tee(child.stderr, process.stderr);
    child.on("error", (error) => {
      if (!this.shuttingDown) this.onUnexpectedExit(name, null, `spawn failed: ${error.message}`);
    });
    const record = { name, pid: child.pid, pgid: child.pid, command: [command, ...args].join(" ") };
    this.children.set(name, { child, record });
    writeProcesses(this.cfg, [...this.children.values()].map((c) => c.record));
    child.on("exit", (code, signal) => {
      this.children.delete(name);
      writeProcesses(this.cfg, [...this.children.values()].map((c) => c.record));
      if (this.silenced.has(name)) {
        this.silenced.delete(name);
        return;
      }
      if (!this.shuttingDown) this.onUnexpectedExit(name, code, signal);
    });
    return child;
  }

  /** Restart one child without tripping the unexpected-exit callback. */
  async restart(name, startFn) {
    const current = this.children.get(name);
    if (!current) {
      startFn();
      return;
    }
    this.silenced.add(name);
    killGroup(current.record.pgid, "SIGTERM");
    const deadline = Date.now() + 10_000;
    while (this.children.has(name) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 150));
    }
    if (this.children.has(name)) {
      killGroup(current.record.pgid, "SIGKILL");
      await new Promise((r) => setTimeout(r, 300));
    }
    this.silenced.delete(name);
    startFn();
  }

  async stopAll() {
    this.shuttingDown = true;
    const entries = [...this.children.values()];
    for (const { record } of entries) killGroup(record.pgid, "SIGTERM");
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && entries.some(({ record }) => isAlive(record.pid))) {
      await new Promise((r) => setTimeout(r, 200));
    }
    for (const { record } of entries) {
      if (isAlive(record.pid)) killGroup(record.pgid, "SIGKILL");
    }
    this.children.clear();
    writeProcesses(this.cfg, []);
  }
}

async function stopRecordedProcesses(cfg) {
  const recorded = readProcesses(cfg);
  for (const record of recorded) {
    if (isAlive(record.pid)) killGroup(record.pgid, "SIGTERM");
  }
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline && recorded.some((r) => isAlive(r.pid))) {
    await new Promise((r) => setTimeout(r, 200));
  }
  for (const record of recorded) {
    if (isAlive(record.pid)) killGroup(record.pgid, "SIGKILL");
  }
  writeProcesses(cfg, []);
  return recorded.length;
}

// ---------------------------------------------------------------------------
// Build steps
// ---------------------------------------------------------------------------

function newestMtime(dir) {
  let newest = 0;
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) stack.push(path);
      else {
        try {
          newest = Math.max(newest, statSync(path).mtimeMs);
        } catch {
          /* raced deletion; ignore */
        }
      }
    }
  }
  return newest;
}

function workspaceDir(root, workspaceName) {
  const groups = ["packages", "apps"];
  for (const group of groups) {
    const base = join(root, group);
    let entries = [];
    try {
      entries = readdirSync(base, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const pkgFile = join(base, entry.name, "package.json");
      try {
        if (JSON.parse(readFileSync(pkgFile, "utf8")).name === workspaceName) {
          return join(base, entry.name);
        }
      } catch {
        /* not a workspace package.json */
      }
    }
  }
  throw new Error(`Workspace ${workspaceName} not found under packages/ or apps/.`);
}

function distIsFresh(dir) {
  const dist = join(dir, "dist");
  if (!existsSync(dist)) return false;
  return newestMtime(join(dir, "src")) <= statSync(dist).mtimeMs;
}

async function buildWorkspaces(cfg, { force = false } = {}) {
  for (const name of BUILD_WORKSPACES) {
    const dir = workspaceDir(cfg.root, name);
    if (!force && distIsFresh(dir)) continue;
    log(`building ${name}...`);
    await run("npm", ["run", "build", "-w", name], { cwd: cfg.root });
  }
}

async function buildWorkspaceByName(cfg, name) {
  await run("npm", ["run", "build", "-w", name], { cwd: cfg.root, capture: true });
}

// ---------------------------------------------------------------------------
// OpenCode: pinned install into the state directory + the parity wrapper
// ---------------------------------------------------------------------------

export function renderOpencodeWrapper(cfg) {
  const state = cfg.stateDir;
  const providerRoot = join(state, "providers", "opencode");
  const binDir = join(state, "opencode", "node_modules", ".bin");
  return `#!/usr/bin/env bash
# Generated by scripts/dev-stack.mjs — the from-source equivalent of
# deploy/docker/public-cli-wrapper.sh for the OpenCode runtime only.
# Provider state, config and the OpenCode install itself all live inside
# the dev stack's state directory; nothing is installed or written globally.
set -euo pipefail
state_root="${providerRoot}"
export HOME="$state_root"
export XDG_CONFIG_HOME="$state_root/config"
export XDG_DATA_HOME="$state_root/data"
export XDG_CACHE_HOME="$state_root/cache"
export XDG_STATE_HOME="$state_root/state"
export TMPDIR="$state_root/tmp"
export PATH="${binDir}:$PATH"
umask 077
mkdir -p "$HOME" "$TMPDIR" "$XDG_CONFIG_HOME" "$XDG_DATA_HOME" "$XDG_CACHE_HOME" "$XDG_STATE_HOME"
if [ "\${1:-}" = "--run-inner" ]; then shift; fi
hash_of() { (sha256sum 2>/dev/null || shasum -a 256) | cut -d ' ' -f 1; }
case "\${1:-}" in
  credential-status)
    if command -v opencode >/dev/null 2>&1; then printf 'READY\n'; exit 0; fi
    printf 'NOT_READY\n'; exit 1 ;;
  credential-observation)
    command -v opencode >/dev/null 2>&1 || exit 1
    printf 'OBSERVATION:%s\n' "$(printf '%s' 'opencode:ready' | hash_of)"; exit 0 ;;
  credential-smoke)
    command -v opencode >/dev/null 2>&1 || exit 1
    opencode --version >/dev/null 2>&1 || exit 1
    printf 'SPACE_OPENCODE_OK\n'; exit 0 ;;
  inspect-env)
    printf 'runtime=opencode\nhome=isolated\ncredential=%s\n' "$(command -v opencode >/dev/null 2>&1 && printf present || printf absent)"
    exit 0 ;;
esac
if ! command -v opencode >/dev/null 2>&1; then
  echo "opencode is not installed in the dev stack state directory. Run: npm run dev:stack" >&2
  exit 69
fi
exec opencode "$@"
`;
}

/**
 * node-pty's published macOS prebuilds ship `spawn-helper` without the
 * execute bit, and node-pty execs that helper for every PTY spawn — so on
 * macOS every CLI pane spawn fails with EACCES and the session sits IDLE
 * forever (seen in fork CI run 38957388065: attach succeeded, the host
 * never registered a session). Linux does not use the helper. Repair the
 * bit in place; it is the checkout's own dependency tree, nothing global.
 */
export function ensurePtySpawnHelpers(cfg, platform = process.platform) {
  if (platform !== "darwin") return [];
  const repaired = [];
  const candidates = [
    join(cfg.root, "node_modules", "node-pty", "prebuilds"),
    join(cfg.root, "packages", "cli-host", "node_modules", "node-pty", "prebuilds")
  ];
  for (const prebuilds of candidates) {
    if (!existsSync(prebuilds)) continue;
    for (const entry of readdirSync(prebuilds)) {
      if (!entry.startsWith("darwin")) continue;
      const helper = join(prebuilds, entry, "spawn-helper");
      if (!existsSync(helper)) continue;
      if ((statSync(helper).mode & 0o111) === 0) {
        chmodSync(helper, 0o755);
        repaired.push(helper);
      }
    }
  }
  return repaired;
}

async function ensureOpencode(cfg, version) {
  const installDir = join(cfg.stateDir, "opencode");
  const binary = join(installDir, "node_modules", ".bin", "opencode");
  if (!existsSync(binary)) {
    log(`installing opencode-ai@${version} into the state directory (not global)...`);
    mkdirSync(installDir, { recursive: true });
    await run("npm", ["install", "--prefix", installDir, "--no-audit", "--no-fund", `opencode-ai@${version}`], {
      cwd: cfg.root
    });
  }
  const binDir = join(cfg.stateDir, "bin");
  mkdirSync(binDir, { recursive: true });
  const wrapperPath = join(binDir, "opencode-vscode-parity");
  writeFileSync(wrapperPath, renderOpencodeWrapper(cfg), { mode: 0o755 });
  chmodSync(wrapperPath, 0o755);
  return binary;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

import { createServer } from "node:net";
import { copyFileSync } from "node:fs";

function portIsFree(port) {
  return new Promise((resolvePromise) => {
    const server = createServer();
    server.once("error", () => resolvePromise(false));
    server.listen(port, "127.0.0.1", () => server.close(() => resolvePromise(true)));
  });
}

async function assertPortsFree(cfg) {
  const names = { api: "SPACE_DEV_API_PORT", web: "SPACE_DEV_WEB_PORT", postgres: "SPACE_DEV_POSTGRES_PORT", temporal: "SPACE_DEV_TEMPORAL_PORT" };
  for (const [name, port] of Object.entries(cfg.ports)) {
    if (!(await portIsFree(port))) {
      throw new Error(
        `Port ${port} (${name}) is already in use. Stop what is using it or set ${names[name]} to a free port.`
      );
    }
  }
}

function seedStarterMemory(cfg) {
  const p = statePaths(cfg);
  mkdirSync(p.memory, { recursive: true });
  const starter = join(cfg.root, "starter-memory");
  for (const file of ["gemini_history.md", "gemini_history_monthly.md", "installation-guide.md"]) {
    const target = join(p.memory, file);
    const source = join(starter, file);
    if (!existsSync(target) && existsSync(source)) {
      copyFileSync(source, target);
      chmodSync(target, 0o600);
    }
  }
}

async function ensureTemporalNamespace(cfg) {
  const args = [...composeArgs(cfg), "exec", "-T", "temporal"];
  const describe = ["temporal", "operator", "namespace", "describe", "--namespace", DEV_TEMPORAL_NAMESPACE, "--address", "temporal:7233"];
  try {
    await run("docker", [...args, ...describe], { capture: true, env: composeEnv(cfg) });
    return;
  } catch {
    /* namespace does not exist yet — create it below */
  }
  await run(
    "docker",
    [...args, "temporal", "operator", "namespace", "create", "--namespace", DEV_TEMPORAL_NAMESPACE, "--address", "temporal:7233"],
    { capture: true, env: composeEnv(cfg) }
  );
  log(`created Temporal namespace "${DEV_TEMPORAL_NAMESPACE}" in the dev stack's Temporal.`);
}

/**
 * Hot reload for packages/*: watch the library sources, rebuild the changed
 * package, then restart the processes that load its dist output. A change
 * under apps/api/src is handled by tsx watch, and under apps/web/src by
 * Vite's HMR; neither needs this watcher.
 */
function startPackageWatcher(cfg, supervisor, starters) {
  const packagesDir = join(cfg.root, "packages");
  const dirToWorkspace = new Map();
  for (const name of BUILD_WORKSPACES) {
    const dir = workspaceDir(cfg.root, name);
    if (dir.startsWith(packagesDir)) dirToWorkspace.set(dir, name);
  }
  const timers = new Map();
  let rebuilding = Promise.resolve();
  const schedule = (workspaceName) => {
    if (timers.has(workspaceName)) clearTimeout(timers.get(workspaceName));
    timers.set(
      workspaceName,
      setTimeout(() => {
        timers.delete(workspaceName);
        rebuilding = rebuilding.then(async () => {
          log(`packages change detected — rebuilding ${workspaceName}...`);
          try {
            await buildWorkspaceByName(cfg, workspaceName);
          } catch (error) {
            fail(`rebuild of ${workspaceName} failed: ${error.message}`);
            return;
          }
          for (const name of ["worker", "cli-host", "api"]) {
            await supervisor.restart(name, starters[name]);
          }
          log(`${workspaceName} rebuilt and dependent processes restarted.`);
        });
      }, 1200)
    );
  };
  let watcher;
  try {
    watcher = fsWatch(packagesDir, { recursive: true }, (_event, filename) => {
      if (!filename) return;
      const normalized = filename.replaceAll("\\", "/");
      if (!/\/src\/.*\.(ts|tsx|mts|cts)$/.test(`/${normalized}`)) return;
      const pkgDirName = normalized.split("/")[0];
      const workspaceName = dirToWorkspace.get(join(packagesDir, pkgDirName));
      if (workspaceName) schedule(workspaceName);
    });
  } catch {
    log("WARNING: recursive file watching is unavailable on this platform; packages/* changes need a manual rebuild (npm run build -w <package>) and a stack restart.");
    return null;
  }
  watcher.on("error", () => {});
  return watcher;
}

async function up() {
  const cfg = resolveConfig();
  const composeTemplate = readFileSync(join(cfg.root, "packages/run-spaceapp/templates/compose.yml"), "utf8");
  const images = parsePinnedImages(composeTemplate);
  const opencodeVersion = parseOpencodePin(readFileSync(join(cfg.root, "Dockerfile"), "utf8"));

  const already = readProcesses(cfg).filter((r) => isAlive(r.pid));
  if (already.length > 0) {
    log(`already running (${already.map((r) => `${r.name} pid ${r.pid}`).join(", ")}).`);
    log(`web: http://127.0.0.1:${cfg.ports.web}/ — stop with: npm run dev:stack -- down`);
    return;
  }
  if (!existsSync(join(cfg.root, "node_modules"))) {
    throw new Error("Dependencies are not installed. Run `ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci` first.");
  }
  await dockerOk(["version"], { daemonCheck: true });
  await dockerOk(["compose", "version"], { daemonCheck: true });
  await assertPortsFree(cfg);

  const secrets = ensureSecrets(cfg.stateDir);
  const p = statePaths(cfg);
  for (const dir of [p.memory, p.memoryGraph, p.artifacts, p.telegram, dirname(p.telegramManifest), p.workspaces, p.bin, p.providers, p.logs, p.run, dirname(cliSocketPath(cfg))]) {
    mkdirSync(dir, { recursive: true });
  }
  seedStarterMemory(cfg);
  writeFileSync(join(cfg.stateDir, "docker-compose.yml"), renderCompose(cfg, images));

  log(`state directory  ${cfg.stateDir}`);
  log(`compose project  ${cfg.project}`);
  log(`postgres         ${images.postgres}`);
  log(`temporal         ${images.temporal}`);
  log(`ports            api=${cfg.ports.api} web=${cfg.ports.web} postgres=${cfg.ports.postgres} temporal=${cfg.ports.temporal} (all 127.0.0.1 only)`);
  log("starting PostgreSQL and Temporal in Docker...");
  try {
    await run("docker", [...composeArgs(cfg), "up", "-d", "--wait", "--wait-timeout", "300"], {
      cwd: cfg.root,
      env: composeEnv(cfg)
    });
  } catch (error) {
    fail("a Docker service did not become healthy; its logs follow.");
    try {
      await run("docker", [...composeArgs(cfg), "logs", "--no-color", "--tail", "150", "postgres", "temporal"], {
        cwd: cfg.root,
        env: composeEnv(cfg)
      });
    } catch {
      /* the error above is the one that matters */
    }
    throw error;
  }
  await ensureTemporalNamespace(cfg);
  log("PostgreSQL and Temporal are healthy.");

  await buildWorkspaces(cfg);
  log("running migrations...");
  await run(process.execPath, [join(cfg.root, "packages/db/dist/migrate.js")], {
    cwd: cfg.root,
    env: { ...process.env, SPACE_DATABASE_URL: databaseUrl(cfg, secrets.postgresPassword) }
  });
  await ensureOpencode(cfg, opencodeVersion);
  log(`OpenCode ${opencodeVersion} ready in the state directory; pane command ${join(p.bin, "opencode-vscode-parity")}`);

  let resolveDone;
  const done = new Promise((r) => (resolveDone = r));
  let exitCode = 0;
  const supervisor = new Supervisor(cfg, (name, code, signal) => {
    exitCode = 1;
    fail(
      `${name} exited unexpectedly (code ${code ?? "null"}, signal ${signal ?? "null"}). ` +
        `The stack is NOT healthy — see ${join(p.logs, `${name}.log`)}. Shutting down.`
    );
    resolveDone();
  });

  const bin = (name) => join(cfg.root, "node_modules", ".bin", name);
  const starters = {
    api: () =>
      supervisor.start("api", bin("tsx"), ["watch", "src/server.ts"], {
        cwd: join(cfg.root, "apps", "api"),
        env: { ...process.env, ...buildApiEnv(cfg, secrets) }
      }),
    web: () =>
      supervisor.start("web", bin("vite"), ["--host", "127.0.0.1", "--port", String(cfg.ports.web)], {
        cwd: join(cfg.root, "apps", "web"),
        env: { ...process.env, ...buildWebEnv(cfg) }
      }),
    worker: () =>
      supervisor.start("worker", process.execPath, [join(cfg.root, "apps", "worker", "dist", "worker.js")], {
        cwd: cfg.root,
        env: { ...process.env, ...buildWorkerEnv(cfg, secrets) }
      }),
    "cli-host": () =>
      supervisor.start("cli-host", process.execPath, [join(cfg.root, "packages", "cli-host", "dist", "main.js")], {
        cwd: cfg.root,
        env: { ...process.env, ...buildCliHostEnv(cfg) }
      })
  };
  log("starting the API (watch), web (Vite), worker and CLI host from source...");
  for (const helper of ensurePtySpawnHelpers(cfg)) {
    log(`repaired node-pty spawn-helper permissions: ${helper} (the published macOS prebuild ships it non-executable; every PTY spawn would fail with EACCES)`);
  }
  starters.api();
  starters.web();
  starters.worker();
  starters["cli-host"]();
  const watcher = startPackageWatcher(cfg, supervisor, starters);

  const apiBase = `http://127.0.0.1:${cfg.ports.api}`;
  const readyTimeoutMs = Number(process.env.SPACE_DEV_READY_TIMEOUT_MS ?? 240_000);
  try {
    await waitFor(
      async () => {
        const body = await fetchJson(`${apiBase}/readyz`);
        return body && body.ok === true;
      },
      readyTimeoutMs,
      2_000,
      `${apiBase}/readyz to report ok: true`
    );
  } catch (error) {
    fail(error.message);
    for (const name of ["api", "web", "worker", "cli-host"]) {
      const logFile = join(p.logs, `${name}.log`);
      if (!existsSync(logFile)) continue;
      const lines = readFileSync(logFile, "utf8").trimEnd().split("\n").slice(-40);
      console.error(`dev-stack: ---- last lines of ${name}.log ----`);
      for (const line of lines) console.error(`[${name}] ${line}`);
    }
    await supervisor.stopAll();
    process.exit(1);
  }
  log("/readyz reports ok: true (workflows enabled).");

  const banner = [
    "",
    "════════════════════════════════════════════════════════════",
    `  SpaceApp (from source)  →  http://127.0.0.1:${cfg.ports.web}/`,
    `  One-time owner setup token:  ${secrets.setupToken}`,
    "  Open the URL, choose owner setup, paste the token, create the owner,",
    "  sign in, open the Getting Started room and start an OpenCode pane.",
    "  Note: the token can be claimed for 15 minutes after the API starts;",
    "  restarting the stack opens a fresh claim window.",
    `  API    ${apiBase}   (/readyz reports ok:true)`,
    `  Logs   ${p.logs}`,
    "  Stop:  npm run dev:stack -- down",
    "  Clean: npm run dev:stack -- reset",
    "════════════════════════════════════════════════════════════",
    ""
  ].join("\n");
  console.log(banner);

  const onSignal = () => resolveDone();
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  await done;
  if (watcher) watcher.close();
  await supervisor.stopAll();
  try {
    await dockerOk([...composeArgs(cfg), "down"], { env: composeEnv(cfg) });
  } catch {
    /* Docker went away first; down/reset can still clean up containers later. */
  }
  log("stopped. Data and secrets stay in the state directory; `npm run dev:stack -- reset` removes them.");
  process.exit(exitCode);
}

async function down() {
  const cfg = resolveConfig();
  if (!existsSync(cfg.stateDir)) {
    log("nothing to stop — no dev-stack state directory exists.");
    return;
  }
  const stopped = await stopRecordedProcesses(cfg);
  if (existsSync(join(cfg.stateDir, "docker-compose.yml"))) {
    try {
      await dockerOk([...composeArgs(cfg), "down"], { env: composeEnv(cfg) });
    } catch (error) {
      fail(error.message);
    }
  }
  log(`stopped (${stopped} recorded process${stopped === 1 ? "" : "es"}). State kept in ${cfg.stateDir}; reset removes it.`);
}

async function reset() {
  const cfg = resolveConfig();
  if (!existsSync(cfg.stateDir)) {
    log("nothing to reset — no dev-stack state directory exists.");
    return;
  }
  const recorded = readProcesses(cfg);
  await stopRecordedProcesses(cfg);
  let dockerVerified = false;
  if (existsSync(join(cfg.stateDir, "docker-compose.yml"))) {
    await dockerOk([...composeArgs(cfg), "down", "-v", "--remove-orphans"], { env: composeEnv(cfg) });
    const label = `label=com.docker.compose.project=${cfg.project}`;
    const containers = (await dockerOk(["ps", "-aq", "--filter", label], { capture: true })).stdout.trim();
    const volumes = (await dockerOk(["volume", "ls", "-q", "--filter", label], { capture: true })).stdout.trim();
    if (containers) throw new Error(`reset incomplete: containers remain:\n${containers}`);
    if (volumes) throw new Error(`reset incomplete: volumes remain:\n${volumes}`);
    dockerVerified = true;
  }
  rmSync(cfg.stateDir, { recursive: true, force: true });
  const processesLeft = recorded.filter((r) => isAlive(r.pid));
  if (processesLeft.length > 0) {
    throw new Error(`reset incomplete: processes still running: ${processesLeft.map((r) => r.name).join(", ")}`);
  }
  log(
    `reset complete — state directory removed; no process left` +
      (dockerVerified ? "; no container or volume left from this stack." : " (Docker unavailable: container/volume cleanup could not be verified).")
  );
}

async function status() {
  const cfg = resolveConfig();
  if (!existsSync(cfg.stateDir)) {
    log("dev stack has never been started (no state directory).");
    return;
  }
  const recorded = readProcesses(cfg);
  if (recorded.length === 0) log("processes: none recorded.");
  for (const record of recorded) {
    log(`process ${record.name}: pid ${record.pid} ${isAlive(record.pid) ? "RUNNING" : "not running"}`);
  }
  if (existsSync(join(cfg.stateDir, "docker-compose.yml"))) {
    try {
      const { stdout } = await dockerOk([...composeArgs(cfg), "ps"], { capture: true, env: composeEnv(cfg) });
      console.log(stdout);
    } catch (error) {
      fail(error.message);
    }
  }
  try {
    const body = await fetchJson(`http://127.0.0.1:${cfg.ports.api}/readyz`);
    log(`/readyz: ok=${body.ok}`);
  } catch {
    log("/readyz: API not answering.");
  }
}

async function main() {
  const command = process.argv[2] ?? "up";
  try {
    if (command === "up") await up();
    else if (command === "down") await down();
    else if (command === "reset") await reset();
    else if (command === "status") await status();
    else {
      fail(`unknown command "${command}". Use: up (default), down, reset, status.`);
      process.exit(2);
    }
  } catch (error) {
    fail(error.message ?? String(error));
    process.exit(1);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
