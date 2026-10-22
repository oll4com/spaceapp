import {
  WorkflowContinuedAsNewError,
  WorkflowFailedError,
  type WorkflowHandle
} from "@temporalio/client";
import { ApplicationFailure } from "@temporalio/common";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  cliChatTurnDefaultRuntimeIds,
  DOT_GOAL_SIGNAL,
  ROOM_AGENT_ENQUEUE_SIGNAL,
  ROOM_AGENT_STOP_SIGNAL,
  roomAgentSupervisorInputSchema,
  type CodexAppServerTurnInput,
  type DotGoalWorkflowInput,
  type DummyTurnInput,
  type MemoryConsolidationRun,
  type MemoryMaintenanceInput,
  type MemoryMaintenanceResult,
  type MemoryMutationWorkflowResult,
  type RoomAgentSupervisorInput
} from "@space/contracts";
import { MEMORY_MAINTENANCE_TASK_QUEUE } from "../src/memory-maintenance-config.js";
import { MEMORY_MUTATION_TASK_QUEUE } from "../src/memory-mutation-config.js";
import {
  discardSupervisorTurn,
  finishSupervisorTurn,
  prepareBackgroundContinuation,
  supervisorTurnState
} from "../src/room-background-continuation.js";
import { continuationFixture } from "./room-continuation-fixture.js";
import {
  extractContinuedAsNewInput,
  installQuietTemporalRuntime,
  sampleQueueItem,
  WORKFLOW_SOURCE_PATHS,
  workflowBundlerOptions
} from "./support/temporal-test-harness.js";

describe("Temporal workflows on time-skipping test server", () => {
  let env: TestWorkflowEnvironment;

  beforeAll(async () => {
    installQuietTemporalRuntime();
    env = await TestWorkflowEnvironment.createTimeSkipping();
  }, 120_000);

  afterAll(async () => {
    await env?.teardown();
  }, 60_000);

  describe("dotGoalWorkflow", () => {
    it(
      "handles wake signal vs timeout, continues as new while unfinished, and retries or fails on activity errors",
      async () => {
        let mode: "signal-vs-timeout" | "continue-as-new" | "retry-then-fail" = "signal-vs-timeout";
        let stepCalls = 0;
        let observeCalls = 0;
        const stepTimestamps: number[] = [];
        let continueHandle: WorkflowHandle | null = null;
        let signalStep1Ready!: () => void;
        const step1Ready = new Promise<void>((resolve) => {
          signalStep1Ready = resolve;
        });

        const worker = await Worker.create({
          connection: env.nativeConnection,
          taskQueue: "test-dot-goal-queue",
          workflowsPath: WORKFLOW_SOURCE_PATHS["workflows.ts"],
          bundlerOptions: workflowBundlerOptions(),
          activities: {
            dotGoalStep: async () => {
              stepCalls += 1;

              if (mode === "signal-vs-timeout") {
                const now = await env.currentTimeMs();
                stepTimestamps.push(now);
                if (stepCalls === 1) {
                  signalStep1Ready();
                  return { state: "PAUSED" as const, runId: null, goalStatus: "PAUSED" as const };
                }
                if (stepCalls === 2) {
                  return { state: "WAITING" as const, runId: null, goalStatus: "ACTIVE" as const };
                }
                if (stepCalls === 3) {
                  return { state: "STARTED" as const, runId: "run:dot-1", goalStatus: "ACTIVE" as const };
                }
                return { state: "DONE" as const, runId: null, goalStatus: "COMPLETED" as const };
              }

              if (mode === "continue-as-new") {
                if (stepCalls > 300) {
                  return { state: "DONE" as const, runId: null, goalStatus: "COMPLETED" as const };
                }
                if (stepCalls > 2 && continueHandle) {
                  // Wake-up arriving during an activity ends the next wait at once.
                  await continueHandle.signal(DOT_GOAL_SIGNAL);
                }
                return { state: "WAITING" as const, runId: null, goalStatus: "ACTIVE" as const };
              }

              if (stepCalls === 1) {
                throw new Error("transient dotGoalStep error #1");
              }
              throw ApplicationFailure.nonRetryable("fatal dotGoalStep failure", "DotGoalFatalError");
            },
            dotGoalObserve: async () => {
              observeCalls += 1;
              return {
                run: observeCalls === 1 ? ("RUNNING" as const) : ("COMPLETED" as const),
                goalStatus: "ACTIVE" as const
              };
            }
          }
        });

        await worker.runUntil(async () => {
          // 1. Wake signal vs. timeout
          const handle1 = await env.client.workflow.start("dotGoalWorkflow", {
            taskQueue: "test-dot-goal-queue",
            workflowId: "test-dot-goal:signal-vs-timeout",
            args: [{ goalId: "dot_goal:test0001" } satisfies DotGoalWorkflowInput]
          });
          await step1Ready;
          // Step 1 returns PAUSED (1 hour timeout), wake early after 5s via DOT_GOAL_SIGNAL
          await env.sleep("5 seconds");
          await handle1.signal(DOT_GOAL_SIGNAL);
          const result1 = await handle1.result();
          expect(result1).toEqual({ goalStatus: "COMPLETED" });

          expect(stepCalls).toBe(4);
          expect(observeCalls).toBe(2);
          // Step 1 -> Step 2 woke early on signal (~5s instead of 1 hour = 3,600,000ms)
          expect(stepTimestamps[1]! - stepTimestamps[0]!).toBeLessThan(60_000);
          // Step 2 (WAITING) -> Step 3 waited full 30s timeout
          expect(stepTimestamps[2]! - stepTimestamps[1]!).toBeGreaterThanOrEqual(29_000);
          // Step 3 (STARTED) polled dotGoalObserve twice with 15s RUNNING timeout (>= 30s total)
          expect(stepTimestamps[3]! - stepTimestamps[2]!).toBeGreaterThanOrEqual(29_000);

          // 2. Continue-as-new after 300 iterations while goal remains ACTIVE, then finish in continued run
          mode = "continue-as-new";
          stepCalls = 0;
          continueHandle = await env.client.workflow.start("dotGoalWorkflow", {
            taskQueue: "test-dot-goal-queue",
            workflowId: "test-dot-goal:continue-as-new",
            args: [{ goalId: "dot_goal:test0002" } satisfies DotGoalWorkflowInput]
          });
          const firstRun2 = env.client.workflow.getHandle(
            "test-dot-goal:continue-as-new",
            continueHandle.firstExecutionRunId,
            { followRuns: false }
          );
          await expect(firstRun2.result()).rejects.toBeInstanceOf(WorkflowContinuedAsNewError);
          const carriedGoalInput = await extractContinuedAsNewInput<DotGoalWorkflowInput>(firstRun2);
          expect(carriedGoalInput).toEqual({ goalId: "dot_goal:test0002" });
          const finalGoalResult = await continueHandle.result();
          expect(finalGoalResult).toEqual({ goalStatus: "COMPLETED" });
          expect(stepCalls).toBe(301);
          continueHandle = null;

          // 3. Activity retry and terminal failure
          mode = "retry-then-fail";
          stepCalls = 0;
          const handle3 = await env.client.workflow.start("dotGoalWorkflow", {
            taskQueue: "test-dot-goal-queue",
            workflowId: "test-dot-goal:retry-fail",
            args: [{ goalId: "dot_goal:test0003" } satisfies DotGoalWorkflowInput]
          });
          await expect(handle3.result()).rejects.toBeInstanceOf(WorkflowFailedError);
          expect(stepCalls).toBe(2);
        });
      },
      180_000
    );
  });

  describe("dummyTurnWorkflow and codexAppServerTurnWorkflow", () => {
    it(
      "executes turn workflows, retries transient activity failures, and propagates terminal turn errors",
      async () => {
        let dummyStartAttempts = 0;
        let openCodeAttempts = 0;
        let cliAttempts = 0;
        let codexAttempts = 0;
        let codexMode: "retry-then-ok" | "fail-non-retryable" = "retry-then-ok";
        let failOpenCode = false;

        const worker = await Worker.create({
          connection: env.nativeConnection,
          taskQueue: "test-turn-workflows-queue",
          workflowsPath: WORKFLOW_SOURCE_PATHS["workflows.ts"],
          bundlerOptions: workflowBundlerOptions(),
          activities: {
            recordDummyTurnStarted: async () => {
              dummyStartAttempts += 1;
              if (dummyStartAttempts === 1) {
                throw new Error("transient sqlite busy on start");
              }
            },
            recordDummyTurnCompleted: async (input: DummyTurnInput) => ({
              workflowId: "test-dummy-turn",
              roomId: input.roomId,
              paneId: input.paneId,
              echoedPrompt: `Echo: ${input.prompt}`,
              completedAt: "2026-01-01T00:00:00.000Z"
            }),
            runOpenCodeAgentTurn: async (input: CodexAppServerTurnInput) => {
              openCodeAttempts += 1;
              if (failOpenCode) {
                throw new Error("opencode single-attempt failure");
              }
              return {
                workflowId: "test-opencode-turn",
                threadId: "thread:opencode",
                turnId: "turn:opencode",
                status: "COMPLETED" as const,
                message: `OpenCode: ${input.prompt}`,
                completedAt: "2026-01-01T00:00:00.000Z"
              };
            },
            runCliAgentTurn: async (input: CodexAppServerTurnInput) => {
              cliAttempts += 1;
              return {
                workflowId: "test-cli-turn",
                threadId: "thread:cli",
                turnId: "turn:cli",
                status: "COMPLETED" as const,
                message: `CLI: ${input.prompt}`,
                completedAt: "2026-01-01T00:00:00.000Z"
              };
            },
            runCodexAppServerTurn: async (input: CodexAppServerTurnInput) => {
              codexAttempts += 1;
              if (codexMode === "fail-non-retryable") {
                throw ApplicationFailure.nonRetryable("codex fatal turn error", "CodexFatalError");
              }
              if (codexAttempts === 1) {
                throw new Error("transient codex turn error");
              }
              return {
                workflowId: "test-codex-turn",
                threadId: "thread:codex",
                turnId: "turn:codex",
                status: "COMPLETED" as const,
                message: `Codex: ${input.prompt}`,
                completedAt: "2026-01-01T00:00:00.000Z"
              };
            }
          }
        });

        await worker.runUntil(async () => {
          const dummyResult = await env.client.workflow.execute("dummyTurnWorkflow", {
            taskQueue: "test-turn-workflows-queue",
            workflowId: "test-dummy-turn",
            args: [
              {
                roomId: "room:turn-1",
                paneId: "pane:turn-1",
                prompt: "Hello turn",
                traceId: "trace:dummy-turn-1"
              } satisfies DummyTurnInput
            ]
          });
          expect(dummyStartAttempts).toBe(2);
          expect(dummyResult.echoedPrompt).toBe("Echo: Hello turn");

          const openCodeResult = await env.client.workflow.execute("codexAppServerTurnWorkflow", {
            taskQueue: "test-turn-workflows-queue",
            workflowId: "test-opencode-turn",
            args: [
              {
                roomId: "room:turn-1",
                paneId: "pane:turn-1",
                prompt: "Run via OpenCode",
                providerId: "opencode",
                traceId: "trace:opencode-turn-1"
              } satisfies CodexAppServerTurnInput
            ]
          });
          expect(openCodeAttempts).toBe(1);
          expect(openCodeResult.message).toBe("OpenCode: Run via OpenCode");

          // OpenCode turn activity has maximumAttempts: 1 so failure is not retried
          failOpenCode = true;
          openCodeAttempts = 0;
          await expect(
            env.client.workflow.execute("codexAppServerTurnWorkflow", {
              taskQueue: "test-turn-workflows-queue",
              workflowId: "test-opencode-turn-fail",
              args: [
                {
                  roomId: "room:turn-1",
                  paneId: "pane:turn-1",
                  prompt: "Fail OpenCode",
                  providerId: "opencode",
                  traceId: "trace:opencode-turn-fail"
                } satisfies CodexAppServerTurnInput
              ]
            })
          ).rejects.toBeInstanceOf(WorkflowFailedError);
          expect(openCodeAttempts).toBe(1);

          const cliResult = await env.client.workflow.execute("codexAppServerTurnWorkflow", {
            taskQueue: "test-turn-workflows-queue",
            workflowId: "test-cli-turn",
            args: [
              {
                roomId: "room:turn-1",
                paneId: "pane:turn-1",
                prompt: "Run via CLI",
                providerId: cliChatTurnDefaultRuntimeIds[0],
                traceId: "trace:cli-turn-1"
              } satisfies CodexAppServerTurnInput
            ]
          });
          expect(cliAttempts).toBe(1);
          expect(cliResult.message).toBe("CLI: Run via CLI");

          const codexResult = await env.client.workflow.execute("codexAppServerTurnWorkflow", {
            taskQueue: "test-turn-workflows-queue",
            workflowId: "test-codex-turn-ok",
            args: [
              {
                roomId: "room:turn-1",
                paneId: "pane:turn-1",
                prompt: "Run via Codex",
                traceId: "trace:codex-turn-1"
              } satisfies CodexAppServerTurnInput
            ]
          });
          expect(codexAttempts).toBe(2);
          expect(codexResult.message).toBe("Codex: Run via Codex");

          codexMode = "fail-non-retryable";
          codexAttempts = 0;
          await expect(
            env.client.workflow.execute("codexAppServerTurnWorkflow", {
              taskQueue: "test-turn-workflows-queue",
              workflowId: "test-codex-turn-fail",
              args: [
                {
                  roomId: "room:turn-1",
                  paneId: "pane:turn-1",
                  prompt: "Fail Codex",
                  traceId: "trace:codex-turn-fail"
                } satisfies CodexAppServerTurnInput
              ]
            })
          ).rejects.toBeInstanceOf(WorkflowFailedError);
          expect(codexAttempts).toBe(1);
        });
      },
      120_000
    );
  });

  describe("roomAgentActionWorkflow", () => {
    it(
      "persists background failure via room-background-action-failure-v1 after retries exhaust or on cancellation, including legacy workflowId derivation",
      async () => {
        const failCalls: Array<{
          roomId: string;
          missionId: string;
          actionId: string;
          cancelled: boolean;
        }> = [];
        let actionBehavior: "fail" | "hang-for-cancel" | "succeed" = "fail";
        let hangStartedResolve!: () => void;
        const hangStarted = new Promise<void>((resolve) => {
          hangStartedResolve = resolve;
        });
        let releaseHangResolve!: () => void;
        const releaseHang = new Promise<void>((resolve) => {
          releaseHangResolve = resolve;
        });
        let hangCompletedResolve!: () => void;
        const hangCompleted = new Promise<void>((resolve) => {
          hangCompletedResolve = resolve;
        });

        const worker = await Worker.create({
          connection: env.nativeConnection,
          taskQueue: "test-room-action-queue",
          workflowsPath: WORKFLOW_SOURCE_PATHS["workflows.ts"],
          bundlerOptions: workflowBundlerOptions(),
          activities: {
            runRoomAgentBackgroundAction: async () => {
              if (actionBehavior === "succeed") return;
              if (actionBehavior === "fail") {
                throw ApplicationFailure.nonRetryable("transport failed", "BackgroundTransportError");
              }
              hangStartedResolve();
              try {
                await releaseHang;
              } finally {
                hangCompletedResolve();
              }
            },
            failRoomAgentBackgroundAction: async (input: {
              roomId: string;
              missionId: string;
              actionId: string;
              cancelled: boolean;
            }) => {
              if (input.cancelled) {
                releaseHangResolve();
                await hangCompleted;
                await new Promise((resolve) => setTimeout(resolve, 100));
              }
              failCalls.push(input);
            }
          }
        });

        await worker.runUntil(async () => {
          // 1. Legacy workflow input (no input.actionId) derives actionId from workflowId
          await expect(
            env.client.workflow.execute("roomAgentActionWorkflow", {
              taskQueue: "test-room-action-queue",
              workflowId: "space-room-action:action:legacy",
              args: [
                {
                  bridge: { roomId: "room:proof", missionId: "mission:proof" } as any,
                  traceId: "trace:proof"
                }
              ]
            })
          ).rejects.toBeInstanceOf(WorkflowFailedError);

          expect(failCalls).toContainEqual({
            roomId: "room:proof",
            missionId: "mission:proof",
            actionId: "action:legacy",
            cancelled: false
          });

          // 2. Cancellation path records cancelled: true with explicit actionId
          actionBehavior = "hang-for-cancel";
          const cancelHandle = await env.client.workflow.start("roomAgentActionWorkflow", {
            taskQueue: "test-room-action-queue",
            workflowId: "space-room-action:action:cancel-1",
            args: [
              {
                bridge: { roomId: "room:proof", missionId: "mission:proof" } as any,
                actionId: "action:explicit-cancel",
                traceId: "trace:cancel"
              } as any
            ]
          });
          await hangStarted;
          await cancelHandle.cancel();
          await expect(cancelHandle.result()).rejects.toThrow();

          expect(failCalls).toContainEqual({
            roomId: "room:proof",
            missionId: "mission:proof",
            actionId: "action:explicit-cancel",
            cancelled: true
          });

          // 3. Normal success does not call failRoomAgentBackgroundAction
          actionBehavior = "succeed";
          const countBefore = failCalls.length;
          await env.client.workflow.execute("roomAgentActionWorkflow", {
            taskQueue: "test-room-action-queue",
            workflowId: "space-room-action:action:ok-1",
            args: [
              {
                bridge: { roomId: "room:proof", missionId: "mission:proof" } as any,
                actionId: "action:explicit-ok",
                traceId: "trace:ok"
              } as any
            ]
          });
          expect(failCalls).toHaveLength(countBefore);
        });
      },
      120_000
    );
  });

  describe("roomAgentSupervisorWorkflow (current branch & room-supervisor-continuation coverage)", () => {
    it(
      "covers allocation -> send -> verification, stop/follow-up race retirement, continueAsNew carry, queue-bound deferral, running mission interruption, and 250-poll rollover",
      async () => {
        const activities = {
          prepareRoomAgentBackgroundContinuation: async (_input: any): Promise<any> => ({ state: "DONE" }),
          checkRoomAgentSupervisorTurn: async (_item: any): Promise<"READY" | "PAUSED" | "SKIP"> => "READY",
          discardRoomAgentSupervisorTurn: async (_input: any): Promise<void> => undefined,
          finishRoomAgentSupervisorTurn: async (_input: any): Promise<void> => undefined,
          runCodexAppServerTurn: async (_input: CodexAppServerTurnInput): Promise<any> => ({
            workflowId: "child-codex",
            threadId: "thread:child",
            turnId: "turn:child",
            status: "COMPLETED",
            message: "Verified",
            completedAt: "2026-01-01T00:00:00.000Z",
            roomAgentOutcome: {
              status: "VERIFIED",
              executedActionCount: 1,
              statusReason: "Verified remaining request."
            }
          })
        };

        const worker = await Worker.create({
          connection: env.nativeConnection,
          taskQueue: "test-room-supervisor-current-queue",
          workflowsPath: WORKFLOW_SOURCE_PATHS["workflows.ts"],
          bundlerOptions: workflowBundlerOptions(),
          activities: {
            prepareRoomAgentBackgroundContinuation: (input: any) =>
              activities.prepareRoomAgentBackgroundContinuation(input),
            checkRoomAgentSupervisorTurn: (item: any) =>
              activities.checkRoomAgentSupervisorTurn(item),
            discardRoomAgentSupervisorTurn: (input: any) =>
              activities.discardRoomAgentSupervisorTurn(input),
            finishRoomAgentSupervisorTurn: (input: any) =>
              activities.finishRoomAgentSupervisorTurn(input),
            runCodexAppServerTurn: (input: CodexAppServerTurnInput) =>
              activities.runCodexAppServerTurn(input)
          }
        });

        await worker.runUntil(async () => {
          // Case F (run first): Continues as new after 250 1-second monitoring polls with carried state intact
          {
            let pollPrepareCalls = 0;
            let run2ParkedResolve!: () => void;
            const run2Parked = new Promise<void>((resolve) => {
              run2ParkedResolve = resolve;
            });
            activities.prepareRoomAgentBackgroundContinuation = async () => {
              pollPrepareCalls += 1;
              if (pollPrepareCalls > 250) {
                setTimeout(run2ParkedResolve, 50);
                return { state: "DONE" as const };
              }
              return { state: "WAITING" as const };
            };

            const handle = await env.client.workflow.start("roomAgentSupervisorWorkflow", {
              taskQueue: "test-room-supervisor-current-queue",
              workflowId: "test-supervisor:250-polls-current",
              args: [
                {
                  roomId: "room:polls-current",
                  pending: [],
                  interrupted: [],
                  monitoringMissionIds: ["mission:monitored-current"],
                  processedCount: 12
                } satisfies RoomAgentSupervisorInput
              ]
            });
            const firstRun = env.client.workflow.getHandle(
              "test-supervisor:250-polls-current",
              handle.firstExecutionRunId,
              { followRuns: false }
            );
            await expect(firstRun.result()).rejects.toBeInstanceOf(WorkflowContinuedAsNewError);
            await run2Parked;

            const carried = await extractContinuedAsNewInput<RoomAgentSupervisorInput>(firstRun);
            expect(pollPrepareCalls).toBeGreaterThanOrEqual(250);
            expect(carried).toEqual({
              roomId: "room:polls-current",
              pending: [],
              interrupted: [],
              monitoringMissionIds: ["mission:monitored-current"],
              processedCount: 0
            });
          }

          // Case A: Executes allocation -> send -> verification in one mission
          {
            const c = continuationFixture();
            let childTurns = 0;
            let finishCalls = 0;

            activities.prepareRoomAgentBackgroundContinuation = async (input) =>
              prepareBackgroundContinuation(input, c.store);
            activities.checkRoomAgentSupervisorTurn = async (item) => supervisorTurnState(item, c.store);
            activities.discardRoomAgentSupervisorTurn = async ({ item, reason }) =>
              discardSupervisorTurn(item, reason, c.store);
            activities.finishRoomAgentSupervisorTurn = async (input) => {
              finishCalls += 1;
              await finishSupervisorTurn(input, c.store);
            };
            activities.runCodexAppServerTurn = async (turn) => {
              childTurns += 1;
              if (childTurns === 1) {
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
                  workflowId: "child-1",
                  threadId: "thread:1",
                  turnId: "turn:1",
                  status: "COMPLETED" as const,
                  message: "Sent",
                  completedAt: "2026-01-01T00:00:00.000Z",
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
                workflowId: "child-2",
                threadId: "thread:2",
                turnId: "turn:2",
                status: "COMPLETED" as const,
                message: "Verified",
                completedAt: "2026-01-01T00:00:00.000Z",
                roomAgentOutcome: {
                  status: "VERIFIED" as const,
                  executedActionCount: 1,
                  statusReason: "Verified remaining request."
                }
              };
            };

            const workflowInput = roomAgentSupervisorInputSchema.parse({
              roomId: c.room.id,
              monitoringMissionIds: [c.initial.mission.id],
              processedCount: 48
            });
            const handle = await env.client.workflow.start("roomAgentSupervisorWorkflow", {
              taskQueue: "test-room-supervisor-current-queue",
              workflowId: "test-supervisor:alloc-send-verify",
              args: [workflowInput]
            });
            const firstRun = env.client.workflow.getHandle(
              "test-supervisor:alloc-send-verify",
              handle.firstExecutionRunId,
              { followRuns: false }
            );
            await expect(firstRun.result()).rejects.toBeInstanceOf(WorkflowContinuedAsNewError);
            await new Promise((resolve) => setTimeout(resolve, 100));

            expect(childTurns).toBe(2);
            expect(c.store.listRoomAgentActions(c.initial.mission.id).filter((a) => a.actionType === "SEND")).toHaveLength(1);
            expect(c.store.getRoomAgentMission(c.room.id, c.initial.mission.id)?.status).toBe("COMPLETED");
            expect(finishCalls).toBe(1);
          }

          // Case B: Retires a prepared run when "stop" or "follow-up" arrives before the activity reply
          for (const kind of ["stop", "follow-up"] as const) {
            const c = continuationFixture();
            const childRequests: Array<string | null | undefined> = [];
            let preparedRunId = "";
            let settledResolved!: () => void;
            const settledPromise = new Promise<void>((resolve) => {
              settledResolved = resolve;
            });

            const workflowInput = roomAgentSupervisorInputSchema.parse({
              roomId: c.room.id,
              monitoringMissionIds: [c.initial.mission.id],
              processedCount: kind === "follow-up" ? 48 : 0
            });
            const workflowId = `test-supervisor:race-${kind}`;
            let handle!: WorkflowHandle;

            let firstPrepare = true;
            activities.prepareRoomAgentBackgroundContinuation = async (input) => {
              const result = await prepareBackgroundContinuation(input, c.store);
              if (firstPrepare) {
                firstPrepare = false;
                if (result.state === "READY") {
                  preparedRunId = result.item.turn.agentRunId!;
                }
                if (kind === "stop") {
                  c.store.updateRoomAgentMission(c.initial.mission.id, { status: "INTERRUPTED" });
                  await handle.signal(ROOM_AGENT_STOP_SIGNAL, { missionId: null, reason: "Stop" });
                } else {
                  const followUp = c.enqueue("follow-up", "Only inspect the room.");
                  await handle.signal(ROOM_AGENT_ENQUEUE_SIGNAL, followUp.queueItem);
                }
                await new Promise((resolve) => setTimeout(resolve, 150));
              }
              return result;
            };
            activities.checkRoomAgentSupervisorTurn = async (item) => supervisorTurnState(item, c.store);
            activities.discardRoomAgentSupervisorTurn = async ({ item, reason }) => {
              await discardSupervisorTurn(item, reason, c.store);
              if (kind === "stop") {
                setTimeout(settledResolved, 100);
              }
            };
            activities.finishRoomAgentSupervisorTurn = async (input) => {
              await finishSupervisorTurn(input, c.store);
            };
            activities.runCodexAppServerTurn = async (turn) => {
              childRequests.push(turn.roomAgentOperatorRequest);
              c.store.updateSpaceAgentRun(turn.agentRunId!, { status: "COMPLETED" });
              return {
                workflowId: "child-followup",
                threadId: "thread:followup",
                turnId: "turn:followup",
                status: "COMPLETED" as const,
                message: "Verified",
                completedAt: "2026-01-01T00:00:00.000Z",
                roomAgentOutcome: {
                  status: "VERIFIED" as const,
                  executedActionCount: 1,
                  statusReason: "Verified remaining request."
                }
              };
            };

            handle = await env.client.workflow.start("roomAgentSupervisorWorkflow", {
              taskQueue: "test-room-supervisor-current-queue",
              workflowId,
              args: [workflowInput]
            });

            if (kind === "stop") {
              await env.sleep("2 seconds");
              await settledPromise;
            } else {
              const firstRun = env.client.workflow.getHandle(workflowId, handle.firstExecutionRunId, {
                followRuns: false
              });
              await expect(firstRun.result()).rejects.toBeInstanceOf(WorkflowContinuedAsNewError);
            }
            await new Promise((resolve) => setTimeout(resolve, 100));

            expect(c.store.getRoomAgentTurn(c.initial.mission.id, preparedRunId)?.run.status).toBe("INTERRUPTED");
            if (kind === "stop") {
              expect(childRequests).toHaveLength(0);
            } else {
              expect(childRequests[0]).toBe("Only inspect the room.");
            }
          }

          // Case C: Carries a prepared continuation through continueAsNew and starts it once
          {
            const c = continuationFixture();
            let childTurns = 0;
            let completedResolved!: () => void;
            const completedPromise = new Promise<void>((resolve) => {
              completedResolved = resolve;
            });

            activities.prepareRoomAgentBackgroundContinuation = async (input) =>
              prepareBackgroundContinuation(input, c.store);
            activities.checkRoomAgentSupervisorTurn = async (item) => supervisorTurnState(item, c.store);
            activities.discardRoomAgentSupervisorTurn = async ({ item, reason }) =>
              discardSupervisorTurn(item, reason, c.store);
            activities.finishRoomAgentSupervisorTurn = async (input) => {
              await finishSupervisorTurn(input, c.store);
              setTimeout(completedResolved, 100);
            };
            activities.runCodexAppServerTurn = async (turn) => {
              childTurns += 1;
              c.store.updateSpaceAgentRun(turn.agentRunId!, { status: "COMPLETED" });
              return {
                workflowId: "child-continued",
                threadId: "thread:continued",
                turnId: "turn:continued",
                status: "COMPLETED" as const,
                message: "Verified",
                completedAt: "2026-01-01T00:00:00.000Z",
                roomAgentOutcome: {
                  status: "VERIFIED" as const,
                  executedActionCount: 1,
                  statusReason: "Verified remaining request."
                }
              };
            };

            const workflowInput = roomAgentSupervisorInputSchema.parse({
              roomId: c.room.id,
              monitoringMissionIds: [c.initial.mission.id],
              processedCount: 50
            });
            const handle = await env.client.workflow.start("roomAgentSupervisorWorkflow", {
              taskQueue: "test-room-supervisor-current-queue",
              workflowId: "test-supervisor:carry-continue-as-new",
              args: [workflowInput]
            });
            const firstRun = env.client.workflow.getHandle(
              "test-supervisor:carry-continue-as-new",
              handle.firstExecutionRunId,
              { followRuns: false }
            );
            await expect(firstRun.result()).rejects.toBeInstanceOf(WorkflowContinuedAsNewError);
            const carried = roomAgentSupervisorInputSchema.parse(
              await extractContinuedAsNewInput<RoomAgentSupervisorInput>(firstRun)
            );
            expect(carried.pending).toHaveLength(1);
            expect(carried.processedCount).toBe(0);

            await completedPromise;
            await new Promise((resolve) => setTimeout(resolve, 100));

            expect(childTurns).toBe(1);
            expect(c.store.getRoomAgentMission(c.room.id, c.initial.mission.id)?.status).toBe("COMPLETED");
          }

          // Case E: Interrupts a currently running mission on ROOM_AGENT_STOP_SIGNAL
          {
            let turnStartedResolve!: () => void;
            const turnStarted = new Promise<void>((resolve) => {
              turnStartedResolve = resolve;
            });
            let releaseTurnResolve!: () => void;
            const releaseTurn = new Promise<void>((resolve) => {
              releaseTurnResolve = resolve;
            });
            let turnCompletedResolve!: () => void;
            const turnCompleted = new Promise<void>((resolve) => {
              turnCompletedResolve = resolve;
            });
            let interruptedReason: string | null | undefined;

            activities.checkRoomAgentSupervisorTurn = async () => {
              turnStartedResolve();
              try {
                await releaseTurn;
              } finally {
                turnCompletedResolve();
              }
              return "READY";
            };
            activities.discardRoomAgentSupervisorTurn = async () => {
              releaseTurnResolve();
              await turnCompleted;
              await new Promise((resolve) => setTimeout(resolve, 100));
            };
            activities.finishRoomAgentSupervisorTurn = async (input) => {
              if (input.status === "INTERRUPTED") {
                interruptedReason = input.statusReason;
              }
            };

            const handle = await env.client.workflow.start("roomAgentSupervisorWorkflow", {
              taskQueue: "test-room-supervisor-current-queue",
              workflowId: "test-supervisor:interrupt-active-mission",
              args: [
                {
                  roomId: "room:interrupt-active",
                  pending: [sampleQueueItem("room:interrupt-active", "mission:active-1", "active-1")],
                  interrupted: [],
                  monitoringMissionIds: [],
                  processedCount: 49
                } satisfies RoomAgentSupervisorInput
              ]
            });

            await turnStarted;
            await handle.signal(ROOM_AGENT_STOP_SIGNAL, {
              missionId: "mission:active-1",
              reason: "Operator interrupted active mission."
            });
            const firstRun = env.client.workflow.getHandle(
              "test-supervisor:interrupt-active-mission",
              handle.firstExecutionRunId,
              { followRuns: false }
            );
            await expect(firstRun.result()).rejects.toBeInstanceOf(WorkflowContinuedAsNewError);
            await new Promise((resolve) => setTimeout(resolve, 100));

            expect(interruptedReason).toBe("Operator interrupted active mission.");
          }

          // Case D: Defers continueAsNew until the carried queue fits the next run's input bounds (<= 100)
          {
            const roomId = "room:carry-bound";
            const makeItem = (index: number) =>
              sampleQueueItem(roomId, "mission:carry-bound", `carry-${String(index).padStart(3, "0")}`);
            let flooded = false;
            let checkCount = 0;
            let run2PausedResolve!: () => void;
            const run2Paused = new Promise<void>((resolve) => {
              run2PausedResolve = resolve;
            });
            let handle!: WorkflowHandle;

            activities.checkRoomAgentSupervisorTurn = async () => {
              checkCount += 1;
              if (!flooded) {
                flooded = true;
                for (let index = 1; index <= 105; index += 1) {
                  await handle.signal(ROOM_AGENT_ENQUEUE_SIGNAL, makeItem(index));
                }
              }
              if (checkCount > 6) {
                setTimeout(run2PausedResolve, 50);
                return "PAUSED";
              }
              return "SKIP";
            };
            activities.discardRoomAgentSupervisorTurn = async () => undefined;
            activities.finishRoomAgentSupervisorTurn = async () => undefined;

            const input = roomAgentSupervisorInputSchema.parse({
              roomId,
              pending: [makeItem(0)],
              processedCount: 49
            });
            handle = await env.client.workflow.start("roomAgentSupervisorWorkflow", {
              taskQueue: "test-room-supervisor-current-queue",
              workflowId: "test-supervisor:queue-bounds",
              args: [input]
            });
            const firstRun = env.client.workflow.getHandle(
              "test-supervisor:queue-bounds",
              handle.firstExecutionRunId,
              { followRuns: false }
            );
            await expect(firstRun.result()).rejects.toBeInstanceOf(WorkflowContinuedAsNewError);
            await run2Paused;

            const carried = await extractContinuedAsNewInput<RoomAgentSupervisorInput>(firstRun);
            expect(carried.pending).toHaveLength(100);
            expect(() => roomAgentSupervisorInputSchema.parse(carried)).not.toThrow();
            expect(checkCount).toBeGreaterThanOrEqual(6);
            await handle.terminate();
          }
        });
      },
      180_000
    );
  });

  describe("roomAgentSupervisorWorkflow (pre-patch branch behind patched('room-background-continuation-v1'))", () => {
    it(
      "preserves settleRoomAgentBackgroundMission polling, handles enqueue/stop/interrupt signals, and continues as new after 50 items or 250 polls",
      async () => {
        let settleCalls = 0;
        let settleMode: "250-polls" | "always-true" = "250-polls";
        let onSettleCalled: (() => void) | null = null;
        let onRun2Parked: (() => void) | null = null;
        const startedMissions: string[] = [];
        const continuedMissions: string[] = [];
        const finishedMissions: Array<{
          missionId: string;
          roomId: string;
          status: string;
          statusReason: string | null;
        }> = [];
        let interceptStart = false;
        let onStartIntercepted: (() => void) | null = null;
        let releaseStartIntercept: (() => void) | null = null;

        const worker = await Worker.create({
          connection: env.nativeConnection,
          taskQueue: "test-room-supervisor-pre-patch-queue",
          workflowsPath: WORKFLOW_SOURCE_PATHS["workflows.ts"],
          bundlerOptions: workflowBundlerOptions("pre-patch"),
          activities: {
            settleRoomAgentBackgroundMission: async () => {
              settleCalls += 1;
              onSettleCalled?.();
              if (settleMode === "250-polls") {
                if (settleCalls > 250) {
                  setTimeout(() => onRun2Parked?.(), 50);
                  return true;
                }
                return false;
              }
              setTimeout(() => onRun2Parked?.(), 50);
              return true;
            },
            markRoomAgentMissionStarted: async (input: { missionId: string }) => {
              startedMissions.push(input.missionId);
              if (interceptStart) {
                onStartIntercepted?.();
                await new Promise<void>((resolve) => {
                  releaseStartIntercept = resolve;
                });
              }
            },
            markRoomAgentMissionContinued: async (input: { missionId: string }) => {
              continuedMissions.push(input.missionId);
            },
            markRoomAgentMissionFinished: async (input: {
              missionId: string;
              roomId: string;
              status: string;
              statusReason: string | null;
            }) => {
              finishedMissions.push(input);
            },
            runCodexAppServerTurn: async () => ({
              workflowId: "pre-patch-child",
              threadId: "thread:pre-patch",
              turnId: "turn:pre-patch",
              status: "COMPLETED" as const,
              message: "Pre-patch child completed",
              completedAt: "2026-01-01T00:00:00.000Z",
              roomAgentOutcome: {
                status: "VERIFIED" as const,
                executedActionCount: 1,
                pendingActionIds: ["action:pre-patch-bg"],
                statusReason: "Queued background action."
              }
            })
          }
        });

        await worker.runUntil(async () => {
          // 1 (run first): 250-poll continueAsNew on the pre-patch branch
          settleCalls = 0;
          settleMode = "250-polls";
          const run2Parked3 = new Promise<void>((resolve) => {
            onRun2Parked = resolve;
          });
          const handle3 = await env.client.workflow.start("roomAgentSupervisorWorkflow", {
            taskQueue: "test-room-supervisor-pre-patch-queue",
            workflowId: "test-supervisor-pre-patch:250-polls",
            args: [
              {
                roomId: "room:pre-patch-3",
                pending: [],
                interrupted: [],
                monitoringMissionIds: ["mission:pre-poll-keep"],
                processedCount: 5
              } satisfies RoomAgentSupervisorInput
            ]
          });
          const firstRun3 = env.client.workflow.getHandle(
            "test-supervisor-pre-patch:250-polls",
            handle3.firstExecutionRunId,
            { followRuns: false }
          );
          await expect(firstRun3.result()).rejects.toBeInstanceOf(WorkflowContinuedAsNewError);
          await run2Parked3;
          onRun2Parked = null;

          const carried3 = await extractContinuedAsNewInput<RoomAgentSupervisorInput>(firstRun3);
          expect(settleCalls).toBeGreaterThanOrEqual(250);
          expect(carried3).toEqual({
            roomId: "room:pre-patch-3",
            pending: [],
            interrupted: [],
            monitoringMissionIds: ["mission:pre-poll-keep"],
            processedCount: 5
          });

          // 2. Legacy boolean settle activity + 50-item continueAsNew rollover
          settleCalls = 0;
          settleMode = "always-true";
          const settledOnce = new Promise<void>((resolve) => {
            onSettleCalled = resolve;
          });
          const handle1 = await env.client.workflow.start("roomAgentSupervisorWorkflow", {
            taskQueue: "test-room-supervisor-pre-patch-queue",
            workflowId: "test-supervisor-pre-patch:50-items",
            args: [
              {
                roomId: "room:pre-patch-1",
                pending: [],
                interrupted: [],
                monitoringMissionIds: ["mission:pre-monitored"],
                processedCount: 49
              } satisfies RoomAgentSupervisorInput
            ]
          });
          await env.sleep("2 seconds");
          await settledOnce;
          onSettleCalled = null;
          const run2Parked1 = new Promise<void>((resolve) => {
            onRun2Parked = resolve;
          });
          await handle1.signal(
            ROOM_AGENT_ENQUEUE_SIGNAL,
            sampleQueueItem("room:pre-patch-1", "mission:pre-1", "pre-1")
          );
          const firstRun1 = env.client.workflow.getHandle(
            "test-supervisor-pre-patch:50-items",
            handle1.firstExecutionRunId,
            { followRuns: false }
          );
          await expect(firstRun1.result()).rejects.toBeInstanceOf(WorkflowContinuedAsNewError);
          await run2Parked1;
          onRun2Parked = null;

          const carried1 = await extractContinuedAsNewInput<RoomAgentSupervisorInput>(firstRun1);
          expect(settleCalls).toBeGreaterThanOrEqual(1);
          expect(startedMissions).toContain("mission:pre-1");
          expect(continuedMissions).toContain("mission:pre-1");
          expect(carried1).toEqual({
            roomId: "room:pre-patch-1",
            pending: [],
            interrupted: [],
            monitoringMissionIds: ["mission:pre-1"],
            processedCount: 0
          });

          // 3. Interrupting an active mission on the pre-patch branch
          interceptStart = true;
          const startInterceptedPromise = new Promise<void>((resolve) => {
            onStartIntercepted = resolve;
          });

          const handle2 = await env.client.workflow.start("roomAgentSupervisorWorkflow", {
            taskQueue: "test-room-supervisor-pre-patch-queue",
            workflowId: "test-supervisor-pre-patch:interrupt",
            args: [
              {
                roomId: "room:pre-patch-2",
                pending: [sampleQueueItem("room:pre-patch-2", "mission:pre-interrupt", "pre-int")],
                interrupted: [],
                monitoringMissionIds: [],
                processedCount: 49
              } satisfies RoomAgentSupervisorInput
            ]
          });

          await startInterceptedPromise;
          await handle2.signal(ROOM_AGENT_STOP_SIGNAL, {
            missionId: "mission:pre-interrupt",
            reason: "Interrupted pre-patch mission."
          });
          await new Promise((resolve) => setTimeout(resolve, 100));
          releaseStartIntercept?.();
          const firstRun2 = env.client.workflow.getHandle(
            "test-supervisor-pre-patch:interrupt",
            handle2.firstExecutionRunId,
            { followRuns: false }
          );
          await expect(firstRun2.result()).rejects.toBeInstanceOf(WorkflowContinuedAsNewError);
          await new Promise((resolve) => setTimeout(resolve, 100));
          interceptStart = false;
          onStartIntercepted = null;
          releaseStartIntercept = null;

          expect(finishedMissions).toContainEqual({
            missionId: "mission:pre-interrupt",
            roomId: "room:pre-patch-2",
            status: "INTERRUPTED",
            statusReason: "Interrupted pre-patch mission."
          });
        });
      },
      180_000
    );
  });

  describe("memoryMaintenanceWorkflow, memoryConsolidationWorkflow, and memoryMutationWorkflow", () => {
    it(
      "continues when non-critical maintenance activities fail, runs memoryConsolidationWorkflow as a child, and retries/propagates memory activity failures",
      async () => {
        const baseConsolidationRun: MemoryConsolidationRun = {
          id: "memory_consolidation_run:test-1",
          mode: "REPAIR",
          triggerKind: "SCHEDULED",
          status: "SUCCEEDED",
          workflowId: "space-memory-consolidation:scheduled:test-1",
          dedupeKey: "scheduled:test-1",
          sourceHash: "c".repeat(64),
          progressCompleted: 1,
          progressTotal: 1,
          findingCount: 1,
          appliedOperationCount: 1,
          skippedOperationCount: 0,
          failedOperationCount: 0,
          modelId: null,
          aiVerified: false,
          aiEvidence: {},
          metrics: {},
          statusReason: null,
          actorUserId: "user:operator-1",
          startedAt: "2026-01-01T00:00:00.000Z",
          completedAt: "2026-01-01T00:01:00.000Z",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:01:00.000Z"
        };

        const baseMaintenanceResult: MemoryMaintenanceResult = {
          status: "REFRESHED",
          generatedAt: "2026-01-01T00:00:00.000Z",
          sourceHash: "c".repeat(64),
          previousSourceHash: null,
          summary: {
            recordCount: 4,
            activeCount: 4,
            archivedCount: 0,
            candidateCount: 0,
            cacheRecordCount: 0,
            unlinkedCacheCount: 0,
            conflictCount: 0,
            staleCount: 0,
            duplicateCount: 0,
            issueCount: 1
          },
          durationMs: 15
        };

        const baseMutationResult: MemoryMutationWorkflowResult = {
          status: "APPLIED",
          changeSetId: "memory_change:test000000000000000001",
          resultingSourceHash: "d".repeat(64),
          reason: null
        };

        let refreshAttempts = 0;
        let prepareAttempts = 0;
        let mutationAttempts = 0;
        let failMutationNonRetryable = false;

        const maintenanceWorker = await Worker.create({
          connection: env.nativeConnection,
          taskQueue: MEMORY_MAINTENANCE_TASK_QUEUE,
          workflowsPath: WORKFLOW_SOURCE_PATHS["memory-maintenance-workflows.ts"],
          bundlerOptions: workflowBundlerOptions(),
          activities: {
            refreshMemoryGraphSnapshot: async () => {
              refreshAttempts += 1;
              if (refreshAttempts === 1) {
                throw new Error("transient snapshot refresh failure");
              }
              return baseMaintenanceResult;
            },
            refreshAllMonthsMemoryGraphSnapshot: async () => {
              throw ApplicationFailure.nonRetryable("all-months snapshot failed", "AllMonthsSnapshotError");
            },
            reconcileStaleSpaceAgentSessions: async () => {
              throw ApplicationFailure.nonRetryable("stale session reconciliation failed", "ReconcileSessionsError");
            },
            createScheduledMemoryAudit: async () => ({
              ...baseConsolidationRun,
              status: "QUEUED" as const
            }),
            prepareMemoryConsolidation: async () => {
              prepareAttempts += 1;
              if (prepareAttempts === 1) {
                throw new Error("transient prepare consolidation failure");
              }
              return {
                run: { ...baseConsolidationRun, status: "RUNNING" as const },
                changeSetId: baseMutationResult.changeSetId
              };
            },
            finalizeMemoryRepair: async () => baseConsolidationRun
          }
        });

        const mutationWorker = await Worker.create({
          connection: env.nativeConnection,
          taskQueue: MEMORY_MUTATION_TASK_QUEUE,
          workflowsPath: WORKFLOW_SOURCE_PATHS["memory-mutation-workflows.ts"],
          bundlerOptions: workflowBundlerOptions(),
          activities: {
            executePersistedMemoryChangeSet: async () => {
              mutationAttempts += 1;
              if (failMutationNonRetryable) {
                throw ApplicationFailure.nonRetryable("fatal memory mutation failure", "MemoryMutationFatalError");
              }
              if (mutationAttempts === 1) {
                throw new Error("transient mutation lock error");
              }
              return baseMutationResult;
            }
          }
        });

        const maintRun = maintenanceWorker.run();
        const mutRun = mutationWorker.run();
        try {
          const maintenanceOutput = await env.client.workflow.execute("memoryMaintenanceWorkflow", {
            taskQueue: MEMORY_MAINTENANCE_TASK_QUEUE,
            workflowId: "test-memory-maintenance:resilient",
            args: [
              {
                trigger: "SCHEDULED",
                scheduledAt: "2026-01-01T00:00:00.000Z",
                traceId: "trace:test-memory-maintenance"
              } satisfies MemoryMaintenanceInput
            ]
          });

          expect(maintenanceOutput).toEqual(baseMaintenanceResult);
          expect(refreshAttempts).toBe(2);
          expect(prepareAttempts).toBe(2);
          expect(mutationAttempts).toBe(2);

          const mutationOutput = await env.client.workflow.execute("memoryMutationWorkflow", {
            taskQueue: MEMORY_MUTATION_TASK_QUEUE,
            workflowId: "test-memory-mutation:ok",
            args: [{ changeSetId: baseMutationResult.changeSetId, traceId: "trace:test-memory-mutation-ok" }]
          });
          expect(mutationOutput).toEqual(baseMutationResult);

          failMutationNonRetryable = true;
          await expect(
            env.client.workflow.execute("memoryMutationWorkflow", {
              taskQueue: MEMORY_MUTATION_TASK_QUEUE,
              workflowId: "test-memory-mutation:fail",
              args: [{ changeSetId: baseMutationResult.changeSetId, traceId: "trace:test-memory-mutation-fail" }]
            })
          ).rejects.toBeInstanceOf(WorkflowFailedError);

          await expect(
            env.client.workflow.execute("memoryConsolidationWorkflow", {
              taskQueue: MEMORY_MAINTENANCE_TASK_QUEUE,
              workflowId: "test-memory-consolidation:fail",
              args: [{ runId: baseConsolidationRun.id, traceId: "trace:test-memory-consolidation-fail" }]
            })
          ).rejects.toBeInstanceOf(WorkflowFailedError);
        } finally {
          maintenanceWorker.shutdown();
          mutationWorker.shutdown();
          await Promise.all([maintRun, mutRun]);
        }
      },
      180_000
    );
  });
});
