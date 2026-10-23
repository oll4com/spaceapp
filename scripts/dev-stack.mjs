#!/usr/bin/env node
/**
 * SpaceApp Dev Stack: Run the full SpaceApp stack from source.
 *
 * Usage:
 *   npm run dev:stack          Start the dev stack (Docker + migrations + source processes)
 *   npm run dev:stack -- down   Stop all processes and Docker containers
 *   npm run dev:stack -- reset  Stop and remove all containers, volumes, and state directory
 */

import { spawn, execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");

// Configuration & Ports (bind to 127.0.0.1 only)
const stateDir = resolve(repoRoot, process.env.SPACE_DEV_STACK_DIR ?? ".dev-stack");
const composeProject = process.env.SPACE_DEV_STACK_PROJECT ?? "spaceapp-dev";
const webPort = Number.parseInt(process.env.SPACE_DEV_STACK_WEB_PORT ?? process.env.SPACE_WEB_PORT ?? "5173", 10);
const apiPort = Number.parseInt(process.env.SPACE_DEV_STACK_API_PORT ?? process.env.SPACE_API_PORT ?? "4920", 10);
const postgresPort = Number.parseInt(process.env.SPACE_DEV_STACK_POSTGRES_PORT ?? "5433", 10);
const temporalPort = Number.parseInt(process.env.SPACE_DEV_STACK_TEMPORAL_PORT ?? "7234", 10);

const composeFilePath = join(stateDir, "docker-compose.yml");
const pidsFilePath = join(stateDir, "pids.json");

function log(message) {
  process.stdout.write(`[dev-stack] ${message}\n`);
}

function logError(message) {
  process.stderr.write(`[dev-stack] ${message}\n`);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Extracts pinned Docker image references from packages/run-spaceapp/templates/compose.yml.
 * Digests are never hardcoded or duplicated.
 */
async function extractPinnedImages() {
  const composeTemplatePath = join(repoRoot, "packages", "run-spaceapp", "templates", "compose.yml");
  const content = await readFile(composeTemplatePath, "utf8");

  const postgresMatch = content.match(/image:\s*(pgvector\/pgvector:[^\s\r\n]+)/);
  if (!postgresMatch?.[1]) {
    throw new Error(`Failed to extract pinned pgvector image from ${composeTemplatePath}`);
  }

  const temporalMatch = content.match(/image:\s*(temporalio\/auto-setup:[^\s\r\n]+)/);
  if (!temporalMatch?.[1]) {
    throw new Error(`Failed to extract pinned temporal image from ${composeTemplatePath}`);
  }

  return {
    postgresImage: postgresMatch[1],
    temporalImage: temporalMatch[1]
  };
}

/**
 * Extracts pinned opencode-ai version from Dockerfile.
 */
async function extractOpencodeVersion() {
  const dockerfilePath = join(repoRoot, "Dockerfile");
  const content = await readFile(dockerfilePath, "utf8");
  const match = content.match(/opencode-ai@([^\s\\]+)/);
  if (!match?.[1]) {
    throw new Error(`Failed to extract pinned opencode-ai version from ${dockerfilePath}`);
  }
  return match[1];
}

/**
 * Generates or reads a secret with mode 0600.
 */
async function ensureSecret(name, generator) {
  const secretsDir = join(stateDir, "secrets");
  await mkdir(secretsDir, { recursive: true });
  const secretPath = join(secretsDir, name);

  if (existsSync(secretPath)) {
    return (await readFile(secretPath, "utf8")).trim();
  }

  const value = generator();
  await writeFile(secretPath, value, { mode: 0o600 });
  try {
    await chmod(secretPath, 0o600);
  } catch {}
  return value;
}

/**
 * Generates the docker-compose.yml content bound strictly to 127.0.0.1.
 */
function generateComposeYaml({ postgresImage, temporalImage, postgresPassword }) {
  return `services:
  postgres:
    image: ${postgresImage}
    restart: unless-stopped
    environment:
      POSTGRES_DB: spaceapp
      POSTGRES_USER: spaceapp
      POSTGRES_PASSWORD: ${postgresPassword}
    ports:
      - "127.0.0.1:${postgresPort}:5432"
    volumes:
      - spaceapp-dev-postgres:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U spaceapp -d spaceapp"]
      interval: 3s
      timeout: 3s
      retries: 20

  temporal:
    image: ${temporalImage}
    restart: unless-stopped
    depends_on:
      postgres:
        condition: service_healthy
    environment:
      DB: postgres12
      DB_PORT: 5432
      POSTGRES_USER: spaceapp
      POSTGRES_PWD: ${postgresPassword}
      POSTGRES_SEEDS: postgres
      DYNAMIC_CONFIG_FILE_PATH: config/dynamicconfig/docker.yaml
    ports:
      - "127.0.0.1:${temporalPort}:7233"
    healthcheck:
      test: ["CMD-SHELL", "temporal operator cluster health --address temporal:7233 >/dev/null 2>&1 && temporal operator namespace describe --namespace default --address temporal:7233 >/dev/null 2>&1"]
      interval: 5s
      timeout: 5s
      retries: 25

volumes:
  spaceapp-dev-postgres:
`;
}

/**
 * Ensures OpenCode is installed in the local state directory (.dev-stack/node_modules/.bin/opencode).
 */
async function ensureOpencodeInstalled(opencodeVersion) {
  const opencodeBin = join(stateDir, "node_modules", ".bin", process.platform === "win32" ? "opencode.cmd" : "opencode");
  if (existsSync(opencodeBin)) {
    return;
  }
  log(`Installing pinned opencode-ai@${opencodeVersion} into state directory (${stateDir})...`);
  await mkdir(stateDir, { recursive: true });

  const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
  await new Promise((res, rej) => {
    const cp = spawn(npmCmd, ["install", "--no-save", "--no-audit", "--no-fund", `opencode-ai@${opencodeVersion}`], {
      cwd: stateDir,
      stdio: "inherit"
    });
    cp.on("exit", (code) => {
      if (code === 0) res();
      else rej(new Error(`npm install opencode-ai exited with code ${code}`));
    });
  });
}

/**
 * Creates CLI wrapper commands in .dev-stack/bin (e.g. opencode-vscode-parity).
 */
async function ensureCliWrappers() {
  const binDir = join(stateDir, "bin");
  await mkdir(binDir, { recursive: true });

  const providers = ["codex", "claude", "gemini", "opencode", "qwen", "kimi", "grok", "deepseek", "autohand", "cursor", "copilot"];
  const isWin = process.platform === "win32";

  for (const name of providers) {
    const wrapperName = `${name}-vscode-parity`;
    const wrapperPath = join(binDir, wrapperName);

    if (isWin) {
      // Windows CMD wrapper
      const cmdContent = `@echo off
set "STATE_ROOT=${stateDir}\\providers\\${name}"
set "HOME=%STATE_ROOT%"
set "TMPDIR=%STATE_ROOT%\\tmp"
if not exist "%STATE_ROOT%" mkdir "%STATE_ROOT%"
if not exist "%TMPDIR%" mkdir "%TMPDIR%"
if "${name}"=="opencode" (
  set "XDG_CONFIG_HOME=%STATE_ROOT%\\config"
  set "XDG_DATA_HOME=%STATE_ROOT%\\data"
  set "XDG_CACHE_HOME=%STATE_ROOT%\\cache"
  set "XDG_STATE_HOME=%STATE_ROOT%\\state"
  set "PATH=${stateDir}\\node_modules\\.bin;%PATH%"
  "${stateDir}\\node_modules\\.bin\\opencode.cmd" %*
) else (
  echo Unsupported CLI in dev stack: ${name} >&2
  exit /b 1
)
`;
      await writeFile(`${wrapperPath}.cmd`, cmdContent, { mode: 0o755 });
    }

    // Unix shell wrapper (Linux, macOS, WSL2)
    const shContent = `#!/bin/sh
set -eu
STATE_ROOT="${stateDir}/providers/${name}"
export HOME="$STATE_ROOT"
export TMPDIR="$STATE_ROOT/tmp"
mkdir -p "$STATE_ROOT" "$TMPDIR"

if [ "${name}" = "opencode" ]; then
  export XDG_CONFIG_HOME="$STATE_ROOT/config"
  export XDG_DATA_HOME="$STATE_ROOT/data"
  export XDG_CACHE_HOME="$STATE_ROOT/cache"
  export XDG_STATE_HOME="$STATE_ROOT/state"
  mkdir -p "$XDG_CONFIG_HOME" "$XDG_DATA_HOME" "$XDG_CACHE_HOME" "$XDG_STATE_HOME"
  export PATH="${stateDir}/node_modules/.bin:$PATH"
  exec "${stateDir}/node_modules/.bin/opencode" "$@"
else
  echo "Unsupported CLI in dev stack: ${name}" >&2
  exit 1
fi
`;
    await writeFile(wrapperPath, shContent, { mode: 0o755 });
    try {
      await chmod(wrapperPath, 0o755);
    } catch {}
  }
}

/**
 * Seeds initial starter memory files into stateDir/memory if missing.
 */
async function seedStarterMemory() {
  const memoryDir = join(stateDir, "memory");
  await mkdir(memoryDir, { recursive: true });

  const starterDir = join(repoRoot, "starter-memory");
  const files = ["gemini_history.md", "gemini_history_monthly.md", "installation-guide.md"];
  for (const file of files) {
    const src = join(starterDir, file);
    const dest = join(memoryDir, file);
    if (!existsSync(dest) && existsSync(src)) {
      const data = await readFile(src);
      await writeFile(dest, data, { mode: 0o600 });
    }
  }
}

/**
 * Runs docker compose command.
 */
async function runDockerCompose(args) {
  const dockerCmd = process.platform === "win32" ? "docker.exe" : "docker";
  return execFileAsync(dockerCmd, ["compose", "-p", composeProject, "-f", composeFilePath, ...args]);
}

/**
 * Waits for Docker services to become healthy.
 */
async function waitForDockerHealthy(timeoutMs = 90_000) {
  log("Waiting for PostgreSQL and Temporal containers to be healthy...");
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      const { stdout } = await runDockerCompose(["ps", "--format", "json"]);
      // docker compose ps returns json objects (either lines or array)
      const lines = stdout.trim().split("\n").filter(Boolean);
      let healthyCount = 0;
      for (const line of lines) {
        try {
          const item = JSON.parse(line);
          const status = (item.Health || item.State || item.Status || "").toLowerCase();
          if (status.includes("healthy")) {
            healthyCount++;
          }
        } catch {}
      }
      if (healthyCount >= 2) {
        log("PostgreSQL and Temporal are healthy.");
        return;
      }
    } catch {}
    await sleep(2000);
  }
  throw new Error("Timed out waiting for Docker services (PostgreSQL / Temporal) to become healthy.");
}

/**
 * Stops running Node child processes recorded in pids.json.
 */
async function stopRecordedProcesses() {
  if (!existsSync(pidsFilePath)) return;
  try {
    const data = JSON.parse(await readFile(pidsFilePath, "utf8"));
    for (const [name, pid] of Object.entries(data)) {
      try {
        process.kill(pid, "SIGTERM");
      } catch {}
    }
    await rm(pidsFilePath, { force: true });
  } catch {}
}

/**
 * Shuts down the dev stack (npm run dev:stack -- down).
 */
async function handleDown() {
  log("Stopping all running processes and Docker containers...");
  await stopRecordedProcesses();
  if (existsSync(composeFilePath)) {
    try {
      await runDockerCompose(["down"]);
      log("Docker containers stopped.");
    } catch (error) {
      logError(`Failed to stop Docker compose: ${error.message}`);
    }
  }
  log("Stopped all services.");
}

/**
 * Resets the dev stack (npm run dev:stack -- reset).
 */
async function handleReset() {
  log("Resetting SpaceApp dev stack...");
  await stopRecordedProcesses();
  if (existsSync(composeFilePath)) {
    try {
      await runDockerCompose(["down", "-v", "--remove-orphans"]);
      log("Docker containers and volumes removed.");
    } catch (error) {
      logError(`Failed to tear down Docker compose: ${error.message}`);
    }
  }
  if (existsSync(stateDir)) {
    await rm(stateDir, { recursive: true, force: true });
    log(`Removed state directory ${stateDir}.`);
  }
  log("Reset complete. No dev-stack containers, volumes, or files remain.");
}

/**
 * Main dev:stack orchestrator.
 */
async function handleStart({ headless = false } = {}) {
  log("Starting SpaceApp dev stack from source...");

  // 1. Extract pinned versions from single source of truth
  const { postgresImage, temporalImage } = await extractPinnedImages();
  const opencodeVersion = await extractOpencodeVersion();
  log(`Pinned images: Postgres (${postgresImage}), Temporal (${temporalImage})`);
  log(`Pinned CLI: opencode-ai@${opencodeVersion}`);

  // 2. Prepare state directory structure
  await mkdir(stateDir, { recursive: true });
  await mkdir(join(stateDir, "secrets"), { recursive: true });
  await mkdir(join(stateDir, "run"), { recursive: true });
  await mkdir(join(stateDir, "artifacts"), { recursive: true });
  await mkdir(join(stateDir, "workspaces"), { recursive: true });

  // 3. Generate secrets (mode 0600)
  const postgresPassword = await ensureSecret("postgres-password", () => randomBytes(32).toString("hex"));
  const sessionSecret = await ensureSecret("session-secret", () => randomBytes(32).toString("hex"));
  const setupToken = await ensureSecret("setup-token", () => randomBytes(32).toString("hex"));
  const databaseUrl = `postgres://spaceapp:${postgresPassword}@127.0.0.1:${postgresPort}/spaceapp`;
  await ensureSecret("database-url", () => databaseUrl);

  // 4. Seed memory and CLI wrappers
  await seedStarterMemory();
  await ensureOpencodeInstalled(opencodeVersion);
  await ensureCliWrappers();

  // 5. Generate and launch Docker compose
  const composeYaml = generateComposeYaml({ postgresImage, temporalImage, postgresPassword });
  await writeFile(composeFilePath, composeYaml, "utf8");
  log(`Wrote Docker compose config to ${composeFilePath}`);

  log("Starting Docker backing services...");
  await runDockerCompose(["up", "-d"]);
  await waitForDockerHealthy();

  // 6. Run database migrations
  log("Running database migrations...");
  const npxCmd = process.platform === "win32" ? "npx.cmd" : "npx";
  await new Promise((res, rej) => {
    const cp = spawn(process.execPath, ["packages/db/dist/migrate.js"], {
      cwd: repoRoot,
      env: {
        ...process.env,
        SPACE_DATABASE_URL: databaseUrl,
        SPACE_DATABASE_URL_FILE: join(stateDir, "secrets", "database-url")
      },
      stdio: "inherit"
    });
    cp.on("exit", (code) => {
      if (code === 0) res();
      else rej(new Error(`Database migration failed with exit code ${code}`));
    });
  });

  // 7. Launch supervised processes from source
  log("Launching SpaceApp processes from source (API watch, Vite web, Worker, CLI host)...");

  const socketPath = join(stateDir, "run", "host.sock");
  const children = new Map();
  let shuttingDown = false;

  function stopAllChildren(signal = "SIGTERM") {
    if (shuttingDown) return;
    shuttingDown = true;
    for (const [name, child] of children.entries()) {
      try {
        child.kill(signal);
      } catch {}
    }
  }

  const commonEnv = {
    ...process.env,
    NODE_ENV: "development",
    SPACE_PUBLIC_DISTRIBUTION: "true",
    SPACE_DEV_LOGIN: "false",
    SPACE_RUNTIME_STORE: "postgres",
    SPACE_DATABASE_URL: databaseUrl,
    SPACE_DATABASE_URL_FILE: join(stateDir, "secrets", "database-url"),
    SPACE_SESSION_SECRET: sessionSecret,
    SPACE_SESSION_SECRET_FILE: join(stateDir, "secrets", "session-secret"),
    SPACE_SETUP_TOKEN_FILE: join(stateDir, "secrets", "setup-token"),
    SPACE_API_HOST: "127.0.0.1",
    SPACE_API_PORT: String(apiPort),
    SPACE_WEB_HOST: "127.0.0.1",
    SPACE_WEB_PORT: String(webPort),
    SPACE_API_ORIGIN: `http://127.0.0.1:${apiPort}`,
    SPACE_TEMPORAL_ADDRESS: `127.0.0.1:${temporalPort}`,
    SPACEAPP_WORKFLOWS_ENABLED: "true",
    SPACE_MEMORY_ROOT: join(stateDir, "memory"),
    SPACE_STARTER_MEMORY_ROOT: join(repoRoot, "starter-memory"),
    SPACE_ARTIFACT_ROOT: join(stateDir, "artifacts"),
    SPACE_CLI_HOST_SOCKET: socketPath,
    SPACE_CLI_ENABLED: "true",
    SPACE_CLI_COMMAND_PATH: join(stateDir, "bin"),
    SPACE_CLI_WORKSPACE_ROOT: join(stateDir, "workspaces"),
    SPACE_CODEX_HOME: join(stateDir, "providers", "codex"),
    SPACE_BROWSER_SESSIONS_ENABLED: "false"
  };

  function spawnService(name, command, args, envOverrides = {}) {
    const child = spawn(command, args, {
      cwd: repoRoot,
      env: { ...commonEnv, ...envOverrides },
      stdio: ["ignore", "pipe", "pipe"]
    });

    children.set(name, child);

    child.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      if (!headless) process.stdout.write(`[${name}] ${text}`);
    });

    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      process.stderr.write(`[${name}] ${text}`);
    });

    child.once("error", (err) => {
      logError(`Service ${name} failed: ${err.message}`);
      stopAllChildren();
      process.exitCode = 1;
    });

    child.once("exit", (code, signal) => {
      children.delete(name);
      if (!shuttingDown) {
        logError(`Service ${name} exited unexpectedly (${code ?? signal}). Terminating stack.`);
        stopAllChildren();
        process.exitCode = code || 1;
      }
    });

    return child;
  }

  // CLI host
  spawnService("cli-host", process.execPath, ["packages/cli-host/dist/main.js"]);

  // Temporal worker
  spawnService("worker", process.execPath, ["apps/worker/dist/worker.js"]);

  // API in watch mode
  const tsxCli = resolve(repoRoot, "node_modules", "tsx", "dist", "cli.mjs");
  spawnService("api", process.execPath, [tsxCli, "watch", "apps/api/src/server.ts"]);

  // Web in Vite dev mode
  const viteCli = resolve(repoRoot, "node_modules", "vite", "bin", "vite.js");
  spawnService("web", process.execPath, [viteCli, "apps/web", "--host", "127.0.0.1", "--port", String(webPort)]);

  // Save pids
  const pids = {};
  for (const [name, child] of children.entries()) {
    pids[name] = child.pid;
  }
  await writeFile(pidsFilePath, JSON.stringify(pids, null, 2), "utf8");

  // 8. Poll readiness endpoint
  log("Waiting for SpaceApp API /readyz to report ok: true...");
  const readyUrl = `http://127.0.0.1:${apiPort}/readyz`;
  const readyDeadline = Date.now() + 60_000;
  let ready = false;

  while (Date.now() < readyDeadline && !shuttingDown) {
    try {
      const res = await fetch(readyUrl);
      if (res.ok) {
        const body = await res.json();
        if (body.ok === true) {
          ready = true;
          break;
        }
      }
    } catch {}
    await sleep(1000);
  }

  if (!ready && !shuttingDown) {
    logError("Timed out waiting for /readyz readiness.");
    stopAllChildren();
    process.exitCode = 1;
    return;
  }

  // 9. Display readiness banner
  const banner = `
================================================================================
🚀 SpaceApp Dev Stack is ready!
--------------------------------------------------------------------------------
Web Interface:      http://127.0.0.1:${webPort}
API Endpoint:       http://127.0.0.1:${apiPort}
Owner Setup Token:  ${setupToken}

Setup Instructions:
  1. Open http://127.0.0.1:${webPort} in your browser
  2. Paste the setup token above to claim owner account
  3. Explore Getting Started room and OpenCode CLI pane
--------------------------------------------------------------------------------
Press Ctrl+C to stop the stack, or run: npm run dev:stack -- down
================================================================================
`;

  process.stdout.write(banner);

  // Handle process shutdown signals
  for (const sig of ["SIGINT", "SIGTERM"]) {
    process.once(sig, async () => {
      log(`Received ${sig}, shutting down dev stack...`);
      stopAllChildren();
      await handleDown();
      process.exit(0);
    });
  }
}

// CLI argument parsing
const args = process.argv.slice(2);
const command = args[0];

if (command === "down") {
  await handleDown();
} else if (command === "reset") {
  await handleReset();
} else {
  const isHeadless = args.includes("--headless");
  await handleStart({ headless: isHeadless });
}
