import { Writable } from "node:stream";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { InMemorySpaceStore, MetricsRegistry, SpaceNotFoundError } from "@space/runtime";
import { parseTraceparent, traceLookupResponseSchema, type DummyTurnInput } from "@space/contracts";
import { createApp } from "../src/app.js";
import { TemporalCodexAppServerTurnStarter } from "../src/turns.js";
import type { TemporalClientFactory } from "../src/temporal-client.js";
// Worker code paths, exercised in-process exactly as the Temporal worker runs them.
import { runCodexAppServerTurn } from "../../worker/src/activities.js";
import { observeActivityExecution } from "../../worker/src/activity-observability.js";
import { captureWorkerLogs } from "../../worker/src/worker-log.js";
import { createWorkerMetrics } from "../../worker/src/worker-metrics.js";

/**
 * Fault injection, end to end: HTTP request -> API turn starter -> (mocked)
 * Temporal client -> worker activity with an injected executor fault ->
 * durable failure record -> admin trace lookup. One id (the API request id,
 * `traceId`) reaches the causal error code and category everywhere, and no
 * prompt, credential or path leaves through logs, metrics or the lookup.
 */
const csrfHeaderName = "x-space-csrf-token";
const inboundTraceId = "0af7651916cd43dd8448eb211c80319c";
const inboundTraceparent = `00-${inboundTraceId}-b7ad6b7169203331-01`;
const secrets = ["PRIVATE PROMPT about the merger", "sk-live-fault-injection-secret-42", "/home/operator/private-repo"];
const codexEnv = {
  SPACE_ENABLE_CODEX_TURNS: "true",
  SPACE_CODEX_APP_SERVER_ENABLED: "true",
  SPACE_CODEX_APP_SERVER_TRANSPORT: "stdio",
  SPACE_CODEX_APP_SERVER_ALLOW_STDIO_SPAWN: "true",
  SPACE_CODEX_APP_SERVER_ALLOW_TURN_EXECUTION: "true"
};

type StartCall = { workflowType: string; options: { args: DummyTurnInput[]; memo: Record<string, string>; workflowId: string } };

let app: Awaited<ReturnType<typeof createApp>>;
let store: InMemorySpaceStore;
let cookie: string;
let csrfToken: string;
let roomId: string;
let paneId: string;
const starts: StartCall[] = [];
// The API's own log lines (1.1.7 review, Codex #9: the start failure's secret reached the log while the test passed).
const apiLog: string[] = [];
let startFailure: Error | null = null;

beforeAll(async () => {
  store = new InMemorySpaceStore();
  const room = store.createRoom({ name: "Fault injection", initialPaneCount: 1 }, "trace:seed-fault");
  const pane = store.listPanes(room.id)[0]!;
  roomId = room.id;
  paneId = pane.id;
  const clientFactory: TemporalClientFactory = async () => ({
    client: {
      workflow: {
        start: vi.fn(async (workflowType: string, options: StartCall["options"]) => {
          if (startFailure) throw startFailure;
          starts.push({ workflowType, options });
          return { workflowId: options.workflowId, firstExecutionRunId: `run-${starts.length}` };
        })
      }
    } as never,
    close: async () => undefined
  });
  app = await createApp({
    logStream: new Writable({ write(chunk, _encoding, callback) { apiLog.push(String(chunk)); callback(); } }),
    store,
    codexTurnStarter: new TemporalCodexAppServerTurnStarter({ address: "unused", namespace: "default", taskQueue: "space-test", clientFactory }),
    auth: { sessionSecret: "fault-injection-session-secret-123", devLogin: true, secureCookies: false }
  });
  const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "space@space.local", password: "space-dev" } });
  cookie = `space_session=${login.cookies.find((entry) => entry.name === "space_session")?.value}`;
  csrfToken = (await app.inject({ method: "GET", url: "/api/auth/csrf", headers: { cookie } })).json().csrfToken as string;
}, 60_000);

afterAll(async () => { await app?.close(); }, 90_000);
afterEach(() => { startFailure = null; vi.restoreAllMocks(); });

async function queueTurn() {
  return app.inject({
    method: "POST",
    url: "/api/turns",
    headers: { cookie, [csrfHeaderName]: csrfToken, traceparent: inboundTraceparent },
    payload: { roomId, paneId, prompt: `${secrets[0]} ${secrets[1]} ${secrets[2]}`, runtime: "CODEX_APP_SERVER" }
  });
}

async function traceLookup(traceId: string) {
  const response = await app.inject({ method: "GET", url: `/api/admin/traces/${encodeURIComponent(traceId)}`, headers: { cookie } });
  expect(response.statusCode).toBe(200);
  return traceLookupResponseSchema.parse(response.json());
}

function expectNoSecrets(label: string, text: string) {
  for (const secret of secrets) expect(text, `${label} leaked ${secret}`).not.toContain(secret);
  expect(text, `${label} leaked a private path`).not.toContain("private-repo");
}

describe("observability fault injection", () => {
  it.each([
    { fault: "missing executable", error: () => new Error(`spawn codex ENOENT ${secrets[2]}`), code: "CODEX_APP_SERVER_COMMAND_UNAVAILABLE", category: "TOOL_UNAVAILABLE" },
    { fault: "executor timeout", error: () => new Error(`Codex turn timed out after 900000ms ${secrets[1]}`), code: "CODEX_APP_SERVER_TURN_TIMEOUT", category: "TIMEOUT" },
    { fault: "protocol error", error: () => new Error("invalid JSON from app server"), code: "CODEX_APP_SERVER_PROTOCOL_ERROR", category: "PROTOCOL_ERROR" },
    { fault: "missing execution state", error: () => new SpaceNotFoundError(`Pane ${secrets[2]} was not found.`), code: "SPACE_EXECUTION_STATE_UNAVAILABLE", category: "STATE_UNAVAILABLE" }
  ])("follows a $fault from the request id to its causal error", async ({ error, code, category }) => {
    // 1. API: the request id is the trace id; the inbound W3C trace is continued.
    const queued = await queueTurn();
    expect(queued.statusCode).toBe(200);
    const traceId = queued.headers["x-request-id"] as string;
    expect(queued.json().traceId).toBe(traceId);

    // 2. Temporal (mocked client): workflow id, input and memo carry both ids.
    const start = starts.at(-1)!;
    expect(start.workflowType).toBe("codexAppServerTurnWorkflow");
    expect(start.options.workflowId).toContain(traceId);
    expect(start.options.memo).toMatchObject({ spaceTraceId: traceId, w3cTraceId: inboundTraceId });
    const turnInput = start.options.args[0]!;
    expect(turnInput.traceId).toBe(traceId);
    expect(parseTraceparent(turnInput.traceparent)?.traceId).toBe(inboundTraceId);

    // 3. Worker: the real activity code path with an injected executor fault.
    const lines: string[] = [];
    const restore = captureWorkerLogs((line) => lines.push(line));
    const turnLog = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const metrics = createWorkerMetrics(new MetricsRegistry());
    let result;
    try {
      result = await observeActivityExecution(
        {
          activityType: "runCodexAppServerTurn",
          activityId: "1",
          attempt: 1,
          workflowType: "codexAppServerTurnWorkflow",
          workflowExecution: { workflowId: start.options.workflowId, runId: "temporal-run-e2e" },
          currentAttemptScheduledTimestampMs: Date.now() - 20
        },
        [turnInput],
        () => runCodexAppServerTurn(turnInput, {
          completionStore: store,
          env: codexEnv,
          executeStdioTurn: async () => { throw error(); }
        }),
        { metrics }
      );
    } finally {
      restore();
    }
    expect(result.status).toBe("FAILED");

    const activityRecords = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(activityRecords.at(-1)).toMatchObject({
      event: "activity.finished",
      outcome: "FAILED_RESULT",
      traceId,
      w3cTraceId: inboundTraceId,
      workflowId: start.options.workflowId,
      temporalRunId: "temporal-run-e2e",
      reasonCode: code,
      category
    });
    const turnRecords = turnLog.mock.calls.map(([value]) => JSON.parse(String(value)) as Record<string, unknown>);
    expect(turnRecords).toContainEqual(expect.objectContaining({
      event: "turn.activity", phase: "FINISHED", status: "FAILED", traceId, w3cTraceId: inboundTraceId, reasonCode: code, category
    }));
    const workerMetricsText = metrics.registry.render();
    expect(workerMetricsText).toContain(
      `space_worker_activity_failures_total{activity_type="runCodexAppServerTurn",category="${category}",code="${code}"} 1`
    );

    // 4. Durable records: the same id finds the causal error via the admin API.
    const trace = await traceLookup(traceId);
    expect(trace.causalError).toMatchObject({ code, category, source: "event:TURN_FAILED", workflowId: start.options.workflowId });
    expect(trace.events.map((event) => event.type).sort()).toEqual(["TURN_FAILED", "TURN_STARTED"]);
    expect(trace.workflows).toEqual([expect.objectContaining({ workflowId: start.options.workflowId, status: "FAILED" })]);
    expect(trace.auditEvents.map((audit) => audit.action)).toContain("turn.queue");
    expect(trace.logQueries.worker).toContain(traceId);

    // 5. Redaction: nothing private in logs, metrics or the lookup.
    const apiMetrics = (await app.inject({ url: "/metrics" })).body;
    expectNoSecrets("worker activity log", lines.join("\n"));
    expectNoSecrets("turn log", JSON.stringify(turnRecords));
    expectNoSecrets("worker metrics", workerMetricsText);
    expectNoSecrets("API metrics", apiMetrics);
    expectNoSecrets("trace lookup", JSON.stringify(trace));
  }, 60_000);

  it("classifies a Temporal start failure in the response, the durable record and metrics", async () => {
    startFailure = Object.assign(new Error(`14 UNAVAILABLE: connect ECONNREFUSED 10.9.8.7:7233 ${secrets[1]}`), { name: "ServiceError" });
    const response = await queueTurn();
    expect(response.statusCode).toBe(500);
    const traceId = response.headers["x-request-id"] as string;
    expect(response.json().error).toMatchObject({ code: "INTERNAL_ERROR", requestId: traceId });
    expectNoSecrets("error response", response.body);

    const trace = await traceLookup(traceId);
    expect(trace.causalError).toMatchObject({ code: "TEMPORAL_UNAVAILABLE", category: "UPSTREAM_UNAVAILABLE" });
    const metrics = (await app.inject({ url: "/metrics" })).body;
    expect(metrics).toMatch(/space_temporal_workflow_starts_total\{workflow_type="codexAppServerTurnWorkflow",outcome="FAILED",category="UPSTREAM_UNAVAILABLE"\} [1-9]/);
    expect(metrics).toMatch(/space_http_error_responses_total\{code="INTERNAL_ERROR",category="INTERNAL",status_class="5xx"\} [1-9]/);
    expectNoSecrets("API metrics", metrics);
    expect(metrics).not.toContain("10.9.8.7");
    const logged = apiLog.join("");
    expect(logged).toContain("14 UNAVAILABLE");
    expect(logged).not.toContain(secrets[1]);
  }, 60_000);

  it("rejects trace lookups from non-administrators and malformed ids", async () => {
    expect((await app.inject({ url: "/api/admin/traces/req:abcdefghijkl" })).statusCode).toBe(401);
    const malformed = await app.inject({ url: `/api/admin/traces/${encodeURIComponent("req:has spaces")}`, headers: { cookie } });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json().error.code).toBe("INVALID_TRACE_ID");
  });
});
