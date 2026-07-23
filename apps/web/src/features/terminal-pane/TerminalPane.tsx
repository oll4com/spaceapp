import { ArrowUp, Loader2, Square, Terminal as TerminalIcon, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ClipboardEvent as ReactClipboardEvent, type DragEvent } from "react";
import type { IDisposable, Terminal as XtermTerminal } from "@xterm/xterm";
import type { FitAddon as XtermFitAddon } from "@xterm/addon-fit";
import {
  paneCliUploadMaxCount,
  paneCliSessionResponseSchema,
  paneCliWebSocketServerMessageSchema,
  type AgentRuntimeRegistry,
  type Pane,
  type PaneCliModelSettings,
  type PaneCliUploadSource,
  type PaneCliUploadedFile,
  type PaneCliSessionResponse,
  type PaneCliTurnActivityStatus
} from "@space/contracts";
import { SpaceApiError, api } from "../../api.js";
import { memoizeTerminalWidthMeasurements } from "./terminal-width-measure-cache.js";
import { DEMO_LOCAL_REPLY, getSpaceRuntime, terminalGateway, type PlatformGateway } from "../../runtime/SpaceRuntime.js";
import { DEFAULT_CLI_IMAGE_PREVIEW_LIMIT, normalizeCliImagePreviewLimit } from "../../cli-upload-settings.js";
import { isCliRuntimeTerminalLaunchable } from "../../cli-runtime-presentation.js";
import { recordLifecycleDebugEvent } from "../../lifecycle-debug.js";
import { CodexModelPicker } from "../codex-model-picker/CodexModelPicker.js";
import {
  SPACE_CLIPBOARD_ITEM_MIME,
  captureClipboardEventText,
  captureClipboardText,
  writeClipboardText
} from "../clipboard-dock/clipboard-events.js";
import { extractClipboardImageDataUrls } from "./clipboard-html.js";

export { CodexModelPicker };

interface TerminalPaneProps {
  pane: Pane;
  terminalFontSize: number;
  bootstrapBarrier?: TerminalBootstrapBarrier;
  shouldBootstrap?: boolean;
  isTarget?: boolean;
  isVisible?: boolean;
  hideFloatingControls?: boolean;
  cliDebugModeEnabled?: boolean;
  maxImagePreviews?: number;
  onCliDebugModeChange?: (enabled: boolean) => void;
  onSessionMetadataChange?: (metadata: TerminalSessionMetadata | null) => void;
  onBootstrapped?: (paneId: string) => void;
}

export interface TerminalBootstrapBarrier {
  join(paneId: string): {
    arrive(): Promise<void>;
  };
  waitForTerminalSetupTask(paneId: string): Promise<void>;
}

export function createTerminalBootstrapBarrier(paneIds: readonly string[]): TerminalBootstrapBarrier {
  const expectedPaneIds = new Set(paneIds);
  const currentTokens = new Map<string, symbol>();
  const arrivedPaneIds = new Set<string>();
  let joinVersion = 0;
  let released = expectedPaneIds.size === 0;
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
const CLAUDE_CLI_RUNTIME_ID = "cli:claude";
type NativePlanRuntimeId = "cli:gemini" | "cli:qwen";
const TERMINAL_PANE_ACTION_EVENT = "space:terminal-pane-action";
const CLI_DEBUG_MODE_STORAGE_KEY = "space.cliDebugMode";
const HIDDEN_INPUT_ECHO_TTL_MS = 5_000;
const PASTE_INPUT_GUARD_MS = 2_500;
const CLIPBOARD_FAILURE_OUTPUT_PATTERN =
  /Failed to paste image:|clipboard unavailable: Unknown error while interacting with the clipboard:|X11 server connection timed out because it was unreachable/i;
const CLIPBOARD_FAILURE_REPORT_WINDOW_MS = 20_000;
const CLIPBOARD_FAILURE_SUPPRESS_AFTER_UPLOAD_MS = 10_000;
const CLIPBOARD_STALL_TIMEOUT_MS = 3_500;
const TERMINAL_PASTE_RECENT_INTENT_MS = 15_000;
const TERMINAL_REFIT_STABILIZE_DELAY_MS = 48;
const TERMINAL_OUTPUT_REFIT_INTERVAL_MS = 500;
const TERMINAL_BROKEN_MAX_COLS = 8;
const TERMINAL_BROKEN_MIN_HOST_WIDTH_PX = 240;
const CLI_RECONNECT_DELAYS_MS = [250, 1000, 2000, 5000, 10000] as const;
const CLI_RECONNECT_JITTER_MS = 100;
const CLI_TURN_ACTIVITY_POLL_MS = 900;
const CLI_MODEL_SETTINGS_REFRESH_DELAY_MS = 400;
const CLI_MODEL_SETTINGS_STARTUP_RETRY_DELAYS_MS = [250, 500, 1_000, 2_000] as const;
const CLI_TURN_ACTIVITY_DISCOVERY_GRACE_MS = 5_000;
const ACTIVE_CLI_TURN_STORAGE_PREFIX = "space.cliActiveTurn:";
const CLI_TURN_MARKER_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ANSI_ESCAPE_PATTERN = /\u001B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;
const CONTROL_SEQUENCE_PATTERN = /[\u0000-\u0008\u000b-\u001f\u007f]/g;
const HIDDEN_UPLOAD_NOTICE = "Upload inserted hidden.";
const LARGE_CLIPBOARD_TEXT_NOTICE = "Large clip inserted as TXT.";
const HIDDEN_UPLOAD_NOTICE_DISMISS_MS = 1_600;
const CLIPBOARD_TEXT_INLINE_MAX_CODE_POINTS = 8_000;
const BRACKETED_PASTE_START = "\u001b[200~";
const BRACKETED_PASTE_END = "\u001b[201~";

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
type TerminalConnectionAlert = { message: string; tone: "warn" | "good" | "bad" };
type ActiveCliTurn = { marker: string; status: Extract<PaneCliTurnActivityStatus, "PENDING" | "RUNNING"> };
type StoredActiveCliTurn = ActiveCliTurn & { sessionId: string };

type TerminalPaneActionDetail =
  | { paneId: string; action: "upload" | "reconnect" | "copy" | "focus" | "cancel_login" }
  | { paneId: string; action: "attach_clip_image"; file: File }
  | { paneId: string; action: "insert_text"; text: string }
  | { paneId: string; action: "insert_clipboard_text"; text: string }
  | { paneId: string; action: "ensure_plan_mode" }
  | { paneId: string; action: "enter_native_plan_mode"; runtimeId: NativePlanRuntimeId }
  | { paneId: string; action: "control_key"; key: "shift_tab" | "escape" }
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

interface TerminalUploadPreview {
  id: string;
  name: string;
  path: string;
  objectUrl: string;
}

interface HiddenInputEchoFilter {
  value: string;
  remaining: string;
  expiresAtMs: number;
}

interface ModelSettingsOutputRefreshArm {
  socket: WebSocket;
  sessionId: string;
  token: number;
  outputRevision: number;
  terminal: XtermTerminal;
  ignoredScreenText: string | null;
  baselineScreen: string;
}

type TerminalWebSocketTicket = NonNullable<PaneCliSessionResponse["websocket"]>;
type BufferedTerminalSocketEvent =
  | { type: "message"; event: MessageEvent }
  | { type: "disconnect"; event: Event };

interface BufferedTerminalSocket {
  ticket: TerminalWebSocketTicket;
  socket: WebSocket;
  events: BufferedTerminalSocketEvent[];
  preopen: Promise<void>;
  stopBuffering(): void;
}

const TERMINAL_SOCKET_PREOPEN_TIMEOUT_MS = 400;
const TERMINAL_REPLAY_WRITE_CHUNK_SIZE = 32 * 1024;
const TERMINAL_SOCKET_SUPERSEDED_CLOSE_CODE = 4001;

interface BrowserTaskScheduler {
  yield?: () => Promise<void>;
}

function yieldForTerminalReplay(): Promise<void> {
  const scheduler = (globalThis as typeof globalThis & { scheduler?: BrowserTaskScheduler }).scheduler;
  if (scheduler?.yield) return scheduler.yield();
  return new Promise<void>((resolve) => window.setTimeout(resolve, 0));
}

export function createTerminalReplayWriteQueue(
  write: (data: string) => Promise<void>,
  yieldControl: () => Promise<void> = yieldForTerminalReplay
) {
  let tail = Promise.resolve();
  let hasWritten = false;
  let disposed = false;

  return {
    enqueue(data: string): Promise<void> {
      if (!data || disposed) return tail;
      const operation = tail.then(async () => {
        if (disposed) return;
        if (hasWritten) await yieldControl();
        if (disposed) return;
        await write(data);
        hasWritten = true;
      });
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

function createBufferedTerminalSocket(ticket: TerminalWebSocketTicket): BufferedTerminalSocket {
  const socket = terminalGateway.connect(api.cliTerminalWebSocketUrl(ticket));
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
  return { ticket, socket, events, preopen, stopBuffering };
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

export function isRetryableCliReconnectError(error: unknown): boolean {
  if (error instanceof SpaceApiError) {
    return error.status === 0 || error.status === 429 || error.status >= 500;
  }
  return error instanceof TypeError;
}

export function buildTerminalCliSessionRequest(
  pane: Pick<Pane, "reasoningEffort" | "cwd">,
  runtimeId: string,
  input: { modelId?: string | null; forceRestart?: boolean; resume?: boolean } = {},
  automaticReconnect = false
) {
  return {
    runtimeId,
    ...(automaticReconnect
      ? {}
      : {
          ...(input.modelId !== undefined ? { modelId: input.modelId } : {}),
          reasoningEffort: pane.reasoningEffort,
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
      const flight = request().finally(() => {
        if (sessionRequestFlight === flight) sessionRequestFlight = null;
      });
      sessionRequestFlight = flight;
      return flight;
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

function isRecoverableCliSession(session: PaneCliSessionResponse["session"] | null | undefined): boolean {
  return Boolean(session?.isActive && session.status !== "EXITED" && session.status !== "ERROR");
}

function streamLabel(stream: string): string {
  if (stream === "stderr") return "err";
  if (stream === "stdin") return "in";
  if (stream === "system") return "sys";
  return "out";
}

function seedTerminalTranscript(terminal: XtermTerminal, sessionResponse: PaneCliSessionResponse): string | null {
  const shouldSeedOutputTranscript = sessionResponse.session.status !== "RUNNING";
  let seededSystemTranscript = false;
  for (const chunk of sessionResponse.transcript) {
    if (chunk.stream === "stdin") continue;
    if ((chunk.stream === "stdout" || chunk.stream === "stderr") && !shouldSeedOutputTranscript) continue;
    if (chunk.stream === "system") seededSystemTranscript = true;
    const content =
      chunk.stream === "system" && !chunk.content.endsWith("\n") ? `${chunk.content}\r\n` : chunk.content;
    if (!content) continue;
    terminal.write(content);
  }
  if (
    !seededSystemTranscript &&
    sessionResponse.session.status === "IDLE" &&
    sessionResponse.session.statusReason
  ) {
    terminal.write(`${sessionResponse.session.statusReason}\r\n`);
    return sessionResponse.session.statusReason;
  }
  return null;
}

function isTerminalPaneAction(detail: unknown): detail is TerminalPaneActionDetail {
  if (typeof detail !== "object" || detail === null) return false;
  const maybeDetail = detail as {
    paneId?: unknown;
    action?: unknown;
    file?: unknown;
    text?: unknown;
    key?: unknown;
    runtimeId?: unknown;
    session?: unknown;
    modelId?: unknown;
    memory?: { scope?: unknown; roomId?: unknown; title?: unknown; provenance?: unknown };
  };
  if (typeof maybeDetail.paneId !== "string") return false;
  if (
    maybeDetail.action === "upload" ||
    maybeDetail.action === "reconnect" ||
    maybeDetail.action === "copy" ||
    maybeDetail.action === "focus" ||
    maybeDetail.action === "cancel_login" ||
    maybeDetail.action === "ensure_plan_mode"
  ) return true;
  if (maybeDetail.action === "attach_clip_image") {
    return maybeDetail.file instanceof File && SUPPORTED_CLIPBOARD_IMAGE_TYPES.has(maybeDetail.file.type.toLowerCase());
  }
  if (maybeDetail.action === "insert_text" || maybeDetail.action === "insert_clipboard_text") {
    return typeof maybeDetail.text === "string";
  }
  if (maybeDetail.action === "control_key") return maybeDetail.key === "shift_tab" || maybeDetail.key === "escape";
  if (maybeDetail.action === "enter_native_plan_mode") {
    return maybeDetail.runtimeId === "cli:gemini" || maybeDetail.runtimeId === "cli:qwen";
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

function measureTerminalCharacterSize(terminal: XtermTerminal | null) {
  const core = (terminal as (XtermTerminal & { _core?: XtermPrivateCore }) | null)?._core;
  core?._charSizeService?.measure();
}

function terminalHostWidth(host: HTMLElement | null): number {
  if (!host) return 0;
  return host.clientWidth || host.getBoundingClientRect().width || 0;
}

function terminalLooksGeometryBroken(terminal: XtermTerminal | null, host: HTMLElement | null): boolean {
  return Boolean(terminal && host && terminal.cols <= TERMINAL_BROKEN_MAX_COLS && terminalHostWidth(host) >= TERMINAL_BROKEN_MIN_HOST_WIDTH_PX);
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

function clipboardTextFilename(now = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `space-clipboard-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}.txt`;
}

function containsCliUploadPath(text: string): boolean {
  return text.includes("/opt/spaceapp/var/artifacts/cli-uploads/") || text.includes("/cli-uploads/");
}

function hiddenEchoCandidates(data: string): string[] {
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

function scrollTerminalViewportByTouchDelta(viewport: HTMLElement, deltaY: number): boolean {
  const maxScrollTop = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
  if (maxScrollTop <= 0) return false;
  const previousScrollTop = viewport.scrollTop;
  const nextScrollTop = Math.max(0, Math.min(maxScrollTop, previousScrollTop + deltaY));
  if (nextScrollTop === previousScrollTop) return false;
  viewport.scrollTop = nextScrollTop;
  return true;
}

function scrollXtermByTouchDelta(terminal: XtermTerminal | null, deltaY: number, fontSize: number): boolean {
  if (!terminal) return false;
  const buffer = terminal.buffer.active;
  if (deltaY > 0 && buffer.viewportY >= buffer.baseY) return false;
  if (deltaY < 0 && buffer.viewportY <= 0) return false;

  const lineHeightPx = Math.max(10, Math.round(fontSize * 1.35));
  const lineDelta =
    deltaY > 0
      ? Math.max(1, Math.floor(deltaY / lineHeightPx))
      : Math.min(-1, Math.ceil(deltaY / lineHeightPx));
  terminal.scrollLines(lineDelta);
  return true;
}

function isPasteShortcutEvent(event: Pick<KeyboardEvent, "altKey" | "code" | "ctrlKey" | "defaultPrevented" | "key" | "metaKey" | "shiftKey">): boolean {
  if (event.defaultPrevented || event.altKey || event.shiftKey || (!event.ctrlKey && !event.metaKey)) return false;
  if (event.code === "KeyV") return true;
  return event.key.toLowerCase() === "v";
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
  return extractClipboardImageDataUrls(html)
    .map((src, index) => fileFromDataUrl(src, index + 1))
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

export function nameTerminalInput(textarea: HTMLTextAreaElement | undefined) {
  if (textarea) textarea.name = "terminal-input";
}

function terminalSemanticScreenFingerprint(terminal: XtermTerminal, ignoredText: string | null = null): string {
  const buffer = terminal.buffer.active;
  const firstLine = Math.max(0, buffer.baseY);
  const lastLine = Math.min(buffer.length, firstLine + Math.max(1, terminal.rows));
  let visibleText = "";
  for (let lineIndex = firstLine; lineIndex < lastLine; lineIndex += 1) {
    visibleText += buffer.getLine(lineIndex)?.translateToString(true) ?? "";
  }
  const fingerprint = visibleText.replace(/\s+/g, "");
  const ignoredFingerprint = ignoredText?.replace(/\s+/g, "") ?? "";
  return ignoredFingerprint ? fingerprint.replace(ignoredFingerprint, "") : fingerprint;
}

function stripSyntheticTerminalPrefix(content: string, syntheticText: string): string {
  const normalizedSyntheticText = syntheticText.replace(/\r\n?/g, "\n").trimEnd();
  if (!normalizedSyntheticText) return content;
  if (content === normalizedSyntheticText) return "";
  const prefix = `${normalizedSyntheticText}\n`;
  return content.startsWith(prefix) ? content.slice(prefix.length) : content;
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

type ClaudePermissionMode = "default mode" | "accept edits on" | "plan mode on" | "bypass permissions on" | "auto mode on";
const CLAUDE_PLAN_MODE_SHIFT_TABS: Record<ClaudePermissionMode, number> = {
  "default mode": 2,
  "accept edits on": 1,
  "plan mode on": 0,
  "bypass permissions on": 4,
  "auto mode on": 3
};

function claudePermissionMode(screenText: string): ClaudePermissionMode | null {
  const footerLines = screenText
    .split(/\r?\n/)
    .map((line) => line.toLowerCase().replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .slice(-4);
  const modes: ClaudePermissionMode[] = ["accept edits on", "plan mode on", "bypass permissions on", "auto mode on"];
  const candidates: Array<{ mode: ClaudePermissionMode; lineIndex: number; columnIndex: number }> = [];
  footerLines.forEach((line, lineIndex) => {
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

export function shouldRefocusTerminalAfterInput(data: string): boolean {
  return data !== "\u001b[I" && data !== "\u001b[O";
}

function nextTerminalPromptDraft(draft: string, data: string): string {
  let next = draft;
  for (let index = 0; index < data.length; index += 1) {
    const character = data[index] ?? "";
    if (character === "\u001b") {
      const controlString = /^\u001b(?:\][^\u0007]*(?:\u0007|\u001b\\)|[PX^_][\s\S]*?\u001b\\)/.exec(data.slice(index));
      if (controlString) {
        index += controlString[0].length - 1;
        continue;
      }
      const sequence = /^\u001b(?:\[[0-?]*[ -/]*[@-~]|[@-Z\\-_])/.exec(data.slice(index));
      if (sequence) index += sequence[0].length - 1;
      continue;
    }
    if (character === "\r" || character === "\n" || character === "\u0015") {
      next = "";
      continue;
    }
    if (character === "\b" || character === "\u007f") {
      next = next.slice(0, -1);
      continue;
    }
    if (character >= " ") next += character;
  }
  return next;
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

export function TerminalPane({
  pane,
  terminalFontSize,
  bootstrapBarrier,
  shouldBootstrap = true,
  isTarget = true,
  isVisible = true,
  hideFloatingControls = false,
  cliDebugModeEnabled,
  maxImagePreviews = DEFAULT_CLI_IMAGE_PREVIEW_LIMIT,
  onCliDebugModeChange,
  onSessionMetadataChange,
  onBootstrapped
}: TerminalPaneProps) {
  const [registry, setRegistry] = useState<AgentRuntimeRegistry | null>(null);
  const [selectedRuntimeId, setSelectedRuntimeId] = useState(pane.terminalRuntimeId ?? DEFAULT_CLI_RUNTIME_ID);
  const [sessionResponse, setSessionResponse] = useState<PaneCliSessionResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [clipboardDebug, setClipboardDebug] = useState<ClipboardDebugState | null>(null);
  const [clipboardDebugHistory, setClipboardDebugHistory] = useState<ClipboardDebugState[]>([]);
  const [dismissedClipboardDebugAt, setDismissedClipboardDebugAt] = useState<string | null>(null);
  const [uploadPreviews, setUploadPreviews] = useState<TerminalUploadPreview[]>([]);
  const [selectedUploadPreviewId, setSelectedUploadPreviewId] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const [terminalStatus, setTerminalStatus] = useState<TerminalConnectionStatus>("idle");
  const [terminalReplayReady, setTerminalReplayReady] = useState(false);
  const [connectionAlert, setConnectionAlert] = useState<TerminalConnectionAlert | null>(null);
  const [terminalPromptDraft, setTerminalPromptDraft] = useState("");
  const [activeCliTurn, setActiveCliTurn] = useState<ActiveCliTurn | null>(null);
  const [modelSettings, setModelSettings] = useState<PaneCliModelSettings | null>(null);
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  const xtermHostRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const terminalRef = useRef<XtermTerminal | null>(null);
  const fitAddonRef = useRef<XtermFitAddon | null>(null);
  const terminalFontSizeRef = useRef(terminalFontSize);
  const socketRef = useRef<WebSocket | null>(null);
  const bufferedSocketRef = useRef<BufferedTerminalSocket | null>(null);
  const loadRuntimesGenerationRef = useRef(0);
  const readySocketRef = useRef<{ socket: WebSocket; sessionId: string } | null>(null);
  const sessionResponseRef = useRef<PaneCliSessionResponse | null>(null);
  const syntheticTerminalSeedRef = useRef<{ sessionId: string; content: string } | null>(null);
  const autoAttachAttemptRef = useRef<string | null>(null);
  const pasteShortcutFallbackRef = useRef<number | null>(null);
  const isTargetRef = useRef(isTarget);
  isTargetRef.current = isTarget;
  const pasteInputGuardRef = useRef<{ source: string; expiresAtMs: number } | null>(null);
  const reconnectAttemptRef = useRef(0);
  const reconnectTimerRef = useRef<number | null>(null);
  const reconnectCoordinatorRef = useRef(createTerminalReconnectCoordinator());
  const modelSettingsRefreshTimerRef = useRef<number | null>(null);
  const modelSettingsOutputRefreshArmRef = useRef<ModelSettingsOutputRefreshArm | null>(null);
  const modelSettingsOutputRefreshTokenRef = useRef(0);
  const modelSettingsRefreshGenerationRef = useRef(0);
  const modelSettingsRef = useRef<PaneCliModelSettings | null>(null);
  modelSettingsRef.current = modelSettings;
  const hiddenInputEchoFiltersRef = useRef<HiddenInputEchoFilter[]>([]);
  const clipboardDebugHistoryRef = useRef<ClipboardDebugState[]>([]);
  const lastClipboardReportRef = useRef<{ key: string; atMs: number } | null>(null);
  const previousUploadPreviewsRef = useRef<TerminalUploadPreview[]>([]);
  const clipboardPasteAttemptRef = useRef<ClipboardPasteAttempt | null>(null);
  const clipboardAttemptTimerRef = useRef<number | null>(null);
  const lastTerminalIntentAtRef = useRef(0);
  const isVisibleRef = useRef(isVisible);
  const scheduledTerminalRepaintFrameRef = useRef<number | null>(null);
  const lastTerminalOutputRefitAtRef = useRef(0);
  const scheduledTerminalRefitFrameRef = useRef<number | null>(null);
  const scheduledTerminalRefitTimerRef = useRef<number | null>(null);
  const scheduledTerminalRefitFontsTicketRef = useRef(0);
  const claudePlanModeActionPendingRef = useRef(false);
  const bootstrapReportedRef = useRef(false);

  const cliRuntimes = useMemo(
    () => (registry?.data ?? []).filter((runtime) => runtime.capabilities.includes("CLI")),
    [registry]
  );
  const selectedRuntime = useMemo(
    () => cliRuntimes.find((runtime) => runtime.id === selectedRuntimeId) ?? cliRuntimes[0] ?? null,
    [cliRuntimes, selectedRuntimeId]
  );
  const selectedUploadPreviewIndex = useMemo(
    () => uploadPreviews.findIndex((preview) => preview.id === selectedUploadPreviewId),
    [selectedUploadPreviewId, uploadPreviews]
  );
  const selectedUploadPreview = selectedUploadPreviewIndex >= 0 ? uploadPreviews[selectedUploadPreviewIndex] ?? null : null;
  const selectedUploadPreviewLabel = selectedUploadPreviewIndex >= 0 ? `Image ${selectedUploadPreviewIndex + 1}` : "Image";
  const isTerminalLoginSession = sessionResponse?.session.purpose === "LOGIN";
  const activeRuntimeId = sessionResponse?.session.runtimeId ?? selectedRuntimeId;
  const supportsCliFileUploads = activeRuntimeId !== "cli:deepseek";
  const canUpload = Boolean(
    supportsCliFileUploads &&
    sessionResponse?.session.purpose === "NORMAL" &&
      sessionResponse.session.isActive &&
      sessionResponse.websocket &&
      !uploading
  );
  const activeTurnMarker = activeCliTurn?.marker ?? null;
  const isCodexCliSession = sessionResponse?.session.purpose === "NORMAL" && sessionResponse.session.runtimeId === DEFAULT_CLI_RUNTIME_ID;
  const isTurnRunning = Boolean(activeCliTurn || modelSettings?.isTurnActive);
  const turnControlState = isTurnRunning ? "running" : terminalPromptDraft.trim() && isCodexCliSession && terminalStatus === "attached" ? "ready" : "idle";
  const canSendTurn = turnControlState === "ready";
  const showCliDebugMode = cliDebugModeEnabled ?? readStoredCliDebugMode();
  const imagePreviewLimit = normalizeCliImagePreviewLimit(maxImagePreviews);
  const showClipboardDebugPanel = Boolean(
    clipboardDebug &&
      clipboardDebug.at !== dismissedClipboardDebugAt &&
      showCliDebugMode
  );
  const priorClipboardDebugEntries = clipboardDebugHistory.slice(0, -1).reverse();

  useEffect(() => {
    recordLifecycleDebugEvent({
      type: "component_mounted",
      scope: "TerminalPane",
      detail: `pane=${pane.title}`,
      paneId: pane.id,
      paneMode: pane.mode
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
        detail: `pane=${pane.title}`,
        paneId: pane.id,
        paneMode: pane.mode
      });
    };
  }, [pane.id, pane.mode, pane.title]);

  async function refreshModelSettings(expectedSessionId: string): Promise<boolean> {
    const generation = modelSettingsRefreshGenerationRef.current;
    try {
      const result = await api.cliModelSettingsStatus(pane.id);
      const activeSession = sessionResponseRef.current?.session;
      if (
        modelSettingsRefreshGenerationRef.current !== generation ||
        !activeSession?.isActive ||
        activeSession.purpose !== "NORMAL" ||
        activeSession.runtimeId !== DEFAULT_CLI_RUNTIME_ID ||
        activeSession.sessionId !== expectedSessionId
      ) {
        return false;
      }
      if (result.status === "UNAVAILABLE") {
        if (modelSettingsRef.current?.sessionId === expectedSessionId) {
          return true;
        }
        return false;
      }
      const settings = result.settings;
      if (settings.sessionId !== expectedSessionId) return false;
      modelSettingsRef.current = settings;
      setModelSettings(settings);
      return true;
    } catch {
      const activeSession = sessionResponseRef.current?.session;
      if (
        modelSettingsRefreshGenerationRef.current !== generation ||
        !activeSession?.isActive ||
        activeSession.purpose !== "NORMAL" ||
        activeSession.runtimeId !== DEFAULT_CLI_RUNTIME_ID ||
        activeSession.sessionId !== expectedSessionId
      ) {
        return false;
      }
      if (modelSettingsRef.current?.sessionId === expectedSessionId) {
        return true;
      }
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
        session.runtimeId === DEFAULT_CLI_RUNTIME_ID &&
        session.sessionId === arm.sessionId &&
        socket === arm.socket &&
        socket.readyState === WebSocket.OPEN &&
        readySocketRef.current?.socket === arm.socket &&
        readySocketRef.current.sessionId === arm.sessionId &&
        terminalRef.current === arm.terminal
    );
  }

  function armModelSettingsOutputRefresh(data: string, socket: WebSocket, sessionId: string, terminal: XtermTerminal | null) {
    if (!terminal || !shouldRefreshCliModelSettings("input", data)) return;
    if (modelSettingsRefreshTimerRef.current !== null) {
      window.clearTimeout(modelSettingsRefreshTimerRef.current);
      modelSettingsRefreshTimerRef.current = null;
    }
    const syntheticSeed = syntheticTerminalSeedRef.current?.sessionId === sessionId
      ? syntheticTerminalSeedRef.current.content
      : null;
    modelSettingsOutputRefreshArmRef.current = {
      socket,
      sessionId,
      token: modelSettingsOutputRefreshTokenRef.current + 1,
      outputRevision: 0,
      terminal,
      ignoredScreenText: syntheticSeed,
      baselineScreen: terminalSemanticScreenFingerprint(terminal, syntheticSeed)
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
    if (terminalSemanticScreenFingerprint(arm.terminal, arm.ignoredScreenText) === arm.baselineScreen) {
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
        terminalSemanticScreenFingerprint(currentArm.terminal, currentArm.ignoredScreenText) === currentArm.baselineScreen
      ) return;
      modelSettingsOutputRefreshArmRef.current = null;
      void refreshModelSettings(currentArm.sessionId);
    }, CLI_MODEL_SETTINGS_REFRESH_DELAY_MS);
  }

  useEffect(() => {
    sessionResponseRef.current = sessionResponse;
  }, [sessionResponse]);

  useEffect(() => {
    const session = sessionResponse?.session;
    if (!session) {
      setActiveCliTurn(null);
    } else if (session.purpose === "NORMAL" && session.runtimeId === DEFAULT_CLI_RUNTIME_ID && session.isActive) {
      setActiveCliTurn(readStoredActiveCliTurn(pane.id, session.sessionId));
    } else {
      clearStoredActiveCliTurn(pane.id);
      setActiveCliTurn(null);
    }
    setTerminalPromptDraft("");
  }, [pane.id, sessionResponse?.session.isActive, sessionResponse?.session.purpose, sessionResponse?.session.runtimeId, sessionResponse?.session.sessionId]);

  useEffect(() => {
    const session = sessionResponse?.session;
    if (
      !sessionResponse?.websocket ||
      !session?.isActive ||
      session.purpose !== "NORMAL" ||
      session.runtimeId !== DEFAULT_CLI_RUNTIME_ID ||
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
    }
    const generation = modelSettingsRefreshGenerationRef.current;
    let disposed = false;
    let retryTimer: number | null = null;
    const loadStartupModelSettings = async (attempt: number) => {
      const loaded = await refreshModelSettings(session.sessionId);
      if (disposed || modelSettingsRefreshGenerationRef.current !== generation || loaded) return;
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
    if (!modelSettings?.isTurnActive || activeCliTurn || !sessionResponse?.session.isActive) return;
    let disposed = false;
    const timer = window.setTimeout(() => {
      if (!disposed) void refreshModelSettings(sessionResponse.session.sessionId);
    }, CLI_TURN_ACTIVITY_POLL_MS);
    return () => {
      disposed = true;
      window.clearTimeout(timer);
    };
  }, [activeCliTurn, modelSettings?.isTurnActive, pane.id, sessionResponse?.session.isActive, sessionResponse?.session.sessionId]);

  useEffect(() => {
    if (!activeTurnMarker || !isCodexCliSession || !sessionResponse?.session.isActive) return;
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
        if (activity.status === "PENDING" || activity.status === "RUNNING") {
          const status: ActiveCliTurn["status"] = activity.status;
          const nextTurn = { marker: activeTurnMarker, status };
          setActiveCliTurn((current) =>
            current?.marker === activeTurnMarker ? nextTurn : current
          );
          storeActiveCliTurn(pane.id, sessionResponse.session.sessionId, nextTurn);
          schedulePoll();
          return;
        }
        if (activity.status === "UNAVAILABLE" && Date.now() < discoveryDeadlineMs) {
          schedulePoll();
          return;
        }
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
  }, [activeTurnMarker, isCodexCliSession, pane.id, sessionResponse?.session.isActive, sessionResponse?.session.sessionId]);

  useEffect(() => {
    isVisibleRef.current = isVisible;
  }, [isVisible]);

  useEffect(() => {
    setDismissedClipboardDebugAt(null);
  }, [pane.id]);

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
      const bufferedSocket = createBufferedTerminalSocket(ticket);
      bufferedSocketRef.current = bufferedSocket;
      return bufferedSocket;
    }
    return null;
  }

  async function loadRuntimes(showLoading = true) {
    const generation = ++loadRuntimesGenerationRef.current;
    const bootstrapParticipant = bootstrapBarrier?.join(pane.id);
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
        .finally(() => bootstrapParticipant?.arrive());
      const [nextRegistry, activeSession] = await Promise.all([
        api.cliRuntimes({ allowStale: true }),
        activeSessionPromise
      ]);
      allowEarlyPreconnect = false;
      if (generation !== loadRuntimesGenerationRef.current) return;
      setRegistry(nextRegistry);
      const runtimes = nextRegistry.data.filter((runtime) => runtime.capabilities.includes("CLI"));
      if (activeSession && isRecoverableCliSession(activeSession.session)) {
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
      } else if (!runtimes.some((runtime) => runtime.id === selectedRuntimeId)) {
        setSelectedRuntimeId(runtimes.find((runtime) => runtime.id === DEFAULT_CLI_RUNTIME_ID)?.id ?? runtimes[0]?.id ?? DEFAULT_CLI_RUNTIME_ID);
      }
    } catch (err) {
      allowEarlyPreconnect = false;
      if (generation === loadRuntimesGenerationRef.current) {
        if (earlyBufferedSocket && bufferedSocketRef.current === earlyBufferedSocket) {
          bufferedSocketRef.current = null;
          closeBufferedTerminalSocket(earlyBufferedSocket);
        }
        setError(err instanceof Error ? err.message : "CLI runtimes failed to load");
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
      return;
    }
    void loadRuntimes();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pane.id, shouldBootstrap]);

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
    const previous = previousUploadPreviewsRef.current;
    const currentObjectUrls = new Set(uploadPreviews.map((preview) => preview.objectUrl));
    for (const preview of previous) {
      if (!currentObjectUrls.has(preview.objectUrl)) {
        URL.revokeObjectURL(preview.objectUrl);
      }
    }
    previousUploadPreviewsRef.current = uploadPreviews;
  }, [uploadPreviews]);

  useEffect(
    () => () => {
      for (const preview of previousUploadPreviewsRef.current) {
        URL.revokeObjectURL(preview.objectUrl);
      }
    },
    []
  );

  useEffect(() => {
    if (notice !== HIDDEN_UPLOAD_NOTICE && notice !== LARGE_CLIPBOARD_TEXT_NOTICE) return;
    const timer = window.setTimeout(() => {
      setNotice((current) => (current === notice ? null : current));
    }, HIDDEN_UPLOAD_NOTICE_DISMISS_MS);
    return () => window.clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    if (loading || pending || sessionResponse || !selectedRuntime || !isCliRuntimeTerminalLaunchable(selectedRuntime)) return;
    const attemptKey = `${pane.id}:${selectedRuntime.id}`;
    if (autoAttachAttemptRef.current === attemptKey) return;
    autoAttachAttemptRef.current = attemptKey;
    void startOrReconnect();
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

  useEffect(() => {
    setUploadPreviews((current) => (current.length > imagePreviewLimit ? current.slice(-imagePreviewLimit) : current));
  }, [imagePreviewLimit]);

  useEffect(() => {
    if (!selectedUploadPreview) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setSelectedUploadPreviewId(null);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [selectedUploadPreview]);

  useEffect(() => {
    terminalFontSizeRef.current = terminalFontSize;
    if (!terminalRef.current) return;
    terminalRef.current.options.fontSize = terminalFontSize;
    scheduleTerminalRefit();
  }, [terminalFontSize]);

  useEffect(() => {
    const host = xtermHostRef.current;
    if (!host || !sessionResponse?.websocket) return;

    let lastTouchY: number | null = null;
    const findViewport = () => host.querySelector<HTMLElement>(".xterm-viewport");
    const handleTouchStart = (event: TouchEvent) => {
      if (event.touches.length !== 1) {
        lastTouchY = null;
        return;
      }
      lastTouchY = event.touches[0]?.clientY ?? null;
    };
    const handleTouchMove = (event: TouchEvent) => {
      if (lastTouchY === null || event.touches.length !== 1) return;
      const nextTouchY = event.touches[0]?.clientY;
      if (typeof nextTouchY !== "number") return;
      const deltaY = lastTouchY - nextTouchY;
      lastTouchY = nextTouchY;
      if (Math.abs(deltaY) < 1) return;
      const viewport = findViewport();
      const didScroll =
        (viewport ? scrollTerminalViewportByTouchDelta(viewport, deltaY) : false) ||
        scrollXtermByTouchDelta(terminalRef.current, deltaY, terminalFontSizeRef.current);
      if (didScroll) {
        event.preventDefault();
      }
    };
    const clearTouch = () => {
      lastTouchY = null;
    };

    host.addEventListener("touchstart", handleTouchStart, { capture: true, passive: true });
    host.addEventListener("touchmove", handleTouchMove, { capture: true, passive: false });
    host.addEventListener("touchend", clearTouch, { capture: true });
    host.addEventListener("touchcancel", clearTouch, { capture: true });
    return () => {
      host.removeEventListener("touchstart", handleTouchStart, { capture: true });
      host.removeEventListener("touchmove", handleTouchMove, { capture: true });
      host.removeEventListener("touchend", clearTouch, { capture: true });
      host.removeEventListener("touchcancel", clearTouch, { capture: true });
    };
  }, [pane.id, sessionResponse?.websocket]);

  useEffect(() => {
    const currentSessionResponse = sessionResponse;
    const ticket = currentSessionResponse?.websocket;
    const host = xtermHostRef.current;
    if (!ticket || !host || !currentSessionResponse) {
      setTerminalStatus("idle");
      return;
    }
    const terminalTicket = ticket;
    const terminalHost = host;
    const terminalSessionResponse = currentSessionResponse;

    let disposed = false;
    let terminal: XtermTerminal | null = null;
    let fitAddon: XtermFitAddon | null = null;
    let socket: WebSocket | null = null;
    let socketGeneration = 0;
    let protocolRejected = false;
    let finalSocketState = false;
    let terminalReplayComplete = false;
    let initialReplayStatusReceived = false;
    let initialReplayWritePending = false;
    let initialReplayErrorPending = false;
    let replayFailureReported = false;
    let pendingReplayOutputRefresh: { token: number; revision: number } | null = null;
    let pendingInitialReplayFinalize: (() => void) | null = null;
    let dataDisposable: IDisposable | null = null;
    let writeParsedDisposable: IDisposable | null = null;
    let resizeDisposable: IDisposable | null = null;
    const nativePasteTargets: EventTarget[] = [];
    const terminalIntentTargets: Array<{ target: EventTarget; type: string; listener: EventListener }> = [];
    const writeBoundedTerminalReplay = async (data: string) => {
      let offset = 0;
      while (offset < data.length) {
        if (disposed || !terminal) return;
        const replayTerminal = terminal;
        const end = terminalReplayChunkEnd(data, offset);
        const chunk = data.slice(offset, end);
        await new Promise<void>((resolve, reject) => {
          try {
            replayTerminal.write(chunk, resolve);
          } catch (error) {
            reject(error);
          }
        });
        offset = end;
        if (offset < data.length) await yieldForTerminalReplay();
      }
    };
    const replayWriteQueue = createTerminalReplayWriteQueue(writeBoundedTerminalReplay);
    const handleTerminalReplayFailure = (error: unknown) => {
      if (replayFailureReported) return;
      replayFailureReported = true;
      initialReplayWritePending = false;
      pendingInitialReplayFinalize = null;
      pendingReplayOutputRefresh = null;
      if (disposed) return;
      setTerminalReplayReady(false);
      setTerminalStatus("closed");
      setError(error instanceof Error ? error.message : "CLI terminal replay failed");
    };
    const queueTerminalReplay = (data: string) => {
      void replayWriteQueue.enqueue(data).catch(handleTerminalReplayFailure);
    };
    const flushInitialReplay = (finalize: () => void) => {
      initialReplayWritePending = true;
      pendingInitialReplayFinalize = finalize;
      void replayWriteQueue.drain().then(() => {
        if (disposed) return;
        initialReplayWritePending = false;
        const pendingRefresh = pendingReplayOutputRefresh;
        pendingReplayOutputRefresh = null;
        const pendingFinalize = pendingInitialReplayFinalize;
        pendingInitialReplayFinalize = null;
        if (terminalReplayComplete && pendingRefresh) {
          scheduleModelSettingsRefreshAfterParsedOutput(pendingRefresh.token, pendingRefresh.revision);
        }
        pendingFinalize?.();
        initialReplayErrorPending = false;
      }).catch(handleTerminalReplayFailure);
    };
    setTerminalReplayReady(false);
    const nativePasteListener: EventListener = (event) => {
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
      if (!bufferedSocket) bufferedSocket = createBufferedTerminalSocket(terminalTicket);
      bufferedSocketRef.current = null;
      const connectingSocket = bufferedSocket.socket;
      socketGeneration = reconnectCoordinatorRef.current.beginSocketGeneration();
      socket = connectingSocket;
      socketRef.current = connectingSocket;
      readySocketRef.current = null;
      const earlySocketEvents = bufferedSocket.events;
      connectingSocket.addEventListener("open", () => {
        setTerminalStatus("connecting");
      });
      if (wasPreconnected) {
        // Every sibling socket is constructed before the room barrier releases. Each pane then
        // waits only for its own handshake and starts xterm in a separate browser task, allowing
        // slow handshakes and network events to progress between synchronous xterm setups.
        await bufferedSocket.preopen;
        await bootstrapBarrier?.waitForTerminalSetupTask(pane.id);
      } else {
        // Keep newly allocated sessions staggered behind each xterm setup so their CLI processes
        // do not burst-start every heavy MCP gateway in the room at once.
        await Promise.resolve();
      }
      if (disposed || socketRef.current !== connectingSocket) {
        bufferedSocket.stopBuffering();
        return;
      }
      terminalHost.replaceChildren();
      terminal = new Terminal({
        convertEol: true,
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
          selectionBackground: "#254941"
        }
      });
      fitAddon = new FitAddon();
      fitAddonRef.current = fitAddon;
      terminal.loadAddon(fitAddon);
      terminal.open(terminalHost);
      memoizeTerminalWidthMeasurements(terminal, terminalHost.ownerDocument);
      terminalRef.current = terminal;
      lastTerminalOutputRefitAtRef.current = 0;
      recoverBrokenTerminalGeometry();
      writeParsedDisposable = terminal.onWriteParsed(() => {
        if (isVisibleRef.current) scheduleTerminalRepaint(terminal);
      });
      const syntheticSeed = seedTerminalTranscript(terminal, terminalSessionResponse);
      syntheticTerminalSeedRef.current = syntheticSeed
        ? { sessionId: terminalSessionResponse.session.sessionId, content: syntheticSeed }
        : null;
      focusTerminal();

      const terminalDom = terminal as XtermTerminal & { element?: HTMLElement; textarea?: HTMLTextAreaElement };
      nameTerminalInput(terminalDom.textarea);
      const addNativePasteTarget = (target: EventTarget | null | undefined) => {
        if (!target || nativePasteTargets.includes(target)) return;
        target.addEventListener("paste", nativePasteListener, { capture: true });
        target.addEventListener("keydown", nativePasteShortcutListener, { capture: true });
        target.addEventListener("beforeinput", nativeBeforeInputListener, { capture: true });
        nativePasteTargets.push(target);
      };
      const addTerminalIntentTarget = (target: EventTarget | null | undefined, type: string) => {
        if (!target) return;
        const listener: EventListener = () => markTerminalIntent();
        target.addEventListener(type, listener, { capture: true });
        terminalIntentTargets.push({ target, type, listener });
      };
      addNativePasteTarget(terminalHost);
      addNativePasteTarget(terminalDom.element);
      addNativePasteTarget(terminalDom.textarea);
      addNativePasteTarget(document);
      addTerminalIntentTarget(terminalHost, "pointerdown");
      addTerminalIntentTarget(terminalHost, "focusin");
      addTerminalIntentTarget(terminalDom.textarea, "focus");

      dataDisposable = terminal.onData((data) => {
        markTerminalIntent();
        if (isGuardedPasteTerminalInput(data)) {
          const source = pasteInputGuardRef.current?.source ?? "terminal paste";
          updateClipboardDebug("info", "raw terminal paste blocked", `${source}: blocked raw Ctrl+V from xterm before Codex CLI.`);
          return;
        }
        const turnMarker =
          terminalSessionResponse.session.purpose === "NORMAL" &&
          terminalSessionResponse.session.runtimeId === DEFAULT_CLI_RUNTIME_ID &&
          isTerminalSubmitInput(data)
            ? createCliTurnMarker()
            : undefined;
        sendTerminalInput(data, "terminal keyboard input", "visible", true, { turnMarker });
      });
      resizeDisposable = terminal.onResize(({ cols, rows }) => {
        if (
          socket?.readyState === WebSocket.OPEN &&
          readySocketRef.current?.socket === socket &&
          readySocketRef.current.sessionId === terminalSessionResponse.session.sessionId
        ) {
          socket.send(JSON.stringify({ type: "resize", cols, rows }));
        }
      });
      const handleSocketMessage = (event: MessageEvent) => {
        if (!socket || disposed || socketRef.current !== socket) return;
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
            clearModelSettingsOutputRefresh(socket);
            clearReconnectTimer();
            setTerminalStatus("closed");
            setError("CLI connection identity mismatch. Reconnect this pane.");
            socket?.close(1008, "CLI terminal identity mismatch");
            return;
          }
          readySocketRef.current = { socket, sessionId: message.sessionId };
          if (!bootstrapReportedRef.current) {
            bootstrapReportedRef.current = true;
            onBootstrapped?.(pane.id);
          }
          recordLifecycleDebugEvent({
            type: "terminal_socket_ready",
            scope: "TerminalPane",
            detail: `generation=${socketGeneration} session=${message.sessionId}`,
            paneId: pane.id,
            paneMode: pane.mode
          });
          setError(null);
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
          reconnectAttemptRef.current = 0;
          reconnectCoordinatorRef.current.invalidateSocketGeneration(socketGeneration);
          if (readySocketRef.current?.socket === socket) readySocketRef.current = null;
          setTerminalStatus("connecting");
          setConnectionAlert(null);
          api.invalidateCliRuntimes();
          void attachReplacedCliSession(message.sessionId, terminalSessionResponse.session.runtimeId);
          return;
        }
        if (message.type === "output") {
          const visibleData = stripHiddenTerminalEcho(message.data);
          if (visibleData) {
            if (!initialReplayStatusReceived) {
              queueTerminalReplay(visibleData);
              return;
            }
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
              queueTerminalReplay(visibleData);
              if (refreshOutputToken !== null && refreshOutputRevision !== null) {
                pendingReplayOutputRefresh = {
                  token: refreshOutputToken,
                  revision: refreshOutputRevision
                };
              }
              return;
            }
            terminal?.write(visibleData, () => {
              if (
                terminalReplayComplete &&
                refreshOutputToken !== null &&
                refreshOutputRevision !== null
              ) {
                scheduleModelSettingsRefreshAfterParsedOutput(refreshOutputToken, refreshOutputRevision);
              }
            });
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
              clearScheduledTerminalRefit();
              lastTerminalOutputRefitAtRef.current = Date.now();
              if (!recoverBrokenTerminalGeometry()) scheduleTerminalRefit({ delayedPass: false });
            } else {
              clearReconnectTimer();
              setConnectionAlert(null);
              clearStoredActiveCliTurn(pane.id);
              setActiveCliTurn(null);
              if (message.statusReason) terminal?.writeln(`\r\n${message.statusReason}`);
            }
          };

          if (initialReplayStatusReceived) {
            terminalReplayComplete = message.status === "RUNNING";
            if (!terminalReplayComplete) clearModelSettingsOutputRefresh(socket);
            if (terminalReplayComplete) {
              if (!initialReplayErrorPending) applyStatus();
              return;
            }
            setTerminalReplayReady(false);
            if (initialReplayWritePending) {
              pendingInitialReplayFinalize = applyStatus;
              return;
            }
            applyStatus();
            return;
          }

          initialReplayStatusReceived = true;
          terminalReplayComplete = message.status === "RUNNING";
          if (!terminalReplayComplete) {
            clearModelSettingsOutputRefresh(socket);
            setTerminalReplayReady(false);
            flushInitialReplay(applyStatus);
            return;
          }
          if (!initialReplayErrorPending) applyStatus();
          flushInitialReplay(() => {
            if (!disposed && socketRef.current === socket) {
              setTerminalReplayReady(true);
              recoverBrokenTerminalGeometry();
            }
          });
          return;
        }
        if (message.type === "error") {
          finalSocketState = true;
          clearReconnectTimer();
          reconnectCoordinatorRef.current.invalidateSocketGeneration(socketGeneration);
          if (readySocketRef.current?.socket === socket) readySocketRef.current = null;
          const applyError = () => {
            if (disposed || socketRef.current !== socket) return;
            clearReconnectTimer();
            setTerminalStatus("closed");
            terminal?.writeln(`\r\n${message.message}`);
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
        if (finalSocketState || !shouldReconnectTerminalSocket(event)) {
          clearReconnectTimer();
          reconnectAttemptRef.current = 0;
          reconnectCoordinatorRef.current.invalidateSocketGeneration(socketGeneration);
          if (readySocketRef.current?.socket === socket) readySocketRef.current = null;
          setTerminalStatus("closed");
          setConnectionAlert(null);
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
        ) return;
        if (readySocketRef.current?.socket === socket) readySocketRef.current = null;
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
          setTerminalStatus("closed");
          return;
        }
        setTerminalStatus("reconnecting");
        setConnectionAlert(null);
        scheduleReconnect(socketGeneration);
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
      setError(err instanceof Error ? err.message : "CLI attach failed");
    });

    const resizeObserver = new ResizeObserver(() => {
      scheduleTerminalRefit({ delayedPass: false });
    });
    resizeObserver.observe(terminalHost);

    return () => {
      disposed = true;
      replayWriteQueue.dispose();
      if (socketGeneration > 0) reconnectCoordinatorRef.current.invalidateSocketGeneration(socketGeneration);
      clearScheduledTerminalRepaint();
      clearScheduledTerminalRefit();
      resizeObserver.disconnect();
      for (const target of nativePasteTargets) {
        target.removeEventListener("paste", nativePasteListener, { capture: true });
        target.removeEventListener("keydown", nativePasteShortcutListener, { capture: true });
        target.removeEventListener("beforeinput", nativeBeforeInputListener, { capture: true });
      }
      for (const { target, type, listener } of terminalIntentTargets) {
        target.removeEventListener(type, listener, { capture: true });
      }
      clearPasteShortcutFallback();
      dataDisposable?.dispose();
      writeParsedDisposable?.dispose();
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
      if (syntheticTerminalSeedRef.current?.sessionId === terminalSessionResponse.session.sessionId) {
        syntheticTerminalSeedRef.current = null;
      }
    };
  }, [sessionResponse?.websocket]);

  function clearReconnectTimer() {
    if (reconnectTimerRef.current === null) return;
    window.clearTimeout(reconnectTimerRef.current);
    reconnectTimerRef.current = null;
  }

  function scheduleReconnect(expectedSocketGeneration: number) {
    if (!reconnectCoordinatorRef.current.isCurrentSocketGeneration(expectedSocketGeneration)) return;
    clearReconnectTimer();
    const delayMs = cliReconnectDelayMs(reconnectAttemptRef.current);
    reconnectAttemptRef.current += 1;
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

  async function requestCliSession(
    input: { modelId?: string | null; forceRestart?: boolean; resume?: boolean } = {},
    options: { automaticReconnect?: boolean; expectedSocketGeneration?: number } = {}
  ): Promise<PaneCliSessionResponse | null> {
    if (!selectedRuntime) return null;
    const selectedRuntimeForRequest = selectedRuntime;
    return reconnectCoordinatorRef.current.runSessionRequest(async () => {
      if (
        options.automaticReconnect &&
        (options.expectedSocketGeneration === undefined ||
          !reconnectCoordinatorRef.current.isCurrentSocketGeneration(options.expectedSocketGeneration))
      ) return null;
      setPending(true);
      if (!options.automaticReconnect) {
        clearReconnectTimer();
        reconnectAttemptRef.current = 0;
        setConnectionAlert(null);
        setError(null);
        setNotice(null);
      }
      try {
        const nextSession = await api.createCliSession(
          pane.id,
          buildTerminalCliSessionRequest(
            pane,
            selectedRuntimeForRequest.id,
            input,
            options.automaticReconnect === true
          )
        );
        if (
          options.automaticReconnect &&
          options.expectedSocketGeneration !== undefined &&
          !reconnectCoordinatorRef.current.isCurrentSocketGeneration(options.expectedSocketGeneration)
        ) return null;
        clearReconnectTimer();
        reconnectAttemptRef.current = 0;
        setError(null);
        setConnectionAlert(null);
        setSessionResponse(nextSession);
        recordLifecycleDebugEvent({
          type: "session_sync",
          scope: "TerminalPane",
          detail: `runtime=${selectedRuntimeForRequest.id} status=${nextSession.session.status} reconnect=${String(options.automaticReconnect)}`,
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
        } else if (options.automaticReconnect) {
          clearReconnectTimer();
          setTerminalStatus("closed");
          setError(err instanceof Error ? err.message : "CLI reconnect stopped");
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

  function reconnectTerminal() {
    clearReconnectTimer();
    reconnectAttemptRef.current = 0;
    setConnectionAlert(null);
    setNotice(null);
    autoAttachAttemptRef.current = null;
    setSessionResponse(null);
    setTerminalStatus("idle");
    void loadRuntimes(false);
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
  }

  function hasRecentTerminalIntent(nowMs = Date.now()): boolean {
    return nowMs - lastTerminalIntentAtRef.current <= TERMINAL_PASTE_RECENT_INTENT_MS;
  }

  function focusTerminal() {
    if (!isTargetRef.current) return;
    markTerminalIntent();
    terminalRef.current?.focus();
  }

  function clearScheduledTerminalRefit() {
    if (scheduledTerminalRefitFrameRef.current !== null) {
      window.cancelAnimationFrame(scheduledTerminalRefitFrameRef.current);
      scheduledTerminalRefitFrameRef.current = null;
    }
    if (scheduledTerminalRefitTimerRef.current !== null) {
      window.clearTimeout(scheduledTerminalRefitTimerRef.current);
      scheduledTerminalRefitTimerRef.current = null;
    }
    scheduledTerminalRefitFontsTicketRef.current += 1;
  }

  function clearScheduledTerminalRepaint() {
    if (scheduledTerminalRepaintFrameRef.current === null) return;
    window.cancelAnimationFrame(scheduledTerminalRepaintFrameRef.current);
    scheduledTerminalRepaintFrameRef.current = null;
  }

  function scheduleTerminalRepaint(terminal = terminalRef.current) {
    if (!terminal || typeof window === "undefined" || scheduledTerminalRepaintFrameRef.current !== null) return;
    scheduledTerminalRepaintFrameRef.current = window.requestAnimationFrame(() => {
      scheduledTerminalRepaintFrameRef.current = null;
      if (!isVisibleRef.current || terminalRef.current !== terminal || terminal.rows <= 0) return;
      const now = Date.now();
      if (now - lastTerminalOutputRefitAtRef.current >= TERMINAL_OUTPUT_REFIT_INTERVAL_MS) {
        lastTerminalOutputRefitAtRef.current = now;
        measureTerminalCharacterSize(terminal);
        fitAddonRef.current?.fit();
      }
      terminal.refresh(0, terminal.rows - 1);
    });
  }

  function sendTerminalResizeFrame() {
    const terminal = terminalRef.current;
    const socket = socketRef.current;
    const sessionId = sessionResponseRef.current?.session.sessionId;
    if (
      !terminal ||
      !socket ||
      socket.readyState !== WebSocket.OPEN ||
      readySocketRef.current?.socket !== socket ||
      readySocketRef.current.sessionId !== sessionId
    ) return;
    socket.send(JSON.stringify({ type: "resize", cols: terminal.cols, rows: terminal.rows }));
  }

  function performTerminalRefit() {
    const terminal = terminalRef.current;
    measureTerminalCharacterSize(terminal);
    fitAddonRef.current?.fit();
    sendTerminalResizeFrame();
    scheduleTerminalRepaint(terminal);
  }

  function recoverBrokenTerminalGeometry(): boolean {
    if (!isVisibleRef.current || !terminalLooksGeometryBroken(terminalRef.current, xtermHostRef.current)) return false;
    scheduleTerminalRefit({ immediate: true, delayedPass: true });
    return true;
  }

  function scheduleTerminalRefit(options: { immediate?: boolean; delayedPass?: boolean } = {}) {
    if (options.immediate) {
      performTerminalRefit();
    }
    if (typeof window === "undefined") return;
    if (scheduledTerminalRefitFrameRef.current !== null) {
      window.cancelAnimationFrame(scheduledTerminalRefitFrameRef.current);
    }
    scheduledTerminalRefitFrameRef.current = window.requestAnimationFrame(() => {
      scheduledTerminalRefitFrameRef.current = null;
      performTerminalRefit();
    });
    if (scheduledTerminalRefitTimerRef.current !== null) {
      window.clearTimeout(scheduledTerminalRefitTimerRef.current);
      scheduledTerminalRefitTimerRef.current = null;
    }
    if (options.delayedPass !== false) {
      scheduledTerminalRefitTimerRef.current = window.setTimeout(() => {
        scheduledTerminalRefitTimerRef.current = null;
        performTerminalRefit();
      }, TERMINAL_REFIT_STABILIZE_DELAY_MS);
    }
    const fontsReady = typeof document !== "undefined" ? document.fonts?.ready : undefined;
    if (fontsReady) {
      const ticket = scheduledTerminalRefitFontsTicketRef.current + 1;
      scheduledTerminalRefitFontsTicketRef.current = ticket;
      void fontsReady.then(() => {
        if (scheduledTerminalRefitFontsTicketRef.current !== ticket) return;
        performTerminalRefit();
      });
      return;
    }
    scheduledTerminalRefitFontsTicketRef.current += 1;
  }

  useEffect(() => clearScheduledTerminalRefit, []);
  useEffect(() => clearScheduledTerminalRepaint, []);

  useEffect(() => {
    if (!isVisible) return;
    if (!recoverBrokenTerminalGeometry()) scheduleTerminalRefit();
  }, [isVisible, pane.id, terminalFontSize]);

  useEffect(() => {
    if (!isVisible || typeof window === "undefined" || typeof document === "undefined") return;
    const repairTerminalAfterBrowserResume = () => {
      if (document.visibilityState === "hidden") return;
      lastTerminalOutputRefitAtRef.current = 0;
      scheduleTerminalRefit({ immediate: true });
    };
    window.addEventListener("focus", repairTerminalAfterBrowserResume);
    window.addEventListener("pageshow", repairTerminalAfterBrowserResume);
    document.addEventListener("visibilitychange", repairTerminalAfterBrowserResume);
    return () => {
      window.removeEventListener("focus", repairTerminalAfterBrowserResume);
      window.removeEventListener("pageshow", repairTerminalAfterBrowserResume);
      document.removeEventListener("visibilitychange", repairTerminalAfterBrowserResume);
    };
  }, [isVisible, pane.id, sessionResponse?.websocket]);

  function controlKeySequence(key: "shift_tab" | "escape"): string {
    return key === "shift_tab" ? "\u001b[Z" : "\u001b";
  }

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
    const sessionId = sessionResponseRef.current?.session.sessionId;
    if (
      !socket ||
      !sessionId ||
      socket.readyState !== WebSocket.OPEN ||
      readySocketRef.current?.socket !== socket ||
      readySocketRef.current.sessionId !== sessionId
    ) {
      setError("Attach a running CLI before pasting into it.");
      updateClipboardDebug("bad", "send failed", `${source}: CLI WebSocket is not open; inputLength=${data.length}.`);
      return false;
    }
    if (display === "hidden") {
      registerHiddenTerminalInput(data);
    }
    socket.send(
      JSON.stringify({
        type: "input",
        data,
        ...(display === "hidden" ? { display } : {}),
        ...(options.turnMarker ? { turnMarker: options.turnMarker } : {})
      })
    );
    if (display === "visible") {
      armModelSettingsOutputRefresh(data, socket, sessionId, terminalRef.current);
    }
    if (display === "visible" && options.trackDraft !== false) {
      setTerminalPromptDraft((current) => nextTerminalPromptDraft(current, data));
    }
    if (options.turnMarker) {
      const nextTurn = { marker: options.turnMarker, status: "PENDING" as const };
      setActiveCliTurn(nextTurn);
      storeActiveCliTurn(pane.id, sessionId, nextTurn);
    }
    if (!preserveNotice) setNotice(null);
    if (shouldRefocusTerminalAfterInput(data)) focusTerminal();
    return true;
  }

  function handleTurnControlClick() {
    if (isTurnRunning) {
      const sent = sendTerminalInput("\u001b", "floating turn pause", "visible", true, { trackDraft: false });
      if (sent) {
        clearStoredActiveCliTurn(pane.id);
        setActiveCliTurn(null);
        setModelSettings((current) => current ? { ...current, isTurnActive: false } : current);
      }
      return;
    }
    if (!canSendTurn) return;
    sendTerminalInput("\r", "floating turn submit", "visible", false, { turnMarker: createCliTurnMarker() });
  }

  async function handleModelSwitch(
    modelId: string,
    reasoningEffort: string
  ): Promise<{
    current: NonNullable<PaneCliModelSettings["current"]>;
    message: string | null;
  }> {
    const currentSession = sessionResponseRef.current;
    if (!currentSession) throw new Error("Attach a Codex CLI session before changing model settings.");
    const result = await api.updateCliModelSettings(pane.id, {
      expectedSessionId: currentSession.session.sessionId,
      modelId,
      reasoningEffort,
      continueActiveTurn: true
    });
    modelSettingsRef.current = result.settings;
    setModelSettings(result.settings);
    setSessionResponse((current) => {
      if (!current || current.session.sessionId !== result.session.session.sessionId) return result.session;
      return { ...current, session: result.session.session };
    });
    if (result.wasActive) {
      clearStoredActiveCliTurn(pane.id);
      setActiveCliTurn(null);
    }
    if (!result.settings.current) {
      throw new Error("Codex did not confirm the applied model settings.");
    }
    const message = result.appliedScope === "REASONING_ONLY"
      ? result.warning ?? "Reasoning changed; Codex kept the previous model."
      : result.warning;
    return {
      current: result.settings.current,
      message
    };
  }

  function registerHiddenTerminalInput(data: string) {
    const now = Date.now();
    const expiresAtMs = now + HIDDEN_INPUT_ECHO_TTL_MS;
    hiddenInputEchoFiltersRef.current = [
      ...hiddenInputEchoFiltersRef.current.filter((item) => item.expiresAtMs > now),
      ...hiddenEchoCandidates(data).map((candidate) => ({ value: candidate, remaining: candidate, expiresAtMs }))
    ];
  }

  function stripHiddenTerminalEcho(data: string): string {
    const now = Date.now();
    hiddenInputEchoFiltersRef.current = hiddenInputEchoFiltersRef.current.filter((item) => item.remaining && item.expiresAtMs > now);
    if (!hiddenInputEchoFiltersRef.current.length) return data;

    let output = data;
    for (let index = 0; index < hiddenInputEchoFiltersRef.current.length && output; ) {
      const pending = hiddenInputEchoFiltersRef.current[index];
      if (!pending) {
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

  function removeUploadPreview(id: string) {
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
    }
    focusTerminal();
    window.requestAnimationFrame(() => focusTerminal());
  }

  function clearUploadPreviews() {
    if (!uploadPreviews.length) return;
    setUploadPreviews([]);
    setSelectedUploadPreviewId(null);
    setNotice("All clipboard previews removed.");
    focusTerminal();
    window.requestAnimationFrame(() => focusTerminal());
  }

  async function uploadFiles(
    files: File[],
    source: PaneCliUploadSource,
    debugSource: string = source,
    hiddenPathNotice = HIDDEN_UPLOAD_NOTICE
  ) {
    if (!files.length) return;
    if (!supportsCliFileUploads) {
      clearClipboardPasteAttempt();
      setDragActive(false);
      setError("DeepSeek CLI is text-only. File and image uploads are unavailable.");
      return;
    }
    if (sessionResponseRef.current?.session.purpose === "LOGIN") {
      clearClipboardPasteAttempt();
      setDragActive(false);
      setError("File and image uploads are unavailable during CLI login.");
      return;
    }
    if (!canUpload) {
      setError("Attach a CLI session before uploading files.");
      if (source === "CLIPBOARD") {
        clearClipboardPasteAttempt();
      }
      updateClipboardDebug("bad", "upload blocked", `${debugSource}: attach a CLI session before uploading files; fileCount=${files.length}.`);
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
            id: `${uploadedFile.sessionId}:${uploadedFile.storedFilename}`,
            name: uploadedFile.originalFilename,
            path: uploadedFile.terminalPath,
            objectUrl: URL.createObjectURL(sourceFile)
          };
        })
        .filter((preview): preview is TerminalUploadPreview => Boolean(preview));
      if (nextPreviews.length) {
        setUploadPreviews((current) => {
          const byId = new Map(current.map((preview) => [preview.id, preview]));
          for (const preview of nextPreviews) byId.set(preview.id, preview);
          return Array.from(byId.values()).slice(-imagePreviewLimit);
        });
      }
      const imageFiles = uploadedFiles.filter((file) => file.isImage);
      const attachedImageCount = imageFiles.filter((file) =>
        sendTerminalInput(terminalImagePaste(file), `${debugSource}: image attachment`, "hidden", true)
      ).length;
      const terminalFiles = uploadedFiles.filter((file) => !file.isImage);
      const pastedPaths = terminalFiles.map((file) => terminalInputPath(file)).join(" ");
      if (pastedPaths) {
        const sent = sendTerminalInput(`${pastedPaths} `, debugSource, "hidden");
        if (sent) {
          setNotice(hiddenPathNotice);
        }
        updateClipboardDebug(
          sent ? "good" : "bad",
          sent ? "upload inserted hidden" : "upload inserted failed",
          `${debugSource}: uploaded=${uploadedFiles.length}; insertedPathCount=${terminalFiles.length}; insertedPathLength=${pastedPaths.length}; display=hidden; containsUploadPath=true.`
        );
      } else {
        updateClipboardDebug(
          attachedImageCount === imageFiles.length ? "good" : "bad",
          attachedImageCount === imageFiles.length ? "image attached" : "image attachment failed",
          `${debugSource}: uploaded=${uploadedFiles.length}; attachedImageCount=${attachedImageCount}; imagePathCount=${imageFiles.length}; display=hidden.`
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
    if (
      sessionResponseRef.current?.session.purpose === "LOGIN" ||
      !supportsCliFileUploads ||
      Array.from(text).length <= CLIPBOARD_TEXT_INLINE_MAX_CODE_POINTS
    ) {
      const sent = sendTerminalInput(text, source);
      if (sent) setNotice("Clip inserted into CLI input.");
      return;
    }
    setNotice(null);
    const file = new File([text], clipboardTextFilename(), { type: "text/plain" });
    await uploadFiles([file], "CLIPBOARD", source, LARGE_CLIPBOARD_TEXT_NOTICE);
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
        const sent = sendTerminalInput(text, `${source}: async clipboard text read succeeded`);
        clearClipboardPasteAttempt();
        updateClipboardDebug(
          sent ? "good" : "bad",
          sent ? "async clipboard text sent" : "async clipboard text blocked",
          `${source}: ${priorClipboardSummary}; textLength=${text.length}.`
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
      sendTerminalInput(text, `react paste text: ${snapshot.summary}`);
      clearClipboardPasteAttempt();
      updateClipboardDebug("good", "text paste sent", `react paste event: ${snapshot.summary}; ${routing}.`);
      return;
    }
    stopClipboardEvent(event.nativeEvent);
    void handleClipboardReadPaste("react paste fallback", `${snapshot.summary}; ${routing}`);
  }

  function handleTerminalNativePaste(event: globalThis.ClipboardEvent) {
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
      sendTerminalInput(snapshot.text, `native paste text: ${snapshot.summary}`);
      clearClipboardPasteAttempt();
      updateClipboardDebug("good", "text paste sent", `native paste event: ${snapshot.summary}; ${routing}.`);
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

  function handleTerminalDrop(event: DragEvent<HTMLElement>) {
    event.preventDefault();
    event.stopPropagation();
    const files = Array.from(event.dataTransfer.files);
    if (files.length) {
      if (sessionResponseRef.current?.session.purpose === "LOGIN") {
        setDragActive(false);
        setError("File drop is unavailable during CLI login. Paste the authorization code as text.");
        return;
      }
      void uploadFiles(files, "DROP");
      return;
    }
    const clipboardItemId = event.dataTransfer.getData(SPACE_CLIPBOARD_ITEM_MIME);
    const text = event.dataTransfer.getData("text/plain");
    if (clipboardItemId && text) {
      void insertClipboardText(text, "clipboard history drop");
    }
    setDragActive(false);
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
      const activeSessionId = sessionResponseRef.current?.session.sessionId;
      const syntheticSeed = syntheticTerminalSeedRef.current;
      const copyableBuffer = syntheticSeed && syntheticSeed.sessionId === activeSessionId
        ? stripSyntheticTerminalPrefix(buffered, syntheticSeed.content)
        : buffered;
      if (buffered.trim()) return copyableBuffer;
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
        event.detail.action !== "insert_clipboard_text"
      ) return;
      if (event.detail.action === "enter_native_plan_mode") {
        const actionSession = sessionResponseRef.current?.session;
        const actionSocket = socketRef.current;
        if (actionSession?.runtimeId !== event.detail.runtimeId) return;
        const actionIdentity = actionSocket
          ? { runtimeId: event.detail.runtimeId, sessionId: actionSession.sessionId, socket: actionSocket }
          : null;
        if (!actionIdentity || !nativePlanModeActionIdentityMatches(actionIdentity)) {
          setNotice(null);
          setError(`Attach a running ${event.detail.runtimeId === "cli:gemini" ? "Gemini" : "Qwen Code"} CLI before changing Plan mode.`);
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
        if (actionSession?.runtimeId !== CLAUDE_CLI_RUNTIME_ID) return;
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
        if (detectedMode === "plan mode on") return;
        let currentMode: ClaudePermissionMode = detectedMode;
        claudePlanModeActionPendingRef.current = true;
        try {
          for (let attempt = 0; attempt < 4; attempt += 1) {
            if (!claudePlanModeActionIdentityMatches(actionIdentity)) return;
            if (!sendTerminalInput(controlKeySequence("shift_tab"), "terminal action ensure Claude Plan mode", "visible", false, { trackDraft: false })) {
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
        }
        return;
      }
      if (event.detail.action === "control_key") {
        sendTerminalInput(controlKeySequence(event.detail.key), `terminal action ${event.detail.key}`);
        return;
      }
      if (event.detail.action === "save_to_memory") {
        const commandText = event.detail.text.trim() || "save to memory";
        const memoryBody = buildMemorySaveBody({
          paneTitle: pane.title,
          modelId: event.detail.modelId,
          commandText,
          transcript: collectTerminalContent()
        });
        const nextSession = await requestCliSession({
          modelId: event.detail.modelId,
          forceRestart: true
        });
        if (!nextSession) return;
        const socketReady = nextSession.websocket ? await waitForTerminalSocketOpen(nextSession.session.sessionId) : false;
        if (!socketReady) {
          setError("CLI restarted, but the replacement terminal socket did not become ready in time.");
          return;
        }
        const prompt = commandText.endsWith("\n") ? commandText : `${commandText}\n`;
        const sent = sendTerminalInput(prompt, "terminal action save_to_memory");
        if (!sent) return;
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
        if (!supportsCliFileUploads) {
          setError("DeepSeek CLI is text-only. File and image uploads are unavailable.");
          return;
        }
        if (!canUpload) {
          setError("Attach a CLI session before uploading files.");
          return;
        }
        fileInputRef.current?.click();
        return;
      }
      if (event.detail.action === "attach_clip_image") {
        await uploadFiles([event.detail.file], "SCREEN_CAPTURE", "Clip Tool");
        return;
      }
      if (event.detail.action === "reconnect") {
        reconnectTerminal();
        return;
      }
      if (event.detail.action === "replace_session") {
        clearReconnectTimer();
        reconnectAttemptRef.current = 0;
        setConnectionAlert(null);
        setError(null);
        setNotice(null);
        autoAttachAttemptRef.current = null;
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
      if (event.detail.action === "insert_clipboard_text") {
        await insertClipboardText(event.detail.text, "clipboard history insert");
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
    }
    function handleTerminalPaneAction(event: Event) {
      if (!(event instanceof CustomEvent)) return;
      void handleTerminalPaneActionEvent(event as CustomEvent<TerminalPaneActionDetail>).catch((error: unknown) => {
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
      data-workspace-text-size={terminalFontSize}
      onPasteCapture={handleTerminalPaste}
      onDrop={handleTerminalDrop}
      onDragOver={(event) => {
        event.preventDefault();
        if (!isTerminalLoginSession && supportsCliFileUploads) setDragActive(true);
      }}
      onDragLeave={() => setDragActive(false)}
    >
      {supportsCliFileUploads ? (
        <input
          ref={fileInputRef}
          type="file"
          name={`cli-files-${pane.id}`}
          multiple
          hidden
          onChange={(event) => {
            const files = event.currentTarget.files ? Array.from(event.currentTarget.files) : [];
            event.currentTarget.value = "";
            if (files.length) void uploadFiles(files, "USER_UPLOAD");
          }}
        />
      ) : null}

      {error ? <div className="terminal-alert bad">{error}</div> : null}
      {connectionAlert ? (
        <div className={["terminal-alert", connectionAlert.tone === "bad" ? "bad" : "", connectionAlert.tone === "good" ? "good" : ""].filter(Boolean).join(" ")} role={connectionAlert.tone === "bad" ? "alert" : "status"}>
          {connectionAlert.message}
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
      {selectedUploadPreview ? (
        <div
          className="attachment-modal terminal-upload-modal"
          role="dialog"
          aria-modal="true"
          aria-label={`${selectedUploadPreviewLabel} preview`}
          onClick={() => setSelectedUploadPreviewId(null)}
        >
          <div className="attachment-modal-body terminal-upload-modal-body" onClick={(event) => event.stopPropagation()}>
            <button type="button" className="terminal-upload-modal-close" aria-label="Close image preview" onClick={() => setSelectedUploadPreviewId(null)}>
              <X aria-hidden="true" />
            </button>
            <span className="terminal-upload-modal-label">{selectedUploadPreviewLabel}</span>
            <img src={selectedUploadPreview.objectUrl} alt={`${selectedUploadPreviewLabel} full size`} />
          </div>
        </div>
      ) : null}

      <div className="terminal-stage">
        {notice || uploading || dragActive || uploadPreviews.length ? (
          <div className="terminal-floating-stack" aria-label={`CLI transient uploads ${pane.title}`}>
            {notice ? (
              <div
                className={[
                  "terminal-alert",
                  "good",
                  "terminal-floating-alert",
                  notice === HIDDEN_UPLOAD_NOTICE || notice === LARGE_CLIPBOARD_TEXT_NOTICE ? "terminal-floating-alert-subtle" : ""
                ]
                  .filter(Boolean)
                  .join(" ")}
                role="status"
              >
                {notice}
              </div>
            ) : null}
            {uploading || dragActive ? (
              <div className="terminal-alert terminal-floating-alert" role="status">
                {uploading ? "Uploading files and preparing terminal paths..." : "Drop files or photos to upload them to this CLI session."}
              </div>
            ) : null}
            {uploadPreviews.length ? (
              <div className="terminal-upload-strip terminal-upload-strip-floating" aria-label={`CLI image uploads ${pane.title}`}>
                <button
                  type="button"
                  className="terminal-upload-strip-close"
                  onClick={clearUploadPreviews}
                  aria-label={`Dismiss all images ${pane.title}`}
                  title="Dismiss all images"
                >
                  <X aria-hidden="true" />
                </button>
                {uploadPreviews.map((preview, index) => (
                  <figure key={preview.id} className="terminal-upload-preview" title={`Image ${index + 1}: ${preview.name}`}>
                    <button
                      type="button"
                      className="terminal-upload-open"
                      aria-label={`Open image ${index + 1}`}
                      onClick={() => setSelectedUploadPreviewId(preview.id)}
                    >
                      <span className="terminal-upload-index" aria-hidden="true">
                        {index + 1}
                      </span>
                      <img src={preview.objectUrl} alt={`Image ${index + 1} preview`} />
                    </button>
                    <button
                      type="button"
                      className="terminal-upload-remove"
                      aria-label={`Remove image ${index + 1}`}
                      title={`Remove image ${index + 1}`}
                      onClick={() => removeUploadPreview(preview.id)}
                    >
                      <X aria-hidden="true" />
                    </button>
                  </figure>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}

        <div ref={transcriptRef} className={`terminal-viewport ${sessionResponse?.websocket ? "live" : ""}`} role="log" aria-live="polite">
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
        {isCodexCliSession && sessionResponse?.websocket && !hideFloatingControls ? (
          <div className="terminal-floating-controls">
            {modelSettings ? <CodexModelPicker settings={modelSettings} onSwitch={handleModelSwitch} /> : null}
            <button
              type="button"
              className="terminal-turn-control"
              data-state={turnControlState}
              aria-label={isTurnRunning ? "Stop Codex" : "Send prompt"}
              title={isTurnRunning ? "Pause Codex" : "Send prompt"}
              disabled={isTurnRunning ? terminalStatus !== "attached" : !canSendTurn}
              onClick={handleTurnControlClick}
            >
              {isTurnRunning ? <Square aria-hidden="true" fill="currentColor" /> : <ArrowUp aria-hidden="true" />}
            </button>
          </div>
        ) : null}
      </div>
    </section>
  );
}
