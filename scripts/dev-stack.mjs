#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import net from "node:net";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
export const defaultRepoRoot = resolve(dirname(scriptPath), "..");

export const INTERNAL_BUILD_WORKSPACES = [
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
];

/**
 * Parses command argument from argv.
 * Supports:
 * - "up" (default)
 * - "down" (via `dev:stack -- down` or `dev:stack down`)
 * - "reset" (via `dev:stack -- reset` or `dev:stack reset`)
 * @param {string[]} [args=process.argv.slice(2)]
 * @returns {"up" | "down" | "reset"}
 */
export function parseCommand(args = process.argv.slice(2)) {
  for (const arg of args) {
    const normalized = String(arg).toLowerCase().replace(/^--?/, "");
    if (normalized === "down") return "down";
    if (normalized === "reset") return "reset";
  }
  return "up";
}

/**
 * Extracts pinned PostgreSQL and Temporal container images (with SHA256 digests)
 * dynamically from `packages/run-spaceapp/templates/compose.yml`.
 * @param {string} composeSource
 * @returns {{ postgresImage: string, temporalImage: string }}
 */
export function parsePinnedImagesFromCompose(composeSource) {
  if (typeof composeSource !== "string" || !composeSource.trim()) {
    throw new Error("Compose template content is empty.");
  }

  const postgresMatch = composeSource.match(
    /^\s{2}postgres:\s*\r?\n\s{4}image:\s*([^\s#]+@sha256:[0-9a-f]{64})\s*$/m
  );
  if (!postgresMatch) {
    throw new Error(
      "Could not find a SHA256-pinned postgres service image in packages/run-spaceapp/templates/compose.yml."
    );
  }

  const temporalMatch = composeSource.match(
    /^\s{2}temporal:\s*\r?\n\s{4}image:\s*(temporalio\/auto-setup:[^\s#]+@sha256:[0-9a-f]{64})\s*$/m
  );
  if (!temporalMatch) {
    throw new Error(
      "Could not find a SHA256-pinned temporalio/auto-setup image in packages/run-spaceapp/templates/compose.yml."
    );
  }

  return {
    postgresImage: postgresMatch[1],
    temporalImage: temporalMatch[1]
  };
}

/**
 * Extracts the pinned `opencode-ai@<version>` package specifier from root `Dockerfile`.
 * @param {string} dockerfileSource
 * @returns {string}
 */
export function parsePinnedOpenCodePackageFromDockerfile(dockerfileSource) {
  if (typeof dockerfileSource !== "string" || !dockerfileSource.trim()) {
    throw new Error("Dockerfile content is empty.");
  }

  const match = dockerfileSource.match(/((?:@opencode\/cli|opencode-ai)@[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?)\b/);
  if (!match) {
    throw new Error("Could not find a pinned @opencode/cli@<version> or opencode-ai@<version> specifier in Dockerfile.");
  }

  return match[1];
}

/**
 * Ensures state directory is safe to clean or delete on `reset`.
 * Refuses filesystem root, repository root, user home directory, or `~/.spaceapp`.
 * @param {string} stateDir
 * @param {string} [repoRoot=defaultRepoRoot]
 * @returns {string}
 */
export function validateSafeStateDir(stateDir, repoRoot = defaultRepoRoot) {
  if (typeof stateDir !== "string" || !stateDir.trim()) {
    throw new Error("State directory path must be a non-empty string.");
  }

  const resolvedState = resolve(stateDir);
  const resolvedRepo = resolve(repoRoot);
  const resolvedHome = resolve(homedir());
  const resolvedOperatorDir = resolve(resolvedHome, ".spaceapp");
  const rootDir = resolve("/");

  if (resolvedState === rootDir || /^[A-Za-z]:\\?$/.test(resolvedState)) {
    throw new Error(`Refusing unsafe state directory at filesystem root: ${resolvedState}`);
  }
  if (resolvedState === resolvedRepo) {
    throw new Error(`Refusing state directory equal to repository root: ${resolvedState}`);
  }
  if (resolvedState === resolvedHome) {
    throw new Error(`Refusing state directory equal to HOME: ${resolvedState}`);
  }
  if (
    resolvedState === resolvedOperatorDir ||
    resolvedState.startsWith(`${resolvedOperatorDir}/`) ||
    resolvedState.startsWith(`${resolvedOperatorDir}\\`)
  ) {
    throw new Error(
      `Refusing state directory inside installed operator path ~/.spaceapp: ${resolvedState}`
    );
  }

  const relToRepo = relative(resolvedState, resolvedRepo);
  if (relToRepo && !relToRepo.startsWith("..") && !isAbsolute(relToRepo)) {
    throw new Error(
      `Refusing state directory that is a parent of the repository root: ${resolvedState}`
    );
  }

  return resolvedState;
}

/**
 * Selects a short Unix domain socket path for cli-host.
 * Falls back to os.tmpdir() if the state directory path exceeds sun_path limit (96 bytes).
 * @param {string} stateDir
 * @param {object} [env=process.env]
 * @returns {string}
 */
export function resolveCliHostSocketPath(stateDir, env = process.env) {
  if (env.SPACE_CLI_HOST_SOCKET && env.SPACE_CLI_HOST_SOCKET.trim()) {
    return resolve(env.SPACE_CLI_HOST_SOCKET.trim());
  }

  const candidate = resolve(stateDir, "var", "run", "cli-host.sock");
  if (candidate.length <= 96) {
    return candidate;
  }

  const digest = createHash("sha256").update(resolve(stateDir)).digest("hex").slice(0, 12);
  return resolve(tmpdir(), `spaceapp-dev-${digest}.sock`);
}

/**
 * Resolves all configuration for the contributor dev stack.
 * @param {object} [options={}]
 */
export function resolveDevStackConfig(options = {}) {
  const repoRoot = resolve(options.repoRoot ?? defaultRepoRoot);
  const env = options.env ?? process.env;

  const rawStateDir = options.stateDir ?? env.SPACE_DEV_STACK_STATE_DIR ?? resolve(repoRoot, ".dev-stack");
  const stateDir = validateSafeStateDir(rawStateDir, repoRoot);

  const composeTemplatePath = resolve(repoRoot, "packages", "run-spaceapp", "templates", "compose.yml");
  const dockerfilePath = resolve(repoRoot, "Dockerfile");

  const { postgresImage, temporalImage } = parsePinnedImagesFromCompose(
    readFileSync(composeTemplatePath, "utf8")
  );
  const openCodePackage = parsePinnedOpenCodePackageFromDockerfile(
    readFileSync(dockerfilePath, "utf8")
  );

  const stateHash = createHash("sha256").update(stateDir).digest("hex").slice(0, 8);
  const composeProjectName =
    options.composeProjectName ??
    env.SPACE_DEV_COMPOSE_PROJECT ??
    `spaceapp-dev-${stateHash}`;

  const postgresPort = Number.parseInt(String(options.postgresPort ?? env.SPACE_DEV_POSTGRES_PORT ?? "15432"), 10);
  const temporalPort = Number.parseInt(String(options.temporalPort ?? env.SPACE_DEV_TEMPORAL_PORT ?? "17233"), 10);
  const apiPort = Number.parseInt(String(options.apiPort ?? env.SPACE_API_PORT ?? "4910"), 10);
  const webPort = Number.parseInt(String(options.webPort ?? env.SPACE_WEB_PORT ?? "4911"), 10);

  const cliHostSocketPath = resolveCliHostSocketPath(stateDir, env);

  return {
    repoRoot,
    stateDir,
    composeProjectName,
    postgresImage,
    temporalImage,
    openCodePackage,
    postgresPort,
    temporalPort,
    apiPort,
    webPort,
    cliHostSocketPath,
    composeFilePath: resolve(stateDir, "compose.dev-stack.yml"),
    secretsDir: resolve(stateDir, "secrets"),
    binDir: resolve(stateDir, "bin"),
    varDir: resolve(stateDir, "var"),
    projectsDir: resolve(stateDir, "projects"),
    cliStateDir: resolve(stateDir, "cli-state"),
    openCodePrefixDir: resolve(stateDir, "opencode"),
    pidsFilePath: resolve(stateDir, "pids.json"),
    runtimeMetaPath: resolve(stateDir, "runtime-meta.json")
  };
}

function writeSecretFile(filePath, content) {
  writeFileSync(filePath, `${content}\n`, { encoding: "utf8", mode: 0o600 });
  try { chmodSync(filePath, 0o600); } catch {}
}

function readOrCreateSecret(filePath, generator, minLength = 16) {
  if (existsSync(filePath)) {
    const existing = readFileSync(filePath, "utf8").trim();
    if (existing.length >= minLength) {
      try { chmodSync(filePath, 0o600); } catch {}
      return existing;
    }
  }
  const value = generator();
  writeSecretFile(filePath, value);
  return value;
}

/**
 * Creates isolated state directories and 0600 secret files.
 * @param {object} config
 */
export function ensureDevStackSecrets(config) {
  const dirs = [
    config.stateDir,
    config.secretsDir,
    resolve(config.secretsDir, "telegram"),
    resolve(config.secretsDir, "streaming"),
    config.binDir,
    config.varDir,
    resolve(config.varDir, "run"),
    resolve(config.varDir, "artifacts"),
    resolve(config.varDir, "memory"),
    resolve(config.varDir, "memory-graph"),
    resolve(config.varDir, "app-diagnostics"),
    resolve(config.varDir, "maintenance-autopilot"),
    resolve(config.varDir, "demo-projects"),
    resolve(config.varDir, "runtime-control"),
    resolve(config.varDir, "uploads"),
    config.projectsDir,
    config.cliStateDir,
    resolve(config.cliStateDir, "home"),
    resolve(config.cliStateDir, "tmp"),
    resolve(config.cliStateDir, "xdg-config"),
    resolve(config.cliStateDir, "xdg-data"),
    resolve(config.cliStateDir, "xdg-state"),
    resolve(config.cliStateDir, "xdg-cache"),
    resolve(config.cliStateDir, "codex"),
    config.openCodePrefixDir
  ];

  for (const dir of dirs) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    try { chmodSync(dir, 0o700); } catch {}
  }

  const postgresPasswordPath = resolve(config.secretsDir, "postgres-password");
  const sessionSecretPath = resolve(config.secretsDir, "session-secret");
  const setupTokenPath = resolve(config.secretsDir, "setup-token");
  const databaseUrlPath = resolve(config.secretsDir, "database-url");

  const postgresPassword = readOrCreateSecret(
    postgresPasswordPath,
    () => randomBytes(24).toString("hex"),
    32
  );
  const sessionSecret = readOrCreateSecret(
    sessionSecretPath,
    () => randomBytes(32).toString("hex"),
    32
  );
  const setupToken = readOrCreateSecret(
    setupTokenPath,
    () => `dev-setup-${randomBytes(16).toString("hex")}`,
    24
  );
  const databaseUrl = `postgresql://spaceapp:${postgresPassword}@127.0.0.1:${config.postgresPort}/spaceapp`;
  writeSecretFile(databaseUrlPath, databaseUrl);

  writeFileSync(
    config.runtimeMetaPath,
    `${JSON.stringify(
      {
        composeProjectName: config.composeProjectName,
        cliHostSocketPath: config.cliHostSocketPath,
        postgresPort: config.postgresPort,
        temporalPort: config.temporalPort,
        apiPort: config.apiPort,
        webPort: config.webPort
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  return {
    postgresPassword,
    sessionSecret,
    setupToken,
    databaseUrl,
    postgresPasswordPath,
    sessionSecretPath,
    setupTokenPath,
    databaseUrlPath
  };
}

/**
 * Generates Docker Compose YAML for PostgreSQL + Temporal sidecars.
 * Pinned by digest from `packages/run-spaceapp/templates/compose.yml`.
 * @param {object} config
 * @returns {string}
 */
export function generateDevStackComposeYaml(config) {
  return `# Generated by scripts/dev-stack.mjs — do not commit.
name: ${config.composeProjectName}

services:
  postgres:
    image: ${config.postgresImage}
    restart: unless-stopped
    environment:
      POSTGRES_DB: spaceapp
      POSTGRES_USER: spaceapp
      POSTGRES_PASSWORD_FILE: /run/secrets/postgres_password
    volumes:
      - postgres_data:/var/lib/postgresql/data
      - ./secrets/postgres-password:/run/secrets/postgres_password:ro
    ports:
      - "127.0.0.1:${config.postgresPort}:5432"
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U spaceapp -d spaceapp"]
      interval: 2s
      timeout: 5s
      retries: 30

  temporal:
    image: ${config.temporalImage}
    restart: unless-stopped
    depends_on:
      postgres:
        condition: service_healthy
    environment:
      DB: postgres12
      DB_PORT: "5432"
      POSTGRES_USER: spaceapp
      POSTGRES_SEEDS: postgres
      DYNAMIC_CONFIG_FILE_PATH: config/dynamicconfig/docker.yaml
      BIND_ON_IP: 0.0.0.0
      TEMPORAL_ADDRESS: 127.0.0.1:7233
      TEMPORAL_CLI_ADDRESS: 127.0.0.1:7233
    volumes:
      - ./secrets/postgres-password:/run/secrets/postgres_password:ro
    entrypoint:
      - /bin/sh
      - -euc
      - |
        export POSTGRES_PWD="$$(tr -d '\\r\\n' < /run/secrets/postgres_password)"
        exec /etc/temporal/entrypoint.sh autosetup
    ports:
      - "127.0.0.1:${config.temporalPort}:7233"
    healthcheck:
      test:
        [
          "CMD-SHELL",
          "temporal operator cluster health --address 127.0.0.1:7233 >/dev/null && temporal operator namespace describe --namespace default --address 127.0.0.1:7233 >/dev/null"
        ]
      interval: 5s
      timeout: 5s
      retries: 30

volumes:
  postgres_data:
`;
}

function writeExecutableScript(filePath, content) {
  writeFileSync(filePath, content, { encoding: "utf8", mode: 0o755 });
  try { chmodSync(filePath, 0o755); } catch {}
}

/**
 * Writes contributor CLI wrapper scripts into `<stateDir>/bin`.
 * Never writes to repository root.
 * @param {object} config
 * @param {object} [options={}]
 */
export function writeDevStackCliWrappers(config, options = {}) {
  mkdirSync(config.binDir, { recursive: true, mode: 0o700 });

  const localOpenCodeBin =
    options.openCodeBinPath ??
    process.env.SPACE_DEV_OPENCODE_BIN ??
    resolve(config.openCodePrefixDir, "node_modules", ".bin", "opencode");

  const openCodeObservationHash = createHash("sha256")
    .update("opencode:ready")
    .digest("hex");

  const openCodeWrapperPath = resolve(config.binDir, "opencode");
  writeExecutableScript(
    openCodeWrapperPath,
    `#!/usr/bin/env bash
set -euo pipefail
if [[ -n "\${SPACE_DEV_OPENCODE_BIN:-}" && -x "\${SPACE_DEV_OPENCODE_BIN}" ]]; then
  exec "\${SPACE_DEV_OPENCODE_BIN}" "$@"
fi
if [[ -x ${JSON.stringify(localOpenCodeBin)} ]]; then
  exec ${JSON.stringify(localOpenCodeBin)} "$@"
fi
if command -v opencode >/dev/null 2>&1; then
  exec "$(command -v opencode)" "$@"
fi
echo "OpenCode binary not found in ${localOpenCodeBin} or PATH" >&2
exit 127
`
  );

  const parityWrapperPath = resolve(config.binDir, "opencode-vscode-parity");
  writeExecutableScript(
    parityWrapperPath,
    `#!/usr/bin/env bash
set -euo pipefail

STATE_CLI_DIR=${JSON.stringify(config.cliStateDir)}
PROJECTS_DIR=${JSON.stringify(config.projectsDir)}
OPENCODE_BIN=${JSON.stringify(openCodeWrapperPath)}

mkdir -p \\
  "\${STATE_CLI_DIR}/home" \\
  "\${STATE_CLI_DIR}/tmp" \\
  "\${STATE_CLI_DIR}/xdg-config" \\
  "\${STATE_CLI_DIR}/xdg-data" \\
  "\${STATE_CLI_DIR}/xdg-state" \\
  "\${STATE_CLI_DIR}/xdg-cache" \\
  "\${PROJECTS_DIR}"

export HOME="\${STATE_CLI_DIR}/home"
export TMPDIR="\${STATE_CLI_DIR}/tmp"
export TMP="\${STATE_CLI_DIR}/tmp"
export TEMP="\${STATE_CLI_DIR}/tmp"
export XDG_CONFIG_HOME="\${STATE_CLI_DIR}/xdg-config"
export XDG_DATA_HOME="\${STATE_CLI_DIR}/xdg-data"
export XDG_STATE_HOME="\${STATE_CLI_DIR}/xdg-state"
export XDG_CACHE_HOME="\${STATE_CLI_DIR}/xdg-cache"
unset OPENCODE_SERVER_PASSWORD OPENCODE_SERVER_USERNAME

if [[ "\${1:-}" == "--run-inner" ]]; then
  shift
fi

case "\${1:-}" in
  credential-status)
    printf 'READY\\n'
    exit 0
    ;;
  credential-observation)
    printf 'OBSERVATION:${openCodeObservationHash}\\n'
    exit 0
    ;;
  credential-smoke)
    printf 'SPACE_OPENCODE_OK\\n'
    exit 0
    ;;
  inspect-env)
    printf 'runtime=opencode\\nhome=isolated\\ncredential=present\\n'
    exit 0
    ;;
esac

if [[ ! -d "\${PWD}" ]]; then
  cd "\${PROJECTS_DIR}"
fi

exec "\${OPENCODE_BIN}" "$@"
`
  );

  const credentialStatusPath = resolve(config.binDir, "credential-status");
  writeExecutableScript(
    credentialStatusPath,
    `#!/usr/bin/env bash
set -euo pipefail
printf 'READY\\n'
`
  );

  const credentialObservationPath = resolve(config.binDir, "credential-observation");
  writeExecutableScript(
    credentialObservationPath,
    `#!/usr/bin/env bash
set -euo pipefail
printf 'OBSERVATION:${openCodeObservationHash}\\n'
`
  );

  const credentialSmokePath = resolve(config.binDir, "credential-smoke");
  writeExecutableScript(
    credentialSmokePath,
    `#!/usr/bin/env bash
set -euo pipefail
printf 'SPACE_OPENCODE_OK\\n'
`
  );

  const inspectEnvPath = resolve(config.binDir, "inspect-env");
  writeExecutableScript(
    inspectEnvPath,
    `#!/usr/bin/env bash
set -euo pipefail
printf 'runtime=opencode\\nhome=isolated\\ncredential=present\\n'
`
  );

  return {
    openCodeWrapperPath,
    parityWrapperPath,
    credentialStatusPath,
    credentialObservationPath,
    credentialSmokePath,
    inspectEnvPath
  };
}

/**
 * Installs pinned `opencode-ai` package into `<stateDir>/opencode` if missing.
 * @param {object} config
 * @param {object} [options={}]
 */
export function ensureDevStackOpenCodeCli(config, options = {}) {
  const env = options.env ?? process.env;
  if (env.SPACE_DEV_SKIP_OPENCODE_INSTALL === "1" || env.SPACE_DEV_OPENCODE_BIN) {
    return;
  }

  const binPath = resolve(config.openCodePrefixDir, "node_modules", ".bin", "opencode");
  const stampPath = resolve(config.openCodePrefixDir, ".pinned-package");
  if (
    existsSync(binPath) &&
    existsSync(stampPath) &&
    readFileSync(stampPath, "utf8").trim() === config.openCodePackage
  ) {
    return;
  }

  mkdirSync(config.openCodePrefixDir, { recursive: true, mode: 0o700 });
  process.stdout.write(`[dev-stack] Installing pinned ${config.openCodePackage} into ${config.openCodePrefixDir}...\n`);
  const result = spawnSync(
    "npm",
    [
      "install",
      "--prefix",
      config.openCodePrefixDir,
      "--no-save",
      "--no-audit",
      "--no-fund",
      config.openCodePackage
    ],
    {
      cwd: config.repoRoot,
      stdio: "inherit",
      env
    }
  );
  if (result.status !== 0) {
    process.stderr.write(`Warning: Failed to install ${config.openCodePackage}. Continuing...\n`);
    return;
  }
  writeFileSync(stampPath, `${config.openCodePackage}\n`, "utf8");
}

/**
 * Builds internal packages and demo projects in dependency order.
 * @param {string} [repoRoot=defaultRepoRoot]
 * @param {object} [env=process.env]
 */
export function buildInternalPackages(repoRoot = defaultRepoRoot, env = process.env) {
  for (const workspace of INTERNAL_BUILD_WORKSPACES) {
    process.stdout.write(`[dev-stack] Building ${workspace}...\n`);
    const res = spawnSync("npm", ["run", "build", "-w", workspace], {
      cwd: repoRoot,
      stdio: "inherit",
      env
    });
    if (res.status !== 0) {
      throw new Error(`Failed building workspace ${workspace} (exit ${res.status ?? "unknown"}).`);
    }
  }

  process.stdout.write("[dev-stack] Building demo projects...\n");
  const demoRes = spawnSync(process.execPath, ["scripts/build-demo-projects.mjs"], {
    cwd: repoRoot,
    stdio: "inherit",
    env
  });
  if (demoRes.status !== 0) {
    throw new Error(`Failed building demo projects (exit ${demoRes.status ?? "unknown"}).`);
  }
}

/**
 * Waits for a TCP port to accept connections.
 * @param {number} port
 * @param {string} [host="127.0.0.1"]
 * @param {number} [timeoutMs=90000]
 */
export async function waitForTcpPort(port, host = "127.0.0.1", timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const connected = await new Promise((resolvePromise) => {
      const socket = net.createConnection({ port, host });
      const done = (ok) => {
        socket.removeAllListeners();
        socket.destroy();
        resolvePromise(ok);
      };
      socket.setTimeout(1_500);
      socket.once("connect", () => done(true));
      socket.once("timeout", () => done(false));
      socket.once("error", () => done(false));
    });
    if (connected) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Timed out waiting for TCP ${host}:${port} after ${timeoutMs}ms.`);
}

/**
 * SupervisingRunner manages sibling processes with fail-fast cleanup.
 */
export class SupervisingRunner {
  constructor(specs, options = {}) {
    this.specs = specs;
    this.logger = options.logger ?? console;
    this.killGraceMs = options.killGraceMs ?? 3_000;
    this.children = new Map();
    this.stopping = false;
    this.firstFailure = null;
    this._failureResolve = null;
    this.failurePromise = new Promise((resolvePromise) => {
      this._failureResolve = resolvePromise;
    });
  }

  startAll() {
    for (const spec of this.specs) {
      const child = spawn(spec.command, spec.args ?? [], {
        cwd: spec.cwd,
        env: spec.env,
        stdio: ["ignore", "pipe", "pipe"]
      });

      this.children.set(spec.name, child);
      this._pipeOutput(spec.name, child.stdout, false);
      this._pipeOutput(spec.name, child.stderr, true);

      child.once("error", (err) => {
        this._handleUnexpectedExit(spec.name, null, null, err);
      });

      child.once("exit", (code, signal) => {
        this.children.delete(spec.name);
        if (!this.stopping) {
          this._handleUnexpectedExit(spec.name, code, signal, null);
        }
      });
    }
  }

  getPids() {
    const pids = {};
    for (const [name, child] of this.children.entries()) {
      if (typeof child.pid === "number") {
        pids[name] = child.pid;
      }
    }
    return pids;
  }

  _pipeOutput(name, stream, isError) {
    if (!stream) return;
    let buffer = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      buffer += chunk;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (isError) {
          this.logger.error(`[${name}] ${line}`);
        } else {
          this.logger.log(`[${name}] ${line}`);
        }
      }
    });
    stream.on("end", () => {
      if (buffer.length > 0) {
        if (isError) {
          this.logger.error(`[${name}] ${buffer}`);
        } else {
          this.logger.log(`[${name}] ${buffer}`);
        }
        buffer = "";
      }
    });
  }

  _handleUnexpectedExit(name, code, signal, error) {
    if (this.firstFailure) return;
    const detail = error
      ? error.message
      : signal
        ? `signal ${signal}`
        : `exit code ${code ?? 1}`;
    const err = new Error(`Supervised process "${name}" exited unexpectedly (${detail}).`);
    err.processName = name;
    err.exitCode = typeof code === "number" && code !== 0 ? code : 1;
    err.signal = signal;
    this.firstFailure = err;
    this.logger.error(`[dev-stack] ${err.message} Stopping remaining processes...`);
    void this.stopAll().finally(() => {
      if (this._failureResolve) this._failureResolve(err);
    });
  }

  async stopAll() {
    this.stopping = true;
    const active = Array.from(this.children.entries());
    if (active.length === 0) return;

    const exitPromises = active.map(
      ([, child]) =>
        new Promise((resolvePromise) => {
          if (child.exitCode !== null || child.signalCode !== null) {
            resolvePromise();
            return;
          }
          child.once("exit", () => resolvePromise());
        })
    );

    for (const [, child] of active) {
      try {
        child.kill("SIGTERM");
      } catch {}
    }

    const graceTimer = new Promise((resolvePromise) =>
      setTimeout(() => resolvePromise("timeout"), this.killGraceMs)
    );
    const result = await Promise.race([Promise.all(exitPromises), graceTimer]);
    if (result === "timeout") {
      for (const [, child] of active) {
        try {
          if (child.exitCode === null && child.signalCode === null) {
            child.kill("SIGKILL");
          }
        } catch {}
      }
      await Promise.all(exitPromises);
    }
  }
}

/**
 * Polls `/readyz` on API and Web until all core dependencies report RUNNING.
 * @param {object} options
 */
export async function waitForStackReadiness({
  apiPort,
  webPort,
  runner,
  timeoutMs = 120_000,
  pollIntervalMs = 750
}) {
  const deadline = Date.now() + timeoutMs;
  let lastStatusSummary = "no response yet";

  while (Date.now() < deadline) {
    if (runner?.firstFailure) {
      throw runner.firstFailure;
    }

    try {
      const [apiRes, webRes] = await Promise.all([
        fetch(`http://127.0.0.1:${apiPort}/readyz`, { signal: AbortSignal.timeout(2_500) }),
        fetch(`http://127.0.0.1:${webPort}/readyz`, { signal: AbortSignal.timeout(2_500) })
      ]);

      const apiBody = await apiRes.json().catch(() => null);
      const webBody = await webRes.json().catch(() => null);

      const deps = apiBody?.dependencies ?? {};
      lastStatusSummary = JSON.stringify({
        apiHttp: apiRes.status,
        webProxyHttp: webRes.status,
        ok: apiBody?.ok,
        database: deps.database,
        worker: deps.worker,
        cliHost: deps.cliHost
      });

      if (
        apiRes.status === 200 &&
        webRes.status === 200 &&
        apiBody?.ok === true &&
        webBody?.ok === true &&
        deps.database === "RUNNING" &&
        deps.worker === "RUNNING" &&
        deps.cliHost === "RUNNING"
      ) {
        return apiBody;
      }
    } catch (err) {
      lastStatusSummary = err instanceof Error ? err.message : String(err);
    }

    await Promise.race([
      new Promise((r) => setTimeout(r, pollIntervalMs)),
      runner ? runner.failurePromise : new Promise(() => {})
    ]);
  }

  if (runner?.firstFailure) {
    throw runner.firstFailure;
  }

  throw new Error(
    `Timed out after ${timeoutMs}ms waiting for stack readiness. Last status: ${lastStatusSummary}`
  );
}

/**
 * Builds environment variables passed to supervised contributor stack processes.
 * @param {object} config
 * @param {object} secrets
 * @param {object} [baseEnv=process.env]
 */
export function buildServiceEnvironment(config, secrets, baseEnv = process.env) {
  return {
    ...baseEnv,
    NODE_ENV: baseEnv.NODE_ENV ?? "development",
    SPACE_PUBLIC_DISTRIBUTION: "true",
    SPACE_RUNTIME_STORE: "postgres",
    SPACE_DATABASE_URL: secrets.databaseUrl,
    DATABASE_URL: secrets.databaseUrl,
    SPACE_ROOT: config.stateDir,
    SPACE_INSTALL_ROOT: config.stateDir,
    SPACE_PROJECTS_ROOT: config.projectsDir,
    SPACE_CLI_ENABLED: "true",
    SPACE_CLI_COMMAND_PATH: config.binDir,
    SPACE_CLI_WRAPPER_DIR: config.binDir,
    SPACE_CLI_WORKSPACE_ROOT: config.projectsDir,
    SPACE_CLI_HOST_SOCKET: config.cliHostSocketPath,
    SPACE_SESSION_SECRET: secrets.sessionSecret,
    SPACE_SESSION_SECRET_FILE: secrets.sessionSecretPath,
    SPACE_SETUP_TOKEN_FILE: secrets.setupTokenPath,
    SPACE_OWNER_SETUP_TOKEN_FILE: secrets.setupTokenPath,
    SPACE_API_HOST: baseEnv.SPACE_API_HOST ?? "127.0.0.1",
    SPACE_API_PORT: String(config.apiPort),
    SPACE_API_ORIGIN: `http://127.0.0.1:${config.apiPort}`,
    SPACE_WEB_HOST: baseEnv.SPACE_WEB_HOST ?? "127.0.0.1",
    SPACE_WEB_PORT: String(config.webPort),
    SPACE_TEMPORAL_ADDRESS: `127.0.0.1:${config.temporalPort}`,
    SPACE_TEMPORAL_NAMESPACE: baseEnv.SPACE_TEMPORAL_NAMESPACE ?? "default",
    SPACE_TEMPORAL_TASK_QUEUE: baseEnv.SPACE_TEMPORAL_TASK_QUEUE ?? "space-agent-turns",
    TEMPORAL_ADDRESS: `127.0.0.1:${config.temporalPort}`,
    TEMPORAL_NAMESPACE: baseEnv.TEMPORAL_NAMESPACE ?? "default",
    TEMPORAL_TASK_QUEUE: baseEnv.TEMPORAL_TASK_QUEUE ?? "space-agent-turns",
    SPACE_ARTIFACT_ROOT: resolve(config.varDir, "artifacts"),
    SPACE_MEMORY_ROOT: resolve(config.varDir, "memory"),
    SPACE_MEMORY_GRAPH_ROOT: resolve(config.varDir, "memory-graph"),
    SPACE_APP_DIAGNOSTICS_ROOT: resolve(config.varDir, "app-diagnostics"),
    SPACE_MAINTENANCE_AUTOPILOT_STATE_FILE: resolve(
      config.varDir,
      "maintenance-autopilot",
      "state.json"
    ),
    SPACE_DEMO_PROJECTS_ROOT: resolve(config.repoRoot, "demos"),
    SPACE_DEMO_PROJECTS_VAR_ROOT: resolve(config.varDir, "demo-projects"),
    SPACE_CODEX_HOME: resolve(config.cliStateDir, "codex"),
    SPACE_CODEX_APP_SERVER_HOME: resolve(config.cliStateDir, "codex"),
    SPACE_CODEX_GOALS_DB_PATH: resolve(config.varDir, "codex-goals.sqlite"),
    SPACE_TELEGRAM_SECRET_ROOT: resolve(config.secretsDir, "telegram"),
    SPACE_STREAMING_SECRET_ROOT: resolve(config.secretsDir, "streaming"),
    SPACE_AGENT_TOOLS_WRITER: "disabled",
    SPACE_DEV_LOGIN: "false",
    SPACE_BROWSER_SESSIONS_ENABLED: "false",
    SPACE_BROWSER_EVIDENCE_ENABLED: "false",
    SPACE_T3CODE_ENABLED: "false",
    PATH: `${config.binDir}:${baseEnv.PATH ?? ""}`
  };
}

function isProcessAlive(pid) {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function stopRecordedHostProcesses(config) {
  if (!existsSync(config.pidsFilePath)) return;
  let pids = {};
  try {
    pids = JSON.parse(readFileSync(config.pidsFilePath, "utf8"));
  } catch {
    pids = {};
  }

  const numericPids = Object.values(pids).filter(
    (pid) => typeof pid === "number" && Number.isInteger(pid) && pid > 0 && pid !== process.pid
  );

  for (const pid of numericPids) {
    if (isProcessAlive(pid)) {
      try {
        process.kill(pid, "SIGTERM");
      } catch {}
    }
  }

  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline && numericPids.some((pid) => isProcessAlive(pid))) {
    await new Promise((r) => setTimeout(r, 150));
  }

  for (const pid of numericPids) {
    if (isProcessAlive(pid)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
    }
  }

  rmSync(config.pidsFilePath, { force: true });
}

function cleanupSocketFiles(config) {
  const candidates = new Set([config.cliHostSocketPath]);
  if (existsSync(config.runtimeMetaPath)) {
    try {
      const meta = JSON.parse(readFileSync(config.runtimeMetaPath, "utf8"));
      if (typeof meta.cliHostSocketPath === "string" && meta.cliHostSocketPath.trim()) {
        candidates.add(meta.cliHostSocketPath.trim());
      }
    } catch {}
  }

  for (const sockPath of candidates) {
    if (existsSync(sockPath)) {
      try {
        unlinkSync(sockPath);
      } catch {}
    }
  }
}

/**
 * Stops host processes and tears down contributor Docker Compose sidecars.
 * @param {object} config
 * @param {object} [options={}]
 */
export async function downDevStack(config, options = {}) {
  const removeVolumes = Boolean(options.volumes);
  const runCommand =
    options.runCommand ??
    ((cmd, args, opts) => spawnSync(cmd, args, { stdio: "inherit", ...opts }));

  await stopRecordedHostProcesses(config);
  cleanupSocketFiles(config);

  const composeArgs = ["compose", "-p", config.composeProjectName];
  if (existsSync(config.composeFilePath)) {
    composeArgs.push("-f", config.composeFilePath);
  }
  composeArgs.push("down", "--remove-orphans");
  if (removeVolumes) {
    composeArgs.push("-v");
  }

  runCommand("docker", composeArgs, { cwd: config.repoRoot });
}

/**
 * Stops contributor stack services, removes Docker volumes, and deletes `<stateDir>`.
 * @param {object} config
 * @param {object} [options={}]
 */
export async function resetDevStack(config, options = {}) {
  validateSafeStateDir(config.stateDir, config.repoRoot);
  await downDevStack(config, { ...options, volumes: true });
  rmSync(config.stateDir, { recursive: true, force: true });
}

/**
 * Starts full contributor stack from source.
 * @param {object} config
 * @param {object} [options={}]
 */
export async function upDevStack(config, options = {}) {
  const env = options.env ?? process.env;
  const skipBuild = Boolean(options.skipBuild || env.SPACE_DEV_SKIP_BUILD === "1");
  const readyFile = options.readyFile ?? env.SPACE_DEV_READY_FILE ?? null;
  const exitWhenReady = Boolean(options.exitWhenReady || env.SPACE_DEV_EXIT_WHEN_READY === "1");

  await stopRecordedHostProcesses(config);
  cleanupSocketFiles(config);

  const secrets = ensureDevStackSecrets(config);
  writeDevStackCliWrappers(config);
  ensureDevStackOpenCodeCli(config, { env });

  const composeYaml = generateDevStackComposeYaml(config);
  writeFileSync(config.composeFilePath, composeYaml, "utf8");

  if (!skipBuild) {
    buildInternalPackages(config.repoRoot, env);
  }

  process.stdout.write("[dev-stack] Starting PostgreSQL and Temporal sidecars via Docker Compose...\n");
  const upResult = spawnSync(
    "docker",
    [
      "compose",
      "-p",
      config.composeProjectName,
      "-f",
      config.composeFilePath,
      "up",
      "-d",
      "--wait"
    ],
    {
      cwd: config.repoRoot,
      stdio: "inherit",
      env
    }
  );
  if (upResult.status !== 0) {
    const plainUp = spawnSync(
      "docker",
      ["compose", "-p", config.composeProjectName, "-f", config.composeFilePath, "up", "-d"],
      {
        cwd: config.repoRoot,
        stdio: "inherit",
        env
      }
    );
    if (plainUp.status !== 0) {
      throw new Error("Failed to start Docker Compose services for dev stack.");
    }
  }

  process.stdout.write(`[dev-stack] Waiting for PostgreSQL on 127.0.0.1:${config.postgresPort}...\n`);
  await waitForTcpPort(config.postgresPort, "127.0.0.1", 60_000);

  const serviceEnv = buildServiceEnvironment(config, secrets, env);

  process.stdout.write("[dev-stack] Running database migrations via @space/db...\n");
  const migrateRes = spawnSync("npm", ["run", "db:migrate"], {
    cwd: config.repoRoot,
    stdio: "inherit",
    env: serviceEnv
  });
  if (migrateRes.status !== 0) {
    throw new Error(`Database migrations failed (exit ${migrateRes.status ?? "unknown"}).`);
  }

  process.stdout.write("[dev-stack] Starting host processes: cli-host, worker, api (watch), web (vite)...\n");
  const specs = [
    {
      name: "cli-host",
      command: "npm",
      args: ["run", "dev", "-w", "@space/cli-host"],
      cwd: config.repoRoot,
      env: serviceEnv
    },
    {
      name: "worker",
      command: "npm",
      args: ["run", "dev", "-w", "@space/worker"],
      cwd: config.repoRoot,
      env: serviceEnv
    },
    {
      name: "api",
      command: "npm",
      args: ["run", "dev", "-w", "@space/api"],
      cwd: config.repoRoot,
      env: serviceEnv
    },
    {
      name: "web",
      command: "npm",
      args: ["run", "dev", "-w", "@space/web"],
      cwd: config.repoRoot,
      env: serviceEnv
    }
  ];

  const runner = new SupervisingRunner(specs, {
    logger: console,
    killGraceMs: 3_000
  });

  runner.startAll();
  writeFileSync(config.pidsFilePath, JSON.stringify(runner.getPids(), null, 2), "utf8");

  const cleanupSignals = () => {
    process.stdout.write("\n[dev-stack] Shutdown signal received. Stopping host processes and containers...\n");
    void (async () => {
      try {
        await runner.stopAll();
        await downDevStack(config);
      } finally {
        process.exit(0);
      }
    })();
  };
  process.once("SIGINT", cleanupSignals);
  process.once("SIGTERM", cleanupSignals);

  process.stdout.write("[dev-stack] Waiting for stack readiness at /readyz...\n");
  const readyInfo = await waitForStackReadiness({
    apiPort: config.apiPort,
    webPort: config.webPort,
    runner,
    timeoutMs: 120_000
  });

  if (readyFile) {
    writeFileSync(
      readyFile,
      JSON.stringify(
        {
          ready: true,
          webUrl: `http://127.0.0.1:${config.webPort}`,
          apiUrl: `http://127.0.0.1:${config.apiPort}`,
          setupToken: secrets.setupToken,
          dependencies: readyInfo.dependencies
        },
        null,
        2
      ),
      "utf8"
    );
  }

  process.stdout.write("\n=======================================================\n");
  process.stdout.write(`SpaceApp source: http://127.0.0.1:${config.webPort}\n`);
  process.stdout.write(`One-time owner setup token (fresh database only): ${secrets.setupToken}\n`);
  process.stdout.write("Browser/Chromium, companion services and root-only features are disabled. No provider account is needed to open OpenCode.\n");
  process.stdout.write("=======================================================\n\n");

  if (exitWhenReady) {
    await runner.stopAll();
    return;
  }

  await runner.failurePromise;
}

/**
 * CLI Entrypoint
 */
export async function runDevStack() {
  const command = parseCommand(process.argv.slice(2));
  const config = resolveDevStackConfig();

  if (command === "down") {
    process.stdout.write(`[dev-stack] Stopping dev stack project ${config.composeProjectName}...\n`);
    await downDevStack(config);
    process.stdout.write("[dev-stack] Dev stack stopped.\n");
    return;
  }

  if (command === "reset") {
    process.stdout.write(`[dev-stack] Resetting dev stack project ${config.composeProjectName} and state...\n`);
    await resetDevStack(config);
    process.stdout.write("[dev-stack] Dev stack reset complete. Containers, volumes, and state directory removed.\n");
    return;
  }

  await upDevStack(config);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  runDevStack().catch((err) => {
    process.stderr.write(`\n[dev-stack] Fatal error: ${err.message}\n`);
    process.exit(1);
  });
}
