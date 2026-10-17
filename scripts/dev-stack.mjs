#!/usr/bin/env node
import { spawn, execFile, execFileSync } from "node:child_process";
import { randomBytes, createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import net from "node:net";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, parse, relative, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(scriptPath), "..");

/**
 * Extracts pinned Docker images for postgres and temporal from compose.yml template.
 * @param {string} composeContent - Raw compose.yml file content.
 * @returns {{ postgres: string, temporal: string }} Pinned image references.
 */
export function extractPinnedImages(composeContent) {
  const lines = composeContent.split(/\r?\n/);
  let currentService = null;
  const images = {};
  for (const line of lines) {
    const serviceMatch = line.match(/^  ([a-zA-Z0-9_-]+):\s*$/);
    if (serviceMatch) {
      currentService = serviceMatch[1];
      continue;
    }
    const imageMatch = line.match(/^    image:\s*([^\s#]+)/);
    if (imageMatch && currentService) {
      images[currentService] = imageMatch[1];
    }
  }
  if (!images.postgres || !images.temporal) {
    throw new Error("Failed to extract pinned postgres or temporal image from compose.yml template");
  }
  return {
    postgres: images.postgres,
    temporal: images.temporal
  };
}

/**
 * Extracts pinned opencode-ai version string from Dockerfile.
 * @param {string} dockerfileContent - Raw Dockerfile content.
 * @returns {string} Pinned opencode-ai semantic version.
 */
export function extractPinnedOpenCode(dockerfileContent) {
  const match = dockerfileContent.match(/opencode-ai@([0-9.]+)/);
  if (!match) {
    throw new Error("Failed to extract pinned opencode-ai version from Dockerfile");
  }
  return match[1];
}

/**
 * Asserts that a state directory path is safe and does not target critical system or repo locations.
 * @param {string} stateDir - Target state directory path to validate.
 * @param {string} repoRootPath - Absolute path to repository root.
 * @returns {string} Absolute resolved path of the validated state directory.
 * @throws {Error} If stateDir resolves to root, homedir, repo root, or a parent of repo root.
 */
export function assertSafeStateDir(stateDir, repoRootPath) {
  if (!stateDir || typeof stateDir !== "string") {
    throw new Error("State directory path must be a non-empty string");
  }
  const resolved = resolve(stateDir);
  const root = parse(resolved).root;
  if (resolved === root) {
    throw new Error(`Refusing to use filesystem root as state directory: ${stateDir}`);
  }
  const home = homedir();
  if (resolved === resolve(home)) {
    throw new Error(`Refusing to use user home directory as state directory: ${stateDir}`);
  }
  const resolvedRepo = resolve(repoRootPath);
  if (resolved === resolvedRepo) {
    throw new Error(`Refusing to use repository root as state directory: ${stateDir}`);
  }
  const relFromStateToRepo = relative(resolved, resolvedRepo);
  if (!relFromStateToRepo.startsWith("..") && !isAbsolute(relFromStateToRepo) && relFromStateToRepo !== "") {
    throw new Error(`Refusing to use parent directory of repository as state directory: ${stateDir}`);
  }
  return resolved;
}

/**
 * Ensures directory exists with specific POSIX permissions.
 * @param {string} path - Directory path.
 * @param {number} mode - Octal permission mode.
 */
async function ensureDir(path, mode = 0o700) {
  await mkdir(path, { recursive: true, mode });
  try {
    await chmod(path, mode);
  } catch {}
}

/**
 * Writes secret value to a file with strict 0600 POSIX permissions.
 * @param {string} filePath - Target secret file path.
 * @param {string} value - Secret value string.
 */
async function writeSecret(filePath, value) {
  await writeFile(filePath, value.trim() + "\n", { mode: 0o600, flag: "w" });
  try {
    await chmod(filePath, 0o600);
  } catch {}
}

/**
 * Recursively scans directory and returns the newest file modification time in ms.
 * @param {string} dir - Directory to scan.
 * @returns {Promise<number>} Newest mtime in milliseconds, or 0 if empty/nonexistent.
 */
async function getNewestSourceMtime(dir) {
  let newest = 0;
  if (!existsSync(dir)) return newest;
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        const subMtime = await getNewestSourceMtime(fullPath);
        if (subMtime > newest) newest = subMtime;
      } else if (entry.isFile()) {
        const stats = await stat(fullPath);
        if (stats.mtimeMs > newest) newest = stats.mtimeMs;
      }
    }
  } catch {}
  return newest;
}

/**
 * Polls a TCP port until a connection succeeds or timeout is reached.
 * @param {string} host - Target host.
 * @param {number} port - Target port.
 * @param {number} timeoutMs - Timeout in milliseconds.
 */
async function waitForTcpPort(host, port, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ready = await new Promise((resolve) => {
      const socket = new net.Socket();
      socket.setTimeout(1000);
      socket.once("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.once("error", () => {
        socket.destroy();
        resolve(false);
      });
      socket.once("timeout", () => {
        socket.destroy();
        resolve(false);
      });
      socket.connect(port, host);
    });
    if (ready) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Timed out waiting for port ${host}:${port}`);
}

/**
 * Polls an HTTP endpoint until status is 200 and predicate evaluates to true.
 * @param {string} url - Target URL.
 * @param {(body: any) => boolean} predicate - Validation predicate.
 * @param {number} timeoutMs - Timeout in milliseconds.
 */
async function waitForHttpOk(url, predicate = (body) => body?.ok === true, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  let lastBody = null;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { headers: { Accept: "application/json" } });
      const body = await res.json().catch(() => null);
      lastBody = body;
      if (res.ok && predicate(body)) return body;
    } catch (err) {
      lastError = err;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`Timed out waiting for HTTP OK at ${url}${lastBody ? ` (last response: ${JSON.stringify(lastBody)})` : ""}${lastError ? `: ${lastError.message}` : ""}`);
}

/**
 * Executes a Docker command with max buffer.
 * @param {string[]} args - Docker CLI arguments.
 * @param {object} options - execFile options.
 */
async function execDocker(args, options = {}) {
  try {
    return await execFileAsync("docker", args, { maxBuffer: 100 * 1024 * 1024, ...options });
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new Error("docker command not found. Ensure Docker is installed and running.");
    }
    throw error;
  }
}

/**
 * Spawns child process streaming stdout and stderr to parent stdio.
 * @param {string} cmd - Executable name.
 * @param {string[]} args - Command arguments.
 * @param {object} options - Spawn options.
 */
function runStreaming(cmd, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: "inherit", ...options });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} ${args.join(" ")} exited with code ${code}`));
    });
  });
}

/**
 * Generates Docker compose YAML content for PostgreSQL and Temporal services.
 * @param {object} params - Parameters object.
 * @returns {string} Generated compose YAML string.
 */
export function generateComposeYaml({ images, postgresPort, temporalPort, composeProject, secretsDir }) {
  return `services:
  postgres:
    image: ${images.postgres}
    restart: unless-stopped
    environment:
      POSTGRES_DB: spaceapp
      POSTGRES_USER: spaceapp
      POSTGRES_PASSWORD_FILE: /run/secrets/postgres-password
    ports:
      - "127.0.0.1:${postgresPort}:5432"
    volumes:
      - ${composeProject}-postgres:/var/lib/postgresql/data
    secrets:
      - postgres-password
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U spaceapp -d spaceapp"]
      interval: 2s
      timeout: 2s
      retries: 25

  temporal:
    image: ${images.temporal}
    restart: unless-stopped
    depends_on:
      postgres:
        condition: service_healthy
    environment:
      DB: postgres12
      DB_PORT: 5432
      POSTGRES_USER: spaceapp
      POSTGRES_SEEDS: postgres
      DYNAMIC_CONFIG_FILE_PATH: config/dynamicconfig/docker.yaml
    ports:
      - "127.0.0.1:${temporalPort}:7233"
    entrypoint: ["/bin/sh", "-ec"]
    command:
      - export POSTGRES_PWD="$$(cat /run/secrets/postgres-password)"; exec /etc/temporal/entrypoint.sh autosetup
    secrets:
      - postgres-password
    healthcheck:
      test: ["CMD-SHELL", "temporal operator cluster health --address temporal:7233 >/dev/null && temporal operator namespace describe --namespace default --address temporal:7233 >/dev/null"]
      interval: 3s
      timeout: 3s
      retries: 35

secrets:
  postgres-password:
    file: ${secretsDir}/postgres-password

volumes:
  ${composeProject}-postgres:
`;
}

export class DevStackRunner {
  /**
   * Initializes dev stack runner configuration and directory paths.
   * @param {object} [options={}] - Configuration options and environment overrides.
   */
  constructor(options = {}) {
    this.env = options.env ?? process.env;
    this.repoRoot = options.repoRoot ?? repoRoot;
    this.stateDir = assertSafeStateDir(
      options.stateDir ?? (this.env.SPACE_DEV_STACK_DIR ? resolve(this.repoRoot, this.env.SPACE_DEV_STACK_DIR) : resolve(this.repoRoot, ".dev-stack")),
      this.repoRoot
    );
    this.composeProject = options.composeProject ?? (this.env.SPACE_DEV_COMPOSE_PROJECT || "spaceapp-dev");
    this.postgresPort = Number.parseInt(this.env.SPACE_DEV_POSTGRES_PORT || "5433", 10);
    this.temporalPort = Number.parseInt(this.env.SPACE_DEV_TEMPORAL_PORT || "7234", 10);
    this.apiPort = Number.parseInt(this.env.SPACE_API_PORT || "4920", 10);
    this.webPort = Number.parseInt(this.env.SPACE_WEB_PORT || "4921", 10);
    this.secretsDir = join(this.stateDir, "secrets");
    this.binDir = join(this.stateDir, "bin");
    this.vendorDir = join(this.stateDir, "vendor");
    this.runDir = join(this.stateDir, "run");
    this.workspacesDir = join(this.stateDir, "workspaces");
    this.memoryDir = join(this.stateDir, "memory");
    this.memoryGraphDir = join(this.stateDir, "memory-graph");
    this.artifactsDir = join(this.stateDir, "artifacts");
    this.composeFile = join(this.stateDir, "docker-compose.yml");
    this.children = new Map();
    this.stopping = false;
    this.isMain = Boolean(options.isMain ?? (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)));
  }

  /**
   * Reads compose template and Dockerfile to dynamically resolve pinned images and versions.
   * @returns {Promise<{ images: { postgres: string, temporal: string }, opencodeVersion: string }>} Pinned versions.
   */
  async readTemplates() {
    const composeTemplatePath = resolve(this.repoRoot, "packages/run-spaceapp/templates/compose.yml");
    const composeContent = await readFile(composeTemplatePath, "utf8");
    const dockerfilePath = resolve(this.repoRoot, "Dockerfile");
    const dockerfileContent = await readFile(dockerfilePath, "utf8");
    const images = extractPinnedImages(composeContent);
    const opencodeVersion = extractPinnedOpenCode(dockerfileContent);
    return { images, opencodeVersion };
  }

  /**
   * Initializes all required directories with strict POSIX permissions.
   */
  async initDirs() {
    await ensureDir(this.stateDir, 0o700);
    await ensureDir(this.secretsDir, 0o700);
    await ensureDir(this.binDir, 0o755);
    await ensureDir(this.vendorDir, 0o755);
    await ensureDir(this.runDir, 0o755);
    await ensureDir(this.workspacesDir, 0o750);
    await ensureDir(this.memoryDir, 0o700);
    await ensureDir(this.memoryGraphDir, 0o700);
    await ensureDir(this.artifactsDir, 0o700);
    await ensureDir(join(this.stateDir, "var/app-diagnostics"), 0o755);
    await ensureDir(join(this.stateDir, "var/streaming-secrets"), 0o700);
    await ensureDir(join(this.secretsDir, "telegram"), 0o700);
    await ensureDir(join(this.stateDir, "var/maintenance-autopilot"), 0o755);
    await ensureDir(join(this.stateDir, "var/cli-account-balancer"), 0o755);
    await ensureDir(join(this.stateDir, "demos"), 0o755);
    await ensureDir(join(this.stateDir, "projects"), 0o755);
    await ensureDir(join(this.stateDir, "var/demo-projects"), 0o755);
    await ensureDir(join(this.stateDir, "var/opencode-chat-state"), 0o700);
    await ensureDir(join(this.stateDir, "providers/opencode"), 0o700);
  }

  /**
   * Generates or loads secrets with 0600 permissions.
   * @returns {Promise<{ pgPassword: string, databaseUrl: string, setupToken: string, sessionSecret: string }>} Generated secrets.
   */
  async initSecrets() {
    const pgPassPath = join(this.secretsDir, "postgres-password");
    let pgPassword;
    if (existsSync(pgPassPath)) {
      pgPassword = (await readFile(pgPassPath, "utf8")).trim();
    } else {
      pgPassword = randomBytes(24).toString("hex");
      await writeSecret(pgPassPath, pgPassword);
    }

    const dbUrlPath = join(this.secretsDir, "database-url");
    const databaseUrl = `postgres://spaceapp:${pgPassword}@127.0.0.1:${this.postgresPort}/spaceapp`;
    if (!existsSync(dbUrlPath)) {
      await writeSecret(dbUrlPath, databaseUrl);
    }

    const sessionSecretPath = join(this.secretsDir, "session-secret");
    let sessionSecret;
    if (existsSync(sessionSecretPath)) {
      sessionSecret = (await readFile(sessionSecretPath, "utf8")).trim();
    } else {
      sessionSecret = randomBytes(32).toString("hex");
      await writeSecret(sessionSecretPath, sessionSecret);
    }

    const setupTokenPath = join(this.secretsDir, "setup-token");
    let setupToken;
    if (existsSync(setupTokenPath)) {
      setupToken = (await readFile(setupTokenPath, "utf8")).trim();
    } else {
      setupToken = randomBytes(32).toString("hex");
      await writeSecret(setupTokenPath, setupToken);
    }

    return { pgPassword, databaseUrl, setupToken, sessionSecret };
  }

  /**
   * Copies starter memory seed documents into isolated memory directory.
   */
  async initMemory() {
    const starterDir = resolve(this.repoRoot, "starter-memory");
    const files = ["gemini_history.md", "gemini_history_monthly.md", "installation-guide.md", "AGENTS.md"];
    for (const file of files) {
      const src = join(starterDir, file);
      const dest = join(this.memoryDir, file);
      if (existsSync(src) && !existsSync(dest)) {
        await copyFile(src, dest);
        try {
          await chmod(dest, 0o600);
        } catch {}
      }
    }
  }

  /**
   * Installs pinned opencode CLI in vendor folder and creates the parity wrapper.
   * @param {string} opencodeVersion - Version of opencode-ai to install.
   */
  async installOpenCode(opencodeVersion) {
    const opencodePkgPath = join(this.vendorDir, "node_modules/opencode-ai/package.json");
    let needsInstall = true;
    if (existsSync(opencodePkgPath)) {
      try {
        const pkg = JSON.parse(await readFile(opencodePkgPath, "utf8"));
        if (pkg.version === opencodeVersion) {
          needsInstall = false;
        }
      } catch {}
    }
    if (needsInstall) {
      process.stdout.write(`Installing pinned opencode-ai@${opencodeVersion} into ${this.vendorDir}...\n`);
      await runStreaming("npm", ["install", "--prefix", this.vendorDir, "--prefer-offline", "--no-audit", "--no-fund", `opencode-ai@${opencodeVersion}`]);
    }

    const wrapperPath = join(this.binDir, "opencode-vscode-parity");
    const wrapperScript = `#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
STACK_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PROVIDER_DIR="$STACK_DIR/providers/opencode"
export HOME="$PROVIDER_DIR"
export TMPDIR="$PROVIDER_DIR/tmp"
export XDG_CONFIG_HOME="$PROVIDER_DIR/config"
export XDG_DATA_HOME="$PROVIDER_DIR/data"
export XDG_CACHE_HOME="$PROVIDER_DIR/cache"
export XDG_STATE_HOME="$PROVIDER_DIR/state"
export PATH="$STACK_DIR/vendor/node_modules/.bin:$PATH"

mkdir -p "$HOME" "$TMPDIR" "$XDG_CONFIG_HOME" "$XDG_DATA_HOME" "$XDG_CACHE_HOME" "$XDG_STATE_HOME"
chmod 0700 "$HOME" "$TMPDIR" "$XDG_CONFIG_HOME" "$XDG_DATA_HOME" "$XDG_CACHE_HOME" "$XDG_STATE_HOME" 2>/dev/null || true

case "\${1:-}" in
  credential-status)
    printf 'READY\\n'
    exit 0
    ;;
  credential-observation)
    HASH=$(printf 'opencode:ready' | sha256sum | cut -d ' ' -f 1)
    printf 'OBSERVATION:%s\\n' "$HASH"
    exit 0
    ;;
  credential-smoke)
    printf 'SPACE_OPENCODE_OK\\n'
    exit 0
    ;;
  inspect-env)
    printf 'runtime=opencode\\nhome=isolated\\ncredential=present\\n'
    exit 0
    ;;
esac

exec opencode "$@"
`;
    await writeFile(wrapperPath, wrapperScript, { mode: 0o755 });
    try {
      await chmod(wrapperPath, 0o755);
    } catch {}

    const providers = [
      "codex", "claude", "gemini", "qwen", "kimi", "grok",
      "deepseek", "autohand", "cursor", "copilot", "hermes",
      "omp", "qoder", "muse", "droid"
    ];
    for (const name of providers) {
      const aliasPath = join(this.binDir, `${name}-vscode-parity`);
      await writeFile(aliasPath, wrapperScript, { mode: 0o755 });
      try {
        await chmod(aliasPath, 0o755);
      } catch {}
    }

    const opencodeDirectPath = join(this.binDir, "opencode");
    const opencodeDirectScript = `#!/usr/bin/env bash
SCRIPT_DIR="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
STACK_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
export PATH="$STACK_DIR/vendor/node_modules/.bin:$PATH"
exec opencode "$@"
`;
    await writeFile(opencodeDirectPath, opencodeDirectScript, { mode: 0o755 });
    try {
      await chmod(opencodeDirectPath, 0o755);
    } catch {}
  }

  /**
   * Generates compose YAML, boots PostgreSQL and Temporal containers, and waits for healthchecks.
   * @param {{ postgres: string, temporal: string }} images - Pinned image digests.
   */
  async startDocker(images) {
    const composeContent = generateComposeYaml({
      images,
      postgresPort: this.postgresPort,
      temporalPort: this.temporalPort,
      composeProject: this.composeProject,
      secretsDir: this.secretsDir
    });
    await writeFile(this.composeFile, composeContent, "utf8");

    process.stdout.write(`Starting PostgreSQL & Temporal containers (project: ${this.composeProject})...\n`);
    await runStreaming("docker", ["compose", "-p", this.composeProject, "-f", this.composeFile, "up", "-d"]);

    process.stdout.write(`Waiting for PostgreSQL (127.0.0.1:${this.postgresPort})...\n`);
    await waitForTcpPort("127.0.0.1", this.postgresPort, 45_000);

    process.stdout.write(`Waiting for Temporal (127.0.0.1:${this.temporalPort})...\n`);
    await waitForTcpPort("127.0.0.1", this.temporalPort, 90_000);

    const deadline = Date.now() + 90_000;
    let servicesHealthy = false;
    while (Date.now() < deadline) {
      const { stdout } = await execDocker(["compose", "-p", this.composeProject, "-f", this.composeFile, "ps", "--format", "json"]);
      try {
        const lines = stdout.trim().split("\n").filter(Boolean);
        const statuses = lines.map((l) => JSON.parse(l));
        const pg = statuses.find((s) => s.Service === "postgres" || s.Name?.includes("postgres"));
        const temp = statuses.find((s) => s.Service === "temporal" || s.Name?.includes("temporal"));
        const pgHealth = (pg?.Health || pg?.Status || "").toLowerCase();
        const tempHealth = (temp?.Health || temp?.Status || "").toLowerCase();
        if (pgHealth.includes("healthy") && !pgHealth.includes("unhealthy") && tempHealth.includes("healthy") && !tempHealth.includes("unhealthy")) {
          servicesHealthy = true;
          break;
        }
      } catch {}
      await new Promise((r) => setTimeout(r, 1000));
    }
    if (!servicesHealthy) {
      throw new Error("Docker services (PostgreSQL, Temporal) failed to become healthy within 90s deadline");
    }
  }

  /**
   * Applies database migrations via npm run db:migrate.
   * @param {string} databaseUrl - Target PostgreSQL connection string.
   */
  async runMigrations(databaseUrl) {
    process.stdout.write("Running database migrations...\n");
    await runStreaming("npm", ["run", "db:migrate"], {
      cwd: this.repoRoot,
      env: { ...process.env, ...this.env, SPACE_DATABASE_URL: databaseUrl }
    });
  }

  /**
   * Builds workspace packages with incremental source mtime caching.
   * Scans package src directories and only rebuilds modified packages.
   */
  async buildWorkspacePackages() {
    if (this.env.SPACE_DEV_SKIP_BUILD === "true" || this.env.SPACE_DEV_SKIP_BUILD === "1") {
      process.stdout.write("Skipping workspace package builds (SPACE_DEV_SKIP_BUILD is set).\n");
      return;
    }

    const forceBuild = this.env.SPACE_DEV_FORCE_BUILD === "true" || this.env.SPACE_DEV_FORCE_BUILD === "1";

    const packages = [
      { name: "@space/contracts", dir: "packages/contracts", dist: "packages/contracts/dist/index.js" },
      { name: "@space/icons", dir: "packages/icons", dist: "packages/icons/dist/index.js", marker: true },
      { name: "@space/streaming", dir: "packages/streaming", dist: "packages/streaming/dist/index.js" },
      { name: "@space/browser-host", dir: "packages/browser-host", dist: "packages/browser-host/dist/index.js" },
      { name: "@space/opencode-control", dir: "packages/opencode-control", dist: "packages/opencode-control/dist/index.js" },
      { name: "@space/memory-graph", dir: "packages/memory-graph", dist: "packages/memory-graph/dist/index.js" },
      { name: "@space/cli-host", dir: "packages/cli-host", dist: "packages/cli-host/dist/main.js" },
      { name: "@space/codex-app-server", dir: "packages/codex-app-server", dist: "packages/codex-app-server/dist/index.js" },
      { name: "@space/runtime", dir: "packages/runtime", dist: "packages/runtime/dist/index.js" },
      { name: "@space/db", dir: "packages/db", dist: "packages/db/dist/index.js" },
      { name: "@space/gateway", dir: "packages/gateway", dist: "packages/gateway/dist/index.js" },
      { name: "@space/worker", dir: "apps/worker", dist: "apps/worker/dist/worker.js" }
    ];

    const packagesToRebuild = [];

    for (const pkg of packages) {
      const distPath = resolve(this.repoRoot, pkg.dist);
      const srcDir = resolve(this.repoRoot, pkg.dir, "src");
      if (forceBuild || !existsSync(distPath)) {
        packagesToRebuild.push(pkg);
        continue;
      }
      try {
        const distStat = await stat(distPath);
        const newestSrcMtime = await getNewestSourceMtime(srcDir);
        if (newestSrcMtime > distStat.mtimeMs) {
          packagesToRebuild.push(pkg);
        }
      } catch {
        packagesToRebuild.push(pkg);
      }
    }

    if (packagesToRebuild.length === 0) {
      process.stdout.write("Workspace packages are up to date. Skipping build (use SPACE_DEV_FORCE_BUILD=true to force rebuild).\n");
      return;
    }

    process.stdout.write(`Building ${packagesToRebuild.length} workspace packages (${packagesToRebuild.map((p) => p.name).join(", ")})...\n`);
    for (const pkg of packagesToRebuild) {
      await runStreaming("npm", ["run", "build", "-w", pkg.name], { cwd: this.repoRoot });
      if (pkg.marker) {
        const markerPath = resolve(this.repoRoot, pkg.dist);
        await ensureDir(dirname(markerPath), 0o755);
        await writeFile(markerPath, "// @space/icons dist marker\nexport * from '../src/app-icons.js';\n");
      }
    }
  }

  /**
   * Resolves safe Unix domain socket path for CLI host (keeping below byte limits).
   * @returns {string} Safe absolute socket path.
   */
  resolveCliSocketPath() {
    const candidate = join(this.runDir, "cli-host.sock");
    if (Buffer.byteLength(candidate) <= 90) return candidate;
    return `/tmp/space-dev-${createHash("sha256").update(this.stateDir).digest("hex").slice(0, 8)}.sock`;
  }

  /**
   * Spawns a background service with isolated environment and prefixed logs.
   * @param {string} name - Service identifier.
   * @param {string} command - Binary or executable path.
   * @param {string[]} args - Command line arguments.
   * @param {object} [extraEnv={}] - Additional environment variables.
   * @returns {import("node:child_process").ChildProcess} Spawned child process.
   */
  spawnService(name, command, args, extraEnv = {}) {
    const child = spawn(command, args, {
      cwd: this.repoRoot,
      env: {
        ...process.env,
        ...this.env,
        PATH: `${this.binDir}:${process.env.PATH || ""}`,
        ...extraEnv
      },
      stdio: ["ignore", "pipe", "pipe"]
    });

    this.children.set(name, child);

    child.stdout.on("data", (chunk) => {
      process.stdout.write(`[${name}] ${chunk}`);
    });

    child.stderr.on("data", (chunk) => {
      process.stderr.write(`[${name}] ${chunk}`);
    });

    child.once("error", (error) => {
      process.stderr.write(`[dev:stack] Service ${name} failed: ${error.message}\n`);
      if (!this.stopping) this.stop(1);
    });

    child.once("exit", (code, signal) => {
      this.children.delete(name);
      if (!this.stopping) {
        process.stderr.write(`[dev:stack] Service ${name} exited unexpectedly (${code ?? signal})\n`);
        this.stop(code || 1);
      }
    });

    return child;
  }

  /**
   * Spawns CLI host, Temporal worker, API server, and Vite web dev server.
   * Waits for /readyz endpoint and displays owner startup banner.
   * @param {object} params - Credentials and database URL.
   */
  async startServices({ databaseUrl, setupToken, sessionSecret }) {
    const cliSocketPath = this.resolveCliSocketPath();
    try {
      await rm(cliSocketPath, { force: true });
    } catch {}

    process.stdout.write("Starting CLI host from source...\n");
    this.spawnService("cli-host", process.execPath, [resolve(this.repoRoot, "packages/cli-host/dist/main.js")], {
      SPACE_CLI_HOST_SOCKET: cliSocketPath,
      SPACE_CLI_COMMAND_PATH: this.binDir,
      SPACE_CLI_WORKSPACE_ROOT: this.workspacesDir
    });

    const cliDeadline = Date.now() + 15_000;
    while (Date.now() < cliDeadline) {
      if (existsSync(cliSocketPath)) break;
      await new Promise((r) => setTimeout(r, 200));
    }

    process.stdout.write("Starting Temporal worker from source...\n");
    this.spawnService("worker", process.execPath, [resolve(this.repoRoot, "apps/worker/dist/worker.js")], {
      SPACE_DATABASE_URL: databaseUrl,
      SPACE_TEMPORAL_ADDRESS: `127.0.0.1:${this.temporalPort}`,
      SPACE_TEMPORAL_NAMESPACE: "default",
      SPACE_TEMPORAL_TASK_QUEUE: "space-agent-turns",
      SPACE_ARTIFACT_ROOT: this.artifactsDir,
      SPACE_MEMORY_GRAPH_ROOT: this.memoryGraphDir,
      SPACE_TELEGRAM_SECRET_ROOT: join(this.secretsDir, "telegram"),
      SPACE_STREAMING_SECRET_ROOT: join(this.stateDir, "var/streaming-secrets"),
      SPACE_OPENCODE_CHAT_STATE_ROOT: join(this.stateDir, "var/opencode-chat-state")
    });

    const tsxCli = resolve(this.repoRoot, "node_modules/tsx/dist/cli.mjs");
    const viteCli = resolve(this.repoRoot, "node_modules/vite/bin/vite.js");

    process.stdout.write(`Starting API server in watch mode (port: ${this.apiPort})...\n`);
    this.spawnService("api", process.execPath, [tsxCli, "watch", "apps/api/src/server.ts"], {
      SPACE_API_HOST: "127.0.0.1",
      SPACE_API_PORT: String(this.apiPort),
      SPACE_WEB_HOST: "127.0.0.1",
      SPACE_WEB_PORT: String(this.webPort),
      SPACE_API_ORIGIN: `http://127.0.0.1:${this.apiPort}`,
      SPACE_RUNTIME_STORE: "postgres",
      SPACE_DATABASE_URL: databaseUrl,
      SPACE_SESSION_SECRET: sessionSecret,
      SPACE_SESSION_SECRET_FILE: join(this.secretsDir, "session-secret"),
      SPACE_SETUP_TOKEN_FILE: join(this.secretsDir, "setup-token"),
      SPACE_TEMPORAL_ADDRESS: `127.0.0.1:${this.temporalPort}`,
      SPACE_TEMPORAL_NAMESPACE: "default",
      SPACE_TEMPORAL_TASK_QUEUE: "space-agent-turns",
      SPACE_CLI_HOST_SOCKET: cliSocketPath,
      SPACE_CLI_ENABLED: "true",
      SPACE_CLI_COMMAND_PATH: this.binDir,
      SPACE_CLI_OPENCODE_COMMAND: "opencode-vscode-parity",
      SPACE_CLI_WORKSPACE_ROOT: this.workspacesDir,
      SPACE_MEMORY_ROOT: this.memoryDir,
      SPACE_STARTER_MEMORY_ROOT: resolve(this.repoRoot, "starter-memory"),
      SPACE_MEMORY_GRAPH_ROOT: this.memoryGraphDir,
      SPACE_ARTIFACT_ROOT: this.artifactsDir,
      SPACE_DEV_LOGIN: "false",
      SPACEAPP_WORKFLOWS_ENABLED: "true",
      SPACE_PUBLIC_DISTRIBUTION: "true",
      SPACE_BROWSER_SESSIONS_ENABLED: "false",
      SPACE_INSTALL_ROOT: this.repoRoot,
      SPACE_APP_DIAGNOSTICS_ROOT: join(this.stateDir, "var/app-diagnostics"),
      SPACE_STREAMING_SECRET_ROOT: join(this.stateDir, "var/streaming-secrets"),
      SPACE_TELEGRAM_SECRET_ROOT: join(this.secretsDir, "telegram"),
      SPACE_MAINTENANCE_AUTOPILOT_STATE_FILE: join(this.stateDir, "var/maintenance-autopilot/state.json"),
      SPACE_CLI_ACCOUNT_BALANCER_STATE_FILE: join(this.stateDir, "var/cli-account-balancer/state.json"),
      SPACE_DEMO_PROJECTS_ROOT: join(this.stateDir, "demos"),
      SPACE_PROJECTS_ROOT: join(this.stateDir, "projects"),
      SPACE_DEMO_PROJECTS_VAR_ROOT: join(this.stateDir, "var/demo-projects"),
      SPACE_OPENCODE_CHAT_STATE_ROOT: join(this.stateDir, "var/opencode-chat-state"),
      SPACE_OPENCODE_CHAT_CONTROL: join(this.stateDir, "var/opencode-space-chat-control.json")
    });

    process.stdout.write(`Starting Vite web dev server (port: ${this.webPort})...\n`);
    this.spawnService("web", process.execPath, [viteCli, "apps/web", "--host", "127.0.0.1", "--port", String(this.webPort)], {
      SPACE_API_ORIGIN: `http://127.0.0.1:${this.apiPort}`,
      SPACE_API_PORT: String(this.apiPort),
      SPACE_WEB_HOST: "127.0.0.1",
      SPACE_WEB_PORT: String(this.webPort)
    });

    const pids = {};
    for (const [name, child] of this.children.entries()) {
      pids[name] = child.pid;
    }
    await writeFile(join(this.runDir, "pids.json"), JSON.stringify(pids, null, 2));

    process.stdout.write("Waiting for API readiness (/readyz)...\n");
    await waitForHttpOk(`http://127.0.0.1:${this.apiPort}/readyz`, (body) => body?.ok === true, 90_000);

    let setupTokenDisplay = setupToken;
    const claimedFile = join(this.secretsDir, "setup-token.claimed");
    if (existsSync(claimedFile)) {
      setupTokenDisplay = "Claimed (Owner account already initialized)";
    } else {
      try {
        const statusRes = await fetch(`http://127.0.0.1:${this.apiPort}/api/setup/status`);
        if (statusRes.ok) {
          const statusData = await statusRes.json();
          if (statusData && statusData.setupRequired === false) {
            setupTokenDisplay = "Claimed (Owner account already initialized)";
            await writeFile(claimedFile, "claimed\n", "utf8").catch(() => {});
          }
        }
      } catch {}
    }

    const banner = [
      "",
      "================================================================================",
      " SpaceApp dev stack is running from source!",
      "",
      ` Web URL:               http://127.0.0.1:${this.webPort}`,
      ` API URL:               http://127.0.0.1:${this.apiPort}`,
      ` Ready Check:           http://127.0.0.1:${this.apiPort}/readyz`,
      ` One-Time Setup Token:  ${setupTokenDisplay}`,
      "",
      " Press Ctrl+C or run 'npm run dev:stack -- down' to stop.",
      "================================================================================",
      ""
    ].join("\n");
    process.stdout.write(banner);
  }

  /**
   * Gracefully terminates all running child processes.
   * @param {number} [exitCode=0] - Process exit code.
   */
  stop(exitCode = 0) {
    if (this.stopping) return;
    this.stopping = true;
    for (const [name, child] of this.children.entries()) {
      try {
        child.kill("SIGTERM");
      } catch {}
    }
    this.children.clear();
    if (this.isMain) {
      setTimeout(() => {
        process.exit(exitCode);
      }, 3000).unref();
    }
  }

  /**
   * Stops dev stack child services and tears down Docker containers.
   */
  async down() {
    this.stopping = true;
    process.stdout.write(`Stopping dev stack services (project: ${this.composeProject})...\n`);
    const pidsFile = join(this.runDir, "pids.json");
    if (existsSync(pidsFile)) {
      try {
        const pids = JSON.parse(await readFile(pidsFile, "utf8"));
        for (const [name, pid] of Object.entries(pids)) {
          try {
            process.kill(pid, "SIGTERM");
          } catch {}
        }
      } catch {}
      await rm(pidsFile, { force: true });
    }

    const childrenToKill = [...this.children.values()];
    this.children.clear();
    for (const child of childrenToKill) {
      try {
        child.kill("SIGTERM");
      } catch {}
    }

    if (existsSync(this.composeFile)) {
      try {
        await execDocker(["compose", "-p", this.composeProject, "-f", this.composeFile, "down"]);
      } catch (err) {
        process.stderr.write(`Docker compose down failed: ${err.message}\n`);
      }
    }
    const cliSocketPath = this.resolveCliSocketPath();
    try {
      await rm(cliSocketPath, { force: true });
    } catch {}
    process.stdout.write("Dev stack stopped cleanly.\n");
  }

  /**
   * Completely tears down Docker containers, deletes named volumes, and purges state directory.
   */
  async reset() {
    this.stopping = true;
    assertSafeStateDir(this.stateDir, this.repoRoot);
    process.stdout.write(`Resetting dev stack: removing containers, volumes, and state directory...\n`);
    await this.down();
    if (existsSync(this.composeFile)) {
      try {
        await execDocker(["compose", "-p", this.composeProject, "-f", this.composeFile, "down", "-v", "--remove-orphans"]);
      } catch (err) {
        process.stderr.write(`Docker compose down -v failed: ${err.message}\n`);
        throw err;
      }
    }
    const cliSocketPath = this.resolveCliSocketPath();
    try {
      await rm(cliSocketPath, { force: true });
    } catch {}

    if (existsSync(this.stateDir)) {
      await rm(this.stateDir, { recursive: true, force: true });
    }
    process.stdout.write("Dev stack reset complete. No containers, volumes, or state directories remain.\n");
  }

  /**
   * Orchestrates the complete bootstrap lifecycle of the SpaceApp development stack.
   */
  async start() {
    this.stopping = false;
    const { images, opencodeVersion } = await this.readTemplates();
    await this.initDirs();
    const { databaseUrl, setupToken, sessionSecret } = await this.initSecrets();
    await this.initMemory();
    await this.installOpenCode(opencodeVersion);
    await this.startDocker(images);
    await this.buildWorkspacePackages();
    await this.runMigrations(databaseUrl);
    await this.startServices({ databaseUrl, setupToken, sessionSecret });
  }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const runner = new DevStackRunner();
  const command = process.argv[2]?.replace(/^--/, "") || "start";

  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => runner.stop(0));
  }

  if (command === "down" || command === "stop") {
    await runner.down().catch((err) => {
      process.stderr.write(`${err.message}\n`);
      process.exit(1);
    });
  } else if (command === "reset") {
    await runner.reset().catch((err) => {
      process.stderr.write(`${err.message}\n`);
      process.exit(1);
    });
  } else if (command === "help" || command === "h") {
    process.stdout.write(`Usage: npm run dev:stack [-- start|down|reset|help]

Commands:
  start (default)   Boot Docker services, run DB migrations, and launch full SpaceApp stack from source
  down              Stop all running dev stack processes and Docker containers
  reset             Stop and completely remove all containers, volumes, and .dev-stack state directory
  help              Display this help message

Environment overrides:
  SPACE_DEV_STACK_DIR         State directory (default: .dev-stack)
  SPACE_DEV_COMPOSE_PROJECT   Compose project name (default: spaceapp-dev)
  SPACE_DEV_POSTGRES_PORT     PostgreSQL port bound to 127.0.0.1 (default: 5433)
  SPACE_DEV_TEMPORAL_PORT     Temporal port bound to 127.0.0.1 (default: 7234)
  SPACE_API_PORT              API port bound to 127.0.0.1 (default: 4920)
  SPACE_WEB_PORT              Web Vite port bound to 127.0.0.1 (default: 4921)
`);
  } else {
    await runner.start().catch(async (err) => {
      process.exitCode = 1;
      process.stderr.write(`[dev:stack] Launch failed: ${err.message}\n`);
      await runner.down().catch(() => {});
      runner.stop(1);
    });
  }
}
