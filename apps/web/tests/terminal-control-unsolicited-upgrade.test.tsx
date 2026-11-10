import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Pane } from "@space/contracts";
import { TerminalPane } from "../src/features/terminal-pane/TerminalPane.js";
import { VoiceInputProvider } from "../src/features/voice-input/VoiceInputProvider.js";
import { resetCliClientEventReporter } from "../src/cli-client-event-reporter.js";
import { liveRuntime } from "../src/live/live-runtime.js";
import { installSpaceRuntime } from "../src/runtime/SpaceRuntime.js";

const apiMock = vi.hoisted(() => ({
  cliRuntimes: vi.fn(),
  cliRuntimesSnapshot: vi.fn(() => null),
  activeCliSession: vi.fn(),
  cliModelSettings: vi.fn(),
  cliModelSettingsStatus: vi.fn(),
  listCliAccountProfiles: vi.fn(),
  cliTerminalWebSocketUrl: vi.fn(),
  setCliTerminalControlLease: vi.fn(),
  reportCliClientEvent: vi.fn(),
  userSettings: vi.fn(async () => ({})),
  artifacts: vi.fn(async () => ({ data: [], pagination: { totalPages: 0 } }))
}));
const terminals = vi.hoisted(() => [] as Array<{ emitData(data: string): void }>);

vi.mock("../src/api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/api.js")>()),
  api: apiMock
}));
vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    cols = 100;
    rows = 30;
    options = {};
    modes = { mouseTrackingMode: "none" };
    buffer = { active: { length: 1, viewportY: 0, baseY: 0, cursorY: 0, getLine: () => undefined } };
    element?: HTMLElement;
    textarea?: HTMLTextAreaElement;
    dataHandlers = new Set<(data: string) => void>();
    constructor() { terminals.push(this); }
    loadAddon() {}
    open(host: HTMLElement) {
      Object.defineProperties(host, {
        clientWidth: { configurable: true, value: 800 },
        clientHeight: { configurable: true, value: 400 }
      });
      this.element = document.createElement("div");
      this.element.className = "xterm";
      this.textarea = document.createElement("textarea");
      this.element.appendChild(this.textarea);
      host.appendChild(this.element);
    }
    focus() { this.textarea?.focus(); }
    write(_data: string, callback?: () => void) { callback?.(); }
    writeln() {}
    getSelection() { return ""; }
    clearSelection() {}
    dispose() {}
    refresh() {}
    scrollToBottom() {}
    onData(handler: (data: string) => void) {
      this.dataHandlers.add(handler);
      return { dispose: () => this.dataHandlers.delete(handler) };
    }
    emitData(data: string) { for (const handler of this.dataHandlers) handler(data); }
    attachCustomKeyEventHandler() {}
    onRender() { return { dispose() {} }; }
    onWriteParsed() { return { dispose() {} }; }
    onScroll() { return { dispose() {} }; }
    onResize() { return { dispose() {} }; }
  }
}));
vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    fit() {}
    proposeDimensions() { return { cols: 100, rows: 30 }; }
    dispose() {}
  }
}));
vi.mock("@xterm/addon-web-links", () => ({ WebLinksAddon: class { dispose() {} } }));

const pane: Pane = {
  id: "pane:control-001", roomId: "room:control-001", title: "Codex CLI", titleSource: "auto",
  mode: "TERMINAL", status: "IDLE", providerId: null, modelId: null, reasoningEffort: "medium",
  cwd: "/opt/spaceapp", terminalRuntimeId: "cli:codex", order: 0, columnSpan: 1,
  isMaximized: false, isMinimized: false, isClosed: false,
  split: { parentId: null, direction: null, size: null }, categoryColor: null, vncTarget: null,
  createdAt: "2026-11-02T00:00:00.000Z", updatedAt: "2026-11-02T00:00:00.000Z"
};
const runtime = {
  id: "cli:codex", providerId: "codex", providerName: "Codex", agentId: "codex",
  agentName: "Codex CLI", displayName: "Codex CLI", capabilities: ["CLI"],
  adapterStatus: "ENABLED", authMode: "NONE", authState: "READY", authReason: "Verified fixture.",
  canStartLogin: false, status: "ENABLED", statusReason: "Verified fixture.",
  commandName: "codex", detectedCommandPath: "/opt/spaceapp/bin/codex", defaultModelId: null,
  supportedReasoningEfforts: ["medium", "high"], checkedAt: "2026-11-02T00:00:00.000Z"
};
const sessionResponse = {
  session: {
    sessionId: "cli_session:control-001", paneId: pane.id, roomId: pane.roomId,
    runtimeId: runtime.id, providerId: runtime.providerId, agentId: runtime.agentId,
    modelId: null, cliTaskId: "cli_task:control-001", accountProfileId: null,
    reasoningEffort: "medium", purpose: "NORMAL", cwd: "/opt/spaceapp", status: "RUNNING",
    statusReason: "Fixture is running.", exitCode: null, isActive: true,
    startedAt: pane.createdAt, updatedAt: pane.updatedAt, endedAt: null
  },
  runtime, transcript: [],
  websocket: { paneId: pane.id, sessionId: "cli_session:control-001", token: "fixture", expiresAt: null }
};

type Frame = { type: string; leaseId?: string; data?: string };
let pageHasFocus = true;
// jsdom supplies one document. Scope synchronous browser entry points to the
// receiving client's page, without sending focus/blur events to the other client.
function onPage<T>(focused: boolean, action: () => T): T {
  const previous = pageHasFocus;
  pageHasFocus = focused;
  try { return action(); } finally { pageHasFocus = previous; }
}

class Socket extends EventTarget {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 3;
  static instances: Socket[] = [];
  static leaseId = "cli_control_lease:focused-controller";
  readyState = Socket.CONNECTING;
  sent: Frame[] = [];
  readonly focused = pageHasFocus;
  readonly clientMode: string;
  constructor(readonly url: string) {
    super();
    this.clientMode = new URL(url).searchParams.get("clientMode")!;
    Socket.instances.push(this);
    // Opening is explicit so the test does not depend on timer ordering.
  }
  receive(frame: object) {
    onPage(this.focused, () => this.dispatchEvent(new MessageEvent("message", {
      data: JSON.stringify(frame)
    })));
  }
  open() {
    this.readyState = Socket.OPEN;
    onPage(this.focused, () => this.dispatchEvent(new Event("open")));
    this.receive({
      type: "ready", paneId: pane.id, sessionId: sessionResponse.session.sessionId,
      runtimeId: runtime.id, protocolVersion: 2, clientMode: this.clientMode,
      controlState: this.clientMode === "INTERACTIVE" ? "CONTROLLER" : "OBSERVER",
      leaseId: this.clientMode === "INTERACTIVE" ? Socket.leaseId : null,
      expiresAt: new Date(Date.now() + 60_000).toISOString(), heartbeatIntervalMs: 10_000
    });
    this.receive({ type: "status", status: "RUNNING", statusReason: "Attached.", replayContinuity: "COMPLETE" });
  }
  send(data: string) {
    this.sent.push(JSON.parse(data) as Frame);
  }
  close() {
    this.readyState = Socket.CLOSED;
    this.dispatchEvent(new Event("close"));
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  resetCliClientEventReporter();
  installSpaceRuntime(liveRuntime);
  terminals.length = 0;
  Socket.instances = [];
  pageHasFocus = true;
  vi.spyOn(document, "hasFocus").mockImplementation(() => pageHasFocus);
  vi.stubGlobal("WebSocket", Socket);
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  apiMock.cliRuntimes.mockResolvedValue({ data: [runtime], checkedAt: runtime.checkedAt });
  apiMock.activeCliSession.mockResolvedValue(sessionResponse);
  apiMock.listCliAccountProfiles.mockResolvedValue({ profiles: [] });
  const settings = {
    sessionId: sessionResponse.session.sessionId, threadId: null, current: null,
    models: [], controlMode: "DIRECT", isTurnActive: false
  };
  apiMock.cliModelSettings.mockResolvedValue(settings);
  apiMock.cliModelSettingsStatus.mockResolvedValue({ status: "AVAILABLE", settings });
  apiMock.reportCliClientEvent.mockResolvedValue({ accepted: true });
  apiMock.cliTerminalWebSocketUrl.mockImplementation((ticket, options) =>
    `ws://space.test/terminal?paneId=${encodeURIComponent(ticket.paneId)}` +
    `&sessionId=${encodeURIComponent(ticket.sessionId)}&clientMode=${options.clientMode}`
  );
});

afterEach(() => {
  cleanup();
  resetCliClientEventReporter();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("ignores unsolicited control_upgraded on an unfocused observer while the focused controller keeps its lease (CONTROL-001)", async () => {
  const mountClient = () => render(
    <VoiceInputProvider><TerminalPane pane={pane} terminalFontSize={12} /></VoiceInputProvider>
  );
  mountClient();
  await waitFor(() => expect(Socket.instances).toHaveLength(1));
  const controller = Socket.instances[0]!;
  act(() => controller.open());
  await waitFor(() => expect(terminals).toHaveLength(1));
  expect(controller.clientMode).toBe("INTERACTIVE");
  expect(controller.focused).toBe(true);
  act(() => onPage(true, () => terminals[0]!.emitData("before\r")));
  expect(controller.sent).toContainEqual({ type: "input", data: "before\r", leaseId: Socket.leaseId });

  pageHasFocus = false;
  mountClient();
  await waitFor(() => expect(Socket.instances).toHaveLength(2));
  const observer = Socket.instances[1]!;
  act(() => observer.open());
  await waitFor(() => expect(terminals).toHaveLength(2));
  expect(observer.clientMode).toBe("OBSERVER");
  expect(observer.focused).toBe(false);
  expect(document.visibilityState).toBe("visible");
  expect(document.hasFocus()).toBe(false);
  expect(new URL(observer.url).searchParams.get("paneId")).toBe(new URL(controller.url).searchParams.get("paneId"));
  expect(observer.sent.filter((frame) => frame.type.startsWith("control_"))).toEqual([]);

  apiMock.setCliTerminalControlLease.mockClear();
  act(() => observer.receive({ type: "control_upgraded" }));

  // These assertions reach the real TerminalPane message handler. A socket-only
  // mock cannot pass by filtering the unsolicited frame before it gets there.
  expect(observer.sent.filter((frame) => frame.type === "control_request")).toEqual([]);
  expect(observer.sent.filter((frame) => frame.type.startsWith("control_"))).toEqual([]);
  expect(apiMock.setCliTerminalControlLease).not.toHaveBeenCalled();
  act(() => onPage(true, () => terminals[0]!.emitData("after\r")));
  expect(controller.sent).toContainEqual({ type: "input", data: "after\r", leaseId: Socket.leaseId });
  expect(controller.sent.some((frame) => frame.type === "control_release")).toBe(false);
});
