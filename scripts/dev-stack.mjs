#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  chmod,
  copyFile,
  mkdir,
  readFile,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const COMPOSE_TEMPLATE_PATH = join(REPO_ROOT, "packages/run-spaceapp/templates/compose.yml");
const DOCKERFILE_PATH = join(REPO_ROOT, "Dockerfile");

export function extractPinnedDevImages(composeYaml) {
  const pgMatch = /^\s*image:\s*(pgvector\/pgvector:[^\s#]+@sha256:[a-f0-9]{64})/m.exec(composeYaml);
  const temporalMatch = /^\s*image:\s*(temporalio\/auto-setup:[^\s#]+@sha256:[a-f0-9]{64})/m.exec(composeYaml);
  if (!pgMatch || !temporalMatch) {
    throw new Error("Could not extract digest-pinned postgres and temporal images from packages/run-spaceapp/templates/compose.yml.");
  }
  return {
    postgresImage: pgMatch[1],
    temporalImage: temporalMatch[1]
  };
}

export function extractPinnedOpenCodeSpec(dockerfileText) {
  const match = /(?:@opencode\/cli|opencode-ai)@[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?/.exec(dockerfileText);
  if (!match) {
    throw new Error("Could not extract pinned opencode-ai package spec from Dockerfile.");
  }
  return match[0];
}

export function resolveDevStackConfig(env = process.env, repoRoot = REPO_ROOT) {
  const stateDir = resolve(repoRoot, env.SPACE_DEV_STACK_DIR || ".dev-stack");
  const apiPort = Number.parseInt(env.SPACE_DEV_API_PORT || "14910", 10);
  const webPort = Number.parseInt(env.SPACE_DEV_WEB_PORT || "14911", 10);
  const postgresPort = Number.parseInt(env.SPACE_DEV_POSTGRES_PORT || "15432", 10);
  const temporalPort = Number.parseInt(env.SPACE_DEV_TEMPORAL_PORT || "17233", 10);
  for (const [name, port] of [
    ["SPACE_DEV_API_PORT", apiPort],
    ["SPACE_DEV_WEB_PORT", webPort],
    ["SPACE_DEV_POSTGRES_PORT", postgresPort],
    ["SPACE_DEV_TEMPORAL_PORT", temporalPort]
  ]) {
    if (!Number.isInteger(port) || port < 1024 || port > 65535) {
      throw new Error(`${name} must be an integer between 1024 and 65535.`);
    }
  }
  const projectHash = createHash("sha256").update(stateDir).digest("hex").slice(0, 10);
  return {
    repoRoot,
    stateDir,
    composeProjectName: `spaceapp-dev-${projectHash}`,
    bindHost: "127.0.0.1",
    apiPort,
    webPort,
    postgresPort,
    temporalPort
  };
}

export function renderDevStackCompose({ postgresImage, temporalImage, postgresPort, temporalPort }) {
  return [
    "services:",
    "  postgres:",
    `    image: ${postgresImage}`,
    "    restart: unless-stopped",
    "    environment:",
    "      POSTGRES_DB: spaceapp",
    "      POSTGRES_USER: spaceapp",
    "      POSTGRES_PASSWORD_FILE: /run/secrets/postgres-password",
    "    ports:",
    `      - "127.0.0.1:${postgresPort}:5432"`,
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
    `    image: ${temporalImage}`,
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
    `      - "127.0.0.1:${temporalPort}:7233"`,
    "    secrets:",
    "      - postgres-password",
    "    healthcheck:",
    '      test: ["CMD-SHELL", "temporal operator cluster health --address 127.0.0.1:7233 >/dev/null && temporal operator namespace describe --namespace default --address 127.0.0.1:7233 >/dev/null"]',
    "      interval: 10s",
    "      timeout: 8s",
    "      retries: 20",
    "",
    "secrets:",
    "  postgres-password:",
    "    file: ./secrets/postgres-password",
    "",
    "volumes:",
    "  dev-postgres: {}",
    ""
  ].join("\n");
}

async function writeSecretIfMissing(filePath, generator) {
  try {
    const existing = (await readFile(filePath, "utf8")).trim();
    await chmod(filePath, 0o600);
    return existing;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    const value = generator();
    await writeFile(filePath, `${value}\n`, { encoding: "utf8", mode: 0o600 });
    await chmod(filePath, 0o600);
    return value;
  }
}

export async function prepareDevStackState(cfg) {
  const secretsDir = join(cfg.stateDir, "secrets");
  const memoryDir = join(cfg.stateDir, "memory");
  const memoryGraphDir = join(cfg.stateDir, "memory-graph");
  const artifactsDir = join(cfg.stateDir, "artifacts");
  const workspacesDir = join(cfg.stateDir, "workspaces");
  const cliStateDir = join(cfg.stateDir, "cli-state");
  const binDir = join(cfg.stateDir, "bin");
  const runDir = join(cfg.stateDir, "run");

  for (const dir of [cfg.stateDir, secretsDir, memoryDir, memoryGraphDir, artifactsDir, workspacesDir, cliStateDir, binDir, runDir]) {
    await mkdir(dir, { recursive: true, mode: 0o700 });
  }

  const postgresPassword = await writeSecretIfMissing(
    join(secretsDir, "postgres-password"),
    () => randomBytes(32).toString("base64url")
  );
  const databaseUrl = `postgresql://spaceapp:${encodeURIComponent(postgresPassword)}@127.0.0.1:${cfg.postgresPort}/spaceapp`;
  await writeFile(join(secretsDir, "database-url"), `${databaseUrl}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(join(secretsDir, "database-url"), 0o600);

  const sessionSecret = await writeSecretIfMissing(
    join(secretsDir, "session-secret"),
    () => randomBytes(48).toString("base64url")
  );
  const setupToken = await writeSecretIfMissing(
    join(secretsDir, "setup-token"),
    () => randomBytes(32).toString("base64url")
  );

  // Copy starter memory files if missing
  for (const file of ["space_memory.md", "space_memory_monthly.md", "installation-guide.md"]) {
    const src = join(cfg.repoRoot, "starter-memory", file);
    const dst = join(memoryDir, file);
    try {
      await stat(dst);
    } catch {
      try {
        await copyFile(src, dst);
        await chmod(dst, 0o600);
      } catch {}
    }
  }

  const composeTemplate = await readFile(COMPOSE_TEMPLATE_PATH, "utf8");
  const images = extractPinnedDevImages(composeTemplate);
  const composeContent = renderDevStackCompose({
    ...images,
    postgresPort: cfg.postgresPort,
    temporalPort: cfg.temporalPort
  });
  const composeFile = join(cfg.stateDir, "compose.dev.yml");
  await writeFile(composeFile, composeContent, { encoding: "utf8", mode: 0o600 });

  // Write local opencode-vscode-parity wrapper script in .dev-stack/bin
  const wrapperPath = join(binDir, "opencode-vscode-parity");
  const vendorPrefix = join(cliStateDir, "vendor", "opencode");
  const wrapperScript = [
    "#!/bin/sh",
    "set -eu",
    `export HOME="${cliStateDir}"`,
    `exec "${join(vendorPrefix, "node_modules", ".bin", "opencode")}" "$@"`,
    ""
  ].join("\n");
  await writeFile(wrapperPath, wrapperScript, { encoding: "utf8", mode: 0o755 });
  await chmod(wrapperPath, 0o755);

  return {
    composeFile,
    databaseUrl,
    sessionSecret,
    setupToken,
    socketPath: join(runDir, "cli-host.sock"),
    memoryDir,
    memoryGraphDir,
    artifactsDir,
    workspacesDir,
    cliStateDir,
    binDir,
    vendorPrefix
  };
}

export function buildDevProcessEnv(cfg, state, baseEnv = process.env) {
  return {
    ...baseEnv,
    SPACE_DEV_LOGIN: "false",
    SPACE_RUNTIME_STORE: "postgres",
    SPACE_DATABASE_URL: state.databaseUrl,
    SPACE_DATABASE_URL_FILE: join(cfg.stateDir, "secrets", "database-url"),
    SPACE_SESSION_SECRET: state.sessionSecret,
    SPACE_SESSION_SECRET_FILE: join(cfg.stateDir, "secrets", "session-secret"),
    SPACE_SETUP_TOKEN_FILE: join(cfg.stateDir, "secrets", "setup-token"),
    SPACE_API_HOST: "127.0.0.1",
    SPACE_API_PORT: String(cfg.apiPort),
    SPACE_WEB_HOST: "127.0.0.1",
    SPACE_WEB_PORT: String(cfg.webPort),
    SPACE_API_ORIGIN: `http://127.0.0.1:${cfg.apiPort}`,
    SPACE_TEMPORAL_ADDRESS: `127.0.0.1:${cfg.temporalPort}`,
    SPACEAPP_WORKFLOWS_ENABLED: "true",
    SPACE_MEMORY_ROOT: state.memoryDir,
    SPACE_STARTER_MEMORY_ROOT: join(cfg.repoRoot, "starter-memory"),
    SPACE_MEMORY_GRAPH_ROOT: state.memoryGraphDir,
    SPACE_MEMORY_INDEX_PATH: join(state.memoryDir, "space_memory.md"),
    SPACE_MEMORY_MONTHLY_PATH: join(state.memoryDir, "space_memory_monthly.md"),
    SPACE_MEMORY_LOCK_PATH: join(state.memoryDir, ".memory.lock"),
    SPACE_ARTIFACT_ROOT: state.artifactsDir,
    SPACE_CLI_HOST_SOCKET: state.socketPath,
    SPACE_CLI_ENABLED: "true",
    SPACE_CLI_COMMAND_PATH: state.binDir,
    SPACE_CLI_WORKSPACE_ROOT: state.workspacesDir,
    SPACE_BROWSER_SESSIONS_ENABLED: "false",
    PATH: `${state.binDir}:${baseEnv.PATH || "/usr/local/bin:/usr/bin:/bin"}`
  };
}

function runCommand(command, args, options = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, { stdio: "inherit", ...options });
    child.once("error", rejectPromise);
    child.once("exit", (code) => resolvePromise(code ?? 1));
  });
}

export async function superviseProcesses(specs, { spawnFn = spawn, stdout = process.stdout, stderr = process.stderr } = {}) {
  const children = new Map();
  let stopping = false;

  const stopAll = (signal = "SIGTERM") => {
    if (stopping) return;
    stopping = true;
    for (const child of children.values()) {
      try { child.kill(signal); } catch {}
    }
  };

  return await new Promise((resolvePromise) => {
    for (const spec of specs) {
      const child = spawnFn(spec.command, spec.args, { env: spec.env, cwd: spec.cwd, stdio: "inherit" });
      children.set(spec.name, child);
      child.once("error", (err) => {
        stderr.write(`[dev:stack] ERROR: process "${spec.name}" failed to start: ${err.message}\n`);
        stopAll();
        resolvePromise(1);
      });
      child.once("exit", (code, signal) => {
        children.delete(spec.name);
        if (!stopping) {
          stderr.write(`[dev:stack] ERROR: process "${spec.name}" exited unexpectedly (${code ?? signal}). Stopping dev stack.\n`);
          stopAll();
          resolvePromise(code || 1);
          return;
        }
        if (children.size === 0) {
          resolvePromise(0);
        }
      });
    }
  });
}

async function main() {
  const args = process.argv.slice(2);
  const subcommand = args[0] || "up";
  const cfg = resolveDevStackConfig(process.env, REPO_ROOT);
  const state = await prepareDevStackState(cfg);

  if (subcommand === "--help" || subcommand === "-h" || subcommand === "help") {
    process.stdout.write(
      "Usage: npm run dev:stack [-- up|down|reset|--plan]\n" +
      `  up (default)  Start Postgres/Temporal in Docker, run migrations, and run API, Web, Worker & CLI host from source (${cfg.stateDir})\n` +
      "  down          Stop running dev:stack containers\n" +
      "  reset         Remove dev:stack containers, volumes, and state directory\n"
    );
    return;
  }

  if (subcommand === "--plan") {
    process.stdout.write(JSON.stringify({
      project: cfg.composeProjectName,
      stateDir: cfg.stateDir,
      url: `http://127.0.0.1:${cfg.webPort}`,
      apiOrigin: `http://127.0.0.1:${cfg.apiPort}`,
      postgresPort: cfg.postgresPort,
      temporalPort: cfg.temporalPort
    }, null, 2) + "\n");
    return;
  }

  if (subcommand === "down") {
    const code = await runCommand("docker", [
      "compose", "--project-name", cfg.composeProjectName, "-f", state.composeFile, "down"
    ]);
    process.exitCode = code;
    return;
  }

  if (subcommand === "reset") {
    const code = await runCommand("docker", [
      "compose", "--project-name", cfg.composeProjectName, "-f", state.composeFile, "down", "--volumes", "--remove-orphans"
    ]);
    await rm(cfg.stateDir, { recursive: true, force: true });
    process.stdout.write(`[dev:stack] Reset complete. Removed ${cfg.stateDir} and Docker volumes.\n`);
    process.exitCode = code;
    return;
  }

  if (subcommand !== "up") {
    throw new Error(`Unknown dev:stack subcommand "${subcommand}". Expected up, down, or reset.`);
  }

  // 1. Start Postgres & Temporal in Docker
  process.stdout.write(`[dev:stack] Starting PostgreSQL and Temporal (${cfg.composeProjectName})...\n`);
  const upCode = await runCommand("docker", [
    "compose", "--project-name", cfg.composeProjectName, "-f", state.composeFile, "up", "-d", "--wait"
  ]);
  if (upCode !== 0) {
    process.exitCode = upCode;
    return;
  }

  // 2. Ensure pinned opencode-ai is installed in .dev-stack/cli-state/vendor/opencode
  const opencodeBin = join(state.vendorPrefix, "node_modules", ".bin", "opencode");
  try {
    await stat(opencodeBin);
  } catch {
    const dockerfileText = await readFile(DOCKERFILE_PATH, "utf8");
    const opencodeSpec = extractPinnedOpenCodeSpec(dockerfileText);
    await mkdir(state.vendorPrefix, { recursive: true, mode: 0o700 });
    process.stdout.write(`[dev:stack] Installing ${opencodeSpec} into ${state.vendorPrefix}...\n`);
    const installCode = await runCommand("npm", ["install", "--prefix", state.vendorPrefix, "--no-audit", "--no-fund", opencodeSpec]);
    if (installCode !== 0) {
      process.exitCode = installCode;
      return;
    }
  }

  // 3. Build workspace packages & run database migrations
  const devEnv = buildDevProcessEnv(cfg, state);
  const migrateCode = await runCommand("npm", ["run", "db:migrate"], { cwd: REPO_ROOT, env: devEnv });
  if (migrateCode !== 0) {
    process.exitCode = migrateCode;
    return;
  }

  process.stdout.write(`\n[dev:stack] SpaceApp dev stack starting at http://127.0.0.1:${cfg.webPort}\n`);
  process.stdout.write(`[dev:stack] One-time owner setup token: ${state.setupToken}\n\n`);

  // 4. Start CLI host, API (watch), Worker (watch), and Vite Web dev server from source
  process.exitCode = await superviseProcesses([
    { name: "cli-host", command: "npx", args: ["tsx", "watch", "packages/cli-host/src/main.ts"], cwd: REPO_ROOT, env: devEnv },
    { name: "api", command: "npx", args: ["tsx", "watch", "apps/api/src/server.ts"], cwd: REPO_ROOT, env: devEnv },
    { name: "worker", command: "npx", args: ["tsx", "watch", "apps/worker/src/worker.ts"], cwd: REPO_ROOT, env: devEnv },
    { name: "web", command: "npm", args: ["run", "dev", "-w", "@space/web"], cwd: REPO_ROOT, env: devEnv }
  ]);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    process.stderr.write(`[dev:stack] ${err?.message || String(err)}\n`);
    process.exitCode = 1;
  });
}
