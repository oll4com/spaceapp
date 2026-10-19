import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pane, PaneBrowserSessionResponse } from "@space/contracts";
import { ManagedYouTubeBrowser as YouTubePane } from "../src/features/browser-pane/ManagedYouTubeBrowser.js";
import { dispatchBrowserPaneActionEvent } from "../src/features/browser-pane/events.js";
import { liveRuntime } from "../src/live/live-runtime.js";
import { installSpaceRuntime } from "../src/runtime/SpaceRuntime.js";

const apiMock = vi.hoisted(() => ({
  browserStatus: vi.fn(),
  browserSession: vi.fn(),
  startBrowserSession: vi.fn(),
  updateBrowserSession: vi.fn(),
  setBrowserViewport: vi.fn(),
  browserFrame: vi.fn(),
  browserStreamTicket: vi.fn(),
  browserStreamWebSocketUrl: vi.fn(),
  browserFrameWebSocketUrl: vi.fn(),
  browserInput: vi.fn(),
  browserAction: vi.fn(),
  acquireBrowserControl: vi.fn(),
  releaseBrowserControl: vi.fn(),
  heartbeatBrowserControl: vi.fn()
}));

vi.mock("../src/api.js", () => ({
  api: apiMock
}));

function pane(overrides: Partial<Pane> = {}): Pane {
  return {
    id: "pane:youtube-proof",
    roomId: "room:youtube-proof",
    title: "YouTube 1",
    titleSource: "auto",
    mode: "YOUTUBE",
    status: "IDLE",
    providerId: null,
    modelId: null,
    reasoningEffort: "medium",
    cwd: null,
    order: 0,
    columnSpan: 1,
    isMaximized: false,
    isMinimized: false,
    isClosed: false,
    split: { parentId: null, direction: null, size: null },
    categoryColor: null,
    vncTarget: null,
    createdAt: "2026-07-06T00:00:00.000Z",
    updatedAt: "2026-07-06T00:00:00.000Z",
    ...overrides
  };
}

function frame(input: Partial<PaneBrowserSessionResponse["frame"]> = {}): NonNullable<PaneBrowserSessionResponse["frame"]> {
  return {
    sessionId: "browser_session:proof",
    paneId: "pane:youtube-proof",
    roomId: "room:youtube-proof",
    status: "READY",
    viewport: "wide",
    currentUrl: "https://www.youtube.com/",
    title: "YouTube",
    screenshotDataUrl: "data:image/png;base64,aGVsbG8=",
    capturedAt: "2026-07-06T00:00:00.000Z",
    ...input
  };
}

function sessionResponse(input: Partial<PaneBrowserSessionResponse["session"]> = {}): PaneBrowserSessionResponse {
  const nextFrame = frame({
    currentUrl: input.currentUrl ?? "https://www.youtube.com/",
    title: input.title ?? "YouTube",
    viewport: input.viewport ?? "wide"
  });
  return {
    session: {
      sessionId: "browser_session:proof",
      paneId: "pane:youtube-proof",
      roomId: "room:youtube-proof",
      ownerAgentId: "agent:4",
      agentNumber: 4,
      profileId: "profile:proof",
      profilePath: "/opt/spaceapp/var/artifacts/browser-profiles/room_youtube-proof/pane_youtube-proof/browser_session",
      viewport: "wide",
      targetUrl: "https://www.youtube.com/",
      currentUrl: "https://www.youtube.com/",
      title: "YouTube",
      status: "READY",
      statusReason: "Page ready.",
      lastFrameAt: "2026-07-06T00:00:00.000Z",
      streamMode: "AUTO",
      resolvedStreamMode: "PREVIEW",
      runtimeState: "READY",
      capacityState: "AVAILABLE",
      controlState: "UNCONTROLLED",
      pages: [],
      activePageId: null,
      workerHeartbeatAt: null,
      queuePosition: null,
      restoreScrollX: null,
      restoreScrollY: null,
      restoreVideoPaused: null,
      isActive: true,
      startedAt: "2026-07-06T00:00:00.000Z",
      updatedAt: "2026-07-06T00:00:00.000Z",
      endedAt: null,
      ...input
    },
    frame: nextFrame,
    websocket: null
  };
}

function streamTicket(sequence: number) {
  return {
    paneId: "pane:youtube-proof",
    sessionId: "browser_session:proof",
    token: `youtube-stream-ticket-${sequence}-test-value`,
    expiresAt: "2026-07-18T01:00:00.000Z"
  };
}

function operatorLease() {
  return {
    lease: {
      leaseId: "browser_lease:operator",
      sessionId: "browser_session:proof",
      paneId: "pane:youtube-proof",
      roomId: "room:youtube-proof",
      holderType: "OPERATOR" as const,
      holderId: "space-user",
      status: "ACTIVE" as const,
      reason: "Direct YouTube interaction",
      acquiredAt: "2026-07-18T00:00:00.000Z",
      heartbeatAt: "2026-07-18T00:00:00.000Z",
      expiresAt: "2026-07-18T00:01:00.000Z",
      releasedAt: null
    }
  };
}

class MockBrowserWebSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: MockBrowserWebSocket[] = [];

  readonly url: string;
  readyState = MockBrowserWebSocket.CONNECTING;
  bufferedAmount = 0;
  binaryType: BinaryType = "blob";
  sent: string[] = [];

  constructor(url: string | URL) {
    super();
    this.url = String(url);
    MockBrowserWebSocket.instances.push(this);
    queueMicrotask(() => {
      if (this.readyState !== MockBrowserWebSocket.CONNECTING) return;
      this.readyState = MockBrowserWebSocket.OPEN;
      this.dispatchEvent(new Event("open"));
    });
  }

  send(data: string | ArrayBufferLike | Blob | ArrayBufferView) {
    this.sent.push(typeof data === "string" ? data : "[binary]");
  }

  close() {
    if (this.readyState === MockBrowserWebSocket.CLOSED) return;
    this.readyState = MockBrowserWebSocket.CLOSED;
    this.dispatchEvent(new Event("close"));
  }

  serverMessage(message: unknown) {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(message) }));
  }

  static reset() {
    MockBrowserWebSocket.instances = [];
  }
}

describe("YouTubePane", () => {
  beforeEach(() => {
    installSpaceRuntime(liveRuntime);
    vi.useRealTimers();
    MockBrowserWebSocket.reset();
    vi.stubGlobal("WebSocket", MockBrowserWebSocket);
    for (const mock of Object.values(apiMock)) {
      if (typeof mock === "function" && "mockReset" in mock) mock.mockReset();
    }
    apiMock.browserStatus.mockResolvedValue({
      enabled: true,
      statusReason: "Managed Chrome browser sessions are enabled.",
      defaultUrl: "https://www.google.com/",
      checkedAt: "2026-07-06T00:00:00.000Z"
    });
    apiMock.browserSession.mockRejectedValue(new Error("not found"));
    apiMock.startBrowserSession.mockResolvedValue(sessionResponse());
    apiMock.updateBrowserSession.mockResolvedValue(sessionResponse());
    apiMock.browserFrame.mockResolvedValue(frame());
    apiMock.browserStreamTicket.mockRejectedValue(new Error("legacy browser host"));
    apiMock.browserStreamWebSocketUrl.mockReturnValue(null);
    apiMock.browserFrameWebSocketUrl.mockReturnValue(null);
    apiMock.browserInput.mockResolvedValue(sessionResponse());
    apiMock.browserAction.mockResolvedValue({ session: sessionResponse().session, frame: frame(), text: null });
    apiMock.acquireBrowserControl.mockRejectedValue(new Error("legacy browser host"));
    apiMock.releaseBrowserControl.mockRejectedValue(new Error("legacy browser host"));
    apiMock.heartbeatBrowserControl.mockRejectedValue(new Error("legacy browser host"));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("submits the selected Google identifier once and leaves the password for the user", async () => {
    const targetUrl = "https://accounts.google.com/ServiceLogin?service=youtube&Email=test%40example.com";
    const response = sessionResponse({ targetUrl, currentUrl: "https://accounts.google.com/v3/signin/identifier" });
    apiMock.startBrowserSession.mockResolvedValue(response);
    apiMock.acquireBrowserControl.mockResolvedValue(operatorLease());
    apiMock.browserInput.mockResolvedValue(sessionResponse({ targetUrl, currentUrl: "https://accounts.google.com/v3/signin/challenge/pwd" }));
    const view = render(<YouTubePane pane={pane()} agentNumber={4} targetUrl={targetUrl} />);
    await screen.findByRole("img", { name: "YouTube 1 browser frame" });
    apiMock.browserSession.mockResolvedValue(response);
    expect(apiMock.browserInput).not.toHaveBeenCalled();
    await waitFor(() => expect(apiMock.browserInput).toHaveBeenCalledTimes(2), { timeout: 2500 });
    expect(apiMock.browserInput).toHaveBeenCalledWith(pane().id, expect.objectContaining({ eventType: "keyDown", key: "Enter", text: "\r" }));
    expect(apiMock.browserInput.mock.calls.map(([, input]) => [input.eventType, input.key])).toEqual([["keyDown", "Enter"], ["keyUp", "Enter"]]);
    view.rerender(<YouTubePane pane={pane()} agentNumber={4} targetUrl={targetUrl} />);
    expect(apiMock.browserInput).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("button", { name: "Continue sign-in" })).toBeNull();
  });

  it.each([
    ["https://accounts.google.com/v3/signin/challenge/pwd", false],
    ["https://accounts.google.com/v3/signin/identifier", true],
    ["https://www.youtube.com/", false]
  ])("rechecks the Google page after loading before sending Next: %s", async (currentUrl, shouldContinue) => {
    const targetUrl = "https://accounts.google.com/ServiceLogin?service=youtube&Email=test%40example.com";
    apiMock.startBrowserSession.mockResolvedValue(sessionResponse({ targetUrl, currentUrl: targetUrl }));
    apiMock.acquireBrowserControl.mockResolvedValue(operatorLease());
    vi.useFakeTimers();
    await act(async () => { render(<YouTubePane pane={pane()} agentNumber={4} targetUrl={targetUrl} />); });
    apiMock.browserSession.mockResolvedValue(sessionResponse({ targetUrl, currentUrl }));
    expect(apiMock.browserInput).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(apiMock.browserInput).toHaveBeenCalledTimes(shouldContinue ? 2 : 0);
    vi.useRealTimers();
  });

  it("cancels pending Google identifier input when the account pane unmounts", async () => {
    const targetUrl = "https://accounts.google.com/ServiceLogin?Email=test%40example.com";
    const response = sessionResponse({ targetUrl, currentUrl: targetUrl });
    apiMock.startBrowserSession.mockResolvedValue(response);
    apiMock.acquireBrowserControl.mockResolvedValue(operatorLease());
    vi.useFakeTimers();
    let view: ReturnType<typeof render>;
    await act(async () => { view = render(<YouTubePane pane={pane()} agentNumber={4} targetUrl={targetUrl} />); });
    apiMock.browserSession.mockResolvedValue(response);
    view!.unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(apiMock.browserInput).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("never auto-submits a Google password challenge or an ordinary YouTube page", async () => {
    const targetUrl = "https://accounts.google.com/ServiceLogin?service=youtube&Email=test%40example.com";
    apiMock.startBrowserSession.mockResolvedValue(sessionResponse({ targetUrl, currentUrl: "https://accounts.google.com/v3/signin/challenge/pwd" }));
    render(<YouTubePane pane={pane()} agentNumber={4} targetUrl={targetUrl} />);
    await screen.findByRole("img", { name: "YouTube 1 browser frame" });
    expect(apiMock.browserInput).not.toHaveBeenCalled();
  });

  it("starts a session locked to the YouTube URL, wide viewport and REALTIME streaming in one request", async () => {
    render(<YouTubePane pane={pane()} agentNumber={4} />);

    expect(await screen.findByRole("img", { name: "YouTube 1 browser frame" })).toBeTruthy();
    await waitFor(() =>
      expect(apiMock.startBrowserSession).toHaveBeenCalledWith("pane:youtube-proof", {
        viewport: "wide",
        targetUrl: "https://www.youtube.com/",
        ownerAgentId: "agent:4",
        streamMode: "REALTIME",
        includeInitialFrame: false
      })
    );
    expect(apiMock.updateBrowserSession).not.toHaveBeenCalled();
  });

  it("fits the managed YouTube page to the pane without restarting the browser session", async () => {
    vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
    const bounds = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ width: 480, height: 560 } as DOMRect);
    apiMock.setBrowserViewport.mockResolvedValue({ ...sessionResponse(), viewportDimensions: { width: 480, height: 560 } });
    try {
      render(<YouTubePane pane={pane()} agentNumber={4} />);
      await waitFor(() => expect(apiMock.setBrowserViewport).toHaveBeenCalledWith("pane:youtube-proof", "desktop", { width: 480, height: 560 }));
      expect(apiMock.startBrowserSession).toHaveBeenCalledTimes(1);
    } finally { bounds.mockRestore(); }
  });

  it("renders no editable URL form, toolbox or internal control bar", async () => {
    apiMock.browserSession.mockResolvedValue(sessionResponse());

    render(<YouTubePane pane={pane()} agentNumber={4} />);

    await screen.findByRole("img", { name: "YouTube 1 browser frame" });
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByRole("button", { name: /Browser URL/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /More browser actions/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Browser bookmarks/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Stream mode/ })).toBeNull();
    expect(screen.queryByRole("group", { name: /Browser viewport/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Record browser session/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Reload YouTube/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Expand to fullscreen view/ })).toBeNull();
  });

  it("reports the realtime stream as ready through pane telemetry", async () => {
    const response = sessionResponse({ streamMode: "REALTIME", resolvedStreamMode: "REALTIME" });
    apiMock.startBrowserSession.mockResolvedValue({ ...response, websocket: streamTicket(0) });
    apiMock.browserStreamTicket.mockResolvedValue({ websocket: streamTicket(1) });
    apiMock.browserStreamWebSocketUrl.mockReturnValue("ws://space.test/browser/stream");

    const { container } = render(<YouTubePane pane={pane()} agentNumber={4} />);

    await screen.findByRole("img", { name: "YouTube 1 browser frame" });
    await waitFor(() => expect(MockBrowserWebSocket.instances.length).toBeGreaterThan(0));
    const socket = MockBrowserWebSocket.instances.at(-1)!;
    socket.serverMessage({
      type: "ready",
      paneId: "pane:youtube-proof",
      sessionId: "browser_session:proof",
      streamId: "stream:proof",
      encoding: "image/jpeg",
      requestedMode: "REALTIME",
      resolvedMode: "REALTIME",
      framesPerSecond: 24
    });

    await waitFor(() =>
      expect(container.querySelector(".youtube-pane")?.getAttribute("data-browser-stream-state")).toBe("ready")
    );
  });

  it("routes interactive canvas input over the live stream when control is acquired", async () => {
    const response = sessionResponse({ streamMode: "REALTIME", resolvedStreamMode: "REALTIME" });
    apiMock.startBrowserSession.mockResolvedValue({ ...response, websocket: streamTicket(0) });
    apiMock.browserStreamTicket.mockResolvedValue({ websocket: streamTicket(1) });
    apiMock.browserStreamWebSocketUrl.mockReturnValue("ws://space.test/browser/stream");
    apiMock.acquireBrowserControl.mockResolvedValue(operatorLease());

    render(<YouTubePane pane={pane()} agentNumber={4} />);

    const image = await screen.findByRole("img", { name: "YouTube 1 browser frame" });
    await waitFor(() => expect(MockBrowserWebSocket.instances.length).toBeGreaterThan(0));
    const socket = MockBrowserWebSocket.instances.at(-1)!;
    socket.serverMessage({
      type: "ready",
      paneId: "pane:youtube-proof",
      sessionId: "browser_session:proof",
      streamId: "stream:proof",
      encoding: "image/jpeg",
      requestedMode: "REALTIME",
      resolvedMode: "REALTIME",
      framesPerSecond: 24
    });

    image.getBoundingClientRect = () =>
      ({
        left: 0,
        top: 0,
        width: 417,
        height: 556,
        right: 417,
        bottom: 556,
        x: 0,
        y: 0,
        toJSON: () => undefined
      }) as DOMRect;
    fireEvent.pointerDown(image, { pointerId: 1, pointerType: "mouse", clientX: 208, clientY: 278, button: 0, buttons: 1 });
    fireEvent.pointerUp(image, { pointerId: 1, pointerType: "mouse", clientX: 208, clientY: 278, button: 0, buttons: 0 });

    await waitFor(() => expect(socket.sent.length).toBeGreaterThan(0));
    const sentInput = JSON.parse(socket.sent.at(-1)!) as { type: string; input: { type: string; eventType: string } };
    expect(sentInput.type).toBe("input");
    expect(sentInput.input.type).toBe("POINTER");
    expect(sentInput.input.eventType).toBe("mouseReleased");
  });

  it("acknowledges consumed live frames so YouTube continues beyond the four-frame server limit", async () => {
    let finishDecode: ((value: { close(): void }) => void) | undefined;
    const decode = vi.fn(() => new Promise<{ close(): void }>(resolve => { finishDecode = resolve; }));
    vi.stubGlobal("createImageBitmap", decode);
    const response = sessionResponse();
    apiMock.startBrowserSession.mockResolvedValue({ ...response, frame: null, websocket: streamTicket(0) });
    apiMock.browserStreamTicket.mockResolvedValue({ websocket: streamTicket(1) });
    apiMock.browserStreamWebSocketUrl.mockReturnValue("ws://space.test/browser/stream?frameAck=1");
    const view = render(<YouTubePane pane={pane()} agentNumber={4} />);
    await waitFor(() => expect(MockBrowserWebSocket.instances.length).toBeGreaterThan(0));
    const socket = MockBrowserWebSocket.instances.at(-1)!;
    const acks = () => socket.sent.filter(message => JSON.parse(message).type === "frameAck");
    for (let index = 0; index < 6; index++) {
      await act(async () => { socket.dispatchEvent(new MessageEvent("message", { data: new Blob(["frame"]) })); });
      expect(acks()).toHaveLength(index);
      await act(async () => { finishDecode!({ close() {} }); });
      expect(acks()).toHaveLength(index + 1);
    }
    await act(async () => { socket.dispatchEvent(new MessageEvent("message", { data: new Blob(["last frame"]) })); });
    view.unmount();
    await act(async () => { finishDecode!({ close() {} }); });
    expect(acks()).toHaveLength(6);
  });

  it("forwards special keys such as Backspace over the live stream", async () => {
    const response = sessionResponse({ streamMode: "REALTIME", resolvedStreamMode: "REALTIME" });
    apiMock.startBrowserSession.mockResolvedValue({ ...response, websocket: streamTicket(0) });
    apiMock.browserStreamTicket.mockResolvedValue({ websocket: streamTicket(1) });
    apiMock.browserStreamWebSocketUrl.mockReturnValue("ws://space.test/browser/stream");
    apiMock.acquireBrowserControl.mockResolvedValue(operatorLease());

    render(<YouTubePane pane={pane()} agentNumber={4} />);

    const image = await screen.findByRole("img", { name: "YouTube 1 browser frame" });
    await waitFor(() => expect(MockBrowserWebSocket.instances.length).toBeGreaterThan(0));
    const socket = MockBrowserWebSocket.instances.at(-1)!;
    socket.serverMessage({
      type: "ready",
      paneId: "pane:youtube-proof",
      sessionId: "browser_session:proof",
      streamId: "stream:proof",
      encoding: "image/jpeg",
      requestedMode: "REALTIME",
      resolvedMode: "REALTIME",
      framesPerSecond: 24
    });

    fireEvent.keyDown(image, { key: "Backspace", code: "Backspace" });

    await waitFor(() => expect(socket.sent.length).toBeGreaterThan(0));
    const sentInput = JSON.parse(socket.sent.at(-1)!) as { type: string; input: { type: string; key: string; eventType: string } };
    expect(sentInput.type).toBe("input");
    expect(sentInput.input.type).toBe("KEY");
    expect(sentInput.input.eventType).toBe("keyDown");
    expect(sentInput.input.key).toBe("Backspace");
  });

  it("sends pasted OS clipboard text as a char input over the live stream", async () => {
    const response = sessionResponse({ streamMode: "REALTIME", resolvedStreamMode: "REALTIME" });
    apiMock.startBrowserSession.mockResolvedValue({ ...response, websocket: streamTicket(0) });
    apiMock.browserStreamTicket.mockResolvedValue({ websocket: streamTicket(1) });
    apiMock.browserStreamWebSocketUrl.mockReturnValue("ws://space.test/browser/stream");
    apiMock.acquireBrowserControl.mockResolvedValue(operatorLease());

    render(<YouTubePane pane={pane()} agentNumber={4} />);

    const image = await screen.findByRole("img", { name: "YouTube 1 browser frame" });
    await waitFor(() => expect(MockBrowserWebSocket.instances.length).toBeGreaterThan(0));
    const socket = MockBrowserWebSocket.instances.at(-1)!;
    socket.serverMessage({
      type: "ready",
      paneId: "pane:youtube-proof",
      sessionId: "browser_session:proof",
      streamId: "stream:proof",
      encoding: "image/jpeg",
      requestedMode: "REALTIME",
      resolvedMode: "REALTIME",
      framesPerSecond: 24
    });

    fireEvent.paste(image, { clipboardData: { getData: () => "operator@example.invalid" } });

    await waitFor(() => expect(socket.sent.length).toBeGreaterThan(0));
    const sentInput = JSON.parse(socket.sent.at(-1)!) as { type: string; input: { type: string; key: string; eventType: string; text: string } };
    expect(sentInput.type).toBe("input");
    expect(sentInput.input.type).toBe("KEY");
    expect(sentInput.input.eventType).toBe("char");
    expect(sentInput.input.text).toBe("operator@example.invalid");
  });

  it("reloads YouTube over the live stream when the pane toolbar reload action fires", async () => {
    const response = sessionResponse({ streamMode: "REALTIME", resolvedStreamMode: "REALTIME" });
    apiMock.startBrowserSession.mockResolvedValue({ ...response, websocket: streamTicket(0) });
    apiMock.browserStreamTicket.mockResolvedValue({ websocket: streamTicket(1) });
    apiMock.browserStreamWebSocketUrl.mockReturnValue("ws://space.test/browser/stream");
    apiMock.acquireBrowserControl.mockResolvedValue(operatorLease());

    render(<YouTubePane pane={pane()} agentNumber={4} />);

    await screen.findByRole("img", { name: "YouTube 1 browser frame" });
    await waitFor(() => expect(MockBrowserWebSocket.instances.length).toBeGreaterThan(0));
    const socket = MockBrowserWebSocket.instances.at(-1)!;
    socket.serverMessage({
      type: "ready",
      paneId: "pane:youtube-proof",
      sessionId: "browser_session:proof",
      streamId: "stream:proof",
      encoding: "image/jpeg",
      requestedMode: "REALTIME",
      resolvedMode: "REALTIME",
      framesPerSecond: 24
    });

    dispatchBrowserPaneActionEvent({ paneId: "pane:youtube-proof", action: "reload" });

    await waitFor(() => expect(socket.sent.length).toBeGreaterThan(0));
    const sentInput = JSON.parse(socket.sent.at(-1)!) as { type: string; input: { type: string; action: string } };
    expect(sentInput.type).toBe("input");
    expect(sentInput.input.type).toBe("NAVIGATION");
    expect(sentInput.input.action).toBe("RELOAD");
  });

  it("falls back to the browser input endpoint when the stream is not connected", async () => {
    apiMock.acquireBrowserControl.mockResolvedValue(operatorLease());

    render(<YouTubePane pane={pane()} agentNumber={4} />);

    await screen.findByRole("img", { name: "YouTube 1 browser frame" });
    dispatchBrowserPaneActionEvent({ paneId: "pane:youtube-proof", action: "reload" });

    await waitFor(() =>
      expect(apiMock.browserInput).toHaveBeenCalledWith("pane:youtube-proof", {
        type: "NAVIGATION",
        action: "RELOAD",
        leaseId: "browser_lease:operator"
      })
    );
  });

  it("keeps heartbeating browser control past the expiry of the first lease", async () => {
    const lease = operatorLease();
    apiMock.acquireBrowserControl.mockResolvedValue(lease);
    const intervals = vi.spyOn(window, "setInterval");
    render(<YouTubePane pane={pane()} agentNumber={4} />);
    await screen.findByRole("img", { name: "YouTube 1 browser frame" });
    dispatchBrowserPaneActionEvent({ paneId: "pane:youtube-proof", action: "reload" });
    await waitFor(() => expect(apiMock.browserInput).toHaveBeenCalled());
    const heartbeat = intervals.mock.calls.filter(([, delay]) => delay === 15_000).at(-1)?.[0] as (() => void) | undefined;
    expect(heartbeat).toBeTypeOf("function");
    const start = Date.parse(lease.lease.acquiredAt);
    const now = vi.spyOn(Date, "now");
    try {
      // Six ticks span 90 s, well past the 60 s expiry of the lease that started the heartbeat.
      for (let tick = 1; tick <= 6; tick++) {
        const at = start + tick * 15_000;
        now.mockReturnValue(at);
        apiMock.heartbeatBrowserControl.mockResolvedValueOnce({
          lease: { ...lease.lease, heartbeatAt: new Date(at).toISOString(), expiresAt: new Date(at + 60_000).toISOString() }
        });
        await act(async () => { heartbeat!(); await Promise.resolve(); });
      }
      expect(apiMock.heartbeatBrowserControl).toHaveBeenCalledTimes(6);
      expect(apiMock.heartbeatBrowserControl).toHaveBeenLastCalledWith("pane:youtube-proof", { leaseId: "browser_lease:operator", ttlSeconds: 60 });
    } finally {
      now.mockRestore();
      intervals.mockRestore();
    }
  });
});
