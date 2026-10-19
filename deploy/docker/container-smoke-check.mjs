#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";

function parseArgs(args = process.argv.slice(2)) {
  let target = null;
  let image = null;
  let arch = process.arch === "arm64" ? "arm64" : "amd64";

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--target" && args[i + 1]) {
      target = args[++i];
    } else if (args[i] === "--image" && args[i + 1]) {
      image = args[++i];
    } else if (args[i] === "--arch" && args[i + 1]) {
      arch = args[++i].replace(/^linux\//, "");
    }
  }

  if (!target || !image) {
    throw new Error("Usage: container-smoke-check.mjs --target <core|browser|cli> --image <image-tag> [--arch <amd64|arm64>]");
  }

  return { target, image, arch };
}

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options
  }).trim();
}

function tryRun(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options
  });
  return { status: result.status, stdout: result.stdout?.trim() ?? "", stderr: result.stderr?.trim() ?? "" };
}

const PG_IMAGE = "pgvector/pgvector:0.8.3-pg17-trixie@sha256:3a3147ccd9a0aee952bb69e1acea1eb3cc7183544185b87a662f872cfa47ae3b";

async function smokeCore(image, arch) {
  const id = Math.random().toString(36).slice(2, 8);
  const netName = `smoke-core-net-${id}`;
  const pgName = `smoke-core-pg-${id}`;
  const coreName = `smoke-core-app-${id}`;
  const secretsDir = mkdtempSync(join(tmpdir(), `spaceapp-smoke-core-${id}-`));

  process.stdout.write(`Starting core smoke check for ${image} on linux/${arch}...\n`);

  try {
    run("docker", ["network", "create", netName]);

    run("docker", [
      "run",
      "-d",
      "--name",
      pgName,
      "--network",
      netName,
      "-e",
      "POSTGRES_DB=spaceapp",
      "-e",
      "POSTGRES_USER=spaceapp",
      "-e",
      "POSTGRES_PASSWORD=smokepassword",
      PG_IMAGE
    ]);

    // Wait for postgres
    let pgReady = false;
    for (let i = 0; i < 30; i++) {
      const check = tryRun("docker", ["exec", pgName, "pg_isready", "-U", "spaceapp", "-d", "spaceapp"]);
      if (check.status === 0) {
        pgReady = true;
        break;
      }
      await delay(1000);
    }
    if (!pgReady) throw new Error("Timed out waiting for pgvector to become ready.");

    const dbUrl = `postgres://spaceapp:smokepassword@${pgName}:5432/spaceapp`;
    writeFileSync(join(secretsDir, "database-url"), `${dbUrl}\n`, "utf8");
    writeFileSync(join(secretsDir, "session-secret"), "smoke-session-secret-random-32-bytes-minimum\n", "utf8");
    writeFileSync(join(secretsDir, "setup-token"), "smoke-setup-token\n", "utf8");

    // Start core container
    run("docker", [
      "run",
      "-d",
      "--name",
      coreName,
      "--network",
      netName,
      "-v",
      `${join(secretsDir, "database-url")}:/run/secrets/database-url:ro`,
      "-v",
      `${join(secretsDir, "session-secret")}:/run/secrets/session-secret:ro`,
      "-v",
      `${join(secretsDir, "setup-token")}:/run/secrets/setup-token:ro`,
      "-e",
      "SPACEAPP_WORKFLOWS_ENABLED=false",
      image
    ]);

    // Poll /readyz
    let ready = false;
    for (let i = 0; i < 45; i++) {
      const probe = tryRun("docker", [
        "exec",
        coreName,
        "node",
        "-e",
        "fetch('http://127.0.0.1:4911/readyz').then(async r=>{const body=await r.json();if(r.ok&&body.ok===true)process.exit(0);else process.exit(1)}).catch(()=>process.exit(1))"
      ]);
      if (probe.status === 0) {
        ready = true;
        break;
      }
      await delay(1000);
    }

    if (!ready) {
      const logs = tryRun("docker", ["logs", coreName]);
      throw new Error(`Core container failed to respond ok: true on /readyz within timeout.\nLogs:\n${logs.stdout}\n${logs.stderr}`);
    }

    process.stdout.write("Core smoke check passed: migrations ran against pgvector, /readyz answered ok: true.\n");
  } finally {
    tryRun("docker", ["rm", "-f", coreName]);
    tryRun("docker", ["rm", "-f", pgName]);
    tryRun("docker", ["network", "rm", netName]);
    try {
      rmSync(secretsDir, { recursive: true, force: true });
    } catch {}
  }
}

async function smokeCli(image, arch) {
  const id = Math.random().toString(36).slice(2, 8);
  const cliName = `smoke-cli-app-${id}`;

  process.stdout.write(`Starting CLI smoke check for ${image} on linux/${arch}...\n`);

  try {
    run("docker", [
      "run",
      "-d",
      "--name",
      cliName,
      "-e",
      "SPACEAPP_CLI_HOST_ROOT_ACCESS=false",
      image
    ]);

    let socketReady = false;
    for (let i = 0; i < 30; i++) {
      const probe = tryRun("docker", [
        "exec",
        cliName,
        "node",
        "-e",
        "const net = require('net'); const s = net.createConnection('/run/spaceapp-cli/host.sock', () => { s.end(); process.exit(0); }); s.on('error', () => process.exit(1));"
      ]);
      if (probe.status === 0) {
        socketReady = true;
        break;
      }
      await delay(1000);
    }

    if (!socketReady) {
      const logs = tryRun("docker", ["logs", cliName]);
      throw new Error(`CLI container failed to accept connection on /run/spaceapp-cli/host.sock within timeout.\nLogs:\n${logs.stdout}\n${logs.stderr}`);
    }

    // Verify node-pty native binding can be loaded in cli-host environment
    run("docker", [
      "exec",
      "-w",
      "/app/packages/cli-host",
      cliName,
      "node",
      "-e",
      "const { createRequire } = require('module'); const r = createRequire(process.cwd() + '/package.json'); r('node-pty');"
    ]);

    process.stdout.write("CLI smoke check passed: CLI host started, accepted socket connection, and verified node-pty.\n");
  } finally {
    tryRun("docker", ["rm", "-f", cliName]);
  }
}

async function smokeBrowser(image, arch) {
  const id = Math.random().toString(36).slice(2, 8);
  const netName = `smoke-browser-net-${id}`;
  const pgName = `smoke-browser-pg-${id}`;
  const browserName = `smoke-browser-app-${id}`;
  const secretsDir = mkdtempSync(join(tmpdir(), `spaceapp-smoke-browser-${id}-`));

  process.stdout.write(`Starting browser smoke check for ${image} on linux/${arch}...\n`);

  try {
    // 1. Launch headless Chromium once
    process.stdout.write("Testing headless Chromium launch...\n");
    const chromiumLaunch = run("docker", [
      "run",
      "--rm",
      "--entrypoint",
      "/usr/bin/chromium",
      image,
      "--headless",
      "--no-sandbox",
      "--disable-gpu",
      "--dump-dom",
      "about:blank"
    ]);

    if (!chromiumLaunch.includes("<html>")) {
      throw new Error(`Chromium launch failed to dump expected DOM: ${chromiumLaunch}`);
    }
    process.stdout.write("Headless Chromium launch verified.\n");

    // 2. Start Browser Host against pgvector
    process.stdout.write("Testing Browser Host startup...\n");
    run("docker", ["network", "create", netName]);

    run("docker", [
      "run",
      "-d",
      "--name",
      pgName,
      "--network",
      netName,
      "-e",
      "POSTGRES_DB=spaceapp",
      "-e",
      "POSTGRES_USER=spaceapp",
      "-e",
      "POSTGRES_PASSWORD=smokepassword",
      PG_IMAGE
    ]);

    let pgReady = false;
    for (let i = 0; i < 30; i++) {
      const check = tryRun("docker", ["exec", pgName, "pg_isready", "-U", "spaceapp", "-d", "spaceapp"]);
      if (check.status === 0) {
        pgReady = true;
        break;
      }
      await delay(1000);
    }
    if (!pgReady) throw new Error("Timed out waiting for pgvector to become ready.");

    const dbUrl = `postgres://spaceapp:smokepassword@${pgName}:5432/spaceapp`;
    writeFileSync(join(secretsDir, "database-url"), `${dbUrl}\n`, "utf8");

    // Run migrations using browser's db module
    run("docker", [
      "run",
      "--rm",
      "--network",
      netName,
      "--entrypoint",
      "node",
      "-e",
      `SPACE_DATABASE_URL=${dbUrl}`,
      image,
      "packages/db/dist/migrate.js"
    ], { timeout: 300000 });

    // Start browser container
    run("docker", [
      "run",
      "-d",
      "--name",
      browserName,
      "--network",
      netName,
      "-v",
      `${join(secretsDir, "database-url")}:/run/secrets/database-url:ro`,
      image
    ]);

    let socketReady = false;
    for (let i = 0; i < 30; i++) {
      const probe = tryRun("docker", [
        "exec",
        browserName,
        "node",
        "-e",
        "const net = require('net'); const s = net.createConnection('/run/spaceapp-browser/browser-host.sock', () => { s.end(); process.exit(0); }); s.on('error', () => process.exit(1));"
      ]);
      if (probe.status === 0) {
        socketReady = true;
        break;
      }
      await delay(1000);
    }

    if (!socketReady) {
      const logs = tryRun("docker", ["logs", browserName]);
      throw new Error(`Browser Host failed to listen on /run/spaceapp-browser/browser-host.sock within timeout.\nLogs:\n${logs.stdout}\n${logs.stderr}`);
    }

    process.stdout.write("Browser smoke check passed: headless Chromium launched and Browser Host socket ready.\n");
  } finally {
    tryRun("docker", ["rm", "-f", browserName]);
    tryRun("docker", ["rm", "-f", pgName]);
    tryRun("docker", ["network", "rm", netName]);
    try {
      rmSync(secretsDir, { recursive: true, force: true });
    } catch {}
  }
}

async function main() {
  const { target, image, arch } = parseArgs();
  if (target === "core") {
    await smokeCore(image, arch);
  } else if (target === "cli") {
    await smokeCli(image, arch);
  } else if (target === "browser") {
    await smokeBrowser(image, arch);
  } else {
    throw new Error(`Unknown target for smoke check: ${target}`);
  }
}

main().catch((err) => {
  process.stderr.write(`Smoke check error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
