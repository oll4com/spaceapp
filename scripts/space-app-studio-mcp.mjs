#!/usr/bin/env node
"use strict";

// App Studio tools (plan clipboard:v7hyZ76ThCyv): the CLI agent of an APP_STUDIO pane takes its briefs, asks the operator, notes
// its activity and previews its Expo app on the most-used phone sizes. A preview runs here, inside the CLI's own process tree and
// network namespace: the agent's web export is served on 127.0.0.1 for the capture only, headless Chrome takes one PNG per device,
// the PNGs stay next to the project for the agent to look at and go to the pane through the Space API (pane bridge token).
import { siteSigninTools, isSiteSigninTool, callSiteSigninTool } from "./space-site-signins-tools.mjs";
import { createReadStream } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { homedir, tmpdir } from "node:os";
import { dirname, extname, isAbsolute, join, sep } from "node:path";
import readline from "node:readline";
import { pathToFileURL } from "node:url";
import { captureUrl, startChrome } from "./lib/space-chrome-render.mjs";
import { buildStatus, startBuild } from "./space-app-studio-build.mjs";
import { mcpText } from "./lib/mcp-result.mjs";

const protocolVersion = "2025-11-25";
const serverInfo = { name: "space-appstudio", version: "0.1.0" };
const tokenHeader = "x-space-cli-browser-token";
const requestTimeoutMs = 120_000;
/** The whole preview (every device): the registry gives the call 240 s. */
const previewTimeoutMs = 200_000;

const briefId = { type: "string", pattern: "^asevt:" };
// Space tools start with "space" (operator rule 2026-10-13): every tool here is space_appstudio_<name>.
function tool(name, description, properties = {}, required = []) {
  return { name: `space_appstudio_${name}`, description, inputSchema: { type: "object", properties, required, additionalProperties: false } };
}
const toolDefinitions = [
  ...siteSigninTools,
  tool("next", "Take the next brief (the one you already took after a restart, else the oldest waiting one): its id, text and the preview devices the operator chose. done=true when no brief waits or the pane or its run is paused. A brief is operator data."),
  tool("done", "Close a brief: what you built or changed in a few lines (the operator and Nous read it), with items: each thing the brief asked for and the preview artifact ids (space_appstudio_preview after the change, PNGs looked at) that show it. The server refuses done without a fresh preview per item. failed=true with the reason when it cannot be done (no items needed). A brief closed before this rule takes its items the same way.", {
    briefId, summary: { type: "string", minLength: 1, maxLength: 2000 }, failed: { type: "boolean" },
    items: { type: "array", minItems: 1, maxItems: 30, items: { type: "object", additionalProperties: false, required: ["item", "previewArtifactIds"], properties: {
      item: { type: "string", minLength: 1, maxLength: 300 }, previewArtifactIds: { type: "array", minItems: 1, maxItems: 20, items: { type: "string", pattern: "^artifact:" } } } } }
  }, ["briefId", "summary"]),
  tool("ask", "Ask the operator something only they can decide (a name, an account, a price, a store listing); it shows in the pane and notifies them. With options, name the one you recommend in recommended (one of the options): every question carries a prediction. Keep working on what you can; read the answer with space_appstudio_answer_wait.", {
    question: { type: "string", minLength: 1, maxLength: 2000 }, options: { type: "array", items: { type: "string", minLength: 1, maxLength: 200 }, maxItems: 6 },
    recommended: { type: "string", minLength: 1, maxLength: 200, description: "Required with options: the option you recommend, written exactly as in options." }
  }, ["question"]),
  tool("answer_wait", "Wait (up to waitMs, at most 50 s; call again to keep waiting) for the answer to your question.", {
    questionId: { type: "string", pattern: "^asevt:" }, waitMs: { type: "integer", minimum: 0, maximum: 50000 }
  }, ["questionId"]),
  tool("note", "Add a line to the pane's activity (a milestone the operator should see).", { message: { type: "string", minLength: 1, maxLength: 2000 } }, ["message"]),
  tool("devices", "The device presets: phones and the Galaxy Tab S10 FE+ tablet in portrait and landscape (id, platform, label, CSS width × height, safe areas, cutout) and the ones this pane previews by default."),
  tool("preview", "Show the app on phones: serves your web export (the folder `npx expo export --platform web` wrote) on 127.0.0.1 for the capture only, takes one PNG per device at 2x, saves them under ~/agent-workspace/app-studio/<pane>/previews and shows them in the pane. Look at the PNGs before you call a screen done.", {
    dir: { type: "string", minLength: 1, maxLength: 1000, description: "Absolute path of the web export folder (it has index.html); a demo build's folder (e.g. dist-demo) works the same." },
    route: { type: "string", minLength: 1, maxLength: 200, pattern: "^/", description: "The screen, e.g. / or /settings, with a query string for a state (/?state=locked) and a concrete value for a dynamic segment (/pane/demo-1 is served from pane/[id].html). Default /." },
    api: { type: "string", minLength: 1, maxLength: 1000, description: "Absolute path of the app's preview-api folder: /api/<path> on the preview's own origin answers from <api>/<METHOD>/<path>.json ({status, headers, body}) or <path>.sse; anything not recorded is a 404. Nothing is forwarded, no session." },
    screens: { type: "integer", minimum: 1, maximum: 20, description: "Also capture the screens below the first one, scrolling the page's main scroller one height each (default 1). Screen 2 onwards show in the pane as <route>#2, #3, ..." },
    devices: { description: "\"all\", or device ids from space_appstudio_devices; default: the pane's preview devices.", anyOf: [{ type: "string", enum: ["all"] }, { type: "array", items: { type: "string", pattern: "^(android|iphone)-[0-9]{3,4}x[0-9]{3,4}$" }, minItems: 1, maxItems: 12 }] }
  }, ["dir"]),
  tool("build_apk", "Build an installable APK of your Expo app for the operator's Android phone: expo prebuild + Gradle with the pinned Android toolchain, JS bundled in, arm64, never a store upload. Signed with the debug keystore by default; signing release re-signs it with the app's own kept key from the operator's Vault (only an app id App Studio lists, today com.oll4.spaceapp.nous; the key is used and deleted inside the build). Runs in the background (5-15 minutes, one build at a time, refused while the server is OVERLOADED); the APK then shows in the pane for download and the operator gets a notification. Needs expo.android.package in app.json and node_modules installed.", {
    dir: { type: "string", minLength: 1, maxLength: 1000, description: "Absolute path of the Expo app folder (the one with package.json), inside this pane's app-studio folder." },
    signing: { type: "string", enum: ["debug", "release"], description: "debug (default). release: the app's kept Vault key; a phone with the debug build installed must uninstall it once before the first release-signed one." },
    release: { type: "boolean", description: "A test build by default, filed in Agent Files › Apps/Android/Builds. Set release true only for a finished build to publish: it is filed in Apps/Android, which the operator's phone offers as an update. Never release until every item is done; the server refuses a release while a brief done since the last release has no preview proof." }
  }, ["dir"]),
  tool("build_status", "The APK build's state (the newest build without jobId): RUNNING with its stage, DONE with the APK's package, version, size and download path, or FAILED with the reason and the log's last lines. Waits up to waitMs (at most 50 s) while it runs.", {
    jobId: { type: "string", pattern: "^apk-" }, waitMs: { type: "integer", minimum: 0, maximum: 50000 }
  })
];

// The sudo env allow-lists between the pane host and the CLI keep only the browser bridge variables, so the endpoint is
// derived from the browser command endpoint.
export function appStudioEndpoint(env) {
  const base = (env.SPACE_BROWSER_COMMAND_ENDPOINT || "").match(/^(https?:\/\/[^/?#]+(?:\/[^?#]*?)?)\/api\/cli\/browser\/commands\/?$/)?.[1];
  return base ? `${base}/api/cli/app-studio` : "";
}
function configuration() {
  return { endpoint: appStudioEndpoint(process.env), token: process.env.SPACE_BROWSER_ACTION_TOKEN || "" };
}
function safeErrorMessage(value) {
  const message = value instanceof Error ? value.message : String(value || "Space App Studio request failed.");
  return message.replace(/clibrowser\.v1\.[A-Za-z0-9_.-]+/g, "[REDACTED]").replace(/(authorization|cookie|token|password)\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]").slice(0, 1000);
}
async function requestJson(path, init = {}) {
  const { endpoint, token } = configuration();
  if (!endpoint || !token) throw new Error("Space App Studio bridge is not available for this pane (SPACE_BROWSER_COMMAND_ENDPOINT, SPACE_BROWSER_ACTION_TOKEN).");
  const json = typeof init.body === "string";
  const response = await fetch(`${endpoint}${path}`, {
    ...init, signal: AbortSignal.timeout(requestTimeoutMs),
    headers: { ...(json ? { "content-type": "application/json" } : {}), [tokenHeader]: token, ...(init.headers || {}) }
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new Error(payload?.error?.message || payload?.message || `Space App Studio request returned HTTP ${response.status}.`);
  return payload;
}
const post = (path, body) => requestJson(path, { method: "POST", body: JSON.stringify(body) });

// ---- the web export, served for one capture --------------------------------------------------------
const contentTypes = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json", ".map": "application/json", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
  ".svg": "image/svg+xml", ".ico": "image/x-icon", ".ttf": "font/ttf", ".otf": "font/otf", ".woff": "font/woff", ".woff2": "font/woff2", ".wasm": "application/wasm"
};
/** A file of the export for a request path: the path, path.html, path/index.html, else index.html (a single-page app); never outside the root. */
export async function resolveExportFile(root, urlPath) {
  let path;
  try { path = decodeURIComponent(urlPath.split("?")[0]); } catch { return null; }
  if (path.includes("\0")) return null;
  // A dynamic route's static page (pane/[id].html, pane/[id]/index.html) serves every concrete value of its segment.
  const dynamic = (await readdir(join(root, dirname(path))).catch(() => [])).filter((name) => /^\[[^/]+\](\.html)?$/.test(name)).sort();
  const dynamicPages = dynamic.map((name) => name.endsWith(".html") ? join(dirname(path), name) : join(dirname(path), name, "index.html"));
  for (const candidate of [path, `${path}.html`, join(path, "index.html"), ...dynamicPages, "/index.html"]) {
    const file = await realpath(join(root, candidate)).catch(() => null);
    if (!file || (file !== root && !file.startsWith(`${root}${sep}`))) continue;
    if ((await stat(file).catch(() => null))?.isFile()) return file;
  }
  return null;
}
/**
 * A recorded API answer (gap 3, Nous decision 2026-10-23: option A): `/api/<path>` is <api>/<METHOD>/<path>.json, {status, headers, body},
 * or <path>.sse, an event stream replayed as written. Never outside the folder; the query string is ignored.
 */
export async function resolveRecordedApi(apiRoot, method, urlPath) {
  let path;
  try { path = decodeURIComponent(urlPath.split("?")[0]).replace(/^\/api\/?/, ""); } catch { return null; }
  if (!/^[A-Z]{3,7}$/.test(method) || path.includes("\0") || !path || path.split("/").includes("..")) return null;
  for (const [suffix, kind] of [[".json", "json"], [".sse", "sse"]]) {
    const file = await realpath(join(apiRoot, method, `${path}${suffix}`)).catch(() => null);
    if (!file || !file.startsWith(`${apiRoot}${sep}`) || !(await stat(file).catch(() => null))?.isFile()) continue;
    return { file, kind };
  }
  return null;
}
async function answerRecorded(apiRoot, request, response) {
  request.resume();
  const recorded = await resolveRecordedApi(apiRoot, request.method || "GET", request.url || "/");
  if (!recorded) {
    response.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: { code: "NOT_RECORDED", message: `${request.method} ${request.url?.split("?")[0]} has no recorded answer in preview-api/.` } }));
    return;
  }
  if (recorded.kind === "sse") {
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
    createReadStream(recorded.file).pipe(response);
    return;
  }
  const answer = JSON.parse(await readFile(recorded.file, "utf8"));
  const status = Number.isInteger(answer?.status) && answer.status >= 200 && answer.status <= 599 ? answer.status : 200;
  const headers = Object.fromEntries(Object.entries(answer?.headers ?? {}).filter(([name, value]) => /^[a-z0-9-]{1,60}$/i.test(name) && !/^(set-cookie|location)$/i.test(name) && typeof value === "string"));
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...headers }).end(typeof answer?.body === "string" ? answer.body : JSON.stringify(answer?.body ?? null));
}

export async function serveExport(dir, { api = null } = {}) {
  if (typeof dir !== "string" || !isAbsolute(dir)) throw new Error("preview needs the absolute path of the web export folder (dir).");
  const root = await realpath(dir).catch(() => null);
  if (!root || !(await stat(root)).isDirectory()) throw new Error(`${dir} is not a folder.`);
  if (!(await stat(join(root, "index.html")).catch(() => null))?.isFile()) throw new Error(`${dir} has no index.html: run npx expo export --platform web first.`);
  if (api !== null && (typeof api !== "string" || !isAbsolute(api))) throw new Error("api is the absolute path of the app's preview-api folder.");
  const apiRoot = api === null ? null : await realpath(api).catch(() => null);
  if (api !== null && (!apiRoot || !(await stat(apiRoot)).isDirectory())) throw new Error(`${api} is not a folder.`);
  // Same origin as the app, so no CORS; this server has no client, so nothing is ever forwarded.
  const server = createServer((request, response) => {
    // A proxy-style absolute URL is read as its path: it names this server's own files, never another host.
    let path = request.url || "/";
    if (!path.startsWith("/")) { try { const url = new URL(path); path = `${url.pathname}${url.search}`; } catch { path = "/"; } }
    request.url = path;
    if (apiRoot && /^\/api(\/|\?|$)/.test(path)) { void answerRecorded(apiRoot, request, response).catch(() => { if (!response.headersSent) response.writeHead(500).end(); }); return; }
    void resolveExportFile(root, path).then((file) => {
      if (!file || request.method !== "GET") { response.writeHead(404).end(); return; }
      response.writeHead(200, { "content-type": contentTypes[extname(file).toLowerCase()] || "application/octet-stream", "cache-control": "no-store" });
      createReadStream(file).pipe(response);
    }, () => response.writeHead(500).end());
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  return { origin: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((resolve) => server.close(() => resolve())) };
}

// ---- the preview -----------------------------------------------------------------------------------
function previewDirectory(env = process.env) {
  const pane = (env.SPACE_PANE_ID || "pane").replace(/[^A-Za-z0-9_-]/g, "_");
  return join(env.SPACE_APP_STUDIO_DIR || join(homedir(), "agent-workspace", "app-studio"), pane, "previews");
}
const routeSlug = (route) => route.replace(/^\/+|\/+$/g, "").replace(/[^A-Za-z0-9_-]+/g, "_").slice(0, 120) || "home";
let previewing = Promise.resolve();

/** The route rule of appStudioRouteSchema (contracts) without the screen suffix: a path inside the app and an optional query. */
export const previewRoutePattern = /^\/[A-Za-z0-9/_\-.[\]()]*(\?[A-Za-z0-9_\-.=&%,~+:]*)?$/;
async function preview(args) {
  const route = typeof args.route === "string" ? args.route : "/";
  if (!previewRoutePattern.test(route) || route.split("?")[0].split("/").includes("..")) throw new Error("route starts with / and stays inside the app (e.g. / or /settings?state=locked).");
  const screens = Number.isInteger(args.screens) ? Math.min(Math.max(args.screens, 1), 20) : 1;
  const { devices, selected } = await requestJson("/devices", { method: "GET" });
  const wanted = args.devices === "all" ? devices.map((device) => device.id) : Array.isArray(args.devices) ? args.devices : selected;
  const chosen = wanted.map((id) => devices.find((device) => device.id === id) ?? (() => { throw new Error(`Unknown device ${id}; see space_appstudio_devices.`); })());
  const server = await serveExport(args.dir, { api: typeof args.api === "string" ? args.api : null });
  const profile = await mkdtemp(join(tmpdir(), "space-app-studio-chrome-"));
  const directory = previewDirectory();
  let chrome = null;
  try {
    chrome = await startChrome(profile);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    // One pane route per screen: /settings, /settings#2, ...
    const byScreen = new Map();
    for (const device of chosen) {
      const shots = await captureUrl(chrome, { url: `${server.origin}${route}`, width: device.width, height: device.height, dpr: 2, safeArea: device.safeArea, screens });
      for (const [index, bytes] of shots.entries()) {
        const key = index === 0 ? route : `${route}#${index + 1}`;
        const path = join(directory, `${routeSlug(route)}${index === 0 ? "" : `-${index + 1}`}-${device.id}.png`);
        await writeFile(path, bytes, { mode: 0o644 });
        byScreen.set(key, [...(byScreen.get(key) ?? []), { device, path, bytes }]);
      }
    }
    const rows = [];
    for (const [key, captures] of byScreen) {
      const form = new FormData();
      // Fields first: the API reads them before the files.
      form.set("route", key);
      for (const capture of captures) form.append(capture.device.id, new Blob([capture.bytes], { type: "image/png" }), `${capture.device.id}.png`);
      const { previews } = await requestJson("/previews", { method: "POST", body: form });
      for (const capture of captures) rows.push({ route: key, deviceId: capture.device.id, label: capture.device.label, size: `${capture.device.width}x${capture.device.height}`,
        path: capture.path, artifactId: previews.find((row) => row.deviceId === capture.device.id)?.artifactId ?? null });
    }
    return { route, screens: byScreen.size, previews: rows };
  } finally {
    await chrome?.close();
    await server.close();
    await rm(profile, { recursive: true, force: true }).catch(() => undefined);
  }
}
/** One preview at a time per CLI (one Chrome), with a cap so a page that never settles cannot hold the call. */
function previewOnce(args) {
  const run = previewing.then(() => Promise.race([preview(args), new Promise((_, reject) => setTimeout(() => reject(new Error("The preview took too long.")), previewTimeoutMs).unref())]));
  previewing = run.catch(() => undefined);
  return run;
}

async function callTool(name, args) {
  if (isSiteSigninTool(name)) return callSiteSigninTool(name, args);
  switch (name) {
    case "space_appstudio_next": return post("/next", {});
    case "space_appstudio_done": return post(`/briefs/${encodeURIComponent(args.briefId)}/done`, { summary: args.summary, ...(args.failed === undefined ? {} : { failed: args.failed }), ...(args.items === undefined ? {} : { items: args.items }) });
    case "space_appstudio_ask": return post("/ask", args);
    case "space_appstudio_answer_wait": return post(`/questions/${encodeURIComponent(args.questionId)}/wait`, { waitMs: args.waitMs ?? 30000 });
    case "space_appstudio_note": return post("/note", args);
    case "space_appstudio_devices": return requestJson("/devices", { method: "GET" });
    case "space_appstudio_preview": return previewOnce(args);
    case "space_appstudio_build_apk": return startBuild(args.dir, { signing: args.signing ?? "debug", releaseBuild: args.release === true });
    case "space_appstudio_build_status": return buildStatus(args.jobId, { waitSeconds: (args.waitMs ?? 30000) / 1000 });
    default: throw new Error(`Unknown Space App Studio tool ${name}.`);
  }
}

function toolResult(payload) {
  return { content: [{ type: "text", text: mcpText(payload) }], structuredContent: payload, isError: false };
}
function toolError(error) {
  const message = safeErrorMessage(error);
  return { content: [{ type: "text", text: message }], structuredContent: { ok: false, code: "SPACE_APP_STUDIO_REQUEST_FAILED", message }, isError: true };
}

function main() {
  let initialized = false;
  const input = readline.createInterface({ input: process.stdin });
  const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
  const sendError = (id, code, message) => send({ jsonrpc: "2.0", id, error: { code, message } });
  input.on("line", (line) => {
    void (async () => {
      let message;
      try { message = JSON.parse(line); } catch { sendError(null, -32700, "Parse error"); return; }
      if (message.method === "initialize") { send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion, capabilities: { tools: { listChanged: false } }, serverInfo } }); return; }
      if (message.method === "notifications/initialized") { initialized = true; return; }
      if (!initialized) { sendError(message.id ?? null, -32002, "Client did not send initialized notification"); return; }
      if (message.method === "tools/list") { send({ jsonrpc: "2.0", id: message.id, result: { tools: toolDefinitions } }); return; }
      if (message.method === "tools/call") {
        try { send({ jsonrpc: "2.0", id: message.id, result: toolResult(await callTool(message.params?.name, message.params?.arguments ?? {})) }); }
        catch (error) { send({ jsonrpc: "2.0", id: message.id, result: toolError(error) }); }
        return;
      }
      sendError(message.id ?? null, -32601, "Method not found");
    })();
  });
}

// Imported by its test for the export server; run as the MCP server otherwise. A CLI whose MCP catalog predates an option calls the
// same preview from its shell: node /opt/spaceapp/scripts/space-app-studio-mcp.mjs preview '{"dir":"...","route":"/?state=locked","screens":3}'
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  if (process.argv[2] === "preview") previewOnce(JSON.parse(process.argv[3] ?? "{}")).then((result) => console.log(JSON.stringify(result, null, 2)), (error) => { console.error(safeErrorMessage(error)); process.exit(1); });
  else main();
}
