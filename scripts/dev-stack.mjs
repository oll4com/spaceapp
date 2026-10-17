#!/usr/bin/env node
import { spawn, execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, watch } from "node:fs";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const defaultRepoRoot = resolve(dirname(scriptPath), "..");

export const DEFAULT_PORTS = Object.freeze({
  web: 14911,
  api: 14910,
  postgres: 15432,
  temporal: 17233
});

export const INTERNAL_PACKAGE_BUILD_ORDER = Object.freeze([
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
  "@space/gateway"
]);

const PACKAGE_DIR_TO_WORKSPACE = new Map([
  ["contracts", "@space/contracts"],
  ["icons", "@space/icons"],
  ["streaming", "@space/streaming"],
  ["opencode-control", "@space/opencode-control"],
  ["memory-graph", "@space/memory-graph"],
  ["browser-host", "@space/browser-host"],
  ["cli-host", "@space/cli-host"],
  ["codex-app-server", "@space/codex-app-server"],
  ["runtime", "@space/runtime"],
  ["db", "@space/db"],
  ["gateway", "@space/gateway"]
]);

function parsePort(rawValue, fallback, envName) {
  if (rawValue === undefined || rawValue === "") return fallback;
  const parsed = Number.parseInt(String(rawValue), 10);
  if (!Number.isInteger(parsed) || parsed < 1024 || parsed > 65535 || String(parsed) !== String(rawValue).trim()) {
    throw new Error(`Invalid port in ${envName}: ${String(rawValue)} (expected integer 1024..65535).`);
  }
  return parsed;
}

/**
 * Extracts the digest-pinned PostgreSQL and Temporal images from
 * packages/run-spaceapp/templates/compose.yml so digests live in one place.
 */
export function extractComposeImages(composeTemplateText) {
  const postgresMatch = composeTemplateText.match(
    /^\s{2}postgres:\r?\n(?:^\s{4}.*\r?\n)*?^\s{4}image:\s*(\S+@sha256:[0-9a-f]{64})\s*$/m
  );
  const temporalMatch = composeTemplateText.match(
    /^\s{2}temporal:\r?\n(?:^\s{4}.*\r?\n)*?^\s{4}image:\s*(\S+@sha256:[0-9a-f]{64})\s*$/m
  );
  if (!postgresMatch?.[1]) {
    throw new Error("Could not extract digest-pinned postgres image from packages/run-spaceapp/templates/compose.yml.");
  }
  if (!temporalMatch?.[1]) {
    throw new Error("Could not extract digest-pinned temporal image from packages/run-spaceapp/templates/compose.yml.");
  }
  return {
    postgresImage: postgresMatch[1],
    temporalImage: temporalMatch[1]
  };
}

/**
 * Extracts the pinned opencode-ai package spec from the root Dockerfile.
 */
export function extractOpenCodePackageSpec(dockerfileText) {
  const match = dockerfileText.match(/\b(opencode-ai@[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?)\b/);
  if (!match?.[1]) {
    throw new Error("Could not extract pinned opencode-ai version from Dockerfile.");
  }
  return match[1];
}

/**
 * Resolves isolated configuration for the contributor dev stack.
 */
export function resolveDevStackConfig(env = process.env, repoRoot = defaultRepoRoot) {
  const resolvedRoot = resolve(repoRoot);
  const rawStateDir = env.SPACE_DEV_STACK_STATE_DIR?.trim() || ".dev-stack";
  const stateDir = isAbsolute(rawStateDir) ? resolve(rawStateDir) : resolve(resolvedRoot, rawStateDir);
  const composeProjectName = (env.SPACE_DEV_STACK_COMPOSE_PROJECT?.trim() || "spaceapp-dev-stack").toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(composeProjectName)) {
    throw new Error(`Invalid compose project name: ${composeProjectName}`);
  }
  if (composeProjectName === "spaceapp") {
    throw new Error("SPACE_DEV_STACK_COMPOSE_PROJECT must not be 'spaceapp' to preserve isolation from an installed instance.");
  }

  const webPort = parsePort(env.SPACE_DEV_WEB_PORT ?? env.SPACE_WEB_PORT, DEFAULT_PORTS.web, "SPACE_DEV_WEB_PORT");
  const apiPort = parsePort(env.SPACE_DEV_API_PORT ?? env.SPACE_API_PORT, DEFAULT_PORTS.api, "SPACE_DEV_API_PORT");
  const postgresPort = parsePort(env.SPACE_DEV_POSTGRES_PORT, DEFAULT_PORTS.postgres, "SPACE_DEV_POSTGRES_PORT");
  const temporalPort = parsePort(env.SPACE_DEV_TEMPORAL_PORT, DEFAULT_PORTS.temporal, "SPACE_DEV_TEMPORAL_PORT");

  const portEntries = [
    ["web", webPort],
    ["api", apiPort],
    ["postgres", postgresPort],
    ["temporal", temporalPort]
  ];
  const seenPorts = new Map();
  for (const [label, port] of portEntries) {
    if (seenPorts.has(port)) {
      throw new Error(`Port collision in dev:stack configuration: ${label} and ${seenPorts.get(port)} both use ${port}.`);
    }
    seenPorts.set(port, label);
  }

  const stateHash = createHash("sha256").update(stateDir).digest("hex").slice(0, 10);
  const socketDir = env.SPACE_DEV_CLI_SOCKET_DIR?.trim()
    ? resolve(env.SPACE_DEV_CLI_SOCKET_DIR.trim())
    : join(tmpdir(), `space-dev-${stateHash}`);
  const socketPath = env.SPACE_DEV_CLI_SOCKET?.trim()
    ? resolve(env.SPACE_DEV_CLI_SOCKET.trim())
    : join(socketDir, "cli-host.sock");

  if (Buffer.byteLength(socketPath) > 100) {
    throw new Error(`CLI host Unix socket path exceeds 100 bytes (${socketPath}). Set SPACE_DEV_CLI_SOCKET_DIR to a shorter directory.`);
  }

  return {
    repoRoot: resolvedRoot,
    stateDir,
    composeProjectName,
    host: "127.0.0.1",
    ports: {
      web: webPort,
      api: apiPort,
      postgres: postgresPort,
      temporal: temporalPort
    },
    socketDir,
    socketPath,
    composeFilePath: join(stateDir, "compose.dev.yml"),
    stackStateFilePath: join(stateDir, "stack-state.json"),
    secretsDir: join(stateDir, "secrets")
  };
}

async function writeSecretFile0600(filePath, content) {
  await writeFile(filePath, `${content}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(filePath, 0o600);
}

async function readOrCreateSecret(filePath, byteLength) {
  if (existsSync(filePath)) {
    const existing = (await readFile(filePath, "utf8")).trim();
    if (existing.length >= 16) {
      await chmod(filePath, 0o600);
      return existing;
    }
  }
  const generated = randomBytes(byteLength).toString("hex");
  await writeSecretFile0600(filePath, generated);
  return generated;
}

/**
 * Generates per-state-directory secrets with mode 0600.
 */
export async function ensureDevStackSecrets(stateDir, postgresPort = DEFAULT_PORTS.postgres) {
  const secretsDir = join(stateDir, "secrets");
  await mkdir(secretsDir, { recursive: true, mode: 0o700 });
  await chmod(secretsDir, 0o700);

  const postgresPasswordPath = join(secretsDir, "postgres-password");
  const sessionSecretPath = join(secretsDir, "session-secret");
  const setupTokenPath = join(secretsDir, "setup-token");
  const databaseUrlPath = join(secretsDir, "database-url");

  const postgresPassword = await readOrCreateSecret(postgresPasswordPath, 24);
  const sessionSecret = await readOrCreateSecret(sessionSecretPath, 32);
  const setupToken = await readOrCreateSecret(setupTokenPath, 24);
  const databaseUrl = `postgresql://spaceapp:${postgresPassword}@127.0.0.1:${postgresPort}/spaceapp`;
  await writeSecretFile0600(databaseUrlPath, databaseUrl);

  return {
    secretsDir,
    postgresPasswordPath,
    sessionSecretPath,
    setupTokenPath,
    databaseUrlPath,
    postgresPassword,
    sessionSecret,
    setupToken,
    databaseUrl
  };
}

/**
 * Renders the Docker Compose file for PostgreSQL (pgvector) and Temporal,
 * binding every published port strictly to 127.0.0.1.
 */
export function renderDevComposeFile({
  postgresImage,
  temporalImage,
  postgresPort,
  temporalPort,
  postgresPasswordFile
}) {
  if (!postgresImage?.includes("@sha256:")) {
    throw new Error("postgresImage must be digest-pinned.");
  }
  if (!temporalImage?.includes("@sha256:")) {
    throw new Error("temporalImage must be digest-pinned.");
  }
  return [
    "services:",
    "  postgres:",
    `    image: ${postgresImage}`,
    "    restart: unless-stopped",
    "    environment:",
    "      POSTGRES_DB: spaceapp",
    "      POSTGRES_USER: spaceapp",
    "      POSTGRES_PASSWORD_FILE: /run/secrets/postgres-password",
    "    secrets:",
    "      - postgres-password",
    "    ports:",
    `      - "127.0.0.1:${postgresPort}:5432"`,
    "    volumes:",
    "      - postgres-data:/var/lib/postgresql/data",
    "    healthcheck:",
    '      test: ["CMD-SHELL", "pg_isready -U spaceapp -d spaceapp"]',
    "      interval: 2s",
    "      timeout: 5s",
    "      retries: 30",
    "",
    "  temporal:",
    `    image: ${temporalImage}`,
    "    restart: unless-stopped",
    "    depends_on:",
    "      postgres:",
    "        condition: service_healthy",
    "    environment:",
    "      DB: postgres12",
    "      DB_PORT: 5432",
    "      POSTGRES_USER: spaceapp",
    "      POSTGRES_SEEDS: postgres",
    "      DYNAMIC_CONFIG_FILE_PATH: config/dynamicconfig/docker.yaml",
    '    entrypoint: ["/bin/sh", "-ec"]',
    "    command:",
    '      - export POSTGRES_PWD="$$(cat /run/secrets/postgres-password)"; exec /etc/temporal/entrypoint.sh autosetup',
    "    secrets:",
    "      - postgres-password",
    "    ports:",
    `      - "127.0.0.1:${temporalPort}:7233"`,
    "    healthcheck:",
    '      test: ["CMD-SHELL", "temporal operator cluster health --address temporal:7233 >/dev/null && temporal operator namespace describe --namespace default --address temporal:7233 >/dev/null"]',
    "      interval: 3s",
    "      timeout: 5s",
    "      retries: 40",
    "",
    "secrets:",
    "  postgres-password:",
    `    file: ${JSON.stringify(postgresPasswordFile)}`,
    "",
    "volumes:",
    "  postgres-data:",
    ""
  ].join("\n");
}

/**
 * Renders the state-directory-local opencode-vscode-parity wrapper script.
 */
export function renderOpenCodeWrapper({ vendorDir, providerRoot }) {
  const opencodeBin = join(vendorDir, "node_modules", ".bin", "opencode");
  return [
    "#!/bin/sh",
    "set -eu",
    `PROVIDER_ROOT=${JSON.stringify(providerRoot)}`,
    `OPENCODE_BIN=${JSON.stringify(opencodeBin)}`,
    'export HOME="$PROVIDER_ROOT/home"',
    'export TMPDIR="$PROVIDER_ROOT/tmp"',
    'export XDG_CONFIG_HOME="$PROVIDER_ROOT/config"',
    'export XDG_DATA_HOME="$PROVIDER_ROOT/data"',
    'export XDG_CACHE_HOME="$PROVIDER_ROOT/cache"',
    'export XDG_STATE_HOME="$PROVIDER_ROOT/state"',
    'mkdir -p "$HOME" "$TMPDIR" "$XDG_CONFIG_HOME/opencode" "$XDG_DATA_HOME" "$XDG_CACHE_HOME" "$XDG_STATE_HOME"',
    'chmod 700 "$TMPDIR" 2>/dev/null || true',
    "",
    'case "${1:-}" in',
    "  credential-status)",
    "    if [ -x \"$OPENCODE_BIN\" ]; then",
    "      printf 'READY\\n'",
    "      exit 0",
    "    fi",
    "    printf 'UNAVAILABLE\\n'",
    "    exit 1",
    "    ;;",
    "  credential-observation)",
    "    if command -v sha256sum >/dev/null 2>&1; then",
    '      DIGEST=$(find "$XDG_CONFIG_HOME" "$XDG_DATA_HOME" -type f 2>/dev/null | LC_ALL=C sort | xargs -r sha256sum 2>/dev/null | sha256sum | awk \'{print $1}\')',
    "    else",
    '      DIGEST="devstack"',
    "    fi",
    '    printf "OBSERVATION:%s\\n" "$DIGEST"',
    "    exit 0",
    "    ;;",
    "  credential-smoke)",
    '    "$OPENCODE_BIN" --version >/dev/null 2>&1',
    "    printf 'SPACE_OPENCODE_OK\\n'",
    "    exit 0",
    "    ;;",
    "  inspect-env)",
    "    env",
    "    exit 0",
    "    ;;",
    "esac",
    "",
    'exec "$OPENCODE_BIN" "$@"',
    ""
  ].join("\n");
}

/**
 * Installs the pinned opencode-ai package into <stateDir>/cli/vendor/opencode
 * and creates the wrapper script in <stateDir>/bin/opencode-vscode-parity.
 */
export async function ensureOpenCodeWrapperAndVendor({
  stateDir,
  repoRoot = defaultRepoRoot,
  packageSpec,
  installVendor = true,
  log = (msg) => process.stdout.write(`${msg}\n`)
}) {
  const resolvedSpec = packageSpec ?? extractOpenCodePackageSpec(await readFile(join(repoRoot, "Dockerfile"), "utf8"));
  const expectedVersion = resolvedSpec.slice("opencode-ai@".length);
  const vendorDir = join(stateDir, "cli", "vendor", "opencode");
  const providerRoot = join(stateDir, "cli", "providers", "opencode");
  const binDir = join(stateDir, "bin");
  const wrapperPath = join(binDir, "opencode-vscode-parity");

  await mkdir(vendorDir, { recursive: true });
  await mkdir(join(providerRoot, "home"), { recursive: true });
  await mkdir(join(providerRoot, "tmp"), { recursive: true, mode: 0o700 });
  await mkdir(join(providerRoot, "config", "opencode"), { recursive: true });
  await mkdir(join(providerRoot, "data"), { recursive: true });
  await mkdir(join(providerRoot, "cache"), { recursive: true });
  await mkdir(join(providerRoot, "state"), { recursive: true });
  await mkdir(binDir, { recursive: true });

  const opencodeConfigPath = join(providerRoot, "config", "opencode", "opencode.json");
  if (!existsSync(opencodeConfigPath)) {
    const tmpRule = join(providerRoot, "tmp");
    const memoryDir = join(stateDir, "memory");
    const defaultConfig = {
      $schema: "https://opencode.ai/config.json",
      permission: {
        edit: "allow",
        bash: "allow",
        webfetch: "allow",
        external_directory: {
          "*": "ask",
          [memoryDir]: "allow",
          [`${memoryDir}/*`]: "allow",
          [tmpRule]: "allow",
          [`${tmpRule}/*`]: "allow"
        }
      }
    };
    await writeFile(opencodeConfigPath, `${JSON.stringify(defaultConfig, null, 2)}\n`, "utf8");
  }

  const installedManifestPath = join(vendorDir, "node_modules", "opencode-ai", "package.json");
  const opencodeBinPath = join(vendorDir, "node_modules", ".bin", "opencode");
  let alreadyInstalled = false;
  if (existsSync(installedManifestPath) && existsSync(opencodeBinPath)) {
    try {
      const installed = JSON.parse(await readFile(installedManifestPath, "utf8"));
      if (installed.version === expectedVersion) {
        alreadyInstalled = true;
      }
    } catch {
      alreadyInstalled = false;
    }
  }

  if (installVendor && !alreadyInstalled) {
    log(`[dev:stack] Installing pinned ${resolvedSpec} into ${relative(repoRoot, vendorDir) || vendorDir}...`);
    await writeFile(
      join(vendorDir, "package.json"),
      `${JSON.stringify({ name: "spaceapp-dev-stack-opencode", private: true }, null, 2)}\n`,
      "utf8"
    );
    execFileSync(
      "npm",
      ["install", "--prefix", vendorDir, "--no-audit", "--no-fund", "--save-exact", resolvedSpec],
      {
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, npm_config_update_notifier: "false" }
      }
    );
  }

  const wrapperContent = renderOpenCodeWrapper({ vendorDir, providerRoot });
  await writeFile(wrapperPath, wrapperContent, { encoding: "utf8", mode: 0o755 });
  await chmod(wrapperPath, 0o755);

  return {
    packageSpec: resolvedSpec,
    expectedVersion,
    vendorDir,
    providerRoot,
    binDir,
    wrapperPath
  };
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    return true;
  }
}

async function terminatePid(pid, timeoutMs = 4000) {
  if (!isProcessAlive(pid)) return;
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      return;
    }
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already exited
    }
  }
}

/**
 * Launches and supervises child processes. If any supervised child exits
 * unexpectedly while the stack is running, all remaining children are stopped
 * and the supervisor rejects with a clear failure message.
 */
export function superviseProcesses(specs, { onLog = (line) => process.stdout.write(`${line}\n`), onErrorLog = (line) => process.stderr.write(`${line}\n`) } = {}) {
  const children = new Map();
  let shuttingDown = false;
  let failureReject;
  const failurePromise = new Promise((_, reject) => {
    failureReject = reject;
  });

  const pipeLines = (stream, prefix, writer) => {
    let buffer = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      buffer += chunk;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line.trim().length > 0) {
          writer(`[${prefix}] ${line}`);
        }
      }
    });
    stream.on("end", () => {
      if (buffer.trim().length > 0) {
        writer(`[${prefix}] ${buffer}`);
      }
    });
  };

  const spawnSpec = (spec) => {
    const child = spawn(spec.command, spec.args ?? [], {
      cwd: spec.cwd,
      env: spec.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32"
    });
    const entry = { spec, child, restarting: false };
    children.set(spec.name, entry);

    if (child.stdout) pipeLines(child.stdout, spec.name, onLog);
    if (child.stderr) pipeLines(child.stderr, spec.name, onErrorLog);

    child.on("exit", (code, signal) => {
      if (shuttingDown || entry.restarting) return;
      const reason = signal ? `signal ${signal}` : `exit code ${code ?? 1}`;
      const message = `[dev:stack] ERROR: Process "${spec.name}" exited unexpectedly (${reason}). Stopping dev stack.`;
      onErrorLog(message);
      void stopAll().finally(() => {
        failureReject(new Error(message));
      });
    });

    child.on("error", (error) => {
      if (shuttingDown || entry.restarting) return;
      const message = `[dev:stack] ERROR: Process "${spec.name}" failed to start: ${error.message}`;
      onErrorLog(message);
      void stopAll().finally(() => {
        failureReject(new Error(message));
      });
    });

    return child;
  };

  const waitForChildExit = (child, timeoutMs = 4000) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      return Promise.resolve();
    }
    return new Promise((resolveExit) => {
      const timer = setTimeout(resolveExit, timeoutMs);
      child.once("exit", () => {
        clearTimeout(timer);
        resolveExit();
      });
    });
  };

  async function stopChild(child, timeoutMs = 4000) {
    if (!child.pid) return;
    const exitPromise = waitForChildExit(child, timeoutMs);
    await terminatePid(child.pid, timeoutMs);
    await exitPromise;
  }

  for (const spec of specs) {
    spawnSpec(spec);
  }

  const inFlightRestarts = new Map();

  async function restartProcess(name) {
    if (shuttingDown) return;
    const existing = inFlightRestarts.get(name);
    if (existing) {
      return existing;
    }
    const restartPromise = (async () => {
      try {
        const entry = children.get(name);
        if (!entry || shuttingDown) return;
        entry.restarting = true;
        await stopChild(entry.child, 3000);
        if (shuttingDown) return;
        spawnSpec(entry.spec);
      } finally {
        inFlightRestarts.delete(name);
      }
    })();
    inFlightRestarts.set(name, restartPromise);
    return restartPromise;
  }

  async function stopAll() {
    if (shuttingDown) return;
    shuttingDown = true;
    const activeChildren = [...children.values()].map(({ child }) => child);
    await Promise.all(activeChildren.map((child) => stopChild(child, 4000)));
  }

  function getPids() {
    const result = {};
    for (const [name, { child }] of children.entries()) {
      if (child.pid) result[name] = child.pid;
    }
    return result;
  }

  return {
    failurePromise,
    restartProcess,
    stopAll,
    getPids
  };
}

async function waitForFile(filePath, timeoutMs, failurePromise, description) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await Promise.race([
      new Promise((resolveDelay) => setTimeout(resolveDelay, 100)),
      failurePromise
    ]);
    if (existsSync(filePath)) return;
  }
  throw new Error(`Timed out waiting for ${description} at ${filePath}.`);
}

async function waitForReadyz(url, timeoutMs, failurePromise) {
  const deadline = Date.now() + timeoutMs;
  let lastDetail = "no response yet";
  while (Date.now() < deadline) {
    await Promise.race([
      new Promise((resolveDelay) => setTimeout(resolveDelay, 400)),
      failurePromise
    ]);
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2500) });
      const text = await response.text();
      let parsed = null;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = null;
      }
      if (
        response.ok &&
        parsed?.ok === true &&
        parsed?.dependencies?.database === "RUNNING" &&
        parsed?.dependencies?.worker === "RUNNING" &&
        parsed?.dependencies?.cliHost === "RUNNING" &&
        parsed?.dependencies?.temporal === "enabled"
      ) {
        return parsed;
      }
      lastDetail = `HTTP ${response.status} (temporal=${parsed?.dependencies?.temporal ?? "unknown"}): ${text.slice(0, 240)}`;
    } catch (error) {
      lastDetail = error instanceof Error ? error.message : String(error);
    }
  }
  throw new Error(
    `Timed out waiting for ${url} to report ok: true with worker RUNNING and dependencies.temporal === "enabled" (last state: ${lastDetail}).`
  );
}

function runDockerCompose(config, composeArgs, stdio = "inherit") {
  execFileSync(
    "docker",
    ["compose", "-p", config.composeProjectName, "-f", config.composeFilePath, ...composeArgs],
    {
      cwd: config.repoRoot,
      stdio
    }
  );
}

async function waitForDockerServicesHealthy(config, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const output = execFileSync(
        "docker",
        ["compose", "-p", config.composeProjectName, "-f", config.composeFilePath, "ps", "--format", "json"],
        { cwd: config.repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
      ).trim();
      const lines = output.split(/\r?\n/).filter(Boolean);
      const records = lines.flatMap((line) => {
        const parsed = JSON.parse(line);
        return Array.isArray(parsed) ? parsed : [parsed];
      });
      const postgres = records.find((r) => r.Service === "postgres");
      const temporal = records.find((r) => r.Service === "temporal");
      if (postgres?.Health === "healthy" && temporal?.Health === "healthy") {
        return;
      }
    } catch {
      // retry until deadline
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 1000));
  }
  throw new Error("Timed out waiting for PostgreSQL and Temporal containers to become healthy.");
}

async function buildSourcePackages(repoRoot, log) {
  log("[dev:stack] Building internal @space/* packages and Temporal worker from source...");
  for (const workspace of [...INTERNAL_PACKAGE_BUILD_ORDER, "@space/worker"]) {
    execFileSync("npm", ["run", "build", "-w", workspace], {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"]
    });
  }
}

function startWorkspaceSourceWatcher({ repoRoot, supervisor, onLog, onErrorLog }) {
  const watchers = [];
  let debounceTimer = null;
  const pendingWorkspaces = new Set();

  const flushBuilds = () => {
    const targets = [...pendingWorkspaces];
    pendingWorkspaces.clear();
    if (targets.length === 0) return;

    const internalPackagesChanged = INTERNAL_PACKAGE_BUILD_ORDER.filter((w) => targets.includes(w));
    const ordered = [...internalPackagesChanged];
    if (targets.includes("@space/worker") || internalPackagesChanged.length > 0) {
      ordered.push("@space/worker");
    }

    for (const workspace of ordered) {
      try {
        onLog(`[dev:stack] Rebuilding ${workspace} after source change...`);
        execFileSync("npm", ["run", "build", "-w", workspace], {
          cwd: repoRoot,
          stdio: ["ignore", "pipe", "pipe"]
        });
      } catch (error) {
        onErrorLog(`[dev:stack] Rebuild failed for ${workspace}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    if (internalPackagesChanged.length > 0 || targets.includes("@space/cli-host")) {
      onLog("[dev:stack] Restarting cli-host to pick up rebuilt packages...");
      void supervisor.restartProcess("cli-host");
    }
    if (internalPackagesChanged.length > 0 || targets.includes("@space/worker")) {
      onLog("[dev:stack] Restarting worker to pick up rebuilt packages...");
      void supervisor.restartProcess("worker");
    }
    if (targets.includes("@space/api") || ordered.length > 0) {
      onLog("[dev:stack] Restarting api to pick up source changes...");
      void supervisor.restartProcess("api");
    }
  };

  const scheduleRebuild = (workspace) => {
    pendingWorkspaces.add(workspace);
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(flushBuilds, 250);
  };

  for (const [dirName, workspace] of PACKAGE_DIR_TO_WORKSPACE.entries()) {
    const srcDir = join(repoRoot, "packages", dirName, "src");
    if (!existsSync(srcDir)) continue;
    try {
      const watcher = watch(srcDir, { recursive: true }, (_eventType, filename) => {
        if (!filename || /\.(ts|tsx|mts|cts|js|mjs|json)$/.test(String(filename))) {
          scheduleRebuild(workspace);
        }
      });
      watchers.push(watcher);
    } catch {
      // recursive watch unsupported on some platforms; ignore
    }
  }

  for (const [appDir, targetName] of [
    ["worker", "@space/worker"],
    ["api", "@space/api"]
  ]) {
    const srcDir = join(repoRoot, "apps", appDir, "src");
    if (!existsSync(srcDir)) continue;
    try {
      const watcher = watch(srcDir, { recursive: true }, (_eventType, filename) => {
        if (!filename || /\.(ts|tsx|mts|cts|js|mjs|json)$/.test(String(filename))) {
          scheduleRebuild(targetName);
        }
      });
      watchers.push(watcher);
    } catch {
      // ignore
    }
  }

  return () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    for (const watcher of watchers) {
      try {
        watcher.close();
      } catch {
        // ignore
      }
    }
  };
}

function isExpectedDevStackProcess(pid) {
  if (!isProcessAlive(pid)) return false;
  try {
    const procCmdline = `/proc/${pid}/cmdline`;
    if (existsSync(procCmdline)) {
      const raw = execFileSync("cat", [procCmdline], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
        .replace(/\0+/g, " ");
      return /(cli-host|worker\.js|src\/server\.ts|vite|dev-stack\.mjs)/.test(raw);
    }
    const psOut = execFileSync("ps", ["-p", String(pid), "-o", "args="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    });
    return /(cli-host|worker\.js|src\/server\.ts|vite|dev-stack\.mjs)/.test(psOut);
  } catch {
    return false;
  }
}

async function stopRecordedProcesses(config) {
  if (!existsSync(config.stackStateFilePath)) return;
  try {
    const state = JSON.parse(await readFile(config.stackStateFilePath, "utf8"));
    const pids = Object.values(state.pids ?? {}).filter((pid) => Number.isInteger(pid));
    if (Number.isInteger(state.supervisorPid) && state.supervisorPid !== process.pid) {
      pids.push(state.supervisorPid);
    }
    const verifiedPids = pids.filter((pid) => isExpectedDevStackProcess(pid));
    await Promise.all(verifiedPids.map((pid) => terminatePid(pid, 4000)));
    if (state.socketPath && existsSync(state.socketPath)) {
      await rm(state.socketPath, { force: true });
    }
  } catch {
    // ignore corrupt state file
  }
}

function removeLabeledDockerResources(projectName, removeVolumes) {
  try {
    const containerIds = execFileSync(
      "docker",
      ["ps", "-aq", "--filter", `label=com.docker.compose.project=${projectName}`],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
    )
      .trim()
      .split(/\r?\n/)
      .filter(Boolean);
    if (containerIds.length > 0) {
      execFileSync("docker", ["rm", "-f", ...containerIds], { stdio: ["ignore", "pipe", "pipe"] });
    }
  } catch {
    // ignore when docker is unavailable or no containers exist
  }

  if (removeVolumes) {
    try {
      const volumeNames = execFileSync(
        "docker",
        ["volume", "ls", "-q", "--filter", `label=com.docker.compose.project=${projectName}`],
        { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
      )
        .trim()
        .split(/\r?\n/)
        .filter(Boolean);
      if (volumeNames.length > 0) {
        execFileSync("docker", ["volume", "rm", "-f", ...volumeNames], { stdio: ["ignore", "pipe", "pipe"] });
      }
    } catch {
      // ignore
    }
  }
}

export async function stopDevStack(config, { removeVolumes = false, removeState = false, log = (msg) => process.stdout.write(`${msg}\n`) } = {}) {
  await stopRecordedProcesses(config);

  if (existsSync(config.composeFilePath)) {
    try {
      const downArgs = ["down", "--remove-orphans"];
      if (removeVolumes) downArgs.push("-v");
      runDockerCompose(config, downArgs, ["ignore", "pipe", "pipe"]);
    } catch {
      removeLabeledDockerResources(config.composeProjectName, removeVolumes);
    }
  } else {
    removeLabeledDockerResources(config.composeProjectName, removeVolumes);
  }

  if (existsSync(config.socketPath)) {
    await rm(config.socketPath, { force: true });
  }

  if (removeState) {
    await rm(config.socketDir, { recursive: true, force: true });
    await rm(config.stateDir, { recursive: true, force: true });
    log(`[dev:stack] Reset complete. Removed containers, volumes, and state directory (${config.stateDir}).`);
  } else {
    if (existsSync(config.stackStateFilePath)) {
      await rm(config.stackStateFilePath, { force: true });
    }
    log("[dev:stack] Stopped all dev:stack processes and containers.");
  }
}

export async function runDevStack(argv = process.argv.slice(2), { env = process.env, repoRoot = defaultRepoRoot } = {}) {
  if (process.platform === "win32") {
    throw new Error("Run `npm run dev:stack` inside Linux, macOS, or Windows 11 WSL2.");
  }

  const command = argv.find((arg) => !arg.startsWith("-")) ?? "up";
  if (!["up", "down", "reset"].includes(command)) {
    throw new Error(`Unknown dev:stack command "${command}". Expected: up (default), down, or reset.`);
  }

  const config = resolveDevStackConfig(env, repoRoot);

  if (command === "down") {
    await stopDevStack(config, { removeVolumes: false, removeState: false });
    return;
  }

  if (command === "reset") {
    await stopDevStack(config, { removeVolumes: true, removeState: true });
    return;
  }

  await stopRecordedProcesses(config);

  const composeTemplateText = await readFile(
    join(config.repoRoot, "packages", "run-spaceapp", "templates", "compose.yml"),
    "utf8"
  );
  const { postgresImage, temporalImage } = extractComposeImages(composeTemplateText);

  await mkdir(config.stateDir, { recursive: true });
  await mkdir(config.socketDir, { recursive: true, mode: 0o700 });
  await chmod(config.socketDir, 0o700);
  if (existsSync(config.socketPath)) {
    await rm(config.socketPath, { force: true });
  }

  const runtimeDataDir = join(config.stateDir, "data");
  const workspacesDir = join(config.stateDir, "workspaces");
  const memoryDir = join(config.stateDir, "memory");
  const memoryGraphDir = join(runtimeDataDir, "memory-graph");
  const telegramSecretDir = join(runtimeDataDir, "telegram");
  const telegramIntegrationsDir = join(runtimeDataDir, "integrations", "telegram");
  await mkdir(runtimeDataDir, { recursive: true });
  await mkdir(workspacesDir, { recursive: true });
  await mkdir(memoryDir, { recursive: true });
  await mkdir(memoryGraphDir, { recursive: true });
  await mkdir(telegramSecretDir, { recursive: true });
  await mkdir(telegramIntegrationsDir, { recursive: true });

  const starterMemoryRoot = join(config.repoRoot, "starter-memory");
  for (const starterFile of ["gemini_history.md", "gemini_history_monthly.md", "installation-guide.md"]) {
    const srcPath = join(starterMemoryRoot, starterFile);
    const destPath = join(memoryDir, starterFile);
    if (existsSync(srcPath) && !existsSync(destPath)) {
      await writeFile(destPath, await readFile(srcPath), { mode: 0o600 });
      await chmod(destPath, 0o600);
    }
  }

  const secrets = await ensureDevStackSecrets(config.stateDir, config.ports.postgres);
  const openCode = await ensureOpenCodeWrapperAndVendor({
    stateDir: config.stateDir,
    repoRoot: config.repoRoot
  });

  const composeYaml = renderDevComposeFile({
    postgresImage,
    temporalImage,
    postgresPort: config.ports.postgres,
    temporalPort: config.ports.temporal,
    postgresPasswordFile: secrets.postgresPasswordPath
  });
  await writeFile(config.composeFilePath, composeYaml, "utf8");

  process.stdout.write("[dev:stack] Starting PostgreSQL (pgvector) and Temporal in Docker...\n");
  try {
    runDockerCompose(config, ["up", "-d"], ["ignore", "pipe", "pipe"]);
    await waitForDockerServicesHealthy(config);

    await buildSourcePackages(config.repoRoot, (msg) => process.stdout.write(`${msg}\n`));

    process.stdout.write("[dev:stack] Running database migrations...\n");
    execFileSync("npm", ["run", "db:migrate"], {
      cwd: config.repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        DATABASE_URL: secrets.databaseUrl,
        SPACE_DATABASE_URL: secrets.databaseUrl,
        SPACE_DATABASE_URL_FILE: secrets.databaseUrlPath
      }
    });
  } catch (error) {
    await stopDevStack(config, { removeVolumes: false, removeState: false, log: () => {} });
    throw error;
  }

  const sharedEnv = {
    ...process.env,
    NODE_ENV: "development",
    SPACE_DEPLOYMENT_PROFILE: "self-hosted",
    SPACE_PUBLIC_DISTRIBUTION: "true",
    SPACE_AGENT_TOOLS_WRITER: "disabled",
    SPACE_T3CODE_ENABLED: "false",
    SPACE_DEV_LOGIN: "false",
    SPACE_DEV_LOGIN_ENABLED: "false",
    SPACE_RUNTIME_STORE: "postgres",
    SPACE_REQUIRE_PERSISTENT_STORES: "true",
    SPACEAPP_WORKFLOWS_ENABLED: "true",
    SPACE_ENABLE_WORKFLOWS: "true",
    SPACE_ENABLE_DUMMY_TURNS: "true",
    SPACE_DB_AUTO_MIGRATE: "false",
    DATABASE_URL: secrets.databaseUrl,
    SPACE_DATABASE_URL: secrets.databaseUrl,
    DATABASE_URL_FILE: secrets.databaseUrlPath,
    SPACE_DATABASE_URL_FILE: secrets.databaseUrlPath,
    SPACE_DATABASE_URL_SOURCE_FILE: secrets.databaseUrlPath,
    SPACE_SESSION_SECRET: secrets.sessionSecret,
    SPACE_SESSION_SECRET_FILE: secrets.sessionSecretPath,
    SPACE_SETUP_TOKEN_FILE: secrets.setupTokenPath,
    SPACE_SETUP_TOKEN_SOURCE_FILE: secrets.setupTokenPath,
    SPACE_INITIAL_OWNER_SETUP_TOKEN_FILE: secrets.setupTokenPath,
    SPACE_TEMPORAL_ADDRESS: `127.0.0.1:${config.ports.temporal}`,
    SPACE_TEMPORAL_NAMESPACE: "default",
    SPACE_TEMPORAL_TASK_QUEUE: "space-default",
    SPACE_API_HOST: "127.0.0.1",
    SPACE_API_PORT: String(config.ports.api),
    SPACE_HOST: "127.0.0.1",
    SPACE_PORT: String(config.ports.api),
    SPACE_WEB_ORIGIN: `http://127.0.0.1:${config.ports.web}`,
    SPACE_WEB_HOST: "127.0.0.1",
    SPACE_WEB_PORT: String(config.ports.web),
    SPACE_API_ORIGIN: `http://127.0.0.1:${config.ports.api}`,
    SPACE_CLI_ENABLED: "true",
    SPACE_CLI_HOST_SOCKET: config.socketPath,
    SPACE_CLI_COMMAND_PATH: openCode.binDir,
    SPACE_CLI_PROVIDER_HOME_ROOT: join(config.stateDir, "cli", "providers"),
    SPACE_CLI_WORKSPACE_ROOT: workspacesDir,
    SPACE_MEMORY_ROOT: memoryDir,
    SPACE_STARTER_MEMORY_ROOT: starterMemoryRoot,
    SPACE_STARTER_MEMORY_PATH: memoryDir,
    SPACE_MEMORY_GRAPH_ROOT: memoryGraphDir,
    SPACE_GEMINI_MEMORY_INDEX_PATH: join(memoryDir, "gemini_history.md"),
    SPACE_GEMINI_MEMORY_MONTHLY_PATH: join(memoryDir, "gemini_history_monthly.md"),
    SPACE_GEMINI_MEMORY_LOCK_PATH: join(memoryDir, ".memory.lock"),
    SPACE_TELEGRAM_SECRET_ROOT: telegramSecretDir,
    SPACE_TELEGRAM_OWNERSHIP_MANIFEST: join(telegramIntegrationsDir, "thread-ownership.json"),
    SPACE_CODEX_GOALS_DB_PATH: join(runtimeDataDir, "codex-goals.sqlite"),
    SPACE_CODEX_CLI_MODE_DEFAULTS_PROJECTION_PATH: join(runtimeDataDir, "codex-cli-mode-defaults-v1.json"),
    SPACE_BROWSER_SESSIONS_ENABLED: "false",
    SPACE_ARTIFACT_ROOT: join(runtimeDataDir, "artifacts"),
    SPACE_APP_DIAGNOSTICS_ROOT: join(runtimeDataDir, "app-diagnostics"),
    SPACE_MAINTENANCE_AUTOPILOT_STATE_FILE: join(runtimeDataDir, "maintenance-autopilot", "state.json"),
    SPACE_CLI_ACCOUNT_BALANCER_STATE_FILE: join(runtimeDataDir, "cli-account-balancer", "state.json"),
    SPACE_STREAMING_SECRET_ROOT: join(runtimeDataDir, "streaming-secrets"),
    SPACE_DEMO_PROJECTS_ROOT: join(runtimeDataDir, "demos"),
    SPACE_PROJECTS_ROOT: join(workspacesDir, "projects"),
    SPACE_INSTALL_ROOT: config.repoRoot,
    SPACE_DEMO_PROJECTS_VAR_ROOT: join(runtimeDataDir, "demo-projects"),
    SPACE_DOT_WORKSPACE_ROOT: join(runtimeDataDir, "dots", "workspaces"),
    SPACE_BACKUP_ROOT: join(runtimeDataDir, "backups"),
    SPACE_PORTABLE_BACKUP_ROOT: join(runtimeDataDir, "portable-backups"),
    SPACE_KNOWLEDGE_STORAGE_ROOT: join(runtimeDataDir, "knowledge-base"),
    SPACE_WORKTREE_ROOT: join(runtimeDataDir, "worktrees"),
    SPACE_WORKTREES_ROOT: join(runtimeDataDir, "worktrees"),
    SPACE_PERSONAL_GIT_ROOT: join(runtimeDataDir, "personal-source-control"),
    SPACE_RUNTIME_STATE_PATH: join(runtimeDataDir, "runtime-state.json"),
    SPACE_SYSTEM_SETTINGS_PATH: join(runtimeDataDir, "system-settings.json"),
    SPACE_PROVIDER_CONNECTIONS_PATH: join(runtimeDataDir, "provider-connections.json"),
    SPACE_ENV_PROFILES_PATH: join(runtimeDataDir, "env-profiles.json"),
    SPACE_PROMPT_LIBRARY_PATH: join(runtimeDataDir, "prompt-library.json"),
    SPACE_MCP_SERVERS_PATH: join(runtimeDataDir, "mcp-servers.json"),
    SPACE_ROUTING_PROFILES_PATH: join(runtimeDataDir, "routing-profiles.json"),
    SPACE_AGENT_PRESETS_PATH: join(runtimeDataDir, "agent-presets.json"),
    SPACE_BUNDLED_SKILLS_PATH: join(config.repoRoot, "agent-skills"),
    SPACE_BUNDLED_DEMOS_PATH: join(config.repoRoot, "demos"),
    PATH: `${openCode.binDir}:${process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin"}`
  };

  const tsxBin = join(config.repoRoot, "node_modules", ".bin", "tsx");
  const viteBin = join(config.repoRoot, "node_modules", ".bin", "vite");

  const supervisor = superviseProcesses([
    {
      name: "cli-host",
      command: process.execPath,
      args: [join(config.repoRoot, "packages", "cli-host", "dist", "main.js")],
      cwd: config.repoRoot,
      env: sharedEnv
    },
    {
      name: "worker",
      command: process.execPath,
      args: [join(config.repoRoot, "apps", "worker", "dist", "worker.js")],
      cwd: join(config.repoRoot, "apps", "worker"),
      env: sharedEnv
    },
    {
      name: "api",
      command: tsxBin,
      args: ["src/server.ts"],
      cwd: join(config.repoRoot, "apps", "api"),
      env: sharedEnv
    },
    {
      name: "web",
      command: viteBin,
      args: ["--host", "127.0.0.1", "--port", String(config.ports.web), "--strictPort"],
      cwd: join(config.repoRoot, "apps", "web"),
      env: sharedEnv
    }
  ]);

  const stopWatcher = startWorkspaceSourceWatcher({
    repoRoot: config.repoRoot,
    supervisor,
    onLog: (line) => process.stdout.write(`${line}\n`),
    onErrorLog: (line) => process.stderr.write(`${line}\n`)
  });

  const writeStackState = async () => {
    await writeFile(
      config.stackStateFilePath,
      `${JSON.stringify(
        {
          supervisorPid: process.pid,
          pids: supervisor.getPids(),
          socketPath: config.socketPath,
          socketDir: config.socketDir,
          ports: config.ports,
          composeProjectName: config.composeProjectName,
          startedAt: new Date().toISOString()
        },
        null,
        2
      )}\n`,
      "utf8"
    );
  };
  await writeStackState();

  let cleanedUp = false;
  const cleanupOnSignal = async () => {
    if (cleanedUp) return;
    cleanedUp = true;
    stopWatcher();
    await supervisor.stopAll();
    if (existsSync(config.socketPath)) {
      await rm(config.socketPath, { force: true });
    }
    if (existsSync(config.stackStateFilePath)) {
      await rm(config.stackStateFilePath, { force: true });
    }
  };

  const onSigInt = () => {
    void cleanupOnSignal().finally(() => process.exit(0));
  };
  const onSigTerm = () => {
    void cleanupOnSignal().finally(() => process.exit(0));
  };
  process.once("SIGINT", onSigInt);
  process.once("SIGTERM", onSigTerm);

  try {
    await waitForFile(config.socketPath, 15_000, supervisor.failurePromise, "CLI host Unix socket");
    const readyzUrl = `http://127.0.0.1:${config.ports.web}/readyz`;
    await waitForReadyz(readyzUrl, 90_000, supervisor.failurePromise);
    await writeStackState();

    const webUrl = `http://127.0.0.1:${config.ports.web}`;
    process.stdout.write("\n============================================================\n");
    process.stdout.write("SpaceApp contributor dev stack is READY\n");
    process.stdout.write(`URL: ${webUrl}\n`);
    process.stdout.write(`Owner setup token: ${secrets.setupToken}\n`);
    process.stdout.write("Stop stack:  npm run dev:stack -- down\n");
    process.stdout.write("Reset stack: npm run dev:stack -- reset\n");
    process.stdout.write("============================================================\n\n");

    await supervisor.failurePromise;
  } catch (error) {
    await cleanupOnSignal();
    throw error;
  } finally {
    process.off("SIGINT", onSigInt);
    process.off("SIGTERM", onSigTerm);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  runDevStack().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
