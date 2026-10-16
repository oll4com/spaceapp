#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

// The same multi-platform pgvector image used by the public launcher. Docker
// selects the requested architecture from its manifest, including under QEMU.
const postgresImage = "pgvector/pgvector:0.8.3-pg17-trixie@sha256:3a3147ccd9a0aee952bb69e1acea1eb3cc7183544185b87a662f872cfa47ae3b";
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function parseSmokeOptions(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (!["--target", "--image", "--arch"].includes(name) || !value || value.startsWith("--") || options[name]) {
      throw new Error("Usage: container-service-smoke.mjs --target <core|browser|cli> --image <name:tag> --arch <amd64|arm64>");
    }
    options[name] = value;
  }
  const target = options["--target"];
  const image = options["--image"];
  const arch = options["--arch"];
  if (!["core", "browser", "cli"].includes(target) || !image || image.startsWith("-") || !["amd64", "arm64"].includes(arch)) {
    throw new Error("Usage: container-service-smoke.mjs --target <core|browser|cli> --image <name:tag> --arch <amd64|arm64>");
  }
  return { target, image, arch };
}

function docker(args, { input, timeoutMs = 30_000, includeStderr = false } = {}) {
  return new Promise((resolveCommand, reject) => {
    const child = spawn("docker", args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout = (stdout + chunk).slice(-16 * 1024 * 1024); });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr = (stderr + chunk).slice(-64 * 1024); });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (timedOut) reject(new Error(`docker ${args[0]} timed out after ${timeoutMs}ms`));
      else if (code !== 0) reject(new Error(`docker ${args[0]} exited ${code}: ${stderr || stdout}`));
      else resolveCommand((includeStderr ? stdout + stderr : stdout).trim());
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(input);
  });
}

// Only built-in modules are used by the probes. A smoke check must not force an
// image to ship client modules or test dependencies it does not otherwise run.
export async function hostProtocolProbe(socketPath, method) {
  const { createConnection } = await import("node:net");
  const { strict: verify } = await import("node:assert");
  const requestId = "container-smoke";
  const result = await new Promise((resolveResponse, reject) => {
    const socket = createConnection(socketPath);
    const timer = setTimeout(() => finish(new Error("Host protocol response timed out")), 15_000);
    let buffered = Buffer.alloc(0);
    let finished = false;
    function finish(error, value) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolveResponse(value);
    }
    socket.once("error", (error) => finish(error));
    socket.once("close", () => { if (!finished) finish(new Error("Host closed before responding")); });
    socket.once("connect", () => {
      const payload = Buffer.from(JSON.stringify({ kind: "request", requestId, method, params: {} }));
      const frame = Buffer.alloc(4 + payload.length);
      frame.writeUInt32BE(payload.length);
      payload.copy(frame, 4);
      socket.write(frame);
    });
    socket.on("data", (chunk) => {
      try {
        buffered = Buffer.concat([buffered, chunk]);
        if (buffered.length < 4) return;
        const length = buffered.readUInt32BE(0);
        verify.ok(length > 0 && length < 1024 * 1024, "Invalid host protocol frame");
        if (buffered.length < length + 4) return;
        const response = JSON.parse(buffered.subarray(4, length + 4).toString());
        verify.equal(response.kind, "response");
        verify.equal(response.requestId, requestId);
        verify.equal(response.ok, true, JSON.stringify(response.error));
        finish(null, response.result);
      } catch (error) { finish(error); }
    });
  });
  verify.ok(Number.isInteger(result.hostPid) && result.hostPid > 0);
  verify.ok(Number.isFinite(Date.parse(result.startedAt)));
  if (method === "ping") verify.equal(result.ok, true);
  else {
    verify.equal(result.status.enabled, true);
    verify.equal(result.captureMetrics.jobs.RUNNING, 0);
  }
  console.log(JSON.stringify(result));
}

async function coreReadinessProbe() {
  const { strict: verify } = await import("node:assert");
  const response = await fetch("http://127.0.0.1:4911/readyz?strict=1", { signal: AbortSignal.timeout(10_000) });
  verify.equal(response.status, 200);
  const body = await response.json();
  verify.equal(body.ok, true);
  verify.equal(body.dependencies.store, "postgres");
  verify.equal(body.dependencies.database, "RUNNING");
  const web = await fetch("http://127.0.0.1:4911/", { signal: AbortSignal.timeout(5_000) });
  verify.equal(web.status, 200);
  verify.match(await web.text(), /<html[\s>]/i);
  console.log(JSON.stringify(body));
}

function probeSource(probe, ...args) {
  return `await (${probe.toString()})(${args.map((value) => JSON.stringify(value)).join(",")});`;
}

export async function runContainerServiceSmoke(options) {
  const { target, image, arch } = options;
  const prefix = `spaceapp-smoke-${target}-${arch}-${randomUUID().slice(0, 8)}`;
  const ownedContainers = [];
  let networkId;
  let fixtureDirectory;
  let postgresId;
  let serviceId;
  let failure;
  const cleanupFailures = [];
  const create = async (args) => {
    const id = await docker(["create", "--label", `spaceapp.container-smoke=${prefix}`, ...args]);
    ownedContainers.push(id);
    return id;
  };
  const waitFor = async (name, id, operation, timeoutMs = 240_000) => {
    const deadline = Date.now() + timeoutMs;
    let lastError;
    while (Date.now() < deadline) {
      const state = JSON.parse(await docker(["inspect", "--format", "{{json .State}}", id]));
      if (!state.Running) throw new Error(`${name} stopped before readiness (exit ${state.ExitCode}): ${state.Error}`);
      try { return await operation(); } catch (error) { lastError = error; }
      await delay(1_000);
    }
    throw new Error(`${name} did not become ready: ${lastError?.message}`);
  };
  try {
    const inspectedImage = JSON.parse(await docker(["image", "inspect", "--format", "{{json .}}", image]));
    assert.equal(inspectedImage.Architecture, arch, "The loaded service image has the wrong architecture");
    assert.equal(inspectedImage.Os, "linux");
    networkId = await docker(["network", "create", "--internal", "--label", `spaceapp.container-smoke=${prefix}`, prefix]);
    const platform = `linux/${arch}`;
    const createArgs = ["--platform", platform, "--network", networkId, "--init", "--security-opt", "no-new-privileges:true"];
    const migrationDirectory = join(repositoryRoot, "packages", "db", "migrations");
    const migrationFiles = (await readdir(migrationDirectory)).filter((name) => name.endsWith(".sql")).sort();
    if (target !== "cli") {
      await docker(["pull", "--platform", platform, postgresImage], { timeoutMs: 300_000 });
      const password = randomBytes(24).toString("hex");
      fixtureDirectory = await mkdtemp(join(tmpdir(), "spaceapp-container-smoke-"));
      await Promise.all([
        writeFile(join(fixtureDirectory, "database-url"), `postgres://spaceapp:${password}@postgres:5432/spaceapp`, { mode: 0o600 }),
        writeFile(join(fixtureDirectory, "session-secret"), randomBytes(48).toString("hex"), { mode: 0o600 }),
        writeFile(join(fixtureDirectory, "setup-token"), randomBytes(32).toString("hex"), { mode: 0o600 })
      ]);
      postgresId = await create([
        ...createArgs, "--name", `${prefix}-postgres`, "--network-alias", "postgres",
        "--env", "POSTGRES_DB=spaceapp", "--env", "POSTGRES_USER=spaceapp", "--env", `POSTGRES_PASSWORD=${password}`, postgresImage
      ]);
      await docker(["start", postgresId]);
      // Initdb's temporary server accepts Unix sockets before restarting. TCP
      // readiness waits for the final server the application will connect to.
      await waitFor("pgvector PostgreSQL", postgresId, () => docker(["exec", postgresId, "pg_isready", "-h", "127.0.0.1", "-U", "spaceapp", "-d", "spaceapp"]));
      if (target === "browser") {
        // Browser Host deliberately does not ship the deployment migrator. Its
        // isolated database uses the exact source SQL; core below exercises the
        // real deploy migration runner and checks its complete history.
        const sql = (await Promise.all(migrationFiles.map((name) => readFile(join(migrationDirectory, name), "utf8")))).join("\n");
        await docker(["exec", "-i", postgresId, "psql", "-U", "spaceapp", "-d", "spaceapp", "--set", "ON_ERROR_STOP=1", "--single-transaction"], { input: sql, timeoutMs: 120_000 });
      }
    }
    const environment = {
      SPACE_PUBLIC_DISTRIBUTION: "true",
      SPACE_CLI_ENABLED: "false",
      SPACE_CLI_HOST_SOCKET: "/run/spaceapp-cli/host.sock",
      SPACE_RUNTIME_STORE: "postgres",
      SPACEAPP_WORKFLOWS_ENABLED: "false",
      SPACE_API_HOST: "127.0.0.1",
      SPACE_API_PORT: "4910",
      SPACE_WEB_HOST: "0.0.0.0",
      SPACE_WEB_PORT: "4911",
      SPACE_API_ORIGIN: "http://127.0.0.1:4910",
      SPACE_BROWSER_HOST_SOCKET: "/run/spaceapp-browser/browser-host.sock",
      SPACE_BROWSER_SESSIONS_ENABLED: target === "browser" ? "true" : "false",
      SPACE_BROWSER_SESSIONS_DEFAULT_URL: "about:blank",
      SPACE_ARTIFACT_ROOT: "/var/lib/spaceapp/artifacts"
    };
    serviceId = await create([
      ...createArgs, "--name", `${prefix}-service`,
      ...Object.entries(environment).flatMap(([name, value]) => ["--env", `${name}=${value}`]), image
    ]);
    if (fixtureDirectory) await docker(["cp", fixtureDirectory, `${serviceId}:/run/secrets`]);
    await docker(["start", serviceId]);
    const execProbe = (source) => docker(["exec", "--user", "10001:10001", serviceId, "node", "--input-type=module", "-e", source]);
    let result;
    if (target === "core") {
      result = JSON.parse(await waitFor("core /readyz", serviceId, () => execProbe(probeSource(coreReadinessProbe))));
      const applied = Number(await docker(["exec", postgresId, "psql", "-U", "spaceapp", "-d", "spaceapp", "-Atc", "SELECT count(*) FROM space_schema_migrations"]));
      assert.equal(applied, migrationFiles.length, "The core entrypoint did not apply every migration");
      const vector = await docker(["exec", postgresId, "psql", "-U", "spaceapp", "-d", "spaceapp", "-Atc", "SELECT extversion FROM pg_extension WHERE extname = 'vector'"]);
      assert.ok(vector, "The pgvector extension was not installed by migrations");
      result = { readyz: result, appliedMigrations: applied, pgvector: vector };
    } else if (target === "cli") {
      result = JSON.parse(await waitFor("CLI host protocol", serviceId, () => execProbe(probeSource(hostProtocolProbe, environment.SPACE_CLI_HOST_SOCKET, "ping"))));
    } else {
      result = JSON.parse(await waitFor("Browser Host protocol", serviceId, () => execProbe(probeSource(hostProtocolProbe, environment.SPACE_BROWSER_HOST_SOCKET, "health"))));
      // Render local content with the bundled Chromium as the service user.
      // This needs no network, display server, account or provider credentials.
      const html = await docker([
        "exec", "--user", "10001:10001", serviceId, "/usr/bin/chromium", "--headless", "--no-sandbox",
        "--disable-dev-shm-usage", "--no-first-run", "--no-default-browser-check", "--user-data-dir=/tmp/spaceapp-smoke-chromium",
        "--dump-dom", "data:text/html,<title>spaceapp-container-smoke</title><p>chromium-rendered</p>"
      ], { timeoutMs: 90_000 });
      assert.match(html, /<title>spaceapp-container-smoke<\/title>/);
      assert.match(html, /<p>chromium-rendered<\/p>/);
      result = { host: result, chromium: "headless local HTML rendered" };
    }
    console.log(JSON.stringify({ target, arch, image, passed: true, result }));
  } catch (error) {
    failure = error;
    for (const id of ownedContainers) {
      const logs = await docker(["logs", "--tail", "80", id], { includeStderr: true }).catch((logError) => logError.message);
      console.error(`Smoke container ${id}:\n${logs}`);
    }
  } finally {
    // Remove only IDs returned by our own create calls, never global Docker
    // state, pre-existing containers, named operator volumes or shared images.
    for (const id of ownedContainers.reverse()) {
      await docker(["rm", "--force", "--volumes", id]).catch((error) => cleanupFailures.push(error.message));
    }
    if (networkId) await docker(["network", "rm", networkId]).catch((error) => cleanupFailures.push(error.message));
    if (fixtureDirectory) await rm(fixtureDirectory, { recursive: true, force: true }).catch((error) => cleanupFailures.push(error.message));
  }
  if (cleanupFailures.length) throw new AggregateError([...(failure ? [failure] : []), ...cleanupFailures.map((message) => new Error(message))], "Container smoke cleanup failed");
  if (failure) throw failure;
  console.log(JSON.stringify({ target, arch, cleaned: true }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { await runContainerServiceSmoke(parseSmokeOptions(process.argv.slice(2))); }
  catch (error) { console.error(error instanceof Error ? error.stack : String(error)); process.exitCode = 1; }
}
