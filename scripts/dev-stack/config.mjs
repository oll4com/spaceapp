import { createHash } from "node:crypto";
import { readFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { privateWrite } from "./state.mjs";

/** Read the published source of truth; fail rather than silently running an unpinned image. */
export function imagePins(template) {
  return Object.fromEntries(["postgres", "temporal"].map((name) => {
    const block = template.match(new RegExp(`^  ${name}:\\n([\\s\\S]*?)(?=^  [a-z]|^\\S|$(?![\\s\\S]))`, "m"))?.[1];
    const pin = block?.match(/^ {4}image: (\S+@sha256:[a-f0-9]{64})$/m)?.[1];
    if (!pin) throw new Error(`Missing pinned ${name} image in launcher template.`);
    return [name, pin];
  }));
}
export function openCodePin(dockerfile) {
  const pins = [...dockerfile.matchAll(/(?:@opencode\/cli|opencode-ai)@\d+\.\d+\.\d+/g)].map(([pin]) => pin);
  if (new Set(pins).size !== 1) throw new Error("Dockerfile must declare one pinned OpenCode version.");
  return pins[0];
}
export async function composeConfig(state) {
  const pins = imagePins(await readFile(join(state.root, "packages/run-spaceapp/templates/compose.yml"), "utf8"));
  const password = (await readFile(join(state.dir, "secrets/postgres-password"), "utf8")).trim();
  const health = (test) => ({ test: ["CMD-SHELL", test], interval: "3s", timeout: "10s", retries: 60 });
  return { name: state.project, services: {
    postgres: { image: pins.postgres, environment: { POSTGRES_DB: "spaceapp_dev", POSTGRES_USER: "spaceapp", POSTGRES_PASSWORD: password },
      ports: [`127.0.0.1:${state.ports.postgres}:5432`], volumes: ["postgres:/var/lib/postgresql/data"],
      healthcheck: health("pg_isready -U spaceapp -d spaceapp_dev"), labels: { "spaceapp.dev.owner": state.id } },
    temporal: { image: pins.temporal, environment: { DB: "postgres12", DB_PORT: "5432", POSTGRES_USER: "spaceapp", POSTGRES_SEEDS: "postgres", DYNAMIC_CONFIG_FILE_PATH: "config/dynamicconfig/docker.yaml", DEFAULT_NAMESPACE: "spaceapp-dev", POSTGRES_PWD: password },
      ports: [`127.0.0.1:${state.ports.temporal}:7233`], depends_on: { postgres: { condition: "service_healthy" } },
      healthcheck: health("temporal operator cluster health --address temporal:7233 >/dev/null && temporal operator namespace describe --namespace spaceapp-dev --address temporal:7233 >/dev/null"), labels: { "spaceapp.dev.owner": state.id } }
  }, volumes: { postgres: { labels: { "spaceapp.dev.owner": state.id } } },
  networks: { default: { labels: { "spaceapp.dev.owner": state.id } } } };
}

/** Inherit tools/locale only, never operator SPACE_* configuration or provider credentials. */
export function toolEnv(source = process.env) {
  return Object.fromEntries(["PATH", "LANG", "LC_ALL", "TZ", "SYSTEMROOT"].filter((key) => source[key] !== undefined).map((key) => [key, source[key]]));
}
export async function applicationEnv(state, source = process.env) {
  const d = state.dir, owned = (...paths) => join(d, ...paths);
  const secret = async (name) => (await readFile(owned("secrets", name), "utf8")).trim();
  const env = { ...toolEnv(source), HOME: owned("home"), TMPDIR: join(state.sockets, "tmp"), NODE_ENV: "development",
    XDG_CONFIG_HOME: owned("home/.config"), XDG_DATA_HOME: owned("home/.local/share"), XDG_CACHE_HOME: owned("home/.cache"), XDG_STATE_HOME: owned("home/.local/state"),
    SPACE_INSTANCE: "dev", SPACE_INSTANCE_ENABLED_JOBS: "", SPACE_PUBLIC_DISTRIBUTION: "true", SPACEAPP_WORKFLOWS_ENABLED: "true",
    SPACE_RUNTIME_STORE: "postgres", SPACE_DATABASE_URL: `postgres://spaceapp:${await secret("postgres-password")}@127.0.0.1:${state.ports.postgres}/spaceapp_dev`,
    SPACE_SESSION_SECRET: await secret("session-secret"), SPACE_SETUP_TOKEN_FILE: owned("secrets/setup-token"), SPACE_DEV_LOGIN: "false", SPACE_GOOGLE_AUTH_DISABLED: "true",
    SPACE_API_HOST: "127.0.0.1", SPACE_API_PORT: String(state.ports.api), SPACE_API_ORIGIN: `http://127.0.0.1:${state.ports.api}`,
    SPACE_WEB_HOST: "127.0.0.1", SPACE_WEB_PORT: String(state.ports.web), SPACE_TEMPORAL_ADDRESS: `127.0.0.1:${state.ports.temporal}`,
    SPACE_TEMPORAL_NAMESPACE: "spaceapp-dev", SPACE_TEMPORAL_TASK_QUEUE: "spaceapp-dev-turns",
    SPACE_CLI_ENABLED: "true", SPACE_CLI_COMMAND_PATH: owned("bin"), SPACE_CLI_WORKSPACE_ROOT: owned("workspaces"), SPACE_CLI_HOST_SOCKET: join(state.sockets, "cli.sock"),
    SPACE_CLI_ROOT_ENABLED: "false", SPACE_CLI_VPN_ENABLED: "false", SPACE_CLI_MAINTENANCE_REPAIR_ENABLED: "false", SPACE_CHESS_MOVE_SOCKET: "disabled",
    SPACE_INSTALL_ROOT: state.root, SPACE_PROJECTS_ROOT: owned("workspaces"), SPACE_FILES_HOST_MODE: "disabled", SPACE_DEMO_PROJECTS_ENABLED: "false",
    SPACE_BROWSER_SESSIONS_ENABLED: "false", SPACE_BROWSER_EVIDENCE_ENABLED: "false", SPACE_T3CODE_ENABLED: "false", SPACE_AGENT_TOOLS_WRITER: "disabled",
    SPACE_CODEX_APP_SERVER_ENABLED: "false", SPACE_ROOM_AGENT_MONITOR_ENABLED: "false", SPACE_ROOM_AGENT_AUTOPILOT_ENABLED: "false", SPACE_DOT_TOOL_GATEWAY: "disabled",
    SPACE_OPTIONAL_MODULES: "", SPACE_TELEMETRY_ENABLED: "false", SPACE_ENABLE_DB_SWEEP: "false",
    OPENCODE_SERVER_USERNAME: "opencode", OPENCODE_SERVER_PASSWORD: await secret("opencode-password"),
    OPENCODE_DISABLE_AUTOUPDATE: "true"
  };
  const paths = { ARTIFACT_ROOT: "artifacts", MEMORY_ROOT: "memory", MEMORY_INDEX_PATH: "memory/space_memory.md", MEMORY_MONTHLY_PATH: "memory/space_memory_monthly.md", MEMORY_LOCK_PATH: "memory/.memory.lock",
    MEMORY_GRAPH_ROOT: "memory-graph", CODEX_HOME: "providers/codex", CODEX_APP_SERVER_HOME: "providers/codex", CODEX_GOALS_DB_PATH: "codex-goals.sqlite",
    CODEX_CLI_MODE_DEFAULTS_PROJECTION_PATH: "codex-cli-mode-defaults.json", APP_DIAGNOSTICS_ROOT: "diagnostics", MAINTENANCE_AUTOPILOT_STATE_FILE: "maintenance/state.json", CLI_ACCOUNT_BALANCER_STATE_FILE: "accounts/state.json",
    TELEGRAM_SECRET_ROOT: "telegram", TELEGRAM_OWNERSHIP_MANIFEST: "telegram/ownership.json", STREAMING_SECRET_ROOT: "streaming", CONNECTOR_KEY_FILE: "secrets/connector.key",
    VIDEO_WORK_ROOT: "video", VIDEO_TOOLS_DIR: "video/tools", DESIGN_GATEWAY_KEY_FILE: "secrets/design.key", DOT_WORKSPACE_ROOT: "workspaces/dot" };
  for (const [key, path] of Object.entries(paths)) env[`SPACE_${key}`] = owned(path);
  for (const key of ["TMPDIR", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME", "SPACE_CODEX_HOME"]) await mkdir(env[key], { recursive: true, mode: 0o700 });
  return env;
}

const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
/** The PTY execs the real pinned CLI; its server and all provider state belong to this stack. */
export async function writeWrapper(state, env) {
  const binary = join(state.dir, "vendor/node_modules/.bin/opencode");
  const fingerprint = createHash("sha256").update(await readFile(join(state.dir, "vendor/pin"), "utf8")).digest("hex");
  const vars = Object.fromEntries(["HOME", "TMPDIR", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME", "OPENCODE_SERVER_USERNAME", "OPENCODE_SERVER_PASSWORD", "OPENCODE_DISABLE_AUTOUPDATE"].map((key) => [key, env[key]]));
  const script = `#!/bin/sh\nset -eu\n${Object.entries(vars).map(([key, value]) => `export ${key}=${quote(value)}`).join("\n")}\nexport PATH=${quote(dirname(process.execPath) + ":/usr/bin:/bin")}\n[ "\${1:-}" != --run-inner ] || shift\ncase "\${1:-}" in\ncredential-status) [ -x ${quote(binary)} ] && printf 'READY\\n'; exit ;;\ncredential-observation) [ -x ${quote(binary)} ] && printf 'OBSERVATION:${fingerprint}\\n'; exit ;;\ncredential-smoke) echo 'Provider inference is not part of the contributor stack.' >&2; exit 1 ;;\nesac\nexec ${quote(binary)} --server ${quote(`http://127.0.0.1:${state.ports.opencode}`)} "$@" "$PWD"\n`;
  await privateWrite(join(state.dir, "bin/opencode-vscode-parity"), script);
  const { chmod } = await import("node:fs/promises");
  await chmod(join(state.dir, "bin/opencode-vscode-parity"), 0o700);
}
