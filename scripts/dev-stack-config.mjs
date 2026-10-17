/** Pure configuration for the checkout-local source development stack. */
import fs from "node:fs";
import { dirname, delimiter, isAbsolute, join, normalize } from "node:path";

const PORTS = {
  api: ["SPACE_DEV_API_PORT", 5910],
  web: ["SPACE_DEV_WEB_PORT", 5911],
  postgres: ["SPACE_DEV_POSTGRES_PORT", 55432],
  temporal: ["SPACE_DEV_TEMPORAL_PORT", 57233],
};
const PASSWORD_REFERENCE = "${DEV_STACK_POSTGRES_PASSWORD}";

function requireCondition(condition, message) {
  if (!condition) throw new Error(`DEV_STACK_CONFIG: ${message}`);
}

function validatePorts(ports) {
  const values = Object.keys(PORTS).map((key) => ports?.[key]);
  requireCondition(values.every((port) => Number.isInteger(port) && port >= 1 && port <= 65535),
    "Ports must be integers between 1 and 65535.");
  requireCondition(values.every((port) => port !== 4910 && port !== 4911),
    "Stable ports 4910 and 4911 must not be used by the development stack.");
  requireCondition(new Set(values).size === values.length, "Development ports must be distinct.");
}

/** Explicit malformed/empty overrides are errors, not requests for defaults. */
export function resolvePorts(env = process.env) {
  const ports = {};
  for (const [key, [variable, fallback]] of Object.entries(PORTS)) {
    const raw = env[variable];
    requireCondition(raw === undefined || (typeof raw === "string" && /^[0-9]+$/u.test(raw.trim())),
      `${variable} must contain a decimal integer.`);
    ports[key] = raw === undefined ? fallback : Number(raw.trim());
  }
  validatePorts(ports);
  return ports;
}

function pinnedImage(image, service) {
  requireCondition(typeof image === "string" && /^[a-z0-9][a-z0-9./:_-]*@sha256:[a-f0-9]{64}$/u.test(image),
    `${service} must use an explicit sha256-pinned image from the release template.`);
  return image;
}

/** Read only the two service images from the single release compose template. */
export function readImages(repoRoot) {
  const source = fs.readFileSync(join(repoRoot, "packages", "run-spaceapp", "templates", "compose.yml"), "utf8");
  const serviceRoots = [...source.matchAll(/^services:[ \t]*\r?\n([\s\S]*?)(?=^\S|(?![\s\S]))/gm)];
  requireCondition(serviceRoots.length === 1, "Expected exactly one services root in the release template.");
  const images = {};
  for (const service of ["postgres", "temporal"]) {
    const sections = [...serviceRoots[0][1].matchAll(new RegExp(`^  ${service}:[ \\t]*\\r?\\n([\\s\\S]*?)(?=^  [a-zA-Z0-9_-]+:|(?![\\s\\S]))`, "gm"))];
    requireCondition(sections.length === 1, `Expected exactly one ${service} service in the release template.`);
    const matches = [...sections[0][1].matchAll(/^    image:[ \t]*([^\r\n]+)$/gm)];
    requireCondition(matches.length === 1, `Expected exactly one image for ${service}.`);
    const value = matches[0][1].trim();
    const unquoted = /^(["']).*\1$/u.test(value) ? value.slice(1, -1) : value;
    images[service] = pinnedImage(unquoted, service);
  }
  return images;
}

/** Reuse the CLI version fixed by the original source Dockerfile. */
export function readOpenCodeVersion(repoRoot) {
  const source = fs.readFileSync(join(repoRoot, "Dockerfile"), "utf8");
  const versions = [...source.matchAll(/\bopencode-ai@([0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?)(?=\s|\\|$)/gu)]
    .map((match) => match[1]);
  requireCondition(versions.length === 1, "Expected one pinned opencode-ai version in Dockerfile.");
  return versions[0];
}

function validateState(state) {
  requireCondition(state && typeof state.project === "string" && /^space-dev-[a-f0-9]{24}$/u.test(state.project),
    "A validated checkout project identity is required.");
  requireCondition(typeof state.repoRoot === "string" && isAbsolute(state.repoRoot)
    && state.repoRoot === normalize(state.repoRoot), "The canonical checkout root must be absolute.");
  requireCondition(state.stateDir === join(state.repoRoot, ".dev-stack"),
    "State must be the fixed .dev-stack child of the checkout.");
  validatePorts(state.ports);
}

/** No app containers, host workspace mounts, external volumes or stable ports. */
export function composeConfig(state, images) {
  validateState(state);
  const postgres = pinnedImage(images?.postgres, "postgres");
  const temporal = pinnedImage(images?.temporal, "temporal");
  return {
    name: state.project,
    services: {
      postgres: {
        image: postgres,
        environment: {
          POSTGRES_DB: "spaceapp_dev", POSTGRES_USER: "spaceapp",
          POSTGRES_PASSWORD: PASSWORD_REFERENCE,
        },
        ports: [`127.0.0.1:${state.ports.postgres}:5432`],
        volumes: ["postgres:/var/lib/postgresql/data"],
        healthcheck: {
          test: ["CMD-SHELL", "pg_isready -U spaceapp -d spaceapp_dev"],
          interval: "10s", timeout: "5s", retries: 10,
        },
      },
      temporal: {
        image: temporal,
        depends_on: { postgres: { condition: "service_healthy" } },
        environment: {
          DB: "postgres12", DB_PORT: "5432", POSTGRES_USER: "spaceapp", POSTGRES_SEEDS: "postgres",
          POSTGRES_PWD: PASSWORD_REFERENCE,
          DYNAMIC_CONFIG_FILE_PATH: "config/dynamicconfig/docker.yaml",
          DEFAULT_NAMESPACE: state.project,
        },
        entrypoint: ["/etc/temporal/entrypoint.sh"],
        command: ["autosetup"],
        ports: [`127.0.0.1:${state.ports.temporal}:7233`],
        healthcheck: {
          test: ["CMD-SHELL", "temporal operator cluster health --address temporal:7233 >/dev/null"
            + ` && temporal operator namespace describe --namespace ${state.project} --address temporal:7233 >/dev/null`],
          interval: "15s", timeout: "10s", retries: 10,
        },
      },
    },
    volumes: {
      postgres: {
        name: `${state.project}-postgres`,
        // Compose supplies its reserved project label from the top-level name.
        labels: { "spaceapp.dev-stack.project": state.project },
      },
    },
  };
}

/**
 * Allowlist host executable/system/locale metadata, then set every app option.
 * This is process environment isolation, not a filesystem or network sandbox.
 * The CLI host runs from source on the host, with the same absolute workspace.
 */
export function serviceEnv(state) {
  validateState(state);
  const p = (...parts) => join(state.stateDir, ...parts);
  for (const [key, file] of Object.entries({
    postgresPassword: "postgres-password", sessionSecret: "session-secret", setupToken: "setup-token",
  })) {
    requireCondition(typeof state.secrets?.[key] === "string" && /^[a-f0-9]{64}$/u.test(state.secrets[key]),
      `Generated ${key} credential is missing or malformed.`);
    requireCondition(state.secretPaths?.[key] === p("secrets", file),
      `Generated ${key} credential path must remain inside checkout state.`);
  }
  const env = {};
  for (const key of ["SystemRoot", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "LANG", "LC_ALL", "LC_CTYPE", "TZ"]) {
    if (typeof process.env[key] === "string") env[key] = process.env[key];
  }
  const hostPath = process.env.PATH ?? process.env.Path ?? "";
  Object.assign(env, {
    PATH: [p("bin"), dirname(process.execPath), join(state.repoRoot, "node_modules", ".bin"), hostPath]
      .filter(Boolean).join(delimiter),
    NODE_ENV: "development",
    HOME: p("home"), USERPROFILE: p("home"),
    XDG_CONFIG_HOME: p("home", ".config"), XDG_DATA_HOME: p("home", ".local", "share"),
    XDG_STATE_HOME: p("home", ".local", "state"), XDG_CACHE_HOME: p("home", ".cache"),
    TMPDIR: p("tmp"), TMP: p("tmp"), TEMP: p("tmp"),
    APPDATA: p("home", "AppData", "Roaming"), LOCALAPPDATA: p("home", "AppData", "Local"),
    NPM_CONFIG_CACHE: p("cache", "npm"), NPM_CONFIG_USERCONFIG: p("home", ".npmrc"),
    NPM_CONFIG_GLOBALCONFIG: p("home", ".npmrc-global"),
    SPACE_INSTANCE: "dev", SPACE_INSTANCE_ENABLED_JOBS: "",
    SPACE_INSTALL_ROOT: state.repoRoot, SPACE_REPO_ROOT: state.repoRoot, SPACE_GIT_ROOT: state.repoRoot,
    SPACE_VAR_DIR: p("var"), SPACE_WORKSPACE_ROOT: p("workspaces"),
    SPACE_RUNTIME_STORE: "postgres",
    SPACE_DATABASE_URL: `postgresql://spaceapp:${encodeURIComponent(state.secrets.postgresPassword)}@127.0.0.1:${state.ports.postgres}/spaceapp_dev`,
    SPACE_SESSION_SECRET: state.secrets.sessionSecret,
    SPACE_SETUP_TOKEN_FILE: state.secretPaths.setupToken,
    SPACE_TEMPORAL_ADDRESS: `127.0.0.1:${state.ports.temporal}`,
    SPACE_TEMPORAL_NAMESPACE: state.project, SPACE_TEMPORAL_TASK_QUEUE: state.project,
    SPACE_API_HOST: "127.0.0.1", SPACE_API_PORT: String(state.ports.api),
    SPACE_WEB_HOST: "127.0.0.1", SPACE_WEB_PORT: String(state.ports.web),
    SPACE_API_ORIGIN: `http://127.0.0.1:${state.ports.api}`,
    SPACE_PUBLIC_DISTRIBUTION: "true", SPACE_DEV_LOGIN: "false", SPACEAPP_WORKFLOWS_ENABLED: "true",
    SPACE_TELEMETRY_ENABLED: "false", SPACE_AGENT_TOOLS_WRITER: "disabled", SPACE_OPTIONAL_MODULES: "none",
    SPACE_CLI_ENABLED: "true", SPACE_CLI_COMMAND_PATH: p("bin"), SPACE_CLI_WORKSPACE_ROOT: p("workspaces"),
    SPACE_CLI_HOST_SOCKET: p("h.sock"), SPACE_CLI_ROOT_ENABLED: "false",
    SPACE_CLI_ADMIN_HOST_SOCKET: p("admin-disabled.sock"), SPACE_CLI_VPN_ENABLED: "false",
    SPACE_CLI_MAINTENANCE_REPAIR_ENABLED: "false", SPACE_ENABLE_CLI_CHAT_TURNS: "false",
    SPACE_CODEX_APP_SERVER_ENABLED: "false", SPACE_CODEX_APP_SERVER_ALLOW_STDIO_SPAWN: "false",
    SPACE_CODEX_APP_SERVER_ALLOW_TURN_EXECUTION: "false", SPACE_CODEX_APP_SERVER_ALLOW_TURN_SMOKE: "false",
    SPACE_ENABLE_CODEX_TURNS: "false", SPACE_ENABLE_DUMMY_TURNS: "false",
    SPACE_T3CODE_ENABLED: "false", SPACE_T3CODE_SOCKET: p("t3-disabled.sock"),
    SPACE_CHESS_MOVE_SOCKET: "disabled",
    SPACE_BROWSER_SESSIONS_ENABLED: "false", SPACE_BROWSER_EVIDENCE_ENABLED: "false",
    SPACE_BROWSER_TOOL_BRIDGE_ENABLED: "false", SPACE_BROWSER_HOST_TRANSPORT: "unix",
    SPACE_BROWSER_HOST_SOCKET: p("browser-disabled.sock"), SPACE_BROWSER_SESSIONS_DEFAULT_URL: "about:blank",
    SPACE_DOT_TOOL_GATEWAY: "disabled", SPACE_FILES_HOST_MODE: "disabled", SPACE_DEMO_PROJECTS_ENABLED: "false",
    SPACE_ROOM_AGENT_MONITOR_ENABLED: "false", SPACE_ROOM_AGENT_AUTOPILOT_ENABLED: "false",
    SPACE_MCP_DISCOVERY_SMOKE_ENABLED: "false", SPACE_MCP_TOOL_EXECUTION_ENABLED: "false",
    SPACE_MCP_TOOL_BRIDGE_ENABLED: "false", SPACE_MEMORY_EMBEDDING_SMOKE_ENABLED: "false",
    SPACE_MEMORY_GRAPH_ENABLED: "false", SPACE_MEMORY_MAINTENANCE_ENABLED: "false",
    SPACE_MEMORY_MUTATIONS_ENABLED: "false", SPACE_VOICE_TRANSCRIPTION_ENABLED: "false",
    SPACE_SWARM_EXECUTION_ENABLED: "false", SPACE_HARNESS_ENABLED: "false",
    OPENCODE_DISABLE_AUTOUPDATE: "1", OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
    OPENCODE_DISABLE_EXTERNAL_SKILLS: "1", OPENCODE_DISABLE_CLAUDE_CODE: "1",
  });
  const paths = {
    SPACE_MEMORY_ROOT: ["memory"], SPACE_STARTER_MEMORY_ROOT: ["starter-memory"],
    SPACE_MEMORY_INDEX_PATH: ["memory", "history.md"], SPACE_MEMORY_MONTHLY_PATH: ["memory", "history_monthly.md"],
    SPACE_MEMORY_LOCK_PATH: ["memory", ".memory.lock"],
    SPACE_GEMINI_MEMORY_INDEX_PATH: ["memory", "gemini_history.md"],
    SPACE_GEMINI_MEMORY_MONTHLY_PATH: ["memory", "gemini_history_monthly.md"],
    SPACE_GEMINI_MEMORY_LOCK_PATH: ["memory", ".gemini-memory.lock"], SPACE_MEMORY_GRAPH_ROOT: ["memory-graph"],
    SPACE_ARTIFACT_ROOT: ["artifacts"], SPACE_CODEX_HOME: ["home", ".codex"],
    SPACE_CODEX_APP_SERVER_HOME: ["home", ".codex"], SPACE_GEMINI_CLI_HOME: ["home", ".gemini"],
    SPACE_CODEX_GOALS_DB_PATH: ["data", "codex-goals.sqlite"],
    SPACE_CODEX_CLI_MODE_DEFAULTS_PROJECTION_PATH: ["data", "codex-cli-mode-defaults-v1.json"],
    SPACE_APP_DIAGNOSTICS_ROOT: ["diagnostics"],
    SPACE_MAINTENANCE_AUTOPILOT_STATE_FILE: ["maintenance", "state.json"],
    SPACE_CLI_ACCOUNT_BALANCER_STATE_FILE: ["cli-account-balancer", "state.json"],
    SPACE_BROWSER_SESSIONS_PROFILE_ROOT: ["browser-profiles"], SPACE_JOB_APPLY_ROOT: ["job-apply"],
    SPACE_DOT_WORKSPACE_ROOT: ["dot-workspaces"], SPACE_TELEGRAM_SECRET_ROOT: ["secrets", "telegram"],
    SPACE_TELEGRAM_OWNERSHIP_MANIFEST: ["integrations", "telegram", "thread-ownership.json"],
    SPACE_STREAMING_SECRET_ROOT: ["streaming-secrets"], SPACE_DEMO_PROJECTS_ROOT: ["demos"],
    SPACE_DEMO_PROJECTS_VAR_ROOT: ["demo-projects"], SPACE_PROJECTS_ROOT: ["projects"],
    SPACE_USER_PROJECTS_ROOT: ["projects"], SPACE_WORKTREES_ROOT: ["worktrees"],
    SPACE_PERSONAL_GIT_ROOT: ["personal-source-control"], SPACE_AGENT_FILE_DOCX_WORK_ROOT: ["docx-work"],
    SPACE_BENCHMARK_RESULTS_DIR: ["benchmarks"], SPACE_ASTEROIDS_BENCHMARK_DIR: ["asteroids"],
    SPACE_ASTEROIDS_CLI_WORKSPACE: ["workspaces", "asteroids"], SPACE_CHESS_TOURNAMENT_FILE: ["chess", "state.json"],
  };
  for (const [key, parts] of Object.entries(paths)) env[key] = p(...parts);
  return env;
}
