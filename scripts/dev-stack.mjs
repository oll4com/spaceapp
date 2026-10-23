#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const defaultRepoRoot = path.resolve(__dirname, "..");

export const defaultDevStackPorts = Object.freeze({
  apiPort: 5910,
  webPort: 5911,
  postgresPort: 55432,
  temporalPort: 57233
});

export const defaultDevStackProjectName = "spaceapp-dev";
export const workspaceBuildOrder = Object.freeze([
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
const stateDirMarkerFile = ".dev-stack-marker.json";
const protectedRepoEntries = new Set([
  ".git",
  ".github",
  "apps",
  "packages",
  "scripts",
  "docs",
  "deploy",
  "node_modules"
]);

/**
 * Parses and validates an unprivileged TCP port number.
 */
function parsePort(value, flagName, fallback) {
  if (value === undefined || value === null || String(value).trim() === "") {
    return fallback;
  }
  const parsed = Number.parseInt(String(value).trim(), 10);
  if (!Number.isInteger(parsed) || parsed < 1024 || parsed > 65535) {
    throw new Error(`Invalid port for ${flagName}: "${value}". Expected an integer between 1024 and 65535.`);
  }
  return parsed;
}

/**
 * Validates that a candidate state directory path is safe to create and reset.
 */
export function assertSafeStateDir(stateDir, repoRoot = defaultRepoRoot) {
  if (typeof stateDir !== "string" || !stateDir.trim()) {
    throw new Error("State directory path must be a non-empty string.");
  }
  const resolvedRepoRoot = path.resolve(repoRoot);
  const resolvedStateDir = path.resolve(resolvedRepoRoot, stateDir.trim());
  const parsed = path.parse(resolvedStateDir);
  if (resolvedStateDir === parsed.root) {
    throw new Error(`Refusing unsafe state directory "${resolvedStateDir}": cannot be filesystem root.`);
  }
  const homeDir = path.resolve(os.homedir());
  const tmpDir = path.resolve(os.tmpdir());
  if (resolvedStateDir === homeDir) {
    throw new Error(`Refusing unsafe state directory "${resolvedStateDir}": cannot be the user home directory.`);
  }
  if (resolvedStateDir === tmpDir) {
    throw new Error(`Refusing unsafe state directory "${resolvedStateDir}": cannot be the system temp root.`);
  }
  if (resolvedStateDir === resolvedRepoRoot) {
    throw new Error(`Refusing unsafe state directory "${resolvedStateDir}": cannot be the repository root.`);
  }
  if (resolvedRepoRoot.startsWith(`${resolvedStateDir}${path.sep}`)) {
    throw new Error(`Refusing unsafe state directory "${resolvedStateDir}": cannot be a parent of the repository root.`);
  }
  if (homeDir.startsWith(`${resolvedStateDir}${path.sep}`)) {
    throw new Error(`Refusing unsafe state directory "${resolvedStateDir}": cannot be a parent of the home directory.`);
  }
  const relativeToRepo = path.relative(resolvedRepoRoot, resolvedStateDir);
  if (!relativeToRepo.startsWith("..") && !path.isAbsolute(relativeToRepo)) {
    const firstSegment = relativeToRepo.split(path.sep)[0];
    if (protectedRepoEntries.has(firstSegment)) {
      throw new Error(
        `Refusing unsafe state directory "${resolvedStateDir}": cannot target repository source directory "${firstSegment}".`
      );
    }
  }
  return resolvedStateDir;
}

/**
 * Parses CLI arguments and environment variables into a dev-stack configuration.
 */
export function parseDevStackArgs(argv = [], env = process.env, repoRoot = defaultRepoRoot) {
  const args = [...argv];
  let command = "up";
  if (args[0] && !args[0].startsWith("-")) {
    command = args.shift();
  }
  const allowedCommands = new Set(["up", "down", "reset", "status", "smoke", "help"]);
  if (!allowedCommands.has(command)) {
    throw new Error(
      `Unknown dev:stack command "${command}". Expected one of: up, down, reset, status, smoke.`
    );
  }

  let stateDirRaw = env.SPACE_DEV_STACK_STATE_DIR || path.join(repoRoot, ".dev-stack");
  let projectName = (env.SPACE_DEV_STACK_PROJECT_NAME || defaultDevStackProjectName).trim();
  let apiPortRaw = env.SPACE_DEV_STACK_API_PORT ?? env.SPACE_API_PORT;
  let webPortRaw = env.SPACE_DEV_STACK_WEB_PORT ?? env.SPACE_WEB_PORT;
  let postgresPortRaw = env.SPACE_DEV_STACK_POSTGRES_PORT ?? env.SPACE_DEV_POSTGRES_PORT ?? env.SPACE_POSTGRES_PORT;
  let temporalPortRaw = env.SPACE_DEV_STACK_TEMPORAL_PORT ?? env.SPACE_DEV_TEMPORAL_PORT ?? env.SPACE_TEMPORAL_PORT;
  let packageWatch = env.SPACE_DEV_STACK_PACKAGE_WATCH !== "false";
  let skipBuild = env.SPACE_DEV_STACK_SKIP_BUILD === "true";

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--help" || arg === "-h") {
      command = "help";
      continue;
    }
    if (arg === "--no-package-watch") {
      packageWatch = false;
      continue;
    }
    if (arg === "--skip-build") {
      skipBuild = true;
      continue;
    }
    const readValue = (flag) => {
      if (index + 1 >= args.length) {
        throw new Error(`Missing value for ${flag}.`);
      }
      index += 1;
      return args[index];
    };
    if (arg === "--state-dir") {
      stateDirRaw = readValue("--state-dir");
    } else if (arg.startsWith("--state-dir=")) {
      stateDirRaw = arg.slice("--state-dir=".length);
    } else if (arg === "--project-name") {
      projectName = readValue("--project-name").trim();
    } else if (arg.startsWith("--project-name=")) {
      projectName = arg.slice("--project-name=".length).trim();
    } else if (arg === "--api-port") {
      apiPortRaw = readValue("--api-port");
    } else if (arg.startsWith("--api-port=")) {
      apiPortRaw = arg.slice("--api-port=".length);
    } else if (arg === "--web-port") {
      webPortRaw = readValue("--web-port");
    } else if (arg.startsWith("--web-port=")) {
      webPortRaw = arg.slice("--web-port=".length);
    } else if (arg === "--postgres-port") {
      postgresPortRaw = readValue("--postgres-port");
    } else if (arg.startsWith("--postgres-port=")) {
      postgresPortRaw = arg.slice("--postgres-port=".length);
    } else if (arg === "--temporal-port") {
      temporalPortRaw = readValue("--temporal-port");
    } else if (arg.startsWith("--temporal-port=")) {
      temporalPortRaw = arg.slice("--temporal-port=".length);
    } else {
      throw new Error(`Unknown option "${arg}". Run "npm run dev:stack -- --help" for usage.`);
    }
  }

  if (!/^[a-z0-9][a-z0-9_-]{1,62}$/.test(projectName)) {
    throw new Error(
      `Invalid compose project name "${projectName}". Must match /^[a-z0-9][a-z0-9_-]{1,62}$/.`
    );
  }

  const stateDir = assertSafeStateDir(stateDirRaw, repoRoot);
  const apiPort = parsePort(apiPortRaw, "SPACE_API_PORT / --api-port", defaultDevStackPorts.apiPort);
  const webPort = parsePort(webPortRaw, "SPACE_WEB_PORT / --web-port", defaultDevStackPorts.webPort);
  const postgresPort = parsePort(
    postgresPortRaw,
    "SPACE_DEV_POSTGRES_PORT / --postgres-port",
    defaultDevStackPorts.postgresPort
  );
  const temporalPort = parsePort(
    temporalPortRaw,
    "SPACE_DEV_TEMPORAL_PORT / --temporal-port",
    defaultDevStackPorts.temporalPort
  );

  const uniquePorts = new Set([apiPort, webPort, postgresPort, temporalPort]);
  if (uniquePorts.size !== 4) {
    throw new Error(
      `Ports must be distinct (got api=${apiPort}, web=${webPort}, postgres=${postgresPort}, temporal=${temporalPort}).`
    );
  }

  return {
    command,
    repoRoot: path.resolve(repoRoot),
    stateDir,
    projectName,
    apiPort,
    webPort,
    postgresPort,
    temporalPort,
    packageWatch,
    skipBuild
  };
}

/**
 * Extracts digest-pinned PostgreSQL and Temporal images from compose.yml.
 */
export function readPinnedComposeImages(composeTemplateText) {
  if (typeof composeTemplateText !== "string" || !composeTemplateText.trim()) {
    throw new Error("packages/run-spaceapp/templates/compose.yml content is empty.");
  }
  const pgMatch = composeTemplateText.match(
    /^\s*image:\s*(pgvector\/pgvector:[^\s#]+@sha256:[0-9a-f]{64})\s*$/m
  );
  if (!pgMatch) {
    throw new Error(
      "Could not find a digest-pinned pgvector/pgvector image (@sha256:...) in packages/run-spaceapp/templates/compose.yml."
    );
  }
  const temporalMatch = composeTemplateText.match(
    /^\s*image:\s*(temporalio\/auto-setup:[^\s#]+@sha256:[0-9a-f]{64})\s*$/m
  );
  if (!temporalMatch) {
    throw new Error(
      "Could not find a digest-pinned temporalio/auto-setup image (@sha256:...) in packages/run-spaceapp/templates/compose.yml."
    );
  }
  return {
    postgresImage: pgMatch[1],
    temporalImage: temporalMatch[1]
  };
}

/**
 * Extracts the pinned @opencode/cli package specifier from Dockerfile.
 */
export function readPinnedOpenCodePackageSpec(dockerfileText) {
  if (typeof dockerfileText !== "string" || !dockerfileText.trim()) {
    throw new Error("Dockerfile content is empty.");
  }
  const match = dockerfileText.match(/(@opencode\/cli@[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?)/);
  if (!match) {
    throw new Error("Could not find a pinned @opencode/cli@<version> package spec in Dockerfile.");
  }
  return match[1];
}

/**
 * Normalizes a host path to forward slashes for Docker Compose.
 */
function toComposeHostPath(filePath) {
  return filePath.replaceAll("\\", "/");
}

/**
 * Renders the isolated Docker Compose configuration for the dev stack.
 */
export function renderDevStackCompose({
  projectName = defaultDevStackProjectName,
  postgresImage,
  temporalImage,
  postgresPort = defaultDevStackPorts.postgresPort,
  temporalPort = defaultDevStackPorts.temporalPort,
  postgresPasswordFile,
  temporalPasswordFile,
  databaseName = "space_dev"
}) {
  if (!postgresImage || !/@sha256:[0-9a-f]{64}$/.test(postgresImage)) {
    throw new Error(`postgresImage must be digest-pinned (@sha256:...), got "${postgresImage}".`);
  }
  if (!temporalImage || !/@sha256:[0-9a-f]{64}$/.test(temporalImage)) {
    throw new Error(`temporalImage must be digest-pinned (@sha256:...), got "${temporalImage}".`);
  }
  const pgSecretPath = toComposeHostPath(postgresPasswordFile);
  const temporalSecretPath = toComposeHostPath(temporalPasswordFile);
  return `name: ${projectName}

services:
  postgres:
    image: ${postgresImage}
    restart: unless-stopped
    environment:
      POSTGRES_DB: ${databaseName}
      POSTGRES_USER: space
      POSTGRES_PASSWORD_FILE: /run/secrets/postgres_password
    volumes:
      - postgres-data:/var/lib/postgresql/data
      - ${pgSecretPath}:/run/secrets/postgres_password:ro
    ports:
      - "127.0.0.1:${postgresPort}:5432"
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U space -d ${databaseName}"]
      interval: 2s
      timeout: 5s
      retries: 30

  temporal:
    image: ${temporalImage}
    restart: unless-stopped
    depends_on:
      postgres:
        condition: service_healthy
    environment:
      DB: postgres12
      DB_PORT: 5432
      POSTGRES_USER: space
      POSTGRES_PWD_FILE: /run/secrets/postgres_password_temporal
      POSTGRES_SEEDS: postgres
      DYNAMIC_CONFIG_FILE_PATH: config/dynamicconfig/development-sql.yaml
    volumes:
      - ${temporalSecretPath}:/run/secrets/postgres_password_temporal:ro
    ports:
      - "127.0.0.1:${temporalPort}:7233"
    healthcheck:
      test: ["CMD", "tctl", "--address", "127.0.0.1:7233", "cluster", "health"]
      interval: 3s
      timeout: 5s
      retries: 40

volumes:
  postgres-data:
`;
}

/**
 * Writes a secret value to disk with strict POSIX file permissions.
 */
function writeSecretFile(filePath, value, mode = 0o600) {
  writeFileSync(filePath, `${value}\n`, { encoding: "utf8", mode });
  try {
    chmodSync(filePath, mode);
  } catch {
    // Best-effort chmod on filesystems that ignore POSIX permission bits.
  }
}

/**
 * Reads an existing secret file or generates and persists a new secret.
 */
function readOrCreateSecret(filePath, generator, mode = 0o600) {
  if (existsSync(filePath)) {
    const existing = readFileSync(filePath, "utf8").trim();
    if (existing.length >= 16) {
      try {
        chmodSync(filePath, mode);
      } catch {}
      return existing;
    }
  }
  const created = generator();
  writeSecretFile(filePath, created, mode);
  return created;
}

/**
 * Ensures per-state-directory secret files exist with 0600 permissions.
 */
export function ensureDevStackSecrets(config) {
  const stateDir = assertSafeStateDir(config.stateDir, config.repoRoot);
  const secretsDir = path.join(stateDir, "secrets");
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  mkdirSync(secretsDir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(stateDir, 0o700);
    chmodSync(secretsDir, 0o700);
  } catch {}

  const markerPath = path.join(stateDir, stateDirMarkerFile);
  if (!existsSync(markerPath)) {
    writeFileSync(
      markerPath,
      `${JSON.stringify({ createdBy: "spaceapp-dev-stack", createdAt: new Date().toISOString() }, null, 2)}\n`,
      { encoding: "utf8", mode: 0o600 }
    );
  }

  const postgresPasswordFile = path.join(secretsDir, "postgres-password");
  const temporalPasswordFile = path.join(secretsDir, "postgres-password-container");
  const sessionSecretFile = path.join(secretsDir, "session-secret");
  const setupTokenFile = path.join(secretsDir, "setup-token");
  const setupClaimedFile = path.join(secretsDir, "setup-token.claimed");
  const databaseUrlFile = path.join(secretsDir, "database-url");
  const connectorKeyFile = path.join(secretsDir, "space-connector.key");
  const designKeyFile = path.join(secretsDir, "space-design.key");

  const postgresPassword = readOrCreateSecret(
    postgresPasswordFile,
    () => randomBytes(24).toString("hex"),
    0o600
  );
  // temporalio/auto-setup runs as UID 10000 inside the container, so its bind-mounted password
  // file inside the 0700 stateDir needs world-read permission inside the container.
  writeSecretFile(temporalPasswordFile, postgresPassword, 0o644);

  const sessionSecret = readOrCreateSecret(
    sessionSecretFile,
    () => randomBytes(32).toString("base64url"),
    0o600
  );
  const setupToken = readOrCreateSecret(
    setupTokenFile,
    () => randomBytes(24).toString("base64url"),
    0o600
  );
  readOrCreateSecret(connectorKeyFile, () => randomBytes(32).toString("base64url"), 0o600);
  readOrCreateSecret(designKeyFile, () => randomBytes(32).toString("base64url"), 0o600);

  const databaseName = "space_dev";
  const databaseUrl = `postgres://space:${encodeURIComponent(postgresPassword)}@127.0.0.1:${config.postgresPort}/${databaseName}`;
  writeSecretFile(databaseUrlFile, databaseUrl, 0o600);

  return {
    secretsDir,
    postgresPasswordFile,
    temporalPasswordFile,
    sessionSecretFile,
    setupTokenFile,
    setupClaimedFile,
    databaseUrlFile,
    connectorKeyFile,
    designKeyFile,
    databaseName,
    databaseUrl,
    sessionSecret,
    setupToken,
    isSetupClaimed: () => existsSync(setupClaimedFile),
    markSetupClaimed: () => {
      if (!existsSync(setupClaimedFile)) {
        writeSecretFile(setupClaimedFile, new Date().toISOString(), 0o600);
      }
    }
  };
}

/**
 * Builds the default OpenCode configuration JSON.
 */
export function buildOpenCodeStarterConfig({ stateDir }) {
  const resolvedStateDir = path.resolve(stateDir);
  const scratchDir = path.join(resolvedStateDir, "var", "scratch").replaceAll("\\", "/");
  const memoryDir = path.join(resolvedStateDir, "var", "memory").replaceAll("\\", "/");
  return {
    $schema: "https://opencode.ai/config.json",
    model: "opencode/big-pickle",
    instructions: [
      `Write temporary scratch files in ${scratchDir}. Do not create scratch files in /tmp or the project root unless the user asks.`
    ],
    permission: {
      external_directory: {
        [`${scratchDir}/**`]: "allow",
        [`${memoryDir}/**`]: "allow"
      }
    }
  };
}

/**
 * Writes isolated CLI wrapper scripts and OpenCode config inside stateDir.
 */
export function writeCliWrapperScripts({ stateDir, opencodeBinPath }) {
  const binDir = path.join(stateDir, "bin");
  const providersDir = path.join(stateDir, "providers");
  const opencodeProviderRoot = path.join(providersDir, "opencode");
  const opencodeConfigDir = path.join(opencodeProviderRoot, "home", ".config", "opencode");
  const scratchDir = path.join(stateDir, "var", "scratch");
  const memoryDir = path.join(stateDir, "var", "memory");

  for (const dir of [
    binDir,
    path.join(opencodeProviderRoot, "home", ".config"),
    path.join(opencodeProviderRoot, "xdg-data"),
    path.join(opencodeProviderRoot, "xdg-cache"),
    path.join(opencodeProviderRoot, "xdg-state"),
    path.join(opencodeProviderRoot, "tmp"),
    scratchDir,
    memoryDir,
    opencodeConfigDir
  ]) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  const opencodeConfigFile = path.join(opencodeConfigDir, "opencode.json");
  if (!existsSync(opencodeConfigFile)) {
    writeFileSync(
      opencodeConfigFile,
      `${JSON.stringify(buildOpenCodeStarterConfig({ stateDir }), null, 2)}\n`,
      { encoding: "utf8", mode: 0o600 }
    );
  }

  const opencodeWrapperPath = path.join(binDir, "opencode-vscode-parity");
  const opencodeWrapperContent = `#!/usr/bin/env bash
set -euo pipefail
PROVIDER_ROOT=${JSON.stringify(opencodeProviderRoot)}
mkdir -p "$PROVIDER_ROOT/home/.config/opencode" "$PROVIDER_ROOT/xdg-data" "$PROVIDER_ROOT/xdg-cache" "$PROVIDER_ROOT/xdg-state" "$PROVIDER_ROOT/tmp"
export HOME="$PROVIDER_ROOT/home"
export XDG_CONFIG_HOME="$PROVIDER_ROOT/home/.config"
export XDG_DATA_HOME="$PROVIDER_ROOT/xdg-data"
export XDG_CACHE_HOME="$PROVIDER_ROOT/xdg-cache"
export XDG_STATE_HOME="$PROVIDER_ROOT/xdg-state"
export TMPDIR="$PROVIDER_ROOT/tmp"
exec ${JSON.stringify(opencodeBinPath)} "$@"
`;
  writeFileSync(opencodeWrapperPath, opencodeWrapperContent, { encoding: "utf8", mode: 0o755 });
  chmodSync(opencodeWrapperPath, 0o755);

  const plainOpencodePath = path.join(binDir, "opencode");
  writeFileSync(plainOpencodePath, opencodeWrapperContent, { encoding: "utf8", mode: 0o755 });
  chmodSync(plainOpencodePath, 0o755);

  const passthroughProviders = ["codex", "claude", "gemini", "kimi", "grok"];
  for (const provider of passthroughProviders) {
    const providerRoot = path.join(providersDir, provider);
    mkdirSync(path.join(providerRoot, "home"), { recursive: true, mode: 0o700 });
    const wrapperPath = path.join(binDir, `${provider}-vscode-parity`);
    const wrapperContent = `#!/usr/bin/env bash
set -euo pipefail
PROVIDER_Binary="$(PATH="\${SPACE_HOST_PATH:-\$PATH}" command -v ${provider} 2>/dev/null || true)"
if [[ -z "$PROVIDER_Binary" ]]; then
  echo "${provider} CLI is not installed on this host. Install ${provider} or use the preconfigured OpenCode pane." >&2
  exit 127
fi
exec "$PROVIDER_Binary" "$@"
`;
    writeFileSync(wrapperPath, wrapperContent, { encoding: "utf8", mode: 0o755 });
    chmodSync(wrapperPath, 0o755);
  }

  return {
    binDir,
    opencodeWrapperPath,
    opencodeConfigFile
  };
}

/**
 * Installs the pinned @opencode/cli package inside stateDir and writes CLI wrappers.
 */
export function ensureDevStackCliWrappers(config, { execCommand = spawnSync } = {}) {
  const dockerfilePath = path.join(config.repoRoot, "Dockerfile");
  const dockerfileText = readFileSync(dockerfilePath, "utf8");
  const opencodeSpec = readPinnedOpenCodePackageSpec(dockerfileText);
  const expectedVersion = opencodeSpec.slice("@opencode/cli@".length);

  const opencodePrefix = path.join(config.stateDir, "opencode");
  const opencodePkgJsonPath = path.join(
    opencodePrefix,
    "node_modules",
    "@opencode",
    "cli",
    "package.json"
  );
  const opencodeBinName = process.platform === "win32" ? "opencode.cmd" : "opencode";
  const opencodeBinPath = path.join(opencodePrefix, "node_modules", ".bin", opencodeBinName);

  let needsInstall = !existsSync(opencodeBinPath) || !existsSync(opencodePkgJsonPath);
  if (!needsInstall) {
    try {
      const installedPkg = JSON.parse(readFileSync(opencodePkgJsonPath, "utf8"));
      if (installedPkg.version !== expectedVersion) {
        needsInstall = true;
      }
    } catch {
      needsInstall = true;
    }
  }

  if (needsInstall) {
    mkdirSync(opencodePrefix, { recursive: true, mode: 0o700 });
    const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
    const installResult = execCommand(
      npmCmd,
      [
        "install",
        "--prefix",
        opencodePrefix,
        "--no-audit",
        "--no-fund",
        "--save-exact",
        opencodeSpec
      ],
      {
        cwd: config.repoRoot,
        stdio: "inherit",
        env: process.env
      }
    );
    if (installResult.status !== 0) {
      throw new Error(`Failed to install ${opencodeSpec} into ${opencodePrefix}.`);
    }
  }

  return {
    opencodeSpec,
    ...writeCliWrapperScripts({ stateDir: config.stateDir, opencodeBinPath })
  };
}

/**
 * Constructs the isolated environment variables for supervised child processes.
 */
export function buildDevStackChildEnv(config, secrets, baseEnv = process.env) {
  const stateDir = config.stateDir;
  const runDir = path.join(stateDir, "run");
  const varDir = path.join(stateDir, "var");
  const artifactsDir = path.join(varDir, "artifacts");
  const memoryDir = path.join(varDir, "memory");
  const memoryGraphDir = path.join(varDir, "memory-graph");
  const appDiagnosticsDir = path.join(varDir, "app-diagnostics");
  const maintenanceDir = path.join(varDir, "maintenance-autopilot");
  const balancerDir = path.join(varDir, "cli-account-balancer");
  const projectsDir = path.join(stateDir, "projects");
  const workspacesDir = path.join(stateDir, "workspaces");
  const binDir = path.join(stateDir, "bin");
  const cliHomeDir = path.join(stateDir, "cli-home");

  for (const dir of [
    runDir,
    varDir,
    artifactsDir,
    memoryDir,
    memoryGraphDir,
    appDiagnosticsDir,
    maintenanceDir,
    balancerDir,
    projectsDir,
    workspacesDir,
    binDir,
    path.join(cliHomeDir, ".codex")
  ]) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  const cliHostSocket = path.join(runDir, "pane-host.sock");
  const cliAdminHostSocket = path.join(runDir, "admin-pane-host.sock");
  const browserHostSocket = path.join(runDir, "browser-host.sock");
  const t3CodeSocket = path.join(runDir, "t3code.sock");
  const apiOrigin = `http://127.0.0.1:${config.apiPort}`;
  const webOrigin = `http://127.0.0.1:${config.webPort}`;

  const env = {
    ...baseEnv,
    SPACE_HOST_PATH: baseEnv.PATH ?? "",
    SPACE_PUBLIC_DISTRIBUTION: "true",
    SPACEAPP_WORKFLOWS_ENABLED: "true",
    SPACE_RUNTIME_STORE: "postgres",
    SPACE_DATABASE_URL: secrets.databaseUrl,
    SPACE_DATABASE_URL_FILE: secrets.databaseUrlFile,
    SPACE_SESSION_SECRET_FILE: secrets.sessionSecretFile,
    SPACE_ENABLE_DB_SWEEP: "true",
    SPACE_ENABLE_DUMMY_TURNS: "true",
    SPACE_DEV_LOGIN: "false",
    SPACE_SECURE_COOKIES: "false",
    SPACE_API_HOST: "127.0.0.1",
    SPACE_API_PORT: String(config.apiPort),
    SPACE_API_ORIGIN: apiOrigin,
    SPACE_WEB_HOST: "127.0.0.1",
    SPACE_WEB_PORT: String(config.webPort),
    SPACE_TEMPORAL_ADDRESS: `127.0.0.1:${config.temporalPort}`,
    SPACE_TEMPORAL_NAMESPACE: "default",
    SPACE_TEMPORAL_TASK_QUEUE: `${config.projectName}-agent-turns`,
    SPACE_CLI_ENABLED: "true",
    SPACE_CLI_ROOT_ENABLED: "false",
    SPACE_CLI_HOST_SOCKET: cliHostSocket,
    SPACE_CLI_ADMIN_HOST_SOCKET: cliAdminHostSocket,
    SPACE_CLI_COMMAND_PATH: binDir,
    SPACE_CLI_WORKSPACE_ROOT: workspacesDir,
    SPACE_PROJECTS_ROOT: projectsDir,
    SPACE_INSTALL_ROOT: config.repoRoot,
    SPACE_GIT_ROOT: config.repoRoot,
    SPACE_REPO_ROOT: config.repoRoot,
    SPACE_BROWSER_SESSIONS_ENABLED: "false",
    SPACE_BROWSER_HOST_SOCKET: browserHostSocket,
    SPACE_T3CODE_ENABLED: "false",
    SPACE_T3CODE_SOCKET: t3CodeSocket,
    SPACE_DEMO_PROJECTS_ENABLED: "false",
    SPACE_ARTIFACT_ROOT: artifactsDir,
    SPACE_MEMORY_INDEX_PATH: path.join(memoryDir, "space_memory.md"),
    SPACE_MEMORY_MONTHLY_PATH: path.join(memoryDir, "space_memory_current.md"),
    SPACE_MEMORY_LOCK_PATH: path.join(memoryDir, "space_memory.lock"),
    SPACE_MEMORY_GRAPH_ROOT: memoryGraphDir,
    SPACE_CODEX_GOALS_DB_PATH: path.join(varDir, "goals.sqlite"),
    SPACE_APP_DIAGNOSTICS_ROOT: appDiagnosticsDir,
    SPACE_MAINTENANCE_AUTOPILOT_STATE_FILE: path.join(maintenanceDir, "state.json"),
    SPACE_CLI_ACCOUNT_BALANCER_STATE_FILE: path.join(balancerDir, "state.json"),
    SPACE_CONNECTOR_KEY_FILE: secrets.connectorKeyFile,
    SPACE_DESIGN_GATEWAY_KEY_FILE: secrets.designKeyFile,
    SPACE_CODEX_APP_SERVER_HOME: path.join(cliHomeDir, ".codex"),
    SPACE_CODEX_HOME: path.join(cliHomeDir, ".codex"),
    SPACE_CHESS_MOVE_SOCKET: "disabled",
    SPACE_TELEGRAM_SECRET_ROOT: path.join(secrets.secretsDir, "telegram"),
    SPACE_TELEGRAM_OWNERSHIP_MANIFEST: path.join(
      varDir,
      "integrations",
      "telegram",
      "space-codex-thread-ownership.json"
    ),
    SPACE_STREAMING_SECRET_ROOT: path.join(varDir, "streaming-secrets"),
    SPACE_STREAMING_BOT_API_BASE_URL: apiOrigin
  };

  if (!secrets.isSetupClaimed()) {
    env.SPACE_SETUP_TOKEN_FILE = secrets.setupTokenFile;
  } else {
    delete env.SPACE_SETUP_TOKEN_FILE;
    delete env.SPACE_SETUP_TOKEN;
  }

  return {
    env,
    apiOrigin,
    webOrigin,
    cliHostSocket
  };
}

/**
 * Formats the startup banner displaying URLs and the one-time owner setup token.
 */
export function formatReadyBanner({
  webOrigin,
  apiOrigin,
  setupRequired,
  setupToken
}) {
  const lines = [
    "",
    "============================================================",
    "SpaceApp contributor dev stack is ready!",
    `  Web URL:      ${webOrigin}`,
    `  API URL:      ${apiOrigin}`,
    `  Readiness:    ${apiOrigin}/readyz`
  ];
  if (setupRequired && setupToken) {
    lines.push(`  Setup token:  ${setupToken}`);
    lines.push("  (One-time owner setup token — enter this at the Web URL to create the owner account)");
  } else {
    lines.push("  Owner setup:  already claimed");
  }
  lines.push("  Stop stack:   npm run dev:stack -- down");
  lines.push("  Reset stack:  npm run dev:stack -- reset");
  lines.push("============================================================",
    ""
  );
  return lines.join("\n");
}

/**
 * Streams line-buffered output from a child stream with a [service] prefix.
 */
function prefixStreamLines(stream, prefix, target, onLine) {
  let buffer = "";
  stream.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (line.trim().length > 0) {
        target.write(`[${prefix}] ${line}\n`);
        onLine?.(line);
      }
    }
  });
  stream.on("end", () => {
    if (buffer.trim().length > 0) {
      target.write(`[${prefix}] ${buffer}\n`);
      onLine?.(buffer);
      buffer = "";
    }
  });
}

/**
 * Spawns and supervises all source child processes, failing fast on unexpected crashes
 * and restarting dependent services when the packages watcher rebuilds.
 */
export function superviseChildProcesses(serviceSpecs, {
  spawnProcess = spawn,
  stdout = process.stdout,
  stderr = process.stderr,
  onUnexpectedExit,
  onPidsChanged
} = {}) {
  const children = new Map();
  let shuttingDown = false;
  let firstFailure = null;
  let resolveFailure;
  const failurePromise = new Promise((resolve) => {
    resolveFailure = resolve;
  });

  const getPids = () => {
    const pids = {};
    for (const [name, { child }] of children) {
      if (child.pid) pids[name] = child.pid;
    }
    return pids;
  };

  const stopAll = async (signal = "SIGTERM", timeoutMs = 5_000) => {
    shuttingDown = true;
    const exitPromises = [];
    for (const [, entry] of children) {
      const { child } = entry;
      if (child.exitCode !== null || child.signalCode !== null) continue;
      exitPromises.push(
        new Promise((resolve) => {
          child.once("exit", () => resolve());
        })
      );
      try {
        child.kill(signal);
      } catch {}
    }
    if (exitPromises.length === 0) return;
    await Promise.race([
      Promise.all(exitPromises),
      new Promise((resolve) => setTimeout(resolve, timeoutMs))
    ]);
    for (const [, entry] of children) {
      const { child } = entry;
      if (child.exitCode === null && child.signalCode === null) {
        try {
          child.kill("SIGKILL");
        } catch {}
      }
    }
  };

  let initialPackageWatchDone = false;

  const restartPackageDependents = async () => {
    for (const [name, entry] of children) {
      if (!entry.spec.restartOnPackageRebuild || shuttingDown || firstFailure) continue;
      entry.restarting = true;
      const oldChild = entry.child;
      if (oldChild.exitCode === null && oldChild.signalCode === null) {
        const exited = new Promise((resolve) => {
          oldChild.once("exit", () => resolve());
        });
        try {
          oldChild.kill("SIGTERM");
        } catch {}
        await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 2_000))]);
        if (oldChild.exitCode === null && oldChild.signalCode === null) {
          try {
            oldChild.kill("SIGKILL");
          } catch {}
        }
      }
      if (shuttingDown || firstFailure) return;
      stdout.write(`[dev:stack] Restarting "${name}" after workspace package rebuild...\n`);
      startService(entry.spec);
    }
    onPidsChanged?.(getPids());
  };

  /**
   * Spawns a single service specification and wires up output logging and crash supervision.
   */
  function startService(spec) {
    const child = spawnProcess(spec.command, spec.args, {
      cwd: spec.cwd,
      env: spec.env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    const entry = { spec, child, restarting: false };
    children.set(spec.name, entry);

    const handleOutputLine =
      spec.name === "packages"
        ? (line) => {
            if (/Found 0 errors\.\s*Watching for file changes\./i.test(line)) {
              if (!initialPackageWatchDone) {
                initialPackageWatchDone = true;
              } else {
                void restartPackageDependents();
              }
            }
          }
        : undefined;

    if (child.stdout) prefixStreamLines(child.stdout, spec.name, stdout, handleOutputLine);
    if (child.stderr) prefixStreamLines(child.stderr, spec.name, stderr, handleOutputLine);

    child.once("error", (error) => {
      if (entry.restarting || shuttingDown || firstFailure) return;
      firstFailure = {
        service: spec.name,
        code: 1,
        signal: null,
        reason: error.message
      };
      stderr.write(
        `[dev:stack] ERROR: service "${spec.name}" failed to start: ${error.message}\n`
      );
      void stopAll().finally(() => {
        onUnexpectedExit?.(firstFailure);
        resolveFailure(firstFailure);
      });
    });

    child.once("exit", (code, signal) => {
      if (entry.restarting || shuttingDown || firstFailure) return;
      firstFailure = {
        service: spec.name,
        code: code ?? 1,
        signal: signal ?? null
      };
      const detail = signal ? `signal ${signal}` : `exit code ${code ?? 1}`;
      stderr.write(
        `[dev:stack] ERROR: service "${spec.name}" exited unexpectedly (${detail}). Stopping dev:stack.\n`
      );
      void stopAll().finally(() => {
        onUnexpectedExit?.(firstFailure);
        resolveFailure(firstFailure);
      });
    });
  }

  for (const spec of serviceSpecs) {
    startService(spec);
  }

  return {
    children,
    failurePromise,
    stopAll,
    getPids
  };
}

/**
 * Sleeps for the specified duration in milliseconds.
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Fetches a URL and parses its response body as JSON when possible.
 */
async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { response, body };
}

/**
 * Polls API /readyz and the Vite web server until both report ready.
 */
export async function waitForStackReadiness({
  apiOrigin,
  webOrigin,
  failurePromise,
  timeoutMs = 90_000
}) {
  const deadline = Date.now() + timeoutMs;
  let lastReadyz = null;
  let lastWebStatus = null;

  while (Date.now() < deadline) {
    const raceResult = await Promise.race([
      (async () => {
        try {
          const { response: apiRes, body: readyz } = await fetchJson(`${apiOrigin}/readyz?strict=1`);
          lastReadyz = readyz;
          const deps = readyz?.dependencies ?? {};
          const apiReady =
            apiRes.status === 200 &&
            readyz?.ok === true &&
            deps.database === "RUNNING" &&
            deps.worker === "RUNNING" &&
            deps.cliHost === "RUNNING";
          if (!apiReady) return false;

          const webIndex = await fetch(`${webOrigin}/`);
          const { response: webReadyRes, body: webReadyBody } = await fetchJson(`${webOrigin}/readyz`);
          lastWebStatus = { indexStatus: webIndex.status, readyStatus: webReadyRes.status };
          return webIndex.status === 200 && webReadyRes.status === 200 && webReadyBody?.ok === true;
        } catch {
          return false;
        }
      })(),
      failurePromise ? failurePromise.then((failure) => ({ failure })) : new Promise(() => {})
    ]);

    if (raceResult && typeof raceResult === "object" && "failure" in raceResult) {
      throw new Error(
        `Service "${raceResult.failure.service}" exited before stack became ready (code=${raceResult.failure.code}, signal=${raceResult.failure.signal}).`
      );
    }
    if (raceResult === true) {
      return lastReadyz;
    }
    await sleep(500);
  }

  throw new Error(
    `Timed out waiting for SpaceApp dev stack readiness. Last /readyz=${JSON.stringify(lastReadyz)} web=${JSON.stringify(lastWebStatus)}`
  );
}

/**
 * Checks whether a numeric process ID currently exists.
 */
function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Reads the command line string of a running process ID using /proc/<pid>/cmdline or ps.
 */
export function readProcessCommand(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return "";
  const procCmdlinePath = `/proc/${pid}/cmdline`;
  if (existsSync(procCmdlinePath)) {
    try {
      const cmdline = readFileSync(procCmdlinePath, "utf8").replaceAll("\0", " ").trim();
      if (cmdline) return cmdline;
    } catch {}
  }
  try {
    const psResult = spawnSync("ps", ["-p", String(pid), "-o", "command="], {
      encoding: "utf8"
    });
    if (psResult.status === 0 && typeof psResult.stdout === "string") {
      return psResult.stdout.trim();
    }
  } catch {}
  return "";
}

/**
 * Verifies that a live PID recorded in pids.json still belongs to this checkout dev stack.
 */
export function isRecordedDevStackProcess(
  pid,
  {
    repoRoot = defaultRepoRoot,
    stateDir = "",
    inspectCommand = readProcessCommand
  } = {}
) {
  const commandLine = inspectCommand(pid);
  if (typeof commandLine !== "string" || !commandLine.trim()) {
    return false;
  }
  const normalizedCmd = commandLine.replaceAll("\\", "/");
  const normalizedRepo = repoRoot ? path.resolve(repoRoot).replaceAll("\\", "/") : "";
  const normalizedState = stateDir ? path.resolve(stateDir).replaceAll("\\", "/") : "";
  const markers = [
    normalizedRepo,
    normalizedState,
    "scripts/dev-stack.mjs",
    "packages/cli-host/dist/main.js",
    "apps/worker/dist/worker.js",
    "apps/api/src/server.ts",
    "vite"
  ].filter(Boolean);
  return markers.some((marker) => normalizedCmd.includes(marker));
}

/**
 * Terminates any running supervisor or child processes recorded in <stateDir>/pids.json
 * after verifying that each PID still belongs to the SpaceApp dev stack.
 */
export async function terminateRecordedProcesses(
  stateDir,
  {
    repoRoot = defaultRepoRoot,
    inspectCommand = readProcessCommand,
    sendSignal = (pid, sig) => process.kill(pid, sig),
    checkAlive = isPidAlive
  } = {}
) {
  const pidsPath = path.join(stateDir, "pids.json");
  if (!existsSync(pidsPath)) return;
  let recorded;
  try {
    recorded = JSON.parse(readFileSync(pidsPath, "utf8"));
  } catch {
    rmSync(pidsPath, { force: true });
    return;
  }

  const effectiveRepoRoot = recorded?.repoRoot || repoRoot;
  const rawPids = [];
  if (Number.isInteger(recorded?.supervisorPid) && recorded.supervisorPid !== process.pid) {
    rawPids.push(recorded.supervisorPid);
  }
  if (recorded?.children && typeof recorded.children === "object") {
    for (const pid of Object.values(recorded.children)) {
      if (Number.isInteger(pid) && pid !== process.pid) {
        rawPids.push(pid);
      }
    }
  }

  const verifiedPids = rawPids.filter(
    (pid) =>
      checkAlive(pid) &&
      isRecordedDevStackProcess(pid, {
        repoRoot: effectiveRepoRoot,
        stateDir,
        inspectCommand
      })
  );

  for (const pid of verifiedPids) {
    try {
      sendSignal(pid, "SIGTERM");
    } catch {}
  }

  const deadline = Date.now() + 6_000;
  while (Date.now() < deadline) {
    if (!verifiedPids.some((pid) => checkAlive(pid))) break;
    await sleep(150);
  }

  for (const pid of verifiedPids) {
    if (checkAlive(pid)) {
      try {
        sendSignal(pid, "SIGKILL");
      } catch {}
    }
  }
  rmSync(pidsPath, { force: true });
}

/**
 * Executes docker compose scoped to the dev-stack project and state directory.
 */
function runDockerCompose(config, composeArgs, { allowFailure = false } = {}) {
  const composeFilePath = path.join(config.stateDir, "compose.yml");
  const args = ["compose", "-p", config.projectName];
  if (existsSync(composeFilePath)) {
    args.push("-f", composeFilePath);
  }
  args.push(...composeArgs);
  const result = spawnSync("docker", args, {
    cwd: config.repoRoot,
    stdio: "inherit",
    env: process.env
  });
  if (result.status !== 0 && !allowFailure) {
    throw new Error(`docker ${args.join(" ")} failed with exit code ${result.status ?? 1}.`);
  }
  return result;
}

/**
 * Removes Docker containers and volumes labeled with the dev-stack project name.
 */
function removeLabeledDockerResources(projectName) {
  const containers = spawnSync(
    "docker",
    ["ps", "-aq", "--filter", `label=com.docker.compose.project=${projectName}`],
    { encoding: "utf8" }
  );
  const containerIds = (containers.stdout ?? "")
    .split(/\r?\n/)
    .map((id) => id.trim())
    .filter(Boolean);
  if (containerIds.length > 0) {
    spawnSync("docker", ["rm", "-f", "-v", ...containerIds], { stdio: "inherit" });
  }

  const volumes = spawnSync(
    "docker",
    ["volume", "ls", "-q", "--filter", `label=com.docker.compose.project=${projectName}`],
    { encoding: "utf8" }
  );
  const volumeNames = (volumes.stdout ?? "")
    .split(/\r?\n/)
    .map((name) => name.trim())
    .filter(Boolean);
  if (volumeNames.length > 0) {
    spawnSync("docker", ["volume", "rm", "-f", ...volumeNames], { stdio: "inherit" });
  }
}

/**
 * Stops dev-stack processes and Docker containers while preserving volumes and state.
 */
export async function downDevStack(config) {
  assertSafeStateDir(config.stateDir, config.repoRoot);
  await terminateRecordedProcesses(config.stateDir, { repoRoot: config.repoRoot });
  if (existsSync(path.join(config.stateDir, "compose.yml"))) {
    runDockerCompose(config, ["down", "--remove-orphans"], { allowFailure: true });
  } else {
    removeLabeledDockerResources(config.projectName);
  }
  process.stdout.write(`[dev:stack] Stopped "${config.projectName}" processes and containers (state preserved at ${config.stateDir}).\n`);
}

/**
 * Stops dev-stack processes and removes its containers, volumes, and state directory.
 */
export async function resetDevStack(config, { removeDocker = true } = {}) {
  const resolvedStateDir = assertSafeStateDir(config.stateDir, config.repoRoot);
  if (existsSync(resolvedStateDir)) {
    const stat = statSync(resolvedStateDir);
    if (!stat.isDirectory()) {
      throw new Error(`Refusing to reset stateDir "${resolvedStateDir}": path is not a directory.`);
    }
    const entries = readdirSync(resolvedStateDir);
    const hasMarker = existsSync(path.join(resolvedStateDir, stateDirMarkerFile));
    const isNamedDevStack = path.basename(resolvedStateDir).startsWith(".dev-stack");
    if (entries.length > 0 && !hasMarker && !isNamedDevStack) {
      throw new Error(
        `Refusing to delete non-empty directory "${resolvedStateDir}" without ${stateDirMarkerFile}.`
      );
    }
  }

  await terminateRecordedProcesses(resolvedStateDir, { repoRoot: config.repoRoot });
  if (removeDocker) {
    if (existsSync(path.join(resolvedStateDir, "compose.yml"))) {
      runDockerCompose(config, ["down", "-v", "--remove-orphans"], { allowFailure: true });
    }
    removeLabeledDockerResources(config.projectName);
  }

  rmSync(resolvedStateDir, { recursive: true, force: true });
  process.stdout.write(`[dev:stack] Reset complete: removed "${config.projectName}" containers, volumes, and ${resolvedStateDir}.\n`);
}

/**
 * Extracts the session cookie from an HTTP response.
 */
function extractSessionCookie(response) {
  const setCookies =
    typeof response.headers.getSetCookie === "function"
      ? response.headers.getSetCookie()
      : [response.headers.get("set-cookie")].filter(Boolean);
  for (const header of setCookies) {
    const match = header.match(/^(space_session(?:_dev)?=[^;]+)/);
    if (match) return match[1];
  }
  return null;
}

/**
 * Verifies that the CLI terminal WebSocket endpoint accepts an authenticated upgrade.
 */
async function verifyWebSocketAttach(wsUrl, origin, cookie) {
  if (typeof WebSocket !== "function") return;
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Timed out waiting for CLI terminal WebSocket handshake at ${wsUrl}`));
    }, 15_000);
    let ws;
    try {
      ws = new WebSocket(wsUrl, {
        headers: {
          Cookie: cookie,
          Origin: origin
        }
      });
    } catch {
      ws = new WebSocket(wsUrl);
    }
    ws.addEventListener("open", () => {
      clearTimeout(timeout);
      ws.close();
      resolve();
    });
    ws.addEventListener("error", () => {
      clearTimeout(timeout);
      reject(new Error(`WebSocket connection failed at ${wsUrl}`));
    });
  });
}

/**
 * Runs an end-to-end HTTP and WebSocket smoke check against a running dev stack.
 */
export async function runDevStackSmoke(config) {
  const apiOrigin = `http://127.0.0.1:${config.apiPort}`;
  const webOrigin = `http://127.0.0.1:${config.webPort}`;
  const readyz = await waitForStackReadiness({ apiOrigin, webOrigin, timeoutMs: 60_000 });

  const { response: statusRes, body: setupStatus } = await fetchJson(`${webOrigin}/api/setup/status`);
  if (statusRes.status !== 200) {
    throw new Error(`Expected GET /api/setup/status to return 200, got ${statusRes.status}`);
  }

  const setupTokenPath = path.join(config.stateDir, "secrets", "setup-token");
  const ownerEmail = process.env.SPACE_DEV_STACK_SMOKE_EMAIL || "owner@example.com";
  const ownerPassword = process.env.SPACE_DEV_STACK_SMOKE_PASSWORD || "ContributorPass!234";

  let sessionCookie = null;
  let starterRoomId = null;

  if (setupStatus.setupRequired) {
    if (!existsSync(setupTokenPath)) {
      throw new Error(`Setup is required, but setup token file is missing at ${setupTokenPath}.`);
    }
    const setupToken = readFileSync(setupTokenPath, "utf8").trim();
    const { response: claimRes, body: claimBody } = await fetchJson(`${webOrigin}/api/setup/claim`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        token: setupToken,
        email: ownerEmail,
        password: ownerPassword
      })
    });
    if (claimRes.status !== 200) {
      throw new Error(`POST /api/setup/claim failed (${claimRes.status}): ${JSON.stringify(claimBody)}`);
    }
    sessionCookie = extractSessionCookie(claimRes);
    starterRoomId = claimBody?.starterRoomId ?? null;
    writeSecretFile(path.join(config.stateDir, "secrets", "setup-token.claimed"), new Date().toISOString(), 0o600);
  } else {
    const { response: loginRes, body: loginBody } = await fetchJson(`${webOrigin}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: ownerEmail,
        password: ownerPassword
      })
    });
    if (loginRes.status !== 200) {
      throw new Error(`POST /api/auth/login failed (${loginRes.status}): ${JSON.stringify(loginBody)}`);
    }
    sessionCookie = extractSessionCookie(loginRes);
  }

  if (!sessionCookie) {
    throw new Error("Did not receive a session cookie after authenticating.");
  }

  const { response: csrfRes, body: csrfBody } = await fetchJson(`${webOrigin}/api/auth/csrf`, {
    headers: { Cookie: sessionCookie }
  });
  if (csrfRes.status !== 200 || !csrfBody?.csrfToken) {
    throw new Error(`Failed to fetch CSRF token (${csrfRes.status}): ${JSON.stringify(csrfBody)}`);
  }
  const authHeaders = {
    Cookie: sessionCookie,
    [csrfBody.headerName || "x-space-csrf-token"]: csrfBody.csrfToken,
    "content-type": "application/json"
  };

  if (!starterRoomId) {
    const { response: starterRes, body: starterBody } = await fetchJson(`${webOrigin}/api/setup/starter-room`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({})
    });
    if (starterRes.status === 200 && starterBody?.room?.id) {
      starterRoomId = starterBody.room.id;
    }
  }

  const { response: roomsRes, body: roomsBody } = await fetchJson(`${webOrigin}/api/rooms`, {
    headers: { Cookie: sessionCookie }
  });
  if (roomsRes.status !== 200 || !Array.isArray(roomsBody?.rooms)) {
    throw new Error(`GET /api/rooms failed (${roomsRes.status}): ${JSON.stringify(roomsBody)}`);
  }
  const gettingStartedRoom =
    roomsBody.rooms.find((room) => room.id === starterRoomId) ??
    roomsBody.rooms.find((room) => room.name === "Getting Started") ??
    roomsBody.rooms[0];
  if (!gettingStartedRoom) {
    throw new Error("Could not find the Getting Started room.");
  }

  const panes = Array.isArray(gettingStartedRoom.panes) ? gettingStartedRoom.panes : [];
  const opencodePane =
    panes.find((pane) => pane.mode === "TERMINAL" && pane.terminalRuntimeId === "cli:opencode" && !pane.isClosed) ??
    panes.find((pane) => pane.mode === "TERMINAL" && !pane.isClosed);
  if (!opencodePane) {
    throw new Error(`Could not find an OpenCode terminal pane in room "${gettingStartedRoom.name}".`);
  }

  const { response: startRes, body: startBody } = await fetchJson(
    `${webOrigin}/api/panes/${encodeURIComponent(opencodePane.id)}/cli/session`,
    {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({
        runtimeId: opencodePane.terminalRuntimeId || "cli:opencode",
        includeTranscript: false
      })
    }
  );
  if (startRes.status !== 200 || !startBody?.session) {
    throw new Error(
      `POST /api/panes/${opencodePane.id}/cli/session failed (${startRes.status}): ${JSON.stringify(startBody)}`
    );
  }

  if (startBody.websocket?.path && startBody.websocket?.token) {
    const wsUrl = `ws://127.0.0.1:${config.webPort}${startBody.websocket.path}?token=${encodeURIComponent(startBody.websocket.token)}`;
    await verifyWebSocketAttach(wsUrl, webOrigin, sessionCookie);
  }

  let currentSession = startBody.session;
  const sessionDeadline = Date.now() + 30_000;
  while (currentSession?.status !== "RUNNING" && Date.now() < sessionDeadline) {
    await sleep(400);
    const { response: pollRes, body: pollBody } = await fetchJson(
      `${webOrigin}/api/panes/${encodeURIComponent(opencodePane.id)}/cli/session`,
      { headers: { Cookie: sessionCookie } }
    );
    if (pollRes.status === 200 && pollBody?.session) {
      currentSession = pollBody.session;
      if (currentSession.status === "ERROR" || currentSession.status === "EXITED") {
        throw new Error(
          `OpenCode pane session entered ${currentSession.status}: ${currentSession.statusReason ?? "no reason"}`
        );
      }
    }
  }

  if (currentSession?.status !== "RUNNING") {
    throw new Error(
      `Expected OpenCode pane session to reach RUNNING, got ${JSON.stringify(currentSession)}`
    );
  }

  const summary = {
    ok: true,
    readyzOk: readyz.ok,
    roomId: gettingStartedRoom.id,
    roomName: gettingStartedRoom.name,
    paneId: opencodePane.id,
    runtimeId: currentSession.runtimeId,
    sessionId: currentSession.sessionId,
    status: currentSession.status,
    cwd: currentSession.cwd
  };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  return summary;
}

/**
 * Queries and prints the current readiness status of the dev stack as JSON.
 */
export async function statusDevStack(config) {
  const apiOrigin = `http://127.0.0.1:${config.apiPort}`;
  const webOrigin = `http://127.0.0.1:${config.webPort}`;
  let readyz = null;
  try {
    const res = await fetchJson(`${apiOrigin}/readyz`);
    readyz = res.body;
  } catch {}
  const status = {
    projectName: config.projectName,
    stateDir: config.stateDir,
    apiOrigin,
    webOrigin,
    ready: Boolean(readyz?.ok),
    readyz
  };
  process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
  return status;
}

/**
 * Prints CLI usage instructions for npm run dev:stack.
 */
function printUsage() {
  process.stdout.write(`Usage: npm run dev:stack [-- <command> [options]]

Commands:
  up (default)   Start Postgres + Temporal in Docker, migrate DB, and run SpaceApp from source
  down           Stop running dev:stack processes and Docker containers (preserving volumes/state)
  reset          Stop processes, remove dev:stack Docker containers + volumes, and delete .dev-stack/
  status         Print current readiness and port status as JSON
  smoke          Verify /readyz, claim owner setup over HTTP, and verify Getting Started OpenCode pane reaches RUNNING

Options:
  --state-dir <dir>         State directory (default: .dev-stack or SPACE_DEV_STACK_STATE_DIR)
  --project-name <name>     Docker Compose project name (default: spaceapp-dev or SPACE_DEV_STACK_PROJECT_NAME)
  --api-port <port>         API port on 127.0.0.1 (default: 5910 or SPACE_API_PORT)
  --web-port <port>         Web port on 127.0.0.1 (default: 5911 or SPACE_WEB_PORT)
  --postgres-port <port>    Postgres host port on 127.0.0.1 (default: 55432 or SPACE_DEV_POSTGRES_PORT)
  --temporal-port <port>    Temporal host port on 127.0.0.1 (default: 57233 or SPACE_DEV_TEMPORAL_PORT)
  --no-package-watch        Disable continuous tsc -b --watch for packages/*
  --skip-build              Skip initial npm run build:packages
`);
}

/**
 * Starts the full SpaceApp contributor stack from source.
 */
export async function upDevStack(config) {
  await terminateRecordedProcesses(config.stateDir, { repoRoot: config.repoRoot });
  const secrets = ensureDevStackSecrets(config);
  const cliWrappers = ensureDevStackCliWrappers(config);

  const composeTemplatePath = path.join(
    config.repoRoot,
    "packages",
    "run-spaceapp",
    "templates",
    "compose.yml"
  );
  const composeTemplateText = readFileSync(composeTemplatePath, "utf8");
  const { postgresImage, temporalImage } = readPinnedComposeImages(composeTemplateText);

  const composeYaml = renderDevStackCompose({
    projectName: config.projectName,
    postgresImage,
    temporalImage,
    postgresPort: config.postgresPort,
    temporalPort: config.temporalPort,
    postgresPasswordFile: secrets.postgresPasswordFile,
    temporalPasswordFile: secrets.temporalPasswordFile,
    databaseName: secrets.databaseName
  });
  const composeFilePath = path.join(config.stateDir, "compose.yml");
  writeFileSync(composeFilePath, composeYaml, { encoding: "utf8", mode: 0o600 });

  const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
  const npxCmd = process.platform === "win32" ? "npx.cmd" : "npx";

  if (!config.skipBuild) {
    process.stdout.write("[dev:stack] Building workspace packages...\n");
    for (const workspaceName of workspaceBuildOrder) {
      const buildRes = spawnSync(npmCmd, ["run", "build", "-w", workspaceName], {
        cwd: config.repoRoot,
        stdio: "inherit",
        env: process.env
      });
      if (buildRes.status !== 0) {
        throw new Error(`npm run build -w ${workspaceName} failed.`);
      }
    }
  }

  process.stdout.write(`[dev:stack] Starting Docker services (${config.projectName})...\n`);
  runDockerCompose(config, ["up", "-d", "--wait"]);

  const { env: childEnv, apiOrigin, webOrigin } = buildDevStackChildEnv(config, secrets);

  process.stdout.write("[dev:stack] Running database migrations...\n");
  const migrateRes = spawnSync(npmCmd, ["run", "db:migrate"], {
    cwd: config.repoRoot,
    stdio: "inherit",
    env: childEnv
  });
  if (migrateRes.status !== 0) {
    throw new Error("Database migration (npm run db:migrate) failed.");
  }

  const serviceSpecs = [
    {
      name: "cli-host",
      command: process.execPath,
      args: [path.join(config.repoRoot, "packages", "cli-host", "dist", "main.js")],
      cwd: config.repoRoot,
      env: childEnv,
      restartOnPackageRebuild: true
    },
    {
      name: "worker",
      command: process.execPath,
      args: [path.join(config.repoRoot, "apps", "worker", "dist", "worker.js")],
      cwd: config.repoRoot,
      env: childEnv,
      restartOnPackageRebuild: true
    },
    {
      name: "api",
      command: npxCmd,
      args: ["tsx", "watch", path.join(config.repoRoot, "apps", "api", "src", "server.ts")],
      cwd: config.repoRoot,
      env: childEnv
    },
    {
      name: "web",
      command: npxCmd,
      args: [
        "vite",
        "--host",
        "127.0.0.1",
        "--port",
        String(config.webPort),
        "--strictPort"
      ],
      cwd: path.join(config.repoRoot, "apps", "web"),
      env: childEnv
    }
  ];

  if (config.packageWatch) {
    serviceSpecs.unshift({
      name: "packages",
      command: npxCmd,
      args: [
        "tsc",
        "-b",
        "packages/contracts",
        "packages/icons",
        "packages/streaming",
        "packages/opencode-control",
        "packages/memory-graph",
        "packages/browser-host",
        "packages/cli-host",
        "packages/codex-app-server",
        "packages/runtime",
        "packages/db",
        "packages/gateway",
        "apps/worker",
        "--watch",
        "--preserveWatchOutput"
      ],
      cwd: config.repoRoot,
      env: childEnv
    });
  }

  const pidsPath = path.join(config.stateDir, "pids.json");
  const writePidsFile = (childPids) => {
    writeFileSync(
      pidsPath,
      `${JSON.stringify(
        {
          supervisorPid: process.pid,
          repoRoot: config.repoRoot,
          stateDir: config.stateDir,
          projectName: config.projectName,
          apiPort: config.apiPort,
          webPort: config.webPort,
          postgresPort: config.postgresPort,
          temporalPort: config.temporalPort,
          opencodeSpec: cliWrappers.opencodeSpec,
          children: childPids
        },
        null,
        2
      )}\n`,
      { encoding: "utf8", mode: 0o600 }
    );
  };

  const supervisor = superviseChildProcesses(serviceSpecs, {
    onPidsChanged: (updatedPids) => {
      try {
        writePidsFile(updatedPids);
      } catch {}
    }
  });
  writePidsFile(supervisor.getPids());

  let shuttingDown = false;
  const handleSignal = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    process.stdout.write(`\n[dev:stack] Received ${signal}, stopping child services...\n`);
    void supervisor.stopAll().finally(() => {
      rmSync(pidsPath, { force: true });
      process.exit(0);
    });
  };
  process.once("SIGINT", () => handleSignal("SIGINT"));
  process.once("SIGTERM", () => handleSignal("SIGTERM"));
  process.once("SIGHUP", () => handleSignal("SIGHUP"));

  try {
    await waitForStackReadiness({
      apiOrigin,
      webOrigin,
      failurePromise: supervisor.failurePromise
    });

    let setupRequired = !secrets.isSetupClaimed();
    try {
      const { response, body } = await fetchJson(`${apiOrigin}/api/setup/status`);
      if (response.status === 200 && typeof body?.setupRequired === "boolean") {
        setupRequired = body.setupRequired;
        if (!setupRequired) {
          secrets.markSetupClaimed();
        }
      }
    } catch {}

    process.stdout.write(
      formatReadyBanner({
        webOrigin,
        apiOrigin,
        setupRequired,
        setupToken: setupRequired ? secrets.setupToken : null
      })
    );

    const statusPollTimer = setInterval(async () => {
      if (secrets.isSetupClaimed()) return;
      try {
        const { response, body } = await fetchJson(`${apiOrigin}/api/setup/status`);
        if (response.status === 200 && body?.setupRequired === false) {
          secrets.markSetupClaimed();
        }
      } catch {}
    }, 5_000);
    statusPollTimer.unref();

    const failure = await supervisor.failurePromise;
    clearInterval(statusPollTimer);
    rmSync(pidsPath, { force: true });
    if (failure) {
      process.exitCode = failure.code || 1;
    }
  } catch (error) {
    await supervisor.stopAll();
    rmSync(pidsPath, { force: true });
    throw error;
  }
}

/**
 * CLI entrypoint dispatching dev:stack subcommands.
 */
export async function runDevStack(argv = process.argv.slice(2), env = process.env) {
  const config = parseDevStackArgs(argv, env, defaultRepoRoot);
  if (config.command === "help") {
    printUsage();
    return;
  }
  if (config.command === "down") {
    await downDevStack(config);
    return;
  }
  if (config.command === "reset") {
    await resetDevStack(config);
    return;
  }
  if (config.command === "status") {
    await statusDevStack(config);
    return;
  }
  if (config.command === "smoke") {
    await runDevStackSmoke(config);
    return;
  }
  await upDevStack(config);
}

const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
  runDevStack().catch((error) => {
    process.stderr.write(`[dev:stack] ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
