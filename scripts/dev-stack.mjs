#!/usr/bin/env node
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { createServer, createConnection } from "node:net";
import {
  chmod,
  cp,
  mkdir,
  readFile,
  readdir,
  rm,
  lstat,
  symlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const defaultRepoRoot = resolve(dirname(scriptPath), "..");

export const DEFAULT_DEV_PORTS = Object.freeze({
  web: 14911,
  api: 14910,
  postgres: 15432,
  temporal: 17233
});

function parsePort(value, fallback, label) {
  if (value === undefined || value === "") return fallback;
  const parsed = /^[0-9]+$/.test(String(value)) ? Number(value) : NaN;
  if (!Number.isInteger(parsed) || parsed < 1024 || parsed > 65535) {
    throw new Error(`Invalid ${label} port: ${value}`);
  }
  if (parsed === 4910 || parsed === 4911) {
    throw new Error(`${label} port ${parsed} collides with the installed SpaceApp ports (4910/4911).`);
  }
  return parsed;
}

/**
 * Reads the digest-pinned PostgreSQL and Temporal images directly from
 * packages/run-spaceapp/templates/compose.yml so digests are never copied by hand.
 */
export async function readPinnedInfraImages(
  composeTemplatePath = join(defaultRepoRoot, "packages/run-spaceapp/templates/compose.yml")
) {
  const content = await readFile(composeTemplatePath, "utf8");
  const pgMatch = content.match(
    /^\s{2}postgres:\s*\n(?:\s{4}.*\n)*?\s{4}image:\s*(pgvector\/pgvector:[^\s]+@sha256:[0-9a-f]{64})\s*$/m
  );
  const temporalMatch = content.match(
    /^\s{2}temporal:\s*\n(?:\s{4}.*\n)*?\s{4}image:\s*(temporalio\/auto-setup:[^\s]+@sha256:[0-9a-f]{64})\s*$/m
  );
  if (!pgMatch?.[1] || !temporalMatch?.[1]) {
    throw new Error(`Could not resolve digest-pinned infrastructure images from ${composeTemplatePath}.`);
  }
  return {
    postgresImage: pgMatch[1],
    temporalImage: temporalMatch[1]
  };
}

/**
 * Reads the pinned opencode-ai package version directly from the repository Dockerfile.
 */
export async function readPinnedOpenCodePackage(dockerfilePath = join(defaultRepoRoot, "Dockerfile")) {
  const content = await readFile(dockerfilePath, "utf8");
  const match = content.match(/\b(opencode-ai@\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\b/);
  if (!match?.[1]) {
    throw new Error(`Could not resolve pinned opencode-ai version from ${dockerfilePath}.`);
  }
  return match[1];
}

export function resolveDevStackConfig(env = process.env, repoRoot = defaultRepoRoot) {
  const bindHost = env.SPACE_DEV_BIND_HOST ?? "127.0.0.1";
  if (bindHost !== "127.0.0.1") {
    throw new Error("dev:stack binds exclusively to 127.0.0.1 for local isolation.");
  }
  const rawStateDir = env.SPACE_DEV_STACK_DIR || ".dev-stack";
  const stateDir = resolve(repoRoot, rawStateDir);
  if (stateDir === repoRoot || stateDir === dirname(stateDir) || repoRoot.startsWith(`${stateDir}/`)) {
    throw new Error("State directory must not be the checkout or one of its ancestors.");
  }
  const projectHash = createHash("sha256").update(stateDir).digest("hex").slice(0, 8);
  const projectName = `spaceapp-dev-${projectHash}`;
  if (env.SPACE_DEV_STACK_PROJECT && env.SPACE_DEV_STACK_PROJECT !== projectName) {
    throw new Error("Compose project is derived from the state directory; do not override it.");
  }

  const webPort = parsePort(env.SPACE_DEV_WEB_PORT ?? env.SPACE_WEB_PORT, DEFAULT_DEV_PORTS.web, "web");
  const apiPort = parsePort(env.SPACE_DEV_API_PORT ?? env.SPACE_API_PORT, DEFAULT_DEV_PORTS.api, "api");
  const postgresPort = parsePort(env.SPACE_DEV_POSTGRES_PORT, DEFAULT_DEV_PORTS.postgres, "postgres");
  const temporalPort = parsePort(env.SPACE_DEV_TEMPORAL_PORT, DEFAULT_DEV_PORTS.temporal, "temporal");
  if (new Set([webPort, apiPort, postgresPort, temporalPort]).size !== 4) throw new Error("Dev ports must be distinct.");

  const defaultRunDir = join(stateDir, "run");
  // Unix sockets have a ~104-byte path limit on macOS/BSD. Fall back to a short owned dir if needed.
  const runDir =
    Buffer.byteLength(join(defaultRunDir, "credentials.sock")) <= 96
      ? defaultRunDir
      : join(tmpdir(), `sp-dev-${projectHash}`);

  return {
    repoRoot,
    stateDir,
    runDir,
    projectName,
    bindHost,
    webPort,
    apiPort,
    postgresPort,
    temporalPort,
    composeFile: join(stateDir, "compose.dev.yml"),
    pidFile: join(stateDir, "dev-stack.pids.json"),
    secretsDir: join(stateDir, "secrets"),
    cliStateDir: join(stateDir, "cli"),
    binDir: join(stateDir, "bin"),
    memoryDir: join(stateDir, "memory"),
    memoryGraphDir: join(stateDir, "memory-graph"),
    artifactsDir: join(stateDir, "artifacts"),
    workspacesDir: join(stateDir, "workspaces"),
    etcDir: join(stateDir, "etc"),
    telegramDir: join(stateDir, "telegram"),
    cliSocketPath: join(runDir, "host.sock"),
    credentialSocketPath: join(runDir, "credentials.sock")
  };
}

export async function assertOwnedState(config, create = false) {
  for (const dir of [config.stateDir, config.runDir, config.secretsDir]) {
    const info = await lstat(dir).catch(error => { if (error.code !== "ENOENT") throw error; });
    if (info && (!info.isDirectory() || info.isSymbolicLink())) throw new Error("Refusing unsafe dev state directory.");
  }
  const marker = join(config.stateDir, "owner.json");
  if (!existsSync(marker)) {
    if (!create) throw new Error("Refusing unowned dev state directory.");
    if (existsSync(config.stateDir) && (await readdir(config.stateDir)).length) throw new Error("Refusing nonempty unowned state directory.");
    await mkdir(config.stateDir, { recursive: true, mode: 0o700 });
    await writeFile(marker, JSON.stringify({ repoRoot: config.repoRoot, stateDir: config.stateDir, projectName: config.projectName, token: randomBytes(32).toString("hex") }), { flag: "wx", mode: 0o600 });
  }
  const info = await lstat(marker);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("Unsafe state ownership marker.");
  const owner = JSON.parse(await readFile(marker, "utf8"));
  if (owner.repoRoot !== config.repoRoot || owner.stateDir !== config.stateDir || owner.projectName !== config.projectName || !/^[a-f0-9]{64}$/.test(owner.token)) throw new Error("State ownership mismatch.");
  return owner;
}

async function writeSecretIfMissing(filePath, generator) {
  const info = await lstat(filePath).catch(error => { if (error.code !== "ENOENT") throw error; });
  if (info && (!info.isFile() || info.isSymbolicLink())) throw new Error("Unsafe secret file.");
  try {
    const existing = (await readFile(filePath, "utf8")).trim();
    if (existing.length >= 32) {
      await chmod(filePath, 0o600);
      return existing;
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const value = generator();
  await writeFile(filePath, `${value}\n`, { mode: 0o600 });
  await chmod(filePath, 0o600);
  return value;
}

export async function ensureDevStackSecrets(config) {
  await assertOwnedState(config, true);
  await mkdir(config.stateDir, { recursive: true, mode: 0o700 });
  await mkdir(config.secretsDir, { recursive: true, mode: 0o700 });
  await chmod(config.secretsDir, 0o700);

  const postgresPassword = await writeSecretIfMissing(
    join(config.secretsDir, "postgres-password"),
    () => randomBytes(24).toString("hex")
  );
  const sessionSecret = await writeSecretIfMissing(
    join(config.secretsDir, "session-secret"),
    () => randomBytes(32).toString("hex")
  );
  const setupToken = await writeSecretIfMissing(
    join(config.secretsDir, "setup-token"),
    () => `space-setup-${randomBytes(24).toString("hex")}`
  );
  const databaseUrl = `postgresql://spaceapp:${postgresPassword}@127.0.0.1:${config.postgresPort}/spaceapp`;
  const databaseUrlFile = join(config.secretsDir, "database-url");
  const databaseInfo = await lstat(databaseUrlFile).catch(error => { if (error.code !== "ENOENT") throw error; });
  if (databaseInfo && (!databaseInfo.isFile() || databaseInfo.isSymbolicLink())) throw new Error("Unsafe database secret file.");
  await writeFile(databaseUrlFile, `${databaseUrl}\n`, { mode: 0o600 });
  await chmod(databaseUrlFile, 0o600);

  return {
    postgresPassword,
    postgresPasswordFile: join(config.secretsDir, "postgres-password"),
    sessionSecretFile: join(config.secretsDir, "session-secret"),
    setupTokenFile: join(config.secretsDir, "setup-token"),
    databaseUrlFile,
    databaseUrl,
    sessionSecret,
    setupToken
  };
}

export function renderDevStackCompose(config, images) {
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
    `      - "127.0.0.1:${config.postgresPort}:5432"`,
    "    volumes:",
    "      - dev-postgres:/var/lib/postgresql/data",
    "    secrets:",
    "      - postgres-password",
    "    healthcheck:",
    '      test: ["CMD-SHELL", "pg_isready -U spaceapp -d spaceapp"]',
    "      interval: 5s",
    "      timeout: 5s",
    "      retries: 20",
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
    '    entrypoint: ["/bin/sh", "-ec"]',
    "    command:",
    '      - export POSTGRES_PWD="$$(cat /run/secrets/postgres-password)"; exec /etc/temporal/entrypoint.sh autosetup',
    "    ports:",
    `      - "127.0.0.1:${config.temporalPort}:7233"`,
    "    secrets:",
    "      - postgres-password",
    "    healthcheck:",
    '      test: ["CMD-SHELL", "temporal operator cluster health --address 127.0.0.1:7233 >/dev/null && temporal operator namespace describe --namespace default --address 127.0.0.1:7233 >/dev/null"]',
    "      interval: 5s",
    "      timeout: 10s",
    "      retries: 25",
    "",
    "secrets:",
    "  postgres-password:",
    "    file: ./secrets/postgres-password",
    "",
    "volumes:",
    "  dev-postgres:",
    ""
  ].join("\n");
}

export async function prepareDevStackFilesystem(config, { installOpenCode = true } = {}) {
  const owner = await assertOwnedState(config);
  if (existsSync(config.runDir)) {
    const info = await lstat(config.runDir);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Unsafe socket directory.");
    const marker = await readFile(join(config.runDir, ".owner"), "utf8").catch(() => null);
    if (marker !== owner.token) throw new Error("Refusing an unowned socket directory.");
  } else {
    await mkdir(config.runDir, { recursive: true, mode: 0o700 });
    await writeFile(join(config.runDir, ".owner"), owner.token, { flag: "wx", mode: 0o600 });
  }
  for (const dir of [
    config.stateDir,
    config.runDir,
    config.cliStateDir,
    join(config.cliStateDir, "providers"),
    join(config.cliStateDir, "imported-credentials"),
    join(config.cliStateDir, "vendor"),
    config.binDir,
    config.memoryDir,
    config.memoryGraphDir,
    config.artifactsDir,
    config.workspacesDir,
    config.etcDir,
    config.telegramDir,
    join(config.stateDir, "integrations/telegram")
  ]) {
    await mkdir(dir, { recursive: true, mode: 0o700 });
  }

  const starterRoot = join(config.repoRoot, "starter-memory");
  for (const name of ["gemini_history.md", "gemini_history_monthly.md", "installation-guide.md"]) {
    const target = join(config.memoryDir, name);
    if (!existsSync(target) && existsSync(join(starterRoot, name))) {
      await cp(join(starterRoot, name), target);
      await chmod(target, 0o600);
    }
  }
  if (existsSync(join(starterRoot, "AGENTS.md"))) {
    await cp(join(starterRoot, "AGENTS.md"), join(config.etcDir, "AGENTS.md"));
  }
  if (existsSync(join(starterRoot, "installation-guide.md"))) {
    await cp(
      join(starterRoot, "installation-guide.md"),
      join(config.etcDir, "spaceapp-installation-guide.md")
    );
  }

  const skillsSource = join(config.repoRoot, "agent-skills");
  if (existsSync(skillsSource)) {
    const codexSkills = join(config.cliStateDir, ".codex/skills");
    const agentSkills = join(config.cliStateDir, ".agents/skills");
    await mkdir(codexSkills, { recursive: true });
    await mkdir(agentSkills, { recursive: true });
    for (const entry of await readdir(skillsSource, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const skillDir = join(skillsSource, entry.name);
      const shortName = entry.name.replace(/^space-/, "");
      for (const base of [codexSkills, agentSkills]) {
        await rm(join(base, entry.name), { force: true });
        await symlink(skillDir, join(base, entry.name));
        if (shortName !== entry.name) {
          await rm(join(base, shortName), { force: true });
          await symlink(skillDir, join(base, shortName));
        }
      }
    }
  }

  const openCodeSpec = await readPinnedOpenCodePackage(join(config.repoRoot, "Dockerfile"));
  const openCodeVendorDir = join(config.cliStateDir, "vendor/opencode");
  const openCodeBin = join(openCodeVendorDir, "node_modules/.bin/opencode");
  const installedVersion = await readFile(join(openCodeVendorDir, "node_modules/opencode-ai/package.json"), "utf8").then(text => JSON.parse(text).version).catch(() => null);
  if (installOpenCode && (!existsSync(openCodeBin) || installedVersion !== openCodeSpec.split("@")[1])) {
    await mkdir(openCodeVendorDir, { recursive: true, mode: 0o700 });
    execFileSync(
      "npm",
      ["install", "--prefix", openCodeVendorDir, "--no-audit", "--no-fund", openCodeSpec],
      { cwd: config.repoRoot, stdio: "inherit" }
    );
  }

  const wrapperPath = join(config.binDir, "spaceapp-cli-wrapper");
  const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
  const wrapper = await readFile(join(config.repoRoot, "deploy/docker/public-cli-wrapper.sh"), "utf8");
  await writeFile(wrapperPath, wrapper.replace("set -euo pipefail", `set -euo pipefail\nexport SPACE_CLI_STATE_ROOT=${quote(config.cliStateDir)}\nexport SPACE_CLI_APP_ROOT=${quote(config.repoRoot)}\nexport SPACE_DEV_STACK_CLI=true`));
  await chmod(wrapperPath, 0o755);
  for (const provider of [
    "codex",
    "claude",
    "gemini",
    "opencode",
    "qwen",
    "kimi",
    "grok",
    "deepseek",
    "autohand",
    "cursor",
    "copilot"
  ]) {
    const linkPath = join(config.binDir, `${provider}-vscode-parity`);
    await rm(linkPath, { force: true });
    await symlink(wrapperPath, linkPath);
  }
}

export function buildDevStackEnvironment(config, secrets, baseEnv = process.env) {
  const vendorOpenCodeBin = join(config.cliStateDir, "vendor/opencode/node_modules/.bin");
  const pathEntries = [
    config.binDir,
    vendorOpenCodeBin,
    join(config.repoRoot, "node_modules/.bin"),
    baseEnv.PATH || "/usr/local/bin:/usr/bin:/bin"
  ];
  return {
    ...Object.fromEntries(Object.entries(baseEnv).filter(([key]) => ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "TERM", "TMPDIR", "CI", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY"].includes(key))),
    PATH: pathEntries.join(":"),
    SPACE_INSTANCE: "dev",
    SPACE_INSTANCE_ENABLED_JOBS: "",
    SPACE_INSTALL_ROOT: config.repoRoot,
    SPACE_PROJECTS_ROOT: config.workspacesDir,
    SPACE_DOT_WORKSPACE_ROOT: join(config.workspacesDir, "dots"),
    SPACE_STREAMING_SECRET_ROOT: join(config.stateDir, "streaming"),
    SPACE_APP_DIAGNOSTICS_ROOT: join(config.stateDir, "diagnostics"),
    SPACE_DEV_LOGIN: "false",
    SPACE_PUBLIC_DISTRIBUTION: "true",
    SPACE_AGENT_TOOLS_WRITER: "disabled",
    SPACE_RUNTIME_STORE: "postgres",
    SPACE_STORE_MODE: "postgres",
    SPACE_DATABASE_URL: secrets.databaseUrl,
    SPACE_DATABASE_URL_FILE: secrets.databaseUrlFile,
    SPACE_SESSION_SECRET: secrets.sessionSecret,
    SPACE_SESSION_SECRET_FILE: secrets.sessionSecretFile,
    SPACE_SETUP_TOKEN_FILE: secrets.setupTokenFile,
    SPACE_API_HOST: "127.0.0.1",
    SPACE_API_PORT: String(config.apiPort),
    SPACE_WEB_HOST: "127.0.0.1",
    SPACE_WEB_PORT: String(config.webPort),
    SPACE_API_ORIGIN: `http://127.0.0.1:${config.apiPort}`,
    SPACE_INTERNAL_API_BASE_URL: `http://127.0.0.1:${config.apiPort}`,
    SPACE_TEMPORAL_ADDRESS: `127.0.0.1:${config.temporalPort}`,
    SPACE_TEMPORAL_NAMESPACE: "spaceapp-dev",
    SPACE_TEMPORAL_TASK_QUEUE: `${config.projectName}-turns`,
    SPACEAPP_WORKFLOWS_ENABLED: "true",
    SPACE_ENABLE_DUMMY_TURNS: "false",
    SPACE_ENABLE_CODEX_TURNS: "true",
    SPACE_MEMORY_ROOT: config.memoryDir,
    SPACE_STARTER_MEMORY_ROOT: join(config.repoRoot, "starter-memory"),
    SPACE_MEMORY_GRAPH_ROOT: config.memoryGraphDir,
    SPACE_GEMINI_MEMORY_INDEX_PATH: join(config.memoryDir, "gemini_history.md"),
    SPACE_GEMINI_MEMORY_MONTHLY_PATH: join(config.memoryDir, "gemini_history_monthly.md"),
    SPACE_GEMINI_MEMORY_LOCK_PATH: join(config.memoryDir, ".memory.lock"),
    SPACE_ARTIFACT_ROOT: config.artifactsDir,
    SPACE_CLI_HOST_SOCKET: config.cliSocketPath,
    SPACEAPP_CREDENTIAL_SOCKET: config.credentialSocketPath,
    SPACE_CLI_ENABLED: "true",
    SPACE_CLI_COMMAND_PATH: config.binDir,
    SPACE_CLI_STATE_ROOT: config.cliStateDir,
    SPACE_CLI_APP_ROOT: config.repoRoot,
    SPACE_CLI_WORKSPACE_ROOT: config.workspacesDir,
    SPACE_DEFAULT_PROJECT_PATH: config.etcDir,
    SPACE_CODEX_HOME: join(config.cliStateDir, "providers/codex"),
    SPACE_CODEX_APP_SERVER_HOME: join(config.cliStateDir, "providers/codex"),
    SPACE_CODEX_APP_SERVER_COMMAND: join(config.binDir, "codex-vscode-parity"),
    SPACE_CODEX_ROUTE_COMMAND: join(config.binDir, "codex-vscode-parity"),
    SPACE_CODEX_GOALS_DB_PATH: join(config.stateDir, "codex-goals.sqlite"),
    SPACE_CODEX_CLI_MODE_DEFAULTS_PROJECTION_PATH: join(
      config.stateDir,
      "codex-cli-mode-defaults-v1.json"
    ),
    SPACE_TELEGRAM_SECRET_ROOT: config.telegramDir,
    SPACE_TELEGRAM_OWNERSHIP_MANIFEST: join(
      config.stateDir,
      "integrations/telegram/thread-ownership.json"
    ),
    SPACE_CHESS_MOVE_SOCKET: "disabled",
    SPACE_BROWSER_SESSIONS_ENABLED: "false"
  };
}

async function requestStop(config) {
  if (!existsSync(config.pidFile)) return;
  const owner = await assertOwnedState(config);
  await new Promise((resolve, reject) => {
    const socket = createConnection(join(config.runDir, "control.sock"));
    socket.setTimeout(30_000, () => socket.destroy(new Error("Dev supervisor did not stop.")));
    socket.once("connect", () => socket.end(JSON.stringify({ token: owner.token, action: "stop" })));
    socket.once("error", () => reject(new Error("Cannot contact the owned dev supervisor. Refusing to signal recorded PIDs; recover the stopped supervisor before reset.")));
    socket.on("data", () => {});
    socket.once("end", resolve);
  });
}

export async function runDevStackDown(config = resolveDevStackConfig(), reset = false) {
  if (!existsSync(config.stateDir)) return;
  const owner = await assertOwnedState(config);
  if (existsSync(config.runDir)) {
    const marker = await readFile(join(config.runDir, ".owner"), "utf8").catch(() => null);
    if (marker !== owner.token) throw new Error("Refusing cleanup of an unowned socket directory.");
  }
  await requestStop(config);
  if (existsSync(config.composeFile)) execFileSync("docker", ["compose", "-p", config.projectName, "-f", config.composeFile, "down", ...(reset ? ["--volumes"] : []), "--remove-orphans"], { cwd: config.repoRoot, stdio: "inherit" });
  await rm(config.runDir, { recursive: true, force: true });
  if (reset) await rm(config.stateDir, { recursive: true, force: true });
}
export const runDevStackReset = config => runDevStackDown(config, true);

async function waitForComposeHealthy(config) {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const out = execFileSync(
      "docker",
      ["compose", "-p", config.projectName, "-f", config.composeFile, "ps", "--format", "json"],
      { cwd: config.repoRoot, encoding: "utf8" }
    ).trim();
    const lines = out
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const pgHealthy = lines.some(
      (item) => item.Service === "postgres" && item.Health === "healthy"
    );
    const temporalHealthy = lines.some(
      (item) => item.Service === "temporal" && item.Health === "healthy"
    );
    if (pgHealthy && temporalHealthy) return;
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error("Timed out waiting for PostgreSQL and Temporal containers to become healthy.");
}

async function waitForHttpReady(url, checkChildFailure, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    checkChildFailure();
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2_500) });
      if (response.ok) {
        const body = await response.json().catch(() => null);
        if (body?.ok === true) return body;
      }
    } catch { /* Services may not have bound their ports yet. */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Timed out waiting for ${url} to report ok: true.`);
}

export async function runDevStackUp(config = resolveDevStackConfig()) {
  try {
    execFileSync("docker", ["compose", "version"], { stdio: "ignore" });
    execFileSync("docker", ["info"], { stdio: "ignore" });
    execFileSync("bash", ["--version"], { stdio: "ignore" });
  } catch { throw new Error("dev:stack requires a running Docker engine, Compose v2 and Bash."); }
  const secrets = await ensureDevStackSecrets(config);
  const owner = await assertOwnedState(config);
  const lock = join(config.stateDir, "supervisor.lock");
  await mkdir(lock, { mode: 0o700 }).catch(() => { throw new Error("A dev supervisor already owns this state directory."); });
  const children = new Map();
  let stopping = false;
  let stopPromise;
  let fatalError = null;
  let control;
  let monitor;
  const commands = [
    ["credential-agent", process.execPath, ["deploy/docker/credential-agent.mjs"], config.repoRoot],
    ["cli-host", process.execPath, ["packages/cli-host/dist/main.js"], config.repoRoot],
    ["worker", process.execPath, ["apps/worker/dist/worker.js"], config.repoRoot],
    ["api", join(config.repoRoot, "node_modules/.bin/tsx"), ["watch", "src/server.ts"], join(config.repoRoot, "apps/api")],
    ["web", join(config.repoRoot, "node_modules/.bin/vite"), ["--host", "127.0.0.1", "--port", String(config.webPort), "--strictPort"], join(config.repoRoot, "apps/web")]
  ];
  const stopAll = () => {
    if (stopPromise) return stopPromise;
    stopping = true;
    stopPromise = (async () => {
    clearInterval(monitor);
    const groupSignal = (child, signal) => { try { process.kill(-child.pid, signal); } catch { /* Process group already exited. */ } };
    const pending = [...children.values()];
    const exits = pending.map(child => new Promise(resolve => !child.pid || child.exitCode !== null || child.signalCode !== null ? resolve() : child.once("exit", resolve)));
    for (const child of pending) groupSignal(child, "SIGTERM");
    await Promise.race([Promise.all(exits), new Promise(resolve => setTimeout(resolve, 5_000))]);
    for (const child of pending) groupSignal(child, "SIGKILL");
    await Promise.all(exits);
    if (existsSync(config.composeFile)) {
      try { execFileSync("docker", ["compose", "-p", config.projectName, "-f", config.composeFile, "stop"], { stdio: "ignore" }); }
      catch { process.stderr.write("[dev:stack] Could not stop owned infrastructure; run down again.\n"); }
    }
    })();
    return stopPromise;
  };
  const env = buildDevStackEnvironment(config, secrets);
  const hide = text => [secrets.databaseUrl, secrets.sessionSecret, secrets.postgresPassword, secrets.setupToken].filter(Boolean).reduce((result, secret) => result.replaceAll(secret, "[redacted]"), text);
  const startManaged = (name, command, args, cwd) => {
    const child = spawn(command, args, { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    children.set(name, child);
    for (const stream of [child.stdout, child.stderr]) {
      let pending = "";
      stream.setEncoding("utf8");
      stream.on("data", chunk => {
        pending += chunk;
        let end;
        while ((end = pending.indexOf("\n")) >= 0) { process.stdout.write(`[${name}] ${hide(pending.slice(0, end + 1))}`); pending = pending.slice(end + 1); }
        if (pending.length > 262144) pending = "[oversized service log discarded]";
      });
      stream.on("end", () => { if (pending) process.stdout.write(`[${name}] ${hide(pending)}\n`); });
    }
    const failed = code => {
      if (stopping) return;
      fatalError = new Error(`[dev:stack] service ${name} exited unexpectedly (${code}); stopping all services.`);
      process.stderr.write(fatalError.message + "\n");
      void stopAll();
    };
    child.once("error", () => failed("spawn error"));
    child.once("exit", (code, signal) => failed(code ?? signal));
  };
  const signalStop = () => void stopAll();
  process.once("SIGINT", signalStop);
  process.once("SIGTERM", signalStop);
  try {
    await prepareDevStackFilesystem(config);
    const images = await readPinnedInfraImages(join(config.repoRoot, "packages/run-spaceapp/templates/compose.yml"));
    await writeFile(config.composeFile, renderDevStackCompose(config, images), { mode: 0o600 });
    execFileSync("docker", ["compose", "version"], { stdio: "ignore" });
    execFileSync("docker", ["compose", "-p", config.projectName, "-f", config.composeFile, "up", "-d"], { cwd: config.repoRoot, stdio: "inherit" });
    await waitForComposeHealthy(config);
    try { execFileSync("docker", ["compose", "-p", config.projectName, "-f", config.composeFile, "exec", "-T", "temporal", "temporal", "operator", "namespace", "describe", "--namespace", "spaceapp-dev"], { stdio: "ignore" }); }
    catch { execFileSync("docker", ["compose", "-p", config.projectName, "-f", config.composeFile, "exec", "-T", "temporal", "temporal", "operator", "namespace", "create", "--namespace", "spaceapp-dev"], { stdio: "ignore" }); }
    execFileSync("npm", ["run", "check"], { cwd: config.repoRoot, env, stdio: "inherit" });
    execFileSync(process.execPath, ["packages/db/dist/migrate.js"], { cwd: config.repoRoot, env, stdio: "inherit" });
    execFileSync("npm", ["run", "build", "-w", "@space/worker"], { cwd: config.repoRoot, env, stdio: "inherit" });
    if (stopping) return;
    // No PID from disk is ever signalled. Only an authenticated socket can ask
    // this supervisor to stop its own live child process groups.
    control = createServer({ allowHalfOpen: true }, socket => {
      let input = "";
      socket.setTimeout(2000, () => socket.destroy());
      socket.on("error", () => { /* Disconnected control client. */ });
      socket.on("data", data => { input += data; if (input.length > 1024) socket.destroy(); });
      socket.on("end", async () => {
        try { const command = JSON.parse(input); if (command.token !== owner.token || command.action !== "stop") return socket.destroy(); }
        catch { return socket.destroy(); }
        socket.setTimeout(0);
        await stopAll(); socket.end("stopped");
      });
    });
    await new Promise((resolve, reject) => control.once("error", reject).listen(join(config.runDir, "control.sock"), resolve));
    await chmod(join(config.runDir, "control.sock"), 0o600);
    await writeFile(config.pidFile, JSON.stringify({ supervisorPid: process.pid }), { mode: 0o600 });
    for (const command of commands) startManaged(...command);
    await writeFile(config.pidFile, JSON.stringify({ supervisorPid: process.pid, childPids: [...children.values()].map(child => child.pid).filter(Boolean) }), { mode: 0o600 });
    await waitForHttpReady(`http://127.0.0.1:${config.webPort}/readyz`, () => { if (fatalError) throw fatalError; if (stopping) throw new Error("Startup interrupted."); });
    process.stdout.write(`SpaceApp from source: http://127.0.0.1:${config.webPort}\nSetup token: ${secrets.setupToken}\nBrowser host and non-OpenCode providers are disabled.\nUse down to stop, reset to remove owned state; after package edits run down then up.\n`);
    monitor = setInterval(() => {
      try { const rows = execFileSync("docker", ["compose", "-p", config.projectName, "-f", config.composeFile, "ps", "--format", "json"], { encoding: "utf8", timeout: 5000 });
        const services = rows.trim().split(/\r?\n/).filter(Boolean).map(JSON.parse);
        if (!["postgres", "temporal"].every(name => services.some(row => row.Service === name && row.Health === "healthy"))) throw new Error();
      } catch { fatalError = new Error("Dev infrastructure is unhealthy; stopping services."); process.stderr.write(fatalError.message + "\n"); void stopAll(); }
    }, 10000);
    await new Promise(resolve => { const timer = setInterval(() => { if (stopping) { clearInterval(timer); resolve(); } }, 200); });
  } finally {
    await stopAll();
    if (control) await new Promise(resolve => control.close(resolve));
    await rm(config.pidFile, { force: true });
    await rm(join(config.runDir, "control.sock"), { force: true });
    await rm(lock, { recursive: true, force: true });
    process.off("SIGINT", signalStop); process.off("SIGTERM", signalStop);
  }
  if (fatalError) throw fatalError;
}

export async function runDevStackCli(args = process.argv.slice(2)) {
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major !== 22 || minor < 12) throw new Error("dev:stack requires Node >=22.12 <23.");
  const command = args.find((arg) => !arg.startsWith("-")) ?? "up";
  if (args.includes("--detach")) throw new Error("Run dev:stack in the foreground, or background it with your shell/CI; --detach is not supported.");
  const config = resolveDevStackConfig();
  if (command === "down" || command === "stop") {
    await runDevStackDown(config);
    return;
  }
  if (command === "reset" || command === "clean") {
    await runDevStackReset(config);
    return;
  }
  if (command === "rebuild") {
    await runDevStackDown(config);
    await runDevStackUp(config);
    return;
  }
  if (command === "up" || command === "start") {
    await runDevStackUp(config);
    return;
  }
  throw new Error(`Unknown dev:stack command "${command}". Expected: up, down, or reset.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runDevStackCli().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
