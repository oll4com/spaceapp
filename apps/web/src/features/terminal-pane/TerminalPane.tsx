import { useManagedPlanExecution } from "./use-managed-plan-execution.js";
import { LocalCliComposer } from "./LocalCliComposer.js";
import { routePaneModelSwitch, routePanePlanSelection, usesManagedPlanExecution, isFinishedExecution, type ManagedStageScope } from "./managed-plan-client.js";
import { holdTerminalReconnectFrame } from "./terminal-reconnect-frame.js";
import {
  nextTerminalControlReplayBudget,
  terminalControlDenialReplay,
  type RecordedTerminalControlMutation,
  type TerminalControlReplayBudget
} from "./terminal-control-recovery.js";
import { formatPlanAttachment } from "./plan-attachment.js";
import { loadCliPhotoHistory, type TerminalUploadPreview } from "./cli-photo-history.js";
import { claudeFooterLines, claudeFooterModeLabel, cliBuildModeState, returnCliToBuildMode, type ClaudeFooterModeLabel } from "./cli-build-mode.js";
import { claudeBackgroundAgentRunning } from "./claude-agent-panel.js";
import type { TerminalActionAvailability } from "./terminal-action-availability.js";
import { submitCliShortcut } from "./submit-cli-shortcut.js";
import { CliShortcutsMenu, cliTranscriptCommand } from "./CliShortcutsMenu.js";
import { CliPlansMenu } from "./CliPlansMenu.js";
import { shouldPreserveForSnipTool } from "../snip-tool/snip-guard.js";
import { cliShortcutCommandsForRuntime, resolveCliModeShortcut, OSK_CLI_COMMANDS, OSK_ESC_COMMAND, OSK_ENTER_COMMAND, type OskCliCommand } from "../osk-keyboard/cli-shortcuts.js";
import { ArrowUp, BrainCircuit, ChevronLeft, ChevronRight, Clipboard, Copy, File as FileIcon, Github, Hash, Images, Keyboard, Loader2, Maximize2, NotebookPen, Square, Terminal as TerminalIcon, Trash2, X } from "../ui-theme/app-icons.js";
import { useTouchContextMenu } from "../ui-theme/use-touch-context-menu.js";
import { detectKeyboardLayoutMismatch, toggleKeyboardLayout, type LayoutMismatchDetection } from "../agent-pane/greek-layout-converter.js";
import { createTerminalResizeTrace } from "./terminal-resize-trace.js";
import {
  isComposerLayoutIconVisible,
  isComposerSuggestionBarVisible,
  playLayoutSuggestionBeep,
  useKeyboardAutocorrectSettings
} from "../keyboard-autocorrect/keyboard-autocorrect-settings.js";
import { PromptVariableAutocomplete } from "../prompt-variables/PromptVariableAutocomplete.js";
import { PromptVariablesMenu } from "../prompt-variables/PromptVariablesMenu.js";
import {
  expandPromptVariables,
  filterPromptVariables,
  findActiveVariableToken,
  usePromptVariables,
  type PromptVariableToken
} from "../prompt-variables/prompt-variables-store.js";
import type { PromptVariable } from "@space/contracts";
import { GoogleGIcon } from "../ui-theme/GoogleGIcon.js";
import { ClaudeIcon } from "../ui-theme/ClaudeIcon.js";
import { CliAccountPicker } from "../cli-accounts/CliAccountPicker.js";
import { CodexAccountPicker } from "../cli-accounts/CodexAccountPicker.js";
import { cliAccountProfileForPane, isNewCliPane, NEW_PANE_WINDOW_MS } from "../cli-accounts/cli-account-default.js";
import { hasCliAccountProfiles, readLastCliAccountProfileId, takeNewPaneAccount, writeLastCliAccountProfileId } from "../cli-accounts/cli-account-memory.js";
import { lazy, memo, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ClipboardEvent as ReactClipboardEvent, type DragEvent, type SyntheticEvent } from "react";
import { createPortal } from "react-dom";
import type { IDisposable, Terminal as XtermTerminal } from "@xterm/xterm";
import type { FitAddon as XtermFitAddon } from "@xterm/addon-fit";
import {
  CLI_PANE_TYPES,
  cliTurnInterruptKey,
  paneCliUploadMaxCount,
  paneCliSessionResponseSchema,
  paneCliWebSocketServerMessageSchema,
  type AgentRuntimeRegistry,
  type CliAccountProfile,
  type CliTerminalClientEventInput,
  type ClipboardItem,
  type ListCliAccountProfilesResponse,
  type Pane,
  type PaneCliModelSettings,
  type PaneCliTerminalControlState,
  type PaneCliUploadSource,
  type PaneCliUploadedFile,
  type PaneCliSessionResponse,
  type PaneCliTurnActivityStatus
} from "@space/contracts";
import { SpaceApiError, api } from "../../api.js";
import { readStoredSuppressNotifications } from "../../notifications-settings.js";
import {
  invalidateTerminalWidthMeasurements,
  memoizeTerminalWidthMeasurements
} from "./terminal-width-measure-cache.js";
import {
  createTerminalGeometryCoordinator,
  fitTerminalForInitialAttach,
  type InitialTerminalGeometry,
  type TerminalRefitOptions
} from "./terminal-geometry-coordinator.js";
import {
  createTerminalInputTokenizer,
  isNonMutatingTerminalProtocolResponse,
  type TerminalInputSegment
} from "./terminal-input-tokenizer.js";
import { createOsc52ClipboardScanner } from "./terminal-osc52-clipboard.js";
import {
  createTerminalOutputCoordinator,
  recordTerminalStressXtermWrite,
  type TerminalOutputPressure,
  type TerminalOutputWriteMode
} from "./terminal-output-coordinator.js";
import {
  HIDDEN_WARM_SOCKET_PARK_MS,
  resolveTerminalControlHeartbeatIntervalMs,
  shouldParkHiddenWarmSocket,
  shouldRefreshModelSettingsFromOutput
} from "./hidden-warm-socket.js";
import { DEMO_LOCAL_REPLY, getSpaceRuntime, getSpaceRuntimeKind, terminalGateway, type PlatformGateway } from "../../runtime/SpaceRuntime.js";
import { DEFAULT_CLI_IMAGE_PREVIEW_LIMIT, normalizeCliImagePreviewLimit } from "../../cli-upload-settings.js";
import { isCliRuntimeTerminalLaunchable } from "../../cli-runtime-presentation.js";
import { recordLifecycleDebugEvent } from "../../lifecycle-debug.js";
import { emitAppDiagnosticsPerformance } from "../../app-diagnostics/app-diagnostics-performance.js";
import { readFullscreenGeometry, recordFullscreenGeometry } from "./fullscreen-geometry.js";
import { watchTerminalPaint } from "./terminal-paint-recovery.js";
import { reportCliClientEventBounded } from "../../cli-client-event-reporter.js";
import { CLI_ACCOUNT_PROFILES_EVENT } from "../../cli-account-profile-events.js";
import { useAutoDismiss, DEFAULT_NOTICE_DISMISS_MS } from "../../use-auto-dismiss.js";
import { publishPaneRunLifecycle } from "../../pane-run-lifecycle-events.js";
import {
  SPACE_CLIPBOARD_ITEM_MIME,
  SPACE_CLIPBOARD_ITEM_TITLE_MIME,
  SPACE_CLIPBOARD_UPDATED_EVENT,
  captureClipboardEventText,
  captureClipboardText,
  writeClipboardText
} from "../clipboard-dock/clipboard-events.js";
import { readArtifactDragPayload, resolveArtifactDragFile, type ArtifactDragPayload } from "../artifacts/artifact-drag.js";
import { SPACE_TASK_ITEM_MIME } from "../task-dock/task-events.js";
import {
  SPACE_PANE_CONTEXT_MIME,
  buildPaneTaskContextBlock,
  formatPaneContextBlock,
  readPaneContextDragPayload,
  type PaneContextDragPayload
} from "../pane-drag/pane-drag.js";
import { takeCliResumeIntent } from "./cli-resume-intent.js";
import { useVoiceInput } from "../voice-input/VoiceInputProvider.js";
import { VoiceInputButton } from "../voice-input/VoiceInputButton.js";
import { formatRecordingClock, previewTail, useRecordingElapsed } from "../voice-input/recording-clock.js";
import type { VoiceInsertMode } from "../../voice-settings.js";
import {
  registerTerminalPreviewGetter,
  notifyTerminalPreviewChangedThrottled,
  extractRecentTerminalLines,
  extractTranscriptLines,
  seedTerminalPreviewLines,
  appendTerminalPreviewChunk
} from "./terminal-preview-service.js";

export { isNonMutatingTerminalProtocolResponse };

import { reasoningEffortBadge, reasoningEffortLabel } from "../codex-model-picker/reasoning-effort.js";

const LazyCodexModelPicker = lazy(() =>
  import("../codex-model-picker/CodexModelPicker.js").then((module) => ({ default: module.CodexModelPicker }))
);
const modelPickerLoadingFallback = (
  <div className="terminal-model-picker">
    <button type="button" className="terminal-model-chip" aria-label="Loading model selector" disabled>
      <Loader2 aria-hidden="true" />
    </button>
  </div>
);

const TERMINAL_PAINT_PHASES = {
  initial: "PAINT_INITIAL",
  reveal: "PAINT_REVEAL",
  refit: "PAINT_REFIT",
  delayed: "PAINT_DELAYED",
  force: "PAINT_FORCE",
  background: "PAINT_BACKGROUND"
} as const;

export function buildTerminalVoiceSubmit(
  transcript: string,
  draft: string,
  insertMode: VoiceInsertMode
): { data: string; enter: "\r"; replace: boolean } | null {
  const normalized = transcript
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/gu, " ")
    .trim();
  if (!normalized) return null;
  if (insertMode === "replace") return { data: `\u0015${normalized}`, enter: "\r", replace: true };
  const separator = draft && !/\s$/.test(draft) ? " " : "";
  return { data: `${separator}${normalized}`, enter: "\r", replace: false };
}

interface TerminalPaneProps {
  pane: Pane;
  terminalFontSize: number;
  bootstrapBarrier?: TerminalBootstrapBarrier;
  shouldBootstrap?: boolean;
  prefillInitialReplay?: boolean;
  isTarget?: boolean;
  isVisible?: boolean;
  fullscreenLayout?: boolean;
  presizeInFullscreen?: boolean;
  observerOnly?: boolean;
  hideFloatingControls?: boolean;
  oskOpen?: boolean;
  mobile?: boolean;
  cliDebugModeEnabled?: boolean;
  maxImagePreviews?: number;
  onCliDebugModeChange?: (enabled: boolean) => void;
  onSessionMetadataChange?: (metadata: TerminalSessionMetadata | null) => void;
  onBootstrapped?: (paneId: string) => void;
  onPrefillReadyChange?: (paneId: string, ready: boolean) => void;
  revealGeneration?: number;
  onRevealReady?: (paneId: string, generation: number) => void;
  onWorkingStateChange?: (workingState: { isWorking: boolean; screenWorkingMs?: number | null }) => void;
  /** Live state the pane actions menu needs to disable items that cannot work right now. */
  onActionAvailabilityChange?: (availability: TerminalActionAvailability) => void;
}

export interface TerminalBootstrapBarrier {
  join(paneId: string): {
    arrive(): Promise<void>;
  };
  waitForTerminalSetupTask(paneId: string): Promise<void>;
}

export function createTerminalBootstrapBarrier(paneIds: readonly string[]): TerminalBootstrapBarrier {
  const isDemo = getSpaceRuntimeKind() === "demo";
  const expectedPaneIds = new Set(paneIds.filter((id) => !id.startsWith("pane:optimistic-")));
  const currentTokens = new Map<string, symbol>();
  const arrivedPaneIds = new Set<string>();
  let joinVersion = 0;
  let released = isDemo || expectedPaneIds.size === 0;
  let release: () => void = () => undefined;
  const ready = released
    ? Promise.resolve()
    : new Promise<void>((resolve) => {
        release = resolve;
      });
  const terminalSetupTurnByPaneId = new Map<string, { promise: Promise<void>; resolve: () => void }>();
  const requestedTerminalSetupPaneIds = new Set<string>();
  const resolvedTerminalSetupPaneIds = new Set<string>();
  let terminalSetupReady = released;
  let terminalSetupTaskScheduled = false;

  function scheduleTerminalSetupTask() {
    if (!terminalSetupReady || terminalSetupTaskScheduled || requestedTerminalSetupPaneIds.size === 0) return;
    if (isDemo) {
      terminalSetupTaskScheduled = true;
      const scheduleNext = typeof window !== "undefined" && typeof window.requestAnimationFrame === "function"
        ? window.requestAnimationFrame
        : (cb: () => void) => setTimeout(cb, 0);
      scheduleNext(() => {
        terminalSetupTaskScheduled = false;
        let count = 0;
        for (const paneId of Array.from(requestedTerminalSetupPaneIds)) {
          requestedTerminalSetupPaneIds.delete(paneId);
          resolvedTerminalSetupPaneIds.add(paneId);
          terminalSetupTurnByPaneId.get(paneId)?.resolve();
          count += 1;
          if (count >= 2) break;
        }
        if (requestedTerminalSetupPaneIds.size > 0) {
          scheduleTerminalSetupTask();
        }
      });
      return;
    }
    terminalSetupTaskScheduled = true;
    window.setTimeout(() => {
      terminalSetupTaskScheduled = false;
      const paneId = Array.from(expectedPaneIds).find((candidate) => requestedTerminalSetupPaneIds.has(candidate));
      if (!paneId) return;
      requestedTerminalSetupPaneIds.delete(paneId);
      resolvedTerminalSetupPaneIds.add(paneId);
      terminalSetupTurnByPaneId.get(paneId)?.resolve();
      // Let the resumed pane construct xterm before scheduling the next browser task.
      void Promise.resolve().then(scheduleTerminalSetupTask);
    }, 0);
  }

  void ready.then(() => {
    terminalSetupReady = true;
    scheduleTerminalSetupTask();
  });

  function scheduleRelease() {
    if (isDemo) {
      released = true;
      release();
      return;
    }
    const scheduledJoinVersion = joinVersion;
    void Promise.resolve().then(() => {
      if (
        released ||
        scheduledJoinVersion !== joinVersion ||
        arrivedPaneIds.size !== expectedPaneIds.size
      ) {
        return;
      }
      released = true;
      release();
    });
  }

  if (!released && typeof window !== "undefined") {
    window.setTimeout(() => {
      if (!released) {
        released = true;
        release();
      }
    }, isDemo ? 0 : 6000);
  }

  return {
    join(paneId) {
      if (released || !expectedPaneIds.has(paneId)) {
        return { arrive: () => Promise.resolve() };
      }
      const token = Symbol(paneId);
      let arrived = false;
      joinVersion += 1;
      currentTokens.set(paneId, token);
      arrivedPaneIds.delete(paneId);
      return {
        arrive() {
          if (!arrived) {
            arrived = true;
            if (currentTokens.get(paneId) === token) {
              arrivedPaneIds.add(paneId);
              if (arrivedPaneIds.size === expectedPaneIds.size) scheduleRelease();
            }
          }
          return ready;
        }
      };
    },
    waitForTerminalSetupTask(paneId) {
      if (!expectedPaneIds.has(paneId)) return Promise.resolve();
      let turn = terminalSetupTurnByPaneId.get(paneId);
      if (!turn) {
        let resolve: () => void = () => undefined;
        const promise = new Promise<void>((resolvePromise) => {
          resolve = resolvePromise;
        });
        turn = { promise, resolve };
        terminalSetupTurnByPaneId.set(paneId, turn);
      }
      if (!resolvedTerminalSetupPaneIds.has(paneId)) {
        requestedTerminalSetupPaneIds.add(paneId);
        scheduleTerminalSetupTask();
      }
      return turn.promise;
    }
  };
}

export function cliReadyMatchesExpectedIdentity(
  ready: { paneId: string; sessionId: string },
  expected: { paneId: string; sessionId: string }
): boolean {
  return ready.paneId === expected.paneId && ready.sessionId === expected.sessionId;
}

export interface TerminalSessionMetadata {
  sessionId: string | null;
  codexThreadId: string | null;
  runtimeId: string | null;
  purpose: PaneCliSessionResponse["session"]["purpose"];
}

const DEFAULT_CLI_RUNTIME_ID = "cli:codex";
const ROOT_CLI_RUNTIME_ID = "cli:root";
const CLAUDE_CLI_RUNTIME_ID = "cli:claude";
const OPENCODE_CLI_RUNTIME_ID = "cli:opencode";
const GEMINI_CLI_RUNTIME_ID = "cli:gemini";
const isCliModelSettingsRuntime = (runtimeId: string | null | undefined): boolean =>
  runtimeId === DEFAULT_CLI_RUNTIME_ID || runtimeId === OPENCODE_CLI_RUNTIME_ID;
const isTurnCapableRuntime = (runtimeId: string | null | undefined): boolean =>
  runtimeId === DEFAULT_CLI_RUNTIME_ID ||
  runtimeId === OPENCODE_CLI_RUNTIME_ID ||
  runtimeId === GEMINI_CLI_RUNTIME_ID;
const isModelPickerRuntime = (runtimeId: string | null | undefined): boolean =>
  Boolean(runtimeId?.startsWith("cli:") && runtimeId !== ROOT_CLI_RUNTIME_ID);
const isRunCapableCliSession = (
  session: Pick<PaneCliSessionResponse["session"], "purpose" | "runtimeId"> | null | undefined
): boolean => Boolean(session?.purpose === "NORMAL" && session.runtimeId !== ROOT_CLI_RUNTIME_ID);
type NativePlanRuntimeId = "cli:gemini" | "cli:qwen" | "cli:omp";
const TERMINAL_PANE_ACTION_EVENT = "space:terminal-pane-action";
const CLI_DEBUG_MODE_STORAGE_KEY = "space.cliDebugMode";
const TERMINAL_CONTROL_REPLAY_NOTICE = "Terminal control lease expired. Re-sending your last input.";
const NEW_PANE_ACCOUNT_WAIT_MS = 3_000;
const HIDDEN_INPUT_ECHO_TTL_MS = 5_000;
const PASTE_INPUT_GUARD_MS = 2_500;
const TURN_STOP_SETTLE_MS = 1_000;
// Claude Code's chat:killAgents chord (Ctrl+X Ctrl+K). The first press only asks for a second
// within 3 s, so one click never stops agents, and a double click must not confirm it either.
const CLAUDE_STOP_BACKGROUND_AGENTS_SEQUENCE = "\u0018\u000b";
const BACKGROUND_AGENT_STOP_CONFIRM_GAP_MS = 500;
const BACKGROUND_AGENT_STOP_LABEL = "Stop background agents (click twice)";
const CLIPBOARD_FAILURE_OUTPUT_PATTERN =
  /Failed to paste image:|clipboard unavailable: Unknown error while interacting with the clipboard:|X11 server connection timed out because it was unreachable/i;
const CLIPBOARD_FAILURE_REPORT_WINDOW_MS = 20_000;
const CLIPBOARD_FAILURE_SUPPRESS_AFTER_UPLOAD_MS = 10_000;
const CLIPBOARD_STALL_TIMEOUT_MS = 3_500;
const TERMINAL_PASTE_RECENT_INTENT_MS = 15_000;
const TERMINAL_OUTPUT_REFIT_INTERVAL_MS = 500;
const TERMINAL_SOCKET_WATCHDOG_INTERVAL_MS = 15_000;
const TERMINAL_SOCKET_PROBE_TIMEOUT_MS = 6_000;
const TERMINAL_INPUT_TOKENIZER_FLUSH_MS = 12;
const INITIAL_CLI_TERMINAL_COLS = 100;
const INITIAL_CLI_TERMINAL_ROWS = 30;
const CLI_RECONNECT_DELAYS_MS = [250, 1000, 2000, 5000, 10000] as const;
const CLI_RECONNECT_JITTER_MS = 100;
const CLI_TURN_ACTIVITY_POLL_MS = 900;
const CLI_FALLBACK_RUN_IDLE_MS = 8_000;
const CLI_MODEL_SETTINGS_REFRESH_DELAY_MS = 400;
// A fresh OpenCode pane can take a few seconds before the CLI's own model is
// readable (native footer / runtime server); keep re-reading long enough that
// the picker converges on the real model instead of keeping the pane's
// persisted default. A settled reading stops the retries immediately.
const CLI_MODEL_SETTINGS_STARTUP_RETRY_DELAYS_MS = [250, 500, 1_000, 2_000, 4_000, 8_000] as const;
const CLI_TURN_ACTIVITY_DISCOVERY_GRACE_MS = 5_000;
const ACTIVE_CLI_TURN_STORAGE_PREFIX = "space.cliActiveTurn:";
const CLI_TURN_MARKER_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ANSI_ESCAPE_PATTERN = /\u001B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;
const CONTROL_SEQUENCE_PATTERN = /[\u0000-\u0008\u000b-\u001f\u007f]/g;
const MANAGED_ATTACHMENT_NOTICE = "Attachment added to CLI prompt.";
const CLIPBOARD_TEXT_FILE_NOTICE = "Clip attached as TXT file.";
const HIDDEN_UPLOAD_NOTICE_DISMISS_MS = 1_600;
const BRACKETED_PASTE_START = "\u001b[200~";
const BRACKETED_PASTE_END = "\u001b[201~";







/** Copilot, Cursor and Kimi panes may run on Auto (Space picks and moves the account); new panes follow the last choice. */
function readLastAutoAccountMode(runtimeId: string): boolean {
  try {
    return getSpaceRuntime().platform.localStorage.getItem(`space.cli.${runtimeId.replace(/^cli:/, "")}.account-mode`) === "AUTO";
  } catch {
    return false;
  }
}

function writeLastAutoAccountMode(runtimeId: string, auto: boolean): void {
  try {
    getSpaceRuntime().platform.localStorage.setItem(`space.cli.${runtimeId.replace(/^cli:/, "")}.account-mode`, auto ? "AUTO" : "PROFILE");
  } catch {
    void 0;
  }
}





type TerminalModules = {
  Terminal: typeof import("@xterm/xterm").Terminal;
  FitAddon: typeof import("@xterm/addon-fit").FitAddon;
};

let terminalModulesPromise: Promise<TerminalModules> | null = null;

function loadTerminalModules(): Promise<TerminalModules> {
  if (terminalModulesPromise) return terminalModulesPromise;
  const pending = Promise.all([
    import("@xterm/xterm/css/xterm.css"),
    import("@xterm/xterm"),
    import("@xterm/addon-fit")
  ]).then(([, { Terminal }, { FitAddon }]) => ({ Terminal, FitAddon }));
  terminalModulesPromise = pending.catch((error: unknown) => {
    terminalModulesPromise = null;
    throw error;
  });
  return terminalModulesPromise;
}

type TerminalConnectionStatus = "idle" | "connecting" | "attached" | "reconnecting" | "closed";
const TERMINAL_SCREEN_ACTIVITY_WINDOW_MS = 2_500;
// Long enough for the double Ctrl+C exit window of Gemini, Qwen and similar CLIs to lapse.
const STOP_COOLDOWN_MS = 3_000;
type TerminalConnectionAlert = { message: string; tone: "warn" | "good" | "bad" };
type ActiveCliTurn = { marker: string; status: Extract<PaneCliTurnActivityStatus, "PENDING" | "RUNNING"> };
type StoredActiveCliTurn = ActiveCliTurn & { sessionId: string };
type TerminalControlSnapshot = {
  protocolVersion: 1 | 2;
  clientMode: "INTERACTIVE" | "OBSERVER";
  state: PaneCliTerminalControlState;
  leaseId: string | null;
  holderLeaseId: string | null;
  expiresAt: string | null;
  heartbeatIntervalMs: number;
};

const initialTerminalControlSnapshot: TerminalControlSnapshot = {
  protocolVersion: 1,
  clientMode: "INTERACTIVE",
  state: "AVAILABLE",
  leaseId: null,
  holderLeaseId: null,
  expiresAt: null,
  heartbeatIntervalMs: 10_000
};

type TerminalPaneActionDetail =
  | { paneId: string; action: "upload" | "reconnect" | "copy" | "paste" | "paste_file" | "focus" | "cancel_login" | "new_task" }
  | { paneId: string; action: "attach_clip_image"; file: File }
  | { paneId: string; action: "insert_text"; text: string }
  | { paneId: string; action: "keyboard_input"; text: string }
  | { paneId: string; action: "cli_shortcut"; commandId: string; handled?: boolean }
  | { paneId: string; action: "switch_model"; modelId: string; reasoningEffort: string }
  | { paneId: string; action: "insert_clipboard_text"; text: string }
  | { paneId: string; action: "start_task_item"; objective: string }
  | { paneId: string; action: "execute_plan"; plan: ClipboardItem }
  | { paneId: string; action: "ensure_plan_mode" }
  | { paneId: string; action: "enable_plan_mode" }
  | { paneId: string; action: "stop_task" }
  | { paneId: string; action: "enter_native_plan_mode"; runtimeId: NativePlanRuntimeId }
  | { paneId: string; action: "control_key"; key: "ctrl_c" | "shift_tab" | "escape" }
  | { paneId: string; action: "replace_session"; session: PaneCliSessionResponse }
  | {
      paneId: string;
      action: "save_to_memory";
      modelId: string;
      text: string;
      memory: {
        scope: "ROOM" | "PROJECT" | "SYSTEM";
        roomId?: string | null;
        title: string;
        provenance: string;
      };
    };

type ClipboardDebugSeverity = "info" | "good" | "bad";

interface ClipboardDebugState {
  title: string;
  detail: string;
  severity: ClipboardDebugSeverity;
  at: string;
}

interface ClipboardDataSnapshot {
  summary: string;
  text: string;
}

interface HiddenInputEchoFilter {
  value: string;
  remaining: string;
  expiresAtMs: number;
}

interface PendingTerminalInput {
  data: string;
  source: string;
  display: "visible" | "hidden";
  preserveNotice: boolean;
  options: { turnMarker?: string; trackDraft?: boolean };
}

interface ManagedPromptAttachment {
  token: string;
  terminalInputPath: string;
}

interface ManagedPromptAttachmentState {
  imageCount: number;
  videoCount: number;
  fileCount: number;
  pending: ManagedPromptAttachment[];
}

interface TerminalPromptDraftState {
  text: string;
  cursor: number;
}

interface ModelSettingsOutputRefreshArm {
  socket: WebSocket;
  sessionId: string;
  token: number;
  outputRevision: number;
  terminal: XtermTerminal;
  baselineScreen: string;
}

type TerminalWebSocketTicket = NonNullable<PaneCliSessionResponse["websocket"]>;
type BufferedTerminalSocketEvent =
  | { type: "message"; event: MessageEvent }
  | { type: "disconnect"; event: Event };

interface BufferedTerminalSocket {
  ticket: TerminalWebSocketTicket;
  clientMode: "INTERACTIVE" | "OBSERVER";
  socket: WebSocket;
  events: BufferedTerminalSocketEvent[];
  preopen: Promise<void>;
  stopBuffering(): void;
}

const TERMINAL_SOCKET_PREOPEN_TIMEOUT_MS = 400;
const TERMINAL_REPLAY_WRITE_CHUNK_SIZE = 1024 * 1024;
const TERMINAL_SOCKET_SUPERSEDED_CLOSE_CODE = 4001;
const TERMINAL_UPLOAD_CONTROL_TIMEOUT_MS = 4_000;

interface BrowserTaskScheduler {
  yield?: () => Promise<void>;
}

function yieldForTerminalReplay(): Promise<void> {
  const scheduler = (globalThis as typeof globalThis & { scheduler?: BrowserTaskScheduler }).scheduler;
  if (scheduler?.yield) return scheduler.yield();
  return new Promise<void>((resolve) => window.setTimeout(resolve, 0));
}

export function createTerminalReplayWriteQueue(
  write: (data: string, mode: TerminalOutputWriteMode) => Promise<void>,
  yieldControl: () => Promise<void> = yieldForTerminalReplay,
  shouldYield: () => boolean = () => true,
  coalesceInitialPrefill = false
) {
  let tail = Promise.resolve();
  let hasWritten = false;
  let disposed = false;
  let pendingPrefillBatch: { chunks: string[]; bytes: number; operation: Promise<void> } | null = null;
  const encoder = new TextEncoder();

  return {
    enqueue(data: string, mode: TerminalOutputWriteMode = "VISIBLE"): Promise<void> {
      if (!data || disposed) return tail;
      const batchable = coalesceInitialPrefill && mode === "PREFILL" && !shouldYield();
      const bytes = batchable ? encoder.encode(data).byteLength : 0;
      if (batchable && pendingPrefillBatch && pendingPrefillBatch.chunks.length < 32 &&
          pendingPrefillBatch.bytes + bytes <= 64 * 1024) {
        pendingPrefillBatch.chunks.push(data);
        pendingPrefillBatch.bytes += bytes;
        return pendingPrefillBatch.operation;
      }
      // A live frame seals the preceding batch; never merge across modes.
      pendingPrefillBatch = null;
      const batch = { chunks: [data], bytes, operation: Promise.resolve() };
      const operation = tail.then(async () => {
        if (pendingPrefillBatch === batch) pendingPrefillBatch = null;
        if (disposed) return;
        if (hasWritten && shouldYield()) await yieldControl();
        if (disposed) return;
        await write(batch.chunks.join(""), mode);
        hasWritten = true;
      });
      batch.operation = operation;
      if (batchable) pendingPrefillBatch = batch;
      tail = operation;
      return operation;
    },
    async drain(): Promise<void> {
      let observed: Promise<void>;
      do {
        observed = tail;
        await observed;
      } while (observed !== tail);
    },
    dispose() {
      disposed = true;
    }
  };
}

function terminalReplayChunkEnd(data: string, start: number): number {
  let end = Math.min(data.length, start + TERMINAL_REPLAY_WRITE_CHUNK_SIZE);
  if (
    end < data.length &&
    end > start &&
    data.charCodeAt(end - 1) >= 0xd800 &&
    data.charCodeAt(end - 1) <= 0xdbff &&
    data.charCodeAt(end) >= 0xdc00 &&
    data.charCodeAt(end) <= 0xdfff
  ) {
    end -= 1;
  }
  return end;
}

function terminalWebSocketTicketsMatch(left: TerminalWebSocketTicket, right: TerminalWebSocketTicket): boolean {
  return left.paneId === right.paneId && left.sessionId === right.sessionId && left.token === right.token;
}

function createBufferedTerminalSocket(
  ticket: TerminalWebSocketTicket,
  options: {
    clientMode: "INTERACTIVE" | "OBSERVER";
    leaseId?: string | null;
    initialCols?: number;
    initialRows?: number;
  }
): BufferedTerminalSocket {
  const socket = terminalGateway.connect(api.cliTerminalWebSocketUrl(ticket, options));
  const events: BufferedTerminalSocketEvent[] = [];
  const preopen = socket.readyState === WebSocket.CONNECTING
    ? new Promise<void>((resolve) => {
        let settled = false;
        const settle = () => {
          if (settled) return;
          settled = true;
          window.clearTimeout(timeout);
          socket.removeEventListener("open", settle);
          socket.removeEventListener("close", settle);
          socket.removeEventListener("error", settle);
          resolve();
        };
        const timeout = window.setTimeout(settle, TERMINAL_SOCKET_PREOPEN_TIMEOUT_MS);
        socket.addEventListener("open", settle);
        socket.addEventListener("close", settle);
        socket.addEventListener("error", settle);
      })
    : Promise.resolve();
  const bufferMessage = (event: MessageEvent) => {
    events.push({ type: "message", event });
  };
  const bufferDisconnect = (event: Event) => {
    events.push({ type: "disconnect", event });
  };
  let buffering = true;
  const stopBuffering = () => {
    if (!buffering) return;
    buffering = false;
    socket.removeEventListener("message", bufferMessage);
    socket.removeEventListener("close", bufferDisconnect);
    socket.removeEventListener("error", bufferDisconnect);
  };
  socket.addEventListener("message", bufferMessage);
  socket.addEventListener("close", bufferDisconnect);
  socket.addEventListener("error", bufferDisconnect);
  return { ticket, clientMode: options.clientMode, socket, events, preopen, stopBuffering };
}

function closeBufferedTerminalSocket(bufferedSocket: BufferedTerminalSocket | null): void {
  bufferedSocket?.stopBuffering();
  bufferedSocket?.socket.close();
}

interface ClipboardPasteAttempt {
  source: string;
  detail: string;
  startedAtMs: number;
  uploadPendingAtMs: number | null;
  uploadSucceededAtMs: number | null;
}

interface XtermPrivateCharSizeService {
  measure(): void;
}

interface XtermPrivateCore {
  _charSizeService?: XtermPrivateCharSizeService;
}

function describeEventTarget(target: EventTarget | null | undefined): string {
  if (!target) return "none";
  if (typeof Document !== "undefined" && target instanceof Document) return "document";
  if (typeof Window !== "undefined" && target instanceof Window) return "window";
  if (typeof HTMLElement !== "undefined" && target instanceof HTMLElement) {
    const id = target.id ? `#${target.id}` : "";
    const className = typeof target.className === "string" && target.className.trim() ? `.${target.className.trim().replace(/\s+/g, ".")}` : "";
    return `${target.tagName.toLowerCase()}${id}${className}`;
  }
  if (typeof Node !== "undefined" && target instanceof Node) return target.nodeName.toLowerCase();
  return Object.prototype.toString.call(target);
}

function describeTerminalRouting(target: EventTarget | null | undefined, activeElement: Element | null | undefined, host: HTMLElement | null): string {
  const targetInTerminal = Boolean(host && typeof Node !== "undefined" && target instanceof Node && host.contains(target));
  const activeInTerminal = Boolean(host && typeof Node !== "undefined" && activeElement instanceof Node && host.contains(activeElement));
  return [
    `target=${describeEventTarget(target)}`,
    `active=${describeEventTarget(activeElement)}`,
    `targetInTerminal=${targetInTerminal}`,
    `activeInTerminal=${activeInTerminal}`
  ].join("; ");
}

function summarizeClipboardFailureOutput(text: string): string {
  return text
    .replace(ANSI_ESCAPE_PATTERN, " ")
    .replace(CONTROL_SEQUENCE_PATTERN, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
}

function cliReconnectDelayMs(attempt: number): number {
  const baseDelay = CLI_RECONNECT_DELAYS_MS[Math.min(attempt, CLI_RECONNECT_DELAYS_MS.length - 1)] ?? CLI_RECONNECT_DELAYS_MS[0];
  return baseDelay + Math.floor(Math.random() * CLI_RECONNECT_JITTER_MS);
}

function cliControlRevocationTelemetryReason(
  reason: "TAKEN_OVER" | "RELEASED" | "EXPIRED" | "SESSION_ENDED"
): CliTerminalClientEventInput["reason"] {
  if (reason === "TAKEN_OVER") return "TAKEN_OVER";
  if (reason === "RELEASED") return "CONTROL_RELEASED";
  if (reason === "EXPIRED") return "LEASE_STALE";
  return "SESSION_CLOSED";
}

function cliControlDenialTelemetryReason(code: string): CliTerminalClientEventInput["reason"] {
  if (code === "CLI_CONTROL_REQUIRED") return "CONTROL_REQUIRED";
  if (code === "CLI_LEASE_STALE") return "LEASE_STALE";
  if (code === "CLI_CONTROL_HELD") return "CONTROL_HELD";
  if (code === "CLI_OBSERVER_MUTATION_DENIED") return "OBSERVER_DENIED";
  if (code === "CLI_PROTOCOL_REQUIRED") return "PROTOCOL_REQUIRED";
  return "UNKNOWN";
}

export function isRetryableCliReconnectError(error: unknown): boolean {
  if (error instanceof SpaceApiError) {
    return (
      error.status === 0 ||
      error.status === 429 ||
      error.status >= 500 ||
      error.code === "REQUEST_TIMEOUT" ||
      error.code === "UPSTREAM_UNAVAILABLE" ||
      error.code === "CLI_SOCKET_ERROR"
    );
  }
  if (error instanceof TypeError) return true;
  if (typeof DOMException !== "undefined" && error instanceof DOMException) {
    return error.name === "AbortError" || error.name === "TimeoutError" || error.name === "NetworkError";
  }
  if (error instanceof Error) {
    const msg = error.message.toLowerCase();
    return (
      msg.includes("fetch") ||
      msg.includes("network") ||
      msg.includes("timeout") ||
      msg.includes("timed out") ||
      msg.includes("upstream") ||
      msg.includes("502") ||
      msg.includes("503") ||
      msg.includes("504") ||
      msg.includes("econnrefused") ||
      msg.includes("econnreset") ||
      msg.includes("epipe") ||
      msg.includes("html error page")
    );
  }
  return false;
}

export function buildTerminalCliSessionRequest(
  pane: Pick<Pane, "reasoningEffort" | "cwd">,
  runtimeId: string,
  input: { accountProfileId?: string | null; accountMode?: "AUTO"; modelId?: string | null; reasoningEffort?: Pane["reasoningEffort"]; forceRestart?: boolean; resume?: boolean } = {},
  automaticReconnect = false
) {
  return {
    runtimeId,
    ...(automaticReconnect
      ? {}
      : {
          ...(input.modelId !== undefined ? { modelId: input.modelId } : {}),
          ...(input.accountMode === "AUTO" ? { accountMode: "AUTO" as const }
            : input.accountProfileId !== undefined ? { accountProfileId: input.accountProfileId } : {}),
          reasoningEffort: input.reasoningEffort ?? (runtimeId === "cli:gemini" && (!pane.reasoningEffort || pane.reasoningEffort === "medium") ? "high" : pane.reasoningEffort),
          cwd: pane.cwd,
          ...(input.forceRestart ? { forceRestart: true } : {}),
          ...(input.resume ? { resume: true } : {})
        }),
    includeTranscript: false
  };
}

export function createTerminalReconnectCoordinator() {
  let socketGeneration = 0;
  let disconnectedGeneration: number | null = null;
  let sessionRequestFlight: Promise<unknown> | null = null;

  return {
    beginSocketGeneration(): number {
      socketGeneration += 1;
      disconnectedGeneration = null;
      return socketGeneration;
    },
    isCurrentSocketGeneration(generation: number): boolean {
      return generation === socketGeneration;
    },
    markDisconnected(generation: number): boolean {
      if (generation !== socketGeneration || disconnectedGeneration === generation) return false;
      disconnectedGeneration = generation;
      return true;
    },
    invalidateSocketGeneration(generation: number): void {
      if (generation !== socketGeneration) return;
      socketGeneration += 1;
      disconnectedGeneration = null;
    },
    invalidateCurrentSocketGeneration(): void {
      socketGeneration += 1;
      disconnectedGeneration = null;
    },
    runSessionRequest<T>(request: () => Promise<T>): Promise<T> {
      if (sessionRequestFlight) return sessionRequestFlight as Promise<T>;
      let flightTimeout: ReturnType<typeof setTimeout> | null = null;
      const flight = Promise.race([
        request(),
        new Promise<never>((_, reject) => {
          flightTimeout = setTimeout(() => {
            reject(
              new SpaceApiError("Terminal session request flight timed out", {
                code: "REQUEST_TIMEOUT",
                status: 0
              })
            );
          }, 10_000);
        })
      ]).finally(() => {
        if (flightTimeout !== null) clearTimeout(flightTimeout);
        if (sessionRequestFlight === flight) sessionRequestFlight = null;
      });
      sessionRequestFlight = flight;
      return flight;
    },
    clearSessionRequestFlight(): void {
      sessionRequestFlight = null;
    }
  };
}

export function shouldReconnectTerminalSocket(event: Event): boolean {
  return !(
    event.type === "close" &&
    "code" in event &&
    event.code === TERMINAL_SOCKET_SUPERSEDED_CLOSE_CODE
  );
}

export function shouldRequestTerminalControl(input: {
  isVisible: boolean;
  isMinimized: boolean;
  documentVisibility: DocumentVisibilityState;
  documentHasFocus: boolean;
  realInteraction?: boolean;
  readOnly?: boolean;
}): boolean {
  if (input.readOnly || !input.isVisible || input.isMinimized) {
    return false;
  }
  if (input.realInteraction === true) {
    return true;
  }
  return input.documentVisibility === "visible" && input.documentHasFocus;
}

function isRecoverableCliSession(session: PaneCliSessionResponse["session"] | null | undefined): boolean {
  return Boolean(session?.isActive && session.status !== "EXITED" && session.status !== "ERROR");
}

function streamLabel(stream: string): string {
  if (stream === "stderr") return "err";
  if (stream === "stdin") return "in";
  if (stream === "system") return "sys";
  return "out";
}

function terminalTranscriptSeed(sessionResponse: PaneCliSessionResponse): string[] {
  const shouldSeedOutputTranscript = sessionResponse.session.status !== "RUNNING";
  const chunks: string[] = [];
  for (const chunk of sessionResponse.transcript) {
    if (chunk.stream === "stdin") continue;
    if ((chunk.stream === "stdout" || chunk.stream === "stderr") && !shouldSeedOutputTranscript) continue;
    const content =
      chunk.stream === "system" && !chunk.content.endsWith("\n") ? `${chunk.content}\r\n` : chunk.content;
    if (!content) continue;
    chunks.push(content);
  }
  return chunks;
}

function isTerminalPaneAction(detail: unknown): detail is TerminalPaneActionDetail {
  if (typeof detail !== "object" || detail === null) return false;
  const maybeDetail = detail as {
    paneId?: unknown;
    action?: unknown;
    file?: unknown;
    text?: unknown;
    objective?: unknown;
    plan?: unknown;
    commandId?: unknown;
    key?: unknown;
    runtimeId?: unknown;
    session?: unknown;
    modelId?: unknown;
    reasoningEffort?: unknown;
    memory?: { scope?: unknown; roomId?: unknown; title?: unknown; provenance?: unknown };
  };
  if (typeof maybeDetail.paneId !== "string") return false;
  if (
    maybeDetail.action === "upload" ||
    maybeDetail.action === "reconnect" ||
    maybeDetail.action === "copy" ||
    maybeDetail.action === "paste" ||
    maybeDetail.action === "paste_file" ||
    maybeDetail.action === "focus" ||
    maybeDetail.action === "cancel_login" ||
    maybeDetail.action === "ensure_plan_mode" ||
    maybeDetail.action === "enable_plan_mode" ||
    maybeDetail.action === "stop_task" ||
    maybeDetail.action === "new_task"
  ) return true;
  if (maybeDetail.action === "attach_clip_image") {
    return maybeDetail.file instanceof File && SUPPORTED_CLIPBOARD_IMAGE_TYPES.has(maybeDetail.file.type.toLowerCase());
  }
  if (
    maybeDetail.action === "insert_text" ||
    maybeDetail.action === "insert_clipboard_text" ||
    maybeDetail.action === "keyboard_input"
  ) {
    return typeof maybeDetail.text === "string";
  }
  if (maybeDetail.action === "cli_shortcut") {
    return (
      OSK_CLI_COMMANDS.some((command) => command.id === maybeDetail.commandId) ||
      maybeDetail.commandId === "esc" ||
      maybeDetail.commandId === "enter"
    );
  }
  if (maybeDetail.action === "switch_model") {
    return typeof maybeDetail.modelId === "string" && typeof maybeDetail.reasoningEffort === "string";
  }
  if (maybeDetail.action === "start_task_item") {
    return typeof maybeDetail.objective === "string";
  }
  if (maybeDetail.action === "execute_plan") {
    const plan = (maybeDetail as any).plan;
    return (
      typeof plan === "object" &&
      plan !== null &&
      typeof plan.id === "string" &&
      typeof plan.text === "string"
    );
  }
  if (maybeDetail.action === "control_key") {
    return maybeDetail.key === "ctrl_c" || maybeDetail.key === "shift_tab" || maybeDetail.key === "escape";
  }
  if (maybeDetail.action === "enter_native_plan_mode") {
    return maybeDetail.runtimeId === "cli:gemini" || maybeDetail.runtimeId === "cli:qwen" || maybeDetail.runtimeId === "cli:omp";
  }
  if (maybeDetail.action === "replace_session") return paneCliSessionResponseSchema.safeParse(maybeDetail.session).success;
  return (
    maybeDetail.action === "save_to_memory" &&
    typeof maybeDetail.modelId === "string" &&
    typeof maybeDetail.text === "string" &&
    (maybeDetail.memory?.scope === "ROOM" || maybeDetail.memory?.scope === "PROJECT" || maybeDetail.memory?.scope === "SYSTEM") &&
    typeof maybeDetail.memory?.title === "string" &&
    typeof maybeDetail.memory?.provenance === "string" &&
    (maybeDetail.memory?.roomId === undefined || maybeDetail.memory?.roomId === null || typeof maybeDetail.memory.roomId === "string")
  );
}

function readStoredCliDebugMode(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return getSpaceRuntime().platform.localStorage.getItem(CLI_DEBUG_MODE_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

const SUPPORTED_CLIPBOARD_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const VIDEO_FILE_EXTENSION_PATTERN = /\.(?:avi|m4v|mkv|mov|mp4|mpeg|mpg|ogv|webm)$/i;

function imageExtension(mimeType: string): string {
  if (mimeType === "image/jpeg") return "jpg";
  if (mimeType === "image/webp") return "webp";
  return "png";
}

function dedupeFiles(files: File[]): File[] {
  const byKey = new Map<string, File>();
  for (const file of files) {
    byKey.set(`${file.name}:${file.size}:${file.type}:${file.lastModified}`, file);
  }
  return Array.from(byKey.values());
}

function dedupeClipboardFiles(files: File[]): File[] {
  const byKey = new Map<string, File>();
  for (const file of files) {
    byKey.set(`${file.name}:${file.size}:${file.type}`, file);
  }
  return Array.from(byKey.values());
}

function terminalCharacterCellSize(terminal: XtermTerminal | null): { width: number; height: number } {
  const core = (terminal as (XtermTerminal & { _core?: XtermPrivateCore }) | null)?._core;
  const size = core?._charSizeService as unknown as { width?: number; height?: number } | undefined;
  return {
    width: size?.width ?? 0,
    height: size?.height ?? 0
  };
}

function measureTerminalCharacterSize(terminal: XtermTerminal | null) {
  const core = (terminal as (XtermTerminal & { _core?: XtermPrivateCore }) | null)?._core;
  core?._charSizeService?.measure();
}

function canUsePlainTerminalPath(file: PaneCliUploadedFile): boolean {
  return file.isImage && /^\/[^\s'"\\\u0000-\u001f\u007f]+$/.test(file.terminalPath);
}

function terminalInputPath(file: PaneCliUploadedFile): string {
  return canUsePlainTerminalPath(file) ? file.terminalPath : file.shellQuotedPath;
}

function terminalImagePaste(file: PaneCliUploadedFile): string {
  return `${BRACKETED_PASTE_START}${file.terminalPath}${BRACKETED_PASTE_END}`;
}

function isVideoUpload(file: PaneCliUploadedFile): boolean {
  return file.mimeType.toLowerCase().startsWith("video/") ||
    VIDEO_FILE_EXTENSION_PATTERN.test(file.originalFilename);
}

function clipboardTextFilename(now = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `space-clipboard-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}.txt`;
}

function containsCliUploadPath(text: string): boolean {
  return text.includes("/opt/spaceapp/var/artifacts/cli-uploads/") || text.includes("/cli-uploads/");
}

// Match the host's disjoint wrap branches to avoid freezing on PTY padding.
export const CLI_UPLOAD_WRAPPED_PATH_PATTERN =
  /(?<![ \t\r\n])(?:[ \t\r\n]|\x1b\[[0-9;?]*[ -/]*[@-~])*['"]?(?:\/srv\/space\/var\/artifacts)?\/cli-uploads\/(?:[a-zA-Z0-9_.\/-]|\x1b\[[0-9;?]*[ -/]*[@-~]|[\r\n][ \t]*|(?<![ \t\r\n])[ \t]+(?=[\r\n]))+\.[a-zA-Z0-9]{1,10}['"]?[ \t]*/gi;

const CLI_UPLOAD_PATH_SEPARATOR_PATTERN = /(\x1b\[[0-9;?]*[ -/]*[@-~]|[ \t\r\n])/;
const CLI_UPLOAD_PATH_START_PATTERN = /(?=\/srv\/space\/var\/artifacts\/cli-uploads\/)|(?<!\/srv\/space\/var\/artifacts)(?=\/cli-uploads\/)/;

function uploadPathLabel(pathText: string): string {
  if (!pathText.includes("/cli-uploads/")) return " ".repeat(pathText.length);
  const fileName = pathText.replace(/['"]/g, "").split("/").pop() ?? "";
  const originalName = fileName.replace(/^upload_[A-Za-z0-9_-]{12}-/, "") || fileName;
  return `[upload: ${originalName}]`.slice(0, pathText.length).padEnd(pathText.length, " ");
}

function maskUploadPathMatch(match: string): string {
  const parts = match.split(CLI_UPLOAD_PATH_SEPARATOR_PATTERN);
  let pathText = "";
  for (let index = 0; index < parts.length; index += 2) pathText += parts[index];
  const label = pathText.split(CLI_UPLOAD_PATH_START_PATTERN).map(uploadPathLabel).join("");
  let offset = 0;
  return parts.map((part, index) => {
    if (index % 2 === 1) return part;
    const masked = label.slice(offset, offset + part.length);
    offset += part.length;
    return masked;
  }).join("");
}

/**
 * Mirror of the pane host's in-place upload path mask. Bytes are never
 * removed: TUIs such as Claude Code redraw with relative cursor moves, so a
 * dropped newline, escape sequence or cell blanks or scrambles later frames.
 */
export function maskUploadPaths(text: string): string {
  if (!text.includes("/cli-uploads/")) return text;
  return text.replace(CLI_UPLOAD_WRAPPED_PATH_PATTERN, maskUploadPathMatch);
}

export function hiddenEchoCandidates(data: string): string[] {
  const candidates = new Set<string>();
  if (data) candidates.add(data);
  if (data.startsWith(BRACKETED_PASTE_START) && data.endsWith(BRACKETED_PASTE_END)) {
    const bracketedPayload = data.slice(BRACKETED_PASTE_START.length, -BRACKETED_PASTE_END.length);
    if (bracketedPayload) candidates.add(bracketedPayload);
  }
  for (const token of data.split(/\s+/)) {
    if (token.length >= 8) candidates.add(token);
  }
  return Array.from(candidates);
}

export function plainTextHiddenEchoCandidates(data: string): string[] {
  return hiddenEchoCandidates(data).filter((candidate) => !/[\u0000-\u001f\u007f-\u009f]/.test(candidate));
}

function longestHiddenEchoPrefixAtEnd(output: string, hidden: string): number {
  const maxLength = Math.min(output.length, hidden.length - 1);
  for (let length = maxLength; length > 0; length -= 1) {
    if (output.endsWith(hidden.slice(0, length))) return length;
  }
  return 0;
}

function isEditablePasteTarget(target: EventTarget | null | undefined): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target instanceof HTMLTextAreaElement || target.isContentEditable) return true;
  if (target instanceof HTMLSelectElement) return true;
  if (target instanceof HTMLInputElement) {
    const type = (target.type || "text").toLowerCase();
    return !["button", "checkbox", "color", "file", "hidden", "image", "radio", "range", "reset", "submit"].includes(type);
  }
  return false;
}

export function encodeSgrMouseWheel(deltaY: number, col: number, row: number): string {
  const safeCol = Math.max(1, Number.isFinite(col) ? Math.floor(col) : 1);
  const safeRow = Math.max(1, Number.isFinite(row) ? Math.floor(row) : 1);
  const button = deltaY > 0 ? 65 : 64;
  return `\u001b[<${button};${safeCol};${safeRow}M`;
}
export function wheelDeltaPx(deltaY: number, deltaMode: number, lineHeightPx: number, pageHeightPx: number): number {
  return deltaMode === 1 ? deltaY * lineHeightPx : deltaMode === 2 ? deltaY * pageHeightPx : deltaY;
}
export function accumulateTouchScrollLines(pendingPx: number, deltaY: number, lineHeightPx: number): { lines: number; pendingPx: number } {
  const height = Math.max(1, lineHeightPx);
  const total = pendingPx + deltaY;
  const lines = Math.trunc(total / height);
  return { lines, pendingPx: total - lines * height };
}

export function scrollXtermByTouchLines(terminal: XtermTerminal | null, lines: number): boolean {
  if (!terminal) return false;
  const buffer = terminal.buffer?.active;
  if (!buffer) return false;
  if (lines > 0 && buffer.viewportY >= buffer.baseY) return false;
  if (lines < 0 && buffer.viewportY <= 0) return false;
  if (lines === 0) return false;
  terminal.scrollLines(lines);
  return true;
}

export function checkHasScrollbackContent(buffer: XtermTerminal["buffer"]["active"], baseY: number): boolean {
  if (baseY <= 0) return false;
  if (typeof buffer?.getLine !== "function") return true;
  const checkLimit = Math.max(0, baseY - 50);
  for (let y = baseY - 1; y >= checkLimit; y--) {
    const line = buffer.getLine(y);
    if (line && typeof line.translateToString === "function" && line.translateToString(true).trim().length > 0) {
      return true;
    }
  }
  if (baseY > 50) return true;
  return false;
}

export function clearTerminalViewportEvidence(host: HTMLElement | null): void {
  if (!host) return;
  delete host.dataset.terminalViewportY;
  delete host.dataset.terminalBaseY;
  delete host.dataset.terminalCursorY;
  delete host.dataset.terminalCursorAbsoluteY;
  delete host.dataset.terminalAtBottom;
  delete host.dataset.terminalCursorInViewport;
  delete host.dataset.terminalOutputParsed;
  delete host.dataset.terminalHasScrollback;
}

export function syncTerminalViewportEvidence(
  host: HTMLElement | null,
  terminal: XtermTerminal | null
): void {
  if (!host || !terminal) {
    clearTerminalViewportEvidence(host);
    return;
  }
  const buffer = terminal.buffer.active;
  const viewportY = buffer.viewportY;
  const baseY = buffer.baseY;
  const cursorY = buffer.cursorY;
  if (
    !Number.isInteger(viewportY) ||
    !Number.isInteger(baseY) ||
    !Number.isInteger(cursorY) ||
    viewportY < 0 ||
    baseY < 0 ||
    cursorY < 0
  ) {
    clearTerminalViewportEvidence(host);
    return;
  }
  const cursorAbsoluteY = baseY + cursorY;
  const hasScrollback =
    baseY > 0 &&
    (viewportY < baseY || checkHasScrollbackContent(buffer, baseY));
  // Reassigning an unchanged data attribute still emits a DOM mutation and can
  // invalidate descendant styles (notably the scrollbar). Warm reveals and
  // output callbacks often report the same viewport several times per frame.
  const evidence = {
    terminalViewportY: String(viewportY),
    terminalBaseY: String(baseY),
    terminalCursorY: String(cursorY),
    terminalCursorAbsoluteY: String(cursorAbsoluteY),
    terminalAtBottom: String(viewportY === baseY),
    terminalCursorInViewport: String(cursorAbsoluteY >= viewportY && cursorAbsoluteY < viewportY + terminal.rows),
    terminalHasScrollback: String(hasScrollback)
  };
  for (const [key, value] of Object.entries(evidence)) {
    if (host.dataset[key] !== value) host.dataset[key] = value;
  }
}

function isPasteShortcutEvent(event: Pick<KeyboardEvent, "altKey" | "code" | "ctrlKey" | "defaultPrevented" | "key" | "metaKey" | "shiftKey">): boolean {
  if (event.defaultPrevented || event.altKey || event.shiftKey || (!event.ctrlKey && !event.metaKey)) return false;
  if (event.code === "KeyV") return true;
  return event.key.toLowerCase() === "v";
}

function isCopyShortcutEvent(event: Pick<KeyboardEvent, "altKey" | "code" | "ctrlKey" | "defaultPrevented" | "key" | "metaKey" | "shiftKey">): boolean {
  if (event.defaultPrevented || event.altKey || event.shiftKey || (!event.ctrlKey && !event.metaKey)) return false;
  if (event.code === "KeyC") return true;
  return event.key.toLowerCase() === "c";
}

export function terminalControlKeySequence(key: "ctrl_c" | "shift_tab" | "escape"): string {
  if (key === "ctrl_c") return "\u0003";
  return key === "shift_tab" ? "\u001b[Z" : "\u001b";
}

/**
 * Interrupt key for the floating turn-control button per CLI runtime. Codex,
 * Claude Code, Oh My Pi and Droid interrupt their running turn on ESC; Claude
 * treats a second Ctrl-C on an idle prompt as exit and Oh My Pi uses Ctrl-C to
 * clear, so they must not get 0x03. The other CLIs cancel on Ctrl-C (0x03).
 */
export function floatingTurnPauseSequence(runtimeId: string | null | undefined): string {
  return terminalControlKeySequence(cliTurnInterruptKey(runtimeId));
}

const FLOATING_STOP_LABELS: Readonly<Record<string, string>> = {
  "cli:autohand": "Stop Autohand",
  "cli:claude": "Stop Claude",
  "cli:codex": "Stop Codex",
  "cli:copilot": "Stop Copilot",
  "cli:cursor": "Stop Cursor",
  "cli:deepseek": "Stop DeepSeek",
  "cli:gemini": "Stop Gemini",
  "cli:grok": "Stop Grok",
  "cli:hermes": "Stop Hermes",
  "cli:kimi": "Stop Kimi",
  "cli:opencode": "Stop OpenCode",
  "cli:qwen": "Stop Qwen"
};

/** Accessible stop label for the floating turn-control button per CLI runtime. */
export function floatingTurnControlStopLabel(runtimeId: string | null | undefined): string {
  if (!runtimeId) return "Stop CLI";
  const catalogLabel = CLI_PANE_TYPES.find((type) => type.id === runtimeId)?.shortLabel;
  return FLOATING_STOP_LABELS[runtimeId] ?? (catalogLabel ? `Stop ${catalogLabel}` : "Stop CLI");
}

export function reasonixShortcutSequence(
  event: Pick<KeyboardEvent, "altKey" | "code" | "ctrlKey" | "defaultPrevented" | "key" | "metaKey" | "shiftKey">
): string | null {
  if (event.altKey || event.metaKey) return null;
  if (
    !event.ctrlKey &&
    event.shiftKey &&
    (event.code === "Tab" || event.key === "Tab" || event.key === "ISO_Left_Tab")
  ) {
    return terminalControlKeySequence("shift_tab");
  }
  if (event.defaultPrevented) return null;
  if (event.ctrlKey && !event.shiftKey && (event.code === "KeyY" || event.key.toLowerCase() === "y")) {
    return "\u0019";
  }
  return null;
}

function fileFromDataUrl(src: string, index: number): File | null {
  const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/i.exec(src.trim());
  if (!match) return null;
  const mimeType = match[1]?.toLowerCase() ?? "";
  if (!SUPPORTED_CLIPBOARD_IMAGE_TYPES.has(mimeType)) return null;
  const binary = window.atob(match[2] ?? "");
  const bytes = new Uint8Array(binary.length);
  for (let offset = 0; offset < binary.length; offset += 1) {
    bytes[offset] = binary.charCodeAt(offset);
  }
  return new File([bytes], `clipboard-image-${index}.${imageExtension(mimeType)}`, { type: mimeType });
}

function extractImageDataUrlFiles(clipboardData: DataTransfer): File[] {
  const html = clipboardData.getData("text/html");
  if (!html) return [];
  const doc = new DOMParser().parseFromString(html, "text/html");
  return Array.from(doc.querySelectorAll("img"))
    .map((image, index) => fileFromDataUrl(image.getAttribute("src") ?? "", index + 1))
    .filter((file): file is File => Boolean(file));
}

function extractClipboardFilesFromData(clipboardData: DataTransfer): File[] {
  const files = Array.from(clipboardData.files ?? []);
  const itemFiles = Array.from(clipboardData.items ?? [])
    .filter((item) => item.kind === "file")
    .map((item) => item.getAsFile())
    .filter((file): file is File => Boolean(file));
  if (files.length) return dedupeClipboardFiles(files);
  if (itemFiles.length) return dedupeClipboardFiles(itemFiles);
  return dedupeClipboardFiles(extractImageDataUrlFiles(clipboardData));
}

function extractClipboardFiles(event: ReactClipboardEvent<HTMLElement> | globalThis.ClipboardEvent): File[] {
  return event.clipboardData ? extractClipboardFilesFromData(event.clipboardData) : [];
}

function isNativeClipboardEvent(event: Event): event is globalThis.ClipboardEvent {
  return "clipboardData" in event;
}

function isPasteBeforeInputEvent(event: Event): event is InputEvent {
  return typeof InputEvent !== "undefined" && event instanceof InputEvent && event.inputType === "insertFromPaste";
}

function snapshotClipboardData(clipboardData: DataTransfer | null): ClipboardDataSnapshot {
  if (!clipboardData) {
    return { summary: "clipboardData unavailable", text: "" };
  }
  const files = Array.from(clipboardData.files ?? []);
  const items = Array.from(clipboardData.items ?? []);
  const types = Array.from(clipboardData.types ?? []);
  const itemTypes = items.map((item) => `${item.kind}:${item.type || "unknown"}`);
  const text = clipboardData.getData("text/plain") || clipboardData.getData("text");
  const html = clipboardData.getData("text/html");
  return {
    text,
    summary: [
      `files=${files.length}`,
      `items=${items.length}${itemTypes.length ? `(${itemTypes.join(",")})` : ""}`,
      `types=${types.length ? types.join(",") : "none"}`,
      `text=${text.length}`,
      `html=${html.length}`
    ].join(" ")
  };
}

async function readClipboardImageFiles(clipboard: PlatformGateway["clipboard"]): Promise<File[]> {
  if (!clipboard?.read) return [];
  const items = await clipboard.read();
  const files: File[] = [];
  for (const item of items) {
    const imageType = item.types.find((type) => SUPPORTED_CLIPBOARD_IMAGE_TYPES.has(type.toLowerCase()));
    if (!imageType) continue;
    const blob = await item.getType(imageType);
    const mimeType = blob.type || imageType;
    files.push(new File([blob], `clipboard-image-${files.length + 1}.${imageExtension(mimeType)}`, { type: mimeType }));
  }
  return dedupeFiles(files);
}

function chunkFiles(files: File[], size: number): File[][] {
  const batches: File[][] = [];
  for (let index = 0; index < files.length; index += size) {
    batches.push(files.slice(index, index + size));
  }
  return batches;
}

function isTerminalSubmitInput(data: string): boolean {
  return data === "\r" || data === "\n";
}

export function shouldRefreshCliModelSettings(source: "input" | "output", data: string): boolean {
  return source === "input" && /[\r\n]/.test(data);
}

/** A picker reading is settled only once the CLI runtime confirmed the model.
 * "session-default" is the pane's persisted default, used as a placeholder while
 * neither the native TUI nor the runtime's own server reports a model yet: a pane
 * holding one must keep re-reading, or a fresh OpenCode pane keeps showing the
 * descriptor default instead of the model the CLI actually runs. */
export function cliModelSettingsCurrentIsSettled(settings: PaneCliModelSettings | null | undefined): boolean {
  return Boolean(settings?.current) && settings?.currentSource !== "session-default";
}

export function nameTerminalInput(textarea: HTMLTextAreaElement | undefined) {
  if (textarea) textarea.name = "terminal-input";
}

function terminalSemanticScreenFingerprint(terminal: XtermTerminal): string {
  const buffer = terminal.buffer.active;
  const firstLine = Math.max(0, buffer.baseY);
  const lastLine = Math.min(buffer.length, firstLine + Math.max(1, terminal.rows));
  let visibleText = "";
  for (let lineIndex = firstLine; lineIndex < lastLine; lineIndex += 1) {
    visibleText += buffer.getLine(lineIndex)?.translateToString(true) ?? "";
  }
  return visibleText.replace(/\s+/g, "");
}

function terminalBufferText(buffer: {
  length: number;
  getLine(index: number): { isWrapped?: boolean; translateToString(trimRight?: boolean): string } | undefined;
}, firstLine = 0, lastLine = buffer.length): string {
  let content = "";
  let line = buffer.getLine(firstLine);
  for (let lineIndex = firstLine; lineIndex < lastLine; lineIndex += 1) {
    const nextLine = lineIndex + 1 < lastLine ? buffer.getLine(lineIndex + 1) : undefined;
    if (lineIndex > firstLine && !line?.isWrapped) content += "\n";
    content += line?.translateToString(!nextLine?.isWrapped) ?? "";
    line = nextLine;
  }
  return content;
}

function terminalCurrentScreenText(terminal: XtermTerminal): string {
  const buffer = terminal.buffer.active;
  const firstLine = Math.max(0, buffer.baseY);
  const lastLine = Math.min(buffer.length, firstLine + Math.max(1, terminal.rows));
  return terminalBufferText(buffer, firstLine, lastLine);
}

// Claude Code status: a spinner line "✻ Razzmatazzing… (12s · thinking with xhigh effort)" while a turn
// runs, and a permission footer that gains "esc to interrupt" (truncated to "esc to …" or "esc t…" in narrow panes).
// Finished turns read "✻ Baked for 35s · done 10:01 AM", which must not count as running.
const CLAUDE_SPINNER_LINE_PATTERN = /^\s*[✢✳✶✻✽*·]\s+[A-Z][\w-]*…(?:\s+\(\s*((?:\d+h\s*)?(?:\d+m\s*)?\d+s)\b[^\n]*)?\s*$/m;
const CLAUDE_FOOTER_LINE_PATTERN = /\(shift\+tab to cycle\)|\? for shortcuts|← for agents/i;
const CLAUDE_FOOTER_INTERRUPT_PATTERN = /esc t(?:o(?: (?:interrupt|…)|…)|…)/i;

function claudeScreenRunningState(screenText: string): boolean | null {
  if (CLAUDE_SPINNER_LINE_PATTERN.test(screenText)) return true;
  // The background agent panel sits below the footer and can push it out of the last lines.
  const footer = claudeFooterLines(screenText).slice(-4);
  if (!footer.some((line) => CLAUDE_FOOTER_LINE_PATTERN.test(line) || claudeFooterModeLabel(line))) return null;
  return footer.some((line) => CLAUDE_FOOTER_INTERRUPT_PATTERN.test(line));
}

// The bottom of the screen holds the CLI's input box. TUIs wrap it with real line breaks, so
// labels are matched with whitespace removed.
function visibleTerminalPromptText(terminal: XtermTerminal | null): string {
  if (!terminal) return "";
  return terminalCurrentScreenText(terminal).split("\n").slice(-12).join("").replace(/\s+/g, "");
}

export function isTerminalScreenRunningText(screenText: string, runtimeId?: string | null): boolean {
  if (!screenText) return false;
  if (runtimeId === CLAUDE_CLI_RUNTIME_ID) {
    const claudeRunning = claudeScreenRunningState(screenText);
    if (claudeRunning !== null) return claudeRunning;
  }
  const hasIdlePrompt = /(?:ask (?:codex|opencode|gemini|claude)?(?:\s+to do)?\s+anything|ask anything|send a message)/i.test(screenText);
  if (hasIdlePrompt) return false;
  const cleanScreen = screenText.replace(/waiting for background terminal[^\n]*(?:esc(?:ape)? to interrupt|\/ps to view|\/stop to close)[^\n]*/gi, "")
    // Oh My Pi's idle prompt hint ("⇧⇥ to change thinking effort") is not a thinking turn.
    .replace(/to change thinking effort/gi, "");
  // Qwen and Qoder keep their "Type your message" placeholder visible while a turn runs.
  if (/type (?:your )?message/i.test(screenText) && !/esc(?:ape)?\s+to\s+(?:interrupt|cancel)/i.test(cleanScreen)) return false;
  return (
    // Oh My Pi's status line starts with a spinner and the elapsed time while it works (" ⠹ 7s > GPT-6 Sol >"), π when idle.
    /^\s*[\u2800-\u28ff]\s+(?:\d+[hms]\s*)+>/m.test(cleanScreen) ||
    /esc(?:ape)?\s+(?:to\s+)?(?:interrupt|cancel|stop)|\bthinking\b|(?:[\u2800-\u28ff•●*o-]\s*working\b|\bworking\s*(?:[(·•]\s*\d+[a-z]*|[.…]))|ctrl\+c to (?:interrupt|stop)|running\s+(?:background\s+)?(?:command|task|subagent|process|test|script|build)[.…]?/i.test(cleanScreen) ||
    /(?:^|\n)\s*[•●*o-]?\s*\[(?:\d{1,2}:\d{2}:\d{2}(?:\s*[ap]m)?|task-[a-z0-9_-]+|\d+)\]\s+[^\n]+?\brunning(?:\s*\([^)]*\))?\s*$/im.test(cleanScreen)
  );
}

function parseDurationStringToMs(timeStr: string): number {
  let totalMs = 0;
  const hVal = /(\d+(?:\.\d+)?)\s*h/i.exec(timeStr)?.[1];
  const mVal = /(\d+(?:\.\d+)?)\s*m/i.exec(timeStr)?.[1];
  const sVal = /(\d+(?:\.\d+)?)\s*s/i.exec(timeStr)?.[1];
  if (hVal) totalMs += parseFloat(hVal) * 3600 * 1000;
  if (mVal) totalMs += parseFloat(mVal) * 60 * 1000;
  if (sVal) totalMs += parseFloat(sVal) * 1000;
  return Math.round(totalMs);
}

export function extractTerminalScreenWorkingTimeMs(screenText: string, runtimeId?: string | null): number | null {
  if (!screenText) return null;
  if (runtimeId === CLAUDE_CLI_RUNTIME_ID) {
    // The spinner also carries "thought for Ns", which is only the thinking part of the turn.
    const claudeElapsed = CLAUDE_SPINNER_LINE_PATTERN.exec(screenText)?.[1];
    const ms = claudeElapsed ? parseDurationStringToMs(claudeElapsed) : 0;
    return ms > 0 ? ms : null;
  }
  const match = /(?:working|waiting for background terminal)\s*\(\s*([0-9hms\s]+?)(?:[•·,]|\s+esc|\))/i.exec(screenText);
  if (match?.[1]) {
    const ms = parseDurationStringToMs(match[1]);
    if (ms > 0) return ms;
  }
  const thoughtMatches = Array.from(screenText.matchAll(/(?:thought\s+for|thinking\s*(?:for|\())\s*([0-9hms\s.]+?)(?:[•·,]|\s*\([^\n)]*\)|\s*tokens|\)|\n|$)/gi));
  if (thoughtMatches.length > 0) {
    const lastThought = thoughtMatches[thoughtMatches.length - 1];
    if (lastThought?.[1]) {
      const ms = parseDurationStringToMs(lastThought[1]);
      if (ms > 0) return ms;
    }
  }
  return null;
}

type ClaudePermissionMode = "default mode" | "accept edits on" | "plan mode on" | "bypass permissions on" | "auto mode on";
const CLAUDE_PLAN_MODE_SHIFT_TABS: Record<ClaudePermissionMode, number> = {
  "default mode": 2,
  "accept edits on": 1,
  "plan mode on": 0,
  "bypass permissions on": 4,
  "auto mode on": 3
};

const CLAUDE_FOOTER_MODES: Record<ClaudeFooterModeLabel, ClaudePermissionMode> = {
  "accept edits": "accept edits on",
  "plan mode": "plan mode on",
  "bypass permissions": "bypass permissions on",
  "auto mode": "auto mode on",
  "manual mode": "default mode"
};

function claudePermissionMode(screenText: string): ClaudePermissionMode | null {
  const footerLines = claudeFooterLines(screenText)
    .map((line) => line.toLowerCase())
    .slice(-4);
  const modes: ClaudePermissionMode[] = ["accept edits on", "plan mode on", "bypass permissions on", "auto mode on"];
  const candidates: Array<{ mode: ClaudePermissionMode; lineIndex: number; columnIndex: number }> = [];
  footerLines.forEach((line, lineIndex) => {
    // The mode label is enough while background shells or a narrow pane drop the footer hints.
    const label = claudeFooterModeLabel(line);
    if (label) candidates.push({ mode: CLAUDE_FOOTER_MODES[label], lineIndex, columnIndex: line.indexOf(label) });
    const nearbyFooter = footerLines
      .slice(Math.max(0, lineIndex - 1), Math.min(footerLines.length, lineIndex + 2))
      .join(" ");
    if (nearbyFooter.includes("shift+tab to cycle") && nearbyFooter.includes("for agents")) {
      for (const mode of modes) {
        const columnIndex = line.lastIndexOf(mode);
        if (columnIndex >= 0) candidates.push({ mode, lineIndex, columnIndex });
      }
    }
    const defaultColumnIndex = line.lastIndexOf("? for shortcuts");
    if (defaultColumnIndex >= 0 && nearbyFooter.includes("for agents")) {
      candidates.push({ mode: "default mode", lineIndex, columnIndex: defaultColumnIndex });
    }
  });
  return candidates.sort((left, right) => right.lineIndex - left.lineIndex || right.columnIndex - left.columnIndex)[0]?.mode ?? null;
}

export function claudePlanModeShiftTabCount(screenText: string): number | null {
  const currentMode = claudePermissionMode(screenText);
  return currentMode ? CLAUDE_PLAN_MODE_SHIFT_TABS[currentMode] : null;
}

// SGR mouse reports: Claude Code tracks every pointer move, and a move is neither a prompt edit nor a reason to take focus.
const SGR_MOUSE_REPORTS = /^(?:\u001b\[<\d+;\d+;\d+[Mm])+$/;

export function shouldRefocusTerminalAfterInput(data: string): boolean {
  return !isNonMutatingTerminalProtocolResponse(data) &&
    !SGR_MOUSE_REPORTS.test(data) &&
    data !== "\u001b[I" &&
    data !== "\u001b[O";
}

export function nextTerminalPromptDraft(
  draft: TerminalPromptDraftState,
  data: string
): TerminalPromptDraftState | null {
  const characters = Array.from(draft.text);
  let cursor = Math.max(0, Math.min(draft.cursor, characters.length));
  let inBracketedPaste = false;

  for (let index = 0; index < data.length; index += 1) {
    const character = data[index] ?? "";
    if (character === "\u001b") {
      const controlString = /^\u001b(?:\][^\u0007]*(?:\u0007|\u001b\\)|[PX^_][\s\S]*?\u001b\\)/.exec(data.slice(index));
      if (controlString) {
        if (!isNonMutatingTerminalProtocolResponse(controlString[0])) return null;
        index += controlString[0].length - 1;
        continue;
      }
      const sequence = /^\u001b(?:O[@-~]|\[[0-?]*[ -/]*[@-~]|[@-Z\\-_])/.exec(data.slice(index));
      if (!sequence) return null;
      if (isNonMutatingTerminalProtocolResponse(sequence[0]) || SGR_MOUSE_REPORTS.test(sequence[0])) {
        index += sequence[0].length - 1;
        continue;
      }
      switch (sequence[0]) {
        case "\u001b[D":
        case "\u001bOD":
          cursor = Math.max(0, cursor - 1);
          break;
        case "\u001b[C":
        case "\u001bOC":
          cursor = Math.min(characters.length, cursor + 1);
          break;
        case "\u001b[H":
        case "\u001b[1~":
        case "\u001b[7~":
        case "\u001bOH":
          cursor = 0;
          break;
        case "\u001b[F":
        case "\u001b[4~":
        case "\u001b[8~":
        case "\u001bOF":
          cursor = characters.length;
          break;
        case "\u001b[3~":
          if (cursor < characters.length) characters.splice(cursor, 1);
          break;
        case BRACKETED_PASTE_START:
          inBracketedPaste = true;
          break;
        case BRACKETED_PASTE_END:
          inBracketedPaste = false;
          break;
        case "\u001b[I":
        case "\u001b[O":
          break;
        default:
          return null;
      }
      index += sequence[0].length - 1;
      continue;
    }
    if (!inBracketedPaste && (character === "\r" || character === "\n" || character === "\u0015")) {
      characters.splice(0);
      cursor = 0;
      continue;
    }
    if (inBracketedPaste && (character === "\r" || character === "\n")) {
      characters.splice(cursor, 0, "\n");
      cursor += 1;
      continue;
    }
    if (character === "\b" || character === "\u007f") {
      if (cursor > 0) {
        characters.splice(cursor - 1, 1);
        cursor -= 1;
      }
      continue;
    }
    if (character === "\u0001") {
      cursor = 0;
      continue;
    }
    if (character === "\u0005") {
      cursor = characters.length;
      continue;
    }
    const codePoint = data.codePointAt(index);
    if (codePoint === undefined || codePoint < 0x20) return null;
    const printable = String.fromCodePoint(codePoint);
    characters.splice(cursor, 0, printable);
    cursor += 1;
    index += printable.length - 1;
  }
  return { text: characters.join(""), cursor };
}

export interface ResolveTerminalPasteModeOptions {
  isLoginPurpose: boolean;
  hasNewlines: boolean;
  lineCount: number;
  charCount: number;
  bracketedPasteSupported: boolean;
}

export function resolveTerminalPasteMode(options: ResolveTerminalPasteModeOptions): "raw" | "bracketed" | "file" {
  if (options.isLoginPurpose) return "raw";
  if (!options.hasNewlines) return "raw";
  const isLarge = options.lineCount > 30 || options.charCount > 4000;
  if (!isLarge && options.bracketedPasteSupported) {
    return "bracketed";
  }
  return "file";
}

function createCliTurnMarker(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const randomHex = (length: number) => Array.from({ length }, () => Math.floor(Math.random() * 16).toString(16)).join("");
  return `${randomHex(8)}-${randomHex(4)}-4${randomHex(3)}-8${randomHex(3)}-${randomHex(12)}`;
}

function activeCliTurnStorageKey(paneId: string): string {
  return `${ACTIVE_CLI_TURN_STORAGE_PREFIX}${paneId}`;
}

function clearStoredActiveCliTurn(paneId: string): void {
  try {
    getSpaceRuntime().platform.sessionStorage.removeItem(activeCliTurnStorageKey(paneId));
  } catch {
    // Best-effort continuity only.
  }
}

function storeActiveCliTurn(paneId: string, sessionId: string, turn: ActiveCliTurn): void {
  try {
    getSpaceRuntime().platform.sessionStorage.setItem(activeCliTurnStorageKey(paneId), JSON.stringify({ sessionId, ...turn } satisfies StoredActiveCliTurn));
  } catch {
    // Best-effort continuity only.
  }
}

function readStoredActiveCliTurn(paneId: string, sessionId: string): ActiveCliTurn | null {
  try {
    const raw = getSpaceRuntime().platform.sessionStorage.getItem(activeCliTurnStorageKey(paneId));
    if (!raw) return null;
    const stored = JSON.parse(raw) as Partial<StoredActiveCliTurn>;
    if (
      stored.sessionId !== sessionId ||
      typeof stored.marker !== "string" ||
      !CLI_TURN_MARKER_PATTERN.test(stored.marker) ||
      (stored.status !== "PENDING" && stored.status !== "RUNNING")
    ) {
      clearStoredActiveCliTurn(paneId);
      return null;
    }
    return { marker: stored.marker, status: stored.status };
  } catch {
    clearStoredActiveCliTurn(paneId);
    return null;
  }
}

export interface PendingTerminalInputQueue {
  length: number;
  queuedBytes: number;
}

export function terminalPendingInputAdmission(
  queue: PendingTerminalInputQueue,
  dataLength: number,
  maxEntries = 256,
  maxBytes = 1_000_000
): boolean {
  if (dataLength <= 0) return true;
  return queue.length < maxEntries && queue.queuedBytes + dataLength <= maxBytes;
}

// The spinner and shimmer behind a photo stop once it has loaded (or failed).
function markUploadImageLoaded(event: SyntheticEvent<HTMLImageElement>) {
  event.currentTarget.dataset.loaded = event.type === "error" ? "error" : "true";
}

// Portals render under <body>; copying the pane's theme attributes keeps the room theme and color mode.
function portalThemeAttributes(source: Element | null | undefined) {
  const host = source?.closest<HTMLElement>("[data-shell-mode], .space-shell, [data-room-theme], [data-ui-theme]");
  return {
    "data-ui-theme": host?.dataset.uiTheme || document.body.dataset.uiTheme,
    "data-interface-theme": host?.dataset.interfaceTheme || document.documentElement.dataset.interfaceTheme,
    "data-room-theme": host?.dataset.roomTheme || document.body.dataset.roomTheme,
    "data-color-mode": host?.dataset.colorMode || document.body.dataset.colorMode
  };
}

export const TerminalPane = memo(function TerminalPane({
  pane,
  terminalFontSize,
  bootstrapBarrier,
  shouldBootstrap = true,
  prefillInitialReplay = false,
  fullscreenLayout = false,
  presizeInFullscreen = false,
  isTarget = true,
  isVisible = true,
  observerOnly = false,
  hideFloatingControls = false,
  cliDebugModeEnabled,
  maxImagePreviews = DEFAULT_CLI_IMAGE_PREVIEW_LIMIT,
  onCliDebugModeChange,
  onSessionMetadataChange,
  onBootstrapped,
  onPrefillReadyChange,
  revealGeneration = 0,
  onRevealReady,
  onWorkingStateChange,
  onActionAvailabilityChange,
  oskOpen = false,
  mobile = false
}: TerminalPaneProps) {
  const voiceInput = useVoiceInput();
  const voiceOwnerId = `cli:${pane.id}`;
  const [registry, setRegistry] = useState<AgentRuntimeRegistry | null>(() => api.cliRuntimesSnapshot());
  const [selectedRuntimeId, setSelectedRuntimeId] = useState(pane.terminalRuntimeId ?? DEFAULT_CLI_RUNTIME_ID);
  const [geminiAccountProfiles, setGeminiAccountProfiles] = useState<CliAccountProfile[]>([]);
  const [selectedGeminiAccountProfileId, setSelectedGeminiAccountProfileId] = useState(() => readLastCliAccountProfileId("cli:gemini"));
  const [uploadPreviewsOpen, setUploadPreviewsOpen] = useState(false);
  const [uploadPreviewPage, setUploadPreviewPage] = useState(0);
  const [photoHistoryError, setPhotoHistoryError] = useState(false);
  const [photoHistoryAttempt, setPhotoHistoryAttempt] = useState(0);
  const uploadPreviewsPickerRef = useRef<HTMLDivElement | null>(null);
  const uploadPreviewsButtonRef = useRef<HTMLButtonElement | null>(null);
  const [photoContextMenu, setPhotoContextMenu] = useState<{ x: number; y: number } | null>(null);
  const photoContextMenuRef = useRef<HTMLDivElement | null>(null);
  const photoTouchContext = useTouchContextMenu(
    (source) => (source instanceof Element ? source.closest<HTMLElement>(".terminal-upload-preview-trigger") : null),
    ({ x, y }) => {
      setUploadPreviewsOpen(false);
      setContextMenu(null);
      setPhotoContextMenu({ x, y });
    }
  );
  const [sessionResponse, setSessionResponse] = useState<PaneCliSessionResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [clipboardDebug, setClipboardDebug] = useState<ClipboardDebugState | null>(null);
  const [clipboardDebugHistory, setClipboardDebugHistory] = useState<ClipboardDebugState[]>([]);
  const revealGenerationRef = useRef(revealGeneration);
  revealGenerationRef.current = revealGeneration;
  const [dismissedClipboardDebugAt, setDismissedClipboardDebugAt] = useState<string | null>(null);
  const [uploadPreviews, setUploadPreviews] = useState<TerminalUploadPreview[]>([]);
  const previousUploadPreviewsRef = useRef<TerminalUploadPreview[]>([]);
  const photoHistoryPaneRef = useRef(pane.id);
  const [selectedUploadPreviewId, setSelectedUploadPreviewId] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const [terminalStatus, setTerminalStatus] = useState<TerminalConnectionStatus>("idle");
  const terminalStatusRef = useRef<TerminalConnectionStatus>("idle");
  terminalStatusRef.current = terminalStatus;
  const [terminalControlState, setTerminalControlState] = useState<PaneCliTerminalControlState>("AVAILABLE");
  const [terminalReplayReady, setTerminalReplayReady] = useState(false);
  const [terminalPrefillReady, setTerminalPrefillReady] = useState(!prefillInitialReplay);
  const [connectionAlert, setConnectionAlert] = useState<TerminalConnectionAlert | null>(null);
  const [terminalPromptDraft, setTerminalPromptDraft] = useState("");
  const terminalPromptDraftDebounceTimerRef = useRef<number | null>(null);
  const [terminalLayoutSuggestion, setTerminalLayoutSuggestion] = useState<LayoutMismatchDetection | null>(null);
  const dismissedTerminalLayoutTextRef = useRef<string | null>(null);
  const { settings: autocorrectSettings } = useKeyboardAutocorrectSettings();
  const prevTerminalLayoutSuggestionRef = useRef(false);

  useEffect(() => {
    if (!autocorrectSettings.enabled) {
      setTerminalLayoutSuggestion(null);
      return;
    }
    const text = terminalPromptDraft.trim();
    if (!text || text === dismissedTerminalLayoutTextRef.current) {
      setTerminalLayoutSuggestion(null);
      return;
    }
    const detection = detectKeyboardLayoutMismatch(text);
    const isLangSupported = (detection.direction === "toGreek" && autocorrectSettings.supportedLanguages.includes("el")) ||
      (detection.direction === "toQwerty" && autocorrectSettings.supportedLanguages.includes("en"));
    if (detection.hasMismatch && detection.confidence >= 0.85 && isLangSupported) {
      setTerminalLayoutSuggestion(detection);
    } else {
      setTerminalLayoutSuggestion(null);
    }
  }, [terminalPromptDraft, autocorrectSettings.enabled, autocorrectSettings.supportedLanguages]);

  useEffect(() => {
    if (terminalLayoutSuggestion && !prevTerminalLayoutSuggestionRef.current) {
      if (autocorrectSettings.enabled && autocorrectSettings.soundEnabled) {
        playLayoutSuggestionBeep();
      }
    }
    prevTerminalLayoutSuggestionRef.current = Boolean(terminalLayoutSuggestion);
  }, [terminalLayoutSuggestion, autocorrectSettings.enabled, autocorrectSettings.soundEnabled]);

  const { variables: promptVariables, settings: promptVariablesSettings } = usePromptVariables();
  const [variablesManagerOpen, setVariablesManagerOpen] = useState(false);
  const [variablesManagerInitialName, setVariablesManagerInitialName] = useState("");
  const [selectedVariableIndex, setSelectedVariableIndex] = useState(0);
  const [dismissedVariableToken, setDismissedVariableToken] = useState<string | null>(null);
  const customKeyEventHandlerRef = useRef<((event: KeyboardEvent) => boolean) | null>(null);
  // Declared before activeVariableToken: the memo below reads .current during render.
  const terminalPromptDraftRef = useRef<TerminalPromptDraftState>({ text: "", cursor: 0 });

  const rawVariableToken: PromptVariableToken | null = useMemo(() => {
    if (!promptVariablesSettings.enabled) return null;
    const draft = terminalPromptDraftRef.current;
    const textBeforeCursor = draft.text.slice(0, draft.cursor);
    return findActiveVariableToken(textBeforeCursor);
  }, [terminalPromptDraft, promptVariablesSettings.enabled]);

  useEffect(() => {
    if (!rawVariableToken || rawVariableToken.token !== dismissedVariableToken) {
      if (dismissedVariableToken) {
        setDismissedVariableToken(null);
      }
    }
    if (!rawVariableToken) {
      setSelectedVariableIndex(0);
    }
  }, [rawVariableToken, dismissedVariableToken]);

  const activeVariableToken: PromptVariableToken | null = useMemo(() => {
    if (!rawVariableToken) return null;
    if (dismissedVariableToken && dismissedVariableToken === rawVariableToken.token) return null;
    return rawVariableToken;
  }, [rawVariableToken, dismissedVariableToken]);

  const filteredVariables = useMemo(() => {
    if (!activeVariableToken) return [];
    return filterPromptVariables(promptVariables, activeVariableToken.query);
  }, [promptVariables, activeVariableToken]);
  // The list can shrink while typing; never point past its end.
  const highlightedVariableIndex = Math.min(selectedVariableIndex, Math.max(0, filteredVariables.length - 1));
  // A bare '#' only picks a variable on Enter after the operator moved through the list with the arrows.
  const variableListNavigatedTokenRef = useRef<string | null>(null);

  const handleSelectPromptVariable = useCallback((variable: PromptVariable) => {
    const activeToken = activeVariableToken;
    if (!activeToken) return;
    const tokenLen = activeToken.token.length;
    const backspaces = "\u007f".repeat(tokenLen);
    sendTerminalInput(`${backspaces}#${variable.name} `, "prompt variable selection", "visible", true);
    variableListNavigatedTokenRef.current = null;
    setSelectedVariableIndex(0);
    setDismissedVariableToken(activeToken.token);
    focusTerminal();
  }, [activeVariableToken]);

  useEffect(() => {
    customKeyEventHandlerRef.current = (event: KeyboardEvent) => {
      if (!activeVariableToken || !promptVariablesSettings.enabled) return true;
      if (event.type !== "keydown") return true;

      if (event.key === "ArrowDown") {
        event.preventDefault();
        event.stopPropagation();
        variableListNavigatedTokenRef.current = activeVariableToken.token;
        setSelectedVariableIndex((prev) => (Math.min(prev, Math.max(0, filteredVariables.length - 1)) + 1) % Math.max(1, filteredVariables.length));
        return false;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        event.stopPropagation();
        variableListNavigatedTokenRef.current = activeVariableToken.token;
        setSelectedVariableIndex((prev) => (Math.min(prev, Math.max(0, filteredVariables.length - 1)) - 1 + Math.max(1, filteredVariables.length)) % Math.max(1, filteredVariables.length));
        return false;
      }
      if (
        event.key === "Enter" &&
        !activeVariableToken.query &&
        variableListNavigatedTokenRef.current !== activeVariableToken.token
      ) {
        return true;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        if (filteredVariables.length > 0) {
          event.preventDefault();
          event.stopPropagation();
          const picked = filteredVariables[highlightedVariableIndex] ?? filteredVariables[0];
          if (picked) {
            handleSelectPromptVariable(picked);
          }
          return false;
        }
      }
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setDismissedVariableToken(activeVariableToken.token);
        return false;
      }
      return true;
    };
  });

  // A pane's own open/close choice wins; panes without one follow the "Local draft open by default" setting.
  const [localComposerChoice, setLocalComposerChoice] = useState<boolean | null>(() => {
    try {
      const stored = getSpaceRuntime().platform.localStorage.getItem(`space.cli.localComposer.open:${pane.id}`);
      return stored === null ? null : stored === "true";
    } catch { return null; }
  });
  const localComposerOpen = localComposerChoice ?? Boolean(voiceInput.settings.terminalLocalDraft);
  function toggleLocalComposer(open: boolean) {
    setLocalComposerChoice(open);
    try { getSpaceRuntime().platform.localStorage.setItem(`space.cli.localComposer.open:${pane.id}`, String(open)); }
    catch { /* Draft persistence reports its own storage errors. This is only the open preference. */ }
  }
  const [localComposerToolbar, setLocalComposerToolbar] = useState<HTMLDivElement | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; selection: string; appSelection?: boolean } | null>(null);
  const contextMenuRef = useRef<HTMLDivElement | null>(null);
  const voiceInputRef = useRef(voiceInput);
  voiceInputRef.current = voiceInput;

  useEffect(() => {
    if (!contextMenu) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (shouldPreserveForSnipTool(event)) return;
      if (event.target instanceof Node && !contextMenuRef.current?.contains(event.target)) {
        setContextMenu(null);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setContextMenu(null);
        focusTerminal();
      }
    };
    const handleResize = () => setContextMenu(null);
    document.addEventListener("pointerdown", handlePointerDown, true);
    document.addEventListener("keydown", handleKeyDown, true);
    window.addEventListener("resize", handleResize);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown, true);
      document.removeEventListener("keydown", handleKeyDown, true);
      window.removeEventListener("resize", handleResize);
    };
  }, [contextMenu]);

  useEffect(() => {
    if (!photoContextMenu) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (shouldPreserveForSnipTool(event)) return;
      if (event.target instanceof Node && !photoContextMenuRef.current?.contains(event.target)) {
        setPhotoContextMenu(null);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setPhotoContextMenu(null);
        focusTerminal();
      }
    };
    const handleResize = () => setPhotoContextMenu(null);
    document.addEventListener("pointerdown", handlePointerDown, true);
    document.addEventListener("keydown", handleKeyDown, true);
    window.addEventListener("resize", handleResize);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown, true);
      document.removeEventListener("keydown", handleKeyDown, true);
      window.removeEventListener("resize", handleResize);
    };
  }, [photoContextMenu]);

  const [activeCliTurn, setActiveCliTurn] = useState<ActiveCliTurn | null>(null);
  const fallbackRunRef = useRef<{ runKey: string } | null>(null);
  const [fallbackRunActive, setFallbackRunActive] = useState(false);
  const fallbackRunIdleTimerRef = useRef<number | null>(null);
  const [terminalScreenRunning, setTerminalScreenRunning] = useState(false);
  // Claude Code keeps working in background agents after its main turn ends and its prompt takes new
  // input. The pane is working, but there is no turn to interrupt and the composer stays usable.
  const [backgroundAgentsRunning, setBackgroundAgentsRunning] = useState(false);
  const [terminalScreenWorkingMs, setTerminalScreenWorkingMs] = useState<number | null>(null);
  const [terminalPlanMode, setTerminalPlanMode] = useState<TerminalActionAvailability["planMode"]>(null);
  const [promptSeenSessionId, setPromptSeenSessionId] = useState<string | null>(null);
  // A working CLI keeps redrawing (spinner, timer); an idle one is still. Screen changes in the last
  // few seconds back up the turn heuristics so Stop is not withheld from a turn they miss.
  const [terminalScreenActive, setTerminalScreenActive] = useState(false);
  const lastScannedScreenTextRef = useRef<string | null>(null);
  const terminalScreenActiveTimerRef = useRef<number | null>(null);
  const [stopCooldown, setStopCooldown] = useState(false);
  const stopCooldownTimerRef = useRef<number | null>(null);
  useEffect(() => () => {
    if (terminalScreenActiveTimerRef.current !== null) window.clearTimeout(terminalScreenActiveTimerRef.current);
    if (stopCooldownTimerRef.current !== null) window.clearTimeout(stopCooldownTimerRef.current);
  }, []);
  const terminalScreenRunningRef = useRef(false);
  terminalScreenRunningRef.current = terminalScreenRunning;

  const checkTerminalScreenRunning = useCallback(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    const screenText = terminalCurrentScreenText(terminal);
    const runtimeId = sessionResponseRef.current?.session.runtimeId ?? null;
    const isRunning = isTerminalScreenRunningText(screenText, runtimeId);
    setBackgroundAgentsRunning(runtimeId === CLAUDE_CLI_RUNTIME_ID && claudeBackgroundAgentRunning(terminal));
    const screenWorkingMs = extractTerminalScreenWorkingTimeMs(screenText, runtimeId);
    if (lastScannedScreenTextRef.current !== null && screenText !== lastScannedScreenTextRef.current) {
      setTerminalScreenActive(true);
      if (terminalScreenActiveTimerRef.current !== null) window.clearTimeout(terminalScreenActiveTimerRef.current);
      terminalScreenActiveTimerRef.current = window.setTimeout(() => {
        terminalScreenActiveTimerRef.current = null;
        setTerminalScreenActive(false);
      }, TERMINAL_SCREEN_ACTIVITY_WINDOW_MS);
    }
    lastScannedScreenTextRef.current = screenText;
    if (runtimeId) {
      const claudeMode = runtimeId === CLAUDE_CLI_RUNTIME_ID ? claudePermissionMode(screenText) : undefined;
      const mode = claudeMode === undefined
        ? cliBuildModeState(runtimeId, screenText)
        : claudeMode === null ? null : claudeMode === "plan mode on" ? "plan" : "build";
      setTerminalPlanMode(mode);
      // The CLI drew its prompt footer at least once, so it has finished starting.
      const sessionId = sessionResponseRef.current?.session.sessionId ?? null;
      if (mode !== null && sessionId) setPromptSeenSessionId(sessionId);
    }
    if (screenWorkingMs !== null) {
      setTerminalScreenWorkingMs((prev) => {
        if (prev === null) return screenWorkingMs;
        if (Math.floor(prev / 60_000) === Math.floor(screenWorkingMs / 60_000)) return prev;
        return screenWorkingMs;
      });
    } else if (!isRunning) {
      // A finished turn's elapsed time must not seed the next turn.
      setTerminalScreenWorkingMs(null);
    }
    if (terminalScreenRunningRef.current !== isRunning) {
      const wasRunning = terminalScreenRunningRef.current;
      terminalScreenRunningRef.current = isRunning;
      setTerminalScreenRunning(isRunning);
      if (wasRunning && !isRunning && fallbackRunRef.current) {
        finishFallbackRun(fallbackRunRef.current.runKey);
      }
    }
  }, []);

  // Output chunks only schedule the screen scan: a burst (for example the
  // replay after a reveal) is scanned once per frame instead of per chunk.
  // Hidden documents get no frames, so they keep the immediate scan.
  const screenRunningCheckFrameRef = useRef<number | null>(null);
  const scheduleTerminalScreenRunningCheck = useCallback(() => {
    if (document.visibilityState === "hidden") {
      if (screenRunningCheckFrameRef.current !== null) {
        window.cancelAnimationFrame(screenRunningCheckFrameRef.current);
        screenRunningCheckFrameRef.current = null;
      }
      checkTerminalScreenRunning();
      return;
    }
    if (screenRunningCheckFrameRef.current !== null) return;
    screenRunningCheckFrameRef.current = window.requestAnimationFrame(() => {
      screenRunningCheckFrameRef.current = null;
      checkTerminalScreenRunning();
    });
  }, [checkTerminalScreenRunning]);

  useEffect(() => {
    const flushPendingScreenRunningCheck = () => {
      if (document.visibilityState !== "hidden" || screenRunningCheckFrameRef.current === null) return;
      window.cancelAnimationFrame(screenRunningCheckFrameRef.current);
      screenRunningCheckFrameRef.current = null;
      checkTerminalScreenRunning();
    };
    document.addEventListener("visibilitychange", flushPendingScreenRunningCheck);
    return () => {
      document.removeEventListener("visibilitychange", flushPendingScreenRunningCheck);
      if (screenRunningCheckFrameRef.current !== null) {
        window.cancelAnimationFrame(screenRunningCheckFrameRef.current);
        screenRunningCheckFrameRef.current = null;
      }
    };
  }, [checkTerminalScreenRunning]);

  useEffect(() => {
    if ((!terminalScreenRunning && !fallbackRunActive) || !isVisible || pane.isMinimized) return;
    const interval = window.setInterval(() => {
      checkTerminalScreenRunning();
    }, 1000);
    return () => window.clearInterval(interval);
  }, [terminalScreenRunning, fallbackRunActive, isVisible, pane.isMinimized, checkTerminalScreenRunning]);
  const terminalTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const oskOpenRef = useRef(oskOpen);
  oskOpenRef.current = oskOpen;
  const mobileRef = useRef(mobile);
  mobileRef.current = mobile;

  useEffect(() => {
    const textarea = terminalTextareaRef.current;
    if (!textarea) return;
    const suppressNativeKeyboard = oskOpen && mobile;
    textarea.readOnly = suppressNativeKeyboard;
    if (suppressNativeKeyboard && document.activeElement === textarea) {
      textarea.blur();
    }
  }, [oskOpen, mobile]);

  function finishFallbackRun(runKey: string | null = null, status: "COMPLETED" | "FAILED" = "COMPLETED") {
    const run = fallbackRunRef.current;
    if (!run || (runKey !== null && run.runKey !== runKey)) return;
    fallbackRunRef.current = null;
    setFallbackRunActive(false);
    if (fallbackRunIdleTimerRef.current !== null) {
      window.clearTimeout(fallbackRunIdleTimerRef.current);
      fallbackRunIdleTimerRef.current = null;
    }
    publishPaneRunLifecycle({
      roomId: pane.roomId,
      paneId: pane.id,
      runKey: run.runKey,
      status
    });
  }

  function resetFallbackRunIdleTimer() {
    const run = fallbackRunRef.current;
    if (!run) return;
    if (fallbackRunIdleTimerRef.current !== null) {
      window.clearTimeout(fallbackRunIdleTimerRef.current);
    }
    fallbackRunIdleTimerRef.current = window.setTimeout(() => {
      fallbackRunIdleTimerRef.current = null;
      checkTerminalScreenRunning();
      if (terminalScreenRunningRef.current) {
        resetFallbackRunIdleTimer();
        return;
      }
      finishFallbackRun(run.runKey);
    }, CLI_FALLBACK_RUN_IDLE_MS);
  }

  function armFallbackRunWatcher(runKey: string) {
    finishFallbackRun();
    fallbackRunRef.current = { runKey };
    setFallbackRunActive(true);
    resetFallbackRunIdleTimer();
  }

  const openCodeObservedRunningMarkerRef = useRef<string | null>(null);
  const shortcutPendingRef = useRef(false);
  const [shortcutPending, setShortcutPending] = useState(false);
  const shortcutLiveRef = useRef(true);
  useEffect(() => { shortcutLiveRef.current = true; return () => { shortcutLiveRef.current = false; }; }, []);
  const [modelSettings, setModelSettings] = useState<PaneCliModelSettings | null>(null);
  const [modelSettingsError, setModelSettingsError] = useState<string | null>(null);
  const managedPlan = useManagedPlanExecution({ api, paneId: pane.id, sessionId: sessionResponse?.session.sessionId ?? null,
    enabled: isVisible && !pane.isMinimized && sessionResponse?.session.runtimeId === "cli:codex" });
  const hasManagedPlan = Boolean(managedPlan.execution && managedPlan.execution.sessionId === sessionResponse?.session.sessionId && !isFinishedExecution(managedPlan.execution));
  const managedModelClickScope: ManagedStageScope | null = hasManagedPlan && managedPlan.execution
    ? { executionId: managedPlan.execution.id, stageId: managedPlan.execution.snapshot.stages[managedPlan.execution.activeStageIndex]?.id ?? "" } : null;
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  const xtermHostRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const uploadPreviewDialogRef = useRef<HTMLDivElement | null>(null);
  const uploadPreviewCloseRef = useRef<HTMLButtonElement | null>(null);
  const uploadPreviewReturnFocusRef = useRef<HTMLButtonElement | null>(null);
  const terminalRef = useRef<XtermTerminal | null>(null);
  const reconnectFrameRef = useRef<ReturnType<typeof holdTerminalReconnectFrame>>(null);
  useEffect(() => () => { reconnectFrameRef.current?.dispose(); }, []);
  const fitAddonRef = useRef<XtermFitAddon | null>(null);
  const terminalFontSizeRef = useRef(terminalFontSize);
  const wheelGeometryReconcileAtRef = useRef(0);
  const socketRef = useRef<WebSocket | null>(null);
  const bufferedSocketRef = useRef<BufferedTerminalSocket | null>(null);
  const loadRuntimesGenerationRef = useRef(0);
  const lastActiveSessionCheckedMsRef = useRef<number>(0);
  const readySocketRef = useRef<{ socket: WebSocket; sessionId: string } | null>(null);
  const terminalControlRef = useRef<TerminalControlSnapshot>({ ...initialTerminalControlSnapshot });
  const terminalControlHeartbeatRef = useRef<number | null>(null);
  const terminalSocketKeepaliveRef = useRef<number | null>(null);
  const terminalSocketMessageCountRef = useRef(0);
  const terminalSocketProbeTimerRef = useRef<number | null>(null);
  const terminalControlRequestPendingRef = useRef(false);
  const observerControlUpgradePendingRef = useRef(false);
  const pendingTerminalInputsRef = useRef<PendingTerminalInput[]>([]);
  const lastTerminalControlMutationRef = useRef<{ socket: WebSocket; record: RecordedTerminalControlMutation } | null>(null);
  const terminalControlReplayBudgetRef = useRef<TerminalControlReplayBudget>({ attempts: 0, windowStartedAtMs: 0 });
  const sessionResponseRef = useRef<PaneCliSessionResponse | null>(null);
  const autoAttachAttemptRef = useRef<string | null>(null);
  const pasteShortcutFallbackRef = useRef<number | null>(null);
  const isTargetRef = useRef(isTarget);
  isTargetRef.current = isTarget;
  const paneMinimizedRef = useRef(pane.isMinimized);
  paneMinimizedRef.current = pane.isMinimized;
  const pasteInputGuardRef = useRef<{ source: string; expiresAtMs: number } | null>(null);
  const reconnectAttemptRef = useRef(0);
  const reconnectTimerRef = useRef<number | null>(null);
  const reconnectCoordinatorRef = useRef(createTerminalReconnectCoordinator());
  const reconnectInProgressRef = useRef(false);
  const reconnectStartedAtRef = useRef<number | null>(null);

  function setReconnectInProgress(inProgress: boolean): void {
    reconnectInProgressRef.current = inProgress;
    reconnectStartedAtRef.current = inProgress ? Date.now() : null;
  }
  const intentionalSocketParkRef = useRef(false);
  const hiddenWarmSocketParkTimerRef = useRef<number | null>(null);
  const modelSettingsRefreshTimerRef = useRef<number | null>(null);
  const modelSettingsOutputRefreshArmRef = useRef<ModelSettingsOutputRefreshArm | null>(null);
  const modelSettingsOutputRefreshTokenRef = useRef(0);
  const modelSettingsRefreshGenerationRef = useRef(0);
  const modelSettingsRef = useRef<PaneCliModelSettings | null>(null);
  modelSettingsRef.current = modelSettings;
  const hiddenInputEchoFiltersRef = useRef<HiddenInputEchoFilter[]>([]);
  const managedPromptAttachmentsRef = useRef<ManagedPromptAttachmentState>({
    imageCount: 0,
    videoCount: 0,
    fileCount: 0,
    pending: []
  });
  const clipboardDebugHistoryRef = useRef<ClipboardDebugState[]>([]);
  const lastClipboardReportRef = useRef<{ key: string; atMs: number } | null>(null);
  const clipboardPasteAttemptRef = useRef<ClipboardPasteAttempt | null>(null);
  const clipboardAttemptTimerRef = useRef<number | null>(null);
  const lastTerminalIntentAtRef = useRef(0);
  // Last selection a mouse-capturing CLI (Claude Code fullscreen, opencode) copied with OSC 52.
  const terminalAppSelectionRef = useRef("");
  const isVisibleRef = useRef(isVisible);
  isVisibleRef.current = isVisible;
  const wasAtBottomRef = useRef(true);
  const isWritingChunkRef = useRef(false);
  const terminalInstanceIdRef = useRef(`term-instance:${crypto.randomUUID()}`);
  const terminalGeometryCoordinatorRef = useRef<ReturnType<typeof createTerminalGeometryCoordinator> | null>(null);
  const terminalOutputCoordinatorRef = useRef<ReturnType<typeof createTerminalOutputCoordinator> | null>(null);
  const prefillInitialReplayRef = useRef(prefillInitialReplay);
  prefillInitialReplayRef.current = prefillInitialReplay;
  const fullscreenLayoutRef = useRef(fullscreenLayout);
  fullscreenLayoutRef.current = fullscreenLayout;
  const presizeInFullscreenRef = useRef(presizeInFullscreen);
  presizeInFullscreenRef.current = presizeInFullscreen;
  const fullscreenPresizeRef = useRef<{ cols: number; rows: number } | null>(null);
  const lastSentResizeRef = useRef<{ socket: WebSocket; cols: number; rows: number } | null>(null);
  const syncTerminalOutputVisibilityRef = useRef<() => void>(() => undefined);
  const scheduledTerminalRepaintFrameRef = useRef<number | null>(null);
  const lastTerminalOutputRefitAtRef = useRef(0);
  const claudePlanModeActionPendingRef = useRef(false);
  // Mirrors the ref so the pane menu can disable Plan while a Claude mode change is in flight.
  const [claudePlanModeActionPending, setClaudePlanModeActionPending] = useState(false);
  const bootstrapReportedRef = useRef(false);

  const cliRuntimes = useMemo(
    () => (registry?.data ?? []).filter((runtime) => runtime.capabilities.includes("CLI")),
    [registry]
  );
  const selectedRuntime = useMemo(
    () => cliRuntimes.find((runtime) => runtime.id === selectedRuntimeId) ?? cliRuntimes[0] ?? null,
    [cliRuntimes, selectedRuntimeId]
  );
  const isGeminiRuntime = selectedRuntimeId === "cli:gemini";
  const isCopilotRuntime = selectedRuntimeId === "cli:copilot";
  const isCursorRuntime = selectedRuntimeId === "cli:cursor";
  const isKimiRuntime = selectedRuntimeId === "cli:kimi";
  const isClaudeRuntime = selectedRuntimeId === "cli:claude";
  const isCodexRuntime = selectedRuntimeId === DEFAULT_CLI_RUNTIME_ID;
  const [copilotAccountProfiles, setCopilotAccountProfiles] = useState<CliAccountProfile[]>([]);
  const [selectedCopilotAccountProfileId, setSelectedCopilotAccountProfileId] = useState(() => readLastCliAccountProfileId("cli:copilot"));
  const [cursorAccountProfiles, setCursorAccountProfiles] = useState<CliAccountProfile[]>([]);
  const [selectedCursorAccountProfileId, setSelectedCursorAccountProfileId] = useState(() => readLastCliAccountProfileId("cli:cursor"));
  const [kimiAccountProfiles, setKimiAccountProfiles] = useState<CliAccountProfile[]>([]);
  const [selectedKimiAccountProfileId, setSelectedKimiAccountProfileId] = useState(() => readLastCliAccountProfileId("cli:kimi"));
  // Copilot and Cursor panes on Auto: Space picks the account with the most room and moves the pane when it runs out.
  const [autoAccountMode, setAutoAccountMode] = useState(false);
  const autoAccountModeRef = useRef(false);
  autoAccountModeRef.current = autoAccountMode;
  const [claudeAccountProfiles, setClaudeAccountProfiles] = useState<CliAccountProfile[]>([]);
  const [selectedClaudeAccountProfileId, setSelectedClaudeAccountProfileId] = useState(() => readLastCliAccountProfileId("cli:claude"));
  // The latest account profile list of this pane's CLI; a new pane waits for it before it starts its CLI.
  const accountProfilesLoadRef = useRef<{ runtimeId: string; result: Promise<ListCliAccountProfilesResponse> } | null>(null);
  const selectedUploadPreviewIndex = useMemo(
    () => uploadPreviews.findIndex((preview) => preview.id === selectedUploadPreviewId),
    [selectedUploadPreviewId, uploadPreviews]
  );
  const selectedUploadPreview = selectedUploadPreviewIndex >= 0 ? uploadPreviews[selectedUploadPreviewIndex] ?? null : null;
  const selectedUploadPreviewLabel = selectedUploadPreviewIndex >= 0 ? `Image ${selectedUploadPreviewIndex + 1}` : "Image";
  const cliPlansMenuPane = useMemo(
    () => ({
      ...pane,
      cwd: pane.cwd || sessionResponse?.session.cwd || null,
      isMaximized: pane.isMaximized,
      isMinimized: pane.isMinimized
    }),
    [pane, sessionResponse?.session.cwd]
  );
  const isTerminalLoginSession = sessionResponse?.session.purpose === "LOGIN";
  const activeRuntimeId = sessionResponse?.session.runtimeId ?? selectedRuntimeId;
  const supportsCliFileUploads = true;
  const canUpload = Boolean(
    supportsCliFileUploads &&
      sessionResponse?.session.purpose === "NORMAL" &&
      sessionResponse.session.isActive &&
      sessionResponse.websocket &&
      terminalControlState === "CONTROLLER" &&
      !uploading
  );

  function reportTerminalBootstrapped() {
    if (bootstrapReportedRef.current) return;
    bootstrapReportedRef.current = true;
    onBootstrapped?.(pane.id);
  }

  useEffect(() => {
    return registerTerminalPreviewGetter(pane.id, () => {
      if (terminalRef.current) {
        return extractRecentTerminalLines(terminalRef.current, 8);
      }
      if (sessionResponseRef.current?.transcript) {
        return extractTranscriptLines(sessionResponseRef.current.transcript, 8);
      }
      return [];
    });
  }, [pane.id]);

  useEffect(() => {
    if (pane.isMinimized && terminalRef.current) {
      const currentLines = extractRecentTerminalLines(terminalRef.current, 15);
      if (currentLines.length > 0) {
        seedTerminalPreviewLines(pane.id, currentLines);
      }
    }
  }, [pane.isMinimized, pane.id]);

  function settleTerminalPrefill(): void {
    const pending = terminalOutputCoordinatorRef.current?.snapshot().pendingPrefillEvents ?? 0;
    if (pending === 0) setTerminalPrefillReady(true);
    checkTerminalScreenRunning();
  }
  const activeTurnMarker = activeCliTurn?.marker ?? null;
  const isCodexCliSession = sessionResponse?.session.purpose === "NORMAL" && sessionResponse.session.runtimeId === DEFAULT_CLI_RUNTIME_ID;
  const isClaudeCliSession = sessionResponse?.session.purpose === "NORMAL" && sessionResponse.session.runtimeId === CLAUDE_CLI_RUNTIME_ID;
  // Codex and Claude Code turn a bracketed-pasted image path into a native image attachment.
  const usesNativeImagePaste = isCodexCliSession || isClaudeCliSession;
  const isTurnActivityPollingSession =
    sessionResponse?.session.purpose === "NORMAL" &&
    (sessionResponse.session.runtimeId === DEFAULT_CLI_RUNTIME_ID ||
      sessionResponse.session.runtimeId === GEMINI_CLI_RUNTIME_ID);
  const isOpenCodeCliSession = sessionResponse?.session.purpose === "NORMAL" && sessionResponse.session.runtimeId === OPENCODE_CLI_RUNTIME_ID;
  const isCliModelSettingsSession = sessionResponse?.session.purpose === "NORMAL" && isModelPickerRuntime(sessionResponse.session.runtimeId);
  const isFloatingTurnControlSession = isRunCapableCliSession(sessionResponse?.session);
  const isNormalAttachedCli = Boolean(
    sessionResponse?.session.purpose === "NORMAL" &&
      sessionResponse.session.isActive &&
      sessionResponse.websocket
  );
  const isTurnRunning = Boolean(activeCliTurn || modelSettings?.isTurnActive || fallbackRunActive || terminalScreenRunning);
  const isPaneWorking = isTurnRunning || backgroundAgentsRunning;

  useEffect(() => {
    onWorkingStateChange?.({
      isWorking: isPaneWorking,
      screenWorkingMs: terminalScreenWorkingMs
    });
  }, [isPaneWorking, terminalScreenWorkingMs, onWorkingStateChange]);
  const turnControlState = isTurnRunning
    ? "running"
    : terminalPromptDraft.trim() &&
        isFloatingTurnControlSession &&
        terminalStatus === "attached" &&
        terminalControlState === "CONTROLLER"
      ? "ready"
      : "idle";
  const canSendTurn = turnControlState === "ready";
  // With an empty prompt the button stops Claude's background agents; a typed prompt keeps Send.
  const stopsBackgroundAgents = backgroundAgentsRunning && turnControlState === "idle";
  const showsTurnStop = isTurnRunning || stopsBackgroundAgents;
  // After Stop the button would turn into Send under the pointer; hold it briefly so a double
  // click neither submits the draft nor sends a second interrupt (Ctrl+C twice exits some CLIs).
  const [turnStopPending, setTurnStopPending] = useState(false);
  const turnControlStopping = turnStopPending || (stopCooldown && isTurnRunning);
  const turnStopPendingTimerRef = useRef<number | null>(null);
  const lastBackgroundAgentStopAtRef = useRef(0);
  useEffect(() => () => {
    if (turnStopPendingTimerRef.current !== null) window.clearTimeout(turnStopPendingTimerRef.current);
  }, []);
  const voiceOwned = voiceInput.ownerId === voiceOwnerId;
  const voiceAttachmentEligible =
    isNormalAttachedCli &&
    isVisible &&
    !pane.isMinimized &&
    !observerOnly &&
    terminalStatus === "attached" &&
    terminalControlState === "CONTROLLER" &&
    !isTurnRunning &&
    !hideFloatingControls;
  const voiceDisabled =
    !voiceAttachmentEligible ||
    !voiceInput.settings.enabled ||
    !voiceInput.serverSettings?.enabled ||
    voiceInput.settingsLoading ||
    Boolean(voiceInput.ownerId && !voiceOwned) ||
    (voiceOwned && (voiceInput.status === "connecting" || voiceInput.status === "transcribing"));
  const voiceRecording = voiceOwned && voiceInput.status === "recording";
  const voiceElapsedMs = useRecordingElapsed(voiceRecording ? voiceInput.recordingStartedAt : null);
  const voiceClock = voiceRecording ? formatRecordingClock(voiceElapsedMs, voiceInput.serverSettings?.maxDurationMs) : null;
  const voiceStatusText = !voiceOwned
    ? null
    : voiceInput.status === "connecting"
      ? "Connecting microphone"
      : voiceInput.status === "recording"
        ? previewTail(voiceInput.preview) || "Listening"
        : voiceInput.status === "transcribing"
          ? previewTail(voiceInput.preview) || "Transcribing"
          : voiceInput.error;
  const showCliDebugMode = cliDebugModeEnabled ?? readStoredCliDebugMode();
  const imagePreviewLimit = normalizeCliImagePreviewLimit(maxImagePreviews);
  const showClipboardDebugPanel = Boolean(
    clipboardDebug &&
      clipboardDebug.at !== dismissedClipboardDebugAt &&
      showCliDebugMode
  );
  const priorClipboardDebugEntries = clipboardDebugHistory.slice(0, -1).reverse();

  function reportCliLifecycleEvent(
    event: CliTerminalClientEventInput["event"],
    outcome: CliTerminalClientEventInput["outcome"],
    reason: CliTerminalClientEventInput["reason"],
    details: Partial<Pick<
      CliTerminalClientEventInput,
      | "sessionId"
      | "runtimeId"
      | "controlState"
      | "protocolVersion"
      | "clientMode"
      | "socketGeneration"
      | "attempt"
      | "delayMs"
      | "closeCode"
      | "wasClean"
    >> = {}
  ) {
    const session = sessionResponseRef.current?.session;
    const control = terminalControlRef.current;
    reportCliClientEventBounded({
      event,
      outcome,
      reason,
      paneId: pane.id,
      sessionId: session?.sessionId ?? null,
      runtimeId: session?.runtimeId ?? null,
      controlState: control.state,
      protocolVersion: control.protocolVersion,
      clientMode: control.clientMode,
      clientAt: new Date().toISOString(),
      ...details
    });
  }

  function canRequestTerminalControl(realInteraction = false, readOnly?: boolean): boolean {
    return shouldRequestTerminalControl({
      isVisible: isVisibleRef.current,
      isMinimized: paneMinimizedRef.current,
      documentVisibility: typeof document === "undefined" ? "hidden" : document.visibilityState,
      documentHasFocus: typeof document !== "undefined" && document.hasFocus(),
      realInteraction,
      readOnly: readOnly ?? sessionResponseRef.current?.websocket?.proofScope === "READ_ONLY"
    });
  }

  function clearTerminalControlHeartbeat() {
    if (terminalControlHeartbeatRef.current === null) return;
    window.clearInterval(terminalControlHeartbeatRef.current);
    terminalControlHeartbeatRef.current = null;
  }

  function clearTerminalSocketKeepalive() {
    if (terminalSocketKeepaliveRef.current === null) return;
    window.clearInterval(terminalSocketKeepaliveRef.current);
    terminalSocketKeepaliveRef.current = null;
  }

  function scheduleTerminalSocketKeepalive(socket: WebSocket, sessionId: string) {
    clearTerminalSocketKeepalive();
    terminalSocketKeepaliveRef.current = window.setInterval(() => {
      if (
        socketRef.current !== socket ||
        readySocketRef.current?.socket !== socket ||
        readySocketRef.current.sessionId !== sessionId ||
        socket.readyState !== WebSocket.OPEN
      ) {
        clearTerminalSocketKeepalive();
        return;
      }
      socket.send(JSON.stringify({ type: "ping" }));
    }, 25_000);
  }

  function scheduleTerminalControlHeartbeat(socket: WebSocket, sessionId: string) {
    clearTerminalControlHeartbeat();
    const control = terminalControlRef.current;
    if (control.protocolVersion !== 2 || control.state !== "CONTROLLER" || !control.leaseId) return;
    const intervalMs = resolveTerminalControlHeartbeatIntervalMs(control.heartbeatIntervalMs, {
      isVisible: isVisibleRef.current,
      isController: true
    });
    terminalControlHeartbeatRef.current = window.setInterval(() => {
      const current = terminalControlRef.current;
      if (
        socketRef.current !== socket ||
        readySocketRef.current?.socket !== socket ||
        readySocketRef.current.sessionId !== sessionId ||
        socket.readyState !== WebSocket.OPEN ||
        current.protocolVersion !== 2 ||
        current.state !== "CONTROLLER" ||
        !current.leaseId
      ) {
        clearTerminalControlHeartbeat();
        return;
      }
      socket.send(JSON.stringify({ type: "control_heartbeat", leaseId: current.leaseId }));
      // A later denial may be for this heartbeat, so never replay an earlier, accepted input.
      lastTerminalControlMutationRef.current = null;
    }, intervalMs);
  }

  function setTerminalControl(
    next: Partial<TerminalControlSnapshot>,
    socket?: WebSocket,
    sessionId?: string
  ) {
    const control = { ...terminalControlRef.current, ...next };
    terminalControlRef.current = control;
    api.setCliTerminalControlLease(
      pane.id,
      control.protocolVersion === 2 && control.state === "CONTROLLER" ? control.leaseId : null
    );
    setTerminalControlState(control.state);
    if (control.state !== "CONTROLLER" || !control.leaseId) {
      clearTerminalControlHeartbeat();
    } else if (socket && sessionId) {
      scheduleTerminalControlHeartbeat(socket, sessionId);
    }
  }

  function resetTerminalControl() {
    terminalControlRequestPendingRef.current = false;
    observerControlUpgradePendingRef.current = false;
    clearTerminalControlHeartbeat();
    terminalControlRef.current = { ...initialTerminalControlSnapshot };
    api.setCliTerminalControlLease(pane.id, null);
    setTerminalControlState("AVAILABLE");
  }

  function terminalFileUploadSessionId(): string | null {
    const currentSession = sessionResponseRef.current;
    if (
      currentSession?.session.purpose !== "NORMAL" ||
      !currentSession.session.isActive ||
      !currentSession.websocket
    ) {
      return null;
    }
    return currentSession.session.sessionId;
  }

  function canUploadTerminalFiles(): boolean {
    const sessionId = terminalFileUploadSessionId();
    const socket = socketRef.current;
    const control = terminalControlRef.current;
    return Boolean(
      sessionId &&
      socket?.readyState === WebSocket.OPEN &&
      readySocketRef.current?.socket === socket &&
      readySocketRef.current.sessionId === sessionId &&
      (control.protocolVersion === 1 || (control.state === "CONTROLLER" && control.leaseId))
    );
  }

  function requestTerminalFileUploadControl(): "ready" | "pending" | "unavailable" {
    if (!terminalFileUploadSessionId()) {
      setError("Attach a CLI session before uploading files.");
      return "unavailable";
    }
    if (canUploadTerminalFiles()) return "ready";
    if (sessionResponseRef.current?.websocket?.proofScope === "READ_ONLY") {
      setNotice(null);
      setError("This terminal is live read-only in the current page.");
      return "unavailable";
    }
    if (!canRequestTerminalControl(true)) {
      setNotice(null);
      setError("This terminal cannot receive uploads right now.");
      return "unavailable";
    }
    ensureTerminalControl(true);
    setError(null);
    return "pending";
  }

  async function waitForTerminalFileUploadControl(
    timeoutMs = TERMINAL_UPLOAD_CONTROL_TIMEOUT_MS
  ): Promise<boolean> {
    const expectedSessionId = terminalFileUploadSessionId();
    if (!expectedSessionId) {
      setError("Attach a CLI session before uploading files.");
      return false;
    }
    if (sessionResponseRef.current?.websocket?.proofScope === "READ_ONLY") {
      setNotice(null);
      setError("This terminal is live read-only in the current page.");
      return false;
    }
    if (canUploadTerminalFiles()) return true;

    ensureTerminalControl(true);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (terminalFileUploadSessionId() !== expectedSessionId) {
        setNotice(null);
        setError("The CLI session disconnected before the upload could start.");
        return false;
      }
      if (canUploadTerminalFiles()) {
        setError(null);
        return true;
      }
      if (canRequestTerminalControl(true) && !terminalControlRequestPendingRef.current) {
        ensureTerminalControl(true);
      }
      await new Promise((resolve) => window.setTimeout(resolve, 25));
    }
    setNotice(null);
    terminalControlRequestPendingRef.current = false;
    setError("Terminal control is still changing. Try the upload again.");
    return false;
  }

  function releaseTerminalControl() {
    const socket = socketRef.current;
    const ready = readySocketRef.current;
    const control = terminalControlRef.current;
    terminalControlRequestPendingRef.current = false;
    if (
      socket &&
      ready?.socket === socket &&
      socket.readyState === WebSocket.OPEN &&
      control.protocolVersion === 2 &&
      control.state === "CONTROLLER" &&
      control.leaseId
    ) {
      socket.send(JSON.stringify({ type: "control_release", leaseId: control.leaseId }));
    }
    setTerminalControl({
      state: control.clientMode === "OBSERVER" ? "OBSERVER" : "AVAILABLE",
      leaseId: null,
      holderLeaseId: null,
      expiresAt: null
    });
  }

  // A hidden pane holds no lease (it may even be an observer) and the API takes a resize only
  // under one, so a hidden pane of the displayed full-screen room borrows the free lease to size
  // its CLI (operator-approved 2026-10-18).
  // shortcut: a grid another device set after this socket's last resize is not seen; read the PTY grid from the API if that shows up.
  function requestFullscreenPresize(cols: number, rows: number) {
    const socket = socketRef.current;
    const control = terminalControlRef.current;
    const sent = lastSentResizeRef.current;
    if (
      observerOnly ||
      !socket ||
      readySocketRef.current?.socket !== socket ||
      socket.readyState !== WebSocket.OPEN ||
      (sent?.socket === socket && sent.cols === cols && sent.rows === rows) ||
      control.protocolVersion !== 2 ||
      terminalControlRequestPendingRef.current ||
      observerControlUpgradePendingRef.current ||
      sessionResponseRef.current?.websocket?.proofScope === "READ_ONLY" ||
      document.visibilityState !== "visible" ||
      !document.hasFocus()
    ) return;
    if (control.clientMode === "OBSERVER") {
      fullscreenPresizeRef.current = { cols, rows };
      observerControlUpgradePendingRef.current = true;
      socket.send(JSON.stringify({ type: "control_upgrade" }));
      return;
    }
    if (control.state !== "AVAILABLE") return;
    fullscreenPresizeRef.current = { cols, rows };
    terminalControlRequestPendingRef.current = true;
    socket.send(JSON.stringify({ type: "control_request" }));
  }

  function presizeHiddenFullscreenPane() {
    const reference = readFullscreenGeometry();
    if (reference && fullscreenLayoutRef.current && presizeInFullscreenRef.current && !isVisibleRef.current) {
      requestFullscreenPresize(reference.cols, reference.rows);
    }
  }

  function upgradeObserverForTerminalControl(realInteraction = false) {
    if (
      observerControlUpgradePendingRef.current ||
      sessionResponseRef.current?.websocket?.proofScope === "READ_ONLY" ||
      !canRequestTerminalControl(realInteraction)
    ) return;
    const socket = socketRef.current;
    const ready = readySocketRef.current;
    const control = terminalControlRef.current;
    if (
      !socket ||
      ready?.socket !== socket ||
      socket.readyState !== WebSocket.OPEN ||
      control.protocolVersion !== 2 ||
      control.clientMode !== "OBSERVER"
    ) return;
    observerControlUpgradePendingRef.current = true;
    socket.send(JSON.stringify({ type: "control_upgrade" }));
  }

  function ensureTerminalControl(realInteraction = false) {
    if (!canRequestTerminalControl(realInteraction)) return;
    const socket = socketRef.current;
    const ready = readySocketRef.current;
    const control = terminalControlRef.current;
    if (!socket || ready?.socket !== socket || socket.readyState !== WebSocket.OPEN) return;
    if (control.protocolVersion === 1 || (control.state === "CONTROLLER" && control.leaseId)) return;
    if (control.clientMode === "OBSERVER") {
      upgradeObserverForTerminalControl(realInteraction);
      return;
    }
    if (terminalControlRequestPendingRef.current) return;
    if (realInteraction && control.state === "HELD_BY_OTHER" && control.holderLeaseId) {
      terminalControlRequestPendingRef.current = true;
      socket.send(JSON.stringify({
        type: "control_takeover",
        expectedLeaseId: control.holderLeaseId,
        interactionId: createCliTurnMarker()
      }));
      return;
    }
    if (control.state === "AVAILABLE" || (realInteraction && (control.state !== "CONTROLLER" || !control.leaseId))) {
      terminalControlRequestPendingRef.current = true;
      socket.send(JSON.stringify({ type: "control_request" }));
    }
  }

  const lifecyclePaneLabelRef = useRef({ title: pane.title, mode: pane.mode });
  lifecyclePaneLabelRef.current = { title: pane.title, mode: pane.mode };

  // Teardown follows pane identity only: a rename (the server renames panes
  // too) must not invalidate the live socket generation or pending loads.
  useEffect(() => {
    recordLifecycleDebugEvent({
      type: "component_mounted",
      scope: "TerminalPane",
      detail: `pane=${lifecyclePaneLabelRef.current.title}`,
      paneId: pane.id,
      paneMode: lifecyclePaneLabelRef.current.mode
    });
    return () => {
      loadRuntimesGenerationRef.current += 1;
      reconnectCoordinatorRef.current.invalidateCurrentSocketGeneration();
      const bufferedSocket = bufferedSocketRef.current;
      bufferedSocketRef.current = null;
      closeBufferedTerminalSocket(bufferedSocket);
      modelSettingsRefreshGenerationRef.current += 1;
      modelSettingsOutputRefreshArmRef.current = null;
      if (modelSettingsRefreshTimerRef.current !== null) {
        window.clearTimeout(modelSettingsRefreshTimerRef.current);
        modelSettingsRefreshTimerRef.current = null;
      }
      recordLifecycleDebugEvent({
        type: "component_unmounted",
        scope: "TerminalPane",
        detail: `pane=${lifecyclePaneLabelRef.current.title}`,
        paneId: pane.id,
        paneMode: lifecyclePaneLabelRef.current.mode
      });
    };
  }, [pane.id]);

  async function refreshModelSettings(expectedSessionId: string): Promise<boolean> {
    const generation = modelSettingsRefreshGenerationRef.current;
    try {
      const result = await api.cliModelSettingsStatus(pane.id);
      const activeSession = sessionResponseRef.current?.session;
      if (
        modelSettingsRefreshGenerationRef.current !== generation ||
        !activeSession?.isActive ||
        activeSession.purpose !== "NORMAL" ||
        !isModelPickerRuntime(activeSession.runtimeId) ||
        activeSession.sessionId !== expectedSessionId
      ) {
        return false;
      }
      if (result.status === "UNAVAILABLE") {
        setModelSettingsError(result.reason);
        if (modelSettingsRef.current?.sessionId === expectedSessionId) {
          return true;
        }
        return false;
      }
      const settings = result.settings;
      if (settings.sessionId !== expectedSessionId) return false;
      modelSettingsRef.current = settings;
      setModelSettingsError(null);
      setModelSettings((prev) => {
        if (
          prev &&
          prev.sessionId === settings.sessionId &&
          prev.threadId === settings.threadId &&
          prev.isTurnActive === settings.isTurnActive &&
          prev.controlMode === settings.controlMode &&
          prev.current?.modelId === settings.current?.modelId &&
          prev.current?.reasoningEffort === settings.current?.reasoningEffort &&
          // A catalog can change while keeping its size (renamed, swapped or re-tiered models).
          JSON.stringify(prev.models) === JSON.stringify(settings.models)
        ) {
          return prev;
        }
        return settings;
      });
      return true;
    } catch {
      const activeSession = sessionResponseRef.current?.session;
      if (
        modelSettingsRefreshGenerationRef.current !== generation ||
        !activeSession?.isActive ||
        activeSession.purpose !== "NORMAL" ||
        !isModelPickerRuntime(activeSession.runtimeId) ||
        activeSession.sessionId !== expectedSessionId
      ) {
        return false;
      }
      if (modelSettingsRef.current?.sessionId === expectedSessionId) {
        return true;
      }
      setModelSettingsError("Model settings are unavailable. Click to retry.");
      return false;
    }
  }

  function clearModelSettingsOutputRefresh(expectedSocket?: WebSocket) {
    const arm = modelSettingsOutputRefreshArmRef.current;
    if (expectedSocket && arm?.socket !== expectedSocket) return;
    modelSettingsOutputRefreshArmRef.current = null;
    if (modelSettingsRefreshTimerRef.current !== null) {
      window.clearTimeout(modelSettingsRefreshTimerRef.current);
      modelSettingsRefreshTimerRef.current = null;
    }
  }

  function modelSettingsRefreshIdentityMatches(arm: ModelSettingsOutputRefreshArm): boolean {
    const session = sessionResponseRef.current?.session;
    const socket = socketRef.current;
    return Boolean(
      session?.isActive &&
        isModelPickerRuntime(session.runtimeId) &&
        session.sessionId === arm.sessionId &&
        socket === arm.socket &&
        socket.readyState === WebSocket.OPEN &&
        readySocketRef.current?.socket === arm.socket &&
        readySocketRef.current.sessionId === arm.sessionId &&
        terminalRef.current === arm.terminal
    );
  }

  function armModelSettingsOutputRefresh(data: string, socket: WebSocket, sessionId: string, terminal: XtermTerminal | null) {
    if (
      !shouldRefreshModelSettingsFromOutput({
        isVisible: isVisibleRef.current,
        isMinimized: paneMinimizedRef.current,
        documentHidden: typeof document !== "undefined" && document.visibilityState === "hidden"
      })
    ) {
      return;
    }
    if (!terminal || !shouldRefreshCliModelSettings("input", data)) return;
    if (modelSettingsRefreshTimerRef.current !== null) {
      window.clearTimeout(modelSettingsRefreshTimerRef.current);
      modelSettingsRefreshTimerRef.current = null;
    }
    modelSettingsOutputRefreshArmRef.current = {
      socket,
      sessionId,
      token: modelSettingsOutputRefreshTokenRef.current + 1,
      outputRevision: 0,
      terminal,
      baselineScreen: terminalSemanticScreenFingerprint(terminal)
    };
    modelSettingsOutputRefreshTokenRef.current += 1;
  }

  function scheduleModelSettingsRefreshAfterParsedOutput(expectedToken: number, expectedOutputRevision: number) {
    const arm = modelSettingsOutputRefreshArmRef.current;
    if (
      !arm ||
      arm.token !== expectedToken ||
      arm.outputRevision !== expectedOutputRevision ||
      !modelSettingsRefreshIdentityMatches(arm)
    ) return;
    if (terminalSemanticScreenFingerprint(arm.terminal) === arm.baselineScreen) {
      if (modelSettingsRefreshTimerRef.current !== null) {
        window.clearTimeout(modelSettingsRefreshTimerRef.current);
        modelSettingsRefreshTimerRef.current = null;
      }
      return;
    }
    if (modelSettingsRefreshTimerRef.current !== null) {
      window.clearTimeout(modelSettingsRefreshTimerRef.current);
    }
    modelSettingsRefreshTimerRef.current = window.setTimeout(() => {
      modelSettingsRefreshTimerRef.current = null;
      const currentArm = modelSettingsOutputRefreshArmRef.current;
      if (
        currentArm !== arm ||
        currentArm.token !== expectedToken ||
        currentArm.outputRevision !== expectedOutputRevision ||
        !modelSettingsRefreshIdentityMatches(currentArm) ||
        terminalSemanticScreenFingerprint(currentArm.terminal) === currentArm.baselineScreen
      ) return;
      modelSettingsOutputRefreshArmRef.current = null;
      void refreshModelSettings(currentArm.sessionId);
    }, CLI_MODEL_SETTINGS_REFRESH_DELAY_MS);
  }

  useEffect(() => {
    sessionResponseRef.current = sessionResponse;
  }, [sessionResponse]);

  useEffect(() => {
    onPrefillReadyChange?.(pane.id, terminalPrefillReady);
  }, [onPrefillReadyChange, pane.id, terminalPrefillReady]);

  useEffect(() => {
    if (loading) return;
    if (
      terminalStatus === "closed" ||
      (sessionResponse !== null && !sessionResponse.websocket) ||
      (observerOnly && sessionResponse === null && !pending) ||
      (!pending && Boolean(error))
    ) {
      setTerminalPrefillReady(true);
    }
  }, [error, loading, observerOnly, pending, sessionResponse, terminalStatus]);

  useEffect(() => {
    if (loading) return;
    if (
      terminalStatus === "closed" ||
      (sessionResponse !== null && !sessionResponse.websocket) ||
      (sessionResponse !== null && !sessionResponse.session && !pending) ||
      (observerOnly && sessionResponse === null && !pending) ||
      (!pending && Boolean(error))
    ) {
      // Session-less/closed panes report reveal-ready even while hidden;
      // visibility-gating here deadlocked the room reveal when orphan panes
      // existed (user-reported: Room 6 with 4 session-less panes never
      // revealed). User-approved 2026-08-14.
      onRevealReady?.(pane.id, revealGenerationRef.current);
    }
  }, [error, loading, observerOnly, onRevealReady, pane.id, pending, sessionResponse, terminalStatus]);

  useEffect(() => {
    const session = sessionResponse?.session;
    if (!session) {
      setActiveCliTurn(null);
    } else if (session.purpose === "NORMAL" && isTurnCapableRuntime(session.runtimeId) && session.isActive) {
      setActiveCliTurn(readStoredActiveCliTurn(pane.id, session.sessionId));
    } else {
      clearStoredActiveCliTurn(pane.id);
      setActiveCliTurn(null);
    }
    if (terminalPromptDraftDebounceTimerRef.current !== null) {
      window.clearTimeout(terminalPromptDraftDebounceTimerRef.current);
      terminalPromptDraftDebounceTimerRef.current = null;
    }
    terminalPromptDraftRef.current = { text: "", cursor: 0 };
    managedPromptAttachmentsRef.current = { imageCount: 0, videoCount: 0, fileCount: 0, pending: [] };
    setTerminalPromptDraft("");
  }, [pane.id, sessionResponse?.session.isActive, sessionResponse?.session.purpose, sessionResponse?.session.runtimeId, sessionResponse?.session.sessionId]);

  useEffect(() => {
    const session = sessionResponse?.session;
    if (
      !sessionResponse?.websocket ||
      !session?.isActive ||
      session.purpose !== "NORMAL" ||
      !isModelPickerRuntime(session.runtimeId) ||
      terminalStatus !== "attached" ||
      !terminalReplayReady
    ) {
      modelSettingsRefreshGenerationRef.current += 1;
      modelSettingsRef.current = null;
      setModelSettings(null);
      return;
    }
    modelSettingsRefreshGenerationRef.current += 1;
    if (modelSettingsRef.current?.sessionId !== session.sessionId) {
      modelSettingsRef.current = null;
      setModelSettings(null);
      setModelSettingsError(null);
    }
    const generation = modelSettingsRefreshGenerationRef.current;
    let disposed = false;
    let retryTimer: number | null = null;
    const loadStartupModelSettings = async (attempt: number) => {
      const loaded = await refreshModelSettings(session.sessionId);
      if (disposed || modelSettingsRefreshGenerationRef.current !== generation) return;
      if (loaded && modelSettingsRef.current?.sessionId === session.sessionId &&
        cliModelSettingsCurrentIsSettled(modelSettingsRef.current)) return;
      // Keep polling until the runtime confirms the current model (fresh OpenCode
      // panes resolve it shortly after boot). A session-default reading is only a
      // placeholder, so it does not stop the retries. Stops as soon as a
      // confirmed current appears so idle panes do not poll forever.
      const retryDelay = CLI_MODEL_SETTINGS_STARTUP_RETRY_DELAYS_MS[attempt];
      if (retryDelay === undefined) return;
      retryTimer = window.setTimeout(() => {
        retryTimer = null;
        void loadStartupModelSettings(attempt + 1);
      }, retryDelay);
    };
    void loadStartupModelSettings(0);
    return () => {
      disposed = true;
      if (retryTimer !== null) window.clearTimeout(retryTimer);
      modelSettingsRefreshGenerationRef.current += 1;
    };
  }, [pane.id, sessionResponse?.session.isActive, sessionResponse?.session.purpose, sessionResponse?.session.runtimeId, sessionResponse?.session.sessionId, sessionResponse?.websocket, terminalReplayReady, terminalStatus]);

  useEffect(() => {
    if ((!modelSettings?.isTurnActive && !terminalScreenRunning) || activeCliTurn || !sessionResponse?.session.isActive) return;
    let disposed = false;
    const timer = window.setTimeout(() => {
      if (!disposed) void refreshModelSettings(sessionResponse.session.sessionId);
    }, CLI_TURN_ACTIVITY_POLL_MS);
    return () => {
      disposed = true;
      window.clearTimeout(timer);
    };
  }, [activeCliTurn, modelSettings?.isTurnActive, terminalScreenRunning, pane.id, sessionResponse?.session.isActive, sessionResponse?.session.sessionId]);

  useEffect(() => {
    if (!activeTurnMarker || !isTurnActivityPollingSession || !sessionResponse?.session.isActive) return;
    let disposed = false;
    let timer: number | null = null;
    const discoveryDeadlineMs = Date.now() + CLI_TURN_ACTIVITY_DISCOVERY_GRACE_MS;
    const schedulePoll = () => {
      timer = window.setTimeout(() => void poll(), CLI_TURN_ACTIVITY_POLL_MS);
    };

    const poll = async () => {
      try {
        const activity = await api.cliTurnActivity(pane.id, activeTurnMarker);
        if (disposed || activity.marker !== activeTurnMarker) return;
        if (activity.status === "PENDING") {
          if (Date.now() >= discoveryDeadlineMs && !terminalScreenRunningRef.current) {
            setActiveCliTurn((current) => (current?.marker === activeTurnMarker ? null : current));
            clearStoredActiveCliTurn(pane.id);
            return;
          }
          const nextTurn = { marker: activeTurnMarker, status: "PENDING" as const };
          setActiveCliTurn((current) =>
            current?.marker === activeTurnMarker ? nextTurn : current
          );
          storeActiveCliTurn(pane.id, sessionResponse.session.sessionId, nextTurn);
          schedulePoll();
          return;
        }
        if (activity.status === "RUNNING") {
          const status: ActiveCliTurn["status"] = activity.status;
          const nextTurn = { marker: activeTurnMarker, status };
          setActiveCliTurn((current) =>
            current?.marker === activeTurnMarker ? nextTurn : current
          );
          storeActiveCliTurn(pane.id, sessionResponse.session.sessionId, nextTurn);
          schedulePoll();
          return;
        }
        if (activity.status === "UNAVAILABLE" && (Date.now() < discoveryDeadlineMs || terminalScreenRunningRef.current)) {
          schedulePoll();
          return;
        }
        publishPaneRunLifecycle({
          roomId: pane.roomId,
          paneId: pane.id,
          runKey: activeTurnMarker,
          status: activity.status === "COMPLETED" ? "COMPLETED" : "FAILED"
        });
        setActiveCliTurn((current) => (current?.marker === activeTurnMarker ? null : current));
        clearStoredActiveCliTurn(pane.id);
      } catch {
        if (!disposed) schedulePoll();
      }
    };

    void poll();
    return () => {
      disposed = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [activeTurnMarker, isTurnActivityPollingSession, pane.id, pane.roomId, sessionResponse?.session.isActive, sessionResponse?.session.sessionId]);

  useEffect(() => {
    if (!activeTurnMarker || !isOpenCodeCliSession || !sessionResponse?.session.isActive) return;
    let disposed = false;
    let timer: number | null = null;
    const discoveryDeadlineMs = Date.now() + CLI_TURN_ACTIVITY_DISCOVERY_GRACE_MS;
    const schedulePoll = (delayMs = CLI_TURN_ACTIVITY_POLL_MS) => {
      timer = window.setTimeout(() => void poll(), delayMs);
    };
    const finish = (status: "COMPLETED" | "FAILED") => {
      publishPaneRunLifecycle({
        roomId: pane.roomId,
        paneId: pane.id,
        runKey: activeTurnMarker,
        status
      });
      if (openCodeObservedRunningMarkerRef.current === activeTurnMarker) {
        openCodeObservedRunningMarkerRef.current = null;
      }
      setActiveCliTurn((current) => (current?.marker === activeTurnMarker ? null : current));
      clearStoredActiveCliTurn(pane.id);
    };
    const poll = async () => {
      await refreshModelSettings(sessionResponse.session.sessionId);
      if (disposed) return;
      if (modelSettingsRef.current?.isTurnActive) {
        openCodeObservedRunningMarkerRef.current = activeTurnMarker;
        const nextTurn = { marker: activeTurnMarker, status: "RUNNING" as const };
        setActiveCliTurn((current) => current?.marker === activeTurnMarker ? nextTurn : current);
        storeActiveCliTurn(pane.id, sessionResponse.session.sessionId, nextTurn);
        schedulePoll();
        return;
      }
      if (openCodeObservedRunningMarkerRef.current === activeTurnMarker) {
        finish("COMPLETED");
        return;
      }
      if (Date.now() < discoveryDeadlineMs) {
        schedulePoll(250);
        return;
      }
      finish("FAILED");
    };
    void poll();
    return () => {
      disposed = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [activeTurnMarker, isOpenCodeCliSession, pane.id, pane.roomId, sessionResponse?.session.isActive, sessionResponse?.session.sessionId]);

  useEffect(() => {
    isVisibleRef.current = isVisible;
    if (canRequestTerminalControl()) ensureTerminalControl();
    else releaseTerminalControl();
  }, [isVisible]);

  useEffect(() => {
    const reconcilePageControl = () => {
      if (canRequestTerminalControl()) ensureTerminalControl();
      else releaseTerminalControl();
      // A presize skipped on an unfocused page runs once the page is back.
      presizeHiddenFullscreenPane();
    };
    const releasePageControl = () => releaseTerminalControl();
    window.addEventListener("focus", reconcilePageControl);
    window.addEventListener("blur", releasePageControl);
    document.addEventListener("visibilitychange", reconcilePageControl);
    return () => {
      window.removeEventListener("focus", reconcilePageControl);
      window.removeEventListener("blur", releasePageControl);
      document.removeEventListener("visibilitychange", reconcilePageControl);
    };
    // Refs keep visibility, session, and socket authority current without rebinding global listeners.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pane.id]);

  useEffect(() => {
    if (typeof window === "undefined" || typeof document === "undefined") return;
    const intervalId = window.setInterval(() => checkTerminalSocketHealth("watchdog"), TERMINAL_SOCKET_WATCHDOG_INTERVAL_MS);
    const onWindowFocus = () => checkTerminalSocketHealth("focus");
    const onVisibilityChange = () => checkTerminalSocketHealth("visibilitychange");
    const onAppResumed = () => checkTerminalSocketHealth("app-resumed");
    window.addEventListener("focus", onWindowFocus);
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("space:app-resumed", onAppResumed);
    return () => {
      window.clearInterval(intervalId);
      if (terminalSocketProbeTimerRef.current !== null) window.clearTimeout(terminalSocketProbeTimerRef.current);
      terminalSocketProbeTimerRef.current = null;
      window.removeEventListener("focus", onWindowFocus);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("space:app-resumed", onAppResumed);
    };
    // Refs keep session and socket authority current; triggerTerminalSocketRecovery only touches refs and stable setters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pane.id]);

  useEffect(() => {
    if (pane.isMinimized) releaseTerminalControl();
    else if (canRequestTerminalControl()) ensureTerminalControl();
  }, [pane.isMinimized]);

  useEffect(() => {
    setDismissedClipboardDebugAt(null);
  }, [pane.id]);

  // A missing purpose is the schema default, NORMAL.
  const actionSessionActive = Boolean(sessionResponse?.session.isActive) && (sessionResponse?.session.purpose ?? "NORMAL") === "NORMAL";
  const actionControllable = !observerOnly && sessionResponse?.websocket?.proofScope !== "READ_ONLY";
  const actionRuntimeReady = Boolean(selectedRuntime) && !observerOnly && !pane.id.startsWith("pane:optimistic-");
  const actionHasDraft = Boolean(terminalPromptDraft.trim());
  useEffect(() => {
    onActionAvailabilityChange?.({
      hasSession: sessionResponse !== null,
      sessionActive: actionSessionActive,
      attached: actionSessionActive && terminalStatus === "attached",
      controllable: actionControllable,
      turnRunning: isTurnRunning,
      screenActive: terminalScreenActive,
      stopCooldown,
      hasDraft: actionHasDraft,
      requestPending: pending,
      shortcutPending: shortcutPending || claudePlanModeActionPending,
      uploading,
      planMode: actionSessionActive ? terminalPlanMode : null,
      promptSeen: Boolean(sessionResponse && promptSeenSessionId === sessionResponse.session.sessionId),
      runtimeReady: actionRuntimeReady
    });
  }, [
    actionControllable,
    actionHasDraft,
    actionRuntimeReady,
    actionSessionActive,
    isTurnRunning,
    onActionAvailabilityChange,
    pending,
    sessionResponse,
    shortcutPending,
    claudePlanModeActionPending,
    stopCooldown,
    promptSeenSessionId,
    terminalPlanMode,
    terminalScreenActive,
    terminalStatus,
    uploading
  ]);

  useEffect(() => {
    onSessionMetadataChange?.(
      sessionResponse
        ? {
            sessionId: sessionResponse.session.sessionId,
            codexThreadId: sessionResponse.session.codexThreadId,
            runtimeId: sessionResponse.session.runtimeId,
            purpose: sessionResponse.session.purpose
          }
        : null
    );
  }, [onSessionMetadataChange, sessionResponse?.session.codexThreadId, sessionResponse?.session.purpose, sessionResponse?.session.runtimeId, sessionResponse?.session.sessionId]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const debugWindow = window as typeof window & {
      __spaceClipboardDebug?: {
        paneId: string;
        latest: ClipboardDebugState | null;
        history: ClipboardDebugState[];
      };
    };
    debugWindow.__spaceClipboardDebug = {
      paneId: pane.id,
      latest: clipboardDebug,
      history: clipboardDebugHistory
    };
    return () => {
      if (debugWindow.__spaceClipboardDebug?.paneId === pane.id) {
        delete debugWindow.__spaceClipboardDebug;
      }
    };
  }, [clipboardDebug, clipboardDebugHistory, pane.id]);

  function preconnectRunningTerminal(activeSession: PaneCliSessionResponse): BufferedTerminalSocket | null {
    const ticket = activeSession.websocket;
    if (
      bufferedSocketRef.current &&
      (!ticket || !terminalWebSocketTicketsMatch(bufferedSocketRef.current.ticket, ticket))
    ) {
      closeBufferedTerminalSocket(bufferedSocketRef.current);
      bufferedSocketRef.current = null;
    }
    if (ticket && activeSession.session.status === "RUNNING" && !bufferedSocketRef.current) {
      const clientMode = canRequestTerminalControl(false, ticket.proofScope === "READ_ONLY")
        ? "INTERACTIVE"
        : "OBSERVER";
      const geometry = activeSession.session.terminalGeometry;
      const initialGeometry =
        geometry &&
        Number.isInteger(geometry.cols) &&
        geometry.cols >= 2 &&
        geometry.cols <= 400 &&
        Number.isInteger(geometry.rows) &&
        geometry.rows >= 2 &&
        geometry.rows <= 200
          ? { initialCols: geometry.cols, initialRows: geometry.rows }
          : {};
      const bufferedSocket = createBufferedTerminalSocket(ticket, {
        clientMode,
        leaseId: terminalControlRef.current.leaseId,
        ...initialGeometry
      });
      bufferedSocketRef.current = bufferedSocket;
      return bufferedSocket;
    }
    return null;
  }

  function restoreActiveSession(activeSession: PaneCliSessionResponse): void {
    preconnectRunningTerminal(activeSession);
    setTerminalStatus(activeSession.websocket ? "connecting" : "idle");
    setSessionResponse(activeSession);
    setSelectedRuntimeId(activeSession.session.runtimeId);
    recordLifecycleDebugEvent({
      type: "session_sync",
      scope: "TerminalPane",
      detail: `runtime=${activeSession.session.runtimeId} status=${activeSession.session.status} restored=active`,
      paneId: pane.id,
      paneMode: pane.mode
    });
    if (!activeSession.websocket) reportTerminalBootstrapped();
    if (!activeSession.websocket) settleTerminalPrefill();
  }

  async function loadRuntimes(showLoading = true) {
    if (pane.id.startsWith("pane:optimistic-")) return;
    // Fetch the shared renderer while session/registry requests are in flight.
    // This imports code only: minimized-pane attachment remains deferred.
    void loadTerminalModules().catch(() => undefined);
    const generation = ++loadRuntimesGenerationRef.current;
    const bootstrapParticipant = bootstrapBarrier?.join(pane.id);
    if (observerOnly) {
      if (showLoading) setLoading(true);
      setError(null);
      setNotice(null);
      try {
        const activeSession = await api.activeCliSession(pane.id, { includeTranscript: false })
          .finally(() => {
            void bootstrapParticipant?.arrive();
          });
        if (generation !== loadRuntimesGenerationRef.current) return;
        if (activeSession && isRecoverableCliSession(activeSession.session)) {
          restoreActiveSession(activeSession);
        } else {
          reportTerminalBootstrapped();
          settleTerminalPrefill();
        }
      } catch (err) {
        if (generation === loadRuntimesGenerationRef.current) {
          setError(err instanceof Error ? err.message : "Active CLI session failed to load");
          reportTerminalBootstrapped();
          settleTerminalPrefill();
        }
      } finally {
        if (showLoading && generation === loadRuntimesGenerationRef.current) setLoading(false);
      }
      return;
    }

    let earlyBufferedSocket: BufferedTerminalSocket | null = null;
    let allowEarlyPreconnect = true;
    if (showLoading) setLoading(true);
    setError(null);
    setNotice(null);
    try {
      const activeSessionPromise = api.activeCliSession(pane.id, { includeTranscript: false })
        .then((activeSession) => {
          if (
            allowEarlyPreconnect &&
            generation === loadRuntimesGenerationRef.current &&
            activeSession &&
            isRecoverableCliSession(activeSession.session)
          ) {
            earlyBufferedSocket = preconnectRunningTerminal(activeSession);
          }
          return activeSession;
        })
        .finally(() => {
          void bootstrapParticipant?.arrive();
        });
      const [nextRegistry, activeSession] = await Promise.all([
        api.cliRuntimes({ allowStale: true }),
        activeSessionPromise
      ]);
      lastActiveSessionCheckedMsRef.current = Date.now();
      allowEarlyPreconnect = false;
      if (generation !== loadRuntimesGenerationRef.current) return;
      setRegistry(nextRegistry);
      const runtimes = nextRegistry.data.filter((runtime) => runtime.capabilities.includes("CLI"));
      if (activeSession && isRecoverableCliSession(activeSession.session)) {
        restoreActiveSession(activeSession);
      } else if (!runtimes.some((runtime) => runtime.id === selectedRuntimeId)) {
        setSelectedRuntimeId(runtimes.find((runtime) => runtime.id === DEFAULT_CLI_RUNTIME_ID)?.id ?? runtimes[0]?.id ?? DEFAULT_CLI_RUNTIME_ID);
        reportTerminalBootstrapped();
        settleTerminalPrefill();
      } else {
        reportTerminalBootstrapped();
        settleTerminalPrefill();
      }
    } catch (err) {
      allowEarlyPreconnect = false;
      if (generation === loadRuntimesGenerationRef.current) {
        if (earlyBufferedSocket && bufferedSocketRef.current === earlyBufferedSocket) {
          bufferedSocketRef.current = null;
          closeBufferedTerminalSocket(earlyBufferedSocket);
        }
        setError(err instanceof Error ? err.message : "CLI runtimes failed to load");
        reportTerminalBootstrapped();
        settleTerminalPrefill();
      }
    } finally {
      if (showLoading && generation === loadRuntimesGenerationRef.current) setLoading(false);
    }
  }

  async function attachReplacedCliSession(expectedSessionId: string, expectedRuntimeId: string) {
    const generation = ++loadRuntimesGenerationRef.current;
    try {
      const [nextRegistry, activeSession] = await Promise.all([
        api.cliRuntimes(),
        api.activeCliSession(pane.id, { includeTranscript: false })
      ]);
      if (generation !== loadRuntimesGenerationRef.current) return;
      setRegistry(nextRegistry);
      if (
        !activeSession ||
        !activeSession.websocket ||
        !isRecoverableCliSession(activeSession.session) ||
        activeSession.session.sessionId !== expectedSessionId ||
        activeSession.session.paneId !== pane.id ||
        activeSession.session.runtimeId !== expectedRuntimeId ||
        activeSession.session.purpose !== "NORMAL"
      ) {
        setTerminalStatus("closed");
        setError("The verified CLI session could not be attached. Reconnect this pane.");
        return;
      }
      setError(null);
      setNotice(null);
      setConnectionAlert(null);
      setTerminalStatus("connecting");
      setSelectedRuntimeId(activeSession.session.runtimeId);
      setSessionResponse(activeSession);
      recordLifecycleDebugEvent({
        type: "session_sync",
        scope: "TerminalPane",
        detail: `runtime=${activeSession.session.runtimeId} status=${activeSession.session.status} restored=login-replacement`,
        paneId: pane.id,
        paneMode: pane.mode
      });
    } catch {
      if (generation !== loadRuntimesGenerationRef.current) return;
      setTerminalStatus("closed");
      setError("The verified CLI session could not be attached. Reconnect this pane.");
    }
  }

  useEffect(() => {
    if (!shouldBootstrap) {
      setLoading(false);
      settleTerminalPrefill();
      return;
    }
    void loadRuntimes();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pane.id, shouldBootstrap]);

  useEffect(() => {
    if (!isGeminiRuntime || observerOnly) return;
    let cancelled = false;
    const loadAccountProfiles = () => {
      const load = api.listCliAccountProfiles("cli:gemini");
      accountProfilesLoadRef.current = { runtimeId: "cli:gemini", result: load };
      void load.then((result) => {
        if (cancelled) return;
        setGeminiAccountProfiles(result.profiles);
        setSelectedGeminiAccountProfileId((current) => {
          const profileId = cliAccountProfileForPane(result, current, isNewCliPane(pane.createdAt, Boolean(sessionResponseRef.current)));
          writeLastCliAccountProfileId("cli:gemini", profileId);
          return profileId;
        });
      }).catch(() => {
        if (!cancelled) setGeminiAccountProfiles([]);
      });
    };
    loadAccountProfiles();
    window.addEventListener(CLI_ACCOUNT_PROFILES_EVENT, loadAccountProfiles);
    return () => {
      cancelled = true;
      window.removeEventListener(CLI_ACCOUNT_PROFILES_EVENT, loadAccountProfiles);
    };
  }, [isGeminiRuntime, observerOnly, pane.createdAt]);

  useEffect(() => {
    if (!isCopilotRuntime || observerOnly) return;
    let cancelled = false;
    const loadAccountProfiles = () => {
      const load = api.listCliAccountProfiles("cli:copilot");
      accountProfilesLoadRef.current = { runtimeId: "cli:copilot", result: load };
      void load.then((result) => {
        if (cancelled) return;
        setCopilotAccountProfiles(result.profiles);
        setSelectedCopilotAccountProfileId((current) => {
          const profileId = cliAccountProfileForPane(result, current, isNewCliPane(pane.createdAt, Boolean(sessionResponseRef.current)));
          writeLastCliAccountProfileId("cli:copilot", profileId);
          return profileId;
        });
      }).catch(() => {
        if (!cancelled) setCopilotAccountProfiles([]);
      });
    };
    loadAccountProfiles();
    window.addEventListener(CLI_ACCOUNT_PROFILES_EVENT, loadAccountProfiles);
    return () => {
      cancelled = true;
      window.removeEventListener(CLI_ACCOUNT_PROFILES_EVENT, loadAccountProfiles);
    };
  }, [isCopilotRuntime, observerOnly, pane.createdAt]);

  useEffect(() => {
    if (!isCursorRuntime || observerOnly) return;
    let cancelled = false;
    const loadAccountProfiles = () => {
      const load = api.listCliAccountProfiles("cli:cursor");
      accountProfilesLoadRef.current = { runtimeId: "cli:cursor", result: load };
      void load.then((result) => {
        if (cancelled) return;
        setCursorAccountProfiles(result.profiles);
        setSelectedCursorAccountProfileId((current) => {
          const profileId = cliAccountProfileForPane(result, current, isNewCliPane(pane.createdAt, Boolean(sessionResponseRef.current)));
          writeLastCliAccountProfileId("cli:cursor", profileId);
          return profileId;
        });
      }).catch(() => {
        if (!cancelled) setCursorAccountProfiles([]);
      });
    };
    loadAccountProfiles();
    window.addEventListener(CLI_ACCOUNT_PROFILES_EVENT, loadAccountProfiles);
    return () => {
      cancelled = true;
      window.removeEventListener(CLI_ACCOUNT_PROFILES_EVENT, loadAccountProfiles);
    };
  }, [isCursorRuntime, observerOnly, pane.createdAt]);

  useEffect(() => {
    if (!isKimiRuntime || observerOnly) return;
    let cancelled = false;
    const loadAccountProfiles = () => {
      const load = api.listCliAccountProfiles("cli:kimi");
      accountProfilesLoadRef.current = { runtimeId: "cli:kimi", result: load };
      void load.then((result) => {
        if (cancelled) return;
        setKimiAccountProfiles(result.profiles);
        setSelectedKimiAccountProfileId((current) => {
          const profileId = cliAccountProfileForPane(result, current, isNewCliPane(pane.createdAt, Boolean(sessionResponseRef.current)));
          writeLastCliAccountProfileId("cli:kimi", profileId);
          return profileId;
        });
      }).catch(() => {
        if (!cancelled) setKimiAccountProfiles([]);
      });
    };
    loadAccountProfiles();
    window.addEventListener(CLI_ACCOUNT_PROFILES_EVENT, loadAccountProfiles);
    return () => {
      cancelled = true;
      window.removeEventListener(CLI_ACCOUNT_PROFILES_EVENT, loadAccountProfiles);
    };
  }, [isKimiRuntime, observerOnly, pane.createdAt]);

  useEffect(() => {
    if (!isClaudeRuntime || observerOnly) return;
    let cancelled = false;
    const loadAccountProfiles = () => {
      const load = api.listCliAccountProfiles("cli:claude");
      accountProfilesLoadRef.current = { runtimeId: "cli:claude", result: load };
      void load.then((result) => {
        if (cancelled) return;
        setClaudeAccountProfiles(result.profiles);
        setSelectedClaudeAccountProfileId((current) => {
          const profileId = cliAccountProfileForPane(result, current, isNewCliPane(pane.createdAt, Boolean(sessionResponseRef.current)));
          writeLastCliAccountProfileId("cli:claude", profileId);
          return profileId;
        });
      }).catch(() => {
        if (!cancelled) setClaudeAccountProfiles([]);
      });
    };
    loadAccountProfiles();
    window.addEventListener(CLI_ACCOUNT_PROFILES_EVENT, loadAccountProfiles);
    return () => {
      cancelled = true;
      window.removeEventListener(CLI_ACCOUNT_PROFILES_EVENT, loadAccountProfiles);
    };
  }, [isClaudeRuntime, observerOnly, pane.createdAt]);

  useEffect(() => {
    if (!uploadPreviews.length) {
      setUploadPreviewsOpen(false);
    }
  }, [uploadPreviews.length]);

  useEffect(() => {
    if (!uploadPreviewsOpen) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (shouldPreserveForSnipTool(event)) return;
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (selectedUploadPreviewId) return;
      if (uploadPreviewsPickerRef.current?.contains(target)) return;
      setUploadPreviewsOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (selectedUploadPreviewId) return;
      event.preventDefault();
      event.stopPropagation();
      setUploadPreviewsOpen(false);
      uploadPreviewsButtonRef.current?.focus();
    };
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [uploadPreviewsOpen, selectedUploadPreviewId]);

  useEffect(() => {
    const session = sessionResponse?.session;
    if (session?.runtimeId === "cli:gemini") {
      const profileId = session.accountProfileId ?? "main";
      setSelectedGeminiAccountProfileId(profileId);
      writeLastCliAccountProfileId("cli:gemini", profileId);
    } else if (session?.runtimeId === "cli:copilot") {
      const profileId = session.accountProfileId ?? "main";
      setSelectedCopilotAccountProfileId(profileId);
      writeLastCliAccountProfileId("cli:copilot", profileId);
    } else if (session?.runtimeId === "cli:cursor") {
      const profileId = session.accountProfileId ?? "main";
      setSelectedCursorAccountProfileId(profileId);
      writeLastCliAccountProfileId("cli:cursor", profileId);
    } else if (session?.runtimeId === "cli:kimi") {
      const profileId = session.accountProfileId ?? "main";
      setSelectedKimiAccountProfileId(profileId);
      writeLastCliAccountProfileId("cli:kimi", profileId);
    } else if (session?.runtimeId === "cli:claude") {
      const profileId = session.accountProfileId ?? "main";
      setSelectedClaudeAccountProfileId(profileId);
      writeLastCliAccountProfileId("cli:claude", profileId);
    }
  }, [sessionResponse?.session.accountProfileId, sessionResponse?.session.runtimeId]);

  useEffect(() => {
    if (sessionResponse?.accountMode) setAutoAccountMode(sessionResponse.accountMode === "AUTO");
  }, [sessionResponse?.accountMode, sessionResponse?.session.sessionId]);

  useEffect(
    () => () => {
      clearReconnectTimer();
      if (clipboardAttemptTimerRef.current !== null) {
        window.clearTimeout(clipboardAttemptTimerRef.current);
        clipboardAttemptTimerRef.current = null;
      }
    },
    []
  );

  useEffect(() => {
    let current = true;
    if (photoHistoryPaneRef.current !== pane.id) {
      photoHistoryPaneRef.current = pane.id;
      setUploadPreviews([]);
      setSelectedUploadPreviewId(null);
      setUploadPreviewPage(0);
    }
    setPhotoHistoryError(false);
    void loadCliPhotoHistory(pane.roomId, pane.id, () => current).then((photos) => {
      if (!current) return;
      setUploadPreviews((existing) => {
        const byId = new Map(photos.map((photo) => [photo.id, photo]));
        // An upload may finish while history is being restored.
        for (const photo of existing) byId.set(photo.id, photo);
        return [...byId.values()];
      });
    }).catch(() => {
      if (current) setPhotoHistoryError(true);
    });
    return () => { current = false; };
  }, [pane.roomId, pane.id, photoHistoryAttempt]);

  useEffect(() => {
    const currentUrls = new Set(uploadPreviews.map((preview) => preview.objectUrl));
    for (const preview of previousUploadPreviewsRef.current) {
      if (preview.objectUrl.startsWith("blob:") && !currentUrls.has(preview.objectUrl)) URL.revokeObjectURL(preview.objectUrl);
    }
    previousUploadPreviewsRef.current = uploadPreviews;
  }, [uploadPreviews]);

  useEffect(() => () => {
    for (const preview of previousUploadPreviewsRef.current) {
      if (preview.objectUrl.startsWith("blob:")) URL.revokeObjectURL(preview.objectUrl);
    }
  }, []);

  useEffect(() => {
    if (!notice) return;
    const subtle =
      notice === MANAGED_ATTACHMENT_NOTICE || notice === CLIPBOARD_TEXT_FILE_NOTICE;
    const timer = window.setTimeout(() => {
      setNotice((current) => (current === notice ? null : current));
    }, subtle ? HIDDEN_UPLOAD_NOTICE_DISMISS_MS : DEFAULT_NOTICE_DISMISS_MS);
    return () => window.clearTimeout(timer);
  }, [notice]);

  useAutoDismiss(error, setError);

  useEffect(() => {
    if (!connectionAlert) return;
    const dismissMs = connectionAlert.tone === "warn" ? 5_000 : 8_000;
    const timer = window.setTimeout(() => {
      setConnectionAlert((current) => (current === connectionAlert ? null : current));
    }, dismissMs);
    return () => window.clearTimeout(timer);
  }, [connectionAlert]);

  useEffect(() => {
    if (loading || pending || sessionResponse || !selectedRuntime || !isCliRuntimeTerminalLaunchable(selectedRuntime)) return;
    if (observerOnly) return;
    const attemptKey = `${pane.id}:${selectedRuntime.id}`;
    if (autoAttachAttemptRef.current === attemptKey) return;
    autoAttachAttemptRef.current = attemptKey;
    void autoAttachRunningSession();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, pane.id, pending, selectedRuntime?.id, selectedRuntime?.status, sessionResponse]);

  useEffect(() => {
    if (transcriptRef.current) {
      transcriptRef.current.scrollTop = transcriptRef.current.scrollHeight;
    }
  }, [sessionResponse?.transcript.length, sessionResponse?.session.status]);

  useEffect(() => {
    if (!selectedUploadPreviewId) return;
    if (uploadPreviews.some((preview) => preview.id === selectedUploadPreviewId)) return;
    setSelectedUploadPreviewId(null);
  }, [selectedUploadPreviewId, uploadPreviews]);

  const uploadPreviewPageCount = Math.max(1, Math.ceil(uploadPreviews.length / imagePreviewLimit));
  const currentUploadPreviewPage = Math.min(uploadPreviewPage, uploadPreviewPageCount - 1);
  const uploadPreviewEnd = uploadPreviews.length - currentUploadPreviewPage * imagePreviewLimit;
  const uploadPreviewStart = Math.max(0, uploadPreviewEnd - imagePreviewLimit);

  function navigateUploadPreview(direction: number) {
    if (!uploadPreviews.length) return;
    const index = (selectedUploadPreviewIndex + direction + uploadPreviews.length) % uploadPreviews.length;
    setSelectedUploadPreviewId(uploadPreviews[index]!.id);
  }

  const uploadPreviewIsOpen = Boolean(selectedUploadPreview);
  useEffect(() => {
    if (!uploadPreviewIsOpen) return;
    const returnFocus = uploadPreviewReturnFocusRef.current;
    uploadPreviewCloseRef.current?.focus({ preventScroll: true });
    return () => {
      if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
    };
  }, [uploadPreviewIsOpen]);

  useEffect(() => {
    if (!selectedUploadPreview) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        setSelectedUploadPreviewId(null);
        return;
      }
      if ((event.key === "ArrowLeft" || event.key === "ArrowRight") && !event.altKey && !event.ctrlKey && !event.metaKey) {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        navigateUploadPreview(event.key === "ArrowLeft" ? -1 : 1);
        return;
      }
      if (event.key !== "Tab") return;
      const dialog = uploadPreviewDialogRef.current;
      if (!dialog) return;
      const focusable = Array.from(
        dialog.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
        )
      ).filter((element) => !element.hasAttribute("hidden") && element.getAttribute("aria-hidden") !== "true");
      if (!focusable.length) {
        event.preventDefault();
        uploadPreviewCloseRef.current?.focus({ preventScroll: true });
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (
        focusable.length === 1 ||
        (!event.shiftKey && document.activeElement === last) ||
        (event.shiftKey && document.activeElement === first) ||
        !dialog.contains(document.activeElement)
      ) {
        event.preventDefault();
        (event.shiftKey ? last : first)?.focus({ preventScroll: true });
      }
    };
    window.addEventListener("keydown", handleKeyDown, true);
    return () => {
      window.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [selectedUploadPreview, uploadPreviews]);

  useEffect(() => {
    terminalFontSizeRef.current = terminalFontSize;
    const terminal = terminalRef.current;
    if (!terminal) return;
    terminal.options.fontSize = terminalFontSize;
    invalidateTerminalWidthMeasurements(terminal);
    scheduleTerminalRefit({ repair: true, reason: "FONT" });
  }, [terminalFontSize]);

  useEffect(() => {
    const host = xtermHostRef.current;
    if (!host || !sessionResponse?.websocket) return;

    let lastTouchY: number | null = null;
    let touchStartX: number | null = null;
    let touchStartY: number | null = null;
    let verticalGesture = false;
    let pendingTouchPx = 0;
    const handleTouchStart = (event: TouchEvent) => {
      if (event.touches.length !== 1) {
        lastTouchY = null;
        touchStartX = null;
        touchStartY = null;
        return;
      }
      lastTouchY = event.touches[0]?.clientY ?? null;
      touchStartY = lastTouchY;
      touchStartX = event.touches[0]?.clientX ?? null;
      verticalGesture = false;
      pendingTouchPx = 0;
    };
    const handleTouchMove = (event: TouchEvent) => {
      if (lastTouchY === null || touchStartX === null || touchStartY === null || event.touches.length !== 1) return;
      const nextTouchY = event.touches[0]?.clientY;
      const nextTouchX = event.touches[0]?.clientX;
      if (typeof nextTouchY !== "number" || typeof nextTouchX !== "number") return;
      if (!verticalGesture) {
        const totalX = nextTouchX - touchStartX;
        const totalY = nextTouchY - touchStartY;
        if (Math.hypot(totalX, totalY) < 8 || Math.abs(totalX) > Math.abs(totalY)) return;
        verticalGesture = true;
      }
      const deltaY = lastTouchY - nextTouchY;
      lastTouchY = nextTouchY;
      const terminal = terminalRef.current;
      const lineHeightPx = Math.max(10, Math.round(terminalFontSizeRef.current * 1.35));
      if (terminal && (terminal.modes?.mouseTrackingMode ?? "none") !== "none") {
        const accumulated = accumulateTouchScrollLines(pendingTouchPx, deltaY, lineHeightPx);
        pendingTouchPx = accumulated.pendingPx;
        if (accumulated.lines !== 0 && terminal.cols > 0 && terminal.rows > 0) {
          const rect = host.getBoundingClientRect();
          const col = Math.max(1, Math.min(terminal.cols, Math.ceil((nextTouchX - rect.left) / Math.max(1, rect.width / terminal.cols))));
          const row = Math.max(1, Math.min(terminal.rows, Math.ceil((nextTouchY - rect.top) / Math.max(1, rect.height / terminal.rows))));
          sendTerminalInput(encodeSgrMouseWheel(accumulated.lines, col, row).repeat(Math.abs(accumulated.lines)), "touch scroll", "hidden");
        }
      } else {
        const accumulated = accumulateTouchScrollLines(pendingTouchPx, deltaY, lineHeightPx);
        pendingTouchPx = accumulated.pendingPx;
        if (accumulated.lines !== 0) {
          if (accumulated.lines < 0) {
            wasAtBottomRef.current = false;
          }
          scrollXtermByTouchLines(terminal, accumulated.lines);
          syncTerminalViewportEvidence(host, terminal);
        }
      }
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    const clearTouch = () => {
      lastTouchY = null;
      touchStartX = null;
      touchStartY = null;
      verticalGesture = false;
      pendingTouchPx = 0;
    };

    // Full-screen TUIs such as the opencode TUI request mouse reporting
    // (1000/1002/1003/1006) and own the wheel: forward gestures as SGR scroll
    // events so their conversation list scrolls. This must apply regardless of
    // buffer type - ink redraws in the normal buffer too, and the leftover
    // normal-buffer scrollback (a few startup lines) would otherwise swallow
    // the wheel for a useless partial scroll. Apps without mouse tracking
    // (plain shells) keep native viewport scrolling.
    let pendingWheelPx = 0;
    const handleMouseWheel = (event: WheelEvent) => {
      if (event.deltaY === 0 || event.ctrlKey || event.metaKey || event.altKey) return;
      const terminal = terminalRef.current;
      if (!terminal) return;
      if ((terminal.modes?.mouseTrackingMode ?? "none") === "none") {
        if (event.deltaY < 0) {
          wasAtBottomRef.current = false;
        }
        return;
      }
      if (event.shiftKey) return;
      event.preventDefault();
      event.stopPropagation();
      // Reconcile the pane host PTY geometry on interaction: the one-shot resize
      // path is deduped and can leave the PTY at a stale size (e.g. after a
      // failed or dropped resize), so full-screen TUIs keep rendering frames at
      // the old size and the browser wraps them into garbage at the edges.
      const reconcileAt = Date.now();
      if (reconcileAt - wheelGeometryReconcileAtRef.current >= 1500) {
        wheelGeometryReconcileAtRef.current = reconcileAt;
        terminalGeometryCoordinatorRef.current?.reconcileResize(terminal.cols, terminal.rows);
      }
      const hostRect = host.getBoundingClientRect();
      if (hostRect.width <= 0 || hostRect.height <= 0) return;
      const cellWidth = hostRect.width / terminal.cols;
      const cellHeight = hostRect.height / terminal.rows;
      const col = Math.max(1, Math.min(terminal.cols, Math.ceil((event.clientX - hostRect.left) / Math.max(0.001, cellWidth))));
      const row = Math.max(1, Math.min(terminal.rows, Math.ceil((event.clientY - hostRect.top) / Math.max(0.001, cellHeight))));
      // Claude Code moves one row per report and cannot tell this terminal sends one report per notch,
      // so its panes get one report per line of wheel travel (what xterm.js scrolls natively for Codex).
      if (sessionResponseRef.current?.session.runtimeId === CLAUDE_CLI_RUNTIME_ID) {
        const accumulated = accumulateTouchScrollLines(pendingWheelPx, wheelDeltaPx(event.deltaY, event.deltaMode, cellHeight, hostRect.height), cellHeight);
        pendingWheelPx = accumulated.pendingPx;
        if (accumulated.lines !== 0) {
          sendTerminalInput(encodeSgrMouseWheel(accumulated.lines, col, row).repeat(Math.abs(accumulated.lines)), "mouse wheel", "hidden");
        }
        return;
      }
      sendTerminalInput(encodeSgrMouseWheel(event.deltaY, col, row), "mouse wheel", "hidden");
    };

    host.addEventListener("touchstart", handleTouchStart, { capture: true, passive: true });
    host.addEventListener("touchmove", handleTouchMove, { capture: true, passive: false });
    host.addEventListener("touchend", clearTouch, { capture: true });
    host.addEventListener("touchcancel", clearTouch, { capture: true });
    host.addEventListener("wheel", handleMouseWheel, { capture: true, passive: false });
    return () => {
      host.removeEventListener("touchstart", handleTouchStart, { capture: true });
      host.removeEventListener("touchmove", handleTouchMove, { capture: true });
      host.removeEventListener("touchend", clearTouch, { capture: true });
      host.removeEventListener("touchcancel", clearTouch, { capture: true });
      host.removeEventListener("wheel", handleMouseWheel, { capture: true });
    };
  }, [pane.id, sessionResponse?.websocket]);

  useEffect(() => {
    const currentSessionResponse = sessionResponse;
    const ticket = currentSessionResponse?.websocket;
    const host = xtermHostRef.current;
    if (!ticket || !host || !currentSessionResponse) {
      setTerminalStatus("idle");
      resetTerminalControl();
      return;
    }
    const terminalTicket = ticket;
    const terminalHost = host;
    const terminalSessionResponse = currentSessionResponse;
    terminalAppSelectionRef.current = "";
    const osc52ClipboardScanner = createOsc52ClipboardScanner();

    let disposed = false;
    let terminal: XtermTerminal | null = null;
    let fitAddon: XtermFitAddon | null = null;
    let socket: WebSocket | null = null;
    let socketGeneration = 0;
    let protocolRejected = false;
    let finalSocketState = false;
    let reconnectStopReported = false;
    let terminalReplayComplete = false;
    let initialReplayStatusReceived = false;
    let initialReplayWritePending = false;
    let pendingInitialPrefillQueueEvents = 0;
    let initialReplayBuffered = false;
    let revealGeometryResolve: (() => void) | null = null;
    let initialReplayErrorPending = false;
    let replayFailureReported = false;
    let pendingReplayOutputRefresh: { token: number; revision: number } | null = null;
    let pendingInitialReplayFinalize: (() => void) | null = null;
    let dataDisposable: IDisposable | null = null;
    let scrollDisposable: IDisposable | null = null;
    let writeParsedDisposable: IDisposable | null = null;
    let paintRecoveryDisposable: IDisposable | null = null;
    let resizeDisposable: IDisposable | null = null;
    const inputTokenizer = createTerminalInputTokenizer();
    let inputTokenizerFlushTimer: number | null = null;
    let outputReadyForGeometry = false;
    let terminalSurfaceOpened = false;
    let initialTerminalFocusResolved = false;
    let initialTerminalGeometryReady = false;
    let initialTailPending = true;
    let openTerminalSurface = () => undefined;
    const terminalSurfaceEligible = () =>
      !disposed &&
      isVisibleRef.current &&
      !paneMinimizedRef.current &&
      terminalHost.ownerDocument.visibilityState !== "hidden" &&
      terminalHost.isConnected;
    const terminalPrefillEligible = () =>
      !disposed &&
      prefillInitialReplayRef.current &&
      !paneMinimizedRef.current &&
      terminalHost.ownerDocument.visibilityState !== "hidden" &&
      terminalHost.isConnected &&
      !terminalSurfaceOpened;
    const initialReplayRequiresReveal = true;
    const terminalOutputWritable = () =>
      Boolean(terminal) && initialReplayBuffered && terminalSurfaceEligible();
    const resizeTrace = createTerminalResizeTrace({
      host: terminalHost, roomId: pane.roomId, paneId: pane.id,
      instanceId: terminalInstanceIdRef.current,
      getTerminal: () => terminal, isVisible: () => isVisibleRef.current,
      isMinimized: () => paneMinimizedRef.current
    });
    const writeXtermOutput = (
      data: string,
      done: (error?: unknown) => void,
      mode: TerminalOutputWriteMode
    ) => {
      let offset = 0;
      const writeNext = () => {
        if (disposed || !terminal) {
          done();
          return;
        }
        const replayTerminal = terminal;
        const end = terminalReplayChunkEnd(data, offset);
        const chunk = data.slice(offset, end);
        resizeTrace.wrote(chunk.length);
        try {
          recordTerminalStressXtermWrite(
            pane.roomId,
            pane.id,
            chunk,
            mode === "PREFILL",
            mode
          );
          notifyTerminalPreviewChangedThrottled(pane.id);
          const activeBuffer = replayTerminal.buffer.active;
          const wasAtBottom = activeBuffer
            ? activeBuffer.baseY <= 0 || (wasAtBottomRef.current && activeBuffer.viewportY >= activeBuffer.baseY)
            : wasAtBottomRef.current;
          isWritingChunkRef.current = true;
          replayTerminal.write(chunk, () => {
            isWritingChunkRef.current = false;
            offset = end;
            if (wasAtBottom && wasAtBottomRef.current) {
              replayTerminal.scrollToBottom();
              wasAtBottomRef.current = true;
              syncTerminalViewportEvidence(terminalHost, replayTerminal);
            }
            if (offset >= data.length) {
              done();
              return;
            }
            void yieldForTerminalReplay().then(writeNext, done);
          });
        } catch (error) {
          isWritingChunkRef.current = false;
          done(error);
        }
      };
      writeNext();
    };
    const reportOutputPressure = (pressure: TerminalOutputPressure) => {
      window.dispatchEvent(new CustomEvent("space:terminal-output-pressure", { detail: pressure }));
    };
    terminalHost.dataset.terminalPendingPrefillEvents = "0";
    terminalHost.dataset.terminalPendingPrefillBytes = "0";
    const outputCoordinator = createTerminalOutputCoordinator({
      roomId: pane.roomId,
      paneId: pane.id,
      isWritable: terminalOutputWritable,
      isPrefillWritable: terminalPrefillEligible,
      write: writeXtermOutput,
      onPrefillDrained: () => {
        if (
          !disposed &&
          initialReplayStatusReceived &&
          pendingInitialPrefillQueueEvents === 1
        ) {
          setTerminalPrefillReady(true);
        }
      },
      onPendingPrefillChange: (snapshot) => {
        terminalHost.dataset.terminalPendingPrefillEvents =
          String(snapshot.pendingPrefillEvents);
        terminalHost.dataset.terminalPendingPrefillBytes =
          String(snapshot.pendingPrefillBytes);
      },
      onPressure: reportOutputPressure,
      onDataEnqueued: (data) => {
        appendTerminalPreviewChunk(pane.id, data);
      }
    });
    terminalOutputCoordinatorRef.current = outputCoordinator;
    const geometryCoordinator = createTerminalGeometryCoordinator({
      onTrace: resizeTrace.trace,
      ownerDocument: terminalHost.ownerDocument,
      host: terminalHost,
      getTerminal: () => terminal,
      getFitAddon: () => fitAddon,
      isVisible: () => isVisibleRef.current && outputReadyForGeometry,
      isMinimized: () => paneMinimizedRef.current,
      measureCharacterSize: () => {
        measureTerminalCharacterSize(terminal);
        const cell = terminalCharacterCellSize(terminal as unknown as XtermTerminal);
        emitAppDiagnosticsPerformance({
          category: "PERFORMANCE",
          metric: "TERMINAL_GEOMETRY",
          phase: "CHAR_MEASURE",
          roomId: pane.roomId,
          paneId: pane.id,
          width: cell.width,
          height: cell.height
        });
      },
      invalidateWidthMeasurements: (terminal) => {
        invalidateTerminalWidthMeasurements(terminal);
        const cell = terminalCharacterCellSize(terminal as unknown as XtermTerminal);
        emitAppDiagnosticsPerformance({
          category: "PERFORMANCE",
          metric: "TERMINAL_GEOMETRY",
          phase: "CHAR_INVALIDATE",
          roomId: pane.roomId,
          paneId: pane.id,
          width: cell.width,
          height: cell.height
        });
      },
      getResizeIdentity: () => {
        const currentSocket = socket;
        const sessionId = terminalSessionResponse.session.sessionId;
        const control = terminalControlRef.current;
        if (
          !currentSocket ||
          socketGeneration <= 0 ||
          currentSocket.readyState !== WebSocket.OPEN ||
          socketRef.current !== currentSocket ||
          readySocketRef.current?.socket !== currentSocket ||
          readySocketRef.current.sessionId !== sessionId ||
          (control.protocolVersion === 2 && (control.state !== "CONTROLLER" || !control.leaseId))
        ) {
          return null;
        }
        return {
          socketGeneration,
          sessionId,
          leaseId: control.protocolVersion === 2 ? control.leaseId : null
        };
      },
      sendResize: ({ cols, rows, leaseId, force }) => {
        const currentSocket = socket;
        if (!currentSocket || currentSocket.readyState !== WebSocket.OPEN || socketRef.current !== currentSocket) return;
        currentSocket.send(JSON.stringify({
          type: "resize",
          cols,
          rows,
          ...(force ? { force: true } : {}),
          ...(leaseId ? { leaseId } : {})
        }));
        lastSentResizeRef.current = { socket: currentSocket, cols, rows };
        // A later denial may be for this resize, so never replay an earlier, accepted input.
        lastTerminalControlMutationRef.current = null;
      },
      isScrolledToBottom: () => {
        if (!wasAtBottomRef.current) return false;
        const activeBuffer = terminal?.buffer.active;
        if (!activeBuffer) return wasAtBottomRef.current;
        if (activeBuffer.baseY <= 0) return true;
        return activeBuffer.viewportY >= activeBuffer.baseY - 1;
      },
      scrollToBottom: () => {
        // xterm 6 owns scrolling through its ScrollableElement. The legacy
        // .xterm-viewport is empty; reading its scrollHeight forces a full
        // layout for each pane without moving the terminal's buffer.
        terminal?.scrollToBottom();
        wasAtBottomRef.current = true;
        syncTerminalViewportEvidence(terminalHost, terminal);
      },
      onRepaint: (info) => {
        emitAppDiagnosticsPerformance({
          category: "PERFORMANCE",
          metric: "TERMINAL_PAINT",
          phase: TERMINAL_PAINT_PHASES[info.phase],
          roomId: pane.roomId,
          paneId: pane.id,
          instanceId: terminalInstanceIdRef.current,
          cols: info.cols,
          rows: info.rows,
          width: info.width,
          height: info.height,
          repaired: info.suspect,
          canvasWidth: info.canvasWidth,
          canvasHeight: info.canvasHeight,
          canvasBlank: info.canvasBlank,
          darkPixelRatio: info.darkPixelRatio,
          cellWidth: terminalCharacterCellSize(terminalRef.current).width,
          cellHeight: terminalCharacterCellSize(terminalRef.current).height,
          rowCount: info.rowCount,
          populatedRowCount: info.populatedRowCount,
          blankRowRatio: info.blankRowRatio
        });
      },
      onReady: ({ width, height, cols, rows, repaired }) => {
        initialTerminalGeometryReady = true;
        if (terminal) reconnectFrameRef.current?.releaseAfterPaint(terminal, {
          replay: initialReplayBuffered && !initialReplayWritePending,
          geometry: initialTerminalGeometryReady
        });
        if (revealGeometryResolve) {
          const resolve = revealGeometryResolve;
          revealGeometryResolve = null;
          resolve();
        }
        if (fullscreenLayoutRef.current && isVisibleRef.current) {
          recordFullscreenGeometry(cols, rows);
          emitAppDiagnosticsPerformance({
            category: "PERFORMANCE",
            metric: "TERMINAL_FULLSCREEN",
            phase: "REFERENCE_RECORDED",
            roomId: pane.roomId,
            paneId: pane.id,
            cols,
            rows
          });
        }
        emitAppDiagnosticsPerformance({
          category: "PERFORMANCE",
          metric: "TERMINAL_GEOMETRY",
          roomId: pane.roomId,
          paneId: pane.id,
          phase: "READY",
          width,
          height,
          cols,
          rows,
          repaired
        });
        if (initialTailPending && initialReplayBuffered) {
          initialTailPending = false;
          terminal?.scrollToBottom();
        }
        syncTerminalViewportEvidence(terminalHost, terminal);
        if (!initialTerminalFocusResolved) {
          initialTerminalFocusResolved = true;
          const activeElement = terminalHost.ownerDocument.activeElement;
          const focusIsUnclaimed =
            !activeElement ||
            activeElement === terminalHost.ownerDocument.body ||
            activeElement === terminalHost.ownerDocument.documentElement ||
            terminalHost.contains(activeElement);
          if (terminalSurfaceEligible() && focusIsUnclaimed) focusTerminal();
        }
        onRevealReady?.(pane.id, revealGenerationRef.current);
      }
    });
    terminalGeometryCoordinatorRef.current = geometryCoordinator;
    const syncOutputVisibility = async () => {
      const eligible =
        !disposed &&
        initialReplayBuffered &&
        isVisibleRef.current &&
        !paneMinimizedRef.current &&
        terminalHost.ownerDocument.visibilityState !== "hidden" &&
        terminalHost.isConnected;
      if (!eligible) {
        outputReadyForGeometry = false;
        geometryCoordinator.syncVisibility();
        if (initialReplayBuffered) {
          await outputCoordinator.maintainPressure().catch(handleTerminalReplayFailure);
        }
        return;
      }
      openTerminalSurface();
      if (!terminalSurfaceOpened) return;
      await outputCoordinator.reveal().then(async () => {
        if (
          disposed ||
          !isVisibleRef.current ||
          paneMinimizedRef.current ||
          terminalHost.ownerDocument.visibilityState === "hidden"
        ) return;
        outputReadyForGeometry = true;
        settleTerminalPrefill();
        if (fullscreenLayoutRef.current) {
          const reference = readFullscreenGeometry();
          if (reference) {
            geometryCoordinator.backgroundResize(reference.cols, reference.rows);
            emitAppDiagnosticsPerformance({
              category: "PERFORMANCE",
              metric: "TERMINAL_FULLSCREEN",
              phase: "REVEAL_PRE_ALIGN",
              roomId: pane.roomId,
              paneId: pane.id,
              value: 1,
              cols: reference.cols,
              rows: reference.rows
            });
          } else {
            emitAppDiagnosticsPerformance({
              category: "PERFORMANCE",
              metric: "TERMINAL_FULLSCREEN",
              phase: "REVEAL_PRE_ALIGN",
              roomId: pane.roomId,
              paneId: pane.id,
              value: 0
            });
          }
        }
        // Initial page refreshes can reveal a live pane with a stale xterm
        // canvas even though no host resize event was emitted. Repair that first
        // reveal; a resident terminal keeps its geometry and only needs fitting
        // when its host changed or the coordinator detects a real geometry fault.
        geometryCoordinator.syncVisibility({ repair: !initialTerminalGeometryReady });
        // Wait for the geometry to actually land (onReady) before the first
        // visible paint — after a refresh the shell layout is still settling,
        // so a fixed frame count lets the default 100x30 grid flash. Bounded
        // by a 500ms timeout and a two-frame fallback.
        await new Promise<void>((resolve) => {
          let settled = false;
          const fallbackTimer = window.setTimeout(() => {
            if (settled) return;
            settled = true;
            revealGeometryResolve = null;
            resolve();
          }, 1200);
          const done = () => {
            if (settled) return;
            settled = true;
            window.clearTimeout(fallbackTimer);
            revealGeometryResolve = null;
            resolve();
          };
          revealGeometryResolve = done;
        });
        if (disposed) return;
        geometryCoordinator.forceRepaint();
      }).catch(handleTerminalReplayFailure);
    };
    syncTerminalOutputVisibilityRef.current = syncOutputVisibility;
    const nativePasteTargets: EventTarget[] = [];
    const nativeCopyTargets: EventTarget[] = [];
    const nativeContextMenuTargets: EventTarget[] = [];
    const terminalIntentTargets: Array<{ target: EventTarget; type: string; listener: EventListener }> = [];
    const replayWriteQueue = createTerminalReplayWriteQueue(
      (data, mode) => outputCoordinator.enqueue(data, undefined, mode),
      yieldForTerminalReplay,
      () => initialReplayBuffered,
      true
    );
    const handleTerminalReplayFailure = (error: unknown) => {
      if (replayFailureReported) return;
      replayFailureReported = true;
      initialReplayWritePending = false;
      pendingInitialReplayFinalize = null;
      pendingReplayOutputRefresh = null;
      if (disposed) return;
      setTerminalReplayReady(false);
      setTerminalStatus("closed");
      reconnectFrameRef.current?.dispose();
      setError(error instanceof Error ? error.message : "CLI terminal replay failed");
      setTerminalPrefillReady(true);
    };
    const queueTerminalReplay = (
      data: string,
      mode: TerminalOutputWriteMode = "PREFILL"
    ) => {
      const countsTowardInitialPrefill = mode === "PREFILL";
      if (countsTowardInitialPrefill) pendingInitialPrefillQueueEvents += 1;
      void replayWriteQueue.enqueue(data, mode).then(
        () => {
          if (countsTowardInitialPrefill) {
            pendingInitialPrefillQueueEvents -= 1;
            if (!disposed && !replayFailureReported && pendingInitialPrefillQueueEvents === 0 && initialReplayStatusReceived) settleTerminalPrefill();
          }
        },
        (error) => {
          if (countsTowardInitialPrefill) pendingInitialPrefillQueueEvents -= 1;
          handleTerminalReplayFailure(error);
        }
      );
    };
    const flushInitialReplay = (finalize: () => void) => {
      initialReplayWritePending = true;
      pendingInitialReplayFinalize = finalize;
      void replayWriteQueue.drain().then(async () => {
        if (disposed) return;
        initialReplayBuffered = true;
        if (initialReplayRequiresReveal) await syncOutputVisibility();
        if (disposed || replayFailureReported) return;
        initialReplayWritePending = false;
        const pendingRefresh = pendingReplayOutputRefresh;
        pendingReplayOutputRefresh = null;
        const pendingFinalize = pendingInitialReplayFinalize;
        pendingInitialReplayFinalize = null;
        if (terminalReplayComplete && pendingRefresh) {
          scheduleModelSettingsRefreshAfterParsedOutput(pendingRefresh.token, pendingRefresh.revision);
        }
        pendingFinalize?.();
        if (terminal) {
          reconnectFrameRef.current?.releaseAfterPaint(terminal, {
            replay: initialReplayBuffered && !initialReplayWritePending,
            geometry: initialTerminalGeometryReady
          });
        }
        initialReplayErrorPending = false;
      }).catch(handleTerminalReplayFailure);
    };
    setTerminalReplayReady(false);
    const nativePasteListener: EventListener = (event) => {
      if (terminalHost.closest("[inert]")) return;
      if (!isNativeClipboardEvent(event)) return;
      const activeElement = typeof document !== "undefined" ? document.activeElement : null;
      const targetInsideTerminal = event.target instanceof Node && terminalHost.contains(event.target);
      const activeInsideTerminal = activeElement instanceof Node && terminalHost.contains(activeElement);
      let routedToTerminal = targetInsideTerminal || activeInsideTerminal;
      if (!routedToTerminal) {
        const paneRoot = terminalHost.closest(".terminal-pane");
        const paneVisible = Boolean(
          paneRoot &&
            paneRoot.isConnected &&
            (!(paneRoot instanceof HTMLElement) ||
              (window.getComputedStyle(paneRoot).display !== "none" && window.getComputedStyle(paneRoot).visibility !== "hidden"))
        );
        const targetInsidePane = Boolean(paneRoot && event.target instanceof Node && paneRoot.contains(event.target));
        const activeInsidePane = Boolean(paneRoot && activeElement instanceof Node && paneRoot.contains(activeElement));
        routedToTerminal =
          paneVisible &&
          hasRecentTerminalIntent() &&
          !isEditablePasteTarget(event.target) &&
          !isEditablePasteTarget(activeElement) &&
          (targetInsidePane ||
            activeInsidePane ||
            activeElement === fileInputRef.current ||
            activeElement === document.body ||
            activeElement === document.documentElement ||
            event.target === document ||
            event.target === window);
        if (!routedToTerminal) {
          if (showCliDebugMode || hasRecentTerminalIntent()) {
            updateClipboardDebug("info", "native paste ignored", `${describeTerminalRouting(event.target, activeElement, terminalHost)}; recentTerminalIntent=${hasRecentTerminalIntent()}.`);
          }
          return;
        }
        updateClipboardDebug("info", "native paste rerouted", `${describeTerminalRouting(event.target, activeElement, terminalHost)}; recentTerminalIntent=true.`);
      }
      markTerminalIntent();
      handleTerminalNativePaste(event);
    };
    const nativePasteShortcutListener: EventListener = (event) => {
      if (terminalHost.closest("[inert]")) return;
      if (!(event instanceof KeyboardEvent)) return;
      const isPasteShortcut = isPasteShortcutEvent(event);
      const activeElement = typeof document !== "undefined" ? document.activeElement : null;
      const targetInsideTerminal = event.target instanceof Node && terminalHost.contains(event.target);
      const activeInsideTerminal = activeElement instanceof Node && terminalHost.contains(activeElement);
      let routedToTerminal = targetInsideTerminal || activeInsideTerminal;
      if (!routedToTerminal) {
        const paneRoot = terminalHost.closest(".terminal-pane");
        const paneVisible = Boolean(
          paneRoot &&
            paneRoot.isConnected &&
            (!(paneRoot instanceof HTMLElement) ||
              (window.getComputedStyle(paneRoot).display !== "none" && window.getComputedStyle(paneRoot).visibility !== "hidden"))
        );
        const targetInsidePane = Boolean(paneRoot && event.target instanceof Node && paneRoot.contains(event.target));
        const activeInsidePane = Boolean(paneRoot && activeElement instanceof Node && paneRoot.contains(activeElement));
        routedToTerminal =
          paneVisible &&
          hasRecentTerminalIntent() &&
          !isEditablePasteTarget(event.target) &&
          !isEditablePasteTarget(activeElement) &&
          (targetInsidePane ||
            activeInsidePane ||
            activeElement === fileInputRef.current ||
            activeElement === document.body ||
            activeElement === document.documentElement ||
            event.target === document ||
            event.target === window);
        if (!routedToTerminal) {
          if ((showCliDebugMode || hasRecentTerminalIntent()) && isPasteShortcut) {
            updateClipboardDebug("info", "Ctrl+V ignored", `${describeTerminalRouting(event.target, activeElement, terminalHost)}; recentTerminalIntent=${hasRecentTerminalIntent()}.`);
          }
          return;
        }
        if (isPasteShortcut) {
          setNotice("Ctrl+V rerouted.");
          updateClipboardDebug("info", "Ctrl+V rerouted", `${describeTerminalRouting(event.target, activeElement, terminalHost)}; recentTerminalIntent=true.`);
        }
      }
      markTerminalIntent();
      handleTerminalPasteShortcut(event);
    };
    const nativeBeforeInputListener: EventListener = (event) => {
      if (terminalHost.closest("[inert]")) return;
      if (!isPasteBeforeInputEvent(event)) return;
      const activeElement = typeof document !== "undefined" ? document.activeElement : null;
      const targetInsideTerminal = event.target instanceof Node && terminalHost.contains(event.target);
      const activeInsideTerminal = activeElement instanceof Node && terminalHost.contains(activeElement);
      let routedToTerminal = targetInsideTerminal || activeInsideTerminal;
      if (!routedToTerminal) {
        const paneRoot = terminalHost.closest(".terminal-pane");
        const paneVisible = Boolean(
          paneRoot &&
            paneRoot.isConnected &&
            (!(paneRoot instanceof HTMLElement) ||
              (window.getComputedStyle(paneRoot).display !== "none" && window.getComputedStyle(paneRoot).visibility !== "hidden"))
        );
        const targetInsidePane = Boolean(paneRoot && event.target instanceof Node && paneRoot.contains(event.target));
        const activeInsidePane = Boolean(paneRoot && activeElement instanceof Node && paneRoot.contains(activeElement));
        routedToTerminal =
          paneVisible &&
          hasRecentTerminalIntent() &&
          !isEditablePasteTarget(event.target) &&
          !isEditablePasteTarget(activeElement) &&
          (targetInsidePane ||
            activeInsidePane ||
            activeElement === fileInputRef.current ||
            activeElement === document.body ||
            activeElement === document.documentElement ||
            event.target === document ||
            event.target === window);
        if (!routedToTerminal) {
          if (showCliDebugMode || hasRecentTerminalIntent()) {
            updateClipboardDebug("info", "beforeinput paste ignored", `${describeTerminalRouting(event.target, activeElement, terminalHost)}; recentTerminalIntent=${hasRecentTerminalIntent()}.`);
          }
          return;
        }
        updateClipboardDebug("info", "beforeinput paste rerouted", `${describeTerminalRouting(event.target, activeElement, terminalHost)}; recentTerminalIntent=true.`);
      }
      markTerminalIntent();
      handleTerminalBeforeInput(event);
    };

    const nativeCopyShortcutListener: EventListener = (event) => {
      if (terminalHost.closest("[inert]")) return;
      if (!(event instanceof KeyboardEvent) || !isCopyShortcutEvent(event)) return;
      const activeElement = typeof document !== "undefined" ? document.activeElement : null;
      const targetInTerminal = event.target instanceof Node && terminalHost.contains(event.target);
      const activeInTerminal = activeElement instanceof Node && terminalHost.contains(activeElement);
      if (!targetInTerminal && !activeInTerminal && !hasRecentTerminalIntent()) return;
      if (isEditablePasteTarget(event.target) || isEditablePasteTarget(activeElement)) return;
      const terminal = terminalRef.current;
      const selection = terminal?.getSelection?.() ?? "";
      if (!selection) return;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      markTerminalIntent();
      void handleTerminalCopyShortcut(selection);
    };

    const nativeContextMenuListener: EventListener = (event) => {
      if (terminalHost.closest("[inert]")) return;
      if (!(event instanceof MouseEvent)) return;
      if (voiceInputRef.current.settings.terminalContextMenu === false) return;
      event.preventDefault();
      event.stopPropagation();
      markTerminalIntent();
      setContextMenu({
        x: event.clientX,
        y: event.clientY,
        ...terminalContextMenuSelection()
      });
    };

    const nativeContextMenuMouseDownListener: EventListener = (event) => {
      if (!(event instanceof MouseEvent) || event.button !== 2) return;
      if (voiceInputRef.current.settings.terminalContextMenu === false) return;
      if ((terminal?.modes?.mouseTrackingMode ?? "none") === "none") return;
      // Right-click opens the Space menu. Reported to the CLI, it would drop the selection being copied.
      event.stopPropagation();
    };

    const nativeReasonixShortcutListener: EventListener = (event) => {
      if (terminalHost.closest("[inert]")) return;
      if (!(event instanceof KeyboardEvent)) return;
      const session = sessionResponseRef.current?.session;
      if (session?.purpose !== "NORMAL" || session.runtimeId !== "cli:deepseek" || !isTargetRef.current) return;
      const shortcut = reasonixShortcutSequence(event);
      if (!shortcut) return;
      const activeElement = typeof document !== "undefined" ? document.activeElement : null;
      const paneRoot = terminalHost.closest(".terminal-pane");
      const targetInsideTerminal = event.target instanceof Node && terminalHost.contains(event.target);
      const activeInsideTerminal = activeElement instanceof Node && terminalHost.contains(activeElement);
      const targetInsidePane = Boolean(paneRoot && event.target instanceof Node && paneRoot.contains(event.target));
      const activeInsidePane = Boolean(paneRoot && activeElement instanceof Node && paneRoot.contains(activeElement));
      const bodyHasRecentTerminalIntent =
        hasRecentTerminalIntent() &&
        (activeElement === document.body || activeElement === document.documentElement);
      if (
        !targetInsideTerminal &&
        !activeInsideTerminal &&
        !targetInsidePane &&
        !activeInsidePane &&
        !bodyHasRecentTerminalIntent
      ) return;
      if (
        !targetInsideTerminal &&
        !activeInsideTerminal &&
        (isEditablePasteTarget(event.target) || isEditablePasteTarget(activeElement))
      ) return;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      markTerminalIntent();
      if (sendTerminalInput(shortcut, "Reasonix keyboard shortcut", "visible", true, { trackDraft: false })) {
        focusTerminal();
      }
    };

    async function attachTerminal() {
      setTerminalStatus("connecting");
      const { Terminal, FitAddon } = await loadTerminalModules();
      if (disposed) return;
      let bufferedSocket = bufferedSocketRef.current;
      if (bufferedSocket && !terminalWebSocketTicketsMatch(bufferedSocket.ticket, terminalTicket)) {
        closeBufferedTerminalSocket(bufferedSocket);
        bufferedSocket = null;
      }
      const wasPreconnected = Boolean(bufferedSocket);
      const socketClientMode = bufferedSocket?.clientMode ??
        (canRequestTerminalControl(false, terminalTicket.proofScope === "READ_ONLY")
          ? "INTERACTIVE"
          : "OBSERVER");
      if (wasPreconnected) {
        // Every sibling socket is constructed before the room barrier releases. Each pane then
        // waits only for its own handshake and starts xterm in a separate browser task, allowing
        // slow handshakes and network events to progress between synchronous xterm setups.
        await bufferedSocket!.preopen;
        await bootstrapBarrier?.waitForTerminalSetupTask(pane.id);
      } else {
        // Fresh sessions measure their xterm before creating the socket, while the task yield keeps
        // sibling heavy CLI process starts staggered.
        await Promise.resolve();
      }
      if (disposed) {
        bufferedSocket?.stopBuffering();
        return;
      }
      terminalHost.replaceChildren();
      const sessionGeometry = terminalSessionResponse.session.terminalGeometry;
      const initialTerminalCols =
        sessionGeometry &&
        Number.isInteger(sessionGeometry.cols) &&
        sessionGeometry.cols >= 2 &&
        sessionGeometry.cols <= 400
          ? sessionGeometry.cols
          : INITIAL_CLI_TERMINAL_COLS;
      const initialTerminalRows =
        sessionGeometry &&
        Number.isInteger(sessionGeometry.rows) &&
        sessionGeometry.rows >= 2 &&
        sessionGeometry.rows <= 200
          ? sessionGeometry.rows
          : INITIAL_CLI_TERMINAL_ROWS;
      terminal = new Terminal({
        // Match the pane host PTY while replaying cursor-relative TUI output.
        // Otherwise xterm reflows a transcript through default bounds before the browser can send the first measured resize.
        cols: initialTerminalCols,
        rows: initialTerminalRows,
        // xterm documents convertEol as a non-PTY compatibility option. PTY
        // termios already handles line endings, so enabling it corrupts TUI cursors.
        // https://github.com/xtermjs/xterm.js/blob/6.0.0/typings/xterm.d.ts#L48-L58
        convertEol: false,
        cursorBlink: true,
        fontFamily: '"SFMono-Regular", Consolas, "Liberation Mono", monospace',
        fontSize: terminalFontSizeRef.current,
        lineHeight: 1.35,
        // PTY output may contain recoverable malformed ANSI; keep xterm parser diagnostics out of the app console.
        logLevel: "off",
        scrollback: 2000,
        theme: {
          background: "#090b0c",
          foreground: "#e8e3d8",
          cursor: "#5cc8aa",
          selectionBackground: "#254941",
          scrollbarSliderBackground: "rgba(232, 227, 216, 0.18)",
          scrollbarSliderHoverBackground: "rgba(232, 227, 216, 0.32)",
          scrollbarSliderActiveBackground: "rgba(232, 227, 216, 0.45)"
        }
      });
      fitAddon = new FitAddon();
      fitAddonRef.current = fitAddon;
      terminal.loadAddon(fitAddon);
      terminalRef.current = terminal;
      resizeTrace.sync();
      lastTerminalOutputRefitAtRef.current = 0;
      const replayTerminal = terminal;
      writeParsedDisposable = replayTerminal.onWriteParsed(() => {
        terminalHost.dataset.terminalOutputParsed = "true";
        syncTerminalViewportEvidence(terminalHost, replayTerminal);
        notifyTerminalPreviewChangedThrottled(pane.id);
        if (terminalSurfaceOpened && isVisibleRef.current) scheduleTerminalRepaint(replayTerminal);
      });
      scrollDisposable = replayTerminal.onScroll(() => {
        const activeBuffer = replayTerminal.buffer.active;
        if (activeBuffer) {
          if (activeBuffer.baseY <= 0 || activeBuffer.viewportY >= activeBuffer.baseY) {
            wasAtBottomRef.current = true;
          } else {
            wasAtBottomRef.current = false;
          }
        }
        syncTerminalViewportEvidence(terminalHost, replayTerminal);
      });
      const addNativePasteTarget = (target: EventTarget | null | undefined) => {
        if (!target || nativePasteTargets.includes(target)) return;
        target.addEventListener("paste", nativePasteListener, { capture: true });
        target.addEventListener("keydown", nativePasteShortcutListener, { capture: true });
        target.addEventListener("beforeinput", nativeBeforeInputListener, { capture: true });
        nativePasteTargets.push(target);
      };
      const addNativeCopyTarget = (target: EventTarget | null | undefined) => {
        if (!target || nativeCopyTargets.includes(target)) return;
        target.addEventListener("keydown", nativeCopyShortcutListener, { capture: true });
        nativeCopyTargets.push(target);
      };
      const addNativeContextMenuTarget = (target: EventTarget | null | undefined) => {
        if (!target || nativeContextMenuTargets.includes(target)) return;
        target.addEventListener("contextmenu", nativeContextMenuListener, { capture: true });
        target.addEventListener("mousedown", nativeContextMenuMouseDownListener, { capture: true });
        nativeContextMenuTargets.push(target);
      };
      const addTerminalIntentTarget = (target: EventTarget | null | undefined, type: string) => {
        if (!target) return;
        const listener: EventListener = (event) => {
          if (type === "pointerdown") {
            markTerminalIntent();
            // A new left click clears or replaces the CLI's own selection.
            if (event instanceof MouseEvent && event.button === 0 && !event.ctrlKey) terminalAppSelectionRef.current = "";
          }
          if (type === "focus" || type === "focusin") {
            terminal?.scrollToBottom();
            syncTerminalViewportEvidence(terminalHost, terminal);
          }
        };
        target.addEventListener(type, listener, { capture: true });
        terminalIntentTargets.push({ target, type, listener });
      };
      openTerminalSurface = () => {
        if (disposed || terminalSurfaceOpened || !terminal) return;
        const activeTerminal = terminal;
        activeTerminal.open(terminalHost);
        terminalSurfaceOpened = true;
        paintRecoveryDisposable = watchTerminalPaint(activeTerminal, terminalHost, terminalSurfaceEligible, {
          roomId: pane.roomId,
          paneId: pane.id
        });
        emitAppDiagnosticsPerformance({
          category: "PERFORMANCE",
          metric: "TERMINAL_GEOMETRY",
          phase: "SURFACE_OPENED",
          roomId: pane.roomId,
          paneId: pane.id,
          width: Math.round((terminalHost.clientWidth || terminalHost.getBoundingClientRect().width || 0) * 10) / 10,
          height: Math.round((terminalHost.clientHeight || terminalHost.getBoundingClientRect().height || 0) * 10) / 10,
          cols: activeTerminal.cols,
          rows: activeTerminal.rows
        });
        syncTerminalViewportEvidence(terminalHost, activeTerminal);
        memoizeTerminalWidthMeasurements(activeTerminal, terminalHost.ownerDocument);
        const terminalDom = activeTerminal as XtermTerminal & {
          element?: HTMLElement;
          textarea?: HTMLTextAreaElement;
        };
        nameTerminalInput(terminalDom.textarea);
        if (terminalDom.textarea) {
          terminalTextareaRef.current = terminalDom.textarea;
          terminalDom.textarea.readOnly = oskOpenRef.current && mobileRef.current;
        }
        addNativePasteTarget(terminalHost);
        addNativeCopyTarget(terminalHost);
        addNativePasteTarget(terminalDom.element);
        addNativeCopyTarget(terminalDom.element);
        addNativePasteTarget(terminalDom.textarea);
        addNativeCopyTarget(terminalDom.textarea);
        addNativePasteTarget(document);
        addNativeContextMenuTarget(terminalHost);
        addNativeContextMenuTarget(terminalDom.element);
        window.addEventListener("keydown", nativeReasonixShortcutListener, { capture: true });
        addTerminalIntentTarget(terminalHost, "pointerdown");
        addTerminalIntentTarget(terminalHost, "focusin");
        addTerminalIntentTarget(terminalDom.textarea, "focus");
        activeTerminal.attachCustomKeyEventHandler((event: KeyboardEvent) => {
          return customKeyEventHandlerRef.current?.(event) ?? true;
        });
        const dispatchInputSegments = (segments: TerminalInputSegment[]) => {
          for (const segment of segments) {
            if (segment.display === "hidden") {
              const control = terminalControlRef.current;
              if (
                control.protocolVersion === 1 ||
                (control.state === "CONTROLLER" && control.leaseId)
              ) {
                sendTerminalInput(
                  segment.data,
                  "terminal protocol response",
                  "hidden",
                  true,
                  { trackDraft: false }
                );
              }
              continue;
            }
            markTerminalIntent();
            if (isGuardedPasteTerminalInput(segment.data)) {
              const source = pasteInputGuardRef.current?.source ?? "terminal paste";
              updateClipboardDebug("info", "raw terminal paste blocked", `${source}: blocked raw Ctrl+V from xterm before Codex CLI.`);
              continue;
            }
            const turnMarker =
              isRunCapableCliSession(terminalSessionResponse.session) &&
              isTerminalSubmitInput(segment.data)
                ? createCliTurnMarker()
                : undefined;
            if (isTerminalSubmitInput(segment.data)) {
              sendTerminalSubmit(segment.data, "terminal keyboard input", { turnMarker });
            } else {
              sendTerminalInput(segment.data, "terminal keyboard input", "visible", true, { turnMarker });
            }
          }
        };
        dataDisposable = activeTerminal.onData((data) => {
          if (inputTokenizerFlushTimer !== null) {
            window.clearTimeout(inputTokenizerFlushTimer);
            inputTokenizerFlushTimer = null;
          }
          dispatchInputSegments(inputTokenizer.push(data));
          if (!inputTokenizer.hasPending()) return;
          inputTokenizerFlushTimer = window.setTimeout(() => {
            inputTokenizerFlushTimer = null;
            dispatchInputSegments(inputTokenizer.flush());
          }, TERMINAL_INPUT_TOKENIZER_FLUSH_MS);
        });
        resizeDisposable = activeTerminal.onResize(({ cols, rows }) => {
          geometryCoordinator.handleTerminalResize(cols, rows);
        });
      };
      if (!bufferedSocket) {
        let initialGeometry: InitialTerminalGeometry | null = null;
        if (terminalSurfaceEligible()) {
          terminalHost.dataset.terminalInitialGeometry = "pending";
          openTerminalSurface();
          initialGeometry = await fitTerminalForInitialAttach({
            ownerDocument: terminalHost.ownerDocument,
            host: terminalHost,
            terminal,
            fitAddon,
            onRepaint: (info) => {
              emitAppDiagnosticsPerformance({
                category: "PERFORMANCE",
                metric: "TERMINAL_PAINT",
                phase: TERMINAL_PAINT_PHASES[info.phase],
                roomId: pane.roomId,
                paneId: pane.id,
                instanceId: terminalInstanceIdRef.current,
                cols: info.cols,
                rows: info.rows,
                width: info.width,
                height: info.height,
                repaired: info.suspect,
                canvasWidth: info.canvasWidth,
                canvasHeight: info.canvasHeight,
                canvasBlank: info.canvasBlank,
                darkPixelRatio: info.darkPixelRatio,
                cellWidth: terminalCharacterCellSize(terminalRef.current).width,
                cellHeight: terminalCharacterCellSize(terminalRef.current).height,
                rowCount: info.rowCount,
                populatedRowCount: info.populatedRowCount,
                blankRowRatio: info.blankRowRatio
              });
            }
          });
          delete terminalHost.dataset.terminalInitialGeometry;
          emitAppDiagnosticsPerformance({
            category: "PERFORMANCE",
            metric: "TERMINAL_GEOMETRY",
            phase: "INITIAL_FIT",
            roomId: pane.roomId,
            paneId: pane.id,
            value: initialGeometry ? 1 : 0,
            cols: initialGeometry?.cols ?? 0,
            rows: initialGeometry?.rows ?? 0
          });
        }
        if (disposed) return;
        bufferedSocket = createBufferedTerminalSocket(terminalTicket, {
          clientMode: socketClientMode,
          leaseId: terminalControlRef.current.leaseId,
          ...(initialGeometry
            ? {
                initialCols: initialGeometry.cols,
                initialRows: initialGeometry.rows
              }
            : {})
        });
      }
      bufferedSocketRef.current = null;
      const connectingSocket = bufferedSocket.socket;
      socketGeneration = reconnectCoordinatorRef.current.beginSocketGeneration();
      socket = connectingSocket;
      socketRef.current = connectingSocket;
      readySocketRef.current = null;
      setTerminalControl({
        protocolVersion: 2,
        clientMode: socketClientMode,
        state: socketClientMode === "OBSERVER" ? "OBSERVER" : "AVAILABLE",
        holderLeaseId: null
      });
      const earlySocketEvents = bufferedSocket.events;
      connectingSocket.addEventListener("open", () => {
        setTerminalStatus("connecting");
      });
      for (const chunk of terminalTranscriptSeed(terminalSessionResponse)) {
        queueTerminalReplay(chunk, "PREFILL");
      }
      syncOutputVisibility();
      const handleSocketMessage = (event: MessageEvent) => {
        if (!socket || disposed || socketRef.current !== socket) return;
        terminalSocketMessageCountRef.current += 1;
        let payload: unknown;
        try {
          payload = JSON.parse(String(event.data));
        } catch {
          return;
        }
        const parsed = paneCliWebSocketServerMessageSchema.safeParse(payload);
        if (!parsed.success) return;
        if (finalSocketState) return;
        const message = parsed.data;
        if (message.type === "pong") {
          return;
        }
        if (message.type === "ready") {
          const matchesExpectedIdentity =
            cliReadyMatchesExpectedIdentity(message, {
              paneId: pane.id,
              sessionId: terminalSessionResponse.session.sessionId
            }) &&
            message.runtimeId === terminalSessionResponse.session.runtimeId;
          if (!matchesExpectedIdentity) {
            protocolRejected = true;
            readySocketRef.current = null;
            clearTerminalSocketKeepalive();
            clearModelSettingsOutputRefresh(socket);
            clearReconnectTimer();
            setTerminalStatus("closed");
            setError("CLI connection identity mismatch. Reconnect this pane.");
            socket?.close(1008, "CLI terminal identity mismatch");
            return;
          }
          readySocketRef.current = { socket, sessionId: message.sessionId };
          scheduleTerminalSocketKeepalive(socket, message.sessionId);
          terminalControlRequestPendingRef.current = false;
          if (message.protocolVersion === 2) {
            const controlState = message.controlState ??
              (message.clientMode === "OBSERVER" ? "OBSERVER" : "AVAILABLE");
            setTerminalControl({
              protocolVersion: 2,
              clientMode: message.clientMode ?? socketClientMode,
              state: controlState,
              leaseId: controlState === "CONTROLLER" ? message.leaseId ?? null : null,
              holderLeaseId: controlState === "HELD_BY_OTHER" ? message.leaseId ?? null : null,
              expiresAt: message.expiresAt ?? null,
              heartbeatIntervalMs: message.heartbeatIntervalMs ?? 10_000
            }, socket, message.sessionId);
            reportCliLifecycleEvent("CONTROL_STATE_CHANGED", "INFO", "SERVER_STATE", {
              sessionId: message.sessionId,
              runtimeId: message.runtimeId,
              controlState,
              protocolVersion: 2,
              clientMode: message.clientMode ?? socketClientMode,
              socketGeneration
            });
          } else {
            setTerminalControl({
              protocolVersion: 1,
              clientMode: "INTERACTIVE",
              state: "CONTROLLER",
              leaseId: null,
              holderLeaseId: null,
              expiresAt: null
            });
          }
          if (terminal) geometryCoordinator.handleTerminalResize(terminal.cols, terminal.rows);
          presizeHiddenFullscreenPane();
          const wasReconnect = reconnectInProgressRef.current;
          setReconnectInProgress(false);
          reportCliLifecycleEvent(
            "SOCKET_READY",
            "SUCCESS",
            wasReconnect ? "SESSION_REFRESH" : "INITIAL_ATTACH",
            {
              sessionId: message.sessionId,
              runtimeId: message.runtimeId,
              protocolVersion: message.protocolVersion ?? 1,
              clientMode: message.clientMode ?? socketClientMode,
              socketGeneration
            }
          );
          if (wasReconnect) {
            reportCliLifecycleEvent("RECONNECT_SUCCEEDED", "SUCCESS", "SESSION_REFRESH", {
              sessionId: message.sessionId,
              runtimeId: message.runtimeId,
              socketGeneration
            });
          }
          if (
            terminalSessionResponse.session.purpose === "LOGIN" &&
            isTargetRef.current &&
            isVisibleRef.current &&
            !paneMinimizedRef.current
          ) {
            window.requestAnimationFrame(() => {
              if (
                sessionResponseRef.current?.session.sessionId === message.sessionId &&
                sessionResponseRef.current.session.purpose === "LOGIN" &&
                isTargetRef.current &&
                isVisibleRef.current &&
                !paneMinimizedRef.current
              ) {
                focusTerminal();
              }
            });
          }
          reportTerminalBootstrapped();
          recordLifecycleDebugEvent({
            type: "terminal_socket_ready",
            scope: "TerminalPane",
            detail: `generation=${socketGeneration} session=${message.sessionId}`,
            paneId: pane.id,
            paneMode: pane.mode
          });
          setError(null);
          flushPendingTerminalInputs();
          ensureTerminalControl();
          return;
        }
        if (
          message.type !== "error" &&
          (readySocketRef.current?.socket !== socket ||
            readySocketRef.current.sessionId !== terminalSessionResponse.session.sessionId)
        ) {
          return;
        }
        if (message.type === "session_replaced") {
          finalSocketState = true;
          clearReconnectTimer();
          clearTerminalSocketKeepalive();
          reconnectAttemptRef.current = 0;
          reconnectCoordinatorRef.current.invalidateSocketGeneration(socketGeneration);
          if (readySocketRef.current?.socket === socket) readySocketRef.current = null;
          setTerminalStatus("connecting");
          setConnectionAlert(null);
          api.invalidateCliRuntimes();
          void attachReplacedCliSession(message.sessionId, terminalSessionResponse.session.runtimeId);
          return;
        }
        if (message.type === "control_upgraded") {
          // Only acknowledge an upgrade this socket actually requested. A late
          // or unsolicited acknowledgement is not a new user interaction.
          if (!observerControlUpgradePendingRef.current) return;
          observerControlUpgradePendingRef.current = false;
          setTerminalControl({
            clientMode: "INTERACTIVE",
            state: "AVAILABLE",
            leaseId: null,
            holderLeaseId: null,
            expiresAt: null
          });
          ensureTerminalControl(true);
          const presize = fullscreenPresizeRef.current;
          if (presize && !isVisibleRef.current) requestFullscreenPresize(presize.cols, presize.rows);
          return;
        }
        if (message.type === "control_state") {
          terminalControlRequestPendingRef.current = false;
          setTerminalControl({
            state: message.controlState,
            leaseId: message.controlState === "CONTROLLER" ? message.leaseId ?? null : null,
            holderLeaseId: message.controlState === "HELD_BY_OTHER" ? message.leaseId ?? null : null,
            expiresAt: message.expiresAt ?? null
          }, socket, terminalSessionResponse.session.sessionId);
          if (message.controlState === "CONTROLLER" && terminal) {
            // A lease grant/state pair reconciles geometry once per identity.
            // The coordinator forces only the first frame of this socket, so the
            // CLI repaints the whole screen into the rebuilt xterm once; later
            // same-grid frames never nudge the PTY or replay CLI history.
            geometryCoordinator.requestRefit({ reason: "CONTROL" });
            geometryCoordinator.handleTerminalResize(terminal.cols, terminal.rows);
          }
          reportCliLifecycleEvent("CONTROL_STATE_CHANGED", "INFO", "SERVER_STATE", {
            controlState: message.controlState,
            socketGeneration
          });
          if (message.controlState === "CONTROLLER") flushPendingTerminalInputs();
          if (message.controlState === "AVAILABLE" || message.controlState === "HELD_BY_OTHER") {
            ensureTerminalControl();
          }
          return;
        }
        if (message.type === "control_granted") {
          terminalControlRequestPendingRef.current = false;
          setTerminalControl({
            clientMode: "INTERACTIVE",
            state: "CONTROLLER",
            leaseId: message.leaseId,
            holderLeaseId: null,
            expiresAt: message.expiresAt
          }, socket, terminalSessionResponse.session.sessionId);
          if (terminal) {
            // A lease grant/state pair reconciles geometry once per identity.
            // The coordinator forces only the first frame of this socket, so the
            // CLI repaints the whole screen into the rebuilt xterm once; later
            // same-grid frames never nudge the PTY or replay CLI history.
            geometryCoordinator.requestRefit({ reason: "CONTROL" });
            geometryCoordinator.handleTerminalResize(terminal.cols, terminal.rows);
          }
          reportCliLifecycleEvent("CONTROL_GRANTED", "SUCCESS", "CONTROL_ACQUIRED", {
            controlState: "CONTROLLER",
            socketGeneration
          });
          flushPendingTerminalInputs();
          const presize = fullscreenPresizeRef.current;
          fullscreenPresizeRef.current = null;
          if (presize && !isVisibleRef.current) {
            geometryCoordinator.backgroundResize(presize.cols, presize.rows);
            releaseTerminalControl();
          }
          return;
        }
        if (message.type === "control_revoked") {
          terminalControlRequestPendingRef.current = false;
          setTerminalControl({
            state: message.reason === "TAKEN_OVER" ? "HELD_BY_OTHER" : "AVAILABLE",
            leaseId: null,
            holderLeaseId: null,
            expiresAt: null
          });
          reportCliLifecycleEvent(
            "CONTROL_REVOKED",
            "REVOKED",
            cliControlRevocationTelemetryReason(message.reason),
            {
              controlState: message.reason === "TAKEN_OVER" ? "HELD_BY_OTHER" : "AVAILABLE",
              socketGeneration
            }
          );
          return;
        }
        if (message.type === "control_denied") {
          const deniedLeaseId = terminalControlRef.current.leaseId;
          terminalControlRequestPendingRef.current = false;
          observerControlUpgradePendingRef.current = false;
          if (message.code === "CLI_CONTROL_REQUIRED" || message.code === "CLI_LEASE_STALE") {
            // Denials have no input correlation and may reject a heartbeat.
            // Never infer that the last input is safe to replay.
            setConnectionAlert({
              tone: "bad",
              message: "Terminal control changed. Check the prompt before sending again."
            });
            setTerminalControl({
              state: terminalControlRef.current.clientMode === "OBSERVER" ? "OBSERVER" : "AVAILABLE",
              leaseId: null,
              holderLeaseId: null,
              expiresAt: null
            });
          }
          replayDeniedTerminalInput(message.code, socket, deniedLeaseId);
          reportCliLifecycleEvent(
            "CONTROL_DENIED",
            "DENIED",
            cliControlDenialTelemetryReason(message.code),
            {
              controlState: terminalControlRef.current.state,
              socketGeneration
            }
          );
          return;
        }
        if (message.type === "output") {
          const visibleData = stripHiddenTerminalEcho(message.data);
          if (visibleData) {
            if (fallbackRunRef.current) resetFallbackRunIdleTimer();
            if (!initialReplayStatusReceived) {
              queueTerminalReplay(visibleData, "PREFILL");
              return;
            }
            for (const text of osc52ClipboardScanner.push(visibleData)) acceptTerminalAppClipboardWrite(text);
            const refreshArm = modelSettingsOutputRefreshArmRef.current;
            let refreshOutputToken: number | null = null;
            let refreshOutputRevision: number | null = null;
            if (
              terminalReplayComplete &&
              refreshArm?.socket === socket &&
              refreshArm.sessionId === terminalSessionResponse.session.sessionId
            ) {
              refreshArm.outputRevision += 1;
              refreshOutputToken = refreshArm.token;
              refreshOutputRevision = refreshArm.outputRevision;
              if (modelSettingsRefreshTimerRef.current !== null) {
                window.clearTimeout(modelSettingsRefreshTimerRef.current);
                modelSettingsRefreshTimerRef.current = null;
              }
            }
            const clipboardFailure = recentTerminalClipboardFailure(visibleData);
            if (clipboardFailure) {
              updateClipboardDebug(
                "bad",
                "terminal reported clipboard failure",
                `fresh clipboard paste attempt (${clipboardFailure.source}) matched terminal clipboard failure signature; excerpt=${clipboardFailure.excerpt}.`
              );
            }
            if (initialReplayWritePending) {
              if (!initialReplayBuffered) {
                queueTerminalReplay(visibleData, "VISIBLE");
                if (refreshOutputToken !== null && refreshOutputRevision !== null) {
                  pendingReplayOutputRefresh = {
                    token: refreshOutputToken,
                    revision: refreshOutputRevision
                  };
                }
              } else {
                void outputCoordinator.enqueue(visibleData, () => {
                  scheduleTerminalScreenRunningCheck();
                  if (
                    terminalReplayComplete &&
                    refreshOutputToken !== null &&
                    refreshOutputRevision !== null
                  ) {
                    scheduleModelSettingsRefreshAfterParsedOutput(refreshOutputToken, refreshOutputRevision);
                  }
                }).catch(handleTerminalReplayFailure);
              }
              return;
            }
            void outputCoordinator.enqueue(visibleData, () => {
              scheduleTerminalScreenRunningCheck();
              if (
                terminalReplayComplete &&
                refreshOutputToken !== null &&
                refreshOutputRevision !== null
              ) {
                scheduleModelSettingsRefreshAfterParsedOutput(refreshOutputToken, refreshOutputRevision);
              }
            }).catch(handleTerminalReplayFailure);
            recoverBrokenTerminalGeometry();
          }
          return;
        }
        if (message.type === "status") {
          if (message.status !== "RUNNING") {
            finalSocketState = true;
            clearReconnectTimer();
            reconnectCoordinatorRef.current.invalidateSocketGeneration(socketGeneration);
            if (readySocketRef.current?.socket === socket) readySocketRef.current = null;
          }
          const applyStatus = () => {
            if (disposed || socketRef.current !== socket) return;
            setTerminalStatus(message.status === "RUNNING" ? "attached" : "closed");
            if (message.status === "RUNNING") {
              setNotice(null);
              reconnectAttemptRef.current = 0;
              setConnectionAlert(
                message.replayContinuity === "TRUNCATED"
                  ? {
                      message: "Reconnected. Some earlier terminal output was outside the replay window.",
                      tone: "warn"
                    }
                  : null
              );
              lastTerminalOutputRefitAtRef.current = Date.now();
              if (!recoverBrokenTerminalGeometry()) scheduleTerminalRefit({ delayedPass: false });
            } else {
              clearReconnectTimer();
              setConnectionAlert(null);
              clearStoredActiveCliTurn(pane.id);
              setActiveCliTurn(null);
              finishFallbackRun();
              if (message.statusReason) {
                void outputCoordinator.enqueue(`\r\n${message.statusReason}\n`).catch(handleTerminalReplayFailure);
              }
              onRevealReady?.(pane.id, revealGenerationRef.current);
            }
          };

          if (initialReplayStatusReceived) {
            terminalReplayComplete = message.status === "RUNNING";
            if (!terminalReplayComplete) clearModelSettingsOutputRefresh(socket);
            if (terminalReplayComplete) {
              if (!initialReplayErrorPending) {
                applyStatus();
                settleTerminalPrefill();
              }
              return;
            }
            setTerminalReplayReady(false);
            if (initialReplayWritePending) {
              pendingInitialReplayFinalize = () => {
                applyStatus();
                settleTerminalPrefill();
              };
              return;
            }
            applyStatus();
            settleTerminalPrefill();
            return;
          }

          initialReplayStatusReceived = true;
          if (pendingInitialPrefillQueueEvents === 0) settleTerminalPrefill();
          terminalReplayComplete = message.status === "RUNNING";
          if (!terminalReplayComplete) {
            clearModelSettingsOutputRefresh(socket);
            setTerminalReplayReady(false);
            flushInitialReplay(() => {
              applyStatus();
              settleTerminalPrefill();
            });
            return;
          }
          if (!initialReplayErrorPending) applyStatus();
          flushInitialReplay(() => {
            if (!disposed && socketRef.current === socket) {
              setTerminalReplayReady(true);
              settleTerminalPrefill();
              recoverBrokenTerminalGeometry();
            }
          });
          return;
        }
        if (message.type === "error") {
          if (message.code === "CODEX_EMPTY_ASSISTANT_MESSAGE") {
            setTerminalStatus("attached");
            setConnectionAlert({ message: message.message, tone: "warn" });
            void outputCoordinator.enqueue(`\r\n${message.message}\n`).catch(handleTerminalReplayFailure);
            return;
          }
          finalSocketState = true;
          clearReconnectTimer();
          reconnectCoordinatorRef.current.invalidateSocketGeneration(socketGeneration);
          if (readySocketRef.current?.socket === socket) readySocketRef.current = null;
          const applyError = () => {
            if (disposed || socketRef.current !== socket) return;
            clearReconnectTimer();
            setTerminalStatus("closed");
            setTerminalPrefillReady(true);
            void outputCoordinator.enqueue(`\r\n${message.message}\n`).finally(() => {
              onRevealReady?.(pane.id, revealGenerationRef.current);
            }).catch(handleTerminalReplayFailure);
          };
          initialReplayErrorPending = true;
          terminalReplayComplete = false;
          setTerminalReplayReady(false);
          clearModelSettingsOutputRefresh(socket);
          if (!initialReplayStatusReceived) {
            initialReplayStatusReceived = true;
            flushInitialReplay(applyError);
            return;
          }
          if (initialReplayWritePending) {
            pendingInitialReplayFinalize = applyError;
            return;
          }
          applyError();
        }
      };
      const reconnectAfterDisconnect = (event: Event) => {
        clearTerminalControlHeartbeat();
        clearTerminalSocketKeepalive();
        if (intentionalSocketParkRef.current) {
          clearReconnectTimer();
          reconnectAttemptRef.current = 0;
          reconnectCoordinatorRef.current.invalidateSocketGeneration(socketGeneration);
          if (readySocketRef.current?.socket === socket) readySocketRef.current = null;
          if (socketRef.current === socket) socketRef.current = null;
          setTerminalStatus("attached");
          setConnectionAlert(null);
          resetTerminalControl();
          setReconnectInProgress(false);
          if (xtermHostRef.current) {
            xtermHostRef.current.dataset.terminalSocketParked = "true";
          }
          recordLifecycleDebugEvent({
            type: "terminal_socket_parked",
            scope: "TerminalPane",
            detail: `generation=${socketGeneration} reason=hidden-warm-idle`,
            paneId: pane.id,
            paneMode: pane.mode
          });
          return;
        }
        if (finalSocketState || !shouldReconnectTerminalSocket(event)) {
          clearReconnectTimer();
          reconnectAttemptRef.current = 0;
          reconnectCoordinatorRef.current.invalidateSocketGeneration(socketGeneration);
          if (readySocketRef.current?.socket === socket) readySocketRef.current = null;
          setTerminalStatus("closed");
          setConnectionAlert(null);
          resetTerminalControl();
          setReconnectInProgress(false);
          if (!reconnectStopReported) {
            reconnectStopReported = true;
            reportCliLifecycleEvent(
              "RECONNECT_STOPPED",
              "INFO",
              finalSocketState ? "SESSION_CLOSED" : "SUPERSEDED",
              { socketGeneration }
            );
          }
          recordLifecycleDebugEvent({
            type: "terminal_reconnect_suppressed",
            scope: "TerminalPane",
            detail: `generation=${socketGeneration} final=${String(finalSocketState)} superseded=${String(!shouldReconnectTerminalSocket(event))}`,
            paneId: pane.id,
            paneMode: pane.mode
          });
          return;
        }
        if (
          disposed ||
          protocolRejected ||
          !reconnectCoordinatorRef.current.markDisconnected(socketGeneration)
        ) {
          if (
            !finalSocketState &&
            socketRef.current === socket &&
            isRecoverableCliSession(sessionResponse?.session)
          ) {
            if (readySocketRef.current?.socket === socket) readySocketRef.current = null;
            setTerminalStatus("reconnecting");
            setConnectionAlert(null);
            setReconnectInProgress(true);
            scheduleReconnect(socketGeneration, "SOCKET_CLOSE");
          }
          return;
        }
        if (readySocketRef.current?.socket === socket) readySocketRef.current = null;
        const disconnectReason = event.type === "error" ? "SOCKET_ERROR" : "SOCKET_CLOSE";
        const closeCode =
          "code" in event && typeof event.code === "number" ? event.code : undefined;
        const wasClean =
          "wasClean" in event && typeof event.wasClean === "boolean" ? event.wasClean : undefined;
        setReconnectInProgress(true);
        reportCliLifecycleEvent("SOCKET_DISCONNECTED", "RETRY", disconnectReason, {
          socketGeneration,
          ...(closeCode !== undefined ? { closeCode } : {}),
          ...(wasClean !== undefined ? { wasClean } : {})
        });
        recordLifecycleDebugEvent({
          type: "terminal_socket_disconnected",
          scope: "TerminalPane",
          detail: `generation=${socketGeneration} recoverable=${String(isRecoverableCliSession(sessionResponse?.session))}`,
          paneId: pane.id,
          paneMode: pane.mode
        });
        if (!isRecoverableCliSession(sessionResponse?.session)) {
          clearStoredActiveCliTurn(pane.id);
          setActiveCliTurn(null);
          finishFallbackRun();
          setTerminalStatus("closed");
          resetTerminalControl();
          setReconnectInProgress(false);
          reportCliLifecycleEvent(
            "RECONNECT_STOPPED",
            "FAILURE",
            "UNRECOVERABLE_SESSION",
            { socketGeneration }
          );
          return;
        }
        setTerminalStatus("reconnecting");
        setConnectionAlert(null);
        scheduleReconnect(socketGeneration, disconnectReason);
      };
      connectingSocket.addEventListener("message", handleSocketMessage);
      connectingSocket.addEventListener("close", reconnectAfterDisconnect);
      connectingSocket.addEventListener("error", reconnectAfterDisconnect);
      bufferedSocket.stopBuffering();
      for (const earlyEvent of earlySocketEvents) {
        if (earlyEvent.type === "message") handleSocketMessage(earlyEvent.event);
        else reconnectAfterDisconnect(earlyEvent.event);
      }
    }

    void attachTerminal().catch((err) => {
      if (disposed) return;
      setTerminalStatus("closed");
      reconnectFrameRef.current?.dispose();
      setError(err instanceof Error ? err.message : "CLI attach failed");
      setTerminalPrefillReady(true);
      onRevealReady?.(pane.id, revealGenerationRef.current);
    });

    let lastHostResizeDebug = "";
    let lastObservedHostWidth = 0;
    let lastObservedHostHeight = 0;
    const resizeObserver = new ResizeObserver((entries) => {
      const entry = entries.find((entry) => entry.target === terminalHost);
      // This host has no padding/border. Use the already-computed content box
      // rather than synchronously measuring again during observer delivery.
      const hostWidth = entry ? entry.contentRect.width : terminalHost.clientWidth || terminalHost.getBoundingClientRect().width || 0;
      const hostHeight = entry ? entry.contentRect.height : terminalHost.clientHeight || terminalHost.getBoundingClientRect().height || 0;
      const roundedWidth = Math.round(hostWidth);
      const roundedHeight = Math.round(hostHeight);
      if (roundedWidth === lastObservedHostWidth && roundedHeight === lastObservedHostHeight) {
        return;
      }
      lastObservedHostWidth = roundedWidth;
      lastObservedHostHeight = roundedHeight;
      const key = JSON.stringify([roundedWidth, roundedHeight, terminal?.cols ?? 0, terminal?.rows ?? 0]);
      if (key !== lastHostResizeDebug) {
        lastHostResizeDebug = key;
        emitAppDiagnosticsPerformance({
          category: "PERFORMANCE",
          metric: "TERMINAL_GEOMETRY",
          phase: "HOST_RESIZE",
          roomId: pane.roomId,
          paneId: pane.id,
          width: Math.round(hostWidth * 10) / 10,
          height: Math.round(hostHeight * 10) / 10,
          cols: terminal?.cols ?? 0,
          rows: terminal?.rows ?? 0
        });
      }
      // Standard container resize refits through the fit addon without destroying
      // GPU texture atlases or forcing PTY nudges on every frame unless broken.
      geometryCoordinator.requestRefit({ delayedPass: false, reason: "OBSERVER" });
    });
    resizeObserver.observe(terminalHost);

    return () => {
      disposed = true;
      terminalTextareaRef.current = null;
      finishFallbackRun();
      if (inputTokenizerFlushTimer !== null) {
        window.clearTimeout(inputTokenizerFlushTimer);
        inputTokenizerFlushTimer = null;
      }
      if (terminalPromptDraftDebounceTimerRef.current !== null) {
        window.clearTimeout(terminalPromptDraftDebounceTimerRef.current);
        terminalPromptDraftDebounceTimerRef.current = null;
      }
      delete terminalHost.dataset.terminalInitialGeometry;
      delete terminalHost.dataset.terminalPendingPrefillEvents;
      delete terminalHost.dataset.terminalPendingPrefillBytes;
      clearTerminalViewportEvidence(terminalHost);
      if (socket?.readyState === WebSocket.OPEN && socketRef.current === socket) {
        releaseTerminalControl();
      } else {
        clearTerminalControlHeartbeat();
      }
      clearTerminalSocketKeepalive();
      replayWriteQueue.dispose();
      outputCoordinator.dispose();
      if (terminalOutputCoordinatorRef.current === outputCoordinator) {
        terminalOutputCoordinatorRef.current = null;
      }
      if (syncTerminalOutputVisibilityRef.current === syncOutputVisibility) {
        syncTerminalOutputVisibilityRef.current = () => undefined;
      }
      if (socketGeneration > 0) reconnectCoordinatorRef.current.invalidateSocketGeneration(socketGeneration);
      clearScheduledTerminalRepaint();
      geometryCoordinator.dispose();
      resizeTrace.dispose();
      if (terminalGeometryCoordinatorRef.current === geometryCoordinator) {
        terminalGeometryCoordinatorRef.current = null;
      }
      resizeObserver.disconnect();
      for (const target of nativePasteTargets) {
        target.removeEventListener("paste", nativePasteListener, { capture: true });
        target.removeEventListener("keydown", nativePasteShortcutListener, { capture: true });
        target.removeEventListener("beforeinput", nativeBeforeInputListener, { capture: true });
      }
      for (const target of nativeCopyTargets) {
        target.removeEventListener("keydown", nativeCopyShortcutListener, { capture: true });
      }
      window.removeEventListener("keydown", nativeReasonixShortcutListener, { capture: true });
      for (const target of nativeContextMenuTargets) {
        target.removeEventListener("contextmenu", nativeContextMenuListener, { capture: true });
        target.removeEventListener("mousedown", nativeContextMenuMouseDownListener, { capture: true });
      }
      for (const { target, type, listener } of terminalIntentTargets) {
        target.removeEventListener(type, listener, { capture: true });
      }
      clearPasteShortcutFallback();
      dataDisposable?.dispose();
      scrollDisposable?.dispose();
      writeParsedDisposable?.dispose();
      paintRecoveryDisposable?.dispose();
      resizeDisposable?.dispose();
      socket?.close();
      terminal?.dispose();
      if (terminalRef.current === terminal) terminalRef.current = null;
      if (fitAddonRef.current === fitAddon) fitAddonRef.current = null;
      if (socketRef.current === socket) {
        socketRef.current = null;
      }
      if (readySocketRef.current?.socket === socket) {
        readySocketRef.current = null;
      }
      if (modelSettingsOutputRefreshArmRef.current?.socket === socket) {
        clearModelSettingsOutputRefresh(socket);
      }
    };
  }, [sessionResponse?.websocket]);

  function clearReconnectTimer() {
    if (reconnectTimerRef.current === null) return;
    window.clearTimeout(reconnectTimerRef.current);
    reconnectTimerRef.current = null;
  }

  function scheduleReconnect(
    expectedSocketGeneration: number,
    reason: CliTerminalClientEventInput["reason"] = "SESSION_REFRESH"
  ) {
    if (!reconnectCoordinatorRef.current.isCurrentSocketGeneration(expectedSocketGeneration)) return;
    clearReconnectTimer();
    const delayMs = cliReconnectDelayMs(reconnectAttemptRef.current);
    reconnectAttemptRef.current += 1;
    reportCliLifecycleEvent("RECONNECT_SCHEDULED", "RETRY", reason, {
      socketGeneration: expectedSocketGeneration,
      attempt: reconnectAttemptRef.current,
      delayMs
    });
    recordLifecycleDebugEvent({
      type: "terminal_reconnect_scheduled",
      scope: "TerminalPane",
      detail: `generation=${expectedSocketGeneration} attempt=${reconnectAttemptRef.current} delayMs=${delayMs}`,
      paneId: pane.id,
      paneMode: pane.mode
    });
    reconnectTimerRef.current = window.setTimeout(() => {
      reconnectTimerRef.current = null;
      if (!reconnectCoordinatorRef.current.isCurrentSocketGeneration(expectedSocketGeneration)) return;
      void startOrReconnect({ automaticReconnect: true, expectedSocketGeneration });
    }, delayMs);
  }

  async function attemptAutomaticCliSessionRecovery(
    expectedSocketGeneration: number | undefined
  ): Promise<"recovered" | "scheduled" | "permanent"> {
    try {
      const recovery = await api.recoveryCliTask(pane.id);
      const recoveryTaskId = recovery.threads[0]?.taskId ?? null;
      if (!recoveryTaskId) {
        return "permanent";
      }
      const resumed = await api.resumeCliSession(pane.id, { taskId: recoveryTaskId });
      const nextSession = {
        session: resumed.session,
        runtime: resumed.runtime,
        transcript: resumed.transcript,
        websocket: resumed.websocket
      };
      clearReconnectTimer();
      reconnectAttemptRef.current = 0;
      setError(null);
      setConnectionAlert(null);
      setSelectedRuntimeId(nextSession.session.runtimeId);
      setSessionResponse(nextSession);
      setTerminalStatus("idle");
      reportCliLifecycleEvent(
        "SESSION_RECOVERED",
        "SUCCESS",
        "AUTO_RESUME",
        expectedSocketGeneration === undefined ? {} : { socketGeneration: expectedSocketGeneration }
      );
      recordLifecycleDebugEvent({
        type: "terminal_reconnect_recovered",
        scope: "TerminalPane",
        detail: `task=${recoveryTaskId} session=${nextSession.session.sessionId} generation=${expectedSocketGeneration ?? "unknown"}`,
        paneId: pane.id,
        paneMode: pane.mode
      });
      return "recovered";
    } catch (recoveryErr) {
      if (isRetryableCliReconnectError(recoveryErr) && expectedSocketGeneration !== undefined) {
        setTerminalStatus("reconnecting");
        setConnectionAlert(null);
        scheduleReconnect(expectedSocketGeneration);
        return "scheduled";
      }
      return "permanent";
    }
  }

  // Remembers the account for the next pane of this CLI and restarts only this pane on it.
  // Gemini and Claude keep the active model and effort and continue the same conversation.
  function switchCliAccountProfile(runtimeId: "cli:gemini" | "cli:copilot" | "cli:cursor" | "cli:kimi" | "cli:claude", profileId: string) {
    const currentProfileId = sessionResponseRef.current?.session.accountProfileId ?? "main";
    if (runtimeId === "cli:copilot" || runtimeId === "cli:cursor" || runtimeId === "cli:kimi") {
      const leavingAuto = autoAccountModeRef.current;
      setAutoAccountMode(false);
      writeLastAutoAccountMode(runtimeId, false);
      // Picking the account Auto already runs on only leaves Auto; the session keeps running.
      if (leavingAuto && sessionResponseRef.current && profileId === currentProfileId) {
        if (runtimeId === "cli:copilot") setSelectedCopilotAccountProfileId(profileId);
        else if (runtimeId === "cli:kimi") setSelectedKimiAccountProfileId(profileId);
        else setSelectedCursorAccountProfileId(profileId);
        void requestCliSession({ accountProfileId: profileId });
        return;
      }
    }
    if (runtimeId === "cli:gemini") {
      setSelectedGeminiAccountProfileId(profileId);
      writeLastCliAccountProfileId("cli:gemini", profileId);
    } else if (runtimeId === "cli:copilot") {
      setSelectedCopilotAccountProfileId(profileId);
      writeLastCliAccountProfileId("cli:copilot", profileId);
    } else if (runtimeId === "cli:cursor") {
      setSelectedCursorAccountProfileId(profileId);
      writeLastCliAccountProfileId("cli:cursor", profileId);
    } else if (runtimeId === "cli:kimi") {
      setSelectedKimiAccountProfileId(profileId);
      writeLastCliAccountProfileId("cli:kimi", profileId);
    } else {
      setSelectedClaudeAccountProfileId(profileId);
      writeLastCliAccountProfileId("cli:claude", profileId);
    }
    if (!sessionResponseRef.current || profileId === currentProfileId) return;
    if (runtimeId === "cli:gemini" || runtimeId === "cli:claude") {
      const hasActiveTask = Boolean(sessionResponseRef.current?.session);
      const activeModelId = modelSettingsRef.current?.current?.modelId
        ?? sessionResponseRef.current?.session.modelId
        ?? pane.modelId
        ?? undefined;
      const activeReasoningEffort = (modelSettingsRef.current?.current?.reasoningEffort
        ?? pane.reasoningEffort
        ?? undefined) as Pane["reasoningEffort"];
      void requestCliSession({
        accountProfileId: profileId,
        modelId: activeModelId,
        reasoningEffort: activeReasoningEffort,
        forceRestart: true,
        resume: hasActiveTask
      });
      return;
    }
    const hasActiveTask = Boolean(sessionResponseRef.current.session.cliTaskId);
    void requestCliSession({ accountProfileId: profileId, forceRestart: true, resume: hasActiveTask });
  }

  // Auto keeps the running session on its account and starts every later session on the account with the most room.
  function selectAutoAccount(runtimeId: "cli:copilot" | "cli:cursor" | "cli:kimi") {
    setAutoAccountMode(true);
    writeLastAutoAccountMode(runtimeId, true);
    if (sessionResponseRef.current) void requestCliSession({ accountMode: "AUTO" });
  }

  async function requestCliSession(
    input: { accountProfileId?: string | null; accountMode?: "AUTO"; modelId?: string | null; reasoningEffort?: Pane["reasoningEffort"]; forceRestart?: boolean; resume?: boolean } = {},
    options: { automaticReconnect?: boolean; expectedSocketGeneration?: number } = {}
  ): Promise<PaneCliSessionResponse | null> {
    if (pane.id.startsWith("pane:optimistic-")) return null;
    if (!selectedRuntime && !options.automaticReconnect) return null;
    const selectedRuntimeForRequest = selectedRuntime;
    return reconnectCoordinatorRef.current.runSessionRequest(async () => {
      if (
        options.automaticReconnect &&
        (options.expectedSocketGeneration === undefined ||
          !reconnectCoordinatorRef.current.isCurrentSocketGeneration(options.expectedSocketGeneration))
      ) {
        setReconnectInProgress(false);
        return null;
      }
      setPending(true);
      if (!options.automaticReconnect) {
        clearReconnectTimer();
        reconnectAttemptRef.current = 0;
        setConnectionAlert(null);
        setError(null);
        setNotice(null);
      }
      try {
        const nextSession = options.automaticReconnect
          ? await api.activeCliSession(pane.id, { includeTranscript: false })
          : await api.createCliSession(
              pane.id,
              buildTerminalCliSessionRequest(
                pane,
                selectedRuntimeForRequest!.id,
                selectedRuntimeForRequest!.id === "cli:gemini"
                  ? { ...input, accountProfileId: input.accountProfileId ?? selectedGeminiAccountProfileId }
                  : (selectedRuntimeForRequest!.id === "cli:copilot" || selectedRuntimeForRequest!.id === "cli:cursor" || selectedRuntimeForRequest!.id === "cli:kimi") &&
                      (input.accountMode === "AUTO" || (input.accountProfileId === undefined && autoAccountModeRef.current))
                    ? { ...input, accountProfileId: undefined, accountMode: "AUTO" as const }
                  : selectedRuntimeForRequest!.id === "cli:copilot"
                    ? { ...input, accountProfileId: input.accountProfileId ?? selectedCopilotAccountProfileId }
                    : selectedRuntimeForRequest!.id === "cli:cursor"
                      ? { ...input, accountProfileId: input.accountProfileId ?? selectedCursorAccountProfileId }
                    : selectedRuntimeForRequest!.id === "cli:kimi"
                      ? { ...input, accountProfileId: input.accountProfileId ?? selectedKimiAccountProfileId }
                      : selectedRuntimeForRequest!.id === "cli:claude"
                        ? { ...input, accountProfileId: input.accountProfileId ?? selectedClaudeAccountProfileId }
                  : input
              )
            );
        if (!nextSession || (
          options.automaticReconnect &&
          (
            !nextSession.websocket ||
            !isRecoverableCliSession(nextSession.session) ||
            nextSession.session.paneId !== pane.id
          )
        )) {
          throw new SpaceApiError("The CLI session is no longer active.", {
            status: 409,
            code: "CLI_SESSION_CLOSED"
          });
        }
        if (
          options.automaticReconnect &&
          options.expectedSocketGeneration !== undefined &&
          !reconnectCoordinatorRef.current.isCurrentSocketGeneration(options.expectedSocketGeneration)
        ) {
          setReconnectInProgress(false);
          return null;
        }
        clearReconnectTimer();
        reconnectAttemptRef.current = 0;
        setError(null);
        setConnectionAlert(null);
        reconnectFrameRef.current?.dispose();
        reconnectFrameRef.current = options.automaticReconnect && isVisibleRef.current && !paneMinimizedRef.current &&
          nextSession.session.sessionId === sessionResponseRef.current?.session.sessionId && xtermHostRef.current
          ? holdTerminalReconnectFrame(xtermHostRef.current) : null;
        setSessionResponse(nextSession);
        recordLifecycleDebugEvent({
          type: "session_sync",
          scope: "TerminalPane",
          detail: `runtime=${nextSession.session.runtimeId} status=${nextSession.session.status} reconnect=${String(options.automaticReconnect)}`,
          paneId: pane.id,
          paneMode: pane.mode
        });
        return nextSession;
      } catch (err) {
        if (
          options.automaticReconnect &&
          options.expectedSocketGeneration !== undefined &&
          reconnectCoordinatorRef.current.isCurrentSocketGeneration(options.expectedSocketGeneration) &&
          isRetryableCliReconnectError(err)
        ) {
          setTerminalStatus("reconnecting");
          setConnectionAlert(null);
          scheduleReconnect(options.expectedSocketGeneration);
        } else if (
          options.automaticReconnect &&
          options.expectedSocketGeneration !== undefined &&
          reconnectCoordinatorRef.current.isCurrentSocketGeneration(options.expectedSocketGeneration) &&
          err instanceof SpaceApiError &&
          err.code === "CLI_SESSION_CLOSED"
        ) {
          const recovery = await attemptAutomaticCliSessionRecovery(options.expectedSocketGeneration);
          if (recovery !== "permanent") {
            return null;
          }
          clearReconnectTimer();
          setTerminalStatus("closed");
          setError(err instanceof Error ? err.message : "CLI reconnect stopped");
          setReconnectInProgress(false);
          reportCliLifecycleEvent(
            "RECONNECT_STOPPED",
            "FAILURE",
            "PERMANENT_ERROR",
            { socketGeneration: options.expectedSocketGeneration }
          );
          recordLifecycleDebugEvent({
            type: "terminal_reconnect_suppressed",
            scope: "TerminalPane",
            detail: `generation=${options.expectedSocketGeneration ?? "unknown"} permanent=${String(!isRetryableCliReconnectError(err))}`,
            paneId: pane.id,
            paneMode: pane.mode
          });
        } else if (options.automaticReconnect) {
          clearReconnectTimer();
          setTerminalStatus("closed");
          setError(err instanceof Error ? err.message : "CLI reconnect stopped");
          setReconnectInProgress(false);
          reportCliLifecycleEvent(
            "RECONNECT_STOPPED",
            "FAILURE",
            "PERMANENT_ERROR",
            { socketGeneration: options.expectedSocketGeneration }
          );
          recordLifecycleDebugEvent({
            type: "terminal_reconnect_suppressed",
            scope: "TerminalPane",
            detail: `generation=${options.expectedSocketGeneration ?? "unknown"} permanent=${String(!isRetryableCliReconnectError(err))}`,
            paneId: pane.id,
            paneMode: pane.mode
          });
        } else {
          setError(err instanceof Error ? err.message : "CLI session failed to start");
        }
        return null;
      } finally {
        setPending(false);
      }
    });
  }

  async function startOrReconnect(options: { automaticReconnect?: boolean; expectedSocketGeneration?: number } = {}) {
    await requestCliSession({}, options);
  }

  // The account a new pane starts on, the same one its picker selects; undefined keeps the picker's selection
  // (CLIs without account profiles, or a list that has not loaded within a few seconds).
  async function newPaneAccountProfileId(): Promise<string | undefined> {
    const runtimeId = selectedRuntime?.id;
    const load = accountProfilesLoadRef.current;
    if (!runtimeId || !hasCliAccountProfiles(runtimeId) || !load || load.runtimeId !== runtimeId) return undefined;
    let timer: number | undefined;
    const result = await Promise.race([
      load.result.catch(() => null),
      new Promise<null>((resolve) => { timer = window.setTimeout(() => resolve(null), NEW_PANE_ACCOUNT_WAIT_MS); })
    ]);
    window.clearTimeout(timer);
    if (!result) return undefined;
    // A copilot pane (Job, Mail) starts on the account chosen for it (launch dialog, Settings → Job/Mail Copilot).
    const jobCopilotAccount = await jobCopilotPaneAccount(runtimeId);
    if (jobCopilotAccount && result.profiles.some((profile) => profile.profileId === jobCopilotAccount)) return jobCopilotAccount;
    return cliAccountProfileForPane(result, readLastCliAccountProfileId(runtimeId), true);
  }

  /** The account a pane was opened for on this device, else the user's Job/Mail/Marketing/Freelance Copilot default for this CLI; null for other panes. */
  async function jobCopilotPaneAccount(runtimeId: string): Promise<string | null> {
    const opened = takeNewPaneAccount(pane.id, runtimeId);
    if (opened || (pane.mode !== "JOB_APPLY" && pane.mode !== "MAIL_COPILOT" && pane.mode !== "MARKETING_COPILOT" && pane.mode !== "FREELANCE_COPILOT")) return opened;
    const settings = await api.userSettings().catch(() => null);
    const saved = pane.mode === "JOB_APPLY" ? settings?.jobCopilot : pane.mode === "MAIL_COPILOT" ? settings?.mailCopilot : pane.mode === "FREELANCE_COPILOT" ? settings?.freelanceCopilot : settings?.marketingCopilot;
    return saved?.runtimeId === runtimeId ? saved.accountProfileId ?? null : null;
  }

  function triggerTerminalSocketRecovery(source: string): void {
    if (reconnectInProgressRef.current) return;
    if (reconnectTimerRef.current !== null) return;
    const session = sessionResponseRef.current;
    if (!session?.websocket || !isRecoverableCliSession(session.session)) return;
    setReconnectInProgress(true);
    setTerminalStatus("reconnecting");
    setConnectionAlert(null);
    const generation = reconnectCoordinatorRef.current.beginSocketGeneration();
    recordLifecycleDebugEvent({
      type: "terminal_reconnect_watchdog",
      scope: "TerminalPane",
      detail: `source=${source} generation=${generation}`,
      paneId: pane.id,
      paneMode: pane.mode
    });
    void startOrReconnect({ automaticReconnect: true, expectedSocketGeneration: generation });
  }

  function checkTerminalSocketHealth(source = "watchdog"): void {
    const now = Date.now();
    if (reconnectInProgressRef.current) {
      if (reconnectStartedAtRef.current !== null && now - reconnectStartedAtRef.current > 12_000) {
        recordLifecycleDebugEvent({
          type: "terminal_reconnect_watchdog_deadlock_cleared",
          scope: "TerminalPane",
          detail: `source=${source} elapsedMs=${now - reconnectStartedAtRef.current}`,
          paneId: pane.id,
          paneMode: pane.mode
        });
        setReconnectInProgress(false);
        clearReconnectTimer();
        reconnectCoordinatorRef.current.clearSessionRequestFlight();
        api.clearActiveCliSessionFlight?.(pane.id);
      } else {
        return;
      }
    }
    if (reconnectTimerRef.current !== null) return;
    if (intentionalSocketParkRef.current) return;
    const status = terminalStatusRef.current;
    const session = sessionResponseRef.current;
    const isPotentiallyActiveCli = Boolean(session && isRecoverableCliSession(session.session));
    if (!isPotentiallyActiveCli && status !== "attached" && status !== "connecting" && status !== "reconnecting") return;
    if (!session?.websocket || !isRecoverableCliSession(session.session)) return;
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      triggerTerminalSocketRecovery(source);
    } else if (source !== "watchdog" && document.visibilityState === "visible") {
      probeTerminalSocketLiveness(socket, source);
    }
  }

  // A phone that slept can keep a dead socket OPEN: on resume one ping must get any answer within 6 s.
  function probeTerminalSocketLiveness(socket: WebSocket, source: string): void {
    if (terminalSocketProbeTimerRef.current !== null || readySocketRef.current?.socket !== socket) return;
    const messagesBefore = terminalSocketMessageCountRef.current;
    try {
      socket.send(JSON.stringify({ type: "ping" }));
    } catch {
      return;
    }
    terminalSocketProbeTimerRef.current = window.setTimeout(() => {
      terminalSocketProbeTimerRef.current = null;
      if (socketRef.current !== socket || terminalSocketMessageCountRef.current !== messagesBefore) return;
      triggerTerminalSocketRecovery(`${source}-pong-timeout`);
    }, TERMINAL_SOCKET_PROBE_TIMEOUT_MS);
  }

  async function autoAttachRunningSession() {
    try {
      const pendingResumeIntent = takeCliResumeIntent(pane.id);
      if (pendingResumeIntent !== null) {
        recordLifecycleDebugEvent({
          type: "terminal_auto_attach_deferred_by_resume_intent",
          scope: "TerminalPane",
          detail: `pending resume intent; taskId=${pendingResumeIntent.taskId ?? "none"} threadId=${pendingResumeIntent.threadId ?? "none"}`,
          paneId: pane.id,
          paneMode: pane.mode
        });
        setPending(true);
        try {
          const resumeInput = pendingResumeIntent.taskId
            ? { taskId: pendingResumeIntent.taskId }
            : pendingResumeIntent.threadId
              ? { threadId: pendingResumeIntent.threadId }
              : null;
          if (!resumeInput) {
            throw new Error("CLI resume intent has no task or thread reference.");
          }
          const resumed = await api.resumeCliSession(pane.id, resumeInput);
          setSelectedRuntimeId(resumed.session.runtimeId);
          setSessionResponse({
            session: resumed.session,
            runtime: resumed.runtime,
            transcript: resumed.transcript,
            websocket: resumed.websocket
          });
          setTerminalStatus("idle");
        } catch (err) {
          setTerminalStatus("closed");
          setError(err instanceof Error ? err.message : "CLI resume failed");
        } finally {
          setPending(false);
        }
        reportTerminalBootstrapped();
        settleTerminalPrefill();
        return;
      }
      const nowMs = Date.now();
      const paneAgeMs = nowMs - new Date(pane.createdAt).getTime();
      const recentlyChecked = nowMs - lastActiveSessionCheckedMsRef.current < 5_000;
      const activeSession = recentlyChecked
        ? null
        : await api.activeCliSession(pane.id, { includeTranscript: false });
      if (activeSession && isRecoverableCliSession(activeSession.session) && activeSession.session.paneId === pane.id) {
        restoreActiveSession(activeSession);
      } else {
        if (paneAgeMs <= NEW_PANE_WINDOW_MS) {
          const runtimeId = selectedRuntime?.id ?? "";
          if ((runtimeId === "cli:copilot" || runtimeId === "cli:cursor" || runtimeId === "cli:kimi") && readLastAutoAccountMode(runtimeId) && pane.mode !== "JOB_APPLY" && pane.mode !== "MAIL_COPILOT" && pane.mode !== "MARKETING_COPILOT" && pane.mode !== "FREELANCE_COPILOT") {
            setAutoAccountMode(true);
            await requestCliSession({ accountMode: "AUTO" });
          } else {
            await requestCliSession({ accountProfileId: await newPaneAccountProfileId() });
          }
        } else {
          reportTerminalBootstrapped();
          settleTerminalPrefill();
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Active CLI session failed to load");
      reportTerminalBootstrapped();
      settleTerminalPrefill();
    }
  }

  async function reconnectTerminal() {
    if (pending) return;
    const rememberedTaskId = sessionResponseRef.current?.session.cliTaskId ?? null;
    clearReconnectTimer();
    reconnectAttemptRef.current = 0;
    setReconnectInProgress(false);
    setConnectionAlert(null);
    setNotice(null);
    autoAttachAttemptRef.current = null;
    setPending(true);
    setError(null);
    try {
      const active = await api.activeCliSession(pane.id, { includeTranscript: false });
      const recovery = await api.recoveryCliTask(pane.id);
      const recoveryTaskId = recovery.threads[0]?.taskId ?? null;
      const activeTaskId = active?.session.cliTaskId ?? active?.session.sessionId ?? null;
      const activeMatchesRecovery = Boolean(
        active &&
        recoveryTaskId &&
        activeTaskId === recoveryTaskId
      );
      let nextSession: PaneCliSessionResponse;
      if (
        active &&
        isRecoverableCliSession(active.session) &&
        (activeMatchesRecovery || !recoveryTaskId)
      ) {
        nextSession = active;
      } else {
        const taskId = recoveryTaskId ?? rememberedTaskId;
        if (!taskId) {
          throw new SpaceApiError("No resumable CLI task was found for this pane.", {
            status: 404,
            code: "CLI_RECOVERY_TASK_NOT_FOUND"
          });
        }
        const resumed = await api.resumeCliSession(pane.id, { taskId });
        nextSession = {
          session: resumed.session,
          runtime: resumed.runtime,
          transcript: resumed.transcript,
          websocket: resumed.websocket
        };
      }
      setSelectedRuntimeId(nextSession.session.runtimeId);
      setSessionResponse(nextSession);
      setTerminalStatus("idle");
      const watchdogSessionId = nextSession.session.sessionId;
      void waitForTerminalSocketOpen(watchdogSessionId, 5_000).then((opened) => {
        if (opened) return;
        const ready = readySocketRef.current;
        const socketAlive =
          Boolean(ready) &&
          ready?.sessionId === watchdogSessionId &&
          ready?.socket.readyState === WebSocket.OPEN;
        if (socketAlive) return;
        recordLifecycleDebugEvent({
          type: "terminal_reconnect_watchdog_restart",
          scope: "TerminalPane",
          detail: `session=${watchdogSessionId} reconnect ticket did not open a socket within 5s`,
          paneId: pane.id,
          paneMode: pane.mode
        });
        void startOrReconnect();
      });
    } catch (err) {
      setTerminalStatus("closed");
      setError(err instanceof Error ? err.message : "CLI reconnect failed");
    } finally {
      setPending(false);
    }
  }

  function updateClipboardDebug(severity: ClipboardDebugSeverity, title: string, detail: string) {
    if (sessionResponseRef.current?.session.purpose === "LOGIN") return;
    const entry = { severity, title, detail, at: new Date().toISOString() };
    setClipboardDebug(entry);
    const nextHistory = [...clipboardDebugHistoryRef.current.slice(-7), entry];
    clipboardDebugHistoryRef.current = nextHistory;
    setClipboardDebugHistory(nextHistory);
    if (typeof console !== "undefined" && (severity === "bad" || showCliDebugMode)) {
      const method = severity === "bad" ? "warn" : "info";
      console[method](`[space clipboard ${pane.id}] ${title}`, detail);
    }
    if (severity === "bad" || showCliDebugMode) {
      void reportClipboardDebug(entry, nextHistory);
    }
  }

  function setCliDebugMode(enabled: boolean) {
    try {
      getSpaceRuntime().platform.localStorage.setItem(CLI_DEBUG_MODE_STORAGE_KEY, String(enabled));
    } catch {
      // Best effort only.
    }
    onCliDebugModeChange?.(enabled);
    if (!enabled) {
      setDismissedClipboardDebugAt(clipboardDebug?.at ?? null);
    }
  }

  function terminalRoutingSummary(target: EventTarget | null | undefined): string {
    return describeTerminalRouting(
      target,
      typeof document !== "undefined" ? document.activeElement : null,
      xtermHostRef.current
    );
  }

  function markTerminalIntent() {
    lastTerminalIntentAtRef.current = Date.now();
    ensureTerminalControl(true);
  }

  function hasRecentTerminalIntent(nowMs = Date.now()): boolean {
    return nowMs - lastTerminalIntentAtRef.current <= TERMINAL_PASTE_RECENT_INTENT_MS;
  }

  function terminalContextMenuSelection(): { selection: string; appSelection: boolean } {
    const terminal = terminalRef.current;
    const selection = terminal?.getSelection?.() ?? "";
    if (selection) return { selection, appSelection: false };
    // While the CLI captures the mouse, its selection lives in the app, not in xterm.
    const mouseCaptured = (terminal?.modes?.mouseTrackingMode ?? "none") !== "none";
    const appSelection = mouseCaptured ? terminalAppSelectionRef.current : "";
    return { selection: appSelection, appSelection: Boolean(appSelection) };
  }

  function acceptTerminalAppClipboardWrite(text: string) {
    const host = xtermHostRef.current;
    if (!host || host.closest("[inert]")) return;
    if (!isVisibleRef.current || paneMinimizedRef.current || host.ownerDocument.visibilityState === "hidden") return;
    const activeElement = host.ownerDocument.activeElement;
    const terminalFocused = activeElement instanceof Node && host.contains(activeElement);
    if (!terminalFocused && !hasRecentTerminalIntent()) return;
    terminalAppSelectionRef.current = text;
    // Copy-on-select, like a native terminal. The context menu Copy covers a refused write.
    try {
      void getSpaceRuntime().platform.clipboard?.writeText(text).catch(() => undefined);
    } catch {
      // Clipboard access can throw synchronously in restricted contexts.
    }
  }

  function focusTerminal() {
    if (xtermHostRef.current?.closest("[inert]")) return;
    const terminal = terminalRef.current;
    terminal?.scrollToBottom();
    wasAtBottomRef.current = true;
    syncTerminalViewportEvidence(xtermHostRef.current, terminal);
    if (isTargetRef.current) {
      terminal?.focus();
    }
  }

  function clearScheduledTerminalRepaint() {
    if (scheduledTerminalRepaintFrameRef.current === null) return;
    window.cancelAnimationFrame(scheduledTerminalRepaintFrameRef.current);
    scheduledTerminalRepaintFrameRef.current = null;
  }

  function scheduleTerminalRepaint(terminal = terminalRef.current) {
    const geometryCoordinator = terminalGeometryCoordinatorRef.current;
    if (!terminal || !geometryCoordinator || typeof window === "undefined") return;
    if (
      !isVisibleRef.current ||
      paneMinimizedRef.current ||
      document.visibilityState === "hidden" ||
      !xtermHostRef.current?.isConnected
    ) {
      geometryCoordinator.syncVisibility();
      return;
    }
    if (scheduledTerminalRepaintFrameRef.current !== null) return;
    scheduledTerminalRepaintFrameRef.current = window.requestAnimationFrame(() => {
      scheduledTerminalRepaintFrameRef.current = null;
      if (
        !isVisibleRef.current ||
        paneMinimizedRef.current ||
        document.visibilityState === "hidden" ||
        terminalRef.current !== terminal ||
        terminal.rows <= 0
      ) {
        geometryCoordinator.syncVisibility();
        return;
      }
      const now = Date.now();
      if (now - lastTerminalOutputRefitAtRef.current >= TERMINAL_OUTPUT_REFIT_INTERVAL_MS) {
        lastTerminalOutputRefitAtRef.current = now;
        geometryCoordinator.repairIfBroken();
      }
    });
  }

  function recoverBrokenTerminalGeometry(): boolean {
    return terminalGeometryCoordinatorRef.current?.repairIfBroken() ?? false;
  }

  function scheduleTerminalRefit(options: TerminalRefitOptions = {}) {
    terminalGeometryCoordinatorRef.current?.requestRefit(options);
  }

  useEffect(() => clearScheduledTerminalRepaint, []);

  useEffect(() => {
    syncTerminalOutputVisibilityRef.current();
    if (isVisible) checkTerminalSocketHealth("reveal");
  }, [isVisible, pane.id, pane.isMinimized]);

  useEffect(() => {
    ensureTerminalControl(true);
    const coordinator = terminalGeometryCoordinatorRef.current;
    if (coordinator && isVisible) {
      coordinator.requestRefit({ reason: "LAYOUT_EFFECT" });
      if (wasAtBottomRef.current) {
        terminalRef.current?.scrollToBottom();
        const host = xtermHostRef.current;
        syncTerminalViewportEvidence(host, terminalRef.current);
      }
    }
  }, [pane.isMaximized, pane.columnSpan, isVisible]);

  useEffect(() => {
    if (!fullscreenLayout || isVisible) return;
    emitAppDiagnosticsPerformance({
      category: "PERFORMANCE",
      metric: "TERMINAL_FULLSCREEN",
      phase: "LAYOUT_CHANGED",
      roomId: pane.roomId,
      paneId: pane.id,
      value: 1
    });
    const applyBackgroundGeometry = (event: Event) => {
      const detail = (event as CustomEvent<{ cols: number; rows: number }>).detail;
      if (
        !detail ||
        !Number.isInteger(detail.cols) ||
        detail.cols <= 0 ||
        !Number.isInteger(detail.rows) ||
        detail.rows <= 0
      ) return;
      if (!fullscreenLayoutRef.current || isVisibleRef.current) return;
      const coordinator = terminalGeometryCoordinatorRef.current;
      if (!coordinator) {
        emitAppDiagnosticsPerformance({
          category: "PERFORMANCE",
          metric: "TERMINAL_FULLSCREEN",
          phase: "COORDINATOR_MISSING",
          roomId: pane.roomId,
          paneId: pane.id
        });
        return;
      }
      if (coordinator.backgroundResize(detail.cols, detail.rows)) {
        emitAppDiagnosticsPerformance({
          category: "PERFORMANCE",
          metric: "TERMINAL_FULLSCREEN",
          phase: "BACKGROUND_APPLIED",
          roomId: pane.roomId,
          paneId: pane.id,
          cols: detail.cols,
          rows: detail.rows
        });
        if (presizeInFullscreenRef.current) requestFullscreenPresize(detail.cols, detail.rows);
      }
    };
    window.addEventListener("space:fullscreen-geometry", applyBackgroundGeometry);
    const current = readFullscreenGeometry();
    if (current) {
      applyBackgroundGeometry(new CustomEvent("space:fullscreen-geometry", { detail: current }));
    } else {
      emitAppDiagnosticsPerformance({
        category: "PERFORMANCE",
        metric: "TERMINAL_FULLSCREEN",
        phase: "REGISTRY_EMPTY",
        roomId: pane.roomId,
        paneId: pane.id
      });
    }
    return () => window.removeEventListener("space:fullscreen-geometry", applyBackgroundGeometry);
  }, [fullscreenLayout, presizeInFullscreen, isVisible, pane.id]);

  useEffect(() => {
    if (!voiceAttachmentEligible || !voiceInput.settings.enabled || !voiceInput.serverSettings?.enabled) {
      voiceInput.cancel(voiceOwnerId, isTurnRunning ? "Voice input stopped because the CLI started a turn." : "Voice input stopped.");
    }
  }, [voiceAttachmentEligible, voiceInput.cancel, voiceInput.serverSettings?.enabled, voiceInput.settings.enabled, voiceOwnerId, isTurnRunning]);

  // Say why a recording ended without a transcript instead of letting it vanish.
  useEffect(() => {
    const cancelled = voiceInput.cancelNotice;
    if (!cancelled || cancelled.ownerId !== voiceOwnerId) return;
    voiceInput.clearCancelNotice();
    setNotice(cancelled.message);
  }, [voiceInput.cancelNotice, voiceInput.clearCancelNotice, voiceOwnerId]);

  useEffect(() => () => voiceInput.cancel(voiceOwnerId), [voiceInput.cancel, voiceOwnerId]);

  useEffect(() => {
    if (hiddenWarmSocketParkTimerRef.current !== null) {
      window.clearTimeout(hiddenWarmSocketParkTimerRef.current);
      hiddenWarmSocketParkTimerRef.current = null;
    }

    const unparkHiddenWarmSocket = () => {
      if (!intentionalSocketParkRef.current) return;
      intentionalSocketParkRef.current = false;
      if (xtermHostRef.current) delete xtermHostRef.current.dataset.terminalSocketParked;
      void api.activeCliSession(pane.id, { includeTranscript: false })
        .then((activeSession) => {
          if (!activeSession || !isRecoverableCliSession(activeSession.session) || !activeSession.websocket) {
            return;
          }
          // Fresh ticket re-opens the socket effect while the room layer stays warm.
          setSessionResponse(activeSession);
          setTerminalStatus("connecting");
        })
        .catch(() => {
          // Best-effort reattach; user can still use explicit reconnect.
        });
    };

    if (isVisible && intentionalSocketParkRef.current) {
      unparkHiddenWarmSocket();
      return;
    }

    const socket = socketRef.current;
    const shouldPark = shouldParkHiddenWarmSocket({
      prefillEnabled: prefillInitialReplay,
      prefillReady: terminalPrefillReady,
      isVisible,
      isMinimized: pane.isMinimized,
      documentHidden: typeof document !== "undefined" && document.visibilityState === "hidden",
      hasOpenSocket: Boolean(socket && socket.readyState === WebSocket.OPEN),
      alreadyParked: intentionalSocketParkRef.current
    });
    if (!shouldPark) return;

    hiddenWarmSocketParkTimerRef.current = window.setTimeout(() => {
      hiddenWarmSocketParkTimerRef.current = null;
      const liveSocket = socketRef.current;
      if (
        !shouldParkHiddenWarmSocket({
          prefillEnabled: prefillInitialReplayRef.current,
          prefillReady: terminalPrefillReady,
          isVisible: isVisibleRef.current,
          isMinimized: paneMinimizedRef.current,
          documentHidden: typeof document !== "undefined" && document.visibilityState === "hidden",
          hasOpenSocket: Boolean(liveSocket && liveSocket.readyState === WebSocket.OPEN),
          alreadyParked: intentionalSocketParkRef.current
        })
      ) {
        return;
      }
      intentionalSocketParkRef.current = true;
      releaseTerminalControl();
      liveSocket?.close();
    }, HIDDEN_WARM_SOCKET_PARK_MS);

    return () => {
      if (hiddenWarmSocketParkTimerRef.current !== null) {
        window.clearTimeout(hiddenWarmSocketParkTimerRef.current);
        hiddenWarmSocketParkTimerRef.current = null;
      }
    };
  }, [isVisible, pane.id, pane.isMinimized, prefillInitialReplay, terminalPrefillReady]);

  useEffect(() => {
    if (typeof window === "undefined" || typeof document === "undefined" || !sessionResponse?.websocket) return;
    const repairTerminalAfterBrowserResume = () => {
      lastTerminalOutputRefitAtRef.current = 0;
      syncTerminalOutputVisibilityRef.current();
    };
    window.addEventListener("focus", repairTerminalAfterBrowserResume);
    window.addEventListener("pageshow", repairTerminalAfterBrowserResume);
    document.addEventListener("visibilitychange", repairTerminalAfterBrowserResume);
    window.addEventListener("space:app-resumed", repairTerminalAfterBrowserResume);
    return () => {
      window.removeEventListener("focus", repairTerminalAfterBrowserResume);
      window.removeEventListener("pageshow", repairTerminalAfterBrowserResume);
      document.removeEventListener("visibilitychange", repairTerminalAfterBrowserResume);
      window.removeEventListener("space:app-resumed", repairTerminalAfterBrowserResume);
    };
  }, [pane.id, sessionResponse?.websocket]);

  async function waitForTerminalSocketOpen(sessionId: string, timeoutMs = 2_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const currentSession = sessionResponseRef.current;
      const socket = socketRef.current;
      if (
        currentSession?.session.sessionId === sessionId &&
        socket?.readyState === WebSocket.OPEN &&
        readySocketRef.current?.socket === socket &&
        readySocketRef.current.sessionId === sessionId
      ) {
        return true;
      }
      await new Promise((resolve) => window.setTimeout(resolve, 25));
    }
    return false;
  }

  function buildMemorySaveBody(input: { paneTitle: string; modelId: string; commandText: string; transcript: string }): string {
    const transcript = input.transcript.trim() || "(no terminal transcript captured)";
    const body = [
      `CLI pane: ${input.paneTitle}`,
      `Model: ${input.modelId}`,
      `Command: ${input.commandText}`,
      "",
      "Recent terminal transcript:",
      transcript
    ].join("\n");
    return body.length <= 10_000 ? body : `${body.slice(0, 9_997).trimEnd()}...`;
  }

  async function reportClipboardDebug(entry: ClipboardDebugState, history: ClipboardDebugState[]) {
    if (sessionResponseRef.current?.session.purpose === "LOGIN") return;
    const key = `${entry.severity}:${entry.title}:${entry.detail}`;
    const now = Date.now();
    const last = lastClipboardReportRef.current;
    if (last && last.key === key && now - last.atMs < 1_500) return;
    lastClipboardReportRef.current = { key, atMs: now };
    try {
      const clipboard = getSpaceRuntime().platform.clipboard;
      await api.reportCliClipboardDebug({
        paneId: pane.id,
        severity: entry.severity,
        title: entry.title,
        detail: entry.detail,
        trace: history.map((item) => ({
          severity: item.severity,
          title: item.title,
          detail: item.detail,
          at: item.at
        })),
        sessionId: sessionResponseRef.current?.session.sessionId ?? null,
        url: typeof window !== "undefined" ? window.location.href : null,
        userAgent: typeof navigator !== "undefined" ? navigator.userAgent : null,
        activeElement: typeof document !== "undefined" ? describeEventTarget(document.activeElement) : null,
        documentHasFocus: typeof document !== "undefined" ? document.hasFocus() : false,
        visibilityState: typeof document !== "undefined" ? document.visibilityState : null,
        clipboardApi: {
          read: Boolean(clipboard?.read),
          readText: Boolean(clipboard?.readText),
          write: Boolean(clipboard?.write),
          writeText: Boolean(clipboard?.writeText)
        }
      });
    } catch (error) {
      if (showCliDebugMode) {
        console.warn("space clipboard debug report failed", error);
      }
    }
  }

  function sendTerminalInput(
    data: string,
    source = "terminal input",
    display: "visible" | "hidden" = "visible",
    preserveNotice = false,
    options: { turnMarker?: string; trackDraft?: boolean } = {}
  ): boolean {
    const socket = socketRef.current;
    const session = sessionResponseRef.current?.session;
    const terminalData =
      session?.purpose === "NORMAL" && session.runtimeId === DEFAULT_CLI_RUNTIME_ID
        ? data.replaceAll("\0", "")
        : data;
    if (!terminalData) return true;

    const MAX_TERMINAL_INPUT_CHUNK_LENGTH = 12_000;
    if (terminalData.length > MAX_TERMINAL_INPUT_CHUNK_LENGTH) {
      let success = true;
      let start = 0;
      while (start < terminalData.length) {
        let end = Math.min(start + MAX_TERMINAL_INPUT_CHUNK_LENGTH, terminalData.length);
        if (end < terminalData.length && /[\uD800-\uDBFF]/.test(terminalData[end - 1]!)) {
          end -= 1;
        }
        const chunk = terminalData.slice(start, end);
        const isLast = end >= terminalData.length;
        const chunkOptions = {
          ...options,
          turnMarker: isLast ? options.turnMarker : undefined,
          trackDraft: isLast ? options.trackDraft : false
        };
        const chunkSent = sendTerminalInput(chunk, source, display, preserveNotice, chunkOptions);
        if (!chunkSent) {
          success = false;
          break;
        }
        start = end;
      }
      return success;
    }
    const sessionId = session?.sessionId;
    const wireDisplay =
      session?.purpose === "LOGIN" ? "hidden" : display;
    if (
      !socket ||
      !sessionId ||
      socket.readyState !== WebSocket.OPEN ||
      readySocketRef.current?.socket !== socket ||
      readySocketRef.current.sessionId !== sessionId
    ) {
      if (session && isRecoverableCliSession(session)) {
        const queuedBytes = pendingTerminalInputsRef.current.reduce(
          (total, pendingInput) => total + pendingInput.data.length,
          0
        );
        if (terminalPendingInputAdmission({ length: pendingTerminalInputsRef.current.length, queuedBytes }, terminalData.length)) {
          pendingTerminalInputsRef.current.push({ data: terminalData, source, display, preserveNotice, options });
          setNotice("CLI connection was lost. Reconnecting\u2026");
          triggerTerminalSocketRecovery("user-input");
          return true;
        }
        setError("CLI connection was lost. Retry this input after the terminal reconnects.");
        updateClipboardDebug("bad", "send failed", `${source}: CLI WebSocket is not open and the pending input queue is full; inputLength=${terminalData.length}.`);
        // The queue is full so this input is dropped - but never leave the pane dead:
        // keep the reconnect machinery running while the user keeps typing.
        triggerTerminalSocketRecovery("user-input-queue-full");
        return false;
      }
      setError("Attach a running CLI before pasting into it.");
      updateClipboardDebug("bad", "send failed", `${source}: CLI WebSocket is not open; inputLength=${terminalData.length}.`);
      return false;
    }
    const control = terminalControlRef.current;
    if (control.protocolVersion === 2 && (control.state !== "CONTROLLER" || !control.leaseId)) {
      if (!canRequestTerminalControl(true)) {
        if (sessionResponseRef.current?.websocket?.proofScope === "READ_ONLY") {
          setNotice("This terminal is live read-only in the current page.");
        } else {
          setNotice("This terminal cannot receive input right now.");
        }
        return false;
      }
      const queuedBytes = pendingTerminalInputsRef.current.reduce(
        (total, pendingInput) => total + pendingInput.data.length,
        0
      );
      if (!terminalPendingInputAdmission({ length: pendingTerminalInputsRef.current.length, queuedBytes }, terminalData.length)) {
        setError("Terminal control is changing. Retry this input after the pane becomes active.");
        return false;
      }
      pendingTerminalInputsRef.current.push({ data: terminalData, source, display, preserveNotice, options });
      ensureTerminalControl(true);
      return true;
    }
    if (wireDisplay === "hidden") {
      registerHiddenTerminalInput(terminalData);
    }
    socket.send(
      JSON.stringify({
        type: "input",
        data: terminalData,
        ...(wireDisplay === "hidden" ? { display: wireDisplay } : {}),
        ...(options.turnMarker ? { turnMarker: options.turnMarker } : {}),
        ...(control.protocolVersion === 2 ? { leaseId: control.leaseId } : {})
      })
    );
    if (control.protocolVersion === 2 && source !== "terminal protocol response") {
      lastTerminalControlMutationRef.current = {
        socket,
        record: { data: terminalData, source, display, preserveNotice, options, leaseId: control.leaseId, sentAtMs: Date.now() }
      };
    }
    if (wireDisplay === "visible") {
      armModelSettingsOutputRefresh(terminalData, socket, sessionId, terminalRef.current);
    }
    if (wireDisplay === "visible" && options.trackDraft !== false) {
      const previousDraft = terminalPromptDraftRef.current;
      const nextDraft = nextTerminalPromptDraft(previousDraft, terminalData);
      const trackedDraft = nextDraft ?? { text: "", cursor: 0 };
      terminalPromptDraftRef.current = trackedDraft;

      const hadText = Boolean(previousDraft.text.trim());
      const hasText = Boolean(trackedDraft.text.trim());
      const promptWasCleared =
        terminalData.includes("\u0015") ||
        (nextDraft !== null && Boolean(previousDraft.text) && !trackedDraft.text);

      if (promptWasCleared || hadText !== hasText || isTerminalSubmitInput(terminalData)) {
        if (terminalPromptDraftDebounceTimerRef.current !== null) {
          window.clearTimeout(terminalPromptDraftDebounceTimerRef.current);
          terminalPromptDraftDebounceTimerRef.current = null;
        }
        setTerminalPromptDraft(trackedDraft.text);
      } else {
        if (terminalPromptDraftDebounceTimerRef.current !== null) {
          window.clearTimeout(terminalPromptDraftDebounceTimerRef.current);
        }
        terminalPromptDraftDebounceTimerRef.current = window.setTimeout(() => {
          terminalPromptDraftDebounceTimerRef.current = null;
          setTerminalPromptDraft(terminalPromptDraftRef.current.text);
        }, 120);
      }

      if (!isTerminalSubmitInput(terminalData) && promptWasCleared) {
        // A Ctrl+U rewrite (layout fix, prompt variables) retypes the labels it keeps.
        const kept = managedPromptAttachmentsRef.current.pending.filter((attachment) => trackedDraft.text.includes(attachment.token));
        managedPromptAttachmentsRef.current = kept.length
          ? { ...managedPromptAttachmentsRef.current, pending: kept }
          : { imageCount: 0, videoCount: 0, fileCount: 0, pending: [] };
      }
      // Input the draft model cannot follow (arrows, Tab, Alt keys) keeps pending labels;
      // submit confirms them against the visible prompt instead of dropping their paths.
    }
    if (options.turnMarker) {
      if (session?.purpose === "NORMAL" && isTurnCapableRuntime(session.runtimeId)) {
        const nextTurn = { marker: options.turnMarker, status: "PENDING" as const };
        setActiveCliTurn(nextTurn);
        storeActiveCliTurn(pane.id, sessionId, nextTurn);
      }
      publishPaneRunLifecycle({
        roomId: pane.roomId,
        paneId: pane.id,
        runKey: options.turnMarker,
        status: "STARTED"
      });
      if (session?.purpose === "NORMAL" && !isTurnCapableRuntime(session.runtimeId)) {
        armFallbackRunWatcher(options.turnMarker);
      }
    }
    if (!preserveNotice) setNotice(null);
    if (shouldRefocusTerminalAfterInput(terminalData)) focusTerminal();
    return true;
  }

  function sendTerminalSubmit(
    data: string,
    source: string,
    options: { turnMarker?: string } = {}
  ): boolean {
    const attachmentState = managedPromptAttachmentsRef.current;
    const visiblePrompt = attachmentState.pending.length
      ? visibleTerminalPromptText(terminalRef.current)
      : "";
    const activeAttachments = attachmentState.pending.filter((attachment) =>
      terminalPromptDraftRef.current.text.includes(attachment.token) ||
      data.includes(attachment.token) ||
      visiblePrompt.includes(attachment.token.replace(/\s+/g, ""))
    );
    if (activeAttachments.length) {
      const hiddenPaths = ` ${activeAttachments.map((attachment) => attachment.terminalInputPath).join(" ")} `;
      if (!sendTerminalInput(hiddenPaths, `${source}: attachment paths`, "hidden", true, { trackDraft: false })) {
        return false;
      }
      updateClipboardDebug(
        "good",
        "attachment paths resolved",
        `${source}: tokenCount=${activeAttachments.length}; insertedPathLength=${hiddenPaths.length}; display=hidden; containsUploadPath=true.`
      );
    }
    if (promptVariablesSettings.enabled && promptVariablesSettings.autoExpandOnSubmit) {
      const currentDraft = terminalPromptDraftRef.current.text;
      if (currentDraft && promptVariables.length) {
        const expanded = expandPromptVariables(currentDraft, promptVariables, { autoUnescape: true });
        if (expanded !== currentDraft) {
          sendTerminalInput(`\u0015${expanded}`, "auto expand prompt variables", "visible", true);
        }
      }
    }
    const sent = sendTerminalInput(data, source, "visible", false, options);
    if (sent) {
      managedPromptAttachmentsRef.current = { imageCount: 0, videoCount: 0, fileCount: 0, pending: [] };
      wasAtBottomRef.current = true;
      terminalRef.current?.scrollToBottom();
      const host = xtermHostRef.current;
      syncTerminalViewportEvidence(host, terminalRef.current);
    }
    return sent;
  }

  async function runCliShortcut(command: OskCliCommand) {
    if (shortcutPendingRef.current) return;
    if (command.id === "scroll_top" || command.action === "scroll_top") {
      const terminal = terminalRef.current;
      if (terminal) {
        terminal.scrollToTop();
        wasAtBottomRef.current = false;
        syncTerminalViewportEvidence(xtermHostRef.current, terminal);
      }
      if (transcriptRef.current) {
        transcriptRef.current.scrollTop = 0;
      }
      return;
    }
    if (command.id === "scroll_bottom" || command.action === "scroll_bottom") {
      const terminal = terminalRef.current;
      if (terminal) {
        terminal.scrollToBottom();
        wasAtBottomRef.current = true;
        syncTerminalViewportEvidence(xtermHostRef.current, terminal);
        if (isTargetRef.current) {
          terminal.focus();
        }
      }
      if (transcriptRef.current) {
        transcriptRef.current.scrollTop = transcriptRef.current.scrollHeight;
      }
      return;
    }
    const identity = sessionResponseRef.current?.session;
    const socket = socketRef.current;
    if (!identity || identity.purpose !== "NORMAL" || !socket) return;
    // Claude reaches Plan with Shift+Tab, which keeps the draft; "/plan" would be typed into it.
    if (command.action === "plan" && identity.runtimeId === CLAUDE_CLI_RUNTIME_ID) {
      window.dispatchEvent(new CustomEvent(TERMINAL_PANE_ACTION_EVENT, { detail: { paneId: pane.id, action: "ensure_plan_mode" } }));
      return;
    }
    const isCurrent = () => shortcutLiveRef.current && isVisibleRef.current && !paneMinimizedRef.current &&
      sessionResponseRef.current?.session.sessionId === identity.sessionId && socketRef.current === socket &&
      readySocketRef.current?.socket === socket && socket.readyState === WebSocket.OPEN;
    shortcutPendingRef.current = true;
    setShortcutPending(true);
    try {
      if (command.id === "transcript") {
        const transcript = cliTranscriptCommand(identity.runtimeId);
        if (!transcript || !isCurrent()) return;
        if (!sendTerminalInput(transcript.text, "CLI full transcript", "visible", false, { trackDraft: false })) {
          throw new Error("Full transcript shortcut could not be sent.");
        }
        if (isCurrent()) focusTerminal();
        return;
      }
      if (command.id === "esc") {
        sendTerminalInput("\u001b", "CLI shortcut Esc");
        if (isCurrent()) focusTerminal();
        return;
      }
      if (command.id === "enter") {
        const actionSession = sessionResponseRef.current?.session;
        const turnMarker =
          isRunCapableCliSession(actionSession)
            ? createCliTurnMarker()
            : undefined;
        sendTerminalSubmit("\r", "CLI shortcut Enter", { turnMarker });
        if (isCurrent()) focusTerminal();
        return;
      }
      if (command.action) {
        setNotice(null);
        setError(null);
        if (!isCurrent()) throw new Error("CLI connection or room changed. Shortcut cancelled.");
        // Claude leaves Plan with Shift+Tab, which works mid-turn and keeps the draft.
        const claudeModeCycle = command.action === "build" && identity.runtimeId === CLAUDE_CLI_RUNTIME_ID;
        if (isTurnRunning && !claudeModeCycle) throw new Error("Wait for the current CLI turn to finish before changing modes.");
        if (command.action === "build" && identity.runtimeId === "cli:hermes" && terminalPromptDraftRef.current.text.trim() === "/plan") {
          if (!sendTerminalInput("\u0015", "Clear Hermes planning prefix")) throw new Error("Planning prefix could not be cleared.");
        }
        if (terminalPromptDraftRef.current.text.trim() && !claudeModeCycle) throw new Error("Send or clear the current CLI draft before changing modes.");
        if (command.action === "build") {
          await returnCliToBuildMode(identity.runtimeId, {
            screen: () => terminalRef.current ? terminalCurrentScreenText(terminalRef.current) : "",
            isCurrent,
            write: text => sendTerminalInput(text, "CLI Build mode", "visible", false, { trackDraft: false }),
            submit: text => submitCliShortcut({ ...command, text, enter: true }, {
              isCurrent, runtimeId: identity.runtimeId, prepare: async () => {},
              write: value => sendTerminalInput(value, "CLI Build mode"),
              enter: () => sendTerminalInput("\r", "CLI Build mode enter")
            }),
            sleep: ms => new Promise(resolve => setTimeout(resolve, ms))
          });
          setNotice("Build mode is ready. Send a task to continue.");
          return;
        }
        const native = resolveCliModeShortcut(identity.runtimeId, command.action);
        if ("unavailable" in native) throw new Error(native.unavailable);
        if (native.prefix) {
          if (!sendTerminalInput(native.prefix, "CLI permissions palette", "visible", false, { trackDraft: false })) throw new Error("CLI permissions palette could not be opened.");
          await new Promise<void>(resolve => setTimeout(resolve, 250));
          if (!isCurrent()) throw new Error("CLI connection or room changed. Shortcut cancelled.");
        }
        if (!native.enter) {
          if (!sendTerminalInput(native.text, "CLI mode shortcut", "visible", false, { trackDraft: identity.runtimeId === "cli:hermes" && command.action === "plan" })) throw new Error("CLI mode key could not be sent.");
          return;
        }
        await submitCliShortcut({ ...command, text: native.text, enter: true }, {
          isCurrent, runtimeId: identity.runtimeId, prepare: async () => {},
          write: text => sendTerminalInput(text, "CLI mode shortcut"),
          enter: () => sendTerminalInput("\r", "CLI mode shortcut enter")
        });
        return;
      }
      await submitCliShortcut(command, {
        isCurrent,
        runtimeId: identity.runtimeId,
        prepare: async () => {
          if (command.id !== "memory") return;
          if (identity.runtimeId === OPENCODE_CLI_RUNTIME_ID || !isCliModelSettingsRuntime(identity.runtimeId)) return;
          try {
            const status = await api.cliModelSettingsStatus(pane.id);
            if (!isCurrent()) throw new Error("CLI changed before the shortcut could be sent.");
            if (status.status === "UNAVAILABLE" || !status.settings.current || status.settings.sessionId !== identity.sessionId) {
              throw new Error("Current model settings are unavailable. Save to memory was not sent.");
            }
            const current = status.settings.current;
            const model = status.settings.models.find((entry) => entry.id === current.modelId);
            if (!model?.supportedReasoningEfforts.includes("low")) {
              throw new Error("The current model does not support Low reasoning. Save to memory was not sent.");
            }
            if (current.reasoningEffort !== "low") {
              const result = await handleModelSwitch(current.modelId, "low", null, false);
              if (result.current?.modelId !== current.modelId || result.current?.reasoningEffort !== "low" || result.pending) {
                throw new Error("Low reasoning was not confirmed. Save to memory was not sent.");
              }
            }
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (message.includes("CLI changed before the shortcut could be sent")) {
              throw error;
            }
            // All CLI shortcuts must remain usable. Low switch is best-effort: transient
            // native-picker state, unavailable settings, API validation or missing Low support
            // must not block "save to memory" itself. Fall back to sending with current reasoning.
            return;
          }
        },
        write: (text) => sendTerminalInput(text, "CLI shortcut"),
        enter: () => sendTerminalSubmit("\r", "CLI shortcut enter", {
          turnMarker: isRunCapableCliSession(identity) ? createCliTurnMarker() : undefined
        })
      });
      if (isCurrent()) focusTerminal();
    } catch (error) {
      if (shortcutLiveRef.current) setError(error instanceof Error ? error.message : "CLI shortcut failed.");
    } finally {
      shortcutPendingRef.current = false;
      if (shortcutLiveRef.current) setShortcutPending(false);
    }
  }

  async function handleSelectOpenPlan(plan: ClipboardItem) {
    setNotice(null);
    if (terminalStatus !== "attached") {
      setError("Attach a running CLI before sending a plan to it.");
      return;
    }
    const session = sessionResponseRef.current?.session;
    const planTitle = plan.title?.trim();

    // Routing returns before every legacy path for Codex, including failed starts.
    await routePanePlanSelection(session?.runtimeId, async () => {
      try {
        await managedPlan.start(plan);
        if (sessionResponseRef.current?.session.sessionId !== session?.sessionId || !isVisibleRef.current) return;
        setNotice(`Started plan: ${planTitle || "Untitled"}`);
      } catch (failure) {
        if (sessionResponseRef.current?.session.sessionId !== session?.sessionId || !isVisibleRef.current) return;
        setError(failure instanceof Error ? failure.message : "Managed plan could not be started. Complete its stage configuration and retry.");
      }
    }, submitLegacyPlan);

    async function submitLegacyPlan() {
      if (typeof window !== "undefined") {
        try {
          localStorage.setItem(`space_active_plan_${pane.id}`, plan.id);
          window.dispatchEvent(new CustomEvent(SPACE_CLIPBOARD_UPDATED_EVENT));
        } catch {}
      }
      void api.updatePlanProgress?.(plan.id, {
        executionStatus: "IN_PROGRESS",
        paneId: pane.id,
        roomId: pane.roomId,
        paneTitle: pane.paneName ?? pane.title ?? undefined
      } as any).catch(() => {});

      if (terminalPromptDraftRef.current.text.trim()) {
        sendTerminalInput("\u0015", "clear draft before plan submit", "visible", true, { trackDraft: true });
      }

      try {
        const asciiSlug = (planTitle || "").toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
        const filename = `plan-${asciiSlug || plan.id.replace(/[^a-zA-Z0-9_-]/g, "_")}.md`;
        const planContent = formatPlanAttachment(plan);
        const file = new File([planContent], filename, { type: "text/markdown" });

        const uploaded = await api.uploadCliFiles({ paneId: pane.id, source: "CLIPBOARD", files: [file] });
        const uploadedFile = uploaded.files[0];
        if (!uploadedFile) throw new Error("Plan file upload returned no file.");

        const previous = managedPromptAttachmentsRef.current;
        const nextFileCount = previous.fileCount + 1;
        const token = `[File #${nextFileCount}]`;
        const attachmentPath = terminalInputPath(uploadedFile);

        managedPromptAttachmentsRef.current = {
          ...previous,
          fileCount: nextFileCount,
          pending: [
            ...previous.pending,
            { token, terminalInputPath: attachmentPath }
          ]
        };

        const instruction = planTitle
          ? `Implement the following plan: ${token} ("${planTitle}")\nPlan ID: ${plan.id}`
          : `Implement the following plan: ${token}\nPlan ID: ${plan.id}`;

        const turnMarker = isRunCapableCliSession(session) ? createCliTurnMarker() : undefined;
        const sent = sendTerminalSubmit(`${instruction}\r`, "cli open plan select", {
          ...(turnMarker ? { turnMarker } : {})
        });
        updateClipboardDebug(
          sent ? "good" : "bad",
          "open plan execution submit",
          `selected plan ${plan.id}; title=${planTitle || "Untitled"}; token=${token}; charCount=${plan.text.trim().length}; autoStart=true.`
        );
        if (sent) {
          setNotice(`Sent plan: ${planTitle || "Untitled"}`);
          focusTerminal();
        } else {
          setError("Attach a running CLI before sending a plan to it.");
        }
      } catch {
        // Fallback to direct text submit if file upload is unavailable
        const instruction = `Implement the following plan:\n\n${formatPlanAttachment(plan)}`;
        const turnMarker = isRunCapableCliSession(session) ? createCliTurnMarker() : undefined;
        const payload = `${BRACKETED_PASTE_START}${instruction}${BRACKETED_PASTE_END}\r`;
        const sent = sendTerminalSubmit(payload, "cli open plan select fallback", {
          ...(turnMarker ? { turnMarker } : {})
        });
        if (sent) {
          setNotice(`Sent plan: ${planTitle || "Untitled"}`);
          focusTerminal();
        } else {
          setError("Attach a running CLI before sending a plan to it.");
        }
      }
    }
  }

  // Uploads the plan as a file and puts its reference into the prompt without Enter, keeping any draft.
  async function handleInsertOpenPlan(plan: ClipboardItem) {
    setNotice(null);
    if (terminalStatus !== "attached") {
      setError("Attach a running CLI before inserting a plan into it.");
      return;
    }
    const planTitle = plan.title?.trim();
    try {
      localStorage.setItem(`space_active_plan_${pane.id}`, plan.id);
    } catch {}
    void api.updatePlanProgress?.(plan.id, {
      paneId: pane.id,
      roomId: pane.roomId,
      paneTitle: pane.paneName ?? pane.title ?? undefined
    } as any).catch(() => {});

    let inserted = false;
    try {
      const asciiSlug = (planTitle || "").toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
      const filename = `plan-${asciiSlug || plan.id.replace(/[^a-zA-Z0-9_-]/g, "_")}.md`;
      const file = new File([formatPlanAttachment(plan)], filename, { type: "text/markdown" });
      const uploaded = await api.uploadCliFiles({ paneId: pane.id, source: "CLIPBOARD", files: [file] });
      const uploadedFile = uploaded.files[0];
      if (!uploadedFile) throw new Error("Plan file upload returned no file.");
      const previous = managedPromptAttachmentsRef.current;
      const token = `[File #${previous.fileCount + 1}]`;
      // One line, so no TUI treats a newline as Enter; the token resolves to the file on submit.
      const reference = planTitle
        ? `Implement the following plan: ${token} ("${planTitle}") Plan ID: ${plan.id} `
        : `Implement the following plan: ${token} Plan ID: ${plan.id} `;
      inserted = sendTerminalInput(reference, "cli open plan insert", "visible", true, { trackDraft: true });
      if (inserted) {
        managedPromptAttachmentsRef.current = {
          ...previous,
          fileCount: previous.fileCount + 1,
          pending: [...previous.pending, { token, terminalInputPath: terminalInputPath(uploadedFile) }]
        };
      }
    } catch {
      const instruction = `Implement the following plan:\n\n${formatPlanAttachment(plan)}`.replace(/\r?\n/g, "\r");
      inserted = sendTerminalInput(`${BRACKETED_PASTE_START}${instruction}${BRACKETED_PASTE_END}`, "cli open plan insert fallback", "visible", true, { trackDraft: true });
    }
    updateClipboardDebug(
      inserted ? "good" : "bad",
      "open plan insert",
      `selected plan ${plan.id}; title=${planTitle || "Untitled"}; autoStart=false.`
    );
    if (inserted) {
      setNotice(`Inserted plan: ${planTitle || "Untitled"}. Press Enter to send it.`);
      focusTerminal();
    } else {
      setError("Attach a running CLI before inserting a plan into it.");
    }
  }

  // Only the non-managed path clears typed text before sending; Codex starts a managed plan instead.
  function planSendClearsDraft(): boolean {
    return !usesManagedPlanExecution(sessionResponseRef.current?.session.runtimeId) && Boolean(terminalPromptDraftRef.current.text.trim());
  }

  function submitVoiceTranscript(transcript: string): boolean {
    const session = sessionResponseRef.current?.session;
    const voiceSubmit = buildTerminalVoiceSubmit(
      transcript,
      terminalPromptDraftRef.current.text,
      voiceInput.settings.insertMode
    );
    if (!voiceSubmit || session?.purpose !== "NORMAL" || !session.isActive) return false;
    const options = isRunCapableCliSession(session)
      ? { turnMarker: createCliTurnMarker() }
      : {};
    if (voiceSubmit.replace) {
      managedPromptAttachmentsRef.current = { imageCount: 0, videoCount: 0, fileCount: 0, pending: [] };
      if (!sendTerminalInput(voiceSubmit.data, "voice transcript replace", "visible", true)) return false;
    } else if (!sendTerminalInput(voiceSubmit.data, "voice transcript append", "visible", true)) {
      return false;
    }
    return sendTerminalSubmit(voiceSubmit.enter, "voice transcript enter", options);
  }

  function toggleTerminalVoiceCapture() {
    if (voiceOwned && voiceInput.status === "recording") {
      voiceInput.stop(voiceOwnerId);
      return;
    }
    void voiceInput.start({
      id: voiceOwnerId,
      onTranscriptDelta: () => {
        // Live transcript preview is tracked by VoiceInputProvider and reflected in voiceStatusText
      },
      onTranscriptComplete: (transcript) => {
        if (!submitVoiceTranscript(transcript)) {
          throw new Error("Voice transcript could not be sent to this CLI pane.");
        }
      }
    });
  }

  function applyTerminalLayoutFix() {
    const draft = terminalPromptDraftRef.current.text || terminalPromptDraft;
    if (!draft.trim()) return;
    dismissedTerminalLayoutTextRef.current = null;
    const detection = detectKeyboardLayoutMismatch(draft);
    const replacement = (detection.hasMismatch && detection.direction === "toGreek")
      ? detection.convertedText
      : toggleKeyboardLayout(draft);
    if (replacement && replacement !== draft) {
      sendTerminalInput(`\u0015${replacement}`, "terminal layout fix", "visible", true);
      setTerminalLayoutSuggestion(null);
      focusTerminal();
    }
  }

  function insertManagedPromptAttachments(
    files: PaneCliUploadedFile[],
    source: string,
    attachmentNotice: string
  ): boolean {
    const previous = managedPromptAttachmentsRef.current;
    let imageCount = previous.imageCount;
    let videoCount = previous.videoCount;
    let fileCount = previous.fileCount;
    const attachments = files.map((file) => {
      if (file.isImage) {
        return {
          token: `[Image #${++imageCount}]`,
          terminalInputPath: terminalInputPath(file)
        };
      }
      const isVideo = isVideoUpload(file);
      const number = isVideo ? ++videoCount : ++fileCount;
      return {
        token: `[${isVideo ? "Video" : "File"} #${number}]`,
        terminalInputPath: terminalInputPath(file)
      };
    });
    const sent = sendTerminalInput(
      `${attachments.map((attachment) => attachment.token).join(" ")} `,
      `${source}: attachment labels`
    );
    if (!sent) return false;
    managedPromptAttachmentsRef.current = {
      imageCount,
      videoCount,
      fileCount,
      pending: [...previous.pending, ...attachments]
    };
    setNotice(attachmentNotice);
    return true;
  }

  // A lease denial re-queues the input this socket just sent with that lease
  // (once per helper budget) instead of dropping it; the grant flush resends it.
  function replayDeniedTerminalInput(code: string, socket: WebSocket, deniedLeaseId: string | null) {
    const recorded = lastTerminalControlMutationRef.current;
    const record = recorded?.socket === socket && recorded.record.leaseId === deniedLeaseId ? recorded.record : null;
    const nowMs = Date.now();
    const replayBudget = terminalControlReplayBudgetRef.current;
    if (!record || terminalControlDenialReplay({ code, record, nowMs, replayBudget }) !== "REPLAY") return;
    const queuedBytes = pendingTerminalInputsRef.current.reduce((total, pendingInput) => total + pendingInput.data.length, 0);
    if (!terminalPendingInputAdmission({ length: pendingTerminalInputsRef.current.length, queuedBytes }, record.data.length)) return;
    lastTerminalControlMutationRef.current = null;
    terminalControlReplayBudgetRef.current = nextTerminalControlReplayBudget(replayBudget, nowMs);
    pendingTerminalInputsRef.current.push({
      data: record.data,
      source: `${record.source}: control replay`,
      display: record.display,
      preserveNotice: record.preserveNotice,
      // The draft model already applied this input when it was first sent.
      options: { ...record.options, trackDraft: false }
    });
    setNotice(TERMINAL_CONTROL_REPLAY_NOTICE);
    ensureTerminalControl(true);
  }

  function flushPendingTerminalInputs() {
    if (
      terminalControlRef.current.protocolVersion === 2 &&
      (terminalControlRef.current.state !== "CONTROLLER" || !terminalControlRef.current.leaseId)
    ) return;
    const pendingInputs = pendingTerminalInputsRef.current.splice(0);
    for (const pendingInput of pendingInputs) {
      sendTerminalInput(
        pendingInput.data,
        pendingInput.source,
        pendingInput.display,
        pendingInput.preserveNotice,
        pendingInput.options
      );
    }
  }

  function stopRunningCliTurn(source: string) {
    if (isOpenCodeCliSession) {
      void abortOpenCodeTurn();
      return;
    }
    const sent = sendTerminalInput(
      floatingTurnPauseSequence(sessionResponse?.session.runtimeId ?? null),
      source,
      "visible",
      true,
      { trackDraft: false }
    );
    if (sent) {
      if (activeTurnMarker) {
        publishPaneRunLifecycle({
          roomId: pane.roomId,
          paneId: pane.id,
          runKey: activeTurnMarker,
          status: "FAILED"
        });
      }
      clearStoredActiveCliTurn(pane.id);
      setActiveCliTurn(null);
      setModelSettings((current) => current ? { ...current, isTurnActive: false } : current);
      setTerminalScreenRunning(false);
      terminalScreenRunningRef.current = false;
      finishFallbackRun(null, "FAILED");
    }
  }

  // One interrupt cooldown for every Stop entry point (pane menu and floating button), so two
  // quick Stops never send two interrupts (Ctrl+C twice exits most CLIs).
  function startStopCooldown() {
    setStopCooldown(true);
    if (stopCooldownTimerRef.current !== null) window.clearTimeout(stopCooldownTimerRef.current);
    stopCooldownTimerRef.current = window.setTimeout(() => {
      stopCooldownTimerRef.current = null;
      setStopCooldown(false);
    }, STOP_COOLDOWN_MS);
  }

  function handleTurnControlClick() {
    if (turnStopPending) return;
    if (isTurnRunning) {
      if (stopCooldown) return;
      setTurnStopPending(true);
      if (turnStopPendingTimerRef.current !== null) window.clearTimeout(turnStopPendingTimerRef.current);
      turnStopPendingTimerRef.current = window.setTimeout(() => {
        turnStopPendingTimerRef.current = null;
        setTurnStopPending(false);
      }, TURN_STOP_SETTLE_MS);
      stopRunningCliTurn("floating turn pause");
      startStopCooldown();
      return;
    }
    if (stopsBackgroundAgents) {
      const now = Date.now();
      if (now - lastBackgroundAgentStopAtRef.current < BACKGROUND_AGENT_STOP_CONFIRM_GAP_MS) return;
      if (sendTerminalInput(CLAUDE_STOP_BACKGROUND_AGENTS_SEQUENCE, "floating stop background agents", "visible", true, { trackDraft: false })) {
        lastBackgroundAgentStopAtRef.current = now;
      }
      return;
    }
    if (!canSendTurn) return;
    sendTerminalSubmit("\r", "floating turn submit", { turnMarker: createCliTurnMarker() });
  }

  async function abortOpenCodeTurn() {
    try {
      const result = await api.abortCliTurn(pane.id);
      if (activeTurnMarker) {
        publishPaneRunLifecycle({
          roomId: pane.roomId,
          paneId: pane.id,
          runKey: activeTurnMarker,
          status: "FAILED"
        });
      }
      clearStoredActiveCliTurn(pane.id);
      setActiveCliTurn(null);
      setModelSettings((current) => current ? { ...current, isTurnActive: result.isTurnActive } : current);
      if (!result.isTurnActive) {
        setTerminalScreenRunning(false);
        terminalScreenRunningRef.current = false;
      }
    } catch (error) {
      setError(error instanceof Error ? error.message : "OpenCode turn abort failed.");
    }
  }

  async function handleModelSwitch(
    modelId: string,
    reasoningEffort: string,
    _providerId: string | null = null,
    continueActiveTurn = false,
    clickedManagedScope?: ManagedStageScope | null
  ): Promise<{
    current: PaneCliModelSettings["current"];
    message: string | null;
    pending?: boolean;
  }> {
    const currentSession = sessionResponseRef.current;
    if (!currentSession) throw new Error("Attach a CLI session before changing model settings.");
    const expectedSessionId = currentSession.session.sessionId;
    if (currentSession.session.runtimeId === "cli:codex") {
      return routePaneModelSwitch(managedPlan.getClient(), { modelId, reasoningEffort }, async () => {
        const settings = await api.cliModelSettings(pane.id);
        if (sessionResponseRef.current?.session.sessionId !== expectedSessionId) throw new Error("The CLI session changed while reading model settings.");
        return settings;
      }, updateUnmanagedModel, clickedManagedScope);
    }
    return updateUnmanagedModel();

    async function updateUnmanagedModel() {
      const result = await api.updateCliModelSettings(pane.id, {
        expectedSessionId,
        modelId,
        reasoningEffort,
        continueActiveTurn
      }).catch(async (error: unknown) => {
        await refreshModelSettings(expectedSessionId);
        throw error;
      });
      if (sessionResponseRef.current?.session.sessionId !== expectedSessionId ||
          result.settings.sessionId !== expectedSessionId) {
        throw new Error("The CLI session changed while updating its model settings.");
      }
      modelSettingsRef.current = result.settings;
      setModelSettings(result.settings);
      setSessionResponse((current) => {
        if (!current || current.session.sessionId !== result.session.session.sessionId) return result.session;
        return { ...current, session: result.session.session };
      });
      if (result.interrupted) {
        clearStoredActiveCliTurn(pane.id);
        setActiveCliTurn(null);
      }
      if (!result.settings.current) {
        throw new Error("The CLI runtime did not confirm the applied model settings.");
      }
      const message = result.appliedScope === "REASONING_ONLY"
        ? result.warning ?? "Reasoning changed; the CLI kept the previous model."
        : result.warning;
      return {
        current: result.settings.current,
        message
      };
    }
  }

  function registerHiddenTerminalInput(data: string) {
    const now = Date.now();
    const expiresAtMs = now + HIDDEN_INPUT_ECHO_TTL_MS;
    hiddenInputEchoFiltersRef.current = [
      ...hiddenInputEchoFiltersRef.current.filter((item) => item.expiresAtMs > now),
      ...plainTextHiddenEchoCandidates(data).map((candidate) => ({ value: candidate, remaining: candidate, expiresAtMs }))
    ];
  }

  function stripHiddenTerminalEcho(data: string): string {
    const now = Date.now();
    hiddenInputEchoFiltersRef.current = hiddenInputEchoFiltersRef.current.filter((item) => item.remaining && item.expiresAtMs > now);
    // The pane host and API already mask upload paths (and rejoin paths split
    // across chunks); this per-chunk mask is a layout-preserving backstop.
    let output = maskUploadPaths(data);
    if (!hiddenInputEchoFiltersRef.current.length) return output;

    for (let index = 0; index < hiddenInputEchoFiltersRef.current.length && output; ) {
      const pending = hiddenInputEchoFiltersRef.current[index];
      if (!pending) {
        index += 1;
        continue;
      }
      if (containsCliUploadPath(pending.value)) {
        index += 1;
        continue;
      }
      let exactIndex = output.indexOf(pending.remaining);
      if (exactIndex >= 0) {
        while (exactIndex >= 0 && output) {
          output = `${output.slice(0, exactIndex)}${output.slice(exactIndex + pending.remaining.length)}`;
          exactIndex = output.indexOf(pending.remaining);
        }
        pending.remaining = pending.value;
        index += 1;
        continue;
      }
      if (pending.remaining.startsWith(output)) {
        pending.remaining = pending.remaining.slice(output.length);
        if (!pending.remaining) pending.remaining = pending.value;
        return "";
      }
      const prefixLength = longestHiddenEchoPrefixAtEnd(output, pending.remaining);
      if (prefixLength > 0) {
        pending.remaining = pending.remaining.slice(prefixLength);
        if (!pending.remaining) pending.remaining = pending.value;
        output = output.slice(0, -prefixLength);
      }
      index += 1;
    }
    return output;
  }

  async function removeUploadPreview(id: string) {
    const removedIndex = uploadPreviews.findIndex((preview) => preview.id === id);
    const removedPreview = removedIndex >= 0 ? uploadPreviews[removedIndex] ?? null : null;
    setUploadPreviews((current) => current.filter((preview) => preview.id !== id));
    if (selectedUploadPreviewId === id) {
      setSelectedUploadPreviewId(null);
    }
    if (removedPreview) {
      setNotice("Clipboard preview removed.");
      updateClipboardDebug(
        "info",
        "clipboard preview removed",
        `removed image ${removedIndex + 1}; remaining=${Math.max(uploadPreviews.length - 1, 0)}; path=${removedPreview.path}; ${terminalRoutingSummary(typeof document !== "undefined" ? document.activeElement : null)}.`
      );
      if (removedPreview.id) {
        await api.deleteArtifact(removedPreview.id).catch(() => {});
      }
    }
    focusTerminal();
    window.requestAnimationFrame(() => focusTerminal());
  }

  async function clearUploadPreviews() {
    if (!uploadPreviews.length) return;
    const toDelete = [...uploadPreviews];
    setUploadPreviews([]);
    setSelectedUploadPreviewId(null);
    setUploadPreviewsOpen(false);
    setPhotoContextMenu(null);
    setNotice("All clipboard previews removed.");
    focusTerminal();
    window.requestAnimationFrame(() => focusTerminal());
    await Promise.allSettled(
      toDelete.map((p) => (p.id ? api.deleteArtifact(p.id).catch(() => {}) : Promise.resolve()))
    );
  }

  async function uploadFiles(
    files: File[],
    source: PaneCliUploadSource,
    debugSource: string = source,
    attachmentNotice = MANAGED_ATTACHMENT_NOTICE
  ) {
    if (!files.length) return;
    if (sessionResponseRef.current?.session.purpose === "LOGIN") {
      clearClipboardPasteAttempt();
      setDragActive(false);
      setError("File and image uploads are unavailable during CLI login.");
      return;
    }
    if (!(await waitForTerminalFileUploadControl())) {
      if (source === "CLIPBOARD") {
        clearClipboardPasteAttempt();
      }
      updateClipboardDebug("bad", "upload blocked", `${debugSource}: CLI upload control unavailable; fileCount=${files.length}.`);
      return;
    }
    setUploading(true);
    setError(null);
    if (source === "CLIPBOARD") {
      markClipboardUploadPending();
    }
    updateClipboardDebug(
      "info",
      "upload started",
      `${debugSource}: uploading ${files.length} file(s): ${files.map((file) => `${file.name || "clipboard"}:${file.type || "unknown"}:${file.size}`).join(", ")}.`
    );
    try {
      const uploadedPairs: Array<{ uploadedFile: PaneCliUploadedFile; sourceFile: File | undefined }> = [];
      for (const batch of chunkFiles(files, paneCliUploadMaxCount)) {
        const uploaded = await api.uploadCliFiles({ paneId: pane.id, source, files: batch });
        uploaded.files.forEach((uploadedFile, index) => {
          uploadedPairs.push({ uploadedFile, sourceFile: batch[index] });
        });
      }
      const uploadedFiles = uploadedPairs.map((pair) => pair.uploadedFile);
      if (source === "CLIPBOARD") {
        if (uploadedFiles.some((file) => file.isImage)) {
          markClipboardUploadSucceeded();
        } else {
          clearClipboardPasteAttempt();
        }
      }
      const nextPreviews = uploadedPairs
        .map(({ uploadedFile, sourceFile }) => {
          if (!uploadedFile.isImage || !sourceFile?.type.startsWith("image/")) return null;
          return {
            id: uploadedFile.artifactId ?? `${uploadedFile.sessionId}:${uploadedFile.storedFilename}`,
            name: uploadedFile.originalFilename,
            path: uploadedFile.terminalPath,
            objectUrl: uploadedFile.artifactId ? api.artifactFileUrl(uploadedFile.artifactId) : URL.createObjectURL(sourceFile)
          };
        })
        .filter((preview): preview is TerminalUploadPreview => Boolean(preview));
      if (nextPreviews.length) {
        setUploadPreviewPage(0);
        setUploadPreviews((current) => {
          const byId = new Map(current.map((preview) => [preview.id, preview]));
          for (const preview of nextPreviews) byId.set(preview.id, preview);
          return Array.from(byId.values());
        });
      }
      if (sessionResponseRef.current?.session.runtimeId === "cli:root") {
        // Bash would treat "[File #1]" labels as a command plus a comment; a shell gets the quoted paths.
        const sent = sendTerminalInput(`${uploadedFiles.map(terminalInputPath).join(" ")} `, `${debugSource}: root shell paths`);
        updateClipboardDebug(
          sent ? "good" : "bad",
          sent ? "root shell paths inserted" : "root shell paths failed",
          `${debugSource}: uploaded=${uploadedFiles.length}; display=visible; containsUploadPath=true.`
        );
        focusTerminal();
      } else if (usesNativeImagePaste) {
        const imageFiles = uploadedFiles.filter((file) => file.isImage);
        const attachedImageCount = imageFiles.filter((file) =>
          sendTerminalInput(terminalImagePaste(file), `${debugSource}: image attachment`, "hidden", true)
        ).length;
        const terminalFiles = uploadedFiles.filter((file) => !file.isImage);
        if (terminalFiles.length) {
          const sent = insertManagedPromptAttachments(terminalFiles, debugSource, attachmentNotice);
          updateClipboardDebug(
            sent ? "good" : "bad",
            sent ? "attachment labels inserted" : "attachment labels failed",
            `${debugSource}: uploaded=${uploadedFiles.length}; tokenCount=${terminalFiles.length}; display=visible; containsUploadPath=false.`
          );
        } else {
          updateClipboardDebug(
            attachedImageCount === imageFiles.length ? "good" : "bad",
            attachedImageCount === imageFiles.length ? "image attached" : "image attachment failed",
            `${debugSource}: uploaded=${uploadedFiles.length}; attachedImageCount=${attachedImageCount}; imagePathCount=${imageFiles.length}; display=hidden.`
          );
          focusTerminal();
        }
      } else {
        const sent = insertManagedPromptAttachments(uploadedFiles, debugSource, attachmentNotice);
        updateClipboardDebug(
          sent ? "good" : "bad",
          sent ? "attachment labels inserted" : "attachment labels failed",
          `${debugSource}: uploaded=${uploadedFiles.length}; tokenCount=${uploadedFiles.length}; display=visible; containsUploadPath=false.`
        );
        focusTerminal();
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "CLI file upload failed";
      setError(message);
      if (source === "CLIPBOARD") {
        clearClipboardPasteAttempt();
      }
      updateClipboardDebug("bad", "upload failed", `${debugSource}: ${message}`);
    } finally {
      setUploading(false);
      setDragActive(false);
    }
  }

  async function insertClipboardText(text: string, source: string) {
    setNotice(null);
    const file = new File([text], clipboardTextFilename(), { type: "text/plain" });
    await uploadFiles([file], "CLIPBOARD", source, CLIPBOARD_TEXT_FILE_NOTICE);
  }

  async function pasteClipboardTextToTerminal(
    text: string,
    source: string,
    routingSummary?: string
  ): Promise<boolean> {
    const isLoginPurpose = sessionResponseRef.current?.session.purpose === "LOGIN";
    const hasNewlines = text.includes("\n") || text.includes("\r");
    const lineCount = text.split(/\r?\n/).length;
    const bracketedPasteSupported = Boolean(
      terminalRef.current?.modes?.bracketedPasteMode || isCodexCliSession || isClaudeCliSession
    );

    const mode = resolveTerminalPasteMode({
      isLoginPurpose,
      hasNewlines,
      lineCount,
      charCount: text.length,
      bracketedPasteSupported
    });

    if (mode === "raw") {
      const display = isLoginPurpose ? "hidden" : "visible";
      const sent = sendTerminalInput(text, source, display);
      clearClipboardPasteAttempt();
      if (!isLoginPurpose) {
        updateClipboardDebug(
          sent ? "good" : "bad",
          sent ? "text paste sent" : "text paste failed",
          `${source}; ${routingSummary ?? ""}.`
        );
      }
      return sent;
    }

    if (mode === "bracketed") {
      const normalized = text.replace(/\r?\n/g, "\r");
      const bracketed = `${BRACKETED_PASTE_START}${normalized}${BRACKETED_PASTE_END}`;
      const sent = sendTerminalInput(bracketed, source, "visible");
      clearClipboardPasteAttempt();
      updateClipboardDebug(
        sent ? "good" : "bad",
        sent ? "multiline bracketed paste sent" : "multiline bracketed paste failed",
        `${source}: lines=${lineCount}; chars=${text.length}; bracketed=true; ${routingSummary ?? ""}.`
      );
      return sent;
    }

    try {
      await insertClipboardText(text, source);
      clearClipboardPasteAttempt();
      updateClipboardDebug(
        "good",
        "multiline text attached as file",
        `${source}: lines=${lineCount}; chars=${text.length}; attached as txt file; ${routingSummary ?? ""}.`
      );
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to attach text file";
      setError(message);
      clearClipboardPasteAttempt();
      return false;
    }
  }

  function stopClipboardEvent(event: Pick<Event, "preventDefault" | "stopPropagation"> & { stopImmediatePropagation?: () => void }) {
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation?.();
  }

  function stopPasteShortcutEvent(event: Pick<Event, "preventDefault" | "stopPropagation"> & { stopImmediatePropagation?: () => void }) {
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation?.();
  }

  function clearPasteShortcutFallback() {
    if (pasteShortcutFallbackRef.current === null) return;
    window.clearTimeout(pasteShortcutFallbackRef.current);
    pasteShortcutFallbackRef.current = null;
  }

  function clearClipboardAttemptWatchdog() {
    if (clipboardAttemptTimerRef.current === null) return;
    window.clearTimeout(clipboardAttemptTimerRef.current);
    clipboardAttemptTimerRef.current = null;
  }

  function clearClipboardPasteAttempt() {
    clearClipboardAttemptWatchdog();
    clipboardPasteAttemptRef.current = null;
  }

  function beginClipboardPasteAttempt(source: string, detail: string) {
    clearClipboardAttemptWatchdog();
    clipboardPasteAttemptRef.current = {
      source,
      detail,
      startedAtMs: Date.now(),
      uploadPendingAtMs: null,
      uploadSucceededAtMs: null
    };
    clipboardAttemptTimerRef.current = window.setTimeout(() => {
      clipboardAttemptTimerRef.current = null;
      const attempt = clipboardPasteAttemptRef.current;
      if (!attempt || attempt.source !== source) return;
      if (attempt.uploadPendingAtMs !== null || attempt.uploadSucceededAtMs !== null) return;
      updateClipboardDebug(
        "bad",
        "paste stalled before upload",
        `${attempt.source}: no upload, no text send, and no terminal clipboard failure were observed within ${CLIPBOARD_STALL_TIMEOUT_MS}ms. ${attempt.detail}`
      );
    }, CLIPBOARD_STALL_TIMEOUT_MS);
  }

  function activeClipboardPasteAttempt(nowMs = Date.now()): ClipboardPasteAttempt | null {
    const attempt = clipboardPasteAttemptRef.current;
    if (!attempt) return null;
    if (attempt.uploadSucceededAtMs !== null) {
      if (nowMs - attempt.uploadSucceededAtMs > CLIPBOARD_FAILURE_SUPPRESS_AFTER_UPLOAD_MS) {
        clipboardPasteAttemptRef.current = null;
        return null;
      }
      return attempt;
    }
    if (attempt.uploadPendingAtMs !== null) {
      if (nowMs - attempt.uploadPendingAtMs > CLIPBOARD_FAILURE_SUPPRESS_AFTER_UPLOAD_MS) {
        attempt.uploadPendingAtMs = null;
      } else {
        return attempt;
      }
    }
    if (nowMs - attempt.startedAtMs > CLIPBOARD_FAILURE_REPORT_WINDOW_MS) {
      clipboardPasteAttemptRef.current = null;
      return null;
    }
    return attempt;
  }

  function markClipboardUploadPending() {
    const attempt = activeClipboardPasteAttempt();
    if (!attempt) return;
    attempt.uploadPendingAtMs = Date.now();
    attempt.uploadSucceededAtMs = null;
  }

  function markClipboardUploadSucceeded() {
    const attempt = activeClipboardPasteAttempt();
    if (!attempt) return;
    attempt.uploadPendingAtMs = null;
    attempt.uploadSucceededAtMs = Date.now();
  }

  function recentTerminalClipboardFailure(text: string): { source: string; excerpt: string } | null {
    const excerpt = summarizeClipboardFailureOutput(text);
    if (!excerpt || !CLIPBOARD_FAILURE_OUTPUT_PATTERN.test(excerpt)) return null;
    const attempt = activeClipboardPasteAttempt();
    if (!attempt) return null;
    if (attempt.uploadPendingAtMs !== null || attempt.uploadSucceededAtMs !== null) return null;
    clearClipboardPasteAttempt();
    return { source: attempt.source, excerpt };
  }

  function armPasteInputGuard(source: string) {
    pasteInputGuardRef.current = { source, expiresAtMs: Date.now() + PASTE_INPUT_GUARD_MS };
  }

  function isGuardedPasteTerminalInput(data: string): boolean {
    const guard = pasteInputGuardRef.current;
    if (!guard) return false;
    if (guard.expiresAtMs <= Date.now()) {
      pasteInputGuardRef.current = null;
      return false;
    }
    return data === "\u0016";
  }

  function schedulePasteShortcutFallback(source: string, priorClipboardSummary: string) {
    clearPasteShortcutFallback();
    pasteShortcutFallbackRef.current = window.setTimeout(() => {
      pasteShortcutFallbackRef.current = null;
      void handleClipboardReadPaste(source, priorClipboardSummary);
    }, 80);
  }

  async function handleClipboardReadPaste(source: string, priorClipboardSummary: string) {
    const clipboard = getSpaceRuntime().platform.clipboard;
    if (!clipboard?.read && !clipboard?.readText) {
      clearClipboardPasteAttempt();
      updateClipboardDebug(
        "bad",
        "async clipboard unavailable",
        `${source}: ${priorClipboardSummary}; browser did not expose navigator.clipboard.read/readText. Raw paste was blocked before Codex CLI.`
      );
      return;
    }
    updateClipboardDebug("info", "async clipboard read started", `${source}: ${priorClipboardSummary}.`);
    try {
      const files = await readClipboardImageFiles(clipboard);
      if (files.length) {
        if (sessionResponseRef.current?.session.purpose === "LOGIN") {
          clearClipboardPasteAttempt();
          setError("Image paste is unavailable during CLI login. Paste the authorization code as text.");
          return;
        }
        updateClipboardDebug("good", "async clipboard image read succeeded", `${source}: ${priorClipboardSummary}; files=${files.length}.`);
        await uploadFiles(files, "CLIPBOARD", `${source}: async clipboard image read succeeded`);
        return;
      }
      const text = await clipboard?.readText?.();
      if (text) {
        if (sessionResponseRef.current?.session.purpose !== "LOGIN") {
          void captureClipboardText({
            text,
            source: "PASTE",
            roomId: pane.roomId,
            paneId: pane.id,
            paneTitle: pane.title
          });
        }
        await pasteClipboardTextToTerminal(
          text,
          `${source}: async clipboard text read succeeded`,
          `${priorClipboardSummary}; textLength=${text.length}`
        );
        return;
      }
      updateClipboardDebug(
        "bad",
        "clipboard image unavailable",
        `${source}: ${priorClipboardSummary}; async clipboard read returned no supported images or text. Raw paste was blocked before Codex CLI.`
      );
      clearClipboardPasteAttempt();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Clipboard paste failed.";
      setError(`${message} Raw paste was blocked before Codex CLI.`);
      clearClipboardPasteAttempt();
      updateClipboardDebug("bad", "async clipboard read failed", `${source}: ${priorClipboardSummary}; ${message}`);
    }
  }

  function handleTerminalPaste(event: ReactClipboardEvent<HTMLElement>) {
    if (event.target instanceof Element && event.target.closest("[data-local-cli-composer]")) return;
    clearPasteShortcutFallback();
    const snapshot = snapshotClipboardData(event.clipboardData);
    const routing = terminalRoutingSummary(event.target);
    beginClipboardPasteAttempt("react paste event", `${snapshot.summary}; ${routing}.`);
    armPasteInputGuard("react paste event");
    updateClipboardDebug("info", "react paste captured", `${snapshot.summary}; ${routing}.`);
    const files = extractClipboardFiles(event);
    if (files.length) {
      stopClipboardEvent(event.nativeEvent);
      if (sessionResponseRef.current?.session.purpose === "LOGIN") {
        clearClipboardPasteAttempt();
        setError("Image paste is unavailable during CLI login. Paste the authorization code as text.");
        return;
      }
      void uploadFiles(files, "CLIPBOARD", `react paste event: ${snapshot.summary}; ${routing}`);
      return;
    }
    const text = snapshot.text;
    if (text) {
      if (sessionResponseRef.current?.session.purpose !== "LOGIN") {
        void captureClipboardEventText(event.nativeEvent, {
          text,
          source: "PASTE",
          roomId: pane.roomId,
          paneId: pane.id,
          paneTitle: pane.title
        });
      }
      event.preventDefault();
      event.stopPropagation();
      void pasteClipboardTextToTerminal(text, `react paste text: ${snapshot.summary}`, routing);
      return;
    }
    stopClipboardEvent(event.nativeEvent);
    void handleClipboardReadPaste("react paste fallback", `${snapshot.summary}; ${routing}`);
  }

  function handleTerminalNativePaste(event: globalThis.ClipboardEvent) {
    if (event.target instanceof Element && event.target.closest("[data-local-cli-composer]")) return;
    clearPasteShortcutFallback();
    const snapshot = snapshotClipboardData(event.clipboardData);
    const routing = terminalRoutingSummary(event.target);
    beginClipboardPasteAttempt("native paste event", `${snapshot.summary}; ${routing}.`);
    armPasteInputGuard("native paste event");
    updateClipboardDebug("info", "native paste captured", `${snapshot.summary}; ${routing}.`);
    const files = extractClipboardFiles(event);
    if (files.length) {
      stopClipboardEvent(event);
      if (sessionResponseRef.current?.session.purpose === "LOGIN") {
        clearClipboardPasteAttempt();
        setError("Image paste is unavailable during CLI login. Paste the authorization code as text.");
        return;
      }
      void uploadFiles(files, "CLIPBOARD", `native paste event: ${snapshot.summary}; ${routing}`);
      return;
    }
    if (snapshot.text) {
      if (sessionResponseRef.current?.session.purpose !== "LOGIN") {
        void captureClipboardEventText(event, {
          text: snapshot.text,
          source: "PASTE",
          roomId: pane.roomId,
          paneId: pane.id,
          paneTitle: pane.title
        });
      }
      stopClipboardEvent(event);
      void pasteClipboardTextToTerminal(snapshot.text, `native paste text: ${snapshot.summary}`, routing);
      return;
    }
    stopClipboardEvent(event);
    void handleClipboardReadPaste("native paste fallback", `${snapshot.summary}; ${routing}`);
  }

  function handleTerminalPasteShortcut(event: KeyboardEvent) {
    if (!isPasteShortcutEvent(event)) return;
    const clipboard = getSpaceRuntime().platform.clipboard;
    if (!clipboard?.read && !clipboard?.readText) return;
    const routing = terminalRoutingSummary(event.target);
    beginClipboardPasteAttempt("Ctrl+V shortcut", `keydown intercepted before Codex CLI; paste event did not expose clipboard data; ${routing}.`);
    armPasteInputGuard("Ctrl+V shortcut");
    stopPasteShortcutEvent(event);
    updateClipboardDebug("info", "Ctrl+V paste intercepted", `keydown intercepted before Codex CLI; ${routing}.`);
    schedulePasteShortcutFallback(
      "Ctrl+V shortcut",
      `keydown intercepted before Codex CLI; paste event did not expose clipboard data; ${routing}`
    );
  }

  async function handleTerminalCopyShortcut(text: string) {
    try {
      const runtimeKind = await writeClipboardText(text);
      void captureClipboardText({
        text,
        source: "COPY",
        roomId: pane.roomId,
        paneId: pane.id,
        paneTitle: pane.title
      });
      setError(null);
      if (runtimeKind === "demo") {
        setNotice(DEMO_LOCAL_REPLY);
      }
      focusTerminal();
    } catch (err) {
      setNotice(null);
      setError(err instanceof Error ? err.message : "CLI selection copy failed");
    }
  }

  function handleTerminalBeforeInput(event: InputEvent) {
    if (event.defaultPrevented || event.inputType !== "insertFromPaste") return;
    clearPasteShortcutFallback();
    const routing = terminalRoutingSummary(event.target);
    const existingAttempt = activeClipboardPasteAttempt();
    if (existingAttempt) {
      if (showCliDebugMode) {
        updateClipboardDebug("info", "beforeinput paste skipped", `existing tracked paste attempt (${existingAttempt.source}) took precedence; ${routing}.`);
      }
      return;
    }
    beginClipboardPasteAttempt("beforeinput paste event", `beforeinput insertFromPaste intercepted before Codex CLI; ${routing}.`);
    armPasteInputGuard("beforeinput paste event");
    stopPasteShortcutEvent(event);
    updateClipboardDebug("info", "beforeinput paste intercepted", `beforeinput insertFromPaste intercepted before Codex CLI; ${routing}.`);
    void handleClipboardReadPaste(
      "beforeinput paste fallback",
      `beforeinput insertFromPaste intercepted before Codex CLI; ${routing}`
    );
  }

  async function dropArtifactFile(payload: ArtifactDragPayload) {
    if (sessionResponseRef.current?.session.purpose === "LOGIN") {
      setDragActive(false);
      setError("File drop is unavailable during CLI login. Paste the authorization code as text.");
      return;
    }
    try {
      const file = await resolveArtifactDragFile(payload);
      await uploadFiles([file], "DROP");
    } catch (err) {
      setDragActive(false);
      setError(err instanceof Error ? err.message : "Artifact file drop failed");
    }
  }

  function buildPaneContextDropBlock(payload: PaneContextDragPayload): Promise<string> {
    if (!payload.runtimeId) return Promise.resolve(formatPaneContextBlock(payload));
    return Promise.allSettled([
      api.recoveryCliTask(payload.id),
      api.activeCliSession(payload.id, { includeTranscript: false })
    ]).then(([taskResult, sessionResult]) => {
      const task = taskResult.status === "fulfilled" ? taskResult.value.threads[0] ?? null : null;
      const session = sessionResult.status === "fulfilled" ? sessionResult.value?.session ?? null : null;
      if (!task) return formatPaneContextBlock(payload);
      const targetRuntime = sessionResponseRef.current?.session.runtimeId ?? null;
      return buildPaneTaskContextBlock(payload, task, session, targetRuntime);
    });
  }

  function dropPaneContext(payload: PaneContextDragPayload) {
    if (sessionResponseRef.current?.session.purpose === "LOGIN") {
      setDragActive(false);
      setError("Pane context drop is unavailable during CLI login.");
      return;
    }
    setDragActive(false);
    void (async () => {
      const block = await buildPaneContextDropBlock(payload);
      const sent = sendTerminalInput(`${block} `, "pane context drop", "visible");
      if (sent) {
        setError(null);
        setNotice("Pane context added to the prompt.");
      } else {
        setError("Attach a running CLI before dropping pane context into it.");
      }
    })();
  }

  function handleTerminalDrop(event: DragEvent<HTMLElement>) {
    const files = Array.from(event.dataTransfer.files);
    if (files.length) {
      event.preventDefault();
      event.stopPropagation();
      if (sessionResponseRef.current?.session.purpose === "LOGIN") {
        setDragActive(false);
        setError("File drop is unavailable during CLI login. Paste the authorization code as text.");
        return;
      }
      void uploadFiles(files, "DROP");
      return;
    }
    const paneContextPayload = readPaneContextDragPayload(event.dataTransfer);
    if (paneContextPayload) {
      if (paneContextPayload.roomId === pane.roomId) {
        setDragActive(false);
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      dropPaneContext(paneContextPayload);
      return;
    }
    const artifactPayload = readArtifactDragPayload(event.dataTransfer);
    if (artifactPayload) {
      event.preventDefault();
      event.stopPropagation();
      void dropArtifactFile(artifactPayload);
      return;
    }
    const clipboardItemId = event.dataTransfer.getData(SPACE_CLIPBOARD_ITEM_MIME);
    const clipboardTitle = event.dataTransfer.getData(SPACE_CLIPBOARD_ITEM_TITLE_MIME);
    const text = event.dataTransfer.getData("text/plain");
    if (clipboardItemId && text) {
      event.preventDefault();
      event.stopPropagation();
      if (clipboardTitle) {
        sendTerminalInput(`# ${clipboardTitle}\n\n`, "clipboard history drop: plan title");
      }
      void insertClipboardText(text, "clipboard history drop");
      setDragActive(false);
      return;
    }
    const taskItemId = event.dataTransfer.getData(SPACE_TASK_ITEM_MIME);
    if (taskItemId && text) {
      event.preventDefault();
      event.stopPropagation();
      void startDroppedTask(text);
      setDragActive(false);
      return;
    }
    setDragActive(false);
  }

  async function startDroppedTask(objective: string) {
    setNotice(null);
    const droppedTaskSession = sessionResponseRef.current?.session;
    const sent = sendTerminalSubmit(`${objective}\r`, "task dock drop", {
      ...(isRunCapableCliSession(droppedTaskSession) ? { turnMarker: createCliTurnMarker() } : {})
    });
    updateClipboardDebug(
      sent ? "good" : "bad",
      "task dock drop",
      `received task drop; objectiveLength=${objective.length}; autoStart=true; display=visible.`
    );
    if (!sent) setError("Attach a running CLI before dropping a task into it.");
  }

  function collectTerminalContent(): string {
    const terminalWithBuffer = terminalRef.current as
      | (XtermTerminal & {
          buffer?: {
            active?: {
              length: number;
              getLine(index: number): { isWrapped?: boolean; translateToString(trimRight?: boolean): string } | undefined;
            };
          };
        })
      | null;
    const activeBuffer = terminalWithBuffer?.buffer?.active;
    if (activeBuffer && activeBuffer.length > 0) {
      const buffered = terminalBufferText(activeBuffer).trimEnd();
      if (buffered.trim()) return buffered;
    }
    const domText = xtermHostRef.current?.innerText || xtermHostRef.current?.textContent || "";
    if (domText.trim()) return domText.trimEnd();
    return sessionResponse?.transcript.map((chunk) => chunk.content).join("").trimEnd() ?? "";
  }

  async function copyTerminalContent() {
    const content = collectTerminalContent();
    if (!content.trim()) {
      setError("No CLI content is available to copy yet.");
      setNotice(null);
      return;
    }
    try {
      const runtimeKind = await writeClipboardText(content);
      void captureClipboardText({
        text: content,
        source: "COPY",
        roomId: pane.roomId,
        paneId: pane.id,
        paneTitle: pane.title
      });
      setError(null);
      setNotice(runtimeKind === "demo" ? DEMO_LOCAL_REPLY : "CLI content copied.");
      focusTerminal();
    } catch (err) {
      setNotice(null);
      setError(err instanceof Error ? err.message : "CLI copy failed");
    }
  }

  type ClaudePlanModeActionIdentity = { sessionId: string; socket: WebSocket };
  type NativePlanModeActionIdentity = ClaudePlanModeActionIdentity & { runtimeId: NativePlanRuntimeId };

  function nativePlanModeActionIdentityMatches(identity: NativePlanModeActionIdentity): boolean {
    const session = sessionResponseRef.current?.session;
    return Boolean(
      session?.isActive &&
        session.runtimeId === identity.runtimeId &&
        session.sessionId === identity.sessionId &&
        socketRef.current === identity.socket &&
        identity.socket.readyState === WebSocket.OPEN &&
        readySocketRef.current?.socket === identity.socket &&
        readySocketRef.current.sessionId === identity.sessionId
    );
  }

  function claudePlanModeActionIdentityMatches(identity: ClaudePlanModeActionIdentity): boolean {
    const session = sessionResponseRef.current?.session;
    return Boolean(
      session?.isActive &&
        session.runtimeId === CLAUDE_CLI_RUNTIME_ID &&
        session.sessionId === identity.sessionId &&
        socketRef.current === identity.socket &&
        identity.socket.readyState === WebSocket.OPEN &&
        readySocketRef.current?.socket === identity.socket &&
        readySocketRef.current.sessionId === identity.sessionId
    );
  }

  async function waitForClaudePermissionModeChange(
    previousMode: ClaudePermissionMode,
    identity: ClaudePlanModeActionIdentity,
    timeoutMs = 1_500
  ): Promise<{ status: "changed"; mode: ClaudePermissionMode } | { status: "aborted" } | { status: "timed_out" }> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!claudePlanModeActionIdentityMatches(identity)) return { status: "aborted" };
      const terminal = terminalRef.current;
      const currentMode = terminal ? claudePermissionMode(terminalCurrentScreenText(terminal)) : null;
      if (currentMode && currentMode !== previousMode) return { status: "changed", mode: currentMode };
      await new Promise((resolve) => window.setTimeout(resolve, 25));
    }
    return claudePlanModeActionIdentityMatches(identity) ? { status: "timed_out" } : { status: "aborted" };
  }

  useEffect(() => {
    async function handleTerminalPaneActionEvent(event: CustomEvent<TerminalPaneActionDetail>) {
      if (!isTerminalPaneAction(event.detail) || event.detail.paneId !== pane.id) return;
      const loginSession = sessionResponseRef.current?.session.purpose === "LOGIN";
      if (loginSession && event.detail.action === "cancel_login") {
        const cancelled = await api.interruptCliSession(pane.id, "CLI login cancelled by operator.");
        clearReconnectTimer();
        setSessionResponse(cancelled);
        setTerminalStatus("closed");
        setError(null);
        setNotice("CLI login cancelled.");
        return;
      }
      if (
        loginSession &&
        event.detail.action !== "reconnect" &&
        event.detail.action !== "focus" &&
        event.detail.action !== "insert_text" &&
        event.detail.action !== "keyboard_input" &&
        event.detail.action !== "insert_clipboard_text" &&
        event.detail.action !== "start_task_item"
      ) return;
      if (event.detail.action === "enter_native_plan_mode") {
        const actionSession = sessionResponseRef.current?.session;
        const actionSocket = socketRef.current;
        if (actionSession?.runtimeId !== event.detail.runtimeId) {
          if (!actionSession) {
            setNotice(null);
            setError("Attach a running CLI before changing Plan mode.");
          }
          return;
        }
        const actionIdentity = actionSocket
          ? { runtimeId: event.detail.runtimeId, sessionId: actionSession.sessionId, socket: actionSocket }
          : null;
        if (!actionIdentity || !nativePlanModeActionIdentityMatches(actionIdentity)) {
          setNotice(null);
          setError(`Attach a running ${event.detail.runtimeId === "cli:gemini" ? "Gemini" : event.detail.runtimeId === "cli:omp" ? "Oh My Pi" : "Qwen Code"} CLI before changing Plan mode.`);
          return;
        }
        // "/plan" typed after a draft would be sent as part of that message.
        if (terminalPromptDraftRef.current.text.trim()) {
          setNotice(null);
          setError("Send or clear the current CLI draft before changing modes.");
          return;
        }
        if (isTurnRunning) {
          setNotice(null);
          setError("Wait for the current CLI turn to finish before changing modes.");
          return;
        }
        sendTerminalInput("/plan\r", `terminal action ${event.detail.runtimeId} native Plan mode`, "visible", false, {
          trackDraft: false
        });
        return;
      }
      if (event.detail.action === "ensure_plan_mode") {
        const actionSession = sessionResponseRef.current?.session;
        const actionSocket = socketRef.current;
        if (actionSession?.runtimeId !== CLAUDE_CLI_RUNTIME_ID) {
          if (!actionSession) {
            setNotice(null);
            setError("Attach a running Claude Code CLI before changing Plan mode.");
          }
          return;
        }
        if (claudePlanModeActionPendingRef.current) return;
        const actionIdentity = actionSocket ? { sessionId: actionSession.sessionId, socket: actionSocket } : null;
        if (!actionIdentity || !claudePlanModeActionIdentityMatches(actionIdentity)) {
          setNotice(null);
          setError("Attach a running Claude Code CLI before changing Plan mode.");
          return;
        }
        const terminal = terminalRef.current;
        const detectedMode = terminal ? claudePermissionMode(terminalCurrentScreenText(terminal)) : null;
        if (detectedMode === null) {
          setNotice(null);
          setError("Claude Code mode is not visible yet. Wait for the prompt, then try Plan mode again.");
          return;
        }
        setError(null);
        if (detectedMode === "plan mode on") {
          setNotice("Plan mode is already on.");
          return;
        }
        let currentMode: ClaudePermissionMode = detectedMode;
        claudePlanModeActionPendingRef.current = true;
        setClaudePlanModeActionPending(true);
        try {
          for (let attempt = 0; attempt < 4; attempt += 1) {
            if (!claudePlanModeActionIdentityMatches(actionIdentity)) return;
            if (!sendTerminalInput(terminalControlKeySequence("shift_tab"), "terminal action ensure Claude Plan mode", "visible", false, { trackDraft: false })) {
              return;
            }
            const modeChange = await waitForClaudePermissionModeChange(currentMode, actionIdentity);
            if (modeChange.status === "aborted") return;
            if (modeChange.status === "timed_out") {
              setNotice(null);
              setError("Claude Code did not confirm the next permission mode. Try Plan mode again.");
              return;
            }
            currentMode = modeChange.mode;
            if (currentMode === "plan mode on") return;
          }
          setNotice(null);
          setError("Claude Code did not reach Plan mode after four bounded attempts.");
        } finally {
          claudePlanModeActionPendingRef.current = false;
          setClaudePlanModeActionPending(false);
        }
        return;
      }
      if (event.detail.action === "enable_plan_mode") {
        const actionSession = sessionResponseRef.current?.session;
        if (!actionSession || actionSession.purpose !== "NORMAL" || !socketRef.current) {
          setNotice(null);
          setError("Attach a running CLI before changing Plan mode.");
          return;
        }
        const terminal = terminalRef.current;
        // Mode keys such as Tab or Shift+Tab toggle; never turn Plan mode off from "Enable Plan mode".
        if (terminal && cliBuildModeState(actionSession.runtimeId, terminalCurrentScreenText(terminal)) === "plan") {
          setError(null);
          setNotice("Plan mode is already on.");
          return;
        }
        const planCommand = OSK_CLI_COMMANDS.find((command) => command.id === "plan");
        if (planCommand) await runCliShortcut(planCommand);
        return;
      }
      if (event.detail.action === "stop_task") {
        const actionSession = sessionResponseRef.current?.session;
        if (!actionSession || !socketRef.current) {
          setNotice(null);
          setError("Attach a running CLI before stopping its task.");
          return;
        }
        if (actionSession.runtimeId === "cli:root") {
          sendTerminalInput(terminalControlKeySequence("ctrl_c"), "terminal action stop root command", "visible", true, { trackDraft: false });
          return;
        }
        // Esc (Codex, Claude) and the OpenCode abort API are no-ops when idle. Ctrl+C is not:
        // a second press on an idle prompt exits most other CLIs, so send it only during a turn.
        const interruptIsHarmless =
          isOpenCodeCliSession ||
          floatingTurnPauseSequence(actionSession.runtimeId) === terminalControlKeySequence("escape");
        const turnLikelyRunning = isTurnRunning || (terminalScreenActive && !terminalPromptDraftRef.current.text.trim());
        if (stopCooldown || (!turnLikelyRunning && !interruptIsHarmless)) {
          setError(null);
          setNotice("No running CLI task to stop.");
          return;
        }
        stopRunningCliTurn("terminal action stop task");
        startStopCooldown();
        return;
      }
      if (event.detail.action === "control_key") {
        sendTerminalInput(terminalControlKeySequence(event.detail.key), `terminal action ${event.detail.key}`);
        return;
      }
      if (event.detail.action === "save_to_memory") {
        const commandText = event.detail.text.trim() || "save to memory";
        const actionSession = sessionResponseRef.current?.session;
        const isClaude = actionSession?.runtimeId === CLAUDE_CLI_RUNTIME_ID;
        // Save from the live conversation. Restarting into a fresh session would ask an agent
        // with no task context to save it, and would end the task the operator is working on.
        const actionSocket = socketRef.current;
        if (
          !actionSession?.isActive ||
          actionSession.purpose !== "NORMAL" ||
          !actionSocket ||
          actionSocket.readyState !== WebSocket.OPEN ||
          readySocketRef.current?.socket !== actionSocket
        ) {
          setNotice(null);
          setError(`Attach a running ${isClaude ? "Claude Code " : ""}CLI before saving it to memory.`);
          return;
        }
        if (terminalPromptDraftRef.current.text.trim()) {
          setNotice(null);
          setError("Send or clear the current CLI draft before saving to memory.");
          return;
        }
        const memoryBody = buildMemorySaveBody({
          paneTitle: pane.title,
          modelId: modelSettingsRef.current?.current?.modelId ?? actionSession.modelId ?? (isClaude ? "Claude Code" : actionSession.runtimeId),
          commandText,
          transcript: collectTerminalContent()
        });
        try {
          await submitCliShortcut({ id: "memory", label: "Save to memory", text: commandText, enter: true }, {
            isCurrent: () =>
              sessionResponseRef.current?.session.sessionId === actionSession.sessionId &&
              socketRef.current === actionSocket &&
              actionSocket.readyState === WebSocket.OPEN,
            runtimeId: actionSession.runtimeId,
            prepare: async () => {},
            write: (text) => sendTerminalInput(text, "terminal action save_to_memory"),
            enter: () => sendTerminalSubmit("\r", "terminal action save_to_memory enter", { turnMarker: createCliTurnMarker() })
          });
        } catch (error) {
          setNotice(null);
          setError(error instanceof Error ? error.message : "Save to memory could not be sent.");
          return;
        }
        await api.createMemory({
          scope: event.detail.memory.scope,
          roomId: event.detail.memory.scope === "ROOM" ? event.detail.memory.roomId ?? pane.roomId : null,
          title: event.detail.memory.title,
          body: memoryBody,
          provenance: event.detail.memory.provenance
        });
        setError(null);
        setNotice("CLI memory save requested.");
        return;
      }
      if (event.detail.action === "upload") {
        if (requestTerminalFileUploadControl() === "unavailable") {
          return;
        }
        fileInputRef.current?.click();
        return;
      }
      if (event.detail.action === "attach_clip_image") {
        markTerminalIntent();
        paneMinimizedRef.current = false;
        isVisibleRef.current = true;
        ensureTerminalControl(true);
        await uploadFiles([event.detail.file], "SCREEN_CAPTURE", "Clip Tool");
        return;
      }
      if (event.detail.action === "reconnect") {
        await reconnectTerminal();
        return;
      }
      if (event.detail.action === "new_task") {
        if (!selectedRuntime || pane.id.startsWith("pane:optimistic-")) {
          setNotice(null);
          setError("The CLI runtime is still loading. Try New task again in a moment.");
          return;
        }
        clearReconnectTimer();
        reconnectAttemptRef.current = 0;
        setReconnectInProgress(false);
        setConnectionAlert(null);
        setNotice(null);
        setError(null);
        autoAttachAttemptRef.current = null;
        takeCliResumeIntent(pane.id);
        if (terminalPromptDraftDebounceTimerRef.current !== null) {
          window.clearTimeout(terminalPromptDraftDebounceTimerRef.current);
          terminalPromptDraftDebounceTimerRef.current = null;
        }
        terminalPromptDraftRef.current = { text: "", cursor: 0 };
        setTerminalPromptDraft("");
        if (typeof terminalRef.current?.reset === "function") {
          terminalRef.current.reset();
        }
        await requestCliSession({ forceRestart: true });
        return;
      }
      if (event.detail.action === "replace_session") {
        clearReconnectTimer();
        reconnectAttemptRef.current = 0;
        setConnectionAlert(null);
        setError(null);
        setNotice(null);
        autoAttachAttemptRef.current = null;
        takeCliResumeIntent(pane.id);
        setSessionResponse(event.detail.session);
        setSelectedRuntimeId(event.detail.session.session.runtimeId);
        setTerminalStatus("idle");
        return;
      }
      if (event.detail.action === "insert_text") {
        if (containsCliUploadPath(event.detail.text)) {
          updateClipboardDebug(
            "good",
            "terminal action image path suppressed",
            `received insert_text action; textLength=${event.detail.text.length}; display=hidden-preview; containsUploadPath=true.`
          );
          focusTerminal();
          return;
        }
        const sent = sendTerminalInput(event.detail.text, "terminal action insert_text");
        updateClipboardDebug(
          sent ? "good" : "bad",
          "terminal action insert_text",
          `received insert_text action; textLength=${event.detail.text.length}; display=visible; containsUploadPath=false.`
        );
        return;
      }
      if (event.detail.action === "cli_shortcut") {
        const commandId = event.detail.commandId;
        if (commandId === "esc") {
          await runCliShortcut(OSK_ESC_COMMAND);
          return;
        }
        if (commandId === "enter") {
          await runCliShortcut(OSK_ENTER_COMMAND);
          return;
        }
        const command = OSK_CLI_COMMANDS.find((entry) => entry.id === commandId);
        if (command) await runCliShortcut(command);
        return;
      }
      if (event.detail.action === "switch_model") {
        await handleModelSwitch(event.detail.modelId, event.detail.reasoningEffort);
        return;
      }
      if (event.detail.action === "keyboard_input") {
        const actionSession = sessionResponseRef.current?.session;
        const submitting = isTerminalSubmitInput(event.detail.text);
        const turnMarker =
          submitting &&
          isRunCapableCliSession(actionSession)
            ? createCliTurnMarker()
            : undefined;
        if (submitting) {
          sendTerminalSubmit(event.detail.text, "on-screen keyboard input", { turnMarker });
        } else {
          sendTerminalInput(event.detail.text, "on-screen keyboard input");
        }
        return;
      }
      if (event.detail.action === "insert_clipboard_text") {
        await insertClipboardText(event.detail.text, "clipboard history insert");
        return;
      }
      if (event.detail.action === "start_task_item") {
        setNotice(null);
        const actionSession = sessionResponseRef.current?.session;
        const sent = sendTerminalSubmit(`${event.detail.objective}\r`, "task dock start", {
          ...(isRunCapableCliSession(actionSession) ? { turnMarker: createCliTurnMarker() } : {})
        });
        updateClipboardDebug(
          sent ? "good" : "bad",
          "terminal action start_task_item",
          `received start_task_item action; objectiveLength=${event.detail.objective.length}; autoStart=true; display=visible.`
        );
        if (!sent) setError("Attach a running CLI before starting a task in it.");
        return;
      }
      if (event.detail.action === "execute_plan") {
        setNotice(null);
        handleSelectOpenPlan(event.detail.plan);
        return;
      }
      if (event.detail.action === "focus") {
        focusTerminal();
        return;
      }
      if (event.detail.action === "copy") {
        void copyTerminalContent();
        return;
      }
      if (event.detail.action === "paste") {
        void (async () => {
          try {
            const clipboard = getSpaceRuntime().platform.clipboard;
            if (!clipboard?.readText) {
              setError("This page cannot read the clipboard. Paste with Ctrl+V inside the terminal instead.");
              return;
            }
            const text = await clipboard.readText();
            if (text) {
              const sent = await pasteClipboardTextToTerminal(text, "toolbar paste");
              if (sent) {
                setNotice("Pasted into CLI.");
              }
            } else {
              setError("No text available in clipboard to paste.");
            }
            focusTerminal();
          } catch (err) {
            setError(err instanceof Error ? err.message : "Clipboard paste failed.");
          }
        })();
        return;
      }
      if (event.detail.action === "paste_file") {
        void (async () => {
          try {
            const clipboard = getSpaceRuntime().platform.clipboard;
            if (!clipboard?.readText) {
              setError("This page cannot read the clipboard, so it cannot attach it as a file.");
              return;
            }
            const text = await clipboard.readText();
            if (text) {
              await insertClipboardText(text, "toolbar paste as file");
              focusTerminal();
            } else {
              setError("No text available in clipboard to paste as file.");
            }
          } catch (err) {
            setError(err instanceof Error ? err.message : "Clipboard paste as file failed.");
          }
        })();
        return;
      }
    }
    function handleTerminalPaneAction(event: Event) {
      if (!(event instanceof CustomEvent)) return;
      const customEvent = event as CustomEvent<TerminalPaneActionDetail>;
      if (!isTerminalPaneAction(customEvent.detail) || customEvent.detail.paneId !== pane.id) return;
      (customEvent.detail as any).handled = true;
      customEvent.preventDefault();
      void handleTerminalPaneActionEvent(customEvent).catch((error: unknown) => {
        setNotice(null);
        setError(error instanceof Error ? error.message : "CLI terminal action failed");
      });
    }
    window.addEventListener(TERMINAL_PANE_ACTION_EVENT, handleTerminalPaneAction);
    return () => window.removeEventListener(TERMINAL_PANE_ACTION_EVENT, handleTerminalPaneAction);
  });

  return (
    <section
      className={dragActive ? "terminal-pane drag-active" : "terminal-pane"}
      aria-label={`CLI pane ${pane.title.replace(/^Terminal\b/i, "CLI")}`}
      data-terminal-status={terminalStatus}
      data-terminal-loading={loading ? "true" : "false"}
      data-terminal-action-pending={pending ? "true" : "false"}
      data-terminal-observer-only={observerOnly ? "true" : "false"}
      data-terminal-has-session={sessionResponse ? "true" : "false"}
      data-terminal-has-websocket={sessionResponse?.websocket ? "true" : "false"}
      data-terminal-has-error={error ? "true" : "false"}
      data-terminal-should-bootstrap={shouldBootstrap ? "true" : "false"}
      data-terminal-prefill-enabled={prefillInitialReplay ? "true" : "false"}
      data-terminal-prefill-ready={terminalPrefillReady ? "true" : "false"}
      data-workspace-text-size={terminalFontSize}
      onKeyDownCapture={(event) => {
        if (event.target instanceof Element && event.target.closest("[data-local-cli-composer]")) return;
        const isGKey = event.code === "KeyG" || event.key.toLowerCase() === "g" || event.key === "γ" || event.key === "Γ" || event.key === "©";
        if (autocorrectSettings.enabled && (event.altKey || (event.ctrlKey && event.shiftKey)) && isGKey) {
          event.preventDefault();
          event.stopPropagation();
          applyTerminalLayoutFix();
          return;
        }
        if (event.key !== "Escape" || !event.repeat) return;
        if (!(event.target instanceof Element) || !event.target.closest(".terminal-xterm")) return;
        event.preventDefault();
        event.stopPropagation();
      }}
      onPasteCapture={handleTerminalPaste}
      onDrop={handleTerminalDrop}
      onDragOver={(event) => {
        event.preventDefault();
        if (!isTerminalLoginSession && supportsCliFileUploads) {
          const isSameRoomPaneDrag = event.dataTransfer.types.includes(SPACE_PANE_CONTEXT_MIME);
          if (!isSameRoomPaneDrag) setDragActive(true);
        }
      }}
      onDragLeave={() => setDragActive(false)}
    >
      {supportsCliFileUploads ? (
        <input
          ref={fileInputRef}
          type="file"
          name={`cli-files-${pane.id}`}
          multiple
          accept="*/*"
          hidden
          onChange={(event) => {
            const files = event.currentTarget.files ? Array.from(event.currentTarget.files) : [];
            event.currentTarget.value = "";
            if (files.length) void uploadFiles(files, "USER_UPLOAD");
          }}
        />
      ) : null}

      {error ? (
        <div className="terminal-alert bad">
          <div className="terminal-alert-head">
            <span>{error}</span>
            <button type="button" className="terminal-alert-close" aria-label="Dismiss message" onClick={() => setError(null)}>
              <X aria-hidden="true" />
            </button>
          </div>
        </div>
      ) : null}
      {!readStoredSuppressNotifications() && notice && ["CLI content copied.", "CLI memory save requested.", "Build mode is ready. Send a task to continue.", "Plan mode is already on.", "No running CLI task to stop.", TERMINAL_CONTROL_REPLAY_NOTICE].includes(notice) ? (
        <div className="terminal-alert good" role="status">
          <div className="terminal-alert-head">
            <span>{notice}</span>
            <button type="button" className="terminal-alert-close" aria-label="Dismiss action message" onClick={() => setNotice(null)}>
              <X aria-hidden="true" />
            </button>
          </div>
        </div>
      ) : null}
      {connectionAlert ? (
        <div className={["terminal-alert", connectionAlert.tone === "bad" ? "bad" : "", connectionAlert.tone === "good" ? "good" : ""].filter(Boolean).join(" ")} role={connectionAlert.tone === "bad" ? "alert" : "status"}>
          <div className="terminal-alert-head">
            <span>{connectionAlert.message}</span>
            <button type="button" className="terminal-alert-close" aria-label="Dismiss connection message" onClick={() => setConnectionAlert(null)}>
              <X aria-hidden="true" />
            </button>
          </div>
        </div>
      ) : null}
      {selectedRuntime && !isCliRuntimeTerminalLaunchable(selectedRuntime) ? (
        <div className="terminal-alert" role="status">
          {selectedRuntime.statusReason}
        </div>
      ) : null}
      {showClipboardDebugPanel && clipboardDebug ? (
        <div className={["terminal-alert", clipboardDebug.severity === "bad" ? "bad" : "", clipboardDebug.severity === "good" ? "good" : ""].filter(Boolean).join(" ")} role={clipboardDebug.severity === "bad" ? "alert" : "status"}>
          <div className="terminal-alert-head">
            <strong>Clipboard debug</strong>
            <button
              type="button"
              className="terminal-alert-close"
              aria-label="Close CLI debug panel"
              onClick={() => setDismissedClipboardDebugAt(clipboardDebug.at)}
            >
              <X aria-hidden="true" />
            </button>
          </div>
          <span>{clipboardDebug.title}</span>
          <small>{clipboardDebug.detail}</small>
          <small>{clipboardDebug.at}</small>
          <button type="button" className="compact-action" onClick={() => setCliDebugMode(false)}>
            Turn off debug messages
          </button>
          {priorClipboardDebugEntries.length ? (
            <ol className="terminal-clipboard-debug-log" aria-label={`Recent clipboard events ${pane.title}`}>
              {priorClipboardDebugEntries.map((entry, index) => (
                <li key={`${entry.at}:${entry.title}:${index}`} className="terminal-clipboard-debug-entry">
                  <strong>{entry.title}</strong>
                  <small>{entry.at}</small>
                  <span>{entry.detail}</span>
                </li>
              ))}
            </ol>
          ) : null}
        </div>
      ) : null}
      {selectedUploadPreview && typeof document !== "undefined"
        ? createPortal(
          <div
            ref={uploadPreviewDialogRef}
            className="attachment-modal terminal-upload-modal"
            role="dialog"
            aria-modal="true"
            aria-label={`${selectedUploadPreviewLabel} preview`}
            {...portalThemeAttributes(uploadPreviewsPickerRef.current)}
            onClick={() => setSelectedUploadPreviewId(null)}
          >
            <div className="attachment-modal-body terminal-upload-modal-body" onClick={(event) => event.stopPropagation()}>
              <div className="terminal-upload-modal-toolbar">
                <span className="terminal-upload-modal-label" aria-live="polite">
                  {selectedUploadPreviewLabel} · {selectedUploadPreviewIndex + 1} / {uploadPreviews.length}
                </span>
                <span className="terminal-upload-modal-name" title={selectedUploadPreview.name}>{selectedUploadPreview.name}</span>
                <button
                  type="button"
                  className="terminal-upload-modal-delete"
                  aria-label="Delete photo"
                  title="Delete photo"
                  onClick={() => void removeUploadPreview(selectedUploadPreview.id)}
                >
                  <Trash2 size={15} aria-hidden="true" />
                </button>
                <button
                  ref={uploadPreviewCloseRef}
                  type="button"
                  className="terminal-upload-modal-close"
                  aria-label="Close image preview"
                  title="Close image preview"
                  onClick={() => setSelectedUploadPreviewId(null)}
                >
                  <X size={15} aria-hidden="true" />
                </button>
              </div>
              {uploadPreviews.length > 1 ? (
                <>
                  <button type="button" className="terminal-upload-modal-nav is-previous" aria-label="Previous image" onClick={() => navigateUploadPreview(-1)}>
                    <ChevronLeft aria-hidden="true" />
                  </button>
                  <button type="button" className="terminal-upload-modal-nav is-next" aria-label="Next image" onClick={() => navigateUploadPreview(1)}>
                    <ChevronRight aria-hidden="true" />
                  </button>
                </>
              ) : null}
              <div className="terminal-upload-modal-stage">
                {/* Keyed per photo so the spinner shows again until the next image has loaded. */}
                <img
                  key={selectedUploadPreview.id}
                  src={selectedUploadPreview.objectUrl}
                  alt={`${selectedUploadPreviewLabel} full size`}
                  decoding="async"
                  onLoad={markUploadImageLoaded}
                  onError={markUploadImageLoaded}
                />
                <Loader2 className="terminal-upload-modal-spinner" aria-hidden="true" />
              </div>
            </div>
          </div>,
          document.body
        )
        : null}

      <div className="terminal-stage">
        {uploadPreviews.length || photoHistoryError ? (
          <div ref={uploadPreviewsPickerRef} className="terminal-upload-preview-picker">
            <button
              ref={uploadPreviewsButtonRef}
              type="button"
              className={`terminal-upload-preview-trigger${uploadPreviewsOpen ? " is-open" : ""}`}
              aria-label={`Photos (${uploadPreviews.length}) for ${pane.title}`}
              aria-haspopup="dialog"
              aria-expanded={uploadPreviewsOpen}
              title={`Photos (${uploadPreviews.length})`}
              onClick={() => setUploadPreviewsOpen((prev) => !prev)}
              onContextMenu={(event) => {
                event.preventDefault();
                event.stopPropagation();
                setUploadPreviewsOpen(false);
                setContextMenu(null);
                setPhotoContextMenu({ x: event.clientX, y: event.clientY });
              }}
              {...photoTouchContext}
            >
              <Images size={16} aria-hidden="true" />
              {uploadPreviews.length > 1 ? (
                <span className="terminal-upload-trigger-badge" aria-hidden="true">
                  {uploadPreviews.length}
                </span>
              ) : null}
            </button>
            {uploadPreviewsOpen ? (
              <div className="terminal-upload-preview-popover" role="dialog" aria-label={`CLI photos ${pane.title}`}>
                <div className="terminal-upload-popover-header">
                  <span className="terminal-upload-popover-title">Photos ({uploadPreviews.length})</span>
                  <button
                    type="button"
                    className="terminal-upload-popover-clear"
                    aria-label={`Dismiss all images ${pane.title}`}
                    title="Delete photos"
                    disabled={!uploadPreviews.length}
                    onClick={() => void clearUploadPreviews()}
                  >
                    <Trash2 size={13} aria-hidden="true" />
                    <span>Delete photos</span>
                  </button>
                </div>
                {photoHistoryError ? (
                  <button type="button" className="compact-action" onClick={() => setPhotoHistoryAttempt((attempt) => attempt + 1)}>
                    Retry loading photos
                  </button>
                ) : null}
                {uploadPreviewPageCount > 1 ? (
                  <div className="terminal-upload-pages">
                    <button type="button" aria-label="Earlier photos" disabled={currentUploadPreviewPage >= uploadPreviewPageCount - 1} onClick={() => setUploadPreviewPage(currentUploadPreviewPage + 1)}><ChevronLeft aria-hidden="true" /></button>
                    <span>{uploadPreviewStart + 1}–{uploadPreviewEnd} / {uploadPreviews.length}</span>
                    <button type="button" aria-label="Later photos" disabled={currentUploadPreviewPage === 0} onClick={() => setUploadPreviewPage(currentUploadPreviewPage - 1)}><ChevronRight aria-hidden="true" /></button>
                  </div>
                ) : null}
                <div className="terminal-upload-strip terminal-upload-strip-floating" aria-label={`CLI image uploads ${pane.title}`}>
                  {uploadPreviews.slice(uploadPreviewStart, uploadPreviewEnd).map((preview, offset) => {
                    const index = uploadPreviewStart + offset;
                    return <figure key={preview.id} className="terminal-upload-preview" title={`Image ${index + 1}: ${preview.name}`}>
                      <button
                        type="button"
                        className="terminal-upload-open"
                        aria-label={`Open image ${index + 1}`}
                        onClick={(event) => {
                          uploadPreviewReturnFocusRef.current = event.currentTarget;
                          setSelectedUploadPreviewId(preview.id);
                        }}
                      >
                        <span className="terminal-upload-index" aria-hidden="true">
                          {index + 1}
                        </span>
                        <img src={preview.objectUrl} alt={`Image ${index + 1} preview`} decoding="async" onLoad={markUploadImageLoaded} onError={markUploadImageLoaded} />
                      </button>
                      <button
                        type="button"
                        className="terminal-upload-preview-delete"
                        aria-label={`Delete image ${index + 1}`}
                        title="Delete photo"
                        onClick={(event) => {
                          event.stopPropagation();
                          void removeUploadPreview(preview.id);
                        }}
                      >
                        <X size={11} aria-hidden="true" />
                      </button>
                    </figure>;
                  })}
                </div>
              </div>
            ) : null}
          </div>
        ) : null}
        {isGeminiRuntime && geminiAccountProfiles.length ? (
          <CliAccountPicker
            runtimeId="cli:gemini"
            providerLabel="Google"
            icon={<GoogleGIcon size={16} />}
            paneTitle={pane.title}
            profiles={geminiAccountProfiles}
            selectedProfileId={selectedGeminiAccountProfileId}
            disabled={pending || observerOnly}
            onSelect={(profileId) => switchCliAccountProfile("cli:gemini", profileId)}
            modelId={modelSettings?.current?.modelId ?? sessionResponse?.session.modelId ?? pane.modelId ?? null}
          />
        ) : null}
        {isCopilotRuntime && copilotAccountProfiles.length ? (
          <CliAccountPicker
            runtimeId="cli:copilot"
            providerLabel="GitHub"
            icon={<Github size={16} aria-hidden="true" />}
            paneTitle={pane.title}
            profiles={copilotAccountProfiles}
            selectedProfileId={selectedCopilotAccountProfileId}
            disabled={pending || observerOnly}
            onSelect={(profileId) => switchCliAccountProfile("cli:copilot", profileId)}
            auto={{ active: autoAccountMode, onSelect: () => selectAutoAccount("cli:copilot") }}
          />
        ) : null}
        {isCursorRuntime && cursorAccountProfiles.length ? (
          <CliAccountPicker
            runtimeId="cli:cursor"
            providerLabel="Cursor"
            icon={<TerminalIcon size={16} aria-hidden="true" />}
            paneTitle={pane.title}
            profiles={cursorAccountProfiles}
            selectedProfileId={selectedCursorAccountProfileId}
            disabled={pending || observerOnly}
            onSelect={(profileId) => switchCliAccountProfile("cli:cursor", profileId)}
            auto={{ active: autoAccountMode, onSelect: () => selectAutoAccount("cli:cursor") }}
          />
        ) : null}
        {isKimiRuntime && kimiAccountProfiles.length > 1 ? (
          <CliAccountPicker
            runtimeId="cli:kimi"
            providerLabel="Kimi"
            icon={<TerminalIcon size={16} aria-hidden="true" />}
            paneTitle={pane.title}
            profiles={kimiAccountProfiles}
            selectedProfileId={selectedKimiAccountProfileId}
            disabled={pending || observerOnly}
            onSelect={(profileId) => switchCliAccountProfile("cli:kimi", profileId)}
            auto={{ active: autoAccountMode, onSelect: () => selectAutoAccount("cli:kimi") }}
          />
        ) : null}
        {isClaudeRuntime && claudeAccountProfiles.length ? (
          <CliAccountPicker
            runtimeId="cli:claude"
            providerLabel="Claude"
            icon={<ClaudeIcon size={16} aria-hidden="true" />}
            paneTitle={pane.title}
            profiles={claudeAccountProfiles}
            selectedProfileId={selectedClaudeAccountProfileId}
            disabled={pending || observerOnly}
            onSelect={(profileId) => switchCliAccountProfile("cli:claude", profileId)}
          />
        ) : null}
        {isCodexRuntime ? <CodexAccountPicker paneTitle={pane.title} disabled={pending || observerOnly} /> : null}

        <div
          ref={transcriptRef}
          className={`terminal-viewport ${sessionResponse?.websocket ? "live" : ""}`}
          role="log"
          aria-live="polite"
          onContextMenu={(event) => {
            if (voiceInput.settings.terminalContextMenu === false) return;
            event.preventDefault();
            event.stopPropagation();
            const terminalSelection = terminalContextMenuSelection();
            setContextMenu({
              x: event.clientX,
              y: event.clientY,
              selection: terminalSelection.selection || (typeof window !== "undefined" ? window.getSelection()?.toString() ?? "" : ""),
              appSelection: terminalSelection.appSelection
            });
          }}
        >
          {sessionResponse?.websocket ? (
            <div ref={xtermHostRef} className="terminal-xterm" aria-label={`Live CLI pane ${pane.title.replace(/^Terminal\b/i, "CLI")}`} />
          ) : loading ? (
            <div className="terminal-empty">
              <Loader2 aria-hidden="true" />
              <span>Loading runtimes</span>
            </div>
          ) : sessionResponse?.transcript.length ? (
            sessionResponse.transcript.map((chunk) => (
              <div key={chunk.chunkId} className={`terminal-line ${chunk.stream}`}>
                <span>{streamLabel(chunk.stream)}</span>
                <code>{chunk.content}</code>
              </div>
            ))
          ) : (
            <div className="terminal-empty">
              <TerminalIcon aria-hidden="true" />
              <span>{selectedRuntime?.statusReason ?? "No CLI session"}</span>
            </div>
          )}
        </div>
        {isNormalAttachedCli && !hideFloatingControls ? (
          <div className="terminal-voice-controls-stack">
            {voiceStatusText ? (
              <div
                className={voiceInput.error ? "terminal-voice-status bad" : "terminal-voice-status"}
                role={voiceInput.error ? "alert" : "status"}
                aria-live={voiceRecording ? "off" : undefined}
              >
                <span>{voiceStatusText}</span>
                {voiceClock ? <span className="terminal-voice-clock" aria-hidden="true">{voiceClock}</span> : null}
                {voiceInput.error ? <button type="button" aria-label="Dismiss voice input error" onClick={() => voiceInput.clearError(voiceOwnerId)}><X aria-hidden="true" /></button> : null}
              </div>
            ) : null}
            {terminalLayoutSuggestion && isComposerSuggestionBarVisible(autocorrectSettings) ? (
              <div className="codex-layout-suggestion terminal-layout-suggestion" role="status" aria-live="polite">
                <Keyboard aria-hidden="true" style={{ width: 14, height: 14, flexShrink: 0 }} />
                <span className="codex-layout-suggestion-label">
                  Convert to: <strong>{terminalLayoutSuggestion.convertedText}</strong>
                </span>
                <button
                  type="button"
                  className="codex-layout-apply-btn"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={applyTerminalLayoutFix}
                  title="Apply layout conversion (Alt+G)"
                >
                  Fix (Alt+G)
                </button>
                <button
                  type="button"
                  className="codex-layout-dismiss-btn"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    dismissedTerminalLayoutTextRef.current = terminalPromptDraft.trim();
                    setTerminalLayoutSuggestion(null);
                  }}
                  aria-label="Dismiss layout suggestion"
                >
                  <X aria-hidden="true" style={{ width: 14, height: 14 }} />
                </button>
              </div>
            ) : null}
            {activeVariableToken ? (
              <PromptVariableAutocomplete
                query={activeVariableToken.query}
                selectedIndex={highlightedVariableIndex}
                onSelect={handleSelectPromptVariable}
                onClose={() => setDismissedVariableToken(activeVariableToken.token)}
                onOpenManager={(name) => {
                  setVariablesManagerInitialName(name ?? "");
                  setVariablesManagerOpen(true);
                }}
                onHighlightIndex={setSelectedVariableIndex}
              />
            ) : null}
            <div className="terminal-floating-controls">
              {!observerOnly && sessionResponse?.session.purpose === "NORMAL" && sessionResponse.session.runtimeId !== "cli:root" ? (
                localComposerOpen ? <div ref={setLocalComposerToolbar} className="local-cli-toolbar" data-local-cli-composer="" /> :
                  <button type="button" className="terminal-shortcuts-button" aria-label="Open local draft" title="Local draft"
                    onClick={() => toggleLocalComposer(true)}><NotebookPen aria-hidden="true" /></button>
              ) : null}
              {voiceInput.settings.terminalShortcutsButton ? (
                <CliShortcutsMenu commands={cliShortcutCommandsForRuntime(sessionResponse?.session.runtimeId)} showKeys transcriptCommand={cliTranscriptCommand(sessionResponse?.session.runtimeId)} disabled={terminalStatus !== "attached" || shortcutPending} active={isVisible && !pane.isMinimized} onCommand={runCliShortcut} />
              ) : null}
              {/* Hidden from the toolbar it still mounts while the autocomplete opens its manager. */}
              {voiceInput.settings.terminalVariablesButton || variablesManagerOpen ? <PromptVariablesMenu
                disabled={terminalStatus !== "attached" || shortcutPending}
                active={isVisible && !pane.isMinimized}
                paneTitle={pane.title}
                initialName={variablesManagerInitialName}
                open={variablesManagerOpen}
                onOpenChange={(nextOpen) => {
                  setVariablesManagerOpen(nextOpen);
                  if (!nextOpen) setVariablesManagerInitialName("");
                }}
                onInsertVariable={(variable) => {
                  sendTerminalInput(`#${variable.name} `, "insert prompt variable", "visible", true);
                  focusTerminal();
                }}
              /> : null}
              {isComposerLayoutIconVisible(autocorrectSettings) ? (
                <button
                  type="button"
                  className={`terminal-model-chip terminal-layout-toggle ${terminalLayoutSuggestion ? "has-suggestion" : ""}`}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={applyTerminalLayoutFix}
                  title={terminalLayoutSuggestion ? `Fix layout: "${terminalLayoutSuggestion.convertedText}" (Alt+G)` : "Fix keyboard layout (Alt+G) · Convert EN ⇄ EL"}
                  disabled={terminalStatus !== "attached" || !terminalPromptDraft.trim()}
                  aria-label="Fix keyboard layout (Alt+G)"
                >
                  <Keyboard aria-hidden="true" />
                </button>
              ) : null}
              {voiceInput.settings.terminalPlansButton ? (
                <CliPlansMenu pane={cliPlansMenuPane} disabled={shortcutPending} canSend={terminalStatus === "attached"} active={isVisible && !pane.isMinimized} onSelectPlan={handleSelectOpenPlan} onInsertPlan={handleInsertOpenPlan} draftWillBeCleared={planSendClearsDraft}
                  managedExecution={managedPlan.execution} managedSettings={modelSettings} managedError={managedPlan.error} managedPending={managedPlan.pending}
                  canControlManaged={terminalControlState === "CONTROLLER"} onManagedOverride={managedPlan.override} onManagedControl={managedPlan.control} onManagedRefresh={managedPlan.refresh} />
              ) : null}
              {voiceInput.settings.terminalVoiceButton ? (
                <VoiceInputButton label={pane.title.replace(/^Terminal\b/i, "CLI")} active={voiceOwned && voiceInput.status === "recording"} disabled={voiceDisabled} onClick={toggleTerminalVoiceCapture} onPrewarm={voiceInput.prewarm} />
              ) : null}
              {isCliModelSettingsSession && voiceInput.settings.terminalModelPicker ? modelSettings ? (
                <Suspense fallback={modelPickerLoadingFallback}>
                  <LazyCodexModelPicker
                    key={modelSettings.sessionId}
                    compact
                    allowSelectionWithoutCurrent
                    groupNativeProviders={selectedRuntime?.id === OPENCODE_CLI_RUNTIME_ID || selectedRuntime?.id === "cli:omp"}
                    settings={modelSettings}
                    selectionScope={hasManagedPlan && managedPlan.execution ? JSON.stringify([pane.id, modelSettings.sessionId, managedPlan.execution.id, managedPlan.execution.snapshot.stages[managedPlan.execution.activeStageIndex]?.id]) : undefined}
                    showLabel
                    disabled={terminalStatus !== "attached" || terminalControlState !== "CONTROLLER" ||
                      (!hasManagedPlan && modelSettings.controlMode === "NATIVE" && (isTurnRunning || Boolean(terminalPromptDraft.trim())))}
                    disabledReason={terminalStatus !== "attached"
                      ? "Available once the CLI is attached."
                      : terminalControlState !== "CONTROLLER"
                        ? "Another window controls this CLI."
                        : !hasManagedPlan && modelSettings.controlMode === "NATIVE" && isTurnRunning
                          ? "Available when the current turn finishes."
                          : !hasManagedPlan && modelSettings.controlMode === "NATIVE" && terminalPromptDraft.trim()
                            ? "Send or clear the typed prompt to change the model."
                            : null}
                    onRefreshCatalog={async () => {
                      const sessionId = sessionResponseRef.current?.session.sessionId;
                      if (sessionId) await refreshModelSettings(sessionId);
                    }}
                    onSwitch={(modelId, effort, providerId) => handleModelSwitch(modelId, effort, providerId, false, managedModelClickScope)}
                  />
                </Suspense>
              ) : (
                <div className="terminal-model-picker">
                  <button type="button"
                    className={`terminal-model-chip${pane.reasoningEffort ? " has-reasoning" : ""}`}
                    data-effort={pane.reasoningEffort ? pane.reasoningEffort.toLowerCase() : undefined}
                    aria-label={modelSettingsError ? "Retry model settings" : "Loading models"}
                    title={modelSettingsError ?? (pane.reasoningEffort ? `Loading models… (${reasoningEffortLabel(pane.reasoningEffort)})` : "Loading models…")}
                    disabled={!modelSettingsError || terminalStatus !== "attached"}
                    onClick={() => {
                      const sessionId = sessionResponseRef.current?.session.sessionId;
                      if (sessionId) { setModelSettingsError(null); void refreshModelSettings(sessionId); }
                    }}>
                    <BrainCircuit aria-hidden="true" />
                  </button>
                </div>
              ) : null}
              {/* With the local draft open its own send sits beside the draft; this one stays only to Stop or send typed terminal text. */}
              {isFloatingTurnControlSession && voiceInput.settings.terminalTurnControl && (!localComposerOpen || turnControlState !== "idle" || stopsBackgroundAgents || turnControlStopping) ? (
                <button
                  type="button"
                  className="terminal-turn-control"
                  data-state={turnControlStopping ? "stopping" : showsTurnStop ? "running" : turnControlState}
                  aria-label={turnControlStopping ? "Stopping…" : isTurnRunning ? floatingTurnControlStopLabel(sessionResponse?.session.runtimeId ?? null) : stopsBackgroundAgents ? BACKGROUND_AGENT_STOP_LABEL : "Send prompt"}
                  title={turnControlStopping ? "Stopping…" : isTurnRunning ? floatingTurnControlStopLabel(sessionResponse?.session.runtimeId ?? null) : stopsBackgroundAgents ? BACKGROUND_AGENT_STOP_LABEL : "Send prompt"}
                  disabled={turnControlStopping || (showsTurnStop ? terminalStatus !== "attached" : !canSendTurn)}
                  onClick={handleTurnControlClick}
                >
                  {turnControlStopping || showsTurnStop ? <Square aria-hidden="true" fill="currentColor" /> : <ArrowUp aria-hidden="true" />}
                </button>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>
      {localComposerOpen && !observerOnly && sessionResponse?.session.purpose === "NORMAL" && sessionResponse.session.runtimeId !== "cli:root" ? (
        <LocalCliComposer paneId={pane.id} paneTitle={pane.title} sessionId={sessionResponse.session.sessionId}
          nativeImages={usesNativeImagePaste} canSend={terminalStatus === "attached"}
          prepareSend={async () => {
            if (terminalPromptDraftRef.current.text.trim() || pendingTerminalInputsRef.current.length) return false;
            return waitForTerminalFileUploadControl();
          }}
          onUploaded={(files) => setUploadPreviews(current => [...current, ...files.filter(file => file.isImage && file.artifactId && !current.some(item => item.id === file.artifactId)).map(file => ({
            id: file.artifactId!, name: file.originalFilename, path: file.terminalPath, objectUrl: api.artifactFileUrl(file.artifactId!)
          }))])}
          onClose={() => toggleLocalComposer(false)} toolbar={localComposerToolbar} />
      ) : null}
      {contextMenu && typeof document !== "undefined" ? (() => {
        const contextMenuLeft = Math.max(8, Math.min(contextMenu.x, window.innerWidth - 210 - 8));
        const contextMenuTop = Math.max(8, Math.min(contextMenu.y, window.innerHeight - 180 - 8));
        return createPortal(
          <div
            ref={contextMenuRef}
            className="icon-context-menu terminal-context-menu"
            role="menu"
            aria-label={`Terminal context menu ${pane.title}`}
            {...portalThemeAttributes(xtermHostRef.current)}
            style={{ left: `${contextMenuLeft}px`, top: `${contextMenuTop}px` }}
          >
            <button
              type="button"
              role="menuitem"
              disabled={!contextMenu.selection}
              onClick={() => {
                setContextMenu(null);
                if (contextMenu.selection) {
                  void handleTerminalCopyShortcut(contextMenu.selection);
                }
              }}
            >
              <div className="terminal-context-menu-item-left">
                <Copy aria-hidden="true" />
                <span>Copy</span>
              </div>
              <kbd>Ctrl+C</kbd>
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setContextMenu(null);
                void (async () => {
                  try {
                    const clipboard = getSpaceRuntime().platform.clipboard;
                    const text = await clipboard?.readText?.();
                    if (text) {
                      const sent = await pasteClipboardTextToTerminal(text, "context menu paste", "context menu");
                      if (sent) {
                        setNotice("Pasted into CLI.");
                      }
                    } else {
                      setError("No text available in clipboard to paste.");
                    }
                    focusTerminal();
                  } catch (err) {
                    setError(err instanceof Error ? err.message : "Clipboard paste failed.");
                  }
                })();
              }}
            >
              <div className="terminal-context-menu-item-left">
                <Clipboard aria-hidden="true" />
                <span>Paste</span>
              </div>
              <kbd>Ctrl+V</kbd>
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setContextMenu(null);
                void (async () => {
                  try {
                    const clipboard = getSpaceRuntime().platform.clipboard;
                    const text = await clipboard?.readText?.();
                    if (text) {
                      await insertClipboardText(text, "context menu paste as file");
                      focusTerminal();
                    } else {
                      setError("No text available in clipboard to paste as file.");
                    }
                  } catch (err) {
                    setError(err instanceof Error ? err.message : "Clipboard paste as file failed.");
                  }
                })();
              }}
            >
              <div className="terminal-context-menu-item-left">
                <FileIcon aria-hidden="true" />
                <span>Attach as TXT file</span>
              </div>
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setContextMenu(null);
                terminalRef.current?.selectAll();
                setNotice("All pane text selected.");
                focusTerminal();
              }}
            >
              <div className="terminal-context-menu-item-left">
                <Maximize2 aria-hidden="true" />
                <span>Select all in pane</span>
              </div>
              <kbd>Ctrl+A</kbd>
            </button>
            <div className="terminal-context-menu-separator" role="separator" />
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setContextMenu(null);
                void copyTerminalContent();
              }}
            >
              <div className="terminal-context-menu-item-left">
                <TerminalIcon aria-hidden="true" />
                <span>Copy all contents</span>
              </div>
            </button>
            {contextMenu.selection && !contextMenu.appSelection ? (
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setContextMenu(null);
                  terminalRef.current?.clearSelection();
                  focusTerminal();
                }}
              >
                <div className="terminal-context-menu-item-left">
                  <X aria-hidden="true" />
                  <span>Clear selection</span>
                </div>
              </button>
            ) : null}
          </div>,
          document.body
        );
      })() : null}
      {photoContextMenu && typeof document !== "undefined" ? (() => {
        const contextMenuLeft = Math.max(8, Math.min(photoContextMenu.x, window.innerWidth - 180 - 8));
        const contextMenuTop = Math.max(8, Math.min(photoContextMenu.y, window.innerHeight - 120 - 8));
        return createPortal(
          <div
            ref={photoContextMenuRef}
            className="icon-context-menu terminal-context-menu terminal-photo-context-menu"
            role="menu"
            aria-label={`Photo options ${pane.title}`}
            {...portalThemeAttributes(xtermHostRef.current)}
            style={{ left: `${contextMenuLeft}px`, top: `${contextMenuTop}px` }}
          >
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setPhotoContextMenu(null);
                setUploadPreviewsOpen(true);
              }}
            >
              <div className="terminal-context-menu-item-left">
                <Images aria-hidden="true" />
                <span>View photos</span>
              </div>
            </button>
            <div className="terminal-context-menu-separator" role="separator" />
            <button
              type="button"
              role="menuitem"
              className="is-delete"
              disabled={!uploadPreviews.length}
              onClick={() => {
                setPhotoContextMenu(null);
                void clearUploadPreviews();
              }}
            >
              <div className="terminal-context-menu-item-left">
                <Trash2 aria-hidden="true" />
                <span>Delete photos</span>
              </div>
            </button>
          </div>,
          document.body
        );
      })() : null}
    </section>
  );
});
