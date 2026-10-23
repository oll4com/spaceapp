#!/usr/bin/env node
import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

const repositoryRoot = resolve(import.meta.dirname, "..");
const ownerLabel = "io.spaceapp.startup-smoke";
const socketProbe = `
  const { createConnection } = require('node:net');
  const socket = createConnection('/run/spaceapp-cli/host.sock');
  socket.setTimeout(5000);
  socket.once('connect', () => { console.log('cli-socket-connected'); socket.end(); });
  socket.once('timeout', () => { socket.destroy(); process.exitCode = 1; });
  socket.once('error', () => { process.exitCode = 1; });
`;
const readyProbe = `
  fetch('http://127.0.0.1:4911/readyz', { signal: AbortSignal.timeout(5000) })
    .then(async response => {
      if (!response.ok || (await response.json()).ok !== true) throw new Error('not ready');
      console.log('core-readyz-ok');
    }).catch(() => { process.exitCode = 1; });
`;
const workflowBundleProbe = `
  import assert from 'node:assert/strict';
  import { bundleWorkflowCode } from '@temporalio/worker';
  const workflowsPath = '/app/apps/worker/dist/workflows.js';
  const { code } = await bundleWorkflowCode({ workflowsPath });
  assert.ok(typeof code === 'string' && code.length > 0, 'production workflow bundle is empty');
  console.log(JSON.stringify({ workflowsPath, bundleBytes: Buffer.byteLength(code), serverUsed: false }));
`;
const xvfbDisplayProbe = `
  import assert from 'node:assert/strict';
  import { spawn } from 'node:child_process';
  import { lstat, mkdir, readFile, unlink } from 'node:fs/promises';
  import { setTimeout as delay } from 'node:timers/promises';
  // Keep the probe outside the managed browser's 100..107 display pool.
  const display = 199;
  const socketPath = '/tmp/.X11-unix/X' + display;
  const lockPath = '/tmp/.X' + display + '-lock';
  const missing = error => { if (error.code === 'ENOENT') return undefined; throw error; };
  assert.ok(!await lstat(socketPath).catch(missing) && !await lstat(lockPath).catch(missing), 'smoke display is already occupied');
  await mkdir('/tmp/.X11-unix', { recursive: true, mode: 0o1777 });
  const child = spawn('/usr/bin/Xvfb', [':' + display, '-screen', '0', '1280x720x24', '-nolisten', 'tcp', '-ac'],
    { stdio: ['ignore', 'ignore', 'pipe'] });
  let spawnError, stderr = '', ready = false;
  child.once('error', error => { spawnError = error; });
  child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-1000); });
  const closed = new Promise(resolve => child.once('close', resolve));
  const running = () => child.pid && child.exitCode === null && child.signalCode === null;
  try {
    const deadline = Date.now() + 120000;
    while (Date.now() < deadline) {
      if (spawnError) throw spawnError;
      if (!running()) throw new Error('Xvfb exited before its display was ready: ' + stderr);
      const socket = await lstat(socketPath).catch(missing);
      const lock = await readFile(lockPath, 'utf8').catch(missing);
      if (socket?.isSocket() && Number(lock?.trim()) === child.pid) { ready = true; break; }
      await delay(100);
    }
    assert.ok(ready, 'Xvfb did not create its owned socket and display lock');
  } finally {
    if (running()) {
      child.kill('SIGTERM');
      await Promise.race([closed, delay(5000, undefined, { ref: false })]);
    }
    if (running()) {
      child.kill('SIGKILL');
      await Promise.race([closed, delay(5000, undefined, { ref: false })]);
    }
    assert.ok(!running(), 'smoke Xvfb process did not stop');
    const remainingLock = await readFile(lockPath, 'utf8').catch(missing);
    if (Number(remainingLock?.trim()) === child.pid) {
      await unlink(socketPath).catch(missing);
      await unlink(lockPath).catch(missing);
    }
  }
  console.log(JSON.stringify({ check: 'xvfb-display-ready-and-stopped', display, uid: process.getuid(), stopped: true }));
`;
const browserProbe = `
  import { BrowserHostClient } from '@space/browser-host';
  const client = new BrowserHostClient({
    socketPath: '/run/spaceapp-browser/browser-host.sock',
    connectTimeoutMs: 3000, healthTimeoutMs: 5000
  });
  try {
    const health = await client.health();
    if (!Number.isInteger(health.hostPid) || health.hostPid <= 0) throw new Error('invalid host health');
    console.log('browser-host-health-ok');
  } finally { await client.close(); }
`;

/** Reads the exact pgvector image pin used by the public Compose installation. */
export function postgresImageFromCompose(compose) {
  const block = compose.match(/^  postgres:\s*\n([\s\S]*?)(?=^  [\w-]+:|^networks:)/m)?.[1];
  const image = block?.match(/^    image:\s*(\S+)\s*$/m)?.[1];
  if (!/^pgvector\/pgvector:[^\s@]+@sha256:[a-f0-9]{64}$/.test(image ?? "")) {
    throw new Error("Public Compose must provide a digest-pinned pgvector PostgreSQL image.");
  }
  return image;
}

/** Applies source SQL in the same full-filename order and records its migration identities. */
export function browserSchemaSql(migrations) {
  return [
    "CREATE TABLE space_schema_migrations (id text PRIMARY KEY, filename text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now());",
    ...[...migrations].sort((a, b) => a.filename < b.filename ? -1 : a.filename > b.filename ? 1 : 0).map(({ filename, sql }) => {
      if (!/^\d{4}_[a-z0-9_]+\.sql$/.test(filename)) throw new Error("Invalid source migration filename.");
      return `BEGIN;\n${sql}\nINSERT INTO space_schema_migrations (id, filename) VALUES ('${filename.slice(0, -4)}', '${filename}');\nCOMMIT;`;
    })
  ].join("\n");
}

/** Replaces every generated secret before any diagnostic leaves the smoke runner. */
export function redactSmokeSecrets(text, secrets) {
  return secrets.filter(Boolean).sort((a, b) => b.length - a.length)
    .reduce((output, secret) => output.split(secret).join("[REDACTED]"), String(text));
}

/** Runs Docker without a shell or inherited command output; callers sanitize diagnostics. */
async function executeDocker(args, { timeout = 30_000, signal } = {}) {
  return new Promise((resolveOutput, reject) => {
    execFile("docker", args, { encoding: "utf8", timeout, signal, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(new Error(`docker ${args[0]} failed: ${stderr || error.message}`));
      else resolveOutput(dockerCommandOutput(args, stdout, stderr));
    });
  });
}

/** Keeps successful container stderr in logs while leaving inspect/probe output machine-readable. */
export function dockerCommandOutput(args, stdout, stderr) {
  return args[0] === "logs" ? [stdout, stderr].filter(Boolean).join("\n").trim() : stdout.trim();
}

/** Exercises the real image entrypoint and removes only resources bearing this invocation's label. */
export async function runContainerStartupSmoke({ target, image, arch, root = repositoryRoot, timeoutMs = 180_000, signal }, {
  docker = executeDocker, sleep = delay
} = {}) {
  if (!["core", "browser", "cli"].includes(target) || !["amd64", "arm64"].includes(arch)) {
    throw new Error("Smoke requires --target core|browser|cli and --arch amd64|arm64.");
  }
  if (typeof image !== "string" || !image || image.startsWith("-")) throw new Error("Smoke requires an image reference.");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 5000 || timeoutMs > 600_000) throw new Error("Invalid smoke timeout.");
  const platform = `linux/${arch}`;
  const prefix = `spaceapp-smoke-${randomUUID().replaceAll("-", "")}`;
  const network = `${prefix}-network`, database = `${prefix}-postgres`, service = `${prefix}-${target}`;
  const containers = [];
  const secrets = [randomBytes(24).toString("hex"), randomBytes(32).toString("hex"), randomBytes(24).toString("hex")];
  const databaseUrl = `postgresql://spaceapp:${secrets[0]}@postgres:5432/spaceapp`;
  secrets.push(databaseUrl);
  let directory, networkCreated = false, failure;
  const checks = [];
  const run = (args, options) => docker(args, { signal, ...options });
  const bind = (source, destination) => {
    if (source.includes(",")) throw new Error("Smoke temporary path cannot contain commas.");
    return ["--mount", `type=bind,src=${source},dst=${destination},readonly`];
  };
  const execNode = (code, esm = false, timeout = 15_000) => run([
    "exec", "--user", "10001:10001", "-e", "HOME=/var/lib/spaceapp-cli", service,
    "node", ...(esm ? ["--input-type=module"] : []), "-e", code
  ], { timeout });
  const waitFor = async (description, probe) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      signal?.throwIfAborted();
      try { await probe(); return; } catch {
        const running = await run(["inspect", "--format", "{{.State.Running}}", description === "PostgreSQL" ? database : service]);
        if (running !== "true") throw new Error(`${description} exited before becoming ready.`);
      }
      await sleep(1000, undefined, { signal });
    }
    throw new Error(`${description} did not become ready before the smoke deadline.`);
  };
  try {
    const actualArchitecture = await run(["image", "inspect", "--format", "{{.Architecture}}", image]);
    if (actualArchitecture !== arch) throw new Error(`Expected ${arch} image; Docker reported ${actualArchitecture}.`);
    directory = await mkdtemp(join(tmpdir(), "spaceapp-startup-smoke-"));
    // The enclosing temporary directory is private; individual bind-mounted files
    // must also be readable by PostgreSQL's unprivileged initialization process.
    for (const [name, value] of [["postgres-password", secrets[0]], ["session-secret", secrets[1]], ["setup-token", secrets[2]], ["database-url", databaseUrl]]) {
      await writeFile(join(directory, name), value, { mode: 0o444 });
    }
    networkCreated = true;
    await run(["network", "create", "--label", `${ownerLabel}=${prefix}`, network]);
    if (target !== "cli") {
      const compose = await readFile(join(root, "packages/run-spaceapp/templates/compose.yml"), "utf8");
      containers.push(database);
      await run([
        "run", "-d", "--name", database, "--label", `${ownerLabel}=${prefix}`, "--platform", platform,
        "--network", network, "--network-alias", "postgres",
        "-e", "POSTGRES_DB=spaceapp", "-e", "POSTGRES_USER=spaceapp",
        "-e", "POSTGRES_PASSWORD_FILE=/run/secrets/postgres-password",
        ...bind(join(directory, "postgres-password"), "/run/secrets/postgres-password"), postgresImageFromCompose(compose)
      ], { timeout: 120_000 });
      await waitFor("PostgreSQL", () => run(["exec", database, "pg_isready", "-h", "127.0.0.1", "-U", "spaceapp", "-d", "spaceapp"]));
      if (target === "browser") {
        const migrationDirectory = join(root, "packages/db/migrations");
        const filenames = (await readdir(migrationDirectory)).filter((name) => name.endsWith(".sql"));
        const migrations = await Promise.all(filenames.map(async (filename) => ({ filename, sql: await readFile(join(migrationDirectory, filename), "utf8") })));
        await writeFile(join(directory, "schema.sql"), browserSchemaSql(migrations), { mode: 0o444 });
        await run(["cp", join(directory, "schema.sql"), `${database}:/tmp/spaceapp-smoke-schema.sql`]);
        await run(["exec", database, "psql", "-U", "spaceapp", "-d", "spaceapp", "-v", "ON_ERROR_STOP=1", "-f", "/tmp/spaceapp-smoke-schema.sql"], { timeout: timeoutMs });
        checks.push("browser schema initialized from source SQL in PostgreSQL, not added to the browser image");
      }
    }
    const environment = [
      "SPACE_PUBLIC_DISTRIBUTION=true", "SPACE_TELEMETRY_ENABLED=false", "SPACE_DEV_LOGIN=false",
      "SPACE_RUNTIME_STORE=postgres", "SPACEAPP_WORKFLOWS_ENABLED=false", "SPACE_CLI_ENABLED=false",
      "SPACE_API_HOST=127.0.0.1", "SPACE_API_PORT=4910", "SPACE_WEB_HOST=0.0.0.0", "SPACE_WEB_PORT=4911",
      "SPACE_API_ORIGIN=http://127.0.0.1:4910",
      "SPACE_DATABASE_URL_FILE=" + (target === "core" ? "/run/spaceapp/database-url" : "/run/secrets/database-url"),
      "SPACE_DATABASE_URL_SOURCE_FILE=/run/secrets/database-url", "SPACE_SESSION_SECRET_FILE=/run/secrets/session-secret",
      "SPACE_SETUP_TOKEN_SOURCE_FILE=/run/secrets/setup-token", "SPACE_ARTIFACT_ROOT=/var/lib/spaceapp/artifacts",
      "SPACE_MEMORY_ROOT=/var/lib/spaceapp/memory", "SPACE_MEMORY_GRAPH_ROOT=/var/lib/spaceapp/memory-graph",
      "SPACE_GEMINI_MEMORY_INDEX_PATH=/var/lib/spaceapp/memory/gemini_history.md",
      "SPACE_GEMINI_MEMORY_MONTHLY_PATH=/var/lib/spaceapp/memory/gemini_history_monthly.md",
      "SPACE_GEMINI_MEMORY_LOCK_PATH=/var/lib/spaceapp/memory/.memory.lock", "SPACE_CLI_WORKSPACE_ROOT=/workspaces",
      "SPACE_AGENT_TOOLS_WRITER=disabled",
      "SPACE_BROWSER_SESSIONS_ENABLED=" + (target === "browser" ? "true" : "false"),
      "SPACE_BROWSER_HOST_SOCKET=/run/spaceapp-browser/browser-host.sock", "SPACE_CLI_HOST_SOCKET=/run/spaceapp-cli/host.sock"
    ];
    containers.push(service);
    await run([
      "run", "-d", "--name", service, "--label", `${ownerLabel}=${prefix}`, "--platform", platform,
      "--network", network, "--security-opt", "no-new-privileges:true",
      ...environment.flatMap((value) => ["-e", value]),
      ...["database-url", "session-secret", "setup-token"].flatMap((name) => bind(join(directory, name), `/run/secrets/${name}`)), image
    ], { timeout: 120_000 });
    if (target === "core") {
      await waitFor("core entrypoint and /readyz", () => execNode(readyProbe));
      const applied = await run(["exec", database, "psql", "-U", "spaceapp", "-d", "spaceapp", "-Atc", "SELECT count(*) FROM space_schema_migrations"]);
      const expected = (await readdir(join(root, "packages/db/migrations"))).filter((name) => name.endsWith(".sql")).length;
      if (Number(applied) !== expected || expected === 0) throw new Error("Core entrypoint did not apply every source migration.");
      // Exercise the packaged SDK's workflow resolution while no Temporal
      // server is configured. QEMU arm64 needs a separate bounded build budget.
      await execNode(workflowBundleProbe, true, 180_000);
      checks.push("real core entrypoint applied migrations", "/readyz returned ok:true",
        "production Temporal workflow bundle built without a server", "Temporal explicitly disabled for this startup smoke only");
    } else if (target === "cli") {
      await waitFor("CLI host socket", () => execNode(socketProbe));
      checks.push("real CLI entrypoint accepted a Unix socket connection as uid10001");
    } else {
      await waitFor("Browser Host health", () => execNode(browserProbe, true));
      // The managed browser uses a headed display by default. A headless-only
      // Chromium probe cannot detect a missing Xvfb runtime dependency.
      await execNode(xvfbDisplayProbe, true, 180_000);
      const dom = await run([
        "exec", "--user", "10001:10001", "-e", "HOME=/var/lib/spaceapp-cli", service,
        "/usr/bin/chromium", "--headless", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage",
        "--disable-background-networking", "--no-first-run", "--user-data-dir=/tmp/spaceapp-smoke-chromium",
        "--dump-dom", "data:text/html,<title>spaceapp-startup-smoke</title>"
      ], { timeout: 120_000 });
      if (!dom.includes("<title>spaceapp-startup-smoke</title>")) throw new Error("Chromium did not render the synthetic smoke page.");
      checks.push("real Browser Host entrypoint answered health", "Xvfb created its owned display and stopped as uid10001",
        "headless Chromium rendered a synthetic page as uid10001");
    }
  } catch (error) {
    for (const name of containers) {
      try {
        const owner = await docker(["inspect", "--format", `{{index .Config.Labels "${ownerLabel}"}}`, name]);
        if (owner !== prefix) continue;
        const logs = await docker(["logs", "--tail", "60", name]);
        process.stderr.write(redactSmokeSecrets(`${name}:\n${logs}\n`, secrets));
      } catch { /* A failed create may not have produced a container. */ }
    }
    failure = new Error(redactSmokeSecrets(error instanceof Error ? error.message : error, secrets));
  } finally {
    const cleanupFailures = [];
    for (const name of containers.reverse()) {
      try {
        const owner = await docker(["inspect", "--format", `{{index .Config.Labels "${ownerLabel}"}}`, name]);
        if (owner !== prefix) throw new Error(`Refusing to remove container without matching smoke ownership: ${name}`);
        await docker(["rm", "-f", "-v", name]);
      } catch (error) {
        if (!/No such (object|container)/i.test(String(error))) cleanupFailures.push(error);
      }
    }
    if (networkCreated) {
      try {
        const owner = await docker(["network", "inspect", "--format", `{{index .Labels "${ownerLabel}"}}`, network]);
        if (owner !== prefix) throw new Error("Refusing to remove a network without matching smoke ownership.");
        await docker(["network", "rm", network]);
      } catch (error) {
        if (!/No such (object|network)/i.test(String(error))) cleanupFailures.push(error);
      }
    }
    if (directory) await rm(directory, { recursive: true, force: true }).catch((error) => cleanupFailures.push(error));
    if (cleanupFailures.length) failure = new Error(redactSmokeSecrets([
      failure?.message, "Smoke cleanup failed:", ...cleanupFailures.map((error) => String(error))
    ].filter(Boolean).join("\n"), secrets));
  }
  if (failure) throw failure;
  return { target, image, platform, passed: true, cleaned: true, checks, fullStackLargeProfileTest: false };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const value = (name) => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; };
  const controller = new AbortController();
  const interrupt = () => controller.abort(new Error("Container startup smoke interrupted."));
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  try {
    const result = await runContainerStartupSmoke({ target: value("--target"), image: value("--image"), arch: value("--arch"), signal: controller.signal });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  } finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
  }
}
