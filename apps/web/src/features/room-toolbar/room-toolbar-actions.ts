import type { Room } from "@space/contracts";
import type { AgentDashboardSummary } from "../agents-dashboard/dashboard-model.js";
import type { SystemAnalyticsTab } from "../system-analytics/SystemAnalyticsWorkspace.js";
import { sideSurfaceMeta } from "../docks/side-surface-meta.js";
import type { SideSurface } from "../docks/dock-types.js";
import type { SideSurfaces } from "../docks/useSideSurfaces.js";
import type { useDesktopWidgets, useWidgetsVisibility } from "../desktop-widgets/index.js";
import type { usePanesVisibility } from "../pane-visibility/use-panes-visibility.js";
import { toggleBrowserFullscreen } from "../desktop-titlebar/fullscreen.js";
import type { PaneCategoryColor } from "@space/contracts";
import type { ShellMode } from "../pane-grid/pane-grid-layout.js";
import { ROOM_THEME_MENU_ID } from "../room-theme/RoomThemeMenu.js";
import { consolidatedManageActions, consolidatedResourceActions, openManage } from "../server-actions/manage-navigation.js";
import type { SnipTool } from "../snip-tool/useSnipTool.js";
import { openSystemHealth, openSystemResources } from "../system-health/health-model.js";
import { CHAT_LAUNCHER_MENU_ID, CLI_LAUNCHER_MENU_ID, PANE_LAYOUT_MENU_ID, SERVER_ACTIONS_MENU_ID } from "../toolbar-menu-ids.js";
import type { ToolbarVpn } from "../toolbar-vpn/useToolbarVpn.js";
import type { UserPreferences } from "../user-settings/useUserPreferences.js";
import { VIBE_MUSIC_PANEL_ID } from "../vibe-music/vibe-music-session.js";
import { WORKSPACE_TEXT_SIZE_PICKER_ID } from "../workspace-text-size-picker/WorkspaceTextSizePicker.js";
import type { IconToolbarAction } from "../../icon-toolbar.js";
import type { Pane } from "@space/contracts";
import {
  ALargeSmall, Activity, Camera, CircleHelp, Clock3, Cpu, Crop, Crosshair, Database, Dumbbell, Eye, EyeOff,
  Gauge, Globe, Keyboard, LayoutDashboard, ListFilter, LogOut, Maximize2, Minimize2,
  Monitor, MoreHorizontal, Music2, Network, Palette, PanelsTopLeft, Radio, RefreshCw, Rocket, ServerCog, Settings,
  ShieldCheck, Shrink, SlidersHorizontal, Sparkles, Star, StickyNote, Terminal, Timer,
  Brain, Router, Bug, Server, CliFloats, Maximize, Minimize
} from "../ui-theme/app-icons.js";
import { modeIcons } from "../pane-card/pane-mode-icons.js";
import type { ToolbarPopovers } from "./useToolbarPopovers.js";
import { serverModuleOn } from "../pane-visibility/server-modules.js";

// The room toolbar's action catalog, in its default order. Users can hide and
// reorder these; the Workspace menu, rails and overflow menus reuse them.

export const OSK_PANEL_ID = "space-osk-keyboard";

export interface RoomToolbarActionsContext {
  /** `auth?.user?.role`; admin actions are listed only for admins. */
  role: string | undefined;
  /** A signed-in user exists (resource indicators). */
  hasUser: boolean;
  shellMode: ShellMode;
  docks: Pick<SideSurfaces, "sourceControlAvailable" | "sideSurfaceToggleLabel" | "toggleSideSurface" | "isSideSurfaceOpen" | "activeSideSurface"> & {
    hiddenDockIds: string[];
    /** Questions and problems across all rooms that wait for the operator in the Room Agent. */
    roomAgentAttention?: number;
    notificationAttention?: number;
  };
  visibility: {
    isWidgetHidden(id: Parameters<ReturnType<typeof useWidgetsVisibility>["isWidgetHidden"]>[0]): boolean;
    isPaneHidden(id: Parameters<ReturnType<typeof usePanesVisibility>["isPaneHidden"]>[0]): boolean;
  };
  popovers: ToolbarPopovers;
  preferences: Pick<UserPreferences, "cliFloatsHidden" | "toggleCliFloats" | "maskSensitiveData" | "toggleMaskSensitiveData" | "isRoomFocusMode" | "toggleRoomFocusMode" | "isRoomToolbarHidden" | "terminalFontSize">;
  room: {
    activeRoom: Room | null;
    selectedRoomId: string | null;
    panes: Pane[];
    paneLayoutPending: boolean;
    setPaneLayoutError: (error: string | null) => void;
    activeRoomCategoryFilter: PaneCategoryColor | null;
    activeRoomCategoryColors: PaneCategoryColor[];
    cycleRoomCategoryColor: (roomId: string, deltaY: number) => void;
  };
  create: {
    isCodexEnabled: boolean;
    cliPaneCreationPending: boolean;
    toggleChatLauncher: () => void;
    toggleCliLauncher: () => void;
    addRootAdminPane: () => Promise<void>;
    addPane: (mode: Pane["mode"]) => unknown;
    addFilesPane: () => Promise<void>;
    addDatabasesPane: () => Promise<void>;
    addDemosPane: () => Promise<void>;
    addT3CodePane: () => Promise<void>;
    addJobApplyPane: () => Promise<void>;
    addMailCopilotPane: () => Promise<void>;
    addMarketingCopilotPane: () => Promise<void>;
    addFreelanceCopilotPane: () => Promise<void>;
    addLivePane: () => Promise<unknown>;
  };
  tools: {
    desktopWidgets: Pick<ReturnType<typeof useDesktopWidgets>, "isWidgetEnabled" | "toggleWidget">;
    openStickyNote: () => void;
    isBrowserFullscreen: boolean;
    snip: Pick<SnipTool, "isSnipToolOpen" | "setIsSnipToolOpen">;
    captureRoomScreen: () => Promise<void>;
    reloadRoomWindow: () => Promise<void>;
    vpn: Pick<ToolbarVpn, "toolbarVpnRoute" | "vpnCityPending" | "rotateVpnCityFromToolbar">;
  };
  workspace: {
    isMemoryWorkspaceOpen: boolean;
    setIsMemoryWorkspaceOpen: (open: boolean) => void;
    /** Space Gateway as a full-screen workspace page (ADMIN), next to the memory workspace. */
    isSpaceGatewayOpen: boolean;
    setIsSpaceGatewayOpen: (open: boolean) => void;
    setSystemAnalyticsTab: (tab: SystemAnalyticsTab | null) => void;
    agentsDashboardSummary: AgentDashboardSummary | null;
    setIsAgentsDashboardOpen: (open: boolean) => void;
    resourceIndicatorsVisible: boolean;
    toggleResourceIndicators: () => void;
    isDebugModeActive: boolean;
    debugModePending: boolean;
    toggleDebugMode: () => Promise<void>;
    /** Space Gateway context compression (ADMIN): null hides the toggle until the mode is known. */
    gatewayCompression: { mode: "ON" | "OFF" | null; pending: boolean; request: () => void };
    isDemoModeActive: boolean;
    setIsDemoModeActive: (active: boolean) => void;
    setAdminModeRequested: (requested: boolean) => void;
    openHelp: () => void;
    openBenchmark: () => void;
    signOut: () => Promise<void>;
    isServerActionsMenuOpen: boolean;
    setIsServerActionsMenuOpen: (open: boolean) => void;
  };
}

export function buildRoomToolbarActions(context: RoomToolbarActionsContext): IconToolbarAction[] {
  const { role, hasUser, shellMode } = context;
  const { sourceControlAvailable, sideSurfaceToggleLabel, toggleSideSurface, isSideSurfaceOpen, activeSideSurface, hiddenDockIds } = context.docks;
  const { isWidgetHidden, isPaneHidden } = context.visibility;
  const {
    isQuickLinksOpen, setIsQuickLinksOpen, isVibeMusicOpen, setIsVibeMusicOpen, isThemeMenuOpen, setIsThemeMenuOpen,
    isPaneLayoutMenuOpen, setIsPaneLayoutMenuOpen, setIsCollapsedPaneLayoutMenuOpen, setIsPaneSpanAllMenuOpen,
    isWorkspaceTextSizePickerOpen, setIsWorkspaceTextSizePickerOpen, setLowerRailVisibilityMenu, isChatLauncherOpen,
    isCliLauncherOpen, setIsCliLauncherOpen, isOskKeyboardOpen, setIsOskKeyboardOpen
  } = context.popovers;
  const { cliFloatsHidden, toggleCliFloats, maskSensitiveData, toggleMaskSensitiveData, isRoomFocusMode, toggleRoomFocusMode, isRoomToolbarHidden, terminalFontSize } = context.preferences;
  const { activeRoom, selectedRoomId, panes, paneLayoutPending, setPaneLayoutError, activeRoomCategoryFilter, activeRoomCategoryColors, cycleRoomCategoryColor } = context.room;
  const { isCodexEnabled, cliPaneCreationPending, toggleChatLauncher, toggleCliLauncher, addRootAdminPane, addPane, addFilesPane, addDatabasesPane, addDemosPane, addT3CodePane, addJobApplyPane, addMailCopilotPane, addMarketingCopilotPane, addFreelanceCopilotPane, addLivePane } = context.create;
  const { desktopWidgets, openStickyNote, isBrowserFullscreen, captureRoomScreen, reloadRoomWindow } = context.tools;
  const { isSnipToolOpen, setIsSnipToolOpen } = context.tools.snip;
  const { toolbarVpnRoute, vpnCityPending, rotateVpnCityFromToolbar } = context.tools.vpn;
  const {
    isMemoryWorkspaceOpen, setIsMemoryWorkspaceOpen, isSpaceGatewayOpen, setIsSpaceGatewayOpen, setSystemAnalyticsTab, agentsDashboardSummary,
    setIsAgentsDashboardOpen, resourceIndicatorsVisible, toggleResourceIndicators, isDebugModeActive, debugModePending, toggleDebugMode, isDemoModeActive,
    setIsDemoModeActive, setAdminModeRequested, openHelp, openBenchmark, signOut, isServerActionsMenuOpen, setIsServerActionsMenuOpen,
    gatewayCompression
  } = context.workspace;
  const actions: IconToolbarAction[] = [
  ...(Object.entries(sideSurfaceMeta) as Array<[SideSurface, (typeof sideSurfaceMeta)[SideSurface]]>)
    .filter(([surface]) => surface !== "health" && (surface !== "streaming" || role === "ADMIN") && (surface !== "source-control" || sourceControlAvailable) && !hiddenDockIds.includes(surface))
    .map(([surface, meta]) => {
      const label = sideSurfaceToggleLabel(surface);
      const attention = surface === "room-agent" ? context.docks.roomAgentAttention ?? 0 : surface === "notifications" ? context.docks.notificationAttention ?? 0 : 0;
      return {
        id: `surface-${surface}`,
        label,
        title: attention ? (surface === "notifications" ? `${label} · ${attention} unread` : `${label} · ${attention} need${attention === 1 ? "s" : ""} you`) : label,
        ariaLabel: label,
        icon: meta.icon,
        onClick: () => toggleSideSurface(surface),
        ariaPressed: isSideSurfaceOpen && activeSideSurface === surface,
        className: attention ? "toolbar-surface-toggle has-attention" : "toolbar-surface-toggle"
      };
    }),
  {
    id: "memory-workspace",
    label: "Open memory workspace",
    title: "Open memory workspace",
    ariaLabel: "Open memory workspace",
    icon: Brain,
    onClick: () => {
      setSystemAnalyticsTab(null);
      setIsSpaceGatewayOpen(false);
      setIsMemoryWorkspaceOpen(true);
    },
    ariaExpanded: isMemoryWorkspaceOpen
  },
  // Space Gateway opens full screen like the memory workspace (operator request 2026-10-13); it left the Manage menu.
  ...(role === "ADMIN" ? [{
    id: "space-gateway",
    label: "Space Gateway",
    title: "Open Space Gateway full screen: pooled accounts, API keys, request logs, routing and compression",
    ariaLabel: "Space Gateway",
    icon: Router,
    onClick: () => {
      setSystemAnalyticsTab(null);
      setIsMemoryWorkspaceOpen(false);
      setIsSpaceGatewayOpen(true);
    },
    ariaExpanded: isSpaceGatewayOpen
  }] : []),
  {
    id: "quick-links",
    label: "Quick Links",
    title: "Quick Links",
    ariaLabel: "Quick Links",
    icon: Star,
    onClick: () => {
      setIsVibeMusicOpen(false);
      setIsQuickLinksOpen((current) => !current);
    },
    ariaExpanded: isQuickLinksOpen,
    ariaHasPopup: "dialog"
  },
  {
    id: "sticky-note",
    label: "Sticky note",
    title: "Sticky note",
    ariaLabel: "Sticky note",
    icon: StickyNote,
    onClick: () => {
      setIsThemeMenuOpen(false);
      setIsPaneLayoutMenuOpen(false);
      setIsCollapsedPaneLayoutMenuOpen(false);
      setIsPaneSpanAllMenuOpen(false);
      setIsWorkspaceTextSizePickerOpen(false);
      setIsVibeMusicOpen(false);
      setLowerRailVisibilityMenu(null);
      openStickyNote();
    }
  },
  ...(!isWidgetHidden("clock")
    ? [
        {
          id: "widget-clock",
          label: "Clock widget",
          title: "Float Clock widget",
          ariaLabel: "Clock widget",
          icon: Clock3,
          ariaPressed: desktopWidgets.isWidgetEnabled("clock"),
          onClick: () => {
            desktopWidgets.toggleWidget("clock");
          }
        }
      ]
    : []),
  ...(!isWidgetHidden("countdown-timer")
    ? [
        {
          id: "widget-countdown-timer",
          label: "Countdown timer",
          title: "Float Countdown Timer widget",
          ariaLabel: "Countdown timer",
          icon: Timer,
          ariaPressed: desktopWidgets.isWidgetEnabled("countdown-timer"),
          onClick: () => {
            desktopWidgets.toggleWidget("countdown-timer");
          }
        }
      ]
    : []),
  ...(!isWidgetHidden("pushup-reminder")
    ? [
        {
          id: "widget-pushup-reminder",
          label: "Push-up reminder",
          title: "Float Push-up Reminder widget",
          ariaLabel: "Push-up reminder",
          icon: Dumbbell,
          ariaPressed: desktopWidgets.isWidgetEnabled("pushup-reminder"),
          onClick: () => {
            desktopWidgets.toggleWidget("pushup-reminder");
          }
        }
      ]
    : []),
  ...(!isWidgetHidden("spaceapp-promo")
    ? [
        {
          id: "widget-spaceapp-promo",
          label: "SpaceApp.dev promo",
          title: "Float SpaceApp.dev promo widget",
          ariaLabel: "SpaceApp.dev promo",
          icon: Rocket,
          ariaPressed: desktopWidgets.isWidgetEnabled("spaceapp-promo"),
          onClick: () => {
            desktopWidgets.toggleWidget("spaceapp-promo");
          }
        }
      ]
    : []),
  ...(!isWidgetHidden("streaming-metrics")
    ? [
        {
          id: "widget-streaming-metrics",
          label: "Streaming metrics",
          title: "Float Streaming Metrics widget",
          ariaLabel: "Streaming metrics widget",
          icon: Radio,
          ariaPressed: desktopWidgets.isWidgetEnabled("streaming-metrics"),
          onClick: () => {
            desktopWidgets.toggleWidget("streaming-metrics");
          }
        }
      ]
    : []),
  ...(!isWidgetHidden("ai-quota")
    ? [
        {
          id: "widget-ai-quota",
          label: "AI Quota & Usage",
          title: "Float AI Quota & Usage: account availability and reset alerts for Codex, Antigravity and Claude",
          ariaLabel: "AI Quota & Usage",
          icon: Gauge,
          ariaPressed: desktopWidgets.isWidgetEnabled("ai-quota"),
          onClick: () => {
            desktopWidgets.toggleWidget("ai-quota");
          }
        }
      ]
    : []),
  {
    id: "pane-layout",
    label: "Pane layout",
    title: "Pane layout",
    ariaLabel: "Pane layout",
    icon: PanelsTopLeft,
    onClick: () => {
      setPaneLayoutError(null);
      if (isRoomToolbarHidden) {
        setIsCollapsedPaneLayoutMenuOpen((current) => !current);
      } else {
        setIsPaneLayoutMenuOpen((current) => !current);
      }
    },
    ariaControls: PANE_LAYOUT_MENU_ID,
    ariaExpanded: isPaneLayoutMenuOpen,
    ariaHasPopup: "menu",
    disabled: !activeRoom || paneLayoutPending
  },
  {
    id: "theme",
    label: "Room theme",
    title: "Room theme",
    ariaLabel: "Room theme",
    icon: Palette,
    onClick: () => setIsThemeMenuOpen((current) => !current),
    ariaControls: ROOM_THEME_MENU_ID,
    ariaExpanded: isThemeMenuOpen,
    ariaHasPopup: "menu",
    disabled: !activeRoom
  },
  {
    id: "category-color-filter",
    label: activeRoomCategoryFilter
      ? `Filter panes by color: ${activeRoomCategoryFilter}`
      : "Filter panes by color",
    title: activeRoomCategoryFilter
      ? `Filter panes by color: ${activeRoomCategoryFilter}. Scroll over the icon to cycle colors.`
      : "Filter panes by color. Scroll over the icon to cycle colors.",
    ariaLabel: activeRoomCategoryFilter
      ? `Color filter: ${activeRoomCategoryFilter}`
      : "Color filter: off",
    icon: ListFilter,
    onClick: () => {
      if (activeRoom) cycleRoomCategoryColor(activeRoom.id, 1);
    },
    onWheel: (event) => {
      event.preventDefault();
      if (activeRoom) cycleRoomCategoryColor(activeRoom.id, event.deltaY);
    },
    ariaPressed: activeRoomCategoryFilter !== null,
    hideable: true,
    disabled: !activeRoom || activeRoomCategoryColors.length === 0,
    disabledReason: !activeRoom ? "Choose a room first" : "No pane colors assigned"
  },
  ...(role === "ADMIN" ? [{
    id: "agents-dashboard",
    label: "Agents Dashboard",
    title: agentsDashboardSummary?.loaded
      ? `Agents Dashboard · ${agentsDashboardSummary.total} agents (${agentsDashboardSummary.working} working, ${agentsDashboardSummary.waiting} waiting, ${agentsDashboardSummary.done} done)`
      : "Agents Dashboard",
    ariaLabel: "Open agents dashboard",
    icon: LayoutDashboard,
    onClick: () => setIsAgentsDashboardOpen(true),
    hideable: true
  }, {
    id: "system-resources",
    label: "System resources",
    title: "Live system resources, CLI sessions, memory & CPU analysis",
    ariaLabel: "System resources",
    icon: Activity,
    onClick: () => openSystemResources(),
    hideable: true
  }, {
    id: "resources",
    label: "Resources",
    title: "Resources & account quotas",
    ariaLabel: "Resources",
    icon: Activity,
    onClick: () => openSystemResources(),
    hideable: true
  }] : []),
  ...(hasUser ? [{
    id: "resource-indicators",
    label: resourceIndicatorsVisible ? "Hide resource indicators" : "Show resource indicators",
    title: "Live resource values at the top right",
    ariaLabel: resourceIndicatorsVisible ? "Hide resource indicators" : "Show resource indicators",
    icon: Cpu,
    onClick: toggleResourceIndicators,
    ariaPressed: resourceIndicatorsVisible
  }] : []),
  {
    id: "cli-floats",
    label: cliFloatsHidden ? "Show CLI floats" : "Hide CLI floats",
    title: cliFloatsHidden ? "Show CLI floats" : "Hide CLI floats",
    ariaLabel: cliFloatsHidden ? "Show CLI floats" : "Hide CLI floats",
    icon: CliFloats,
    onClick: toggleCliFloats,
    ariaPressed: cliFloatsHidden
  },
  {
    id: "sensitive-data",
    label: maskSensitiveData ? "Show sensitive data" : "Hide sensitive data",
    title: maskSensitiveData ? "Show sensitive data" : "Hide sensitive data",
    ariaLabel: maskSensitiveData ? "Show sensitive data" : "Hide sensitive data",
    icon: maskSensitiveData ? EyeOff : Eye,
    onClick: toggleMaskSensitiveData,
    ariaPressed: maskSensitiveData,
    hideable: false,
    dataSensitiveIgnore: true
  },
  {
    id: "debug-mode",
    label: isDebugModeActive ? "Turn off Debug (App diagnostics)" : "Turn on Debug (App diagnostics)",
    title: isDebugModeActive ? "Turn off Debug (App diagnostics)" : "Turn on Debug (App diagnostics)",
    ariaLabel: isDebugModeActive ? "Turn off Debug (App diagnostics)" : "Turn on Debug (App diagnostics)",
    icon: Bug,
    onClick: () => void toggleDebugMode(),
    ariaPressed: isDebugModeActive,
    disabled: debugModePending,
    hideable: true
  },
  // Space Gateway compression for every CLI, chat and agent; the click asks for confirmation first.
  ...(role === "ADMIN" && gatewayCompression.mode !== null ? [{
    id: "gateway-compression",
    label: gatewayCompression.mode === "ON" ? "Turn off context compression" : "Turn on context compression",
    title: gatewayCompression.mode === "ON" ? "Turn off context compression" : "Turn on context compression",
    ariaLabel: gatewayCompression.mode === "ON" ? "Turn off context compression" : "Turn on context compression",
    icon: Shrink,
    onClick: gatewayCompression.request,
    ariaPressed: gatewayCompression.mode === "ON",
    disabled: gatewayCompression.pending,
    hideable: true
  } satisfies IconToolbarAction] : []),
  {
    id: "font-down",
    label: "Workspace text size",
    title: `Workspace text size: ${terminalFontSize} px`,
    ariaLabel: "Workspace text size",
    icon: ALargeSmall,
    onClick: () => setIsWorkspaceTextSizePickerOpen((current) => !current),
    ariaControls: WORKSPACE_TEXT_SIZE_PICKER_ID,
    ariaExpanded: isWorkspaceTextSizePickerOpen,
    ariaHasPopup: "listbox",
    disabled: !activeRoom || !panes.some((pane) => pane.mode === "TERMINAL" || pane.mode === "CHAT"),
    disabledReason: !activeRoom ? "Choose a room first" : "Open a terminal or chat pane"
  },
  ...(!isPaneHidden("chat")
    ? [{
        id: "add-chat",
        label: "Add chat pane",
        title: isCodexEnabled ? "Add chat pane" : "Enable Codex in Settings",
        ariaLabel: "Add chat pane",
        icon: modeIcons.CHAT,
        onClick: toggleChatLauncher,
        ariaControls: CHAT_LAUNCHER_MENU_ID,
        ariaExpanded: isChatLauncherOpen,
        ariaHasPopup: shellMode === "mobile" ? "dialog" as const : "menu" as const,
        disabled: !isCodexEnabled || !selectedRoomId || panes.length >= 16
      }]
    : []),
  {
    id: "add-cli",
    label: "Add CLI pane",
    title: "Add CLI pane",
    ariaLabel: "Add CLI pane",
    icon: Terminal,
    onClick: toggleCliLauncher,
    ariaControls: CLI_LAUNCHER_MENU_ID,
    ariaExpanded: isCliLauncherOpen,
    ariaHasPopup: shellMode === "mobile" ? "dialog" as const : "menu" as const,
    disabled: !selectedRoomId || cliPaneCreationPending
  },
  ...(role === "ADMIN"
    ? [{
        id: "add-root-admin-cli",
        label: "Add CLI ROOT",
        title: "Add CLI ROOT",
        ariaLabel: "Add CLI ROOT",
        icon: ShieldCheck,
        onClick: () => void addRootAdminPane(),
        disabled: !selectedRoomId || panes.length >= 16
      },
      {
        id: "server-restart",
        label: "Manage",
        title: "Manage",
        ariaLabel: "Manage",
        icon: ServerCog,
        onClick: () => openManage(),
        ariaControls: SERVER_ACTIONS_MENU_ID,
        ariaExpanded: isServerActionsMenuOpen,
        ariaHasPopup: shellMode === "mobile" ? "dialog" as const : "menu" as const,
        hideable: false
      }]
    : []),
  ...(!isPaneHidden("browser")
    ? [{
        id: "add-browser",
        label: "Add browser pane",
        title: "Add browser pane",
        ariaLabel: "Add browser pane",
        icon: modeIcons.BROWSER,
        onClick: () => addPane("BROWSER"),
        disabled: !selectedRoomId || panes.length >= 16
      }]
    : []),
  ...(!isPaneHidden("files")
    ? [{
        id: "add-files",
        label: "File Manager",
        title: "Add File Manager pane",
        ariaLabel: "Add File Manager pane",
        icon: modeIcons.FILES,
        onClick: () => {
          if (!activeRoom) return;
          void addFilesPane();
        },
        disabled: !activeRoom || panes.length >= 16
      }]
    : []),
  ...(!isPaneHidden("databases")
    ? [{
        id: "add-databases",
        label: "Databases",
        title: "Add Databases pane",
        ariaLabel: "Add Databases pane",
        icon: modeIcons.DATABASES,
        onClick: () => {
          if (!activeRoom) return;
          void addDatabasesPane();
        },
        disabled: !activeRoom || panes.length >= 16
      }]
    : []),
  ...(!isPaneHidden("demos")
    ? [{
        id: "add-demos",
        label: "Demo Projects",
        title: "Add Demo Projects pane",
        ariaLabel: "Add Demo Projects pane",
        icon: modeIcons.DEMOS,
        onClick: () => {
          if (!activeRoom) return;
          void addDemosPane();
        },
        disabled: !activeRoom || panes.length >= 16
      }]
    : []),
  ...(!isPaneHidden("jobs")
    ? [{
        id: "add-jobs",
        label: "Job Copilot",
        title: "Add Job Copilot pane",
        ariaLabel: "Add Job Copilot pane",
        icon: modeIcons.JOB_APPLY,
        onClick: () => {
          if (!activeRoom) return;
          void addJobApplyPane();
        },
        disabled: !activeRoom || panes.length >= 16
      }]
    : []),
  ...(!isPaneHidden("mail")
    ? [{
        id: "add-mail",
        label: "Mail Copilot",
        title: "Add Mail Copilot pane",
        ariaLabel: "Add Mail Copilot pane",
        icon: modeIcons.MAIL_COPILOT,
        onClick: () => {
          if (!activeRoom) return;
          void addMailCopilotPane();
        },
        disabled: !activeRoom || panes.length >= 16
      }]
    : []),
  ...(!isPaneHidden("marketing")
    ? [{
        id: "add-marketing",
        label: "Marketing Copilot",
        title: "Add Marketing Copilot pane",
        ariaLabel: "Add Marketing Copilot pane",
        icon: modeIcons.MARKETING_COPILOT,
        onClick: () => {
          if (!activeRoom) return;
          void addMarketingCopilotPane();
        },
        disabled: !activeRoom || panes.length >= 16
      }]
    : []),
  ...(!isPaneHidden("freelance")
    ? [{
        id: "add-freelance",
        label: "Freelance Copilot",
        title: "Add Freelance Copilot pane",
        ariaLabel: "Add Freelance Copilot pane",
        icon: modeIcons.FREELANCE_COPILOT,
        onClick: () => {
          if (!activeRoom) return;
          void addFreelanceCopilotPane();
        },
        disabled: !activeRoom || panes.length >= 16
      }]
    : []),
  ...(!isPaneHidden("t3code")
    ? [{
        id: "add-t3code",
        label: "T3 Code",
        title: "Add T3 Code pane",
        ariaLabel: "Add T3 Code pane",
        icon: modeIcons.T3CODE,
        onClick: () => {
          if (!activeRoom) return;
          void addT3CodePane();
        },
        disabled: !activeRoom || panes.length >= 16
      }]
    : []),
  ...(!isPaneHidden("youtube")
    ? [{
        id: "add-youtube",
        label: "Add YouTube pane",
        title: "Add YouTube pane",
        ariaLabel: "Add YouTube pane",
        icon: modeIcons.YOUTUBE,
        onClick: () => addPane("YOUTUBE"),
        disabled: !selectedRoomId || panes.length >= 16
      }]
    : []),
  ...(!isPaneHidden("vnc")
    ? [{
        id: "add-vnc",
        label: "Add VNC pane",
        title: "Add VNC pane",
        ariaLabel: "Add VNC pane",
        icon: modeIcons.VNC,
        onClick: () => addPane("VNC"),
        disabled: !selectedRoomId || panes.length >= 16
      }]
    : []),
  ...(!isPaneHidden("live")
    ? [{
        id: "add-live",
        label: "Add Live audio pane",
        title: "Add Live audio pane",
        ariaLabel: "Add Live audio pane",
        icon: modeIcons.LIVE,
        onClick: () => void addLivePane(),
        disabled: !selectedRoomId || panes.length >= 16
      }]
    : []),
  {
    id: "vpn-city",
    label: `Change ${toolbarVpnRoute === "nord" ? "NordVPN" : toolbarVpnRoute === "mullvad" ? "Mullvad" : "VPN"} city`,
    title: `Change ${toolbarVpnRoute === "nord" ? "NordVPN" : toolbarVpnRoute === "mullvad" ? "Mullvad" : "VPN"} city`,
    ariaLabel: `Change ${toolbarVpnRoute === "nord" ? "NordVPN" : toolbarVpnRoute === "mullvad" ? "Mullvad" : "VPN"} city`,
    icon: Globe,
    onClick: () => void rotateVpnCityFromToolbar(),
    disabled: vpnCityPending || !toolbarVpnRoute
  },
  {
    id: "reload-room",
    label: "Reload window",
    title: "Reload window",
    ariaLabel: "Reload window",
    icon: RefreshCw,
    onClick: () => void reloadRoomWindow(),
    disabled: false
  },
  {
    id: "browser-fullscreen",
    label: isBrowserFullscreen ? "Exit full screen" : "Full screen browser",
    title: isBrowserFullscreen ? "Exit full screen (F11)" : "Full screen browser (F11)",
    ariaLabel: isBrowserFullscreen ? "Exit full screen" : "Full screen browser",
    icon: isBrowserFullscreen ? Minimize : Maximize,
    onClick: () => void toggleBrowserFullscreen(),
    ariaPressed: isBrowserFullscreen,
    disabled: false
  },
  {
    id: "snip-tool",
    label: "Snip Tool",
    title: "Snip Tool (Capture, edit and share)",
    ariaLabel: "Snip Tool",
    icon: Crop,
    onClick: () => {
      setIsSnipToolOpen((current) => !current);
    },
    ariaPressed: isSnipToolOpen,
    disabled: !activeRoom
  },
  {
    id: "clip-tool",
    label: "Clip Tool",
    title: "Clip Tool",
    ariaLabel: "Clip Tool",
    icon: Camera,
    onClick: () => void captureRoomScreen(),
    disabled: !activeRoom
  },
  {
    id: "osk-keyboard",
    label: "On-screen keyboard",
    title: "On-screen keyboard",
    ariaLabel: "On-screen keyboard",
    icon: Keyboard,
    onClick: () => setIsOskKeyboardOpen((current) => !current),
    ariaPressed: isOskKeyboardOpen,
    ariaControls: OSK_PANEL_ID,
    ariaExpanded: isOskKeyboardOpen,
    ariaHasPopup: "dialog"
  },
  {
    id: "help",
    label: "Help",
    title: "Help",
    ariaLabel: "Help",
    icon: CircleHelp,
    onClick: openHelp
  },
  ...(role === "ADMIN" ? [{
    id: "demo-mode",
    label: "Demo mode",
    title: "Explore all Space App features with an interactive guided tour",
    ariaLabel: "Demo mode",
    icon: Sparkles,
    onClick: () => setIsDemoModeActive(true),
    ariaPressed: isDemoModeActive,
    hideable: false
  }, {
    id: "token-usage",
    label: "Token usage",
    title: "Token usage history by provider and model",
    ariaLabel: "Token usage",
    icon: Database,
    onClick: () => openSystemHealth("usage")
  }, {
    id: "advanced-settings",
    label: "Advanced settings",
    title: "All advanced settings in one place",
    ariaLabel: "Advanced settings",
    icon: Settings,
    onClick: () => {
      setAdminModeRequested(true);
      toggleSideSurface("settings");
    }
  }, {
    id: "setup-connections",
    label: "Setup wizard",
    title: "Set up tools and connections",
    ariaLabel: "Setup wizard",
    icon: SlidersHorizontal,
    onClick: () => openManage("setup-connections")
  }, {
    id: "system-analytics",
    label: "System analytics",
    title: "Live system telemetry, model performance, CPU & RAM, and CLI sessions",
    ariaLabel: "System analytics",
    icon: Monitor,
    onClick: () => {
      setIsMemoryWorkspaceOpen(false);
      setIsSpaceGatewayOpen(false);
      setSystemAnalyticsTab("overview");
    }
  }, {
    id: "system-services",
    label: "System services",
    title: "Inspect and control systemd services, background workers, and timers",
    ariaLabel: "System services",
    icon: Server,
    onClick: () => openManage("system-services")
  }] : []),
  // The games are an optional server module (off by default in public installs).
  ...(serverModuleOn("games") ? [{
    id: "benchmark",
    label: "Games Benchmark",
    title: "Open the AI Games Benchmark: Asteroids and Chess",
    ariaLabel: "Games Benchmark",
    icon: Crosshair,
    onClick: openBenchmark
  }] : []),
  {
    id: "vibe-music",
    label: "Vibe music",
    title: "Vibe music with freeCodeCamp Code Radio",
    ariaLabel: "Music",
    icon: Music2,
    onClick: () => {
      setIsQuickLinksOpen(false);
      setIsThemeMenuOpen(false);
      setIsPaneLayoutMenuOpen(false);
      setIsPaneSpanAllMenuOpen(false);
      setIsWorkspaceTextSizePickerOpen(false);
      setIsServerActionsMenuOpen(false);
      setIsCliLauncherOpen(false);
      setIsVibeMusicOpen((current) => !current);
    },
    ariaControls: VIBE_MUSIC_PANEL_ID,
    ariaExpanded: isVibeMusicOpen,
    ariaPressed: isVibeMusicOpen,
    ariaHasPopup: "dialog",
    hideable: false
  },
  {
    id: "sign-out",
    label: "Sign out",
    title: "Sign out",
    ariaLabel: "Sign out",
    icon: LogOut,
    onClick: () => void signOut(),
    hideable: false
  },
  {
    id: "room-focus",
    label: isRoomFocusMode ? "Restore room" : "Maximize room",
    title: isRoomFocusMode ? "Restore room" : "Maximize room",
    ariaLabel: isRoomFocusMode ? "Restore room" : "Maximize room",
    icon: isRoomFocusMode ? Minimize2 : Maximize2,
    onClick: () => {
      setIsPaneLayoutMenuOpen(false);
      setIsCliLauncherOpen(false);
      toggleRoomFocusMode();
    },
    ariaPressed: isRoomFocusMode,
    hideable: false,
    disabled: !activeRoom
  },
  {
    id: "more-actions",
    label: "More room actions",
    title: "More room actions",
    ariaLabel: "More room actions",
    icon: MoreHorizontal,
    onClick: () => {},
    ariaControls: "room-actions-popup",
    ariaHasPopup: shellMode === "mobile" ? "dialog" : "menu",
    hideable: false
  }
  ];
  return actions.filter(action => !consolidatedResourceActions.has(action.id) && !consolidatedManageActions.has(action.id));
}
