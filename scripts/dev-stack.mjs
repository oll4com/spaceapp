#!/usr/bin/env node
/**
 * dev:stack — run the full SpaceApp stack from source with one command.
 *
 *   npm run dev:stack            start everything (foreground, supervised)
 *   npm run dev:stack -- down    stop the processes and Docker services
 *   npm run dev:stack -- reset   down + remove containers, volumes and the state directory
 *   npm run dev:stack -- status  show what is running
 *
 * Only PostgreSQL (pgvector) and Temporal run in Docker, using the exact
 * digest-pinned images from packages/run-spaceapp/templates/compose.yml —
 * the digests are parsed out of that file at runtime, never copied by hand.
 * The API (tsx watch), the Vite web dev server, the Temporal worker and the
 * CLI host all run from source. Everything this command creates lives in
 * .dev-stack/ (git-ignored): secrets (mode 0600), provider state, wrapper
 * commands, the pinned OpenCode install, logs and the rendered compose file.
 * It uses its own compose project name and its own ports, so it never
 * collides with an installed SpaceApp on 4910/4911. Every port binds to
 * 127.0.0.1 only. Ports can be changed with SPACE_DEV_API_PORT,
 * SPACE_DEV_WEB_PORT, SPACE_DEV_POSTGRES_PORT and SPACE_DEV_TEMPORAL_PORT.
 *
 * The owner setup is the usual one (setup token -> create owner -> sign in);
 * the dev-login shortcut is never enabled.
 */
import { spawn, execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync,
  rmSync, symlinkSync, writeFileSync, watch
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const templateComposePath = join(repoRoot, "packages/run-spaceapp/templates/compose.yml");
const dockerfilePath = join(repoRoot, "Dockerfile");
const wrapperSourcePath = join(repoRoot, "deploy/docker/public-cli-wrapper.sh");
const composeTemplatePath = join(repoRoot, "scripts/dev-stack.compose.yml");

const CLI_WRAPPER_NAMES = [
  "codex", "claude", "gemini", "opencode", "qwen", "kimi",
  "grok", "deepseek", "autohand", "cursor", "copilot"
];

/**
 * Ownership marker written into every state directory `up` creates. reset
 * deletes the whole state directory, so it first proves the directory is
 * really ours by checking for this file (see assertResetAllowed).
 */
export const STATE_MARKER_FILE = ".dev-stack-owned";
export const STATE_MARKER_CONTENTS = "spaceapp dev-stack state directory\n";

/**
 * Derive the compose project name from the state directory's absolute path:
 * stable for a given state directory, different across checkouts, so two
 * checkouts on one machine never share containers or volumes.
 */
export function composeProjectName(stateDir) {
  const suffix = createHash("sha256").update(resolve(stateDir)).digest("hex").slice(0, 8);
  return `spaceapp-dev-${suffix}`;
}

/** Stamp the state directory as dev-stack-owned (called during `up` setup). */
export function ensureStateMarker(config) {
  mkdirSync(config.stateDir, { recursive: true });
  writeFileSync(join(config.stateDir, STATE_MARKER_FILE), STATE_MARKER_CONTENTS);
}

/**
 * Guard for commandReset, which recursively deletes the state directory.
 * Refuses when the state directory resolves to the repository root, the
 * user's home directory or the filesystem root, and when the directory
 * does not carry the ownership marker written by `up`.
 */
export function assertResetAllowed(config) {
  const { stateDir } = config;
  const forbidden = new Map([
    [resolve(repoRoot), "the repository root"],
    [resolve(homedir()), "your home directory"],
    [resolve("/"), "the filesystem root"]
  ]);
  if (forbidden.has(stateDir)) {
    throw new Error(
      `Refusing to reset: the dev-stack state directory resolves to ${forbidden.get(stateDir)} (${stateDir}). ` +
      "Point SPACE_DEV_STATE_DIR at a dedicated directory instead."
    );
  }
  let marker = null;
  try {
    marker = readFileSync(join(stateDir, STATE_MARKER_FILE), "utf8");
  } catch { /* missing marker */ }
  if (marker !== STATE_MARKER_CONTENTS) {
    throw new Error(
      `Refusing to delete ${stateDir}: it does not carry the dev-stack ownership marker (${STATE_MARKER_FILE}), ` +
      "so it may not belong to dev:stack. If you are sure it is disposable, remove it manually."
    );
  }
}

/** Resolve ports and directories. Defaults never collide with an install (4910/4911). */
export function buildConfig(env = process.env) {
  const port = (name, fallback) => {
    const raw = env[name];
    const value = raw === undefined ? fallback : Number.parseInt(raw, 10);
    if (!Number.isInteger(value) || value < 1 || value > 65535) {
      throw new Error(`${name} must be a TCP port number, got ${JSON.stringify(raw)}`);
    }
    return value;
  };
  const stateDir = env.SPACE_DEV_STATE_DIR
    ? resolve(env.SPACE_DEV_STATE_DIR)
    : join(repoRoot, ".dev-stack");
  return {
    stateDir,
    secretsDir: join(stateDir, "secrets"),
    logsDir: join(stateDir, "logs"),
    dataDir: join(stateDir, "data"),
    binDir: join(stateDir, "bin"),
    cliHomeDir: join(stateDir, "cli-home"),
    opencodePrefix: join(stateDir, "opencode"),
    workspacesDir: join(stateDir, "workspaces"),
    composeFile: join(stateDir, "compose.yml"),
    pidsFile: join(stateDir, "pids.json"),
    composeProject: composeProjectName(stateDir),
    apiPort: port("SPACE_DEV_API_PORT", 14910),
    webPort: port("SPACE_DEV_WEB_PORT", 14911),
    postgresPort: port("SPACE_DEV_POSTGRES_PORT", 15432),
    temporalPort: port("SPACE_DEV_TEMPORAL_PORT", 7233)
  };
}

/** Extract the digest-pinned image of one service from the install compose template. */
export function parseServiceImage(composeText, service) {
  const escaped = service.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const block = new RegExp(`\\n  ${escaped}:\\n([\\s\\S]*?)(?=\\n  [a-zA-Z0-9_-]+:|\\nnetworks:|\\nsecrets:|\\nvolumes:|$)`).exec(composeText);
  if (!block) throw new Error(`Service ${service} not found in ${templateComposePath}`);
  const image = /^\s+image:\s*(\S+)\s*$/m.exec(block[1]);
  if (!image) throw new Error(`Service ${service} has no image in ${templateComposePath}`);
  return image[1];
}

/** Extract the pinned OpenCode version from the Dockerfile (@opencode/cli@x.y.z). */
export function parseOpencodePin(dockerfileText) {
  const match = /@opencode\/cli@(\d+\.\d+\.\d+)/.exec(dockerfileText);
  if (!match) throw new Error(`No @opencode/cli pin found in ${dockerfilePath}`);
  return match[1];
}

function writeSecretFile(path, contents) {
  writeFileSync(path, contents, { mode: 0o600 });
  chmodSync(path, 0o600);
}

/**
 * Create the per-state-directory secrets once and reuse them across restarts.
 * Files are mode 0600; nothing here is ever printed except the setup token.
 */
export function ensureSecrets(config) {
  mkdirSync(config.secretsDir, { recursive: true, mode: 0o700 });
  chmodSync(config.secretsDir, 0o700);
  const files = {
    "postgres-password": () => randomBytes(24).toString("hex"),
    "session-secret": () => randomBytes(32).toString("hex"),
    "setup-token": () => randomBytes(24).toString("hex")
  };
  let created = false;
  for (const [name, generate] of Object.entries(files)) {
    const path = join(config.secretsDir, name);
    if (!existsSync(path)) {
      writeSecretFile(path, `${generate()}\n`);
      created = true;
    } else {
      chmodSync(path, 0o600);
    }
  }
  const password = readFileSync(join(config.secretsDir, "postgres-password"), "utf8").trim();
  const databaseUrl = `postgres://spaceapp:${password}@127.0.0.1:${config.postgresPort}/spaceapp`;
  writeSecretFile(join(config.secretsDir, "database-url"), `${databaseUrl}\n`);
  return { created, databaseUrl };
}

/** Render the dev compose file (PostgreSQL + Temporal only) into the state directory. */
export function renderCompose(config, images) {
  const template = readFileSync(composeTemplatePath, "utf8");
  const rendered = template
    .replaceAll("__POSTGRES_IMAGE__", images.postgres)
    .replaceAll("__TEMPORAL_IMAGE__", images.temporal)
    .replaceAll("__POSTGRES_PORT__", String(config.postgresPort))
    .replaceAll("__TEMPORAL_PORT__", String(config.temporalPort))
    .replaceAll("__SECRETS_DIR__", config.secretsDir);
  writeFileSync(config.composeFile, rendered);
  return rendered;
}

/** Generate the *-vscode-parity wrapper commands inside the state directory. */
export function ensureWrappers(config) {
  mkdirSync(config.binDir, { recursive: true });
  mkdirSync(join(config.cliHomeDir, "providers"), { recursive: true });
  mkdirSync(join(config.cliHomeDir, "imported-credentials"), { recursive: true });
  mkdirSync(join(config.cliHomeDir, "vendor"), { recursive: true });
  const source = readFileSync(wrapperSourcePath, "utf8");
  const devWrapper = source.replaceAll("/var/lib/spaceapp-cli", config.cliHomeDir);
  const wrapperPath = join(config.binDir, "spaceapp-cli-wrapper");
  writeFileSync(wrapperPath, devWrapper, { mode: 0o755 });
  chmodSync(wrapperPath, 0o755);
  for (const name of CLI_WRAPPER_NAMES) {
    const link = join(config.binDir, `${name}-vscode-parity`);
    if (existsSync(link)) rmSync(link);
    symlinkSync(wrapperPath, link);
  }
}

/** Seed the memory root from starter-memory the way core-entrypoint.sh does. */
function seedMemory(config) {
  const memoryRoot = join(config.dataDir, "memory");
  mkdirSync(memoryRoot, { recursive: true });
  mkdirSync(join(config.dataDir, "memory-graph"), { recursive: true });
  mkdirSync(join(config.dataDir, "artifacts"), { recursive: true });
  mkdirSync(join(config.dataDir, "telegram"), { recursive: true });
  mkdirSync(join(config.dataDir, "integrations", "telegram"), { recursive: true });
  const starter = join(repoRoot, "starter-memory");
  for (const name of ["space_memory.md", "space_memory_monthly.md", "installation-guide.md"]) {
    const target = join(memoryRoot, name);
    if (!existsSync(target) && existsSync(join(starter, name))) {
      copyFileSync(join(starter, name), target);
    }
  }
}

/** Environment shared by the from-source processes, mirroring the install compose env. */
export function devEnvironment(config) {
  const data = config.dataDir;
  const memoryRoot = join(data, "memory");
  const apiOrigin = `http://127.0.0.1:${config.apiPort}`;
  const readSecretFile = (name) => readFileSync(join(config.secretsDir, name), "utf8").trim();
  const databaseUrl = readSecretFile("database-url");
  const sessionSecret = readSecretFile("session-secret");
  return {
    SPACE_PUBLIC_DISTRIBUTION: "true",
    SPACE_AGENT_TOOLS_WRITER: "disabled",
    SPACE_DEV_LOGIN: "false",
    SPACE_TELEMETRY_ENABLED: "false",
    SPACE_OPTIONAL_MODULES: "all",
    SPACE_RUNTIME_STORE: "postgres",
    SPACE_DATABASE_URL: readFileSync(join(config.secretsDir, "database-url"), "utf8").trim(),
    SPACE_SESSION_SECRET: sessionSecret,
    SPACE_SETUP_TOKEN_FILE: join(config.secretsDir, "setup-token"),
    SPACE_API_HOST: "127.0.0.1",
    SPACE_API_PORT: String(config.apiPort),
    SPACE_WEB_HOST: "127.0.0.1",
    SPACE_WEB_PORT: String(config.webPort),
    SPACE_API_ORIGIN: apiOrigin,
    SPACE_TEMPORAL_ADDRESS: `127.0.0.1:${config.temporalPort}`,
    SPACEAPP_WORKFLOWS_ENABLED: "true",
    SPACE_MEMORY_ROOT: memoryRoot,
    SPACE_STARTER_MEMORY_ROOT: join(repoRoot, "starter-memory"),
    SPACE_MEMORY_GRAPH_ROOT: join(data, "memory-graph"),
    SPACE_MEMORY_INDEX_PATH: join(memoryRoot, "space_memory.md"),
    SPACE_MEMORY_MONTHLY_PATH: join(memoryRoot, "space_memory_monthly.md"),
    SPACE_MEMORY_LOCK_PATH: join(memoryRoot, ".memory.lock"),
    SPACE_ARTIFACT_ROOT: join(data, "artifacts"),
    SPACE_CLI_HOST_SOCKET: join(config.stateDir, "run", "cli-host.sock"),
    SPACE_CLI_ENABLED: "true",
    SPACE_CLI_COMMAND_PATH: config.binDir,
    SPACE_CLI_WORKSPACE_ROOT: config.workspacesDir,
    SPACE_CODEX_HOME: join(config.cliHomeDir, "providers", "codex"),
    SPACE_CODEX_APP_SERVER_HOME: join(config.cliHomeDir, "providers", "codex"),
    SPACE_CODEX_APP_SERVER_COMMAND: join(config.binDir, "codex-vscode-parity"),
    SPACE_CODEX_ROUTE_COMMAND: join(config.binDir, "codex-vscode-parity"),
    SPACE_CODEX_GOALS_DB_PATH: join(data, "codex-goals.sqlite"),
    SPACE_CODEX_CLI_MODE_DEFAULTS_PROJECTION_PATH: join(data, "codex-cli-mode-defaults-v1.json"),
    SPACE_TELEGRAM_SECRET_ROOT: join(data, "telegram"),
    SPACE_TELEGRAM_OWNERSHIP_MANIFEST: join(data, "integrations", "telegram", "thread-ownership.json"),
    SPACE_BROWSER_SESSIONS_ENABLED: "false",
    SPACE_GIT_ROOT: repoRoot
  };
}

function log(line) {
  process.stdout.write(`[dev-stack] ${line}\n`);
}

async function run(command, args, options = {}) {
  const capture = options.stdio === "pipe";
  const child = spawn(command, args, {
    cwd: options.cwd ?? repoRoot,
    env: { ...process.env, ...(options.env ?? {}) },
    shell: process.platform === "win32",
    stdio: options.stdio ?? "inherit"
  });
  let captured = "";
  if (capture) {
    child.stdout?.on("data", (chunk) => { captured += chunk; });
    child.stderr?.on("data", (chunk) => { captured += chunk; });
  }
  const code = await new Promise((resolvePromise, reject) => {
    child.on("error", reject);
    child.on("exit", (exitCode) => resolvePromise(exitCode ?? 1));
  });
  if (code !== 0 && !options.allowFailure) {
    const tail = captured.trim().split(/\r?\n/).slice(-20).join("\n");
    throw new Error(`${command} ${args.join(" ")} failed with exit code ${code}${tail ? `\n${tail}` : ""}`);
  }
  return code;
}

async function dockerCompose(config, args, options = {}) {
  return run("docker", ["compose", "-p", config.composeProject, "-f", config.composeFile, ...args], options);
}

function readPids(config) {
  if (!existsSync(config.pidsFile)) return [];
  try {
    return JSON.parse(readFileSync(config.pidsFile, "utf8"));
  } catch {
    return [];
  }
}

function killPidTree(pid, signal = "SIGTERM") {
  try {
    process.kill(process.platform === "win32" ? pid : -pid, signal);
  } catch {
    try { process.kill(pid, signal); } catch { /* already gone */ }
  }
}

async function stopProcesses(config) {
  const pids = readPids(config);
  for (const pid of pids) killPidTree(pid);
  if (pids.length > 0) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1500));
    for (const pid of pids) killPidTree(pid, "SIGKILL");
  }
  if (existsSync(config.pidsFile)) rmSync(config.pidsFile);
  return pids.length;
}

async function commandDown(config) {
  const stopped = await stopProcesses(config);
  if (existsSync(config.composeFile)) {
    await dockerCompose(config, ["down"], { allowFailure: true, stdio: "inherit" });
  }
  log(stopped > 0 || existsSync(config.composeFile)
    ? "Dev stack stopped. State, volumes and secrets were kept."
    : "Nothing was running.");
}

async function commandReset(config) {
  await stopProcesses(config);
  if (existsSync(config.composeFile)) {
    await dockerCompose(config, ["down", "-v", "--remove-orphans"], { allowFailure: true, stdio: "inherit" });
  }
  assertResetAllowed(config);
  if (existsSync(config.stateDir)) rmSync(config.stateDir, { recursive: true, force: true });
  log("Dev stack removed: containers, volumes and .dev-stack state are gone.");
}

async function commandStatus(config) {
  const pids = readPids(config);
  log(`State directory: ${config.stateDir} (${existsSync(config.stateDir) ? "present" : "absent"})`);
  log(`Supervised processes: ${pids.length > 0 ? pids.join(", ") : "none recorded"}`);
  if (existsSync(config.composeFile)) {
    await dockerCompose(config, ["ps"], { allowFailure: true, stdio: "inherit" });
  }
}

const BUILD_ORDER = [
  "@space/contracts", "@space/icons", "@space/streaming", "@space/opencode-control",
  "@space/memory-graph", "@space/browser-host", "@space/cli-host", "@space/codex-app-server",
  "@space/runtime", "@space/db", "@space/gateway", "@space/worker"
];

async function buildWorkspaces(names, env) {
  for (const name of names) {
    await run("npm", ["run", "build", "-w", name], { env, stdio: "pipe" });
  }
}

function packageNameByDir() {
  const map = new Map();
  for (const area of ["packages", "apps"]) {
    const base = join(repoRoot, area);
    if (!existsSync(base)) continue;
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const manifest = join(base, entry.name, "package.json");
      if (!existsSync(manifest)) continue;
      try {
        const parsed = JSON.parse(readFileSync(manifest, "utf8"));
        if (parsed.name) map.set(`${area}/${entry.name}`, parsed.name);
      } catch { /* ignore malformed manifests */ }
    }
  }
  return map;
}

class Supervisor {
  constructor(config, env) {
    this.config = config;
    this.env = env;
    this.children = new Map();
    this.shuttingDown = false;
    this.failed = null;
  }

  start(name, command, args, cwd) {
    const logPath = join(this.config.logsDir, `${name}.log`);
    const child = spawn(command, args, {
      cwd,
      env: this.env,
      shell: process.platform === "win32",
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"]
    });
    const prefix = (chunk, stream) => {
      for (const line of chunk.toString().split(/\r?\n/)) {
        if (line.length > 0) process.stdout.write(`[${name}] ${line}\n`);
      }
      stream.write(chunk);
    };
    const logStream = { write: (chunk) => writeFileSync(logPath, chunk, { flag: "a" }) };
    child.stdout.on("data", (chunk) => prefix(chunk, logStream));
    child.stderr.on("data", (chunk) => prefix(chunk, logStream));
    child.on("exit", (code, signal) => {
      const current = this.children.get(name);
      if (current === child) this.children.delete(name);
      if (!this.shuttingDown && !current?.restarting) {
        this.failed = { name, code, signal, logPath };
        log(`ERROR: ${name} exited unexpectedly (code ${code ?? "—"}, signal ${signal ?? "—"}). Full log: ${logPath}`);
        void this.shutdown(1);
      }
    });
    this.children.set(name, child);
    this.writePids();
    return child;
  }

  async restart(name, command, args, cwd) {
    const child = this.children.get(name);
    if (child) {
      child.restarting = true;
      killPidTree(child.pid);
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 600));
      try { killPidTree(child.pid, "SIGKILL"); } catch { /* gone */ }
    }
    if (!this.shuttingDown) this.start(name, command, args, cwd);
  }

  writePids() {
    const pids = [...this.children.values()].map((child) => child.pid).filter(Boolean);
    writeFileSync(this.config.pidsFile, JSON.stringify(pids, null, 2));
  }

  async shutdown(exitCode = 0) {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    for (const child of this.children.values()) killPidTree(child.pid);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1200));
    for (const child of this.children.values()) killPidTree(child.pid, "SIGKILL");
    if (existsSync(this.config.pidsFile)) rmSync(this.config.pidsFile);
    await dockerCompose(this.config, ["down"], { allowFailure: true, stdio: "pipe" }).catch(() => {});
    process.exit(this.failed ? 1 : exitCode);
  }
}

async function waitForReadyz(config, timeoutMs = 240_000) {
  const url = `http://127.0.0.1:${config.apiPort}/readyz`;
  const deadline = Date.now() + timeoutMs;
  let lastError = "no response";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      const body = await response.json().catch(() => ({}));
      if (body && body.ok === true) return body;
      lastError = `readyz answered ${response.status} with ok=${body?.ok}`;
    } catch (error) {
      lastError = error.message;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 2_000));
  }
  throw new Error(`Timed out waiting for ${url} (${lastError})`);
}

async function commandUp(config) {
  // Preflight: Docker is the only hard host dependency besides Node and npm.
  await run("docker", ["version", "--format", "{{.Server.Version}}"], { stdio: "pipe" })
    .catch(() => { throw new Error("Docker is not reachable. Start Docker Desktop, Colima or dockerd first (see CONTRIBUTING.md)."); });
  await run("docker", ["compose", "version"], { stdio: "pipe" })
    .catch(() => { throw new Error("Docker Compose v2 is required (docker compose version failed)."); });

  ensureStateMarker(config);
  mkdirSync(config.logsDir, { recursive: true });
  mkdirSync(join(config.stateDir, "run"), { recursive: true });
  mkdirSync(config.workspacesDir, { recursive: true });

  const composeText = readFileSync(templateComposePath, "utf8");
  const images = {
    postgres: parseServiceImage(composeText, "postgres"),
    temporal: parseServiceImage(composeText, "temporal")
  };
  const opencodePin = parseOpencodePin(readFileSync(dockerfilePath, "utf8"));
  log(`Images from the install template: postgres=${images.postgres}`);
  log(`Images from the install template: temporal=${images.temporal}`);

  ensureSecrets(config);
  renderCompose(config, images);
  seedMemory(config);
  ensureWrappers(config);

  if (!existsSync(join(repoRoot, "node_modules"))) {
    log("node_modules missing — running npm ci (ELECTRON_SKIP_BINARY_DOWNLOAD=1)…");
    await run("npm", ["ci"], { env: { ELECTRON_SKIP_BINARY_DOWNLOAD: "1" } });
  }

  const childEnv = {
    ...process.env,
    ...devEnvironment(config),
    PATH: `${config.opencodePrefix}/bin:${config.binDir}:${process.env.PATH}`
  };

  log("Starting PostgreSQL and Temporal…");
  await dockerCompose(config, ["up", "-d", "--wait", "postgres", "temporal"]);

  log("Building shared packages and the worker (the API and web run from source)…");
  await buildWorkspaces(BUILD_ORDER, childEnv);

  const opencodeBin = join(config.opencodePrefix, "bin", "opencode");
  if (!existsSync(opencodeBin)) {
    log(`Installing pinned OpenCode @opencode/cli@${opencodePin} into the state directory…`);
    await run("npm", ["install", "--global", `--prefix=${config.opencodePrefix}`, "--no-audit", "--no-fund", `@opencode/cli@${opencodePin}`], { env: childEnv });
  }

  log("Running database migrations…");
  await run("npm", ["run", "migrate", "-w", "@space/db"], { env: childEnv, stdio: "pipe" });

  const supervisor = new Supervisor(config, childEnv);
  const apiDir = join(repoRoot, "apps/api");
  const webDir = join(repoRoot, "apps/web");
  const workerDir = join(repoRoot, "apps/worker");
  const cliHostDir = join(repoRoot, "packages/cli-host");
  const apiCommand = ["npx", ["tsx", "watch", "src/server.ts"], apiDir];
  const workerCommand = ["node", ["dist/worker.js"], workerDir];
  const cliHostCommand = ["node", ["dist/main.js"], cliHostDir];

  supervisor.start("api", ...apiCommand);
  supervisor.start("worker", ...workerCommand);
  supervisor.start("cli-host", ...cliHostCommand);
  supervisor.start("web", "npx", ["vite", "--host", "127.0.0.1", "--port", String(config.webPort)], webDir);

  // Hot reload for shared packages and the worker: rebuild on source change,
  // then restart the processes that consume the built output.
  const dirToPackage = packageNameByDir();
  const pending = new Map();
  const scheduleRebuild = (dirKey) => {
    const packageName = dirToPackage.get(dirKey);
    if (!packageName) return;
    if (pending.has(packageName)) clearTimeout(pending.get(packageName));
    pending.set(packageName, setTimeout(async () => {
      pending.delete(packageName);
      if (supervisor.shuttingDown) return;
      log(`Rebuilding ${packageName} after a source change…`);
      try {
        await buildWorkspaces([packageName], childEnv);
      } catch (error) {
        log(`Rebuild of ${packageName} failed: ${error.message}. Keeping the previous build running.`);
        return;
      }
      if (packageName === "@space/worker") {
        await supervisor.restart("worker", ...workerCommand);
      } else {
        await supervisor.restart("api", ...apiCommand);
        await supervisor.restart("worker", ...workerCommand);
        await supervisor.restart("cli-host", ...cliHostCommand);
      }
    }, 800));
  };
  const watchers = [];
  for (const area of ["packages", "apps/worker"]) {
    const base = join(repoRoot, area);
    if (!existsSync(base)) continue;
    const watcher = watch(base, { recursive: true }, (_event, filename) => {
      if (!filename) return;
      const normalized = filename.replaceAll("\\", "/");
      if (!/\.(ts|tsx|mts|cts|mjs)$/.test(normalized)) return;
      if (area === "packages") {
        if (!normalized.includes("/src/")) return;
        scheduleRebuild(`packages/${normalized.split("/")[0]}`);
      } else {
        if (!normalized.startsWith("src/")) return;
        scheduleRebuild("apps/worker");
      }
    });
    watchers.push(watcher);
  }

  process.on("SIGINT", () => { log("Stopping (Ctrl+C)…"); void supervisor.shutdown(0); });
  process.on("SIGTERM", () => { void supervisor.shutdown(0); });

  await waitForReadyz(config);
  const setupToken = readFileSync(join(config.secretsDir, "setup-token"), "utf8").trim();
  log("");
  log("SpaceApp dev stack is ready:");
  log(`  Web:        http://127.0.0.1:${config.webPort}`);
  log(`  API:        http://127.0.0.1:${config.apiPort} (/readyz ok, workflows enabled)`);
  log(`  Setup token (owner setup, valid ~15 minutes after API start): ${setupToken}`);
  log("  Stop with Ctrl+C, or `npm run dev:stack -- down`. Remove everything with `npm run dev:stack -- reset`.");
  log("Watching packages/* and the worker for changes; the API restarts on its own source changes and the web app hot-reloads.");
}

async function main() {
  const config = buildConfig();
  const command = process.argv[2] ?? "up";
  if (command === "up") await commandUp(config);
  else if (command === "down") await commandDown(config);
  else if (command === "reset") await commandReset(config);
  else if (command === "status") await commandStatus(config);
  else {
    process.stderr.write("Usage: dev-stack.mjs [up|down|reset|status]\n");
    process.exit(2);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`[dev-stack] ${error.message}\n`);
    process.exit(1);
  });
}
