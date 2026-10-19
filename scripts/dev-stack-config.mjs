import { createHash } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";

export function devStackConfig(checkout, env = {}) {
  const root = resolve(checkout);
  const state = resolve(root, env.SPACE_DEV_STACK_DIR || ".dev-stack");
  if (dirname(state) !== root || !/^\.dev-stack(?:-[a-z0-9-]+)?$/.test(basename(state))) {
    throw new Error("SPACE_DEV_STACK_DIR must be a .dev-stack or .dev-stack-<name> directory directly inside this checkout.");
  }
  const ports = {};
  for (const [name, fallback] of Object.entries({ api: 54910, web: 54911, postgres: 55432, temporal: 57233 })) {
    const raw = env[`SPACE_DEV_${name.toUpperCase()}_PORT`] ?? String(fallback);
    if (!/^\d+$/.test(raw) || Number(raw) < 1024 || Number(raw) > 65535 || [4910, 4911].includes(Number(raw))) {
      throw new Error(`SPACE_DEV_${name.toUpperCase()}_PORT must be an unprivileged port other than 4910/4911.`);
    }
    ports[name] = Number(raw);
  }
  if (new Set(Object.values(ports)).size !== 4) throw new Error("Dev-stack ports must be distinct.");
  const id = createHash("sha256").update(state).digest("hex").slice(0, 12);
  const socket = join(state, "cli.sock");
  if (Buffer.byteLength(socket) > 100) throw new Error("This checkout path is too long for Unix sockets. Use a shorter checkout path (at most 80 bytes).");
  return { version: 1, root, state, id, project: `spaceapp-dev-${id}`, ports, socket, namespace: `spaceapp-dev-${id}` };
}

export function pinnedDevImages(template) {
  let service;
  const images = {};
  for (const line of template.split(/\r?\n/)) {
    const header = /^  ([a-z0-9-]+):\s*$/.exec(line);
    if (header) service = header[1];
    const image = /^    image: (\S+)\s*$/.exec(line);
    if (image && ["postgres", "temporal"].includes(service)) {
      if (images[service]) throw new Error(`Duplicate ${service} image in launcher template.`);
      images[service] = image[1];
    }
  }
  for (const [service, repository] of [["postgres", "pgvector/pgvector"], ["temporal", "temporalio/auto-setup"]]) {
    if (!images[service]?.startsWith(`${repository}:`) || !/@sha256:[0-9a-f]{64}$/.test(images[service])) {
      throw new Error(`The launcher template must pin ${service} by SHA-256 digest.`);
    }
  }
  return images;
}

export function pinnedOpenCode(dockerfile) {
  const versions = [...dockerfile.matchAll(/\bopencode-ai@(\d+\.\d+\.\d+)\b/g)].map(match => match[1]);
  if (new Set(versions).size !== 1) throw new Error("Dockerfile must specify exactly one OpenCode version.");
  return versions[0];
}

export function devCompose(config, images) {
  return {
    services: {
      postgres: {
        image: images.postgres,
        environment: { POSTGRES_DB: "spaceapp_dev", POSTGRES_USER: "spaceapp", POSTGRES_PASSWORD_FILE: "/run/secrets/postgres-password" },
        ports: [`127.0.0.1:${config.ports.postgres}:5432`],
        volumes: ["postgres-data:/var/lib/postgresql/data"], secrets: ["postgres-password"],
        healthcheck: { test: ["CMD-SHELL", "pg_isready -U spaceapp -d spaceapp_dev"], interval: "2s", timeout: "5s", retries: 60 }
      },
      temporal: {
        image: images.temporal,
        environment: { DB: "postgres12", DB_PORT: "5432", POSTGRES_USER: "spaceapp", POSTGRES_SEEDS: "postgres", DYNAMIC_CONFIG_FILE_PATH: "config/dynamicconfig/docker.yaml" },
        // Compose reads this private host file as the developer. The image's
        // non-root Temporal user cannot read a Linux bind mount owned by them.
        env_file: [join(config.state, "secrets", "temporal.env")],
        ports: [`127.0.0.1:${config.ports.temporal}:7233`],
        depends_on: { postgres: { condition: "service_healthy" } },
        healthcheck: { test: ["CMD-SHELL", "temporal operator cluster health --address temporal:7233 >/dev/null && temporal operator namespace describe --namespace default --address temporal:7233 >/dev/null"], interval: "3s", timeout: "10s", retries: 60 }
      }
    },
    volumes: { "postgres-data": {} },
    secrets: { "postgres-password": { file: join(config.state, "secrets", "postgres-password") } }
  };
}

/** Deliberately do not inherit installed Space settings, provider keys or preload hooks. */
export function devEnvironment(config, secrets, inherited = {}) {
  const state = config.state, stateHome = join(state, "home");
  return {
    PATH: inherited.PATH || "/usr/local/bin:/usr/bin:/bin", LANG: inherited.LANG || "en_US.UTF-8",
    TERM: inherited.TERM || "xterm-256color", HOME: stateHome, USER: inherited.USER || "spaceapp-dev", LOGNAME: inherited.LOGNAME || inherited.USER || "spaceapp-dev",
    TMPDIR: join(state, "tmp"), NODE_ENV: "development", ELECTRON_SKIP_BINARY_DOWNLOAD: "1",
    SPACE_INSTANCE: "dev", SPACE_INSTANCE_ENABLED_JOBS: "", SPACE_INSTALL_ROOT: config.root,
    SPACE_DEV_SESSION_COOKIE_NAMESPACE: config.id,
    SPACE_PUBLIC_DISTRIBUTION: "true", SPACE_AGENT_TOOLS_WRITER: "disabled", SPACE_TELEMETRY_ENABLED: "false", SPACE_DEV_LOGIN: "false", SPACE_OPTIONAL_MODULES: "none",
    SPACE_T3CODE_ENABLED: "false", SPACE_BROWSER_EVIDENCE_ENABLED: "false",
    SPACE_RUNTIME_STORE: "postgres", SPACE_DATABASE_URL: `postgresql://spaceapp:${secrets.database}@127.0.0.1:${config.ports.postgres}/spaceapp_dev`,
    SPACE_DATABASE_URL_FILE: join(state, "secrets", "database-url"), SPACE_SESSION_SECRET: secrets.session,
    SPACE_SETUP_TOKEN_FILE: join(state, "secrets", "setup-token"),
    SPACE_API_HOST: "127.0.0.1", SPACE_API_PORT: String(config.ports.api), SPACE_API_ORIGIN: `http://127.0.0.1:${config.ports.api}`,
    SPACE_WEB_HOST: "127.0.0.1", SPACE_WEB_PORT: String(config.ports.web),
    SPACE_TEMPORAL_ADDRESS: `127.0.0.1:${config.ports.temporal}`, SPACE_TEMPORAL_NAMESPACE: config.namespace,
    SPACE_TEMPORAL_TASK_QUEUE: config.namespace, SPACEAPP_WORKFLOWS_ENABLED: "true",
    SPACE_CLI_ENABLED: "true", SPACE_CLI_ROOT_ENABLED: "false", SPACE_CLI_HOST_SOCKET: config.socket,
    SPACE_CLI_ADMIN_HOST_SOCKET: join(state, "admin-disabled.sock"), SPACE_CLI_COMMAND_PATH: join(state, "bin"), SPACE_CLI_WORKSPACE_ROOT: join(state, "workspaces"),
    SPACE_BROWSER_SESSIONS_ENABLED: "false", SPACE_BROWSER_HOST_TRANSPORT: "unix", SPACE_BROWSER_HOST_SOCKET: join(state, "browser-disabled.sock"),
    SPACE_ARTIFACT_ROOT: join(state, "artifacts"), SPACE_PROJECTS_ROOT: join(state, "workspaces"), SPACE_DOT_WORKSPACE_ROOT: join(state, "workspaces"),
    SPACE_MEMORY_ROOT: join(state, "memory"), SPACE_MEMORY_GRAPH_ROOT: join(state, "memory-graph"),
    SPACE_GEMINI_MEMORY_INDEX_PATH: join(state, "memory", "gemini_history.md"), SPACE_GEMINI_MEMORY_MONTHLY_PATH: join(state, "memory", "gemini_history_monthly.md"), SPACE_GEMINI_MEMORY_LOCK_PATH: join(state, "memory", ".memory.lock"),
    SPACE_CODEX_HOME: join(state, "providers", "codex"), SPACE_CODEX_APP_SERVER_HOME: join(state, "providers", "codex"),
    SPACE_CODEX_APP_SERVER_COMMAND: join(state, "bin", "codex-disabled"), SPACE_CLI_VPN_LAUNCHER: join(state, "bin", "vpn-disabled"),
    SPACE_CODEX_GOALS_DB_PATH: join(state, "codex-goals.sqlite"), SPACE_CODEX_CLI_MODE_DEFAULTS_PROJECTION_PATH: join(state, "codex-mode-defaults.json"),
    SPACE_APP_DIAGNOSTICS_ROOT: join(state, "app-diagnostics"), SPACE_MAINTENANCE_AUTOPILOT_STATE_FILE: join(state, "maintenance", "state.json"), SPACE_CLI_ACCOUNT_BALANCER_STATE_FILE: join(state, "accounts", "state.json"),
    SPACE_DEMO_PROJECTS_ROOT: join(config.root, "demos"), SPACE_DEMO_PROJECTS_VAR_ROOT: join(state, "demo-projects"), SPACE_STREAMING_SECRET_ROOT: join(state, "streaming-secrets"),
    SPACE_TELEGRAM_SECRET_ROOT: join(state, "telegram"), SPACE_TELEGRAM_OWNERSHIP_MANIFEST: join(state, "integrations", "telegram.json")
  };
}
