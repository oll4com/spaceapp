#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { resolveDevStackConfig, stopDevStack } from "./dev-stack.mjs";

const config = resolveDevStackConfig();
const API_ORIGIN = `http://127.0.0.1:${config.apiPort}`;

/**
 * Utility promise-based sleep helper.
 *
 * @param {number} ms - Milliseconds to sleep.
 * @returns {Promise<void>}
 */
async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Polls the API /readyz endpoint until it returns HTTP 200 with ok: true.
 *
 * @param {number} [maxWaitMs=150000] - Maximum milliseconds to wait.
 * @returns {Promise<boolean>}
 * @throws {Error} If readiness probe times out.
 */
async function waitForReadyz(maxWaitMs = 150000) {
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

/**
 * Claims the initial owner account using the generated setup token.
 *
 * @param {string} setupToken - Raw token read from secrets/setup-token.
 * @returns {Promise<{ claimData: any, cookie: string | null }>}
 * @throws {Error} If the claim request fails.
 */
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

/**
 * Ensures a starter room exists, verifies an OpenCode CLI pane is active,
 * and asserts that the CLI session endpoint returns a valid session.
 *
 * @param {string | null} cookie - Session cookie from owner claim.
 * @returns {Promise<void>}
 * @throws {Error} If starter room creation, pane query, or CLI session verification fails.
 */
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
    const errorText = await panesRes.text();
    throw new Error(`Failed to list rooms (${panesRes.status}): ${errorText}`);
  }

  const allRooms = await panesRes.json();
  const targetRoom = allRooms.items?.find((r) => r.id === roomId) || roomData.room;

  // Query CLI session for the pane
  // In starter room, locate the OpenCode CLI pane or create one if absent
  let opencodePaneId = targetRoom.panes?.find((p) => p.terminalRuntimeId === "cli:opencode" || p.mode === "TERMINAL")?.id;
  if (!opencodePaneId) {
    console.log("Creating OpenCode CLI pane in room...");
    const createPaneRes = await fetch(`${API_ORIGIN}/api/rooms/${encodeURIComponent(roomId)}/panes`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: cookie || ""
      },
      body: JSON.stringify({
        title: "OpenCode CLI",
        mode: "TERMINAL",
        terminalRuntimeId: "cli:opencode"
      })
    });
    if (createPaneRes.ok) {
      const createdPaneData = await createPaneRes.json();
      opencodePaneId = createdPaneData.pane?.id || createdPaneData.id;
    } else {
      const errText = await createPaneRes.text();
      throw new Error(`OpenCode CLI pane not found and failed to create pane (${createPaneRes.status}): ${errText}`);
    }
  }

  if (!opencodePaneId) {
    throw new Error(`Required OpenCode CLI pane is missing in starter room ${roomId}`);
  }

  console.log(`Verifying CLI session on pane ${opencodePaneId}...`);
  const sessionRes = await fetch(`${API_ORIGIN}/api/panes/${encodeURIComponent(opencodePaneId)}/cli/session`, {
    headers: { Cookie: cookie || "" }
  });
  if (!sessionRes.ok) {
    const errText = await sessionRes.text();
    throw new Error(`CLI session request failed (${sessionRes.status}): ${errText}`);
  }

  const sessionData = await sessionRes.json();
  console.log(`CLI session verified successfully:`, sessionData.session?.id || sessionData.status || sessionRes.status);
}

/**
 * Triggers dev-stack stop and purge, and asserts that the state directory is completely removed.
 *
 * @returns {Promise<void>}
 * @throws {Error} If state root still exists after reset.
 */
async function verifyResetCleanup() {
  console.log("Running dev:stack -- reset to verify full cleanup...");
  await stopDevStack(config, { purge: true });

  if (existsSync(config.stateRoot)) {
    throw new Error(`State root still exists after reset: ${config.stateRoot}`);
  }

  console.log("Reset cleanup verified cleanly!");
}

/**
 * Main CI gate execution flow.
 *
 * @returns {Promise<void>}
 */
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
          const timeout = setTimeout(() => {
            try {
              devStackProcess.kill("SIGKILL");
            } catch {}
            resolve();
          }, 10000);
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
