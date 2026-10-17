import { describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { formatTraceparent, parseTraceparent } from "@space/contracts";
import { createOtlpSpanExporter, type ServerSpan } from "@space/runtime";
import { ContinueAsNew } from "@temporalio/workflow";
import { createWorkflowTracingSink } from "../src/workflow-tracing-sinks.js";
import {
  interceptors,
  createWorkflowObservabilityInterceptors
} from "../src/workflow-observability.js";
import { defaultPayloadConverter } from "@temporalio/common";
import { observeActivityExecution } from "../src/activity-observability.js";

const inboundTraceId = "4bf92f3577b34da6a3ce929d0e0e4736";
const inboundSpanId = "00f067aa0ba902b7";
const inboundTraceparent = formatTraceparent(inboundTraceId, inboundSpanId, "01");

const defaultWorkflowInfo = () => ({
  workflowType: "codexAppServerTurnWorkflow",
  workflowId: "workflow:codex",
  runId: "run:1",
  attempt: 1,
  memo: {}
});

describe("Workflow observability interceptors and sinks", () => {
  it("exports a no-argument interceptors factory returning non-empty inbound and outbound arrays", () => {
    const factory = interceptors();
    expect(factory.inbound).toBeDefined();
    expect(factory.inbound!.length).toBeGreaterThan(0);
    expect(factory.outbound).toBeDefined();
    expect(factory.outbound!.length).toBeGreaterThan(0);
  });

  it("creates a workflow span whose parent is the propagated traceparent and attaches traceparent to outbound activities", async () => {
    const recordedSpans: ServerSpan[] = [];
    const mockExporter = {
      record: (span: ServerSpan) => recordedSpans.push(span),
      flush: async () => {},
      close: async () => {},
      stats: () => ({ exported: 0, dropped: 0, failed: 0 })
    };

    const interceptorFactory = createWorkflowObservabilityInterceptors({
      sink: { recordWorkflowSpan: (span) => mockExporter.record(span) },
      getWorkflowInfo: defaultWorkflowInfo
    })();
    const inbound = interceptorFactory.inbound![0]!;
    const outbound = interceptorFactory.outbound![0]!;

    let activityHeaders: any = null;

    // Simulate workflow execution
    await inbound.execute!(
      {
        args: [{ roomId: "room:alpha", missionId: "mission:1", traceId: "req:test01" }],
        headers: {
          traceparent: defaultPayloadConverter.toPayload(inboundTraceparent)
        }
      },
      async () => {
        // Workflow schedules an activity
        await outbound.scheduleActivity!(
          {
            activityType: "testActivity",
            args: [{ traceId: "req:test01" }],
            headers: {},
            options: { startToCloseTimeout: "10s" },
            seq: 1
          },
          async (actInput) => {
            activityHeaders = actInput.headers;
            return "activity-result";
          }
        );
        return "workflow-result";
      }
    );

    // Verify activity received the workflow's span ID as parentId in its headers
    expect(activityHeaders).toBeDefined();
    expect(activityHeaders.traceparent).toBeDefined();
    const activityTraceparentDecoded = defaultPayloadConverter.fromPayload(activityHeaders.traceparent);
    const parsedActivityParent = parseTraceparent(activityTraceparentDecoded as string);
    expect(parsedActivityParent).toBeDefined();
    expect(parsedActivityParent!.traceId).toBe(inboundTraceId);

    // Verify workflow span was recorded
    expect(recordedSpans).toHaveLength(1);
    const wfSpan = recordedSpans[0]!;
    expect(wfSpan.traceId).toBe(inboundTraceId);
    expect(wfSpan.parentSpanId).toBe(inboundSpanId);
    expect(wfSpan.spanId).toBe(parsedActivityParent!.parentId);
    expect(wfSpan.kind).toBe(1); // INTERNAL
    expect(wfSpan.error).toBe(false);
    expect(wfSpan.name).toBe("workflow codexAppServerTurnWorkflow");
    expect(wfSpan.attributes["space.workflow_type"]).toBe("codexAppServerTurnWorkflow");
    expect(wfSpan.attributes["space.mission_id"]).toBe("mission:1");
    expect(wfSpan.attributes["space.room_id"]).toBe("room:alpha");
  });

  it("derives traceId and spanId deterministically from workflowInfo without PRNG when no inbound traceparent", async () => {
    const recordedSpans: ServerSpan[] = [];
    const mockExporter = {
      record: (span: ServerSpan) => recordedSpans.push(span),
      flush: async () => {},
      close: async () => {},
      stats: () => ({ exported: 0, dropped: 0, failed: 0 })
    };

    const interceptorFactory = createWorkflowObservabilityInterceptors({
      sink: { recordWorkflowSpan: (span) => mockExporter.record(span) },
      getWorkflowInfo: () => ({
        workflowType: "customWorkflow",
        workflowId: "workflow:fixed-id",
        runId: "run:fixed-run",
        attempt: 2,
        memo: {}
      })
    })();
    const inbound = interceptorFactory.inbound![0]!;

    await inbound.execute!({ args: [], headers: {} }, async () => "ok");

    expect(recordedSpans).toHaveLength(1);
    const span = recordedSpans[0]!;
    expect(span.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(span.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(span.parentSpanId).toBeNull();

    // Running again with identical workflowInfo produces identical deterministic IDs
    const recordedSpans2: ServerSpan[] = [];
    const factory2 = createWorkflowObservabilityInterceptors({
      sink: { recordWorkflowSpan: (s) => recordedSpans2.push(s) },
      getWorkflowInfo: () => ({
        workflowType: "customWorkflow",
        workflowId: "workflow:fixed-id",
        runId: "run:fixed-run",
        attempt: 2,
        memo: {}
      })
    })();
    await factory2.inbound![0]!.execute!({ args: [], headers: {} }, async () => "ok");
    expect(recordedSpans2[0]!.traceId).toBe(span.traceId);
    expect(recordedSpans2[0]!.spanId).toBe(span.spanId);

    // Preserves valid 32-char hex memoTraceId
    const memoTraceId = "0123456789abcdef0123456789abcdef";
    const recordedSpans3: ServerSpan[] = [];
    const factory3 = createWorkflowObservabilityInterceptors({
      sink: { recordWorkflowSpan: (s) => recordedSpans3.push(s) },
      getWorkflowInfo: () => ({
        workflowType: "customWorkflow",
        workflowId: "workflow:fixed-id",
        runId: "run:fixed-run",
        attempt: 1,
        memo: { w3cTraceId: memoTraceId }
      })
    })();
    await factory3.inbound![0]!.execute!({ args: [], headers: {} }, async () => "ok");
    expect(recordedSpans3[0]!.traceId).toBe(memoTraceId);
  });

  it("does not mark ContinueAsNew errors as failure on workflow spans", async () => {
    const recordedSpans: ServerSpan[] = [];
    const mockExporter = {
      record: (span: ServerSpan) => recordedSpans.push(span),
      flush: async () => {},
      close: async () => {},
      stats: () => ({ exported: 0, dropped: 0, failed: 0 })
    };

    const factory = createWorkflowObservabilityInterceptors({
      sink: { recordWorkflowSpan: (span) => mockExporter.record(span) },
      getWorkflowInfo: defaultWorkflowInfo
    })();
    const inbound = factory.inbound![0]!;

    await expect(
      inbound.execute!({ args: [], headers: {} }, async () => {
        throw new ContinueAsNew({});
      })
    ).rejects.toThrow();

    expect(recordedSpans).toHaveLength(1);
    expect(recordedSpans[0]!.error).toBe(false);
    expect(recordedSpans[0]!.attributes["space.status"]).toBe("COMPLETED");

    // Standard application error is marked as failure
    const errorSpans: ServerSpan[] = [];
    const errorFactory = createWorkflowObservabilityInterceptors({
      sink: { recordWorkflowSpan: (span) => errorSpans.push(span) },
      getWorkflowInfo: defaultWorkflowInfo
    })();
    await expect(
      errorFactory.inbound![0]!.execute!({ args: [], headers: {} }, async () => {
        throw new Error("unhandled workflow error");
      })
    ).rejects.toThrow("unhandled workflow error");

    expect(errorSpans).toHaveLength(1);
    expect(errorSpans[0]!.error).toBe(true);
    expect(errorSpans[0]!.attributes["space.status"]).toBe("FAILED");
  });

  it("nests child workflows under parent workflow span", async () => {
    const recordedSpans: ServerSpan[] = [];
    const mockExporter = {
      record: (span: ServerSpan) => recordedSpans.push(span),
      flush: async () => {},
      close: async () => {},
      stats: () => ({ exported: 0, dropped: 0, failed: 0 })
    };

    const parentFactory = createWorkflowObservabilityInterceptors({
      sink: { recordWorkflowSpan: (span) => mockExporter.record(span) },
      getWorkflowInfo: defaultWorkflowInfo
    })();
    const parentInbound = parentFactory.inbound![0]!;
    const parentOutbound = parentFactory.outbound![0]!;

    let childHeaders: any = null;

    await parentInbound.execute!(
      {
        args: [{ traceId: "req:parent" }],
        headers: {
          traceparent: defaultPayloadConverter.toPayload(inboundTraceparent)
        }
      },
      async () => {
        // Parent workflow starts a child workflow
        await parentOutbound.startChildWorkflowExecution!(
          {
            workflowType: "memoryConsolidationWorkflow",
            args: [{ runId: "run:1" }],
            headers: {},
            options: {} as any,
            seq: 1
          },
          async (childInput) => {
            childHeaders = childInput.headers;
            return [Promise.resolve("child-run-id"), Promise.resolve("child-result")];
          }
        );
      }
    );

    const childTraceparentDecoded = defaultPayloadConverter.fromPayload(childHeaders.traceparent);
    const parsedChildParent = parseTraceparent(childTraceparentDecoded as string);
    expect(parsedChildParent).toBeDefined();
    expect(parsedChildParent!.traceId).toBe(inboundTraceId);

    const parentWfSpan = recordedSpans[0]!;
    expect(parsedChildParent!.parentId).toBe(parentWfSpan.spanId);

    // Simulate child workflow execution with childHeaders
    const childFactory = createWorkflowObservabilityInterceptors({
      sink: { recordWorkflowSpan: (span) => mockExporter.record(span) },
      getWorkflowInfo: () => ({
        workflowType: "memoryConsolidationWorkflow",
        workflowId: "workflow:child",
        runId: "run:child",
        attempt: 1,
        memo: {}
      })
    })();
    const childInbound = childFactory.inbound![0]!;
    await childInbound.execute!(
      {
        args: [{ runId: "run:1" }],
        headers: childHeaders
      },
      async () => "child-done"
    );

    expect(recordedSpans).toHaveLength(2);
    const childWfSpan = recordedSpans[1]!;
    expect(childWfSpan.traceId).toBe(inboundTraceId);
    expect(childWfSpan.parentSpanId).toBe(parentWfSpan.spanId);
    expect(childWfSpan.name).toBe("workflow memoryConsolidationWorkflow");
  });

  it("carries span links on continue-as-new runs", async () => {
    const recordedSpans: ServerSpan[] = [];
    const mockExporter = {
      record: (span: ServerSpan) => recordedSpans.push(span),
      flush: async () => {},
      close: async () => {},
      stats: () => ({ exported: 0, dropped: 0, failed: 0 })
    };

    const run1Factory = createWorkflowObservabilityInterceptors({
      sink: { recordWorkflowSpan: (span) => mockExporter.record(span) },
      getWorkflowInfo: defaultWorkflowInfo
    })();
    const run1Inbound = run1Factory.inbound![0]!;
    const run1Outbound = run1Factory.outbound![0]!;

    let nextRunHeaders: any = null;

    try {
      await run1Inbound.execute!(
        {
          args: [{ traceId: "req:loop" }],
          headers: { traceparent: defaultPayloadConverter.toPayload(inboundTraceparent) }
        },
        async () => {
          await run1Outbound.continueAsNew!(
            {
              args: [{ traceId: "req:loop" }],
              headers: {},
              options: {} as any
            },
            async (nextInput) => {
              nextRunHeaders = nextInput.headers;
              throw new ContinueAsNew({});
            }
          );
        }
      );
    } catch {}

    const run1Span = recordedSpans[0]!;
    expect(nextRunHeaders).toBeDefined();
    expect(nextRunHeaders["x-space-continue-from"]).toBeDefined();

    // Run 2 starts with nextRunHeaders
    const run2Factory = createWorkflowObservabilityInterceptors({
      sink: { recordWorkflowSpan: (span) => mockExporter.record(span) },
      getWorkflowInfo: () => ({
        workflowType: "codexAppServerTurnWorkflow",
        workflowId: "workflow:codex",
        runId: "run:2",
        attempt: 1,
        memo: {}
      })
    })();
    const run2Inbound = run2Factory.inbound![0]!;
    await run2Inbound.execute!(
      {
        args: [{ traceId: "req:loop" }],
        headers: nextRunHeaders
      },
      async () => "run2-complete"
    );

    expect(recordedSpans).toHaveLength(2);
    const run2Span = recordedSpans[1]!;
    expect(run2Span.links).toBeDefined();
    expect(run2Span.links).toHaveLength(1);
    expect(run2Span.links![0]!.traceId).toBe(inboundTraceId);
    expect(run2Span.links![0]!.spanId).toBe(run1Span.spanId);
    expect(run2Span.links![0]!.attributes).toEqual({ "link.reason": "continue_as_new" });
  });

  it("carries span link for background continuation runs", async () => {
    const recordedSpans: ServerSpan[] = [];
    const mockExporter = {
      record: (span: ServerSpan) => recordedSpans.push(span),
      flush: async () => {},
      close: async () => {},
      stats: () => ({ exported: 0, dropped: 0, failed: 0 })
    };

    const factory = createWorkflowObservabilityInterceptors({
      sink: { recordWorkflowSpan: (span) => mockExporter.record(span) },
      getWorkflowInfo: defaultWorkflowInfo
    })();
    const inbound = factory.inbound![0]!;

    const bgSourceTraceparent = "00-11112222333344445555666677778888-aaaabbbbccccdddd-01";
    await inbound.execute!(
      {
        args: [
          {
            traceId: "trace:bg-continuation-99",
            turn: {
              roomAgentContinuation: {
                sourceRunId: "agent_run:prev",
                generation: 2,
                sourceTraceparent: bgSourceTraceparent
              }
            }
          }
        ],
        headers: {}
      },
      async () => "continuation-done"
    );

    expect(recordedSpans).toHaveLength(1);
    const bgSpan = recordedSpans[0]!;
    expect(bgSpan.links).toBeDefined();
    expect(bgSpan.links).toHaveLength(1);
    expect(bgSpan.links![0]!.traceId).toBe("11112222333344445555666677778888");
    expect(bgSpan.links![0]!.spanId).toBe("aaaabbbbccccdddd");
    expect(bgSpan.links![0]!.attributes).toEqual({ "link.reason": "background_continuation" });
  });

  it("guarantees callDuringReplay: false on the tracing sink so replay emits zero spans", () => {
    let recorded = 0;
    const sinkDef = createWorkflowTracingSink({
      record: () => { recorded++; },
      flush: async () => {},
      close: async () => {},
      stats: () => ({ exported: 0, dropped: 0, failed: 0 })
    });

    // In Temporal Worker SDK, callDuringReplay: false prevents sink execution during history replay.
    expect(sinkDef.observability.recordWorkflowSpan.callDuringReplay).toBe(false);
    expect(typeof sinkDef.observability.recordWorkflowSpan.fn).toBe("function");
    expect(recorded).toBe(0);
  });
});

describe("End-to-end trace tree integration with fake OTLP collector", () => {
  it("produces a single connected trace: inbound caller -> workflow -> activity attempt", async () => {
    const receivedSpans: any[] = [];
    const server: Server = createServer((req, res) => {
      let body = "";
      req.on("data", chunk => { body += chunk; });
      req.on("end", () => {
        try {
          const parsed = JSON.parse(body);
          for (const resourceSpan of parsed.resourceSpans || []) {
            for (const scopeSpan of resourceSpan.scopeSpans || []) {
              for (const s of scopeSpan.spans || []) {
                receivedSpans.push(s);
              }
            }
          }
        } catch {}
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({}));
      });
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as any).port;
    const endpoint = `http://127.0.0.1:${port}`;

    try {
      const exporter = createOtlpSpanExporter({
        endpoint,
        serviceName: "space-worker",
        flushIntervalMs: 50
      });

      // Wire sinks
      const sinks = createWorkflowTracingSink(exporter);

      const interceptorFactory = createWorkflowObservabilityInterceptors({
        sink: {
          recordWorkflowSpan: (span) => sinks.observability.recordWorkflowSpan.fn({} as any, span)
        },
        getWorkflowInfo: defaultWorkflowInfo
      })();
      const wfInbound = interceptorFactory.inbound![0]!;
      const wfOutbound = interceptorFactory.outbound![0]!;

      // Execute Workflow
      await wfInbound.execute!(
        {
          args: [
            {
              roomId: "room:prod",
              missionId: "mission:e2e",
              traceId: "req:prod001"
            }
          ],
          headers: {
            traceparent: defaultPayloadConverter.toPayload(inboundTraceparent)
          }
        },
        async () => {
          // Inside workflow: schedule activity
          await wfOutbound.scheduleActivity!(
            {
              activityType: "executeAction",
              args: [{ traceId: "req:prod001" }],
              headers: {},
              options: {} as any,
              seq: 1
            },
            async (activityInput) => {
              // Activity runs on worker with observed interceptors
              const actInfo = {
                activityType: "executeAction",
                activityId: "act:1",
                attempt: 1,
                workflowType: "codexAppServerTurnWorkflow",
                workflowExecution: { workflowId: "w:1", runId: "r:1" },
                currentAttemptScheduledTimestampMs: Date.now()
              } as any;

              return observeActivityExecution(
                actInfo,
                activityInput.args,
                async () => "action-ok",
                {
                  headers: activityInput.headers as any,
                  spans: exporter
                }
              );
            }
          );
          return "workflow-ok";
        }
      );

      await exporter.flush();
      await exporter.close();

      // Verify collected trace
      expect(receivedSpans).toHaveLength(2);

      const workflowSpan = receivedSpans.find(s => s.name.startsWith("workflow"));
      const activitySpan = receivedSpans.find(s => s.name.startsWith("activity"));

      expect(workflowSpan).toBeDefined();
      expect(activitySpan).toBeDefined();

      // 1. Trace ID continuity
      expect(workflowSpan.traceId).toBe(inboundTraceId);
      expect(activitySpan.traceId).toBe(inboundTraceId);

      // 2. Parent-child hierarchy
      // Workflow span's parent is the inbound API request's span ID
      expect(workflowSpan.parentSpanId).toBe(inboundSpanId);

      // Activity span's parent is the workflow span ID
      expect(activitySpan.parentSpanId).toBe(workflowSpan.spanId);

      // 3. Attributes allowlist verified on both spans
      expect(workflowSpan.kind).toBe(1);
      expect(activitySpan.kind).toBe(1);
      expect(workflowSpan.status.code).toBe(0);
      expect(activitySpan.status.code).toBe(0);

      const wfAttrKeys = workflowSpan.attributes.map((a: any) => a.key);
      expect(wfAttrKeys).toContain("space.workflow_type");
      expect(wfAttrKeys).toContain("space.room_id");
      expect(wfAttrKeys).toContain("space.mission_id");

      const actAttrKeys = activitySpan.attributes.map((a: any) => a.key);
      expect(actAttrKeys).toContain("space.activity_type");
      expect(actAttrKeys).toContain("space.outcome");
      expect(actAttrKeys).toContain("space.attempt");
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
