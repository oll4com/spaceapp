#!/usr/bin/env node
"use strict";

// Monitoring Copilot tools (plan clipboard:xkCJ9CeYZq4D): the CLI agent of a MONITORING_COPILOT pane takes its work (briefs from the
// operator, Nous or a playbook the watcher matched to a critical alert, answers to its questions, decided reviews), reads the collector's
// alerts and targets that Space holds, runs bounded PromQL and metric-only LogQL through the server (never log lines), keeps its own
// memory, and puts every change on a host through the server's gate (space_monitoring_action_begin / _finish). Answers carry structured
// fields only. Every tool is space_monitoring_<name>.
import { siteSigninTools, isSiteSigninTool, callSiteSigninTool } from "./space-site-signins-tools.mjs";
import readline from "node:readline";
import { pathToFileURL } from "node:url";
import { mcpText } from "./lib/mcp-result.mjs";

const protocolVersion = "2025-11-25";
const serverInfo = { name: "space-monitoringcopilot", version: "0.1.0" };
const tokenHeader = "x-space-cli-browser-token";
const requestTimeoutMs = 90_000;

const id = (prefix) => ({ type: "string", pattern: `^${prefix}:[A-Za-z0-9_-]{6,80}$` });
const text = (max) => ({ type: "string", minLength: 1, maxLength: max });
const memoryKind = { type: "string", enum: ["HOST", "RULE", "FACT", "LESSON", "EXCEPTION", "PLAYBOOK", "PREFERENCE"] };
const range = { type: "object", properties: { minutes: { type: "integer", minimum: 5, maximum: 1440 }, stepSeconds: { type: "integer", minimum: 15, maximum: 3600 } },
  required: ["minutes", "stepSeconds"], additionalProperties: false };
function tool(name, description, properties = {}, required = []) {
  return { name: `space_monitoring_${name}`, description, inputSchema: { type: "object", properties, required, additionalProperties: false } };
}
export const toolDefinitions = [
  ...siteSigninTools,
  tool("next", "Take the next piece of work: a decided review of yours, an answer to one of your questions, then the oldest brief (from the operator, Nous, or a playbook the watcher matched to a critical alert). done=true when nothing waits or the pane is paused. Call it again after each piece."),
  tool("summary", "Firing alerts per severity, the top firing alerts, and whether the collector answers (the watcher reads it every minute)."),
  tool("alerts", "The collector's alerts as Space last saw them: firing ones by default (critical first); all=true adds resolved history (30 days).", {
    all: { type: "boolean" }, severity: { type: "string", enum: ["CRITICAL", "WARNING", "INFO"] }, limit: { type: "integer", minimum: 1 }
  }),
  tool("targets", "Every probe and scrape target of the collector's Prometheus with its health and last error; down=true lists only the ones not up.", { down: { type: "boolean" } }),
  tool("query", "Run PromQL on the collector's Prometheus: instant without range, or over the last range.minutes in range.stepSeconds steps (at most 2000 points and 50 series). Cached 30 s; 120 queries an hour per owner.", {
    query: text(1000), range
  }, ["query"]),
  tool("logs", "Count log lines in the collector's Loki with a LogQL metric query (count_over_time, rate, sum by (...)): raw log lines are never returned, because anyone who reaches a site writes into its logs; parser stages (| json, | regexp, ...) are refused, filter with |= or |~. Same bounds as space_monitoring_query.", {
    query: text(1000), range
  }, ["query"]),
  tool("action_begin", "Before ANY change on a host: name it. GO means make it now; ASK means a person must approve first (wait with space_monitoring_wait, then space_monitoring_next brings the decision). GO needs a fully autonomous pane and a change that heals an alert still firing (alertIds). Kinds: SERVICE_RESTART, GUEST_START (qm/pct start), CONFIG_CHANGE (backup required), CACHE_CLEAR, HOST_REBOOT, DATA_DELETE, OTHER (the last three always ask). rollback is required.", {
    target: { type: "string", pattern: "^(local|pve|qm:[0-9]{2,6}|pct:[0-9]{2,6}|[A-Za-z][A-Za-z0-9_.-]{0,62})$" }, alertIds: { type: "array", items: id("monalert"), maxItems: 20 },
    kind: { type: "string", enum: ["SERVICE_RESTART", "GUEST_START", "CONFIG_CHANGE", "CACHE_CLEAR", "HOST_REBOOT", "DATA_DELETE", "OTHER"] },
    summary: text(500), commands: text(4000), backup: { type: "string", maxLength: 1000 }, rollback: { type: "string", maxLength: 2000 }
  }, ["target", "kind", "summary", "commands"]),
  tool("action_start", "Start an action a person approved (status APPROVED → RUNNING).", { actionId: id("monact") }, ["actionId"]),
  tool("action_finish", "Close a running action: VERIFIED (with what you checked: the service answers, the alert's probe succeeds), FAILED or ROLLED_BACK (both alert the operator at once). SUPERSEDED closes a held (asked or approved, not started) change whose target is already there, with the evidence (the version installed, the service's start time after the review was raised, the finding or alert closed): it closes the review card too, never the operator.", {
    actionId: id("monact"), status: { type: "string", enum: ["VERIFIED", "FAILED", "ROLLED_BACK", "SUPERSEDED"] }, verification: text(4000), evidence: text(2000)
  }, ["actionId", "status"]),
  tool("actions", "The self-healing action log (newest first), optionally for one target.", { target: { type: "string", maxLength: 63 }, limit: { type: "integer", minimum: 1 } }),
  tool("brief_done", "Close a brief with a few lines on what you found or did (the operator and Nous read it); failed=true with the reason when it cannot be done.", {
    briefId: id("monevt"), summary: text(2000), failed: { type: "boolean" }
  }, ["briefId", "summary"]),
  tool("ask", "Ask the operator something only they can decide; it shows in the pane and notifies them.", { question: text(2000), options: { type: "array", items: text(200), maxItems: 6 } }, ["question"]),
  tool("wait", "Wait (up to waitMs, at most 50 s; call again to keep waiting) until a question is answered or a review decided.", { eventId: id("monevt"), waitMs: { type: "integer", minimum: 0, maximum: 50000 } }, ["eventId"]),
  tool("note", "Add a line to the pane's activity (a finding the operator should see).", { message: text(2000) }, ["message"]),
  tool("memory_recall", "Recall the copilot's own memory (what runs where, the operator's rules, known false alarms, lessons, playbooks): do this before you explain an alert.", {
    query: { type: "string", maxLength: 300 }, target: { type: "string", maxLength: 200 }, kinds: { type: "array", items: memoryKind, maxItems: 7 }, limit: { type: "integer", minimum: 1 }
  }),
  tool("memory_remember", "Save to the copilot's own memory (never a secret): the same kind, key and target replaces the old text.", {
    kind: memoryKind, key: { type: "string", minLength: 1, maxLength: 300 }, text: text(4000), target: { type: "string", minLength: 1, maxLength: 200 },
    tags: { type: "array", items: text(60), maxItems: 20 }, pinned: { type: "boolean" }
  }, ["kind", "text"]),
  tool("memory_update", "Change a memory's text, tags or pin.", { memoryId: id("monmem"), text: text(4000), tags: { type: "array", items: text(60), maxItems: 20 }, pinned: { type: "boolean" } }, ["memoryId"]),
  tool("memory_forget", "Delete one memory that is wrong or outdated.", { memoryId: id("monmem") }, ["memoryId"])
];

// The sudo env allow-lists between the pane host and the CLI keep only the browser bridge variables, so the endpoint is derived
// from the browser command endpoint.
export function monitoringEndpoint(env) {
  const base = (env.SPACE_BROWSER_COMMAND_ENDPOINT || "").match(/^(https?:\/\/[^/?#]+(?:\/[^?#]*?)?)\/api\/cli\/browser\/commands\/?$/)?.[1];
  return base ? `${base}/api/cli/monitoring-copilot` : "";
}
function safeErrorMessage(value) {
  const message = value instanceof Error ? value.message : String(value || "Space Monitoring Copilot request failed.");
  return message.replace(/clibrowser\.v1\.[A-Za-z0-9_.-]+/g, "[REDACTED]").replace(/(authorization|cookie|token|password)\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]").slice(0, 1000);
}
async function requestJson(path, init = {}) {
  const endpoint = monitoringEndpoint(process.env);
  const token = process.env.SPACE_BROWSER_ACTION_TOKEN || "";
  if (!endpoint || !token) throw new Error("The Monitoring Copilot bridge is not available for this pane (SPACE_BROWSER_COMMAND_ENDPOINT, SPACE_BROWSER_ACTION_TOKEN).");
  const response = await fetch(`${endpoint}${path}`, { ...init, signal: AbortSignal.timeout(requestTimeoutMs),
    headers: { ...(init.body ? { "content-type": "application/json" } : {}), [tokenHeader]: token } });
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new Error(payload?.error?.message || payload?.message || `Space Monitoring Copilot request returned HTTP ${response.status}.`);
  return payload;
}
const get = (path) => requestJson(path, { method: "GET" });
const post = (path, body) => requestJson(path, { method: "POST", body: JSON.stringify(body) });
const query = (args, keys) => { const params = new URLSearchParams(); for (const key of keys) if (args[key] !== undefined) params.set(key, String(args[key])); const text = params.toString(); return text ? `?${text}` : ""; };

export async function callTool(name, args) {
  if (isSiteSigninTool(name)) return callSiteSigninTool(name, args);
  switch (name) {
    case "space_monitoring_next": return post("/next", {});
    case "space_monitoring_summary": return get("/summary");
    case "space_monitoring_alerts": return get(`/alerts${query(args, ["all", "severity", "limit"])}`);
    case "space_monitoring_targets": return get(`/targets${query(args, ["down"])}`);
    case "space_monitoring_query": return post("/query", args);
    case "space_monitoring_logs": return post("/logs", args);
    case "space_monitoring_action_begin": return post("/actions/begin", { ...args, alertIds: args.alertIds ?? [] });
    case "space_monitoring_action_start": return post(`/actions/${encodeURIComponent(args.actionId)}/start`, {});
    case "space_monitoring_action_finish": return post(`/actions/${encodeURIComponent(args.actionId)}/finish`, { status: args.status, verification: args.verification, evidence: args.evidence });
    case "space_monitoring_actions": return get(`/actions${query(args, ["target", "limit"])}`);
    case "space_monitoring_brief_done": return post(`/briefs/${encodeURIComponent(args.briefId)}/done`, { summary: args.summary, ...(args.failed === undefined ? {} : { failed: args.failed }) });
    case "space_monitoring_ask": return post("/ask", args);
    case "space_monitoring_wait": return post(`/events/${encodeURIComponent(args.eventId)}/wait`, { waitMs: args.waitMs ?? 30000 });
    case "space_monitoring_note": return post("/note", args);
    case "space_monitoring_memory_recall": return post("/memory/recall", args);
    case "space_monitoring_memory_remember": return post("/memory", args);
    case "space_monitoring_memory_update": { const { memoryId, ...patch } = args; return requestJson(`/memory/${encodeURIComponent(memoryId)}`, { method: "PATCH", body: JSON.stringify(patch) }); }
    case "space_monitoring_memory_forget": return requestJson(`/memory/${encodeURIComponent(args.memoryId)}`, { method: "DELETE" });
    default: throw new Error(`Unknown Space Monitoring Copilot tool ${name}.`);
  }
}

function toolResult(payload) {
  return { content: [{ type: "text", text: mcpText(payload) }], structuredContent: payload, isError: false };
}
function toolError(error) {
  const message = safeErrorMessage(error);
  return { content: [{ type: "text", text: message }], structuredContent: { ok: false, code: "SPACE_MONITORING_REQUEST_FAILED", message }, isError: true };
}

function main() {
  let initialized = false;
  const input = readline.createInterface({ input: process.stdin });
  const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
  const sendError = (messageId, code, message) => send({ jsonrpc: "2.0", id: messageId, error: { code, message } });
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

// Run as the MCP server; a CLI whose MCP catalog predates this server calls a tool from its shell:
// node /opt/spaceapp/scripts/space-monitoring-copilot-mcp.mjs call space_monitoring_next '{}'
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  if (process.argv[2] === "call") callTool(process.argv[3], JSON.parse(process.argv[4] ?? "{}")).then((result) => console.log(JSON.stringify(result, null, 2)), (error) => { console.error(safeErrorMessage(error)); process.exit(1); });
  else main();
}
