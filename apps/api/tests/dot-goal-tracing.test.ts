import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseTraceparent } from "@space/contracts";
import { TemporalDotGoalWorkflowCoordinator } from "../src/dot-goals.js";
import { createRequestTraceContext, requestTraceContexts } from "../src/trace-context.js";

const temporal = vi.hoisted(() => ({ start: vi.fn(), close: vi.fn() }));

vi.mock("@temporalio/client", async (importOriginal) => {
  const original = await importOriginal<typeof import("@temporalio/client")>();
  return {
    ...original,
    Connection: { connect: async () => ({ close: temporal.close }) },
    Client: class { workflow = { start: temporal.start }; }
  };
});

beforeEach(() => {
  temporal.start.mockReset().mockResolvedValue({});
  temporal.close.mockReset().mockResolvedValue(undefined);
});

describe("Dot Goal workflow trace propagation", () => {
  it("parents both explicit starts and requested restarts to their recorded API spans", async () => {
    const coordinator = new TemporalDotGoalWorkflowCoordinator({ address: "unused", namespace: "default", taskQueue: "agent-turns" });
    const first = createRequestTraceContext("00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01");
    const restart = createRequestTraceContext("00-11111111111111111111111111111111-2222222222222222-01");
    requestTraceContexts.remember("req:goal-create", first);
    requestTraceContexts.remember("req:goal-restart", restart);

    await coordinator.start("dot_goal:abcdefgh1", "req:goal-create");
    expect(await coordinator.ensure("dot_goal:abcdefgh1", "req:goal-restart")).toBe(true);

    const start = temporal.start.mock.calls[0]![1];
    const resumed = temporal.start.mock.calls[1]![1];
    expect(start).toMatchObject({ args: [{ goalId: "dot_goal:abcdefgh1" }], workflowIdReusePolicy: "REJECT_DUPLICATE" });
    expect(resumed).toMatchObject({ args: [{ goalId: "dot_goal:abcdefgh1" }], workflowIdReusePolicy: "ALLOW_DUPLICATE" });
    expect(parseTraceparent(start.memo.traceparent)).toMatchObject({ traceId: first.w3cTraceId, parentId: first.spanId });
    expect(parseTraceparent(resumed.memo.traceparent)).toMatchObject({ traceId: restart.w3cTraceId, parentId: restart.spanId });
    expect(temporal.close).toHaveBeenCalledTimes(2);
  });

  it("does not fabricate a parent for autonomous reconciliation with no request", async () => {
    const coordinator = new TemporalDotGoalWorkflowCoordinator({ address: "unused", namespace: "default", taskQueue: "agent-turns" });
    await coordinator.ensure("dot_goal:abcdefgh1");
    expect(temporal.start.mock.calls[0]![1].memo).toEqual({});
  });
});
