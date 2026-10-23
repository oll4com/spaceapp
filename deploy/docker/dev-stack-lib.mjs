import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, lstat, mkdir, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const repoRoot = resolve(here, "../..");
export const sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

function parsePort(raw, fallback, name) {
  const value = raw == null || raw === "" ? fallback : Number(raw);
  if (!Number.isInteger(value) || value < 1024 || value > 65535) {
    throw new Error(`${name} must be an integer port between 1024 and 65535.`);
  }
  return value;
}

function inside(parent, child) {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

export async function assertSafeStateRoot(stateRoot, root = repoRoot) {
  const value = resolve(stateRoot);
  const repo = resolve(root);
  const home = resolve(homedir());
  if (value === resolve(sep) || value === repo || value === home) throw new Error(`Unsafe dev-stack state directory: ${value}`);
  if (inside(value, repo) && value !== repo) throw new Error("The dev-stack state directory may not be an ancestor of the repository.");
  if (existsSync(value) && (await lstat(value)).isSymbolicLink()) throw new Error("The dev-stack state directory may not be a symlink.");
  return value;
}

export function parsePinnedImages(text) {
  const postgres = text.match(/image:\s*(pgvector\/pgvector:[^\s]+@sha256:[a-f0-9]{64})/i)?.[1];
  const temporal = text.match(/image:\s*(temporalio\/auto-setup:[^\s]+@sha256:[a-f0-9]{64})/i)?.[1];
  if (!postgres || !temporal) throw new Error("Could not read digest-pinned PostgreSQL and Temporal images from the launcher Compose template.");
  return { postgres, temporal };
}

export function parseOpenCodeVersion(text) {
  const version = text.match(/opencode-ai@([0-9]+\.[0-9]+\.[0-9]+)/)?.[1];
  if (!version) throw new Error("Could not read the pinned opencode-ai version from Dockerfile.");
  return version;
}

export async function resolveConfig(env = process.env, root = repoRoot) {
  const rootHash = createHash("sha256").update(await realpath(root)).digest("hex").slice(0, 10);
  const stateRoot = await assertSafeStateRoot(env.SPACE_DEV_STACK_DIR || join(root, ".dev-stack"), root);
  const ports = {
    api: parsePort(env.SPACE_DEV_API_PORT, 5910, "SPACE_DEV_API_PORT"),
    web: parsePort(env.SPACE_DEV_WEB_PORT, 5911, "SPACE_DEV_WEB_PORT"),
    postgres: parsePort(env.SPACE_DEV_POSTGRES_PORT, 55432, "SPACE_DEV_POSTGRES_PORT"),
    temporal: parsePort(env.SPACE_DEV_TEMPORAL_PORT, 57233, "SPACE_DEV_TEMPORAL_PORT")
  };
  const seen = new Map();
  for (const [name, value] of Object.entries(ports)) {
    if (seen.has(value)) throw new Error(`${name} conflicts with ${seen.get(value)} on port ${value}.`);
    seen.set(value, name);
  }
  for (const [name, value] of Object.entries(ports)) {
    if (value === 4910 || value === 4911) throw new Error(`${name} port ${value} is reserved for an installed SpaceApp.`);
  }
  const project = env.SPACE_DEV_COMPOSE_PROJECT || `spaceapp-dev-${rootHash}`;
  if (!/^[a-z0-9][a-z0-9_-]{2,50}$/i.test(project)) throw new Error("SPACE_DEV_COMPOSE_PROJECT contains unsupported characters.");
  const preferredSocket = join(stateRoot, "run", "cli-host.sock");
  const socketPath = Buffer.byteLength(preferredSocket) <= 96 ? preferredSocket : join(tmpdir(), `spaceapp-dev-${rootHash}`, "cli-host.sock");
  if (Buffer.byteLength(socketPath) > 96) {
    throw new Error(`Unix socket path exceeds the 96-byte limit after fallback (${Buffer.byteLength(socketPath)} bytes). Set TMPDIR to a shorter directory and retry.`);
  }
  return {
    root, rootHash, stateRoot, project, ports, socketPath,
    composeFile: join(stateRoot, "compose.yml"),
    configFile: join(stateRoot, "config.json"),
    ownerFile: join(stateRoot, "ownership.json"),
    pidFile: join(stateRoot, "supervisor.pid"),
    processFile: join(stateRoot, "process-groups.json"),
    buildMarker: join(stateRoot, "build-marker.json"),
    secretsDir: join(stateRoot, "secrets"),
    binDir: join(stateRoot, "bin"),
    vendorDir: join(stateRoot, "vendor", "opencode"),
    providerRoot: join(stateRoot, "providers", "opencode"),
    workspacesRoot: join(stateRoot, "workspaces"),
    memoryRoot: join(stateRoot, "memory"),
    memoryGraphRoot: join(stateRoot, "memory-graph"),
    artifactRoot: join(stateRoot, "artifacts"),
    projectsRoot: join(stateRoot, "projects"),
    diagnosticsRoot: join(stateRoot, "diagnostics"),
    openCodeChatRoot: join(stateRoot, "opencode-chat")
  };
}

export function renderCompose(config, images, ownership) {
  if (!ownership?.token) throw new Error("Dev-stack ownership token is required to render Compose resources.");
  const ownerLabel = `com.spaceapp.dev-stack.owner: ${ownership.token}`;
  return `services:\n  postgres:\n    image: ${images.postgres}\n    restart: unless-stopped\n    labels:\n      ${ownerLabel}\n    environment:\n      POSTGRES_DB: spaceapp_dev\n      POSTGRES_USER: spaceapp\n      POSTGRES_PASSWORD: \${SPACEAPP_DEV_POSTGRES_PASSWORD:-dev-stack-password-not-supplied}\n    ports:\n      - \"127.0.0.1:${config.ports.postgres}:5432\"\n    volumes:\n      - postgres-data:/var/lib/postgresql/data\n    healthcheck:\n      test: [\"CMD-SHELL\", \"pg_isready -U spaceapp -d spaceapp_dev\"]\n      interval: 2s\n      timeout: 3s\n      retries: 30\n  temporal:\n    image: ${images.temporal}\n    restart: unless-stopped\n    labels:\n      ${ownerLabel}\n    depends_on:\n      postgres:\n        condition: service_healthy\n    environment:\n      DB: postgres12\n      DB_PORT: 5432\n      POSTGRES_USER: spaceapp\n      POSTGRES_SEEDS: postgres\n      POSTGRES_PWD: \${SPACEAPP_DEV_POSTGRES_PASSWORD:-dev-stack-password-not-supplied}\n      DYNAMIC_CONFIG_FILE_PATH: config/dynamicconfig/docker.yaml\n    ports:\n      - \"127.0.0.1:${config.ports.temporal}:7233\"\n    healthcheck:\n      test: [\"CMD-SHELL\", \"temporal operator cluster health --address temporal:7233 >/dev/null && temporal operator namespace describe --namespace default --address temporal:7233 >/dev/null\"]\n      interval: 3s\n      timeout: 5s\n      retries: 40\nvolumes:\n  postgres-data:\n    labels:\n      ${ownerLabel}\nnetworks:\n  default:\n    labels:\n      ${ownerLabel}\n`;
}

export async function run(command, args, { capture = false, allowFailure = false, env = process.env, cwd = repoRoot } = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, { cwd, env, stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit" });
    let stdout = "";
    let stderr = "";
    if (capture) {
      child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
      child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    }
    child.once("error", rejectPromise);
    child.once("close", (code, signal) => {
      const result = { code: code ?? 1, signal, stdout: stdout.trim(), stderr: stderr.trim() };
      if (!allowFailure && code !== 0) rejectPromise(new Error(`${command} ${args.join(" ")} failed (${code ?? signal}).${stderr ? `\n${stderr}` : ""}`));
      else resolvePromise(result);
    });
  });
}

export function composeArgs(config, ...args) {
  return ["compose", "-p", config.project, "-f", config.composeFile, ...args];
}
export const compose = (config, args, options = {}) => run("docker", composeArgs(config, ...args), options);

async function privateFile(path, value) {
  if (!existsSync(path)) await writeFile(path, `${value}\n`, { mode: 0o600, flag: "wx" });
  await chmod(path, 0o600);
}

export async function prepareState(config) {
  for (const path of [config.stateRoot, config.secretsDir, dirname(config.socketPath), config.binDir, config.vendorDir, config.providerRoot,
    config.workspacesRoot, config.memoryRoot, config.memoryGraphRoot, config.artifactRoot, config.projectsRoot, config.diagnosticsRoot, config.openCodeChatRoot]) {
    await mkdir(path, { recursive: true, mode: 0o700 });
  }
  await privateFile(join(config.secretsDir, "postgres-password"), randomBytes(24).toString("base64url"));
  await privateFile(join(config.secretsDir, "session-secret"), randomBytes(32).toString("hex"));
  await privateFile(join(config.secretsDir, "setup-token"), randomBytes(32).toString("hex"));
  const postgresPassword = (await readFile(join(config.secretsDir, "postgres-password"), "utf8")).trim();
  const sessionSecret = (await readFile(join(config.secretsDir, "session-secret"), "utf8")).trim();
  const databaseUrl = `postgresql://spaceapp:${encodeURIComponent(postgresPassword)}@127.0.0.1:${config.ports.postgres}/spaceapp_dev`;
  await writeFile(join(config.secretsDir, "database-url"), `${databaseUrl}\n`, { mode: 0o600 });
  await chmod(join(config.secretsDir, "database-url"), 0o600);
  return { databaseUrl, sessionSecret, postgresPassword };
}

async function buildSourceFingerprint(root) {
  const inputs = [];
  const visit = async (path) => {
    if (!existsSync(path)) return;
    const info = await stat(path);
    if (!info.isDirectory()) {
      inputs.push([relative(root, path), info.mtimeMs, info.size]);
      return;
    }
    for (const name of (await readdir(path)).sort()) {
      if (["node_modules", "dist", "coverage"].includes(name)) continue;
      await visit(join(path, name));
    }
  };
  await visit(join(root, "packages"));
  await visit(join(root, "apps", "worker", "src"));
  // Building creates excluded output directories, which changes parent directory
  // mtimes. Hash source file identities instead, including paths to detect deletes.
  return createHash("sha256").update(JSON.stringify(inputs)).digest("hex");
}

export async function ensureBuild(config, force = false, runner = run) {
  if (process.env.SPACE_DEV_SKIP_BUILD === "true" && !force) return;
  const artifacts = ["packages/contracts/dist/index.js", "packages/runtime/dist/index.js", "packages/db/dist/migrate.js", "packages/cli-host/dist/main.js", "apps/worker/dist/worker.js"].map((p) => join(config.root, p));
  const marker = existsSync(config.buildMarker) ? JSON.parse(await readFile(config.buildMarker, "utf8")) : null;
  const sourceFingerprint = await buildSourceFingerprint(config.root);
  if (!force && process.env.SPACE_DEV_FORCE_BUILD !== "true" && marker && artifacts.every(existsSync) && sourceFingerprint === marker.sourceFingerprint) return;
  const buildStartedAt = Date.now();
  console.log(`[dev:stack] Building source workspaces before migrations... started at ${new Date(buildStartedAt).toISOString()}`);
  await runner("npm", ["run", "build"], { cwd: config.root });
  await writeFile(config.buildMarker, `${JSON.stringify({ sourceFingerprint, builtAt: new Date().toISOString() }, null, 2)}\n`, { mode: 0o600 });
  console.log(`[dev:stack] Source workspace build completed at ${new Date().toISOString()} (${Math.round((Date.now() - buildStartedAt) / 1000)}s).`);
}

export async function installOpenCode(config, version, runner = run) {
  const packageJson = join(config.vendorDir, "node_modules", "opencode-ai", "package.json");
  let installed = null;
  if (existsSync(packageJson)) {
    try { installed = JSON.parse(await readFile(packageJson, "utf8")).version; } catch {}
  }
  if (installed !== version) {
    await rm(config.vendorDir, { recursive: true, force: true });
    await mkdir(config.vendorDir, { recursive: true, mode: 0o700 });
    console.log(`[dev:stack] Installing pinned opencode-ai@${version} into dev state...`);
    await runner("npm", ["install", "--prefix", config.vendorDir, "--no-package-lock", "--no-save", "--no-audit", "--no-fund", `opencode-ai@${version}`]);
  }
  const wrapper = join(config.binDir, "opencode-vscode-parity");
  const binary = join(config.vendorDir, "node_modules", ".bin", "opencode");
  // The API supplies installed-runtime paths to CLI panes; override them at
  // the executable boundary so source runs never write to an installed instance.
  const shellQuote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
  const paths = {
    HOME: join(config.providerRoot, "home"),
    XDG_CONFIG_HOME: join(config.providerRoot, "config"),
    XDG_DATA_HOME: join(config.providerRoot, "data"),
    XDG_CACHE_HOME: join(config.providerRoot, "cache"),
    XDG_STATE_HOME: join(config.providerRoot, "state"),
    TMPDIR: join(config.providerRoot, "tmp")
  };
  const exports = Object.entries(paths).map(([key, value]) => `export ${key}=${shellQuote(value)}`);
  await writeFile(wrapper, [
    "#!/bin/sh", "set -eu", "umask 077", ...exports,
    'export TMP="$TMPDIR" TEMP="$TMPDIR"',
    "unset OPENCODE_API_KEY",
    'mkdir -p "$HOME" "$XDG_CONFIG_HOME" "$XDG_DATA_HOME" "$XDG_CACHE_HOME" "$XDG_STATE_HOME" "$TMPDIR"',
    `exec ${shellQuote(binary)} "$@"`, ""
  ].join("\n"), { mode: 0o700 });
  await chmod(wrapper, 0o700);
  return wrapper;
}

export async function waitHealthy(config, service, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const id = (await compose(config, ["ps", "-q", service], { capture: true })).stdout;
    if (id) {
      const status = await run("docker", ["inspect", "--format", "{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}", id], { capture: true, allowFailure: true });
      if (status.stdout === "healthy") return;
      if (["unhealthy", "exited", "dead"].includes(status.stdout)) throw new Error(`${service} became ${status.stdout}.`);
    }
    await sleep(1000);
  }
  throw new Error(`${service} did not become healthy within ${Math.round(timeoutMs / 1000)} seconds.`);
}

export async function ensureTemporalNamespace(config) {
  const base = ["exec", "-T", "temporal", "temporal", "operator", "namespace"];
  const described = await compose(config, [...base, "describe", "--namespace", "spaceapp-dev", "--address", "temporal:7233"], { capture: true, allowFailure: true });
  if (described.code !== 0) await compose(config, [...base, "create", "--namespace", "spaceapp-dev", "--address", "temporal:7233"]);
}

export function sourceEnv(config, databaseUrl, sessionSecret, openCodeWrapper) {
  // Source services need the host's executable lookup and basic OS/temp/locale
  // settings. Do not inherit arbitrary user variables: provider credentials
  // have many names and a denylist inevitably misses some of them.
  const inheritedKeys = new Set(["PATH", "HOME", "TMPDIR", "TMP", "TEMP", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "LANG", "TZ"]);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => inheritedKeys.has(key) || key.startsWith("LC_")));
  if (openCodeWrapper !== join(config.binDir, "opencode-vscode-parity")) {
    throw new Error("OpenCode wrapper must live inside the controlled dev-stack command directory.");
  }
  return {
    ...env,
    SPACE_INSTANCE: "dev",
    SPACE_INSTALL_ROOT: config.root,
    SPACE_RUNTIME_STORE: "postgres",
    SPACE_DATABASE_URL: databaseUrl,
    SPACE_SESSION_SECRET: sessionSecret,
    SPACE_SETUP_TOKEN_FILE: join(config.secretsDir, "setup-token"),
    SPACE_STREAMING_SECRET_ROOT: join(config.secretsDir, "streaming"),
    SPACE_DEV_LOGIN: "false",
    SPACE_GOOGLE_AUTH_DISABLED: "true",
    SPACE_PUBLIC_DISTRIBUTION: "true",
    SPACE_OPTIONAL_MODULES: "none",
    SPACEAPP_WORKFLOWS_ENABLED: "true",
    SPACE_API_HOST: "127.0.0.1",
    SPACE_API_PORT: String(config.ports.api),
    SPACE_WEB_HOST: "127.0.0.1",
    SPACE_WEB_PORT: String(config.ports.web),
    SPACE_API_ORIGIN: `http://127.0.0.1:${config.ports.api}`,
    SPACE_TEMPORAL_ADDRESS: `127.0.0.1:${config.ports.temporal}`,
    SPACE_TEMPORAL_NAMESPACE: "spaceapp-dev",
    SPACE_TEMPORAL_TASK_QUEUE: "space-dev-agent-turns",
    SPACE_CLI_ENABLED: "true",
    SPACE_CLI_HOST_SOCKET: config.socketPath,
    SPACE_CLI_COMMAND_PATH: config.binDir,
    SPACE_CLI_OPENCODE_COMMAND: "opencode-vscode-parity",
    SPACE_CLI_WORKSPACE_ROOT: config.workspacesRoot,
    SPACE_CLI_ROOT_ENABLED: "false",
    SPACE_BROWSER_SESSIONS_ENABLED: "false",
    SPACE_BROWSER_HOST_TRANSPORT: "in-process",
    SPACE_MEMORY_ROOT: config.memoryRoot,
    SPACE_MEMORY_GRAPH_ROOT: config.memoryGraphRoot,
    SPACE_ARTIFACT_ROOT: config.artifactRoot,
    SPACE_PROJECTS_ROOT: config.projectsRoot,
    SPACE_APP_DIAGNOSTICS_ROOT: config.diagnosticsRoot,
    SPACE_OPENCODE_CHAT_STATE_ROOT: config.openCodeChatRoot,
    SPACE_ENABLE_DUMMY_TURNS: "false",
    SPACE_ROOM_AGENT_AUTOPILOT_ENABLED: "false"
  };
}

// The API/database is authoritative for whether the one-time setup token is
// usable. The local secret file persists after the owner claims it and must not
// be printed again on a normal source-stack restart.
export async function ownerSetupBanner(config, {
  request = fetch,
  readSecret = readFile,
  nowMs = Date.now()
} = {}) {
  const response = await request(`http://127.0.0.1:${config.ports.api}/api/setup/status`, {
    method: "GET",
    headers: { accept: "application/json" },
    redirect: "error",
    signal: AbortSignal.timeout(5000)
  });
  if (!response?.ok) {
    throw new Error(`Could not verify dev-stack owner setup status (HTTP ${response?.status ?? "unknown"}); refusing to print a token.`);
  }
  const status = await response.json();
  if (!status || typeof status !== "object" || typeof status.setupRequired !== "boolean"
    || (status.expiresAt !== null && typeof status.expiresAt !== "string")) {
    throw new Error("Invalid dev-stack owner setup status; refusing to print a token.");
  }
  if (!status.setupRequired) {
    return "Owner setup already complete; sign in with the existing owner account.";
  }

  const expiresAtMs = Date.parse(status.expiresAt ?? "");
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= nowMs) {
    return "Owner setup token expired or unavailable; no token will be printed. Verify the setup status before attempting first-owner setup.";
  }
  const token = (await readSecret(join(config.secretsDir, "setup-token"), "utf8")).trim();
  if (!/^[a-f0-9]{64}$/.test(token)) {
    throw new Error("Invalid dev-stack owner setup token file; refusing to print its content.");
  }
  return `Owner setup token: ${token}`;
}

export async function waitReady(config, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      // A server may accept a connection but never answer. Bound both
      // headers and response-body reads, then honor the overall deadline.
      const remainingMs = Math.max(1, deadline - Date.now());
      const response = await fetch(`http://127.0.0.1:${config.ports.api}/readyz`, {
        signal: AbortSignal.timeout(Math.min(5_000, remainingMs))
      });
      if (response.ok) {
        const body = await response.json();
        if (body.ok === true && body.dependencies?.database === "RUNNING" && body.dependencies?.worker === "RUNNING" && body.dependencies?.cliHost === "RUNNING") return body;
      }
    } catch {}
    const remainingMs = Math.max(0, deadline - Date.now());
    if (remainingMs > 0) await sleep(Math.min(500, remainingMs));
  }
  throw new Error("The source stack did not reach /readyz with database, worker and CLI host RUNNING.");
}

export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error?.code === "ESRCH") return false; throw error; }
}

export async function readSupervisorPid(config) {
  if (!existsSync(config.pidFile)) return null;
  const value = Number.parseInt((await readFile(config.pidFile, "utf8")).trim(), 10);
  return Number.isInteger(value) ? value : null;
}

function splitLines(value) {
  return value.split(/\s+/).filter(Boolean);
}

async function dockerList(runner, args, kind) {
  const result = await runner("docker", args, { capture: true, allowFailure: true });
  if (result.code !== 0) throw new Error(`Docker inventory failed while listing dev-stack ${kind}; state was preserved for recovery.`);
  return splitLines(result.stdout);
}

function sameSet(left, right) {
  return left.length === right.length && [...left].sort().every((value, index) => value === [...right].sort()[index]);
}

export async function dockerResources(config, ownership = null, runner = run) {
  const projectFilter = `label=com.docker.compose.project=${config.project}`;
  const all = {
    containers: await dockerList(runner, ["ps", "-aq", "--filter", projectFilter], "containers"),
    volumes: await dockerList(runner, ["volume", "ls", "-q", "--filter", projectFilter], "volumes"),
    networks: await dockerList(runner, ["network", "ls", "-q", "--filter", projectFilter], "networks")
  };
  if (!ownership) return all;

  const ownerFilter = `label=com.spaceapp.dev-stack.owner=${ownership.token}`;
  const owned = {
    containers: await dockerList(runner, ["ps", "-aq", "--filter", projectFilter, "--filter", ownerFilter], "owned containers"),
    volumes: await dockerList(runner, ["volume", "ls", "-q", "--filter", projectFilter, "--filter", ownerFilter], "owned volumes"),
    networks: await dockerList(runner, ["network", "ls", "-q", "--filter", projectFilter, "--filter", ownerFilter], "owned networks")
  };
  for (const kind of ["containers", "volumes", "networks"]) {
    if (!sameSet(all[kind], owned[kind])) {
      throw new Error(`Refusing cleanup: Compose project ${config.project} contains ${kind} that are not proven to belong to this dev-stack state.`);
    }
  }
  return owned;
}
