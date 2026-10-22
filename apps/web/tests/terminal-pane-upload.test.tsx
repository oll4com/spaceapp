import { act, fireEvent, render as renderBase, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PaneCliModelSettings } from "@space/contracts";
import { StrictMode, type ReactElement } from "react";
import {
  createTerminalBootstrapBarrier,
  TerminalPane
} from "../src/features/terminal-pane/TerminalPane.js";
import { recordFullscreenGeometry } from "../src/features/terminal-pane/fullscreen-geometry.js";
import { resetCliClientEventReporter } from "../src/cli-client-event-reporter.js";
import { createDemoRuntime } from "../src/demo/demo-runtime.js";
import { liveRuntime } from "../src/live/live-runtime.js";
import { installSpaceRuntime } from "../src/runtime/SpaceRuntime.js";
import { SPACE_ARTIFACT_MIME } from "../src/features/artifacts/artifact-drag.js";
import { rememberNewPaneAccount } from "../src/features/cli-accounts/cli-account-memory.js";
import type { TerminalActionAvailability } from "../src/features/terminal-pane/terminal-action-availability.js";
import { VoiceInputProvider } from "../src/features/voice-input/VoiceInputProvider.js";
import { defaultVoiceComposerSettings, VOICE_SETTINGS_STORAGE_KEY } from "../src/voice-settings.js";

function withVoiceInput(ui: ReactElement) {
  return <VoiceInputProvider>{ui}</VoiceInputProvider>;
}

function render(ui: ReactElement, options?: Parameters<typeof renderBase>[1]) {
  return renderBase(withVoiceInput(ui), options);
}

const terminalAttachConstructionOrder = vi.hoisted(() => [] as Array<"websocket" | "terminal" | "task">);
const apiMock = vi.hoisted(() => ({
  cliRuntimes: vi.fn(),
  activeCliSession: vi.fn(),
  createCliSession: vi.fn(),
  recoveryCliTask: vi.fn(),
  resumeCliSession: vi.fn(),
  cliModelSettings: vi.fn(),
  cliModelSettingsStatus: vi.fn(),
  updateCliModelSettings: vi.fn(),
  cliTurnActivity: vi.fn(),
  interruptCliSession: vi.fn(),
  abortCliTurn: vi.fn(),
  uploadCliFiles: vi.fn(),
  createClipboardItem: vi.fn(),
  createMemory: vi.fn(),
  reportCliClipboardDebug: vi.fn(),
  reportCliClientEvent: vi.fn(),
  cliTerminalWebSocketUrl: vi.fn(),
  listCliAccountProfiles: vi.fn(),
  setCliTerminalControlLease: vi.fn(),
  invalidateCliRuntimes: vi.fn(),
  cliRuntimesSnapshot: vi.fn(() => null),
  userSettings: vi.fn(() => Promise.resolve({})),
  artifacts: vi.fn(),
  artifactFileUrl: vi.fn(),
  deleteArtifact: vi.fn(() => Promise.resolve({ ok: true }))
}));
const xtermMock = vi.hoisted(() => ({
  markConstructionTask: false,
  instances: [] as Array<{
    cols: number;
    rows: number;
    options: {
      cols?: number;
      rows?: number;
      convertEol?: boolean;
      fontSize?: number;
      logLevel?: string;
    };
    writes: string[];
    pendingWrites: Array<{ data: string; callback?: () => void }>;
    screenText: string;
    element?: HTMLElement;
    textarea?: HTMLTextAreaElement;
    scrollLinesCalls: number[];
    scrollToTopCalls: number;
    scrollToBottomCalls: number;
    refreshCalls: Array<{ start: number; end: number }>;
    writeParsedHandlers: Set<() => void>;
    deferWrites: boolean;
    writeBeforeOpenCount: number;
    modes: { mouseTrackingMode: string };
    selection: string;
    completeNextWrite: () => void;
    viewportY: number;
    baseY: number;
    cursorY: number;
    wrappedLineIndexes: Set<number>;
    emitData: (data: string) => void;
    emitScroll: () => void;
    emitWriteParsed: () => void;
  }>
}));
const fitAddonMock = vi.hoisted(() => ({
  instances: [] as Array<{
    fitCalls: number;
    proposeDimensions: () => { cols: number; rows: number } | undefined;
  }>
}));

vi.mock("../src/api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/api.js")>()),
  api: apiMock
}));

vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    cols = 100;
    rows = 30;
    element?: HTMLElement;
    textarea?: HTMLTextAreaElement;
    options: {
      cols?: number;
      rows?: number;
      convertEol?: boolean;
      fontSize?: number;
      logLevel?: string;
    };
    writes: string[] = [];
    screenText = "";
    scrollLinesCalls: number[] = [];
    scrollToTopCalls = 0;
    scrollToBottomCalls = 0;
    refreshCalls: Array<{ start: number; end: number }> = [];
    viewportY = 0;
    baseY = 0;
    cursorY = 0;
    wrappedLineIndexes = new Set<number>();
    buffer: {
      active: {
        length: number;
        viewportY: number;
        baseY: number;
        cursorY: number;
        getLine(index: number): { translateToString(trimRight?: boolean): string } | undefined;
      };
    };
    dataHandlers = new Set<(data: string) => void>();
    customKeyEventHandler: ((event: KeyboardEvent) => boolean) | null = null;
    scrollHandlers = new Set<() => void>();
    writeParsedHandlers = new Set<() => void>();
    renderHandlers = new Set<() => void>();
    deferWrites = false;
    writeBeforeOpenCount = 0;
    modes = { mouseTrackingMode: "none" };
    selection = "";
    pendingWrites: Array<{ data: string; callback?: () => void }> = [];
    constructor(options: {
      cols?: number;
      rows?: number;
      convertEol?: boolean;
      fontSize?: number;
      logLevel?: string;
    }) {
      terminalAttachConstructionOrder.push("terminal");
      if (xtermMock.markConstructionTask) {
        window.setTimeout(() => terminalAttachConstructionOrder.push("task"), 0);
      }
      this.options = { ...options };
      const terminal = this;
      this.buffer = {
        active: {
          get viewportY() {
            return terminal.viewportY;
          },
          get baseY() {
            return terminal.baseY;
          },
          get cursorY() {
            return terminal.cursorY;
          },
          get length() {
            return Math.max(1, terminal.screenText.split(/\r?\n/).length);
          },
          getLine(index: number) {
            const line = terminal.screenText.split(/\r?\n/)[index] ?? "";
            const cells = Array.from(line);
            return {
              isWrapped: terminal.wrappedLineIndexes.has(index),
              length: cells.length,
              translateToString(trimRight?: boolean) {
                return trimRight ? line.trimEnd() : line;
              },
              // Written colours are stripped, so every cell has the default foreground.
              getCell(x: number) {
                const chars = cells[x];
                return chars === undefined ? undefined : {
                  getChars: () => chars,
                  getWidth: () => 1,
                  getFgColor: () => 0,
                  isFgDefault: () => true,
                  isFgPalette: () => false
                };
              }
            };
          }
        }
      };
      xtermMock.instances.push(this);
    }
    loadAddon() {}
    open(host: HTMLElement) {
      Object.defineProperties(host, {
        clientWidth: { configurable: true, value: 800 },
        clientHeight: { configurable: true, value: 400 }
      });
      const element = document.createElement("div");
      element.className = "xterm";
      const textarea = document.createElement("textarea");
      textarea.className = "xterm-helper-textarea";
      element.appendChild(textarea);
      host.appendChild(element);
      this.element = element;
      this.textarea = textarea;
    }
    focus() {
      this.textarea?.focus();
    }
    applyWrite(data: string) {
      this.writes.push(data);
      const clearScreen = "\u001b[2J";
      const clearIndex = data.lastIndexOf(clearScreen);
      const visibleData = (clearIndex >= 0 ? data.slice(clearIndex + clearScreen.length) : data)
        .replace(/\u001b(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "")
        .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
      this.screenText = `${clearIndex >= 0 ? "" : this.screenText}${visibleData}`;
    }
    write(data: string, callback?: () => void) {
      if (!this.element) this.writeBeforeOpenCount += 1;
      if (this.deferWrites) {
        this.pendingWrites.push({ data, callback });
        return;
      }
      this.applyWrite(data);
      callback?.();
    }
    completeNextWrite() {
      const pendingWrite = this.pendingWrites.shift();
      if (!pendingWrite) return;
      this.applyWrite(pendingWrite.data);
      pendingWrite.callback?.();
    }
    getSelection() {
      return this.selection;
    }
    clearSelection() {
      this.selection = "";
    }
    writeln(data: string) {
      this.writes.push(`${data}\n`);
      this.screenText = `${this.screenText}${data}\n`;
    }
    dispose() {}
    scrollLines(amount: number) {
      this.scrollLinesCalls.push(amount);
      this.viewportY = Math.max(0, Math.min(this.baseY, this.viewportY + amount));
      this.emitScroll();
    }
    scrollToTop() {
      this.scrollToTopCalls += 1;
      this.viewportY = 0;
      this.emitScroll();
    }
    scrollToBottom() {
      this.scrollToBottomCalls += 1;
      this.viewportY = this.baseY;
      this.emitScroll();
    }
    refresh(start: number, end: number) {
      this.refreshCalls.push({ start, end });
    }
    onData(handler: (data: string) => void) {
      this.dataHandlers.add(handler);
      return { dispose: () => this.dataHandlers.delete(handler) };
    }
    attachCustomKeyEventHandler(handler: (event: KeyboardEvent) => boolean) {
      this.customKeyEventHandler = handler;
    }
    onRender(handler: () => void) {
      this.renderHandlers.add(handler);
      return { dispose: () => this.renderHandlers.delete(handler) };
    }
    onWriteParsed(handler: () => void) {
      this.writeParsedHandlers.add(handler);
      return { dispose: () => this.writeParsedHandlers.delete(handler) };
    }
    onScroll(handler: () => void) {
      this.scrollHandlers.add(handler);
      return { dispose: () => this.scrollHandlers.delete(handler) };
    }
    emitData(data: string) {
      for (const handler of this.dataHandlers) handler(data);
    }
    emitScroll() {
      for (const handler of this.scrollHandlers) handler();
    }
    emitWriteParsed() {
      for (const handler of this.writeParsedHandlers) handler();
    }
    onResize() {
      return { dispose() {} };
    }
  }
}));

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    fitCalls = 0;
    constructor() {
      fitAddonMock.instances.push(this);
    }
    fit() {
      this.fitCalls += 1;
    }
    proposeDimensions() {
      return undefined;
    }
  }
}));

class MockWebSocket extends EventTarget {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 3;
  static autoOpen = true;
  static autoReady = true;
  static autoRunningStatus = true;
  static protocolVersion: 1 | 2 = 1;
  readyState = MockWebSocket.CONNECTING;
  sent: string[] = [];
  onSend: ((data: string) => void) | null = null;
  messageListenerRegistrations = 0;

  constructor(readonly url: string) {
    super();
    terminalAttachConstructionOrder.push("websocket");
    MockWebSocket.instances.push(this);
    if (MockWebSocket.autoOpen) window.setTimeout(() => this.open(), 0);
  }

  open() {
    if (this.readyState !== MockWebSocket.CONNECTING) return;
    this.readyState = MockWebSocket.OPEN;
    this.dispatchEvent(new Event("open"));
    if (MockWebSocket.autoReady) {
      const terminalUrl = new URL(this.url);
      const clientMode = terminalUrl.searchParams.get("clientMode") === "OBSERVER"
        ? "OBSERVER"
        : "INTERACTIVE";
      const leaseId = clientMode === "INTERACTIVE"
        ? `cli_control_lease:test-${MockWebSocket.instances.indexOf(this) + 1}`
        : null;
      const controlReady = MockWebSocket.protocolVersion === 2
        ? {
            protocolVersion: 2 as const,
            clientMode,
            controlState: clientMode === "INTERACTIVE" ? "CONTROLLER" as const : "OBSERVER" as const,
            leaseId,
            expiresAt: leaseId ? "2026-07-05T00:05:00.000Z" : null,
            heartbeatIntervalMs: 10_000
          }
        : {};
      this.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({
            type: "ready",
            paneId: terminalUrl.searchParams.get("paneId"),
            sessionId: terminalUrl.searchParams.get("sessionId"),
            runtimeId: terminalUrl.searchParams.get("runtimeId"),
            ...controlReady
          })
        })
      );
      if (MockWebSocket.autoRunningStatus) {
        this.dispatchEvent(
          new MessageEvent("message", {
            data: JSON.stringify({
              type: "status",
              status: "RUNNING",
              statusReason: "Attached to CLI process.",
              replayContinuity: "COMPLETE"
            })
          })
        );
      }
    }
  }

  override addEventListener(
    type: string,
    callback: EventListenerOrEventListenerObject | null,
    options?: boolean | AddEventListenerOptions
  ) {
    if (type === "message") this.messageListenerRegistrations += 1;
    super.addEventListener(type, callback, options);
  }

  send(data: string) {
    this.sent.push(data);
    this.onSend?.(data);
  }

  close() {
    this.readyState = MockWebSocket.CLOSED;
    this.dispatchEvent(new Event("close"));
  }

  static instances: MockWebSocket[] = [];
}

function cliPane(options: { terminalRuntimeId?: string; fresh?: boolean } = {}) {
  const freshNow = new Date().toISOString();
  const staleCreatedAt = "2026-07-05T00:00:00.000Z";
  const createdAt = options.fresh === false ? staleCreatedAt : freshNow;
  return {
    id: "pane:cli-upload",
    roomId: "room:cli-upload",
    title: "Codex CLI",
    titleSource: "auto" as const,
    mode: "TERMINAL" as const,
    status: "IDLE" as const,
    providerId: null,
    modelId: null,
    reasoningEffort: "medium" as const,
    cwd: "/opt/spaceapp",
    order: 0,
    columnSpan: 1,
    isMaximized: false,
    isMinimized: false,
    isClosed: false,
    split: { parentId: null, direction: null, size: null },
    categoryColor: null,
    vncTarget: null,
    terminalRuntimeId: options.terminalRuntimeId ?? null,
    createdAt,
    updatedAt: createdAt
  };
}

let uploadResponseSequence = 0;
function cliUploadResponse(files: File[]) {
  const responseId = ++uploadResponseSequence;
  return {
    sessionId: "cli_session:test-upload",
    paneId: "pane:cli-upload",
    roomId: "room:cli-upload",
    files: files.map((file, index) => ({
      artifactId: `artifact:test-upload:${responseId}:${index + 1}`,
      sessionId: "cli_session:test-upload",
      paneId: "pane:cli-upload",
      roomId: "room:cli-upload",
      originalFilename: file.name,
      storedFilename: `upload-test-${index + 1}-${file.name}`,
      mimeType: file.type || "application/octet-stream",
      byteSize: file.size,
      sha256: String.fromCharCode(97 + index).repeat(64),
      storageUri: `space-artifact://cli-uploads/${encodeURIComponent(file.name)}`,
      terminalPath: `/opt/spaceapp/var/artifacts/cli-uploads/${file.name}`,
      shellQuotedPath: `'/opt/spaceapp/var/artifacts/cli-uploads/${file.name}'`,
      isImage: file.type.startsWith("image/")
    }))
  };
}

function cliSessionResponse(
  token = "terminal-ws-ticket-test-value",
  sessionStatus = "IDLE",
  isActive = true,
  options: {
    sessionId?: string;
    modelId?: string | null;
    cliTaskId?: string | null;
    purpose?: "NORMAL" | "LOGIN";
    runtimeId?: "cli:codex" | "cli:claude" | "cli:gemini" | "cli:qwen" | "cli:deepseek" | "cli:opencode" | "cli:autohand" | "cli:kimi" | "cli:grok" | "cli:cursor" | "cli:copilot" | "cli:hermes" | "cli:omp" | "cli:qoder" | "cli:muse" | "cli:droid" | "cli:root";
    accountProfileId?: string | null;
    transcript?: Array<{
      chunkId: string;
      sessionId: string;
      paneId: string;
      roomId: string;
      sequence: number;
      stream: "stdin" | "stdout" | "stderr" | "system";
      content: string;
      byteLength: number;
      createdAt: string;
    }>;
  } = {}
) {
  const runtimeId = options.runtimeId ?? "cli:codex";
  const isClaude = runtimeId === "cli:claude";
  const isGemini = runtimeId === "cli:gemini";
  const isQwen = runtimeId === "cli:qwen";
  const isDeepSeek = runtimeId === "cli:deepseek";
  const isOpenCode = runtimeId === "cli:opencode";
  const providerId = isClaude ? "anthropic" : isGemini ? "google" : isQwen ? "alibaba" : isDeepSeek ? "deepseek" : isOpenCode ? "opencode" : "codex";
  const agentId = isClaude ? "claude" : isGemini ? "gemini" : isQwen ? "qwen" : isDeepSeek ? "deepseek" : isOpenCode ? "opencode" : "codex";
  const agentName = isClaude ? "Claude Code CLI" : isGemini ? "Gemini CLI" : isQwen ? "Qwen Code CLI" : isDeepSeek ? "DeepSeek CLI" : isOpenCode ? "OpenCode CLI" : "Codex CLI";
  return {
    session: {
      sessionId: options.sessionId ?? "cli_session:test-upload",
      paneId: "pane:cli-upload",
      roomId: "room:cli-upload",
      runtimeId,
      providerId,
      agentId,
      modelId: options.modelId ?? null,
      cliTaskId: options.cliTaskId ?? "cli_task:test-upload",
      accountProfileId: options.accountProfileId ?? null,
      reasoningEffort: "medium",
      purpose: options.purpose ?? "NORMAL",
      cwd: "/opt/spaceapp/var/artifacts/cli-workspaces/room_cli-upload/pane_cli-upload/cli_session_test-upload",
      status: sessionStatus,
      statusReason: "CLI session allocated.",
      exitCode: null,
      isActive,
      startedAt: "2026-07-05T00:00:00.000Z",
      updatedAt: "2026-07-05T00:00:00.000Z",
      endedAt: null
    },
    runtime: {
      id: runtimeId,
      providerId,
      providerName: isClaude ? "Anthropic" : isGemini ? "Google" : isQwen ? "Alibaba" : isDeepSeek ? "DeepSeek" : isOpenCode ? "OpenCode" : "Codex",
      agentId,
      agentName,
      displayName: agentName,
      capabilities: ["CLI"],
      adapterStatus: "ENABLED",
      authMode: "NONE",
      authState: "READY",
      authReason: "Runtime credentials are verified.",
      canStartLogin: false,
      status: "ENABLED",
      statusReason: "Codex CLI command and credential smoke are verified.",
      commandName: isClaude ? "claude-vscode-parity" : isGemini ? "gemini-vscode-parity" : isQwen ? "qwen-vscode-parity" : isDeepSeek ? "deepseek-vscode-parity" : isOpenCode ? "opencode" : "codex",
      detectedCommandPath: `/opt/spaceapp/bin/${isClaude ? "claude-vscode-parity" : isGemini ? "gemini-vscode-parity" : isQwen ? "qwen-vscode-parity" : isDeepSeek ? "deepseek-vscode-parity" : isOpenCode ? "opencode" : "codex"}`,
      defaultModelId: null,
      supportedReasoningEfforts: isDeepSeek ? [] : ["medium", "high"],
      checkedAt: "2026-07-05T00:00:00.000Z"
    },
    transcript: options.transcript ?? [],
    websocket: {
      paneId: "pane:cli-upload",
      sessionId: options.sessionId ?? "cli_session:test-upload",
      token,
      expiresAt: "2026-07-05T00:01:00.000Z"
    }
  };
}

function cliModelSettingsResponse(options: {
  sessionId?: string;
  current?: PaneCliModelSettings["current"];
  models?: PaneCliModelSettings["models"];
} = {}): PaneCliModelSettings {
  return {
    sessionId: options.sessionId ?? "cli_session:test-upload",
    threadId: null,
    current: options.current ?? { modelId: "gpt-5-mini", reasoningEffort: "medium" },
    models: options.models ?? [
      {
        id: "gpt-5-mini",
        displayName: "GPT-5 Mini",
        isDefault: true,
        defaultReasoningEffort: "medium",
        supportedReasoningEfforts: ["medium", "high"]
      }
    ],
    controlMode: "DIRECT",
    isTurnActive: false
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function readFileText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(String(reader.result ?? "")));
    reader.addEventListener("error", () => reject(reader.error ?? new Error("FileReader failed")));
    reader.readAsText(file, "UTF-8");
  });
}

// Since 14943f2a73 upload previews live in the closed-by-default "Photos (N)" popover.
async function openPhotoPreviews(count: number, title = "Codex CLI") {
  const trigger = await screen.findByRole("button", { name: `Photos (${count}) for ${title}` });
  if (trigger.getAttribute("aria-expanded") !== "true") fireEvent.click(trigger);
  return trigger;
}

describe("TerminalPane uploads and paste", () => {
  beforeEach(() => {
    uploadResponseSequence = 0;
    resetCliClientEventReporter();
    installSpaceRuntime(liveRuntime);
    apiMock.cliRuntimes.mockReset();
    apiMock.activeCliSession.mockReset();
    apiMock.createCliSession.mockReset();
    apiMock.recoveryCliTask.mockReset();
    apiMock.resumeCliSession.mockReset();
    apiMock.cliModelSettings.mockReset();
    apiMock.cliModelSettingsStatus.mockReset();
    apiMock.updateCliModelSettings.mockReset();
    apiMock.cliTurnActivity.mockReset();
    apiMock.interruptCliSession.mockReset();
    apiMock.abortCliTurn.mockReset();
    apiMock.uploadCliFiles.mockReset();
    apiMock.deleteArtifact.mockReset().mockResolvedValue({ ok: true });
    apiMock.createClipboardItem.mockReset();
    apiMock.createMemory.mockReset();
    apiMock.reportCliClipboardDebug.mockReset();
    apiMock.reportCliClientEvent.mockReset();
    apiMock.cliTerminalWebSocketUrl.mockReset();
    apiMock.listCliAccountProfiles.mockReset();
    apiMock.setCliTerminalControlLease.mockReset();
    apiMock.invalidateCliRuntimes.mockReset();
    apiMock.artifacts.mockReset().mockResolvedValue({ data: [], pagination: { totalPages: 0 } });
    apiMock.artifactFileUrl.mockReset().mockImplementation((id: string) => `/api/artifacts/${encodeURIComponent(id)}/file`);
    MockWebSocket.instances = [];
    MockWebSocket.autoOpen = true;
    MockWebSocket.autoReady = true;
    MockWebSocket.autoRunningStatus = true;
    MockWebSocket.protocolVersion = 1;
    terminalAttachConstructionOrder.length = 0;
    xtermMock.markConstructionTask = false;
    xtermMock.instances = [];
    fitAddonMock.instances = [];
    window.localStorage.removeItem("space.clipboardDebug");
    window.localStorage.removeItem("space.cliDebugMode");
    window.localStorage.setItem(
      VOICE_SETTINGS_STORAGE_KEY,
      JSON.stringify({ ...defaultVoiceComposerSettings, terminalModelPicker: true })
    );
    window.sessionStorage.removeItem("space.cliActiveTurn:pane:cli-upload");
    vi.stubGlobal("WebSocket", MockWebSocket);
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        disconnect() {}
      }
    );
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:space-cli-upload-preview");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    apiMock.cliTerminalWebSocketUrl.mockImplementation(
      (
        ticket: { paneId: string; sessionId: string },
        options: { clientMode?: "INTERACTIVE" | "OBSERVER"; leaseId?: string | null } = {}
      ) =>
        `ws://space.test/terminal?paneId=${encodeURIComponent(ticket.paneId)}` +
        `&sessionId=${encodeURIComponent(ticket.sessionId)}&runtimeId=cli%3Acodex` +
        `&protocolVersion=2&clientMode=${options.clientMode ?? "INTERACTIVE"}` +
        (options.leaseId ? `&leaseId=${encodeURIComponent(options.leaseId)}` : "")
    );
    apiMock.cliRuntimes.mockResolvedValue({
      data: [
        {
          id: "cli:codex",
          providerId: "codex",
          providerName: "Codex",
          agentId: "codex",
          agentName: "Codex CLI",
          displayName: "Codex CLI",
          capabilities: ["CLI"],
          adapterStatus: "ENABLED",
          authMode: "NONE",
          authState: "READY",
          authReason: "Runtime credentials are verified.",
          canStartLogin: false,
          status: "ENABLED",
          statusReason: "Codex CLI command and credential smoke are verified.",
          commandName: "codex",
          detectedCommandPath: "/opt/spaceapp/bin/codex",
          defaultModelId: null,
          supportedReasoningEfforts: ["medium", "high"],
          checkedAt: "2026-07-05T00:00:00.000Z"
        }
      ],
      checkedAt: "2026-07-05T00:00:00.000Z"
    });
    apiMock.activeCliSession.mockResolvedValue(null);
    apiMock.listCliAccountProfiles.mockResolvedValue({ profiles: [] });
    apiMock.createCliSession.mockImplementation(async () =>
      cliSessionResponse(`terminal-ws-ticket-test-value-${apiMock.createCliSession.mock.calls.length}`)
    );
    apiMock.recoveryCliTask.mockResolvedValue({
      threads: [],
      total: 0,
      page: 1,
      pageSize: 1
    });
    apiMock.cliModelSettings.mockResolvedValue({
      sessionId: "cli_session:test-upload",
      threadId: null,
      current: null,
      models: [
        {
          id: "gpt-5-mini",
          displayName: "GPT-5 Mini",
          isDefault: true,
          defaultReasoningEffort: "medium",
          supportedReasoningEfforts: ["medium", "high"]
        }
      ],
      controlMode: "DIRECT",
      isTurnActive: false
    });
    apiMock.cliModelSettingsStatus.mockImplementation(async (...args: unknown[]) => ({
      status: "AVAILABLE" as const,
      settings: await apiMock.cliModelSettings(...args)
    }));
    apiMock.cliTurnActivity.mockImplementation(async (_paneId: string, marker: string) => ({ marker, status: "UNAVAILABLE", turnId: null }));
    apiMock.uploadCliFiles.mockImplementation(async ({ files }: { files: File[] }) => cliUploadResponse(files));
    apiMock.createClipboardItem.mockResolvedValue({ id: "clipboard:captured" });
    apiMock.createMemory.mockResolvedValue({
      id: "memory:test-cli-save",
      scope: "ROOM",
      roomId: "room:cli-upload",
      title: "CLI memory save request - Codex CLI",
      body: "saved",
      provenance: "space-cli-memory-save",
      createdAt: "2026-07-05T00:00:00.000Z",
      updatedAt: "2026-07-05T00:00:00.000Z"
    });
    apiMock.reportCliClipboardDebug.mockResolvedValue({ ok: true, requestId: "req:test-clipboard-debug" });
    apiMock.reportCliClientEvent.mockResolvedValue({ accepted: true });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("starts the terminal websocket before constructing xterm", async () => {
    apiMock.activeCliSession.mockResolvedValueOnce(
      cliSessionResponse("terminal-ws-ticket-existing-active", "RUNNING", true)
    );

    render(<TerminalPane pane={cliPane()} terminalFontSize={12} />);

    await waitFor(() => expect(terminalAttachConstructionOrder).toHaveLength(2));
    expect(terminalAttachConstructionOrder).toEqual(["websocket", "terminal"]);
  });

  it("restarts only this Gemini pane when its Google account changes", async () => {
    const activeSession = cliSessionResponse("terminal-ws-ticket-gemini-main", "RUNNING", true, {
      runtimeId: "cli:gemini",
      sessionId: "cli_session:gemini-main",
      accountProfileId: null
    });
    apiMock.cliRuntimes.mockResolvedValueOnce({ data: [activeSession.runtime], checkedAt: "2026-08-13T00:00:00.000Z" });
    apiMock.activeCliSession.mockResolvedValueOnce(activeSession);
    apiMock.listCliAccountProfiles.mockResolvedValueOnce({
      profiles: [
        { runtimeId: "cli:gemini", profileId: "main", displayName: "Main account", createdAt: "2026-08-13T00:00:00.000Z", updatedAt: "2026-08-13T00:00:00.000Z", updatedBy: null },
        { runtimeId: "cli:gemini", profileId: "work", displayName: "Work account", createdAt: "2026-08-13T00:00:00.000Z", updatedAt: "2026-08-13T00:00:00.000Z", updatedBy: null }
      ]
    });
    apiMock.createCliSession.mockResolvedValueOnce(cliSessionResponse("terminal-ws-ticket-gemini-work", "IDLE", true, {
      runtimeId: "cli:gemini",
      sessionId: "cli_session:gemini-work",
      accountProfileId: "work"
    }));

    render(
      <VoiceInputProvider>
        <TerminalPane pane={cliPane({ terminalRuntimeId: "cli:gemini" })} terminalFontSize={12} />
      </VoiceInputProvider>
    );
    const trigger = await screen.findByRole("button", { name: "Google account for Codex CLI" });
    fireEvent.click(trigger);
    const menu = await screen.findByRole("menu", { name: "Google account for Codex CLI" });
    expect(within(menu).getAllByRole("menuitemradio")).toHaveLength(2);
    fireEvent.click(within(menu).getByRole("menuitemradio", { name: /Work account/ }));

    await waitFor(() => expect(apiMock.createCliSession).toHaveBeenCalledWith("pane:cli-upload", {
      runtimeId: "cli:gemini",
      accountProfileId: "work",
      reasoningEffort: "medium",
      cwd: "/opt/spaceapp",
      forceRestart: true,
      resume: true,
      includeTranscript: false
    }));
    expect(apiMock.createCliSession).toHaveBeenCalledTimes(1);
  });

  it("restarts only this Claude pane on the selected Claude account", async () => {
    const activeSession = cliSessionResponse("terminal-ws-ticket-claude-main", "RUNNING", true, {
      runtimeId: "cli:claude",
      sessionId: "cli_session:claude-main",
      accountProfileId: null
    });
    apiMock.cliRuntimes.mockResolvedValueOnce({ data: [activeSession.runtime], checkedAt: "2026-08-13T00:00:00.000Z" });
    apiMock.activeCliSession.mockResolvedValueOnce(activeSession);
    apiMock.listCliAccountProfiles.mockResolvedValueOnce({
      profiles: [
        { runtimeId: "cli:claude", profileId: "main", displayName: "Main account", createdAt: "2026-08-13T00:00:00.000Z", updatedAt: "2026-08-13T00:00:00.000Z", updatedBy: null },
        { runtimeId: "cli:claude", profileId: "work", displayName: "Work account", createdAt: "2026-08-13T00:00:00.000Z", updatedAt: "2026-08-13T00:00:00.000Z", updatedBy: null }
      ]
    });
    apiMock.createCliSession.mockResolvedValueOnce(cliSessionResponse("terminal-ws-ticket-claude-work", "IDLE", true, {
      runtimeId: "cli:claude",
      sessionId: "cli_session:claude-work",
      accountProfileId: "work"
    }));

    render(
      <VoiceInputProvider>
        <TerminalPane pane={cliPane({ terminalRuntimeId: "cli:claude" })} terminalFontSize={12} />
      </VoiceInputProvider>
    );
    const trigger = await screen.findByRole("button", { name: "Claude account for Codex CLI" });
    expect(screen.queryByRole("button", { name: "Google account for Codex CLI" })).toBeNull();
    expect(trigger.getAttribute("title")).toMatch(/^Claude account: Main account/);
    // One click opens the account list directly; no nested select.
    fireEvent.click(trigger);
    const menu = await screen.findByRole("menu", { name: "Claude account for Codex CLI" });
    const items = within(menu).getAllByRole("menuitemradio");
    expect(items.map((item) => item.querySelector("strong")?.textContent)).toEqual(["Main account", "Work account"]);
    expect(items.map((item) => item.getAttribute("aria-checked"))).toEqual(["true", "false"]);
    expect(within(items[0]!).getByText("Active")).toBeTruthy();
    expect(apiMock.listCliAccountProfiles).toHaveBeenCalledWith("cli:claude");
    fireEvent.click(items[1]!);

    await waitFor(() => expect(apiMock.createCliSession).toHaveBeenCalledWith("pane:cli-upload", expect.objectContaining({
      runtimeId: "cli:claude",
      accountProfileId: "work",
      forceRestart: true,
      resume: true,
      includeTranscript: false
    })));
    expect(apiMock.createCliSession).toHaveBeenCalledTimes(1);
  });

  it.each([
    { ready: true, remembered: "work", expected: "space-gateway", label: "Space Gateway" },
    { ready: false, remembered: "space-gateway", expected: "main", label: "Main account" }
  ])("starts a new Claude pane on $expected when Space Gateway ready=$ready", async ({ ready, remembered, expected, label }) => {
    const claudeProfile = (profileId: string, displayName: string) =>
      ({ runtimeId: "cli:claude", profileId, displayName, createdAt: "2026-10-12T00:00:00.000Z", updatedAt: "2026-10-12T00:00:00.000Z", updatedBy: null });
    const started = cliSessionResponse("terminal-ws-ticket-claude-new", "IDLE", true, {
      runtimeId: "cli:claude",
      sessionId: "cli_session:claude-new",
      accountProfileId: expected
    });
    window.localStorage.setItem("space.cli.claude.account-profile", remembered);
    apiMock.cliRuntimes.mockResolvedValueOnce({ data: [started.runtime], checkedAt: "2026-10-12T00:00:00.000Z" });
    apiMock.listCliAccountProfiles.mockResolvedValue({
      profiles: [claudeProfile("main", "Main account"), claudeProfile("work", "Work account"), claudeProfile("space-gateway", "Space Gateway")],
      gatewayProfile: { profileId: "space-gateway", ready }
    });
    apiMock.createCliSession.mockResolvedValueOnce(started);

    try {
      render(
        <VoiceInputProvider>
          <TerminalPane pane={cliPane({ terminalRuntimeId: "cli:claude" })} terminalFontSize={12} />
        </VoiceInputProvider>
      );
      await waitFor(() => expect(apiMock.createCliSession).toHaveBeenCalledWith("pane:cli-upload", expect.objectContaining({
        runtimeId: "cli:claude",
        accountProfileId: expected
      })));
      expect(apiMock.createCliSession).toHaveBeenCalledTimes(1);
      const trigger = await screen.findByRole("button", { name: "Claude account for Codex CLI" });
      await waitFor(() => expect(trigger.getAttribute("title")).toMatch(new RegExp(`^Claude account: ${label}`)));
    } finally {
      window.localStorage.removeItem("space.cli.claude.account-profile");
    }
  });

  it.each([
    { source: "this device's launch", opened: "work", saved: null, expected: "work" },
    { source: "the saved Job Copilot default", opened: null, saved: "work", expected: "work" },
    { source: "the ready Space Gateway without a choice", opened: null, saved: null, expected: "space-gateway" }
  ])("starts a new Job Copilot pane on the account from $source", async ({ opened, saved, expected }) => {
    const claudeProfile = (profileId: string, displayName: string) =>
      ({ runtimeId: "cli:claude", profileId, displayName, createdAt: "2026-10-12T00:00:00.000Z", updatedAt: "2026-10-12T00:00:00.000Z", updatedBy: null });
    const started = cliSessionResponse("terminal-ws-ticket-claude-job", "IDLE", true, {
      runtimeId: "cli:claude",
      sessionId: "cli_session:claude-job",
      accountProfileId: expected
    });
    apiMock.userSettings.mockResolvedValue(saved ? { jobCopilot: { runtimeId: "cli:claude", accountProfileId: saved, askOnLaunch: false } } : {});
    apiMock.cliRuntimes.mockResolvedValueOnce({ data: [started.runtime], checkedAt: "2026-10-12T00:00:00.000Z" });
    apiMock.listCliAccountProfiles.mockResolvedValue({
      profiles: [claudeProfile("main", "Main account"), claudeProfile("work", "Work account"), claudeProfile("space-gateway", "Space Gateway")],
      gatewayProfile: { profileId: "space-gateway", ready: true }
    });
    apiMock.createCliSession.mockResolvedValueOnce(started);
    const jobPane = { ...cliPane({ terminalRuntimeId: "cli:claude" }), mode: "JOB_APPLY" as const };
    if (opened) rememberNewPaneAccount([jobPane.id], "cli:claude", opened);
    render(
      <VoiceInputProvider>
        <TerminalPane pane={jobPane} terminalFontSize={12} />
      </VoiceInputProvider>
    );
    await waitFor(() => expect(apiMock.createCliSession).toHaveBeenCalledWith("pane:cli-upload", expect.objectContaining({
      runtimeId: "cli:claude",
      accountProfileId: expected
    })));
    expect(apiMock.createCliSession).toHaveBeenCalledTimes(1);
  });

  it("preserves active model and reasoning effort when Google account changes", async () => {
    const activeSession = cliSessionResponse("terminal-ws-ticket-gemini-main", "RUNNING", true, {
      runtimeId: "cli:gemini",
      sessionId: "cli_session:gemini-main",
      accountProfileId: null,
      modelId: "gemini-3.8-flash-high"
    });
    apiMock.cliRuntimes.mockResolvedValueOnce({ data: [activeSession.runtime], checkedAt: "2026-08-13T00:00:00.000Z" });
    apiMock.activeCliSession.mockResolvedValueOnce(activeSession);
    apiMock.listCliAccountProfiles.mockResolvedValueOnce({
      profiles: [
        { runtimeId: "cli:gemini", profileId: "main", displayName: "Main account", createdAt: "2026-08-13T00:00:00.000Z", updatedAt: "2026-08-13T00:00:00.000Z", updatedBy: null },
        { runtimeId: "cli:gemini", profileId: "work", displayName: "Work account", createdAt: "2026-08-13T00:00:00.000Z", updatedAt: "2026-08-13T00:00:00.000Z", updatedBy: null }
      ]
    });
    apiMock.createCliSession.mockResolvedValueOnce(cliSessionResponse("terminal-ws-ticket-gemini-work", "IDLE", true, {
      runtimeId: "cli:gemini",
      sessionId: "cli_session:gemini-work",
      accountProfileId: "work",
      modelId: "gemini-3.8-flash-high"
    }));

    render(
      <VoiceInputProvider>
        <TerminalPane pane={cliPane({ terminalRuntimeId: "cli:gemini" })} terminalFontSize={12} />
      </VoiceInputProvider>
    );
    const trigger = await screen.findByRole("button", { name: "Google account for Codex CLI" });
    fireEvent.click(trigger);
    const menu = await screen.findByRole("menu", { name: "Google account for Codex CLI" });
    fireEvent.click(within(menu).getByRole("menuitemradio", { name: /Work account/ }));

    await waitFor(() => expect(apiMock.createCliSession).toHaveBeenCalledWith("pane:cli-upload", {
      runtimeId: "cli:gemini",
      accountProfileId: "work",
      modelId: "gemini-3.8-flash-high",
      reasoningEffort: "medium",
      cwd: "/opt/spaceapp",
      forceRestart: true,
      resume: true,
      includeTranscript: false
    }));
  });

  it("reports reveal readiness with the latest presentation generation", async () => {
    const sessionGate = deferred<ReturnType<typeof cliSessionResponse>>();
    const onRevealReady = vi.fn();
    apiMock.createCliSession.mockReturnValueOnce(sessionGate.promise);
    const view = render(
      <TerminalPane
        pane={cliPane()}
        terminalFontSize={12}
        revealGeneration={1}
        onRevealReady={onRevealReady}
      />
    );

    await waitFor(() => expect(apiMock.createCliSession).toHaveBeenCalledTimes(1));
    expect(onRevealReady).not.toHaveBeenCalled();
    view.rerender(withVoiceInput(
      <TerminalPane
        pane={cliPane()}
        terminalFontSize={12}
        revealGeneration={2}
        onRevealReady={onRevealReady}
      />
    ));
    const session = cliSessionResponse();
    sessionGate.resolve(session);

    await waitFor(() => expect(onRevealReady).toHaveBeenCalledWith("pane:cli-upload", 2));
    expect(onRevealReady.mock.calls.every(([, generation]) => generation === 2)).toBe(true);
  });

  it("settles an observer-only visible pane with no active CLI session without starting one", async () => {
    const onRevealReady = vi.fn();

    render(
      <TerminalPane
        pane={cliPane()}
        terminalFontSize={12}
        observerOnly
        revealGeneration={3}
        onRevealReady={onRevealReady}
      />
    );

    await waitFor(() => expect(apiMock.activeCliSession).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(onRevealReady).toHaveBeenCalledWith("pane:cli-upload", 3));
    expect(apiMock.cliRuntimes).not.toHaveBeenCalled();
    expect(apiMock.createCliSession).not.toHaveBeenCalled();
    expect(screen.getByLabelText("CLI pane Codex CLI").getAttribute("data-terminal-status")).toBe("idle");
  });

  it("prefills an observer-only hidden active session without waiting for the launcher catalog", async () => {
    MockWebSocket.autoRunningStatus = false;
    const onPrefillReadyChange = vi.fn();
    apiMock.activeCliSession.mockResolvedValueOnce(
      cliSessionResponse("terminal-ws-ticket-observer-prefill", "RUNNING", true)
    );

    render(
      <TerminalPane
        pane={cliPane()}
        terminalFontSize={12}
        isVisible={false}
        observerOnly
        prefillInitialReplay
        onPrefillReadyChange={onPrefillReadyChange}
      />
    );

    await waitFor(() => expect(MockWebSocket.instances[0]?.readyState).toBe(MockWebSocket.OPEN));
    expect(apiMock.cliRuntimes).not.toHaveBeenCalled();
    expect(apiMock.createCliSession).not.toHaveBeenCalled();
    expect(
      screen.getByLabelText("CLI pane Codex CLI").getAttribute("data-terminal-prefill-ready")
    ).toBe("false");

    const socket = MockWebSocket.instances[0]!;
    act(() => {
      socket.dispatchEvent(new MessageEvent("message", {
        data: JSON.stringify({ type: "output", stream: "stdout", data: "observer-prefill\n" })
      }));
      socket.dispatchEvent(new MessageEvent("message", {
        data: JSON.stringify({
          type: "status",
          status: "RUNNING",
          statusReason: "Attached to CLI process.",
          replayContinuity: "COMPLETE"
        })
      }));
    });

    await waitFor(() => expect(xtermMock.instances[0]?.writes).toEqual(["observer-prefill\n"]));
    await waitFor(() =>
      expect(onPrefillReadyChange).toHaveBeenLastCalledWith("pane:cli-upload", true)
    );
    expect(xtermMock.instances[0]?.element).toBeUndefined();
  });

  it.each([false, true])("does not force a history redraw on warm room return (control reacquired: %s)", async (reacquireControl) => {
    MockWebSocket.protocolVersion = 2;
    const view = render(<TerminalPane pane={cliPane()} terminalFontSize={12} isVisible />);
    await waitFor(() => expect(MockWebSocket.instances[0]?.readyState).toBe(MockWebSocket.OPEN));
    const socket = MockWebSocket.instances[0]!;
    const terminal = xtermMock.instances[0]!;
    const resizeFrames = () => socket.sent.map((frame) => JSON.parse(frame)).filter((frame) => frame.type === "resize");
    const settle = async () => act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 150));
    });
    const receive = (message: object) => act(() => {
      socket.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(message) }));
    });
    await waitFor(() => expect(resizeFrames().length).toBeGreaterThan(0));
    await settle();
    const element = terminal.element;
    const sessionRequests = apiMock.createCliSession.mock.calls.length;

    view.rerender(withVoiceInput(<TerminalPane pane={cliPane()} terminalFontSize={12} isVisible={false} />));
    receive({ type: "output", stream: "stdout", data: "ordered hidden output\n" });
    await settle();
    const beforeReturn = socket.sent.length;
    view.rerender(withVoiceInput(<TerminalPane pane={cliPane()} terminalFontSize={12} isVisible />));
    await settle();
    if (reacquireControl) {
      const leaseId = "cli_control_lease:warm-return";
      const expiresAt = new Date(Date.now() + 60_000).toISOString();
      receive({ type: "control_granted", leaseId, expiresAt });
      await settle();
      receive({ type: "control_state", controlState: "CONTROLLER", leaseId, expiresAt });
      await settle();
    }
    const returnResizes = socket.sent.slice(beforeReturn).map((frame) => JSON.parse(frame))
      .filter((frame) => frame.type === "resize");
    expect(xtermMock.instances).toHaveLength(1);
    expect(terminal.element).toBe(element);
    expect(MockWebSocket.instances).toHaveLength(1);
    expect(apiMock.createCliSession).toHaveBeenCalledTimes(sessionRequests);
    expect(terminal.writes.join("")).toContain("ordered hidden output\n");
    expect(returnResizes.filter((frame) => frame.force)).toEqual([]);
    expect(returnResizes).toHaveLength(reacquireControl ? 1 : 0);
  });

  it("takes over protocol-v2 terminal control only after terminal input", async () => {
    MockWebSocket.autoReady = false;
    MockWebSocket.protocolVersion = 2;
    render(
      <VoiceInputProvider>
        <TerminalPane pane={cliPane()} terminalFontSize={12} />
      </VoiceInputProvider>
    );

    await waitFor(() => expect(MockWebSocket.instances[0]?.readyState).toBe(MockWebSocket.OPEN));
    const socket = MockWebSocket.instances[0]!;
    act(() => {
      socket.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({
            type: "ready",
            paneId: "pane:cli-upload",
            sessionId: "cli_session:test-upload",
            runtimeId: "cli:codex",
            protocolVersion: 2,
            clientMode: "INTERACTIVE",
            controlState: "HELD_BY_OTHER",
            leaseId: "cli_control_lease:other-page",
            expiresAt: "2026-07-05T00:05:00.000Z",
            heartbeatIntervalMs: 10_000
          })
        })
      );
    });

    expect(socket.sent.map((frame) => JSON.parse(frame))).not.toContainEqual({
      type: "control_takeover",
      expectedLeaseId: "cli_control_lease:other-page",
      interactionId: expect.any(String)
    });

    act(() => {
      xtermMock.instances[0]?.textarea?.focus();
    });

    expect(socket.sent.map((frame) => JSON.parse(frame))).not.toContainEqual({
      type: "control_takeover",
      expectedLeaseId: "cli_control_lease:other-page",
      interactionId: expect.any(String)
    });

    act(() => {
      xtermMock.instances[0]?.emitData("take-control");
    });

    await waitFor(() =>
      expect(socket.sent.map((frame) => JSON.parse(frame))).toContainEqual({
        type: "control_takeover",
        expectedLeaseId: "cli_control_lease:other-page",
        interactionId: expect.any(String)
      })
    );
  });

  it("waits for terminal control before uploading a file to an attached CLI session", async () => {
    MockWebSocket.autoReady = false;
    MockWebSocket.protocolVersion = 2;
    render(
      <VoiceInputProvider>
        <TerminalPane pane={cliPane()} terminalFontSize={12} />
      </VoiceInputProvider>
    );

    await waitFor(() => expect(MockWebSocket.instances[0]?.readyState).toBe(MockWebSocket.OPEN));
    const socket = MockWebSocket.instances[0]!;
    act(() => {
      socket.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({
            type: "ready",
            paneId: "pane:cli-upload",
            sessionId: "cli_session:test-upload",
            runtimeId: "cli:codex",
            protocolVersion: 2,
            clientMode: "INTERACTIVE",
            controlState: "HELD_BY_OTHER",
            leaseId: "cli_control_lease:other-page",
            expiresAt: "2026-07-05T00:05:00.000Z",
            heartbeatIntervalMs: 10_000
          })
        })
      );
    });

    const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
    const click = vi.spyOn(input, "click");
    act(() => {
      window.dispatchEvent(
        new CustomEvent("space:terminal-pane-action", {
          detail: { paneId: "pane:cli-upload", action: "upload" }
        })
      );
    });

    await waitFor(() =>
      expect(socket.sent.map((frame) => JSON.parse(frame))).toContainEqual({
        type: "control_takeover",
        expectedLeaseId: "cli_control_lease:other-page",
        interactionId: expect.any(String)
      })
    );

    expect(click).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("Attach a CLI session before uploading files.")).toBeNull();

    const photo = new File(["photo"], "control-handoff.png", { type: "image/png" });
    fireEvent.change(input, { target: { files: [photo] } });
    expect(apiMock.uploadCliFiles).not.toHaveBeenCalled();

    act(() => {
      socket.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({
            type: "control_granted",
            leaseId: "cli_control_lease:upload-owner",
            expiresAt: "2026-07-05T00:05:00.000Z"
          })
        })
      );
    });

    await waitFor(() =>
      expect(apiMock.uploadCliFiles).toHaveBeenCalledWith({
        paneId: "pane:cli-upload",
        source: "USER_UPLOAD",
        files: [photo]
      })
    );
    expect(screen.queryByText("Attach a CLI session before uploading files.")).toBeNull();
  });

  it("acquires terminal control and uploads files even when document visibility is hidden during file chooser return", async () => {
    MockWebSocket.autoReady = false;
    MockWebSocket.protocolVersion = 2;
    render(
      <VoiceInputProvider>
        <TerminalPane pane={cliPane()} terminalFontSize={12} />
      </VoiceInputProvider>
    );

    await waitFor(() => expect(MockWebSocket.instances[0]?.readyState).toBe(MockWebSocket.OPEN));
    const socket = MockWebSocket.instances[0]!;
    act(() => {
      socket.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({
            type: "ready",
            paneId: "pane:cli-upload",
            sessionId: "cli_session:test-upload",
            runtimeId: "cli:codex",
            protocolVersion: 2,
            clientMode: "INTERACTIVE",
            controlState: "HELD_BY_OTHER",
            leaseId: "cli_control_lease:other-page",
            expiresAt: "2026-07-05T00:05:00.000Z",
            heartbeatIntervalMs: 10_000
          })
        })
      );
    });

    const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
    act(() => {
      window.dispatchEvent(
        new CustomEvent("space:terminal-pane-action", {
          detail: { paneId: "pane:cli-upload", action: "upload" }
        })
      );
    });

    await waitFor(() =>
      expect(socket.sent.map((frame) => JSON.parse(frame))).toContainEqual({
        type: "control_takeover",
        expectedLeaseId: "cli_control_lease:other-page",
        interactionId: expect.any(String)
      })
    );

    const visibilitySpy = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    const photo = new File(["photo"], "mobile-upload.png", { type: "image/png" });
    fireEvent.change(input, { target: { files: [photo] } });

    expect(screen.queryByText("This terminal is live read-only in the current page.")).toBeNull();

    act(() => {
      socket.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({
            type: "control_granted",
            leaseId: "cli_control_lease:upload-owner",
            expiresAt: "2026-07-05T00:05:00.000Z"
          })
        })
      );
    });

    await waitFor(() =>
      expect(apiMock.uploadCliFiles).toHaveBeenCalledWith({
        paneId: "pane:cli-upload",
        source: "USER_UPLOAD",
        files: [photo]
      })
    );
    expect(screen.queryByText("This terminal is live read-only in the current page.")).toBeNull();
    visibilitySpy.mockRestore();
  });

  it("connects a background page as an observer and never requests terminal control", async () => {
    MockWebSocket.protocolVersion = 2;
    render(<TerminalPane pane={cliPane()} terminalFontSize={12} isVisible={false} />);

    await waitFor(() => expect(MockWebSocket.instances[0]?.readyState).toBe(MockWebSocket.OPEN));
    const socket = MockWebSocket.instances[0]!;
    expect(new URL(socket.url).searchParams.get("clientMode")).toBe("OBSERVER");
    expect(socket.sent.some((frame) => {
      const type = (JSON.parse(frame) as { type?: string }).type;
      return type === "control_request" || type === "control_takeover";
    })).toBe(false);
    expect(socket.readyState).toBe(MockWebSocket.OPEN);
  });

  it.each([true, false])("sizes a hidden full-screen pane's CLI under a borrowed lease only when asked to presize (%s)", async (presize) => {
    MockWebSocket.protocolVersion = 2;
    recordFullscreenGeometry(133, 41);
    render(
      <TerminalPane pane={cliPane()} terminalFontSize={12} isVisible={false} fullscreenLayout presizeInFullscreen={presize} />
    );
    await waitFor(() => expect(MockWebSocket.instances[0]?.readyState).toBe(MockWebSocket.OPEN));
    const socket = MockWebSocket.instances[0]!;
    const frames = () => socket.sent.map((frame) => JSON.parse(frame) as { type: string; cols?: number; rows?: number; leaseId?: string });
    const types = () => frames().map((frame) => frame.type);
    const receive = (message: object) => act(() => {
      socket.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(message) }));
    });
    if (!presize) {
      await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 100)); });
      expect(types().filter((type) => type.startsWith("control_") || type === "resize")).toEqual([]);
      return;
    }
    await waitFor(() => expect(types()).toContain("control_upgrade"));
    receive({ type: "control_upgraded" });
    await waitFor(() => expect(types()).toContain("control_request"));
    receive({ type: "control_granted", leaseId: "cli_control_lease:presize", expiresAt: new Date(Date.now() + 60_000).toISOString() });
    await waitFor(() => expect(types()).toContain("control_release"));
    expect(frames().filter((frame) => frame.type === "resize")).toEqual([
      expect.objectContaining({ cols: 133, rows: 41, leaseId: "cli_control_lease:presize" })
    ]);
    expect(types().indexOf("resize")).toBeLessThan(types().indexOf("control_release"));
  });

  it("presizes a hidden full-screen pane once an unfocused page gets focus back", async () => {
    vi.mocked(document.hasFocus).mockReturnValue(false);
    MockWebSocket.protocolVersion = 2;
    recordFullscreenGeometry(127, 39);
    render(<TerminalPane pane={cliPane()} terminalFontSize={12} isVisible={false} fullscreenLayout presizeInFullscreen />);
    await waitFor(() => expect(MockWebSocket.instances[0]?.readyState).toBe(MockWebSocket.OPEN));
    const socket = MockWebSocket.instances[0]!;
    const types = () => socket.sent.map((frame) => (JSON.parse(frame) as { type: string }).type);
    await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 100)); });
    expect(types()).not.toContain("control_upgrade");
    vi.mocked(document.hasFocus).mockReturnValue(true);
    act(() => { window.dispatchEvent(new Event("focus")); });
    await waitFor(() => expect(types()).toContain("control_upgrade"));
  });

  it("does not treat xterm protocol replies as real interaction on an unfocused page", async () => {
    vi.mocked(document.hasFocus).mockReturnValue(false);
    MockWebSocket.protocolVersion = 2;
    render(<TerminalPane pane={cliPane()} terminalFontSize={12} />);

    await waitFor(() => expect(MockWebSocket.instances[0]?.readyState).toBe(MockWebSocket.OPEN));
    await screen.findByLabelText("CLI pane Codex CLI");
    const socket = MockWebSocket.instances[0]!;
    expect(new URL(socket.url).searchParams.get("clientMode")).toBe("OBSERVER");

    act(() => {
      xtermMock.instances[0]?.emitData(
        "\u001b[?1;2c\u001b]11;rgb:0909/0b0b/0c0c\u001b\\"
      );
      socket.dispatchEvent(new MessageEvent("message", {
        data: JSON.stringify({ type: "control_upgraded" })
      }));
      socket.dispatchEvent(new MessageEvent("message", {
        data: JSON.stringify({
          type: "control_granted",
          leaseId: "cli_control_lease:after-protocol-reply",
          expiresAt: "2026-07-05T00:05:00.000Z"
        })
      }));
    });

    expect(socket.sent.some((frame) => {
      const type = (JSON.parse(frame) as { type?: string }).type;
      return type === "control_upgrade" || type === "control_request" || type === "control_takeover";
    })).toBe(false);
    expect(socket.sent.some((frame) => {
      const message = JSON.parse(frame) as { type?: string; data?: string };
      return message.type === "input" && message.data?.includes("rgb:0909/0b0b/0c0c");
    })).toBe(false);
    expect(screen.queryByText("Taking terminal control…")).toBeNull();
  });

  it("sends xterm protocol replies as hidden input through the active control lease", async () => {
    MockWebSocket.protocolVersion = 2;
    render(<TerminalPane pane={cliPane()} terminalFontSize={12} />);

    await waitFor(() => expect(MockWebSocket.instances[0]?.readyState).toBe(MockWebSocket.OPEN));
    await screen.findByLabelText("CLI pane Codex CLI");
    const socket = MockWebSocket.instances[0]!;
    const response = "\u001b[?1;2c\u001b]11;rgb:0909/0b0b/0c0c\u001b\\";

    act(() => xtermMock.instances[0]?.emitData(response));

    expect(socket.sent).toContain(JSON.stringify({
      type: "input",
      data: response,
      display: "hidden",
      leaseId: "cli_control_lease:test-1"
    }));
    expect(screen.queryByText("Taking terminal control…")).toBeNull();
  });

  it("upgrades a writable observer in place without another session GET", async () => {
    MockWebSocket.protocolVersion = 2;
    apiMock.activeCliSession.mockResolvedValueOnce(null);
    const view = render(
      <TerminalPane pane={cliPane()} terminalFontSize={12} isVisible={false} />
    );

    await waitFor(() => expect(MockWebSocket.instances[0]?.readyState).toBe(MockWebSocket.OPEN));
    const socket = MockWebSocket.instances[0]!;
    expect(new URL(socket.url).searchParams.get("clientMode")).toBe("OBSERVER");
    socket.onSend = (data) => {
      const message = JSON.parse(data) as { type?: string };
      if (message.type === "control_upgrade") {
        socket.dispatchEvent(new MessageEvent("message", {
          data: JSON.stringify({ type: "control_upgraded" })
        }));
      } else if (message.type === "control_request") {
        socket.dispatchEvent(new MessageEvent("message", {
          data: JSON.stringify({
            type: "control_granted",
            leaseId: "cli_control_lease:observer-upgrade",
            expiresAt: "2026-07-05T00:05:00.000Z"
          })
        }));
      }
    };

    // Loading the pane checks the active session once. Upgrading the existing
    // observer socket must not repeat that request.
    expect(apiMock.activeCliSession).toHaveBeenCalledTimes(1);
    view.rerender(withVoiceInput(<TerminalPane pane={cliPane()} terminalFontSize={12} isVisible />));

    await waitFor(() => expect(socket.sent).toContain(JSON.stringify({ type: "control_upgrade" })));
    await waitFor(() => expect(socket.sent).toContain(JSON.stringify({ type: "control_request" })));
    expect(apiMock.activeCliSession).toHaveBeenCalledTimes(1);
    expect(apiMock.createCliSession).toHaveBeenCalledTimes(1);
    expect(MockWebSocket.instances).toHaveLength(1);
  });

  it("fences protocol-v2 input, resize, and heartbeat frames with the granted lease", async () => {
    MockWebSocket.autoReady = false;
    MockWebSocket.protocolVersion = 2;
    render(<TerminalPane pane={cliPane()} terminalFontSize={12} />);

    await waitFor(() => expect(MockWebSocket.instances[0]?.readyState).toBe(MockWebSocket.OPEN));
    const socket = MockWebSocket.instances[0]!;
    vi.useFakeTimers();
    try {
      act(() => {
        socket.dispatchEvent(
          new MessageEvent("message", {
            data: JSON.stringify({
              type: "ready",
              paneId: "pane:cli-upload",
              sessionId: "cli_session:test-upload",
              runtimeId: "cli:codex",
              protocolVersion: 2,
              clientMode: "INTERACTIVE",
              controlState: "CONTROLLER",
              leaseId: "cli_control_lease:current-page",
              expiresAt: "2026-07-05T00:05:00.000Z",
              heartbeatIntervalMs: 1_000
            })
          })
        );
        socket.dispatchEvent(
          new MessageEvent("message", {
            data: JSON.stringify({
              type: "status",
              status: "RUNNING",
              statusReason: "Attached to CLI process.",
              replayContinuity: "COMPLETE"
            })
          })
        );
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(xtermMock.instances[0]?.element?.isConnected).toBe(true);
      act(() => {
        xtermMock.instances[0]?.emitData("lease-fenced-input");
        window.dispatchEvent(new Event("focus"));
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_000);
      });

      expect(socket.sent).toContain(JSON.stringify({
        type: "input",
        data: "lease-fenced-input",
        leaseId: "cli_control_lease:current-page"
      }));
      expect(socket.sent.some((frame) => {
        const message = JSON.parse(frame) as { type?: string; leaseId?: string };
        return message.type === "resize" && message.leaseId === "cli_control_lease:current-page";
      })).toBe(true);
      expect(socket.sent).toContain(JSON.stringify({
        type: "control_heartbeat",
        leaseId: "cli_control_lease:current-page"
      }));
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a revoked protocol-v2 socket live for output while blocking stale input", async () => {
    MockWebSocket.protocolVersion = 2;
    render(<TerminalPane pane={cliPane()} terminalFontSize={12} />);

    await waitFor(() => expect(MockWebSocket.instances[0]?.readyState).toBe(MockWebSocket.OPEN));
    const socket = MockWebSocket.instances[0]!;
    const inputCountBeforeRevocation = socket.sent.filter((frame) =>
      (JSON.parse(frame) as { type?: string }).type === "input"
    ).length;
    act(() => {
      socket.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({
            type: "control_revoked",
            leaseId: "cli_control_lease:test-1",
            reason: "TAKEN_OVER"
          })
        })
      );
      socket.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({
            type: "output",
            stream: "stdout",
            data: "observer-output-after-revocation"
          })
        })
      );
      xtermMock.instances[0]?.emitData("stale-input-after-revocation");
    });

    await waitFor(() =>
      expect(xtermMock.instances[0]?.writes.join("")).toContain("observer-output-after-revocation")
    );
    expect(socket.readyState).toBe(MockWebSocket.OPEN);
    expect(socket.sent.filter((frame) =>
      (JSON.parse(frame) as { type?: string }).type === "input"
    )).toHaveLength(inputCountBeforeRevocation);
    await waitFor(() =>
      expect(apiMock.reportCliClientEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          event: "CONTROL_REVOKED",
          outcome: "REVOKED",
          reason: "TAKEN_OVER",
          paneId: "pane:cli-upload",
          controlState: "HELD_BY_OTHER"
        })
      )
    );
  });

  // Main (3213ef2bae) shows the intervention alert for every lease denial; the
  // operator-approved replay (2f7bd5a910) still re-sends an input denied for the
  // exact lease it was sent with. Heartbeat/resize denials never replay (see the
  // heartbeat test below).
  it.each(["CLI_LEASE_STALE", "CLI_CONTROL_REQUIRED"])("shows intervention and replays a pasted key the API rejected with %s for its stale protocol-v2 lease", async (code) => {
    MockWebSocket.autoReady = false;
    MockWebSocket.protocolVersion = 2;
    render(<TerminalPane pane={cliPane()} terminalFontSize={12} />);

    await waitFor(() => expect(MockWebSocket.instances[0]?.readyState).toBe(MockWebSocket.OPEN));
    const socket = MockWebSocket.instances[0]!;
    act(() => {
      socket.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({
            type: "ready",
            paneId: "pane:cli-upload",
            sessionId: "cli_session:test-upload",
            runtimeId: "cli:codex",
            protocolVersion: 2,
            clientMode: "INTERACTIVE",
            controlState: "CONTROLLER",
            leaseId: "cli_control_lease:stale",
            expiresAt: "2026-07-05T00:05:00.000Z",
            heartbeatIntervalMs: 10_000
          })
        })
      );
      socket.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({
            type: "status",
            status: "RUNNING",
            statusReason: "Attached to CLI process.",
            replayContinuity: "COMPLETE"
          })
        })
      );
    });
    await waitFor(() => expect(xtermMock.instances[0]?.textarea).toBeTruthy());

    const inputFrames = () =>
      socket.sent
        .map((frame) => JSON.parse(frame) as { type?: string; data?: string; leaseId?: string })
        .filter((frame) => frame.type === "input");

    fireEvent.paste(xtermMock.instances[0]!.textarea!, {
      clipboardData: {
        files: [],
        items: [],
        types: ["text/plain"],
        getData: (type: string) => type === "text/plain" ? "synthetic-pasted-api-key" : ""
      }
    });
    await waitFor(() =>
      expect(inputFrames()).toEqual([
        { type: "input", data: "synthetic-pasted-api-key", leaseId: "cli_control_lease:stale" }
      ])
    );

    act(() => {
      socket.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({
            type: "control_denied",
            code,
            message: "CLI terminal control lease is stale."
          })
        })
      );
    });

    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByText("Terminal control changed. Check the prompt before sending again.")).toBeTruthy();
    // The denied paste must not vanish: the operator sees what happened and the
    // client asks for control again instead of dropping the input.
    expect(await screen.findByText("Terminal control lease expired. Re-sending your last input.")).toBeTruthy();
    await waitFor(() =>
      expect(socket.sent.map((frame) => JSON.parse(frame))).toContainEqual({ type: "control_request" })
    );
    expect(inputFrames()).toHaveLength(1);

    act(() => {
      socket.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({
            type: "control_granted",
            leaseId: "cli_control_lease:fresh",
            expiresAt: "2026-07-05T00:06:00.000Z"
          })
        })
      );
    });

    await waitFor(() =>
      expect(inputFrames()).toEqual([
        { type: "input", data: "synthetic-pasted-api-key", leaseId: "cli_control_lease:stale" },
        { type: "input", data: "synthetic-pasted-api-key", leaseId: "cli_control_lease:fresh" }
      ])
    );
    expect(screen.queryByText("Terminal control kept changing. Take the terminal again and retry this input.")).toBeNull();
    expect(MockWebSocket.instances).toEqual([socket]);
    expect(apiMock.createCliSession).toHaveBeenCalledOnce();
  });

  it("does not replay an accepted input when a later heartbeat is denied for a stale lease", async () => {
    MockWebSocket.autoReady = false;
    MockWebSocket.protocolVersion = 2;
    render(<TerminalPane pane={cliPane()} terminalFontSize={12} />);

    await waitFor(() => expect(MockWebSocket.instances[0]?.readyState).toBe(MockWebSocket.OPEN));
    const socket = MockWebSocket.instances[0]!;
    const frames = () => socket.sent.map((frame) => JSON.parse(frame) as { type?: string; data?: string; leaseId?: string });
    const inputFrames = () => frames().filter((frame) => frame.type === "input");
    const acceptedInput = { type: "input", data: "accepted-input", leaseId: "cli_control_lease:heartbeat" };
    vi.useFakeTimers();
    try {
      act(() => {
        socket.dispatchEvent(new MessageEvent("message", {
          data: JSON.stringify({
            type: "ready",
            paneId: "pane:cli-upload",
            sessionId: "cli_session:test-upload",
            runtimeId: "cli:codex",
            protocolVersion: 2,
            clientMode: "INTERACTIVE",
            controlState: "CONTROLLER",
            leaseId: "cli_control_lease:heartbeat",
            expiresAt: "2026-07-05T00:05:00.000Z",
            heartbeatIntervalMs: 1_000
          })
        }));
        socket.dispatchEvent(new MessageEvent("message", {
          data: JSON.stringify({
            type: "status",
            status: "RUNNING",
            statusReason: "Attached to CLI process.",
            replayContinuity: "COMPLETE"
          })
        }));
      });
      // Let attach-time geometry settle so no resize frame follows the input.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_500);
      });
      const framesBeforeInput = socket.sent.length;
      act(() => xtermMock.instances[0]?.emitData("accepted-input"));
      expect(inputFrames()).toEqual([acceptedInput]);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_000);
      });
      const framesSinceInput = frames().slice(framesBeforeInput);
      expect(framesSinceInput).toContainEqual({ type: "control_heartbeat", leaseId: "cli_control_lease:heartbeat" });
      expect(framesSinceInput.some((frame) => frame.type === "resize")).toBe(false);

      // The denial answers the heartbeat; the earlier input was accepted and must not be resent.
      act(() => {
        socket.dispatchEvent(new MessageEvent("message", {
          data: JSON.stringify({ type: "control_denied", code: "CLI_LEASE_STALE", message: "CLI terminal control lease is stale." })
        }));
        socket.dispatchEvent(new MessageEvent("message", {
          data: JSON.stringify({ type: "control_granted", leaseId: "cli_control_lease:fresh", expiresAt: "2026-07-05T00:06:00.000Z" })
        }));
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(inputFrames()).toEqual([acceptedInput]);
      expect(screen.queryByText("Terminal control lease expired. Re-sending your last input.")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("reconnects the same pane to the NORMAL session announced after LOGIN", async () => {
    const loginSession = cliSessionResponse("terminal-ws-ticket-login", "RUNNING", true, {
      sessionId: "cli_session:login",
      purpose: "LOGIN"
    });
    const normalSession = cliSessionResponse("terminal-ws-ticket-normal", "IDLE", true, {
      sessionId: "cli_session:normal"
    });
    apiMock.activeCliSession
      .mockResolvedValueOnce(loginSession)
      .mockResolvedValueOnce(normalSession);

    render(<TerminalPane pane={cliPane()} terminalFontSize={12} />);

    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
    await waitFor(() => expect(MockWebSocket.instances[0]?.readyState).toBe(MockWebSocket.OPEN));
    act(() => {
      MockWebSocket.instances[0]?.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({ type: "session_replaced", sessionId: "cli_session:normal" })
        })
      );
    });

    await waitFor(() => expect(apiMock.activeCliSession).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(2));
    expect(MockWebSocket.instances[1]?.url).toContain("sessionId=cli_session%3Anormal");
    expect(apiMock.invalidateCliRuntimes).toHaveBeenCalledTimes(1);
  });

  it("refuses to attach a replacement session that does not match the advertised session id", async () => {
    const loginSession = cliSessionResponse("terminal-ws-ticket-login-stale", "RUNNING", true, {
      sessionId: "cli_session:login-stale",
      purpose: "LOGIN"
    });
    const staleSession = cliSessionResponse("terminal-ws-ticket-stale", "RUNNING", true, {
      sessionId: "cli_session:unexpected"
    });
    apiMock.activeCliSession
      .mockResolvedValueOnce(loginSession)
      .mockResolvedValueOnce(staleSession);

    render(<TerminalPane pane={cliPane()} terminalFontSize={12} />);

    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
    await waitFor(() => expect(MockWebSocket.instances[0]?.readyState).toBe(MockWebSocket.OPEN));
    act(() => {
      MockWebSocket.instances[0]?.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({ type: "session_replaced", sessionId: "cli_session:expected" })
        })
      );
    });

    await waitFor(() => expect(apiMock.activeCliSession).toHaveBeenCalledTimes(2));
    expect(await screen.findByText("The verified CLI session could not be attached. Reconnect this pane.")).toBeTruthy();
    expect(MockWebSocket.instances).toHaveLength(1);
  });

  it("keeps LOGIN panes ephemeral and allows only text I/O, reconnect, and explicit cancellation", async () => {
    const loginSession = cliSessionResponse("terminal-ws-ticket-login-restricted", "RUNNING", true, {
      sessionId: "cli_session:login-restricted",
      purpose: "LOGIN"
    });
    apiMock.activeCliSession.mockResolvedValue(loginSession);
    apiMock.interruptCliSession.mockResolvedValue({
      ...loginSession,
      session: { ...loginSession.session, status: "EXITED", isActive: false }
    });

    render(<TerminalPane pane={cliPane()} terminalFontSize={12} />);

    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
    await waitFor(() => expect(MockWebSocket.instances[0]?.readyState).toBe(MockWebSocket.OPEN));
    await waitFor(() => expect(xtermMock.instances[0]?.textarea).toBeTruthy());
    fireEvent.paste(xtermMock.instances[0]!.textarea!, {
      clipboardData: {
        files: [],
        items: [],
        types: ["text/plain"],
        getData: (type: string) => type === "text/plain" ? "synthetic-authorization-code" : ""
      }
    });

    await waitFor(() => {
      const secretFrames = MockWebSocket.instances[0]?.sent
        .map((frame) => JSON.parse(frame) as { type?: string; data?: string; display?: string })
        .filter((frame) => frame.type === "input" && frame.data === "synthetic-authorization-code");
      expect(secretFrames).toEqual([{
        type: "input",
        data: "synthetic-authorization-code",
        display: "hidden"
      }]);
    });
    expect(apiMock.createClipboardItem).not.toHaveBeenCalled();
    expect(apiMock.uploadCliFiles).not.toHaveBeenCalled();
    expect(apiMock.reportCliClipboardDebug).not.toHaveBeenCalled();
    expect(apiMock.cliModelSettingsStatus).not.toHaveBeenCalled();

    act(() => {
      window.dispatchEvent(new CustomEvent("space:terminal-pane-action", {
        detail: { paneId: "pane:cli-upload", action: "cancel_login" }
      }));
    });
    await waitFor(() => expect(apiMock.interruptCliSession).toHaveBeenCalledWith(
      "pane:cli-upload",
      "CLI login cancelled by operator."
    ));
  });

  it("focuses a selected LOGIN terminal when its socket becomes ready", async () => {
    const launcher = document.createElement("button");
    launcher.textContent = "CLI launcher";
    document.body.appendChild(launcher);
    launcher.focus();
    const loginSession = cliSessionResponse("terminal-ws-ticket-login-focus", "RUNNING", true, {
      sessionId: "cli_session:login-focus",
      purpose: "LOGIN",
      runtimeId: "cli:gemini"
    });
    apiMock.activeCliSession.mockResolvedValue(loginSession);
    apiMock.cliTerminalWebSocketUrl.mockImplementation(
      (ticket: { paneId: string; sessionId: string }) =>
        `ws://space.test/terminal?paneId=${encodeURIComponent(ticket.paneId)}` +
        `&sessionId=${encodeURIComponent(ticket.sessionId)}&runtimeId=cli%3Agemini` +
        `&protocolVersion=2&clientMode=INTERACTIVE`
    );

    render(
      <VoiceInputProvider>
        <TerminalPane pane={cliPane({ terminalRuntimeId: "cli:gemini" })} terminalFontSize={12} isTarget />
      </VoiceInputProvider>
    );

    await waitFor(() => expect(MockWebSocket.instances[0]?.readyState).toBe(MockWebSocket.OPEN));
    await waitFor(() => expect(document.activeElement).toBe(xtermMock.instances[0]?.textarea));
    launcher.remove();
  });

  it("keeps a normal Gemini terminal free of Space authorization-code UI", async () => {
    apiMock.activeCliSession.mockResolvedValue(cliSessionResponse(
      "terminal-ws-ticket-gemini-native-auth",
      "RUNNING",
      true,
      { sessionId: "cli_session:gemini-native-auth", purpose: "NORMAL", runtimeId: "cli:gemini" }
    ));
    apiMock.cliTerminalWebSocketUrl.mockImplementation(
      (ticket: { paneId: string; sessionId: string }) =>
        `ws://space.test/terminal?paneId=${encodeURIComponent(ticket.paneId)}` +
        `&sessionId=${encodeURIComponent(ticket.sessionId)}&runtimeId=cli%3Agemini` +
        `&protocolVersion=2&clientMode=INTERACTIVE`
    );

    render(
      <VoiceInputProvider>
        <TerminalPane pane={cliPane({ terminalRuntimeId: "cli:gemini" })} terminalFontSize={12} isTarget />
      </VoiceInputProvider>
    );

    await waitFor(() => expect(MockWebSocket.instances[0]?.readyState).toBe(MockWebSocket.OPEN));
    expect(screen.queryByText("Paste authorization code")).toBeNull();
    expect(screen.queryByLabelText("Gemini authorization code")).toBeNull();
  });

  it("does not steal focus when a NORMAL terminal socket becomes ready", async () => {
    const launcher = document.createElement("button");
    launcher.textContent = "CLI launcher";
    document.body.appendChild(launcher);
    launcher.focus();
    apiMock.activeCliSession.mockResolvedValue(cliSessionResponse(
      "terminal-ws-ticket-normal-focus",
      "RUNNING",
      true,
      { sessionId: "cli_session:normal-focus" }
    ));

    render(
      <VoiceInputProvider>
        <TerminalPane pane={cliPane()} terminalFontSize={12} isTarget />
      </VoiceInputProvider>
    );

    await waitFor(() => expect(MockWebSocket.instances[0]?.readyState).toBe(MockWebSocket.OPEN));
    expect(document.activeElement).toBe(launcher);
    launcher.remove();
  });

  it("preconnects a running terminal before the runtime registry settles", async () => {
    const activeSession = cliSessionResponse("terminal-ws-ticket-before-runtime-registry", "RUNNING", true);
    const pendingRegistry = deferred<{
      data: [typeof activeSession.runtime];
      checkedAt: string;
    }>();
    apiMock.cliRuntimes.mockReturnValueOnce(pendingRegistry.promise);
    apiMock.activeCliSession.mockResolvedValueOnce(activeSession);

    render(<TerminalPane pane={cliPane()} terminalFontSize={12} />);

    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
    expect(xtermMock.instances).toHaveLength(0);

    pendingRegistry.resolve({ data: [activeSession.runtime], checkedAt: "2026-07-05T00:00:00.000Z" });
    await waitFor(() => expect(xtermMock.instances).toHaveLength(1));
  });

  it("closes an early terminal preconnection when the runtime registry fails", async () => {
    const activeSession = cliSessionResponse("terminal-ws-ticket-before-runtime-error", "RUNNING", true);
    const pendingRegistry = deferred<{
      data: [typeof activeSession.runtime];
      checkedAt: string;
    }>();
    apiMock.cliRuntimes.mockReturnValueOnce(pendingRegistry.promise);
    apiMock.activeCliSession.mockResolvedValueOnce(activeSession);

    render(<TerminalPane pane={cliPane()} terminalFontSize={12} />);

    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
    await act(async () => {
      pendingRegistry.reject(new Error("Runtime registry unavailable"));
      await pendingRegistry.promise.catch(() => undefined);
    });

    await waitFor(() => expect(MockWebSocket.instances[0]?.readyState).toBe(MockWebSocket.CLOSED));
    expect(await screen.findByText("Runtime registry unavailable")).toBeTruthy();
  });

  it("does not preconnect a delayed session after the runtime registry has already failed", async () => {
    const activeSession = cliSessionResponse("terminal-ws-ticket-after-runtime-error", "RUNNING", true);
    const pendingSession = deferred<typeof activeSession>();
    apiMock.cliRuntimes.mockRejectedValueOnce(new Error("Runtime registry unavailable first"));
    apiMock.activeCliSession.mockReturnValueOnce(pendingSession.promise);

    render(<TerminalPane pane={cliPane()} terminalFontSize={12} />);

    expect(await screen.findByText("Runtime registry unavailable first")).toBeTruthy();
    await act(async () => {
      pendingSession.resolve(activeSession);
      await pendingSession.promise;
      await Promise.resolve();
    });

    expect(MockWebSocket.instances).toHaveLength(0);
  });

  it("holds 16 sibling xterm setups until every terminal preconnect arrives", async () => {
    const panes = Array.from({ length: 16 }, (_, index) => ({
      ...cliPane(),
      id: `pane:cli-bootstrap-${index + 1}`,
      title: `Codex CLI ${index + 1}`,
      order: index
    }));
    const sessions = panes.map((pane, index) => {
      const session = cliSessionResponse(`terminal-ws-ticket-bootstrap-${index + 1}`, "RUNNING", true, {
        sessionId: `cli_session:test-bootstrap-${index + 1}`
      });
      session.session.paneId = pane.id;
      session.websocket.paneId = pane.id;
      return session;
    });
    const sessionGates = new Map(
      panes.map((pane) => [pane.id, deferred<(typeof sessions)[number]>()] as const)
    );
    const bootstrapBarrier = createTerminalBootstrapBarrier(panes.map((pane) => pane.id));

    apiMock.activeCliSession.mockImplementation((paneId: string) => sessionGates.get(paneId)!.promise);

    render(
      <>
        {panes.map((pane) => (
          <TerminalPane
            key={pane.id}
            pane={pane}
            terminalFontSize={12}
            bootstrapBarrier={bootstrapBarrier}
          />
        ))}
      </>
    );

    await waitFor(() => expect(apiMock.activeCliSession).toHaveBeenCalledTimes(16));
    await act(async () => {
      for (let index = 0; index < 15; index += 1) {
        sessionGates.get(panes[index]!.id)!.resolve(sessions[index]!);
      }
      await Promise.all(panes.slice(0, 15).map((pane) => sessionGates.get(pane.id)!.promise));
    });

    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(15));
    expect(xtermMock.instances).toHaveLength(0);

    await act(async () => {
      sessionGates.get(panes[15]!.id)!.resolve(sessions[15]!);
      await sessionGates.get(panes[15]!.id)!.promise;
    });

    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(16));
    await waitFor(() => expect(xtermMock.instances).toHaveLength(16));
    expect(terminalAttachConstructionOrder.slice(0, 16)).toEqual(Array(16).fill("websocket"));
  });

  it("starts an opened xterm without waiting for a slow sibling handshake", async () => {
    MockWebSocket.autoOpen = false;
    const panes = [
      { ...cliPane(), id: "pane:preopen-first", title: "Preopen first", order: 0 },
      { ...cliPane(), id: "pane:preopen-second", title: "Preopen second", order: 1 }
    ];
    const sessions = panes.map((pane, index) => {
      const session = cliSessionResponse(`terminal-ws-ticket-preopen-${index + 1}`, "RUNNING", true, {
        sessionId: `cli_session:test-preopen-${index + 1}`
      });
      session.session.paneId = pane.id;
      session.websocket.paneId = pane.id;
      return session;
    });
    const bootstrapBarrier = createTerminalBootstrapBarrier(panes.map((pane) => pane.id));

    apiMock.activeCliSession.mockImplementation((paneId: string) =>
      Promise.resolve(sessions.find((session) => session.session.paneId === paneId)!)
    );

    render(
      <>
        {panes.map((pane) => (
          <TerminalPane
            key={pane.id}
            pane={pane}
            terminalFontSize={12}
            bootstrapBarrier={bootstrapBarrier}
          />
        ))}
      </>
    );

    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(2));
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 20));
    });
    expect(xtermMock.instances).toHaveLength(0);

    act(() => MockWebSocket.instances[0]!.open());
    await waitFor(() => expect(xtermMock.instances).toHaveLength(1));

    act(() => MockWebSocket.instances[1]!.open());
    await waitFor(() => expect(xtermMock.instances).toHaveLength(2));
  });

  it("yields a browser task between sibling xterm setups", async () => {
    xtermMock.markConstructionTask = true;
    const panes = [
      { ...cliPane(), id: "pane:task-yield-first", title: "Task yield first", order: 0 },
      { ...cliPane(), id: "pane:task-yield-second", title: "Task yield second", order: 1 }
    ];
    const sessions = panes.map((pane, index) => {
      const session = cliSessionResponse(`terminal-ws-ticket-task-yield-${index + 1}`, "RUNNING", true, {
        sessionId: `cli_session:test-task-yield-${index + 1}`
      });
      session.session.paneId = pane.id;
      session.websocket.paneId = pane.id;
      return session;
    });
    const bootstrapBarrier = createTerminalBootstrapBarrier(panes.map((pane) => pane.id));

    apiMock.activeCliSession.mockImplementation((paneId: string) =>
      Promise.resolve(sessions.find((session) => session.session.paneId === paneId)!)
    );

    render(
      <>
        {panes.map((pane) => (
          <TerminalPane
            key={pane.id}
            pane={pane}
            terminalFontSize={12}
            bootstrapBarrier={bootstrapBarrier}
          />
        ))}
      </>
    );

    await waitFor(() => expect(xtermMock.instances).toHaveLength(2));
    await waitFor(() => expect(terminalAttachConstructionOrder.filter((entry) => entry === "task")).toHaveLength(2));
    expect(terminalAttachConstructionOrder.filter((entry) => entry !== "websocket").slice(0, 3)).toEqual([
      "terminal",
      "task",
      "terminal"
    ]);
  });

  it("honors configured pane priority when sibling setup waits arrive out of order", async () => {
    const bootstrapBarrier = createTerminalBootstrapBarrier(["pane:target", "pane:background"]);
    const targetParticipant = bootstrapBarrier.join("pane:target");
    const backgroundParticipant = bootstrapBarrier.join("pane:background");
    const setupOrder: string[] = [];

    const backgroundSetup = bootstrapBarrier.waitForTerminalSetupTask("pane:background").then(() => {
      setupOrder.push("pane:background");
    });
    const targetSetup = bootstrapBarrier.waitForTerminalSetupTask("pane:target").then(() => {
      setupOrder.push("pane:target");
    });

    await Promise.all([
      targetParticipant.arrive(),
      backgroundParticipant.arrive(),
      targetSetup,
      backgroundSetup
    ]);

    expect(setupOrder).toEqual(["pane:target", "pane:background"]);
  });

  it("ignores stale StrictMode barrier arrivals from the first effect generation", async () => {
    const panes = [
      { ...cliPane(), id: "pane:strict-bootstrap-first", title: "Strict first", order: 0 },
      { ...cliPane(), id: "pane:strict-bootstrap-second", title: "Strict second", order: 1 }
    ];
    const sessionGenerations = new Map(
      panes.map((pane) => [
        pane.id,
        [deferred<ReturnType<typeof cliSessionResponse>>(), deferred<ReturnType<typeof cliSessionResponse>>()]
      ] as const)
    );
    const callCounts = new Map<string, number>();
    const bootstrapBarrier = createTerminalBootstrapBarrier(panes.map((pane) => pane.id));

    apiMock.activeCliSession.mockImplementation((paneId: string) => {
      const callIndex = callCounts.get(paneId) ?? 0;
      callCounts.set(paneId, callIndex + 1);
      return sessionGenerations.get(paneId)![callIndex]!.promise;
    });

    renderBase(
      <StrictMode>
        <VoiceInputProvider>
          {panes.map((pane) => (
            <TerminalPane
              key={pane.id}
              pane={pane}
              terminalFontSize={12}
              bootstrapBarrier={bootstrapBarrier}
            />
          ))}
        </VoiceInputProvider>
      </StrictMode>
    );

    await waitFor(() => {
      expect(callCounts.get(panes[0]!.id)).toBe(2);
      expect(callCounts.get(panes[1]!.id)).toBe(2);
    });

    const firstCurrentSession = cliSessionResponse("terminal-ws-ticket-strict-first-current", "RUNNING", true, {
      sessionId: "cli_session:test-strict-first-current"
    });
    firstCurrentSession.session.paneId = panes[0]!.id;
    firstCurrentSession.websocket.paneId = panes[0]!.id;
    await act(async () => {
      sessionGenerations.get(panes[0]!.id)![1]!.resolve(firstCurrentSession);
      await sessionGenerations.get(panes[0]!.id)![1]!.promise;
    });

    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
    expect(xtermMock.instances).toHaveLength(0);

    await act(async () => {
      for (const pane of panes) {
        const staleSession = cliSessionResponse(`terminal-ws-ticket-stale-${pane.id}`, "RUNNING", true, {
          sessionId: `cli_session:stale-${pane.id}`
        });
        staleSession.session.paneId = pane.id;
        staleSession.websocket.paneId = pane.id;
        sessionGenerations.get(pane.id)![0]!.resolve(staleSession);
      }
      await Promise.all(panes.map((pane) => sessionGenerations.get(pane.id)![0]!.promise));
      await Promise.resolve();
    });

    expect(MockWebSocket.instances).toHaveLength(1);
    expect(xtermMock.instances).toHaveLength(0);

    const secondCurrentSession = cliSessionResponse("terminal-ws-ticket-strict-second-current", "RUNNING", true, {
      sessionId: "cli_session:test-strict-second-current"
    });
    secondCurrentSession.session.paneId = panes[1]!.id;
    secondCurrentSession.websocket.paneId = panes[1]!.id;
    await act(async () => {
      sessionGenerations.get(panes[1]!.id)![1]!.resolve(secondCurrentSession);
      await sessionGenerations.get(panes[1]!.id)![1]!.promise;
    });

    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(2));
    await waitFor(() => expect(xtermMock.instances).toHaveLength(2));
  });

  it("opens staggered sibling terminal websockets before constructing either xterm", async () => {
    const firstPane = cliPane();
    const secondPane = {
      ...cliPane(),
      id: "pane:cli-upload-sibling",
      title: "Codex CLI sibling",
      order: 1
    };
    const firstSession = cliSessionResponse("terminal-ws-ticket-first", "RUNNING", true, {
      sessionId: "cli_session:test-upload-first"
    });
    const secondSession = cliSessionResponse("terminal-ws-ticket-sibling", "RUNNING", true, {
      sessionId: "cli_session:test-upload-sibling"
    });
    secondSession.session.paneId = secondPane.id;
    secondSession.websocket.paneId = secondPane.id;
    const pendingSecondSession = deferred<typeof secondSession>();

    apiMock.activeCliSession.mockImplementation((paneId: string) =>
      paneId === secondPane.id ? pendingSecondSession.promise : Promise.resolve(firstSession)
    );
    let siblingCompletionScheduled = false;
    apiMock.cliTerminalWebSocketUrl.mockImplementation(
      (ticket: { paneId: string; sessionId: string }) => {
        if (!siblingCompletionScheduled && ticket.paneId === firstPane.id) {
          siblingCompletionScheduled = true;
          window.setTimeout(() => pendingSecondSession.resolve(secondSession), 0);
        }
        return (
          `ws://space.test/terminal?paneId=${encodeURIComponent(ticket.paneId)}` +
          `&sessionId=${encodeURIComponent(ticket.sessionId)}&runtimeId=cli%3Acodex`
        );
      }
    );

    render(
      <>
        <TerminalPane pane={firstPane} terminalFontSize={12} />
        <TerminalPane pane={secondPane} terminalFontSize={12} />
      </>
    );

    await waitFor(() => expect(terminalAttachConstructionOrder).toHaveLength(4));
    expect(terminalAttachConstructionOrder.slice(0, 2)).toEqual(["websocket", "websocket"]);
  });

  it("keeps newly allocated sibling terminal attaches staggered across xterm setup", async () => {
    const firstPane = cliPane();
    const secondPane = {
      ...cliPane(),
      id: "pane:cli-upload-new-sibling",
      title: "New Codex CLI sibling",
      order: 1
    };
    const firstSession = cliSessionResponse("terminal-ws-ticket-new-first", "IDLE", true, {
      sessionId: "cli_session:test-upload-new-first"
    });
    const secondSession = cliSessionResponse("terminal-ws-ticket-new-sibling", "IDLE", true, {
      sessionId: "cli_session:test-upload-new-sibling"
    });
    secondSession.session.paneId = secondPane.id;
    secondSession.websocket.paneId = secondPane.id;
    const pendingSecondSession = deferred<typeof secondSession>();

    apiMock.activeCliSession.mockImplementation((paneId: string) =>
      paneId === secondPane.id ? pendingSecondSession.promise : Promise.resolve(firstSession)
    );
    let siblingCompletionScheduled = false;
    apiMock.cliTerminalWebSocketUrl.mockImplementation(
      (ticket: { paneId: string; sessionId: string }) => {
        if (!siblingCompletionScheduled && ticket.paneId === firstPane.id) {
          siblingCompletionScheduled = true;
          window.setTimeout(() => pendingSecondSession.resolve(secondSession), 0);
        }
        return (
          `ws://space.test/terminal?paneId=${encodeURIComponent(ticket.paneId)}` +
          `&sessionId=${encodeURIComponent(ticket.sessionId)}&runtimeId=cli%3Acodex`
        );
      }
    );

    render(
      <>
        <TerminalPane pane={firstPane} terminalFontSize={12} />
        <TerminalPane pane={secondPane} terminalFontSize={12} />
      </>
    );

    await waitFor(() => expect(terminalAttachConstructionOrder).toHaveLength(4));
    expect(terminalAttachConstructionOrder).toEqual(["terminal", "websocket", "terminal", "websocket"]);
  });

  it("fits xterm for a newly allocated session before opening its websocket", async () => {
    apiMock.activeCliSession.mockResolvedValueOnce(
      cliSessionResponse("terminal-ws-ticket-new-idle", "IDLE", true)
    );
    let initialGeometry: { initialCols?: number; initialRows?: number } | null = null;
    apiMock.cliTerminalWebSocketUrl.mockImplementation(
      (
        ticket: { paneId: string; sessionId: string },
        options: { initialCols?: number; initialRows?: number } = {}
      ) => {
        initialGeometry = options;
        window.setTimeout(() => terminalAttachConstructionOrder.push("task"), 0);
        return (
          `ws://space.test/terminal?paneId=${encodeURIComponent(ticket.paneId)}` +
          `&sessionId=${encodeURIComponent(ticket.sessionId)}&runtimeId=cli%3Acodex`
        );
      }
    );

    render(<TerminalPane pane={cliPane()} terminalFontSize={12} />);

    await waitFor(() => expect(terminalAttachConstructionOrder).toHaveLength(3));
    expect(terminalAttachConstructionOrder).toEqual(["terminal", "websocket", "task"]);
    expect(initialGeometry).toMatchObject({ initialCols: 100, initialRows: 30 });
  });

  it("does not open an early terminal websocket after its pane unmounts", async () => {
    const pendingSession = deferred<ReturnType<typeof cliSessionResponse>>();
    apiMock.activeCliSession.mockReturnValueOnce(pendingSession.promise);
    const paneView = render(<TerminalPane pane={cliPane()} terminalFontSize={12} />);

    await waitFor(() => expect(apiMock.activeCliSession).toHaveBeenCalledTimes(1));
    paneView.unmount();
    await act(async () => {
      pendingSession.resolve(cliSessionResponse("terminal-ws-ticket-after-unmount", "RUNNING", true));
      await pendingSession.promise;
    });

    expect(MockWebSocket.instances).toHaveLength(0);
  });

  it("refreshes the model catalog on activation and selector opens while deduplicating in-flight refreshes", async () => {
    const firstCatalog = deferred<PaneCliModelSettings>();
    apiMock.cliModelSettings.mockReturnValueOnce(firstCatalog.promise);
    const firstRoom = render(<TerminalPane pane={cliPane()} terminalFontSize={12} />);

    await waitFor(() => expect(apiMock.cliModelSettings).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(MockWebSocket.instances[0]?.readyState).toBe(MockWebSocket.OPEN));
    expect(await screen.findByLabelText("Live CLI pane Codex CLI")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /change codex model and reasoning/i })).toBeNull();

    await act(async () => {
      firstCatalog.resolve(cliModelSettingsResponse());
      await firstCatalog.promise;
    });
    const selectorCatalog = deferred<PaneCliModelSettings>();
    apiMock.cliModelSettings.mockReturnValueOnce(selectorCatalog.promise);
    const trigger = await screen.findByRole("button", { name: /current GPT-5 Mini · medium/i }, { timeout: 3_000 });
    fireEvent.click(trigger);
    fireEvent.click(trigger);
    fireEvent.click(trigger);
    expect(screen.getByRole("dialog", { name: "Model and reasoning" })).toBeTruthy();
    // Since d65fc01b41 opening the picker refreshes the catalog once while a refresh is in flight.
    expect(apiMock.cliModelSettings).toHaveBeenCalledTimes(2);
    await act(async () => {
      selectorCatalog.resolve(cliModelSettingsResponse());
      await selectorCatalog.promise;
    });

    firstRoom.unmount();
    render(<TerminalPane pane={cliPane()} terminalFontSize={12} />);
    await waitFor(() => expect(apiMock.cliModelSettings).toHaveBeenCalledTimes(3));
  });

  it("applies a refreshed model catalog that changed without changing size", async () => {
    apiMock.cliModelSettings.mockResolvedValueOnce(cliModelSettingsResponse());
    render(<TerminalPane pane={cliPane()} terminalFontSize={12} />);
    const trigger = await screen.findByRole("button", { name: /current GPT-5 Mini · medium/i }, { timeout: 3_000 });

    apiMock.cliModelSettings.mockResolvedValueOnce(cliModelSettingsResponse({
      models: [{
        id: "gpt-5-mini",
        displayName: "GPT-5 Mini Fast",
        isDefault: true,
        defaultReasoningEffort: "medium",
        supportedReasoningEfforts: ["medium", "high"]
      }]
    }));
    fireEvent.click(trigger);
    expect(await screen.findByRole("button", { name: /current GPT-5 Mini Fast · medium/i }, { timeout: 3_000 })).toBeTruthy();
  });

  it("marks CLI attached while deferring model discovery until replay parsing finishes", async () => {
    MockWebSocket.autoRunningStatus = false;
    apiMock.activeCliSession.mockResolvedValueOnce(
      cliSessionResponse("terminal-ws-ticket-models-after-replay", "RUNNING", true)
    );

    render(<TerminalPane pane={cliPane()} terminalFontSize={12} />);

    await waitFor(() => expect(MockWebSocket.instances[0]?.readyState).toBe(MockWebSocket.OPEN));
    await waitFor(() => expect(xtermMock.instances).toHaveLength(1));
    const terminal = xtermMock.instances[0]!;
    const terminalPane = screen.getByLabelText("CLI pane Codex CLI");
    terminal.deferWrites = true;

    expect(terminalPane.getAttribute("data-terminal-status")).toBe("connecting");
    expect(apiMock.cliModelSettings).not.toHaveBeenCalled();

    act(() => {
      MockWebSocket.instances[0]?.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({ type: "output", stream: "stdout", data: "complete replay\n" })
        })
      );
      MockWebSocket.instances[0]?.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({
            type: "status",
            status: "RUNNING",
            statusReason: "Attached to CLI process.",
            replayContinuity: "COMPLETE"
          })
        })
      );
    });

    await waitFor(() => expect(terminal.pendingWrites).toHaveLength(1));
    expect(terminalPane.getAttribute("data-terminal-status")).toBe("attached");
    expect(apiMock.cliModelSettings).not.toHaveBeenCalled();

    act(() => terminal.completeNextWrite());

    await waitFor(() => expect(apiMock.cliModelSettings).toHaveBeenCalledTimes(1));
  });

  it("does not bootstrap a never-seen minimized terminal until it is restored", async () => {
    const minimizedPane = { ...cliPane(), isMinimized: true };
    const view = render(
      <TerminalPane pane={minimizedPane} terminalFontSize={12} isVisible={false} shouldBootstrap={false} />
    );

    await act(async () => Promise.resolve());
    expect(apiMock.cliRuntimes).not.toHaveBeenCalled();
    expect(apiMock.activeCliSession).not.toHaveBeenCalled();
    expect(apiMock.createCliSession).not.toHaveBeenCalled();
    expect(MockWebSocket.instances).toHaveLength(0);

    view.rerender(withVoiceInput(
      <TerminalPane pane={{ ...minimizedPane, isMinimized: false }} terminalFontSize={12} isVisible shouldBootstrap />
    ));
    await waitFor(() => expect(apiMock.activeCliSession).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));

    view.rerender(withVoiceInput(
      <TerminalPane pane={minimizedPane} terminalFontSize={12} isVisible={false} shouldBootstrap />
    ));
    expect(MockWebSocket.instances).toHaveLength(1);
  });

  it("parses a large initial replay in bounded writes without interleaving live output", async () => {
    MockWebSocket.autoRunningStatus = false;
    apiMock.activeCliSession.mockResolvedValueOnce(
      cliSessionResponse("terminal-ws-ticket-existing-active", "RUNNING", true)
    );
    render(<TerminalPane pane={cliPane()} terminalFontSize={12} />);

    await waitFor(() => expect(MockWebSocket.instances[0]?.readyState).toBe(MockWebSocket.OPEN));
    await waitFor(() => expect(MockWebSocket.instances[0]?.messageListenerRegistrations).toBeGreaterThanOrEqual(2));
    const terminalPane = screen.getByLabelText("CLI pane Codex CLI");
    const terminal = xtermMock.instances[0]!;
    const writesBeforeReplay = terminal.writes.length;
    const replayFrame = "replay-data-".repeat(1_000);
    const replay = replayFrame.repeat(10);
    const liveTail = "live output after replay boundary\n";
    terminal.deferWrites = true;

    act(() => {
      for (let frame = 0; frame < 10; frame += 1) {
        MockWebSocket.instances[0]?.dispatchEvent(
          new MessageEvent("message", {
            data: JSON.stringify({ type: "output", stream: "stdout", data: replayFrame })
          })
        );
      }
      MockWebSocket.instances[0]?.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({
            type: "status",
            status: "RUNNING",
            statusReason: "Still attached to CLI process.",
            replayContinuity: "COMPLETE"
          })
        })
      );
    });

    await waitFor(() => expect(terminal.pendingWrites).toHaveLength(1));
    expect(terminal.pendingWrites[0]!.data.length).toBeLessThanOrEqual(256 * 1024);
    expect(terminalPane.getAttribute("data-terminal-status")).toBe("attached");

    act(() => {
      MockWebSocket.instances[0]?.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({ type: "output", stream: "stdout", data: liveTail })
        })
      );
    });
    expect(terminal.pendingWrites).toHaveLength(1);

    const expectedReplayOutput = `${replay}${liveTail}`;
    for (let writeCount = 0; writeCount < 20; writeCount += 1) {
      if (terminal.writes.slice(writesBeforeReplay).join("") === expectedReplayOutput) break;
      if (terminal.pendingWrites.length > 0) {
        expect(terminal.pendingWrites).toHaveLength(1);
        act(() => terminal.completeNextWrite());
      }
      await act(async () => new Promise((resolve) => window.setTimeout(resolve, 0)));
    }

    expect(terminalPane.getAttribute("data-terminal-status")).toBe("attached");
    const replayWrites = terminal.writes.slice(writesBeforeReplay);
    expect(replayWrites.join("")).toBe(expectedReplayOutput);
    expect(replayWrites.every((write) => write.length <= 256 * 1024)).toBe(true);
  });

  it("opens a preparing pane surface before draining its buffered initial replay", async () => {
    MockWebSocket.autoRunningStatus = false;
    apiMock.activeCliSession.mockResolvedValueOnce(
      cliSessionResponse("terminal-ws-ticket-buffer-visible-replay", "RUNNING", true)
    );
    render(<TerminalPane pane={cliPane()} terminalFontSize={12} />);

    await waitFor(() => expect(MockWebSocket.instances[0]?.readyState).toBe(MockWebSocket.OPEN));
    const socket = MockWebSocket.instances[0]!;
    const terminal = xtermMock.instances[0]!;
    act(() => {
      socket.dispatchEvent(new MessageEvent("message", {
        data: JSON.stringify({ type: "output", stream: "stdout", data: "initial preparing replay\n" })
      }));
    });
    await act(async () => Promise.resolve());

    expect(terminal.writes).toEqual([]);
    expect(terminal.element).toBeUndefined();

    act(() => {
      socket.dispatchEvent(new MessageEvent("message", {
        data: JSON.stringify({
          type: "status",
          status: "RUNNING",
          statusReason: "Attached to CLI process.",
          replayContinuity: "COMPLETE"
        })
      }));
    });

    await waitFor(() => expect(terminal.writes).toEqual(["initial preparing replay\n"]));
    await waitFor(() => expect(terminal.element?.isConnected).toBe(true));
    expect(terminal.writeBeforeOpenCount).toBe(0);
  });

  it("tails parsed initial replay after geometry fit so a refreshed prompt is visible", async () => {
    MockWebSocket.autoRunningStatus = false;
    apiMock.activeCliSession.mockResolvedValueOnce(
      cliSessionResponse("terminal-ws-ticket-tail-after-refresh", "RUNNING", true)
    );
    render(<TerminalPane pane={cliPane()} terminalFontSize={12} />);

    await waitFor(() => expect(MockWebSocket.instances[0]?.readyState).toBe(MockWebSocket.OPEN));
    const socket = MockWebSocket.instances[0]!;
    const terminal = xtermMock.instances[0]!;
    terminal.baseY = 40;
    terminal.viewportY = 3;

    act(() => {
      socket.dispatchEvent(new MessageEvent("message", {
        data: JSON.stringify({ type: "output", stream: "stdout", data: "replayed prompt\n" })
      }));
      socket.dispatchEvent(new MessageEvent("message", {
        data: JSON.stringify({
          type: "status",
          status: "RUNNING",
          statusReason: "Attached to CLI process.",
          replayContinuity: "COMPLETE"
        })
      }));
    });

    await waitFor(() => expect(terminal.writes).toContain("replayed prompt\n"));
    await waitFor(() => expect(fitAddonMock.instances[0]?.fitCalls).toBeGreaterThan(0));
    await waitFor(() => expect(terminal.viewportY).toBe(terminal.baseY));
    expect(terminal.scrollToBottomCalls).toBeGreaterThan(0);
  });

  it("preserves manual scroll-up on passive output but returns to the prompt for focus and input", async () => {
    render(<TerminalPane pane={cliPane()} terminalFontSize={12} />);

    await waitFor(() => expect(MockWebSocket.instances[0]?.readyState).toBe(MockWebSocket.OPEN));
    await waitFor(() => expect(fitAddonMock.instances[0]?.fitCalls).toBeGreaterThan(0));
    const host = await screen.findByLabelText("Live CLI pane Codex CLI");
    // The pre-attach fit runs before the geometry coordinator's first ready pass,
    // which tails and focuses the freshly attached CLI and then re-checks the tail
    // one frame later. Let that initial attach settle before the user scrolls up.
    await waitFor(() => expect(host.dataset.terminalGeometryRepaired).toBeDefined());
    await act(async () => new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve())));
    const socket = MockWebSocket.instances[0]!;
    const terminal = xtermMock.instances[0]!;
    terminal.baseY = 30;
    terminal.viewportY = 29;
    const baselineTailCalls = terminal.scrollToBottomCalls;

    act(() => {
      socket.dispatchEvent(new MessageEvent("message", {
        data: JSON.stringify({ type: "output", stream: "stdout", data: "passive output\n" })
      }));
      terminal.emitWriteParsed();
    });
    await act(async () => new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve())));

    expect(terminal.viewportY).toBe(29);
    expect(terminal.scrollToBottomCalls).toBe(baselineTailCalls);

    act(() => {
      window.dispatchEvent(new CustomEvent("space:terminal-pane-action", {
        detail: { paneId: "pane:cli-upload", action: "focus" }
      }));
    });
    expect(terminal.viewportY).toBe(terminal.baseY);

    terminal.viewportY = 7;
    act(() => terminal.emitData("x"));
    expect(terminal.viewportY).toBe(terminal.baseY);
    expect(socket.sent.some((frame) => {
      const message = JSON.parse(frame) as { type?: string; data?: string };
      return message.type === "input" && message.data === "x";
    })).toBe(true);
  });

  it("publishes sanitized tail and cursor evidence and refreshes it after terminal input", async () => {
    render(<TerminalPane pane={cliPane()} terminalFontSize={12} />);

    await waitFor(() => expect(MockWebSocket.instances[0]?.readyState).toBe(MockWebSocket.OPEN));
    const terminal = xtermMock.instances[0]!;
    const host = await screen.findByLabelText("Live CLI pane Codex CLI");
    terminal.baseY = 40;
    terminal.viewportY = 4;
    terminal.cursorY = 3;

    act(() => terminal.emitWriteParsed());

    expect(host.dataset.terminalViewportY).toBe("4");
    expect(host.dataset.terminalBaseY).toBe("40");
    expect(host.dataset.terminalCursorY).toBe("3");
    expect(host.dataset.terminalCursorAbsoluteY).toBe("43");
    expect(host.dataset.terminalAtBottom).toBe("false");
    expect(host.dataset.terminalCursorInViewport).toBe("false");
    expect(host.dataset.terminalOutputParsed).toBe("true");

    act(() => terminal.emitData("x"));

    expect(host.dataset.terminalViewportY).toBe("40");
    expect(host.dataset.terminalBaseY).toBe("40");
    expect(host.dataset.terminalCursorAbsoluteY).toBe("43");
    expect(host.dataset.terminalAtBottom).toBe("true");
    expect(host.dataset.terminalCursorInViewport).toBe("true");
  });

  it("retains tail state across refits only when the terminal was already at the bottom", async () => {
    render(<TerminalPane pane={cliPane()} terminalFontSize={12} />);

    await waitFor(() => expect(MockWebSocket.instances[0]?.readyState).toBe(MockWebSocket.OPEN));
    await waitFor(() => expect(fitAddonMock.instances[0]?.fitCalls).toBeGreaterThan(0));
    const terminal = xtermMock.instances[0]!;
    const fitAddon = fitAddonMock.instances[0]!;
    terminal.baseY = 25;
    terminal.viewportY = 25;
    const initialTailCalls = terminal.scrollToBottomCalls;
    const initialFitCalls = fitAddon.fitCalls;

    act(() => window.dispatchEvent(new Event("resize")));
    await waitFor(() => expect(fitAddon.fitCalls).toBeGreaterThan(initialFitCalls));
    expect(terminal.scrollToBottomCalls).toBeGreaterThan(initialTailCalls);
    expect(terminal.viewportY).toBe(terminal.baseY);

    terminal.viewportY = 4;
    const scrolledUpTailCalls = terminal.scrollToBottomCalls;
    const scrolledUpFitCalls = fitAddon.fitCalls;
    act(() => window.dispatchEvent(new Event("resize")));
    await waitFor(() => expect(fitAddon.fitCalls).toBeGreaterThan(scrolledUpFitCalls));
    expect(terminal.scrollToBottomCalls).toBe(scrolledUpTailCalls);
    expect(terminal.viewportY).toBe(4);
  });

  it("restores the warm terminal tail without measuring the legacy DOM viewport", async () => {
    const pane = cliPane();
    const view = render(<TerminalPane pane={pane} terminalFontSize={12} />);
    await waitFor(() => expect(MockWebSocket.instances[0]?.readyState).toBe(MockWebSocket.OPEN));
    await waitFor(() => expect(fitAddonMock.instances[0]?.fitCalls).toBeGreaterThan(0));
    const terminal = xtermMock.instances[0]!;
    const viewport = document.createElement("div");
    viewport.className = "xterm-viewport";
    const readLegacyHeight = vi.fn(() => 400);
    Object.defineProperty(viewport, "scrollHeight", { get: readLegacyHeight });
    terminal.element!.appendChild(viewport);
    terminal.baseY = 25;
    terminal.viewportY = 25;
    view.rerender(withVoiceInput(<TerminalPane pane={pane} terminalFontSize={12} isVisible={false} />));
    const tailCalls = terminal.scrollToBottomCalls;
    view.rerender(withVoiceInput(<TerminalPane pane={pane} terminalFontSize={12} isVisible />));
    await waitFor(() => expect(terminal.scrollToBottomCalls).toBeGreaterThan(tailCalls));
    expect(terminal.viewportY).toBe(25);
    expect(readLegacyHeight).not.toHaveBeenCalled();
    expect(MockWebSocket.instances).toHaveLength(1);
  });

  it("uses observed host dimensions without a synchronous layout read and still refits", async () => {
    const observers: { callback: ResizeObserverCallback; targets: Set<Element> }[] = [];
    vi.stubGlobal("ResizeObserver", class {
      targets = new Set<Element>();
      constructor(public callback: ResizeObserverCallback) { observers.push(this); }
      observe(target: Element) { this.targets.add(target); }
      disconnect() { this.targets.clear(); }
    });
    const view = render(<TerminalPane pane={cliPane()} terminalFontSize={12} />);
    await waitFor(() => expect(fitAddonMock.instances[0]?.fitCalls).toBeGreaterThan(0));
    const host = view.container.querySelector<HTMLElement>(".terminal-xterm")!;
    const observer = observers.find(observer => observer.targets.has(host));
    expect(observer).toBeTruthy();
    const readWidth = vi.fn(() => 640);
    const readHeight = vi.fn(() => 480);
    Object.defineProperty(host, "clientWidth", { configurable: true, get: readWidth });
    Object.defineProperty(host, "clientHeight", { configurable: true, get: readHeight });
    const fitCalls = fitAddonMock.instances[0]!.fitCalls;
    act(() => observer!.callback([
      { target: document.body, contentRect: { width: 1, height: 1 } },
      { target: host, contentRect: { width: 640.2, height: 480.2 } }
    ] as unknown as ResizeObserverEntry[], observer as unknown as ResizeObserver));
    // The observer schedules a refit; only the frame may read final geometry.
    expect(readWidth).not.toHaveBeenCalled();
    expect(readHeight).not.toHaveBeenCalled();
    await waitFor(() => expect(fitAddonMock.instances[0]!.fitCalls).toBeGreaterThan(fitCalls));
    expect(MockWebSocket.instances).toHaveLength(1);
  });

  it("keeps terminal tailed when new streaming chunks arrive while at the bottom in small heights", async () => {
    render(<TerminalPane pane={cliPane()} terminalFontSize={12} />);

    await waitFor(() => expect(MockWebSocket.instances[0]?.readyState).toBe(MockWebSocket.OPEN));
    const socket = MockWebSocket.instances[0]!;
    const terminal = xtermMock.instances[0]!;
    terminal.baseY = 15;
    terminal.viewportY = 15;
    const initialTailCalls = terminal.scrollToBottomCalls;

    act(() => {
      socket.dispatchEvent(new MessageEvent("message", {
        data: JSON.stringify({ type: "output", stream: "stdout", data: "stream line 1\nstream line 2\n" })
      }));
      terminal.emitWriteParsed();
    });

    await waitFor(() => expect(terminal.scrollToBottomCalls).toBeGreaterThan(initialTailCalls));
    expect(terminal.viewportY).toBe(terminal.baseY);
  });

  it("commits usable attachment before deferred terminal geometry stabilization", async () => {
    MockWebSocket.autoRunningStatus = false;
    apiMock.activeCliSession.mockResolvedValueOnce(
      cliSessionResponse("terminal-ws-ticket-deferred-attach-geometry", "RUNNING", true)
    );
    render(<TerminalPane pane={cliPane()} terminalFontSize={12} />);

    await waitFor(() => expect(MockWebSocket.instances[0]?.readyState).toBe(MockWebSocket.OPEN));
    const terminalPane = screen.getByLabelText("CLI pane Codex CLI");
    const terminal = xtermMock.instances[0]!;
    const socket = MockWebSocket.instances[0]!;
    terminal.deferWrites = true;

    act(() => {
      MockWebSocket.instances[0]?.dispatchEvent(
        new MessageEvent("message", { data: JSON.stringify({ type: "output", stream: "stdout", data: "complete replay\n" }) })
      );
      MockWebSocket.instances[0]?.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({
            type: "status",
            status: "RUNNING",
            statusReason: "Attached to CLI process.",
            replayContinuity: "COMPLETE"
          })
        })
      );
    });

    await waitFor(() => expect(terminal.pendingWrites).toHaveLength(1));
    const fitCallsBeforeReplayCompletion = fitAddonMock.instances[0]!.fitCalls;
    await act(async () => terminal.completeNextWrite());

    await waitFor(() => expect(terminal.element?.isConnected).toBe(true));
    expect(terminalPane.getAttribute("data-terminal-status")).toBe("attached");
    act(() => terminal.emitData("input before deferred refit"));
    expect(socket.sent).toContain(JSON.stringify({ type: "input", data: "input before deferred refit" }));
    await waitFor(() => expect(fitAddonMock.instances[0]!.fitCalls).toBeGreaterThan(fitCallsBeforeReplayCompletion));
    await waitFor(() => expect(socket.sent.some((frame) => frame.includes('"type":"resize"'))).toBe(true));
  });

  it("repairs broken wide-host geometry on first running attach without a font-size change", async () => {
    MockWebSocket.autoRunningStatus = false;
    apiMock.activeCliSession.mockResolvedValueOnce(
      cliSessionResponse("terminal-ws-ticket-initial-attach-geometry", "RUNNING", true)
    );
    render(<TerminalPane pane={cliPane()} terminalFontSize={12} />);

    await waitFor(() => expect(MockWebSocket.instances[0]?.readyState).toBe(MockWebSocket.OPEN));
    const xtermHost = await screen.findByLabelText("Live CLI pane Codex CLI");
    Object.defineProperty(xtermHost, "clientWidth", { configurable: true, value: 640 });
    const terminal = xtermMock.instances[0]!;
    terminal.cols = 4;
    const baselineFitCalls = fitAddonMock.instances[0]!.fitCalls;

    act(() => {
      MockWebSocket.instances[0]?.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({
            type: "status",
            status: "RUNNING",
            statusReason: "Attached to CLI process.",
            replayContinuity: "COMPLETE"
          })
        })
      );
    });

    await waitFor(() => expect(fitAddonMock.instances[0]!.fitCalls).toBeGreaterThan(baselineFitCalls));
    const immediateFitCalls = fitAddonMock.instances[0]!.fitCalls;
    await act(async () => new Promise((resolve) => window.setTimeout(resolve, 80)));
    expect(fitAddonMock.instances[0]!.fitCalls).toBeGreaterThan(immediateFitCalls);
    expect(terminal.options.fontSize).toBe(12);
  });

  it("parses buffered replay before surfacing an attach error received before status", async () => {
    MockWebSocket.autoRunningStatus = false;
    apiMock.activeCliSession.mockResolvedValueOnce(
      cliSessionResponse("terminal-ws-ticket-existing-active", "RUNNING", true)
    );
    render(<TerminalPane pane={cliPane()} terminalFontSize={12} />);

    await waitFor(() => expect(MockWebSocket.instances[0]?.readyState).toBe(MockWebSocket.OPEN));
    const terminalPane = screen.getByLabelText("CLI pane Codex CLI");
    const terminal = xtermMock.instances[0]!;
    const writesBeforeReplay = terminal.writes.length;
    terminal.deferWrites = true;

    act(() => {
      MockWebSocket.instances[0]?.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({ type: "output", stream: "stdout", data: "persisted before failure\n" })
        })
      );
      MockWebSocket.instances[0]?.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({ type: "error", code: "CLI_TERMINAL_ATTACH_FAILED", message: "Attach failed." })
        })
      );
    });

    await waitFor(() => expect(terminal.pendingWrites[0]?.data).toBe("persisted before failure\n"));
    expect(terminalPane.getAttribute("data-terminal-status")).toBe("connecting");
    await act(async () => terminal.completeNextWrite());
    await waitFor(() => expect(terminal.pendingWrites[0]?.data).toBe("\r\nAttach failed.\n"));
    await act(async () => terminal.completeNextWrite());
    await waitFor(() =>
      expect(terminal.writes.slice(writesBeforeReplay)).toEqual(["persisted before failure\n", "\r\nAttach failed.\n"])
    );
    await waitFor(() => expect(terminalPane.getAttribute("data-terminal-status")).toBe("closed"));
  });

  it("coalesces terminal replay output with the room-activation model catalog refresh", async () => {
    MockWebSocket.autoRunningStatus = false;
    apiMock.activeCliSession.mockResolvedValueOnce(
      cliSessionResponse("terminal-ws-ticket-existing-active", "IDLE", true)
    );
    apiMock.cliModelSettings.mockResolvedValueOnce(cliModelSettingsResponse());
    render(<TerminalPane pane={cliPane()} terminalFontSize={12} />);

    await waitFor(() => expect(MockWebSocket.instances[0]?.readyState).toBe(MockWebSocket.OPEN));
    expect(apiMock.cliModelSettings).not.toHaveBeenCalled();

    vi.useFakeTimers();
    await act(async () => {
      MockWebSocket.instances[0]?.dispatchEvent(
        new MessageEvent("message", { data: JSON.stringify({ type: "output", stream: "stdout", data: "replayed prompt\n" }) })
      );
      MockWebSocket.instances[0]?.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({
            type: "status",
            status: "RUNNING",
            statusReason: "Attached to CLI process.",
            replayContinuity: "COMPLETE"
          })
        })
      );
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(apiMock.cliModelSettings).toHaveBeenCalledTimes(1));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });

    expect(apiMock.cliModelSettings).toHaveBeenCalledTimes(1);
  });

  it("does not refresh the model catalog when submitted Enter produces no output", async () => {
    apiMock.cliModelSettings.mockResolvedValue(cliModelSettingsResponse());
    render(<TerminalPane pane={cliPane()} terminalFontSize={12} />);

    await waitFor(() => expect(apiMock.cliModelSettings).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(MockWebSocket.instances[0]?.readyState).toBe(MockWebSocket.OPEN));
    expect(await screen.findByRole("button", { name: /current GPT-5 Mini · medium/i })).toBeTruthy();

    vi.useFakeTimers();
    const socket = MockWebSocket.instances[0]!;
    act(() => {
      xtermMock.instances[0]?.emitData("\r");
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(800);
    });

    expect(apiMock.cliModelSettings).toHaveBeenCalledTimes(1);
    expect(socket.sent.map((frame) => JSON.parse(frame))).toContainEqual({
      type: "input",
      data: "\r",
      turnMarker: expect.any(String)
    });
  });

  it("keeps a submitted refresh armed through resize and focus repaint output", async () => {
    apiMock.cliModelSettings.mockResolvedValue(cliModelSettingsResponse());
    render(<TerminalPane pane={cliPane()} terminalFontSize={12} />);

    await waitFor(() => expect(apiMock.cliModelSettings).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(MockWebSocket.instances[0]?.readyState).toBe(MockWebSocket.OPEN));
    expect(await screen.findByRole("button", { name: /current GPT-5 Mini · medium/i })).toBeTruthy();

    const socket = MockWebSocket.instances[0]!;
    const terminal = xtermMock.instances[0]!;
    act(() => {
      socket.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({ type: "output", stream: "stdout", data: "stable Codex prompt" })
        })
      );
    });

    vi.useFakeTimers();
    act(() => {
      terminal.emitData("\r");
    });
    const resizeFramesBeforeFocus = socket.sent.filter((frame) => frame.includes('"type":"resize"')).length;

    act(() => {
      window.dispatchEvent(new FocusEvent("focus"));
      terminal.emitData("\u001b[I");
      socket.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({
            type: "output",
            stream: "stdout",
            data: "\u001b[H\u001b[2Jstable Codex prompt\u001b[?25h"
          })
        })
      );
    });
    expect(socket.sent.filter((frame) => frame.includes('"type":"resize"'))).toHaveLength(resizeFramesBeforeFocus);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(800);
    });
    expect(apiMock.cliModelSettings).toHaveBeenCalledTimes(1);

    act(() => {
      socket.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({ type: "output", stream: "stdout", data: "\nreal command output" })
        })
      );
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(399);
    });
    expect(apiMock.cliModelSettings).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(apiMock.cliModelSettings).toHaveBeenCalledTimes(2);
  });

  it("starts the model catalog debounce on delayed output instead of Enter", async () => {
    apiMock.cliModelSettings.mockResolvedValue(cliModelSettingsResponse());
    render(<TerminalPane pane={cliPane()} terminalFontSize={12} />);

    await waitFor(() => expect(apiMock.cliModelSettings).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(MockWebSocket.instances[0]?.readyState).toBe(MockWebSocket.OPEN));
    expect(await screen.findByRole("button", { name: /current GPT-5 Mini · medium/i })).toBeTruthy();

    vi.useFakeTimers();
    const socket = MockWebSocket.instances[0]!;
    const terminal = xtermMock.instances[0]!;
    act(() => {
      terminal.emitData("\r");
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
    });
    expect(apiMock.cliModelSettings).toHaveBeenCalledTimes(1);

    act(() => {
      socket.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({ type: "output", stream: "stdout", data: "submitted command output\n" })
        })
      );
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(399);
    });
    expect(apiMock.cliModelSettings).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(apiMock.cliModelSettings).toHaveBeenCalledTimes(2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(800);
    });
    expect(apiMock.cliModelSettings).toHaveBeenCalledTimes(2);
  });

  it("coalesces a burst of submitted terminal output into one model catalog refresh", async () => {
    apiMock.cliModelSettings.mockResolvedValue(cliModelSettingsResponse());
    render(<TerminalPane pane={cliPane()} terminalFontSize={12} />);

    await waitFor(() => expect(apiMock.cliModelSettings).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(MockWebSocket.instances[0]?.readyState).toBe(MockWebSocket.OPEN));
    expect(await screen.findByRole("button", { name: /current GPT-5 Mini · medium/i })).toBeTruthy();

    vi.useFakeTimers();
    const socket = MockWebSocket.instances[0]!;
    const terminal = xtermMock.instances[0]!;
    act(() => {
      terminal.emitData("\r");
      socket.dispatchEvent(
        new MessageEvent("message", { data: JSON.stringify({ type: "output", stream: "stdout", data: "chunk one" }) })
      );
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    act(() => {
      socket.dispatchEvent(
        new MessageEvent("message", { data: JSON.stringify({ type: "output", stream: "stdout", data: " chunk two" }) })
      );
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    expect(apiMock.cliModelSettings).toHaveBeenCalledTimes(1);
    act(() => {
      socket.dispatchEvent(
        new MessageEvent("message", { data: JSON.stringify({ type: "output", stream: "stdout", data: " chunk three" }) })
      );
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(399);
    });
    expect(apiMock.cliModelSettings).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(apiMock.cliModelSettings).toHaveBeenCalledTimes(2);
  });

  it("cancels the submitted output debounce when the semantic screen returns to its baseline", async () => {
    apiMock.cliModelSettings.mockResolvedValue(cliModelSettingsResponse());
    render(<TerminalPane pane={cliPane()} terminalFontSize={12} />);

    await waitFor(() => expect(apiMock.cliModelSettings).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(MockWebSocket.instances[0]?.readyState).toBe(MockWebSocket.OPEN));
    expect(await screen.findByRole("button", { name: /current GPT-5 Mini · medium/i })).toBeTruthy();

    const socket = MockWebSocket.instances[0]!;
    const terminal = xtermMock.instances[0]!;
    act(() => {
      socket.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({ type: "output", stream: "stdout", data: "stable Codex prompt" })
        })
      );
    });

    vi.useFakeTimers();
    act(() => {
      terminal.emitData("\r");
      socket.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({ type: "output", stream: "stdout", data: "temporary screen delta" })
        })
      );
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    act(() => {
      socket.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({
            type: "output",
            stream: "stdout",
            data: "\u001b[H\u001b[2Jstable Codex prompt\u001b[?25h"
          })
        })
      );
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(800);
    });
    expect(apiMock.cliModelSettings).toHaveBeenCalledTimes(1);
  });

  it("cancels the old debounce as soon as restoration output arrives before that output is parsed", async () => {
    apiMock.cliModelSettings.mockResolvedValue(cliModelSettingsResponse());
    render(<TerminalPane pane={cliPane()} terminalFontSize={12} />);

    await waitFor(() => expect(apiMock.cliModelSettings).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(MockWebSocket.instances[0]?.readyState).toBe(MockWebSocket.OPEN));
    expect(await screen.findByRole("button", { name: /current GPT-5 Mini · medium/i })).toBeTruthy();

    const socket = MockWebSocket.instances[0]!;
    const terminal = xtermMock.instances[0]!;
    act(() => {
      socket.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({ type: "output", stream: "stdout", data: "stable Codex prompt" })
        })
      );
    });

    vi.useFakeTimers();
    act(() => {
      terminal.emitData("\r");
      socket.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({ type: "output", stream: "stdout", data: "temporary screen delta" })
        })
      );
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(399);
    });

    terminal.deferWrites = true;
    act(() => {
      socket.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({
            type: "output",
            stream: "stdout",
            data: "\u001b[H\u001b[2Jstable Codex prompt\u001b[?25h"
          })
        })
      );
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2);
    });
    expect(apiMock.cliModelSettings).toHaveBeenCalledTimes(1);

    act(() => terminal.completeNextWrite());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(800);
    });
    expect(apiMock.cliModelSettings).toHaveBeenCalledTimes(1);
  });

  it("waits for the callback of the relevant terminal write instead of an unrelated parsed event", async () => {
    apiMock.cliModelSettings.mockResolvedValue(cliModelSettingsResponse());
    render(<TerminalPane pane={cliPane()} terminalFontSize={12} />);

    await waitFor(() => expect(apiMock.cliModelSettings).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(MockWebSocket.instances[0]?.readyState).toBe(MockWebSocket.OPEN));
    expect(await screen.findByRole("button", { name: /current GPT-5 Mini · medium/i })).toBeTruthy();

    vi.useFakeTimers();
    const socket = MockWebSocket.instances[0]!;
    const terminal = xtermMock.instances[0]!;
    act(() => {
      terminal.emitData("\r");
    });
    terminal.deferWrites = true;
    act(() => {
      socket.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({ type: "output", stream: "stdout", data: "delayed parsed command output" })
        })
      );
      terminal.emitWriteParsed();
      terminal.completeNextWrite();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    expect(apiMock.cliModelSettings).toHaveBeenCalledTimes(2);
  });

  it("waits for the latest queued output write before starting the model catalog debounce", async () => {
    apiMock.cliModelSettings.mockResolvedValue(cliModelSettingsResponse());
    render(<TerminalPane pane={cliPane()} terminalFontSize={12} />);

    await waitFor(() => expect(apiMock.cliModelSettings).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(MockWebSocket.instances[0]?.readyState).toBe(MockWebSocket.OPEN));
    expect(await screen.findByRole("button", { name: /current GPT-5 Mini · medium/i })).toBeTruthy();

    vi.useFakeTimers();
    const socket = MockWebSocket.instances[0]!;
    const terminal = xtermMock.instances[0]!;
    act(() => {
      terminal.emitData("\r");
    });
    terminal.deferWrites = true;
    act(() => {
      socket.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({ type: "output", stream: "stdout", data: "queued output one" })
        })
      );
      socket.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({ type: "output", stream: "stdout", data: " queued output two" })
        })
      );
      terminal.completeNextWrite();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(401);
    });
    expect(apiMock.cliModelSettings).toHaveBeenCalledTimes(1);

    act(() => terminal.completeNextWrite());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(399);
    });
    expect(apiMock.cliModelSettings).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(apiMock.cliModelSettings).toHaveBeenCalledTimes(2);
  });

  it("cancels a submitted output refresh when its socket is unmounted before debounce", async () => {
    apiMock.cliModelSettings.mockResolvedValue(cliModelSettingsResponse());
    const room = render(<TerminalPane pane={cliPane()} terminalFontSize={12} />);

    await waitFor(() => expect(apiMock.cliModelSettings).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(MockWebSocket.instances[0]?.readyState).toBe(MockWebSocket.OPEN));
    expect(await screen.findByRole("button", { name: /current GPT-5 Mini · medium/i })).toBeTruthy();

    vi.useFakeTimers();
    const socket = MockWebSocket.instances[0]!;
    const terminal = xtermMock.instances[0]!;
    act(() => {
      terminal.emitData("\r");
      socket.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({ type: "output", stream: "stdout", data: "scheduled command output" })
        })
      );
    });
    room.unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(800);
    });
    expect(apiMock.cliModelSettings).toHaveBeenCalledTimes(1);
  });

  it("updates a live catalog after submitted terminal output and preserves the last-known-good catalog on refresh failure", async () => {
    const initial = cliModelSettingsResponse();
    const refreshed = cliModelSettingsResponse({
      models: [
        ...initial.models,
        {
          id: "gpt-future-omega",
          displayName: "Future Omega",
          isDefault: false,
          defaultReasoningEffort: "turbo",
          supportedReasoningEfforts: ["medium", "turbo"]
        }
      ]
    });
    apiMock.cliModelSettings
      .mockResolvedValueOnce(initial)
      .mockRejectedValueOnce(new Error("model/list temporarily unavailable"))
      .mockResolvedValue(refreshed);
    render(<TerminalPane pane={cliPane()} terminalFontSize={12} />);

    const trigger = await screen.findByRole("button", { name: /current GPT-5 Mini · medium/i }, { timeout: 5_000 });
    await waitFor(() => expect(MockWebSocket.instances[0]?.readyState).toBe(MockWebSocket.OPEN));
    act(() => {
      xtermMock.instances[0]?.emitData("\r");
      MockWebSocket.instances[0]?.dispatchEvent(
        new MessageEvent("message", { data: JSON.stringify({ type: "output", stream: "stdout", data: "refresh one\n" }) })
      );
    });
    await waitFor(() => expect(apiMock.cliModelSettings).toHaveBeenCalledTimes(2));
    expect(screen.getByRole("button", { name: /current GPT-5 Mini · medium/i })).toBe(trigger);
    expect(screen.queryByRole("button", { name: /model control unavailable/i })).toBeNull();

    act(() => {
      xtermMock.instances[0]?.emitData("\r");
      MockWebSocket.instances[0]?.dispatchEvent(
        new MessageEvent("message", { data: JSON.stringify({ type: "output", stream: "stdout", data: "refresh two\n" }) })
      );
    });
    await waitFor(() => expect(apiMock.cliModelSettings).toHaveBeenCalledTimes(3));
    fireEvent.click(trigger);
    expect(await screen.findByRole("option", { name: "Future Omega" })).toBeTruthy();
  });

  it("accepts a valid room-activation catalog when a concurrent same-session refresh fails", async () => {
    const activationCatalog = deferred<PaneCliModelSettings>();
    apiMock.cliModelSettings
      .mockReturnValueOnce(activationCatalog.promise)
      .mockRejectedValueOnce(new Error("concurrent model/list refresh failed"));
    render(<TerminalPane pane={cliPane()} terminalFontSize={12} />);

    await waitFor(() => expect(apiMock.cliModelSettings).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(MockWebSocket.instances[0]?.readyState).toBe(MockWebSocket.OPEN));
    act(() => {
      xtermMock.instances[0]?.emitData("\r");
      MockWebSocket.instances[0]?.dispatchEvent(
        new MessageEvent("message", { data: JSON.stringify({ type: "output", stream: "stdout", data: "turn output\n" }) })
      );
    });
    await waitFor(() => expect(apiMock.cliModelSettings).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole("button", { name: /model control unavailable/i })).toBeNull();

    await act(async () => {
      activationCatalog.resolve(cliModelSettingsResponse());
      await activationCatalog.promise;
    });

    expect(await screen.findByRole("button", { name: /current GPT-5 Mini · medium/i })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /model control unavailable/i })).toBeNull();
  });

  it("retries the startup catalog without replacing the active CLI session", async () => {
    const firstCatalog = deferred<PaneCliModelSettings>();
    apiMock.cliModelSettings
      .mockReturnValueOnce(firstCatalog.promise)
      .mockResolvedValueOnce(cliModelSettingsResponse());
    render(<TerminalPane pane={cliPane()} terminalFontSize={12} />);

    await waitFor(() => expect(apiMock.cliModelSettings).toHaveBeenCalledTimes(1));
    expect(await screen.findByLabelText("Live CLI pane Codex CLI")).toBeTruthy();
    expect(apiMock.createCliSession).toHaveBeenCalledTimes(1);

    vi.useFakeTimers();
    await act(async () => {
      firstCatalog.reject(new Error("model/list unavailable while app-server starts"));
      await firstCatalog.promise.catch(() => undefined);
    });

    expect(screen.queryByRole("button", { name: /model control unavailable/i })).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(249);
    });
    expect(apiMock.cliModelSettings).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });

    expect(apiMock.cliModelSettings).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("button", { name: /current GPT-5 Mini · medium/i })).toBeTruthy();
    expect(apiMock.createCliSession).toHaveBeenCalledTimes(1);
  });

  it("keeps model controls absent after startup retries are exhausted without replacing the CLI session", async () => {
    const firstCatalog = deferred<PaneCliModelSettings>();
    apiMock.cliModelSettings
      .mockReturnValueOnce(firstCatalog.promise)
      .mockRejectedValue(new Error("model/list unavailable"));
    render(<TerminalPane pane={cliPane()} terminalFontSize={12} />);

    await waitFor(() => expect(apiMock.cliModelSettings).toHaveBeenCalledTimes(1));
    expect(await screen.findByLabelText("Live CLI pane Codex CLI")).toBeTruthy();

    vi.useFakeTimers();
    await act(async () => {
      firstCatalog.reject(new Error("model/list unavailable"));
      await firstCatalog.promise.catch(() => undefined);
    });
    expect(screen.queryByRole("button", { name: /model control unavailable/i })).toBeNull();

    for (const retryDelay of [250, 500, 1_000]) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(retryDelay);
      });
      expect(screen.queryByRole("button", { name: /model control unavailable/i })).toBeNull();
    }
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_999);
    });
    expect(screen.queryByRole("button", { name: /model control unavailable/i })).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });

    expect(apiMock.cliModelSettings).toHaveBeenCalledTimes(5);
    expect(screen.queryByRole("button", { name: /model control unavailable/i })).toBeNull();
    expect(apiMock.createCliSession).toHaveBeenCalledTimes(1);
  });

  it("cancels a scheduled startup catalog retry when the pane unmounts", async () => {
    const firstCatalog = deferred<PaneCliModelSettings>();
    apiMock.cliModelSettings.mockReturnValueOnce(firstCatalog.promise);
    const room = render(<TerminalPane pane={cliPane()} terminalFontSize={12} />);

    await waitFor(() => expect(apiMock.cliModelSettings).toHaveBeenCalledTimes(1));
    expect(await screen.findByLabelText("Live CLI pane Codex CLI")).toBeTruthy();

    vi.useFakeTimers();
    await act(async () => {
      firstCatalog.reject(new Error("model/list unavailable while app-server starts"));
      await firstCatalog.promise.catch(() => undefined);
    });
    room.unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });

    expect(apiMock.cliModelSettings).toHaveBeenCalledTimes(1);
    expect(apiMock.createCliSession).toHaveBeenCalledTimes(1);
  });

  it("ignores a stale catalog response after the active CLI session is replaced", async () => {
    const staleCatalog = deferred<PaneCliModelSettings>();
    apiMock.createCliSession.mockResolvedValueOnce(
      cliSessionResponse("terminal-ws-ticket-initial", "IDLE", true, { sessionId: "cli_session:initial" })
    );
    apiMock.activeCliSession
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(
        cliSessionResponse("terminal-ws-ticket-replacement", "IDLE", true, {
          sessionId: "cli_session:replacement"
        })
      );
    apiMock.cliModelSettings
      .mockReturnValueOnce(staleCatalog.promise)
      .mockResolvedValueOnce(cliModelSettingsResponse({
        sessionId: "cli_session:replacement",
        current: { modelId: "gpt-replacement", reasoningEffort: "high" },
        models: [
          {
            id: "gpt-replacement",
            displayName: "Replacement",
            isDefault: true,
            defaultReasoningEffort: "high",
            supportedReasoningEfforts: ["high"]
          }
        ]
      }));
    render(<TerminalPane pane={cliPane()} terminalFontSize={12} />);

    await waitFor(() => expect(apiMock.cliModelSettings).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(MockWebSocket.instances[0]?.readyState).toBe(MockWebSocket.OPEN));
    act(() => MockWebSocket.instances[0]?.close());
    await waitFor(() => expect(apiMock.activeCliSession).toHaveBeenCalledTimes(2), { timeout: 1_200 });
    expect(apiMock.createCliSession).toHaveBeenCalledTimes(1);
    expect(await screen.findByRole("button", { name: /current Replacement · high/i })).toBeTruthy();

    await act(async () => {
      staleCatalog.resolve(cliModelSettingsResponse({
        sessionId: "cli_session:initial",
        current: { modelId: "gpt-stale", reasoningEffort: "medium" },
        models: [
          {
            id: "gpt-stale",
            displayName: "Stale",
            isDefault: true,
            defaultReasoningEffort: "medium",
            supportedReasoningEfforts: ["medium"]
          }
        ]
      }));
      await staleCatalog.promise;
    });

    expect(screen.getByRole("button", { name: /current Replacement · high/i })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /current Stale/i })).toBeNull();
  });

  it("ignores a scheduled catalog response after the room unmounts", async () => {
    const scheduledCatalog = deferred<PaneCliModelSettings>();
    apiMock.cliModelSettings
      .mockResolvedValueOnce(cliModelSettingsResponse())
      .mockReturnValueOnce(scheduledCatalog.promise);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const room = render(<TerminalPane pane={cliPane()} terminalFontSize={12} />);

    await screen.findByRole("button", { name: /current GPT-5 Mini · medium/i }, { timeout: 3_000 });
    await waitFor(() => expect(MockWebSocket.instances[0]?.readyState).toBe(MockWebSocket.OPEN));
    act(() => {
      xtermMock.instances[0]?.emitData("\r");
      MockWebSocket.instances[0]?.dispatchEvent(
        new MessageEvent("message", { data: JSON.stringify({ type: "output", stream: "stdout", data: "refresh before close\n" }) })
      );
    });
    await waitFor(() => expect(apiMock.cliModelSettings).toHaveBeenCalledTimes(2));
    room.unmount();

    await act(async () => {
      scheduledCatalog.resolve(cliModelSettingsResponse());
      await scheduledCatalog.promise;
    });
    expect(consoleError).not.toHaveBeenCalled();
  });

  it("attaches pasted images to the Codex prompt through bracketed paste", async () => {
    render(<TerminalPane pane={cliPane()} terminalFontSize={12} />);

    await waitFor(() =>
      expect(apiMock.createCliSession).toHaveBeenCalledWith("pane:cli-upload", {
        runtimeId: "cli:codex",
        reasoningEffort: "medium",
        cwd: "/opt/spaceapp",
        includeTranscript: false
      })
    );
    expect(screen.queryByLabelText("Start CLI Codex CLI")).toBeNull();
    expect(screen.queryByLabelText("CLI runtime Codex CLI")).toBeNull();
    expect(screen.queryByText("/opt/spaceapp/var/artifacts/cli-workspaces/room_cli-upload/pane_cli-upload/cli_session_test-upload")).toBeNull();
    await waitFor(() => expect(MockWebSocket.instances[0]?.readyState).toBe(MockWebSocket.OPEN));

    const terminal = await screen.findByLabelText("CLI pane Codex CLI");
    const file = new File(["data"], "diagram.png", { type: "image/png" });
    fireEvent.paste(terminal, {
      clipboardData: {
        files: [],
        items: [{ kind: "file", getAsFile: () => file }],
        getData: () => ""
      }
    });

    await waitFor(() => expect(apiMock.uploadCliFiles).toHaveBeenCalledWith({ paneId: "pane:cli-upload", source: "CLIPBOARD", files: [file] }));
    await openPhotoPreviews(1);
    expect(await screen.findByRole("button", { name: "Open image 1" })).toBeTruthy();
    expect(screen.getByLabelText("CLI image uploads Codex CLI")).toBeTruthy();
    expect(screen.queryByText("diagram.png")).toBeNull();
    expect(MockWebSocket.instances[0]?.sent).toContain(
      JSON.stringify({
        type: "input",
        data: "\u001b[200~/opt/spaceapp/var/artifacts/cli-uploads/diagram.png\u001b[201~",
        display: "hidden"
      })
    );
  });

  it("lets Enter after a bare # submit normally and picks a variable only after arrow navigation", async () => {
    window.localStorage.setItem("space.promptVariables.v1", JSON.stringify([
      { id: "var:pc", name: "pc_thai", value: "10.0.0.5", createdAt: "2026-10-11T00:00:00.000Z", updatedAt: "2026-10-11T00:00:00.000Z" }
    ]));
    try {
      render(<TerminalPane pane={cliPane()} terminalFontSize={12} />);
      await waitFor(() => expect(apiMock.createCliSession).toHaveBeenCalled());
      await waitFor(() => expect(MockWebSocket.instances[0]?.readyState).toBe(MockWebSocket.OPEN));
      const terminal = xtermMock.instances[0] as unknown as { emitData: (data: string) => void; customKeyEventHandler?: (event: KeyboardEvent) => boolean };
      const socket = MockWebSocket.instances[0]!;

      act(() => terminal.emitData("ping #"));
      await screen.findByRole("listbox", { name: "Prompt variables suggestions" });
      socket.sent.length = 0;
      expect(terminal.customKeyEventHandler?.(new KeyboardEvent("keydown", { key: "Enter" }))).toBe(true);
      expect(socket.sent.some((frame) => frame.includes("#pc_thai"))).toBe(false);

      act(() => {
        expect(terminal.customKeyEventHandler?.(new KeyboardEvent("keydown", { key: "ArrowDown" }))).toBe(false);
      });
      act(() => {
        expect(terminal.customKeyEventHandler?.(new KeyboardEvent("keydown", { key: "Enter" }))).toBe(false);
      });
      await waitFor(() => expect(socket.sent).toContain(JSON.stringify({ type: "input", data: "\u007f#pc_thai " })));
    } finally {
      window.localStorage.removeItem("space.promptVariables.v1");
    }
  });

  it("leaves the Shortcuts and Plans buttons out of the toolbar when Settings hides them", async () => {
    window.localStorage.setItem(VOICE_SETTINGS_STORAGE_KEY, JSON.stringify({
      ...defaultVoiceComposerSettings, terminalControlsVersion: 2, terminalShortcutsButton: false, terminalPlansButton: false
    }));
    render(<TerminalPane pane={cliPane()} terminalFontSize={12} />);
    await waitFor(() => expect(MockWebSocket.instances[0]?.readyState).toBe(MockWebSocket.OPEN));
    expect(await screen.findByRole("button", { name: "Send prompt" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "CLI shortcuts" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Open plans|Active plan/i })).toBeNull();
    expect(screen.getByRole("button", { name: /Prompt Variables \(#\)/ })).toBeTruthy();
  });

  it("opens the local draft by default when Settings says so, unless the pane was closed by hand", async () => {
    const draftKey = "space.cli.localComposer.open:pane:cli-upload";
    const apiWithMe = apiMock as typeof apiMock & { me?: unknown };
    const previousMe = apiWithMe.me;
    apiWithMe.me = vi.fn(() => new Promise(() => undefined));
    window.localStorage.setItem(VOICE_SETTINGS_STORAGE_KEY, JSON.stringify({
      ...defaultVoiceComposerSettings, terminalControlsVersion: 2, terminalLocalDraft: true
    }));
    try {
      const view = render(<TerminalPane pane={cliPane()} terminalFontSize={12} />);
      await waitFor(() => expect(MockWebSocket.instances[0]?.readyState).toBe(MockWebSocket.OPEN));
      expect(await screen.findByText("Opening saved draft…")).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Open local draft" })).toBeNull();
      view.unmount();

      window.localStorage.setItem(draftKey, "false");
      render(<TerminalPane pane={cliPane()} terminalFontSize={12} />);
      expect(await screen.findByRole("button", { name: "Open local draft" })).toBeTruthy();
      expect(screen.queryByText("Opening saved draft…")).toBeNull();
    } finally {
      window.localStorage.removeItem(draftKey);
      apiWithMe.me = previousMe;
    }
  });

  it("uses the floating control to submit a draft and pause an active Codex turn with Esc", async () => {
    apiMock.cliTurnActivity.mockImplementation(() => new Promise(() => undefined));
    render(<TerminalPane pane={cliPane()} terminalFontSize={12} />);

    await waitFor(() => expect(apiMock.createCliSession).toHaveBeenCalled());
    await waitFor(() => expect(MockWebSocket.instances[0]?.readyState).toBe(MockWebSocket.OPEN));

    const send = (await screen.findByRole("button", { name: "Send prompt" })) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    expect(send.getAttribute("data-state")).toBe("idle");

    for (const response of [
      "\u001b[I",
      "\u001b[7;1R",
      "\u001b]10;rgb:e8e8/e3e3/d8d8\u001b\\",
      "\u001b]11;rgb:0909/0b0b/0c0c\u001b\\",
      "\u001b[?1;2c"
    ]) {
      xtermMock.instances[0]?.emitData(response);
    }
    expect(send.disabled).toBe(true);
    expect(send.getAttribute("data-state")).toBe("idle");

    xtermMock.instances[0]?.emitData("Explain this change");
    await waitFor(() => expect(send.disabled).toBe(false));
    expect(send.getAttribute("data-state")).toBe("ready");

    fireEvent.click(send);

    const submitted = MockWebSocket.instances[0]?.sent
      .map((frame) => JSON.parse(frame) as { type: string; data: string; turnMarker?: string })
      .find((frame) => frame.type === "input" && frame.data === "\r");
    expect(submitted).toMatchObject({ type: "input", data: "\r", turnMarker: expect.any(String) });

    const stop = await screen.findByRole("button", { name: "Stop Codex" });
    expect(stop.getAttribute("data-state")).toBe("running");
    fireEvent.click(stop);
    expect(MockWebSocket.instances[0]?.sent).toContain(JSON.stringify({ type: "input", data: "\u001b" }));
    // A second click right after Stop neither submits nor interrupts again.
    const stopping = screen.getByRole("button", { name: "Stopping…" }) as HTMLButtonElement;
    expect(stopping.disabled).toBe(true);
    expect(stopping.getAttribute("data-state")).toBe("stopping");
    const framesAfterStop = MockWebSocket.instances[0]!.sent.length;
    fireEvent.click(stopping);
    expect(MockWebSocket.instances[0]!.sent.length).toBe(framesAfterStop);
    const idleAfterStop = await screen.findByRole("button", { name: "Send prompt" }, { timeout: 2_500 });
    expect(idleAfterStop.getAttribute("data-state")).toBe("idle");
    expect(window.sessionStorage.getItem("space.cliActiveTurn:pane:cli-upload")).toBeNull();
    expect(apiMock.interruptCliSession).not.toHaveBeenCalled();
  });

  it("hides and restores the floating controls without replacing the active CLI session or sending input", async () => {
    const room = render(<TerminalPane pane={cliPane()} terminalFontSize={12} hideFloatingControls={false} />);

    await waitFor(() => expect(apiMock.createCliSession).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(MockWebSocket.instances[0]?.readyState).toBe(MockWebSocket.OPEN));
    expect(await screen.findByRole("button", { name: "Send prompt" })).toBeTruthy();
    expect(room.container.querySelector(".terminal-floating-controls")).toBeTruthy();

    const file = new File(["data"], "still-visible.png", { type: "image/png" });
    fireEvent.paste(screen.getByLabelText("CLI pane Codex CLI"), {
      clipboardData: {
        files: [],
        items: [{ kind: "file", getAsFile: () => file }],
        getData: () => ""
      }
    });
    await openPhotoPreviews(1);
    expect(await screen.findByRole("button", { name: "Open image 1" })).toBeTruthy();

    const socket = MockWebSocket.instances[0]!;
    const inputFramesBeforeHide = socket.sent.filter((frame) =>
      (JSON.parse(frame) as { type?: string }).type === "input"
    );
    room.rerender(withVoiceInput(<TerminalPane pane={cliPane()} terminalFontSize={12} hideFloatingControls />));

    expect(room.container.querySelector(".terminal-floating-controls")).toBeNull();
    expect(screen.queryByRole("button", { name: "Send prompt" })).toBeNull();
    expect(room.container.querySelector(".terminal-xterm")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open image 1" })).toBeTruthy();
    expect(screen.getByLabelText("CLI image uploads Codex CLI")).toBeTruthy();
    expect(apiMock.createCliSession).toHaveBeenCalledTimes(1);
    expect(MockWebSocket.instances).toHaveLength(1);
    expect(socket.sent.filter((frame) =>
      (JSON.parse(frame) as { type?: string }).type === "input"
    )).toEqual(inputFramesBeforeHide);

    room.rerender(withVoiceInput(<TerminalPane pane={cliPane()} terminalFontSize={12} hideFloatingControls={false} />));

    expect(await screen.findByRole("button", { name: "Send prompt" })).toBeTruthy();
    expect(room.container.querySelector(".terminal-floating-controls")).toBeTruthy();
    expect(apiMock.createCliSession).toHaveBeenCalledTimes(1);
    expect(MockWebSocket.instances).toHaveLength(1);
    expect(socket.sent.filter((frame) =>
      (JSON.parse(frame) as { type?: string }).type === "input"
    )).toEqual(inputFramesBeforeHide);
  });

  it("tracks native Enter and returns the floating control to idle after the Codex turn completes", async () => {
    let resolveActivity!: (value: { marker: string; status: "COMPLETED"; turnId: string }) => void;
    let activityCalls = 0;
    apiMock.cliTurnActivity.mockImplementation((_paneId: string, marker: string) => {
      activityCalls += 1;
      if (activityCalls === 1) return Promise.resolve({ marker, status: "UNAVAILABLE" as const, turnId: null });
      return new Promise<{ marker: string; status: "COMPLETED"; turnId: string }>((resolve) => {
        resolveActivity = resolve;
      });
    });
    render(<TerminalPane pane={cliPane()} terminalFontSize={12} />);

    await waitFor(() => expect(apiMock.createCliSession).toHaveBeenCalled());
    await waitFor(() => expect(MockWebSocket.instances[0]?.readyState).toBe(MockWebSocket.OPEN));

    xtermMock.instances[0]?.emitData("Use native Enter");
    xtermMock.instances[0]?.emitData("\r");

    const stop = await screen.findByRole("button", { name: "Stop Codex" });
    const submitted = MockWebSocket.instances[0]?.sent
      .map((frame) => JSON.parse(frame) as { type: string; data: string; turnMarker?: string })
      .findLast((frame) => frame.type === "input" && frame.data === "\r");
    expect(submitted?.turnMarker).toEqual(expect.any(String));
    expect(window.sessionStorage.getItem("space.cliActiveTurn:pane:cli-upload")).toContain(submitted?.turnMarker);
    await waitFor(() => expect(apiMock.cliTurnActivity).toHaveBeenCalledWith("pane:cli-upload", submitted?.turnMarker));
    await waitFor(() => expect(apiMock.cliTurnActivity).toHaveBeenCalledTimes(2), { timeout: 2_000 });
    expect(stop.getAttribute("data-state")).toBe("running");

    await act(async () => {
      resolveActivity({ marker: submitted?.turnMarker ?? "", status: "COMPLETED", turnId: "turn:native-enter" });
    });

    await waitFor(() => expect(screen.getByRole("button", { name: "Send prompt" }).getAttribute("data-state")).toBe("idle"));
    expect(window.sessionStorage.getItem("space.cliActiveTurn:pane:cli-upload")).toBeNull();
    expect(stop.getAttribute("aria-label")).toBe("Send prompt");
  });

  it("stops a running OpenCode turn through the server-control abort instead of an ESC keystroke", async () => {
    apiMock.cliModelSettings.mockResolvedValue({
      sessionId: "cli_session:test-upload",
      threadId: null,
      current: { modelId: "opencode/deepseek-v4-flash-free", reasoningEffort: "auto" },
      models: [
        {
          id: "opencode/deepseek-v4-flash-free",
          displayName: "DeepSeek V4 Flash Free",
          isDefault: true,
          defaultReasoningEffort: "auto",
          supportedReasoningEfforts: [],
          reasoningOptions: []
        }
      ],
      controlMode: "OPENCODE",
      isTurnActive: true
    });
    apiMock.createCliSession.mockResolvedValueOnce(
      cliSessionResponse("terminal-ws-ticket-opencode", "RUNNING", true, { runtimeId: "cli:opencode" })
    );
    apiMock.abortCliTurn.mockResolvedValue({ ok: true, isTurnActive: false });
    apiMock.cliTerminalWebSocketUrl.mockImplementation(
      (
        ticket: { paneId: string; sessionId: string },
        options: { clientMode?: "INTERACTIVE" | "OBSERVER"; leaseId?: string | null } = {}
      ) =>
        `ws://space.test/terminal?paneId=${encodeURIComponent(ticket.paneId)}` +
        `&sessionId=${encodeURIComponent(ticket.sessionId)}&runtimeId=cli%3Aopencode` +
        `&protocolVersion=2&clientMode=${options.clientMode ?? "INTERACTIVE"}` +
        (options.leaseId ? `&leaseId=${encodeURIComponent(options.leaseId)}` : "")
    );
    apiMock.cliRuntimes.mockResolvedValueOnce({
      data: [
        {
          id: "cli:opencode",
          providerId: "opencode",
          providerName: "OpenCode",
          agentId: "opencode",
          agentName: "OpenCode CLI",
          displayName: "OpenCode CLI",
          capabilities: ["CLI"],
          adapterStatus: "ENABLED",
          authMode: "NONE",
          authState: "READY",
          authReason: "Runtime credentials are verified.",
          canStartLogin: false,
          status: "ENABLED",
          statusReason: "OpenCode CLI command and credential smoke are verified.",
          commandName: "opencode",
          detectedCommandPath: "/opt/spaceapp/bin/opencode",
          defaultModelId: null,
          supportedReasoningEfforts: [],
          checkedAt: "2026-07-05T00:00:00.000Z"
        }
      ],
      checkedAt: "2026-07-05T00:00:00.000Z"
    });
    render(<TerminalPane pane={cliPane({ terminalRuntimeId: "cli:opencode" })} terminalFontSize={12} />);

    await waitFor(() => expect(apiMock.createCliSession).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(MockWebSocket.instances[0]?.readyState).toBe(MockWebSocket.OPEN));

    const stop = await screen.findByRole("button", { name: "Stop OpenCode" });
    expect(stop.getAttribute("data-state")).toBe("running");
    fireEvent.click(stop);

    await waitFor(() => expect(apiMock.abortCliTurn).toHaveBeenCalledWith("pane:cli-upload"));
    expect(apiMock.interruptCliSession).not.toHaveBeenCalled();
    const inputFrames = MockWebSocket.instances[0]?.sent
      .map((frame) => JSON.parse(frame) as { type: string; data?: string })
      .filter((frame) => frame.type === "input");
    expect(inputFrames?.some((frame) => frame.data === "\u001b")).toBe(false);

    await waitFor(() => expect(screen.getByRole("button", { name: "Send prompt" }).getAttribute("data-state")).toBe("idle"));
    expect(window.sessionStorage.getItem("space.cliActiveTurn:pane:cli-upload")).toBeNull();
  });

  it("keeps the active turn state while a recoverable terminal socket reconnects", async () => {
    apiMock.cliTurnActivity.mockImplementation(() => new Promise(() => undefined));
    render(<TerminalPane pane={cliPane()} terminalFontSize={12} />);

    await waitFor(() => expect(apiMock.createCliSession).toHaveBeenCalled());
    await waitFor(() => expect(MockWebSocket.instances[0]?.readyState).toBe(MockWebSocket.OPEN));

    xtermMock.instances[0]?.emitData("Keep this request active");
    fireEvent.click(await screen.findByRole("button", { name: "Send prompt" }));
    await screen.findByRole("button", { name: "Stop Codex" });

    MockWebSocket.instances[0]?.close();

    const reconnectingStop = await screen.findByRole("button", { name: "Stop Codex" });
    expect(reconnectingStop.getAttribute("data-state")).toBe("running");
    expect((reconnectingStop as HTMLButtonElement).disabled).toBe(true);
  });

  it("restores the active turn for the same CLI session after a page remount", async () => {
    apiMock.cliTurnActivity.mockImplementation(async (_paneId: string, marker: string) => ({
      marker,
      status: "RUNNING" as const,
      turnId: "turn:restored"
    }));
    const first = render(<TerminalPane pane={cliPane()} terminalFontSize={12} />);

    await waitFor(() => expect(MockWebSocket.instances[0]?.readyState).toBe(MockWebSocket.OPEN));
    xtermMock.instances[0]?.emitData("Keep running through refresh");
    fireEvent.click(await screen.findByRole("button", { name: "Send prompt" }));
    const submitted = MockWebSocket.instances[0]?.sent
      .map((frame) => JSON.parse(frame) as { type: string; data: string; turnMarker?: string })
      .find((frame) => frame.type === "input" && frame.data === "\r");
    await screen.findByRole("button", { name: "Stop Codex" });
    first.unmount();

    apiMock.activeCliSession.mockResolvedValueOnce(
      cliSessionResponse("terminal-ws-ticket-restored", "RUNNING", true, {
        sessionId: "cli_session:test-upload"
      })
    );
    render(<TerminalPane pane={cliPane()} terminalFontSize={12} />);

    const restoredStop = await screen.findByRole("button", { name: "Stop Codex" });
    expect(restoredStop.getAttribute("data-state")).toBe("running");
    await waitFor(() => expect(apiMock.cliTurnActivity).toHaveBeenCalledWith("pane:cli-upload", submitted?.turnMarker));
  });

  it("discards a stored active turn when the CLI session identity changes", async () => {
    const marker = "77b236da-622e-4f0a-9f36-66850c94b553";
    window.sessionStorage.setItem(
      "space.cliActiveTurn:pane:cli-upload",
      JSON.stringify({ sessionId: "cli_session:old", marker, status: "RUNNING" })
    );
    apiMock.activeCliSession.mockResolvedValueOnce(
      cliSessionResponse("terminal-ws-ticket-new-session", "RUNNING", true, {
        sessionId: "cli_session:new"
      })
    );

    render(<TerminalPane pane={cliPane()} terminalFontSize={12} />);

    await screen.findByRole("button", { name: "Send prompt" });
    await waitFor(() => expect(window.sessionStorage.getItem("space.cliActiveTurn:pane:cli-upload")).toBeNull());
    expect(apiMock.cliTurnActivity).not.toHaveBeenCalledWith("pane:cli-upload", marker);
  });

  it("fails closed and removes malformed active turn storage", async () => {
    window.sessionStorage.setItem("space.cliActiveTurn:pane:cli-upload", "{not-json");
    apiMock.activeCliSession.mockResolvedValueOnce(
      cliSessionResponse("terminal-ws-ticket-malformed-storage", "RUNNING", true, {
        sessionId: "cli_session:test-upload"
      })
    );

    render(<TerminalPane pane={cliPane()} terminalFontSize={12} />);

    await screen.findByRole("button", { name: "Send prompt" });
    await waitFor(() =>
      expect(window.sessionStorage.getItem("space.cliActiveTurn:pane:cli-upload")).toBeNull()
    );
    expect(apiMock.cliTurnActivity).not.toHaveBeenCalled();
  });

  it("attaches an existing active CLI session on mount before creating a replacement", async () => {
    apiMock.activeCliSession.mockResolvedValueOnce(
      cliSessionResponse("terminal-ws-ticket-existing-active", "RUNNING", true, {
        sessionId: "cli_session:existing-active"
      })
    );

    render(<TerminalPane pane={cliPane()} terminalFontSize={12} />);

    await waitFor(() =>
      expect(apiMock.activeCliSession).toHaveBeenCalledWith("pane:cli-upload", { includeTranscript: false })
    );
    expect(apiMock.cliRuntimes).toHaveBeenCalledWith({ allowStale: true });
    await waitFor(() => expect(MockWebSocket.instances[0]?.readyState).toBe(MockWebSocket.OPEN));
    expect(apiMock.createCliSession).not.toHaveBeenCalled();
    expect(MockWebSocket.instances[0]?.url).toContain("sessionId=cli_session%3Aexisting-active");
  });

  function photoHistoryPage(ids: number[], totalPages = 1) {
    return {
      data: ids.map((id) => ({
        id: `artifact:photo-${id}`, roomId: cliPane().roomId, paneId: cliPane().id,
        kind: "IMAGE", mimeType: "image/png", deletedAt: null,
        storageUri: `space-artifact://cli-uploads/room/pane/old-session/day/photo-${id}.png`,
        metadata: { originalFilename: `photo-${id}.png` }
      })),
      pagination: { totalPages }
    };
  }

  it.each(["cli:codex", "cli:gemini", "cli:opencode", "cli:deepseek", "cli:claude", "cli:antigravity"])(
    "restores persistent photo gallery for %s after remount, without a new upload",
    async (runtimeId) => {
      apiMock.artifacts.mockResolvedValue(photoHistoryPage([1, 2]));
      const pane = { ...cliPane(), terminalRuntimeId: runtimeId };
      const first = render(<TerminalPane pane={pane} terminalFontSize={12} />);
      fireEvent.click(await screen.findByRole("button", { name: "Photos (2) for Codex CLI" }));
      fireEvent.click(screen.getByRole("button", { name: "Open image 1" }));
      expect(screen.getByRole("img", { name: "Image 1 full size" }).getAttribute("src")).toBe("/api/artifacts/artifact%3Aphoto-1/file");
      first.unmount();
      render(<TerminalPane pane={pane} terminalFontSize={12} />);
      expect(await screen.findByRole("button", { name: "Photos (2) for Codex CLI" })).toBeTruthy();
      expect(apiMock.uploadCliFiles).not.toHaveBeenCalled();
      expect(apiMock.artifacts).toHaveBeenCalledWith(expect.objectContaining({ paneId: pane.id, roomId: pane.roomId, kind: "IMAGE" }));
    }
  );

  it("restores every photo history page and keeps older photos accessible beyond the thumbnail limit", async () => {
    apiMock.artifacts.mockResolvedValueOnce(photoHistoryPage([1, 2], 2)).mockResolvedValueOnce(photoHistoryPage([3, 4], 2));
    render(<TerminalPane pane={cliPane()} terminalFontSize={12} maxImagePreviews={2} />);
    fireEvent.click(await screen.findByRole("button", { name: "Photos (4) for Codex CLI" }));
    expect(screen.getAllByRole("button", { name: /Open image/ })).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Open image 4" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Earlier photos" }));
    expect(screen.getByRole("button", { name: "Open image 1" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open image 2" }));
    fireEvent.click(screen.getByRole("button", { name: "Next image" }));
    expect(screen.getByRole("dialog", { name: "Image 3 preview" })).toBeTruthy();
    expect(apiMock.artifacts.mock.calls.map(([query]) => query.page)).toEqual([1, 2]);
  });

  it("navigates the photo gallery with buttons and arrow keys without sending input to the CLI", async () => {
    apiMock.artifacts.mockResolvedValue(photoHistoryPage([1, 2, 3]));
    render(<TerminalPane pane={cliPane()} terminalFontSize={12} />);
    await waitFor(() => expect(MockWebSocket.instances[0]?.readyState).toBe(MockWebSocket.OPEN));
    fireEvent.click(await screen.findByRole("button", { name: "Photos (3) for Codex CLI" }));
    const thumbnail = screen.getByRole("button", { name: "Open image 1" });
    fireEvent.click(thumbnail);
    const framesBefore = MockWebSocket.instances[0]!.sent.length;
    const next = screen.getByRole("button", { name: "Next image" });
    next.focus();
    fireEvent.click(next);
    expect(screen.getByRole("dialog", { name: "Image 2 preview" })).toBeTruthy();
    expect(document.activeElement).toBe(next);
    fireEvent.keyDown(next, { key: "ArrowRight" });
    expect(screen.getByRole("dialog", { name: "Image 3 preview" })).toBeTruthy();
    fireEvent.keyDown(next, { key: "ArrowRight" });
    expect(screen.getByRole("dialog", { name: "Image 1 preview" })).toBeTruthy();
    fireEvent.keyDown(next, { key: "ArrowLeft" });
    expect(screen.getByRole("dialog", { name: "Image 3 preview" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Previous image" }));
    expect(screen.getByRole("dialog", { name: "Image 2 preview" })).toBeTruthy();
    fireEvent.keyDown(next, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: /preview/ })).toBeNull();
    expect(document.activeElement).toBe(thumbnail);
    expect(MockWebSocket.instances[0]!.sent.length).toBe(framesBefore);
  });

  it("themes the photo viewer like its pane and shows a spinner until the photo loads", async () => {
    apiMock.artifacts.mockResolvedValue(photoHistoryPage([1, 2]));
    const shell = Object.assign(document.createElement("main"), { className: "space-shell" });
    Object.assign(shell.dataset, { roomTheme: "copper", uiTheme: "modern", colorMode: "light" });
    document.body.append(shell);
    try {
      render(<TerminalPane pane={cliPane()} terminalFontSize={12} />, { container: shell.appendChild(document.createElement("div")) });
      fireEvent.click(await screen.findByRole("button", { name: "Photos (2) for Codex CLI" }));
      fireEvent.click(screen.getByRole("button", { name: "Open image 2" }));
      const dialog = screen.getByRole("dialog", { name: "Image 2 preview" });
      expect(dialog.parentElement).toBe(document.body);
      expect(dialog.dataset).toMatchObject({ roomTheme: "copper", uiTheme: "modern", colorMode: "light" });
      expect(screen.getByText("photo-2.png")).toBeTruthy();
      const photo = screen.getByRole("img", { name: "Image 2 full size" });
      expect(photo.dataset.loaded).toBeUndefined();
      fireEvent.load(photo);
      expect(photo.dataset.loaded).toBe("true");
    } finally {
      shell.remove();
    }
  });

  it("retries photo history failures without discarding current uploads", async () => {
    apiMock.artifacts.mockRejectedValueOnce(new Error("API restarting"));
    render(<TerminalPane pane={cliPane()} terminalFontSize={12} />);
    fireEvent.click(await screen.findByRole("button", { name: "Photos (0) for Codex CLI" }));
    apiMock.artifacts.mockResolvedValue(photoHistoryPage([1]));
    fireEvent.click(screen.getByRole("button", { name: "Retry loading photos" }));
    expect(await screen.findByRole("button", { name: "Photos (1) for Codex CLI" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Retry loading photos" })).toBeNull();
  });

  it("ignores unrelated artifacts and a photo history response from an unmounted pane", async () => {
    const page = photoHistoryPage([1, 2, 3]);
    page.data[1]!.paneId = "pane:other";
    page.data[2]!.storageUri = "space-artifact://user-uploads/other.png";
    apiMock.artifacts.mockResolvedValueOnce(page);
    const first = render(<TerminalPane pane={cliPane()} terminalFontSize={12} />);
    expect(await screen.findByRole("button", { name: "Photos (1) for Codex CLI" })).toBeTruthy();
    first.unmount();
    let finish!: (value: ReturnType<typeof photoHistoryPage>) => void;
    apiMock.artifacts.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const pending = render(<TerminalPane pane={cliPane()} terminalFontSize={12} />);
    pending.unmount();
    apiMock.artifacts.mockResolvedValue({ data: [], pagination: { totalPages: 0 } });
    render(<TerminalPane pane={{ ...cliPane(), id: "pane:other" }} terminalFontSize={12} />);
    await act(async () => { finish(photoHistoryPage([4])); });
    expect(screen.queryByRole("button", { name: /Photos/ })).toBeNull();
  });

  it("shows photo options menu on right click and deletes photos permanently", async () => {
    apiMock.artifacts.mockResolvedValue(photoHistoryPage([1, 2]));
    render(<TerminalPane pane={cliPane()} terminalFontSize={12} />);

    const photoButton = await screen.findByRole("button", { name: "Photos (2) for Codex CLI" });

    // Desktop Right-click opens context menu with "Delete photos"
    fireEvent.contextMenu(photoButton, { clientX: 100, clientY: 100 });
    expect(await screen.findByRole("menu", { name: "Photo options Codex CLI" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: /View photos/i })).toBeTruthy();
    const deleteOption = screen.getByRole("menuitem", { name: /Delete photos/i });
    expect(deleteOption).toBeTruthy();

    // Clicking Delete photos triggers deletion
    fireEvent.click(deleteOption);
    await waitFor(() => expect(apiMock.deleteArtifact).toHaveBeenCalledWith("artifact:photo-1"));
    expect(apiMock.deleteArtifact).toHaveBeenCalledWith("artifact:photo-2");
    expect(screen.queryByRole("menu", { name: "Photo options Codex CLI" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Photos/ })).toBeNull();
  });

  it("opens photo options menu on mobile touch long-press and dismisses with Escape", async () => {
    apiMock.artifacts.mockResolvedValue(photoHistoryPage([1, 2]));
    render(<TerminalPane pane={cliPane()} terminalFontSize={12} />);

    const photoButton = await screen.findByRole("button", { name: "Photos (2) for Codex CLI" });

    // Enable fake timers specifically around the touch long-press
    vi.useFakeTimers();
    try {
      // Pointer down on touch starts timer
      fireEvent.pointerDown(photoButton, { pointerType: "touch", isPrimary: true, clientX: 50, clientY: 50, pointerId: 1 });
      act(() => {
        vi.advanceTimersByTime(550);
      });

      expect(screen.getByRole("menu", { name: "Photo options Codex CLI" })).toBeTruthy();
      expect(screen.getByRole("menuitem", { name: /Delete photos/i })).toBeTruthy();

      // Dismiss with Escape key
      fireEvent.keyDown(document, { key: "Escape" });
      expect(screen.queryByRole("menu", { name: "Photo options Codex CLI" })).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("allows deleting an individual photo thumbnail from the popover strip", async () => {
    apiMock.artifacts.mockResolvedValue(photoHistoryPage([1, 2]));
    render(<TerminalPane pane={cliPane()} terminalFontSize={12} />);

    const photoButton = await screen.findByRole("button", { name: "Photos (2) for Codex CLI" });
    fireEvent.click(photoButton);

    const deleteFirstImageBtn = screen.getByRole("button", { name: "Delete image 1" });
    fireEvent.click(deleteFirstImageBtn);

    await waitFor(() => expect(apiMock.deleteArtifact).toHaveBeenCalledWith("artifact:photo-1"));
    expect(await screen.findByRole("button", { name: "Photos (1) for Codex CLI" })).toBeTruthy();
  });

  it("keeps 12 image previews by default while batching API uploads within the per-request limit", async () => {
    render(<TerminalPane pane={cliPane()} terminalFontSize={12} />);

    await waitFor(() => expect(apiMock.createCliSession).toHaveBeenCalled());
    await waitFor(() => expect(MockWebSocket.instances[0]?.readyState).toBe(MockWebSocket.OPEN));

    const terminal = await screen.findByLabelText("CLI pane Codex CLI");
    const files = Array.from({ length: 12 }, (_, index) => new File([`image-${index + 1}`], `image-${index + 1}.png`, { type: "image/png" }));
    fireEvent.paste(terminal, {
      clipboardData: {
        files,
        items: [],
        getData: () => ""
      }
    });

    await openPhotoPreviews(12);
    await waitFor(() => expect(screen.getAllByRole("button", { name: /Open image/i })).toHaveLength(12));
    expect(apiMock.uploadCliFiles).toHaveBeenCalledTimes(2);
    expect((apiMock.uploadCliFiles.mock.calls[0]?.[0] as { files: File[] }).files).toHaveLength(8);
    expect((apiMock.uploadCliFiles.mock.calls[1]?.[0] as { files: File[] }).files).toHaveLength(4);
    expect(screen.getByRole("button", { name: "Open image 12" })).toBeTruthy();
    expect(
      MockWebSocket.instances[0]?.sent
        .map((frame) => JSON.parse(frame) as { data?: string })
        .filter((frame) => frame.data?.startsWith("\u001b[200~") && frame.data.endsWith("\u001b[201~"))
    ).toHaveLength(12);
  });

  it("uses the configured preview page size while keeping older uploaded previews", async () => {
    render(<TerminalPane pane={cliPane()} terminalFontSize={12} maxImagePreviews={4} />);

    await waitFor(() => expect(apiMock.createCliSession).toHaveBeenCalled());
    await waitFor(() => expect(MockWebSocket.instances[0]?.readyState).toBe(MockWebSocket.OPEN));

    const terminal = await screen.findByLabelText("CLI pane Codex CLI");
    const files = Array.from({ length: 6 }, (_, index) => new File([`image-${index + 1}`], `image-${index + 1}.png`, { type: "image/png" }));
    fireEvent.paste(terminal, {
      clipboardData: {
        files,
        items: [],
        getData: () => ""
      }
    });

    // Since 25c872523d every upload is retained; the limit pages the visible previews.
    await openPhotoPreviews(6);
    await waitFor(() => expect(screen.getAllByRole("button", { name: /Open image/i })).toHaveLength(4));
    expect(screen.queryByTitle("Image 1: image-1.png")).toBeNull();
    expect(screen.queryByTitle("Image 2: image-2.png")).toBeNull();
    expect(screen.getByTitle("Image 6: image-6.png")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Earlier photos" }));
    expect(screen.getByTitle("Image 1: image-1.png")).toBeTruthy();
    expect(screen.getByTitle("Image 2: image-2.png")).toBeTruthy();
  });

  it("seeds system transcript lines into the live terminal before Codex emits stdout", async () => {
    apiMock.createCliSession.mockResolvedValueOnce(
      cliSessionResponse("terminal-ws-ticket-test-value-seeded", "IDLE", true, {
        transcript: [
          {
            chunkId: "cli_chunk:system-seed",
            sessionId: "cli_session:test-upload",
            paneId: "pane:cli-upload",
            roomId: "room:cli-upload",
            sequence: 0,
            stream: "system",
            content: "Codex CLI session allocated by Space.",
            byteLength: 37,
            createdAt: "2026-07-05T00:00:00.000Z"
          }
        ]
      })
    );

    render(<TerminalPane pane={cliPane()} terminalFontSize={12} />);

    await waitFor(() => expect(apiMock.createCliSession).toHaveBeenCalled());
    await waitFor(() => expect(MockWebSocket.instances[0]?.readyState).toBe(MockWebSocket.OPEN));
    expect(
      xtermMock.instances[0]?.writes.join("").match(/Codex CLI session allocated by Space\./g)
    ).toHaveLength(1);
  });

  it("does not mix a local allocation status into the live PTY output stream", async () => {
    MockWebSocket.autoRunningStatus = false;
    const session = cliSessionResponse("terminal-ws-ticket-pty-output-only", "IDLE", true);
    session.session.statusReason = "CLI session allocated; waiting for terminal transport attach.";
    apiMock.createCliSession.mockResolvedValueOnce(session);

    render(<TerminalPane pane={cliPane()} terminalFontSize={12} />);

    await waitFor(() => expect(apiMock.createCliSession).toHaveBeenCalled());
    await waitFor(() => expect(MockWebSocket.instances[0]?.readyState).toBe(MockWebSocket.OPEN));
    const socket = MockWebSocket.instances[0]!;
    const inlineTuiOutput = "\u001b[2K\r> test";

    act(() => {
      socket.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({ type: "output", stream: "stdout", data: inlineTuiOutput })
        })
      );
      socket.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({
            type: "status",
            status: "RUNNING",
            statusReason: "Attached to CLI process.",
            replayContinuity: "COMPLETE"
          })
        })
      );
    });

    await waitFor(() => expect(xtermMock.instances[0]?.writes.join("")).toBe(inlineTuiOutput));
  });

  it("scrolls the xterm viewport when dragging vertically on the live CLI pane", async () => {
    render(<TerminalPane pane={cliPane()} terminalFontSize={12} />);

    await waitFor(() => expect(apiMock.createCliSession).toHaveBeenCalled());
    await waitFor(() => expect(MockWebSocket.instances[0]?.readyState).toBe(MockWebSocket.OPEN));
    const host = await screen.findByLabelText("Live CLI pane Codex CLI");
    const viewport = document.createElement("div");
    viewport.className = "xterm-viewport";
    Object.defineProperty(viewport, "clientHeight", { configurable: true, value: 240 });
    Object.defineProperty(viewport, "scrollHeight", { configurable: true, value: 1200 });
    viewport.scrollTop = 20;
    // Since 4929df96f9 touch drags scroll xterm's scrollback, never the native viewport element.
    const terminal = xtermMock.instances[0]!;
    terminal.viewportY = 4;
    terminal.baseY = 100;
    host.appendChild(viewport);

    const touchStart = new Event("touchstart", { bubbles: true, cancelable: true });
    Object.defineProperty(touchStart, "touches", { configurable: true, value: [{ clientX: 100, clientY: 500 }] });
    host.dispatchEvent(touchStart);

    const touchMove = new Event("touchmove", { bubbles: true, cancelable: true });
    Object.defineProperty(touchMove, "touches", { configurable: true, value: [{ clientX: 100, clientY: 380 }] });
    const defaultAllowed = host.dispatchEvent(touchMove);

    expect(terminal.scrollLinesCalls).toEqual([7]);
    expect(terminal.viewportY).toBe(11);
    expect(viewport.scrollTop).toBe(20);
    expect(defaultAllowed).toBe(false);
    expect(touchMove.defaultPrevented).toBe(true);
  });

  it("falls back to xterm scrollback when the live CLI viewport has no native scroll range", async () => {
    render(<TerminalPane pane={cliPane()} terminalFontSize={12} />);

    await waitFor(() => expect(apiMock.createCliSession).toHaveBeenCalled());
    await waitFor(() => expect(MockWebSocket.instances[0]?.readyState).toBe(MockWebSocket.OPEN));
    const host = await screen.findByLabelText("Live CLI pane Codex CLI");
    const viewport = document.createElement("div");
    viewport.className = "xterm-viewport";
    Object.defineProperty(viewport, "clientHeight", { configurable: true, value: 240 });
    Object.defineProperty(viewport, "scrollHeight", { configurable: true, value: 240 });
    host.appendChild(viewport);
    const terminal = xtermMock.instances[0];
    expect(terminal).toBeTruthy();
    terminal!.viewportY = 4;
    terminal!.baseY = 20;

    const touchStart = new Event("touchstart", { bubbles: true, cancelable: true });
    Object.defineProperty(touchStart, "touches", { configurable: true, value: [{ clientX: 100, clientY: 500 }] });
    host.dispatchEvent(touchStart);

    const touchMove = new Event("touchmove", { bubbles: true, cancelable: true });
    Object.defineProperty(touchMove, "touches", { configurable: true, value: [{ clientX: 100, clientY: 440 }] });
    const defaultAllowed = host.dispatchEvent(touchMove);

    expect(terminal!.scrollLinesCalls[0]).toBeGreaterThan(0);
    expect(terminal!.viewportY).toBeGreaterThan(4);
    expect(defaultAllowed).toBe(false);
    expect(touchMove.defaultPrevented).toBe(true);
  });

  it("waits for websocket replay instead of duplicating running stdout transcript", async () => {
    apiMock.createCliSession.mockResolvedValueOnce(
      cliSessionResponse("terminal-ws-ticket-test-value-running", "RUNNING", true, {
        transcript: [
          {
            chunkId: "cli_chunk:running-stdout",
            sessionId: "cli_session:test-upload",
            paneId: "pane:cli-upload",
            roomId: "room:cli-upload",
            sequence: 0,
            stream: "stdout",
            content: "historic output\n",
            byteLength: 16,
            createdAt: "2026-07-05T00:00:00.000Z"
          }
        ]
      })
    );

    render(<TerminalPane pane={cliPane()} terminalFontSize={12} />);

    await waitFor(() => expect(apiMock.createCliSession).toHaveBeenCalled());
    await waitFor(() => expect(MockWebSocket.instances[0]?.readyState).toBe(MockWebSocket.OPEN));
    expect(xtermMock.instances[0]?.writes.join("")).not.toContain("historic output");

    MockWebSocket.instances[0]?.dispatchEvent(
      new MessageEvent("message", {
        data: JSON.stringify({ type: "output", stream: "stdout", data: "historic output\n" })
      })
    );

    await waitFor(() => expect(xtermMock.instances[0]?.writes.join("")).toContain("historic output"));
    expect(xtermMock.instances[0]?.writes.join("").match(/historic output/g)?.length).toBe(1);
  });

  it("labels video and file uploads separately and injects their hidden paths only on native Enter", async () => {
    window.localStorage.setItem("space.clipboardDebug", "true");
    render(<TerminalPane pane={cliPane()} terminalFontSize={12} />);

    await waitFor(() => expect(apiMock.createCliSession).toHaveBeenCalled());
    await waitFor(() => expect(MockWebSocket.instances[0]?.readyState).toBe(MockWebSocket.OPEN));

    const input = document.querySelector<HTMLInputElement>('input[type="file"]');
    expect(input).toBeTruthy();
    const video = new File(["video"], "recording.mp4", { type: "video/mp4" });
    const file = new File(["document"], "notes.pdf", { type: "application/pdf" });
    fireEvent.change(input!, { target: { files: [video, file] } });

    await waitFor(() =>
      expect(apiMock.uploadCliFiles).toHaveBeenCalledWith({
        paneId: "pane:cli-upload",
        source: "USER_UPLOAD",
        files: [video, file]
      })
    );
    const socket = MockWebSocket.instances[0]!;
    await waitFor(() =>
      expect(socket.sent).toContain(JSON.stringify({ type: "input", data: "[Video #1] [File #1] " }))
    );

    const terminal = screen.getByLabelText("CLI pane Codex CLI");
    const droppedVideo = new File(["drop-video"], "dropped.webm", { type: "video/webm" });
    fireEvent.drop(terminal, {
      dataTransfer: {
        files: [droppedVideo],
        getData: () => ""
      }
    });
    await waitFor(() =>
      expect(apiMock.uploadCliFiles).toHaveBeenCalledWith({
        paneId: "pane:cli-upload",
        source: "DROP",
        files: [droppedVideo]
      })
    );
    await waitFor(() =>
      expect(socket.sent).toContain(JSON.stringify({ type: "input", data: "[Video #2] " }))
    );

    const pastedFile = new File(["paste-file"], "pasted.csv", { type: "text/csv" });
    fireEvent.paste(terminal, {
      clipboardData: {
        files: [pastedFile],
        items: [],
        getData: () => ""
      }
    });
    await waitFor(() =>
      expect(apiMock.uploadCliFiles).toHaveBeenCalledWith({
        paneId: "pane:cli-upload",
        source: "CLIPBOARD",
        files: [pastedFile]
      })
    );
    await waitFor(() =>
      expect(socket.sent).toContain(JSON.stringify({ type: "input", data: "[File #2] " }))
    );

    expect(socket.sent.some((frame) => frame.includes("/opt/spaceapp/var/artifacts/cli-uploads/"))).toBe(false);
    expect(xtermMock.instances).toHaveLength(1);
    expect(screen.queryByRole("button", { name: /^Photos \(/ })).toBeNull();
    expect(screen.queryByLabelText("CLI image uploads Codex CLI")).toBeNull();
    expect(screen.queryByText("recording.mp4")).toBeNull();

    act(() => xtermMock.instances[0]?.emitData("\r"));

    const hiddenPaths = {
      type: "input",
      data:
        " '/opt/spaceapp/var/artifacts/cli-uploads/recording.mp4' " +
        "'/opt/spaceapp/var/artifacts/cli-uploads/notes.pdf' " +
        "'/opt/spaceapp/var/artifacts/cli-uploads/dropped.webm' " +
        "'/opt/spaceapp/var/artifacts/cli-uploads/pasted.csv' ",
      display: "hidden"
    };
    await waitFor(() => expect(socket.sent).toContain(JSON.stringify(hiddenPaths)));
    const parsedFrames = socket.sent.map((frame) => JSON.parse(frame) as {
      type?: string;
      data?: string;
      display?: string;
      turnMarker?: string;
    });
    const hiddenPathIndex = parsedFrames.findIndex((frame) => frame.data === hiddenPaths.data && frame.display === "hidden");
    const submitIndex = parsedFrames.findIndex((frame) => frame.data === "\r");
    expect(hiddenPathIndex).toBeGreaterThan(-1);
    expect(submitIndex).toBeGreaterThan(hiddenPathIndex);
    expect(parsedFrames[submitIndex]?.turnMarker).toMatch(/^[a-f0-9-]{36}$/);
  });

  it("labels a common video extension as Video when the browser omits its MIME type", async () => {
    render(<TerminalPane pane={cliPane()} terminalFontSize={12} />);

    await waitFor(() => expect(apiMock.createCliSession).toHaveBeenCalled());
    await waitFor(() => expect(MockWebSocket.instances[0]?.readyState).toBe(MockWebSocket.OPEN));
    const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
    const videoWithoutMime = new File(["video"], "recording-without-mime.mp4");
    fireEvent.change(input, { target: { files: [videoWithoutMime] } });

    await waitFor(() =>
      expect(MockWebSocket.instances[0]?.sent).toContain(
        JSON.stringify({ type: "input", data: "[Video #1] " })
      )
    );
  });

  it("labels image uploads as managed [Image #1] prompt tokens in Gemini CLI and resolves paths on submit", async () => {
    apiMock.activeCliSession.mockResolvedValue(cliSessionResponse(
      "terminal-ws-ticket-gemini-native-auth",
      "RUNNING",
      true,
      { sessionId: "cli_session:gemini-native-auth", purpose: "NORMAL", runtimeId: "cli:gemini" }
    ));
    apiMock.cliTerminalWebSocketUrl.mockImplementation(
      (ticket: { paneId: string; sessionId: string }) =>
        `ws://space.test/terminal?paneId=${encodeURIComponent(ticket.paneId)}` +
        `&sessionId=${encodeURIComponent(ticket.sessionId)}&runtimeId=cli%3Agemini` +
        `&protocolVersion=2&clientMode=INTERACTIVE`
    );

    render(
      <VoiceInputProvider>
        <TerminalPane pane={cliPane({ terminalRuntimeId: "cli:gemini" })} terminalFontSize={12} isTarget />
      </VoiceInputProvider>
    );

    await waitFor(() => expect(MockWebSocket.instances[0]?.readyState).toBe(MockWebSocket.OPEN));
    const socket = MockWebSocket.instances[0]!;
    const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
    const screenshot = new File(["fake-image-bytes"], "screenshot.png", { type: "image/png" });
    fireEvent.change(input, { target: { files: [screenshot] } });

    await waitFor(() =>
      expect(socket.sent).toContain(
        JSON.stringify({ type: "input", data: "[Image #1] " })
      )
    );

    expect(socket.sent.some((frame) => frame.includes("\u001b[200~"))).toBe(false);

    act(() => xtermMock.instances[0]?.emitData("\r"));

    await waitFor(() =>
      expect(socket.sent).toContain(
        JSON.stringify({
          type: "input",
          data: " /opt/spaceapp/var/artifacts/cli-uploads/screenshot.png ",
          display: "hidden"
        })
      )
    );
  });

  it("attaches pasted images to the Claude Code prompt through its native bracketed-paste image path", async () => {
    apiMock.activeCliSession.mockResolvedValue(cliSessionResponse(
      "terminal-ws-ticket-claude-image",
      "RUNNING",
      true,
      { sessionId: "cli_session:claude-image", purpose: "NORMAL", runtimeId: "cli:claude" }
    ));
    apiMock.cliTerminalWebSocketUrl.mockImplementation(
      (ticket: { paneId: string; sessionId: string }) =>
        `ws://space.test/terminal?paneId=${encodeURIComponent(ticket.paneId)}` +
        `&sessionId=${encodeURIComponent(ticket.sessionId)}&runtimeId=cli%3Aclaude`
    );
    render(<TerminalPane pane={cliPane({ terminalRuntimeId: "cli:claude" })} terminalFontSize={12} isTarget />);

    await waitFor(() => expect(MockWebSocket.instances[0]?.readyState).toBe(MockWebSocket.OPEN));
    const socket = MockWebSocket.instances[0]!;
    const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
    fireEvent.change(input, { target: { files: [new File(["fake-image-bytes"], "screenshot.png", { type: "image/png" })] } });

    await waitFor(() =>
      expect(socket.sent).toContain(JSON.stringify({
        type: "input",
        data: "\u001b[200~/opt/spaceapp/var/artifacts/cli-uploads/screenshot.png\u001b[201~",
        display: "hidden"
      }))
    );
    // Claude Code renders its own [Image #1] attachment; Space must not type a second, path-less label.
    expect(socket.sent).not.toContain(JSON.stringify({ type: "input", data: "[Image #1] " }));
  });

  async function renderGeminiWithManagedImage() {
    apiMock.activeCliSession.mockResolvedValue(cliSessionResponse(
      "terminal-ws-ticket-gemini-managed",
      "RUNNING",
      true,
      { sessionId: "cli_session:gemini-managed", purpose: "NORMAL", runtimeId: "cli:gemini" }
    ));
    apiMock.cliTerminalWebSocketUrl.mockImplementation(
      (ticket: { paneId: string; sessionId: string }) =>
        `ws://space.test/terminal?paneId=${encodeURIComponent(ticket.paneId)}` +
        `&sessionId=${encodeURIComponent(ticket.sessionId)}&runtimeId=cli%3Agemini` +
        `&protocolVersion=2&clientMode=INTERACTIVE`
    );
    render(
      <VoiceInputProvider>
        <TerminalPane pane={cliPane({ terminalRuntimeId: "cli:gemini" })} terminalFontSize={12} isTarget />
      </VoiceInputProvider>
    );
    await waitFor(() => expect(MockWebSocket.instances[0]?.readyState).toBe(MockWebSocket.OPEN));
    const socket = MockWebSocket.instances[0]!;
    const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
    fireEvent.change(input, { target: { files: [new File(["fake-image-bytes"], "screenshot.png", { type: "image/png" })] } });
    await waitFor(() => expect(socket.sent).toContain(JSON.stringify({ type: "input", data: "[Image #1] " })));
    return socket;
  }

  const hiddenScreenshotPath = JSON.stringify({
    type: "input",
    data: " /opt/spaceapp/var/artifacts/cli-uploads/screenshot.png ",
    display: "hidden"
  });

  it("keeps a managed attachment path when the prompt receives keys the draft model cannot follow", async () => {
    const socket = await renderGeminiWithManagedImage();
    act(() => xtermMock.instances[0]?.emitData("\u001b[A"));
    act(() => xtermMock.instances[0]?.emitData("\t"));
    xtermMock.instances[0]!.screenText = "> [Image #1] describe this\n  wrapped";
    act(() => xtermMock.instances[0]?.emitData("\r"));
    await waitFor(() => expect(socket.sent).toContain(hiddenScreenshotPath));
  });

  it("keeps a managed attachment path when mouse reports arrive before a typo is corrected", async () => {
    const socket = await renderGeminiWithManagedImage();
    act(() => xtermMock.instances[0]?.emitData("\u001b[<35;10;5M"));
    act(() => xtermMock.instances[0]?.emitData("x"));
    act(() => xtermMock.instances[0]?.emitData("\u007f"));
    act(() => xtermMock.instances[0]?.emitData("\u001b[<0;10;5M\u001b[<0;10;5m"));
    act(() => xtermMock.instances[0]?.emitData("\r"));
    await waitFor(() => expect(socket.sent).toContain(hiddenScreenshotPath));
  });

  it("keeps managed labels that a Ctrl+U prompt rewrite retypes", async () => {
    const socket = await renderGeminiWithManagedImage();
    act(() => xtermMock.instances[0]?.emitData("\u0015[Image #1] rewritten prompt"));
    act(() => xtermMock.instances[0]?.emitData("\r"));
    await waitFor(() => expect(socket.sent).toContain(hiddenScreenshotPath));
  });

  it("resolves managed attachment paths through floating Send and restarts numbering after submit", async () => {
    render(<TerminalPane pane={cliPane()} terminalFontSize={12} />);

    await waitFor(() => expect(apiMock.createCliSession).toHaveBeenCalled());
    await waitFor(() => expect(MockWebSocket.instances[0]?.readyState).toBe(MockWebSocket.OPEN));
    const socket = MockWebSocket.instances[0]!;
    const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
    const firstFile = new File(["first"], "first.txt", { type: "text/plain" });
    fireEvent.change(input, { target: { files: [firstFile] } });

    const fileTokenFrame = JSON.stringify({ type: "input", data: "[File #1] " });
    await waitFor(() => expect(socket.sent).toContain(fileTokenFrame));
    fireEvent.click(await screen.findByRole("button", { name: "Send prompt" }));

    const firstHiddenPath = JSON.stringify({
      type: "input",
      data: " '/opt/spaceapp/var/artifacts/cli-uploads/first.txt' ",
      display: "hidden"
    });
    await waitFor(() => expect(socket.sent).toContain(firstHiddenPath));
    expect(
      socket.sent
        .map((frame) => JSON.parse(frame) as { data?: string; turnMarker?: string })
        .some((frame) => frame.data === "\r" && /^[a-f0-9-]{36}$/.test(frame.turnMarker ?? ""))
    ).toBe(true);

    const secondFile = new File(["second"], "second.txt", { type: "text/plain" });
    fireEvent.change(input, { target: { files: [secondFile] } });
    await waitFor(() => expect(apiMock.uploadCliFiles).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(socket.sent.filter((frame) => frame === fileTokenFrame)).toHaveLength(2));
  });

  it("preserves managed tokens across non-mutating terminal capability replies", async () => {
    render(<TerminalPane pane={cliPane()} terminalFontSize={12} />);

    await waitFor(() => expect(apiMock.createCliSession).toHaveBeenCalled());
    await waitFor(() => expect(MockWebSocket.instances[0]?.readyState).toBe(MockWebSocket.OPEN));
    const socket = MockWebSocket.instances[0]!;
    const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
    const file = new File(["protocol"], "terminal-replies.txt", { type: "text/plain" });
    fireEvent.change(input, { target: { files: [file] } });
    await waitFor(() =>
      expect(socket.sent).toContain(JSON.stringify({ type: "input", data: "[File #1] " }))
    );

    const protocolReplies = [
      "\u001b[2;15R",
      "\u001b]10;rgb:e8e8/e3e3/d8d8\u001b\\",
      "\u001b]11;rgb:0909/0b0b/0c0c\u001b\\",
      "\u001b[?1;2c",
      "\u001b[?1;2c\u001b]11;rgb:0909/0b0b/0c0c\u001b\\"
    ];
    act(() => {
      for (const response of protocolReplies) xtermMock.instances[0]?.emitData(response);
    });

    const protocolFrames = socket.sent
      .map((frame) => JSON.parse(frame) as { type: string; data?: string; display?: string })
      .filter((frame) => frame.type === "input" && protocolReplies.includes(frame.data ?? ""));
    expect(protocolFrames).toEqual(protocolReplies.map((data) => ({
      type: "input",
      data,
      display: "hidden"
    })));

    const sendButton = await screen.findByRole("button", { name: "Send prompt" });
    expect((sendButton as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(sendButton);
    await waitFor(() =>
      expect(socket.sent).toContain(JSON.stringify({
        type: "input",
        data: " '/opt/spaceapp/var/artifacts/cli-uploads/terminal-replies.txt' ",
        display: "hidden"
      }))
    );
  });

  it("keeps fragmented protocol replies hidden while preserving mixed user text in the draft", async () => {
    render(<TerminalPane pane={cliPane()} terminalFontSize={12} />);

    await waitFor(() => expect(apiMock.createCliSession).toHaveBeenCalled());
    await waitFor(() => expect(MockWebSocket.instances[0]?.readyState).toBe(MockWebSocket.OPEN));
    const socket = MockWebSocket.instances[0]!;
    const sentBefore = socket.sent.length;

    act(() => {
      xtermMock.instances[0]?.emitData("\u001b[?1;");
      xtermMock.instances[0]?.emitData("2cte\u001b]11;rgb:0909/");
      xtermMock.instances[0]?.emitData("0b0b/0c0c\u001b\\st");
    });

    await waitFor(() => {
      const inputFrames = socket.sent
        .slice(sentBefore)
        .map((frame) => JSON.parse(frame) as { type?: string; data?: string; display?: string })
        .filter((frame) => frame.type === "input");
      expect(inputFrames).toEqual([
        { type: "input", data: "\u001b[?1;2c", display: "hidden" },
        { type: "input", data: "te" },
        { type: "input", data: "\u001b]11;rgb:0909/0b0b/0c0c\u001b\\", display: "hidden" },
        { type: "input", data: "st" }
      ]);
    });

    const visibleInput = socket.sent
      .slice(sentBefore)
      .map((frame) => JSON.parse(frame) as { type?: string; data?: string; display?: string })
      .filter((frame) => frame.type === "input" && frame.display !== "hidden")
      .map((frame) => frame.data)
      .join("");
    expect(visibleInput).toBe("test");
    expect(visibleInput).not.toContain("\u001b");
    expect((await screen.findByRole("button", { name: "Send prompt" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("drops NUL keyboard bytes before sending Codex terminal input", async () => {
    render(<TerminalPane pane={cliPane()} terminalFontSize={12} />);

    await waitFor(() => expect(apiMock.createCliSession).toHaveBeenCalled());
    await waitFor(() => expect(MockWebSocket.instances[0]?.readyState).toBe(MockWebSocket.OPEN));
    const socket = MockWebSocket.instances[0]!;
    const sentBefore = socket.sent.length;

    act(() => {
      xtermMock.instances[0]?.emitData("\0");
      xtermMock.instances[0]?.emitData("before\0after");
    });

    await waitFor(() => {
      const inputFrames = socket.sent
        .slice(sentBefore)
        .map((frame) => JSON.parse(frame) as { type?: string; data?: string })
        .filter((frame) => frame.type === "input");
      expect(inputFrames).toEqual([{ type: "input", data: "beforeafter" }]);
    });
    expect(socket.readyState).toBe(MockWebSocket.OPEN);
  });

  it("omits a managed path when its exact token was edited before submit", async () => {
    render(<TerminalPane pane={cliPane()} terminalFontSize={12} />);

    await waitFor(() => expect(apiMock.createCliSession).toHaveBeenCalled());
    await waitFor(() => expect(MockWebSocket.instances[0]?.readyState).toBe(MockWebSocket.OPEN));
    const socket = MockWebSocket.instances[0]!;
    const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
    const file = new File(["draft"], "edited-token.txt", { type: "text/plain" });
    fireEvent.change(input, { target: { files: [file] } });
    await waitFor(() =>
      expect(socket.sent).toContain(JSON.stringify({ type: "input", data: "[File #1] " }))
    );

    act(() => {
      xtermMock.instances[0]?.emitData("\b\b");
      xtermMock.instances[0]?.emitData(" send without attachment");
      xtermMock.instances[0]?.emitData("\r");
    });

    await waitFor(() =>
      expect(socket.sent.map((frame) => JSON.parse(frame) as { data?: string }).some((frame) => frame.data === "\r")).toBe(true)
    );
    expect(socket.sent.some((frame) => frame.includes("edited-token.txt"))).toBe(false);
  });

  it("omits a managed path when cursor-based editing changes its exact token before submit", async () => {
    render(<TerminalPane pane={cliPane()} terminalFontSize={12} />);

    await waitFor(() => expect(apiMock.createCliSession).toHaveBeenCalled());
    await waitFor(() => expect(MockWebSocket.instances[0]?.readyState).toBe(MockWebSocket.OPEN));
    const socket = MockWebSocket.instances[0]!;
    const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
    const file = new File(["draft"], "cursor-edited-token.txt", { type: "text/plain" });
    fireEvent.change(input, { target: { files: [file] } });
    await waitFor(() =>
      expect(socket.sent).toContain(JSON.stringify({ type: "input", data: "[File #1] " }))
    );

    act(() => {
      xtermMock.instances[0]?.emitData("\u001b[H");
      xtermMock.instances[0]?.emitData("\u001b[3~");
      xtermMock.instances[0]?.emitData("\r");
    });

    await waitFor(() =>
      expect(socket.sent.map((frame) => JSON.parse(frame) as { data?: string }).some((frame) => frame.data === "\r")).toBe(true)
    );
    expect(socket.sent.some((frame) => frame.includes("cursor-edited-token.txt"))).toBe(false);
  });

  it("tracks Home, End, Left, Right and Delete while resolving exact managed tokens", async () => {
    render(<TerminalPane pane={cliPane()} terminalFontSize={12} />);

    await waitFor(() => expect(apiMock.createCliSession).toHaveBeenCalled());
    await waitFor(() => expect(MockWebSocket.instances[0]?.readyState).toBe(MockWebSocket.OPEN));
    const socket = MockWebSocket.instances[0]!;
    const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
    const file = new File(["draft"], "cursor-movement-token.txt", { type: "text/plain" });
    fireEvent.change(input, { target: { files: [file] } });
    await waitFor(() =>
      expect(socket.sent).toContain(JSON.stringify({ type: "input", data: "[File #1] " }))
    );

    act(() => {
      xtermMock.instances[0]?.emitData("\u001b[H");
      xtermMock.instances[0]?.emitData("\u001b[C");
      xtermMock.instances[0]?.emitData("\u001b[3~");
      xtermMock.instances[0]?.emitData("\u001b[F");
      xtermMock.instances[0]?.emitData("\u001b[D");
      xtermMock.instances[0]?.emitData("x");
      xtermMock.instances[0]?.emitData("\r");
    });

    await waitFor(() =>
      expect(socket.sent.map((frame) => JSON.parse(frame) as { data?: string }).some((frame) => frame.data === "\r")).toBe(true)
    );
    expect(socket.sent.some((frame) => frame.includes("cursor-movement-token.txt"))).toBe(false);
  });

  it("fails closed for an unknown prompt-mutating control sequence", async () => {
    render(<TerminalPane pane={cliPane()} terminalFontSize={12} />);

    await waitFor(() => expect(apiMock.createCliSession).toHaveBeenCalled());
    await waitFor(() => expect(MockWebSocket.instances[0]?.readyState).toBe(MockWebSocket.OPEN));
    const socket = MockWebSocket.instances[0]!;
    const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
    const file = new File(["draft"], "unknown-control-token.txt", { type: "text/plain" });
    fireEvent.change(input, { target: { files: [file] } });
    await waitFor(() =>
      expect(socket.sent).toContain(JSON.stringify({ type: "input", data: "[File #1] " }))
    );

    act(() => {
      xtermMock.instances[0]?.emitData("\u001b[A");
      xtermMock.instances[0]?.emitData("\r");
    });

    await waitFor(() =>
      expect(socket.sent.map((frame) => JSON.parse(frame) as { data?: string }).some((frame) => frame.data === "\r")).toBe(true)
    );
    expect(socket.sent.some((frame) => frame.includes("unknown-control-token.txt"))).toBe(false);
  });

  it("drops stale paths but keeps numbering monotonic after unknown prompt mutation", async () => {
    render(<TerminalPane pane={cliPane()} terminalFontSize={12} />);

    await waitFor(() => expect(apiMock.createCliSession).toHaveBeenCalled());
    await waitFor(() => expect(MockWebSocket.instances[0]?.readyState).toBe(MockWebSocket.OPEN));
    const socket = MockWebSocket.instances[0]!;
    const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
    fireEvent.change(input, {
      target: { files: [new File(["old"], "stale-unknown-control.txt", { type: "text/plain" })] }
    });
    await waitFor(() =>
      expect(socket.sent).toContain(JSON.stringify({ type: "input", data: "[File #1] " }))
    );

    act(() => xtermMock.instances[0]?.emitData("\u001b[A"));
    fireEvent.change(input, {
      target: { files: [new File(["new"], "fresh-after-unknown-control.txt", { type: "text/plain" })] }
    });
    await waitFor(() =>
      expect(socket.sent).toContain(JSON.stringify({ type: "input", data: "[File #2] " }))
    );

    act(() => xtermMock.instances[0]?.emitData("\r"));
    await waitFor(() =>
      expect(socket.sent).toContain(JSON.stringify({
        type: "input",
        data: " '/opt/spaceapp/var/artifacts/cli-uploads/fresh-after-unknown-control.txt' ",
        display: "hidden"
      }))
    );
    expect(socket.sent.some((frame) => frame.includes("stale-unknown-control.txt"))).toBe(false);
  });

  it("retains a managed path when supported cursor movement leaves its token unchanged", async () => {
    render(<TerminalPane pane={cliPane()} terminalFontSize={12} />);

    await waitFor(() => expect(apiMock.createCliSession).toHaveBeenCalled());
    await waitFor(() => expect(MockWebSocket.instances[0]?.readyState).toBe(MockWebSocket.OPEN));
    const socket = MockWebSocket.instances[0]!;
    const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
    const file = new File(["draft"], "unchanged-cursor-token.txt", { type: "text/plain" });
    fireEvent.change(input, { target: { files: [file] } });
    await waitFor(() =>
      expect(socket.sent).toContain(JSON.stringify({ type: "input", data: "[File #1] " }))
    );

    act(() => {
      xtermMock.instances[0]?.emitData("\u001b[H");
      xtermMock.instances[0]?.emitData("\u001b[C");
      xtermMock.instances[0]?.emitData("\u001b[D");
      xtermMock.instances[0]?.emitData("\u001b[F");
      xtermMock.instances[0]?.emitData("\u001bOH");
      xtermMock.instances[0]?.emitData("\u001bOC");
      xtermMock.instances[0]?.emitData("\u001bOD");
      xtermMock.instances[0]?.emitData("\u001bOF");
      xtermMock.instances[0]?.emitData("\r");
    });

    await waitFor(() =>
      expect(socket.sent).toContain(JSON.stringify({
        type: "input",
        data: " '/opt/spaceapp/var/artifacts/cli-uploads/unchanged-cursor-token.txt' ",
        display: "hidden"
      }))
    );
  });

  it("clears pending paths and restarts numbering when the CLI prompt is cleared", async () => {
    render(<TerminalPane pane={cliPane()} terminalFontSize={12} />);

    await waitFor(() => expect(apiMock.createCliSession).toHaveBeenCalled());
    await waitFor(() => expect(MockWebSocket.instances[0]?.readyState).toBe(MockWebSocket.OPEN));
    const socket = MockWebSocket.instances[0]!;
    const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
    const discardedFile = new File(["discarded"], "discarded.txt", { type: "text/plain" });
    fireEvent.change(input, { target: { files: [discardedFile] } });
    const fileTokenFrame = JSON.stringify({ type: "input", data: "[File #1] " });
    await waitFor(() => expect(socket.sent).toContain(fileTokenFrame));

    act(() => xtermMock.instances[0]?.emitData("\u0015"));

    const retainedFile = new File(["retained"], "retained.txt", { type: "text/plain" });
    fireEvent.change(input, { target: { files: [retainedFile] } });
    await waitFor(() => expect(apiMock.uploadCliFiles).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(socket.sent.filter((frame) => frame === fileTokenFrame)).toHaveLength(2));

    act(() => xtermMock.instances[0]?.emitData("\r"));
    await waitFor(() =>
      expect(socket.sent).toContain(JSON.stringify({
        type: "input",
        data: " '/opt/spaceapp/var/artifacts/cli-uploads/retained.txt' ",
        display: "hidden"
      }))
    );
    expect(socket.sent.some((frame) => frame.includes("/discarded.txt"))).toBe(false);
  });

  it("clears pending paths and counters when the CLI session is replaced", async () => {
    render(<TerminalPane pane={cliPane()} terminalFontSize={12} />);

    await waitFor(() => expect(apiMock.createCliSession).toHaveBeenCalled());
    await waitFor(() => expect(MockWebSocket.instances[0]?.readyState).toBe(MockWebSocket.OPEN));
    const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
    fireEvent.change(input, {
      target: { files: [new File(["old"], "old-session.txt", { type: "text/plain" })] }
    });
    await waitFor(() =>
      expect(MockWebSocket.instances[0]?.sent).toContain(
        JSON.stringify({ type: "input", data: "[File #1] " })
      )
    );

    const replacement = cliSessionResponse("terminal-ws-ticket-replacement", "IDLE", true, {
      sessionId: "cli_session:replacement"
    });
    act(() => {
      window.dispatchEvent(new CustomEvent("space:terminal-pane-action", {
        detail: {
          paneId: "pane:cli-upload",
          action: "replace_session",
          session: replacement
        }
      }));
    });

    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(2));
    await waitFor(() => expect(MockWebSocket.instances[1]?.readyState).toBe(MockWebSocket.OPEN));
    const replacementInput = document.querySelector<HTMLInputElement>('input[type="file"]')!;
    fireEvent.change(replacementInput, {
      target: { files: [new File(["new"], "new-session.txt", { type: "text/plain" })] }
    });
    await waitFor(() =>
      expect(MockWebSocket.instances[1]?.sent).toContain(
        JSON.stringify({ type: "input", data: "[File #1] " })
      )
    );
    expect(MockWebSocket.instances[1]?.sent.some((frame) => frame.includes("old-session.txt"))).toBe(false);
  });

  it("dedupes duplicate clipboard file entries from the same native paste", async () => {
    render(<TerminalPane pane={cliPane()} terminalFontSize={12} />);

    await waitFor(() => expect(apiMock.createCliSession).toHaveBeenCalled());
    await waitFor(() => expect(MockWebSocket.instances[0]?.readyState).toBe(MockWebSocket.OPEN));

    const terminal = await screen.findByLabelText("CLI pane Codex CLI");
    const firstFile = new File(["same"], "image.png", { type: "image/png", lastModified: 1 });
    const duplicateFile = new File(["same"], "image.png", { type: "image/png", lastModified: 2 });
    fireEvent.paste(terminal, {
      clipboardData: {
        files: [firstFile],
        items: [{ kind: "file", getAsFile: () => duplicateFile }],
        getData: () => ""
      }
    });

    await waitFor(() => expect(apiMock.uploadCliFiles).toHaveBeenCalledTimes(1));
    const uploadInput = apiMock.uploadCliFiles.mock.calls[0]?.[0] as { files: File[] };
    expect(uploadInput.files).toHaveLength(1);
    expect(uploadInput.files[0]?.name).toBe("image.png");
    await openPhotoPreviews(1);
    expect(screen.getAllByRole("button", { name: /Open image/i })).toHaveLength(1);
    expect(screen.queryByText("image.png")).toBeNull();
  });

  it("keeps one preview after the first paste, accumulates a second preview on the next paste, and allows removing each image", async () => {
    render(<TerminalPane pane={cliPane()} terminalFontSize={12} />);

    await waitFor(() => expect(apiMock.createCliSession).toHaveBeenCalled());
    await waitFor(() => expect(MockWebSocket.instances[0]?.readyState).toBe(MockWebSocket.OPEN));

    const terminal = await screen.findByLabelText("CLI pane Codex CLI");
    const firstFile = new File(["first"], "first.png", { type: "image/png" });
    fireEvent.paste(terminal, {
      clipboardData: {
        files: [],
        items: [{ kind: "file", getAsFile: () => firstFile }],
        getData: () => ""
      }
    });

    await openPhotoPreviews(1);
    await waitFor(() => expect(screen.getAllByRole("button", { name: /Open image/i })).toHaveLength(1));
    expect(screen.getByRole("button", { name: "Open image 1" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Delete image 1" })).toBeTruthy();
    expect(screen.getByTitle("Image 1: first.png")).toBeTruthy();
    expect(screen.queryByText("first.png")).toBeNull();

    const secondFile = new File(["second"], "second.png", { type: "image/png" });
    fireEvent.paste(terminal, {
      clipboardData: {
        files: [],
        items: [{ kind: "file", getAsFile: () => secondFile }],
        getData: () => ""
      }
    });

    await openPhotoPreviews(2);
    expect(screen.getAllByRole("button", { name: /Open image/i })).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Open image 1" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open image 2" })).toBeTruthy();
    expect(screen.getAllByRole("button", { name: /Delete image/i })).toHaveLength(2);
    expect(screen.getByTitle("Image 1: first.png")).toBeTruthy();
    expect(screen.getByTitle("Image 2: second.png")).toBeTruthy();
    expect(screen.queryByText("first.png")).toBeNull();
    expect(screen.queryByText("second.png")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Delete image 1" }));
    await waitFor(() => expect(screen.getAllByRole("button", { name: /Open image/i })).toHaveLength(1));
    expect(screen.queryByTitle("Image 1: first.png")).toBeNull();
    expect(screen.getByTitle("Image 1: second.png")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open image 1" })).toBeTruthy();
  });

  it("clears all terminal image previews at once", async () => {
    render(<TerminalPane pane={cliPane()} terminalFontSize={12} />);

    await waitFor(() => expect(apiMock.createCliSession).toHaveBeenCalled());
    await waitFor(() => expect(MockWebSocket.instances[0]?.readyState).toBe(MockWebSocket.OPEN));

    const terminal = await screen.findByLabelText("CLI pane Codex CLI");
    const firstFile = new File(["first"], "first.png", { type: "image/png" });
    const secondFile = new File(["second"], "second.png", { type: "image/png" });
    fireEvent.paste(terminal, {
      clipboardData: {
        files: [],
        items: [{ kind: "file", getAsFile: () => firstFile }],
        getData: () => ""
      }
    });
    fireEvent.paste(terminal, {
      clipboardData: {
        files: [],
        items: [{ kind: "file", getAsFile: () => secondFile }],
        getData: () => ""
      }
    });

    await openPhotoPreviews(2);
    await waitFor(() => expect(screen.getAllByRole("button", { name: /Open image/i })).toHaveLength(2));
    expect(screen.queryByText("Clear all")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss all images Codex CLI" }));

    await waitFor(() => expect(screen.queryByRole("button", { name: /Open image 1/i })).toBeNull());
    expect(screen.queryByRole("button", { name: /Open image 2/i })).toBeNull();
    expect(screen.queryByLabelText("CLI image uploads Codex CLI")).toBeNull();
    // Since 0826067e05 this notice is not rendered; the Photos trigger disappears instead.
    expect(screen.queryByRole("button", { name: /^Photos \(/ })).toBeNull();
    expect(apiMock.deleteArtifact).toHaveBeenCalledTimes(2);
    expect(apiMock.deleteArtifact).toHaveBeenCalledWith("artifact:test-upload:1:1");
    expect(apiMock.deleteArtifact).toHaveBeenCalledWith("artifact:test-upload:2:1");
  });

  it("portals the image modal to the body, traps focus, closes safely, and restores thumbnail focus", async () => {
    render(<TerminalPane pane={cliPane()} terminalFontSize={12} />);

    await waitFor(() => expect(apiMock.createCliSession).toHaveBeenCalled());
    await waitFor(() => expect(MockWebSocket.instances[0]?.readyState).toBe(MockWebSocket.OPEN));

    const terminal = await screen.findByLabelText("CLI pane Codex CLI");
    const file = new File(["preview"], "preview.png", { type: "image/png" });
    fireEvent.paste(terminal, {
      clipboardData: {
        files: [],
        items: [{ kind: "file", getAsFile: () => file }],
        getData: () => ""
      }
    });

    await openPhotoPreviews(1);
    const openPreview = await screen.findByRole("button", { name: "Open image 1" });
    fireEvent.click(openPreview);

    const dialog = screen.getByRole("dialog", { name: "Image 1 preview" });
    const closeButton = within(dialog).getByRole("button", { name: "Close image preview" });
    expect(dialog.parentElement).toBe(document.body);
    expect(within(dialog).getByRole("img", { name: "Image 1 full size" })).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(closeButton));

    const deletePhoto = within(dialog).getByRole("button", { name: "Delete photo" });
    // Delete comes first and Close last in the viewer toolbar: Tab wraps from Close, Shift+Tab from Delete.
    fireEvent.keyDown(closeButton, { key: "Tab" });
    expect(document.activeElement).toBe(deletePhoto);
    fireEvent.keyDown(deletePhoto, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(closeButton);
    fireEvent.keyDown(closeButton, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Image 1 preview" })).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(openPreview));
    expect(MockWebSocket.instances[0]?.sent).not.toContain(
      JSON.stringify({ type: "input", data: "\u001b" })
    );

    fireEvent.click(openPreview);
    const reopenedDialog = screen.getByRole("dialog", { name: "Image 1 preview" });
    fireEvent.click(reopenedDialog);
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Image 1 preview" })).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(openPreview));
  });

  it("uploads clipboard API images on Ctrl+V instead of sending raw Ctrl+V to Codex", async () => {
    const imageBlob = new Blob(["image-data"], { type: "image/png" });
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        read: vi.fn().mockResolvedValue([
          {
            types: ["image/png"],
            getType: vi.fn().mockResolvedValue(imageBlob)
          }
        ]),
        readText: vi.fn().mockResolvedValue("")
      }
    });
    render(<TerminalPane pane={cliPane()} terminalFontSize={12} />);

    await waitFor(() => expect(apiMock.createCliSession).toHaveBeenCalled());
    await waitFor(() => expect(MockWebSocket.instances[0]?.readyState).toBe(MockWebSocket.OPEN));
    const textarea = await waitFor(() => {
      const found = document.querySelector<HTMLTextAreaElement>(".xterm-helper-textarea");
      expect(found).toBeTruthy();
      return found!;
    });
    textarea.addEventListener("keydown", (event) => {
      if (!event.defaultPrevented && event.ctrlKey && event.key.toLowerCase() === "v") {
        MockWebSocket.instances[0]?.send(JSON.stringify({ type: "input", data: "\u0016" }));
      }
    });

    const event = new KeyboardEvent("keydown", { key: "v", ctrlKey: true, bubbles: true, cancelable: true });
    textarea.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    await waitFor(() =>
      expect(apiMock.uploadCliFiles).toHaveBeenCalledWith({
        paneId: "pane:cli-upload",
        source: "CLIPBOARD",
        files: [expect.objectContaining({ type: "image/png", name: "clipboard-image-1.png" })]
      })
    );
    expect(MockWebSocket.instances[0]?.sent).not.toContain(JSON.stringify({ type: "input", data: "\u0016" }));
    expect(MockWebSocket.instances[0]?.sent.some((frame) => frame.includes("/opt/spaceapp/var/artifacts/cli-uploads/diagram.png"))).toBe(false);
  });

  it("uploads clipboard API images on Ctrl+V when the keyboard layout reports a Greek key", async () => {
    const imageBlob = new Blob(["image-data"], { type: "image/png" });
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        read: vi.fn().mockResolvedValue([
          {
            types: ["image/png"],
            getType: vi.fn().mockResolvedValue(imageBlob)
          }
        ]),
        readText: vi.fn().mockResolvedValue("")
      }
    });
    render(<TerminalPane pane={cliPane()} terminalFontSize={12} />);

    await waitFor(() => expect(apiMock.createCliSession).toHaveBeenCalled());
    await waitFor(() => expect(MockWebSocket.instances[0]?.readyState).toBe(MockWebSocket.OPEN));
    const textarea = await waitFor(() => {
      const found = document.querySelector<HTMLTextAreaElement>(".xterm-helper-textarea");
      expect(found).toBeTruthy();
      return found!;
    });
    let rawCtrlVReachedCodex = false;
    textarea.addEventListener("keydown", (event) => {
      if (!event.defaultPrevented && event.ctrlKey && event.code === "KeyV") {
        rawCtrlVReachedCodex = true;
      }
    });

    const event = new KeyboardEvent("keydown", { key: "υ", code: "KeyV", ctrlKey: true, bubbles: true, cancelable: true });
    textarea.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    await waitFor(() =>
      expect(apiMock.uploadCliFiles).toHaveBeenCalledWith({
        paneId: "pane:cli-upload",
        source: "CLIPBOARD",
        files: [expect.objectContaining({ type: "image/png", name: "clipboard-image-1.png" })]
      })
    );
    expect(rawCtrlVReachedCodex).toBe(false);
    expect(MockWebSocket.instances[0]?.sent.some((frame) => frame.includes("/opt/spaceapp/var/artifacts/cli-uploads/diagram.png"))).toBe(false);
  });

  it("uploads multiple clipboard API images on Ctrl+V", async () => {
    const pngBlob = new Blob(["png-image-data"], { type: "image/png" });
    const jpegBlob = new Blob(["jpeg-image-data"], { type: "image/jpeg" });
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        read: vi.fn().mockResolvedValue([
          {
            types: ["image/png"],
            getType: vi.fn().mockResolvedValue(pngBlob)
          },
          {
            types: ["image/jpeg"],
            getType: vi.fn().mockResolvedValue(jpegBlob)
          }
        ]),
        readText: vi.fn().mockResolvedValue("")
      }
    });
    render(<TerminalPane pane={cliPane()} terminalFontSize={12} />);

    await waitFor(() => expect(apiMock.createCliSession).toHaveBeenCalled());
    await waitFor(() => expect(MockWebSocket.instances[0]?.readyState).toBe(MockWebSocket.OPEN));
    const textarea = await waitFor(() => {
      const found = document.querySelector<HTMLTextAreaElement>(".xterm-helper-textarea");
      expect(found).toBeTruthy();
      return found!;
    });

    fireEvent.keyDown(textarea, { key: "v", ctrlKey: true });

    await waitFor(() =>
      expect(apiMock.uploadCliFiles).toHaveBeenCalledWith({
        paneId: "pane:cli-upload",
        source: "CLIPBOARD",
        files: [
          expect.objectContaining({ type: "image/png", name: "clipboard-image-1.png" }),
          expect.objectContaining({ type: "image/jpeg", name: "clipboard-image-2.jpg" })
        ]
      })
    );
  });

  it("treats document-level Ctrl+V as terminal paste when the xterm textarea is active", async () => {
    const imageBlob = new Blob(["image-data"], { type: "image/png" });
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        read: vi.fn().mockResolvedValue([
          {
            types: ["image/png"],
            getType: vi.fn().mockResolvedValue(imageBlob)
          }
        ]),
        readText: vi.fn().mockResolvedValue("")
      }
    });
    render(<TerminalPane pane={cliPane()} terminalFontSize={12} />);

    await waitFor(() => expect(apiMock.createCliSession).toHaveBeenCalled());
    await waitFor(() => expect(MockWebSocket.instances[0]?.readyState).toBe(MockWebSocket.OPEN));
    const textarea = await waitFor(() => {
      const found = document.querySelector<HTMLTextAreaElement>(".xterm-helper-textarea");
      expect(found).toBeTruthy();
      return found!;
    });
    textarea.focus();
    let rawCtrlVReachedCodex = false;
    const rawKeyListener = (event: KeyboardEvent) => {
      if (!event.defaultPrevented && event.ctrlKey && event.key.toLowerCase() === "v") {
        rawCtrlVReachedCodex = true;
      }
    };
    document.addEventListener("keydown", rawKeyListener);

    const event = new KeyboardEvent("keydown", { key: "v", ctrlKey: true, bubbles: true, cancelable: true });
    act(() => {
      document.dispatchEvent(event);
    });

    expect(event.defaultPrevented).toBe(true);
    await waitFor(() =>
      expect(apiMock.uploadCliFiles).toHaveBeenCalledWith({
        paneId: "pane:cli-upload",
        source: "CLIPBOARD",
        files: [expect.objectContaining({ type: "image/png", name: "clipboard-image-1.png" })]
      })
    );
    expect(rawCtrlVReachedCodex).toBe(false);
    document.removeEventListener("keydown", rawKeyListener);
  });

  it("refocuses the terminal for a second clipboard image paste after the Clip Tool button had focus", async () => {
    const firstBlob = new Blob(["first-image"], { type: "image/png" });
    const secondBlob = new Blob(["second-image"], { type: "image/png" });
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        read: vi
          .fn()
          .mockResolvedValueOnce([
            {
              types: ["image/png"],
              getType: vi.fn().mockResolvedValue(firstBlob)
            }
          ])
          .mockResolvedValueOnce([
            {
              types: ["image/png"],
              getType: vi.fn().mockResolvedValue(secondBlob)
            }
          ]),
        readText: vi.fn().mockResolvedValue("")
      }
    });
    const clipToolButton = document.createElement("button");
    clipToolButton.textContent = "Clip Tool";
    document.body.appendChild(clipToolButton);
    render(<TerminalPane pane={cliPane()} terminalFontSize={12} />);

    await waitFor(() => expect(apiMock.createCliSession).toHaveBeenCalled());
    await waitFor(() => expect(MockWebSocket.instances[0]?.readyState).toBe(MockWebSocket.OPEN));
    const textarea = await waitFor(() => {
      const found = document.querySelector<HTMLTextAreaElement>(".xterm-helper-textarea");
      expect(found).toBeTruthy();
      return found!;
    });
    textarea.focus();

    const firstEvent = new KeyboardEvent("keydown", { key: "v", ctrlKey: true, bubbles: true, cancelable: true });
    textarea.dispatchEvent(firstEvent);
    expect(firstEvent.defaultPrevented).toBe(true);
    await waitFor(() => expect(apiMock.uploadCliFiles).toHaveBeenCalledTimes(1));
    expect(document.activeElement).toBe(textarea);

    clipToolButton.focus();
    expect(document.activeElement).toBe(clipToolButton);
    window.dispatchEvent(new CustomEvent("space:terminal-pane-action", { detail: { paneId: "pane:cli-upload", action: "focus" } }));
    expect(document.activeElement).toBe(textarea);

    const secondEvent = new KeyboardEvent("keydown", { key: "v", ctrlKey: true, bubbles: true, cancelable: true });
    textarea.dispatchEvent(secondEvent);
    expect(secondEvent.defaultPrevented).toBe(true);
    await waitFor(() => expect(apiMock.uploadCliFiles).toHaveBeenCalledTimes(2));
    expect(apiMock.uploadCliFiles).toHaveBeenLastCalledWith({
      paneId: "pane:cli-upload",
      source: "CLIPBOARD",
      files: [expect.objectContaining({ type: "image/png", name: "clipboard-image-1.png" })]
    });
    expect(MockWebSocket.instances[0]?.sent).not.toContain(JSON.stringify({ type: "input", data: "\u0016" }));
    clipToolButton.remove();
  });

  it("refocuses the terminal after removing a preview so the next Ctrl+V paste still works", async () => {
    const firstBlob = new Blob(["first-image"], { type: "image/png" });
    const secondBlob = new Blob(["second-image"], { type: "image/png" });
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        read: vi
          .fn()
          .mockResolvedValueOnce([
            {
              types: ["image/png"],
              getType: vi.fn().mockResolvedValue(firstBlob)
            }
          ])
          .mockResolvedValueOnce([
            {
              types: ["image/png"],
              getType: vi.fn().mockResolvedValue(secondBlob)
            }
          ]),
        readText: vi.fn().mockResolvedValue("")
      }
    });
    render(<TerminalPane pane={cliPane()} terminalFontSize={12} />);

    await waitFor(() => expect(apiMock.createCliSession).toHaveBeenCalled());
    await waitFor(() => expect(MockWebSocket.instances[0]?.readyState).toBe(MockWebSocket.OPEN));
    const textarea = await waitFor(() => {
      const found = document.querySelector<HTMLTextAreaElement>(".xterm-helper-textarea");
      expect(found).toBeTruthy();
      return found!;
    });
    textarea.focus();

    fireEvent.keyDown(textarea, { key: "v", ctrlKey: true });
    await waitFor(() => expect(apiMock.uploadCliFiles).toHaveBeenCalledTimes(1));

    await openPhotoPreviews(1);
    const removeButton = await screen.findByRole("button", { name: "Delete image 1" });
    removeButton.focus();
    expect(document.activeElement).toBe(removeButton);
    fireEvent.click(removeButton);
    await waitFor(() => expect(apiMock.deleteArtifact).toHaveBeenCalledWith("artifact:test-upload:1:1"));

    await waitFor(() => expect(screen.queryByRole("button", { name: "Open image 1" })).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(textarea));

    const secondEvent = new KeyboardEvent("keydown", { key: "v", ctrlKey: true, bubbles: true, cancelable: true });
    document.dispatchEvent(secondEvent);

    expect(secondEvent.defaultPrevented).toBe(true);
    await waitFor(() => expect(apiMock.uploadCliFiles).toHaveBeenCalledTimes(2));
    await openPhotoPreviews(1);
    expect(screen.getByRole("button", { name: "Open image 1" })).toBeTruthy();
  });

  it("reroutes document-level Ctrl+V back to the terminal after focus drifts to the hidden file input", async () => {
    const imageBlob = new Blob(["image-data"], { type: "image/png" });
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        read: vi.fn().mockResolvedValue([
          {
            types: ["image/png"],
            getType: vi.fn().mockResolvedValue(imageBlob)
          }
        ]),
        readText: vi.fn().mockResolvedValue("")
      }
    });
    window.localStorage.setItem("space.clipboardDebug", "true");
    window.localStorage.setItem("space.cliDebugMode", "true");
    render(<TerminalPane pane={cliPane()} terminalFontSize={12} />);

    await waitFor(() => expect(apiMock.createCliSession).toHaveBeenCalled());
    await waitFor(() => expect(MockWebSocket.instances[0]?.readyState).toBe(MockWebSocket.OPEN));
    const textarea = await waitFor(() => {
      const found = document.querySelector<HTMLTextAreaElement>(".xterm-helper-textarea");
      expect(found).toBeTruthy();
      return found!;
    });
    fireEvent.pointerDown(textarea);
    textarea.focus();

    const fileInput = document.querySelector<HTMLInputElement>('input[name="cli-files-pane:cli-upload"]');
    expect(fileInput).toBeTruthy();
    fileInput!.focus();
    expect(document.activeElement).toBe(fileInput);
    // Since 9e1378b4cd only a real pointer gesture, not programmatic focus, marks terminal intent.
    fireEvent.pointerDown(textarea);
    fileInput!.focus();
    expect(document.activeElement).toBe(fileInput);

    const event = new KeyboardEvent("keydown", { key: "v", ctrlKey: true, bubbles: true, cancelable: true });
    document.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    await waitFor(() =>
      expect(apiMock.uploadCliFiles).toHaveBeenCalledWith({
        paneId: "pane:cli-upload",
        source: "CLIPBOARD",
        files: [expect.objectContaining({ type: "image/png", name: "clipboard-image-1.png" })]
      })
    );
    expect(await screen.findByText(/Ctrl\+V rerouted/i)).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(textarea));
    expect(MockWebSocket.instances[0]?.sent).not.toContain(JSON.stringify({ type: "input", data: "\u0016" }));
  });

  it("reads async demo paste text from the local platform clipboard without native access", async () => {
    const nativeRead = vi.fn(async () => {
      throw new Error("Native clipboard must stay unused in demo mode.");
    });
    const nativeReadText = vi.fn(async () => "native text");
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { read: nativeRead, readText: nativeReadText }
    });
    const { runtime: demoRuntime } = createDemoRuntime();
    await demoRuntime.platform.clipboard?.writeText("local demo paste");
    installSpaceRuntime({ ...liveRuntime, kind: "demo", platform: demoRuntime.platform });
    render(<TerminalPane pane={cliPane()} terminalFontSize={12} />);

    await waitFor(() => expect(apiMock.createCliSession).toHaveBeenCalled());
    await waitFor(() => expect(MockWebSocket.instances[0]?.readyState).toBe(MockWebSocket.OPEN));
    fireEvent.paste(await screen.findByLabelText("CLI pane Codex CLI"), {
      clipboardData: { files: [], items: [], types: [], getData: () => "" }
    });

    await waitFor(() =>
      expect(MockWebSocket.instances[0]?.sent).toContain(JSON.stringify({ type: "input", data: "local demo paste" }))
    );
    expect(nativeRead).not.toHaveBeenCalled();
    expect(nativeReadText).not.toHaveBeenCalled();
  });

  it("blocks raw xterm Ctrl+V input after clipboard image paste interception fails", async () => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        read: vi.fn().mockRejectedValue(new Error("clipboard image read denied")),
        readText: vi.fn().mockResolvedValue("")
      }
    });
    render(<TerminalPane pane={cliPane()} terminalFontSize={12} />);

    await waitFor(() => expect(apiMock.createCliSession).toHaveBeenCalled());
    await waitFor(() => expect(MockWebSocket.instances[0]?.readyState).toBe(MockWebSocket.OPEN));
    const textarea = await waitFor(() => {
      const found = document.querySelector<HTMLTextAreaElement>(".xterm-helper-textarea");
      expect(found).toBeTruthy();
      return found!;
    });
    textarea.focus();

    const event = new KeyboardEvent("keydown", { key: "v", ctrlKey: true, bubbles: true, cancelable: true });
    textarea.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    xtermMock.instances[0]?.emitData("\u0016");

    expect(MockWebSocket.instances[0]?.sent).not.toContain(JSON.stringify({ type: "input", data: "\u0016" }));
  });

  it("treats document-level paste events as terminal paste when the xterm textarea is active", async () => {
    render(<TerminalPane pane={cliPane()} terminalFontSize={12} />);

    await waitFor(() => expect(apiMock.createCliSession).toHaveBeenCalled());
    await waitFor(() => expect(MockWebSocket.instances[0]?.readyState).toBe(MockWebSocket.OPEN));
    const textarea = await waitFor(() => {
      const found = document.querySelector<HTMLTextAreaElement>(".xterm-helper-textarea");
      expect(found).toBeTruthy();
      return found!;
    });
    textarea.focus();
    const file = new File(["document-paste"], "document-paste.png", { type: "image/png" });
    let rawPasteReachedCodex = false;
    const rawPasteListener = (event: ClipboardEvent) => {
      if (!event.defaultPrevented) {
        rawPasteReachedCodex = true;
      }
    };
    document.addEventListener("paste", rawPasteListener);

    fireEvent.paste(document, {
      clipboardData: {
        files: [file],
        items: [],
        getData: () => ""
      }
    });

    await waitFor(() => expect(apiMock.uploadCliFiles).toHaveBeenCalledWith({ paneId: "pane:cli-upload", source: "CLIPBOARD", files: [file] }));
    expect(rawPasteReachedCodex).toBe(false);
    document.removeEventListener("paste", rawPasteListener);
  });

  it("treats beforeinput paste events as terminal paste when the xterm textarea is active", async () => {
    const asyncImageBlob = new Blob(["beforeinput-image"], { type: "image/png" });
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        read: vi.fn().mockResolvedValue([
          {
            types: ["image/png"],
            getType: vi.fn().mockResolvedValue(asyncImageBlob)
          }
        ]),
        readText: vi.fn().mockResolvedValue("")
      }
    });
    render(<TerminalPane pane={cliPane()} terminalFontSize={12} />);

    await waitFor(() => expect(apiMock.createCliSession).toHaveBeenCalled());
    await waitFor(() => expect(MockWebSocket.instances[0]?.readyState).toBe(MockWebSocket.OPEN));
    const textarea = await waitFor(() => {
      const found = document.querySelector<HTMLTextAreaElement>(".xterm-helper-textarea");
      expect(found).toBeTruthy();
      return found!;
    });
    textarea.focus();

    const event = new InputEvent("beforeinput", { inputType: "insertFromPaste", bubbles: true, cancelable: true });
    textarea.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    await waitFor(() => expect(apiMock.uploadCliFiles).toHaveBeenCalledTimes(1));
    const uploadInput = apiMock.uploadCliFiles.mock.calls[0]?.[0] as { paneId: string; source: string; files: File[] };
    expect(uploadInput.paneId).toBe("pane:cli-upload");
    expect(uploadInput.source).toBe("CLIPBOARD");
    expect(uploadInput.files).toHaveLength(1);
    expect(uploadInput.files[0]?.name).toBe("clipboard-image-1.png");
    expect(uploadInput.files[0]?.type).toBe("image/png");
  });

  it("lets multi-file paste events beat the Ctrl+V async clipboard fallback", async () => {
    const asyncImageBlob = new Blob(["async-image-data"], { type: "image/png" });
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        read: vi.fn().mockResolvedValue([
          {
            types: ["image/png"],
            getType: vi.fn().mockResolvedValue(asyncImageBlob)
          }
        ]),
        readText: vi.fn().mockResolvedValue("")
      }
    });
    render(<TerminalPane pane={cliPane()} terminalFontSize={12} />);

    await waitFor(() => expect(apiMock.createCliSession).toHaveBeenCalled());
    await waitFor(() => expect(MockWebSocket.instances[0]?.readyState).toBe(MockWebSocket.OPEN));
    const terminal = await screen.findByLabelText("CLI pane Codex CLI");
    const textarea = await waitFor(() => {
      const found = document.querySelector<HTMLTextAreaElement>(".xterm-helper-textarea");
      expect(found).toBeTruthy();
      return found!;
    });
    textarea.addEventListener("keydown", (event) => {
      if (!event.defaultPrevented && event.ctrlKey && event.key.toLowerCase() === "v") {
        MockWebSocket.instances[0]?.send(JSON.stringify({ type: "input", data: "\u0016" }));
      }
    });

    const firstFile = new File(["first"], "first-clip.png", { type: "image/png" });
    const secondFile = new File(["second"], "second-clip.jpg", { type: "image/jpeg" });
    fireEvent.keyDown(textarea, { key: "v", ctrlKey: true });
    fireEvent.paste(terminal, {
      clipboardData: {
        files: [firstFile, secondFile],
        items: [],
        getData: () => ""
      }
    });

    await waitFor(() => expect(apiMock.uploadCliFiles).toHaveBeenCalledTimes(1));
    expect(apiMock.uploadCliFiles).toHaveBeenCalledWith({
      paneId: "pane:cli-upload",
      source: "CLIPBOARD",
      files: [firstFile, secondFile]
    });
    expect(MockWebSocket.instances[0]?.sent).not.toContain(JSON.stringify({ type: "input", data: "\u0016" }));
  });

  it("falls back to clipboard API images when paste events expose no files or text without auto-showing debug UI", async () => {
    const imageBlob = new Blob(["image-data"], { type: "image/png" });
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        read: vi.fn().mockResolvedValue([
          {
            types: ["image/png"],
            getType: vi.fn().mockResolvedValue(imageBlob)
          }
        ]),
        readText: vi.fn().mockResolvedValue("")
      }
    });
    render(<TerminalPane pane={cliPane()} terminalFontSize={12} />);

    await waitFor(() => expect(apiMock.createCliSession).toHaveBeenCalled());
    await waitFor(() => expect(MockWebSocket.instances[0]?.readyState).toBe(MockWebSocket.OPEN));
    const terminal = await screen.findByLabelText("CLI pane Codex CLI");
    terminal.addEventListener("paste", (event) => {
      if (!event.defaultPrevented) {
        MockWebSocket.instances[0]?.send(JSON.stringify({ type: "input", data: "RAW_PASTE_REACHED_CODEX" }));
      }
    });

    fireEvent.paste(terminal, {
      clipboardData: {
        files: [],
        items: [],
        types: [],
        getData: () => ""
      }
    });

    await waitFor(() =>
      expect(apiMock.uploadCliFiles).toHaveBeenCalledWith({
        paneId: "pane:cli-upload",
        source: "CLIPBOARD",
        files: [expect.objectContaining({ type: "image/png", name: "clipboard-image-1.png" })]
      })
    );
    expect(MockWebSocket.instances[0]?.sent).not.toContain(JSON.stringify({ type: "input", data: "RAW_PASTE_REACHED_CODEX" }));
    expect(screen.queryByText(/Clipboard debug/i)).toBeNull();
    expect(screen.queryByText(/async clipboard image read succeeded/i)).toBeNull();
  });

  it("uploads pasted image data URLs when clipboard files are unavailable", async () => {
    render(<TerminalPane pane={cliPane()} terminalFontSize={12} />);

    await waitFor(() => expect(apiMock.createCliSession).toHaveBeenCalled());
    await waitFor(() => expect(MockWebSocket.instances[0]?.readyState).toBe(MockWebSocket.OPEN));
    const terminal = await screen.findByLabelText("CLI pane Codex CLI");
    fireEvent.paste(terminal, {
      clipboardData: {
        files: [],
        items: [],
        getData: (type: string) =>
          type === "text/html" ? '<img src="data:image/png;base64,aW1hZ2UtZGF0YQ==" alt="clipboard">' : ""
      }
    });

    await waitFor(() =>
      expect(apiMock.uploadCliFiles).toHaveBeenCalledWith({
        paneId: "pane:cli-upload",
        source: "CLIPBOARD",
        files: [expect.objectContaining({ type: "image/png", name: "clipboard-image-1.png" })]
      })
    );
  });

  it("uploads multiple pasted image data URLs when clipboard files are unavailable", async () => {
    render(<TerminalPane pane={cliPane()} terminalFontSize={12} />);

    await waitFor(() => expect(apiMock.createCliSession).toHaveBeenCalled());
    await waitFor(() => expect(MockWebSocket.instances[0]?.readyState).toBe(MockWebSocket.OPEN));
    const terminal = await screen.findByLabelText("CLI pane Codex CLI");
    fireEvent.paste(terminal, {
      clipboardData: {
        files: [],
        items: [],
        getData: (type: string) =>
          type === "text/html"
            ? [
                '<img src="data:image/png;base64,cG5nLWltYWdl" alt="clipboard 1">',
                '<img src="data:image/jpeg;base64,anBlZy1pbWFnZQ==" alt="clipboard 2">'
              ].join("")
            : ""
      }
    });

    await waitFor(() =>
      expect(apiMock.uploadCliFiles).toHaveBeenCalledWith({
        paneId: "pane:cli-upload",
        source: "CLIPBOARD",
        files: [
          expect.objectContaining({ type: "image/png", name: "clipboard-image-1.png" }),
          expect.objectContaining({ type: "image/jpeg", name: "clipboard-image-2.jpg" })
        ]
      })
    );
  });

  it("sends pasted text directly to the terminal WebSocket", async () => {
    render(<TerminalPane pane={cliPane()} terminalFontSize={12} />);

    await waitFor(() => expect(apiMock.createCliSession).toHaveBeenCalled());
    expect(screen.queryByLabelText("Start CLI Codex CLI")).toBeNull();
    await waitFor(() => expect(MockWebSocket.instances[0]?.readyState).toBe(MockWebSocket.OPEN));

    fireEvent.paste(await screen.findByLabelText("CLI pane Codex CLI"), {
      clipboardData: {
        files: [],
        getData: (type: string) => (type === "text" ? "echo hello" : "")
      }
    });

    expect(MockWebSocket.instances[0]?.sent).toContain(JSON.stringify({ type: "input", data: "echo hello" }));
  });

  it("copies the full CLI buffer and falls back when clipboard permissions reject", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("clipboard denied"));
    const execCommand = vi.fn().mockReturnValue(true);
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      value: execCommand
    });
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText }
    });
    render(<TerminalPane pane={cliPane()} terminalFontSize={12} />);

    await waitFor(() => expect(apiMock.createCliSession).toHaveBeenCalled());
    await waitFor(() => expect(MockWebSocket.instances[0]?.readyState).toBe(MockWebSocket.OPEN));
    MockWebSocket.instances[0]?.dispatchEvent(
      new MessageEvent("message", {
        data: JSON.stringify({ type: "output", stream: "stdout", data: "first line\nsecond line\n" })
      })
    );
    await waitFor(() => expect(xtermMock.instances[0]?.writes.join("")).toContain("second line"));

    window.dispatchEvent(
      new CustomEvent("space:terminal-pane-action", {
        detail: { paneId: "pane:cli-upload", action: "copy" }
      })
    );

    await waitFor(() => expect(writeText).toHaveBeenCalledWith("first line\nsecond line"));
    expect(execCommand).toHaveBeenCalledWith("copy");
    expect(await screen.findByText("CLI content copied.")).toBeTruthy();
  });

  it("reports no copyable content before the live PTY emits output", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText }
    });
    render(<TerminalPane pane={cliPane()} terminalFontSize={12} />);

    await waitFor(() => expect(apiMock.createCliSession).toHaveBeenCalled());
    await waitFor(() => expect(MockWebSocket.instances[0]?.readyState).toBe(MockWebSocket.OPEN));

    window.dispatchEvent(
      new CustomEvent("space:terminal-pane-action", {
        detail: { paneId: "pane:cli-upload", action: "copy" }
      })
    );

    expect(await screen.findByText("No CLI content is available to copy yet.")).toBeTruthy();
    expect(writeText).not.toHaveBeenCalled();
  });

  it("copies a mouse-capturing CLI's own OSC 52 selection from the context menu, never a replayed one", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText }
    });
    MockWebSocket.autoRunningStatus = false;
    apiMock.activeCliSession.mockResolvedValueOnce(
      cliSessionResponse("terminal-ws-ticket-existing-active", "RUNNING", true)
    );
    render(<TerminalPane pane={cliPane()} terminalFontSize={12} />);

    await waitFor(() => expect(MockWebSocket.instances[0]?.readyState).toBe(MockWebSocket.OPEN));
    await waitFor(() => expect(MockWebSocket.instances[0]?.messageListenerRegistrations).toBeGreaterThanOrEqual(2));
    const socket = MockWebSocket.instances[0]!;
    const terminal = xtermMock.instances[0]!;
    const host = await screen.findByLabelText("Live CLI pane Codex CLI");
    const osc52 = (text: string) => `\u001b]52;c;${btoa(text)}\u0007`;
    const output = (data: string) => new MessageEvent("message", {
      data: JSON.stringify({ type: "output", stream: "stdout", data })
    });
    const copyItem = () => screen.getByRole("menuitem", { name: /Copy\s+Ctrl\+C/i });
    const openMenu = async () => {
      fireEvent.contextMenu(host, { clientX: 40, clientY: 40 });
      return screen.findByRole("menu", { name: /Terminal context menu/i });
    };
    // Claude Code's fullscreen renderer and the opencode TUI report the mouse.
    terminal.modes.mouseTrackingMode = "any";
    fireEvent.pointerDown(host, { button: 0 });

    act(() => {
      socket.dispatchEvent(output(`replayed frame${osc52("stale replay selection")}`));
      socket.dispatchEvent(new MessageEvent("message", {
        data: JSON.stringify({ type: "status", status: "RUNNING", replayContinuity: "COMPLETE" })
      }));
    });
    await waitFor(() => expect(terminal.writes.join("")).toContain("replayed frame"));
    await openMenu();
    expect(copyItem().hasAttribute("disabled")).toBe(true);
    act(() => {
      fireEvent.keyDown(document, { key: "Escape" });
    });

    act(() => {
      socket.dispatchEvent(output(`\u001b[7mselected\u001b[27m${osc52("live CLI selection")}`));
    });
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("live CLI selection"));
    expect(writeText).not.toHaveBeenCalledWith("stale replay selection");
    writeText.mockClear();

    await openMenu();
    expect(copyItem().hasAttribute("disabled")).toBe(false);
    // The CLI owns the highlight, so xterm cannot clear it.
    expect(screen.queryByRole("menuitem", { name: /Clear selection/i })).toBeNull();
    fireEvent.click(copyItem());
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("live CLI selection"));

    const reportedButtons: number[] = [];
    terminal.element!.addEventListener("mousedown", (event) => reportedButtons.push(event.button));
    fireEvent.pointerDown(host, { button: 2 });
    fireEvent.mouseDown(terminal.element!, { button: 2 });
    // Right-click belongs to the Space menu; reporting it would clear the CLI's selection.
    expect(reportedButtons).toEqual([]);
    await openMenu();
    expect(copyItem().hasAttribute("disabled")).toBe(false);
    act(() => {
      fireEvent.keyDown(document, { key: "Escape" });
    });

    // A new left click clears the CLI's selection; xterm's own selection still wins.
    fireEvent.pointerDown(host, { button: 0 });
    await openMenu();
    expect(copyItem().hasAttribute("disabled")).toBe(true);
    act(() => {
      fireEvent.keyDown(document, { key: "Escape" });
    });
    terminal.selection = "shift-drag selection";
    await openMenu();
    expect(copyItem().hasAttribute("disabled")).toBe(false);
    expect(screen.getByRole("menuitem", { name: /Clear selection/i })).toBeTruthy();
  });

  it("ignores OSC 52 writes once the CLI stops capturing the mouse or the pane is not in use", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText }
    });
    render(<TerminalPane pane={cliPane()} terminalFontSize={12} />);

    await waitFor(() => expect(MockWebSocket.instances[0]?.readyState).toBe(MockWebSocket.OPEN));
    const socket = MockWebSocket.instances[0]!;
    const terminal = xtermMock.instances[0]!;
    const host = await screen.findByLabelText("Live CLI pane Codex CLI");
    (document.activeElement as HTMLElement | null)?.blur();
    terminal.modes.mouseTrackingMode = "any";

    act(() => {
      socket.dispatchEvent(new MessageEvent("message", {
        data: JSON.stringify({ type: "output", stream: "stdout", data: `\u001b]52;c;${btoa("background copy")}\u0007` })
      }));
    });
    await waitFor(() => expect(terminal.writes.join("")).toContain("\u001b]52;c;"));
    expect(writeText).not.toHaveBeenCalled();

    fireEvent.pointerDown(host, { button: 0 });
    act(() => {
      socket.dispatchEvent(new MessageEvent("message", {
        data: JSON.stringify({ type: "output", stream: "stdout", data: `\u001b]52;c;${btoa("user copy")}\u0007` })
      }));
    });
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("user copy"));
    terminal.modes.mouseTrackingMode = "none";
    const reportedButtons: number[] = [];
    terminal.element!.addEventListener("mousedown", (event) => reportedButtons.push(event.button));
    fireEvent.mouseDown(terminal.element!, { button: 2 });
    expect(reportedButtons).toEqual([2]);
    fireEvent.contextMenu(host, { clientX: 40, clientY: 40 });
    await screen.findByRole("menu", { name: /Terminal context menu/i });
    expect(screen.getByRole("menuitem", { name: /Copy\s+Ctrl\+C/i }).hasAttribute("disabled")).toBe(true);
  });

  it("keeps clipboard debug hidden by default when Clip Tool insert_text reaches the terminal pane", async () => {
    render(<TerminalPane pane={cliPane()} terminalFontSize={12} />);

    await waitFor(() => expect(apiMock.createCliSession).toHaveBeenCalled());
    await waitFor(() => expect(MockWebSocket.instances[0]?.readyState).toBe(MockWebSocket.OPEN));

    window.dispatchEvent(
      new CustomEvent("space:terminal-pane-action", {
        detail: { paneId: "pane:cli-upload", action: "insert_text", text: "/opt/spaceapp/var/artifacts/cli-uploads/from-clip-tool.png " }
      })
    );

    await waitFor(() => expect(MockWebSocket.instances[0]?.sent.some((frame) => frame.includes("from-clip-tool.png"))).toBe(false));
    expect(screen.queryByText(/Clipboard debug/i)).toBeNull();
    expect(screen.queryByText(/terminal action insert_text/i)).toBeNull();
  });

  it("uploads a Clip Tool action as SCREEN_CAPTURE, shows its preview, and sends only hidden bracketed terminal input", async () => {
    render(<TerminalPane pane={cliPane()} terminalFontSize={12} />);

    await waitFor(() => expect(apiMock.createCliSession).toHaveBeenCalled());
    await waitFor(() => expect(MockWebSocket.instances[0]?.readyState).toBe(MockWebSocket.OPEN));
    const socket = MockWebSocket.instances[0]!;
    socket.sent.length = 0;
    const screenshot = new File(["clip"], "clip-tool.png", { type: "image/png" });

    window.dispatchEvent(
      new CustomEvent("space:terminal-pane-action", {
        detail: { paneId: "pane:cli-upload", action: "attach_clip_image", file: screenshot }
      })
    );

    await waitFor(() =>
      expect(apiMock.uploadCliFiles).toHaveBeenCalledWith({
        paneId: "pane:cli-upload",
        source: "SCREEN_CAPTURE",
        files: [screenshot]
      })
    );
    await openPhotoPreviews(1);
    expect(await screen.findByRole("button", { name: "Open image 1" })).toBeTruthy();
    await waitFor(() =>
      expect(socket.sent).toContain(
        JSON.stringify({
          type: "input",
          data: "\u001b[200~/opt/spaceapp/var/artifacts/cli-uploads/clip-tool.png\u001b[201~",
          display: "hidden"
        })
      )
    );
    expect(
      socket.sent
        .map((frame) => JSON.parse(frame) as { type?: string; data?: string })
        .filter((frame) => frame.type === "input" && /^[\r\n]+$/.test(frame.data ?? ""))
    ).toEqual([]);
    socket.dispatchEvent(
      new MessageEvent("message", {
        data: JSON.stringify({
          type: "output",
          stream: "stdout",
          data: "/opt/spaceapp/var/artifacts/cli-uploads/clip-tool.png"
        })
      })
    );
    expect(xtermMock.instances[0]?.writes.join("")).not.toContain("/opt/spaceapp/var/artifacts/cli-uploads/");
    expect(screen.queryByText(/srv\/space\/var\/artifacts\/cli-uploads/)).toBeNull();
    expect(screen.queryByText(/Clipboard debug/i)).toBeNull();
  });

  it("uploads short Clipboard-card action and drag text as exact UTF-8 TXT files without Enter", async () => {
    render(<TerminalPane pane={cliPane()} terminalFontSize={12} />);

    await waitFor(() => expect(apiMock.createCliSession).toHaveBeenCalled());
    await waitFor(() => expect(MockWebSocket.instances[0]?.readyState).toBe(MockWebSocket.OPEN));
    const socket = MockWebSocket.instances[0]!;
    socket.sent.length = 0;

    const actionText = "short 😀 clip\nwith a second line";
    window.dispatchEvent(new CustomEvent("space:terminal-pane-action", {
      detail: { paneId: "pane:cli-upload", action: "insert_clipboard_text", text: actionText }
    }));
    await waitFor(() => expect(apiMock.uploadCliFiles).toHaveBeenCalledTimes(1));
    const actionUpload = apiMock.uploadCliFiles.mock.calls[0]?.[0] as { source: string; files: File[] };
    expect(actionUpload.source).toBe("CLIPBOARD");
    expect(actionUpload.files[0]?.name).toMatch(/^space-clipboard-\d{8}-\d{6}\.txt$/);
    expect(actionUpload.files[0]?.type).toBe("text/plain");
    expect(await readFileText(actionUpload.files[0]!)).toBe(actionText);
    await waitFor(() => expect(socket.sent).toContain(JSON.stringify({ type: "input", data: "[File #1] " })));

    const draggedText = "dragged clip stays a file";
    const terminal = screen.getByLabelText("CLI pane Codex CLI");
    fireEvent.drop(terminal, {
      dataTransfer: {
        files: [],
        getData: (type: string) => type === "application/x-space-clipboard-item-id" ? "clipboard:drag" : type === "text/plain" ? draggedText : ""
      }
    });
    await waitFor(() => expect(apiMock.uploadCliFiles).toHaveBeenCalledTimes(2));
    const dragUpload = apiMock.uploadCliFiles.mock.calls[1]?.[0] as { source: string; files: File[] };
    expect(dragUpload.source).toBe("CLIPBOARD");
    expect(await readFileText(dragUpload.files[0]!)).toBe(draggedText);
    await waitFor(() => expect(socket.sent).toContain(JSON.stringify({ type: "input", data: "[File #2] " })));

    expect(socket.sent.some((frame) => frame.includes(actionText) || frame.includes(draggedText))).toBe(false);
    expect(socket.sent.some((frame) => frame.includes("/opt/spaceapp/var/artifacts/cli-uploads/"))).toBe(false);
    expect(
      socket.sent
        .map((frame) => JSON.parse(frame) as { type?: string; data?: string })
        .filter((frame) => frame.type === "input" && /^[\r\n]+$/.test(frame.data ?? ""))
    ).toEqual([]);
  });

  it("inserts a previewed plan as a file reference without Enter and keeps the typed draft", async () => {
    const plan = {
      id: "clipboard:plan-insert",
      text: "1. Fix the voice prewarm\n2. Verify",
      source: "PLAN",
      title: "Fix voice",
      minimumModel: "gpt-6.1-sol",
      minimumReasoning: null,
      isCompleted: false,
      executionStatus: "PLANNED",
      progressPercentage: 0,
      activeAgent: null,
      steps: [],
      lastProgressAt: null,
      roomId: null,
      paneId: null,
      paneTitle: null,
      occurrenceCount: 1,
      characterCount: 34,
      createdAt: "2026-10-11T09:00:00.000Z",
      lastUsedAt: "2026-10-11T09:00:00.000Z"
    };
    const planApi = apiMock as unknown as Record<string, unknown>;
    const updatePlanProgress = vi.fn(async (_planId: string, _input: Record<string, unknown>) => ({}));
    planApi.clipboardItems = vi.fn(async () => ({ data: [plan], pagination: { page: 1, pageSize: 100, totalItems: 1, totalPages: 1 } }));
    planApi.updatePlanProgress = updatePlanProgress;
    try {
      render(<TerminalPane pane={cliPane()} terminalFontSize={12} />);
      await waitFor(() => expect(apiMock.createCliSession).toHaveBeenCalled());
      await waitFor(() => expect(MockWebSocket.instances[0]?.readyState).toBe(MockWebSocket.OPEN));
      const socket = MockWebSocket.instances[0]!;
      act(() => xtermMock.instances[0]?.emitData("keep this draft"));
      socket.sent.length = 0;

      fireEvent.click(await screen.findByRole("button", { name: /Open plans/i }));
      fireEvent.click(await screen.findByText("Fix voice"));
      fireEvent.click(screen.getByRole("button", { name: "Insert without sending" }));

      await waitFor(() => expect(apiMock.uploadCliFiles).toHaveBeenCalledTimes(1));
      const uploaded = (apiMock.uploadCliFiles.mock.calls[0]?.[0] as { files: File[] }).files[0]!;
      expect(uploaded.name).toBe("plan-fix-voice.md");
      await waitFor(() =>
        expect(socket.sent).toContain(JSON.stringify({
          type: "input",
          data: 'Implement the following plan: [File #1] ("Fix voice") Plan ID: clipboard:plan-insert '
        }))
      );
      const inputs = socket.sent.map((frame) => JSON.parse(frame) as { type?: string; data?: string }).filter((frame) => frame.type === "input");
      expect(inputs.some((frame) => frame.data === "\r" || frame.data?.includes("\u0015"))).toBe(false);
      expect(updatePlanProgress).toHaveBeenCalledExactlyOnceWith("clipboard:plan-insert", expect.objectContaining({ paneId: "pane:cli-upload", roomId: "room:cli-upload" }));
      expect(updatePlanProgress.mock.calls[0]?.[1]).not.toHaveProperty("executionStatus");
    } finally {
      delete planApi.clipboardItems;
      delete planApi.updatePlanProgress;
    }
  });

  it("uploads large Clipboard-card action text as exact UTF-8 TXT and resolves its token on submit", async () => {
    render(<TerminalPane pane={cliPane()} terminalFontSize={12} />);

    await waitFor(() => expect(apiMock.createCliSession).toHaveBeenCalled());
    await waitFor(() => expect(MockWebSocket.instances[0]?.readyState).toBe(MockWebSocket.OPEN));
    const socket = MockWebSocket.instances[0]!;
    socket.sent.length = 0;
    const largeText = "😀".repeat(8_001);

    window.dispatchEvent(new CustomEvent("space:terminal-pane-action", {
      detail: { paneId: "pane:cli-upload", action: "insert_clipboard_text", text: largeText }
    }));

    await waitFor(() => expect(apiMock.uploadCliFiles).toHaveBeenCalledTimes(1));
    const uploadInput = apiMock.uploadCliFiles.mock.calls[0]?.[0] as { paneId: string; source: string; files: File[] };
    const uploadedTextFile = uploadInput.files[0]!;
    expect(uploadInput.paneId).toBe("pane:cli-upload");
    expect(uploadInput.source).toBe("CLIPBOARD");
    expect(uploadedTextFile.name).toMatch(/^space-clipboard-\d{8}-\d{6}\.txt$/);
    expect(uploadedTextFile.type).toBe("text/plain");
    expect(uploadedTextFile.size).toBe(new TextEncoder().encode(largeText).byteLength);
    expect(await readFileText(uploadedTextFile)).toBe(largeText);

    await waitFor(() =>
      expect(socket.sent).toContain(JSON.stringify({
        type: "input",
        data: "[File #1] "
      }))
    );
    expect(socket.sent.some((frame) => frame.includes("/opt/spaceapp/var/artifacts/cli-uploads/"))).toBe(false);
    act(() => xtermMock.instances[0]?.emitData("\r"));

    const hiddenInput = {
      type: "input",
      data: ` '/opt/spaceapp/var/artifacts/cli-uploads/${uploadedTextFile.name}' `,
      display: "hidden"
    };
    await waitFor(() => expect(socket.sent).toContain(JSON.stringify(hiddenInput)));
    expect(socket.sent.some((frame) => frame.includes(largeText))).toBe(false);
    expect(socket.sent.map((frame) => JSON.parse(frame) as { data?: string }).some((frame) => frame.data === "\r")).toBe(true);
  });

  it("uploads dropped Clipboard-card text over 8000 Unicode code points as TXT and labels it as a file", async () => {
    render(<TerminalPane pane={cliPane()} terminalFontSize={12} />);

    await waitFor(() => expect(apiMock.createCliSession).toHaveBeenCalled());
    await waitFor(() => expect(MockWebSocket.instances[0]?.readyState).toBe(MockWebSocket.OPEN));
    const socket = MockWebSocket.instances[0]!;
    socket.sent.length = 0;
    const largeText = "α".repeat(8_001);
    const terminal = screen.getByLabelText("CLI pane Codex CLI");

    fireEvent.drop(terminal, {
      dataTransfer: {
        files: [],
        getData: (type: string) => type === "application/x-space-clipboard-item-id" ? "clipboard:drag" : type === "text/plain" ? largeText : ""
      }
    });

    await waitFor(() => expect(apiMock.uploadCliFiles).toHaveBeenCalledTimes(1));
    const uploadInput = apiMock.uploadCliFiles.mock.calls[0]?.[0] as { paneId: string; source: string; files: File[] };
    const uploadedTextFile = uploadInput.files[0]!;
    expect(uploadInput.source).toBe("CLIPBOARD");
    expect(uploadedTextFile.name).toMatch(/^space-clipboard-\d{8}-\d{6}\.txt$/);
    expect(uploadedTextFile.type).toBe("text/plain");
    expect(await readFileText(uploadedTextFile)).toBe(largeText);
    await waitFor(() =>
      expect(socket.sent).toContain(JSON.stringify({
        type: "input",
        data: "[File #1] "
      }))
    );
    expect(socket.sent.some((frame) => frame.includes(largeText))).toBe(false);
    expect(socket.sent.some((frame) => frame.includes("/opt/spaceapp/var/artifacts/cli-uploads/"))).toBe(false);
  });

  it("uploads a Media/Agent-File dock artifact dropped into the CLI as a DROP file", async () => {
    const artifactFileUrl = "/api/artifacts/artifact:drag/file";
    apiMock.artifactFileUrl.mockReturnValue(artifactFileUrl);
    // Since 16e70ebb53 the pane's prompt-variables hooks also fetch /api/user-settings on mount.
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) !== artifactFileUrl) throw new Error(`Unexpected fetch ${String(input)}`);
      return { ok: true, status: 200, blob: async () => new Blob(["artifact bytes"], { type: "image/png" }) };
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<TerminalPane pane={cliPane()} terminalFontSize={12} />);

    await waitFor(() => expect(apiMock.createCliSession).toHaveBeenCalled());
    await waitFor(() => expect(MockWebSocket.instances[0]?.readyState).toBe(MockWebSocket.OPEN));
    const terminal = screen.getByLabelText("CLI pane Codex CLI");

    fireEvent.drop(terminal, {
      dataTransfer: {
        files: [],
        getData: (type: string) =>
          type === SPACE_ARTIFACT_MIME
            ? JSON.stringify({ id: "artifact:drag", name: "screenshot.png", mimeType: "image/png" })
            : ""
      }
    });

    await waitFor(() => expect(apiMock.uploadCliFiles).toHaveBeenCalledTimes(1));
    const uploadInput = apiMock.uploadCliFiles.mock.calls[0]?.[0] as { paneId: string; source: string; files: File[] };
    expect(uploadInput.source).toBe("DROP");
    const droppedFile = uploadInput.files[0]!;
    expect(droppedFile.name).toBe("screenshot.png");
    expect(droppedFile.type).toBe("image/png");
    expect(await readFileText(droppedFile)).toBe("artifact bytes");
    expect(fetchMock.mock.calls.filter(([input]) => String(input) === artifactFileUrl)).toHaveLength(1);
    vi.unstubAllGlobals();
  });

  it("does not fall back to inline clipboard text when the automatic TXT upload fails", async () => {
    apiMock.uploadCliFiles.mockRejectedValueOnce(new Error("Clipboard TXT upload failed"));
    render(<TerminalPane pane={cliPane()} terminalFontSize={12} />);

    await waitFor(() => expect(apiMock.createCliSession).toHaveBeenCalled());
    await waitFor(() => expect(MockWebSocket.instances[0]?.readyState).toBe(MockWebSocket.OPEN));
    const socket = MockWebSocket.instances[0]!;
    socket.sent.length = 0;
    const clipText = "short clip that must still be a file";

    window.dispatchEvent(new CustomEvent("space:terminal-pane-action", {
      detail: { paneId: "pane:cli-upload", action: "insert_clipboard_text", text: clipText }
    }));

    expect(await screen.findByText("Clipboard TXT upload failed")).toBeTruthy();
    expect(apiMock.uploadCliFiles).toHaveBeenCalledTimes(1);
    expect(socket.sent).toEqual([]);
  });

  it("ignores the legacy clipboard debug flag until CLI debug mode is enabled", async () => {
    window.localStorage.setItem("space.clipboardDebug", "true");
    render(<TerminalPane pane={cliPane()} terminalFontSize={12} />);

    await waitFor(() => expect(apiMock.createCliSession).toHaveBeenCalled());
    await waitFor(() => expect(MockWebSocket.instances[0]?.readyState).toBe(MockWebSocket.OPEN));

    window.dispatchEvent(
      new CustomEvent("space:terminal-pane-action", {
        detail: { paneId: "pane:cli-upload", action: "insert_text", text: "/opt/spaceapp/var/artifacts/cli-uploads/from-clip-tool.png " }
      })
    );

    await waitFor(() => expect(MockWebSocket.instances[0]?.sent.some((frame) => frame.includes("from-clip-tool.png"))).toBe(false));
    expect(screen.queryByText(/Clipboard debug/i)).toBeNull();
    expect(screen.queryByText(/terminal action image path suppressed/i)).toBeNull();
  });

  it("shows clipboard debug when CLI debug mode is enabled", async () => {
    window.localStorage.setItem("space.cliDebugMode", "true");
    render(<TerminalPane pane={cliPane()} terminalFontSize={12} />);

    await waitFor(() => expect(apiMock.createCliSession).toHaveBeenCalled());
    await waitFor(() => expect(MockWebSocket.instances[0]?.readyState).toBe(MockWebSocket.OPEN));

    window.dispatchEvent(
      new CustomEvent("space:terminal-pane-action", {
        detail: { paneId: "pane:cli-upload", action: "insert_text", text: "/opt/spaceapp/var/artifacts/cli-uploads/from-clip-tool.png " }
      })
    );

    await waitFor(() => expect(MockWebSocket.instances[0]?.sent.some((frame) => frame.includes("from-clip-tool.png"))).toBe(false));
    expect(await screen.findByText(/Clipboard debug/i)).toBeTruthy();
    expect(await screen.findByText(/terminal action image path suppressed/i)).toBeTruthy();
  });

  it("lets operators close the visible CLI debug panel manually", async () => {
    window.localStorage.setItem("space.cliDebugMode", "true");
    render(<TerminalPane pane={cliPane()} terminalFontSize={12} />);

    await waitFor(() => expect(apiMock.createCliSession).toHaveBeenCalled());
    await waitFor(() => expect(MockWebSocket.instances[0]?.readyState).toBe(MockWebSocket.OPEN));

    window.dispatchEvent(
      new CustomEvent("space:terminal-pane-action", {
        detail: { paneId: "pane:cli-upload", action: "insert_text", text: "/opt/spaceapp/var/artifacts/cli-uploads/from-clip-tool.png " }
      })
    );

    expect(await screen.findByText(/Clipboard debug/i)).toBeTruthy();
    fireEvent.click(await screen.findByLabelText("Close CLI debug panel"));
    await waitFor(() => expect(screen.queryByText(/Clipboard debug/i)).toBeNull());
  });

  it("routes Shift+Tab and Escape quick actions into the active CLI session", async () => {
    render(<TerminalPane pane={cliPane()} terminalFontSize={12} />);

    await waitFor(() => expect(apiMock.createCliSession).toHaveBeenCalled());
    await waitFor(() => expect(MockWebSocket.instances[0]?.readyState).toBe(MockWebSocket.OPEN));

    window.dispatchEvent(
      new CustomEvent("space:terminal-pane-action", {
        detail: { paneId: "pane:cli-upload", action: "control_key", key: "shift_tab" }
      })
    );
    window.dispatchEvent(
      new CustomEvent("space:terminal-pane-action", {
        detail: { paneId: "pane:cli-upload", action: "control_key", key: "escape" }
      })
    );

    await waitFor(() =>
      expect(MockWebSocket.instances[0]?.sent).toEqual(
        expect.arrayContaining([
          JSON.stringify({ type: "input", data: "\u001b[Z" }),
          JSON.stringify({ type: "input", data: "\u001b" })
        ])
      )
    );
  });

  it.each([
    ["cli:codex", ["/plan", "\r"], ["/permissions", "\r"]],
    ["cli:gemini", ["\u001b[Z"], ["/permissions", "\r"]],
    ["cli:qwen", ["/plan", "\r"], ["/approval-mode", "\r"]],
    ["cli:autohand", ["/plan", "\r"], ["/permissions", "\r"]],
    ["cli:kimi", ["/plan", "\r"], ["/permission", "\r"]],
    ["cli:grok", ["/plan", "\r"], ["/always-approve", "\r"]],
    ["cli:cursor", ["/plan", "\r"], ["/settings", "\r"]],
    ["cli:copilot", ["\u001b[Z"], ["/permissions", "\r"]],
    ["cli:deepseek", ["\u001b[Z"], ["\u0019"]],
    ["cli:opencode", ["\t"], ["\u0010", "auto-approve permissions"]],
    ["cli:hermes", ["/plan "], ["/yolo", "\r"]]
  ] as const)("routes both mode shortcuts through the owning %s session", async (runtimeId, plan, permissions) => {
    apiMock.activeCliSession.mockResolvedValueOnce(cliSessionResponse("ticket", "IDLE", true, { runtimeId, sessionId: "cli_session:modes" }));
    apiMock.cliTerminalWebSocketUrl.mockImplementation((ticket: { paneId: string; sessionId: string }) =>
      `ws://space.test/terminal?paneId=${encodeURIComponent(ticket.paneId)}&sessionId=${encodeURIComponent(ticket.sessionId)}&runtimeId=${encodeURIComponent(runtimeId)}`);
    render(<TerminalPane pane={cliPane({ terminalRuntimeId: runtimeId })} terminalFontSize={12} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "CLI shortcuts" }).hasAttribute("disabled")).toBe(false));
    const socket = MockWebSocket.instances[0]!;
    const inputs = () => socket.sent.map(frame => JSON.parse(frame)).filter(frame => frame.type === "input").map(frame => frame.data);
    for (const [commandId, expected] of [["permissions", permissions], ["plan", plan]] as const) {
      socket.sent.length = 0;
      act(() => window.dispatchEvent(new CustomEvent("space:terminal-pane-action", { detail: { paneId: "pane:other", action: "cli_shortcut", commandId } })));
      expect(inputs()).toEqual([]);
      act(() => window.dispatchEvent(new CustomEvent("space:terminal-pane-action", { detail: { paneId: "pane:cli-upload", action: "cli_shortcut", commandId } })));
      await waitFor(() => expect(inputs()).toEqual(expected));
      expect(socket.sent.map(frame => JSON.parse(frame)).some(frame => frame.turnMarker)).toBe(false);
    }
  });

  it.each(["cli:omp", "cli:droid", "cli:muse"] as const)("stops a %s task from the pane menu with Escape, its own interrupt key", async (runtimeId) => {
    apiMock.activeCliSession.mockResolvedValueOnce(cliSessionResponse("ticket", "IDLE", true, { runtimeId, sessionId: "cli_session:stop" }));
    apiMock.cliTerminalWebSocketUrl.mockImplementation((ticket: { paneId: string; sessionId: string }) =>
      `ws://space.test/terminal?paneId=${encodeURIComponent(ticket.paneId)}&sessionId=${encodeURIComponent(ticket.sessionId)}&runtimeId=${encodeURIComponent(runtimeId)}`);
    render(<TerminalPane pane={cliPane({ terminalRuntimeId: runtimeId })} terminalFontSize={12} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "CLI shortcuts" }).hasAttribute("disabled")).toBe(false));
    const socket = MockWebSocket.instances[0]!;
    const inputs = () => socket.sent.map(frame => JSON.parse(frame)).filter(frame => frame.type === "input").map(frame => frame.data);
    socket.sent.length = 0;
    act(() => window.dispatchEvent(new CustomEvent("space:terminal-pane-action", { detail: { paneId: "pane:cli-upload", action: "stop_task" } })));
    await waitFor(() => expect(inputs()).toEqual(["\u001b"]));
  });

  it.each([
    ["cli:codex", ["/plan", "\r"]],
    ["cli:opencode", ["\t"]],
    ["cli:kimi", ["/plan", "\r"]],
    ["cli:deepseek", ["\u001b[Z"]]
  ] as const)("enables Plan mode from the pane menu with the native %s control", async (runtimeId, expected) => {
    apiMock.activeCliSession.mockResolvedValueOnce(cliSessionResponse("ticket", "IDLE", true, { runtimeId, sessionId: "cli_session:menu-plan" }));
    apiMock.cliTerminalWebSocketUrl.mockImplementation((ticket: { paneId: string; sessionId: string }) =>
      `ws://space.test/terminal?paneId=${encodeURIComponent(ticket.paneId)}&sessionId=${encodeURIComponent(ticket.sessionId)}&runtimeId=${encodeURIComponent(runtimeId)}`);
    render(<TerminalPane pane={cliPane({ terminalRuntimeId: runtimeId })} terminalFontSize={12} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "CLI shortcuts" }).hasAttribute("disabled")).toBe(false));
    const socket = MockWebSocket.instances[0]!;
    const inputs = () => socket.sent.map(frame => JSON.parse(frame)).filter(frame => frame.type === "input").map(frame => frame.data);
    socket.sent.length = 0;

    act(() => window.dispatchEvent(new CustomEvent("space:terminal-pane-action", { detail: { paneId: "pane:cli-upload", action: "enable_plan_mode" } })));

    await waitFor(() => expect(inputs()).toEqual(expected));
  });

  it("never toggles Plan mode off when the pane menu asks to enable it", async () => {
    apiMock.activeCliSession.mockResolvedValueOnce(cliSessionResponse("ticket", "IDLE", true, { runtimeId: "cli:opencode", sessionId: "cli_session:menu-plan-on" }));
    apiMock.cliTerminalWebSocketUrl.mockImplementation((ticket: { paneId: string; sessionId: string }) =>
      `ws://space.test/terminal?paneId=${encodeURIComponent(ticket.paneId)}&sessionId=${encodeURIComponent(ticket.sessionId)}&runtimeId=cli%3Aopencode`);
    render(<TerminalPane pane={cliPane({ terminalRuntimeId: "cli:opencode" })} terminalFontSize={12} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "CLI shortcuts" }).hasAttribute("disabled")).toBe(false));
    const socket = MockWebSocket.instances[0]!;
    xtermMock.instances[0]!.screenText = ["┃  Plan  DeepSeek V4 Flash Free", "tab agents  ctrl+p commands"].join("\n");
    socket.sent.length = 0;

    act(() => window.dispatchEvent(new CustomEvent("space:terminal-pane-action", { detail: { paneId: "pane:cli-upload", action: "enable_plan_mode" } })));

    expect(await screen.findByText("Plan mode is already on.")).toBeTruthy();
    expect(socket.sent.filter(frame => JSON.parse(frame).type === "input")).toHaveLength(0);
  });

  it("refuses native /plan while a CLI draft would swallow it", async () => {
    apiMock.activeCliSession.mockResolvedValueOnce(cliSessionResponse("ticket", "IDLE", true, { runtimeId: "cli:gemini", sessionId: "cli_session:gemini-draft" }));
    apiMock.cliTerminalWebSocketUrl.mockImplementation((ticket: { paneId: string; sessionId: string }) =>
      `ws://space.test/terminal?paneId=${encodeURIComponent(ticket.paneId)}&sessionId=${encodeURIComponent(ticket.sessionId)}&runtimeId=cli%3Agemini`);
    render(<TerminalPane pane={cliPane({ terminalRuntimeId: "cli:gemini" })} terminalFontSize={12} />);
    await waitFor(() => expect(MockWebSocket.instances[0]?.readyState).toBe(MockWebSocket.OPEN));
    const socket = MockWebSocket.instances[0]!;
    xtermMock.instances[0]!.emitData("fix the bug");
    socket.sent.length = 0;

    act(() => window.dispatchEvent(new CustomEvent("space:terminal-pane-action", {
      detail: { paneId: "pane:cli-upload", action: "enter_native_plan_mode", runtimeId: "cli:gemini" }
    })));

    expect(await screen.findByText("Send or clear the current CLI draft before changing modes.")).toBeTruthy();
    expect(socket.sent.filter(frame => frame.includes("/plan"))).toHaveLength(0);
  });

  it("switches Claude to Plan and back to Build from the shortcuts with Shift+Tab, keeping the draft", async () => {
    apiMock.activeCliSession.mockResolvedValueOnce(cliSessionResponse("ticket", "IDLE", true, { runtimeId: "cli:claude", sessionId: "cli_session:claude-draft" }));
    apiMock.cliTerminalWebSocketUrl.mockImplementation((ticket: { paneId: string; sessionId: string }) =>
      `ws://space.test/terminal?paneId=${encodeURIComponent(ticket.paneId)}&sessionId=${encodeURIComponent(ticket.sessionId)}&runtimeId=cli%3Aclaude`);
    render(<TerminalPane pane={cliPane({ terminalRuntimeId: "cli:claude" })} terminalFontSize={12} />);
    await waitFor(() => expect(MockWebSocket.instances[0]?.readyState).toBe(MockWebSocket.OPEN));
    const socket = MockWebSocket.instances[0]!;
    const terminal = xtermMock.instances[0]!;
    const inputs = () => socket.sent.map(frame => JSON.parse(frame)).filter(frame => frame.type === "input").map(frame => frame.data);
    const footer = (mode: string) => { terminal.screenText = ["❯ build me a dock", `  ${mode} on (shift+tab to cycle) · ← for agents`].join("\n"); };
    footer("⏵⏵ bypass permissions");
    socket.sent.length = 0;
    act(() => window.dispatchEvent(new CustomEvent("space:terminal-pane-action", { detail: { paneId: "pane:cli-upload", action: "cli_shortcut", commandId: "permissions" } })));
    await waitFor(() => expect(inputs()).toEqual(["/permissions", "\r"]));
    await waitFor(() => expect(screen.getByRole("button", { name: "CLI shortcuts" }).hasAttribute("disabled")).toBe(false));
    terminal.emitData("build me a dock");
    socket.sent.length = 0;

    act(() => window.dispatchEvent(new CustomEvent("space:terminal-pane-action", { detail: { paneId: "pane:cli-upload", action: "cli_shortcut", commandId: "plan" } })));
    await waitFor(() => expect(inputs()).toEqual(["\u001b[Z"]));
    footer("⏸ plan mode");
    await waitFor(() => expect(screen.getByRole("button", { name: "CLI shortcuts" }).hasAttribute("disabled")).toBe(false));

    act(() => window.dispatchEvent(new CustomEvent("space:terminal-pane-action", { detail: { paneId: "pane:cli-upload", action: "cli_shortcut", commandId: "build" } })));
    await waitFor(() => expect(inputs()).toEqual(["\u001b[Z", "\u001b[Z"]));
    footer("⏵⏵ bypass permissions");
    expect(await screen.findByText("Build mode is ready. Send a task to continue.")).toBeTruthy();
    expect(screen.queryByText("Send or clear the current CLI draft before changing modes.")).toBeNull();
  });

  it("stops a Codex task from the pane menu with Escape", async () => {
    render(<TerminalPane pane={cliPane()} terminalFontSize={12} />);
    await waitFor(() => expect(MockWebSocket.instances[0]?.readyState).toBe(MockWebSocket.OPEN));
    const socket = MockWebSocket.instances[0]!;
    socket.sent.length = 0;

    act(() => window.dispatchEvent(new CustomEvent("space:terminal-pane-action", { detail: { paneId: "pane:cli-upload", action: "stop_task" } })));

    await waitFor(() => expect(socket.sent).toContain(JSON.stringify({ type: "input", data: "\u001b" })));
    expect(socket.sent).not.toContain(JSON.stringify({ type: "input", data: "\u0003" }));
  });

  it("does not send Ctrl+C to an idle CLI from the pane menu Stop action", async () => {
    apiMock.activeCliSession.mockResolvedValueOnce(cliSessionResponse("ticket", "IDLE", true, { runtimeId: "cli:gemini", sessionId: "cli_session:gemini-idle" }));
    apiMock.cliTerminalWebSocketUrl.mockImplementation((ticket: { paneId: string; sessionId: string }) =>
      `ws://space.test/terminal?paneId=${encodeURIComponent(ticket.paneId)}&sessionId=${encodeURIComponent(ticket.sessionId)}&runtimeId=cli%3Agemini`);
    render(<TerminalPane pane={cliPane({ terminalRuntimeId: "cli:gemini" })} terminalFontSize={12} />);
    await waitFor(() => expect(MockWebSocket.instances[0]?.readyState).toBe(MockWebSocket.OPEN));
    const socket = MockWebSocket.instances[0]!;
    socket.sent.length = 0;

    act(() => window.dispatchEvent(new CustomEvent("space:terminal-pane-action", { detail: { paneId: "pane:cli-upload", action: "stop_task" } })));

    expect(await screen.findByText("No running CLI task to stop.")).toBeTruthy();
    expect(socket.sent.filter(frame => JSON.parse(frame).type === "input")).toHaveLength(0);
  });

  it("stops a redrawing Ctrl+C CLI once and refuses a second Ctrl+C during the cooldown", async () => {
    apiMock.activeCliSession.mockResolvedValueOnce(cliSessionResponse("ticket", "IDLE", true, { runtimeId: "cli:gemini", sessionId: "cli_session:gemini-busy" }));
    apiMock.cliTerminalWebSocketUrl.mockImplementation((ticket: { paneId: string; sessionId: string }) =>
      `ws://space.test/terminal?paneId=${encodeURIComponent(ticket.paneId)}&sessionId=${encodeURIComponent(ticket.sessionId)}&runtimeId=cli%3Agemini`);
    const availability = vi.fn();
    render(<TerminalPane pane={cliPane({ terminalRuntimeId: "cli:gemini" })} terminalFontSize={12} onActionAvailabilityChange={availability} />);
    await waitFor(() => expect(MockWebSocket.instances[0]?.readyState).toBe(MockWebSocket.OPEN));
    const socket = MockWebSocket.instances[0]!;
    const terminal = xtermMock.instances[0]!;
    const redraw = (frame: string) => act(() => {
      terminal.screenText = frame;
      socket.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "output", stream: "stdout", data: frame }) }));
    });
    redraw("Analysing the repository (1s)");
    redraw("Analysing the repository (2s)");
    await waitFor(() => expect(availability.mock.calls.at(-1)?.[0]?.screenActive).toBe(true));
    socket.sent.length = 0;
    const ctrlC = JSON.stringify({ type: "input", data: "\u0003" });

    act(() => window.dispatchEvent(new CustomEvent("space:terminal-pane-action", { detail: { paneId: "pane:cli-upload", action: "stop_task" } })));
    await waitFor(() => expect(socket.sent.filter((frame) => frame === ctrlC)).toHaveLength(1));
    await waitFor(() => expect(availability.mock.calls.at(-1)?.[0]?.stopCooldown).toBe(true));

    act(() => window.dispatchEvent(new CustomEvent("space:terminal-pane-action", { detail: { paneId: "pane:cli-upload", action: "stop_task" } })));
    expect(await screen.findByText("No running CLI task to stop.")).toBeTruthy();
    expect(socket.sent.filter((frame) => frame === ctrlC)).toHaveLength(1);
  });

  it("shares one interrupt cooldown between the floating Stop and the pane menu Stop", async () => {
    apiMock.cliTurnActivity.mockImplementation(() => new Promise(() => undefined));
    render(<TerminalPane pane={cliPane()} terminalFontSize={12} />);
    await waitFor(() => expect(MockWebSocket.instances[0]?.readyState).toBe(MockWebSocket.OPEN));
    const socket = MockWebSocket.instances[0]!;
    xtermMock.instances[0]?.emitData("Explain this change");
    fireEvent.click(await screen.findByRole("button", { name: "Send prompt" }));
    fireEvent.click(await screen.findByRole("button", { name: "Stop Codex" }));
    const esc = JSON.stringify({ type: "input", data: "\u001b" });
    expect(socket.sent.filter((frame) => frame === esc)).toHaveLength(1);

    act(() => window.dispatchEvent(new CustomEvent("space:terminal-pane-action", { detail: { paneId: "pane:cli-upload", action: "stop_task" } })));
    expect(await screen.findByText("No running CLI task to stop.")).toBeTruthy();
    expect(socket.sent.filter((frame) => frame === esc)).toHaveLength(1);
  });

  it("stops an OpenCode task through the OpenCode abort API instead of Ctrl+C", async () => {
    apiMock.activeCliSession.mockResolvedValueOnce(cliSessionResponse("ticket", "RUNNING", true, { runtimeId: "cli:opencode", sessionId: "cli_session:opencode-stop" }));
    apiMock.abortCliTurn.mockResolvedValue({ ok: true, isTurnActive: false });
    apiMock.cliTerminalWebSocketUrl.mockImplementation((ticket: { paneId: string; sessionId: string }) =>
      `ws://space.test/terminal?paneId=${encodeURIComponent(ticket.paneId)}&sessionId=${encodeURIComponent(ticket.sessionId)}&runtimeId=cli%3Aopencode`);
    render(<TerminalPane pane={cliPane({ terminalRuntimeId: "cli:opencode" })} terminalFontSize={12} />);
    await waitFor(() => expect(MockWebSocket.instances[0]?.readyState).toBe(MockWebSocket.OPEN));
    const socket = MockWebSocket.instances[0]!;
    socket.sent.length = 0;

    act(() => window.dispatchEvent(new CustomEvent("space:terminal-pane-action", { detail: { paneId: "pane:cli-upload", action: "stop_task" } })));

    await waitFor(() => expect(apiMock.abortCliTurn).toHaveBeenCalledWith("pane:cli-upload"));
    expect(socket.sent).not.toContain(JSON.stringify({ type: "input", data: "\u0003" }));
  });

  it("publishes live menu availability as the CLI attaches, gets a draft, runs and enters Plan mode", async () => {
    const availability = vi.fn();
    apiMock.activeCliSession.mockResolvedValueOnce(cliSessionResponse("ticket", "IDLE", true, { runtimeId: "cli:opencode", sessionId: "cli_session:availability" }));
    apiMock.cliTerminalWebSocketUrl.mockImplementation((ticket: { paneId: string; sessionId: string }) =>
      `ws://space.test/terminal?paneId=${encodeURIComponent(ticket.paneId)}&sessionId=${encodeURIComponent(ticket.sessionId)}&runtimeId=cli%3Aopencode`);
    render(<TerminalPane pane={cliPane({ terminalRuntimeId: "cli:opencode" })} terminalFontSize={12} onActionAvailabilityChange={availability} />);
    const latest = () => availability.mock.calls.at(-1)?.[0];

    await waitFor(() => expect(latest()).toMatchObject({
      hasSession: true,
      sessionActive: true,
      attached: true,
      controllable: true,
      turnRunning: false,
      hasDraft: false,
      runtimeReady: true,
      promptSeen: false
    }));
    const socket = MockWebSocket.instances[0]!;
    const terminal = xtermMock.instances[0]!;

    act(() => terminal.emitData("half typed"));
    await waitFor(() => expect(latest()?.hasDraft).toBe(true));

    terminal.screenText = ["┃  Plan  DeepSeek V4 Flash Free", "tab agents  ctrl+p commands"].join("\n");
    act(() => {
      socket.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "output", stream: "stdout", data: "mode\n" }) }));
    });
    await waitFor(() => expect(latest()?.planMode).toBe("plan"));
    expect(latest()?.promptSeen).toBe(true);
  });

  it("inserts quoted file paths, not prompt labels, when uploading into the root shell", async () => {
    apiMock.activeCliSession.mockResolvedValueOnce(cliSessionResponse("ticket", "IDLE", true, { runtimeId: "cli:root", sessionId: "cli_session:root-upload" }));
    apiMock.cliTerminalWebSocketUrl.mockImplementation((ticket: { paneId: string; sessionId: string }) =>
      `ws://space.test/terminal?paneId=${encodeURIComponent(ticket.paneId)}&sessionId=${encodeURIComponent(ticket.sessionId)}&runtimeId=cli%3Aroot`);
    render(<TerminalPane pane={cliPane({ terminalRuntimeId: "cli:root" })} terminalFontSize={12} />);
    await waitFor(() => expect(MockWebSocket.instances[0]?.readyState).toBe(MockWebSocket.OPEN));
    const socket = MockWebSocket.instances[0]!;

    const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
    const file = new File(["document"], "notes.pdf", { type: "application/pdf" });
    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() =>
      expect(socket.sent).toContain(JSON.stringify({ type: "input", data: "'/opt/spaceapp/var/artifacts/cli-uploads/notes.pdf' " }))
    );
    expect(socket.sent.some((frame) => frame.includes("[File #"))).toBe(false);
  });

  it("explains that New task must wait for the runtime instead of wiping the screen", async () => {
    apiMock.cliRuntimes.mockReset();
    apiMock.cliRuntimes.mockReturnValue(new Promise(() => {}));
    apiMock.cliRuntimesSnapshot?.mockReturnValue?.(null);
    render(<TerminalPane pane={cliPane()} terminalFontSize={12} />);

    act(() => window.dispatchEvent(new CustomEvent("space:terminal-pane-action", { detail: { paneId: "pane:cli-upload", action: "new_task" } })));

    expect(await screen.findByText("The CLI runtime is still loading. Try New task again in a moment.")).toBeTruthy();
    expect(apiMock.createCliSession).not.toHaveBeenCalledWith("pane:cli-upload", expect.objectContaining({ forceRestart: true }));
  });

  it("routes esc and enter CLI shortcuts into the active CLI session", async () => {
    render(<TerminalPane pane={cliPane()} terminalFontSize={12} />);

    await waitFor(() => expect(apiMock.createCliSession).toHaveBeenCalled());
    await waitFor(() => expect(MockWebSocket.instances[0]?.readyState).toBe(MockWebSocket.OPEN));
    const socket = MockWebSocket.instances[0]!;
    socket.sent.length = 0;

    act(() => {
      window.dispatchEvent(
        new CustomEvent("space:terminal-pane-action", {
          detail: { paneId: "pane:cli-upload", action: "cli_shortcut", commandId: "esc" }
        })
      );
    });

    await waitFor(() => {
      const inputs = socket.sent
        .map((frame) => JSON.parse(frame) as { type?: string; data?: string })
        .filter((frame) => frame.type === "input")
        .map((frame) => frame.data);
      expect(inputs).toContain("\u001b");
    });

    socket.sent.length = 0;
    act(() => {
      window.dispatchEvent(
        new CustomEvent("space:terminal-pane-action", {
          detail: { paneId: "pane:cli-upload", action: "cli_shortcut", commandId: "enter" }
        })
      );
    });

    await waitFor(() => {
      const inputs = socket.sent
        .map((frame) => JSON.parse(frame) as { type?: string; data?: string })
        .filter((frame) => frame.type === "input")
        .map((frame) => frame.data);
      expect(inputs).toContain("\r");
    });
  });

  it("routes scroll_top and scroll_bottom CLI shortcuts to scroll the active terminal", async () => {
    render(<TerminalPane pane={cliPane()} terminalFontSize={12} />);

    await waitFor(() => expect(apiMock.createCliSession).toHaveBeenCalled());
    await waitFor(() => expect(MockWebSocket.instances[0]?.readyState).toBe(MockWebSocket.OPEN));
    const terminal = xtermMock.instances[0]!;
    terminal.baseY = 50;
    terminal.viewportY = 50;

    const initialTopCalls = terminal.scrollToTopCalls;
    const initialBottomCalls = terminal.scrollToBottomCalls;

    act(() => {
      window.dispatchEvent(
        new CustomEvent("space:terminal-pane-action", {
          detail: { paneId: "pane:cli-upload", action: "cli_shortcut", commandId: "scroll_top" }
        })
      );
    });

    expect(terminal.scrollToTopCalls).toBe(initialTopCalls + 1);
    expect(terminal.viewportY).toBe(0);

    act(() => {
      window.dispatchEvent(
        new CustomEvent("space:terminal-pane-action", {
          detail: { paneId: "pane:cli-upload", action: "cli_shortcut", commandId: "scroll_bottom" }
        })
      );
    });

    expect(terminal.scrollToBottomCalls).toBeGreaterThan(initialBottomCalls);
    expect(terminal.viewportY).toBe(terminal.baseY);
  });

  it("routes on-screen keyboard characters and Enter into the active CLI WebSocket", async () => {
    render(<TerminalPane pane={cliPane()} terminalFontSize={12} />);

    await waitFor(() => expect(apiMock.createCliSession).toHaveBeenCalled());
    await waitFor(() => expect(MockWebSocket.instances[0]?.readyState).toBe(MockWebSocket.OPEN));
    const socket = MockWebSocket.instances[0]!;
    socket.sent.length = 0;

    window.dispatchEvent(
      new CustomEvent("space:terminal-pane-action", {
        detail: { paneId: "pane:cli-upload", action: "keyboard_input", text: "q" }
      })
    );
    window.dispatchEvent(
      new CustomEvent("space:terminal-pane-action", {
        detail: { paneId: "pane:cli-upload", action: "keyboard_input", text: "\r" }
      })
    );

    await waitFor(() => {
      const inputs = socket.sent
        .map((frame) => JSON.parse(frame) as { type?: string; data?: string })
        .filter((frame) => frame.type === "input")
        .map((frame) => frame.data);
      expect(inputs).toEqual(["q", "\r"]);
    });
  });

  it("does not turn a held physical Escape key into an OpenCode double-Escape", async () => {
    render(
      <VoiceInputProvider>
        <TerminalPane pane={cliPane({ terminalRuntimeId: "cli:opencode" })} terminalFontSize={12} />
      </VoiceInputProvider>
    );

    await waitFor(() => expect(apiMock.createCliSession).toHaveBeenCalled());
    await waitFor(() => expect(MockWebSocket.instances[0]?.readyState).toBe(MockWebSocket.OPEN));
    const socket = MockWebSocket.instances[0]!;
    const terminal = xtermMock.instances[0]!;
    const textarea = terminal.textarea!;
    socket.sent.length = 0;
    textarea.addEventListener("keydown", (event) => {
      if (event.key === "Escape") terminal.emitData("\u001b");
    });

    fireEvent.keyDown(textarea, { key: "Escape", code: "Escape", repeat: false });
    fireEvent.keyDown(textarea, { key: "Escape", code: "Escape", repeat: true });

    await waitFor(() => {
      const inputs = socket.sent
        .map((frame) => JSON.parse(frame) as { type?: string; data?: string })
        .filter((frame) => frame.type === "input")
        .map((frame) => frame.data);
      expect(inputs).toEqual(["\u001b"]);
    });
  });

  it("supports DeepSeek file selection and Clip Tool uploads with managed prompt tokens", async () => {
    // 55d7225f43 enabled DeepSeek uploads; 3a532bf2a1 (wip) accidentally restored the older expectation.
    const deepseekSession = cliSessionResponse("terminal-ws-ticket-deepseek", "IDLE", true, {
      runtimeId: "cli:deepseek",
      sessionId: "cli_session:deepseek"
    });
    apiMock.cliRuntimes.mockResolvedValueOnce({
      data: [deepseekSession.runtime],
      checkedAt: "2026-07-22T18:00:00.000Z"
    });
    apiMock.activeCliSession.mockResolvedValueOnce(deepseekSession);
    apiMock.cliTerminalWebSocketUrl.mockImplementation(
      (ticket: { paneId: string; sessionId: string }) =>
        `ws://space.test/terminal?paneId=${encodeURIComponent(ticket.paneId)}` +
        `&sessionId=${encodeURIComponent(ticket.sessionId)}&runtimeId=cli%3Adeepseek`
    );
    const deepseekPane = { ...cliPane(), title: "DeepSeek CLI", terminalRuntimeId: "cli:deepseek" };
    render(<TerminalPane pane={deepseekPane} terminalFontSize={12} />);

    await waitFor(() => expect(MockWebSocket.instances[0]?.readyState).toBe(MockWebSocket.OPEN));
    const socket = MockWebSocket.instances[0]!;
    socket.sent.length = 0;
    const fileInput = document.querySelector<HTMLInputElement>(`input[name="cli-files-${deepseekPane.id}"]`)!;
    expect(fileInput).toBeTruthy();
    const openChooser = vi.spyOn(fileInput, "click");
    act(() => {
      window.dispatchEvent(new CustomEvent("space:terminal-pane-action", {
        detail: { paneId: deepseekPane.id, action: "upload" }
      }));
    });
    expect(openChooser).toHaveBeenCalledOnce();
    expect(screen.queryByText("DeepSeek CLI is text-only. File and image uploads are unavailable.")).toBeNull();
    expect(apiMock.uploadCliFiles).not.toHaveBeenCalled();

    const clipImage = new File(["png"], "clip.png", { type: "image/png" });
    act(() => {
      window.dispatchEvent(new CustomEvent("space:terminal-pane-action", {
        detail: {
          paneId: deepseekPane.id,
          action: "attach_clip_image",
          file: clipImage
        }
      }));
    });
    await waitFor(() =>
      expect(apiMock.uploadCliFiles).toHaveBeenCalledWith({
        paneId: deepseekPane.id,
        source: "SCREEN_CAPTURE",
        files: [clipImage]
      })
    );
    // Since e4b7245d92 non-Codex CLIs receive a managed [Image #N] token; the path is sent hidden on submit.
    await waitFor(() =>
      expect(socket.sent).toContain(JSON.stringify({ type: "input", data: "[Image #1] " }))
    );
    expect(socket.sent.some((frame) => frame.includes("/opt/spaceapp/var/artifacts/cli-uploads/"))).toBe(false);
  });

  it.each(["cli:gemini", "cli:qwen"] as const)(
    "sends native /plan only when the active %s session and requested runtime match",
    async (runtimeId) => {
      const otherRuntimeId = runtimeId === "cli:gemini" ? "cli:qwen" : "cli:gemini";
      apiMock.activeCliSession.mockResolvedValueOnce(
        cliSessionResponse(`terminal-ws-ticket-${runtimeId}`, "IDLE", true, {
          runtimeId,
          sessionId: `cli_session:${runtimeId}`
        })
      );
      apiMock.cliTerminalWebSocketUrl.mockImplementation(
        (ticket: { paneId: string; sessionId: string }) =>
          `ws://space.test/terminal?paneId=${encodeURIComponent(ticket.paneId)}` +
          `&sessionId=${encodeURIComponent(ticket.sessionId)}&runtimeId=${encodeURIComponent(runtimeId)}`
      );
      render(<TerminalPane pane={{ ...cliPane(), terminalRuntimeId: runtimeId }} terminalFontSize={12} />);

      await waitFor(() => expect(MockWebSocket.instances[0]?.readyState).toBe(MockWebSocket.OPEN));
      const socket = MockWebSocket.instances[0]!;
      const planFrame = JSON.stringify({ type: "input", data: "/plan\r" });

      window.dispatchEvent(
        new CustomEvent("space:terminal-pane-action", {
          detail: { paneId: "pane:cli-upload", action: "enter_native_plan_mode", runtimeId: otherRuntimeId }
        })
      );
      expect(socket.sent.filter((frame) => frame === planFrame)).toHaveLength(0);

      window.dispatchEvent(
        new CustomEvent("space:terminal-pane-action", {
          detail: { paneId: "pane:cli-upload", action: "enter_native_plan_mode", runtimeId }
        })
      );
      await waitFor(() => expect(socket.sent.filter((frame) => frame === planFrame)).toHaveLength(1));
    }
  );

  it.each([
    ["default mode", 2],
    ["accept edits on", 1],
    ["plan mode on", 0],
    ["bypass permissions on", 4],
    ["auto mode on", 3]
  ] as const)("deterministically enables Claude Plan mode from %s", async (currentMode, expectedShiftTabs) => {
    const claudeSession = cliSessionResponse("terminal-ws-ticket-claude", "IDLE", true, { runtimeId: "cli:claude" });
    apiMock.activeCliSession.mockResolvedValueOnce(claudeSession);
    apiMock.cliTerminalWebSocketUrl.mockImplementation(
      (ticket: { paneId: string; sessionId: string }) =>
        `ws://space.test/terminal?paneId=${encodeURIComponent(ticket.paneId)}` +
        `&sessionId=${encodeURIComponent(ticket.sessionId)}&runtimeId=cli%3Aclaude`
    );
    render(<TerminalPane pane={cliPane()} terminalFontSize={12} />);

    await waitFor(() => expect(MockWebSocket.instances[0]?.readyState).toBe(MockWebSocket.OPEN));
    const socket = MockWebSocket.instances[0]!;
    const modeCycle = ["default mode", "accept edits on", "plan mode on", "bypass permissions on", "auto mode on"] as const;
    const renderedMode = (mode: (typeof modeCycle)[number]) =>
      mode === "default mode" ? "? for shortcuts · ← for agents" : `${mode} (shift+tab to cycle) · ← for agents`;
    let modeIndex = modeCycle.indexOf(currentMode);
    socket.onSend = (frame) => {
      if (frame !== JSON.stringify({ type: "input", data: "\u001b[Z" })) return;
      modeIndex = (modeIndex + 1) % modeCycle.length;
      const nextMode = modeCycle[modeIndex]!;
      socket.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({ type: "output", stream: "stdout", data: `\u001b[2JClaude Code\n${renderedMode(nextMode)}` })
        })
      );
    };
    act(() => {
      socket.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({ type: "output", stream: "stdout", data: `\u001b[2JClaude Code\n${renderedMode(currentMode)}` })
        })
      );
    });

    window.dispatchEvent(
      new CustomEvent("space:terminal-pane-action", {
        detail: { paneId: "pane:cli-upload", action: "ensure_plan_mode" }
      })
    );
    expect(xtermMock.instances[0]?.screenText).toContain(
      renderedMode(modeCycle[(modeCycle.indexOf(currentMode) + Math.min(1, expectedShiftTabs)) % modeCycle.length]!)
    );
    window.dispatchEvent(
      new CustomEvent("space:terminal-pane-action", {
        detail: { paneId: "pane:cli-upload", action: "ensure_plan_mode" }
      })
    );
    expect(socket.sent.filter((frame) => frame === JSON.stringify({ type: "input", data: "\u001b[Z" }))).toHaveLength(Math.min(1, expectedShiftTabs));

    await waitFor(() =>
      expect(socket.sent.filter((frame) => frame === JSON.stringify({ type: "input", data: "\u001b[Z" }))).toHaveLength(expectedShiftTabs)
    );

    act(() => {
      socket.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({ type: "output", stream: "stdout", data: "\u001b[2JClaude Code\nplan mode on" })
        })
      );
    });
    window.dispatchEvent(
      new CustomEvent("space:terminal-pane-action", {
        detail: { paneId: "pane:cli-upload", action: "ensure_plan_mode" }
      })
    );

    await waitFor(() =>
      expect(socket.sent.filter((frame) => frame === JSON.stringify({ type: "input", data: "\u001b[Z" }))).toHaveLength(expectedShiftTabs)
    );
  });

  it("enables Claude Plan mode while background shells and agents run", async () => {
    apiMock.activeCliSession.mockResolvedValueOnce(cliSessionResponse("terminal-ws-ticket-claude", "IDLE", true, { runtimeId: "cli:claude" }));
    apiMock.cliTerminalWebSocketUrl.mockImplementation(
      (ticket: { paneId: string; sessionId: string }) =>
        `ws://space.test/terminal?paneId=${encodeURIComponent(ticket.paneId)}` +
        `&sessionId=${encodeURIComponent(ticket.sessionId)}&runtimeId=cli%3Aclaude`
    );
    render(<TerminalPane pane={cliPane()} terminalFontSize={12} />);
    await waitFor(() => expect(MockWebSocket.instances[0]?.readyState).toBe(MockWebSocket.OPEN));
    const socket = MockWebSocket.instances[0]!;
    // Claude Code 2.1.296's cycle from bypass permissions; background shells replace "(shift+tab to cycle)".
    const footers = [
      "⏵⏵ bypass permissions on · 3 shells · ← for agents · ↓ to manage",
      "⏵⏵ auto mode on · 3 shells · ← for agents · ↓ to manage",
      "⏸ manual mode on · 3 shells · ← for agents · ↓ to manage",
      "⏵⏵ accept edits on · 3 shells · ← for agents · ↓ to manage",
      "⏸ plan mode on · 3 shells · ← for agents · ↓ to manage"
    ];
    const panel = "\n\n  ● main\n  ◯ Plan  Inspecting…  7m 13s · ↓ 231.2k tokens\n  ◯ Explore  Counting…  4m 59s · ↓ 125.1k tokens\n  ◯ general-purpose  1h 58m 48s · ↓ 893.4k tokens";
    const shiftTab = JSON.stringify({ type: "input", data: "\u001b[Z" });
    let footerIndex = 0;
    const show = () => socket.dispatchEvent(new MessageEvent("message", {
      data: JSON.stringify({ type: "output", stream: "stdout", data: `\u001b[2J────\n❯ \n────\n  ${footers[footerIndex]}${panel}` })
    }));
    socket.onSend = (frame) => {
      if (frame !== shiftTab) return;
      footerIndex = Math.min(footerIndex + 1, footers.length - 1);
      show();
    };
    act(() => show());

    window.dispatchEvent(new CustomEvent("space:terminal-pane-action", { detail: { paneId: "pane:cli-upload", action: "ensure_plan_mode" } }));

    await waitFor(() => expect(socket.sent.filter((frame) => frame === shiftTab)).toHaveLength(4));
    await waitFor(() => expect(xtermMock.instances[0]?.screenText).toContain("⏸ plan mode on"));
    expect(screen.queryByText(/mode is not visible|did not confirm/)).toBeNull();
  });

  it("shows a Claude pane as working while its background agents run after the main turn", async () => {
    apiMock.activeCliSession.mockResolvedValueOnce(cliSessionResponse("terminal-ws-ticket-claude", "IDLE", true, { runtimeId: "cli:claude" }));
    apiMock.cliTerminalWebSocketUrl.mockImplementation(
      (ticket: { paneId: string; sessionId: string }) =>
        `ws://space.test/terminal?paneId=${encodeURIComponent(ticket.paneId)}` +
        `&sessionId=${encodeURIComponent(ticket.sessionId)}&runtimeId=cli%3Aclaude`
    );
    const workingStates: boolean[] = [];
    const availabilities: TerminalActionAvailability[] = [];
    render(
      <TerminalPane
        pane={cliPane()}
        terminalFontSize={12}
        onWorkingStateChange={({ isWorking }) => workingStates.push(isWorking)}
        onActionAvailabilityChange={(availability) => availabilities.push(availability)}
      />
    );
    await waitFor(() => expect(MockWebSocket.instances[0]?.readyState).toBe(MockWebSocket.OPEN));
    const socket = MockWebSocket.instances[0]!;
    const show = (screenText: string) => act(() => {
      socket.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "output", stream: "stdout", data: `\u001b[2J${screenText}` }) }));
    });
    const prompt = "────\n❯ \n────\n  ⏵⏵ bypass permissions on · 3 shells · ← for agents · ↓ …";
    const withAgent = `${prompt}\n\n  ● main\n  ◯ general-purpose  1h 58m 48s · ↓ 893.4k tokens · 1 queued`;
    const chord = JSON.stringify({ type: "input", data: "\u0018\u000b" });

    show(withAgent);
    const stop = await screen.findByRole("button", { name: "Stop background agents (click twice)" });
    expect(stop.getAttribute("data-state")).toBe("running");
    expect(workingStates.at(-1)).toBe(true);
    // The main turn is idle: Claude takes prompts and pane actions while its agents work.
    expect(availabilities.at(-1)?.turnRunning).toBe(false);

    // Claude asks for a second chord before it stops agents; a double click must not confirm it.
    fireEvent.click(stop);
    fireEvent.click(stop);
    expect(socket.sent.filter((frame) => frame === chord)).toHaveLength(1);
    expect(socket.sent).not.toContain(JSON.stringify({ type: "input", data: "\u001b" }));

    show(prompt);
    await waitFor(() => expect(screen.getByRole("button", { name: "Send prompt" }).getAttribute("data-state")).toBe("idle"));
    expect(workingStates.at(-1)).toBe(false);

    // Claude can also show no agent panel, only its turn status above the prompt.
    show(`✻ Waiting for 1 background agent to finish\n\n──────── room-agent-monitoring-context ─\n❯ \n────\n  ⏸ plan mode on (shift+tab to cycle) · ← for agents · ↓ to manage`);
    expect((await screen.findByRole("button", { name: "Stop background agents (click twice)" })).getAttribute("data-state")).toBe("running");
    await waitFor(() => expect(workingStates.at(-1)).toBe(true));
    expect(availabilities.at(-1)?.turnRunning).toBe(false);
    expect(availabilities.at(-1)?.planMode).toBe("plan");

    show(withAgent);
    await waitFor(() => expect(workingStates.at(-1)).toBe(true));
    xtermMock.instances[0]?.emitData("next task");
    await waitFor(() => expect(screen.getByRole("button", { name: "Send prompt" }).getAttribute("data-state")).toBe("ready"));
    expect(workingStates.at(-1)).toBe(true);
  });

  it("stops a pending Claude Plan mode transition when the active session is replaced", async () => {
    const initialSession = cliSessionResponse("terminal-ws-ticket-claude-initial", "IDLE", true, {
      runtimeId: "cli:claude",
      sessionId: "cli_session:claude-initial"
    });
    const replacementSession = cliSessionResponse("terminal-ws-ticket-claude-replacement", "IDLE", true, {
      runtimeId: "cli:claude",
      sessionId: "cli_session:claude-replacement"
    });
    apiMock.activeCliSession.mockResolvedValueOnce(initialSession);
    apiMock.cliTerminalWebSocketUrl.mockImplementation(
      (ticket: { paneId: string; sessionId: string }) =>
        `ws://space.test/terminal?paneId=${encodeURIComponent(ticket.paneId)}` +
        `&sessionId=${encodeURIComponent(ticket.sessionId)}&runtimeId=cli%3Aclaude`
    );
    render(<TerminalPane pane={cliPane()} terminalFontSize={12} />);

    await waitFor(() => expect(MockWebSocket.instances[0]?.readyState).toBe(MockWebSocket.OPEN));
    const initialSocket = MockWebSocket.instances[0]!;
    act(() => {
      initialSocket.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({
            type: "output",
            stream: "stdout",
            data: "\u001b[2JClaude Code\nbypass permissions on (shift+tab to cycle) · ← for agents"
          })
        })
      );
    });

    vi.useFakeTimers();
    window.dispatchEvent(
      new CustomEvent("space:terminal-pane-action", {
        detail: { paneId: "pane:cli-upload", action: "ensure_plan_mode" }
      })
    );
    expect(initialSocket.sent.filter((frame) => frame === JSON.stringify({ type: "input", data: "\u001b[Z" }))).toHaveLength(1);

    act(() => {
      window.dispatchEvent(
        new CustomEvent("space:terminal-pane-action", {
          detail: { paneId: "pane:cli-upload", action: "replace_session", session: replacementSession }
        })
      );
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(MockWebSocket.instances).toHaveLength(2);
    const replacementSocket = MockWebSocket.instances[1]!;
    act(() => {
      replacementSocket.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({
            type: "output",
            stream: "stdout",
            data: "\u001b[2JClaude Code\nauto mode on (shift+tab to cycle) · ← for agents"
          })
        })
      );
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_600);
    });

    expect(initialSocket.sent.filter((frame) => frame === JSON.stringify({ type: "input", data: "\u001b[Z" }))).toHaveLength(1);
    expect(
      MockWebSocket.instances.slice(1).flatMap((socket) => socket.sent).filter((frame) => frame === JSON.stringify({ type: "input", data: "\u001b[Z" }))
    ).toHaveLength(0);
  });

  it("saves a Codex task to memory from the live conversation without restarting the CLI", async () => {
    apiMock.createCliSession
      .mockResolvedValueOnce(cliSessionResponse("terminal-ws-ticket-1", "IDLE", true, { sessionId: "cli_session:initial", modelId: "gpt-5.5" }));
    render(<TerminalPane pane={cliPane()} terminalFontSize={12} />);

    await waitFor(() => expect(apiMock.createCliSession).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(MockWebSocket.instances[0]?.readyState).toBe(MockWebSocket.OPEN));
    const socket = MockWebSocket.instances[0]!;
    act(() => {
      socket.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({ type: "output", stream: "stdout", data: "active task output\n" })
        })
      );
    });
    const terminal = xtermMock.instances[0]!;
    terminal.screenText = "active task output";

    window.dispatchEvent(
      new CustomEvent("space:terminal-pane-action", {
        detail: {
          paneId: "pane:cli-upload",
          action: "save_to_memory",
          modelId: "gpt-5-mini",
          text: "save to memory",
          memory: {
            scope: "ROOM",
            roomId: "room:cli-upload",
            title: "CLI memory save request - Codex CLI",
            provenance: "space-cli-memory-save"
          }
        }
      })
    );

    await waitFor(() => {
      const inputs = socket.sent
        .map((frame) => JSON.parse(frame) as { type: string; data?: string })
        .filter((frame) => frame.type === "input");
      expect(inputs.map((frame) => frame.data)).toEqual(["save to memory", "\r"]);
    });
    await waitFor(() =>
      expect(apiMock.createMemory).toHaveBeenCalledWith(
        expect.objectContaining({
          scope: "ROOM",
          roomId: "room:cli-upload",
          title: "CLI memory save request - Codex CLI",
          provenance: "space-cli-memory-save"
        })
      )
    );
    const memoryBody = apiMock.createMemory.mock.calls.at(-1)?.[0]?.body as string;
    expect(memoryBody).toContain("active task output");
    expect(memoryBody).not.toContain("gpt-5-mini");
    expect(memoryBody.replace(/\s+/g, " ")).not.toContain("CLI session allocated.");
    expect(apiMock.createCliSession).toHaveBeenCalledTimes(1);
    expect(MockWebSocket.instances).toHaveLength(1);
  });

  it("refuses save-to-memory while a CLI draft is pending instead of mixing it into the prompt", async () => {
    render(<TerminalPane pane={cliPane()} terminalFontSize={12} />);

    await waitFor(() => expect(MockWebSocket.instances[0]?.readyState).toBe(MockWebSocket.OPEN));
    const socket = MockWebSocket.instances[0]!;
    xtermMock.instances[0]!.emitData("half typed");
    socket.sent.length = 0;

    window.dispatchEvent(
      new CustomEvent("space:terminal-pane-action", {
        detail: {
          paneId: "pane:cli-upload",
          action: "save_to_memory",
          modelId: "gpt-5-mini",
          text: "save to memory",
          memory: { scope: "ROOM", roomId: "room:cli-upload", title: "CLI memory save request", provenance: "space-cli-memory-save" }
        }
      })
    );

    expect(await screen.findByText("Send or clear the current CLI draft before saving to memory.")).toBeTruthy();
    expect(socket.sent.filter((frame) => frame.includes("save to memory"))).toHaveLength(0);
    expect(apiMock.createMemory).not.toHaveBeenCalled();
  });

  it("saves a Claude Code task to memory from the live conversation without a Codex-model restart", async () => {
    const claudeSession = cliSessionResponse("terminal-ws-ticket-claude", "IDLE", true, {
      runtimeId: "cli:claude",
      sessionId: "cli_session:claude-live",
      modelId: "opus"
    });
    apiMock.activeCliSession.mockResolvedValueOnce(claudeSession);
    apiMock.cliTerminalWebSocketUrl.mockImplementation(
      (ticket: { paneId: string; sessionId: string }) =>
        `ws://space.test/terminal?paneId=${encodeURIComponent(ticket.paneId)}` +
        `&sessionId=${encodeURIComponent(ticket.sessionId)}&runtimeId=cli%3Aclaude`
    );
    render(<TerminalPane pane={cliPane({ terminalRuntimeId: "cli:claude" })} terminalFontSize={12} />);

    await waitFor(() => expect(MockWebSocket.instances[0]?.readyState).toBe(MockWebSocket.OPEN));
    const socket = MockWebSocket.instances[0]!;
    act(() => {
      socket.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({ type: "output", stream: "stdout", data: "claude task output\n" })
        })
      );
    });
    xtermMock.instances[0]!.screenText = "claude task output";
    const createCallsBefore = apiMock.createCliSession.mock.calls.length;

    window.dispatchEvent(
      new CustomEvent("space:terminal-pane-action", {
        detail: {
          paneId: "pane:cli-upload",
          action: "save_to_memory",
          modelId: "gpt-5-mini",
          text: "save to memory",
          memory: {
            scope: "ROOM",
            roomId: "room:cli-upload",
            title: "CLI memory save request - Claude",
            provenance: "space-cli-memory-save"
          }
        }
      })
    );

    await waitFor(() => {
      const inputs = socket.sent
        .map((frame) => JSON.parse(frame) as { type: string; data?: string; turnMarker?: string })
        .filter((frame) => frame.type === "input");
      expect(inputs.map((frame) => frame.data)).toEqual(["save to memory", "\r"]);
      expect(inputs[1]?.turnMarker).toEqual(expect.any(String));
    });
    await waitFor(() =>
      expect(apiMock.createMemory).toHaveBeenCalledWith(expect.objectContaining({
        scope: "ROOM",
        roomId: "room:cli-upload",
        title: "CLI memory save request - Claude",
        provenance: "space-cli-memory-save"
      }))
    );
    const memoryBody = apiMock.createMemory.mock.calls.at(-1)?.[0]?.body as string;
    expect(memoryBody).toContain("claude task output");
    expect(memoryBody).toContain("Model: opus");
    expect(memoryBody).not.toContain("gpt-5-mini");
    expect(apiMock.createCliSession.mock.calls.length).toBe(createCallsBefore);
    expect(MockWebSocket.instances).toHaveLength(1);
  });

  it("starts a fresh CLI task on new_task pane action with forceRestart", async () => {
    apiMock.createCliSession
      .mockResolvedValueOnce(cliSessionResponse("terminal-ws-ticket-1", "IDLE", true, { sessionId: "cli_session:initial", modelId: "gpt-5.5" }))
      .mockResolvedValueOnce(cliSessionResponse("terminal-ws-ticket-2", "IDLE", true, { sessionId: "cli_session:new", modelId: "gpt-5.5" }));
    render(<TerminalPane pane={cliPane()} terminalFontSize={12} />);

    await waitFor(() => expect(apiMock.createCliSession).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(MockWebSocket.instances[0]?.readyState).toBe(MockWebSocket.OPEN));

    MockWebSocket.instances[0]?.dispatchEvent(
      new MessageEvent("message", {
        data: JSON.stringify({ type: "output", stream: "stdout", data: "ready\n" })
      })
    );

    window.dispatchEvent(
      new CustomEvent("space:terminal-pane-action", {
        detail: {
          paneId: "pane:cli-upload",
          action: "new_task"
        }
      })
    );

    await waitFor(() => expect(apiMock.createCliSession).toHaveBeenCalledTimes(2));
    expect(apiMock.createCliSession).toHaveBeenLastCalledWith("pane:cli-upload", {
      runtimeId: "cli:codex",
      reasoningEffort: "medium",
      cwd: "/opt/spaceapp",
      forceRestart: true,
      includeTranscript: false
    });
  });

  it("ignores stale terminal clipboard failure text when no fresh paste attempt happened", async () => {
    render(<TerminalPane pane={cliPane()} terminalFontSize={12} />);

    await waitFor(() => expect(apiMock.createCliSession).toHaveBeenCalled());
    await waitFor(() => expect(MockWebSocket.instances[0]?.readyState).toBe(MockWebSocket.OPEN));

    MockWebSocket.instances[0]?.dispatchEvent(
      new MessageEvent("message", {
        data: JSON.stringify({
          type: "output",
          stream: "stderr",
          data: "■ Failed to paste image: clipboard unavailable: Unknown error while interacting with the clipboard: X11 server connection timed out because it was unreachable"
        })
      })
    );

    expect(apiMock.reportCliClipboardDebug).not.toHaveBeenCalled();
  });

  it("does not report terminal clipboard failures after a successful clipboard image upload", async () => {
    render(<TerminalPane pane={cliPane()} terminalFontSize={12} />);

    await waitFor(() => expect(apiMock.createCliSession).toHaveBeenCalled());
    await waitFor(() => expect(MockWebSocket.instances[0]?.readyState).toBe(MockWebSocket.OPEN));

    const terminal = await screen.findByLabelText("CLI pane Codex CLI");
    const file = new File(["fresh"], "fresh.png", { type: "image/png" });
    fireEvent.paste(terminal, {
      clipboardData: {
        files: [],
        items: [{ kind: "file", getAsFile: () => file }],
        getData: () => ""
      }
    });

    await waitFor(() => expect(apiMock.uploadCliFiles).toHaveBeenCalledTimes(1));
    MockWebSocket.instances[0]?.dispatchEvent(
      new MessageEvent("message", {
        data: JSON.stringify({
          type: "output",
          stream: "stderr",
          data: "■ Failed to paste image: clipboard unavailable: Unknown error while interacting with the clipboard: X11 server connection timed out because it was unreachable"
        })
      })
    );

    expect(apiMock.reportCliClipboardDebug).not.toHaveBeenCalled();
  });

  it("reports fresh terminal-side clipboard failures into clipboard debug logs", async () => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        read: vi.fn().mockReturnValue(new Promise(() => undefined)),
        readText: vi.fn().mockResolvedValue("")
      }
    });
    render(<TerminalPane pane={cliPane()} terminalFontSize={12} />);

    await waitFor(() => expect(apiMock.createCliSession).toHaveBeenCalled());
    await waitFor(() => expect(MockWebSocket.instances[0]?.readyState).toBe(MockWebSocket.OPEN));
    const textarea = await waitFor(() => {
      const found = document.querySelector<HTMLTextAreaElement>(".xterm-helper-textarea");
      expect(found).toBeTruthy();
      return found!;
    });
    const event = new KeyboardEvent("keydown", { key: "v", ctrlKey: true, bubbles: true, cancelable: true });
    textarea.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    MockWebSocket.instances[0]?.dispatchEvent(
      new MessageEvent("message", {
        data: JSON.stringify({
          type: "output",
          stream: "stderr",
          data: "■ Failed to paste image: clipboard unavailable: Unknown error while interacting with the clipboard: X11 server connection timed out because it was unreachable"
        })
      })
    );

    await waitFor(() =>
      expect(apiMock.reportCliClipboardDebug).toHaveBeenCalledWith(
        expect.objectContaining({
          paneId: "pane:cli-upload",
          severity: "bad",
          title: "terminal reported clipboard failure"
        })
      )
    );
  });

  it("reports delayed terminal-side clipboard failures into clipboard debug logs", async () => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        read: vi.fn().mockReturnValue(new Promise(() => undefined)),
        readText: vi.fn().mockResolvedValue("")
      }
    });
    render(<TerminalPane pane={cliPane()} terminalFontSize={12} />);

    await waitFor(() => expect(apiMock.createCliSession).toHaveBeenCalled());
    await waitFor(() => expect(MockWebSocket.instances[0]?.readyState).toBe(MockWebSocket.OPEN));
    const textarea = await waitFor(() => {
      const found = document.querySelector<HTMLTextAreaElement>(".xterm-helper-textarea");
      expect(found).toBeTruthy();
      return found!;
    });

    vi.useFakeTimers();
    try {
      const event = new KeyboardEvent("keydown", { key: "v", ctrlKey: true, bubbles: true, cancelable: true });
      textarea.dispatchEvent(event);

      expect(event.defaultPrevented).toBe(true);
      await act(async () => {
        vi.advanceTimersByTime(80);
        await Promise.resolve();
      });
      await act(async () => {
        vi.advanceTimersByTime(6000);
        await Promise.resolve();
      });

      MockWebSocket.instances[0]?.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({
            type: "output",
            stream: "stderr",
            data: "■ Failed to paste image: clipboard unavailable: Unknown error while interacting with the clipboard: X11 server connection timed out because it was unreachable"
          })
        })
      );

      expect(apiMock.reportCliClipboardDebug).toHaveBeenCalledWith(
        expect.objectContaining({
          paneId: "pane:cli-upload",
          severity: "bad",
          title: "terminal reported clipboard failure"
        })
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports stalled clipboard paste attempts when no upload or failure arrives", async () => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        read: vi.fn().mockReturnValue(new Promise(() => undefined)),
        readText: vi.fn().mockResolvedValue("")
      }
    });
    render(<TerminalPane pane={cliPane()} terminalFontSize={12} />);

    await waitFor(() => expect(apiMock.createCliSession).toHaveBeenCalled());
    await waitFor(() => expect(MockWebSocket.instances[0]?.readyState).toBe(MockWebSocket.OPEN));
    const textarea = await waitFor(() => {
      const found = document.querySelector<HTMLTextAreaElement>(".xterm-helper-textarea");
      expect(found).toBeTruthy();
      return found!;
    });

    vi.useFakeTimers();
    try {
      const event = new KeyboardEvent("keydown", { key: "v", ctrlKey: true, bubbles: true, cancelable: true });
      textarea.dispatchEvent(event);

      expect(event.defaultPrevented).toBe(true);
      await act(async () => {
        vi.advanceTimersByTime(80);
        await Promise.resolve();
      });
      await act(async () => {
        vi.advanceTimersByTime(3600);
        await Promise.resolve();
      });

      expect(apiMock.reportCliClipboardDebug).toHaveBeenCalledWith(
        expect.objectContaining({
          paneId: "pane:cli-upload",
          severity: "bad",
          title: "paste stalled before upload"
        })
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps API restart restore notices out of the terminal UI", async () => {
    render(<TerminalPane pane={cliPane()} terminalFontSize={12} />);

    await waitFor(() => expect(apiMock.createCliSession).toHaveBeenCalled());
    await waitFor(() => expect(MockWebSocket.instances[0]?.readyState).toBe(MockWebSocket.OPEN));
    MockWebSocket.instances[0]?.dispatchEvent(
      new MessageEvent("message", {
        data: JSON.stringify({
          type: "status",
          status: "RUNNING",
          statusReason: "CLI terminal transport restored after API restart; persisted transcript replayed."
        })
      })
    );

    await waitFor(() =>
      expect(screen.queryByText("CLI terminal transport restored after API restart; persisted transcript replayed.")).toBeNull()
    );
  });

  it("keeps a truncated replay attached and shows one nonfatal continuity warning", async () => {
    render(<TerminalPane pane={cliPane()} terminalFontSize={12} />);

    await waitFor(() => expect(apiMock.createCliSession).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(MockWebSocket.instances[0]?.readyState).toBe(MockWebSocket.OPEN));
    act(() => {
      MockWebSocket.instances[0]?.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({
            type: "status",
            status: "RUNNING",
            statusReason: "CLI terminal reconnected with a truncated replay.",
            replayContinuity: "TRUNCATED"
          })
        })
      );
    });

    expect(await screen.findByText("Reconnected. Some earlier terminal output was outside the replay window.")).toBeTruthy();
    expect(MockWebSocket.instances).toHaveLength(1);
    expect(MockWebSocket.instances[0]?.readyState).toBe(MockWebSocket.OPEN);
    expect(screen.queryByText(/CLI host output before sequence/i)).toBeNull();
  });

  it.each([
    ["pane", { paneId: "pane:other", sessionId: "cli_session:test-upload", runtimeId: "cli:codex" }],
    ["session", { paneId: "pane:cli-upload", sessionId: "cli_session:other", runtimeId: "cli:codex" }],
    ["runtime", { paneId: "pane:cli-upload", sessionId: "cli_session:test-upload", runtimeId: "cli:other" }]
  ])("rejects a terminal WebSocket ready frame for the wrong %s", async (_identity, ready) => {
    MockWebSocket.autoReady = false;
    render(<TerminalPane pane={cliPane()} terminalFontSize={12} />);

    await waitFor(() => expect(MockWebSocket.instances[0]?.readyState).toBe(MockWebSocket.OPEN));
    act(() => {
      MockWebSocket.instances[0]?.dispatchEvent(
        new MessageEvent("message", { data: JSON.stringify({ type: "ready", ...ready }) })
      );
    });

    await waitFor(() => expect(MockWebSocket.instances[0]?.readyState).toBe(MockWebSocket.CLOSED));
    expect(await screen.findByText("CLI connection identity mismatch. Reconnect this pane.")).toBeTruthy();
    expect(apiMock.createCliSession).toHaveBeenCalledTimes(1);
  });

  it("does not let a stale ready frame unlock a replacement socket for the same session", async () => {
    MockWebSocket.autoReady = false;
    apiMock.activeCliSession
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(cliSessionResponse("terminal-ws-ticket-reconnected"));
    render(<TerminalPane pane={cliPane()} terminalFontSize={12} />);

    await waitFor(() => expect(MockWebSocket.instances[0]?.readyState).toBe(MockWebSocket.OPEN));
    const ready = {
      type: "ready",
      paneId: "pane:cli-upload",
      sessionId: "cli_session:test-upload",
      runtimeId: "cli:codex"
    };
    act(() => {
      MockWebSocket.instances[0]?.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(ready) }));
      MockWebSocket.instances[0]?.close();
    });

    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(2));
    await waitFor(() => expect(MockWebSocket.instances[1]?.readyState).toBe(MockWebSocket.OPEN));
    act(() => {
      MockWebSocket.instances[0]?.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(ready) }));
      xtermMock.instances.at(-1)?.emitData("stale-ready-input\n");
    });
    expect(MockWebSocket.instances[1]?.sent).not.toContain(
      JSON.stringify({ type: "input", data: "stale-ready-input\n" })
    );

    act(() => {
      MockWebSocket.instances[1]?.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(ready) }));
      MockWebSocket.instances[1]?.dispatchEvent(new MessageEvent("message", {
        data: JSON.stringify({
          type: "status",
          status: "RUNNING",
          statusReason: "Attached to CLI process.",
          replayContinuity: "COMPLETE"
        })
      }));
    });
    await waitFor(() => expect(xtermMock.instances.at(-1)?.element?.isConnected).toBe(true));
    act(() => {
      xtermMock.instances.at(-1)?.emitData("current-ready-input\n");
    });
    await waitFor(() =>
      expect(MockWebSocket.instances[1]?.sent).toContain(
        JSON.stringify({ type: "input", data: "current-ready-input\n" })
      )
    );
  });

  it("after the app resumes, reconnects a socket that stays OPEN but answers nothing", async () => {
    apiMock.activeCliSession
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(cliSessionResponse("terminal-ws-ticket-after-sleep"));
    render(<TerminalPane pane={cliPane()} terminalFontSize={12} />);
    await waitFor(() => expect(apiMock.createCliSession).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(MockWebSocket.instances[0]?.readyState).toBe(MockWebSocket.OPEN));
    const socket = MockWebSocket.instances[0]!;
    const pings = () => socket.sent.filter((data) => data === JSON.stringify({ type: "ping" })).length;

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      // A live socket answers the probe: nothing happens.
      act(() => { window.dispatchEvent(new Event("space:app-resumed")); });
      expect(pings()).toBe(1);
      act(() => { socket.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "pong" }) })); });
      act(() => { vi.advanceTimersByTime(6_000); });
      expect(apiMock.activeCliSession).toHaveBeenCalledTimes(1);

      // A socket that went silent while the phone slept is replaced.
      act(() => { window.dispatchEvent(new Event("space:app-resumed")); });
      expect(pings()).toBe(2);
      act(() => { vi.advanceTimersByTime(6_000); });
    } finally {
      vi.useRealTimers();
    }
    await waitFor(() => expect(apiMock.activeCliSession).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(2));
    expect(apiMock.createCliSession).toHaveBeenCalledTimes(1);
  });

  it("automatically reconnects a live CLI transport after its WebSocket closes without showing restart noise", async () => {
    apiMock.activeCliSession
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(cliSessionResponse("terminal-ws-ticket-reconnected"));
    render(<TerminalPane pane={cliPane()} terminalFontSize={12} />);

    await waitFor(() => expect(apiMock.createCliSession).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(MockWebSocket.instances[0]?.readyState).toBe(MockWebSocket.OPEN));

    act(() => {
      MockWebSocket.instances[0]?.close();
    });

    await waitFor(() => expect(apiMock.activeCliSession).toHaveBeenCalledTimes(2), { timeout: 1200 });
    expect(apiMock.activeCliSession).toHaveBeenLastCalledWith("pane:cli-upload", {
      includeTranscript: false
    });
    expect(apiMock.createCliSession).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(2));
    await waitFor(() => {
      const lifecycleEvents = apiMock.reportCliClientEvent.mock.calls.map(([event]) => event);
      expect(lifecycleEvents).toEqual(expect.arrayContaining([
        expect.objectContaining({ event: "SOCKET_DISCONNECTED", outcome: "RETRY", reason: "SOCKET_CLOSE" }),
        expect.objectContaining({ event: "RECONNECT_SCHEDULED", outcome: "RETRY", reason: "SOCKET_CLOSE" }),
        expect.objectContaining({ event: "RECONNECT_SUCCEEDED", outcome: "SUCCESS", reason: "SESSION_REFRESH" })
      ]));
    });
    expect(screen.queryByText("CLI connection lost. Reconnecting...")).toBeNull();
    expect(screen.queryByText("CLI reconnected.")).toBeNull();
  });

  it("keeps a recoverable null-agent-message diagnostic attached to the live CLI session", async () => {
    render(<TerminalPane pane={cliPane()} terminalFontSize={12} />);

    await waitFor(() => expect(MockWebSocket.instances[0]?.readyState).toBe(MockWebSocket.OPEN));
    act(() => {
      MockWebSocket.instances[0]?.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({
            type: "error",
            code: "CODEX_EMPTY_ASSISTANT_MESSAGE",
            message: "Codex completed this turn without a final assistant message. The CLI process remains active."
          })
        })
      );
    });

    await waitFor(() =>
      expect(screen.getByLabelText("CLI pane Codex CLI").getAttribute("data-terminal-status")).toBe("attached")
    );
    expect(xtermMock.instances.at(-1)?.writes.join("")).toContain("The CLI process remains active.");
  });

  it("resumes the last meaningful pane task instead of reattaching a blank replacement session", async () => {
    const blankSession = cliSessionResponse(
      "terminal-ws-ticket-blank",
      "RUNNING",
      true,
      {
        sessionId: "cli_session:blank-replacement",
        cliTaskId: "cli_task:blank-replacement"
      }
    );
    const resumedSession = cliSessionResponse(
      "terminal-ws-ticket-resumed",
      "IDLE",
      true,
      {
        sessionId: "cli_session:resumed-original",
        cliTaskId: "cli_task:original"
      }
    );
    apiMock.activeCliSession.mockResolvedValue(blankSession);
    apiMock.recoveryCliTask.mockResolvedValue({
      threads: [{
        id: "cli_task:original",
        taskId: "cli_task:original",
        revisionId: "cli_revision:original",
        title: "MCP Setup",
        runtimeId: "cli:codex",
        providerId: "codex",
        providerLabel: "Codex",
        modelProvider: "codex",
        preview: "Still working on the MCP setup",
        firstUserMessage: "Finish configuring the MCP setup",
        cwd: "/etc",
        model: "gpt-5.6-sol",
        reasoningEffort: "xhigh",
        updatedAt: "2026-07-27T00:00:00.000Z",
        recencyAt: "2026-07-27T00:00:00.000Z",
        archived: false,
        source: "space",
        threadSource: "cli:codex",
        rolloutPath: null
      }],
      total: 1,
      page: 1,
      pageSize: 1
    });
    apiMock.resumeCliSession.mockResolvedValue({
      ...resumedSession,
      pane: cliPane(),
      mode: "NATIVE_RESUME"
    });
    render(<TerminalPane pane={cliPane()} terminalFontSize={12} />);

    await waitFor(() => expect(apiMock.activeCliSession).toHaveBeenCalledTimes(1));
    act(() => {
      window.dispatchEvent(
        new CustomEvent("space:terminal-pane-action", {
          detail: { paneId: "pane:cli-upload", action: "reconnect" }
        })
      );
    });

    await waitFor(() =>
      expect(apiMock.resumeCliSession).toHaveBeenCalledWith("pane:cli-upload", {
        taskId: "cli_task:original"
      })
    );
    expect(apiMock.recoveryCliTask).toHaveBeenCalledWith("pane:cli-upload");
    expect(apiMock.createCliSession).not.toHaveBeenCalled();
  });

  it("does not reconnect after a terminal status marks the session closed", async () => {
    MockWebSocket.autoRunningStatus = false;
    apiMock.activeCliSession.mockResolvedValueOnce(
      cliSessionResponse("terminal-ws-ticket-final-status", "RUNNING", true)
    );
    render(<TerminalPane pane={cliPane()} terminalFontSize={12} />);

    await waitFor(() => expect(MockWebSocket.instances[0]?.readyState).toBe(MockWebSocket.OPEN));
    const terminal = xtermMock.instances[0]!;
    vi.spyOn(Math, "random").mockReturnValue(0);
    vi.useFakeTimers();
    try {
      act(() => {
        const finalStatus = new MessageEvent("message", {
          data: JSON.stringify({
            type: "status",
            status: "EXITED",
            statusReason: "CLI session is closed.",
            replayContinuity: "COMPLETE"
          })
        });
        MockWebSocket.instances[0]?.dispatchEvent(finalStatus);
        MockWebSocket.instances[0]?.dispatchEvent(finalStatus);
        terminal.emitData("late input after final status\n");
        MockWebSocket.instances[0]?.close();
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });

      expect(apiMock.createCliSession).not.toHaveBeenCalled();
      expect(terminal.writes.filter((write) => write.includes("CLI session is closed."))).toHaveLength(1);
      expect(MockWebSocket.instances[0]?.sent.some((frame) => frame.includes("late input after final status"))).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not reconnect after a terminal error marks the socket final", async () => {
    MockWebSocket.autoRunningStatus = false;
    apiMock.activeCliSession.mockResolvedValueOnce(
      cliSessionResponse("terminal-ws-ticket-final-error", "RUNNING", true)
    );
    render(<TerminalPane pane={cliPane()} terminalFontSize={12} />);

    await waitFor(() => expect(MockWebSocket.instances[0]?.readyState).toBe(MockWebSocket.OPEN));
    vi.spyOn(Math, "random").mockReturnValue(0);
    vi.useFakeTimers();
    try {
      act(() => {
        MockWebSocket.instances[0]?.dispatchEvent(
          new MessageEvent("message", {
            data: JSON.stringify({
              type: "error",
              code: "CLI_TERMINAL_CLOSED",
              message: "CLI session is closed."
            })
          })
        );
        MockWebSocket.instances[0]?.dispatchEvent(new Event("error"));
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });

      expect(apiMock.createCliSession).not.toHaveBeenCalled();
      expect(xtermMock.instances[0]!.writes.filter((write) => write.includes("CLI session is closed."))).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps retrying short CLI reconnect outages without showing restart noise", async () => {
    apiMock.createCliSession.mockResolvedValueOnce(cliSessionResponse("terminal-ws-ticket-initial"));
    apiMock.activeCliSession
      .mockResolvedValueOnce(null)
      .mockRejectedValueOnce(new TypeError("Space API restarting"))
      .mockResolvedValueOnce(cliSessionResponse("terminal-ws-ticket-restored"));
    render(<TerminalPane pane={cliPane()} terminalFontSize={12} />);

    await waitFor(() => expect(apiMock.createCliSession).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(MockWebSocket.instances[0]?.readyState).toBe(MockWebSocket.OPEN));

    act(() => {
      MockWebSocket.instances[0]?.close();
    });

    await waitFor(() => expect(apiMock.activeCliSession).toHaveBeenCalledTimes(3), { timeout: 2500 });
    expect(apiMock.createCliSession).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(2));
    expect(screen.queryByText("CLI connection lost. Reconnecting...")).toBeNull();
    expect(screen.queryByText("CLI reconnect failed; retrying automatically.")).toBeNull();
  });

  it("keeps automatic CLI reconnect silent even during a longer API restart", async () => {
    apiMock.createCliSession.mockResolvedValueOnce(cliSessionResponse("terminal-ws-ticket-initial"));
    apiMock.activeCliSession
      .mockResolvedValueOnce(null)
      .mockRejectedValueOnce(new TypeError("Space API restarting"))
      .mockRejectedValueOnce(new TypeError("Space API restarting"))
      .mockRejectedValueOnce(new TypeError("Space API restarting"))
      .mockRejectedValueOnce(new TypeError("Space API restarting"));

    render(<TerminalPane pane={cliPane()} terminalFontSize={12} />);

    await waitFor(() => expect(apiMock.createCliSession).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(MockWebSocket.instances[0]?.readyState).toBe(MockWebSocket.OPEN));

    vi.spyOn(Math, "random").mockReturnValue(0);
    vi.useFakeTimers();
    try {
      act(() => {
        MockWebSocket.instances[0]?.close();
      });

      await act(async () => {
        await vi.advanceTimersByTimeAsync(250);
      });
      expect(apiMock.activeCliSession).toHaveBeenCalledTimes(2);
      expect(apiMock.createCliSession).toHaveBeenCalledTimes(1);
      expect(screen.queryByText("CLI reconnect failed; retrying automatically.")).toBeNull();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
      expect(apiMock.activeCliSession).toHaveBeenCalledTimes(3);
      expect(screen.queryByText("CLI reconnect failed; retrying automatically.")).toBeNull();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000);
      });
      expect(apiMock.activeCliSession).toHaveBeenCalledTimes(4);
      expect(screen.queryByText("CLI reconnect failed; retrying automatically.")).toBeNull();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000);
      });
      expect(apiMock.activeCliSession).toHaveBeenCalledTimes(5);
      expect(screen.queryByText("CLI reconnect failed; retrying automatically.")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("re-fits a visible CLI pane when output arrives while the xterm grid is stuck in a broken few-column state", async () => {
    render(<TerminalPane pane={cliPane()} terminalFontSize={12} />);

    await waitFor(() => expect(apiMock.createCliSession).toHaveBeenCalled());
    await waitFor(() => expect(MockWebSocket.instances[0]?.readyState).toBe(MockWebSocket.OPEN));
    await waitFor(() => expect(fitAddonMock.instances[0]?.fitCalls).toBeGreaterThan(0));

    const xtermHost = await screen.findByLabelText("Live CLI pane Codex CLI");
    Object.defineProperty(xtermHost, "clientWidth", { configurable: true, value: 320 });
    Object.defineProperty(xtermHost, "clientHeight", { configurable: true, value: 560 });
    xtermMock.instances[0]!.cols = 4;

    const baselineFitCalls = fitAddonMock.instances[0]!.fitCalls;
    MockWebSocket.instances[0]?.dispatchEvent(
      new MessageEvent("message", {
        data: JSON.stringify({
          type: "output",
          stream: "stdout",
          data: "fresh output should trigger a visible terminal recovery\n"
        })
      })
    );

    await waitFor(() => expect(fitAddonMock.instances[0]!.fitCalls).toBeGreaterThan(baselineFitCalls));
  });

  it("does not force a whole-terminal repaint for parsed CLI output with healthy geometry", async () => {
    render(<TerminalPane pane={cliPane()} terminalFontSize={12} />);

    await waitFor(() => expect(apiMock.createCliSession).toHaveBeenCalled());
    await waitFor(() => expect(MockWebSocket.instances[0]?.readyState).toBe(MockWebSocket.OPEN));
    await waitFor(() => expect(fitAddonMock.instances[0]?.fitCalls).toBeGreaterThan(0));
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 600));
    });

    const terminal = xtermMock.instances[0]!;
    terminal.cols = 100;
    const baselineFitCalls = fitAddonMock.instances[0]!.fitCalls;
    const baselineRefreshCalls = terminal.refreshCalls.length;

    MockWebSocket.instances[0]?.dispatchEvent(
      new MessageEvent("message", {
        data: JSON.stringify({
          type: "output",
          data: "parsed output must repaint without changing the shared font size\n"
        })
      })
    );
    act(() => terminal.emitWriteParsed());

    await act(async () => {
      await new Promise((resolve) => window.requestAnimationFrame(resolve));
    });
    expect(terminal.refreshCalls).toHaveLength(baselineRefreshCalls);
    expect(fitAddonMock.instances[0]!.fitCalls).toBe(baselineFitCalls);
    expect(terminal.options.fontSize).toBe(12);
  });

  it("coalesces parsed-output geometry checks without repainting and disposes the listener on unmount", async () => {
    const { unmount } = render(<TerminalPane pane={cliPane()} terminalFontSize={12} />);

    await waitFor(() => expect(apiMock.createCliSession).toHaveBeenCalled());
    await waitFor(() => expect(MockWebSocket.instances[0]?.readyState).toBe(MockWebSocket.OPEN));
    const terminal = xtermMock.instances[0]!;
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 300));
    });
    const baselineRefreshCalls = terminal.refreshCalls.length;

    act(() => {
      terminal.emitWriteParsed();
      terminal.emitWriteParsed();
      terminal.emitWriteParsed();
    });

    await act(async () => {
      await new Promise((resolve) => window.requestAnimationFrame(resolve));
    });
    expect(terminal.refreshCalls).toHaveLength(baselineRefreshCalls);
    expect(terminal.writeParsedHandlers.size).toBe(2); // Geometry evidence and paint recovery.
    unmount();
    expect(terminal.writeParsedHandlers.size).toBe(0);
  });

  it("preserves stable terminal geometry when the browser regains focus", async () => {
    const { unmount } = render(<TerminalPane pane={cliPane()} terminalFontSize={12} />);

    await waitFor(() => expect(apiMock.createCliSession).toHaveBeenCalled());
    await waitFor(() => expect(MockWebSocket.instances[0]?.readyState).toBe(MockWebSocket.OPEN));
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 75));
    });

    const terminal = xtermMock.instances[0]!;
    const baselineFitCalls = fitAddonMock.instances[0]!.fitCalls;
    const baselineRefreshCalls = terminal.refreshCalls.length;
    const baselineGrid = { cols: terminal.cols, rows: terminal.rows };
    const socket = MockWebSocket.instances[0];

    act(() => window.dispatchEvent(new FocusEvent("focus")));

    await act(async () => {
      await new Promise((resolve) => window.requestAnimationFrame(resolve));
    });
    // A stable grid is neither refitted nor repainted on focus (main's +1 refit
    // expectation from 6c5bd20bc6 also fails against main's own TerminalPane).
    expect(fitAddonMock.instances[0]!.fitCalls).toBe(baselineFitCalls);
    expect(terminal.refreshCalls).toHaveLength(baselineRefreshCalls);
    expect({ cols: terminal.cols, rows: terminal.rows }).toEqual(baselineGrid);
    expect(xtermMock.instances).toEqual([terminal]);
    expect(MockWebSocket.instances).toEqual([socket]);
    expect(apiMock.createCliSession).toHaveBeenCalledOnce();

    unmount();
    const fitCallsAfterUnmount = fitAddonMock.instances[0]!.fitCalls;
    act(() => window.dispatchEvent(new FocusEvent("focus")));
    expect(fitAddonMock.instances[0]!.fitCalls).toBe(fitCallsAfterUnmount);
  });

  it("defers parsed-output repaint while hidden and repaints when the CLI pane becomes visible", async () => {
    const { rerender } = render(<TerminalPane pane={cliPane()} terminalFontSize={12} isVisible={false} />);

    await waitFor(() => expect(apiMock.createCliSession).toHaveBeenCalled());
    await waitFor(() => expect(MockWebSocket.instances[0]?.readyState).toBe(MockWebSocket.OPEN));
    const terminal = xtermMock.instances[0]!;
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 75));
    });
    const hiddenRefreshCalls = terminal.refreshCalls.length;

    act(() => terminal.emitWriteParsed());
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 25));
    });
    expect(terminal.refreshCalls).toHaveLength(hiddenRefreshCalls);

    rerender(withVoiceInput(<TerminalPane pane={cliPane()} terminalFontSize={12} isVisible />));
    await waitFor(() => expect(terminal.refreshCalls.length).toBeGreaterThan(hiddenRefreshCalls));
    expect(terminal.refreshCalls.at(-1)).toEqual({ start: 0, end: terminal.rows - 1 });
  });

  it("buffers replay and live output with zero hidden writes, fits, refreshes, or resizes before ordered reveal", async () => {
    MockWebSocket.autoRunningStatus = false;
    const dispatchEvent = vi.spyOn(window, "dispatchEvent");
    apiMock.activeCliSession.mockResolvedValueOnce(
      cliSessionResponse("terminal-ws-ticket-hidden-output", "RUNNING", true)
    );
    const view = render(<TerminalPane pane={cliPane()} terminalFontSize={12} isVisible={false} />);

    await waitFor(() => expect(MockWebSocket.instances[0]?.readyState).toBe(MockWebSocket.OPEN));
    const socket = MockWebSocket.instances[0]!;
    const terminal = xtermMock.instances[0]!;
    act(() => {
      socket.dispatchEvent(new MessageEvent("message", {
        data: JSON.stringify({ type: "output", stream: "stdout", data: "replay-hidden\n" })
      }));
      socket.dispatchEvent(new MessageEvent("message", {
        data: JSON.stringify({
          type: "status",
          status: "RUNNING",
          statusReason: "Attached to CLI process.",
          replayContinuity: "COMPLETE"
        })
      }));
      socket.dispatchEvent(new MessageEvent("message", {
        data: JSON.stringify({ type: "output", stream: "stdout", data: "live-hidden\n" })
      }));
    });
    await act(async () => Promise.resolve());

    expect(terminal.writes).toEqual([]);
    expect(terminal.refreshCalls).toEqual([]);
    expect(fitAddonMock.instances[0]!.fitCalls).toBe(0);
    expect(socket.sent.filter((frame) => JSON.parse(frame).type === "resize")).toEqual([]);

    view.rerender(withVoiceInput(<TerminalPane pane={cliPane()} terminalFontSize={12} isVisible />));
    await waitFor(() => expect(terminal.writes.join("")).toBe("replay-hidden\nlive-hidden\n"));
    await waitFor(() => expect(fitAddonMock.instances[0]!.fitCalls).toBeGreaterThan(0));
    expect(socket.sent.filter((frame) => JSON.parse(frame).type === "resize")).toHaveLength(1);
    const geometryMetrics = dispatchEvent.mock.calls
      .map(([event]) => event)
      .filter((event) => event.type === "space:app-diagnostics-performance")
      .map((event) => (event as CustomEvent).detail)
      .filter((detail) => detail.metric === "TERMINAL_GEOMETRY");
    expect(geometryMetrics).toContainEqual(expect.objectContaining({
      roomId: "room:cli-upload",
      paneId: "pane:cli-upload",
      phase: "READY",
      cols: expect.any(Number),
      rows: expect.any(Number),
      width: expect.any(Number),
      height: expect.any(Number)
    }));
  });

  it("prefills only initial replay in a headless hidden terminal and buffers subsequent live output", async () => {
    MockWebSocket.autoRunningStatus = false;
    const onPrefillReadyChange = vi.fn();
    apiMock.activeCliSession.mockResolvedValueOnce(
      cliSessionResponse("terminal-ws-ticket-hidden-prefill", "RUNNING", true)
    );
    const view = render(
      <TerminalPane
        pane={cliPane()}
        terminalFontSize={12}
        isVisible={false}
        prefillInitialReplay
        onPrefillReadyChange={onPrefillReadyChange}
      />
    );

    await waitFor(() => expect(MockWebSocket.instances[0]?.readyState).toBe(MockWebSocket.OPEN));
    const socket = MockWebSocket.instances[0]!;
    const terminal = xtermMock.instances[0]!;
    act(() => {
      socket.dispatchEvent(new MessageEvent("message", {
        data: JSON.stringify({ type: "output", stream: "stdout", data: "replay-prefilled\n" })
      }));
      socket.dispatchEvent(new MessageEvent("message", {
        data: JSON.stringify({
          type: "status",
          status: "RUNNING",
          statusReason: "Attached to CLI process.",
          replayContinuity: "COMPLETE"
        })
      }));
      socket.dispatchEvent(new MessageEvent("message", {
        data: JSON.stringify({ type: "output", stream: "stdout", data: "live-buffered\n" })
      }));
    });

    await waitFor(() => expect(terminal.writes.join("")).toBe("replay-prefilled\n"));
    await waitFor(() => expect(onPrefillReadyChange).toHaveBeenLastCalledWith("pane:cli-upload", true));
    expect(terminal.writeBeforeOpenCount).toBeGreaterThan(0);
    expect(terminal.element).toBeUndefined();
    expect(terminal.refreshCalls).toEqual([]);
    expect(fitAddonMock.instances[0]!.fitCalls).toBe(0);
    expect(socket.sent.filter((frame) => JSON.parse(frame).type === "resize")).toEqual([]);

    view.rerender(withVoiceInput(
      <TerminalPane
        pane={cliPane()}
        terminalFontSize={12}
        isVisible
        prefillInitialReplay
        onPrefillReadyChange={onPrefillReadyChange}
      />
    ));
    await waitFor(() =>
      expect(terminal.writes.join("")).toBe("replay-prefilled\nlive-buffered\n")
    );
    expect(terminal.writes).toEqual(["replay-prefilled\n", "live-buffered\n"]);
  });

  it("keeps the non-preconnected hidden attach headless while prefilling replay", async () => {
    MockWebSocket.autoRunningStatus = false;
    const onPrefillReadyChange = vi.fn();
    render(
      <TerminalPane
        pane={cliPane()}
        terminalFontSize={12}
        isVisible={false}
        prefillInitialReplay
        onPrefillReadyChange={onPrefillReadyChange}
      />
    );

    await waitFor(() => expect(apiMock.createCliSession).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(MockWebSocket.instances[0]?.readyState).toBe(MockWebSocket.OPEN));
    const socket = MockWebSocket.instances[0]!;
    const terminal = xtermMock.instances[0]!;
    act(() => {
      socket.dispatchEvent(new MessageEvent("message", {
        data: JSON.stringify({ type: "output", stream: "stdout", data: "fallback-prefill\n" })
      }));
      socket.dispatchEvent(new MessageEvent("message", {
        data: JSON.stringify({
          type: "status",
          status: "RUNNING",
          statusReason: "Attached to CLI process.",
          replayContinuity: "COMPLETE"
        })
      }));
    });

    await waitFor(() => expect(terminal.writes).toEqual(["fallback-prefill\n"]));
    await waitFor(() =>
      expect(onPrefillReadyChange).toHaveBeenLastCalledWith("pane:cli-upload", true)
    );
    expect(terminal.element).toBeUndefined();
    expect(terminal.writeBeforeOpenCount).toBe(1);
    expect(fitAddonMock.instances[0]!.fitCalls).toBe(0);
    expect(socket.sent.filter((frame) => JSON.parse(frame).type === "resize")).toEqual([]);
    const terminalSection = screen.getByLabelText("CLI pane Codex CLI");
    const terminalHost = terminalSection.querySelector(".terminal-xterm");
    expect(terminalSection.getAttribute("data-terminal-prefill-enabled")).toBe("true");
    expect(terminalHost?.getAttribute("data-terminal-pending-prefill-events")).toBe("0");
    expect(terminalHost?.getAttribute("data-terminal-pending-prefill-bytes")).toBe("0");
  });

  it("marks hidden PREFILL ready from the final asynchronous xterm callback", async () => {
    MockWebSocket.autoRunningStatus = false;
    const onPrefillReadyChange = vi.fn();
    apiMock.activeCliSession.mockResolvedValueOnce(
      cliSessionResponse("terminal-ws-ticket-deferred-prefill", "RUNNING", true)
    );
    render(
      <TerminalPane
        pane={cliPane()}
        terminalFontSize={12}
        isVisible={false}
        prefillInitialReplay
        onPrefillReadyChange={onPrefillReadyChange}
      />
    );

    await waitFor(() => expect(MockWebSocket.instances[0]?.readyState).toBe(MockWebSocket.OPEN));
    const socket = MockWebSocket.instances[0]!;
    const terminal = xtermMock.instances[0]!;
    terminal.deferWrites = true;
    const firstChunk = "deferred-prefill-1\n";
    act(() => {
      socket.dispatchEvent(new MessageEvent("message", {
        data: JSON.stringify({ type: "output", stream: "stdout", data: firstChunk })
      }));
      socket.dispatchEvent(new MessageEvent("message", {
        data: JSON.stringify({ type: "output", stream: "stdout", data: "deferred-prefill-2\n" })
      }));
      socket.dispatchEvent(new MessageEvent("message", {
        data: JSON.stringify({
          type: "status",
          status: "RUNNING",
          statusReason: "Attached to CLI process.",
          replayContinuity: "COMPLETE"
        })
      }));
    });

    await waitFor(() => expect(terminal.pendingWrites).toHaveLength(1));
    expect(
      screen.getByLabelText("CLI pane Codex CLI").getAttribute("data-terminal-prefill-ready")
    ).toBe("false");
    expect(onPrefillReadyChange).not.toHaveBeenCalledWith("pane:cli-upload", true);

    // Since 76641456fb contiguous initial PREFILL frames are written as one asynchronous batch.
    expect(terminal.pendingWrites[0]?.data).toBe(firstChunk + "deferred-prefill-2\n");
    expect(terminal.writes).toEqual([]);
    act(() => terminal.completeNextWrite());

    await waitFor(() => expect(
      screen.getByLabelText("CLI pane Codex CLI").getAttribute("data-terminal-prefill-ready")
    ).toBe("true"));
    expect(onPrefillReadyChange).toHaveBeenLastCalledWith("pane:cli-upload", true);
    expect(terminal.writes).toEqual([firstChunk + "deferred-prefill-2\n"]);
    expect(terminal.writeBeforeOpenCount).toBe(1);
    expect(terminal.pendingWrites).toHaveLength(0);
  });

  it("marks hidden PREFILL ready when replay drains before initial status arrives", async () => {
    MockWebSocket.autoRunningStatus = false;
    const onPrefillReadyChange = vi.fn();
    apiMock.activeCliSession.mockResolvedValueOnce(
      cliSessionResponse("terminal-ws-ticket-prefill-before-status", "RUNNING", true)
    );
    render(
      <TerminalPane
        pane={cliPane()}
        terminalFontSize={12}
        isVisible={false}
        prefillInitialReplay
        onPrefillReadyChange={onPrefillReadyChange}
      />
    );

    await waitFor(() => expect(MockWebSocket.instances[0]?.readyState).toBe(MockWebSocket.OPEN));
    const socket = MockWebSocket.instances[0]!;
    const terminal = xtermMock.instances[0]!;
    act(() => {
      socket.dispatchEvent(new MessageEvent("message", {
        data: JSON.stringify({ type: "output", stream: "stdout", data: "prefill-before-status\n" })
      }));
    });

    await waitFor(() => expect(terminal.writes).toEqual(["prefill-before-status\n"]));
    expect(
      screen.getByLabelText("CLI pane Codex CLI").getAttribute("data-terminal-prefill-ready")
    ).toBe("false");
    expect(onPrefillReadyChange).not.toHaveBeenCalledWith("pane:cli-upload", true);

    act(() => {
      socket.dispatchEvent(new MessageEvent("message", {
        data: JSON.stringify({
          type: "status",
          status: "RUNNING",
          statusReason: "Attached to CLI process.",
          replayContinuity: "COMPLETE"
        })
      }));
    });

    await waitFor(() => expect(
      screen.getByLabelText("CLI pane Codex CLI").getAttribute("data-terminal-prefill-ready")
    ).toBe("true"));
    expect(onPrefillReadyChange).toHaveBeenLastCalledWith("pane:cli-upload", true);
    expect(terminal.writeBeforeOpenCount).toBe(1);
  });

  it("does not prefill a hidden browser tab or a minimized terminal", async () => {
    MockWebSocket.autoRunningStatus = false;
    let visibilityState: DocumentVisibilityState = "hidden";
    vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibilityState);
    apiMock.activeCliSession.mockResolvedValueOnce(
      cliSessionResponse("terminal-ws-ticket-tab-hidden-prefill", "RUNNING", true)
    );
    const hiddenTab = render(
      <TerminalPane
        pane={cliPane()}
        terminalFontSize={12}
        isVisible={false}
        prefillInitialReplay
      />
    );
    await waitFor(() => expect(MockWebSocket.instances[0]?.readyState).toBe(MockWebSocket.OPEN));
    const socket = MockWebSocket.instances[0]!;
    const terminal = xtermMock.instances[0]!;
    act(() => {
      socket.dispatchEvent(new MessageEvent("message", {
        data: JSON.stringify({ type: "output", stream: "stdout", data: "tab-hidden-replay\n" })
      }));
      socket.dispatchEvent(new MessageEvent("message", {
        data: JSON.stringify({
          type: "status",
          status: "RUNNING",
          statusReason: "Attached to CLI process.",
          replayContinuity: "COMPLETE"
        })
      }));
    });
    await act(async () => Promise.resolve());
    expect(terminal.writes).toEqual([]);
    hiddenTab.unmount();

    MockWebSocket.instances = [];
    xtermMock.instances = [];
    apiMock.activeCliSession.mockClear();
    visibilityState = "visible";
    render(
      <TerminalPane
        pane={{ ...cliPane(), isMinimized: true }}
        terminalFontSize={12}
        isVisible={false}
        shouldBootstrap={false}
        prefillInitialReplay={false}
      />
    );
    await act(async () => Promise.resolve());
    expect(apiMock.activeCliSession).not.toHaveBeenCalled();
    expect(xtermMock.instances).toEqual([]);
  });

  it("reveals a two-mebibyte hidden backlog in at most two bounded xterm writes", async () => {
    MockWebSocket.autoRunningStatus = false;
    apiMock.activeCliSession.mockResolvedValueOnce(
      cliSessionResponse("terminal-ws-ticket-large-hidden-output", "RUNNING", true)
    );
    const view = render(<TerminalPane pane={cliPane()} terminalFontSize={12} isVisible={false} />);

    await waitFor(() => expect(MockWebSocket.instances[0]?.readyState).toBe(MockWebSocket.OPEN));
    const socket = MockWebSocket.instances[0]!;
    const terminal = xtermMock.instances[0]!;
    const events = Array.from(
      { length: 200 },
      (_, index) => `${String(index).padStart(3, "0")}:${"x".repeat(9_744)}`
    );
    act(() => {
      for (const data of events) {
        socket.dispatchEvent(new MessageEvent("message", {
          data: JSON.stringify({ type: "output", stream: "stdout", data })
        }));
      }
      socket.dispatchEvent(new MessageEvent("message", {
        data: JSON.stringify({
          type: "status",
          status: "RUNNING",
          statusReason: "Attached to CLI process.",
          replayContinuity: "COMPLETE"
        })
      }));
    });

    await waitFor(() => {
      expect(screen.getByLabelText("CLI pane Codex CLI").getAttribute("data-terminal-status")).toBe("attached");
    }, { timeout: 5_000 });
    expect(terminal.writes).toEqual([]);
    expect(terminal.element).toBeUndefined();
    expect(screen.getByLabelText("Live CLI pane Codex CLI").querySelector(".xterm")).toBeNull();

    view.rerender(withVoiceInput(<TerminalPane pane={cliPane()} terminalFontSize={12} isVisible />));
    await waitFor(() => expect(terminal.writes.join("")).toBe(events.join("")), { timeout: 10_000 });

    expect(terminal.writes.length).toBeLessThanOrEqual(2);
    expect(terminal.writes.every((write) => write.length <= 1024 * 1024)).toBe(true);
    expect(terminal.element?.isConnected).toBe(true);
  });

  it("keeps pressure output hidden and requests cold eviction without fitting, refreshing, or resizing", async () => {
    MockWebSocket.autoRunningStatus = false;
    const dispatchEvent = vi.spyOn(window, "dispatchEvent");
    apiMock.activeCliSession.mockResolvedValueOnce(
      cliSessionResponse("terminal-ws-ticket-maintenance-output", "RUNNING", true)
    );
    const view = render(<TerminalPane pane={cliPane()} terminalFontSize={12} isVisible={false} />);

    await waitFor(() => expect(MockWebSocket.instances[0]?.readyState).toBe(MockWebSocket.OPEN));
    const socket = MockWebSocket.instances[0]!;
    const terminal = xtermMock.instances[0]!;
    const events = Array.from(
      { length: 230 },
      (_, index) => `${String(index).padStart(3, "0")}:${"x".repeat(9_744)}`
    );
    act(() => {
      for (const data of events) {
        socket.dispatchEvent(new MessageEvent("message", {
          data: JSON.stringify({ type: "output", stream: "stdout", data })
        }));
      }
      socket.dispatchEvent(new MessageEvent("message", {
        data: JSON.stringify({
          type: "status",
          status: "RUNNING",
          statusReason: "Attached to CLI process.",
          replayContinuity: "COMPLETE"
        })
      }));
    });

    await waitFor(() => {
      expect(
        dispatchEvent.mock.calls
          .map(([event]) => event)
          .filter((event) => event.type === "space:terminal-output-pressure")
      ).toHaveLength(2);
    });
    expect(terminal.writes).toEqual([]);
    expect(terminal.element).toBeUndefined();
    expect(terminal.refreshCalls).toEqual([]);
    expect(fitAddonMock.instances[0]!.fitCalls).toBe(0);
    expect(socket.sent.filter((frame) => JSON.parse(frame).type === "resize")).toEqual([]);
    const pressureEvents = dispatchEvent.mock.calls
      .map(([event]) => event)
      .filter((event) => event.type === "space:terminal-output-pressure");
    const pressureDetails = pressureEvents.map((event) => (event as CustomEvent).detail);
    expect(pressureDetails.map((detail) => detail.reason)).toEqual(["PANE_LIMIT", "TOTAL_LIMIT"]);
    expect(pressureDetails[0]).toEqual(
      expect.objectContaining({
        roomId: "room:cli-upload",
        paneId: "pane:cli-upload",
        reason: "PANE_LIMIT"
      })
    );
    expect(pressureDetails[0].bufferedBytes).toBeGreaterThan(128 * 1024);
    expect(pressureDetails[1].totalBufferedBytes).toBeGreaterThan(1024 * 1024);
    expect(pressureDetails[1].bufferedEvents).toBeGreaterThan(0);
    expect(pressureDetails[1].bufferedEvents).toBeLessThanOrEqual(events.length);
    expect(
      dispatchEvent.mock.calls
        .map(([event]) => event)
        .filter((event) => event.type === "space:app-diagnostics-performance")
        .map((event) => (event as CustomEvent).detail)
    ).toEqual(expect.arrayContaining([
      expect.objectContaining({
        metric: "TERMINAL_OUTPUT_PRESSURE",
        phase: "PANE_LIMIT",
        roomId: "room:cli-upload",
        paneId: "pane:cli-upload"
      }),
      expect.objectContaining({
        metric: "TERMINAL_OUTPUT_PRESSURE",
        phase: "TOTAL_LIMIT",
        roomId: "room:cli-upload",
        paneId: "pane:cli-upload"
      })
    ]));
    view.unmount();
  });

  it("keeps runtime/footer chrome hidden and applies the shared terminal font size", async () => {
    const { rerender } = render(<TerminalPane pane={cliPane()} terminalFontSize={14} />);

    await waitFor(() => expect(apiMock.createCliSession).toHaveBeenCalled());
    await waitFor(() => expect(MockWebSocket.instances[0]?.readyState).toBe(MockWebSocket.OPEN));
    await waitFor(() => expect(xtermMock.instances[0]?.options.fontSize).toBe(14));
    expect(xtermMock.instances[0]?.options.logLevel).toBe("off");
    expect(xtermMock.instances[0]?.options).toEqual(expect.objectContaining({
      cols: 100,
      rows: 30,
      convertEol: false
    }));

    expect(screen.queryByLabelText("CLI runtime Codex CLI")).toBeNull();
    expect(screen.queryByText("runtime pending")).toBeNull();
    expect(screen.queryByText("cli_session:test-upload")).toBeNull();
    expect(screen.queryByLabelText("Increase CLI font size Codex CLI")).toBeNull();
    expect(screen.queryByLabelText("Upload files Codex CLI")).toBeNull();

    rerender(withVoiceInput(<TerminalPane pane={cliPane()} terminalFontSize={15} />));
    await waitFor(() => expect(xtermMock.instances[0]?.options.fontSize).toBe(15));
  });
});
