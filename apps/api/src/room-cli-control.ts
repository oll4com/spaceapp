import { randomUUID } from "node:crypto";
import { eventSchema, type AntigravityUsageAccountList, type Event, type Pane, type PaneCliModelSettings, type PaneCliSession } from "@space/contracts";
import { fetchOpenCodeAgentNames, type OpenCodeServerControl } from "@space/opencode-control";
import { makeSpaceId, nowIso, redactMemoryText, SpaceConflictError, type SpaceStore } from "@space/runtime";
import { cliUsageLimited } from "./agents-dashboard.js";
import { loadClaudeNativeTurns, type createClaudeNativeRefRecorder } from "./claude-native-turns.js";
import { cleanupNativeSettingsMenu, inspectedNativeModelId, type createNativeCliModelCatalog } from "./cli-native-model-picker.js";
import { codexDirectParityCodexHome, isClaudeDirectParityRuntime, isCodexDirectParityRuntime, isDeepSeekDirectParityRuntime, isOpenCodeDirectParityRuntime } from "./cli-parity.js";
import { submitCliPrompt } from "./cli-prompt-submit.js";
import { loadOmpTurnOpen } from "./omp-native-model.js";
import { findRuntime, type createAgentRuntimeRegistryCache } from "./cli-runtimes.js";
import type { CliTerminalManager } from "./cli-terminal.js";
import { findCodexTaskTimeline } from "./codex-rollout-diagnostics.js";
import { geminiTurnRunning, loadGeminiNativeTurns } from "./gemini-native-turns.js";
import { verifyGeminiPaneSession } from "./gemini-session-verification.js";
import { roomOpenCodeInspection } from "./opencode-room-inspection.js";
import { isCliPane } from "./pane-guards.js";
import { selectRoomCliMenuRow } from "./room-cli-menu.js";
import type { RoomCommandAction, RoomPaneObservation } from "./room-pane-control.js";
import { claudeRoomState, roomOpenCodeTerminalState, roomPromptFingerprint, roomTerminalCommands, roomTerminalMode, roomTerminalState, styledRunsFor, type TerminalRun } from "./room-terminal-screen.js";

type PaneModelReader = (pane: Pane, session: PaneCliSession, traceId: string) => Promise<{ settings: Pick<PaneCliModelSettings, "models" | "current" | "isTurnActive"> }>;

/**
 * A room's view of an AI terminal pane and its commands: the CLI session a control may act on, the pane's observed state, tasks,
 * models and modes per CLI (cached 15 s), and a command, key or answer typed into it under an 8-second watchdog that interrupts
 * a hanging CLI and records ROOM_WATCHDOG_ALERT.
 */
export function createRoomCliControl(options: {
  store: SpaceStore;
  /** A command over 8 s (room-watchdog-notices.ts: the room-hour line for Nous, never a banner by itself). */
  reportWatchdog?: (event: Event) => void;
  cliTerminalManager: CliTerminalManager;
  cliRuntimeRegistryCache: Pick<ReturnType<typeof createAgentRuntimeRegistryCache>, "read">;
  assertPaneCliRuntimeEnabled: (pane: Pane) => Promise<void>;
  readPaneCliModelSettings: PaneModelReader;
  readPaneOpenCodeModelSettings: PaneModelReader;
  resolveOpenCodeServerControl: (session: PaneCliSession) => Promise<OpenCodeServerControl>;
  readPaneNativeModelSettings: (session: PaneCliSession) => Promise<PaneCliModelSettings>;
  loadNativeCliModels: ReturnType<typeof createNativeCliModelCatalog>;
  antigravityUsageProvider: () => Promise<AntigravityUsageAccountList>;
  recordClaudeNativeRef: ReturnType<typeof createClaudeNativeRefRecorder>;
}) {
  const { store, reportWatchdog, cliTerminalManager, cliRuntimeRegistryCache, assertPaneCliRuntimeEnabled, readPaneCliModelSettings, readPaneOpenCodeModelSettings,
    resolveOpenCodeServerControl, readPaneNativeModelSettings, loadNativeCliModels, antigravityUsageProvider, recordClaudeNativeRef } = options;
  async function roomCliSession(pane: Pane, expectedSessionId?: string) {
    await assertPaneCliRuntimeEnabled(pane);
    if (!isCliPane(pane) || pane.terminalRuntimeId === "cli:root") throw new SpaceConflictError("Room CLI controls require an AI terminal.");
    if ((await store.getPane(pane.id)).isClosed) throw new SpaceConflictError("Reopen the pane before controlling its CLI.");
    let session = await store.getActivePaneCliSession(pane.id);
    if (!session) {
      session = (await store.listPaneCliSessions(pane.id, 1))[0] ?? null;
    }
    if (!session || session.purpose !== "NORMAL" || (expectedSessionId && session.sessionId !== expectedSessionId)) throw new SpaceConflictError("The target CLI session is unavailable or changed.");
    return session;
  }
  const roomCliObservationCache = new Map<string, { expires: number; data: RoomPaneObservation }>();
  async function inspectRoomCli(pane: Pane, freshness?: { fresh?: boolean; styled?: boolean }): Promise<RoomPaneObservation> {
    const cached = roomCliObservationCache.get(pane.id);
    if (!freshness?.fresh && cached && cached.expires > Date.now()) {
      if (!freshness?.styled || !cached.data.sessionId) return cached.data;
      // The cached text stays the answer; lines the screen has changed since go plain (styledRunsFor).
      const screen = await cliTerminalManager.observeRoomScreen(cached.data.sessionId, false, true).catch(() => null);
      return { ...cached.data, ...styledRunsFor(cached.data.text ?? "", screen?.runs) };
    }
    const session = await store.getActivePaneCliSession(pane.id) ?? (await store.listPaneCliSessions(pane.id, 1))[0] ?? null;
    const rawTaskRef = session?.codexThreadId?.trim();
    const base: RoomPaneObservation = { paneId: pane.id, paneName: pane.paneName ?? null, title: pane.title, runtimeId: pane.terminalRuntimeId ?? null,
      sessionId: session?.sessionId ?? null, state: "UNKNOWN", nativeTaskRef: rawTaskRef && rawTaskRef.length > 0 ? rawTaskRef : null,
      modelId: session?.modelId ?? pane.modelId ?? null, nativeMode: null, checkedAt: nowIso(), tasks: [] };
    if (!session || session.purpose !== "NORMAL") return base;
    const screen: { text: string; runs?: TerminalRun[][] } = await cliTerminalManager.observeRoomScreen(session.sessionId, false, freshness?.styled === true).catch(error=>{if(pane.isClosed||["EXITED","ERROR"].includes(session.status))return {text:""};throw error;});
    base.text = redactMemoryText(screen.text);
    base.promptFingerprint = roomPromptFingerprint(base.text);
    base.commands = roomTerminalCommands(screen.text);
    const rawState = roomTerminalState(screen.text);
    let claudeNative: Awaited<ReturnType<typeof loadClaudeNativeTurns>> = null;
    base.state = pane.isClosed || session.status === "EXITED" ? "EXITED" : session.status === "ERROR" ? "ERROR" : (rawState === "UNKNOWN" && screen.text.trim() === "" && session.runtimeId !== "cli:gemini" ? "IDLE" : rawState);
    if (isCodexDirectParityRuntime(session.runtimeId)) {
      base.tasks = session.codexThreadId ? await findCodexTaskTimeline({ codexHome: codexDirectParityCodexHome,
        threadId: session.codexThreadId }) : [];
      const settings = await readPaneCliModelSettings(pane, session, "room-observation").catch(() => null);
      if (settings) { base.models = settings.settings.models; base.modelId = settings.settings.current?.modelId ?? null;
        base.configuredModelId = pane.modelId; base.effectiveModelId = base.modelId; base.modelVerificationStatus = base.modelId ? "VERIFIED" : "UNKNOWN";
        if (base.state !== "EXITED" && base.state !== "ERROR") base.state = settings.settings.isTurnActive ? "RUNNING" : base.state === "WAITING_FOR_INPUT" ? base.state : "IDLE"; }
      base.modes = ["default", "plan"];
    } else if (isOpenCodeDirectParityRuntime(session.runtimeId)) {
      const control = await resolveOpenCodeServerControl(session).catch(() => null);
      if (control) {
        base.nativeTaskRef = control.nativeSessionId;
        const inspection = await roomOpenCodeInspection(control).catch(() => null);
        if (inspection) {
          base.tasks = inspection.tasks;
          if (inspection.transcript && inspection.transcript.trim().length > 0) {
            base.text = redactMemoryText(inspection.transcript);
          }
        }
        const settings = await readPaneOpenCodeModelSettings(pane, session, "room-observation").catch(() => null);
        if (settings) {
          base.models = settings.settings.models; base.modelId = settings.settings.current?.modelId ?? null;
          base.configuredModelId = pane.modelId; base.effectiveModelId = base.modelId; base.modelVerificationStatus = base.modelId ? "VERIFIED" : "UNKNOWN";
        }
        const modes = await fetchOpenCodeAgentNames(control).catch(() => []);
        if (modes.length) base.modes = modes;
        if (base.state !== "EXITED" && base.state !== "ERROR") {
          const terminalMode = roomOpenCodeTerminalState(screen.text, settings?.settings?.isTurnActive ?? false, base.modes ?? []);
          base.state = settings?.settings?.isTurnActive
            ? "RUNNING"
            : (terminalMode === "WAITING_FOR_INPUT" || rawState === "WAITING_FOR_INPUT")
            ? "WAITING_FOR_INPUT"
            : (terminalMode === "IDLE" || Boolean(control))
            ? "IDLE"
            : "UNKNOWN";
        }
      }
    } else if (session.runtimeId === "cli:gemini") {
      const pids = await cliTerminalManager.activeSessionPids([session]).catch(() => null);
      const rootPid = pids?.get(session.sessionId) ?? null;
      let catalog: Array<{ id: string; displayName: string }> = [];
      const runtime = findRuntime(await cliRuntimeRegistryCache.read(), session.runtimeId);
      if (runtime?.detectedCommandPath) {
        const loadedModels = await Promise.race([
          loadNativeCliModels(runtime.detectedCommandPath, session.accountProfileId),
          new Promise<Awaited<ReturnType<typeof loadNativeCliModels>>>((r) => setTimeout(() => r([]), 2000))
        ]).catch(() => []);
        catalog = loadedModels;
        base.models = loadedModels;
      }
      const usageList = await Promise.race([
        antigravityUsageProvider(),
        new Promise<{ data: any[] }>((r) => setTimeout(() => r({ data: [] }), 1500))
      ]).catch(() => ({ data: [] }));
      const fallbackVerification = {
        configuredModelId: session?.modelId ?? pane.modelId ?? null,
        effectiveModelId: null,
        modelVerificationStatus: "UNVERIFIED" as const,
        accountProfileId: session?.accountProfileId ?? "main",
        accountEmail: null,
        accountVerificationStatus: "UNVERIFIED" as const,
        verificationEvidence: { fallback: true },
        nativeTaskRef: null
      };
      const verified = await Promise.race([
        verifyGeminiPaneSession({
          pane,
          session,
          rootPid,
          screenText: screen.text,
          catalog,
          usageAccounts: usageList.data
        }),
        new Promise<any>((r) => setTimeout(() => r(fallbackVerification), 2000))
      ]).catch(() => fallbackVerification);

      if (verified.nativeTaskRef) {
        base.nativeTaskRef = verified.nativeTaskRef;
        const taskModel = verified.effectiveModelId ?? verified.configuredModelId ?? base.modelId;
        base.tasks = [{
          taskId: verified.nativeTaskRef,
          title: pane.title,
          status: "UNKNOWN",
          timing: { startedAt: session.startedAt ?? null, completedAt: null, durationMs: null, source: "OBSERVED", observedAt: nowIso() },
          modelsUsed: taskModel ? [{
            providerId: null,
            modelId: taskModel,
            reasoningEffort: null,
            turnId: null,
            startedAt: null,
            completedAt: null,
            source: "OBSERVED" as const
          }] : []
        }];
      }

      const native = await loadGeminiNativeTurns({ paneId: pane.id, sessionId: session.sessionId, rootPid }, { fresh: freshness?.fresh === true }).catch(() => null);
      if (native) {
        base.nativeTaskRef = native.conversationId;
        base.tasks = native.turns.map(({ finalResponse: _response, inputText: _input, aborted: _aborted, ...task }) => task);
        if (base.state !== "EXITED" && base.state !== "ERROR") {
          const latest = native.turns.at(-1);
          if (geminiTurnRunning(latest, rawState === "IDLE") || rawState === "RUNNING") {
            base.state = "RUNNING";
          } else if (rawState === "WAITING_FOR_INPUT" || latest?.status === "INTERRUPTED" || latest?.aborted) {
            base.state = "WAITING_FOR_INPUT";
          } else if (latest?.status === "COMPLETED" || rawState === "UNKNOWN") {
            base.state = "IDLE";
          }
        }
      }

      base.configuredModelId = verified.configuredModelId;
      base.effectiveModelId = verified.effectiveModelId;
      base.modelVerificationStatus = verified.modelVerificationStatus;
      base.accountProfileId = verified.accountProfileId;
      base.accountEmail = verified.accountEmail;
      base.accountVerificationStatus = verified.accountVerificationStatus;
      base.verificationEvidence = verified.verificationEvidence as unknown as Record<string, unknown>;

      base.modelId = verified.effectiveModelId ?? verified.configuredModelId ?? base.modelId;
      base.modes = ["default", "plan"];
    } else if (isDeepSeekDirectParityRuntime(session.runtimeId)) {
      if (base.state !== "EXITED" && base.state !== "ERROR") {
        base.state = rawState === "RUNNING" ? "RUNNING" : rawState === "WAITING_FOR_INPUT" ? "WAITING_FOR_INPUT" : "IDLE";
      }
      base.modes = ["workspace", "read-only", "yolo", "plan"];
    } else if (isClaudeDirectParityRuntime(session.runtimeId)) {
      const pids = await cliTerminalManager.activeSessionPids([session]).catch(() => null);
      const native = claudeNative = await loadClaudeNativeTurns({
        paneId: pane.id, sessionId: session.sessionId, rootPid: pids?.get(session.sessionId) ?? null
      }, { fresh: freshness?.fresh === true }).catch(() => null);
      if (native) {
        base.nativeTaskRef = native.nativeSessionId;
        base.tasks = native.tasks;
        base.modelId = native.modelId ?? base.modelId;
        await recordClaudeNativeRef(session, native).catch(() => undefined);
        // Claude's own session status is authoritative over screen heuristics.
        if (base.state !== "EXITED" && base.state !== "ERROR") {
          base.state = claudeRoomState(base.state, native);
        }
      }
    }
    if (session.runtimeId === "cli:omp" && base.state !== "EXITED" && base.state !== "ERROR" && base.state !== "WAITING_FOR_INPUT") {
      // omp's screen is blank while a pty:true command runs, which read as idle: a stop was confirmed while the turn went on and the next
      // prompt was typed into the command (step 9, 3/11). Its session file says whether the turn goes on; without it a blank omp is busy.
      const pids = await cliTerminalManager.activeSessionPids([session]).catch(() => null);
      const open = await loadOmpTurnOpen(session, pids?.get(session.sessionId) ?? null, freshness?.fresh === true).catch(() => null);
      if (open || (open === null && !screen.text.trim())) base.state = "RUNNING";
    }
    if (session.runtimeId === "cli:claude") base.modes = ["default", "plan", "accept edits", "bypass permissions", "auto"];
    if (session.runtimeId === "cli:omp" || session.runtimeId === "cli:droid") base.modes = ["build", "plan"];
    if (session.runtimeId === "cli:qoder") base.modes = ["yolo", "auto mode", "don't ask", "default", "accept edits", "plan"];
    base.modelId = await inspectedNativeModelId(session, readPaneNativeModelSettings, cliTerminalManager) ?? base.modelId;
    base.nativeMode = roomTerminalMode(session.runtimeId, screen.text, base.modes);
    base.usageLimited = cliUsageLimited(screen.text, claudeNative, session.startedAt);
    if (claudeNative) base.paceHold = claudeNative.paceHold ?? null;
    roomCliObservationCache.set(pane.id, { expires: Date.now() + 15_000, data: base });
    return freshness?.styled ? { ...base, ...styledRunsFor(base.text ?? "", screen.runs) } : base;
  }
  async function commandRoomCli(pane: Pane, action: RoomCommandAction, traceId: string): Promise<Record<string, unknown>> {
    roomCliObservationCache.delete(pane.id);
    const session = await roomCliSession(pane, action.expectedSessionId);
    const startMs = Date.now();
    // One key per command: Nous's trace is per turn, so a second answer or key to the same pane in a turn was dropped (review 2026-10-24).
    const inputKey = `${traceId}:${randomUUID()}`;
    const COMMAND_WATCHDOG_TIMEOUT_MS = 8000;
    const COMMAND_QUEUE_TIMEOUT_MS = 30_000;
    // 2/11 (load 45 on 24 cores): the 8 s ran from the queue, so a command waiting behind another one on the pane timed out, and the timeout
    // pressed Ctrl+C and Esc into the CLI (a running turn interrupted, a draft cleared) while this command kept typing. Now the 8 s start when
    // the command starts (30 s for its wait in the pane's queue), and a timed-out command types nothing more: every step checks `current` first.
    let timedOut = false;
    let started = false;
    let watchdogTimer: ReturnType<typeof setTimeout> | undefined;
    let startWatchdog!: () => void;
    // 7/11 Bruno/Kate: a timed-out prompt kept waiting 45 s for the CLI's composer and held the pane's lock; the abort ends that wait.
    const abort = new AbortController();
    const watchdogPromise = new Promise<never>((_, reject) => {
      const fire = () => { timedOut = true; abort.abort(new SpaceConflictError("The command timed out; nothing more was typed.")); reject(new Error("COMMAND_WATCHDOG_TIMEOUT")); };
      watchdogTimer = setTimeout(fire, COMMAND_QUEUE_TIMEOUT_MS);
      startWatchdog = () => { started = true; clearTimeout(watchdogTimer); watchdogTimer = setTimeout(fire, COMMAND_WATCHDOG_TIMEOUT_MS); };
    });
    const current = async () => {
      if (timedOut) throw new SpaceConflictError("The command timed out; nothing more was typed.");
      return roomCliSession(pane, action.expectedSessionId);
    };

    const mutationPromise = cliTerminalManager.runSerializedTerminalMutation(session.sessionId, async () => {
      if (timedOut) throw new SpaceConflictError("The command timed out in the pane's queue; nothing was typed.");
      startWatchdog();
      await current();
      const before = await cliTerminalManager.observeRoomScreen(session.sessionId);
      await current();
      if (action.answer !== undefined) {
        // Answer only the question that was inspected; a changed screen means a different question.
        const fingerprint = roomPromptFingerprint(redactMemoryText(before.text));
        if (action.expectedPromptFingerprint && action.expectedPromptFingerprint !== fingerprint)
          throw new SpaceConflictError("The pane's question changed since it was inspected; inspect it again before answering.");
        if (!action.expectedPromptFingerprint && roomTerminalState(before.text) !== "WAITING_FOR_INPUT")
          throw new SpaceConflictError("The pane is not waiting for an answer; inspect it again.");
        // Text with Enter is a prompt; a single key ("1", "y") or text without Enter goes as keys, for menus.
        if (action.submit !== false && action.answer.length > 1) {
          await submitCliPrompt(cliTerminalManager, session.sessionId, action.answer, traceId, `${inputKey}:answer`,
            { assertCurrent: current, paneId: pane.id, signal: abort.signal });
        } else {
          if (action.answer) await cliTerminalManager.sendInput(session.sessionId, action.answer, traceId, null, `${inputKey}:answer`);
          if (action.submit !== false) {
            await new Promise((resolve) => setTimeout(resolve, 200));
            await current();
            await cliTerminalManager.sendInput(session.sessionId, "\r", traceId, null, `${inputKey}:submit-answer`);
          }
        }
      }
      if (action.command) {
        // A native menu left open (Claude's /model scrolled past its title in a narrow pane) took the command's keys as a pick (4/11).
        let escape = 0;
        await cleanupNativeSettingsMenu({ runtimeId: session.runtimeId, assertCurrent: async () => { await current(); },
          read: () => cliTerminalManager.observeRoomScreen(session.sessionId, true),
          write: (data) => cliTerminalManager.sendInput(session.sessionId, data, traceId, null, `${inputKey}:close-menu:${escape++}`) });
        await cliTerminalManager.sendInput(session.sessionId, action.command, traceId, null, `${inputKey}:command`);
        // Let native paste/burst detection finish before Enter. Otherwise
        // Codex retains even a short slash command as an unsubmitted line.
        await new Promise((resolve) => setTimeout(resolve, 200));
        await current();
        await cliTerminalManager.sendInput(session.sessionId, "\r", traceId, null, `${inputKey}:submit-command`);
        // Antigravity / Gemini CLI displays an interactive autocomplete menu for slash
        // commands. The first Enter selects the menu item into the input line; a second
        // Enter is required to submit the command.
        if (action.command.startsWith("/") && session.runtimeId === "cli:gemini") {
          await new Promise((resolve) => setTimeout(resolve, 150));
          await current();
          await cliTerminalManager.sendInput(session.sessionId, "\r", traceId, null, `${inputKey}:submit-command-confirm`);
        }
      }
      if (action.key) {
        const keys = { UP: "\u001b[A", DOWN: "\u001b[B", LEFT: "\u001b[D", RIGHT: "\u001b[C", ENTER: "\r", ESCAPE: "\u001b", TAB: "\t", SHIFT_TAB: "\u001b[Z" };
        await cliTerminalManager.sendInput(session.sessionId, keys[action.key], traceId, null, `${inputKey}:key`);
      }
      let screen = before;
      const typed = Boolean(action.command || action.key || action.answer !== undefined);
      for (let attempt = 0; typed && attempt < 20; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 150));
        await current();
        screen = await cliTerminalManager.observeRoomScreen(session.sessionId);
        if (screen.revision !== before.revision) break;
      }
      if (typed && screen.revision === before.revision) throw new SpaceConflictError("CLI command produced no observable response.");
      if (/unknown command|unrecognized command|invalid slash command/i.test(screen.text)) throw new SpaceConflictError("The CLI rejected the command.");
      if (action.selection) screen = await selectRoomCliMenuRow({ screen, selection: action.selection, command: action.command,
        send: async (data, step) => { if (timedOut) throw new SpaceConflictError("The command timed out; nothing more was typed.");
          return cliTerminalManager.sendInput(session.sessionId, data, traceId, null, `${inputKey}:${step}`); },
        observe: async () => { await current(); return cliTerminalManager.observeRoomScreen(session.sessionId); } });
      return { sessionId: session.sessionId, command: action.command, selection: action.selection ?? null,
        key: action.key ?? null, answered: action.answer !== undefined, state: roomTerminalState(screen.text), text: redactMemoryText(screen.text), checkedAt: nowIso() };
    });

    try {
      return await Promise.race([mutationPromise, watchdogPromise]);
    } catch (error) {
      if (error instanceof Error && error.message === "COMMAND_WATCHDOG_TIMEOUT") {
        // The mutation goes on unlocked: its next step sees `timedOut` and stops; its unhandled rejection is expected.
        mutationPromise.catch(() => {});
        const cmdName = action.command ? `command "${action.command}"` : (action.key ? `key "${action.key}"` : action.answer !== undefined ? "answer" : "operation");
        const alertMessage = started
          ? `Room watchdog: the ${cmdName} in pane "${pane.title}" (${session.runtimeId}) took over 8 s; it was stopped before its next step and nothing more was typed. Try it again.`
          : `Room watchdog: the ${cmdName} for pane "${pane.title}" (${session.runtimeId}) waited 30 s behind the pane's previous command and was not typed. Try it again.`;
        const watchdogEvent = eventSchema.parse({
          id: makeSpaceId("event"),
          roomId: pane.roomId,
          paneId: pane.id,
          turnId: null,
          workflowId: null,
          traceId,
          type: "ROOM_WATCHDOG_ALERT",
          message: alertMessage,
          payload: {
            kind: "ROOM_FREEZE_PREVENTED",
            source: "commandRoomCli",
            roomId: pane.roomId,
            paneId: pane.id,
            paneTitle: pane.title,
            runtimeId: session.runtimeId,
            command: action.command ?? action.key ?? null,
            started,
            durationMs: Date.now() - startMs,
            killedAt: nowIso()
          },
          createdAt: nowIso()
        });
        console.warn(JSON.stringify({ level: 40, time: Date.now(), event: "room_cli.command_timeout", roomId: pane.roomId, paneId: pane.id, runtimeId: session.runtimeId,
          command: action.command ?? action.key ?? (action.answer !== undefined ? "answer" : null), durationMs: Date.now() - startMs }));
        reportWatchdog?.(watchdogEvent);
        throw new SpaceConflictError(alertMessage);
      }
      throw error;
    } finally {
      if (watchdogTimer) clearTimeout(watchdogTimer);
    }
  }
  return { roomCliSession, roomCliObservationCache, inspectRoomCli, commandRoomCli };
}
