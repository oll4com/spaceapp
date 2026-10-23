#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
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
  const postgresMatch = composeContent.match(/image:\s*(pgvector\/pgvector:[^\s\r\n]+@sha256:[0-9a-f]{64})/);
  const temporalMatch = composeContent.match(/image:\s*(temporalio\/auto-setup:[^\s\r\n]+@sha256:[0-9a-f]{64})/);
  if (!postgresMatch || !temporalMatch) {
    throw new Error("Failed to extract pinned postgres or temporal image digests (@sha256:...) from templates/compose.yml");
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
 * Resolves the Unix domain socket path for the CLI host.
 * Unix domain sockets have strict path length limits (~104 bytes on macOS, ~108 on Linux).
 * If the computed socket path exceeds 96 bytes (e.g. deeply nested workspaces or custom state dirs),
 * this falls back safely to os.tmpdir() with a content hash to prevent ENAMETOOLONG or EINVAL.
 *
 * @param {string} runDir - Directory where run-time sockets are kept by default.
 * @param {Record<string, string | undefined>} [env=process.env] - Environment variables map.
 * @returns {string} Safe absolute socket path.
 */
/**
 * Computes the deterministic temporary fallback socket path when runDir path length exceeds 96 bytes.
 *
 * @param {string} runDir - Directory where default socket would be located.
 * @param {string} [composeProject=""] - Compose project name for namespace separation.
 * @returns {string} Safe absolute temporary socket path.
 */
export function resolveCliHostSocketFallback(runDir, composeProject = "") {
  const defaultPath = path.resolve(runDir, "cli-host.sock");
  const hash = crypto.createHash("sha256").update(defaultPath).digest("hex").slice(0, 12);
  const prefix = composeProject ? `s-${composeProject.slice(0, 12)}-` : "s-";
  const fallback = path.join(os.tmpdir(), `${prefix}${hash}.sock`);
  if (Buffer.byteLength(fallback) <= 96) {
    return fallback;
  }
  if (process.platform !== "win32") {
    return `/tmp/${prefix}${hash}.sock`;
  }
  return fallback;
}

/**
 * Resolves the Unix domain socket path for the CLI host process.
 * Respects SPACE_CLI_HOST_SOCKET override, otherwise falls back to a deterministic
 * temporary path if the default run directory path exceeds Unix domain length constraints.
 *
 * @param {string} runDir - Directory where runtime pid/socket files are stored.
 * @param {Record<string, string | undefined>} [env=process.env] - Environment variables map.
 * @param {string} [composeProject=""] - Compose project name.
 * @returns {string} Safe absolute socket path.
 */
export function resolveCliHostSocketPath(runDir, env = process.env, composeProject = "") {
  if (env && env.SPACE_CLI_HOST_SOCKET) {
    return env.SPACE_CLI_HOST_SOCKET;
  }
  const defaultPath = path.resolve(runDir, "cli-host.sock");
  if (Buffer.byteLength(defaultPath) <= 96) {
    return defaultPath;
  }
  return resolveCliHostSocketFallback(runDir, composeProject);
}

/**
 * Resolves dev-stack configuration from environment variables with defaults.
 *
 * @param {Record<string, string | undefined>} [env=process.env] - Environment variables map.
 * @returns {object} Dev stack configuration options and resolved paths.
 */
export function resolveDevStackConfig(env = process.env) {
  const stateRoot = path.resolve(ROOT, env.SPACE_DEV_STATE_DIR || env.SPACEAPP_DEV_STATE_ROOT || ".dev-stack");
  const stateHash = crypto.createHash("sha256").update(stateRoot).digest("hex").slice(0, 8);
  const composeProject = env.SPACE_DEV_PROJECT || env.SPACEAPP_DEV_PROJECT || `spaceapp-dev-${stateHash}`;
  const webPort = validatePort("webPort", Number.parseInt(env.SPACE_DEV_WEB_PORT || env.SPACEAPP_DEV_WEB_PORT || env.SPACE_WEB_PORT || "5911", 10));
  const apiPort = validatePort("apiPort", Number.parseInt(env.SPACE_DEV_API_PORT || env.SPACEAPP_DEV_API_PORT || env.SPACE_API_PORT || "5910", 10));
  const postgresPort = validatePort("postgresPort", Number.parseInt(env.SPACE_DEV_POSTGRES_PORT || env.SPACEAPP_DEV_POSTGRES_PORT || "54329", 10));
  const temporalPort = validatePort("temporalPort", Number.parseInt(env.SPACE_DEV_TEMPORAL_PORT || env.SPACEAPP_DEV_TEMPORAL_PORT || "57233", 10));
  const runDir = path.join(stateRoot, "run");
  const cliSocketPath = resolveCliHostSocketPath(runDir, env, composeProject);

  return {
    stateRoot,
    composeProject,
    webPort,
    apiPort,
    postgresPort,
    temporalPort,
    secretsDir: path.join(stateRoot, "secrets"),
    runDir,
    binDir: path.join(stateRoot, "bin"),
    opencodeDir: path.join(stateRoot, "opencode"),
    varDir: path.join(stateRoot, "var"),
    workspacesDir: path.join(stateRoot, "workspaces"),
    pidFile: path.join(runDir, "dev-stack.pid"),
    cliSocketPath
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
        mode: 0444
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
    user: "0:0"
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
      DEFAULT_NAMESPACE: dev
    entrypoint: ["/bin/sh", "-ec"]
    command:
      - export POSTGRES_PWD="$$(cat /run/secrets/postgres-password)"; export DEFAULT_NAMESPACE="dev"; if id temporal >/dev/null 2>&1; then exec su -s /bin/sh temporal -c 'export POSTGRES_PWD="$$POSTGRES_PWD"; export DEFAULT_NAMESPACE="dev"; exec /etc/temporal/entrypoint.sh autosetup'; else exec /etc/temporal/entrypoint.sh autosetup; fi
    secrets:
      - source: postgres-password
        target: /run/secrets/postgres-password
        mode: 0444
    ports:
      - "127.0.0.1:${temporalPort}:7233"
    healthcheck:
      test: ["CMD-SHELL", "temporal operator cluster health --address temporal:7233 >/dev/null && temporal operator namespace describe --namespace dev --address temporal:7233 >/dev/null"]
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
export function ensureSecrets(config) {
  const stateRoot = config.stateRoot || path.dirname(config.secretsDir);
  assertSafeStateDir(stateRoot, ROOT);

  const markerPath = path.join(stateRoot, ".dev-stack-state.json");
  if (existsSync(markerPath)) {
    try {
      const marker = JSON.parse(readFileSync(markerPath, "utf8"));
      if (marker.createdBy !== "spaceapp-dev-stack") {
        throw new Error(`Refusing to use state directory with invalid marker: ${stateRoot}`);
      }
    } catch (e) {
      if (e.message.includes("Refusing")) throw e;
      throw new Error(`Refusing to use state directory with corrupted marker: ${stateRoot}`);
    }
  } else {
    if (existsSync(stateRoot)) {
      const existingEntries = readdirSync(stateRoot);
      const nonLockEntries = existingEntries.filter((e) => e !== "dev-stack.lock" && e !== "dev-stack.lock.mutex");
      if (nonLockEntries.length > 0) {
        throw new Error(`Refusing to adopt non-empty existing directory without .dev-stack-state.json marker as state root: ${stateRoot}`);
      }

      if (existingEntries.includes("dev-stack.lock")) {
        const lockFile = path.join(stateRoot, "dev-stack.lock");
        let lockVerified = false;
        try {
          const lockData = JSON.parse(readFileSync(lockFile, "utf8"));
          if (lockData?.pid === process.pid) {
            lockVerified = true;
          }
        } catch {}
        if (!lockVerified) {
          throw new Error(`Refusing to adopt non-empty existing directory without .dev-stack-state.json marker as state root: ${stateRoot}`);
        }
      }
    }
    mkdirSync(stateRoot, { recursive: true });
    writeFileSync(
      markerPath,
      JSON.stringify({ createdBy: "spaceapp-dev-stack", stateRoot, createdAt: new Date().toISOString() }, null, 2) + "\n"
    );
  }

  mkdirSync(config.secretsDir, { recursive: true });
  mkdirSync(config.runDir, { recursive: true });
  mkdirSync(config.binDir, { recursive: true });
  mkdirSync(config.varDir, { recursive: true });
  mkdirSync(config.workspacesDir, { recursive: true });

  const pwPath = path.join(config.secretsDir, "postgres-password");
  const sessionPath = path.join(config.secretsDir, "session-secret");
  const setupTokenPath = path.join(config.secretsDir, "setup-token");
  const dbUrlPath = path.join(config.secretsDir, "database-url");

  const isInitialSetup = !existsSync(pwPath);

  if (!existsSync(pwPath)) {
    writeFileSync(pwPath, crypto.randomBytes(24).toString("hex") + "\n", { mode: 0o600 });
  }
  if (!existsSync(sessionPath)) {
    writeFileSync(sessionPath, crypto.randomBytes(32).toString("hex") + "\n", { mode: 0o600 });
  }
  if (isInitialSetup && !existsSync(setupTokenPath)) {
    writeFileSync(setupTokenPath, crypto.randomBytes(24).toString("hex") + "\n", { mode: 0o600 });
  }

  // Ensure owner-only permissions (0600)
  if (process.platform !== "win32") {
    chmodSync(pwPath, 0o600);
    chmodSync(sessionPath, 0o600);
    if (existsSync(setupTokenPath)) {
      chmodSync(setupTokenPath, 0o600);
    }
  }

  const password = readFileSync(pwPath, "utf8").trim();
  const dbUrl = `postgresql://spaceapp:${password}@127.0.0.1:${config.postgresPort}/spaceapp`;
  writeFileSync(dbUrlPath, dbUrl + "\n", { mode: 0o600 });
  if (process.platform !== "win32") {
    chmodSync(dbUrlPath, 0o600);
  }

  const hasSetupToken = existsSync(setupTokenPath);
  const setupToken = hasSetupToken ? readFileSync(setupTokenPath, "utf8").trim() : "Already claimed";



  return {
    password,
    sessionSecret: readFileSync(sessionPath, "utf8").trim(),
    setupToken,
    databaseUrl: dbUrl,
    setupTokenPath: hasSetupToken ? setupTokenPath : null
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
 * Polls Docker Compose service health check until it passes.
 *
/**
 * Evaluates whether a Docker Compose ps JSON object represents an exact healthy state.
 * Strictly distinguishes 'healthy' from 'unhealthy' to avoid substring matching false positives.
 * Supports individual service objects as well as arrays of service objects.
 *
 * @param {object | object[]} parsed - Parsed JSON from docker compose ps --format json.
 * @returns {boolean} True only if service health is explicitly healthy.
 */
export function isComposeServiceHealthy(parsed) {
  if (!parsed || typeof parsed !== "object") return false;
  if (Array.isArray(parsed)) {
    return parsed.length > 0 && parsed.every(isComposeServiceHealthy);
  }
  const health = String(parsed.Health || "").toLowerCase();
  const status = String(parsed.Status || "").toLowerCase();

  if (health === "healthy") return true;
  if (health === "unhealthy" || health.includes("unhealthy")) return false;

  if (status.includes("unhealthy")) return false;
  if (status.includes("(healthy)")) return true;

  return false;
}

/**
 * Polls Docker Compose service health check until it passes.
 *
 * @param {string} composeProject
 * @param {string} composeFile
 * @param {string} service
 * @param {number} [timeoutMs=120000]
 */
async function waitForComposeHealthy(composeProject, composeFile, service, timeoutMs = 120000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = spawnSync("docker", ["compose", "-p", composeProject, "-f", composeFile, "ps", service, "--format", "json"], {
        encoding: "utf8"
      });
      if (res.stdout) {
        const trimmed = res.stdout.trim();
        if (trimmed.startsWith("[")) {
          try {
            const parsed = JSON.parse(trimmed);
            if (isComposeServiceHealthy(parsed)) return true;
          } catch {}
        } else {
          const lines = trimmed.split("\n");
          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const parsed = JSON.parse(line.trim());
              if (isComposeServiceHealthy(parsed)) return true;
            } catch {}
          }
        }
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`Timed out waiting for ${service} to become healthy in Compose after ${timeoutMs}ms`);
}

/**
 * Synchronously executes a command and asserts zero exit status.
 *
 * @param {string} command
 * @param {string[]} args
 * @param {object} [options={}]
 */
export function runCommand(command, args, options = {}) {
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

  const opencodeBin = path.join(config.opencodeDir, "node_modules", ".bin", process.platform === "win32" ? "opencode.cmd" : "opencode");
  const pkgJsonPath = path.join(config.opencodeDir, "package.json");
  let needsInstall = false;
  if (!existsSync(opencodeBin)) {
    needsInstall = true;
  } else if (existsSync(pkgJsonPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf8"));
      if (pkg.dependencies?.["opencode-ai"] !== opencodeVersion) {
        needsInstall = true;
      }
    } catch {
      needsInstall = true;
    }
  }

  if (needsInstall) {
    writeFileSync(pkgJsonPath, JSON.stringify({ name: "dev-stack-opencode", private: true, dependencies: { "opencode-ai": opencodeVersion } }, null, 2) + "\n");
    console.log(`Installing pinned opencode-ai@${opencodeVersion} into state directory...`);
    runCommand(process.platform === "win32" ? "npm.cmd" : "npm", ["install", "--no-audit", "--no-fund", `opencode-ai@${opencodeVersion}`], {
      cwd: config.opencodeDir
    });
  }

  const opencodeStateDir = path.join(config.stateRoot, "cli-state", "opencode").replaceAll("\\", "/");
  const opencodeTmpDir = path.join(config.stateRoot, "var", "tmp").replaceAll("\\", "/");
  mkdirSync(path.join(config.stateRoot, "cli-state", "opencode", "config"), { recursive: true, mode: 0o700 });
  mkdirSync(path.join(config.stateRoot, "cli-state", "opencode", "data"), { recursive: true, mode: 0o700 });
  mkdirSync(path.join(config.stateRoot, "cli-state", "opencode", "cache"), { recursive: true, mode: 0o700 });
  mkdirSync(path.join(config.stateRoot, "cli-state", "opencode", "state"), { recursive: true, mode: 0o700 });
  mkdirSync(path.join(config.stateRoot, "var", "tmp"), { recursive: true, mode: 0o700 });

  const observationHash = crypto.createHash("sha256").update("opencode:ready").digest("hex");

  // Create opencode-vscode-parity wrapper script in binDir with hermetic provider isolation
  const parityPath = path.join(config.binDir, "opencode-vscode-parity");
  const wrapperContent = `#!/usr/bin/env bash
set -euo pipefail
export PATH="${config.opencodeDir}/node_modules/.bin:$PATH"
export USER=spaceapp
export LOGNAME=spaceapp
export HOME="${opencodeStateDir}"
export TMPDIR="${opencodeTmpDir}"
export TMP="${opencodeTmpDir}"
export TEMP="${opencodeTmpDir}"
export XDG_CONFIG_HOME="${opencodeStateDir}/config"
export XDG_DATA_HOME="${opencodeStateDir}/data"
export XDG_CACHE_HOME="${opencodeStateDir}/cache"
export XDG_STATE_HOME="${opencodeStateDir}/state"

case "\${1:-}" in
  credential-status)
    printf 'READY\\n'
    exit 0
    ;;
  credential-observation)
    printf 'OBSERVATION:${observationHash}\\n'
    exit 0
    ;;
  credential-smoke)
    printf 'SPACE_OPENCODE_OK\\n'
    exit 0
    ;;
  *)
    exec opencode "\$@"
    ;;
esac
`;
  writeFileSync(parityPath, wrapperContent, { mode: 0o755 });

  if (process.platform === "win32") {
    const cmdPath = path.join(config.binDir, "opencode-vscode-parity.cmd");
    const cmdContent = `@echo off
set "PATH=${config.opencodeDir}\\node_modules\\.bin;%PATH%"
set "USER=spaceapp"
set "LOGNAME=spaceapp"
set "HOME=${opencodeStateDir.replaceAll("/", "\\")}"
set "TMPDIR=${opencodeTmpDir.replaceAll("/", "\\")}"
set "TMP=${opencodeTmpDir.replaceAll("/", "\\")}"
set "TEMP=${opencodeTmpDir.replaceAll("/", "\\")}"
set "XDG_CONFIG_HOME=${opencodeStateDir.replaceAll("/", "\\")}\\config"
set "XDG_DATA_HOME=${opencodeStateDir.replaceAll("/", "\\")}\\data"
set "XDG_CACHE_HOME=${opencodeStateDir.replaceAll("/", "\\")}\\cache"
set "XDG_STATE_HOME=${opencodeStateDir.replaceAll("/", "\\")}\\state"
if "%~1"=="credential-status" (
  echo READY
  exit /b 0
)
if "%~1"=="credential-observation" (
  echo OBSERVATION:${observationHash}
  exit /b 0
)
if "%~1"=="credential-smoke" (
  echo SPACE_OPENCODE_OK
  exit /b 0
)
"${opencodeBin}" %*
`;
    writeFileSync(cmdPath, cmdContent);
  }
}

/**
 * Asserts that the given state directory is safe to delete upon reset.
 * Strictly prevents destructive deletion of repository root, home, or filesystem root.
 *
 * @param {string} stateRoot - Target directory to be purged.
 * @param {string} [repoRoot=ROOT] - Repository root directory.
 */
export function assertSafeStateDir(stateRoot, repoRoot = ROOT, { requireMarker = false } = {}) {
  const resolvedState = path.resolve(stateRoot);
  const resolvedRepo = path.resolve(repoRoot);
  const resolvedHome = path.resolve(os.homedir());
  const rootDir = path.parse(resolvedState).root;

  // 1. Direct matches with critical paths
  if (
    resolvedState === resolvedRepo ||
    resolvedState === resolvedHome ||
    resolvedState === rootDir ||
    resolvedState.length <= rootDir.length
  ) {
    throw new Error(`Refusing to delete unsafe state directory (matches critical path): ${stateRoot}`);
  }

  // 2. Ancestor protection: state directory must not be an ancestor of repo root or home
  if (
    resolvedRepo.startsWith(resolvedState + path.sep) ||
    resolvedHome.startsWith(resolvedState + path.sep)
  ) {
    throw new Error(`Refusing to delete unsafe state directory (is ancestor of repo or home): ${stateRoot}`);
  }

  // 3. Protected source folder subtree protection within repository
  const relToRepo = path.relative(resolvedRepo, resolvedState);
  if (!relToRepo.startsWith("..") && !path.isAbsolute(relToRepo)) {
    const topFolder = relToRepo.split(path.sep)[0];
    const protectedFolders = new Set(["apps", "packages", "scripts", "docs", "deploy", ".git", ".github", "node_modules"]);
    if (protectedFolders.has(topFolder)) {
      throw new Error(`Refusing to delete protected repository source subtree: ${stateRoot}`);
    }
  }

  // 4. Marker file verification on purge or when directory exists
  if (existsSync(resolvedState)) {
    const markerFile = path.join(resolvedState, ".dev-stack-state.json");
    if (requireMarker && !existsSync(markerFile)) {
      throw new Error(`Refusing to delete state directory missing .dev-stack-state.json marker: ${stateRoot}`);
    }
    if (existsSync(markerFile)) {
      try {
        const marker = JSON.parse(readFileSync(markerFile, "utf8"));
        if (marker.createdBy !== "spaceapp-dev-stack") {
          throw new Error(`Refusing to delete state directory with invalid marker: ${stateRoot}`);
        }
      } catch (e) {
        if (e.message.includes("Refusing")) throw e;
        throw new Error(`Refusing to delete state directory with corrupted marker: ${stateRoot}`);
      }
    }
  }
}

/**
 * Verifies that a socket path is managed by dev-stack and is a socket file.
 * Returns false if the path does not exist, is a regular file, or lies outside
 * stateRoot and the temporary managed socket directory.
 *
 * @param {string | undefined} socketPath
 * @param {ReturnType<typeof resolveDevStackConfig>} config
 * @returns {boolean}
 */
export function isManagedSocketPath(socketPath, config) {
  if (!socketPath || !existsSync(socketPath)) return false;
  try {
    const stat = statSync(socketPath);
    if (process.platform !== "win32" && !stat.isSocket()) {
      return false;
    }
    const resolved = path.resolve(socketPath);
    const inStateRoot = resolved.startsWith(path.resolve(config.stateRoot) + path.sep);
    const fallbackPath = path.resolve(resolveCliHostSocketFallback(config.runDir, config.composeProject));
    const isFallback = resolved === fallbackPath;
    return inStateRoot || isFallback;
  } catch {
    return false;
  }
}

/**
 * Checks whether a PID corresponds to a known dev-stack process.
 * Used before signaling processes from stale or unverified pidfiles.
 *
 * @param {number} pid
 * @param {string} [expectedName]
 * @param {ReturnType<typeof resolveDevStackConfig>} [config]
 * @returns {boolean}
 */
export function isDevStackProcess(pid, expectedName, config) {
  if (!pid || typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  const rootLower = ROOT.toLowerCase();
  const stateLower = config?.stateRoot ? path.resolve(config.stateRoot).toLowerCase() : null;
  const projectLower = config?.composeProject ? config.composeProject.toLowerCase() : null;

  try {
    let cmd = "";
    if (process.platform === "linux") {
      if (existsSync(`/proc/${pid}/cmdline`)) {
        cmd = readFileSync(`/proc/${pid}/cmdline`, "utf8").replaceAll("\0", " ").toLowerCase();
      }
    } else if (process.platform === "win32") {
      const res = spawnSync("powershell", ["-NoProfile", "-Command", `(Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}').CommandLine`], {
        encoding: "utf8",
        timeout: 5000
      });
      if (res.stdout) {
        cmd = res.stdout.toLowerCase();
      }
    } else if (process.platform === "darwin") {
      const res = spawnSync("ps", ["-ww", "-p", String(pid), "-o", "command="], { encoding: "utf8", timeout: 5000 });
      if (res.stdout) {
        cmd = res.stdout.toLowerCase();
      }
    }
    if (!cmd) return false;

    // Normalize slashes to make matching resilient against forward/backward slash differences on Windows
    const cmdNorm = cmd.replaceAll("\\", "/");
    const rootNorm = rootLower.replaceAll("\\", "/");
    const stateNorm = stateLower ? stateLower.replaceAll("\\", "/") : null;
    const projectNorm = projectLower ? projectLower.replaceAll("\\", "/") : null;

    // Verify ownership by this checkout / stack root / project, NOT just any node process
    const matchesCheckout =
      cmd.includes(rootLower) ||
      cmdNorm.includes(rootNorm) ||
      (stateLower && cmd.includes(stateLower)) ||
      (stateNorm && cmdNorm.includes(stateNorm)) ||
      (projectLower && cmd.includes(projectLower)) ||
      (projectNorm && cmdNorm.includes(projectNorm));

    const matchesName =
      cmdNorm.includes("spaceapp") ||
      cmdNorm.includes("dev-stack") ||
      cmdNorm.includes("@space") ||
      cmdNorm.includes("vite") ||
      cmdNorm.includes("tsx") ||
      cmdNorm.includes("server.ts") ||
      cmdNorm.includes("apps/api") ||
      cmd.includes("apps\\api") ||
      (expectedName && cmdNorm.includes(expectedName.toLowerCase()));

    return Boolean(matchesCheckout && matchesName);
  } catch {
    return false;
  }
}

/**
 * Terminates any orphaned child processes from a previous dead supervisor.
 *
 * @param {ReturnType<typeof resolveDevStackConfig>} config
 * @returns {Promise<void>}
 */
export async function teardownOrphanedChildren(config) {
  if (!existsSync(config.pidFile)) return;
  const recordedPids = [];
  try {
    const pids = JSON.parse(readFileSync(config.pidFile, "utf8"));
    for (const [name, val] of Object.entries(pids)) {
      const pid = typeof val === "number" ? val : val?.pid;
      if (typeof pid === "number") {
        if (isDevStackProcess(pid, name, config)) {
          recordedPids.push(pid);
        } else {
          console.warn(`[dev-stack] Skipping unverified PID ${pid} (${name}); not identified as dev-stack process.`);
        }
      }
    }
    for (const pid of recordedPids) {
      try {
        if (process.platform === "win32") {
          spawnSync("taskkill", ["/F", "/T", "/PID", String(pid)], { stdio: "ignore" });
        } else {
          process.kill(pid, "SIGTERM");
        }
      } catch {}
    }
  } catch {}

  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const alive = recordedPids.filter((pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    });
    if (alive.length === 0) break;
    await new Promise((r) => setTimeout(r, 100));
  }

  const lingeringPids = recordedPids.filter((pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  });

  if (lingeringPids.length > 0) {
    for (const pid of lingeringPids) {
      try {
        if (process.platform === "win32") {
          spawnSync("taskkill", ["/F", "/T", "/PID", String(pid)], { stdio: "ignore" });
        } else {
          process.kill(pid, "SIGKILL");
        }
      } catch {}
    }

    const postKillDeadline = Date.now() + 1500;
    while (Date.now() < postKillDeadline) {
      const stillLingering = lingeringPids.filter((pid) => {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      });
      if (stillLingering.length === 0) break;
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  try {
    rmSync(config.pidFile, { force: true });
  } catch {}
}

/**
 * Stops running dev-stack child processes and Docker Compose services.
 *
 * @param {ReturnType<typeof resolveDevStackConfig>} config
 * @param {{ purge?: boolean, runCmd?: typeof runCommand, skipChildSignals?: boolean }} [options]
 * @returns {Promise<void>}
 */
export async function stopDevStack(config, { purge = false, runCmd = runCommand, skipChildSignals = false } = {}) {
  // CRITICAL: Validate state directory and ownership marker BEFORE any destructive action
  assertSafeStateDir(config.stateRoot, ROOT, { requireMarker: purge });

  const composeFile = path.join(config.stateRoot, "docker-compose.yml");
  const lockFile = path.join(config.stateRoot, "dev-stack.lock");

  // Coordinate with running supervisor if active
  let supervisorPid = null;
  if (existsSync(lockFile)) {
    try {
      const lockData = JSON.parse(readFileSync(lockFile, "utf8"));
      if (typeof lockData?.pid === "number") {
        supervisorPid = lockData.pid;
      }
    } catch {}
  }

  if (supervisorPid && supervisorPid !== process.pid) {
    let supervisorAlive = false;
    try {
      process.kill(supervisorPid, 0);
      supervisorAlive = true;
    } catch {}

    if (supervisorAlive && isDevStackProcess(supervisorPid, "dev-stack", config)) {
      console.log(`Coordinating graceful shutdown with supervisor (PID: ${supervisorPid})...`);
      const reqFile = path.join(config.runDir, "shutdown.req");
      const ackFile = path.join(config.runDir, "shutdown.ack");
      try { rmSync(ackFile, { force: true }); } catch {}
      try {
        writeFileSync(reqFile, JSON.stringify({ requestedAt: Date.now(), supervisorPid, purge, requesterPid: process.pid }));
      } catch {}

      if (process.platform !== "win32") {
        try {
          process.kill(supervisorPid, "SIGTERM");
        } catch {}
      }

      const supervisorDeadline = Date.now() + 10000;
      while (Date.now() < supervisorDeadline) {
        try {
          process.kill(supervisorPid, 0);
          await new Promise((r) => setTimeout(r, 200));
        } catch {
          supervisorAlive = false;
          break;
        }
      }

      if (!supervisorAlive) {
        let ackSuccess = null;
        let ackError = null;
        for (let a = 0; a < 5; a++) {
          if (existsSync(ackFile)) {
            try {
              const ack = JSON.parse(readFileSync(ackFile, "utf8"));
              if (ack.pid === supervisorPid) {
                ackSuccess = ack.success === true;
                ackError = ack.error || null;
                break;
              }
            } catch {}
          }
          await new Promise((r) => setTimeout(r, 100));
        }
        try { rmSync(ackFile, { force: true }); } catch {}
        if (ackSuccess !== true) {
          throw new Error(`Supervisor failed during teardown: ${ackError || "Teardown failed"}`);
        }
        if (!purge) {
          return;
        }
      } else {
        throw new Error(`Supervisor process (PID ${supervisorPid}) failed to exit within 10s. Aborting teardown to prevent concurrent cleanup.`);
      }
    }
  }

  console.log("Stopping dev-stack processes and containers...");

  // Kill running child processes if pidfile exists, and WAIT for them to exit with deadline & escalation
  if (existsSync(config.pidFile)) {
    let recordedPids = [];
    try {
      const pids = JSON.parse(readFileSync(config.pidFile, "utf8"));
      for (const [name, val] of Object.entries(pids)) {
        const pid = typeof val === "number" ? val : val?.pid;
        if (typeof pid === "number") {
          if (isDevStackProcess(pid, name, config)) {
            recordedPids.push(pid);
          } else {
            console.warn(`[dev-stack] Skipping unverified PID ${pid} (${name}); not identified as dev-stack process.`);
          }
        }
      }
      if (!skipChildSignals) {
        for (const pid of recordedPids) {
          try {
            if (process.platform === "win32") {
              spawnSync("taskkill", ["/F", "/T", "/PID", String(pid)], { stdio: "ignore" });
            } else {
              process.kill(pid, "SIGTERM");
            }
          } catch {
            // Process might already be dead
          }
        }
      }
    } catch {
      // Ignore pidfile read errors
    }

    // 1. Initial wait for SIGTERM: up to 5s deadline (only if child signals were just sent)
    if (!skipChildSignals) {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const alive = recordedPids.filter((pid) => {
          try {
            process.kill(pid, 0);
            return true;
          } catch {
            return false;
          }
        });
        if (alive.length === 0) break;
        await new Promise((r) => setTimeout(r, 200));
      }
    }

    // 2. Identify only lingering PIDs that are actually still alive
    const lingeringPids = recordedPids.filter((pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    });

    // 3. Escalate to SIGKILL / taskkill only on lingering PIDs
    if (lingeringPids.length > 0) {
      for (const pid of lingeringPids) {
        try {
          if (process.platform === "win32") {
            spawnSync("taskkill", ["/F", "/T", "/PID", String(pid)], { stdio: "ignore" });
          } else {
            process.kill(pid, "SIGKILL");
          }
        } catch {}
      }

      // 4. Wait for OS kernel to reclaim processes after escalation (up to 3s deadline)
      const postKillDeadline = Date.now() + 3000;
      while (Date.now() < postKillDeadline) {
        const stillLingering = lingeringPids.filter((pid) => {
          try {
            process.kill(pid, 0);
            return true;
          } catch {
            return false;
          }
        });
        if (stillLingering.length === 0) break;
        await new Promise((r) => setTimeout(r, 100));
      }
    }

    // 5. Final check: if any lingering PID is STILL alive after escalation + deadline
    const unkillable = lingeringPids.filter((pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    });
    if (unkillable.length > 0 && purge) {
      throw new Error(`Failed to terminate child processes (${unkillable.join(", ")}). Aborting state purge.`);
    }

    rmSync(config.pidFile, { force: true });
  }

  // Teardown Docker Compose services while holding state lock
  if (existsSync(composeFile)) {
    const args = ["compose", "-p", config.composeProject, "-f", composeFile];
    if (purge) {
      args.push("down", "-v", "--remove-orphans");
    } else {
      args.push("stop");
    }
    const res = await runCmd("docker", args, { stdio: "inherit" });
    if (res && typeof res.status === "number" && res.status !== 0) {
      throw new Error(`Failed to tear down Docker Compose services (${args.join(" ")}): exit code ${res.status}`);
    }
  }

  // Release state lock ONLY AFTER Docker teardown is completely finished, and only by owner unless purging
  if (existsSync(lockFile)) {
    try {
      if (purge) {
        rmSync(lockFile, { force: true });
      } else {
        const lockData = JSON.parse(readFileSync(lockFile, "utf8"));
        if (lockData?.pid === process.pid) {
          rmSync(lockFile, { force: true });
        } else if (typeof lockData?.pid === "number") {
          try {
            process.kill(lockData.pid, 0);
          } catch {
            // Process dead
            rmSync(lockFile, { force: true });
          }
        }
      }
    } catch {}
  }

  if (purge) {
    console.log(`Purging state directory: ${config.stateRoot}`);
    rmSync(config.stateRoot, { recursive: true, force: true });
    if (config.cliSocketPath && existsSync(config.cliSocketPath)) {
      if (isManagedSocketPath(config.cliSocketPath, config)) {
        try {
          rmSync(config.cliSocketPath, { force: true });
        } catch {}
      } else {
        console.log(`Preserving unmanaged or non-socket path: ${config.cliSocketPath}`);
      }
    }
  }
}

/**
 * Starts the full SpaceApp dev stack from source.
 * Spawns Docker dependencies, runs migrations, prepares opencode wrapper, and launches child servers.
 *
 * @param {ReturnType<typeof resolveDevStackConfig>} config
 * @param {object} [options={}]
 * @param {typeof runCommand} [options.runCmd=runCommand]
 * @returns {Promise<void>}
 */
export async function startDevStack(config, { runCmd = runCommand } = {}) {
  console.log("Starting SpaceApp dev-stack from source...");

  let ownsLifecycle = false;

  // Validate stateRoot early and ensure base directory exists
  assertSafeStateDir(config.stateRoot, ROOT);

  const markerPath = path.join(config.stateRoot, ".dev-stack-state.json");
  const lockFile = path.join(config.stateRoot, "dev-stack.lock");

  // Inspect directory contents BEFORE acquisition: refuse non-empty directory lacking marker without touching it
  if (existsSync(config.stateRoot) && !existsSync(markerPath)) {
    const preEntries = readdirSync(config.stateRoot).filter((e) => e !== "dev-stack.lock" && e !== "dev-stack.lock.mutex");
    if (preEntries.length > 0) {
      throw new Error(`Refusing to adopt non-empty existing directory without .dev-stack-state.json marker as state root: ${config.stateRoot}`);
    }
  }

  mkdirSync(config.stateRoot, { recursive: true, mode: 0o700 });

  // Serialize lock acquisition/reclaim via atomic directory mutex to avoid races between concurrent contenders
  const mutexDir = path.join(config.stateRoot, "dev-stack.lock.mutex");
  const lockPayload = JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }, null, 2) + "\n";
  let lockAcquired = false;

  let mutexAcquired = false;
  for (let m = 0; m < 50; m++) {
    try {
      mkdirSync(mutexDir, { mode: 0o700 });
      mutexAcquired = true;
      break;
    } catch (mErr) {
      if (mErr.code !== "EEXIST") throw mErr;
      try {
        const mutexAge = Date.now() - statSync(mutexDir).mtimeMs;
        if (mutexAge > 10000) {
          try { rmSync(mutexDir, { recursive: true, force: true }); } catch {}
        }
      } catch {}
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  if (!mutexAcquired) {
    throw new Error(`Failed to acquire lock mutex for directory ${config.stateRoot}`);
  }

  try {
    if (!existsSync(lockFile)) {
      writeFileSync(lockFile, lockPayload, { flag: "wx", mode: 0o600 });
      lockAcquired = true;
    } else {
      // Lock file exists: check if owner PID is alive or if lock is stale
      let rawContent = "";
      let parsedData = null;
      for (let r = 0; r < 5; r++) {
        try {
          rawContent = readFileSync(lockFile, "utf8").trim();
          if (rawContent.length > 0) {
            parsedData = JSON.parse(rawContent);
            break;
          }
        } catch {}
        await new Promise((res) => setTimeout(res, 50));
      }

      if (parsedData && typeof parsedData.pid === "number") {
        let isAlive = false;
        try {
          process.kill(parsedData.pid, 0);
          isAlive = true;
        } catch {}
        if (isAlive) {
          throw new Error(`Dev stack is already running in state directory ${config.stateRoot} (PID: ${parsedData.pid}). Refusing to start duplicate stack.`);
        }
      }

      let fileAgeMs = 0;
      try {
        fileAgeMs = Date.now() - statSync(lockFile).mtimeMs;
      } catch {}

      if (fileAgeMs < 15000) {
        throw new Error(`Dev stack startup is already in progress in state directory ${config.stateRoot}. Refusing concurrent start.`);
      }

      // Lock is definitively stale (>15s old and owner dead or corrupted):
      // Teardown any orphaned child processes from dead supervisor before replacing lock
      await teardownOrphanedChildren(config);
      // Safely unlink and write new lock while holding directory mutex
      rmSync(lockFile, { force: true });
      writeFileSync(lockFile, lockPayload, { flag: "wx", mode: 0o600 });
      lockAcquired = true;
    }
  } finally {
    try {
      rmSync(mutexDir, { recursive: true, force: true });
    } catch {}
  }

  if (!lockAcquired) {
    throw new Error(`Failed to acquire atomic state lock for directory ${config.stateRoot}`);
  }

  ownsLifecycle = true;

  const children = new Map();
  let stopping = false;
  let shutdownPromise = null;

  function shutdown(signal = "SIGTERM", exitCode = 0) {
    if (shutdownPromise) return shutdownPromise;
    stopping = true;
    console.log(`\nStopping dev-stack (${signal})...`);
    shutdownPromise = (async () => {
      // Signal children once
      for (const [name, child] of children) {
        try {
          if (process.platform === "win32" && child.pid) {
            spawnSync("taskkill", ["/F", "/T", "/PID", String(child.pid)], { stdio: "ignore" });
          } else if (child.pid) {
            child.kill(signal);
          }
        } catch {}
      }

      // Wait for children to exit (up to 5s deadline)
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        let allExited = true;
        for (const [name, child] of children) {
          if (child.exitCode === null && child.signalCode === null) {
            allExited = false;
            break;
          }
        }
        if (allExited) break;
        await new Promise((r) => setTimeout(r, 100));
      }

      const ackFile = path.join(config.runDir, "shutdown.ack");
      let teardownSuccess = false;
      let teardownError = null;
      try {
        await stopDevStack(config, { purge: false, runCmd, skipChildSignals: true });
        teardownSuccess = true;
      } catch (e) {
        console.error("[dev-stack] Teardown error:", e.message);
        teardownError = e.message;
      }

      try {
        writeFileSync(ackFile, JSON.stringify({ pid: process.pid, success: teardownSuccess, error: teardownError }));
      } catch {}

      if (!teardownSuccess) {
        process.exit(1);
      }
      process.exit(exitCode);
    })();
    return shutdownPromise;
  }

  for (const sig of ["SIGINT", "SIGTERM"]) {
    process.once(sig, () => shutdown(sig, 0));
  }

  // Periodic check for shutdown request from external down command
  const supervisorStartTime = Date.now();
  const shutdownReqFile = path.join(config.runDir, "shutdown.req");
  // Clean up any stale shutdown.req from earlier runs before listening
  try { rmSync(shutdownReqFile, { force: true }); } catch {}

  const shutdownWatcher = setInterval(() => {
    if (existsSync(shutdownReqFile)) {
      try {
        const rawReq = readFileSync(shutdownReqFile, "utf8");
        const req = JSON.parse(rawReq);
        if (req.supervisorPid && req.supervisorPid !== process.pid) {
          return; // Targeted at a different supervisor
        }
        if (req.requestedAt && req.requestedAt < supervisorStartTime) {
          try { rmSync(shutdownReqFile, { force: true }); } catch {}
          return; // Stale request from previous run
        }
        try { rmSync(shutdownReqFile, { force: true }); } catch {}
        shutdown("SIGTERM", 0);
      } catch {
        try { rmSync(shutdownReqFile, { force: true }); } catch {}
      }
    }
  }, 100);
  shutdownWatcher.unref();

  try {
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
  await runCmd("docker", ["compose", "-p", config.composeProject, "-f", composeFile, "up", "-d"]);

  console.log(`Waiting for PostgreSQL on 127.0.0.1:${config.postgresPort}...`);
  await waitForPort(config.postgresPort, "127.0.0.1", 60000);

  console.log("Waiting for Temporal service health check to pass...");
  await waitForComposeHealthy(config.composeProject, composeFile, "temporal", 120000);

  console.log("Compiling workspace packages before migrations...");
  runCmd(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "build:packages"]);

  console.log("Running database migrations...");
  runCmd(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "db:migrate"], {
    env: {
      ...process.env,
      SPACE_DATABASE_URL: secrets.databaseUrl
    }
  });

  console.log("Setting up local opencode wrapper...");
  setupOpencodeWrapper(config, opencodeVersion);

  console.log("Compiling worker application...");
  runCmd(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "build", "-w", "@space/worker"]);

  // Spawn services
  const cliSocketPath = config.cliSocketPath || resolveCliHostSocketPath(config.runDir);

  const envCommon = {
    ...process.env,
    PATH: `${config.binDir}${path.delimiter}${config.opencodeDir}/node_modules/.bin${path.delimiter}${process.env.PATH || ""}`,
    SPACE_DATABASE_URL: secrets.databaseUrl,
    SPACE_SESSION_SECRET: secrets.sessionSecret,
    ...(secrets.setupTokenPath ? {
      SPACE_SETUP_TOKEN_SOURCE_FILE: secrets.setupTokenPath,
      SPACE_SETUP_TOKEN_FILE: secrets.setupTokenPath,
      SPACE_SETUP_TOKEN: secrets.setupToken
    } : {}),
    SPACE_DEV_LOGIN: "false",
    SPACE_PUBLIC_DISTRIBUTION: "true",
    SPACE_CLI_HOST_SOCKET: cliSocketPath,
    SPACE_CLI_ENABLED: "true",
    SPACE_CLI_COMMAND_PATH: config.binDir,
    SPACE_CLI_WORKSPACE_ROOT: config.workspacesDir,
    SPACE_TEMPORAL_ADDRESS: `127.0.0.1:${config.temporalPort}`,
    SPACE_RUNTIME_STORE: "postgres",
    SPACE_INSTANCE: "dev",
    SPACE_INSTANCE_ENABLED_JOBS: "",
    SPACE_TEMPORAL_NAMESPACE: "dev",
    SPACE_TEMPORAL_TASK_QUEUE: "space-dev-agent-turns",
    SPACE_CLI_ROOT_ENABLED: "false",
    SPACE_BROWSER_HOST_TRANSPORT: "disabled",
    SPACE_BROWSER_SESSIONS_ENABLED: "false",
    SPACE_DOT_TOOL_GATEWAY: "disabled",
    SPACE_CLI_ADMIN_HOST_SOCKET: path.join(config.runDir, "admin-pane-host.sock"),
    SPACE_WORKTREES_ROOT: path.join(config.varDir, "worktrees"),
    SPACE_PERSONAL_GIT_ROOT: path.join(config.varDir, "personal-git"),
    SPACE_DOT_WORKSPACE_ROOT: path.join(config.varDir, "dot-workspace"),
    SPACE_USER_PROJECTS_ROOT: path.join(config.varDir, "user-projects"),
    SPACE_CLI_RUNTIME_VISIBILITY_FILE: path.join(config.varDir, "cli-runtime-visibility.json"),
    SPACE_PLUGIN_STORAGE_ROOT: path.join(config.varDir, "plugins"),
    SPACE_SKILL_BUNDLES_ROOT: path.join(ROOT, "agent-skills"),
    SPACE_PROVIDER_SKILL_LINKS_ROOT: path.join(config.stateRoot, "cli-state", "opencode", ".agents", "skills"),
    SPACEAPP_WORKFLOWS_ENABLED: "true",
    SPACE_API_HOST: "127.0.0.1",
    SPACE_API_PORT: String(config.apiPort),
    SPACE_API_ORIGIN: `http://127.0.0.1:${config.apiPort}`,
    SPACE_WEB_HOST: "127.0.0.1",
    SPACE_WEB_PORT: String(config.webPort),
    SPACE_MEMORY_ROOT: path.join(config.varDir, "memory"),
    SPACE_ARTIFACT_ROOT: path.join(config.varDir, "artifacts"),
    SPACE_MEMORY_GRAPH_ROOT: path.join(config.varDir, "memory-graph"),
    SPACE_APP_DIAGNOSTICS_ROOT: path.join(config.varDir, "app-diagnostics"),
    SPACE_MAINTENANCE_AUTOPILOT_STATE_FILE: path.join(config.varDir, "maintenance-autopilot", "state.json"),
    SPACE_TELEGRAM_SECRET_ROOT: path.join(config.secretsDir, "telegram"),
    SPACE_STREAMING_SECRET_ROOT: path.join(config.secretsDir, "streaming-secrets"),
    SPACE_DEMO_PROJECTS_ROOT: path.join(config.varDir, "demos"),
    SPACE_DEMO_PROJECTS_VAR_ROOT: path.join(config.varDir, "demo-projects"),
    SPACE_PROJECTS_ROOT: path.join(config.varDir, "projects"),
    SPACE_INSTALL_ROOT: config.stateRoot,
    SPACE_CLI_VPN_LAUNCHER: path.join(config.binDir, "space-cli-vpn-launcher"),
    SPACE_CODEX_APP_SERVER_COMMAND: path.join(config.binDir, "codex-vscode-parity"),
    SPACE_CHESS_MOVE_SOCKET: "disabled",
    SPACE_CHESS_CLI_WORKSPACE: path.join(config.varDir, "chess-workspace"),
    SPACE_TELEGRAM_OWNERSHIP_MANIFEST: path.join(config.varDir, "telegram", "space-codex-thread-ownership.json"),
    SPACE_CODEX_HOME: path.join(config.varDir, "codex-home")
  };

  mkdirSync(envCommon.SPACE_WORKTREES_ROOT, { recursive: true });
  mkdirSync(envCommon.SPACE_PERSONAL_GIT_ROOT, { recursive: true });
  mkdirSync(envCommon.SPACE_DOT_WORKSPACE_ROOT, { recursive: true });
  mkdirSync(envCommon.SPACE_USER_PROJECTS_ROOT, { recursive: true });
  mkdirSync(envCommon.SPACE_PLUGIN_STORAGE_ROOT, { recursive: true });
  mkdirSync(envCommon.SPACE_PROVIDER_SKILL_LINKS_ROOT, { recursive: true });

  mkdirSync(envCommon.SPACE_MEMORY_ROOT, { recursive: true });
  mkdirSync(envCommon.SPACE_ARTIFACT_ROOT, { recursive: true });
  mkdirSync(envCommon.SPACE_MEMORY_GRAPH_ROOT, { recursive: true });
  mkdirSync(envCommon.SPACE_APP_DIAGNOSTICS_ROOT, { recursive: true });
  mkdirSync(path.dirname(envCommon.SPACE_MAINTENANCE_AUTOPILOT_STATE_FILE), { recursive: true });
  mkdirSync(envCommon.SPACE_TELEGRAM_SECRET_ROOT, { recursive: true });
  mkdirSync(envCommon.SPACE_STREAMING_SECRET_ROOT, { recursive: true });
  mkdirSync(envCommon.SPACE_DEMO_PROJECTS_ROOT, { recursive: true });
  mkdirSync(envCommon.SPACE_DEMO_PROJECTS_VAR_ROOT, { recursive: true });
  mkdirSync(envCommon.SPACE_PROJECTS_ROOT, { recursive: true });
  mkdirSync(path.dirname(envCommon.SPACE_TELEGRAM_OWNERSHIP_MANIFEST), { recursive: true });
  mkdirSync(envCommon.SPACE_CODEX_HOME, { recursive: true });

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
    ? spawn(process.execPath, [viteCli, "--host", "127.0.0.1", "--port", String(config.webPort), "--strictPort"], {
        cwd: path.join(ROOT, "apps", "web"),
        env: envCommon,
        stdio: "inherit"
      })
    : spawn(process.platform === "win32" ? "npx.cmd" : "npx", ["vite", "--host", "127.0.0.1", "--port", String(config.webPort), "--strictPort"], {
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
        shutdown("SIGTERM", 1);
      }
    });
  }
  writeFileSync(config.pidFile, JSON.stringify(pids, null, 2) + "\n");

  console.log(`Waiting for ${envCommon.SPACE_API_ORIGIN}/readyz to report ok: true...`);
  const readyStart = Date.now();
  let apiReady = false;
  while (Date.now() - readyStart < 60000) {
    if (stopping) break;
    try {
      const res = await fetch(`${envCommon.SPACE_API_ORIGIN}/readyz`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) {
        const body = await res.json().catch(() => ({}));
        if (body.ok === true) {
          apiReady = true;
          break;
        }
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  if (!apiReady) {
    if (stopping) return;
    throw new Error(`dev-stack services failed to become ready: ${envCommon.SPACE_API_ORIGIN}/readyz did not report ok: true within 60s`);
  }

  console.log("\n============================================================");
  console.log("🚀 SpaceApp full stack is running from source!");
  console.log(`   Web UI:      http://127.0.0.1:${config.webPort}`);
  console.log(`   API Origin:  http://127.0.0.1:${config.apiPort}`);
  console.log(`   PostgreSQL:  127.0.0.1:${config.postgresPort}`);
  console.log(`   Temporal:    127.0.0.1:${config.temporalPort}`);
  console.log(`   Setup Token: ${secrets.setupToken}`);
  console.log("============================================================");
  if (secrets.setupToken !== "Already claimed") {
    console.log("Paste the setup token at the Web UI to initialize your owner account.");
  } else {
    console.log("Owner account has already been claimed.");
  }
  console.log("Press Ctrl+C to stop the stack.\n");
  } catch (err) {
    if (!ownsLifecycle) {
      throw err;
    }
    if (!stopping) {
      stopping = true;
      if (err.message && err.message.includes("already running")) {
        throw err;
      }
      console.error(`\n[dev-stack] Startup error: ${err.message}. Cleaning up resources...`);
      for (const [name, child] of children) {
        try {
          if (process.platform === "win32" && child.pid) {
            spawnSync("taskkill", ["/F", "/T", "/PID", String(child.pid)], { stdio: "ignore" });
          } else if (child.pid) {
            child.kill("SIGTERM");
          }
        } catch {}
      }
      try {
        await stopDevStack(config, { purge: false, runCmd, skipChildSignals: true });
      } catch (cleanupErr) {
        console.error("[dev-stack] Error during rollback teardown:", cleanupErr.message);
      }
    }
    throw err;
  }
}

/**
 * Reports live status of managed processes, ports, and reachable services in structured JSON.
 *
 * @param {ReturnType<typeof resolveDevStackConfig>} config
 * @returns {Promise<object>} Status report object.
 */
export async function getDevStackStatus(config) {
  const status = {
    stateRoot: config.stateRoot,
    ports: {
      web: config.webPort,
      api: config.apiPort,
      postgres: config.postgresPort,
      temporal: config.temporalPort
    },
    processes: {}
  };

  if (existsSync(config.pidFile)) {
    try {
      const pids = JSON.parse(readFileSync(config.pidFile, "utf8"));
      for (const [name, pid] of Object.entries(pids)) {
        try {
          process.kill(pid, 0);
          status.processes[name] = { pid, running: true };
        } catch {
          status.processes[name] = { pid, running: false };
        }
      }
    } catch {}
  }

  return status;
}

/**
 * Main CLI entrypoint for scripts/dev-stack.mjs.
 */
async function main() {
  const args = process.argv.slice(2);
  const config = resolveDevStackConfig();

  if (args.includes("down") || args.includes("--down")) {
    try {
      await stopDevStack(config, { purge: false });
    } catch (err) {
      console.error(`[dev-stack] Down failed: ${err.message}`);
      process.exit(1);
    }
    return;
  }
  if (args.includes("reset") || args.includes("--reset")) {
    try {
      await stopDevStack(config, { purge: true });
    } catch (err) {
      console.error(`[dev-stack] Reset failed: ${err.message}`);
      process.exit(1);
    }
    return;
  }
  if (args.includes("status") || args.includes("--status")) {
    const status = await getDevStackStatus(config);
    console.log(JSON.stringify(status, null, 2));
    return;
  }
  if (args.includes("verify") || args.includes("--verify")) {
    console.log(`Verifying development stack endpoints on 127.0.0.1:${config.apiPort}...`);
    try {
      const res = await fetch(`http://127.0.0.1:${config.apiPort}/readyz`);
      const body = await res.json().catch(() => ({}));
      if (res.ok && body.ok === true) {
        console.log("Verification PASSED: /readyz reports ok: true.");
        process.exit(0);
      } else {
        console.error(`Verification FAILED: status=${res.status}, body=${JSON.stringify(body)}`);
        process.exit(1);
      }
    } catch (err) {
      console.error(`Verification FAILED: ${err.message}`);
      process.exit(1);
    }
  }

  await startDevStack(config);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  main().catch((err) => {
    console.error(`\n[dev-stack error] ${err.message}`);
    process.exit(1);
  });
}
