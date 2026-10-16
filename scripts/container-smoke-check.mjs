#!/usr/bin/env node
/**
 * container-smoke-check.mjs — start one built image the way production
 * does and prove it answers, per target:
 *
 *   core    starts against a pgvector PostgreSQL service, runs its
 *           migrations, and answers GET /readyz with { ok: true }.
 *   cli     starts the CLI host, which accepts a connection on its Unix
 *           socket and answers a ping; OpenCode is present (--version).
 *   browser starts the Browser Host, answers a health request, and
 *           launches headless Chromium once by opening a page.
 *
 * The checks run the images' real entrypoints with the production
 * environment shape (mirroring packages/run-spaceapp/templates/compose.yml)
 * and drive the services through the repository's own client libraries
 * inside the container, so a broken dependency closure fails here instead
 * of on a user's machine.
 *
 * Usage: node scripts/container-smoke-check.mjs --target <core|browser|cli>
 *          --image <image-ref> [--timeout-seconds 240]
 * Requires a working `docker` CLI. Exits non-zero on any failure and
 * always removes the containers and network it created.
 */
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const args = process.argv.slice(2);
function argValue(name, fallback) {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}
const TARGET = argValue("--target", "");
const IMAGE = argValue("--image", "");
const TIMEOUT_MS = Number(argValue("--timeout-seconds", "240")) * 1000;
if (!["core", "browser", "cli"].includes(TARGET) || !IMAGE) {
  console.error(
    "usage: container-smoke-check.mjs --target <core|browser|cli> --image <image-ref>"
  );
  process.exit(2);
}

const PGVECTOR_IMAGE =
  "pgvector/pgvector:0.8.3-pg17-trixie@sha256:3a3147ccd9a0aee952bb69e1acea1eb3cc7183544185b87a662f872cfa47ae3b";
const suffix = `${process.pid}-${Math.floor(Math.random() * 1e6)}`;
const NETWORK = `spaceapp-smoke-${suffix}`;
const PG = `spaceapp-smoke-pg-${suffix}`;
const APP = `spaceapp-smoke-${TARGET}-${suffix}`;
const PG_PASSWORD = randomBytes(18).toString("hex");
const DATABASE_URL = `postgres://spaceapp:${PG_PASSWORD}@${PG}:5432/spaceapp`;

const containers = [];
let networkCreated = false;
let secretsDir = null;

async function docker(argv, { timeout = 60_000, quiet = false } = {}) {
  try {
    const { stdout, stderr } = await execFileAsync("docker", argv, {
      timeout,
      maxBuffer: 16 * 1024 * 1024
    });
    return { ok: true, stdout, stderr };
  } catch (error) {
    if (!quiet) {
      process.stderr.write(
        `docker ${argv.join(" ")} failed: ${error.stderr || error.message}\n`
      );
    }
    return { ok: false, stdout: error.stdout || "", stderr: error.stderr || "" };
  }
}

async function waitFor(description, probe, timeoutMs = TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const result = await probe();
      if (result) return result;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error(
    `timed out waiting for ${description}${lastError ? `: ${lastError.message}` : ""}`
  );
}

async function appLogs() {
  const { stdout, stderr } = await docker(["logs", APP], { quiet: true });
  return `${stdout}\n${stderr}`.trim().split("\n").slice(-40).join("\n");
}

async function startPostgres() {
  const run = await docker([
    "run", "-d", "--name", PG, "--network", NETWORK,
    "-e", "POSTGRES_DB=spaceapp",
    "-e", "POSTGRES_USER=spaceapp",
    "-e", `POSTGRES_PASSWORD=${PG_PASSWORD}`,
    PGVECTOR_IMAGE
  ]);
  if (!run.ok) throw new Error("postgres container failed to start");
  containers.push(PG);
  await waitFor("postgres readiness", async () => {
    const probe = await docker(
      ["exec", PG, "pg_isready", "-U", "spaceapp", "-d", "spaceapp"],
      { quiet: true }
    );
    return probe.ok;
  }, 120_000);
  console.log("smoke: postgres is ready");
}

async function writeSecrets() {
  secretsDir = await mkdtemp(join(tmpdir(), "spaceapp-smoke-secrets-"));
  await writeFile(join(secretsDir, "database-url"), DATABASE_URL, { mode: 0o644 });
  await writeFile(join(secretsDir, "session-secret"), randomBytes(32).toString("hex"), { mode: 0o644 });
  await writeFile(join(secretsDir, "setup-token"), randomBytes(32).toString("hex"), { mode: 0o644 });
}

function secretMount() {
  return ["-v", `${secretsDir}:/run/secrets:ro`];
}

async function execNode(container, source) {
  const result = await docker(
    ["exec", container, "node", "--input-type=module", "-e", source],
    { timeout: 120_000 }
  );
  if (!result.ok) {
    throw new Error(`in-container check failed:\n${result.stdout}\n${result.stderr}`);
  }
  return result.stdout.trim();
}

async function checkCore() {
  const run = await docker([
    "run", "-d", "--name", APP, "--network", NETWORK,
    "-p", "127.0.0.1:0:4911",
    ...secretMount(),
    "-e", "SPACE_PUBLIC_DISTRIBUTION=true",
    "-e", "SPACE_AGENT_TOOLS_WRITER=disabled",
    "-e", "SPACE_RUNTIME_STORE=postgres",
    "-e", "SPACE_DATABASE_URL_SOURCE_FILE=/run/secrets/database-url",
    "-e", "SPACE_DATABASE_URL_FILE=/run/spaceapp/database-url",
    "-e", "SPACE_SESSION_SECRET_FILE=/run/secrets/session-secret",
    "-e", "SPACE_SETUP_TOKEN_SOURCE_FILE=/run/secrets/setup-token",
    "-e", "SPACE_API_HOST=127.0.0.1",
    "-e", "SPACE_API_PORT=4910",
    "-e", "SPACE_WEB_HOST=0.0.0.0",
    "-e", "SPACE_WEB_PORT=4911",
    "-e", "SPACE_API_ORIGIN=http://127.0.0.1:4910",
    "-e", "SPACE_MEMORY_ROOT=/var/lib/spaceapp/memory",
    "-e", "SPACE_STARTER_MEMORY_ROOT=/opt/spaceapp/starter-memory",
    "-e", "SPACE_ARTIFACT_ROOT=/var/lib/spaceapp/artifacts",
    "-e", "SPACE_CLI_HOST_SOCKET=/run/spaceapp-cli/host.sock",
    "-e", "SPACE_CLI_ENABLED=true",
    "-e", "SPACE_BROWSER_SESSIONS_ENABLED=false",
    "-e", "SPACEAPP_WORKFLOWS_ENABLED=false",
    "-e", "SPACE_TELEMETRY_ENABLED=false",
    IMAGE
  ]);
  if (!run.ok) throw new Error("core container failed to start");
  containers.push(APP);

  const portResult = await docker(["port", APP, "4911/tcp"]);
  const hostPort = portResult.stdout.trim().split(":").pop();
  if (!hostPort) throw new Error("could not discover the published core port");

  const body = await waitFor("/readyz ok:true (migrations + startup)", async () => {
    const response = await fetch(`http://127.0.0.1:${hostPort}/readyz`);
    if (!response.ok) return null;
    const parsed = await response.json().catch(() => null);
    return parsed && parsed.ok === true ? parsed : null;
  });
  console.log(`smoke: core /readyz answered ${JSON.stringify(body)}`);
  console.log("smoke: core PASS");
}

async function checkCli() {
  const run = await docker([
    "run", "-d", "--name", APP, "--network", NETWORK,
    "-e", "SPACE_PUBLIC_DISTRIBUTION=true",
    "-e", "SPACE_MEMORY_ROOT=/var/lib/spaceapp/memory",
    "-e", "SPACE_CLI_HOST_SOCKET=/run/spaceapp-cli/host.sock",
    IMAGE
  ]);
  if (!run.ok) throw new Error("cli container failed to start");
  containers.push(APP);

  await waitFor("CLI host socket", async () => {
    const probe = await docker(
      ["exec", APP, "test", "-S", "/run/spaceapp-cli/host.sock"],
      { quiet: true }
    );
    return probe.ok;
  }, 120_000);

  const ping = await execNode(
    APP,
    `import { CliHostClient } from "/app/packages/cli-host/dist/client.js";
     const client = new CliHostClient({ socketPath: "/run/spaceapp-cli/host.sock" });
     const reply = await client.ping();
     console.log(JSON.stringify(reply));
     await client.close();`
  );
  console.log(`smoke: CLI host ping answered ${ping}`);

  const version = await docker(["exec", APP, "opencode", "--version"], { timeout: 60_000 });
  if (!version.ok) throw new Error("opencode --version failed in the cli image");
  console.log(`smoke: opencode --version -> ${version.stdout.trim()}`);
  console.log("smoke: cli PASS");
}

async function checkBrowser() {
  const run = await docker([
    "run", "-d", "--name", APP, "--network", NETWORK,
    ...secretMount(),
    "-e", "SPACE_PUBLIC_DISTRIBUTION=true",
    "-e", "SPACE_RUNTIME_STORE=postgres",
    "-e", "SPACE_DATABASE_URL_FILE=/run/secrets/database-url",
    "-e", "SPACE_ARTIFACT_ROOT=/var/lib/spaceapp/artifacts",
    "-e", "SPACE_BROWSER_SESSIONS_ENABLED=true",
    "-e", "SPACE_BROWSER_HOST_SOCKET=/run/spaceapp-browser/browser-host.sock",
    "-e", "SPACE_BROWSER_SESSIONS_DEFAULT_URL=about:blank",
    IMAGE
  ]);
  if (!run.ok) throw new Error("browser container failed to start");
  containers.push(APP);

  await waitFor("Browser Host socket", async () => {
    const probe = await docker(
      ["exec", APP, "test", "-S", "/run/spaceapp-browser/browser-host.sock"],
      { quiet: true }
    );
    return probe.ok;
  }, 120_000);

  const result = await execNode(
    APP,
    `import { BrowserHostClient } from "/app/packages/browser-host/dist/client.js";
     const client = new BrowserHostClient({ socketPath: "/run/spaceapp-browser/browser-host.sock" });
     const health = await client.health();
     console.log("health " + JSON.stringify(health));
     const now = new Date().toISOString();
     const pane = {
       id: "smoke-pane-1", roomId: "smoke-room-1", title: "Container smoke check",
       mode: "BROWSER", status: "IDLE", providerId: null, modelId: null,
       cwd: null, order: 0, columnSpan: 1, isMaximized: false,
       isMinimized: false, isClosed: false,
       split: { parentId: null, direction: null, size: null },
       createdAt: now, updatedAt: now
     };
     const opened = await client.startOrRestore(
       { pane, targetUrl: "about:blank", traceId: "container-smoke" },
       undefined
     );
     console.log("opened " + JSON.stringify(opened).slice(0, 400));
     await client.stopPane("smoke-pane-1", "container-smoke", undefined);
     await client.close();`
  );
  console.log(`smoke: browser host session -> ${result.split("\n").join(" | ")}`);
  console.log("smoke: browser PASS (health + headless Chromium page opened)");
}

async function main() {
  console.log(`smoke: target=${TARGET} image=${IMAGE}`);
  const net = await docker(["network", "create", NETWORK]);
  if (!net.ok) throw new Error("could not create the smoke network");
  networkCreated = true;
  if (TARGET === "core" || TARGET === "browser") {
    await writeSecrets();
    await startPostgres();
  }
  if (TARGET === "core") await checkCore();
  if (TARGET === "cli") await checkCli();
  if (TARGET === "browser") await checkBrowser();
}

let failure = null;
try {
  await main();
} catch (error) {
  failure = error;
  console.error(`smoke: FAIL: ${error.message}`);
  if (containers.includes(APP)) {
    console.error(`smoke: last app log lines:\n${await appLogs()}`);
  }
} finally {
  for (const container of containers) {
    await docker(["rm", "-f", container], { quiet: true });
  }
  if (networkCreated) await docker(["network", "rm", NETWORK], { quiet: true });
  if (secretsDir) await rm(secretsDir, { recursive: true, force: true });
}
process.exit(failure ? 1 : 0);
