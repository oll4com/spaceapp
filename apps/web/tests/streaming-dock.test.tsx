import {
  streamingMetricDefinitions,
  type StreamingCatalogResponse,
  type StreamingOverlaySettings,
  type StreamingOverlaySnapshot
} from "@space/contracts";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StreamingDock } from "../src/features/streaming/StreamingDock.js";
import { DockActiveContext } from "../src/features/docks/dock-active-context.js";
import {
  STREAMING_OVERLAY_SESSION_KEY,
  StreamingOverlayProvider
} from "../src/features/streaming/StreamingOverlay.js";
import { liveRuntime } from "../src/live/live-runtime.js";
import { installSpaceRuntime, SpaceApiError, type SpaceApiClient } from "../src/runtime/SpaceRuntime.js";

const settings: StreamingOverlaySettings = {
  version: 3,
  tiles: [
    { metricKey: "space.rooms", accountId: null },
    { metricKey: "space.active_agents", accountId: null },
    { metricKey: "space.active_cli_sessions", accountId: null }
  ],
  customTextEnabled: false,
  customText: "",
  updatedAt: "2026-08-11T12:00:00.000Z",
  updatedBy: "user:admin"
};

const catalog: StreamingCatalogResponse = {
  providers: (["YOUTUBE", "TWITCH", "TIKTOK", "X", "DISCORD"] as const).map((provider) => ({
    provider,
    status: provider === "YOUTUBE" ? "READY" : "UNCONFIGURED",
    clientFilePresent: provider === "YOUTUBE",
    clientFileSecure: provider === "YOUTUBE",
    code: provider === "YOUTUBE" ? "READY" : "CLIENT_FILE_MISSING",
    message: provider === "YOUTUBE" ? "YouTube is ready." : `${provider} client credentials are not configured.`,
    scopes: []
  })),
  metrics: streamingMetricDefinitions.map((metric) => ({ ...metric })),
  authorizations: [{
    id: "streaming_authorization:youtube",
    provider: "YOUTUBE",
    status: "ACTIVE",
    scopes: ["youtube.readonly"],
    accountCount: 1,
    lastRefreshedAt: "2026-08-11T12:00:00.000Z",
    safeErrorCode: null,
    safeErrorMessage: null,
    createdAt: "2026-08-11T12:00:00.000Z",
    updatedAt: "2026-08-11T12:00:00.000Z"
  }],
  accounts: [{
    id: "streaming_account:youtube",
    authorizationId: "streaming_authorization:youtube",
    provider: "YOUTUBE",
    externalAccountId: "channel-1",
    displayName: "Channel One",
    badge: "@channel-one",
    status: "ACTIVE",
    analyticsPeriod: 28,
    verifiedAt: "2026-08-11T12:00:00.000Z",
    safeErrorCode: null,
    safeErrorMessage: null,
    createdAt: "2026-08-11T12:00:00.000Z",
    updatedAt: "2026-08-11T12:00:00.000Z"
  }],
  settings
};

const snapshot: StreamingOverlaySnapshot = {
  generatedAt: "2026-08-11T12:00:00.000Z",
  settingsVersion: 3,
  tiles: settings.tiles.map((tile, index) => ({
    ...tile,
    provider: "SPACE" as const,
    label: ["Rooms", "Active agents", "Active CLI sessions"][index]!,
    badge: "Space",
    value: index + 1,
    state: "FRESH" as const,
    sampledAt: "2026-08-11T12:00:00.000Z"
  })),
  customTextEnabled: false,
  customText: "",
  botTickerEnabled: false,
  botTicker: []
};

function renderDock(apiOverrides: Partial<SpaceApiClient> = {}) {
  const api = {
    streamingCatalog: vi.fn(async () => structuredClone(catalog)),
    streamingOverlaySnapshot: vi.fn(async () => structuredClone(snapshot)),
    updateStreamingOverlaySettings: vi.fn(async (input) => ({
      ...settings,
      version: settings.version + 1,
      tiles: input.tiles,
      customTextEnabled: input.customTextEnabled,
      customText: input.customText
    })),
    startStreamingOAuth: vi.fn(),
    verifyStreamingAccount: vi.fn(async () => ({ account: catalog.accounts[0]! })),
    removeStreamingAccount: vi.fn(async () => ({ account: catalog.accounts[0]! })),
    disconnectStreamingAuthorization: vi.fn(async () => ({ authorizationId: catalog.authorizations[0]!.id, status: "REVOKED" as const, disconnected: true })),
    ...apiOverrides
  } as unknown as SpaceApiClient;
  installSpaceRuntime({ ...liveRuntime, api });
  const result = render(
    <StreamingOverlayProvider active>
      <StreamingDock />
    </StreamingOverlayProvider>
  );
  return { ...result, api };
}

describe("StreamingDock", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps provider accounts opt-in, enforces 64 tiles, and exposes safe readiness details", async () => {
    renderDock();
    const controls = await screen.findByLabelText("Streaming controls");
    expect(controls.classList.contains("streaming-dock")).toBe(true);
    expect(within(controls).getAllByRole("tablist", { name: "Streaming dock sections" })).toHaveLength(1);
    for (const section of ["Overview", "Bot", "Memory", "Moderation", "Display", "Activity"]) {
      expect(screen.getByRole("tab", { name: section })).toBeTruthy();
    }
    expect(within(controls).getAllByText("Client credentials file is missing")).toHaveLength(4);
    expect(within(controls).queryByText("CLIENT_FILE_MISSING")).toBeNull();
    expect(within(controls).getAllByText("Not configured")).toHaveLength(4);
    expect(within(controls).queryByText("UNCONFIGURED")).toBeNull();
    expect(within(controls).getByText("3/64")).toBeTruthy();

    // Providers start collapsed by default
    expect(screen.queryByRole("switch", { name: "Subscribers" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Expand YouTube" }));

    expect(screen.queryByRole("switch", { name: "Subscribers" })).toBeTruthy();
    expect((screen.getByRole("switch", { name: "Subscribers" }) as HTMLInputElement).checked).toBe(false);
    expect((screen.getByRole("switch", { name: "Rooms" }) as HTMLInputElement).checked).toBe(true);

    const accountMetrics = screen.getByRole("group", { name: "Metrics for Channel One" });
    const switches = within(accountMetrics).getAllByRole("switch");
    for (const toggle of switches.slice(0, 9)) fireEvent.click(toggle);
    expect(screen.getByText("12/64")).toBeTruthy();
  });

  it("supports native drag ordering, accessible move buttons, per-tile periods, preview, and explicit save", async () => {
    const { api } = renderDock();
    await screen.findByLabelText("Streaming controls");
    fireEvent.click(screen.getByRole("button", { name: "Expand YouTube" }));
    fireEvent.click(screen.getByRole("switch", { name: "Period views" }));
    fireEvent.click(screen.getByRole("tab", { name: "Display" }));
    const order = screen.getByRole("list", { name: "Streaming overlay tile order" });
    let rows = within(order).getAllByRole("listitem");
    fireEvent.dragStart(rows[0]!);
    fireEvent.dragOver(rows[2]!);
    fireEvent.drop(rows[2]!);
    rows = within(order).getAllByRole("listitem");
    expect(within(rows[2]!).getByText("Rooms")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Move Rooms earlier" }));
    rows = within(order).getAllByRole("listitem");
    expect(within(rows[1]!).getByText("Rooms")).toBeTruthy();

    fireEvent.change(screen.getByRole("combobox", { name: "Period" }), { target: { value: "90" } });
    fireEvent.click(screen.getByRole("switch", { name: "Custom footer text" }));
    fireEvent.change(screen.getByLabelText("Streaming overlay custom text"), { target: { value: "Line one\nLine two\nLine three" } });
    expect((screen.getByLabelText("Streaming overlay custom text") as HTMLTextAreaElement).value).toBe("Line one\nLine two");

    fireEvent.click(screen.getByRole("switch", { name: "Draft preview" }));
    expect(await screen.findByLabelText("Streaming overlay draft preview")).toBeTruthy();
    await waitFor(() => expect(api.streamingOverlaySnapshot).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole("button", { name: "Save overlay" }));
    await waitFor(() => expect(api.updateStreamingOverlaySettings).toHaveBeenCalledTimes(1));
    expect(api.updateStreamingOverlaySettings).toHaveBeenCalledWith(expect.objectContaining({
      expectedVersion: 3,
      customTextEnabled: true,
      customText: "Line one\nLine two",
      tiles: expect.arrayContaining([expect.objectContaining({
        metricKey: "youtube.analytics.views",
        analyticsPeriod: 90
      })])
    }));
  });

  it("uses session-only activation and refreshes the catalog after an optimistic 409", async () => {
    const conflict = vi.fn(async () => {
      throw new SpaceApiError("Overlay settings changed.", { status: 409, code: "STREAMING_SETTINGS_VERSION_CONFLICT" });
    });
    const { api } = renderDock({ updateStreamingOverlaySettings: conflict as SpaceApiClient["updateStreamingOverlaySettings"] });
    await screen.findByLabelText("Streaming controls");
    fireEvent.click(screen.getByRole("tab", { name: "Display" }));

    fireEvent.click(screen.getByRole("switch", { name: "Overlay" }));
    expect(window.sessionStorage.getItem(STREAMING_OVERLAY_SESSION_KEY)).toBe("true");
    expect(window.localStorage.getItem(STREAMING_OVERLAY_SESSION_KEY)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Save overlay" }));
    await waitFor(() => expect(api.streamingCatalog).toHaveBeenCalledTimes(2));
    expect(screen.getByText("A newer overlay version was loaded. Review it before saving again.")).toBeTruthy();
  });

  it("supports bulk selection of all metrics for accounts, space metrics, and all providers", async () => {
    renderDock();
    await screen.findByLabelText("Streaming controls");
    expect(screen.getByText("3/64")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Expand YouTube" }));

    const channelOneGroup = screen.getByRole("group", { name: "Metrics for Channel One" });
    const channelOneSelectAll = within(channelOneGroup).getByRole("button", { name: "All metrics" });
    fireEvent.click(channelOneSelectAll);

    expect(within(channelOneGroup).getByRole("button", { name: "Deselect all" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Deselect all provider metrics" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Deselect all provider metrics" }));
    expect(screen.getByRole("button", { name: "All provider metrics" })).toBeTruthy();
    expect(within(channelOneGroup).getByRole("button", { name: "All metrics" })).toBeTruthy();
    expect(screen.getByText("3/64")).toBeTruthy();

    const spaceGroup = screen.getByRole("group", { name: "Metrics from this Space installation" });
    const spaceDeselect = within(spaceGroup).getByRole("button", { name: "Deselect all" });
    fireEvent.click(spaceDeselect);
    expect(screen.getByText("0/64")).toBeTruthy();
    expect(within(spaceGroup).getByRole("button", { name: "All metrics" })).toBeTruthy();

    fireEvent.click(within(spaceGroup).getByRole("button", { name: "All metrics" }));
    expect(screen.getByText("3/64")).toBeTruthy();
    expect(within(spaceGroup).getByRole("button", { name: "Deselect all" })).toBeTruthy();
  });

  it("starts with providers collapsed by default and allows expanding each individually", async () => {
    renderDock();
    await screen.findByLabelText("Streaming controls");

    // All provider cards start collapsed; the chevron is the one accessible toggle per card.
    const youtubeToggle = screen.getByRole("button", { name: "Expand YouTube" });
    const twitchToggle = screen.getByRole("button", { name: "Expand Twitch" });
    expect(youtubeToggle.getAttribute("aria-expanded")).toBe("false");
    expect(twitchToggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("group", { name: "Metrics for Channel One" })).toBeNull();

    // Open YouTube
    fireEvent.click(youtubeToggle);
    expect(youtubeToggle.getAttribute("aria-expanded")).toBe("true");
    expect(youtubeToggle.getAttribute("aria-label")).toBe("Collapse YouTube");
    expect(twitchToggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.getByRole("group", { name: "Metrics for Channel One" })).toBeTruthy();
    expect(screen.getByLabelText("Capabilities for Channel One")).toBeTruthy();
    expect(screen.getAllByText("ON").length).toBeGreaterThanOrEqual(1);

    // Close YouTube with the same button
    fireEvent.click(screen.getByRole("button", { name: "Collapse YouTube" }));
    expect(youtubeToggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("group", { name: "Metrics for Channel One" })).toBeNull();

    // A click on the card header opens it too
    fireEvent.click(screen.getByRole("heading", { name: "YouTube" }));
    expect(screen.getByRole("group", { name: "Metrics for Channel One" })).toBeTruthy();
  });

  it("copies provider login link to clipboard and disables copy when provider is unconfigured", async () => {
    let written = "";
    Object.assign(navigator, {
      clipboard: {
        writeText: vi.fn(async (text: string) => {
          written = text;
        })
      }
    });

    const startOAuth = vi.fn(async (provider: string) => ({
      provider,
      authorizationUrl: `http://127.0.0.1:4911/api/admin/streaming/providers/${provider}/oauth/authorize?state=test-state`,
      expiresAt: "2026-08-11T12:10:00.000Z"
    }));

    renderDock({ startStreamingOAuth: startOAuth as any });
    await screen.findByLabelText("Streaming controls");

    const copyYouTubeBtn = screen.getByRole("button", { name: "Copy YouTube login link" });
    expect(copyYouTubeBtn).toBeTruthy();
    expect(copyYouTubeBtn.hasAttribute("disabled")).toBe(false);

    const copyTikTokBtn = screen.getByRole("button", { name: "Copy TikTok login link" });
    expect(copyTikTokBtn).toBeTruthy();
    expect(copyTikTokBtn.hasAttribute("disabled")).toBe(true);

    fireEvent.click(copyYouTubeBtn);
    await waitFor(() => expect(startOAuth).toHaveBeenCalledWith("YOUTUBE"));
    await waitFor(() => expect(screen.getByText("YouTube login link copied to clipboard.")).toBeTruthy());
    expect(written).toBe("http://127.0.0.1:4911/api/admin/streaming/providers/YOUTUBE/oauth/authorize?state=test-state");
  });
});

function renderDockWith(active: boolean, apiOverrides: Partial<SpaceApiClient> = {}) {
  const view = renderDock(apiOverrides);
  const ui = (visible: boolean) => (
    <DockActiveContext.Provider value={visible}>
      <StreamingOverlayProvider active>
        <StreamingDock />
      </StreamingOverlayProvider>
    </DockActiveContext.Provider>
  );
  view.rerender(ui(active));
  return { ...view, ui };
}

describe("StreamingDock on the dock kit", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("exposes the sections as tabs with arrow-key navigation", async () => {
    renderDock();
    const tablist = await screen.findByRole("tablist", { name: "Streaming dock sections" });
    const tabs = within(tablist).getAllByRole("tab");
    expect(tabs.map((tab) => tab.textContent)).toEqual(["Overview", "Bot", "Memory", "Moderation", "Display", "Activity"]);
    expect(tabs.map((tab) => tab.getAttribute("aria-selected"))).toEqual(["true", "false", "false", "false", "false", "false"]);
    expect(tabs.map((tab) => tab.tabIndex)).toEqual([0, -1, -1, -1, -1, -1]);

    const panel = screen.getByRole("tabpanel");
    expect(panel.getAttribute("aria-labelledby")).toBe(tabs[0]!.id);
    expect(tabs[0]!.getAttribute("aria-controls")).toBe(panel.id);

    tabs[0]!.focus();
    fireEvent.keyDown(tabs[0]!, { key: "ArrowRight" });
    expect(screen.getByRole("tab", { name: "Bot" }).getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(screen.getByRole("tab", { name: "Bot" }));

    fireEvent.keyDown(document.activeElement!, { key: "End" });
    expect(screen.getByRole("tab", { name: "Activity" }).getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(document.activeElement!, { key: "ArrowRight" });
    expect(screen.getByRole("tab", { name: "Overview" }).getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(document.activeElement!, { key: "ArrowLeft" });
    expect(screen.getByRole("tab", { name: "Activity" }).getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(document.activeElement!, { key: "Home" });
    expect(document.activeElement).toBe(screen.getByRole("tab", { name: "Overview" }));
    expect(screen.getByRole("tabpanel").getAttribute("aria-labelledby")).toBe(screen.getByRole("tab", { name: "Overview" }).id);
    expect(screen.queryByRole("heading", { name: "Streaming" })).toBeNull();
  });

  it("asks before removing an account or disconnecting an authorization", async () => {
    const nativeConfirm = vi.fn(() => true);
    vi.stubGlobal("confirm", nativeConfirm);
    const { api } = renderDock();
    await screen.findByLabelText("Streaming controls");
    fireEvent.click(screen.getByRole("button", { name: "Expand YouTube" }));
    expect(screen.getByText("@channel-one · Active")).toBeTruthy();
    expect(screen.getByText("1 account · Active")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Remove account" }));
    const removeDialog = screen.getByRole("alertdialog", { name: "Remove Channel One?" });
    fireEvent.click(within(removeDialog).getByRole("button", { name: "Cancel" }));
    expect(api.removeStreamingAccount).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Remove account" }));
    fireEvent.click(within(screen.getByRole("alertdialog", { name: "Remove Channel One?" })).getByRole("button", { name: "Remove account" }));
    await waitFor(() => expect(api.removeStreamingAccount).toHaveBeenCalledWith("streaming_account:youtube"));
    expect(await screen.findByText("Channel One was removed.")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Disconnect authorization" }));
    const disconnectDialog = screen.getByRole("alertdialog", { name: "Disconnect YouTube?" });
    fireEvent.click(within(disconnectDialog).getByRole("button", { name: "Cancel" }));
    expect(api.disconnectStreamingAuthorization).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Disconnect authorization" }));
    fireEvent.click(within(screen.getByRole("alertdialog", { name: "Disconnect YouTube?" })).getByRole("button", { name: "Disconnect" }));
    await waitFor(() => expect(api.disconnectStreamingAuthorization).toHaveBeenCalledWith("streaming_authorization:youtube"));
    expect(nativeConfirm).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("asks before deleting a memory entry", async () => {
    const entry = {
      id: "streaming_memory:schedule",
      title: "Stream schedule",
      body: "Live every Friday at 20:00.",
      status: "APPROVED" as const,
      source: "OPERATOR" as const,
      version: 2,
      createdAt: "2026-08-11T12:00:00.000Z",
      updatedAt: "2026-08-11T12:00:00.000Z"
    };
    const deleteMemory = vi.fn(async () => ({ deleted: true }));
    renderDock({
      streamingBotMemory: vi.fn(async () => ({ entries: [entry] })) as unknown as SpaceApiClient["streamingBotMemory"],
      deleteStreamingBotMemory: deleteMemory as unknown as SpaceApiClient["deleteStreamingBotMemory"]
    });
    await screen.findByLabelText("Streaming controls");
    fireEvent.click(screen.getByRole("tab", { name: "Memory" }));
    expect(await screen.findByText("Stream schedule")).toBeTruthy();
    expect(screen.getByText("Approved", { selector: ".dock-kit-badge" })).toBeTruthy();
    expect(screen.getByText(/Added by you/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Delete Stream schedule" }));
    fireEvent.click(within(screen.getByRole("alertdialog", { name: "Delete this memory?" })).getByRole("button", { name: "Cancel" }));
    expect(deleteMemory).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Delete Stream schedule" }));
    fireEvent.click(within(screen.getByRole("alertdialog", { name: "Delete this memory?" })).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(deleteMemory).toHaveBeenCalledWith(entry.id));
    expect(await screen.findByText("Memory deleted.")).toBeTruthy();
  });

  it("points an empty overlay layout to the Overview tab", async () => {
    renderDock({
      streamingCatalog: vi.fn(async () => ({ ...structuredClone(catalog), settings: { ...settings, tiles: [] } })) as SpaceApiClient["streamingCatalog"]
    });
    await screen.findByLabelText("Streaming controls");
    fireEvent.click(screen.getByRole("tab", { name: "Display" }));
    expect(screen.getByText("No overlay tiles yet")).toBeTruthy();
    expect(screen.getByText("Turn on metrics in the Overview tab to build the overlay.")).toBeTruthy();
    expect(screen.queryByText(/Select metrics above/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Go to Overview" }));
    expect(screen.getByRole("tab", { name: "Overview" }).getAttribute("aria-selected")).toBe("true");
  });

  it("shows one consistent save status from unsaved to saved", async () => {
    const { api } = renderDock();
    await screen.findByLabelText("Streaming controls");
    fireEvent.click(screen.getByRole("switch", { name: "Rooms" }));
    expect(screen.getByText("Unsaved overlay changes")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Save now" })).toBeTruthy();
    expect(await screen.findByText("Overlay changes saved.")).toBeTruthy();
    expect(api.updateStreamingOverlaySettings).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("Unsaved overlay changes")).toBeNull();
    expect(screen.queryByRole("button", { name: "Save changes" })).toBeNull();
  });

  it("shows a retryable error state when the catalog cannot load", async () => {
    let attempts = 0;
    renderDock({
      streamingCatalog: vi.fn(async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("Streaming service is offline.");
        return structuredClone(catalog);
      }) as SpaceApiClient["streamingCatalog"]
    });
    const failure = await screen.findByRole("alert");
    expect(failure.textContent).toContain("Streaming integrations could not be loaded");
    expect(failure.textContent).toContain("Streaming service is offline.");
    fireEvent.click(within(failure).getByRole("button", { name: "Try again" }));
    expect(await screen.findByLabelText("Streaming controls")).toBeTruthy();
  });

  it("reloads on window focus only while visible and pauses the draft preview while hidden", async () => {
    const { api, rerender, ui } = renderDockWith(true);
    await screen.findByLabelText("Streaming controls");
    const catalogReads = () => (api.streamingCatalog as ReturnType<typeof vi.fn>).mock.calls.length;
    const snapshotReads = () => (api.streamingOverlaySnapshot as ReturnType<typeof vi.fn>).mock.calls.length;

    const visibleBefore = catalogReads();
    act(() => { window.dispatchEvent(new Event("focus")); });
    await waitFor(() => expect(catalogReads()).toBe(visibleBefore + 1));

    fireEvent.click(screen.getByRole("tab", { name: "Display" }));
    fireEvent.click(screen.getByRole("switch", { name: "Draft preview" }));
    await waitFor(() => expect(snapshotReads()).toBeGreaterThanOrEqual(1));

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    rerender(ui(false));
    const hiddenCatalog = catalogReads();
    const hiddenSnapshots = snapshotReads();
    act(() => { window.dispatchEvent(new Event("focus")); });
    await act(async () => { vi.advanceTimersByTime(60_000); });
    expect(catalogReads()).toBe(hiddenCatalog);
    expect(snapshotReads()).toBe(hiddenSnapshots);
    // The preview stays requested and resumes when the dock is visible again.
    expect((screen.getByRole("switch", { name: "Draft preview" }) as HTMLInputElement).checked).toBe(true);

    vi.useRealTimers();
    rerender(ui(true));
    await waitFor(() => expect(snapshotReads()).toBeGreaterThan(hiddenSnapshots));
    await waitFor(() => expect(catalogReads()).toBeGreaterThan(hiddenCatalog));
  });

  it("shows readable bot labels and a consistent save status in the Bot tab", async () => {
    const botSettings = {
      version: 4,
      enabled: false,
      persona: { name: "Live Assistant", tone: "Friendly" },
      platforms: { YOUTUBE: { enabled: false, accountId: null }, TWITCH: { enabled: false, accountId: null } },
      facts: [],
      faq: [],
      instructions: "",
      guardrails: { cooldownSeconds: 15, maxRepliesPerMinute: 5, replyToQuestionsOnly: true },
      modelSelection: null,
      fallbackModelSelection: null,
      memoryEnabled: true,
      moderationEnabled: false,
      jevEnabled: false,
      overlayTickerEnabled: false,
      updatedAt: "2026-08-11T12:00:00.000Z",
      updatedBy: null
    };
    const updateBot = vi.fn(async (input: Record<string, unknown>) => ({ ...botSettings, ...input, version: 5 }));
    renderDock({
      streamingBotSettings: vi.fn(async () => ({ settings: structuredClone(botSettings), memoryCount: 1 })) as unknown as SpaceApiClient["streamingBotSettings"],
      streamingBotStatus: vi.fn(async () => ({
        enabled: false,
        paused: true,
        llmConfigured: false,
        model: null,
        youtubeQuota: { day: "2026-08-11", unitsConsumed: 0, budget: 8000 },
        platforms: {
          YOUTUBE: { connected: true, live: false, chatId: null, lastPollAt: null, lastReplyAt: null, pendingCount: 0 },
          TWITCH: { connected: false, live: false, chatId: null, lastPollAt: null, lastReplyAt: null, pendingCount: 0 }
        }
      })) as unknown as SpaceApiClient["streamingBotStatus"],
      streamingBotModels: vi.fn(async () => ({ models: [] })) as unknown as SpaceApiClient["streamingBotModels"],
      updateStreamingBotSettings: updateBot as unknown as SpaceApiClient["updateStreamingBotSettings"]
    });
    await screen.findByLabelText("Streaming controls");
    fireEvent.click(screen.getByRole("tab", { name: "Bot" }));
    expect(await screen.findByRole("switch", { name: "Fast message screening" })).toBeTruthy();
    expect(screen.queryByText(/Jev/)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Add fact" }));
    expect(screen.getByText("Unsaved bot settings")).toBeTruthy();
    const factKey = screen.getByRole("textbox", { name: "Fact key 1" });
    factKey.focus();
    fireEvent.change(factKey, { target: { value: "Schedule" } });
    // The row keeps its input while typing, so focus stays in the field.
    expect(screen.getByRole("textbox", { name: "Fact key 1" })).toBe(factKey);

    fireEvent.click(screen.getByRole("button", { name: "Save now" }));
    expect(await screen.findByText("Bot settings saved.")).toBeTruthy();
    expect(updateBot).toHaveBeenCalledWith(expect.objectContaining({ expectedVersion: 4, facts: [{ key: "Schedule", value: "" }] }));
    expect(screen.queryByText("Unsaved bot settings")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Remove fact 1" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(screen.getByText("Unsaved bot settings")).toBeTruthy();
  });
});

const upgradeBotSettings = {
  version: 4,
  enabled: true,
  persona: { name: "Live Assistant", tone: "Friendly" },
  platforms: { YOUTUBE: { enabled: true, accountId: "streaming_account:youtube" }, TWITCH: { enabled: false, accountId: null } },
  facts: [],
  faq: [],
  instructions: "",
  guardrails: { cooldownSeconds: 15, maxRepliesPerMinute: 5, replyToQuestionsOnly: true },
  modelSelection: null,
  fallbackModelSelection: null,
  memoryEnabled: true,
  moderationEnabled: true,
  jevEnabled: false,
  overlayTickerEnabled: false,
  updatedAt: "2026-08-11T12:00:00.000Z",
  updatedBy: null
};

function upgradeBotStatus(enabled: boolean) {
  return {
    enabled,
    paused: !enabled,
    llmConfigured: true,
    model: "gpt-6-mini",
    youtubeQuota: { day: "2026-08-11", unitsConsumed: 0, budget: 8000 },
    platforms: {
      YOUTUBE: { connected: true, live: false, chatId: null, lastPollAt: null, lastReplyAt: null, pendingCount: 0 },
      TWITCH: { connected: false, live: false, chatId: null, lastPollAt: null, lastReplyAt: null, pendingCount: 0 }
    },
    moderationEnabled: true,
    memoryPending: 2,
    setup: [
      { id: "llm-key", label: "Language model key", ok: true, hint: null },
      { id: "llm-models", label: "Space Gateway models verified", ok: false, hint: "Verify the Space Gateway provider." },
      { id: "worker", label: "Bot worker on this instance", ok: true, hint: null }
    ]
  };
}

function botApi(overrides: Partial<SpaceApiClient> = {}): Partial<SpaceApiClient> {
  return {
    streamingBotSettings: vi.fn(async () => ({ settings: structuredClone(upgradeBotSettings), memoryCount: 1 })) as unknown as SpaceApiClient["streamingBotSettings"],
    streamingBotStatus: vi.fn(async () => upgradeBotStatus(true)) as unknown as SpaceApiClient["streamingBotStatus"],
    streamingBotModels: vi.fn(async () => ({ models: [] })) as unknown as SpaceApiClient["streamingBotModels"],
    ...overrides
  };
}

describe("StreamingDock upgrades", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("shows bot, moderation and memory at a glance and opens their tabs", async () => {
    renderDock(botApi({ streamingBotMemory: vi.fn(async () => ({ entries: [] })) as unknown as SpaceApiClient["streamingBotMemory"] }));
    const strip = await screen.findByRole("navigation", { name: "Chat companion status" });
    expect(within(strip).getByText("Setup 2/3")).toBeTruthy();
    expect(within(strip).getByText("On")).toBeTruthy();
    fireEvent.click(within(strip).getByText("2 pending"));
    expect(screen.getByRole("tab", { name: "Memory" }).getAttribute("aria-selected")).toBe("true");
  });

  it("keeps an unsaved bot draft across tab switches and Pause, and lists the setup steps", async () => {
    let active = true;
    const pause = vi.fn(async () => { active = false; return { ...upgradeBotSettings, enabled: false, version: 5 }; });
    renderDock(botApi({
      pauseStreamingBot: pause as unknown as SpaceApiClient["pauseStreamingBot"],
      streamingBotStatus: vi.fn(async () => upgradeBotStatus(active)) as unknown as SpaceApiClient["streamingBotStatus"]
    }));
    await screen.findByLabelText("Streaming controls");
    fireEvent.click(screen.getByRole("tab", { name: "Bot" }));
    expect(await screen.findByText("Space Gateway models verified")).toBeTruthy();
    expect(screen.getByText("Verify the Space Gateway provider.")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Add fact" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Fact key 1" }), { target: { value: "Schedule" } });
    fireEvent.click(screen.getByRole("tab", { name: "Overview" }));
    fireEvent.click(screen.getByRole("tab", { name: "Bot" }));
    expect((screen.getByRole("textbox", { name: "Fact key 1" }) as HTMLInputElement).value).toBe("Schedule");

    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    expect(await screen.findByText("Bot paused.")).toBeTruthy();
    expect(pause).toHaveBeenCalled();
    expect((screen.getByRole("textbox", { name: "Fact key 1" }) as HTMLInputElement).value).toBe("Schedule");
    expect(screen.getByText("Unsaved bot settings")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Resume" })).toBeTruthy();
  });

  it("explains a client file problem with its fix", async () => {
    const insecure = structuredClone(catalog);
    insecure.providers[1] = { ...insecure.providers[1]!, status: "ERROR", clientFilePresent: true, code: "CLIENT_FILE_PERMISSIONS",
      message: "/opt/spaceapp/var/streaming-secrets/twitch-client.json (mode 0644) belongs to another user; run: sudo chown space:space x && sudo chmod 600 x" };
    renderDock({ streamingCatalog: vi.fn(async () => structuredClone(insecure)) as SpaceApiClient["streamingCatalog"] });
    await screen.findByLabelText("Streaming controls");
    expect(screen.getByText("Client credentials file needs owner-only permissions")).toBeTruthy();
    const connect = screen.getAllByRole("button", { name: "Connect" }).find((button) => button.getAttribute("title")?.includes("owner-only"));
    expect(connect?.hasAttribute("disabled")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Expand Twitch" }));
    expect(screen.getByText(/sudo chown space:space/)).toBeTruthy();
  });

  it("keeps provider buttons usable while the overlay autosaves", async () => {
    let finishSave: (() => void) | null = null;
    const update = vi.fn((input: { tiles: unknown }) => new Promise((resolve) => {
      finishSave = () => resolve({ ...settings, version: 4, tiles: input.tiles });
    }));
    renderDock({ updateStreamingOverlaySettings: update as unknown as SpaceApiClient["updateStreamingOverlaySettings"] });
    await screen.findByLabelText("Streaming controls");
    fireEvent.click(screen.getByRole("switch", { name: "Rooms" }));
    await waitFor(() => expect(update).toHaveBeenCalled(), { timeout: 2000 });
    expect(screen.getByText("Saving overlay changes…")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Copy YouTube login link" }).hasAttribute("disabled")).toBe(false);
    await act(async () => { finishSave?.(); });
  });

  it("names moderated viewers and times out an item waiting for review", async () => {
    const review = {
      id: "moderation:review", platform: "TWITCH" as const, accountId: "account-1", channelId: "chat-1", userId: "viewer-1",
      messageId: "message-1", decision: "REVIEW" as const, reason: "AMBIGUOUS", durationSeconds: null, result: "REVIEW" as const,
      platformActionId: null, safeErrorCode: null, createdAt: "2026-08-11T12:00:00.000Z", updatedAt: "2026-08-11T12:00:00.000Z",
      author: "rude_viewer", message: "maybe rude", activityId: "activity:1"
    };
    const timeout = vi.fn(async () => ({ ...review, result: "SUCCEEDED", decision: "TIMEOUT_5M", durationSeconds: 300 }));
    renderDock({
      streamingModerationActions: vi.fn(async () => ({ actions: [review] })) as unknown as SpaceApiClient["streamingModerationActions"],
      timeoutStreamingModerationReview: timeout as unknown as SpaceApiClient["timeoutStreamingModerationReview"]
    });
    await screen.findByLabelText("Streaming controls");
    fireEvent.click(screen.getByRole("tab", { name: "Moderation" }));
    expect(await screen.findByText("maybe rude")).toBeTruthy();
    expect(screen.getByText(/rude_viewer/)).toBeTruthy();
    expect(screen.queryByText(/viewer-1/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Timeout 5 min" }));
    await waitFor(() => expect(timeout).toHaveBeenCalledWith("moderation:review", 300));
    expect(await screen.findByText("Viewer timed out for 5 minutes.")).toBeTruthy();
  });

  it("shows who wrote each chat message and times out a recent viewer", async () => {
    const message = {
      id: "activity:1", platform: "YOUTUBE" as const, accountId: "account-1", channelId: "chat-1", authorId: "viewer-1", messageId: "message-1",
      protectedAccount: false, direction: "IN" as const, author: "curious_viewer", message: "hello everyone", reply: null, status: "SKIPPED" as const,
      createdAt: new Date().toISOString()
    };
    const liveAction = vi.fn(async () => ({ ok: true, result: {} }));
    renderDock({
      streamingBotActivity: vi.fn(async () => ({ data: [message], pagination: { page: 1, pageSize: 1, totalItems: 1, totalPages: 1 } })) as unknown as SpaceApiClient["streamingBotActivity"],
      streamingLiveAction: liveAction as unknown as SpaceApiClient["streamingLiveAction"]
    });
    await screen.findByLabelText("Streaming controls");
    fireEvent.click(screen.getByRole("tab", { name: "Activity" }));
    expect(await screen.findByText(/curious_viewer/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Timeout 5 min" }));
    await waitFor(() => expect(liveAction).toHaveBeenCalledWith({ action: "TIMEOUT", activityId: "activity:1", durationSeconds: 300 }));
  });
});
