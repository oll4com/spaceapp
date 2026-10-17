#!/usr/bin/env node
import { execFile } from "node:child_process";
import { resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const postgresSmokeImage =
  "pgvector/pgvector:0.8.3-pg17-trixie@sha256:3a3147ccd9a0aee952bb69e1acea1eb3cc7183544185b87a662f872cfa47ae3b";

const supportedTargets = new Set(["core", "browser", "cli"]);
const supportedArchs = new Set(["amd64", "arm64"]);

export function parseSmokeArgs(argv = process.argv.slice(2)) {
  let target = "";
  let arch = "";
  let image = "";

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--target") {
      target = argv[index + 1] ?? "";
      index += 1;
    } else if (token.startsWith("--target=")) {
      target = token.slice("--target=".length);
    } else if (token === "--arch") {
      arch = argv[index + 1] ?? "";
      index += 1;
    } else if (token.startsWith("--arch=")) {
      arch = token.slice("--arch=".length);
    } else if (token === "--image") {
      image = argv[index + 1] ?? "";
      index += 1;
    } else if (token.startsWith("--image=")) {
      image = token.slice("--image=".length);
    }
  }

  const normalizedTarget = target.trim().toLowerCase();
  const normalizedArch = arch.trim().toLowerCase();
  const normalizedImage = image.trim();

  if (!supportedTargets.has(normalizedTarget)) {
    throw new Error(`Unsupported container smoke target: ${target || "<empty>"}. Expected core, browser, or cli.`);
  }
  if (!supportedArchs.has(normalizedArch)) {
    throw new Error(`Unsupported container smoke architecture: ${arch || "<empty>"}. Expected amd64 or arm64.`);
  }
  if (!normalizedImage) {
    throw new Error("Container smoke check requires --image <tag>.");
  }

  return {
    target: normalizedTarget,
    arch: normalizedArch,
    image: normalizedImage
  };
}

async function defaultRunCommand(command, args, { timeoutMs = 120_000 } = {}) {
  const { stdout, stderr } = await execFileAsync(command, args, {
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 8 * 1024 * 1024
  });
  return { stdout: stdout ?? "", stderr: stderr ?? "" };
}

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

async function pollUntilReady({ label, attempts, delayMs, check }) {
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await check();
      return;
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        await sleep(delayMs);
      }
    }
  }
  const detail = lastError instanceof Error ? lastError.message : String(lastError ?? "unknown error");
  throw new Error(`${label} did not become ready after ${attempts} attempts: ${detail}`);
}

async function dumpLogsBestEffort(runCommand, containerName) {
  try {
    const { stdout, stderr } = await runCommand("docker", ["logs", containerName], { timeoutMs: 15_000 });
    const combined = `${stdout}\n${stderr}`.trim();
    if (combined) {
      process.stderr.write(`--- docker logs (${containerName}) ---\n${combined}\n--- end logs ---\n`);
    }
  } catch {
    // Ignore log collection errors during cleanup
  }
}

async function cleanupDockerResources(runCommand, { containers = [], network = null }) {
  for (const container of containers) {
    try {
      await runCommand("docker", ["rm", "-f", container], { timeoutMs: 30_000 });
    } catch {
      // Best-effort cleanup
    }
  }
  if (network) {
    try {
      await runCommand("docker", ["network", "rm", network], { timeoutMs: 30_000 });
    } catch {
      // Best-effort cleanup
    }
  }
}

async function startPostgresService(runCommand, { networkName, pgContainerName, sleepFn }) {
  await runCommand("docker", ["network", "create", networkName]);
  await runCommand("docker", [
    "run",
    "-d",
    "--name",
    pgContainerName,
    "--network",
    networkName,
    "--network-alias",
    "postgres",
    "-e",
    "POSTGRES_DB=spaceapp",
    "-e",
    "POSTGRES_USER=spaceapp",
    "-e",
    "POSTGRES_PASSWORD=spaceapp-smoke",
    postgresSmokeImage
  ]);

  await pollUntilReady({
    label: `PostgreSQL (${pgContainerName})`,
    attempts: 30,
    delayMs: 1000,
    check: async () => {
      try {
        await runCommand("docker", ["exec", pgContainerName, "pg_isready", "-U", "spaceapp", "-d", "spaceapp"], {
          timeoutMs: 10_000
        });
      } catch (error) {
        if (sleepFn) await sleepFn(0);
        throw error;
      }
    }
  });
}

export async function smokeCheckCore({
  image,
  arch,
  runId = `${Date.now()}`,
  runCommand = defaultRunCommand,
  delayMs = 1000
}) {
  const networkName = `spaceapp-smoke-core-net-${arch}-${runId}`;
  const pgContainerName = `spaceapp-smoke-core-pg-${arch}-${runId}`;
  const coreContainerName = `spaceapp-smoke-core-${arch}-${runId}`;
  const databaseUrl = "postgresql://spaceapp:spaceapp-smoke@postgres:5432/spaceapp";

  try {
    await startPostgresService(runCommand, { networkName, pgContainerName });

    await runCommand("docker", [
      "run",
      "-d",
      "--platform",
      `linux/${arch}`,
      "--name",
      coreContainerName,
      "--network",
      networkName,
      "--tmpfs",
      "/var/lib/spaceapp:uid=10001,gid=10001,mode=0770",
      "--tmpfs",
      "/run/spaceapp:uid=10001,gid=10001,mode=0770",
      "--tmpfs",
      "/run/spaceapp-cli:uid=10001,gid=10001,mode=0770",
      "--tmpfs",
      "/run/spaceapp-browser:uid=10001,gid=10001,mode=0770",
      "--tmpfs",
      "/workspaces:uid=10001,gid=10001,mode=0770",
      "-e",
      "SPACE_PUBLIC_DISTRIBUTION=true",
      "-e",
      "SPACE_RUNTIME_STORE=postgres",
      "-e",
      `SPACE_DATABASE_URL=${databaseUrl}`,
      "-e",
      "SPACE_SESSION_SECRET=smoke-test-session-secret-0123456789abcdef",
      "-e",
      "SPACE_SETUP_TOKEN=smoke-test-setup-token-0123456789abcdef0123456789abcdef",
      "-e",
      "SPACEAPP_WORKFLOWS_ENABLED=false",
      "-e",
      "SPACE_BROWSER_SESSIONS_ENABLED=false",
      "-e",
      "SPACE_API_HOST=127.0.0.1",
      "-e",
      "SPACE_API_PORT=4910",
      "-e",
      "SPACE_WEB_HOST=0.0.0.0",
      "-e",
      "SPACE_WEB_PORT=4911",
      "-e",
      "SPACE_API_ORIGIN=http://127.0.0.1:4910",
      image
    ]);

    const readyzScript =
      "fetch('http://127.0.0.1:4911/readyz').then(async (r) => { if (!r.ok) process.exit(1); const body = await r.json(); if (body.ok !== true) process.exit(1); }).catch(() => process.exit(1))";

    await pollUntilReady({
      label: `core /readyz (${coreContainerName})`,
      attempts: 90,
      delayMs,
      check: async () => {
        await runCommand("docker", ["exec", coreContainerName, "node", "-e", readyzScript], {
          timeoutMs: 15_000
        });
      }
    });
  } catch (error) {
    await dumpLogsBestEffort(runCommand, coreContainerName);
    throw error;
  } finally {
    await cleanupDockerResources(runCommand, {
      containers: [coreContainerName, pgContainerName],
      network: networkName
    });
  }
}

export async function smokeCheckCli({
  image,
  arch,
  runId = `${Date.now()}`,
  runCommand = defaultRunCommand,
  delayMs = 1000
}) {
  const cliContainerName = `spaceapp-smoke-cli-${arch}-${runId}`;

  try {
    await runCommand("docker", [
      "run",
      "-d",
      "--platform",
      `linux/${arch}`,
      "--name",
      cliContainerName,
      "--tmpfs",
      "/run/spaceapp-cli:uid=10001,gid=10001,mode=0770",
      "--tmpfs",
      "/var/lib/spaceapp-cli:uid=10001,gid=10001,mode=0770",
      "--tmpfs",
      "/var/lib/spaceapp/memory:uid=10001,gid=10001,mode=0770",
      "--tmpfs",
      "/workspaces:uid=10001,gid=10001,mode=0770",
      "-e",
      "SPACE_PUBLIC_DISTRIBUTION=true",
      "-e",
      "SPACE_MEMORY_ROOT=/var/lib/spaceapp/memory",
      "-e",
      "SPACE_CLI_HOST_SOCKET=/run/spaceapp-cli/host.sock",
      image
    ]);

    const cliPingScript = [
      "import net from 'node:net';",
      "import { encodeLengthPrefixedJson, LengthPrefixedJsonDecoder } from '/app/packages/cli-host/dist/index.js';",
      "await new Promise((resolve, reject) => {",
      "  const socket = net.createConnection('/run/spaceapp-cli/host.sock');",
      "  const timer = setTimeout(() => { socket.destroy(); reject(new Error('CLI host ping timed out')); }, 5000);",
      "  const decoder = new LengthPrefixedJsonDecoder((msg) => {",
      "    clearTimeout(timer);",
      "    socket.end();",
      "    if (msg?.kind === 'response' && msg?.id === 'smoke-ping' && msg?.ok === true) resolve();",
      "    else reject(new Error('Unexpected CLI host response'));",
      "  });",
      "  socket.once('error', (err) => { clearTimeout(timer); reject(err); });",
      "  socket.once('connect', () => { socket.write(encodeLengthPrefixedJson({ id: 'smoke-ping', type: 'ping' })); });",
      "  socket.on('data', (chunk) => decoder.push(chunk));",
      "});"
    ].join(" ");

    await pollUntilReady({
      label: `cli host socket (${cliContainerName})`,
      attempts: 45,
      delayMs,
      check: async () => {
        await runCommand(
          "docker",
          ["exec", cliContainerName, "node", "--input-type=module", "-e", cliPingScript],
          { timeoutMs: 15_000 }
        );
      }
    });
  } catch (error) {
    await dumpLogsBestEffort(runCommand, cliContainerName);
    throw error;
  } finally {
    await cleanupDockerResources(runCommand, {
      containers: [cliContainerName]
    });
  }
}

export async function smokeCheckBrowser({
  image,
  arch,
  runId = `${Date.now()}`,
  runCommand = defaultRunCommand,
  delayMs = 1000
}) {
  const networkName = `spaceapp-smoke-browser-net-${arch}-${runId}`;
  const pgContainerName = `spaceapp-smoke-browser-pg-${arch}-${runId}`;
  const browserContainerName = `spaceapp-smoke-browser-${arch}-${runId}`;
  const databaseUrl = "postgresql://spaceapp:spaceapp-smoke@postgres:5432/spaceapp";

  try {
    await startPostgresService(runCommand, { networkName, pgContainerName });

    await runCommand("docker", [
      "run",
      "--rm",
      "--platform",
      `linux/${arch}`,
      "--network",
      networkName,
      "-e",
      `SPACE_DATABASE_URL=${databaseUrl}`,
      "--entrypoint",
      "node",
      image,
      "/app/packages/db/dist/migrate.js"
    ], { timeoutMs: 180_000 });

    await runCommand("docker", [
      "run",
      "-d",
      "--platform",
      `linux/${arch}`,
      "--name",
      browserContainerName,
      "--network",
      networkName,
      "--tmpfs",
      "/var/lib/spaceapp:uid=10001,gid=10001,mode=0770",
      "--tmpfs",
      "/run/spaceapp-browser:uid=10001,gid=10001,mode=0770",
      "-e",
      "SPACE_PUBLIC_DISTRIBUTION=true",
      "-e",
      "SPACE_RUNTIME_STORE=postgres",
      "-e",
      `SPACE_DATABASE_URL=${databaseUrl}`,
      "-e",
      "SPACE_SESSION_SECRET=smoke-test-session-secret-0123456789abcdef",
      "-e",
      "SPACE_ARTIFACT_ROOT=/var/lib/spaceapp/artifacts",
      "-e",
      "SPACE_BROWSER_SESSIONS_ENABLED=true",
      "-e",
      "SPACE_BROWSER_HOST_SOCKET=/run/spaceapp-browser/browser-host.sock",
      "-e",
      "SPACE_BROWSER_SESSIONS_DEFAULT_URL=about:blank",
      image
    ]);

    const browserHealthScript =
      "import { BrowserHostSocketClient } from '/app/packages/browser-host/dist/index.js'; const health = await new BrowserHostSocketClient('/run/spaceapp-browser/browser-host.sock').health(); if (!(health.capacity?.maxSessions >= 8) || !(health.capacity?.maxLiveWorkloads >= 4)) process.exit(1);";

    await pollUntilReady({
      label: `browser host socket (${browserContainerName})`,
      attempts: 60,
      delayMs,
      check: async () => {
        await runCommand(
          "docker",
          ["exec", browserContainerName, "node", "--input-type=module", "-e", browserHealthScript],
          { timeoutMs: 15_000 }
        );
      }
    });

    const { stdout } = await runCommand(
      "docker",
      [
        "exec",
        browserContainerName,
        "/usr/bin/chromium",
        "--headless",
        "--no-sandbox",
        "--no-zygote",
        "--single-process",
        "--disable-gpu",
        "--disable-dev-shm-usage",
        "--dump-dom",
        "about:blank"
      ],
      { timeoutMs: 60_000 }
    );
    if (!stdout.includes("<html") || !stdout.includes("<body")) {
      throw new Error(`Headless Chromium did not return expected DOM output: ${stdout.slice(0, 200)}`);
    }
  } catch (error) {
    await dumpLogsBestEffort(runCommand, browserContainerName);
    throw error;
  } finally {
    await cleanupDockerResources(runCommand, {
      containers: [browserContainerName, pgContainerName],
      network: networkName
    });
  }
}

export async function runSmokeCheck(options) {
  const { target, arch, image } = options;
  if (target === "core") {
    await smokeCheckCore(options);
  } else if (target === "cli") {
    await smokeCheckCli(options);
  } else if (target === "browser") {
    await smokeCheckBrowser(options);
  } else {
    throw new Error(`Unsupported container smoke target: ${target}`);
  }
  process.stdout.write(`${target} (${arch}) container startup smoke check passed for ${image}.\n`);
}

const isMain = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  const parsed = parseSmokeArgs();
  await runSmokeCheck(parsed);
}
