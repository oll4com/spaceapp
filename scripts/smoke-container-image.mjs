#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function parsePostgresImageFromCompose(
  composePath = path.join(repoRoot, "packages", "run-spaceapp", "templates", "compose.yml")
) {
  const composeText = readFileSync(composePath, "utf8");
  const match = composeText.match(
    /^\s{2}postgres:\s*\r?\n(?:.*\r?\n)*?\s*image:\s*([^\s]+@sha256:[0-9a-f]{64})\b/m
  );
  if (!match?.[1]) {
    throw new Error(`Unable to locate digest-pinned postgres image in ${composePath}`);
  }
  return match[1];
}

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function runDocker(args, { stdio = ["ignore", "pipe", "pipe"] } = {}) {
  return execFileSync("docker", args, {
    encoding: "utf8",
    stdio
  }).trim();
}

function tryDocker(args) {
  try {
    return { ok: true, output: runDocker(args) };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

function waitForCondition(description, fn, { timeoutMs = 120_000, intervalMs = 1_500 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError = "timed out";
  while (Date.now() < deadline) {
    const res = fn();
    if (res.ok) {
      return res.output;
    }
    lastError = res.error ?? "not ready";
    sleepMs(intervalMs);
  }
  throw new Error(`Timed out waiting for ${description}: ${lastError}`);
}

function startPostgresContainer({ networkName, containerName, postgresPassword, postgresImage }) {
  runDocker([
    "run",
    "-d",
    "--name",
    containerName,
    "--network",
    networkName,
    "--network-alias",
    "postgres",
    "-e",
    "POSTGRES_DB=spaceapp",
    "-e",
    "POSTGRES_USER=spaceapp",
    "-e",
    `POSTGRES_PASSWORD=${postgresPassword}`,
    postgresImage
  ]);
  waitForCondition(
    "PostgreSQL readiness",
    () =>
      tryDocker([
        "exec",
        containerName,
        "pg_isready",
        "-U",
        "spaceapp",
        "-d",
        "spaceapp"
      ]),
    { timeoutMs: 90_000, intervalMs: 1_000 }
  );
}

export function smokeCheckCoreImage({ image, arch, postgresImage }) {
  const suffix = randomBytes(4).toString("hex");
  const networkName = `spaceapp-smoke-core-${suffix}`;
  const pgContainer = `spaceapp-smoke-pg-${suffix}`;
  const coreContainer = `spaceapp-smoke-core-${suffix}`;
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "spaceapp-smoke-core-"));

  try {
    const postgresPassword = randomBytes(16).toString("hex");
    const databaseUrl = `postgresql://spaceapp:${postgresPassword}@postgres:5432/spaceapp`;
    const dbFile = path.join(tmpDir, "database-url");
    const sessionFile = path.join(tmpDir, "session-secret");
    const setupFile = path.join(tmpDir, "setup-token");
    writeFileSync(dbFile, `${databaseUrl}\n`, { mode: 0o644 });
    writeFileSync(sessionFile, `${randomBytes(24).toString("hex")}\n`, { mode: 0o644 });
    writeFileSync(setupFile, `${randomBytes(16).toString("hex")}\n`, { mode: 0o644 });
    chmodSync(dbFile, 0o644);
    chmodSync(sessionFile, 0o644);
    chmodSync(setupFile, 0o644);

    runDocker(["network", "create", networkName]);
    startPostgresContainer({
      networkName,
      containerName: pgContainer,
      postgresPassword,
      postgresImage
    });

    runDocker([
      "run",
      "-d",
      "--name",
      coreContainer,
      "--platform",
      `linux/${arch}`,
      "--network",
      networkName,
      "-v",
      `${tmpDir}:/run/secrets:ro`,
      "-e",
      "SPACE_PUBLIC_DISTRIBUTION=true",
      "-e",
      "SPACE_RUNTIME_STORE=postgres",
      "-e",
      "SPACEAPP_WORKFLOWS_ENABLED=false",
      "-e",
      "SPACE_CLI_ENABLED=false",
      "-e",
      "SPACE_BROWSER_SESSIONS_ENABLED=false",
      image
    ]);

    const readyOutput = waitForCondition(
      "core /readyz ok: true",
      () =>
        tryDocker([
          "exec",
          coreContainer,
          "node",
          "-e",
          "fetch('http://127.0.0.1:4911/readyz').then(async r => { const b = await r.json(); if (!r.ok || b.ok !== true || b.dependencies?.database !== 'RUNNING') process.exit(1); process.stdout.write(JSON.stringify(b)); }).catch(() => process.exit(1))"
        ]),
      { timeoutMs: 120_000, intervalMs: 1_500 }
    );

    runDocker([
      "exec",
      coreContainer,
      "node",
      "-e",
      "Promise.all([import('@temporalio/worker'), import('./scripts/reset-owner-password.mjs'), import('./scripts/rotate-owner-setup-token.mjs'), import('./scripts/portable-backup.mjs'), import('./scripts/portable-restore.mjs')]).then(([w]) => { if (!w.Worker || !w.NativeConnection) process.exit(1); })"
    ]);

    process.stdout.write(`core smoke passed (${arch}): ${readyOutput}\n`);
    return { ok: true, target: "core", arch };
  } finally {
    tryDocker(["rm", "-f", coreContainer]);
    tryDocker(["rm", "-f", pgContainer]);
    tryDocker(["network", "rm", networkName]);
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

export function smokeCheckCliImage({ image, arch }) {
  const suffix = randomBytes(4).toString("hex");
  const cliContainer = `spaceapp-smoke-cli-${suffix}`;

  try {
    runDocker([
      "run",
      "-d",
      "--name",
      cliContainer,
      "--platform",
      `linux/${arch}`,
      "-e",
      "SPACE_PUBLIC_DISTRIBUTION=true",
      "-e",
      "SPACE_CLI_HOST_SOCKET=/run/spaceapp-cli/host.sock",
      image
    ]);

    const pingOutput = waitForCondition(
      "cli host socket connection and ping",
      () =>
        tryDocker([
          "exec",
          cliContainer,
          "node",
          "-e",
          "import('./packages/cli-host/dist/index.js').then(async ({ CliHostClient }) => { const c = new CliHostClient({ socketPath: '/run/spaceapp-cli/host.sock' }); const ok = await c.ping(); if (!ok) process.exit(1); process.stdout.write(JSON.stringify({ ok })); }).catch(() => process.exit(1))"
        ]),
      { timeoutMs: 90_000, intervalMs: 1_000 }
    );

    process.stdout.write(`cli smoke passed (${arch}): ${pingOutput}\n`);
    return { ok: true, target: "cli", arch };
  } finally {
    tryDocker(["rm", "-f", cliContainer]);
  }
}

export function smokeCheckBrowserImage({ image, arch, postgresImage }) {
  const suffix = randomBytes(4).toString("hex");
  const networkName = `spaceapp-smoke-browser-${suffix}`;
  const pgContainer = `spaceapp-smoke-pg-${suffix}`;
  const browserContainer = `spaceapp-smoke-browser-${suffix}`;
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "spaceapp-smoke-browser-"));

  try {
    const postgresPassword = randomBytes(16).toString("hex");
    const databaseUrl = `postgresql://spaceapp:${postgresPassword}@postgres:5432/spaceapp`;
    const dbFile = path.join(tmpDir, "database-url");
    writeFileSync(dbFile, `${databaseUrl}\n`, { mode: 0o644 });
    chmodSync(dbFile, 0o644);

    runDocker(["network", "create", networkName]);
    startPostgresContainer({
      networkName,
      containerName: pgContainer,
      postgresPassword,
      postgresImage
    });

    runDocker([
      "run",
      "--rm",
      "--platform",
      `linux/${arch}`,
      "--network",
      networkName,
      "--entrypoint",
      "node",
      "-e",
      `SPACE_DATABASE_URL=${databaseUrl}`,
      image,
      "packages/db/dist/migrate.js"
    ]);

    runDocker([
      "run",
      "-d",
      "--name",
      browserContainer,
      "--platform",
      `linux/${arch}`,
      "--network",
      networkName,
      "-v",
      `${tmpDir}:/run/secrets:ro`,
      "-e",
      "SPACE_PUBLIC_DISTRIBUTION=true",
      "-e",
      "SPACE_RUNTIME_STORE=postgres",
      "-e",
      "SPACE_SESSION_SECRET=smoke-browser-session-secret-0123456789abcdef",
      "-e",
      "SPACE_BROWSER_SESSIONS_ENABLED=true",
      "-e",
      "SPACE_BROWSER_HOST_SOCKET=/run/spaceapp-browser/browser-host.sock",
      image
    ]);

    const healthOutput = waitForCondition(
      "browser host socket readiness",
      () =>
        tryDocker([
          "exec",
          browserContainer,
          "node",
          "-e",
          "import('./packages/browser-host/dist/index.js').then(async ({ BrowserHostClient }) => { const c = new BrowserHostClient({ socketPath: '/run/spaceapp-browser/browser-host.sock' }); const h = await c.health(); if (!h || typeof h.hostPid !== 'number') process.exit(1); process.stdout.write(JSON.stringify({ hostPid: h.hostPid, status: h.status })); }).catch(() => process.exit(1))"
        ]),
      { timeoutMs: 90_000, intervalMs: 1_500 }
    );

    const domOutput = runDocker([
      "exec",
      browserContainer,
      "gosu",
      "spaceapp",
      "chromium",
      "--headless",
      "--no-sandbox",
      "--disable-gpu",
      "--dump-dom",
      "about:blank"
    ]);
    if (!domOutput.includes("<html")) {
      throw new Error(`Expected headless Chromium --dump-dom output to contain <html, got: ${domOutput}`);
    }

    process.stdout.write(`browser smoke passed (${arch}): ${healthOutput}\n`);
    return { ok: true, target: "browser", arch };
  } finally {
    tryDocker(["rm", "-f", browserContainer]);
    tryDocker(["rm", "-f", pgContainer]);
    tryDocker(["network", "rm", networkName]);
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

function optionValue(args, name) {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

export function parseSmokeArgs(args = process.argv.slice(2)) {
  const target = optionValue(args, "--target");
  const arch = optionValue(args, "--arch") ?? "amd64";
  const image = optionValue(args, "--image");
  if (!target || !image) {
    throw new Error(
      "Usage: smoke-container-image.mjs --target <core|browser|cli> --image <name:tag> [--arch <amd64|arm64>]"
    );
  }
  return {
    target,
    arch,
    image,
    postgresImage:
      optionValue(args, "--postgres-image") ??
      (target === "core" || target === "browser" ? parsePostgresImageFromCompose() : undefined)
  };
}

export function runSmokeContainerImage(args = process.argv.slice(2)) {
  const { target, arch, image, postgresImage } = parseSmokeArgs(args);
  if (target === "core") {
    return smokeCheckCoreImage({
      image,
      arch,
      postgresImage
    });
  }
  if (target === "cli") {
    return smokeCheckCliImage({ image, arch });
  }
  if (target === "browser") {
    return smokeCheckBrowserImage({
      image,
      arch,
      postgresImage
    });
  }
  throw new Error(`Unknown container target: ${target}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    runSmokeContainerImage();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
