#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { resolveDevStackConfig, stopDevStack } from "./dev-stack.mjs";

const config = resolveDevStackConfig();
const API_ORIGIN = `http://127.0.0.1:${config.apiPort}`;

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForReadyz(maxWaitMs = 120000) {
  const start = Date.now();
  console.log(`Waiting for ${API_ORIGIN}/readyz to report ok: true...`);
  while (Date.now() - start < maxWaitMs) {
    try {
      const res = await fetch(`${API_ORIGIN}/readyz`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) {
        const body = await res.json();
        if (body.ok === true) {
          console.log("Readyz check PASSED:", JSON.stringify(body));
          return true;
        }
      }
    } catch {
      // API not up yet
    }
    await sleep(2000);
  }
  throw new Error(`Timed out waiting for ${API_ORIGIN}/readyz`);
}

async function claimOwner(setupToken) {
  console.log("Claiming initial owner account over HTTP...");
  const claimRes = await fetch(`${API_ORIGIN}/api/setup/claim`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      token: setupToken,
      email: "contributor@example.com",
      password: "DevPassword123!456"
    })
  });

  if (!claimRes.ok) {
    const errorText = await claimRes.text();
    throw new Error(`Owner claim failed (${claimRes.status}): ${errorText}`);
  }

  const claimData = await claimRes.json();
  const setCookie = claimRes.headers.get("set-cookie");
  console.log("Owner claimed successfully. User:", claimData.user?.email);
  return { claimData, cookie: setCookie };
}

async function verifyStarterRoomAndCliPane(cookie) {
  console.log("Ensuring starter room and verifying CLI pane...");
  const roomRes = await fetch(`${API_ORIGIN}/api/setup/starter-room`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: cookie || ""
    }
  });

  if (!roomRes.ok) {
    const errorText = await roomRes.text();
    throw new Error(`Starter room request failed (${roomRes.status}): ${errorText}`);
  }

  const roomData = await roomRes.json();
  const roomId = roomData.room.id;
  console.log(`Starter room ensured: "${roomData.room.name}" (${roomId})`);

  // List panes in the room
  const panesRes = await fetch(`${API_ORIGIN}/api/rooms`, {
    headers: { Cookie: cookie || "" }
  });
  if (!panesRes.ok) {
    throw new Error(`Failed to list rooms (${panesRes.status}): ${await panesRes.text()}`);
  }
  const allRooms = await panesRes.json();
  const targetRoom = allRooms.items?.find((r) => r.id === roomId) || roomData.room;

  // Query CLI session for the pane
  // In starter room, there is an OpenCode CLI pane
  const opencodePaneId = targetRoom.panes?.find((p) => p.terminalRuntimeId === "cli:opencode" || p.mode === "TERMINAL")?.id;
  if (!opencodePaneId) {
    console.log("Panes in starter room:", JSON.stringify(targetRoom.panes || []));
    throw new Error(`Expected OpenCode CLI pane in starter room "${roomId}", but none was found.`);
  }

  console.log(`Verifying CLI session on pane ${opencodePaneId}...`);
  const sessionRes = await fetch(`${API_ORIGIN}/api/panes/${encodeURIComponent(opencodePaneId)}/cli/session`, {
    headers: { Cookie: cookie || "" }
  });
  if (!sessionRes.ok) {
    throw new Error(`CLI session request failed (${sessionRes.status}): ${await sessionRes.text()}`);
  }
  console.log(`CLI session verified successfully (${sessionRes.status}).`);
}

async function verifyResetCleanup() {
  console.log("Running dev:stack -- reset to verify full cleanup...");
  await stopDevStack(config, { purge: true });

  if (existsSync(config.stateRoot)) {
    throw new Error(`State root still exists after reset: ${config.stateRoot}`);
  }

  console.log("Reset cleanup verified cleanly!");
}

async function main() {
  let devStackProcess = null;

  try {
    console.log("Starting dev:stack without a TTY...");
    devStackProcess = spawn(process.execPath, [path.join(process.cwd(), "scripts", "dev-stack.mjs")], {
      stdio: "inherit",
      env: process.env
    });

    devStackProcess.on("error", (err) => {
      console.error("Failed to spawn dev-stack process:", err);
    });

    await waitForReadyz(150000);

    // Read setup token
    const tokenFile = path.join(config.secretsDir, "setup-token");
    if (!existsSync(tokenFile)) {
      throw new Error(`Setup token file not found at ${tokenFile}`);
    }
    const setupToken = readFileSync(tokenFile, "utf8").trim();

    const { cookie } = await claimOwner(setupToken);
    await verifyStarterRoomAndCliPane(cookie);

    console.log("All functional gate assertions PASSED!");
  } finally {
    if (devStackProcess) {
      try {
        devStackProcess.kill("SIGTERM");
        await new Promise((resolve) => {
          const timeout = setTimeout(resolve, 10000);
          devStackProcess.once("exit", () => {
            clearTimeout(timeout);
            resolve();
          });
        });
      } catch {}
    }
    await verifyResetCleanup();
  }
}

main().catch((err) => {
  console.error(`\n[FATAL Gate Error] ${err.message}`);
  process.exit(1);
});
