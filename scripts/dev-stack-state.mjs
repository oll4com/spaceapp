import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve, dirname, basename, relative, isAbsolute, sep } from "node:path";
import { tmpdir } from "node:os";

export const defaultPorts = { api: 5910, web: 5911, postgres: 55432, temporal: 57233 };
export const packageWorkspaces = ["contracts", "icons", "streaming", "opencode-control", "memory-graph", "browser-host", "cli-host", "codex-app-server", "runtime", "db", "gateway"];

/**
 * Read the launcher's digest-pinned database images and Dockerfile's exact OpenCode version.
 * Reject missing or ambiguous pins rather than silently selecting a newer dependency.
 */
export function readPins(root) {
  const template = readFileSync(join(root, "packages/run-spaceapp/templates/compose.yml"), "utf8");
  /**
   * Require exactly one matching image with a complete SHA-256 digest in the existing Compose template.
   */
  const image = (name) => {
    const matches = [...template.matchAll(/^\s+image:\s*(\S+)/gm)].map((m) => m[1]).filter((s) => s.startsWith(`${name}:`));
    if (matches.length !== 1 || !/@sha256:[a-f0-9]{64}$/.test(matches[0])) throw new Error(`Expected one digest-pinned ${name} image in the launcher template.`);
    return matches[0];
  };
  const version = readFileSync(join(root, "Dockerfile"), "utf8").match(/\bopencode-ai@(\d+\.\d+\.\d+)(?=[\s\\])/);
  if (!version) throw new Error("Dockerfile must pin an exact opencode-ai version.");
  return { postgres: image("pgvector/pgvector"), temporal: image("temporalio/auto-setup"), opencode: version[1] };
}

/**
 * Validate four distinct unprivileged ports while reserving the installed product's ports.
 * @returns {{api: number, web: number, postgres: number, temporal: number}} Validated loopback bindings.
 */
export function resolvePorts(env = process.env) {
  const ports = Object.fromEntries(Object.entries(defaultPorts).map(([name, fallback]) => {
    const key = `SPACE_DEV_${name.toUpperCase()}_PORT`;
    const raw = env[key] ?? String(fallback);
    const value = Number(raw);
    if (!/^\d+$/.test(raw) || !Number.isInteger(value) || value < 1024 || value > 65535 || [4910, 4911].includes(value)) throw new Error(`${key} must be a port between 1024 and 65535, excluding installed ports 4910/4911.`);
    return [name, value];
  }));
  if (new Set(Object.values(ports)).size !== 4) throw new Error("Dev stack ports must be distinct.");
  return ports;
}

// A deliberately narrow state override: never adopt an arbitrary existing folder.
// Sibling names also avoid nested stacks whose reset could remove one another.
/**
 * Restrict state to a non-symlink .dev-stack sibling inside this checkout.
 * Nested stacks and arbitrary existing folders cannot become destructive reset targets.
 */
export function statePath(root, env = process.env) {
  const requested = resolve(root, env.SPACE_DEV_STATE_DIR || ".dev-stack");
  if (dirname(requested) !== root || !/^\.dev-stack(?:-[a-zA-Z0-9_-]+)?$/.test(basename(requested))) throw new Error("SPACE_DEV_STATE_DIR must be .dev-stack or a sibling .dev-stack-NAME in this checkout.");
  const stat = lstatSync(requested, { throwIfNoEntry: false });
  if (stat && (!stat.isDirectory() || stat.uid !== process.getuid())) throw new Error("Refusing a symlink, non-directory or foreign-owned dev state path.");
  return requested;
}

/**
 * Inspect a private file without following links, rejecting shared inodes and other owners before reads or chmod.
 * @returns {import("node:fs").Stats | undefined} The validated file, or undefined when absent (including no adoption).
 */
export function privateFileStat(path, description = "private file") {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (stat && (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid())) throw new Error(`Expected an owned, unlinked ${description}: ${basename(path)}`);
  return stat;
}

/**
 * Create private directories one component at a time under a trusted root, refusing links before chmod or traversal.
 * This protects stale/tampered local state; it is not a sandbox against concurrent code running as the same user.
 */
export function privateDirectory(directory, name = "") {
  const target = resolve(directory, name);
  const suffix = relative(directory, target);
  if (isAbsolute(suffix) || suffix === ".." || suffix.startsWith(`..${sep}`)) throw new Error("Private directory must stay inside its owned root.");
  let path = directory;
  for (const part of ["", ...(suffix ? suffix.split(sep) : [])]) {
    path = join(path, part);
    const stat = lstatSync(path, { throwIfNoEntry: false });
    if (stat && (!stat.isDirectory() || stat.uid !== process.getuid())) throw new Error(`Refusing linked, non-directory or foreign-owned private directory: ${path}`);
    if (!stat) mkdirSync(path, { mode: 0o700 });
    chmodSync(path, 0o700);
  }
  return target;
}

/**
 * Atomically replace an owned single-link private file, defaulting to 0600; executable wrappers explicitly use 0700.
 */
export function privateFile(path, content, mode = 0o600) {
  privateFileStat(path);
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, content, { mode, flag: "wx" });
    chmodSync(temporary, mode);
    renameSync(temporary, path);
  } finally { rmSync(temporary, { force: true }); }
}

/**
 * Load a versioned manifest only when checkout, directory, project hash and stack ID establish ownership.
 * @returns {object | null} Validated recovery state, or null when no manifest exists.
 */
export function readState(root, directory) {
  const path = join(directory, "manifest.json");
  statePath(root, { SPACE_DEV_STATE_DIR: directory });
  if (!privateFileStat(path)) return null;
  const state = JSON.parse(readFileSync(path, "utf8"));
  const project = `spaceapp-dev-${createHash("sha256").update(directory).digest("hex").slice(0, 12)}`;
  if (state.version !== 1 || state.root !== root || state.directory !== directory || state.project !== project || !/^[a-f0-9]{32}$/.test(state.id)) throw new Error("State manifest does not belong to this checkout; refusing to adopt or remove it.");
  resolvePorts(Object.fromEntries(Object.entries(state.ports).map(([key, value]) => [`SPACE_DEV_${key.toUpperCase()}_PORT`, String(value)])));
  return state;
}

/**
 * Reuse owned state and secrets without changing its ports, or initialize an empty private directory.
 * Refuse adoption of pre-existing data without a matching ownership manifest.
 */
export function initializeState(root, directory, env = process.env) {
  const saved = readState(root, directory);
  if (saved) {
    privateDirectory(directory);
    for (const name of Object.keys(defaultPorts)) {
      const key = `SPACE_DEV_${name.toUpperCase()}_PORT`;
      if (env[key] !== undefined && Number(env[key]) !== saved.ports[name]) throw new Error(`${key} differs from saved state; reset this stack before changing ports.`);
    }
    return saved;
  }
  if (existsSync(directory) && readdirSync(directory).length) throw new Error("State directory is not empty and has no ownership manifest; refusing to adopt it.");
  privateDirectory(directory);
  const state = { version: 1, root, directory, id: randomBytes(16).toString("hex"), ports: resolvePorts(env), project: `spaceapp-dev-${createHash("sha256").update(directory).digest("hex").slice(0, 12)}`, pins: readPins(root), processes: [] };
  saveState(state);
  return state;
}

/**
 * Persist the recovery manifest atomically with private permissions after process or runtime changes.
 */
export function saveState(state) {
  privateDirectory(state.directory);
  privateFile(join(state.directory, "manifest.json"), `${JSON.stringify(state, null, 2)}\n`);
}

/**
 * Reuse a verified owned temporary directory or create a short private directory for Unix sockets.
 * Ownership is checked again before reset may delete this directory outside the checkout.
 */
export function runtimeDirectory(state) {
  if (state.runtime && lstatSync(state.runtime, { throwIfNoEntry: false })) {
    if (!/^spaceapp-dev-[a-zA-Z0-9]+$/.test(basename(state.runtime))) throw new Error("Invalid runtime directory name.");
    const marker = join(state.runtime, "owner.json");
    const allowedParents = [realpathSync(tmpdir()), realpathSync("/tmp")];
    if (!allowedParents.includes(realpathSync(dirname(state.runtime)))) throw new Error("Runtime directory must be in the system temporary directory.");
    const stat = lstatSync(state.runtime);
    if (stat.isDirectory() && stat.uid === process.getuid() && privateFileStat(marker) && JSON.parse(readFileSync(marker, "utf8")).id === state.id) {
      privateDirectory(state.runtime);
      return state.runtime;
    }
    throw new Error("Runtime directory ownership check failed; preserving state for inspection.");
  }
  // macOS socket paths are limited to about 104 bytes. Keep sockets outside deep checkouts.
  const base = realpathSync(tmpdir());
  const directory = mkdtempSync(join(base.length < 35 ? base : "/tmp", "spaceapp-dev-"));
  chmodSync(directory, 0o700);
  privateFile(join(directory, "owner.json"), JSON.stringify({ id: state.id }));
  state.runtime = directory;
  saveState(state);
  return directory;
}

/**
 * Create or validate per-stack 256-bit secrets and write private database and Temporal environment files.
 * The password reaches Temporal via Compose env_file, without weakening its file permissions.
 */
export function ensureSecrets(state) {
  const directory = privateDirectory(state.directory, "secrets");
  /**
   * Read or generate a 64-hex-character secret, refusing links and restoring mode 0600 only on owned files.
   */
  const secret = (name) => {
    const path = join(directory, name);
    if (!privateFileStat(path, "secret file")) privateFile(path, `${randomBytes(32).toString("hex")}\n`);
    chmodSync(path, 0o600);
    const value = readFileSync(path, "utf8").trim();
    if (!/^[a-f0-9]{64}$/.test(value)) throw new Error(`Invalid secret content: ${name}`);
    return value;
  };
  const password = secret("postgres-password");
  const session = secret("session-secret");
  const setup = secret("setup-token");
  const database = `postgresql://spaceapp:${password}@127.0.0.1:${state.ports.postgres}/spaceapp_dev`;
  privateFile(join(directory, "database-url"), `${database}\n`);
  // Temporal runs as an unprivileged container user. Compose injects this private
  // env file, avoiding unreadable 0600 bind mounts or world-readable passwords.
  privateFile(join(directory, "temporal.env"), `POSTGRES_PWD=${password}\n`);
  return { password, session, setup, database };
}

/**
 * Render isolated PostgreSQL and Temporal services with loopback ports and readiness health checks.
 * Keep secret values out of the generated definition; Docker receives private file references.
 */
export function composeDefinition(state) {
  /**
   * Publish a container port exclusively on IPv4 loopback, avoiding remote exposure of the dev stack.
   */
  const ports = (host, container) => [`127.0.0.1:${host}:${container}`];
  return {
    services: {
      postgres: {
        image: state.pins.postgres, environment: { POSTGRES_DB: "spaceapp_dev", POSTGRES_USER: "spaceapp", POSTGRES_PASSWORD_FILE: "/run/secrets/postgres-password" },
        secrets: ["postgres-password"], volumes: ["postgres:/var/lib/postgresql/data"], ports: ports(state.ports.postgres, 5432),
        healthcheck: { test: ["CMD-SHELL", "pg_isready -U spaceapp -d spaceapp_dev"], interval: "2s", timeout: "5s", retries: 60 }
      },
      temporal: {
        image: state.pins.temporal, depends_on: { postgres: { condition: "service_healthy" } }, env_file: ["./secrets/temporal.env"],
        environment: { DB: "postgres12", DB_PORT: "5432", POSTGRES_USER: "spaceapp", POSTGRES_SEEDS: "postgres", DEFAULT_NAMESPACE: "spaceapp-dev", DYNAMIC_CONFIG_FILE_PATH: "config/dynamicconfig/docker.yaml" },
        ports: ports(state.ports.temporal, 7233),
        healthcheck: { test: ["CMD-SHELL", "temporal operator cluster health --address temporal:7233 >/dev/null && temporal operator namespace describe --namespace spaceapp-dev --address temporal:7233 >/dev/null"], interval: "3s", timeout: "10s", retries: 60 }
      }
    },
    secrets: { "postgres-password": { file: "./secrets/postgres-password" } },
    volumes: { postgres: { labels: { "io.spaceapp.dev-stack": state.id } } },
    networks: { default: { labels: { "io.spaceapp.dev-stack": state.id } } }
  };
}

/**
 * Build an allowlisted service environment with owned data paths and real PostgreSQL/Temporal enabled.
 * Exclude inherited provider credentials, installed configuration and NODE_OPTIONS from source services.
 */
export function serviceEnvironment(state, secrets, base = process.env) {
  const env = {};
  // Do not inherit provider accounts, installed SPACE_* configuration, NODE_OPTIONS
  // or dotenv files from the launching shell.
  for (const key of ["PATH", "LANG", "LC_ALL", "TERM", "COLORTERM", "USER", "LOGNAME", "SystemRoot"]) if (base[key]) env[key] = base[key];
  /**
   * Resolve a service data path under this stack's private checkout-local data directory.
   */
  const data = (...parts) => join(state.directory, "data", ...parts);
  const memory = data("memory");
  return {
    ...env, NODE_ENV: "development", HOME: data("home"), TMPDIR: join(state.runtime, "tmp"), SHELL: "/bin/sh",
    PATH: `${join(state.directory, "bin")}:${dirname(process.execPath)}:${env.PATH || "/usr/local/bin:/usr/bin:/bin"}`,
    SPACE_INSTANCE: "dev", SPACE_INSTANCE_ENABLED_JOBS: "", SPACE_PUBLIC_DISTRIBUTION: "true", SPACE_DEV_LOGIN: "false",
    SPACE_TELEMETRY_ENABLED: "false", SPACE_OPTIONAL_MODULES: "none", SPACE_RUNTIME_STORE: "postgres", SPACE_DATABASE_URL: secrets.database,
    SPACE_PG_SOCKET_PATH: join(state.runtime, "postgres-disabled.sock"),
    SPACE_SESSION_SECRET: secrets.session, SPACE_SETUP_TOKEN_FILE: join(state.directory, "secrets/setup-token"),
    SPACE_API_HOST: "127.0.0.1", SPACE_API_PORT: String(state.ports.api), SPACE_API_ORIGIN: `http://127.0.0.1:${state.ports.api}`,
    SPACE_WEB_HOST: "127.0.0.1", SPACE_WEB_PORT: String(state.ports.web),
    SPACE_BROWSER_EVIDENCE_TARGET_ORIGIN: `http://127.0.0.1:${state.ports.web}`,
    SPACE_TEMPORAL_ADDRESS: `127.0.0.1:${state.ports.temporal}`, SPACE_TEMPORAL_NAMESPACE: "spaceapp-dev", SPACE_TEMPORAL_TASK_QUEUE: "spaceapp-dev-turns", SPACEAPP_WORKFLOWS_ENABLED: "true",
    SPACE_CLI_ENABLED: "true", SPACE_CLI_ROOT_ENABLED: "false", SPACE_CLI_VPN_ENABLED: "false", SPACE_CLI_MAINTENANCE_REPAIR_ENABLED: "false",
    SPACE_CLI_HOST_SOCKET: join(state.runtime, "cli.sock"), SPACE_CLI_ADMIN_HOST_SOCKET: join(state.runtime, "admin-disabled.sock"),
    SPACE_CLI_COMMAND_PATH: join(state.directory, "bin"), SPACE_CLI_WORKSPACE_ROOT: data("workspaces"),
    SPACE_ARTIFACT_ROOT: data("artifacts"), SPACE_WORKFLOW_ARTIFACTS_ROOT: data("artifacts"), SPACE_MEMORY_ROOT: memory,
    SPACE_STARTER_MEMORY_ROOT: join(state.root, "starter-memory"), SPACE_MEMORY_GRAPH_ROOT: data("memory-graph"),
    SPACE_MEMORY_INDEX_PATH: join(memory, "space_memory.md"), SPACE_MEMORY_MONTHLY_PATH: join(memory, "space_memory_monthly.md"), SPACE_MEMORY_LOCK_PATH: join(memory, ".memory.lock"),
    SPACE_APP_DIAGNOSTICS_ROOT: data("app-diagnostics"), SPACE_MAINTENANCE_AUTOPILOT_STATE_FILE: data("maintenance", "state.json"), SPACE_CLI_ACCOUNT_BALANCER_STATE_FILE: data("account-balancer", "state.json"),
    SPACE_TELEGRAM_SECRET_ROOT: data("telegram"), SPACE_TELEGRAM_OWNERSHIP_MANIFEST: data("integrations", "telegram.json"), SPACE_STREAMING_SECRET_ROOT: data("streaming-secrets"),
    SPACE_CODEX_HOME: data("providers", "codex"), SPACE_CODEX_APP_SERVER_HOME: data("providers", "codex"), SPACE_CODEX_GOALS_DB_PATH: data("codex-goals.sqlite"), SPACE_CODEX_CLI_MODE_DEFAULTS_PROJECTION_PATH: data("codex-defaults.json"),
    SPACE_CODEX_APP_SERVER_COMMAND: join(state.directory, "bin", "codex-unavailable"), SPACE_CODEX_ROUTE_COMMAND: join(state.directory, "bin", "codex-unavailable"),
    SPACE_OPENCODE_STATE_ROOT: data("providers", "opencode"), SPACE_BROWSER_SESSIONS_ENABLED: "false", SPACE_BROWSER_EVIDENCE_ENABLED: "false", SPACE_BROWSER_TOOL_BRIDGE_ENABLED: "false", SPACE_DOT_TOOL_GATEWAY: "disabled",
    SPACE_BROWSER_HOST_SOCKET: join(state.runtime, "browser-disabled.sock"), SPACE_CHESS_MOVE_SOCKET: "disabled", SPACE_T3CODE_ENABLED: "false", SPACE_T3CODE_SOCKET: join(state.runtime, "t3-disabled.sock"),
    SPACE_GOOGLE_AUTH_DISABLED: "true", SPACE_AGENT_TOOLS_WRITER: "disabled", SPACE_ROOM_AGENT_AUTOPILOT_ENABLED: "false",
    SPACE_DEMO_PROJECTS_ROOT: join(state.root, "demos"), SPACE_DEMO_PROJECTS_VAR_ROOT: data("demo-projects"), SPACE_DEMO_PROJECTS_ENABLED: "false", SPACE_PROJECTS_ROOT: data("projects"), SPACE_LIVE_VOICE_LOG_ROOT: data("live-voice-logs"), SPACE_PLUGINS_ROOT: data("plugins"), SPACE_PERSONAL_GIT_ROOT: data("personal-source-control"), SPACE_AGENT_FILE_DOCX_WORK_ROOT: data("agent-docx-work"), SPACE_INSTALL_ROOT: state.directory, SPACE_DOT_WORKSPACE_ROOT: data("dots"),
    SPACE_GIT_ROOT: state.root, SPACE_REPO_ROOT: state.root
  };
}
