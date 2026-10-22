#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Runs a command synchronously and returns stdout.
 * @param {string} cmd
 * @param {string[]} args
 * @param {object} [options]
 * @returns {string}
 */
function run(cmd, args, options = {}) {
  return execFileSync(cmd, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options
  }).trim();
}

/**
 * Parses CLI options.
 * @param {string[]} [args=process.argv.slice(2)]
 * @returns {{ target: string, image: string }}
 */
export function parseSmokeArgs(args = process.argv.slice(2)) {
  let target = "";
  let image = "";

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--target" && args[i + 1]) {
      target = args[++i];
    } else if (args[i] === "--image" && args[i + 1]) {
      image = args[++i];
    }
  }

  if (!target || !image) {
    throw new Error("Usage: ci-container-smoke.mjs --target <core|browser|cli> --image <name:tag>");
  }

  return { target, image };
}

/**
 * Performs smoke verification on the core container image.
 * Starts against a temporary PostgreSQL pgvector container, verifies migrations,
 * and asserts that /readyz returns ok: true.
 * @param {string} image
 */
export async function smokeCore(image) {
  const netName = `spaceapp-smoke-net-${Date.now()}`;
  const pgContainer = `spaceapp-smoke-pg-${Date.now()}`;
  const coreContainer = `spaceapp-smoke-core-${Date.now()}`;
  const tempDir = mkdtempSync(join(tmpdir(), "spaceapp-core-smoke-"));

  try {
    process.stdout.write(`Creating smoke network ${netName}...\n`);
    run("docker", ["network", "create", netName]);

    process.stdout.write(`Starting pgvector service container ${pgContainer}...\n`);
    run("docker", [
      "run",
      "-d",
      "--name", pgContainer,
      "--network", netName,
      "-e", "POSTGRES_PASSWORD=smokepassword",
      "-e", "POSTGRES_USER=spaceapp",
      "-e", "POSTGRES_DB=spaceapp",
      "pgvector/pgvector:pg16"
    ]);

    // Await PostgreSQL readiness
    let pgReady = false;
    for (let i = 0; i < 30; i++) {
      const check = spawnSync("docker", [
        "exec",
        pgContainer,
        "pg_isready",
        "-U", "spaceapp",
        "-d", "spaceapp"
      ], { encoding: "utf8" });
      if (check.status === 0) {
        pgReady = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    if (!pgReady) {
      throw new Error("pgvector container failed to become ready within 30s");
    }

    // Prepare secrets
    const dbUrlPath = join(tempDir, "database-url");
    const sessionSecretPath = join(tempDir, "session-secret");
    const setupTokenPath = join(tempDir, "setup-token");

    writeFileSync(dbUrlPath, `postgres://spaceapp:smokepassword@${pgContainer}:5432/spaceapp\n`);
    writeFileSync(sessionSecretPath, "012345678901234567890123456789012\n");
    writeFileSync(setupTokenPath, "smoke-setup-token-12345\n");

    try {
      chmodSync(dbUrlPath, 0o600);
      chmodSync(sessionSecretPath, 0o600);
      chmodSync(setupTokenPath, 0o600);
    } catch {}

    process.stdout.write(`Starting core service container ${coreContainer}...\n`);
    run("docker", [
      "run",
      "-d",
      "--name", coreContainer,
      "--network", netName,
      "-p", "127.0.0.1:4921:4911",
      "-e", "SPACEAPP_WORKFLOWS_ENABLED=false",
      "-e", "SPACE_DATABASE_URL_SOURCE_FILE=/run/secrets/database-url",
      "-e", "SPACE_SESSION_SECRET_FILE=/run/secrets/session-secret",
      "-e", "SPACE_SETUP_TOKEN_SOURCE_FILE=/run/secrets/setup-token",
      "-v", `${dbUrlPath}:/run/secrets/database-url:ro`,
      "-v", `${sessionSecretPath}:/run/secrets/session-secret:ro`,
      "-v", `${setupTokenPath}:/run/secrets/setup-token:ro`,
      image
    ]);

    // Poll /readyz on port 4921
    let coreReady = false;
    for (let i = 0; i < 45; i++) {
      try {
        const res = await fetch("http://127.0.0.1:4921/readyz");
        if (res.ok) {
          const body = await res.json();
          if (body.ok === true) {
            coreReady = true;
            break;
          }
        }
      } catch {
        // Retry
      }
      await new Promise((r) => setTimeout(r, 1000));
    }

    if (!coreReady) {
      const logs = run("docker", ["logs", "--tail", "100", coreContainer]);
      throw new Error(`Core container failed /readyz check. Container logs:\n${logs}`);
    }

    process.stdout.write("Core container smoke check passed: /readyz returned ok: true.\n");
  } finally {
    try { run("docker", ["rm", "-f", coreContainer]); } catch {}
    try { run("docker", ["rm", "-f", pgContainer]); } catch {}
    try { run("docker", ["network", "rm", netName]); } catch {}
    try { rmSync(tempDir, { recursive: true, force: true }); } catch {}
  }
}

/**
 * Performs smoke verification on the CLI container image.
 * Starts the CLI host and verifies that it accepts a connection on its socket.
 * @param {string} image
 */
export async function smokeCli(image) {
  const cliContainer = `spaceapp-smoke-cli-${Date.now()}`;
  try {
    process.stdout.write(`Starting CLI service container ${cliContainer}...\n`);
    run("docker", [
      "run",
      "-d",
      "--name", cliContainer,
      "-e", "SPACE_CLI_HOST_SOCKET=/run/spaceapp-cli/host.sock",
      image
    ]);

    // Wait for the CLI socket to be ready and connect to it
    let socketAccepted = false;
    for (let i = 0; i < 30; i++) {
      const check = spawnSync("docker", [
        "exec",
        cliContainer,
        "node",
        "-e",
        `
        const net = require("node:net");
        const socket = net.createConnection("/run/spaceapp-cli/host.sock", () => {
          socket.end();
          process.exit(0);
        });
        socket.on("error", () => process.exit(1));
        `
      ], { encoding: "utf8" });

      if (check.status === 0) {
        socketAccepted = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 1000));
    }

    if (!socketAccepted) {
      const logs = run("docker", ["logs", "--tail", "100", cliContainer]);
      throw new Error(`CLI container failed socket connection check. Container logs:\n${logs}`);
    }

    process.stdout.write("CLI container smoke check passed: accepted connection on host socket.\n");
  } finally {
    try { run("docker", ["rm", "-f", cliContainer]); } catch {}
  }
}

/**
 * Performs smoke verification on the browser container image.
 * Launches headless Chromium once and verifies Browser Host module integrity.
 * @param {string} image
 */
export async function smokeBrowser(image) {
  process.stdout.write("Verifying Browser Host module closure...\n");
  run("docker", [
    "run",
    "--rm",
    "--entrypoint",
    "node",
    image,
    "-e",
    `
    const { createBrowserHostServer } = await import("@space/browser-host");
    const { PostgresSpaceStore } = await import("@space/db");
    const { SpaceConflictError } = await import("@space/runtime");
    if (typeof createBrowserHostServer !== "function") process.exit(1);
    `
  ]);

  process.stdout.write("Launching headless Chromium...\n");
  const chromiumOutput = run("docker", [
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

  if (!chromiumOutput.includes("<html><head></head><body></body></html>")) {
    throw new Error(`Chromium failed to dump DOM for about:blank. Output:\n${chromiumOutput}`);
  }

  process.stdout.write("Browser container smoke check passed: headless Chromium launched successfully.\n");
}

/**
 * Main dispatcher.
 * @param {object} [options]
 * @param {string} [options.target]
 * @param {string} [options.image]
 */
export async function runContainerSmoke(options = parseSmokeArgs()) {
  const { target, image } = options;
  process.stdout.write(`Running smoke check for target '${target}' using image '${image}'...\n`);

  switch (target) {
    case "core":
      await smokeCore(image);
      break;
    case "cli":
      await smokeCli(image);
      break;
    case "browser":
      await smokeBrowser(image);
      break;
    default:
      throw new Error(`Unknown target for container smoke: ${target}`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  runContainerSmoke().catch((error) => {
    process.stderr.write(`Smoke check failed: ${error.message}\n`);
    process.exit(1);
  });
}
