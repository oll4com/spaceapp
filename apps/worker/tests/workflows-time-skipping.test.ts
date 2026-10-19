import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ApplicationFailure,
  CancelledFailure,
  WorkflowContinuedAsNewError,
  WorkflowFailedError
} from "@temporalio/client";
import { Context } from "@temporalio/activity";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { bundleWorkflowCode, Worker, type WorkflowBundleWithSourceMap } from "@temporalio/worker";
import {
  DOT_GOAL_SIGNAL,
  MEMORY_MUTATION_TASK_QUEUE,
  ROOM_AGENT_ENQUEUE_SIGNAL,
  ROOM_AGENT_STOP_SIGNAL,
  roomAgentSupervisorInputSchema,
  type DummyTurnInput,
  type MemoryConsolidationRun,
  type MemoryMaintenanceResult,
  type MemoryMutationWorkflowResult,
  type RoomAgentSupervisorInput,
  type RoomAgentSupervisorQueueItem
} from "@space/contracts";
import { MEMORY_MAINTENANCE_TASK_QUEUE } from "../src/memory-maintenance-config.js";
import {
  discardSupervisorTurn,
  finishSupervisorTurn,
  prepareBackgroundContinuation,
  supervisorTurnState
} from "../src/room-background-continuation.js";
import { continuationFixture } from "./room-continuation-fixture.js";
import {
  createWorktreeBundlerOptions,
  decodeContinueAsNewInput,
  ensureQuietTemporalRuntime,
  WORKFLOW_MODULE_PATHS
} from "./support/workflow-sandbox-harness.js";

describe("Temporal workflows in real time-skipping sandbox", () => {
  let env: TestWorkflowEnvironment;
  let mainWorkflowBundle: WorkflowBundleWithSourceMap;

  beforeAll(async () => {
    ensureQuietTemporalRuntime();
    [env, mainWorkflowBundle] = await Promise.all([
      TestWorkflowEnvironment.createTimeSkipping(),
      bundleWorkflowCode({
        workflowsPath: WORKFLOW_MODULE_PATHS.main,
        ...createWorktreeBundlerOptions(),
        logger: {
          trace: () => undefined,
          debug: () => undefined,
          info: () => undefined,
          warn: () => undefined,
          error: () => undefined,
          log: () => undefined
        }
      })
    ]);
  }, 60_000);

  afterAll(async () => {
    await env?.teardown();
  }, 30_000);

  it(
    "runs dotGoalWorkflow with wake signals, timer timeouts, activity retries, and continueAsNew",
    async () => {
      const taskQueue = "ts-dot-goal";
      let stepAttempt = 0;
      let stepCall = 0;
      let observeAttempt = 0;
      let observeCall = 0;
      let continueIterations = 0;
      let dotHandleForInActivitySignal:
        | Awaited<ReturnType<typeof env.client.workflow.start>>
        | undefined;

      const worker = await Worker.create({
        connection: env.nativeConnection,
        taskQueue,
        workflowBundle: mainWorkflowBundle,
        activities: {
          dotGoalStep: async (goalId: string) => {
            if (goalId === "goal:continue-as-new") {
              continueIterations += 1;
              if (continueIterations <= 300) {
                return { state: "WAITING", runId: null, goalStatus: "ACTIVE" };
              }
              return { state: "DONE", runId: null, goalStatus: "COMPLETED_AFTER_CONTINUE" };
            }

            stepAttempt += 1;
            if (stepAttempt === 1) {
              throw ApplicationFailure.retryable("Transient step failure", "STEP_RETRY");
            }
            stepCall += 1;
            if (stepCall === 1) {
              // Signal while the activity is in flight so `woken` is already true before `wait("1 hour")`
              await dotHandleForInActivitySignal?.signal(DOT_GOAL_SIGNAL);
              return { state: "PAUSED", runId: null, goalStatus: "PAUSED" };
            }
            if (stepCall === 2) {
              return { state: "WAITING", runId: null, goalStatus: "ACTIVE" };
            }
            if (stepCall === 3) {
              return { state: "RUNNING", runId: "run:dot-step-3", goalStatus: "ACTIVE" };
            }
            return { state: "DONE", runId: null, goalStatus: "COMPLETED" };
          },
          dotGoalObserve: async (_goalId: string, runId: string) => {
            expect(runId).toBe("run:dot-step-3");
            observeAttempt += 1;
            if (observeAttempt === 1) {
              throw ApplicationFailure.retryable("Transient observe failure", "OBSERVE_RETRY");
            }
            observeCall += 1;
            return {
              run: observeCall === 1 ? "RUNNING" : "COMPLETED",
              goalStatus: "ACTIVE"
            };
          }
        }
      });

      await worker.runUntil(async () => {
        const handle = await env.client.workflow.start("dotGoalWorkflow", {
          taskQueue,
          workflowId: "dot-goal:wake-and-timeout",
          args: [{ goalId: "goal:wake-and-timeout" }]
        });
        dotHandleForInActivitySignal = handle;

        const result = await handle.result();
        expect(result).toEqual({ goalStatus: "COMPLETED" });
        expect(stepAttempt).toBe(5);
        expect(observeAttempt).toBe(3);

        const wakeHistory = await handle.fetchHistory();
        const wakeEvents = wakeHistory.events ?? [];
        const signaled = wakeEvents.filter((event) =>
          Boolean(event.workflowExecutionSignaledEventAttributes)
        );
        expect(signaled.length).toBeGreaterThanOrEqual(1);
        expect(signaled[0]!.workflowExecutionSignaledEventAttributes?.signalName).toBe(
          DOT_GOAL_SIGNAL
        );
        // Step 1 PAUSED (1h) was woken immediately by the signal, so only the 30s WAITING
        // and two 15s RUNNING observe timers fired.
        const firedTimers = wakeEvents.filter((event) =>
          Boolean(event.timerFiredEventAttributes)
        );
        expect(firedTimers).toHaveLength(3);

        // Verify continueAsNew after 300 unfinished iterations, then completion on the next run
        const canHandle = await env.client.workflow.start("dotGoalWorkflow", {
          taskQueue,
          workflowId: "dot-goal:continue-as-new",
          args: [{ goalId: "goal:continue-as-new" }]
        });
        const continuedResult = await canHandle.result();
        expect(continuedResult).toEqual({ goalStatus: "COMPLETED_AFTER_CONTINUE" });
        expect(continueIterations).toBe(301);

        const firstHistory = await env.client.workflow
          .getHandle("dot-goal:continue-as-new", canHandle.firstExecutionRunId)
          .fetchHistory();
        expect(decodeContinueAsNewInput(firstHistory)).toEqual({
          goalId: "goal:continue-as-new"
        });
      });
    },
    120_000
  );

  it(
    "runs dummyTurnWorkflow, codexAppServerTurnWorkflow, and roomAgentActionWorkflow with retry and failure policies",
    async () => {
      const taskQueue = "ts-turn-and-action";
      let dummyStartAttempts = 0;
      let codexAttempts = 0;
      let openCodeAttempts = 0;
      let cliAttempts = 0;
      let actionAttempts = 0;
      const recordedActionFailures: Array<Record<string, unknown>> = [];

      const worker = await Worker.create({
        connection: env.nativeConnection,
        taskQueue,
        workflowBundle: mainWorkflowBundle,
        activities: {
          recordDummyTurnStarted: async () => {
            if (++dummyStartAttempts === 1) {
              throw ApplicationFailure.retryable("Dummy start transient error", "DUMMY_RETRY");
            }
          },
          recordDummyTurnCompleted: async (input: DummyTurnInput) => ({
            workflowId: "dummy-turn:1",
            roomId: input.roomId,
            paneId: input.paneId,
            completedAt: "2026-10-17T00:00:00.000Z",
            echoedPrompt: input.prompt
          }),
          runCodexAppServerTurn: async (input: DummyTurnInput) => {
            if (++codexAttempts < 3) {
              throw ApplicationFailure.retryable("Codex transient error", "CODEX_RETRY");
            }
            return {
              workflowId: "codex-turn:1",
              roomId: input.roomId,
              paneId: input.paneId,
              completedAt: "2026-10-17T00:00:01.000Z",
              providerId: input.providerId ?? "codex",
              modelId: input.modelId ?? "gpt-5.6-sol",
              status: "COMPLETED" as const,
              message: `Answered: ${input.prompt}`
            };
          },
          runOpenCodeAgentTurn: async () => {
            openCodeAttempts += 1;
            throw ApplicationFailure.retryable("OpenCode single-attempt failure", "OPENCODE_ERR");
          },
          runCliAgentTurn: async () => {
            cliAttempts += 1;
            throw ApplicationFailure.retryable("CLI single-attempt failure", "CLI_ERR");
          },
          runRoomAgentBackgroundAction: async () => {
            actionAttempts += 1;
            throw ApplicationFailure.retryable("transport failed", "TRANSPORT_ERR");
          },
          failRoomAgentBackgroundAction: async (payload: Record<string, unknown>) => {
            recordedActionFailures.push(payload);
          }
        }
      });

      await worker.runUntil(async () => {
        const dummyResult = await env.client.workflow.execute("dummyTurnWorkflow", {
          taskQueue,
          workflowId: "dummy-turn:1",
          args: [{ roomId: "room:1", paneId: "pane:1", prompt: "Ping" }]
        });
        expect(dummyStartAttempts).toBe(2);
        expect(dummyResult.echoedPrompt).toBe("Ping");

        const codexResult = await env.client.workflow.execute("codexAppServerTurnWorkflow", {
          taskQueue,
          workflowId: "codex-turn:retry",
          args: [
            {
              roomId: "room:1",
              paneId: "pane:1",
              prompt: "Solve",
              providerId: "codex",
              modelId: "gpt-5.6-sol",
              agentSessionId: "session:1",
              agentRunId: "run:1"
            }
          ]
        });
        expect(codexAttempts).toBe(3);
        expect(codexResult.status).toBe("COMPLETED");

        // OpenCode and CLI chat turns have maximumAttempts = 1
        await expect(
          env.client.workflow.execute("codexAppServerTurnWorkflow", {
            taskQueue,
            workflowId: "opencode-turn:fail-once",
            args: [
              {
                roomId: "room:1",
                paneId: "pane:1",
                prompt: "OpenCode",
                providerId: "opencode"
              }
            ]
          })
        ).rejects.toThrowError(WorkflowFailedError);
        expect(openCodeAttempts).toBe(1);

        await expect(
          env.client.workflow.execute("codexAppServerTurnWorkflow", {
            taskQueue,
            workflowId: "cli-turn:fail-once",
            args: [
              {
                roomId: "room:1",
                paneId: "pane:1",
                prompt: "Claude CLI",
                providerId: "cli:claude"
              }
            ]
          })
        ).rejects.toThrowError(WorkflowFailedError);
        expect(cliAttempts).toBe(1);

        // roomAgentActionWorkflow: exhausts 5 attempts and persists failure via room-background-action-failure-v1
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
        ).rejects.toThrowError(WorkflowFailedError);
        expect(actionAttempts).toBe(5);
        expect(recordedActionFailures).toEqual([
          {
            roomId: "room:proof",
            missionId: "mission:proof",
            actionId: "action:legacy",
            cancelled: false
          }
        ]);
      });
    },
    120_000
  );

  it(
    "covers all room-supervisor-continuation scenarios and continueAsNew/cancellation in the real sandbox",
    async () => {
      const taskQueue = "ts-supervisor-current";
      let currentActivities: Record<string, (...args: any[]) => Promise<any>> = {};

      const invokeActivity = (name: string) => (...args: any[]) => {
        const fn = currentActivities[name];
        if (!fn) throw new Error(`Missing stubbed activity: ${name}`);
        return fn(...args);
      };

      const worker = await Worker.create({
        connection: env.nativeConnection,
        taskQueue,
        workflowBundle: mainWorkflowBundle,
        maxHeartbeatThrottleInterval: "50ms",
        defaultHeartbeatThrottleInterval: "50ms",
        activities: {
          prepareRoomAgentBackgroundContinuation: invokeActivity(
            "prepareRoomAgentBackgroundContinuation"
          ),
          checkRoomAgentSupervisorTurn: invokeActivity("checkRoomAgentSupervisorTurn"),
          discardRoomAgentSupervisorTurn: invokeActivity("discardRoomAgentSupervisorTurn"),
          finishRoomAgentSupervisorTurn: invokeActivity("finishRoomAgentSupervisorTurn"),
          runCodexAppServerTurn: invokeActivity("runCodexAppServerTurn"),
          settleRoomAgentBackgroundMission: invokeActivity("settleRoomAgentBackgroundMission"),
          markRoomAgentMissionStarted: invokeActivity("markRoomAgentMissionStarted"),
          markRoomAgentMissionContinued: invokeActivity("markRoomAgentMissionContinued"),
          markRoomAgentMissionFinished: invokeActivity("markRoomAgentMissionFinished")
        }
      });

      await worker.runUntil(async () => {
        // Case 1: executes allocation -> send -> verification in one mission
        {
          const c = continuationFixture();
          let childTurns = 0;
          let supervisorHandle:
            | Awaited<ReturnType<typeof env.client.workflow.start>>
            | undefined;

          currentActivities = {
            prepareRoomAgentBackgroundContinuation: async (input) =>
              prepareBackgroundContinuation(input, c.store),
            checkRoomAgentSupervisorTurn: async (item) => supervisorTurnState(item, c.store),
            discardRoomAgentSupervisorTurn: async ({ item, reason }) =>
              discardSupervisorTurn(item, reason, c.store),
            finishRoomAgentSupervisorTurn: async (input) =>
              finishSupervisorTurn(input, c.store),
            runCodexAppServerTurn: async (turn: DummyTurnInput) => {
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
                  roomId: turn.roomId,
                  paneId: turn.paneId,
                  completedAt: "2026-10-17T00:00:01.000Z",
                  status: "COMPLETED",
                  message: "Sent",
                  roomAgentOutcome: {
                    status: "VERIFIED",
                    executedActionCount: 1,
                    pendingActionIds: ["action:send"],
                    statusReason: "Queued"
                  }
                };
              }
              c.store.updateSpaceAgentRun(turn.agentRunId!, { status: "COMPLETED" });
              return {
                workflowId: "child-2",
                roomId: turn.roomId,
                paneId: turn.paneId,
                completedAt: "2026-10-17T00:00:02.000Z",
                status: "COMPLETED",
                message: "Verified",
                roomAgentOutcome: {
                  status: "VERIFIED",
                  executedActionCount: 1,
                  statusReason: "Verified remaining request."
                }
              };
            }
          };

          const workflowInput = roomAgentSupervisorInputSchema.parse({
            roomId: c.room.id,
            monitoringMissionIds: [c.initial.mission.id],
            processedCount: 48
          });
          supervisorHandle = await env.client.workflow.start("roomAgentSupervisorWorkflow", {
            taskQueue,
            workflowId: "sup-current:alloc-send-verify",
            followRuns: false,
            args: [workflowInput]
          });
          await expect(supervisorHandle.result()).rejects.toThrowError(
            WorkflowContinuedAsNewError
          );
          await env.client.workflow
            .getHandle("sup-current:alloc-send-verify")
            .terminate()
            .catch(() => undefined);
          expect(childTurns).toBe(2);
          expect(
            c.store
              .listRoomAgentActions(c.initial.mission.id)
              .filter((a) => a.actionType === "SEND")
          ).toHaveLength(1);
          expect(c.store.getRoomAgentMission(c.room.id, c.initial.mission.id)?.status).toBe(
            "COMPLETED"
          );
        }

        // Case 2: retires a prepared run when stop or follow-up arrives before the activity reply
        for (const kind of ["stop", "follow-up"] as const) {
          const c = continuationFixture();
          const childCalls: DummyTurnInput[] = [];
          let signaledDuringPrepare = false;
          let preparedRunId = "";
          let handle!: Awaited<ReturnType<typeof env.client.workflow.start>>;

          currentActivities = {
            prepareRoomAgentBackgroundContinuation: async (input) => {
              const result = await prepareBackgroundContinuation(input, c.store);
              if (result.state === "READY") {
                preparedRunId = result.item.turn.agentRunId ?? "";
              }
              if (!signaledDuringPrepare) {
                signaledDuringPrepare = true;
                if (kind === "stop") {
                  c.store.updateRoomAgentMission(c.initial.mission.id, {
                    status: "INTERRUPTED"
                  });
                  await handle.signal(ROOM_AGENT_STOP_SIGNAL, {
                    missionId: null,
                    reason: "Stop"
                  });
                } else {
                  const followUp = c.enqueue("follow-up", "Only inspect the room.");
                  await handle.signal(ROOM_AGENT_ENQUEUE_SIGNAL, followUp.queueItem);
                }
              }
              return result;
            },
            checkRoomAgentSupervisorTurn: async (item) => supervisorTurnState(item, c.store),
            discardRoomAgentSupervisorTurn: async ({ item, reason }) =>
              discardSupervisorTurn(item, reason, c.store),
            finishRoomAgentSupervisorTurn: async (input) =>
              finishSupervisorTurn(input, c.store),
            runCodexAppServerTurn: async (turn: DummyTurnInput) => {
              childCalls.push(turn);
              c.store.updateSpaceAgentRun(turn.agentRunId!, { status: "COMPLETED" });
              return {
                workflowId: `child:${turn.agentRunId}`,
                roomId: turn.roomId,
                paneId: turn.paneId,
                completedAt: "2026-10-17T00:00:01.000Z",
                status: "COMPLETED",
                message: "Done",
                roomAgentOutcome: {
                  status: "VERIFIED",
                  executedActionCount: 1,
                  statusReason: "Done"
                }
              };
            }
          };

          const input = roomAgentSupervisorInputSchema.parse({
            roomId: c.room.id,
            monitoringMissionIds: [c.initial.mission.id],
            processedCount: kind === "stop" ? 50 : 49
          });
          handle = await env.client.workflow.start("roomAgentSupervisorWorkflow", {
            taskQueue,
            workflowId: `sup-current:retire-${kind}`,
            followRuns: false,
            args: [input]
          });
          await expect(handle.result()).rejects.toThrowError(WorkflowContinuedAsNewError);
          await env.client.workflow
            .getHandle(`sup-current:retire-${kind}`)
            .terminate()
            .catch(() => undefined);

          expect(preparedRunId).toMatch(/^agent_run:bg-/);
          expect(c.store.getRoomAgentTurn(c.initial.mission.id, preparedRunId)?.run.status).toBe(
            "INTERRUPTED"
          );
          if (kind === "stop") {
            expect(childCalls).toHaveLength(0);
          } else {
            expect(childCalls).toHaveLength(1);
            expect(childCalls[0]!.roomAgentOperatorRequest).toBe("Only inspect the room.");
          }
        }

        // Case 3: carries a prepared continuation through continueAsNew and starts it once on the continued run
        {
          const c = continuationFixture();
          let childCalls = 0;
          let resolveFinished!: () => void;
          const finishedPromise = new Promise<void>((resolve) => {
            resolveFinished = resolve;
          });

          currentActivities = {
            prepareRoomAgentBackgroundContinuation: async (input) =>
              prepareBackgroundContinuation(input, c.store),
            checkRoomAgentSupervisorTurn: async (item) => supervisorTurnState(item, c.store),
            discardRoomAgentSupervisorTurn: async ({ item, reason }) =>
              discardSupervisorTurn(item, reason, c.store),
            finishRoomAgentSupervisorTurn: async (input) => {
              await finishSupervisorTurn(input, c.store);
              resolveFinished();
            },
            runCodexAppServerTurn: async (turn: DummyTurnInput) => {
              childCalls += 1;
              c.store.updateSpaceAgentRun(turn.agentRunId!, { status: "COMPLETED" });
              return {
                workflowId: `child:${turn.agentRunId}`,
                roomId: turn.roomId,
                paneId: turn.paneId,
                completedAt: "2026-10-17T00:00:01.000Z",
                status: "COMPLETED",
                message: "Verified",
                roomAgentOutcome: {
                  status: "VERIFIED",
                  executedActionCount: 1,
                  statusReason: "Verified"
                }
              };
            }
          };

          const handle = await env.client.workflow.start("roomAgentSupervisorWorkflow", {
            taskQueue,
            workflowId: "sup-current:carry-continuation",
            followRuns: false,
            args: [
              roomAgentSupervisorInputSchema.parse({
                roomId: c.room.id,
                monitoringMissionIds: [c.initial.mission.id],
                processedCount: 50
              })
            ]
          });
          await expect(handle.result()).rejects.toThrowError(WorkflowContinuedAsNewError);

          const firstHistory = await env.client.workflow
            .getHandle("sup-current:carry-continuation", handle.firstExecutionRunId)
            .fetchHistory();
          const resumed = roomAgentSupervisorInputSchema.parse(
            decodeContinueAsNewInput(firstHistory)
          );
          expect(resumed.pending).toHaveLength(1);

          await finishedPromise;
          await env.client.workflow
            .getHandle("sup-current:carry-continuation")
            .terminate()
            .catch(() => undefined);
          expect(childCalls).toBe(1);
          expect(c.store.getRoomAgentMission(c.room.id, c.initial.mission.id)?.status).toBe(
            "COMPLETED"
          );
        }

        // Case 4: defers continueAsNew until the carried queue fits the next run's input bounds (<= 100)
        {
          const roomId = "room:carry-bound";
          const makeItem = (index: number): RoomAgentSupervisorQueueItem => ({
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

          let flooded = false;
          let firstRunCheckCalls = 0;
          let handle!: Awaited<ReturnType<typeof env.client.workflow.start>>;

          currentActivities = {
            checkRoomAgentSupervisorTurn: async () => {
              if (
                Context.current().info.workflowExecution.runId === handle.firstExecutionRunId
              ) {
                firstRunCheckCalls += 1;
              }
              if (!flooded) {
                flooded = true;
                for (let index = 1; index <= 105; index += 1) {
                  await handle.signal(ROOM_AGENT_ENQUEUE_SIGNAL, makeItem(index));
                }
              }
              return "SKIP";
            },
            discardRoomAgentSupervisorTurn: async () => undefined,
            finishRoomAgentSupervisorTurn: async () => undefined
          };

          handle = await env.client.workflow.start("roomAgentSupervisorWorkflow", {
            taskQueue,
            workflowId: "sup-current:carry-bound",
            followRuns: false,
            args: [
              roomAgentSupervisorInputSchema.parse({
                roomId,
                pending: [makeItem(0)],
                processedCount: 49
              })
            ]
          });
          await expect(handle.result()).rejects.toThrowError(WorkflowContinuedAsNewError);
          await env.client.workflow
            .getHandle("sup-current:carry-bound")
            .terminate()
            .catch(() => undefined);

          const history = await env.client.workflow
            .getHandle("sup-current:carry-bound", handle.firstExecutionRunId)
            .fetchHistory();
          const carried = decodeContinueAsNewInput<RoomAgentSupervisorInput>(history);
          expect(carried.pending).toHaveLength(100);
          expect(() => roomAgentSupervisorInputSchema.parse(carried)).not.toThrow();
          expect(firstRunCheckCalls).toBe(6);
        }

        // Case 5: interrupts a running mission via stop signal and polls background continuation on 1s timer
        {
          const roomId = "room:interrupt-and-polls";
          const finished: Array<Record<string, unknown>> = [];
          let pollCount = 0;
          let handle!: Awaited<ReturnType<typeof env.client.workflow.start>>;

          const runningItem: RoomAgentSupervisorQueueItem = {
            missionId: "mission:running",
            turn: {
              roomId,
              paneId: "pane:room-agent-1",
              prompt: "Long running turn",
              artifactIds: [],
              agentRunId: "agent_run:running-1",
              permissionMode: null,
              collaborationMode: "default",
              traceId: "trace:running-1"
            }
          };

          const polledContinuationItem: RoomAgentSupervisorQueueItem = {
            missionId: "mission:poll-ready",
            turn: {
              roomId,
              paneId: "pane:room-agent-1",
              prompt: "Polled continuation turn",
              artifactIds: [],
              agentRunId: "agent_run:polled-1",
              permissionMode: null,
              collaborationMode: "default",
              traceId: "trace:polled-1",
              roomAgentContinuation: {
                sourceRunId: "agent_run:source-1",
                generation: 1
              }
            }
          };

          currentActivities = {
            checkRoomAgentSupervisorTurn: async () => "READY",
            discardRoomAgentSupervisorTurn: async () => undefined,
            finishRoomAgentSupervisorTurn: async (payload) => {
              finished.push(payload);
            },
            runCodexAppServerTurn: async (turn: DummyTurnInput) => {
              if (turn.agentRunId === "agent_run:running-1") {
                const ctx = Context.current();
                await handle.signal(ROOM_AGENT_STOP_SIGNAL, {
                  missionId: "mission:running",
                  reason: "Interrupted by operator in sandbox test."
                });
                for (;;) {
                  ctx.heartbeat();
                  await ctx.sleep(25);
                }
              }
              return {
                workflowId: `child:${turn.agentRunId}`,
                roomId: turn.roomId,
                paneId: turn.paneId,
                completedAt: "2026-10-17T00:00:03.000Z",
                status: "COMPLETED" as const,
                message: "Polled turn completed",
                roomAgentOutcome: {
                  status: "VERIFIED" as const,
                  executedActionCount: 1,
                  statusReason: "Verified after polling"
                }
              };
            },
            prepareRoomAgentBackgroundContinuation: async ({
              missionId
            }: {
              roomId: string;
              missionId: string;
              continuationId: string;
            }) => {
              pollCount += 1;
              if (missionId === "mission:poll-ready" && pollCount >= 3) {
                return { state: "READY" as const, item: polledContinuationItem };
              }
              return { state: "WAITING" as const };
            }
          };

          handle = await env.client.workflow.start("roomAgentSupervisorWorkflow", {
            taskQueue,
            workflowId: "sup-current:interrupt-and-polls",
            followRuns: false,
            args: [
              roomAgentSupervisorInputSchema.parse({
                roomId,
                pending: [runningItem],
                monitoringMissionIds: ["mission:poll-ready", "mission:keep-monitoring"],
                processedCount: 48
              })
            ]
          });
          await expect(handle.result()).rejects.toThrowError(WorkflowContinuedAsNewError);
          await env.client.workflow
            .getHandle("sup-current:interrupt-and-polls")
            .terminate()
            .catch(() => undefined);

          expect(finished).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                status: "INTERRUPTED",
                statusReason: "Interrupted by operator in sandbox test."
              }),
              expect.objectContaining({
                status: "COMPLETED",
                statusReason: "Verified after polling"
              })
            ])
          );
          expect(pollCount).toBeGreaterThanOrEqual(3);
          const history = await env.client.workflow
            .getHandle("sup-current:interrupt-and-polls", handle.firstExecutionRunId)
            .fetchHistory();
          const carried = decodeContinueAsNewInput<RoomAgentSupervisorInput>(history);
          expect(carried.monitoringMissionIds).toEqual(["mission:keep-monitoring"]);
        }
      });
    },
    120_000
  );

  it(
    "runs the pre-patch roomAgentSupervisorWorkflow branch with 1s polling, signals, interruption, and continueAsNew",
    async () => {
      const taskQueue = "ts-supervisor-pre-patch";
      let settlePolls = 0;
      let signaledAfterPolls = false;
      const finishedMissions: Array<Record<string, unknown>> = [];
      let activeHandle: Awaited<ReturnType<typeof env.client.workflow.start>> | undefined;
      let pollHandle: Awaited<ReturnType<typeof env.client.workflow.start>> | undefined;

      const enqueuedAfterPollItem: RoomAgentSupervisorQueueItem = {
        missionId: "mission:legacy-enqueued",
        turn: {
          roomId: "room:legacy-polls",
          paneId: "pane:legacy",
          prompt: "Enqueued after 3 polling cycles",
          artifactIds: [],
          agentRunId: "agent_run:legacy-enqueued",
          permissionMode: null,
          collaborationMode: "default",
          traceId: "trace:legacy-enqueued"
        }
      };

      const worker = await Worker.create({
        connection: env.nativeConnection,
        taskQueue,
        workflowsPath: WORKFLOW_MODULE_PATHS.main,
        bundlerOptions: createWorktreeBundlerOptions({
          disableRoomBackgroundContinuationPatch: true
        }),
        maxHeartbeatThrottleInterval: "50ms",
        defaultHeartbeatThrottleInterval: "50ms",
        activities: {
          settleRoomAgentBackgroundMission: async ({ missionId }: { missionId: string }) => {
            settlePolls += 1;
            if (missionId === "mission:settle-immediately") return true;
            if (missionId === "mission:settle-on-poll-3" && settlePolls >= 3) {
              if (!signaledAfterPolls) {
                signaledAfterPolls = true;
                await pollHandle?.signal(ROOM_AGENT_ENQUEUE_SIGNAL, enqueuedAfterPollItem);
              }
              return true;
            }
            return false;
          },
          markRoomAgentMissionStarted: async () => undefined,
          markRoomAgentMissionContinued: async () => undefined,
          markRoomAgentMissionFinished: async (payload: Record<string, unknown>) => {
            finishedMissions.push(payload);
          },
          runCodexAppServerTurn: async (turn: DummyTurnInput) => {
            if (turn.agentRunId === "agent_run:legacy-cancel") {
              const ctx = Context.current();
              await activeHandle?.signal(ROOM_AGENT_STOP_SIGNAL, {
                missionId: "mission:legacy-cancel",
                reason: "Legacy operator stop."
              });
              for (;;) {
                ctx.heartbeat();
                await ctx.sleep(25);
              }
            }
            return {
              workflowId: `legacy:${turn.agentRunId}`,
              roomId: turn.roomId,
              paneId: turn.paneId,
              completedAt: "2026-10-17T00:00:01.000Z",
              status: "COMPLETED" as const,
              message: "Completed",
              roomAgentOutcome: {
                status: "VERIFIED" as const,
                executedActionCount: 1,
                statusReason: "Legacy mission verified."
              }
            };
          }
        }
      });

      await worker.runUntil(async () => {
        // 1. Interrupting a running mission + continueAsNew after 50 processed items
        const cancelItem: RoomAgentSupervisorQueueItem = {
          missionId: "mission:legacy-cancel",
          turn: {
            roomId: "room:legacy",
            paneId: "pane:legacy",
            prompt: "Cancel me",
            artifactIds: [],
            agentRunId: "agent_run:legacy-cancel",
            permissionMode: null,
            collaborationMode: "default",
            traceId: "trace:legacy-cancel"
          }
        };

        activeHandle = await env.client.workflow.start("roomAgentSupervisorWorkflow", {
          taskQueue,
          workflowId: "sup-legacy:interrupt-and-50",
          followRuns: false,
          args: [
            roomAgentSupervisorInputSchema.parse({
              roomId: "room:legacy",
              pending: [cancelItem],
              monitoringMissionIds: ["mission:settle-immediately"],
              processedCount: 49
            })
          ]
        });
        await expect(activeHandle.result()).rejects.toThrowError(WorkflowContinuedAsNewError);
        expect(finishedMissions).toContainEqual({
          missionId: "mission:legacy-cancel",
          roomId: "room:legacy",
          status: "INTERRUPTED",
          statusReason: "Legacy operator stop."
        });

        // 2. 1s polling loops + enqueue signal on the pre-patch branch triggers continueAsNew with carried state intact
        settlePolls = 0;
        pollHandle = await env.client.workflow.start("roomAgentSupervisorWorkflow", {
          taskQueue,
          workflowId: "sup-legacy:polls-and-continue",
          followRuns: false,
          args: [
            roomAgentSupervisorInputSchema.parse({
              roomId: "room:legacy-polls",
              pending: [],
              monitoringMissionIds: ["mission:settle-on-poll-3", "mission:keep-monitoring"],
              processedCount: 49
            })
          ]
        });
        await expect(pollHandle.result()).rejects.toThrowError(WorkflowContinuedAsNewError);
        expect(settlePolls).toBeGreaterThanOrEqual(3);

        const pollHistory = await env.client.workflow
          .getHandle("sup-legacy:polls-and-continue", pollHandle.firstExecutionRunId)
          .fetchHistory();
        const carried = decodeContinueAsNewInput<RoomAgentSupervisorInput>(pollHistory);
        expect(carried.roomId).toBe("room:legacy-polls");
        expect(carried.processedCount).toBe(0);
        expect(carried.monitoringMissionIds).toEqual(["mission:keep-monitoring"]);
      });
    },
    120_000
  );

  it(
    "runs memoryMaintenanceWorkflow, memoryConsolidationWorkflow, and memoryMutationWorkflow with child workflows and retries",
    async () => {
      let refreshSnapshotAttempts = 0;
      let allMonthsAttempts = 0;
      let reconcileAttempts = 0;
      let mutationAttempts = 0;
      let finalizeCalled = false;

      const maintenanceWorker = await Worker.create({
        connection: env.nativeConnection,
        taskQueue: MEMORY_MAINTENANCE_TASK_QUEUE,
        workflowsPath: WORKFLOW_MODULE_PATHS.memoryMaintenance,
        bundlerOptions: createWorktreeBundlerOptions(),
        activities: {
          refreshMemoryGraphSnapshot: async (): Promise<MemoryMaintenanceResult> => {
            if (++refreshSnapshotAttempts === 1) {
              throw ApplicationFailure.retryable("Transient snapshot error", "SNAPSHOT_RETRY");
            }
            return {
              snapshotPath: "/tmp/memory-snapshot.json",
              sourceHash: "sha256:test-hash",
              nodeCount: 25,
              edgeCount: 40,
              generatedAt: "2026-10-17T00:00:00.000Z"
            };
          },
          refreshAllMonthsMemoryGraphSnapshot: async () => {
            allMonthsAttempts += 1;
            throw ApplicationFailure.retryable("All-months failed", "ALL_MONTHS_ERR");
          },
          reconcileStaleSpaceAgentSessions: async () => {
            reconcileAttempts += 1;
            throw ApplicationFailure.retryable("Reconcile failed", "RECONCILE_ERR");
          },
          createScheduledMemoryAudit: async () => ({
            id: "consolidation_run:child-1",
            workflowId: "memory-consolidation:child-1"
          }),
          prepareMemoryConsolidation: async ({ runId }: { runId: string }) => {
            if (runId === "consolidation_run:no-op") {
              return {
                changeSetId: null,
                run: {
                  id: runId,
                  status: "COMPLETED",
                  trigger: "SCHEDULED",
                  sourceHash: "sha256:test-hash",
                  findingsCount: 0,
                  appliedOperationsCount: 0,
                  changeSetId: null,
                  workflowId: `wf:${runId}`,
                  errorMessage: null,
                  startedAt: "2026-10-17T00:00:00.000Z",
                  completedAt: "2026-10-17T00:00:01.000Z",
                  createdAt: "2026-10-17T00:00:00.000Z",
                  updatedAt: "2026-10-17T00:00:01.000Z"
                } satisfies MemoryConsolidationRun
              };
            }
            return {
              changeSetId: `changeset:${runId}`,
              run: {
                id: runId,
                status: "APPLYING",
                trigger: "SCHEDULED",
                sourceHash: "sha256:test-hash",
                findingsCount: 2,
                appliedOperationsCount: 0,
                changeSetId: `changeset:${runId}`,
                workflowId: `wf:${runId}`,
                errorMessage: null,
                startedAt: "2026-10-17T00:00:00.000Z",
                completedAt: null,
                createdAt: "2026-10-17T00:00:00.000Z",
                updatedAt: "2026-10-17T00:00:00.000Z"
              } satisfies MemoryConsolidationRun
            };
          },
          finalizeMemoryRepair: async ({
            runId,
            changeSetId
          }: {
            runId: string;
            changeSetId: string;
          }): Promise<MemoryConsolidationRun> => {
            finalizeCalled = true;
            return {
              id: runId,
              status: "COMPLETED",
              trigger: "SCHEDULED",
              sourceHash: "sha256:test-hash",
              findingsCount: 2,
              appliedOperationsCount: 3,
              changeSetId,
              workflowId: `wf:${runId}`,
              errorMessage: null,
              startedAt: "2026-10-17T00:00:00.000Z",
              completedAt: "2026-10-17T00:00:05.000Z",
              createdAt: "2026-10-17T00:00:00.000Z",
              updatedAt: "2026-10-17T00:00:05.000Z"
            };
          }
        }
      });

      const mutationWorker = await Worker.create({
        connection: env.nativeConnection,
        taskQueue: MEMORY_MUTATION_TASK_QUEUE,
        workflowsPath: WORKFLOW_MODULE_PATHS.memoryMutation,
        bundlerOptions: createWorktreeBundlerOptions(),
        activities: {
          executePersistedMemoryChangeSet: async ({
            changeSetId
          }: {
            changeSetId: string;
          }): Promise<MemoryMutationWorkflowResult> => {
            if (++mutationAttempts === 1) {
              throw ApplicationFailure.retryable("Transient mutation failure", "MUTATION_RETRY");
            }
            return {
              changeSetId,
              status: "APPLIED",
              appliedOperationsCount: 3,
              snapshotInvalidated: true,
              summary: "Applied change set"
            };
          }
        }
      });

      await mutationWorker.runUntil(async () => {
        await maintenanceWorker.runUntil(async () => {
          const maintResult = await env.client.workflow.execute("memoryMaintenanceWorkflow", {
            taskQueue: MEMORY_MAINTENANCE_TASK_QUEUE,
            workflowId: "memory-maintenance:full",
            args: [{ reason: "scheduled", traceId: "trace:maint-1" }]
          });
          expect(maintResult.sourceHash).toBe("sha256:test-hash");
          expect(refreshSnapshotAttempts).toBe(2);
          // Both optional steps exhausted their 3 attempts and were caught without failing maintenance
          expect(allMonthsAttempts).toBe(3);
          expect(reconcileAttempts).toBe(3);
          // Child memoryConsolidationWorkflow ran executePersistedMemoryChangeSet (with retry) + finalizeMemoryRepair
          expect(mutationAttempts).toBe(2);
          expect(finalizeCalled).toBe(true);

          const noOpRun = await env.client.workflow.execute("memoryConsolidationWorkflow", {
            taskQueue: MEMORY_MAINTENANCE_TASK_QUEUE,
            workflowId: "memory-consolidation:no-op",
            args: [{ runId: "consolidation_run:no-op", traceId: "trace:no-op" }]
          });
          expect(noOpRun.status).toBe("COMPLETED");
          expect(noOpRun.changeSetId).toBeNull();

          mutationAttempts = 0;
          const mutResult = await env.client.workflow.execute("memoryMutationWorkflow", {
            taskQueue: MEMORY_MUTATION_TASK_QUEUE,
            workflowId: "memory-mutation:direct",
            args: [{ changeSetId: "changeset:direct-1", traceId: "trace:direct-1" }]
          });
          expect(mutationAttempts).toBe(2);
          expect(mutResult.status).toBe("APPLIED");
        });
      });
    },
    120_000
  );
});
