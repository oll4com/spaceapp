#!/usr/bin/env node
/**
 * CI driver for the dev stack (.github/workflows/dev-stack.yml):
 * start `npm run dev:stack` without a TTY, wait for /readyz, complete the
 * owner setup over HTTP, ensure the starter room and its CLI pane exist,
 * then run `reset` and verify nothing is left behind (no container, no
 * volume, no state directory, no supervised process).
 */
import { spawn, execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { buildConfig } from "./dev-stack.mjs";

const execFileAsync = promisify(execFile);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const config = buildConfig();
const webOrigin = `http://127.0.0.1:${config.webPort}`;
const apiOrigin = `http://127.0.0.1:${config.apiPort}`;

function step(message) {
  process.stdout.write(`\n=== ${message}\n`);
}

async function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

async function waitForReadyz(timeoutMs = 300_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${webOrigin}/readyz`);
      const body = await response.json().catch(() => ({}));
      if (body && body.ok === true) return body;
    } catch { /* not up yet */ }
    await sleep(3_000);
  }
  throw new Error(`dev stack did not become ready within ${timeoutMs}ms`);
}

async function main() {
  step("Starting the dev stack (background, no TTY)");
  const stack = spawn("npm", ["run", "dev:stack"], {
    cwd: repoRoot,
    env: process.env,
    shell: process.platform === "win32",
    detached: process.platform !== "win32",
    stdio: "inherit"
  });
  let stackExit = null;
  stack.on("exit", (code) => { stackExit = code; });

  try {
    step("Waiting for /readyz through the web port");
    const ready = await waitForReadyz();
    if (stackExit !== null) throw new Error(`dev stack exited early with code ${stackExit}`);
    process.stdout.write(`readyz: ${JSON.stringify(ready)}\n`);

    step("Completing owner setup over HTTP");
    const setupToken = readFileSync(join(config.secretsDir, "setup-token"), "utf8").trim();
    const claimResponse = await fetch(`${apiOrigin}/api/setup/claim`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        token: setupToken,
        email: "dev-stack-ci@example.com",
        password: "dev-stack-ci-password-1"
      })
    });
    if (!claimResponse.ok) {
      throw new Error(`Owner claim failed: ${claimResponse.status} ${await claimResponse.text()}`);
    }
    const claim = await claimResponse.json();
    const cookie = claimResponse.headers.get("set-cookie");
    if (!cookie) throw new Error("Owner claim did not return a session cookie.");
    const authHeaders = { cookie, "content-type": "application/json" };
    process.stdout.write(`Owner claimed; starter room: ${claim.starterRoomId}\n`);

    step("Ensuring the starter room and its CLI pane");
    const starterResponse = await fetch(`${apiOrigin}/api/setup/starter-room`, {
      method: "POST",
      headers: authHeaders,
      body: "{}"
    });
    if (!starterResponse.ok) {
      throw new Error(`Starter room failed: ${starterResponse.status} ${await starterResponse.text()}`);
    }
    const starter = await starterResponse.json();
    const roomId = starter.room?.id ?? claim.starterRoomId;
    const roomResponse = await fetch(`${apiOrigin}/api/rooms/${roomId}`, { headers: authHeaders });
    if (!roomResponse.ok) {
      throw new Error(`Room fetch failed: ${roomResponse.status} ${await roomResponse.text()}`);
    }
    const room = await roomResponse.json();
    const panes = room.panes ?? room.room?.panes ?? [];
    const cliPane = panes.find((pane) => pane.mode === "TERMINAL" || pane.terminalRuntimeId);
    if (!cliPane) {
      throw new Error(`Starter room ${roomId} has no CLI pane. Panes: ${JSON.stringify(panes).slice(0, 500)}`);
    }
    process.stdout.write(`CLI pane present: ${cliPane.id} (mode ${cliPane.mode ?? "?"}, runtime ${cliPane.terminalRuntimeId ?? "?"})\n`);

    const tasksResponse = await fetch(`${apiOrigin}/api/cli/tasks`, { headers: authHeaders });
    if (!tasksResponse.ok) {
      throw new Error(`CLI tasks endpoint failed: ${tasksResponse.status}`);
    }
    process.stdout.write("CLI host answers through the API.\n");
  } finally {
    step("Resetting the dev stack and verifying nothing is left");
    try { process.kill(process.platform === "win32" ? stack.pid : -stack.pid, "SIGTERM"); } catch { /* already down */ }
    await sleep(2_000);
    const reset = spawn("npm", ["run", "dev:stack", "--", "reset"], {
      cwd: repoRoot, env: process.env, shell: process.platform === "win32", stdio: "inherit"
    });
    await new Promise((resolvePromise) => reset.on("exit", resolvePromise));

    const { stdout: containers } = await execFileAsync("docker", ["ps", "-aq", "--filter", "name=spaceapp-dev"]).catch(() => ({ stdout: "" }));
    if (containers.trim().length > 0) throw new Error(`Containers left behind: ${containers.trim()}`);
    const { stdout: volumes } = await execFileAsync("docker", ["volume", "ls", "-q", "--filter", "name=spaceapp-dev"]).catch(() => ({ stdout: "" }));
    if (volumes.trim().length > 0) throw new Error(`Volumes left behind: ${volumes.trim()}`);
    if (existsSync(config.stateDir)) throw new Error(`State directory left behind: ${config.stateDir}`);
    process.stdout.write("Reset verified: no container, volume, process or state left.\n");
  }
}

main().catch((error) => {
  process.stderr.write(`dev-stack CI failed: ${error.message}\n`);
  process.exit(1);
});
