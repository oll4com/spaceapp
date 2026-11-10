import { abortOpenCodeSession, openCodeSpaceChatStateRoot, parseOpenCodeCompositeModelId, readOpenCodeServerControl } from "@space/opencode-control";
import { nowIso, SpaceConflictError, type SpaceStore } from "@space/runtime";
import { unlink } from "node:fs/promises";
import { discoverAntigravityProfiles } from "./antigravity-usage-services.js";
import { switchClaudePaneAccount, type ClaudeAccountSwitchDeps } from "./claude-account-switch.js";
import { findNativeCliModel } from "./cli-native-model-picker.js";
import { hasExactNativeTaskResume } from "./cli-native-task-resume.js";
import { isCodexDirectParityRuntime, isDirectOperatorParityRuntime, isOpenCodeDirectParityRuntime } from "./cli-parity.js";
import type { CliRuntimeVisibilityPolicy } from "./cli-runtime-visibility.js";
import type { CliTerminalManager } from "./cli-terminal.js";
import type { createCodexThreadSettings } from "./codex-thread-settings.js";
import { findCodexTaskTimeline } from "./codex-rollout-diagnostics.js";
import type { SpaceApiConfig } from "./config.js";
import {
  geminiNativeConversationIdPattern, normalizeGeminiPaneId, readGeminiNativeConversationIdFromProcessTree, readGeminiPaneConversation, writeGeminiPaneConversation
} from "./gemini-native-session.js";
import type { createOpenCodePaneModel } from "./opencode-pane-model.js";
import { roomOpenCodeTasks } from "./opencode-room-inspection.js";
import type { createOpenCodeServerControlResolver } from "./opencode-server-control.js";
import type { createPaneCliModel } from "./pane-cli-model.js";
import type { createPaneCliResume } from "./pane-cli-resume.js";
import { applyUnmanagedCodexModelSettings } from "./plan-execution-mutations.js";
import type { createRoomCliControl } from "./room-cli-control.js";
import { resumeRoomCliFromMenu } from "./room-cli-menu.js";
import { createRoomPaneController } from "./room-pane-control.js";
import { roomTerminalInterruptKey, roomTerminalMode } from "./room-terminal-screen.js";
import type { SpaceAgentAdapter } from "./space-agent.js";
import { CliTaskNotResumableError, type UnifiedCliTaskRegistry } from "./unified-cli-task-registry.js";

/** When an OMP stop sends its follow-up Escapes, after the first: the killed command's result came 1.6-2.5 s after a stop at load 50 and the model's next tool call ~4 s later (3/11). */
export const OMP_FOLLOW_UP_ESCAPES_MS = [1500, 3000] as const;
/** ADAPTER-013: Hermes 0.22 and OMP 18 list no task by its Space title in /resume (live 4/11: the menu was never verified and the
 * pane stayed on it), so without a recorded reference they continue in a fresh session with the task's bounded context. */
const noTitleResumeMenu = new Set(["cli:hermes", "cli:omp"]);

type RoomPaneCliControllerDeps = {
  store: SpaceStore;
  spaceAgentAdapter: SpaceAgentAdapter;
  config: SpaceApiConfig;
  cliTerminalManager: CliTerminalManager;
  cliRuntimeVisibility: Pick<CliRuntimeVisibilityPolicy, "isEnabled">;
  unifiedCliTaskRegistry: Pick<UnifiedCliTaskRegistry, "getTask">;
  assertNoManagedModelMutation: (paneId: string) => Promise<unknown>;
  claudeAccountSwitchDeps: ClaudeAccountSwitchDeps;
} & Pick<ReturnType<typeof createRoomCliControl>, "inspectRoomCli" | "commandRoomCli" | "roomCliSession" | "roomCliObservationCache">
  & Pick<ReturnType<typeof createPaneCliModel>, "readPaneCliModelSettings" | "readPaneNativeModelSettings" | "applyNativePaneModel">
  & Pick<ReturnType<typeof createOpenCodePaneModel>, "readPaneOpenCodeModelSettings" | "applyOpenCodePaneSelection">
  & Pick<ReturnType<typeof createOpenCodeServerControlResolver>, "resolveOpenCodeServerControl">
  & Pick<ReturnType<typeof createPaneCliResume>, "resumePaneCliTask">
  & Pick<ReturnType<typeof createCodexThreadSettings>, "waitForCodexThreadSettings">;

/**
 * The room pane controller over a pane's CLI: its chat tasks, the screen inspection and commands, configure (model and effort
 * per CLI, native mode, account profile), start, resume (an exact native task, else the CLI's own /resume menu) and interrupt.
 */
export function createRoomPaneCliController(deps: RoomPaneCliControllerDeps) {
  const { store, spaceAgentAdapter, config, cliTerminalManager, cliRuntimeVisibility, unifiedCliTaskRegistry, assertNoManagedModelMutation, claudeAccountSwitchDeps,
    inspectRoomCli, commandRoomCli, roomCliSession, roomCliObservationCache, readPaneCliModelSettings, readPaneNativeModelSettings, applyNativePaneModel,
    readPaneOpenCodeModelSettings, applyOpenCodePaneSelection, resolveOpenCodeServerControl, resumePaneCliTask, waitForCodexThreadSettings } = deps;
  const roomPaneController = createRoomPaneController({
    store, chat: spaceAgentAdapter, listRuntimes: () => cliTerminalManager.listRuntimes(),
    isEnabled: (runtimeId) => cliRuntimeVisibility.isEnabled(runtimeId),
    chatTypes: () => spaceAgentAdapter.listRoomChatTypes?.() ?? Promise.resolve([]),
    async chatTasks(pane) {
      const session = await store.getActiveSpaceAgentSession(pane.id);
      if (!session) return [];
      if (session.selectedProviderId?.includes("opencode")) {
        const control = await readOpenCodeServerControl(session.sessionId, openCodeSpaceChatStateRoot);
        return control ? roomOpenCodeTasks(control) : [];
      }
      return session.threadId ? findCodexTaskTimeline({ codexHome: config.codexAppServerHome ?? "/var/lib/spaceapp-user/.codex", threadId: session.threadId }) : [];
    },
    inspectCli: inspectRoomCli, commandCli: commandRoomCli,
    async configureCli(pane, action, traceId) {
      const session = await roomCliSession(pane, action.expectedSessionId);
      if (action.modelId || action.reasoningEffort) {
        await assertNoManagedModelMutation(pane.id);
        if (isOpenCodeDirectParityRuntime(session.runtimeId)) {
          const control = await resolveOpenCodeServerControl(session);
          const before = await readPaneOpenCodeModelSettings(pane, session, traceId);
          const modelId = action.modelId ?? before.settings.current?.modelId;
          const model = before.settings.models.find((entry) => entry.id === modelId);
          const ref = modelId ? parseOpenCodeCompositeModelId(modelId) : null;
          if (!model || !ref) throw new SpaceConflictError("The model is not advertised by this CLI.");
          const reasoning = action.reasoningEffort ?? model.defaultReasoningEffort;
          await applyOpenCodePaneSelection(pane, session, model, reasoning, traceId, undefined, before.settings.models);
          const after = await readPaneOpenCodeModelSettings(pane, session, traceId);
          if (after.settings.current?.modelId !== model.id) throw new SpaceConflictError("OpenCode model readback did not confirm the requested model.");
          await store.updatePaneCliSession(session.sessionId, { modelId: model.id, reasoningEffort: reasoning }, traceId);
        } else if (isCodexDirectParityRuntime(session.runtimeId)) {
          await applyUnmanagedCodexModelSettings(store,pane.id,{
            inspect: async () => {
              const before = await readPaneCliModelSettings(pane, session, traceId);
              const modelId = action.modelId ?? before.settings.current?.modelId;
              const model = before.settings.models.find((entry) => entry.id === modelId);
              const reasoning = action.reasoningEffort ?? before.settings.current?.reasoningEffort ?? model?.defaultReasoningEffort;
              if (!model || !reasoning || !model.supportedReasoningEfforts.includes(reasoning)) throw new SpaceConflictError("The model/reasoning combination is not advertised by this CLI.");
              return {before,model,reasoning};
            },
            assertCurrent: async ({before}) => {
              const current = await roomCliSession(pane, action.expectedSessionId);
              // Like the pane picker: a fresh TUI's task reaches the DB only after its first turn is saved.
              const liveThreadId = before.primaryThreadId !== undefined ? await before.directControl.readCurrentThreadId?.() : current.codexThreadId;
              if (liveThreadId !== before.settings.threadId || current.cwd !== session.cwd)
                throw new SpaceConflictError("The native Codex thread changed before model control.");
            },
            updateSettings: async ({before,model,reasoning},beforeSend) => {
              if (before.settings.threadId) await before.directControl.updateThreadSettings({
                threadId: before.settings.threadId, model: model.id, reasoningEffort: reasoning, beforeSend });
            },
            updateRouter: async ({before,model,reasoning}) => {
              // Keep the TUI's collaboration-mode router in sync with this explicit
              // selection while managed creation is excluded from the pane.
              // The fence checked the live thread; the router guards the DB's (null until a fresh TUI's first turn is saved).
              await cliTerminalManager.updateCodexNativeModelSettings({ sessionId: session.sessionId,
                expectedThreadId: before.session.codexThreadId, models: before.settings.models, modelId: model.id, reasoningEffort: reasoning, traceId });
            },
            finish: async ({before,model,reasoning}) => {
              if (before.settings.threadId) await waitForCodexThreadSettings({ threadId: before.settings.threadId, cwd: session.cwd, sessionId: session.sessionId, modelId: model.id, reasoningEffort: reasoning, models: before.settings.models });
              await store.updatePaneCliSession(session.sessionId, { modelId: model.id, reasoningEffort: reasoning }, traceId);
            }
          });
        } else if (session.runtimeId === "cli:omp") {
          const command = `/switch ${action.modelId}${action.reasoningEffort && action.reasoningEffort !== "none" ? `:${action.reasoningEffort}` : ""}`;
          await commandRoomCli(pane, { type: "cli_command", paneId: pane.id, expectedSessionId: session.sessionId,
            command, when: action.when }, traceId);
          if (action.modelId) await store.updatePaneCliSession(session.sessionId, { modelId: action.modelId, reasoningEffort: action.reasoningEffort }, traceId);
        } else if (session.runtimeId === "cli:cursor") {
          await commandRoomCli(pane, { type: "cli_command", paneId: pane.id, expectedSessionId: session.sessionId,
            command: `/model ${action.modelId}`, when: action.when }, traceId);
          if (action.modelId) await store.updatePaneCliSession(session.sessionId, { modelId: action.modelId }, traceId);
        } else {
          // Same verified native switch as the pane picker (screen readback, pane pick persisted);
          // the plain /model menu stays the fallback while a turn runs or the catalog lacks the model.
          const isClaude = session.runtimeId === "cli:claude";
          const before = (action.modelId || isClaude) && isDirectOperatorParityRuntime(session.runtimeId)
            ? await readPaneNativeModelSettings(session).catch(() => null) : null;
          const requested = action.modelId ?? (isClaude ? before?.current?.modelId : undefined);
          const model = before && requested ? findNativeCliModel(before.models, requested, session.runtimeId) : undefined;
          const reasoning = model ? action.reasoningEffort ?? model.defaultReasoningEffort ?? before?.current?.reasoningEffort : undefined;
          if (before && model && reasoning && model.supportedReasoningEfforts.includes(reasoning) && !before.isTurnActive) {
            await cliTerminalManager.runSerializedTerminalMutation(session.sessionId, () => applyNativePaneModel({
              pane, active: session, modelId: model.id, reasoningEffort: reasoning, traceId,
              assertControl: async (current) => { if (current.sessionId !== session.sessionId) throw new SpaceConflictError("The CLI session changed during the model switch."); }
            }));
          } else if (isClaude) {
            // Claude's /model menu lists families, never ids, and Enter there saves the profile's shared default.
            throw new SpaceConflictError(!before ? "The Claude model catalog is unavailable; try again shortly."
              : before.isTurnActive ? "Claude is working; change its model after the current turn."
              // R74 (2026-11-05 REVIEW: 6 of 14 failed switches on 4/11 answered only this list): name what was asked.
              : `${!model ? `"${requested ?? ""}" is no Claude model` : `${model.id} has no effort ${reasoning ? `"${reasoning}"` : "set"}`}: `
                + `Claude offers ${before.models.map((entry) => `${entry.id} (${entry.supportedReasoningEfforts.join("/")})`).join(", ")}.`);
          } else await commandRoomCli(pane, { type: "cli_command", paneId: pane.id, expectedSessionId: session.sessionId,
            command: "/model", selection: action.modelId ?? action.reasoningEffort, when: action.when }, traceId);
        }
      }
      if (action.nativeMode) {
        const mode = action.nativeMode.toLowerCase() === "build" && session.runtimeId === "cli:codex" ? "default" : action.nativeMode.toLowerCase();
        const codexSettings = isCodexDirectParityRuntime(session.runtimeId)
          ? await readPaneCliModelSettings(pane, session, traceId) : null;
        const before = await inspectRoomCli(pane);
        if (before.nativeMode !== mode) {
          if (before.modes && !before.modes.includes(mode)) throw new SpaceConflictError("The requested mode is not advertised by this CLI.");
          if (mode === "plan" && ["cli:codex", "cli:gemini", "cli:qwen"].includes(session.runtimeId)) {
            await commandRoomCli(pane, { type: "cli_command", paneId: pane.id, expectedSessionId: session.sessionId, command: "/plan", when: action.when }, traceId);
          } else if ((session.runtimeId === "cli:omp" || session.runtimeId === "cli:qoder") && (mode === "plan" || before.nativeMode === "plan")) {
            // Plan is a /plan toggle here; Shift+Tab changes thinking effort (Oh My Pi) or permissions (Qoder).
            await commandRoomCli(pane, { type: "cli_command", paneId: pane.id, expectedSessionId: session.sessionId, command: "/plan", when: action.when }, traceId);
          } else {
            if (!before.nativeMode) throw new SpaceConflictError("The current native mode is not visible; inspect the CLI menu before switching.");
            let previous = before.nativeMode;
            for (let attempt = 0; attempt < 8; attempt++) {
              await roomCliSession(pane, action.expectedSessionId);
              await cliTerminalManager.sendInput(session.sessionId, "\u001b[Z", traceId, null, `${traceId}:mode:${attempt}`);
              let changed: string | null = null;
              for (let poll = 0; poll < 15; poll++) {
                await new Promise((resolve) => setTimeout(resolve, 100));
                await roomCliSession(pane, action.expectedSessionId);
                const screen = await cliTerminalManager.observeRoomScreen(session.sessionId);
                changed = roomTerminalMode(session.runtimeId, screen.text, before.modes);
                if (changed && changed !== previous) break;
              }
              if (!changed || changed === previous) throw new SpaceConflictError("The CLI did not confirm a mode change; no further cycle keys were sent.");
              if (changed === mode || changed === before.nativeMode) break;
              previous = changed;
            }
          }
          let after = await inspectRoomCli(pane);
          for (let poll = 0; after.nativeMode !== mode && poll < 20; poll++) {
            await new Promise((resolve) => setTimeout(resolve, 100));
            await roomCliSession(pane, action.expectedSessionId);
            after = await inspectRoomCli(pane);
          }
          if (after.nativeMode !== mode) throw new SpaceConflictError("CLI mode readback is unconfirmed; inspect the current pane before retrying.");
          // Native collaboration presets can restore a different model/effort
          // when cycling. A mode-only request must retain the user's selection.
          if (codexSettings?.settings.current) {
            await roomCliSession(pane, action.expectedSessionId);
            const { modelId, reasoningEffort } = codexSettings.settings.current;
            const threadId = codexSettings.settings.threadId;
            if (threadId) await codexSettings.directControl.updateThreadSettings({ threadId, model: modelId, reasoningEffort });
            if (threadId && mode === "plan") {
              // The model picker can emit Default collaboration settings. Keep
              // the router's manual pair and refresh the native Plan composer
              // through its own command instead of cycling back through Default.
              await commandRoomCli(pane, { type: "cli_command", paneId: pane.id, expectedSessionId: session.sessionId,
                command: "/plan", when: action.when }, traceId);
            } else {
              await cliTerminalManager.updateCodexNativeModelSettings({ sessionId: session.sessionId,
                expectedThreadId: threadId, modelId, reasoningEffort, models: codexSettings.settings.models, traceId });
            }
            if (threadId) {
              await waitForCodexThreadSettings({ threadId, cwd: session.cwd, sessionId: session.sessionId,
                modelId, reasoningEffort, models: codexSettings.settings.models });
            }
            if ((await inspectRoomCli(pane)).nativeMode !== mode) throw new SpaceConflictError("Restoring model settings changed the requested native mode.");
          }
        }
      }
      if (action.accountProfileId !== undefined) {
        if (session.runtimeId === "cli:gemini") {
          const targetProfile = action.accountProfileId;
          if (targetProfile && targetProfile !== "main") {
            const profiles = await discoverAntigravityProfiles();
            if (!profiles.some((p) => p.profileId === targetProfile)) {
              throw new SpaceConflictError(`Antigravity account profile "${targetProfile}" is not found.`);
            }
          }
          if (session.accountProfileId !== targetProfile) {
            let convId = await readGeminiPaneConversation(pane.id).catch(() => null);
            if (!convId && session.codexThreadId && geminiNativeConversationIdPattern.test(session.codexThreadId.trim())) {
              convId = session.codexThreadId.trim();
            }
            if (!convId) {
              const pids = await cliTerminalManager.activeSessionPids([session]).catch(() => null);
              const rootPid = pids?.get(session.sessionId) ?? null;
              if (rootPid) {
                convId = await readGeminiNativeConversationIdFromProcessTree(rootPid).catch(() => null);
              }
            }
            if (convId) {
              await writeGeminiPaneConversation(pane.id, convId);
            }
            if (session.isActive && session.status !== "EXITED") {
              const pids = await cliTerminalManager.activeSessionPids([session]).catch(() => null);
              const rootPid = pids?.get(session.sessionId) ?? null;
              if (rootPid) {
                try { process.kill(rootPid, "SIGTERM"); } catch {}
              }
              await store.updatePaneCliSession(
                session.sessionId,
                { status: "EXITED", isActive: false, endedAt: nowIso(), statusReason: "Account profile switched" },
                traceId
              );
              // ADAPTER-010: the wrapper reads pane-<id>.json on `--continue` and copies that conversation into the new account's store,
              // so a RESUME launch keeps the pane's conversation; only with none to carry is a stale file cleared for a fresh start.
              if (!convId) {
                const cleanId = normalizeGeminiPaneId(pane.id);
                await unlink(`/opt/spaceapp/var/gemini-pane-conversations/pane-${cleanId}.json`).catch(() => {});
                await unlink(`/opt/spaceapp/var/gemini-pane-conversations/pane-pane:${cleanId}.json`).catch(() => {});
              }
              await cliTerminalManager.ensurePaneControlReady(pane, traceId, { accountProfileId: targetProfile, launchMode: convId ? "RESUME" : "FRESH" });
            } else {
              await store.updatePaneCliSession(session.sessionId, { accountProfileId: targetProfile }, traceId);
            }
          }
        } else if (session.runtimeId === "cli:claude") {
          if (await switchClaudePaneAccount(claudeAccountSwitchDeps, pane, session, action.accountProfileId, traceId)) roomCliObservationCache.delete(pane.id);
        } else {
          throw new SpaceConflictError("Account profile switching is supported on Gemini and Claude Code panes.");
        }
      }
      return { observation: await inspectRoomCli(pane) };
    },
    async startCli(pane, traceId) {
      const session = await cliTerminalManager.ensurePaneControlReady(pane, traceId);
      roomCliObservationCache.delete(pane.id);
      return { sessionId: session.sessionId, state: session.status };
    },
    async resumeCli(pane, taskId, traceId) {
      if (pane.terminalRuntimeId && !isCodexDirectParityRuntime(pane.terminalRuntimeId) && !isOpenCodeDirectParityRuntime(pane.terminalRuntimeId)) {
        const source = taskId ? await unifiedCliTaskRegistry.getTask(taskId, [pane.terminalRuntimeId]) : null;
        if (source && source.session.roomId !== pane.roomId) throw new SpaceConflictError("Room Agent can resume only tasks belonging to this room.");
        if (source && hasExactNativeTaskResume(pane.terminalRuntimeId)) {
          // Runtimes with a registered native task resolver (cli-native-task-resume.ts) resume that exact
          // task like Codex and OpenCode; the native /resume menu stays the fallback when no ref is available.
          try {
            const result = await resumePaneCliTask(pane, { taskId: source.taskId }, traceId, undefined, !noTitleResumeMenu.has(pane.terminalRuntimeId));
            const resumed = await cliTerminalManager.ensurePaneControlReady(result.pane, traceId);
            return { paneId: pane.id, sessionId: resumed.sessionId, mode: result.mode, state: resumed.status };
          } catch (error) {
            if (!(error instanceof SpaceConflictError) || !error.message.startsWith("Exact native resume is unavailable")) throw error;
          }
        }
        const ready = await cliTerminalManager.ensurePaneControlReady(pane, traceId);
        if (noTitleResumeMenu.has(pane.terminalRuntimeId)) return { paneId: pane.id, sessionId: ready.sessionId, state: ready.status };
        return resumeRoomCliFromMenu({ paneId: pane.id, ready, source, command: (selection) => commandRoomCli(pane, { type: "cli_command", paneId: pane.id,
          expectedSessionId: ready.sessionId, command: "/resume", ...(selection ? { selection } : {}), when: "AFTER_TURN" }, traceId) });
      }
      const session = await store.getActivePaneCliSession(pane.id) ?? (await store.listPaneCliSessions(pane.id,1))[0];
      const ref = taskId ?? session?.cliTaskId;
      if (!ref) throw new CliTaskNotResumableError("Inspect task history and choose an existing native task to resume.");
      const result = await resumePaneCliTask(pane, { taskId: ref }, traceId, undefined, true);
      const ready = await cliTerminalManager.ensurePaneControlReady(result.pane, traceId);
      return { paneId: pane.id, sessionId: ready.sessionId, mode: result.mode, state: ready.status };
    },
    async interruptCli(pane, traceId) {
      const active = await store.getActivePaneCliSession(pane.id);
      if (!active || active.status === "EXITED" || pane.isClosed) return { interrupted: false, state: "EXITED" };
      const session = await roomCliSession(pane);
      let interrupted = false;
      if (isOpenCodeDirectParityRuntime(session.runtimeId)) {
        const control = await resolveOpenCodeServerControl(session);
        await abortOpenCodeSession(control, control.nativeSessionId);
        interrupted = true;
      } else if (isCodexDirectParityRuntime(session.runtimeId)) {
        const before = await readPaneCliModelSettings(pane, session, traceId).catch(() => null);
        if (before?.settings.threadId && before.activity?.turnId && before.settings.isTurnActive) {
          try {
            await before.directControl.interruptTurn({ threadId: before.settings.threadId, turnId: before.activity.turnId });
            interrupted = true;
          } catch {}
        }
        if (!interrupted) {
          await cliTerminalManager.sendInput(session.sessionId, "\u001b", traceId, null, `${traceId}:interrupt:esc`);
          interrupted = true;
        }
      } else {
        const key = roomTerminalInterruptKey(session.runtimeId);
        await cliTerminalManager.sendInput(session.sessionId, key, traceId, null, `${traceId}:interrupt:1`);
        // Oh My Pi 18 runs a pty:true command in an overlay whose Escape kills only that command; the model then runs it again and
        // the next prompt lands in the new command (plan clipboard:NtzEOzE3Ew00 step 9, 3/11). An Escape after the overlay closes stops
        // the turn. At an idle empty composer an Escape more than 500 ms after the last one only records the time (two within 500 ms
        // open its rewind selector) and a draft is kept, so the follow-ups are harmless once the turn has ended.
        if (session.runtimeId === "cli:omp") {
          for (const [index, atMs] of OMP_FOLLOW_UP_ESCAPES_MS.entries()) {
            await new Promise((resolve) => setTimeout(resolve, atMs - (OMP_FOLLOW_UP_ESCAPES_MS[index - 1] ?? 0)));
            await cliTerminalManager.sendInput(session.sessionId, key, traceId, null, `${traceId}:interrupt:${index + 2}`);
          }
        }
        interrupted = true;
      }
      return { sessionId: session.sessionId, interrupted, observation: await inspectRoomCli(pane) };
    }
  });
  return roomPaneController;
}
