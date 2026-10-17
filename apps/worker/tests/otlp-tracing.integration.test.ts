import { Context } from "@temporalio/activity";
import { ApplicationFailure } from "@temporalio/common";
import { Worker } from "@temporalio/worker";
import { ROOM_AGENT_ENQUEUE_SIGNAL, roomAgentSupervisorQueueItemSchema } from "@space/contracts";
import { describe, expect, it } from "vitest";
import { noteActivityFailureReason } from "../src/activity-observability.js";
import { createBackgroundTraceContext } from "../src/activity-trace-context.js";
import { attributes, otlpWorkflowBundle, withOtlpHarness, type CollectedSpan } from "./support/otlp-test-harness.js";

const traceId = "4bf92f3577b34da6a3ce929d0e0e4736";
const parentSpanId = "00f067aa0ba902b7";
const traceparent = `00-${traceId}-${parentSpanId}-01`;
const privatePrompt = "PRIVATE_PROMPT_SENTINEL_83c2";
const privatePath = "F:/PRIVATE_PATH_SENTINEL_83c2/operator/private.txt";
const privateError = "PRIVATE_ERROR_SENTINEL_83c2";
const input = () => ({ roomId: "room:otlp", paneId: "pane:otlp", prompt: privatePrompt,
  traceId: "request:otlp", traceparent, workspacePath: privatePath, providerId: "codex" });

/** Require one matching span so duplicate exports cannot satisfy parent-tree assertions. */
function one(spans: CollectedSpan[], name: string): CollectedSpan {
  const matches = spans.filter((span) => span.name === name);
  expect(matches, name).toHaveLength(1);
  return matches[0]!;
}

/** Reject fixture secrets and free-form exception fields anywhere in raw collector payloads. */
function privateDataAbsent(bodies: unknown[]) {
  const payload = JSON.stringify(bodies);
  for (const sentinel of [privatePrompt, privatePath, privateError, "workspacePath", "exception.stacktrace", "exception.message"]) {
    expect(payload).not.toContain(sentinel);
  }
}

describe("worker OTLP tracing against real Temporal and HTTP", () => {
  it("joins request, workflow and distinct retry attempts, then replays without exporting", async () => {
    await withOtlpHarness({
      recordDummyTurnStarted: async () => {
        if (Context.current().info.attempt === 1) {
          const error = new Error(privateError);
          Object.assign(error, { code: "PROVIDER_UNAVAILABLE" });
          throw error;
        }
      },
      recordDummyTurnCompleted: async () => ({ status: "COMPLETED", message: privatePrompt })
    }, async (ctx) => {
      const handle = await ctx.start("dummyTurnWorkflow", [input()]);
      expect(await handle.result()).toMatchObject({ status: "COMPLETED" });
      const spans = await ctx.collectUntil((value) => value.length === 4);
      const workflow = one(spans, "workflow.dummyTurnWorkflow");
      expect(workflow).toMatchObject({ traceId, parentSpanId, kind: 1, status: { code: 0 } });
      expect(attributes(workflow)).toMatchObject({ "space.outcome": "COMPLETED", "space.room_id": "room:otlp", "space.pane_id": "pane:otlp" });
      const started = spans.filter((span) => span.name === "activity.recordDummyTurnStarted")
        .sort((a, b) => Number(attributes(a)["temporal.activity.attempt"]) - Number(attributes(b)["temporal.activity.attempt"]));
      expect(started).toHaveLength(2);
      expect(attributes(started[0]!)).toMatchObject({ "temporal.activity.attempt": "1", "space.outcome": "FAILED",
        "space.reason_code": "PROVIDER_UNAVAILABLE", "space.failure_category": "UPSTREAM_UNAVAILABLE" });
      expect(started[0]!.status.code).toBe(2);
      expect(attributes(started[1]!)).toMatchObject({ "temporal.activity.attempt": "2", "space.outcome": "COMPLETED" });
      expect(started[1]!.status.code).toBe(0);
      expect(new Set(spans.map((span) => span.spanId)).size).toBe(4);
      for (const span of spans.filter((span) => span.name.startsWith("activity."))) {
        expect(span).toMatchObject({ traceId, parentSpanId: workflow.spanId, kind: 1 });
      }
      privateDataAbsent(ctx.collector.bodies);
      const before = ctx.tracing.stats();
      await Worker.runReplayHistory({ workflowBundle: await otlpWorkflowBundle(), sinks: ctx.tracing.workerOptions.sinks }, await handle.fetchHistory());
      await ctx.tracing.flush();
      expect(ctx.tracing.stats()).toEqual(before);
      expect(ctx.collector.spans()).toHaveLength(4);
    });
  }, 60_000);

  it("exports failed results and thrown failures with safe reasons and action cleanup", async () => {
    await withOtlpHarness({
      runCodexAppServerTurn: async () => {
        noteActivityFailureReason("TOOL_UNAVAILABLE");
        return { status: "FAILED", message: privateError };
      },
      runRoomAgentBackgroundAction: async () => { throw ApplicationFailure.nonRetryable(privateError, "PROVIDER_ERROR"); },
      failRoomAgentBackgroundAction: async () => undefined
    }, async (ctx) => {
      expect(await (await ctx.start("codexAppServerTurnWorkflow", [input()])).result()).toMatchObject({ status: "FAILED" });
      const action = await ctx.start("roomAgentActionWorkflow", [{ ...input(), actionId: "action:otlp", bridge: { roomId: "room:otlp", missionId: "mission:otlp" } }]);
      await expect(action.result()).rejects.toThrow();
      const spans = await ctx.collectUntil((value) => value.length === 5);
      expect(attributes(one(spans, "activity.runCodexAppServerTurn"))).toMatchObject({ "space.outcome": "FAILED_RESULT", "space.reason_code": "TOOL_UNAVAILABLE", "space.failure_category": "TOOL_UNAVAILABLE" });
      expect(attributes(one(spans, "workflow.codexAppServerTurnWorkflow"))).toMatchObject({ "space.outcome": "FAILED_RESULT", "space.reason_code": "WORKFLOW_RESULT_FAILED", "space.failure_category": "INTERNAL" });
      expect(attributes(one(spans, "activity.runRoomAgentBackgroundAction"))).toMatchObject({ "space.outcome": "FAILED", "space.reason_code": "PROVIDER_ERROR", "space.failure_category": "PROVIDER_ERROR" });
      const workflow = one(spans, "workflow.roomAgentActionWorkflow");
      expect(attributes(workflow)).toMatchObject({ "space.outcome": "FAILED", "space.reason_code": "WORKFLOW_ERROR" });
      for (const name of ["activity.runRoomAgentBackgroundAction", "activity.failRoomAgentBackgroundAction"]) {
        expect(one(spans, name)).toMatchObject({ traceId, parentSpanId: workflow.spanId });
      }
      expect(one(spans, "activity.failRoomAgentBackgroundAction").status.code).toBe(0);
      privateDataAbsent(ctx.collector.bodies);
    });
  }, 60_000);

  it("propagates through maintenance, consolidation and mutation task queues", async () => {
    const run = { id: "consolidation:otlp", workflowId: "otlp-memory-consolidation", status: "COMPLETED" };
    await withOtlpHarness({
      refreshMemoryGraphSnapshot: async () => ({ sourceHash: "synthetic-hash", status: "COMPLETED" }),
      refreshAllMonthsMemoryGraphSnapshot: async () => undefined,
      reconcileStaleSpaceAgentSessions: async () => undefined,
      createScheduledMemoryAudit: async () => run,
      prepareMemoryConsolidation: async () => ({ run, changeSetId: "change:otlp" }),
      executePersistedMemoryChangeSet: async () => ({ status: "COMPLETED" }),
      finalizeMemoryRepair: async () => run
    }, async (ctx) => {
      const maintenance = await ctx.start("memoryMaintenanceWorkflow", [{ traceId: "request:memory", traceparent }]);
      expect(await maintenance.result()).toMatchObject({ sourceHash: "synthetic-hash" });
      const mutation = await ctx.start("memoryMutationWorkflow", [{ changeSetId: "change:direct", traceparent }]);
      expect(await mutation.result()).toMatchObject({ status: "COMPLETED" });
      const spans = await ctx.collectUntil((value) => value.length === 11);
      const parent = one(spans, "workflow.memoryMaintenanceWorkflow");
      const child = one(spans, "workflow.memoryConsolidationWorkflow");
      const standalone = one(spans, "workflow.memoryMutationWorkflow");
      expect(parent).toMatchObject({ traceId, parentSpanId });
      expect(child).toMatchObject({ traceId, parentSpanId: parent.spanId });
      expect(standalone).toMatchObject({ traceId, parentSpanId });
      const workflowByRun = new Map([parent, child, standalone].map((span) => [attributes(span)["temporal.run.id"], span]));
      for (const activity of spans.filter((span) => span.name.startsWith("activity."))) {
        const workflow = workflowByRun.get(attributes(activity)["temporal.run.id"]);
        expect(workflow).toBeDefined();
        expect(activity).toMatchObject({ traceId, parentSpanId: workflow!.spanId });
      }
      expect(spans.filter((span) => span.name === "activity.executePersistedMemoryChangeSet")).toHaveLength(2);
    }, { memoryQueues: true });
  }, 60_000);

  it("links continue-as-new runs while retaining the original request parent", async () => {
    let calls = 0;
    const runIds = new Set<string>();
    await withOtlpHarness({
      dotGoalStep: async () => {
        runIds.add(Context.current().info.workflowExecution!.runId);
        return { state: ++calls > 300 ? "DONE" : "WAITING", runId: null, goalStatus: "COMPLETED" };
      }
    }, async (ctx) => {
      const handle = await ctx.start("dotGoalWorkflow", [{ goalId: "goal:otlp", traceparent }]);
      expect(await handle.result()).toEqual({ goalStatus: "COMPLETED" });
      expect(calls).toBe(301);
      expect(runIds.size).toBe(2);
      const spans = await ctx.collectUntil((value) => value.length === 303);
      const workflows = spans.filter((span) => span.name === "workflow.dotGoalWorkflow");
      expect(workflows).toHaveLength(2);
      const first = workflows.find((span) => attributes(span)["space.outcome"] === "CONTINUED_AS_NEW")!;
      const second = workflows.find((span) => attributes(span)["space.outcome"] === "COMPLETED")!;
      expect(first).toMatchObject({ traceId, parentSpanId, status: { code: 0 } });
      expect(second).toMatchObject({ traceId, parentSpanId, status: { code: 0 }, links: [{ traceId, spanId: first.spanId }] });
      expect(first.spanId).not.toBe(second.spanId);
      for (const workflow of workflows) {
        const runId = String(attributes(workflow)["temporal.run.id"]);
        const activities = spans.filter((span) => span.name === "activity.dotGoalStep" && attributes(span)["temporal.run.id"] === runId);
        expect(activities).toHaveLength(workflow === first ? 300 : 1);
        for (const activity of activities) expect(activity).toMatchObject({ traceId, parentSpanId: workflow.spanId });
        const before = ctx.tracing.stats();
        await Worker.runReplayHistory({ workflowBundle: await otlpWorkflowBundle(), sinks: ctx.tracing.workerOptions.sinks }, await ctx.env.client.workflow.getHandle(handle.workflowId, runId).fetchHistory());
        await ctx.tracing.flush();
        expect(ctx.tracing.stats()).toEqual(before);
      }
    });
  }, 90_000);

  it("starts a linked background trace under the real supervisor and records cancellation", async () => {
    const initial = roomAgentSupervisorQueueItemSchema.parse({ missionId: "mission:otlp", turn: { ...input(), agentRunId: "agent-run:initial", roomAgentMissionId: "mission:otlp" } });
    let completed = false;
    let backgroundTraceparent = "";
    await withOtlpHarness({
      checkRoomAgentSupervisorTurn: async () => "READY",
      runCodexAppServerTurn: async (turn) => ({ status: "COMPLETED", roomAgentOutcome: {
        status: "VERIFIED", executedActionCount: 1, statusReason: "Synthetic verification",
        ...(!turn.roomAgentContinuation ? { pendingActionIds: ["action:otlp"] } : {})
      } }),
      prepareRoomAgentBackgroundContinuation: async () => {
        const context = createBackgroundTraceContext();
        backgroundTraceparent = context.traceparent;
        return { state: "READY", item: { ...initial, turn: { ...initial.turn, ...context,
          agentRunId: "agent-run:background", traceId: "request:background",
          roomAgentContinuation: { sourceRunId: initial.turn.agentRunId, generation: 1 }
        } } };
      },
      finishRoomAgentSupervisorTurn: async () => { completed = true; },
      discardRoomAgentSupervisorTurn: async () => undefined
    }, async (ctx) => {
      const handle = await ctx.start("roomAgentSupervisorWorkflow", [{ roomId: "room:otlp", pending: [initial] }], { traceparent });
      for (let poll = 0; poll < 50 && !completed; poll++) {
        await ctx.env.sleep("1 second");
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(completed).toBe(true);
      // Finish the activity before cancellation so its telemetry and business result agree.
      for (let poll = 0; poll < 100; poll++) {
        const description = await handle.describe();
        if (!description.raw.pendingActivities?.length && !description.raw.pendingChildren?.length) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      await handle.cancel();
      await expect(handle.result()).rejects.toThrow();
      const spans = await ctx.collectUntil((value) => value.some((span) => span.name === "workflow.roomAgentSupervisorWorkflow"));
      const supervisor = one(spans, "workflow.roomAgentSupervisorWorkflow");
      expect(supervisor).toMatchObject({ traceId, parentSpanId, status: { code: 2 } });
      expect(attributes(supervisor)).toMatchObject({ "space.outcome": "CANCELLED", "space.reason_code": "WORKFLOW_CANCELLED", "space.failure_category": "CANCELLED" });
      const children = spans.filter((span) => span.name === "workflow.codexAppServerTurnWorkflow");
      expect(children).toHaveLength(2);
      expect(children.find((span) => span.traceId === traceId)).toMatchObject({ parentSpanId: supervisor.spanId });
      const background = children.find((span) => span.traceId !== traceId)!;
      expect(background.traceId).toBe(backgroundTraceparent.split("-")[1]);
      expect(background.parentSpanId).toBeUndefined();
      expect(background.links).toEqual([{ traceId, spanId: supervisor.spanId }]);
      const backgroundActivities = spans.filter((span) => span.name.startsWith("activity.") && span.traceId === background.traceId);
      expect(backgroundActivities).toHaveLength(1);
      expect(backgroundActivities[0]!.parentSpanId).toBe(background.spanId);
      privateDataAbsent(ctx.collector.bodies);
    });
  }, 60_000);

  it("completes without exporting when the endpoint is disabled", async () => {
    await withOtlpHarness({ recordDummyTurnStarted: async () => undefined, recordDummyTurnCompleted: async () => "done" }, async (ctx) => {
      expect(await (await ctx.start("dummyTurnWorkflow", [input()])).result()).toBe("done");
      await ctx.tracing.flush();
      expect(ctx.tracing.enabled).toBe(false);
      expect(ctx.tracing.stats()).toEqual({ exported: 0, dropped: 0, failed: 0 });
      expect(ctx.collector.bodies).toEqual([]);
    }, { enabled: false });
  }, 60_000);

  it.each([
    ["new trace", "3".repeat(32)],
    ["shared trace", traceId]
  ])("connects a later request's real child turn to that request and links the long-lived supervisor (%s)", async (_case, laterTraceId) => {
    const initial = roomAgentSupervisorQueueItemSchema.parse({ missionId: "mission:first-request", turn: {
      ...input(), agentRunId: "agent-run:first-request", roomAgentMissionId: "mission:first-request"
    } });
    const laterParentSpanId = "4".repeat(16);
    const later = roomAgentSupervisorQueueItemSchema.parse({ missionId: "mission:later-request", turn: {
      ...input(), traceId: "request:later", traceparent: `00-${laterTraceId}-${laterParentSpanId}-01`,
      agentRunId: "agent-run:later-request", roomAgentMissionId: "mission:later-request"
    } });
    const finished = new Set<string>();
    await withOtlpHarness({
      checkRoomAgentSupervisorTurn: async () => "READY",
      runCodexAppServerTurn: async () => ({ status: "COMPLETED" }),
      finishRoomAgentSupervisorTurn: async ({ item }) => { finished.add(item.missionId); },
      discardRoomAgentSupervisorTurn: async () => undefined
    }, async (ctx) => {
      const handle = await ctx.start("roomAgentSupervisorWorkflow", [{ roomId: "room:otlp", pending: [initial] }], { traceparent });
      const waitForFinish = async (missionId: string) => {
        const deadline = Date.now() + 10_000;
        while (Date.now() < deadline) {
          const description = await handle.describe();
          if (finished.has(missionId) && !description.raw.pendingActivities?.length && !description.raw.pendingChildren?.length) return;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        throw new Error(`Synthetic mission did not finish: ${missionId}`);
      };
      await waitForFinish(initial.missionId);
      await handle.signal(ROOM_AGENT_ENQUEUE_SIGNAL, later);
      await waitForFinish(later.missionId);
      await handle.cancel();
      await expect(handle.result()).rejects.toThrow();
      const spans = await ctx.collectUntil((value) => value.some((span) => span.name === "workflow.roomAgentSupervisorWorkflow"));
      const supervisor = one(spans, "workflow.roomAgentSupervisorWorkflow");
      const turns = spans.filter((span) => span.name === "workflow.codexAppServerTurnWorkflow");
      expect(turns).toHaveLength(2);
      const firstTurn = turns.find((span) => attributes(span)["space.trace_id"] === initial.turn.traceId)!;
      const laterTurn = turns.find((span) => attributes(span)["space.trace_id"] === later.turn.traceId)!;
      expect(supervisor).toMatchObject({ traceId, parentSpanId });
      expect(firstTurn).toMatchObject({ traceId, parentSpanId: supervisor.spanId });
      expect(laterTurn).toMatchObject({ traceId: laterTraceId, parentSpanId: laterParentSpanId,
        links: [{ traceId, spanId: supervisor.spanId }] });
      const laterActivities = spans.filter((span) => span.name === "activity.runCodexAppServerTurn" && attributes(span)["space.mission_id"] === later.missionId);
      expect(laterActivities).toHaveLength(1);
      expect(laterActivities[0]).toMatchObject({ traceId: laterTraceId, parentSpanId: laterTurn.spanId });
      const beforeReplay = ctx.tracing.stats();
      await Worker.runReplayHistory({ workflowBundle: await otlpWorkflowBundle(), sinks: ctx.tracing.workerOptions.sinks }, await handle.fetchHistory());
      await ctx.tracing.flush();
      expect(ctx.tracing.stats()).toEqual(beforeReplay);
      privateDataAbsent(ctx.collector.bodies);
    });
  }, 60_000);

  it("completes workflows when the real HTTP collector rejects every export", async () => {
    await withOtlpHarness({ recordDummyTurnStarted: async () => undefined, recordDummyTurnCompleted: async () => "done" }, async (ctx) => {
      expect(await (await ctx.start("dummyTurnWorkflow", [input()])).result()).toBe("done");
      await ctx.collectUntil((value) => value.length === 3);
      expect(ctx.tracing.stats()).toEqual({ exported: 0, dropped: 0, failed: 3 });
    }, { collectorMode: "reject", exporter: { batchSize: 1 } });
  }, 60_000);

  it("finishes business work before a pending collector request is released", async () => {
    await withOtlpHarness({ recordDummyTurnStarted: async () => undefined, recordDummyTurnCompleted: async () => "done" }, async (ctx) => {
      expect(await (await ctx.start("dummyTurnWorkflow", [input()])).result()).toBe("done");
      for (let poll = 0; poll < 100 && ctx.collector.bodies.length === 0; poll++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(ctx.collector.bodies).toHaveLength(1);
      // The collector still holds its first response, but the workflow already completed.
      expect(ctx.tracing.stats()).toEqual({ exported: 0, dropped: 0, failed: 0 });
      ctx.collector.release();
      await ctx.collectUntil((value) => value.length === 3);
      expect(ctx.tracing.stats()).toEqual({ exported: 0, dropped: 0, failed: 3 });
    }, { collectorMode: "hold", exporter: { batchSize: 1, timeoutMs: 30_000 } });
  }, 60_000);
});
