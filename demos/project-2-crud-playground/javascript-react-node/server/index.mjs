import { createServer } from "node:http";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join, normalize, resolve, extname } from "node:path";

/**
 * Project 2 — CRUD Playground (JavaScript · React · Node.js).
 *
 * Self-contained demo: every write stays inside this run's data directory, so
 * the runtime, preview, logs and isolation behaviour can be verified without any
 * external service. Served by the Space Demo Projects pane through its preview
 * gateway; the browser talks to this server with relative URLs only.
 */

const projectId = "project-2-crud-playground";
const variantId = "javascript-react-node";
const runId = process.env.DEMO_RUN_ID ?? "unknown-run";
const mode = process.env.DEMO_MODE === "LIVE" ? "LIVE" : "SAMPLE";
const dataDir = process.env.DEMO_DATA_DIR ?? resolve(process.cwd(), "data");
const workspaceDir = process.env.DEMO_WORKSPACE_DIR ?? resolve(dataDir, "..");
const webRoot = resolve(process.env.DEMO_SOURCE_ROOT ?? process.cwd(), "web/dist");
const host = process.env.HOST ?? "127.0.0.1";
const port = Number.parseInt(process.env.PORT ?? "0", 10);
const statePath = join(dataDir, "records.json");
const startedAt = Date.now();

const allowedStatuses = new Set(["TODO", "DOING", "DONE"]);

function log(message, detail = {}) {
  process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), message, ...detail })}\n`);
}

async function readState() {
  try {
    const raw = await readFile(statePath, "utf8");
    const parsed = JSON.parse(raw);
    return { records: Array.isArray(parsed.records) ? parsed.records : [] };
  } catch {
    return { records: [] };
  }
}

async function writeState(state) {
  await mkdir(dataDir, { recursive: true });
  const temporary = `${statePath}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await rename(temporary, statePath);
}

function makeId(prefix) {
  return `${prefix}-${Math.random().toString(36).slice(2, 8)}${Date.now().toString(36).slice(-4)}`;
}

function validateCreate(payload) {
  const errors = [];
  const title = typeof payload?.title === "string" ? payload.title.trim() : "";
  if (title.length < 3) errors.push("title must contain at least 3 characters");
  if (title.length > 160) errors.push("title must stay under 160 characters");
  const operationKey = typeof payload?.operationKey === "string" ? payload.operationKey.trim() : "";
  if (!/^[A-Za-z0-9._:-]{8,160}$/.test(operationKey)) errors.push("operationKey must be 8-160 safe characters");
  const status = typeof payload?.status === "string" && allowedStatuses.has(payload.status) ? payload.status : "TODO";
  return { errors, value: { title, operationKey, status } };
}

function publicRecord(record) {
  return {
    id: record.id,
    operationKey: record.operationKey,
    title: record.title,
    name: record.title,
    status: record.status,
    syncStatus: "SYNCED",
    source: "sample",
    accountId: null,
    contactId: null,
    sheetRow: null,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt
  };
}

const contentTypes = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".ico", "image/x-icon"],
  [".png", "image/png"],
  [".map", "application/json; charset=utf-8"]
]);

function corsHeaders() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "content-type",
    "access-control-allow-methods": "GET,POST,PATCH,PUT,DELETE,OPTIONS"
  };
}

function sendJson(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...corsHeaders() });
  response.end(body);
}

async function readJsonBody(request, limitBytes = 64 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limitBytes) throw new Error("PAYLOAD_TOO_LARGE");
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function serveStatic(response, urlPath) {
  const relative = urlPath === "/" || urlPath === "" ? "index.html" : urlPath.replace(/^\/+/, "");
  const candidate = resolve(webRoot, normalize(relative));
  if (!candidate.startsWith(resolve(webRoot))) {
    response.writeHead(403, corsHeaders());
    response.end("Forbidden");
    return;
  }
  try {
    const payload = await readFile(candidate);
    response.writeHead(200, { "content-type": contentTypes.get(extname(candidate)) ?? "application/octet-stream", ...corsHeaders() });
    response.end(payload);
  } catch {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8", ...corsHeaders() });
    response.end("Not found");
  }
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${host}:${port}`}`);
  const pathname = url.pathname;

  if (request.method === "OPTIONS") {
    response.writeHead(204, corsHeaders());
    response.end();
    return;
  }

  try {
    if (pathname === "/healthz") {
      sendJson(response, 200, { ok: true, runId, projectId, variantId, mode, uptimeMs: Date.now() - startedAt });
      return;
    }

    if (pathname === "/api/config") {
      sendJson(response, 200, {
        projectId,
        variantId,
        mode,
        sampleData: true,
        source: "sample",
        runId,
        runtime: { node: process.version, entry: "server/index.mjs" }
      });
      return;
    }

    if (pathname === "/api/isolation") {
      sendJson(response, 200, {
        runId,
        dataPath: dataDir,
        workspaceInsideRun: dataDir.startsWith(resolve(workspaceDir)),
        sharedStateDetected: false,
        stateFile: statePath
      });
      return;
    }

    if (pathname === "/api/records" && request.method === "GET") {
      const state = await readState();
      const search = (url.searchParams.get("search") ?? "").trim().toLowerCase();
      const page = Math.max(1, Number.parseInt(url.searchParams.get("page") ?? "1", 10) || 1);
      const pageSize = Math.min(50, Math.max(1, Number.parseInt(url.searchParams.get("pageSize") ?? "25", 10) || 25));
      const filtered = search.length > 0 ? state.records.filter((record) => record.title.toLowerCase().includes(search)) : state.records;
      const start = (page - 1) * pageSize;
      sendJson(response, 200, {
        data: filtered.slice(start, start + pageSize).map(publicRecord),
        page,
        pageSize,
        totalItems: filtered.length,
        source: "sample",
        refreshedAt: new Date().toISOString()
      });
      return;
    }

    if (pathname === "/api/records" && request.method === "POST") {
      const payload = await readJsonBody(request);
      const { errors, value } = validateCreate(payload);
      if (errors.length > 0) {
        sendJson(response, 400, { error: { code: "DEMO_VALIDATION_FAILED", message: errors.join("; ") } });
        return;
      }
      const state = await readState();
      const existing = state.records.find((record) => record.operationKey === value.operationKey);
      if (existing) {
        sendJson(response, 200, publicRecord(existing));
        return;
      }
      const at = new Date().toISOString();
      const record = {
        id: makeId("task"),
        operationKey: value.operationKey,
        title: value.title,
        status: value.status,
        createdAt: at,
        updatedAt: at
      };
      state.records.unshift(record);
      await writeState(state);
      log("created task", { id: record.id, operationKey: record.operationKey });
      sendJson(response, 201, publicRecord(record));
      return;
    }

    const recordMatch = /^\/api\/records\/([A-Za-z0-9:_-]{4,120})$/.exec(pathname);
    if (recordMatch && request.method === "PATCH") {
      const payload = await readJsonBody(request);
      const state = await readState();
      const record = state.records.find((candidate) => candidate.id === recordMatch[1]);
      if (!record) {
        sendJson(response, 404, { error: { code: "DEMO_RECORD_NOT_FOUND", message: "The task was not found." } });
        return;
      }
      const status = typeof payload?.status === "string" ? payload.status : "";
      if (!allowedStatuses.has(status)) {
        sendJson(response, 400, { error: { code: "DEMO_VALIDATION_FAILED", message: "status must be TODO, DOING or DONE" } });
        return;
      }
      record.status = status;
      record.updatedAt = new Date().toISOString();
      await writeState(state);
      sendJson(response, 200, publicRecord(record));
      return;
    }

    if (recordMatch && request.method === "DELETE") {
      const state = await readState();
      const next = state.records.filter((candidate) => candidate.id !== recordMatch[1]);
      if (next.length === state.records.length) {
        sendJson(response, 404, { error: { code: "DEMO_RECORD_NOT_FOUND", message: "The task was not found." } });
        return;
      }
      await writeState({ records: next });
      sendJson(response, 200, { ok: true, id: recordMatch[1] });
      return;
    }

    if (pathname.startsWith("/api/")) {
      sendJson(response, 404, { error: { code: "DEMO_ENDPOINT_NOT_FOUND", message: "Unknown demo endpoint." } });
      return;
    }

    await serveStatic(response, pathname);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected demo error";
    log("request failed", { path: pathname, message });
    sendJson(response, 500, { error: { code: "DEMO_INTERNAL_ERROR", message } });
  }
});

server.listen(port, host, () => {
  log("demo server ready", { projectId, variantId, mode, port, dataDir });
});

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    log("demo server stopping", { signal });
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2_000).unref();
  });
}
