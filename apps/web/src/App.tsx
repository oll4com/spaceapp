import {
  AppIconProvider,
  Activity,
  ALargeSmall,
  ArrowRightLeft,
  Bookmark,
  Bot,
  Boxes,
  Camera,
  ChevronLeft,
  ChevronRight,
  CheckCircle2,
  Chrome,
  CircleHelp,
  CircleStop,
  Clipboard,
  Columns3,
  Copy,
  Crosshair,
  Database,
  Eye,
  EyeOff,
  FileInput,
  FolderOpen,
  FolderPlus,
  Gauge,
  GitCompare,
  Grid2X2,
  GripVertical,
  HardDrive,
  History,
  Images,
  Keyboard,
  Link as LinkIcon,
  ListTodo,
  Loader2,
  Lock,
  LogOut,
  Maximize2,
  MessageSquare,
  Mic,
  Minimize2,
  Minus,
  MoreHorizontal,
  MoveHorizontal,
  Music2,
  Network,
  Paperclip,
  Palette,
  PanelRight,
  PanelsTopLeft,
  PanelTopOpen,
  Pencil,
  Plus,
  Printer,
  Radio,
  RefreshCw,
  Rocket,
  Save,
  Send,
  Search,
  ServerCog,
  Settings2,
  Bell,
  ShieldCheck,
  Sparkles,
  Star,
  Shrink,
  Terminal,
  Trash2,
  Upload,
  Undo2,
  UserCheck,
  Wrench,
  X,
  Youtube
} from "./features/ui-theme/app-icons.js";
import type { LucideIcon } from "./features/ui-theme/app-icons.js";
import { SensitiveDataMask } from "./features/sensitive-data/SensitiveDataMask.js";
import { SpaceToggle } from "./features/ui-controls/SpaceToggle.js";
import type { AgentPaneIdentity } from "./features/agent-pane/AgentPane.js";
import { lazy, memo, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent as ReactDragEvent, type FormEvent, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { useAutoDismiss } from "./use-auto-dismiss.js";
import type {
  Artifact,
  AgentPaneSession,
  AgentRuntime,
  AuditEvent,
  AuthMe,
  BrowserEvidenceViewport,
  ClipboardItem,
  CliTaskHistoryItem,
  CliVpnRoutingStatus,
  CodexEnvironment,
  CodexHistoryItem,
  CodexAppServerHandshakeCheck,
  CodexAppServerStatus,
  CodexAppServerTurnSmokeCheck,
  TaskItem,
  CreateProviderInput,
  CreateRoomPanesRequest,
  Event as SpaceEvent,
  ImportCandidate,
  ImportSourceKind,
  ImportTargetKind,
  LaunchReadiness,
  McpDiscoverySmokeCheck,
  McpToolExecutionResult,
  MemoryEmbeddingSmokeCheck,
  MemoryEntry,
  MemorySearchMode,
  MemorySearchStatus,
  MemoryVectorReadiness,
  Model,
  ObservabilitySnapshot,
  Pane,
  PaneCliSessionResponse,
  PaneCapabilityMatrix,
  Provider,
  ProviderSettings,
  ProviderValidationResult,
  ReviewCheck,
  ReviewDecision,
  ReviewDiffSummary,
  ReviewRoomState,
  Room,
  SetupClaimInput,
  SetupStatus,
  Skill,
  StorageReadiness,
  SwarmLock,
  SwarmReconcileDecision,
  SwarmState,
  SwarmTask,
  SwarmTaskRole,
  SwarmTaskStatus,
  Turn,
  UpdateProviderInput,
  UpdateProviderSettingsInput,
  WorkerReadiness,
  UserLink,
  CliRuntimeSettingsResponse,
  AgentSessionHistoryItem
} from "@space/contracts";
import { paneCategoryColors, type PaneCategoryColor } from "@space/contracts";
import { SpaceApiError, api, type McpPayload, type ReadyzPayload } from "./api.js";
import {
  acknowledgePaneCompletion,
  applyPaneCompletionEvents,
  createPaneCompletionLifecycleState,
  hydratePaneCompletionRoom,
  hydratePaneCompletionReplay,
  pendingPaneCompletionEventId,
  type PaneCompletionLifecycleState
} from "./pane-completion-lifecycle.js";
import {
  PANE_RUN_LIFECYCLE_EVENT,
  type PaneRunLifecycleDetail
} from "./pane-run-lifecycle-events.js";
import { nextGeneratedRoomName } from "./room-naming.js";
import {
  cliRuntimeLabel,
  cliRuntimePresentation,
  isCliRuntimeTerminalLaunchable
} from "./cli-runtime-presentation.js";
import {
  CLI_RUNTIME_VISIBILITY_EVENT,
  dispatchCliRuntimeVisibilityChange
} from "./cli-runtime-visibility-events.js";
import {
  CLI_VPN_ROUTING_STATUS_EVENT,
  loadCliVpnRoutingStatus,
  paneVpnRoutingPresentation,
  publishCliVpnRoutingStatus
} from "./cli-vpn-routing.js";
import {
  CLI_RECOVERY_OPENED_EVENT,
  parseCliRecoveryOpenedDetail
} from "./cli-recovery-events.js";
import { GlobalApiErrorAlert, reportCoreApiFailure, reportCoreApiSuccess } from "./core-api-availability.js";
import { DEMO_LOCAL_REPLY, eventGateway, getSpaceRuntime, getSpaceRuntimeKind } from "./runtime/SpaceRuntime.js";
import { dispatchArtifactsUpdated } from "./artifact-events.js";
import { SpaceBrand } from "./SpaceBrand.js";
import {
  CLI_IMAGE_PREVIEW_LIMIT_STORAGE_KEY,
  MAX_CLI_IMAGE_PREVIEW_LIMIT,
  MIN_CLI_IMAGE_PREVIEW_LIMIT,
  normalizeCliImagePreviewLimit,
  readStoredCliImagePreviewLimit
} from "./cli-upload-settings.js";
import {
  dispatchAgentPaneActionEvent,
  dispatchAgentPaneAttachmentsEvent
} from "./features/agent-pane/events.js";
import {
  AdminCodexToolsDialog,
  type AdminCodexTool
} from "./features/admin-codex-tools/AdminCodexToolsDialog.js";
import type { AdminOperationTool } from "./features/admin-operations/AdminOperationsDialog.js";
import { AuthenticationBootstrap } from "./features/auth/AuthenticationBootstrap.js";
import { OwnerSetupScreen } from "./features/auth/OwnerSetupScreen.js";
import {
  BROWSER_PANE_ACTION_EVENT,
  dispatchBrowserPaneActionEvent,
  parseBrowserPaneActionDetail,
  type BrowserPaneAction
} from "./features/browser-pane/events.js";
import { ClipboardDock } from "./features/clipboard-dock/ClipboardDock.js";
import { AppVersionMeta, DemoVersionMeta } from "./features/app-version/AppVersionMeta.js";
import { useAppVersion } from "./features/app-version/use-app-version.js";
import { TaskDock } from "./features/task-dock/TaskDock.js";
import {
  AppDiagnosticsGlobalIndicators,
  AppDiagnosticsSettingsCard
} from "./features/app-diagnostics/AppDiagnosticsSettingsCard.js";
import { emitAppDiagnosticsPerformance } from "./app-diagnostics/app-diagnostics-performance.js";
import { CodexCliDefaultsCard } from "./features/codex-cli-defaults/CodexCliDefaultsCard.js";
import {
  CLI_LAUNCHER_MENU_ID,
  CliLauncherMenu
} from "./features/cli-launcher/CliLauncherMenu.js";
import { CliRuntimeSettingsCard } from "./features/cli-runtime-settings/CliRuntimeSettingsCard.js";
import { SourceControlPublishingCard } from "./features/source-control-publishing/SourceControlPublishingCard.js";
import { SettingsActionMenu } from "./features/settings/SettingsActionMenu.js";
import {
  SPACE_CLIPBOARD_NOTICE_EVENT,
  useSpaceClipboardCapture,
  writeClipboardText
} from "./features/clipboard-dock/clipboard-events.js";
import { MediaDock } from "./features/media-dock/MediaDock.js";
import { StreamingDock } from "./features/streaming/StreamingDock.js";
import {
  StreamingOverlay,
  StreamingOverlayProvider
} from "./features/streaming/StreamingOverlay.js";
import { reorderPanesByTarget, setPaneDragData } from "./features/pane-drag/pane-drag.js";
import { ActivityLogDock } from "./features/activity-log/ActivityLogDock.js";
import { AgentFilesDock } from "./features/agent-files/AgentFilesDock.js";
import { AgentToolsDock } from "./features/agent-tools/AgentToolsDock.js";
import { CliDock } from "./features/cli-dock/CliDock.js";
import { PANE_LAYOUT_MENU_ID, PaneLayoutMenu } from "./features/pane-layout/PaneLayoutMenu.js";
import { PANE_SPAN_ALL_MENU_ID, PaneSpanAllMenu } from "./features/pane-layout/PaneSpanAllMenu.js";
import { EmbeddedDashboardDialog } from "./features/embedded-dashboard/EmbeddedDashboardDialog.js";
import { LinksPanel, QuickLinksPopover } from "./features/user-links/UserLinks.js";
import { HelpPage } from "./features/help/HelpPage.js";
import { RoomAgentDock } from "./features/room-agent/RoomAgentDock.js";
import { AgentSessionsDock } from "./features/agent-sessions/AgentSessionsDock.js";
import {
  ROOM_THEME_MENU_ID,
  RoomThemeMenu,
  roomThemes,
  type RoomTheme
} from "./features/room-theme/RoomThemeMenu.js";
import { UiThemeSettingsCard } from "./features/ui-theme/UiThemeSettingsCard.js";
import {
  groupModernRoomActions,
  modernPanePrimaryActionCapacity,
  modernPanePrimaryActionCount
} from "./features/ui-theme/modern-toolbar.js";
import {
  migrateModernToolbarPreference,
  modernPaneToolbarStorageKeys,
  modernRoomToolbarStorageKeys,
  readModernAppearance,
  readModernIconPack,
  readUiTheme,
  resolveModernColorMode,
  shouldMeasureToolbarLayout,
  writeModernAppearance,
  writeModernIconPack,
  writeUiTheme,
  type ModernAppearance,
  type ModernColorMode,
  type ModernIconPack,
  type UiTheme
} from "./ui-theme.js";
import { RoomPaneComposer } from "./features/room-pane-composer/RoomPaneComposer.js";
import {
  SERVER_ACTIONS_MENU_ID,
  ServerActionsMenu,
  type ServerActionCommand
} from "./features/server-actions/ServerActionsMenu.js";
import { SetupConnectionsWizard } from "./features/setup-connections/SetupConnectionsWizard.js";
import { TelegramIntegrationCard } from "./features/telegram-integration/TelegramIntegrationCard.js";
import {
  createTerminalBootstrapBarrier,
  TerminalPane,
  type TerminalBootstrapBarrier,
  type TerminalSessionMetadata
} from "./features/terminal-pane/index.js";
import { registerCliResumeIntent } from "./features/terminal-pane/cli-resume-intent.js";
import { VIBE_MUSIC_PANEL_ID, VibeMusicPlayer } from "./features/vibe-music/VibeMusicPlayer.js";
import { OSK_PANEL_ID, OnScreenKeyboard, type OnScreenKeyboardInput } from "./features/osk-keyboard/OnScreenKeyboard.js";
import {
  ToolbarMetrics,
  ToolbarMetricsSummary,
  type ToolbarMetricsHandle
} from "./features/toolbar-metrics/ToolbarMetrics.js";
import type { SystemAnalyticsTab } from "./features/system-analytics/SystemAnalyticsWorkspace.js";
import {
  MAX_WORKSPACE_TEXT_SIZE,
  MIN_WORKSPACE_TEXT_SIZE,
  WORKSPACE_TEXT_SIZE_PICKER_ID,
  WorkspaceTextSizePicker
} from "./features/workspace-text-size-picker/WorkspaceTextSizePicker.js";
import {
  useDismissibleToolbarLayer,
  usePersistentIconToolbar,
  type IconToolbarAction
} from "./icon-toolbar.js";
import {
  clearLifecycleDebugEvents,
  classifyRoomSwitchTemperature,
  LIFECYCLE_DEBUG_UPDATED_EVENT,
  readLifecycleDebugSnapshot,
  recordLifecycleDebugEvent,
  recordRoomSwitchMeasurementPhase,
  startRoomSwitchMeasurement,
  type LifecycleDebugEvent,
  type LifecycleDebugSnapshot
} from "./lifecycle-debug.js";
import {
  writeVoiceComposerSettings,
  type VoiceComposerSettings
} from "./voice-settings.js";
import { useVoiceInput } from "./features/voice-input/VoiceInputProvider.js";
import {
  connectedPaneCount,
  selectHiddenRoomEvictionIds,
  selectRoomRuntimePollIds,
  selectWarmRoomIds,
  WARM_ROOM_RUNTIME_POLL_INTERVAL_MS
} from "./room-runtime-cache.js";
import {
  createWarmRoomCapacityController,
  readBrowserWarmRoomMemoryTelemetry,
  snapshotWarmRoomCapacity,
  WARM_ROOM_FULL_PANE_COUNT,
  WARM_ROOM_PRESSURE_WINDOW_MS,
  type WarmRoomCapacitySnapshot,
  type WarmRoomHydrationSample
} from "./warm-room-capacity-controller.js";
import {
  classifyRoomWarmPresentation,
  hydrateWarmRoomsWithinWindow,
  isRoomInEvictionCooldown,
  readRoomMru,
  recordRoomMru,
  runWithConcurrency,
  selectAutomaticWarmFillRoomIds,
  selectWarmHydrationRoomIds,
  WARM_ROOM_EVICTION_COOLDOWN_MS,
  WARM_ROOM_STARTUP_HYDRATION_CONCURRENCY
} from "./warm-room-startup.js";
import { reuseVersionedItems, useStableCallback } from "./render-performance.js";
import {
  readStoredWarmRoomEnabled,
  removeLegacyWarmRoomConnectedPaneLimit,
  writeStoredWarmRoomEnabled,
} from "./warm-room-settings.js";
import {
  readStoredSuppressNotifications,
  writeStoredSuppressNotifications,
} from "./notifications-settings.js";

const modeIcons: Record<Pane["mode"], typeof MessageSquare> = {
  CHAT: MessageSquare,
  CODE: Terminal,
  BROWSER: Eye,
  REVIEW: GitCompare,
  SWARM: Boxes,
  DESIGN: Sparkles,
  TERMINAL: Terminal,
  YOUTUBE: Youtube
};

const ROOM_PRESENTATION_FAILURE_TIMEOUT_MS = 30_000;

function PaneModeIcon({ pane }: { pane: Pick<Pane, "mode" | "terminalRuntimeId"> }) {
  const runtimeId = pane.terminalRuntimeId?.replace(/^cli:/, "") ?? "codex";
  const runtimeBrand = pane.mode === "TERMINAL" ? cliRuntimePresentation(runtimeId) : undefined;
  if (runtimeBrand) {
    return (
      <img
        src={runtimeBrand.iconSrc}
        alt=""
        aria-hidden="true"
        data-terminal-runtime-brand={runtimeBrand.brand}
        draggable={false}
      />
    );
  }
  const Icon = modeIcons[pane.mode];
  return <Icon aria-hidden="true" />;
}

type SideSurface = "rooms" | "room-agent" | "media" | "streaming" | "agent-files" | "clipboard" | "tasks" | "links" | "settings" | "health" | "logs" | "agent-tools" | "cli" | "agent-sessions";
type EventStreamStatus = "idle" | "connecting" | "connected" | "reconnecting" | "unavailable";
type ActiveRoomEventStreamStatus = "idle" | "connecting" | "connected" | "disconnected" | "unavailable";
type RoomRefreshCategory = "panes" | "turns" | "swarm" | "events";
type ShellMode = "desktop" | "tablet" | "mobile";
type AppView = "workspace" | "help";
type PaneDensity = "regular" | "dense" | "tight";
type PaneGridPlacement = {
  columnStart: number;
  rowIndex: number;
  effectiveSpan: number;
  canGrow: boolean;
  canReset: boolean;
};
type PaneGridPlacementSeed = Omit<PaneGridPlacement, "canGrow" | "canReset">;
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
type TerminalOutputPressureDetail = {
  roomId: string;
  paneId: string;
  bufferedBytes: number;
  bufferedEvents: number;
  totalBufferedBytes: number;
  reason: "PANE_LIMIT" | "TOTAL_LIMIT";
};
type WarmRoomAdmissionDecision = {
  action: "OPEN_SAFELY";
  automatic: true;
  targetRoomId: string;
  evictedRoomId: string | null;
  usedColdRevealReserve: boolean;
  sequence: number;
};

type WarmRoomCapacityDiagnosticPhase =
  | "SAMPLE"
  | "ADMIT"
  | "EVICT"
  | "OVERCOMMIT"
  | "REVOKE"
  | "PRESSURE";

function emitWarmRoomCapacityDiagnostic(
  snapshot: WarmRoomCapacitySnapshot,
  phase: WarmRoomCapacityDiagnosticPhase
) {
  emitAppDiagnosticsPerformance({
    category: "PERFORMANCE",
    metric: "WARM_ROOM_CAPACITY",
    phase,
    safeCapacity: snapshot.effectiveSafeRoomCapacity,
    hardCapacity: snapshot.hardRoomCapacity,
    warmRoomCount: snapshot.warmRoomCount,
    connectedPaneCount: snapshot.connectedPaneCount,
    safePaneCapacity: snapshot.safePaneCapacity,
    hardPaneCapacity: snapshot.hardPaneCapacity,
    estimatedRoomBytes: snapshot.estimatedRoomBytes,
    ...(snapshot.usedBytes === null ? {} : { usedBytes: snapshot.usedBytes }),
    longTaskCount: snapshot.longTaskCount,
    driftCount: snapshot.driftCount
  });
}

export function shellVisiblePaneIds(
  panes: ReadonlyArray<Pick<Pane, "id" | "isMaximized" | "isMinimized">>,
  selectedPaneId: string | null,
  shellMode: ShellMode,
  fullscreenLayout = false
): string[] {
  const visiblePanes = panes.filter((pane) => !pane.isMinimized);
  if (shellMode === "mobile" || fullscreenLayout) {
    const selectedPane = visiblePanes.find((pane) => pane.id === selectedPaneId) ?? visiblePanes[0];
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
  const newPaneIds = paneIds.filter((paneId) => !barrierByPaneIdRef.current.has(paneId));
  if (newPaneIds.length > 0) {
    const barrier = createTerminalBootstrapBarrier(newPaneIds);
    for (const paneId of newPaneIds) barrierByPaneIdRef.current.set(paneId, barrier);
  }
  return children(barrierByPaneIdRef.current);
}

type PaneColumnAnchorMap = Map<string, number>;

const LazyMemoryWorkspace = lazy(() =>
  import("./features/memory-workspace/MemoryWorkspace.js").then((module) => ({ default: module.MemoryWorkspace }))
);
const LazySystemAnalyticsWorkspace = lazy(() =>
  import("./features/system-analytics/SystemAnalyticsWorkspace.js")
    .then((module) => ({ default: module.SystemAnalyticsWorkspace }))
);
const LazyAgentPane = lazy(() =>
  import("./features/agent-pane/AgentPane.js").then((module) => ({ default: module.AgentPane }))
);
const LazyBrowserPane = lazy(() =>
  import("./features/browser-pane/BrowserPane.js").then((module) => ({ default: module.BrowserPane }))
);
const LazyYouTubePane = lazy(() =>
  import("./features/browser-pane/YouTubePane.js").then((module) => ({ default: module.YouTubePane }))
);
const LazyAdminOperationsDialog = lazy(() =>
  import("./features/admin-operations/AdminOperationsDialog.js")
    .then((module) => ({ default: module.AdminOperationsDialog }))
);
const agentPaneLoadingFallback = <div className="pane-copy" role="status">Loading chat pane…</div>;
const browserPaneLoadingFallback = <div className="pane-copy" role="status">Loading browser pane…</div>;

const roomEventLimit = 50;
const MIN_TERMINAL_FONT_SIZE = MIN_WORKSPACE_TEXT_SIZE;
const MAX_TERMINAL_FONT_SIZE = MAX_WORKSPACE_TEXT_SIZE;
const DEFAULT_TERMINAL_FONT_SIZE = 12;
const TERMINAL_FONT_SIZE_STORAGE_KEY = "space.terminal.fontSize";
const SESSION_DEBUG_IDS_STORAGE_KEY = "space.showSessionDebugIds";
const CLI_DEBUG_MODE_STORAGE_KEY = "space.cliDebugMode";
const CLI_FLOATS_HIDDEN_STORAGE_KEY = "space.cliFloatsHidden";
const SPACE_SENSITIVE_DATA_MASKED_STORAGE_KEY = "space.sensitiveDataMasked";
const SIDE_SURFACE_HIDDEN_STORAGE_KEY = "space.roomsRailHidden";
const ROOM_FOCUS_MODE_STORAGE_KEY = "space.roomFocusMode";
const ROOM_TOOLBAR_HIDDEN_STORAGE_KEY = "space.roomToolbar.hidden.v1";
const ROOM_THEME_STORAGE_KEY = "space.room.theme";
const ROOM_TOOLBAR_HIDDEN_ACTIONS_STORAGE_KEY = "space.roomToolbar.hiddenActionIds.v3";
const ROOM_TOOLBAR_ACTION_ORDER_STORAGE_KEY = "space.roomToolbar.actionOrder.v3";
const PANE_TOOLBAR_HIDDEN_ACTIONS_STORAGE_KEY_PREFIX = "space.paneToolbar.hiddenActionIds";
const PANE_TOOLBAR_ACTION_ORDER_STORAGE_KEY_PREFIX = "space.paneToolbar.actionOrder";
const SHARED_CODEX_TOOLBAR_HIDDEN_STORAGE_KEY = "space.paneToolbar.sharedCodex.hiddenActionIds";
const SHARED_CODEX_TOOLBAR_ORDER_STORAGE_KEY = "space.paneToolbar.sharedCodex.actionOrder";
const SELECTED_ROOM_ID_STORAGE_KEY = "space.selectedRoomId";
const SELECTED_PANE_ID_STORAGE_KEY = "space.selectedPaneId";
const TERMINAL_PANE_ACTION_EVENT = "space:terminal-pane-action";
const AGENT_PANE_SETTINGS_EVENT = "space:agent-pane-settings-updated";
const MOBILE_SHELL_MAX_WIDTH = 768;
const TABLET_SHELL_MAX_WIDTH = 1100;
const MAX_PANE_COLUMN_SPAN = 4;
const ROOM_CLI_ACTIVITY_POLL_INTERVAL_MS = 5_000;

function readAppView(): AppView {
  const pathname = window.location.pathname.replace(/\/+$/, "") || "/";
  return pathname === "/help" ? "help" : "workspace";
}

const paneGridDensityMetrics: Record<PaneDensity, { minWidthRem: number; gapRem: number }> = {
  regular: { minWidthRem: 19, gapRem: 0.75 },
  dense: { minWidthRem: 16, gapRem: 0.6 },
  tight: { minWidthRem: 14, gapRem: 0.5 }
};

type TerminalPaneAction =
  | { action: "upload" | "reconnect" | "copy" | "focus" | "cancel_login" }
  | { action: "attach_clip_image"; file: File }
  | { action: "insert_text"; text: string }
  | { action: "keyboard_input"; text: string }
  | { action: "insert_clipboard_text"; text: string }
  | { action: "start_task_item"; objective: string }
  | { action: "ensure_plan_mode" }
  | { action: "enter_native_plan_mode"; runtimeId: "cli:gemini" | "cli:qwen" }
  | { action: "control_key"; key: "shift_tab" | "escape" }
  | { action: "replace_session"; session: PaneCliSessionResponse }
  | {
      action: "save_to_memory";
      modelId: string;
      text: string;
      memory: {
        scope: MemoryEntry["scope"];
        roomId?: string | null;
        title: string;
        provenance: string;
      };
      };
type AgentPaneAction =
  | "upload"
  | "plan"
  | "resume"
  | "copy"
  | "reconnect"
  | "interrupt"
  | "save_to_memory"
  | "new_task"
  | "attach_folder"
  | "manage_goal";
type AgentPaneDetailAction =
  | { action: "insert_text"; text: string }
  | { action: "open_thread"; threadId: string };
const SUPPORTED_CLIP_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

type ClipImageTarget = {
  roomId: string;
  paneId: string | null;
  paneMode: Pane["mode"] | null;
};

function isTransientUpstreamErrorMessage(message: string | null): boolean {
  if (!message) return false;
  return (
    message.startsWith("UPSTREAM_UNAVAILABLE:") ||
    message.includes("Space API is not reachable from the web server.") ||
    message.startsWith("Request failed: 502")
  );
}

function isTransientUpstreamRuntimeError(error: unknown): boolean {
  if (error instanceof SpaceApiError) {
    return error.code === "UPSTREAM_UNAVAILABLE" || error.status === 0 || error.status === 502;
  }
  if (error instanceof Error) {
    return isTransientUpstreamErrorMessage(error.message);
  }
  return false;
}

const streamEventTypes: SpaceEvent["type"][] = [
  "ROOM_CREATED",
  "PANE_CREATED",
  "PANE_UPDATED",
  "PANE_CLOSED",
  "TURN_STARTED",
  "TURN_DELTA",
  "TURN_COMPLETED",
  "TURN_FAILED",
  "APPROVAL_REQUESTED",
  "ARTIFACT_CREATED",
  "CAPABILITY_STATUS_CHANGED",
  "MEMORY_SAVED",
  "SKILL_PROPOSED",
  "IMPORT_CANDIDATE_CREATED",
  "IMPORT_CANDIDATE_DECIDED",
  "SWARM_TASK_CREATED",
  "SWARM_TASK_UPDATED",
  "SWARM_LOCK_CLAIMED",
  "SWARM_LOCK_RELEASED",
  "SWARM_MESSAGE_POSTED",
  "SWARM_RECONCILED",
  "REVIEW_CHECK_RECORDED",
  "REVIEW_DIFF_RECORDED",
  "REVIEW_DECISION_CREATED",
  "BROWSER_HANDOFF_REQUESTED"
];

const sideSurfaceMeta: Record<SideSurface, { icon: LucideIcon; label: string; surfaceLabel: string }> = {
  rooms: { icon: PanelRight, label: "rooms", surfaceLabel: "Rooms" },
  "room-agent": { icon: Bot, label: "room agent", surfaceLabel: "Room Agent" },
  media: { icon: Images, label: "media dock", surfaceLabel: "Media dock" },
  streaming: { icon: Radio, label: "streaming dock", surfaceLabel: "Streaming dock" },
  "agent-files": { icon: FolderOpen, label: "Agent Files", surfaceLabel: "Agent Files" },
  clipboard: { icon: Clipboard, label: "clipboard", surfaceLabel: "Clipboard" },
  tasks: { icon: ListTodo, label: "tasks", surfaceLabel: "Tasks" },
  links: { icon: LinkIcon, label: "links", surfaceLabel: "Links" },
  settings: { icon: Settings2, label: "settings dock", surfaceLabel: "Settings dock" },
  health: { icon: Activity, label: "health dock", surfaceLabel: "Health dock" },
  logs: { icon: History, label: "activity log", surfaceLabel: "Activity log" },
  "agent-tools": { icon: Wrench, label: "agent tools", surfaceLabel: "Agent Tools" },
  cli: { icon: Terminal, label: "cli dock", surfaceLabel: "CLI dock" },
  "agent-sessions": { icon: History, label: "agent session history", surfaceLabel: "Agent Session History" }
};

type BlueprintStatus = "LIVE" | "GATED" | "NEXT";

function remToPx(rem: number) {
  if (typeof window === "undefined" || typeof document === "undefined") return rem * 16;
  const rootFontSize = Number.parseFloat(window.getComputedStyle(document.documentElement).fontSize || "16");
  return rem * (Number.isFinite(rootFontSize) ? rootFontSize : 16);
}

let titleMeasureCanvas: HTMLCanvasElement | null = null;

function measureSingleLineTitleWidth(element: HTMLElement | null, fallbackRem = 8) {
  if (!element || typeof window === "undefined" || typeof document === "undefined") return remToPx(fallbackRem);
  const text = element.textContent?.trim();
  if (!text) return remToPx(1);
  if (typeof navigator !== "undefined" && /\bjsdom\b/i.test(navigator.userAgent)) {
    return Math.max(element.scrollWidth, remToPx(fallbackRem));
  }

  const computed = window.getComputedStyle(element);
  const font =
    computed.font && computed.font !== ""
      ? computed.font
      : `${computed.fontStyle} ${computed.fontVariant} ${computed.fontWeight} ${computed.fontSize} / ${computed.lineHeight} ${computed.fontFamily}`;
  titleMeasureCanvas ??= document.createElement("canvas");
  const context = titleMeasureCanvas.getContext("2d");
  if (!context) return Math.max(element.scrollWidth, remToPx(fallbackRem));

  context.font = font;
  const letterSpacing = Number.parseFloat(computed.letterSpacing || "");
  const spacingWidth = Number.isFinite(letterSpacing) ? Math.max(text.length - 1, 0) * letterSpacing : 0;
  return Math.ceil(context.measureText(text).width + spacingWidth);
}

export function roomToolbarNeedsSecondRow(input: {
  availableWidth: number;
  titleWidth: number;
  lbWidth: number;
  actionsWidth: number;
  columnGap: number;
}) {
  if (input.availableWidth <= 0) return false;
  const requiredWidth = input.titleWidth + input.lbWidth + input.actionsWidth + input.columnGap * 2;
  return requiredWidth > input.availableWidth + 1;
}

export function paneHeaderNeedsSecondRow(input: {
  availableWidth: number;
  paddingLeft: number;
  paddingRight: number;
  badgeWidth: number;
  titleWidth: number;
  actionsWidth: number;
  fixedWidth: number;
  columnGap: number;
}) {
  if (input.availableWidth <= 0) return false;
  const requiredWidth =
    input.paddingLeft +
    input.paddingRight +
    input.badgeWidth +
    input.titleWidth +
    input.actionsWidth +
    input.fixedWidth +
    input.columnGap * 3;
  return requiredWidth > input.availableWidth + 1;
}

function clampPaneColumnSpan(columnSpan: number | null | undefined, columnCount: number) {
  return Math.max(1, Math.min(MAX_PANE_COLUMN_SPAN, columnSpan ?? 1, columnCount));
}

function sortPanesForGrid(panes: Pane[]) {
  return [...panes].sort((left, right) => {
    if (left.order !== right.order) return left.order - right.order;
    const leftCreatedAt = Date.parse(left.createdAt);
    const rightCreatedAt = Date.parse(right.createdAt);
    if (Number.isFinite(leftCreatedAt) && Number.isFinite(rightCreatedAt) && leftCreatedAt !== rightCreatedAt) {
      return leftCreatedAt - rightCreatedAt;
    }
    return left.id.localeCompare(right.id);
  });
}

function detectPaneGridColumnCount(input: { shellMode: ShellMode; paneDensity: PaneDensity; containerWidth: number }) {
  if (input.shellMode === "mobile") return 1;
  if (input.shellMode === "tablet") return 2;
  const metrics = paneGridDensityMetrics[input.paneDensity];
  const minWidthPx = remToPx(metrics.minWidthRem);
  const gapPx = remToPx(metrics.gapRem);
  return Math.max(1, Math.floor((Math.max(input.containerWidth, minWidthPx) + gapPx) / (minWidthPx + gapPx)));
}

function resolvePaneGridColumnCount(input: {
  shellMode: ShellMode;
  paneDensity: PaneDensity;
  containerWidth: number;
  paneLayoutColumns: Room["paneLayoutColumns"];
  visiblePaneCount: number;
  forceTabletTwoColumns?: boolean;
}) {
  if (input.containerWidth > 0 && input.containerWidth <= 768) return 1;
  if (input.paneLayoutColumns === 0) return 1;
  const automaticColumns = Math.min(4, detectPaneGridColumnCount(input));
  const requestedColumns = input.paneLayoutColumns ?? automaticColumns;
  const responsiveColumns =
    input.shellMode === "mobile"
      ? 1
      : input.shellMode === "tablet"
        ? input.forceTabletTwoColumns && input.paneLayoutColumns === null && input.visiblePaneCount > 1
          ? 2
          : Math.min(requestedColumns, 2)
        : requestedColumns;
  return Math.max(1, Math.min(responsiveColumns, Math.max(input.visiblePaneCount, 1)));
}

function computePaneGridPlacements(panes: Pane[], columnCount: number, anchoredColumnStarts: PaneColumnAnchorMap = new Map()) {
  const placements = new Map<string, PaneGridPlacementSeed>();
  const occupancy: boolean[][] = [];
  let cursorRow = 0;
  let cursorColumn = 1;

  const ensureRow = (rowIndex: number) => {
    while (occupancy.length <= rowIndex) {
      occupancy.push(Array.from({ length: columnCount }, () => false));
    }
  };

  const rangeIsAvailable = (row: boolean[], columnStart: number, span: number) => {
    if (columnStart + span - 1 > columnCount) return false;
    for (let offset = 0; offset < span; offset += 1) {
      if (row[columnStart - 1 + offset]) return false;
    }
    return true;
  };

  const placeAutoFlowPane = (span: number) => {
    let rowIndex = 0;
    let columnStart = 1;

    while (true) {
      if (columnStart > columnCount) {
        rowIndex += 1;
        columnStart = 1;
        continue;
      }
      ensureRow(rowIndex);
      if (columnStart + span - 1 > columnCount) {
        rowIndex += 1;
        columnStart = 1;
        continue;
      }
      if (!rangeIsAvailable(occupancy[rowIndex] ?? [], columnStart, span)) {
        columnStart += 1;
        continue;
      }
      return { rowIndex, columnStart };
    }
  };

  const placeAnchoredPane = (anchorColumnStart: number, span: number, startRow: number) => {
    const columnStart = Math.max(1, Math.min(anchorColumnStart, columnCount - span + 1));
    let rowIndex = startRow;

    while (true) {
      ensureRow(rowIndex);
      if (rangeIsAvailable(occupancy[rowIndex] ?? [], columnStart, span)) {
        return { rowIndex, columnStart };
      }
      rowIndex += 1;
    }
  };

  for (const pane of sortPanesForGrid(panes)) {
    const effectiveSpan = clampPaneColumnSpan(pane.columnSpan, columnCount);
    const anchoredColumnStart = anchoredColumnStarts.get(pane.id);
    const placement =
      anchoredColumnStart === undefined
        ? placeAutoFlowPane(effectiveSpan)
        : placeAnchoredPane(anchoredColumnStart, effectiveSpan, cursorRow);

    for (let offset = 0; offset < effectiveSpan; offset += 1) {
      occupancy[placement.rowIndex]![placement.columnStart - 1 + offset] = true;
    }
    placements.set(pane.id, {
      columnStart: placement.columnStart,
      rowIndex: placement.rowIndex,
      effectiveSpan
    });
    cursorRow = placement.rowIndex;
    cursorColumn = placement.columnStart + effectiveSpan;
  }

  return placements;
}

function canPaneGrowAtCurrentPlacement(input: {
  pane: Pane;
  columnCount: number;
  basePlacements: Map<string, PaneGridPlacementSeed>;
}) {
  const currentPlacement = input.basePlacements.get(input.pane.id);
  if (!currentPlacement || input.pane.isMaximized) return false;

  const nextColumnSpan = clampPaneColumnSpan((input.pane.columnSpan ?? 1) + 1, input.columnCount);
  return nextColumnSpan > currentPlacement.effectiveSpan;
}

function resolvePaneGridPlacements(panes: Pane[], columnCount: number, anchoredColumnStarts: PaneColumnAnchorMap = new Map()) {
  const placements = new Map<string, PaneGridPlacement>();
  const basePlacements = computePaneGridPlacements(panes, columnCount, anchoredColumnStarts);

  for (const pane of sortPanesForGrid(panes)) {
    const basePlacement = basePlacements.get(pane.id);
    if (!basePlacement) continue;
    placements.set(pane.id, {
      ...basePlacement,
      canGrow: canPaneGrowAtCurrentPlacement({
        pane,
        columnCount,
        basePlacements
      }),
      canReset: !pane.isMaximized && (pane.columnSpan ?? 1) > 1
    });
  }

  return placements;
}

interface BlueprintProgressItem {
  label: string;
  status: BlueprintStatus;
  detail: string;
}

type LaunchBlockerSeverity = "hard" | "gate" | "next";

interface LaunchBlocker {
  label: string;
  detail: string;
  severity: LaunchBlockerSeverity;
}

interface BlueprintProgressProps {
  readiness: ReadyzPayload | null;
  mcp: McpPayload | null;
  latestSmoke: McpDiscoverySmokeCheck | null;
  latestMemoryEmbeddingSmoke: MemoryEmbeddingSmokeCheck | null;
  latestMemoryVectorReadiness: MemoryVectorReadiness | null;
  providers: Provider[];
  skills: Skill[];
  importCandidates: ImportCandidate[];
  swarmState: SwarmState | null;
  rooms: Room[];
  panes: Pane[];
  codexAppServer: CodexAppServerStatus | null;
  observability: ObservabilitySnapshot | null;
  workerReadiness: WorkerReadiness | null;
  storageReadiness: StorageReadiness | null;
  storageWarning: string;
}

function statusTone(status: string) {
  if (
    status === "VERIFIED" ||
    status === "EXECUTED" ||
    status === "TOOL_EXECUTION_OK" ||
    status === "LIVE" ||
    status === "READY" ||
    status === "RUNNING" ||
    status === "COMPLETE" ||
    status === "COMPLETED"
  ) {
    return "ok";
  }
  if (status === "WARN" || status === "GATED") return "warn";
  if (status === "ERROR" || status === "FAILED" || status === "BLOCKED") return "bad";
  return "muted";
}

function readableCode(code: string) {
  return code
    .split("_")
    .filter(Boolean)
    .map((part) => part[0] + part.slice(1).toLowerCase())
    .join(" ");
}

function readViewportWidth() {
  return typeof window === "undefined" ? 1440 : window.innerWidth;
}

function readStoredSessionString(key: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    const value = getSpaceRuntime().platform.sessionStorage.getItem(key);
    return value || null;
  } catch {
    return null;
  }
}

function detectShellMode(width: number, mobileMaxWidth = MOBILE_SHELL_MAX_WIDTH): ShellMode {
  if (width <= mobileMaxWidth) return "mobile";
  if (width <= TABLET_SHELL_MAX_WIDTH) return "tablet";
  return "desktop";
}

function detectUiThemeShellMode(width: number, uiTheme: UiTheme): ShellMode {
  return detectShellMode(width, uiTheme === "modern" ? 767 : MOBILE_SHELL_MAX_WIDTH);
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

const paneModeLabels: Record<Pane["mode"], string> = {
  CHAT: "Chat",
  CODE: "Code",
  BROWSER: "Browser",
  REVIEW: "Review",
  SWARM: "Swarm",
  DESIGN: "Design",
  TERMINAL: "CLI",
  YOUTUBE: "YouTube"
};

function paneModeLabel(mode: Pane["mode"]): string {
  return paneModeLabels[mode];
}

function paneTitleForMode(mode: Pane["mode"], index: number): string {
  return `${paneModeLabel(mode)} ${index}`;
}

function displayPaneTitle(pane: Pick<Pane, "mode" | "title">): string {
  if (pane.mode !== "TERMINAL") return pane.title;
  return pane.title.replace(/^Terminal\b/i, "CLI");
}

type TaskHistoryDialogItem = CodexHistoryItem | CliTaskHistoryItem;

function appendUniqueTaskHistoryItems(current: TaskHistoryDialogItem[], incoming: TaskHistoryDialogItem[]): TaskHistoryDialogItem[] {
  const ids = new Set(current.map((item) => item.id));
  const merged = [...current];
  for (const item of incoming) {
    if (ids.has(item.id)) continue;
    ids.add(item.id);
    merged.push(item);
  }
  return merged;
}

function sortRoomsByOrder(rooms: Room[]): Room[] {
  return [...rooms].sort((left, right) => {
    if (left.order !== right.order) return left.order - right.order;
    const leftCreatedAt = Date.parse(left.createdAt);
    const rightCreatedAt = Date.parse(right.createdAt);
    if (!Number.isNaN(leftCreatedAt) && !Number.isNaN(rightCreatedAt) && leftCreatedAt !== rightCreatedAt) {
      return leftCreatedAt - rightCreatedAt;
    }
    return left.id.localeCompare(right.id);
  });
}

const ROOM_CATALOG_PAGE_SIZE = 100;
const ROOM_CATALOG_MAX_PAGES = 20;

async function loadBoundedRoomCatalog(): Promise<Room[]> {
  const firstPage = await api.rooms({ page: 1, pageSize: ROOM_CATALOG_PAGE_SIZE });
  const reportedPageCount = firstPage.pagination.totalPages;
  const pageCount = Number.isSafeInteger(reportedPageCount) && reportedPageCount > 1
    ? Math.min(reportedPageCount, ROOM_CATALOG_MAX_PAGES)
    : 1;
  if (pageCount === 1) return firstPage.data;

  const remainingPages = await Promise.all(
    Array.from({ length: pageCount - 1 }, (_, index) =>
      api.rooms({ page: index + 2, pageSize: ROOM_CATALOG_PAGE_SIZE })
    )
  );
  return [firstPage, ...remainingPages].flatMap((page) => page.data);
}

function reorderRoomsById(rooms: Room[], draggedRoomId: string, targetRoomId: string): Room[] {
  if (draggedRoomId === targetRoomId) return rooms;
  const draggedIndex = rooms.findIndex((room) => room.id === draggedRoomId);
  const targetIndex = rooms.findIndex((room) => room.id === targetRoomId);
  if (draggedIndex === -1 || targetIndex === -1) return rooms;
  const next = [...rooms];
  const [draggedRoom] = next.splice(draggedIndex, 1);
  if (!draggedRoom) return rooms;
  const insertionIndex = draggedIndex < targetIndex ? targetIndex - 1 : targetIndex;
  next.splice(insertionIndex, 0, draggedRoom);
  return next.map((room, index) => (room.order === index ? room : { ...room, order: index }));
}

type PaneOverflowCommand = {
  id: string;
  label: string;
  description: string;
  title?: string;
  ariaLabel: string;
  icon: LucideIcon;
  onClick: () => void;
  disabled?: boolean;
};

function enabledButtons(container: HTMLElement): HTMLButtonElement[] {
  return Array.from(container.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"));
}

type PopupCloseIntent = "auto" | "dismissal" | "activation";

function restorePopupTriggerFocus(
  popup: HTMLElement | null,
  trigger: HTMLButtonElement | null,
  closeIntent: PopupCloseIntent
) {
  if (!trigger?.isConnected) return;
  const activeElement = document.activeElement;
  const focusInPopup = Boolean(activeElement && popup?.contains(activeElement));
  const focusMovedToDestination =
    activeElement instanceof HTMLElement &&
    activeElement.isConnected &&
    activeElement !== document.body &&
    activeElement !== trigger &&
    !focusInPopup;
  if (focusMovedToDestination) return;
  if (closeIntent !== "auto" || focusInPopup || !activeElement || activeElement === document.body) trigger.focus();
}

function MobileActionSheet({
  actionSections,
  actions,
  commandSectionLabel = "Task commands",
  commands = [],
  hiddenActionIds,
  label,
  onClose,
  onHideAction,
  onRunCommand,
  onShowAction,
  onRunAction,
  plainActions = false,
  popupId,
  summary,
  triggerRef,
}: {
  actionSections?: Array<{ id: string; label: string; actions: IconToolbarAction[] }>;
  actions: IconToolbarAction[];
  commandSectionLabel?: string;
  commands?: PaneOverflowCommand[];
  hiddenActionIds: string[];
  label: string;
  onClose: () => void;
  onHideAction: (actionId: string) => void;
  onRunCommand?: (command: PaneOverflowCommand) => void;
  onShowAction: (actionId: string) => void;
  onRunAction: (action: IconToolbarAction) => void;
  plainActions?: boolean;
  popupId: string;
  summary?: ReactNode;
  triggerRef: RefObject<HTMLButtonElement | null>;
}) {
  const hiddenSet = new Set(hiddenActionIds);
  const toolbarSections = actionSections ?? [{ id: "toolbar", label: "Toolbar buttons", actions }];
  const dialogRef = useRef<HTMLElement>(null);
  const closeIntentRef = useRef<PopupCloseIntent>("auto");

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog) enabledButtons(dialog)[0]?.focus();
    return () => restorePopupTriggerFocus(dialog, triggerRef.current, closeIntentRef.current);
  }, [triggerRef]);

  function dismiss() {
    closeIntentRef.current = "dismissal";
    onClose();
  }

  function runCommand(command: PaneOverflowCommand) {
    closeIntentRef.current = "activation";
    onRunCommand?.(command);
  }

  function runAction(action: IconToolbarAction) {
    closeIntentRef.current = "activation";
    onRunAction(action);
  }

  function handleDialogKeyDown(event: ReactKeyboardEvent<HTMLElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      dismiss();
      return;
    }
    if (event.key !== "Tab") return;
    const dialog = dialogRef.current;
    if (!dialog) return;
    const buttons = enabledButtons(dialog);
    const first = buttons[0];
    const last = buttons.at(-1);
    if (!first || !last) {
      event.preventDefault();
      return;
    }
    const active = document.activeElement;
    if (event.shiftKey && (active === first || !dialog.contains(active))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (active === last || !dialog.contains(active))) {
      event.preventDefault();
      first.focus();
    }
  }

  return (
    <div className="mobile-action-sheet-backdrop" onClick={dismiss}>
      <section
        id={popupId}
        ref={dialogRef}
        className="mobile-action-sheet"
        role="dialog"
        aria-modal="true"
        aria-label={label}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={handleDialogKeyDown}
      >
        <header>
          <strong>{label}</strong>
          <button type="button" className="mobile-action-sheet-close" aria-label={`Close ${label}`} onClick={dismiss}>
            <X aria-hidden="true" />
          </button>
        </header>
        <div className="mobile-action-sheet-list">
          {summary}
          {commands.length ? (
            <div className="mobile-action-sheet-section" role="group" aria-label={commandSectionLabel}>
              <span className="mobile-action-sheet-section-label">{commandSectionLabel}</span>
              {commands.map((command) => {
                const CommandIcon = command.icon;
                return (
                  <div className="mobile-action-sheet-row" key={command.id}>
                    <button
                      type="button"
                      className="mobile-action-sheet-main"
                      aria-label={command.ariaLabel}
                      title={command.title}
                      disabled={command.disabled}
                      onClick={() => runCommand(command)}
                    >
                      <CommandIcon aria-hidden="true" />
                      <span>
                        <strong>{command.label}</strong>
                        <small>{command.description}</small>
                      </span>
                    </button>
                  </div>
                );
              })}
            </div>
          ) : null}
          {toolbarSections.map((section) => section.actions.length ? (
            <div className="mobile-action-sheet-section" role="group" aria-label={section.label} key={section.id}>
              <span className="mobile-action-sheet-section-label">{section.label}</span>
              {section.actions.map((action) => {
                const ActionIcon = action.icon;
                const isHidden = hiddenSet.has(action.id);
                if (plainActions) {
                  return (
                    <div className="mobile-action-sheet-row" key={action.id}>
                      <button
                        type="button"
                        className="mobile-action-sheet-main"
                        aria-label={action.ariaLabel}
                        aria-controls={action.ariaControls}
                        aria-expanded={action.ariaExpanded}
                        aria-haspopup={action.ariaHasPopup}
                        disabled={action.disabled}
                        onClick={() => runAction(action)}
                      >
                        <ActionIcon aria-hidden="true" />
                        <span>
                          <strong>{action.label}</strong>
                          <small>{action.title}</small>
                        </span>
                      </button>
                    </div>
                  );
                }
                return (
                  <div className={isHidden ? "mobile-action-sheet-row is-hidden" : "mobile-action-sheet-row"} key={action.id}>
                    <button
                      type="button"
                      className="mobile-action-sheet-main"
                      aria-label={action.ariaLabel}
                      aria-controls={action.ariaControls}
                      aria-expanded={action.ariaExpanded}
                      aria-haspopup={action.ariaHasPopup}
                      disabled={action.disabled || isHidden}
                      onClick={() => runAction(action)}
                    >
                      <ActionIcon aria-hidden="true" />
                      <span>
                        <strong>{action.label}</strong>
                        <small>{isHidden ? "Hidden" : action.title}</small>
                      </span>
                    </button>
                    {action.hideable === false ? null : (
                      <button
                        type="button"
                        className="mobile-action-sheet-toggle"
                        aria-label={`${isHidden ? "Show" : "Hide"} ${action.label}`}
                        onClick={() => {
                          if (isHidden) {
                            onShowAction(action.id);
                          } else {
                            onHideAction(action.id);
                          }
                        }}
                      >
                        {isHidden ? "Show" : "Hide"}
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          ) : null)}
        </div>
      </section>
    </div>
  );
}

function DesktopActionManager({
  actions,
  commandSectionLabel = "Task commands",
  commands = [],
  hiddenActionIds,
  label,
  onClose,
  onHideAction,
  onRunAction,
  onRunCommand,
  onShowAction,
  plainActions = false,
  preferPaneInside = false,
  primaryActionIds,
  popupId,
  triggerRef
}: {
  actions: IconToolbarAction[];
  commandSectionLabel?: string;
  commands?: PaneOverflowCommand[];
  hiddenActionIds: string[];
  label: string;
  onClose: () => void;
  onHideAction: (actionId: string) => void;
  onRunAction?: (action: IconToolbarAction) => void;
  onRunCommand?: (command: PaneOverflowCommand) => void;
  onShowAction: (actionId: string) => void;
  plainActions?: boolean;
  preferPaneInside?: boolean;
  primaryActionIds?: string[];
  popupId: string;
  triggerRef: RefObject<HTMLButtonElement | null>;
}) {
  const hiddenSet = new Set(hiddenActionIds);
  const primarySet = primaryActionIds ? new Set(primaryActionIds) : null;
  const menuRef = useRef<HTMLDivElement>(null);
  const closeIntentRef = useRef<PopupCloseIntent>("auto");
  const [position, setPosition] = useState<{
    left: number;
    top: number;
    ready: boolean;
    width: number | null;
    maxHeight: number | null;
    placement: "pane-inside-above" | "pane-inside-below" | "trigger-above" | "trigger-below";
  }>({
    left: 8,
    top: 8,
    ready: false,
    width: null,
    maxHeight: null,
    placement: "trigger-below"
  });

  useLayoutEffect(() => {
    function updatePosition() {
      const trigger = triggerRef.current;
      const menu = menuRef.current;
      if (!trigger || !menu) return;
      const margin = 8;
      const gap = 8;
      const triggerRect = trigger.getBoundingClientRect();
      const menuRect = menu.getBoundingClientRect();
      const width = menuRect.width || Math.min(320, window.innerWidth - margin * 2);
      const height = menuRect.height || Math.min(448, window.innerHeight * 0.7);
      const maxLeft = Math.max(margin, window.innerWidth - width - margin);
      const maxTop = Math.max(margin, window.innerHeight - height - margin);
      const pane = preferPaneInside ? trigger.closest<HTMLElement>(".pane-card") : null;
      if (pane) {
        const paneRect = pane.getBoundingClientRect();
        const paneLeft = Math.max(margin, paneRect.left);
        const paneRight = Math.min(window.innerWidth - margin, paneRect.right);
        const paneTop = Math.max(margin, paneRect.top);
        const paneBottom = Math.min(window.innerHeight - margin, paneRect.bottom);
        const insideWidth = Math.max(1, Math.min(width, paneRight - paneLeft - margin * 2));
        const belowTop = triggerRect.bottom + gap;
        const belowHeight = Math.max(0, paneBottom - margin - belowTop);
        const aboveHeight = Math.max(0, triggerRect.top - gap - (paneTop + margin));
        const placeBelow = belowHeight >= height || belowHeight >= aboveHeight;
        const availableHeight = placeBelow ? belowHeight : aboveHeight;
        const insideHeight = Math.max(1, Math.min(height, availableHeight));
        const insideTop = placeBelow
          ? belowTop
          : Math.max(paneTop + margin, triggerRect.top - gap - insideHeight);
        setPosition({
          left: Math.max(
            paneLeft + margin,
            Math.min(triggerRect.right - insideWidth, paneRight - margin - insideWidth)
          ),
          top: insideTop,
          ready: true,
          width: insideWidth,
          maxHeight: insideHeight,
          placement: placeBelow ? "pane-inside-below" : "pane-inside-above"
        });
        return;
      }
      const fitsBelow = triggerRect.bottom + gap + height <= window.innerHeight - margin;
      const desiredTop = fitsBelow ? triggerRect.bottom + gap : triggerRect.top - gap - height;
      setPosition({
        left: Math.max(margin, Math.min(triggerRect.right - width, maxLeft)),
        top: Math.max(margin, Math.min(desiredTop, maxTop)),
        ready: true,
        width: null,
        maxHeight: null,
        placement: fitsBelow ? "trigger-below" : "trigger-above"
      });
    }

    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [preferPaneInside, triggerRef]);

  useEffect(() => {
    const menu = menuRef.current;
    return () => restorePopupTriggerFocus(menu, triggerRef.current, closeIntentRef.current);
  }, [triggerRef]);

  useEffect(() => {
    if (!position.ready) return;
    const frame = window.requestAnimationFrame(() => {
      const menu = menuRef.current;
      if (menu) enabledButtons(menu)[0]?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [position.ready]);

  function dismiss() {
    closeIntentRef.current = "dismissal";
    onClose();
  }

  function runCommand(command: PaneOverflowCommand) {
    closeIntentRef.current = "activation";
    onRunCommand?.(command);
  }

  function runAction(action: IconToolbarAction) {
    closeIntentRef.current = "activation";
    onRunAction?.(action);
  }

  function handleMenuKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      dismiss();
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const menu = menuRef.current;
    if (!menu) return;
    const items = enabledButtons(menu);
    if (!items.length) return;
    event.preventDefault();
    const activeIndex = items.findIndex((item) => item === document.activeElement);
    const nextIndex = event.key === "Home"
      ? 0
      : event.key === "End"
        ? items.length - 1
        : event.key === "ArrowUp"
          ? activeIndex <= 0 ? items.length - 1 : activeIndex - 1
          : activeIndex < 0 || activeIndex === items.length - 1 ? 0 : activeIndex + 1;
    items[nextIndex]?.focus();
  }

  return createPortal(
    <div
      id={popupId}
      ref={menuRef}
      className="icon-overflow-menu icon-action-manager"
      role="menu"
      aria-label={label}
      data-placement={position.placement}
      style={{
        left: `${position.left}px`,
        top: `${position.top}px`,
        width: position.width === null ? undefined : `${position.width}px`,
        maxHeight: position.maxHeight === null ? undefined : `${position.maxHeight}px`,
        visibility: position.ready ? "visible" : "hidden"
      }}
      onPointerDown={(event) => event.stopPropagation()}
      onKeyDown={handleMenuKeyDown}
    >
      {commands.length ? (
        <div className="icon-action-manager-section" role="group" aria-label={commandSectionLabel}>
          <span className="icon-action-manager-section-label">{commandSectionLabel}</span>
          {commands.map((command) => {
            const CommandIcon = command.icon;
            return (
              <button
                key={command.id}
                type="button"
                role="menuitem"
                aria-label={command.ariaLabel}
                title={command.title}
                disabled={command.disabled}
                onClick={() => runCommand(command)}
              >
                <CommandIcon aria-hidden="true" />
                <span>{command.label}</span>
              </button>
            );
          })}
        </div>
      ) : null}
      <div className="icon-action-manager-scroll">
        <div className="icon-action-manager-section" role="group" aria-label="Toolbar buttons">
          <span className="icon-action-manager-section-label">Toolbar buttons</span>
          {actions.map((action) => {
            const ActionIcon = action.icon;
            const isHidden = hiddenSet.has(action.id);
            const isShown = !isHidden && (primarySet?.has(action.id) ?? true);
            const canHide = action.hideable !== false;
            const stateLabel = isShown ? (canHide ? "Hide" : "Shown") : "Show";
            if (plainActions) {
              return (
                <button
                  key={action.id}
                  type="button"
                  role="menuitem"
                  aria-label={action.ariaLabel}
                  title={action.title}
                  disabled={action.disabled}
                  onClick={() => runAction(action)}
                >
                  <ActionIcon aria-hidden="true" />
                  <span>{action.label}</span>
                </button>
              );
            }
            return (
              <button
                key={action.id}
                type="button"
                role="menuitemcheckbox"
                aria-checked={isShown}
                aria-label={`${stateLabel} ${action.ariaLabel}`}
                disabled={isShown && !canHide}
                onClick={() => (isShown ? onHideAction(action.id) : onShowAction(action.id))}
              >
                <ActionIcon aria-hidden="true" />
                <span>{action.label}</span>
                <span className="icon-action-manager-state">{stateLabel}</span>
              </button>
            );
          })}
        </div>
      </div>
    </div>,
    document.body
  );
}

function TaskHistoryDialog({
  mode,
  paneTitle,
  runtimeLabel,
  items,
  loading,
  error,
  loadMorePending,
  hasMore,
  query,
  onClose,
  onSelect,
  onLoadMore,
  onQueryChange
}: {
  mode: "chat" | "cli";
  paneTitle: string;
  runtimeLabel: string;
  items: TaskHistoryDialogItem[];
  loading: boolean;
  error: string | null;
  loadMorePending: boolean;
  hasMore: boolean;
  query: string;
  onClose: () => void;
  onSelect: (item: TaskHistoryDialogItem) => void;
  onLoadMore: () => void;
  onQueryChange: (query: string) => void;
}) {
  const isChat = mode === "chat";
  let description = `Open an existing Codex thread in ${paneTitle}.`;
  if (!isChat) {
    description = `Shared Space CLI task history. Continue a task in ${paneTitle} with ${runtimeLabel}; the runtime stays unchanged.`;
  }
  return (
    <div className="attachment-modal codex-resume-modal" onClick={onClose}>
      <section
        className="attachment-modal-body codex-resume-modal-body"
        role="dialog"
        aria-modal="true"
        aria-label={isChat ? "Open Codex task history" : "Resume CLI task"}
        onClick={(event) => event.stopPropagation()}
      >
        <button
          type="button"
          className="terminal-upload-modal-close codex-resume-modal-close"
          aria-label={isChat ? "Close task history" : "Close resume task history"}
          onClick={onClose}
        >
          <X aria-hidden="true" />
        </button>
        <div className="codex-resume-modal-header">
          <span className="terminal-upload-modal-label codex-resume-modal-label">
            <History aria-hidden="true" />
            {isChat ? "Task history" : "Resume task"}
          </span>
          <strong>{isChat ? "Codex task history" : "CLI task history"}</strong>
          <small>{description}</small>
        </div>
        <div className="codex-resume-search">
          <Search aria-hidden="true" />
          <input
            type="search"
            aria-label={isChat ? "Search Codex tasks" : "Search CLI tasks"}
            placeholder="Search tasks"
            autoComplete="off"
            autoFocus
            value={query}
            onChange={(event) => onQueryChange(event.currentTarget.value)}
          />
          {query ? (
            <button type="button" aria-label="Clear task search" title="Clear task search" onClick={() => onQueryChange("")}>
              <X aria-hidden="true" />
            </button>
          ) : null}
        </div>
        <div className="vscode-codex-task-list codex-resume-task-list">
          {loading ? (
            <div className="vscode-codex-state" role="status">
              <Loader2 aria-hidden="true" />
              <span>Loading tasks</span>
            </div>
          ) : error ? (
            <div className="vscode-codex-state" role="alert">
              <span>{error}</span>
            </div>
          ) : items.length ? (
            items.map((item) => {
              const runtimeId = "runtimeId" in item ? item.runtimeId : "cli:codex";
              const runtimeBrand = cliRuntimePresentation(runtimeId);
              const itemProviderLabel = "providerLabel" in item ? item.providerLabel : "Codex";
              return (
                <button
                  key={item.id}
                  type="button"
                  className="vscode-codex-task-row"
                  onClick={() => onSelect(item)}
                  aria-label={`${itemProviderLabel} task ${item.title}`}
                >
                  <div className="cli-task-history-row-content">
                    <strong>{item.title}</strong>
                    <span className="cli-task-history-provider">
                      {runtimeBrand ? (
                        <img
                          src={runtimeBrand.iconSrc}
                          alt=""
                          aria-hidden="true"
                          data-terminal-runtime-brand={runtimeBrand.brand}
                          draggable={false}
                        />
                      ) : (
                        <Terminal aria-hidden="true" />
                      )}
                      <span>{itemProviderLabel}</span>
                    </span>
                  </div>
                </button>
              );
            })
          ) : (
            <div className="vscode-codex-state" role="status">
              <span>{isChat ? "No Codex tasks found" : "No CLI tasks found"}</span>
            </div>
          )}
        </div>
        <div className="codex-resume-modal-actions">
          <button type="button" onClick={onClose}>
            Close
          </button>
          {hasMore ? (
            <button type="button" onClick={onLoadMore} disabled={loadMorePending}>
              {loadMorePending ? "Loading..." : "Load more"}
            </button>
          ) : null}
        </div>
      </section>
    </div>
  );
}

function MovePaneDialog({
  paneTitle,
  targetRooms,
  targetRoomId,
  pending,
  error,
  onTargetRoomChange,
  onClose,
  onConfirm
}: {
  paneTitle: string;
  targetRooms: Room[];
  targetRoomId: string;
  pending: boolean;
  error: string | null;
  onTargetRoomChange: (roomId: string) => void;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="attachment-modal codex-resume-modal" onClick={onClose}>
      <section
        className="attachment-modal-body codex-resume-modal-body"
        role="dialog"
        aria-modal="true"
        aria-label="Move pane to another room"
        onClick={(event) => event.stopPropagation()}
      >
        <button type="button" className="terminal-upload-modal-close codex-resume-modal-close" aria-label="Close pane move dialog" onClick={onClose}>
          <X aria-hidden="true" />
        </button>
        <div className="codex-resume-modal-header">
          <span className="terminal-upload-modal-label codex-resume-modal-label">
            <ArrowRightLeft aria-hidden="true" />
            Move pane
          </span>
          <strong>{paneTitle}</strong>
          <small>This v1 moves only inactive panes without live CLI, browser, or agent bindings.</small>
        </div>
        <label className="provider-form-row">
          <span>Target room</span>
          <select
            aria-label="Target room"
            value={targetRoomId}
            disabled={pending || targetRooms.length === 0}
            onChange={(event) => onTargetRoomChange(event.currentTarget.value)}
          >
            {targetRooms.map((room) => (
              <option key={room.id} value={room.id}>
                {room.name}
              </option>
            ))}
          </select>
        </label>
        {error ? (
          <div className="validation-result bad" role="alert">
            {error}
          </div>
        ) : null}
        <div className="codex-resume-modal-actions">
          <button type="button" onClick={onClose} disabled={pending}>
            Cancel
          </button>
          <button type="button" onClick={onConfirm} disabled={pending || !targetRooms.length || !targetRoomId}>
            {pending ? "Moving..." : "Move pane"}
          </button>
        </div>
      </section>
    </div>
  );
}

export function formatTerminalSessionDebugInfo(metadata: TerminalSessionMetadata): { label: string; title: string } | null {
  const runtimeLabel = cliRuntimeLabel(metadata.runtimeId ?? "cli:codex") ?? "Space CLI";
  if (metadata.codexThreadId) {
    return {
      label: metadata.codexThreadId.slice(0, 8),
      title: `${runtimeLabel} session ${metadata.codexThreadId}`
    };
  }
  if (!metadata.sessionId) return null;
  const normalized = metadata.sessionId.replace(/^cli_session:/, "");
  return {
    label: normalized.slice(0, 8),
    title: `${runtimeLabel} session ${metadata.sessionId}`
  };
}

export function formatTerminalSessionClipboardText(metadata: TerminalSessionMetadata): string | null {
  const sessionId = metadata.sessionId?.trim();
  if (!sessionId) return null;
  return [
    `CLI session ID: ${sessionId}`,
    ...(metadata.codexThreadId ? [`Codex thread ID: ${metadata.codexThreadId}`] : [])
  ].join("\n");
}

function dispatchAgentPaneSettingsUpdated(paneId: string | null, session?: AgentPaneSession) {
  window.dispatchEvent(new CustomEvent(AGENT_PANE_SETTINGS_EVENT, { detail: { paneId, session } }));
}

function readStoredTerminalFontSize(): number {
  if (typeof window === "undefined") return DEFAULT_TERMINAL_FONT_SIZE;
  const storedValue = getSpaceRuntime().platform.localStorage.getItem(TERMINAL_FONT_SIZE_STORAGE_KEY);
  if (!storedValue) return DEFAULT_TERMINAL_FONT_SIZE;
  const stored = Number(storedValue);
  if (!Number.isFinite(stored)) return DEFAULT_TERMINAL_FONT_SIZE;
  return Math.min(MAX_TERMINAL_FONT_SIZE, Math.max(MIN_TERMINAL_FONT_SIZE, Math.round(stored)));
}

function readStoredBoolean(key: string): boolean {
  if (typeof window === "undefined") return false;
  return getSpaceRuntime().platform.localStorage.getItem(key) === "true";
}

function hasStoredValue(key: string): boolean {
  if (typeof window === "undefined") return false;
  return getSpaceRuntime().platform.localStorage.getItem(key) !== null;
}

function readStoredBooleanDefaultTrue(key: string): boolean {
  if (typeof window === "undefined") return true;
  const stored = getSpaceRuntime().platform.localStorage.getItem(key);
  return stored === null ? true : stored === "true";
}

function readStoredRoomTheme(): RoomTheme {
  if (typeof window === "undefined") return "graphite";
  const stored = getSpaceRuntime().platform.localStorage.getItem(ROOM_THEME_STORAGE_KEY);
  return roomThemes.some((theme) => theme.id === stored) ? (stored as RoomTheme) : "graphite";
}

function paneToolbarHiddenStorageKey(mode: Pane["mode"]): string {
  if (mode === "CHAT" || mode === "TERMINAL") return SHARED_CODEX_TOOLBAR_HIDDEN_STORAGE_KEY;
  return `${PANE_TOOLBAR_HIDDEN_ACTIONS_STORAGE_KEY_PREFIX}.${mode}`;
}

function paneToolbarActionOrderStorageKey(mode: Pane["mode"]): string {
  if (mode === "CHAT" || mode === "TERMINAL") return SHARED_CODEX_TOOLBAR_ORDER_STORAGE_KEY;
  return `${PANE_TOOLBAR_ACTION_ORDER_STORAGE_KEY_PREFIX}.${mode}`;
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

function dispatchTerminalPaneAction(paneId: string, action: TerminalPaneAction) {
  window.dispatchEvent(new CustomEvent(TERMINAL_PANE_ACTION_EVENT, { detail: { paneId, ...action } }));
}

function terminalPlanModeAction(runtimeId: string): TerminalPaneAction {
  if (runtimeId === "cli:claude") return { action: "ensure_plan_mode" };
  if (runtimeId === "cli:gemini" || runtimeId === "cli:qwen") {
    return { action: "enter_native_plan_mode", runtimeId };
  }
  return { action: "control_key", key: "shift_tab" };
}

function pickCliMemorySaveModelId(models: Model[]): string {
  const exactMatch = models.find((model) => model.id === "gpt-5-mini");
  if (exactMatch) return exactMatch.id;
  const miniCodexModel = models.find((model) => model.providerId === "codex" && /mini/i.test(model.id));
  if (miniCodexModel) return miniCodexModel.id;
  const genericMiniModel = models.find((model) => /mini/i.test(model.id));
  return genericMiniModel?.id ?? "gpt-5-mini";
}

function dispatchAgentPaneAction(paneId: string, action: AgentPaneAction | AgentPaneDetailAction) {
  const detail = typeof action === "string" ? { paneId, action } : { paneId, ...action };
  dispatchAgentPaneActionEvent(detail);
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

function fallbackMemorySearchStatus(mode: MemorySearchMode): MemorySearchStatus {
  return {
    mode,
    keyword: {
      status: "VERIFIED",
      statusReason: "Keyword index is available.",
      checkedAt: null
    },
    semantic: {
      status: "DISABLED",
      statusReason: "Embedding smoke is pending.",
      checkedAt: null
    }
  };
}

function embeddingSmokeRemediation(smoke: MemoryEmbeddingSmokeCheck | null): string | null {
  if (!smoke) return null;
  if (
    smoke.provider === "codex-lb" &&
    smoke.code === "EMBEDDING_PROVIDER_SMOKE_FAILED" &&
    /HTTP\s+(404|405)\b/.test(smoke.message)
  ) {
    return "Codex-LB /v1/embeddings is not available; add a real embeddings endpoint there or switch to a dedicated direct OpenAI embedding key, then rerun smoke.";
  }
  if (smoke.code === "EMBEDDING_KEY_NAME_NOT_DEDICATED") {
    return "Use a dedicated key label that starts with space- before enabling semantic memory.";
  }
  if (smoke.code === "EMBEDDING_CREDENTIAL_MISSING" || smoke.code === "EMBEDDING_KEY_FILE_UNREADABLE") {
    return "Install the dedicated embedding credential file under /opt/spaceapp/secrets with space-readable permissions, then rerun smoke.";
  }
  return null;
}

function buildBlueprintProgressState({
  readiness,
  mcp,
  latestSmoke,
  latestMemoryEmbeddingSmoke,
  latestMemoryVectorReadiness,
  providers,
  skills,
  importCandidates,
  swarmState,
  rooms,
  panes,
  codexAppServer,
  observability,
  workerReadiness
}: BlueprintProgressProps) {
  const dependencies = readiness?.dependencies;
  const verifiedProviders = providers.filter((provider) => provider.status === "VERIFIED").length;
  const codexTurnLive = dependencies?.codexTurns === "enabled" && codexAppServer?.status === "READY";
  const mcpVerified = mcp?.gateway.status === "VERIFIED";
  const workerLive = workerReadiness?.status === "RUNNING" || dependencies?.worker === "RUNNING";
  const vectorReadinessLabel = latestMemoryVectorReadiness?.code
    ? readableCode(latestMemoryVectorReadiness.code)
    : "Vector readiness pending";
  const embeddingSmokeLabel = latestMemoryEmbeddingSmoke?.code
    ? readableCode(latestMemoryEmbeddingSmoke.code)
    : "Embedding smoke pending";
  const progressItems: BlueprintProgressItem[] = [
    {
      label: "Postgres state",
      status: dependencies?.store === "postgres" ? "LIVE" : "GATED",
      detail: dependencies ? `${dependencies.store} canonical state` : "Loading readiness"
    },
    {
      label: "Temporal workflows",
      status: dependencies?.temporal === "enabled" ? "LIVE" : "GATED",
      detail: dependencies ? `Workflow plane ${dependencies.temporal}` : "Loading workflow plane"
    },
    {
      label: "Temporal worker",
      status: workerLive ? "LIVE" : "GATED",
      detail: workerReadiness
        ? `${workerReadiness.status}; ${workerReadiness.workflowPollerCount} workflow / ${workerReadiness.activityPollerCount} activity pollers`
        : dependencies?.worker
          ? `Worker ${dependencies.worker}`
          : "Loading worker readiness"
    },
    {
      label: "Observability",
      status: observability ? "LIVE" : "GATED",
      detail: observability
        ? `${observability.totals.requestCount} requests / p95 ${formatDurationMs(observability.totals.p95Ms)}`
        : "Metrics snapshot loading"
    },
    {
      label: "Rooms and panes",
      status: "LIVE",
      detail: `${rooms.length} rooms / ${panes.length} open panes`
    },
    {
      label: "Memory registry",
      status: "LIVE",
      detail: latestMemoryEmbeddingSmoke?.code
        ? `Keyword active; ${vectorReadinessLabel}; embeddings ${embeddingSmokeLabel}`
        : `Native save/search active; ${vectorReadinessLabel}`
    },
    {
      label: "Skill proposals",
      status: "LIVE",
      detail: `${skills.length} proposals loaded; execution remains gated`
    },
    {
      label: "Import gates",
      status: "LIVE",
      detail: `${importCandidates.filter((candidate) => candidate.status === "PENDING").length} pending explicit imports`
    },
    {
      label: "Browser evidence",
      status: "LIVE",
      detail: "Screenshot, DOM, console and network smoke artifacts"
    },
    {
      label: "Review gate",
      status: "LIVE",
      detail: "Ship/block decisions, evidence IDs and rollback notes"
    },
    {
      label: "MCP execution gate",
      status: mcpVerified ? "LIVE" : "GATED",
      detail: mcp ? `${mcp.gateway.status} / ${mcp.gateway.toolCount} verified tools` : "Loading gateway"
    },
    {
      label: "Codex real turn gated",
      status: codexTurnLive ? "LIVE" : "GATED",
      detail: codexAppServer ? `${codexAppServer.status}: ${readableCode(codexAppServer.reasonCode)}` : "Loading adapter status"
    },
    {
      label: "Provider smoke gated",
      status: verifiedProviders > 0 ? "LIVE" : "GATED",
      detail: verifiedProviders > 0 ? `${verifiedProviders}/${providers.length} providers verified` : "Dedicated credentials required"
    },
    {
      label: "pgvector semantic search",
      status: latestMemoryVectorReadiness?.status === "VERIFIED" && latestMemoryEmbeddingSmoke?.status === "VERIFIED" ? "LIVE" : "GATED",
      detail: `${vectorReadinessLabel}; ${embeddingSmokeLabel}`
    },
    {
      label: "Swarm orchestration",
      status: swarmState ? "LIVE" : "NEXT",
      detail: swarmState
        ? `${swarmState.tasks.length} tasks / ${swarmState.locks.filter((lock) => lock.status === "ACTIVE").length} active locks; execution disabled`
        : "Worktree locks, mailbox and reconcile workflow"
    }
  ];
  const liveCount = progressItems.filter((item) => item.status === "LIVE").length;
  const visibleCount = progressItems.filter((item) => item.status === "LIVE" || item.status === "GATED").length;
  const completionPct = Math.round((liveCount / progressItems.length) * 100);
  const latestSmokeLabel = latestSmoke?.code ? readableCode(latestSmoke.code) : "MCP smoke not run";

  return {
    progressItems,
    liveCount,
    visibleCount,
    completionPct,
    latestSmokeLabel,
    nextItem: progressItems.find((item) => item.status === "NEXT"),
    gatedItems: progressItems.filter((item) => item.status === "GATED")
  };
}

function launchBlockerTone(severity: LaunchBlockerSeverity) {
  if (severity === "hard") return "bad";
  if (severity === "gate") return "muted";
  return "ok";
}

function buildLaunchBlockers(props: BlueprintProgressProps): LaunchBlocker[] {
  const blockers: LaunchBlocker[] = [];
  const dependencies = props.readiness?.dependencies;
  const verifiedProviders = props.providers.filter((provider) => provider.status === "VERIFIED").length;
  const vectorReady =
    props.latestMemoryVectorReadiness?.status === "VERIFIED" &&
    props.latestMemoryVectorReadiness.code === "MEMORY_VECTOR_READY";
  const embeddingReady =
    props.latestMemoryEmbeddingSmoke?.status === "VERIFIED" &&
    props.latestMemoryEmbeddingSmoke.code === "EMBEDDING_SMOKE_OK";

  if (props.storageReadiness && props.storageReadiness.status !== "VERIFIED") {
    blockers.push({
      label: "Dedicated storage volume",
      detail: `${props.storageReadiness.statusReason} App free ${formatBytes(props.storageReadiness.app.availableBytes)}; root used ${props.storageReadiness.root.usedPercent}%.`,
      severity: props.storageReadiness.status === "BLOCKED" ? "hard" : "gate"
    });
  } else if (!props.storageReadiness && props.storageWarning.trim()) {
    blockers.push({
      label: "Dedicated storage volume",
      detail: props.storageWarning,
      severity: "hard"
    });
  }

  if (!props.readiness) {
    blockers.push({
      label: "Readiness snapshot",
      detail: "The API readiness endpoint has not loaded yet.",
      severity: "gate"
    });
  } else if (!props.readiness.ok) {
    blockers.push({
      label: "API readiness",
      detail: `Ready check is not green; worker is ${dependencies?.worker ?? "unknown"}.`,
      severity: "hard"
    });
  }

  if (dependencies && dependencies.store !== "postgres") {
    blockers.push({
      label: "Postgres canonical state",
      detail: `Current store is ${dependencies.store}; production launch requires Postgres as source of truth.`,
      severity: "hard"
    });
  }

  if (dependencies && dependencies.temporal !== "enabled") {
    blockers.push({
      label: "Temporal workflow plane",
      detail: `Temporal is ${dependencies.temporal}; turns, approvals and retries require durable workflows.`,
      severity: "hard"
    });
  }

  if (props.workerReadiness && props.workerReadiness.status !== "RUNNING") {
    blockers.push({
      label: "Temporal worker pollers",
      detail: props.workerReadiness.statusReason,
      severity: "hard"
    });
  }

  if (!props.observability) {
    blockers.push({
      label: "Observability snapshot",
      detail: "Metrics snapshot has not loaded, so launch evidence is incomplete.",
      severity: "gate"
    });
  }

  if (props.codexAppServer?.status !== "READY") {
    blockers.push({
      label: "Codex App Server real turn",
      detail: props.codexAppServer?.statusReason ?? "Adapter status has not loaded.",
      severity: "gate"
    });
  }

  if (verifiedProviders === 0) {
    blockers.push({
      label: "Dedicated provider credential",
      detail: "No provider has passed dedicated credential validation and model refresh.",
      severity: "gate"
    });
  }

  if (props.mcp?.gateway.status !== "VERIFIED") {
    blockers.push({
      label: "MCP discovery and tool allowlist",
      detail: props.mcp?.gateway.statusReason ?? "Gateway status has not loaded.",
      severity: "gate"
    });
  }

  if (!vectorReady || !embeddingReady) {
    const remediation = embeddingSmokeRemediation(props.latestMemoryEmbeddingSmoke);
    blockers.push({
      label: "Semantic memory embeddings",
      detail: vectorReady
        ? remediation ?? `pgvector storage is ready, but embedding provider smoke has not passed${props.latestMemoryEmbeddingSmoke?.message ? `: ${props.latestMemoryEmbeddingSmoke.message}` : "."}`
        : props.latestMemoryVectorReadiness?.message ?? "Vector readiness has not loaded.",
      severity: "gate"
    });
  }

  if (props.swarmState?.executionStatus === "DISABLED") {
    blockers.push({
      label: "Swarm execution gate",
      detail: props.swarmState.statusReason,
      severity: "gate"
    });
  }

  return blockers;
}

export function App() {
  const runtime = getSpaceRuntime();
  const runtimeKind = getSpaceRuntimeKind();
  const { ensureServerSettings } = useVoiceInput();
  migrateLegacyCliToolbarPreferences(runtime.platform.localStorage);
  const [uiTheme] = useState<UiTheme>(() => readUiTheme(runtime.platform.localStorage));
  const [roomToolbarStorageKeys] = useState(() => {
    const storageKeys = uiTheme === "modern"
      ? modernRoomToolbarStorageKeys()
      : {
          hidden: ROOM_TOOLBAR_HIDDEN_ACTIONS_STORAGE_KEY,
          order: ROOM_TOOLBAR_ACTION_ORDER_STORAGE_KEY
        };
    if (uiTheme === "modern") {
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
  const [systemPrefersDark, setSystemPrefersDark] = useState(
    () => typeof window.matchMedia === "function" && window.matchMedia("(prefers-color-scheme: dark)").matches
  );
  const modernColorMode = resolveModernColorMode(modernAppearance, systemPrefersDark);
  useEffect(() => {
    const interval = window.setInterval(() => publishCliVpnRoutingStatus(), 20_000);
    return () => window.clearInterval(interval);
  }, []);
  useEffect(() => {
    const body = document.body;
    if (uiTheme !== "modern") {
      body.removeAttribute("data-ui-theme");
      body.removeAttribute("data-color-mode");
      body.removeAttribute("data-icon-pack");
      return;
    }
    body.setAttribute("data-ui-theme", "modern");
    body.setAttribute("data-color-mode", modernColorMode);
    body.setAttribute("data-icon-pack", modernIconPack);
    return () => {
      if (body.getAttribute("data-ui-theme") === "modern") body.removeAttribute("data-ui-theme");
      if (body.getAttribute("data-color-mode") === modernColorMode) body.removeAttribute("data-color-mode");
      if (body.getAttribute("data-icon-pack") === modernIconPack) body.removeAttribute("data-icon-pack");
    };
  }, [modernColorMode, modernIconPack, uiTheme]);
  const [auth, setAuth] = useState<AuthMe | null>(null);
  const [setupStatus, setSetupStatus] = useState<SetupStatus | null>(null);
  const voiceSettingsAuthUserIdRef = useRef<string | null>(null);

  useEffect(() => {
    const authenticatedUserId = auth?.isAuthenticated ? auth.user?.id ?? "authenticated" : null;
    if (!authenticatedUserId) {
      voiceSettingsAuthUserIdRef.current = null;
      return;
    }
    if (voiceSettingsAuthUserIdRef.current === authenticatedUserId) return;
    voiceSettingsAuthUserIdRef.current = authenticatedUserId;
    void ensureServerSettings();
  }, [auth?.isAuthenticated, auth?.user?.id, ensureServerSettings]);
  const [authBootstrapError, setAuthBootstrapError] = useState<string | null>(null);
  const [appView, setAppView] = useState<AppView>(readAppView);
  const [rooms, setRooms] = useState<Room[]>([]);
  const [roomCliActivityCounts, setRoomCliActivityCounts] = useState<Record<string, number>>({});
  const [selectedRoomId, setSelectedRoomId] = useState<string | null>(() => readStoredSessionString(SELECTED_ROOM_ID_STORAGE_KEY));
  const [roomRuntimes, setRoomRuntimes] = useState<Record<string, RoomRuntimeSnapshot>>({});
  const [roomPaneLoadStates, setRoomPaneLoadStates] = useState<Record<string, RoomPaneLoadState>>({});
  const [displayedRoomId, setDisplayedRoomId] = useState<string | null>(selectedRoomId);
  const [preparingRoomId, setPreparingRoomId] = useState<string | null>(null);
  const [panes, setPanes] = useState<Pane[]>([]);
  const [selectedPaneId, setSelectedPaneId] = useState<string | null>(() => readStoredSessionString(SELECTED_PANE_ID_STORAGE_KEY));
  const [shellMode, setShellMode] = useState<ShellMode>(() => detectUiThemeShellMode(readViewportWidth(), uiTheme));
  const [turns, setTurns] = useState<Turn[]>([]);
  const [roomEvents, setRoomEvents] = useState<SpaceEvent[]>([]);
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
  const [storageWarning, setStorageWarning] = useState<string>("");
  const [clipboardNotice, setClipboardNotice] = useState<string | null>(null);
  const [clipToolNotice, setClipToolNotice] = useState<string | null>(null);
  useAutoDismiss(clipToolNotice, setClipToolNotice);
  const [codexEnvironmentSummary, setCodexEnvironmentSummary] = useState<CodexEnvironment | null>(null);
  const isCodexEnabled = codexEnvironmentSummary?.isCodexEnabled ?? true;
  const [cliRuntimeSettings, setCliRuntimeSettings] = useState<CliRuntimeSettingsResponse | null>(null);
  const anyCliEnabled = cliRuntimeSettings?.settings.some((setting) => setting.enabled) ?? true;
  const [activeSideSurface, setActiveSideSurface] = useState<SideSurface>("rooms");
  const [isRoomFocusMode, setIsRoomFocusMode] = useState(() => readStoredBoolean(ROOM_FOCUS_MODE_STORAGE_KEY));
  const [isRoomToolbarHidden, setIsRoomToolbarHidden] = useState(() => readStoredBoolean(ROOM_TOOLBAR_HIDDEN_STORAGE_KEY));
  const [isMobilePaneFocusMode, setIsMobilePaneFocusMode] = useState(false);
  const [isDesktopSideSurfaceOpen, setIsDesktopSideSurfaceOpen] = useState(() => !readStoredBoolean(SIDE_SURFACE_HIDDEN_STORAGE_KEY));
  const [isCompactSideSurfaceOpen, setIsCompactSideSurfaceOpen] = useState(false);
  const compactSideSurfaceRef = useRef<HTMLElement>(null);
  const compactSideSurfaceTriggerRef = useRef<HTMLElement | null>(null);
  const [terminalFontSize, setTerminalFontSize] = useState(readStoredTerminalFontSize);
  const [cliImagePreviewLimit, setCliImagePreviewLimit] = useState(readStoredCliImagePreviewLimit);
  const [warmRoomEnabled, setWarmRoomEnabled] = useState(readStoredWarmRoomEnabled);
  const [suppressNotifications, setSuppressNotifications] = useState(readStoredSuppressNotifications);
  const [warmRoomCapacity, setWarmRoomCapacity] = useState<WarmRoomCapacitySnapshot>(() =>
    snapshotWarmRoomCapacity({
      memory: {
        source: "fallback",
        usedBytes: null,
        heapLimitBytes: null,
        deviceMemoryBytes: null
      },
      hydrationSamples: [],
      warmRoomCount: 0,
      connectedPaneCount: 0,
      hardwareConcurrency: undefined,
      pressureReasons: [],
      overcommitInUse: false
    })
  );
  const [automaticWarmFillSuppressed, setAutomaticWarmFillSuppressed] = useState(false);
  const [showSessionDebugIds, setShowSessionDebugIds] = useState(() => readStoredBooleanDefaultTrue(SESSION_DEBUG_IDS_STORAGE_KEY));
  const [cliDebugModeEnabled, setCliDebugModeEnabled] = useState(() => readStoredBoolean(CLI_DEBUG_MODE_STORAGE_KEY));
  const [cliFloatsHidden, setCliFloatsHidden] = useState(() => readStoredBoolean(CLI_FLOATS_HIDDEN_STORAGE_KEY));
  const [maskSensitiveData, setMaskSensitiveData] = useState(() =>
    readStoredBoolean(SPACE_SENSITIVE_DATA_MASKED_STORAGE_KEY)
  );
  const [roomTheme, setRoomTheme] = useState<RoomTheme>(readStoredRoomTheme);
  useEffect(() => {
    const body = document.body;
    if (uiTheme !== "modern") {
      body.removeAttribute("data-room-theme");
      return;
    }
    body.setAttribute("data-room-theme", roomTheme);
    return () => {
      if (body.getAttribute("data-room-theme") === roomTheme) {
        body.removeAttribute("data-room-theme");
      }
    };
  }, [roomTheme, uiTheme]);
  const [isThemeMenuOpen, setIsThemeMenuOpen] = useState(false);
  const [isPaneLayoutMenuOpen, setIsPaneLayoutMenuOpen] = useState(false);
  const [paneLayoutPending, setPaneLayoutPending] = useState(false);
  const [paneLayoutError, setPaneLayoutError] = useState<string | null>(null);
  const [isPaneSpanAllMenuOpen, setIsPaneSpanAllMenuOpen] = useState(false);
  const [paneSpanAllPending, setPaneSpanAllPending] = useState(false);
  const [paneSpanAllError, setPaneSpanAllError] = useState<string | null>(null);
  const [isWorkspaceTextSizePickerOpen, setIsWorkspaceTextSizePickerOpen] = useState(false);
  const [isCliLauncherOpen, setIsCliLauncherOpen] = useState(false);
  const [cliPaneCreationPending, setCliPaneCreationPending] = useState(false);
  const [isVibeMusicOpen, setIsVibeMusicOpen] = useState(false);
  const [isOskKeyboardOpen, setIsOskKeyboardOpen] = useState(false);
  const [isServerActionsMenuOpen, setIsServerActionsMenuOpen] = useState(false);
  const [isSetupConnectionsOpen, setIsSetupConnectionsOpen] = useState(false);
  const [isServerRestartDialogOpen, setIsServerRestartDialogOpen] = useState(false);
  const [adminCodexTool, setAdminCodexTool] = useState<AdminCodexTool | null>(null);
  const [adminOperationTool, setAdminOperationTool] = useState<AdminOperationTool | null>(null);
  const [serverRestartPending, setServerRestartPending] = useState(false);
  const [serverRestartMessage, setServerRestartMessage] = useState<string | null>(null);
  const [serverRestartError, setServerRestartError] = useState<string | null>(null);
  useAutoDismiss(serverRestartMessage, setServerRestartMessage);
  useAutoDismiss(serverRestartError, setServerRestartError);
  const [isCliRuntimeRestartAllDialogOpen, setIsCliRuntimeRestartAllDialogOpen] = useState(false);
  const [cliRuntimeRestartAllPending, setCliRuntimeRestartAllPending] = useState(false);
  const [cliRuntimeRestartAllMessage, setCliRuntimeRestartAllMessage] = useState<string | null>(null);
  const [cliRuntimeRestartAllError, setCliRuntimeRestartAllError] = useState<string | null>(null);
  useAutoDismiss(cliRuntimeRestartAllMessage, setCliRuntimeRestartAllMessage);
  useAutoDismiss(cliRuntimeRestartAllError, setCliRuntimeRestartAllError);
  const [restoreAllPending, setRestoreAllPending] = useState(false);
  const [isRoomRenameOpen, setIsRoomRenameOpen] = useState(false);
  const [isMemoryWorkspaceOpen, setIsMemoryWorkspaceOpen] = useState(false);
  const [systemAnalyticsTab, setSystemAnalyticsTab] = useState<SystemAnalyticsTab | null>(null);
  const [activeUserLink, setActiveUserLink] = useState<UserLink | null>(null);
  const [isQuickLinksOpen, setIsQuickLinksOpen] = useState(false);
  const [roomNameDraft, setRoomNameDraft] = useState("");
  const [roomRenamePending, setRoomRenamePending] = useState(false);
  const [roomRenameError, setRoomRenameError] = useState<string | null>(null);
  useAutoDismiss(roomRenameError, setRoomRenameError);
  const [isRoomToolbarStacked, setIsRoomToolbarStacked] = useState(false);
  const [paneMoveDialog, setPaneMoveDialog] = useState<{
    pane: Pane;
    targetRoomId: string;
    pending: boolean;
    error: string | null;
  } | null>(null);
  const [warmRoomAdmissionDecision, setWarmRoomAdmissionDecision] =
    useState<WarmRoomAdmissionDecision | null>(null);
  const [paneMoveNotice, setPaneMoveNotice] = useState<string | null>(null);
  const [roomReorderPending, setRoomReorderPending] = useState(false);
  const [draggedRoomId, setDraggedRoomId] = useState<string | null>(null);
  const [dragOverRoomId, setDragOverRoomId] = useState<string | null>(null);
  const [paneReorderPending, setPaneReorderPending] = useState(false);
  const [draggedPaneId, setDraggedPaneId] = useState<string | null>(null);
  const [paneDragOverId, setPaneDragOverId] = useState<string | null>(null);
  const [lifecycleDebugSnapshot, setLifecycleDebugSnapshot] = useState<LifecycleDebugSnapshot>(() => readLifecycleDebugSnapshot());
  const [error, setError] = useState<string | null>(null);
  const [roomCreationPending, setRoomCreationPending] = useState(false);
  const [deletePendingRoomId, setDeletePendingRoomId] = useState<string | null>(null);
  const [paneCompletionLifecycle, setPaneCompletionLifecycle] = useState<PaneCompletionLifecycleState>(
    createPaneCompletionLifecycleState
  );
  const [paneGridWidth, setPaneGridWidth] = useState(() => readViewportWidth());
  const [pendingBrowserHandoffPaneId, setPendingBrowserHandoffPaneId] = useState<string | null>(null);
  const [activeRoomEventStreamStatus, setActiveRoomEventStreamStatus] = useState<ActiveRoomEventStreamStatus>("idle");
  const cliMemorySaveModelId = useMemo(() => pickCliMemorySaveModelId(models), [models]);
  const previousShellModeRef = useRef<ShellMode | null>(null);
  const mobileRoomFocusDefaultAppliedRef = useRef(false);
  const hasStoredRoomFocusPreferenceRef = useRef(hasStoredValue(ROOM_FOCUS_MODE_STORAGE_KEY));
  const mobilePaneFocusRoomIdRef = useRef(selectedRoomId);
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
  const roomRuntimeLastPolledAtRef = useRef(new Map<string, number>());
  const roomRefreshQueueRef = useRef(createCoalescedRefreshQueue());
  const roomCatalogRefreshQueueRef = useRef(createCoalescedRefreshQueue());
  const requestRoomCatalogRefreshRef = useRef<() => Promise<void>>(async () => undefined);
  const warmRoomIdsRef = useRef<string[]>([]);
  const warmRoomCapacityRef = useRef(warmRoomCapacity);
  const warmRoomCapacityControllerRef = useRef(createWarmRoomCapacityController({ nowMs: Date.now() }));
  const warmRoomHydrationSamplesRef = useRef<WarmRoomHydrationSample[]>([]);
  const startupWarmFillReadyRef = useRef(false);
  const startupWarmFillRoomIdsRef = useRef(new Set<string>());
  const automaticWarmFillSuppressedByOutputPressureRef = useRef(false);
  const lastOutputPressureEvictionAtRef = useRef(0);
  const outputPressureEvictedAtByRoomIdRef = useRef(new Map<string, number>());
  const warmRoomAdmissionSequenceRef = useRef(0);
  const roomAdmissionFlightsRef = useRef(new Map<string, Promise<void>>());
  const pendingTerminalOutputPressureRef = useRef(new Map<string, TerminalOutputPressureDetail>());
  const appMountedRef = useRef(true);
  const roomPaneLoadStatesRef = useRef(roomPaneLoadStates);
  const clipImageInputRef = useRef<HTMLInputElement | null>(null);
  const pendingClipImageTargetRef = useRef<ClipImageTarget | null>(null);
  const boardToolbarRef = useRef<HTMLDivElement | null>(null);
  const roomToolbarActionsRef = useRef<HTMLDivElement | null>(null);
  const roomToolbarScrollRef = useRef<HTMLDivElement | null>(null);
  const roomOverflowTriggerRef = useRef<HTMLButtonElement | null>(null);
  const cliLauncherButtonRef = useRef<HTMLButtonElement | null>(null);
  const cliLauncherReturnFocusRef = useRef<HTMLButtonElement | null>(null);
  const cliPaneCreationPendingRef = useRef(false);
  const roomCreationPendingRef = useRef(false);
  const workspaceTextSizeButtonRef = useRef<HTMLButtonElement | null>(null);
  const vibeMusicButtonRef = useRef<HTMLButtonElement | null>(null);
  const paneLayoutButtonRef = useRef<HTMLButtonElement | null>(null);
  const paneSpanAllButtonRef = useRef<HTMLButtonElement | null>(null);
  const roomThemeButtonRef = useRef<HTMLButtonElement | null>(null);
  const serverActionsButtonRef = useRef<HTMLButtonElement | null>(null);
  const toolbarMetricsRef = useRef<ToolbarMetricsHandle | null>(null);
  const adminCodexToolTriggerRef = useRef<HTMLButtonElement | null>(null);
  const adminOperationToolTriggerRef = useRef<HTMLButtonElement | null>(null);
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
  warmRoomCapacityRef.current = warmRoomCapacity;
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
      if (nextRoom) {
        await loadRoomRuntimeRef.current(nextRoom.id);
        if (!appMountedRef.current) return;
        setError(`Room ${missingRoomId} no longer exists; switched to ${nextRoom.name}.`);
        return;
      }
      setError(`Room ${missingRoomId} no longer exists.`);
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

  function closeAdminCodexTool() {
    setAdminCodexTool(null);
    window.requestAnimationFrame(() => adminCodexToolTriggerRef.current?.focus());
  }

  function closeAdminOperationTool() {
    setAdminOperationTool(null);
    window.requestAnimationFrame(() => adminOperationToolTriggerRef.current?.focus());
  }

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

  useEffect(() => {
    const syncViewFromLocation = () => {
      const nextView = readAppView();
      if (nextView === "help") setIsVibeMusicOpen(false);
      setAppView(nextView);
    };
    window.addEventListener("popstate", syncViewFromLocation);
    return () => window.removeEventListener("popstate", syncViewFromLocation);
  }, []);

  useEffect(() => {
    document.title = appView === "help" ? "Space Help" : "Space";
  }, [appView]);

  useEffect(() => {
    let dismissTimer: number | null = null;
    const handleClipboardNotice = (event: Event) => {
      const detail = (event as CustomEvent<{ message?: unknown }>).detail;
      if (typeof detail?.message !== "string" || !detail.message.trim()) return;
      setClipboardNotice(detail.message);
      if (dismissTimer !== null) window.clearTimeout(dismissTimer);
      dismissTimer = window.setTimeout(() => setClipboardNotice(null), 5_000);
    };
    window.addEventListener(SPACE_CLIPBOARD_NOTICE_EVENT, handleClipboardNotice);
    return () => {
      if (dismissTimer !== null) window.clearTimeout(dismissTimer);
      window.removeEventListener(SPACE_CLIPBOARD_NOTICE_EVENT, handleClipboardNotice);
    };
  }, []);

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
    pendingTerminalOutputPressureRef.current.delete(roomId);
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

  function currentWarmRoomUsage(): { warmRoomCount: number; connectedPaneCount: number } {
    const admittedRoomIds = new Set(warmRoomIdsRef.current);
    if (selectedRoomIdRef.current) admittedRoomIds.add(selectedRoomIdRef.current);
    let totalConnectedPanes = 0;
    for (const roomId of admittedRoomIds) {
      const runtimeSnapshot = roomRuntimesRef.current[roomId];
      const runtimePanes = roomId === selectedRoomIdRef.current
        ? panesRef.current
        : runtimeSnapshot?.panes ?? [];
      totalConnectedPanes += connectedPaneCount(
        runtimePanes,
        runtimeSnapshot?.bootstrappedPaneIds ?? []
      );
    }
    return {
      warmRoomCount: admittedRoomIds.size,
      connectedPaneCount: totalConnectedPanes
    };
  }

  function setAutomaticWarmFillSuppression(next: boolean) {
    automaticWarmFillSuppressedByOutputPressureRef.current = next;
    setAutomaticWarmFillSuppressed(next);
  }

  function commitWarmRoomCapacity(next: WarmRoomCapacitySnapshot): WarmRoomCapacitySnapshot {
    const previous = warmRoomCapacityRef.current;
    warmRoomCapacityRef.current = next;
    setWarmRoomCapacity(next);
    if (previous.overcommitInUse && !next.overcommitInUse) {
      emitWarmRoomCapacityDiagnostic(next, "REVOKE");
    }
    if (previous.pressureReasons.length === 0 && next.pressureReasons.length > 0) {
      emitWarmRoomCapacityDiagnostic(next, "PRESSURE");
    }
    const allowedRoomCount = next.effectiveSafeRoomCapacity + (next.overcommitInUse ? 1 : 0);
    const excessRoomCount = Math.max(0, warmRoomIdsRef.current.length - allowedRoomCount);
    if (excessRoomCount <= 0) return next;
    const evictions = selectHiddenRoomEvictionIds({
      candidates: Object.values(roomRuntimesRef.current).map((runtimeSnapshot) => ({
        roomId: runtimeSnapshot.roomId,
        attachedPaneCount: connectedPaneCount(
          runtimeSnapshot.panes,
          runtimeSnapshot.bootstrappedPaneIds
        ),
        lastAccessedAt: runtimeSnapshot.lastAccessedAt
      })),
      protectedRoomIds: [
        selectedRoomIdRef.current,
        displayedRoomIdRef.current,
        preparingRoomIdRef.current
      ].filter((roomId): roomId is string => Boolean(roomId)),
      evictionCount: excessRoomCount
    });
    for (const roomId of evictions) {
      removeRoomRuntime(roomId);
      emitWarmRoomCapacityDiagnostic(next, "EVICT");
    }
    return next;
  }

  async function sampleWarmRoomCapacity(): Promise<WarmRoomCapacitySnapshot> {
    const memory = await readBrowserWarmRoomMemoryTelemetry();
    const usage = currentWarmRoomUsage();
    const base = snapshotWarmRoomCapacity({
      memory,
      hydrationSamples: warmRoomHydrationSamplesRef.current,
      warmRoomCount: usage.warmRoomCount,
      connectedPaneCount: usage.connectedPaneCount,
      hardwareConcurrency: navigator.hardwareConcurrency,
      pressureReasons: [],
      overcommitInUse: warmRoomCapacityRef.current.overcommitInUse
    });
    const next = commitWarmRoomCapacity(
      warmRoomCapacityControllerRef.current.sample(base, Date.now())
    );
    if (
      automaticWarmFillSuppressedByOutputPressureRef.current &&
      next.pressureReasons.length === 0 &&
      Date.now() - lastOutputPressureEvictionAtRef.current >= WARM_ROOM_PRESSURE_WINDOW_MS
    ) {
      setAutomaticWarmFillSuppression(false);
    }
    emitWarmRoomCapacityDiagnostic(next, "SAMPLE");
    return next;
  }

  async function recordWarmRoomHydrationCost(
    roomId: string,
    beforeMemory: Promise<Awaited<ReturnType<typeof readBrowserWarmRoomMemoryTelemetry>>>
  ): Promise<void> {
    const [before, after] = await Promise.all([
      beforeMemory,
      readBrowserWarmRoomMemoryTelemetry()
    ]);
    const runtimeSnapshot = roomRuntimesRef.current[roomId];
    if (
      before.source !== after.source ||
      before.usedBytes === null ||
      after.usedBytes === null ||
      !runtimeSnapshot
    ) return;
    const deltaBytes = after.usedBytes - before.usedBytes;
    const paneCount = connectedPaneCount(
      runtimeSnapshot.panes,
      runtimeSnapshot.bootstrappedPaneIds
    );
    if (deltaBytes <= 0 || paneCount <= 0) return;
    warmRoomHydrationSamplesRef.current = [
      ...warmRoomHydrationSamplesRef.current,
      { deltaBytes, paneCount }
    ].slice(-8);
    await sampleWarmRoomCapacity();
  }

  function roomRuntimeEligibleForPressureEviction(roomId: string): boolean {
    return Boolean(roomRuntimesRef.current[roomId]) &&
      roomId !== selectedRoomIdRef.current &&
      roomId !== displayedRoomIdRef.current &&
      roomId !== preparingRoomIdRef.current;
  }

  function evictRoomRuntimeForOutputPressure(
    roomId: string,
    detail: TerminalOutputPressureDetail
  ): boolean {
    if (!roomRuntimeEligibleForPressureEviction(roomId)) return false;
    setAutomaticWarmFillSuppression(true);
    const nowMs = Date.now();
    lastOutputPressureEvictionAtRef.current = nowMs;
    outputPressureEvictedAtByRoomIdRef.current.set(roomId, nowMs);
    removeRoomRuntime(roomId);
    emitAppDiagnosticsPerformance({
      category: "PERFORMANCE",
      metric: "TERMINAL_OUTPUT_PRESSURE",
      roomId,
      phase: "EVICTED",
      bufferedBytes: Math.floor(detail.bufferedBytes),
      bufferedEvents: Math.floor(detail.bufferedEvents),
      totalBufferedBytes: Math.floor(detail.totalBufferedBytes)
    });
    recordLifecycleDebugEvent({
      type: "terminal_output_pressure_eviction",
      scope: "App",
      detail: `room=${roomId}`,
      notify: false
    });
    return true;
  }

  function commitLocalTerminalOutputPressureResolution(): WarmRoomCapacitySnapshot {
    return commitWarmRoomCapacity(
      warmRoomCapacityControllerRef.current.resolveTerminalOutputPressureLocally(
        currentWarmRoomUsage()
      )
    );
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
    if (roomTerminalBarrierReady(roomId)) return;
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
    if (roomTerminalPrefillBarrierReady(roomId)) return true;
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
    const readyPaneIds = roomRevealReadyPaneIdsRef.current.get(roomId) ?? new Set<string>();
    if (!visibleTerminalPaneIds(snapshot).every((paneId) => readyPaneIds.has(paneId))) return;
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
    readyPaneIds.add(paneId);
    roomRevealReadyPaneIdsRef.current.set(roomId, readyPaneIds);
    finishPreparingRoomWhenReady(roomId);
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
        recordRoomPresentationMetric(roomId, generation, "ERROR");
        if (outgoingDisplayedRoomId && roomRuntimesRef.current[outgoingDisplayedRoomId]) {
          activateRoom(outgoingDisplayedRoomId);
          setError("The target room did not become paint-ready. The previous room was preserved; try again.");
          return;
        }
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

  async function loadRoomPanes(roomId: string) {
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
        panePayload = await api.panes(roomId);
      } catch (error) {
        if (!appMountedRef.current) return;
        if (roomPaneRequestSequenceRef.current.get(roomId) !== sequence) return;
        if (!roomRuntimesRef.current[roomId]) {
          pendingTerminalOutputPressureRef.current.delete(roomId);
        }
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
      const pendingPressure = pendingTerminalOutputPressureRef.current.get(roomId);
      if (pendingPressure && evictRoomRuntimeForOutputPressure(roomId, pendingPressure)) {
        commitLocalTerminalOutputPressureResolution();
        return;
      }
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
    options: { loadMetadata?: boolean } = {}
  ) {
    const startedAt = performance.now();
    const memoryBeforeHydration = readBrowserWarmRoomMemoryTelemetry();
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
      await loadRoomPanes(roomId);
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
      void recordWarmRoomHydrationCost(roomId, memoryBeforeHydration);
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
      protectedRoomIds: [displayedRoomId, preparingRoomId]
        .filter((roomId): roomId is string => Boolean(roomId)),
      preferredRoomIds,
      previousRoomId: previousWarmRoomIdRef.current,
      maxWarmRooms:
        warmRoomCapacity.effectiveSafeRoomCapacity +
        (warmRoomCapacity.overcommitInUse ? 1 : 0),
      maxAttachedPanes: warmRoomCapacity.overcommitInUse
        ? warmRoomCapacity.hardPaneCapacity
        : warmRoomCapacity.safePaneCapacity,
      candidates
    });
  }, [
    displayedRoomId,
    panes,
    preparingRoomId,
    roomRuntimes,
    rooms,
    selectedRoomId,
    warmRoomCapacity.effectiveSafeRoomCapacity,
    warmRoomCapacity.hardPaneCapacity,
    warmRoomCapacity.overcommitInUse,
    warmRoomCapacity.safePaneCapacity,
    warmRoomEnabled
  ]);
  warmRoomIdsRef.current = warmRoomIds;
  const warmRoomLiveCapacity: WarmRoomCapacitySnapshot = {
    ...warmRoomCapacity,
    ...currentWarmRoomUsage()
  };

  useEffect(() => {
    const retainedRoomIds = new Set([
      ...warmRoomIds,
      ...roomRuntimeHydrationIdsRef.current,
      selectedRoomId,
      displayedRoomId,
      preparingRoomId
    ].filter((roomId): roomId is string => Boolean(roomId)));
    for (const roomId of Object.keys(roomRuntimesRef.current)) {
      if (!retainedRoomIds.has(roomId)) removeRoomRuntime(roomId);
    }
    // Runtime disposal is driven only by the controller-owned admitted set.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [displayedRoomId, preparingRoomId, selectedRoomId, warmRoomIds]);

  useEffect(() => {
    if (warmRoomEnabled) return;
    commitWarmRoomCapacity(
      warmRoomCapacityControllerRef.current.setOvercommitInUse(false)
    );
    for (const roomId of Object.keys(roomRuntimesRef.current)) {
      if (roomId !== selectedRoomId && roomId !== displayedRoomId) removeRoomRuntime(roomId);
    }
    // removeRoomRuntime is intentionally kept outside the dependency list; the policy reacts only
    // to the browser-local cache setting and the requested/presented room identities.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [displayedRoomId, selectedRoomId, warmRoomEnabled]);

  useEffect(() => {
    const handleTerminalOutputPressure = (event: Event) => {
      if (!(event instanceof CustomEvent) || typeof event.detail !== "object" || event.detail === null) return;
      const detail = event.detail as Partial<{
        roomId: string;
        paneId: string;
        bufferedBytes: number;
        bufferedEvents: number;
        totalBufferedBytes: number;
        reason: string;
      }>;
      if (
        typeof detail.roomId !== "string" ||
        typeof detail.paneId !== "string" ||
        typeof detail.bufferedBytes !== "number" ||
        typeof detail.bufferedEvents !== "number" ||
        typeof detail.totalBufferedBytes !== "number" ||
        !Number.isFinite(detail.bufferedBytes) ||
        !Number.isFinite(detail.bufferedEvents) ||
        !Number.isFinite(detail.totalBufferedBytes) ||
        (detail.reason !== "PANE_LIMIT" && detail.reason !== "TOTAL_LIMIT")
      ) return;
      const pressure: TerminalOutputPressureDetail = {
        roomId: detail.roomId,
        paneId: detail.paneId,
        bufferedBytes: detail.bufferedBytes,
        bufferedEvents: detail.bufferedEvents,
        totalBufferedBytes: detail.totalBufferedBytes,
        reason: detail.reason
      };
      if (
        pressure.roomId === selectedRoomIdRef.current ||
        pressure.roomId === displayedRoomIdRef.current ||
        pressure.roomId === preparingRoomIdRef.current
      ) {
        pendingTerminalOutputPressureRef.current.set(pressure.roomId, pressure);
        return;
      }
      if (pressure.reason === "PANE_LIMIT") {
        if (evictRoomRuntimeForOutputPressure(pressure.roomId, pressure)) {
          commitLocalTerminalOutputPressureResolution();
          return;
        }
        if (
          roomRuntimesRef.current[pressure.roomId] ||
          roomPaneLoadPromisesRef.current.has(pressure.roomId)
        ) {
          pendingTerminalOutputPressureRef.current.set(pressure.roomId, pressure);
          return;
        }
        commitWarmRoomCapacity(
          warmRoomCapacityControllerRef.current.recordTerminalOutputPressure(
            Date.now(),
            currentWarmRoomUsage()
          )
        );
        return;
      }
      const hiddenCandidates = Object.values(roomRuntimesRef.current)
        .filter((runtime) =>
          runtime.roomId !== selectedRoomIdRef.current &&
          runtime.roomId !== displayedRoomIdRef.current &&
          runtime.roomId !== preparingRoomIdRef.current
        )
        .sort((left, right) =>
          left.lastAccessedAt - right.lastAccessedAt || left.roomId.localeCompare(right.roomId)
        );
      const evicted = hiddenCandidates[0];
      if (evicted && evictRoomRuntimeForOutputPressure(evicted.roomId, pressure)) {
        commitLocalTerminalOutputPressureResolution();
        return;
      }
      commitWarmRoomCapacity(
        warmRoomCapacityControllerRef.current.recordTerminalOutputPressure(
          Date.now(),
          currentWarmRoomUsage()
        )
      );
    };
    window.addEventListener("space:terminal-output-pressure", handleTerminalOutputPressure);
    return () => window.removeEventListener("space:terminal-output-pressure", handleTerminalOutputPressure);
  }, []);

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

  useEffect(() => {
    let performanceObserver: PerformanceObserver | null = null;
    if (typeof PerformanceObserver === "function") {
      try {
        performanceObserver = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            if (entry.entryType !== "longtask" || entry.duration < 100) continue;
            commitWarmRoomCapacity(
              warmRoomCapacityControllerRef.current.recordLongTask(
                entry.duration,
                Date.now(),
                currentWarmRoomUsage()
              )
            );
          }
        });
        performanceObserver.observe({ entryTypes: ["longtask"] });
      } catch {
        performanceObserver = null;
      }
    }

    let expectedTickAt = performance.now() + 1_000;
    const driftTimer = window.setInterval(() => {
      const now = performance.now();
      const driftMs = Math.max(0, now - expectedTickAt);
      expectedTickAt = now + 1_000;
      if (document.visibilityState === "hidden" || driftMs < 250) return;
      commitWarmRoomCapacity(
        warmRoomCapacityControllerRef.current.recordEventLoopDrift(
          driftMs,
          Date.now(),
          currentWarmRoomUsage()
        )
      );
    }, 1_000);
    const sampleTimer = window.setInterval(() => {
      if (document.visibilityState !== "hidden") void sampleWarmRoomCapacity();
    }, 10_000);
    const handleVisibilityChange = () => {
      const visible = document.visibilityState !== "hidden";
      commitWarmRoomCapacity(
        warmRoomCapacityControllerRef.current.setVisibility(visible, Date.now())
      );
      expectedTickAt = performance.now() + 1_000;
      if (visible) void sampleWarmRoomCapacity();
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    void sampleWarmRoomCapacity();
    return () => {
      performanceObserver?.disconnect();
      window.clearInterval(driftTimer);
      window.clearInterval(sampleTimer);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
    // The controller reads synchronized refs and owns its bounded timers.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    for (const [roomId, detail] of pendingTerminalOutputPressureRef.current) {
      if (!roomRuntimesRef.current[roomId]) {
        pendingTerminalOutputPressureRef.current.delete(roomId);
        continue;
      }
      if (evictRoomRuntimeForOutputPressure(roomId, detail)) {
        commitLocalTerminalOutputPressureResolution();
      }
    }
    // The eviction helpers operate exclusively on synchronized refs; this effect is triggered by
    // room presentation identity changes, not by function identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [displayedRoomId, preparingRoomId, selectedRoomId]);

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

  async function recoverMissingRoom(missingRoomId: string) {
    const roomPayload = await api.rooms();
    const nextRoomId = roomPayload.data[0]?.id ?? null;
    setRooms(sortRoomsByOrder(roomPayload.data));
    activateRoom(nextRoomId, { preserveOutgoing: false });
    if (nextRoomId) {
      await loadRoomRuntime(nextRoomId);
      setError(`Room ${missingRoomId} no longer exists; switched to ${roomPayload.data[0]?.name ?? "the next room"}.`);
      return;
    }
    setPanes([]);
    setSelectedPaneId(null);
    setTurns([]);
    setRoomEvents([]);
    setSwarmState(await api.swarm());
    setError(`Room ${missingRoomId} no longer exists.`);
  }

  async function refreshRoomEvents(roomId: string) {
    const eventPayload = await api.events({ roomId, pageSize: 50, sortOrder: "desc" });
    hydratePaneCompletionEvents(roomId, eventPayload.data);
    setRoomEvents([...eventPayload.data]);
  }

  const appendRoomEvent = useCallback((event: SpaceEvent, applyCompletion = true) => {
    if (applyCompletion) {
      commitPaneCompletionLifecycle(applyPaneCompletionEvents(paneCompletionLifecycleRef.current, [event]));
    }
    setRoomEvents((current) => mergeSpaceEvents(current, event));
  }, []);

  async function refresh() {
    // Prefetch CLI runtime registry before terminal panes mount so multi-pane rooms share one flight.
    api.warmCliRuntimes();
    const me = await api.me();
    const nextSetupStatus: SetupStatus =
      me.isAuthenticated && !me.isSetupRequired
        ? { setupRequired: false, expiresAt: null }
        : await api.setupStatus();
    setSetupStatus(nextSetupStatus);
    setAuth(me);
    setAuthBootstrapError(null);
    if (!me.isAuthenticated) return;
    if (me.user?.role === "ADMIN") api.warmCliRuntimeSettings();

    let roomPayload = await api.rooms();
    if (me.user?.role === "ADMIN" && me.user?.automationScope !== "APP_DIAGNOSTICS") {
      const recovery = await api.openCliMaintenanceRecovery().catch(() => {
        setError("Scheduled CLI Recovery handoffs could not be opened automatically.");
        return null;
      });
      if (recovery?.room && !roomPayload.data.some((room) => room.id === recovery.room?.id)) {
        roomPayload = await api.rooms();
      }
    }
    if (
      selectedRoomId &&
      !roomPayload.data.some((room) => room.id === selectedRoomId) &&
      roomPayload.pagination.totalPages > 1
    ) {
      roomPayload = {
        ...roomPayload,
        data: await loadBoundedRoomCatalog()
      };
    }
    setRooms(sortRoomsByOrder(roomPayload.data));
    startupWarmFillRoomIdsRef.current = new Set(roomPayload.data.map((room) => room.id));
    const selectedRoomStillExists = selectedRoomId ? roomPayload.data.some((room) => room.id === selectedRoomId) : false;
    const nextRoomId = selectedRoomStillExists ? selectedRoomId : roomPayload.data[0]?.id ?? null;
    activateRoom(nextRoomId, { preserveOutgoing: selectedRoomStillExists });
    if (selectedRoomId && !selectedRoomStillExists && nextRoomId) {
      setError(`Room ${selectedRoomId} no longer exists; switched to ${roomPayload.data[0]?.name ?? "the next room"}.`);
    }
    if (nextRoomId) {
      await loadRoomRuntime(nextRoomId);
      if (!appMountedRef.current) return;
      await waitForRoomTerminalBarrier(nextRoomId);
      if (!appMountedRef.current) return;
      const startupCapacity = await sampleWarmRoomCapacity();
      if (!appMountedRef.current) return;
      const validRoomIds = new Set(roomPayload.data.map((room) => room.id));
      const hydrationRoomIds = selectWarmHydrationRoomIds({
        roomIds: roomPayload.data.map((room) => room.id),
        activeRoomId: nextRoomId,
        mruRoomIds: readRoomMru(runtime.platform.sessionStorage, validRoomIds),
        maxWarmRooms: startupCapacity.effectiveSafeRoomCapacity
      });
      await hydrateWarmRoomsWithinWindow(
        hydrationRoomIds,
        (roomId) => loadRoomRuntime(roomId, undefined, { loadMetadata: false }),
        undefined,
        WARM_ROOM_STARTUP_HYDRATION_CONCURRENCY
      );
      if (!appMountedRef.current) return;
    } else {
      setPanes([]);
      setSelectedPaneId(null);
      setTurns([]);
      setRoomEvents([]);
      setSwarmState(await api.swarm());
    }

    // Unlock automatic warm-fill before the admin/readiness fan-out so adjacent rooms
    // start hydrating while smokes and provider catalogs load in the background.
    startupWarmFillReadyRef.current = true;
    setError((current) => (isTransientUpstreamErrorMessage(current) ? null : current));

    void runWithConcurrency([
      () => api.readyz(),
      () => api.providers(),
      () => api.providerSettings(),
      () => api.models(),
      () => api.skills(),
      () => api.imports(),
      () => api.admin(),
      () => api.mcp(),
      () => api.latestMcpDiscoverySmoke(),
      () => api.latestMemoryEmbeddingSmoke(),
      () => api.memoryVectorReadiness(),
      () => api.codexAppServer(),
      () => api.latestCodexAppServerHandshake(),
      () => api.latestCodexAppServerTurnSmoke(),
      () => api.storage(),
      () => api.observability(),
      () => api.worker()
    ] as const, 4).then((
      [
        readyPayload,
        providerPayload,
        providerSettingsPayload,
        modelPayload,
        skillPayload,
        importPayload,
        admin,
        mcpPayload,
        mcpSmokePayload,
        memoryEmbeddingSmokePayload,
        memoryVectorReadinessPayload,
        codexAppServerPayload,
        codexHandshakePayload,
        codexTurnSmokePayload,
        storageReadinessPayload,
        observabilityPayload,
        workerReadinessPayload
      ]
    ) => {
      if (!appMountedRef.current) return;
      setReadiness(readyPayload);
      setProviders(providerPayload.data);
      setProviderSettings(providerSettingsPayload);
      setModels(modelPayload.data);
      setSkills(skillPayload.data);
      setImportCandidates(importPayload.data);
      setStorageWarning(admin.storageWarning);
      setMcp(mcpPayload);
      setLatestMcpSmoke(mcpSmokePayload.data);
      setLatestMemoryEmbeddingSmoke(memoryEmbeddingSmokePayload.data);
      setLatestMemoryVectorReadiness(memoryVectorReadinessPayload.data);
      setCodexAppServer(codexAppServerPayload);
      setLatestCodexHandshake(codexHandshakePayload.data);
      setLatestCodexTurnSmoke(codexTurnSmokePayload.data);
      setStorageReadiness(storageReadinessPayload);
      setObservability(observabilityPayload);
      setWorkerReadiness(workerReadinessPayload);
    }).catch(() => {
      // Admin/readiness cards are non-blocking after the interactive shell is ready.
    });

    if (me.user?.role === "ADMIN") {
      void api.setupOverview()
        .then((overview) => {
          if (appMountedRef.current && !overview.isComplete) setIsSetupConnectionsOpen(true);
        })
        .catch(() => {
          // Onboarding discovery is best-effort and must not delay or block room hydration.
        });
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
    if (
      !startupWarmFillReadyRef.current ||
      automaticWarmFillSuppressedByOutputPressureRef.current ||
      !warmRoomEnabled ||
      !selectedRoomId ||
      warmRoomCapacity.pressureReasons.length > 0
    ) return;
    const targetCount =
      warmRoomCapacity.effectiveSafeRoomCapacity +
      (warmRoomCapacity.overcommitInUse ? 1 : 0);
    const hydratingCount = roomRuntimeHydrationIdsRef.current.size;
    const admittedAndPending = warmRoomIds.length + hydratingCount;
    if (admittedAndPending >= targetCount) return;
    const slots = Math.max(0, targetCount - admittedAndPending);
    if (slots === 0) return;
    const nowMs = Date.now();
    // Drop expired cool-downs so the map cannot grow without bound.
    for (const [roomId, evictedAt] of outputPressureEvictedAtByRoomIdRef.current) {
      if (nowMs - evictedAt >= WARM_ROOM_EVICTION_COOLDOWN_MS) {
        outputPressureEvictedAtByRoomIdRef.current.delete(roomId);
      }
    }
    const loadedRoomIds = new Set(Object.keys(roomRuntimesRef.current));
    const preferredRoomIds = readRoomMru(
      runtime.platform.sessionStorage,
      new Set(rooms.map((room) => room.id))
    );
    const blockedRoomIds = new Set(
      [...outputPressureEvictedAtByRoomIdRef.current.keys()].filter((roomId) =>
        isRoomInEvictionCooldown(roomId, outputPressureEvictedAtByRoomIdRef.current, nowMs)
      )
    );
    for (const roomId of roomRuntimeHydrationIdsRef.current) blockedRoomIds.add(roomId);
    const nextRoomIds = selectAutomaticWarmFillRoomIds({
      roomIds: rooms.map((room) => room.id),
      activeRoomId: selectedRoomId,
      preferredRoomIds,
      loadedRoomIds,
      eligibleRoomIds: startupWarmFillRoomIdsRef.current,
      blockedRoomIds,
      slots: Math.min(slots, WARM_ROOM_STARTUP_HYDRATION_CONCURRENCY)
    });
    for (const nextRoomId of nextRoomIds) {
      void loadRoomRuntimeRef.current(nextRoomId, undefined, { loadMetadata: false });
    }
  }, [
    automaticWarmFillSuppressed,
    readiness,
    rooms,
    selectedRoomId,
    warmRoomCapacity.effectiveSafeRoomCapacity,
    warmRoomCapacity.overcommitInUse,
    warmRoomCapacity.pressureReasons.length,
    warmRoomEnabled,
    warmRoomIds
  ]);

  useEffect(() => {
    function syncLifecycleDebugSnapshot() {
      setLifecycleDebugSnapshot(readLifecycleDebugSnapshot());
    }
    window.addEventListener(LIFECYCLE_DEBUG_UPDATED_EVENT, syncLifecycleDebugSnapshot);
    const navigationEntry = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
    recordLifecycleDebugEvent({
      type: "app_boot",
      scope: "App",
      detail: `nav=${navigationEntry?.type ?? "unknown"} width=${readViewportWidth()} url=${window.location.pathname}`,
      shellMode
    });
    syncLifecycleDebugSnapshot();
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
      window.removeEventListener(LIFECYCLE_DEBUG_UPDATED_EVENT, syncLifecycleDebugSnapshot);
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
    };

    updatePaneGridWidth();
    const resizeObserver = typeof ResizeObserver !== "undefined" ? new ResizeObserver(updatePaneGridWidth) : null;
    resizeObserver?.observe(grid);
    window.addEventListener("resize", updatePaneGridWidth);
    return () => {
      resizeObserver?.disconnect();
      window.removeEventListener("resize", updatePaneGridWidth);
    };
  }, [selectedRoomId, shellMode, panes.length, isDesktopSideSurfaceOpen, isCompactSideSurfaceOpen, isRoomFocusMode]);

  useEffect(() => {
    runtime.platform.localStorage.setItem(SIDE_SURFACE_HIDDEN_STORAGE_KEY, String(!isDesktopSideSurfaceOpen));
  }, [isDesktopSideSurfaceOpen]);

  useEffect(() => {
    try {
      if (selectedRoomId) runtime.platform.sessionStorage.setItem(SELECTED_ROOM_ID_STORAGE_KEY, selectedRoomId);
      else runtime.platform.sessionStorage.removeItem(SELECTED_ROOM_ID_STORAGE_KEY);
    } catch {
      // Best effort only.
    }
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

  useEffect(() => {
    runtime.platform.localStorage.setItem(TERMINAL_FONT_SIZE_STORAGE_KEY, String(terminalFontSize));
  }, [terminalFontSize]);

  useEffect(() => {
    runtime.platform.localStorage.setItem(CLI_IMAGE_PREVIEW_LIMIT_STORAGE_KEY, String(cliImagePreviewLimit));
  }, [cliImagePreviewLimit]);

  useEffect(() => {
    writeStoredWarmRoomEnabled(warmRoomEnabled);
  }, [warmRoomEnabled]);

  useEffect(() => {
    removeLegacyWarmRoomConnectedPaneLimit();
  }, []);

  useEffect(() => {
    runtime.platform.localStorage.setItem(SESSION_DEBUG_IDS_STORAGE_KEY, String(showSessionDebugIds));
  }, [showSessionDebugIds]);

  useEffect(() => {
    runtime.platform.localStorage.setItem(CLI_DEBUG_MODE_STORAGE_KEY, String(cliDebugModeEnabled));
  }, [cliDebugModeEnabled]);

  useEffect(() => {
    runtime.platform.localStorage.setItem(ROOM_THEME_STORAGE_KEY, roomTheme);
  }, [roomTheme]);

  useEffect(() => {
    if (uiTheme !== "modern" || modernAppearance !== "system" || typeof window.matchMedia !== "function") return;
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
          if (roomId !== selectedRoomIdRef.current) return;
          if (isRoomNotFoundError(err, roomId)) {
            recoverMissingRoom(roomId).catch((recoveryError: unknown) =>
              setError(recoveryError instanceof Error ? recoveryError.message : "Room recovery failed")
            );
            return;
          }
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
    setAuth(nextAuth);
    if (nextAuth.isAuthenticated) {
      await refresh();
    }
  }

  async function handleOwnerClaim(input: SetupClaimInput) {
    const nextAuth = await api.claimSetup(input);
    setSetupStatus({ setupRequired: false, expiresAt: null });
    if (!nextAuth.isOnboardingComplete) setIsSetupConnectionsOpen(true);
    await handleLogin(nextAuth);
  }

  async function signOut() {
    await api.logout();
    if (runtimeKind === "demo") {
      setAuth(await api.me());
      setAppView("workspace");
      return;
    }
    runtime.platform.reloadPage();
  }

  function openHelp() {
    window.history.pushState({ spaceView: "help" }, "", "/help");
    setAppView("help");
  }

  function closeHelp() {
    window.history.replaceState({ spaceView: "workspace" }, "", "/");
    setAppView("workspace");
  }

  async function createRoom() {
    if (roomCreationPendingRef.current) return;
    roomCreationPendingRef.current = true;
    setRoomCreationPending(true);
    setError(null);
    try {
      let room: Room;
      try {
        room = await api.createRoom(
          nextGeneratedRoomName(rooms.map((room) => room.name)),
          0
        );
      } catch (err) {
        setError(`Room creation failed: ${err instanceof Error ? err.message : "Unknown error"}`);
        return;
      }
      setRooms((current) => sortRoomsByOrder([...current, room]));
      setRoomCliActivityCounts((current) => ({ ...current, [room.id]: 0 }));
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

  async function addRoomPanes(roomId: string, input: CreateRoomPanesRequest) {
    await api.createRoomPanes(roomId, input);
    await loadRoomRuntime(roomId);
  }

  async function addRootAdminPane() {
    if (!selectedRoomId || panes.length >= 16) return;
    const created = await api.createPane(selectedRoomId, "CLI ROOT", "TERMINAL", {
      cwd: "/etc",
      terminalRuntimeId: "cli:root"
    });
    setPanes((current) => [...current, created]);
    setSelectedPaneId(created.id);
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

  async function addCliRuntimePane(runtime: AgentRuntime) {
    const roomId = selectedRoomIdRef.current;
    if (!roomId) throw new Error("Select a room before adding a CLI pane.");
    if (panesRef.current.length >= 16) throw new Error("This room already has the maximum of 16 panes.");
    if (cliPaneCreationPendingRef.current) throw new Error("A CLI pane is already being created.");
    if (runtime.id === "cli:root" || !runtime.capabilities.includes("CLI") || !isCliRuntimeTerminalLaunchable(runtime)) {
      throw new Error(runtime.statusReason || "This CLI runtime is unavailable.");
    }

    cliPaneCreationPendingRef.current = true;
    setCliPaneCreationPending(true);
    const optimisticId = `pane:optimistic-${Date.now().toString(36)}`;
    const optimisticTitle =
      runtime.id === "cli:codex"
        ? paneTitleForMode("TERMINAL", panesRef.current.length + 1)
        : runtime.displayName;
    const nowIso = new Date().toISOString();
    const optimisticPane: Pane = {
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
      cwd: runtime.id === "cli:codex" ? null : "/etc",
      order: panesRef.current.length,
      columnSpan: 1,
      isMaximized: false,
      isMinimized: false,
      isClosed: false,
      split: { parentId: null, direction: null, size: null },
      categoryColor: null,
      createdAt: nowIso,
      updatedAt: nowIso
    };
    // Show a skeleton card immediately; replace it with the server pane on success.
    if (selectedRoomIdRef.current === roomId) {
      setPanes((current) => [...current, optimisticPane]);
      setSelectedPaneId(optimisticId);
    }
    try {
      const created = runtime.id === "cli:codex"
        ? await api.createPane(roomId, optimisticTitle, "TERMINAL")
        : await api.createPane(roomId, runtime.displayName, "TERMINAL", {
            cwd: "/etc",
            terminalRuntimeId: runtime.id
          });
      if (selectedRoomIdRef.current === roomId) {
        setPanes((current) => {
          const withoutOptimistic = current.filter((pane) => pane.id !== optimisticId);
          return withoutOptimistic.some((pane) => pane.id === created.id)
            ? withoutOptimistic
            : [...withoutOptimistic, created];
        });
        setSelectedPaneId(created.id);
        void refreshRoomEvents(roomId).catch(() => setError("CLI pane created, but room activity could not be refreshed."));
      }
    } catch (error) {
      if (selectedRoomIdRef.current === roomId) {
        setPanes((current) => current.filter((pane) => pane.id !== optimisticId));
        setSelectedPaneId((current) => (current === optimisticId ? panesRef.current.find((pane) => pane.id !== optimisticId)?.id ?? null : current));
      }
      throw error;
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

  async function openRoom(roomId: string, options: { keepCompactSurfaceOpen?: boolean } = {}) {
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
    activateRoom(roomId);
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

  function warmRoomSafeSlotAvailable(
    snapshot: WarmRoomCapacitySnapshot,
    targetPaneCount = WARM_ROOM_FULL_PANE_COUNT
  ): boolean {
    return snapshot.warmRoomCount < snapshot.effectiveSafeRoomCapacity &&
      snapshot.connectedPaneCount + targetPaneCount <= snapshot.safePaneCapacity;
  }

  async function selectRoomOnce(roomId: string, options: { keepCompactSurfaceOpen?: boolean } = {}) {
    if (
      roomId === selectedRoomIdRef.current &&
      roomRuntimesRef.current[roomId] &&
      roomPaneLoadStatesRef.current[roomId] === "loaded"
    ) return;
    if (
      !warmRoomEnabled ||
      roomId === selectedRoomIdRef.current ||
      (
        warmRoomIdsRef.current.includes(roomId) &&
        roomRuntimesRef.current[roomId] &&
        roomPaneLoadStatesRef.current[roomId] === "loaded"
      )
    ) {
      await openRoom(roomId, options);
      return;
    }
    const fresh = await sampleWarmRoomCapacity();
    const safeSlotAvailable = warmRoomSafeSlotAvailable(fresh);
    let evictionRoomId: string | null = null;
    if (!safeSlotAvailable) {
      evictionRoomId = selectHiddenRoomEvictionIds({
        candidates: Object.values(roomRuntimesRef.current).map((runtimeSnapshot) => ({
          roomId: runtimeSnapshot.roomId,
          attachedPaneCount: connectedPaneCount(
            runtimeSnapshot.panes,
            runtimeSnapshot.bootstrappedPaneIds
          ),
          lastAccessedAt: runtimeSnapshot.lastAccessedAt
        })),
        protectedRoomIds: [
          selectedRoomIdRef.current,
          displayedRoomIdRef.current,
          preparingRoomIdRef.current
        ].filter((candidate): candidate is string => Boolean(candidate)),
        evictionCount: 1
      })[0] ?? null;
      if (evictionRoomId) {
        removeRoomRuntime(evictionRoomId);
        emitWarmRoomCapacityDiagnostic(fresh, "EVICT");
      }
    }
    const decision = {
      action: "OPEN_SAFELY",
      automatic: true,
      targetRoomId: roomId,
      evictedRoomId: evictionRoomId,
      usedColdRevealReserve: !safeSlotAvailable && evictionRoomId === null,
      sequence: warmRoomAdmissionSequenceRef.current + 1
    } satisfies WarmRoomAdmissionDecision;
    warmRoomAdmissionSequenceRef.current = decision.sequence;
    setWarmRoomAdmissionDecision(decision);
    emitWarmRoomCapacityDiagnostic(fresh, "ADMIT");
    await openRoom(roomId, options);
  }

  async function selectRoom(roomId: string, options: { keepCompactSurfaceOpen?: boolean } = {}) {
    const activeFlight = roomAdmissionFlightsRef.current.get(roomId);
    if (activeFlight) return activeFlight;
    const flight = selectRoomOnce(roomId, options);
    roomAdmissionFlightsRef.current.set(roomId, flight);
    try {
      await flight;
    } finally {
      if (roomAdmissionFlightsRef.current.get(roomId) === flight) {
        roomAdmissionFlightsRef.current.delete(roomId);
      }
    }
  }

  useEffect(() => {
    const openRecoveryRoom = (event: Event) => {
      if (!(event instanceof CustomEvent)) return;
      const detail = parseCliRecoveryOpenedDetail(event.detail);
      if (!detail) return;
      void (async () => {
        const roomPayload = await api.rooms();
        setRooms(sortRoomsByOrder(roomPayload.data));
        await openRoom(detail.roomId);
        if (detail.paneId) setSelectedPaneId(detail.paneId);
      })().catch(() => setError("CLI Recovery opened, but the room could not be selected automatically."));
    };
    window.addEventListener(CLI_RECOVERY_OPENED_EVENT, openRecoveryRoom);
    return () => window.removeEventListener(CLI_RECOVERY_OPENED_EVENT, openRecoveryRoom);
  });

  async function deleteRoom(roomId: string) {
    if (deletePendingRoomId) return;
    const activeCli = roomCliActivityCounts[roomId] ?? 0;
    if (activeCli > 0) {
      const confirmed = window.confirm(
        `Το δωμάτιο έχει ${activeCli} ενεργά CLI ${activeCli === 1 ? "session" : "sessions"} που θα τερματιστούν. Να διαγραφεί το δωμάτιο;`
      );
      if (!confirmed) return;
    }
    const deletedRoom = rooms.find((room) => room.id === roomId);
    const nextRooms = rooms.filter((room) => room.id !== roomId);
    const nextSelectedRoomId = selectedRoomId === roomId ? nextRooms[0]?.id ?? null : selectedRoomId;
    setDeletePendingRoomId(roomId);
    setError(null);
    setRooms(nextRooms);
    setRoomCliActivityCounts((current) => {
      if (!(roomId in current)) return current;
      const next = { ...current };
      delete next[roomId];
      return next;
    });
    if (selectedRoomId === roomId) {
      activateRoom(nextSelectedRoomId);
      removeRoomRuntime(roomId);
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
      removeRoomRuntime(roomId);
    }
    try {
      await api.deleteRoom(roomId);
    } catch (err) {
      if (deletedRoom) setRooms(sortRoomsByOrder([...nextRooms, deletedRoom]));
      setError(err instanceof Error ? err.message : "Room delete failed");
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

  async function submitPaneMove() {
    if (!paneMoveDialog || paneMoveDialog.pending) return;
    const targetRoomName = rooms.find((room) => room.id === paneMoveDialog.targetRoomId)?.name ?? "the selected room";
    setPaneMoveDialog((current) => (current ? { ...current, pending: true, error: null } : current));
    try {
      const move = await api.movePane(paneMoveDialog.pane.id, paneMoveDialog.targetRoomId);
      if (selectedRoomId === move.sourceRoomId) {
        await loadRoomRuntime(move.sourceRoomId);
      }
      setPaneMoveDialog(null);
      setPaneMoveNotice(`Moved "${move.sourcePane.title}" to "${targetRoomName}".`);
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

  async function addPane(mode: Pane["mode"]) {
    if (!selectedRoomId || panes.length >= 16) return;
    const prior = (await api.panes(selectedRoomId, { includeClosed: true }).catch(() => null))?.data ?? [];
    const closedMatch = prior.find((candidate) => candidate.isClosed && candidate.mode === mode);
    let pane: Pane;
    if (closedMatch) {
      pane = await api.updatePane(closedMatch.id, { isClosed: false, status: "IDLE" });
    } else {
      pane = await api.createPane(selectedRoomId, paneTitleForMode(mode, panes.length + 1), mode);
    }
    setPanes((current) => [...current.filter((candidate) => candidate.id !== pane.id), pane]);
    setSelectedPaneId(pane.id);
    await refreshRoomEvents(selectedRoomId);
  }

  async function splitPane(sourcePane: Pane, direction: "horizontal" | "vertical") {
    if (!selectedRoomId || panes.length >= 16) return;
    const sourceTerminalRuntimeId = sourcePane.mode === "TERMINAL"
      ? sourcePane.terminalRuntimeId ?? "cli:codex"
      : null;
    if (
      !isCodexEnabled &&
      (sourcePane.mode === "CHAT" || sourceTerminalRuntimeId === "cli:codex")
    ) return;
    const pane = await api.createPane(selectedRoomId, paneTitleForMode(sourcePane.mode, panes.length + 1), sourcePane.mode, {
      providerId: sourcePane.providerId,
      modelId: sourcePane.modelId,
      terminalRuntimeId: sourceTerminalRuntimeId,
      cwd: sourcePane.mode === "TERMINAL" ? null : sourcePane.cwd,
      split: { parentId: sourcePane.id, direction, size: 50 }
    });
    setPanes((current) => [...current, pane]);
    setSelectedPaneId(pane.id);
    await refreshRoomEvents(selectedRoomId);
  }

  async function closePane(paneId: string) {
    await api.closePane(paneId);
    setPanes((current) => current.filter((pane) => pane.id !== paneId));
    setSelectedPaneId((current) => (current === paneId ? null : current));
    if (selectedRoomId) await loadRoomRuntime(selectedRoomId);
  }

  async function toggleMaximize(pane: Pane) {
    const updated = await api.updatePane(pane.id, { isMaximized: !pane.isMaximized });
    setPanes((current) => current.map((item) => (item.id === updated.id ? updated : item)));
    await refreshRoomEvents(pane.roomId);
  }

  async function minimizePane(pane: Pane) {
    setError(null);
    try {
      const updated = await api.updatePane(pane.id, { isMinimized: true });
      const remainingVisible = sortPanesForGrid(panes.filter((candidate) => candidate.id !== pane.id && !candidate.isMinimized));
      const nextPane = remainingVisible.find((candidate) => candidate.order > pane.order) ?? remainingVisible[0] ?? null;
      setPanes((current) => current.map((item) => (item.id === updated.id ? updated : item)));
      setSelectedPaneId(nextPane?.id ?? null);
      setIsMobilePaneFocusMode(false);
      window.requestAnimationFrame(() => minimizedPaneRestoreRefs.current.get(pane.id)?.focus());
      await refreshRoomEvents(pane.roomId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Pane minimize failed");
    }
  }

  async function restorePane(pane: Pane) {
    setError(null);
    const results = await Promise.allSettled([
      api.updatePane(pane.id, { isMinimized: false, isMaximized: false }),
      ...panes
        .filter((candidate) => candidate.id !== pane.id && candidate.isMaximized)
        .map((candidate) => api.updatePane(candidate.id, { isMaximized: false }))
    ]);
    try {
      const reconciled = await api.panes(pane.roomId);
      const restored = reconciled.data.find((candidate) => candidate.id === pane.id && !candidate.isMinimized);
      if (restored) pendingPaneHeaderFocusIdRef.current = restored.id;
      setPanes([...reconciled.data]);
      if (restored) {
        setSelectedPaneId(restored.id);
        setIsMobilePaneFocusMode(false);
      }
      if (results.some((result) => result.status === "rejected")) {
        setError("Pane restore was only partially applied. Room state was refreshed.");
      }
      await refreshRoomEvents(pane.roomId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Pane restore failed");
    }
  }

  async function restoreAllPanes() {
    if (!selectedRoomId || restoreAllPending) return;
    const allWereMinimized = panes.length > 0 && panes.every((pane) => pane.isMinimized);
    const candidates = panes.filter((pane) => pane.isMinimized || pane.isMaximized).slice(0, 16);
    setRestoreAllPending(true);
    setError(null);
    const results = await Promise.allSettled(
      candidates.map((pane) => api.updatePane(pane.id, { isMinimized: false, isMaximized: false }))
    );
    try {
      const reconciled = await api.panes(selectedRoomId);
      setPanes([...reconciled.data]);
      const visiblePanes = reconciled.data.filter((pane) => !pane.isMinimized);
      setSelectedPaneId((current) => {
        if (allWereMinimized) return visiblePanes[0]?.id ?? null;
        return visiblePanes.some((pane) => pane.id === current) ? current : visiblePanes[0]?.id ?? null;
      });
      setIsMobilePaneFocusMode(false);
      if (results.some((result) => result.status === "rejected")) {
        const failedCount = results.filter((result) => result.status === "rejected").length;
        setError(`Restore all partially failed for ${failedCount} pane${failedCount === 1 ? "" : "s"}. Room state was refreshed.`);
      }
      await refreshRoomEvents(selectedRoomId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Restore all failed");
    } finally {
      setRestoreAllPending(false);
    }
  }

  async function updatePaneColumnSpan(pane: Pane, columnSpan: number, anchorColumnStart?: number) {
    const nextColumnSpan = Math.max(1, Math.min(MAX_PANE_COLUMN_SPAN, columnSpan));
    if ((pane.columnSpan ?? 1) === nextColumnSpan) return;
    const previousAnchorColumnStart = paneColumnAnchorStartsRef.current.get(pane.id);
    if (anchorColumnStart !== undefined) {
      paneColumnAnchorStartsRef.current.set(pane.id, anchorColumnStart);
    }
    try {
      const updated = await api.updatePane(pane.id, { columnSpan: nextColumnSpan });
      setPanes((current) => current.map((item) => (item.id === updated.id ? updated : item)));
      await refreshRoomEvents(pane.roomId);
    } catch (error) {
      if (anchorColumnStart !== undefined) {
        if (previousAnchorColumnStart === undefined) {
          paneColumnAnchorStartsRef.current.delete(pane.id);
        } else {
          paneColumnAnchorStartsRef.current.set(pane.id, previousAnchorColumnStart);
        }
      }
      throw error;
    }
  }

  function handlePaneUpdated(updatedPane: Pane) {
    setPanes((current) => current.map((pane) => (pane.id === updatedPane.id ? updatedPane : pane)));
    void refreshRoomEvents(updatedPane.roomId);
  }

  const activeRoom = useMemo(() => rooms.find((room) => room.id === selectedRoomId) ?? null, [rooms, selectedRoomId]);
  const visiblePanes = useMemo(() => panes.filter((pane) => !pane.isMinimized), [panes]);
  const minimizedPanes = useMemo(() => panes.filter((pane) => pane.isMinimized), [panes]);
  const activePane = useMemo(
    () => visiblePanes.find((pane) => pane.id === selectedPaneId) ?? visiblePanes[0] ?? null,
    [selectedPaneId, visiblePanes]
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
    const presentationVisiblePanes = presentationPanes.filter((pane) => !pane.isMinimized);
    return presentationVisiblePanes.find((pane) => pane.id === presentationSelectedPaneId)
      ?? presentationVisiblePanes[0]
      ?? null;
  }, [presentationPanes, presentationSelectedPaneId]);
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
          void recoverMissingRoom(activeRoom.id);
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
          void recoverMissingRoom(activeRoom.id);
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
          if (handoff.status !== "REQUESTED") return;
          activateRoom(handoff.roomId);
          await loadRoomRuntimeRef.current(handoff.roomId);
          setSelectedPaneId(handoff.paneId);
          setPendingBrowserHandoffPaneId(handoff.paneId);
        })
        .catch(() => {
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
    return () => {
      source.removeEventListener("replay-start", handleReplayStart);
      source.removeEventListener("replay-complete", handleReplayComplete);
      source.removeEventListener("ROOM_CREATED", handleRoomCreated as EventListener);
      source.removeEventListener("BROWSER_HANDOFF_REQUESTED", handleBrowserHandoff as EventListener);
      source.removeEventListener("CAPABILITY_STATUS_CHANGED", handleCapabilityStatusChanged as EventListener);
      source.close();
    };
  }, [activeTerminalPanesBootstrapped, auth?.isAuthenticated]);

  useEffect(() => {
    if (!auth?.isAuthenticated) return;
    const handleCliRuntimeVisibility = () => {
      api.invalidateCliRuntimes();
      api.invalidateCliRuntimeSettings();
      void api.codexEnvironment()
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
          setRoomCliActivityCounts(Object.fromEntries(
            payload.data.map((activity) => [activity.roomId, activity.runningCliCount])
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
  const activeRoomIndex = useMemo(
    () => (activeRoom ? rooms.findIndex((room) => room.id === activeRoom.id) : -1),
    [activeRoom, rooms]
  );
  const previousRoom = activeRoomIndex > 0 ? rooms[activeRoomIndex - 1] ?? null : null;
  const nextRoom = activeRoomIndex >= 0 && activeRoomIndex < rooms.length - 1 ? rooms[activeRoomIndex + 1] ?? null : null;
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
  const paneDensity = useMemo(() => paneDensityFor(shellMode, visiblePanes.length), [shellMode, visiblePanes.length]);
  const automaticPaneGridColumnCount = useMemo(
    () =>
      resolvePaneGridColumnCount({
        shellMode,
        paneDensity,
        containerWidth: paneGridWidth,
        paneLayoutColumns: null,
        visiblePaneCount: visiblePanes.length,
        forceTabletTwoColumns: uiTheme === "modern"
      }),
    [paneDensity, paneGridWidth, shellMode, uiTheme, visiblePanes.length]
  );
  const paneGridColumnCount = useMemo(
    () =>
      resolvePaneGridColumnCount({
        shellMode,
        paneDensity,
        containerWidth: paneGridWidth,
        paneLayoutColumns: activeRoom?.paneLayoutColumns ?? null,
        visiblePaneCount: visiblePanes.length,
        forceTabletTwoColumns: uiTheme === "modern"
      }),
    [activeRoom?.paneLayoutColumns, paneDensity, paneGridWidth, shellMode, uiTheme, visiblePanes.length]
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
  const agentNumberByPaneId = useMemo(() => new Map(panes.map((pane, index) => [pane.id, index + 1])), [panes]);
  const isCompactShell = shellMode !== "desktop";
  const isSideSurfaceOpen = isCompactShell ? isCompactSideSurfaceOpen : isDesktopSideSurfaceOpen;
  const activeSideSurfaceLabel = sideSurfaceMeta[activeSideSurface].surfaceLabel;
  const activeSideSurfaceCloseLabel = `Close ${sideSurfaceMeta[activeSideSurface].label}`;
  const showInlineSideSurface = !isCompactShell && isDesktopSideSurfaceOpen;
  const showOverlaySideSurface = isCompactShell && isCompactSideSurfaceOpen;
  const isRoomsSurfaceVisible = Boolean(auth?.isAuthenticated)
    && appView === "workspace"
    && !isMemoryWorkspaceOpen
    && systemAnalyticsTab === null
    && activeSideSurface === "rooms"
    && isSideSurfaceOpen;

  useEffect(() => {
    if (!isRoomsSurfaceVisible) return;
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
        setRoomCliActivityCounts(Object.fromEntries(
          payload.data.map((activity) => [activity.roomId, activity.runningCliCount])
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
  }, [isRoomsSurfaceVisible]);

  useEffect(() => {
    if (!showOverlaySideSurface) return;
    const trigger = compactSideSurfaceTriggerRef.current;
    const drawer = compactSideSurfaceRef.current;
    const focusableSelector = 'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])';
    const isJSDOM = /\bjsdom\b/i.test(navigator.userAgent);
    const focusableElements = () => Array.from(drawer?.querySelectorAll<HTMLElement>(focusableSelector) ?? [])
      .filter((element) => isJSDOM || element.getClientRects().length > 0);
    window.requestAnimationFrame(() => focusableElements()[0]?.focus());
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        closeCompactSideSurface();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = focusableElements();
      const first = focusable[0];
      const last = focusable.at(-1);
      if (!first || !last) {
        event.preventDefault();
        return;
      }
      if (event.shiftKey && (document.activeElement === first || !drawer?.contains(document.activeElement))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !drawer?.contains(document.activeElement))) {
        event.preventDefault();
        first.focus();
      }
    }
    document.addEventListener("keydown", handleKeyDown, true);
    return () => {
      document.removeEventListener("keydown", handleKeyDown, true);
      if (trigger?.isConnected) window.requestAnimationFrame(() => trigger.focus());
    };
  }, [showOverlaySideSurface]);

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

  function sideSurfaceToggleLabel(surface: SideSurface) {
    const verb = isSideSurfaceOpen && activeSideSurface === surface ? (isCompactShell ? "Close" : "Hide") : isCompactShell ? "Open" : "Show";
    return `${verb} ${sideSurfaceMeta[surface].label}`;
  }

  function closeCompactSideSurface() {
    setIsCompactSideSurfaceOpen(false);
  }

  function toggleSideSurface(surface: SideSurface) {
    if (isCompactShell) {
      if (activeSideSurface === surface && isCompactSideSurfaceOpen) {
        setIsCompactSideSurfaceOpen(false);
        return;
      }
      if (document.activeElement instanceof HTMLElement) compactSideSurfaceTriggerRef.current = document.activeElement;
      setActiveSideSurface(surface);
      setIsCompactSideSurfaceOpen(true);
      return;
    }
    if (activeSideSurface !== surface) {
      setActiveSideSurface(surface);
      setIsDesktopSideSurfaceOpen(true);
      return;
    }
    setIsDesktopSideSurfaceOpen((current) => !current);
  }

  function openSettingsSurface() {
    setIsCliLauncherOpen(false);
    setActiveSideSurface("settings");
    if (isCompactShell) {
      setIsCompactSideSurfaceOpen(true);
    } else {
      setIsDesktopSideSurfaceOpen(true);
    }
  }

  function manageLinks() {
    setIsQuickLinksOpen(false);
    setActiveSideSurface("links");
    if (isCompactShell) setIsCompactSideSurfaceOpen(true);
    else setIsDesktopSideSurfaceOpen(true);
  }

  function openUserLink(link: UserLink) {
    setIsQuickLinksOpen(false);
    if (link.openMode === "NEW_TAB") {
      const opened = runtime.platform.openLink(link.url, "_blank", "noopener,noreferrer");
      if (opened) opened.opener = null;
      return;
    }
    setActiveUserLink(link);
  }

  function toggleCliFloats() {
    setCliFloatsHidden((current) => {
      const next = !current;
      try {
        runtime.platform.localStorage.setItem(CLI_FLOATS_HIDDEN_STORAGE_KEY, String(next));
      } catch {
        // Best effort only.
      }
      return next;
    });
  }

  function toggleMaskSensitiveData() {
    setMaskSensitiveData((current) => {
      const next = !current;
      try {
        runtime.platform.localStorage.setItem(SPACE_SENSITIVE_DATA_MASKED_STORAGE_KEY, String(next));
      } catch {
        // Best effort only.
      }
      return next;
    });
  }

  function openServerRestartDialog() {
    setServerRestartError(null);
    setServerRestartMessage(null);
    setIsServerRestartDialogOpen(true);
  }

  function openCliRuntimeRestartAllDialog() {
    setCliRuntimeRestartAllError(null);
    setCliRuntimeRestartAllMessage(null);
    setIsCliRuntimeRestartAllDialogOpen(true);
  }

  function closeCliRuntimeRestartAllDialog() {
    if (cliRuntimeRestartAllPending) return;
    setIsCliRuntimeRestartAllDialogOpen(false);
    window.requestAnimationFrame(() => serverActionsButtonRef.current?.focus());
  }

  async function confirmCliRuntimeRestartAll() {
    if (cliRuntimeRestartAllPending) return;
    setCliRuntimeRestartAllPending(true);
    setCliRuntimeRestartAllError(null);
    setCliRuntimeRestartAllMessage("Restarting every CLI runtime session...");
    try {
      const result = await api.cliRuntimeRestartAll();
      const restarted = result.restartedSessionIds.length;
      const failed = result.failedSessionIds.length;
      setCliRuntimeRestartAllMessage(
        failed > 0
          ? `Restart requested: ${restarted} sessions restarted across ${result.requestedRuntimes.length} runtimes, ${failed} failed.`
          : `Restart requested: ${restarted} sessions restarted across ${result.requestedRuntimes.length} runtimes.`
      );
    } catch (err) {
      setCliRuntimeRestartAllMessage(null);
      setCliRuntimeRestartAllError(err instanceof Error ? err.message : "CLI restart-all failed.");
    } finally {
      setCliRuntimeRestartAllPending(false);
    }
  }

  function closeServerRestartDialog() {
    if (serverRestartPending) return;
    setIsServerRestartDialogOpen(false);
    window.requestAnimationFrame(() => serverActionsButtonRef.current?.focus());
  }

  async function waitForServerRestart(previousApiStartedAt: string) {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      try {
        const nextReady = await api.readyz();
        setReadiness(nextReady);
        if (nextReady.ok && nextReady.apiStartedAt && nextReady.apiStartedAt !== previousApiStartedAt) return;
      } catch {
        // The API is expected to be briefly unavailable while the core services restart.
      }
      await new Promise((resolve) => window.setTimeout(resolve, 1500));
    }
    throw new Error("Timed out waiting for Space to become ready after restart.");
  }

  async function confirmServerRestart() {
    if (serverRestartPending) return;
    setServerRestartPending(true);
    setServerRestartError(null);
    setServerRestartMessage("Requesting server restart...");
    try {
      const accepted = await api.restartCoreServices();
      if (getSpaceRuntimeKind() === "demo") {
        setServerRestartMessage(DEMO_LOCAL_REPLY);
        return;
      }
      setServerRestartMessage("Restart request accepted. Waiting for Space to return...");
      await waitForServerRestart(accepted.apiStartedAt);
      try {
        setCodexEnvironmentSummary(await api.codexEnvironment());
      } catch {
        // Host metrics are refreshed by the existing environment poll if this immediate read races the restart.
      }
      setServerRestartMessage("Server restarted and ready.");
    } catch (restartError) {
      const message = restartError instanceof Error ? restartError.message : "Server restart failed.";
      setServerRestartError(message);
      setServerRestartMessage(null);
    } finally {
      setServerRestartPending(false);
    }
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

  function closePaneLayoutMenu(restoreFocus = true) {
    setIsPaneLayoutMenuOpen(false);
    if (restoreFocus) {
      window.requestAnimationFrame(() => paneLayoutButtonRef.current?.focus());
    }
  }

  async function applyPaneLayoutPreset(paneLayoutColumns: Room["paneLayoutColumns"]) {
    if (!activeRoom || paneLayoutPending) return;
    setPaneLayoutPending(true);
    setPaneLayoutError(null);
    try {
      const result = await api.updateRoomPaneLayout(activeRoom.id, { paneLayoutColumns });
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
      closePaneLayoutMenu();
      try {
        await refreshRoomEvents(activeRoom.id);
      } catch {
        setError("Pane layout applied, but room activity could not be refreshed.");
      }
    } catch (layoutError) {
      setPaneLayoutError(layoutError instanceof Error ? layoutError.message : "Pane layout update failed");
      setPaneLayoutPending(false);
    }
  }

  async function applyPaneSpanToAll(columnSpan: number) {
    if (!activeRoom || paneSpanAllPending) return;
    const targets = visiblePanes.filter((pane) => pane.roomId === activeRoom.id);
    if (targets.length === 0) return;
    setPaneSpanAllPending(true);
    setPaneSpanAllError(null);
    try {
      const nextColumnSpan = Math.max(1, Math.min(MAX_PANE_COLUMN_SPAN, columnSpan));
      const results = await Promise.allSettled(
        targets.map((pane) => {
          if ((pane.columnSpan ?? 1) === nextColumnSpan) return Promise.resolve(pane);
          return api.updatePane(pane.id, { columnSpan: nextColumnSpan });
        })
      );
      const updatedPanes: Pane[] = [];
      let failed = 0;
      results.forEach((result, index) => {
        const pane = targets[index]!;
        if (result.status === "fulfilled") {
          updatedPanes.push(result.value);
        } else {
          failed += 1;
          updatedPanes.push(pane);
        }
      });
      setPanes((current) => current.map((item) => updatedPanes.find((pane) => pane.id === item.id) ?? item));
      setPaneSpanAllPending(false);
      if (failed > 0) {
        setPaneSpanAllError(`${failed} pane${failed === 1 ? "" : "s"} could not be updated.`);
      } else {
        closePaneSpanAllMenu();
      }
      try {
        await refreshRoomEvents(activeRoom.id);
      } catch {
        setError("Pane width applied, but room activity could not be refreshed.");
      }
    } catch (spanError) {
      setPaneSpanAllError(spanError instanceof Error ? spanError.message : "Pane width update failed");
      setPaneSpanAllPending(false);
    }
  }

  function commonPaneColumnSpan(panes: Pane[]): number | null {
    const first = panes[0]?.columnSpan ?? 1;
    return panes.every((pane) => (pane.columnSpan ?? 1) === first) ? first : null;
  }

  function closePaneSpanAllMenu(restoreFocus = true) {
    setIsPaneSpanAllMenuOpen(false);
    if (restoreFocus) {
      window.requestAnimationFrame(() => paneSpanAllButtonRef.current?.focus());
    }
  }

  const roomToolbarActions = useMemo<IconToolbarAction[]>(
    () => {
      const actions: IconToolbarAction[] = [
      ...(Object.entries(sideSurfaceMeta) as Array<[SideSurface, (typeof sideSurfaceMeta)[SideSurface]]>)
        .filter(([surface]) => surface !== "streaming" || auth?.user?.role === "ADMIN")
        .map(([surface, meta]) => {
          const label = sideSurfaceToggleLabel(surface);
          return {
            id: `surface-${surface}`,
            label,
            title: label,
            ariaLabel: label,
            icon: meta.icon,
            onClick: () => toggleSideSurface(surface),
            ariaPressed: isSideSurfaceOpen && activeSideSurface === surface,
            className: "toolbar-surface-toggle"
          };
        }),
      {
        id: "memory-workspace",
        label: "Open memory workspace",
        title: "Open memory workspace",
        ariaLabel: "Open memory workspace",
        icon: Network,
        onClick: () => {
          setSystemAnalyticsTab(null);
          setIsMemoryWorkspaceOpen(true);
        },
        ariaExpanded: isMemoryWorkspaceOpen
      },
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
        id: "pane-layout",
        label: "Pane layout",
        title: "Pane layout",
        ariaLabel: "Pane layout",
        icon: PanelsTopLeft,
        onClick: () => {
          setPaneLayoutError(null);
          setIsPaneLayoutMenuOpen((current) => !current);
        },
        ariaControls: PANE_LAYOUT_MENU_ID,
        ariaExpanded: isPaneLayoutMenuOpen,
        ariaHasPopup: "menu",
        disabled: !activeRoom || paneLayoutPending
      },
      {
        id: "pane-span-all",
        label: "All panes width",
        title: "Set width for all panes",
        ariaLabel: "Set width for all panes",
        icon: Columns3,
        onClick: () => {
          setPaneSpanAllError(null);
          setIsPaneLayoutMenuOpen(false);
          setIsPaneSpanAllMenuOpen((current) => !current);
        },
        ariaControls: PANE_SPAN_ALL_MENU_ID,
        ariaExpanded: isPaneSpanAllMenuOpen,
        ariaHasPopup: "menu",
        disabled: !activeRoom || visiblePanes.length < 2 || paneSpanAllPending
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
        id: "cli-floats",
        label: cliFloatsHidden ? "Show CLI floats" : "Hide CLI floats",
        title: cliFloatsHidden ? "Show CLI floats" : "Hide CLI floats",
        ariaLabel: cliFloatsHidden ? "Show CLI floats" : "Hide CLI floats",
        icon: cliFloatsHidden ? Eye : EyeOff,
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
        id: "font-down",
        label: "Workspace text size",
        title: `Workspace text size: ${terminalFontSize} px`,
        ariaLabel: "Workspace text size",
        icon: ALargeSmall,
        onClick: () => setIsWorkspaceTextSizePickerOpen((current) => !current),
        ariaControls: WORKSPACE_TEXT_SIZE_PICKER_ID,
        ariaExpanded: isWorkspaceTextSizePickerOpen,
        ariaHasPopup: "listbox",
        disabled: !activeRoom || !panes.some((pane) => pane.mode === "TERMINAL" || pane.mode === "CHAT")
      },
      {
        id: "add-chat",
        label: "Add chat pane",
        title: isCodexEnabled ? "Add chat pane" : "Enable Codex in Settings",
        ariaLabel: "Add chat pane",
        icon: MessageSquare,
        onClick: () => addPane("CHAT"),
        disabled: !isCodexEnabled || !selectedRoomId || panes.length >= 16
      },
      {
        id: "add-cli",
        label: "Add CLI pane",
        title: "Add CLI pane",
        ariaLabel: "Add CLI pane",
        icon: Terminal,
        onClick: openCliLauncher,
        ariaControls: CLI_LAUNCHER_MENU_ID,
        ariaExpanded: isCliLauncherOpen,
        ariaHasPopup: shellMode === "mobile" ? "dialog" as const : "menu" as const,
        disabled: !selectedRoomId || cliPaneCreationPending
      },
      ...(auth?.user?.role === "ADMIN"
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
            label: "Server restart",
            title: "Server restart",
            ariaLabel: "Server restart",
            icon: ServerCog,
            onClick: () => setIsServerActionsMenuOpen((current) => !current),
            ariaControls: SERVER_ACTIONS_MENU_ID,
            ariaExpanded: isServerActionsMenuOpen,
            ariaHasPopup: shellMode === "mobile" ? "dialog" as const : "menu" as const,
            hideable: false
          }]
        : []),
      {
        id: "add-browser",
        label: "Add browser pane",
        title: "Add browser pane",
        ariaLabel: "Add browser pane",
        icon: Eye,
        onClick: () => addPane("BROWSER"),
        disabled: !selectedRoomId || panes.length >= 16
      },
      {
        id: "add-youtube",
        label: "Add YouTube pane",
        title: "Add YouTube pane",
        ariaLabel: "Add YouTube pane",
        icon: Youtube,
        onClick: () => addPane("YOUTUBE"),
        disabled: !selectedRoomId || panes.length >= 16
      },
      {
        id: "add-review",
        label: "Add review pane",
        title: "Add review pane",
        ariaLabel: "Add review pane",
        icon: GitCompare,
        onClick: () => addPane("REVIEW"),
        disabled: !selectedRoomId || panes.length >= 16
      },
      {
        id: "reload-room",
        label: "Reload window",
        title: "Reload window",
        ariaLabel: "Reload window",
        icon: RefreshCw,
        onClick: () => void reloadRoomWindow(),
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
        id: "print-window",
        label: "Print window",
        title: "Print window",
        ariaLabel: "Print window",
        icon: Printer,
        onClick: () => runtime.platform.print(),
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
      }
      ];
      return actions;
    },
    [
      activeRoom,
      isQuickLinksOpen,
      activeSideSurface,
      auth?.user?.role,
      captureRoomScreen,
      cliPaneCreationPending,
      cliFloatsHidden,
      isCompactShell,
      isCodexEnabled,
      isMemoryWorkspaceOpen,
      isCliLauncherOpen,
      isOskKeyboardOpen,
      isPaneLayoutMenuOpen,
      isPaneSpanAllMenuOpen,
      isSideSurfaceOpen,
      isCompactSideSurfaceOpen,
      isServerActionsMenuOpen,
      isThemeMenuOpen,
      isWorkspaceTextSizePickerOpen,
      panes,
      paneLayoutPending,
      reloadRoomWindow,
      runtime,
      selectedRoomId,
      shellMode,
      terminalFontSize
    ]
  );
  const serverActionCommands: ServerActionCommand[] = auth?.user?.role === "ADMIN"
    ? [
        {
          id: "setup-connections",
          label: "Setup & connections",
          description: "See connected tools, verify them, and finish any remaining setup.",
          icon: LinkIcon,
          onSelect: () => setIsSetupConnectionsOpen(true)
        },
        {
          id: "restart-server",
          label: "Restart server",
          description: "Restart the Space core services while protecting CLI and browser sessions.",
          icon: ServerCog,
          disabled: serverRestartPending,
          onSelect: openServerRestartDialog
        },
        {
          id: "restart-all-cli-runtimes",
          label: "Restart all CLI runtimes",
          description: "Restart sessions for every CLI type (codex, claude, gemini, opencode, kimi, ...).",
          icon: Terminal,
          disabled: cliRuntimeRestartAllPending,
          onSelect: openCliRuntimeRestartAllDialog
        },
        {
          id: "space-cli-maintenance",
          label: "Space & CLI maintenance",
          description: "Run Space health, doctor and guarded updates for every CLI app.",
          icon: Wrench,
          onSelect: () => {
            adminOperationToolTriggerRef.current = serverActionsButtonRef.current;
            setAdminOperationTool("maintenance");
          }
        },
        {
          id: "publish-space-release",
          label: "Publish Space release",
          description: "Preview and publish one version to Gitea and GitHub.",
          icon: Rocket,
          onSelect: () => {
            adminOperationToolTriggerRef.current = serverActionsButtonRef.current;
            setAdminOperationTool("release");
          }
        },
        {
          id: "codex-lb-speed-control",
          label: "Codex-LB speed control",
          description: isCodexEnabled
            ? "Set global speed defaults for the current provider models."
            : "OFF · Enable Codex in Settings.",
          icon: Gauge,
          disabled: !isCodexEnabled,
          title: !isCodexEnabled ? "Enable Codex in Settings" : undefined,
          onSelect: () => {
            adminCodexToolTriggerRef.current = serverActionsButtonRef.current;
            setAdminCodexTool("speed");
          }
        },
        {
          id: "codex-history-purge",
          label: "Purge history",
          description: anyCliEnabled
            ? "Preview and remove inactive task history across all active CLIs."
            : "OFF · Enable a CLI in Settings.",
          icon: Trash2,
          disabled: !anyCliEnabled,
          title: !anyCliEnabled ? "Enable a CLI in Settings" : undefined,
          onSelect: () => {
            adminCodexToolTriggerRef.current = serverActionsButtonRef.current;
            setAdminCodexTool("history");
          }
        },
        {
          id: "cli-session-cleanup",
          label: "Clean CLI sessions",
          description: anyCliEnabled
            ? "Remove empty sessions, orphaned codex pane homes and disposable CLI store files."
            : "OFF · Enable a CLI in Settings.",
          icon: Trash2,
          disabled: !anyCliEnabled,
          title: !anyCliEnabled ? "Enable a CLI in Settings" : undefined,
          onSelect: () => {
            adminCodexToolTriggerRef.current = serverActionsButtonRef.current;
            setAdminCodexTool("cleanup");
          }
        },
        {
          id: "clean-detached-cli-sessions",
          label: "Clean detached CLI sessions",
          description: "Clean eligible detached Space CLI sessions.",
          icon: Terminal,
          onSelect: () => toolbarMetricsRef.current?.openCliCleanup(serverActionsButtonRef.current)
        },
        {
          id: "reclaim-safe-memory",
          label: "Reclaim safe memory",
          description: "Run the bounded memory reclaim flow after live safety checks.",
          icon: RefreshCw,
          onSelect: () => toolbarMetricsRef.current?.openMemoryReclaim(serverActionsButtonRef.current)
        }
      ]
    : [];
  const roomToolbar = usePersistentIconToolbar({
    actions: roomToolbarActions,
    hiddenStorageKey: roomToolbarStorageKeys.hidden,
    orderStorageKey: roomToolbarStorageKeys.order
  });
  const MoreRoomActionsIcon = MoreHorizontal;
  const HelpIcon = CircleHelp;
  const roomToolbarRenderedActions = roomToolbar.visibleActions;
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
              : action.id === "font-down"
                ? workspaceTextSizeButtonRef
                : action.id === "theme"
                  ? roomThemeButtonRef
                : action.id === "pane-layout"
                  ? paneLayoutButtonRef
                : action.id === "pane-span-all"
                  ? paneSpanAllButtonRef
                  : undefined
        }
        type="button"
        className={action.className}
        onClick={() => {
          roomToolbar.closeMenus();
          if (action.id !== "theme") setIsThemeMenuOpen(false);
          if (action.id !== "pane-layout") setIsPaneLayoutMenuOpen(false);
          if (action.id !== "pane-span-all") setIsPaneSpanAllMenuOpen(false);
          if (action.id !== "font-down") setIsWorkspaceTextSizePickerOpen(false);
          if (action.id !== "server-restart") setIsServerActionsMenuOpen(false);
          if (action.id !== "add-cli") setIsCliLauncherOpen(false);
          action.onClick();
        }}
        disabled={action.disabled}
        title={action.title}
        aria-label={action.ariaLabel}
        aria-controls={action.ariaControls}
        aria-expanded={action.ariaExpanded}
        aria-haspopup={action.ariaHasPopup}
        aria-pressed={action.ariaPressed}
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
    try {
      runtime.platform.localStorage.setItem(ROOM_TOOLBAR_HIDDEN_STORAGE_KEY, String(hidden));
    } catch {
      // Best effort only.
    }
    setIsRoomToolbarHidden(hidden);
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
  function updateMobilePaneFocusMode(nextFocused: boolean) {
    if (shellMode !== "mobile") return;
    setIsCompactSideSurfaceOpen(false);
    setIsThemeMenuOpen(false);
    setIsPaneLayoutMenuOpen(false);
    setIsPaneSpanAllMenuOpen(false);
    setIsWorkspaceTextSizePickerOpen(false);
    roomToolbar.closeMenus();
    setIsMobilePaneFocusMode(nextFocused);
  }
  useDismissibleToolbarLayer({
    containerRef: roomToolbarActionsRef,
    active: isThemeMenuOpen || isPaneLayoutMenuOpen || isPaneSpanAllMenuOpen || roomToolbar.isOverflowOpen || Boolean(roomToolbar.actionMenu),
    onDismiss: () => {
      setIsThemeMenuOpen(false);
      closePaneLayoutMenu(isPaneLayoutMenuOpen);
      closePaneSpanAllMenu(isPaneSpanAllMenuOpen);
      setIsWorkspaceTextSizePickerOpen(false);
      roomToolbar.closeMenus();
    }
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

  function beginRoomRename() {
    if (!activeRoom || roomRenamePending) return;
    setRoomNameDraft(activeRoom.name);
    setRoomRenameError(null);
    setIsThemeMenuOpen(false);
    setIsWorkspaceTextSizePickerOpen(false);
    roomToolbar.closeMenus();
    setIsRoomRenameOpen(true);
  }

  function cancelRoomRename() {
    setIsRoomRenameOpen(false);
    setRoomRenamePending(false);
    setRoomRenameError(null);
    setRoomNameDraft(activeRoom?.name ?? "");
  }

  function toggleRoomFocusMode() {
    const nextValue = !isRoomFocusMode;
    try {
      runtime.platform.localStorage.setItem(ROOM_FOCUS_MODE_STORAGE_KEY, String(nextValue));
      hasStoredRoomFocusPreferenceRef.current = true;
    } catch {
      // Best effort only.
    }
    setIsRoomFocusMode(nextValue);
  }

  async function submitRoomRename(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!activeRoom || roomRenamePending) return;
    const nextName = roomNameDraft.trim();
    if (!nextName) {
      setRoomRenameError("Room name is required.");
      return;
    }
    if (nextName === activeRoom.name) {
      cancelRoomRename();
      return;
    }
    setRoomRenamePending(true);
    setRoomRenameError(null);
    try {
      const updated = await api.updateRoom(activeRoom.id, { name: nextName });
      setRooms((current) => current.map((room) => (room.id === updated.id ? updated : room)));
      setRoomNameDraft(updated.name);
      setIsRoomRenameOpen(false);
    } catch (err) {
      setRoomRenameError(err instanceof Error ? err.message : "Room rename failed");
    } finally {
      setRoomRenamePending(false);
    }
  }

  useEffect(() => {
    if (!selectedRoomId && isRoomFocusMode) setIsRoomFocusMode(false);
  }, [isRoomFocusMode, selectedRoomId]);
  useEffect(() => {
    const didRoomChange = mobilePaneFocusRoomIdRef.current !== selectedRoomId;
    mobilePaneFocusRoomIdRef.current = selectedRoomId;
    if ((didRoomChange || shellMode !== "mobile" || !activePane) && isMobilePaneFocusMode) {
      setIsMobilePaneFocusMode(false);
    }
  }, [activePane, isMobilePaneFocusMode, selectedRoomId, shellMode]);
  useEffect(() => {
    if (shellMode !== "mobile") {
      if (mobileRoomFocusDefaultAppliedRef.current && !hasStoredRoomFocusPreferenceRef.current) setIsRoomFocusMode(false);
      mobileRoomFocusDefaultAppliedRef.current = false;
      return;
    }
    if (selectedRoomId && !mobileRoomFocusDefaultAppliedRef.current && !hasStoredRoomFocusPreferenceRef.current) {
      mobileRoomFocusDefaultAppliedRef.current = true;
      setIsRoomFocusMode(true);
    }
  }, [selectedRoomId, shellMode]);
  useEffect(() => {
    if (!auth?.isAuthenticated) {
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
          api.cliRuntimeSettings({ forceRefresh: true })
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
    void loadCodexEnvironmentSummary();
    const interval = window.setInterval(() => void loadCodexEnvironmentSummary(), 10000);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      disposed = true;
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [auth?.isAuthenticated]);
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
  const paneCardOnClose = useStableCallback(closePane);
  const paneCardOnMaximize = useStableCallback(toggleMaximize);
  const paneCardOnMinimize = useStableCallback(minimizePane);
  const paneCardOnMobilePaneFocusChange = useStableCallback(updateMobilePaneFocusMode);
  const paneCardOnGrowColumnSpan = useStableCallback(growPaneColumnSpan);
  const paneCardOnResetColumnSpan = useStableCallback(resetPaneColumnSpan);
  const paneCardOnToggleColumnSpan = useStableCallback(togglePaneColumnSpan);
  const paneCardOnSplit = useStableCallback(splitPane);
  const paneCardOnTerminalBootstrapped = useStableCallback(recordRoomPaneBootstrapped);
  const paneCardOnTerminalPrefillReadyChange = useStableCallback(recordRoomTerminalPrefillReady);

  const navigateFullscreenPane = useCallback(
    (direction: "previous" | "next") => {
      const visible = sortPanesForGrid(panes.filter((pane) => !pane.isMinimized));
      if (visible.length < 2) return;
      const currentIndex = Math.max(0, visible.findIndex((pane) => pane.id === selectedPaneId));
      const step = direction === "next" ? 1 : -1;
      const nextPane = visible[(currentIndex + step + visible.length) % visible.length];
      if (nextPane) setSelectedPaneId(nextPane.id);
    },
    [panes, selectedPaneId]
  );
  const paneCardOnFullscreenNavigate = useStableCallback(navigateFullscreenPane);

  async function captureRoomScreen() {
    if (!activeRoom) return;
    const target: ClipImageTarget = {
      roomId: activeRoom.id,
      paneId: activePane?.id ?? null,
      paneMode: activePane?.mode ?? null
    };
    setError(null);
    setClipToolNotice(null);
    if (runtimeKind === "demo") {
      setClipToolNotice(DEMO_LOCAL_REPLY);
      return;
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

  async function routeClipImage(file: File, target: ClipImageTarget) {
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
      files: [file]
    });
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
    await refresh();
    if (activeRoom) await loadRoomRuntime(activeRoom.id);
  }

  function clearRoomReorderState() {
    setDraggedRoomId(null);
    setDragOverRoomId(null);
  }

  function handleRoomDragStart(event: ReactDragEvent<HTMLElement>, roomId: string) {
    if (roomReorderPending) return;
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", roomId);
    }
    setDraggedRoomId(roomId);
    setDragOverRoomId(roomId);
  }

  function handleRoomDragOver(event: ReactDragEvent<HTMLElement>, roomId: string) {
    if (!draggedRoomId || draggedRoomId === roomId || roomReorderPending) return;
    event.preventDefault();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = "move";
    }
    setDragOverRoomId(roomId);
  }

  async function handleRoomDrop(roomId: string) {
    if (!draggedRoomId || draggedRoomId === roomId || roomReorderPending) {
      clearRoomReorderState();
      return;
    }
    const previousRooms = rooms;
    const nextRooms = reorderRoomsById(previousRooms, draggedRoomId, roomId);
    clearRoomReorderState();
    setRooms(nextRooms);
    setRoomReorderPending(true);
    setError(null);
    try {
      const reorderedRooms = await api.reorderRooms(nextRooms.map((room) => room.id));
      setRooms(sortRoomsByOrder(reorderedRooms));
    } catch (err) {
      setRooms(previousRooms);
      setError(err instanceof Error ? err.message : "Room reorder failed");
    } finally {
      setRoomReorderPending(false);
    }
  }

  function clearPaneReorderState() {
    setDraggedPaneId(null);
    setPaneDragOverId(null);
  }

  function handlePaneDragStart(event: ReactDragEvent<HTMLElement>, pane: Pane) {
    if (paneReorderPending) return;
    setPaneDragData(event, pane, activeRoom);
    setDraggedPaneId(pane.id);
  }

  function handlePaneDragOver(event: ReactDragEvent<HTMLElement>, paneId: string) {
    if (!draggedPaneId || draggedPaneId === paneId || paneReorderPending) return;
    event.preventDefault();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = "move";
    }
    setPaneDragOverId(paneId);
  }

  function handlePaneDragLeave(paneId: string) {
    if (paneDragOverId === paneId) {
      setPaneDragOverId(null);
    }
  }

  async function handlePaneDrop(targetPaneId: string) {
    if (!draggedPaneId || draggedPaneId === targetPaneId || paneReorderPending) {
      clearPaneReorderState();
      return;
    }
    const previousPanes = panes;
    const nextPanes = reorderPanesByTarget(previousPanes, draggedPaneId, targetPaneId);
    clearPaneReorderState();
    paneColumnAnchorStartsRef.current = new Map();
    setPanes(nextPanes);
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

  const roomsSurfaceContent = (
    <div className="side-surface-panel side-surface-room-panel">
      <div className="rail-actions">
        <button
          type="button"
          onClick={() => void createRoom()}
          disabled={roomCreationPending}
          aria-busy={roomCreationPending}
          title="Create empty room"
        >
          <Plus aria-hidden="true" />
          New room
        </button>
      </div>
      <div className="room-list">
        {rooms.map((room) => {
          const warmPresentation = classifyRoomWarmPresentation({
            roomId: room.id,
            activeRoomId: selectedRoomId,
            warmRoomIds,
            hydratingRoomIds: new Set(
              Object.entries(roomPaneLoadStates)
                .filter(([, state]) => state === "loading")
                .map(([roomId]) => roomId)
            ),
            loadedRoomIds: new Set(
              Object.entries(roomPaneLoadStates)
                .filter(([, state]) => state === "loaded")
                .map(([roomId]) => roomId)
            )
          });
          const warmLabel =
            warmPresentation === "active"
              ? "Active"
              : warmPresentation === "warm"
                ? "Warm"
                : warmPresentation === "warming"
                  ? "Warming"
                  : "Cold";
          return (
          <div
            key={room.id}
            className={[
              "room-item",
              room.id === selectedRoomId ? "selected" : "",
              draggedRoomId === room.id ? "is-dragging" : "",
              dragOverRoomId === room.id && draggedRoomId !== room.id ? "is-drop-target" : ""
            ].filter(Boolean).join(" ")}
            data-warm-presentation={warmPresentation}
            onDragOver={(event) => handleRoomDragOver(event, room.id)}
            onDrop={(event) => {
              event.preventDefault();
              void handleRoomDrop(room.id);
            }}
            onDragEnd={clearRoomReorderState}
          >
            <button
              type="button"
              className="room-drag-handle"
              aria-label={`Reorder ${room.name}`}
              title={`Reorder ${room.name}`}
              disabled={roomReorderPending}
              draggable={!roomReorderPending}
              onDragStart={(event) => handleRoomDragStart(event, room.id)}
              onDragEnd={clearRoomReorderState}
            >
              <GripVertical aria-hidden="true" />
            </button>
            <button
              className="room-select"
              data-room-id={room.id}
              onClick={() => void selectRoom(room.id, { keepCompactSurfaceOpen: true })}
              disabled={deletePendingRoomId === room.id || roomReorderPending}
              aria-label={`Open ${room.name}`}
              aria-current={room.id === selectedRoomId ? "true" : undefined}
            >
              <span className="room-select-heading">
                <span className="room-name">{room.name}</span>
                <span className="room-cli-badge">
                  CLI {roomCliActivityCounts[room.id] ?? "—"}
                </span>
                {warmRoomEnabled ? (
                  <span
                    className={`room-warm-badge is-${warmPresentation}`}
                    data-warm-presentation={warmPresentation}
                    title={`Warm cache: ${warmLabel}`}
                  >
                    {warmLabel}
                  </span>
                ) : null}
              </span>
              <span className="room-select-meta">
                {room.kind === "AGENT_PROOF" ? <span className="room-kind-badge">Agent Proof</span> : null}
                {room.kind === "CLI_RECOVERY" ? <span className="room-kind-badge">CLI Recovery</span> : null}
                <small>{room.id === selectedRoomId ? "Pane target · " : "Select for panes · "}{room.paneCap} cap</small>
              </span>
            </button>
            <button
              className="room-delete"
              onClick={() => deleteRoom(room.id)}
              disabled={deletePendingRoomId === room.id || roomReorderPending}
              title={`Delete ${room.name}`}
              aria-label={`Delete ${room.name}`}
            >
              <Trash2 aria-hidden="true" />
            </button>
          </div>
          );
        })}
      </div>
      <div className="room-pane-composer-slot" inert={preparingRoomId ? true : undefined}>
        <RoomPaneComposer
          activePaneCount={presentationPanes.length}
          onApply={addRoomPanes}
          onOpenSettings={openSettingsSurface}
          room={presentationRoom}
        />
      </div>
    </div>
  );

  function resumeAgentSessionCodexThread(threadId: string) {
    if (!activePane || !isCodexEnabled) return;
    dispatchAgentPaneAction(activePane.id, { action: "open_thread", threadId });
  }

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

  const sideSurfaceContent =
    activeSideSurface === "rooms" ? (
      roomsSurfaceContent
    ) : activeSideSurface === "room-agent" ? (
      <RoomAgentDock
        activeRoom={activeRoom}
        isCodexEnabled={isCodexEnabled}
        refreshKey={roomEvents.at(-1)?.id ?? null}
      />
    ) : activeSideSurface === "settings" ? (
      <AgentSettingsDock
        activePane={activePane}
        currentAppearance={modernAppearance}
        currentIconPack={modernIconPack}
        currentUiTheme={uiTheme}
        isCodexEnabled={isCodexEnabled}
        canManageCliRuntimes={auth?.user?.role === "ADMIN"}
        canManageDiagnostics={auth?.user?.role === "ADMIN"}
        canManageSourceControl={auth?.user?.role === "ADMIN"}
        canManageTelegram={auth?.user?.role === "ADMIN"}
        suppressNotifications={suppressNotifications}
        providerSettings={providerSettings}
        providers={providers}
        onSuppressNotificationsChange={(suppressed) => {
          setSuppressNotifications(writeStoredSuppressNotifications(suppressed));
        }}
        onProviderSettingsRefresh={setProviderSettings}
        onUiThemeApply={({ appearance, iconPack, theme }) => {
          writeModernAppearance(runtime.platform.localStorage, appearance);
          writeModernIconPack(runtime.platform.localStorage, iconPack);
          writeUiTheme(runtime.platform.localStorage, theme);
          runtime.platform.reloadPage();
        }}
      />
    ) : activeSideSurface === "media" ? (
      <MediaDock activeRoom={activeRoom} refreshKey={latestArtifactEventId} />
    ) : activeSideSurface === "streaming" ? (
      <StreamingDock />
    ) : activeSideSurface === "agent-tools" ? (
      <AgentToolsDock
        canManage={auth?.user?.role === "ADMIN"}
        refreshKey={roomEvents.at(-1)?.id ?? null}
      />
    ) : activeSideSurface === "cli" ? (
      <CliDock
        canManage={auth?.user?.role === "ADMIN"}
        cliImagePreviewLimit={cliImagePreviewLimit}
        warmRoomEnabled={warmRoomEnabled}
        warmRoomCapacity={warmRoomLiveCapacity}
        onCliImagePreviewLimitChange={setCliImagePreviewLimit}
        onWarmRoomEnabledChange={(enabled) => {
          setWarmRoomEnabled(writeStoredWarmRoomEnabled(enabled));
        }}
        onOpenRestartAll={openCliRuntimeRestartAllDialog}
        restartAllPending={cliRuntimeRestartAllPending}
      />
    ) : activeSideSurface === "agent-sessions" ? (
      <AgentSessionsDock
        activePaneLabel={activePane ? displayPaneTitle(activePane) : null}
        canResume={Boolean(selectedRoomId)}
        codexEnabled={isCodexEnabled}
        onResume={resumeAgentSession}
      />
    ) : activeSideSurface === "agent-files" ? (
      <AgentFilesDock activeRoom={activeRoom} refreshKey={latestArtifactEventId} />
    ) : activeSideSurface === "clipboard" ? (
      <ClipboardDock
        canInsert={activePane?.mode === "CHAT" || activePane?.mode === "TERMINAL"}
        activePaneLabel={activePane ? displayPaneTitle(activePane) : null}
        onInsert={insertClipboardItem}
      />
    ) : activeSideSurface === "tasks" ? (
      <TaskDock
        canInsert={activePane?.mode === "CHAT" || activePane?.mode === "TERMINAL"}
        activePaneLabel={activePane ? displayPaneTitle(activePane) : null}
        onInsert={insertTaskItem}
      />
    ) : activeSideSurface === "links" ? (
      <LinksPanel onOpen={openUserLink} />
    ) : activeSideSurface === "logs" ? (
      <ActivityLogDock canManage={auth?.user?.role === "ADMIN"} />
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
      />
    );

  if (!auth || !setupStatus) {
    return (
      <AppIconProvider pack={uiTheme === "modern" ? modernIconPack : "lucide"}>
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
      <AppIconProvider pack={uiTheme === "modern" ? modernIconPack : "lucide"}>
        <OwnerSetupScreen expiresAt={setupStatus.expiresAt} onClaim={handleOwnerClaim} />
      </AppIconProvider>
    );
  }

  if (!auth.isAuthenticated) {
    return (
      <AppIconProvider pack={uiTheme === "modern" ? modernIconPack : "lucide"}>
        <LoginScreen
          auth={auth}
          colorMode={uiTheme === "modern" ? resolveModernColorMode(modernAppearance, systemPrefersDark) : null}
          modern={uiTheme === "modern"}
          onLogin={handleLogin}
        />
      </AppIconProvider>
    );
  }

  const vibeMusicPlayer = (
    <VibeMusicPlayer
      mobile={shellMode === "mobile"}
      open={isVibeMusicOpen}
      onOpenChange={setIsVibeMusicOpen}
      roomTheme={roomTheme}
      triggerRef={vibeMusicButtonRef}
    />
  );

  const oskKeyboard = (
    <OnScreenKeyboard
      mobile={shellMode === "mobile"}
      open={isOskKeyboardOpen}
      onInput={routeOnScreenKeyboardInput}
      onOpenChange={setIsOskKeyboardOpen}
      roomTheme={roomTheme}
    />
  );

  if (auth?.isAuthenticated && appView === "help") {
    const helpContent = <>{vibeMusicPlayer}{oskKeyboard}<HelpPage onBack={closeHelp} /></>;
    return (
      <AppIconProvider pack={uiTheme === "modern" ? modernIconPack : "lucide"}>
        {uiTheme === "modern" ? (
          <div
            className="modern-theme-page"
            data-ui-theme="modern"
            data-color-mode={modernColorMode}
            data-icon-pack={modernIconPack}
            data-room-theme={roomTheme}
          >
            {helpContent}
          </div>
        ) : helpContent}
      </AppIconProvider>
    );
  }

  const isMobilePaneFocused = shellMode === "mobile" && isMobilePaneFocusMode && Boolean(activePane);
  const showMobilePaneSwitcher = shellMode === "mobile" && visiblePanes.length > 1 && !isMobilePaneFocused;
  const showPaneNavigation = !isMobilePaneFocused && (minimizedPanes.length > 0 || showMobilePaneSwitcher);
  const shellClassName = ["space-shell", `shell-${shellMode}`, isRoomFocusMode ? "room-focus-mode" : ""].filter(Boolean).join(" ");
  const workspaceClassName = ["workspace", showInlineSideSurface ? "" : "side-surface-hidden"].filter(Boolean).join(" ");
  const boardClassName = ["board", showPaneNavigation ? "has-pane-navigation" : ""].filter(Boolean).join(" ");
  const mountedRoomRuntimeIds = selectedRoomId
    ? Array.from(new Set(
        [selectedRoomId, displayedRoomId, preparingRoomId, ...warmRoomIds]
          .filter((roomId): roomId is string => Boolean(roomId))
      ))
    : [];

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
    const layerVisiblePanes = layerPanes.filter((pane) => !pane.isMinimized);
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
    const layerDensity = isActive ? paneDensity : paneDensityFor(shellMode, layerVisiblePanes.length);
    const layerColumnCount = isActive
      ? paneGridColumnCount
      : resolvePaneGridColumnCount({
          shellMode,
          paneDensity: layerDensity,
          containerWidth: paneGridWidth,
          paneLayoutColumns: layerRoom?.paneLayoutColumns ?? null,
          visiblePaneCount: layerVisiblePanes.length,
          forceTabletTwoColumns: uiTheme === "modern"
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
    const layerTerminalPrefillReady = layerPanes
      .filter((pane) => pane.mode === "TERMINAL" && !pane.isMinimized)
      .every((pane) => prefillReadyPaneIds.has(pane.id));
    const unorderedTerminalBootstrapPaneIds = layerPanes
      .filter((pane) => pane.mode === "TERMINAL" && !pane.isMinimized)
      .map((pane) => pane.id);
    const priorityTerminalPaneId = layerActivePane?.mode === "TERMINAL" ? layerActivePane.id : null;
    const terminalBootstrapPaneIds = priorityTerminalPaneId
      ? [
          priorityTerminalPaneId,
          ...unorderedTerminalBootstrapPaneIds.filter((paneId) => paneId !== priorityTerminalPaneId)
        ]
      : unorderedTerminalBootstrapPaneIds;
    const layerVisiblePaneCount = (shellMode === "mobile" || layerFullscreenLayout) && layerActivePane ? 1 : layerVisiblePanes.length;
    const layerHasMaximizedPane = shellMode !== "mobile" && layerVisiblePanes.some((pane) => pane.isMaximized);

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
            <Loader2 aria-hidden="true" />
            <h3>Loading panes</h3>
          </div>
        ) : layerPanes.length === 0 && layerPaneLoadState === "error" ? (
          <div className="empty-state" role={isInteractive ? "alert" : undefined}>
            <Grid2X2 aria-hidden="true" />
            <h3>Unable to load panes</h3>
          </div>
        ) : layerPanes.length === 0 ? (
          <div className="empty-state" role={isInteractive ? "status" : undefined}>
            <Grid2X2 aria-hidden="true" />
            <h3>Zero panes open</h3>
            <button onClick={() => addPane("TERMINAL")} disabled={!isInteractive || !selectedRoomId}>
              <Plus aria-hidden="true" />
              Open CLI
            </button>
          </div>
        ) : (
          <TerminalBootstrapBoundary paneIds={terminalBootstrapPaneIds}>
            {(terminalBootstrapBarriers) => (
              <div
                ref={isActive ? paneGridRef : undefined}
                className={layerHasMaximizedPane ? "pane-grid maximized" : "pane-grid"}
                data-density={layerDensity}
                data-shell-mode={shellMode}
                data-pane-count={layerPanes.length}
                data-visible-pane-count={layerVisiblePaneCount}
                data-column-count={layerColumnCount}
                data-pane-layout-columns={layerRoom?.paneLayoutColumns ?? "automatic"}
                data-fullscreen-layout={layerFullscreenLayout ? "true" : undefined}
                style={{ gridTemplateColumns: `repeat(${layerColumnCount}, minmax(0, 1fr))` }}
              >
                {layerPanes.map((pane) => {
                  const latestCompletion = layerLatestCompletionByPane.get(pane.id) ?? null;
                  const placement = layerPlacements.get(pane.id);
                  return (
                    <PaneCard
                      key={pane.id}
                      pane={pane}
                      agentNumber={layerAgentNumberByPaneId.get(pane.id) ?? 1}
                      latestTurn={layerLatestTurnByPane.get(pane.id) ?? null}
                      latestCompletion={latestCompletion}
                      hasPendingCompletion={Boolean(
                        pendingPaneCompletionEventId(paneCompletionLifecycle, pane.id)
                      )}
                      isTarget={isPresented && layerActivePane?.id === pane.id}
                      isMoveDialogOpen={isInteractive && paneMoveDialog?.pane.id === pane.id}
                      isVisibleInShell={isPresented && layerShellVisiblePaneIds.has(pane.id)}
                      maskSensitiveData={maskSensitiveData}
                      isTerminalOutputVisible={
                        acceptsTerminalOutput &&
                        layerShellVisiblePaneIds.has(pane.id)
                      }
                      isMobilePaneFocused={isInteractive && isMobilePaneFocused}
                      browserObserverOnly={auth?.user?.automationScope === "APP_DIAGNOSTICS"}
                      terminalObserverOnly={auth?.user?.automationScope === "APP_DIAGNOSTICS"}
                      uiTheme={uiTheme}
                      shellMode={shellMode}
                      codexTurnsEnabled={codexTurnsEnabled}
                      codexEnvironment={codexEnvironmentSummary}
                      canMoveToAnotherRoom={rooms.some((room) => room.id !== pane.roomId)}
                      draggedPaneId={draggedPaneId}
                      dragOverPaneId={paneDragOverId}
                      paneReorderPending={paneReorderPending}
                      onPaneDragStart={handlePaneDragStart}
                      onPaneDragEnd={clearPaneReorderState}
                      onPaneDragOver={handlePaneDragOver}
                      onPaneDragLeave={handlePaneDragLeave}
                      onPaneDrop={handlePaneDrop}
                      onTarget={paneCardOnTarget}
                      onMove={paneCardOnMove}
                      onPaneUpdated={paneCardOnPaneUpdated}
                      onClose={paneCardOnClose}
                      onMaximize={paneCardOnMaximize}
                      onMinimize={paneCardOnMinimize}
                      onMobilePaneFocusChange={paneCardOnMobilePaneFocusChange}
                      onGrowColumnSpan={paneCardOnGrowColumnSpan}
                      onResetColumnSpan={paneCardOnResetColumnSpan}
                      onToggleColumnSpan={paneCardOnToggleColumnSpan}
                      onSplit={paneCardOnSplit}
                      isFullscreenLayout={layerFullscreenLayout}
                      fullscreenIndex={layerFullscreenLayout ? Math.max(0, layerVisiblePanes.findIndex((candidate) => candidate.id === pane.id)) : 0}
                      fullscreenCount={layerVisiblePanes.length}
                      onFullscreenNavigate={paneCardOnFullscreenNavigate}
                      effectiveColumnSpan={placement?.effectiveSpan ?? 1}
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
                        (!pane.isMinimized || bootstrappedPaneIds.has(pane.id))
                      }
                      prefillInitialReplay={presentationState === "hidden" && !pane.isMinimized}
                      revealGeneration={roomPresentationGenerationRef.current}
                      onTerminalBootstrapped={paneCardOnTerminalBootstrapped}
                      onTerminalPrefillReadyChange={paneCardOnTerminalPrefillReadyChange}
                      onTerminalRevealReady={recordTerminalRevealReady}
                    />
                  );
                })}
              </div>
            )}
          </TerminalBootstrapBoundary>
        )}
      </div>
    );
  }

  return (
    <AppIconProvider pack={uiTheme === "modern" ? modernIconPack : "lucide"}>
      <StreamingOverlayProvider active={auth.user?.role === "ADMIN"}>
      {vibeMusicPlayer}
      {oskKeyboard}
      <SetupConnectionsWizard
        checks={api}
        open={isSetupConnectionsOpen}
        finish={api.finishSetup}
        loadOverview={api.setupOverview}
        onOpenChange={setIsSetupConnectionsOpen}
        openLogin={openSetupConnectionLogin}
        onOpenMaintenance={() => {
          setIsSetupConnectionsOpen(false);
          adminOperationToolTriggerRef.current = serverActionsButtonRef.current;
          setAdminOperationTool("maintenance");
        }}
        triggerRef={serverActionsButtonRef}
      />
      <AppDiagnosticsGlobalIndicators />
      <SensitiveDataMask enabled={maskSensitiveData} />
      <main
      className={shellClassName}
      data-room-theme={roomTheme}
      data-sensitive-mode={maskSensitiveData ? "hidden" : undefined}
      data-ui-theme={uiTheme === "modern" ? "modern" : undefined}
      data-color-mode={uiTheme === "modern" ? modernColorMode : undefined}
      data-icon-pack={uiTheme === "modern" ? modernIconPack : undefined}
      data-room-id={activeRoom?.id}
      data-shell-mode={shellMode}
      data-warm-room-cache-enabled={String(warmRoomEnabled)}
      data-suppress-notifications={String(suppressNotifications)}
      data-warm-room-safe-capacity={warmRoomCapacity.effectiveSafeRoomCapacity}
      data-warm-room-hard-capacity={warmRoomCapacity.hardRoomCapacity}
      data-warm-room-count={warmRoomLiveCapacity.warmRoomCount}
      data-warm-room-connected-panes={warmRoomLiveCapacity.connectedPaneCount}
      data-warm-room-memory-source={warmRoomCapacity.memorySource}
      data-warm-room-pressure={warmRoomCapacity.pressureReasons.length > 0 ? "true" : "false"}
      data-warm-room-overcommit={warmRoomCapacity.overcommitInUse ? "true" : "false"}
      data-warm-room-admission-decision={warmRoomAdmissionDecision?.action}
      data-warm-room-admission-automatic={warmRoomAdmissionDecision?.automatic ? "true" : undefined}
      data-warm-room-admission-target={warmRoomAdmissionDecision?.targetRoomId}
      data-warm-room-admission-evicted={warmRoomAdmissionDecision?.evictedRoomId ?? undefined}
      data-warm-room-admission-used-cold-reveal-reserve={
        warmRoomAdmissionDecision
          ? warmRoomAdmissionDecision.usedColdRevealReserve
            ? "true"
            : "false"
          : undefined
      }
      data-warm-room-admission-sequence={warmRoomAdmissionDecision?.sequence}
      data-cli-floats-hidden={cliFloatsHidden ? "true" : "false"}
      data-room-toolbar-hidden={isRoomToolbarHidden ? "true" : undefined}
      data-mobile-pane-focus={isMobilePaneFocused ? "true" : undefined}
    >
      {!isRoomFocusMode && !isMobilePaneFocused ? <header className="topbar">
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

      <GlobalApiErrorAlert actionError={error} />
      {storageWarning && (!isRoomFocusMode || runtimeKind === "demo") ? <div className="banner warn">{storageWarning}</div> : null}
      {clipToolNotice ? (
        <div className="banner warn" role="status">
          <div className="notice-row"><span>{clipToolNotice}</span><button type="button" className="notice-close" aria-label="Dismiss message" onClick={() => setClipToolNotice(null)}><X aria-hidden="true" /></button></div>
        </div>
      ) : null}
      {!isRoomFocusMode && clipboardNotice ? (
        <div className="banner warn" role="status">
          <div className="notice-row"><span>{clipboardNotice}</span><button type="button" className="notice-close" aria-label="Dismiss message" onClick={() => setClipboardNotice(null)}><X aria-hidden="true" /></button></div>
        </div>
      ) : null}

      {auth?.user?.role === "ADMIN" && adminCodexTool ? (
        <AdminCodexToolsDialog
          initialTool={adminCodexTool}
          isCodexEnabled={isCodexEnabled}
          anyCliEnabled={anyCliEnabled}
          onClose={closeAdminCodexTool}
        />
      ) : null}

      {auth?.user?.role === "ADMIN" && adminOperationTool ? (
        <Suspense fallback={<div role="status">Loading admin operation…</div>}>
          <LazyAdminOperationsDialog initialTool={adminOperationTool} onClose={closeAdminOperationTool} />
        </Suspense>
      ) : null}

      {isMemoryWorkspaceOpen ? (
        <Suspense fallback={<div className="memory-workspace-loading" role="status">Loading memory workspace…</div>}>
          <LazyMemoryWorkspace
            shellMode={shellMode}
            activeRoomId={activeRoom?.id ?? null}
            onClose={() => setIsMemoryWorkspaceOpen(false)}
          />
        </Suspense>
      ) : null}
      {systemAnalyticsTab ? (
        <Suspense fallback={<div className="system-analytics-loading" role="status">Loading system analytics…</div>}>
          <LazySystemAnalyticsWorkspace
            shellMode={shellMode}
            initialTab={systemAnalyticsTab}
            onClose={() => setSystemAnalyticsTab(null)}
          />
        </Suspense>
      ) : null}
      {!isMemoryWorkspaceOpen && !systemAnalyticsTab ? <section className={workspaceClassName}>
        {showInlineSideSurface ? (
          <aside className="side-surface side-surface-inline" aria-label={activeSideSurfaceLabel} data-surface={activeSideSurface}>
            {sideSurfaceContent}
          </aside>
        ) : null}
        {showOverlaySideSurface ? (
          <>
            <button className="surface-dismiss-layer" type="button" aria-label={activeSideSurfaceCloseLabel} onClick={closeCompactSideSurface} />
            <aside
              ref={compactSideSurfaceRef}
              className="side-surface side-surface-drawer"
              role="dialog"
              aria-modal="true"
              aria-label={activeSideSurfaceLabel}
              data-surface={activeSideSurface}
              data-surface-mode="drawer"
            >
              <div className="surface-header">
                <strong>{activeSideSurfaceLabel}</strong>
                <button
                  type="button"
                  className="icon-button"
                  aria-label={activeSideSurfaceCloseLabel}
                  title={activeSideSurfaceCloseLabel}
                  onClick={closeCompactSideSurface}
                >
                  <X aria-hidden="true" />
                </button>
              </div>
              {sideSurfaceContent}
            </aside>
          </>
        ) : null}

        <section className={boardClassName} aria-label="Pane board">
          {!isMobilePaneFocused && isRoomToolbarHidden ? (
            <div className="room-toolbar-collapsed room-toolbar-floating-controls" role="region" aria-label="Room toolbar hidden">
              <button
                type="button"
                className="room-toolbar-visibility-button"
                title="Show room toolbar"
                aria-label="Show room toolbar"
                onClick={() => updateRoomToolbarVisibility(false)}
              >
                <PanelTopOpen aria-hidden="true" />
              </button>
            </div>
          ) : null}
          {!isMobilePaneFocused && !isRoomToolbarHidden ? (
            <div
              ref={boardToolbarRef}
              className="board-toolbar"
              data-room-actions-stacked={isRoomToolbarStacked ? "true" : undefined}
              data-presentation-state={preparingRoomId ? "held" : "displayed"}
              aria-disabled={preparingRoomId ? "true" : undefined}
              inert={preparingRoomId ? true : undefined}
            >
            <div className="board-toolbar-main">
              <div className="board-title-row">
                {isRoomFocusMode ? <SpaceBrand /> : null}
                <div className="board-title-heading">
                  {isRoomRenameOpen && presentationRoom ? (
                    <form className="room-title-form" onSubmit={submitRoomRename}>
                      <input
                        aria-label="Room name"
                        value={roomNameDraft}
                        disabled={roomRenamePending}
                        onChange={(event) => setRoomNameDraft(event.currentTarget.value)}
                        onKeyDown={(event) => {
                          if (event.key === "Escape") {
                            event.preventDefault();
                            cancelRoomRename();
                          }
                        }}
                        autoFocus
                      />
                      <button type="submit" title="Save room name" aria-label="Save room name" disabled={roomRenamePending}>
                        <Save aria-hidden="true" />
                      </button>
                      <button
                        type="button"
                        title="Cancel room rename"
                        aria-label="Cancel room rename"
                        onClick={cancelRoomRename}
                        disabled={roomRenamePending}
                      >
                        <Undo2 aria-hidden="true" />
                      </button>
                    </form>
                  ) : (
                    <h2>{presentationRoom?.name ?? "No room"}</h2>
                  )}
                  {presentationRoom ? (
                    <div className="board-title-controls">
                      {!isRoomRenameOpen ? (
                        <button
                          type="button"
                          className="room-title-edit"
                          title={`Rename ${presentationRoom.name}`}
                          aria-label={`Rename ${presentationRoom.name}`}
                          onClick={beginRoomRename}
                        >
                          <Pencil aria-hidden="true" />
                        </button>
                      ) : null}
                      <div className="room-title-nav" role="group" aria-label="Room navigation">
                        <button
                          type="button"
                          title="Previous room"
                          aria-label="Previous room"
                          disabled={!previousRoom}
                          onClick={() => {
                            if (previousRoom) {
                              void selectRoom(previousRoom.id);
                            }
                          }}
                        >
                          <ChevronLeft aria-hidden="true" />
                        </button>
                        <button
                          type="button"
                          title="Next room"
                          aria-label="Next room"
                          disabled={!nextRoom}
                          onClick={() => {
                            if (nextRoom) {
                              void selectRoom(nextRoom.id);
                            }
                          }}
                        >
                          <ChevronRight aria-hidden="true" />
                        </button>
                      </div>
                    </div>
                  ) : null}
                </div>
              </div>
              {roomRenameError ? <p className="room-title-error" role="alert"><span>{roomRenameError}</span><button type="button" className="notice-close" aria-label="Dismiss message" onClick={() => setRoomRenameError(null)}><X aria-hidden="true" /></button></p> : null}
              {paneMoveNotice ? (
                <div className="validation-result" role="status" aria-live="polite">
                  <div className="notice-row"><span>{paneMoveNotice}</span><button type="button" className="notice-close" aria-label="Dismiss message" onClick={() => setPaneMoveNotice(null)}><X aria-hidden="true" /></button></div>
                </div>
              ) : null}
            </div>
            <div className="toolbar-actions" ref={roomToolbarActionsRef}>
              {presentationRoom ? (
                <ToolbarMetrics
                  ref={toolbarMetricsRef}
                  canManage={auth?.user?.role === "ADMIN"}
                  environment={codexEnvironmentSummary}
                  roomName={presentationRoom.name}
                  roomId={presentationRoom.id}
                  onOpenAnalytics={(tab) => {
                    setIsMemoryWorkspaceOpen(false);
                    setSystemAnalyticsTab(tab);
                  }}
                  onChanged={refreshToolbarSystemState}
                />
              ) : null}
              <div ref={roomToolbarScrollRef} className="toolbar-actions-scroll">
                {uiTheme === "modern" ? (
                  <div className="modern-action-groups">
                    {groupModernRoomActions(roomToolbarRenderedActions).map((group) => group.actions.length ? (
                      <div
                        key={group.id}
                        className="modern-action-group"
                        data-action-group={group.id}
                        role="group"
                        aria-label={group.label}
                      >
                        <span className="modern-action-group-label">{group.label}</span>
                        <div className="modern-action-group-buttons">
                          {group.actions.map(renderRoomToolbarAction)}
                        </div>
                      </div>
                    ) : null)}
                  </div>
                ) : roomToolbarRenderedActions.map(renderRoomToolbarAction)}
              </div>
              <div className="toolbar-actions-fixed room-toolbar-floating-controls" role="group" aria-label="Room utility controls">
                <div className="toolbar-overflow">
                  <button
                    ref={roomOverflowTriggerRef}
                    type="button"
                    title="More room actions"
                    aria-label="More room actions"
                    aria-controls="room-actions-popup"
                    aria-expanded={roomToolbar.isOverflowOpen}
                    aria-haspopup={shellMode === "mobile" ? "dialog" : "menu"}
                    onClick={() => {
                      setIsThemeMenuOpen(false);
                      setIsPaneLayoutMenuOpen(false);
                      setIsPaneSpanAllMenuOpen(false);
                      setIsWorkspaceTextSizePickerOpen(false);
                      setIsServerActionsMenuOpen(false);
                      setIsCliLauncherOpen(false);
                      roomToolbar.setActionMenu(null);
                      roomToolbar.setIsOverflowOpen((current) => !current);
                    }}
                  >
                    <MoreRoomActionsIcon aria-hidden="true" />
                  </button>
                  {roomToolbar.isOverflowOpen ? (
                    shellMode === "mobile" ? (
                      <MobileActionSheet
                        actionSections={uiTheme === "modern" ? groupModernRoomActions(roomToolbar.orderedActions) : undefined}
                        actions={roomToolbar.orderedActions}
                        hiddenActionIds={roomToolbar.hiddenActionIds}
                        label="Room actions"
                        onClose={roomToolbar.closeMenus}
                        onHideAction={roomToolbar.hideAction}
                        onShowAction={roomToolbar.showAction}
                        onRunAction={(action) => {
                          roomToolbar.closeMenus();
                          if (action.id !== "theme") setIsThemeMenuOpen(false);
                          if (action.id !== "pane-layout") setIsPaneLayoutMenuOpen(false);
                          if (action.id !== "pane-span-all") setIsPaneSpanAllMenuOpen(false);
                          if (action.id !== "font-down") setIsWorkspaceTextSizePickerOpen(false);
                          if (action.id !== "add-cli") setIsCliLauncherOpen(false);
                          action.onClick();
                        }}
                        popupId="room-actions-popup"
                        summary={<ToolbarMetricsSummary environment={codexEnvironmentSummary} />}
                        triggerRef={roomOverflowTriggerRef}
                      />
                    ) : (
                      <DesktopActionManager
                        actions={roomToolbar.orderedActions}
                        hiddenActionIds={roomToolbar.hiddenActionIds}
                        label="Room actions"
                        onClose={roomToolbar.closeMenus}
                        onHideAction={roomToolbar.hideAction}
                        onShowAction={roomToolbar.showAction}
                        popupId="room-actions-popup"
                        triggerRef={roomOverflowTriggerRef}
                      />
                    )
                  ) : null}
                </div>
                <button
                  ref={vibeMusicButtonRef}
                  type="button"
                  title="Vibe music with freeCodeCamp Code Radio"
                  aria-label="Music"
                  aria-controls={VIBE_MUSIC_PANEL_ID}
                  aria-expanded={isVibeMusicOpen}
                  aria-haspopup="dialog"
                  onClick={() => {
                    roomToolbar.closeMenus();
                    setIsQuickLinksOpen(false);
                    setIsThemeMenuOpen(false);
                    setIsPaneLayoutMenuOpen(false);
                    setIsPaneSpanAllMenuOpen(false);
                    setIsWorkspaceTextSizePickerOpen(false);
                    setIsServerActionsMenuOpen(false);
                    setIsCliLauncherOpen(false);
                    setIsVibeMusicOpen((current) => !current);
                  }}
                >
                  <Music2 aria-hidden="true" />
                </button>
                <button
                  type="button"
                  title="Help"
                  aria-label="Help"
                  onClick={() => {
                    roomToolbar.closeMenus();
                    setIsThemeMenuOpen(false);
                    setIsPaneLayoutMenuOpen(false);
                    setIsPaneSpanAllMenuOpen(false);
                    setIsWorkspaceTextSizePickerOpen(false);
                    setIsVibeMusicOpen(false);
                    setIsCliLauncherOpen(false);
                    openHelp();
                  }}
                >
                  <HelpIcon aria-hidden="true" />
                </button>
                <button
                  type="button"
                  title={isRoomFocusMode ? "Restore room" : "Maximize room"}
                  aria-label={isRoomFocusMode ? "Restore room" : "Maximize room"}
                  aria-pressed={isRoomFocusMode}
                  onClick={() => {
                    setIsPaneLayoutMenuOpen(false);
                    setIsCliLauncherOpen(false);
                    toggleRoomFocusMode();
                  }}
                  disabled={!activeRoom}
                >
                  {isRoomFocusMode ? <Minimize2 aria-hidden="true" /> : <Maximize2 aria-hidden="true" />}
                </button>
                <button
                  type="button"
                  title="Sign out"
                  aria-label="Sign out"
                  onClick={() => void signOut()}
                >
                  <LogOut aria-hidden="true" />
                </button>
                <button
                  type="button"
                  className="room-toolbar-visibility-button"
                  title="Hide room toolbar"
                  aria-label="Hide room toolbar"
                  onClick={() => updateRoomToolbarVisibility(true)}
                >
                  <Minus aria-hidden="true" />
                </button>
              </div>
              {isPaneLayoutMenuOpen && activeRoom ? (
                <PaneLayoutMenu
                  automaticColumns={automaticPaneGridColumnCount}
                  currentColumns={activeRoom.paneLayoutColumns ?? null}
                  error={paneLayoutError}
                  maximumColumns={shellMode === "mobile" ? 1 : shellMode === "tablet" ? 2 : 4}
                  onClose={() => setIsPaneLayoutMenuOpen(false)}
                  onSelect={(paneLayoutColumns) => void applyPaneLayoutPreset(paneLayoutColumns)}
                  pending={paneLayoutPending}
                  triggerRef={paneLayoutButtonRef}
                  visiblePaneCount={visiblePanes.length}
                />
              ) : null}
              {isPaneSpanAllMenuOpen && activeRoom ? (
                <PaneSpanAllMenu
                  activeColumnCount={paneGridColumnCount}
                  currentSpan={commonPaneColumnSpan(visiblePanes)}
                  error={paneSpanAllError}
                  onClose={() => setIsPaneSpanAllMenuOpen(false)}
                  onSelect={(columnSpan) => void applyPaneSpanToAll(columnSpan)}
                  pending={paneSpanAllPending}
                  triggerRef={paneSpanAllButtonRef}
                  visiblePaneCount={visiblePanes.length}
                />
              ) : null}
              {isCliLauncherOpen ? (
                <CliLauncherMenu
                  atPaneCap={panes.length >= 16}
                  isCodexEnabled={isCodexEnabled}
                  mobile={shellMode === "mobile"}
                  onClose={() => setIsCliLauncherOpen(false)}
                  onCreate={addCliRuntimePane}
                  onLogin={openCliRuntimeLogin}
                  onOpenSettings={openSettingsSurface}
                  triggerRef={cliLauncherReturnFocusRef}
                />
              ) : null}
              {isThemeMenuOpen ? (
                <RoomThemeMenu
                  currentTheme={roomTheme}
                  mobile={shellMode === "mobile"}
                  onClose={() => setIsThemeMenuOpen(false)}
                  onSelect={setRoomTheme}
                  triggerRef={roomThemeButtonRef}
                />
              ) : null}
              <WorkspaceTextSizePicker
                anchorRef={workspaceTextSizeButtonRef}
                open={isWorkspaceTextSizePickerOpen}
                value={terminalFontSize}
                onChange={setTerminalFontSize}
                onClose={() => setIsWorkspaceTextSizePickerOpen(false)}
              />
              {auth?.user?.role === "ADMIN" && isServerActionsMenuOpen ? (
                <ServerActionsMenu
                  actions={serverActionCommands}
                  mobile={shellMode === "mobile"}
                  onClose={() => setIsServerActionsMenuOpen(false)}
                  triggerRef={serverActionsButtonRef}
                />
              ) : null}
              {isServerRestartDialogOpen ? (
                <div
                  className="attachment-modal server-restart-modal"
                  onClick={closeServerRestartDialog}
                >
                  <section
                    className="attachment-modal-body server-restart-modal-body"
                    role="dialog"
                    aria-modal="true"
                    aria-label="Restart Space server"
                    onClick={(event) => event.stopPropagation()}
                    onKeyDown={(event) => {
                      if (event.key === "Escape" && !serverRestartPending) {
                        event.preventDefault();
                        closeServerRestartDialog();
                      }
                    }}
                  >
                    <header>
                      <ServerCog aria-hidden="true" />
                      <div>
                        <h3>Restart Space server</h3>
                        <p>Restarts space-worker.service, space-api.service, and space-web.service.</p>
                      </div>
                    </header>
                    <p>CLI and browser sessions stay protected because codex-pane-host, the admin host, and the browser host are not restarted.</p>
                    {serverRestartMessage ? <p className="server-restart-status" role="status"><span>{serverRestartMessage}</span><button type="button" className="notice-close" aria-label="Dismiss message" onClick={() => setServerRestartMessage(null)}><X aria-hidden="true" /></button></p> : null}
                    {serverRestartError ? <p className="server-restart-error" role="alert"><span>{serverRestartError}</span><button type="button" className="notice-close" aria-label="Dismiss message" onClick={() => setServerRestartError(null)}><X aria-hidden="true" /></button></p> : null}
                    <div className="server-restart-modal-actions">
                      <button type="button" autoFocus onClick={closeServerRestartDialog} disabled={serverRestartPending}>
                        Cancel
                      </button>
                      <button type="button" className="danger" onClick={() => void confirmServerRestart()} disabled={serverRestartPending}>
                        {serverRestartPending ? "Restarting..." : "Restart server"}
                      </button>
                    </div>
                  </section>
                </div>
              ) : null}
              {isCliRuntimeRestartAllDialogOpen ? (
                <div
                  className="attachment-modal server-restart-modal"
                  onClick={closeCliRuntimeRestartAllDialog}
                >
                  <section
                    className="attachment-modal-body server-restart-modal-body"
                    role="dialog"
                    aria-modal="true"
                    aria-label="Restart all CLI runtimes"
                    onClick={(event) => event.stopPropagation()}
                    onKeyDown={(event) => {
                      if (event.key === "Escape" && !cliRuntimeRestartAllPending) {
                        event.preventDefault();
                        closeCliRuntimeRestartAllDialog();
                      }
                    }}
                  >
                    <header>
                      <Terminal aria-hidden="true" />
                      <div>
                        <h3>Restart all CLI runtimes</h3>
                        <p>Stops and restarts the sessions of every CLI type one after another.</p>
                      </div>
                    </header>
                    <p>Codex, claude, gemini, opencode, kimi, and the other CLI runtimes are restarted individually; the pane host service itself is not restarted.</p>
                    {cliRuntimeRestartAllMessage ? <p className="server-restart-status" role="status"><span>{cliRuntimeRestartAllMessage}</span><button type="button" className="notice-close" aria-label="Dismiss message" onClick={() => setCliRuntimeRestartAllMessage(null)}><X aria-hidden="true" /></button></p> : null}
                    {cliRuntimeRestartAllError ? <p className="server-restart-error" role="alert"><span>{cliRuntimeRestartAllError}</span><button type="button" className="notice-close" aria-label="Dismiss message" onClick={() => setCliRuntimeRestartAllError(null)}><X aria-hidden="true" /></button></p> : null}
                    <div className="server-restart-modal-actions">
                      <button type="button" autoFocus onClick={closeCliRuntimeRestartAllDialog} disabled={cliRuntimeRestartAllPending}>
                        Cancel
                      </button>
                      <button type="button" className="danger" onClick={() => void confirmCliRuntimeRestartAll()} disabled={cliRuntimeRestartAllPending}>
                        {cliRuntimeRestartAllPending ? "Restarting..." : "Restart all CLI runtimes"}
                      </button>
                    </div>
                  </section>
                </div>
              ) : null}
              {roomToolbar.actionMenu ? (
                <div
                  className="icon-context-menu"
                  role="menu"
                  aria-label={`Action menu ${roomToolbar.actionMenu.actionLabel}`}
                  style={{ left: `${roomToolbar.actionMenu.x}px`, top: `${roomToolbar.actionMenu.y}px` }}
                >
                  {roomToolbar.actionMenu.actionId === "sensitive-data" ? (
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        if (roomToolbar.actionMenu) {
                          roomToolbar.closeMenus();
                          toggleMaskSensitiveData();
                        }
                      }}
                    >
                      {maskSensitiveData ? "Show sensitive data" : "Hide sensitive data"}
                    </button>
                  ) : (
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        if (roomToolbar.actionMenu) {
                          roomToolbar.hideAction(roomToolbar.actionMenu.actionId);
                        }
                      }}
                    >
                      Hide
                    </button>
                  )}
                </div>
              ) : null}
            </div>
            </div>
          ) : null}
          {showPaneNavigation ? (
            <div className="pane-navigation">
              {minimizedPanes.length > 0 ? (
                <section className="minimized-pane-bar" aria-label="Minimized panes">
                  <div className="minimized-pane-items">
                    {visiblePanes.length === 0 ? (
                      <span className="all-panes-minimized" role="status">All panes minimized</span>
                    ) : null}
                    {minimizedPanes.map((pane) => {
                      return (
                        <button
                          key={pane.id}
                          ref={(element) => {
                            if (element) minimizedPaneRestoreRefs.current.set(pane.id, element);
                            else minimizedPaneRestoreRefs.current.delete(pane.id);
                          }}
                          type="button"
                          aria-label={`Restore pane ${displayPaneTitle(pane)}`}
                          title={pane.title}
                          onClick={() => void restorePane(pane)}
                        >
                          <PaneModeIcon pane={pane} />
                          <span>{pane.title}</span>
                        </button>
                      );
                    })}
                  </div>
                  <button
                    type="button"
                    className="restore-all-panes"
                    aria-label="Restore all minimized panes"
                    title="Restore all minimized panes"
                    disabled={restoreAllPending}
                    onClick={() => void restoreAllPanes()}
                  >
                    <Grid2X2 aria-hidden="true" />
                    <span>{restoreAllPending ? "Restoring…" : "Restore all"}</span>
                  </button>
                </section>
              ) : null}
              {showMobilePaneSwitcher ? (
                <div className="pane-switcher" role="tablist" aria-label="Room panes">
                  {visiblePanes.map((pane) => {
                    const agentNumber = agentNumberByPaneId.get(pane.id) ?? 0;
                    const agentTone = ((agentNumber - 1 + 8) % 8) + 1;
                    const isSelected = pane.id === activePane?.id;
                    return (
                      <button
                        key={pane.id}
                        type="button"
                        className={isSelected ? "selected" : ""}
                        data-agent-tone={agentTone}
                        role="tab"
                        aria-selected={isSelected}
                        aria-label={`Show ${displayPaneTitle(pane)} for agent ${agentNumber}`}
                        title={`${displayPaneTitle(pane)} / Agent ${agentNumber}`}
                        onClick={(event) => {
                          targetPaneFromUser(pane.id);
                          event.currentTarget.scrollIntoView?.({ block: "nearest", inline: "center" });
                        }}
                      >
                        <span className="pane-switcher-meta">
                          <em>Agent {agentNumber}</em>
                          <small>{paneModeLabel(pane.mode)}</small>
                        </span>
                        <strong>{displayPaneTitle(pane)}</strong>
                      </button>
                    );
                  })}
                </div>
              ) : null}
            </div>
          ) : null}

          <div
            className="room-runtime-stack"
            aria-busy={preparingRoomId ? "true" : "false"}
            data-presentation-generation={roomPresentationGenerationRef.current}
          >
            {mountedRoomRuntimeIds.map((roomId) => renderRoomRuntimeLayer(roomId))}
          </div>
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

      </section> : null}
      <QuickLinksPopover open={isQuickLinksOpen} onClose={() => setIsQuickLinksOpen(false)} onOpen={openUserLink} onManage={manageLinks} />
      {activeUserLink ? (
        <EmbeddedDashboardDialog link={activeUserLink} onClose={() => setActiveUserLink(null)} />
      ) : null}
      </main>
      <StreamingOverlay theme={uiTheme === "modern" ? "modern" : "classic"} />
      </StreamingOverlayProvider>
    </AppIconProvider>
  );
}

function LoginScreen({
  auth,
  colorMode,
  modern,
  onLogin
}: {
  auth: AuthMe;
  colorMode: ModernColorMode | null;
  modern: boolean;
  onLogin: (auth: AuthMe) => void | Promise<void>;
}) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);

  function loginErrorMessage(err: unknown): string {
    if (err instanceof SpaceApiError && err.code === "INVALID_CREDENTIALS") {
      return "Login rejected. Use the configured operator credentials, or the documented development account when development login is enabled.";
    }
    return err instanceof Error ? err.message : "Login failed";
  }

  return (
    <main
      className={modern ? "login-shell modern-theme-page" : "login-shell"}
      data-ui-theme={modern ? "modern" : undefined}
      data-color-mode={modern ? colorMode ?? undefined : undefined}
    >
      <form
        className="login-panel"
        onSubmit={(event) => {
          event.preventDefault();
          api
            .login(email, password)
            .then(onLogin)
            .catch((err: unknown) => setError(loginErrorMessage(err)));
        }}
      >
        <div className="brand login-brand">
          <Lock aria-hidden="true" />
          <div>
            <h1>Space</h1>
            <span>{auth.isSetupRequired ? "Operator setup required" : "Operator access"}</span>
          </div>
        </div>
        <label htmlFor="operator-email">
          Email
          <input
            id="operator-email"
            name="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            type="email"
            autoComplete="username"
          />
        </label>
        <label htmlFor="operator-password">
          Password
          <input
            id="operator-password"
            name="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            type="password"
            autoComplete="current-password"
          />
        </label>
        {error ? <p className="form-error">{error}</p> : null}
        <button type="submit">Enter</button>
      </form>
    </main>
  );
}

const providerTypeOptions: CreateProviderInput["type"][] = ["CODEX_LB", "OPENAI", "ANTHROPIC", "LOCAL", "CUSTOM"];
const providerRouteProfileOptions: NonNullable<Provider["routeProfile"]>[] = [
  "headroom",
  "direct-primary",
  "direct-auto",
  "direct-fallback",
  "openai-direct",
  "custom"
];

interface ProviderFormState {
  id: string;
  displayName: string;
  type: CreateProviderInput["type"];
  baseUrl: string;
  routeProfile: NonNullable<Provider["routeProfile"]>;
  backingProviderId: string;
  credentialRef: string;
}

const emptyProviderForm: ProviderFormState = {
  id: "",
  displayName: "",
  type: "CUSTOM",
  baseUrl: "",
  routeProfile: "custom",
  backingProviderId: "",
  credentialRef: ""
};

function providerFormFrom(provider: Provider): ProviderFormState {
  return {
    id: provider.id,
    displayName: provider.displayName,
    type: provider.type,
    baseUrl: provider.baseUrl ?? "",
    routeProfile: provider.routeProfile ?? "custom",
    backingProviderId: provider.backingProviderId ?? "",
    credentialRef: provider.credentialRef ?? ""
  };
}

function providerModelCount(provider: Provider, models: Model[]): number {
  return models.filter((model) => model.providerId === provider.id || model.providerId === provider.backingProviderId).length;
}

function providerRouteLabel(provider: Provider): string {
  return [provider.routeProfile ?? "custom", provider.backingProviderId ?? provider.type.toLowerCase()].join(" / ");
}

function providerFormPayload(form: ProviderFormState): CreateProviderInput {
  return {
    id: form.id.trim(),
    displayName: form.displayName.trim(),
    type: form.type,
    baseUrl: form.baseUrl.trim() || null,
    routeProfile: form.routeProfile,
    backingProviderId: form.backingProviderId.trim() || null,
    credentialRef: form.credentialRef.trim() || null
  };
}

function providerUpdatePayload(form: ProviderFormState): UpdateProviderInput {
  const payload = providerFormPayload(form);
  return {
    displayName: payload.displayName,
    type: payload.type,
    baseUrl: payload.baseUrl,
    routeProfile: payload.routeProfile,
    backingProviderId: payload.backingProviderId,
    credentialRef: payload.credentialRef
  };
}

function ProviderSettingsCard({
  settings,
  providers,
  models,
  onProviderSettingsRefresh,
  onProvidersRefresh,
  onModelsRefresh
}: {
  settings: ProviderSettings | null;
  providers: Provider[];
  models: Model[];
  onProviderSettingsRefresh: (settings: ProviderSettings) => void;
  onProvidersRefresh: (providers: Provider[]) => void;
  onModelsRefresh: (models: Model[]) => void;
}) {
  const [validationResults, setValidationResults] = useState<Record<string, ProviderValidationResult>>({});
  const [validationErrors, setValidationErrors] = useState<Record<string, string>>({});
  const [pendingProviderId, setPendingProviderId] = useState<string | null>(null);
  const [defaultPending, setDefaultPending] = useState(false);
  const [titleGenerationPending, setTitleGenerationPending] = useState(false);
  const [formOpen, setFormOpen] = useState(false);
  const [editingProvider, setEditingProvider] = useState<Provider | null>(null);
  const [form, setForm] = useState<ProviderFormState>(emptyProviderForm);
  const [formPending, setFormPending] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const defaultProvider = providers.find((provider) => provider.id === settings?.defaultProviderId) ?? null;
  const titleGenerationModels = useMemo(
    () => models.filter((model) => model.status === "VERIFIED").sort((left, right) => left.displayName.localeCompare(right.displayName)),
    [models]
  );
  const titleGenerationReasoningOptions: ProviderSettings["titleGenerationReasoningEffort"][] = [
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
    "none"
  ];

  function openAddProvider() {
    setEditingProvider(null);
    setForm(emptyProviderForm);
    setFormError(null);
    setFormOpen(true);
  }

  function openEditProvider(provider: Provider) {
    setEditingProvider(provider);
    setForm(providerFormFrom(provider));
    setFormError(null);
    setFormOpen(true);
  }

  async function refreshProviderCatalog() {
    const [providerPayload, modelPayload] = await Promise.all([api.providers(), api.models()]);
    onProvidersRefresh(providerPayload.data);
    onModelsRefresh(modelPayload.data);
  }

  async function selectDefaultProvider(providerId: string) {
    if (!providerId || providerId === settings?.defaultProviderId) return;
    setDefaultPending(true);
    setSettingsError(null);
    try {
      const updated = await api.updateProviderSettings({ defaultProviderId: providerId });
      onProviderSettingsRefresh(updated);
      dispatchAgentPaneSettingsUpdated(null);
    } catch (err) {
      setSettingsError(err instanceof Error ? err.message : "Default provider update failed");
    } finally {
      setDefaultPending(false);
    }
  }

  async function updateGlobalProviderSettings(input: UpdateProviderSettingsInput) {
    const updated = await api.updateProviderSettings(input);
    onProviderSettingsRefresh(updated);
    dispatchAgentPaneSettingsUpdated(null);
  }

  async function selectTitleGenerationModel(modelId: string) {
    if ((settings?.titleGenerationModelId ?? "") === modelId) return;
    setTitleGenerationPending(true);
    setSettingsError(null);
    try {
      await updateGlobalProviderSettings({ titleGenerationModelId: modelId || null });
    } catch (err) {
      setSettingsError(err instanceof Error ? err.message : "CLI title model update failed");
    } finally {
      setTitleGenerationPending(false);
    }
  }

  async function selectTitleGenerationReasoning(value: ProviderSettings["titleGenerationReasoningEffort"]) {
    if ((settings?.titleGenerationReasoningEffort ?? "low") === value) return;
    setTitleGenerationPending(true);
    setSettingsError(null);
    try {
      await updateGlobalProviderSettings({ titleGenerationReasoningEffort: value });
    } catch (err) {
      setSettingsError(err instanceof Error ? err.message : "CLI title reasoning update failed");
    } finally {
      setTitleGenerationPending(false);
    }
  }

  async function validateProvider(provider: Provider) {
    setPendingProviderId(provider.id);
    setValidationErrors((current) => ({ ...current, [provider.id]: "" }));
    try {
      const result = await api.validateProvider(provider.id);
      setValidationResults((current) => ({ ...current, [provider.id]: result }));
      await refreshProviderCatalog();
      dispatchAgentPaneSettingsUpdated(null);
    } catch (err) {
      setValidationErrors((current) => ({
        ...current,
        [provider.id]: err instanceof Error ? err.message : "Validation failed"
      }));
    } finally {
      setPendingProviderId(null);
    }
  }

  async function saveProvider(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormPending(true);
    setFormError(null);
    try {
      if (editingProvider) {
        await api.updateProvider(editingProvider.id, providerUpdatePayload(form));
      } else {
        await api.createProvider(providerFormPayload(form));
      }
      await refreshProviderCatalog();
      setFormOpen(false);
      setEditingProvider(null);
      setForm(emptyProviderForm);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Provider save failed");
    } finally {
      setFormPending(false);
    }
  }

  return (
    <section className="provider-settings-card" aria-label="Global provider settings">
      <div className="mcp-execution-head">
        <div>
          <strong>Default provider</strong>
          <span>{defaultProvider ? `${defaultProvider.displayName} / ${providerRouteLabel(defaultProvider)}` : "Provider settings loading"}</span>
        </div>
        <button className="compact-action" type="button" onClick={openAddProvider} title="Add provider" aria-label="Add provider">
          <Plus aria-hidden="true" />
          <span>Add provider</span>
        </button>
      </div>
      <div className="provider-settings-grid">
        <label className="provider-default-select">
          <span>Provider</span>
          <select
            aria-label="Default provider"
            name="global-default-provider"
            value={settings?.defaultProviderId ?? ""}
            onChange={(event) => void selectDefaultProvider(event.target.value)}
            disabled={defaultPending || providers.length === 0}
          >
            {providers.length ? (
              providers.map((provider) => (
                <option key={provider.id} value={provider.id}>
                  {provider.displayName}
                </option>
              ))
            ) : (
              <option value="">No providers</option>
            )}
          </select>
        </label>
        <label className="provider-default-select">
          <span>CLI title model</span>
          <select
            aria-label="CLI title model"
            value={settings?.titleGenerationModelId ?? ""}
            onChange={(event) => void selectTitleGenerationModel(event.target.value)}
            disabled={titleGenerationPending}
          >
            <option value="">Auto</option>
            {titleGenerationModels.map((model) => (
              <option key={model.id} value={model.id}>
                {model.displayName}
              </option>
            ))}
          </select>
        </label>
        <label className="provider-default-select">
          <span>CLI title reasoning</span>
          <select
            aria-label="CLI title reasoning"
            value={settings?.titleGenerationReasoningEffort ?? "low"}
            onChange={(event) =>
              void selectTitleGenerationReasoning(event.target.value as ProviderSettings["titleGenerationReasoningEffort"])
            }
            disabled={titleGenerationPending}
          >
            {titleGenerationReasoningOptions.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </label>
      </div>
      {settingsError ? (
        <div className="validation-result bad" role="alert">
          <strong>PROVIDER_SETTINGS_ERROR</strong>
          <small>{settingsError}</small>
        </div>
      ) : null}
      <div className="provider-list" aria-label="Provider catalog">
        {providers.map((provider) => {
          const validation = validationResults[provider.id];
          const validationError = validationErrors[provider.id];
          const isPending = pendingProviderId === provider.id;
          const isDefault = provider.id === settings?.defaultProviderId;
          return (
            <article key={provider.id} className={isDefault ? "provider-row selected" : "provider-row"}>
              <div className="provider-row-main">
                <span className={`status ${statusTone(provider.status)}`}>{provider.status}</span>
                <strong>{provider.displayName}</strong>
                {isDefault ? <em>Default</em> : null}
              </div>
              <small>{provider.statusReason ?? "Verified provider"}</small>
              <small>
                {providerRouteLabel(provider)} / {providerModelCount(provider, models)} models
              </small>
              <div className="provider-row-actions">
                <button
                  className="compact-action"
                  type="button"
                  onClick={() => validateProvider(provider)}
                  disabled={isPending}
                  title={`Validate ${provider.displayName}`}
                  aria-label={`Validate ${provider.displayName}`}
                >
                  <ShieldCheck aria-hidden="true" />
                  <span>{isPending ? "Checking" : "Validate"}</span>
                </button>
                <button
                  className="compact-action"
                  type="button"
                  onClick={() => openEditProvider(provider)}
                  disabled={provider.isBuiltIn}
                  title={provider.isBuiltIn ? "Built-in provider metadata is fixed" : `Edit ${provider.displayName}`}
                  aria-label={`Edit ${provider.displayName}`}
                >
                  <Settings2 aria-hidden="true" />
                  <span>Edit</span>
                </button>
              </div>
              {validation ? (
                <div className="validation-result" role="status" aria-live="polite">
                  <div>
                    <span className={`status ${statusTone(validation.status)}`}>{validation.status}</span>
                    <strong>{validation.code}</strong>
                    <span>{validation.modelCount === null ? "models n/a" : `${validation.modelCount} models`}</span>
                  </div>
                  <small>{validation.statusReason}</small>
                </div>
              ) : null}
              {validationError ? (
                <div className="validation-result bad" role="alert">
                  <strong>VALIDATION_ERROR</strong>
                  <small>{validationError}</small>
                </div>
              ) : null}
            </article>
          );
        })}
      </div>
      {formOpen ? (
        <div className="provider-modal" role="dialog" aria-modal="true" aria-label={editingProvider ? "Edit provider" : "Add provider"}>
          <form className="provider-modal-body" onSubmit={(event) => void saveProvider(event)}>
            <div className="mcp-execution-head">
              <div>
                <strong>{editingProvider ? "Edit provider" : "Add provider"}</strong>
                <span>Save metadata, then run validation from the provider list.</span>
              </div>
              <button
                className="icon-action"
                type="button"
                onClick={() => {
                  setFormOpen(false);
                  setEditingProvider(null);
                }}
                title="Close provider form"
                aria-label="Close provider form"
              >
                <X aria-hidden="true" />
              </button>
            </div>
            <label>
              <span>Provider id</span>
              <input
                aria-label="Provider id"
                value={form.id}
                onChange={(event) => setForm((current) => ({ ...current, id: event.target.value }))}
                disabled={Boolean(editingProvider)}
                placeholder="custom-provider"
              />
            </label>
            <label>
              <span>Display name</span>
              <input
                aria-label="Provider display name"
                value={form.displayName}
                onChange={(event) => setForm((current) => ({ ...current, displayName: event.target.value }))}
                placeholder="Custom Provider"
              />
            </label>
            <div className="provider-form-grid">
              <label>
                <span>Type</span>
                <select
                  aria-label="Provider type"
                  value={form.type}
                  onChange={(event) => setForm((current) => ({ ...current, type: event.target.value as CreateProviderInput["type"] }))}
                >
                  {providerTypeOptions.map((type) => (
                    <option key={type} value={type}>
                      {readableCode(type)}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>Route profile</span>
                <select
                  aria-label="Provider route profile"
                  value={form.routeProfile}
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      routeProfile: event.target.value as NonNullable<Provider["routeProfile"]>
                    }))
                  }
                >
                  {providerRouteProfileOptions.map((profile) => (
                    <option key={profile} value={profile}>
                      {profile}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <label>
              <span>Base URL</span>
              <input
                aria-label="Provider base URL"
                value={form.baseUrl}
                onChange={(event) => setForm((current) => ({ ...current, baseUrl: event.target.value }))}
                placeholder="https://example.com/v1"
              />
            </label>
            <label>
              <span>Backing provider</span>
              <input
                aria-label="Provider backing provider"
                value={form.backingProviderId}
                onChange={(event) => setForm((current) => ({ ...current, backingProviderId: event.target.value }))}
                placeholder="codex-lb"
              />
            </label>
            <label>
              <span>Credential reference</span>
              <input
                aria-label="Provider credential reference"
                value={form.credentialRef}
                onChange={(event) => setForm((current) => ({ ...current, credentialRef: event.target.value }))}
                placeholder="/opt/spaceapp/secrets/space-provider.key"
              />
            </label>
            {formError ? (
              <div className="validation-result bad" role="alert">
                <strong>PROVIDER_SAVE_ERROR</strong>
                <small>{formError}</small>
              </div>
            ) : null}
            <button
              className="compact-action primary-action"
              type="submit"
              disabled={formPending || !form.id.trim() || !form.displayName.trim()}
              title={editingProvider ? "Save provider" : "Create provider"}
              aria-label={editingProvider ? "Save provider" : "Create provider"}
            >
              <CheckCircle2 aria-hidden="true" />
              <span>{formPending ? "Saving" : editingProvider ? "Save provider" : "Create provider"}</span>
            </button>
          </form>
        </div>
      ) : null}
    </section>
  );
}

function VoiceSettingsCard() {
  const voiceInput = useVoiceInput();
  const settings = voiceInput.settings;
  const serverSettings = voiceInput.serverSettings;
  const loading = voiceInput.settingsLoading;
  const error = voiceInput.settingsError;

  function updateVoiceSettings(patch: Partial<VoiceComposerSettings>) {
    const next = { ...settings, ...patch };
    writeVoiceComposerSettings(next);
  }

  const languageOptions = serverSettings?.languageOptions ?? ["auto", "el", "en"];
  const statusLabel = serverSettings?.enabled ? "READY" : "DISABLED";
  const statusToneValue = serverSettings?.enabled ? "ok" : "warn";

  return (
    <section className="provider-settings-card settings-flat-card voice-settings-card" aria-label="Voice input settings">
      <div className="agent-settings-section-title settings-flat-heading">
        <Mic aria-hidden="true" />
        <span>
          <strong>Voice input</strong>
          <small>{serverSettings?.statusReason ?? (loading ? "Voice settings loading" : "Voice settings unavailable")}</small>
        </span>
        <div className="settings-flat-heading-actions">
          <span className={`status ${statusToneValue}`}>{statusLabel}</span>
          <SettingsActionMenu
            label="Voice input actions"
            disabled={loading}
            actions={[{
              id: "refresh",
              label: "Refresh voice status",
              icon: RefreshCw,
              onSelect: () => void voiceInput.refreshServerSettings()
            }]}
          />
        </div>
      </div>
      {error ? (
        <div className="validation-result bad" role="alert">
          <strong>VOICE_SETTINGS_ERROR</strong>
          <small>{error}</small>
        </div>
      ) : null}
      <SpaceToggle
        className="settings-flat-row settings-flat-toggle-row voice-toggle"
        name="voice-input-enabled"
        label="Voice input"
        detail={settings.enabled ? "Enabled in Chat and attached CLI panes." : "Microphone controls are hidden."}
        checked={settings.enabled}
        onChange={(enabled) => updateVoiceSettings({ enabled })}
      />
      <label className="settings-flat-row">
        <span className="settings-flat-row-copy"><strong>Language</strong><small>Transcription language.</small></span>
        <select name="voice-input-language" value={settings.language} onChange={(event) => updateVoiceSettings({ language: event.target.value as VoiceComposerSettings["language"] })}>
          {languageOptions.map((language) => (
            <option key={language} value={language}>
              {language === "auto" ? "Auto" : language === "el" ? "Greek" : "English"}
            </option>
          ))}
        </select>
      </label>
      <label className="settings-flat-row">
        <span className="settings-flat-row-copy"><strong>Insert mode</strong><small>How finished speech enters the prompt.</small></span>
        <select name="voice-input-insert-mode" value={settings.insertMode} onChange={(event) => updateVoiceSettings({ insertMode: event.target.value as VoiceComposerSettings["insertMode"] })}>
          <option value="append">Append</option>
          <option value="replace">Replace</option>
        </select>
      </label>
      <SpaceToggle
        className="settings-flat-row settings-flat-toggle-row voice-toggle"
        name="voice-input-prewarm"
        label="Pre-warm connection"
        detail="Reduce delay before the first words."
        checked={settings.prewarm}
        onChange={(prewarm) => updateVoiceSettings({ prewarm })}
      />
      <div className="voice-float-settings">
        <div className="settings-flat-subheading">
          <strong>Floating controls</strong>
          <small>Choose which controls appear over CLI panes.</small>
        </div>
        <SpaceToggle
          className="settings-flat-row settings-flat-toggle-row voice-toggle"
          name="float-voice-button"
          label="Voice mic"
          checked={settings.terminalVoiceButton}
          onChange={(terminalVoiceButton) => updateVoiceSettings({ terminalVoiceButton })}
        />
        <SpaceToggle
          className="settings-flat-row settings-flat-toggle-row voice-toggle"
          name="float-model-picker"
          label="Model choice"
          checked={settings.terminalModelPicker}
          onChange={(terminalModelPicker) => updateVoiceSettings({ terminalModelPicker })}
        />
        <SpaceToggle
          className="settings-flat-row settings-flat-toggle-row voice-toggle"
          name="float-turn-control"
          label="Turn control"
          checked={settings.terminalTurnControl}
          onChange={(terminalTurnControl) => updateVoiceSettings({ terminalTurnControl })}
        />
      </div>
      <p className="settings-flat-note voice-settings-help">Uses OpenAI gpt-live-transcribe. Finished speech is submitted immediately.</p>
    </section>
  );
}

function AgentSettingsDock({
  activePane,
  canManageCliRuntimes,
  canManageDiagnostics,
  canManageSourceControl,
  canManageTelegram,
  currentAppearance,
  currentIconPack,
  currentUiTheme,
  isCodexEnabled,
  suppressNotifications,
  providerSettings,
  providers,
  onUiThemeApply,
  onSuppressNotificationsChange,
  onProviderSettingsRefresh
}: {
  activePane: Pane | null;
  canManageCliRuntimes: boolean;
  canManageDiagnostics: boolean;
  canManageSourceControl: boolean;
  canManageTelegram: boolean;
  currentAppearance: ModernAppearance;
  currentIconPack: ModernIconPack;
  currentUiTheme: UiTheme;
  isCodexEnabled: boolean;
  suppressNotifications: boolean;
  providerSettings: ProviderSettings | null;
  providers: Provider[];
  onUiThemeApply: (selection: { appearance: ModernAppearance; iconPack: ModernIconPack; theme: UiTheme }) => void;
  onSuppressNotificationsChange: (suppressed: boolean) => void;
  onProviderSettingsRefresh: (settings: ProviderSettings) => void;
}) {
  const [session, setSession] = useState<AgentPaneSession | null>(null);
  const [loading, setLoading] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [providerPending, setProviderPending] = useState(false);
  const [providerError, setProviderError] = useState<string | null>(null);

  async function loadSession(showLoading = true) {
    if (!activePane || activePane.mode !== "CHAT") {
      setSession(null);
      return;
    }
    if (showLoading) setLoading(true);
    setError(null);
    try {
      setSession(await api.agentSession(activePane.id));
    } catch (err) {
      setSession(null);
      setError(err instanceof Error ? err.message : "Agent settings failed to load");
    } finally {
      if (showLoading) setLoading(false);
    }
  }

  useEffect(() => {
    void loadSession();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activePane?.id, activePane?.mode]);

  const defaultProvider = providers.find((provider) => provider.id === providerSettings?.defaultProviderId) ?? null;
  const selectedToolIds = useMemo(() => new Set(session?.selectedToolIds ?? []), [session?.selectedToolIds]);
  const selectedToolCount = session?.toolOptions.filter((tool) => selectedToolIds.has(tool.id) || tool.isForceOn).length ?? 0;
  const title = activePane ? displayPaneTitle(activePane) : "Agent";

  async function updateSettings(input: { selectedToolIds?: string[] | null }) {
    if (!isCodexEnabled || !activePane || activePane.mode !== "CHAT") return;
    setPending(true);
    setError(null);
    try {
      const updated = await api.updateAgentSettings(activePane.id, input);
      setSession(updated);
      dispatchAgentPaneSettingsUpdated(activePane.id, updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Agent settings update failed");
    } finally {
      setPending(false);
    }
  }

  async function toggleTool(toolId: string, checked: boolean) {
    const next = new Set(session?.selectedToolIds ?? []);
    if (checked) next.add(toolId);
    else next.delete(toolId);
    await updateSettings({ selectedToolIds: Array.from(next) });
  }

  async function selectDefaultProvider(providerId: string) {
    if (!isCodexEnabled || !providerId || providerId === providerSettings?.defaultProviderId) return;
    setProviderPending(true);
    setProviderError(null);
    try {
      const updated = await api.updateProviderSettings({ defaultProviderId: providerId });
      onProviderSettingsRefresh(updated);
      dispatchAgentPaneSettingsUpdated(null);
    } catch (err) {
      setProviderError(err instanceof Error ? err.message : "Default provider update failed");
    } finally {
      setProviderPending(false);
    }
  }

  return (
    <div className="dock-panel agent-settings-dock basic-settings-dock">
      <header className="settings-dock-title settings-flat-dock-title">
        <Settings2 aria-hidden="true" />
        <span>
          <h2>Settings</h2>
          <small>Browser and workspace controls.</small>
        </span>
      </header>

      <UiThemeSettingsCard
        currentAppearance={currentAppearance}
        currentIconPack={currentIconPack}
        currentTheme={currentUiTheme}
        onChange={onUiThemeApply}
      />

      <AppDiagnosticsSettingsCard canManage={canManageDiagnostics} />

      <section className="agent-settings-card settings-flat-card settings-provider-card" aria-label="Global provider settings">
        <div className="agent-settings-section-title settings-flat-heading codex-gated-settings-title">
          <ServerCog aria-hidden="true" />
          <span>
            <strong>Default provider</strong>
            <small>{defaultProvider ? `${defaultProvider.displayName} / ${providerRouteLabel(defaultProvider)}` : "Provider settings loading"}</small>
          </span>
          {!isCodexEnabled ? <span className="status muted">OFF</span> : null}
        </div>
        <label className="provider-default-select settings-flat-row">
          <span className="settings-flat-row-copy">
            <strong>Provider</strong>
            <small>Used by new Chat and agent sessions.</small>
          </span>
          <select
            aria-label="Default provider"
            name="settings-default-provider"
            value={providerSettings?.defaultProviderId ?? ""}
            onChange={(event) => void selectDefaultProvider(event.target.value)}
            disabled={!isCodexEnabled || providerPending || providers.length === 0}
            title={!isCodexEnabled ? "Enable Codex in Settings" : undefined}
          >
            {providers.length ? (
              providers.map((provider) => (
                <option key={provider.id} value={provider.id}>
                  {provider.displayName}
                </option>
              ))
            ) : (
              <option value="">No providers</option>
            )}
          </select>
        </label>
        {providerError ? (
          <div className="validation-result bad" role="alert">
            <strong>PROVIDER_SETTINGS_ERROR</strong>
            <small>{providerError}</small>
          </div>
        ) : null}
      </section>

      <SourceControlPublishingCard canManage={canManageSourceControl} />

      <CodexCliDefaultsCard client={api} isCodexEnabled={isCodexEnabled} />

      <TelegramIntegrationCard canManage={canManageTelegram} isCodexEnabled={isCodexEnabled} />

      <VoiceSettingsCard />

      <section className="agent-settings-card settings-flat-card suppress-notifications-settings-card" aria-label="Notification settings">
        <div className="agent-settings-section-title settings-flat-heading">
          <Bell aria-hidden="true" />
          <span>
            <strong>Notifications</strong>
            <small>Browser-local toast and status controls.</small>
          </span>
        </div>
        <SpaceToggle
          className="settings-flat-row settings-flat-toggle-row suppress-notifications-toggle"
          name="suppress-notifications-enabled"
          label="Suppress all notifications"
          detail={suppressNotifications ? "All notices are hidden in this browser." : "Notices appear normally."}
          checked={suppressNotifications}
          onChange={onSuppressNotificationsChange}
        />
      </section>

      <section className="agent-settings-card settings-flat-card basic-agent-card" aria-label={activePane?.mode === "CHAT" ? `Basic settings for ${title}` : `Selected pane ${title}`}>
        <div className="agent-settings-section-title settings-flat-heading">
          <MessageSquare aria-hidden="true" />
          <span>
            <strong>Agent</strong>
            <small>{activePane?.mode === "CHAT" ? (loading ? "Loading settings" : session?.statusReason ?? "Chat pane controls") : "Tools are available on chat panes."}</small>
          </span>
          {activePane?.mode === "CHAT" ? (
            <SettingsActionMenu
              label="Agent settings actions"
              disabled={!isCodexEnabled || loading || pending}
              actions={[{
                id: "refresh",
                label: "Refresh agent settings",
                icon: RefreshCw,
                onSelect: () => void loadSession()
              }]}
            />
          ) : null}
        </div>

        {!activePane ? (
          <div className="empty-mini" role="status">
            Select a chat pane to edit tools.
          </div>
        ) : activePane.mode !== "CHAT" ? (
          <div className="empty-mini" role="status">
            {title} is not a chat pane.
          </div>
        ) : !session ? (
          <div className="empty-mini" role="status">
            Agent settings are loading.
          </div>
        ) : (
          <>
            <div className="settings-flat-subheading">
              <strong>Tools</strong>
              <small>{selectedToolCount}/{session.toolOptions.length} enabled</small>
            </div>
            <div className="agent-tool-list settings-flat-tool-list">
              {session.toolOptions.length ? (
                session.toolOptions.map((tool) => {
                  const requiresAuth = tool.authType === "oauth2" && !tool.authConnected;
                  const checked = selectedToolIds.has(tool.id) || tool.isForceOn;
                  return (
                    <SpaceToggle
                      key={tool.id}
                      className={checked ? "selected" : ""}
                      title={!isCodexEnabled ? "Enable Codex in Settings" : requiresAuth ? `${tool.displayName} requires auth` : tool.displayName}
                      name={`agent-tool-${tool.id}`}
                      label={tool.displayName}
                      checked={checked}
                      onChange={(nextChecked) => void toggleTool(tool.id, nextChecked)}
                      disabled={!isCodexEnabled || pending || !session.capabilities.canSelectTools || tool.isForceOn || requiresAuth}
                    />
                  );
                })
              ) : (
                <div className="empty-mini" role="status">
                  No tools available
                </div>
              )}
            </div>
          </>
        )}
      </section>

      {error ? (
        <div className="validation-result bad" role="alert">
          <strong>AGENT_SETTINGS_ERROR</strong>
          <small>{error}</small>
        </div>
      ) : null}
    </div>
  );
}

function BrowserDock({
  activeRoom,
  browserPane,
  canOpenBrowser,
  onOpenBrowser,
  onBookmarks,
  onImport,
  onJoin
}: {
  activeRoom: Room | null;
  browserPane: Pane | null;
  canOpenBrowser: boolean;
  onOpenBrowser: () => void;
  onBookmarks: () => void;
  onImport: () => void;
  onJoin: () => void;
}) {
  const hasBrowserPane = Boolean(browserPane);
  const disabledReason = activeRoom
    ? "Room is full; close a pane before starting another browser."
    : "Select a room before starting browser sessions.";
  const targetTitle = browserPane ? displayPaneTitle(browserPane) : null;
  return (
    <div className="dock-panel browser-dock">
      <div className="browser-dock-strip" role="group" aria-label="Browser controls">
        <button disabled={!canOpenBrowser} title={canOpenBrowser ? "Open Chrome browser pane" : disabledReason} aria-label="Open Chrome browser" onClick={onOpenBrowser}>
          <Chrome aria-hidden="true" />
        </button>
        <button
          disabled={!hasBrowserPane}
          title={hasBrowserPane ? `Open bookmarks in ${targetTitle}` : "Open a browser pane before using bookmarks."}
          aria-label="Open browser bookmarks"
          onClick={onBookmarks}
        >
          <Bookmark aria-hidden="true" />
        </button>
        <button
          disabled={!hasBrowserPane}
          title={hasBrowserPane ? `Import browser bookmarks JSON into ${targetTitle}` : "Open a browser pane before importing bookmarks."}
          aria-label="Import browser bookmarks"
          onClick={onImport}
        >
          <Upload aria-hidden="true" />
        </button>
        <button
          disabled={!hasBrowserPane}
          title={hasBrowserPane ? `Join ${targetTitle}` : "Open a browser pane before joining."}
          aria-label="Join browser session"
          onClick={onJoin}
        >
          <UserCheck aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}

const PaneCard = memo(function PaneCard({
  pane,
  agentNumber,
  latestTurn,
  latestCompletion,
  hasPendingCompletion,
  isTarget,
  isMoveDialogOpen,
  isVisibleInShell,
  isTerminalOutputVisible,
  isMobilePaneFocused,
  browserObserverOnly,
  terminalObserverOnly,
  uiTheme,
  shellMode,
  maskSensitiveData,
  codexTurnsEnabled,
  codexEnvironment,
  canMoveToAnotherRoom,
  draggedPaneId,
  dragOverPaneId,
  paneReorderPending,
  onPaneDragStart,
  onPaneDragEnd,
  onPaneDragOver,
  onPaneDragLeave,
  onPaneDrop,
  onTarget,
  onMove,
  onPaneUpdated,
  onClose,
  onMaximize,
  onMinimize,
  onMobilePaneFocusChange,
  onGrowColumnSpan,
  onResetColumnSpan,
  onToggleColumnSpan,
  onSplit,
  isFullscreenLayout,
  fullscreenIndex,
  fullscreenCount,
  onFullscreenNavigate,
  effectiveColumnSpan,
  columnStart,
  rowIndex,
  canGrowColumnSpan,
  canResetColumnSpan,
  terminalFontSize,
  hideCliFloats,
  showSessionDebugIds,
  cliDebugModeEnabled,
  onCliDebugModeChange,
  cliMemorySaveModelId,
  cliImagePreviewLimit,
  terminalBootstrapBarrier,
  shouldBootstrapTerminal,
  prefillInitialReplay,
  revealGeneration,
  onTerminalBootstrapped,
  onTerminalPrefillReadyChange,
  onTerminalRevealReady
}: {
  pane: Pane;
  agentNumber: number;
  latestTurn: Turn | null;
  latestCompletion: SpaceEvent | null;
  hasPendingCompletion: boolean;
  isTarget: boolean;
  isMoveDialogOpen: boolean;
  isVisibleInShell: boolean;
  isTerminalOutputVisible: boolean;
  isMobilePaneFocused: boolean;
  browserObserverOnly: boolean;
  terminalObserverOnly: boolean;
  uiTheme: UiTheme;
  shellMode: ShellMode;
  maskSensitiveData: boolean;
  codexTurnsEnabled: boolean;
  codexEnvironment: CodexEnvironment | null;
  canMoveToAnotherRoom: boolean;
  draggedPaneId: string | null;
  dragOverPaneId: string | null;
  paneReorderPending: boolean;
  onPaneDragStart: (event: ReactDragEvent<HTMLElement>, pane: Pane) => void;
  onPaneDragEnd: () => void;
  onPaneDragOver: (event: ReactDragEvent<HTMLElement>, paneId: string) => void;
  onPaneDragLeave: (paneId: string) => void;
  onPaneDrop: (paneId: string) => void | Promise<void>;
  onTarget: (paneId: string) => void;
  onMove: (pane: Pane) => void;
  onPaneUpdated: (pane: Pane) => void;
  onClose: (paneId: string) => void;
  onMaximize: (pane: Pane) => void;
  onMinimize: (pane: Pane) => void;
  onMobilePaneFocusChange: (focused: boolean) => void;
  onGrowColumnSpan: (pane: Pane) => Promise<void>;
  onResetColumnSpan: (pane: Pane) => Promise<void>;
  onToggleColumnSpan: (pane: Pane) => Promise<void>;
  onSplit: (pane: Pane, direction: "horizontal" | "vertical") => void;
  isFullscreenLayout: boolean;
  fullscreenIndex: number;
  fullscreenCount: number;
  onFullscreenNavigate: (direction: "previous" | "next") => void;
  effectiveColumnSpan: number;
  columnStart: number;
  rowIndex: number;
  canGrowColumnSpan: boolean;
  canResetColumnSpan: boolean;
  terminalFontSize: number;
  hideCliFloats: boolean;
  showSessionDebugIds: boolean;
  cliDebugModeEnabled: boolean;
  onCliDebugModeChange: (enabled: boolean) => void;
  cliMemorySaveModelId: string;
  cliImagePreviewLimit: number;
  terminalBootstrapBarrier?: TerminalBootstrapBarrier;
  shouldBootstrapTerminal: boolean;
  prefillInitialReplay: boolean;
  revealGeneration: number;
  onTerminalBootstrapped: (roomId: string, paneId: string) => void;
  onTerminalPrefillReadyChange: (roomId: string, paneId: string, ready: boolean) => void;
  onTerminalRevealReady: (roomId: string, paneId: string, generation: number) => void;
}) {
  const agentResponse = latestCompletion ? extractAgentResponseFromEvent(latestCompletion) : null;
  const completionState = hasPendingCompletion
    ? "pending"
    : latestCompletion
      ? "acknowledged"
      : "idle";
  const title = displayPaneTitle(pane);
  const isTerminalPane = pane.mode === "TERMINAL";
  const usesCompactPaneActions = isTerminalPane || pane.mode === "CHAT";
  const isRootPane = pane.terminalRuntimeId === "cli:root";
  const maximizeLabel = shellMode === "mobile"
    ? isMobilePaneFocused
      ? "Restore room"
      : "Maximize pane"
    : pane.isMaximized
      ? "Restore pane"
      : "Maximize pane";
  const showRestoreIcon = shellMode === "mobile" ? isMobilePaneFocused : pane.isMaximized;
  const agentTone = ((agentNumber - 1) % 8) + 1;
  const genericUploadInputRef = useRef<HTMLInputElement | null>(null);
  const titleInputRef = useRef<HTMLInputElement | null>(null);
  const titleTextRef = useRef<HTMLElement | null>(null);
  const paneHeaderRef = useRef<HTMLElement | null>(null);
  const paneBadgeRef = useRef<HTMLDivElement | null>(null);
  const paneFixedActionsRef = useRef<HTMLDivElement | null>(null);
  const [genericImportPending, setGenericImportPending] = useState(false);
  const [genericImportNotice, setGenericImportNotice] = useState<string | null>(null);
  const [genericImportError, setGenericImportError] = useState<string | null>(null);
  useAutoDismiss(genericImportNotice, setGenericImportNotice);
  useAutoDismiss(genericImportError, setGenericImportError);
  const [terminalSessionMetadata, setTerminalSessionMetadata] = useState<TerminalSessionMetadata | null>(null);
  const [agentPaneIdentity, setAgentPaneIdentity] = useState<AgentPaneIdentity | null>(null);
  const [cliVpnRoutingStatus, setCliVpnRoutingStatus] = useState<CliVpnRoutingStatus | null>(null);
  const [titleDraft, setTitleDraft] = useState(pane.title);
  const [titleEditOpen, setTitleEditOpen] = useState(false);
  const [titleSavePending, setTitleSavePending] = useState(false);
  const [titleGeneratePending, setTitleGeneratePending] = useState(false);
  const [badgeMenuPosition, setBadgeMenuPosition] = useState<{ x: number; y: number } | null>(null);
  const [categoryColorPending, setCategoryColorPending] = useState(false);
  const [resumeHistoryOpen, setResumeHistoryOpen] = useState(false);
  const [resumeHistoryMode, setResumeHistoryMode] = useState<"chat" | "cli">("cli");
  const [resumeHistoryItems, setResumeHistoryItems] = useState<TaskHistoryDialogItem[]>([]);
  const [resumeHistoryPage, setResumeHistoryPage] = useState(0);
  const [resumeHistoryHasMore, setResumeHistoryHasMore] = useState(false);
  const [resumeHistoryLoading, setResumeHistoryLoading] = useState(false);
  const [resumeHistoryLoadMorePending, setResumeHistoryLoadMorePending] = useState(false);
  const [resumeHistoryError, setResumeHistoryError] = useState<string | null>(null);
  const [resumeHistoryQuery, setResumeHistoryQuery] = useState("");
  const [resumePending, setResumePending] = useState(false);
  const [titleError, setTitleError] = useState<string | null>(null);
  const [isHeaderActionsStacked, setIsHeaderActionsStacked] = useState(false);
  const [modernPrimaryActionCapacity, setModernPrimaryActionCapacity] = useState<number | null>(null);
  const usesGenericImport = pane.mode !== "CHAT" && pane.mode !== "TERMINAL" && pane.mode !== "YOUTUBE";
  const sessionDebugInfo = terminalSessionMetadata ? formatTerminalSessionDebugInfo(terminalSessionMetadata) : null;
  const vpnRoutingPresentation = paneVpnRoutingPresentation(cliVpnRoutingStatus, {
    sessionId: terminalSessionMetadata?.sessionId ?? null,
    runtimeId: terminalSessionMetadata?.runtimeId ?? null,
    purpose: terminalSessionMetadata?.purpose ?? "NORMAL"
  });
  const paneIdentityBaseTitle = showSessionDebugIds && sessionDebugInfo
    ? `${title} / Agent ${agentNumber} / ${sessionDebugInfo.title}`
    : `${title} / Agent ${agentNumber}`;
  const paneIdentityTitle = vpnRoutingPresentation && !maskSensitiveData
    ? `${paneIdentityBaseTitle} / ${vpnRoutingPresentation.label} — ${vpnRoutingPresentation.title}`
    : paneIdentityBaseTitle;
  const terminalRuntimeId = terminalSessionMetadata?.runtimeId ?? pane.terminalRuntimeId ?? "cli:codex";
  const codexMutationBlocked =
    codexEnvironment?.isCodexEnabled === false &&
    (pane.mode === "CHAT" || (isTerminalPane && terminalRuntimeId === "cli:codex"));
  const codexDisabledReason = "Enable Codex in Settings";
  const isDeepSeekTerminal = isTerminalPane && terminalRuntimeId === "cli:deepseek";
  const isTerminalLoginSession = terminalSessionMetadata?.purpose === "LOGIN";
  const canOpenCliTaskHistory = isTerminalPane && !isRootPane && !isTerminalLoginSession;
  const [paneToolbarStorageKeys] = useState(() => {
    const classicStorageKeys = {
      hidden: paneToolbarHiddenStorageKey(pane.mode),
      order: paneToolbarActionOrderStorageKey(pane.mode)
    };
    const storageKeys = uiTheme === "modern"
      ? modernPaneToolbarStorageKeys(pane.mode)
      : classicStorageKeys;
    if (uiTheme === "modern") {
      migrateModernToolbarPreference(
        getSpaceRuntime().platform.localStorage,
        classicStorageKeys.hidden,
        storageKeys.hidden
      );
      migrateModernToolbarPreference(
        getSpaceRuntime().platform.localStorage,
        classicStorageKeys.order,
        storageKeys.order
      );
    }
    return storageKeys;
  });
  const previousVisibilityRef = useRef(isVisibleInShell);
  const resumeHistoryRequestRef = useRef(0);
  const paneActionsRef = useRef<HTMLDivElement | null>(null);
  const paneOverflowTriggerRef = useRef<HTMLButtonElement | null>(null);
  const paneActionsPopupId = `pane-actions-${pane.id}`;
  const paneCardStyle = useMemo(
    () =>
      ({
        "--pane-column-span": String(effectiveColumnSpan)
      }) as CSSProperties,
    [effectiveColumnSpan]
  );
  const handleTerminalBootstrapped = useCallback(
    (paneId: string) => onTerminalBootstrapped(pane.roomId, paneId),
    [onTerminalBootstrapped, pane.roomId]
  );
  const handleTerminalPrefillReadyChange = useCallback(
    (paneId: string, ready: boolean) => onTerminalPrefillReadyChange(pane.roomId, paneId, ready),
    [onTerminalPrefillReadyChange, pane.roomId]
  );
  const handleTerminalRevealReady = useCallback(
    (paneId: string, generation: number) => onTerminalRevealReady(pane.roomId, paneId, generation),
    [onTerminalRevealReady, pane.roomId]
  );

  useEffect(() => {
    recordLifecycleDebugEvent({
      type: "component_mounted",
      scope: "PaneCard",
      detail: `pane=${title}`,
      paneId: pane.id,
      paneMode: pane.mode,
      shellMode
    });
    return () => {
      recordLifecycleDebugEvent({
        type: "component_unmounted",
        scope: "PaneCard",
        detail: `pane=${title}`,
        paneId: pane.id,
        paneMode: pane.mode,
        shellMode
      });
    };
  }, [pane.id, pane.mode, title]);

  useEffect(() => {
    if (previousVisibilityRef.current === isVisibleInShell) return;
    recordLifecycleDebugEvent({
      type: "pane_visibility_changed",
      scope: "PaneCard",
      detail: `visible=${String(isVisibleInShell)}`,
      paneId: pane.id,
      paneMode: pane.mode,
      shellMode
    });
    previousVisibilityRef.current = isVisibleInShell;
  }, [isVisibleInShell, pane.id, pane.mode, shellMode]);

  useEffect(() => {
    if (!titleEditOpen) {
      setTitleDraft(pane.title);
    }
  }, [pane.title, titleEditOpen]);

  useEffect(() => {
    setResumeHistoryOpen(false);
    setResumeHistoryMode("cli");
    setResumeHistoryItems([]);
    setResumeHistoryPage(0);
    setResumeHistoryHasMore(false);
    setResumeHistoryLoading(false);
    setResumeHistoryLoadMorePending(false);
    setResumeHistoryError(null);
    setResumeHistoryQuery("");
    resumeHistoryRequestRef.current += 1;
    setResumePending(false);
  }, [pane.id]);

  useEffect(() => {
    if (!isTerminalPane || !terminalSessionMetadata?.sessionId) {
      setCliVpnRoutingStatus(null);
      return;
    }
    let active = true;
    const refresh = () => {
      void loadCliVpnRoutingStatus(true)
        .then((status) => {
          if (active) setCliVpnRoutingStatus(status);
        })
        .catch(() => {
          if (active) setCliVpnRoutingStatus(null);
        });
    };
    refresh();
    window.addEventListener(CLI_VPN_ROUTING_STATUS_EVENT, refresh);
    return () => {
      active = false;
      window.removeEventListener(CLI_VPN_ROUTING_STATUS_EVENT, refresh);
    };
  }, [isTerminalPane, terminalSessionMetadata?.sessionId]);

  useEffect(() => {
    if (!codexMutationBlocked) return;
    setResumeHistoryOpen(false);
    setTitleEditOpen(false);
  }, [codexMutationBlocked]);

  useEffect(() => {
    if (!resumeHistoryOpen) return;
    const query = resumeHistoryQuery.trim();
    const timeoutId = window.setTimeout(() => {
      void loadResumeHistory(1, { query });
    }, query ? 180 : 0);
    return () => window.clearTimeout(timeoutId);
  }, [resumeHistoryMode, resumeHistoryOpen, resumeHistoryQuery]);

  useEffect(() => {
    if (!titleEditOpen) return;
    titleInputRef.current?.focus();
    titleInputRef.current?.select();
  }, [titleEditOpen]);

  function openPaneImport() {
    if (codexMutationBlocked) return;
    setGenericImportNotice(null);
    setGenericImportError(null);
    if (pane.mode === "CHAT") {
      dispatchAgentPaneAction(pane.id, "upload");
      return;
    }
    if (pane.mode === "TERMINAL") {
      dispatchTerminalPaneAction(pane.id, { action: "upload" });
      return;
    }
    genericUploadInputRef.current?.click();
  }

  async function importGenericPaneFiles(files: File[]) {
    if (!files.length) return;
    setGenericImportPending(true);
    setGenericImportNotice(null);
    setGenericImportError(null);
    try {
      const uploaded = await api.uploadPaneFiles({ roomId: pane.roomId, paneId: pane.id, source: "USER_UPLOAD", files });
      dispatchArtifactsUpdated(pane.roomId, uploaded.artifacts);
      setGenericImportNotice(`${uploaded.artifacts.length} file${uploaded.artifacts.length === 1 ? "" : "s"} imported to ${title}.`);
    } catch (err) {
      setGenericImportError(err instanceof Error ? err.message : "Pane file import failed");
    } finally {
      setGenericImportPending(false);
    }
  }

  function cancelTitleEdit() {
    setTitleDraft(pane.title);
    setTitleEditOpen(false);
    setTitleError(null);
  }

  async function submitPaneTitle(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if ((pane.mode !== "CHAT" && !isTerminalPane) || titleSavePending || codexMutationBlocked) return;
    const nextTitle = titleDraft.trim();
    if (!nextTitle) {
      setTitleDraft(pane.title);
      setTitleError("Pane title cannot be empty.");
      return;
    }
    if (nextTitle === pane.title) {
      setTitleEditOpen(false);
      setTitleError(null);
      return;
    }
    setTitleSavePending(true);
    setTitleError(null);
    try {
      const updated = await api.updatePane(pane.id, { title: nextTitle });
      onPaneUpdated(updated);
      setTitleDraft(updated.title);
      setTitleEditOpen(false);
    } catch (err) {
      setTitleError(err instanceof Error ? err.message : "Pane title update failed");
    } finally {
      setTitleSavePending(false);
    }
  }

  async function generatePaneTitle() {
    if ((pane.mode !== "CHAT" && !isTerminalPane) || titleGeneratePending || codexMutationBlocked) return;
    setTitleGeneratePending(true);
    setTitleError(null);
    try {
      const updated = await api.generatePaneTitle(pane.id);
      onPaneUpdated(updated);
      setTitleDraft(updated.title);
      setTitleEditOpen(false);
    } catch (err) {
      setTitleError(err instanceof Error ? err.message : "AI title generation failed");
    } finally {
      setTitleGeneratePending(false);
    }
  }

  async function loadResumeHistory(page: number, options: { append?: boolean; query?: string } = {}) {
    const setPendingState = options.append ? setResumeHistoryLoadMorePending : setResumeHistoryLoading;
    const requestId = ++resumeHistoryRequestRef.current;
    const query = options.query?.trim();
    setPendingState(true);
    if (!options.append) {
      setResumeHistoryError(null);
    }
    try {
      const history = resumeHistoryMode === "chat"
        ? await api.codexHistory({ page, pageSize: 50, dedupeTitles: true, q: query || undefined })
        : await api.unifiedCliTasks({ page, pageSize: 50, q: query || undefined });
      if (requestId !== resumeHistoryRequestRef.current) return;
      const items: TaskHistoryDialogItem[] = "threads" in history ? history.threads : history.data;
      setResumeHistoryItems((current) => (options.append ? appendUniqueTaskHistoryItems(current, items) : items));
      setResumeHistoryPage(page);
      const total = "total" in history ? history.total : history.totalItems;
      const pageSize = "pageSize" in history ? history.pageSize : history.pagination?.pageSize ?? 50;
      const totalPages = Math.ceil(total / pageSize);
      setResumeHistoryHasMore(page < totalPages);
    } catch (err) {
      if (requestId !== resumeHistoryRequestRef.current) return;
      setResumeHistoryError(err instanceof Error ? err.message : "Task history failed to load");
      if (!options.append) {
        setResumeHistoryItems([]);
        setResumeHistoryPage(0);
        setResumeHistoryHasMore(false);
      }
    } finally {
      if (requestId === resumeHistoryRequestRef.current) setPendingState(false);
    }
  }

  function openResumeTaskHistory(mode: "chat" | "cli") {
    if (
      codexMutationBlocked ||
      (mode === "cli" && !canOpenCliTaskHistory) ||
      (mode === "chat" && pane.mode !== "CHAT") ||
      resumePending
    ) return;
    resumeHistoryRequestRef.current += 1;
    setResumeHistoryMode(mode);
    setResumeHistoryQuery("");
    setResumeHistoryItems([]);
    setResumeHistoryPage(0);
    setResumeHistoryHasMore(false);
    setResumeHistoryLoading(true);
    setResumeHistoryError(null);
    setResumeHistoryOpen(true);
  }

  function closeResumeTaskHistory() {
    if (resumePending) return;
    resumeHistoryRequestRef.current += 1;
    setResumeHistoryOpen(false);
  }

  function changeResumeHistoryQuery(query: string) {
    resumeHistoryRequestRef.current += 1;
    setResumeHistoryQuery(query);
    setResumeHistoryItems([]);
    setResumeHistoryPage(0);
    setResumeHistoryHasMore(false);
    setResumeHistoryLoadMorePending(false);
    setResumeHistoryError(null);
    setResumeHistoryLoading(true);
  }

  async function resumeTask(item: TaskHistoryDialogItem) {
    if (codexMutationBlocked) return;
    if (resumeHistoryMode === "chat") {
      dispatchAgentPaneAction(pane.id, { action: "open_thread", threadId: item.id });
      setResumeHistoryOpen(false);
      return;
    }
    if (!canOpenCliTaskHistory || resumePending) return;
    setResumePending(true);
    setResumeHistoryError(null);
    try {
      if (!("taskId" in item)) throw new Error("This item is not a Space CLI task.");
      const resumed = await api.resumeCliSession(pane.id, { taskId: item.taskId });
      onPaneUpdated(resumed.pane);
      dispatchTerminalPaneAction(pane.id, {
        action: "replace_session",
        session: {
          session: resumed.session,
          runtime: resumed.runtime,
          transcript: resumed.transcript,
          websocket: resumed.websocket
        }
      });
      setResumeHistoryOpen(false);
    } catch (err) {
      setResumeHistoryError(err instanceof Error ? err.message : "CLI resume failed");
    } finally {
      setResumePending(false);
    }
  }

  function beginTitleEdit() {
    if (codexMutationBlocked) return;
    setTitleDraft(pane.title);
    setTitleEditOpen(true);
    setTitleError(null);
  }

  async function applyPaneCategoryColor(color: PaneCategoryColor | null) {
    if (color === pane.categoryColor || categoryColorPending || codexMutationBlocked) return;
    setCategoryColorPending(true);
    try {
      const updated = await api.updatePane(pane.id, { categoryColor: color });
      onPaneUpdated(updated);
    } catch (err) {
      window.dispatchEvent(new CustomEvent(SPACE_CLIPBOARD_NOTICE_EVENT, {
        detail: { message: err instanceof Error ? err.message : "Pane color update failed" }
      }));
    } finally {
      setCategoryColorPending(false);
      setBadgeMenuPosition(null);
    }
  }

  async function copyPaneIdentityInfo() {
    setBadgeMenuPosition(null);
    const text = pane.mode === "CHAT"
      ? agentPaneIdentity?.sessionId
        ? [
            `Space agent session ID: ${agentPaneIdentity.sessionId}`,
            `Codex thread ID: ${agentPaneIdentity.threadId ?? "Not assigned yet"}`
          ].join("\n")
        : ""
      : pane.mode === "TERMINAL" && terminalSessionMetadata
        ? formatTerminalSessionClipboardText(terminalSessionMetadata) ?? ""
        : "";
    if ((pane.mode === "CHAT" || pane.mode === "TERMINAL") && !text) {
      window.dispatchEvent(new CustomEvent(SPACE_CLIPBOARD_NOTICE_EVENT, {
        detail: { message: `${pane.mode === "CHAT" ? "Chat" : "CLI"} session info is still loading.` }
      }));
      return;
    }
    if (!text) return;
    try {
      await writeClipboardText(text);
      window.dispatchEvent(new CustomEvent(SPACE_CLIPBOARD_NOTICE_EVENT, {
        detail: { message: "Pane session info copied." }
      }));
    } catch {
      window.dispatchEvent(new CustomEvent(SPACE_CLIPBOARD_NOTICE_EVENT, {
        detail: { message: "Pane session info copy failed." }
      }));
    }
  }

  let rawPaneActions: IconToolbarAction[] = [
    ...(!isTerminalLoginSession && !isDeepSeekTerminal ? [{
      id: "import",
      label: pane.mode === "CHAT" ? "Attach files to agent" : pane.mode === "TERMINAL" ? "Upload files to CLI" : "Import files to pane",
      title: pane.mode === "CHAT" ? "Attach files to agent" : pane.mode === "TERMINAL" ? "Upload files to CLI" : "Import files to pane",
      ariaLabel: `Import files ${title}`,
      icon: Paperclip,
      onClick: openPaneImport,
      disabled: usesGenericImport && genericImportPending
    }] : []),
    ...(pane.mode === "CHAT"
      ? [
          {
            id: "generate-title",
            label: "Generate pane title",
            title: "Generate pane title with AI",
            ariaLabel: `Generate pane title with AI ${title}`,
            icon: Sparkles,
            onClick: () => void generatePaneTitle(),
            disabled: titleSavePending || titleGeneratePending
          }
        ]
      : []),
    ...(pane.mode === "CHAT"
      ? [
          {
            id: "plan",
            label: "Enable Plan mode",
            title: "Enable Plan mode",
            ariaLabel: `Enable Plan mode ${title}`,
            icon: PanelRight,
            onClick: () => dispatchAgentPaneAction(pane.id, "plan")
          },
          {
            id: "resume",
            label: "Resume task",
            title: "Resume task",
            ariaLabel: `Resume ${title}`,
            icon: Send,
            onClick: () => dispatchAgentPaneAction(pane.id, "resume")
          },
          {
            id: "stop",
            label: "Stop task",
            title: "Stop task",
            ariaLabel: `Stop ${title}`,
            icon: CircleStop,
            onClick: () => dispatchAgentPaneAction(pane.id, "interrupt")
          },
          {
            id: "memory",
            label: "Save task to memory",
            title: "Save task to memory",
            ariaLabel: `Save ${title} to memory`,
            icon: Database,
            onClick: () => dispatchAgentPaneAction(pane.id, "save_to_memory")
          },
          {
            id: "copy",
            label: "Copy Chat contents",
            title: "Copy Chat contents",
            ariaLabel: `Copy Chat contents ${title}`,
            icon: Copy,
            onClick: () => dispatchAgentPaneAction(pane.id, "copy")
          },
          {
            id: "reconnect",
            label: "Reconnect Chat",
            title: "Reconnect Chat",
            ariaLabel: `Reconnect Chat ${title}`,
            icon: RefreshCw,
            onClick: () => dispatchAgentPaneAction(pane.id, "reconnect")
          }
        ]
      : pane.mode === "TERMINAL" && !isRootPane
        ? isTerminalLoginSession
          ? [
              {
                id: "cancel-login",
                label: "Cancel CLI login",
                title: "Cancel CLI login",
                ariaLabel: `Cancel CLI login ${title}`,
                icon: CircleStop,
                onClick: () => dispatchTerminalPaneAction(pane.id, { action: "cancel_login" }),
                hideable: false
              },
              {
                id: "reconnect",
                label: "Reconnect CLI login",
                title: "Reconnect CLI login",
                ariaLabel: `Reconnect CLI login ${title}`,
                icon: RefreshCw,
                onClick: () => dispatchTerminalPaneAction(pane.id, { action: "reconnect" }),
                hideable: false
              }
            ]
          : [
            ...(isDeepSeekTerminal ? [] : [{
              id: "plan",
              label: "Enable Plan mode",
              title: "Enable Plan mode",
              ariaLabel: `Enable Plan mode ${title}`,
              icon: PanelRight,
              onClick: () =>
                dispatchTerminalPaneAction(
                  pane.id,
                  terminalPlanModeAction(terminalRuntimeId)
                )
            }]),
            {
              id: "resume",
              label: "Resume CLI task",
              title: "Resume CLI task",
              ariaLabel: `Resume ${title}`,
              icon: History,
              onClick: () => openResumeTaskHistory("cli"),
              ariaExpanded: resumeHistoryOpen,
              disabled: resumePending,
              hideable: false
            },
            {
              id: "stop",
              label: "Stop CLI task",
              title: "Stop CLI task",
              ariaLabel: `Stop ${title}`,
              icon: CircleStop,
              onClick: () => dispatchTerminalPaneAction(pane.id, { action: "control_key", key: "escape" })
            },
            {
              id: "memory",
              label: "Save CLI task to memory",
              title: "Save CLI task to memory",
              ariaLabel: `Save ${title} to memory`,
              icon: Database,
              onClick: () =>
                dispatchTerminalPaneAction(pane.id, {
                  action: "save_to_memory",
                  modelId: cliMemorySaveModelId,
                  text: "save to memory",
                  memory: {
                    scope: "ROOM",
                    roomId: pane.roomId,
                    title: `CLI memory save request - ${title}`,
                    provenance: "space-cli-memory-save"
                  }
                })
            },
            {
              id: "copy",
              label: "Copy CLI contents",
              title: "Copy CLI contents",
              ariaLabel: `Copy CLI contents ${title}`,
              icon: Copy,
              onClick: () => dispatchTerminalPaneAction(pane.id, { action: "copy" })
            },
            {
              id: "reconnect",
              label: "Reconnect CLI",
              title: "Reconnect CLI",
              ariaLabel: `Reconnect CLI ${title}`,
              icon: RefreshCw,
              onClick: () => dispatchTerminalPaneAction(pane.id, { action: "reconnect" })
            }
            ]
        : pane.mode === "TERMINAL"
          ? [
              {
                id: "stop",
                label: "Stop root shell",
                title: "Stop root shell",
                ariaLabel: `Stop ${title}`,
                icon: CircleStop,
                onClick: () => dispatchTerminalPaneAction(pane.id, { action: "control_key", key: "escape" })
              },
              {
                id: "copy",
                label: "Copy CLI contents",
                title: "Copy CLI contents",
                ariaLabel: `Copy CLI contents ${title}`,
                icon: Copy,
                onClick: () => dispatchTerminalPaneAction(pane.id, { action: "copy" })
              },
              {
                id: "reconnect",
                label: "Reconnect CLI",
                title: "Reconnect CLI",
                ariaLabel: `Reconnect CLI ${title}`,
                icon: RefreshCw,
                onClick: () => dispatchTerminalPaneAction(pane.id, { action: "reconnect" })
              }
            ]
          : []),
    ...(!isTerminalLoginSession ? [{
      id: "move",
      label: "Move pane",
      title: canMoveToAnotherRoom ? "Move pane to another room" : "Create another room before moving a pane",
      ariaLabel: canMoveToAnotherRoom ? `Move ${title} to another room` : `Cannot move ${title} without another room`,
      icon: ArrowRightLeft,
      onClick: () => onMove(pane),
      ariaExpanded: isMoveDialogOpen,
      disabled: !canMoveToAnotherRoom
    }] : []),
    ...(pane.mode !== "TERMINAL"
      ? [
          {
            id: pane.mode === "CHAT" ? "chat-target" : "target",
            label: "Use as command target",
            title: "Use as command target",
            ariaLabel: `Target ${title}`,
            icon: Crosshair,
            onClick: () => onTarget(pane.id),
            ariaPressed: isTarget,
            className: "target-action"
          }
        ]
      : []),
    ...(!isTerminalLoginSession ? [{
      id: "add",
      label: "Add pane",
      title: "Add pane",
      ariaLabel: `Add pane from ${title}`,
      icon: PanelTopOpen,
      onClick: () => onSplit(pane, "horizontal")
    }] : []),
    ...(!isTerminalLoginSession && shellMode !== "mobile"
      ? [
          {
            id: "grow-width",
            label: "Grow pane width",
            title: "Grow pane width",
            ariaLabel: "Grow pane width",
            icon: MoveHorizontal,
            onClick: () => void onGrowColumnSpan(pane),
            disabled: !canGrowColumnSpan
          },
          {
            id: "reset-width",
            label: "Reset pane width",
            title: "Reset pane width",
            ariaLabel: "Reset pane width",
            icon: Shrink,
            onClick: () => void onResetColumnSpan(pane),
            disabled: !canResetColumnSpan
          }
        ]
      : [])
  ];
  if (pane.mode === "YOUTUBE") {
    rawPaneActions = [
      {
        id: "reload",
        label: "Reload YouTube",
        title: "Reload YouTube",
        ariaLabel: `Reload YouTube ${title}`,
        icon: RefreshCw,
        onClick: () => dispatchBrowserPaneAction(pane.id, "reload")
      }
    ];
  }
  const codexMutationActionIds = new Set([
    "import",
    "generate-title",
    "plan",
    "resume",
    "stop",
    "memory",
    "reconnect",
    "cancel-login",
    "add"
  ]);
  const paneActions: IconToolbarAction[] = rawPaneActions.map((action) =>
    codexMutationBlocked && codexMutationActionIds.has(action.id)
      ? { ...action, disabled: true, title: codexDisabledReason }
      : action
  );
  const paneTaskCommands: PaneOverflowCommand[] = pane.mode === "CHAT"
    ? [
        {
          id: "new_task",
          label: "New task",
          description: "Start a clean Codex thread",
          ariaLabel: "New task",
          icon: Plus,
          onClick: () => dispatchAgentPaneAction(pane.id, "new_task"),
          disabled: codexMutationBlocked,
          title: codexMutationBlocked ? codexDisabledReason : undefined
        },
        {
          id: "task_history",
          label: "Task history",
          description: "Open an existing Codex thread",
          ariaLabel: "Task history",
          icon: History,
          onClick: () => openResumeTaskHistory("chat"),
          disabled: resumePending || codexMutationBlocked,
          title: codexMutationBlocked ? codexDisabledReason : undefined
        },
        {
          id: "attach_folder",
          label: "Attach folder",
          description: "Add a folder to the next turn",
          ariaLabel: "Attach folder",
          icon: FolderPlus,
          onClick: () => dispatchAgentPaneAction(pane.id, "attach_folder"),
          disabled: codexMutationBlocked,
          title: codexMutationBlocked ? codexDisabledReason : undefined
        },
        {
          id: "manage_goal",
          label: "Manage goal",
          description: "Set or clear the task goal",
          ariaLabel: "Manage goal",
          icon: Crosshair,
          onClick: () => dispatchAgentPaneAction(pane.id, "manage_goal"),
          disabled: codexMutationBlocked,
          title: codexMutationBlocked ? codexDisabledReason : undefined
        }
      ]
    : [];
  const paneToolbar = usePersistentIconToolbar({
    actions: paneActions,
    hiddenStorageKey: paneToolbarStorageKeys.hidden,
    orderStorageKey: paneToolbarStorageKeys.order,
    nonPersistentActionIds: pane.mode === "CHAT" ? ["chat-target"] : [],
    preserveUnknownActionIds: pane.mode === "CHAT" || pane.mode === "TERMINAL" || pane.mode === "BROWSER",
    closeOverflowOnDragStart: shellMode === "mobile"
  });
  const modernPrimaryActionLimit = modernPanePrimaryActionCount(shellMode);
  const paneToolbarMenuActions = usesCompactPaneActions ? paneToolbar.orderedActions : paneToolbar.visibleActions;
  const paneToolbarPrimaryActionCount = uiTheme === "modern"
    ? Math.min(modernPrimaryActionLimit, modernPrimaryActionCapacity ?? modernPrimaryActionLimit)
    : paneToolbarMenuActions.length;
  const paneToolbarRenderedActions = usesCompactPaneActions
    ? []
    : (uiTheme === "modern"
        ? paneToolbarMenuActions.slice(0, paneToolbarPrimaryActionCount)
        : paneToolbarMenuActions);
  const paneOverflowCommands: PaneOverflowCommand[] = [
    ...paneTaskCommands,
    ...(uiTheme === "modern" && shellMode !== "mobile" && !usesCompactPaneActions
      ? paneToolbarMenuActions.slice(paneToolbarPrimaryActionCount).map((action) => ({
          id: `toolbar-action:${action.id}`,
          label: action.label,
          description: action.title,
          ariaLabel: action.ariaLabel,
          icon: action.icon,
          onClick: action.onClick,
          disabled: action.disabled
        }))
      : [])
  ];
  useLayoutEffect(() => {
    if (!isVisibleInShell || shellMode === "mobile") {
      setIsHeaderActionsStacked(false);
      setModernPrimaryActionCapacity(null);
      return;
    }
    const headerElement = paneHeaderRef.current;
    const badgeElement = paneBadgeRef.current;
    const actionsElement = paneActionsRef.current;
    const fixedActionsElement = paneFixedActionsRef.current;
    if (!headerElement || !badgeElement || !actionsElement || !fixedActionsElement) {
      setIsHeaderActionsStacked(false);
      return;
    }

    const measureHeaderLayout = () => {
      const headerWidth = headerElement.clientWidth;
      if (headerWidth <= 0) {
        setIsHeaderActionsStacked(false);
        setModernPrimaryActionCapacity(null);
        return;
      }

      const headerStyles = window.getComputedStyle(headerElement);
      const actionsStyles = window.getComputedStyle(actionsElement);
      const fixedActionsStyles = window.getComputedStyle(fixedActionsElement);
      const headerGap = Number.parseFloat(headerStyles.columnGap || headerStyles.gap || "") || remToPx(0.5);
      const actionsGap = Number.parseFloat(actionsStyles.columnGap || actionsStyles.gap || "") || remToPx(0.25);
      const fixedActionsGap = Number.parseFloat(fixedActionsStyles.columnGap || fixedActionsStyles.gap || "") || remToPx(0.25);
      const paddingLeft = Number.parseFloat(headerStyles.paddingLeft || "") || remToPx(0.55);
      const paddingRight = Number.parseFloat(headerStyles.paddingRight || "") || remToPx(0.55);
      const actionButtons = Array.from(actionsElement.children).filter((node): node is HTMLButtonElement => node instanceof HTMLButtonElement);
      const actionButtonsWidth = actionButtons.reduce((sum, button) => sum + (button.offsetWidth || remToPx(2.25)), 0);
      const actionsInlineWidth = actionButtonsWidth + Math.max(0, actionButtons.length - 1) * actionsGap;
      const fixedControls = Array.from(fixedActionsElement.children).filter(
        (node): node is HTMLElement => node instanceof HTMLElement
      );
      const fixedControlsWidth = fixedControls.reduce(
        (sum, control) => sum + (control.getBoundingClientRect().width || control.offsetWidth || remToPx(2.25)),
        0
      );
      const fixedInlineWidth = fixedControlsWidth + Math.max(0, fixedControls.length - 1) * fixedActionsGap;
      const badgeWidth = badgeElement.clientWidth || remToPx(2);
      if (uiTheme === "modern") {
        const nextCapacity = modernPanePrimaryActionCapacity({
          availableWidth: headerWidth,
          paddingLeft,
          paddingRight,
          badgeWidth,
          titleWidth: remToPx(6),
          fixedWidth: fixedInlineWidth,
          columnGap: headerGap,
          actionWidth: actionButtons[0]?.offsetWidth || remToPx(2.05),
          actionGap: actionsGap,
          maxActions: modernPrimaryActionLimit
        });
        setModernPrimaryActionCapacity((current) => current === nextCapacity ? current : nextCapacity);
        setIsHeaderActionsStacked(false);
        return;
      }
      setModernPrimaryActionCapacity(null);
      if (!shouldMeasureToolbarLayout(uiTheme)) {
        setIsHeaderActionsStacked(false);
        return;
      }
      const titleInlineWidth = titleEditOpen
        ? remToPx(12)
        : Math.min(
            Math.max(measureSingleLineTitleWidth(titleTextRef.current, 8) + (isTerminalPane ? remToPx(1.45) : 0), remToPx(8)),
            remToPx(16)
          );
      setIsHeaderActionsStacked(
        paneHeaderNeedsSecondRow({
          availableWidth: headerWidth,
          paddingLeft,
          paddingRight,
          badgeWidth,
          titleWidth: titleInlineWidth,
          actionsWidth: actionsInlineWidth,
          fixedWidth: fixedInlineWidth,
          columnGap: headerGap
        })
      );
    };

    measureHeaderLayout();
    const resizeObserver = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measureHeaderLayout) : null;
    resizeObserver?.observe(headerElement);
    resizeObserver?.observe(badgeElement);
    resizeObserver?.observe(actionsElement);
    resizeObserver?.observe(fixedActionsElement);
    if (titleTextRef.current) resizeObserver?.observe(titleTextRef.current);
    window.addEventListener("resize", measureHeaderLayout);
    return () => {
      resizeObserver?.disconnect();
      window.removeEventListener("resize", measureHeaderLayout);
    };
  }, [
    isTerminalPane,
    isVisibleInShell,
    modernPrimaryActionLimit,
    paneToolbarRenderedActions.length,
    pane.title,
    shellMode,
    titleEditOpen,
    uiTheme,
    vpnRoutingPresentation?.label
  ]);
  useDismissibleToolbarLayer({
    containerRef: paneHeaderRef,
    active: paneToolbar.isOverflowOpen || Boolean(paneToolbar.actionMenu) || Boolean(badgeMenuPosition),
    onDismiss: () => {
      paneToolbar.closeMenus();
      setBadgeMenuPosition(null);
    }
  });

  return (
    <article
      className={`${pane.isMaximized ? "pane-card is-maximized" : "pane-card"}${pane.isMinimized ? " is-minimized" : ""}${isTarget ? " is-target" : ""}${hasPendingCompletion ? " is-completion-pending" : ""}${pane.mode === "BROWSER" ? " browser-pane-card" : ""}${pane.mode === "YOUTUBE" ? " youtube-pane-card" : ""}${pane.mode === "CHAT" ? " chat-pane-card" : ""}${isVisibleInShell ? "" : " is-shell-hidden"}${draggedPaneId === pane.id ? " is-dragging" : ""}${dragOverPaneId === pane.id && draggedPaneId !== pane.id ? " is-drop-target" : ""}`}
      data-agent-tone={agentTone}
      data-space-pane-id={pane.id}
      data-space-room-id={pane.roomId}
      data-space-pane-title={pane.title}
      data-pane-mode={pane.mode}
      data-terminal-output-state={isTerminalOutputVisible ? "writable" : "buffering"}
      data-cli-vpn-routing={vpnRoutingPresentation?.tone ?? "direct"}
      data-column-span={effectiveColumnSpan}
      data-stored-column-span={pane.columnSpan}
      data-grid-column-start={columnStart}
      data-grid-row-index={rowIndex}
      data-completion-state={completionState}
      data-minimized={pane.isMinimized ? "true" : "false"}
      data-shell-visible={isVisibleInShell ? "true" : "false"}
      aria-hidden={isVisibleInShell ? undefined : true}
      aria-label={`${title} agent ${agentNumber}`}
      style={paneCardStyle}
      onPointerDownCapture={() => onTarget(pane.id)}
      onDragOver={(event) => onPaneDragOver(event, pane.id)}
      onDragLeave={() => onPaneDragLeave(pane.id)}
      onDrop={(event) => {
        event.preventDefault();
        void onPaneDrop(pane.id);
      }}
      onFocusCapture={(event) => {
        if (event.target instanceof Element && event.target.classList.contains("xterm-helper-textarea")) return;
        onTarget(pane.id);
      }}
    >
      {usesGenericImport ? (
        <input
          ref={genericUploadInputRef}
          type="file"
          name="pane-import-files"
          multiple
          hidden
          onChange={(event) => {
            const files = event.currentTarget.files ? Array.from(event.currentTarget.files) : [];
            event.currentTarget.value = "";
            if (files.length) void importGenericPaneFiles(files);
          }}
        />
      ) : null}
      <header ref={paneHeaderRef} className={isHeaderActionsStacked ? "is-actions-stacked" : undefined} tabIndex={-1}>
        <div ref={paneBadgeRef} className="pane-header-identity">
          {isMobilePaneFocused && isTarget ? <SpaceBrand /> : (
            <div
              className={`pane-agent-badge${vpnRoutingPresentation ? ` has-vpn-routing is-${vpnRoutingPresentation.tone}` : ""}${draggedPaneId === pane.id ? " is-dragging" : ""}`}
              title={paneIdentityTitle}
              role="img"
              aria-label={paneIdentityTitle}
              data-category-color={pane.categoryColor ?? undefined}
              draggable={!paneReorderPending}
              onDragStart={(event) => onPaneDragStart(event, pane)}
              onDragEnd={onPaneDragEnd}
              onDoubleClick={() => void onToggleColumnSpan(pane)}
              onContextMenu={usesCompactPaneActions ? (event) => {
                event.preventDefault();
                paneToolbar.closeMenus();
                setBadgeMenuPosition({ x: event.clientX, y: event.clientY });
              } : undefined}
            >
              <PaneModeIcon pane={pane} />
              {vpnRoutingPresentation ? (
                <span className="pane-agent-vpn-indicator" aria-hidden="true">VPN</span>
              ) : null}
            </div>
          )}
          {badgeMenuPosition ? (
            <div
              className="icon-context-menu"
              role="menu"
              aria-label={`Pane menu ${title}`}
              style={{ left: `${badgeMenuPosition.x}px`, top: `${badgeMenuPosition.y}px` }}
            >
              <button
                type="button"
                role="menuitem"
                onClick={() => void copyPaneIdentityInfo()}
              >
                <Copy aria-hidden="true" />
                Copy session info
              </button>
              {!isTerminalLoginSession ? (
                <button
                  type="button"
                  role="menuitem"
                  disabled={titleSavePending || titleGeneratePending || codexMutationBlocked}
                  title={codexMutationBlocked ? codexDisabledReason : undefined}
                  onClick={() => {
                    setBadgeMenuPosition(null);
                    beginTitleEdit();
                  }}
                >
                  <Pencil aria-hidden="true" />
                  Edit pane title
                </button>
              ) : null}
              {!isRootPane && !isTerminalLoginSession ? (
                <button
                  type="button"
                  role="menuitem"
                  disabled={titleSavePending || titleGeneratePending || codexMutationBlocked}
                  title={codexMutationBlocked ? codexDisabledReason : undefined}
                  onClick={() => {
                    setBadgeMenuPosition(null);
                    void generatePaneTitle();
                  }}
                >
                  <Sparkles aria-hidden="true" />
                  Generate pane title
                </button>
              ) : null}
              <div className="icon-context-menu-separator" role="separator" />
              <span className="icon-context-menu-label">Color</span>
              <div className="icon-context-menu-swatches" role="group" aria-label="Pane category color">
                {paneCategoryColors.map((color) => (
                  <button
                    key={color}
                    type="button"
                    className={`category-swatch ${color}${pane.categoryColor === color ? " selected" : ""}`}
                    aria-label={`Set category color ${color}`}
                    aria-pressed={pane.categoryColor === color}
                    title={color}
                    disabled={categoryColorPending}
                    onClick={() => void applyPaneCategoryColor(color)}
                  />
                ))}
                <button
                  type="button"
                  className={`category-swatch none${pane.categoryColor === null ? " selected" : ""}`}
                  aria-label="Clear category color"
                  aria-pressed={pane.categoryColor === null}
                  title="No color"
                  disabled={categoryColorPending}
                  onClick={() => void applyPaneCategoryColor(null)}
                >
                  <X aria-hidden="true" />
                </button>
              </div>
            </div>
          ) : null}
        </div>
        <div className="pane-title-block">
          <div className="pane-title-row">
            {titleEditOpen ? (
              <form className="pane-title-form room-title-form" onSubmit={(event) => void submitPaneTitle(event)}>
                <input
                  ref={titleInputRef}
                  className="pane-title-input"
                  aria-label="Pane title"
                  value={titleDraft}
                  disabled={titleSavePending || titleGeneratePending}
                  onChange={(event) => setTitleDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") {
                      event.preventDefault();
                      cancelTitleEdit();
                    }
                  }}
                />
                <button type="submit" title="Save pane title" aria-label="Save pane title" disabled={titleSavePending || titleGeneratePending}>
                  <Save aria-hidden="true" />
                </button>
                <button
                  type="button"
                  title="Cancel pane title"
                  aria-label="Cancel pane title"
                  onClick={cancelTitleEdit}
                  disabled={titleSavePending || titleGeneratePending}
                >
                  <Undo2 aria-hidden="true" />
                </button>
              </form>
            ) : (
              <strong ref={titleTextRef} className="pane-title-text" title={pane.title}>
                {pane.title}
              </strong>
            )}
          </div>
          {titleError ? (
            <small className="pane-title-hint" role="alert">
              {titleError}
            </small>
          ) : null}
        </div>
        <div className="pane-actions" ref={paneActionsRef}>
          {isFullscreenLayout ? (
            <div className="pane-fullscreen-nav" role="group" aria-label={`Pane navigation, pane ${fullscreenIndex + 1} of ${fullscreenCount}`}>
              <button
                type="button"
                className="pane-fullscreen-nav-button"
                title="Previous pane"
                aria-label="Previous pane"
                disabled={fullscreenCount < 2}
                onClick={() => onFullscreenNavigate("previous")}
              >
                <ChevronLeft aria-hidden="true" />
              </button>
              <span className="pane-fullscreen-position" aria-live="polite">
                {fullscreenIndex + 1} / {fullscreenCount}
              </span>
              <button
                type="button"
                className="pane-fullscreen-nav-button"
                title="Next pane"
                aria-label="Next pane"
                disabled={fullscreenCount < 2}
                onClick={() => onFullscreenNavigate("next")}
              >
                <ChevronRight aria-hidden="true" />
              </button>
            </div>
          ) : null}
          {paneToolbarRenderedActions.map((action) => {
            const ActionIcon = action.icon;
            return (
              <button
                key={action.id}
                type="button"
                className={action.className}
                title={action.title}
                aria-label={action.ariaLabel}
                aria-controls={action.ariaControls}
                aria-expanded={action.ariaExpanded}
                aria-haspopup={action.ariaHasPopup}
                aria-pressed={action.ariaPressed}
                onClick={action.onClick}
                disabled={action.disabled}
                onContextMenu={(event) => {
                  if (usesCompactPaneActions || action.hideable === false) return;
                  event.preventDefault();
                  paneToolbar.closeMenus();
                  paneToolbar.setActionMenu({
                    actionId: action.id,
                    actionLabel: action.ariaLabel,
                    x: event.clientX,
                    y: event.clientY
                  });
                }}
                {...paneToolbar.getDragHandleProps(action)}
              >
                <ActionIcon aria-hidden="true" />
              </button>
            );
          })}
          {paneToolbar.actionMenu ? (
            <div
              className="icon-context-menu"
              role="menu"
              aria-label={`Action menu ${paneToolbar.actionMenu.actionLabel}`}
              style={{ left: `${paneToolbar.actionMenu.x}px`, top: `${paneToolbar.actionMenu.y}px` }}
            >
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  if (paneToolbar.actionMenu) paneToolbar.hideAction(paneToolbar.actionMenu.actionId);
                }}
              >
                Hide
              </button>
            </div>
          ) : null}
        </div>
        <div ref={paneFixedActionsRef} className="pane-actions-fixed">
          <div className="pane-actions-overflow">
            <button
              ref={paneOverflowTriggerRef}
              type="button"
              title={`More pane actions ${title}`}
              aria-label={`More pane actions ${title}`}
              aria-controls={paneActionsPopupId}
              aria-expanded={paneToolbar.isOverflowOpen}
              aria-haspopup={shellMode === "mobile" ? "dialog" : "menu"}
              onClick={() => {
                paneToolbar.setActionMenu(null);
                paneToolbar.setIsOverflowOpen((current) => !current);
              }}
            >
              <MoreHorizontal aria-hidden="true" />
            </button>
            {paneToolbar.isOverflowOpen ? (
              shellMode === "mobile" ? (
                <MobileActionSheet
                  actions={paneToolbar.orderedActions}
                  commands={paneOverflowCommands}
                  hiddenActionIds={paneToolbar.hiddenActionIds}
                  label={`Pane actions ${title}`}
                  onClose={paneToolbar.closeMenus}
                  onHideAction={paneToolbar.hideAction}
                  onRunCommand={(command) => {
                    paneToolbar.setIsOverflowOpen(false);
                    command.onClick();
                  }}
                  onShowAction={paneToolbar.showAction}
                  onRunAction={(action) => {
                    paneToolbar.setIsOverflowOpen(false);
                    action.onClick();
                  }}
                  plainActions={usesCompactPaneActions}
                  popupId={paneActionsPopupId}
                  triggerRef={paneOverflowTriggerRef}
                />
              ) : (
                <DesktopActionManager
                  actions={paneToolbar.orderedActions}
                  commandSectionLabel={uiTheme === "modern" ? "Quick actions" : "Task commands"}
                  commands={paneOverflowCommands}
                  hiddenActionIds={paneToolbar.hiddenActionIds}
                  label={`Pane actions ${title}`}
                  onClose={paneToolbar.closeMenus}
                  onHideAction={paneToolbar.hideAction}
                  onRunAction={(action) => {
                    paneToolbar.setIsOverflowOpen(false);
                    action.onClick();
                  }}
                  onRunCommand={(command) => {
                    paneToolbar.setIsOverflowOpen(false);
                    command.onClick();
                  }}
                  onShowAction={(actionId) => {
                    if (uiTheme === "modern") {
                      paneToolbar.showActionInPrimary(actionId, paneToolbarPrimaryActionCount);
                    } else {
                      paneToolbar.showAction(actionId);
                    }
                  }}
                  plainActions={usesCompactPaneActions}
                  preferPaneInside={pane.mode === "CHAT"}
                  primaryActionIds={uiTheme === "modern" ? paneToolbarRenderedActions.map((action) => action.id) : undefined}
                  popupId={paneActionsPopupId}
                  triggerRef={paneOverflowTriggerRef}
                />
              )
            ) : null}
          </div>
          <button
            type="button"
            title={maximizeLabel}
            aria-label={maximizeLabel}
            aria-pressed={showRestoreIcon}
            onClick={() => {
              paneToolbar.closeMenus();
              if (shellMode === "mobile") {
                onMobilePaneFocusChange(!isMobilePaneFocused);
                return;
              }
              onMaximize(pane);
            }}
          >
            {showRestoreIcon ? <Minimize2 aria-hidden="true" /> : <Maximize2 aria-hidden="true" />}
          </button>
          {shellMode !== "mobile" ? (
            <button
              type="button"
              title="Minimize pane"
              aria-label={`Minimize pane ${title}`}
              onClick={() => {
                paneToolbar.closeMenus();
                onMinimize(pane);
              }}
            >
              <Minus aria-hidden="true" />
            </button>
          ) : null}
          <button type="button" title="Close pane" aria-label="Close pane" onClick={() => onClose(pane.id)}>
            <X aria-hidden="true" />
          </button>
        </div>
      </header>
      <div className="pane-body">
        {usesGenericImport && (genericImportPending || genericImportNotice || genericImportError) ? (
          <div className={genericImportError ? "pane-import-alert bad" : "pane-import-alert"} role={genericImportError ? "alert" : "status"}>
            <span>{genericImportError ?? (genericImportPending ? "Importing files..." : genericImportNotice)}</span>
            {genericImportPending ? null : (
              <button type="button" className="notice-close" aria-label="Dismiss message" onClick={() => { if (genericImportError) setGenericImportError(null); else setGenericImportNotice(null); }}><X aria-hidden="true" /></button>
            )}
          </div>
        ) : null}
        {pane.mode === "CHAT" ? (
          <Suspense fallback={agentPaneLoadingFallback}>
            <LazyAgentPane
              pane={pane}
              codexEnvironment={codexEnvironment}
              workspaceTextSize={terminalFontSize}
              isVisible={isVisibleInShell && !pane.isMinimized}
              onSessionIdentityChange={setAgentPaneIdentity}
            />
          </Suspense>
        ) : pane.mode === "TERMINAL" ? (
          <TerminalPane
            pane={pane}
            terminalFontSize={terminalFontSize}
            bootstrapBarrier={terminalBootstrapBarrier}
            shouldBootstrap={shouldBootstrapTerminal}
            prefillInitialReplay={prefillInitialReplay}
            revealGeneration={revealGeneration}
            hideFloatingControls={hideCliFloats}
            isTarget={isTarget}
            isVisible={isTerminalOutputVisible}
            cliDebugModeEnabled={cliDebugModeEnabled}
            observerOnly={terminalObserverOnly}
            maxImagePreviews={cliImagePreviewLimit}
            onCliDebugModeChange={onCliDebugModeChange}
            onSessionMetadataChange={setTerminalSessionMetadata}
            onBootstrapped={handleTerminalBootstrapped}
            onPrefillReadyChange={handleTerminalPrefillReadyChange}
            onRevealReady={handleTerminalRevealReady}
          />
        ) : pane.mode === "BROWSER" ? (
          <Suspense fallback={browserPaneLoadingFallback}>
            <LazyBrowserPane
              pane={pane}
              agentNumber={agentNumber}
              observerOnly={browserObserverOnly}
              uiTheme={uiTheme}
            />
          </Suspense>
        ) : pane.mode === "YOUTUBE" ? (
          <Suspense fallback={browserPaneLoadingFallback}>
            <LazyYouTubePane
              pane={pane}
              agentNumber={agentNumber}
              observerOnly={browserObserverOnly}
              uiTheme={uiTheme}
            />
          </Suspense>
        ) : (
          <>
            <div className="pane-copy">
              <span className={`pill ${pane.status.toLowerCase()}`}>{pane.status}</span>
              <p>
                {codexTurnsEnabled
                  ? "Codex App Server turns are live through Temporal."
                  : "Dummy Temporal path ready; real Codex/model turns remain gated."}
              </p>
            </div>
            {latestTurn ? (
              <div className="turn-summary conversation-preview" aria-label={`Latest turn for ${pane.title}`}>
                <div className="turn-summary-head">
                  <span className={`status ${statusTone(latestTurn.status)}`}>{latestTurn.status}</span>
                  <strong>{latestTurn.id}</strong>
                </div>
                <div className="conversation-message user-message">
                  <span>You</span>
                  <p>{latestTurn.prompt ?? "Legacy prompt unavailable"}</p>
                </div>
                <div className="conversation-message agent-message">
                  <span>Agent</span>
                  <p>
                    {agentResponse ??
                      (latestTurn.status === "COMPLETED"
                        ? "Agent response was not captured for this older turn."
                        : latestTurn.status === "FAILED"
                          ? "Turn failed before an agent response was captured."
                          : "Waiting for agent response...")}
                  </p>
                </div>
                <small>{latestTurn.workflowId ?? "No workflow id"}</small>
              </div>
            ) : (
              <div className="turn-summary empty" role="status">
                No turns yet
              </div>
            )}
          </>
        )}
      </div>
      {resumeHistoryOpen ? (
        <TaskHistoryDialog
          mode={resumeHistoryMode}
          paneTitle={title}
          runtimeLabel={cliRuntimeLabel(terminalRuntimeId) ?? "Space CLI"}
          items={resumeHistoryItems}
          loading={resumeHistoryLoading}
          error={resumeHistoryError}
          loadMorePending={resumeHistoryLoadMorePending}
          hasMore={resumeHistoryHasMore}
          query={resumeHistoryQuery}
          onClose={closeResumeTaskHistory}
          onSelect={(item) => void resumeTask(item)}
          onLoadMore={() => void loadResumeHistory(resumeHistoryPage + 1, { append: true, query: resumeHistoryQuery })}
          onQueryChange={changeResumeHistoryQuery}
        />
      ) : null}
      {hasPendingCompletion && !hideCliFloats ? (
        <span className="pane-completion-chip" role="status" aria-label={`${title} ended`}>
          END
        </span>
      ) : null}
    </article>
  );
});

function eventTone(event: SpaceEvent) {
  if (event.type.endsWith("_FAILED") || event.type === "PANE_CLOSED") return "bad";
  if (
    event.type.endsWith("_CREATED") ||
    event.type.endsWith("_COMPLETED") ||
    event.type.endsWith("_SAVED") ||
    event.type.endsWith("_RECORDED") ||
    event.type.endsWith("_DECIDED")
  ) {
    return "ok";
  }
  return "muted";
}

function formatEventIds(event: SpaceEvent) {
  return [event.paneId, event.turnId, event.workflowId].filter(Boolean).join(" / ") || "room event";
}

function isPaneCapabilityMatrix(value: unknown): value is PaneCapabilityMatrix {
  return (
    typeof value === "object" &&
    value !== null &&
    Array.isArray((value as { groups?: unknown }).groups) &&
    typeof (value as { paneId?: unknown }).paneId === "string"
  );
}

function capabilityStatusTone(status: string): string {
  if (status === "VERIFIED" || status === "ENABLED") return "ok";
  if (status === "WARN") return "warn";
  if (status === "ERROR") return "bad";
  return "muted";
}

function capabilityExecutionLabel(execution: string): string {
  return execution.replace(/_/g, " ");
}

function PaneCapabilityPanel({
  title,
  matrix,
  loading,
  error
}: {
  title: string;
  matrix: PaneCapabilityMatrix | null;
  loading: boolean;
  error: string | null;
}) {
  return (
    <section className="pane-capabilities" aria-label={`Capabilities for ${title}`}>
      {matrix ? (
        matrix.groups.map((group) => (
          <div className="pane-capability-group" key={group.id} title={group.statusReason}>
            <span className={`capability-dot ${capabilityStatusTone(group.status)}`} aria-hidden="true" />
            <strong>{group.label}</strong>
            <span>{group.status.toLowerCase()}</span>
            <div>
              {group.items.slice(0, 3).map((item) => (
                <span className={`capability-chip ${capabilityStatusTone(item.status)}`} key={item.id} title={item.statusReason}>
                  {capabilityExecutionLabel(item.execution)}
                </span>
              ))}
            </div>
          </div>
        ))
      ) : (
        <div className="pane-capability-group is-empty">
          <span className={`capability-dot ${error ? "warn" : "muted"}`} aria-hidden="true" />
          <strong>Capabilities</strong>
          <span>{loading ? "loading" : "unavailable"}</span>
          <div>
            <span className="capability-chip muted">{error ?? "metadata pending"}</span>
          </div>
        </div>
      )}
    </section>
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function extractAgentResponseFromEvent(event: SpaceEvent): string | null {
  const metadata = isRecord(event.payload.metadata) ? event.payload.metadata : null;
  const codexAppServer = isRecord(metadata?.codexAppServer) ? metadata.codexAppServer : null;
  const agentMessageText = codexAppServer?.agentMessageText;
  if (typeof agentMessageText === "string" && agentMessageText.trim()) {
    return agentMessageText.trim();
  }
  if (event.message && event.message !== "Codex App Server turn completed.") {
    return event.message;
  }
  return null;
}

function parseStreamEvent(data: string, roomId?: string): SpaceEvent | null {
  let payload: unknown;
  try {
    payload = JSON.parse(data) as unknown;
  } catch {
    return null;
  }
  if (!isRecord(payload)) return null;
  const type = payload.type;
  const eventRoomId = payload.roomId;
  if (typeof type !== "string" || !streamEventTypes.includes(type as SpaceEvent["type"])) return null;
  if (typeof eventRoomId !== "string" || (roomId && eventRoomId !== roomId)) return null;
  if (
    typeof payload.id !== "string" ||
    typeof payload.traceId !== "string" ||
    typeof payload.message !== "string" ||
    typeof payload.createdAt !== "string"
  ) {
    return null;
  }
  return {
    id: payload.id,
    roomId: eventRoomId,
    paneId: typeof payload.paneId === "string" ? payload.paneId : null,
    turnId: typeof payload.turnId === "string" ? payload.turnId : null,
    workflowId: typeof payload.workflowId === "string" ? payload.workflowId : null,
    traceId: payload.traceId,
    type: type as SpaceEvent["type"],
    message: payload.message,
    payload: isRecord(payload.payload) ? payload.payload : {},
    createdAt: payload.createdAt
  };
}

function eventStreamStatusLabel(status: EventStreamStatus) {
  switch (status) {
    case "connected":
      return "SSE stream connected";
    case "connecting":
      return "SSE stream connecting";
    case "reconnecting":
      return "SSE stream reconnecting";
    case "unavailable":
      return "SSE stream unavailable";
    case "idle":
      return "SSE stream idle";
  }
}

function eventStreamStatusTone(status: EventStreamStatus) {
  if (status === "connected") return "ok";
  if (status === "unavailable") return "bad";
  return "muted";
}

function lifecycleEventTone(event: LifecycleDebugEvent) {
  if (event.type === "window_beforeunload" || event.type === "window_pagehide" || event.type === "component_unmounted") return "warn";
  if (event.type === "app_boot") return "ok";
  return "muted";
}

function EventDock({
  activeRoom,
  events,
  lifecycleDebugSnapshot,
  onLifecycleDebugClear,
  onRefresh,
  onLiveEvent
}: {
  activeRoom: Room | null;
  events: SpaceEvent[];
  lifecycleDebugSnapshot: LifecycleDebugSnapshot;
  onLifecycleDebugClear: () => void;
  onRefresh: (roomId: string) => Promise<void>;
  onLiveEvent: (event: SpaceEvent) => void;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [streamStatus, setStreamStatus] = useState<EventStreamStatus>("idle");
  const [streamError, setStreamError] = useState<string | null>(null);
  const streamHadConnectedRef = useRef(false);
  const latestEvents = useMemo(
    () => [...events].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 25),
    [events]
  );
  const latestLifecycleEvents = useMemo(
    () => [...lifecycleDebugSnapshot.events].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 18),
    [lifecycleDebugSnapshot.events]
  );

  useEffect(() => {
    if (!activeRoom) {
      streamHadConnectedRef.current = false;
      setStreamStatus("idle");
      setStreamError(null);
      return;
    }
    if (!eventGateway.supported) {
      setStreamStatus("unavailable");
      setStreamError("Browser EventSource is unavailable; use durable replay refresh.");
      return;
    }

    setStreamStatus("connecting");
    setStreamError(null);
    const source = eventGateway.open(api.eventStreamUrl({ roomId: activeRoom.id, replayLimit: 50 }), { withCredentials: true });

    const markConnected = () => {
      streamHadConnectedRef.current = true;
      setStreamStatus("connected");
      setStreamError(null);
    };
    const markReconnecting = () => {
      if (streamHadConnectedRef.current) {
        setStreamStatus("connected");
        setStreamError(null);
        return;
      }
      setStreamStatus("reconnecting");
      setStreamError(null);
    };
    const handleSpaceEvent = (message: MessageEvent<string>) => {
      const event = parseStreamEvent(message.data, activeRoom.id);
      if (!event) {
        setStreamError("Dropped malformed SSE payload; durable replay refresh remains authoritative.");
        return;
      }
      setStreamStatus("connected");
      setStreamError(null);
      onLiveEvent(event);
    };

    source.onopen = markConnected;
    source.onerror = markReconnecting;
    source.onmessage = handleSpaceEvent;
    source.addEventListener("ready", markConnected);
    for (const eventType of streamEventTypes) {
      source.addEventListener(eventType, handleSpaceEvent as EventListener);
    }

    return () => {
      source.onopen = null;
      source.onerror = null;
      source.onmessage = null;
      source.removeEventListener("ready", markConnected);
      for (const eventType of streamEventTypes) {
        source.removeEventListener(eventType, handleSpaceEvent as EventListener);
      }
      source.close();
    };
  }, [activeRoom, onLiveEvent]);

  async function refreshEvents() {
    if (!activeRoom) return;
    setPending(true);
    setError(null);
    try {
      await onRefresh(activeRoom.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Event replay refresh failed");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="dock-panel event-dock">
      <h2>Durable Event Log</h2>
      <section className="event-source" aria-label="Lifecycle refresh debug">
        <div className="mcp-execution-head">
          <div>
            <strong>Lifecycle refresh debug</strong>
            <span>Tracks real page loads, unloads, shell switches, pane visibility, and component remounts.</span>
          </div>
          <button className="compact-action" onClick={onLifecycleDebugClear} title="Clear lifecycle debug" aria-label="Clear lifecycle debug">
            <Trash2 aria-hidden="true" />
            <span>Clear</span>
          </button>
        </div>
        <div className="lifecycle-debug-grid">
          <div className="validation-result" role="status">
            <div>
              <span className={`status ${lifecycleDebugSnapshot.pageLoadCount > 1 ? "warn" : "ok"}`}>{lifecycleDebugSnapshot.pageLoadCount}</span>
              <strong>App boots</strong>
            </div>
            <small>Expected `1` unless the whole page actually reloaded.</small>
          </div>
          <div className="validation-result" role="status">
            <div>
              <span className={`status ${lifecycleDebugSnapshot.beforeUnloadCount > 0 ? "warn" : "ok"}`}>{lifecycleDebugSnapshot.beforeUnloadCount}</span>
              <strong>beforeunload</strong>
            </div>
            <small>Non-zero means the browser attempted to leave or reload the page.</small>
          </div>
          <div className="validation-result" role="status">
            <div>
              <span className={`status ${lifecycleDebugSnapshot.pageHideCount > 0 ? "warn" : "ok"}`}>{lifecycleDebugSnapshot.pageHideCount}</span>
              <strong>pagehide</strong>
            </div>
            <small>Useful to separate real navigations from React-only remounts.</small>
          </div>
          <div className="validation-result" role="status">
            <div>
              <span className="status muted">{lifecycleDebugSnapshot.shellModeChangeCount}</span>
              <strong>Shell mode changes</strong>
            </div>
            <small>Mobile/tablet/desktop transitions seen by the app shell.</small>
          </div>
          <div className="validation-result" role="status">
            <div>
              <span className={`status ${lifecycleDebugSnapshot.componentUnmountCount > 0 ? "warn" : "ok"}`}>{lifecycleDebugSnapshot.componentUnmountCount}</span>
              <strong>Component unmounts</strong>
            </div>
            <small>High churn here usually means pane refresh/remount, not full navigation.</small>
          </div>
          <div className="validation-result" role="status">
            <div>
              <span className={`status ${lifecycleDebugSnapshot.suspectRefreshCount > 0 ? "warn" : "ok"}`}>{lifecycleDebugSnapshot.suspectRefreshCount}</span>
              <strong>Suspect refreshes</strong>
            </div>
            <small>Derived from extra app boots plus unload/navigation signals.</small>
          </div>
        </div>
        {lifecycleDebugSnapshot.lastAppBoot ? (
          <div className="validation-result" role="status" aria-live="polite">
            <div>
              <span className="status ok">BOOT</span>
              <strong>Last app boot</strong>
              <code className="raw-code">{new Date(lifecycleDebugSnapshot.lastAppBoot.at).toLocaleTimeString()}</code>
            </div>
            <small>{lifecycleDebugSnapshot.lastAppBoot.detail}</small>
          </div>
        ) : null}
      </section>
      <section className="event-feed" aria-label="Lifecycle debug trace">
        {latestLifecycleEvents.length ? (
          latestLifecycleEvents.map((event) => (
            <article key={event.id} className="event-entry">
              <div>
                <span className={`status ${lifecycleEventTone(event)}`}>{event.type}</span>
                <time dateTime={event.at}>{new Date(event.at).toLocaleTimeString()}</time>
              </div>
              <strong>{event.scope}</strong>
              <small>{event.detail || "No detail"}</small>
              <code className="raw-code">
                {[event.shellMode, event.paneMode, event.paneId].filter(Boolean).join(" / ") || "global"}
              </code>
            </article>
          ))
        ) : (
          <div className="empty-mini" role="status">
            No lifecycle debug events recorded yet
          </div>
        )}
      </section>
      <section className="event-source" aria-label="Event replay source">
        <div className="mcp-execution-head">
          <div>
            <strong>Postgres replay source</strong>
            <span>{activeRoom ? `${activeRoom.name} / ${events.length} persisted events` : "No room selected"}</span>
          </div>
          <button className="compact-action" onClick={refreshEvents} disabled={!activeRoom || pending} title="Refresh events" aria-label="Refresh events">
            <RefreshCw aria-hidden="true" />
            <span>{pending ? "Refreshing" : "Refresh"}</span>
          </button>
        </div>
        <div className="validation-result" role="status" aria-live="polite">
          <div>
            <span className="status ok">LIVE</span>
            <strong>Durable replay active</strong>
            <code className="raw-code">GET /api/events</code>
          </div>
          <small>UI cache and SSE fan-out remain secondary to persisted room events.</small>
        </div>
        <div className="validation-result" role="status" aria-live="polite">
          <div>
            <span className={`status ${eventStreamStatusTone(streamStatus)}`}>{streamStatus.toUpperCase()}</span>
            <strong>{eventStreamStatusLabel(streamStatus)}</strong>
            <code className="raw-code">GET /api/events/stream</code>
          </div>
          <small>{activeRoom ? "Live fan-out accelerates the dock; Postgres replay remains the source of truth." : "Select a room to open the event stream."}</small>
          {streamError ? <small>{streamError}</small> : null}
        </div>
      </section>
      <section className="event-feed" aria-label="Persisted room events">
        {latestEvents.length ? (
          latestEvents.map((event) => {
            const payloadKeys = Object.keys(event.payload);
            return (
              <article key={event.id} className="event-entry">
                <div>
                  <span className={`status ${eventTone(event)}`}>{event.type}</span>
                  <time dateTime={event.createdAt}>{new Date(event.createdAt).toLocaleTimeString()}</time>
                </div>
                <strong>{event.message}</strong>
                <small>{formatEventIds(event)}</small>
                <code className="raw-code" title={event.traceId}>
                  {event.traceId}
                </code>
                <small>{payloadKeys.length ? `payload: ${payloadKeys.join(", ")}` : "payload: empty"}</small>
              </article>
            );
          })
        ) : (
          <div className="empty-mini" role="status">
            No persisted events for this room
          </div>
        )}
      </section>
      {error ? (
        <div className="validation-result bad" role="alert">
          <strong>EVENT_REPLAY_ERROR</strong>
          <small>{error}</small>
        </div>
      ) : null}
    </div>
  );
}

function ContextDock({
  providers,
  skills,
  onSkillCreated
}: {
  providers: Provider[];
  skills: Skill[];
  onSkillCreated: (skill: Skill) => void;
}) {
  const [displayName, setDisplayName] = useState("");
  const [triggerDescription, setTriggerDescription] = useState("");
  const [body, setBody] = useState("");
  const [allowedTools, setAllowedTools] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function proposeSkill() {
    setPending(true);
    setError(null);
    try {
      const skill = await api.createSkill({
        displayName,
        triggerDescription,
        body,
        allowedTools: allowedTools
          .split(/[,\n]/)
          .map((tool) => tool.trim())
          .filter(Boolean)
      });
      onSkillCreated(skill);
      setDisplayName("");
      setTriggerDescription("");
      setBody("");
      setAllowedTools("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Skill proposal failed");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="dock-panel">
      <h2>Context</h2>
      <section>
        <h3>Providers</h3>
        {providers.map((provider) => (
          <div key={provider.id} className="dock-row">
            <span>{provider.displayName}</span>
            <span className={`status ${statusTone(provider.status)}`}>{provider.status}</span>
          </div>
        ))}
      </section>
      <section className="skill-form" aria-label="Propose skill">
        <h3>Propose Skill</h3>
        <input aria-label="Skill name" value={displayName} onChange={(event) => setDisplayName(event.target.value)} placeholder="Name" />
        <input
          aria-label="Skill trigger"
          value={triggerDescription}
          onChange={(event) => setTriggerDescription(event.target.value)}
          placeholder="Trigger"
        />
        <textarea aria-label="Skill body" value={body} onChange={(event) => setBody(event.target.value)} placeholder="Body" rows={4} />
        <input
          aria-label="Skill tools"
          value={allowedTools}
          onChange={(event) => setAllowedTools(event.target.value)}
          placeholder="Allowed tools"
        />
        <button
          className="compact-action primary-action"
          onClick={proposeSkill}
          disabled={pending || !displayName.trim() || !triggerDescription.trim() || !body.trim()}
          title="Propose skill"
          aria-label="Propose skill"
        >
          <Plus aria-hidden="true" />
          <span>{pending ? "Saving" : "Propose"}</span>
        </button>
        {error ? (
          <div className="validation-result bad" role="alert">
            <strong>SKILL_ERROR</strong>
            <small>{error}</small>
          </div>
        ) : null}
      </section>
      <section className="skill-list" aria-label="Skills">
        <h3>Skills</h3>
        {skills.map((skill) => (
          <article key={skill.id} className="skill-entry">
            <div>
              <span className={`status ${statusTone(skill.status)}`}>{skill.status}</span>
              <strong>{skill.displayName}</strong>
            </div>
            <p>{skill.triggerDescription}</p>
            <small>{skill.contentHash.slice(0, 19)}</small>
          </article>
        ))}
      </section>
    </div>
  );
}

function ImportDock({
  activeRoom,
  candidates,
  onCandidateCreated,
  onCandidateUpdated,
  onSkillImported
}: {
  activeRoom: Room | null;
  candidates: ImportCandidate[];
  onCandidateCreated: (candidate: ImportCandidate) => void;
  onCandidateUpdated: (candidate: ImportCandidate) => void;
  onSkillImported: (skill: Skill) => void;
}) {
  const [sourceKind, setSourceKind] = useState<ImportSourceKind>("CODEX_MEMORY");
  const [targetKind, setTargetKind] = useState<ImportTargetKind>("MEMORY");
  const [memoryScope, setMemoryScope] = useState<MemoryEntry["scope"]>("ROOM");
  const [sourceRef, setSourceRef] = useState("operator-paste");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [provenance, setProvenance] = useState("explicit-import-gate");
  const [skillTriggerDescription, setSkillTriggerDescription] = useState("");
  const [skillVersion, setSkillVersion] = useState("0.1.0");
  const [allowedTools, setAllowedTools] = useState("");
  const [decisionReason, setDecisionReason] = useState("Not approved for import.");
  const [pending, setPending] = useState(false);
  const [decisionPendingId, setDecisionPendingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function stageCandidate() {
    setPending(true);
    setError(null);
    try {
      const candidate = await api.createImportCandidate({
        sourceKind,
        targetKind,
        sourceRef,
        roomId: targetKind === "MEMORY" && memoryScope === "ROOM" ? activeRoom?.id ?? null : null,
        memoryScope,
        title,
        body,
        provenance,
        skillVersion,
        skillTriggerDescription: targetKind === "SKILL" ? skillTriggerDescription : undefined,
        allowedTools: allowedTools
          .split(/[,\n]/)
          .map((tool) => tool.trim())
          .filter(Boolean)
      });
      onCandidateCreated(candidate);
      setTitle("");
      setBody("");
      setSkillTriggerDescription("");
      setAllowedTools("");
      setSourceRef("operator-paste");
      setProvenance("explicit-import-gate");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Import candidate staging failed");
    } finally {
      setPending(false);
    }
  }

  async function decide(candidate: ImportCandidate, decision: "IMPORT" | "REJECT") {
    setDecisionPendingId(candidate.id);
    setError(null);
    try {
      const result = await api.decideImportCandidate(candidate.id, {
        decision,
        reason: decision === "REJECT" ? decisionReason : "Approved explicit import."
      });
      onCandidateUpdated(result.candidate);
      if (result.skill) onSkillImported(result.skill);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Import candidate decision failed");
    } finally {
      setDecisionPendingId(null);
    }
  }

  const pendingCandidates = candidates.filter((candidate) => candidate.status === "PENDING");
  const decidedCandidates = candidates.filter((candidate) => candidate.status !== "PENDING").slice(0, 5);
  const stageDisabled =
    pending ||
    !title.trim() ||
    !body.trim() ||
    !sourceRef.trim() ||
    !provenance.trim() ||
    (targetKind === "MEMORY" && memoryScope === "ROOM" && !activeRoom) ||
    (targetKind === "SKILL" && !skillTriggerDescription.trim());

  return (
    <div className="dock-panel import-dock">
      <h2>Import Gate</h2>
      <section className="import-gate-status" aria-label="Import gate status">
        <div className="validation-result" role="status">
          <div>
            <span className="status ok">LIVE</span>
            <strong>Explicit copy gate active</strong>
          </div>
          <small>Codex memory/skill material must be pasted or staged here, reviewed, and imported as a native Space copy.</small>
        </div>
      </section>
      <section className="import-form" aria-label="Stage import candidate">
        <div className="inline-field">
          <select aria-label="Import source kind" value={sourceKind} onChange={(event) => setSourceKind(event.target.value as ImportSourceKind)}>
            <option value="CODEX_MEMORY">Codex memory</option>
            <option value="CODEX_SKILL">Codex skill</option>
            <option value="OPERATOR_NOTE">Operator note</option>
            <option value="MARKDOWN">Markdown</option>
          </select>
          <select aria-label="Import target kind" value={targetKind} onChange={(event) => setTargetKind(event.target.value as ImportTargetKind)}>
            <option value="MEMORY">Memory</option>
            <option value="SKILL">Skill</option>
          </select>
        </div>
        <input aria-label="Import source reference" value={sourceRef} onChange={(event) => setSourceRef(event.target.value)} placeholder="Source reference" />
        {targetKind === "MEMORY" ? (
          <div className="inline-field">
            <select aria-label="Import memory scope" value={memoryScope} onChange={(event) => setMemoryScope(event.target.value as MemoryEntry["scope"])}>
              <option value="ROOM">Room</option>
              <option value="PROJECT">Project</option>
              <option value="SYSTEM">System</option>
            </select>
            <input
              aria-label="Import provenance"
              value={provenance}
              onChange={(event) => setProvenance(event.target.value)}
              placeholder="Provenance"
            />
          </div>
        ) : (
          <>
            <input
              aria-label="Import skill trigger"
              value={skillTriggerDescription}
              onChange={(event) => setSkillTriggerDescription(event.target.value)}
              placeholder="Skill trigger"
            />
            <div className="inline-field">
              <input aria-label="Import skill version" value={skillVersion} onChange={(event) => setSkillVersion(event.target.value)} placeholder="Version" />
              <input aria-label="Import skill tools" value={allowedTools} onChange={(event) => setAllowedTools(event.target.value)} placeholder="Allowed tools" />
            </div>
          </>
        )}
        <input aria-label="Import title" value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Title" />
        <textarea aria-label="Import body" value={body} onChange={(event) => setBody(event.target.value)} placeholder="Copy source content here" rows={4} />
        <button
          className="compact-action primary-action"
          onClick={stageCandidate}
          disabled={stageDisabled}
          title="Stage import candidate"
          aria-label="Stage import candidate"
        >
          <Plus aria-hidden="true" />
          <span>{pending ? "Staging" : "Stage"}</span>
        </button>
      </section>
      <section className="import-decisions" aria-label="Import candidates">
        <div className="inline-field">
          <input
            aria-label="Import reject reason"
            value={decisionReason}
            onChange={(event) => setDecisionReason(event.target.value)}
            placeholder="Reject reason"
          />
        </div>
        {pendingCandidates.length ? (
          pendingCandidates.map((candidate) => (
            <article key={candidate.id} className="import-entry">
              <div>
                <span className={`status ${statusTone(candidate.status)}`}>{candidate.status}</span>
                <strong>{candidate.title}</strong>
              </div>
              <p>{candidate.body}</p>
              <small>
                {candidate.sourceKind} {"->"} {candidate.targetKind} / {candidate.sourceRef}
              </small>
              <div className="entry-actions">
                <button
                  className="compact-action primary-action"
                  onClick={() => decide(candidate, "IMPORT")}
                  disabled={decisionPendingId === candidate.id}
                  title="Import candidate"
                  aria-label={`Import ${candidate.title}`}
                >
                  <CheckCircle2 aria-hidden="true" />
                  <span>Import</span>
                </button>
                <button
                  className="compact-action"
                  onClick={() => decide(candidate, "REJECT")}
                  disabled={decisionPendingId === candidate.id || !decisionReason.trim()}
                  title="Reject candidate"
                  aria-label={`Reject ${candidate.title}`}
                >
                  <CircleStop aria-hidden="true" />
                  <span>Reject</span>
                </button>
              </div>
            </article>
          ))
        ) : (
          <div className="empty-mini" role="status">
            No pending imports
          </div>
        )}
      </section>
      {decidedCandidates.length ? (
        <section className="import-list" aria-label="Recent import decisions">
          <h3>Recent Decisions</h3>
          {decidedCandidates.map((candidate) => (
            <article key={candidate.id} className="import-entry compact">
              <div>
                <span className={`status ${statusTone(candidate.status)}`}>{candidate.status}</span>
                <strong>{candidate.title}</strong>
              </div>
              <small>{candidate.importedMemoryId ?? candidate.importedSkillId ?? candidate.statusReason}</small>
            </article>
          ))}
        </section>
      ) : null}
      {error ? (
        <div className="validation-result bad" role="alert">
          <strong>IMPORT_ERROR</strong>
          <small>{error}</small>
        </div>
      ) : null}
    </div>
  );
}

const swarmRoles: SwarmTaskRole[] = ["PLANNER", "WORKER", "REVIEWER"];
const swarmTaskStatuses: SwarmTaskStatus[] = ["READY", "RUNNING", "BLOCKED", "DONE"];
const reconcileDecisions: SwarmReconcileDecision[] = ["MERGED", "BLOCKED", "NEEDS_HUMAN"];

function taskTone(status: SwarmTaskStatus) {
  if (status === "DONE") return "ok";
  if (status === "BLOCKED" || status === "CANCELLED") return "bad";
  return "muted";
}

function SwarmDock({
  activeRoom,
  swarmState,
  onSwarmState
}: {
  activeRoom: Room | null;
  swarmState: SwarmState | null;
  onSwarmState: (state: SwarmState) => void;
}) {
  const [role, setRole] = useState<SwarmTaskRole>("WORKER");
  const [title, setTitle] = useState("");
  const [goal, setGoal] = useState("");
  const [assignee, setAssignee] = useState("");
  const [lockTaskId, setLockTaskId] = useState("");
  const [resource, setResource] = useState("/opt/spaceapp");
  const [holder, setHolder] = useState("worker-1");
  const [lockReason, setLockReason] = useState("Avoid concurrent writes.");
  const [messageTaskId, setMessageTaskId] = useState("");
  const [fromRole, setFromRole] = useState<SwarmTaskRole>("WORKER");
  const [toRole, setToRole] = useState<SwarmTaskRole | "">("REVIEWER");
  const [messageBody, setMessageBody] = useState("");
  const [selectedTaskIds, setSelectedTaskIds] = useState<string[]>([]);
  const [decision, setDecision] = useState<SwarmReconcileDecision>("MERGED");
  const [summary, setSummary] = useState("");
  const [nextSteps, setNextSteps] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function loadSwarm() {
    if (!activeRoom) return;
    onSwarmState(await api.swarm(activeRoom.id));
  }

  useEffect(() => {
    void loadSwarm();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeRoom?.id]);

  async function runSwarmAction(action: () => Promise<void>) {
    if (!activeRoom) return;
    setPending(true);
    setError(null);
    try {
      await action();
      await loadSwarm();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Swarm action failed");
    } finally {
      setPending(false);
    }
  }

  async function createTask() {
    await runSwarmAction(async () => {
      if (!activeRoom || !title.trim() || !goal.trim()) return;
      await api.createSwarmTask({
        roomId: activeRoom.id,
        role,
        title,
        goal,
        assignee: assignee.trim() || null,
        dependsOnTaskIds: selectedTaskIds
      });
      setTitle("");
      setGoal("");
      setAssignee("");
    });
  }

  async function updateTask(task: SwarmTask, status: SwarmTaskStatus) {
    await runSwarmAction(async () => {
      await api.updateSwarmTask(task.id, {
        status,
        resultSummary: status === "DONE" ? "Marked done by operator control plane." : task.resultSummary
      });
    });
  }

  async function claimLock() {
    await runSwarmAction(async () => {
      if (!activeRoom || !resource.trim() || !holder.trim() || !lockReason.trim()) return;
      await api.claimSwarmLock({
        roomId: activeRoom.id,
        taskId: lockTaskId || null,
        resource,
        holder,
        reason: lockReason
      });
    });
  }

  async function releaseLock(lock: SwarmLock) {
    await runSwarmAction(async () => {
      await api.releaseSwarmLock(lock.id, "Released from Space Swarm dock.");
    });
  }

  async function postMessage() {
    await runSwarmAction(async () => {
      if (!activeRoom || !messageBody.trim()) return;
      await api.postSwarmMessage({
        roomId: activeRoom.id,
        taskId: messageTaskId || null,
        fromRole,
        toRole: toRole || null,
        body: messageBody
      });
      setMessageBody("");
    });
  }

  async function reconcile() {
    await runSwarmAction(async () => {
      if (!activeRoom || !selectedTaskIds.length || !summary.trim()) return;
      await api.createSwarmReconcile({
        roomId: activeRoom.id,
        taskIds: selectedTaskIds,
        decision,
        summary,
        nextSteps
      });
      setSummary("");
      setNextSteps("");
    });
  }

  function toggleTaskSelection(taskId: string) {
    setSelectedTaskIds((current) =>
      current.includes(taskId) ? current.filter((id) => id !== taskId) : [...current, taskId]
    );
  }

  const tasks = swarmState?.tasks ?? [];
  const locks = swarmState?.locks ?? [];
  const activeLocks = locks.filter((lock) => lock.status === "ACTIVE");
  const messages = swarmState?.messages ?? [];
  const reconciles = swarmState?.reconciles ?? [];

  return (
    <div className="dock-panel swarm-dock">
      <h2>Swarm</h2>
      <section className="swarm-status" aria-label="Swarm status">
        <Boxes aria-hidden="true" />
        <span>
          <strong>Control plane active</strong>
          <small>{swarmState?.statusReason ?? "Load a room to inspect swarm state."}</small>
        </span>
        <span className="status muted">{swarmState?.executionStatus ?? "DISABLED"}</span>
      </section>
      <section className="swarm-metrics" aria-label="Swarm metrics">
        <Metric label="Tasks" value={String(tasks.length)} tone="muted" />
        <Metric label="Active locks" value={String(activeLocks.length)} tone={activeLocks.length ? "bad" : "ok"} />
      </section>
      <section className="swarm-form" aria-label="Create swarm task">
        <div className="inline-field">
          <select aria-label="Swarm task role" value={role} onChange={(event) => setRole(event.target.value as SwarmTaskRole)}>
            {swarmRoles.map((item) => (
              <option key={item} value={item}>{readableCode(item)}</option>
            ))}
          </select>
          <input aria-label="Swarm assignee" value={assignee} onChange={(event) => setAssignee(event.target.value)} placeholder="Assignee" />
        </div>
        <input aria-label="Swarm task title" value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Task title" />
        <textarea aria-label="Swarm task goal" value={goal} onChange={(event) => setGoal(event.target.value)} placeholder="Goal" rows={3} />
        <button className="compact-action primary-action" onClick={createTask} disabled={pending || !activeRoom || !title.trim() || !goal.trim()} title="Create swarm task" aria-label="Create swarm task">
          <Plus aria-hidden="true" />
          <span>{pending ? "Working" : "Create task"}</span>
        </button>
      </section>
      {error ? (
        <div className="validation-result bad" role="alert">
          <strong>SWARM_ERROR</strong>
          <small>{error}</small>
        </div>
      ) : null}
      <section className="swarm-list" aria-label="Swarm tasks">
        {tasks.length ? tasks.map((task) => (
          <article key={task.id} className="swarm-entry">
            <div className="swarm-entry-head">
              <SpaceToggle
                className="checkbox-line"
                ariaLabel={`Select ${task.title}`}
                label={<span className={`status ${taskTone(task.status)}`}>{readableCode(task.status)}</span>}
                checked={selectedTaskIds.includes(task.id)}
                onChange={() => toggleTaskSelection(task.id)}
              />
              <strong>{task.title}</strong>
            </div>
            <p>{task.goal}</p>
            <small>{task.role} / {task.assignee ?? "unassigned"} / {task.id}</small>
            <div className="swarm-actions" role="group" aria-label={`Update ${task.title}`}>
              {swarmTaskStatuses.map((status) => (
                <button key={status} className="compact-action" onClick={() => updateTask(task, status)} disabled={pending || task.status === status} title={`Mark ${readableCode(status)}`} aria-label={`Mark ${task.title} ${readableCode(status)}`}>
                  <CheckCircle2 aria-hidden="true" />
                  <span>{readableCode(status)}</span>
                </button>
              ))}
            </div>
          </article>
        )) : (
          <div className="empty-mini" role="status">No swarm tasks</div>
        )}
      </section>
      <section className="swarm-form" aria-label="Claim swarm lock">
        <div className="inline-field">
          <select aria-label="Swarm lock task" value={lockTaskId} onChange={(event) => setLockTaskId(event.target.value)}>
            <option value="">No task</option>
            {tasks.map((task) => (
              <option key={task.id} value={task.id}>{task.title}</option>
            ))}
          </select>
          <input aria-label="Swarm lock holder" value={holder} onChange={(event) => setHolder(event.target.value)} placeholder="Holder" />
        </div>
        <input aria-label="Swarm lock resource" value={resource} onChange={(event) => setResource(event.target.value)} placeholder="/opt/spaceapp/path" />
        <input aria-label="Swarm lock reason" value={lockReason} onChange={(event) => setLockReason(event.target.value)} placeholder="Reason" />
        <button className="compact-action primary-action" onClick={claimLock} disabled={pending || !activeRoom || !resource.trim()} title="Claim swarm lock" aria-label="Claim swarm lock">
          <Lock aria-hidden="true" />
          <span>Claim lock</span>
        </button>
      </section>
      <section className="swarm-list" aria-label="Swarm locks">
        {locks.length ? locks.map((lock) => (
          <article key={lock.id} className="swarm-entry compact">
            <div className="swarm-entry-head">
              <span className={`status ${lock.status === "ACTIVE" ? "bad" : "muted"}`}>{readableCode(lock.status)}</span>
              <strong>{lock.resource}</strong>
            </div>
            <small>{lock.holder} / {lock.reason}</small>
            {lock.status === "ACTIVE" ? (
              <button className="compact-action" onClick={() => releaseLock(lock)} disabled={pending} title="Release swarm lock" aria-label={`Release ${lock.resource}`}>
                <CircleStop aria-hidden="true" />
                <span>Release</span>
              </button>
            ) : null}
          </article>
        )) : (
          <div className="empty-mini" role="status">No swarm locks</div>
        )}
      </section>
      <section className="swarm-form" aria-label="Post swarm message">
        <div className="inline-field">
          <select aria-label="Swarm message task" value={messageTaskId} onChange={(event) => setMessageTaskId(event.target.value)}>
            <option value="">Room mailbox</option>
            {tasks.map((task) => (
              <option key={task.id} value={task.id}>{task.title}</option>
            ))}
          </select>
          <select aria-label="Swarm message from role" value={fromRole} onChange={(event) => setFromRole(event.target.value as SwarmTaskRole)}>
            {swarmRoles.map((item) => (
              <option key={item} value={item}>{readableCode(item)}</option>
            ))}
          </select>
        </div>
        <select aria-label="Swarm message to role" value={toRole} onChange={(event) => setToRole(event.target.value as SwarmTaskRole | "")}>
          <option value="">Broadcast</option>
          {swarmRoles.map((item) => (
            <option key={item} value={item}>{readableCode(item)}</option>
          ))}
        </select>
        <textarea aria-label="Swarm message body" value={messageBody} onChange={(event) => setMessageBody(event.target.value)} placeholder="Message" rows={3} />
        <button className="compact-action primary-action" onClick={postMessage} disabled={pending || !activeRoom || !messageBody.trim()} title="Post swarm message" aria-label="Post swarm message">
          <Send aria-hidden="true" />
          <span>Post message</span>
        </button>
      </section>
      <section className="swarm-form" aria-label="Create swarm reconcile">
        <select aria-label="Swarm reconcile decision" value={decision} onChange={(event) => setDecision(event.target.value as SwarmReconcileDecision)}>
          {reconcileDecisions.map((item) => (
            <option key={item} value={item}>{readableCode(item)}</option>
          ))}
        </select>
        <input aria-label="Swarm reconcile summary" value={summary} onChange={(event) => setSummary(event.target.value)} placeholder="Summary" />
        <textarea aria-label="Swarm reconcile next steps" value={nextSteps} onChange={(event) => setNextSteps(event.target.value)} placeholder="Next steps" rows={2} />
        <button className="compact-action primary-action" onClick={reconcile} disabled={pending || !activeRoom || !selectedTaskIds.length || !summary.trim()} title="Create swarm reconcile" aria-label="Create swarm reconcile">
          <GitCompare aria-hidden="true" />
          <span>Reconcile {selectedTaskIds.length}</span>
        </button>
      </section>
      <section className="swarm-list" aria-label="Swarm mailbox and reconciles">
        {messages.slice(0, 4).map((message) => (
          <article key={message.id} className="swarm-entry compact">
            <div className="swarm-entry-head">
              <span className="status muted">{message.fromRole}</span>
              <strong>{message.toRole ?? "BROADCAST"}</strong>
            </div>
            <p>{message.body}</p>
          </article>
        ))}
        {reconciles.slice(0, 4).map((item) => (
          <article key={item.id} className="swarm-entry compact">
            <div className="swarm-entry-head">
              <span className={`status ${item.decision === "MERGED" ? "ok" : "bad"}`}>{readableCode(item.decision)}</span>
              <strong>{item.summary}</strong>
            </div>
            {item.nextSteps ? <p>{item.nextSteps}</p> : null}
            <small>{item.taskIds.length} reconciled tasks</small>
          </article>
        ))}
      </section>
    </div>
  );
}

function OperatorProgressBanner(props: BlueprintProgressProps) {
  const { completionPct, liveCount, progressItems, visibleCount, gatedItems, nextItem } = buildBlueprintProgressState(props);
  const storageBlocked = props.storageReadiness ? props.storageReadiness.status !== "VERIFIED" : props.storageWarning.trim().length > 0;
  const storageLabel = props.storageReadiness ? `Storage ${props.storageReadiness.status}` : "Storage gate";
  const storageDetail = props.storageReadiness
    ? `${formatBytes(props.storageReadiness.app.availableBytes)} free / root ${props.storageReadiness.root.usedPercent}% / dedicated ${
        props.storageReadiness.dedicatedAppVolume ? "yes" : "no"
      }`
    : "Dedicated /opt/spaceapp volume still blocks production-heavy launch";
  const primaryGate = gatedItems[0];

  return (
    <section className="operator-pulse" aria-label="Space build pulse">
      <div className="pulse-main">
        <span className="eyebrow">Live UI Marker</span>
        <h3>Space Build Pulse</h3>
        <p>New visible now: first-viewport progress banner for the Space Master Blueprint rollout.</p>
      </div>
      <div className="pulse-meter" aria-label="Blueprint live completion">
        <strong>{completionPct}% live</strong>
        <span>
          {liveCount}/{progressItems.length} slices active
        </span>
        <div className="pulse-bar" aria-hidden="true">
          <span style={{ width: `${completionPct}%` }} />
        </div>
      </div>
      <div className="pulse-facts" aria-label="Current Space state">
        <span>
          <strong>{visibleCount}</strong>
          visible surfaces
        </span>
        <span>
          <strong>{primaryGate?.label ?? "No active gate"}</strong>
          {primaryGate?.detail ?? "All required gates are currently clear"}
        </span>
        <span className={storageBlocked ? "pulse-warning" : ""}>
          <strong>{storageBlocked ? storageLabel : nextItem?.label ?? "Next slice"}</strong>
          {storageBlocked ? storageDetail : nextItem?.detail ?? "Backlog is empty"}
        </span>
      </div>
    </section>
  );
}

function BlueprintProgress(props: BlueprintProgressProps) {
  const { progressItems, liveCount, visibleCount, latestSmokeLabel } = buildBlueprintProgressState(props);
  const {
    latestSmoke,
    storageWarning
  } = props;

  return (
    <section className="blueprint-progress" aria-label="Blueprint progress">
      <header>
        <div>
          <span className="eyebrow">Master Blueprint</span>
          <h3>Blueprint Progress</h3>
        </div>
        <div className="blueprint-meters" aria-label="Blueprint counters">
          <Metric label="Visible surface" value={`${visibleCount}/${progressItems.length}`} tone="ok" />
          <Metric label="Live slices" value={`${liveCount}/${progressItems.length}`} tone="ok" />
          <Metric label="MCP smoke" value={latestSmokeLabel} tone={statusTone(latestSmoke?.status ?? "")} />
        </div>
      </header>
      <div className="latest-slice" role="status">
        <Sparkles aria-hidden="true" />
        <span>
          <strong>Latest visible slice</strong>
          <small>This progress board stays tucked into the dock until opened.</small>
        </span>
      </div>
      {storageWarning ? (
        <div className="storage-blocker" role="status">
          <CircleStop aria-hidden="true" />
          <span>
            <strong>Production storage blocker</strong>
            <small>{storageWarning}</small>
          </span>
        </div>
      ) : null}
      <div className="blueprint-grid">
        {progressItems.map((item) => (
          <article key={item.label} className="blueprint-cell">
            <span className={`status ${statusTone(item.status)}`}>{item.status}</span>
            <strong>{item.label}</strong>
            <small>{item.detail}</small>
          </article>
        ))}
      </div>
    </section>
  );
}

function ProgressDock(props: BlueprintProgressProps) {
  return (
    <div className="dock-panel progress-dock">
      <BlueprintProgress {...props} />
    </div>
  );
}

interface RuntimeStatusProps {
  readiness: ReadyzPayload | null;
  mcp: McpPayload | null;
  latestSmoke: McpDiscoverySmokeCheck | null;
  observability: ObservabilitySnapshot | null;
  workerReadiness: WorkerReadiness | null;
  storageReadiness: StorageReadiness | null;
}

interface HealthDockProps extends RuntimeStatusProps {
  providers: Provider[];
  models: Model[];
}

function HealthDock({
  readiness,
  mcp,
  latestSmoke,
  providers,
  models,
  observability,
  workerReadiness,
  storageReadiness
}: HealthDockProps) {
  const dependencies = readiness?.dependencies;
  const provider = providers[0] ?? null;
  const verifiedModelCount = models.filter((model) => model.status === "VERIFIED").length;
  const requestValue = observability
    ? `${observability.totals.requestCount} req / p95 ${formatDurationMs(observability.totals.p95Ms)}`
    : "Loading";
  const storageDetail = storageReadiness
    ? storageReadiness.statusReason
    : "Storage snapshot loading";
  const storageMeta = storageReadiness
    ? `${formatBytes(storageReadiness.app.availableBytes)} free / root ${storageReadiness.root.usedPercent}% / dedicated ${storageReadiness.dedicatedAppVolume ? "yes" : "no"}`
    : "Checking storage";
  const appVersion = useAppVersion();
  const versionDetail = appVersion?.athensTag
    ? `${appVersion.athensTag}`
    : appVersion?.shortCommit
      ? `commit ${appVersion.shortCommit}${appVersion.dirty ? " · dirty" : ""}`
      : "Version unavailable";
  const versionValue = appVersion?.appRelease ?? "Loading";

  return (
    <div className="dock-panel health-dock">
      <header className="settings-dock-title">
        <Activity aria-hidden="true" />
        <span>
          <h2>Space Health</h2>
          <small>Basic operating status.</small>
        </span>
      </header>
      <section className="health-grid" aria-label="Space health status">
        <HealthTile
          icon={ServerCog}
          label="Runtime"
          value={dependencies ? `${dependencies.runtimeStore} / Temporal ${dependencies.temporal}` : "Loading"}
          detail={dependencies ? `Worker ${dependencies.worker}` : "Runtime snapshot loading"}
          tone={readiness?.ok ? "ok" : "muted"}
        />
        <HealthTile
          icon={UserCheck}
          label="Worker"
          value={workerReadiness?.status ?? dependencies?.worker ?? "Loading"}
          detail={workerReadiness ? `${workerReadiness.pollerCount} pollers / ${workerReadiness.taskQueue}` : "Worker snapshot loading"}
          tone={statusTone(workerReadiness?.status ?? dependencies?.worker ?? "")}
        />
        <HealthTile
          icon={ServerCog}
          label="Provider"
          value={provider?.displayName ?? "No provider"}
          detail={provider ? `${provider.status} / ${verifiedModelCount}/${models.length} verified models` : "Provider catalog loading"}
          tone={statusTone(provider?.status ?? "")}
        />
        <HealthTile
          icon={HardDrive}
          label="Storage"
          value={storageReadiness?.status ?? "Loading"}
          detail={storageDetail}
          meta={storageMeta}
          tone={statusTone(storageReadiness?.status ?? "")}
        />
        <HealthTile
          icon={ShieldCheck}
          label="MCP"
          value={mcp?.gateway.status ?? "Loading"}
          detail={mcp ? `${mcp.gateway.serverCount} servers / ${mcp.gateway.toolCount} tools` : "MCP snapshot loading"}
          meta={latestSmoke?.code ? readableCode(latestSmoke.code) : "Smoke not run"}
          tone={statusTone(mcp?.gateway.status ?? latestSmoke?.status ?? "")}
        />
        <HealthTile
          icon={Activity}
          label="Requests"
          value={requestValue}
          detail={observability ? `${observability.totals.errorCount} errors` : "Observability snapshot loading"}
          tone={(observability?.totals.errorCount ?? 0) > 0 ? "bad" : observability ? "ok" : "muted"}
        />
        <HealthTile
          icon={GitCompare}
          label="Version"
          value={versionValue}
          detail={versionDetail}
          meta={
            appVersion?.updateAvailable && appVersion.githubLatest
              ? `Update available: ${appVersion.githubLatest}`
              : appVersion?.checkedAt
                ? "Up to date"
                : undefined
          }
          tone={appVersion?.updateAvailable ? "bad" : appVersion ? "ok" : "muted"}
        />
      </section>
    </div>
  );
}

function HealthTile({
  icon: Icon,
  label,
  value,
  detail,
  meta,
  tone
}: {
  icon: LucideIcon;
  label: string;
  value: string;
  detail: string;
  meta?: string;
  tone: string;
}) {
  return (
    <article className="health-tile" aria-label={`${label} health`}>
      <div className="health-tile-top">
        <Icon aria-hidden="true" />
        <span className={`status ${tone}`}>{value}</span>
      </div>
      <strong>{label}</strong>
      <small>{detail}</small>
      {meta ? <small className="health-tile-meta">{meta}</small> : null}
    </article>
  );
}

function RuntimeDock(props: RuntimeStatusProps) {
  return (
    <div className="dock-panel runtime-dock">
      <RuntimeStrip {...props} />
    </div>
  );
}

function RuntimeStrip({
  readiness,
  mcp,
  latestSmoke,
  observability,
  workerReadiness,
  storageReadiness
}: RuntimeStatusProps) {
  const dependencies = readiness?.dependencies;
  const latestSmokeCode = latestSmoke?.code;
  return (
    <section className="runtime-strip" aria-label="Runtime status">
      <div className="runtime-item">
        <ServerCog aria-hidden="true" />
        <div>
          <span>Runtime</span>
          <strong>{dependencies ? `${dependencies.runtimeStore} / Temporal ${dependencies.temporal}` : "Loading"}</strong>
        </div>
      </div>
      <div className="runtime-item">
        <ShieldCheck aria-hidden="true" />
        <div>
          <span>MCP Gateway</span>
          <strong>{mcp ? `${mcp.gateway.status} / approval ${mcp.gateway.approvalMode}` : "Loading"}</strong>
        </div>
      </div>
      <div className="runtime-item">
        <Database aria-hidden="true" />
        <div>
          <span>Catalog</span>
          <strong>{mcp ? `${mcp.gateway.serverCount} servers / ${mcp.gateway.toolCount} tools` : "Loading"}</strong>
        </div>
      </div>
      <div className="runtime-item">
        <ServerCog aria-hidden="true" />
        <div>
          <span>Worker</span>
          <strong>
            {workerReadiness
              ? `${workerReadiness.status} / ${workerReadiness.pollerCount} pollers`
              : dependencies?.worker
                ? dependencies.worker
                : "Loading"}
          </strong>
          {workerReadiness ? <code className="raw-code">{workerReadiness.taskQueue}</code> : null}
        </div>
      </div>
      <div className="runtime-item">
        <Activity aria-hidden="true" />
        <div>
          <span>Observability</span>
          <strong>{observability ? `${observability.totals.requestCount} req / p95 ${formatDurationMs(observability.totals.p95Ms)}` : "Loading"}</strong>
        </div>
      </div>
      <div className="runtime-item">
        <HardDrive aria-hidden="true" />
        <div>
          <span>Storage</span>
          <strong>{storageReadiness ? `${storageReadiness.status} / ${formatBytes(storageReadiness.app.availableBytes)} free` : "Loading"}</strong>
          {storageReadiness ? (
            <code className="raw-code">
              root {storageReadiness.root.usedPercent}% / dedicated {storageReadiness.dedicatedAppVolume ? "yes" : "no"}
            </code>
          ) : null}
        </div>
      </div>
      <div className="runtime-item">
        <CircleStop aria-hidden="true" />
        <div>
          <span>Latest MCP Smoke</span>
          <strong>{latestSmokeCode ? readableCode(latestSmokeCode) : "No check yet"}</strong>
          {latestSmokeCode ? (
            <code className="raw-code" title={latestSmokeCode}>
              {latestSmokeCode}
            </code>
          ) : null}
        </div>
      </div>
    </section>
  );
}

function formatDurationMs(value: number | null) {
  if (value === null) return "n/a";
  if (value < 10) return `${value.toFixed(1)}ms`;
  return `${Math.round(value)}ms`;
}

function formatBytes(value: number) {
  if (value >= 1024 * 1024 * 1024) return `${(value / (1024 * 1024 * 1024)).toFixed(1)}GB`;
  if (value >= 1024 * 1024) return `${Math.round(value / (1024 * 1024))}MB`;
  if (value >= 1024) return `${Math.round(value / 1024)}KB`;
  return `${value}B`;
}

function auditMetadataKeys(metadata: AuditEvent["metadata"]) {
  const keys = Object.keys(metadata ?? {});
  return keys.length ? `metadata: ${keys.slice(0, 6).join(", ")}${keys.length > 6 ? ", ..." : ""}` : "metadata: none";
}

function auditTarget(event: AuditEvent) {
  return `${event.targetType}${event.targetId ? ` / ${event.targetId}` : ""}`;
}

function modelCapabilities(model: Model) {
  const capabilities = [
    model.supportsTools ? "tools" : null,
    model.supportsVision ? "vision" : null,
    model.supportsRealtime ? "realtime" : null,
    model.supportsReasoning ? "reasoning" : null
  ].filter(Boolean);
  return capabilities.length ? capabilities.join(", ") : "no verified capabilities";
}

function AuditDock() {
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function loadAudit() {
    setPending(true);
    setError(null);
    try {
      const payload = await api.audit({ pageSize: 20 });
      setEvents(payload.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Audit load failed");
    } finally {
      setPending(false);
    }
  }

  useEffect(() => {
    void loadAudit();
  }, []);

  return (
    <div className="dock-panel event-dock">
      <h2>Audit Trail</h2>
      <section className="event-source" aria-label="Audit status">
        <div>
          <ServerCog aria-hidden="true" />
          <span>
            <strong>Admin audit log</strong>
            <small>Recent operator and system actions from canonical state.</small>
          </span>
        </div>
        <button className="compact-action" onClick={loadAudit} disabled={pending} title="Refresh audit trail" aria-label="Refresh audit trail">
          <RefreshCw aria-hidden="true" />
          <span>{pending ? "Loading" : "Refresh"}</span>
        </button>
      </section>
      <section className="event-feed" aria-label="Audit events">
        {events.length ? (
          events.map((event) => (
            <article key={event.id} className="event-entry">
              <div>
                <strong>{event.action}</strong>
                <time dateTime={event.createdAt}>{new Date(event.createdAt).toLocaleTimeString()}</time>
              </div>
              <small>{auditTarget(event)}</small>
              <code className="raw-code" title={event.traceId}>
                {event.traceId}
              </code>
              <small>{auditMetadataKeys(event.metadata)}</small>
            </article>
          ))
        ) : (
          <div className="empty-mini" role="status">
            No audit events
          </div>
        )}
      </section>
      {error ? (
        <div className="validation-result bad" role="alert">
          <strong>AUDIT_ERROR</strong>
          <small>{error}</small>
        </div>
      ) : null}
    </div>
  );
}

function LaunchReadinessDock(props: BlueprintProgressProps) {
  const { progressItems, completionPct, liveCount } = buildBlueprintProgressState(props);
  const blockers = buildLaunchBlockers(props);
  const activeBlockers = blockers.filter((blocker) => blocker.severity !== "next");
  const hardBlockers = activeBlockers.filter((blocker) => blocker.severity === "hard");
  const launchPct = Math.max(0, Math.round(((progressItems.length - activeBlockers.length) / progressItems.length) * 100));
  const verifiedFoundations = progressItems.filter((item) => item.status === "LIVE").slice(0, 6);
  const launchStatus = activeBlockers.length ? "Production launch gated" : "Production launch clear";
  const [launchReadiness, setLaunchReadiness] = useState<LaunchReadiness | null>(null);
  const [readinessPending, setReadinessPending] = useState(false);
  const [readinessError, setReadinessError] = useState<string | null>(null);

  async function refreshLaunchReadiness() {
    setReadinessPending(true);
    setReadinessError(null);
    try {
      setLaunchReadiness(await api.launchReadiness());
    } catch (err) {
      setReadinessError(err instanceof Error ? err.message : "Launch readiness load failed");
    } finally {
      setReadinessPending(false);
    }
  }

  useEffect(() => {
    void refreshLaunchReadiness();
  }, []);

  const failedGoldenRequirements = launchReadiness?.requirements.filter((item) => item.status !== "PASS") ?? [];
  const shownGoldenRequirements = failedGoldenRequirements.length
    ? failedGoldenRequirements
    : launchReadiness?.requirements.slice(0, 6) ?? [];

  return (
    <div className="dock-panel launch-dock">
      <h2>Launch Readiness</h2>
      <section className="launch-summary" aria-label="Golden E2E readiness">
        <div className="mcp-execution-head">
          <div>
            <strong>Golden E2E readiness</strong>
            <span>{launchReadiness?.summary ?? "Canonical launch report loading from Space state."}</span>
          </div>
          <button
            className="compact-action"
            onClick={refreshLaunchReadiness}
            disabled={readinessPending}
            title="Refresh launch readiness"
            aria-label="Refresh launch readiness"
          >
            <RefreshCw aria-hidden="true" />
            <span>{readinessPending ? "Checking" : "Refresh"}</span>
          </button>
        </div>
        <div className="mcp-metrics">
          <Metric label="Status" value={launchReadiness?.status ?? "Loading"} tone={statusTone(launchReadiness?.status ?? "")} />
          <Metric label="Evidence" value={launchReadiness ? `${launchReadiness.passedCount}/${launchReadiness.totalCount}` : "0/0"} tone="ok" />
          <Metric label="Golden" value={launchReadiness ? `${launchReadiness.completionPct}%` : "0%"} tone={launchReadiness?.status === "READY" ? "ok" : "muted"} />
          <Metric label="Hard" value={String(launchReadiness?.hardBlockerCount ?? 0)} tone={(launchReadiness?.hardBlockerCount ?? 0) ? "bad" : "ok"} />
        </div>
        {readinessError ? (
          <div className="validation-result bad" role="alert">
            <strong>LAUNCH_READINESS_ERROR</strong>
            <small>{readinessError}</small>
          </div>
        ) : null}
        <div className="launch-blockers compact-list" aria-label="Golden E2E requirements">
          {shownGoldenRequirements.length ? (
            shownGoldenRequirements.map((requirement) => (
              <article key={requirement.id} className={`launch-blocker ${requirement.severity === "none" ? "next" : requirement.severity}`}>
                <div>
                  <span className={`status ${requirement.status === "PASS" ? "ok" : launchBlockerTone(requirement.severity === "none" ? "next" : requirement.severity)}`}>
                    {requirement.status}
                  </span>
                  <strong>{requirement.label}</strong>
                </div>
                <small>{requirement.message}</small>
              </article>
            ))
          ) : (
            <div className="empty-mini" role="status">
              Golden readiness loading
            </div>
          )}
        </div>
      </section>
      <section className="launch-summary" aria-label="Launch readiness summary">
        <div className="mcp-execution-head">
          <div>
            <strong>{launchStatus}</strong>
            <span>Live Space state, fail-closed gates and production blockers from current Space endpoints.</span>
          </div>
          <span className={`status ${activeBlockers.length ? "bad" : "ok"}`}>{activeBlockers.length ? "GATED" : "CLEAR"}</span>
        </div>
        <div className="mcp-metrics">
          <Metric label="Internal live" value={`${completionPct}%`} tone="ok" />
          <Metric label="Production gates" value={`${launchPct}%`} tone={activeBlockers.length ? "muted" : "ok"} />
          <Metric label="Live slices" value={`${liveCount}/${progressItems.length}`} tone="ok" />
          <Metric label="Hard blockers" value={String(hardBlockers.length)} tone={hardBlockers.length ? "bad" : "ok"} />
        </div>
      </section>

      <section className="storage-readiness" aria-label="Storage readiness">
        <div className="mcp-execution-head">
          <div>
            <strong>Storage readiness</strong>
            <span>{props.storageReadiness?.statusReason ?? "Storage snapshot loading"}</span>
          </div>
          <span className={`status ${statusTone(props.storageReadiness?.status ?? "")}`}>
            {props.storageReadiness?.status ?? "LOADING"}
          </span>
        </div>
        <div className="mcp-metrics">
          <Metric label="App free" value={formatBytes(props.storageReadiness?.app.availableBytes ?? 0)} tone={props.storageReadiness?.status === "VERIFIED" ? "ok" : "bad"} />
          <Metric label="Root used" value={`${props.storageReadiness?.root.usedPercent ?? 0}%`} tone={(props.storageReadiness?.root.usedPercent ?? 100) < 80 ? "ok" : "bad"} />
          <Metric label="Dedicated" value={props.storageReadiness?.dedicatedAppVolume ? "yes" : "no"} tone={props.storageReadiness?.dedicatedAppVolume ? "ok" : "bad"} />
          <Metric label="Minimum" value={formatBytes(props.storageReadiness?.minimumRecommendedFreeBytes ?? 0)} tone="muted" />
        </div>
      </section>

      <section className="launch-blockers" aria-label="Blocking gates">
        <h3>Blocking Gates</h3>
        {activeBlockers.length ? (
          activeBlockers.map((blocker) => (
            <article key={blocker.label} className={`launch-blocker ${blocker.severity}`}>
              <div>
                <span className={`status ${launchBlockerTone(blocker.severity)}`}>{blocker.severity.toUpperCase()}</span>
                <strong>{blocker.label}</strong>
              </div>
              <small>{blocker.detail}</small>
            </article>
          ))
        ) : (
          <div className="empty-mini" role="status">
            No active production blockers
          </div>
        )}
      </section>

      <section className="launch-foundations" aria-label="Verified foundations">
        <h3>Verified Foundations</h3>
        {verifiedFoundations.map((item) => (
          <article key={item.label} className="launch-foundation">
            <div>
              <CheckCircle2 aria-hidden="true" />
              <strong>{item.label}</strong>
            </div>
            <small>{item.detail}</small>
          </article>
        ))}
      </section>
    </div>
  );
}

function ObservabilityDock({
  snapshot,
  workerReadiness,
  onRefresh,
  onWorkerRefresh
}: {
  snapshot: ObservabilitySnapshot | null;
  workerReadiness: WorkerReadiness | null;
  onRefresh: (snapshot: ObservabilitySnapshot) => void;
  onWorkerRefresh: (readiness: WorkerReadiness) => void;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function refreshSnapshot() {
    setPending(true);
    setError(null);
    try {
      onRefresh(await api.observability());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Observability refresh failed");
    } finally {
      setPending(false);
    }
  }

  async function refreshWorker() {
    setPending(true);
    setError(null);
    try {
      onWorkerRefresh(await api.worker());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Worker readiness refresh failed");
    } finally {
      setPending(false);
    }
  }

  const endpoints = snapshot?.endpoints.slice(0, 8) ?? [];

  return (
    <div className="dock-panel observability-dock">
      <h2>Observability</h2>
      <section className="observability-status" aria-label="Observability status">
        <div className="mcp-execution-head">
          <div>
            <strong>Prometheus metrics live</strong>
            <span>{snapshot ? `Generated ${new Date(snapshot.generatedAt).toLocaleTimeString()}` : "Snapshot loading"}</span>
          </div>
          <button className="compact-action" onClick={refreshSnapshot} disabled={pending} title="Refresh observability" aria-label="Refresh observability">
            <RefreshCw aria-hidden="true" />
            <span>{pending ? "Refreshing" : "Refresh"}</span>
          </button>
        </div>
        <div className="mcp-metrics">
          <Metric label="Requests" value={String(snapshot?.totals.requestCount ?? 0)} tone="ok" />
          <Metric label="Errors" value={String(snapshot?.totals.errorCount ?? 0)} tone={(snapshot?.totals.errorCount ?? 0) > 0 ? "bad" : "ok"} />
          <Metric label="p95" value={formatDurationMs(snapshot?.totals.p95Ms ?? null)} tone="muted" />
          <Metric label="Uptime" value={`${snapshot?.runtime.uptimeSeconds ?? 0}s`} tone="muted" />
        </div>
        <div className="validation-result" role="status" aria-live="polite">
          <div>
            <span className="status ok">LIVE</span>
            <strong>/metrics scrape target</strong>
            <code className="raw-code">space_http_requests_total</code>
          </div>
          <small>No cookies, headers, request bodies, user ids or raw URLs are exported in metric labels.</small>
        </div>
      </section>
      <section className="observability-runtime" aria-label="Process runtime">
        <div className="mcp-metrics">
          <Metric label="RSS" value={formatBytes(snapshot?.runtime.memory.rssBytes ?? 0)} tone="muted" />
          <Metric label="Heap" value={formatBytes(snapshot?.runtime.memory.heapUsedBytes ?? 0)} tone="muted" />
          <Metric label="Node" value={snapshot?.runtime.nodeVersion ?? "loading"} tone="muted" />
          <Metric label="PID" value={String(snapshot?.runtime.pid ?? "-")} tone="muted" />
        </div>
      </section>
      <section className="observability-worker" aria-label="Temporal worker readiness">
        <div className="mcp-execution-head">
          <div>
            <strong>Temporal worker readiness</strong>
            <span>{workerReadiness?.statusReason ?? "Worker snapshot loading"}</span>
          </div>
          <button className="compact-action" onClick={refreshWorker} disabled={pending} title="Refresh worker readiness" aria-label="Refresh worker readiness">
            <RefreshCw aria-hidden="true" />
            <span>{pending ? "Checking" : "Worker"}</span>
          </button>
        </div>
        <div className="mcp-metrics">
          <Metric label="Status" value={workerReadiness?.status ?? "Loading"} tone={statusTone(workerReadiness?.status ?? "")} />
          <Metric label="Workflow" value={String(workerReadiness?.workflowPollerCount ?? 0)} tone={(workerReadiness?.workflowPollerCount ?? 0) > 0 ? "ok" : "bad"} />
          <Metric label="Activity" value={String(workerReadiness?.activityPollerCount ?? 0)} tone={(workerReadiness?.activityPollerCount ?? 0) > 0 ? "ok" : "bad"} />
          <Metric label="Queue" value={workerReadiness?.taskQueue ?? "loading"} tone="muted" />
        </div>
        <div className="validation-result" role="status" aria-live="polite">
          <div>
            <span className={`status ${statusTone(workerReadiness?.status ?? "")}`}>{workerReadiness?.status ?? "LOADING"}</span>
            <strong>{workerReadiness ? `${workerReadiness.address} / ${workerReadiness.namespace}` : "Temporal target loading"}</strong>
          </div>
          <small>
            {workerReadiness?.pollerIdentities.length
              ? workerReadiness.pollerIdentities.join(", ")
              : "No poller identity is currently visible for this task queue."}
          </small>
        </div>
      </section>
      <section className="observability-endpoints" aria-label="Endpoint metrics">
        <h3>Endpoint RED</h3>
        {endpoints.length ? (
          endpoints.map((endpoint) => (
            <article key={`${endpoint.method}:${endpoint.route}:${endpoint.statusClass}`} className="observability-row">
              <div>
                <span className={`status ${statusTone(endpoint.statusClass === "5xx" ? "ERROR" : "VERIFIED")}`}>{endpoint.statusClass}</span>
                <strong>
                  {endpoint.method} {endpoint.route}
                </strong>
              </div>
              <small>
                {endpoint.requestCount} requests / {endpoint.errorCount} errors / p95 {formatDurationMs(endpoint.durationMs.p95)}
              </small>
            </article>
          ))
        ) : (
          <div className="empty-mini" role="status">
            No endpoint samples yet
          </div>
        )}
      </section>
      {error ? (
        <div className="validation-result bad" role="alert">
          <strong>OBSERVABILITY_ERROR</strong>
          <small>{error}</small>
        </div>
      ) : null}
    </div>
  );
}

function ToolsDock({
  models,
  mcp,
  latestSmoke,
  codexAppServer,
  latestCodexHandshake,
  latestCodexTurnSmoke,
  onMcpSmoke,
  onMcpRefresh,
  onCodexHandshake,
  onCodexTurnSmoke
}: {
  models: Model[];
  mcp: McpPayload | null;
  latestSmoke: McpDiscoverySmokeCheck | null;
  codexAppServer: CodexAppServerStatus | null;
  latestCodexHandshake: CodexAppServerHandshakeCheck | null;
  latestCodexTurnSmoke: CodexAppServerTurnSmokeCheck | null;
  onMcpSmoke: (smoke: McpDiscoverySmokeCheck) => void;
  onMcpRefresh: (mcp: McpPayload) => void;
  onCodexHandshake: (check: CodexAppServerHandshakeCheck) => void;
  onCodexTurnSmoke: (check: CodexAppServerTurnSmokeCheck) => void;
}) {
  const [codexHandshakePending, setCodexHandshakePending] = useState(false);
  const [codexTurnSmokePending, setCodexTurnSmokePending] = useState(false);
  const [codexError, setCodexError] = useState<string | null>(null);
  const [mcpPending, setMcpPending] = useState(false);
  const [mcpError, setMcpError] = useState<string | null>(null);
  const [mcpExecutionPendingToolId, setMcpExecutionPendingToolId] = useState<string | null>(null);
  const [mcpExecutionError, setMcpExecutionError] = useState<string | null>(null);
  const [mcpExecutionResult, setMcpExecutionResult] = useState<McpToolExecutionResult | null>(null);
  const [mcpApprovalReason, setMcpApprovalReason] = useState("Operator approved safe read-only smoke.");
  const latestSmokeCode = latestSmoke?.code ?? "MCP_DISCOVERY_NOT_RUN";
  const latestCodexHandshakeCode = latestCodexHandshake?.code ?? "CODEX_HANDSHAKE_NOT_RUN";
  const latestCodexTurnSmokeCode = latestCodexTurnSmoke?.code ?? "CODEX_TURN_SMOKE_NOT_RUN";
  const verifiedModelCount = models.filter((model) => model.status === "VERIFIED").length;

  async function runMcpSmoke() {
    setMcpPending(true);
    setMcpError(null);
    try {
      const smoke = await api.runMcpDiscoverySmoke();
      const refreshed = await api.mcp();
      onMcpSmoke(smoke);
      onMcpRefresh(refreshed);
    } catch (err) {
      setMcpError(err instanceof Error ? err.message : "MCP discovery smoke failed");
    } finally {
      setMcpPending(false);
    }
  }

  async function runCodexHandshake() {
    setCodexHandshakePending(true);
    setCodexError(null);
    try {
      const check = await api.runCodexAppServerHandshake();
      onCodexHandshake(check);
    } catch (err) {
      setCodexError(err instanceof Error ? err.message : "Codex App Server handshake failed");
    } finally {
      setCodexHandshakePending(false);
    }
  }

  async function runCodexTurnSmoke() {
    setCodexTurnSmokePending(true);
    setCodexError(null);
    try {
      const check = await api.runCodexAppServerTurnSmoke();
      onCodexTurnSmoke(check);
    } catch (err) {
      setCodexError(err instanceof Error ? err.message : "Codex App Server turn smoke failed");
    } finally {
      setCodexTurnSmokePending(false);
    }
  }

  async function runMcpExecution(toolId: string) {
    setMcpExecutionPendingToolId(toolId);
    setMcpExecutionError(null);
    try {
      const approvalReason = mcpApprovalReason.trim();
      const result = await api.executeMcpTool({
        toolId,
        arguments: {},
        approvalReason: approvalReason.length ? approvalReason : undefined
      });
      setMcpExecutionResult(result);
    } catch (err) {
      setMcpExecutionError(err instanceof Error ? err.message : "MCP execution gate failed");
    } finally {
      setMcpExecutionPendingToolId(null);
    }
  }

  return (
    <div className="dock-panel">
      <h2>Tools</h2>
      <section className="model-registry" aria-label="Model registry">
        <div className="mcp-execution-head">
          <div>
            <strong>Model Registry</strong>
            <span>Provider-owned models stay empty or disabled until real credential smoke and model refresh pass.</span>
          </div>
          <span className={`status ${verifiedModelCount > 0 ? "ok" : "muted"}`}>{verifiedModelCount} verified</span>
        </div>
        <div className="mcp-metrics">
          <Metric label="Catalog" value={`${models.length} models`} tone={models.length ? "ok" : "muted"} />
          <Metric label="Verified" value={String(verifiedModelCount)} tone={verifiedModelCount ? "ok" : "muted"} />
        </div>
        {models.length ? (
          <div className="model-list">
            {models.map((model) => (
              <article key={model.id} className="model-row">
                <div>
                  <span className={`status ${statusTone(model.status)}`}>{model.status}</span>
                  <strong>{model.displayName}</strong>
                </div>
                <small>{model.providerId}</small>
                <small>
                  {model.contextWindow ? `${model.contextWindow.toLocaleString()} ctx` : "context n/a"} / {modelCapabilities(model)}
                </small>
              </article>
            ))}
          </div>
        ) : (
          <div className="empty-mini" role="status">
            No models loaded until a provider credential smoke passes.
          </div>
        )}
      </section>
      <section className="mcp-panel" aria-label="Codex App Server">
        <div className="mcp-panel-header">
          <div>
            <strong>Codex App Server</strong>
            <span>{codexAppServer?.statusReason ?? "Loading adapter status"}</span>
          </div>
          <span className={`status ${statusTone(codexAppServer?.status ?? "")}`}>{codexAppServer?.status ?? "LOADING"}</span>
        </div>
        <div className="mcp-metrics">
          <Metric label="Reason" value={codexAppServer?.reasonCode ?? "Loading"} tone={statusTone(codexAppServer?.status ?? "")} />
          <Metric label="Transport" value={codexAppServer?.transport ?? "Loading"} tone="muted" />
          <Metric label="Schemas" value={codexAppServer?.schemasGenerated ? "generated" : "missing"} tone={codexAppServer?.schemasGenerated ? "ok" : "muted"} />
          <Metric label="Socket" value={codexAppServer?.socketPath ? "unix" : "none"} tone="muted" />
        </div>
        <div className="mcp-execution-plane" aria-label="Codex App Server smoke gates">
          <div className="mcp-execution-head">
            <div>
              <strong>Adapter smoke gates</strong>
              <span>No Codex process is spawned unless this adapter is explicitly enabled and verified.</span>
            </div>
          </div>
          <button
            className="compact-action"
            onClick={runCodexHandshake}
            disabled={codexHandshakePending}
            title="Run Codex App Server handshake"
            aria-label="Run Codex App Server handshake"
          >
            <ShieldCheck aria-hidden="true" />
            <span>{codexHandshakePending ? "Checking" : "Handshake"}</span>
          </button>
          <button
            className="compact-action"
            onClick={runCodexTurnSmoke}
            disabled={codexTurnSmokePending}
            title="Run Codex App Server turn smoke"
            aria-label="Run Codex App Server turn smoke"
          >
            <CheckCircle2 aria-hidden="true" />
            <span>{codexTurnSmokePending ? "Checking" : "Turn smoke"}</span>
          </button>
        </div>
        <div className="validation-result" role="status" aria-live="polite">
          <div>
            <span className={`status ${statusTone(latestCodexHandshake?.status ?? "")}`}>{latestCodexHandshake?.status ?? "NO_CHECK"}</span>
            <strong>{latestCodexHandshakeCode}</strong>
            <code className="raw-code" title={latestCodexHandshake?.checkId ?? latestCodexHandshakeCode}>
              {latestCodexHandshake?.checkId ?? latestCodexHandshakeCode}
            </code>
          </div>
          <small>{latestCodexHandshake?.message ?? "Handshake smoke has not run in this view yet."}</small>
        </div>
        <div className="validation-result" role="status" aria-live="polite">
          <div>
            <span className={`status ${statusTone(latestCodexTurnSmoke?.status ?? "")}`}>{latestCodexTurnSmoke?.status ?? "NO_CHECK"}</span>
            <strong>{latestCodexTurnSmokeCode}</strong>
            <code className="raw-code" title={latestCodexTurnSmoke?.checkId ?? latestCodexTurnSmokeCode}>
              {latestCodexTurnSmoke?.checkId ?? latestCodexTurnSmokeCode}
            </code>
          </div>
          <small>{latestCodexTurnSmoke?.message ?? "Real turn smoke remains gated until the shared Codex App Server adapter is enabled."}</small>
        </div>
        {codexError ? (
          <div className="validation-result bad" role="alert">
            <strong>CODEX_APP_SERVER_ERROR</strong>
            <small>{codexError}</small>
          </div>
        ) : null}
      </section>
      <section className="mcp-panel" aria-label="MCP gateway">
        <div className="mcp-panel-header">
          <div>
            <strong>Space MCP Gateway</strong>
            <span>{mcp?.gateway.statusReason ?? "Loading gateway status"}</span>
          </div>
          <button
            className="compact-action"
            onClick={runMcpSmoke}
            disabled={mcpPending}
            title="Run MCP discovery smoke"
            aria-label="Run MCP discovery smoke"
          >
            <RefreshCw aria-hidden="true" />
            <span>{mcpPending ? "Checking" : "Smoke"}</span>
          </button>
        </div>
        <div className="mcp-metrics">
          <Metric label="Gateway" value={mcp?.gateway.status ?? "Loading"} tone={statusTone(mcp?.gateway.status ?? "")} />
          <Metric label="Approval" value={mcp?.gateway.approvalMode ?? "Loading"} tone="muted" />
          <Metric label="Servers" value={String(mcp?.gateway.serverCount ?? 0)} tone="muted" />
          <Metric label="Tools" value={String(mcp?.gateway.toolCount ?? 0)} tone="muted" />
        </div>
        <div className="mcp-execution-plane" aria-label="MCP execution gate">
          <div className="mcp-execution-head">
            <div>
              <strong>Execution gate</strong>
              <span>{mcpExecutionResult ? readableCode(mcpExecutionResult.code) : "No execution check in this view yet"}</span>
            </div>
            <button
              className="compact-action"
              onClick={() => runMcpExecution("mcp-gateway:execution-gate-smoke")}
              disabled={mcpExecutionPendingToolId !== null}
              title="Check MCP execution gate"
              aria-label="Check MCP execution gate"
            >
              <CheckCircle2 aria-hidden="true" />
              <span>{mcpExecutionPendingToolId === "mcp-gateway:execution-gate-smoke" ? "Checking" : "Gate"}</span>
            </button>
          </div>
          <label className="field-label" htmlFor="mcp-approval-reason">
            Approval reason
          </label>
          <input
            id="mcp-approval-reason"
            value={mcpApprovalReason}
            onChange={(event) => setMcpApprovalReason(event.target.value)}
            aria-label="MCP approval reason"
          />
          {mcpExecutionResult ? (
            <div className="validation-result" role="status" aria-live="polite">
              <div>
                <span className={`status ${statusTone(mcpExecutionResult.status)}`}>{mcpExecutionResult.status}</span>
                <strong>{readableCode(mcpExecutionResult.code)}</strong>
                <code className="raw-code" title={mcpExecutionResult.executionId}>
                  {mcpExecutionResult.executionId}
                </code>
              </div>
              <small>
                {mcpExecutionResult.message}
                {mcpExecutionResult.artifact ? ` Artifact ${mcpExecutionResult.artifact.id}` : ""}
              </small>
            </div>
          ) : null}
          {mcpExecutionError ? (
            <div className="validation-result bad" role="alert">
              <strong>MCP_EXECUTION_ERROR</strong>
              <small>{mcpExecutionError}</small>
            </div>
          ) : null}
        </div>
        <div className="validation-result" role="status" aria-live="polite">
          <div>
            <span className={`status ${statusTone(latestSmoke?.status ?? "")}`}>{latestSmoke?.status ?? "NO_CHECK"}</span>
            <strong>{readableCode(latestSmokeCode)}</strong>
            <code className="raw-code" title={latestSmokeCode}>
              {latestSmokeCode}
            </code>
          </div>
          <small>{latestSmoke?.message ?? "Live config has not produced a discovery smoke result in this session."}</small>
        </div>
        {mcp?.servers.map((server) => (
          <div key={server.id} className="dock-row mcp-row">
            <span>{server.displayName}</span>
            <span className={`status ${statusTone(server.status)}`}>{server.status}</span>
          </div>
        ))}
        {mcp?.tools.length ? (
          <div className="tool-list">
            {mcp.tools.map((tool) => (
              <div key={tool.id} className="tool-row">
                <strong>{tool.name}</strong>
                <span>{tool.riskLevel}</span>
                <span>{tool.approvalRequired ? "approval" : "allowlisted"}</span>
                <button
                  className="icon-action"
                  onClick={() => runMcpExecution(tool.id)}
                  disabled={mcpExecutionPendingToolId !== null}
                  title={`Execute ${tool.name}`}
                  aria-label={`Execute ${tool.name}`}
                >
                  <CheckCircle2 aria-hidden="true" />
                </button>
              </div>
            ))}
          </div>
        ) : null}
        {mcpError ? (
          <div className="validation-result bad" role="alert">
            <strong>MCP_SMOKE_ERROR</strong>
            <small>{mcpError}</small>
          </div>
        ) : null}
      </section>
    </div>
  );
}

function MemoryDock({
  activeRoom,
  latestSmoke,
  vectorReadiness,
  onSmoke
}: {
  activeRoom: Room | null;
  latestSmoke: MemoryEmbeddingSmokeCheck | null;
  vectorReadiness: MemoryVectorReadiness | null;
  onSmoke: (smoke: MemoryEmbeddingSmokeCheck) => void;
}) {
  const [entries, setEntries] = useState<MemoryEntry[]>([]);
  const [embeddingSmoke, setEmbeddingSmoke] = useState<MemoryEmbeddingSmokeCheck | null>(latestSmoke);
  const [query, setQuery] = useState("");
  const [searchMode, setSearchMode] = useState<MemorySearchMode>("keyword");
  const [searchStatus, setSearchStatus] = useState<MemorySearchStatus | null>(null);
  const [scope, setScope] = useState<MemoryEntry["scope"]>("ROOM");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [provenance, setProvenance] = useState("operator");
  const [pending, setPending] = useState(false);
  const [smokePending, setSmokePending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setEmbeddingSmoke(latestSmoke);
  }, [latestSmoke]);

  async function loadMemory(nextQuery = query, nextMode = searchMode) {
    setError(null);
    if (scope === "ROOM" && !activeRoom) {
      setEntries([]);
      setSearchStatus(fallbackMemorySearchStatus(nextMode));
      return;
    }
    try {
      const payload = await api.memory({
        roomId: scope === "ROOM" ? activeRoom?.id ?? undefined : undefined,
        q: nextQuery || undefined,
        scope,
        searchMode: nextMode
      });
      setEntries(payload.data);
      setSearchStatus(payload.search);
    } catch (err) {
      setEntries([]);
      setSearchStatus(fallbackMemorySearchStatus(nextMode));
      setError(err instanceof Error ? err.message : "Memory load failed");
    }
  }

  useEffect(() => {
    void loadMemory();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeRoom?.id, scope, searchMode]);

  async function saveMemory() {
    setPending(true);
    setError(null);
    try {
      const saved = await api.createMemory({
        scope,
        roomId: scope === "ROOM" ? activeRoom?.id ?? null : null,
        title,
        body,
        provenance
      });
      setEntries((current) => [saved, ...current.filter((entry) => entry.id !== saved.id)]);
      setTitle("");
      setBody("");
      setProvenance("operator");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Memory save failed");
    } finally {
      setPending(false);
    }
  }

  async function runEmbeddingSmoke() {
    setSmokePending(true);
    setError(null);
    try {
      const smoke = await api.runMemoryEmbeddingSmoke();
      setEmbeddingSmoke(smoke);
      onSmoke(smoke);
      await loadMemory();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Embedding smoke failed");
    } finally {
      setSmokePending(false);
    }
  }

  const currentSearchStatus = searchStatus ?? fallbackMemorySearchStatus(searchMode);
  const semanticEmbeddingsReady = currentSearchStatus.semantic.status === "VERIFIED";
  const embeddingSmokeCode = embeddingSmoke?.code ?? "EMBEDDING_SMOKE_NOT_RUN";
  const embeddingRemediation = embeddingSmokeRemediation(embeddingSmoke);

  return (
    <div className="dock-panel memory-dock">
      <h2>Memory</h2>
      <section className="memory-search-plane" aria-label="Memory search status">
        <div>
          <Search aria-hidden="true" />
          <span>
            <strong>Keyword search active</strong>
            <small>{currentSearchStatus.keyword.statusReason}</small>
          </span>
          <em className={`status ${statusTone(currentSearchStatus.keyword.status)}`}>
            {currentSearchStatus.keyword.status}
          </em>
        </div>
        <div>
          <Database aria-hidden="true" />
          <span>
            <strong>{semanticEmbeddingsReady ? "Semantic embeddings active" : "Semantic embeddings disabled"}</strong>
            <small>{currentSearchStatus.semantic.statusReason}</small>
          </span>
          <em className={`status ${statusTone(currentSearchStatus.semantic.status)}`}>
            {currentSearchStatus.semantic.status}
          </em>
        </div>
      </section>
      <section className="embedding-smoke-panel" aria-label="Memory vector readiness">
        <div className="mcp-execution-head">
          <div>
            <strong>Vector readiness</strong>
            <span>{vectorReadiness ? readableCode(vectorReadiness.code) : "Vector readiness pending"}</span>
          </div>
          <em className={`status ${statusTone(vectorReadiness?.status ?? "")}`}>
            {vectorReadiness?.status ?? "PENDING"}
          </em>
        </div>
        <div className="mcp-metrics">
          <Metric label="pgvector" value={vectorReadiness?.extensionVersion ?? "none"} tone={vectorReadiness?.extensionInstalled ? "ok" : "muted"} />
          <Metric label="Column" value={vectorReadiness?.embeddingColumnReady ? "ready" : "missing"} tone={vectorReadiness?.embeddingColumnReady ? "ok" : "muted"} />
          <Metric label="Index" value={vectorReadiness?.vectorIndexReady ? "HNSW" : "missing"} tone={vectorReadiness?.vectorIndexReady ? "ok" : "muted"} />
          <Metric
            label="Dims"
            value={`${vectorReadiness?.embeddingDimensions ?? "?"}/${vectorReadiness?.expectedDimensions ?? 1536}`}
            tone={vectorReadiness?.embeddingDimensions === vectorReadiness?.expectedDimensions ? "ok" : "muted"}
          />
        </div>
        <div className="validation-result" role="status" aria-live="polite">
          <div>
            <span className={`status ${statusTone(vectorReadiness?.status ?? "")}`}>{vectorReadiness?.status ?? "PENDING"}</span>
            <strong>{vectorReadiness ? readableCode(vectorReadiness.code) : "Vector Readiness Pending"}</strong>
            <code className="raw-code" title={vectorReadiness?.code ?? "VECTOR_READINESS_PENDING"}>
              {vectorReadiness?.code ?? "VECTOR_READINESS_PENDING"}
            </code>
          </div>
          <small>{vectorReadiness?.message ?? "Vector storage readiness has not been checked yet."}</small>
        </div>
      </section>
      <section className="embedding-smoke-panel" aria-label="Memory embedding smoke">
        <div className="mcp-execution-head">
          <div>
            <strong>Embedding smoke gate</strong>
            <span>{embeddingSmoke ? readableCode(embeddingSmoke.code) : "No embedding smoke check yet"}</span>
          </div>
          <button
            className="compact-action"
            onClick={runEmbeddingSmoke}
            disabled={smokePending}
            title="Run embedding smoke"
            aria-label="Run embedding smoke"
          >
            <RefreshCw aria-hidden="true" />
            <span>{smokePending ? "Checking" : "Smoke"}</span>
          </button>
        </div>
        <div className="mcp-metrics">
          <Metric label="Smoke" value={embeddingSmoke?.status ?? "NO_CHECK"} tone={statusTone(embeddingSmoke?.status ?? "")} />
          <Metric
            label="Provider smoke"
            value={embeddingSmoke?.embeddingProviderReady ? "passed" : "gated"}
            tone={embeddingSmoke?.embeddingProviderReady ? "ok" : "muted"}
          />
          <Metric label="Provider" value={embeddingSmoke?.provider ?? "none"} tone="muted" />
          <Metric label="Model" value={embeddingSmoke?.model ?? "none"} tone="muted" />
          <Metric label="Dims" value={String(embeddingSmoke?.dimensions ?? 1536)} tone="muted" />
        </div>
        <div className="validation-result" role="status" aria-live="polite">
          <div>
            <span className={`status ${statusTone(embeddingSmoke?.status ?? "")}`}>{embeddingSmoke?.status ?? "NO_CHECK"}</span>
            <strong>{readableCode(embeddingSmokeCode)}</strong>
            <code className="raw-code" title={embeddingSmokeCode}>
              {embeddingSmokeCode}
            </code>
          </div>
          <small>{embeddingSmoke?.message ?? "Semantic memory stays disabled until pgvector and an embedding provider pass smoke."}</small>
          <small>OpenAI or Codex-LB provider smoke is available after dedicated key configuration.</small>
          {embeddingRemediation ? <small>{embeddingRemediation}</small> : null}
          {embeddingSmoke?.checkId ? <small>{embeddingSmoke.checkId}</small> : null}
        </div>
      </section>
      <section className="memory-controls" aria-label="Memory search">
        <div className="search-mode-toggle" role="group" aria-label="Memory search mode">
          <button
            className={searchMode === "keyword" ? "selected" : ""}
            type="button"
            aria-pressed={searchMode === "keyword"}
            onClick={() => setSearchMode("keyword")}
          >
            Keyword
          </button>
          <button
            className={searchMode === "semantic" ? "selected" : ""}
            type="button"
            aria-pressed={searchMode === "semantic"}
            onClick={() => setSearchMode("semantic")}
          >
            Semantic
          </button>
        </div>
        <div className="inline-field">
          <input
            aria-label="Search memory"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search memory"
          />
          <button className="compact-action" onClick={() => loadMemory()} title="Search memory" aria-label="Search memory">
            <RefreshCw aria-hidden="true" />
            <span>Search</span>
          </button>
        </div>
      </section>
      <section className="memory-form" aria-label="Save memory">
        <div className="inline-field">
          <select aria-label="Memory scope" value={scope} onChange={(event) => setScope(event.target.value as MemoryEntry["scope"])}>
            <option value="ROOM">Room</option>
            <option value="PROJECT">Project</option>
            <option value="SYSTEM">System</option>
          </select>
          <input
            aria-label="Memory provenance"
            value={provenance}
            onChange={(event) => setProvenance(event.target.value)}
            placeholder="Provenance"
          />
        </div>
        <input aria-label="Memory title" value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Title" />
        <textarea aria-label="Memory body" value={body} onChange={(event) => setBody(event.target.value)} placeholder="Body" rows={4} />
        <button
          className="compact-action primary-action"
          onClick={saveMemory}
          disabled={pending || !title.trim() || !body.trim() || !provenance.trim() || (scope === "ROOM" && !activeRoom)}
          title="Save memory"
          aria-label="Save memory"
        >
          <Plus aria-hidden="true" />
          <span>{pending ? "Saving" : "Save"}</span>
        </button>
      </section>
      {error ? (
        <div className="validation-result bad" role="alert">
          <strong>MEMORY_ERROR</strong>
          <small>{error}</small>
        </div>
      ) : null}
      <section className="memory-list" aria-label="Memory entries">
        {entries.length ? (
          entries.map((entry) => (
            <article key={entry.id} className="memory-entry">
              <div>
                <span className="status muted">{entry.scope}</span>
                <strong>{entry.title}</strong>
              </div>
              <p>{entry.body}</p>
              <small>{entry.provenance}</small>
            </article>
          ))
        ) : (
          <div className="empty-mini" role="status">
            No memory entries
          </div>
        )}
      </section>
    </div>
  );
}

function parseEvidenceIds(value: string): string[] {
  return Array.from(
    new Set(
      value
        .split(/[\s,]+/)
        .map((item) => item.trim())
        .filter(Boolean)
    )
  );
}

function appendEvidenceId(value: string, artifactId: string): string {
  return [...parseEvidenceIds(value), artifactId].filter((item, index, items) => items.indexOf(item) === index).join("\n");
}

function parseArtifactMetadata(value: string): Record<string, string> {
  return Object.fromEntries(
    value
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const separator = line.indexOf("=");
        if (separator === -1) return [line.slice(0, 120), "true"];
        return [line.slice(0, separator).trim().slice(0, 120), line.slice(separator + 1).trim()];
      })
      .filter(([key]) => Boolean(key))
  );
}

const artifactKinds: Artifact["kind"][] = [
  "SCREENSHOT",
  "DOM_SNAPSHOT",
  "CONSOLE_LOG",
  "NETWORK_LOG",
  "TRACE",
  "VIDEO",
  "PATCH",
  "TRANSCRIPT",
  "EXPORT"
];

const browserEvidenceViewports: BrowserEvidenceViewport[] = ["mobile", "tablet", "desktop", "wide", "ultrawide"];

function decisionTone(decision: ReviewDecision["decision"]) {
  if (decision === "SHIP") return "ok";
  if (decision === "BLOCK") return "bad";
  return "muted";
}

const reviewCheckStatuses: ReviewCheck["status"][] = ["PASS", "WARN", "FAIL", "SKIPPED", "RUNNING"];
const reviewDiffStatuses: ReviewDiffSummary["status"][] = ["MODIFIED", "ADDED", "DELETED", "RENAMED"];

function reviewCheckTone(status: ReviewCheck["status"]) {
  if (status === "PASS") return "ok";
  if (status === "FAIL") return "bad";
  return "muted";
}

function reviewGateTone(status: ReviewRoomState["gateStatus"]) {
  if (status === "PASS") return "ok";
  if (status === "FAIL") return "bad";
  return "muted";
}

function ReviewDock({ activeRoom }: { activeRoom: Room | null }) {
  const [decisions, setDecisions] = useState<ReviewDecision[]>([]);
  const [checks, setChecks] = useState<ReviewCheck[]>([]);
  const [diffs, setDiffs] = useState<ReviewDiffSummary[]>([]);
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [gateStatus, setGateStatus] = useState<ReviewRoomState["gateStatus"]>("EMPTY");
  const [gateReason, setGateReason] = useState("No review checks have been recorded for this room.");
  const [decision, setDecision] = useState<ReviewDecision["decision"]>("BLOCK");
  const [summary, setSummary] = useState("");
  const [rollbackNote, setRollbackNote] = useState("");
  const [evidenceIds, setEvidenceIds] = useState("");
  const [checkName, setCheckName] = useState("npm test");
  const [checkStatus, setCheckStatus] = useState<ReviewCheck["status"]>("PASS");
  const [checkCommand, setCheckCommand] = useState("npm test");
  const [checkSummary, setCheckSummary] = useState("");
  const [checkArtifactIds, setCheckArtifactIds] = useState("");
  const [checkMetadata, setCheckMetadata] = useState("source=operator");
  const [diffTitle, setDiffTitle] = useState("");
  const [diffFilePath, setDiffFilePath] = useState("");
  const [diffStatus, setDiffStatus] = useState<ReviewDiffSummary["status"]>("MODIFIED");
  const [diffAdditions, setDiffAdditions] = useState("0");
  const [diffDeletions, setDiffDeletions] = useState("0");
  const [diffPatchArtifactId, setDiffPatchArtifactId] = useState("");
  const [diffSummary, setDiffSummary] = useState("");
  const [artifactKind, setArtifactKind] = useState<Artifact["kind"]>("SCREENSHOT");
  const [artifactMimeType, setArtifactMimeType] = useState("image/png");
  const [artifactStorageUri, setArtifactStorageUri] = useState("");
  const [artifactSha256, setArtifactSha256] = useState("");
  const [artifactByteSize, setArtifactByteSize] = useState("0");
  const [artifactMetadata, setArtifactMetadata] = useState("source=operator");
  const [browserViewport, setBrowserViewport] = useState<BrowserEvidenceViewport>("desktop");
  const [pending, setPending] = useState(false);
  const [artifactPending, setArtifactPending] = useState(false);
  const [checkPending, setCheckPending] = useState(false);
  const [diffPending, setDiffPending] = useState(false);
  const [browserEvidencePending, setBrowserEvidencePending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function loadReviewState() {
    setError(null);
    if (!activeRoom) {
      setDecisions([]);
      setChecks([]);
      setDiffs([]);
      setArtifacts([]);
      setGateStatus("EMPTY");
      setGateReason("No room selected.");
      return;
    }
    try {
      const state = await api.reviewState({ roomId: activeRoom.id });
      setDecisions(state.decisions);
      setChecks(state.checks);
      setDiffs(state.diffs);
      setArtifacts(state.artifacts);
      setGateStatus(state.gateStatus);
      setGateReason(state.statusReason);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Review load failed");
    }
  }

  useEffect(() => {
    void loadReviewState();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeRoom?.id]);

  async function saveArtifact() {
    if (!activeRoom) return;
    setArtifactPending(true);
    setError(null);
    try {
      const saved = await api.createArtifact({
        roomId: activeRoom.id,
        kind: artifactKind,
        mimeType: artifactMimeType,
        storageUri: artifactStorageUri,
        sha256: artifactSha256,
        byteSize: Number(artifactByteSize || 0),
        metadata: parseArtifactMetadata(artifactMetadata)
      });
      setArtifacts((current) => [saved, ...current.filter((item) => item.id !== saved.id)]);
      setEvidenceIds((current) => appendEvidenceId(current, saved.id));
      setArtifactStorageUri("");
      setArtifactSha256("");
      setArtifactByteSize("0");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Artifact registration failed");
    } finally {
      setArtifactPending(false);
    }
  }

  async function captureBrowserEvidence() {
    if (!activeRoom) return;
    setBrowserEvidencePending(true);
    setError(null);
    try {
      const capture = await api.captureBrowserEvidence({
        roomId: activeRoom.id,
        viewport: browserViewport
      });
      setArtifacts((current) => [
        ...capture.artifacts,
        ...current.filter((item) => !capture.artifacts.some((artifact) => artifact.id === item.id))
      ]);
      setEvidenceIds((current) => capture.artifacts.reduce((value, artifact) => appendEvidenceId(value, artifact.id), current));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Browser evidence capture failed");
    } finally {
      setBrowserEvidencePending(false);
    }
  }

  async function saveReview() {
    if (!activeRoom) return;
    setPending(true);
    setError(null);
    try {
      const saved = await api.createReview({
        roomId: activeRoom.id,
        decision,
        summary,
        rollbackNote,
        evidenceArtifactIds: parseEvidenceIds(evidenceIds)
      });
      setDecisions((current) => [saved, ...current.filter((item) => item.id !== saved.id)]);
      setSummary("");
      setRollbackNote("");
      setEvidenceIds("");
      await loadReviewState();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Review decision failed");
    } finally {
      setPending(false);
    }
  }

  async function saveCheck() {
    if (!activeRoom) return;
    setCheckPending(true);
    setError(null);
    try {
      const saved = await api.createReviewCheck({
        roomId: activeRoom.id,
        reviewDecisionId: decisions[0]?.id ?? null,
        name: checkName,
        status: checkStatus,
        command: checkCommand.trim() || null,
        summary: checkSummary,
        artifactIds: parseEvidenceIds(checkArtifactIds),
        metadata: parseArtifactMetadata(checkMetadata)
      });
      setChecks((current) => [saved, ...current.filter((item) => item.id !== saved.id)]);
      setCheckSummary("");
      setCheckArtifactIds("");
      await loadReviewState();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Review check failed");
    } finally {
      setCheckPending(false);
    }
  }

  async function saveDiff() {
    if (!activeRoom) return;
    setDiffPending(true);
    setError(null);
    try {
      const saved = await api.createReviewDiff({
        roomId: activeRoom.id,
        reviewDecisionId: decisions[0]?.id ?? null,
        title: diffTitle,
        filePath: diffFilePath,
        status: diffStatus,
        additions: Number(diffAdditions || 0),
        deletions: Number(diffDeletions || 0),
        patchArtifactId: diffPatchArtifactId.trim() || null,
        summary: diffSummary
      });
      setDiffs((current) => [saved, ...current.filter((item) => item.id !== saved.id)]);
      setDiffTitle("");
      setDiffFilePath("");
      setDiffAdditions("0");
      setDiffDeletions("0");
      setDiffPatchArtifactId("");
      setDiffSummary("");
      await loadReviewState();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Review diff failed");
    } finally {
      setDiffPending(false);
    }
  }

  const canSaveArtifact =
    Boolean(activeRoom) &&
    artifactStorageUri.trim().length > 0 &&
    /^[a-f0-9]{64}$/.test(artifactSha256.trim()) &&
    Number.isFinite(Number(artifactByteSize)) &&
    Number(artifactByteSize) >= 0;
  const canSaveCheck = Boolean(activeRoom) && checkName.trim().length > 0 && checkSummary.trim().length > 0;
  const canSaveDiff = Boolean(activeRoom) && diffTitle.trim().length > 0 && diffFilePath.trim().length > 0;

  return (
    <div className="dock-panel review-dock">
      <h2>Review</h2>
      <section className="review-gate" aria-label="Review gate status">
        <CheckCircle2 aria-hidden="true" />
        <span>
          <strong>Ship/block gate active</strong>
          <small>Operator decisions are persisted, audited, and room-scoped.</small>
        </span>
      </section>
      <section className="review-aggregation" aria-label="Review aggregation status">
        <div>
          <span className={`status ${reviewGateTone(gateStatus)}`}>{readableCode(gateStatus)}</span>
          <strong>Checks and diffs ledger</strong>
          <small>{gateReason}</small>
        </div>
        <div className="review-aggregation-grid">
          <Metric label="Checks" value={String(checks.length)} tone={checks.some((item) => item.status === "FAIL") ? "bad" : checks.length ? "ok" : "muted"} />
          <Metric label="Diffs" value={String(diffs.length)} tone={diffs.length ? "ok" : "muted"} />
        </div>
      </section>
      <section className="browser-evidence-panel" aria-label="Browser evidence smoke">
        <div>
          <Eye aria-hidden="true" />
          <span>
            <strong>Browser evidence smoke</strong>
            <small>Internal Space capture creates screenshot, DOM, console and network artifacts.</small>
          </span>
        </div>
        <div className="inline-field">
          <select
            aria-label="Browser evidence viewport"
            value={browserViewport}
            onChange={(event) => setBrowserViewport(event.target.value as BrowserEvidenceViewport)}
          >
            {browserEvidenceViewports.map((viewport) => (
              <option key={viewport} value={viewport}>
                {readableCode(viewport)}
              </option>
            ))}
          </select>
          <button
            className="compact-action primary-action"
            onClick={captureBrowserEvidence}
            disabled={!activeRoom || browserEvidencePending}
            title="Capture browser evidence"
            aria-label="Capture browser evidence"
          >
            <Eye aria-hidden="true" />
            <span>{browserEvidencePending ? "Capturing" : "Capture"}</span>
          </button>
        </div>
      </section>
      <section className="artifact-form" aria-label="Register evidence artifact">
        <div className="inline-field">
          <select aria-label="Artifact kind" value={artifactKind} onChange={(event) => setArtifactKind(event.target.value as Artifact["kind"])}>
            {artifactKinds.map((kind) => (
              <option key={kind} value={kind}>
                {readableCode(kind)}
              </option>
            ))}
          </select>
          <input
            aria-label="Artifact MIME type"
            value={artifactMimeType}
            onChange={(event) => setArtifactMimeType(event.target.value)}
            placeholder="image/png"
          />
        </div>
        <input
          aria-label="Artifact storage URI"
          value={artifactStorageUri}
          onChange={(event) => setArtifactStorageUri(event.target.value)}
          placeholder="cas://sha256/..."
        />
        <div className="inline-field">
          <input
            aria-label="Artifact SHA256"
            value={artifactSha256}
            onChange={(event) => setArtifactSha256(event.target.value)}
            placeholder="64 hex sha256"
          />
          <input
            aria-label="Artifact byte size"
            value={artifactByteSize}
            onChange={(event) => setArtifactByteSize(event.target.value)}
            inputMode="numeric"
            placeholder="0"
          />
        </div>
        <textarea
          aria-label="Artifact metadata"
          value={artifactMetadata}
          onChange={(event) => setArtifactMetadata(event.target.value)}
          placeholder="viewport=1440x900"
          rows={2}
        />
        <button
          className="compact-action primary-action"
          onClick={saveArtifact}
          disabled={artifactPending || !canSaveArtifact}
          title="Register evidence artifact"
          aria-label="Register evidence artifact"
        >
          <Plus aria-hidden="true" />
          <span>{artifactPending ? "Registering" : "Register artifact"}</span>
        </button>
      </section>
      <section className="artifact-list" aria-label="Evidence artifacts">
        {artifacts.length ? (
          artifacts.map((artifact) => (
            <article key={artifact.id} className="artifact-entry">
              <div>
                <span className="status ok">{readableCode(artifact.kind)}</span>
                <strong>{artifact.id}</strong>
              </div>
              <small>{artifact.storageUri}</small>
              <div className="artifact-entry-footer">
                <small>{artifact.byteSize.toLocaleString()} bytes</small>
                <button
                  className="compact-action"
                  onClick={() => setEvidenceIds((current) => appendEvidenceId(current, artifact.id))}
                  title="Use artifact in review"
                  aria-label={`Use ${artifact.id} in review`}
                >
                  <Plus aria-hidden="true" />
                  <span>Use</span>
                </button>
              </div>
            </article>
          ))
        ) : (
          <div className="empty-mini" role="status">
            No evidence artifacts
          </div>
        )}
      </section>
      <section className="review-form" aria-label="Record review check">
        <div className="inline-field">
          <select aria-label="Review check status" value={checkStatus} onChange={(event) => setCheckStatus(event.target.value as ReviewCheck["status"])}>
            {reviewCheckStatuses.map((status) => (
              <option key={status} value={status}>
                {readableCode(status)}
              </option>
            ))}
          </select>
          <input aria-label="Review check name" value={checkName} onChange={(event) => setCheckName(event.target.value)} placeholder="npm test" />
        </div>
        <input aria-label="Review check command" value={checkCommand} onChange={(event) => setCheckCommand(event.target.value)} placeholder="npm test" />
        <textarea
          aria-label="Review check summary"
          value={checkSummary}
          onChange={(event) => setCheckSummary(event.target.value)}
          placeholder="Check summary"
          rows={2}
        />
        <input
          aria-label="Review check artifact IDs"
          value={checkArtifactIds}
          onChange={(event) => setCheckArtifactIds(event.target.value)}
          placeholder="artifact:id values"
        />
        <textarea
          aria-label="Review check metadata"
          value={checkMetadata}
          onChange={(event) => setCheckMetadata(event.target.value)}
          placeholder="suite=unit"
          rows={2}
        />
        <button
          className="compact-action primary-action"
          onClick={saveCheck}
          disabled={checkPending || !canSaveCheck}
          title="Record review check"
          aria-label="Record review check"
        >
          <CheckCircle2 aria-hidden="true" />
          <span>{checkPending ? "Recording" : "Record check"}</span>
        </button>
      </section>
      <section className="review-list" aria-label="Review checks">
        {checks.length ? (
          checks.slice(0, 6).map((item) => (
            <article key={item.id} className="review-entry">
              <div>
                <span className={`status ${reviewCheckTone(item.status)}`}>{readableCode(item.status)}</span>
                <strong>{item.name}</strong>
              </div>
              <p>{item.summary}</p>
              <small>{item.artifactIds.length} artifacts / {item.command ?? "no command"}</small>
            </article>
          ))
        ) : (
          <div className="empty-mini" role="status">
            No review checks
          </div>
        )}
      </section>
      <section className="review-form" aria-label="Record review diff">
        <div className="inline-field">
          <select aria-label="Review diff status" value={diffStatus} onChange={(event) => setDiffStatus(event.target.value as ReviewDiffSummary["status"])}>
            {reviewDiffStatuses.map((status) => (
              <option key={status} value={status}>
                {readableCode(status)}
              </option>
            ))}
          </select>
          <input aria-label="Review diff title" value={diffTitle} onChange={(event) => setDiffTitle(event.target.value)} placeholder="UI changes" />
        </div>
        <input aria-label="Review diff file path" value={diffFilePath} onChange={(event) => setDiffFilePath(event.target.value)} placeholder="apps/web/src/App.tsx" />
        <div className="inline-field">
          <input aria-label="Review diff additions" value={diffAdditions} onChange={(event) => setDiffAdditions(event.target.value)} inputMode="numeric" placeholder="0" />
          <input aria-label="Review diff deletions" value={diffDeletions} onChange={(event) => setDiffDeletions(event.target.value)} inputMode="numeric" placeholder="0" />
        </div>
        <input
          aria-label="Review diff patch artifact ID"
          value={diffPatchArtifactId}
          onChange={(event) => setDiffPatchArtifactId(event.target.value)}
          placeholder="artifact:patch"
        />
        <textarea
          aria-label="Review diff summary"
          value={diffSummary}
          onChange={(event) => setDiffSummary(event.target.value)}
          placeholder="Diff summary"
          rows={2}
        />
        <button
          className="compact-action primary-action"
          onClick={saveDiff}
          disabled={diffPending || !canSaveDiff}
          title="Record review diff"
          aria-label="Record review diff"
        >
          <GitCompare aria-hidden="true" />
          <span>{diffPending ? "Recording" : "Record diff"}</span>
        </button>
      </section>
      <section className="review-list" aria-label="Review diffs">
        {diffs.length ? (
          diffs.slice(0, 6).map((item) => (
            <article key={item.id} className="review-entry">
              <div>
                <span className="status muted">{readableCode(item.status)}</span>
                <strong>{item.title}</strong>
              </div>
              <p>{item.filePath}</p>
              <small>+{item.additions.toLocaleString()} / -{item.deletions.toLocaleString()} / {item.patchArtifactId ?? "no patch artifact"}</small>
            </article>
          ))
        ) : (
          <div className="empty-mini" role="status">
            No review diffs
          </div>
        )}
      </section>
      <section className="review-form" aria-label="Create review decision">
        <select aria-label="Review decision" value={decision} onChange={(event) => setDecision(event.target.value as ReviewDecision["decision"])}>
          <option value="BLOCK">Block</option>
          <option value="NEEDS_HUMAN">Needs human</option>
          <option value="SHIP">Ship</option>
        </select>
        <textarea
          aria-label="Review summary"
          value={summary}
          onChange={(event) => setSummary(event.target.value)}
          placeholder="Summary"
          rows={3}
        />
        <input
          aria-label="Evidence artifact IDs"
          value={evidenceIds}
          onChange={(event) => setEvidenceIds(event.target.value)}
          placeholder="artifact:id values"
        />
        <textarea
          aria-label="Rollback note"
          value={rollbackNote}
          onChange={(event) => setRollbackNote(event.target.value)}
          placeholder="Rollback note"
          rows={2}
        />
        <button
          className="compact-action primary-action"
          onClick={saveReview}
          disabled={pending || !activeRoom || !summary.trim()}
          title="Record review decision"
          aria-label="Record review decision"
        >
          <Plus aria-hidden="true" />
          <span>{pending ? "Recording" : "Record"}</span>
        </button>
      </section>
      {error ? (
        <div className="validation-result bad" role="alert">
          <strong>REVIEW_ERROR</strong>
          <small>{error}</small>
        </div>
      ) : null}
      <section className="review-list" aria-label="Review decisions">
        {decisions.length ? (
          decisions.map((item) => (
            <article key={item.id} className="review-entry">
              <div>
                <span className={`status ${decisionTone(item.decision)}`}>{readableCode(item.decision)}</span>
                <strong>{item.summary}</strong>
              </div>
              {item.rollbackNote ? <p>{item.rollbackNote}</p> : null}
              <small>{item.evidenceArtifactIds.length} evidence artifacts</small>
            </article>
          ))
        ) : (
          <div className="empty-mini" role="status">
            No review decisions
          </div>
        )}
      </section>
    </div>
  );
}

function Metric({ label, value, tone }: { label: string; value: string; tone: string }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong className={`status ${tone}`}>{value}</strong>
    </div>
  );
}

function DockPanel({ title, text }: { title: string; text: string }) {
  return (
    <div className="dock-panel">
      <h2>{title}</h2>
      <p>{text}</p>
    </div>
  );
}
