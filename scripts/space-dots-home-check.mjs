#!/usr/bin/env node
// Space Dots Stage 8 end-to-end check (PLAN clipboard:Aact0Rmpocum, Step 4), run on the operator's request.
//
// It takes a short-lived session from the root-owned auth broker inside this process (never printed or saved),
// creates two temporary WORKSPACE rooms with one Chat pane each, talks to one Dot through the real API and a
// headless Chrome, and deletes both rooms (and restores the Dot's model and permissions) in finally. Output is
// ids, statuses, counts and booleans only: never message, mail or notice text.
//
//   node scripts/space-dots-home-check.mjs [--dot-slot 6] [--skip-approval] [--skip-browser]
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";

const origin = "http://127.0.0.1:4911";
const scratchRoot = "/var/lib/spaceapp-user/agent-workspace/active";
const TURN_TIMEOUT_MS = 360_000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function brokerSession() {
  const broker = spawnSync("/usr/bin/sudo", ["-n", "/opt/spaceapp/bin/space-auth-broker"], {
    input: JSON.stringify({ origin, ttlSeconds: 600, automationScope: "UI_PROOF" }), encoding: "utf8", timeout: 5000, maxBuffer: 8192
  });
  if (broker.status !== 0) throw new Error("The Space auth broker did not issue a session.");
  const auth = JSON.parse(broker.stdout);
  if (auth.ok !== true || auth.cookieName !== "space_session" || typeof auth.cookieValue !== "string") {
    throw new Error("The Space auth broker answered with an invalid session.");
  }
  return { name: auth.cookieName, value: auth.cookieValue };
}

/** The broker's sessions last at most 10 minutes; the check takes a new one after 8 (and a new CSRF token with it). */
export function renewingSession(issue = brokerSession, now = Date.now, maxAgeMs = 480_000) {
  let current = null;
  return () => {
    if (!current || now() - current.issuedAt > maxAgeMs) current = { ...issue(), issuedAt: now() };
    return current;
  };
}

export function createApi(sessionOf, fetchImpl = fetch) {
  const currentSession = typeof sessionOf === "function" ? sessionOf : () => sessionOf;
  let csrf = null;
  let csrfSession = null;
  async function call(method, path, body) {
    const session = currentSession();
    const cookie = `${session.name}=${session.value}`;
    if (csrfSession !== session) { csrf = null; csrfSession = session; }
    const headers = { cookie, origin };
    if (method !== "GET") {
      if (!csrf) {
        const response = await fetchImpl(`${origin}/api/auth/csrf`, { headers: { cookie } });
        if (!response.ok) throw new Error(`The CSRF token request failed (HTTP ${response.status}).`);
        const { csrfToken, headerName } = await response.json();
        csrf = { [headerName]: csrfToken };
      }
      // A DELETE has no body, and a JSON content type without one is refused (400).
      Object.assign(headers, csrf, body === undefined ? {} : { "content-type": "application/json" });
    }
    const response = await fetchImpl(`${origin}${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      const code = typeof payload?.error?.code === "string" ? payload.error.code.slice(0, 80) : "UNKNOWN";
      const error = new Error(`${method} ${path.split("?")[0]} failed (${response.status}, ${code})`);
      error.status = response.status;
      throw error;
    }
    return payload;
  }
  return { get: (path) => call("GET", path), post: (path, body = {}) => call("POST", path, body), patch: (path, body) => call("PATCH", path, body),
    put: (path, body) => call("PUT", path, body), del: (path) => call("DELETE", path) };
}

const enc = encodeURIComponent;
/** Waits until the pane's latest run of this session finished; returns the session. */
async function waitForTurn(api, paneId, previousRunId, timeoutMs = TURN_TIMEOUT_MS) {
  const until = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < until) {
    const session = await api.get(`/api/panes/${enc(paneId)}/agent-session`);
    const run = session.latestRun;
    last = { runStatus: session.runStatus, latestRun: run?.runId === previousRunId ? "PREVIOUS" : run?.status ?? null, pendingRequest: Boolean(session.pendingRequest) };
    if (run && run.runId !== previousRunId && ["COMPLETED", "FAILED", "INTERRUPTED"].includes(run.status) && session.runStatus === "IDLE") return session;
    await sleep(2000);
  }
  throw new Error(`The Dot's turn did not finish in time (${JSON.stringify(last)}).`);
}
async function send(api, paneId, session, content, waitForEnd = true) {
  const before = session.latestRun?.runId ?? null;
  await api.post(`/api/panes/${enc(paneId)}/agent/messages`, { content, sessionId: session.binding.sessionId, ...(session.dotId ? { dotId: session.dotId } : {}) });
  return waitForEnd ? waitForTurn(api, paneId, before) : null;
}
async function feed(api, dotId, roomId) {
  return api.get(`/api/dots/${enc(dotId)}/feed?limit=100&roomId=${enc(roomId)}`);
}

/** A minimal Chrome DevTools Protocol client over the browser's WebSocket (Node's global WebSocket). */
async function startChrome(profileDir) {
  const chrome = spawn("/usr/bin/google-chrome", ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profileDir}`, "--no-first-run",
    "--no-default-browser-check", "--disable-extensions", "--window-size=1440,900", "about:blank"],
  { env: { ...process.env, TMPDIR: "/tmp" }, stdio: "ignore" });
  let endpoint = null;
  for (let i = 0; i < 100 && !endpoint; i++) {
    await sleep(100);
    const lines = (await readFile(join(profileDir, "DevToolsActivePort"), "utf8").catch(() => "")).split("\n");
    if (lines[0] && lines[1]) endpoint = `ws://127.0.0.1:${lines[0].trim()}${lines[1].trim()}`;
  }
  if (!endpoint) { chrome.kill("SIGKILL"); throw new Error("Chrome did not start."); }
  const socket = new WebSocket(endpoint);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = () => reject(new Error("The DevTools connection failed.")); });
  let next = 0;
  const pending = new Map();
  const consoleErrors = [];
  const handlers = new Map();
  socket.onmessage = (event) => {
    const message = JSON.parse(String(event.data));
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id); pending.delete(message.id);
      if (message.error) reject(new Error(`CDP ${message.error.message}`)); else resolve(message.result);
      return;
    }
    if (message.method === "Runtime.exceptionThrown") consoleErrors.push("exception");
    else if (message.method === "Runtime.consoleAPICalled" && message.params?.type === "error") consoleErrors.push("console.error");
    handlers.get(message.method)?.(message.params, message.sessionId);
  };
  const on = (method, handler) => handlers.set(method, handler);
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = ++next; pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  const close = async () => { try { socket.close(); } catch { /* closed */ } chrome.kill("SIGKILL"); await sleep(300); };
  return { send, on, close, consoleErrors };
}

/** The room list the page sees holds only the check's own rooms, so the app can never select or change another room. */
export function scopeRoomList(payload, allowed) {
  if (!payload || !Array.isArray(payload.data)) throw new Error("The room list is invalid.");
  const data = payload.data.filter((room) => allowed.has(room?.id));
  return { ...payload, data, ...(payload.pagination ? { pagination: { ...payload.pagination, totalItems: data.length, totalPages: data.length ? 1 : 0 } } : {}) };
}

async function browserChecks({ api, session, room, rooms, pane, dot, report }) {
  const profileDir = await mkdtemp(join(scratchRoot, "dots-home-check-chrome-"));
  const chrome = await startChrome(profileDir).catch(async (error) => { await rm(profileDir, { recursive: true, force: true }); throw error; });
  try {
    const { targetId } = await chrome.send("Target.createTarget", { url: "about:blank" });
    const { sessionId: sid } = await chrome.send("Target.attachToTarget", { targetId, flatten: true });
    await chrome.send("Runtime.enable", {}, sid);
    await chrome.send("Network.enable", {}, sid);
    const allowed = new Set(rooms);
    let scopeFailures = 0;
    chrome.on("Fetch.requestPaused", async (params, eventSid) => {
      if (eventSid !== sid) return;
      try {
        const url = new URL(params.request.url);
        if (url.pathname !== "/api/rooms" || params.request.method !== "GET" || params.responseStatusCode !== 200) {
          await chrome.send("Fetch.continueRequest", { requestId: params.requestId }, sid);
          return;
        }
        const body = await chrome.send("Fetch.getResponseBody", { requestId: params.requestId }, sid);
        const scoped = scopeRoomList(JSON.parse(body.base64Encoded ? Buffer.from(body.body, "base64").toString("utf8") : body.body), allowed);
        await chrome.send("Fetch.fulfillRequest", { requestId: params.requestId, responseCode: 200, body: Buffer.from(JSON.stringify(scoped)).toString("base64"),
          responseHeaders: [{ name: "Content-Type", value: "application/json" }, { name: "Cache-Control", value: "no-store" }] }, sid);
      } catch {
        scopeFailures += 1;
        await chrome.send("Fetch.failRequest", { requestId: params.requestId, errorReason: "BlockedByClient" }, sid).catch(() => undefined);
      }
    });
    await chrome.send("Fetch.enable", { patterns: [{ urlPattern: `${origin}/api/rooms*`, requestStage: "Response" }] }, sid);
    await chrome.send("Network.setCookie", { name: session.name, value: session.value, domain: "127.0.0.1", path: "/", httpOnly: true, sameSite: "Lax" }, sid);
    await chrome.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }, sid);
    // The test room is selected, and the operator's floating sticky note is hidden in this browser only.
    await chrome.send("Page.addScriptToEvaluateOnNewDocument", { source: `sessionStorage.setItem("space.selectedRoomId", ${JSON.stringify(room)});
      document.addEventListener("DOMContentLoaded", () => { const s = document.createElement("style"); s.textContent = ".sticky-note-window{display:none!important}"; document.head.appendChild(s); });` }, sid);
    await chrome.send("Page.navigate", { url: `${origin}/app` }, sid);
    const evaluate = async (expression) => {
      const result = await chrome.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, sid);
      if (result.exceptionDetails) throw new Error("A browser check failed.");
      return result.result?.value;
    };
    const until = async (expression, label, timeoutMs = 60_000) => {
      const end = Date.now() + timeoutMs;
      while (Date.now() < end) { if (await evaluate(expression).catch(() => false)) return true; await sleep(300); }
      throw new Error(`${label} did not appear.`);
    };
    const paneSelector = JSON.stringify(`[data-space-pane-id="${pane}"]`);
    const callSelector = JSON.stringify(`[data-space-pane-id="${pane}"] button[aria-label="Call ${dot.name}"]`);
    // The Call button must belong to the visible pane of the selected test room before anything is clicked.
    await until(`(() => { const b = document.querySelector(${callSelector}); if (!b) return false; const r = b.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && r.top >= 0 && r.left >= 0 && r.bottom <= innerHeight && r.right <= innerWidth && document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)?.closest("button") === b; })()`,
      "The visible Call button of the test pane");
    const livePanes = async () => (await api.get(`/api/panes?roomId=${enc(room)}`)).data.filter((item) => item.mode === "LIVE" && !item.isClosed);
    // 6. Call opens "<Dot> · Call" bound to that Dot; a second Call brings the same call forward.
    await evaluate(`document.querySelector(${callSelector}).click()`);
    let calls = [];
    for (let i = 0; i < 40 && !calls.length; i++) { await sleep(500); calls = await livePanes(); }
    const boundDot = calls[0] ? await evaluate(`(() => { try { return JSON.parse(localStorage.getItem(${JSON.stringify(`space_live_pane_dot_${calls[0].id}`)}) ?? "null")?.dotId ?? null; } catch { return null; } })()`) : null;
    await evaluate(`document.querySelector(${callSelector})?.click()`);
    await sleep(3000);
    const callsAfterSecond = await livePanes();
    report.call = { opened: calls.length === 1, title: calls[0]?.title === `${dot.name} · Call`, boundToDot: boundDot === dot.dotId,
      secondCallReusedPane: callsAfterSecond.length === 1 && callsAfterSecond[0]?.id === calls[0]?.id };
    report.call.ok = Object.values(report.call).every(Boolean);
    // 7. "Dot settings" opens Settings → Dots at this Dot once; reopening Settings does not replay it.
    await until(`Boolean(document.querySelector(${paneSelector}))`, "The Dot pane");
    await evaluate(`document.querySelector(${paneSelector}).querySelector('.dots-header button[aria-label="More actions"]').click()`);
    await until(`[...document.querySelectorAll('.dots-more-menu button')].some((b) => b.textContent.trim() === "Dot settings")`, "The More actions menu");
    await evaluate(`[...document.querySelectorAll('.dots-more-menu button')].find((b) => b.textContent.trim() === "Dot settings").click()`);
    await until(`Boolean(document.querySelector('section.dots-settings[aria-label="Dots settings"] .dots-part[data-open="true"]'))`, "Settings → Dots");
    const opened = await evaluate(`(() => { const s = document.querySelector('section.dots-settings[aria-label="Dots settings"]');
      const each = [...s.querySelectorAll('.dots-part[data-open="true"]')].length;
      const selected = s.querySelector('[aria-pressed="true"]')?.textContent?.trim() ?? null;
      return { openParts: each, selected }; })()`);
    // Settings is closed with its own control and opened again from the same navigation the user would use.
    const surface = await evaluate(`(() => { const s = document.querySelector('section.dots-settings[aria-label="Dots settings"]');
      const host = s?.closest('[role="dialog"], .side-surface, .workspace-dock-detail, aside, section[aria-label]');
      return host ? (host.getAttribute('aria-label') ?? host.className ?? null) : null; })()`);
    // The user folds the part, closes Settings with its own control and opens it again: the earlier request must not
    // open the part again (whether the dock stays mounted or not).
    await evaluate(`document.querySelector('section.dots-settings[aria-label="Dots settings"] .dots-part[data-open="true"] .dots-part-toggle').click()`);
    await sleep(500);
    const folded = await evaluate(`document.querySelectorAll('section.dots-settings[aria-label="Dots settings"] .dots-part[data-open="true"]').length === 0`);
    const clickLabel = (labels) => evaluate(`(() => { for (const label of ${JSON.stringify(labels)}) {
      const b = [...document.querySelectorAll('button')].find((item) => item.getAttribute('aria-label') === label && item.getClientRects().length);
      if (b) { b.click(); return label; } } return null; })()`);
    const closedWith = await clickLabel(["Close settings dock", "Hide settings", "Close settings"]);
    await sleep(800);
    const closed = await evaluate(`!document.querySelector('section.dots-settings[aria-label="Dots settings"]')?.getClientRects().length`);
    let reopenedWith = await clickLabel(["Show settings", "Open settings"]);
    if (!reopenedWith) {
      // Desktop navigation: the Workspace menu lists the docks by name.
      const menu = await clickLabel(["Show docks", "More workspace actions", "Workspace navigation"]);
      await sleep(500);
      reopenedWith = menu && await evaluate(`(() => { const b = [...document.querySelectorAll('button, [role="menuitem"]')]
        .find((item) => item.textContent.trim() === "Settings" && item.getClientRects().length); if (!b) return null; b.click(); return "Workspace menu"; })()`);
    }
    await sleep(1500);
    const reopened = await evaluate(`(() => { const s = document.querySelector('section.dots-settings[aria-label="Dots settings"]');
      return { settingsVisible: Boolean([...document.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === "Close settings dock" && b.getClientRects().length)),
        dotsMounted: Boolean(s), openParts: s ? s.querySelectorAll('.dots-part[data-open="true"]').length : 0 }; })()`);
    report.settingsDeepLink = { opened: opened.openParts > 0, selectedDot: opened.selected === dot.name, surface: typeof surface === "string" ? surface.slice(0, 80) : null,
      folded, closedWith, closed, reopenedWith: reopenedWith || null, reopenedVisible: reopened.settingsVisible, dotsMountedAfterReopen: reopened.dotsMounted,
      partsOpenAfterReopen: reopened.openParts,
      ok: opened.openParts > 0 && opened.selected === dot.name && folded && closed && Boolean(reopenedWith) && reopened.openParts === 0 };
    report.roomScopeFailures = scopeFailures;
    report.browserConsoleErrors = chrome.consoleErrors.length;
    return { evaluate, until };
  } finally {
    await chrome.close();
    await rm(profileDir, { recursive: true, force: true });
  }
}

export async function run(argv = process.argv.slice(2)) {
  const slot = Number(argv[argv.indexOf("--dot-slot") + 1] || 6);
  const skipApproval = argv.includes("--skip-approval");
  const skipBrowser = argv.includes("--skip-browser");
  const sessionOf = renewingSession();
  const api = createApi(sessionOf);
  const report = { startedAt: new Date().toISOString(), rooms: [], checks: {} };
  // ✎ sends what the pane sends (AgentPane transitionSession): an explicitly new session, keeping the pane's model.
  const newConversation = (paneId, current, dotId) => api.post(`/api/panes/${enc(paneId)}/agent-session`, { ...(dotId ? { dotId } : {}), sessionId: null,
    title: current?.binding?.title ?? "Dots check", threadId: null, selectedModelConfigId: current?.selectedModelConfigId ?? null, selectedToolIds: current?.selectedToolIds ?? [] });
  const created = [];
  let restoreRuntime = null;
  try {
    const dots = [...(await api.get("/api/dots")).dots].sort((a, b) => a.slot - b.slot);
    const settings = (await api.get("/api/dots/settings")).settings;
    const dot = dots.find((item) => item.slot === slot);
    if (!dot) throw new Error("The test Dot was not found.");
    const defaultDot = settings.defaultDotId ?? dots[0].dotId;
    report.dot = { dotId: dot.dotId, slot: dot.slot, isDefault: dot.dotId === defaultDot, confirmExternalActions: settings.confirmExternalActions };
    const stamp = new Date().toISOString().slice(0, 16).replace("T", " ");
    for (const label of ["A", "B"]) {
      const room = await api.post("/api/rooms", { name: `Dots check ${label} · ${stamp}`, initialPaneCount: 0, reason: "Dots Stage 8 end-to-end check (temporary)" });
      created.push(room.id);
      if (room.kind !== "WORKSPACE") throw new Error("A test room is not a WORKSPACE room.");
      const pane = await api.post("/api/panes", { roomId: room.id, title: `Dots check ${label}`, mode: "CHAT" });
      report.rooms.push({ label, roomId: room.id, paneId: pane.id });
    }
    const [A, B] = report.rooms;

    // 5a. A new pane's first conversation opens with the default Dot.
    const firstB = await api.post(`/api/panes/${enc(B.paneId)}/agent-session`, {});
    report.checks.newPaneDefaultDot = { dotId: firstB.dotId ?? null, ok: firstB.dotId === defaultDot };
    // 5b. Later conversations keep the pane's own choice: the user picks the test Dot, then ✎ stays with it.
    const chosen = await api.post(`/api/panes/${enc(B.paneId)}/agent-session`, { dotId: dot.dotId, sessionId: null, title: "Dots check B", threadId: null,
      selectedModelConfigId: firstB.selectedModelConfigId ?? null, selectedToolIds: [] });
    const afterPen = await newConversation(B.paneId, chosen, chosen.dotId);
    // A pane without a Dot cannot exist in an owned room on Postgres: the Stage 1 trigger (0131) gives a session without one the first Dot.
    const withoutDot = await newConversation(B.paneId, afterPen, null);
    const sessionIds = new Set([firstB.binding.sessionId, chosen.binding.sessionId, afterPen.binding.sessionId, withoutDot.binding.sessionId]);
    report.checks.laterConversationKeepsPaneChoice = { chosenDot: chosen.dotId === dot.dotId, afterNewConversation: afterPen.dotId === dot.dotId,
      notDefault: dot.dotId === defaultDot || afterPen.dotId !== defaultDot, newSessions: sessionIds.size === 4,
      sessionWithoutDotGets: withoutDot.dotId === dots[0].dotId ? "FIRST_DOT" : withoutDot.dotId ? "OTHER_DOT" : "NONE",
      ok: chosen.dotId === dot.dotId && afterPen.dotId === dot.dotId && sessionIds.size === 4 };

    // 1. A message to the Dot in room A appears in the same Dot's feed read from room B.
    let sessionA = await api.post(`/api/panes/${enc(A.paneId)}/agent-session`, {});
    sessionA = await newConversation(A.paneId, sessionA, dot.dotId);
    const firstSessionId = sessionA.binding.sessionId;
    sessionA = await send(api, A.paneId, sessionA, "Space Dots end-to-end check (temporary room, deleted afterwards). Reply with exactly: CHECK ONE");
    const fromB = await feed(api, dot.dotId, B.roomId);
    const inA = fromB.items.filter((item) => item.roomId === A.roomId && item.sessionId === firstSessionId);
    report.checks.crossRoomFeed = { scope: fromB.scope, runStatus: sessionA.latestRun?.status,
      userMessage: inA.some((item) => item.author === "USER" && item.kind === "MESSAGE"), dotReply: inA.some((item) => item.author === "DOT" && item.kind === "MESSAGE"),
      ok: fromB.scope === "DOT" && inA.some((item) => item.author === "USER") && inA.some((item) => item.author === "DOT") };

    // 2. ✎ starts a new context; the feed stays continuous and marks where the new conversation starts.
    sessionA = await newConversation(A.paneId, sessionA, dot.dotId);
    const secondSessionId = sessionA.binding.sessionId;
    sessionA = await send(api, A.paneId, sessionA, "Space Dots end-to-end check, second conversation. Reply with exactly: CHECK TWO");
    const afterNew = (await feed(api, dot.dotId, A.roomId)).items;
    const startIndex = afterNew.findIndex((item) => item.sessionId === secondSessionId && item.conversationStart);
    report.checks.newConversation = { newSession: secondSessionId !== firstSessionId, earlierStillShown: afterNew.some((item) => item.sessionId === firstSessionId),
      dividerShown: startIndex > 0 && afterNew[startIndex - 1].sessionId !== secondSessionId,
      ok: secondSessionId !== firstSessionId && afterNew.some((item) => item.sessionId === firstSessionId) && startIndex > 0 && afterNew[startIndex - 1].sessionId !== secondSessionId };

    // 4. A model or permission change in Settings → Dots applies on the next turn.
    const choices = (await api.get("/api/dots/models")).providers.flatMap((provider) => provider.options.map((option) => option.id));
    const currentModel = sessionA.latestRun?.execution?.modelConfigId ?? sessionA.selectedModelConfigId ?? null;
    const otherModel = choices.find((id) => id !== currentModel && id.split("|")[1] === String(currentModel ?? "").split("|")[1])
      ?? choices.find((id) => id !== currentModel) ?? null;
    const currentMode = sessionA.permissionMode ?? null;
    const otherMode = currentMode === "full_access" ? "approve_for_me" : "full_access";
    restoreRuntime = { modelConfigId: dot.preferences.runtime?.modelConfigId ?? null, permissionMode: dot.preferences.runtime?.permissionMode ?? null };
    if (otherModel) {
      await api.patch(`/api/dots/${enc(dot.dotId)}`, { preferences: { ...dot.preferences, runtime: { modelConfigId: otherModel, permissionMode: otherMode } } });
      sessionA = await send(api, A.paneId, sessionA, "Space Dots end-to-end check, after a settings change. Reply with exactly: CHECK THREE");
      report.checks.settingsApplyNextTurn = { modelChanged: sessionA.latestRun?.execution?.modelConfigId === otherModel,
        permissionChanged: sessionA.permissionMode === otherMode, runStatus: sessionA.latestRun?.status,
        ok: sessionA.latestRun?.execution?.modelConfigId === otherModel && sessionA.permissionMode === otherMode };
      await api.patch(`/api/dots/${enc(dot.dotId)}`, { preferences: { ...dot.preferences, runtime: restoreRuntime } });
      restoreRuntime = null;
    } else report.checks.settingsApplyNextTurn = { ok: false, reason: "Only one model is available, so no change can be observed." };

    // 3. An approval shows in the feed as a one-line event (declined here: nothing is created).
    if (!skipApproval) {
      const before = sessionA.latestRun?.runId ?? null;
      await api.post(`/api/panes/${enc(A.paneId)}/agent/messages`, { sessionId: sessionA.binding.sessionId, dotId: dot.dotId,
        content: "Space Dots end-to-end check: create a calendar event in my connected Google calendar with the Space tool calendar.create (find it in your Space tool catalog): title \"Space Dots check - decline me\", tomorrow 10:00 to 10:15 in my time zone. Call the tool now; I will decide the approval in Space. Do not ask me anything first." });
      let approval = null;
      const until = Date.now() + TURN_TIMEOUT_MS;
      while (Date.now() < until && !approval) {
        approval = (await api.get(`/api/dots/${enc(dot.dotId)}/approvals?sessionId=${enc(sessionA.binding.sessionId)}`)).items[0] ?? null;
        if (!approval) {
          const current = await api.get(`/api/panes/${enc(A.paneId)}/agent-session`);
          if (current.latestRun && current.latestRun.runId !== before && current.runStatus === "IDLE" &&
            ["COMPLETED", "FAILED", "INTERRUPTED"].includes(current.latestRun.status)) break;
          await sleep(2000);
        }
      }
      if (approval) {
        // The user decides once the Dot's turn has ended, as in the pane; the state when the approval appeared is recorded.
        const atApproval = await api.get(`/api/panes/${enc(A.paneId)}/agent-session`);
        const runAtApproval = { runStatus: atApproval.runStatus, pendingRequest: Boolean(atApproval.pendingRequest) };
        const asked = await waitForTurn(api, A.paneId, before).catch(() => null);
        const decided = await api.post(`/api/dots/${enc(dot.dotId)}/approvals/${enc(approval.invocationId)}`, { decision: "DECLINE" });
        sessionA = decided.continued ? await waitForTurn(api, A.paneId, asked?.latestRun?.runId ?? null).catch(async () =>
          api.get(`/api/panes/${enc(A.paneId)}/agent-session`)) : await api.get(`/api/panes/${enc(A.paneId)}/agent-session`);
        const events = (await feed(api, dot.dotId, A.roomId)).items.filter((item) => item.kind === "EVENT" && item.origin === "APPROVAL");
        const event = events.at(-1);
        report.checks.approvalEvent = { toolId: approval.toolId, runAtApproval, turnEndedBeforeDecision: Boolean(asked), continued: decided.continued === true, eventShown: Boolean(event),
          oneLine: Boolean(event?.summary && !event.summary.includes("\n")), declinedSummary: Boolean(event?.summary?.startsWith("Declined:")),
          noJson: Boolean(event?.summary && !/[{}]/.test(event.summary)), ok: Boolean(event?.summary?.startsWith("Declined:") && !/[{}\n]/.test(event.summary)) };
      } else {
        const current = await api.get(`/api/panes/${enc(A.paneId)}/agent-session`);
        const calls = (await api.get(`/api/dots/${enc(dot.dotId)}/tool-invocations`)).items
          .filter((item) => item.startedAt >= report.startedAt).map((item) => ({ toolId: item.toolId, status: item.status }));
        report.checks.approvalEvent = { ok: false, reason: "The Dot did not ask for an approval.", runStatus: current.latestRun?.status ?? null, toolCalls: calls };
      }
    }

    // 6 and 7 need the real web app.
    if (!skipBrowser) {
      const browser = {};
      try { await browserChecks({ api, session: sessionOf(), room: A.roomId, rooms: report.rooms.map((item) => item.roomId), pane: A.paneId, dot, report: browser }); }
      catch (error) { browser.error = error instanceof Error ? error.message.slice(0, 200) : "The browser check failed."; }
      // A call this run opened anywhere but the test rooms is closed and reported (it must never happen).
      browser.strayCallsClosed = [];
      for (let page = 1, pages = 1; page <= pages && page <= 20; page += 1) {
        const listed = await api.get(`/api/rooms?page=${page}&pageSize=100`);
        pages = listed.pagination?.totalPages ?? 1;
        for (const room of listed.data.filter((item) => !report.rooms.some((test) => test.roomId === item.id))) {
          for (const stray of (await api.get(`/api/panes?roomId=${enc(room.id)}`)).data.filter((item) => item.mode === "LIVE" && item.title === `${dot.name} · Call`
            && item.createdAt >= report.startedAt)) {
            await api.del(`/api/panes/${enc(stray.id)}`).catch(() => undefined);
            browser.strayCallsClosed.push(stray.id);
          }
        }
      }
      report.checks.browser = browser;
    }
  } catch (error) {
    // A failed step is reported with everything checked before it; cleanup still runs.
    report.error = error instanceof Error ? error.message.slice(0, 300) : "The check failed.";
  } finally {
    if (restoreRuntime) {
      const dot = (await api.get("/api/dots").catch(() => ({ dots: [] }))).dots.find((item) => item.slot === slot);
      if (dot) await api.patch(`/api/dots/${enc(dot.dotId)}`, { preferences: { ...dot.preferences, runtime: restoreRuntime } }).catch(() => undefined);
    }
    report.cleanup = { deleted: [], failed: [] };
    for (const roomId of created) {
      try { await api.del(`/api/rooms/${enc(roomId)}`); report.cleanup.deleted.push(roomId); }
      catch { report.cleanup.failed.push(roomId); }
    }
    report.finishedAt = new Date().toISOString();
  }
  return report;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().then((report) => {
    process.stdout.write(`${JSON.stringify(report, null, 1)}\n`);
    if (report.error || report.cleanup?.failed.length) process.exitCode = 1;
  }, (error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
