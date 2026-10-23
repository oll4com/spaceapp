import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import {
  ALLOWED_SPAN_ATTRIBUTE_KEYS,
  createOtlpSpanExporter,
  sanitizeSpanAttributes
} from "@space/runtime";
import { observeActivityExecution } from "../src/activity-observability.js";
import {
  childWorkflowTraceparent,
  createWorkflowObservabilitySinks,
  deriveWorkflowSpanId
} from "../src/workflow-observability.js";

const traceId = "4bf92f3577b34da6a3ce929d0e0e4736";
const apiSpanId = "00f067aa0ba902b7";
const apiTraceparent = `00-${traceId}-${apiSpanId}-01`;

describe("OTLP workflow and activity connected trace export (#61)", () => {
  it("enforces the span attribute allowlist and strips prompts, paths, URLs and error messages", () => {
    const dirty = {
      "space.workflow_type": "codexAppServerTurnWorkflow",
      "space.workflow_id": "workflow:codex-app-server:room:1:pane:1:req:1234567890ab",
      "space.run_id": "run-123",
      "space.outcome": "FAILED",
      "space.reason_code": "CODEX_APP_SERVER_TURN_TIMEOUT",
      "space.category": "TIMEOUT",
      "space.attempt": 2,
      "space.duration_ms": 420,
      "space.prompt": "SECRET USER PROMPT DO NOT EXPORT",
      "space.error_message": "Connection failed at /home/user/.ssh/id_rsa",
      "http.url": "https://example.com/private?token=secret",
      "space.room_id": "room with spaces and secret text"
    };
    const cleaned = sanitizeSpanAttributes(dirty);
    expect(Object.keys(cleaned).every(k => ALLOWED_SPAN_ATTRIBUTE_KEYS.has(k))).toBe(true);
    expect(cleaned["space.workflow_type"]).toBe("codexAppServerTurnWorkflow");
    expect(cleaned["space.reason_code"]).toBe("CODEX_APP_SERVER_TURN_TIMEOUT");
    expect(cleaned["space.category"]).toBe("TIMEOUT");
    expect(cleaned["space.prompt"]).toBeUndefined();
    expect(cleaned["space.error_message"]).toBeUndefined();
    expect(cleaned["http.url"]).toBeUndefined();
    expect(cleaned["space.room_id"]).toBeUndefined();
  });

  it("marks workflow sinks callDuringReplay: false so replaying history emits zero duplicate spans", () => {
    const sinks = createWorkflowObservabilitySinks({ spans: null });
    expect(sinks.observability.recordWorkflowSpan.callDuringReplay).toBe(false);
  });

  it("exports a connected trace (API -> Workflow -> Activity -> Child Workflow + Continuation Link) to a local OTLP HTTP collector", async () => {
    const receivedBatches: Array<Record<string, unknown>> = [];
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", chunk => { body += String(chunk); });
      req.on("end", () => {
        receivedBatches.push(JSON.parse(body));
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{}");
      });
    });

    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", () => resolve()));
    const port = (server.address() as AddressInfo).port;
    const exporter = createOtlpSpanExporter({
      endpoint: `http://127.0.0.1:${port}`,
      serviceName: "space-worker",
      batchSize: 10,
      flushIntervalMs: 60_000
    });

    try {
      const sinks = createWorkflowObservabilitySinks({ spans: exporter });
      const workflowId = "workflow:codex-app-server:room:alpha:pane:main:req:abcdefghijkl";
      const runId = "run-parent-001";
      const expectedWfSpanId = deriveWorkflowSpanId(traceId, workflowId, runId);

      // 1. Record parent workflow span (child of API span)
      sinks.observability.recordWorkflowSpan.fn(
        { workflowId, runId, workflowType: "codexAppServerTurnWorkflow" } as never,
        {
          workflowType: "codexAppServerTurnWorkflow",
          workflowId,
          runId,
          traceparent: apiTraceparent,
          traceId: "req:abcdefghijkl",
          roomId: "room:alpha",
          paneId: "pane:main",
          startedAtMs: 1_000,
          endedAtMs: 1_500,
          outcome: "COMPLETED"
        }
      );

      // 2. Execute activity inside that workflow (automatically parents under expectedWfSpanId)
      let clock = 1_100;
      await observeActivityExecution(
        {
          activityType: "runCodexAppServerTurn",
          activityId: "1",
          attempt: 1,
          workflowType: "codexAppServerTurnWorkflow",
          workflowExecution: { workflowId, runId },
          currentAttemptScheduledTimestampMs: 1_050
        },
        [{ traceId: "req:abcdefghijkl", traceparent: apiTraceparent, roomId: "room:alpha", paneId: "pane:main" }],
        async () => {
          clock = 1_450;
          return { status: "COMPLETED" };
        },
        { now: () => clock, spans: exporter }
      );

      // 3. Record child workflow + continuation link
      const childTp = childWorkflowTraceparent(apiTraceparent, workflowId, runId);
      const childWfId = "workflow:memory-consolidation:child:1";
      const childRunId = "run-child-002";
      sinks.observability.recordWorkflowSpan.fn(
        { workflowId: childWfId, runId: childRunId, workflowType: "memoryConsolidationWorkflow" } as never,
        {
          workflowType: "memoryConsolidationWorkflow",
          workflowId: childWfId,
          runId: childRunId,
          traceparent: childTp,
          parentWorkflowId: workflowId,
          parentRunId: runId,
          continuationOfRunId: "agent_run:prev01",
          linkedTraceparent: apiTraceparent,
          startedAtMs: 1_200,
          endedAtMs: 1_400,
          outcome: "COMPLETED"
        }
      );

      await exporter.close();
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }

    expect(receivedBatches.length).toBeGreaterThanOrEqual(1);
    const spans = (receivedBatches[0] as any).resourceSpans[0].scopeSpans[0].spans;
    expect(spans).toHaveLength(3);

    const [wfSpan, actSpan, childWfSpan] = spans;
    expect(wfSpan.traceId).toBe(traceId);
    expect(wfSpan.parentSpanId).toBe(apiSpanId);
    expect(actSpan.traceId).toBe(traceId);
    expect(actSpan.parentSpanId).toBe(wfSpan.spanId);
    expect(childWfSpan.traceId).toBe(traceId);
    expect(childWfSpan.parentSpanId).toBe(wfSpan.spanId);
    expect(childWfSpan.links).toEqual([
      {
        traceId,
        spanId: apiSpanId,
        attributes: [{ key: "space.continuation_of", value: { stringValue: "agent_run:prev01" } }]
      }
    ]);
  });
});
