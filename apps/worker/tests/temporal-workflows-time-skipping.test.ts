import path from "node:path";
import { fileURLToPath } from "node:url";
import { Context } from "@temporalio/activity";
import { WorkflowContinuedAsNewError, WorkflowFailedError } from "@temporalio/client";
import { ApplicationFailure } from "@temporalio/common";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import {
  cliChatTurnDefaultRuntimeIds,
  DOT_GOAL_SIGNAL,
  MEMORY_MUTATION_TASK_QUEUE,
  ROOM_AGENT_ENQUEUE_SIGNAL,
  ROOM_AGENT_STOP_SIGNAL,
  roomAgentSupervisorInputSchema,
  roomAgentSupervisorQueueItemSchema,
  type RoomAgentSupervisorInput,
  type RoomAgentSupervisorQueueItem
} from "@space/contracts";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  discardSupervisorTurn,
  finishSupervisorTurn,
  prepareBackgroundContinuation,
  supervisorTurnState
} from "../src/room-background-continuation.js";
import { MEMORY_MAINTENANCE_TASK_QUEUE } from "../src/memory-maintenance-config.js";
import { continuationFixture } from "./room-continuation-fixture.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const workerRoot = path.resolve(__dirname, "..");

const workflowsPath = path.resolve(workerRoot, "src/workflows.ts");
const memoryMaintenanceWorkflowsPath = path.resolve(workerRoot, "src/memory-maintenance-workflows.ts");
const memoryMutationWorkflowsPath = path.resolve(workerRoot, "src/memory-mutation-workflows.ts");

function makeQueueItem(
  roomId: string,
  missionId: string,
  suffix: string,
  continuation = false
): RoomAgentSupervisorQueueItem {
  return roomAgentSupervisorQueueItemSchema.parse({
    missionId,
    turn: {
      roomId,
      paneId: `pane:${suffix}`,
      prompt: `Prompt ${suffix}`,
      roomAgentOperatorRequest: `Prompt ${suffix}`,
      roomAgentMissionId: missionId,
      ...(continuation
        ? { roomAgentContinuation: { sourceRunId: "agent_run:initial", generation: 1 } }
        : {}),
      artifactIds: [],
      agentSessionId: `agent_session:${suffix}`,
      agentRunId: `agent_run:${suffix}`,
      agentUserMessageId: `agent_msg:user-${suffix}`,
      agentAssistantMessageId: `agent_msg:assistant-${suffix}`,
      permissionMode: null,
      collaborationMode: "default",
      traceId: `trace:${suffix}`
    }
  });
}

async function extractContinuedAsNewInput<T>(
  env: TestWorkflowEnvironment,
  workflowId: string,
  runId: string
): Promise<T> {
  const handle = env.client.workflow.getHandle(workflowId, runId);
  const history = await handle.fetchHistory();
  const closeEvent = history.events?.find(
    (e) => Boolean(e.workflowExecutionContinuedAsNewEventAttributes)
  );
  const payload =
    closeEvent?.workflowExecutionContinuedAsNewEventAttributes?.input?.payloads?.[0];
  if (!payload?.data) {
    throw new Error(`Expected continuedAsNew input payload for ${workflowId} (${runId})`);
  }
  return JSON.parse(Buffer.from(payload.data).toString("utf8")) as T;
}

describe("Temporal workflows on time-skipping TestWorkflowEnvironment", () => {
  let env: TestWorkflowEnvironment;
  let queueSeq = 0;
  const nextQueue = (prefix: string) => `${prefix}-${++queueSeq}`;

  beforeAll(async () => {
    env = await TestWorkflowEnvironment.createTimeSkipping();
  }, 60_000);

  afterAll(async () => {
    await env?.teardown();
  }, 30_000);

  describe("dotGoalWorkflow", () => {
    it(
      "handles timeout waits, early dotGoalWakeSignal, and activity retries",
      async () => {
        const taskQueue = nextQueue("dot-goal");
        let stepCalls = 0;
        let observeCalls = 0;
        let pausedStepEnteredResolve!: () => void;
        const pausedStepEntered = new Promise<void>((r) => {
          pausedStepEnteredResolve = r;
        });

        const worker = await Worker.create({
          connection: env.nativeConnection,
          taskQueue,
          workflowsPath,
          activities: {
            dotGoalStep: async () => {
              stepCalls += 1;
              if (stepCalls === 1) {
                // Triggers 1-hour PAUSED wait while time skipping is still locked;
                // dotGoalWakeSignal wakes it immediately without waiting for the timer.
                pausedStepEnteredResolve();
                return { state: "PAUSED", runId: null, goalStatus: "PAUSED" };
              }
              if (stepCalls === 2) {
                throw new Error("Transient step error");
              }
              if (stepCalls === 3) {
                // Triggers 30-second wait timer (time-skipped automatically inside handle.result())
                return { state: "WAITING", runId: null, goalStatus: "RUNNING" };
              }
              if (stepCalls === 4) {
                return { state: "RUNNING", runId: "run:dot-active", goalStatus: "RUNNING" };
              }
              return { state: "DONE", runId: "run:dot-active", goalStatus: "COMPLETED" };
            },
            dotGoalObserve: async () => {
              observeCalls += 1;
              if (observeCalls === 1) {
                throw new Error("Transient observe error");
              }
              if (observeCalls === 2) {
                return { run: "RUNNING", goalStatus: "RUNNING" };
              }
              return { run: "COMPLETED", goalStatus: "RUNNING" };
            }
          }
        });

        await worker.runUntil(async () => {
          const handle = await env.client.workflow.start("dotGoalWorkflow", {
            taskQueue,
            workflowId: `dot-goal-wake-${queueSeq}`,
            args: [{ goalId: "goal:wake-1" }]
          });

          await pausedStepEntered;
          await handle.signal(DOT_GOAL_SIGNAL);

          const result = await handle.result();
          expect(result).toEqual({ goalStatus: "COMPLETED" });
          expect(stepCalls).toBe(5);
          expect(observeCalls).toBe(3);
        });
      },
      30_000
    );

    it(
      "continues as new after 300 iterations while unfinished and finishes in the continued run",
      async () => {
        const taskQueue = nextQueue("dot-goal-can");
        let stepCalls = 0;

        const worker = await Worker.create({
          connection: env.nativeConnection,
          taskQueue,
          workflowsPath,
          activities: {
            dotGoalStep: async () => {
              stepCalls += 1;
              if (stepCalls <= 300) {
                return { state: "WAITING", runId: null, goalStatus: "RUNNING" };
              }
              return { state: "DONE", runId: "run:final", goalStatus: "COMPLETED" };
            },
            dotGoalObserve: async () => ({ run: "COMPLETED", goalStatus: "COMPLETED" })
          }
        });

        await worker.runUntil(async () => {
          const workflowId = `dot-goal-can-${queueSeq}`;
          const firstRunHandle = await env.client.workflow.start("dotGoalWorkflow", {
            taskQueue,
            workflowId,
            args: [{ goalId: "goal:long-running" }],
            followRuns: false
          });

          await expect(firstRunHandle.result()).rejects.toThrow(WorkflowContinuedAsNewError);
          const carried = await extractContinuedAsNewInput<{ goalId: string }>(
            env,
            workflowId,
            firstRunHandle.firstExecutionRunId
          );
          expect(carried).toEqual({ goalId: "goal:long-running" });

          const followHandle = env.client.workflow.getHandle(workflowId);
          const finalResult = await followHandle.result();
          expect(finalResult).toEqual({ goalStatus: "COMPLETED" });
          expect(stepCalls).toBe(301);
        });
      },
      45_000
    );
  });

  describe("dummyTurnWorkflow and codexAppServerTurnWorkflow", () => {
    it(
      "retries transient activity failures in dummyTurnWorkflow and fails after maximumAttempts (3)",
      async () => {
        const taskQueue = nextQueue("dummy-turn");
        let startAttempts = 0;
        let completeAttempts = 0;

        const worker = await Worker.create({
          connection: env.nativeConnection,
          taskQueue,
          workflowsPath,
          activities: {
            recordDummyTurnStarted: async (input) => {
              if (input.runId === "run:fail-always") {
                throw new Error("Permanent start failure");
              }
              if (++startAttempts < 3) {
                throw new Error("Transient start failure");
              }
            },
            recordDummyTurnCompleted: async (input) => {
              if (++completeAttempts < 2) {
                throw new Error("Transient complete failure");
              }
              return {
                runId: input.runId,
                threadId: input.threadId,
                status: "COMPLETED" as const,
                assistantMessage: `Completed: ${input.userMessage}`
              };
            }
          }
        });

        await worker.runUntil(async () => {
          const res = await env.client.workflow.execute("dummyTurnWorkflow", {
            taskQueue,
            workflowId: `dummy-turn-ok-${queueSeq}`,
            args: [{ runId: "run:ok", threadId: "thread:ok", userMessage: "ping" }]
          });
          expect(res).toEqual({
            runId: "run:ok",
            threadId: "thread:ok",
            status: "COMPLETED",
            assistantMessage: "Completed: ping"
          });
          expect(startAttempts).toBe(3);
          expect(completeAttempts).toBe(2);

          await expect(
            env.client.workflow.execute("dummyTurnWorkflow", {
              taskQueue,
              workflowId: `dummy-turn-fail-${queueSeq}`,
              args: [{ runId: "run:fail-always", threadId: "thread:fail", userMessage: "boom" }]
            })
          ).rejects.toThrow(WorkflowFailedError);
        });
      },
      30_000
    );

    it(
      "routes codexAppServerTurnWorkflow across native, room-agent, opencode, and CLI providers with their retry policies",
      async () => {
        const taskQueue = nextQueue("codex-turn");
        let codexAttempts = 0;
        let openCodeAttempts = 0;
        let cliAttempts = 0;

        const worker = await Worker.create({
          connection: env.nativeConnection,
          taskQueue,
          workflowsPath,
          activities: {
            runCodexAppServerTurn: async (input) => {
              if (++codexAttempts < 3) {
                throw new Error("Transient codex turn failure");
              }
              return {
                runId: input.runId,
                threadId: input.threadId,
                status: "COMPLETED" as const,
                assistantMessage: input.roomAgentMissionId ? "Room turn ok" : "Native turn ok"
              };
            },
            runOpenCodeAgentTurn: async () => {
              openCodeAttempts += 1;
              throw new Error("OpenCode non-retried failure");
            },
            runCliAgentTurn: async () => {
              cliAttempts += 1;
              throw new Error("CLI non-retried failure");
            }
          }
        });

        await worker.runUntil(async () => {
          const nativeRes = await env.client.workflow.execute("codexAppServerTurnWorkflow", {
            taskQueue,
            workflowId: `codex-native-${queueSeq}`,
            args: [
              {
                runId: "run:native",
                threadId: "thread:native",
                userMessage: "hello",
                agentSessionId: "session:native",
                agentAssistantMessageId: "msg:native"
              }
            ]
          });
          expect(nativeRes.assistantMessage).toBe("Native turn ok");
          expect(codexAttempts).toBe(3);

          const roomRes = await env.client.workflow.execute("codexAppServerTurnWorkflow", {
            taskQueue,
            workflowId: `codex-room-${queueSeq}`,
            args: [
              {
                runId: "run:room",
                threadId: "thread:room",
                userMessage: "hello room",
                roomAgentMissionId: "mission:room"
              }
            ]
          });
          expect(roomRes.assistantMessage).toBe("Room turn ok");
          expect(codexAttempts).toBe(4);

          // OpenCode has maximumAttempts: 1
          await expect(
            env.client.workflow.execute("codexAppServerTurnWorkflow", {
              taskQueue,
              workflowId: `codex-opencode-${queueSeq}`,
              args: [
                {
                  runId: "run:oc",
                  threadId: "thread:oc",
                  userMessage: "hi",
                  providerId: "opencode"
                }
              ]
            })
          ).rejects.toThrow(WorkflowFailedError);
          expect(openCodeAttempts).toBe(1);

          // CLI provider has maximumAttempts: 1
          await expect(
            env.client.workflow.execute("codexAppServerTurnWorkflow", {
              taskQueue,
              workflowId: `codex-cli-${queueSeq}`,
              args: [
                {
                  runId: "run:cli",
                  threadId: "thread:cli",
                  userMessage: "hi",
                  providerId: cliChatTurnDefaultRuntimeIds[0]
                }
              ]
            })
          ).rejects.toThrow(WorkflowFailedError);
          expect(cliAttempts).toBe(1);
        });
      },
      30_000
    );
  });

  describe("roomAgentActionWorkflow", () => {
    it(
      "persists background failure via room-background-action-failure-v1 after retries are exhausted",
      async () => {
        const taskQueue = nextQueue("room-action");
        let runAttempts = 0;
        const failCalls: Array<Record<string, unknown>> = [];

        const worker = await Worker.create({
          connection: env.nativeConnection,
          taskQueue,
          workflowsPath,
          activities: {
            runRoomAgentBackgroundAction: async () => {
              runAttempts += 1;
              throw new Error("transport failed");
            },
            failRoomAgentBackgroundAction: async (payload) => {
              failCalls.push(payload as unknown as Record<string, unknown>);
            }
          }
        });

        await worker.runUntil(async () => {
          await expect(
            env.client.workflow.execute("roomAgentActionWorkflow", {
              taskQueue,
              workflowId: "space-room-action:action:legacy",
              args: [
                {
                  bridge: { roomId: "room:proof", missionId: "mission:proof" },
                  traceId: "trace:proof"
                }
              ]
            })
          ).rejects.toThrow(WorkflowFailedError);

          // ROOM_AGENT_TURN_ACTIVITY_MAX_ATTEMPTS is 5
          expect(runAttempts).toBe(5);
          expect(failCalls).toEqual([
            {
              roomId: "room:proof",
              missionId: "mission:proof",
              actionId: "action:legacy",
              cancelled: false
            }
          ]);
        });
      },
      30_000
    );
  });

  describe("roomAgentSupervisorWorkflow (current patched branch)", () => {
    it(
      "executes allocation -> send -> verification in one mission",
      async () => {
        const taskQueue = nextQueue("sup-alloc");
        const c = continuationFixture();
        let childCalls = 0;
        let finishedResolve!: () => void;
        const finishedPromise = new Promise<void>((r) => {
          finishedResolve = r;
        });

        const finishSpy = vi.fn(async (input) => {
          await finishSupervisorTurn(input, c.store);
          setTimeout(finishedResolve, 50);
        });

        const worker = await Worker.create({
          connection: env.nativeConnection,
          taskQueue,
          workflowsPath,
          activities: {
            prepareRoomAgentBackgroundContinuation: async (input) =>
              prepareBackgroundContinuation(input, c.store),
            checkRoomAgentSupervisorTurn: async (item) => supervisorTurnState(item, c.store),
            discardRoomAgentSupervisorTurn: async ({ item, reason }) =>
              discardSupervisorTurn(item, reason, c.store),
            finishRoomAgentSupervisorTurn: finishSpy,
            runCodexAppServerTurn: async (turn) => {
              childCalls += 1;
              if (childCalls === 1) {
                expect(turn.prompt).toContain("Open CLI and Chat, then send a story");
                c.store.createRoomAgentAction({
                  ...c.action,
                  actionId: "action:send",
                  idempotencyKey: "send-once",
                  actionType: "SEND",
                  evidence: { cli: "Story complete", chat: "Story complete" },
                  statusReason: "Both tasks completed."
                });
                c.store.updateSpaceAgentRun(turn.agentRunId!, { status: "COMPLETED" });
                return {
                  runId: turn.agentRunId ?? "run:1",
                  threadId: "thread:1",
                  status: "COMPLETED" as const,
                  assistantMessage: "Sent",
                  roomAgentOutcome: {
                    status: "VERIFIED" as const,
                    executedActionCount: 1,
                    pendingActionIds: ["action:send"],
                    statusReason: "Queued"
                  }
                };
              }
              c.store.updateSpaceAgentRun(turn.agentRunId!, { status: "COMPLETED" });
              return {
                runId: turn.agentRunId ?? "run:2",
                threadId: "thread:2",
                status: "COMPLETED" as const,
                assistantMessage: "Verified",
                roomAgentOutcome: {
                  status: "VERIFIED" as const,
                  executedActionCount: 1,
                  statusReason: "Verified remaining request."
                }
              };
            }
          }
        });

        await worker.runUntil(async () => {
          const input = roomAgentSupervisorInputSchema.parse({
            roomId: c.room.id,
            monitoringMissionIds: [c.initial.mission.id]
          });
          const handle = await env.client.workflow.start("roomAgentSupervisorWorkflow", {
            taskQueue,
            workflowId: `sup-alloc-${queueSeq}`,
            args: [input]
          });

          await finishedPromise;
          await new Promise((r) => setTimeout(r, 100));
          await handle.terminate();

          expect(childCalls).toBe(2);
          expect(
            c.store.listRoomAgentActions(c.initial.mission.id).filter((a) => a.actionType === "SEND")
          ).toHaveLength(1);
          expect(c.store.getRoomAgentMission(c.room.id, c.initial.mission.id)?.status).toBe(
            "COMPLETED"
          );
          expect(finishSpy).toHaveBeenCalledOnce();
        });
      },
      30_000
    );

    it.each(["stop", "follow-up"] as const)(
      "retires a prepared run when %s arrives before the activity reply",
      async (kind) => {
        const taskQueue = nextQueue(`sup-retire-${kind}`);
        const c = continuationFixture();
        let childCalls = 0;
        let prepareCalls = 0;
        const childPrompts: Array<string | undefined> = [];

        let prepareEnteredResolve!: () => void;
        const prepareEntered = new Promise<void>((r) => {
          prepareEnteredResolve = r;
        });
        let signalSentResolve!: () => void;
        const signalSent = new Promise<void>((r) => {
          signalSentResolve = r;
        });
        let settledResolve!: () => void;
        const settled = new Promise<void>((r) => {
          settledResolve = r;
        });

        let preparedRunId = "";
        let discardDone = false;
        let followUpDone = false;
        const checkFollowUpSettled = () => {
          if (kind === "follow-up" && discardDone && followUpDone) {
            setTimeout(settledResolve, 100);
          }
        };

        const worker = await Worker.create({
          connection: env.nativeConnection,
          taskQueue,
          workflowsPath,
          activities: {
            prepareRoomAgentBackgroundContinuation: async (input) => {
              prepareCalls += 1;
              if (prepareCalls > 1) {
                followUpDone = true;
                checkFollowUpSettled();
                return { state: "DONE" as const };
              }
              const result = await prepareBackgroundContinuation(input, c.store);
              if (result.state === "READY") {
                preparedRunId = result.item.turn.agentRunId!;
              }
              prepareEnteredResolve();
              await signalSent;
              return result;
            },
            checkRoomAgentSupervisorTurn: async (item) => supervisorTurnState(item, c.store),
            discardRoomAgentSupervisorTurn: async ({ item, reason }) => {
              await discardSupervisorTurn(item, reason, c.store);
              if (item.turn.agentRunId === preparedRunId) {
                discardDone = true;
              }
              if (kind === "stop") {
                setTimeout(settledResolve, 100);
              } else {
                checkFollowUpSettled();
              }
            },
            finishRoomAgentSupervisorTurn: async (input) => {
              await finishSupervisorTurn(input, c.store);
            },
            runCodexAppServerTurn: async (turn) => {
              childCalls += 1;
              childPrompts.push(turn.roomAgentOperatorRequest);
              c.store.updateSpaceAgentRun(turn.agentRunId!, { status: "COMPLETED" });
              return {
                runId: turn.agentRunId ?? "run:followup",
                threadId: "thread:followup",
                status: "COMPLETED" as const,
                assistantMessage: "Verified",
                roomAgentOutcome: {
                  status: "VERIFIED" as const,
                  executedActionCount: 1,
                  statusReason: "Verified remaining request."
                }
              };
            }
          }
        });

        await worker.runUntil(async () => {
          const input = roomAgentSupervisorInputSchema.parse({
            roomId: c.room.id,
            monitoringMissionIds: [c.initial.mission.id]
          });
          const handle = await env.client.workflow.start("roomAgentSupervisorWorkflow", {
            taskQueue,
            workflowId: `sup-retire-${kind}-${queueSeq}`,
            args: [input]
          });

          await prepareEntered;
          if (kind === "stop") {
            c.store.updateRoomAgentMission(c.initial.mission.id, { status: "INTERRUPTED" });
            await handle.signal(ROOM_AGENT_STOP_SIGNAL, { missionId: null, reason: "Stop" });
          } else {
            const followUp = c.enqueue("follow-up", "Only inspect the room.");
            await handle.signal(ROOM_AGENT_ENQUEUE_SIGNAL, followUp.queueItem);
          }
          signalSentResolve();

          await settled;
          await handle.terminate();

          expect(preparedRunId).toBeTruthy();
          expect(c.store.getRoomAgentTurn(c.initial.mission.id, preparedRunId)?.run.status).toBe(
            "INTERRUPTED"
          );
          if (kind === "stop") {
            expect(childCalls).toBe(0);
          } else {
            expect(childCalls).toBe(1);
            expect(childPrompts[0]).toBe("Only inspect the room.");
          }
        });
      },
      30_000
    );

    it(
      "carries a prepared continuation through continueAsNew and starts it once",
      async () => {
        const taskQueue = nextQueue("sup-carry-can");
        const c = continuationFixture();
        let childCalls = 0;
        let finishedResolve!: () => void;
        const finishedPromise = new Promise<void>((r) => {
          finishedResolve = r;
        });

        const worker = await Worker.create({
          connection: env.nativeConnection,
          taskQueue,
          workflowsPath,
          activities: {
            prepareRoomAgentBackgroundContinuation: async (input) =>
              prepareBackgroundContinuation(input, c.store),
            checkRoomAgentSupervisorTurn: async (item) => supervisorTurnState(item, c.store),
            discardRoomAgentSupervisorTurn: async ({ item, reason }) =>
              discardSupervisorTurn(item, reason, c.store),
            finishRoomAgentSupervisorTurn: async (input) => {
              await finishSupervisorTurn(input, c.store);
              setTimeout(finishedResolve, 100);
            },
            runCodexAppServerTurn: async (turn) => {
              childCalls += 1;
              c.store.updateSpaceAgentRun(turn.agentRunId!, { status: "COMPLETED" });
              return {
                runId: turn.agentRunId ?? "run:carried",
                threadId: "thread:carried",
                status: "COMPLETED" as const,
                assistantMessage: "Verified",
                roomAgentOutcome: {
                  status: "VERIFIED" as const,
                  executedActionCount: 1,
                  statusReason: "Verified remaining request."
                }
              };
            }
          }
        });

        await worker.runUntil(async () => {
          const workflowId = `sup-carry-can-${queueSeq}`;
          const input = roomAgentSupervisorInputSchema.parse({
            roomId: c.room.id,
            monitoringMissionIds: [c.initial.mission.id],
            processedCount: 50
          });
          const handle = await env.client.workflow.start("roomAgentSupervisorWorkflow", {
            taskQueue,
            workflowId,
            args: [input],
            followRuns: false
          });

          await expect(handle.result()).rejects.toThrow(WorkflowContinuedAsNewError);
          const carried = roomAgentSupervisorInputSchema.parse(
            await extractContinuedAsNewInput<RoomAgentSupervisorInput>(
              env,
              workflowId,
              handle.firstExecutionRunId
            )
          );
          expect(carried.pending).toHaveLength(1);

          await finishedPromise;
          await env.client.workflow.getHandle(workflowId).terminate();

          expect(childCalls).toBe(1);
          expect(c.store.getRoomAgentMission(c.room.id, c.initial.mission.id)?.status).toBe(
            "COMPLETED"
          );
        });
      },
      30_000
    );

    it(
      "defers continueAsNew until the carried queue fits the next run's input bounds",
      async () => {
        const taskQueue = nextQueue("sup-carry-bound");
        const roomId = "room:carry-bound";
        const item = (index: number) =>
          roomAgentSupervisorQueueItemSchema.parse({
            missionId: "mission:carry-bound",
            turn: {
              roomId,
              paneId: "pane:carry-bound",
              prompt: `Queued request ${index}`,
              artifactIds: [],
              agentRunId: `agent_run:carry-${String(index).padStart(3, "0")}`,
              permissionMode: null,
              collaborationMode: "default",
              traceId: `trace:carry-${index}`
            }
          });

        let checkCalls = 0;
        let firstCheckEnteredResolve!: () => void;
        const firstCheckEntered = new Promise<void>((r) => {
          firstCheckEnteredResolve = r;
        });
        let floodedResolve!: () => void;
        const flooded = new Promise<void>((r) => {
          floodedResolve = r;
        });

        const worker = await Worker.create({
          connection: env.nativeConnection,
          taskQueue,
          workflowsPath,
          activities: {
            checkRoomAgentSupervisorTurn: async () => {
              checkCalls += 1;
              if (checkCalls === 1) {
                firstCheckEnteredResolve();
                await flooded;
              }
              return "SKIP";
            },
            discardRoomAgentSupervisorTurn: async () => {
              if (checkCalls > 6) {
                throw ApplicationFailure.nonRetryable("Stop Run 2 after continueAsNew check");
              }
            },
            finishRoomAgentSupervisorTurn: async () => undefined
          }
        });

        await worker.runUntil(async () => {
          const workflowId = `sup-carry-bound-${queueSeq}`;
          const input = roomAgentSupervisorInputSchema.parse({
            roomId,
            pending: [item(0)],
            processedCount: 49
          });
          const handle = await env.client.workflow.start("roomAgentSupervisorWorkflow", {
            taskQueue,
            workflowId,
            args: [input],
            followRuns: false
          });

          await firstCheckEntered;
          for (let index = 1; index <= 105; index += 1) {
            await handle.signal(ROOM_AGENT_ENQUEUE_SIGNAL, item(index));
          }
          floodedResolve();

          await expect(handle.result()).rejects.toThrow(WorkflowContinuedAsNewError);
          const carried = await extractContinuedAsNewInput<RoomAgentSupervisorInput>(
            env,
            workflowId,
            handle.firstExecutionRunId
          );
          expect(carried.pending).toHaveLength(100);
          expect(() => roomAgentSupervisorInputSchema.parse(carried)).not.toThrow();
          expect(checkCalls).toBeGreaterThanOrEqual(6);

          await expect(env.client.workflow.getHandle(workflowId).result()).rejects.toThrow(
            WorkflowFailedError
          );
        });
      },
      45_000
    );

    it(
      "interrupts a running mission when stop signal arrives and continues as new after 250 monitoring polls",
      async () => {
        const taskQueue = nextQueue("sup-interrupt-and-polls");
        const roomId = "room:sup-interrupt";
        let childStartedResolve!: () => void;
        const childStarted = new Promise<void>((r) => {
          childStartedResolve = r;
        });
        const finishRecords: Array<Record<string, unknown>> = [];
        let interruptedDoneResolve!: () => void;
        const interruptedDone = new Promise<void>((r) => {
          interruptedDoneResolve = r;
        });
        let pollCalls = 0;

        const worker = await Worker.create({
          connection: env.nativeConnection,
          taskQueue,
          workflowsPath,
          maxHeartbeatThrottleInterval: "50 ms",
          defaultHeartbeatThrottleInterval: "50 ms",
          activities: {
            checkRoomAgentSupervisorTurn: async () => "READY",
            discardRoomAgentSupervisorTurn: async () => undefined,
            finishRoomAgentSupervisorTurn: async (payload) => {
              finishRecords.push(payload as unknown as Record<string, unknown>);
              setTimeout(interruptedDoneResolve, 100);
            },
            prepareRoomAgentBackgroundContinuation: async () => {
              pollCalls += 1;
              if (pollCalls > 250) {
                throw ApplicationFailure.nonRetryable("Stop Run 2 after 250 polls");
              }
              return { state: "WAITING" as const };
            },
            runCodexAppServerTurn: async () => {
              childStartedResolve();
              await Promise.race([Context.current().cancelled, interruptedDone]);
              throw new Error("Activity cancelled");
            }
          }
        });

        await worker.runUntil(async () => {
          // Part A: Continue-as-new after 250 monitoring polls with carried state intact
          const wfPollsId = `sup-polls-${queueSeq}`;
          const pollsHandle = await env.client.workflow.start("roomAgentSupervisorWorkflow", {
            taskQueue,
            workflowId: wfPollsId,
            args: [
              roomAgentSupervisorInputSchema.parse({
                roomId,
                monitoringMissionIds: ["mission:monitored-250"]
              })
            ],
            followRuns: false
          });

          await expect(pollsHandle.result()).rejects.toThrow(WorkflowContinuedAsNewError);
          const carried = roomAgentSupervisorInputSchema.parse(
            await extractContinuedAsNewInput<RoomAgentSupervisorInput>(
              env,
              wfPollsId,
              pollsHandle.firstExecutionRunId
            )
          );
          expect(pollCalls).toBeGreaterThanOrEqual(250);
          expect(carried.monitoringMissionIds).toEqual(["mission:monitored-250"]);
          expect(carried.roomId).toBe(roomId);

          await expect(env.client.workflow.getHandle(wfPollsId).result()).rejects.toThrow(
            WorkflowFailedError
          );

          // Part B: Interrupt a running child workflow mission
          const wfInterruptId = `sup-interrupt-${queueSeq}`;
          const interruptHandle = await env.client.workflow.start("roomAgentSupervisorWorkflow", {
            taskQueue,
            workflowId: wfInterruptId,
            args: [
              roomAgentSupervisorInputSchema.parse({
                roomId,
                pending: [makeQueueItem(roomId, "mission:running-1", "running-1", false)]
              })
            ]
          });

          await childStarted;
          await interruptHandle.signal(ROOM_AGENT_STOP_SIGNAL, {
            missionId: "mission:running-1",
            reason: "Aborted by operator test."
          });
          await interruptedDone;
          await interruptHandle.terminate();
          await (
            env.connection as unknown as {
              testService: { unlockTimeSkipping(req: Record<string, never>): Promise<void> };
            }
          ).testService.unlockTimeSkipping({});

          expect(finishRecords).toHaveLength(1);
          expect(finishRecords[0]?.status).toBe("INTERRUPTED");
          expect(finishRecords[0]?.statusReason).toBe("Aborted by operator test.");
        });
      },
      60_000
    );
  });

  describe("roomAgentSupervisorWorkflow (pre-patch branch)", () => {
    it(
      "preserves the legacy boolean settle activity, handles enqueue/stop signals and active cancellation, and continues as new after 50 items or 250 polls",
      async () => {
        const taskQueue = nextQueue("sup-legacy");
        const roomId = "room:legacy";
        let settleCalls = 0;
        let prepareCalls = 0;
        const finishedStatuses: Array<{ missionId: string; status: string; statusReason: string }> =
          [];

        let childStartedResolve!: () => void;
        const childStarted = new Promise<void>((r) => {
          childStartedResolve = r;
        });
        let childCancelledFinishResolve!: () => void;
        const childCancelledFinish = new Promise<void>((r) => {
          childCancelledFinishResolve = r;
        });

        const worker = await Worker.create({
          connection: env.nativeConnection,
          taskQueue,
          workflowsPath,
          maxHeartbeatThrottleInterval: "50 ms",
          defaultHeartbeatThrottleInterval: "50 ms",
          patchActivationCallback: ({ patchId }) => patchId !== "room-background-continuation-v1",
          activities: {
            settleRoomAgentBackgroundMission: async ({ missionId }) => {
              if (missionId === "mission:keep-monitoring") {
                throw ApplicationFailure.nonRetryable("Stop Run 2 of 50-item test");
              }
              settleCalls += 1;
              if (missionId === "mission:poll-250" && settleCalls > 250) {
                throw ApplicationFailure.nonRetryable("Stop Run 2 after 250 polls");
              }
              return false;
            },
            prepareRoomAgentBackgroundContinuation: async () => {
              prepareCalls += 1;
              return { state: "DONE" as const };
            },
            markRoomAgentMissionStarted: async () => undefined,
            markRoomAgentMissionContinued: async () => undefined,
            markRoomAgentMissionFinished: async (payload) => {
              finishedStatuses.push({
                missionId: payload.missionId,
                status: payload.status,
                statusReason: payload.statusReason
              });
              if (payload.missionId === "mission:legacy-cancel") {
                setTimeout(childCancelledFinishResolve, 100);
              }
            },
            runCodexAppServerTurn: async (turn) => {
              if (turn.roomAgentMissionId === "mission:legacy-cancel") {
                childStartedResolve();
                await Promise.race([Context.current().cancelled, childCancelledFinish]);
                throw new Error("Legacy activity cancelled");
              }
              return {
                runId: turn.agentRunId ?? "run:legacy",
                threadId: "thread:legacy",
                status: "COMPLETED" as const,
                assistantMessage: "Done"
              };
            }
          }
        });

        await worker.runUntil(async () => {
          // 1. Pre-patch branch calls settleRoomAgentBackgroundMission (not prepareRoomAgentBackgroundContinuation)
          //    and continues as new after 50 processed items
          const wf50Id = `sup-legacy-50-${queueSeq}`;
          const handle50 = await env.client.workflow.start("roomAgentSupervisorWorkflow", {
            taskQueue,
            workflowId: wf50Id,
            args: [
              roomAgentSupervisorInputSchema.parse({
                roomId,
                pending: [makeQueueItem(roomId, "mission:legacy-50", "item-50", false)],
                monitoringMissionIds: ["mission:keep-monitoring"],
                processedCount: 49
              })
            ],
            followRuns: false
          });

          await expect(handle50.result()).rejects.toThrow(WorkflowContinuedAsNewError);
          const carried50 = roomAgentSupervisorInputSchema.parse(
            await extractContinuedAsNewInput<RoomAgentSupervisorInput>(
              env,
              wf50Id,
              handle50.firstExecutionRunId
            )
          );
          expect(carried50.monitoringMissionIds).toEqual(["mission:keep-monitoring"]);
          expect(carried50.processedCount).toBe(0);
          await expect(env.client.workflow.getHandle(wf50Id).result()).rejects.toThrow(
            WorkflowFailedError
          );

          // 2. 250 monitoring polls on pre-patch branch triggers continueAsNew with carried state
          settleCalls = 0;
          const wf250Id = `sup-legacy-250-${queueSeq}`;
          const handle250 = await env.client.workflow.start("roomAgentSupervisorWorkflow", {
            taskQueue,
            workflowId: wf250Id,
            args: [
              roomAgentSupervisorInputSchema.parse({
                roomId,
                monitoringMissionIds: ["mission:poll-250"],
                processedCount: 12
              })
            ],
            followRuns: false
          });

          await expect(handle250.result()).rejects.toThrow(WorkflowContinuedAsNewError);
          const carried250 = roomAgentSupervisorInputSchema.parse(
            await extractContinuedAsNewInput<RoomAgentSupervisorInput>(
              env,
              wf250Id,
              handle250.firstExecutionRunId
            )
          );
          expect(settleCalls).toBeGreaterThanOrEqual(250);
          expect(prepareCalls).toBe(0);
          expect(carried250.monitoringMissionIds).toEqual(["mission:poll-250"]);
          expect(carried250.processedCount).toBe(12);
          await expect(env.client.workflow.getHandle(wf250Id).result()).rejects.toThrow(
            WorkflowFailedError
          );

          // 3. Interrupting a running mission on the pre-patch branch
          const wfCancelId = `sup-legacy-cancel-${queueSeq}`;
          const cancelHandle = await env.client.workflow.start("roomAgentSupervisorWorkflow", {
            taskQueue,
            workflowId: wfCancelId,
            args: [
              roomAgentSupervisorInputSchema.parse({
                roomId,
                pending: []
              })
            ]
          });
          await cancelHandle.signal(
            ROOM_AGENT_ENQUEUE_SIGNAL,
            makeQueueItem(roomId, "mission:legacy-cancel", "cancel-turn", false)
          );
          await childStarted;
          await cancelHandle.signal(ROOM_AGENT_STOP_SIGNAL, {
            missionId: "mission:legacy-cancel",
            reason: "Legacy operator stop."
          });
          await childCancelledFinish;
          await cancelHandle.terminate();
          await (
            env.connection as unknown as {
              testService: { unlockTimeSkipping(req: Record<string, never>): Promise<void> };
            }
          ).testService.unlockTimeSkipping({});

          expect(finishedStatuses).toContainEqual({
            missionId: "mission:legacy-cancel",
            status: "INTERRUPTED",
            statusReason: "Legacy operator stop."
          });
        });
      },
      60_000
    );
  });

  describe("memoryMaintenanceWorkflow, memoryConsolidationWorkflow, and memoryMutationWorkflow", () => {
    it(
      "continues memoryMaintenanceWorkflow when all-months refresh or session reconciliation fails, runs memoryConsolidationWorkflow as a child, and retries memory mutations",
      async () => {
        let allMonthsAttempts = 0;
        let reconcileAttempts = 0;
        let prepareAttempts = 0;
        let mutationAttempts = 0;
        const finalizedRuns: Array<Record<string, unknown>> = [];

        const maintenanceWorker = await Worker.create({
          connection: env.nativeConnection,
          taskQueue: MEMORY_MAINTENANCE_TASK_QUEUE,
          workflowsPath: memoryMaintenanceWorkflowsPath,
          activities: {
            refreshMemoryGraphSnapshot: async (input) => ({
              monthKey: input.monthKey ?? "2026-10",
              nodeCount: 12,
              edgeCount: 5,
              sourceHash: "sha256:maint-test"
            }),
            refreshAllMonthsMemoryGraphSnapshot: async () => {
              allMonthsAttempts += 1;
              throw new Error("All-months snapshot failed");
            },
            reconcileStaleSpaceAgentSessions: async () => {
              reconcileAttempts += 1;
              throw new Error("Stale session reconciliation failed");
            },
            createScheduledMemoryAudit: async (input) => ({
              id: "audit_run:child-1",
              workflowId: `memory-consolidation-child-${queueSeq}`,
              status: "QUEUED",
              createdAt: "2026-10-16T00:00:00.000Z",
              sourceHash: input.sourceHash
            }),
            prepareMemoryConsolidation: async (input) => {
              if (input.runId === "audit_run:noop") {
                return {
                  changeSetId: null,
                  run: { id: input.runId, status: "COMPLETED", traceId: input.traceId }
                };
              }
              if (++prepareAttempts < 2) {
                throw new Error("Transient prepare consolidation error");
              }
              return {
                changeSetId: "changeset:child-1",
                run: { id: input.runId, status: "RUNNING", traceId: input.traceId }
              };
            },
            finalizeMemoryRepair: async (payload) => {
              finalizedRuns.push(payload as unknown as Record<string, unknown>);
              return {
                id: payload.runId,
                changeSetId: payload.changeSetId,
                status: "COMPLETED"
              };
            }
          }
        });

        const mutationWorker = await Worker.create({
          connection: env.nativeConnection,
          taskQueue: MEMORY_MUTATION_TASK_QUEUE,
          workflowsPath: memoryMutationWorkflowsPath,
          activities: {
            executePersistedMemoryChangeSet: async (input) => {
              if (input.changeSetId === "changeset:fail-always") {
                throw new Error("Permanent mutation failure");
              }
              if (++mutationAttempts < 3) {
                throw new Error("Transient mutation execution error");
              }
              return {
                changeSetId: input.changeSetId,
                status: "APPLIED" as const,
                resultingSourceHash: "sha256:mutated",
                reason: null
              };
            }
          }
        });

        const mutationRun = mutationWorker.run();
        try {
          await maintenanceWorker.runUntil(async () => {
            // 1. memoryMaintenanceWorkflow continues despite all-months & reconcile failures and runs child memoryConsolidationWorkflow
            const maintResult = await env.client.workflow.execute("memoryMaintenanceWorkflow", {
              taskQueue: MEMORY_MAINTENANCE_TASK_QUEUE,
              workflowId: `memory-maint-${queueSeq}`,
              args: [{ monthKey: "2026-10", traceId: "trace:maint-1" }]
            });
            expect(maintResult).toEqual({
              monthKey: "2026-10",
              nodeCount: 12,
              edgeCount: 5,
              sourceHash: "sha256:maint-test"
            });
            expect(allMonthsAttempts).toBe(3);
            expect(reconcileAttempts).toBe(3);
            expect(prepareAttempts).toBe(2);
            expect(mutationAttempts).toBe(3);
            expect(finalizedRuns).toHaveLength(1);
            expect(finalizedRuns[0]?.changeSetId).toBe("changeset:child-1");

            // 2. memoryConsolidationWorkflow early return when changeSetId is null
            const noopRun = await env.client.workflow.execute("memoryConsolidationWorkflow", {
              taskQueue: MEMORY_MAINTENANCE_TASK_QUEUE,
              workflowId: `memory-cons-noop-${queueSeq}`,
              args: [{ runId: "audit_run:noop", traceId: "trace:noop" }]
            });
            expect(noopRun).toEqual({
              id: "audit_run:noop",
              status: "COMPLETED",
              traceId: "trace:noop"
            });

            // 3. memoryMutationWorkflow standalone retry and failure exhaustion
            mutationAttempts = 0;
            const mutRes = await env.client.workflow.execute("memoryMutationWorkflow", {
              taskQueue: MEMORY_MUTATION_TASK_QUEUE,
              workflowId: `memory-mut-ok-${queueSeq}`,
              args: [{ changeSetId: "changeset:standalone", traceId: "trace:mut-ok" }]
            });
            expect(mutRes).toEqual({
              changeSetId: "changeset:standalone",
              status: "APPLIED",
              resultingSourceHash: "sha256:mutated",
              reason: null
            });
            expect(mutationAttempts).toBe(3);

            await expect(
              env.client.workflow.execute("memoryMutationWorkflow", {
                taskQueue: MEMORY_MUTATION_TASK_QUEUE,
                workflowId: `memory-mut-fail-${queueSeq}`,
                args: [{ changeSetId: "changeset:fail-always", traceId: "trace:mut-fail" }]
              })
            ).rejects.toThrow(WorkflowFailedError);
          });
        } finally {
          mutationWorker.shutdown();
          await mutationRun;
        }
      },
      60_000
    );
  });
});
