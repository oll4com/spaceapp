import { describe, expect, it, vi } from "vitest";
import { defaultPayloadConverter } from "@temporalio/common";
import type { ServerSpan, SpanExporter } from "@space/runtime";
import { createWorkflowTraceSinks } from "../src/workflow-sinks.js";
import { workflowSpanRegistry } from "../src/workflow-span-registry.js";
import {
  TracingWorkflowInboundInterceptor,
  TracingWorkflowOutboundInterceptor
} from "../src/workflow-interceptors.js";

describe("workflow trace sinks", () => {
  it("protects replay determinism with callDuringReplay: false", () => {
    const sinks = createWorkflowTraceSinks(null);
    expect(sinks.trace.recordWorkflowStart.callDuringReplay).toBe(false);
    expect(sinks.trace.recordWorkflowSpan.callDuringReplay).toBe(false);
  });

  it("registers in workflowSpanRegistry on start and emits INTERNAL span on completion", () => {
    const recorded: ServerSpan[] = [];
    const exporter: SpanExporter = {
      record: (span) => void recorded.push(span),
      flush: async () => undefined,
      close: async () => undefined,
      stats: () => ({ exported: recorded.length, dropped: 0, failed: 0 })
    };

    const sinks = createWorkflowTraceSinks(exporter);
    const runId = "test-run-123";

    sinks.trace.recordWorkflowStart.fn({} as never, {
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      spanId: "00f067aa0ba902b7",
      parentSpanId: "1122334455667788",
      workflowType: "dummyTurnWorkflow",
      workflowId: "wf-dummy-1",
      runId,
      startedAtMs: 1_000
    });

    const registered = workflowSpanRegistry.lookup(runId);
    expect(registered).toEqual({
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      spanId: "00f067aa0ba902b7",
      workflowType: "dummyTurnWorkflow"
    });

    sinks.trace.recordWorkflowSpan.fn({} as never, {
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      spanId: "00f067aa0ba902b7",
      parentSpanId: "1122334455667788",
      workflowType: "dummyTurnWorkflow",
      workflowId: "wf-dummy-1",
      runId,
      startedAtMs: 1_000,
      endedAtMs: 1_500,
      status: "COMPLETED"
    });

    expect(workflowSpanRegistry.lookup(runId)).toBeNull();
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      spanId: "00f067aa0ba902b7",
      parentSpanId: "1122334455667788",
      name: "workflow dummyTurnWorkflow",
      kind: 1,
      error: false,
      startTimeUnixNano: 1_000_000_000n,
      endTimeUnixNano: 1_500_000_000n,
      attributes: {
        "space.workflow_type": "dummyTurnWorkflow",
        "space.workflow_id": "wf-dummy-1",
        "space.temporal_run_id": runId,
        "space.outcome": "COMPLETED"
      }
    });
  });

  it("emits error span on FAILED workflow completion", () => {
    const recorded: ServerSpan[] = [];
    const exporter: SpanExporter = {
      record: (span) => void recorded.push(span),
      flush: async () => undefined,
      close: async () => undefined,
      stats: () => ({ exported: recorded.length, dropped: 0, failed: 0 })
    };

    const sinks = createWorkflowTraceSinks(exporter);
    const runId = "test-run-fail";

    sinks.trace.recordWorkflowSpan.fn({} as never, {
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      spanId: "00f067aa0ba902b7",
      parentSpanId: null,
      workflowType: "roomAgentSupervisorWorkflow",
      workflowId: "wf-supervisor-1",
      runId,
      startedAtMs: 1_000,
      endedAtMs: 2_000,
      status: "FAILED",
      errorName: "ApplicationFailure"
    });

    expect(recorded).toHaveLength(1);
    expect(recorded[0].error).toBe(true);
    expect(recorded[0].attributes["space.outcome"]).toBe("FAILED");
  });
});

describe("workflow outbound calls interceptor", () => {
  it("injects traceparent header into scheduled activities", async () => {
    const inbound = new TracingWorkflowInboundInterceptor();
    const outbound = new TracingWorkflowOutboundInterceptor(inbound);

    // Simulate active context
    (inbound as any).activeContext = {
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      spanId: "a1b2c3d4e5f60718",
      parentSpanId: null
    };

    let scheduledInput: any;
    await outbound.scheduleActivity(
      {
        activityType: "sampleActivity",
        args: [],
        headers: {},
        options: {} as never,
        seq: 1
      },
      async (input) => {
        scheduledInput = input;
        return "done";
      }
    );

    expect(scheduledInput).toBeDefined();
    expect(scheduledInput.headers.traceparent).toBeDefined();
    const decoded = defaultPayloadConverter.fromPayload(scheduledInput.headers.traceparent);
    expect(decoded).toBe("00-4bf92f3577b34da6a3ce929d0e0e4736-a1b2c3d4e5f60718-01");
  });

  it("injects traceparent header into child workflows", async () => {
    const inbound = new TracingWorkflowInboundInterceptor();
    const outbound = new TracingWorkflowOutboundInterceptor(inbound);

    (inbound as any).activeContext = {
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      spanId: "childparent12345",
      parentSpanId: null
    };

    let childInput: any;
    await outbound.startChildWorkflowExecution(
      {
        workflowType: "memoryConsolidationWorkflow",
        args: [],
        headers: {},
        options: {} as never
      },
      async (input) => {
        childInput = input;
        return [Promise.resolve("wf-child-id"), Promise.resolve("result")];
      }
    );

    expect(childInput).toBeDefined();
    expect(childInput.headers.traceparent).toBeDefined();
    const decoded = defaultPayloadConverter.fromPayload(childInput.headers.traceparent);
    expect(decoded).toBe("00-4bf92f3577b34da6a3ce929d0e0e4736-childparent12345-01");
  });

  it("injects continuationTraceparent header into continueAsNew", async () => {
    const inbound = new TracingWorkflowInboundInterceptor();
    const outbound = new TracingWorkflowOutboundInterceptor(inbound);

    (inbound as any).activeContext = {
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      spanId: "continue12345678",
      parentSpanId: null
    };

    let continueInput: any;
    await expect(
      outbound.continueAsNew(
        {
          args: [],
          headers: {}
        },
        async (input) => {
          continueInput = input;
          throw new Error("ContinueAsNewExecuted");
        }
      )
    ).rejects.toThrow("ContinueAsNewExecuted");

    expect(continueInput).toBeDefined();
    expect(continueInput.headers.continuationTraceparent).toBeDefined();
    const decoded = defaultPayloadConverter.fromPayload(continueInput.headers.continuationTraceparent);
    expect(decoded).toBe("00-4bf92f3577b34da6a3ce929d0e0e4736-continue12345678-01");
  });
});
