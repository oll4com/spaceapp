import { createServer } from "node:http";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";

/**
 * Project 1 — Salesforce CRM (JavaScript · React · Node.js).
 *
 * Sample mode keeps everything inside the run workspace with synthetic records.
 * Live mode never touches OAuth secrets: it asks the Space connector API, which
 * owns the encrypted Salesforce and Google tokens, and reports back the real ids.
 */

const projectId = "project-1-salesforce-crm";
const variantId = "javascript-react-node";
const runId = process.env.DEMO_RUN_ID ?? "unknown-run";
const mode = process.env.DEMO_MODE === "LIVE" ? "LIVE" : "SAMPLE";
const dataDir = process.env.DEMO_DATA_DIR ?? resolve(process.cwd(), "data");
const workspaceDir = process.env.DEMO_WORKSPACE_DIR ?? resolve(dataDir, "..");
const webRoot = resolve(process.env.DEMO_SOURCE_ROOT ?? process.cwd(), "web/dist");
const host = process.env.HOST ?? "127.0.0.1";
const port = Number.parseInt(process.env.PORT ?? "0", 10);
const apiBase = process.env.SPACE_API_BASE_URL ?? "";
const runToken = process.env.DEMO_RUN_TOKEN ?? "";
const statePath = join(dataDir, "records.json");
const startedAt = Date.now();

function log(message, detail = {}) {
  process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), message, ...detail })}\n`);
}

const seedAccounts = [
  ["Acme Analytics", "Maria Papadopoulou", "maria@acme-analytics.example"],
  ["Blue Harbor Logistics", "Nikos Georgiou", "nikos@blueharbor.example"],
  ["Cedar Health Group", "Eleni Stavrou", "eleni@cedarhealth.example"],
  ["Delta Robotics", "Kostas Nikolaou", "kostas@deltarobotics.example"],
  ["Everest Consulting", "Sofia Dimitriou", "sofia@everest.example"],
  ["Festive Retail", "Giorgos Petrou", "giorgos@festive.example"],
  ["Granite Insurance", "Anna Christou", "anna@granite.example"],
  ["Harborline Shipping", "Petros Alexiou", "petros@harborline.example"]
];

async function readState() {
  try {
    const raw = await readFile(statePath, "utf8");
    const parsed = JSON.parse(raw);
    return {
      records: Array.isArray(parsed.records) ? parsed.records : [],
      accounts: Array.isArray(parsed.accounts) && parsed.accounts.length > 0 ? parsed.accounts : seedSampleAccounts()
    };
  } catch {
    return { records: [], accounts: seedSampleAccounts() };
  }
}

function seedSampleAccounts() {
  return seedAccounts.map(([name, contactName, email], index) => ({
    id: `SAMPLE-ACCT-${String(1000 + index)}`,
    name,
    contactName,
    contactId: `SAMPLE-CONTACT-${String(2000 + index)}`,
    email,
    createdAt: new Date(Date.now() - (index + 1) * 86_400_000).toISOString(),
    source: "sample"
  }));
}

async function writeState(state) {
  await mkdir(dataDir, { recursive: true });
  const temporary = `${statePath}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await rename(temporary, statePath);
}

function validateCreate(payload) {
  const errors = [];
  const name = typeof payload?.name === "string" ? payload.name.trim() : "";
  const contactLastName = typeof payload?.contactLastName === "string" ? payload.contactLastName.trim() : "";
  const operationKey = typeof payload?.operationKey === "string" ? payload.operationKey.trim() : "";
  const email = typeof payload?.email === "string" && payload.email.trim().length > 0 ? payload.email.trim() : null;
  const phone = typeof payload?.phone === "string" && payload.phone.trim().length > 0 ? payload.phone.trim() : null;
  const website = typeof payload?.website === "string" && payload.website.trim().length > 0 ? payload.website.trim() : null;
  const firstName = typeof payload?.firstName === "string" && payload.firstName.trim().length > 0 ? payload.firstName.trim() : null;
  if (name.length < 2) errors.push("Account Name must contain at least 2 characters");
  if (contactLastName.length < 2) errors.push("Contact Last Name must contain at least 2 characters");
  if (!/^[A-Za-z0-9._:-]{8,160}$/.test(operationKey)) errors.push("operationKey must be 8-160 safe characters");
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.push("Email must be a valid address");
  return { errors, value: { name, contactLastName, operationKey, email, phone, website, firstName } };
}

function publicSampleRecord(record) {
  return {
    id: record.id,
    operationKey: record.operationKey,
    name: record.name,
    accountId: record.accountId,
    contactId: record.contactId,
    contactName: record.contactName,
    email: record.email,
    phone: record.phone,
    website: record.website,
    sheetRow: record.sheetRow,
    syncStatus: record.syncStatus,
    steps: record.steps ?? [],
    lastError: null,
    source: "sample",
    createdAt: record.createdAt,
    updatedAt: record.updatedAt
  };
}

function publicLiveOperation(operation) {
  const contactName = [operation.firstName, operation.contactLastName].filter(Boolean).join(" ");
  return {
    id: operation.id,
    operationKey: operation.operationKey,
    name: operation.accountName,
    accountId: operation.salesforceAccountId,
    contactId: operation.salesforceContactId,
    contactName: contactName.length > 0 ? contactName : null,
    email: operation.email,
    phone: operation.phone,
    website: operation.website,
    sheetRow: operation.sheetsRow,
    syncStatus: operation.status,
    steps: operation.steps ?? [],
    lastError: operation.lastErrorMessage ?? null,
    source: "salesforce",
    createdAt: operation.createdAt,
    updatedAt: operation.updatedAt
  };
}

async function connectorRequest(path, init = {}) {
  if (apiBase.length === 0 || runToken.length === 0) {
    throw new Error("The Space connector is not configured for this run.");
  }
  const response = await fetch(`${apiBase}/api/demo-projects/runs/${encodeURIComponent(runId)}/connector${path}`, {
    ...init,
    headers: {
      accept: "application/json",
      "x-demo-run-token": runToken,
      ...(init.body ? { "content-type": "application/json" } : {})
    },
    signal: AbortSignal.timeout(20_000)
  });
  const text = await response.text();
  const payload = text.length > 0 ? JSON.parse(text) : {};
  if (!response.ok) {
    const error = payload?.error ?? {};
    const failure = new Error(error.message ?? `Connector request failed with ${response.status}`);
    failure.code = error.code ?? "DEMO_CONNECTOR_FAILED";
    failure.status = response.status;
    throw failure;
  }
  return payload;
}

const contentTypes = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
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
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...corsHeaders() });
  response.end(JSON.stringify(payload));
}

function sendFailure(response, error) {
  const status = typeof error?.status === "number" ? error.status : 500;
  sendJson(response, status, {
    error: { code: error?.code ?? "DEMO_INTERNAL_ERROR", message: error instanceof Error ? error.message : "Unexpected demo error" }
  });
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

async function sampleAccounts(search, page, pageSize) {
  const state = await readState();
  const term = search.trim().toLowerCase();
  const filtered = term.length > 0 ? state.accounts.filter((account) => account.name.toLowerCase().includes(term)) : state.accounts;
  const start = (page - 1) * pageSize;
  return {
    data: filtered.slice(start, start + pageSize),
    page,
    pageSize,
    totalItems: filtered.length,
    source: "sample",
    refreshedAt: new Date().toISOString(),
    sampleData: true
  };
}

async function liveAccounts(search, page, pageSize) {
  const query = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
  if (search.trim().length > 0) query.set("search", search.trim());
  const payload = await connectorRequest(`/accounts?${query.toString()}`);
  return { ...payload, sampleData: false };
}

async function createSampleRecord(value) {
  const state = await readState();
  const existing = state.records.find((record) => record.operationKey === value.operationKey);
  if (existing) return { record: existing, created: false };
  const at = new Date().toISOString();
  const suffix = state.records.length + 1;
  const account = {
    id: `SAMPLE-ACCT-${Date.now().toString(36).toUpperCase()}`,
    name: value.name,
    contactName: [value.firstName, value.contactLastName].filter(Boolean).join(" "),
    contactId: `SAMPLE-CONTACT-${Date.now().toString(36).toUpperCase()}`,
    email: value.email,
    createdAt: at,
    source: "sample"
  };
  const record = {
    id: `demo-record-${state.records.length + 1}-${Date.now().toString(36)}`.slice(0, 60),
    operationKey: value.operationKey,
    name: value.name,
    accountId: account.id,
    contactId: account.contactId,
    contactName: account.contactName,
    email: value.email,
    phone: value.phone,
    website: value.website,
    sheetRow: suffix,
    syncStatus: "SYNCED",
    steps: [
      { key: "salesforce-account", status: "DONE", message: "Sample account created locally.", externalId: account.id },
      { key: "salesforce-contact", status: "DONE", message: "Sample contact created locally.", externalId: account.contactId },
      { key: "google-sheets-row", status: "DONE", message: "Sample row appended to the run workspace.", externalId: String(suffix) }
    ],
    createdAt: at,
    updatedAt: at
  };
  state.records.unshift(record);
  state.accounts.unshift(account);
  await writeState(state);
  log("created sample account and contact", { operationKey: value.operationKey });
  return { record, created: true };
}

async function createLiveOperation(value) {
  const payload = await connectorRequest("/operations", {
    method: "POST",
    body: JSON.stringify({
      operationKey: value.operationKey,
      accountName: value.name,
      contactLastName: value.contactLastName,
      firstName: value.firstName,
      email: value.email,
      phone: value.phone,
      website: value.website
    })
  });
  return { operation: payload.operation, created: Boolean(payload.created) };
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
        sampleData: mode !== "LIVE",
        source: mode === "LIVE" ? "salesforce" : "sample",
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

    if (pathname === "/api/status") {
      if (mode !== "LIVE") {
        sendJson(response, 200, {
          mode,
          accountsSource: "sample",
          sheetsReady: true,
          sampleData: true,
          pending: 0,
          failed: 0
        });
        return;
      }
      const payload = await connectorRequest("/status");
      sendJson(response, 200, payload);
      return;
    }

    if (pathname === "/api/accounts" && request.method === "GET") {
      const search = url.searchParams.get("search") ?? "";
      const page = Math.max(1, Number.parseInt(url.searchParams.get("page") ?? "1", 10) || 1);
      const pageSize = Math.min(100, Math.max(1, Number.parseInt(url.searchParams.get("pageSize") ?? "25", 10) || 25));
      const payload = mode === "LIVE" ? await liveAccounts(search, page, pageSize) : await sampleAccounts(search, page, pageSize);
      sendJson(response, 200, payload);
      return;
    }

    if (pathname === "/api/records" && request.method === "GET") {
      if (mode === "LIVE") {
        const payload = await connectorRequest("/operations");
        sendJson(response, 200, {
          data: payload.data.map(publicLiveOperation),
          page: 1,
          pageSize: payload.data.length,
          totalItems: payload.data.length,
          source: "salesforce",
          refreshedAt: new Date().toISOString(),
          pending: payload.pending,
          failed: payload.failed
        });
        return;
      }
      const state = await readState();
      const search = (url.searchParams.get("search") ?? "").trim().toLowerCase();
      const filtered = search.length > 0 ? state.records.filter((record) => record.name.toLowerCase().includes(search)) : state.records;
      sendJson(response, 200, {
        data: filtered.map(publicSampleRecord),
        page: 1,
        pageSize: filtered.length,
        totalItems: filtered.length,
        source: "sample",
        refreshedAt: new Date().toISOString(),
        pending: 0,
        failed: 0
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
      if (mode === "LIVE") {
        const result = await createLiveOperation(value);
        log("live operation queued", { operationKey: value.operationKey, created: result.created });
        sendJson(response, result.created ? 201 : 200, {
          ...publicLiveOperation(result.operation),
          duplicate: !result.created
        });
        return;
      }
      const result = await createSampleRecord(value);
      sendJson(response, result.created ? 201 : 200, { ...publicSampleRecord(result.record), duplicate: !result.created });
      return;
    }

    const retryMatch = /^\/api\/records\/([A-Za-z0-9:_-]{4,140})\/retry$/.exec(pathname);
    if (retryMatch && request.method === "POST") {
      if (mode !== "LIVE") {
        sendJson(response, 400, { error: { code: "DEMO_SAMPLE_MODE", message: "Sample mode has no external sync to retry." } });
        return;
      }
      const payload = await connectorRequest(`/operations/${encodeURIComponent(retryMatch[1])}/retry`, { method: "POST", body: JSON.stringify({}) });
      sendJson(response, 200, publicLiveOperation(payload.operation));
      return;
    }

    const deleteAccountMatch = /^\/api\/accounts\/([A-Za-z0-9]{4,120})$/.exec(pathname);
    if (deleteAccountMatch && request.method === "DELETE") {
      const accountId = deleteAccountMatch[1];
      if (mode === "LIVE") {
        const body = await readJsonBody(request);
        const contactId = typeof body?.contactId === "string" && body.contactId.trim().length > 3 ? body.contactId.trim() : null;
        await connectorRequest(`/accounts/${encodeURIComponent(accountId)}`, {
          method: "DELETE",
          body: JSON.stringify({ contactId })
        });
        sendJson(response, 204, null);
      } else {
        // SAMPLE mode: remove from local state
        const state = await readState();
        const before = state.accounts.length;
        state.accounts = state.accounts.filter((account) => account.id !== accountId);
        if (state.accounts.length < before) {
          await writeState(state);
          log("deleted sample account", { accountId });
        }
        sendJson(response, 204, null);
      }
      return;
    }

    if (pathname.startsWith("/api/")) {
      sendJson(response, 404, { error: { code: "DEMO_ENDPOINT_NOT_FOUND", message: "Unknown demo endpoint." } });
      return;
    }

    await serveStatic(response, pathname);
  } catch (error) {
    log("request failed", { path: pathname, message: error instanceof Error ? error.message : String(error) });
    sendFailure(response, error);
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
