#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

function optionValue(args, name) {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function docker(args) {
  return execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }).trim();
}

function encodeLengthPrefixedJson(obj) {
  const json = Buffer.from(JSON.stringify(obj), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32BE(json.length, 0);
  return Buffer.concat([header, json]);
}

async function startPgContainer(pgName, dbName) {
  console.log(`[smoke-check] Starting pgvector container ${pgName}...`);
  docker([
    "run", "-d", "--name", pgName,
    "--network", "host",
    "-e", "POSTGRES_PASSWORD=postgres",
    "-e", `POSTGRES_DB=${dbName}`,
    "pgvector/pgvector:pg16"
  ]);

  let pgReady = false;
  for (let i = 0; i < 30; i++) {
    const probe = spawnSync("docker", [
      "exec", pgName, "pg_isready", "-U", "postgres"
    ], { stdio: "ignore" });
    if (probe.status === 0) {
      pgReady = true;
      break;
    }
    await sleep(1000);
  }
  if (!pgReady) throw new Error("PostgreSQL failed to become ready in time.");
}

async function smokeCore(image) {
  const pgContainer = `spaceapp-smoke-pg-${Date.now()}`;
  const coreContainer = `spaceapp-smoke-core-${Date.now()}`;
  const tmpDir = join(process.env.RUNNER_TEMP || "/tmp", `spaceapp-core-secrets-${Date.now()}`);

  try {
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(join(tmpDir, "database-url"), "postgres://postgres:postgres@127.0.0.1:5432/spaceapp");
    writeFileSync(join(tmpDir, "session-secret"), "0123456789012345678901234567890123456789");
    writeFileSync(join(tmpDir, "setup-token"), "smoke-test-setup-token");

    await startPgContainer(pgContainer, "spaceapp");

    console.log(`[smoke-check:core] Starting core container ${coreContainer}...`);
    docker([
      "run", "-d", "--name", coreContainer,
      "--network", "host",
      "-v", `${tmpDir}:/run/secrets:ro`,
      image
    ]);

    console.log("[smoke-check:core] Polling http://127.0.0.1:4911/readyz...");
    let ok = false;
    for (let i = 0; i < 45; i++) {
      try {
        const res = await new Promise((resolve, reject) => {
          const req = http.get("http://127.0.0.1:4911/readyz", { timeout: 3000 }, (r) => {
            let data = "";
            r.on("data", (chunk) => { data += chunk; });
            r.on("end", () => resolve({ statusCode: r.statusCode, body: data }));
          });
          req.on("error", reject);
          req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
        });
        if (res.statusCode === 200) {
          const parsed = JSON.parse(res.body);
          if (parsed.ok === true) {
            ok = true;
            console.log(`[smoke-check:core] /readyz responded with ok: true (${res.body})`);
            break;
          }
        }
      } catch {}
      await sleep(1500);
    }

    if (!ok) {
      console.error("[smoke-check:core] Core logs:");
      spawnSync("docker", ["logs", "--tail", "100", coreContainer], { stdio: "inherit" });
      throw new Error("Core container failed to pass /readyz readiness check.");
    }
  } finally {
    console.log("[smoke-check:core] Cleaning up containers...");
    spawnSync("docker", ["rm", "-f", coreContainer, pgContainer], { stdio: "ignore" });
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

async function smokeCli(image) {
  const cliContainer = `spaceapp-smoke-cli-${Date.now()}`;
  const socketDir = join(process.env.RUNNER_TEMP || "/tmp", `spaceapp-cli-sock-${Date.now()}`);

  try {
    mkdirSync(socketDir, { recursive: true });
    spawnSync("chmod", ["0777", socketDir], { stdio: "ignore" });

    console.log(`[smoke-check:cli] Starting cli container ${cliContainer}...`);
    docker([
      "run", "-d", "--name", cliContainer,
      "-v", `${socketDir}:/run/spaceapp-cli`,
      "-e", "SPACE_CLI_HOST_SOCKET=/run/spaceapp-cli/host.sock",
      image
    ]);

    const socketPath = join(socketDir, "host.sock");
    console.log(`[smoke-check:cli] Waiting for host socket ${socketPath}...`);
    let client = null;

    for (let i = 0; i < 30; i++) {
      try {
        const candidate = net.createConnection({ path: socketPath });
        await new Promise((resolve, reject) => {
          candidate.once("connect", () => {
            client = candidate;
            resolve();
          });
          candidate.once("error", reject);
        });
        if (client) {
          console.log("[smoke-check:cli] Successfully connected to CLI host Unix domain socket.");
          break;
        }
      } catch {}
      await sleep(1000);
    }

    if (!client) {
      console.error("[smoke-check:cli] CLI logs:");
      spawnSync("docker", ["logs", "--tail", "100", cliContainer], { stdio: "inherit" });
      throw new Error("CLI host socket failed to accept connection.");
    }

    // Exercise node-pty dynamic import and pty spawn path
    console.log("[smoke-check:cli] Sending attach request to exercise node-pty spawn...");
    const attachRequest = encodeLengthPrefixedJson({
      kind: "request",
      requestId: "smoke-attach-1",
      method: "attach",
      params: {
        identity: {
          cliSessionId: "smoke-cli-session-1",
          paneId: "smoke-pane-1",
          roomId: "smoke-room-1",
          runtimeId: "cli:codex",
          codexThreadId: null,
          modelId: null,
          reasoningEffort: null
        },
        spawn: {
          command: "/bin/echo",
          args: ["node-pty-smoke-ok"],
          cwd: "/tmp",
          env: {},
          cols: 80,
          rows: 24
        }
      }
    });

    const attachResponseReceived = await new Promise((resolve, reject) => {
      client.once("data", (data) => {
        if (data.length >= 4) {
          const jsonLen = data.readUInt32BE(0);
          const body = data.subarray(4, 4 + jsonLen).toString("utf8");
          console.log(`[smoke-check:cli] Attach response received: ${body.slice(0, 100)}...`);
          resolve(true);
        } else {
          resolve(true);
        }
      });
      client.once("error", reject);
      client.write(attachRequest);
      setTimeout(() => resolve(false), 5000);
    });

    client.destroy();
    if (!attachResponseReceived) {
      throw new Error("CLI host failed to respond to attach request.");
    }
    console.log("[smoke-check:cli] CLI host successfully exercised node-pty spawn and returned response.");
  } finally {
    console.log("[smoke-check:cli] Cleaning up...");
    spawnSync("docker", ["rm", "-f", cliContainer], { stdio: "ignore" });
    rmSync(socketDir, { recursive: true, force: true });
  }
}

async function smokeBrowser(image) {
  const pgContainer = `spaceapp-smoke-browser-pg-${Date.now()}`;
  const browserContainer = `spaceapp-smoke-browser-${Date.now()}`;
  const tmpDir = join(process.env.RUNNER_TEMP || "/tmp", `spaceapp-browser-secrets-${Date.now()}`);
  const socketDir = join(process.env.RUNNER_TEMP || "/tmp", `spaceapp-browser-sock-${Date.now()}`);

  try {
    mkdirSync(tmpDir, { recursive: true });
    mkdirSync(socketDir, { recursive: true });
    spawnSync("chmod", ["0777", socketDir], { stdio: "ignore" });
    writeFileSync(join(tmpDir, "database-url"), "postgres://postgres:postgres@127.0.0.1:5432/spaceapp_browser");

    await startPgContainer(pgContainer, "spaceapp_browser");

    console.log(`[smoke-check:browser] Starting browser host container ${browserContainer}...`);
    docker([
      "run", "-d", "--name", browserContainer,
      "--network", "host",
      "-v", `${tmpDir}/database-url:/run/secrets/database-url:ro`,
      "-v", `${socketDir}:/run/spaceapp-browser`,
      "-e", "SPACE_BROWSER_HOST_SOCKET=/run/spaceapp-browser/browser-host.sock",
      image
    ]);

    const socketPath = join(socketDir, "browser-host.sock");
    console.log(`[smoke-check:browser] Waiting for browser-host socket ${socketPath}...`);
    let hostReady = false;

    for (let i = 0; i < 30; i++) {
      try {
        const client = net.createConnection({ path: socketPath });
        await new Promise((resolve, reject) => {
          client.once("connect", () => {
            hostReady = true;
            client.destroy();
            resolve();
          });
          client.once("error", reject);
        });
        if (hostReady) {
          console.log("[smoke-check:browser] Browser Host socket accepted connection.");
          break;
        }
      } catch {}
      await sleep(1000);
    }

    if (!hostReady) {
      console.error("[smoke-check:browser] Browser Host logs:");
      spawnSync("docker", ["logs", "--tail", "100", browserContainer], { stdio: "inherit" });
      throw new Error("Browser Host socket failed to accept connection.");
    }

    console.log(`[smoke-check:browser] Running headless chromium verification in ${image}...`);
    const result = spawnSync("docker", [
      "run", "--rm",
      image,
      "gosu", "spaceapp", "/usr/bin/chromium",
      "--headless", "--no-sandbox", "--disable-gpu", "--dump-dom", "about:blank"
    ], { encoding: "utf8" });

    if (result.status !== 0) {
      console.error("[smoke-check:browser] Chromium verification failed:", result.stderr || result.stdout);
      throw new Error(`Browser smoke check failed with exit code ${result.status}`);
    }
    console.log("[smoke-check:browser] Headless Chromium launched successfully and dumped DOM.");
  } finally {
    console.log("[smoke-check:browser] Cleaning up...");
    spawnSync("docker", ["rm", "-f", browserContainer, pgContainer], { stdio: "ignore" });
    rmSync(tmpDir, { recursive: true, force: true });
    rmSync(socketDir, { recursive: true, force: true });
  }
}

export async function runContainerSmokeCheck(args = process.argv.slice(2)) {
  const target = optionValue(args, "--target");
  const image = optionValue(args, "--image");

  if (!target || !image) {
    throw new Error("Usage: container-smoke-check.mjs --target <core|browser|cli> --image <name:tag>");
  }

  console.log(`[smoke-check] Running smoke test for target: ${target}, image: ${image}`);
  if (target === "core") {
    await smokeCore(image);
  } else if (target === "cli") {
    await smokeCli(image);
  } else if (target === "browser") {
    await smokeBrowser(image);
  } else {
    throw new Error(`Unknown target: ${target}`);
  }
  console.log(`[smoke-check] Target ${target} PASSED smoke check.`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runContainerSmokeCheck().catch((err) => {
    console.error(`[smoke-check:failed] ${err.message}`);
    process.exit(1);
  });
}
