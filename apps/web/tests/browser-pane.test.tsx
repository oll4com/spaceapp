import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Artifact, BrowserCaptureJob, BrowserCaptureOptions, BrowserFrame, MarketingBookmark, Pane, PaneBrowserSessionResponse } from "@space/contracts";
import { BROWSER_PANE_ACTION_EVENT, BrowserPane, queueBrowserHttpInput } from "../src/features/browser-pane/BrowserPane.js";
import { liveRuntime } from "../src/live/live-runtime.js";
import { installSpaceRuntime } from "../src/runtime/SpaceRuntime.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const apiMock = vi.hoisted(() => ({
  artifactFileUrl: vi.fn((artifactId: string) => `/api/artifacts/${encodeURIComponent(artifactId)}/file`),
  artifacts: vi.fn(),
  browserAction: vi.fn(),
  browserFrame: vi.fn(),
  browserFrameWebSocketUrl: vi.fn(),
  browserStreamWebSocketUrl: vi.fn(),
  browserStreamTicket: vi.fn(),
  browserInput: vi.fn(),
  browserPages: vi.fn(),
  browserAccounts: vi.fn(),
  selectBrowserAccount: vi.fn(),
  createPane: vi.fn(),
  setBrowserPageAccount: vi.fn(),
  panes: vi.fn(),
  createBrowserPage: vi.fn(),
  createMarketingBookmark: vi.fn(),
  deleteMarketingBookmark: vi.fn(),
  marketingBookmarks: vi.fn(),
  openMarketingBookmark: vi.fn(),
  closeBrowserPage: vi.fn(),
  activateBrowserPage: vi.fn(),
  acquireBrowserControl: vi.fn(),
  releaseBrowserControl: vi.fn(),
  heartbeatBrowserControl: vi.fn(),
  createBrowserCapture: vi.fn(),
  stopBrowserCapture: vi.fn(),
  cancelBrowserCapture: vi.fn(),
  browserCapture: vi.fn(),
  browserCaptureSegments: vi.fn(),
  browserCaptureTimeline: vi.fn(),
  browserRecordingManifest: vi.fn(),
  browserDiagnostics: vi.fn(),
  browserSession: vi.fn(),
  browserStatus: vi.fn(),
  navigateBrowser: vi.fn(),
  setBrowserViewport: vi.fn(),
  updateBrowserSession: vi.fn(),
  startBrowserSession: vi.fn(),
  stopBrowserSession: vi.fn(),
  updateArtifactRetention: vi.fn()
}));

vi.mock("../src/api.js", () => ({
  api: apiMock
}));

function browserPane(overrides: Partial<Pane> = {}): Pane {
  return {
    id: "pane:browser-proof",
    roomId: "room:browser-proof",
    title: "Research Browser",
    titleSource: "auto",
    mode: "BROWSER",
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

function frame(input: Partial<BrowserFrame> = {}): BrowserFrame {
  return {
    sessionId: "browser_session:proof",
    paneId: "pane:browser-proof",
    roomId: "room:browser-proof",
    status: "READY",
    viewport: "desktop",
    currentUrl: "https://www.google.com/",
    title: "Olla",
    screenshotDataUrl: "data:image/png;base64,aGVsbG8=",
    capturedAt: "2026-07-06T00:00:00.000Z",
    ...input
  };
}

function sessionResponse(input: Partial<PaneBrowserSessionResponse["session"]> = {}): PaneBrowserSessionResponse {
  const nextFrame = frame({
    currentUrl: input.currentUrl ?? "https://www.google.com/",
    title: input.title ?? "Olla",
    viewport: input.viewport ?? "desktop"
  });
  return {
    session: {
      sessionId: "browser_session:proof",
      paneId: "pane:browser-proof",
      roomId: "room:browser-proof",
      ownerAgentId: "agent:4",
      agentNumber: 4,
      profileId: "profile:proof",
      profilePath: "/opt/spaceapp/var/artifacts/browser-profiles/room_browser-proof/pane_browser-proof/browser_session",
      viewport: "desktop",
      targetUrl: "https://www.google.com/",
      currentUrl: "https://www.google.com/",
      title: "Olla",
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

function bookmark(id: string, title: string, url = "https://www.google.com/"): MarketingBookmark {
  return { id, ownerUserId: "user:operator", title, url, profileId: "google_account:primary", accountLabel: "primary@example.com", createdAt: "2026-07-06T00:00:00.000Z" };
}

function captureJob(jobId: string, options: BrowserCaptureOptions, status: BrowserCaptureJob["status"]): BrowserCaptureJob {
  return {
    jobId,
    sessionId: "browser_session:proof",
    paneId: "pane:browser-proof",
    roomId: "room:browser-proof",
    requestedByType: "OPERATOR",
    requestedById: "space-user",
    status,
    options,
    progressPercent: status === "COMPLETED" ? 100 : 25,
    statusReason: null,
    artifactIds: status === "COMPLETED" ? ["artifact:proof"] : [],
    queuedAt: "2026-07-11T00:00:00.000Z",
    startedAt: "2026-07-11T00:00:01.000Z",
    updatedAt: "2026-07-11T00:00:02.000Z",
    completedAt: status === "COMPLETED" ? "2026-07-11T00:00:02.000Z" : null
  };
}

function streamTicket(sequence: number) {
  return {
    paneId: "pane:browser-proof",
    sessionId: "browser_session:proof",
    token: `browser-stream-ticket-${sequence}-test-value`,
    expiresAt: "2026-07-18T01:00:00.000Z"
  };
}

function streamingSessionResponse(): PaneBrowserSessionResponse {
  const response = sessionResponse({ streamMode: "REALTIME", resolvedStreamMode: "REALTIME" });
  return { ...response, websocket: streamTicket(0) };
}

function operatorLease() {
  return {
    lease: {
      leaseId: "browser_lease:operator",
      sessionId: "browser_session:proof",
      paneId: "pane:browser-proof",
      roomId: "room:browser-proof",
      holderType: "OPERATOR" as const,
      holderId: "space-user",
      status: "ACTIVE" as const,
      reason: "Direct browser interaction",
      acquiredAt: "2026-07-18T00:00:00.000Z",
      heartbeatAt: "2026-07-18T00:00:00.000Z",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
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

async function openBrowserActions(): Promise<HTMLElement> {
  const more = await screen.findByRole("button", { name: "More browser actions Research Browser" });
  if (more.getAttribute("aria-expanded") !== "true") fireEvent.click(more);
  return screen.findByRole("menu", { name: "Browser actions Research Browser" });
}

async function browserAction(name: string): Promise<HTMLButtonElement> {
  const menu = await openBrowserActions();
  const action = within(menu).getByRole("menuitem", { name }) as HTMLButtonElement;
  await waitFor(() => expect(action.disabled).toBe(false));
  return action;
}

async function chooseBrowserAction(name: string): Promise<void> {
  fireEvent.click(await browserAction(name));
}

describe("BrowserPane", () => {
  it("opens a mobile browser session with mobile viewport", async () => {
    apiMock.startBrowserSession.mockResolvedValue(sessionResponse({ viewport: "mobile" }));
    render(<BrowserPane pane={browserPane()} agentNumber={4} mobile />);
    await waitFor(() => expect(apiMock.startBrowserSession).toHaveBeenCalledWith("pane:browser-proof", expect.objectContaining({ viewport: "mobile" })));
  });
  beforeEach(() => {
    installSpaceRuntime(liveRuntime);
    vi.useRealTimers();
    MockBrowserWebSocket.reset();
    vi.stubGlobal("WebSocket", MockBrowserWebSocket);
    for (const mock of Object.values(apiMock)) {
      if (typeof mock === "function" && "mockReset" in mock) mock.mockReset();
    }
    apiMock.marketingBookmarks.mockResolvedValue({ bookmarks: [] });
    apiMock.artifactFileUrl.mockImplementation((artifactId: string) => `/api/artifacts/${encodeURIComponent(artifactId)}/file`);
    apiMock.artifacts.mockResolvedValue({ data: [], pagination: { page: 1, pageSize: 100, totalItems: 0, totalPages: 0 } });
    apiMock.browserFrameWebSocketUrl.mockReturnValue(null);
    apiMock.browserStreamWebSocketUrl.mockReturnValue(null);
    apiMock.browserStreamTicket.mockRejectedValue(new Error("legacy browser host"));
    apiMock.browserStatus.mockResolvedValue({
      enabled: true,
      statusReason: "Managed Chrome browser sessions are enabled.",
      defaultUrl: "https://www.google.com/",
      checkedAt: "2026-07-06T00:00:00.000Z"
    });
    apiMock.browserSession.mockRejectedValue(new Error("not found"));
    apiMock.startBrowserSession.mockResolvedValue(sessionResponse());
    apiMock.browserFrame.mockResolvedValue(frame());
    apiMock.browserAction.mockResolvedValue({ session: sessionResponse().session, frame: frame(), text: null });
    apiMock.browserInput.mockResolvedValue(sessionResponse());
    apiMock.navigateBrowser.mockResolvedValue(sessionResponse());
    apiMock.setBrowserViewport.mockResolvedValue(sessionResponse());
    apiMock.updateBrowserSession.mockResolvedValue(sessionResponse());
    apiMock.browserPages.mockRejectedValue(new Error("legacy browser host"));
    apiMock.browserAccounts.mockResolvedValue({ selectedProfileId: null, profiles: [] });
    apiMock.acquireBrowserControl.mockRejectedValue(new Error("legacy browser host"));
    apiMock.releaseBrowserControl.mockRejectedValue(new Error("legacy browser host"));
    apiMock.createBrowserCapture.mockRejectedValue(new Error("legacy browser host"));
    apiMock.stopBrowserCapture.mockRejectedValue(new Error("legacy browser host"));
    apiMock.cancelBrowserCapture.mockRejectedValue(new Error("legacy browser host"));
    apiMock.browserCaptureSegments.mockRejectedValue(new Error("legacy browser host"));
    apiMock.browserCaptureTimeline.mockRejectedValue(new Error("legacy browser host"));
    apiMock.browserDiagnostics.mockRejectedValue(new Error("legacy browser host"));
    apiMock.stopBrowserSession.mockResolvedValue({ ok: true, paneId: "pane:browser-proof" });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("does not stack page-list polls while the previous read is slow", async () => {
    apiMock.browserSession.mockResolvedValue(sessionResponse());
    let settle!: (value: any) => void;
    apiMock.browserPages.mockReturnValue(new Promise(resolve => { settle = resolve; }));
    const view = render(<BrowserPane pane={browserPane()} agentNumber={4} />);
    await waitFor(() => expect(apiMock.browserPages).toHaveBeenCalledTimes(1));
    vi.useFakeTimers();
    try {
      view.rerender(<BrowserPane pane={browserPane()} agentNumber={4} isVisible={false} />);
      view.rerender(<BrowserPane pane={browserPane()} agentNumber={4} isVisible />);
      await act(() => vi.advanceTimersByTimeAsync(30_000));
      expect(apiMock.browserPages).toHaveBeenCalledTimes(1);
      await act(async () => settle({ sessionId: "browser_session:proof", pages: [], activePageId: null }));
      view.rerender(<BrowserPane pane={browserPane()} agentNumber={4} isVisible={false} />);
      await act(() => vi.advanceTimersByTimeAsync(30_000));
      expect(apiMock.browserPages).toHaveBeenCalledTimes(1);
    } finally { view.unmount(); vi.useRealTimers(); }
  });

  it("never starts a missing browser session in diagnostics observer mode", async () => {
    apiMock.browserSession.mockRejectedValue(new Error("not found"));

    render(<BrowserPane pane={browserPane()} agentNumber={4} observerOnly />);

    await waitFor(() => expect(apiMock.browserSession).toHaveBeenCalledWith("pane:browser-proof"));
    expect(apiMock.startBrowserSession).not.toHaveBeenCalled();
  });

  it("lets the user edit and retry a different URL after browser startup fails", async () => {
    apiMock.browserSession.mockRejectedValue(new Error("not found"));
    apiMock.startBrowserSession.mockRejectedValueOnce(new Error("BROWSER_HOST_UNAVAILABLE: The Browser Host is unavailable."));
    render(<BrowserPane pane={browserPane()} agentNumber={4} />);
    await screen.findByRole("alert");
    const input = screen.getByRole("textbox", { name: "Browser URL Research Browser" }) as HTMLInputElement;
    expect(input.disabled).toBe(false);
    fireEvent.change(input, { target: { value: "https://example.com/recovered" } });
    apiMock.startBrowserSession.mockResolvedValue(sessionResponse({ targetUrl: "https://example.com/recovered", currentUrl: "https://example.com/recovered" }));
    fireEvent.click(screen.getByRole("button", { name: "Navigate browser Research Browser" }));
    await waitFor(() => expect(apiMock.startBrowserSession).toHaveBeenLastCalledWith("pane:browser-proof", expect.objectContaining({ targetUrl: "https://example.com/recovered" })));
  });

  it("selects a saved Google account in its own browser session", async () => {
    apiMock.browserSession.mockResolvedValue(sessionResponse());
    // The menu reloads the server's accounts whenever it opens.
    let saved: string | null = null;
    apiMock.browserAccounts.mockImplementation(async () => ({ selectedProfileId: saved, profiles: [{ profileId: "google-1", displayName: "Google 1" }] }));
    const targetUrl = "https://accounts.google.com/ServiceLogin?continue=https%3A%2F%2Fwww.google.com%2F";
    apiMock.selectBrowserAccount.mockImplementation(async (_paneId: string, profileId: string | null) => { saved = profileId; return { selectedProfileId: profileId, targetUrl }; });
    apiMock.startBrowserSession.mockResolvedValue(sessionResponse({ sessionId: "browser_session:google-1", targetUrl, currentUrl: targetUrl }));
    render(<BrowserPane pane={browserPane()} agentNumber={4} />);
    const picker = await screen.findByLabelText("Google account for Research Browser");
    await waitFor(() => expect(picker.hasAttribute("disabled")).toBe(false));
    fireEvent.click(picker);
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Google 1" }));
    await waitFor(() => expect(apiMock.startBrowserSession).toHaveBeenCalledWith("pane:browser-proof", expect.objectContaining({ targetUrl })));
    expect(apiMock.selectBrowserAccount).toHaveBeenCalledWith("pane:browser-proof", "google-1");
    expect(picker.getAttribute("aria-expanded")).toBe("false");
    await waitFor(() => expect(picker.hasAttribute("disabled")).toBe(false));
    fireEvent.click(picker);
    expect(screen.getByRole("menuitemradio", { name: "Google 1" }).getAttribute("aria-checked")).toBe("true");
    expect(await screen.findByText("Sign in once per Google account. Every Browser and YouTube pane using that account stays signed in.")).toBeTruthy();
    expect(screen.getByText("Shared by all panes")).toBeTruthy();
    expect(screen.getByText("This pane only")).toBeTruthy();
    expect(screen.getByRole("menuitemradio", { name: "Private pane profile" }).getAttribute("aria-checked")).toBe("false");
    fireEvent.keyDown(screen.getByRole("menu", { name: "Google accounts for Research Browser" }), { key: "Escape" });
    expect(picker.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(picker);
  });

  it("offers the Google account menu in a Job Copilot pane browser", async () => {
    apiMock.browserSession.mockResolvedValue(sessionResponse());
    apiMock.browserAccounts.mockResolvedValue({ selectedProfileId: null, effectiveProfileId: "google_account:primary", profiles: [
      { profileId: "google_account:primary", displayName: "Primary", email: "primary@example.test", browserStatus: "CONNECTED" }] });
    apiMock.selectBrowserAccount.mockResolvedValue({ selectedProfileId: "google_account:primary", targetUrl: "https://www.google.com/" });
    apiMock.startBrowserSession.mockResolvedValue(sessionResponse());
    render(<BrowserPane pane={browserPane({ mode: "JOB_APPLY", title: "Iris" })} agentNumber={4} />);
    const picker = await screen.findByLabelText("Google account for Iris");
    await waitFor(() => expect(picker.hasAttribute("disabled")).toBe(false));
    expect(apiMock.browserAccounts).toHaveBeenCalledWith("pane:browser-proof");
    fireEvent.click(picker);
    fireEvent.click(screen.getAllByRole("menuitemradio")[0]!);
    await waitFor(() => expect(apiMock.selectBrowserAccount).toHaveBeenCalledWith("pane:browser-proof", "google_account:primary"));
  });

  it("switches accounts when Job Copilot Setup asks for one and announces the switch", async () => {
    apiMock.browserSession.mockResolvedValue(sessionResponse());
    apiMock.browserAccounts.mockResolvedValue({ selectedProfileId: null, profiles: [{ profileId: "google_account:primary", displayName: "Primary" }] });
    const targetUrl = "https://accounts.google.com/ServiceLogin?Email=primary%40example.test";
    apiMock.selectBrowserAccount.mockResolvedValue({ selectedProfileId: "google_account:primary", targetUrl });
    apiMock.startBrowserSession.mockResolvedValue(sessionResponse());
    const announced = vi.fn();
    window.addEventListener("space:browser-pane-account-selected", announced);
    try {
      render(<BrowserPane pane={browserPane({ mode: "JOB_APPLY", title: "Iris" })} agentNumber={4} />);
      const picker = await screen.findByLabelText("Google account for Iris");
      await waitFor(() => expect(picker.hasAttribute("disabled")).toBe(false));
      fireEvent(window, new CustomEvent(BROWSER_PANE_ACTION_EVENT, {
        detail: { paneId: "pane:browser-proof", action: "account", profileId: "google_account:primary", signIn: true }
      }));
      await waitFor(() => expect(apiMock.selectBrowserAccount).toHaveBeenCalledWith("pane:browser-proof", "google_account:primary", { signIn: true }));
      await waitFor(() => expect(announced).toHaveBeenCalledTimes(1));
      expect((announced.mock.calls[0]![0] as CustomEvent).detail).toEqual({ paneId: "pane:browser-proof", profileId: "google_account:primary" });
      await waitFor(() => expect(apiMock.startBrowserSession).toHaveBeenCalledWith("pane:browser-proof", expect.objectContaining({ targetUrl })));
      // An account action without a profile is not an action.
      fireEvent(window, new CustomEvent(BROWSER_PANE_ACTION_EVENT, { detail: { paneId: "pane:browser-proof", action: "account" } }));
      expect(apiMock.selectBrowserAccount).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener("space:browser-pane-account-selected", announced);
    }
  });

  it("shows the primary Google account as the pane default and offers a private pane profile", async () => {
    apiMock.browserSession.mockResolvedValue(sessionResponse());
    apiMock.browserAccounts.mockResolvedValue({ selectedProfileId: null, effectiveProfileId: "google_account:primary", profiles: [
      { profileId: "google_account:primary", displayName: "Primary", browserStatus: "CONNECTED" }, { profileId: "main", displayName: "Legacy main" }] });
    apiMock.selectBrowserAccount.mockResolvedValue({ selectedProfileId: "private:pane", targetUrl: "https://www.google.com/" });
    apiMock.startBrowserSession.mockResolvedValue(sessionResponse());
    render(<BrowserPane pane={browserPane()} agentNumber={4} />);
    const picker = await screen.findByLabelText("Google account for Research Browser");
    await waitFor(() => expect(picker.hasAttribute("disabled")).toBe(false));
    expect(picker.getAttribute("title")).toBe("Google account: Primary · Signed in");
    fireEvent.click(picker);
    const items = screen.getAllByRole("menuitemradio").map(item => item.getAttribute("aria-label"));
    expect(items).toEqual(["Primary · Signed in · Linked Google account", "Legacy main", "Private pane profile"]);
    expect(screen.getByRole("menuitemradio", { name: "Primary · Signed in · Linked Google account" }).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Private pane profile" }));
    await waitFor(() => expect(apiMock.selectBrowserAccount).toHaveBeenCalledWith("pane:browser-proof", "private:pane"));
  });

  it("opens Google sign-in inside the selected verified browser profile on reconnect", async () => {
    const profileId = "google_account:verified";
    const signIn = "https://accounts.google.com/ServiceLogin?continue=https%3A%2F%2Fwww.google.com%2F&Email=verified%40example.test";
    apiMock.browserSession.mockResolvedValue(sessionResponse());
    apiMock.browserAccounts.mockResolvedValue({ selectedProfileId: profileId, profiles: [{ profileId, displayName: "Verified", browserStatus: "CONNECTED" }, { profileId: "google_account:other", displayName: "Other", browserStatus: "UNKNOWN" }] });
    apiMock.selectBrowserAccount.mockResolvedValue({ selectedProfileId: profileId, targetUrl: signIn });
    apiMock.startBrowserSession.mockResolvedValue(sessionResponse());
    render(<BrowserPane pane={browserPane()} agentNumber={4} />);
    const picker = await screen.findByLabelText("Google account for Research Browser");
    await waitFor(() => expect(picker.hasAttribute("disabled")).toBe(false));
    fireEvent.click(picker);
    expect(screen.getByRole("menuitemradio", { name: "Verified · Signed in · Linked Google account" })).toBeTruthy();
    expect(screen.getByRole("menuitemradio", { name: "Other · Linked Google account" })).toBeTruthy();
    fireEvent.click(screen.getByRole("menuitem", { name: "Sign in to selected account" }));
    await waitFor(() => expect(apiMock.startBrowserSession).toHaveBeenCalledWith("pane:browser-proof", expect.objectContaining({ targetUrl: signIn })));
    expect(apiMock.selectBrowserAccount).toHaveBeenCalledWith("pane:browser-proof", profileId, { signIn: true });
  });

  it("shows each Google account once and marks the accounts that need sign-in", async () => {
    apiMock.browserSession.mockResolvedValue(sessionResponse());
    const profiles = [
      { profileId: "google_account:pir", displayName: "Google account · pir@example.test", label: "pir@example.test", email: "pir@example.test", browserStatus: "CONNECTED" },
      { profileId: "google_account:info", displayName: "Google account · Info", label: "Info", email: "Info@Example.test", browserStatus: "NOT_CONNECTED" },
      { profileId: "main", displayName: "Gemini account · spc", label: "spc", email: "spc@example.test", browserStatus: "SIGNED_IN" },
      { profileId: "2", displayName: "Gemini account · pir", label: "pir", email: "pir@example.test", browserStatus: "SIGNED_IN" },
      { profileId: "9", displayName: "Gemini account · olla", label: "olla", email: "info@example.test", browserStatus: "SIGNED_IN" },
      { profileId: "7", displayName: "Gemini account · bo", label: "bo", email: "bo@example.test", browserStatus: "NOT_CONNECTED" }
    ];
    apiMock.browserAccounts.mockResolvedValue({ selectedProfileId: null, effectiveProfileId: "google_account:info", profiles });
    apiMock.selectBrowserAccount.mockResolvedValue({ selectedProfileId: "9", targetUrl: "https://www.google.com/" });
    apiMock.startBrowserSession.mockResolvedValue(sessionResponse());
    render(<BrowserPane pane={browserPane()} agentNumber={4} />);
    const picker = await screen.findByLabelText("Google account for Research Browser");
    await waitFor(() => expect(picker.hasAttribute("disabled")).toBe(false));
    // The pane is on the linked profile that has no Google session yet.
    expect(picker.getAttribute("title")).toBe("Google account: Info@Example.test · Sign-in needed");
    expect(picker.getAttribute("data-account-status")).toBe("attention");
    fireEvent.click(picker);
    const items = screen.getAllByRole("menuitemradio").map(item => item.getAttribute("aria-label"));
    expect(items).toEqual([
      "pir@example.test · Signed in · Gemini pir · Linked",
      "Info@Example.test · Sign-in needed · Gemini olla · Linked",
      "spc@example.test · Signed in · Gemini spc",
      "bo@example.test · Sign-in needed · Gemini bo",
      "Private pane profile"
    ]);
    expect(screen.getByText("2 need sign-in")).toBeTruthy();
    const info = screen.getByRole("menuitemradio", { name: "Info@Example.test · Sign-in needed · Gemini olla · Linked" });
    expect(info.getAttribute("aria-checked")).toBe("true");
    // Choosing the row opens the same account's signed-in Gemini profile.
    expect(info.getAttribute("data-profile-id")).toBe("9");
    fireEvent.click(info);
    await waitFor(() => expect(apiMock.selectBrowserAccount).toHaveBeenCalledWith("pane:browser-proof", "9"));
  });

  it("reloads account sign-in states when the menu opens", async () => {
    apiMock.browserSession.mockResolvedValue(sessionResponse());
    const account = (browserStatus: string) => ({ selectedProfileId: "7", profiles: [{ profileId: "7", displayName: "Gemini account · bo", label: "bo", email: "bo@example.test", browserStatus }] });
    apiMock.browserAccounts.mockResolvedValueOnce(account("NOT_CONNECTED")).mockResolvedValue(account("SIGNED_IN"));
    render(<BrowserPane pane={browserPane()} agentNumber={4} />);
    const picker = await screen.findByLabelText("Google account for Research Browser");
    await waitFor(() => expect(picker.getAttribute("data-account-status")).toBe("attention"));
    fireEvent.click(picker);
    expect(await screen.findByRole("menuitemradio", { name: "bo@example.test · Signed in · Gemini bo" })).toBeTruthy();
    expect(apiMock.browserAccounts).toHaveBeenCalledTimes(2);
    expect(picker.getAttribute("data-account-status")).toBe("ok");
  });

  it.each([
    ["https://accounts.google.com/v3/signin/identifier", true],
    ["https://accounts.google.com/v3/signin/challenge/pwd", false]
  ])("rechecks Google navigation before automatic identifier input: %s", async (currentUrl, shouldContinue) => {
    apiMock.browserSession.mockResolvedValue(sessionResponse());
    apiMock.browserAccounts.mockResolvedValue({ selectedProfileId: null, profiles: [{ profileId: "google-1", displayName: "Google 1" }] });
    const targetUrl = "https://accounts.google.com/ServiceLogin?Email=browser-proof%40example.com";
    const sessionId = "browser_session:google-1";
    apiMock.selectBrowserAccount.mockResolvedValue({ selectedProfileId: "google-1", targetUrl });
    apiMock.startBrowserSession.mockResolvedValue(sessionResponse({ sessionId, targetUrl, currentUrl: targetUrl }));
    apiMock.acquireBrowserControl.mockResolvedValue({ lease: { ...operatorLease().lease, sessionId } });
    render(<BrowserPane pane={browserPane()} agentNumber={4} />);
    const picker = await screen.findByLabelText("Google account for Research Browser");
    await waitFor(() => expect(picker.hasAttribute("disabled")).toBe(false));
    fireEvent.click(picker);
    apiMock.browserSession.mockResolvedValue(sessionResponse({ sessionId, targetUrl, currentUrl }));
    vi.useFakeTimers();
    await act(async () => { fireEvent.click(screen.getByRole("menuitemradio", { name: "Google 1" })); });
    expect(apiMock.browserInput).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    if (shouldContinue) {
      expect(apiMock.browserInput).toHaveBeenCalledWith("pane:browser-proof", expect.objectContaining({ key: "Enter", eventType: "keyDown", text: "\r" }));
    } else {
      expect(apiMock.browserInput).not.toHaveBeenCalled();
    }
  });

  it("renews expired browser control before forwarding the next key", async () => {
    apiMock.browserSession.mockResolvedValue(sessionResponse());
    const lease = operatorLease();
    apiMock.acquireBrowserControl.mockResolvedValue(lease);
    render(<BrowserPane pane={browserPane()} agentNumber={4} />);
    const join = await screen.findByRole("button", { name: "Join browser session Research Browser" });
    await waitFor(() => expect(join.hasAttribute("disabled")).toBe(false));
    fireEvent.click(join);
    await screen.findByRole("button", { name: "Release browser control Research Browser" });
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + 65_000);
    apiMock.acquireBrowserControl.mockResolvedValue({ lease: { ...lease.lease, leaseId: "browser_lease:renewed", expiresAt: new Date(now + 120_000).toISOString() } });
    fireEvent.keyDown(screen.getByRole("img", { name: "Research Browser browser frame" }), { key: "A", code: "KeyA", shiftKey: true });
    await waitFor(() => expect(apiMock.browserInput).toHaveBeenCalledWith("pane:browser-proof", expect.objectContaining({ leaseId: "browser_lease:renewed", text: "A" })));
    expect(apiMock.acquireBrowserControl).toHaveBeenCalledTimes(2);
  });

  it("pastes clipboard text into the page from the toolbar's Paste icon, or opens the text box without clipboard access", async () => {
    // Operator report 2026-10-15: a Freelance Copilot sign-in field took no paste.
    const readText = vi.fn().mockResolvedValue("s3cret pass");
    installSpaceRuntime({ ...liveRuntime, platform: { ...liveRuntime.platform, clipboard: { read: vi.fn(), readText, write: vi.fn(), writeText: vi.fn() } } });
    apiMock.browserSession.mockResolvedValue(sessionResponse());
    apiMock.acquireBrowserControl.mockResolvedValue(operatorLease());
    render(<BrowserPane pane={browserPane({ mode: "FREELANCE_COPILOT" })} agentNumber={4} />);
    const paste = await screen.findByRole("button", { name: "Paste into browser Research Browser" });
    await waitFor(() => expect(paste.hasAttribute("disabled")).toBe(false));
    fireEvent.click(paste);
    await waitFor(() => expect(apiMock.browserInput).toHaveBeenCalledWith(
      "pane:browser-proof",
      expect.objectContaining({ type: "KEY", eventType: "char", text: "s3cret pass", leaseId: "browser_lease:operator" })
    ));
    readText.mockRejectedValue(new DOMException("Read permission denied.", "NotAllowedError"));
    fireEvent.click(paste);
    expect(await screen.findByPlaceholderText("Type into page")).toBeTruthy();
  });

  it("asks the server again on a copilot's Take control while it already holds the browser, without the text box", async () => {
    // Operator report 2026-10-15: the agent asked for a login while the operator already held the browser, and
    // "Take control" never reached the server, so the request card stayed. The join must reach it (the server then
    // accepts the handoff), and in a copilot the operator works in the page itself.
    apiMock.browserSession.mockResolvedValue(sessionResponse());
    apiMock.acquireBrowserControl.mockResolvedValue(operatorLease());
    render(<BrowserPane pane={browserPane({ mode: "MARKETING_COPILOT" })} agentNumber={4} />);
    const join = await screen.findByRole("button", { name: "Join browser session Research Browser" });
    await waitFor(() => expect(join.hasAttribute("disabled")).toBe(false));
    fireEvent.keyDown(screen.getByRole("img", { name: "Research Browser browser frame" }), { key: "a", code: "KeyA" });
    await waitFor(() => expect(apiMock.browserInput).toHaveBeenCalled());
    expect(apiMock.acquireBrowserControl).toHaveBeenCalledTimes(1);
    fireEvent(window, new CustomEvent(BROWSER_PANE_ACTION_EVENT, { detail: { paneId: "pane:browser-proof", action: "handoff", roomId: "room:browser-proof" } }));
    await waitFor(() => expect(apiMock.acquireBrowserControl).toHaveBeenCalledTimes(2));
    expect(await screen.findByRole("button", { name: "Release browser control Research Browser" })).toBeTruthy();
    expect(screen.queryByPlaceholderText("Type into page")).toBeNull();
  });

  it("keeps heartbeating browser control past the expiry of the first lease", async () => {
    apiMock.browserSession.mockResolvedValue(sessionResponse());
    const lease = operatorLease();
    apiMock.acquireBrowserControl.mockResolvedValue(lease);
    const intervals = vi.spyOn(window, "setInterval");
    render(<BrowserPane pane={browserPane()} agentNumber={4} />);
    const join = await screen.findByRole("button", { name: "Join browser session Research Browser" });
    await waitFor(() => expect(join.hasAttribute("disabled")).toBe(false));
    fireEvent.click(join);
    await screen.findByRole("button", { name: "Release browser control Research Browser" });
    const heartbeat = intervals.mock.calls.filter(([, delay]) => delay === 15_000).at(-1)?.[0] as (() => void) | undefined;
    expect(heartbeat).toBeTypeOf("function");
    const start = Date.now();
    const now = vi.spyOn(Date, "now");
    // Six ticks span 90 s, well past the 60 s expiry of the lease that started the heartbeat; a key at 45 s keeps the operator inside the 60 s idle release.
    for (let tick = 1; tick <= 6; tick++) {
      const at = start + tick * 15_000;
      now.mockReturnValue(at);
      if (tick === 3) fireEvent.keyDown(screen.getByRole("img", { name: "Research Browser browser frame" }), { key: "a", code: "KeyA" });
      apiMock.heartbeatBrowserControl.mockResolvedValueOnce({
        lease: { ...lease.lease, heartbeatAt: new Date(at).toISOString(), expiresAt: new Date(at + 60_000).toISOString() }
      });
      await act(async () => { heartbeat!(); await Promise.resolve(); });
    }
    expect(apiMock.heartbeatBrowserControl).toHaveBeenCalledTimes(6);
    expect(apiMock.heartbeatBrowserControl).toHaveBeenLastCalledWith("pane:browser-proof", expect.objectContaining({ leaseId: "browser_lease:operator", ttlSeconds: 60 }));
    expect(screen.getByRole("button", { name: "Release browser control Research Browser" })).toBeTruthy();
  });

  it("gives browser control back 60 s after the last press, a hover does not count", async () => {
    apiMock.browserSession.mockResolvedValue(sessionResponse());
    const lease = operatorLease();
    apiMock.acquireBrowserControl.mockResolvedValue(lease);
    apiMock.releaseBrowserControl.mockResolvedValue({ lease: { ...lease.lease, status: "RELEASED" } });
    const intervals = vi.spyOn(window, "setInterval");
    render(<BrowserPane pane={browserPane()} agentNumber={4} />);
    const join = await screen.findByRole("button", { name: "Join browser session Research Browser" });
    await waitFor(() => expect(join.hasAttribute("disabled")).toBe(false));
    fireEvent.click(join);
    await screen.findByRole("button", { name: "Release browser control Research Browser" });
    const heartbeat = intervals.mock.calls.filter(([, delay]) => delay === 15_000).at(-1)?.[0] as (() => void) | undefined;
    const start = Date.now();
    const now = vi.spyOn(Date, "now");
    // Input at 4 minutes keeps the browser; the next tick only renews the lease.
    now.mockReturnValue(start + 4 * 60_000);
    apiMock.acquireBrowserControl.mockResolvedValue({ lease: { ...lease.lease, expiresAt: new Date(start + 10 * 60_000).toISOString() } });
    fireEvent.keyDown(screen.getByRole("img", { name: "Research Browser browser frame" }), { key: "a", code: "KeyA" });
    await waitFor(() => expect(apiMock.browserInput).toHaveBeenCalled());
    now.mockReturnValue(start + 4 * 60_000 + 30_000);
    apiMock.heartbeatBrowserControl.mockResolvedValueOnce({ lease: { ...lease.lease, expiresAt: new Date(start + 12 * 60_000).toISOString() } });
    await act(async () => { heartbeat!(); await Promise.resolve(); });
    expect(apiMock.releaseBrowserControl).not.toHaveBeenCalled();
    // A hover at 4:45 is forwarded but is not use.
    now.mockReturnValue(start + 4 * 60_000 + 45_000);
    const frame = screen.getByRole("img", { name: "Research Browser browser frame" });
    fireEvent.mouseMove(frame, { clientX: 20, clientY: 20, buttons: 0 });
    // 60 s after that press (operator decision 2026-10-24; two minutes until then) the tick gives the browser back instead of renewing it.
    now.mockReturnValue(start + 5 * 60_000 + 1);
    apiMock.heartbeatBrowserControl.mockClear();
    await act(async () => { heartbeat!(); await Promise.resolve(); });
    await waitFor(() => expect(apiMock.releaseBrowserControl).toHaveBeenCalledWith("pane:browser-proof", { leaseId: "browser_lease:operator" }));
    expect(apiMock.heartbeatBrowserControl).not.toHaveBeenCalled();
    await screen.findByRole("button", { name: "Join browser session Research Browser" });
  });

  it("keeps a sign-in handoff while the operator stays on the pane and gives it back 60 s after they leave (operator 2026-10-27)", async () => {
    apiMock.browserSession.mockResolvedValue(sessionResponse());
    const lease = operatorLease();
    apiMock.acquireBrowserControl.mockResolvedValue(lease);
    apiMock.releaseBrowserControl.mockResolvedValue({ lease: { ...lease.lease, status: "RELEASED" } });
    const intervals = vi.spyOn(window, "setInterval");
    const maximized = { ...browserPane(), isMaximized: true };
    const view = render(<BrowserPane pane={maximized} agentNumber={4} />);
    const join = await screen.findByRole("button", { name: "Join browser session Research Browser" });
    await waitFor(() => expect(join.hasAttribute("disabled")).toBe(false));
    fireEvent.click(join);
    await screen.findByRole("button", { name: "Release browser control Research Browser" });
    const heartbeat = intervals.mock.calls.filter(([, delay]) => delay === 15_000).at(-1)?.[0] as (() => void) | undefined;
    const start = Date.now();
    const now = vi.spyOn(Date, "now");
    const tick = async (at: number) => {
      now.mockReturnValue(at);
      apiMock.heartbeatBrowserControl.mockResolvedValueOnce({ lease: { ...lease.lease, expiresAt: new Date(at + 120_000).toISOString() }, presenceHold: true });
      await act(async () => { heartbeat!(); await Promise.resolve(); });
    };
    // Five minutes on the maximized pane without a key (waiting for the SMS): the browser stays theirs.
    for (let minute = 0; minute <= 5; minute++) await tick(start + 15_000 + minute * 60_000);
    expect(apiMock.releaseBrowserControl).not.toHaveBeenCalled();
    expect(apiMock.heartbeatBrowserControl).toHaveBeenLastCalledWith("pane:browser-proof", { leaseId: "browser_lease:operator", ttlSeconds: 60, present: true });
    // They go to another room: idle counts from then.
    view.rerender(<BrowserPane pane={maximized} agentNumber={4} isVisible={false} />);
    await tick(start + 15_000 + 5 * 60_000 + 30_000);
    expect(apiMock.heartbeatBrowserControl).toHaveBeenLastCalledWith("pane:browser-proof", { leaseId: "browser_lease:operator", ttlSeconds: 60, present: false });
    expect(apiMock.releaseBrowserControl).not.toHaveBeenCalled();
    now.mockReturnValue(start + 15_000 + 6 * 60_000 + 1);
    await act(async () => { heartbeat!(); await Promise.resolve(); });
    await waitFor(() => expect(apiMock.releaseBrowserControl).toHaveBeenCalledWith("pane:browser-proof", { leaseId: "browser_lease:operator" }));
  });

  it("draws the page's open native dropdown after a click (never during a held press) and picks an option as keys (option D, plan clipboard:gHaiX_8yanVA)", async () => {
    const dropdown = { selectedIndex: 0, box: { x: 100, y: 50, width: 200, height: 30 }, labels: ["Choose a country", "Greece", "Thailand"], disabled: [0], truncated: false };
    apiMock.browserSession.mockResolvedValue(sessionResponse());
    apiMock.acquireBrowserControl.mockResolvedValue(operatorLease());
    apiMock.browserAction.mockImplementation(async (_paneId: string, input: { type: string }) =>
      ({ session: sessionResponse().session, frame: frame(), text: input.type === "select_state" ? JSON.stringify(dropdown) : null }));
    render(<BrowserPane pane={browserPane()} agentNumber={4} />);
    const join = await screen.findByRole("button", { name: "Join browser session Research Browser" });
    await waitFor(() => expect(join.hasAttribute("disabled")).toBe(false));
    const image = screen.getByRole("img", { name: "Research Browser browser frame" });
    image.getBoundingClientRect = () => ({ left: 0, top: 0, width: 144, height: 90, right: 144, bottom: 90, x: 0, y: 0, toJSON: () => undefined }) as DOMRect;
    // A hover asks nothing, nor does a held button (Fiverr's Press & Hold reset under it); the release asks once whether a dropdown opened.
    fireEvent.pointerMove(image, { pointerId: 1, pointerType: "mouse", clientX: 20, clientY: 10, buttons: 0 });
    fireEvent.pointerDown(image, { pointerId: 1, pointerType: "mouse", clientX: 20, clientY: 10, button: 0, buttons: 1 });
    await waitFor(() => expect(apiMock.acquireBrowserControl).toHaveBeenCalled());
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 300)); });
    expect(apiMock.browserAction.mock.calls.filter(([, input]) => input.type === "select_state")).toHaveLength(0);
    fireEvent.pointerUp(image, { pointerId: 1, pointerType: "mouse", clientX: 20, clientY: 10, button: 0, buttons: 0 });
    await waitFor(() => expect(apiMock.browserAction).toHaveBeenCalledWith("pane:browser-proof", { type: "select_state", sessionId: "browser_session:proof" }));
    expect(apiMock.browserAction.mock.calls.filter(([, input]) => input.type === "select_state")).toHaveLength(1);
    await screen.findByRole("listbox", { name: "Dropdown options" });
    fireEvent.click(screen.getByRole("option", { name: "Thailand" }));
    await waitFor(() => expect(apiMock.browserAction).toHaveBeenCalledWith("pane:browser-proof", { type: "select_choose", index: 2, sessionId: "browser_session:proof" }));
    expect(screen.queryByRole("listbox")).toBeNull();
    // A Browser Host from before select_state answers no text: no list.
    apiMock.browserAction.mockResolvedValue({ session: sessionResponse().session, frame: frame(), text: null });
    fireEvent.pointerDown(image, { pointerId: 1, pointerType: "mouse", clientX: 20, clientY: 10, button: 0, buttons: 1 });
    fireEvent.pointerUp(image, { pointerId: 1, pointerType: "mouse", clientX: 20, clientY: 10, button: 0, buttons: 0 });
    await waitFor(() => expect(apiMock.browserAction.mock.calls.filter(([, input]) => input.type === "select_state")).toHaveLength(2));
    await act(async () => { await Promise.resolve(); });
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("drops browser control the server already gave back instead of failing the release", async () => {
    apiMock.browserSession.mockResolvedValue(sessionResponse());
    apiMock.acquireBrowserControl.mockResolvedValue(operatorLease());
    apiMock.releaseBrowserControl.mockRejectedValue(Object.assign(new Error("A valid active control lease is required for interactive browser input."), { status: 409 }));
    render(<BrowserPane pane={browserPane()} agentNumber={4} />);
    const join = await screen.findByRole("button", { name: "Join browser session Research Browser" });
    await waitFor(() => expect(join.hasAttribute("disabled")).toBe(false));
    fireEvent.click(join);
    fireEvent.click(await screen.findByRole("button", { name: "Release browser control Research Browser" }));
    await screen.findByRole("button", { name: "Join browser session Research Browser" });
    expect(screen.queryByText(/valid active control lease/)).toBeNull();
  });

  it("preserves the URL being typed while the initial browser session is loading", async () => {
    let ready!: (value: PaneBrowserSessionResponse) => void;
    apiMock.browserSession.mockImplementation(() => new Promise<PaneBrowserSessionResponse>(resolve => { ready = resolve; }));
    render(<BrowserPane pane={browserPane()} agentNumber={4} />);
    await waitFor(() => expect(apiMock.browserSession).toHaveBeenCalled());
    const input = screen.getByRole("textbox", { name: "Browser URL Research Browser" }) as HTMLInputElement;
    expect(input.disabled).toBe(false);
    fireEvent.change(input, { target: { value: "https://example.com/draft" } });
    await act(async () => { ready(sessionResponse()); });
    expect(input.value).toBe("https://example.com/draft");
  });

  it.each(["READY", "CLOSED"] as const)("navigates to a bare domain from a %s blank tab", async (status) => {
    apiMock.browserSession.mockResolvedValue(sessionResponse({ status, currentUrl: "about:blank", targetUrl: "about:blank", isActive: status === "READY" }));
    const loaded = sessionResponse({ currentUrl: "https://google.com/", targetUrl: "https://google.com/" });
    apiMock.navigateBrowser.mockResolvedValue(loaded);
    apiMock.startBrowserSession.mockResolvedValue(sessionResponse({ currentUrl: "about:blank", targetUrl: "about:blank" }));
    render(<BrowserPane pane={browserPane()} agentNumber={4} />);
    const navigate = screen.getByRole("button", { name: "Navigate browser Research Browser" });
    await waitFor(() => expect(screen.getByRole("button", { name: "New browser tab Research Browser" }).hasAttribute("disabled")).toBe(false));
    const input = screen.getByLabelText("Browser URL Research Browser") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "google.com" } });
    expect(navigate.hasAttribute("disabled")).toBe(false);
    fireEvent.submit(input.closest("form")!);
    await waitFor(() => expect(input.value).toBe("https://google.com/"));
    expect(apiMock.navigateBrowser).toHaveBeenCalledExactlyOnceWith("pane:browser-proof", "https://google.com/");
    if (status === "READY") expect(apiMock.startBrowserSession).not.toHaveBeenCalled();
    else expect(apiMock.startBrowserSession).toHaveBeenCalledExactlyOnceWith("pane:browser-proof", {
      viewport: "desktop", targetUrl: "about:blank", ownerAgentId: "agent:4"
    });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  async function closeLastBrowserTab() {
    const { before } = tabFixture();
    const pages = [before.pages[0]!];
    apiMock.browserSession.mockResolvedValue(sessionResponse({ pages, activePageId: pages[0]!.pageId }));
    apiMock.browserPages.mockResolvedValue({ ...before, pages });
    apiMock.closeBrowserPage.mockResolvedValue({ ...before, pages: [], activePageId: null });
    render(<BrowserPane pane={browserPane()} agentNumber={4} />);
    const close = await screen.findByRole("button", { name: "Close browser tab First tab" });
    await waitFor(() => expect(close.hasAttribute("disabled")).toBe(false));
    fireEvent.click(close);
    const start = await screen.findByRole("button", { name: "Start browser" });
    await waitFor(() => expect(start.hasAttribute("disabled")).toBe(false));
    expect(screen.queryAllByRole("tab")).toHaveLength(0);
    apiMock.browserPages.mockRejectedValue(new Error("legacy browser host"));
    return start;
  }

  it("starts a stopped browser using the normalized address and shows useful invalid-address errors", async () => {
    const start = await closeLastBrowserTab();
    apiMock.startBrowserSession.mockResolvedValue(sessionResponse({ targetUrl: "https://www.google.com/", currentUrl: "https://www.google.com/" }));
    const input = screen.getByLabelText("Browser URL Research Browser") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "www.google.com" } });
    fireEvent.click(start);
    await waitFor(() => expect(apiMock.startBrowserSession).toHaveBeenCalledWith("pane:browser-proof", expect.objectContaining({ targetUrl: "https://www.google.com/" })));
    await waitFor(() => expect(input.value).toBe("https://www.google.com/"));
    fireEvent.change(input, { target: { value: "https://" } });
    fireEvent.submit(input.closest("form")!);
    expect(await screen.findByText("Enter a valid web address, such as google.com.")).toBeTruthy();
    expect(apiMock.navigateBrowser).not.toHaveBeenCalled();
    expect(input.disabled).toBe(false);
  });

  it("keeps the explicitly closed browser stopped until Start browser is pressed", async () => {
    const start = await closeLastBrowserTab();
    apiMock.browserFrame.mockClear();
    apiMock.browserPages.mockClear();
    apiMock.browserStreamTicket.mockClear();
    vi.useFakeTimers();
    await act(async () => { await vi.advanceTimersByTimeAsync(6000); });
    expect(apiMock.browserFrame).not.toHaveBeenCalled();
    expect(apiMock.startBrowserSession).not.toHaveBeenCalled();
    expect(apiMock.browserPages).not.toHaveBeenCalled();
    expect(apiMock.browserStreamTicket).not.toHaveBeenCalled();
    await act(async () => { fireEvent.click(start); await vi.advanceTimersByTimeAsync(0); });
    expect(apiMock.startBrowserSession).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("follows the browser an agent started in place of the closed one on screen (2026-10-22)", async () => {
    const { before } = tabFixture();
    let settle!: (value: unknown) => void;
    apiMock.browserPages.mockReturnValue(new Promise(resolve => { settle = resolve; }));
    const view = render(<BrowserPane pane={browserPane()} agentNumber={4} />);
    await waitFor(() => expect(apiMock.browserPages).toHaveBeenCalledTimes(1));
    vi.useFakeTimers();
    try {
      // An agent's account switch stopped the view's session before its first tab list: the view shows it closed.
      await act(async () => settle({ sessionId: "browser_session:proof", pages: [], activePageId: null }));
      expect(screen.getByText("No open tabs. Use + to open a new tab.")).toBeTruthy();
      const agent = { ...before, sessionId: "browser_session:agent" };
      apiMock.browserSession.mockResolvedValue(sessionResponse({ sessionId: agent.sessionId, pages: agent.pages, activePageId: agent.activePageId }));
      apiMock.browserPages.mockResolvedValue(agent);
      await act(() => vi.advanceTimersByTimeAsync(5000));
      expect(screen.getByRole("tab", { name: "First tab" })).toBeTruthy();
      expect(screen.queryByText("No open tabs. Use + to open a new tab.")).toBeNull();
      expect(apiMock.startBrowserSession).not.toHaveBeenCalled();
    } finally { view.unmount(); vi.useRealTimers(); }
  });

  it("shares concurrent browser status discovery across panes", async () => {
    const nextStatus = {
      enabled: true,
      statusReason: "Managed Chrome browser sessions are enabled.",
      defaultUrl: "https://www.google.com/",
      checkedAt: "2026-09-05T00:00:00.000Z"
    };
    let resolveStatus!: (status: typeof nextStatus) => void;
    apiMock.browserStatus.mockImplementation(() => new Promise<typeof nextStatus>((resolve) => {
      resolveStatus = resolve;
    }));

    render(
      <>
        <BrowserPane pane={browserPane({ id: "pane:browser-one", title: "Browser One" })} agentNumber={1} />
        <BrowserPane pane={browserPane({ id: "pane:browser-two", title: "Browser Two" })} agentNumber={2} />
      </>
    );

    await waitFor(() => expect(apiMock.browserStatus).toHaveBeenCalledTimes(1));
    await act(async () => resolveStatus(nextStatus));
    await waitFor(() => expect(apiMock.startBrowserSession).toHaveBeenCalledTimes(2));
  });

  it("wires the shared bookmarks and human handoff through mediated browser actions", async () => {
    const shared = bookmark("mktbm:olla000001", "(2) Olla", "https://example.com/");
    apiMock.marketingBookmarks.mockResolvedValue({ bookmarks: [shared] });
    apiMock.openMarketingBookmark.mockResolvedValue({ bookmark: shared, pages: { sessionId: "browser_session:proof", activePageId: null, pages: [] } });

    render(<BrowserPane pane={browserPane()} agentNumber={4} />);

    expect(await screen.findByRole("img", { name: "Research Browser browser frame" })).toBeTruthy();
    await waitFor(() =>
      expect(apiMock.startBrowserSession).toHaveBeenCalledWith("pane:browser-proof", {
        viewport: "desktop",
        targetUrl: "about:blank",
        ownerAgentId: "agent:4"
      })
    );

    // The Browser pane shows the bookmarks every copilot shows, each with its Google account (operator 2026-10-21).
    await chooseBrowserAction("Browser bookmarks Research Browser");
    const menu = await screen.findByRole("dialog", { name: "Saved browser bookmarks Research Browser" });
    fireEvent.click(await within(menu).findByRole("button", { name: "Open Olla with primary@example.com" }));
    await waitFor(() => expect(apiMock.openMarketingBookmark).toHaveBeenCalledWith("pane:browser-proof", "mktbm:olla000001"));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Saved browser bookmarks Research Browser" })).toBeNull());

    const joinButton = screen.getByRole("button", { name: "Join browser session Research Browser" });
    expect(joinButton.getAttribute("type")).toBe("button");
    await waitFor(() => expect((joinButton as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(joinButton);
    const handoffInput = await screen.findByLabelText("Browser text input Research Browser");
    await waitFor(() => expect((handoffInput as HTMLInputElement).disabled).toBe(false));
    fireEvent.change(handoffInput, { target: { value: "operator typed text" } });
    fireEvent.click(screen.getByRole("button", { name: "Type into browser Research Browser" }));
    await waitFor(() =>
      expect(apiMock.browserAction).toHaveBeenCalledWith("pane:browser-proof", {
        type: "type",
        text: "operator typed text",
        sessionId: "browser_session:proof"
      })
    );

    const image = screen.getByRole("img", { name: "Research Browser browser frame" });
    image.getBoundingClientRect = () =>
      ({
        left: 0,
        top: 0,
        width: 144,
        height: 90,
        right: 144,
        bottom: 90,
        x: 0,
        y: 0,
        toJSON: () => undefined
      }) as DOMRect;
    fireEvent.pointerDown(image, { pointerId: 1, pointerType: "mouse", clientX: 72, clientY: 45, button: 0, buttons: 1 });
    fireEvent.pointerUp(image, { pointerId: 1, pointerType: "mouse", clientX: 72, clientY: 45, button: 0, buttons: 0 });
    await waitFor(() =>
      expect(apiMock.browserAction).toHaveBeenCalledWith("pane:browser-proof", {
        type: "click",
        x: 720,
        y: 450,
        sessionId: "browser_session:proof"
      })
    );
    fireEvent.wheel(image, { clientX: 72, clientY: 45, deltaX: 3, deltaY: 120 });
    await waitFor(() =>
      expect(apiMock.browserAction).toHaveBeenCalledWith("pane:browser-proof", {
        type: "scroll",
        deltaX: 3,
        deltaY: 120,
        sessionId: "browser_session:proof"
      })
    );
  });

  it("renders a browser session for a YOUTUBE-mode pane without a start URL override", async () => {
    apiMock.browserStatus.mockResolvedValue({
      enabled: true,
      statusReason: "ready",
      defaultUrl: "https://www.google.com/",
      checkedAt: "2026-08-03T00:00:00.000Z"
    });
    apiMock.browserSession.mockResolvedValue(
      sessionResponse({ currentUrl: "https://www.youtube.com/", title: "YouTube" })
    );

    render(<BrowserPane pane={browserPane({ mode: "YOUTUBE", title: "YouTube 1" })} agentNumber={4} />);

    expect(await screen.findByRole("img", { name: "YouTube 1 browser frame" })).toBeTruthy();
    await waitFor(() =>
      expect(apiMock.startBrowserSession).not.toHaveBeenCalled()
    );
  });

  it("exposes real active state for browser toggles but not one-shot actions", async () => {
    apiMock.browserDiagnostics.mockResolvedValue({ sessionId: "browser_session:proof", events: [] });

    render(<BrowserPane pane={browserPane()} agentNumber={4} />);
    expect(await screen.findByRole("img", { name: "Research Browser browser frame" })).toBeTruthy();

    const desktopViewport = screen.getByRole("button", { name: "PC view Research Browser" });
    expect(desktopViewport.getAttribute("aria-pressed")).toBe("true");

    await chooseBrowserAction("Browser bookmarks Research Browser");
    expect(screen.getByRole("dialog", { name: "Saved browser bookmarks Research Browser" })).toBeTruthy();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Saved browser bookmarks Research Browser" })).toBeNull();

    await chooseBrowserAction("Record browser session Research Browser");
    expect(screen.getByRole("dialog", { name: "Browser recording controls Research Browser" })).toBeTruthy();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Browser recording controls Research Browser" })).toBeNull();

    await chooseBrowserAction("Open browser debugger Research Browser");
    expect(screen.getByRole("complementary", { name: "Browser debugger Research Browser" })).toBeTruthy();

    const focus = screen.getByRole("button", { name: "Expand browser view Research Browser" });
    expect(focus.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(focus);
    expect(screen.getByRole("button", { name: "Exit browser focus mode Research Browser" }).getAttribute("aria-pressed")).toBe("true");

    expect((await browserAction("Capture browser screenshot Research Browser")).hasAttribute("aria-pressed")).toBe(false);
    expect((await browserAction("Refresh browser frame Research Browser")).hasAttribute("aria-expanded")).toBe(false);
  });

  it("supports hide, overflow and persistent drag order for browser toolbar icons", async () => {
    window.localStorage.clear();

    render(<BrowserPane pane={browserPane()} agentNumber={4} />);

    expect(await screen.findByRole("img", { name: "Research Browser browser frame" })).toBeTruthy();
    expect(await screen.findByRole("button", { name: "More browser actions Research Browser" })).toBeTruthy();

    fireEvent.contextMenu(await browserAction("Browser bookmarks Research Browser"));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Hide" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Browser bookmarks Research Browser" })).toBeNull());

    const overflowMenu = await openBrowserActions();
    fireEvent.click(within(overflowMenu).getByLabelText("Browser bookmarks Research Browser"));
    expect(await screen.findByRole("dialog", { name: "Saved browser bookmarks Research Browser" })).toBeTruthy();

    const restoreMenu = await openBrowserActions();
    fireEvent.click(within(restoreMenu).getByRole("menuitem", { name: "Show all icons" }));
    expect(await browserAction("Browser bookmarks Research Browser")).toBeTruthy();

    const stopButton = await browserAction("Stop browser session Research Browser");
    const refreshButton = await browserAction("Refresh browser frame Research Browser");
    fireEvent.dragStart(stopButton);
    fireEvent.dragOver(refreshButton);
    fireEvent.drop(refreshButton);
    fireEvent.dragEnd(stopButton);
    await waitFor(() =>
      expect(window.localStorage.getItem("space.browserToolbar.actionOrder")).toContain("\"stop\"")
    );
  });

  function tabFixture() {
    const first = { pageId: "page:one", kind: "PAGE" as const, title: "First tab", url: "https://example.com/one",
      isActive: true, openerPageId: null, canGoBack: false, canGoForward: false };
    const second = { ...first, pageId: "page:two", title: "Second tab", url: "https://example.com/two", isActive: false };
    const before = { sessionId: "browser_session:proof", pages: [first, second], activePageId: first.pageId };
    const after = { ...before, pages: [{ ...second, isActive: true }], activePageId: second.pageId };
    const initial = sessionResponse({ pages: before.pages, activePageId: before.activePageId });
    apiMock.browserSession.mockResolvedValue(initial);
    apiMock.browserPages.mockResolvedValue(before);
    apiMock.closeBrowserPage.mockResolvedValue(after);
    return { before, after, initial };
  }

  function twoAccounts() {
    apiMock.browserAccounts.mockResolvedValue({ selectedProfileId: null, effectiveProfileId: "google_account:primary", profiles: [
      { profileId: "google_account:primary", displayName: "Primary", email: "primary@example.com" },
      { profileId: "google_account:second", displayName: "Second", email: "second@example.com" }] });
  }

  async function chooseSecondAccount() {
    await screen.findByRole("tab", { name: "First tab" });
    const picker = await screen.findByLabelText("Google account for Research Browser");
    await waitFor(() => expect(picker.hasAttribute("disabled")).toBe(false));
    fireEvent.click(picker);
    fireEvent.click(screen.getByRole("menuitemradio", { name: /^second@example\.com/ }));
  }

  it("names the room and the agent pane driving the browser in the frame's corner; a click goes to that pane (operator 2026-10-20/21)", async () => {
    const { before } = tabFixture();
    apiMock.browserPages.mockResolvedValue({ ...before, agent: { paneId: "pane:codex", title: "Fix login", paneName: "Andy", roomId: "room:main", roomName: "Main",
      drivenAt: new Date().toISOString(), active: true } });
    const focus = vi.fn();
    window.addEventListener("space:nous-focus", focus);
    render(<BrowserPane pane={browserPane()} agentNumber={4} />);
    const label = await screen.findByRole("button", { name: "Main · Andy · Fix login" });
    expect(label.getAttribute("title")).toBe("Handled by Andy in room Main. Click to go to that pane.");
    fireEvent.click(label);
    window.removeEventListener("space:nous-focus", focus);
    expect((focus.mock.calls[0]![0] as CustomEvent).detail).toEqual({ roomId: "room:main", paneId: "pane:codex", immediate: true });
  });

  it("keeps naming the last agent pane after it stopped driving the browser, with how long ago (operator 2026-10-22)", async () => {
    const { before } = tabFixture();
    apiMock.browserPages.mockResolvedValue({ ...before, agent: { paneId: "pane:iris", title: "YC application", paneName: "Iris", roomId: "room:bruno",
      roomName: "Bruno", drivenAt: new Date(Date.now() - 25 * 60_000).toISOString(), active: false } });
    render(<BrowserPane pane={browserPane()} agentNumber={4} />);
    const label = await screen.findByRole("button", { name: "Last: Bruno · Iris · YC application · 25 min ago" });
    expect(label.getAttribute("data-active")).toBe("false");
    expect(label.getAttribute("title")).toBe("Last handled 25 min ago by Iris in room Bruno. Click to go to that pane.");
  });

  it.each(["BROWSER", "MARKETING_COPILOT"] as const)("changes the account of the %s pane's tab in view in place; the other tabs keep the pane's", async (mode) => {
    const { before } = tabFixture();
    twoAccounts();
    // A Browser Host with per-tab accounts reports `account` on every tab.
    const own = { ...before, pages: before.pages.map((page) => ({ ...page, account: null })) };
    apiMock.browserSession.mockResolvedValue(sessionResponse({ pages: own.pages, activePageId: own.activePageId }));
    apiMock.browserPages.mockResolvedValue(own);
    const second = { profileId: "google_account:second", label: "second@example.com" };
    const switched = { ...own, pages: [own.pages[1]!, { ...own.pages[0]!, pageId: "page:three", account: second }], activePageId: "page:three" };
    apiMock.setBrowserPageAccount.mockResolvedValue(switched);
    render(<BrowserPane pane={browserPane({ mode })} agentNumber={4} />);
    await chooseSecondAccount();
    await waitFor(() => expect(apiMock.setBrowserPageAccount).toHaveBeenCalledWith("pane:browser-proof", "page:one", "google_account:second", {}));
    expect(apiMock.createPane).not.toHaveBeenCalled();
    expect(apiMock.selectBrowserAccount).not.toHaveBeenCalled();
    expect(apiMock.closeBrowserPage).not.toHaveBeenCalled();
    const tab = await screen.findByRole("tab", { name: "First tab · second@example.com" });
    expect(tab.getAttribute("title")).toBe("https://example.com/one\nGoogle account: second@example.com");
    expect(screen.getByRole("tab", { name: "Second tab" })).toBeTruthy();

    // The menu now shows the tab's account, says it changes this tab, and moves the tab back to the pane's account.
    apiMock.browserPages.mockResolvedValue(switched);
    const picker = screen.getByLabelText("Google account for Research Browser");
    await waitFor(() => expect(picker.hasAttribute("disabled")).toBe(false));
    fireEvent.click(picker);
    expect(screen.getByText("This tab")).toBeTruthy();
    expect(screen.getByRole("menuitemradio", { name: /^second@example\.com/ }).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(screen.getByRole("menuitem", { name: "Sign in to selected account" }));
    await waitFor(() => expect(apiMock.setBrowserPageAccount).toHaveBeenLastCalledWith("pane:browser-proof", "page:three", "google_account:second", { signIn: true }));
    await waitFor(() => expect(picker.hasAttribute("disabled")).toBe(false));
    fireEvent.click(picker);
    fireEvent.click(screen.getByRole("menuitemradio", { name: /^primary@example\.com/ }));
    await waitFor(() => expect(apiMock.setBrowserPageAccount).toHaveBeenLastCalledWith("pane:browser-proof", "page:three", null, {}));
  });

  it.each(["MARKETING_COPILOT", "BROWSER"] as const)("saves a %s tab to the shared bookmarks with the Google account it is open in", async (mode) => {
    const { before } = tabFixture();
    twoAccounts();
    const second = { profileId: "google_account:second", label: "second@example.com" };
    const own = { ...before, pages: [{ ...before.pages[0]!, account: null }, { ...before.pages[1]!, account: second }] };
    apiMock.browserSession.mockResolvedValue(sessionResponse({ pages: own.pages, activePageId: own.activePageId }));
    apiMock.browserPages.mockResolvedValue(own);
    apiMock.createMarketingBookmark.mockResolvedValue({ bookmark: {} });
    const changed = vi.fn();
    window.addEventListener("space:marketing-bookmarks-changed", changed);
    render(<BrowserPane pane={browserPane({ mode })} agentNumber={4} />);
    await waitFor(() => expect(apiMock.browserAccounts).toHaveBeenCalled());
    fireEvent.contextMenu(await screen.findByRole("tab", { name: "Second tab · second@example.com" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Save to bookmarks" }));
    await waitFor(() => expect(apiMock.createMarketingBookmark).toHaveBeenCalledWith({ url: "https://example.com/two", title: "Second tab", profileId: "google_account:second", accountLabel: "second@example.com" }));
    expect(await screen.findByText("Saved to Bookmarks with second@example.com.")).toBeTruthy();
    // A tab in the pane's own account saves that account by name.
    fireEvent.contextMenu(screen.getByRole("tab", { name: "First tab" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Save to bookmarks" }));
    await waitFor(() => expect(apiMock.createMarketingBookmark).toHaveBeenLastCalledWith({ url: "https://example.com/one", title: "First tab", profileId: "google_account:primary", accountLabel: "primary@example.com" }));
    expect(changed).toHaveBeenCalledTimes(2);
    window.removeEventListener("space:marketing-bookmarks-changed", changed);
  });

  it.each(["BROWSER", "MARKETING_COPILOT"] as const)("with a Browser Host from before per-tab accounts, moves the %s pane's tab to a new Browser pane in the other account", async (mode) => {
    tabFixture();
    twoAccounts();
    const moved = browserPane({ id: "pane:second", title: "Browser · second@example.com" });
    apiMock.createPane.mockResolvedValue(moved);
    apiMock.panes.mockResolvedValue({ data: [browserPane()] });
    const view = render(<BrowserPane pane={browserPane({ mode })} agentNumber={4} />);
    await chooseSecondAccount();
    await waitFor(() => expect(apiMock.closeBrowserPage).toHaveBeenCalledWith("pane:browser-proof", "page:one"));
    expect(apiMock.createPane).toHaveBeenCalledWith("room:browser-proof", "Browser · second@example.com", "BROWSER",
      { split: { parentId: "pane:browser-proof", direction: "horizontal", size: 50 } });
    expect(apiMock.selectBrowserAccount).not.toHaveBeenCalled();
    expect(await screen.findByRole("tab", { name: "Second tab" })).toBeTruthy();

    // The new pane opens the moved tab's page in the chosen account.
    view.unmount();
    apiMock.selectBrowserAccount.mockResolvedValue({ selectedProfileId: "google_account:second", targetUrl: "https://www.google.com/" });
    render(<BrowserPane pane={moved} agentNumber={5} />);
    await waitFor(() => expect(apiMock.startBrowserSession).toHaveBeenCalledWith("pane:second", expect.objectContaining({ targetUrl: "https://example.com/one" })));
    expect(apiMock.selectBrowserAccount).toHaveBeenCalledWith("pane:second", "google_account:second");
  });

  it("switches the whole Freelance Copilot browser, whose tabs must keep the platform egress route", async () => {
    tabFixture();
    twoAccounts();
    apiMock.selectBrowserAccount.mockResolvedValue({ selectedProfileId: "google_account:second", targetUrl: "https://www.google.com/" });
    render(<BrowserPane pane={browserPane({ mode: "FREELANCE_COPILOT" })} agentNumber={4} />);
    await chooseSecondAccount();
    await waitFor(() => expect(apiMock.selectBrowserAccount).toHaveBeenCalledWith("pane:browser-proof", "google_account:second"));
    expect(apiMock.createPane).not.toHaveBeenCalled();
  });

  it("reloads the page and restarts a stuck browser on the page it showed", async () => {
    const { before } = tabFixture();
    // The active page is a sign-in popup that closed itself; the tab list still has the page that opened it.
    apiMock.browserPages.mockResolvedValue({ ...before, pages: [before.pages[1]!, { ...before.pages[0]!, isActive: false }], activePageId: "page:closed-popup" });
    apiMock.acquireBrowserControl.mockResolvedValue(operatorLease());
    render(<BrowserPane pane={browserPane()} agentNumber={4} />);
    await screen.findByRole("tab", { name: "First tab" });
    await chooseBrowserAction("Reload page Research Browser");
    await waitFor(() => expect(apiMock.browserInput).toHaveBeenCalledWith("pane:browser-proof", expect.objectContaining({ type: "NAVIGATION", action: "RELOAD" })));

    apiMock.startBrowserSession.mockResolvedValue(sessionResponse({ currentUrl: "https://example.com/two", targetUrl: "https://example.com/two" }));
    await chooseBrowserAction("Restart browser Research Browser");
    await waitFor(() => expect(apiMock.startBrowserSession).toHaveBeenCalled());
    expect(apiMock.stopBrowserSession).toHaveBeenCalledWith("pane:browser-proof");
    expect(apiMock.stopBrowserSession.mock.invocationCallOrder[0]).toBeLessThan(apiMock.startBrowserSession.mock.invocationCallOrder[0]!);
    expect(apiMock.startBrowserSession).toHaveBeenCalledWith("pane:browser-proof", expect.objectContaining({ targetUrl: "https://example.com/two" }));
  });

  it("does not resurrect closed tabs from a later stale session snapshot or overwrite the URL draft", async () => {
    const { after, initial } = tabFixture();
    render(<BrowserPane pane={browserPane()} agentNumber={4} />);
    const close = await screen.findByRole("button", { name: "Close browser tab First tab" });
    await waitFor(() => expect(close.hasAttribute("disabled")).toBe(false));
    const input = screen.getByLabelText("Browser URL Research Browser") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "https://draft.example/" } });
    fireEvent.click(close);
    await waitFor(() => expect(screen.queryByRole("tab", { name: "First tab" })).toBeNull());
    // A later viewport/stream response still contains the old persisted tabs.
    apiMock.updateBrowserSession.mockResolvedValue(initial);
    apiMock.browserPages.mockResolvedValue(after);
    fireEvent.change(screen.getByLabelText("Stream mode Research Browser"), { target: { value: "REALTIME" } });
    await waitFor(() => expect(apiMock.updateBrowserSession).toHaveBeenCalled());
    expect(screen.queryByRole("tab", { name: "First tab" })).toBeNull();
    expect(screen.getByRole("tab", { name: "Second tab" }).getAttribute("aria-selected")).toBe("true");
    expect(input.value).toBe("https://draft.example/");
  });

  it("ignores a page-list read that completes after a close and permits closing the last tab", async () => {
    const { before, after } = tabFixture();
    let resolvePages!: (value: typeof before) => void;
    apiMock.browserPages.mockReturnValue(new Promise((resolve) => { resolvePages = resolve; }));
    render(<BrowserPane pane={browserPane()} agentNumber={4} />);
    const close = await screen.findByRole("button", { name: "Close browser tab First tab" });
    await waitFor(() => expect(close.hasAttribute("disabled")).toBe(false));
    fireEvent.click(close);
    await waitFor(() => expect(screen.queryByRole("tab", { name: "First tab" })).toBeNull());
    await act(async () => { resolvePages(before); });
    expect(screen.queryByRole("tab", { name: "First tab" })).toBeNull();
    const blank = { ...after, pages: [], activePageId: null };
    let resolveClose!: (value: typeof blank) => void;
    apiMock.closeBrowserPage.mockReturnValue(new Promise((resolve) => { resolveClose = resolve; }));
    const last = screen.getByRole("button", { name: "Close browser tab Second tab" });
    fireEvent.click(last);
    fireEvent.click(last);
    expect(apiMock.closeBrowserPage).toHaveBeenCalledTimes(2);
    await act(async () => { resolveClose(blank); });
    expect(screen.queryByRole("tab", { name: "Second tab" })).toBeNull();
    expect(screen.queryAllByRole("tab")).toHaveLength(0);
    expect(screen.getByText("No open tabs. Use + to open a new tab.")).toBeTruthy();
    expect((screen.getByLabelText("Browser URL Research Browser") as HTMLInputElement).value).toBe("");
    const newTab = screen.getByRole("button", { name: "New browser tab Research Browser" });
    expect(newTab.hasAttribute("disabled")).toBe(false);
    apiMock.startBrowserSession.mockResolvedValue(sessionResponse({ sessionId: "browser_session:new", targetUrl: "about:blank", currentUrl: null }));
    fireEvent.click(newTab);
    await waitFor(() => expect(apiMock.startBrowserSession).toHaveBeenCalledWith("pane:browser-proof", expect.objectContaining({ targetUrl: "about:blank" })));
    expect(apiMock.createBrowserPage).not.toHaveBeenCalled();
  });

  it("refreshes stale tab failures while retaining real close errors", async () => {
    const { after } = tabFixture();
    render(<BrowserPane pane={browserPane()} agentNumber={4} />);
    const close = await screen.findByRole("button", { name: "Close browser tab First tab" });
    await waitFor(() => expect(close.hasAttribute("disabled")).toBe(false));
    apiMock.browserPages.mockResolvedValue(after);
    apiMock.closeBrowserPage.mockRejectedValue(new Error("NOT_FOUND: Browser page was not found."));
    fireEvent.click(close);
    await waitFor(() => expect(screen.queryByRole("tab", { name: "First tab" })).toBeNull());
    expect(screen.queryByText(/NOT_FOUND/)).toBeNull();
    apiMock.closeBrowserPage.mockRejectedValue(new Error("Browser control is held"));
    fireEvent.click(screen.getByRole("button", { name: "Close browser tab Second tab" }));
    expect(await screen.findByText("Browser control is held")).toBeTruthy();
  });

  it("operates v2 stream modes, browser tabs and an exclusive operator lease", async () => {
    const firstPage = {
      pageId: "page:one",
      kind: "PAGE" as const,
      title: "Olla",
      url: "https://www.google.com/",
      isActive: true,
      openerPageId: null,
      canGoBack: false,
      canGoForward: false
    };
    const secondPage = { ...firstPage, pageId: "page:two", title: "Docs", url: "https://example.com/docs", isActive: false };
    const v2Response = sessionResponse({
      streamMode: "AUTO",
      resolvedStreamMode: "PREVIEW",
      runtimeState: "READY",
      capacityState: "AVAILABLE",
      controlState: "AGENT",
      pages: [firstPage, secondPage],
      activePageId: "page:one",
      workerHeartbeatAt: "2026-07-11T00:00:00.000Z",
      queuePosition: null
    } as never);
    apiMock.browserSession.mockResolvedValue(v2Response);
    apiMock.browserPages.mockResolvedValue({ sessionId: "browser_session:proof", pages: [firstPage, secondPage], activePageId: "page:one" });
    apiMock.updateBrowserSession.mockResolvedValue({
      ...v2Response,
      session: { ...v2Response.session, streamMode: "REALTIME", resolvedStreamMode: "REALTIME" }
    });
    apiMock.activateBrowserPage.mockResolvedValue({
      sessionId: "browser_session:proof",
      pages: [
        { ...firstPage, isActive: false },
        { ...secondPage, isActive: true }
      ],
      activePageId: "page:two"
    });
    apiMock.acquireBrowserControl.mockResolvedValue({
      lease: {
        leaseId: "lease:operator",
        sessionId: "browser_session:proof",
        paneId: "pane:browser-proof",
        roomId: "room:browser-proof",
        holderType: "OPERATOR",
        holderId: "space-user",
        status: "ACTIVE",
        reason: "Human takeover",
        acquiredAt: "2026-07-11T00:00:00.000Z",
        heartbeatAt: "2026-07-11T00:00:00.000Z",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        releasedAt: null
      }
    });
    apiMock.releaseBrowserControl.mockResolvedValue({
      lease: {
        leaseId: "lease:operator",
        sessionId: "browser_session:proof",
        paneId: "pane:browser-proof",
        roomId: "room:browser-proof",
        holderType: "OPERATOR",
        holderId: "space-user",
        status: "RELEASED",
        reason: "Human takeover",
        acquiredAt: "2026-07-11T00:00:00.000Z",
        heartbeatAt: "2026-07-11T00:00:00.000Z",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        releasedAt: "2026-07-11T00:00:05.000Z"
      }
    });

    render(<BrowserPane pane={browserPane()} agentNumber={4} />);

    expect(await screen.findByRole("tab", { name: "Olla" })).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Stream mode Research Browser"), { target: { value: "REALTIME" } });
    await waitFor(() => expect(apiMock.updateBrowserSession).toHaveBeenCalledWith("pane:browser-proof", { streamMode: "REALTIME" }));
    expect((await screen.findAllByText("Live")).length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole("tab", { name: "Docs" }));
    await waitFor(() => expect(apiMock.activateBrowserPage).toHaveBeenCalledWith("pane:browser-proof", "page:two"));

    fireEvent.click(screen.getByRole("button", { name: "Join browser session Research Browser" }));
    expect(await screen.findByRole("button", { name: "Release browser control Research Browser" })).toBeTruthy();
    expect(apiMock.acquireBrowserControl).toHaveBeenCalledWith("pane:browser-proof", expect.objectContaining({ holderType: "OPERATOR" }));
    const browserImage = screen.getByRole("img", { name: "Research Browser browser frame" });
    vi.spyOn(browserImage, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 1440,
      bottom: 900,
      width: 1440,
      height: 900,
      toJSON: () => ({})
    });
    fireEvent.pointerDown(browserImage, {
      pointerId: 1,
      pointerType: "mouse",
      clientX: 120,
      clientY: 80,
      button: 0,
      buttons: 1
    });
    await waitFor(() => expect(apiMock.browserInput).toHaveBeenCalledWith(
      "pane:browser-proof",
      expect.objectContaining({ type: "POINTER", eventType: "mousePressed", button: "left", leaseId: "lease:operator" })
    ));
    fireEvent.pointerDown(browserImage, {
      pointerId: 3,
      pointerType: "touch",
      clientX: 90,
      clientY: 60,
      button: 0,
      buttons: 1,
      pressure: 0.5
    });
    await waitFor(() => expect(apiMock.browserInput).toHaveBeenCalledWith(
      "pane:browser-proof",
      expect.objectContaining({ type: "TOUCH", eventType: "touchStart", touchPoints: [expect.objectContaining({ id: 3 })] })
    ));
    // After 100+ taps Android's pointerId passes the contract's 100: every tap was rejected (2026-10-21).
    fireEvent.pointerDown(browserImage, { pointerId: 357, pointerType: "touch", clientX: 90, clientY: 60, button: 0, buttons: 1 });
    await waitFor(() => expect(apiMock.browserInput).toHaveBeenCalledWith(
      "pane:browser-proof",
      expect.objectContaining({ type: "TOUCH", eventType: "touchStart", touchPoints: [expect.objectContaining({ id: 57 })] })
    ));
    await chooseBrowserAction("Type text into browser Research Browser");
    fireEvent.change(await screen.findByLabelText("Browser text input Research Browser"), { target: { value: "captcha answer" } });
    fireEvent.click(screen.getByRole("button", { name: "Type into browser Research Browser" }));
    await waitFor(() => expect(apiMock.browserInput).toHaveBeenCalledWith(
      "pane:browser-proof",
      expect.objectContaining({ type: "KEY", eventType: "char", text: "captcha answer", leaseId: "lease:operator" })
    ));
    // The emptied box passes Enter and Backspace to the page.
    const textBox = screen.getByLabelText("Browser text input Research Browser");
    fireEvent.keyDown(textBox, { key: "Enter" });
    await waitFor(() => expect(apiMock.browserInput).toHaveBeenCalledWith(
      "pane:browser-proof",
      expect.objectContaining({ type: "KEY", eventType: "keyDown", key: "Enter", text: "\r" })
    ));
    fireEvent.keyDown(textBox, { key: "Backspace" });
    await waitFor(() => expect(apiMock.browserInput).toHaveBeenCalledWith(
      "pane:browser-proof",
      expect.objectContaining({ type: "KEY", eventType: "keyUp", key: "Backspace" })
    ));
    // Without the stream socket, moves go one request at a time, coalesced to the latest point.
    apiMock.browserInput.mockClear();
    let finishMove!: () => void;
    apiMock.browserInput.mockImplementationOnce(() => new Promise((resolve) => { finishMove = () => resolve(sessionResponse()); }));
    for (const clientX of [10, 20, 30, 40]) {
      fireEvent.pointerMove(browserImage, { pointerId: 1, pointerType: "mouse", clientX, clientY: 80, buttons: 0 });
    }
    await waitFor(() => expect(apiMock.browserInput).toHaveBeenCalledTimes(1));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    expect(apiMock.browserInput).toHaveBeenCalledTimes(1);
    act(() => finishMove());
    await waitFor(() => expect(apiMock.browserInput).toHaveBeenCalledTimes(2));
    const [first, last] = apiMock.browserInput.mock.calls.map(([, input]) => input as { eventType: string; x: number });
    expect([first?.eventType, last?.eventType]).toEqual(["mouseMoved", "mouseMoved"]);
    expect(last!.x).toBeGreaterThan(first!.x);
    fireEvent.click(screen.getByRole("button", { name: "Release browser control Research Browser" }));
    await waitFor(() => expect(apiMock.releaseBrowserControl).toHaveBeenCalledWith("pane:browser-proof", { leaseId: "lease:operator" }));
  });

  it("captures evidence and exposes diagnostics with frame-by-frame playback", async () => {
    const captureArtifact: Artifact = {
      id: "artifact:proof",
      roomId: "room:browser-proof",
      paneId: "pane:browser-proof",
      turnId: null,
      workflowId: null,
      kind: "SCREENSHOT",
      mimeType: "image/png",
      storageUri: "space-artifact://browser-evidence/capture_proof/screenshot.png",
      sha256: "a".repeat(64),
      byteSize: 2048,
      metadata: { artifactFile: "screenshot.png" },
      expiresAt: "2026-07-18T00:00:00.000Z",
      pinnedAt: null,
      deletedAt: null,
      createdAt: "2026-07-11T00:00:00.000Z"
    };
    apiMock.browserSession.mockResolvedValue(sessionResponse());
    apiMock.createBrowserCapture
      .mockResolvedValueOnce({ job: captureJob("capture:screenshot", { kind: "SCREENSHOT", format: "PNG", target: "VIEWPORT", selector: null, quality: null }, "COMPLETED") })
      .mockResolvedValueOnce({ job: captureJob("capture:recording", { kind: "RECORDING", format: "WEBM", maxDurationMs: 1_800_000, maxBytes: 1_073_741_824, frameIntervalMs: 100 }, "RUNNING") });
    apiMock.browserDiagnostics.mockResolvedValue({
      sessionId: "browser_session:proof",
      events: [
        {
          eventId: "console:1",
          sessionId: "browser_session:proof",
          pageId: "page:one",
          sequence: 1,
          type: "CONSOLE",
          level: "ERROR",
          message: "Hydration failed",
          frameIndex: 0,
          metadata: {},
          occurredAt: "2026-07-11T00:00:01.000Z"
        },
        {
          eventId: "network:1",
          sessionId: "browser_session:proof",
          pageId: "page:one",
          sequence: 2,
          type: "NETWORK",
          level: "ERROR",
          message: "GET /api failed",
          frameIndex: 0,
          metadata: { method: "GET", url: "https://www.google.com/api", status: 500, durationMs: 42 },
          occurredAt: "2026-07-11T00:00:02.000Z"
        }
      ]
    });
    apiMock.artifacts.mockResolvedValue({
      data: [captureArtifact],
      pagination: { page: 1, pageSize: 100, totalItems: 1, totalPages: 1 }
    });
    apiMock.updateArtifactRetention.mockResolvedValue({ ...captureArtifact, pinnedAt: "2026-07-11T00:05:00.000Z" });

    render(<BrowserPane pane={browserPane()} agentNumber={4} />);
    expect(await screen.findByRole("img", { name: "Research Browser browser frame" })).toBeTruthy();

    await chooseBrowserAction("Capture browser screenshot Research Browser");
    await waitFor(() => expect(apiMock.createBrowserCapture).toHaveBeenNthCalledWith(1, "pane:browser-proof", { options: { kind: "SCREENSHOT", format: "PNG", target: "VIEWPORT", selector: null, quality: null } }));
    await chooseBrowserAction("Record browser session Research Browser");
    const recordingControls = await screen.findByRole("dialog", { name: "Browser recording controls Research Browser" });
    expect(within(recordingControls).getByRole("button", { name: "1m recording duration" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(within(recordingControls).getByRole("button", { name: "Start browser recording Research Browser" }));
    await waitFor(() => expect(apiMock.createBrowserCapture).toHaveBeenNthCalledWith(2, "pane:browser-proof", { options: { kind: "RECORDING", format: "WEBM", maxDurationMs: 60000, maxBytes: 1073741824, frameIntervalMs: 100 } }));
    expect(await within(recordingControls).findByRole("progressbar", { name: "Browser recording progress" })).toBeTruthy();

    await chooseBrowserAction("Open browser debugger Research Browser");
    expect(await screen.findByRole("tab", { name: "Console" })).toBeTruthy();
    expect(await screen.findByText("Hydration failed")).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "Network" }));
    expect(screen.getByText("500")).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "Timeline" }));
    expect(screen.getByRole("button", { name: "Previous browser frame" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Next browser frame" })).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "Artifacts" }));
    expect(await screen.findByRole("link", { name: "screenshot.png" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Pin browser artifact artifact:proof" }));
    await waitFor(() => expect(apiMock.updateArtifactRetention).toHaveBeenCalledWith(
      "artifact:proof",
      expect.objectContaining({ pinnedAt: expect.any(String) })
    ));
    const unpin = await screen.findByRole("button", { name: "Unpin browser artifact artifact:proof" });
    expect(unpin.getAttribute("aria-pressed")).toBe("true");
    expect(unpin.classList.contains("selected")).toBe(false);
  });

  it("supports recording duration presets plus stop and cancel actions", async () => {
    const fiveMinuteJob = captureJob(
      "capture:five-minute",
      { kind: "RECORDING", format: "WEBM", maxDurationMs: 300_000, maxBytes: 1_073_741_824, frameIntervalMs: 100 },
      "RUNNING"
    );
    const cancelledJob = { ...fiveMinuteJob, jobId: "capture:cancel", status: "CANCELLED" as const, progressPercent: 0 };
    apiMock.browserSession.mockResolvedValue(sessionResponse());
    apiMock.createBrowserCapture
      .mockResolvedValueOnce({ job: fiveMinuteJob })
      .mockResolvedValueOnce({ job: { ...fiveMinuteJob, jobId: "capture:cancel", options: { ...fiveMinuteJob.options, maxDurationMs: 10_000 } } });
    apiMock.stopBrowserCapture.mockResolvedValue({ job: { ...fiveMinuteJob, status: "COMPLETED", progressPercent: 100 } });
    apiMock.cancelBrowserCapture.mockResolvedValue({ job: cancelledJob });

    render(<BrowserPane pane={browserPane()} agentNumber={4} />);
    expect(await screen.findByRole("img", { name: "Research Browser browser frame" })).toBeTruthy();
    await chooseBrowserAction("Record browser session Research Browser");
    const controls = await screen.findByRole("dialog", { name: "Browser recording controls Research Browser" });
    expect(["10s", "30s", "1m", "5m", "30m"].map((label) => within(controls).getByRole("button", { name: `${label} recording duration` }))).toHaveLength(5);

    fireEvent.click(within(controls).getByRole("button", { name: "5m recording duration" }));
    fireEvent.click(within(controls).getByRole("button", { name: "Start browser recording Research Browser" }));
    await waitFor(() => expect(apiMock.createBrowserCapture).toHaveBeenCalledWith(
      "pane:browser-proof",
      { options: { kind: "RECORDING", format: "WEBM", maxDurationMs: 300_000, maxBytes: 1_073_741_824, frameIntervalMs: 100 } }
    ));
    expect((await within(controls).findByRole("progressbar", { name: "Browser recording progress" })).getAttribute("aria-valuenow")).toBe("25");
    fireEvent.click(within(controls).getByRole("button", { name: "Stop and save browser recording Research Browser" }));
    await waitFor(() => expect(apiMock.stopBrowserCapture).toHaveBeenCalledWith("pane:browser-proof", "capture:five-minute"));

    fireEvent.click(within(controls).getByRole("button", { name: "10s recording duration" }));
    fireEvent.click(within(controls).getByRole("button", { name: "Start browser recording Research Browser" }));
    await waitFor(() => expect(apiMock.createBrowserCapture).toHaveBeenLastCalledWith(
      "pane:browser-proof",
      { options: { kind: "RECORDING", format: "WEBM", maxDurationMs: 10_000, maxBytes: 1_073_741_824, frameIntervalMs: 100 } }
    ));
    fireEvent.click(within(controls).getByRole("button", { name: "Cancel browser recording Research Browser" }));
    await waitFor(() => expect(apiMock.cancelBrowserCapture).toHaveBeenCalledWith("pane:browser-proof", "capture:cancel"));
  });

  it("opens persisted recordings and steps their playback frame by frame", async () => {
    const recordingVideo: Artifact = {
      id: "artifact:video",
      roomId: "room:browser-proof",
      paneId: "pane:browser-proof",
      turnId: null,
      workflowId: null,
      kind: "VIDEO",
      mimeType: "video/webm",
      storageUri: "space-artifact://browser-evidence/recording/recording.webm",
      sha256: "b".repeat(64),
      byteSize: 4096,
      metadata: { browserCaptureJobId: "capture:persisted", filename: "recording.webm" },
      expiresAt: null,
      pinnedAt: null,
      deletedAt: null,
      createdAt: "2026-07-11T00:00:00.000Z"
    };
    const manifest: Artifact = {
      ...recordingVideo,
      id: "artifact:manifest",
      kind: "EXPORT",
      mimeType: "application/json",
      storageUri: "space-artifact://browser-evidence/recording/manifest.json",
      metadata: { browserCaptureJobId: "capture:persisted", filename: "manifest.json" }
    };
    const segmentArtifact: Artifact = {
      ...recordingVideo,
      id: "artifact:segment",
      storageUri: "space-artifact://browser-evidence/recording/segment-0000.webm",
      metadata: { browserCaptureJobId: "capture:persisted", filename: "segment-0000.webm" }
    };
    apiMock.browserSession.mockResolvedValue(sessionResponse());
    apiMock.browserDiagnostics.mockResolvedValue({ sessionId: "browser_session:proof", events: [] });
    apiMock.artifacts.mockResolvedValue({ data: [segmentArtifact, recordingVideo, manifest], pagination: { page: 1, pageSize: 100, totalItems: 3, totalPages: 1 } });
    apiMock.browserRecordingManifest.mockResolvedValue({ durationMs: 10_000, fps: 10, frameCount: 100, startedAt: "2026-07-11T00:00:00.000Z", finishedAt: "2026-07-11T00:00:10.000Z" });
    apiMock.browserCaptureTimeline.mockResolvedValue({
      jobId: "capture:persisted",
      sessionId: "browser_session:proof",
      durationMs: 500,
      frameCount: 3,
      segmentCount: 1,
      frames: [
        { index: 0, segmentSequence: 0, segmentFrameIndex: 0, capturedAt: "2026-07-11T00:00:00.000Z", elapsedMs: 0 },
        { index: 1, segmentSequence: 0, segmentFrameIndex: 1, capturedAt: "2026-07-11T00:00:00.125Z", elapsedMs: 125 },
        { index: 2, segmentSequence: 0, segmentFrameIndex: 2, capturedAt: "2026-07-11T00:00:00.500Z", elapsedMs: 500 }
      ],
      events: []
    });
    apiMock.browserCaptureSegments.mockResolvedValue({
      jobId: "capture:persisted",
      segments: [{
        segmentId: "browser_segment:persisted",
        jobId: "capture:persisted",
        sessionId: "browser_session:proof",
        sequence: 0,
        status: "FINALIZED",
        artifactId: "artifact:segment",
        storageUri: segmentArtifact.storageUri,
        sha256: segmentArtifact.sha256,
        byteSize: segmentArtifact.byteSize,
        durationMs: 500,
        frameCount: 3,
        lastFrameSequence: 2,
        statusReason: "Segment finalized.",
        startedAt: "2026-07-11T00:00:00.000Z",
        updatedAt: "2026-07-11T00:00:00.500Z",
        finalizedAt: "2026-07-11T00:00:00.500Z"
      }]
    });

    render(<BrowserPane pane={browserPane()} agentNumber={4} />);
    expect(await screen.findByRole("img", { name: "Research Browser browser frame" })).toBeTruthy();
    await chooseBrowserAction("Open browser debugger Research Browser");
    fireEvent.click(await screen.findByRole("tab", { name: "Artifacts" }));
    const video = await screen.findByLabelText("Persisted browser recording capture:persisted");
    expect(screen.getAllByLabelText("Persisted browser recording capture:persisted")).toHaveLength(1);
    expect(await screen.findByText("1/1 segments ready")).toBeTruthy();
    expect(screen.getByRole("slider", { name: "Persisted recording timeline" }).getAttribute("max")).toBe("2");
    Object.defineProperty(video, "duration", { configurable: true, value: 10 });
    Object.defineProperty(video, "currentTime", { configurable: true, writable: true, value: 0 });
    fireEvent.click(screen.getByRole("button", { name: "Next persisted recording frame" }));
    expect((video as HTMLVideoElement).currentTime).toBeCloseTo(0.125);
    fireEvent.click(screen.getByRole("button", { name: "Previous persisted recording frame" }));
    expect((video as HTMLVideoElement).currentTime).toBe(0);
  });

  it("focuses the requested browser pane when a handoff action arrives", async () => {
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: scrollIntoView });
    render(<BrowserPane pane={browserPane()} agentNumber={4} />);
    const joinButton = await screen.findByRole("button", { name: "Join browser session Research Browser" });
    await waitFor(() => expect((joinButton as HTMLButtonElement).disabled).toBe(false));

    fireEvent(window, new CustomEvent(BROWSER_PANE_ACTION_EVENT, {
      detail: { paneId: "pane:browser-proof", action: "handoff", roomId: "room:browser-proof" }
    }));
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalled());
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText("Browser text input Research Browser")));
  });

  it("does not enter operator mode when the v2 control lease is held elsewhere", async () => {
    apiMock.browserSession.mockResolvedValue(sessionResponse({ controlState: "AGENT" }));
    apiMock.acquireBrowserControl.mockRejectedValue({ status: 409, message: "Control lease is already active" });

    render(<BrowserPane pane={browserPane()} agentNumber={4} />);
    expect(await screen.findByRole("img", { name: "Research Browser browser frame" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Join browser session Research Browser" }));

    expect((await screen.findByRole("alert")).textContent).toContain("Browser control could not be acquired");
    expect(screen.queryByLabelText("Browser text input Research Browser")).toBeNull();
    expect(screen.getByRole("button", { name: "Join browser session Research Browser" })).toBeTruthy();
  });

  it("keeps the browser canvas and debugger responsive with mobile-sized controls", () => {
    const css = readFileSync(resolve(__dirname, "../src/styles.css"), "utf8");
    const browserCss = css.slice(css.indexOf(".browser-pane {"), css.indexOf(".pane-copy {"));

    expect(browserCss).toContain("@container pane-body (max-width: 44rem)");
    expect(browserCss).toContain("grid-template-rows: auto auto minmax(0, 1fr)");
    expect(browserCss).toContain(".browser-canvas-surface");
    expect(browserCss).toContain(".browser-debug-drawer {\n  position: absolute");
    expect(browserCss).toContain("width: min(22rem, 46%)");
    expect(browserCss).not.toContain(".browser-control-strip");
    expect(browserCss).toContain("touch-action: none");
    expect(browserCss).not.toContain("!important");
  });

  it("uses a compact canvas-first layout while keeping every viewport one click away", async () => {
    const { container } = render(<BrowserPane pane={browserPane()} agentNumber={4} />);

    expect(await screen.findByRole("img", { name: "Research Browser browser frame" })).toBeTruthy();
    expect(screen.getByRole("textbox", { name: "Browser URL Research Browser" }).getAttribute("name")).toBe("browser-url");
    expect(screen.getByRole("combobox", { name: "Stream mode Research Browser" }).getAttribute("name")).toBe("browser-stream-mode");
    expect(container.querySelector("canvas[aria-label='Research Browser browser frame']")).toBeTruthy();
    expect(container.querySelector(".browser-status-row")).toBeNull();
    expect(container.querySelector(".browser-control-strip")).toBeNull();
    expect(screen.queryByLabelText("Browser text input Research Browser")).toBeNull();

    expect(screen.getByRole("button", { name: "PC view Research Browser" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Tablet view Research Browser" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Mobile view Research Browser" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Join browser session Research Browser" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Expand browser view Research Browser" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "More browser actions Research Browser" }));
    const tools = await screen.findByRole("menu", { name: "Browser actions Research Browser" });
    for (const actionName of [
      "Browser bookmarks Research Browser",
      "Type text into browser Research Browser",
      "Capture browser screenshot Research Browser",
      "Record browser session Research Browser",
      "Open browser debugger Research Browser",
      "Reload page Research Browser",
      "Restart browser Research Browser",
      "Stop browser session Research Browser"
    ]) {
      expect(within(tools).getByRole("menuitem", { name: actionName })).toBeTruthy();
    }
  });

  it("keeps the URL usable and moves viewport controls into overflow in narrow panes", async () => {
    apiMock.browserSession.mockResolvedValue(sessionResponse());
    const measure = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ x:0,y:0,left:0,top:0,right:320,bottom:600,width:320,height:600,toJSON:()=>({}) });
    const callbacks: Array<() => void> = [];
    vi.stubGlobal("ResizeObserver", class { constructor(callback: () => void) { callbacks.push(callback); } observe() {} disconnect() {} unobserve() {} });
    try {
      const { container } = render(<BrowserPane pane={browserPane()} agentNumber={4} />);
      await screen.findByRole("button", { name: "More browser actions Research Browser" });
      expect(container.querySelector(".browser-toolbar-compact")).toBeTruthy();
      // At 320px the Live badge would leave the address field under 160px: it stays out until the toolbar is wider.
      expect(container.querySelector(".browser-live-status")).toBeNull();
      expect(screen.queryByRole("button", { name: "DevTools Research Browser" })).toBeNull();
      expect(screen.queryByRole("button", { name: "PC view Research Browser" })).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "More browser actions Research Browser" }));
      expect(screen.getByRole("menuitem", { name: "DevTools Research Browser" })).toBeTruthy();
      expect(screen.getByRole("combobox", { name: "Stream mode Research Browser" })).toBeTruthy();
      expect(screen.getByRole("menuitem", { name: "PC view Research Browser" })).toBeTruthy();
      expect(screen.getByRole("menuitem", { name: "Fit browser to pane Research Browser" })).toBeTruthy();
      fireEvent.click(screen.getByRole("menuitem", { name: "Mobile view Research Browser" }));
      await waitFor(() => expect(apiMock.setBrowserViewport).toHaveBeenCalledWith("pane:browser-proof", "mobile"));
      measure.mockReturnValue({ x:0,y:0,left:0,top:0,right:1200,bottom:600,width:1200,height:600,toJSON:()=>({}) });
      act(() => callbacks.forEach((callback) => callback()));
      expect(container.querySelector(".browser-toolbar-stacked")).toBeNull();
      expect(container.querySelector(".browser-live-status")).toBeTruthy();
      expect(screen.getByRole("button", { name: "PC view Research Browser" })).toBeTruthy();
    } finally { measure.mockRestore(); vi.unstubAllGlobals(); }
  });

  it("bounds a wheel burst while preserving scroll distance and subsequent typing order", async () => {
    apiMock.browserSession.mockResolvedValue(streamingSessionResponse());
    apiMock.browserStreamTicket.mockResolvedValue({ websocket: streamTicket(1) });
    apiMock.browserStreamWebSocketUrl.mockReturnValue("ws://space.test/browser");
    apiMock.acquireBrowserControl.mockResolvedValue(operatorLease());
    render(<BrowserPane pane={browserPane()} agentNumber={4} />);
    await waitFor(() => expect(MockBrowserWebSocket.instances[0]?.readyState).toBe(1));
    const socket = MockBrowserWebSocket.instances[0]!;
    act(() => socket.serverMessage({ type: "ready", paneId: "pane:browser-proof", sessionId: "browser_session:proof",
      streamId: "browser_stream:test", encoding: "image/jpeg", requestedMode: "REALTIME", resolvedMode: "REALTIME", framesPerSecond: 35 }));
    const canvas = await screen.findByRole("img", { name: "Research Browser browser frame" });
    vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue({ x:0,y:0,left:0,top:0,right:1440,bottom:900,width:1440,height:900,toJSON:()=>({}) });
    const inputs = () => socket.sent.map(value => JSON.parse(value)).filter(message => message.type === "input");
    fireEvent.wheel(canvas, { clientX: 200, clientY: 300, deltaY: 10 });
    await waitFor(() => expect(inputs()).toHaveLength(1));
    // No ACK arrives while the trackpad keeps emitting events.
    for (let n = 0; n < 100; n++) fireEvent.wheel(canvas, { clientX: 200, clientY: 300, deltaY: 10 });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 40)); });
    expect(inputs()).toHaveLength(1);
    fireEvent.keyDown(canvas, { key: "a", code: "KeyA" });
    await waitFor(() => expect(inputs()).toHaveLength(3));
    expect(inputs().map(message => message.input.eventType)).toEqual(["mouseWheel", "mouseWheel", "keyDown"]);
    expect(inputs().slice(0, 2).reduce((total, message) => total + message.input.deltaY, 0)).toBe(1010);
    for (const message of inputs()) act(() => socket.serverMessage({ type: "inputAck", requestId: message.requestId, ok: true, serverDurationMs: 80 }));
    expect(apiMock.browserInput).not.toHaveBeenCalled();
  });

  it("sends ordered realtime canvas input over the binary stream and records ACK telemetry without REST replay", async () => {
    apiMock.browserSession.mockResolvedValue(streamingSessionResponse());
    apiMock.browserStreamTicket.mockResolvedValue({ websocket: streamTicket(1) });
    apiMock.browserStreamWebSocketUrl.mockImplementation((ticket: { token: string }) => `ws://space.test/browser?token=${ticket.token}`);
    apiMock.acquireBrowserControl.mockResolvedValue(operatorLease());
    const { container } = render(<BrowserPane pane={browserPane()} agentNumber={4} />);

    await waitFor(() => expect(MockBrowserWebSocket.instances).toHaveLength(1));
    const socket = MockBrowserWebSocket.instances[0]!;
    await waitFor(() => expect(socket.readyState).toBe(MockBrowserWebSocket.OPEN));
    act(() => socket.serverMessage({
      type: "ready",
      paneId: "pane:browser-proof",
      sessionId: "browser_session:proof",
      streamId: "browser_stream:test",
      encoding: "image/jpeg",
      requestedMode: "REALTIME",
      resolvedMode: "REALTIME",
      framesPerSecond: 24
    }));

    const canvas = await screen.findByRole("img", { name: "Research Browser browser frame" });
    vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue({
      x: 0, y: 0, left: 0, top: 0, right: 1440, bottom: 900, width: 1440, height: 900, toJSON: () => ({})
    });
    // A bare hover over the live view neither takes control (the agent keeps the browser) nor reaches the page.
    fireEvent.pointerMove(canvas, { pointerId: 1, pointerType: "mouse", clientX: 100, clientY: 80, buttons: 0 });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    expect(apiMock.acquireBrowserControl).not.toHaveBeenCalled();
    expect(socket.sent.filter((value) => value.includes('"type":"input"'))).toHaveLength(0);

    fireEvent.pointerDown(canvas, { pointerId: 1, pointerType: "mouse", clientX: 220, clientY: 120, button: 0, buttons: 1 });
    fireEvent.pointerUp(canvas, { pointerId: 1, pointerType: "mouse", clientX: 220, clientY: 120, button: 0, buttons: 0 });
    await waitFor(() => expect(socket.sent.filter((value) => value.includes('"type":"input"'))).toHaveLength(2));
    expect(apiMock.acquireBrowserControl).toHaveBeenCalledTimes(1);
    const clicks = socket.sent.map((value) => JSON.parse(value)).filter((message) => message.type === "input");
    for (const message of clicks) {
      act(() => socket.serverMessage({ type: "inputAck", requestId: message.requestId, ok: true, serverDurationMs: 2 }));
    }
    // While the click's lease is held, hover reaches the page again (coalesced to the latest point).
    fireEvent.pointerMove(canvas, { pointerId: 1, pointerType: "mouse", clientX: 100, clientY: 80, buttons: 0 });
    fireEvent.pointerMove(canvas, { pointerId: 1, pointerType: "mouse", clientX: 240, clientY: 140, buttons: 0 });

    await waitFor(() => expect(socket.sent.filter((value) => value.includes('"type":"input"'))).toHaveLength(3));
    const inputs = socket.sent.map((value) => JSON.parse(value)).filter((message) => message.type === "input");
    expect(inputs.map((message) => message.input.eventType)).toEqual(["mousePressed", "mouseReleased", "mouseMoved"]);
    expect(inputs[0].input.leaseId).toBe("browser_lease:operator");
    expect(inputs[2].input.leaseId).toBe("browser_lease:operator");
    expect(inputs[2].input.x).toBeCloseTo(240);
    expect(inputs[2].input.y).toBeCloseTo(140);
    expect(apiMock.browserInput).not.toHaveBeenCalled();

    act(() => socket.serverMessage({ type: "inputAck", requestId: inputs[2].requestId, ok: true, serverDurationMs: 2 }));
    const paneElement = container.querySelector(".browser-pane") as HTMLElement;
    await waitFor(() => expect(paneElement.dataset.browserInputPending).toBe("0"));
    expect(paneElement.dataset.browserInputLastAck).toBe("ok");
    expect(Number(paneElement.dataset.browserInputRttMs)).toBeGreaterThanOrEqual(0);

    fireEvent.keyDown(canvas, { key: "a", code: "KeyA" });
    await waitFor(() => expect(socket.sent.filter((value) => value.includes('"type":"input"'))).toHaveLength(4));
    const keyMessage = JSON.parse(socket.sent.at(-1)!);
    act(() => socket.serverMessage({
      type: "inputAck",
      requestId: keyMessage.requestId,
      ok: false,
      serverDurationMs: 3,
      error: { code: "BROWSER_INPUT_FAILED", message: "Browser input could not be dispatched." }
    }));
    expect((await screen.findByRole("alert")).textContent).toContain("Browser input could not be dispatched");
    expect(apiMock.browserInput).not.toHaveBeenCalled();
  });

  it("closes the frame stream while the page is hidden and reconnects with a fresh ticket when it shows", async () => {
    apiMock.browserSession.mockResolvedValue(streamingSessionResponse());
    apiMock.browserStreamTicket
      .mockResolvedValueOnce({ websocket: streamTicket(1) })
      .mockResolvedValueOnce({ websocket: streamTicket(2) });
    apiMock.browserStreamWebSocketUrl.mockImplementation((ticket: { token: string }) => `ws://space.test/browser?token=${ticket.token}`);
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    try {
      render(<BrowserPane pane={browserPane()} agentNumber={4} />);
      await waitFor(() => expect(MockBrowserWebSocket.instances).toHaveLength(1));
      const first = MockBrowserWebSocket.instances[0]!;
      await waitFor(() => expect(first.readyState).toBe(MockBrowserWebSocket.OPEN));

      visibility.mockReturnValue("hidden");
      act(() => { document.dispatchEvent(new Event("visibilitychange")); });
      expect(first.readyState).toBe(MockBrowserWebSocket.CLOSED);
      await new Promise((resolve) => setTimeout(resolve, 600));
      expect(MockBrowserWebSocket.instances).toHaveLength(1);

      visibility.mockReturnValue("visible");
      act(() => { document.dispatchEvent(new Event("visibilitychange")); });
      await waitFor(() => expect(MockBrowserWebSocket.instances).toHaveLength(2));
      expect(MockBrowserWebSocket.instances[1]!.url).toContain("browser-stream-ticket-2-test-value");
    } finally {
      visibility.mockRestore();
    }
  });

  it("fetches a fresh one-time stream ticket before reconnecting and never replays timed-out input through REST", async () => {
    apiMock.browserSession.mockResolvedValue(streamingSessionResponse());
    apiMock.browserStreamTicket
      .mockResolvedValueOnce({ websocket: streamTicket(1) })
      .mockResolvedValueOnce({ websocket: streamTicket(2) });
    apiMock.browserStreamWebSocketUrl.mockImplementation((ticket: { token: string }) => `ws://space.test/browser?token=${ticket.token}`);
    apiMock.acquireBrowserControl.mockResolvedValue(operatorLease());
    const { container } = render(<BrowserPane pane={browserPane()} agentNumber={4} />);

    await waitFor(() => expect(MockBrowserWebSocket.instances).toHaveLength(1));
    const initialSocket = MockBrowserWebSocket.instances[0]!;
    await waitFor(() => expect(initialSocket.readyState).toBe(MockBrowserWebSocket.OPEN));
    act(() => initialSocket.serverMessage({
      type: "ready",
      paneId: "pane:browser-proof",
      sessionId: "browser_session:proof",
      streamId: "browser_stream:first",
      encoding: "image/jpeg",
      requestedMode: "REALTIME",
      resolvedMode: "REALTIME",
      framesPerSecond: 24
    }));
    const canvas = await screen.findByRole("img", { name: "Research Browser browser frame" });
    vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue({
      x: 0, y: 0, left: 0, top: 0, right: 1440, bottom: 900, width: 1440, height: 900, toJSON: () => ({})
    });
    vi.useFakeTimers();
    await act(async () => {
      fireEvent.pointerDown(canvas, { pointerId: 1, pointerType: "mouse", clientX: 50, clientY: 40, button: 0, buttons: 1 });
      await Promise.resolve();
    });
    expect(initialSocket.sent.some((value) => value.includes('"mousePressed"'))).toBe(true);
    act(() => vi.advanceTimersByTime(2_500));
    expect(apiMock.browserInput).not.toHaveBeenCalled();
    expect((container.querySelector(".browser-pane") as HTMLElement).dataset.browserInputLastAck).toBe("timeout");
    vi.useRealTimers();

    act(() => initialSocket.close());
    await waitFor(() => expect(MockBrowserWebSocket.instances).toHaveLength(2));
    expect(apiMock.browserStreamTicket).toHaveBeenCalledTimes(2);
    expect(MockBrowserWebSocket.instances[1]!.url).toContain("browser-stream-ticket-2-test-value");
    expect(MockBrowserWebSocket.instances[1]!.url).not.toContain("browser-stream-ticket-1-test-value");
  });
});
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

describe("browser HTTP input queue", () => {
  const move = (x: number) => ({ type: "POINTER" as const, leaseId: "lease:a", eventType: "mouseMoved" as const, x, y: 1 });
  const wheel = (deltaY: number) => ({ type: "POINTER" as const, leaseId: "lease:a", eventType: "mouseWheel" as const, x: 1, y: 1, deltaY });
  it("keeps the latest move, adds wheel deltas within the limit and keeps the order of other inputs", () => {
    const queue: Parameters<typeof queueBrowserHttpInput>[0] = [];
    for (const input of [move(1), move(2), wheel(100), wheel(50), wheel(9_900), move(3)]) queueBrowserHttpInput(queue, input);
    queueBrowserHttpInput(queue, { type: "KEY", leaseId: "lease:a", eventType: "keyDown", key: "a" });
    queueBrowserHttpInput(queue, move(4));
    expect(queue.map((input) => "eventType" in input ? [input.eventType, "x" in input ? input.x : null, "deltaY" in input ? input.deltaY : undefined] : null))
      .toEqual([["mouseMoved", 2, undefined], ["mouseWheel", 1, 150], ["mouseWheel", 1, 9_900], ["mouseMoved", 3, undefined], ["keyDown", null, undefined], ["mouseMoved", 4, undefined]]);
  });
});
