#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

const executeFile = promisify(execFile);
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function pinnedServiceImage(compose, service) {
  const block = compose.match(new RegExp(`^  ${service}:\\r?\\n([\\s\\S]*?)(?=^  [a-zA-Z0-9_-]+:|^[^ #]|$(?![\\s\\S]))`, "m"))?.[1];
  const image = block?.match(/^    image: ([^\s"']+@sha256:[0-9a-f]{64})\s*$/m)?.[1];
  if (!image) throw new Error(`Missing digest-pinned ${service} image in launcher Compose`);
  return image;
}

async function until(check, description, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  let latest;
  do {
    try { const result = await check(); if (result) return result; } catch (error) { latest = error; }
    await wait(1_000);
  } while (Date.now() < deadline);
  throw new Error(`Timed out waiting for ${description}`, { cause: latest });
}

export async function smokeImage({ target, image, root = repositoryRoot, execute = executeFile }) {
  if (!["core", "browser", "cli"].includes(target) || !image) throw new Error("Expected --target core|browser|cli and --image tag");
  const compose = await readFile(join(root, "packages/run-spaceapp/templates/compose.yml"), "utf8");
  const postgresImage = target === "cli" ? null : pinnedServiceImage(compose, "postgres");
  const identity = randomBytes(8).toString("hex");
  const prefix = `space-smoke-${identity}`;
  const main = `${prefix}-${target}`;
  const postgres = `${prefix}-postgres`;
  const network = `${prefix}-network`;
  const directory = await mkdtemp(join(tmpdir(), `${prefix}-`));
  const password = randomBytes(24).toString("hex");
  const sessionSecret = randomBytes(32).toString("hex");
  const setupToken = randomBytes(32).toString("hex");
  const databaseUrl = `postgresql://spaceapp:${password}@${postgres}:5432/spaceapp`;
  const ownedContainers = [];
  let ownedVolumes = [];
  let networkCreated = false;
  let failure;
  const cleanupErrors = [];
  const report = { target, image, started: false, runtimeUid: null, ready: false, socket: false, chromium: false, xvfbAvailable: false, cleaned: false };
  const docker = async (args, options = {}) => (await execute("docker", args, { encoding: "utf8", timeout: 180_000, maxBuffer: 8 * 1024 * 1024, ...options })).stdout.trim();
  const nodeIn = (container, code) => docker(["exec", "--user", "10001:10001", container, "node", "--input-type=module", "-e", code], { timeout: 30_000 });
  try {
    await writeFile(join(directory, "database-url"), `${databaseUrl}\n`, { mode: 0o600 });
    await writeFile(join(directory, "session-secret"), `${sessionSecret}\n`, { mode: 0o600 });
    await writeFile(join(directory, "setup-token"), `${setupToken}\n`, { mode: 0o600 });
    await writeFile(join(directory, "postgres.env"), `POSTGRES_USER=spaceapp\nPOSTGRES_DB=spaceapp\nPOSTGRES_PASSWORD=${password}\n`, { mode: 0o600 });
    const environment = {
      SPACE_DATABASE_URL: databaseUrl, SPACE_RUNTIME_STORE: "postgres", SPACE_PUBLIC_DISTRIBUTION: "true",
      SPACE_DEV_LOGIN: "false", SPACEAPP_WORKFLOWS_ENABLED: "false", SPACE_TELEMETRY_ENABLED: "false",
      SPACE_CLI_ENABLED: String(target === "cli"), SPACE_BROWSER_SESSIONS_ENABLED: String(target === "browser"),
      SPACE_SESSION_SECRET: sessionSecret, SPACE_BROWSER_HOST_SOCKET: "/run/spaceapp-browser/host.sock",
      SPACE_CLI_HOST_SOCKET: "/run/spaceapp-cli/host.sock", SPACE_API_HOST: "127.0.0.1", SPACE_API_PORT: "4910",
      SPACE_WEB_HOST: "0.0.0.0", SPACE_WEB_PORT: "4911", SPACE_API_ORIGIN: "http://127.0.0.1:4910"
    };
    await writeFile(join(directory, "runtime.env"), `${Object.entries(environment).map(([key, value]) => `${key}=${value}`).join("\n")}\n`, { mode: 0o600 });
    await docker(["network", "create", network]);
    networkCreated = true;
    if (postgresImage) {
      ownedContainers.push(postgres);
      await docker(["run", "-d", "--name", postgres, "--network", network, "--env-file", join(directory, "postgres.env"), postgresImage]);
      ownedVolumes = JSON.parse(await docker(["inspect", postgres, "--format", "{{json .Mounts}}"])).filter(mount => mount.Type === "volume").map(mount => mount.Name);
      await until(async () => { await docker(["exec", postgres, "pg_isready", "-U", "spaceapp", "-d", "spaceapp"], { timeout: 5_000 }); return true; }, "isolated PostgreSQL");
    }
    if (target === "browser") {
      // Only a database fixture: use the real shipped SQL. Core and full-stack
      // checks separately exercise the application's actual migration runner.
      const bootstrap = 'import pg from "pg"; import {loadMigrations} from "@space/db"; const c=new pg.Client({connectionString:process.env.SPACE_DATABASE_URL}); await c.connect(); try { await c.query("CREATE TABLE IF NOT EXISTS space_schema_migrations(id text PRIMARY KEY,filename text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())"); for(const m of await loadMigrations()){await c.query("BEGIN");await c.query(m.sql);await c.query("INSERT INTO space_schema_migrations(id,filename) VALUES($1,$2)",[m.id,m.filename]);await c.query("COMMIT");}} finally {await c.end();}';
      await docker(["run", "--rm", "--network", network, "--env-file", join(directory, "runtime.env"), "--entrypoint", "node", image, "--input-type=module", "-e", bootstrap]);
    }
    ownedContainers.push(main);
    await docker(["run", "-d", "--name", main, "--network", network,
      "--env-file", join(directory, "runtime.env"), "--mount", `type=bind,src=${directory},dst=/run/secrets,readonly`,
      ...(target === "core" ? ["--publish", "127.0.0.1::4911"] : []), image]);
    report.started = true;
    if (target === "core") {
      const ports = JSON.parse(await docker(["inspect", main, "--format", "{{json .NetworkSettings.Ports}}"]));
      const port = ports["4911/tcp"][0];
      assert.equal(port.HostIp, "127.0.0.1");
      await until(async () => {
        const response = await fetch(`http://127.0.0.1:${port.HostPort}/readyz`, { signal: AbortSignal.timeout(5_000) });
        return response.ok && (await response.json()).ok === true;
      }, "core entrypoint migrations and /readyz");
      await nodeIn(main, 'await import("@temporalio/worker"); await import("@space/cli-host/client");');
      report.ready = true;
    } else {
      const client = target === "cli" ? "CliHostClient" : "BrowserHostClient";
      const module = target === "cli" ? "@space/cli-host" : "@space/browser-host";
      const socket = target === "cli" ? environment.SPACE_CLI_HOST_SOCKET : environment.SPACE_BROWSER_HOST_SOCKET;
      await until(async () => {
        const raw = await nodeIn(main, `import {${client}} from ${JSON.stringify(module)}; const c=new ${client}({socketPath:${JSON.stringify(socket)}}); try {const h=await c.health();if(!(h.hostPid>0))throw new Error("Host PID missing");console.log("socket-ready");} finally {await c.close();}`);
        return raw.includes("socket-ready");
      }, `${target} host's real socket`);
      report.socket = true;
      if (target === "browser") {
        // Real browser panes start headed Chrome through this display server.
        await nodeIn(main, 'import fs from "node:fs"; fs.accessSync("/usr/bin/Xvfb", fs.constants.X_OK);');
        report.xvfbAvailable = true;
        const html = await docker(["exec", "--user", "10001:10001", main, "/usr/bin/chromium", "--headless", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--disable-background-networking", "--dump-dom", "data:text/html,<title>SpaceApp container smoke</title>"]);
        assert.match(html, /<title>SpaceApp container smoke<\/title>/);
        report.chromium = true;
      }
    }
    const uid = await nodeIn(main, 'import fs from "node:fs"; const status=fs.readFileSync("/proc/1/status","utf8"); const uid=Number(status.match(/^Uid:\\s+(\\d+)/m)[1]); if(uid!==10001)throw new Error(`Unexpected runtime uid ${uid}`); for(const f of ["/app/LICENSE","/app/NOTICE","/app/THIRD_PARTY_NOTICES.md","/app/deploy/docker/public-cli-wrapper.sh"])fs.accessSync(f); if(fs.readlinkSync("/usr/local/bin/opencode-vscode-parity")!=="/usr/local/bin/spaceapp-cli-wrapper")throw new Error("Wrapper link missing");console.log(uid);');
    report.runtimeUid = Number(uid);
  } catch (error) {
    // Preserve the actual startup/assertion error even if diagnostic logs fail.
    failure = error;
    for (const container of ownedContainers) {
      try {
        let logs = await docker(["logs", "--tail", "50", container], { timeout: 5_000 });
        for (const secret of [password, sessionSecret, setupToken]) logs = logs.replaceAll(secret, "[redacted]");
        if (logs) process.stderr.write(`${container}: ${logs}\n`);
      } catch { /* Original failure wins. */ }
    }
  } finally {
    for (const container of ownedContainers.reverse()) {
      try { await docker(["rm", "--force", "--volumes", container], { timeout: 30_000 }); }
      catch (error) { if (!String(error.stderr ?? error.message).includes("No such container")) cleanupErrors.push(error); }
    }
    if (networkCreated) {
      try { await docker(["network", "rm", network], { timeout: 30_000 }); } catch (error) { cleanupErrors.push(error); }
    }
    for (const volume of ownedVolumes) {
      try { await docker(["volume", "inspect", volume]); cleanupErrors.push(new Error(`Anonymous fixture volume survived: ${volume}`)); }
      catch (error) { if (!String(error.stderr ?? error.message).includes("no such volume") && !String(error.stderr ?? error.message).includes("No such volume")) cleanupErrors.push(error); }
    }
    await rm(directory, { recursive: true, force: true });
    report.cleaned = cleanupErrors.length === 0;
  }
  if (failure && cleanupErrors.length) throw new AggregateError([failure, ...cleanupErrors], failure.message, { cause: failure });
  if (failure) throw failure;
  if (cleanupErrors.length) throw new AggregateError(cleanupErrors, "Container smoke cleanup failed");
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const option = name => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
  smokeImage({ target: option("--target"), image: option("--image") }).then(report => {
    process.stdout.write(`${JSON.stringify(report)}\n`);
  }).catch(error => { process.stderr.write(`${error.stack}\n`); process.exitCode = 1; });
}
