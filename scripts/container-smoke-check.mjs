import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile, chmod, readdir, readFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");

function parseArgs(args = process.argv.slice(2)) {
  let target = null;
  let image = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--target") target = args[++i];
    else if (args[i] === "--image") image = args[++i];
  }
  if (!target || !image) {
    throw new Error("Usage: container-smoke-check.mjs --target <core|browser|cli> --image <image-tag>");
  }
  return { target, image };
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForSocket(socketPath, timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      await new Promise((resolve, reject) => {
        const client = createConnection(socketPath);
        client.once("connect", () => {
          client.end();
          resolve();
        });
        client.once("error", reject);
      });
      return;
    } catch {
      await sleep(500);
    }
  }
  throw new Error(`Timed out waiting for socket at ${socketPath} after ${timeoutMs}ms`);
}

async function smokeCore(image) {
  const runId = Math.random().toString(36).slice(2, 8);
  const network = `spaceapp-smoke-net-${runId}`;
  const pgName = `spaceapp-smoke-pg-${runId}`;
  const coreName = `spaceapp-smoke-core-${runId}`;
  const tempDir = await mkdtemp(join(tmpdir(), "spaceapp-core-smoke-"));

  try {
    process.stdout.write(`[core-smoke] Creating network ${network}...\n`);
    execFileSync("docker", ["network", "create", network], { stdio: "inherit" });

    process.stdout.write(`[core-smoke] Starting pgvector database...\n`);
    execFileSync("docker", [
      "run", "-d",
      "--name", pgName,
      "--network", network,
      "--network-alias", "pg",
      "-e", "POSTGRES_PASSWORD=postgres",
      "-e", "POSTGRES_DB=spaceapp",
      "pgvector/pgvector:0.8.3-pg17-trixie"
    ], { stdio: "inherit" });

    // Wait for postgres readiness
    process.stdout.write(`[core-smoke] Waiting for pgvector readiness...\n`);
    const pgDeadline = Date.now() + 30000;
    let pgReady = false;
    while (Date.now() < pgDeadline) {
      try {
        execFileSync("docker", ["exec", pgName, "pg_isready", "-U", "postgres"], { stdio: "ignore" });
        pgReady = true;
        break;
      } catch {
        await sleep(500);
      }
    }
    if (!pgReady) throw new Error("pgvector database failed to become ready within 30s");

    // Write secrets
    await writeFile(join(tempDir, "database-url"), "postgresql://postgres:postgres@pg:5432/spaceapp");
    await writeFile(join(tempDir, "session-secret"), "0123456789abcdef0123456789abcdef");
    await writeFile(join(tempDir, "setup-token"), "0123456789abcdef");
    await chmod(join(tempDir, "database-url"), 0o600);
    await chmod(join(tempDir, "session-secret"), 0o600);
    await chmod(join(tempDir, "setup-token"), 0o600);

    process.stdout.write(`[core-smoke] Starting core container ${coreName} with image ${image}...\n`);
    execFileSync("docker", [
      "run", "-d",
      "--name", coreName,
      "--network", network,
      "-p", "127.0.0.1::4911",
      "-e", "SPACE_PUBLIC_DISTRIBUTION=true",
      "-e", "SPACEAPP_WORKFLOWS_ENABLED=false",
      "-e", "SPACE_RUNTIME_STORE=postgres",
      "-v", `${join(tempDir, "database-url")}:/run/secrets/database-url:ro`,
      "-v", `${join(tempDir, "session-secret")}:/run/secrets/session-secret:ro`,
      "-v", `${join(tempDir, "setup-token")}:/run/secrets/setup-token:ro`,
      image
    ], { stdio: "inherit" });

    // Inspect mapped port
    const portOutput = execFileSync("docker", ["port", coreName, "4911"], { encoding: "utf8" }).trim();
    const match = portOutput.match(/:(\d+)$/);
    if (!match) throw new Error(`Could not determine host port from: ${portOutput}`);
    const hostPort = match[1];

    process.stdout.write(`[core-smoke] Checking /readyz on http://127.0.0.1:${hostPort}...\n`);
    const readyDeadline = Date.now() + 45000;
    let ready = false;
    while (Date.now() < readyDeadline) {
      try {
        const res = await fetch(`http://127.0.0.1:${hostPort}/readyz`);
        if (res.ok) {
          const body = await res.json();
          if (body?.ok === true) {
            ready = true;
            break;
          }
        }
      } catch {
        // Retry
      }
      await sleep(1000);
    }

    if (!ready) {
      const logs = execFileSync("docker", ["logs", "--tail", "100", coreName], { encoding: "utf8" });
      process.stderr.write(`[core-smoke] Container logs on failure:\n${logs}\n`);
      throw new Error("Core container failed to respond to /readyz with ok: true");
    }

    process.stdout.write("[core-smoke] Core smoke check passed: migrations ran and /readyz answered ok: true.\n");
  } finally {
    try { execFileSync("docker", ["rm", "-f", coreName], { stdio: "ignore" }); } catch {}
    try { execFileSync("docker", ["rm", "-f", pgName], { stdio: "ignore" }); } catch {}
    try { execFileSync("docker", ["network", "rm", network], { stdio: "ignore" }); } catch {}
    try { await rm(tempDir, { recursive: true, force: true }); } catch {}
  }
}

async function smokeCli(image) {
  const runId = Math.random().toString(36).slice(2, 8);
  const cliName = `spaceapp-smoke-cli-${runId}`;
  const tempDir = await mkdtemp(join(tmpdir(), "spaceapp-cli-smoke-"));
  await chmod(tempDir, 0o777);

  try {
    process.stdout.write(`[cli-smoke] Starting cli container ${cliName} with image ${image}...\n`);
    execFileSync("docker", [
      "run", "-d",
      "--name", cliName,
      "-v", `${tempDir}:/run/spaceapp-cli`,
      image
    ], { stdio: "inherit" });

    process.stdout.write("[cli-smoke] Waiting for CLI host socket to accept connections...\n");
    const socketPath = join(tempDir, "host.sock");
    await waitForSocket(socketPath, 30000);

    process.stdout.write("[cli-smoke] CLI host smoke check passed: accepted connection on socket.\n");
  } finally {
    try { execFileSync("docker", ["rm", "-f", cliName], { stdio: "ignore" }); } catch {}
    try { await rm(tempDir, { recursive: true, force: true }); } catch {}
  }
}

async function smokeBrowser(image) {
  const runId = Math.random().toString(36).slice(2, 8);
  const network = `spaceapp-smoke-net-${runId}`;
  const pgName = `spaceapp-smoke-pg-${runId}`;
  const browserName = `spaceapp-smoke-browser-${runId}`;
  const tempDir = await mkdtemp(join(tmpdir(), "spaceapp-browser-smoke-"));
  await chmod(tempDir, 0o777);

  try {
    process.stdout.write(`[browser-smoke] Creating network ${network}...\n`);
    execFileSync("docker", ["network", "create", network], { stdio: "inherit" });

    process.stdout.write(`[browser-smoke] Starting pgvector database...\n`);
    execFileSync("docker", [
      "run", "-d",
      "--name", pgName,
      "--network", network,
      "--network-alias", "pg",
      "-e", "POSTGRES_PASSWORD=postgres",
      "-e", "POSTGRES_DB=spaceapp",
      "pgvector/pgvector:0.8.3-pg17-trixie"
    ], { stdio: "inherit" });

    // Wait for pgvector
    const pgDeadline = Date.now() + 30000;
    let pgReady = false;
    while (Date.now() < pgDeadline) {
      try {
        execFileSync("docker", ["exec", pgName, "pg_isready", "-U", "postgres"], { stdio: "ignore" });
        pgReady = true;
        break;
      } catch {
        await sleep(500);
      }
    }
    if (!pgReady) throw new Error("pgvector database failed to become ready within 30s");

    process.stdout.write("[browser-smoke] Applying database migrations to pgvector...\n");
    const migrationsDir = join(repoRoot, "packages", "db", "migrations");
    if (existsSync(migrationsDir)) {
      const sqlFiles = (await readdir(migrationsDir))
        .filter((f) => f.endsWith(".sql"))
        .sort();
      for (const sqlFile of sqlFiles) {
        const sqlContent = await readFile(join(migrationsDir, sqlFile));
        execFileSync("docker", ["exec", "-i", pgName, "psql", "-U", "postgres", "-d", "spaceapp"], {
          input: sqlContent,
          stdio: ["pipe", "ignore", "ignore"]
        });
      }
    }

    await writeFile(join(tempDir, "database-url"), "postgresql://postgres:postgres@pg:5432/spaceapp");
    await chmod(join(tempDir, "database-url"), 0o644);

    process.stdout.write(`[browser-smoke] Starting browser container ${browserName} with image ${image}...\n`);
    execFileSync("docker", [
      "run", "-d",
      "--name", browserName,
      "--network", network,
      "-e", "SPACE_RUNTIME_STORE=postgres",
      "-v", `${join(tempDir, "database-url")}:/run/secrets/database-url:ro`,
      "-v", `${tempDir}:/run/spaceapp-browser`,
      image
    ], { stdio: "inherit" });

    process.stdout.write("[browser-smoke] Waiting for Browser Host socket to accept connections...\n");
    const socketPath = join(tempDir, "browser-host.sock");
    await waitForSocket(socketPath, 30000);

    process.stdout.write("[browser-smoke] Launching headless Chromium inside container...\n");
    execFileSync("docker", [
      "exec",
      browserName,
      "/usr/bin/chromium",
      "--headless",
      "--no-sandbox",
      "--disable-gpu",
      "--dump-dom",
      "about:blank"
    ], { stdio: "inherit" });

    process.stdout.write("[browser-smoke] Browser smoke check passed: Browser Host started and Chromium launched successfully.\n");
  } finally {
    try { execFileSync("docker", ["rm", "-f", browserName], { stdio: "ignore" }); } catch {}
    try { execFileSync("docker", ["rm", "-f", pgName], { stdio: "ignore" }); } catch {}
    try { execFileSync("docker", ["network", "rm", network], { stdio: "ignore" }); } catch {}
    try { await rm(tempDir, { recursive: true, force: true }); } catch {}
  }
}

async function run() {
  const { target, image } = parseArgs();
  if (target === "core") {
    await smokeCore(image);
  } else if (target === "cli") {
    await smokeCli(image);
  } else if (target === "browser") {
    await smokeBrowser(image);
  } else {
    throw new Error(`Unknown target: ${target}`);
  }
}

run().catch((error) => {
  process.stderr.write(`Smoke check failed: ${error.stack || error.message}\n`);
  process.exit(1);
});
