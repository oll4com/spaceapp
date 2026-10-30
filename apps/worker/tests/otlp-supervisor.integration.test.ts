import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Worker } from "@temporalio/worker";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { describe, expect, it } from "vitest";
import { roomAgentSupervisorInputSchema, type DummyTurnInput, type RoomAgentSupervisorQueueItem } from "@space/contracts";
import type { ServerSpan, SpanExporter } from "@space/runtime";
import { createActivityObservabilityInterceptors } from "../src/activity-observability.js";
import { createWorkflowTraceSinks } from "../src/workflow-tracing-sink.js";
import { continuationFixture } from "./room-continuation-fixture.js";

const workflowsPath = fileURLToPath(new URL("./fixtures/otlp-supervisor-workflows.ts", import.meta.url));
const workflowModules = [fileURLToPath(new URL("../src/workflow-tracing.ts", import.meta.url))];
const traceA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const traceB = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const parentA = "1111111111111111";
const parentB = "2222222222222222";

describe("real supervisor mission tracing", () => {
  it("exports two request segments once while the current supervisor remains idle", async () => {
    const fixture = continuationFixture("OPEN_TYPES", `00-${traceA}-${parentA}-01`);
    const first = fixture.initial.queueItem;
    const followUp = fixture.enqueue("follow-up").queueItem;
    const second: RoomAgentSupervisorQueueItem = {
      ...followUp,
      turn: { ...followUp.turn, traceparent: `00-${traceB}-${parentB}-01` }
    };
    expect(first.missionId).toBe(second.missionId);
    expect(first.turn.agentRunId).not.toBe(second.turn.agentRunId);
    const input = roomAgentSupervisorInputSchema.parse({ roomId: fixture.room.id, pending: [first, second] });
    const recorded: ServerSpan[] = [];
    const spans: SpanExporter = {
      record: span => { recorded.push(span); },
      flush: async () => undefined,
      close: async () => undefined,
      stats: () => ({ exported: recorded.length, dropped: 0, failed: 0 })
    };
    const finishedRuns: string[] = [];
    const executedRuns: string[] = [];
    const environment = await TestWorkflowEnvironment.createLocal();
    const taskQueue = `otlp-supervisor-${randomUUID()}`;
    try {
      const worker = await Worker.create({
        connection: environment.nativeConnection, taskQueue, workflowsPath,
        activities: {
          checkRoomAgentSupervisorTurn: async () => "READY",
          runCodexAppServerTurn: async (turn: DummyTurnInput) => {
            executedRuns.push(turn.agentRunId!);
            return {
              status: "COMPLETED", message: "Synthetic turn completed",
              roomAgentOutcome: { status: "VERIFIED", executedActionCount: 1, statusReason: "Synthetic verification" }
            };
          },
          finishRoomAgentSupervisorTurn: async ({ item }: { item: RoomAgentSupervisorQueueItem }) => {
            finishedRuns.push(item.turn.agentRunId!);
          }
        },
        sinks: createWorkflowTraceSinks(spans),
        interceptors: { workflowModules, activity: [createActivityObservabilityInterceptors({ spans })] }
      });
      await worker.runUntil(async () => {
        const handle = await environment.client.workflow.start("roomAgentSupervisorWorkflow", {
          workflowId: taskQueue, taskQueue, args: [input],
          memo: { traceparent: first.turn.traceparent }
        });
        try {
          const segments = () => recorded.filter(span => span.name === "workflow roomAgentSupervisorWorkflow" && span.attributes["space.agent_run_id"]);
          await expect.poll(() => segments().length, { timeout: 30_000 }).toBe(2);
          expect(executedRuns).toEqual([first.turn.agentRunId, second.turn.agentRunId]);
          // A deliberately has a same-mission successor, so production code
          // skips its finish activity. Its segment must still be emitted.
          expect(finishedRuns).toEqual([second.turn.agentRunId]);
          expect((await handle.describe()).status.name).toBe("RUNNING");
          for (const [item, traceId, parentSpanId] of [[first, traceA, parentA], [second, traceB, parentB]] as const) {
            const segment = segments().filter(span => span.attributes["space.agent_run_id"] === item.turn.agentRunId);
            expect(segment).toHaveLength(1);
            expect(segment[0]).toMatchObject({ traceId, parentSpanId });
            expect(recorded.filter(span => span.spanId === segment[0]!.spanId)).toHaveLength(1);
            const children = recorded.filter(span => span.name === "workflow codexAppServerTurnWorkflow" && span.traceId === traceId);
            expect(children).toHaveLength(1);
            expect(children[0]!.parentSpanId).toBe(segment[0]!.spanId);
            const turnActivities = recorded.filter(span => span.name === "activity runCodexAppServerTurn" && span.traceId === traceId);
            expect(turnActivities).toHaveLength(1);
            expect(turnActivities[0]!.parentSpanId).toBe(children[0]!.spanId);
            expect(turnActivities[0]!.attributes["space.attempt"]).toBe(1);
            const checks = recorded.filter(span => span.name === "activity checkRoomAgentSupervisorTurn" && span.traceId === traceId);
            expect(checks).toHaveLength(1);
            expect(checks[0]!.parentSpanId).toBe(segment[0]!.spanId);
          }
          const finishActivities = recorded.filter(span => span.name === "activity finishRoomAgentSupervisorTurn");
          expect(finishActivities).toHaveLength(1);
          expect(finishActivities[0]!.traceId).toBe(traceB);
          const secondSegment = segments().find(span => span.traceId === traceB)!;
          expect(finishActivities[0]!.parentSpanId).toBe(secondSegment.spanId);
          expect(recorded.some(span => Object.keys(span.attributes).some(key => /prompt|message|path|url/i.test(key)))).toBe(false);
        } finally {
          await handle.cancel().catch(() => undefined);
          await handle.result().catch(() => undefined);
        }
      });
    } finally {
      await spans.close();
      await environment.teardown();
    }
  }, 120_000);
});
