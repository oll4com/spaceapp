import { createHash, randomUUID } from "node:crypto";
import {
  reasoningEffortSchema,
  spaceAgentRoomActionBridgeResponseSchema,
  type Pane,
  type RoomAgentActionType,
  type SpaceAgentRoomActionBridgeRequest,
  type SpaceAgentRoomActionBridgeResult,
  type SpaceAgentRoomActionRequest
} from "@space/contracts";
import { makeSpaceId, nowIso, redactMemoryText, type SpaceStore } from "@space/runtime";
import type { BrowserSessionManager } from "./browser-sessions.js";
import type { CliTerminalManager } from "./cli-terminal.js";
import type { SpaceAgentAdapter } from "./space-agent.js";
import type { RoomPlanInventoryProvider } from "./room-plan-inventory.js";
import { unavailableRoomTaskEvaluator, type RoomTaskEvaluator } from "./room-task-evaluator.js";
import { isCliRuntimeTerminalLaunchable } from "./cli-runtimes.js";

function actionType(request: SpaceAgentRoomActionRequest): RoomAgentActionType {
  switch (request.action.type) {
    case "inspect": return "INSPECT";
    case "orchestrate": return "ORCHESTRATE";
    case "send": return "SEND";
    case "interrupt": return "INTERRUPT";
    case "restart": return "RESTART";
    case "create_pane": return "CREATE_PANE";
    case "close_pane": return "CLOSE_PANE";
    case "reopen_pane": return "REOPEN_PANE";
  }
}

function actionPaneId(request: SpaceAgentRoomActionRequest): string | null {
  switch (request.action.type) {
    case "send":
    case "interrupt":
    case "restart":
    case "close_pane":
    case "reopen_pane":
      return request.action.paneId;
    default:
      return null;
  }
}

function idempotencyKey(
  missionId: string,
  index: string,
  request: SpaceAgentRoomActionRequest,
  executionId: string | null = null
): string {
  const payload = executionId === null ? request : { request, executionId };
  const digest = createHash("sha256").update(JSON.stringify(payload)).digest("hex").slice(0, 32);
  return `room-agent:${missionId}:${index}:${digest}`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function roomAgentExecutionScore(input: {
  verified: boolean;
  retryCount: number;
  restartCount: number;
  stallCount: number;
}): {
  score: number;
  breakdown: { verified: number; retries: number; restarts: number; stalls: number };
} {
  const breakdown = {
    verified: input.verified ? 100 : 0,
    retries: input.verified ? -10 * Math.max(0, input.retryCount) : 0,
    restarts: input.verified ? -15 * Math.max(0, input.restartCount) : 0,
    stalls: input.verified ? -10 * Math.max(0, input.stallCount) : 0
  };
  return {
    score: Math.max(0, Math.min(100, Object.values(breakdown).reduce((total, value) => total + value, 0))),
    breakdown
  };
}

class RecoverableCliTurnError extends Error {
  constructor(readonly code: "CLI_TURN_ABORTED" | "CLI_TURN_NOT_STARTED" | "CLI_TURN_UNAVAILABLE", message: string) {
    super(message);
  }
}

interface CliSendCheckpoint {
  phase: "INTENT" | "CONTENT" | "SENT";
  paneId: string;
  sessionId: string;
  marker: string;
  markerAtMs: number;
  turnId: string | null;
}

function readCliSendCheckpoint(evidence: Record<string, unknown>): CliSendCheckpoint | null {
  const checkpoint = evidence.cliSend;
  if (!checkpoint || typeof checkpoint !== "object" || Array.isArray(checkpoint)) return null;
  const candidate = checkpoint as Record<string, unknown>;
  if (
    typeof candidate.paneId !== "string" ||
    typeof candidate.sessionId !== "string" ||
    typeof candidate.marker !== "string" ||
    typeof candidate.markerAtMs !== "number" ||
    (candidate.turnId !== null && typeof candidate.turnId !== "string")
  ) {
    return null;
  }
  let phase: CliSendCheckpoint["phase"] = "SENT";
  if (candidate.phase === "INTENT") phase = "INTENT";
  if (candidate.phase === "CONTENT") phase = "CONTENT";
  return {
    phase,
    paneId: candidate.paneId,
    sessionId: candidate.sessionId,
    marker: candidate.marker,
    markerAtMs: candidate.markerAtMs,
    turnId: candidate.turnId
  };
}

export function createRoomActionExecutor(options: {
  store: SpaceStore;
  cliTerminalManager: Pick<CliTerminalManager, "sendInput" | "getTurnActivity" | "interrupt"> &
    Partial<Pick<CliTerminalManager, "ensurePaneControlReady" | "getCurrentTurnActivity" | "listRuntimes">>;
  spaceAgentAdapter: SpaceAgentAdapter;
  browserSessionManager: BrowserSessionManager;
  roomPlanInventoryProvider?: RoomPlanInventoryProvider;
  taskEvaluator?: RoomTaskEvaluator;
  pollIntervalMs?: number;
  actionTimeoutMs?: number;
  cliSendRecoveryGraceMs?: number;
  cliTurnStartGraceMs?: number;
  cliExistingTurnStallMs?: number;
  cliSubmittedTurnStallMs?: number;
  cliEscapeRecoveryGraceMs?: number;
  isCliRuntimeEnabled?: (runtimeId: string) => Promise<boolean>;
  assertCliRuntimeEnabled?: (runtimeId: string) => Promise<void>;
}) {
  const { store, cliTerminalManager, spaceAgentAdapter, browserSessionManager, roomPlanInventoryProvider } = options;
  const taskEvaluator = options.taskEvaluator ?? unavailableRoomTaskEvaluator;
  const pollIntervalMs = options.pollIntervalMs ?? 1_500;
  const actionTimeoutMs = options.actionTimeoutMs ?? 23 * 60 * 60_000;
  const cliSendRecoveryGraceMs = Math.min(60_000, Math.max(0, options.cliSendRecoveryGraceMs ?? 15_000));
  const cliTurnStartGraceMs = Math.min(actionTimeoutMs, Math.max(1, options.cliTurnStartGraceMs ?? 30_000));
  const cliExistingTurnStallMs = Math.min(actionTimeoutMs, Math.max(1, options.cliExistingTurnStallMs ?? 120_000));
  const cliSubmittedTurnStallMs = Math.min(actionTimeoutMs, Math.max(1, options.cliSubmittedTurnStallMs ?? 12 * 60_000));
  const cliEscapeRecoveryGraceMs = Math.min(actionTimeoutMs, Math.max(1, options.cliEscapeRecoveryGraceMs ?? 10_000));
  const inspectTailLimit = 20;

  async function paneRuntimeEnabled(pane: Pane): Promise<boolean> {
    if (pane.mode !== "TERMINAL" || !pane.terminalRuntimeId || !options.isCliRuntimeEnabled) return true;
    return options.isCliRuntimeEnabled(pane.terminalRuntimeId);
  }

  async function assertPaneRuntimeEnabled(pane: Pane): Promise<void> {
    if (pane.mode !== "TERMINAL" || !pane.terminalRuntimeId || !options.assertCliRuntimeEnabled) return;
    await options.assertCliRuntimeEnabled(pane.terminalRuntimeId);
  }

  async function paneInRoom(roomId: string, paneId: string, agentPaneId: string): Promise<Pane> {
    if (paneId === agentPaneId) throw new Error("The hidden Room Agent pane cannot target itself.");
    const pane = (await store.listPanes(roomId, true)).find((candidate) => candidate.id === paneId);
    if (!pane) throw new Error(`Pane ${paneId} was not found in this room.`);
    return pane;
  }

  async function actionInMission(missionId: string, actionId: string) {
    return store.getRoomAgentAction(missionId, actionId);
  }

  async function missionInRoom(roomId: string, missionId: string) {
    return store.getRoomAgentMission(roomId, missionId);
  }

  async function assertMissionRunning(bridge: SpaceAgentRoomActionBridgeRequest) {
    let mission = await missionInRoom(bridge.roomId, bridge.missionId);
    if (!mission || mission.sessionId !== bridge.agentSessionId) {
      throw new Error("Room Agent mission is not available in this room.");
    }
    while (mission.status === "PAUSED") {
      await delay(pollIntervalMs);
      mission = await missionInRoom(bridge.roomId, bridge.missionId);
      if (!mission || mission.sessionId !== bridge.agentSessionId) {
        throw new Error("Room Agent mission is not available in this room.");
      }
    }
    if (mission.status !== "RUNNING") {
      throw new Error(`Room Agent mission is not running: ${mission.statusReason}`);
    }
    return mission;
  }

  async function assertActionCanContinue(
    bridge: SpaceAgentRoomActionBridgeRequest,
    actionId: string
  ): Promise<void> {
    await assertMissionRunning(bridge);
    const action = await actionInMission(bridge.missionId, actionId);
    if (action?.status === "BLOCKED") throw new Error(action.statusReason);
  }

  async function reportProgress(
    bridge: SpaceAgentRoomActionBridgeRequest,
    content: string,
    traceId: string
  ): Promise<void> {
    const messages = await store.listSpaceAgentMessages(bridge.agentSessionId, 24);
    const safeContent = redactMemoryText(content).slice(0, 2_000);
    if (messages.some((message) => message.role === "assistant" && message.status === "COMPLETED" && message.content === safeContent)) {
      return;
    }
    await store.createSpaceAgentMessage({
      sessionId: bridge.agentSessionId,
      role: "assistant",
      content: safeContent,
      status: "COMPLETED"
    }, traceId);
  }

  async function sendCliEscape(sessionId: string, traceId: string, idempotencyKey: string) {
    await cliTerminalManager.sendInput(sessionId, "\u001b", traceId, null, idempotencyKey);
    return { controlMode: "KEYSTROKE" as const, key: "ESC" as const, sessionId };
  }

  async function waitForCli(
    sessionId: string,
    marker: string,
    markerAtMs: number,
    startedAtMs: number,
    initialTurnId: string | null,
    onTurnId: (turnId: string) => Promise<void>,
    bridge: SpaceAgentRoomActionBridgeRequest,
    actionId: string,
    traceId: string
  ): Promise<{ status: string; turnId: string | null }> {
    let turnId = initialTurnId;
    let lastRolloutActivityAtMs = markerAtMs;
    let escapedStall = false;
    while (Date.now() - startedAtMs < actionTimeoutMs) {
      await assertActionCanContinue(bridge, actionId);
      let activity = await cliTerminalManager.getTurnActivity(sessionId, marker, {
        markerAtMs,
        turnId,
        inputMarker: marker
      });
      if (activity.lastActivityAtMs !== undefined) {
        lastRolloutActivityAtMs = Math.max(lastRolloutActivityAtMs, activity.lastActivityAtMs);
      }
      if (activity.turnId && activity.turnId !== turnId) {
        turnId = activity.turnId;
        await onTurnId(turnId);
      }
      if (activity.status === "COMPLETED") return { status: activity.status, turnId };
      if (activity.status === "ABORTED") {
        throw new RecoverableCliTurnError("CLI_TURN_ABORTED", "CLI turn aborted before completion evidence; automatic pane recovery is required.");
      }
      if (activity.status === "UNAVAILABLE") {
        throw new RecoverableCliTurnError("CLI_TURN_UNAVAILABLE", "CLI turn became unavailable before completion evidence; automatic pane recovery is required.");
      }
      if (activity.status === "PENDING" && Date.now() - markerAtMs >= cliTurnStartGraceMs) {
        throw new RecoverableCliTurnError("CLI_TURN_NOT_STARTED", "CLI pane accepted input but did not start a turn; automatic pane recovery is required.");
      }
      if (activity.status === "RUNNING" && Date.now() - lastRolloutActivityAtMs >= cliSubmittedTurnStallMs) {
        if (escapedStall) {
          throw new Error("CLI task remains stalled after Escape; manual operator decision is required without changing its session or thread.");
        }
        escapedStall = true;
        await reportProgress(
          bridge,
          "The submitted CLI turn is not writing new Codex rollout events. I only send Esc, without restart or session/thread change.",
          traceId
        );
        await sendCliEscape(sessionId, traceId, `${actionId}:escape-submitted-stall`);
        const activityBeforeEscapeMs = lastRolloutActivityAtMs;
        const recoveryDeadline = Date.now() + cliEscapeRecoveryGraceMs;
        while (Date.now() < recoveryDeadline) {
          await delay(pollIntervalMs);
          activity = await cliTerminalManager.getTurnActivity(sessionId, marker, {
            markerAtMs,
            turnId,
            inputMarker: marker
          });
          if (activity.turnId && activity.turnId !== turnId) {
            turnId = activity.turnId;
            await onTurnId(turnId);
          }
          if (activity.lastActivityAtMs !== undefined) {
            lastRolloutActivityAtMs = Math.max(lastRolloutActivityAtMs, activity.lastActivityAtMs);
          }
          if (activity.status !== "RUNNING" || lastRolloutActivityAtMs > activityBeforeEscapeMs) break;
        }
        if (activity.status === "COMPLETED") return { status: activity.status, turnId };
        if (activity.status !== "RUNNING" || lastRolloutActivityAtMs <= activityBeforeEscapeMs) {
          await reportProgress(
            bridge,
            "BLOCKED: the CLI turn remained stalled after Esc. I did not change task, session or thread; a manual operator decision is required.",
            traceId
          );
          throw new Error("CLI task remains stalled after Escape; manual operator decision is required without changing its session or thread.");
        }
      }
      await delay(pollIntervalMs);
    }
    throw new Error("CLI pane did not provide completion evidence before the Room Agent timeout.");
  }

  async function waitForChat(
    pane: Pane,
    startedAtMs: number,
    bridge: SpaceAgentRoomActionBridgeRequest,
    actionId: string
  ): Promise<void> {
    while (Date.now() - startedAtMs < actionTimeoutMs) {
      await assertActionCanContinue(bridge, actionId);
      const session = await spaceAgentAdapter.loadSession({ pane });
      if (session.runStatus === "IDLE") return;
      if (session.runStatus === "ERROR" || session.runStatus === "BLOCKED") {
        throw new Error(session.statusReason);
      }
      await delay(pollIntervalMs);
    }
    throw new Error("Chat pane did not provide completion evidence before the Room Agent timeout.");
  }

  async function finalPaneResult(pane: Pane, sinceMs: number): Promise<string> {
    if (pane.mode === "TERMINAL") {
      const session = await store.getActivePaneCliSession(pane.id);
      if (!session || session.purpose !== "NORMAL") return "CLI task completed without a readable final transcript.";
      const chunks = await store.listPaneCliTranscriptChunks(session.sessionId);
      return redactMemoryText(chunks.filter((chunk) => Date.parse(chunk.createdAt) >= sinceMs).slice(-20).map((chunk) => chunk.content).join("\n")).slice(-12_000) ||
        "CLI task completed without textual output.";
    }
    if (pane.mode === "CHAT") {
      const session = await store.getActiveSpaceAgentSession(pane.id);
      if (!session) return "Chat task completed without a readable final response.";
      const messages = await store.listSpaceAgentMessages(session.sessionId, 20);
      return redactMemoryText(messages.filter((message) => message.role === "assistant" && Date.parse(message.createdAt) >= sinceMs).map((message) => message.content).join("\n")).slice(-12_000) ||
        "Chat task completed without textual output.";
    }
    return "Task completed with browser evidence only.";
  }

  async function sendToPane(input: {
    roomId: string;
    agentPaneId: string;
    paneId: string;
    instruction: string;
    actionId: string;
    bridge: SpaceAgentRoomActionBridgeRequest;
    traceId: string;
    evidence: Record<string, unknown>;
  }): Promise<Record<string, unknown>> {
    const pane = await paneInRoom(input.roomId, input.paneId, input.agentPaneId);
    if (pane.isClosed) throw new Error(`Pane ${pane.id} is closed; reopen it before sending work.`);
    await assertPaneRuntimeEnabled(pane);
    const startedAtMs = Date.now();
    if (pane.mode === "TERMINAL") {
      const session = await store.getActivePaneCliSession(pane.id);
      if (!session) throw new Error(`Pane ${pane.id} has no active CLI session.`);
      if (session.purpose !== "NORMAL") throw new Error(`Pane ${pane.id} is reserved for operator-managed CLI login.`);
      if (cliTerminalManager.getCurrentTurnActivity) {
        let current = await cliTerminalManager.getCurrentTurnActivity(session.sessionId);
        let reportedBusy = false;
        let lastProgressAtMs = Date.now();
        let lastTranscriptSequence = (await store.listPaneCliTranscriptChunks(session.sessionId, 1)).at(-1)?.sequence ?? -1;
        while (current.status === "RUNNING" && Date.now() - startedAtMs < actionTimeoutMs) {
          await assertActionCanContinue(input.bridge, input.actionId);
          if (!reportedBusy) {
            await store.updateRoomAgentAction(input.actionId, {
              statusReason: "Existing CLI turn is still running; waiting before submitting the next instruction."
            }, input.traceId);
            await reportProgress(
              input.bridge,
              `The pane «${pane.title}» is already running a task and keeps producing live output. I am watching it and will send the next step only when it completes.`,
              input.traceId
            );
            reportedBusy = true;
          }
          await delay(pollIntervalMs);
          current = await cliTerminalManager.getCurrentTurnActivity(session.sessionId);
          const transcriptSequence = (await store.listPaneCliTranscriptChunks(session.sessionId, 1)).at(-1)?.sequence ?? -1;
          if (transcriptSequence !== lastTranscriptSequence) {
            lastTranscriptSequence = transcriptSequence;
            lastProgressAtMs = Date.now();
          } else if (current.status === "RUNNING" && Date.now() - lastProgressAtMs >= cliExistingTurnStallMs) {
            await reportProgress(
              input.bridge,
              `The pane «${pane.title}» stopped producing output. I only send Esc, as the operator would, without restart or session/thread change.`,
              input.traceId
            );
            await sendCliEscape(session.sessionId, input.traceId, `${input.actionId}:escape-stalled`);
            const recoveryDeadline = Date.now() + cliEscapeRecoveryGraceMs;
            while (Date.now() < recoveryDeadline) {
              await delay(pollIntervalMs);
              current = await cliTerminalManager.getCurrentTurnActivity(session.sessionId);
              if (current.status !== "RUNNING") break;
            }
            if (current.status === "RUNNING") {
              await reportProgress(
                input.bridge,
                `BLOCKED: the pane «${pane.title}» remains stalled after Esc. I did not change task, session or thread; a manual operator decision is required.`,
                input.traceId
              );
              throw new Error("CLI task remains stalled after Escape; manual operator decision is required without changing its session or thread.");
            }
            lastProgressAtMs = Date.now();
          }
        }
        if (current.status === "RUNNING") {
          throw new Error("Existing CLI turn did not complete before the Room Agent action timeout.");
        }
        if (reportedBusy) {
          await reportProgress(
            input.bridge,
            `The active task in pane «${pane.title}» completed. I am now submitting the next scheduled step.`,
            input.traceId
          );
        }
      }
      let checkpoint = readCliSendCheckpoint(input.evidence);
      let createdIntent = false;
      if (checkpoint && checkpoint.paneId !== pane.id) {
        throw new Error("Persisted CLI send checkpoint does not match the requested pane.");
      }
      if (!checkpoint) {
        const marker = randomUUID();
        checkpoint = {
          phase: "INTENT",
          paneId: pane.id,
          sessionId: session.sessionId,
          marker,
          markerAtMs: Date.now(),
          turnId: null
        };
        await store.updateRoomAgentAction(input.actionId, {
          evidence: { cliSend: checkpoint },
          statusReason: "CLI send intent persisted before host acknowledgement."
        }, input.traceId);
        createdIntent = true;
      }
      if (checkpoint.phase === "INTENT" && !createdIntent) {
        const recoveryDeadlineMs = Math.min(
          startedAtMs + Math.min(actionTimeoutMs, cliSendRecoveryGraceMs),
          checkpoint.markerAtMs + cliSendRecoveryGraceMs
        );
        while (Date.now() < recoveryDeadlineMs) {
          await assertActionCanContinue(input.bridge, input.actionId);
          const activity = await cliTerminalManager.getTurnActivity(checkpoint.sessionId, checkpoint.marker, {
            markerAtMs: checkpoint.markerAtMs,
            turnId: checkpoint.turnId,
            inputMarker: checkpoint.marker
          });
          if (activity.status === "RUNNING" || activity.status === "COMPLETED") {
            checkpoint = { ...checkpoint, phase: "SENT", turnId: activity.turnId };
            await store.updateRoomAgentAction(input.actionId, {
              evidence: { cliSend: checkpoint },
              statusReason: "Recovered marker-matched CLI instruction; monitoring durable completion evidence."
            }, input.traceId);
            break;
          }
          await delay(pollIntervalMs);
        }
        if (checkpoint.phase === "INTENT") {
          const activity = await cliTerminalManager.getTurnActivity(checkpoint.sessionId, checkpoint.marker, {
            markerAtMs: checkpoint.markerAtMs,
            turnId: checkpoint.turnId,
            inputMarker: checkpoint.marker
          });
          if (activity.status === "RUNNING" || activity.status === "COMPLETED") {
            checkpoint = { ...checkpoint, phase: "SENT", turnId: activity.turnId };
            await store.updateRoomAgentAction(input.actionId, {
              evidence: { cliSend: checkpoint },
              statusReason: "Recovered marker-matched CLI instruction; monitoring durable completion evidence."
            }, input.traceId);
          }
        }
      }
      if (checkpoint.phase === "INTENT") {
        const markedInstruction = [
          input.instruction.trim(),
          "",
          `<space-room-action marker="${checkpoint.marker}">Internal recovery marker; ignore and do not mention.</space-room-action>`
        ].join("\n");
        const sent = await cliTerminalManager.sendInput(
          checkpoint.sessionId,
          markedInstruction,
          input.traceId,
          checkpoint.marker,
          input.actionId
        );
        checkpoint = {
          ...checkpoint,
          phase: "CONTENT",
          markerAtMs: sent.markerAtMs,
          turnId: checkpoint.turnId
        };
        await store.updateRoomAgentAction(input.actionId, {
          evidence: { cliSend: checkpoint },
          statusReason: "CLI instruction content accepted; submit is pending."
        }, input.traceId);
      }
      if (checkpoint.phase === "CONTENT") {
        await cliTerminalManager.sendInput(
          checkpoint.sessionId,
          "\r",
          input.traceId,
          null,
          `${input.actionId}:submit`
        );
        checkpoint = { ...checkpoint, phase: "SENT" };
        await store.updateRoomAgentAction(input.actionId, {
          evidence: { cliSend: checkpoint },
          statusReason: "CLI instruction submitted; monitoring durable completion evidence."
        }, input.traceId);
      }
      const persistTurnId = async (turnId: string) => {
        checkpoint = { ...checkpoint!, turnId };
        await store.updateRoomAgentAction(input.actionId, {
          evidence: { cliSend: checkpoint },
          statusReason: "CLI turn detected; monitoring durable completion evidence."
        }, input.traceId);
      };
      const completed = await waitForCli(
        checkpoint.sessionId,
        checkpoint.marker,
        checkpoint.markerAtMs,
        startedAtMs,
        checkpoint.turnId,
        persistTurnId,
        input.bridge,
        input.actionId,
        input.traceId
      );
      checkpoint = { ...checkpoint, turnId: completed.turnId };
      const firstOutput = (await store.listPaneCliTranscriptChunks(session.sessionId))
        .find((chunk) =>
          (chunk.stream === "stdout" || chunk.stream === "stderr") && Date.parse(chunk.createdAt) >= checkpoint!.markerAtMs
        );
      const firstResponseAt = firstOutput?.createdAt ?? null;
      return {
        cliSend: checkpoint,
        paneId: pane.id,
        mode: pane.mode,
        status: completed.status,
        firstResponseAt,
        firstResponseMs: firstResponseAt === null ? null : Math.max(0, Date.parse(firstResponseAt) - checkpoint.markerAtMs)
      };
    }
    if (pane.mode === "CHAT") {
      await spaceAgentAdapter.sendMessage({ pane, content: input.instruction, traceId: input.traceId });
      await waitForChat(pane, startedAtMs, input.bridge, input.actionId);
      const session = await store.getActiveSpaceAgentSession(pane.id);
      const firstResponse = session
        ? (await store.listSpaceAgentMessages(session.sessionId, 500))
            .find((message) => message.role === "assistant" && Date.parse(message.createdAt) >= startedAtMs)
        : null;
      const firstResponseAt = firstResponse?.createdAt ?? null;
      return {
        paneId: pane.id,
        mode: pane.mode,
        status: "COMPLETED",
        firstResponseAt,
        firstResponseMs: firstResponseAt === null ? null : Math.max(0, Date.parse(firstResponseAt) - startedAtMs)
      };
    }
    throw new Error(`Browser pane ${pane.id} must be controlled with the selected browser tools.`);
  }

  async function interruptPane(roomId: string, agentPaneId: string, paneId: string, reason: string, traceId: string) {
    const pane = await paneInRoom(roomId, paneId, agentPaneId);
    if (pane.mode === "TERMINAL") {
      const session = await store.getActivePaneCliSession(pane.id);
      if (!session) return { paneId: pane.id, interrupted: false };
      if (session.purpose !== "NORMAL") throw new Error(`Pane ${pane.id} is reserved for operator-managed CLI login.`);
      return {
        paneId: pane.id,
        reason,
        ...(await sendCliEscape(session.sessionId, traceId, `${traceId}:escape:${pane.id}`))
      };
    }
    if (pane.mode === "CHAT") {
      await spaceAgentAdapter.interrupt({ pane, reason });
      return { paneId: pane.id, interrupted: true };
    }
    await browserSessionManager.stopPane(pane.id, traceId);
    return { paneId: pane.id, interrupted: true };
  }

  async function restartPane(roomId: string, agentPaneId: string, paneId: string, traceId: string) {
    const pane = await paneInRoom(roomId, paneId, agentPaneId);
    if (pane.mode === "TERMINAL") {
      throw new Error("Room Agent cannot restart CLI panes; use Escape and a text prompt in the existing task.");
    }
    if (pane.mode === "CHAT") {
      await spaceAgentAdapter.interrupt({ pane, reason: "Restarted by Room Agent." });
      const session = await spaceAgentAdapter.createOrRestoreSession({ pane, sessionId: null, title: pane.title });
      return { paneId: pane.id, sessionId: session.binding.sessionId };
    }
    await browserSessionManager.stopPane(pane.id, traceId);
    const response = await browserSessionManager.startOrRestore({ pane, traceId });
    return { paneId: pane.id, sessionId: response.session.sessionId };
  }

  async function perform(
    bridge: SpaceAgentRoomActionBridgeRequest,
    request: SpaceAgentRoomActionRequest,
    actionId: string,
    traceId: string,
    index: string,
    evidence: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    await assertActionCanContinue(bridge, actionId);
    switch (request.action.type) {
      case "inspect": {
        const candidates = await store.listPanes(bridge.roomId, true);
        const visiblePanes = (await Promise.all(candidates.map(async (pane) => ({
          pane,
          visible: pane.id !== bridge.agentPaneId && await paneRuntimeEnabled(pane)
        })))).filter((candidate) => candidate.visible).map((candidate) => candidate.pane);
        const panes = await Promise.all(
          visiblePanes
            .map(async (pane) => {
              const summary: Record<string, unknown> = {
                id: pane.id,
                title: pane.title,
                mode: pane.mode,
                status: pane.status,
                isClosed: pane.isClosed,
                updatedAt: pane.updatedAt
              };
              if (pane.mode === "TERMINAL") {
                const session = await store.getActivePaneCliSession(pane.id);
                if (session?.purpose === "NORMAL") {
                  const transcript = await store.listPaneCliTranscriptChunks(session.sessionId);
                  summary.cli = {
                    session,
                    transcript: transcript.slice(-inspectTailLimit),
                    totalCount: transcript.length,
                    truncated: transcript.length > inspectTailLimit
                  };
                } else {
                  summary.cli = { session: null, transcript: [], totalCount: 0, truncated: false };
                }
              } else if (pane.mode === "CHAT") {
                const session = await store.getActiveSpaceAgentSession(pane.id);
                const latestRun = session ? await store.getLatestSpaceAgentRun(session.sessionId) : null;
                const runStatus = latestRun?.status === "QUEUED" || latestRun?.status === "RUNNING"
                  ? latestRun.status
                  : latestRun?.status === "FAILED" || session?.status === "ERROR"
                    ? "ERROR"
                    : session?.status === "BLOCKED"
                    ? "BLOCKED"
                      : "IDLE";
                const [messages, totalCount] = session
                  ? await Promise.all([
                      store.listSpaceAgentMessages(session.sessionId, inspectTailLimit),
                      store.countSpaceAgentMessages(session.sessionId)
                    ])
                  : [[], 0];
                summary.chat = {
                  session: session
                    ? {
                        sessionId: session.sessionId,
                        threadId: session.threadId,
                        status: session.status,
                        updatedAt: session.updatedAt
                      }
                    : null,
                  runStatus,
                  statusReason: latestRun?.errorMessage ?? (session ? `Chat session is ${runStatus.toLowerCase()}.` : "No active chat session."),
                  messages,
                  totalCount,
                  truncated: totalCount > messages.length
                };
              }
              return summary;
            })
        );
        return {
          panes,
          ...(roomPlanInventoryProvider ? { roomInventory: await roomPlanInventoryProvider.inspect(bridge.roomId) } : {})
        };
      }
      case "send":
        return sendToPane({
          roomId: bridge.roomId,
          agentPaneId: bridge.agentPaneId,
          paneId: request.action.paneId,
          instruction: request.action.input,
          actionId,
          bridge,
          traceId,
          evidence
        });
      case "orchestrate": {
        type PreparedPaneEvidence = {
          paneKey: string; paneId: string; title: string; mode: "TERMINAL" | "CHAT";
          modelId: string; reasoningEffort: string; status: "PREPARING" | "READY";
        };
        const preparedPanes = new Map<string, PreparedPaneEvidence>();
        for (const candidate of Array.isArray(evidence.preparedPanes) ? evidence.preparedPanes : []) {
          if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
          const record = candidate as Record<string, unknown>;
          if ((record.status === "PREPARING" || record.status === "READY") && typeof record.paneKey === "string" && typeof record.paneId === "string") {
            preparedPanes.set(record.paneKey, record as PreparedPaneEvidence);
          }
        }
        const missing = request.action.preparePanes.filter((pane) => !preparedPanes.has(pane.paneKey));
        const pendingReadiness = request.action.preparePanes.filter((pane) => preparedPanes.get(pane.paneKey)?.status !== "READY");
        if (pendingReadiness.length) {
          const chatPanes = pendingReadiness.filter((pane) => pane.mode === "CHAT");
          const [room, allPanes, models] = await Promise.all([
            store.getRoom(bridge.roomId),
            store.listPanes(bridge.roomId, true),
            chatPanes.length ? store.listModels() : Promise.resolve([])
          ]);
          const openPaneCount = allPanes.filter((pane) => !pane.isClosed).length;
          if (openPaneCount + missing.length > room.paneCap) {
            throw new Error(
              `Pane capacity exceeded: ${openPaneCount} panes are open, ${missing.length} more were requested, and the room cap is ${room.paneCap}.`
            );
          }
          const modelIds = new Set(models.filter((model) => model.status === "VERIFIED").map((model) => model.id));
          for (const pane of chatPanes) {
            if (!modelIds.has(pane.modelId)) throw new Error(`Model ${pane.modelId} is not available.`);
          }
          const terminalPanes = pendingReadiness.filter((pane) => pane.mode === "TERMINAL");
          if (terminalPanes.length) {
            if (!cliTerminalManager.listRuntimes) throw new Error("CLI runtime preflight is unavailable for prepared panes.");
            const registry = await cliTerminalManager.listRuntimes();
            const runtimes = new Map(registry.data.map((runtime) => [runtime.id, runtime]));
            for (const pane of terminalPanes) {
              const runtimeId = pane.terminalRuntimeId ?? "cli:codex";
              await options.assertCliRuntimeEnabled?.(runtimeId);
              const runtime = runtimes.get(runtimeId);
              if (!runtime || !isCliRuntimeTerminalLaunchable(runtime) || !runtime.capabilities.includes("CLI") || !runtime.detectedCommandPath) {
                throw new Error(`CLI runtime ${runtimeId} is not available.`);
              }
              if (runtime.supportedReasoningEfforts.length && !runtime.supportedReasoningEfforts.includes(pane.reasoningEffort)) {
                throw new Error(`CLI runtime ${runtimeId} does not support reasoning effort ${pane.reasoningEffort}.`);
              }
            }
          }
          await reportProgress(bridge, `Execution plan validated. Preparing ${pendingReadiness.length} pane(s) before assigning work.`, traceId);
          for (const specification of pendingReadiness) {
            const checkpoint = preparedPanes.get(specification.paneKey);
            let pane = checkpoint
              ? await paneInRoom(bridge.roomId, checkpoint.paneId, bridge.agentPaneId)
              : null;
            if (!pane) {
              if (specification.mode === "TERMINAL") {
                await options.assertCliRuntimeEnabled?.(specification.terminalRuntimeId ?? "cli:codex");
              }
              const created = await store.createPane({
                roomId: bridge.roomId,
                title: specification.title,
                mode: specification.mode,
                modelId: specification.modelId,
                terminalRuntimeId: specification.terminalRuntimeId ?? null
              }, traceId);
              pane = await store.updatePane(created.id, { reasoningEffort: specification.reasoningEffort }, traceId);
              preparedPanes.set(specification.paneKey, {
                paneKey: specification.paneKey, paneId: pane.id, title: pane.title, mode: specification.mode,
                modelId: specification.modelId, reasoningEffort: specification.reasoningEffort, status: "PREPARING"
              });
              await store.updateRoomAgentAction(actionId, {
                evidence: { ...evidence, preparedPanes: [...preparedPanes.values()] },
                statusReason: `Prepared pane ${specification.paneKey} was allocated and is becoming ready.`
              }, traceId);
            }
            if (pane.mode === "TERMINAL") {
              await assertPaneRuntimeEnabled(pane);
              if (!cliTerminalManager.ensurePaneControlReady) throw new Error("CLI terminal control is unavailable for a prepared pane.");
              await cliTerminalManager.ensurePaneControlReady(pane, traceId);
            } else {
              const chatSession = await spaceAgentAdapter.createOrRestoreSession({
                pane,
                selectedModelConfigId: `${specification.modelId}:${specification.reasoningEffort}`
              });
              if (chatSession.runStatus === "BLOCKED" || chatSession.runStatus === "ERROR") {
                throw new Error(`Chat pane ${pane.title} is not ready: ${chatSession.statusReason}`);
              }
            }
            preparedPanes.set(specification.paneKey, {
              paneKey: specification.paneKey, paneId: pane.id, title: pane.title, mode: specification.mode,
              modelId: specification.modelId, reasoningEffort: specification.reasoningEffort, status: "READY"
            });
            await store.updateRoomAgentAction(actionId, {
              evidence: { ...evidence, preparedPanes: [...preparedPanes.values()] },
              statusReason: `Prepared pane ${specification.paneKey} is ready.`
            }, traceId);
            await reportProgress(bridge, `Pane «${pane.title}» is ready as ${specification.paneKey}, model ${specification.modelId}, reasoning ${specification.reasoningEffort}.`, traceId);
          }
        }
        const normalized = request.action.steps.map((step, stepIndex) => ({
          ...step,
          paneId: step.paneId ?? preparedPanes.get(step.paneKey ?? "")?.paneId ?? "",
          stepId: step.stepId ?? `step-${stepIndex + 1}`,
          dependsOn: [...step.dependsOn]
        }));
        const previousForPane = new Map<string, string>();
        for (const step of normalized) {
          const previous = previousForPane.get(step.paneId);
          if (previous && !step.dependsOn.includes(previous)) step.dependsOn.push(previous);
          previousForPane.set(step.paneId, step.stepId);
        }
        type StepEvidence = {
          stepId: string;
          paneId: string;
          label: string;
          dependsOn: string[];
          status: "EXECUTED";
          recovered: boolean;
          retryCount: number;
          restartCount: number;
          stallCount: number;
          durationMs: number;
          queueMs: number;
          firstResponseMs: number | null;
          completedAt: string;
          modelId: string | null;
          reasoningEffort: string | null;
          verificationSummary: string;
          score: number;
          scoreBreakdown: ReturnType<typeof roomAgentExecutionScore>["breakdown"];
        };
        const persistedSteps = Array.isArray(evidence.steps) ? evidence.steps : [];
        const completed = new Map<string, StepEvidence>();
        for (const candidate of persistedSteps) {
          if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
          const record = candidate as Record<string, unknown>;
          if (record.status === "EXECUTED" && typeof record.stepId === "string") {
            completed.set(record.stepId, record as StepEvidence);
          }
        }
        const failed = new Map<string, Error>();
        const active = new Map<string, Promise<{ stepId: string; result?: StepEvidence; error?: Error }>>();
        let peakConcurrency = typeof evidence.peakConcurrency === "number" ? evidence.peakConcurrency : 0;
        const orchestrationStartedAtMs = Date.now();
        const taskRuntimeSettings = async (pane: Pane) => {
          if (pane.mode === "TERMINAL") {
            const session = await store.getActivePaneCliSession(pane.id);
            const sessionReasoningEffort = reasoningEffortSchema.safeParse(session?.reasoningEffort).data;
            return {
              modelId: session?.modelId ?? pane.modelId,
              reasoningEffort: sessionReasoningEffort ?? pane.reasoningEffort
            };
          }
          if (pane.mode === "CHAT") {
            const session = await store.getActiveSpaceAgentSession(pane.id);
            const selectedReasoningEffort = reasoningEffortSchema.safeParse(session?.selectedReasoningKey).data;
            return {
              modelId: session?.selectedModelId ?? pane.modelId,
              reasoningEffort: selectedReasoningEffort ?? pane.reasoningEffort
            };
          }
          return { modelId: pane.modelId, reasoningEffort: pane.reasoningEffort };
        };

        for (const step of normalized) {
          if (completed.has(step.stepId) || await store.getRoomAgentTaskRun(bridge.missionId, step.stepId)) continue;
          const pane = await paneInRoom(bridge.roomId, step.paneId, bridge.agentPaneId);
          const runtimeSettings = await taskRuntimeSettings(pane);
          await store.upsertRoomAgentTaskRun({
            runId: makeSpaceId("room_agent_task_run"),
            missionId: bridge.missionId,
            roomId: bridge.roomId,
            stepId: step.stepId,
            paneId: pane.id,
            label: step.label ?? pane.title,
            instruction: step.instruction,
            status: "QUEUED",
            state: "RUNNING",
            modelId: runtimeSettings.modelId,
            reasoningEffort: runtimeSettings.reasoningEffort,
            qualityScore: null,
            qualityUnavailableReason: "Evaluation pending.",
            reliabilityScore: 0,
            combinedScore: null,
            rubric: null,
            queueMs: 0,
            firstResponseMs: null,
            executionMs: 0,
            totalMs: 0,
            retries: 0,
            recoveries: 0,
            stalls: 0,
            queuedAt: nowIso(),
            startedAt: null,
            firstResponseAt: null,
            completedAt: null,
            verificationSummary: step.dependsOn.length
              ? `Task is queued behind dependencies: ${step.dependsOn.join(", ")}.`
              : "Task is queued and ready to start."
          }, traceId);
          if (step.dependsOn.length) {
            await reportProgress(
              bridge,
              `«${step.label ?? pane.title}» is waiting for dependencies: ${step.dependsOn.join(", ")}.`,
              traceId
            );
          }
        }

        const runStep = async (step: (typeof normalized)[number]): Promise<StepEvidence> => {
          const startedAtMs = Date.now();
          const pane = await paneInRoom(bridge.roomId, step.paneId, bridge.agentPaneId);
          const runtimeSettings = await taskRuntimeSettings(pane);
          const existingRun = await store.getRoomAgentTaskRun(bridge.missionId, step.stepId);
          const queuedAt = existingRun?.queuedAt ?? nowIso();
          const startedAt = existingRun?.startedAt ?? nowIso();
          const runId = existingRun?.runId ?? makeSpaceId("room_agent_task_run");
          await store.upsertRoomAgentTaskRun({
            runId,
            missionId: bridge.missionId,
            roomId: bridge.roomId,
            stepId: step.stepId,
            paneId: pane.id,
            label: step.label ?? pane.title,
            instruction: step.instruction,
            status: "RUNNING",
            state: "RUNNING",
            modelId: runtimeSettings.modelId,
            reasoningEffort: runtimeSettings.reasoningEffort,
            qualityScore: null,
            qualityUnavailableReason: "Evaluation pending.",
            reliabilityScore: existingRun?.reliabilityScore ?? 0,
            combinedScore: null,
            rubric: null,
            queueMs: Math.max(0, Date.parse(startedAt) - Date.parse(queuedAt)),
            firstResponseMs: existingRun?.firstResponseMs ?? null,
            executionMs: existingRun?.executionMs ?? 0,
            totalMs: existingRun?.totalMs ?? 0,
            retries: existingRun?.retries ?? 0,
            recoveries: existingRun?.recoveries ?? 0,
            stalls: existingRun?.stalls ?? 0,
            queuedAt,
            startedAt,
            firstResponseAt: existingRun?.firstResponseAt ?? null,
            completedAt: null,
            verificationSummary: "Task is running and awaiting durable completion evidence."
          }, traceId);
          await reportProgress(
            bridge,
            `Starting «${step.label ?? pane.title}» on ${pane.title}, model ${runtimeSettings.modelId ?? "runtime default"}, reasoning ${runtimeSettings.reasoningEffort}.`,
            traceId
          );
          let retryCount = 0;
          const restartCount = 0;
          let stallCount = 0;
          try {
            for (;;) {
            const subrequest = {
              toolId: "room:send" as const,
              action: { type: "send" as const, paneId: step.paneId, input: step.instruction }
            };
            const result = await executeOne(bridge, subrequest, traceId, `${index}.${step.stepId}.attempt-${retryCount}`);
            if (result.status === "EXECUTED") {
              const scoring = roomAgentExecutionScore({ verified: true, retryCount, restartCount, stallCount });
              const completedAt = nowIso();
              const firstResponseMs = typeof result.evidence.firstResponseMs === "number"
                ? Math.max(0, Math.trunc(result.evidence.firstResponseMs))
                : null;
              const firstResponseAt = typeof result.evidence.firstResponseAt === "string"
                ? result.evidence.firstResponseAt
                : null;
              const stepEvidence: StepEvidence = {
                stepId: step.stepId,
                paneId: step.paneId,
                label: step.label ?? step.paneId,
                dependsOn: step.dependsOn,
                status: "EXECUTED",
                recovered: restartCount > 0,
                retryCount,
                restartCount,
                stallCount,
                durationMs: Math.max(0, Date.now() - startedAtMs),
                queueMs: Math.max(0, startedAtMs - orchestrationStartedAtMs),
                firstResponseMs,
                completedAt,
                modelId: runtimeSettings.modelId,
                reasoningEffort: runtimeSettings.reasoningEffort,
                verificationSummary: "Pane supplied durable verified completion evidence.",
                score: scoring.score,
                scoreBreakdown: scoring.breakdown
              };
              await reportProgress(bridge, `Verifying quality for «${stepEvidence.label}» with the isolated tool-free evaluator.`, traceId);
              await store.upsertRoomAgentTaskRun({
                runId,
                missionId: bridge.missionId,
                roomId: bridge.roomId,
                stepId: step.stepId,
                paneId: pane.id,
                label: stepEvidence.label,
                instruction: step.instruction,
                status: "VERIFYING",
                state: "VERIFYING",
                modelId: runtimeSettings.modelId,
                reasoningEffort: runtimeSettings.reasoningEffort,
                qualityScore: null,
                qualityUnavailableReason: "Evaluation in progress.",
                reliabilityScore: scoring.score,
                combinedScore: null,
                rubric: null,
                queueMs: stepEvidence.queueMs,
                firstResponseMs: stepEvidence.firstResponseMs,
                executionMs: stepEvidence.durationMs,
                totalMs: stepEvidence.queueMs + stepEvidence.durationMs,
                retries: retryCount,
                recoveries: retryCount > 0 ? 1 : 0,
                stalls: stallCount,
                queuedAt,
                startedAt,
                firstResponseAt,
                completedAt: null,
                verificationSummary: "Pane supplied durable completion evidence; isolated quality evaluation is running."
              }, traceId);
              const evaluation = await taskEvaluator.evaluate({
                instruction: redactMemoryText(step.instruction),
                finalResult: await finalPaneResult(pane, Date.parse(startedAt)),
                completionEvidence: redactMemoryText(JSON.stringify(result.evidence)).slice(0, 12_000)
              });
              const qualityScore = evaluation.available ? evaluation.qualityScore : null;
              const combinedScore = qualityScore === null ? null : qualityScore * 0.7 + scoring.score * 0.3;
              const state = combinedScore !== null && combinedScore < 70 ? "LOW_QUALITY" as const : "COMPLETED" as const;
              await store.upsertRoomAgentTaskRun({
                runId,
                missionId: bridge.missionId,
                roomId: bridge.roomId,
                stepId: step.stepId,
                paneId: pane.id,
                label: stepEvidence.label,
                instruction: step.instruction,
                status: state,
                state,
                modelId: runtimeSettings.modelId,
                reasoningEffort: runtimeSettings.reasoningEffort,
                qualityScore,
                qualityUnavailableReason: evaluation.available ? null : evaluation.reason,
                reliabilityScore: scoring.score,
                combinedScore,
                rubric: evaluation.available ? evaluation.rubric : null,
                queueMs: stepEvidence.queueMs,
                firstResponseMs: stepEvidence.firstResponseMs,
                executionMs: stepEvidence.durationMs,
                totalMs: stepEvidence.queueMs + stepEvidence.durationMs,
                retries: retryCount,
                recoveries: retryCount > 0 ? 1 : 0,
                stalls: stallCount,
                queuedAt,
                startedAt,
                firstResponseAt,
                completedAt,
                verificationSummary: evaluation.available
                  ? `${stepEvidence.verificationSummary} ${evaluation.summary}`
                  : `${stepEvidence.verificationSummary} Quality unavailable after ${evaluation.attempts} evaluator attempt(s).`
              }, traceId);
              if (state === "LOW_QUALITY") {
                await reportProgress(bridge, `LOW QUALITY: «${stepEvidence.label}» scored ${combinedScore?.toFixed(1)}/100; verified completion remains authoritative.`, traceId);
              }
              return stepEvidence;
            }
            const failureCode = typeof result.evidence.failureCode === "string" ? result.evidence.failureCode : null;
            if (!failureCode?.startsWith("CLI_TURN_")) {
              throw new Error(`Orchestration stopped at pane ${step.paneId}: ${result.statusReason}`);
            }
            retryCount += 1;
            if (failureCode === "CLI_TURN_UNAVAILABLE") stallCount += 1;
            if (retryCount > 1) {
              await reportProgress(
                bridge,
                `BLOCKED: the plan «${step.label ?? step.paneId}» failed even after the single Esc recovery. I did not change task, session or thread; a manual operator decision is required.`,
                traceId
              );
              throw new Error(`Orchestration blocked at pane ${step.paneId}; manual operator decision is required.`);
            }
            await reportProgress(
              bridge,
              `The pane «${step.label ?? step.paneId}» needs recovery. I send Esc and repeat the same prompt in the same task/session/thread.`,
              traceId
            );
            const escapeRequest = {
              toolId: "room:interrupt" as const,
              action: { type: "interrupt" as const, paneId: step.paneId, reason: "Room Agent same-task Escape recovery." }
            };
            const escaped = await executeOne(
              bridge,
              escapeRequest,
              traceId,
              `${index}.${step.stepId}.escape-recovery`
            );
            if (escaped.status !== "EXECUTED") {
              throw new Error(`Orchestration Escape recovery failed at pane ${step.paneId}: ${escaped.statusReason}`);
            }
            await reportProgress(
              bridge,
              `Esc was sent to the pane «${step.label ?? step.paneId}». I am now repeating the same prompt in the same task and continuing to monitor.`,
              traceId
            );
            }
          } catch (error) {
            const completedAt = nowIso();
            const executionMs = Math.max(0, Date.now() - startedAtMs);
            const reason = redactMemoryText(error instanceof Error ? error.message : "Task execution was blocked.").slice(0, 1000);
            await store.upsertRoomAgentTaskRun({
              runId,
              missionId: bridge.missionId,
              roomId: bridge.roomId,
              stepId: step.stepId,
              paneId: pane.id,
              label: step.label ?? pane.title,
              instruction: step.instruction,
              status: "BLOCKED",
              state: "BLOCKED",
              modelId: runtimeSettings.modelId,
              reasoningEffort: runtimeSettings.reasoningEffort,
              qualityScore: null,
              qualityUnavailableReason: "Task did not reach verified completion.",
              reliabilityScore: 0,
              combinedScore: null,
              rubric: null,
              queueMs: Math.max(0, Date.parse(startedAt) - Date.parse(queuedAt)),
              firstResponseMs: null,
              executionMs,
              totalMs: Math.max(0, Date.parse(completedAt) - Date.parse(queuedAt)),
              retries: retryCount,
              recoveries: retryCount > 0 ? 1 : 0,
              stalls: stallCount,
              queuedAt,
              startedAt,
              firstResponseAt: null,
              completedAt,
              verificationSummary: reason
            }, traceId);
            throw error;
          }
        };

        const startReadySteps = () => {
          for (const step of normalized) {
            if (completed.has(step.stepId) || failed.has(step.stepId) || active.has(step.stepId)) continue;
            if (step.dependsOn.some((dependency) => failed.has(dependency))) {
              failed.set(step.stepId, new Error(`Dependency failed for step ${step.stepId}.`));
              continue;
            }
            if (!step.dependsOn.every((dependency) => completed.has(dependency))) continue;
            const promise = runStep(step)
              .then((result) => ({ stepId: step.stepId, result }))
              .catch((error: unknown) => ({
                stepId: step.stepId,
                error: error instanceof Error ? error : new Error("Room orchestration step failed.")
              }));
            active.set(step.stepId, promise);
          }
          peakConcurrency = Math.max(peakConcurrency, active.size);
        };

        await reportProgress(
          bridge,
          `I found ${normalized.length} plans. ${request.action.analysisSummary ?? "I start all independent ones together and keep dependencies waiting."}`,
          traceId
        );
        startReadySteps();
        while (active.size > 0) {
          const settled = await Promise.race(active.values());
          active.delete(settled.stepId);
          if (settled.result) completed.set(settled.stepId, settled.result);
          if (settled.error) failed.set(settled.stepId, settled.error);
          startReadySteps();
          const orderedSteps = normalized.flatMap((step) => {
            const result = completed.get(step.stepId);
            return result ? [result] : [];
          });
          const snapshot = {
            strategy: request.action.strategy,
            analysisSummary: request.action.analysisSummary ?? null,
            peakConcurrency,
            preparedPanes: [...preparedPanes.values()],
            steps: orderedSteps
          };
          await store.updateRoomAgentAction(actionId, {
            evidence: snapshot,
            statusReason: `${orderedSteps.length} of ${normalized.length} room plans completed with evidence.`
          }, traceId);
          if (settled.result) {
            await reportProgress(
              bridge,
              `Plan «${settled.result.label}» completed in ${settled.result.durationMs} ms with score ${settled.result.score}/100. ` +
                `${active.size} plan(s) are already running and ${normalized.length - completed.size - failed.size - active.size} are waiting on dependencies.`,
              traceId
            );
          }
        }
        if (failed.size > 0) {
          for (const [stepId, error] of failed) {
            const run = await store.getRoomAgentTaskRun(bridge.missionId, stepId);
            if (!run || run.status === "BLOCKED") continue;
            const { updatedAt: _updatedAt, ...persisted } = run;
            const completedAt = nowIso();
            await store.upsertRoomAgentTaskRun({
              ...persisted,
              status: "BLOCKED",
              state: "BLOCKED",
              qualityUnavailableReason: "Task did not reach verified completion.",
              completedAt,
              totalMs: Math.max(0, Date.parse(completedAt) - Date.parse(run.queuedAt)),
              verificationSummary: redactMemoryText(error.message).slice(0, 1000)
            }, traceId);
          }
          const first = failed.values().next().value as Error | undefined;
          throw first ?? new Error("Room orchestration stopped because one or more plans were blocked.");
        }
        const steps = normalized.map((step) => completed.get(step.stepId)!);
        await reportProgress(
          bridge,
          `All ${steps.length} plans completed with verified evidence. I am now doing the final mission check.`,
          traceId
        );
        return {
          strategy: request.action.strategy,
          analysisSummary: request.action.analysisSummary ?? null,
          peakConcurrency,
          preparedPanes: [...preparedPanes.values()],
          steps
        };
      }
      case "interrupt":
        return interruptPane(bridge.roomId, bridge.agentPaneId, request.action.paneId, request.action.reason, traceId);
      case "restart":
        return restartPane(bridge.roomId, bridge.agentPaneId, request.action.paneId, traceId);
      case "create_pane": {
        if (request.action.mode === "TERMINAL") {
          await options.assertCliRuntimeEnabled?.(request.action.terminalRuntimeId ?? "cli:codex");
        }
        const pane = await store.createPane({
          roomId: bridge.roomId,
          title: request.action.title,
          mode: request.action.mode,
          terminalRuntimeId: request.action.terminalRuntimeId ?? null
        }, traceId);
        if (pane.mode !== "TERMINAL") return { paneId: pane.id, mode: pane.mode };
        await assertPaneRuntimeEnabled(pane);
        if (!cliTerminalManager.ensurePaneControlReady) {
          throw new Error("CLI terminal control is unavailable for the newly created pane.");
        }
        const session = await cliTerminalManager.ensurePaneControlReady(pane, traceId);
        return {
          paneId: pane.id,
          mode: pane.mode,
          cliSession: {
            sessionId: session.sessionId,
            runtimeId: session.runtimeId,
            status: session.status,
            statusReason: session.statusReason,
            cwd: session.cwd
          }
        };
      }
      case "close_pane": {
        const pane = await paneInRoom(bridge.roomId, request.action.paneId, bridge.agentPaneId);
        if (pane.mode === "TERMINAL") {
          throw new Error("Room Agent cannot close CLI panes because that would alter the user task structure.");
        }
        await interruptPane(bridge.roomId, bridge.agentPaneId, pane.id, "Soft-closed by Room Agent.", traceId);
        const closed = await store.updatePane(pane.id, { isClosed: true, status: "CLOSED" }, traceId);
        return { paneId: closed.id, isClosed: closed.isClosed };
      }
      case "reopen_pane": {
        const pane = await paneInRoom(bridge.roomId, request.action.paneId, bridge.agentPaneId);
        await assertPaneRuntimeEnabled(pane);
        const reopened = await store.updatePane(pane.id, { isClosed: false, status: "IDLE" }, traceId);
        return { paneId: reopened.id, isClosed: reopened.isClosed };
      }
    }
  }

  async function executeOne(
    bridge: SpaceAgentRoomActionBridgeRequest,
    request: SpaceAgentRoomActionRequest,
    traceId: string,
    index: string
  ): Promise<SpaceAgentRoomActionBridgeResult> {
    await assertMissionRunning(bridge);
    const key = idempotencyKey(
      bridge.missionId,
      index,
      request,
      request.action.type === "inspect" ? traceId : null
    );
    const existing = (await store.listRoomAgentActions(bridge.missionId)).find((action) => action.idempotencyKey === key);
    if (existing?.status === "COMPLETED") {
      return {
        request,
        status: "EXECUTED",
        statusReason: existing.statusReason,
        paneId: existing.paneId,
        missionId: bridge.missionId,
        evidence: existing.evidence
      };
    }
    if (existing && (existing.status === "FAILED" || existing.status === "BLOCKED")) {
      return {
        request,
        status: existing.status === "BLOCKED" ? "BLOCKED" : "FAILED",
        statusReason: existing.statusReason,
        paneId: existing.paneId,
        missionId: bridge.missionId,
        evidence: existing.evidence
      };
    }
    const action = existing ?? await store.createRoomAgentAction({
      actionId: makeSpaceId("room_agent_action"),
      missionId: bridge.missionId,
      roomId: bridge.roomId,
      paneId: actionPaneId(request),
      idempotencyKey: key,
      actionType: actionType(request),
      status: "QUEUED",
      requestPayload: request,
      evidence: {},
      attemptCount: 0,
      statusReason: "Room action queued."
    }, traceId);
    try {
      await assertMissionRunning(bridge);
      await store.updateRoomAgentAction(action.actionId, {
        status: "RUNNING",
        attemptCount: Math.min(3, action.attemptCount + 1),
        statusReason: "Room action is running."
      }, traceId);
      await assertActionCanContinue(bridge, action.actionId);
      const evidence = await perform(bridge, request, action.actionId, traceId, index, action.evidence);
      await assertActionCanContinue(bridge, action.actionId);
      const completed = await store.updateRoomAgentAction(action.actionId, {
        status: "COMPLETED",
        evidence,
        statusReason: "Room action completed with evidence.",
        completedAt: nowIso()
      }, traceId);
      return {
        request,
        status: "EXECUTED",
        statusReason: completed.statusReason,
        paneId: completed.paneId,
        missionId: bridge.missionId,
        evidence: completed.evidence
      };
    } catch (error) {
      const stopped = await actionInMission(bridge.missionId, action.actionId);
      if (stopped?.status === "BLOCKED") {
        return {
          request,
          status: "BLOCKED",
          statusReason: stopped.statusReason,
          paneId: stopped.paneId,
          missionId: bridge.missionId,
          evidence: stopped.evidence
        };
      }
      const mission = await missionInRoom(bridge.roomId, bridge.missionId);
      if (!mission || mission.status !== "RUNNING") {
        const reason = mission?.statusReason ?? "Room Agent mission is no longer available.";
        const blocked = await store.updateRoomAgentAction(action.actionId, {
          status: "BLOCKED",
          statusReason: reason,
          completedAt: nowIso()
        }, traceId);
        return {
          request,
          status: "BLOCKED",
          statusReason: blocked.statusReason,
          paneId: blocked.paneId,
          missionId: bridge.missionId,
          evidence: blocked.evidence
        };
      }
      const reason = redactMemoryText(error instanceof Error ? error.message : "Room action failed.").slice(0, 1000);
      const databaseErrorCode = error && typeof error === "object" && "code" in error
        ? (error as { code?: unknown }).code
        : null;
      const featureErrorCode = error && typeof error === "object" && "errorCode" in error
        ? (error as { errorCode?: unknown }).errorCode
        : null;
      const latestEvidence = stopped?.evidence ?? action.evidence;
      const failureEvidence = error instanceof RecoverableCliTurnError
        ? { ...latestEvidence, failureCode: error.code }
        : featureErrorCode === "CLI_RUNTIME_DISABLED"
          ? { ...latestEvidence, failureCode: "CLI_RUNTIME_DISABLED" }
          : databaseErrorCode === "40P01"
          ? { ...latestEvidence, failureCode: "DATABASE_DEADLOCK" }
          : latestEvidence;
      const failed = await store.updateRoomAgentAction(action.actionId, {
        status: "FAILED",
        evidence: failureEvidence,
        statusReason: reason,
        completedAt: nowIso()
      }, traceId);
      return {
        request,
        status: "FAILED",
        statusReason: failed.statusReason,
        paneId: failed.paneId,
        missionId: bridge.missionId,
        evidence: failed.evidence
      };
    }
  }

  async function execute(bridge: SpaceAgentRoomActionBridgeRequest, traceId: string) {
    await assertMissionRunning(bridge);
    const results = [];
    for (let index = 0; index < bridge.actions.length; index += 1) {
      results.push(await executeOne(bridge, bridge.actions[index]!, traceId, String(index)));
    }
    return spaceAgentRoomActionBridgeResponseSchema.parse({ id: "space-agent-room-action-bridge", results });
  }

  async function stopMission(roomId: string, reason: string, traceId: string) {
    const mission = (await store.listRoomAgentMissions(roomId)).find(
      (candidate) => candidate.status === "RUNNING" || candidate.status === "PAUSED"
    ) ?? null;
    if (!mission) return { missionId: null, interruptedPaneIds: [] as string[] };
    await store.updateRoomAgentMission(mission.id, {
      status: "INTERRUPTED",
      statusReason: reason,
      completedAt: nowIso()
    }, traceId);
    const actions = (await store.listRoomAgentActions(mission.id)).filter(
      (action) => action.status === "QUEUED" || action.status === "RUNNING"
    );
    const paneIds = Array.from(new Set(actions.flatMap((action) => (action.paneId ? [action.paneId] : []))));
    await Promise.all(
      actions.map((action) =>
        store.updateRoomAgentAction(action.actionId, {
          status: "BLOCKED",
          statusReason: reason,
          completedAt: nowIso()
        }, traceId)
      )
    );
    const agentPane = await store.getOrCreateRoomAgentPane(roomId, traceId);
    await Promise.all(
      paneIds.map((paneId) => interruptPane(roomId, agentPane.id, paneId, reason, traceId))
    );
    return { missionId: mission.id, interruptedPaneIds: paneIds };
  }

  async function pauseMission(roomId: string, reason: string, traceId: string) {
    const mission = (await store.listRoomAgentMissions(roomId)).find((candidate) => candidate.status === "RUNNING") ?? null;
    if (!mission) return { missionId: null, interruptedPaneIds: [] as string[] };
    await store.updateRoomAgentMission(mission.id, {
      status: "PAUSED",
      pausedAt: nowIso(),
      statusReason: reason
    }, traceId);
    const actions = (await store.listRoomAgentActions(mission.id)).filter((action) => action.status === "RUNNING");
    const paneIds = Array.from(new Set(actions.flatMap((action) => (action.paneId ? [action.paneId] : []))));
    const agentPane = await store.getOrCreateRoomAgentPane(roomId, traceId);
    await Promise.all(paneIds.map((paneId) => interruptPane(roomId, agentPane.id, paneId, reason, traceId)));
    return { missionId: mission.id, interruptedPaneIds: paneIds };
  }

  async function resumeMission(roomId: string, traceId: string) {
    const mission = (await store.listRoomAgentMissions(roomId)).find((candidate) => candidate.status === "PAUSED") ?? null;
    if (!mission) return { missionId: null };
    const timestamp = nowIso();
    const pausedDurationMs = mission.pausedAt
      ? Math.max(0, Date.parse(timestamp) - Date.parse(mission.pausedAt))
      : 0;
    const pending = mission.executionState.pendingCompletion;
    const pendingCompletion = pending && typeof pending === "object" && !Array.isArray(pending)
      ? pending as Record<string, unknown>
      : null;
    const pendingStatus = pendingCompletion?.status;
    if (pendingCompletion && (pendingStatus === "COMPLETED" || pendingStatus === "FAILED" || pendingStatus === "INTERRUPTED")) {
      const { pendingCompletion: _completed, ...executionState } = mission.executionState;
      await store.updateRoomAgentMission(mission.id, {
        status: pendingStatus,
        currentPaneId: null,
        pausedAt: null,
        totalPausedMs: mission.totalPausedMs + pausedDurationMs,
        completedAt: typeof pendingCompletion.completedAt === "string" ? pendingCompletion.completedAt : timestamp,
        lastProgressAt: timestamp,
        executionState,
        statusReason: typeof pendingCompletion.statusReason === "string"
          ? pendingCompletion.statusReason
          : "Room Agent goal finished while paused."
      }, traceId);
      return { missionId: mission.id };
    }
    await store.updateRoomAgentMission(mission.id, {
      status: "RUNNING",
      pausedAt: null,
      totalPausedMs: mission.totalPausedMs + pausedDurationMs,
      lastProgressAt: timestamp,
      statusReason: "Room Agent goal resumed by operator."
    }, traceId);
    return { missionId: mission.id };
  }

  return { execute, stopMission, pauseMission, resumeMission };
}

export type RoomActionExecutor = ReturnType<typeof createRoomActionExecutor>;
