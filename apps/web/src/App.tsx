import { bridgePlanExecutionEvent } from "./features/terminal-pane/plan-execution-events.js";
import { DOT_CALL_EVENT, OPEN_DOT_SETTINGS_EVENT, readLivePaneDot, writeLivePaneDot, type DotSettingsSection } from "./features/agent-pane/dot-home-events.js";
import type { DotSettingsRequest } from "./features/agent-pane/DotsSettingsCard.js";
import { PANE_TOOLBAR_ACTION_ORDER_STORAGE_KEY_PREFIX, PANE_TOOLBAR_HIDDEN_ACTIONS_STORAGE_KEY_PREFIX, PaneCard, SHARED_CODEX_TOOLBAR_HIDDEN_STORAGE_KEY, SHARED_CODEX_TOOLBAR_ORDER_STORAGE_KEY, dispatchAgentPaneAction, dispatchTerminalPaneAction, displayPaneTitle } from "./features/pane-card/PaneCard.js";
export { formatTerminalSessionDebugInfo, formatTerminalSessionClipboardText } from "./features/pane-card/PaneCard.js";
import { MovePaneDialog } from "./features/pane-dialogs/PaneDialogs.js";
import { isTransientUpstreamErrorMessage, isTransientUpstreamRuntimeError, parseStreamEvent, streamEventTypes } from "./app-shell-utils.js";
import {
  MAX_PANE_COLUMN_SPAN,
  calculatePaneGridBaseRows,
  measureSingleLineTitleWidth,
  paneHeaderNeedsSecondRow,
  remToPx,
  resolvePaneGridColumnCount,
  resolvePaneGridPlacements,
  roomToolbarNeedsSecondRow,
  sortPanesForGrid,
  type PaneColumnAnchor,
  type PaneColumnAnchorMap,
  type PaneDensity,
  type ShellMode
} from "./features/pane-grid/pane-grid-layout.js";
export { roomToolbarNeedsSecondRow, paneHeaderNeedsSecondRow, resolvePaneGridPlacements, calculatePaneGridBaseRows } from "./features/pane-grid/pane-grid-layout.js";
export type { PaneColumnAnchor, PaneColumnAnchorMap } from "./features/pane-grid/pane-grid-layout.js";
import { LoginScreen } from "./features/auth/LoginScreen.js";
import { InviteAcceptScreen, readInviteToken } from "./features/auth/InviteAcceptScreen.js";
// Evaluated at its old position so the stylesheet order is unchanged; the Settings dock renders it.
import "./features/voice-input/VoiceSettingsCard.js";
import { clearLegacyCliShortcutUsage } from "./features/terminal-pane/CliShortcutsMenu.js";
import { openManage } from "./features/server-actions/manage-navigation.js";
import { useSpaceControlClient } from "./features/room-agent/space-control-client.js";
import { useRailOrder } from "./features/ui-theme/use-rail-order.js";
import { syncRailScale } from "./features/ui-theme/rail-dynamic-scaling.js";
import { useTouchContextMenu } from "./features/ui-theme/use-touch-context-menu.js";
import { MobilePaneSwitcher } from "./features/ui-theme/MobilePaneSwitcher.js";
import { LiveSessionProvider } from "./features/live-pane/LiveSessionProvider.js";
import { LiveRailSession } from "./features/live-pane/LiveRailSession.js";
import { useLiveRail } from "./features/live-pane/useLiveRail.js";
import {
  DEFAULT_LOWER_RAIL_ITEMS,
  LOWER_RAIL_HIDDEN_KEY,
  LOWER_RAIL_NON_HIDEABLE,
  LOWER_RAIL_VISIBILITY_IDS,
  useRailVisibility
} from "./features/ui-theme/use-rail-visibility.js";
import { bindSpaceMediaVolume } from './space-audio.js';
import { AsteroidsGate } from "./features/asteroids/AsteroidsGate.js";
import { canPlayAsteroids } from "./features/asteroids/eligibility.js";
import { createWorktree } from "./features/worktrees/worktree-client.js";
import { RecoverableSurface } from "./features/SurfaceErrorBoundary.js";
import { readDockSession } from "./features/workspace-session.js";
import { SystemHealth, useResourceIndicators } from "./features/system-health/SystemHealth.js";
import { openSystemHealth, openSystemResources } from "./features/system-health/health-model.js";
import type { OskCliCommand } from "./features/osk-keyboard/cli-shortcuts.js";
import {
  AppIconProvider,
  Activity,
  ChevronLeft,
  ChevronRight,
  Chrome,
  Globe,
  Grid2X2,
  Loader2,
  MessageSquare,
  Mic,
  Minus,
  Monitor,
  MoveHorizontal,
  Network,
  Palette,
  PanelTopOpen,
  Pencil,
  Plus,
  Save,
  Bell,
  ShieldCheck,
  Terminal,
  UserCheck
} from "./features/ui-theme/app-icons.js";
import { SensitiveDataMask } from "./features/sensitive-data/SensitiveDataMask.js";
import { SpaceToggle } from "./features/ui-controls/SpaceToggle.js";
import { lazy, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent as ReactDragEvent, type ReactNode, type RefObject } from "react";
import type {
  Artifact,
  AgentRuntime,
  AuthMe,
  ClipboardItem,
  CodexEnvironment,
  CodexAppServerHandshakeCheck,
  CodexAppServerStatus,
  CodexAppServerTurnSmokeCheck,
  TaskItem,
  CreateRoomPanesRequest,
  Event as SpaceEvent,
  ImportCandidate,
  McpDiscoverySmokeCheck,
  MemoryEmbeddingSmokeCheck,
  MemoryVectorReadiness,
  Model,
  ObservabilitySnapshot,
  Pane,
  Provider,
  ProviderSettings,
  Room,
  SetupClaimInput,
  SetupStatus,
  Skill,
  StorageReadiness,
  SwarmState,
  Turn,
  WorkerReadiness,
  UserLink,
  CliRuntimeSettingsResponse,
  AgentSessionHistoryItem,
  CopilotLaunchSettings,
  UserSettings
} from "@space/contracts";
import {
  seedInitialLocalSettingsToServer,
  syncFromServer
} from "./features/user-settings/user-settings-manager.js";
import { MAX_ROOMS, type PaneCategoryColor } from "@space/contracts";
import {
  nextCategoryColor,
  readStoredCategoryFilter,
  roomCategoryColors,
  writeStoredCategoryFilter
} from "./features/pane-category-color/room-filter.js";
import { api, SpaceApiError, type McpPayload, type ReadyzPayload } from "./api.js";
import {
  acknowledgePaneCompletion,
  applyPaneCompletionEvents,
  createPaneCompletionLifecycleState,
  hydratePaneCompletionRoom,
  hydratePaneCompletionReplay,
  pendingPaneCompletionEventId,
  type PaneCompletionLifecycleState
} from "./pane-completion-lifecycle.js";
import { type AgentDashboardSummary } from "./features/agents-dashboard/dashboard-model.js";
import {
  PANE_RUN_LIFECYCLE_EVENT,
  type PaneRunLifecycleDetail
} from "./pane-run-lifecycle-events.js";
import { nextGeneratedRoomName } from "./room-naming.js";
import {
  isCliRuntimeTerminalLaunchable
} from "./cli-runtime-presentation.js";
import {
  CLI_RUNTIME_VISIBILITY_EVENT,
  dispatchCliRuntimeVisibilityChange,
  readCliRuntimeVisibilityChange
} from "./cli-runtime-visibility-events.js";
import { useToolbarVpn } from "./features/toolbar-vpn/useToolbarVpn.js";
import {
  CLI_RECOVERY_OPENED_EVENT,
  parseCliRecoveryOpenedDetail
} from "./cli-recovery-events.js";
import { reportCoreApiFailure, reportCoreApiSuccess } from "./core-api-availability.js";
import { DEMO_LOCAL_REPLY, eventGateway, getSpaceRuntime, getSpaceRuntimeKind } from "./runtime/SpaceRuntime.js";
import { dispatchArtifactsUpdated } from "./artifact-events.js";
import { SpaceBrand } from "./SpaceBrand.js";
import {
  dispatchAgentPaneActionEvent,
  dispatchAgentPaneAttachmentsEvent
} from "./features/agent-pane/events.js";
import { AuthenticationBootstrap } from "./features/auth/AuthenticationBootstrap.js";
import { OwnerSetupScreen } from "./features/auth/OwnerSetupScreen.js";
import {
  BROWSER_PANE_ACTION_EVENT,
  dispatchBrowserPaneActionEvent,
  parseBrowserPaneActionDetail,
  type BrowserPaneAction
} from "./features/browser-pane/events.js";
import { AppVersionMeta, DemoVersionMeta } from "./features/app-version/AppVersionMeta.js";
import type { CopilotLaunchChoice } from "./features/copilot-kit/CopilotLaunchDialog.js";
import { DESIGN_KIND, FREELANCE_COPILOT_KIND, JOB_COPILOT_KIND, MAIL_COPILOT_KIND, MARKETING_COPILOT_KIND, type CopilotKind } from "./features/copilot-kit/copilot-kind.js";
import { resolveCopilotLaunch } from "./features/copilot-kit/copilot-runtimes.js";
import { rememberNewPaneAccount } from "./features/cli-accounts/cli-account-memory.js";
import { forwardCopilotStreamEvents } from "./features/copilot-kit/copilot-stream.js";
import { forwardNousFocusEvents, useNousFocus } from "./features/nous-focus/NousFocus.js";
import { HealthDock } from "./features/health/HealthDock.js";
import {
  AppDiagnosticsGlobalIndicators,
  useDiagnosticsState
} from "./features/app-diagnostics/AppDiagnosticsIndicators.js";
import { emitAppDiagnosticsPerformance } from "./app-diagnostics/app-diagnostics-performance.js";
import {
  applyAppDiagnosticsStatus,
  startAppDiagnosticsBootstrap
} from "./app-diagnostics/app-diagnostics-bootstrap.js";
import { GitBranch } from "./features/ui-theme/app-icons.js";
import { SettingsDisclosure, SettingsSections } from "./features/settings/SettingsDisclosure.js";
import { useRoomAgentAttention } from "./features/room-agent/use-room-agent-attention.js";
import { dispatchNotificationStreamEvent, useNotificationBootstrap } from "./features/notifications/useNotifications.js";
import { pushNotificationsEnabled, setPushNotifications } from "./features/notifications/desktop-notifications.js";
import { useNotificationStore, type NotificationNavigator } from "./features/notifications/notification-store.js";
import { NotificationToastHost } from "./features/notifications/NotificationToastHost.js";
import { useDocksVisibility } from "./features/docks/use-docks-visibility.js";
import { useDockConfirm } from "./features/dock-kit/DockKit.js";
import type { SideSurface } from "./features/docks/dock-types.js";
import { sideSurfaceMeta } from "./features/docks/side-surface-meta.js";
import { useSideSurfaceEffects, useSideSurfaces } from "./features/docks/useSideSurfaces.js";
import { CompactSideSurfaceDrawer, InlineSideSurface } from "./features/docks/SideSurfaceFrame.js";
import { preloadDockModules } from "./features/docks/dock-preloader.js";
import { usePanesVisibility } from "./features/pane-visibility/use-panes-visibility.js";
// Evaluated at its old position so the stylesheet order is unchanged; the room toolbar and rail render it.
import "./features/ui-theme/DesktopNavigation.js";
import { WorkspaceRoomSettings } from "./features/ui-theme/WorkspaceRoomSettings.js";
import { LiquidGlassLens } from "./features/ui-theme/LiquidGlassLens.js";
import { useLiquidGlassTint } from "./features/ui-theme/use-liquid-glass-tint.js";
import { WorkspacePortalMount } from "./features/ui-theme/WorkspaceSurface.js";
import "./features/ui-theme/workspace-chrome.css";
import {
  useSpaceClipboardCapture
} from "./features/clipboard-dock/clipboard-events.js";
import { useAppNotices } from "./features/app-notices/useAppNotices.js";
import { AppNoticeBanners, LiveDebugToastView } from "./features/app-notices/AppNoticeBanners.js";
import {
  StreamingOverlay,
  StreamingOverlayProvider
} from "./features/streaming/StreamingOverlay.js";
import { reorderPanesByTarget, setPaneDragData, type PaneDropPosition } from "./features/pane-drag/pane-drag.js";
import { LinksPanel, QuickLinksPopover } from "./features/user-links/UserLinks.js";
import {
  RoomThemeMenu
} from "./features/room-theme/RoomThemeMenu.js";
import {
  migrateModernToolbarPreference,
  modernRoomToolbarStorageKeys,
  readModernAppearance,
  readModernIconPack,
  readUiBackground,
  readUiTheme,
  resolveModernColorMode,
  shouldMeasureToolbarLayout,
  writeModernAppearance,
  writeModernIconPack,
  writeUiBackground,
  writeUiTheme,
  type ModernAppearance,
  type ModernIconPack,
  type UiBackground,
  type UiTheme
} from "./ui-theme.js";
import { RoomsDockPanel, selectRoomEntries } from "./features/rooms-dock/RoomsDockPanel.js";
import { useRoomsDock } from "./features/rooms-dock/useRoomsDock.js";
import { useAdminUsers } from "./features/rooms-dock/useAdminUsers.js";
import { ensureProjectFolder, loadBoundedRoomCatalog, sortRoomsByOrder } from "./features/rooms-dock/room-catalog.js";
import { useAppView } from "./features/help/useAppView.js";
import { MemoryWorkspaceErrorBoundary } from "./features/memory-workspace/MemoryWorkspaceErrorBoundary.js";
import { useManageController } from "./features/server-actions/useManageController.js";
import { CliRuntimeRestartAllDialog, ServerRestartDialog } from "./features/server-actions/RestartDialogs.js";
import { CliLauncherMenu } from "./features/cli-launcher/CliLauncherMenu.js";
import { PaneLayoutMenu } from "./features/pane-layout/PaneLayoutMenu.js";
import { useRootRemSize } from "./features/pane-layout/use-root-rem-size.js";
import {
  createTerminalBootstrapBarrier,
  type TerminalBootstrapBarrier
} from "./features/terminal-pane/index.js";
import { registerYouTubeBrowseIntent } from "./features/browser-pane/youtube-browse-intent.js";
import { registerCliResumeIntent } from "./features/terminal-pane/cli-resume-intent.js";
import { paneRuntimeBlockedReason, roomPaneLimit } from "./pane-runtime-availability.js";
import type { OnScreenKeyboardInput } from "./features/osk-keyboard/OnScreenKeyboard.js";
import { useVibeMusicMount } from "./features/vibe-music/vibe-music-session.js";
import { StickyNoteLayer, StickyNoteWindow, useStickyNoteWindows } from "./features/clipboard-dock/StickyNoteWindow.js";
import { usePaneOpener } from "./features/pane-card/pane-opener.js";
import { useYouTubeFloatRequest } from "./features/pane-card/use-youtube-float-request.js";
import {
  DesktopWidgetsLayer,
  useDesktopWidgets,
  useWidgetsVisibility
} from "./features/desktop-widgets/index.js";
import {
  ToolbarMetrics,
  type ToolbarMetricsHandle
} from "./features/toolbar-metrics/ToolbarMetrics.js";
import type { SystemAnalyticsTab } from "./features/system-analytics/SystemAnalyticsWorkspace.js";
import { shouldLoadHarnessPane } from "./features/harness-pane/harness-load-policy.js";
import {
  WorkspaceTextSizePicker
} from "./features/workspace-text-size-picker/WorkspaceTextSizePicker.js";
import {
  MINIMIZED_PANE_BAR_TOGGLE_ID,
  MinimizedPaneBarToggle
} from "./features/pane-float/MinimizedPaneBarToggle.js";
import { DesktopDisplayControls } from "./features/desktop-screens/DesktopDisplayControls.js";
import { useBrowserFullscreen } from "./features/desktop-titlebar/useBrowserFullscreen.js";
import { DesktopWindowTitlebar } from "./features/desktop-titlebar/DesktopWindowTitlebar.js";
import {
  useDismissibleToolbarLayer,
  usePersistentIconToolbar,
  type IconToolbarAction
} from "./icon-toolbar.js";
import {
  classifyRoomSwitchTemperature,
  recordLifecycleDebugEvent,
  recordRoomSwitchMeasurementPhase,
  startRoomSwitchMeasurement
} from "./lifecycle-debug.js";
import { useVoiceInput } from "./features/voice-input/VoiceInputProvider.js";
import {
  connectedPaneCount,
  selectRoomRuntimePollIds,
  selectWarmRoomIds,
  warmRoomLimits,
  WARM_ROOM_RUNTIME_POLL_INTERVAL_MS
} from "./room-runtime-cache.js";
import { MOBILE_WARM_ROOM_CONNECTED_PANE_LIMIT } from "./warm-room-settings.js";
import {
  hydrateWarmRoomsWithinWindow,
  readRoomMru,
  recordRoomMru,
  runWithConcurrency,
  selectWarmHydrationRoomIds,
  WARM_ROOM_STARTUP_HYDRATION_CONCURRENCY
} from "./warm-room-startup.js";
import { reuseVersionedItems, useStableCallback } from "./render-performance.js";
import { lazyWithPreload } from "./lazy-with-preload.js";
import { LazyTaskDock, LazyVaultDock } from "./features/docks/lazy-docks.js";
import { useUserPreferenceWriteThrough, useUserPreferences } from "./features/user-settings/useUserPreferences.js";
import { readStoredBoolean } from "./stored-boolean.js";
import { readStoredSessionString } from "./session-string-storage.js";
import { useSnipTool } from "./features/snip-tool/useSnipTool.js";
import { useToolbarPopovers } from "./features/room-toolbar/useToolbarPopovers.js";
import { buildRoomToolbarActions } from "./features/room-toolbar/room-toolbar-actions.js";
import { CollapsedRoomRail, type WorkspaceNavigationBinding } from "./features/room-toolbar/CollapsedRoomRail.js";
import { roomActionFilter, roomRailVisibility } from "./features/rooms-dock/room-share-view.js";
import { RoomTitleBar } from "./features/room-toolbar/RoomTitleBar.js";
import { useRoomRename } from "./features/room-toolbar/useRoomRename.js";
import { useMinimizedPaneBar } from "./features/pane-float/useMinimizedPaneBar.js";
import { MinimizedPaneBar } from "./features/pane-float/MinimizedPaneBar.js";
import { paneTitleForMode } from "./features/pane-float/pane-mode-labels.js";
import { AgentSettingsDock, settingsCardLoadingFallback, type AgentSettingsCards } from "./features/settings/AgentSettingsDock.js";
import { RoomToolbarActions } from "./features/room-toolbar/RoomToolbarActions.js";
import { scheduleT3BundlePrefetch } from "./features/t3code-pane/t3code-prefetch.js";
import { useGatewayCompressionToggle } from "./features/space-gateway/useGatewayCompressionToggle.js";
import { scheduleSetupOverviewProbe, scheduleStartupBackground } from "./startup-background.js";

const ROOM_PRESENTATION_FAILURE_TIMEOUT_MS = 8_000;

type ActiveRoomEventStreamStatus = "idle" | "connecting" | "connected" | "disconnected" | "unavailable";
type RoomRefreshCategory = "panes" | "turns" | "swarm" | "events";
type RoomRuntimeSnapshot = {
  roomId: string;
  panes: Pane[];
  turns: Turn[];
  events: SpaceEvent[];
  swarm: SwarmState | null;
  selectedPaneId: string | null;
  bootstrappedPaneIds: string[];
  prefillReadyPaneIds: string[];
  lastAccessedAt: number;
};
type RoomPaneLoadState = "loading" | "loaded" | "error";

export function roomRuntimeLayerHasEmptyState({
  roomId,
  selectedRoomId,
  selectedPanes,
  runtimePanes,
  category
}: {
  roomId: string;
  selectedRoomId: string | null;
  selectedPanes: Pane[];
  runtimePanes?: Pane[];
  category: PaneCategoryColor | null;
}): boolean {
  if (roomId !== selectedRoomId && runtimePanes === undefined) return false;
  const panes = roomId === selectedRoomId ? selectedPanes : runtimePanes ?? [];
  return panes.length === 0 || (category !== null && panes.every((pane) => pane.categoryColor !== category));
}

export function shellVisiblePaneIds(
  panes: ReadonlyArray<Pick<Pane, "id" | "isMaximized" | "isMinimized">>,
  selectedPaneId: string | null,
  shellMode: ShellMode,
  fullscreenLayout = false
): string[] {
  const visiblePanes = shellMode === "mobile" ? panes : panes.filter((pane) => !pane.isMinimized);
  if (shellMode === "mobile" || fullscreenLayout) {
    const selectedPane =
      shellMode === "mobile"
        ? (selectedPaneId ? visiblePanes.find((pane) => pane.id === selectedPaneId) : null) ?? visiblePanes[0]
        : visiblePanes.find((pane) => pane.id === selectedPaneId && !pane.isMinimized)
          ?? visiblePanes.find((p) => !p.isMinimized)
          ?? visiblePanes.find((pane) => pane.id === selectedPaneId)
          ?? visiblePanes[0];
    return selectedPane ? [selectedPane.id] : [];
  }
  const maximizedPanes = visiblePanes.filter((pane) => pane.isMaximized);
  return (maximizedPanes.length > 0 ? maximizedPanes : visiblePanes).map((pane) => pane.id);
}

interface CoalescedRefreshEntry {
  started: boolean;
  trailing: boolean;
  operation: () => Promise<void>;
  promise: Promise<void>;
}

export function createCoalescedRefreshQueue() {
  const entries = new Map<string, CoalescedRefreshEntry>();

  return {
    request(key: string, operation: () => Promise<void>): Promise<void> {
      const active = entries.get(key);
      if (active) {
        active.operation = operation;
        if (active.started) active.trailing = true;
        return active.promise;
      }

      let entry!: CoalescedRefreshEntry;
      const promise = Promise.resolve()
        .then(async () => {
          entry.started = true;
          do {
            entry.trailing = false;
            const nextOperation = entry.operation;
            await nextOperation();
          } while (entry.trailing);
        })
        .finally(() => {
          if (entries.get(key) === entry) entries.delete(key);
        });
      entry = { started: false, trailing: false, operation, promise };
      entries.set(key, entry);
      return promise;
    }
  };
}

export function roomRefreshCategoriesForEvent(type: SpaceEvent["type"]): RoomRefreshCategory[] {
  if (type === "PANE_CREATED" || type === "PANE_UPDATED" || type === "PANE_CLOSED") return ["panes"];
  if (type === "TURN_STARTED" || type === "TURN_DELTA" || type === "TURN_COMPLETED" || type === "TURN_FAILED") {
    return ["turns"];
  }
  if (type.startsWith("SWARM_")) return ["swarm"];
  return [];
}

export function shouldUseEventStreamFallback(status: ActiveRoomEventStreamStatus): boolean {
  return status === "disconnected" || status === "unavailable";
}

export function shouldOpenAppEventStreams(input: {
  authenticated: boolean;
  terminalsConnected: boolean;
  eventSourceSupported: boolean;
  cliLauncherOpen: boolean;
}): boolean {
  return input.authenticated && input.terminalsConnected && input.eventSourceSupported && !input.cliLauncherOpen;
}

function TerminalBootstrapBoundary({
  paneIds,
  children
}: {
  paneIds: readonly string[];
  children: (barriers: ReadonlyMap<string, TerminalBootstrapBarrier>) => ReactNode;
}) {
  const barrierByPaneIdRef = useRef(new Map<string, TerminalBootstrapBarrier>());
  const validPaneIds = paneIds.filter((paneId) => !paneId.startsWith("pane:optimistic-"));
  const newPaneIds = validPaneIds.filter((paneId) => !barrierByPaneIdRef.current.has(paneId));
  if (newPaneIds.length > 0) {
    const barrier = createTerminalBootstrapBarrier(newPaneIds);
    for (const paneId of newPaneIds) barrierByPaneIdRef.current.set(paneId, barrier);
  }
  return children(barrierByPaneIdRef.current);
}

const LazyMemoryWorkspace = lazyWithPreload(() =>
  import("./features/memory-workspace/MemoryWorkspace.js").then((module) => ({ default: module.MemoryWorkspace })),
  { idle: true }
);
const LazySystemAnalyticsWorkspace = lazy(() =>
  import("./features/system-analytics/SystemAnalyticsWorkspace.js")
    .then((module) => ({ default: module.SystemAnalyticsWorkspace }))
);
const LazyAdminOperationsDialog = lazy(() =>
  import("./features/admin-operations/AdminOperationsDialog.js")
    .then((module) => ({ default: module.AdminOperationsDialog }))
);
const LazyCopilotLaunchDialog = lazy(() =>
  import("./features/copilot-kit/CopilotLaunchDialog.js")
    .then((module) => ({ default: module.CopilotLaunchDialog }))
);
const LazyMaintenanceHub = lazy(() =>
  import("./features/admin-operations/MaintenanceHub.js")
    .then((module) => ({ default: module.MaintenanceHub }))
);
const LazyAdminCodexToolsDialog = lazy(() =>
  import("./features/admin-codex-tools/AdminCodexToolsDialog.js")
    .then((module) => ({ default: module.AdminCodexToolsDialog }))
);
const LazyUserManagementDialog = lazy(() =>
  import("./features/user-management/UserManagementDialog.js")
    .then((module) => ({ default: module.UserManagementDialog }))
);
const LazySpaceGatewayDialog = lazy(() =>
  import("./features/space-gateway/SpaceGatewayDialog.js")
    .then((module) => ({ default: module.SpaceGatewayDialog }))
);
const LazySetupConnectionsWizard = lazy(() =>
  import("./features/setup-connections/SetupConnectionsWizard.js")
    .then((module) => ({ default: module.SetupConnectionsWizard }))
);
const LazyEmbeddedDashboardDialog = lazy(() =>
  import("./features/embedded-dashboard/EmbeddedDashboardDialog.js")
    .then((module) => ({ default: module.EmbeddedDashboardDialog }))
);
const LazySystemServicesDialog = lazy(() =>
  import("./features/service-control/SystemServicesDialog.js")
    .then((module) => ({ default: module.SystemServicesDialog }))
);
const LazyHelpPage = lazy(() =>
  import("./features/help/HelpPage.js").then((module) => ({ default: module.HelpPage }))
);
const LazyBenchmarkPage = lazy(() =>
  import("./features/benchmark/BenchmarkPage.js").then((module) => ({ default: module.BenchmarkPage }))
);
const LazyDemoModeOverlay = lazy(() =>
  import("./features/demo-mode/DemoModeOverlay.js").then((module) => ({ default: module.DemoModeOverlay }))
);
const LazyNotificationCenterDock = lazyWithPreload(() =>
  import("./features/notifications/NotificationCenterDock.js").then((module) => ({ default: module.NotificationCenterDock })),
  { idle: true }
);
const LazyRoomAgentDock = lazyWithPreload(() =>
  import("./features/room-agent/RoomAgentDock.js").then((module) => ({ default: module.RoomAgentDock })),
  { idle: true }
);
const LazyMediaDock = lazyWithPreload(() =>
  import("./features/media-dock/MediaDock.js").then((module) => ({ default: module.MediaDock })),
  { idle: true }
);
const LazyStreamingDock = lazyWithPreload(() =>
  import("./features/streaming/StreamingDock.js").then((module) => ({ default: module.StreamingDock })),
  { idle: true }
);
const LazyCliDock = lazyWithPreload(() =>
  import("./features/cli-dock/CliDock.js").then((module) => ({ default: module.CliDock })),
  { idle: true }
);
const LazyAgentsDashboard = lazy(() => import("./features/agents-dashboard/AgentsDashboard.js").then(module => ({ default: module.AgentsDashboard })));

const LazyAgentSessionsDock = lazyWithPreload(() =>
  import("./features/agent-sessions/AgentSessionsDock.js").then((module) => ({ default: module.AgentSessionsDock })),
  { idle: true }
);
const LazyAgentFilesDock = lazyWithPreload(() =>
  import("./features/agent-files/AgentFilesDock.js").then((module) => ({ default: module.AgentFilesDock })),
  { idle: true }
);
const LazySharedChatDock = lazyWithPreload(() =>
  import("./features/shared-chat/SharedChatDock.js").then((module) => ({ default: module.SharedChatDock })),
  { idle: true }
);
const LazyNousDock = lazyWithPreload(() =>
  import("./features/nous/NousDock.js").then((module) => ({ default: module.NousDock })), { idle: true });
const LazyClipboardDock = lazyWithPreload(() =>
  import("./features/clipboard-dock/ClipboardDock.js").then((module) => ({ default: module.ClipboardDock })),
  { idle: true }
);
const LazyUiThemeSettingsCard = lazyWithPreload(() =>
  import("./features/ui-theme/UiThemeSettingsCard.js").then((module) => ({ default: module.UiThemeSettingsCard })),
  { idle: true }
);
const LazySourceControlPublishingCard = lazyWithPreload(() =>
  import("./features/source-control-publishing/SourceControlPublishingCard.js")
    .then((module) => ({ default: module.SourceControlPublishingCard })),
  { idle: true }
);
const LazySourceControlDock = lazyWithPreload(() => import("./features/source-control/SourceControlDock.js").then(module => ({ default: module.SourceControlDock })), { idle: true });
const LazyTelegramIntegrationCard = lazyWithPreload(() =>
  import("./features/telegram-integration/TelegramIntegrationCard.js")
    .then((module) => ({ default: module.TelegramIntegrationCard })),
  { idle: true }
);
const LazyConfigurationMigrationCard = lazyWithPreload(() =>
  import("./features/settings/ConfigurationMigrationCard.js")
    .then((module) => ({ default: module.ConfigurationMigrationCard })),
  { idle: true }
);
const LazyOnScreenKeyboard = lazy(() =>
  import("./features/osk-keyboard/OnScreenKeyboard.js").then((module) => ({ default: module.OnScreenKeyboard }))
);
const LazyCliLauncherMenu = CliLauncherMenu;
const LazyChatLauncherMenu = lazyWithPreload(() =>
  import("./features/chat-launcher/ChatLauncherMenu.js").then((module) => ({ default: module.ChatLauncherMenu })),
  { idle: true }
);
const LazyServerActionsMenu = lazyWithPreload(() =>
  import("./features/server-actions/ServerActionsMenu.js").then((module) => ({ default: module.ServerActionsMenu })),
  { idle: true }
);
const LazyPaneLayoutMenu = PaneLayoutMenu;
const LazyPaneSpanAllMenu = lazyWithPreload(() =>
  import("./features/pane-layout/PaneSpanAllMenu.js").then((module) => ({ default: module.PaneSpanAllMenu })),
  { idle: true }
);
const LazyVibeMusicPlayer = lazyWithPreload(() =>
  import("./features/vibe-music/VibeMusicPlayer.js").then((module) => ({ default: module.VibeMusicPlayer })),
  { idle: true }
);
const LazySnipToolOverlay = lazyWithPreload(() =>
  import("./features/snip-tool/SnipToolOverlay.js").then((module) => ({ default: module.SnipToolOverlay })),
  { idle: true }
);
const LazyEnvironmentPresetCard = lazyWithPreload(() =>
  import("./features/settings/EnvironmentPresetCard.js").then((module) => ({ default: module.EnvironmentPresetCard })),
  { idle: true }
);
const LazyGoogleAccountSettingsCard = lazyWithPreload(() =>
  import("./features/auth/GoogleAccountSettingsCard.js").then((module) => ({ default: module.GoogleAccountSettingsCard })),
  { idle: true }
);
const LazyDocksSettingsCard = lazyWithPreload(() =>
  import("./features/settings/DocksSettingsCard.js").then((module) => ({ default: module.DocksSettingsCard })),
  { idle: true }
);
const LazyPanesSettingsCard = lazyWithPreload(() =>
  import("./features/settings/PanesSettingsCard.js").then((module) => ({ default: module.PanesSettingsCard })),
  { idle: true }
);
const LazyWidgetsSettingsCard = lazyWithPreload(() =>
  import("./features/settings/WidgetsSettingsCard.js").then((module) => ({ default: module.WidgetsSettingsCard })),
  { idle: true }
);
const LazyDateTimeSettingsCard = lazyWithPreload(() =>
  import("./features/date-time-settings/DateTimeSettingsCard.js").then((module) => ({ default: module.DateTimeSettingsCard })),
  { idle: true }
);
const LazyAppDiagnosticsSettingsCard = lazyWithPreload(() =>
  import("./features/app-diagnostics/AppDiagnosticsSettingsCard.js")
    .then((module) => ({ default: module.AppDiagnosticsSettingsCard })),
  { idle: true }
);
const LazyReleasesSettingsCard = lazyWithPreload(() =>
  import("./features/releases/ReleasesSettingsCard.js")
    .then((module) => ({ default: module.ReleasesSettingsCard })),
  { idle: true }
);
const LazyPluginsSettingsCard = lazyWithPreload(() =>
  import("./features/plugins/PluginsSettingsCard.js").then((module) => ({ default: module.PluginsSettingsCard })),
  { idle: true }
);
const LazyAgentCapabilitiesCard = lazyWithPreload(() =>
  import("./features/agent-tools/AgentCapabilitiesCard.js").then((module) => ({ default: module.AgentCapabilitiesCard })),
  { idle: true }
);
const LazyKeyboardAutocorrectSettingsCard = lazyWithPreload(() =>
  import("./features/keyboard-autocorrect/KeyboardAutocorrectSettingsCard.js")
    .then((module) => ({ default: module.KeyboardAutocorrectSettingsCard })),
  { idle: true }
);
const LazyPromptVariablesSettingsCard = lazyWithPreload(() =>
  import("./features/prompt-variables/PromptVariablesSettingsCard.js")
    .then((module) => ({ default: module.PromptVariablesSettingsCard })),
  { idle: true }
);
const LazyDotsSettingsCard = lazyWithPreload(() =>
  import("./features/agent-pane/DotsSettingsCard.js").then((module) => ({ default: module.DotsSettingsCard })),
  { idle: true }
);
const LazyJobCopilotSettingsCard = lazyWithPreload(() =>
  import("./features/job-apply-pane/JobCopilotSettingsCard.js").then((module) => ({ default: module.JobCopilotSettingsCard })),
  { idle: true }
);
const LazyMailCopilotSettingsCard = lazyWithPreload(() =>
  import("./features/mail-copilot-pane/MailCopilotSettingsCard.js").then((module) => ({ default: module.MailCopilotSettingsCard })),
  { idle: true }
);
const LazyMarketingCopilotSettingsCard = lazyWithPreload(() => import("./features/marketing-copilot-pane/MarketingCopilotSettingsCard.js").then((module) => ({ default: module.MarketingCopilotSettingsCard })), { idle: true });
const LazyFreelanceCopilotSettingsCard = lazyWithPreload(() => import("./features/freelance-copilot-pane/FreelanceCopilotSettingsCard.js").then((module) => ({ default: module.FreelanceCopilotSettingsCard })), { idle: true });
const LazyDesignSettingsCard = lazyWithPreload(() => import("./features/design-pane/DesignSettingsCard.js").then((module) => ({ default: module.DesignSettingsCard })), { idle: true });
const sideSurfaceLoadingFallback = <div className="dock-muted-text" role="status">Loading panel…</div>;
/** The Settings dock's cards, in the dock's order; their declarations above keep the idle preload order. */
const agentSettingsCards: AgentSettingsCards = {
  EnvironmentPreset: LazyEnvironmentPresetCard,
  GoogleAccount: LazyGoogleAccountSettingsCard,
  UiTheme: LazyUiThemeSettingsCard,
  Docks: LazyDocksSettingsCard,
  Panes: LazyPanesSettingsCard,
  Widgets: LazyWidgetsSettingsCard,
  DateTime: LazyDateTimeSettingsCard,
  AppDiagnostics: LazyAppDiagnosticsSettingsCard,
  Releases: LazyReleasesSettingsCard,
  SourceControlPublishing: LazySourceControlPublishingCard,
  TelegramIntegration: LazyTelegramIntegrationCard,
  Plugins: LazyPluginsSettingsCard,
  AgentCapabilities: LazyAgentCapabilitiesCard,
  KeyboardAutocorrect: LazyKeyboardAutocorrectSettingsCard,
  PromptVariables: LazyPromptVariablesSettingsCard,
  ConfigurationMigration: LazyConfigurationMigrationCard,
  Dots: LazyDotsSettingsCard,
  JobCopilot: LazyJobCopilotSettingsCard,
  MailCopilot: LazyMailCopilotSettingsCard,
  MarketingCopilot: LazyMarketingCopilotSettingsCard, FreelanceCopilot: LazyFreelanceCopilotSettingsCard, Design: LazyDesignSettingsCard
};

const toolbarMenuLoadingFallback = <span className="sr-only" role="status">Loading menu…</span>;

const roomEventLimit = 50;
const ADMIN_MODE_REQUESTED_STORAGE_KEY = "space.adminModeRequested";
const ROOM_TOOLBAR_HIDDEN_ACTIONS_STORAGE_KEY = "space.roomToolbar.hiddenActionIds.v3";
const ROOM_TOOLBAR_ACTION_ORDER_STORAGE_KEY = "space.roomToolbar.actionOrder.v3";
const SELECTED_ROOM_ID_STORAGE_KEY = "space.selectedRoomId";
const SELECTED_PANE_ID_STORAGE_KEY = "space.selectedPaneId";
const MOBILE_SHELL_MAX_WIDTH = 767;
const TABLET_SHELL_MAX_WIDTH = 1100;
const ROOM_CLI_ACTIVITY_POLL_INTERVAL_MS = 5_000;
const SUPPORTED_CLIP_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

type ClipImageTarget = {
  roomId: string;
  paneId: string | null;
  paneMode: Pane["mode"] | null;
};

function readViewportWidth() {
  return typeof window === "undefined" ? 1440 : window.innerWidth;
}

function detectShellMode(width: number, mobileMaxWidth = MOBILE_SHELL_MAX_WIDTH): ShellMode {
  if (width <= mobileMaxWidth) return "mobile";
  if (width <= TABLET_SHELL_MAX_WIDTH) return "tablet";
  return "desktop";
}

function detectUiThemeShellMode(width: number, uiTheme: UiTheme): ShellMode {
  if (typeof window !== "undefined") {
    const mobileHint = (navigator as Navigator & { userAgentData?: { mobile?: boolean } }).userAgentData?.mobile;
    const userAgent = navigator.userAgent;
    const phoneUserAgent = /iPhone|iPod/i.test(userAgent) || (/Android/i.test(userAgent) && /\bMobile\b/i.test(userAgent));
    const tabletUserAgent = /iPad/i.test(userAgent) || (/Android/i.test(userAgent) && mobileHint !== true && !/\bMobile\b/i.test(userAgent));
    const screenShortSide = Math.min(window.screen.width, window.screen.height);
    const coarsePointer = window.matchMedia?.("(pointer: coarse)")?.matches ?? false;
    if (mobileHint === true || phoneUserAgent || (!tabletUserAgent && coarsePointer && screenShortSide > 0 && screenShortSide <= MOBILE_SHELL_MAX_WIDTH)) {
      return "mobile";
    }
    if ((tabletUserAgent || (coarsePointer && screenShortSide >= 768)) && width <= TABLET_SHELL_MAX_WIDTH) {
      return "tablet";
    }
  }
  return detectShellMode(width, MOBILE_SHELL_MAX_WIDTH);
}

function paneDensityFor(shellMode: ShellMode, paneCount: number): PaneDensity {
  if (shellMode === "desktop") {
    if (paneCount >= 12) return "tight";
    if (paneCount >= 8) return "dense";
    return "regular";
  }
  if (shellMode === "tablet") {
    return paneCount >= 6 ? "dense" : "regular";
  }
  return paneCount >= 6 ? "dense" : "regular";
}

const migratedCliToolbarStorages = new WeakSet<Storage>();

function migrateLegacyCliToolbarPreferences(storage: Storage): void {
  if (migratedCliToolbarStorages.has(storage)) return;
  migratedCliToolbarStorages.add(storage);
  const pairs: Array<readonly [string, string]> = [
    [`${PANE_TOOLBAR_HIDDEN_ACTIONS_STORAGE_KEY_PREFIX}.TERMINAL`, SHARED_CODEX_TOOLBAR_HIDDEN_STORAGE_KEY],
    [`${PANE_TOOLBAR_ACTION_ORDER_STORAGE_KEY_PREFIX}.TERMINAL`, SHARED_CODEX_TOOLBAR_ORDER_STORAGE_KEY]
  ];
  try {
    for (const [legacyKey, sharedKey] of pairs) {
      if (storage.getItem(sharedKey) !== null) continue;
      const legacyValue = storage.getItem(legacyKey);
      if (legacyValue !== null) storage.setItem(sharedKey, legacyValue);
    }
  } catch {
    // The toolbar still works with in-memory defaults when browser storage is unavailable.
  }
}

function pickCliMemorySaveModelId(models: Model[]): string {
  const exactMatch = models.find((model) => model.id === "gpt-5-mini");
  if (exactMatch) return exactMatch.id;
  const miniCodexModel = models.find((model) => model.providerId === "codex" && /mini/i.test(model.id));
  if (miniCodexModel) return miniCodexModel.id;
  const genericMiniModel = models.find((model) => /mini/i.test(model.id));
  return genericMiniModel?.id ?? "gpt-5-mini";
}

function dispatchAgentPaneAttachments(paneId: string, artifacts: Artifact[]) {
  dispatchAgentPaneAttachmentsEvent({ paneId, artifacts });
}

function dispatchBrowserPaneAction(paneId: string, action: BrowserPaneAction) {
  dispatchBrowserPaneActionEvent({ paneId, action });
}

function isRoomNotFoundError(error: unknown, roomId: string): boolean {
  if (!(error instanceof Error)) return false;
  return error.message.includes("NOT_FOUND") && error.message.includes(`Room ${roomId} was not found`);
}

function applyServerUserSettings(
  storage: Storage,
  settings: UserSettings,
  currentUiTheme: UiTheme,
  currentModernAppearance: ModernAppearance,
  currentModernIconPack: ModernIconPack,
  currentUiBackground: UiBackground = "spaceapp",
  userId?: string
): { themeChanged: boolean } {
  let { themeChanged } = syncFromServer(settings, storage, userId);
  if (settings.uiTheme && settings.uiTheme !== currentUiTheme) themeChanged = true;
  if (settings.modernAppearance && settings.modernAppearance !== currentModernAppearance) themeChanged = true;
  if (settings.modernIconPack && settings.modernIconPack !== currentModernIconPack) themeChanged = true;
  if (settings.uiBackground && settings.uiBackground !== currentUiBackground) themeChanged = true;
  return { themeChanged };
}

export function App() {
  useEffect(() => bindSpaceMediaVolume(), []);
  useEffect(() => clearLegacyCliShortcutUsage(), []);
  const runtime = getSpaceRuntime();
  const runtimeKind = getSpaceRuntimeKind();
  const { ensureServerSettings } = useVoiceInput();
  const {
    windows: stickyWindows,
    openNew: openStickyNote,
    closeWindow: closeStickyWindow,
    updateWindow: updateStickyWindow,
    bringToFront: bringStickyWindowToFront
  } = useStickyNoteWindows();
  const desktopWidgets = useDesktopWidgets();

  useEffect(() => {
    const handler = (e: Event) => {
      const item = (e as CustomEvent<ClipboardItem | null>).detail;
      openStickyNote(item);
    };
    window.addEventListener("space:sticky-note:open", handler);
    return () => window.removeEventListener("space:sticky-note:open", handler);
  }, [openStickyNote]);
  migrateLegacyCliToolbarPreferences(runtime.platform.localStorage);
  const [uiTheme] = useState<UiTheme>(() => readUiTheme(runtime.platform.localStorage));
  const [roomToolbarStorageKeys] = useState(() => {
    const storageKeys = uiTheme !== "classic"
      ? modernRoomToolbarStorageKeys()
      : {
          hidden: ROOM_TOOLBAR_HIDDEN_ACTIONS_STORAGE_KEY,
          order: ROOM_TOOLBAR_ACTION_ORDER_STORAGE_KEY
        };
    if (uiTheme !== "classic") {
      migrateModernToolbarPreference(
        runtime.platform.localStorage,
        ROOM_TOOLBAR_HIDDEN_ACTIONS_STORAGE_KEY,
        storageKeys.hidden
      );
      migrateModernToolbarPreference(
        runtime.platform.localStorage,
        ROOM_TOOLBAR_ACTION_ORDER_STORAGE_KEY,
        storageKeys.order
      );
    }
    return storageKeys;
  });
  const [modernAppearance] = useState<ModernAppearance>(() => readModernAppearance(runtime.platform.localStorage));
  const [modernIconPack] = useState<ModernIconPack>(() => readModernIconPack(runtime.platform.localStorage));
  const [uiBackground] = useState<UiBackground>(() => readUiBackground(runtime.platform.localStorage));
  const [liquidGlassTint, changeLiquidGlassTint] = useLiquidGlassTint(runtime.platform.localStorage);
  const [systemPrefersDark, setSystemPrefersDark] = useState(
    () => typeof window.matchMedia === "function" && window.matchMedia("(prefers-color-scheme: dark)").matches
  );
  const modernColorMode = uiTheme === "codex" || uiTheme === "motion" || uiTheme === "aurora" || uiTheme === "jarvis" || uiTheme === "aira" ? "dark" : resolveModernColorMode(modernAppearance, systemPrefersDark);
  useEffect(() => {
    document.documentElement.dataset.interfaceTheme = uiTheme;
    document.documentElement.dataset.uiBackground = uiBackground;
    return () => {
      delete document.documentElement.dataset.interfaceTheme;
      delete document.documentElement.dataset.uiBackground;
    };
  }, [uiTheme, uiBackground]);
  useEffect(() => {
    const body = document.body;
    const html = document.documentElement;
    body.setAttribute("data-ui-background", uiBackground);
    html.setAttribute("data-ui-background", uiBackground);
    if (uiTheme === "classic") {
      body.removeAttribute("data-ui-theme");
      body.removeAttribute("data-color-mode");
      body.removeAttribute("data-icon-pack");
      html.removeAttribute("data-color-mode");
      html.style.colorScheme = "dark";
      return () => {
        body.removeAttribute("data-ui-background");
        html.removeAttribute("data-ui-background");
      };
    }
    body.setAttribute("data-ui-theme", "modern");
    body.setAttribute("data-color-mode", modernColorMode);
    body.setAttribute("data-icon-pack", modernIconPack);
    html.setAttribute("data-color-mode", modernColorMode);
    html.style.colorScheme = modernColorMode;
    return () => {
      if (body.getAttribute("data-ui-theme") === "modern") body.removeAttribute("data-ui-theme");
      if (body.getAttribute("data-color-mode") === modernColorMode) body.removeAttribute("data-color-mode");
      if (body.getAttribute("data-icon-pack") === modernIconPack) body.removeAttribute("data-icon-pack");
      if (html.getAttribute("data-color-mode") === modernColorMode) html.removeAttribute("data-color-mode");
      body.removeAttribute("data-ui-background");
      html.removeAttribute("data-ui-background");
    };
  }, [modernColorMode, modernIconPack, uiTheme, uiBackground]);
  const [auth, setAuth] = useState<AuthMe | null>(null); const [startupReady, setStartupReady] = useState(false);
  const [adminModeRequested, setAdminModeRequestedState] = useState(() => readStoredBoolean(ADMIN_MODE_REQUESTED_STORAGE_KEY));
  const setAdminModeRequested = useCallback((next: boolean | ((current: boolean) => boolean)) => {
    setAdminModeRequestedState((current) => {
      const value = typeof next === "function" ? next(current) : next;
      try {
        runtime.platform.localStorage.setItem(ADMIN_MODE_REQUESTED_STORAGE_KEY, String(value));
      } catch {
        // storage unavailable
      }
      return value;
    });
  }, [runtime.platform.localStorage]);
  const isAdminMode = auth?.user?.role === "ADMIN" && adminModeRequested;
  const [isDemoModeActive, setIsDemoModeActive] = useState(false);
  const [setupStatus, setSetupStatus] = useState<SetupStatus | null>(null);
  const voiceSettingsAuthUserIdRef = useRef<string | null>(null);
  const toolbarVpn = useToolbarVpn({
    isAuthenticated: Boolean(auth?.isAuthenticated && startupReady),
    onRuntimeSettings: (settings) => setCliRuntimeSettings(settings)
  });
  const { toolbarVpnRoute, vpnCityPending, vpnCityNotice, setVpnCityNotice, vpnCityNoticeRef, rotateVpnCityFromToolbar } = toolbarVpn;

  useEffect(() => {
    const authenticatedUserId = auth?.isAuthenticated && startupReady ? auth.user?.id ?? "authenticated" : null;
    if (!authenticatedUserId) {
      voiceSettingsAuthUserIdRef.current = null;
      return;
    }
    if (voiceSettingsAuthUserIdRef.current === authenticatedUserId) return;
    voiceSettingsAuthUserIdRef.current = authenticatedUserId;
    void ensureServerSettings();
  }, [auth?.isAuthenticated, auth?.user?.id, ensureServerSettings, startupReady]);
  const [authBootstrapError, setAuthBootstrapError] = useState<string | null>(null);
  const [rooms, setRooms] = useState<Room[]>([]);

  // T3 Code is the owner's: warm its client bundle once the page is idle.
  useEffect(() => {
    if (auth?.user?.role === "ADMIN") scheduleT3BundlePrefetch();
  }, [auth?.user?.role]);

  const adminUsers = useAdminUsers(auth?.user?.role, rooms, startupReady);

  const [roomPaneCounts, setRoomPaneCounts] = useState<Record<string, number>>({});
  const [roomCliActivityCounts, setRoomCliActivityCounts] = useState<Record<string, number>>({});
  const [roomCliRuntimeIds, setRoomCliRuntimeIds] = useState<Record<string, string[]>>({});
  const [selectedRoomId, setSelectedRoomId] = useState<string | null>(() => readStoredSessionString(SELECTED_ROOM_ID_STORAGE_KEY));
  const [dotSettingsRequest, setDotSettingsRequest] = useState<DotSettingsRequest | null>(null);
  const [roomRuntimes, setRoomRuntimes] = useState<Record<string, RoomRuntimeSnapshot>>({});
  const [roomPaneLoadStates, setRoomPaneLoadStates] = useState<Record<string, RoomPaneLoadState>>({});
  const [displayedRoomId, setDisplayedRoomId] = useState<string | null>(selectedRoomId);
  const [preparingRoomId, setPreparingRoomId] = useState<string | null>(null);
  const [panes, setPanes] = useState<Pane[]>([]);
  const notices = useAppNotices();
  const { showLiveDebug } = notices;

  const [activeCategoryColorByRoom, setActiveCategoryColorByRoom] = useState<Record<string, PaneCategoryColor>>({});
  const [selectedPaneId, setSelectedPaneId] = useState<string | null>(() => readStoredSessionString(SELECTED_PANE_ID_STORAGE_KEY));
  const [shellMode, setShellMode] = useState<ShellMode>(() => detectUiThemeShellMode(readViewportWidth(), uiTheme));
  const [turns, setTurns] = useState<Turn[]>([]);
  const [roomEvents, setRoomEvents] = useState<SpaceEvent[]>([]);
  const bridgedPlanEventsRef = useRef(new Set<string>());
  useEffect(() => {
    // Presentation invalidation from the shared persisted room feed, including replay/fallback.
    for (const event of roomEvents) {
      if (event.type !== "PLAN_EXECUTION_UPDATED" || bridgedPlanEventsRef.current.has(event.id)) continue;
      bridgedPlanEventsRef.current.add(event.id);
      bridgePlanExecutionEvent(event);
    }
    if (bridgedPlanEventsRef.current.size > 256) {
      bridgedPlanEventsRef.current = new Set([...bridgedPlanEventsRef.current].slice(-256));
    }
  }, [roomEvents]);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [providerSettings, setProviderSettings] = useState<ProviderSettings | null>(null);
  const [models, setModels] = useState<Model[]>([]);
  const [skills, setSkills] = useState<Skill[]>([]);
  const [importCandidates, setImportCandidates] = useState<ImportCandidate[]>([]);
  const [swarmState, setSwarmState] = useState<SwarmState | null>(null);
  const [readiness, setReadiness] = useState<ReadyzPayload | null>(null);
  const [mcp, setMcp] = useState<McpPayload | null>(null);
  const [latestMcpSmoke, setLatestMcpSmoke] = useState<McpDiscoverySmokeCheck | null>(null);
  const [latestMemoryEmbeddingSmoke, setLatestMemoryEmbeddingSmoke] = useState<MemoryEmbeddingSmokeCheck | null>(null);
  const [latestMemoryVectorReadiness, setLatestMemoryVectorReadiness] = useState<MemoryVectorReadiness | null>(null);
  const [codexAppServer, setCodexAppServer] = useState<CodexAppServerStatus | null>(null);
  const [latestCodexHandshake, setLatestCodexHandshake] = useState<CodexAppServerHandshakeCheck | null>(null);
  const [latestCodexTurnSmoke, setLatestCodexTurnSmoke] = useState<CodexAppServerTurnSmokeCheck | null>(null);
  const [observability, setObservability] = useState<ObservabilitySnapshot | null>(null);
  const [workerReadiness, setWorkerReadiness] = useState<WorkerReadiness | null>(null);
  const [storageReadiness, setStorageReadiness] = useState<StorageReadiness | null>(null);
  const [codexEnvironmentSummary, setCodexEnvironmentSummary] = useState<CodexEnvironment | null>(null);
  // Panes only read isCodexEnabled; keep their prop stable across the 30 s
  // environment poll so cached rooms do not re-render on every check.
  const paneCodexEnabled = codexEnvironmentSummary ? codexEnvironmentSummary.isCodexEnabled : null;
  const paneCodexEnvironment = useMemo(
    () => (paneCodexEnabled === null ? null : { isCodexEnabled: paneCodexEnabled }),
    [paneCodexEnabled]
  );
  const isCodexEnabled = codexEnvironmentSummary?.isCodexEnabled ?? true;
  const [cliRuntimeSettings, setCliRuntimeSettings] = useState<CliRuntimeSettingsResponse | null>(null);
  const anyCliEnabled = cliRuntimeSettings?.settings.some((setting) => setting.enabled) ?? true;
  const isHarnessEnabled = cliRuntimeSettings?.harness?.enabled ?? true;
  const [restoredDock] = useState(() => readDockSession(runtime.platform.sessionStorage, Object.keys(sideSurfaceMeta)));
  const { hiddenDockIds, isDockHidden } = useDocksVisibility();
  const { hiddenPaneIds, isPaneHidden } = usePanesVisibility();
  const { hiddenWidgetIds, isWidgetHidden } = useWidgetsVisibility();

  useEffect(() => {
    preloadDockModules();
  }, []);

  const isBrowserFullscreen = useBrowserFullscreen();
  const userPreferences = useUserPreferences({ isAuthenticated: auth?.isAuthenticated, restoredDesktopOpen: restoredDock?.desktopOpen, uiTheme });
  const {
    terminalFontSize, setTerminalFontSize, cliImagePreviewLimit, warmRoomEnabled, warmConnectedPaneLimit, suppressNotifications,
    showSessionDebugIds, cliDebugModeEnabled, setCliDebugModeEnabled, cliFloatsHidden, maskSensitiveData, roomTheme, setRoomTheme,
    isRoomFocusMode, setIsRoomFocusMode, isRoomToolbarHidden, isDesktopSideSurfaceOpen, setIsDesktopSideSurfaceOpen, projectPresets,
    roomExtraEmptySlots, updateRoomExtraEmptySlots, isRoomWorktreeEnabled, toggleCliFloats, toggleMaskSensitiveData, toggleRoomFocusMode
  } = userPreferences;
  const deviceWarmPaneLimit = shellMode === "mobile" ? Math.min(warmConnectedPaneLimit, MOBILE_WARM_ROOM_CONNECTED_PANE_LIMIT) : warmConnectedPaneLimit;
  const sideSurfaces = useSideSurfaces({
    shellMode, restoredDock, isDesktopSideSurfaceOpen, setIsDesktopSideSurfaceOpen, runtimeKind,
    isAuthenticated: auth?.isAuthenticated, role: auth?.user?.role, isDockHidden
  });
  const {
    activeSideSurface, setActiveSideSurface, isCompactSideSurfaceOpen, setIsCompactSideSurfaceOpen, sourceControlEnabled,
    sourceControlAvailable, isCompactShell, isSideSurfaceOpen, showInlineSideSurface, showOverlaySideSurface,
    sideSurfaceToggleLabel, closeCompactSideSurface, toggleSideSurface, openSideSurface
  } = sideSurfaces;
  const appDiagnosticsState = useDiagnosticsState();
  const [debugModePending, setDebugModePending] = useState(false);
  const canManageDiagnostics = auth?.user?.role === "ADMIN";
  const isAppDiagnosticsEnabled = Boolean(appDiagnosticsState.status?.isEnabled);
  const isDebugModeActive = canManageDiagnostics ? isAppDiagnosticsEnabled : cliDebugModeEnabled;

  const toggleDebugMode = useCallback(async () => {
    if (debugModePending) return;
    const nextEnabled = !isDebugModeActive;
    setDebugModePending(true);
    try {
      try {
        const updated = await api.updateAppDiagnosticsStatus(nextEnabled);
        await applyAppDiagnosticsStatus(updated);
      } catch (diagError) {
        console.warn("App diagnostics update error:", diagError);
      }
      setCliDebugModeEnabled(nextEnabled);
    } catch (error) {
      console.error("Failed to toggle debug mode", error);
    } finally {
      setDebugModePending(false);
    }
  }, [debugModePending, isDebugModeActive]);
  const gatewayCompression = useGatewayCompressionToggle({ enabled: auth?.user?.role === "ADMIN" && startupReady });
  const toolbarPopovers = useToolbarPopovers();
  const {
    isThemeMenuOpen, setIsThemeMenuOpen, isPaneLayoutMenuOpen, setIsPaneLayoutMenuOpen, isCollapsedPaneLayoutMenuOpen,
    setIsCollapsedPaneLayoutMenuOpen, isPaneSpanAllMenuOpen, setIsPaneSpanAllMenuOpen, isWorkspaceTextSizePickerOpen,
    setIsWorkspaceTextSizePickerOpen, isCliLauncherOpen, setIsCliLauncherOpen, isChatLauncherOpen, setIsChatLauncherOpen,
    isVibeMusicOpen, setIsVibeMusicOpen, isOskKeyboardOpen, setIsOskKeyboardOpen, isQuickLinksOpen, setIsQuickLinksOpen,
    lowerRailVisibilityMenu, setLowerRailVisibilityMenu, boardToolbarRef, roomToolbarActionsRef, roomToolbarScrollRef,
    collapsedToolbarRef, roomOverflowTriggerRef, cliLauncherButtonRef, chatLauncherButtonRef, cliLauncherReturnFocusRef,
    workspaceTextSizeButtonRef, vibeMusicButtonRef, quickLinksButtonRef, paneLayoutButtonRef, paneLayoutCollapsedButtonRef,
    paneSpanAllButtonRef, roomThemeButtonRef, closePaneLayoutMenu, closePaneSpanAllMenu
  } = toolbarPopovers;
  const [paneLayoutPending, setPaneLayoutPending] = useState(false);
  const paneLayoutSequenceRef = useRef(0);
  const [paneLayoutError, setPaneLayoutError] = useState<string | null>(null);
  const [paneSpanAllPending, setPaneSpanAllPending] = useState(false);
  const paneSpanSequenceRef = useRef(0);
  const [paneSpanAllError, setPaneSpanAllError] = useState<string | null>(null);
  const [cliPaneCreationPending, setCliPaneCreationPending] = useState(false);
  const snipTool = useSnipTool();
  const { isSnipToolOpen, setIsSnipToolOpen, snipToolInitialModeRef } = snipTool;
  const oskKeyboardMountedRef = useRef(false);
  const manage = useManageController({ role: auth?.user?.role, onReadiness: setReadiness, onEnvironment: setCodexEnvironmentSummary });
  const {
    serverActionsButtonRef, adminOperationToolTriggerRef, isServerActionsMenuOpen, setIsServerActionsMenuOpen, manageLoginPending,
    manageLoginPendingRef, setManageLoginPending, isSetupConnectionsOpen, setIsSetupConnectionsOpen, workspaceSetupHost,
    setWorkspaceSetupHost, workspaceSetupBack, setupFromWorkspace
  } = manage;
  const [restoreAllPending, setRestoreAllPending] = useState(false);
  const [minimizeAllPending, setMinimizeAllPending] = useState(false);
  const [isAgentsDashboardOpen, setIsAgentsDashboardOpen] = useState(false);
  const [agentsDashboardSummary, setAgentsDashboardSummary] = useState<AgentDashboardSummary | null>(null);
  const [isMemoryWorkspaceOpen, setIsMemoryWorkspaceOpen] = useState(false);
  // Space Gateway as a full-screen page over the workspace, like the memory workspace (ADMIN).
  const [isSpaceGatewayOpen, setIsSpaceGatewayOpen] = useState(false);
  const [workspaceNavigationDetail, setWorkspaceNavigationDetail] = useState<string | null>(null);
  const [workspaceUserLink, setWorkspaceUserLink] = useState<UserLink | null>(null);
  const [workspaceStickyItem, setWorkspaceStickyItem] = useState<ClipboardItem | null>(null);
  const roomDeleteConfirm = useDockConfirm();
  useEffect(() => {
    if (workspaceNavigationDetail !== "link-preview") setWorkspaceUserLink(null);
  }, [workspaceNavigationDetail]);
  const [workspaceMusicHost, setWorkspaceMusicHost] = useState<HTMLDivElement | null>(null);
  const workspaceMusicBack = useRef<(() => void) | null>(null);
  const [workspaceKeyboardHost, setWorkspaceKeyboardHost] = useState<HTMLDivElement | null>(null);
  const workspaceKeyboardBack = useRef<(() => void) | null>(null);
  const [resourceIndicatorsVisible, toggleResourceIndicators] = useResourceIndicators(auth?.user?.id);
  const [systemAnalyticsTab, setSystemAnalyticsTab] = useState<SystemAnalyticsTab | null>(null);
  useEffect(() => {
    if (systemAnalyticsTab) {
      openSystemHealth("analytics", systemAnalyticsTab);
      setSystemAnalyticsTab(null);
    }
  }, [systemAnalyticsTab]);

  const [activeUserLink, setActiveUserLink] = useState<UserLink | null>(null);
  const [isRoomToolbarStacked, setIsRoomToolbarStacked] = useState(false);
  const [paneMoveDialog, setPaneMoveDialog] = useState<{
    pane: Pane;
    targetRoomId: string;
    pending: boolean;
    error: string | null;
  } | null>(null);
  const [paneMoveNotice, setPaneMoveNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const roomsDock = useRoomsDock({ rooms, setRooms, reportError: setError, addNamedProjectPreset: userPreferences.addNamedProjectPreset });
  const { adminRoomFilterMode, adminSelectedUserId, dockProjectPathDrafts } = roomsDock;
  const [paneReorderPending, setPaneReorderPending] = useState(false);
  const [draggedPaneId, setDraggedPaneId] = useState<string | null>(null);
  const [paneDragOverId, setPaneDragOverId] = useState<string | null>(null);
  const [paneDragOverPosition, setPaneDragOverPosition] = useState<PaneDropPosition>("before");
  const [dragOverSlotKey, setDragOverSlotKey] = useState<string | null>(null);
  const [paneCreationPendingMode, setPaneCreationPendingMode] = useState<Pane["mode"] | null>(null);
  const [roomCreationPending, setRoomCreationPending] = useState(false);
  const [deletePendingRoomId, setDeletePendingRoomId] = useState<string | null>(null);
  const [paneCompletionLifecycle, setPaneCompletionLifecycle] = useState<PaneCompletionLifecycleState>(
    createPaneCompletionLifecycleState
  );
  const rootRemSize = useRootRemSize();
  const [paneGridWidth, setPaneGridWidth] = useState(() => readViewportWidth());
  const [paneGridHeight, setPaneGridHeight] = useState(0);
  const [pendingBrowserHandoffPaneId, setPendingBrowserHandoffPaneId] = useState<string | null>(null);
  const [copilotLaunch, setCopilotLaunch] = useState<{ kind: CopilotKind; roomId: string; count: number; preselect: CopilotLaunchSettings | null; notice: string | null } | null>(null);
  const [activeRoomEventStreamStatus, setActiveRoomEventStreamStatus] = useState<ActiveRoomEventStreamStatus>("idle");
  const cliMemorySaveModelId = useMemo(() => pickCliMemorySaveModelId(models), [models]);
  const previousShellModeRef = useRef<ShellMode | null>(null);
  const previousSelectedRoomIdRef = useRef<string | null>(null);
  const previousSelectedPaneIdRef = useRef<string | null>(null);
  const selectedRoomIdRef = useRef(selectedRoomId);
  const selectedPaneIdRef = useRef(selectedPaneId);
  const panesRef = useRef(panes);
  const turnsRef = useRef(turns);
  const roomEventsRef = useRef(roomEvents);
  const paneCompletionLifecycleRef = useRef(paneCompletionLifecycle);
  const swarmStateRef = useRef(swarmState);
  const roomRuntimesRef = useRef(roomRuntimes);
  const activeRuntimeRoomIdRef = useRef(selectedRoomId);
  const previousWarmRoomIdRef = useRef<string | null>(null);
  const displayedRoomIdRef = useRef<string | null>(displayedRoomId);
  const preparingRoomIdRef = useRef<string | null>(null);
  const roomPresentationGenerationRef = useRef(0);
  const scheduledRoomRevealRef = useRef<{ roomId: string; generation: number } | null>(null);
  const roomPresentationFailureTimeoutRef = useRef<number | null>(null);
  const roomPresentationMetricRef = useRef<{
    roomId: string;
    generation: number;
    startedAt: number;
    readyReported: boolean;
  } | null>(null);
  const roomRevealReadyPaneIdsRef = useRef(new Map<string, Set<string>>());
  const roomPresentedGeometryRef = useRef(new Map<string, string>());
  const warmPreparedGeometryRef = useRef(new Map<string, string>());
  const roomRevealDebugLastMissingRef = useRef(new Map<string, string>());
  const roomTerminalBarrierWaitersRef = useRef(new Map<string, Set<() => void>>());
  const roomTerminalPrefillBarrierWaitersRef = useRef(new Map<string, Set<() => void>>());
  const roomRuntimeHydrationIdsRef = useRef(new Set<string>());
  const paneCompletionInitialReplayRoomIdsRef = useRef(new Set<string>());
  const roomPaneRequestSequenceRef = useRef(new Map<string, number>());
  const roomTurnsRequestSequenceRef = useRef(new Map<string, number>());
  const roomSwarmRequestSequenceRef = useRef(new Map<string, number>());
  const roomEventsRequestSequenceRef = useRef(new Map<string, number>());
  const roomPaneLoadPromisesRef = useRef(new Map<string, Promise<void>>());
  const roomTurnsLoadPromisesRef = useRef(new Map<string, Promise<void>>());
  const roomSwarmLoadPromisesRef = useRef(new Map<string, Promise<void>>());
  const roomEventsLoadPromisesRef = useRef(new Map<string, Promise<void>>());
  const settingsSurfaceDataPromiseRef = useRef<Promise<void> | null>(null);
  const healthSurfaceDataPromiseRef = useRef<Promise<void> | null>(null);
  const settingsSurfaceDataLoadedRef = useRef(false);
  const healthSurfaceDataLoadedRef = useRef(false);
  const [healthSurfaceError, setHealthSurfaceError] = useState<string | null>(null);
  const roomRuntimeLastPolledAtRef = useRef(new Map<string, number>());
  const roomRefreshQueueRef = useRef(createCoalescedRefreshQueue());
  const roomCatalogRefreshQueueRef = useRef(createCoalescedRefreshQueue());
  const requestRoomCatalogRefreshRef = useRef<() => Promise<void>>(async () => undefined);
  const warmRoomIdsRef = useRef<string[]>([]);
  const appMountedRef = useRef(true);
  const roomPaneLoadStatesRef = useRef(roomPaneLoadStates);
  const clipImageInputRef = useRef<HTMLInputElement | null>(null);
  const pendingClipImageTargetRef = useRef<ClipImageTarget | null>(null);
  const isCapturingScreenRef = useRef(false);
  const cliPaneCreationPendingRef = useRef(false);
  const paneCreationPendingRef = useRef(false);
  const roomCreationPendingRef = useRef(false);
  const lowerRailTouchContext = useTouchContextMenu(
    (source) => source instanceof Element && !source.closest(".room-live-rail-button, .touch-context-menu-trigger")
      ? source.closest<HTMLElement>(".room-toolbar-collapsed > button, .room-toolbar-collapsed > .toolbar-overflow > button")
      : null,
    ({ x, y }) => setLowerRailVisibilityMenu((current) => current ? null : { x, y })
  );
  const lowerRailVisibility = useRailVisibility(LOWER_RAIL_HIDDEN_KEY, LOWER_RAIL_VISIBILITY_IDS, LOWER_RAIL_NON_HIDEABLE);
  const toolbarMetricsRef = useRef<ToolbarMetricsHandle | null>(null);
  const paneGridRef = useRef<HTMLDivElement | null>(null);
  const minimizedPaneRestoreRefs = useRef(new Map<string, HTMLButtonElement>());
  const pendingPaneHeaderFocusIdRef = useRef<string | null>(null);
  const paneColumnAnchorStartsRef = useRef<PaneColumnAnchorMap>(new Map());
  const previousPaneGridColumnCountRef = useRef<number | null>(null);
  const handledBrowserHandoffEventIdsRef = useRef(new Set<string>());
  const loadRoomRuntimeRef = useRef<(
    roomId: string,
    onPanesLoaded?: () => void,
    options?: { loadMetadata?: boolean }
  ) => Promise<void>>(async () => undefined);
  const refreshHiddenRoomRuntimeRef = useRef<(roomId: string) => Promise<void>>(async () => undefined);
  const loadRoomPanesRef = useRef<(roomId: string) => Promise<void>>(async () => undefined);
  const loadRoomTurnsRef = useRef<(roomId: string) => Promise<void>>(async () => undefined);
  const loadRoomSwarmRef = useRef<(roomId: string) => Promise<void>>(async () => undefined);
  const loadRoomEventsRef = useRef<(roomId: string) => Promise<void>>(async () => undefined);
  const requestRoomRefreshRef = useRef<(
    roomId: string,
    category: RoomRefreshCategory,
    reason: string
  ) => Promise<void>>(async () => undefined);

  selectedRoomIdRef.current = selectedRoomId;
  selectedPaneIdRef.current = selectedPaneId;
  panesRef.current = panes;
  turnsRef.current = turns;
  roomEventsRef.current = roomEvents;
  swarmStateRef.current = swarmState;
  roomRuntimesRef.current = roomRuntimes;
  roomPaneLoadStatesRef.current = roomPaneLoadStates;
  displayedRoomIdRef.current = displayedRoomId;
  preparingRoomIdRef.current = preparingRoomId;
  requestRoomCatalogRefreshRef.current = () =>
    roomCatalogRefreshQueueRef.current.request("rooms", async () => {
      const roomCatalog = await loadBoundedRoomCatalog();
      if (!appMountedRef.current) return;
      const nextRooms = sortRoomsByOrder(roomCatalog);
      setRooms((current) => reuseVersionedItems(current, nextRooms, (room) => room.updatedAt));
      const missingRoomId = selectedRoomIdRef.current;
      if (!missingRoomId || nextRooms.some((room) => room.id === missingRoomId)) return;

      const nextRoom = nextRooms[0] ?? null;
      activateRoom(nextRoom?.id ?? null);
      removeRoomRuntime(missingRoomId);
      // A vanished room switches silently (operator request 2026-10-14): no "no longer exists" notice.
      if (nextRoom) await loadRoomRuntimeRef.current(nextRoom.id);
    });

  useSpaceClipboardCapture(Boolean(auth?.isAuthenticated));

  useEffect(() => {
    appMountedRef.current = true;
    return () => {
      appMountedRef.current = false;
      if (roomPresentationFailureTimeoutRef.current !== null) {
        window.clearTimeout(roomPresentationFailureTimeoutRef.current);
        roomPresentationFailureTimeoutRef.current = null;
      }
    };
  }, []);

  useLayoutEffect(() => {
    const paneId = pendingPaneHeaderFocusIdRef.current;
    const pane = panes.find((candidate) => candidate.id === paneId);
    if (!paneId || !pane || pane.isMinimized) return;
    const paneElement = Array.from(document.querySelectorAll<HTMLElement>("[data-space-pane-id]")).find(
      (element) => element.dataset.spacePaneId === paneId
    );
    if (!paneElement || paneElement.getAttribute("aria-hidden") === "true") return;
    const paneHeader = paneElement.querySelector<HTMLElement>("header");
    if (!paneHeader) return;
    paneHeader.focus();
    if (document.activeElement === paneHeader) pendingPaneHeaderFocusIdRef.current = null;
  }, [panes]);

  const { appView, setAppView, openHelp, closeHelp, openBenchmark, closeBenchmark } = useAppView({ onLeaveWorkspace: () => setIsVibeMusicOpen(false) });

  function roomRuntimeSnapshotsEqual(left: RoomRuntimeSnapshot | undefined, right: RoomRuntimeSnapshot): boolean {
    if (!left) return false;
    return left.roomId === right.roomId &&
      left.panes === right.panes &&
      left.turns === right.turns &&
      left.events === right.events &&
      left.swarm === right.swarm &&
      left.selectedPaneId === right.selectedPaneId &&
      left.bootstrappedPaneIds === right.bootstrappedPaneIds &&
      left.prefillReadyPaneIds === right.prefillReadyPaneIds &&
      left.lastAccessedAt === right.lastAccessedAt;
  }

  function replaceRoomRuntime(snapshot: RoomRuntimeSnapshot) {
    if (roomRuntimeSnapshotsEqual(roomRuntimesRef.current[snapshot.roomId], snapshot)) return;
    const next = { ...roomRuntimesRef.current, [snapshot.roomId]: snapshot };
    roomRuntimesRef.current = next;
    setRoomRuntimes((current) => {
      if (roomRuntimeSnapshotsEqual(current[snapshot.roomId], snapshot)) return current;
      return { ...current, [snapshot.roomId]: snapshot };
    });
  }

  function setRoomPaneLoadState(roomId: string, state: RoomPaneLoadState | null) {
    const current = roomPaneLoadStatesRef.current;
    if (state === null) {
      if (!current[roomId]) return;
      const next = { ...current };
      delete next[roomId];
      roomPaneLoadStatesRef.current = next;
      setRoomPaneLoadStates(next);
      return;
    }
    if (current[roomId] === state) return;
    const next = { ...current, [roomId]: state };
    roomPaneLoadStatesRef.current = next;
    setRoomPaneLoadStates(next);
  }

  function removeRoomRuntime(roomId: string) {
    roomPresentedGeometryRef.current.delete(roomId);
    warmPreparedGeometryRef.current.delete(roomId);
    roomRuntimeLastPolledAtRef.current.delete(roomId);
    warmRoomIdsRef.current = warmRoomIdsRef.current.filter((candidate) => candidate !== roomId);
    roomRevealReadyPaneIdsRef.current.delete(roomId);
    const barrierWaiters = roomTerminalBarrierWaitersRef.current.get(roomId);
    roomTerminalBarrierWaitersRef.current.delete(roomId);
    for (const resolve of barrierWaiters ?? []) resolve();
    const prefillBarrierWaiters = roomTerminalPrefillBarrierWaitersRef.current.get(roomId);
    roomTerminalPrefillBarrierWaitersRef.current.delete(roomId);
    for (const resolve of prefillBarrierWaiters ?? []) resolve();
    if (scheduledRoomRevealRef.current?.roomId === roomId) {
      scheduledRoomRevealRef.current = null;
    }
    roomPaneRequestSequenceRef.current.set(roomId, (roomPaneRequestSequenceRef.current.get(roomId) ?? 0) + 1);
    roomTurnsRequestSequenceRef.current.set(roomId, (roomTurnsRequestSequenceRef.current.get(roomId) ?? 0) + 1);
    roomSwarmRequestSequenceRef.current.set(roomId, (roomSwarmRequestSequenceRef.current.get(roomId) ?? 0) + 1);
    roomEventsRequestSequenceRef.current.set(roomId, (roomEventsRequestSequenceRef.current.get(roomId) ?? 0) + 1);
    roomPaneLoadPromisesRef.current.delete(roomId);
    roomTurnsLoadPromisesRef.current.delete(roomId);
    roomSwarmLoadPromisesRef.current.delete(roomId);
    roomEventsLoadPromisesRef.current.delete(roomId);
    setRoomPaneLoadState(roomId, null);
    if (!roomRuntimesRef.current[roomId]) return;
    const next = { ...roomRuntimesRef.current };
    delete next[roomId];
    roomRuntimesRef.current = next;
    setRoomRuntimes((current) => {
      if (!current[roomId]) return current;
      const retained = { ...current };
      delete retained[roomId];
      return retained;
    });
  }

  function snapshotActiveRoom(roomId: string, lastAccessedAt?: number): RoomRuntimeSnapshot {
    const existing = roomRuntimesRef.current[roomId];
    return {
      roomId,
      panes: panesRef.current,
      turns: turnsRef.current,
      events: roomEventsRef.current,
      swarm: swarmStateRef.current,
      selectedPaneId: selectedPaneIdRef.current,
      bootstrappedPaneIds: existing?.bootstrappedPaneIds ?? [],
      prefillReadyPaneIds: existing?.prefillReadyPaneIds ?? [],
      lastAccessedAt: lastAccessedAt ?? existing?.lastAccessedAt ?? Date.now()
    };
  }

  function applyRoomRuntime(snapshot: RoomRuntimeSnapshot) {
    panesRef.current = snapshot.panes;
    turnsRef.current = snapshot.turns;
    roomEventsRef.current = snapshot.events;
    swarmStateRef.current = snapshot.swarm;
    selectedPaneIdRef.current = snapshot.selectedPaneId;
    setPanes(snapshot.panes);
    setTurns(snapshot.turns);
    setRoomEvents(snapshot.events);
    setSwarmState(snapshot.swarm);
    setSelectedPaneId(snapshot.selectedPaneId);
  }

  function clearActiveRoomRuntime() {
    panesRef.current = [];
    turnsRef.current = [];
    roomEventsRef.current = [];
    swarmStateRef.current = null;
    selectedPaneIdRef.current = null;
    setPanes([]);
    setTurns([]);
    setRoomEvents([]);
    setSwarmState(null);
    setSelectedPaneId(null);
  }

  function visibleTerminalPaneIds(snapshot: RoomRuntimeSnapshot): string[] {
    const fullscreenLayout = rooms.find((room) => room.id === snapshot.roomId)?.paneLayoutColumns === 0;
    const shellVisibleIds = new Set(
      shellVisiblePaneIds(snapshot.panes, snapshot.selectedPaneId, shellMode, fullscreenLayout)
    );
    return snapshot.panes
      .filter((pane) => pane.mode === "TERMINAL" && shellVisibleIds.has(pane.id))
      .map((pane) => pane.id);
  }

  function roomTerminalBarrierReady(roomId: string): boolean {
    const snapshot = roomRuntimesRef.current[roomId];
    if (!snapshot) return false;
    const bootstrapped = new Set(snapshot.bootstrappedPaneIds);
    return visibleTerminalPaneIds(snapshot).every((paneId) => bootstrapped.has(paneId));
  }

  function notifyRoomTerminalBarrier(roomId: string) {
    if (!roomTerminalBarrierReady(roomId)) return;
    const waiters = roomTerminalBarrierWaitersRef.current.get(roomId);
    roomTerminalBarrierWaitersRef.current.delete(roomId);
    for (const resolve of waiters ?? []) resolve();
  }

  async function waitForRoomTerminalBarrier(roomId: string, timeoutMs = 5_000): Promise<void> {
    if (getSpaceRuntimeKind() === "demo" || roomTerminalBarrierReady(roomId)) return;
    await new Promise<void>((resolve) => {
      let timer = 0;
      const finish = () => {
        window.clearTimeout(timer);
        roomTerminalBarrierWaitersRef.current.get(roomId)?.delete(finish);
        resolve();
      };
      const waiters = roomTerminalBarrierWaitersRef.current.get(roomId) ?? new Set<() => void>();
      waiters.add(finish);
      roomTerminalBarrierWaitersRef.current.set(roomId, waiters);
      timer = window.setTimeout(finish, timeoutMs);
    });
  }

  function roomTerminalPrefillBarrierReady(roomId: string): boolean {
    const snapshot = roomRuntimesRef.current[roomId];
    if (!snapshot) return false;
    const readyPaneIds = new Set(snapshot.prefillReadyPaneIds);
    return snapshot.panes
      .filter((pane) => pane.mode === "TERMINAL" && !pane.isMinimized)
      .every((pane) => readyPaneIds.has(pane.id));
  }

  function notifyRoomTerminalPrefillBarrier(roomId: string) {
    if (!roomTerminalPrefillBarrierReady(roomId)) return;
    const waiters = roomTerminalPrefillBarrierWaitersRef.current.get(roomId);
    roomTerminalPrefillBarrierWaitersRef.current.delete(roomId);
    for (const resolve of waiters ?? []) resolve();
  }

  async function waitForRoomTerminalPrefillBarrier(roomId: string, timeoutMs = 2_000): Promise<boolean> {
    if (getSpaceRuntimeKind() === "demo" || roomTerminalPrefillBarrierReady(roomId)) return true;
    return new Promise<boolean>((resolve) => {
      let timer = 0;
      const finish = () => {
        window.clearTimeout(timer);
        roomTerminalPrefillBarrierWaitersRef.current.get(roomId)?.delete(finishReady);
        resolve(roomTerminalPrefillBarrierReady(roomId));
      };
      const finishReady = () => {
        window.clearTimeout(timer);
        roomTerminalPrefillBarrierWaitersRef.current.get(roomId)?.delete(finishReady);
        resolve(true);
      };
      const waiters = roomTerminalPrefillBarrierWaitersRef.current.get(roomId) ?? new Set<() => void>();
      waiters.add(finishReady);
      roomTerminalPrefillBarrierWaitersRef.current.set(roomId, waiters);
      timer = window.setTimeout(finish, timeoutMs);
    });
  }

  function clearRoomPresentationFailureTimeout() {
    if (roomPresentationFailureTimeoutRef.current === null) return;
    window.clearTimeout(roomPresentationFailureTimeoutRef.current);
    roomPresentationFailureTimeoutRef.current = null;
  }

  function recordRoomPresentationMetric(
    roomId: string,
    generation: number,
    phase: "START" | "READY" | "COMPLETE" | "ERROR"
  ) {
    const metric = roomPresentationMetricRef.current;
    if (!metric || metric.roomId !== roomId || metric.generation !== generation) return;
    if (phase === "READY") {
      if (metric.readyReported) return;
      metric.readyReported = true;
    }
    emitAppDiagnosticsPerformance({
      category: "PERFORMANCE",
      metric: "ROOM_PRESENTATION",
      roomId,
      phase,
      durationMs: Math.max(0, Date.now() - metric.startedAt),
      value: generation
    });
    if (phase === "COMPLETE" || phase === "ERROR") {
      roomPresentationMetricRef.current = null;
    }
  }

  function schedulePreparedRoomReveal(roomId: string, generation: number) {
    if (
      scheduledRoomRevealRef.current?.roomId === roomId &&
      scheduledRoomRevealRef.current.generation === generation
    ) return;
    scheduledRoomRevealRef.current = { roomId, generation };
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        if (
          roomPresentationGenerationRef.current !== generation ||
          preparingRoomIdRef.current !== roomId ||
          selectedRoomIdRef.current !== roomId
        ) return;
        scheduledRoomRevealRef.current = null;
        clearRoomPresentationFailureTimeout();
        recordRoomPresentationMetric(roomId, generation, "COMPLETE");
        displayedRoomIdRef.current = roomId;
        preparingRoomIdRef.current = null;
        setDisplayedRoomId(roomId);
        setPreparingRoomId(null);
      });
    });
  }

  function finishPreparingRoomWhenReady(roomId: string) {
    if (preparingRoomIdRef.current !== roomId || selectedRoomIdRef.current !== roomId) return;
    const snapshot = roomRuntimesRef.current[roomId];
    if (!snapshot || roomPaneLoadStatesRef.current[roomId] !== "loaded") return;
    // User-approved 2026-08-14: reveal as soon as pane data is loaded — panes
    // fill in afterwards. The old per-pane reveal barrier deadlocked when
    // session-less orphan panes existed (Room 6: 12/16 ready, the 4 orphans
    // never reported, 8s timeout on every open).
    recordRoomPresentationMetric(roomId, roomPresentationGenerationRef.current, "READY");
    schedulePreparedRoomReveal(roomId, roomPresentationGenerationRef.current);
  }

  function recordTerminalRevealReady(roomId: string, paneId: string, generation: number) {
    if (
      generation !== roomPresentationGenerationRef.current ||
      preparingRoomIdRef.current !== roomId ||
      selectedRoomIdRef.current !== roomId
    ) return;
    const readyPaneIds = roomRevealReadyPaneIdsRef.current.get(roomId) ?? new Set<string>();
    if (readyPaneIds.has(paneId)) return;
    readyPaneIds.add(paneId);
    roomRevealReadyPaneIdsRef.current.set(roomId, readyPaneIds);
    // DEBUG (user-requested 2026-08-14): which panes report ready.
    emitAppDiagnosticsPerformance({
      category: "PERFORMANCE",
      metric: "ROOM_REVEAL_PROGRESS",
      roomId,
      paneId,
      phase: "PANE_READY",
      durationMs: 0
    });
    finishPreparingRoomWhenReady(roomId);
  }

  function roomPresentationGeometryKey(roomId: string): string {
    const room = rooms.find(candidate => candidate.id === roomId);
    const snapshot = roomRuntimesRef.current[roomId];
    // State and viewport numbers only: no synchronous layout measurement.
    return JSON.stringify([
      window.innerWidth, window.innerHeight, window.devicePixelRatio,
      shellMode, paneGridWidth, paneGridHeight, rootRemSize, terminalFontSize,
      room?.updatedAt, room?.paneLayoutColumns, room?.paneLayoutHeight,
      snapshot?.panes.map(pane => [pane.id, pane.updatedAt])
    ]);
  }

  function scheduleWarmRoomPreparation(roomId: string) {
    if (!warmRoomEnabled || selectedRoomIdRef.current === roomId || warmPreparedGeometryRef.current.has(roomId)) return;
    const attempt = (remainingFrames: number) => window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        if (!appMountedRef.current || selectedRoomIdRef.current === roomId) return;
        const layer = Array.from(document.querySelectorAll<HTMLElement>(".room-runtime-layer"))
          .find((candidate) => candidate.dataset.roomRuntimeId === roomId);
        if (!layer || layer.dataset.presentationState !== "hidden") {
          if (remainingFrames > 0) attempt(remainingFrames - 1);
          return;
        }
        layer.dataset.warmPrepared = "true";
        // Force the browser to resolve the prepared room's style/layout while
        // it is still hidden, so the first reveal does not pay that cost.
        void layer.offsetHeight;
        warmPreparedGeometryRef.current.set(roomId, roomPresentationGeometryKey(roomId));
      });
    });
    attempt(3);
  }

  function canImmediatelyPresentWarmCliRoom(roomId: string): boolean {
    if (document.visibilityState === "hidden" ||
        ![roomPresentedGeometryRef.current.get(roomId), warmPreparedGeometryRef.current.get(roomId)]
          .includes(roomPresentationGeometryKey(roomId))) return false;
    if (!warmRoomEnabled || !warmRoomIdsRef.current.includes(roomId) ||
        roomPaneLoadStatesRef.current[roomId] !== "loaded" ||
        !roomTerminalBarrierReady(roomId) || !roomTerminalPrefillBarrierReady(roomId)) return false;
    const snapshot = roomRuntimesRef.current[roomId];
    if (!snapshot) return false;
    const visibleIds = visibleTerminalPaneIds(snapshot);
    // Keep mixed/browser rooms and empty rooms on the existing reveal path.
    if (!visibleIds.length || snapshot.panes.some(pane => !pane.isMinimized && pane.mode !== "TERMINAL")) return false;
    const layer = Array.from(document.querySelectorAll<HTMLElement>(".room-runtime-layer"))
      .find(element => element.dataset.roomRuntimeId === roomId);
    if (!layer || layer.dataset.presentationState !== "hidden") return false;
    const paneElements = Array.from(layer.querySelectorAll<HTMLElement>("[data-space-pane-id]"));
    return visibleIds.every(paneId => {
      const pane = paneElements.find(element => element.dataset.spacePaneId === paneId);
      const terminal = pane?.querySelector<HTMLElement>(".terminal-pane");
      const host = terminal?.querySelector<HTMLElement>(".terminal-xterm");
      return terminal?.dataset.terminalStatus === "attached" &&
        terminal.dataset.terminalPrefillReady === "true" &&
        terminal.dataset.terminalLoading === "false" &&
        terminal.dataset.terminalActionPending === "false" &&
        terminal.dataset.terminalHasError === "false" &&
        host?.dataset.terminalPendingPrefillEvents === "0" &&
        host.dataset.terminalPendingPrefillBytes === "0" &&
        host.dataset.terminalInitialGeometry !== "pending" &&
        host.dataset.terminalSocketParked !== "true" &&
        Boolean(host.querySelector(".xterm-screen")) &&
        !host.querySelector("[data-terminal-resize-frame]");
    });
  }

  function activateRoom(
    roomId: string | null,
    options: { preserveOutgoing?: boolean } = {}
  ) {
    const preserveOutgoing = options.preserveOutgoing ?? true;
    const currentRoomId = selectedRoomIdRef.current;
    const outgoingDisplayedRoomId = preserveOutgoing ? displayedRoomIdRef.current : null;
    if (preserveOutgoing && currentRoomId && activeRuntimeRoomIdRef.current === currentRoomId) {
      replaceRoomRuntime(snapshotActiveRoom(currentRoomId));
      if (displayedRoomIdRef.current === currentRoomId && !preparingRoomIdRef.current) {
        roomPresentedGeometryRef.current.set(currentRoomId, roomPresentationGeometryKey(currentRoomId));
      }
    }
    if (currentRoomId !== roomId) previousWarmRoomIdRef.current = currentRoomId;
    const supersededMetric = roomPresentationMetricRef.current;
    if (supersededMetric && supersededMetric.roomId !== roomId) {
      recordRoomPresentationMetric(
        supersededMetric.roomId,
        supersededMetric.generation,
        "ERROR"
      );
    }
    roomPresentationGenerationRef.current += 1;
    scheduledRoomRevealRef.current = null;
    clearRoomPresentationFailureTimeout();
    selectedRoomIdRef.current = roomId;
    activeRuntimeRoomIdRef.current = roomId;
    setSelectedRoomId(roomId);
    if (!roomId) {
      displayedRoomIdRef.current = null;
      preparingRoomIdRef.current = null;
      setDisplayedRoomId(null);
      setPreparingRoomId(null);
      clearActiveRoomRuntime();
      return;
    }
    recordRoomMru(runtime.platform.sessionStorage, roomId);
    const generation = roomPresentationGenerationRef.current;
    roomPresentationMetricRef.current = {
      roomId,
      generation,
      startedAt: Date.now(),
      readyReported: false
    };
    recordRoomPresentationMetric(roomId, generation, "START");
    const cached = roomRuntimesRef.current[roomId];
    const shouldHoldOutgoingRoom = Boolean(
      !canImmediatelyPresentWarmCliRoom(roomId) &&
      outgoingDisplayedRoomId &&
      outgoingDisplayedRoomId !== roomId &&
      roomRuntimesRef.current[outgoingDisplayedRoomId]
    );
    roomRevealReadyPaneIdsRef.current.set(roomId, new Set());
    if (shouldHoldOutgoingRoom) {
      preparingRoomIdRef.current = roomId;
      setPreparingRoomId(roomId);
      roomPresentationFailureTimeoutRef.current = window.setTimeout(() => {
        if (
          roomPresentationGenerationRef.current !== generation ||
          preparingRoomIdRef.current !== roomId ||
          selectedRoomIdRef.current !== roomId
        ) return;
        roomPresentationFailureTimeoutRef.current = null;
        // DEBUG (user-requested 2026-08-14): which panes blocked the reveal.
        {
          const snapshot = roomRuntimesRef.current[roomId];
          const readyPaneIds = roomRevealReadyPaneIdsRef.current.get(roomId) ?? new Set<string>();
          const visibleIds = snapshot ? visibleTerminalPaneIds(snapshot) : [];
          const missing = visibleIds.filter((paneId) => !readyPaneIds.has(paneId));
          emitAppDiagnosticsPerformance({
            category: "PERFORMANCE",
            metric: "ROOM_REVEAL_PROGRESS",
            roomId,
            phase: "TIMEOUT",
            readyCount: visibleIds.length - missing.length,
            totalCount: visibleIds.length,
            missingPaneIds: missing.join(","),
            durationMs: ROOM_PRESENTATION_FAILURE_TIMEOUT_MS
          });
        }
        // User-approved 2026-08-14: reveal the target room once the grace
        // window elapses instead of bouncing back to the previous room —
        // slow panes keep filling in after the reveal.
        recordRoomPresentationMetric(roomId, generation, "ERROR");
        displayedRoomIdRef.current = roomId;
        preparingRoomIdRef.current = null;
        setDisplayedRoomId(roomId);
        setPreparingRoomId(null);
      }, ROOM_PRESENTATION_FAILURE_TIMEOUT_MS);
    } else {
      displayedRoomIdRef.current = roomId;
      preparingRoomIdRef.current = null;
      setDisplayedRoomId(roomId);
      setPreparingRoomId(null);
      recordRoomPresentationMetric(roomId, generation, "COMPLETE");
    }
    if (cached) {
      const accessed = { ...cached, lastAccessedAt: Date.now() };
      replaceRoomRuntime(accessed);
      applyRoomRuntime(accessed);
      finishPreparingRoomWhenReady(roomId);
    } else {
      clearActiveRoomRuntime();
    }
  }

  type RoomPanesPayload = Awaited<ReturnType<typeof api.panes>>;

  async function loadRoomPanes(roomId: string, prefetchedPayload?: RoomPanesPayload) {
    const activeRequest = roomPaneLoadPromisesRef.current.get(roomId);
    if (activeRequest) return activeRequest;

    const request = (async () => {
      const isFirstPaneLoad = roomPaneLoadStatesRef.current[roomId] !== "loaded";
      if (isFirstPaneLoad) {
        setRoomPaneLoadState(roomId, "loading");
      }
      const sequence = (roomPaneRequestSequenceRef.current.get(roomId) ?? 0) + 1;
      roomPaneRequestSequenceRef.current.set(roomId, sequence);
      let panePayload: Awaited<ReturnType<typeof api.panes>>;
      try {
        panePayload = prefetchedPayload ?? await api.panes(roomId);
      } catch (error) {
        if (!appMountedRef.current) return;
        if (roomPaneRequestSequenceRef.current.get(roomId) !== sequence) return;
        if (isFirstPaneLoad) {
          setRoomPaneLoadState(roomId, "error");
          if (preparingRoomIdRef.current === roomId && selectedRoomIdRef.current === roomId) {
            schedulePreparedRoomReveal(roomId, roomPresentationGenerationRef.current);
          }
        }
        throw error;
      }
      if (!appMountedRef.current) return;
      if (roomPaneRequestSequenceRef.current.get(roomId) !== sequence) return;
      const existing = roomRuntimesRef.current[roomId];
      const nextPanes = reuseVersionedItems(existing?.panes, panePayload.data, (pane) => pane.updatedAt);
      const visiblePanes = nextPanes.filter((pane) => !pane.isMinimized);
      const currentSelectedPaneId = selectedRoomIdRef.current === roomId
        ? selectedPaneIdRef.current
        : existing?.selectedPaneId ?? null;
      const nextSelectedPaneId = visiblePanes.some((pane) => pane.id === currentSelectedPaneId)
        ? currentSelectedPaneId
        : visiblePanes[0]?.id ?? null;
      const paneIds = new Set(nextPanes.map((pane) => pane.id));
      const nextBootstrappedPaneIds = (existing?.bootstrappedPaneIds ?? []).filter((paneId) => paneIds.has(paneId));
      const stableBootstrappedPaneIds = existing?.bootstrappedPaneIds &&
        nextBootstrappedPaneIds.length === existing.bootstrappedPaneIds.length
          ? existing.bootstrappedPaneIds
          : nextBootstrappedPaneIds;
      const nextPrefillReadyPaneIds = (existing?.prefillReadyPaneIds ?? []).filter((paneId) => paneIds.has(paneId));
      const stablePrefillReadyPaneIds = existing?.prefillReadyPaneIds &&
        nextPrefillReadyPaneIds.length === existing.prefillReadyPaneIds.length
          ? existing.prefillReadyPaneIds
          : nextPrefillReadyPaneIds;
      const snapshot: RoomRuntimeSnapshot = {
        roomId,
        panes: nextPanes,
        turns: existing?.turns ?? [],
        events: existing?.events ?? [],
        swarm: existing?.swarm ?? null,
        selectedPaneId: nextSelectedPaneId,
        bootstrappedPaneIds: stableBootstrappedPaneIds,
        prefillReadyPaneIds: stablePrefillReadyPaneIds,
        lastAccessedAt: selectedRoomIdRef.current === roomId ? Date.now() : existing?.lastAccessedAt ?? Date.now()
      };
      replaceRoomRuntime(snapshot);
      setRoomPaneLoadState(roomId, "loaded");
      if (selectedRoomIdRef.current !== roomId) return;
      activeRuntimeRoomIdRef.current = roomId;
      applyRoomRuntime(snapshot);
      finishPreparingRoomWhenReady(roomId);
      setError((current) => (isTransientUpstreamErrorMessage(current) ? null : current));
    })();

    roomPaneLoadPromisesRef.current.set(roomId, request);
    try {
      await request;
    } finally {
      if (roomPaneLoadPromisesRef.current.get(roomId) === request) {
        roomPaneLoadPromisesRef.current.delete(roomId);
      }
    }
  }

  async function loadRoomTurns(roomId: string) {
    const activeRequest = roomTurnsLoadPromisesRef.current.get(roomId);
    if (activeRequest) return activeRequest;

    const request = (async () => {
      const sequence = (roomTurnsRequestSequenceRef.current.get(roomId) ?? 0) + 1;
      roomTurnsRequestSequenceRef.current.set(roomId, sequence);
      const turnPayload = await api.turns({ roomId });
      if (!appMountedRef.current || roomTurnsRequestSequenceRef.current.get(roomId) !== sequence) return;
      const existing = roomRuntimesRef.current[roomId];
      if (!existing) return;
      const nextTurns = reuseVersionedItems(existing.turns, turnPayload.data, (turn) => turn.updatedAt);
      replaceRoomRuntime({
        ...existing,
        panes: selectedRoomIdRef.current === roomId ? panesRef.current : existing.panes,
        turns: nextTurns,
        selectedPaneId: selectedRoomIdRef.current === roomId ? selectedPaneIdRef.current : existing.selectedPaneId,
        lastAccessedAt: selectedRoomIdRef.current === roomId ? Date.now() : existing.lastAccessedAt
      });
      if (selectedRoomIdRef.current !== roomId) return;
      activeRuntimeRoomIdRef.current = roomId;
      turnsRef.current = nextTurns;
      setTurns(nextTurns);
      setError((current) => (isTransientUpstreamErrorMessage(current) ? null : current));
    })();

    roomTurnsLoadPromisesRef.current.set(roomId, request);
    try {
      await request;
    } finally {
      if (roomTurnsLoadPromisesRef.current.get(roomId) === request) roomTurnsLoadPromisesRef.current.delete(roomId);
    }
  }

  async function loadRoomSwarm(roomId: string) {
    const activeRequest = roomSwarmLoadPromisesRef.current.get(roomId);
    if (activeRequest) return activeRequest;

    const request = (async () => {
      const sequence = (roomSwarmRequestSequenceRef.current.get(roomId) ?? 0) + 1;
      roomSwarmRequestSequenceRef.current.set(roomId, sequence);
      const swarmPayload = await api.swarm(roomId);
      if (!appMountedRef.current || roomSwarmRequestSequenceRef.current.get(roomId) !== sequence) return;
      const existing = roomRuntimesRef.current[roomId];
      if (!existing) return;
      replaceRoomRuntime({
        ...existing,
        panes: selectedRoomIdRef.current === roomId ? panesRef.current : existing.panes,
        swarm: swarmPayload,
        selectedPaneId: selectedRoomIdRef.current === roomId ? selectedPaneIdRef.current : existing.selectedPaneId,
        lastAccessedAt: selectedRoomIdRef.current === roomId ? Date.now() : existing.lastAccessedAt
      });
      if (selectedRoomIdRef.current !== roomId) return;
      activeRuntimeRoomIdRef.current = roomId;
      swarmStateRef.current = swarmPayload;
      setSwarmState(swarmPayload);
      setError((current) => (isTransientUpstreamErrorMessage(current) ? null : current));
    })();

    roomSwarmLoadPromisesRef.current.set(roomId, request);
    try {
      await request;
    } finally {
      if (roomSwarmLoadPromisesRef.current.get(roomId) === request) roomSwarmLoadPromisesRef.current.delete(roomId);
    }
  }

  function commitPaneCompletionLifecycle(next: PaneCompletionLifecycleState) {
    if (next === paneCompletionLifecycleRef.current) return;
    paneCompletionLifecycleRef.current = next;
    setPaneCompletionLifecycle(next);
  }

  function hydratePaneCompletionEvents(roomId: string, events: readonly SpaceEvent[]) {
    commitPaneCompletionLifecycle(
      hydratePaneCompletionRoom(paneCompletionLifecycleRef.current, roomId, events)
    );
  }

  async function loadRoomEvents(roomId: string) {
    const activeRequest = roomEventsLoadPromisesRef.current.get(roomId);
    if (activeRequest) return activeRequest;

    const request = (async () => {
      const sequence = (roomEventsRequestSequenceRef.current.get(roomId) ?? 0) + 1;
      roomEventsRequestSequenceRef.current.set(roomId, sequence);
      const eventPayload = await api.events({ roomId, pageSize: 50, sortOrder: "desc" });
      if (!appMountedRef.current || roomEventsRequestSequenceRef.current.get(roomId) !== sequence) return;
      const existing = roomRuntimesRef.current[roomId];
      if (!existing) return;
      const nextEvents = reuseVersionedItems(existing.events, eventPayload.data, (event) => event.createdAt);
      hydratePaneCompletionEvents(roomId, nextEvents);
      replaceRoomRuntime({
        ...existing,
        panes: selectedRoomIdRef.current === roomId ? panesRef.current : existing.panes,
        events: nextEvents,
        selectedPaneId: selectedRoomIdRef.current === roomId ? selectedPaneIdRef.current : existing.selectedPaneId,
        lastAccessedAt: selectedRoomIdRef.current === roomId ? Date.now() : existing.lastAccessedAt
      });
      if (selectedRoomIdRef.current !== roomId) return;
      activeRuntimeRoomIdRef.current = roomId;
      roomEventsRef.current = nextEvents;
      setRoomEvents(nextEvents);
      setError((current) => (isTransientUpstreamErrorMessage(current) ? null : current));
    })();

    roomEventsLoadPromisesRef.current.set(roomId, request);
    try {
      await request;
    } finally {
      if (roomEventsLoadPromisesRef.current.get(roomId) === request) roomEventsLoadPromisesRef.current.delete(roomId);
    }
  }

  async function loadRoomMetadata(roomId: string) {
    await Promise.all([loadRoomSwarm(roomId), loadRoomTurns(roomId), loadRoomEvents(roomId)]);
  }

  async function loadRoomRuntime(
    roomId: string,
    onPanesLoaded?: () => void,
    options: { loadMetadata?: boolean; panePayload?: RoomPanesPayload } = {}
  ) {
    const startedAt = performance.now();
    const durationMs = () => Math.min(120_000, Math.max(0, performance.now() - startedAt));
    emitAppDiagnosticsPerformance({
      category: "PERFORMANCE",
      metric: "ROOM_HYDRATION",
      roomId,
      phase: "START",
      durationMs: 0
    });
    roomRuntimeHydrationIdsRef.current.add(roomId);
    try {
      roomRuntimeLastPolledAtRef.current.set(roomId, Date.now());
      await loadRoomPanes(roomId, options.panePayload);
      emitAppDiagnosticsPerformance({
        category: "PERFORMANCE",
        metric: "ROOM_HYDRATION",
        roomId,
        phase: "PANES_READY",
        durationMs: durationMs()
      });
      if (!appMountedRef.current) return;
      onPanesLoaded?.();
      await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
      await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
      if (!appMountedRef.current) return;
      const hiddenHydration =
        roomId !== selectedRoomIdRef.current &&
        roomId !== displayedRoomIdRef.current &&
        roomId !== preparingRoomIdRef.current;
      if (hiddenHydration) {
        const runtimeSnapshot = roomRuntimesRef.current[roomId];
        if (!runtimeSnapshot || runtimeSnapshot.panes.length === 0) {
          // Empty rooms need no prefill or metadata; finish immediately so the
          // warm pass cannot stall on them (user-reported stall, 2026-08-14).
          emitAppDiagnosticsPerformance({
            category: "PERFORMANCE",
            metric: "ROOM_HYDRATION",
            roomId,
            phase: "COMPLETE",
            durationMs: durationMs()
          });
          return;
        }
        const terminalPrefillReady = await waitForRoomTerminalPrefillBarrier(roomId, 2_000);
        if (!appMountedRef.current) return;
        emitAppDiagnosticsPerformance({
          category: "PERFORMANCE",
          metric: "ROOM_HYDRATION",
          roomId,
          phase: terminalPrefillReady ? "READY" : "ERROR",
          durationMs: durationMs()
        });
      }
      // Active/presented rooms become interactive as soon as panes (and cold terminals) are ready.
      // Metadata (swarm/turns/events) continues in the background so cold switches stay snappy.
      if (options.loadMetadata !== false) {
        if (hiddenHydration) {
          await loadRoomMetadata(roomId);
        } else {
          void loadRoomMetadata(roomId).catch(() => {
            // Metadata is best-effort after interactive readiness.
          });
        }
      }
      emitAppDiagnosticsPerformance({
        category: "PERFORMANCE",
        metric: "ROOM_HYDRATION",
        roomId,
        phase: "COMPLETE",
        durationMs: durationMs()
      });
    } catch (error) {
      emitAppDiagnosticsPerformance({
        category: "PERFORMANCE",
        metric: "ROOM_HYDRATION",
        roomId,
        phase: "ERROR",
        durationMs: durationMs()
      });
      throw error;
    } finally {
      roomRuntimeHydrationIdsRef.current.delete(roomId);
    }
  }

  async function refreshHiddenRoomRuntime(roomId: string) {
    roomRuntimeLastPolledAtRef.current.set(roomId, Date.now());
    await loadRoomPanes(roomId);
  }
  loadRoomPanesRef.current = loadRoomPanes;
  loadRoomTurnsRef.current = loadRoomTurns;
  loadRoomSwarmRef.current = loadRoomSwarm;
  loadRoomEventsRef.current = loadRoomEvents;
  loadRoomRuntimeRef.current = loadRoomRuntime;
  refreshHiddenRoomRuntimeRef.current = refreshHiddenRoomRuntime;

  requestRoomRefreshRef.current = (roomId, category, reason) => {
    const key = `${roomId}:${category}`;
    return roomRefreshQueueRef.current.request(key, async () => {
      recordLifecycleDebugEvent({
        type: "room_refresh_started",
        scope: "App",
        detail: `room=${roomId} category=${category} reason=${reason}`,
        notify: false
      });
      try {
        if (category === "panes") await loadRoomPanesRef.current(roomId);
        else if (category === "turns") await loadRoomTurnsRef.current(roomId);
        else if (category === "swarm") await loadRoomSwarmRef.current(roomId);
        else await loadRoomEventsRef.current(roomId);
        recordLifecycleDebugEvent({
          type: "room_refresh_completed",
          scope: "App",
          detail: `room=${roomId} category=${category} reason=${reason}`,
          notify: false
        });
      } catch (refreshError) {
        recordLifecycleDebugEvent({
          type: "room_refresh_failed",
          scope: "App",
          detail: `room=${roomId} category=${category} reason=${reason}`,
          notify: false
        });
        throw refreshError;
      }
    });
  };

  useEffect(() => {
    if (!selectedRoomId || activeRuntimeRoomIdRef.current !== selectedRoomId) return;
    replaceRoomRuntime(snapshotActiveRoom(selectedRoomId));
    // State synchronization intentionally follows the active facade only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panes, roomEvents, selectedPaneId, selectedRoomId, swarmState, turns]);

  const warmRoomIds = useMemo(() => {
    if (!selectedRoomId) return [];
    const candidates = rooms.flatMap((room) => {
      const cached = roomRuntimes[room.id];
      if (room.id !== selectedRoomId && !cached) return [];
      const runtimePanes = room.id === selectedRoomId ? panes : cached?.panes ?? [];
      const bootstrappedPaneIds = cached?.bootstrappedPaneIds ?? [];
      return [{
        roomId: room.id,
        attachedPaneCount: connectedPaneCount(runtimePanes, bootstrappedPaneIds),
        lastAccessedAt: cached?.lastAccessedAt ?? Date.now()
      }];
    });
    const preferredRoomIds = readRoomMru(
      runtime.platform.sessionStorage,
      new Set(rooms.map((room) => room.id))
    );
    return selectWarmRoomIds({
      enabled: warmRoomEnabled,
      roomIds: rooms.map((room) => room.id),
      activeRoomId: selectedRoomId,
      preferredRoomIds,
      previousRoomId: previousWarmRoomIdRef.current,
      maxAttachedPanes: deviceWarmPaneLimit,
      candidates
    });
  }, [panes, roomRuntimes, rooms, selectedRoomId, deviceWarmPaneLimit, warmRoomEnabled]);
  warmRoomIdsRef.current = warmRoomIds;

  const warmRoomLimitsForDevice = useMemo(() => warmRoomLimits(
    deviceWarmPaneLimit
  ), [deviceWarmPaneLimit]);

  const warmConnectedPaneTotal = useMemo(() => {
    let total = 0;
    for (const roomId of warmRoomIds) {
      const runtime = roomRuntimes[roomId];
      const runtimePanes = roomId === selectedRoomId ? panes : runtime?.panes ?? [];
      total += connectedPaneCount(runtimePanes, runtime?.bootstrappedPaneIds ?? []);
    }
    return total;
  }, [panes, roomRuntimes, selectedRoomId, warmRoomIds]);

  useEffect(() => {
    if (warmRoomEnabled) return;
    for (const roomId of Object.keys(roomRuntimesRef.current)) {
      if (roomId !== selectedRoomId && roomId !== displayedRoomId) removeRoomRuntime(roomId);
    }
    // removeRoomRuntime is intentionally kept outside the dependency list; the policy reacts only
    // to the browser-local cache setting and the requested/presented room identities.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [displayedRoomId, selectedRoomId, warmRoomEnabled]);

  useEffect(() => {
    const handlePaneRunLifecycle = (event: Event) => {
      if (!(event instanceof CustomEvent)) return;
      const detail = event.detail as Partial<PaneRunLifecycleDetail> | null;
      if (
        !detail ||
        typeof detail.roomId !== "string" ||
        typeof detail.paneId !== "string" ||
        typeof detail.runKey !== "string" ||
        typeof detail.occurredAt !== "string" ||
        (detail.status !== "STARTED" && detail.status !== "COMPLETED" && detail.status !== "FAILED")
      ) return;
      const lifecycleEvent: SpaceEvent = {
        id: `pane-run:${detail.paneId}:${detail.runKey}:${detail.status}`,
        roomId: detail.roomId,
        paneId: detail.paneId,
        turnId: null,
        workflowId: null,
        traceId: `pane-run:${detail.runKey}`,
        type: detail.status === "STARTED"
          ? "TURN_STARTED"
          : detail.status === "COMPLETED"
            ? "TURN_COMPLETED"
            : "TURN_FAILED",
        message: `Pane run ${detail.status.toLowerCase()}.`,
        payload: { clientTurnMarker: detail.runKey, sourceType: "PANE_RUNTIME" },
        createdAt: detail.occurredAt
      };
      commitPaneCompletionLifecycle(
        applyPaneCompletionEvents(paneCompletionLifecycleRef.current, [lifecycleEvent])
      );
    };
    window.addEventListener(PANE_RUN_LIFECYCLE_EVENT, handlePaneRunLifecycle);
    return () => window.removeEventListener(PANE_RUN_LIFECYCLE_EVENT, handlePaneRunLifecycle);
  }, []);

  function recordRoomPaneBootstrapped(roomId: string, paneId: string) {
    const runtime = roomRuntimesRef.current[roomId]
      ?? (selectedRoomIdRef.current === roomId ? snapshotActiveRoom(roomId) : null);
    if (!runtime || runtime.bootstrappedPaneIds.includes(paneId)) return;
    replaceRoomRuntime({
      ...runtime,
      bootstrappedPaneIds: [...runtime.bootstrappedPaneIds, paneId]
    });
    notifyRoomTerminalBarrier(roomId);
  }

  function recordRoomTerminalPrefillReady(roomId: string, paneId: string, ready: boolean) {
    const runtime = roomRuntimesRef.current[roomId]
      ?? (selectedRoomIdRef.current === roomId ? snapshotActiveRoom(roomId) : null);
    if (!runtime) return;
    const current = new Set(runtime.prefillReadyPaneIds);
    if (ready) current.add(paneId);
    else current.delete(paneId);
    if (current.size === runtime.prefillReadyPaneIds.length &&
      runtime.prefillReadyPaneIds.every((candidate) => current.has(candidate))) {
      if (ready) notifyRoomTerminalPrefillBarrier(roomId);
      return;
    }
    replaceRoomRuntime({
      ...runtime,
      prefillReadyPaneIds: [...current]
    });
    if (ready) notifyRoomTerminalPrefillBarrier(roomId);
  }

  async function recoverMissingRoom() {
    const roomPayload = await api.rooms({ all: true });
    const nextRoomId = roomPayload.data[0]?.id ?? null;
    setRooms(sortRoomsByOrder(roomPayload.data));
    activateRoom(nextRoomId, { preserveOutgoing: false });
    if (nextRoomId) {
      await loadRoomRuntime(nextRoomId);
      return;
    }
    setPanes([]);
    setSelectedPaneId(null);
    setTurns([]);
    setRoomEvents([]);
    setSwarmState(await api.swarm());
  }

  async function refreshRoomEvents(roomId: string) {
    const eventPayload = await api.events({ roomId, pageSize: 50, sortOrder: "desc" });
    if (!appMountedRef.current) return;
    hydratePaneCompletionEvents(roomId, eventPayload.data);
    // A slow response must not overwrite another room's events after a switch.
    if (selectedRoomIdRef.current !== roomId) return;
    // Keep unchanged event objects so panes whose events did not change skip re-rendering.
    setRoomEvents((current) => reuseVersionedItems(current, eventPayload.data, (event) => event.createdAt));
  }

  const appendRoomEvent = useCallback((event: SpaceEvent, applyCompletion = true) => {
    if (applyCompletion) {
      commitPaneCompletionLifecycle(applyPaneCompletionEvents(paneCompletionLifecycleRef.current, [event]));
    }
    setRoomEvents((current) => mergeSpaceEvents(current, event));
  }, []);

  async function refresh() { setStartupReady(false);
    try {
      const search = window.location.search;
      if (search) {
        const params = new URLSearchParams(search);
        if (
          params.has("login") ||
          params.has("logout") ||
          params.has("relogin") ||
          params.has("forceLogin") ||
          params.has("switch") ||
          params.has("new") ||
          params.get("prompt") === "login" ||
          params.get("action") === "logout"
        ) {
          await api.logout().catch(() => undefined);
          params.delete("login");
          params.delete("logout");
          params.delete("relogin");
          params.delete("forceLogin");
          params.delete("switch");
          params.delete("new");
          if (params.get("prompt") === "login") params.delete("prompt");
          if (params.get("action") === "logout") params.delete("action");
          const remaining = params.toString();
          const cleanUrl = window.location.pathname + (remaining ? `?${remaining}` : "");
          window.history.replaceState({}, document.title, cleanUrl);
        }
      }
    } catch {
      // Ignore
    }

    const me = await api.me();
    if (me.settings) {
      if (me.isAuthenticated) {
        const seeded = await seedInitialLocalSettingsToServer(api, me.settings, runtime.platform.localStorage);
        if (seeded) me.settings = seeded;
      }
      userPreferences.hydrate(me.settings);
      const { themeChanged } = applyServerUserSettings(
        runtime.platform.localStorage,
        me.settings,
        uiTheme,
        modernAppearance,
        modernIconPack,
        uiBackground,
        me.user?.id
      );
      if (themeChanged) {
        runtime.platform.reloadPage();
        return;
      }
    }
    const nextSetupStatus: SetupStatus =
      me.isAuthenticated && !me.isSetupRequired
        ? { setupRequired: false, expiresAt: null }
        : await api.setupStatus();
    setSetupStatus(nextSetupStatus);
    setAuth(me);
    setAuthBootstrapError(null);
    if (!me.isAuthenticated) return;
    // Prefetch only after authentication so the login surface never probes a
    // protected runtime endpoint. Multi-pane rooms still share one flight.
    api.warmCliRuntimes(); api.reportInstallActivity();
    if (me.user?.role === "ADMIN") api.warmCliRuntimeSettings();

    let roomPayload = await api.rooms({ all: true });
    const userStorageKey = me.user?.id ? `${SELECTED_ROOM_ID_STORAGE_KEY}.${me.user.id}` : SELECTED_ROOM_ID_STORAGE_KEY;
    const userSelectedRoomId = readStoredSessionString(userStorageKey) ?? (selectedRoomId && roomPayload.data.some((room) => room.id === selectedRoomId) ? selectedRoomId : null);
    if (
      userSelectedRoomId &&
      !roomPayload.data.some((room) => room.id === userSelectedRoomId) &&
      roomPayload.pagination.totalPages > 1
    ) {
      roomPayload = {
        ...roomPayload,
        data: await loadBoundedRoomCatalog()
      };
    }
    setRooms(sortRoomsByOrder(roomPayload.data));
    const myRooms = roomPayload.data.filter((room) => me.user?.role === "USER" || !room.ownerUserId || room.ownerUserId === me.user?.id); // a USER's list is own + shared rooms
    const selectedRoomIsMine = userSelectedRoomId ? myRooms.some((room) => room.id === userSelectedRoomId) : false;
    const selectedRoomStillExists = userSelectedRoomId ? roomPayload.data.some((room) => room.id === userSelectedRoomId) : false;
    const starterRoom = myRooms.find((room) => room.name.toLowerCase() === "getting started")
      ?? roomPayload.data.find((room) => room.name.toLowerCase() === "getting started");
    const defaultFirstRoom = starterRoom ?? myRooms[0] ?? roomPayload.data[0];
    const nextRoomId = (selectedRoomIsMine || adminModeRequested) && selectedRoomStillExists
      ? userSelectedRoomId
      : (defaultFirstRoom?.id ?? null);
    activateRoom(nextRoomId, { preserveOutgoing: selectedRoomStillExists });
    if (nextRoomId) {
      // Give the active room its existing attachment/PREFILL barriers before
      // background terminals compete for its initial render and session reads.
      const startBackgroundWarm = async () => {
        if (!(me.settings?.warmRoomEnabled ?? warmRoomEnabled)) return;
        const activeRoom = roomPayload.data.find((room) => room.id === nextRoomId);
        if (activeRoom?.kind === "AGENT_PROOF") {
          return;
        }
        await waitForRoomTerminalPrefillBarrier(nextRoomId);
        if (!appMountedRef.current) return;
        const candidateRooms = roomPayload.data.filter((room) => room.kind !== "AGENT_PROOF");
        const validRoomIds = new Set(candidateRooms.map((room) => room.id));
        const hydrationRoomIds = selectWarmHydrationRoomIds({
          roomIds: candidateRooms.map((room) => room.id),
          activeRoomId: nextRoomId,
          mruRoomIds: readRoomMru(runtime.platform.sessionStorage, validRoomIds),
          maxWarmRooms: warmRoomLimits(me.settings?.warmRoomConnectedPaneLimit ?? warmConnectedPaneLimit).maxRooms
        });
        const hydrateRoomIfNotEmpty = async (roomId: string) => {
          try {
            if (
              roomPaneLoadStatesRef.current[roomId] === "loaded" ||
              roomRuntimeHydrationIdsRef.current.has(roomId)
            ) {
              return; // already warm or warming — never re-hydrate (log spam: 4-5x per room)
            }
            const panePayload = await api.panes(roomId);
            if (!appMountedRef.current) return;
            if (panePayload.data.length === 0) return;
            await loadRoomRuntime(roomId, undefined, { loadMetadata: false, panePayload });
            scheduleWarmRoomPreparation(roomId);
          } catch {
            // Best-effort background hydration.
          }
        };
        void hydrateWarmRoomsWithinWindow(
          hydrationRoomIds,
          hydrateRoomIfNotEmpty,
          undefined,
          WARM_ROOM_STARTUP_HYDRATION_CONCURRENCY
        ).catch(() => undefined);
      };
      await loadRoomRuntime(nextRoomId);
      if (!appMountedRef.current) return;
      await waitForRoomTerminalBarrier(nextRoomId);
      if (!appMountedRef.current) return;
      void startBackgroundWarm();
    } else {
      setPanes([]);
      setSelectedPaneId(null);
      setTurns([]);
      setRoomEvents([]);
      setSwarmState(await api.swarm());
    }

    setStartupReady(true);
    // Keep only shell-critical status reads in the startup path. Provider and
    // health catalogs load when their dock is opened.
    setError((current) => (isTransientUpstreamErrorMessage(current) ? null : current));

    scheduleStartupBackground(() => {
      void Promise.allSettled([api.readyz(), api.admin()]).then(([readyResult, adminResult]) => {
        if (!appMountedRef.current) return;
        if (readyResult.status === "fulfilled") setReadiness(readyResult.value);
        if (adminResult.status === "fulfilled") {
          notices.applyStorageWarning(adminResult.value.storageWarning);
        }
      });
    }, () => appMountedRef.current);

    if (me.user?.role === "ADMIN") {
      scheduleSetupOverviewProbe({
        isMounted: () => appMountedRef.current,
        loadOverview: api.setupOverview,
        onIncomplete: () => {
          setupFromWorkspace.current = false;
          setIsSetupConnectionsOpen(true);
        },
        onError: () => setError((current) => current ?? "Setup status could not be loaded. Open Setup wizard from the room toolbar to finish setup.")
      });
    }
  }

  async function loadSettingsSurfaceData() {
    if (settingsSurfaceDataLoadedRef.current) return;
    if (settingsSurfaceDataPromiseRef.current) return settingsSurfaceDataPromiseRef.current;
    const request = Promise.all([api.providers(), api.providerSettings()]).then(([providerPayload, settings]) => {
      if (!appMountedRef.current) return;
      setProviders(providerPayload.data);
      setProviderSettings(settings);
      settingsSurfaceDataLoadedRef.current = true;
    });
    settingsSurfaceDataPromiseRef.current = request;
    try {
      await request;
    } finally {
      if (settingsSurfaceDataPromiseRef.current === request) settingsSurfaceDataPromiseRef.current = null;
    }
  }

  async function loadHealthSurfaceData(force = false) {
    if (healthSurfaceDataLoadedRef.current && !force) return;
    if (healthSurfaceDataPromiseRef.current) return healthSurfaceDataPromiseRef.current;
    const request = Promise.allSettled([
      force ? api.readyz() : Promise.resolve(null),
      loadSettingsSurfaceData(),
      api.models(),
      api.mcp(),
      api.latestMcpDiscoverySmoke(),
      api.storage(),
      api.observability(),
      api.worker()
    ]).then((results) => {
      if (!appMountedRef.current) return;
      const [readyResult, , modelResult, mcpResult, smokeResult, storageResult, observabilityResult, workerResult] = results;
      if (readyResult.status === "fulfilled" && readyResult.value) setReadiness(readyResult.value);
      if (modelResult.status === "fulfilled") setModels(modelResult.value.data);
      if (mcpResult.status === "fulfilled") setMcp(mcpResult.value);
      if (smokeResult.status === "fulfilled") setLatestMcpSmoke(smokeResult.value.data);
      if (storageResult.status === "fulfilled") setStorageReadiness(storageResult.value);
      if (observabilityResult.status === "fulfilled") setObservability(observabilityResult.value);
      if (workerResult.status === "fulfilled") setWorkerReadiness(workerResult.value);
      healthSurfaceDataLoadedRef.current = results.every((result) => result.status === "fulfilled");
      setHealthSurfaceError(healthSurfaceDataLoadedRef.current ? null : "Some health checks could not be loaded. Refresh to try again.");
    });
    healthSurfaceDataPromiseRef.current = request;
    try {
      await request;
    } finally {
      if (healthSurfaceDataPromiseRef.current === request) healthSurfaceDataPromiseRef.current = null;
    }
  }

  useEffect(() => {
    refresh().catch((err: unknown) => {
      if (!appMountedRef.current) return;
      const message = err instanceof Error ? err.message : "Failed to load Space";
      setAuthBootstrapError(message);
      if (!isTransientUpstreamRuntimeError(err)) setError(message);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const navigationEntry = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
    recordLifecycleDebugEvent({
      type: "app_boot",
      scope: "App",
      detail: `nav=${navigationEntry?.type ?? "unknown"} width=${readViewportWidth()} url=${window.location.pathname}`,
      shellMode
    });
    const handlePageShow = (event: PageTransitionEvent) => {
      recordLifecycleDebugEvent({
        type: "window_pageshow",
        scope: "window",
        detail: `persisted=${String(event.persisted)}`,
        shellMode: detectUiThemeShellMode(readViewportWidth(), uiTheme)
      });
    };
    const handlePageHide = (event: PageTransitionEvent) => {
      recordLifecycleDebugEvent({
        type: "window_pagehide",
        scope: "window",
        detail: `persisted=${String(event.persisted)}`,
        shellMode: detectUiThemeShellMode(readViewportWidth(), uiTheme)
      });
    };
    const handleBeforeUnload = () => {
      recordLifecycleDebugEvent({
        type: "window_beforeunload",
        scope: "window",
        detail: `url=${window.location.pathname}`,
        shellMode: detectUiThemeShellMode(readViewportWidth(), uiTheme)
      });
    };
    const handleVisibilityChange = () => {
      recordLifecycleDebugEvent({
        type: "window_visibilitychange",
        scope: "document",
        detail: `state=${document.visibilityState}`,
        shellMode: detectUiThemeShellMode(readViewportWidth(), uiTheme)
      });
    };
    window.addEventListener("pageshow", handlePageShow);
    window.addEventListener("pagehide", handlePageHide);
    window.addEventListener("beforeunload", handleBeforeUnload);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      window.removeEventListener("pageshow", handlePageShow);
      window.removeEventListener("pagehide", handlePageHide);
      window.removeEventListener("beforeunload", handleBeforeUnload);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [uiTheme]);

  useEffect(() => {
    function handleResize() {
      setShellMode(detectUiThemeShellMode(readViewportWidth(), uiTheme));
    }
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, [uiTheme]);

  useEffect(() => {
    const grid = paneGridRef.current;
    if (!grid) return;

    const updatePaneGridWidth = () => {
      const nextWidth = grid.clientWidth || grid.getBoundingClientRect().width || readViewportWidth();
      setPaneGridWidth((current) => (Math.abs(current - nextWidth) > 1 ? nextWidth : current));
      const nextHeight =
        grid.clientHeight ||
        (grid.parentElement ? grid.parentElement.clientHeight : 0) ||
        grid.getBoundingClientRect().height ||
        0;
      setPaneGridHeight((current) => (Math.abs(current - nextHeight) > 1 ? nextHeight : current));
    };

    // The observer delivers initial geometry before paint. Measuring during
    // every room effect forces styles/layout while sibling panes still update.
    const resizeObserver = typeof ResizeObserver !== "undefined" ? new ResizeObserver((entries) => {
      const entry = entries.find((entry) => entry.target === grid);
      if (!entry) {
        updatePaneGridWidth();
        return;
      }
      // The grid has no border/padding: contentRect matches its usable client
      // size, excluding scrollbar space. Retain geometry while hidden (0x0).
      const width = Math.round(entry.contentRect.width);
      const height = Math.round(entry.contentRect.height);
      if (width > 0) setPaneGridWidth((current) => (Math.abs(current - width) > 1 ? width : current));
      if (height > 0) setPaneGridHeight((current) => (Math.abs(current - height) > 1 ? height : current));
    }) : null;
    resizeObserver?.observe(grid);
    if (!resizeObserver) {
      updatePaneGridWidth();
      window.addEventListener("resize", updatePaneGridWidth);
    }
    return () => {
      resizeObserver?.disconnect();
      window.removeEventListener("resize", updatePaneGridWidth);
    };
  }, [selectedRoomId, shellMode, panes.length, isDesktopSideSurfaceOpen, isCompactSideSurfaceOpen, isRoomFocusMode]);

  useEffect(() => {
    try {
      const storageKey = auth?.user?.id ? `${SELECTED_ROOM_ID_STORAGE_KEY}.${auth.user.id}` : SELECTED_ROOM_ID_STORAGE_KEY;
      if (selectedRoomId) {
        runtime.platform.sessionStorage.setItem(storageKey, selectedRoomId);
        runtime.platform.sessionStorage.setItem(SELECTED_ROOM_ID_STORAGE_KEY, selectedRoomId);
      } else {
        runtime.platform.sessionStorage.removeItem(storageKey);
        runtime.platform.sessionStorage.removeItem(SELECTED_ROOM_ID_STORAGE_KEY);
      }
    } catch {
      // Best effort only.
    }
  }, [selectedRoomId, auth?.user?.id]);

  useEffect(() => {
    if (!selectedRoomId) return;
    const stored = readStoredCategoryFilter(selectedRoomId);
    setActiveCategoryColorByRoom((current) =>
      (current[selectedRoomId] ?? null) === stored ? current : { ...current, [selectedRoomId]: stored }
    );
  }, [selectedRoomId]);

  useEffect(() => {
    try {
      if (selectedPaneId) runtime.platform.sessionStorage.setItem(SELECTED_PANE_ID_STORAGE_KEY, selectedPaneId);
      else runtime.platform.sessionStorage.removeItem(SELECTED_PANE_ID_STORAGE_KEY);
    } catch {
      // Best effort only.
    }
  }, [selectedPaneId]);

  useEffect(() => {
    function focusRequestedBrowserPane(event: Event) {
      if (!(event instanceof CustomEvent)) return;
      const detail = parseBrowserPaneActionDetail(event.detail);
      if (detail?.action !== "handoff") return;
      if (panes.some((pane) => pane.id === detail.paneId && (pane.mode === "BROWSER" || pane.mode === "YOUTUBE") && !pane.isMinimized)) {
        setSelectedPaneId(detail.paneId);
      }
    }
    window.addEventListener(BROWSER_PANE_ACTION_EVENT, focusRequestedBrowserPane);
    return () => window.removeEventListener(BROWSER_PANE_ACTION_EVENT, focusRequestedBrowserPane);
  }, [panes]);

  useUserPreferenceWriteThrough(userPreferences, auth?.isAuthenticated);

  useEffect(() => {
    if (uiTheme === "classic" || modernAppearance !== "system" || typeof window.matchMedia !== "function") return;
    const colorScheme = window.matchMedia("(prefers-color-scheme: dark)");
    const update = () => setSystemPrefersDark(colorScheme.matches);
    update();
    colorScheme.addEventListener?.("change", update);
    return () => colorScheme.removeEventListener?.("change", update);
  }, [modernAppearance, uiTheme]);

  useEffect(() => {
    setIsWorkspaceTextSizePickerOpen(false);
    if (shellMode === "desktop") {
      setIsCompactSideSurfaceOpen(false);
      return;
    }
    setIsThemeMenuOpen(false);
  }, [shellMode]);

  useEffect(() => {
    if (!paneMoveNotice) return;
    const timeoutId = window.setTimeout(() => setPaneMoveNotice(null), 4000);
    return () => window.clearTimeout(timeoutId);
  }, [paneMoveNotice]);

  useEffect(() => {
    setPaneMoveDialog((current) => (current?.pending ? current : null));
    setIsCliLauncherOpen(false);
  }, [selectedRoomId]);

  useEffect(() => {
    if (panes.length >= 16) setIsCliLauncherOpen(false);
  }, [panes.length]);

  useEffect(() => {
    if (!auth?.isAuthenticated) return;
    const interval = window.setInterval(() => {
      const roomIds = selectRoomRuntimePollIds({
        warmRoomIds: warmRoomIdsRef.current,
        activeRoomId: selectedRoomIdRef.current,
        lastPolledAtByRoomId: roomRuntimeLastPolledAtRef.current,
        now: Date.now()
      });
      for (const roomId of roomIds) {
        refreshHiddenRoomRuntimeRef.current(roomId).catch((err: unknown) => {
          if (!appMountedRef.current) return;
          if (isRoomNotFoundError(err, roomId)) {
            if (roomId === selectedRoomIdRef.current) {
              recoverMissingRoom().catch((recoveryError: unknown) =>
                setError(recoveryError instanceof Error ? recoveryError.message : "Room recovery failed")
              );
            } else {
              removeRoomRuntime(roomId);
            }
            return;
          }
          if (roomId !== selectedRoomIdRef.current) return;
          if (!isTransientUpstreamRuntimeError(err)) {
            setError(err instanceof Error ? err.message : "Room refresh failed");
          }
        });
      }
    }, WARM_ROOM_RUNTIME_POLL_INTERVAL_MS);
    return () => window.clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auth?.isAuthenticated]);

  async function handleLogin(nextAuth: AuthMe) {
    if (nextAuth.isAuthenticated && nextAuth.settings) {
      const seeded = await seedInitialLocalSettingsToServer(api, nextAuth.settings, runtime.platform.localStorage);
      if (seeded) nextAuth.settings = seeded;

      userPreferences.hydrate(nextAuth.settings);
      const { themeChanged } = applyServerUserSettings(
        runtime.platform.localStorage,
        nextAuth.settings,
        uiTheme,
        modernAppearance,
        modernIconPack,
        uiBackground,
        nextAuth.user?.id
      );
      if (themeChanged) {
        runtime.platform.reloadPage();
        return;
      }
    }
    setAuth(nextAuth);
    if (nextAuth.isAuthenticated) {
      if (runtimeKind !== "demo") {
        const diagnosticsStartup = startAppDiagnosticsBootstrap();
        await diagnosticsStartup.beforeMount;
      }
      await refresh();
    }
  }

  async function handleOwnerClaim(input: SetupClaimInput) {
    const nextAuth = await api.claimSetup(input);
    setSetupStatus({ setupRequired: false, expiresAt: null });
    if (!nextAuth.isOnboardingComplete) {
      setupFromWorkspace.current = false;
      setIsSetupConnectionsOpen(true);
    }
    await handleLogin(nextAuth);
  }

  async function signOut() {
    // A signed-out phone must not keep showing this account's pushes.
    if (pushNotificationsEnabled()) await setPushNotifications(false, api).catch(() => undefined);
    try {
      await api.logout();
    } catch (error) {
      // The server ended the session but could not save the logout (LOGOUT_NOT_SAVED): say so instead of reloading.
      setError(error instanceof Error ? error.message : "The logout could not be saved.");
      return;
    }
    if (runtimeKind === "demo") {
      setAuth(await api.me());
      setAppView("workspace");
      return;
    }
    runtime.platform.reloadPage();
  }

  async function createRoom() {
    if (roomCreationPendingRef.current) return;
    if (rooms.length >= MAX_ROOMS) {
      setError(`Maximum room limit (${MAX_ROOMS}) reached. Close or delete an existing room to create a new one.`);
      return;
    }
    roomCreationPendingRef.current = true;
    setRoomCreationPending(true);
    setError(null);
    try {
      let room: Room;
      try {
        room = await api.createRoom(
          nextGeneratedRoomName(rooms.map((room) => room.name)),
          0,
          undefined,
          "/opt/spaceapp"
        );
      } catch (err) {
        setError(`Room creation failed: ${err instanceof Error ? err.message : "Unknown error"}`);
        return;
      }
      setRooms((current) => sortRoomsByOrder([...current, room]));
      setRoomCliActivityCounts((current) => ({ ...current, [room.id]: 0 }));
      setRoomCliRuntimeIds((current) => ({ ...current, [room.id]: [] }));
      activateRoom(room.id);
      setActiveSideSurface("rooms");
      if (shellMode === "desktop") {
        setIsDesktopSideSurfaceOpen(true);
      } else {
        setIsCompactSideSurfaceOpen(true);
      }
      try {
        await loadRoomRuntime(room.id);
      } catch (err) {
        setError(`Room created, but failed to load: ${err instanceof Error ? err.message : "Unknown error"}`);
      }
    } finally {
      roomCreationPendingRef.current = false;
      setRoomCreationPending(false);
    }
  }

  async function addRoomPanes(roomId: string, input: CreateRoomPanesRequest, onCreated?: (created: Pane[]) => void) {
    const result = await api.createRoomPanes(roomId, input);
    onCreated?.(result.data);
    const createdPane = result.data.at(-1);
    if (shellMode === "mobile" && selectedRoomIdRef.current === roomId && createdPane) {
      selectedPaneIdRef.current = createdPane.id;
      setSelectedPaneId(createdPane.id);
    }
    await loadRoomRuntime(roomId);
  }

  async function addRootAdminPane(targetRoomId?: string) {
    const roomId = targetRoomId || selectedRoomId;
    if (!roomId || panes.length >= 16) return;
    const targetRoom = rooms.find((r) => r.id === roomId);
    const targetCwd = targetRoom?.projectPath || "/opt/spaceapp";
    const created = await api.createPane(roomId, "CLI ROOT", "TERMINAL", {
      cwd: targetCwd,
      terminalRuntimeId: "cli:root"
    });
    setPanes((current) => [...current, created]);
    setSelectedPaneId(created.id);
    await loadRoomRuntime(roomId);
  }

  async function addWorktreePane(targetRoomId?: string) {
    const roomId = targetRoomId || selectedRoomId;
    if (!roomId || panes.length >= 16) return;
    await addRoomPanes(roomId, {
      panes: [{
        mode: "TERMINAL",
        terminalRuntimeId: "cli:gemini",
        useWorktree: true
      }]
    });
  }

  async function addFilesPane(count = 1, targetRoomId?: string) {
    const roomId = targetRoomId || selectedRoomId;
    if (!roomId || panes.length >= 16) return;
    const targetRoom = rooms.find((r) => r.id === roomId);
    if (targetRoom?.projectPath) {
      await ensureProjectFolder(targetRoom.projectPath);
    }
    const targetCount = Math.min(Math.max(1, count), 16 - panes.length);
    try {
      for (let i = 0; i < targetCount; i++) {
        const prior = (await api.panes(roomId, { includeClosed: true }).catch(() => null))?.data ?? [];
        const closedMatch = prior.find((candidate) => candidate.isClosed && candidate.mode === "FILES");
        let pane: Pane;
        if (closedMatch) {
          pane = await api.updatePane(closedMatch.id, {
            isClosed: false,
            status: "IDLE",
            cwd: targetRoom?.projectPath || "/opt/spaceapp"
          });
        } else {
          pane = await api.createPane(roomId, paneTitleForMode("FILES", panes.length + 1), "FILES", {
            cwd: targetRoom?.projectPath || "/opt/spaceapp"
          });
        }
        setPanes((current) => [...current.filter((candidate) => candidate.id !== pane.id), pane]);
        setSelectedPaneId(pane.id);
      }
      await refreshRoomEvents(roomId);
      await loadRoomRuntime(roomId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Files pane failed to open");
    }
  }

  async function addDatabasesPane(count = 1, targetRoomId?: string) {
    const roomId = targetRoomId || selectedRoomId;
    if (!roomId || panes.length >= 16) return;
    const targetRoom = rooms.find((r) => r.id === roomId);
    if (targetRoom?.projectPath) {
      await ensureProjectFolder(targetRoom.projectPath);
    }
    const targetCount = Math.min(Math.max(1, count), 16 - panes.length);
    try {
      for (let i = 0; i < targetCount; i++) {
        const prior = (await api.panes(roomId, { includeClosed: true }).catch(() => null))?.data ?? [];
        const closedMatch = prior.find((candidate) => candidate.isClosed && candidate.mode === "DATABASES");
        let pane: Pane;
        if (closedMatch) {
          pane = await api.updatePane(closedMatch.id, {
            isClosed: false,
            status: "IDLE",
            cwd: targetRoom?.projectPath || "/opt/spaceapp"
          });
        } else {
          pane = await api.createPane(roomId, paneTitleForMode("DATABASES", panes.length + 1), "DATABASES", {
            cwd: targetRoom?.projectPath || "/opt/spaceapp"
          });
        }
        setPanes((current) => [...current.filter((candidate) => candidate.id !== pane.id), pane]);
        setSelectedPaneId(pane.id);
      }
      await refreshRoomEvents(roomId);
      await loadRoomRuntime(roomId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Databases pane failed to open");
    }
  }

  async function addDemosPane(count = 1) {
    if (!selectedRoomId || panes.length >= 16) return;
    const targetCount = Math.min(Math.max(1, count), 16 - panes.length);
    const newPanes = Array.from({ length: targetCount }, () => ({ mode: "DEMOS" as const }));
    await addRoomPanes(selectedRoomId, { panes: newPanes });
  }

  // Copilot panes (Job, Mail, Marketing, Freelance): the operator picks the agent and account once (Claude Code recommended); later panes
  // open with it on every device. The dialog shows again when "ask every time" is on or the saved CLI is not ready.
  function copilotPaneItems(kind: CopilotKind, count: number, choice: CopilotLaunchChoice) {
    return Array.from({ length: count }, () => ({
      mode: kind.mode, terminalRuntimeId: choice.terminalRuntimeId, ...(choice.accountProfileId ? { accountProfileId: choice.accountProfileId } : {})
    }));
  }

  // The new panes' CLIs start on the chosen account (the pane row cannot hold it; see the copilot contracts).
  function rememberCopilotPaneAccount(created: Pane[], choice: CopilotLaunchChoice) {
    if (choice.accountProfileId) rememberNewPaneAccount(created.map((pane) => pane.id), choice.terminalRuntimeId, choice.accountProfileId);
  }

  async function addCopilotPane(kind: CopilotKind, count = 1) {
    if (!selectedRoomId || panes.length >= 16) return;
    const launch = { kind, roomId: selectedRoomId, count: Math.min(Math.max(1, count), 16 - panes.length) };
    const decision = await resolveCopilotLaunch(kind).catch(() => null);
    if (!decision?.open) {
      setCopilotLaunch({ ...launch, preselect: decision?.preselect ?? null, notice: decision?.notice ?? null });
      return;
    }
    await addRoomPanes(launch.roomId, { panes: copilotPaneItems(kind, launch.count, decision.choice) }, (created) => rememberCopilotPaneAccount(created, decision.choice));
  }
  const addJobApplyPane = (count = 1) => addCopilotPane(JOB_COPILOT_KIND, count);
  const addMailCopilotPane = (count = 1) => addCopilotPane(MAIL_COPILOT_KIND, count);

  async function createCopilotPanes(choice: CopilotLaunchChoice) {
    const launch = copilotLaunch;
    if (!launch) return;
    await addRoomPanes(launch.roomId, { panes: copilotPaneItems(launch.kind, launch.count, choice) }, (created) => rememberCopilotPaneAccount(created, choice));
    setCopilotLaunch(null);
  }

  async function addT3CodePane(count = 1) {
    if (!selectedRoomId || panes.length >= 16) return;
    const targetCount = Math.min(Math.max(1, count), 16 - panes.length);
    // Same room worktree isolation as CLI panes: each T3 pane gets its own worktree.
    const useWorktree = isRoomWorktreeEnabled(selectedRoomId);
    const newPanes = Array.from({ length: targetCount }, () => ({ mode: "T3CODE" as const, ...(useWorktree ? { useWorktree: true } : {}) }));
    await addRoomPanes(selectedRoomId, { panes: newPanes });
  }

  function toggleCliLauncher() {
    if (isCliLauncherOpen) {
      setIsCliLauncherOpen(false);
      return;
    }
    if (!selectedRoomId || cliPaneCreationPendingRef.current) return;
    cliLauncherReturnFocusRef.current = cliLauncherButtonRef.current?.isConnected
      ? cliLauncherButtonRef.current
      : roomOverflowTriggerRef.current;
    setIsQuickLinksOpen(false);
    setIsVibeMusicOpen(false);
    setIsChatLauncherOpen(false);
    setIsCliLauncherOpen(true);
  }

  function openCliLauncher() {
    if (!selectedRoomId || cliPaneCreationPendingRef.current) return;
    cliLauncherReturnFocusRef.current = cliLauncherButtonRef.current?.isConnected
      ? cliLauncherButtonRef.current
      : roomOverflowTriggerRef.current;
    setIsQuickLinksOpen(false);
    setIsVibeMusicOpen(false);
    setIsCliLauncherOpen(true);
  }

  function toggleChatLauncher() {
    if (isChatLauncherOpen) {
      setIsChatLauncherOpen(false);
      return;
    }
    if (!selectedRoomId || cliPaneCreationPendingRef.current) return;
    setIsQuickLinksOpen(false);
    setIsVibeMusicOpen(false);
    setIsCliLauncherOpen(false);
    setIsChatLauncherOpen(true);
  }

  function closeChatLauncher() {
    setIsChatLauncherOpen(false);
  }

  async function addCliRuntimePane(runtime: AgentRuntime, count = 1) {
    const roomId = selectedRoomIdRef.current;
    if (!roomId) throw new Error("Select a room before adding a CLI pane.");
    if (panesRef.current.length >= 16) throw new Error("This room already has the maximum of 16 panes.");
    if (cliPaneCreationPendingRef.current) throw new Error("A CLI pane is already being created.");
    if (runtime.id === "cli:root" || !runtime.capabilities.includes("CLI") || !isCliRuntimeTerminalLaunchable(runtime)) {
      throw new Error(runtime.statusReason || "This CLI runtime is unavailable.");
    }

    const targetRoom = rooms.find((r) => r.id === roomId);
    const effectiveProjectPath = targetRoom?.projectPath || dockProjectPathDrafts[roomId]?.trim() || "/opt/spaceapp";
    const roomCwd = effectiveProjectPath;
    cliPaneCreationPendingRef.current = true;
    setCliPaneCreationPending(true);
    const targetCount = Math.min(Math.max(1, count), 16 - panesRef.current.length);
    if (targetCount <= 0) return;
    try {
      const optimisticPanes: Pane[] = [];
      const currentPanes = panesRef.current;
      const baseOrder = currentPanes.reduce((max, p) => Math.max(max, p.order), -1) + 1;
      const nowIso = new Date().toISOString();
      const baseTimestamp = Date.now().toString(36);

      for (let i = 0; i < targetCount; i++) {
        const optimisticId = `pane:optimistic-${baseTimestamp}-${i}`;
        const optimisticTitle =
          runtime.id === "cli:codex"
            ? paneTitleForMode("TERMINAL", currentPanes.length + i + 1)
            : runtime.displayName;
        optimisticPanes.push({
          id: optimisticId,
          roomId,
          title: optimisticTitle,
          titleSource: "auto",
          mode: "TERMINAL",
          status: "IDLE",
          providerId: null,
          modelId: null,
          terminalRuntimeId: runtime.id === "cli:codex" ? null : runtime.id,
          reasoningEffort: "medium",
          cwd: effectiveProjectPath ? effectiveProjectPath : (runtime.id === "cli:codex" ? null : "/etc"),
          order: baseOrder + i,
          columnSpan: 1,
          isMaximized: false,
          isMinimized: false,
          isClosed: false,
          split: { parentId: null, direction: null, size: null },
          categoryColor: null,
          vncTarget: null,
          createdAt: nowIso,
          updatedAt: nowIso
        });
      }

      // Show skeleton cards immediately
      if (selectedRoomIdRef.current === roomId) {
        setPanes((current) => [...current, ...optimisticPanes]);
      }

      // Create all panes concurrently; the room's project path is persisted once.
      let roomProjectPathPersisted = false;
      const createPromises = optimisticPanes.map(async (optPane) => {
        let paneCwd = roomCwd;
        if (effectiveProjectPath && isRoomWorktreeEnabled(roomId)) {
          try {
            const wt = await createWorktree({
              repoPath: effectiveProjectPath,
              roomId,
              baseBranch: "main",
              linkModules: true
            });
            paneCwd = wt.worktreePath;
            if (!targetRoom?.projectPath && targetRoom && !roomProjectPathPersisted) {
              roomProjectPathPersisted = true;
              void api.updateRoom(roomId, { name: targetRoom.name, projectPath: effectiveProjectPath }).then((updated) => {
                setRooms((current) => current.map((r) => (r.id === roomId ? updated : r)));
              }).catch((err) => {
                console.warn("Failed to persist the room project path:", err);
              });
            }
          } catch (err) {
            console.warn("Failed to provision worktree for CLI pane, falling back to project path:", err);
            paneCwd = effectiveProjectPath;
          }
        }
        const created = runtime.id === "cli:codex"
          ? await api.createPane(roomId, optPane.title, "TERMINAL", paneCwd ? { cwd: paneCwd } : undefined)
          : await api.createPane(roomId, runtime.displayName, "TERMINAL", {
              cwd: paneCwd,
              terminalRuntimeId: runtime.id
            });
        return { optimisticId: optPane.id, created };
      });

      const results = await Promise.allSettled(createPromises);
      const createdPanes: Pane[] = [];
      const failedOptimisticIds = new Set<string>();

      for (let i = 0; i < results.length; i++) {
        const res = results[i];
        const optPane = optimisticPanes[i];
        if (!res || !optPane) continue;
        if (res.status === "fulfilled") {
          createdPanes.push(res.value.created);
        } else {
          failedOptimisticIds.add(optPane.id);
        }
      }

      if (selectedRoomIdRef.current === roomId) {
        setPanes((current) => {
          const optimisticIds = new Set(optimisticPanes.map((p) => p.id));
          const withoutOptimistic = current.filter((pane) => !optimisticIds.has(pane.id));
          const existingIds = new Set(withoutOptimistic.map((p) => p.id));
          const toAdd = createdPanes.filter((p) => !existingIds.has(p.id));
          return [...withoutOptimistic, ...toAdd];
        });
        const firstCreated = createdPanes[0];
        if (firstCreated) {
          setSelectedPaneId(firstCreated.id);
        }
      }
      if (failedOptimisticIds.size > 0 && createdPanes.length === 0) {
        const firstError = results.find((r) => r.status === "rejected") as PromiseRejectedResult | undefined;
        throw firstError?.reason ?? new Error("Failed to create CLI panes.");
      }
      if (selectedRoomIdRef.current === roomId) {
        void refreshRoomEvents(roomId).catch(() => setError("CLI pane created, but room activity could not be refreshed."));
      }
    } finally {
      cliPaneCreationPendingRef.current = false;
      setCliPaneCreationPending(false);
    }
  }

  async function openCliRuntimeLogin(runtime: AgentRuntime) {
    const roomId = selectedRoomIdRef.current;
    if (!roomId) throw new Error("Select a room before opening CLI login.");
    const result = await api.cliLogin(roomId, runtime.id);
    if (selectedRoomIdRef.current === roomId) {
      pendingPaneHeaderFocusIdRef.current = result.pane.id;
      setPanes((current) => current.some((pane) => pane.id === result.pane.id) ? current : [...current, result.pane]);
      setSelectedPaneId(result.pane.id);
      void refreshRoomEvents(roomId).catch(() => setError("CLI login opened, but room activity could not be refreshed."));
    }
  }

  async function openSetupConnectionLogin(connectionId: string) {
    const registry = await api.cliRuntimes();
    const connectionRuntime = registry.data.find((candidate) => candidate.id === connectionId);
    if (!connectionRuntime) {
      throw new Error("This CLI connection is not available in the current Space runtime.");
    }

    if (!selectedRoomIdRef.current) {
      const { room } = await api.setupStarterRoom();
      setRooms((current) => sortRoomsByOrder(
        current.some((candidate) => candidate.id === room.id)
          ? current.map((candidate) => candidate.id === room.id ? room : candidate)
          : [...current, room]
      ));
      activateRoom(room.id);
      await loadRoomRuntime(room.id);
    }

    await openCliRuntimeLogin(connectionRuntime);
  }

  async function selectRoom(roomId: string, options: { keepCompactSurfaceOpen?: boolean } = {}) {
    const outgoingRoomId = selectedRoomIdRef.current;
    const warmRuntimeReady = Boolean(
      warmRoomIdsRef.current.includes(roomId) &&
      roomRuntimesRef.current[roomId] &&
      roomPaneLoadStatesRef.current[roomId] === "loaded"
    );
    const measurement = startRoomSwitchMeasurement({
      fromRoomId: selectedRoomIdRef.current,
      toRoomId: roomId,
      temperature: classifyRoomSwitchTemperature(roomId, warmRoomIdsRef.current)
    });
    // Activate before starting any load. A document-wide View Transition defers
    // this callback until Chrome captures all visible pane surfaces, including
    // canvases/iframes, adding work even when the target runtime is already warm.
    activateRoom(roomId);
    if (outgoingRoomId && outgoingRoomId !== roomId) scheduleWarmRoomPreparation(outgoingRoomId);
    recordRoomSwitchMeasurementPhase(measurement, "activated");
    if (!options.keepCompactSurfaceOpen) setIsCompactSideSurfaceOpen(false);
    if (warmRuntimeReady) {
      recordRoomSwitchMeasurementPhase(measurement, "loaded");
      return;
    }
    let panesLoaded = false;
    try {
      await loadRoomRuntime(roomId, () => {
        panesLoaded = true;
        recordRoomSwitchMeasurementPhase(measurement, "loaded");
      });
    } catch (error) {
      if (!panesLoaded) recordRoomSwitchMeasurementPhase(measurement, "failed");
      throw error;
    }
  }

  useEffect(() => {
    const openRecoveryRoom = (event: Event) => {
      if (!(event instanceof CustomEvent)) return;
      const detail = parseCliRecoveryOpenedDetail(event.detail);
      if (!detail) return;
      void (async () => {
        const roomPayload = await api.rooms({ all: true });
        setRooms(sortRoomsByOrder(roomPayload.data));
        await selectRoom(detail.roomId);
        if (detail.paneId) setSelectedPaneId(detail.paneId);
      })().catch(() => setError("CLI Recovery opened, but the room could not be selected automatically."));
    };
    window.addEventListener(CLI_RECOVERY_OPENED_EVENT, openRecoveryRoom);
    return () => window.removeEventListener(CLI_RECOVERY_OPENED_EVENT, openRecoveryRoom);
  });

  // Space Dots Stage 8: a Dot pane asks the shell to open a call or Settings → Dots.
  useEffect(() => {
    const call = (event: Event) => {
      if (!(event instanceof CustomEvent) || typeof event.detail?.dotId !== "string" || typeof event.detail?.dotName !== "string") return;
      const dot = { dotId: event.detail.dotId as string, name: event.detail.dotName as string,
        ...(typeof event.detail.slot === "number" ? { slot: event.detail.slot as number } : {}) };
      // One call per Dot and room: an open call with this Dot is brought forward instead of a second one.
      const existing = panes.find((pane) => pane.mode === "LIVE" && !pane.isClosed && readLivePaneDot(pane.id)?.dotId === dot.dotId);
      if (existing) { setSelectedPaneId(existing.id); return; }
      void addLivePane(1, `${dot.name} · Call`).then((pane) => { if (pane) writeLivePaneDot(pane.id, dot); });
    };
    const settings = (event: Event) => {
      const detail = event instanceof CustomEvent ? event.detail as { dotId?: string; section?: DotSettingsSection } | null : null;
      setDotSettingsRequest({ dotId: detail?.dotId, section: detail?.section, nonce: Date.now() });
      openSettingsSurface();
    };
    window.addEventListener(DOT_CALL_EVENT, call);
    window.addEventListener(OPEN_DOT_SETTINGS_EVENT, settings);
    return () => { window.removeEventListener(DOT_CALL_EVENT, call); window.removeEventListener(OPEN_DOT_SETTINGS_EVENT, settings); };
  });

  useEffect(() => {
    if (!isAdminMode && selectedRoomId && rooms.length > 0 && auth?.user?.role !== "USER") {
      const currentRoom = rooms.find((r) => r.id === selectedRoomId);
      if (currentRoom && currentRoom.ownerUserId && currentRoom.ownerUserId !== auth?.user?.id) {
        const myFirstRoom = rooms.find((r) => !r.ownerUserId || r.ownerUserId === auth?.user?.id);
        if (myFirstRoom) {
          void selectRoom(myFirstRoom.id);
        }
      }
    }
  }, [isAdminMode, selectedRoomId, rooms, auth?.user?.id]);

  // Every room delete is confirmed in the app; running CLI sessions are named in the question.
  async function requestRoomDelete(room: Room) {
    if (deletePendingRoomId) return;
    const activeCli = roomCliActivityCounts[room.id] ?? 0;
    const confirmed = await roomDeleteConfirm.confirm({
      title: `Delete ${room.name}?`,
      message: activeCli > 0
        ? `This room has ${activeCli} active CLI ${activeCli === 1 ? "session" : "sessions"} that will be terminated. The room and its panes will be removed.`
        : "The room and its panes will be removed.",
      confirmLabel: "Delete room"
    });
    if (confirmed) await deleteRooms([room.id]);
  }

  // The Test rooms group deletes all its rooms behind one confirmation.
  async function requestTestRoomsDelete(targets: Room[]) {
    if (deletePendingRoomId || !targets.length) return;
    const activeCli = targets.reduce((sum, room) => sum + (roomCliActivityCounts[room.id] ?? 0), 0);
    const confirmed = await roomDeleteConfirm.confirm({
      title: `Delete ${targets.length} test ${targets.length === 1 ? "room" : "rooms"}?`,
      message: activeCli > 0
        ? `They have ${activeCli} active CLI ${activeCli === 1 ? "session" : "sessions"} that will be terminated. The rooms and their panes will be removed.`
        : "The rooms and their panes will be removed.",
      confirmLabel: "Delete rooms"
    });
    if (confirmed) await deleteRooms(targets.map((room) => room.id));
  }

  async function deleteRooms(roomIds: string[]) {
    if (deletePendingRoomId || !roomIds.length) return;
    const deletedIds = new Set(roomIds);
    const deletedRooms = rooms.filter((room) => deletedIds.has(room.id));
    const nextRooms = rooms.filter((room) => !deletedIds.has(room.id));
    const candidateRooms = !isAdminMode && auth?.user?.role !== "USER" ? nextRooms.filter((r) => !r.ownerUserId || r.ownerUserId === auth?.user?.id) : nextRooms;
    const selectedDeleted = selectedRoomId !== null && deletedIds.has(selectedRoomId);
    const nextSelectedRoomId = selectedDeleted ? candidateRooms[0]?.id ?? null : selectedRoomId;
    setDeletePendingRoomId(roomIds[0]!);
    setError(null);
    setRooms(nextRooms);
    setRoomCliActivityCounts((current) => {
      if (!roomIds.some((roomId) => roomId in current)) return current;
      const next = { ...current };
      for (const roomId of roomIds) delete next[roomId];
      return next;
    });
    setRoomCliRuntimeIds((current) => {
      if (!roomIds.some((roomId) => roomId in current)) return current;
      const next = { ...current };
      for (const roomId of roomIds) delete next[roomId];
      return next;
    });
    if (selectedDeleted) {
      activateRoom(nextSelectedRoomId);
      for (const roomId of roomIds) removeRoomRuntime(roomId);
      if (nextSelectedRoomId) {
        await loadRoomRuntime(nextSelectedRoomId);
      } else {
        setPanes([]);
        setSelectedPaneId(null);
        setTurns([]);
        setRoomEvents([]);
        setSwarmState(await api.swarm());
      }
    } else {
      for (const roomId of roomIds) removeRoomRuntime(roomId);
    }
    try {
      const results = await Promise.allSettled(roomIds.map((roomId) => api.deleteRoom(roomId)));
      const failure = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
      if (failure) {
        // Only the rooms the server refused come back.
        setRooms(sortRoomsByOrder([...nextRooms, ...deletedRooms.filter((room) => results[roomIds.indexOf(room.id)]?.status === "rejected")]));
        setError(failure.reason instanceof Error ? failure.reason.message : "Room delete failed");
      }
    } finally {
      setDeletePendingRoomId(null);
    }
  }

  function openMovePaneDialog(pane: Pane) {
    const targetRooms = rooms.filter((room) => room.id !== pane.roomId);
    if (!targetRooms.length) return;
    setError(null);
    setPaneMoveNotice(null);
    setPaneMoveDialog({
      pane,
      targetRoomId: targetRooms[0]!.id,
      pending: false,
      error: null
    });
  }

  function closeMovePaneDialog() {
    setPaneMoveDialog((current) => (current?.pending ? current : null));
  }

  async function movePaneToRoom(paneId: string, targetRoomId: string) {
    const move = await api.movePane(paneId, targetRoomId);
    if (selectedRoomId === move.sourceRoomId) await loadRoomRuntime(move.sourceRoomId);
    setPaneMoveNotice(`Moved "${move.sourcePane.title}" to "${rooms.find((room) => room.id === targetRoomId)?.name ?? "the selected room"}".`);
  }

  async function submitPaneMove() {
    if (!paneMoveDialog || paneMoveDialog.pending) return;
    setPaneMoveDialog((current) => (current ? { ...current, pending: true, error: null } : current));
    try {
      await movePaneToRoom(paneMoveDialog.pane.id, paneMoveDialog.targetRoomId);
      setPaneMoveDialog(null);
    } catch (err) {
      setPaneMoveDialog((current) =>
        current
          ? {
              ...current,
              pending: false,
              error: err instanceof Error ? err.message : "Pane move failed"
            }
          : current
      );
    }
  }

  async function addPane(mode: Pane["mode"], youtubeUrl?: string, count = 1) {
    const roomId = selectedRoomIdRef.current;
    if (
      !roomId ||
      panesRef.current.length >= 16 ||
      paneCreationPendingRef.current ||
      cliPaneCreationPendingRef.current
    ) return;
    paneCreationPendingRef.current = true;
    setPaneCreationPendingMode(mode);
    setError(null);
    const targetCount = Math.min(Math.max(1, count), 16 - panesRef.current.length);
    try {
      for (let i = 0; i < targetCount; i++) {
        // The closed-pane lookup does not depend on the worktree: run both together.
        const priorRequest = api.panes(roomId, { includeClosed: true }).catch(() => null);
        let paneCwd: string | undefined;
        if (mode === "TERMINAL") {
          const targetRoom = rooms.find((r) => r.id === roomId);
          const effectiveProjectPath = targetRoom?.projectPath || dockProjectPathDrafts[roomId]?.trim() || "/opt/spaceapp";
          if (isRoomWorktreeEnabled(roomId)) {
            try {
              const wt = await createWorktree({
                repoPath: effectiveProjectPath,
                roomId,
                baseBranch: "main",
                linkModules: true
              });
              paneCwd = wt.worktreePath;
              if (!targetRoom?.projectPath && targetRoom) {
                void api.updateRoom(roomId, { name: targetRoom.name, projectPath: effectiveProjectPath }).then((updated) => {
                  setRooms((current) => current.map((r) => (r.id === roomId ? updated : r)));
                }).catch((err) => {
                  console.warn("Failed to persist the room project path:", err);
                });
              }
            } catch (err) {
              console.warn("Failed to provision worktree for CLI pane in addPane:", err);
              paneCwd = effectiveProjectPath;
            }
          } else {
            paneCwd = effectiveProjectPath;
          }
        }
        const prior = (await priorRequest)?.data ?? [];
        const closedMatch = prior.find((candidate) => candidate.isClosed && candidate.mode === mode);
        let pane: Pane;
        if (closedMatch) {
          pane = await api.updatePane(closedMatch.id, {
            isClosed: false,
            status: "IDLE",
            ...(paneCwd ? { cwd: paneCwd } : {})
          });
        } else {
          pane = await api.createPane(
            roomId,
            paneTitleForMode(mode, panesRef.current.length + 1),
            mode,
            paneCwd ? { cwd: paneCwd } : undefined
          );
        }
        if (mode === "YOUTUBE" && youtubeUrl) {
          registerYouTubeBrowseIntent(pane.id, youtubeUrl);
        }
        if (selectedRoomIdRef.current === roomId) {
          setPanes((current) => [...current.filter((candidate) => candidate.id !== pane.id), pane]);
          setSelectedPaneId(pane.id);
          setIsMemoryWorkspaceOpen(false);
          setIsSpaceGatewayOpen(false);
        }
      }
      await refreshRoomEvents(roomId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Pane failed to open");
    } finally {
      paneCreationPendingRef.current = false;
      setPaneCreationPendingMode(null);
    }
  }

  async function addHarnessPane(count = 1) {
    if (!selectedRoomId || panes.length >= 16) return;
    if (!isHarnessEnabled) {
      setError("DeepSeek Harness is disabled. Enable it in Settings to open a Harness pane.");
      return;
    }
    const targetCount = Math.min(Math.max(1, count), 16 - panes.length);
    try {
      for (let i = 0; i < targetCount; i++) {
        const pane = await api.createPane(selectedRoomId, paneTitleForMode("HARNESS", panes.length + 1), "HARNESS");
        setPanes((current) => [...current.filter((candidate) => candidate.id !== pane.id), pane]);
        setSelectedPaneId(pane.id);
        setIsMemoryWorkspaceOpen(false);
        setIsSpaceGatewayOpen(false);
      }
      await refreshRoomEvents(selectedRoomId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Harness pane failed to open");
    }
  }

  async function addLivePane(count = 1, title?: string): Promise<Pane | null> {
    const targetRoomId = selectedRoomId || activeRoom?.id || rooms[0]?.id;
    if (!targetRoomId) {
      showLiveDebug("Cannot open AI Live: No active room found.", "error");
      return null;
    }
    if (panes.length >= 16) {
      showLiveDebug("Room pane limit reached (16 max).", "error");
      return null;
    }
    showLiveDebug("Opening AI Live audio pane...", "info");
    const targetCount = Math.min(Math.max(1, count), 16 - panes.length);
    let lastPane: Pane | null = null;
    try {
      for (let i = 0; i < targetCount; i++) {
        const pane = await api.createPane(targetRoomId, title ?? paneTitleForMode("LIVE", panes.length + 1), "LIVE");
        setPanes((current) => [...current.filter((candidate) => candidate.id !== pane.id), pane]);
        setSelectedPaneId(pane.id);
        lastPane = pane;
      }
      await refreshRoomEvents(targetRoomId);
      showLiveDebug("AI Live pane opened successfully.", "success");
      return lastPane;
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Live audio pane failed to open";
      setError(msg);
      showLiveDebug(`AI Live pane error: ${msg}`, "error");
      return null;
    }
  }

  function activateLiveFromRail() {
    showLiveDebug("AI Live button tapped...", "info");
    const targetRoomId = selectedRoomId || activeRoom?.id || rooms[0]?.id;
    if (!targetRoomId) {
      showLiveDebug("No active room found for AI Live.", "error");
      return;
    }
    if (!selectedRoomId) {
      setSelectedRoomId(targetRoomId);
    }
    window.dispatchEvent(new CustomEvent("space-live-rail-toggle"));
  }

  async function addLegacyHarnessPane() {
    if (!selectedRoomId || panes.length >= 16) return;
    let createdPaneId: string | null = null;
    try {
      const pane = await api.createPane(selectedRoomId, "DeepSeek Harness", "BROWSER");
      createdPaneId = pane.id;
      await api.startBrowserSession(pane.id, {
        targetUrl: "http://127.0.0.1:3080/"
      });
      setPanes((current) => [...current.filter((candidate) => candidate.id !== pane.id), pane]);
      setSelectedPaneId(pane.id);
      await refreshRoomEvents(selectedRoomId);
    } catch (err) {
      if (createdPaneId) await api.closePane(createdPaneId).catch(() => undefined);
      setError(err instanceof Error ? err.message : "DeepSeek Harness pane failed to open");
    }
  }

  async function splitPane(sourcePane: Pane, direction: "horizontal" | "vertical") {
    if (!selectedRoomId) return;
    const paneLimit = roomPaneLimit(rooms.find((room) => room.id === selectedRoomId));
    if (panes.length >= paneLimit) {
      setError(`This room already has the maximum of ${paneLimit} panes.`);
      return;
    }
    const sourceTerminalRuntimeId = sourcePane.mode === "TERMINAL"
      ? sourcePane.terminalRuntimeId ?? "cli:codex"
      : null;
    if (
      !isCodexEnabled &&
      (sourcePane.mode === "CHAT" || sourceTerminalRuntimeId === "cli:codex")
    ) return;

    let paneCwd = sourcePane.mode === "TERMINAL" ? null : sourcePane.cwd;
    if (sourcePane.mode === "TERMINAL") {
      const targetRoom = rooms.find((r) => r.id === selectedRoomId);
      const effectiveProjectPath = targetRoom?.projectPath || dockProjectPathDrafts[selectedRoomId]?.trim() || "/opt/spaceapp";
      const baseRepoPath = (sourcePane.cwd && !sourcePane.cwd.includes("/worktrees/") && !sourcePane.cwd.includes("/agent-workspace/"))
        ? sourcePane.cwd
        : effectiveProjectPath;
      if (isRoomWorktreeEnabled(selectedRoomId)) {
        try {
          const wt = await createWorktree({
            repoPath: baseRepoPath,
            roomId: selectedRoomId,
            baseBranch: "main",
            linkModules: true
          });
          paneCwd = wt.worktreePath;
          if (!targetRoom?.projectPath && targetRoom) {
            void api.updateRoom(selectedRoomId, { name: targetRoom.name, projectPath: effectiveProjectPath }).then((updated) => {
              setRooms((current) => current.map((r) => (r.id === selectedRoomId ? updated : r)));
            }).catch((err) => {
              console.warn("Failed to persist the room project path:", err);
            });
          }
        } catch (err) {
          console.warn("Failed to provision worktree for split CLI pane, falling back to project path:", err);
          paneCwd = effectiveProjectPath;
        }
      } else {
        paneCwd = effectiveProjectPath;
      }
    }

    let pane: Pane;
    try {
      pane = await api.createPane(selectedRoomId, paneTitleForMode(sourcePane.mode, panes.length + 1), sourcePane.mode, {
        providerId: sourcePane.providerId,
        modelId: sourcePane.modelId,
        terminalRuntimeId: sourceTerminalRuntimeId,
        cwd: paneCwd,
        vncTarget: sourcePane.mode === "VNC" ? sourcePane.vncTarget : null,
        split: { parentId: sourcePane.id, direction, size: 50 }
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Pane could not be added.");
      return;
    }
    setPanes((current) => [...current, pane]);
    setSelectedPaneId(pane.id);
    await refreshRoomEvents(selectedRoomId);
  }

  async function closePane(paneId: string) {
    // Remove the pane first so the click feels instant; the server stops the
    // pane's session meanwhile and a failure puts the pane back where it was.
    const closingIndex = panesRef.current.findIndex((pane) => pane.id === paneId);
    const closingPane = closingIndex >= 0 ? panesRef.current[closingIndex] : null;
    const wasSelected = selectedPaneIdRef.current === paneId;
    setPanes((current) => current.filter((pane) => pane.id !== paneId));
    setSelectedPaneId((current) => (current === paneId ? null : current));
    try {
      await api.closePane(paneId);
    } catch (err) {
      if (closingPane) {
        setPanes((current) => {
          if (current.some((pane) => pane.id === paneId) || current.some((pane) => pane.roomId !== closingPane.roomId)) return current;
          const restored = [...current];
          restored.splice(Math.min(closingIndex, restored.length), 0, closingPane);
          return restored;
        });
        if (wasSelected) setSelectedPaneId((current) => current ?? paneId);
      }
      setError(err instanceof Error ? err.message : "Pane close failed");
      return;
    }
    const roomId = closingPane?.roomId ?? selectedRoomIdRef.current;
    // Closing changes only this pane server-side; refresh room metadata in the
    // background instead of re-hydrating the whole room runtime.
    if (roomId) void loadRoomMetadata(roomId).catch(() => undefined);
  }

  async function toggleMaximize(pane: Pane) {
    const willBeMaximized = !pane.isMaximized;
    setSelectedPaneId(pane.id);
    setPanes((current) =>
      current.map((item) => {
        if (item.id === pane.id) return { ...item, isMaximized: willBeMaximized };
        if (willBeMaximized && item.isMaximized) return { ...item, isMaximized: false };
        return item;
      })
    );
    try {
      const updated = await api.updatePane(pane.id, { isMaximized: willBeMaximized });
      setPanes((current) => current.map((item) => (item.id === updated.id ? updated : item)));
      void refreshRoomEvents(pane.roomId);
    } catch (err) {
      setPanes((current) =>
        current.map((item) => (item.id === pane.id ? { ...item, isMaximized: !willBeMaximized } : item))
      );
      setError(err instanceof Error ? err.message : "Failed to toggle pane maximize");
    }
  }

  const cycleRoomCategoryColor = useStableCallback((roomId: string, deltaY: number) => {
    const colors = roomCategoryColors(panes.filter((pane) => pane.roomId === roomId));
    const current = activeCategoryColorByRoom[roomId] ?? null;
    const next = nextCategoryColor(current, colors, deltaY);
    setActiveCategoryColorByRoom((currentMap) => {
      if ((currentMap[roomId] ?? null) === next) return currentMap;
      return { ...currentMap, [roomId]: next };
    });
    writeStoredCategoryFilter(roomId, next);
    if (selectedRoomIdRef.current === roomId && next !== null) {
      const filteredVisiblePanes = panes.filter(
        (pane) => pane.roomId === roomId && !pane.isMinimized && pane.categoryColor === next
      );
      const currentSelectedPaneId = selectedPaneIdRef.current;
      if (currentSelectedPaneId && !filteredVisiblePanes.some((pane) => pane.id === currentSelectedPaneId)) {
        setSelectedPaneId(filteredVisiblePanes[0]?.id ?? null);
      }
    }
  });

  // Window flags change on screen first (as toggleMaximize does); the server
  // result then reconciles them. Returns the previous flags for rollback.
  function applyOptimisticPaneFlags(
    roomId: string,
    flagsFor: (pane: Pane) => Partial<Pick<Pane, "isMinimized" | "isMaximized">> | null
  ) {
    const previousFlags = new Map<string, Pick<Pane, "isMinimized" | "isMaximized">>();
    for (const pane of panesRef.current) {
      if (pane.roomId !== roomId) continue;
      const flags = flagsFor(pane);
      if (!flags) continue;
      if ((flags.isMinimized ?? pane.isMinimized) === pane.isMinimized && (flags.isMaximized ?? pane.isMaximized) === pane.isMaximized) continue;
      previousFlags.set(pane.id, { isMinimized: pane.isMinimized, isMaximized: pane.isMaximized });
    }
    if (previousFlags.size > 0) {
      setPanes((current) => current.map((item) => {
        if (!previousFlags.has(item.id)) return item;
        const flags = flagsFor(item);
        return flags ? { ...item, ...flags } : item;
      }));
    }
    return previousFlags;
  }

  function rollbackOptimisticPaneFlags(previousFlags: Map<string, Pick<Pane, "isMinimized" | "isMaximized">>) {
    if (previousFlags.size === 0) return;
    setPanes((current) => current.map((item) => {
      const flags = previousFlags.get(item.id);
      return flags ? { ...item, ...flags } : item;
    }));
  }

  function reconcileRoomPanes(roomId: string, serverPanes: readonly Pane[]) {
    if (selectedRoomIdRef.current !== roomId) return;
    // A failed PATCH leaves updatedAt unchanged, so the window flags are part
    // of the version: an optimistic object never survives a server mismatch.
    setPanes((current) => reuseVersionedItems(
      current,
      serverPanes,
      (pane) => `${pane.updatedAt}|${pane.isMinimized}|${pane.isMaximized}`
    ));
  }

  async function minimizePane(pane: Pane) {
    setError(null);
    const remainingVisible = sortPanesForGrid(panesRef.current.filter((candidate) => candidate.roomId === pane.roomId && candidate.id !== pane.id && !candidate.isMinimized));
    const nextPane = remainingVisible.find((candidate) => candidate.order > pane.order) ?? remainingVisible[0] ?? null;
    const previousSelectedPaneId = selectedPaneIdRef.current;
    const previousFlags = applyOptimisticPaneFlags(pane.roomId, (candidate) =>
      candidate.id === pane.id ? { isMinimized: true, isMaximized: false } : null
    );
    setSelectedPaneId(nextPane?.id ?? null);
    // With the bar parked behind the float toggle, focus goes to whichever affordance is visible.
    window.requestAnimationFrame(() => {
      const restoreChip = minimizedPaneRestoreRefs.current.get(pane.id);
      if (restoreChip) restoreChip.focus();
      else document.getElementById(MINIMIZED_PANE_BAR_TOGGLE_ID)?.focus();
    });
    try {
      const updated = await api.updatePane(pane.id, { isMinimized: true });
      setPanes((current) => current.map((item) => (item.id === updated.id ? updated : item)));
      void refreshRoomEvents(pane.roomId).catch(() => undefined);
    } catch (err) {
      rollbackOptimisticPaneFlags(previousFlags);
      setSelectedPaneId((current) => (current === (nextPane?.id ?? null) ? previousSelectedPaneId : current));
      setError(err instanceof Error ? err.message : "Pane minimize failed");
    }
  }

  async function restorePane(pane: Pane) {
    setError(null);
    const otherMaximized = panesRef.current.filter(
      (candidate) => candidate.roomId === pane.roomId && candidate.id !== pane.id && candidate.isMaximized
    );
    const previousSelectedPaneId = selectedPaneIdRef.current;
    const previousFlags = applyOptimisticPaneFlags(pane.roomId, (candidate) => {
      if (candidate.id === pane.id) return { isMinimized: false, isMaximized: false };
      return candidate.isMaximized ? { isMaximized: false } : null;
    });
    pendingPaneHeaderFocusIdRef.current = pane.id;
    setSelectedPaneId(pane.id);
    const results = await Promise.allSettled([
      api.updatePane(pane.id, { isMinimized: false, isMaximized: false }),
      ...otherMaximized.map((candidate) => api.updatePane(candidate.id, { isMaximized: false }))
    ]);
    try {
      const reconciled = await api.panes(pane.roomId);
      reconcileRoomPanes(pane.roomId, reconciled.data);
      const restored = reconciled.data.find((candidate) => candidate.id === pane.id && !candidate.isMinimized);
      if (!restored) {
        if (pendingPaneHeaderFocusIdRef.current === pane.id) pendingPaneHeaderFocusIdRef.current = null;
        setSelectedPaneId((current) => (current === pane.id ? previousSelectedPaneId : current));
      }
      if (results.some((result) => result.status === "rejected")) {
        setError("Pane restore was only partially applied. Room state was refreshed.");
      }
      void refreshRoomEvents(pane.roomId).catch(() => undefined);
    } catch (err) {
      if (results.every((result) => result.status === "rejected")) {
        rollbackOptimisticPaneFlags(previousFlags);
        setSelectedPaneId((current) => (current === pane.id ? previousSelectedPaneId : current));
      }
      setError(err instanceof Error ? err.message : "Pane restore failed");
    }
  }

  async function restoreAllPanes() {
    if (!selectedRoomId || restoreAllPending) return;
    const roomId = selectedRoomId;
    const roomPanes = panesRef.current.filter((pane) => pane.roomId === roomId);
    const allWereMinimized = roomPanes.length > 0 && roomPanes.every((pane) => pane.isMinimized);
    const candidates = roomPanes.filter((pane) => pane.isMinimized || pane.isMaximized).slice(0, 16);
    const candidateIds = new Set(candidates.map((pane) => pane.id));
    setRestoreAllPending(true);
    setError(null);
    const previousFlags = applyOptimisticPaneFlags(roomId, (pane) =>
      candidateIds.has(pane.id) ? { isMinimized: false, isMaximized: false } : null
    );
    const optimisticVisible = sortPanesForGrid(
      roomPanes.filter((pane) => candidateIds.has(pane.id) || !pane.isMinimized)
    );
    setSelectedPaneId((current) => {
      if (allWereMinimized) return optimisticVisible[0]?.id ?? null;
      return optimisticVisible.some((pane) => pane.id === current) ? current : optimisticVisible[0]?.id ?? null;
    });
    const results = await Promise.allSettled(
      candidates.map((pane) => api.updatePane(pane.id, { isMinimized: false, isMaximized: false }))
    );
    try {
      const reconciled = await api.panes(roomId);
      reconcileRoomPanes(roomId, reconciled.data);
      const visiblePanes = reconciled.data.filter((pane) => !pane.isMinimized);
      if (selectedRoomIdRef.current === roomId) {
        setSelectedPaneId((current) => (
          visiblePanes.some((pane) => pane.id === current) ? current : visiblePanes[0]?.id ?? null
        ));
      }
      if (results.some((result) => result.status === "rejected")) {
        const failedCount = results.filter((result) => result.status === "rejected").length;
        setError(`Restore all partially failed for ${failedCount} pane${failedCount === 1 ? "" : "s"}. Room state was refreshed.`);
      }
      void refreshRoomEvents(roomId).catch(() => undefined);
    } catch (err) {
      if (results.length > 0 && results.every((result) => result.status === "rejected")) rollbackOptimisticPaneFlags(previousFlags);
      setError(err instanceof Error ? err.message : "Restore all failed");
    } finally {
      setRestoreAllPending(false);
    }
  }

  async function minimizeAllPanes() {
    if (!selectedRoomId || minimizeAllPending) return;
    const roomId = selectedRoomId;
    const candidates = panesRef.current.filter((pane) => pane.roomId === roomId && !pane.isMinimized).slice(0, 16);
    if (candidates.length === 0) return;
    const candidateIds = new Set(candidates.map((pane) => pane.id));
    const previousSelectedPaneId = selectedPaneIdRef.current;
    setMinimizeAllPending(true);
    setError(null);
    const previousFlags = applyOptimisticPaneFlags(roomId, (pane) =>
      candidateIds.has(pane.id) ? { isMinimized: true, isMaximized: false } : null
    );
    setSelectedPaneId(null);
    const results = await Promise.allSettled(
      candidates.map((pane) => api.updatePane(pane.id, { isMinimized: true }))
    );
    try {
      const reconciled = await api.panes(roomId);
      reconcileRoomPanes(roomId, reconciled.data);
      if (results.some((result) => result.status === "rejected")) {
        const failedCount = results.filter((result) => result.status === "rejected").length;
        setError(`Minimize all partially failed for ${failedCount} pane${failedCount === 1 ? "" : "s"}. Room state was refreshed.`);
      }
      void refreshRoomEvents(roomId).catch(() => undefined);
    } catch (err) {
      if (results.every((result) => result.status === "rejected")) {
        rollbackOptimisticPaneFlags(previousFlags);
        setSelectedPaneId((current) => current ?? previousSelectedPaneId);
      }
      setError(err instanceof Error ? err.message : "Minimize all failed");
    } finally {
      setMinimizeAllPending(false);
    }
  }

  async function updatePaneColumnSpan(pane: Pane, columnSpan: number, anchorColumnStart?: number) {
    const nextColumnSpan = Math.max(1, Math.min(MAX_PANE_COLUMN_SPAN, columnSpan));
    if ((pane.columnSpan ?? 1) === nextColumnSpan) return;
    const previousColumnSpan = pane.columnSpan;
    const previousAnchorColumnStart = paneColumnAnchorStartsRef.current.get(pane.id);
    if (anchorColumnStart !== undefined) {
      paneColumnAnchorStartsRef.current.set(pane.id, anchorColumnStart);
    }
    setPanes((current) =>
      current.map((item) => (item.id === pane.id ? { ...item, columnSpan: nextColumnSpan } : item))
    );
    try {
      const updated = await api.updatePane(pane.id, { columnSpan: nextColumnSpan });
      setPanes((current) => current.map((item) => (item.id === updated.id ? updated : item)));
      void refreshRoomEvents(pane.roomId);
    } catch (error) {
      setPanes((current) =>
        current.map((item) => (item.id === pane.id ? { ...item, columnSpan: previousColumnSpan } : item))
      );
      if (anchorColumnStart !== undefined) {
        if (previousAnchorColumnStart === undefined) {
          paneColumnAnchorStartsRef.current.delete(pane.id);
        } else {
          paneColumnAnchorStartsRef.current.set(pane.id, previousAnchorColumnStart);
        }
      }
      // Every caller fires and forgets; report the rollback instead of leaving an unhandled rejection.
      setError(error instanceof Error ? error.message : "Pane width could not be changed.");
    }
  }

  function handlePaneUpdated(updatedPane: Pane) {
    setPanes((current) => current.map((pane) => (pane.id === updatedPane.id ? updatedPane : pane)));
    void refreshRoomEvents(updatedPane.roomId);
  }

  const activeRoom = useMemo(() => rooms.find((room) => room.id === selectedRoomId) ?? null, [rooms, selectedRoomId]);
  const roomRename = useRoomRename({
    activeRoom,
    setRooms,
    onBeginRename: () => {
      setIsThemeMenuOpen(false);
      setIsWorkspaceTextSizePickerOpen(false);
      roomToolbar.closeMenus();
    }
  });
  const {
    isRoomRenameOpen, setIsRoomRenameOpen, roomNameDraft, setRoomNameDraft, roomRenamePending, setRoomRenamePending, roomRenameError,
    setRoomRenameError, beginRoomRename, submitRoomRename
  } = roomRename;
  const controlLayouts = useSpaceControlClient(selectedRoomId, Boolean(auth?.isAuthenticated && auth.user?.role === "ADMIN" && !auth.user?.automationScope), selectRoom, setSelectedPaneId);
  const activeRoomCategoryFilter = useMemo(
    () => (selectedRoomId ? (activeCategoryColorByRoom[selectedRoomId] ?? null) : null),
    [selectedRoomId, activeCategoryColorByRoom]
  );
  const activeRoomCategoryColors = useMemo(
    () => (activeRoom ? roomCategoryColors(panes.filter((pane) => pane.roomId === activeRoom.id)) : []),
    [activeRoom, panes]
  );
  const [floatingYouTubePaneIds, setFloatingYouTubePaneIds] = useState<Set<string>>(() => {
    try {
      const stored = localStorage.getItem("space.youtube.floating.panes.v1");
      return stored ? new Set(JSON.parse(stored)) : new Set();
    } catch {
      return new Set();
    }
  });
  const toggleYouTubeFloating = useCallback((paneId: string) => {
    setFloatingYouTubePaneIds((prev) => {
      const next = new Set(prev);
      if (next.has(paneId)) {
        next.delete(paneId);
      } else {
        next.add(paneId);
      }
      try {
        localStorage.setItem("space.youtube.floating.panes.v1", JSON.stringify(Array.from(next)));
      } catch {}
      return next;
    });
  }, []);
  useYouTubeFloatRequest({ panes, activeRoomId: activeRoom?.id ?? null, floatingIds: floatingYouTubePaneIds, toggle: toggleYouTubeFloating });
  const visiblePanes = useMemo(() => {
    const unfiltered = panes.filter((pane) => (shellMode === "mobile" || !pane.isMinimized) && !floatingYouTubePaneIds.has(pane.id));
    return activeRoomCategoryFilter
      ? unfiltered.filter((pane) => pane.categoryColor === activeRoomCategoryFilter)
      : unfiltered;
  }, [panes, activeRoomCategoryFilter, floatingYouTubePaneIds, shellMode]);
  const minimizedPaneBar = useMinimizedPaneBar({ panes, shellMode, paneCompletionLifecycle });
  const { minimizedCount, minimizedPaneRunningCount, showMinimizedBar, showMinimizedBarToggle, setMinimizedBarExpanded } = minimizedPaneBar;

  const activePane = useMemo(
    () => {
      if (selectedPaneId) {
        const match = visiblePanes.find((pane) => pane.id === selectedPaneId && (shellMode === "mobile" || !pane.isMinimized));
        if (match) return match;
      }
      return (shellMode === "mobile" ? null : visiblePanes.find((pane) => !pane.isMinimized))
        ?? visiblePanes.find((pane) => pane.id === selectedPaneId)
        ?? visiblePanes[0]
        ?? null;
    },
    [selectedPaneId, visiblePanes, shellMode]
  );
  const presentationRoom = useMemo(
    () => rooms.find((room) => room.id === displayedRoomId) ?? activeRoom,
    [activeRoom, displayedRoomId, rooms]
  );
  const presentationRuntime =
    displayedRoomId && displayedRoomId !== selectedRoomId
      ? roomRuntimes[displayedRoomId] ?? null
      : null;
  const presentationPanes = presentationRuntime?.panes ?? panes;
  const presentationSelectedPaneId = presentationRuntime?.selectedPaneId ?? selectedPaneId;
  const presentationActivePane = useMemo(() => {
    const presentationVisiblePanes = presentationPanes.filter((pane) => shellMode === "mobile" || !pane.isMinimized);
    return presentationVisiblePanes.find((pane) => pane.id === presentationSelectedPaneId)
      ?? presentationVisiblePanes[0]
      ?? null;
  }, [presentationPanes, presentationSelectedPaneId, shellMode]);
  const activeTerminalPanesBootstrapped = useMemo(() => {
    if (!activeRoom) return true;
    const bootstrappedPaneIds = new Set(roomRuntimes[activeRoom.id]?.bootstrappedPaneIds ?? []);
    return panes.every(
      (pane) => pane.isMinimized || pane.mode !== "TERMINAL" || bootstrappedPaneIds.has(pane.id)
    );
  }, [activeRoom, panes, roomRuntimes]);

  function insertClipboardItem(item: ClipboardItem) {
    if (!activePane) return;
    if (activePane.mode === "CHAT") {
      dispatchAgentPaneAction(activePane.id, { action: "insert_text", text: item.text });
      return;
    }
    if (activePane.mode === "TERMINAL") {
      dispatchTerminalPaneAction(activePane.id, { action: "insert_clipboard_text", text: item.text });
    }
  }

  function insertTaskItem(item: TaskItem) {
    if (!activePane) return;
    if (activePane.mode === "CHAT") {
      dispatchAgentPaneAction(activePane.id, { action: "insert_text", text: item.objective });
      return;
    }
    if (activePane.mode === "TERMINAL") {
      dispatchTerminalPaneAction(activePane.id, { action: "start_task_item", objective: item.objective });
    }
  }

  function routeCliShortcut(command: OskCliCommand): boolean {
    if (activePane?.mode === "CHAT" && (command.id === "plan_progress" || command.id === "deploy" || command.id === "promote" || command.id === "clean_worktree" || command.id === "scroll_top" || command.id === "scroll_bottom")) {
      setIsOskKeyboardOpen(false);
      dispatchAgentPaneActionEvent({ paneId: activePane.id, action: command.id });
      return true;
    }
    if (command.action) {
      if (activePane?.mode === "CHAT") {
        if (command.action === "permissions" || command.action === "scroll_top" || command.action === "scroll_bottom") setIsOskKeyboardOpen(false);
        dispatchAgentPaneActionEvent({ paneId: activePane.id, action: command.action === "plan" ? "toggle_plan" : command.action });
        return true;
      }
      if (activePane?.mode !== "TERMINAL") return true;
    }
    if (activePane?.mode !== "TERMINAL") return false;
    dispatchTerminalPaneAction(activePane.id, { action: "cli_shortcut", commandId: command.id });
    return true;
  }

  function routeOnScreenKeyboardInput(input: OnScreenKeyboardInput): boolean {
    if (!activePane) return false;
    if (activePane.mode === "TERMINAL") {
      dispatchTerminalPaneAction(activePane.id, { action: "keyboard_input", text: input.terminalData });
      return true;
    }
    if (activePane.mode === "CHAT" && input.text !== null) {
      dispatchAgentPaneAction(activePane.id, { action: "insert_text", text: input.text });
      return true;
    }
    return false;
  }

  useEffect(() => {
    if (
      !auth?.isAuthenticated ||
      auth?.user?.automationScope === "APP_DIAGNOSTICS"
    ) return;
    api.warmCliRuntimes();
  }, [auth?.isAuthenticated, auth?.user?.automationScope]);

  useEffect(() => {
    if (!activeRoom || !auth?.isAuthenticated || !activeTerminalPanesBootstrapped || isCliLauncherOpen) {
      setActiveRoomEventStreamStatus("idle");
      return;
    }
    if (!eventGateway.supported) {
      setActiveRoomEventStreamStatus("unavailable");
      recordLifecycleDebugEvent({
        type: "sse_state_changed",
        scope: "App",
        detail: `room=${activeRoom.id} state=unavailable`,
        notify: false
      });
      return;
    }
    if (!shouldOpenAppEventStreams({
      authenticated: auth.isAuthenticated,
      terminalsConnected: activeTerminalPanesBootstrapped,
      eventSourceSupported: eventGateway.supported,
      cliLauncherOpen: isCliLauncherOpen
    })) return;

    setActiveRoomEventStreamStatus("connecting");
    recordLifecycleDebugEvent({
      type: "sse_state_changed",
      scope: "App",
      detail: `room=${activeRoom.id} state=connecting`,
      notify: false
    });
    const source = eventGateway.open(api.eventStreamUrl({ roomId: activeRoom.id, replayLimit: 50 }), { withCredentials: true });
    let replaying = true;
    let baselineReplay = !paneCompletionInitialReplayRoomIdsRef.current.has(activeRoom.id);
    let replayCompletionEvents: SpaceEvent[] = [];
    const replayRefreshCategories = new Set<RoomRefreshCategory>();
    const markConnected = () => {
      setActiveRoomEventStreamStatus("connected");
      if (runtimeKind === "live") reportCoreApiSuccess();
      recordLifecycleDebugEvent({
        type: "sse_state_changed",
        scope: "App",
        detail: `room=${activeRoom.id} state=connected`,
        notify: false
      });
    };
    const markDisconnected = () => {
      setActiveRoomEventStreamStatus("disconnected");
      if (runtimeKind === "live") reportCoreApiFailure();
      recordLifecycleDebugEvent({
        type: "sse_state_changed",
        scope: "App",
        detail: `room=${activeRoom.id} state=disconnected`,
        notify: false
      });
    };
    const requestRefresh = (category: RoomRefreshCategory, reason: string) => {
      void requestRoomRefreshRef.current(activeRoom.id, category, reason).catch((refreshError: unknown) => {
        if (!appMountedRef.current || selectedRoomIdRef.current !== activeRoom.id) return;
        if (isRoomNotFoundError(refreshError, activeRoom.id)) {
          void recoverMissingRoom();
          return;
        }
        if (!isTransientUpstreamRuntimeError(refreshError)) {
          setError(refreshError instanceof Error ? refreshError.message : "Room refresh failed");
        }
      });
    };
    const handleSpaceEvent = (message: MessageEvent<string>) => {
      const event = parseStreamEvent(message.data, activeRoom.id);
      if (!event || selectedRoomIdRef.current !== activeRoom.id) return;
      if (replaying && baselineReplay) replayCompletionEvents.push(event);
      appendRoomEvent(event, !replaying || !baselineReplay);
      if (/^(PANE_|TASK_|ROOM_AGENT_|MISSION_|MODEL_)/.test(event.type)) window.dispatchEvent(new CustomEvent("space-live-context-invalidated", { detail: { roomId: activeRoom.id } }));
      if (event.type === "PANE_UPDATED" && event.payload.roomPaneLayoutChanged === true) {
        void requestRoomCatalogRefreshRef.current();
      }
      // A replayed alert is history: every room switch or reconnect replays the room's last 50 events, which brought a
      // dismissed alert back again and again. Its URGENT notification stays in the Notifications dock.
      if (event.type === "ROOM_WATCHDOG_ALERT" && !replaying) {
        notices.addWatchdogAlert({ id: event.id, message: event.message, timestamp: event.createdAt });
      }
      for (const category of roomRefreshCategoriesForEvent(event.type)) {
        if (replaying) replayRefreshCategories.add(category);
        else requestRefresh(category, `sse:${event.type}`);
      }
    };
    const handleReplayStart = () => {
      replaying = true;
      baselineReplay = !paneCompletionInitialReplayRoomIdsRef.current.has(activeRoom.id);
      replayCompletionEvents = [];
      replayRefreshCategories.clear();
    };
    const handleReplayComplete = () => {
      if (baselineReplay) {
        commitPaneCompletionLifecycle(
          hydratePaneCompletionReplay(
            paneCompletionLifecycleRef.current,
            activeRoom.id,
            replayCompletionEvents
          )
        );
        paneCompletionInitialReplayRoomIdsRef.current.add(activeRoom.id);
      }
      replayCompletionEvents = [];
      replaying = false;
      for (const category of replayRefreshCategories) requestRefresh(category, "sse:replay-complete");
      replayRefreshCategories.clear();
    };

    source.onopen = markConnected;
    source.onerror = markDisconnected;
    source.onmessage = handleSpaceEvent;
    source.addEventListener("ready", markConnected);
    source.addEventListener("replay-start", handleReplayStart);
    source.addEventListener("replay-complete", handleReplayComplete);
    for (const eventType of streamEventTypes) {
      source.addEventListener(eventType, handleSpaceEvent as EventListener);
    }

    return () => {
      source.onopen = null;
      source.onerror = null;
      source.onmessage = null;
      source.removeEventListener("ready", markConnected);
      source.removeEventListener("replay-start", handleReplayStart);
      source.removeEventListener("replay-complete", handleReplayComplete);
      for (const eventType of streamEventTypes) {
        source.removeEventListener(eventType, handleSpaceEvent as EventListener);
      }
      source.close();
    };
  }, [activeRoom, activeTerminalPanesBootstrapped, appendRoomEvent, auth?.isAuthenticated, isCliLauncherOpen]);

  useEffect(() => {
    if (!activeRoom || !auth?.isAuthenticated || !shouldUseEventStreamFallback(activeRoomEventStreamStatus)) return;
    let disposed = false;
    const refreshFromFallback = async () => {
      try {
        await requestRoomRefreshRef.current(activeRoom.id, "panes", "sse:fallback");
        await requestRoomRefreshRef.current(activeRoom.id, "turns", "sse:fallback");
        await requestRoomRefreshRef.current(activeRoom.id, "swarm", "sse:fallback");
        await requestRoomRefreshRef.current(activeRoom.id, "events", "sse:fallback");
      } catch (refreshError) {
        if (disposed || !appMountedRef.current || selectedRoomIdRef.current !== activeRoom.id) return;
        if (isRoomNotFoundError(refreshError, activeRoom.id)) {
          void recoverMissingRoom();
          return;
        }
        if (!isTransientUpstreamRuntimeError(refreshError)) {
          setError(refreshError instanceof Error ? refreshError.message : "Room fallback refresh failed");
        }
      }
    };
    void refreshFromFallback();
    const interval = window.setInterval(() => void refreshFromFallback(), 30_000);
    return () => {
      disposed = true;
      window.clearInterval(interval);
    };
  }, [activeRoom, activeRoomEventStreamStatus, auth?.isAuthenticated]);

  useEffect(() => {
    if (!auth?.isAuthenticated || !activeTerminalPanesBootstrapped || !eventGateway.supported) return;
    const source = eventGateway.open(api.eventStreamUrl({ replayLimit: 200 }), { withCredentials: true });
    let replaying = true;
    let replayCreatedRoom = false;
    let replayCapabilityStatusChanged = false;
    const refreshRoomCatalog = () => {
      void requestRoomCatalogRefreshRef.current().catch(() => {
        // The catalog remains usable from its last successful snapshot during temporary failures.
      });
    };
    const handleRoomCreated = (message: MessageEvent<string>) => {
      const event = parseStreamEvent(message.data);
      if (!event || event.type !== "ROOM_CREATED") return;
      if (replaying) {
        replayCreatedRoom = true;
        return;
      }
      refreshRoomCatalog();
    };
    const handleReplayStart = () => {
      replaying = true;
      replayCreatedRoom = false;
      replayCapabilityStatusChanged = false;
    };
    const handleReplayComplete = () => {
      replaying = false;
      if (replayCreatedRoom) refreshRoomCatalog();
      if (replayCapabilityStatusChanged) dispatchCliRuntimeVisibilityChange({ source: "server" });
      replayCreatedRoom = false;
      replayCapabilityStatusChanged = false;
    };
    const handleBrowserHandoff = (message: MessageEvent<string>) => {
      const event = parseStreamEvent(message.data);
      if (
        !event ||
        event.type !== "BROWSER_HANDOFF_REQUESTED" ||
        !event.paneId ||
        handledBrowserHandoffEventIdsRef.current.has(event.id)
      ) {
        return;
      }
      handledBrowserHandoffEventIdsRef.current.add(event.id);
      if (handledBrowserHandoffEventIdsRef.current.size > 500) handledBrowserHandoffEventIdsRef.current.clear();
      void api.browserHandoff(event.paneId)
        .then(async ({ handoff }) => {
          if (handoff?.status !== "REQUESTED") return;
          activateRoom(handoff.roomId);
          await loadRoomRuntimeRef.current(handoff.roomId);
          setSelectedPaneId(handoff.paneId);
          setPendingBrowserHandoffPaneId(handoff.paneId);
        })
        .catch((error: unknown) => {
          // A closed (409) or deleted (404) pane never comes back; only retry transient failures.
          if (error instanceof SpaceApiError && (error.status === 404 || error.status === 409)) return;
          handledBrowserHandoffEventIdsRef.current.delete(event.id);
        });
    };
    const handleCapabilityStatusChanged = (message: MessageEvent<string>) => {
      const event = parseStreamEvent(message.data);
      if (!event || event.type !== "CAPABILITY_STATUS_CHANGED") return;
      if (replaying) {
        replayCapabilityStatusChanged = true;
        return;
      }
      dispatchCliRuntimeVisibilityChange({ source: "server" });
    };
    source.addEventListener("replay-start", handleReplayStart);
    source.addEventListener("replay-complete", handleReplayComplete);
    source.addEventListener("ROOM_CREATED", handleRoomCreated as EventListener);
    source.addEventListener("BROWSER_HANDOFF_REQUESTED", handleBrowserHandoff as EventListener);
    source.addEventListener("CAPABILITY_STATUS_CHANGED", handleCapabilityStatusChanged as EventListener);
    // Copilot activity (copilot-kit/copilot-stream.ts) and Nous focus requests (nous-focus) reach the page as window events.
    const stopWindowStreams = [forwardCopilotStreamEvents(source), forwardNousFocusEvents(source)];
    // Notifications travel as ids only; the store reads the owner's records and delivers the new ones.
    const handleNotification = (message: MessageEvent<string>) => {
      const event = parseStreamEvent(message.data);
      if (!event || (event.type !== "NOTIFICATION_CREATED" && event.type !== "NOTIFICATION_UPDATED") || replaying) return;
      dispatchNotificationStreamEvent(event.payload);
    };
    source.addEventListener("NOTIFICATION_CREATED", handleNotification as EventListener);
    source.addEventListener("NOTIFICATION_UPDATED", handleNotification as EventListener);
    return () => {
      source.removeEventListener("replay-start", handleReplayStart);
      source.removeEventListener("replay-complete", handleReplayComplete);
      source.removeEventListener("ROOM_CREATED", handleRoomCreated as EventListener);
      source.removeEventListener("BROWSER_HANDOFF_REQUESTED", handleBrowserHandoff as EventListener);
      source.removeEventListener("CAPABILITY_STATUS_CHANGED", handleCapabilityStatusChanged as EventListener);
      for (const stop of stopWindowStreams) stop();
      source.removeEventListener("NOTIFICATION_CREATED", handleNotification as EventListener);
      source.removeEventListener("NOTIFICATION_UPDATED", handleNotification as EventListener);
      source.close();
    };
  }, [activeTerminalPanesBootstrapped, auth?.isAuthenticated]);

  useEffect(() => {
    if (!auth?.isAuthenticated) return;
    const handleCliRuntimeVisibility = (event: Event) => {
      const change = readCliRuntimeVisibilityChange(event);
      api.invalidateCliRuntimes(change ?? undefined);
      api.invalidateCliRuntimeSettings();
      void api.cliRuntimes().catch(() => undefined);
      // Bypass the 15s environment cache: availability just changed.
      void api.codexEnvironment(true)
        .then((environment) => {
          if (appMountedRef.current) setCodexEnvironmentSummary(environment);
        })
        .catch(() => undefined);
      void api.cliRuntimeSettings()
        .then((settings) => {
          if (appMountedRef.current) setCliRuntimeSettings(settings);
        })
        .catch(() => undefined);
      const roomIds = new Set<string>([
        ...(selectedRoomIdRef.current ? [selectedRoomIdRef.current] : []),
        ...warmRoomIdsRef.current
      ]);
      for (const roomId of roomIds) {
        void requestRoomRefreshRef.current(roomId, "panes", "cli-runtime-visibility").catch(() => undefined);
      }
      void api.roomCliActivity()
        .then((payload) => {
          if (!appMountedRef.current) return;
          setRoomPaneCounts(Object.fromEntries(
            payload.data.flatMap((activity) => activity.paneCount === undefined ? [] : [[activity.roomId, activity.paneCount]])
          ));
          setRoomCliActivityCounts(Object.fromEntries(
            payload.data.map((activity) => [activity.roomId, activity.runningCliCount])
          ));
          setRoomCliRuntimeIds(Object.fromEntries(
            payload.data.map((activity) => [
              activity.roomId,
              (activity as typeof activity & { runtimeIds?: string[] }).runtimeIds ?? []
            ])
          ));
        })
        .catch(() => undefined);
    };
    window.addEventListener(CLI_RUNTIME_VISIBILITY_EVENT, handleCliRuntimeVisibility);
    return () => window.removeEventListener(CLI_RUNTIME_VISIBILITY_EVENT, handleCliRuntimeVisibility);
  }, [auth?.isAuthenticated]);

  useEffect(() => {
    if (!pendingBrowserHandoffPaneId) return;
    const pendingPane = panes.find((pane) => pane.id === pendingBrowserHandoffPaneId && (pane.mode === "BROWSER" || pane.mode === "YOUTUBE"));
    if (!pendingPane || pendingPane.isMinimized) {
      setPendingBrowserHandoffPaneId(null);
      return;
    }
    dispatchBrowserPaneAction(pendingBrowserHandoffPaneId, "handoff");
    setPendingBrowserHandoffPaneId(null);
  }, [panes, pendingBrowserHandoffPaneId]);
  const userNavigableRooms = useMemo(() => {
    if (!isAdminMode || adminRoomFilterMode === "mine") {
      return rooms.filter((r) => auth?.user?.role === "USER" || !r.ownerUserId || r.ownerUserId === auth?.user?.id);
    }
    if (adminRoomFilterMode === "user" && adminSelectedUserId) {
      return rooms.filter((r) => r.ownerUserId === adminSelectedUserId);
    }
    return rooms;
  }, [rooms, isAdminMode, adminRoomFilterMode, adminSelectedUserId, auth?.user?.id]);
  const activeRoomIndex = useMemo(
    () => (activeRoom ? userNavigableRooms.findIndex((room) => room.id === activeRoom.id) : -1),
    [activeRoom, userNavigableRooms]
  );
  const previousRoom = activeRoomIndex > 0 ? userNavigableRooms[activeRoomIndex - 1] ?? null : null;
  const nextRoom = activeRoomIndex >= 0 && activeRoomIndex < userNavigableRooms.length - 1 ? userNavigableRooms[activeRoomIndex + 1] ?? null : null;
  useEffect(() => {
    setIsRoomRenameOpen(false);
    setRoomRenamePending(false);
    setRoomRenameError(null);
    setRoomNameDraft(activeRoom?.name ?? "");
    setIsPaneLayoutMenuOpen(false);
    setPaneLayoutError(null);
    setIsPaneSpanAllMenuOpen(false);
    setPaneSpanAllError(null);
  }, [activeRoom?.id, activeRoom?.name]);
  useEffect(() => {
    if (workspaceNavigationDetail !== "rename-room") return;
    setRoomNameDraft(activeRoom?.name ?? "");
    setRoomRenameError(null);
  }, [workspaceNavigationDetail, activeRoom?.id, activeRoom?.name]);
  const activeRoomExtraSlots = activeRoom ? (roomExtraEmptySlots[activeRoom.id] ?? 0) : 0;
  const effectiveVisiblePaneCountForAuto = useMemo(() => {
    if (visiblePanes.length < 1) return 0;
    if (activeRoomExtraSlots <= 0) return visiblePanes.length;
    return Math.min(16, visiblePanes.length + activeRoomExtraSlots);
  }, [visiblePanes.length, activeRoomExtraSlots]);

  const paneDensity = useMemo(
    () => paneDensityFor(shellMode, effectiveVisiblePaneCountForAuto),
    [shellMode, effectiveVisiblePaneCountForAuto]
  );
  const automaticPaneGridColumnCount = useMemo(
    () =>
      resolvePaneGridColumnCount({
        shellMode,
        paneDensity,
        containerWidth: paneGridWidth,
        rootRemSize,
        paneLayoutColumns: null,
        visiblePaneCount: effectiveVisiblePaneCountForAuto,
        forceTabletTwoColumns: uiTheme !== "classic"
      }),
    [paneDensity, paneGridWidth, rootRemSize, shellMode, uiTheme, effectiveVisiblePaneCountForAuto]
  );
  const paneGridColumnCount = useMemo(
    () =>
      resolvePaneGridColumnCount({
        shellMode,
        paneDensity,
        containerWidth: paneGridWidth,
        rootRemSize,
        paneLayoutColumns: activeRoom?.paneLayoutColumns ?? null,
        visiblePaneCount: effectiveVisiblePaneCountForAuto,
        forceTabletTwoColumns: uiTheme !== "classic"
      }),
    [activeRoom?.paneLayoutColumns, paneDensity, paneGridWidth, rootRemSize, shellMode, uiTheme, effectiveVisiblePaneCountForAuto]
  );
  if (previousPaneGridColumnCountRef.current !== paneGridColumnCount) {
    previousPaneGridColumnCountRef.current = paneGridColumnCount;
    paneColumnAnchorStartsRef.current = new Map();
  } else {
    const paneIds = new Set(visiblePanes.map((pane) => pane.id));
    for (const paneId of Array.from(paneColumnAnchorStartsRef.current.keys())) {
      if (!paneIds.has(paneId)) {
        paneColumnAnchorStartsRef.current.delete(paneId);
      }
    }
  }
  const paneGridPlacements = useMemo(
    () => resolvePaneGridPlacements(visiblePanes, paneGridColumnCount, paneColumnAnchorStartsRef.current),
    [paneGridColumnCount, visiblePanes]
  );
  const activeRoomEmptySlotsMetrics = useMemo(() => {
    if (!activeRoom) return null;
    const { minCount, maxCount, targetEmptySlots } = calculatePaneGridBaseRows({
      placements: paneGridPlacements,
      visiblePaneCount: visiblePanes.length,
      columnCount: paneGridColumnCount,
      targetEmptySlots: roomExtraEmptySlots[activeRoom.id]
    });
    return {
      count: targetEmptySlots,
      min: minCount,
      max: maxCount,
      disabledReason: targetEmptySlots >= maxCount
        ? (targetEmptySlots >= 6 ? "Maximum empty slots reached (6)" : "Room is at maximum capacity (16)")
        : undefined,
      onIncrement: () => {
        if (targetEmptySlots < maxCount) {
          updateRoomExtraEmptySlots(activeRoom.id, targetEmptySlots + 1, true);
        }
      },
      onDecrement: () => {
        if (targetEmptySlots > minCount) {
          const nextVal = targetEmptySlots - 1;
          updateRoomExtraEmptySlots(activeRoom.id, nextVal, true);
          if (nextVal === 0) {
            for (const [paneId, anchor] of Array.from(paneColumnAnchorStartsRef.current.entries())) {
              if (typeof anchor === "object" && anchor.rowIndex !== undefined) {
                paneColumnAnchorStartsRef.current.delete(paneId);
              }
            }
          }
        }
      }
    };
  }, [activeRoom, paneGridColumnCount, paneGridPlacements, roomExtraEmptySlots, updateRoomExtraEmptySlots, visiblePanes.length]);
  const effectiveLayoutPaneCount = useMemo(() => {
    if (visiblePanes.length < 1) return 0;
    const emptyCount = activeRoomEmptySlotsMetrics?.count ?? 0;
    return Math.min(16, visiblePanes.length + emptyCount);
  }, [visiblePanes.length, activeRoomEmptySlotsMetrics?.count]);
  const layoutAutomaticPaneGridColumnCount = useMemo(
    () =>
      resolvePaneGridColumnCount({
        shellMode,
        paneDensity: paneDensityFor(shellMode, effectiveLayoutPaneCount),
        containerWidth: paneGridWidth,
        rootRemSize,
        paneLayoutColumns: null,
        visiblePaneCount: effectiveLayoutPaneCount,
        forceTabletTwoColumns: uiTheme !== "classic"
      }),
    [effectiveLayoutPaneCount, paneGridWidth, rootRemSize, shellMode, uiTheme]
  );
  const agentNumberByPaneId = useMemo(() => new Map(panes.map((pane, index) => [pane.id, index + 1])), [panes]);
  const liveRail = useLiveRail(panes);

  useEffect(() => {
    const handlePaneControlAction = async (event: Event) => {
      const customEvent = event as CustomEvent<{
        action: "minimize" | "maximize" | "restore" | "close" | "refresh";
        paneId?: string;
        paneIds?: string[];
        mode?: string;
      }>;
      const detail = customEvent.detail;
      if (!detail?.action) return;

      const currentPanes = panesRef.current || panes;
      let targetPanes: Pane[] = [];

      if (detail.paneId) {
        const found = currentPanes.find((p) => p.id === detail.paneId);
        if (found) targetPanes = [found];
      } else if (detail.paneIds && detail.paneIds.length > 0) {
        targetPanes = currentPanes.filter((p) => detail.paneIds!.includes(p.id));
      } else if (detail.mode) {
        targetPanes = currentPanes.filter(
          (p) => p.mode !== "LIVE" && String(p.mode).toUpperCase() === detail.mode!.toUpperCase()
        );
      } else {
        const nonLive = currentPanes.filter((p) => p.mode !== "LIVE");
        const last = nonLive[nonLive.length - 1];
        if (last) targetPanes = [last];
      }

      if (detail.action === "minimize") {
        for (const p of targetPanes) {
          await minimizePane(p);
        }
      } else if (detail.action === "maximize") {
        for (const p of targetPanes) {
          if (!p.isMaximized) {
            await toggleMaximize(p);
          }
        }
      } else if (detail.action === "restore") {
        if (targetPanes.length > 0) {
          for (const p of targetPanes) {
            await restorePane(p);
          }
        } else {
          await restoreAllPanes();
        }
      } else if (detail.action === "close") {
        for (const p of targetPanes) {
          await closePane(p.id);
        }
      } else if (detail.action === "refresh") {
        if (selectedRoomId) {
          try {
            const reconciled = await api.panes(selectedRoomId);
            setPanes([...reconciled.data]);
          } catch {}
        }
      }
    };

    window.addEventListener("space-pane-control-action", handlePaneControlAction);
    return () => window.removeEventListener("space-pane-control-action", handlePaneControlAction);
  }, [panes, selectedRoomId]);
  useRailOrder(collapsedToolbarRef, Boolean(auth?.isAuthenticated && setupStatus) && appView === "workspace" && isRoomToolbarHidden && !showOverlaySideSurface && !systemAnalyticsTab);
  useLayoutEffect(() => {
    const element = collapsedToolbarRef.current;
    if (!element) return;
    const shell = element.closest<HTMLElement>(".space-shell");
    if (!shell) return;
    const measure = () => {
      const rect = element.getBoundingClientRect();
      if (rect.height > 0) {
        shell.style.setProperty("--room-toolbar-collapsed-height", `${rect.height}px`);
        shell.style.setProperty("--room-toolbar-collapsed-top", `${Math.round(rect.top)}px`);
      }
      syncRailScale(shell);
    };
    measure();
    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
    observer?.observe(element);
    window.addEventListener("resize", measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
      shell.style.removeProperty("--room-toolbar-collapsed-height");
      shell.style.removeProperty("--room-toolbar-collapsed-top");
      syncRailScale(shell);
    };
  }, [isRoomToolbarHidden, showOverlaySideSurface, isMemoryWorkspaceOpen]);
  useEffect(() => {
    if (!isRoomToolbarHidden) setLowerRailVisibilityMenu(null);
  }, [isRoomToolbarHidden]);
  // Settings also open as a Workspace menu page, which needs the same provider catalog.
  const isSettingsSurfaceVisible = (isSideSurfaceOpen && activeSideSurface === "settings")
    || workspaceNavigationDetail === "surface-settings"
    || workspaceNavigationDetail === "advanced-settings";
  const isHealthSideSurfaceVisible = isSideSurfaceOpen && activeSideSurface === "health";
  useEffect(() => {
    if (!auth?.isAuthenticated) return;
    if (isSettingsSurfaceVisible) {
      void loadSettingsSurfaceData().catch(() => undefined);
    } else if (isHealthSideSurfaceVisible) {
      // Health is a live view: reload the snapshots every time the dock opens.
      void loadHealthSurfaceData(true).catch(() => undefined);
    }
  }, [auth?.isAuthenticated, isHealthSideSurfaceVisible, isSettingsSurfaceVisible]);
  const isRoomsSurfaceVisible = Boolean(auth?.isAuthenticated)
    && appView === "workspace"
    && !isMemoryWorkspaceOpen
    && !isSpaceGatewayOpen
    && systemAnalyticsTab === null
    && activeSideSurface === "rooms"
    && isSideSurfaceOpen;

  useEffect(() => {
    if (!isRoomsSurfaceVisible || !startupReady) return;
    let disposed = false;
    let requestPending = false;

    void requestRoomCatalogRefreshRef.current().catch(() => {
      // Keep the last successful room catalog visible through temporary API failures.
    });

    async function refreshRoomCliActivity() {
      if (requestPending) return;
      requestPending = true;
      try {
        const payload = await api.roomCliActivity();
        if (disposed) return;
        setRoomPaneCounts(Object.fromEntries(
          payload.data.flatMap((activity) => activity.paneCount === undefined ? [] : [[activity.roomId, activity.paneCount]])
        ));
        setRoomCliActivityCounts(Object.fromEntries(
          payload.data.map((activity) => [activity.roomId, activity.runningCliCount])
        ));
        setRoomCliRuntimeIds(Object.fromEntries(
          payload.data.map((activity) => [
            activity.roomId,
            (activity as typeof activity & { runtimeIds?: string[] }).runtimeIds ?? []
          ])
        ));
      } catch {
        // Keep the last successful sample through temporary API failures.
      } finally {
        requestPending = false;
      }
    }

    void refreshRoomCliActivity();
    const interval = window.setInterval(() => {
      void refreshRoomCliActivity();
    }, ROOM_CLI_ACTIVITY_POLL_INTERVAL_MS);
    return () => {
      disposed = true;
      window.clearInterval(interval);
    };
  }, [isRoomsSurfaceVisible, startupReady]);

  useSideSurfaceEffects(sideSurfaces, { runtimeKind, isAuthenticated: auth?.isAuthenticated, role: auth?.user?.role, userId: auth?.user?.id, startupReady });

  async function growPaneColumnSpan(pane: Pane) {
    if (shellMode === "mobile") return;
    const placement = paneGridPlacements.get(pane.id);
    if (!placement?.canGrow) return;
    await updatePaneColumnSpan(pane, (pane.columnSpan ?? 1) + 1, placement.columnStart);
  }

  async function resetPaneColumnSpan(pane: Pane) {
    if (shellMode === "mobile" || (pane.columnSpan ?? 1) <= 1) return;
    const placement = paneGridPlacements.get(pane.id);
    await updatePaneColumnSpan(pane, 1, placement?.columnStart);
  }

  async function togglePaneColumnSpan(pane: Pane) {
    if (shellMode === "mobile" || pane.isMaximized) return;
    if ((pane.columnSpan ?? 1) > 1) {
      const placement = paneGridPlacements.get(pane.id);
      await updatePaneColumnSpan(pane, 1, placement?.columnStart);
      return;
    }
    const placement = paneGridPlacements.get(pane.id);
    if (!placement?.canGrow) return;
    await updatePaneColumnSpan(pane, 2, placement.columnStart);
  }

  function openSettingsSurface() {
    setIsCliLauncherOpen(false);
    openSideSurface("settings");
  }

  function manageLinks() {
    setIsQuickLinksOpen(false);
    openSideSurface("links");
  }

  function isYouTubeUrl(url: string): boolean {
    try {
      const host = new URL(url).hostname.replace(/^www\./, "");
      return host === "youtube.com" || host === "m.youtube.com" || host === "youtu.be";
    } catch {
      return false;
    }
  }

  function openUserLink(link: UserLink) {
    setIsQuickLinksOpen(false);
    // YouTube links: route to the YouTube pane (existing or new)
    if (isYouTubeUrl(link.url)) {
      const existingYouTubePane = panesRef.current.find(
        (pane) => pane.mode === "YOUTUBE" && !pane.isMinimized && !pane.isClosed,
      );
      if (existingYouTubePane) {
        window.dispatchEvent(
          new CustomEvent("space-play-youtube-url", {
            detail: { paneId: existingYouTubePane.id, url: link.url, title: link.title },
          }),
        );
        setSelectedPaneId(existingYouTubePane.id);
      } else {
        void addPane("YOUTUBE", link.url);
      }
      return;
    }
    if (link.openMode === "NEW_TAB") {
      const opened = runtime.platform.openLink(link.url, "_blank", "noopener,noreferrer");
      if (opened) opened.opener = null;
      return;
    }
    setActiveUserLink(link);
  }

  async function refreshToolbarSystemState() {
    const [environmentResult, providerSettingsResult, runtimeSettingsResult] = await Promise.allSettled([
      api.codexEnvironment(),
      api.providerSettings(),
      api.cliRuntimeSettings()
    ]);
    if (environmentResult.status === "fulfilled") setCodexEnvironmentSummary(environmentResult.value);
    if (providerSettingsResult.status === "fulfilled") setProviderSettings(providerSettingsResult.value);
    if (runtimeSettingsResult.status === "fulfilled") setCliRuntimeSettings(runtimeSettingsResult.value);
  }

  async function applyPaneLayoutPreset(
    paneLayoutColumns?: Room["paneLayoutColumns"],
    paneLayoutHeight?: Room["paneLayoutHeight"],
    keepMenuOpen = false
  ) {
    if (!activeRoom) return;
    const sequence = ++paneLayoutSequenceRef.current;
    const previousRoom = activeRoom;
    const isPresetSelection = paneLayoutColumns !== undefined;
    const nextColumns = isPresetSelection ? paneLayoutColumns : activeRoom.paneLayoutColumns;
    const nextHeight = isPresetSelection ? 1 : (paneLayoutHeight !== undefined ? paneLayoutHeight : (activeRoom.paneLayoutHeight ?? 1));
    emitAppDiagnosticsPerformance({
      category: "PERFORMANCE",
      metric: "PANE_LAYOUT",
      phase: "LAYOUT_PRESET",
      roomId: activeRoom.id,
      value: nextColumns ?? -1
    });
    // Optimistic: apply the layout locally in 0ms so panes resize instantly
    setRooms((current) =>
      sortRoomsByOrder(
        current.map((room) =>
          room.id === activeRoom.id
            ? { ...room, paneLayoutColumns: nextColumns, paneLayoutHeight: nextHeight }
            : room
        )
      )
    );
    if (isPresetSelection) {
      setPanes((current) =>
        current.map((pane) =>
          pane.roomId === activeRoom.id && (pane.columnSpan !== 1 || pane.isMaximized)
            ? { ...pane, columnSpan: 1, isMaximized: false }
            : pane
        )
      );
    }
    if (!keepMenuOpen) {
      closePaneLayoutMenu();
      setIsCollapsedPaneLayoutMenuOpen(false);
    }
    setPaneLayoutError(null);
    try {
      const payload: { paneLayoutColumns?: Room["paneLayoutColumns"]; paneLayoutHeight?: Room["paneLayoutHeight"] } = {};
      if (paneLayoutColumns !== undefined) {
        payload.paneLayoutColumns = paneLayoutColumns;
        payload.paneLayoutHeight = 1;
      } else if (paneLayoutHeight !== undefined) {
        payload.paneLayoutHeight = paneLayoutHeight;
      }
      const result = await api.updateRoomPaneLayout(activeRoom.id, payload);
      if (sequence !== paneLayoutSequenceRef.current) return;
      paneColumnAnchorStartsRef.current = new Map();
      setRooms((current) =>
        sortRoomsByOrder(current.map((room) => (room.id === result.room.id ? result.room : room)))
      );
      setPanes([...result.panes]);
      setSelectedPaneId((current) =>
        result.panes.some((pane) => pane.id === current)
          ? current
          : result.panes.find((pane) => !pane.isMinimized)?.id ?? null
      );
      setPaneLayoutPending(false);
      emitAppDiagnosticsPerformance({
        category: "PERFORMANCE",
        metric: "PANE_LAYOUT",
        phase: "LAYOUT_APPLIED",
        roomId: activeRoom.id,
        value: nextColumns ?? -1
      });
      void refreshRoomEvents(activeRoom.id).catch(() => {});
    } catch (layoutError) {
      if (sequence !== paneLayoutSequenceRef.current) return;
      setRooms((current) =>
        sortRoomsByOrder(current.map((room) => (room.id === previousRoom.id ? previousRoom : room)))
      );
      setPaneLayoutError(layoutError instanceof Error ? layoutError.message : "Pane layout update failed");
      setPaneLayoutPending(false);
    }
  }

  async function applyPaneSpanToAll(columnSpan: number) {
    if (!activeRoom) return;
    const sequence = ++paneSpanSequenceRef.current;
    const targets = visiblePanes.filter((pane) => !activeRoom || pane.roomId === activeRoom.id || !pane.roomId);
    const resolvedTargets = targets.length > 0 ? targets : visiblePanes;
    if (resolvedTargets.length === 0) return;
    const nextColumnSpan = Math.max(1, Math.min(MAX_PANE_COLUMN_SPAN, columnSpan));
    const previousPanes = panes;
    paneColumnAnchorStartsRef.current = new Map();
    // Optimistic: update all pane widths locally in 0ms
    setPanes((current) =>
      current.map((pane) =>
        resolvedTargets.some((target) => target.id === pane.id)
          ? { ...pane, columnSpan: nextColumnSpan }
          : pane
      )
    );
    setPaneSpanAllError(null);
    try {
      const results = await Promise.allSettled(
        resolvedTargets.map((pane) => {
          if ((pane.columnSpan ?? 1) === nextColumnSpan) return Promise.resolve(pane);
          return api.updatePane(pane.id, { columnSpan: nextColumnSpan });
        })
      );
      if (sequence !== paneSpanSequenceRef.current) return;
      const updatedPanes: Pane[] = [];
      let failed = 0;
      results.forEach((result, index) => {
        const pane = resolvedTargets[index]!;
        if (result.status === "fulfilled") {
          updatedPanes.push(result.value);
        } else {
          failed += 1;
          updatedPanes.push(pane);
        }
      });
      setPanes((current) => current.map((item) => updatedPanes.find((pane) => pane.id === item.id) ?? item));
      if (failed > 0) {
        setPaneSpanAllError(`${failed} pane${failed === 1 ? "" : "s"} could not be updated.`);
      } else {
        closePaneSpanAllMenu();
      }
      void refreshRoomEvents(activeRoom.id).catch(() => {});
    } catch (spanError) {
      if (sequence !== paneSpanSequenceRef.current) return;
      setPanes(previousPanes);
      setPaneSpanAllError(spanError instanceof Error ? spanError.message : "Pane width update failed");
    } finally {
      if (sequence === paneSpanSequenceRef.current) {
        setPaneSpanAllPending(false);
      }
    }
  }

  function commonPaneColumnSpan(panes: Pane[]): number | null {
    const first = panes[0]?.columnSpan ?? 1;
    return panes.every((pane) => (pane.columnSpan ?? 1) === first) ? first : null;
  }

  // Room Agent attention keeps the toolbar count; its desktop alerts arrive as Space notifications now.
  const roomAgentAttention = useRoomAgentAttention(Boolean(auth?.user) && startupReady);
  // Space notifications: a click opens the room, the pane and the surface the notification points at; panes get the target.
  const notificationStore = useNotificationStore();
  const navigateToNotification = useCallback<NotificationNavigator>((link) => {
    void (async () => {
      if (link.roomId) {
        activateRoom(link.roomId);
        await loadRoomRuntimeRef.current(link.roomId).catch(() => undefined);
      }
      if (link.paneId) setSelectedPaneId(link.paneId);
      if (link.surface) sideSurfaces.openSideSurface(link.surface as SideSurface);
      if (link.paneId && link.target) window.dispatchEvent(new CustomEvent("space:notification-open", { detail: { paneId: link.paneId, target: link.target } }));
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activateRoom, sideSurfaces.openSideSurface]);
  useNotificationBootstrap(startupReady ? auth?.user?.id ?? null : null, navigateToNotification);
  const nousFocus = useNousFocus({ userId: auth?.user?.id ?? null, rooms, panes, selectedRoomId, selectedPaneId, selectRoom, selectPane: setSelectedPaneId, toggleMaximize, restorePane, sideSurfaces });
  const roomToolbarActions = useMemo<IconToolbarAction[]>(
    () => {
      return buildRoomToolbarActions({
        role: auth?.user?.role,
        hasUser: Boolean(auth?.user),
        shellMode,
        docks: { ...sideSurfaces, hiddenDockIds, roomAgentAttention: roomAgentAttention.total, notificationAttention: notificationStore.pending.total },
        visibility: { isWidgetHidden, isPaneHidden },
        popovers: toolbarPopovers,
        preferences: userPreferences,
        room: {
          activeRoom, selectedRoomId, panes, paneLayoutPending, setPaneLayoutError, activeRoomCategoryFilter,
          activeRoomCategoryColors, cycleRoomCategoryColor
        },
        create: {
          isCodexEnabled, cliPaneCreationPending, toggleChatLauncher, toggleCliLauncher, addRootAdminPane, addPane, addFilesPane,
          addDatabasesPane, addDemosPane, addT3CodePane, addJobApplyPane, addMailCopilotPane, addMarketingCopilotPane: () => addCopilotPane(MARKETING_COPILOT_KIND), addFreelanceCopilotPane: () => addCopilotPane(FREELANCE_COPILOT_KIND), addDesignPane: () => addCopilotPane(DESIGN_KIND), addLivePane
        },
        tools: { desktopWidgets, openStickyNote, isBrowserFullscreen, snip: snipTool, captureRoomScreen, reloadRoomWindow, vpn: toolbarVpn },
        workspace: {
          isMemoryWorkspaceOpen, setIsMemoryWorkspaceOpen, isSpaceGatewayOpen, setIsSpaceGatewayOpen, setSystemAnalyticsTab, agentsDashboardSummary, setIsAgentsDashboardOpen,
          resourceIndicatorsVisible, toggleResourceIndicators, isDebugModeActive, debugModePending, toggleDebugMode, isDemoModeActive,
          setIsDemoModeActive, setAdminModeRequested, openHelp, openBenchmark, signOut, isServerActionsMenuOpen, setIsServerActionsMenuOpen,
          gatewayCompression: { mode: gatewayCompression.mode, pending: gatewayCompression.pending, request: gatewayCompression.request }
        }
      });
    },
    [
      activeRoom,
      isQuickLinksOpen,
      activeRoomCategoryColors,
      activeRoomCategoryFilter,
      auth?.user?.role,
      sourceControlAvailable,
      captureRoomScreen,
      cliPaneCreationPending,
      cliFloatsHidden, resourceIndicatorsVisible, toggleResourceIndicators,
      cycleRoomCategoryColor,
      isCompactShell,
      isCodexEnabled,
      isMemoryWorkspaceOpen,
      isSpaceGatewayOpen,
      isCliLauncherOpen,
      isOskKeyboardOpen,
      isPaneLayoutMenuOpen,
      isPaneSpanAllMenuOpen,
      isSideSurfaceOpen,
      isCompactSideSurfaceOpen,
      isServerActionsMenuOpen,
      isRoomFocusMode,
      isBrowserFullscreen,
      isThemeMenuOpen,
      isVibeMusicOpen,
      isSnipToolOpen,
      isWorkspaceTextSizePickerOpen,
      panes,
      paneLayoutPending,
      reloadRoomWindow,
      rotateVpnCityFromToolbar,
      runtime,
      selectedRoomId,
      shellMode,
      terminalFontSize,
      toolbarVpnRoute,
      vpnCityPending,
      desktopWidgets,
      isDebugModeActive,
      debugModePending,
      toggleDebugMode,
      gatewayCompression.mode,
      gatewayCompression.pending,
      gatewayCompression.request,
      hiddenDockIds,
      hiddenPaneIds,
      hiddenWidgetIds,
      roomAgentAttention.total,
      notificationStore.pending.total
    ]
  );
  const serverActionCommands = manage.buildCommands({
    isCodexEnabled,
    anyCliEnabled,
    reclaimMemory: (anchor) => toolbarMetricsRef.current?.openMemoryReclaim(anchor),
    openSystemAnalytics: () => {
      setIsMemoryWorkspaceOpen(false);
      setIsSpaceGatewayOpen(false);
      setSystemAnalyticsTab("overview");
    }
  });
  const roomToolbar = usePersistentIconToolbar({
    actions: roomToolbarActions,
    hiddenStorageKey: roomToolbarStorageKeys.hidden,
    orderStorageKey: roomToolbarStorageKeys.order
  });
  const roomToolbarRenderedActions = (shellMode === "mobile"
    ? roomToolbar.visibleActions.filter((action) => action.id !== "pane-layout" && action.id !== "pane-span-all")
    : roomToolbar.visibleActions).filter(roomActionFilter(presentationRoom));
  const availableRoomActions = (shellMode === "mobile"
    ? roomToolbar.orderedActions.filter((action) => action.id !== "pane-layout" && action.id !== "pane-span-all" && action.id !== "sticky-note" && !action.id.startsWith("widget-"))
    : roomToolbar.orderedActions).filter(roomActionFilter(presentationRoom));
  const roomToolbarTouchContext = useTouchContextMenu(
    (source) => source instanceof Element && !source.closest(".desktop-menu-drag-handle, .cli-launcher-drag-handle")
      ? source.closest<HTMLElement>("button[data-action-id]")
      : null,
    ({ target, x, y }) => {
      const action = availableRoomActions.find((item) => item.id === target.dataset.actionId);
      if (!action || action.id === "more-actions") return;
      roomToolbar.closeMenus();
      roomToolbar.setActionMenu({ actionId: action.id, actionLabel: action.ariaLabel, x, y });
    }
  );
  const desktopToolbarActions: IconToolbarAction[] = availableRoomActions.map(action => action.id === "add-chat" ? {
    ...action,
    onClick: () => void addPane("CHAT"),
    ariaExpanded: undefined,
    ariaControls: undefined,
    ariaHasPopup: undefined
  } : action).concat(
    roomToolbar.orderedActions.some(a => a.id === "resources") ? [] : [{
      id: "resources", label: "Resources", title: "Resources", ariaLabel: "Resources", icon: Activity,
      onClick: () => openSystemResources()
    }], {
    id: "rename-room", label: "Rename room", title: "Rename room", ariaLabel: "Rename room", icon: Pencil,
    disabled: !activeRoom, disabledReason: "Choose a room first", onClick: beginRoomRename
  }, {
    id: "previous-room", label: "Previous room", title: previousRoom?.name ?? "Previous room", ariaLabel: "Previous room", icon: ChevronLeft,
    disabled: !previousRoom, disabledReason: "This is the first room", onClick: () => { if (previousRoom) void selectRoom(previousRoom.id); }
  }, {
    id: "next-room", label: "Next room", title: nextRoom?.name ?? "Next room", ariaLabel: "Next room", icon: ChevronRight,
    disabled: !nextRoom, disabledReason: "This is the last room", onClick: () => { if (nextRoom) void selectRoom(nextRoom.id); }
  }, ...(isHarnessEnabled && !isPaneHidden("harness") ? [{
    id: "add-harness", label: "DeepSeek Harness", title: "Open DeepSeek Harness",
    ariaLabel: "Open DeepSeek Harness", icon: Network,
    onClick: () => void addHarnessPane(), disabled: !selectedRoomId || panes.length >= 16
  }] as IconToolbarAction[] : []), {
    id: "live-model",
    label: "Live voice model",
    title:
      liveRail.liveRailStatus === "listening"
        ? "User speaking..."
        : liveRail.liveRailStatus === "speaking"
        ? "Agent speaking..."
        : liveRail.liveRailStatus === "active"
        ? "Live voice active (Listening)"
        : liveRail.liveRailStatus === "connecting"
        ? "Connecting Live voice model..."
        : "Start Live voice conversation",
    ariaLabel: "Live voice model",
    icon: Mic,
    onClick: activateLiveFromRail,
    ariaPressed: liveRail.liveRailStatus !== "idle" && liveRail.liveRailStatus !== "error",
    disabled: !selectedRoomId
  }, {
    id: "create",
    label: "Create",
    title: "Create pane",
    ariaLabel: "Create",
    icon: Plus,
    onClick: () => {
      setIsChatLauncherOpen(true);
    },
    disabled: !selectedRoomId || panes.length >= 16
  }, {
    id: "docks",
    label: "Docks",
    title: "Docks",
    ariaLabel: "Docks",
    icon: Grid2X2,
    onClick: () => {
      toggleSideSurface("tasks");
    }
  }, ...(showMinimizedBarToggle && auth?.user?.role !== "ADMIN" ? [{
    id: "minimized-bar",
    label: "Minimized panes",
    title: showMinimizedBar ? "Hide minimized pane bar" : "Show minimized pane bar",
    ariaLabel: "Minimized panes",
    icon: Minus,
    onClick: () => setMinimizedBarExpanded((value) => !value),
    ariaPressed: showMinimizedBar
  }] as IconToolbarAction[] : []), ...(auth?.user?.role === "ADMIN" ? [{
    id: "toggle-admin-mode",
    label: isAdminMode ? "Switch to User mode" : "Switch to Admin mode",
    title: isAdminMode ? "Switch to User mode" : "Switch to Admin mode",
    ariaLabel: isAdminMode ? "Switch to User mode" : "Switch to Admin mode",
    icon: isAdminMode ? ShieldCheck : UserCheck,
    onClick: () => {
      setAdminModeRequested(!isAdminMode);
      setIsServerActionsMenuOpen(false);
      if (isAdminMode && ["health", "streaming"].includes(activeSideSurface)) setIsDesktopSideSurfaceOpen(false);
    }
  }] as IconToolbarAction[] : [])).filter(roomActionFilter(presentationRoom));
  const workspaceNavigationActions: IconToolbarAction[] = [...desktopToolbarActions, {
    id: "workspace-room", label: "Room", title: "Room settings", ariaLabel: "Room", icon: PanelTopOpen,
    onClick: () => undefined
  }, {
    id: "desktop-displays", label: "Displays", title: "Multi-Screen Displays", ariaLabel: "Displays", icon: Monitor,
    onClick: () => window.dispatchEvent(new Event("space:desktop:open-displays"))
  }];
  const workspaceDetailActionIds = [
    ...Object.keys(sideSurfaceMeta).map(surface => `surface-${surface}`),
    "pane-layout", "pane-span-all", "font-down", "theme", "resources", "system-resources", "system-analytics",
    "server-restart", "advanced-settings", "setup-connections", "system-services", "help",
    "benchmark", "token-usage", "add-chat", "add-cli", "create", "desktop-displays", "sticky-note", "quick-links",
    "vibe-music", "clip-tool", "snip-tool", "agents-dashboard", "demo-mode", "rename-room", "workspace-room"
  ];
  useEffect(() => {
    const dismiss = () => {
      roomToolbar.closeMenus();
      setIsThemeMenuOpen(false);
      setIsPaneLayoutMenuOpen(false);
      setIsCollapsedPaneLayoutMenuOpen(false);
      setIsPaneSpanAllMenuOpen(false);
      setIsWorkspaceTextSizePickerOpen(false);
      setIsServerActionsMenuOpen(false);
      setIsCliLauncherOpen(false);
      setIsQuickLinksOpen(false);
      setIsVibeMusicOpen(false);
    };
    window.addEventListener("space:navigation-open", dismiss);
    return () => window.removeEventListener("space:navigation-open", dismiss);
  }, [roomToolbar.closeMenus]);
  function runDesktopAction(action: IconToolbarAction, anchor: HTMLButtonElement, count = 1) {
    // Submenus stay anchored to the persistent navigation trigger after the menu closes.
    const refs = {
      "server-restart": serverActionsButtonRef, "add-cli": cliLauncherButtonRef,
      "add-chat": chatLauncherButtonRef, "font-down": workspaceTextSizeButtonRef,
      theme: roomThemeButtonRef, "pane-layout": paneLayoutButtonRef,
      "pane-span-all": paneSpanAllButtonRef, "vibe-music": vibeMusicButtonRef
    };
    const targetRef = refs[action.id as keyof typeof refs];
    if (targetRef) targetRef.current = anchor;
    if (action.id === "pane-layout" && isRoomToolbarHidden) paneLayoutCollapsedButtonRef.current = anchor;
    roomToolbar.closeMenus();
    if (action.id !== "theme") setIsThemeMenuOpen(false);
    if (action.id !== "pane-layout") setIsPaneLayoutMenuOpen(false);
    if (action.id !== "pane-span-all") setIsPaneSpanAllMenuOpen(false);
    if (action.id !== "font-down") setIsWorkspaceTextSizePickerOpen(false);
    if (action.id !== "server-restart") setIsServerActionsMenuOpen(false);
    if (action.id !== "add-cli") setIsCliLauncherOpen(false);
    if (action.id !== "add-chat") setIsChatLauncherOpen(false);
    if (action.id === "system-resources") openSystemResources();
    else if (action.id === "resources") openSystemResources();
    else if (action.id === "server-restart") {
      serverActionsButtonRef.current = anchor;
      openManage();
    } else if (count > 1) {
      if (action.id === "add-browser") void addPane("BROWSER", undefined, count);
      else if (action.id === "add-chat") void addPane("CHAT", undefined, count);
      else if (action.id === "add-youtube") void addPane("YOUTUBE", undefined, count);
      else if (action.id === "add-vnc") void addPane("VNC", undefined, count);
      else if (action.id === "add-live") void addLivePane(count);
      else if (action.id === "add-files") void addFilesPane(count);
      else if (action.id === "add-databases") void addDatabasesPane(count);
      else if (action.id === "add-demos") void addDemosPane(count);
      else if (action.id === "add-t3code") void addT3CodePane(count);
      else if (action.id === "add-jobs") void addJobApplyPane(count);
      else if (action.id === "add-mail") void addMailCopilotPane(count);
      else if (action.id === "add-marketing" || action.id === "add-freelance" || action.id === "add-design") void addCopilotPane(action.id === "add-marketing" ? MARKETING_COPILOT_KIND : action.id === "add-design" ? DESIGN_KIND : FREELANCE_COPILOT_KIND, count);
      else if (action.id === "add-harness") void addHarnessPane(count);
      else action.onClick();
    }
    else action.onClick();
  }
  function renderDesktopCreateTools({
    query,
    onClose,
    triggerRef,
    paneCount,
    onPaneCountChange,
    onNavigate,
    availablePanes: passedAvailablePanes
  }: {
    query: string;
    onClose: () => void;
    triggerRef: RefObject<HTMLButtonElement | null>;
    paneCount?: number;
    onPaneCountChange?: (count: number | ((prev: number) => number)) => void;
    onNavigate?: (id: string) => void;
    availablePanes?: number;
  }) {
    const availablePanes = passedAvailablePanes ?? Math.max(0, 16 - panes.length);
    return (
      <RecoverableSurface fallback={toolbarMenuLoadingFallback}>
        <LazyCliLauncherMenu
          embedded
          query={query}
          mobile={false}
          refreshOnOpen={true}
          atPaneCap={panes.length >= 16 || availablePanes <= 0}
          availablePanes={availablePanes}
          isCodexEnabled={isCodexEnabled}
          onClose={onClose}
          onCreate={addCliRuntimePane}
          onLogin={openCliRuntimeLogin}
          onOpenSettings={() => { if (onNavigate) onNavigate("surface-settings"); else { onClose(); openSettingsSurface(); } }}
          triggerRef={triggerRef}
          paneCount={paneCount}
          onPaneCountChange={onPaneCountChange}
        />
      </RecoverableSurface>
    );
  }
  const renderRoomToolbarAction = (action: IconToolbarAction) => {
    const Icon = action.icon;
    return (
      <button
        key={action.id}
        ref={
          action.id === "server-restart"
            ? serverActionsButtonRef
            : action.id === "add-cli"
              ? cliLauncherButtonRef
              : action.id === "add-chat"
                ? chatLauncherButtonRef
                : action.id === "font-down"
                  ? workspaceTextSizeButtonRef
                : action.id === "theme"
                  ? roomThemeButtonRef
                : action.id === "pane-layout"
                  ? paneLayoutButtonRef
                : action.id === "pane-span-all"
                  ? paneSpanAllButtonRef
                : action.id === "vibe-music"
                  ? vibeMusicButtonRef
                  : action.id === "more-actions"
                    ? roomOverflowTriggerRef
                    : undefined
        }
        type="button"
        className={action.id === "category-color-filter"
          ? `category-color-filter${activeRoomCategoryFilter ? " is-active" : ""}`
          : action.className}
        onClick={() => {
          roomToolbar.closeMenus();
          if (action.id !== "theme") setIsThemeMenuOpen(false);
          if (action.id !== "pane-layout") setIsPaneLayoutMenuOpen(false);
          if (action.id !== "pane-span-all") setIsPaneSpanAllMenuOpen(false);
          if (action.id !== "font-down") setIsWorkspaceTextSizePickerOpen(false);
          if (action.id !== "server-restart") setIsServerActionsMenuOpen(false);
          if (action.id !== "add-cli") setIsCliLauncherOpen(false);
          if (action.id !== "add-chat") setIsChatLauncherOpen(false);
          if (action.id === "more-actions") {
            roomToolbar.setIsOverflowOpen((current) => !current);
            return;
          }
          action.onClick();
        }}
        disabled={action.disabled}
        title={action.title}
        aria-label={action.ariaLabel}
        aria-controls={action.ariaControls}
        aria-expanded={action.id === "more-actions" ? roomToolbar.isOverflowOpen : action.ariaExpanded}
        aria-haspopup={action.ariaHasPopup}
        aria-pressed={action.ariaPressed}
        onWheel={action.onWheel}
        data-action-id={action.id}
        data-category-color={action.id === "category-color-filter" ? (activeRoomCategoryFilter ?? undefined) : undefined}
        {...(action.dataSensitiveIgnore ? { "data-sensitive-ignore": "true" } : {})}
        onContextMenu={(event) => {
          event.preventDefault();
          roomToolbar.closeMenus();
          setIsThemeMenuOpen(false);
          setIsPaneLayoutMenuOpen(false);
          setIsPaneSpanAllMenuOpen(false);
          setIsWorkspaceTextSizePickerOpen(false);
          setIsServerActionsMenuOpen(false);
          setIsCliLauncherOpen(false);
          setIsChatLauncherOpen(false);
          roomToolbar.setActionMenu({
            actionId: action.id,
            actionLabel: action.ariaLabel,
            x: event.clientX,
            y: event.clientY
          });
        }}
        {...roomToolbar.getDragHandleProps(action)}
      >
        <Icon aria-hidden="true" />
        {action.id === "category-color-filter" ? (
          <span className="category-filter-dots" aria-hidden="true">
            {activeRoomCategoryColors.map((color) => (
              <i
                key={color}
                className={`category-swatch-dot ${color}${activeRoomCategoryFilter === color ? " active" : ""}`}
              />
            ))}
          </span>
        ) : null}
      </button>
    );
  };
  function updateRoomToolbarVisibility(hidden: boolean) {
    if (hidden) {
      roomToolbar.closeMenus();
      setIsQuickLinksOpen(false);
      setIsThemeMenuOpen(false);
      setIsPaneLayoutMenuOpen(false);
      setIsPaneSpanAllMenuOpen(false);
      setIsWorkspaceTextSizePickerOpen(false);
      setIsServerActionsMenuOpen(false);
      setIsCliLauncherOpen(false);
    }
    userPreferences.setRoomToolbarHidden(hidden);
  }
  useLayoutEffect(() => {
    const toolbar = boardToolbarRef.current;
    if (!toolbar || shellMode === "mobile" || !shouldMeasureToolbarLayout(uiTheme)) {
      setIsRoomToolbarStacked(false);
      return;
    }

    const measureChildrenWidth = (element: HTMLElement | null, fallbackWidthRem: number, fallbackGapRem: number) => {
      if (!element) return 0;
      const children = Array.from(element.children).filter((child): child is HTMLElement => child instanceof HTMLElement);
      if (!children.length) return 0;
      const styles = window.getComputedStyle(element);
      const parsedGap = Number.parseFloat(styles.columnGap || styles.gap || "");
      const gap = Number.isFinite(parsedGap) ? parsedGap : remToPx(fallbackGapRem);
      const childrenWidth = children.reduce(
        (total, child) => total + (child.getBoundingClientRect().width || child.offsetWidth || remToPx(fallbackWidthRem)),
        0
      );
      return childrenWidth + Math.max(0, children.length - 1) * gap;
    };

    const measureToolbar = () => {
      const availableWidth = toolbar.clientWidth;
      if (availableWidth <= 0) return;
      const titleRow = toolbar.querySelector<HTMLElement>(".board-title-row");
      const titleElement = titleRow?.querySelector<HTMLElement>("h2") ?? null;
      const titleForm = titleRow?.querySelector<HTMLElement>(".room-title-form") ?? null;
      const titleControls = titleRow?.querySelector<HTMLElement>(".board-title-controls") ?? null;
      const titleStyles = titleRow ? window.getComputedStyle(titleRow) : null;
      const parsedTitleGap = Number.parseFloat(titleStyles?.columnGap || titleStyles?.gap || "");
      const titleGap = Number.isFinite(parsedTitleGap) ? parsedTitleGap : remToPx(0.5);
      const headingWidth = titleForm
        ? titleForm.scrollWidth || remToPx(16)
        : measureSingleLineTitleWidth(titleElement, 8);
      const titleControlsWidth = measureChildrenWidth(titleControls, 2.25, 0.25);
      const titleWidth = Math.max(remToPx(10), headingWidth + (titleControlsWidth ? titleGap + titleControlsWidth : 0));
      const lbWidth = measureChildrenWidth(toolbar.querySelector<HTMLElement>(".toolbar-lb-strip"), 2.25, 0.35);
      const actionsWidth = measureChildrenWidth(roomToolbarScrollRef.current, 2.25, 0.25);
      const toolbarStyles = window.getComputedStyle(toolbar);
      const parsedToolbarGap = Number.parseFloat(toolbarStyles.columnGap || toolbarStyles.gap || "");
      const columnGap = Number.isFinite(parsedToolbarGap) ? parsedToolbarGap : remToPx(0.75);
      setIsRoomToolbarStacked(
        roomToolbarNeedsSecondRow({ availableWidth, titleWidth, lbWidth, actionsWidth, columnGap })
      );
    };

    measureToolbar();
    const resizeObserver = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measureToolbar) : null;
    resizeObserver?.observe(toolbar);
    const titleRow = toolbar.querySelector<HTMLElement>(".board-title-row");
    const lbStrip = toolbar.querySelector<HTMLElement>(".toolbar-lb-strip");
    if (titleRow) resizeObserver?.observe(titleRow);
    if (lbStrip) resizeObserver?.observe(lbStrip);
    if (roomToolbarScrollRef.current) resizeObserver?.observe(roomToolbarScrollRef.current);
    window.addEventListener("resize", measureToolbar);
    return () => {
      resizeObserver?.disconnect();
      window.removeEventListener("resize", measureToolbar);
    };
  }, [activeRoom?.name, isRoomRenameOpen, isRoomToolbarHidden, roomToolbarRenderedActions.length, shellMode, uiTheme]);
  useDismissibleToolbarLayer({
    containerRef: boardToolbarRef,
    active: !isRoomToolbarHidden && (isThemeMenuOpen || isPaneLayoutMenuOpen || isPaneSpanAllMenuOpen || roomToolbar.isOverflowOpen || Boolean(roomToolbar.actionMenu)),
    onDismiss: () => {
      setIsThemeMenuOpen(false);
      closePaneLayoutMenu(isPaneLayoutMenuOpen);
      closePaneSpanAllMenu(isPaneSpanAllMenuOpen);
      setIsWorkspaceTextSizePickerOpen(false);
      roomToolbar.closeMenus();
    }
  });
  useDismissibleToolbarLayer({
    containerRef: collapsedToolbarRef,
    active: isRoomToolbarHidden && (isCollapsedPaneLayoutMenuOpen || isPaneSpanAllMenuOpen || Boolean(lowerRailVisibilityMenu)),
    onDismiss: () => {
      setIsCollapsedPaneLayoutMenuOpen(false);
      setIsPaneSpanAllMenuOpen(false);
      setLowerRailVisibilityMenu(null);
      window.requestAnimationFrame(() => (paneSpanAllButtonRef.current ?? paneLayoutCollapsedButtonRef.current)?.focus());
    }
  });
  useDismissibleToolbarLayer({
    containerRef: vpnCityNoticeRef,
    active: Boolean(vpnCityNotice),
    onDismiss: () => setVpnCityNotice(null)
  });
  const dockBrowserPane = useMemo(
    () => (activePane?.mode === "BROWSER" || activePane?.mode === "YOUTUBE" ? activePane : visiblePanes.find((pane) => pane.mode === "BROWSER" || pane.mode === "YOUTUBE") ?? null),
    [activePane, visiblePanes]
  );

  function runBrowserPaneAction(action: BrowserPaneAction) {
    if (!dockBrowserPane) return;
    setSelectedPaneId(dockBrowserPane.id);
    window.requestAnimationFrame(() => dispatchBrowserPaneAction(dockBrowserPane.id, action));
  }

  useEffect(() => {
    if (!selectedRoomId && isRoomFocusMode) setIsRoomFocusMode(false);
  }, [isRoomFocusMode, selectedRoomId]);
  useEffect(() => {
    if (!auth?.isAuthenticated || !startupReady) {
      setCodexEnvironmentSummary(null);
      return;
    }
    let disposed = false;
    let requestPending = false;
    const loadCodexEnvironmentSummary = async () => {
      if (requestPending || document.visibilityState === "hidden") return;
      requestPending = true;
      try {
        const [environment, runtimeSettings] = await Promise.allSettled([
          api.codexEnvironment(),
          api.cliRuntimeSettings()
        ]);
        if (disposed) return;
        if (environment.status === "fulfilled") setCodexEnvironmentSummary(environment.value);
        if (runtimeSettings.status === "fulfilled") setCliRuntimeSettings(runtimeSettings.value);
      } catch {
        // Keep room-level stats best-effort so the main shell still renders if this endpoint is unavailable.
      } finally {
        requestPending = false;
      }
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") void loadCodexEnvironmentSummary();
    };
    const handleAppResumed = () => {
      void loadCodexEnvironmentSummary();
    };
    const startupTimer = scheduleStartupBackground(() => void loadCodexEnvironmentSummary());
    const interval = window.setInterval(() => void loadCodexEnvironmentSummary(), 30000);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("space:app-resumed", handleAppResumed);
    return () => {
      disposed = true;
      window.clearTimeout(startupTimer);
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("space:app-resumed", handleAppResumed);
    };
  }, [auth?.isAuthenticated, startupReady]);
  useEffect(() => {
    if (previousShellModeRef.current === null) {
      previousShellModeRef.current = shellMode;
      return;
    }
    if (previousShellModeRef.current === shellMode) return;
    recordLifecycleDebugEvent({
      type: "shell_mode_changed",
      scope: "App",
      detail: `from=${previousShellModeRef.current} to=${shellMode} width=${readViewportWidth()}`,
      shellMode
    });
    previousShellModeRef.current = shellMode;
  }, [shellMode]);

  useEffect(() => {
    if (previousSelectedRoomIdRef.current === null) {
      previousSelectedRoomIdRef.current = selectedRoomId;
      return;
    }
    if (previousSelectedRoomIdRef.current === selectedRoomId) return;
    recordLifecycleDebugEvent({
      type: "room_selection_changed",
      scope: "App",
      detail: `from=${previousSelectedRoomIdRef.current ?? "none"} to=${selectedRoomId ?? "none"}`,
      shellMode,
      paneId: selectedPaneId
    });
    previousSelectedRoomIdRef.current = selectedRoomId;
  }, [selectedPaneId, selectedRoomId, shellMode]);

  useEffect(() => {
    if (previousSelectedPaneIdRef.current === null) {
      previousSelectedPaneIdRef.current = selectedPaneId;
      return;
    }
    if (previousSelectedPaneIdRef.current === selectedPaneId) return;
    recordLifecycleDebugEvent({
      type: "pane_selection_changed",
      scope: "App",
      detail: `from=${previousSelectedPaneIdRef.current ?? "none"} to=${selectedPaneId ?? "none"}`,
      shellMode,
      paneId: selectedPaneId
    });
    previousSelectedPaneIdRef.current = selectedPaneId;
  }, [selectedPaneId, shellMode]);
  const codexTurnsEnabled = readiness?.dependencies.codexTurns === "enabled";
  const latestArtifactEventId = useMemo(
    () => roomEvents.find((event) => event.type === "ARTIFACT_CREATED")?.id ?? null,
    [roomEvents]
  );
  const targetPaneFromUser = useCallback(
    (paneId: string) => {
      if (!panes.some((pane) => pane.id === paneId && !pane.isMinimized)) return;
      setSelectedPaneId(paneId);
      commitPaneCompletionLifecycle(
        acknowledgePaneCompletion(paneCompletionLifecycleRef.current, paneId)
      );
    },
    [panes]
  );
  const paneCardOnTarget = useStableCallback(targetPaneFromUser);
  const paneCardOnMove = useStableCallback(openMovePaneDialog);
  const paneCardOnPaneUpdated = useStableCallback(handlePaneUpdated);
  const paneCardOnOpenExisting = useStableCallback(async (pane: Pane) => {
    await selectRoom(pane.roomId);
    if (pane.isMinimized) {
      await restorePane(pane);
    } else {
      setSelectedPaneId(pane.id);
      pendingPaneHeaderFocusIdRef.current = pane.id;
    }
  });
  // Room Agent links and a plan's "Open pane" (Clipboard dock, Open plans) open like an Agents Dashboard entry.
  const roomAgentOnOpenPane = usePaneOpener(() => panesRef.current, paneCardOnOpenExisting, setError);
  const paneCardOnClose = useStableCallback(closePane);
  const paneCardOnMaximize = useStableCallback(toggleMaximize);
  const paneCardOnRestoreLayout = useStableCallback(() => {
    void applyPaneLayoutPreset(null);
  });
  const paneCardOnMinimize = useStableCallback(minimizePane);
  const paneCardOnGrowColumnSpan = useStableCallback(growPaneColumnSpan);
  const paneCardOnResetColumnSpan = useStableCallback(resetPaneColumnSpan);
  const paneCardOnToggleColumnSpan = useStableCallback(togglePaneColumnSpan);
  const paneCardOnSplit = useStableCallback(splitPane);
  const paneCardOnTerminalBootstrapped = useStableCallback(recordRoomPaneBootstrapped);
  const paneCardOnTerminalPrefillReadyChange = useStableCallback(recordRoomTerminalPrefillReady);
  const paneCardOnTerminalRevealReady = useStableCallback(recordTerminalRevealReady);
  const paneCardOnDragStart = useStableCallback(handlePaneDragStart);
  const paneCardOnDragEnd = useStableCallback(clearPaneReorderState);
  const paneCardOnDragOver = useStableCallback(handlePaneDragOver);
  const paneCardOnDragLeave = useStableCallback(handlePaneDragLeave);
  const paneCardOnDrop = useStableCallback(handlePaneDrop);

  const navigateFullscreenPane = useCallback(
    (direction: "previous" | "next", fromPaneId?: string) => {
      const visible = sortPanesForGrid(visiblePanes);
      if (visible.length < 2) return;
      const currentTargetId = fromPaneId ?? selectedPaneId;
      const currentIndex = Math.max(0, visible.findIndex((pane) => pane.id === currentTargetId));
      const step = direction === "next" ? 1 : -1;
      const nextPane = visible[(currentIndex + step + visible.length) % visible.length];
      if (nextPane) {
        setSelectedPaneId(nextPane.id);
        commitPaneCompletionLifecycle(
          acknowledgePaneCompletion(paneCompletionLifecycleRef.current, nextPane.id)
        );
      }
    },
    [visiblePanes, selectedPaneId]
  );
  const paneCardOnFullscreenNavigate = useStableCallback(navigateFullscreenPane);
  const selectMobilePane = useStableCallback((paneId: string) => { setSelectedPaneId(paneId); commitPaneCompletionLifecycle(acknowledgePaneCompletion(paneCompletionLifecycleRef.current, paneId)); });

  async function captureRoomScreen() {
    if (!activeRoom || isCapturingScreenRef.current) return;
    isCapturingScreenRef.current = true;
    try {
      const target: ClipImageTarget = {
        roomId: activeRoom.id,
        paneId: activePane?.id ?? null,
        paneMode: activePane?.mode ?? null
      };
      setError(null);
      notices.setClipToolNotice(null);
      if (runtimeKind === "demo") {
        notices.setClipToolNotice(DEMO_LOCAL_REPLY);
        return;
      }
      const desktopBridge = (window as any).spaceDesktop;
      if (typeof desktopBridge?.openSnippingTool === "function") {
        try {
          const opened = await desktopBridge.openSnippingTool();
          if (opened) return;
        } catch {}
      }
      if (shellMode !== "desktop") {
        openClipImagePicker(target);
        return;
      }
      if (!runtime.platform.displayMediaSupported) {
        openClipImagePicker(target);
        return;
      }
      try {
        let stream: MediaStream;
        try {
          stream = await runtime.platform.getDisplayMedia({
            video: { cursor: "always" } as MediaTrackConstraints,
            audio: false
          });
        } catch (err) {
          const name = err instanceof DOMException ? err.name : "";
          if (name === "AbortError" || name === "NotAllowedError") return;
          openClipImagePicker(target);
          return;
        }
        try {
          const video = document.createElement("video");
          video.srcObject = stream;
          video.muted = true;
          await video.play();
          await new Promise((resolve) => window.requestAnimationFrame(resolve));
          const track = stream.getVideoTracks()[0];
          const settings = track?.getSettings?.() ?? {};
          const width = settings.width ?? video.videoWidth ?? 1920;
          const height = settings.height ?? video.videoHeight ?? 1080;
          const canvas = document.createElement("canvas");
          canvas.width = width;
          canvas.height = height;
          const context = canvas.getContext("2d");
          if (!context) throw new Error("Screen capture canvas is unavailable.");
          context.drawImage(video, 0, 0, width, height);
          const blob = await new Promise<Blob>((resolve, reject) => {
            canvas.toBlob((nextBlob) => {
              if (nextBlob) resolve(nextBlob);
              else reject(new Error("Screen capture PNG export failed."));
            }, "image/png");
          });
          await routeClipImage(
            new File([blob], `space-screen-capture-${Date.now()}.png`, { type: "image/png" }),
            target
          );
        } finally {
          stream.getTracks().forEach((track) => track.stop());
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "Screen capture failed");
      }
    } finally {
      setTimeout(() => {
        isCapturingScreenRef.current = false;
      }, 1200);
    }
  }

  function openClipImagePicker(target: ClipImageTarget) {
    pendingClipImageTargetRef.current = target;
    const input = clipImageInputRef.current;
    if (!input) {
      setError("Image picker is unavailable.");
      return;
    }
    input.value = "";
    input.click();
  }

  async function routeClipImage(file: File, target: ClipImageTarget, signal?: AbortSignal) {
    signal?.throwIfAborted();
    if (!SUPPORTED_CLIP_IMAGE_TYPES.has(file.type.toLowerCase())) {
      throw new Error("Choose a PNG, JPEG, or WebP image.");
    }
    if (target.paneMode === "TERMINAL" && target.paneId) {
      dispatchTerminalPaneAction(target.paneId, { action: "attach_clip_image", file });
      return;
    }
    const uploaded = await api.uploadPaneFiles({
      roomId: target.roomId,
      paneId: target.paneId,
      source: "SCREEN_CAPTURE",
      files: [file],
      signal
    });
    signal?.throwIfAborted();
    dispatchArtifactsUpdated(target.roomId, uploaded.artifacts);
    if (target.paneMode === "CHAT" && target.paneId) {
      dispatchAgentPaneAttachments(target.paneId, uploaded.artifacts);
    }
    if (target.roomId === selectedRoomId) await refreshRoomEvents(target.roomId);
  }

  function handleClipImageSelection(file: File | null) {
    const target = pendingClipImageTargetRef.current;
    pendingClipImageTargetRef.current = null;
    if (!file || !target) return;
    setError(null);
    void routeClipImage(file, target).catch((err: unknown) => {
      setError(err instanceof Error ? err.message : "Clip image upload failed");
    });
  }

  async function reloadRoomWindow() {
    setError(null);
    recordLifecycleDebugEvent({
      type: "manual_room_refresh",
      scope: "App",
      detail: `room=${activeRoom?.id ?? "none"}`,
      shellMode,
      paneId: activePane?.id ?? null
    });
    runtime.platform.reloadPage();
  }

  function clearPaneReorderState() {
    setDraggedPaneId(null);
    setPaneDragOverId(null);
    setPaneDragOverPosition("before");
    setDragOverSlotKey(null);
  }

  function handlePaneDragStart(event: ReactDragEvent<HTMLElement>, pane: Pane) {
    if (paneReorderPending) return;
    if (typeof document !== "undefined") {
      document.querySelectorAll<HTMLDetailsElement>(".pane-title-details[open]").forEach((details) => {
        details.open = false;
      });
    }
    setPaneDragData(event, pane, activeRoom);
    setDraggedPaneId(pane.id);
  }

  function handlePaneDragOver(event: ReactDragEvent<HTMLElement>, paneId: string) {
    if (!draggedPaneId || draggedPaneId === paneId || paneReorderPending) return;
    event.preventDefault();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = "move";
    }
    const rect = event.currentTarget.getBoundingClientRect();
    const isMultiColumn = paneGridColumnCount > 1;
    const clientX =
      typeof event.clientX === "number" && !Number.isNaN(event.clientX)
        ? event.clientX
        : typeof (event.nativeEvent as any)?.clientX === "number"
          ? (event.nativeEvent as any).clientX
          : 0;
    const clientY =
      typeof event.clientY === "number" && !Number.isNaN(event.clientY)
        ? event.clientY
        : typeof (event.nativeEvent as any)?.clientY === "number"
          ? (event.nativeEvent as any).clientY
          : 0;
    const isAfter = isMultiColumn
      ? (rect.width > 0 ? clientX > rect.left + rect.width / 2 : clientX > 0)
      : (rect.height > 0 ? clientY > rect.top + rect.height / 2 : clientY > 0);
    const nextPosition: PaneDropPosition = isAfter ? "after" : "before";
    setPaneDragOverId(paneId);
    setPaneDragOverPosition(nextPosition);
  }

  function handlePaneDragLeave(paneId: string) {
    if (paneDragOverId === paneId) {
      setPaneDragOverId(null);
    }
  }

  async function handlePaneDrop(targetPaneId: string, position: PaneDropPosition = paneDragOverPosition, anchorColumnStart?: number, targetRowIndex?: number) {
    if (!draggedPaneId || (draggedPaneId === targetPaneId && anchorColumnStart === undefined) || paneReorderPending) {
      clearPaneReorderState();
      return;
    }
    const movingPaneId = draggedPaneId;
    const previousPanes = panes;
    const nextPanes = targetPaneId && targetPaneId !== movingPaneId
      ? reorderPanesByTarget(previousPanes, movingPaneId, targetPaneId, position)
      : previousPanes;
    clearPaneReorderState();
    if (anchorColumnStart !== undefined) {
      paneColumnAnchorStartsRef.current.set(
        movingPaneId,
        targetRowIndex !== undefined ? { columnStart: anchorColumnStart, rowIndex: targetRowIndex } : anchorColumnStart
      );
    } else {
      paneColumnAnchorStartsRef.current.delete(movingPaneId);
    }
    setPanes([...nextPanes]);
    setPaneReorderPending(true);
    setError(null);
    try {
      const reorderedPanes = await api.reorderPanes(activeRoom?.id ?? nextPanes[0]?.roomId ?? "", nextPanes.map((pane) => pane.id));
      setPanes(reorderedPanes);
    } catch (err) {
      setPanes(previousPanes);
      setError(err instanceof Error ? err.message : "Pane reorder failed");
    } finally {
      setPaneReorderPending(false);
    }
  }

  const { entries: filteredRoomEntries, isRoomListFiltered } = selectRoomEntries({
    rooms, selectedRoomId, panes, roomRuntimes, completions: paneCompletionLifecycle.panes, roomCliActivityCounts,
    isAdminMode, userId: auth?.user?.id, dock: roomsDock, userEmailById: adminUsers.userEmailById, notificationRooms: notificationStore.pending.byRoom, listsEveryRoom: auth?.user?.role === "USER" });
  const roomsSurfaceContent = (
    <RoomsDockPanel
      dock={roomsDock}
      adminUsers={adminUsers}
      entries={filteredRoomEntries}
      isRoomListFiltered={isRoomListFiltered}
      catalog={{ rooms, setRooms, selectedRoomId, panes, roomRuntimes, roomPaneLoadStates, warmRoomIds, warmRoomEnabled, roomPaneCounts, roomCliRuntimeIds }}
      access={{ auth, isAdminMode, runtimeKind }}
      actions={{
        createRoom, roomCreationPending, selectRoom, requestRoomDelete, requestTestRoomsDelete, deletePendingRoomId, setSelectedPaneId, addFilesPane, addRootAdminPane,
        isRoomWorktreeEnabled, setRoomWorktreeEnabled: userPreferences.setRoomWorktreeEnabled, projectPresets, reportError: setError,
        roomDeleteConfirmDialog: roomDeleteConfirm.confirmDialog, movePaneToRoom
      }}
      composer={{ preparingRoomId, presentationPanes, presentationRoom, addRoomPanes, openSettingsSurface }}
    />
  );

  async function resumeAgentSession(item: AgentSessionHistoryItem): Promise<string | null> {
    if (!selectedRoomId) return "Open a room first to resume sessions.";
    if (panes.length >= 16) return "The room has reached its pane limit.";
    if (item.kind === "codex") {
      if (!item.threadId) return "This session cannot be resumed.";
      if (!isCodexEnabled) return "Codex is not enabled in this workspace.";
      try {
        const created = await api.createPane(
          selectedRoomId,
          paneTitleForMode("TERMINAL", panes.length + 1),
          "TERMINAL",
          { terminalRuntimeId: "cli:codex" }
        );
        registerCliResumeIntent(created.id, { threadId: item.threadId });
        setPanes((current) => [...current.filter((pane) => pane.id !== created.id), created]);
        setSelectedPaneId(created.id);
        return null;
      } catch (err) {
        return err instanceof Error ? err.message : "Codex CLI resume failed";
      }
    }
    const runtimeId = item.threadSource;
    if (!runtimeId) return "This session has no runtime to resume into.";
    if (!item.taskId) return "This session cannot be resumed.";
    try {
      const created = await api.createPane(
        selectedRoomId,
        paneTitleForMode("TERMINAL", panes.length + 1),
        "TERMINAL",
        { terminalRuntimeId: runtimeId }
      );
      registerCliResumeIntent(created.id, { taskId: item.taskId });
      setPanes((current) => [...current.filter((pane) => pane.id !== created.id), created]);
      setSelectedPaneId(created.id);
      return null;
    } catch (err) {
      const message = err instanceof Error ? err.message : "CLI resume failed";
      if (/take control/i.test(message)) {
        return "Open this CLI pane once, then press Resume again.";
      }
      return message;
    }
  }

  const cliDockContent = (
    <LazyCliDock
      canManage={auth?.user?.role === "ADMIN"}
      cliImagePreviewLimit={cliImagePreviewLimit}
      warmRoomEnabled={warmRoomEnabled}
      warmConnectedPaneLimit={warmConnectedPaneLimit}
      defaultWorktreeEnabled={userPreferences.defaultWorktreeEnabled}
      onDefaultWorktreeEnabledChange={userPreferences.changeDefaultWorktreeEnabled}
      onCliImagePreviewLimitChange={userPreferences.changeCliImagePreviewLimit}
      onWarmRoomEnabledChange={userPreferences.changeWarmRoomEnabled}
      onWarmConnectedPaneLimitChange={userPreferences.changeWarmConnectedPaneLimit}
      onOpenRestartAll={manage.cliRuntimeRestartAll.open}
      restartAllPending={manage.cliRuntimeRestartAll.pending}
    />
  );
  const renderSideSurfaceContent = (surface: SideSurface, onClose?: () => void, onNavigate?: (id: string) => void) =>
    surface === "rooms" ? (
      roomsSurfaceContent
    ) : surface === "notifications" ? (
      <LazyNotificationCenterDock />
    ) : surface === "room-agent" ? (
      <LazyRoomAgentDock
        activeRoom={activeRoom}
        selectedBrowserPaneId={activePane?.mode === "BROWSER" && activePane.id === selectedPaneId ? activePane.id : undefined}
        isCodexEnabled={isCodexEnabled}
        refreshKey={roomEvents.at(-1)?.id ?? null}
        onOpenPane={roomAgentOnOpenPane}
      />
    ) : surface === "settings" ? (
      <AgentSettingsDock
        cards={agentSettingsCards}
        roomId={selectedRoomId}
        dotSettingsRequest={dotSettingsRequest}
        adminMode={shellMode !== "desktop" || isAdminMode}
        onOpenSetup={() => onNavigate ? onNavigate("setup-connections") : openManage("setup-connections")}
        activePane={activePane}
        currentAppearance={modernAppearance}
        currentBackground={uiBackground}
        currentIconPack={modernIconPack}
        currentUiTheme={uiTheme}
        currentGlassTint={liquidGlassTint}
        onGlassTintChange={changeLiquidGlassTint}
        isCodexEnabled={isCodexEnabled}
        canManageCliRuntimes={auth?.user?.role === "ADMIN"}
        canManageDiagnostics={auth?.user?.role === "ADMIN"}
        canManageSourceControl={auth?.user?.role === "ADMIN"}
        canManageTelegram={auth?.user?.role === "ADMIN"}
        suppressNotifications={suppressNotifications}
        providerSettings={providerSettings}
        providers={providers}
        gitPluginsActive={sourceControlEnabled}
        isHarnessEnabled={isHarnessEnabled}
        onSuppressNotificationsChange={userPreferences.changeSuppressNotifications}
        onProviderSettingsRefresh={setProviderSettings}
        onUiThemeApply={async ({ appearance, background, iconPack, theme }) => {
          writeModernAppearance(runtime.platform.localStorage, appearance);
          writeUiBackground(runtime.platform.localStorage, background);
          writeModernIconPack(runtime.platform.localStorage, iconPack);
          writeUiTheme(runtime.platform.localStorage, theme);
          try {
            await api.updateUserSettings({
              modernAppearance: appearance,
              uiBackground: background,
              modernIconPack: iconPack,
              uiTheme: theme
            });
          } catch {
            // offline fallback
          }
          runtime.platform.reloadPage();
        }}
        auth={auth}
        onAuthRefresh={refresh}
      />
    ) : surface === "media" ? (
      <LazyMediaDock activeRoom={activeRoom} refreshKey={latestArtifactEventId} />
    ) : surface === "streaming" ? (
      <LazyStreamingDock />
    ) : surface === "source-control" ? (
      <LazySourceControlDock userId={auth?.user?.id || ""} currentProjectPath={activeRoom?.projectPath}
        projects={[...projectPresets, ...rooms.filter(room => room.projectPath).map(room => ({ label: room.name, path: room.projectPath! }))]}
        isAdmin={auth?.user?.role === "ADMIN" || auth?.user?.role === "OPERATOR"} canViewDeploys={auth?.user?.role === "ADMIN"} onProjectOpened={userPreferences.addOpenedProjectPreset} />
    ) : surface === "cli" ? (
      cliDockContent
    ) : surface === "agent-sessions" ? (
      <LazyAgentSessionsDock
        activePaneLabel={activePane ? displayPaneTitle(activePane) : null}
        canResume={Boolean(selectedRoomId)}
        codexEnabled={isCodexEnabled}
        onResume={resumeAgentSession}
      />
    ) : surface === "agent-files" ? (
      <LazyAgentFilesDock activeRoom={activeRoom} refreshKey={latestArtifactEventId} paneTitles={agentFilesPaneTitles} />
    ) : surface === "shared-chat" ? (
      <LazySharedChatDock canRun={auth?.user?.role === "ADMIN" || auth?.user?.role === "OPERATOR"} />
    ) : surface === "nous" ? (
      <LazyNousDock canRun={auth?.user?.role === "ADMIN" || auth?.user?.role === "OPERATOR"} />
    ) : surface === "clipboard" ? (
      <LazyClipboardDock
        canInsert={activePane?.mode === "CHAT" || activePane?.mode === "TERMINAL"}
        activePaneLabel={activePane ? displayPaneTitle(activePane) : null}
        onInsert={insertClipboardItem}
        onOpenStickyNote={onNavigate ? (item) => { setWorkspaceStickyItem(item ?? null); onNavigate("sticky-note"); } : openStickyNote}
        onClose={() => {
          if (onClose) { onClose(); return; }
          setIsDesktopSideSurfaceOpen(false);
          closeCompactSideSurface();
        }}
      />
    ) : surface === "tasks" ? (
      <LazyTaskDock
        canInsert={activePane?.mode === "CHAT" || activePane?.mode === "TERMINAL"}
        activePaneLabel={activePane ? displayPaneTitle(activePane) : null}
        activeCliPaneId={activePane?.mode === "TERMINAL" ? activePane.id : null}
        onInsert={insertTaskItem}
      />
    ) : surface === "vault" ? <LazyVaultDock /> : surface === "links" ? (
      <LinksPanel onOpen={link => {
        if (onNavigate && link.openMode !== "NEW_TAB" && !isYouTubeUrl(link.url)) {
          setWorkspaceUserLink(link);
          onNavigate("link-preview");
        } else openUserLink(link);
      }} />
    ) : (
      <HealthDock
        readiness={readiness}
        mcp={mcp}
        latestSmoke={latestMcpSmoke}
        providers={providers}
        models={models}
        observability={observability}
        workerReadiness={workerReadiness}
        storageReadiness={storageReadiness}
        loadError={healthSurfaceError}
        onRefresh={() => loadHealthSurfaceData(true)}
      />
    );

  // Agent Files cards name the pane that produced a file; the key keeps the map stable while titles are unchanged.
  const paneTitleKey = panes.map((pane) => `${pane.id}\u0001${displayPaneTitle(pane)}`).join("\u0002");
  const agentFilesPaneTitles = useMemo<Record<string, string>>(
    () => Object.fromEntries(paneTitleKey ? paneTitleKey.split("\u0002").map((entry) => entry.split("\u0001") as [string, string]) : []),
    [paneTitleKey]
  );

  const targetablePanes = useMemo(() => {
    const roomPanes = panes.filter(
      (p) => p.roomId === activeRoom?.id && !p.isClosed && !floatingYouTubePaneIds.has(p.id)
    );
    const nonMinimized = roomPanes.filter((p) => !p.isMinimized);
    return nonMinimized.length > 0 ? nonMinimized : roomPanes;
  }, [panes, activeRoom?.id, floatingYouTubePaneIds]);

  const handleSnipCapture = useStableCallback(async (file: File, targetPaneId?: string | null, captureRoomId?: string, signal?: AbortSignal) => {
    const assertCurrent = () => {
      if (signal?.aborted) throw new DOMException("Capture cancelled", "AbortError");
      if (!activeRoom || selectedRoomIdRef.current !== activeRoom.id || (captureRoomId && activeRoom.id !== captureRoomId)) {
        throw new Error("The room changed. Close Snip Tool and capture again in the current room.");
      }
    };
    assertCurrent();
    // Explicit null means Media Dock, never a fallback to a different pane.
    const resolvedPane = targetPaneId ? panes.find(p => p.id === targetPaneId && p.roomId === activeRoom!.id && !p.isClosed) : null;
    if (targetPaneId && !resolvedPane) throw new Error("The selected pane is no longer available. Choose another pane or Media Dock.");
    if (resolvedPane?.isMinimized) await restorePane(resolvedPane);
    assertCurrent();
    if (resolvedPane && !panesRef.current.some(p => p.id === resolvedPane.id && !p.isClosed && p.roomId === activeRoom!.id)) {
      throw new Error("The selected pane is no longer available. Choose another pane or Media Dock.");
    }
    if (resolvedPane) setSelectedPaneId(resolvedPane.id);
    await routeClipImage(file, {
      roomId: activeRoom!.id,
      paneId: resolvedPane?.id ?? null,
      paneMode: resolvedPane?.mode ?? null
    }, signal);
  });

  const isVibeMusicMounted = useVibeMusicMount(activeRoom?.id, isVibeMusicOpen || Boolean(workspaceMusicHost));

  if (!auth || !setupStatus) {
    return (
      <AppIconProvider pack={modernIconPack}>
        <AuthenticationBootstrap
          error={authBootstrapError}
          onRetry={() => {
            setAuthBootstrapError(null);
            refresh().catch((err: unknown) => {
              if (!appMountedRef.current) return;
              setAuthBootstrapError(err instanceof Error ? err.message : "Owner setup status is unavailable.");
            });
          }}
        />
      </AppIconProvider>
    );
  }

  if (!auth.isAuthenticated && (setupStatus.setupRequired || auth.isSetupRequired)) {
    return (
      <AppIconProvider pack={modernIconPack}>
        <OwnerSetupScreen expiresAt={setupStatus.expiresAt} onClaim={handleOwnerClaim} />
      </AppIconProvider>
    );
  }

  const inviteToken = auth.isAuthenticated ? null : readInviteToken(window.location);
  if (inviteToken) {
    return (
      <AppIconProvider pack={modernIconPack}>
        <InviteAcceptScreen
          token={inviteToken}
          colorMode={uiTheme !== "classic" ? modernColorMode : null}
          modern={uiTheme !== "classic"}
          onLogin={handleLogin}
        />
      </AppIconProvider>
    );
  }

  if (!auth.isAuthenticated) {
    return (
      <AppIconProvider pack={modernIconPack}>
        <LoginScreen
          auth={auth}
          colorMode={uiTheme !== "classic" ? modernColorMode : null}
          modern={uiTheme !== "classic"}
          onLogin={handleLogin}
        />
      </AppIconProvider>
    );
  }

  if (isOskKeyboardOpen || workspaceKeyboardHost) oskKeyboardMountedRef.current = true;

  const vibeMusicPlayer = isVibeMusicMounted ? (
    <RecoverableSurface fallback={null}>
      <LazyVibeMusicPlayer
        activeRoomId={activeRoom?.id}
        mobile={shellMode === "mobile"}
        open={isVibeMusicOpen || Boolean(workspaceMusicHost)}
        portalTarget={workspaceMusicHost}
        onOpenChange={open => { if (!open && workspaceMusicHost) workspaceMusicBack.current?.(); else setIsVibeMusicOpen(open); }}
        onOpenYouTube={(url) => { void addPane("YOUTUBE", url); }}
        roomTheme={roomTheme}
        triggerRef={vibeMusicButtonRef}
      />
    </RecoverableSurface>
  ) : null;

  const snipToolOverlay = isSnipToolOpen ? (
    <RecoverableSurface fallback={null}>
    <LazySnipToolOverlay
      isOpen={isSnipToolOpen}
      initialMode={snipToolInitialModeRef.current}
      roomId={activeRoom?.id}
      onClose={() => setIsSnipToolOpen(false)}
      isMobile={shellMode === "mobile"}
      activePaneId={activePane && !activePane.isMinimized ? activePane.id : null}
      activePaneTitle={activePane ? displayPaneTitle(activePane) : null}
      activePaneMode={activePane?.mode ?? null}
      activePaneName={activePane?.paneName ?? null}
      availablePanes={targetablePanes.map((p) => ({
        id: p.id,
        title: displayPaneTitle(p),
        mode: p.mode,
        paneName: p.paneName ?? null
      }))}
      onCapture={handleSnipCapture}
    />
    </RecoverableSurface>
  ) : null;

  const oskKeyboard = oskKeyboardMountedRef.current ? (
    <RecoverableSurface fallback={null}>
      <LazyOnScreenKeyboard
        mobile={shellMode === "mobile"}
        open={isOskKeyboardOpen || Boolean(workspaceKeyboardHost)}
        portalTarget={workspaceKeyboardHost}
        onInput={routeOnScreenKeyboardInput}
        onShortcut={routeCliShortcut}
        onOpenChange={open => { if (!open && workspaceKeyboardHost) workspaceKeyboardBack.current?.(); else setIsOskKeyboardOpen(open); }}
        roomTheme={roomTheme}
      />
    </RecoverableSurface>
  ) : null;

  const stickyNoteLayer = shellMode === "mobile" ? null : (
    <StickyNoteLayer
      windows={stickyWindows}
      onClose={closeStickyWindow}
      onUpdateText={(id, text) => updateStickyWindow(id, { text })}
      onUpdateColor={(id, color) => updateStickyWindow(id, { color })}
      onUpdatePosition={(id, x, y) => updateStickyWindow(id, { x, y })}
      onUpdateItemId={(id, itemId) => updateStickyWindow(id, { itemId })}
      onBringToFront={bringStickyWindowToFront}
    />
  );

  const isHeaderDockActive = !isRoomToolbarHidden;

  const desktopWidgetsLayer = shellMode === "mobile" ? null : (
    <DesktopWidgetsLayer
      widgetsController={desktopWidgets}
      isMultiColumn={paneGridColumnCount >= 2}
      isHeaderDockActive={isHeaderDockActive}
    />
  );

  if (auth?.isAuthenticated && appView === "benchmark") {
    const benchmarkContent = (
      <RecoverableSurface fallback={<div className="page-loading" role="status">Loading benchmark…</div>}>
        <LazyBenchmarkPage onBack={closeBenchmark} />
      </RecoverableSurface>
    );
    return (
      <AppIconProvider pack={modernIconPack}>
        {vibeMusicPlayer}
        {oskKeyboard}
        {stickyNoteLayer}
        {desktopWidgetsLayer}
        {uiTheme !== "classic" ? (
          <div
            className="modern-theme-page"
            data-ui-theme="modern"
            data-color-mode={modernColorMode}
            data-icon-pack={modernIconPack}
            data-room-theme={roomTheme}
          >
            {benchmarkContent}
          </div>
        ) : benchmarkContent}
      </AppIconProvider>
    );
  }

  if (auth?.isAuthenticated && appView === "help") {
    const helpContent = (
        <RecoverableSurface fallback={<div className="page-loading" role="status">Loading Help…</div>}>
          <LazyHelpPage onBack={closeHelp} />
        </RecoverableSurface>
    );
    // Same provider path as the workspace, so the music player, keyboard, notes and widgets keep
    // their instances (audio keeps playing) when Help opens and closes.
    return (
      <AppIconProvider pack={modernIconPack}>
        <LiveSessionProvider ownerId={auth.user?.id || ""} roomId={selectedRoomId || activeRoom?.id || null} roomName={activeRoom?.name}>
        {vibeMusicPlayer}
        {oskKeyboard}
        {stickyNoteLayer}
        {desktopWidgetsLayer}
        {uiTheme !== "classic" ? (
          <div
            className={
              uiTheme === "codex"
                ? "modern-theme-page codex-theme-page"
                : uiTheme === "motion" || uiTheme === "aurora" || uiTheme === "liquid-glass" || uiTheme === "jarvis" || uiTheme === "aira"
                  ? `modern-theme-page ${uiTheme}-theme-page`
                  : "modern-theme-page"
            }
            data-ui-theme={uiTheme}
            data-interface-theme={uiTheme}
            data-color-mode={modernColorMode}
            data-icon-pack={modernIconPack}
            data-room-theme={roomTheme}
          >
            {helpContent}
          </div>
        ) : (
          <div
            className="space-shell classic-theme-page"
            data-ui-theme="classic"
            data-interface-theme="classic"
            data-room-theme={roomTheme}
            data-icon-pack={modernIconPack}
          >
            {helpContent}
          </div>
        )}
        </LiveSessionProvider>
      </AppIconProvider>
    );
  }

  const showPaneNavigation = showMinimizedBar;
  const shellClassName = ["space-shell", `shell-${shellMode}`, isRoomFocusMode ? "room-focus-mode" : ""].filter(Boolean).join(" ");
  const workspaceClassName = ["workspace", showInlineSideSurface ? "" : "side-surface-hidden"].filter(Boolean).join(" ");
  const boardClassName = ["board", showPaneNavigation ? "has-pane-navigation" : ""].filter(Boolean).join(" ");
  // Presentation state controls stacking. Keep resident siblings in stable ID
  // order so React never detaches/reinserts their DOM just to activate a room.
  const mountedRoomRuntimeIds = selectedRoomId
    ? Array.from(new Set(
        [selectedRoomId, displayedRoomId, preparingRoomId, ...warmRoomIds]
          .filter((roomId): roomId is string => Boolean(roomId))
      )).sort()
    : [];
  const roomRuntimeStackHasEmptyState = mountedRoomRuntimeIds.some((roomId) => {
    return roomRuntimeLayerHasEmptyState({
      roomId,
      selectedRoomId,
      selectedPanes: panes,
      runtimePanes: roomRuntimes[roomId]?.panes,
      category: activeCategoryColorByRoom[roomId] ?? null
    });
  });

  function renderRoomRuntimeLayer(roomId: string) {
    const isActive = roomId === selectedRoomId;
    const warmRecencyRank = warmRoomIds.indexOf(roomId);
    const presentationState =
      roomId === preparingRoomId
        ? "preparing"
        : roomId === displayedRoomId
          ? preparingRoomId
            ? "held"
            : "displayed"
          : "hidden";
    const isPresented = presentationState !== "hidden";
    const isInteractive = presentationState === "displayed";
    const acceptsTerminalOutput = presentationState === "preparing" || presentationState === "displayed";
    const cached = roomRuntimes[roomId];
    if (!isActive && !cached) return null;
    const layerPanes = isActive ? panes : cached?.panes ?? [];
    const layerTurns = isActive ? turns : cached?.turns ?? [];
    const layerEvents = isActive ? roomEvents : cached?.events ?? [];
    const layerSelectedPaneId = isActive ? selectedPaneId : cached?.selectedPaneId ?? null;
    const layerPaneLoadState = roomPaneLoadStates[roomId] ?? "loading";
    const layerRoom = rooms.find((room) => room.id === roomId) ?? null;
    const layerPaneLimit = roomPaneLimit(layerRoom);
    const layerAddPaneBlockedReason = layerPanes.length >= layerPaneLimit
      ? `This room already has the maximum of ${layerPaneLimit} panes.`
      : null;
    const roomCategoryFilter = activeCategoryColorByRoom[roomId] ?? null;
    const layerRenderPanes = roomCategoryFilter
      ? layerPanes.filter((pane) => pane.categoryColor === roomCategoryFilter)
      : layerPanes;
    const layerVisiblePanes = layerRenderPanes.filter((pane) => (shellMode === "mobile" || !pane.isMinimized) && !floatingYouTubePaneIds.has(pane.id));
    // A stored layout may outlive pane creation/closure or a shell mode change.
    // Fall back to the existing grid until it covers the current room exactly.
    const savedControlLayout = controlLayouts[roomId];
    const layerControlLayout = savedControlLayout?.mode === "CUSTOM"
      && !layerPanes.some(pane => pane.isMaximized)
      && layerRoom?.paneLayoutColumns !== 0
      && savedControlLayout.placements.length === layerPanes.length
      && layerPanes.every(pane => savedControlLayout.placements.some(placement => placement.paneId === pane.id))
      ? savedControlLayout : null;
    const layerFullscreenLayout = layerRoom?.paneLayoutColumns === 0;
    const layerShellVisiblePaneIds = new Set(
      shellVisiblePaneIds(layerPanes, layerSelectedPaneId, shellMode, layerFullscreenLayout)
    );
    const layerShellVisiblePanes = layerVisiblePanes.filter((pane) =>
      layerShellVisiblePaneIds.has(pane.id)
    );
    const layerActivePane =
      layerShellVisiblePanes.find((pane) => pane.id === layerSelectedPaneId) ??
      layerShellVisiblePanes[0] ??
      null;
    // Every hidden pane of the displayed full-screen room sizes its CLI ahead of a switch (operator-approved 2026-10-18).
    const layerFullscreenPresizeIds = new Set(
      isInteractive && layerFullscreenLayout && shellMode !== "mobile" ? layerVisiblePanes.map((pane) => pane.id) : []
    );
    const layerDensity = isActive ? paneDensity : paneDensityFor(shellMode, layerVisiblePanes.length);
    const layerColumnCount = isActive
      ? paneGridColumnCount
      : resolvePaneGridColumnCount({
          shellMode,
          paneDensity: layerDensity,
          containerWidth: paneGridWidth,
          rootRemSize,
          paneLayoutColumns: layerRoom?.paneLayoutColumns ?? null,
          visiblePaneCount: layerVisiblePanes.length,
          forceTabletTwoColumns: uiTheme !== "classic"
        });
    const layerPlacements = isActive
      ? paneGridPlacements
      : resolvePaneGridPlacements(layerVisiblePanes, layerColumnCount, new Map());
    const layerLatestTurnByPane = new Map<string, Turn>();
    for (const turn of layerTurns) {
      if (turn.paneId && !layerLatestTurnByPane.has(turn.paneId)) layerLatestTurnByPane.set(turn.paneId, turn);
    }
    const layerLatestCompletionByPane = new Map<string, SpaceEvent>();
    for (const event of layerEvents) {
      if (event.type === "TURN_COMPLETED" && event.paneId && !layerLatestCompletionByPane.has(event.paneId)) {
        layerLatestCompletionByPane.set(event.paneId, event);
      }
    }
    const layerAgentNumberByPaneId = new Map(layerPanes.map((pane, index) => [pane.id, index + 1]));
    const bootstrappedPaneIds = new Set(cached?.bootstrappedPaneIds ?? []);
    const prefillReadyPaneIds = new Set(cached?.prefillReadyPaneIds ?? []);
    const layerTerminalPrefillReady = layerRenderPanes
      .filter((pane) => pane.mode === "TERMINAL" && !pane.isMinimized)
      .every((pane) => prefillReadyPaneIds.has(pane.id));
    const unorderedTerminalBootstrapPaneIds = layerRenderPanes
      .filter((pane) => pane.mode === "TERMINAL" && !pane.isMinimized && !pane.id.startsWith("pane:optimistic-"))
      .map((pane) => pane.id);
    const priorityTerminalPaneId = layerActivePane?.mode === "TERMINAL" && !layerActivePane.id.startsWith("pane:optimistic-")
      ? layerActivePane.id
      : null;
    const terminalBootstrapPaneIds = priorityTerminalPaneId
      ? [
          priorityTerminalPaneId,
          ...unorderedTerminalBootstrapPaneIds.filter((paneId) => paneId !== priorityTerminalPaneId)
        ]
      : unorderedTerminalBootstrapPaneIds;
    const layerVisiblePaneCount = (shellMode === "mobile" || layerFullscreenLayout) && layerActivePane ? 1 : layerVisiblePanes.length;
    const layerHasMaximizedPane = shellMode !== "mobile" && layerVisiblePanes.some((pane) => pane.isMaximized);
    const layerHeight = (layerRoom?.paneLayoutHeight ?? 1) as 1 | 2 | 3 | 4;
    const {
      naturalRows: layerNaturalRows,
      naturalEmptySlots: layerNaturalEmptySlots,
      actualBaseRows: layerCalculatedBaseRows
    } = calculatePaneGridBaseRows({
      placements: layerPlacements,
      visiblePaneCount: layerVisiblePanes.length,
      columnCount: layerColumnCount,
      targetEmptySlots: roomExtraEmptySlots[roomId]
    });
    const layerActualBaseRows = layerFullscreenLayout ? 1 : layerCalculatedBaseRows;
    const layerExplicitHeight =
      shellMode !== "mobile" &&
      !layerHasMaximizedPane &&
      !layerFullscreenLayout &&
      layerVisiblePanes.length > 0;
    const layerGridGapPx = layerDensity === "dense" || layerDensity === "tight" ? 9.6 : 12;
    const layerEffectiveContainerHeight =
      paneGridHeight > 0
        ? paneGridHeight
        : typeof window !== "undefined" && window.innerHeight > 0
          ? Math.max(window.innerHeight - 120, 480)
          : 600;
    const minPaneRowPx = 320;
    const maxFittingRows = Math.max(
      1,
      Math.floor((layerEffectiveContainerHeight + layerGridGapPx) / (minPaneRowPx + layerGridGapPx))
    );
    const viewportRows = Math.max(1, Math.min(layerActualBaseRows, maxFittingRows));
    const layerBaselineRowPx = Math.max(
      Math.round((layerEffectiveContainerHeight - (viewportRows - 1) * layerGridGapPx) / viewportRows),
      minPaneRowPx
    );
    const layerRowPx = layerExplicitHeight ? Math.round(layerBaselineRowPx * layerHeight) : 0;

    const staticEmptyGridSlots: { rowIndex: number; columnStart: number }[] = [];
    if (shellMode !== "mobile" && (layerColumnCount > 1 || layerActualBaseRows > 1) && !layerHasMaximizedPane && layerVisiblePanes.length > 0) {
      const occupied = Array.from({ length: layerActualBaseRows }, () => Array(layerColumnCount).fill(false));
      for (const pane of layerVisiblePanes) {
        const placement = layerPlacements.get(pane.id);
        if (!placement) continue;
        for (let c = 0; c < placement.effectiveSpan; c++) {
          const colIdx = placement.columnStart - 1 + c;
          const rowArr = occupied[placement.rowIndex];
          if (rowArr && colIdx < layerColumnCount) {
            rowArr[colIdx] = true;
          }
        }
      }
      for (let r = 0; r < layerActualBaseRows; r++) {
        for (let c = 0; c < layerColumnCount; c++) {
          if (!occupied[r]?.[c]) {
            staticEmptyGridSlots.push({ rowIndex: r, columnStart: c + 1 });
          }
        }
      }
    }

    const emptyGridSlots: { rowIndex: number; columnStart: number; precedingPaneId: string | null }[] = [];
    if (draggedPaneId && shellMode !== "mobile" && (layerColumnCount > 1 || layerActualBaseRows > 1) && !layerHasMaximizedPane && layerVisiblePanes.length > 0) {
      const occupied = Array.from({ length: layerActualBaseRows }, () => Array(layerColumnCount).fill(false));
      for (const pane of layerVisiblePanes) {
        if (pane.id === draggedPaneId) continue;
        const placement = layerPlacements.get(pane.id);
        if (!placement) continue;
        for (let c = 0; c < placement.effectiveSpan; c++) {
          const colIdx = placement.columnStart - 1 + c;
          const rowArr = occupied[placement.rowIndex];
          if (rowArr && colIdx < layerColumnCount) {
            rowArr[colIdx] = true;
          }
        }
      }
      for (let r = 0; r < layerActualBaseRows; r++) {
        for (let c = 0; c < layerColumnCount; c++) {
          if (!occupied[r]?.[c]) {
            let precedingPaneId: string | null = null;
            let maxPos = -1;
            for (const pane of layerVisiblePanes) {
              if (pane.id === draggedPaneId) continue;
              const pl = layerPlacements.get(pane.id);
              if (!pl) continue;
              const pos = pl.rowIndex * layerColumnCount + (pl.columnStart - 1);
              const currentSlotPos = r * layerColumnCount + c;
              if (pos < currentSlotPos && pos > maxPos) {
                maxPos = pos;
                precedingPaneId = pane.id;
              }
            }
            emptyGridSlots.push({ rowIndex: r, columnStart: c + 1, precedingPaneId });
          }
        }
      }
    }

    return (
      <div
        key={roomId}
        className="room-runtime-layer"
        data-room-runtime-id={roomId}
        data-presentation-state={presentationState}
        data-reveal-state={isActive && preparingRoomId === roomId ? "preparing" : "ready"}
        data-warm-room-admission-state={
          isActive
            ? "active"
            : roomId === preparingRoomId
              ? "preparing"
              : roomId === displayedRoomId
                ? "displayed"
                : "warm"
        }
        data-warm-room-recency-rank={warmRecencyRank >= 0 ? warmRecencyRank + 1 : undefined}
        data-terminal-prefill-ready={layerTerminalPrefillReady ? "true" : "false"}
        aria-hidden={!isInteractive}
        inert={isInteractive ? undefined : true}
      >
        {layerPanes.length === 0 && layerPaneLoadState === "loading" ? (
          <div className="empty-state" role={isInteractive ? "status" : undefined}>
            <img src="/brand/space-launch.svg" alt="" width="88" height="110" />
            <h3 className="sr-only">Loading panes</h3>
          </div>
        ) : layerPanes.length === 0 && layerPaneLoadState === "error" ? (
          <div className="empty-state" role={isInteractive ? "alert" : undefined}>
            <Grid2X2 aria-hidden="true" />
            <h3>Unable to load panes</h3>
          </div>
        ) : layerPanes.length === 0 ? (
          <div
            className="empty-state room-empty-state"
            role={isInteractive ? "region" : undefined}
            aria-label={isInteractive ? "Empty room quick start" : undefined}
          >
            <Grid2X2 aria-hidden="true" />
            <h3>Start your workspace</h3>
            <p>Choose a pane to begin working in this room.</p>
            <div className="empty-state-actions" aria-label="Quick start" aria-busy={paneCreationPendingMode !== null}>
              <button
                onClick={() => void addPane("TERMINAL")}
                disabled={!isInteractive || !selectedRoomId || paneCreationPendingMode !== null || cliPaneCreationPending}
              >
                {paneCreationPendingMode === "TERMINAL" ? <Loader2 className="spin" aria-hidden="true" /> : <Terminal aria-hidden="true" />}
                {paneCreationPendingMode === "TERMINAL" ? "Opening CLI…" : "Open CLI"}
              </button>
              <button
                onClick={() => void addPane("CHAT")}
                disabled={!isInteractive || !selectedRoomId || paneCreationPendingMode !== null || cliPaneCreationPending}
              >
                {paneCreationPendingMode === "CHAT" ? <Loader2 className="spin" aria-hidden="true" /> : <MessageSquare aria-hidden="true" />}
                {paneCreationPendingMode === "CHAT" ? "Opening Chat…" : "Open Chat"}
              </button>
              <button
                onClick={() => void addPane("BROWSER")}
                disabled={!isInteractive || !selectedRoomId || paneCreationPendingMode !== null || cliPaneCreationPending}
              >
                {paneCreationPendingMode === "BROWSER" ? <Loader2 className="spin" aria-hidden="true" /> : <Globe aria-hidden="true" />}
                {paneCreationPendingMode === "BROWSER" ? "Opening Browser…" : "Open Browser"}
              </button>
            </div>
          </div>
        ) : layerRenderPanes.length === 0 ? (
          <div className="empty-state" role={isInteractive ? "status" : undefined}>
            <Palette aria-hidden="true" />
            <h3>No panes match this color</h3>
          </div>
        ) : (
          <TerminalBootstrapBoundary paneIds={terminalBootstrapPaneIds}>
            {(terminalBootstrapBarriers) => (
              <div
                ref={isActive ? paneGridRef : undefined}
                className={layerHasMaximizedPane ? "pane-grid maximized" : "pane-grid"}
                data-density={layerDensity}
                data-shell-mode={shellMode}
                data-pane-count={layerRenderPanes.length}
                data-visible-pane-count={layerVisiblePaneCount}
                data-column-count={layerColumnCount}
                data-pane-layout-columns={layerRoom?.paneLayoutColumns ?? "automatic"}
                data-pane-layout-height={layerRoom?.paneLayoutHeight ?? 1}
                data-fullscreen-layout={layerFullscreenLayout ? "true" : undefined}
                style={{
                  gridTemplateColumns: layerFullscreenLayout
                    ? "minmax(0, 1fr)"
                    : `repeat(${layerColumnCount}, minmax(0, 1fr))`,
                  ...(shellMode !== "mobile" && layerControlLayout ? {position:"relative",display:"block",minHeight:`${Math.max(30,...layerControlLayout.placements.map(p=>p.y+p.height))*12}px`} : {}),
                  ...(shellMode !== "mobile" && layerExplicitHeight && layerRowPx > 0
                    ? {
                        gridTemplateRows: `repeat(${layerActualBaseRows}, ${layerRowPx}px)`,
                        gridAutoRows: `${layerRowPx}px`
                      }
                    : {
                        // A maximized pane spans every row (1 / -1) while the others are hidden;
                        // one row keeps it at the grid's height instead of N × 20rem with a scrollbar.
                        gridTemplateRows: shellMode === "mobile" || layerFullscreenLayout || layerHasMaximizedPane
                          ? "minmax(0, 1fr)"
                          : `repeat(${layerActualBaseRows}, minmax(20rem, 1fr))`
                      })
                }}
              >
                {layerRenderPanes.map((pane) => {
                  const latestCompletion = layerLatestCompletionByPane.get(pane.id) ?? null;
                  const placement = layerPlacements.get(pane.id);
                  return (
                    <PaneCard
                      key={pane.id}
                      roomProjectPath={layerRoom?.projectPath}
                      controlPlacement={shellMode !== "mobile" && !pane.isMinimized ? layerControlLayout?.placements.find(p=>p.paneId===pane.id) : undefined}
                      pane={shellMode === "mobile" && pane.isMinimized ? { ...pane, isMinimized: false } : pane}
                      agentNumber={layerAgentNumberByPaneId.get(pane.id) ?? 1}
                      latestTurn={layerLatestTurnByPane.get(pane.id) ?? null}
                      latestCompletion={latestCompletion}
                      hasPendingCompletion={Boolean(
                        pendingPaneCompletionEventId(paneCompletionLifecycle, pane.id)
                      )}
                      isLifecycleRunning={paneCompletionLifecycle.panes[pane.id]?.activeRunKey != null}
                      isTarget={isPresented && layerActivePane?.id === pane.id}
                      isMoveDialogOpen={isInteractive && paneMoveDialog?.pane.id === pane.id}
                      isVisibleInShell={isPresented && (layerShellVisiblePaneIds.has(pane.id) || floatingYouTubePaneIds.has(pane.id))}
                      isPresentationInteractive={isInteractive}
                      isFloatingYouTube={pane.mode === "YOUTUBE" && floatingYouTubePaneIds.has(pane.id)}
                      onToggleYouTubeFloating={pane.mode === "YOUTUBE" ? () => toggleYouTubeFloating(pane.id) : undefined}
                      maskSensitiveData={maskSensitiveData}
                      isTerminalOutputVisible={
                        acceptsTerminalOutput &&
                        layerShellVisiblePaneIds.has(pane.id)
                      }
                      oskOpen={isOskKeyboardOpen}
                      browserObserverOnly={auth?.user?.automationScope === "APP_DIAGNOSTICS"}
                      terminalObserverOnly={auth?.user?.automationScope === "APP_DIAGNOSTICS"}
                      uiTheme={uiTheme}
                      shellMode={shellMode}
                      codexTurnsEnabled={codexTurnsEnabled}
                      codexEnvironment={paneCodexEnvironment}
                      cliRuntimeSettings={pane.mode === "HARNESS" ? cliRuntimeSettings : null}
                      runtimeBlockedReason={paneRuntimeBlockedReason(pane, cliRuntimeSettings)}
                      addPaneBlockedReason={layerAddPaneBlockedReason}
                      canMoveToAnotherRoom={rooms.some((room) => room.id !== pane.roomId)}
                      draggedPaneId={draggedPaneId === pane.id ? draggedPaneId : null}
                      dragOverPaneId={paneDragOverId === pane.id ? paneDragOverId : null}
                      dragOverPosition={paneDragOverId === pane.id ? paneDragOverPosition : undefined}
                      paneReorderPending={paneReorderPending}
                      onPaneDragStart={paneCardOnDragStart}
                      onPaneDragEnd={paneCardOnDragEnd}
                      onPaneDragOver={paneCardOnDragOver}
                      onPaneDragLeave={paneCardOnDragLeave}
                      onPaneDrop={paneCardOnDrop}
                      onTarget={paneCardOnTarget}
                      onMove={paneCardOnMove}
                      onPaneUpdated={paneCardOnPaneUpdated}
                      onOpenExistingPane={paneCardOnOpenExisting}
                      onClose={paneCardOnClose}
                      onMaximize={paneCardOnMaximize}
                      onMinimize={paneCardOnMinimize}
                      onGrowColumnSpan={paneCardOnGrowColumnSpan}
                      onResetColumnSpan={paneCardOnResetColumnSpan}
                      onToggleColumnSpan={paneCardOnToggleColumnSpan}
                      onSplit={paneCardOnSplit}
                      isFullscreenLayout={layerFullscreenLayout}
                      presizeInFullscreen={layerFullscreenPresizeIds.has(pane.id)}
                      fullscreenIndex={Math.max(0, layerVisiblePanes.findIndex((candidate) => candidate.id === pane.id))}
                      fullscreenCount={layerVisiblePanes.length}
                      onFullscreenNavigate={paneCardOnFullscreenNavigate}
                      onRestoreLayout={paneCardOnRestoreLayout}
                      effectiveColumnSpan={placement?.effectiveSpan ?? 1}
                      rowSpan={1}
                      columnStart={placement?.columnStart ?? 1}
                      rowIndex={placement?.rowIndex ?? 0}
                      canGrowColumnSpan={placement?.canGrow ?? false}
                      canResetColumnSpan={placement?.canReset ?? false}
                      terminalFontSize={terminalFontSize}
                      hideCliFloats={cliFloatsHidden}
                      showSessionDebugIds={showSessionDebugIds}
                      cliDebugModeEnabled={cliDebugModeEnabled}
                      onCliDebugModeChange={setCliDebugModeEnabled}
                      cliMemorySaveModelId={cliMemorySaveModelId}
                      cliImagePreviewLimit={cliImagePreviewLimit}
                      terminalBootstrapBarrier={terminalBootstrapBarriers.get(pane.id)}
                      shouldBootstrapTerminal={
                        !pane.id.startsWith("pane:optimistic-") &&
                        (!pane.isMinimized || bootstrappedPaneIds.has(pane.id) || (shellMode === "mobile" && layerShellVisiblePaneIds.has(pane.id)))
                      }
                      prefillInitialReplay={presentationState === "hidden" && !pane.isMinimized}
                      shouldLoadHarness={shouldLoadHarnessPane(presentationState, layerTerminalPrefillReady)}
                      // Only the selected room can acknowledge this reveal.
                      // Keep unrelated resident panes memoized across switches;
                      // recordTerminalRevealReady still rejects stale rooms.
                      revealGeneration={isActive ? roomPresentationGenerationRef.current : 0}
                      onTerminalBootstrapped={paneCardOnTerminalBootstrapped}
                      onTerminalPrefillReadyChange={paneCardOnTerminalPrefillReadyChange}
                      onTerminalRevealReady={paneCardOnTerminalRevealReady}
                    />
                  );
                })}
                {!draggedPaneId && staticEmptyGridSlots.map((slot) => (
                  <div
                    key={`static-empty-${slot.rowIndex}-${slot.columnStart}`}
                    className="pane-grid-empty-slot"
                    style={{
                      gridRow: slot.rowIndex + 1,
                      gridColumn: slot.columnStart
                    }}
                    aria-hidden="true"
                  />
                ))}
                {emptyGridSlots.map((slot) => {
                  const slotKey = `slot-${slot.rowIndex}-${slot.columnStart}`;
                  const isHovered = dragOverSlotKey === slotKey;
                  return (
                    <div
                      key={slotKey}
                      className={`pane-grid-drop-slot${isHovered ? " is-hovered" : ""}`}
                      style={{
                        gridRow: slot.rowIndex + 1,
                        gridColumn: slot.columnStart
                      }}
                      onDragOver={(event) => {
                        event.preventDefault();
                        if (event.dataTransfer) {
                          event.dataTransfer.dropEffect = "move";
                        }
                        setDragOverSlotKey(slotKey);
                      }}
                      onDragLeave={() => {
                        if (dragOverSlotKey === slotKey) {
                          setDragOverSlotKey(null);
                        }
                      }}
                      onDrop={(event) => {
                        event.preventDefault();
                        const fallbackPane = layerVisiblePanes.find((candidate) => candidate.id !== draggedPaneId);
                        if (slot.precedingPaneId) {
                          void handlePaneDrop(slot.precedingPaneId, "after", slot.columnStart, slot.rowIndex);
                        } else if (fallbackPane) {
                          void handlePaneDrop(fallbackPane.id, "before", slot.columnStart, slot.rowIndex);
                        } else if (draggedPaneId) {
                          void handlePaneDrop(draggedPaneId, "after", slot.columnStart, slot.rowIndex);
                        }
                      }}
                    >
                      <div className="pane-grid-drop-slot-indicator">
                        <MoveHorizontal aria-hidden="true" />
                        <span>Drop pane here</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </TerminalBootstrapBoundary>
        )}
      </div>
    );
  }

  async function reopenPane(roomId: string, paneId: string) {
    try {
      const pane = await api.updatePane(paneId, { isClosed: false, isMinimized: false, status: "IDLE" });
      if (selectedRoomIdRef.current === roomId) {
        setPanes((current) => [...current.filter((candidate) => candidate.id !== pane.id), pane]);
        setSelectedPaneId(pane.id);
        await refreshRoomEvents(roomId);
      } else {
        await selectRoom(roomId);
        setSelectedPaneId(pane.id);
      }
      refreshToolbarSystemState();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to reopen window");
    }
  }

  async function reopenAllDetachedPanes() {
    try {
      const analytics = await api.systemAnalyticsCliSessions("10m").catch(() => null);
      const detached = analytics?.sessions.filter((s) => s.status === "RUNNING" && s.attachmentCount === 0) ?? [];
      if (detached.length === 0) return;
      const reopenedRoomIds = new Set<string>();
      for (const session of detached) {
        await api.updatePane(session.paneId, { isClosed: false, isMinimized: false, status: "IDLE" }).catch(() => null);
        reopenedRoomIds.add(session.roomId);
      }
      const currentRoomId = selectedRoomIdRef.current;
      if (currentRoomId && reopenedRoomIds.has(currentRoomId)) {
        await loadRoomRuntime(currentRoomId);
        await refreshRoomEvents(currentRoomId);
      } else if (detached[0]?.roomId) {
        await selectRoom(detached[0].roomId);
      }
      refreshToolbarSystemState();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to reopen detached windows");
    }
  }

  async function closeDetachedPane(paneId: string) {
    try {
      await api.closePane(paneId);
      setPanes((current) => current.filter((pane) => pane.id !== paneId));
      refreshToolbarSystemState();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to close window");
    }
  }

  const showResourceIndicatorRail = (resourceIndicatorsVisible || (Boolean(showMinimizedBarToggle) && auth?.user?.role === "ADMIN")) && isRoomToolbarHidden;
  const renderToolbarMetrics = (hideTrigger = true) => (
    <ToolbarMetrics
      hideTrigger={hideTrigger}
      ref={toolbarMetricsRef}
      presentation="drawer"
      onOpenResources={auth?.user?.role === "ADMIN" ? () => openSystemResources() : undefined}
      allowChanges={shellMode !== "desktop" || isAdminMode}
      canManage={auth?.user?.role === "ADMIN"}
      environment={codexEnvironmentSummary}
      roomName={presentationRoom?.name}
      roomId={presentationRoom?.id}
      onOpenAnalytics={(tab) => {
        setIsMemoryWorkspaceOpen(false);
        setIsSpaceGatewayOpen(false);
        setSystemAnalyticsTab(tab);
      }}
      onChanged={refreshToolbarSystemState}
      onReopenPane={reopenPane}
      onReopenAllDetached={reopenAllDetachedPanes}
      onCloseSession={closeDetachedPane}
    />
  );

  const setupConnectionsContent = auth?.user?.role === "ADMIN" ? (
              <SettingsSections>
                <SettingsDisclosure title="GitHub & Gitea" description="Connect repositories for publishing." scope="Installation" icon={GitBranch}>
                  <RecoverableSurface fallback={settingsCardLoadingFallback}><LazySourceControlPublishingCard canManage /></RecoverableSurface>
                </SettingsDisclosure>
                <SettingsDisclosure title="Telegram notifications" description="Get updates in Telegram." scope="Installation" icon={Bell}>
                  <RecoverableSurface fallback={settingsCardLoadingFallback}><LazyTelegramIntegrationCard canManage isCodexEnabled={isCodexEnabled} /></RecoverableSurface>
                </SettingsDisclosure>
              </SettingsSections>
            ) : undefined;

  function renderManageGroupIntro(group: string, open: (id: string) => void) {
    if (group !== "maintenance") return null;
    return <RecoverableSurface fallback={<p role="status">Loading maintenance…</p>}><LazyMaintenanceHub onOpenTool={open} /></RecoverableSurface>;
  }

  function renderWorkspaceManageAction(id: string, back: () => void, navigate: (id: string) => void = openManage, inline = false) {
              if (id === "setup-connections" && inline) return <WorkspacePortalMount onTargetChange={setWorkspaceSetupHost} onBack={back} onBackRef={workspaceSetupBack} />;
              if (id === "space-cli-maintenance" || id === "cli-update-all" || id === "publish-space-release")
                return <LazyAdminOperationsDialog embedded initialTool={id === "publish-space-release" ? "release" : id === "cli-update-all" ? "update-all" : "maintenance"} onClose={back}
                  onMinimize={() => { setIsServerActionsMenuOpen(false); back(); }} />;
              if (id === "codex-lb-speed-control" || id === "cli-session-cleanup" || id === "codex-history-purge")
                return <LazyAdminCodexToolsDialog embedded initialTool={id === "codex-lb-speed-control" ? "speed" : id === "cli-session-cleanup" ? "cleanup" : "history"} isCodexEnabled={isCodexEnabled} anyCliEnabled={anyCliEnabled} onClose={back} />;
              if (id === "system-services") return <LazySystemServicesDialog embedded onClose={back} />;
              if (id === "user-management") return <LazyUserManagementDialog embedded currentUserId={auth?.user?.id} onClose={back} />;
              if (id === "setup-connections") return <LazySetupConnectionsWizard embedded open onOpenMaintenance={() => navigate("space-cli-maintenance")} connectionsContent={setupConnectionsContent} checks={api} finish={api.finishSetup} loadOverview={api.setupOverview} openLogin={async connection => {
                  manageLoginPendingRef.current = true; setManageLoginPending(true);
                  try { await openSetupConnectionLogin(connection); }
                  catch (error) { manageLoginPendingRef.current = false; setManageLoginPending(false); throw error; }
                }} onOpenChange={open => {
                  if (open) { manageLoginPendingRef.current = false; setIsServerActionsMenuOpen(true); setManageLoginPending(false); }
                  else if (manageLoginPendingRef.current) setIsServerActionsMenuOpen(false);
                  else back();
                }} />;
              return null;
  }

  function renderWorkspaceAction(id: string, { onBack, onNavigate, triggerRef }: {
    onBack: () => void; onNavigate: (id: string) => void; triggerRef: RefObject<HTMLButtonElement | null>;
  }) {
    let content;
    if (id === "vibe-music") return <WorkspacePortalMount onTargetChange={setWorkspaceMusicHost} onBack={onBack} onBackRef={workspaceMusicBack} />;
    if (id === "osk-keyboard") return <WorkspacePortalMount onTargetChange={setWorkspaceKeyboardHost} onBack={onBack} onBackRef={workspaceKeyboardBack} />;
    if (id === "workspace-room") {
      content = <WorkspaceRoomSettings actions={workspaceNavigationActions} detailActionIds={workspaceDetailActionIds} onNavigate={onNavigate} />;
    } else if (id === "resources" || id === "system-resources" || id === "surface-health") {
      content = <SystemHealth userId={auth?.user?.id ?? ""} railVisible={false} environment={codexEnvironmentSummary}
        allowChanges={isAdminMode} onClose={onBack} onReopenPane={reopenPane} onReopenAllDetached={reopenAllDetachedPanes}
        onCloseSession={closeDetachedPane} />;
    } else if (id.startsWith("surface-")) {
      const surface = id.slice(8) as SideSurface;
      content = <section className="workspace-dock-detail" aria-label={sideSurfaceMeta[surface].surfaceLabel}>
        {renderSideSurfaceContent(surface, onBack, onNavigate)}
      </section>;
    } else if (id === "advanced-settings") {
      content = renderSideSurfaceContent("settings", onBack, onNavigate);
    } else if (id === "pane-layout" && activeRoom) {
      content = <LazyPaneLayoutMenu automaticColumns={layoutAutomaticPaneGridColumnCount}
        currentColumns={activeRoom.paneLayoutColumns ?? null} currentHeight={activeRoom.paneLayoutHeight ?? 1}
        emptySlots={activeRoomEmptySlotsMetrics ?? undefined} error={paneLayoutError}
        maximumColumns={shellMode === "mobile" ? 1 : shellMode === "tablet" ? 2 : 4}
        onClose={onBack} onSelect={columns => void applyPaneLayoutPreset(columns, undefined, true)}
        onSelectHeight={height => void applyPaneLayoutPreset(undefined, height, true)} pending={paneLayoutPending}
        triggerRef={triggerRef} visiblePaneCount={effectiveLayoutPaneCount} />;
    } else if (id === "pane-span-all") {
      content = <LazyPaneSpanAllMenu activeColumnCount={paneGridColumnCount}
        currentSpan={commonPaneColumnSpan(visiblePanes)} error={paneSpanAllError} onClose={onBack}
        onSelect={span => void applyPaneSpanToAll(span)} pending={paneSpanAllPending} triggerRef={triggerRef}
        visiblePaneCount={visiblePanes.length} />;
    } else if (id === "rename-room" && activeRoom) {
      content = <form className="workspace-room-rename" onSubmit={event => void submitRoomRename(event, onBack)} aria-busy={roomRenamePending}>
        <label>Room name<input aria-label="Room name" value={roomNameDraft} disabled={roomRenamePending}
          onChange={event => setRoomNameDraft(event.target.value)} required /></label>
        {roomRenameError ? <p role="alert">{roomRenameError}</p> : null}
        <button type="submit" disabled={roomRenamePending}>Save room name</button>
      </form>;
    } else if (id === "font-down") {
      content = <div className="workspace-text-size-page"><p>Text size across your workspace</p>
        <WorkspaceTextSizePicker anchorRef={triggerRef} open value={terminalFontSize} onChange={setTerminalFontSize} onClose={onBack} />
        <p className="workspace-text-preview" style={{ fontSize: terminalFontSize }}>The quick brown fox jumps over the lazy dog. 0123456789</p></div>;
    } else if (id === "theme") {
      content = <RoomThemeMenu currentTheme={roomTheme} mobile={false} onClose={onBack} onSelect={setRoomTheme} triggerRef={triggerRef} />;
    } else if (["server-restart", "setup-connections", "system-services"].includes(id)) {
      content = <LazyServerActionsMenu actions={serverActionCommands} mobile={false} onClose={onBack} triggerRef={triggerRef}
        initialAction={id === "server-restart" ? null : id} renderAction={(actionId, back, navigate) => renderWorkspaceManageAction(actionId, back, navigate, true)}
        renderGroupIntro={renderManageGroupIntro} />;
    } else if (["space-cli-maintenance", "cli-update-all", "publish-space-release", "codex-lb-speed-control", "cli-session-cleanup", "codex-history-purge", "user-management"].includes(id)) {
      content = renderWorkspaceManageAction(id, onBack, onNavigate, true);
    } else if (id === "space-gateway") {
      content = <LazySpaceGatewayDialog embedded onClose={onBack} />;
    } else if (id === "memory-workspace") {
      content = <MemoryWorkspaceErrorBoundary onClose={onBack}><LazyMemoryWorkspace shellMode={shellMode}
        activeRoomId={activeRoom?.id ?? null} onClose={onBack} /></MemoryWorkspaceErrorBoundary>;
    } else if (id === "system-analytics" || id === "token-usage") {
      content = <LazySystemAnalyticsWorkspace shellMode={shellMode} initialTab={id === "token-usage" ? "models" : "overview"} onClose={onBack} />;
    } else if (id === "help") {
      content = <LazyHelpPage onBack={onBack} />;
    } else if (id === "benchmark") {
      content = <LazyBenchmarkPage onBack={onBack} />;
    } else if (id === "room-toolbar") {
      content = <div className="workspace-rail-settings" role="group" aria-label="Room toolbar icons">
        {DEFAULT_LOWER_RAIL_ITEMS.map(item => (
          <SpaceToggle
            key={item.id}
            name={`rail-item-${item.id}`}
            label={item.label}
            checked={lowerRailVisibility.isVisible(item.id)}
            disabled={item.hideable === false}
            onChange={(checked) => checked ? lowerRailVisibility.show(item.id) : lowerRailVisibility.hide(item.id)}
          />
        ))}
      </div>;
    } else if (id === "desktop-displays") {
      content = <DesktopDisplayControls activeRoomId={activeRoom?.id} activePaneId={activePane?.id} />;
    } else if (id === "demo-mode") {
      content = <LazyDemoModeOverlay isOpen onClose={onBack} onActionPreview={onNavigate} />;
    } else if (id === "link-preview" && workspaceUserLink) {
      content = <LazyEmbeddedDashboardDialog link={workspaceUserLink} onClose={() => { setWorkspaceUserLink(null); onBack(); }} />;
    } else if (id === "quick-links") {
      content = renderSideSurfaceContent("links", onBack, onNavigate);
    } else if (id === "sticky-note") {
      content = <StickyNoteWindow key={workspaceStickyItem?.id ?? "new"} id="workspace-sticky-note"
        initialText={workspaceStickyItem?.text} itemId={workspaceStickyItem?.id}
        onClose={() => { setWorkspaceStickyItem(null); onBack(); }} />;
    } else if (id === "clip-tool" || id === "snip-tool") {
      content = <LazySnipToolOverlay isOpen onClose={onBack} roomId={activeRoom?.id} isMobile={shellMode === "mobile"}
        activePaneId={activePane && !activePane.isMinimized ? activePane.id : null}
        activePaneTitle={activePane ? displayPaneTitle(activePane) : null}
        activePaneMode={activePane?.mode ?? null}
        activePaneName={activePane?.paneName ?? null}
        availablePanes={targetablePanes.map(p => ({
          id: p.id,
          title: displayPaneTitle(p),
          mode: p.mode,
          paneName: p.paneName ?? null
        }))} onCapture={handleSnipCapture} />;
    } else if (id === "agents-dashboard") {
      content = <LazyAgentsDashboard userId={auth?.user?.id} open rooms={rooms} completions={paneCompletionLifecycle.panes}
        activePanes={panes} onOpenPane={paneCardOnOpenExisting} onClose={onBack}
        currentRoomId={activeRoom?.id ?? selectedRoomId ?? null} selectedPaneId={selectedPaneId} />;
    } else if (id === "add-chat") {
      content = <LazyChatLauncherMenu mobile={false} onClose={onBack} onSelectChat={() => void addPane("CHAT")}
        onSelectHarness={() => void addHarnessPane()} onSelectLive={() => void addLivePane()} triggerRef={triggerRef}
        chatDisabled={!isCodexEnabled || panes.length >= 16} harnessDisabled={panes.length >= 16}
        chatHidden={isPaneHidden("chat")}
        harnessHidden={!isHarnessEnabled || isPaneHidden("harness")}
        liveDisabled={isPaneHidden("live") || panes.length >= 16}
        liveHidden={isPaneHidden("live")} />;
    } else if (id === "add-cli" || id === "create") {
      content = <LazyCliLauncherMenu embedded query="" mobile={false} refreshOnOpen atPaneCap={panes.length >= 16}
        availablePanes={Math.max(0, 16 - panes.length)}
        isCodexEnabled={isCodexEnabled} onClose={onBack} onCreate={addCliRuntimePane} onLogin={openCliRuntimeLogin}
        onOpenSettings={() => onNavigate("surface-settings")} triggerRef={triggerRef} />;
    }
    return <RecoverableSurface resetKey={id} fallback={sideSurfaceLoadingFallback}>{content}</RecoverableSurface>;
  }

  function toggleAdminMode() {
    setAdminModeRequested(!isAdminMode);
    setIsServerActionsMenuOpen(false);
    if (isAdminMode && ["health", "streaming"].includes(activeSideSurface)) setIsDesktopSideSurfaceOpen(false);
  }

  const workspaceNavigation: WorkspaceNavigationBinding = {
    desktopToolbarActions,
    roomToolbarActions,
    workspaceNavigationActions,
    workspaceDetailActionIds,
    isAdminMode,
    canAdmin: auth?.user?.role === "ADMIN",
    onModeChange: toggleAdminMode,
    runDesktopAction,
    renderDesktopCreateTools,
    renderWorkspaceAction,
    setWorkspaceNavigationDetail,
    availablePanes: Math.max(0, 16 - panes.length),
    emptySlots: activeRoomEmptySlotsMetrics ?? undefined
  };

  return (
    <AppIconProvider pack={modernIconPack}>
      <LiveSessionProvider ownerId={startupReady ? auth.user?.id || "" : ""} roomId={selectedRoomId || activeRoom?.id || null} roomName={activeRoom?.name}>
      {vibeMusicPlayer}
      {oskKeyboard}
      {stickyNoteLayer}
      {desktopWidgetsLayer}
      {snipToolOverlay}
      <StreamingOverlayProvider active={auth.user?.role === "ADMIN"}>
      {manage.setupConnectionsMounted.current ? (
        <RecoverableSurface
          fallback={(
            <div className="setup-connections-backdrop" role="status">
              Loading setup &amp; connections…
            </div>
          )}
        >
          <LazySetupConnectionsWizard
            guided={!setupFromWorkspace.current}
            embedded={Boolean(workspaceSetupHost)}
            portalTarget={workspaceSetupHost}
            connectionsContent={setupConnectionsContent}
            checks={api}
            open={isSetupConnectionsOpen || Boolean(workspaceSetupHost)}
            finish={api.finishSetup}
            loadOverview={api.setupOverview}
            onOpenChange={open => {
              if (!open && workspaceSetupHost) workspaceSetupBack.current?.();
              setIsSetupConnectionsOpen(open);
            }}
            openLogin={openSetupConnectionLogin}
            onOpenMaintenance={() => {
              workspaceSetupBack.current?.();
              setIsSetupConnectionsOpen(false);
              adminOperationToolTriggerRef.current = serverActionsButtonRef.current;
              openManage("space-cli-maintenance");
            }}
            triggerRef={serverActionsButtonRef}
          />
        </RecoverableSurface>
      ) : null}
      <AppDiagnosticsGlobalIndicators />
      <SensitiveDataMask enabled={maskSensitiveData} />
      <LiveRailSession />
      <main
      className={shellClassName}
      data-room-theme={roomTheme}
      data-sensitive-mode={maskSensitiveData ? "hidden" : undefined}
      data-ui-theme={uiTheme !== "classic" ? "modern" : undefined}
      data-interface-theme={uiTheme}
      data-color-mode={uiTheme !== "classic" ? modernColorMode : undefined}
      data-icon-pack={modernIconPack}
      data-room-id={activeRoom?.id}
      data-shell-mode={shellMode}
      data-interface-mode={isAdminMode ? "admin" : "user"}
      data-warm-room-cache-enabled={String(warmRoomEnabled)}
      data-suppress-notifications={String(suppressNotifications)}
      data-warm-room-safe-capacity={warmRoomLimitsForDevice.maxRooms}
      data-warm-room-hard-capacity={warmRoomLimitsForDevice.maxRooms}
      data-warm-room-count={warmRoomIds.length}
      data-warm-room-connected-panes={warmConnectedPaneTotal}
      data-warm-room-memory-source="fixed"
      data-warm-room-pressure="false"
      data-warm-room-overcommit="false"
      data-cli-floats-hidden={cliFloatsHidden ? "true" : "false"}
      data-workspace-rail={showResourceIndicatorRail || isRoomToolbarHidden ? "true" : undefined}
      data-room-toolbar-hidden={isRoomToolbarHidden ? "true" : undefined}
      data-browser-fullscreen={isBrowserFullscreen ? "true" : undefined}
    >
      <DesktopWindowTitlebar
        activeRoomName={activeRoom?.name}
        activeRoomId={activeRoom?.id}
        activePaneId={activePane?.id}
        isFullscreen={isBrowserFullscreen}
      />
      {uiTheme === "liquid-glass" ? <LiquidGlassLens /> : null}
      {!selectedRoomId && shellMode !== "desktop" && !isRoomFocusMode ? <header className="topbar">
        <div className="brand">
          <SpaceBrand />
          <div>
            <h1>
              <a
                className="brand-site-link"
                href="https://spaceapp.dev"
                target="_blank"
                rel="noopener noreferrer"
              >
                SpaceApp.dev
              </a>
            </h1>
            <span>Space agent room control plane</span>
          </div>
        </div>
        <div className="topbar-summary">
          <span>{presentationRoom?.name ?? "No room selected"}</span>
          <small>{presentationActivePane ? `Target ${displayPaneTitle(presentationActivePane)}` : "No pane target"}</small>
        </div>
        {runtimeKind === "demo" ? <DemoVersionMeta /> : <AppVersionMeta />}
      </header> : null}

      <input
        ref={clipImageInputRef}
        type="file"
        name="clip-tool-image"
        accept="image/png,image/jpeg,image/webp"
        hidden
        onChange={(event) => {
          const file = event.currentTarget.files?.[0] ?? null;
          event.currentTarget.value = "";
          handleClipImageSelection(file);
        }}
      />
      <AppNoticeBanners
        notices={notices}
        actionError={error}
        onDismissActionError={() => setError(null)}
        vpnCityNotice={vpnCityNotice}
        vpnCityNoticeRef={vpnCityNoticeRef}
        onDismissVpnCityNotice={() => setVpnCityNotice(null)}
        isRoomFocusMode={isRoomFocusMode}
        isDemoRuntime={runtimeKind === "demo"}
      />

      {auth?.user?.role === "ADMIN" && manage.adminCodexTool ? (
        <RecoverableSurface fallback={<div role="status">Loading Codex tools…</div>}>
          <LazyAdminCodexToolsDialog
            initialTool={manage.adminCodexTool}
            isCodexEnabled={isCodexEnabled}
            anyCliEnabled={anyCliEnabled}
            onClose={manage.closeAdminCodexTool}
          />
        </RecoverableSurface>
      ) : null}

      {auth?.user?.role === "ADMIN" && manage.adminOperationTool ? (
        <RecoverableSurface fallback={<div role="status">Loading admin operation…</div>}>
          <LazyAdminOperationsDialog initialTool={manage.adminOperationTool} onClose={manage.closeAdminOperationTool} />
        </RecoverableSurface>
      ) : null}
      {copilotLaunch ? (
        <RecoverableSurface fallback={<div role="status">Loading {copilotLaunch.kind.label}…</div>}>
          <LazyCopilotLaunchDialog kind={copilotLaunch.kind} preselect={copilotLaunch.preselect} notice={copilotLaunch.notice} onClose={() => setCopilotLaunch(null)} onCreate={createCopilotPanes} />
        </RecoverableSurface>
      ) : null}

      {auth?.user?.role === "ADMIN" && manage.isSystemServicesDialogOpen ? (
        <RecoverableSurface fallback={<div role="status">Loading system services…</div>}>
          <LazySystemServicesDialog onClose={manage.closeSystemServicesDialog} />
        </RecoverableSurface>
      ) : null}

      {auth?.user?.role === "ADMIN" && manage.isUserManagementOpen ? (
        <RecoverableSurface fallback={<div role="status">Loading user management…</div>}>
          <LazyUserManagementDialog
            currentUserId={auth.user?.id}
            onClose={manage.closeUserManagement}
          />
        </RecoverableSurface>
      ) : null}

      {auth?.user?.role === "ADMIN" && isDemoModeActive ? (
        <RecoverableSurface fallback={<div role="status">Loading demo mode…</div>}>
          <LazyDemoModeOverlay
            isOpen={isDemoModeActive}
            onClose={() => setIsDemoModeActive(false)}
            onActionPreview={(actionId) => {
              if (actionId === "surface-rooms" || actionId.startsWith("surface-")) {
                const surface = actionId.replace("surface-", "") as SideSurface;
                toggleSideSurface(surface);
              } else if (actionId === "memory-workspace") {
                setIsSpaceGatewayOpen(false);
                setIsMemoryWorkspaceOpen(true);
              } else if (actionId === "space-gateway") {
                setIsMemoryWorkspaceOpen(false);
                setIsSpaceGatewayOpen(true);
              } else if (actionId === "system-resources") {
                openSystemResources();
              } else if (actionId === "benchmark") {
                openBenchmark();
              } else if (actionId === "vibe-music") {
                setIsVibeMusicOpen(true);
              }
            }}
          />
        </RecoverableSurface>
      ) : null}

      {auth?.user?.role === "ADMIN" && (isServerActionsMenuOpen || manageLoginPending) ? (
        <RecoverableSurface fallback={toolbarMenuLoadingFallback}>
          <LazyServerActionsMenu
            actions={serverActionCommands}
            suspended={!isServerActionsMenuOpen}
            initialAction={manage.manageInitialAction}
            renderAction={renderWorkspaceManageAction}
            renderGroupIntro={renderManageGroupIntro}
            mobile={shellMode === "mobile"}
            onClose={() => setIsServerActionsMenuOpen(false)}
            triggerRef={serverActionsButtonRef}
          />
        </RecoverableSurface>
      ) : null}

      {manage.serverRestart.isOpen ? <ServerRestartDialog controller={manage.serverRestart} /> : null}

      {manage.cliRuntimeRestartAll.isOpen ? <CliRuntimeRestartAllDialog controller={manage.cliRuntimeRestartAll} /> : null}
      {gatewayCompression.dialog}

      {auth.user?.role === "ADMIN" && (isRoomToolbarHidden || isMemoryWorkspaceOpen || isSpaceGatewayOpen || systemAnalyticsTab || !presentationRoom) ? renderToolbarMetrics(true) : null}
      {auth.user?.role === "ADMIN" ? (
        <RecoverableSurface fallback={isAgentsDashboardOpen ? <div role="status">Loading agents dashboard…</div> : null}>
          <LazyAgentsDashboard key={auth.user.id} userId={auth.user.id} open={isAgentsDashboardOpen} rooms={rooms} completions={paneCompletionLifecycle.panes}
            activePanes={panes} onSummaryChange={setAgentsDashboardSummary}
            onOpenPane={paneCardOnOpenExisting} onClose={() => setIsAgentsDashboardOpen(false)}
            currentRoomId={activeRoom?.id ?? selectedRoomId ?? null} selectedPaneId={selectedPaneId} />
        </RecoverableSurface>
      ) : null}
      {auth.user && <SystemHealth key={auth.user.id} userId={auth.user.id} allowChanges={shellMode !== "desktop" || isAdminMode}
        onOpenAgentsDashboard={() => setIsAgentsDashboardOpen(true)}
        agentsSummary={agentsDashboardSummary}
        railVisible={showResourceIndicatorRail}
        indicatorsVisible={resourceIndicatorsVisible}
        environment={codexEnvironmentSummary}
        readOnly={auth.user.role !== "ADMIN"}
        minimizedBarToggle={auth.user.role === "ADMIN" && showMinimizedBarToggle && isRoomToolbarHidden ? (
          <MinimizedPaneBarToggle
            count={minimizedCount}
            runningCount={minimizedPaneRunningCount}
            expanded={showMinimizedBar}
            onToggle={() => setMinimizedBarExpanded((value) => !value)}
          />
        ) : undefined}
        onManage={auth.user.role === "ADMIN" ? (panel) => openSystemHealth(panel === "accounts" ? "ai" : panel === "cli" ? "sessions" : "provider") : undefined}
        onReopenPane={auth.user.role === "ADMIN" ? reopenPane : undefined}
        onReopenAllDetached={auth.user.role === "ADMIN" ? reopenAllDetachedPanes : undefined}
        onCloseSession={auth.user.role === "ADMIN" ? closeDetachedPane : undefined} />}

      {!isRoomToolbarHidden || showOverlaySideSurface || systemAnalyticsTab ? null : (
        <CollapsedRoomRail
          popovers={toolbarPopovers}
          railVisibility={roomRailVisibility(lowerRailVisibility, presentationRoom)}
          touchContext={lowerRailTouchContext}
          navigation={workspaceNavigation}
          roomNavigation={{ previousRoom, nextRoom, selectRoom }}
          docks={sideSurfaces}
          liveRail={liveRail}
          onActivateLive={activateLiveFromRail}
          liveDisabled={!selectedRoomId && !activeRoom && rooms.length === 0}
          hasActiveRoom={Boolean(activeRoom)}
          paneLayoutPending={paneLayoutPending}
          stickyWindowCount={stickyWindows.length}
          openStickyNote={openStickyNote}
          snip={snipTool}
          isBrowserFullscreen={isBrowserFullscreen}
          minimized={{
            showInRail: showMinimizedBarToggle && auth?.user?.role !== "ADMIN",
            count: minimizedCount,
            runningCount: minimizedPaneRunningCount,
            expanded: showMinimizedBar,
            onToggle: () => setMinimizedBarExpanded((value) => !value)
          }}
          onShowToolbar={() => updateRoomToolbarVisibility(false)}
          paneMenus={(
            <>
          {isCollapsedPaneLayoutMenuOpen && activeRoom ? (
            <RecoverableSurface fallback={toolbarMenuLoadingFallback}>
              <LazyPaneLayoutMenu
                automaticColumns={layoutAutomaticPaneGridColumnCount}
                currentColumns={activeRoom.paneLayoutColumns ?? null}
                currentHeight={activeRoom.paneLayoutHeight ?? 1}
                error={paneLayoutError}
                maximumColumns={shellMode === "mobile" ? 1 : shellMode === "tablet" ? 2 : 4}
                menuId="pane-layout-presets-collapsed"
                onClose={() => setIsCollapsedPaneLayoutMenuOpen(false)}
                onSelect={(paneLayoutColumns) => void applyPaneLayoutPreset(paneLayoutColumns)}
                onSelectHeight={(paneLayoutHeight) => void applyPaneLayoutPreset(undefined, paneLayoutHeight, true)}
                pending={paneLayoutPending}
                triggerRef={paneLayoutCollapsedButtonRef}
                visiblePaneCount={effectiveLayoutPaneCount}
                emptySlots={activeRoomEmptySlotsMetrics ?? undefined}
              />
            </RecoverableSurface>
          ) : null}
          {isPaneSpanAllMenuOpen && activeRoom ? (
            <RecoverableSurface fallback={toolbarMenuLoadingFallback}>
              <LazyPaneSpanAllMenu
                activeColumnCount={paneGridColumnCount}
                currentSpan={commonPaneColumnSpan(visiblePanes)}
                error={paneSpanAllError}
                onClose={() => setIsPaneSpanAllMenuOpen(false)}
                onSelect={(columnSpan) => void applyPaneSpanToAll(columnSpan)}
                pending={paneSpanAllPending}
                triggerRef={paneSpanAllButtonRef}
                visiblePaneCount={visiblePanes.length}
              />
            </RecoverableSurface>
          ) : null}
          <WorkspaceTextSizePicker
            anchorRef={workspaceTextSizeButtonRef}
            open={isWorkspaceTextSizePickerOpen}
            value={terminalFontSize}
            onChange={setTerminalFontSize}
            onClose={() => setIsWorkspaceTextSizePickerOpen(false)}
          />
            </>
          )}
        />
      )}

      <div className="workspace-stage">
      <section className={workspaceClassName}
        inert={isMemoryWorkspaceOpen || isSpaceGatewayOpen || undefined}
        aria-hidden={isMemoryWorkspaceOpen || isSpaceGatewayOpen || undefined}>
        <InlineSideSurface sideSurfaces={sideSurfaces} launcherActions={roomToolbar.orderedActions} renderSurface={renderSideSurfaceContent} fallback={sideSurfaceLoadingFallback} />
        <CompactSideSurfaceDrawer sideSurfaces={sideSurfaces} launcherActions={roomToolbar.orderedActions} renderSurface={renderSideSurfaceContent} fallback={sideSurfaceLoadingFallback} />

        <section className={boardClassName} aria-label="Pane board">
          {!isRoomToolbarHidden ? (
            <div
              ref={boardToolbarRef}
              className="board-toolbar"
              data-room-actions-stacked={isRoomToolbarStacked ? "true" : undefined}
              data-presentation-state={preparingRoomId ? "held" : "displayed"}
              aria-disabled={preparingRoomId ? "true" : undefined}
              inert={preparingRoomId ? true : undefined}
            >
            <RoomTitleBar
              room={presentationRoom}
              rename={roomRename}
              shellMode={shellMode}
              docks={sideSurfaces}
              onMinimizeAllPanes={() => void minimizeAllPanes()}
              onOpenProjectFiles={async (room, effectiveProj) => {
                const existingFilesPane = panes.find((p) => !p.isClosed && p.mode === "FILES");
                if (existingFilesPane) {
                  setSelectedPaneId(existingFilesPane.id);
                  window.dispatchEvent(new CustomEvent("space:files:navigate", { detail: { path: effectiveProj } }));
                } else {
                  await addFilesPane(1, room.id);
                }
              }}
              canNavigateRooms={userNavigableRooms.length > 1}
              previousRoom={previousRoom}
              nextRoom={nextRoom}
              selectRoom={selectRoom}
              paneMoveNotice={paneMoveNotice}
              setPaneMoveNotice={setPaneMoveNotice}
            />
            <div
              id="toolbar-docked-widgets"
              className="toolbar-docked-widgets"
              role="region"
              aria-label="Docked toolbar widgets"
            />
            <RoomToolbarActions
              popovers={toolbarPopovers}
              touchContext={roomToolbarTouchContext}
              roomToolbar={roomToolbar}
              availableRoomActions={availableRoomActions}
              navigation={workspaceNavigation}
              hiddenRailIds={lowerRailVisibility.hiddenIds}
              footer={runtimeKind === "demo" ? <DemoVersionMeta /> : <AppVersionMeta />}
              metrics={presentationRoom ? renderToolbarMetrics() : null}
              shellMode={shellMode}
              uiTheme={uiTheme}
              environment={codexEnvironmentSummary}
              minimizedBar={minimizedPaneBar}
              preferences={userPreferences}
              onHideToolbar={() => updateRoomToolbarVisibility(true)}
              menus={
                <>
                  {shellMode !== "mobile" && isPaneLayoutMenuOpen && activeRoom ? (
                    <RecoverableSurface fallback={toolbarMenuLoadingFallback}>
                      <LazyPaneLayoutMenu
                        automaticColumns={layoutAutomaticPaneGridColumnCount}
                        currentColumns={activeRoom.paneLayoutColumns ?? null}
                        currentHeight={activeRoom.paneLayoutHeight ?? 1}
                        error={paneLayoutError}
                        maximumColumns={shellMode === "tablet" ? 2 : 4}
                        onClose={() => setIsPaneLayoutMenuOpen(false)}
                        onSelect={(paneLayoutColumns) => void applyPaneLayoutPreset(paneLayoutColumns)}
                        onSelectHeight={(paneLayoutHeight) => void applyPaneLayoutPreset(undefined, paneLayoutHeight, true)}
                        pending={paneLayoutPending}
                        triggerRef={paneLayoutButtonRef}
                        visiblePaneCount={effectiveLayoutPaneCount}
                        emptySlots={activeRoomEmptySlotsMetrics ?? undefined}
                      />
                    </RecoverableSurface>
                  ) : null}
                  {isPaneSpanAllMenuOpen && activeRoom ? (
                    <RecoverableSurface fallback={toolbarMenuLoadingFallback}>
                      <LazyPaneSpanAllMenu
                        activeColumnCount={paneGridColumnCount}
                        currentSpan={commonPaneColumnSpan(visiblePanes)}
                        error={paneSpanAllError}
                        onClose={() => setIsPaneSpanAllMenuOpen(false)}
                        onSelect={(columnSpan) => void applyPaneSpanToAll(columnSpan)}
                        pending={paneSpanAllPending}
                        triggerRef={paneSpanAllButtonRef}
                        visiblePaneCount={visiblePanes.length}
                      />
                    </RecoverableSurface>
                  ) : null}
                  {isCliLauncherOpen ? (
                    <RecoverableSurface fallback={toolbarMenuLoadingFallback}>
                      <LazyCliLauncherMenu
                        refreshOnOpen={true}
                        atPaneCap={panes.length >= 16}
                        availablePanes={Math.max(0, 16 - panes.length)}
                        isCodexEnabled={isCodexEnabled}
                        mobile={shellMode === "mobile"}
                        onClose={() => setIsCliLauncherOpen(false)}
                        onCreate={addCliRuntimePane}
                        onLogin={openCliRuntimeLogin}
                        onOpenSettings={openSettingsSurface}
                        triggerRef={cliLauncherReturnFocusRef}
                      />
                    </RecoverableSurface>
                  ) : null}
                  {isChatLauncherOpen ? (
                    <RecoverableSurface fallback={toolbarMenuLoadingFallback}>
                      <LazyChatLauncherMenu
                        mobile={shellMode === "mobile"}
                        onClose={closeChatLauncher}
                        onSelectChat={() => void addPane("CHAT")}
                        onSelectHarness={() => void addHarnessPane()}
                        onSelectLive={() => void addLivePane()}
                        triggerRef={chatLauncherButtonRef}
                        chatDisabled={!isCodexEnabled || panes.length >= 16}
                        chatHidden={isPaneHidden("chat")}
                        harnessDisabled={panes.length >= 16}
                        harnessHidden={!isHarnessEnabled || isPaneHidden("harness")}
                        liveDisabled={isPaneHidden("live") || panes.length >= 16}
                        liveHidden={isPaneHidden("live")}
                      />
                    </RecoverableSurface>
                  ) : null}
                </>
              }
            />
            </div>
          ) : null}
          {showPaneNavigation ? (
            <div className="pane-navigation">
              {showMinimizedBar ? (
                <MinimizedPaneBar
                  bar={minimizedPaneBar}
                  visiblePaneCount={visiblePanes.length}
                  paneCompletionLifecycle={paneCompletionLifecycle}
                  turns={turns}
                  restoreRefs={minimizedPaneRestoreRefs}
                  restorePane={restorePane}
                  minimizeAllPanes={minimizeAllPanes}
                  restoreAllPanes={restoreAllPanes}
                  minimizeAllPending={minimizeAllPending}
                  restoreAllPending={restoreAllPending}
                />
              ) : null}
            </div>
          ) : null}

          <div
            className="room-runtime-stack"
            data-ui-background={uiBackground}
            data-has-empty-state={roomRuntimeStackHasEmptyState ? "true" : "false"}
            aria-busy={preparingRoomId ? "true" : "false"}
            data-presentation-generation={roomPresentationGenerationRef.current}
          >
            {mountedRoomRuntimeIds.map((roomId) => renderRoomRuntimeLayer(roomId))}
            {canPlayAsteroids({ selectedRoomId, displayedRoomId, preparingRoomId,
              loaded: Boolean(selectedRoomId && roomPaneLoadStates[selectedRoomId] === "loaded"),
              category: selectedRoomId ? activeCategoryColorByRoom[selectedRoomId] ?? null : null, panes }) ? (
                <AsteroidsGate key={selectedRoomId} />
              ) : null}
          </div>
          {shellMode === "mobile" ? <MobilePaneSwitcher panes={sortPanesForGrid(visiblePanes)} activePaneId={activePane?.id} onSelect={selectMobilePane} /> : null}
        </section>
        {paneMoveDialog ? (
          <MovePaneDialog
            paneTitle={displayPaneTitle(paneMoveDialog.pane)}
            targetRooms={rooms.filter((room) => room.id !== paneMoveDialog.pane.roomId)}
            targetRoomId={paneMoveDialog.targetRoomId}
            pending={paneMoveDialog.pending}
            error={paneMoveDialog.error}
            onTargetRoomChange={(targetRoomId) =>
              setPaneMoveDialog((current) => (current ? { ...current, targetRoomId, error: null } : current))
            }
            onClose={closeMovePaneDialog}
            onConfirm={() => void submitPaneMove()}
          />
        ) : null}

      </section>
      {isMemoryWorkspaceOpen ? <div className="workspace-cover">
        <MemoryWorkspaceErrorBoundary onClose={() => setIsMemoryWorkspaceOpen(false)}>
          <RecoverableSurface fallback={<div className="memory-workspace-loading" role="status">Loading memory workspace…</div>}>
            <LazyMemoryWorkspace
              shellMode={shellMode}
              activeRoomId={activeRoom?.id ?? null}
              onClose={() => setIsMemoryWorkspaceOpen(false)}
            />
          </RecoverableSurface>
        </MemoryWorkspaceErrorBoundary>
      </div> : null}
      {isSpaceGatewayOpen && auth.user?.role === "ADMIN" ? <div className="workspace-cover">
        <RecoverableSurface fallback={<div className="memory-workspace-loading" role="status">Loading Space Gateway…</div>}>
          <LazySpaceGatewayDialog fullscreen onClose={() => setIsSpaceGatewayOpen(false)} />
        </RecoverableSurface>
      </div> : null}
      </div>
      <QuickLinksPopover open={isQuickLinksOpen} triggerRef={quickLinksButtonRef} onClose={() => setIsQuickLinksOpen(false)} onOpen={openUserLink} onManage={manageLinks} />
      {activeUserLink && !workspaceNavigationDetail ? (
        <RecoverableSurface fallback={<div role="status">Loading dashboard…</div>}>
          <LazyEmbeddedDashboardDialog link={activeUserLink} onClose={() => setActiveUserLink(null)} />
        </RecoverableSurface>
      ) : null}
      <LiveDebugToastView notices={notices} />
      <NotificationToastHost />{nousFocus}
      </main>
      <StreamingOverlay theme={uiTheme !== "classic" ? "modern" : "classic"} />
      </StreamingOverlayProvider>
      </LiveSessionProvider>
    </AppIconProvider>
  );
}

function mergeSpaceEvents(current: SpaceEvent[], incoming: SpaceEvent | SpaceEvent[]): SpaceEvent[] {
  const next = new Map<string, SpaceEvent>();
  for (const event of current) {
    next.set(event.id, event);
  }
  for (const event of Array.isArray(incoming) ? incoming : [incoming]) {
    next.set(event.id, event);
  }
  return [...next.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, roomEventLimit);
}

