import { createHash, randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

export function port(value, fallback) {
  const result = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(result) || result < 1024 || result > 65535 || [4910, 4911].includes(result)) {
    throw new Error("Dev-stack ports must be integers in 1024..65535, excluding installed ports 4910/4911.");
  }
  return result;
}

export function configuration(root, env = process.env) {
  const ports = {
    api: port(env.SPACE_DEV_API_PORT, 5910), web: port(env.SPACE_DEV_WEB_PORT, 5911),
    postgres: port(env.SPACE_DEV_POSTGRES_PORT, 55432), temporal: port(env.SPACE_DEV_TEMPORAL_PORT, 57233)
  };
  if (new Set(Object.values(ports)).size !== 4) throw new Error("Dev-stack ports must be distinct.");
  const id = createHash("sha256").update(root).digest("hex").slice(0, 16);
  return {
    root, state: join(root, ".dev-stack"), project: `spaceapp-dev-${id}`, ports,
    control: join(tmpdir(), `spaceapp-dev-${id}.sock`),
    hostSocket: join(tmpdir(), `spaceapp-cli-dev-${id}.sock`)
  };
}

export async function assertOwnedState(config) {
  const info = await lstat(config.state);
  if (!info.isDirectory() || info.isSymbolicLink() || await realpath(config.state) !== config.state) {
    throw new Error("Refusing non-directory or symlink dev-stack state.");
  }
  const marker = JSON.parse(await readFile(join(config.state, "owner.json"), "utf8"));
  if (marker.root !== config.root || marker.project !== config.project || marker.version !== 1) {
    throw new Error("State does not belong to this checkout; refusing cleanup.");
  }
}

export async function prepareState(config) {
  try { await lstat(config.state); await assertOwnedState(config); }
  catch (error) {
    if (error.code !== "ENOENT") throw error;
    // An existing directory without a marker is never adopted.
    await mkdir(config.state, { mode: 0o700 });
    await writeFile(join(config.state, "owner.json"), JSON.stringify({
      version: 1, root: config.root, project: config.project
    }), { flag: "wx", mode: 0o600 });
  }
  await chmod(config.state, 0o700);
  for (const dir of ["secrets", "memory", "memory-graph", "artifacts", "workspaces", "providers", "bin", "logs"]) {
    const path = join(config.state, dir);
    await mkdir(path, { recursive: true, mode: 0o700 });
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Invalid dev-stack directory: ${dir}`);
    await chmod(path, 0o700);
  }
  const secrets = {};
  for (const name of ["postgres-password", "session-secret", "setup-token", "control-token"]) {
    const path = join(config.state, "secrets", name);
    try { await writeFile(path, randomBytes(32).toString("hex"), { flag: "wx", mode: 0o600 }); }
    catch (error) { if (error.code !== "EEXIST") throw error; }
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Invalid secret file: ${name}`);
    await chmod(path, 0o600);
    secrets[name] = await readFile(path, "utf8");
    if (!/^[a-f0-9]{64}$/.test(secrets[name])) throw new Error(`Invalid secret format: ${name}`);
  }
  for (const name of ["space_memory.md", "space_memory_monthly.md", "installation-guide.md"]) {
    const destination = join(config.state, "memory", name);
    try { await writeFile(destination, await readFile(join(config.root, "starter-memory", name)), { flag: "wx", mode: 0o600 }); }
    catch (error) { if (error.code !== "EEXIST") throw error; }
  }
  return secrets;
}

export function pinnedImage(template, service) {
  const section = template.match(new RegExp(`^  ${service}:\\n([\\s\\S]*?)(?=^  [a-zA-Z]|^networks:|$(?![\\s\\S]))`, "m"));
  const image = section?.[1].match(/^ {4}image: ([^\s]+)$/m)?.[1];
  if (!image || !/@sha256:[a-f0-9]{64}$/.test(image)) throw new Error(`Missing pinned ${service} image in launcher template.`);
  return image;
}

export function composeDocument(config, template) {
  return {
    services: {
      postgres: {
        image: pinnedImage(template, "postgres"),
        environment: { POSTGRES_DB: "spaceapp_dev", POSTGRES_USER: "spaceapp", POSTGRES_PASSWORD_FILE: "/run/secrets/postgres-password" },
        ports: [`127.0.0.1:${config.ports.postgres}:5432`],
        secrets: ["postgres-password"], volumes: ["database:/var/lib/postgresql/data"],
        healthcheck: { test: ["CMD-SHELL", "pg_isready -U spaceapp -d spaceapp_dev"], interval: "2s", timeout: "5s", retries: 60 }
      },
      temporal: {
        image: pinnedImage(template, "temporal"),
        // Compose mounts host secret files without remapping their 0600 ownership.
        // The image defaults to UID 1000, which cannot read those files on Linux.
        user: "0:0",
        environment: { DB: "postgres12", DB_PORT: "5432", POSTGRES_USER: "spaceapp", POSTGRES_SEEDS: "postgres", DYNAMIC_CONFIG_FILE_PATH: "config/dynamicconfig/docker.yaml" },
        entrypoint: ["/bin/sh", "-ec"],
        command: ['export POSTGRES_PWD="$$(cat /run/secrets/postgres-password)"; exec /etc/temporal/entrypoint.sh autosetup'],
        ports: [`127.0.0.1:${config.ports.temporal}:7233`],
        secrets: ["postgres-password"], depends_on: { postgres: { condition: "service_healthy" } },
        healthcheck: {
          test: ["CMD-SHELL", "temporal operator cluster health --address temporal:7233 >/dev/null && temporal operator namespace describe --namespace default --address temporal:7233 >/dev/null"],
          interval: "3s", timeout: "10s", retries: 60
        }
      }
    },
    secrets: { "postgres-password": { file: "./secrets/postgres-password" } },
    volumes: { database: {} }
  };
}

export function sourceEnvironment(config, secrets, inherited = process.env) {
  // Do not inherit operator SPACE_* configuration, provider credentials, NODE_OPTIONS or homes.
  const env = {};
  for (const key of ["PATH", "LANG", "LC_ALL", "TERM", "TZ", "SYSTEMROOT", "COMSPEC"]) {
    if (inherited[key]) env[key] = inherited[key];
  }
  const path = (...parts) => join(config.state, ...parts);
  return Object.assign(env, {
    HOME: path("providers"), TMPDIR: path("providers", "tmp"), NODE_ENV: "development",
    SPACE_INSTANCE: "dev", SPACE_INSTANCE_ENABLED_JOBS: "", SPACE_PUBLIC_DISTRIBUTION: "true",
    SPACE_DEV_LOGIN: "false", SPACE_SESSION_SECRET: secrets["session-secret"],
    SPACE_GOOGLE_AUTH_DISABLED: "true", SPACE_T3CODE_ENABLED: "false",
    SPACE_SETUP_TOKEN_FILE: path("secrets", "setup-token"),
    SPACE_RUNTIME_STORE: "postgres", SPACE_DATABASE_URL: `postgresql://spaceapp:${secrets["postgres-password"]}@127.0.0.1:${config.ports.postgres}/spaceapp_dev`,
    SPACE_API_HOST: "127.0.0.1", SPACE_API_PORT: String(config.ports.api),
    SPACE_API_ORIGIN: `http://127.0.0.1:${config.ports.api}`,
    SPACE_BROWSER_EVIDENCE_TARGET_ORIGIN: `http://127.0.0.1:${config.ports.web}`,
    SPACE_WEB_HOST: "127.0.0.1", SPACE_WEB_PORT: String(config.ports.web),
    SPACE_TEMPORAL_ADDRESS: `127.0.0.1:${config.ports.temporal}`, SPACE_TEMPORAL_NAMESPACE: "spaceapp-dev",
    SPACE_TEMPORAL_TASK_QUEUE: config.project, SPACEAPP_WORKFLOWS_ENABLED: "true",
    SPACE_ENABLE_DUMMY_TURNS: "true",
    SPACE_INSTALL_ROOT: config.root, SPACE_MEMORY_ROOT: path("memory"),
    SPACE_MEMORY_INDEX_PATH: path("memory", "space_memory.md"), SPACE_MEMORY_MONTHLY_PATH: path("memory", "space_memory_monthly.md"),
    SPACE_MEMORY_LOCK_PATH: path("memory", ".memory.lock"), SPACE_MEMORY_GRAPH_ROOT: path("memory-graph"),
    SPACE_ARTIFACT_ROOT: path("artifacts"), SPACE_PROJECTS_ROOT: path("workspaces"),
    SPACE_CLI_ENABLED: "true", SPACE_CLI_ROOT_ENABLED: "false", SPACE_CLI_COMMAND_PATH: path("bin"),
    SPACE_CLI_WORKSPACE_ROOT: path("workspaces"), SPACE_CLI_HOST_SOCKET: config.hostSocket,
    SPACE_CODEX_HOME: path("providers", "codex"), SPACE_CODEX_APP_SERVER_HOME: path("providers", "codex"),
    SPACE_OPENCODE_STATE_ROOT: path("providers", "opencode"),
    SPACE_CODEX_GOALS_DB_PATH: path("codex-goals.sqlite"),
    SPACE_CODEX_CLI_MODE_DEFAULTS_PROJECTION_PATH: path("codex-mode-defaults.json"),
    SPACE_TELEGRAM_SECRET_ROOT: path("providers", "telegram"), SPACE_STREAMING_SECRET_ROOT: path("providers", "streaming"),
    SPACE_TELEGRAM_OWNERSHIP_MANIFEST: path("telegram-ownership.json"),
    SPACE_MAINTENANCE_AUTOPILOT_STATE_FILE: path("maintenance.json"), SPACE_APP_DIAGNOSTICS_ROOT: path("diagnostics"),
    SPACE_CONNECTOR_KEY_FILE: path("secrets", "connector.key"), SPACE_DOT_WORKSPACE_ROOT: path("workspaces", "dots"),
    SPACE_DESIGN_GATEWAY_KEY_FILE: path("secrets", "design.key"),
    SPACE_CHESS_MOVE_SOCKET: "disabled", SPACE_BROWSER_SESSIONS_ENABLED: "false", SPACE_BROWSER_EVIDENCE_ENABLED: "false",
    SPACE_DEMO_PROJECTS_ENABLED: "false", SPACE_FILES_HOST_MODE: "disabled", SPACE_AGENT_TOOLS_WRITER: "disabled",
    SPACE_ROOM_AGENT_AUTOPILOT_ENABLED: "false", SPACE_ROOM_AGENT_MONITOR_ENABLED: "false"
  });
}

export function openCodePackage(dockerfile) {
  const match = dockerfile.match(/(?:@opencode\/cli|opencode-ai)@\d+\.\d+\.\d+(?:[-\w.]*)?/);
  if (!match) throw new Error("No pinned OpenCode package found in Dockerfile.");
  return match[0];
}

export function composeArgs(config, ...args) {
  return ["compose", "--project-name", config.project, "--file", resolve(config.state, "compose.json"), ...args];
}
