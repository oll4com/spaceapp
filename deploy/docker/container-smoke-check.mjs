#!/usr/bin/env node
// Per-service container smoke checks (#64):
// - core: verifies the trimmed @temporalio/core-bridge native addon loads,
//   starts against a pgvector PostgreSQL service, applies migrations, and
//   answers /readyz with ok:true.
// - cli: starts the CLI host, accepts a framed ping on its Unix socket as
//   the non-root spaceapp user, and verifies node-pty loads.
// - browser: runs database migrations, starts the Browser Host, answers a
//   framed health request on its Unix socket as spaceapp, and launches
//   headless Chromium once as spaceapp (or asserts /usr/bin/chromium is
//   executable under QEMU user-mode emulation when SMOKE_SKIP_CHROMIUM_LAUNCH=true).
//
// Usage:
//   node deploy/docker/container-smoke-check.mjs --target <core|browser|cli> --image <image>
import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const validSmokeTargets = Object.freeze(["core", "browser", "cli"]);

const defaultDatabaseUrl = "postgres://spaceapp:spaceapp@127.0.0.1:5432/spaceapp";
const browserSocketPath = "/run/spaceapp-browser/browser-host.sock";
const cliSocketPath = "/run/space-codex-pane-host/pane-host.sock";

/**
 * Parses and validates `--target` and `--image` arguments for the container smoke check CLI.
 */
export function parseSmokeArgs(argv) {
  let target;
  let image;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--target") {
      target = argv[++index];
    } else if (arg === "--image") {
      image = argv[++index];
    } else if (!arg.startsWith("--") && !target) {
      target = arg;
    } else if (!arg.startsWith("--") && !image) {
      image = arg;
    } else {
      throw new Error(`Unexpected argument: ${arg}`);
    }
  }
  if (!target || !validSmokeTargets.includes(target)) {
    throw new Error(
      `Invalid or missing --target (${String(target)}). Expected one of: ${validSmokeTargets.join(", ")}`
    );
  }
  if (!image || typeof image !== "string" || !image.trim()) {
    throw new Error("Missing --image <image-tag>.");
  }
  return { target, image: image.trim() };
}

/**
 * Encodes a JSON-serializable message with a 4-byte big-endian byte length prefix.
 */
export function encodeLengthPrefixedFrame(message) {
  const payload = Buffer.from(JSON.stringify(message), "utf8");
  const frame = Buffer.allocUnsafe(4 + payload.length);
  frame.writeUInt32BE(payload.length, 0);
  payload.copy(frame, 4);
  return frame;
}

/**
 * Decodes all complete 4-byte length-prefixed JSON frames from `buffer` and returns any trailing bytes.
 */
export function decodeLengthPrefixedFrames(buffer) {
  const messages = [];
  let offset = 0;
  while (buffer.length - offset >= 4) {
    const length = buffer.readUInt32BE(offset);
    if (buffer.length - offset < 4 + length) break;
    const raw = buffer.subarray(offset + 4, offset + 4 + length).toString("utf8");
    messages.push(JSON.parse(raw));
    offset += 4 + length;
  }
  return { messages, remaining: buffer.subarray(offset) };
}

/**
 * Redacts explicit secret values and PostgreSQL connection string passwords from log or error text.
 */
export function redactSmokeText(text, secrets = []) {
  let output = String(text ?? "");
  for (const secret of secrets) {
    if (typeof secret === "string" && secret.length >= 6) {
      output = output.split(secret).join("[REDACTED]");
    }
  }
  return output.replace(/(postgres(?:ql)?:\/\/[^:\s/]+:)[^@\s]+(@)/gi, "$1[REDACTED]$2");
}

/**
 * Executes a command synchronously and returns its UTF-8 standard output.
 */
function sh(args, options = {}) {
  return execFileSync(args[0], args.slice(1), {
    stdio: [options.input ? "pipe" : "ignore", "pipe", "pipe"],
    encoding: "utf8",
    ...options
  });
}

/**
 * Reads combined stdout and stderr logs from a Docker container without throwing if the container exited.
 */
function readContainerLogs(containerName, tailLines) {
  const args = ["logs"];
  if (typeof tailLines === "number") {
    args.push("--tail", String(tailLines));
  }
  args.push(containerName);
  const result = spawnSync("docker", args, {
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8"
  });
  return `${result.stdout ?? ""}${result.stderr ?? ""}`;
}

/**
 * Resolves after `ms` milliseconds.
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Builds an inline Node script that sends a framed RPC request to a Unix socket and verifies `ok === true`.
 */
function buildSocketProbeScript({ socketPath, requestId, method }) {
  return [
    'const net = require("node:net");',
    `const socket = net.createConnection(${JSON.stringify(socketPath)});`,
    `const payload = Buffer.from(JSON.stringify({ kind: "request", requestId: ${JSON.stringify(requestId)}, method: ${JSON.stringify(method)}, params: {} }), "utf8");`,
    "const frame = Buffer.allocUnsafe(4 + payload.length);",
    "frame.writeUInt32BE(payload.length, 0);",
    "payload.copy(frame, 4);",
    "let buffer = Buffer.alloc(0);",
    'const timeout = setTimeout(() => { console.error("SMOKE-TIMEOUT"); process.exit(1); }, 20000);',
    'socket.on("connect", () => socket.write(frame));',
    'socket.on("data", (chunk) => {',
    "  buffer = Buffer.concat([buffer, chunk]);",
    "  if (buffer.length < 4) return;",
    "  const length = buffer.readUInt32BE(0);",
    "  if (buffer.length < 4 + length) return;",
    '  const value = JSON.parse(buffer.subarray(4, 4 + length).toString("utf8"));',
    `  if (value.kind === "response" && value.requestId === ${JSON.stringify(requestId)}) {`,
    '    if (value.ok !== true) { console.error("SMOKE-ERROR " + JSON.stringify(value.error)); process.exit(1); }',
    '    console.log("SMOKE-OK");',
    "    clearTimeout(timeout);",
    "    socket.end();",
    "    process.exit(0);",
    "  }",
    "});",
    'socket.on("error", (error) => { console.error("SMOKE-SOCKET-ERROR " + error.message); process.exit(1); });'
  ].join("\n");
}

/**
 * Runs the core container smoke check against PostgreSQL, verifying native Temporal bridge loading, migrations, and `/readyz`.
 */
async function runCoreSmoke(image, env) {
  const containerName = "spaceapp-smoke-core";
  const databaseUrl = env.SMOKE_DATABASE_URL ?? defaultDatabaseUrl;
  const timeoutMs = Number(env.SMOKE_TIMEOUT_MS ?? 300_000);
  const port = env.SMOKE_PORT ?? "4911";
  const sessionSecret = randomBytes(32).toString("hex");
  const setupToken = randomBytes(24).toString("hex");
  const secrets = mkdtempSync(join(tmpdir(), "spaceapp-smoke-core-secrets-"));
  try {
    // Verify the trimmed @temporalio/core-bridge native binary loads on this architecture.
    sh([
      "docker",
      "run",
      "--rm",
      "--entrypoint",
      "node",
      image,
      "-e",
      "const { createRequire } = require('node:module'); createRequire('/app/package.json')('@temporalio/core-bridge');"
    ]);

    writeFileSync(join(secrets, "database-url"), databaseUrl);
    writeFileSync(join(secrets, "session-secret"), sessionSecret);
    writeFileSync(join(secrets, "setup-token"), setupToken);
    try {
      sh(["docker", "rm", "-f", containerName]);
    } catch {
      // Container did not exist yet.
    }
    sh([
      "docker",
      "run",
      "-d",
      "--name",
      containerName,
      "--network",
      "host",
      "-v",
      `${secrets}:/run/secrets:ro`,
      "-e",
      "SPACE_RUNTIME_STORE=postgres",
      "-e",
      "SPACE_PUBLIC_DISTRIBUTION=true",
      // Workflows, CLI panes and browser panes are disabled so the check
      // exercises this image (API + web server + migrations), not the other
      // containers the launcher runs beside it.
      "-e",
      "SPACEAPP_WORKFLOWS_ENABLED=false",
      "-e",
      "SPACE_CLI_ENABLED=false",
      "-e",
      "SPACE_BROWSER_SESSIONS_ENABLED=false",
      "-e",
      "SPACE_API_HOST=127.0.0.1",
      "-e",
      "SPACE_API_PORT=4910",
      "-e",
      "SPACE_WEB_HOST=127.0.0.1",
      "-e",
      `SPACE_WEB_PORT=${port}`,
      "-e",
      "SPACE_API_ORIGIN=http://127.0.0.1:4910",
      image
    ]);
    const deadline = Date.now() + timeoutMs;
    let lastError = "no response";
    let lastBody = "";
    while (Date.now() < deadline) {
      await sleep(2_000);
      let ready = false;
      try {
        const response = await fetch(`http://127.0.0.1:${port}/readyz`);
        lastBody = await response.text();
        const body = JSON.parse(lastBody);
        if (response.ok && body.ok === true) {
          ready = true;
        } else {
          lastError = `ok:${body.ok} dependencies:${JSON.stringify(body.dependencies)}`;
        }
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
      if (ready) {
        const logs = readContainerLogs(containerName);
        if (!logs.includes("applied")) {
          throw new Error(
            `Core answered /readyz ok:true, but the migrations did not report applying.\nContainer logs:\n${redactSmokeText(
              logs,
              [databaseUrl, sessionSecret, setupToken]
            )}`
          );
        }
        process.stdout.write("core smoke: @temporalio/core-bridge loaded, /readyz ok:true, migrations applied\n");
        return;
      }
    }
    const logs = redactSmokeText(readContainerLogs(containerName, 80), [databaseUrl, sessionSecret, setupToken]);
    throw new Error(`Core smoke failed: ${lastError}\nLast body: ${lastBody}\nContainer logs:\n${logs}`);
  } finally {
    try {
      sh(["docker", "rm", "-f", containerName]);
    } catch {
      // Best-effort container cleanup.
    }
    rmSync(secrets, { recursive: true, force: true });
  }
}

/**
 * Runs the browser container smoke check, verifying migrations, Browser Host socket health, and headless Chromium startup.
 */
async function runBrowserSmoke(image, env) {
  const containerName = "spaceapp-smoke-browser";
  const databaseUrl = env.SMOKE_DATABASE_URL ?? defaultDatabaseUrl;
  const timeoutMs = Number(env.SMOKE_TIMEOUT_MS ?? 240_000);
  const secrets = mkdtempSync(join(tmpdir(), "spaceapp-smoke-browser-secrets-"));
  const socketDir = mkdtempSync(join(tmpdir(), "spaceapp-smoke-browser-socket-"));
  // The Browser Host runs as the image's spaceapp user (uid 10001); a bind-mounted
  // host directory is owned by whoever runs the smoke, so make it writable.
  chmodSync(socketDir, 0o777);
  try {
    writeFileSync(join(secrets, "database-url"), databaseUrl);
    try {
      sh(["docker", "rm", "-f", containerName]);
    } catch {
      // Container did not exist yet.
    }
    // Migrations first: the Browser Host opens the store when it starts.
    sh([
      "docker",
      "run",
      "--rm",
      "--network",
      "host",
      "-v",
      `${secrets}:/run/secrets:ro`,
      "-e",
      `SPACE_DATABASE_URL=${databaseUrl}`,
      "--entrypoint",
      "node",
      image,
      "packages/db/dist/migrate.js"
    ]);
    sh([
      "docker",
      "run",
      "-d",
      "--name",
      containerName,
      "--network",
      "host",
      "-v",
      `${secrets}:/run/secrets:ro`,
      "-v",
      `${socketDir}:/run/spaceapp-browser`,
      "-e",
      "SPACE_PUBLIC_DISTRIBUTION=true",
      "-e",
      "SPACE_RUNTIME_STORE=postgres",
      "-e",
      "SPACE_ARTIFACT_ROOT=/var/lib/spaceapp/artifacts",
      "-e",
      "SPACE_BROWSER_SESSIONS_ENABLED=true",
      "-e",
      `SPACE_BROWSER_HOST_SOCKET=${browserSocketPath}`,
      "-e",
      "SPACE_BROWSER_SESSIONS_DEFAULT_URL=about:blank",
      image
    ]);
    const deadline = Date.now() + timeoutMs;
    let socketUp = false;
    while (Date.now() < deadline) {
      await sleep(1_000);
      try {
        sh(["docker", "exec", "-u", "spaceapp", containerName, "test", "-S", browserSocketPath]);
        socketUp = true;
        break;
      } catch {
        // Socket is not ready yet.
      }
    }
    if (!socketUp) {
      const logs = redactSmokeText(readContainerLogs(containerName, 60), [databaseUrl]);
      throw new Error(`Browser smoke failed: Browser Host socket did not appear\nContainer logs:\n${logs}`);
    }
    const healthScript = buildSocketProbeScript({
      socketPath: browserSocketPath,
      requestId: "smoke-health",
      method: "health"
    });
    const healthOutput = sh(["docker", "exec", "-u", "spaceapp", "-i", containerName, "node"], {
      input: healthScript
    });
    if (!healthOutput.includes("SMOKE-OK")) {
      throw new Error(`Browser smoke failed: health response was not ok\n${healthOutput}`);
    }
    // Headless Chromium once: proves the shipped browser binary starts in
    // this image as the spaceapp user. Under QEMU user-mode emulation (arm64
    // job on an amd64 runner) Chromium dies during startup with SIGTRAP
    // (crashpad prctl fails), so SMOKE_SKIP_CHROMIUM_LAUNCH=true asserts the
    // binary is present and executable by spaceapp.
    if (env.SMOKE_SKIP_CHROMIUM_LAUNCH === "true") {
      sh(["docker", "exec", "-u", "spaceapp", containerName, "test", "-x", "/usr/bin/chromium"]);
      process.stdout.write(
        "browser smoke: Browser Host healthy; headless Chromium launch skipped under QEMU (binary present and executable at /usr/bin/chromium)\n"
      );
    } else {
      const dom = sh([
        "docker",
        "exec",
        "-u",
        "spaceapp",
        containerName,
        "chromium",
        "--headless=new",
        "--no-sandbox",
        "--disable-gpu",
        "--disable-dev-shm-usage",
        "--dump-dom",
        "about:blank"
      ]);
      if (!dom.includes("<html")) {
        throw new Error(`Browser smoke failed: headless Chromium did not render about:blank\n${dom.slice(0, 400)}`);
      }
      process.stdout.write("browser smoke: Browser Host healthy, headless Chromium rendered about:blank\n");
    }
  } finally {
    try {
      sh(["docker", "rm", "-f", containerName]);
    } catch {
      // Best-effort container cleanup.
    }
    rmSync(secrets, { recursive: true, force: true });
    try {
      rmSync(socketDir, { recursive: true, force: true });
    } catch {
      // Best-effort socket directory cleanup.
    }
  }
}

/**
 * Runs the CLI container smoke check, verifying the CLI Host Unix socket ping and native `node-pty` module loading.
 */
async function runCliSmoke(image, env) {
  const containerName = "spaceapp-smoke-cli";
  const timeoutMs = Number(env.SMOKE_TIMEOUT_MS ?? 120_000);
  const socketDir = mkdtempSync(join(tmpdir(), "spaceapp-smoke-cli-socket-"));
  // The pane host runs as the image's spaceapp user (uid 10001); a bind-mounted
  // host directory is owned by whoever runs the smoke, so make it writable.
  chmodSync(socketDir, 0o777);
  try {
    try {
      sh(["docker", "rm", "-f", containerName]);
    } catch {
      // Container did not exist yet.
    }
    sh(["docker", "run", "-d", "--name", containerName, "-v", `${socketDir}:/run/space-codex-pane-host`, image]);
    const deadline = Date.now() + timeoutMs;
    let socketUp = false;
    while (Date.now() < deadline) {
      await sleep(1_000);
      try {
        sh(["docker", "exec", "-u", "spaceapp", containerName, "test", "-S", cliSocketPath]);
        socketUp = true;
        break;
      } catch {
        // Socket is not ready yet.
      }
    }
    if (!socketUp) {
      const logs = readContainerLogs(containerName, 60);
      throw new Error(`CLI smoke failed: pane host socket did not appear\nContainer logs:\n${logs}`);
    }
    const pingScript = buildSocketProbeScript({
      socketPath: cliSocketPath,
      requestId: "smoke-ping",
      method: "ping"
    });
    const output = sh(["docker", "exec", "-u", "spaceapp", "-i", containerName, "node"], { input: pingScript });
    if (!output.includes("SMOKE-OK")) {
      throw new Error(`CLI smoke failed: ping response was not ok\n${output}`);
    }
    // Verify the compiled Linux node-pty native addon loads in the CLI image.
    sh([
      "docker",
      "exec",
      "-u",
      "spaceapp",
      containerName,
      "node",
      "-e",
      "const { createRequire } = require('node:module'); const pty = createRequire('/app/package.json')('node-pty'); if (typeof pty.spawn !== 'function') process.exit(1);"
    ]);
    process.stdout.write("cli smoke: pane host accepted a framed ping and node-pty loaded\n");
  } finally {
    try {
      sh(["docker", "rm", "-f", containerName]);
    } catch {
      // Best-effort container cleanup.
    }
    try {
      rmSync(socketDir, { recursive: true, force: true });
    } catch {
      // Best-effort socket directory cleanup.
    }
  }
}

/**
 * Dispatches the runtime container smoke check for `--target <core|browser|cli>` and `--image <image>`.
 */
export async function runContainerSmokeCheck(argv = process.argv.slice(2), env = process.env) {
  const { target, image } = parseSmokeArgs(argv);
  if (target === "core") {
    await runCoreSmoke(image, env);
  } else if (target === "browser") {
    await runBrowserSmoke(image, env);
  } else if (target === "cli") {
    await runCliSmoke(image, env);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runContainerSmokeCheck().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${redactSmokeText(message, [process.env.SMOKE_DATABASE_URL])}\n`);
    process.exitCode = 1;
  });
}
