// A Room Agent mission run by the long-lived supervisor: the supervisor run
// sits under the request that started it, and the mission's turn sits under its
// own request, linked to the supervisor run that executed it. Real production
// workflows on a Temporal time-skipping test server, stub activities, and a
// fake OTLP/HTTP collector on loopback.
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildCodexAppServerTurnWorkflowId, buildRoomAgentSupervisorWorkflowId, type DummyTurnInput } from "@space/contracts";
import { DEFAULT_TASK_QUEUE } from "../src/constants.js";
import { captureWorkerLogs } from "../src/worker-log.js";
import { apiSpanId, apiTraceId, secretPrompt, turn } from "./support/otlp-scenarios.js";
import { attr, runTraced, startFakeCollector, tracedWorker, type CollectedSpan, type FakeCollector } from "./support/otlp-temporal.js";

// The request that started the supervisor (its first mission).
const supervisorTraceId = "0af7651916cd43dd8448eb211c80319c";
const supervisorParentSpanId = "b7ad6b7169203331";

const missionTurn = { ...turn, agentRunId: "agent_run:otlp-supervised", traceId: "req:otlpmission1" } as DummyTurnInput;
const supervisorWorkflowId = buildRoomAgentSupervisorWorkflowId(missionTurn.roomId);
const turnWorkflowId = buildCodexAppServerTurnWorkflowId(missionTurn);

let env: TestWorkflowEnvironment;
let collector: FakeCollector;
let spans: CollectedSpan[];
/** Restores worker logging; replaced in beforeAll. */
let restoreLogs: () => void = () => undefined;

beforeAll(async () => {
  restoreLogs = captureWorkerLogs(() => undefined);
  env = await TestWorkflowEnvironment.createTimeSkipping();
  collector = await startFakeCollector();
  const finished: string[] = [];
  const worker = await tracedWorker(env, {
    collectorUrl: collector.url, service: "space-worker", taskQueue: DEFAULT_TASK_QUEUE, workflows: "workflows.ts",
    activities: {
      async checkRoomAgentSupervisorTurn() { return "RUN"; },
      async runCodexAppServerTurn() { return { status: "COMPLETED" }; },
      async finishRoomAgentSupervisorTurn(input: { status: string }) { finished.push(input.status); },
      async discardRoomAgentSupervisorTurn() { return undefined; },
      async prepareRoomAgentBackgroundContinuation() { return { state: "DONE" }; }
    }
  });
  await runTraced([worker], async () => {
    const supervisor = await env.client.workflow.start("roomAgentSupervisorWorkflow", {
      taskQueue: DEFAULT_TASK_QUEUE, workflowId: supervisorWorkflowId,
      args: [{ roomId: missionTurn.roomId, pending: [{ missionId: "mission:otlp", turn: missionTurn }], interrupted: [], monitoringMissionIds: [], processedCount: 0 }],
      memo: { spaceTraceId: "req:otlpsuper001", traceparent: `00-${supervisorTraceId}-${supervisorParentSpanId}-01`, w3cTraceId: supervisorTraceId }
    });
    // The supervisor starts the mission's turn as a child; wait for it to exist, then to finish.
    const child = env.client.workflow.getHandle(turnWorkflowId);
    for (let tries = 0; tries < 200; tries++) {
      if (await child.describe().then(() => true, () => false)) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await child.result();
    for (let tries = 0; !finished.length && tries < 100; tries++) await new Promise((resolve) => setTimeout(resolve, 50));
    // The supervisor runs until it is stopped; cancel it so its run ends and is exported.
    await supervisor.cancel();
    await supervisor.result().catch(() => undefined);
  });
  spans = collector.spans();
}, 240_000);

afterAll(async () => {
  restoreLogs();
  await collector?.close();
  await env?.teardown();
});

/** The single workflow span exported for `workflowId`. */
const workflowSpan = (workflowId: string) => {
  const list = spans.filter((span) => span.name.startsWith("workflow ") && attr(span, "space.workflow_id") === workflowId);
  expect(list).toHaveLength(1);
  return list[0]!;
};
/** Spans whose parent is `parent`, in the same trace. */
const childrenOf = (parent: CollectedSpan) => spans.filter((span) => span.traceId === parent.traceId && span.parentSpanId === parent.spanId);

describe("worker OTLP spans for a supervised Room Agent mission", () => {
  it("parents the supervisor run on the request that started it, with its activities as children", () => {
    const supervisor = workflowSpan(supervisorWorkflowId);
    expect(supervisor).toMatchObject({ traceId: supervisorTraceId, parentSpanId: supervisorParentSpanId, name: "workflow roomAgentSupervisorWorkflow", kind: 1 });
    expect(attr(supervisor, "space.outcome")).toBe("CANCELLED");
    expect(attr(supervisor, "space.room_id")).toBe(missionTurn.roomId);
    expect(childrenOf(supervisor).map((span) => span.name).sort()).toEqual([
      "activity checkRoomAgentSupervisorTurn",
      "activity finishRoomAgentSupervisorTurn"
    ]);
  });

  it("puts the mission turn in its own request's trace, linked to the supervisor run", () => {
    const supervisor = workflowSpan(supervisorWorkflowId);
    const mission = workflowSpan(turnWorkflowId);
    expect(mission).toMatchObject({ traceId: apiTraceId, parentSpanId: apiSpanId, name: "workflow codexAppServerTurnWorkflow" });
    expect(attr(mission, "space.outcome")).toBe("COMPLETED");
    expect(attr(mission, "space.parent_workflow_id")).toBe(supervisorWorkflowId);
    expect(mission.links).toEqual([{ traceId: supervisorTraceId, spanId: supervisor.spanId, attributes: [{ key: "space.link", value: { stringValue: "PARENT_WORKFLOW" } }] }]);
    const attempts = childrenOf(mission);
    expect(attempts.map((span) => [span.name, attr(span, "space.attempt"), attr(span, "space.outcome")])).toEqual([["activity runCodexAppServerTurn", 1, "COMPLETED"]]);
  });

  it("exports no prompt text", () => {
    expect(collector.bodies.join("\n")).not.toContain(secretPrompt.slice(0, 20));
  });
});
