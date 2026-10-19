import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Pane, Room } from "@space/contracts";
import { buildRoomToolbarActions, OSK_PANEL_ID, type RoomToolbarActionsContext } from "../src/features/room-toolbar/room-toolbar-actions.js";
import { useToolbarPopovers, type ToolbarPopovers } from "../src/features/room-toolbar/useToolbarPopovers.js";

function popovers(): ToolbarPopovers {
  const flag = () => vi.fn();
  return {
    isThemeMenuOpen: false, setIsThemeMenuOpen: flag(), isPaneLayoutMenuOpen: false, setIsPaneLayoutMenuOpen: flag(),
    isCollapsedPaneLayoutMenuOpen: false, setIsCollapsedPaneLayoutMenuOpen: flag(), isPaneSpanAllMenuOpen: false, setIsPaneSpanAllMenuOpen: flag(),
    isWorkspaceTextSizePickerOpen: false, setIsWorkspaceTextSizePickerOpen: flag(), isCliLauncherOpen: false, setIsCliLauncherOpen: flag(),
    isChatLauncherOpen: false, setIsChatLauncherOpen: flag(), isVibeMusicOpen: true, setIsVibeMusicOpen: flag(), isOskKeyboardOpen: false,
    setIsOskKeyboardOpen: flag(), isQuickLinksOpen: false, setIsQuickLinksOpen: flag(), lowerRailVisibilityMenu: null, setLowerRailVisibilityMenu: flag(),
    boardToolbarRef: { current: null }, roomToolbarActionsRef: { current: null }, roomToolbarScrollRef: { current: null }, collapsedToolbarRef: { current: null },
    roomOverflowTriggerRef: { current: null }, cliLauncherButtonRef: { current: null }, chatLauncherButtonRef: { current: null },
    cliLauncherReturnFocusRef: { current: null }, workspaceTextSizeButtonRef: { current: null }, vibeMusicButtonRef: { current: null },
    quickLinksButtonRef: { current: null }, paneLayoutButtonRef: { current: null }, paneLayoutCollapsedButtonRef: { current: null },
    paneSpanAllButtonRef: { current: null }, roomThemeButtonRef: { current: null }, closePaneLayoutMenu: vi.fn(), closePaneSpanAllMenu: vi.fn()
  };
}

function context(overrides: Partial<RoomToolbarActionsContext> = {}): RoomToolbarActionsContext {
  const room = { id: "room:a", name: "Room A" } as Room;
  return {
    role: "USER",
    hasUser: true,
    shellMode: "desktop",
    docks: {
      sourceControlAvailable: false, sideSurfaceToggleLabel: (surface) => `Show ${surface}`, toggleSideSurface: vi.fn(),
      isSideSurfaceOpen: true, activeSideSurface: "rooms", hiddenDockIds: ["media"]
    },
    visibility: { isWidgetHidden: (id) => id !== "clock", isPaneHidden: () => false },
    popovers: popovers(),
    preferences: {
      cliFloatsHidden: false, toggleCliFloats: vi.fn(), maskSensitiveData: true, toggleMaskSensitiveData: vi.fn(), isRoomFocusMode: false,
      toggleRoomFocusMode: vi.fn(), isRoomToolbarHidden: false, terminalFontSize: 13
    },
    room: {
      activeRoom: room, selectedRoomId: room.id, panes: [{ id: "pane:1", mode: "TERMINAL" } as Pane], paneLayoutPending: false,
      setPaneLayoutError: vi.fn(), activeRoomCategoryFilter: null, activeRoomCategoryColors: [], cycleRoomCategoryColor: vi.fn()
    },
    create: {
      isCodexEnabled: true, cliPaneCreationPending: false, toggleChatLauncher: vi.fn(), toggleCliLauncher: vi.fn(), addRootAdminPane: vi.fn(async () => undefined),
      addPane: vi.fn(), addFilesPane: vi.fn(async () => undefined), addDatabasesPane: vi.fn(async () => undefined), addDemosPane: vi.fn(async () => undefined),
      addT3CodePane: vi.fn(async () => undefined), addJobApplyPane: vi.fn(async () => undefined), addMailCopilotPane: vi.fn(async () => undefined), addMarketingCopilotPane: vi.fn(async () => undefined), addFreelanceCopilotPane: vi.fn(async () => undefined), addDesignPane: vi.fn(async () => undefined), addLivePane: vi.fn(async () => null)
    },
    tools: {
      desktopWidgets: { isWidgetEnabled: () => false, toggleWidget: vi.fn() } as never, openStickyNote: vi.fn(), isBrowserFullscreen: false,
      snip: { isSnipToolOpen: false, setIsSnipToolOpen: vi.fn() }, captureRoomScreen: vi.fn(async () => undefined), reloadRoomWindow: vi.fn(async () => undefined),
      vpn: { toolbarVpnRoute: "nord", vpnCityPending: false, rotateVpnCityFromToolbar: vi.fn(async () => undefined) }
    },
    workspace: {
      isMemoryWorkspaceOpen: false, setIsMemoryWorkspaceOpen: vi.fn(), isSpaceGatewayOpen: false, setIsSpaceGatewayOpen: vi.fn(), setSystemAnalyticsTab: vi.fn(),
      agentsDashboardSummary: null,
      setIsAgentsDashboardOpen: vi.fn(), resourceIndicatorsVisible: true, toggleResourceIndicators: vi.fn(), isDebugModeActive: false,
      debugModePending: false, toggleDebugMode: vi.fn(async () => undefined), isDemoModeActive: false, setIsDemoModeActive: vi.fn(),
      setAdminModeRequested: vi.fn(), openHelp: vi.fn(), openBenchmark: vi.fn(), signOut: vi.fn(async () => undefined),
      isServerActionsMenuOpen: false, setIsServerActionsMenuOpen: vi.fn(),
      gatewayCompression: { mode: null, pending: false, request: vi.fn() }
    },
    ...overrides
  };
}

describe("buildRoomToolbarActions", () => {
  afterEach(() => cleanup());

  it("lists the default actions in order and leaves consolidated ones to the Workspace menu", () => {
    const ids = buildRoomToolbarActions(context()).map((action) => action.id);
    expect(ids.slice(0, 5)).toEqual(["surface-rooms", "surface-nous", "surface-notifications", "surface-room-agent", "surface-shared-chat"]);
    expect(ids).not.toContain("surface-media");
    expect(ids).not.toContain("surface-health");
    expect(ids).not.toContain("surface-streaming");
    expect(ids).toContain("widget-clock");
    expect(ids).not.toContain("widget-countdown-timer");
    expect(ids).not.toContain("add-root-admin-cli");
    expect(ids.at(-1)).toBe("more-actions");
    for (const consolidated of ["system-resources", "system-analytics", "token-usage", "system-services", "setup-connections"]) {
      expect(ids).not.toContain(consolidated);
    }
    expect(ids).not.toContain("space-gateway");
    const adminIds = buildRoomToolbarActions(context({ role: "ADMIN" })).map((action) => action.id);
    expect(adminIds).toEqual(expect.arrayContaining(["surface-streaming", "agents-dashboard", "add-root-admin-cli", "server-restart", "demo-mode", "advanced-settings", "space-gateway"]));
    // Space Gateway opens full screen next to the memory workspace, and the two never show together.
    expect(adminIds.indexOf("space-gateway")).toBe(adminIds.indexOf("memory-workspace") + 1);
  });

  it("opens Space Gateway full screen for admins, closing the memory workspace and analytics", () => {
    const ctx = context({ role: "ADMIN" });
    const gateway = buildRoomToolbarActions(ctx).find((action) => action.id === "space-gateway");
    expect(gateway).toMatchObject({ label: "Space Gateway", ariaExpanded: false });
    gateway!.onClick?.();
    expect(ctx.workspace.setIsSpaceGatewayOpen).toHaveBeenCalledWith(true);
    expect(ctx.workspace.setIsMemoryWorkspaceOpen).toHaveBeenCalledWith(false);
    expect(ctx.workspace.setSystemAnalyticsTab).toHaveBeenCalledWith(null);
    const memory = buildRoomToolbarActions(ctx).find((action) => action.id === "memory-workspace");
    memory!.onClick?.();
    expect(ctx.workspace.setIsSpaceGatewayOpen).toHaveBeenLastCalledWith(false);
  });

  it("offers context compression as an ADMIN quick toggle once the gateway mode is known", () => {
    const request = vi.fn();
    const base = context();
    const withMode = (role: string, mode: "ON" | "OFF" | null) => buildRoomToolbarActions({ ...base, role,
      workspace: { ...base.workspace, gatewayCompression: { mode, pending: false, request } } });
    const on = withMode("ADMIN", "ON").find((action) => action.id === "gateway-compression");
    expect(on).toMatchObject({ label: "Turn off context compression", ariaPressed: true });
    on!.onClick?.();
    expect(request).toHaveBeenCalledTimes(1);
    expect(withMode("ADMIN", "OFF").find((action) => action.id === "gateway-compression")).toMatchObject({ label: "Turn on context compression", ariaPressed: false });
    expect(withMode("ADMIN", null).some((action) => action.id === "gateway-compression")).toBe(false);
    expect(withMode("OPERATOR", "ON").some((action) => action.id === "gateway-compression")).toBe(false);
  });

  it("closes the rail popovers before opening a sticky note and toggles music alone", () => {
    const ctx = context();
    const actions = new Map(buildRoomToolbarActions(ctx).map((action) => [action.id, action]));
    actions.get("sticky-note")!.onClick();
    for (const setter of [ctx.popovers.setIsThemeMenuOpen, ctx.popovers.setIsPaneLayoutMenuOpen, ctx.popovers.setIsCollapsedPaneLayoutMenuOpen,
      ctx.popovers.setIsPaneSpanAllMenuOpen, ctx.popovers.setIsWorkspaceTextSizePickerOpen, ctx.popovers.setIsVibeMusicOpen]) {
      expect(setter).toHaveBeenCalledWith(false);
    }
    expect(ctx.popovers.setLowerRailVisibilityMenu).toHaveBeenCalledWith(null);
    expect(ctx.tools.openStickyNote).toHaveBeenCalledTimes(1);

    const music = actions.get("vibe-music")!;
    expect(music.ariaExpanded).toBe(true);
    music.onClick();
    expect(ctx.workspace.setIsServerActionsMenuOpen).toHaveBeenCalledWith(false);
    expect(ctx.popovers.setIsCliLauncherOpen).toHaveBeenCalledWith(false);
    expect(ctx.popovers.setIsVibeMusicOpen).toHaveBeenLastCalledWith(expect.any(Function));
  });

  it("reflects preferences, the VPN route and the keyboard panel", () => {
    const actions = new Map(buildRoomToolbarActions(context()).map((action) => [action.id, action]));
    expect(actions.get("sensitive-data")).toMatchObject({ label: "Show sensitive data", ariaPressed: true, hideable: false });
    expect(actions.get("font-down")).toMatchObject({ title: "Workspace text size: 13 px", disabled: false });
    expect(actions.get("vpn-city")).toMatchObject({ label: "Change NordVPN city", disabled: false });
    expect(actions.get("osk-keyboard")?.ariaControls).toBe(OSK_PANEL_ID);
    expect(actions.get("room-focus")).toMatchObject({ label: "Maximize room", disabled: false });
  });
});

describe("Room Agent attention in the toolbar", () => {
  it("marks the Room Agent dock button while something waits for the operator", () => {
    const quiet = buildRoomToolbarActions(context()).find((action) => action.id === "surface-room-agent")!;
    expect(quiet.className).toBe("toolbar-surface-toggle");
    expect(quiet.title).toBe("Show room-agent");
    const base = context();
    const busy = buildRoomToolbarActions({ ...base, docks: { ...base.docks, roomAgentAttention: 2 } }).find((action) => action.id === "surface-room-agent")!;
    expect(busy.className).toBe("toolbar-surface-toggle has-attention");
    expect(busy.title).toBe("Show room-agent · 2 need you");
    expect(busy.ariaLabel).toBe("Show room-agent");
    const other = buildRoomToolbarActions({ ...base, docks: { ...base.docks, roomAgentAttention: 2 } }).find((action) => action.id === "surface-rooms")!;
    expect(other.className).toBe("toolbar-surface-toggle");
  });
});

describe("useToolbarPopovers", () => {
  afterEach(() => cleanup());

  it("returns focus to the trigger after closing the layout and span menus", async () => {
    const { result } = renderHook(() => useToolbarPopovers());
    const layoutTrigger = document.createElement("button");
    const spanTrigger = document.createElement("button");
    document.body.append(layoutTrigger, spanTrigger);
    result.current.paneLayoutButtonRef.current = layoutTrigger;
    result.current.paneSpanAllButtonRef.current = spanTrigger;
    act(() => { result.current.setIsPaneLayoutMenuOpen(true); result.current.setIsPaneSpanAllMenuOpen(true); });
    act(() => result.current.closePaneLayoutMenu());
    await act(async () => { await new Promise((resolve) => window.requestAnimationFrame(() => resolve(undefined))); });
    expect(result.current.isPaneLayoutMenuOpen).toBe(false);
    expect(document.activeElement).toBe(layoutTrigger);
    act(() => result.current.closePaneSpanAllMenu(false));
    await act(async () => { await new Promise((resolve) => window.requestAnimationFrame(() => resolve(undefined))); });
    expect(result.current.isPaneSpanAllMenuOpen).toBe(false);
    expect(document.activeElement).toBe(layoutTrigger);
    layoutTrigger.remove();
    spanTrigger.remove();
  });
});
