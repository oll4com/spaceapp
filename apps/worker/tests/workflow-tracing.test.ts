import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkflowSpanRecord } from "../src/workflow-tracing-context.js";
import {
  parseWorkflowTraceparent, traceArgument, traceFromHeaders, traceHeader,
  workflowCorrelation, workflowSpanId
} from "../src/workflow-tracing-context.js";
import { createWorkflowTraceSinks } from "../src/workflow-tracing-sink.js";

const state = vi.hoisted(() => ({
  info: { workflowId: "workflow:1", runId: "run:1", workflowType: "testWorkflow", memo: {} as Record<string, unknown> },
  records: [] as WorkflowSpanRecord[]
}));
vi.mock("@temporalio/workflow", () => ({
  ContinueAsNew: class ContinueAsNew extends Error {},
  isCancellation: (error: unknown) => error instanceof Error && error.name === "CancelledFailure",
  proxySinks: () => ({ spaceTracing: { record: (span: WorkflowSpanRecord) => state.records.push(span) } }),
  workflowInfo: () => state.info
}));
import { ContinueAsNew } from "@temporalio/workflow";
import { interceptors } from "../src/workflow-tracing.js";

const traceId = "4bf92f3577b34da6a3ce929d0e0e4736";
const parentId = "00f067aa0ba902b7";
const traceparent = `00-${traceId}-${parentId}-01`;
const otherTraceparent = "00-11111111111111111111111111111111-2222222222222222-01";
beforeEach(() => { state.records = []; state.info.memo = {}; state.info.workflowType = "testWorkflow"; });

function activity(args: unknown[] = []) {
  return { activityType: "testActivity", args, headers: {}, seq: 1, options: { startToCloseTimeout: "1 minute" } } as never;
}

describe("workflow trace context", () => {
  it("roundtrips valid W3C headers and rejects invalid/oversized/zero identifiers", () => {
    expect(traceFromHeaders({ traceparent: traceHeader(traceparent) })).toEqual({ traceId, spanId: parentId, flags: "01" });
    expect(traceFromHeaders({ traceparent: { data: new Uint8Array(257) } })).toBeNull();
    expect(traceFromHeaders({ traceparent: { data: Uint8Array.of(1, 2) } })).toBeNull();
    expect(parseWorkflowTraceparent("00-00000000000000000000000000000000-00f067aa0ba902b7-01")).toBeNull();
    expect(parseWorkflowTraceparent("00-4bf92f3577b34da6a3ce929d0e0e4736-0000000000000000-01")).toBeNull();
    expect(parseWorkflowTraceparent("secret prompt")).toBeNull();
  });

  it("reads only bounded known argument containers and identifier fields", () => {
    const args = [{ item: { missionId: "mission:1", turn: { traceparent, prompt: "private text", roomId: "room:1" } } }];
    expect(traceArgument(args)).toMatchObject({ traceId });
    expect(workflowCorrelation(args)).toEqual({ missionId: "mission:1", roomId: "room:1" });
    expect(traceArgument([{ arbitrary: { traceparent } }])).toBeNull();
    expect(workflowCorrelation([{ roomId: "https://private.example/secret", prompt: "private" }])).toEqual({});
  });

  it("derives stable nonzero span ids without consuming application randomness", () => {
    const random = vi.spyOn(Math, "random");
    expect(workflowSpanId("run:1")).toMatch(/^[0-9a-f]{16}$/);
    expect(workflowSpanId("run:1")).toBe(workflowSpanId("run:1"));
    expect(workflowSpanId("run:1")).not.toBe(workflowSpanId("run:2"));
    expect(random).not.toHaveBeenCalled();
    random.mockRestore();
  });
});

describe("workflow interceptor", () => {
  it("parents activities and child workflows beneath the actual workflow span", async () => {
    const hooks = interceptors();
    const outbound = hooks.outbound![0]!;
    const activityNext = vi.fn(async () => "activity result");
    const childNext = vi.fn(async () => [Promise.resolve("child-run"), Promise.resolve("child result")] as [Promise<string>, Promise<unknown>]);
    await hooks.inbound![0]!.execute!({ args: [{ traceparent }], headers: {} }, async () => {
      await outbound.scheduleActivity!(activity([{ traceparent }]), activityNext);
      await outbound.startChildWorkflowExecution!({
        workflowType: "child", options: { args: [{ traceparent }] }, headers: {}, seq: 2
      } as never, childNext);
      return "done";
    });
    const root = state.records.at(-1)!;
    expect(state.records).toHaveLength(1);
    expect(root).toMatchObject({ traceId, parentSpanId: parentId, outcome: "COMPLETED" });
    expect(traceFromHeaders(activityNext.mock.calls[0]![0].headers)).toMatchObject({ traceId, spanId: root.spanId });
    expect(traceFromHeaders(childNext.mock.calls[0]![0].headers)).toMatchObject({ traceId, spanId: root.spanId });
  });

  it("prefers a propagated workflow header over an ancestor traceparent left in business arguments", async () => {
    const hooks = interceptors();
    const childParent = `00-${traceId}-aaaaaaaaaaaaaaaa-01`;
    const next = vi.fn(async () => "ok");
    await hooks.inbound![0]!.execute!({ args: [{ traceparent }], headers: { traceparent: traceHeader(childParent) } }, async () => {
      return hooks.outbound![0]!.scheduleActivity!(activity([{ traceparent }]), next);
    });
    const root = state.records.at(-1)!;
    expect(root.parentSpanId).toBe("aaaaaaaaaaaaaaaa");
    expect(traceFromHeaders(next.mock.calls[0]![0].headers)?.spanId).toBe(root.spanId);
  });

  it("uses memo when arguments and headers have no context", async () => {
    state.info.memo = { traceparent };
    const hooks = interceptors();
    await hooks.inbound![0]!.execute!({ args: [], headers: {} }, async () => "ok");
    expect(state.records[0]).toMatchObject({ traceId, parentSpanId: parentId });
  });

  it("keeps later supervisor mission activities in their own API trace", async () => {
    state.info.workflowType = "roomAgentSupervisorWorkflow";
    const hooks = interceptors();
    const next = vi.fn(async () => "ok");
    await hooks.inbound![0]!.execute!({ args: [{ traceparent }], headers: {} }, async () => {
      await hooks.inbound![0]!.handleSignal!({ signalName: "enqueue", headers: {}, args: [{ missionId: "mission:2", turn: { traceparent: otherTraceparent } }] }, async () => undefined);
      await hooks.outbound![0]!.scheduleActivity!(activity([{ missionId: "mission:2" }]), next);
    });
    expect(traceFromHeaders(next.mock.calls[0]![0].headers)?.traceId).toBe("11111111111111111111111111111111");
    expect(state.records.some(span => span.traceId === "11111111111111111111111111111111" && span.parentSpanId === "2222222222222222")).toBe(true);
  });

  it.each(["finishRoomAgentSupervisorTurn", "markRoomAgentMissionFinished"])("exports each supervisor mission once after %s", async (activityType) => {
    state.info.workflowType = "roomAgentSupervisorWorkflow";
    const hooks = interceptors();
    const next = vi.fn(async () => "ok");
    await hooks.inbound![0]!.execute!({ args: [{ traceparent }], headers: {} }, async () => {
      await hooks.inbound![0]!.handleSignal!({ signalName: "enqueue", headers: {}, args: [{ missionId: "mission:2", turn: { traceparent: otherTraceparent } }] }, async () => undefined);
      await hooks.outbound![0]!.scheduleActivity!(activity([{ missionId: "mission:2" }]), next);
      expect(state.records).toHaveLength(0);
      await hooks.outbound![0]!.scheduleActivity!({
        activityType, args: [{ item: { missionId: "mission:2" }, status: "COMPLETED" }], headers: {}, seq: 2, options: { startToCloseTimeout: "1 minute" }
      } as never, next);
      expect(state.records).toHaveLength(1);
    });
    expect(state.records).toHaveLength(2); // One mission plus the workflow run, each once.
    expect(new Set(state.records.map(span => span.spanId)).size).toBe(2);
  });

  it("exports a completed supervisor turn before an indefinite wait, after active bookkeeping settles", async () => {
    state.info.workflowType = "roomAgentSupervisorWorkflow";
    const hooks = interceptors();
    let resolveBookkeeping!: () => void;
    const bookkeeping = new Promise<void>(resolve => { resolveBookkeeping = resolve; });
    await hooks.inbound![0]!.execute!({ args: [{ traceparent }], headers: {} }, async () => {
      const child = await hooks.outbound![0]!.startChildWorkflowExecution!({
        workflowType: "child", options: { args: [{ missionId: "mission:2", traceparent: otherTraceparent }] }, headers: {}, seq: 2
      } as never, async () => [Promise.resolve("child-run"), Promise.resolve("done")]);
      await child[1];
      const running = hooks.outbound![0]!.scheduleActivity!(activity([{ missionId: "mission:2" }]), async () => bookkeeping);
      await Promise.resolve();
      hooks.internals![0]!.concludeActivation!({ commands: [] }, value => value);
      expect(state.records).toHaveLength(0);
      resolveBookkeeping();
      await running;
      hooks.internals![0]!.concludeActivation!({ commands: [] }, value => value);
      expect(state.records).toHaveLength(1);
      hooks.internals![0]!.concludeActivation!({ commands: [] }, value => value);
      expect(state.records).toHaveLength(1);
    });
    expect(state.records).toHaveLength(2);
  });

  it("carries a link to the previous run across continue-as-new", async () => {
    const hooks = interceptors();
    const continued = new ContinueAsNew({} as never);
    const next = vi.fn(async () => { throw continued; });
    await expect(hooks.inbound![0]!.execute!({ args: [{ traceparent }], headers: {} }, async () => {
      return hooks.outbound![0]!.continueAsNew!({ args: [], headers: {}, options: { workflowType: "testWorkflow" } }, next);
    })).rejects.toBe(continued);
    const root = state.records.at(-1)!;
    expect(root.outcome).toBe("CONTINUED");
    const headers = next.mock.calls[0]![0].headers;
    expect(traceFromHeaders(headers)).toMatchObject({ traceId, spanId: parentId });
    expect(traceFromHeaders(headers, "space-trace-link")).toMatchObject({ traceId, spanId: root.spanId });
    const resumed = interceptors();
    await resumed.inbound![0]!.execute!({ args: [], headers }, async () => "ok");
    expect(state.records.at(-1)!.links).toEqual([{ traceId, spanId: root.spanId }]);
  });

  it("exports generic failure outcome without error messages or argument content", async () => {
    const hooks = interceptors();
    await expect(hooks.inbound![0]!.execute!({ args: [{ traceparent, prompt: "private prompt" }], headers: {} }, async () => {
      throw new Error("private exception text");
    })).rejects.toThrow("private exception text");
    expect(state.records.at(-1)!.outcome).toBe("FAILED");
    expect(JSON.stringify(state.records)).not.toMatch(/private/);
  });
});

describe("workflow sink", () => {
  it("is disabled without an exporter and explicitly suppresses replay calls", () => {
    expect(createWorkflowTraceSinks(null)).toBeUndefined();
    const record = vi.fn();
    const sinks = createWorkflowTraceSinks({ record } as never)!;
    expect(sinks.spaceTracing.record.callDuringReplay).toBe(false);
  });

  it("reconstructs only allowlisted attributes and isolates exporter failures", () => {
    const record = vi.fn();
    const sinks = createWorkflowTraceSinks({ record } as never)!;
    const sample = {
      traceId, spanId: "aaaaaaaaaaaaaaaa", parentSpanId: parentId,
      startedAtMs: 1000, endedAtMs: 1100, outcome: "COMPLETED" as const,
      correlation: { roomId: "room:1", prompt: "private", url: "https://private", path: "/secret" },
      unexpected: "private"
    };
    sinks.spaceTracing.record.fn(state.info as never, sample);
    expect(record.mock.calls[0]![0].attributes).toEqual({
      "space.workflow_type": "testWorkflow", "space.outcome": "COMPLETED",
      "space.workflow_id": "workflow:1", "space.run_id": "run:1", "space.room_id": "room:1"
    });
    expect(JSON.stringify(record.mock.calls, (_key, value) => typeof value === "bigint" ? String(value) : value)).not.toMatch(/private|secret/);
    record.mockImplementation(() => { throw new Error("collector unavailable"); });
    expect(() => sinks.spaceTracing.record.fn(state.info as never, sample)).not.toThrow();
  });
});
