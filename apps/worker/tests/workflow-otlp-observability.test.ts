import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { defaultPayloadConverter, Worker } from "@temporalio/worker";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import {
  formatTraceparent,
  parseTraceparent
} from "@space/contracts";
import {
  ALLOWED_SPAN_ATTRIBUTE_KEYS,
  createOtlpSpanExporter,
  sanitizeSpanAttributes,
  type SpanExporter
} from "@space/runtime";
import {
  createActivityObservabilityInterceptors,
  noteActivityFailureReason,
  observeActivityExecution
} from "../src/activity-observability.js";
import {
  createWorkflowObservabilitySinks,
  recordWorkflowSpan,
  rememberActiveWorkflowTrace,
  workflowObservabilityInterceptorPath
} from "../src/workflow-observability.js";
import {
  continuationSpanId,
  extractWorkflowInputMetadata,
  WORKFLOW_CONTINUED_TRACEPARENT_HEADER,
  WORKFLOW_TRACEPARENT_HEADER,
  workflowSpanId
} from "../src/workflow-observability-interceptors.js";

interface OtlpJsonAttribute {
  key: string;
  value: { stringValue?: string; intValue?: string };
}

interface OtlpJsonLink {
  traceId: string;
  spanId: string;
  attributes?: OtlpJsonAttribute[];
}

interface OtlpJsonSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: OtlpJsonAttribute[];
  links?: OtlpJsonLink[];
  status: { code: number };
}

function attrMap(attrs: readonly OtlpJsonAttribute[] | undefined): Record<string, string | number> {
  const map: Record<string, string | number> = {};
  for (const item of attrs ?? []) {
    if (item.value.intValue !== undefined) map[item.key] = Number(item.value.intValue);
    else if (item.value.stringValue !== undefined) map[item.key] = item.value.stringValue;
  }
  return map;
}

async function startFakeOtlpCollector() {
  const batches: Array<{ serviceName: string; spans: OtlpJsonSpan[] }> = [];
  const rawPayloads: string[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.method === "POST" && req.url === "/v1/traces") {
      let body = "";
      req.on("data", (chunk) => { body += String(chunk); });
      req.on("end", () => {
        rawPayloads.push(body);
        const parsed = JSON.parse(body) as {
          resourceSpans?: Array<{
            resource?: { attributes?: OtlpJsonAttribute[] };
            scopeSpans?: Array<{ spans?: OtlpJsonSpan[] }>;
          }>;
        };
        for (const rs of parsed.resourceSpans ?? []) {
          const serviceName = String(attrMap(rs.resource?.attributes)["service.name"] ?? "");
          for (const ss of rs.scopeSpans ?? []) {
            batches.push({ serviceName, spans: ss.spans ?? [] });
          }
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{}");
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Failed to bind fake OTLP collector");
  const endpoint = `http://127.0.0.1:${address.port}`;

  return {
    endpoint,
    batches,
    rawPayloads,
    allSpans: () => batches.flatMap((b) => b.spans),
    close: () => new Promise<void>((resolve) => server.close(() => resolve()))
  };
}

const activeExporters: SpanExporter[] = [];
afterEach(async () => {
  await Promise.all(activeExporters.splice(0).map((e) => e.close()));
});

describe("OTLP workflow and activity trace tree (#61)", () => {
  const w3cTraceId = "4bf92f3577b34da6a3ce929d0e0e4736";
  const apiSpanId = "00f067aa0ba902b7";
  const apiTraceparent = formatTraceparent(w3cTraceId, apiSpanId, "01");
  const sensitivePrompt = "PRIVATE PROMPT sk-live-secret-token-999 /Users/operator/secret.txt https://internal.local/secret?key=1";

  it("enforces the strict attribute allowlist and strips prompts, paths, URLs, error messages and secrets", () => {
    const dirty: Record<string, string | number> = {
      "space.trace_id": "req:abcdefghijkl",
      "space.workflow_type": "codexAppServerTurnWorkflow",
      "space.activity_type": "runCodexAppServerTurn",
      "space.attempt": 2,
      "space.outcome": "FAILED",
      "space.reason_code": "CODEX_APP_SERVER_TURN_TIMEOUT",
      "space.category": "TIMEOUT",
      "space.duration_ms": 145,
      "space.room_id": "room:alpha",
      "space.pane_id": "pane:beta",
      "space.mission_id": "mission:gamma",
      "prompt": sensitivePrompt,
      "error.message": "Connection refused to 10.0.0.12 with sk-live-secret",
      "file.path": "/Users/operator/secret.txt",
      "url.full": "https://internal.local/secret?key=1",
      "space.agent_run_id": sensitivePrompt
    };

    const cleaned = sanitizeSpanAttributes(dirty);
    expect(Object.keys(cleaned).every((k) => ALLOWED_SPAN_ATTRIBUTE_KEYS.has(k))).toBe(true);
    expect(cleaned).toEqual({
      "space.trace_id": "req:abcdefghijkl",
      "space.workflow_type": "codexAppServerTurnWorkflow",
      "space.activity_type": "runCodexAppServerTurn",
      "space.attempt": 2,
      "space.outcome": "FAILED",
      "space.reason_code": "CODEX_APP_SERVER_TURN_TIMEOUT",
      "space.category": "TIMEOUT",
      "space.duration_ms": 145,
      "space.room_id": "room:alpha",
      "space.pane_id": "pane:beta",
      "space.mission_id": "mission:gamma"
    });
    expect(JSON.stringify(cleaned)).not.toMatch(/PRIVATE PROMPT|sk-live|secret\.txt|internal\.local/);
  });

  it("connects API SERVER span -> workflow span -> retrying activity attempts -> child workflow span in one OTLP trace", async () => {
    const collector = await startFakeOtlpCollector();
    try {
      const apiExporter = createOtlpSpanExporter({
        endpoint: collector.endpoint,
        serviceName: "space-api",
        flushIntervalMs: 60_000
      });
      const workerExporter = createOtlpSpanExporter({
        endpoint: collector.endpoint,
        serviceName: "space-worker",
        flushIntervalMs: 60_000
      });
      activeExporters.push(apiExporter, workerExporter);

      // 1. API records SERVER span
      apiExporter.record({
        traceId: w3cTraceId,
        spanId: apiSpanId,
        parentSpanId: null,
        name: "POST /api/turns",
        startTimeUnixNano: 1_700_000_000_000_000_000n,
        endTimeUnixNano: 1_700_000_000_050_000_000n,
        attributes: {
          "http.request.method": "POST",
          "http.route": "/api/turns",
          "http.response.status_code": 200,
          "space.request_id": "req:turn00000001"
        },
        error: false,
        kind: 2
      });

      // 2. Parent workflow (`memoryMaintenanceWorkflow`) starts under the API span's traceparent
      const parentWfId = "space-memory-maintenance:2026-10-28";
      const parentRunId = "run-parent-1";
      const parentWfSpanId = workflowSpanId(parentWfId, parentRunId);
      const parentWfTraceparent = formatTraceparent(w3cTraceId, parentWfSpanId, "01");

      const sinks = createWorkflowObservabilitySinks({ spans: workerExporter, now: () => 1_700_000_000_100 });
      sinks.workflowObservability.workflowStarted.fn(
        { workflowId: parentWfId, runId: parentRunId, runStartTime: new Date(1_700_000_000_050) } as never,
        parentWfSpanId,
        parentWfTraceparent,
        { "space.trace_id": "req:turn00000001", "space.room_id": "room:1" }
      );

      // 3. Activity attempt 1 (fails with TIMEOUT) and attempt 2 (succeeds) run as children of parentWfSpanId
      const wfHeaders = {
        [WORKFLOW_TRACEPARENT_HEADER]: defaultPayloadConverter.toPayload(parentWfTraceparent)
      };
      const actInfo = (attempt: number) => ({
        activityType: "refreshMemoryGraphSnapshot",
        activityId: "act-1",
        attempt,
        workflowType: "memoryMaintenanceWorkflow",
        workflowExecution: { workflowId: parentWfId, runId: parentRunId },
        currentAttemptScheduledTimestampMs: 1_700_000_000_060
      });

      await observeActivityExecution(
        actInfo(1),
        [{ scheduledAt: "2026-10-28T00:00:00.000Z", traceId: "req:turn00000001", prompt: sensitivePrompt }],
        async () => {
          noteActivityFailureReason("CODEX_APP_SERVER_TURN_TIMEOUT");
          return { status: "FAILED" };
        },
        { spans: workerExporter, headers: wfHeaders, now: () => 1_700_000_000_080 }
      );

      await observeActivityExecution(
        actInfo(2),
        [{ scheduledAt: "2026-10-28T00:00:00.000Z", traceId: "req:turn00000001", prompt: sensitivePrompt }],
        async () => ({ status: "REFRESHED" }),
        { spans: workerExporter, headers: wfHeaders, now: () => 1_700_000_000_095 }
      );

      // 4. Child workflow (`memoryConsolidationWorkflow`) nests under `parentWfSpanId`
      const childWfId = "space-memory-consolidation:scheduled:2026-10-28";
      const childRunId = "run-child-1";
      const childWfSpanId = workflowSpanId(childWfId, childRunId);
      sinks.workflowObservability.workflowStarted.fn(
        { workflowId: childWfId, runId: childRunId, runStartTime: new Date(1_700_000_000_096) } as never,
        childWfSpanId,
        formatTraceparent(w3cTraceId, childWfSpanId, "01"),
        { "space.trace_id": "req:turn00000001" }
      );
      sinks.workflowObservability.workflowFinished.fn(
        { workflowId: childWfId, runId: childRunId } as never,
        {
          traceId: w3cTraceId,
          spanId: childWfSpanId,
          parentSpanId: parentWfSpanId,
          workflowType: "memoryConsolidationWorkflow",
          workflowId: childWfId,
          runId: childRunId,
          parentWorkflowId: parentWfId,
          parentRunId: parentRunId,
          continuedFromRunId: null,
          outcome: "COMPLETED",
          reasonCode: null,
          category: null,
          correlation: { "space.trace_id": "req:turn00000001" },
          links: []
        }
      );

      // 5. Parent workflow finishes
      sinks.workflowObservability.workflowFinished.fn(
        { workflowId: parentWfId, runId: parentRunId } as never,
        {
          traceId: w3cTraceId,
          spanId: parentWfSpanId,
          parentSpanId: apiSpanId,
          workflowType: "memoryMaintenanceWorkflow",
          workflowId: parentWfId,
          runId: parentRunId,
          parentWorkflowId: null,
          parentRunId: null,
          continuedFromRunId: null,
          outcome: "COMPLETED",
          reasonCode: null,
          category: null,
          correlation: { "space.trace_id": "req:turn00000001", "space.room_id": "room:1" },
          links: []
        }
      );

      await apiExporter.flush();
      await workerExporter.flush();

      const spans = collector.allSpans();
      expect(spans).toHaveLength(5);
      for (const s of spans) {
        expect(s.traceId).toBe(w3cTraceId);
      }

      const apiSpan = spans.find((s) => s.name === "POST /api/turns")!;
      const parentWfSpan = spans.find((s) => s.name === "workflow memoryMaintenanceWorkflow")!;
      const childWfSpan = spans.find((s) => s.name === "workflow memoryConsolidationWorkflow")!;
      const activitySpans = spans.filter((s) => s.name === "activity refreshMemoryGraphSnapshot");

      expect(apiSpan.parentSpanId).toBeUndefined();
      expect(parentWfSpan.parentSpanId).toBe(apiSpan.spanId);
      expect(childWfSpan.parentSpanId).toBe(parentWfSpan.spanId);
      expect(attrMap(childWfSpan.attributes)["space.parent_workflow_id"]).toBe(parentWfId);

      expect(activitySpans).toHaveLength(2);
      const attempt1 = activitySpans.find((s) => attrMap(s.attributes)["space.attempt"] === 1)!;
      const attempt2 = activitySpans.find((s) => attrMap(s.attributes)["space.attempt"] === 2)!;

      expect(attempt1.parentSpanId).toBe(parentWfSpan.spanId);
      expect(attempt1.status.code).toBe(2);
      expect(attrMap(attempt1.attributes)).toMatchObject({
        "space.activity_type": "refreshMemoryGraphSnapshot",
        "space.attempt": 1,
        "space.outcome": "FAILED_RESULT",
        "space.reason_code": "CODEX_APP_SERVER_TURN_TIMEOUT",
        "space.category": "TIMEOUT",
        "space.trace_id": "req:turn00000001"
      });

      expect(attempt2.parentSpanId).toBe(parentWfSpan.spanId);
      expect(attempt2.status.code).toBe(0);
      expect(attrMap(attempt2.attributes)).toMatchObject({
        "space.activity_type": "refreshMemoryGraphSnapshot",
        "space.attempt": 2,
        "space.outcome": "COMPLETED",
        "space.trace_id": "req:turn00000001"
      });

      expect(collector.rawPayloads.join("\n")).not.toMatch(/PRIVATE PROMPT|sk-live|secret\.txt|internal\.local/);
    } finally {
      await collector.close();
    }
  });

  it("attaches OTLP span links for continue-as-new runs and background continuations (trace:bg-*)", async () => {
    const collector = await startFakeOtlpCollector();
    try {
      const exporter = createOtlpSpanExporter({
        endpoint: collector.endpoint,
        serviceName: "space-worker",
        flushIntervalMs: 60_000
      });
      activeExporters.push(exporter);

      const prevRunId = "run-initial-01";
      const prevSpanId = workflowSpanId("dot-goal:dot_goal:1", prevRunId);
      const sourceRunId = "agent_run:source-123";
      const bgSourceSpanId = continuationSpanId(sourceRunId);

      recordWorkflowSpan(
        {
          traceId: w3cTraceId,
          spanId: workflowSpanId("dot-goal:dot_goal:1", "run-continued-02"),
          parentSpanId: apiSpanId,
          workflowType: "dotGoalWorkflow",
          workflowId: "dot-goal:dot_goal:1",
          runId: "run-continued-02",
          parentWorkflowId: null,
          parentRunId: null,
          continuedFromRunId: prevRunId,
          outcome: "COMPLETED",
          reasonCode: null,
          category: null,
          correlation: { "space.goal_id": "dot_goal:1", "space.trace_id": "trace:bg-cont-01" },
          links: [
            {
              traceId: w3cTraceId,
              spanId: prevSpanId,
              attributes: {
                "space.link_kind": "CONTINUE_AS_NEW",
                "space.continued_from_run_id": prevRunId
              }
            },
            {
              traceId: w3cTraceId,
              spanId: bgSourceSpanId,
              attributes: {
                "space.link_kind": "BACKGROUND_CONTINUATION",
                "space.source_run_id": sourceRunId
              }
            }
          ]
        },
        { spans: exporter, startedAtMs: 1_000, now: () => 1_200 }
      );

      await exporter.flush();
      const [exported] = collector.allSpans();
      expect(exported).toBeDefined();
      expect(exported!.links).toHaveLength(2);
      expect(exported!.links![0]!.spanId).toBe(prevSpanId);
      expect(attrMap(exported!.links![0]!.attributes)).toEqual({
        "space.link_kind": "CONTINUE_AS_NEW",
        "space.continued_from_run_id": prevRunId
      });
      expect(exported!.links![1]!.spanId).toBe(bgSourceSpanId);
      expect(attrMap(exported!.links![1]!.attributes)).toEqual({
        "space.link_kind": "BACKGROUND_CONTINUATION",
        "space.source_run_id": sourceRunId
      });
    } finally {
      await collector.close();
    }
  });

  it("configures workflow sinks with callDuringReplay: false so replaying a workflow history emits zero spans", async () => {
    const recorded: unknown[] = [];
    const spans: SpanExporter = {
      record: (span) => void recorded.push(span),
      flush: async () => undefined,
      close: async () => undefined,
      stats: () => ({ exported: recorded.length, dropped: 0, failed: 0 })
    };
    const sinks = createWorkflowObservabilitySinks({ spans });
    expect(sinks.workflowObservability.workflowStarted.callDuringReplay).toBe(false);
    expect(sinks.workflowObservability.workflowFinished.callDuringReplay).toBe(false);

    // Also verify extractWorkflowInputMetadata never leaks free-text prompts
    const metadata = extractWorkflowInputMetadata([
      {
        roomId: "room:replay",
        paneId: "pane:replay",
        traceId: "trace:bg-replay1",
        traceparent: apiTraceparent,
        prompt: sensitivePrompt,
        roomAgentContinuation: { sourceRunId: "agent_run:orig1", generation: 1 }
      }
    ]);
    expect(metadata.sourceRunId).toBe("agent_run:orig1");
    expect(metadata.fields.traceId).toBe("trace:bg-replay1");
    expect(JSON.stringify(metadata)).not.toContain("PRIVATE PROMPT");
  });

  it("runs a real Temporal workflow with stub activities in @temporalio/testing and exports a connected trace to the local HTTP OTLP collector", async () => {
    // createLocal uses the Temporal CLI dev server, which has an arm64 build.
    // createTimeSkipping's Java test server does not run on Apple Silicon without Rosetta,
    // and a skipped server must fail this test rather than pass it.
    const testEnv = await TestWorkflowEnvironment.createLocal();
    const collector = await startFakeOtlpCollector();
    const workerExporter = createOtlpSpanExporter({
      endpoint: collector.endpoint,
      serviceName: "space-worker",
      flushIntervalMs: 60_000
    });
    activeExporters.push(workerExporter);

    try {
      const workflowsPath = fileURLToPath(new URL("./otlp-probe-workflows.ts", import.meta.url));
      const interceptorPath = fileURLToPath(new URL("../src/workflow-observability-interceptors.ts", import.meta.url));
      let flakyAttempts = 0;
      const activities = {
        otlpFlakyActivity: async () => {
          flakyAttempts += 1;
          if (flakyAttempts === 1) {
            throw Object.assign(new Error("transient failure sk-live-secret"), { code: "UPSTREAM_RETRYABLE_UNAVAILABLE" });
          }
          return "ok";
        },
        otlpOnceActivity: async (label: string) => label
      };

      const taskQueue = "otlp-integration-test-queue";
      const worker = await Worker.create({
        connection: testEnv.nativeConnection,
        taskQueue,
        workflowsPath,
        activities,
        interceptors: {
          activity: [createActivityObservabilityInterceptors({ spans: workerExporter })],
          workflowModules: [interceptorPath]
        },
        sinks: createWorkflowObservabilitySinks({ spans: workerExporter })
      });

      const probeInput = {
        traceparent: apiTraceparent,
        traceId: "req:otlp00000001",
        prompt: sensitivePrompt
      };

      const parentHandle = await worker.runUntil(async () => {
        const parent = await testEnv.client.workflow.start("otlpParentWorkflow", {
          taskQueue,
          workflowId: "otlp-parent:req:otlp00000001",
          args: [probeInput]
        });
        const continued = await testEnv.client.workflow.start("otlpContinueWorkflow", {
          taskQueue,
          workflowId: "otlp-continue:req:otlp00000001",
          args: [{ ...probeInput, remaining: 1 }]
        });
        const background = await testEnv.client.workflow.start("otlpBackgroundWorkflow", {
          taskQueue,
          workflowId: "otlp-background:trace:bg-cont01",
          args: [{
            ...probeInput,
            traceId: "trace:bg-cont01",
            roomAgentContinuation: { sourceRunId: "agent_run:source-123", generation: 1 }
          }]
        });
        await Promise.all([parent.result(), continued.result(), background.result()]);
        return parent;
      });

      await workerExporter.flush();
      const spans = collector.allSpans();
      const parentWf = spans.find((s) => s.name === "workflow otlpParentWorkflow")!;
      const childWf = spans.find((s) => s.name === "workflow otlpChildWorkflow")!;
      const flakySpans = spans.filter((s) => s.name === "activity otlpFlakyActivity");
      const childActivity = spans.find((s) => s.name === "activity otlpOnceActivity" && attrMap(s.attributes)["space.workflow_type"] === "otlpChildWorkflow");

      expect(parentWf).toBeDefined();
      expect(parentWf.traceId).toBe(w3cTraceId);
      expect(parentWf.parentSpanId).toBe(apiSpanId);

      expect(childWf).toBeDefined();
      expect(childWf.traceId).toBe(w3cTraceId);
      expect(childWf.parentSpanId).toBe(parentWf.spanId);

      expect(flakySpans).toHaveLength(2);
      const failedAttempt = flakySpans.find((s) => attrMap(s.attributes)["space.attempt"] === 1)!;
      const okAttempt = flakySpans.find((s) => attrMap(s.attributes)["space.attempt"] === 2)!;
      expect(failedAttempt.parentSpanId).toBe(parentWf.spanId);
      expect(failedAttempt.traceId).toBe(w3cTraceId);
      expect(attrMap(failedAttempt.attributes)["space.outcome"]).toBe("FAILED");
      expect(attrMap(failedAttempt.attributes)["space.reason_code"]).toBe("UPSTREAM_RETRYABLE_UNAVAILABLE");
      expect(okAttempt.parentSpanId).toBe(parentWf.spanId);
      expect(attrMap(okAttempt.attributes)["space.outcome"]).toBe("COMPLETED");

      expect(childActivity).toBeDefined();
      expect(childActivity!.traceId).toBe(w3cTraceId);
      expect(childActivity!.parentSpanId).toBe(childWf.spanId);

      const continueSpans = spans.filter((s) => s.name === "workflow otlpContinueWorkflow");
      expect(continueSpans).toHaveLength(2);
      for (const span of continueSpans) {
        expect(span.traceId).toBe(w3cTraceId);
        expect(span.parentSpanId).toBe(apiSpanId);
      }
      const continued = continueSpans.find((s) => (s.links ?? []).some((link) => attrMap(link.attributes)["space.link_kind"] === "CONTINUE_AS_NEW"));
      expect(continued).toBeDefined();
      const continueLink = continued!.links!.find((link) => attrMap(link.attributes)["space.link_kind"] === "CONTINUE_AS_NEW")!;
      expect(continueLink.traceId).toBe(w3cTraceId);
      expect(continueSpans.some((s) => s.spanId === continueLink.spanId)).toBe(true);

      const background = spans.find((s) => s.name === "workflow otlpBackgroundWorkflow");
      expect(background).toBeDefined();
      expect(background!.traceId).not.toBe(w3cTraceId);
      const bgLink = background!.links?.find((link) => attrMap(link.attributes)["space.link_kind"] === "BACKGROUND_CONTINUATION");
      expect(bgLink).toBeDefined();
      expect(bgLink!.traceId).toBe(w3cTraceId);
      expect(bgLink!.spanId).toBe(apiSpanId);
      expect(attrMap(bgLink!.attributes)["space.source_run_id"]).toBe("agent_run:source-123");
      const bgActivity = spans.find((s) => s.name === "activity otlpOnceActivity" && s.traceId === background!.traceId);
      expect(bgActivity?.parentSpanId).toBe(background!.spanId);

      const countBeforeReplay = collector.allSpans().length;
      const history = await parentHandle.fetchHistory();
      await Worker.runReplayHistory(
        {
          workflowsPath,
          interceptors: { workflowModules: [interceptorPath] },
          sinks: createWorkflowObservabilitySinks({ spans: workerExporter })
        },
        history
      );
      await workerExporter.flush();
      expect(collector.allSpans().length).toBe(countBeforeReplay);
      expect(collector.rawPayloads.join("\n")).not.toMatch(/PRIVATE PROMPT|sk-live|secret/);
    } finally {
      await collector.close();
      await testEnv.teardown();
    }
  }, 180_000);
});
