#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import net from "node:net";
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
          console.log("Readyz check PASSED:", JSON.stringify({
            ok: body.ok,
            store: body.dependencies?.runtimeStore || body.dependencies?.store,
            database: body.dependencies?.database,
            worker: body.dependencies?.worker
          }));
          return true;
        }
      }
    } catch {
      // API not ready yet
    }
    await sleep(2000);
  }
  throw new Error(`Timed out waiting for ${API_ORIGIN}/readyz`);
}

/**
 * Claims the initial owner account using the generated setup token.
 *
 * @param {string} setupToken - Raw token read from secrets/setup-token.
 * @returns {Promise<any>}
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
  console.log("Owner claimed successfully. User:", claimData.user?.email);
  return claimData;
}

/**
 * Authenticates the owner account independently and extracts the session cookie.
 *
 * @param {string} email
 * @param {string} password
 * @returns {Promise<string>} Clean session cookie string (name=value).
 */
async function loginOwner(email, password) {
  console.log("Logging in owner account over HTTP to verify credentials...");
  const loginRes = await fetch(`${API_ORIGIN}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password })
  });

  if (!loginRes.ok) {
    const errorText = await loginRes.text();
    throw new Error(`Owner login failed (${loginRes.status}): ${errorText}`);
  }

  const setCookie = loginRes.headers.get("set-cookie");
  if (!setCookie) {
    throw new Error("Owner login succeeded but set-cookie header was not returned by API.");
  }

  const sessionCookie = setCookie.split(";")[0].trim();
  console.log("Owner login succeeded. Acquired session cookie.");
  return sessionCookie;
}

/**
 * Retrieves the CSRF token and header name for authenticated mutations.
 *
 * @param {string} sessionCookie
 * @returns {Promise<{ csrfToken: string, headerName: string }>}
 */
async function getCsrf(sessionCookie) {
  console.log("Fetching CSRF token from /api/auth/csrf...");
  const csrfRes = await fetch(`${API_ORIGIN}/api/auth/csrf`, {
    headers: { Cookie: sessionCookie }
  });

  if (!csrfRes.ok) {
    const errorText = await csrfRes.text();
    throw new Error(`Failed to fetch CSRF token (${csrfRes.status}): ${errorText}`);
  }

  const csrfData = await csrfRes.json();
  if (!csrfData.csrfToken || !csrfData.headerName) {
    throw new Error(`Invalid CSRF response format: ${JSON.stringify(csrfData)}`);
  }

  console.log(`CSRF token acquired (headerName: "${csrfData.headerName}").`);
  return { csrfToken: csrfData.csrfToken, headerName: csrfData.headerName };
}

/**
 * Ensures a starter room exists, verifies an OpenCode CLI pane is active,
 * and asserts that the CLI session endpoint returns a valid session.
 *
 * @param {string} sessionCookie - Session cookie from owner login.
 * @param {{ csrfToken: string, headerName: string }} csrf - CSRF token credentials.
 * @returns {Promise<void>}
 * @throws {Error} If starter room creation, pane query, or CLI session verification fails.
 */
async function verifyStarterRoomAndCliPane(sessionCookie, csrf) {
  console.log("Ensuring starter room and verifying CLI pane...");
  const roomRes = await fetch(`${API_ORIGIN}/api/setup/starter-room`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: sessionCookie,
      [csrf.headerName]: csrf.csrfToken
    },
    body: JSON.stringify({})
  });

  if (!roomRes.ok) {
    const errorText = await roomRes.text();
    throw new Error(`Starter room request failed (${roomRes.status}): ${errorText}`);
  }

  const roomData = await roomRes.json();
  const roomId = roomData.room.id;
  console.log(`Starter room ensured: "${roomData.room.name}" (${roomId})`);

  // Query Getting Started panes via /api/panes?roomId=...
  const panesRes = await fetch(`${API_ORIGIN}/api/panes?roomId=${encodeURIComponent(roomId)}`, {
    headers: { Cookie: sessionCookie }
  });
  if (!panesRes.ok) {
    const errorText = await panesRes.text();
    throw new Error(`Failed to list panes for room ${roomId} (${panesRes.status}): ${errorText}`);
  }

  const panesJson = await panesRes.json();
  const panesList = Array.isArray(panesJson.data) ? panesJson.data : (Array.isArray(panesJson) ? panesJson : []);

  // Locate Getting Started OpenCode CLI pane
  let opencodePane = panesList.find((p) => p.terminalRuntimeId === "cli:opencode");
  let opencodePaneId = opencodePane?.id;

  if (!opencodePaneId) {
    console.log("OpenCode CLI pane not present in initial room panes, creating pane...");
    const createPaneRes = await fetch(`${API_ORIGIN}/api/rooms/${encodeURIComponent(roomId)}/panes`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: sessionCookie,
        [csrf.headerName]: csrf.csrfToken
      },
      body: JSON.stringify({
        panes: [
          {
            mode: "TERMINAL",
            terminalRuntimeId: "cli:opencode"
          }
        ]
      })
    });
    if (createPaneRes.ok) {
      const createdPaneData = await createPaneRes.json();
      opencodePaneId = createdPaneData.data?.[0]?.id || createdPaneData.pane?.id || createdPaneData.id;
    } else {
      const errText = await createPaneRes.text();
      throw new Error(`OpenCode CLI pane not found and failed to create pane (${createPaneRes.status}): ${errText}`);
    }
  }

  if (!opencodePaneId) {
    throw new Error(`Required OpenCode CLI pane is missing in starter room ${roomId}`);
  }

  console.log(`Starting OpenCode CLI session on pane ${opencodePaneId}...`);
  const startSessionRes = await fetch(`${API_ORIGIN}/api/panes/${encodeURIComponent(opencodePaneId)}/cli/session`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: sessionCookie,
      [csrf.headerName]: csrf.csrfToken
    },
    body: JSON.stringify({
      runtimeId: "cli:opencode"
    })
  });
  if (!startSessionRes.ok) {
    const errText = await startSessionRes.text();
    console.warn(`Initial CLI start returned ${startSessionRes.status}: ${errText}`);
  }

  // Poll CLI session until status is active/running and transport is ready
  let sessionConfirmed = false;
  let lastSessionData = null;
  let activeSession = null;
  for (let attempt = 0; attempt < 15; attempt++) {
    const sessionRes = await fetch(`${API_ORIGIN}/api/panes/${encodeURIComponent(opencodePaneId)}/cli/session`, {
      headers: { Cookie: sessionCookie }
    });
    if (sessionRes.ok) {
      lastSessionData = await sessionRes.json().catch(() => null);
      if (lastSessionData && typeof lastSessionData === "object") {
        const sessionObj = lastSessionData.session || lastSessionData;
        const sessionId = sessionObj.sessionId || sessionObj.id;
        const runtimeId = sessionObj.runtimeId;
        const isActive = sessionObj.isActive;
        const status = sessionObj.status;

        // Strict criteria required by maintainer review:
        // Must verify runtimeId is opencode, session is active, not in error/exited, and websocket token is issued
        const hasValidSession = Boolean(
          sessionId &&
          runtimeId === "cli:opencode" &&
          isActive === true &&
          status !== "EXITED" &&
          status !== "ERROR"
        );

        const hasValidTransport = Boolean(
          lastSessionData.websocket?.token ||
          lastSessionData.websocket?.url ||
          lastSessionData.ticket
        );

        if (hasValidSession && hasValidTransport) {
          activeSession = sessionObj;
          sessionConfirmed = true;
          break;
        }
      }
    }
    await sleep(1000);
  }

  if (!sessionConfirmed || !activeSession) {
    throw new Error(`OpenCode CLI session failed to start or satisfy active transport criteria: ${JSON.stringify(lastSessionData)}`);
  }

  const sessionId = activeSession.sessionId || activeSession.id;
  const status = activeSession.status || "RUNNING";
  console.log(`CLI session verified in API state (id: ${sessionId}, runtime: ${activeSession.runtimeId}, status: ${status}).`);

  // Verify real WebSocket transport and terminal output handshake through Vite proxy
  const wsToken = lastSessionData.websocket?.token;
  if (!wsToken) {
    throw new Error("CLI session response is missing required websocket token/ticket.");
  }

  // Connect through Vite proxy on webPort to verify Vite proxy and CLI terminal transport
  const webOrigin = `http://127.0.0.1:${config.webPort}`;
  const wsOrigin = webOrigin.replace(/^http/, "ws");
  const wsUrl = `${wsOrigin}/api/panes/${encodeURIComponent(opencodePaneId)}/cli/terminal?sessionId=${encodeURIComponent(sessionId)}&token=${encodeURIComponent(wsToken)}`;
  const maskedWsUrl = `${wsOrigin}/api/panes/${encodeURIComponent(opencodePaneId)}/cli/terminal?sessionId=${encodeURIComponent(sessionId)}&token=${encodeURIComponent(wsToken.slice(0, 6))}...`;
  console.log(`Connecting to CLI terminal WebSocket via Vite proxy at ${maskedWsUrl}...`);

  // MUST NOT catch or swallow: must strictly fail the gate on error, timeout, or bad frames
  const wsResult = await verifyCliWebSocketTransport(wsUrl, sessionCookie, {
    expectedRuntimeId: "cli:opencode",
    expectedSessionId: sessionId,
    expectedPaneId: opencodePaneId
  });
  console.log("Live WebSocket terminal transport verified via Vite proxy:", wsResult);
}

/**
 * Connects to the CLI terminal WebSocket endpoint and asserts receipt of
 * valid protocol handshake and live non-empty terminal output frames.
 * Rejects on error frame, fatal session status, non-JSON text, connection error,
 * premature close, or timeout.
 *
 * @param {string} wsUrl - WebSocket URL with sessionId and token.
 * @param {string|null} [cookie] - Session cookie for authenticated connection.
 * @param {number|object} [optionsOrTimeout=10000] - Timeout in milliseconds or options object.
 * @returns {Promise<object>} Parsed valid terminal output frame received.
 */
async function verifyCliWebSocketTransport(wsUrl, cookie, optionsOrTimeout = 10000) {
  const timeoutMs = typeof optionsOrTimeout === "number" ? optionsOrTimeout : (optionsOrTimeout?.timeoutMs ?? 10000);
  const expectedRuntimeId = typeof optionsOrTimeout === "object" ? (optionsOrTimeout.expectedRuntimeId ?? "cli:opencode") : "cli:opencode";
  const expectedSessionId = typeof optionsOrTimeout === "object" ? optionsOrTimeout.expectedSessionId : null;
  const expectedPaneId = typeof optionsOrTimeout === "object" ? optionsOrTimeout.expectedPaneId : null;

  let WebSocketClient = globalThis.WebSocket;
  try {
    const wsMod = await import("ws");
    WebSocketClient = wsMod.default || wsMod;
  } catch {}

  if (!WebSocketClient) {
    throw new Error("No WebSocket client implementation available.");
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    let ws = null;
    let readyReceived = false;
    let terminalOutputReceived = false;

    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        try { ws?.close(); } catch {}
        reject(new Error(`Timeout (${timeoutMs}ms) waiting for live terminal output frame from CLI host (readyReceived: ${readyReceived})`));
      }
    }, timeoutMs);

    const onFail = (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        try { ws?.close(); } catch {}
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    };

    try {
      ws = new WebSocketClient(wsUrl, {
        headers: {
          Cookie: cookie || ""
        }
      });
    } catch (err) {
      clearTimeout(timeout);
      return reject(err);
    }

    const handleFrame = (raw) => {
      if (settled) return;
      let msg;
      try {
        const text = typeof raw === "string" ? raw : (raw?.data ? raw.data.toString() : raw.toString());
        msg = JSON.parse(text);
      } catch {
        return onFail(new Error(`Received unexpected non-JSON frame on terminal websocket: ${String(raw).slice(0, 150)}`));
      }

      if (msg.type === "error" || msg.error) {
        return onFail(new Error(`Terminal websocket reported error frame: ${msg.error || msg.message || JSON.stringify(msg)}`));
      }

      if (msg.type === "status" && (msg.status === "ERROR" || msg.status === "EXITED")) {
        return onFail(new Error(`Terminal websocket reported fatal session status: ${msg.status} (reason: ${msg.statusReason || "none"})`));
      }

      if (msg.type === "ready") {
        if (expectedRuntimeId && msg.runtimeId && msg.runtimeId !== expectedRuntimeId && !msg.runtimeId.includes("opencode")) {
          return onFail(new Error(`Terminal websocket ready frame runtimeId mismatch: expected ${expectedRuntimeId}, got ${msg.runtimeId}`));
        }
        if (expectedSessionId && msg.sessionId && msg.sessionId !== expectedSessionId) {
          return onFail(new Error(`Terminal websocket ready frame sessionId mismatch: expected ${expectedSessionId}, got ${msg.sessionId}`));
        }
        if (expectedPaneId && msg.paneId && msg.paneId !== expectedPaneId) {
          return onFail(new Error(`Terminal websocket ready frame paneId mismatch: expected ${expectedPaneId}, got ${msg.paneId}`));
        }
        readyReceived = true;
        try {
          if (typeof ws.send === "function") {
            ws.send(JSON.stringify({ type: "input", data: "\n" }));
          }
        } catch (err) {
          return onFail(err);
        }
        // Do NOT resolve on ready frame: continue waiting for live terminal output confirming OpenCode UI is active
        return;
      }

      if (
        msg.type === "output" ||
        msg.type === "chunk" ||
        msg.type === "transcript"
      ) {
        const outputData = typeof msg.data === "string" ? msg.data : (typeof msg.text === "string" ? msg.text : "");
        if (outputData.trim().length > 0) {
          terminalOutputReceived = true;
          if (!settled) {
            settled = true;
            clearTimeout(timeout);
            try { ws.close(); } catch {}
            return resolve({ ok: true, frameType: msg.type, output: outputData });
          }
        }
      }
    };

    if (typeof ws.on === "function") {
      ws.on("message", (data) => handleFrame(data));
      ws.on("error", (err) => onFail(err));
      ws.on("close", (code, reason) => {
        if (!settled) {
          if (!terminalOutputReceived) {
            onFail(new Error(`WebSocket closed before receiving non-empty terminal output (code: ${code}, reason: ${reason || "none"})`));
          }
        }
      });
    } else {
      ws.onmessage = (event) => handleFrame(event.data);
      ws.onerror = (event) => onFail(new Error(event?.message || "WebSocket connection error"));
      ws.onclose = (event) => {
        if (!settled) {
          if (!terminalOutputReceived) {
            onFail(new Error(`WebSocket closed before receiving non-empty terminal output (code: ${event.code}, reason: ${event.reason || "none"})`));
          }
        }
      };
    }
  });
}

/**
 * Triggers dev-stack stop and purge, and asserts that the state directory,
 * containers, volumes, and child processes are completely removed.
 *
 * @param {Array<{ name: string, pid: number }>} [preRecordedPids=[]]
 * @returns {Promise<void>}
 * @throws {Error} If cleanup assertions fail.
 */
async function verifyResetCleanup(preRecordedPids = []) {
  console.log("Running dev:stack -- reset to verify full cleanup...");

  // Capture any lingering dev-stack child PIDs from pidfile if available
  const recordedPids = [...preRecordedPids];
  if (existsSync(config.pidFile)) {
    try {
      const pidsObj = JSON.parse(readFileSync(config.pidFile, "utf8"));
      for (const [name, pid] of Object.entries(pidsObj)) {
        if (typeof pid === "number" && !recordedPids.some((p) => p.pid === pid)) {
          recordedPids.push({ name, pid });
        }
      }
    } catch {
      // Ignore read error
    }
  }

  await stopDevStack(config, { purge: true });

  if (existsSync(config.stateRoot)) {
    throw new Error(`State root still exists after reset: ${config.stateRoot}`);
  }

  // Assert all recorded dev-stack child processes have exited
  for (const { name, pid } of recordedPids) {
    let running = false;
    try {
      process.kill(pid, 0);
      running = true;
    } catch {
      running = false;
    }
    if (running) {
      throw new Error(`Dev-stack child process '${name}' (PID ${pid}) is still running after reset`);
    }
  }

  // Assert Compose project has no lingering containers
  const psCheck = spawnSync("docker", ["compose", "-p", config.composeProject, "ps", "-a", "-q"], {
    encoding: "utf8"
  });
  if (psCheck.status !== 0) {
    throw new Error(`Failed to query Docker containers after reset (exit code ${psCheck.status}): ${psCheck.stderr || psCheck.stdout}`);
  }
  if (psCheck.stdout.trim().length > 0) {
    throw new Error(`Compose project containers still exist after reset: ${psCheck.stdout.trim()}`);
  }

  // Assert Compose project has no lingering volumes
  const volCheck = spawnSync("docker", ["volume", "ls", "--filter", `label=com.docker.compose.project=${config.composeProject}`, "-q"], {
    encoding: "utf8"
  });
  if (volCheck.status !== 0) {
    throw new Error(`Failed to query Docker volumes after reset (exit code ${volCheck.status}): ${volCheck.stderr || volCheck.stdout}`);
  }
  if (volCheck.stdout.trim().length > 0) {
    throw new Error(`Compose project volumes still exist after reset: ${volCheck.stdout.trim()}`);
  }

  // Assert managed ports are completely released and no longer listening
  for (const port of [config.apiPort, config.webPort, config.postgresPort, config.temporalPort]) {
    const isBound = await new Promise((resolve) => {
      const s = new net.Socket();
      s.once("connect", () => { s.destroy(); resolve(true); });
      s.once("error", () => { s.destroy(); resolve(false); });
      s.connect(port, "127.0.0.1");
    });
    if (isBound) {
      throw new Error(`Port 127.0.0.1:${port} is still listening after reset`);
    }
  }

  console.log("Reset cleanup verified cleanly (state directory, child processes, containers, volumes, and listeners absent)!");
}

/**
 * Main CI gate execution flow.
 *
 * @returns {Promise<void>}
 */
async function main() {
  let devStackProcess = null;
  let isShuttingDown = false;
  let unexpectedExitError = null;
  const activePids = [];

  try {
    console.log("Starting dev:stack without a TTY...");
    devStackProcess = spawn(process.execPath, [path.join(process.cwd(), "scripts", "dev-stack.mjs")], {
      stdio: "inherit",
      env: process.env
    });

    devStackProcess.on("error", (err) => {
      console.error("Failed to spawn dev-stack process:", err);
      unexpectedExitError = err;
    });

    devStackProcess.on("exit", (code, signal) => {
      if (!isShuttingDown && (code !== 0 || signal)) {
        unexpectedExitError = new Error(`dev:stack process exited unexpectedly with code ${code ?? signal}`);
      }
    });

    await waitForReadyz(150000);
    if (unexpectedExitError) throw unexpectedExitError;

    // Capture live dev-stack child PIDs while stack is actively running
    if (existsSync(config.pidFile)) {
      try {
        const pidsObj = JSON.parse(readFileSync(config.pidFile, "utf8"));
        for (const [name, pid] of Object.entries(pidsObj)) {
          if (typeof pid === "number" && !activePids.some((p) => p.pid === pid)) {
            activePids.push({ name, pid });
          }
        }
      } catch {}
    }

    // Read setup token
    const tokenFile = path.join(config.secretsDir, "setup-token");
    if (!existsSync(tokenFile)) {
      throw new Error(`Setup token file not found at ${tokenFile}`);
    }
    const setupToken = readFileSync(tokenFile, "utf8").trim();

    await claimOwner(setupToken);
    const sessionCookie = await loginOwner("contributor@example.com", "DevPassword123!456");
    const csrf = await getCsrf(sessionCookie);
    await verifyStarterRoomAndCliPane(sessionCookie, csrf);

    if (unexpectedExitError) throw unexpectedExitError;
    console.log("All functional gate assertions PASSED!");
  } finally {
    isShuttingDown = true;
    if (activePids.length === 0 && existsSync(config.pidFile)) {
      try {
        const pidsObj = JSON.parse(readFileSync(config.pidFile, "utf8"));
        for (const [name, pid] of Object.entries(pidsObj)) {
          if (typeof pid === "number" && !activePids.some((p) => p.pid === pid)) {
            activePids.push({ name, pid });
          }
        }
      } catch {}
    }

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
    await verifyResetCleanup(activePids);
    if (unexpectedExitError) throw unexpectedExitError;
  }
}

main().catch((err) => {
  console.error(`\n[FATAL Gate Error] ${err.message}`);
  process.exit(1);
});
