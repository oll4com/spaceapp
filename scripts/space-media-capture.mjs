#!/usr/bin/env node
// Space Media Studio capture engine (skill space-media-studio, PLAN clipboard:ZS8C81sNHXf7).
//
// Screenshots and short videos of SpaceApp for social posts and docs, on stable, dev or the public demo mock, in
// device and social sizes, with a capture-only appearance preview. Every target, size and appearance value comes
// from the allowlists below: no URL, selector, script or output path is accepted from the caller (only the Space
// Control adapter names the artifact directory it made for a video).
//
// The session comes from the root-owned auth broker inside this process and is never printed or saved. A
// MEDIA_CAPTURE (READ_ONLY) session may view the operator's live rooms: terminals attach as observers and the
// capture browser fails every API write. Without that scope only an Agent Proof room may be opened.
//
//   node scripts/space-media-capture.mjs --instance dev --slug launch --room room:abc --viewport desktop,mobile,story
//   node scripts/space-media-capture.mjs --instance mock --slug tour --video scenario.json --viewport desktop
//   node scripts/space-media-capture.mjs --instance stable --slug restart --dock nous --outage calm   (a played API restart, READ_ONLY)
import { childProcessEnv } from "../packages/runtime/dist/child-process-env.js";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import { renderHtml, sleep, startChrome } from "./lib/space-chrome-render.mjs";
import { scopeRoomList } from "./space-dots-home-check.mjs";

export const OUTPUT_ROOT = "/var/lib/spaceapp-user/agent-workspace/active";

export const INSTANCES = {
  stable: { origin: "http://127.0.0.1:4911", cookieName: "space_session" },
  dev: { origin: "http://127.0.0.1:4911:4940", cookieName: "space_session_dev" },
  mock: { origin: "https://spaceapp.dev", path: "/spaceappmock/" }
};

// CSS size, device scale factor and touch: the output is the platform's pixel size.
export const VIEWPORTS = {
  desktop: [1440, 900, 2, false], "desktop-hd": [1920, 1080, 1, false], "desktop-4k": [1920, 1080, 2, false], laptop: [1280, 800, 2, false],
  tablet: [820, 1180, 2, true], narrow: [605, 1000, 2, false], "tablet-landscape": [1180, 820, 2, true], mobile: [390, 844, 3, true], android: [412, 915, 2.625, true],
  og: [1200, 630, 1, false], square: [1080, 1080, 1, false], portrait: [864, 1080, 1.25, false], story: [360, 640, 3, true],
  x: [1280, 720, 1.25, false], linkedin: [1200, 627, 1, false], "ph-gallery": [1270, 760, 1, false], "yt-thumb": [1280, 720, 1, false]
};

export const FRAMES = { og: [1200, 630], square: [1080, 1080], portrait: [1080, 1350], story: [1080, 1920] };

// Dock id → the action label of its Show/Open button (apps/web/src/features/docks/side-surface-meta.ts).
export const DOCKS = {
  rooms: "rooms", notifications: "notifications", "room-agent": "room agent", "shared-chat": "council", media: "media dock",
  streaming: "streaming dock", "source-control": "source control", "agent-files": "Agent Files", clipboard: "clipboard",
  tasks: "tasks", links: "links", settings: "settings dock", health: "health dock", cli: "cli dock", "agent-sessions": "agent session history",
  // Nous, docked or in its full-screen command view (its fixed "Open Nous fullscreen" button, plan clipboard:wr9yNPJwkDrp).
  nous: "nous", "nous-fullscreen": "nous",
  // Nous on its Load tab (plan clipboard:f4SH36t3fJ6c): the dock opens on the tab the capture browser's storage names.
  "nous-load": "nous",
  // Nous on its Quotas tab (plan clipboard:FDitYcI63D9R), the same way.
  "nous-quotas": "nous",
  // Nous on its ADMIN-only Task runs tab (plan clipboard:GA__W4qBxSPR), the same way.
  "nous-task-runs": "nous",
  // Nous on its Goals tab (plan clipboard:ESIzQb7rHGQM: the stable proof of a goal's limit row), the same way.
  "nous-goals": "nous",
  // Nous on its Needs you tab (plan clipboard:32etNsBgtbI- step 4: the cards in the operator's language), the same way.
  "nous-needs-you": "nous",
  // Nous on its Startup programs tab (plan clipboard:17yLAnH5ZpyF), the same way; nous-funding is its alias since the funding tab went (7/11).
  "nous-startup": "nous", "nous-funding": "nous",
  // Nous on its Job applications and Crypto tabs (operator 3/11 22:33 BKK), the same way.
  "nous-jobs": "nous", "nous-crypto": "nous", "nous-marketing": "nous",
  // Nous on its Score tab (plan clipboard:1NF6u6gcCwtj), the same way.
  "nous-score": "nous",
  // Nous on its Requests tab (operator nous_msg:82daac31: the search with a status), the same way.
  "nous-requests": "nous"
};
// The Nous tab each of those docks opens on (the dock's `space.nous.ui.tab`).
const NOUS_TABS = { "nous-load": "load", "nous-quotas": "quotas", "nous-task-runs": "taskRuns", "nous-goals": "goals", "nous-needs-you": "needs", "nous-startup": "startup", "nous-funding": "startup", "nous-jobs": "jobs", "nous-crypto": "crypto", "nous-marketing": "marketing", "nous-score": "score", "nous-requests": "requests" };
// A copilot pane's rail tab (--rail, with --pane), seeded as the rail preference copilot-kit/rail-preference.ts reads: [storage kind, tab].
export const RAIL_TABS = { "monitoring-charts": ["monitoring-copilot", "charts"], "marketing-memory": ["marketing-copilot", "memory"], "app-studio-setup": ["app-studio", "setup"] };

// Settings dock sections by their header title. Account, backup, Git hosts and Telegram are left out: they show credentials.
export const SETTINGS_SECTIONS = {
  appearance: "Appearance", docks: "Docks", panes: "Panes", widgets: "Widgets", notifications: "Notifications", dots: "Dots",
  plugins: "Plugins", "agent-capabilities": "Agent capabilities", "default-provider": "Default provider", "voice-input": "Voice input",
  releases: "Releases", "cli-pane-controls": "CLI pane controls", "date-time": "Date & time", "image-previews": "Image previews",
  "prompt-variables": "Prompt variables", "room-cache": "Room cache", "git-worktrees": "Git worktrees", diagnostics: "Diagnostics",
  "job-copilot": "Job Copilot", "mail-copilot": "Mail Copilot", "marketing-copilot": "Marketing Copilot", "freelance-copilot": "Freelance Copilot", nous: "Nous",
  history: "History"
};

export const HEALTH_SECTIONS = ["overview", "topology", "performance", "processes", "services", "ai", "alerts", "usage",
  // Resources → AI on one Accounts & quotas tab: the engine presses that tab (ACCOUNT_TABS) in the capture browser only.
  "ai-antigravity", "ai-codex", "ai-claude", "ai-api"];
// Accounts & quotas provider tabs by their accessible name (apps/web/src/features/toolbar-metrics/ToolbarMetrics.tsx providerTabs).
const ACCOUNT_TABS = { "ai-antigravity": "Antigravity (Google)", "ai-codex": "Codex", "ai-claude": "Claude", "ai-api": "API Providers" };
// Space Gateway (ADMIN, full screen) tabs by their label (apps/web/src/features/space-gateway/SpaceGatewayDialog.tsx). Accounts,
// API keys and Request logs are left out: they show account e-mails, key prefixes and request details.
export // A pool's supported models list opens only on a click (a <details>): the shot shows it open, as after the operator's click.
const OPEN_POOL_MODELS = (scope) => `(document.querySelector(${JSON.stringify(`${scope} details.gw-pool-models`)})?.setAttribute("open", ""), true)`;
const GATEWAY_TABS = { dashboard: "Dashboard", reports: "Reports", routing: "Routing", compression: "Compression", settings: "Settings" };
export const VIEWS = { app: "/app", help: "/help", benchmark: "/benchmark" };
// Public mock showcase chapters and their step counts (apps/web/src/demo/showcase-controller.ts).
export const MOCK_SCENES = { layouts: 6, docks: 5, rooms: 5, panes: 6 };

export const APPEARANCE = {
  theme: ["uiTheme", ["modern", "classic", "codex", "motion", "aurora", "liquid-glass", "jarvis", "aira"]],
  mode: ["modernAppearance", ["system", "light", "dark"]],
  icons: ["modernIconPack", ["lucide", "material-rounded", "motion", "aurora", "space"]],
  background: ["uiBackground", ["spaceapp", "aurora", "liquid-glass", "jarvis", "aira", "none"]],
  "room-theme": ["roomTheme", ["graphite", "forest", "copper", "steel", "contrast", "motion"]],
  language: ["uiLanguage", ["en", "el"]]
};

const idPattern = /^[a-zA-Z0-9._:-]{8,128}$/;
const MAX_VIDEO_MS = 180_000;

/**
 * --outage (nous_msg:1be51d08): the capture browser plays a Space API restart. While it lasts it answers every /api request and
 * /readyz itself with the web proxy's 503 UPSTREAM_UNAVAILABLE (nothing reaches the server), then lets them through again.
 * calm: until the calm notices show (global banner and Nous dock), then after recovery; red: also until the red error shows (60 s).
 */
export const OUTAGES = { calm: ["during", "after"], red: ["during", "red", "after"] };
export const OUTAGE_BODY = JSON.stringify({ error: { code: "UPSTREAM_UNAVAILABLE", message: "Space API is not reachable from the web server.", requestId: "space-web" } });
const shown = (selector, text) => `[...document.querySelectorAll(${JSON.stringify(selector)})].some((e) => e.getClientRects().length && e.textContent.includes(${JSON.stringify(text)}))`;
export const OUTAGE_PAGE = {
  // Both languages name SpaceApp in the calm text; the red one keeps its code.
  calmBanner: shown(".banner:not(.bad)[role=status]", "SpaceApp"),
  // Docked or full screen (nous-fullscreen covers a maximized pane); only the outage notice names SpaceApp.
  calmDock: shown(".dock-kit-notice.is-info", "SpaceApp"),
  red: shown(".banner.bad[role=alert]", "UPSTREAM_UNAVAILABLE: Space API"),
  anyNotice: `(${shown(".banner", "SpaceApp")} || ${shown(".banner", "UPSTREAM_UNAVAILABLE")} || ${shown(".dock-kit-notice", "SpaceApp")} || ${shown(".dock-kit-notice", "UPSTREAM_UNAVAILABLE")})`
};

function oneOf(value, allowed, label) {
  if (!allowed.includes(value)) throw new Error(`${label} must be one of: ${allowed.join(", ")}.`);
  return value;
}

function intIn(value, min, max, label) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) throw new Error(`${label} must be an integer from ${min} to ${max}.`);
  return number;
}

function parseScene(value) {
  const [chapter, step, extra] = String(value).split(":");
  if (extra !== undefined || !Object.hasOwn(MOCK_SCENES, chapter)) throw new Error(`scene must be <chapter>:<step> with chapter ${Object.keys(MOCK_SCENES).join(", ")}.`);
  return { chapter, step: intIn(step, 0, MOCK_SCENES[chapter] - 1, `scene ${chapter} step`) };
}

/** One page state: a dock, a Settings section, a Health section or a mock scene. */
export function validateStep(raw, instance) {
  const step = {};
  // "none": the app with its dock closed (the capture otherwise opens with the Rooms dock showing).
  if (raw.dock !== undefined) step.dock = oneOf(raw.dock, [...Object.keys(DOCKS), "none"], "dock");
  if (raw.settings !== undefined) step.settings = oneOf(raw.settings, Object.keys(SETTINGS_SECTIONS), "settings");
  if (raw.health !== undefined) step.health = oneOf(raw.health, HEALTH_SECTIONS, "health");
  if (raw.gateway !== undefined) step.gateway = oneOf(raw.gateway, Object.keys(GATEWAY_TABS), "gateway");
  if (raw.scene !== undefined) step.scene = parseScene(raw.scene);
  for (const chip of ["approved", "waiting"]) if (raw[chip] !== undefined) {
    if (step.dock !== "nous-startup" && step.dock !== "nous-funding") throw new Error(`--${chip} needs --dock nous-startup.`);
    if (raw[chip] === true) step[chip] = true;
  }
  // One program opened (details open only on a click: the capture clicks it, as the operator would).
  if (raw.program !== undefined) {
    if (step.dock !== "nous-startup" && step.dock !== "nous-funding") throw new Error("--program needs --dock nous-startup.");
    if (typeof raw.program !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(raw.program)) throw new Error("--program is a program id such as nvidia-inception.");
    step.program = raw.program;
  }
  if (raw["focus-search"] === true) step.focusSearch = true;
  // One key pool account's detail (7/11: its supported models), always cropped to it, so the Accounts list (e-mails, other accounts) stays out.
  if (raw["gateway-account"] !== undefined) {
    if (step.gateway !== undefined || typeof raw["gateway-account"] !== "string" || !/^[A-Za-z0-9][A-Za-z0-9 .()-]{1,39}$/.test(raw["gateway-account"])) {
      throw new Error("--gateway-account is a provider name as the Accounts list shows it (such as \"Jina AI\"), without --gateway.");
    }
    step.gatewayAccount = raw["gateway-account"];
  }
  if (instance === "mock" && (step.dock || step.settings || step.health || step.gateway || step.gatewayAccount || step.focusSearch)) throw new Error("The mock is driven by --scene only.");
  if (instance !== "mock" && step.scene) throw new Error("--scene is only for --instance mock.");
  return step;
}

/** Scenario file for --video: at most 20 steps and 180 seconds. */
export function validateScenario(raw, instance) {
  if (!raw || typeof raw !== "object" || !Array.isArray(raw.steps) || raw.steps.length < 1 || raw.steps.length > 20) {
    throw new Error('A video scenario is {"steps":[...]} with 1 to 20 steps.');
  }
  let total = 0;
  const steps = raw.steps.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Object.keys(entry).some((key) => !["dock", "settings", "health", "gateway", "scene", "dwellMs"].includes(key))) {
      throw new Error(`Scenario step ${index + 1} may hold only dock, settings, health, gateway, scene and dwellMs.`);
    }
    const dwellMs = intIn(entry.dwellMs ?? 3000, 500, 30_000, `Scenario step ${index + 1} dwellMs`);
    total += dwellMs;
    return { ...validateStep(entry, instance), dwellMs };
  });
  if (total > MAX_VIDEO_MS) throw new Error("A video scenario lasts at most 180 seconds.");
  return steps;
}

/** Validates the command line (or the --stdin JSON of the Space Control adapter) into a capture request. */
export function validateInput(raw) {
  const instance = oneOf(raw.instance ?? "stable", Object.keys(INSTANCES), "instance");
  const input = { instance, viewports: [], appearance: {}, masked: raw.unmasked !== true };
  if (!raw.stdin) {
    if (!/^[a-z0-9-]{1,40}$/.test(raw.slug ?? "")) throw new Error("--slug must be 1-40 characters of a-z, 0-9 and -.");
    input.slug = raw.slug;
  }
  input.viewports = String(raw.viewport ?? "desktop").split(",").map((name) => oneOf(name.trim(), Object.keys(VIEWPORTS), "viewport"));
  if (input.viewports.length > 8 || new Set(input.viewports).size !== input.viewports.length) throw new Error("Use at most 8 different viewports.");
  for (const key of ["room", "pane"]) {
    if (raw[key] === undefined) continue;
    if (instance === "mock") throw new Error(`--${key} is not available on the mock.`);
    if (!idPattern.test(raw[key])) throw new Error(`--${key} must be a Space id.`);
    input[key] = raw[key];
  }
  if (input.pane && !input.room) throw new Error("--pane needs its --room.");
  if (raw.rail !== undefined) {
    if (!input.pane) throw new Error("--rail needs --pane.");
    input.rail = oneOf(raw.rail, Object.keys(RAIL_TABS), "rail");
  }
  if (raw.appointments !== undefined) input.appointments = oneOf(raw.appointments, ["week", "month"], "appointments");
  if (raw["appointments-wheel"] !== undefined) {
    if (input.pane || !input.appointments) throw new Error("--appointments-wheel needs --appointments without --pane.");
    input.appointmentsWheel = oneOf(raw["appointments-wheel"], ["next", "prev"], "appointments-wheel");
  }
  if (raw["token-usage"] !== undefined) input.tokenUsage = oneOf(raw["token-usage"], ["day", "week", "month"], "token-usage");
  if (raw["requests-status"] !== undefined) input.requestsStatus = oneOf(raw["requests-status"], ["ALL", "DONE", "ANSWERED", "IN_PROGRESS", "WAITS_FOR_YOU", "NOT_DONE", "NOT_ANSWERED"], "requests-status");
  if (raw["requests-search"] !== undefined) {
    if (typeof raw["requests-search"] !== "string" || raw["requests-search"].length > 200) throw new Error("--requests-search takes at most 200 characters.");
    input.requestsSearch = raw["requests-search"];
  }
  if ((input.requestsStatus || input.requestsSearch) && raw.dock !== "nous-requests") throw new Error("--requests-status and --requests-search need --dock nous-requests.");
  input.view = oneOf(raw.view ?? "app", Object.keys(VIEWS), "view");
  if (instance === "mock" && input.view !== "app") throw new Error("The mock has only the app view.");
  input.step = validateStep(raw, instance);
  if (raw.crop !== undefined) {
    input.crop = oneOf(raw.crop, ["pane", "dock", "rail"], "crop");
    if (input.crop === "pane" && !input.pane) throw new Error("--crop pane needs --pane.");
  }
  for (const [flag, [key, allowed]] of Object.entries(APPEARANCE)) {
    if (raw[flag] !== undefined) input.appearance[key] = oneOf(raw[flag], allowed, flag);
  }
  if (raw.tint !== undefined) input.appearance.liquidGlassTint = intIn(raw.tint, 0, 100, "tint");
  if (raw.zoom !== undefined) input.appearance.uiZoom = intIn(raw.zoom, 50, 200, "zoom");
  // shortcut: the mock keeps its own appearance (showcase uses Motion); add mock storage seeding when a mock theme is needed.
  if (instance === "mock" && (Object.keys(input.appearance).length || raw.unmasked)) throw new Error("The mock keeps its own appearance.");
  input.format = oneOf(raw.format ?? "png", ["png", "jpeg", "webp"], "format");
  if (raw.quality !== undefined) input.quality = intIn(raw.quality, 1, 100, "quality");
  if (raw.maxWidth !== undefined) input.maxWidth = intIn(raw.maxWidth, 320, 3840, "maxWidth");
  if (raw.maxHeight !== undefined) input.maxHeight = intIn(raw.maxHeight, 240, 2160, "maxHeight");
  if (raw.frame !== undefined) {
    input.frame = oneOf(raw.frame, Object.keys(FRAMES), "frame");
    input.headline = String(raw.headline ?? "").slice(0, 120);
    input.subline = String(raw.subline ?? "").slice(0, 200);
  }
  if (raw.fitTerminals !== undefined) {
    // The API resizes the PTYs for the room owner's own space_screenshot; a read-only CLI session never writes.
    if (!raw.stdin || typeof raw.fitTerminals !== "boolean") throw new Error("fitTerminals runs only through Space Control space_screenshot.");
    input.fitTerminals = raw.fitTerminals;
  }
  if (raw.outage !== undefined) {
    if (raw.stdin || instance === "mock" || raw.video !== undefined || raw.frame !== undefined) throw new Error("--outage is a still capture of stable or dev from the command line.");
    input.outage = oneOf(raw.outage, Object.keys(OUTAGES), "outage");
  }
  if (raw.video !== undefined) {
    // The CLI names a scenario file; Space Control sends the scenario inline (never a path).
    if (typeof raw.video !== (raw.stdin ? "object" : "string")) throw new Error(raw.stdin ? "Space Control sends the video scenario inline." : "--video names a scenario file.");
    if (input.crop) throw new Error("A video is not cropped.");
    // shortcut: 60 s stable take with two CLIs typing (2026-10-23): desktop-4k 6.6 fps, 2560x1440 12, desktop-hd 17.7; lift it when 4K holds 24.
    if (input.viewports.includes("desktop-4k")) throw new Error("desktop-4k is for stills: its video records about 7 frames a second; use desktop-hd (about 18).");
    input.video = raw.video;
    input.gif = !raw.stdin && raw.gif === true;
  }
  return input;
}

/** The settings the capture browser sees: the account's own, with the preview and masking on top. */
export function appearancePatch(settings, appearance, masked) {
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) throw new Error("The user settings are invalid.");
  return { ...settings, ...appearance, ...(masked ? { sensitiveDataMasked: true } : {}) };
}

/**
 * Seeds the page's session storage with validated values only: the room, the pane and the open dock. A read-only
 * capture also hides the app's error banner: it reports only the writes the capture itself refused.
 */
export function seedScript({ room, pane, dock, rail, appointments, tokenUsage, requestsStatus, requestsSearch, readOnly = false, outage = false, resourceRail = false }) {
  const lines = ["try {"];
  if (room) lines.push(`sessionStorage.setItem("space.selectedRoomId", ${JSON.stringify(room)});`);
  if (pane) lines.push(`sessionStorage.setItem("space.selectedPaneId", ${JSON.stringify(pane)});`);
  const open = dock !== "none";
  if (dock) lines.push(`sessionStorage.setItem("space.workspace.dock.v1", ${JSON.stringify(JSON.stringify({ surface: open ? dock : "rooms", desktopOpen: open, compactOpen: open }))});`);
  if (pane && RAIL_TABS[rail]) lines.push(`localStorage.setItem(${JSON.stringify(`space:${RAIL_TABS[rail][0]}:rail:${pane}`)}, ${JSON.stringify(JSON.stringify({ width: 520, collapsed: false, tab: RAIL_TABS[rail][1] }))});`);
  // --appointments: an Appointments pane's Week or Month view (its own per-pane preference), which shows done calls the List's Upcoming hides;
  // without --pane, the Nous board's Appointments card (the device-wide `space.nous.ui.<key>`).
  if (["week", "month"].includes(appointments)) lines.push(pane ? `localStorage.setItem(${JSON.stringify(`space.appointments.view:${pane}`)}, ${JSON.stringify(appointments)});`
    : `localStorage.setItem("space.nous.ui.appointments.view", ${JSON.stringify(JSON.stringify(appointments))});`);
  // --token-usage: the Quotas view's Token usage period (a fresh capture browser reads the device-wide `space.nous.ui.<key>`).
  if (["day", "week", "month"].includes(tokenUsage)) lines.push(`localStorage.setItem("space.nous.ui.tokenUsage.period", ${JSON.stringify(JSON.stringify(tokenUsage))});`);
  // --requests-status / --requests-search: the Requests tab's filter and search, device-wide like the period above.
  if (requestsStatus) lines.push(`localStorage.setItem("space.nous.ui.requests.status", ${JSON.stringify(JSON.stringify(requestsStatus))});`);
  if (requestsSearch) lines.push(`localStorage.setItem("space.nous.ui.requests.search", ${JSON.stringify(JSON.stringify(requestsSearch))});`);
  if (NOUS_TABS[dock]) lines.push(`localStorage.setItem("space.nous.ui.tab", ${JSON.stringify(JSON.stringify(dock === "nous-score" ? "conversation" : NOUS_TABS[dock]))});`);
  lines.push("} catch {}");
  // --crop rail: the resource rail is a per-browser switch (useResourceIndicators, off by default); on for this capture browser only.
  if (resourceRail) lines.push(`(() => { const get = Storage.prototype.getItem; Storage.prototype.getItem = function (key) {
    return String(key).startsWith("space.systemHealth.indicators.v1.") ? "true" : get.call(this, key); }; })();`);
  if (room) {
    // A pinned capture never follows the account: its Nous focus and browser handoff requests (replayed or live on the
    // account's event stream, and the in-page focus event) are not for this page (2026-10-23 Demo API takes, report 6477).
    lines.push(`(() => { const ignored = new Set(["NOUS_FOCUS_REQUESTED", "BROWSER_HANDOFF_REQUESTED"]); const add = EventSource.prototype.addEventListener;
  EventSource.prototype.addEventListener = function (type, ...rest) { return ignored.has(type) ? undefined : add.call(this, type, ...rest); };
  window.addEventListener("space:nous-focus", (event) => event.stopImmediatePropagation(), true); })();`);
  }
  // The operator's floating sticky note stays out of every shot, as in space-dots-home-check; a read-only capture also
  // hides the error notices of the writes it refused (Live history is one).
  // An outage capture shows .banner.bad: its red outage error is the shot (the refused writes' errors are transient upstream ones the app hides).
  const hidden = readOnly ? `.sticky-note-window,${outage ? "" : ".banner.bad,"}.live-debug-toast` : ".sticky-note-window";
  lines.push(`document.addEventListener("DOMContentLoaded", () => { const s = document.createElement("style"); s.textContent = "${hidden}{display:none!important}"; document.head.appendChild(s); });`);
  return lines.join("\n");
}

export function outputDir(slug, now = new Date()) {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 13);
  return join(OUTPUT_ROOT, `${stamp}-media-${slug}`);
}

const escapeHtml = (text) => String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

/** A social card: the shot in a framed window over the SpaceApp gradient, with an optional headline (a FRAMES name, or any [width, height]). */
export function frameHtml({ frame, size = FRAMES[frame], imageDataUrl, headline = "", subline = "", colors = null }) {
  const [width, height] = size;
  const tall = height > width;
  // Design's screenshot-frame passes its validated #rrggbb colours: the glows of base.css's .glow; Media Studio's cards keep their own.
  const background = colors ? `radial-gradient(circle at 20% 15%,color-mix(in srgb,${colors.accent} 55%,transparent) 0,transparent 55%),`
    + `radial-gradient(circle at 85% 90%,color-mix(in srgb,${colors.primary} 45%,transparent) 0,transparent 50%),${colors.background}`
    : "radial-gradient(circle at 20% 15%,#3b2a7a 0,transparent 55%),radial-gradient(circle at 85% 90%,#0e5a6e 0,transparent 50%),#0a0d1a";
  return `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;width:${width}px;height:${height}px;overflow:hidden}
body{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:${tall ? 56 : 32}px;box-sizing:border-box;padding:${tall ? "96px 64px" : "48px 64px"};
background:${background};
font-family:Inter,"Segoe UI",system-ui,sans-serif;color:${colors?.text ?? "#f4f6ff"}}
h1{margin:0;font-size:${tall ? 72 : 52}px;line-height:1.08;font-weight:800;text-align:center;letter-spacing:-.02em}
p{margin:0;font-size:${tall ? 34 : 26}px;line-height:1.3;color:${colors ? `color-mix(in srgb,${colors.text} 75%,${colors.background})` : "#b8c0e0"};text-align:center}
.text{display:flex;flex-direction:column;gap:14px;max-width:92%}
.shot{flex:1;min-height:0;display:flex;align-items:center;justify-content:center;width:100%}
.shot img{max-width:100%;max-height:100%;border-radius:${tall ? 36 : 18}px;box-shadow:0 30px 80px rgba(0,0,0,.55),0 0 0 1px rgba(255,255,255,.12)}
</style></head><body>${headline || subline ? `<div class="text">${headline ? `<h1>${escapeHtml(headline)}</h1>` : ""}${subline ? `<p>${escapeHtml(subline)}</p>` : ""}</div>` : ""}
<div class="shot"><img src="${imageDataUrl}" alt=""></div></body></html>`;
}

function brokerSession(origin, scope, spawnImpl = spawnSync) {
  const broker = spawnImpl("/usr/bin/sudo", ["-n", "/opt/spaceapp/bin/space-auth-broker"], {
    env: childProcessEnv(), input: JSON.stringify({ origin, ttlSeconds: 600, automationScope: scope ?? "UI_PROOF" }), encoding: "utf8", timeout: 5000, maxBuffer: 8192
  });
  if (broker.status !== 0) return null;
  const auth = JSON.parse(broker.stdout);
  if (auth.ok !== true || typeof auth.cookieValue !== "string") throw new Error("The Space auth broker answered with an invalid session.");
  return { name: auth.cookieName, value: auth.cookieValue };
}

/**
 * A READ_ONLY session (broker scope MEDIA_CAPTURE) may open any of the operator's rooms. A full session (a broker
 * without that scope) may open only an Agent Proof room, and the page then sees only that room.
 */
export async function acquireSession(input, { issue = brokerSession, fetchImpl = fetch } = {}) {
  const { origin, cookieName } = INSTANCES[input.instance];
  // A Studio room (an Agent Proof room) is shot with a full session even when the read-only scope exists: the page then
  // lists only that room, and its terminals attach as a normal client sized to the shot. A read-only observer keeps each
  // CLI's own terminal width, so Claude Code and Gemini rendered garbled and the Rooms dock listed every room (2026-10-20).
  if (input.room) {
    const full = issue(origin, null);
    if (full && full.name === cookieName && await isAgentProofRoom(origin, full, input.room, fetchImpl)) return { ...full, mode: "studio" };
  }
  const readOnly = issue(origin, "MEDIA_CAPTURE");
  if (readOnly) {
    if (readOnly.name !== cookieName) throw new Error("The Space auth broker answered with another instance's session.");
    return { ...readOnly, mode: "read-only" };
  }
  if (!input.room) throw new Error("This broker has no read-only scope yet: pass --room with an Agent Proof room (the Studio room).");
  throw new Error("Without the read-only scope only an Agent Proof room may be captured.");
}

/** True when a request URL (path or query, encoded or not) names a room other than the Studio room. */
export function foreignRoom(url, room) {
  let text = url;
  try { text = decodeURIComponent(url); } catch { /* keep the raw URL */ }
  return [...text.matchAll(/room:[A-Za-z0-9_-]{6,80}/g)].some(([id]) => id !== room);
}

/**
 * What the capture page may load. A read-only capture never writes and no capture changes the account's settings. A capture
 * of a named room refuses every request naming another room and sees only that room in the room list, whatever its session:
 * the account's own room switches (the operator's browser, a Nous focus) followed a Studio take on 2026-10-20 and a
 * read-only take on 2026-10-23.
 */
export function requestPolicy(method, url, input, mode) {
  const path = new URL(url).pathname;
  const write = method !== "GET" && method !== "HEAD";
  // Appearance reaches the page through /api/auth/me (its settings) and /api/user-settings.
  const settings = /^\/api\/user[-/]settings$/.test(path) || path === "/api/auth/me";
  const block = (write && (mode === "read-only" || /^\/api\/user[-/]settings/.test(path))) || Boolean(input.room && foreignRoom(url, input.room));
  return { block, settings, intercept: !block && !write && (settings || (path === "/api/rooms" && Boolean(input.room))) };
}

const DISPLAYED_ROOM = `document.querySelector('[data-room-runtime-id][data-presentation-state="displayed"]')?.dataset.roomRuntimeId`;
/** Latches the first other room the page ever shows, so a switch that came back still fails the capture. */
export const pinRoomScript = (room) => `(() => { const room = ${JSON.stringify(room)}; window.__spaceCaptureLeftRoom = null;
  setInterval(() => { const shown = ${DISPLAYED_ROOM}; if (shown && shown !== room && !window.__spaceCaptureLeftRoom) window.__spaceCaptureLeftRoom = shown; }, 50);
  return true; })()`;
export const leftRoomScript = (room) => `window.__spaceCaptureLeftRoom || ((shown) => shown && shown !== ${JSON.stringify(room)} ? shown : null)(${DISPLAYED_ROOM}) || null`;

/** Fails closed: never another room's data in a frame. */
async function assertPinned(page, input) {
  if (input.room && input.view === "app" && await page.evaluate(leftRoomScript(input.room))) {
    throw new Error(`The capture page left ${input.room} for another room (the account switched rooms); nothing was recorded.`);
  }
}

async function isAgentProofRoom(origin, session, roomId, fetchImpl) {
  // The room list: /api/proof-rooms/:id refuses a proof room holding other panes than Codex terminals (a Studio set).
  const listed = await fetchImpl(`${origin}/api/rooms?pageSize=100`, { headers: { cookie: `${session.name}=${session.value}` } });
  const rooms = listed.ok ? (await listed.json().catch(() => null))?.data : null;
  return Array.isArray(rooms) && rooms.find((room) => room?.id === roomId)?.kind === "AGENT_PROOF";
}

/** The viewport's device scale, lowered to fit maxWidth/maxHeight. */
function deviceScale(input, viewport) {
  const [width, height, scale] = VIEWPORTS[viewport];
  return Math.min(scale, input.maxWidth ? input.maxWidth / width : scale, input.maxHeight ? input.maxHeight / height : scale);
}

async function openPage(chrome, input, session, viewport) {
  const { origin } = INSTANCES[input.instance];
  const { targetId } = await chrome.send("Target.createTarget", { url: "about:blank" });
  const { sessionId: sid } = await chrome.send("Target.attachToTarget", { targetId, flatten: true });
  await chrome.send("Page.enable", {}, sid);
  await chrome.send("Runtime.enable", {}, sid);
  const [width, height, , touch] = VIEWPORTS[viewport];
  const fit = deviceScale(input, viewport);
  await chrome.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: fit, mobile: touch }, sid);
  await chrome.send("Emulation.setTouchEmulationEnabled", { enabled: touch, ...(touch ? { maxTouchPoints: 5 } : {}) }, sid);
  // A headless page has no focused window, and Space pauses its animations in an unfocused one: shots show the app as the operator sees it.
  await chrome.send("Emulation.setFocusEmulationEnabled", { enabled: true }, sid);
  const blocked = [];
  const outage = { active: false };
  if (session) {
    await chrome.send("Network.enable", {}, sid);
    await chrome.send("Network.setCookie", { name: session.name, value: session.value, url: `${origin}/`, httpOnly: true, secure: origin.startsWith("https:"), sameSite: "Lax" }, sid);
    chrome.on("Fetch.requestPaused", async (params, eventSid) => {
      if (eventSid !== sid) return;
      const { requestId, request, responseStatusCode } = params;
      const path = new URL(request.url).pathname;
      // In read-only mode a running CLI still attaches through GET /api/panes/:id/cli/session; a stopped one is never started.
      const { block, settings, intercept } = requestPolicy(request.method, request.url, input, session.mode);
      try {
        if (responseStatusCode === undefined && outage.active) {
          await chrome.send("Fetch.fulfillRequest", { requestId, responseCode: 503, body: Buffer.from(OUTAGE_BODY).toString("base64"),
            responseHeaders: [{ name: "Content-Type", value: "application/json" }, { name: "Cache-Control", value: "no-store" }] }, sid);
          return;
        }
        if (responseStatusCode === undefined) {
          if (block) {
            blocked.push(`${request.method} ${path}`.slice(0, 120));
            await chrome.send("Fetch.failRequest", { requestId, errorReason: "BlockedByClient" }, sid);
          } else await chrome.send("Fetch.continueRequest", { requestId, ...(intercept ? { interceptResponse: true } : {}) }, sid);
          return;
        }
        if (responseStatusCode !== 200) {
          await chrome.send("Fetch.continueResponse", { requestId }, sid);
          return;
        }
        const body = await chrome.send("Fetch.getResponseBody", { requestId }, sid);
        const json = JSON.parse(body.base64Encoded ? Buffer.from(body.body, "base64").toString("utf8") : body.body);
        const patched = !settings ? scopeRoomList(json, new Set([input.room]))
          : path === "/api/auth/me" ? (json.settings ? { ...json, settings: appearancePatch(json.settings, input.appearance, input.masked) } : json)
            : appearancePatch(json, input.appearance, input.masked);
        await chrome.send("Fetch.fulfillRequest", { requestId, responseCode: 200, body: Buffer.from(JSON.stringify(patched)).toString("base64"),
          responseHeaders: [{ name: "Content-Type", value: "application/json" }, { name: "Cache-Control", value: "no-store" }] }, sid);
      } catch {
        await chrome.send("Fetch.failRequest", { requestId, errorReason: "BlockedByClient" }, sid).catch(() => undefined);
      }
    });
    await chrome.send("Fetch.enable", { patterns: [{ urlPattern: `${origin}/api/*`, requestStage: "Request" },
      ...(input.outage ? [{ urlPattern: `${origin}/readyz*`, requestStage: "Request" }] : [])] }, sid);
    await chrome.send("Page.addScriptToEvaluateOnNewDocument", { source: seedScript({ room: input.room, pane: input.pane, rail: input.rail, appointments: input.appointments, tokenUsage: input.tokenUsage, requestsStatus: input.requestsStatus, requestsSearch: input.requestsSearch, dock: input.step.dock ?? (input.step.settings ? "settings" : undefined), readOnly: session.mode === "read-only", outage: Boolean(input.outage), resourceRail: input.crop === "rail" }) }, sid);
  }
  const evaluate = async (expression) => {
    const result = await chrome.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, sid);
    if (result.exceptionDetails) throw new Error("A page step failed.");
    return result.result?.value;
  };
  const until = async (expression, label, timeoutMs = 45_000) => {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) { if (await evaluate(expression).catch(() => false)) return; await sleep(300); }
    throw new Error(`${label} did not appear.`);
  };
  const mock = input.instance === "mock";
  const scene = input.step.scene || input.scenarioHasScenes;
  const url = mock ? `${origin}${INSTANCES.mock.path}${scene ? "?showcase=1" : ""}` : `${origin}${VIEWS[input.view]}`;
  await chrome.send("Page.navigate", { url }, sid);
  await until(`document.readyState === "complete"`, "The page");
  if (!mock) {
    if (await evaluate(`Boolean(document.querySelector('input[type="password"]'))`)) throw new Error("The page asked for a login: the session was not accepted.");
    await until(`document.documentElement.hasAttribute("data-interface-theme")`, "The Space workspace");
    if (input.room && input.view === "app") {
      await until(`${DISPLAYED_ROOM} === ${JSON.stringify(input.room)}`, "The requested room");
      await evaluate(pinRoomScript(input.room));
    }
  }
  if (input.pane) await until(`Boolean(document.querySelector(${JSON.stringify(`[data-space-pane-id="${input.pane}"]`)}))`, "The pane");
  await evaluate("document.fonts.ready.then(() => true)");
  await sleep(2500);
  return { targetId, sid, evaluate, until, blocked, outage, width, height, scale: fit };
}

/**
 * Opens every goal card that shows a percentage (a goal with a limit), as the operator opens it: its bar and "Limit" row show
 * only on an open card (plan clipboard:ESIzQb7rHGQM). Opening is this browser's own UI state, never an API write.
 */
export async function openLimitedGoals(doc, settleMs = 400) {
  const heads = [...doc.querySelectorAll(".nous-goals .nous-goal-head")].filter((head) => head.querySelector(".nous-goal-percent"));
  for (const head of heads) if (head.getAttribute("aria-expanded") !== "true") head.click();
  await new Promise((resolve) => setTimeout(resolve, settleMs)); // the app renders the opened cards
  // One shot shows the goal above (a head with no percentage), this goal's percentage, bar and Limit row (right under the
  // bar): start at the goal above, and if long goal text still pushes the Limit row past the bottom, bring it to the bottom.
  const card = heads[0]?.closest(".nous-goal");
  const limit = card && [...card.querySelectorAll(".nous-goal-facts dt")].find((dt) => dt.textContent.trim() === "Limit");
  const above = card?.previousElementSibling?.classList?.contains("nous-goal") ? card.previousElementSibling : null;
  (above ?? card)?.scrollIntoView({ block: "start" });
  if (limit && limit.getBoundingClientRect().bottom > (doc.defaultView?.innerHeight ?? Infinity)) limit.scrollIntoView({ block: "end" });
  return heads.length;
}

/** Puts the page into one validated state with the app's own controls. Returns what could not be applied. */
async function applyStep(page, step) {
  const skipped = [];
  const openDock = async (dock) => {
    const label = DOCKS[dock];
    // The toggle is on the room toolbar, or (desktop) inside the "Show docks" menu, which mounts its items when open.
    const opened = await page.evaluate(`(async () => {
      const find = (name) => [...document.querySelectorAll("button[aria-label]")].find((b) => b.getAttribute("aria-label") === name && b.getClientRects().length);
      if (find(${JSON.stringify(`Hide ${label}`)}) || find(${JSON.stringify(`Close ${label}`)})) return true;
      const toggle = () => find(${JSON.stringify(`Show ${label}`)}) || find(${JSON.stringify(`Open ${label}`)});
      const wait = () => new Promise((r) => setTimeout(r, 500));
      if (!toggle()) { find("Show docks")?.click(); await wait(); }
      if (!toggle()) {
        // A phone-size dock covers the room toolbar: close it first.
        [...document.querySelectorAll("aside.side-surface button[aria-label]")].find((b) => /^(Close|Hide) /.test(b.getAttribute("aria-label")) && b.getClientRects().length)?.click();
        await wait();
        if (!toggle()) { find("Show docks")?.click(); await wait(); }
      }
      const button = toggle();
      if (!button) return false;
      button.click();
      return true;
    })()`);
    if (!opened) skipped.push(`dock:${dock}`);
    return opened;
  };
  if (step.dock === "none") {
    // The open dock's own Hide/Close button, as the operator closes it.
    const labels = Object.values(DOCKS).flatMap((label) => [`Hide ${label}`, `Close ${label}`]);
    const closed = await page.evaluate(`(async () => {
      const open = () => [...document.querySelectorAll("button[aria-label]")].find((b) => ${JSON.stringify(labels)}.includes(b.getAttribute("aria-label")) && b.getClientRects().length);
      open()?.click();
      await new Promise((r) => setTimeout(r, 500));
      return !open();
    })()`);
    if (!closed) skipped.push("dock:none");
  } else if (step.dock && await openDock(step.dock) && step.dock === "nous-fullscreen") {
    const full = await page.evaluate(`(async () => {
      for (let i = 0; i < 20; i += 1) {
        const button = [...document.querySelectorAll('button[aria-label="Open Nous fullscreen"]')].find((b) => b.getClientRects().length);
        if (button) { button.click(); return true; }
        await new Promise((r) => setTimeout(r, 250));
      }
      return false;
    })()`);
    if (!full) skipped.push("dock:nous-fullscreen");
    else await new Promise((resolve) => setTimeout(resolve, 2_500));
  }
  if (step.dock === "nous-goals" && !skipped.length) {
    try {
      // Loaded: a card, or the goal loop's line (an empty list has one too).
      await page.until(`Boolean(document.querySelector(".nous-goals .nous-goal, .nous-goals .nous-goals-loop"))`, "The goals", 15_000);
      await page.evaluate(`(${openLimitedGoals})(document)`);
    } catch { skipped.push("dock:nous-goals"); }
  }
  // The programs pages (plan clipboard:17yLAnH5ZpyF): loaded once a program line, the empty page or its error shows. 60 s: the panel's
  // chunk and the list load slowly on a busy server (stable 3/11, load 17-23: three shots of "Loading panel…").
  // The Score tab: loaded once its headline shows, 60 s as the programs pages (stable 3/11, load 32: two shots of "Loading panel…").
  if (step.dock === "nous-score" && !skipped.length) {
    try {
      await page.until(`Boolean(document.querySelector('.nous-dock [aria-label="Nous views"]'))`, "The Nous views", 60_000);
      // Fixed Score acceptance: allow the dock's background prefetch three seconds, then measure the real tab click to its first painted value.
      // The same capture runs against the dev build before and after a Score change; no response fixtures or account settings are written.
      await sleep(3_000);
      page.scoreOpen = await page.evaluate(`new Promise((resolve, reject) => {
        const button = [...document.querySelectorAll('.nous-dock [aria-label="Nous views"] button')]
          .find(b => b.querySelector('.dock-kit-chip-label')?.textContent === 'Score');
        if (!button) { reject(new Error('The Score tab was not available.')); return; }
        let spinnerSeen = false;
        const started = performance.now();
        const observer = new MutationObserver(check);
        const timeout = setTimeout(() => { observer.disconnect(); reject(new Error('The Score did not load within 60 seconds.')); }, 60000);
        function check() {
          spinnerSeen ||= Boolean(document.querySelector('.nous-dock .dock-kit-state.is-loading'));
          if (!document.querySelector('.nous-score .nous-score-value')) return;
          observer.disconnect(); clearTimeout(timeout);
          requestAnimationFrame(() => requestAnimationFrame(() => resolve({ openMs: Math.round((performance.now() - started) * 10) / 10, spinnerSeen,
            tiles: document.querySelectorAll('.nous-score-tile').length })));
        }
        observer.observe(document.querySelector('.nous-dock'), {childList:true,subtree:true});
        button.click(); check();
      })`);
    } catch { skipped.push("dock:nous-score"); }
  }
  // The Quotas tab: loaded once its providers or its empty line show (6/11: every still shot "Loading panel…", it had no wait).
  if (step.dock === "nous-quotas" && !skipped.length) {
    await page.until(`Boolean(document.querySelector('.nous-overview[aria-label="Quotas"] .aiq-footer'))`, "The Quotas", 60_000).catch(() => skipped.push("dock:nous-quotas"));
  }
  if (["nous-startup", "nous-funding", "nous-jobs", "nous-crypto", "nous-marketing"].includes(step.dock) && !skipped.length) {
    try {
      await page.until(`Boolean(document.querySelector(".nous-programs .nous-program, .nous-programs .dock-kit-state:not(.is-loading), .nous-programs [role=alert]"))`, "The programs", 60_000);
    } catch { skipped.push(`dock:${step.dock}`); }
    // The Approved or Waiting status chip pressed, as the operator presses it (this browser's own UI state): All, Approved, In progress, Waiting, ...
    const chip = step.approved ? "approved" : step.waiting ? "waiting" : null;
    if (chip && !skipped.length && !await page.evaluate(`(() => { const b = document.querySelectorAll(".nous-programs [role=group]")[0]?.querySelectorAll("button")[${chip === "approved" ? 1 : 3}];
      if (!b) return false; if (b.getAttribute("aria-pressed") !== "true") b.click(); return true; })()`)) skipped.push(chip);
    if (step.program && !skipped.length) {
      const head = JSON.stringify(`.nous-programs button[aria-controls="nous-program-${step.program}"]`);
      const opened = await page.evaluate(`(() => { const b = document.querySelector(${head}); if (!b) return false; if (b.getAttribute("aria-expanded") !== "true") b.click();
        b.scrollIntoView({ block: "start" }); return true; })()`);
      if (!opened) skipped.push(`program:${step.program}`);
      else await page.until(`Boolean(document.getElementById(${JSON.stringify(`nous-program-${step.program}`)}))`, "The program's details", 10_000)
        .then(() => page.evaluate(OPEN_POOL_MODELS(`#nous-program-${step.program}`))).catch(() => skipped.push(`program:${step.program}`));
    }
  }
  if (step.settings) {
    await openDock("settings");
    const title = SETTINGS_SECTIONS[step.settings];
    const selector = JSON.stringify(`.settings-disclosure button[aria-label="${title}"]`);
    try {
      await page.until(`Boolean(document.querySelector(${selector}))`, "The Settings section", 15_000);
      await page.evaluate(`(() => { const b = document.querySelector(${selector}); if (b.getAttribute("aria-expanded") !== "true") b.click();
        b.closest(".settings-disclosure").scrollIntoView({ block: "start" }); return true; })()`);
      // A section that reads the server first says so ("Checking the providers…", "(checking…)", "Loading…"): shoot what it loads.
      await page.until(`!/checking…|Loading…/i.test(document.querySelector(${selector})?.closest(".settings-disclosure")?.textContent ?? "")`, "The Settings section's data", 30_000)
        .catch(() => skipped.push(`settings:${step.settings}:loading`));
    } catch { skipped.push(`settings:${step.settings}`); }
  }
  if (step.health) await page.evaluate(`window.dispatchEvent(new CustomEvent("space:system-health", { detail: { section: ${JSON.stringify(step.health.replace(/^ai-.*/, "ai"))} } })), true`);
  if (ACCOUNT_TABS[step.health]) {
    // A read-only capture fails the setting's write, so only this page shows the tab.
    const selector = JSON.stringify(`[role="tablist"][aria-label="Account providers"] [role="tab"][aria-label="${ACCOUNT_TABS[step.health]}"]`);
    try {
      await page.until(`Boolean(document.querySelector(${selector}))`, "The Accounts & quotas tab", 15_000);
      await page.evaluate(`(document.querySelector(${selector}).click(), true)`);
    } catch { skipped.push(`health:${step.health}`); }
  }
  if (step.gateway || step.gatewayAccount) {
    // The ADMIN "Space Gateway" action opens it full screen: on the room toolbar, or (toolbar folded into the rail) in the Workspace
    // menu found by its search, as PROVE_PHONE_COVERS opens it. The tab is pressed in the capture browser only.
    const opened = await page.evaluate(`(async () => {
      const wait = () => new Promise((r) => setTimeout(r, 500));
      const find = (selector) => [...document.querySelectorAll(selector)].find((b) => b.getClientRects().length);
      const dialog = () => document.querySelector('[aria-label="Space Gateway"].space-gateway-dialog');
      if (!dialog() && find('.toolbar-actions-scroll button[aria-label="Space Gateway"]')) find('.toolbar-actions-scroll button[aria-label="Space Gateway"]').click();
      else if (!dialog()) {
        (find('.room-toolbar-collapsed button[aria-label="Workspace tools"]') ?? find('button[aria-label="More workspace actions"]') ?? find('.desktop-navigation button[title="Workspace"]'))?.click();
        await wait();
        const input = document.querySelector('.desktop-navigation-menu input[aria-label="Find an action"]');
        if (input) {
          Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, "gateway");
          input.dispatchEvent(new Event("input", { bubbles: true }));
          await wait();
        }
        find('.desktop-navigation-menu button[aria-label="Space Gateway"]')?.click();
      }
      for (let i = 0; i < 60; i += 1) {
        const tab = [...(dialog()?.querySelectorAll('[role="tablist"][aria-label="Space Gateway sections"] [role="tab"]') ?? [])]
          .find((b) => b.textContent.trim() === ${JSON.stringify(step.gatewayAccount ? "Accounts" : GATEWAY_TABS[step.gateway])});
        // The tabs show before the Gateway's status answers; a tab pressed then stays on "Loading Space Gateway…".
        if (tab) { tab.click(); return true; }
        await new Promise((r) => setTimeout(r, 250));
      }
      return false;
    })()`);
    // Shown: the status answered (the dialog may show its tabs before "Loading Space Gateway…"); Routing's point for Space is its
    // provider order, below the account routing.
    const ready = step.gateway === "routing" ? `Boolean(document.querySelector('.space-gateway-dialog [role="group"][aria-label="Provider order"]'))`
      : `/^(?!.*Loading (Space Gateway|report)…)/s.test(document.querySelector('.space-gateway-dialog')?.textContent ?? "Loading Space Gateway…")`;
    try {
      if (!opened) throw new Error("not opened");
      await page.until(ready, "The Space Gateway tab", 30_000);
      if (step.gateway === "routing") await page.evaluate(`(document.querySelector('[role="group"][aria-label="Provider order"]').scrollIntoView({ block: "start" }), true)`);
      if (step.gatewayAccount) {
        const row = `[...document.querySelectorAll('.space-gateway-dialog .gw-list-item')].find((b) => b.querySelector('.space-gateway-note')?.textContent.startsWith(${JSON.stringify(`${step.gatewayAccount} ·`)}))`;
        await page.until(`Boolean(${row})`, "The provider's account", 30_000);
        await page.evaluate(`(${row}.click(), true)`);
        await page.until(`Boolean(document.querySelector('.space-gateway-dialog .gw-detail .gw-pool-models'))`, "The account's supported models", 60_000);
        await page.evaluate(OPEN_POOL_MODELS(".space-gateway-dialog .gw-detail"));
      }
    } catch { skipped.push(step.gatewayAccount ? `gateway-account:${step.gatewayAccount}` : `gateway:${step.gateway}`); }
  }
  if (step.scene) {
    // The showcase controller answers a command from its parent window; a top-level page is its own parent.
    const answer = await page.evaluate(`new Promise((resolve) => {
      const requestId = Date.now();
      const onMessage = (event) => { if (event.data?.type === "space-showcase:event" && event.data.requestId === requestId) { removeEventListener("message", onMessage); resolve(event.data.event === "error" ? "error " + event.data.message : event.data.event); } };
      addEventListener("message", onMessage);
      postMessage({ type: "space-showcase:command", command: "step", scene: ${JSON.stringify(step.scene.chapter)}, step: ${step.scene.step}, requestId }, location.origin);
      setTimeout(() => resolve("timeout"), 20000);
    })`);
    if (answer !== "step") skipped.push(`scene:${step.scene.chapter}:${step.scene.step}:${String(answer).slice(0, 80)}`);
  }
  if (step.dock || step.settings || step.health || step.gateway || step.gatewayAccount || step.scene) await sleep(1200);
  return skipped;
}

/** --focus-search: the first visible search field of the pane (--pane) or the open dock, focused as a click would, and what its focus draws. */
async function focusSearch(chrome, page, input) {
  // A headless page has no focused window: without the emulation :focus and :focus-within never match.
  await chrome.send("Emulation.setFocusEmulationEnabled", { enabled: true }, page.sid);
  const scope = JSON.stringify(input.pane ? `[data-space-pane-id="${input.pane}"]` : "aside.side-surface");
  return page.evaluate(`(async () => {
    const field = [...(document.querySelector(${scope}) ?? document).querySelectorAll('input[type="search"], [role="search"] input, [class*="search"] > input')]
      .find((e) => e.getClientRects().length);
    if (!field) return null;
    field.focus();
    await new Promise((r) => setTimeout(r, 400));
    const look = (e) => { const s = getComputedStyle(e); return { className: String(e.className), outline: s.outlineStyle === "none" ? "none" : s.outlineWidth + " " + s.outlineStyle + " " + s.outlineColor,
      boxShadow: s.boxShadow, border: s.borderTopWidth + " " + s.borderTopStyle + " " + s.borderTopColor }; };
    return { focused: document.activeElement === field, input: look(field), wrapper: look(field.parentElement) };
  })()`);
}

// Each Token usage list's row names, and the rows whose name runs into its value, whose name is cut, or whose bar leaves the row.
export const tokenUsageLayout = `(() => {
  const section = document.querySelector(".nous-token-usage"), box = (e) => e.getBoundingClientRect(), problems = [];
  const lists = [...section.querySelectorAll("ul")].map((ul) => {
    const title = ul.getAttribute("aria-label") ?? ul.previousElementSibling?.textContent ?? "";
    const names = [...ul.children].map((li) => {
      const [name, value] = li.classList.length || li.querySelector(".nous-load-part-label") ? [li.querySelector(".nous-load-part-label"), li.querySelector(".nous-load-part-value")] : [...li.children];
      const bar = li.querySelector(".nous-load-bar"), row = box(li);
      if (name && value && box(name).right > box(value).left && box(name).bottom > box(value).top && box(name).top < box(value).bottom) problems.push({ list: title, name: name.textContent, issue: "name overlaps value" });
      if (name && name.scrollWidth > name.clientWidth + 1) problems.push({ list: title, name: name.textContent, issue: "name clipped" });
      if (bar && (box(bar).left < row.left - 1 || box(bar).right > row.right + 1)) problems.push({ list: title, name: name?.textContent, issue: "bar outside row" });
      return name?.textContent ?? li.textContent;
    });
    return { title, names };
  });
  if (section.scrollWidth > section.clientWidth + 1) problems.push({ issue: "section overflows sideways" });
  return { lists, problems };
})()`;

async function screenshot(chrome, page, input) {
  let clip;
  if (input.crop || input.tokenUsage || input.step?.gatewayAccount) {
    const selector = input.step?.gatewayAccount ? ".space-gateway-dialog .gw-detail" : input.tokenUsage ? ".nous-token-usage" : input.crop === "pane" ? `[data-space-pane-id="${input.pane}"]` : input.crop === "rail" ? ".health-indicator-rail" : "aside.side-surface";
    const rect = await page.evaluate(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) return null; const r = e.getBoundingClientRect();
      return r.width > 0 && r.height > 0 ? { x: r.left, y: r.top, width: r.width, height: r.height } : null; })()`);
    if (!rect) throw new Error(`The ${input.crop} to crop is not visible.`);
    clip = { ...rect, scale: 1 };
  }
  // The rail's AI quota tile in words: its tooltip is a native title, which the browser draws outside the page and no screenshot shows.
  const railQuota = input.crop === "rail" ? await page.evaluate(`(() => { const e = document.querySelector('[data-rail-id="accounts"]'); return e && {
    tag: e.querySelector(".health-indicator-provider-tag")?.textContent ?? null, value: e.querySelector("strong")?.textContent ?? null,
    title: e.getAttribute("title"), ariaLabel: e.getAttribute("aria-label") }; })()`) : null;
  const { data } = await chrome.send("Page.captureScreenshot", { format: input.format, ...(input.quality && input.format !== "png" ? { quality: input.quality } : {}),
    ...(clip ? { clip } : {}), captureBeyondViewport: false }, page.sid);
  return { image: Buffer.from(data, "base64"), clip, railQuota };
}

async function renderFrame(chrome, input, image) {
  const [width, height] = FRAMES[input.frame];
  const html = frameHtml({ frame: input.frame, imageDataUrl: `data:image/${input.format};base64,${image.toString("base64")}`, headline: input.headline, subline: input.subline });
  return (await renderHtml(chrome, { html, width, height })).image;
}

/** Records the scenario from Chrome's screencast and encodes a constant 30 fps H.264 MP4 (and a GIF on request). */
async function recordVideo(chrome, page, input, steps, dir, viewport) {
  const framesDir = await mkdtemp(join(dir, ".frames-"));
  try {
    // Chrome pushes a frame whenever the page changes, at the device scale it was started with (capture() starts it so).
    // Each frame lasts until the next one: its own timestamp spaces them, the last one runs to the end of the recording.
    const frames = [];
    const writes = [];
    chrome.on("Page.screencastFrame", ({ data, metadata, sessionId }, eventSid) => {
      if (eventSid !== page.sid) return;
      void chrome.send("Page.screencastFrameAck", { sessionId }, page.sid).catch(() => undefined);
      const file = join(framesDir, `f${String(frames.length).padStart(5, "0")}.jpg`);
      frames.push({ file, at: metadata.timestamp ?? Date.now() / 1000, arrived: Date.now() / 1000 });
      writes.push(writeFile(file, Buffer.from(data, "base64")));
    });
    const startedAt = Date.now() / 1000;
    await chrome.send("Page.startScreencast", { format: "jpeg", quality: 90, everyNthFrame: 1 }, page.sid);
    const skipped = [];
    try {
      for (const step of steps) {
        skipped.push(...await applyStep(page, step));
        await sleep(step.dwellMs);
      }
    } finally {
      await chrome.send("Page.stopScreencast", {}, page.sid).catch(() => undefined);
      chrome.on("Page.screencastFrame", () => undefined);
      await Promise.all(writes);
    }
    const endedAt = Date.now() / 1000;
    if (!frames.length) throw new Error("The recording captured no frames.");
    await assertPinned(page, input);
    // The real length: opening a dock or section between steps adds to the steps' dwell time.
    const durationMs = Math.round((endedAt - startedAt) * 1000);
    const last = frames.at(-1);
    const list = frames.map((frame, i) => `file '${frame.file}'\nduration ${Math.max(0.001, i + 1 < frames.length ? frames[i + 1].at - frame.at : endedAt - last.arrived).toFixed(3)}`);
    await writeFile(join(framesDir, "list.txt"), `${list.join("\n")}\nfile '${frames.at(-1).file}'\n`);
    const mp4 = join(dir, `video-${viewport}.mp4`);
    ffmpeg(["-f", "concat", "-safe", "0", "-i", join(framesDir, "list.txt"), "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2,fps=30,format=yuv420p",
      "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-movflags", "+faststart", "-an", mp4]);
    const files = [mp4];
    if (input.gif) {
      const gif = join(dir, `video-${viewport}.gif`);
      ffmpeg(["-i", mp4, "-vf", "fps=12,scale='min(960,iw)':-2:flags=lanczos,split[a][b];[a]palettegen[p];[b][p]paletteuse", gif]);
      files.push(gif);
    }
    return { files, skipped, durationMs, frames: frames.length };
  } finally {
    await rm(framesDir, { recursive: true, force: true });
  }
}

function ffmpeg(args) {
  const result = spawnSync("/usr/bin/ffmpeg", ["-y", "-loglevel", "error", ...args], { env: childProcessEnv(), encoding: "utf8", timeout: 300_000 });
  if (result.status !== 0) throw new Error(`ffmpeg failed: ${(result.stderr ?? "").slice(0, 300)}`);
}

async function fileEntry(path, viewport, extra = {}) {
  const bytes = await readFile(path);
  return { file: path, viewport, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), ...extra };
}

/** Plays the restart (see OUTAGES): each shot once its notice shows, the last one after the notices went by themselves. */
async function outageShots(chrome, page, input, dir, viewport) {
  const files = [];
  const startedAt = Date.now();
  const shot = async (name) => {
    await assertPinned(page, input);
    const file = join(dir, `shot-${viewport}-outage-${name}.${input.format === "jpeg" ? "jpg" : input.format}`);
    await writeFile(file, (await screenshot(chrome, page, input)).image);
    files.push([name, file, Date.now() - startedAt]);
  };
  // A wait that runs out leaves its shot and names what the page showed.
  const wait = async (expression, label, timeoutMs) => {
    try {
      await page.until(expression, label, timeoutMs);
    } catch (error) {
      await shot("timeout").catch(() => undefined);
      const seen = await page.evaluate(`JSON.stringify({ visibility: document.visibilityState, calmBanner: ${OUTAGE_PAGE.calmBanner}, calmDock: ${OUTAGE_PAGE.calmDock}, red: ${OUTAGE_PAGE.red} })`).catch(() => "unknown");
      throw new Error(`${error.message} The page showed ${seen}; see ${files.at(-1)?.[1] ?? "no shot"}.`, { cause: error });
    }
  };
  page.outage.active = true;
  try {
    // The Nous dock polls every 20 s; the global banner shows 10 s after the first failed request.
    await wait(`${OUTAGE_PAGE.calmBanner} && ${OUTAGE_PAGE.calmDock}`, "The calm outage notices", 45_000);
    await shot("during");
    if (input.outage === "red") {
      await wait(OUTAGE_PAGE.red, "The red outage error", 90_000);
      await shot("red");
    }
  } finally {
    page.outage.active = false;
  }
  // The page's own /readyz probe (at most 10 s apart) or any request ends the outage.
  await wait(`!${OUTAGE_PAGE.anyNotice}`, "The recovery", 30_000);
  await sleep(1200);
  await shot("after");
  return files;
}

/**
 * Runs one capture request. With `session` given (Space Control adapter) the shots come back inline, not on disk, and a
 * video goes to the adapter's `dir`.
 */
export async function capture(input, { session: given, dir: videoDir = null, fit = null } = {}) {
  const mock = input.instance === "mock";
  const session = mock ? null : given ?? await acquireSession(input);
  const { origin } = INSTANCES[input.instance];
  const scenario = typeof input.video === "string" ? JSON.parse(await readFile(input.video, "utf8")) : input.video;
  const steps = scenario ? validateScenario(scenario, input.instance) : null;
  input.scenarioHasScenes = steps?.some((step) => step.scene) ?? false;
  const dir = given ? videoDir : outputDir(input.slug);
  if (dir) await mkdir(dir, { recursive: true });
  const profileDir = await mkdtemp(join(given ? tmpdir() : OUTPUT_ROOT, "media-capture-chrome-"));
  const report = { instance: input.instance, origin, session: session?.mode ?? "public-mock", dir, room: input.room ?? null, pane: input.pane ?? null,
    view: input.view, step: input.step, appearance: input.appearance, masked: !mock && input.masked, files: [], shots: [], skipped: [], blockedWrites: 0 };
  report.version = mock ? null : await fetch(`${origin}/version`).then((r) => r.json()).then((v) => v.git?.shortCommit ?? null).catch(() => null);
  let chrome = null;
  try {
    if (!steps) chrome = await startChrome(profileDir);
    for (const viewport of input.viewports) {
      if (steps) {
        // A screencast follows the window's real device scale: each video gets a Chrome started at its own.
        await chrome?.close();
        chrome = await startChrome(await mkdtemp(join(profileDir, "video-")), { scale: deviceScale(input, viewport) });
      }
      const page = await openPage(chrome, input, session, viewport);
      report.skipped.push(...await applyStep(page, input.step));
      // Token usage ends the Quotas view, below the fold: wait for its bars (a month of request logs reads slowly), grow the window until the whole
      // section fits the dock, and shoot only the section; the report names every row and any label that overlaps or is clipped.
      if (input.tokenUsage) await page.until(`Boolean(document.querySelector(".nous-token-usage .nous-load-parts"))`, "The token usage", 60_000)
        .then(async () => {
          const extra = await page.evaluate(`(() => { let e = document.querySelector(".nous-token-usage");
            while (e && !(e.scrollHeight > e.clientHeight && /auto|scroll/.test(getComputedStyle(e).overflowY))) e = e.parentElement;
            return e ? e.scrollHeight - e.clientHeight : 0; })()`);
          const [width, height, , touch] = VIEWPORTS[viewport];
          if (extra > 0) await chrome.send("Emulation.setDeviceMetricsOverride", { width, height: height + extra, deviceScaleFactor: page.scale, mobile: touch }, page.sid);
          await sleep(800);
          await page.evaluate(`document.querySelector(".nous-token-usage").scrollIntoView({ block: "start" })`);
          (report.tokenUsage ??= []).push({ viewport, period: input.tokenUsage, ...await page.evaluate(tokenUsageLayout) });
        }, () => report.skipped.push("token-usage"));
      // --appointments-wheel: one real horizontal wheel on the Nous board's week or month (nous_msg:e3776676); the report names the period before and after.
      if (input.appointmentsWheel) {
        const grid = `document.querySelector(".nous-appointments :is(.nous-appointments-week, .nous-appointments-month)")`;
        const period = `document.querySelector(".nous-appointments-period h4")?.textContent`;
        await page.until(`Boolean(${grid})`, "The appointments calendar", 30_000).then(async () => {
          const at = await page.evaluate(`(() => { const r = ${grid}.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, from: ${period} }; })()`);
          await chrome.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: at.x, y: at.y, deltaX: input.appointmentsWheel === "next" ? 120 : -120, deltaY: 0 }, page.sid);
          await sleep(600);
          (report.appointmentsWheel ??= []).push({ viewport, wheel: input.appointmentsWheel, from: at.from, to: await page.evaluate(period) });
        }, () => report.skipped.push("appointments-wheel"));
      }
      if (page.scoreOpen) (report.scoreOpen ??= []).push({ viewport, ...page.scoreOpen });
      if (input.step.focusSearch) {
        const focused = await focusSearch(chrome, page, input);
        if (focused) (report.focusSearch ??= []).push({ viewport, ...focused }); else report.skipped.push("focus-search");
      }
      if (input.fitTerminals && fit) {
        // The grid each displayed CLI pane shows in this layout (its xterm's own fit); the API resizes those PTYs to it.
        const panes = await page.evaluate(`[...document.querySelectorAll('.room-runtime-layer[data-presentation-state="displayed"] .pane-card[data-pane-mode="TERMINAL"][data-space-pane-id]')]
          .map((pane) => { const host = pane.querySelector(".terminal-xterm");
            return host?.getClientRects().length ? { paneId: pane.dataset.spacePaneId, cols: Number(host.dataset.terminalCols), rows: Number(host.dataset.terminalRows) } : null; })
          .filter((entry) => entry && entry.cols > 0 && entry.rows > 0)`);
        report.terminalsFitted = await fit(panes);
        // The CLIs repaint at their new width.
        if (report.terminalsFitted) await sleep(2000);
      }
      await assertPinned(page, input);
      if (steps) {
        const video = await recordVideo(chrome, page, input, steps, dir, viewport);
        report.skipped.push(...video.skipped);
        for (const file of video.files) report.files.push(await fileEntry(file, viewport, { durationMs: video.durationMs, frames: video.frames }));
      } else if (input.outage) {
        if (session.mode !== "read-only") throw new Error("--outage needs the read-only (MEDIA_CAPTURE) session.");
        report.outage ??= { mode: input.outage, shots: [] };
        for (const [name, file, atMs] of await outageShots(chrome, page, input, dir, viewport)) {
          report.outage.shots.push({ viewport, name, atMs });
          report.files.push(await fileEntry(file, viewport, { outage: name }));
        }
      } else {
        const { image, clip, railQuota } = await screenshot(chrome, page, input);
        await assertPinned(page, input);
        const area = clip ?? page;
        const size = { width: Math.round(area.width * page.scale), height: Math.round(area.height * page.scale) };
        if (given) report.shots.push({ viewport, format: input.format, ...size, base64: image.toString("base64") });
        else {
          const file = join(dir, `shot-${viewport}.${input.format === "jpeg" ? "jpg" : input.format}`);
          await writeFile(file, image);
          report.files.push(await fileEntry(file, viewport, input.crop ? { crop: input.crop, ...(railQuota ? { railQuota } : {}) } : size));
          if (input.frame) {
            const framed = join(dir, `shot-${viewport}-frame-${input.frame}.png`);
            await writeFile(framed, await renderFrame(chrome, input, image));
            report.files.push(await fileEntry(framed, viewport, { frame: input.frame }));
          }
        }
      }
      report.blockedWrites += page.blocked.length;
      await chrome.send("Target.closeTarget", { targetId: page.targetId }).catch(() => undefined);
    }
  } finally {
    await chrome?.close();
    await rm(profileDir, { recursive: true, force: true });
  }
  if (dir && !given) await writeFile(join(dir, "manifest.json"), `${JSON.stringify(report, null, 1)}\n`);
  return report;
}

const options = {
  instance: { type: "string" }, slug: { type: "string" }, viewport: { type: "string" }, room: { type: "string" }, pane: { type: "string" },
  dock: { type: "string" }, settings: { type: "string" }, health: { type: "string" }, gateway: { type: "string" }, "gateway-account": { type: "string" }, view: { type: "string" }, scene: { type: "string" },
  crop: { type: "string" }, theme: { type: "string" }, mode: { type: "string" }, icons: { type: "string" }, background: { type: "string" },
  tint: { type: "string" }, "room-theme": { type: "string" }, language: { type: "string" }, rail: { type: "string" }, appointments: { type: "string" }, "appointments-wheel": { type: "string" }, "token-usage": { type: "string" }, "requests-status": { type: "string" }, "requests-search": { type: "string" }, zoom: { type: "string" }, unmasked: { type: "boolean" }, format: { type: "string" },
  quality: { type: "string" }, frame: { type: "string" }, headline: { type: "string" }, subline: { type: "string" }, video: { type: "string" },
  gif: { type: "boolean" }, stdin: { type: "boolean" }, outage: { type: "string" }, program: { type: "string" }, approved: { type: "boolean" }, waiting: { type: "boolean" },
  "focus-search": { type: "boolean" }
};

/**
 * --stdin is the Space Control adapter's entry (apps/api/src/space-control-capture.ts): {instance, cookieName, cookieValue,
 * room, pane, crop, dock, settings, health, viewport, format, quality, maxWidth, maxHeight, video, outDir} with a READ_ONLY
 * session the API signed for the actor. A video's frames and MP4 go to the artifact directory the adapter made (outDir):
 * the API's /tmp is a memory-backed tmpfs.
 */
export function stdinInput(raw) {
  const instance = raw?.instance;
  if (!["stable", "dev"].includes(instance) || raw.cookieName !== INSTANCES[instance].cookieName || typeof raw.cookieValue !== "string") throw new Error("The capture request is invalid.");
  const input = validateInput({ stdin: true, instance, room: raw.room, pane: raw.pane, crop: raw.crop, dock: raw.dock, settings: raw.settings, health: raw.health,
    viewport: raw.viewport ?? "desktop", format: raw.format, quality: raw.quality, maxWidth: raw.maxWidth, maxHeight: raw.maxHeight, video: raw.video,
    fitTerminals: raw.fitTerminals, language: raw.language });
  if (!input.room || input.viewports.length !== 1) throw new Error("The capture request is invalid.");
  if (input.video && !/\/browser-evidence\/space-control-[0-9a-f-]{36}$/.test(raw.outDir ?? "")) throw new Error("The capture request is invalid.");
  return input;
}

export async function runStdin(raw, fit = null) {
  const input = stdinInput(raw);
  return capture(input, { session: { name: raw.cookieName, value: raw.cookieValue, mode: "read-only" }, dir: input.video ? raw.outDir : null, fit });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  (async () => {
    const { values } = parseArgs({ options, strict: true, allowPositionals: false });
    if (values.stdin) {
      // The request is the first line; with fitTerminals the API answers SPACE_FIT with one more line (space-control-capture.ts).
      const lines = createInterface({ input: process.stdin })[Symbol.asyncIterator]();
      return runStdin(JSON.parse((await lines.next()).value ?? ""), async (panes) => {
        process.stdout.write(`SPACE_FIT ${JSON.stringify(panes)}\n`);
        const answer = await Promise.race([lines.next(), sleep(20_000).then(() => ({ value: null }))]);
        return Number(JSON.parse(answer.value ?? "null")?.fitted ?? 0);
      });
    }
    return capture(validateInput(values));
  })().then((report) => {
    process.stdout.write(`${JSON.stringify(report.shots?.length ? report : { ...report, shots: undefined }, null, 1)}\n`);
  }, (error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
