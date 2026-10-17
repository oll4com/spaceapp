import { describe, expect, it, vi } from "vitest";
const mocked = vi.hoisted(() => ({ start: vi.fn(async () => ({})), close: vi.fn(async () => {}) }));
vi.mock("@temporalio/client", async importOriginal => {
  const actual = await importOriginal<typeof import("@temporalio/client")>();
  return { ...actual,
    Connection: { connect: vi.fn(async () => ({ close: mocked.close })) },
    Client: class { workflow = { start: mocked.start }; }
  };
});
import { TemporalDotGoalWorkflowCoordinator } from "../src/dot-goals.js";
import { scheduleMemoryMutation } from "../src/memory-mutation-coordinator.js";
import { scheduleMemoryConsolidation } from "../src/memory-consolidation-coordinator.js";
import { createRequestTraceContext, requestTraceContexts } from "../src/trace-context.js";

describe("workflow starts preserve actual HTTP parents", () => {
  const traceId = "req:trace-fixture";
  const context = createRequestTraceContext(undefined);
  it("passes the request context into Dot Goal Temporal memo", async () => {
    requestTraceContexts.remember(traceId, context);
    const coordinator = new TemporalDotGoalWorkflowCoordinator({ address: "fixture", namespace: "default", taskQueue: "test" });
    await coordinator.start("goal:fixture", traceId);
    expect(mocked.start).toHaveBeenLastCalledWith("dotGoalWorkflow", expect.objectContaining({
      memo: { spaceTraceId: traceId, traceparent: context.traceparent, w3cTraceId: context.w3cTraceId }
    }));
  });
  it("passes the context into consolidation without changing strict workflow inputs", async () => {
    requestTraceContexts.remember(traceId, context);
    const input = { runId: "consolidation:fixture", traceId };
    const start = vi.fn(async (_type, options) => ({ workflowId: options.workflowId }));
    await scheduleMemoryConsolidation(input, "workflow:fixture", start);
    expect(start).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      args: [input], memo: expect.objectContaining({ traceparent: context.traceparent })
    }));
  });
  it("passes the context into memory mutation without changing strict workflow inputs", async () => {
    requestTraceContexts.remember(traceId, context);
    const input = { changeSetId: "memory_change:fixture", traceId };
    const start = vi.fn(async (_type, options) => ({ workflowId: options.workflowId }));
    await scheduleMemoryMutation(input, start);
    expect(start).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      args: [input], memo: expect.objectContaining({ traceparent: context.traceparent })
    }));
  });
});
