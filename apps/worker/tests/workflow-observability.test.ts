import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import type { ServerSpan, SpanExporter } from "@space/runtime";
import { createActivityObservabilityInterceptors } from "../src/activity-observability.js";
import type { WorkflowSpanPayload } from "../src/workflow-observability.js";

const traceId = "4bf92f3577b34da6a3ce929d0e0e4736";
const parentId = "00f067aa0ba902b7";
const traceparent = `00-${traceId}-${parentId}-01`;

describe("workflow OTLP spans", () => {
  let env: TestWorkflowEnvironment;
  const spans: ServerSpan[] = [];

  const exporter: SpanExporter = {
    record: (span) => { spans.push(span); },
    flush: async () => {},
    close: async () => {},
    stats: () => ({ exported: spans.length, dropped: 0, failed: 0 })
  };

  beforeAll(async () => {
    const executable = process.env.TEMPORAL_CLI_PATH || process.env.TEMPORAL_EXECUTABLE;
    env = await TestWorkflowEnvironment.createLocal(
      executable ? { server: { executable: { path: executable } } } : undefined
    );
  }, 180_000);

  afterAll(async () => {
    await env?.teardown();
  });

  it("parents an activity span to the workflow span in the API trace", async () => {
    spans.length = 0;
    const worker = await testWorker();

    await worker.runUntil(async () => {
      await env.client.workflow.execute("tracePing", {
        taskQueue: "workflow-observability-test",
        workflowId: `workflow-observability-${Date.now()}`,
        args: [{ traceparent }]
      });
    });

    const workflowSpan = spans.find(span => span.name.startsWith("workflow "));
    const activitySpan = spans.find(span => span.name.startsWith("activity "));

    expect(workflowSpan).toBeDefined();
    expect(activitySpan).toBeDefined();
    expect(workflowSpan!.traceId).toBe(traceId);
    expect(workflowSpan!.parentSpanId).toBe(parentId);
    expect(activitySpan!.traceId).toBe(traceId);
    expect(activitySpan!.parentSpanId).toBe(workflowSpan!.spanId);
  }, 180_000);

  it("nests a child workflow and its activity under the parent workflow span", async () => {
    spans.length = 0;
    const worker = await testWorker();
    await worker.runUntil(async () => {
      await env.client.workflow.execute("traceChild", {
        taskQueue: "workflow-observability-test",
        workflowId: `workflow-observability-child-${Date.now()}`,
        args: [{ traceparent }]
      });
    });

    const parent = spans.find(span => span.name === "workflow traceChild");
    const child = spans.find(span => span.name === "workflow tracePing");
    const activity = spans.filter(span => span.name.startsWith("activity ")).at(-1);

    expect(parent).toBeDefined();
    expect(child).toBeDefined();
    expect(child!.parentSpanId).toBe(parent!.spanId);
    expect(child!.traceId).toBe(traceId);
    expect(activity!.parentSpanId).toBe(child!.spanId);
  }, 180_000);

  it("keeps a different request trace on a child workflow and links the parent span", async () => {
    spans.length = 0;
    const worker = await testWorker();
    const turnTraceId = "a".repeat(32);
    const turnParentId = "abcdefabcdefabcd";
    const turnTraceparent = `00-${turnTraceId}-${turnParentId}-01`;
    await worker.runUntil(async () => {
      await env.client.workflow.execute("traceSupervisor", {
        taskQueue: "workflow-observability-test",
        workflowId: `workflow-observability-supervisor-${Date.now()}`,
        args: [{ traceparent, turnTraceparent }]
      });
    });

    const supervisor = spans.find(span => span.name === "workflow traceSupervisor");
    const child = spans.find(span => span.name === "workflow tracePing");
    expect(supervisor).toBeDefined();
    expect(child).toBeDefined();
    expect(supervisor!.traceId).toBe(traceId);
    expect(child!.traceId).toBe(turnTraceId);
    expect(child!.parentSpanId).toBe(turnParentId);
    expect(child!.links).toContainEqual({ traceId: supervisor!.traceId, spanId: supervisor!.spanId });
  }, 180_000);

  it("exports room, pane and mission identifiers from the turn input", async () => {
    spans.length = 0;
    const worker = await testWorker();
    await worker.runUntil(async () => {
      await env.client.workflow.execute("traceCorrelated", {
        taskQueue: "workflow-observability-test",
        workflowId: `workflow-observability-correlated-${Date.now()}`,
        args: [{ traceparent, roomId: "room:corr01", paneId: "pane:corr01", roomAgentMissionId: "mission:corr01" }]
      });
    });

    const workflowSpan = spans.find(span => span.name === "workflow traceCorrelated");
    const activitySpan = spans.find(span => span.name === "activity ping");
    expect(workflowSpan!.attributes).toMatchObject({
      "space.room_id": "room:corr01", "space.pane_id": "pane:corr01", "space.mission_id": "mission:corr01"
    });
    expect(activitySpan!.attributes).toMatchObject({
      "space.room_id": "room:corr01", "space.pane_id": "pane:corr01", "space.mission_id": "mission:corr01"
    });
  }, 180_000);

  it("links a continue-as-new run to the run it replaced", async () => {
    spans.length = 0;
    const worker = await testWorker();
    await worker.runUntil(async () => {
      await env.client.workflow.execute("traceContinue", {
        taskQueue: "workflow-observability-test",
        workflowId: `workflow-observability-continue-${Date.now()}`,
        args: [{ traceparent, generation: 0 }]
      });
    });

    const runs = spans.filter(span => span.name === "workflow traceContinue");
    expect(runs.length).toBe(2);
    expect(runs[0].attributes["space.status"]).toBe("CONTINUED");
    expect(runs[1].links).toContainEqual({ traceId, spanId: runs[0].spanId });
  }, 180_000);

  it("does not re-emit spans when replaying a completed history", async () => {
    spans.length = 0;
    const worker = await testWorker();
    const handle = await env.client.workflow.start("tracePing", {
      taskQueue: "workflow-observability-test",
      workflowId: `workflow-observability-replay-${Date.now()}`,
      args: [{ traceparent }]
    });
    await worker.runUntil(() => handle.result());
    expect(spans.length).toBeGreaterThan(0);

    const history = await handle.fetchHistory();
    spans.length = 0;
    await Worker.runReplayHistory({
      workflowsPath: fileURLToPath(new URL("./fixtures/workflow-observability.workflow.ts", import.meta.url)),
      interceptors: {
        workflowModules: [fileURLToPath(new URL("../src/workflow-observability.ts", import.meta.url))]
      },
      sinks: {
        spaceWorkflowTelemetry: {
          span: {
            fn: (_info, payload) => {
              spans.push(payload as unknown as ServerSpan);
            },
            callDuringReplay: false
          }
        }
      }
    }, history);

    expect(spans).toHaveLength(0);
  }, 180_000);

  it("emits a deterministic root trace when no traceparent is supplied", async () => {
    spans.length = 0;
    const worker = await testWorker();
    await worker.runUntil(async () => {
      await env.client.workflow.execute("tracePing", {
        taskQueue: "workflow-observability-test",
        workflowId: `workflow-observability-root-${Date.now()}`,
        args: [{}]
      });
    });

    const workflowSpan = spans.find(span => span.name === "workflow tracePing");
    const activitySpan = spans.find(span => span.name === "activity ping");
    expect(workflowSpan).toBeDefined();
    expect(workflowSpan!.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(workflowSpan!.parentSpanId).toBeNull();
    expect(activitySpan!.traceId).toBe(workflowSpan!.traceId);
    expect(activitySpan!.parentSpanId).toBe(workflowSpan!.spanId);
  }, 180_000);

  function testWorker() {
    return Worker.create({
      connection: env.nativeConnection,
      taskQueue: "workflow-observability-test",
      workflowsPath: fileURLToPath(new URL("./fixtures/workflow-observability.workflow.ts", import.meta.url)),
      activities: { ping: async () => "pong" },
      interceptors: {
        activity: [createActivityObservabilityInterceptors({ spans: exporter })],
        workflowModules: [fileURLToPath(new URL("../src/workflow-observability.ts", import.meta.url))]
      },
      sinks: {
        spaceWorkflowTelemetry: {
          span: {
            fn: (_info, payload) => {
              const span = payload as WorkflowSpanPayload;
              exporter.record({
                ...span,
                startTimeUnixNano: BigInt(span.startTimeUnixNano),
                endTimeUnixNano: BigInt(span.endTimeUnixNano)
              });
            },
            callDuringReplay: false
          }
        }
      }
    });
  }
});
