import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve, dirname, basename } from "node:path";
import { tmpdir } from "node:os";

export const defaultPorts = { api: 5910, web: 5911, postgres: 55432, temporal: 57233 };
export const packageWorkspaces = ["contracts", "icons", "streaming", "opencode-control", "memory-graph", "browser-host", "cli-host", "codex-app-server", "runtime", "db", "gateway"];

export function readPins(root) {
  const template = readFileSync(join(root, "packages/run-spaceapp/templates/compose.yml"), "utf8");
  const image = (name) => {
    const matches = [...template.matchAll(/^\s+image:\s*(\S+)/gm)].map((m) => m[1]).filter((s) => s.startsWith(`${name}:`));
    if (matches.length !== 1 || !/@sha256:[a-f0-9]{64}$/.test(matches[0])) throw new Error(`Expected one digest-pinned ${name} image in the launcher template.`);
    return matches[0];
  };
  const version = readFileSync(join(root, "Dockerfile"), "utf8").match(/\bopencode-ai@(\d+\.\d+\.\d+)(?=[\s\\])/);
  if (!version) throw new Error("Dockerfile must pin an exact opencode-ai version.");
  return { postgres: image("pgvector/pgvector"), temporal: image("temporalio/auto-setup"), opencode: version[1] };
}

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
export function statePath(root, env = process.env) {
  const requested = resolve(root, env.SPACE_DEV_STATE_DIR || ".dev-stack");
  if (dirname(requested) !== root || !/^\.dev-stack(?:-[a-zA-Z0-9_-]+)?$/.test(basename(requested))) throw new Error("SPACE_DEV_STATE_DIR must be .dev-stack or a sibling .dev-stack-NAME in this checkout.");
  if (existsSync(requested) && (lstatSync(requested).isSymbolicLink() || !lstatSync(requested).isDirectory())) throw new Error("Refusing a symlink or non-directory dev state path.");
  return requested;
}

export function privateFile(path, content) {
  if (existsSync(path) && (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink())) throw new Error(`Expected a regular private file: ${basename(path)}`);
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, content, { mode: 0o600, flag: "wx" });
  renameSync(temporary, path);
  chmodSync(path, 0o600);
}

export function readState(root, directory) {
  const path = join(directory, "manifest.json");
  if (!existsSync(path)) return null;
  if (lstatSync(path).isSymbolicLink() || !lstatSync(path).isFile()) throw new Error("Refusing a symlink or non-file manifest.");
  const state = JSON.parse(readFileSync(path, "utf8"));
  const project = `spaceapp-dev-${createHash("sha256").update(directory).digest("hex").slice(0, 12)}`;
  if (state.version !== 1 || state.root !== root || state.directory !== directory || state.project !== project || !/^[a-f0-9]{32}$/.test(state.id)) throw new Error("State manifest does not belong to this checkout; refusing to adopt or remove it.");
  resolvePorts(Object.fromEntries(Object.entries(state.ports).map(([key, value]) => [`SPACE_DEV_${key.toUpperCase()}_PORT`, String(value)])));
  return state;
}

export function initializeState(root, directory, env = process.env) {
  const saved = readState(root, directory);
  if (saved) {
    chmodSync(directory, 0o700);
    for (const name of Object.keys(defaultPorts)) {
      const key = `SPACE_DEV_${name.toUpperCase()}_PORT`;
      if (env[key] !== undefined && Number(env[key]) !== saved.ports[name]) throw new Error(`${key} differs from saved state; reset this stack before changing ports.`);
    }
    return saved;
  }
  if (existsSync(directory) && readdirSync(directory).length) throw new Error("State directory is not empty and has no ownership manifest; refusing to adopt it.");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const state = { version: 1, root, directory, id: randomBytes(16).toString("hex"), ports: resolvePorts(env), project: `spaceapp-dev-${createHash("sha256").update(directory).digest("hex").slice(0, 12)}`, pins: readPins(root), processes: [] };
  saveState(state);
  return state;
}

export function saveState(state) { privateFile(join(state.directory, "manifest.json"), `${JSON.stringify(state, null, 2)}\n`); }

export function runtimeDirectory(state) {
  if (state.runtime && existsSync(state.runtime)) {
    if (!/^spaceapp-dev-[a-zA-Z0-9]+$/.test(basename(state.runtime))) throw new Error("Invalid runtime directory name.");
    const marker = join(state.runtime, "owner.json");
    const allowedParents = [realpathSync(tmpdir()), realpathSync("/tmp")];
    if (!allowedParents.includes(realpathSync(dirname(state.runtime)))) throw new Error("Runtime directory must be in the system temporary directory.");
    if (existsSync(marker) && !lstatSync(state.runtime).isSymbolicLink() && JSON.parse(readFileSync(marker, "utf8")).id === state.id) return state.runtime;
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

export function ensureSecrets(state) {
  const directory = join(state.directory, "secrets");
  if (existsSync(directory) && lstatSync(directory).isSymbolicLink()) throw new Error("Refusing symlink secrets directory.");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const secret = (name) => {
    const path = join(directory, name);
    if (!existsSync(path)) privateFile(path, `${randomBytes(32).toString("hex")}\n`);
    if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) throw new Error(`Invalid secret file: ${name}`);
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

export function composeDefinition(state) {
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

export function serviceEnvironment(state, secrets, base = process.env) {
  const env = {};
  // Do not inherit provider accounts, installed SPACE_* configuration, NODE_OPTIONS
  // or dotenv files from the launching shell.
  for (const key of ["PATH", "LANG", "LC_ALL", "TERM", "COLORTERM", "USER", "LOGNAME", "SystemRoot"]) if (base[key]) env[key] = base[key];
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
    SPACE_GEMINI_MEMORY_INDEX_PATH: join(memory, "gemini_history.md"), SPACE_GEMINI_MEMORY_MONTHLY_PATH: join(memory, "gemini_history_monthly.md"), SPACE_GEMINI_MEMORY_LOCK_PATH: join(memory, ".memory.lock"),
    SPACE_APP_DIAGNOSTICS_ROOT: data("app-diagnostics"), SPACE_MAINTENANCE_AUTOPILOT_STATE_FILE: data("maintenance", "state.json"), SPACE_CLI_ACCOUNT_BALANCER_STATE_FILE: data("account-balancer", "state.json"),
    SPACE_TELEGRAM_SECRET_ROOT: data("telegram"), SPACE_TELEGRAM_OWNERSHIP_MANIFEST: data("integrations", "telegram.json"), SPACE_STREAMING_SECRET_ROOT: data("streaming-secrets"),
    SPACE_CODEX_HOME: data("providers", "codex"), SPACE_CODEX_APP_SERVER_HOME: data("providers", "codex"), SPACE_CODEX_GOALS_DB_PATH: data("codex-goals.sqlite"), SPACE_CODEX_CLI_MODE_DEFAULTS_PROJECTION_PATH: data("codex-defaults.json"),
    SPACE_CODEX_APP_SERVER_COMMAND: join(state.directory, "bin", "codex-unavailable"), SPACE_CODEX_ROUTE_COMMAND: join(state.directory, "bin", "codex-unavailable"),
    SPACE_OPENCODE_STATE_ROOT: data("providers", "opencode"), SPACE_BROWSER_SESSIONS_ENABLED: "false", SPACE_BROWSER_EVIDENCE_ENABLED: "false", SPACE_BROWSER_TOOL_BRIDGE_ENABLED: "false", SPACE_DOT_TOOL_GATEWAY: "disabled",
    SPACE_BROWSER_HOST_SOCKET: join(state.runtime, "browser-disabled.sock"), SPACE_CHESS_MOVE_SOCKET: "disabled", SPACE_T3CODE_ENABLED: "false", SPACE_T3CODE_SOCKET: join(state.runtime, "t3-disabled.sock"),
    SPACE_GOOGLE_AUTH_DISABLED: "true", SPACE_AGENT_TOOLS_WRITER: "disabled", SPACE_ROOM_AGENT_AUTOPILOT_ENABLED: "false",
    SPACE_DEMO_PROJECTS_ROOT: join(state.root, "demos"), SPACE_DEMO_PROJECTS_VAR_ROOT: data("demo-projects"), SPACE_DEMO_PROJECTS_ENABLED: "false", SPACE_PROJECTS_ROOT: data("projects"), SPACE_INSTALL_ROOT: state.directory, SPACE_DOT_WORKSPACE_ROOT: data("dots"),
    SPACE_GIT_ROOT: state.root, SPACE_REPO_ROOT: state.root
  };
}
