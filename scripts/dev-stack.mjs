#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import process from "node:process";

const ROOT = process.cwd();
const TEMPLATE_COMPOSE_PATH = path.join(ROOT, "packages", "run-spaceapp", "templates", "compose.yml");
const DOCKERFILE_PATH = path.join(ROOT, "Dockerfile");

/**
 * Validates that a configured port is an integer in the valid range 1-65535.
 *
 * @param {string} name - Port name for error reporting.
 * @param {number} port - Port number to validate.
 * @returns {number} The validated port number.
 * @throws {Error} If the port is not an integer between 1 and 65535.
 */
export function validatePort(name, port) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid port for ${name}: ${port}. Port must be an integer between 1 and 65535.`);
  }
  return port;
}

/**
 * Parses pinned Docker image references for PostgreSQL and Temporal from the template compose file.
 *
 * @param {string} composeContent - Contents of packages/run-spaceapp/templates/compose.yml.
 * @returns {{ postgres: string, temporal: string }} Pinned image names and digests.
 * @throws {Error} If postgres or temporal image digests cannot be parsed.
 */
export function parsePinnedImages(composeContent) {
  const postgresMatch = composeContent.match(/image:\s*(pgvector\/pgvector:[^\s\r\n]+)/);
  const temporalMatch = composeContent.match(/image:\s*(temporalio\/auto-setup:[^\s\r\n]+)/);
  if (!postgresMatch || !temporalMatch) {
    throw new Error("Failed to extract pinned postgres or temporal image digests from templates/compose.yml");
  }
  return {
    postgres: postgresMatch[1].trim(),
    temporal: temporalMatch[1].trim()
  };
}

/**
 * Parses the pinned version of opencode-ai from the repository Dockerfile.
 *
 * @param {string} dockerfileContent - Contents of Dockerfile.
 * @returns {string} Pinned semver string for opencode-ai.
 * @throws {Error} If the version string cannot be found.
 */
export function parsePinnedOpencodeVersion(dockerfileContent) {
  const match = dockerfileContent.match(/opencode-ai@([0-9.]+)/);
  if (!match) {
    throw new Error("Failed to extract pinned opencode-ai version from Dockerfile");
  }
  return match[1].trim();
}

/**
 * Resolves dev-stack configuration from environment variables with defaults.
 *
 * @param {Record<string, string | undefined>} [env=process.env] - Environment variables map.
 * @returns {object} Dev stack configuration options and resolved paths.
 */
export function resolveDevStackConfig(env = process.env) {
  const stateRoot = path.resolve(ROOT, env.SPACEAPP_DEV_STATE_ROOT || ".dev-stack");
  const composeProject = env.SPACEAPP_DEV_PROJECT || "spaceapp-dev";
  const webPort = validatePort("webPort", Number.parseInt(env.SPACEAPP_DEV_WEB_PORT || env.SPACE_WEB_PORT || "5911", 10));
  const apiPort = validatePort("apiPort", Number.parseInt(env.SPACEAPP_DEV_API_PORT || env.SPACE_API_PORT || "5910", 10));
  const postgresPort = validatePort("postgresPort", Number.parseInt(env.SPACEAPP_DEV_POSTGRES_PORT || "54329", 10));
  const temporalPort = validatePort("temporalPort", Number.parseInt(env.SPACEAPP_DEV_TEMPORAL_PORT || "57233", 10));

  return {
    stateRoot,
    composeProject,
    webPort,
    apiPort,
    postgresPort,
    temporalPort,
    secretsDir: path.join(stateRoot, "secrets"),
    runDir: path.join(stateRoot, "run"),
    binDir: path.join(stateRoot, "bin"),
    opencodeDir: path.join(stateRoot, "opencode"),
    varDir: path.join(stateRoot, "var"),
    workspacesDir: path.join(stateRoot, "workspaces"),
    pidFile: path.join(stateRoot, "run", "dev-stack.pid")
  };
}

/**
 * Generates the Docker Compose YAML configuration for isolated dev services.
 * Uses Docker Compose secrets to ensure containers can read passwords even when
 * the host file is owned exclusively by the current user (mode 0600).
 *
 * @param {object} params
 * @param {string} params.postgresImage - Pinned image digest for PostgreSQL.
 * @param {string} params.temporalImage - Pinned image digest for Temporal.
 * @param {number} params.postgresPort - Host port bound to PostgreSQL.
 * @param {number} params.temporalPort - Host port bound to Temporal.
 * @param {string} params.secretsDir - Directory where postgres-password is kept.
 * @param {string} params.composeProject - Unique Compose project name.
 * @returns {string} Docker Compose YAML definition.
 */
export function generateDevComposeYaml({ postgresImage, temporalImage, postgresPort, temporalPort, secretsDir, composeProject }) {
  const pwFile = path.resolve(secretsDir, "postgres-password").replaceAll("\\", "/");
  return `name: ${composeProject}
services:
  postgres:
    image: ${postgresImage}
    restart: unless-stopped
    environment:
      POSTGRES_DB: spaceapp
      POSTGRES_USER: spaceapp
      POSTGRES_PASSWORD_FILE: /run/secrets/postgres-password
    secrets:
      - source: postgres-password
        target: /run/secrets/postgres-password
    volumes:
      - dev-postgres-data:/var/lib/postgresql/data
    ports:
      - "127.0.0.1:${postgresPort}:5432"
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
      POSTGRES_SEEDS: postgres
      DYNAMIC_CONFIG_FILE_PATH: config/dynamicconfig/docker.yaml
    entrypoint: ["/bin/sh", "-ec"]
    command:
      - export POSTGRES_PWD="$$(cat /run/secrets/postgres-password)"; exec /etc/temporal/entrypoint.sh autosetup
    secrets:
      - source: postgres-password
        target: /run/secrets/postgres-password
    ports:
      - "127.0.0.1:${temporalPort}:7233"
    healthcheck:
      test: ["CMD-SHELL", "temporal operator cluster health --address temporal:7233 >/dev/null && temporal operator namespace describe --namespace default --address temporal:7233 >/dev/null"]
      interval: 5s
      timeout: 5s
      retries: 25

secrets:
  postgres-password:
    file: "${pwFile}"

volumes:
  dev-postgres-data:
`;
}

/**
 * Initializes secrets with owner-only permissions (0600) and returns secret metadata.
 *
 * @param {ReturnType<typeof resolveDevStackConfig>} config
 * @returns {{ password: string, sessionSecret: string, setupToken: string, databaseUrl: string, setupTokenPath: string }}
 */
function ensureSecrets(config) {
  mkdirSync(config.secretsDir, { recursive: true });
  mkdirSync(config.runDir, { recursive: true });
  mkdirSync(config.binDir, { recursive: true });
  mkdirSync(config.varDir, { recursive: true });
  mkdirSync(config.workspacesDir, { recursive: true });

  const pwPath = path.join(config.secretsDir, "postgres-password");
  const sessionPath = path.join(config.secretsDir, "session-secret");
  const setupTokenPath = path.join(config.secretsDir, "setup-token");
  const dbUrlPath = path.join(config.secretsDir, "database-url");

  if (!existsSync(pwPath)) {
    writeFileSync(pwPath, crypto.randomBytes(24).toString("hex") + "\n", { mode: 0o600 });
  }
  if (!existsSync(sessionPath)) {
    writeFileSync(sessionPath, crypto.randomBytes(32).toString("hex") + "\n", { mode: 0o600 });
  }
  if (!existsSync(setupTokenPath)) {
    writeFileSync(setupTokenPath, crypto.randomBytes(24).toString("hex") + "\n", { mode: 0o600 });
  }

  // Ensure owner-only permissions (0600)
  if (process.platform !== "win32") {
    chmodSync(pwPath, 0o600);
    chmodSync(sessionPath, 0o600);
    chmodSync(setupTokenPath, 0o600);
  }

  const password = readFileSync(pwPath, "utf8").trim();
  const dbUrl = `postgresql://spaceapp:${password}@127.0.0.1:${config.postgresPort}/spaceapp`;
  writeFileSync(dbUrlPath, dbUrl + "\n", { mode: 0o600 });
  if (process.platform !== "win32") {
    chmodSync(dbUrlPath, 0o600);
  }

  return {
    password,
    sessionSecret: readFileSync(sessionPath, "utf8").trim(),
    setupToken: readFileSync(setupTokenPath, "utf8").trim(),
    databaseUrl: dbUrl,
    setupTokenPath
  };
}

/**
 * Polls a TCP port until a connection succeeds or timeout is reached.
 *
 * @param {number} port
 * @param {string} [host="127.0.0.1"]
 * @param {number} [timeoutMs=60000]
 * @returns {Promise<boolean>}
 */
async function waitForPort(port, host = "127.0.0.1", timeoutMs = 60000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const ready = await new Promise((resolve) => {
      const socket = new net.Socket();
      socket.setTimeout(1000);
      socket.once("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.once("error", () => {
        socket.destroy();
        resolve(false);
      });
      socket.once("timeout", () => {
        socket.destroy();
        resolve(false);
      });
      socket.connect(port, host);
    });
    if (ready) return true;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`Timed out waiting for port ${host}:${port} after ${timeoutMs}ms`);
}

/**
 * Synchronously executes a command and asserts zero exit status.
 *
 * @param {string} command
 * @param {string[]} args
 * @param {object} [options={}]
 */
function runCommand(command, args, options = {}) {
  const res = spawnSync(command, args, { stdio: "inherit", ...options });
  if (res.error) throw res.error;
  if (res.status !== 0) throw new Error(`${command} ${args.join(" ")} exited with code ${res.status}`);
}

/**
 * Installs the pinned version of opencode-ai into the state directory and creates wrapper scripts.
 *
 * @param {ReturnType<typeof resolveDevStackConfig>} config
 * @param {string} opencodeVersion
 */
export function setupOpencodeWrapper(config, opencodeVersion) {
  mkdirSync(config.opencodeDir, { recursive: true });
  mkdirSync(config.binDir, { recursive: true });

  const pkgJsonPath = path.join(config.opencodeDir, "package.json");
  if (!existsSync(pkgJsonPath)) {
    writeFileSync(pkgJsonPath, JSON.stringify({ name: "dev-stack-opencode", private: true }, null, 2) + "\n");
  }

  const opencodeBin = path.join(config.opencodeDir, "node_modules", ".bin", process.platform === "win32" ? "opencode.cmd" : "opencode");
  if (!existsSync(opencodeBin)) {
    console.log(`Installing pinned opencode-ai@${opencodeVersion} into state directory...`);
    runCommand("npm", ["install", "--no-audit", "--no-fund", `opencode-ai@${opencodeVersion}`], {
      cwd: config.opencodeDir
    });
  }

  // Create opencode-vscode-parity wrapper script in binDir
  const parityPath = path.join(config.binDir, "opencode-vscode-parity");
  const wrapperContent = `#!/usr/bin/env bash
set -euo pipefail
export PATH="${config.opencodeDir}/node_modules/.bin:$PATH"
exec opencode "$@"
`;
  writeFileSync(parityPath, wrapperContent, { mode: 0o755 });

  if (process.platform === "win32") {
    const cmdPath = path.join(config.binDir, "opencode-vscode-parity.cmd");
    writeFileSync(cmdPath, `@echo off\nset "PATH=${config.opencodeDir}\\node_modules\\.bin;%PATH%"\n"${opencodeBin}" %*\n`);
  }
}

/**
 * Stops running dev-stack child processes and Docker Compose services.
 *
 * @param {ReturnType<typeof resolveDevStackConfig>} config
 * @param {{ purge?: boolean }} [options]
 * @returns {Promise<void>}
 */
export async function stopDevStack(config, { purge = false } = {}) {
  const composeFile = path.join(config.stateRoot, "docker-compose.yml");
  console.log("Stopping dev-stack processes and containers...");

  // Kill running child processes if pidfile exists
  if (existsSync(config.pidFile)) {
    try {
      const pids = JSON.parse(readFileSync(config.pidFile, "utf8"));
      for (const [name, pid] of Object.entries(pids)) {
        try {
          process.kill(pid, "SIGTERM");
        } catch {
          // Process might already be dead
        }
      }
    } catch {
      // Ignore pidfile read errors
    }
    rmSync(config.pidFile, { force: true });
  }

  if (existsSync(composeFile)) {
    const args = ["compose", "-p", config.composeProject, "-f", composeFile];
    if (purge) {
      args.push("down", "-v", "--remove-orphans");
    } else {
      args.push("stop");
    }
    spawnSync("docker", args, { stdio: "inherit" });
  }

  if (purge) {
    console.log(`Purging state directory: ${config.stateRoot}`);
    rmSync(config.stateRoot, { recursive: true, force: true });
  }
}

/**
 * Starts the full SpaceApp dev stack from source.
 * Spawns Docker dependencies, runs migrations, prepares opencode wrapper, and launches child servers.
 *
 * @param {ReturnType<typeof resolveDevStackConfig>} config
 * @returns {Promise<void>}
 */
export async function startDevStack(config) {
  console.log("Starting SpaceApp dev-stack from source...");

  const composeContent = readFileSync(TEMPLATE_COMPOSE_PATH, "utf8");
  const dockerfileContent = readFileSync(DOCKERFILE_PATH, "utf8");

  const images = parsePinnedImages(composeContent);
  const opencodeVersion = parsePinnedOpencodeVersion(dockerfileContent);

  const secrets = ensureSecrets(config);
  const composeYaml = generateDevComposeYaml({
    postgresImage: images.postgres,
    temporalImage: images.temporal,
    postgresPort: config.postgresPort,
    temporalPort: config.temporalPort,
    secretsDir: config.secretsDir,
    composeProject: config.composeProject
  });

  const composeFile = path.join(config.stateRoot, "docker-compose.yml");
  writeFileSync(composeFile, composeYaml, "utf8");

  console.log(`Starting Docker dependencies (postgres and temporal, project: ${config.composeProject})...`);
  runCommand("docker", ["compose", "-p", config.composeProject, "-f", composeFile, "up", "-d"]);

  console.log(`Waiting for PostgreSQL on 127.0.0.1:${config.postgresPort}...`);
  await waitForPort(config.postgresPort, "127.0.0.1", 60000);

  console.log(`Waiting for Temporal on 127.0.0.1:${config.temporalPort}...`);
  await waitForPort(config.temporalPort, "127.0.0.1", 90000);

  console.log("Running database migrations...");
  runCommand("npm", ["run", "db:migrate"], {
    env: {
      ...process.env,
      SPACE_DATABASE_URL: secrets.databaseUrl
    }
  });

  console.log("Setting up local opencode wrapper...");
  setupOpencodeWrapper(config, opencodeVersion);

  // Build required packages if not already built
  console.log("Ensuring packages are compiled...");
  runCommand("npm", ["run", "build:packages"], {
    shell: true
  });

  // Spawn services
  const cliSocketPath = path.join(config.runDir, "cli-host.sock");
  const children = new Map();
  let stopping = false;

  function shutdown(signal = "SIGTERM") {
    if (stopping) return;
    stopping = true;
    console.log(`\nStopping dev-stack (${signal})...`);
    for (const [name, child] of children) {
      try {
        child.kill(signal);
      } catch {}
    }
    stopDevStack(config, { purge: false }).then(() => {
      process.exit(0);
    });
  }

  for (const sig of ["SIGINT", "SIGTERM"]) {
    process.once(sig, () => shutdown(sig));
  }

  const envCommon = {
    ...process.env,
    PATH: `${config.binDir}${path.delimiter}${config.opencodeDir}/node_modules/.bin${path.delimiter}${process.env.PATH || ""}`,
    SPACE_DATABASE_URL: secrets.databaseUrl,
    SPACE_SESSION_SECRET: secrets.sessionSecret,
    SPACE_SETUP_TOKEN_SOURCE_FILE: secrets.setupTokenPath,
    SPACE_SETUP_TOKEN_FILE: secrets.setupTokenPath,
    SPACE_SETUP_TOKEN: secrets.setupToken,
    SPACE_DEV_LOGIN: "false",
    SPACE_PUBLIC_DISTRIBUTION: "true",
    SPACE_CLI_HOST_SOCKET: cliSocketPath,
    SPACE_CLI_ENABLED: "true",
    SPACE_CLI_COMMAND_PATH: config.binDir,
    SPACE_CLI_WORKSPACE_ROOT: config.workspacesDir,
    SPACE_TEMPORAL_ADDRESS: `127.0.0.1:${config.temporalPort}`,
    SPACEAPP_WORKFLOWS_ENABLED: "true",
    SPACE_API_HOST: "127.0.0.1",
    SPACE_API_PORT: String(config.apiPort),
    SPACE_API_ORIGIN: `http://127.0.0.1:${config.apiPort}`,
    SPACE_WEB_HOST: "127.0.0.1",
    SPACE_WEB_PORT: String(config.webPort),
    SPACE_MEMORY_ROOT: path.join(config.varDir, "memory"),
    SPACE_ARTIFACT_ROOT: path.join(config.varDir, "artifacts")
  };

  mkdirSync(envCommon.SPACE_MEMORY_ROOT, { recursive: true });
  mkdirSync(envCommon.SPACE_ARTIFACT_ROOT, { recursive: true });

  // 1. CLI Host
  console.log("Spawning CLI Host...");
  const cliHostProc = spawn(process.execPath, [path.join(ROOT, "packages", "cli-host", "dist", "main.js")], {
    env: envCommon,
    stdio: "inherit"
  });
  children.set("cli-host", cliHostProc);

  // 2. Worker
  console.log("Spawning Temporal Worker...");
  const workerProc = spawn(process.execPath, [path.join(ROOT, "apps", "worker", "dist", "worker.js")], {
    env: envCommon,
    stdio: "inherit"
  });
  children.set("worker", workerProc);

  // 3. API in watch mode (launch direct tsx CLI via node to avoid intermediate npx wrapper)
  console.log("Spawning API in watch mode...");
  const tsxCli = path.join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
  const apiProc = existsSync(tsxCli)
    ? spawn(process.execPath, [tsxCli, "watch", "src/server.ts"], {
        cwd: path.join(ROOT, "apps", "api"),
        env: envCommon,
        stdio: "inherit"
      })
    : spawn(process.platform === "win32" ? "npx.cmd" : "npx", ["tsx", "watch", "src/server.ts"], {
        cwd: path.join(ROOT, "apps", "api"),
        env: envCommon,
        stdio: "inherit"
      });
  children.set("api", apiProc);

  // 4. Vite Web dev server (launch direct vite CLI via node to avoid intermediate npx wrapper)
  console.log(`Spawning Vite Web dev server on port ${config.webPort}...`);
  const viteCli = path.join(ROOT, "node_modules", "vite", "bin", "vite.js");
  const webProc = existsSync(viteCli)
    ? spawn(process.execPath, [viteCli, "--host", "127.0.0.1", "--port", String(config.webPort)], {
        cwd: path.join(ROOT, "apps", "web"),
        env: envCommon,
        stdio: "inherit"
      })
    : spawn(process.platform === "win32" ? "npx.cmd" : "npx", ["vite", "--host", "127.0.0.1", "--port", String(config.webPort)], {
        cwd: path.join(ROOT, "apps", "web"),
        env: envCommon,
        stdio: "inherit"
      });
  children.set("web", webProc);

  // Write PIDs
  const pids = {};
  for (const [name, proc] of children) {
    pids[name] = proc.pid;
    proc.once("exit", (code, signal) => {
      children.delete(name);
      if (!stopping) {
        console.error(`\n[FATAL] Dev stack process "${name}" exited unexpectedly (code: ${code}, signal: ${signal}).`);
        shutdown("SIGTERM");
      }
    });
  }
  writeFileSync(config.pidFile, JSON.stringify(pids, null, 2) + "\n");

  console.log("\n============================================================");
  console.log("🚀 SpaceApp full stack is running from source!");
  console.log(`   Web UI:      http://127.0.0.1:${config.webPort}`);
  console.log(`   API Origin:  http://127.0.0.1:${config.apiPort}`);
  console.log(`   PostgreSQL:  127.0.0.1:${config.postgresPort}`);
  console.log(`   Temporal:    127.0.0.1:${config.temporalPort}`);
  console.log(`   Setup Token: ${secrets.setupToken}`);
  console.log("============================================================");
  console.log("Paste the setup token at the Web UI to initialize your owner account.");
  console.log("Press Ctrl+C to stop the stack.\n");
}

/**
 * Main CLI entrypoint for scripts/dev-stack.mjs.
 */
async function main() {
  const args = process.argv.slice(2);
  const config = resolveDevStackConfig();

  if (args.includes("down") || args.includes("--down")) {
    await stopDevStack(config, { purge: false });
    return;
  }
  if (args.includes("reset") || args.includes("--reset")) {
    await stopDevStack(config, { purge: true });
    return;
  }

  await startDevStack(config);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  main().catch((err) => {
    console.error(`\n[dev-stack error] ${err.message}`);
    process.exit(1);
  });
}
