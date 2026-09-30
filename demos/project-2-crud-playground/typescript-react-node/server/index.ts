import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import type { DemoRuntimeConfig, DemoState, ListResponse, PublicTask, TaskRecord, TaskStatus } from "./types.js";

/**
 * Project 2 — CRUD Playground (TypeScript · React · Node.js).
 *
 * Typed variant of the CRUD demo. It is compiled by the repository build step and
 * started as a plain Node process; every write stays in this run's data directory.
 */

const projectId = "project-2-crud-playground" as const;
const variantId = "typescript-react-node" as const;
const runId: string = process.env.DEMO_RUN_ID ?? "unknown-run";
const mode: "SAMPLE" | "LIVE" = process.env.DEMO_MODE === "LIVE" ? "LIVE" : "SAMPLE";
const dataDir: string = process.env.DEMO_DATA_DIR ?? resolve(process.cwd(), "data");
const workspaceDir: string = process.env.DEMO_WORKSPACE_DIR ?? resolve(dataDir, "..");
const webRoot: string = resolve(process.env.DEMO_SOURCE_ROOT ?? process.cwd(), "web/dist");
const host: string = process.env.HOST ?? "127.0.0.1";
const port: number = Number.parseInt(process.env.PORT ?? "0", 10);
const statePath: string = join(dataDir, "records.json");
const startedAt = Date.now();

const allowedStatuses: readonly TaskStatus[] = ["TODO", "DOING", "DONE"];

function log(message: string, detail: Record<string, unknown> = {}): void {
  process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), message, ...detail })}\n`);
}

async function readState(): Promise<DemoState> {
  try {
    const parsed = JSON.parse(await readFile(statePath, "utf8")) as Partial<DemoState>;
    return { records: Array.isArray(parsed.records) ? parsed.records : [] };
  } catch {
    return { records: [] };
  }
}

async function writeState(state: DemoState): Promise<void> {
  await mkdir(dataDir, { recursive: true });
  const temporary = `${statePath}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await rename(temporary, statePath);
}

function makeId(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 8)}${Date.now().toString(36).slice(-4)}`;
}

interface ValidatedCreate {
  errors: string[];
  value: { title: string; operationKey: string; status: TaskStatus };
}

function validateCreate(payload: Record<string, unknown>): ValidatedCreate {
  const errors: string[] = [];
  const title = typeof payload.title === "string" ? payload.title.trim() : "";
  if (title.length < 3) errors.push("title must contain at least 3 characters");
  if (title.length > 160) errors.push("title must stay under 160 characters");
  const operationKey = typeof payload.operationKey === "string" ? payload.operationKey.trim() : "";
  if (!/^[A-Za-z0-9._:-]{8,160}$/.test(operationKey)) errors.push("operationKey must be 8-160 safe characters");
  const requestedStatus = typeof payload.status === "string" && allowedStatuses.includes(payload.status as TaskStatus) ? (payload.status as TaskStatus) : "TODO";
  return { errors, value: { title, operationKey, status: requestedStatus } };
}

function publicTask(record: TaskRecord): PublicTask {
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

const contentTypes: ReadonlyMap<string, string> = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".map", "application/json; charset=utf-8"]
]);

function corsHeaders(): Record<string, string> {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "content-type",
    "access-control-allow-methods": "GET,POST,PATCH,PUT,DELETE,OPTIONS"
  };
}

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...corsHeaders() });
  response.end(JSON.stringify(payload));
}

async function readJsonBody(request: IncomingMessage, limitBytes = 64 * 1024): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > limitBytes) throw new Error("PAYLOAD_TOO_LARGE");
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

async function serveStatic(response: ServerResponse, urlPath: string): Promise<void> {
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

const server = createServer((request, response) => {
  void handleRequest(request, response);
});

async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
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
      const payload: DemoRuntimeConfig = {
        projectId,
        variantId,
        mode,
        sampleData: true,
        source: "sample",
        runId,
        runtime: { node: process.version, entry: "server-dist/index.js" }
      };
      sendJson(response, 200, payload);
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
      const payload: ListResponse<PublicTask> = {
        data: filtered.slice(start, start + pageSize).map(publicTask),
        page,
        pageSize,
        totalItems: filtered.length,
        source: "sample",
        refreshedAt: new Date().toISOString()
      };
      sendJson(response, 200, payload);
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
        sendJson(response, 200, publicTask(existing));
        return;
      }
      const at = new Date().toISOString();
      const record: TaskRecord = {
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
      sendJson(response, 201, publicTask(record));
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
      const status = typeof payload.status === "string" ? payload.status : "";
      if (!allowedStatuses.includes(status as TaskStatus)) {
        sendJson(response, 400, { error: { code: "DEMO_VALIDATION_FAILED", message: "status must be TODO, DOING or DONE" } });
        return;
      }
      record.status = status as TaskStatus;
      record.updatedAt = new Date().toISOString();
      await writeState(state);
      sendJson(response, 200, publicTask(record));
      return;
    }

    if (recordMatch && request.method === "DELETE") {
      const state = await readState();
      const id = recordMatch[1] ?? "";
      const next = state.records.filter((candidate) => candidate.id !== id);
      if (next.length === state.records.length) {
        sendJson(response, 404, { error: { code: "DEMO_RECORD_NOT_FOUND", message: "The task was not found." } });
        return;
      }
      await writeState({ records: next });
      sendJson(response, 200, { ok: true, id });
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
}

server.listen(port, host, () => {
  log("demo server ready", { projectId, variantId, mode, port, dataDir });
});

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    log("demo server stopping", { signal });
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2_000).unref();
  });
}
