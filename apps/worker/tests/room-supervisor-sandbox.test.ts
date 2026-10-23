import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker, type WorkerOptions } from "@temporalio/worker";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(__dirname, "../src");
const WORKFLOWS = path.join(SRC, "workflows.ts");
const SUPERVISOR_QUEUE = "space-room-supervisor";

let env: TestWorkflowEnvironment;

beforeAll(async () => {
  env = await TestWorkflowEnvironment.createTimeSkipping();
}, 300_000);

afterAll(async () => {
  await env?.teardown();
});

async function withWorker(
  activities: NonNullable<WorkerOptions["activities"]>,
  run: () => Promise<void>
): Promise<void> {
  const worker = await Worker.create({
    connection: env.nativeConnection,
    taskQueue: SUPERVISOR_QUEUE,
    workflowsPath: WORKFLOWS,
    activities
  });
  await worker.runUntil(run());
}

function turn(suffix: string, overrides: Record<string, unknown> = {}) {
  return {
    roomId: "room:supervisor",
    paneId: "pane:supervisor",
    prompt: `Request ${suffix}`,
    roomAgentOperatorRequest: `Request ${suffix}`,
    modelId: "gpt-5.6-sol",
    reasoningEffort: "high",
    agentSessionId: "session:supervisor",
    agentRunId: `agent_run:${suffix}`,
    agentUserMessageId: `agent_msg:user-${suffix}`,
    agentAssistantMessageId: `agent_msg:assistant-${suffix}`,
    roomAgentMissionId: "mission:supervisor",
    traceId: `trace:${suffix}`,
    ...overrides
  };
}

function queueItem(suffix: string, overrides: Record<string, unknown> = {}) {
  return { missionId: "mission:supervisor", turn: turn(suffix, overrides) };
}

/**
 * The supervisor never returns: it parks in condition() and runs until
 * continueAsNew or cancellation. These tests drive it with stub activities and
 * end each run by cancelling the workflow, which is what an operator stop does.
 */
describe("roomAgentSupervisorWorkflow (real sandbox)", () => {
  it("runs a queued mission to completion, then parks", async () => {
    const calls: string[] = [];
    await withWorker(
      {
        checkRoomAgentSupervisorTurn: async () => {
          calls.push("check");
          return "RUN";
        },
        runCodexAppServerTurn: async () => {
          calls.push("turn");
          return {
            status: "COMPLETED",
            message: "done",
            roomAgentOutcome: {
              status: "VERIFIED",
              statusReason: "done"
            }
          };
        },
        finishRoomAgentSupervisorTurn: async (input: { status?: string }) => {
          calls.push(`finish:${input.status ?? "none"}`);
        },
        discardRoomAgentSupervisorTurn: async () => {
          calls.push("discard");
        }
      },
      async () => {
        const handle = await env.client.workflow.start("roomAgentSupervisorWorkflow", {
          args: [
            {
              roomId: "room:supervisor",
              pending: [queueItem("one")],
              monitoringMissionIds: [],
              interrupted: [],
              processedCount: 0
            }
          ],
          taskQueue: SUPERVISOR_QUEUE,
          workflowId: "wf:supervisor:complete"
        });
        // The child codexAppServerTurnWorkflow runs for real; its activity is stubbed.
        await env.sleep("30 seconds");
        await handle.cancel();
        await expect(handle.result()).rejects.toThrow();
      }
    );
    expect(calls).toContain("check");
    expect(calls).toContain("turn");
    expect(calls).toContain("finish:COMPLETED");
  }, 300_000);

  it("records an operator stop on a queued mission as INTERRUPTED", async () => {
    const finishes: Array<{ status?: string; statusReason?: string }> = [];
    await withWorker(
      {
        checkRoomAgentSupervisorTurn: async () => {
          // Never returns RUN, so the stop signal lands on a queued item.
          return "PAUSED";
        },
        finishRoomAgentSupervisorTurn: async (input: { status?: string; statusReason?: string }) => {
          finishes.push(input);
        },
        discardRoomAgentSupervisorTurn: async () => undefined
      },
      async () => {
        const handle = await env.client.workflow.start("roomAgentSupervisorWorkflow", {
          args: [
            {
              roomId: "room:supervisor",
              pending: [queueItem("stop")],
              monitoringMissionIds: [],
              interrupted: [],
              processedCount: 0
            }
          ],
          taskQueue: SUPERVISOR_QUEUE,
          workflowId: "wf:supervisor:stop"
        });
        await env.sleep("5 seconds");
        await handle.signal("stopRoomAgentMission", {
          missionId: "mission:supervisor",
          reason: "Operator stopped the room agent."
        });
        await env.sleep("5 seconds");
        await handle.cancel();
        await expect(handle.result()).rejects.toThrow();
      }
    );
    expect(finishes.some((entry) => entry.status === "INTERRUPTED")).toBe(true);
  }, 300_000);

  it("continues as new once 50 missions have been processed", async () => {
    let processed = 0;
    await withWorker(
      {
        checkRoomAgentSupervisorTurn: async () => {
          processed += 1;
          return "SKIP";
        },
        finishRoomAgentSupervisorTurn: async () => undefined,
        discardRoomAgentSupervisorTurn: async () => undefined
      },
      async () => {
        const pending = Array.from({ length: 50 }, (_, index) =>
          queueItem(`bulk-${String(index).padStart(3, "0")}`)
        );
        const handle = await env.client.workflow.start("roomAgentSupervisorWorkflow", {
          args: [
            {
              roomId: "room:supervisor",
              pending,
              monitoringMissionIds: [],
              interrupted: [],
              processedCount: 0
            }
          ],
          taskQueue: SUPERVISOR_QUEUE,
          workflowId: "wf:supervisor:continue"
        });
        // continueAsNew starts a fresh run under the same workflow id, so the
        // handle keeps following the chain and the run id changes.
        await env.sleep("120 seconds");
        const description = await handle.describe();
        expect(description.workflowId).toBe("wf:supervisor:continue");
        expect(description.runId).not.toBe(handle.firstExecutionRunId);
        await handle.cancel();
        await expect(handle.result()).rejects.toThrow();
      }
    );
    expect(processed).toBeGreaterThanOrEqual(50);
  }, 300_000);

  it("continues as new after 250 monitoring polls with the carried state intact", async () => {
    let polls = 0;
    await withWorker(
      {
        checkRoomAgentSupervisorTurn: async () => "SKIP",
        finishRoomAgentSupervisorTurn: async () => undefined,
        discardRoomAgentSupervisorTurn: async () => undefined,
        // "WORKING" keeps the mission in the monitoring set, so the poll loop
        // keeps running until the 250-poll bound trips continueAsNew.
        prepareRoomAgentBackgroundContinuation: async () => {
          polls += 1;
          return { state: "WORKING" };
        }
      },
      async () => {
        const handle = await env.client.workflow.start("roomAgentSupervisorWorkflow", {
          args: [
            {
              roomId: "room:supervisor",
              pending: [],
              monitoringMissionIds: ["mission:supervisor"],
              interrupted: [],
              processedCount: 0
            }
          ],
          taskQueue: SUPERVISOR_QUEUE,
          workflowId: "wf:supervisor:polls"
        });
        await env.sleep("600 seconds");
        const description = await handle.describe();
        expect(description.workflowId).toBe("wf:supervisor:polls");
        expect(description.runId).not.toBe(handle.firstExecutionRunId);
        await handle.cancel();
        await expect(handle.result()).rejects.toThrow();
      }
    );
    expect(polls).toBeGreaterThanOrEqual(250);
  }, 300_000);

  it("keeps the legacy branch reachable for histories that predate the patch", async () => {
    const calls: string[] = [];
    await withWorker(
      {
        settleRoomAgentBackgroundMission: async () => {
          calls.push("settle");
          return true;
        },
        markRoomAgentMissionStarted: async () => undefined,
        markRoomAgentMissionFinished: async () => undefined,
        markRoomAgentMissionContinued: async () => undefined
      },
      async () => {
        const handle = await env.client.workflow.start("legacyRoomAgentSupervisorWorkflow", {
          args: [
            {
              roomId: "room:supervisor",
              pending: [],
              monitoringMissionIds: ["mission:supervisor"],
              interrupted: [],
              processedCount: 0
            }
          ],
          taskQueue: SUPERVISOR_QUEUE,
          workflowId: "wf:supervisor:legacy"
        });
        await env.sleep("30 seconds");
        await handle.cancel();
        await expect(handle.result()).rejects.toThrow();
      }
    );
    // The legacy branch polls the boolean settle activity while monitoring.
    expect(calls).toContain("settle");
  }, 300_000);

  it("continues as new from the pre-patch branch after 250 monitoring polls", async () => {
    let polls = 0;
    await withWorker(
      {
        // false keeps the mission in the monitoring set so the legacy poll loop
        // reaches its 250-poll bound, which is that branch's continueAsNew path.
        settleRoomAgentBackgroundMission: async () => {
          polls += 1;
          return false;
        },
        markRoomAgentMissionStarted: async () => undefined,
        markRoomAgentMissionFinished: async () => undefined,
        markRoomAgentMissionContinued: async () => undefined
      },
      async () => {
        const handle = await env.client.workflow.start("legacyRoomAgentSupervisorWorkflow", {
          args: [
            {
              roomId: "room:supervisor",
              pending: [],
              monitoringMissionIds: ["mission:supervisor"],
              interrupted: [],
              processedCount: 0
            }
          ],
          taskQueue: SUPERVISOR_QUEUE,
          workflowId: "wf:supervisor:legacy-continue"
        });
        await env.sleep("600 seconds");
        const description = await handle.describe();
        expect(description.runId).not.toBe(handle.firstExecutionRunId);
        await handle.cancel();
        await expect(handle.result()).rejects.toThrow();
      }
    );
    expect(polls).toBeGreaterThanOrEqual(250);
  }, 300_000);
});
