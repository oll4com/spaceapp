#!/usr/bin/env node
// Core image smoke check (#64): the image starts against a pgvector
// PostgreSQL service, runs its migrations and answers /readyz with ok:true.
// Usage: node scripts/container-smoke/core-smoke.mjs <image>
// Environment: SMOKE_DATABASE_URL (default spaceapp user on 127.0.0.1:5432),
// SMOKE_TIMEOUT_MS (default 300000), SMOKE_PORT (default 4911).
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

const containerName = "spaceapp-smoke-core";

function sh(args) {
  return execFileSync(args[0], args.slice(1), { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const image = process.argv[2];
  if (!image) {
    throw new Error("Usage: node scripts/container-smoke/core-smoke.mjs <image>");
  }
  const databaseUrl = process.env.SMOKE_DATABASE_URL ?? "postgres://spaceapp:spaceapp@127.0.0.1:5432/spaceapp";
  const timeoutMs = Number(process.env.SMOKE_TIMEOUT_MS ?? 300_000);
  const port = process.env.SMOKE_PORT ?? "4911";
  const secrets = mkdtempSync(join(tmpdir(), "spaceapp-smoke-core-secrets-"));
  try {
    writeFileSync(join(secrets, "database-url"), databaseUrl);
    writeFileSync(join(secrets, "session-secret"), randomBytes(32).toString("hex"));
    writeFileSync(join(secrets, "setup-token"), randomBytes(24).toString("hex"));
    try {
      sh(["docker", "rm", "-f", containerName]);
    } catch {}
    sh(["docker", "run", "-d", "--name", containerName, "--network", "host",
      "-v", `${secrets}:/run/secrets:ro`,
      "-e", "SPACE_RUNTIME_STORE=postgres",
      "-e", "SPACE_PUBLIC_DISTRIBUTION=true",
      // Workflows, CLI panes and browser panes are disabled so the check
      // exercises this image (API + web server + migrations), not the other
      // containers the launcher runs beside it.
      "-e", "SPACEAPP_WORKFLOWS_ENABLED=false",
      "-e", "SPACE_CLI_ENABLED=false",
      "-e", "SPACE_BROWSER_SESSIONS_ENABLED=false",
      "-e", "SPACE_API_HOST=127.0.0.1",
      "-e", "SPACE_API_PORT=4910",
      "-e", "SPACE_WEB_HOST=127.0.0.1",
      "-e", `SPACE_WEB_PORT=${port}`,
      "-e", "SPACE_API_ORIGIN=http://127.0.0.1:4910",
      image]);
    const deadline = Date.now() + timeoutMs;
    let lastError = "no response";
    let lastBody = "";
    while (Date.now() < deadline) {
      await sleep(2_000);
      try {
        const response = await fetch(`http://127.0.0.1:${port}/readyz`);
        lastBody = await response.text();
        const body = JSON.parse(lastBody);
        if (response.ok && body.ok === true) {
          const logs = sh(["docker", "logs", containerName]);
          if (!logs.includes("applied")) {
            throw new Error("Core answered /readyz ok:true, but the migrations did not report applying.");
          }
          process.stdout.write("core smoke: /readyz ok:true, migrations applied\n");
          return;
        }
        lastError = `ok:${body.ok} dependencies:${JSON.stringify(body.dependencies)}`;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
    }
    let logs = "";
    try {
      logs = sh(["docker", "logs", "--tail", "80", containerName]);
    } catch {}
    throw new Error(`Core smoke failed: ${lastError}\nLast body: ${lastBody}\nContainer logs:\n${logs}`);
  } finally {
    try {
      sh(["docker", "rm", "-f", containerName]);
    } catch {}
    rmSync(secrets, { recursive: true, force: true });
  }
}

await main();
