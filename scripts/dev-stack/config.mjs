// Pure configuration for `npm run dev:stack`: ports, state paths, service
// images, the generated compose file and the environment of every process.
// Nothing here starts a process or touches Docker, so it is unit-tested.
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, parse, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const composeTemplatePath = join(repoRoot, "packages/run-spaceapp/templates/compose.yml");
export const dockerfilePath = join(repoRoot, "Dockerfile");

export const stateMarker = ".spaceapp-dev-stack";
export const stateMarkerContents = "spaceapp-dev-stack-v1\n";

/** Default host ports. An installed SpaceApp uses 4910 (API, loopback in its container) and 4911 (web). */
export const defaultPorts = Object.freeze({ web: 4811, api: 4810, postgres: 54329, temporal: 47233 });
const portVariables = Object.freeze({
  web: "SPACE_DEV_WEB_PORT",
  api: "SPACE_DEV_API_PORT",
  postgres: "SPACE_DEV_POSTGRES_PORT",
  temporal: "SPACE_DEV_TEMPORAL_PORT"
});
const reservedPorts = new Set([4910, 4911]);

/**
 * Resolves and validates loopback host ports for the dev stack services.
 *
 * @param {NodeJS.ProcessEnv} [env=process.env] - Environment variable map.
 * @returns {{ web: number, api: number, postgres: number, temporal: number }} Validated port map.
 */
export function resolvePorts(env = process.env) {
  const ports = {};
  for (const [name, variable] of Object.entries(portVariables)) {
    const raw = env[variable]?.trim();
    const port = raw ? Number(raw) : defaultPorts[name];
    if (!Number.isInteger(port) || port < 1024 || port > 65535) {
      throw new Error(`${variable} must be a port number between 1024 and 65535.`);
    }
    if (reservedPorts.has(port)) {
      throw new Error(`${variable}=${port} collides with an installed SpaceApp (4910/4911). Choose another port.`);
    }
    ports[name] = port;
  }
  const values = Object.values(ports);
  if (new Set(values).size !== values.length) {
    throw new Error("The dev-stack ports must all be different.");
  }
  return ports;
}

/**
 * Returns true when `candidateParent` is the same directory as `target` or an ancestor of `target`.
 *
 * @param {string} candidateParent - Resolved candidate parent directory.
 * @param {string} target - Resolved target path.
 * @returns {boolean} True when `candidateParent` contains or equals `target`.
 */
export function isSameOrAncestorPath(candidateParent, target) {
  const rel = relative(candidateParent, target);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * Ensures a state directory path cannot point at filesystem root, home, temp root, repo root,
 * or any ancestor directory of the repository or user home directory.
 *
 * @param {string} stateDir - Candidate state directory path.
 * @param {string} [root=repoRoot] - Repository root directory.
 * @param {string} [home=homedir()] - User home directory.
 * @returns {string} Resolved safe state directory path.
 */
export function assertSafeStateDir(stateDir, root = repoRoot, home = homedir()) {
  if (!stateDir || !String(stateDir).trim()) {
    throw new Error("State directory path must not be empty.");
  }
  const resolved = resolve(String(stateDir));
  const resolvedRoot = resolve(root);
  const resolvedHome = resolve(home);
  const resolvedTmp = resolve(tmpdir());
  const parsed = parse(resolved);
  if (
    resolved === parsed.root ||
    resolved === resolvedTmp ||
    isSameOrAncestorPath(resolved, resolvedRoot) ||
    isSameOrAncestorPath(resolved, resolvedHome)
  ) {
    throw new Error(`Refusing unsafe state directory path: ${resolved}`);
  }
  return resolved;
}

/**
 * Resolves the dev stack state directory and verifies it is a safe target path.
 *
 * @param {NodeJS.ProcessEnv} [env=process.env] - Environment variable map.
 * @param {string} [root=repoRoot] - Repository root path.
 * @returns {string} Resolved state directory path.
 */
export function resolveStateDir(env = process.env, root = repoRoot) {
  const candidate = resolve(root, env.SPACE_DEV_STATE_DIR?.trim() || ".dev-stack");
  return assertSafeStateDir(candidate, root);
}

/**
 * Verifies that an existing state directory carries the dev-stack ownership marker.
 *
 * @param {string} stateDir - State directory to verify before destructive operations.
 * @returns {Promise<void>}
 */
export async function assertOwnedStateDir(stateDir) {
  let content;
  try {
    content = await readFile(join(stateDir, stateMarker), "utf8");
  } catch {
    throw new Error(`Refusing to reset unowned state directory ${stateDir}`);
  }
  if (content !== stateMarkerContents) {
    throw new Error(`Refusing to reset unowned state directory ${stateDir}`);
  }
}

/**
 * Resolves the Docker Compose project name, defaulting to a deterministic hash of `stateDir`
 * so multiple checkouts and an installed SpaceApp never share containers or volumes.
 *
 * @param {NodeJS.ProcessEnv} [env=process.env] - Environment variable map.
 * @param {string} [stateDir] - State directory used to derive the default project name.
 * @returns {string} Validated Docker Compose project name.
 */
export function resolveProjectName(env = process.env, stateDir = resolveStateDir(env)) {
  const configured = env.SPACE_DEV_COMPOSE_PROJECT?.trim();
  if (configured) {
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(configured) || configured === "spaceapp") {
      throw new Error("SPACE_DEV_COMPOSE_PROJECT must be a lowercase compose project name other than spaceapp.");
    }
    return configured;
  }
  const hash = createHash("sha256").update(resolve(stateDir)).digest("hex").slice(0, 10);
  return `spaceapp-dev-${hash}`;
}

/**
 * Extracts the digest-pinned image of one service from the installer compose template.
 *
 * @param {string} composeText - Raw contents of `packages/run-spaceapp/templates/compose.yml`.
 * @param {string} service - Service key (`postgres` or `temporal`).
 * @returns {string} Digest-pinned container image reference.
 */
export function serviceImage(composeText, service) {
  const lines = composeText.split(/\r?\n/);
  const start = lines.findIndex((line) => line === `  ${service}:`);
  if (start < 0) throw new Error(`Service ${service} is missing from the compose template.`);
  for (const line of lines.slice(start + 1)) {
    if (/^ {0,2}\S/.test(line)) break;
    const match = /^ {4}image:\s*(\S+)\s*$/.exec(line);
    if (match) {
      if (!/@sha256:[0-9a-f]{64}$/.test(match[1])) {
        throw new Error(`Service ${service} image is not pinned by digest.`);
      }
      return match[1];
    }
  }
  throw new Error(`Service ${service} has no image in the compose template.`);
}

/**
 * Reads the digest-pinned PostgreSQL and Temporal images from the installer compose template.
 *
 * @param {string} [templatePath=composeTemplatePath] - Path to the compose template.
 * @returns {{ postgres: string, temporal: string }} Digest-pinned service images.
 */
export function readServiceImages(templatePath = composeTemplatePath) {
  const text = readFileSync(templatePath, "utf8");
  return { postgres: serviceImage(text, "postgres"), temporal: serviceImage(text, "temporal") };
}

/**
 * Extracts the pinned `opencode-ai` version from `Dockerfile` text.
 *
 * @param {string} dockerfileText - Raw contents of `Dockerfile`.
 * @returns {string} Exact semantic version of `opencode-ai`.
 */
export function opencodeVersion(dockerfileText) {
  const match = /\bopencode-ai@(\d+\.\d+\.\d+)\b/.exec(dockerfileText);
  if (!match) throw new Error("The Dockerfile does not pin an opencode-ai version.");
  return match[1];
}

/**
 * Reads the pinned `opencode-ai` version from the repository `Dockerfile`.
 *
 * @param {string} [path=dockerfilePath] - Path to `Dockerfile`.
 * @returns {string} Exact semantic version of `opencode-ai`.
 */
export function readOpencodeVersion(path = dockerfilePath) {
  return opencodeVersion(readFileSync(path, "utf8"));
}

/**
 * Renders the Docker Compose file for PostgreSQL (pgvector) and Temporal with loopback-only
 * port bindings and environment-injected credentials.
 *
 * @param {{ images: { postgres: string, temporal: string }, ports: { postgres: number, temporal: number } }} options - Images and ports.
 * @returns {string} Generated Docker Compose YAML content.
 */
export function renderCompose({ images, ports }) {
  return `# Generated by npm run dev:stack. Do not edit; it is rewritten on every start.
services:
  postgres:
    image: ${images.postgres}
    environment:
      POSTGRES_DB: spaceapp
      POSTGRES_USER: spaceapp
      POSTGRES_PASSWORD: \${SPACE_DEV_POSTGRES_PASSWORD:?}
    ports:
      - "127.0.0.1:${ports.postgres}:5432"
    volumes:
      - postgres:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U spaceapp -d spaceapp"]
      interval: 2s
      timeout: 5s
      retries: 60
  temporal:
    image: ${images.temporal}
    depends_on:
      postgres:
        condition: service_healthy
    environment:
      DB: postgres12
      DB_PORT: 5432
      POSTGRES_USER: spaceapp
      POSTGRES_PWD: \${SPACE_DEV_POSTGRES_PASSWORD:?}
      POSTGRES_SEEDS: postgres
      DYNAMIC_CONFIG_FILE_PATH: config/dynamicconfig/docker.yaml
    ports:
      - "127.0.0.1:${ports.temporal}:7233"
    healthcheck:
      test: ["CMD-SHELL", "temporal operator cluster health --address temporal:7233 >/dev/null && temporal operator namespace describe --namespace default --address temporal:7233 >/dev/null"]
      interval: 3s
      timeout: 10s
      retries: 100
volumes:
  postgres: {}
`;
}

/**
 * Computes all filesystem paths inside the dev-stack state directory.
 *
 * @param {string} stateDir - Root state directory path.
 * @returns {Record<string, string>} Structured state paths.
 */
export function statePaths(stateDir) {
  const cli = join(stateDir, "cli");
  return {
    stateDir,
    marker: join(stateDir, stateMarker),
    secrets: join(stateDir, "secrets"),
    postgresPassword: join(stateDir, "secrets", "postgres-password"),
    sessionSecret: join(stateDir, "secrets", "session-secret"),
    setupToken: join(stateDir, "secrets", "setup-token"),
    compose: join(stateDir, "compose.yml"),
    runFile: join(stateDir, "run.json"),
    data: join(stateDir, "data"),
    memory: join(stateDir, "data", "memory"),
    memoryGraph: join(stateDir, "data", "memory-graph"),
    artifacts: join(stateDir, "data", "artifacts"),
    workspaces: join(stateDir, "workspaces"),
    projects: join(stateDir, "projects"),
    socketDir: join(stateDir, "run"),
    cliHostSocket: join(stateDir, "run", "cli-host.sock"),
    cli,
    cliBin: join(cli, "bin"),
    cliProviders: join(cli, "providers"),
    cliVendor: join(cli, "vendor")
  };
}

const secretSpecs = [
  ["postgresPassword", 32],
  ["sessionSecret", 48],
  ["setupToken", 32]
];

/**
 * Creates missing secret files with mode 0600 inside a mode 0700 directory and returns their values.
 *
 * @param {ReturnType<typeof statePaths>} paths - State directory path map.
 * @returns {Promise<{ postgresPassword: string, sessionSecret: string, setupToken: string }>} Secret values.
 */
export async function ensureSecrets(paths) {
  await mkdir(paths.secrets, { recursive: true, mode: 0o700 });
  await chmod(paths.secrets, 0o700);
  const secrets = {};
  for (const [key, bytes] of secretSpecs) {
    const path = paths[key];
    let value;
    try {
      value = (await readFile(path, "utf8")).trim();
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    if (!value) {
      value = randomBytes(bytes).toString("base64url");
      await writeFile(path, `${value}\n`, { mode: 0o600 });
    }
    await chmod(path, 0o600);
    secrets[key] = value;
  }
  return secrets;
}

/**
 * Builds the environment map shared by the API, worker, CLI host, Vite dev server, and migrations.
 *
 * @param {{ paths: ReturnType<typeof statePaths>, ports: ReturnType<typeof resolvePorts>, secrets: { postgresPassword: string, sessionSecret: string, setupToken: string }, env?: NodeJS.ProcessEnv }} options - Context options.
 * @returns {Record<string, string>} Environment variable map for child services.
 */
export function serviceEnvironment({ paths, ports, secrets, env = process.env }) {
  const memory = paths.memory;
  const codexHome = join(paths.cliProviders, "codex");
  const opencodeState = join(paths.cliProviders, "opencode", "state");
  const encodedPassword = encodeURIComponent(secrets.postgresPassword);
  return {
    SPACE_PUBLIC_DISTRIBUTION: "true",
    SPACE_AGENT_TOOLS_WRITER: "disabled",
    SPACE_DEV_LOGIN: "false",
    SPACE_TELEMETRY_ENABLED: "false",
    SPACE_OPTIONAL_MODULES: env.SPACE_OPTIONAL_MODULES || "all",
    SPACE_RUNTIME_STORE: "postgres",
    SPACE_DATABASE_URL: `postgresql://spaceapp:${encodedPassword}@127.0.0.1:${ports.postgres}/spaceapp`,
    SPACE_SESSION_SECRET: secrets.sessionSecret,
    SPACE_SETUP_TOKEN_FILE: paths.setupToken,
    SPACE_API_HOST: "127.0.0.1",
    SPACE_API_PORT: String(ports.api),
    SPACE_API_ORIGIN: `http://127.0.0.1:${ports.api}`,
    SPACE_WEB_HOST: "127.0.0.1",
    SPACE_WEB_PORT: String(ports.web),
    SPACE_TEMPORAL_ADDRESS: `127.0.0.1:${ports.temporal}`,
    SPACEAPP_WORKFLOWS_ENABLED: "true",
    SPACE_MEMORY_ROOT: memory,
    SPACE_STARTER_MEMORY_ROOT: join(repoRoot, "starter-memory"),
    SPACE_MEMORY_GRAPH_ROOT: paths.memoryGraph,
    SPACE_GEMINI_MEMORY_INDEX_PATH: join(memory, "gemini_history.md"),
    SPACE_GEMINI_MEMORY_MONTHLY_PATH: join(memory, "gemini_history_monthly.md"),
    SPACE_GEMINI_MEMORY_LOCK_PATH: join(memory, ".memory.lock"),
    SPACE_ARTIFACT_ROOT: paths.artifacts,
    SPACE_CLI_HOST_SOCKET: env.SPACE_CLI_HOST_SOCKET?.trim() || paths.cliHostSocket,
    SPACE_CLI_ENABLED: "true",
    SPACE_CLI_COMMAND_PATH: paths.cliBin,
    SPACE_CLI_WORKSPACE_ROOT: paths.workspaces,
    SPACE_CODEX_HOME: codexHome,
    SPACE_CODEX_APP_SERVER_HOME: codexHome,
    SPACE_OPENCODE_STATE_ROOT: opencodeState,
    SPACE_CODEX_APP_SERVER_COMMAND: join(paths.cliBin, "codex-vscode-parity"),
    SPACE_CODEX_ROUTE_COMMAND: join(paths.cliBin, "codex-vscode-parity"),
    SPACE_CODEX_GOALS_DB_PATH: join(paths.data, "codex-goals.sqlite"),
    SPACE_CODEX_CLI_MODE_DEFAULTS_PROJECTION_PATH: join(paths.data, "codex-cli-mode-defaults-v1.json"),
    SPACE_TELEGRAM_SECRET_ROOT: join(paths.data, "telegram"),
    SPACE_TELEGRAM_OWNERSHIP_MANIFEST: join(paths.data, "integrations", "telegram", "thread-ownership.json"),
    SPACE_BROWSER_SESSIONS_ENABLED: "false",
    SPACE_BROWSER_SESSIONS_DEFAULT_URL: "about:blank",
    // Defaults below point at /opt/spaceapp in the code; the dev stack keeps them in its state directory.
    SPACE_INSTALL_ROOT: repoRoot,
    SPACE_WORKSPACE_ROOT: repoRoot,
    SPACE_VAR_DIR: paths.data,
    SPACE_PROJECTS_ROOT: paths.projects,
    SPACE_WORKTREES_ROOT: join(paths.data, "worktrees"),
    SPACE_PERSONAL_GIT_ROOT: join(paths.data, "personal-source-control"),
    SPACE_DEMO_PROJECTS_ENABLED: "false",
    SPACE_DEMO_PROJECTS_ROOT: join(repoRoot, "demos"),
    SPACE_DEMO_PROJECTS_VAR_ROOT: join(paths.data, "demo-projects"),
    SPACE_APP_DIAGNOSTICS_ROOT: join(paths.data, "app-diagnostics"),
    SPACE_MAINTENANCE_AUTOPILOT_STATE_FILE: join(paths.data, "maintenance-autopilot", "state.json"),
    SPACE_STREAMING_SECRET_ROOT: join(paths.data, "streaming-secrets"),
    SPACE_DOT_WORKSPACE_ROOT: join(paths.data, "dots", "workspaces")
  };
}

/**
 * Returns the list of directories inside the state root that services expect to exist with mode 0700.
 *
 * @param {ReturnType<typeof statePaths>} paths - State directory path map.
 * @returns {string[]} Directory paths to create.
 */
export function stateDirectories(paths) {
  return [
    paths.data,
    paths.memory,
    paths.memoryGraph,
    paths.artifacts,
    paths.workspaces,
    paths.projects,
    paths.socketDir,
    paths.cliBin,
    paths.cliProviders,
    paths.cliVendor,
    join(paths.data, "telegram"),
    join(paths.data, "integrations", "telegram"),
    join(paths.data, "worktrees"),
    join(paths.data, "personal-source-control")
  ];
}

/** Starter memory files the core entrypoint installs once. */
export const starterMemoryFiles = ["gemini_history.md", "gemini_history_monthly.md", "installation-guide.md"];

/**
 * Renders the `<runtime>-vscode-parity` launcher script that delegates to `scripts/dev-stack/cli-wrapper.sh`.
 *
 * @param {{ runtime: string, paths: ReturnType<typeof statePaths>, nodePath: string }} options - Wrapper options.
 * @returns {string} Executable shell script content.
 */
export function renderCliCommand({ runtime, paths, nodePath }) {
  const wrapper = join(repoRoot, "scripts", "dev-stack", "cli-wrapper.sh");
  return `#!/usr/bin/env bash
# Generated by npm run dev:stack.
export SPACE_DEV_CLI_ROOT=${shellQuote(paths.cli)}
export SPACE_DEV_MEMORY_ROOT=${shellQuote(paths.memory)}
export PATH=${shellQuote(dirname(nodePath))}:"$PATH"
exec bash ${shellQuote(wrapper)} ${shellQuote(runtime)} "$@"
`;
}

/**
 * Quotes an arbitrary string for safe single-quoted POSIX shell interpolation.
 *
 * @param {string} value - Raw string value.
 * @returns {string} Single-quoted POSIX shell literal.
 */
export function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

/** Workspace packages the apps import, in dependency order (the order of the root build script). */
export const workspacePackages = [
  "contracts",
  "icons",
  "streaming",
  "opencode-control",
  "memory-graph",
  "browser-host",
  "cli-host",
  "codex-app-server",
  "runtime",
  "db",
  "gateway"
];

/**
 * Maps a changed relative path under `packages/<name>/src/` to its workspace package name.
 *
 * @param {string} relativePath - Repository-relative changed file path.
 * @returns {string | null} Workspace package short name, or null when not a watched package source file.
 */
export function packageForChange(relativePath) {
  const normalized = relativePath.replaceAll("\\", "/");
  const match = /^packages\/([^/]+)\/src\//.exec(normalized);
  return match && workspacePackages.includes(match[1]) ? match[1] : null;
}

/**
 * Compares a recorded process identity against a live process identity to prevent signaling recycled PIDs.
 *
 * @param {Record<string, unknown> | number | null | undefined} recorded - Saved process identity record.
 * @param {Record<string, unknown> | number | null | undefined} current - Current live process identity record.
 * @returns {boolean} True when both descriptors refer to the same process instance.
 */
export function sameProcess(recorded, current) {
  if (!recorded || typeof recorded !== "object" || !current || typeof current !== "object") {
    return false;
  }
  const recPid = recorded.pid;
  const curPid = current.pid;
  if (!Number.isInteger(recPid) || recPid <= 0 || recPid !== curPid) {
    return false;
  }
  if (recorded.starttime && current.starttime) {
    if (String(recorded.starttime) !== String(current.starttime)) return false;
    if (recorded.comm && current.comm && recorded.comm !== current.comm) return false;
    return true;
  }
  if (recorded.ps && current.ps) {
    return recorded.ps === current.ps;
  }
  if (recorded.comm && current.comm) {
    return recorded.comm === current.comm;
  }
  return false;
}

/**
 * Validates a recorded process identity against live identity, returning the verified PID or null.
 *
 * @param {Record<string, unknown> | number | null | undefined} recorded - Saved process identity record.
 * @param {Record<string, unknown> | number | null | undefined} currentLive - Current live process identity record.
 * @returns {number | null} Verified PID when identity matches, or null.
 */
export function verifyProcessIdentity(recorded, currentLive) {
  if (!sameProcess(recorded, currentLive)) {
    return null;
  }
  return recorded.pid;
}
