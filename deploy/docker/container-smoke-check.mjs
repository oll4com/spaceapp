#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

function optionValue(args, name) {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

async function startPgContainer(pgName, dbName, netName) {
  console.log(`[smoke-check] Starting pgvector container ${pgName} on network ${netName}...`);
  docker([
    "run", "-d", "--name", pgName,
    "--network", netName,
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
  const unique = `${Date.now()}-${Math.floor(Math.random() * 10000)}`;
  const netName = `spaceapp-smoke-net-${unique}`;
  const pgContainer = `spaceapp-smoke-pg-${unique}`;
  const coreContainer = `spaceapp-smoke-core-${unique}`;
  const tmpDir = join(process.env.RUNNER_TEMP || "/tmp", `spaceapp-core-secrets-${unique}`);

  try {
    docker(["network", "create", netName]);
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(join(tmpDir, "database-url"), `postgres://postgres:postgres@${pgContainer}:5432/spaceapp`);
    writeFileSync(join(tmpDir, "session-secret"), "0123456789012345678901234567890123456789");
    writeFileSync(join(tmpDir, "setup-token"), "smoke-test-setup-token-0123456789abcdef");

    await startPgContainer(pgContainer, "spaceapp", netName);

    console.log(`[smoke-check:core] Starting core container ${coreContainer}...`);
    docker([
      "run", "-d", "--name", coreContainer,
      "--network", netName,
      "-p", "4911:4911",
      "-e", "SPACE_PUBLIC_DISTRIBUTION=true",
      "-e", "SPACE_RUNTIME_STORE=postgres",
      "-e", "SPACEAPP_WORKFLOWS_ENABLED=false",
      "-e", "SPACE_CLI_ENABLED=false",
      "-e", "SPACE_BROWSER_SESSIONS_ENABLED=false",
      "-v", `${tmpDir}:/run/secrets:ro`,
      image
    ]);

    console.log("[smoke-check:core] Polling http://127.0.0.1:4911/readyz...");
    let ok = false;
    for (let i = 0; i < 45; i++) {
      try {
        const res = await new Promise((resolve, reject) => {
          const req = http.get("http://127.0.0.1:4911/readyz", { timeout: 10000 }, (r) => {
            let data = "";
            r.on("data", (chunk) => { data += chunk; });
            r.on("end", () => resolve({ statusCode: r.statusCode, body: data }));
          });
          req.on("error", reject);
        });

        console.log(`[smoke-check:core] Probe result: status=${res.statusCode}, body=${res.body}`);
        if (res.statusCode === 200) {
          const parsed = JSON.parse(res.body);
          if (parsed && parsed.ok === true) {
            console.log("[smoke-check:core] /readyz answered ok: true!");
            ok = true;
            break;
          }
        }
      } catch (err) {
        console.log("[smoke-check:core] Probe exception:", err?.message);
      }
      await sleep(1000);
    }

    if (!ok) {
      console.error("[smoke-check:core] Core logs on failure:");
      spawnSync("docker", ["logs", "--tail", "100", coreContainer], { stdio: "inherit" });
      throw new Error("Core container failed /readyz check");
    }
  } finally {
    console.log("[smoke-check:core] Cleaning up...");
    spawnSync("docker", ["rm", "-f", coreContainer, pgContainer], { stdio: "ignore" });
    spawnSync("docker", ["network", "rm", netName], { stdio: "ignore" });
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

async function smokeCli(image) {
  const unique = `${Date.now()}-${Math.floor(Math.random() * 10000)}`;
  const cliContainer = `spaceapp-smoke-cli-${unique}`;
  const socketDir = join(process.env.RUNNER_TEMP || "/tmp", `spaceapp-cli-sock-${unique}`);

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
      console.error("[smoke-check:cli] CLI logs on failure:");
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

    await new Promise((resolve, reject) => {
      let buffer = Buffer.alloc(0);
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error("Timed out waiting for CLI attach response after 15000ms"));
      }, 15000);

      function cleanup() {
        clearTimeout(timeout);
        client.removeListener("data", onData);
        client.removeListener("error", onError);
      }

      function onError(err) {
        cleanup();
        reject(err);
      }

      function onData(chunk) {
        buffer = Buffer.concat([buffer, chunk]);
        if (buffer.length >= 4) {
          const jsonLen = buffer.readUInt32BE(0);
          if (jsonLen === 0 || jsonLen > 16 * 1024 * 1024) {
            cleanup();
            reject(new Error(`Invalid frame length in CLI attach response: ${jsonLen}`));
            return;
          }
          if (buffer.length >= 4 + jsonLen) {
            cleanup();
            try {
              const bodyStr = buffer.subarray(4, 4 + jsonLen).toString("utf8");
              const parsed = JSON.parse(bodyStr);
              console.log(`[smoke-check:cli] Attach response received: ${JSON.stringify(parsed).slice(0, 100)}`);
              if (parsed && parsed.kind === "response" && parsed.ok === true) {
                resolve(true);
              } else {
                reject(new Error(`CLI attach response indicated failure or invalid schema: ${bodyStr}`));
              }
            } catch (err) {
              reject(err);
            }
          }
        }
      }

      client.on("data", onData);
      client.once("error", onError);
      client.write(attachRequest);
    });

    client.destroy();
    console.log("[smoke-check:cli] CLI smoke check completed successfully.");
  } finally {
    console.log("[smoke-check:cli] Cleaning up...");
    spawnSync("docker", ["rm", "-f", cliContainer], { stdio: "ignore" });
    rmSync(socketDir, { recursive: true, force: true });
  }
}

async function smokeBrowser(image) {
  const unique = `${Date.now()}-${Math.floor(Math.random() * 10000)}`;
  const netName = `spaceapp-smoke-browser-net-${unique}`;
  const pgContainer = `spaceapp-smoke-browser-pg-${unique}`;
  const browserContainer = `spaceapp-smoke-browser-${unique}`;
  const tmpDir = join(process.env.RUNNER_TEMP || "/tmp", `spaceapp-browser-secrets-${unique}`);
  const socketDir = join(process.env.RUNNER_TEMP || "/tmp", `spaceapp-browser-sock-${unique}`);

  try {
    docker(["network", "create", netName]);
    mkdirSync(tmpDir, { recursive: true });
    mkdirSync(socketDir, { recursive: true });
    spawnSync("chmod", ["0777", socketDir], { stdio: "ignore" });
    writeFileSync(join(tmpDir, "database-url"), `postgres://postgres:postgres@${pgContainer}:5432/spaceapp_browser`);

    await startPgContainer(pgContainer, "spaceapp_browser", netName);

    console.log("[smoke-check:browser] Running database migrations on test database...");
    docker([
      "run", "--rm",
      "--entrypoint", "",
      "--network", netName,
      "-e", `SPACE_DATABASE_URL=postgres://postgres:postgres@${pgContainer}:5432/spaceapp_browser`,
      "-e", "SPACE_RUNTIME_STORE=postgres",
      image,
      "gosu", "spaceapp", "node", "packages/db/dist/migrate.js"
    ]);

    console.log(`[smoke-check:browser] Starting browser host container ${browserContainer}...`);
    docker([
      "run", "-d", "--name", browserContainer,
      "--network", netName,
      "-v", `${tmpDir}/database-url:/run/secrets/database-url:ro`,
      "-v", `${socketDir}:/run/spaceapp-browser`,
      "-e", "SPACE_RUNTIME_STORE=postgres",
      "-e", "SPACE_BROWSER_SESSIONS_ENABLED=true",
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
          let buffer = Buffer.alloc(0);
          const timeout = setTimeout(() => {
            client.destroy();
            reject(new Error("Timeout waiting for Browser Host health response"));
          }, 5000);

          client.once("connect", () => {
            client.write(encodeLengthPrefixedJson({
              kind: "request",
              requestId: `smoke-browser-health-${i}`,
              method: "health",
              params: {}
            }));
          });

          client.once("error", (error) => {
            clearTimeout(timeout);
            reject(error);
          });

          client.on("data", (chunk) => {
            buffer = Buffer.concat([buffer, chunk]);
            if (buffer.length < 4) return;
            const jsonLen = buffer.readUInt32BE(0);
            if (jsonLen === 0 || buffer.length < 4 + jsonLen) return;
            try {
              const response = JSON.parse(buffer.subarray(4, 4 + jsonLen).toString("utf8"));
              const health = response?.result;
              if (
                response?.kind !== "response" ||
                response.ok !== true ||
                health?.status?.enabled !== true ||
                typeof health?.capacity?.maxSessions !== "number" ||
                health.capacity.maxSessions < 8 ||
                typeof health?.capacity?.maxLiveWorkloads !== "number" ||
                health.capacity.maxLiveWorkloads < 4
              ) {
                throw new Error(`Browser Host health response is not ready: ${JSON.stringify(response)}`);
              }
              clearTimeout(timeout);
              hostReady = true;
              client.destroy();
              resolve();
            } catch (error) {
              clearTimeout(timeout);
              client.destroy();
              reject(error);
            }
          });
        });
        if (hostReady) {
          console.log("[smoke-check:browser] Browser Host socket accepted connection and confirmed health readiness.");
          break;
        }
      } catch {}
      await sleep(1000);
    }

    if (!hostReady) {
      console.error("[smoke-check:browser] Browser Host logs on failure:");
      spawnSync("docker", ["logs", "--tail", "100", browserContainer], { stdio: "inherit" });
      throw new Error("Browser Host socket failed to accept connection.");
    }

    console.log(`[smoke-check:browser] Running headless chromium verification in ${image}...`);
    const result = spawnSync("docker", [
      "run", "--rm",
      "--entrypoint", "",
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
    spawnSync("docker", ["network", "rm", netName], { stdio: "ignore" });
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

  console.log(`[smoke-check] Executing startup smoke check for target='${target}' image='${image}'...`);
  if (target === "core") {
    await smokeCore(image);
  } else if (target === "cli") {
    await smokeCli(image);
  } else if (target === "browser") {
    await smokeBrowser(image);
  } else {
    throw new Error(`Unknown smoke check target: ${target}`);
  }
  console.log(`[smoke-check] Target '${target}' passed all smoke verification checks!`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  runContainerSmokeCheck().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
