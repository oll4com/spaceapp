#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import net from "node:net";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export const DEFAULT_PORTS = Object.freeze({
  webPort: 5911,
  apiPort: 5910,
  postgresPort: 55432,
  temporalPort: 57233
});

export const PACKAGE_BUILD_ORDER = Object.freeze([
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

export const CLI_WRAPPER_RUNTIMES = Object.freeze([
  "opencode",
  "codex",
  "claude",
  "gemini",
  "qwen",
  "kimi",
  "grok",
  "deepseek",
  "autohand",
  "cursor",
  "copilot",
  "hermes"
]);

export function resolveRepoRoot(fromUrl = import.meta.url) {
  return path.resolve(path.dirname(fileURLToPath(fromUrl)), "..");
}

export function resolveStatePaths(repoRoot, env = process.env) {
  const configured = env.SPACE_DEV_STATE_DIR?.trim();
  const stateDir = configured
    ? path.resolve(repoRoot, configured)
    : path.join(repoRoot, ".dev-stack");
  const runtimeDir = path.join(stateDir, "runtime");
  const candidateSocket = path.join(runtimeDir, "cli-host.sock");
  const hashSuffix = createHash("sha256").update(stateDir).digest("hex").slice(0, 10);
  const useShortSocket =
    !candidateSocket.startsWith("/") || Buffer.byteLength(candidateSocket, "utf8") > 92;
  const cliHostSocketDir = useShortSocket ? `/tmp/spaceapp-dev-${hashSuffix}` : runtimeDir;
  const cliHostSocketPath = useShortSocket
    ? `/tmp/spaceapp-dev-${hashSuffix}/cli-host.sock`
    : candidateSocket;

  return {
    stateDir,
    secretsDir: path.join(stateDir, "secrets"),
    logsDir: path.join(stateDir, "logs"),
    pidsDir: path.join(stateDir, "pids"),
    binDir: path.join(stateDir, "bin"),
    toolsDir: path.join(stateDir, "tools"),
    dataDir: path.join(stateDir, "data"),
    memoryDir: path.join(stateDir, "memory"),
    cliStateDir: path.join(stateDir, "cli-state"),
    workspacesDir: path.join(stateDir, "workspaces"),
    artifactsDir: path.join(stateDir, "artifacts"),
    runtimeDir,
    cliHostSocketDir,
    cliHostSocketPath,
    installRoot: path.join(stateDir, "install"),
    composePath: path.join(stateDir, "compose.yml"),
    stateFile: path.join(stateDir, "stack-state.json")
  };
}

function parsePort(value, fallback, envName) {
  if (value === undefined || value === "") {
    return fallback;
  }
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error(`${envName} must be an integer between 1 and 65535 (received: ${value})`);
  }
  return parsed;
}

export function resolvePorts(env = process.env) {
  const ports = {
    webPort: parsePort(env.SPACE_DEV_WEB_PORT, DEFAULT_PORTS.webPort, "SPACE_DEV_WEB_PORT"),
    apiPort: parsePort(env.SPACE_DEV_API_PORT, DEFAULT_PORTS.apiPort, "SPACE_DEV_API_PORT"),
    postgresPort: parsePort(
      env.SPACE_DEV_POSTGRES_PORT,
      DEFAULT_PORTS.postgresPort,
      "SPACE_DEV_POSTGRES_PORT"
    ),
    temporalPort: parsePort(
      env.SPACE_DEV_TEMPORAL_PORT,
      DEFAULT_PORTS.temporalPort,
      "SPACE_DEV_TEMPORAL_PORT"
    )
  };
  const seen = new Map();
  for (const [key, port] of Object.entries(ports)) {
    if (seen.has(port)) {
      throw new Error(`Duplicate host port ${port} configured for ${seen.get(port)} and ${key}`);
    }
    seen.set(port, key);
  }
  return ports;
}

export function resolveComposeProjectName(stateDir, env = process.env) {
  const explicit = env.SPACE_DEV_COMPOSE_PROJECT?.trim();
  if (explicit) {
    return explicit;
  }
  const suffix = createHash("sha256").update(stateDir).digest("hex").slice(0, 8);
  return `spaceapp-dev-${suffix}`;
}

export function parseComposeImages(composeText) {
  const postgresMatch = composeText.match(
    /^\s{2}postgres:\s*\r?\n(?:.*\r?\n)*?\s*image:\s*([^\s]+@sha256:[0-9a-f]{64})\b/m
  );
  const temporalMatch = composeText.match(
    /^\s{2}temporal:\s*\r?\n(?:.*\r?\n)*?\s*image:\s*(temporalio\/auto-setup:[^\s]+@sha256:[0-9a-f]{64})\b/m
  );
  if (!postgresMatch?.[1]) {
    throw new Error("Unable to locate digest-pinned postgres image in compose template");
  }
  if (!temporalMatch?.[1]) {
    throw new Error("Unable to locate digest-pinned temporal image in compose template");
  }
  return {
    postgresImage: postgresMatch[1],
    temporalImage: temporalMatch[1]
  };
}

export function parseOpenCodeSpec(dockerfileText) {
  const scopedMatch = dockerfileText.match(
    /(@opencode\/cli)@([0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?)\b/
  );
  if (scopedMatch?.[1] && scopedMatch?.[2]) {
    return { pkg: scopedMatch[1], version: scopedMatch[2] };
  }
  const legacyMatch =
    dockerfileText.match(/\b(opencode-ai)@([0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?)\b/) ??
    dockerfileText.match(/OPENCODE_VERSION="([^"]+)"/);
  if (legacyMatch?.[2]) {
    return { pkg: legacyMatch[1], version: legacyMatch[2] };
  }
  if (legacyMatch?.[1]) {
    return { pkg: "opencode-ai", version: legacyMatch[1] };
  }
  throw new Error("Unable to locate pinned OpenCode CLI version in Dockerfile");
}

export function parseOpenCodeVersion(dockerfileText) {
  return parseOpenCodeSpec(dockerfileText).version;
}

function writeSecretFile(filePath, value) {
  writeFileSync(filePath, `${value}\n`, { encoding: "utf8", mode: 0o600 });
  chmodSync(filePath, 0o600);
}

function readOrCreateSecret(filePath, byteLength = 24) {
  if (existsSync(filePath)) {
    const existing = readFileSync(filePath, "utf8").trim();
    if (existing.length > 0) {
      chmodSync(filePath, 0o600);
      return existing;
    }
  }
  const generated = randomBytes(byteLength).toString("hex");
  writeSecretFile(filePath, generated);
  return generated;
}

export function ensureSecrets(stateDir, ports = DEFAULT_PORTS) {
  const secretsDir = path.join(stateDir, "secrets");
  mkdirSync(secretsDir, { recursive: true, mode: 0o700 });
  chmodSync(secretsDir, 0o700);

  const postgresPasswordPath = path.join(secretsDir, "postgres-password");
  const sessionSecretPath = path.join(secretsDir, "session-secret");
  const setupTokenPath = path.join(secretsDir, "setup-token");
  const databaseUrlPath = path.join(secretsDir, "database-url");

  const alreadyInitialized =
    existsSync(postgresPasswordPath) && existsSync(sessionSecretPath);
  const postgresPassword = readOrCreateSecret(postgresPasswordPath, 24);
  const sessionSecret = readOrCreateSecret(sessionSecretPath, 32);
  const setupToken =
    !alreadyInitialized || existsSync(setupTokenPath)
      ? readOrCreateSecret(setupTokenPath, 24)
      : null;
  const databaseUrl = `postgresql://spaceapp:${postgresPassword}@127.0.0.1:${ports.postgresPort}/spaceapp`;
  writeSecretFile(databaseUrlPath, databaseUrl);

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

export function renderCompose({ paths, ports, images }) {
  const postgresSecretPath = paths.secretsDir
    ? path.join(paths.secretsDir, "postgres-password")
    : path.join(paths.stateDir, "secrets", "postgres-password");

  return [
    "services:",
    "  postgres:",
    `    image: ${images.postgresImage}`,
    "    restart: unless-stopped",
    "    environment:",
    "      POSTGRES_DB: spaceapp",
    "      POSTGRES_USER: spaceapp",
    "      POSTGRES_PASSWORD_FILE: /run/secrets/postgres-password",
    "    ports:",
    `      - "127.0.0.1:${ports.postgresPort}:5432"`,
    "    volumes:",
    "      - spaceapp-dev-postgres:/var/lib/postgresql/data",
    `      - ${JSON.stringify(`${postgresSecretPath}:/run/secrets/postgres-password:ro`)}`,
    "    healthcheck:",
    '      test: ["CMD-SHELL", "pg_isready -U spaceapp -d spaceapp"]',
    "      interval: 2s",
    "      timeout: 3s",
    "      retries: 30",
    "",
    "  temporal:",
    `    image: ${images.temporalImage}`,
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
    "    ports:",
    `      - "127.0.0.1:${ports.temporalPort}:7233"`,
    "    volumes:",
    `      - ${JSON.stringify(`${postgresSecretPath}:/run/secrets/postgres-password:ro`)}`,
    '    entrypoint: ["/bin/sh", "-ec"]',
    '    command: ["export POSTGRES_PWD=\\"$$(cat /run/secrets/postgres-password)\\"; exec /etc/temporal/entrypoint.sh autosetup"]',
    "    healthcheck:",
    '      test: ["CMD-SHELL", "addr=$$(hostname -i); addr=$${addr%% *}:7233; temporal operator cluster health --address $$addr >/dev/null && temporal operator namespace describe --namespace default --address $$addr >/dev/null"]',
    "      interval: 3s",
    "      timeout: 5s",
    "      retries: 40",
    "",
    "volumes:",
    "  spaceapp-dev-postgres:",
    ""
  ].join("\n");
}

export function renderOpenCodeWrapper(opencodeBin) {
  return [
    "#!/usr/bin/env sh",
    "set -eu",
    `exec ${JSON.stringify(opencodeBin)} "$@"`,
    ""
  ].join("\n");
}

export function renderCliParityWrapper({ cliStateDir, memoryDir, binDir }) {
  return [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    "",
    'runtime_name="$(basename "$0" -vscode-parity)"',
    `cli_state_root=${JSON.stringify(cliStateDir)}`,
    `memory_root=${JSON.stringify(memoryDir)}`,
    `bin_dir=${JSON.stringify(binDir)}`,
    'state_root="$cli_state_root/providers/$runtime_name"',
    'credential_root="$cli_state_root/imported-credentials"',
    'credential_file="$credential_root/$runtime_name.key"',
    "",
    'export PATH="$bin_dir:${PATH:-/usr/local/bin:/usr/bin:/bin}"',
    'export USER="$(id -un 2>/dev/null || echo spaceapp)"',
    'export LOGNAME="$USER"',
    'export HOME="$state_root"',
    'export TMPDIR="$state_root/tmp"',
    'export TEMP="$state_root/tmp"',
    'export TMP="$state_root/tmp"',
    "umask 077",
    "",
    'case "$runtime_name" in',
    "  opencode)",
    '    command_name="$bin_dir/opencode"',
    '    export XDG_CONFIG_HOME="$state_root/config"',
    '    export XDG_DATA_HOME="$state_root/data"',
    '    export XDG_CACHE_HOME="$state_root/cache"',
    '    export XDG_STATE_HOME="$state_root/state"',
    '    export OPENCODE_API_KEY="$(cat "$credential_file" 2>/dev/null || true)"',
    "    ;;",
    "  codex)",
    '    command_name="codex"',
    '    export CODEX_HOME="$state_root"',
    '    export OPENAI_API_KEY="$(cat "$credential_file" 2>/dev/null || true)"',
    "    ;;",
    "  claude)",
    '    command_name="claude"',
    '    export CLAUDE_CONFIG_DIR="$state_root"',
    '    export ANTHROPIC_API_KEY="$(cat "$credential_file" 2>/dev/null || true)"',
    "    export DISABLE_UPDATES=1",
    "    ;;",
    "  gemini)",
    '    command_name="gemini"',
    '    export GEMINI_CLI_HOME="$state_root"',
    '    export GEMINI_API_KEY="$(cat "$credential_file" 2>/dev/null || true)"',
    "    ;;",
    "  qwen)",
    '    command_name="qwen"',
    '    export QWEN_HOME="$state_root"',
    '    export QWEN_API_KEY="$(cat "$credential_file" 2>/dev/null || true)"',
    "    ;;",
    "  kimi)",
    '    command_name="kimi"',
    '    export KIMI_CODE_HOME="$state_root"',
    '    export KIMI_API_KEY="$(cat "$credential_file" 2>/dev/null || true)"',
    "    ;;",
    "  grok)",
    '    command_name="grok"',
    '    export GROK_HOME="$state_root"',
    '    export XAI_API_KEY="$(cat "$credential_file" 2>/dev/null || true)"',
    "    ;;",
    "  deepseek)",
    '    command_name="deepseek-cli"',
    '    export DEEPSEEK_HOME="$state_root"',
    '    export DEEPSEEK_API_KEY="$(cat "$credential_file" 2>/dev/null || true)"',
    "    ;;",
    "  autohand)",
    '    command_name="autohand"',
    '    export AUTOHAND_HOME="$state_root"',
    '    export AUTOHAND_API_KEY="$(cat "$credential_file" 2>/dev/null || true)"',
    "    ;;",
    "  cursor)",
    '    command_name="cursor-agent"',
    '    export CURSOR_CONFIG_DIR="$state_root"',
    '    export AGENT_CLI_CREDENTIAL_STORE="file"',
    "    ;;",
    "  copilot)",
    '    command_name="copilot"',
    '    export COPILOT_HOME="$state_root"',
    "    ;;",
    "  hermes)",
    '    command_name="hermes"',
    '    export HERMES_HOME="$state_root"',
    "    ;;",
    "  *)",
    '    echo "Unsupported SpaceApp CLI wrapper." >&2',
    "    exit 64",
    "    ;;",
    "esac",
    "",
    'if [ "${1:-}" = "--run-inner" ]; then',
    "  shift",
    "fi",
    "",
    "ensure_runtime_dirs() {",
    '  mkdir -p "$HOME" "$TMPDIR" "$credential_root"',
    '  chmod 0700 "$HOME" "$TMPDIR" "$credential_root"',
    '  if [ "$runtime_name" = "opencode" ]; then',
    '    mkdir -p "$XDG_CONFIG_HOME/opencode" "$XDG_DATA_HOME" "$XDG_CACHE_HOME" "$XDG_STATE_HOME"',
    '    if [ ! -f "$XDG_CONFIG_HOME/opencode/opencode.json" ]; then',
    '      cat > "$XDG_CONFIG_HOME/opencode/opencode.json" <<EOF',
    "{",
    '  "model": "opencode/big-pickle",',
    '  "permission": {',
    '    "external_directory": {',
    '      "*": "ask",',
    '      "$memory_root": "allow",',
    '      "$memory_root/*": "allow",',
    '      "$TMPDIR": "allow",',
    '      "$TMPDIR/*": "allow"',
    "    }",
    "  }",
    "}",
    "EOF",
    '      chmod 0600 "$XDG_CONFIG_HOME/opencode/opencode.json"',
    "    fi",
    "  fi",
    "}",
    "",
    "credential_ready() {",
    '  [ -s "$credential_file" ] && return 0',
    '  case "$runtime_name" in',
    '    opencode) [ -x "$command_name" ] || command -v opencode >/dev/null 2>&1 ;;',
    '    codex) [ -s "$state_root/auth.json" ] ;;',
    '    gemini) [ -s "$state_root/.gemini/oauth_creds.json" ] ;;',
    '    qwen) [ -s "$state_root/.qwen/oauth_creds.json" ] ;;',
    '    kimi) [ -s "$state_root/.kimi/credentials.json" ] ;;',
    '    grok) [ -s "$state_root/.grok/credentials.json" ] ;;',
    '    claude) [ -s "$state_root/.credentials.json" ] ;;',
    '    deepseek) [ -s "$credential_file" ] ;;',
    '    autohand) [ -s "$state_root/config.json" ] ;;',
    '    cursor) [ -s "$state_root/.config/cursor/auth.json" ] ;;',
    '    copilot) [ -s "$state_root/config.json" ] ;;',
    "    *) return 1 ;;",
    "  esac",
    "}",
    "",
    'case "${1:-}" in',
    "  credential-status)",
    "    if credential_ready; then",
    "      printf 'READY\\n'",
    "      exit 0",
    "    fi",
    "    printf 'NOT_READY\\n'",
    "    exit 1",
    "    ;;",
    "  credential-observation)",
    "    credential_ready || exit 1",
    "    printf 'OBSERVATION:%s\\n' \"$(printf '%s' \"$runtime_name:ready\" | sha256sum | cut -d ' ' -f 1)\"",
    "    exit 0",
    "    ;;",
    "  credential-smoke)",
    "    credential_ready || exit 1",
    "    ensure_runtime_dirs",
    "    printf '%s\\n' \"SPACE_$(printf '%s' \"$runtime_name\" | tr '[:lower:]' '[:upper:]')_OK\"",
    "    exit 0",
    "    ;;",
    "  inspect-env)",
    "    printf 'runtime=%s\\nhome=isolated\\ncredential=%s\\n' \\",
    '      "$runtime_name" "$(credential_ready && printf present || printf absent)"',
    "    exit 0",
    "    ;;",
    "esac",
    "",
    "ensure_runtime_dirs",
    'exec "$command_name" "$@"',
    ""
  ].join("\n");
}

export function ensureOpenCodeBinary(repoRoot, paths, { runCommand = spawnSync } = {}) {
  const dockerfilePath = path.join(repoRoot, "Dockerfile");
  const { pkg, version } = parseOpenCodeSpec(readFileSync(dockerfilePath, "utf8"));
  const installDir = path.join(paths.toolsDir, "opencode", version);
  const opencodeBin = path.join(installDir, "node_modules", ".bin", "opencode");

  mkdirSync(paths.binDir, { recursive: true, mode: 0o755 });
  mkdirSync(installDir, { recursive: true, mode: 0o755 });

  if (!existsSync(opencodeBin)) {
    console.log(`[dev:stack] Installing OpenCode CLI (${pkg}@${version}) into ${installDir}...`);
    const result = runCommand(
      "npm",
      [
        "install",
        "--prefix",
        installDir,
        "--no-save",
        "--no-audit",
        "--no-fund",
        `${pkg}@${version}`
      ],
      {
        cwd: repoRoot,
        stdio: "inherit",
        env: process.env
      }
    );
    if (result.status !== 0) {
      throw new Error(`Failed to install ${pkg}@${version} (exit ${result.status ?? "unknown"})`);
    }
  }

  const wrapperPath = path.join(paths.binDir, "opencode");
  writeFileSync(wrapperPath, renderOpenCodeWrapper(opencodeBin), {
    encoding: "utf8",
    mode: 0o755
  });
  chmodSync(wrapperPath, 0o755);

  const parityScript = renderCliParityWrapper({
    cliStateDir: paths.cliStateDir ?? path.join(paths.stateDir, "cli-state"),
    memoryDir: paths.memoryDir ?? path.join(paths.stateDir, "memory"),
    binDir: paths.binDir
  });
  for (const runtimeName of CLI_WRAPPER_RUNTIMES) {
    const parityPath = path.join(paths.binDir, `${runtimeName}-vscode-parity`);
    writeFileSync(parityPath, parityScript, {
      encoding: "utf8",
      mode: 0o755
    });
    chmodSync(parityPath, 0o755);
  }

  return { version, wrapperPath, opencodeBin };
}

export function ensureRuntimeDirectories(paths, repoRoot) {
  const dirs = [
    paths.stateDir,
    paths.logsDir,
    paths.pidsDir,
    paths.binDir,
    paths.toolsDir,
    paths.dataDir,
    paths.memoryDir,
    paths.cliStateDir,
    path.join(paths.cliStateDir, "providers"),
    path.join(paths.cliStateDir, "imported-credentials"),
    paths.workspacesDir,
    paths.artifactsDir,
    paths.runtimeDir,
    paths.cliHostSocketDir,
    paths.installRoot,
    path.join(paths.dataDir, "memory-graph"),
    path.join(paths.dataDir, "telegram"),
    path.join(paths.dataDir, "integrations", "telegram"),
    path.join(paths.dataDir, "streaming-secrets"),
    path.join(paths.dataDir, "app-diagnostics"),
    path.join(paths.dataDir, "maintenance-autopilot"),
    path.join(paths.dataDir, "cli-account-balancer"),
    path.join(paths.dataDir, "demo-projects"),
    path.join(paths.dataDir, "projects"),
    path.join(paths.dataDir, "dots")
  ];
  for (const dir of dirs) {
    if (!dir) continue;
    mkdirSync(dir, { recursive: true, mode: 0o755 });
  }
  if (repoRoot) {
    const starterMemoryRoot = path.join(repoRoot, "starter-memory");
    for (const fileName of [
      "gemini_history.md",
      "gemini_history_monthly.md",
      "installation-guide.md",
      "AGENTS.md"
    ]) {
      const src = path.join(starterMemoryRoot, fileName);
      const dest = path.join(paths.memoryDir, fileName);
      if (existsSync(src) && !existsSync(dest)) {
        copyFileSync(src, dest);
        chmodSync(dest, 0o600);
      }
    }
  }
}

export function buildServiceEnv({ repoRoot, paths, ports, secrets, baseEnv = process.env }) {
  const pathKey =
    Object.keys(baseEnv).find((key) => key.toUpperCase() === "PATH") ?? "PATH";
  const currentPath = baseEnv[pathKey] ?? "";
  const combinedPath = currentPath
    ? `${paths.binDir}${path.delimiter}${currentPath}`
    : paths.binDir;
  const memoryDir = paths.memoryDir ?? path.join(paths.stateDir, "memory");
  const cliStateDir = paths.cliStateDir ?? path.join(paths.stateDir, "cli-state");
  const cliHostSocketPath =
    paths.cliHostSocketPath ?? path.join(paths.runtimeDir, "cli-host.sock");

  return {
    ...baseEnv,
    [pathKey]: combinedPath,
    NODE_ENV: baseEnv.NODE_ENV ?? "development",
    SPACE_INSTANCE: "stable",
    SPACE_PUBLIC_DISTRIBUTION: "true",
    SPACE_RUNTIME_STORE: "postgres",
    SPACE_DEV_LOGIN: "false",
    SPACE_AGENT_TOOLS_WRITER: "disabled",
    SPACE_CHESS_MOVE_SOCKET: "disabled",
    SPACE_TELEMETRY_ENABLED: "false",
    SPACE_API_HOST: "127.0.0.1",
    SPACE_API_PORT: String(ports.apiPort),
    SPACE_HOST: "127.0.0.1",
    SPACE_PORT: String(ports.apiPort),
    SPACE_WEB_HOST: "127.0.0.1",
    SPACE_WEB_PORT: String(ports.webPort),
    SPACE_API_ORIGIN: `http://127.0.0.1:${ports.apiPort}`,
    SPACE_APP_ORIGIN: `http://127.0.0.1:${ports.webPort}`,
    SPACE_PUBLIC_ORIGIN: `http://127.0.0.1:${ports.webPort}`,
    SPACE_BROWSER_EVIDENCE_TARGET_ORIGIN: `http://127.0.0.1:${ports.webPort}`,
    SPACE_BROWSER_EVIDENCE_ENABLED: "false",
    SPACE_BROWSER_SESSIONS_ENABLED: "false",
    SPACE_T3CODE_ENABLED: "false",
    SPACE_DATABASE_URL: secrets.databaseUrl,
    SPACE_DATABASE_URL_FILE: secrets.databaseUrlPath,
    SPACE_SESSION_SECRET: secrets.sessionSecret,
    SPACE_SESSION_SECRET_FILE: secrets.sessionSecretPath,
    SPACE_SETUP_TOKEN_FILE: secrets.setupTokenPath,
    SPACE_TEMPORAL_ADDRESS: `127.0.0.1:${ports.temporalPort}`,
    SPACE_TEMPORAL_NAMESPACE: "default",
    SPACE_TEMPORAL_TASK_QUEUE: "space-agent-turns",
    SPACEAPP_WORKFLOWS_ENABLED: "true",
    SPACE_ENABLE_DUMMY_TURNS: "true",
    SPACE_CLI_ENABLED: "true",
    SPACE_CLI_ROOT_ENABLED: "false",
    SPACE_CLI_VPN_ENABLED: "false",
    SPACE_CLI_COMMAND_PATH: paths.binDir,
    SPACE_OPEN_CODE_BINARY: path.join(paths.binDir, "opencode"),
    SPACE_CLI_WORKSPACE_ROOT: paths.workspacesDir,
    SPACE_CLI_HOST_SOCKET: cliHostSocketPath,
    SPACE_CLI_HOST_SOCKET_PATH: cliHostSocketPath,
    SPACE_ARTIFACT_ROOT: paths.artifactsDir,
    SPACE_WORKFLOW_ARTIFACTS_ROOT: paths.artifactsDir,
    SPACE_MEMORY_ROOT: memoryDir,
    SPACE_STARTER_MEMORY_ROOT: path.join(repoRoot, "starter-memory"),
    SPACE_MEMORY_GRAPH_ROOT: path.join(paths.dataDir, "memory-graph"),
    SPACE_GEMINI_MEMORY_INDEX_PATH: path.join(memoryDir, "gemini_history.md"),
    SPACE_GEMINI_MEMORY_MONTHLY_PATH: path.join(memoryDir, "gemini_history_monthly.md"),
    SPACE_GEMINI_MEMORY_LOCK_PATH: path.join(memoryDir, ".memory.lock"),
    SPACE_CODEX_HOME: path.join(cliStateDir, "providers", "codex"),
    SPACE_CODEX_APP_SERVER_HOME: path.join(cliStateDir, "providers", "codex"),
    SPACE_CODEX_APP_SERVER_COMMAND: path.join(paths.binDir, "codex-vscode-parity"),
    SPACE_CODEX_ROUTE_COMMAND: path.join(paths.binDir, "codex-vscode-parity"),
    SPACE_CODEX_GOALS_DB_PATH: path.join(paths.dataDir, "codex-goals.sqlite"),
    SPACE_CODEX_CLI_MODE_DEFAULTS_PROJECTION_PATH: path.join(
      paths.dataDir,
      "codex-cli-mode-defaults-v1.json"
    ),
    SPACE_TELEGRAM_SECRET_ROOT: path.join(paths.dataDir, "telegram"),
    SPACE_TELEGRAM_OWNERSHIP_MANIFEST: path.join(
      paths.dataDir,
      "integrations",
      "telegram",
      "thread-ownership.json"
    ),
    SPACE_STREAMING_SECRET_ROOT: path.join(paths.dataDir, "streaming-secrets"),
    SPACE_APP_DIAGNOSTICS_ROOT: path.join(paths.dataDir, "app-diagnostics"),
    SPACE_MAINTENANCE_AUTOPILOT_STATE_FILE: path.join(
      paths.dataDir,
      "maintenance-autopilot",
      "state.json"
    ),
    SPACE_CLI_ACCOUNT_BALANCER_STATE_FILE: path.join(
      paths.dataDir,
      "cli-account-balancer",
      "state.json"
    ),
    SPACE_DEMO_PROJECTS_ROOT: path.join(repoRoot, "demos"),
    SPACE_DEMO_PROJECTS_VAR_ROOT: path.join(paths.dataDir, "demo-projects"),
    SPACE_PROJECTS_ROOT: path.join(paths.dataDir, "projects"),
    SPACE_INSTALL_ROOT: paths.installRoot,
    SPACE_DOT_WORKSPACE_ROOT: path.join(paths.dataDir, "dots"),
    SPACE_GIT_ROOT: repoRoot,
    SPACE_REPO_ROOT: repoRoot,
    SPACE_DEV_STACK_REPO_ROOT: repoRoot
  };
}

export function processStartIdentity(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return null;
  }
  const procStatPath = `/proc/${pid}/stat`;
  if (existsSync(procStatPath)) {
    try {
      const raw = readFileSync(procStatPath, "utf8");
      const closeParen = raw.lastIndexOf(")");
      if (closeParen !== -1) {
        const fields = raw
          .slice(closeParen + 2)
          .trim()
          .split(/\s+/);
        const state = fields[0];
        const starttime = fields[19];
        if (state === "Z" || state === "X") {
          return null;
        }
        if (starttime) {
          return `proc:${starttime}`;
        }
      }
    } catch {
      return null;
    }
  }
  if (process.platform === "win32") {
    try {
      process.kill(pid, 0);
      return `win32:${pid}`;
    } catch {
      return null;
    }
  }
  const psResult = spawnSync("ps", ["-p", String(pid), "-o", "stat=,lstart="], {
    encoding: "utf8"
  });
  if (psResult.status !== 0) {
    return null;
  }
  const line = (psResult.stdout ?? "").trim();
  if (!line) {
    return null;
  }
  const match = line.match(/^(\S+)\s+(.+)$/);
  if (!match) {
    return null;
  }
  const [, statField, lstart] = match;
  if (statField.startsWith("Z") || statField.startsWith("X")) {
    return null;
  }
  return `ps:${lstart.trim()}`;
}

function listProcessGroupMembers(pgid) {
  if (!Number.isInteger(pgid) || pgid <= 0 || process.platform === "win32") {
    return [];
  }
  if (existsSync("/proc")) {
    const members = [];
    try {
      for (const entry of readdirSync("/proc")) {
        if (!/^\d+$/.test(entry)) {
          continue;
        }
        const pid = Number.parseInt(entry, 10);
        try {
          const raw = readFileSync(`/proc/${pid}/stat`, "utf8");
          const closeParen = raw.lastIndexOf(")");
          if (closeParen === -1) {
            continue;
          }
          const fields = raw
            .slice(closeParen + 2)
            .trim()
            .split(/\s+/);
          const state = fields[0];
          const procPgid = Number.parseInt(fields[2] ?? "", 10);
          if (procPgid === pgid && state !== "Z" && state !== "X") {
            members.push(pid);
          }
        } catch {
          // Process exited while scanning /proc
        }
      }
      return members;
    } catch {
      // Fall back to ps
    }
  }

  const psResult = spawnSync("ps", ["-a", "-x", "-o", "pid=,pgid=,stat="], {
    encoding: "utf8"
  });
  if (psResult.status !== 0) {
    return [];
  }
  const members = [];
  for (const rawLine of (psResult.stdout ?? "").split("\n")) {
    const trimmed = rawLine.trim();
    if (!trimmed) {
      continue;
    }
    const parts = trimmed.split(/\s+/);
    if (parts.length < 3) {
      continue;
    }
    const pid = Number.parseInt(parts[0], 10);
    const procPgid = Number.parseInt(parts[1], 10);
    const stat = parts[2];
    if (procPgid === pgid && !stat.startsWith("Z") && !stat.startsWith("X")) {
      members.push(pid);
    }
  }
  return members;
}

export function processTreeAlive(record) {
  if (!record || typeof record !== "object") {
    return false;
  }
  const pid = Number(record.pid);
  const pgid = Number(record.pgid ?? record.pid);
  if (Number.isInteger(pid) && pid > 0) {
    const currentIdentity = processStartIdentity(pid);
    if (currentIdentity) {
      if (!record.startIdentity || record.startIdentity === currentIdentity) {
        return true;
      }
      return false;
    }
  }
  if (Number.isInteger(pgid) && pgid > 0) {
    const members = listProcessGroupMembers(pgid);
    return members.length > 0;
  }
  return false;
}

export function signalProcessTree(record, signal) {
  if (!record || typeof record !== "object") {
    return;
  }
  const pid = Number(record.pid);
  const pgid = Number(record.pgid ?? record.pid);
  if (process.platform !== "win32" && Number.isInteger(pgid) && pgid > 0) {
    try {
      process.kill(-pgid, signal);
      return;
    } catch {
      // Fall back to individual members or leader PID
    }
    for (const memberPid of listProcessGroupMembers(pgid)) {
      try {
        process.kill(memberPid, signal);
      } catch {
        // Ignore ESRCH
      }
    }
  }
  if (Number.isInteger(pid) && pid > 0) {
    try {
      process.kill(pid, signal);
    } catch {
      // Ignore ESRCH
    }
  }
}

export async function stopManagedProcesses(paths, { timeoutMs = 6000 } = {}) {
  if (!existsSync(paths.pidsDir)) {
    return;
  }
  const records = [];
  for (const entry of readdirSync(paths.pidsDir)) {
    if (!entry.endsWith(".json")) {
      continue;
    }
    const pidFile = path.join(paths.pidsDir, entry);
    try {
      const record = JSON.parse(readFileSync(pidFile, "utf8"));
      records.push({ pidFile, record });
    } catch {
      rmSync(pidFile, { force: true });
    }
  }

  const active = records.filter(({ record }) => processTreeAlive(record));
  for (const { record } of active) {
    signalProcessTree(record, "SIGTERM");
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (active.every(({ record }) => !processTreeAlive(record))) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  for (const { record } of active) {
    if (processTreeAlive(record)) {
      signalProcessTree(record, "SIGKILL");
    }
  }

  const killDeadline = Date.now() + 2000;
  while (Date.now() < killDeadline) {
    if (active.every(({ record }) => !processTreeAlive(record))) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  for (const { pidFile } of records) {
    rmSync(pidFile, { force: true });
  }
  if (paths.cliHostSocketPath && existsSync(paths.cliHostSocketPath)) {
    rmSync(paths.cliHostSocketPath, { force: true });
  }
}

export function checkPortBindable(port, host = "127.0.0.1") {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once("error", () => resolve(false));
    server.listen({ port, host, exclusive: true }, () => {
      server.close(() => resolve(true));
    });
  });
}

export function checkTcpReachable(port, host = "127.0.0.1", timeoutMs = 1500) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ port, host });
    let settled = false;
    const finish = (ok) => {
      if (settled) {
        return;
      }
      settled = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

export async function waitForTcp(port, { host = "127.0.0.1", timeoutMs = 90000, label = `TCP ${host}:${port}` } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await checkTcpReachable(port, host, 1500)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out waiting for ${label} on ${host}:${port}`);
}

export async function waitForHttp(
  url,
  {
    timeoutMs = 90000,
    validate = (res) => res.ok,
    label = url,
    onTick
  } = {}
) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    if (onTick) {
      onTick();
    }
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(2500)
      });
      const bodyText = await response.text();
      if (await validate(response, bodyText)) {
        return { status: response.status, bodyText };
      }
      lastError = new Error(`HTTP ${response.status}: ${bodyText.slice(0, 240)}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(
    `Timed out waiting for ${label} (${url})${lastError ? `: ${lastError.message}` : ""}`
  );
}

function runDockerCompose(paths, projectName, args, { env = process.env, stdio = "inherit" } = {}) {
  const result = spawnSync(
    "docker",
    ["compose", "-p", projectName, "-f", paths.composePath, ...args],
    {
      stdio,
      env
    }
  );
  if (result.status !== 0) {
    throw new Error(
      `docker compose ${args.join(" ")} failed with exit code ${result.status ?? "unknown"}`
    );
  }
  return result;
}

function verifyPrerequisites(repoRoot) {
  if (process.platform === "win32") {
    throw new Error(
      "Run `npm run dev:stack` inside WSL2 (Ubuntu) on Windows 11 so Unix domain sockets and POSIX PTYs are available."
    );
  }
  const dockerCheck = spawnSync("docker", ["compose", "version"], {
    cwd: repoRoot,
    encoding: "utf8"
  });
  if (dockerCheck.status !== 0) {
    throw new Error(
      "Docker with Compose v2 (`docker compose`) is required to run Postgres and Temporal."
    );
  }
  if (!existsSync(path.join(repoRoot, "node_modules"))) {
    throw new Error(
      "Dependencies are not installed. Run `npm ci` (or `npm install`) before `npm run dev:stack`."
    );
  }
}

function buildWorkspacePackages(repoRoot) {
  console.log("[dev:stack] Building workspace libraries and worker...");
  const workspaceFlags = PACKAGE_BUILD_ORDER.flatMap((pkg) => ["-w", pkg]);
  const result = spawnSync("npm", ["run", "build", ...workspaceFlags], {
    cwd: repoRoot,
    stdio: "inherit",
    env: process.env
  });
  if (result.status !== 0) {
    throw new Error(`Workspace package build failed (exit ${result.status ?? "unknown"})`);
  }
}

function runMigrations(repoRoot, serviceEnv) {
  console.log("[dev:stack] Running database migrations (@space/db)...");
  const result = spawnSync(
    process.execPath,
    [path.join(repoRoot, "packages", "db", "dist", "migrate.js")],
    {
      cwd: repoRoot,
      stdio: "inherit",
      env: serviceEnv
    }
  );
  if (result.status !== 0) {
    throw new Error(`Database migrations failed (exit ${result.status ?? "unknown"})`);
  }
}

function spawnManagedService({ name, command, args, cwd, env, paths }) {
  const logPath = path.join(paths.logsDir, `${name}.log`);
  const pidPath = path.join(paths.pidsDir, `${name}.json`);
  const logFd = openSync(logPath, "a");
  let child;
  try {
    child = spawn(command, args, {
      cwd,
      env,
      detached: true,
      stdio: ["ignore", logFd, logFd]
    });
  } finally {
    closeSync(logFd);
  }
  child.unref();

  const record = {
    name,
    pid: child.pid,
    pgid: child.pid,
    startIdentity: processStartIdentity(child.pid),
    logPath,
    startedAt: new Date().toISOString()
  };
  writeFileSync(pidPath, `${JSON.stringify(record, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600
  });
  return record;
}

function readLogTail(logPath, maxLines = 40) {
  if (!existsSync(logPath)) {
    return "(no log file)";
  }
  const lines = readFileSync(logPath, "utf8").trimEnd().split("\n");
  return lines.slice(-maxLines).join("\n");
}

function assertServicesAlive(records) {
  for (const record of records) {
    if (!processTreeAlive(record)) {
      const tail = readLogTail(record.logPath, 50);
      throw new Error(
        `Service "${record.name}" exited unexpectedly (PID ${record.pid}). Last log lines:\n${tail}`
      );
    }
  }
}

function snapshotSourceMtime(repoRoot) {
  const roots = [path.join(repoRoot, "packages"), path.join(repoRoot, "apps", "worker", "src")];
  const snapshot = new Map();
  const walk = (dir) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "dist" || entry.name === "node_modules" || entry.name.startsWith(".")) {
        continue;
      }
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile() && /\.(?:ts|tsx|mts|cts|js|mjs|cjs|json|css)$/.test(entry.name)) {
        try {
          snapshot.set(fullPath, statSync(fullPath).mtimeMs);
        } catch {
          // Ignore transient file removal
        }
      }
    }
  };
  for (const rootDir of roots) {
    walk(rootDir);
  }
  return snapshot;
}

function startPackageWatcher(repoRoot, logPath) {
  let baseline = snapshotSourceMtime(repoRoot);
  let building = false;

  const timer = setInterval(() => {
    if (building) {
      return;
    }
    const next = snapshotSourceMtime(repoRoot);
    let changed = next.size !== baseline.size;
    if (!changed) {
      for (const [file, mtime] of next) {
        if (baseline.get(file) !== mtime) {
          changed = true;
          break;
        }
      }
    }
    if (!changed) {
      return;
    }
    baseline = next;
    building = true;
    const logFd = openSync(logPath, "a");
    try {
      const workspaceFlags = PACKAGE_BUILD_ORDER.flatMap((pkg) => ["-w", pkg]);
      spawnSync("npm", ["run", "build", ...workspaceFlags], {
        cwd: repoRoot,
        stdio: ["ignore", logFd, logFd],
        env: process.env
      });
    } finally {
      closeSync(logFd);
      baseline = snapshotSourceMtime(repoRoot);
      building = false;
    }
  }, 1500);
  timer.unref();
  return () => clearInterval(timer);
}

export function renderReadyBanner({ ports, secrets, paths, setupRequired }) {
  const webUrl = `http://127.0.0.1:${ports.webPort}`;
  const apiUrl = `http://127.0.0.1:${ports.apiPort}`;
  const tokenAvailable =
    (setupRequired ?? true) &&
    Boolean(secrets.setupToken) &&
    existsSync(secrets.setupTokenPath);
  const lines = [
    "",
    "========================================================================",
    " SpaceApp contributor stack is READY",
    "========================================================================",
    `  Web UI:          ${webUrl}`,
    `  API Server:      ${apiUrl} (/livez, /readyz)`,
    `  Postgres:        127.0.0.1:${ports.postgresPort} (db: spaceapp, user: spaceapp)`,
    `  Temporal gRPC:   127.0.0.1:${ports.temporalPort} (namespace: default)`,
    `  CLI Host Socket: ${paths.cliHostSocketPath ?? path.join(paths.runtimeDir, "cli-host.sock")}`,
    `  State Directory: ${paths.stateDir}`,
    `  Logs Directory:  ${paths.logsDir}`
  ];
  if (tokenAvailable) {
    lines.push(
      `  Setup Token:     ${secrets.setupToken}`,
      `  Setup Token File:${secrets.setupTokenPath} (consumed on first owner claim)`
    );
  } else {
    lines.push("  Owner Setup:     Already claimed (setup token file consumed)");
  }
  lines.push(
    "------------------------------------------------------------------------",
    "  Verify stack:    npm run dev:stack -- verify",
    "  Stop stack:      npm run dev:stack -- down",
    "  Reset stack:     npm run dev:stack -- reset",
    "========================================================================",
    ""
  );
  return lines.join("\n");
}

export async function runUp(repoRoot, { detach = false, env = process.env } = {}) {
  verifyPrerequisites(repoRoot);
  const paths = resolveStatePaths(repoRoot, env);
  const ports = resolvePorts(env);
  const projectName = resolveComposeProjectName(paths.stateDir, env);

  await stopManagedProcesses(paths);

  for (const [name, port] of [
    ["web", ports.webPort],
    ["api", ports.apiPort]
  ]) {
    const bindable = await checkPortBindable(port, "127.0.0.1");
    if (!bindable) {
      throw new Error(
        `Host port 127.0.0.1:${port} (${name}) is already in use. Stop the conflicting process or override SPACE_DEV_${name.toUpperCase()}_PORT.`
      );
    }
  }

  ensureRuntimeDirectories(paths, repoRoot);
  const secrets = ensureSecrets(paths.stateDir, ports);
  const composeTemplatePath = path.join(
    repoRoot,
    "packages",
    "run-spaceapp",
    "templates",
    "compose.yml"
  );
  const images = parseComposeImages(readFileSync(composeTemplatePath, "utf8"));
  const composeContent = renderCompose({ paths, ports, images });
  writeFileSync(paths.composePath, composeContent, { encoding: "utf8", mode: 0o600 });
  chmodSync(paths.composePath, 0o600);

  ensureOpenCodeBinary(repoRoot, paths);
  buildWorkspacePackages(repoRoot);

  console.log("[dev:stack] Starting Postgres and Temporal containers...");
  runDockerCompose(paths, projectName, ["up", "-d", "--wait", "postgres", "temporal"], {
    env
  });

  await waitForTcp(ports.postgresPort, { label: "Postgres" });
  await waitForTcp(ports.temporalPort, { label: "Temporal gRPC" });

  const serviceEnv = buildServiceEnv({
    repoRoot,
    paths,
    ports,
    secrets,
    baseEnv: env
  });

  runMigrations(repoRoot, serviceEnv);

  const tsxBin = path.join(repoRoot, "node_modules", ".bin", "tsx");
  const viteBin = path.join(repoRoot, "node_modules", ".bin", "vite");

  console.log("[dev:stack] Starting CLI host, API, worker, and web dev servers from source...");
  const cliHostRecord = spawnManagedService({
    name: "cli-host",
    command: tsxBin,
    args: ["watch", "packages/cli-host/src/main.ts"],
    cwd: repoRoot,
    env: serviceEnv,
    paths
  });
  const apiRecord = spawnManagedService({
    name: "api",
    command: tsxBin,
    args: ["watch", "apps/api/src/server.ts"],
    cwd: repoRoot,
    env: serviceEnv,
    paths
  });
  const workerRecord = spawnManagedService({
    name: "worker",
    command: process.execPath,
    args: ["--watch", path.join(repoRoot, "apps", "worker", "dist", "worker.js")],
    cwd: repoRoot,
    env: serviceEnv,
    paths
  });
  const webRecord = spawnManagedService({
    name: "web",
    command: viteBin,
    args: ["--host", "127.0.0.1", "--port", String(ports.webPort), "--strictPort"],
    cwd: path.join(repoRoot, "apps", "web"),
    env: serviceEnv,
    paths
  });

  const managedRecords = [cliHostRecord, apiRecord, workerRecord, webRecord];

  writeFileSync(
    paths.stateFile,
    `${JSON.stringify(
      {
        projectName,
        ports,
        cliHostSocketPath: paths.cliHostSocketPath,
        startedAt: new Date().toISOString()
      },
      null,
      2
    )}\n`,
    { encoding: "utf8", mode: 0o600 }
  );

  let setupRequired = true;
  try {
    await waitForHttp(`http://127.0.0.1:${ports.apiPort}/livez`, {
      label: "API /livez",
      onTick: () => assertServicesAlive(managedRecords)
    });
    await waitForHttp(`http://127.0.0.1:${ports.apiPort}/readyz`, {
      label: "API /readyz",
      onTick: () => assertServicesAlive(managedRecords),
      validate: (res, bodyText) => {
        if (!res.ok) {
          return false;
        }
        try {
          const parsed = JSON.parse(bodyText);
          return (
            parsed.ok === true &&
            parsed.dependencies?.database === "RUNNING" &&
            parsed.dependencies?.worker === "RUNNING" &&
            parsed.dependencies?.cliHost === "RUNNING"
          );
        } catch {
          return false;
        }
      }
    });
    await waitForHttp(`http://127.0.0.1:${ports.webPort}/`, {
      label: "Web dev server",
      onTick: () => assertServicesAlive(managedRecords),
      validate: (res, bodyText) => res.ok && bodyText.includes('<div id="root">')
    });
    await waitForHttp(`http://127.0.0.1:${ports.webPort}/api/setup/status`, {
      label: "Web -> API proxy (/api/setup/status)",
      onTick: () => assertServicesAlive(managedRecords),
      validate: (res, bodyText) => {
        if (!res.ok) {
          return false;
        }
        try {
          const parsed = JSON.parse(bodyText);
          if (typeof parsed.setupRequired === "boolean") {
            setupRequired = parsed.setupRequired;
            return true;
          }
          return false;
        } catch {
          return false;
        }
      }
    });
  } catch (error) {
    await stopManagedProcesses(paths);
    throw error;
  }

  if (!setupRequired && existsSync(secrets.setupTokenPath)) {
    rmSync(secrets.setupTokenPath, { force: true });
    secrets.setupToken = null;
  }

  console.log(renderReadyBanner({ ports, secrets, paths, setupRequired }));

  if (detach) {
    return;
  }

  const stopWatcher = startPackageWatcher(
    repoRoot,
    path.join(paths.logsDir, "packages-watch.log")
  );
  const tailChild = spawn(
    "tail",
    [
      "-n",
      "0",
      "-F",
      cliHostRecord.logPath,
      apiRecord.logPath,
      workerRecord.logPath,
      webRecord.logPath
    ],
    {
      stdio: ["ignore", "inherit", "inherit"]
    }
  );

  await new Promise((resolve, reject) => {
    let shuttingDown = false;
    const shutdown = async (exitError = null) => {
      if (shuttingDown) {
        return;
      }
      shuttingDown = true;
      stopWatcher();
      clearInterval(healthTimer);
      try {
        tailChild.kill("SIGTERM");
      } catch {
        // Ignore
      }
      await stopManagedProcesses(paths);
      if (exitError) {
        reject(exitError);
      } else {
        resolve();
      }
    };

    const healthTimer = setInterval(() => {
      try {
        assertServicesAlive(managedRecords);
      } catch (error) {
        void shutdown(error);
      }
    }, 1000);

    process.once("SIGINT", () => {
      console.log("\n[dev:stack] Caught SIGINT, stopping host services...");
      void shutdown();
    });
    process.once("SIGTERM", () => {
      console.log("\n[dev:stack] Caught SIGTERM, stopping host services...");
      void shutdown();
    });
  });
}

function removeResidualComposeResources(projectName, env = process.env) {
  const containersResult = spawnSync(
    "docker",
    ["ps", "-aq", "--filter", `label=com.docker.compose.project=${projectName}`],
    { encoding: "utf8", env }
  );
  if (containersResult.status === 0) {
    const ids = (containersResult.stdout ?? "")
      .split(/\s+/)
      .map((item) => item.trim())
      .filter(Boolean);
    if (ids.length > 0) {
      spawnSync("docker", ["rm", "-f", "-v", ...ids], { stdio: "inherit", env });
    }
  }
  const volumesResult = spawnSync(
    "docker",
    ["volume", "ls", "-q", "--filter", `label=com.docker.compose.project=${projectName}`],
    { encoding: "utf8", env }
  );
  if (volumesResult.status === 0) {
    const volumes = (volumesResult.stdout ?? "")
      .split(/\s+/)
      .map((item) => item.trim())
      .filter(Boolean);
    if (volumes.length > 0) {
      spawnSync("docker", ["volume", "rm", "-f", ...volumes], { stdio: "inherit", env });
    }
  }
}

export async function runDown(repoRoot, { env = process.env, removeVolumes = false } = {}) {
  const paths = resolveStatePaths(repoRoot, env);
  let projectName = resolveComposeProjectName(paths.stateDir, env);
  if (existsSync(paths.stateFile)) {
    try {
      const saved = JSON.parse(readFileSync(paths.stateFile, "utf8"));
      if (saved.projectName) {
        projectName = saved.projectName;
      }
    } catch {
      // Use computed projectName
    }
  }

  await stopManagedProcesses(paths);

  if (existsSync(paths.composePath)) {
    const downArgs = ["down", "--remove-orphans"];
    if (removeVolumes) {
      downArgs.push("--volumes");
    }
    const result = spawnSync(
      "docker",
      ["compose", "-p", projectName, "-f", paths.composePath, ...downArgs],
      {
        stdio: "inherit",
        env
      }
    );
    if (result.status !== 0) {
      throw new Error(
        `docker compose ${downArgs.join(" ")} failed (exit ${result.status ?? "unknown"})`
      );
    }
  }
  if (removeVolumes) {
    removeResidualComposeResources(projectName, env);
  }
}

export async function runReset(repoRoot, { env = process.env } = {}) {
  const paths = resolveStatePaths(repoRoot, env);
  const rel = path.relative(paths.stateDir, repoRoot);
  const containsRepo = rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
  if (
    containsRepo ||
    paths.stateDir === path.parse(paths.stateDir).root ||
    (env.HOME && path.resolve(env.HOME) === paths.stateDir)
  ) {
    throw new Error(`Refusing to delete unsafe SPACE_DEV_STATE_DIR: ${paths.stateDir}`);
  }
  const ports = resolvePorts(env);
  await runDown(repoRoot, { env, removeVolumes: true });
  rmSync(paths.stateDir, { recursive: true, force: true });
  if (paths.cliHostSocketDir && paths.cliHostSocketDir !== paths.runtimeDir) {
    rmSync(paths.cliHostSocketDir, { recursive: true, force: true });
  }

  for (const [name, port] of Object.entries(ports)) {
    const stillReachable = await checkTcpReachable(port, "127.0.0.1", 500);
    if (stillReachable) {
      throw new Error(`Port 127.0.0.1:${port} (${name}) is still listening after reset`);
    }
  }
  console.log(`[dev:stack] Reset complete. Removed ${paths.stateDir} and compose volumes.`);
}

export async function runStatus(repoRoot, { env = process.env } = {}) {
  const paths = resolveStatePaths(repoRoot, env);
  const ports = resolvePorts(env);
  const services = {};
  for (const name of ["cli-host", "api", "worker", "web"]) {
    const pidFile = path.join(paths.pidsDir, `${name}.json`);
    if (existsSync(pidFile)) {
      try {
        const record = JSON.parse(readFileSync(pidFile, "utf8"));
        services[name] = {
          alive: processTreeAlive(record),
          pid: record.pid
        };
      } catch {
        services[name] = { alive: false, pid: null };
      }
    } else {
      services[name] = { alive: false, pid: null };
    }
  }
  const status = {
    stateDir: paths.stateDir,
    stateDirExists: existsSync(paths.stateDir),
    ports,
    services,
    postgresReachable: await checkTcpReachable(ports.postgresPort, "127.0.0.1", 500),
    temporalReachable: await checkTcpReachable(ports.temporalPort, "127.0.0.1", 500)
  };
  console.log(JSON.stringify(status, null, 2));
  return status;
}

export async function runVerify(repoRoot, { env = process.env } = {}) {
  const paths = resolveStatePaths(repoRoot, env);
  const ports = resolvePorts(env);
  const webOrigin = `http://127.0.0.1:${ports.webPort}`;

  const readyRes = await fetch(`${webOrigin}/readyz`);
  if (!readyRes.ok) {
    throw new Error(`/readyz failed with HTTP ${readyRes.status}`);
  }
  const readyBody = await readyRes.json();
  if (
    readyBody.ok !== true ||
    readyBody.dependencies?.database !== "RUNNING" ||
    readyBody.dependencies?.worker !== "RUNNING" ||
    readyBody.dependencies?.cliHost !== "RUNNING"
  ) {
    throw new Error(`/readyz reported unhealthy dependencies: ${JSON.stringify(readyBody)}`);
  }

  const setupStatusRes = await fetch(`${webOrigin}/api/setup/status`);
  if (!setupStatusRes.ok) {
    throw new Error(`/api/setup/status failed with HTTP ${setupStatusRes.status}`);
  }
  const setupStatus = await setupStatusRes.json();

  let sessionCookie = null;
  let starterRoomId = null;
  const ownerEmail = env.SPACE_DEV_OWNER_EMAIL?.trim() || "owner@example.com";
  const ownerPassword = env.SPACE_DEV_OWNER_PASSWORD || "correct horse battery staple";

  if (setupStatus.setupRequired) {
    if (!existsSync(paths.secretsDir)) {
      throw new Error(`Secrets directory ${paths.secretsDir} does not exist`);
    }
    const setupTokenPath = path.join(paths.secretsDir, "setup-token");
    if (!existsSync(setupTokenPath)) {
      throw new Error(`Setup token file ${setupTokenPath} does not exist`);
    }
    const token = readFileSync(setupTokenPath, "utf8").trim();
    const claimRes = await fetch(`${webOrigin}/api/setup/claim`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: webOrigin
      },
      body: JSON.stringify({
        token,
        email: ownerEmail,
        password: ownerPassword
      })
    });
    const claimText = await claimRes.text();
    if (!claimRes.ok) {
      throw new Error(`/api/setup/claim failed with HTTP ${claimRes.status}: ${claimText}`);
    }
    const setCookies =
      typeof claimRes.headers.getSetCookie === "function"
        ? claimRes.headers.getSetCookie()
        : [claimRes.headers.get("set-cookie")].filter(Boolean);
    const spaceCookie = setCookies.find((cookie) => cookie.startsWith("space_session="));
    if (!spaceCookie) {
      throw new Error("/api/setup/claim did not return a space_session cookie");
    }
    sessionCookie = spaceCookie.split(";")[0];
    const claimBody = JSON.parse(claimText);
    starterRoomId = claimBody.starterRoomId;
  } else {
    const loginRes = await fetch(`${webOrigin}/api/auth/login`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: webOrigin
      },
      body: JSON.stringify({
        email: ownerEmail,
        password: ownerPassword
      })
    });
    const loginText = await loginRes.text();
    if (!loginRes.ok) {
      throw new Error(
        `/api/auth/login failed with HTTP ${loginRes.status} for ${ownerEmail} (if you claimed the owner account with custom credentials, set SPACE_DEV_OWNER_EMAIL and SPACE_DEV_OWNER_PASSWORD): ${loginText}`
      );
    }
    const setCookies =
      typeof loginRes.headers.getSetCookie === "function"
        ? loginRes.headers.getSetCookie()
        : [loginRes.headers.get("set-cookie")].filter(Boolean);
    const spaceCookie = setCookies.find((cookie) => cookie.startsWith("space_session="));
    if (!spaceCookie) {
      throw new Error("/api/auth/login did not return a space_session cookie");
    }
    sessionCookie = spaceCookie.split(";")[0];
  }

  const csrfRes = await fetch(`${webOrigin}/api/auth/csrf`, {
    headers: {
      cookie: sessionCookie,
      origin: webOrigin
    }
  });
  if (!csrfRes.ok) {
    throw new Error(`/api/auth/csrf failed with HTTP ${csrfRes.status}`);
  }
  const { csrfToken, headerName } = await csrfRes.json();

  if (!starterRoomId) {
    const starterRes = await fetch(`${webOrigin}/api/setup/starter-room`, {
      method: "POST",
      headers: {
        cookie: sessionCookie,
        origin: webOrigin,
        [headerName]: csrfToken
      }
    });
    if (!starterRes.ok) {
      throw new Error(`/api/setup/starter-room failed with HTTP ${starterRes.status}`);
    }
    const starterBody = await starterRes.json();
    starterRoomId = starterBody.room?.id;
  }

  const panesRes = await fetch(
    `${webOrigin}/api/panes?roomId=${encodeURIComponent(starterRoomId)}`,
    {
      headers: {
        cookie: sessionCookie,
        origin: webOrigin
      }
    }
  );
  if (!panesRes.ok) {
    throw new Error(`/api/panes failed with HTTP ${panesRes.status}`);
  }
  const panesBody = await panesRes.json();
  const openCodePane = (panesBody.data ?? []).find(
    (pane) => pane.mode === "TERMINAL" && pane.terminalRuntimeId === "cli:opencode"
  );
  if (!openCodePane) {
    throw new Error(`No OpenCode CLI pane found in starter room ${starterRoomId}`);
  }

  const createSessionRes = await fetch(
    `${webOrigin}/api/panes/${encodeURIComponent(openCodePane.id)}/cli/session`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: sessionCookie,
        origin: webOrigin,
        [headerName]: csrfToken
      },
      body: JSON.stringify({
        runtimeId: "cli:opencode"
      })
    }
  );
  const createSessionText = await createSessionRes.text();
  if (!createSessionRes.ok) {
    throw new Error(
      `POST /api/panes/${openCodePane.id}/cli/session failed with HTTP ${createSessionRes.status}: ${createSessionText}`
    );
  }
  const createSessionBody = JSON.parse(createSessionText);
  const sessionId = createSessionBody.session?.sessionId;
  const wsToken = createSessionBody.websocket?.token;
  if (!sessionId || !wsToken) {
    throw new Error(`CLI session response missing sessionId or websocket.token: ${createSessionText}`);
  }

  const { default: WebSocket } = await import("ws");
  const wsUrl = `ws://127.0.0.1:${ports.webPort}/api/panes/${encodeURIComponent(openCodePane.id)}/cli/terminal?sessionId=${encodeURIComponent(sessionId)}&token=${encodeURIComponent(wsToken)}&initialCols=100&initialRows=30`;

  await new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl, {
      headers: {
        cookie: sessionCookie,
        origin: webOrigin
      }
    });
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error("Timed out waiting for OpenCode CLI terminal WebSocket RUNNING status"));
    }, 30000);

    ws.on("message", (raw) => {
      try {
        const message = JSON.parse(String(raw));
        if (message.type === "error") {
          clearTimeout(timer);
          ws.close();
          reject(new Error(`CLI terminal WebSocket error: ${message.code} ${message.message}`));
          return;
        }
        if (
          (message.type === "status" && message.status === "RUNNING") ||
          (message.type === "ready" && message.status === "RUNNING")
        ) {
          clearTimeout(timer);
          ws.close();
          resolve();
        }
      } catch {
        // Ignore non-JSON frames
      }
    });
    ws.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });

  const inspectSessionRes = await fetch(
    `${webOrigin}/api/panes/${encodeURIComponent(openCodePane.id)}/cli/session`,
    {
      headers: {
        cookie: sessionCookie,
        origin: webOrigin
      }
    }
  );
  if (!inspectSessionRes.ok) {
    throw new Error(`GET /api/panes/${openCodePane.id}/cli/session failed with HTTP ${inspectSessionRes.status}`);
  }
  const inspectSessionBody = await inspectSessionRes.json();
  if (inspectSessionBody.session?.status !== "RUNNING") {
    throw new Error(
      `Expected OpenCode CLI pane session to be RUNNING, got ${JSON.stringify(inspectSessionBody.session)}`
    );
  }

  const result = {
    ok: true,
    readyz: {
      ok: readyBody.ok,
      database: readyBody.dependencies?.database,
      worker: readyBody.dependencies?.worker,
      cliHost: readyBody.dependencies?.cliHost
    },
    starterRoomId,
    paneId: openCodePane.id,
    cliSessionId: sessionId,
    cliStatus: inspectSessionBody.session.status
  };
  console.log(JSON.stringify(result, null, 2));
  return result;
}

export async function main(argv = process.argv.slice(2)) {
  const repoRoot = resolveRepoRoot();
  const flags = new Set(argv.filter((arg) => arg.startsWith("-")));
  const positional = argv.filter((arg) => !arg.startsWith("-"));
  const subcommand = positional[0] ?? "up";
  const detach = flags.has("--detach") || flags.has("-d") || process.env.SPACE_DEV_STACK_DETACH === "1";

  if (flags.has("--help") || flags.has("-h") || subcommand === "help") {
    console.log(
      [
        "Usage: npm run dev:stack [-- <up|down|reset|status|verify> [--detach]]",
        "",
        "Commands:",
        "  up [--detach]  Start Postgres, Temporal, migrations, CLI host, API, worker, and web from source (default)",
        "  down           Stop host processes and compose containers (keeps state and database volume)",
        "  reset          Stop all processes/containers and delete .dev-stack state and volumes",
        "  status         Print JSON status of managed processes and ports",
        "  verify         Verify /readyz, claim owner setup, and confirm the Getting Started OpenCode CLI pane runs"
      ].join("\n")
    );
    return;
  }

  switch (subcommand) {
    case "up":
      await runUp(repoRoot, { detach });
      break;
    case "down":
      await runDown(repoRoot);
      break;
    case "reset":
      await runReset(repoRoot);
      break;
    case "status":
      await runStatus(repoRoot);
      break;
    case "verify":
      await runVerify(repoRoot);
      break;
    default:
      throw new Error(
        `Unknown dev:stack command "${subcommand}". Expected up, down, reset, status, or verify.`
      );
  }
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  main().catch((error) => {
    console.error(`[dev:stack] Error: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
