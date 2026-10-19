import { api } from "../../api.js";
import { isRecord } from "../../app-shell-utils.js";
import { dispatchArtifactsUpdated } from "../../artifact-events.js";
import { cliRuntimeLabel, cliRuntimePresentation } from "../../cli-runtime-presentation.js";
import { cliModeShortcutAvailable } from "../osk-keyboard/cli-shortcuts.js";
import { CLI_VPN_ROUTING_STATUS_EVENT, harnessPaneVpnRoutingPresentation, loadCliVpnRoutingStatus, paneVpnRoutingPresentation } from "../../cli-vpn-routing.js";
import { type IconToolbarAction, useDismissibleToolbarLayer, usePersistentIconToolbar } from "../../icon-toolbar.js";
import { lazyWithPreload } from "../../lazy-with-preload.js";
import { recordLifecycleDebugEvent } from "../../lifecycle-debug.js";
import { getSpaceRuntime } from "../../runtime/SpaceRuntime.js";
import { migrateModernToolbarPreference, modernPaneToolbarStorageKeys, shouldMeasureToolbarLayout, type UiTheme } from "../../ui-theme.js";
import { useAutoDismiss } from "../../use-auto-dismiss.js";
import { RecoverableSurface } from "../SurfaceErrorBoundary.js";
import { DesktopActionManager } from "../action-surfaces/DesktopActionManager.js";
import { MobileActionSheet } from "../action-surfaces/MobileActionSheet.js";
import { type PaneOverflowCommand } from "../action-surfaces/action-surface-shared.js";
import { type AgentPaneIdentity } from "../agent-pane/AgentPane.js";
import { dispatchAgentPaneActionEvent } from "../agent-pane/events.js";
import {
  agentActionAvailabilityEqual,
  agentActionDisabledReason,
  type AgentPaneActionAvailability
} from "../agent-pane/agent-action-availability.js";
import { SPACE_CLIPBOARD_NOTICE_EVENT, writeClipboardText } from "../clipboard-dock/clipboard-events.js";
import { TaskHistoryDialog, type TaskHistoryDialogItem } from "../pane-dialogs/PaneDialogs.js";
import { type PaneDropPosition } from "../pane-drag/pane-drag.js";
import { measureSingleLineTitleWidth, paneHeaderNeedsSecondRow, remToPx, type ShellMode } from "../pane-grid/pane-grid-layout.js";
import { PaneWorkingTimeBadge } from "../pane-working-time/index.js";
import { useRailMenuDodge } from "../rail-popover.js";
import { statusTone } from "../status-tone.js";
import { TaskTitleDetails } from "../task-titles/TaskTitleDetails.js";
import { TerminalPane, type TerminalBootstrapBarrier, type TerminalSessionMetadata } from "../terminal-pane/index.js";
import {
  terminalActionAvailabilityEqual,
  terminalActionDisabledReason,
  type TerminalActionAvailability
} from "../terminal-pane/terminal-action-availability.js";
import { ArrowRightLeft, Camera, ChevronLeft, ChevronRight, CircleStop, Clipboard, ClipboardList, Columns2, Copy, Crosshair, Database, Eye, EyeOff, FileInput, FolderPlus, Grid2X2, GripVertical, History, Maximize2, Minimize2, Minus, Monitor, MoreHorizontal, MoveHorizontal, Paperclip, Pencil, PictureInPicture2, Plus, RefreshCw, Save, Send, Shrink, Sparkles, Terminal, Undo2, X, Youtube } from "../ui-theme/app-icons.js";
import { modernPanePrimaryActionCapacity, modernPanePrimaryActionCount } from "../ui-theme/modern-toolbar.js";
import { useTouchContextMenu } from "../ui-theme/use-touch-context-menu.js";
import { WorktreeBadge } from "../worktrees/WorktreeBadge.js";
import { modeIcons } from "./pane-mode-icons.js";
import { cliTurnInterruptKey, paneCategoryColors, type CliRuntimeSettingsResponse, type CliVpnRoutingStatus, type CodexEnvironment, type Event as SpaceEvent, type MemoryEntry, type Pane, type PaneCategoryColor, type PaneCliSessionResponse, type Turn } from "@space/contracts";
import { lazy, memo, type ComponentProps, type CSSProperties, type DragEvent as ReactDragEvent, type FormEvent, type PointerEvent as ReactPointerEvent, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";


export function PaneModeIcon({ pane }: { pane: Pick<Pane, "mode" | "terminalRuntimeId"> }) {
  const runtimeId = pane.terminalRuntimeId?.replace(/^cli:/, "") ?? "codex";
  const runtimeBrand = pane.mode === "TERMINAL"
    ? cliRuntimePresentation(runtimeId)
    : pane.mode === "HARNESS"
      ? cliRuntimePresentation("cli:harness")
      : undefined;
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

export const LazyAgentPane = lazyWithPreload(() =>
  import("../agent-pane/AgentPane.js").then((module) => ({ default: module.AgentPane })),
  { idle: true }
);

export const LazyBrowserPane = lazyWithPreload(() =>
  import("../browser-pane/BrowserPane.js").then((module) => ({ default: module.BrowserPane })),
  { idle: true }
);

export const LazyYouTubePane = lazy(() =>
  import("../browser-pane/YouTubePane.js").then((module) => ({ default: module.YouTubePane }))
);

export const LazyVncPane = lazy(() =>
  import("../vnc-pane/VncPane.js").then((module) => ({ default: module.VncPane }))
);

export const LazyHarnessPane = lazy(() =>
  import("../harness-pane/HarnessPane.js").then((module) => ({ default: module.HarnessPane }))
);

export const LazyLivePane = lazy(() =>
  import("../live-pane/LivePane.js").then((module) => ({ default: module.LivePane }))
);

export const LazyDemosPane = lazy(() =>
  import("../demos-pane/DemosPane.js").then((module) => ({ default: module.DemosPane }))
);

export const LazyFilesPane = lazy(() =>
  import("../files-pane/FilesPane.js").then((module) => ({ default: module.FilesPane }))
);

export const LazyDatabasesPane = lazy(() =>
  import("../databases-pane/DatabasesPane.js").then((module) => ({ default: module.DatabasesPane }))
);

export const LazyT3CodePane = lazy(() =>
  import("../t3code-pane/T3CodePane.js").then((module) => ({ default: module.T3CodePane }))
);
export const LazyJobApplyPane = lazy(() =>
  import("../job-apply-pane/JobCopilotPane.js").then((module) => ({ default: module.JobCopilotPane }))
);
const LazyMailCopilotPane = lazy(() =>
  import("../mail-copilot-pane/MailCopilotPane.js").then((module) => ({ default: module.MailCopilotPane }))
);
const LazyMarketingCopilotPane = lazy(() =>
  import("../marketing-copilot-pane/MarketingCopilotPane.js").then((module) => ({ default: module.MarketingCopilotPane }))
);
const LazyFreelanceCopilotPane = lazy(() =>
  import("../freelance-copilot-pane/FreelanceCopilotPane.js").then((module) => ({ default: module.FreelanceCopilotPane }))
);
/** Marketing and Freelance Copilot share one pane layout (live browser, rail, agent terminal). */
function BrowserCopilotPane(props: ComponentProps<typeof LazyMarketingCopilotPane>) {
  return props.pane.mode === "FREELANCE_COPILOT" ? <LazyFreelanceCopilotPane {...props} /> : <LazyMarketingCopilotPane {...props} />;
}

export const agentPaneLoadingFallback = <div className="pane-copy" role="status">Loading chat pane…</div>;

export const browserPaneLoadingFallback = <div className="pane-copy" role="status">Loading browser pane…</div>;

export const terminalPaneLoadingFallback = <div className="pane-copy" role="status">Loading CLI pane…</div>;

export const PANE_TOOLBAR_HIDDEN_ACTIONS_STORAGE_KEY_PREFIX = "space.paneToolbar.hiddenActionIds";

export const PANE_TOOLBAR_ACTION_ORDER_STORAGE_KEY_PREFIX = "space.paneToolbar.actionOrder";

export const SHARED_CODEX_TOOLBAR_HIDDEN_STORAGE_KEY = "space.paneToolbar.sharedCodex.hiddenActionIds";

export const SHARED_CODEX_TOOLBAR_ORDER_STORAGE_KEY = "space.paneToolbar.sharedCodex.actionOrder";

export const TERMINAL_PANE_ACTION_EVENT = "space:terminal-pane-action";

export type TerminalPaneAction =
  | { action: "upload" | "reconnect" | "copy" | "paste" | "paste_file" | "focus" | "cancel_login" | "new_task" }
  | { action: "attach_clip_image"; file: File }
  | { action: "insert_text"; text: string }
  | { action: "keyboard_input"; text: string }
  | { action: "cli_shortcut"; commandId: string }
  | { action: "insert_clipboard_text"; text: string }
  | { action: "start_task_item"; objective: string }
  | { action: "ensure_plan_mode" }
  | { action: "enable_plan_mode" }
  | { action: "stop_task" }
  | { action: "enter_native_plan_mode"; runtimeId: "cli:gemini" | "cli:qwen" | "cli:omp" }
  | { action: "control_key"; key: "ctrl_c" | "shift_tab" | "escape" }
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

export type AgentPaneAction =
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

export type AgentPaneDetailAction =
  | { action: "insert_text"; text: string }
  | { action: "open_thread"; threadId: string };

export function displayPaneTitle(pane: Pick<Pane, "mode" | "title"> & { paneName?: string | null }): string {
  if (pane.paneName) return pane.paneName;
  if (pane.mode !== "TERMINAL") return pane.title;
  return pane.title.replace(/^Terminal\b/i, "CLI");
}

export function appendUniqueTaskHistoryItems(current: TaskHistoryDialogItem[], incoming: TaskHistoryDialogItem[]): TaskHistoryDialogItem[] {
  const ids = new Set(current.map((item) => item.id));
  const merged = [...current];
  for (const item of incoming) {
    if (ids.has(item.id)) continue;
    ids.add(item.id);
    merged.push(item);
  }
  return merged;
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

export function paneToolbarHiddenStorageKey(mode: Pane["mode"]): string {
  if (mode === "CHAT" || mode === "TERMINAL") return SHARED_CODEX_TOOLBAR_HIDDEN_STORAGE_KEY;
  return `${PANE_TOOLBAR_HIDDEN_ACTIONS_STORAGE_KEY_PREFIX}.${mode}`;
}

export function paneToolbarActionOrderStorageKey(mode: Pane["mode"]): string {
  if (mode === "CHAT" || mode === "TERMINAL") return SHARED_CODEX_TOOLBAR_ORDER_STORAGE_KEY;
  return `${PANE_TOOLBAR_ACTION_ORDER_STORAGE_KEY_PREFIX}.${mode}`;
}

export function dispatchTerminalPaneAction(paneId: string, action: TerminalPaneAction) {
  window.dispatchEvent(new CustomEvent(TERMINAL_PANE_ACTION_EVENT, { detail: { paneId, ...action } }));
}

export function terminalPlanModeAction(runtimeId: string): TerminalPaneAction {
  if (runtimeId === "cli:claude") return { action: "ensure_plan_mode" };
  if (runtimeId === "cli:gemini" || runtimeId === "cli:qwen" || runtimeId === "cli:omp") {
    return { action: "enter_native_plan_mode", runtimeId };
  }
  // The per-runtime Plan shortcut (Codex /plan, OpenCode Tab, Kimi /plan, ...) guards drafts and running turns.
  return { action: "enable_plan_mode" };
}

/** Native key hint for the pane menu Plan action; slash-command runtimes show none. */
export function terminalPlanModeShortcut(runtimeId: string): string | undefined {
  if (runtimeId === "cli:claude" || runtimeId === "cli:copilot" || runtimeId === "cli:droid") return "Shift+Tab";
  if (runtimeId === "cli:opencode") return "Tab";
  return undefined;
}

/** Native key the pane menu Stop action sends; OpenCode stops through its server API instead. */
export function terminalStopShortcut(runtimeId: string): string {
  return runtimeId === "cli:opencode" || cliTurnInterruptKey(runtimeId) === "escape" ? "Esc" : "Ctrl+C";
}

// Menu items the Live pane handles itself through "space-live-pane-action".
const LIVE_PANE_ACTION_IDS = new Set(["import", "live-camera", "live-screen", "live-real-view"]);

// The API rejects these pane updates while the pane's runtime (Codex, a CLI or the Harness) is disabled.
const PANE_UPDATE_ACTION_IDS = new Set(["add", "youtube-add-pane", "grow-width", "reset-width"]);

// Default menu order for CLI and Chat panes: task, clipboard and files, then pane layout. Both pane
// types share one stored order, so they must agree on the relative order of their common actions.
// Users can still drag to reorder.
export const AGENT_PANE_ACTION_ORDER = [
  "new-task",
  "stop",
  "plan",
  "resume",
  "memory",
  "copy",
  "paste",
  "paste_file",
  "import",
  "generate-title",
  "add",
  "move",
  "chat-target",
  "grow-width",
  "reset-width",
  "reconnect"
];

export function sortPaneActionsByPreferredOrder<T extends { id: string }>(actions: T[], preferredOrder: string[]): T[] {
  const rank = (id: string) => {
    const index = preferredOrder.indexOf(id);
    return index === -1 ? preferredOrder.length : index;
  };
  return actions
    .map((action, index) => ({ action, index }))
    .sort((left, right) => rank(left.action.id) - rank(right.action.id) || left.index - right.index)
    .map(({ action }) => action);
}

export function dispatchAgentPaneAction(paneId: string, action: AgentPaneAction | AgentPaneDetailAction) {
  const detail = typeof action === "string" ? { paneId, action } : { paneId, ...action };
  dispatchAgentPaneActionEvent(detail);
}

export const PaneCard = memo(function PaneCard({
  pane,
  roomProjectPath,
  controlPlacement,
  agentNumber,
  latestTurn,
  latestCompletion,
  hasPendingCompletion,
  isLifecycleRunning = false,
  isTarget,
  isMoveDialogOpen,
  isVisibleInShell,
  isPresentationInteractive = true,
  isFloatingYouTube = false,
  onToggleYouTubeFloating,
  isTerminalOutputVisible,
  browserObserverOnly,
  terminalObserverOnly,
  uiTheme,
  shellMode,
  oskOpen,
  maskSensitiveData,
  codexTurnsEnabled,
  codexEnvironment,
  cliRuntimeSettings,
  runtimeBlockedReason = null,
  addPaneBlockedReason = null,
  canMoveToAnotherRoom,
  draggedPaneId,
  dragOverPaneId,
  dragOverPosition = "before",
  paneReorderPending,
  onPaneDragStart,
  onPaneDragEnd,
  onPaneDragOver,
  onPaneDragLeave,
  onPaneDrop,
  onTarget,
  onMove,
  onPaneUpdated,
  onOpenExistingPane,
  onClose,
  onMaximize,
  onMinimize,
  onGrowColumnSpan,
  onResetColumnSpan,
  onToggleColumnSpan,
  onSplit,
  isFullscreenLayout,
  presizeInFullscreen = false,
  fullscreenIndex,
  fullscreenCount,
  onFullscreenNavigate,
  onRestoreLayout,
  effectiveColumnSpan,
  rowSpan,
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
  shouldLoadHarness,
  revealGeneration,
  onTerminalBootstrapped,
  onTerminalPrefillReadyChange,
  onTerminalRevealReady
}: {
  pane: Pane;
  roomProjectPath?: string | null;
  controlPlacement?: {x:number;y:number;width:number;height:number};
  agentNumber: number;
  latestTurn: Turn | null;
  latestCompletion: SpaceEvent | null;
  hasPendingCompletion: boolean;
  isLifecycleRunning?: boolean;
  isTarget: boolean;
  isMoveDialogOpen: boolean;
  isVisibleInShell: boolean;
  /** The containing room layer is exposed to assistive technology. */
  isPresentationInteractive?: boolean;
  isFloatingYouTube?: boolean;
  onToggleYouTubeFloating?: () => void;
  isTerminalOutputVisible: boolean;
  browserObserverOnly: boolean;
  terminalObserverOnly: boolean;
  uiTheme: UiTheme;
  shellMode: ShellMode;
  oskOpen: boolean;
  maskSensitiveData: boolean;
  codexTurnsEnabled: boolean;
  codexEnvironment: Pick<CodexEnvironment, "isCodexEnabled"> | null;
  cliRuntimeSettings: CliRuntimeSettingsResponse | null;
  /** Set when the pane's runtime (Codex, a CLI or the Harness) is disabled, so the API rejects pane updates. */
  runtimeBlockedReason?: string | null;
  /** Set when the room cannot take another pane. */
  addPaneBlockedReason?: string | null;
  canMoveToAnotherRoom: boolean;
  draggedPaneId: string | null;
  dragOverPaneId: string | null;
  dragOverPosition?: PaneDropPosition;
  paneReorderPending: boolean;
  onPaneDragStart: (event: ReactDragEvent<HTMLElement>, pane: Pane) => void;
  onPaneDragEnd: () => void;
  onPaneDragOver: (event: ReactDragEvent<HTMLElement>, paneId: string) => void;
  onPaneDragLeave: (paneId: string) => void;
  onPaneDrop: (paneId: string, position?: PaneDropPosition) => void | Promise<void>;
  onTarget: (paneId: string) => void;
  onMove: (pane: Pane) => void;
  onPaneUpdated: (pane: Pane) => void;
  onOpenExistingPane: (pane: Pane) => Promise<void>;
  onClose: (paneId: string) => void;
  onMaximize: (pane: Pane) => void;
  onMinimize: (pane: Pane) => void;
  onGrowColumnSpan: (pane: Pane) => Promise<void>;
  onResetColumnSpan: (pane: Pane) => Promise<void>;
  onToggleColumnSpan: (pane: Pane) => Promise<void>;
  onSplit: (pane: Pane, direction: "horizontal" | "vertical") => void;
  isFullscreenLayout: boolean;
  presizeInFullscreen?: boolean;
  fullscreenIndex: number;
  fullscreenCount: number;
  onFullscreenNavigate: (direction: "previous" | "next", fromPaneId?: string) => void;
  onRestoreLayout?: () => void;
  effectiveColumnSpan: number;
  rowSpan: number;
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
  shouldLoadHarness: boolean;
  revealGeneration: number;
  onTerminalBootstrapped: (roomId: string, paneId: string) => void;
  onTerminalPrefillReadyChange: (roomId: string, paneId: string, ready: boolean) => void;
  onTerminalRevealReady: (roomId: string, paneId: string, generation: number) => void;
}) {
  const isCoarsePointer = useMemo(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
    return window.matchMedia("(pointer: coarse)").matches;
  }, []);
  const agentResponse = latestCompletion ? extractAgentResponseFromEvent(latestCompletion) : null;
  const completionState = hasPendingCompletion
    ? "pending"
    : latestCompletion
      ? "acknowledged"
      : "idle";
  const [youtubeVideoTitle, setYoutubeVideoTitle] = useState('');
  const youtubeToolbarStorageKey = `space.youtube.toolbar.hidden.v1:${pane.id}`;
  const [youtubeToolbarHidden, setYoutubeToolbarHidden] = useState(() => {
    try { return localStorage.getItem(youtubeToolbarStorageKey) === 'true'; } catch { return false; }
  });
  const floatLayoutStorageKey = `space.youtube.float-layout.v1:${pane.id}`;
  const [floatLayout, setFloatLayout] = useState<{ x: number; y: number; width: number; height: number }>(() => {
    try {
      const saved = localStorage.getItem(floatLayoutStorageKey);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (typeof parsed.x === "number" && typeof parsed.y === "number" && typeof parsed.width === "number" && typeof parsed.height === "number") {
          return parsed;
        }
      }
    } catch {}
    const defaultWidth = 380;
    const defaultHeight = 240;
    const x = typeof window !== "undefined" ? Math.max(16, window.innerWidth - defaultWidth - 24) : 100;
    const y = typeof window !== "undefined" ? Math.max(16, window.innerHeight - defaultHeight - 24) : 100;
    return { x, y, width: defaultWidth, height: defaultHeight };
  });
  const [isPointerActive, setIsPointerActive] = useState(false);
  const lastPanePointerDownAtRef = useRef(0);
  const latestFloatLayoutRef = useRef(floatLayout);
  latestFloatLayoutRef.current = floatLayout;

  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    initialX: number;
    initialY: number;
    latestX: number;
    latestY: number;
  } | null>(null);
  const resizeRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    initialX: number;
    initialY: number;
    initialWidth: number;
    initialHeight: number;
    latestX: number;
    latestY: number;
    latestWidth: number;
    latestHeight: number;
  } | null>(null);
  const paneArticleRef = useRef<HTMLElement | null>(null);

  const youtubeDodgeShiftX = useRailMenuDodge(paneArticleRef, {
    x: floatLayout.x,
    y: floatLayout.y,
    active: isFloatingYouTube,
    isDragging: isPointerActive
  });

  useEffect(() => {
    return () => {
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
  }, []);

  useEffect(() => {
    if (!isFloatingYouTube || !paneArticleRef.current || typeof ResizeObserver === "undefined") return;
    const el = paneArticleRef.current;
    const ro = new ResizeObserver((entries) => {
      if (isPointerActive) return;
      for (const entry of entries) {
        const target = entry.target as HTMLElement;
        const width = target.offsetWidth || entry.contentRect.width;
        const height = target.offsetHeight || entry.contentRect.height;
        if (width >= 200 && height >= 140) {
          setFloatLayout((prev) => {
            if (Math.abs(prev.width - width) < 4 && Math.abs(prev.height - height) < 4) return prev;
            const updated = { ...prev, width: Math.round(width), height: Math.round(height) };
            try {
              localStorage.setItem(floatLayoutStorageKey, JSON.stringify(updated));
            } catch {}
            return updated;
          });
        }
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [isFloatingYouTube, floatLayoutStorageKey, isPointerActive]);

  const handleFloatHeaderPointerDown = (e: ReactPointerEvent<HTMLElement>) => {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest("button, input, select, textarea, a")) return;
    e.preventDefault();
    e.stopPropagation();
    const initialVisualX = floatLayout.x - youtubeDodgeShiftX;
    setIsPointerActive(true);
    if (youtubeDodgeShiftX > 0) {
      setFloatLayout((prev) => ({ ...prev, x: initialVisualX }));
    }
    const current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      initialX: initialVisualX,
      initialY: floatLayout.y,
      latestX: initialVisualX,
      latestY: floatLayout.y
    };
    dragRef.current = current;

    if (paneArticleRef.current) {
      paneArticleRef.current.style.transition = "none";
      paneArticleRef.current.classList.add("is-pointer-active");
    }
    document.body.style.userSelect = "none";

    const onHeaderMove = (ev: PointerEvent) => {
      if (!dragRef.current || dragRef.current.pointerId !== ev.pointerId) return;
      const ref = dragRef.current;
      const dx = ev.clientX - ref.startX;
      const dy = ev.clientY - ref.startY;
      const maxX = Math.max(0, window.innerWidth - 60);
      const maxY = Math.max(0, window.innerHeight - 40);
      const nextX = Math.round(Math.min(maxX, Math.max(0, ref.initialX + dx)));
      const nextY = Math.round(Math.min(maxY, Math.max(0, ref.initialY + dy)));
      ref.latestX = nextX;
      ref.latestY = nextY;
      if (paneArticleRef.current) {
        paneArticleRef.current.style.left = `${nextX}px`;
        paneArticleRef.current.style.top = `${nextY}px`;
      }
    };

    const onHeaderUp = (ev: PointerEvent) => {
      if (!dragRef.current || dragRef.current.pointerId !== ev.pointerId) return;
      window.removeEventListener("pointermove", onHeaderMove);
      window.removeEventListener("pointerup", onHeaderUp);
      window.removeEventListener("pointercancel", onHeaderUp);

      document.body.style.userSelect = "";

      const ref = dragRef.current;
      dragRef.current = null;
      setIsPointerActive(false);

      if (paneArticleRef.current) {
        paneArticleRef.current.classList.remove("is-pointer-active");
        paneArticleRef.current.style.transition = "";
      }

      const updated = {
        ...latestFloatLayoutRef.current,
        x: ref.latestX,
        y: ref.latestY
      };
      setFloatLayout(updated);
      latestFloatLayoutRef.current = updated;
      try {
        localStorage.setItem(floatLayoutStorageKey, JSON.stringify(updated));
      } catch {}
    };

    window.addEventListener("pointermove", onHeaderMove, { passive: true });
    window.addEventListener("pointerup", onHeaderUp);
    window.addEventListener("pointercancel", onHeaderUp);

    try {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    } catch {}
  };

  const handleResizePointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const initialVisualX = floatLayout.x - youtubeDodgeShiftX;
    setIsPointerActive(true);
    if (youtubeDodgeShiftX > 0) {
      setFloatLayout((prev) => ({ ...prev, x: initialVisualX }));
    }
    const current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      initialX: initialVisualX,
      initialY: floatLayout.y,
      initialWidth: floatLayout.width,
      initialHeight: floatLayout.height,
      latestX: initialVisualX,
      latestY: floatLayout.y,
      latestWidth: floatLayout.width,
      latestHeight: floatLayout.height
    };
    resizeRef.current = current;

    if (paneArticleRef.current) {
      paneArticleRef.current.style.transition = "none";
      paneArticleRef.current.classList.add("is-pointer-active");
    }
    document.body.style.cursor = "nwse-resize";
    document.body.style.userSelect = "none";

    const onResizeMove = (ev: PointerEvent) => {
      if (!resizeRef.current || resizeRef.current.pointerId !== ev.pointerId) return;
      const ref = resizeRef.current;
      const dw = ev.clientX - ref.startX;
      const dh = ev.clientY - ref.startY;

      const minW = 240;
      const minH = 160;
      const screenW = typeof window !== "undefined" ? window.innerWidth : 1920;
      const screenH = typeof window !== "undefined" ? window.innerHeight : 1080;
      const maxW = Math.max(minW, screenW - 16);
      const maxH = Math.max(minH, screenH - 16);

      const desiredWidth = Math.max(minW, Math.min(maxW, ref.initialWidth + dw));
      const desiredHeight = Math.max(minH, Math.min(maxH, ref.initialHeight + dh));

      const margin = 8;
      const availRight = screenW - ref.initialX - margin;
      const availBottom = screenH - ref.initialY - margin;

      let nextX = ref.initialX;
      let nextWidth = desiredWidth;
      if (desiredWidth > availRight) {
        const overflowX = desiredWidth - availRight;
        nextX = Math.max(margin, ref.initialX - overflowX);
        nextWidth = Math.min(screenW - nextX - margin, desiredWidth);
      }

      let nextY = ref.initialY;
      let nextHeight = desiredHeight;
      if (desiredHeight > availBottom) {
        const overflowY = desiredHeight - availBottom;
        nextY = Math.max(margin, ref.initialY - overflowY);
        nextHeight = Math.min(screenH - nextY - margin, desiredHeight);
      }

      const finalX = Math.round(nextX);
      const finalY = Math.round(nextY);
      const finalW = Math.round(nextWidth);
      const finalH = Math.round(nextHeight);

      ref.latestX = finalX;
      ref.latestY = finalY;
      ref.latestWidth = finalW;
      ref.latestHeight = finalH;

      if (paneArticleRef.current) {
        paneArticleRef.current.style.width = `${finalW}px`;
        paneArticleRef.current.style.height = `${finalH}px`;
        paneArticleRef.current.style.left = `${finalX}px`;
        paneArticleRef.current.style.top = `${finalY}px`;
      }
    };

    const onResizeUp = (ev: PointerEvent) => {
      if (!resizeRef.current || resizeRef.current.pointerId !== ev.pointerId) return;
      window.removeEventListener("pointermove", onResizeMove);
      window.removeEventListener("pointerup", onResizeUp);
      window.removeEventListener("pointercancel", onResizeUp);

      document.body.style.cursor = "";
      document.body.style.userSelect = "";

      const ref = resizeRef.current;
      resizeRef.current = null;
      setIsPointerActive(false);

      if (paneArticleRef.current) {
        paneArticleRef.current.classList.remove("is-pointer-active");
        paneArticleRef.current.style.transition = "";
      }

      const finalLayout = {
        x: ref.latestX,
        y: ref.latestY,
        width: ref.latestWidth,
        height: ref.latestHeight
      };

      setFloatLayout(finalLayout);
      latestFloatLayoutRef.current = finalLayout;
      try {
        localStorage.setItem(floatLayoutStorageKey, JSON.stringify(finalLayout));
      } catch {}
    };

    window.addEventListener("pointermove", onResizeMove, { passive: true });
    window.addEventListener("pointerup", onResizeUp);
    window.addEventListener("pointercancel", onResizeUp);

    try {
      (e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId);
    } catch {}
  };
  const title = pane.mode === "YOUTUBE" && youtubeVideoTitle ? youtubeVideoTitle : displayPaneTitle(pane);
  const isTerminalPane = pane.mode === "TERMINAL";
  const usesCompactPaneActions = isTerminalPane || pane.mode === "CHAT" || pane.mode === "HARNESS" || pane.mode === "LIVE";
  const isRootPane = pane.terminalRuntimeId === "cli:root";
  const maximizeLabel = isFullscreenLayout
    ? "Restore automatic layout"
    : shellMode === "mobile"
      ? "Maximize pane"
      : pane.isMaximized
        ? "Restore pane"
        : "Maximize pane";
  const showRestoreIcon = shellMode !== "mobile" && pane.isMaximized;
  const agentTone = ((agentNumber - 1) % 8) + 1;
  const genericUploadInputRef = useRef<HTMLInputElement | null>(null);
  const titleInputRef = useRef<HTMLInputElement | null>(null);
  const titleTextRef = useRef<HTMLElement | null>(null);
  const titleTouchStartRef = useRef<{ x: number; y: number; time: number } | null>(null);
  const paneHeaderRef = useRef<HTMLElement | null>(null);
  const measuredHeaderInputsRef = useRef<string | null>(null);
  const [observedHeaderBoxes] = useState(() => new WeakMap<Element, { width: number; height: number }>());
  const paneBadgeRef = useRef<HTMLDivElement | null>(null);
  const paneFixedActionsRef = useRef<HTMLDivElement | null>(null);
  const [genericImportPending, setGenericImportPending] = useState(false);
  const [genericImportNotice, setGenericImportNotice] = useState<string | null>(null);
  const [genericImportError, setGenericImportError] = useState<string | null>(null);
  useAutoDismiss(genericImportNotice, setGenericImportNotice);
  useAutoDismiss(genericImportError, setGenericImportError);
  const [terminalSessionMetadata, setTerminalSessionMetadata] = useState<TerminalSessionMetadata | null>(null);
  const [terminalActionAvailability, setTerminalActionAvailability] = useState<TerminalActionAvailability | null>(null);
  const handleTerminalActionAvailabilityChange = useCallback((next: TerminalActionAvailability) => {
    setTerminalActionAvailability((prev) => (prev && terminalActionAvailabilityEqual(prev, next) ? prev : next));
  }, []);
  const [agentPaneIdentity, setAgentPaneIdentity] = useState<AgentPaneIdentity | null>(null);
  const [agentActionAvailability, setAgentActionAvailability] = useState<AgentPaneActionAvailability | null>(null);
  // The lazy Live pane only hears menu actions once it has mounted its listener.
  const [livePaneActionsReady, setLivePaneActionsReady] = useState(false);
  const handleAgentActionAvailabilityChange = useCallback((next: AgentPaneActionAvailability) => {
    setAgentActionAvailability((prev) => (prev && agentActionAvailabilityEqual(prev, next) ? prev : next));
  }, []);
  const [paneWorkingState, setPaneWorkingState] = useState<{ isWorking: boolean; screenWorkingMs?: number | null }>({ isWorking: false });
  const handleWorkingStateChange = useCallback((nextState: { isWorking: boolean; screenWorkingMs?: number | null }) => {
    setPaneWorkingState((prev) => {
      if (
        prev.isWorking === nextState.isWorking &&
        prev.screenWorkingMs === nextState.screenWorkingMs
      ) {
        return prev;
      }
      return nextState;
    });
  }, []);
  const effectiveIsWorking = paneWorkingState.isWorking || Boolean(isLifecycleRunning) || pane.status === "RUNNING";
  const [cliVpnRoutingStatus, setCliVpnRoutingStatus] = useState<CliVpnRoutingStatus | null>(null);
  const [titleDraft, setTitleDraft] = useState(pane.title);
  const [titleEditOpen, setTitleEditOpen] = useState(false);
  const [titleSavePending, setTitleSavePending] = useState(false);
  const [titleGeneratePending, setTitleGeneratePending] = useState(false);
  const [badgeMenuPosition, setBadgeMenuPosition] = useState<{ x: number; y: number } | null>(null);
  const badgeTouchContext = useTouchContextMenu(
    (source) => source instanceof Element ? source.closest<HTMLElement>(".pane-agent-badge") : null,
    ({ x, y }) => {
      if (!usesCompactPaneActions) return;
      paneToolbar.closeMenus();
      setBadgeMenuPosition({ x, y });
    }
  );
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
  const [youtubeFloatFits, setYoutubeFloatFits] = useState<boolean>(true);
  const usesGenericImport = pane.mode !== "CHAT" && pane.mode !== "TERMINAL" && pane.mode !== "YOUTUBE";
  const sessionDebugInfo = terminalSessionMetadata ? formatTerminalSessionDebugInfo(terminalSessionMetadata) : null;
  const vpnRoutingPresentation = isTerminalPane
    ? paneVpnRoutingPresentation(cliVpnRoutingStatus, {
        sessionId: terminalSessionMetadata?.sessionId ?? null,
        runtimeId: terminalSessionMetadata?.runtimeId ?? null,
        purpose: terminalSessionMetadata?.purpose ?? "NORMAL"
      })
    : pane.mode === "HARNESS"
      ? harnessPaneVpnRoutingPresentation(cliRuntimeSettings)
      : null;
  const harnessStatus = pane.mode === "HARNESS" ? cliRuntimeSettings?.harness ?? null : null;
  const paneIdentityBaseTitle = pane.mode === "HARNESS" && showSessionDebugIds
    ? `${title} / Agent ${agentNumber} / DeepSeek Harness pane session ${pane.id} / service PID ${harnessStatus?.pid ?? "inactive"}`
    : showSessionDebugIds && sessionDebugInfo
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
  const isTerminalLoginSession = terminalSessionMetadata?.purpose === "LOGIN";
  const paneUpdateBlockedReason = runtimeBlockedReason ?? (codexMutationBlocked ? codexDisabledReason : null);
  // The title API generates titles only for AI task panes; the root shell has no task to name.
  const canGeneratePaneTitle =
    (pane.mode === "CHAT" || pane.mode === "HARNESS" || (isTerminalPane && !isRootPane)) && !isTerminalLoginSession;
  const generateTitleBlockedReason =
    paneUpdateBlockedReason ?? (pane.mode === "CHAT" ? agentActionDisabledReason("generate-title", agentActionAvailability) : null);
  const sessionInfoUnavailableReason =
    pane.mode === "CHAT" && !agentPaneIdentity?.sessionId
      ? "The Chat session is still loading."
      : isTerminalPane && !terminalSessionMetadata
        ? "The CLI session is still loading."
        : null;
  const canOpenCliTaskHistory = isTerminalPane && !isRootPane && !isTerminalLoginSession;
  const [paneToolbarStorageKeys] = useState(() => {
    const classicStorageKeys = {
      hidden: paneToolbarHiddenStorageKey(pane.mode),
      order: paneToolbarActionOrderStorageKey(pane.mode)
    };
    const storageKeys = uiTheme !== "classic"
      ? modernPaneToolbarStorageKeys(pane.mode)
      : classicStorageKeys;
    if (uiTheme !== "classic") {
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
        "--pane-column-span": String(effectiveColumnSpan),
        ...(shellMode !== "mobile" && !isFullscreenLayout && !pane.isMaximized
          ? {
              gridColumn: `${columnStart} / span ${effectiveColumnSpan}`,
              gridRow: `${rowIndex + 1} / span ${rowSpan}`
            }
          : null),
        ...(isFullscreenLayout
          ? {
              gridColumn: "1 / -1",
              gridRow: "1 / -1",
              height: "100%",
              minHeight: 0
            }
          : null),
        ...(controlPlacement ? {position:"absolute",left:`${controlPlacement.x}%`,top:`${controlPlacement.y*12}px`,width:`${controlPlacement.width}%`,height:`${controlPlacement.height*12}px`,minHeight:0} : {}),
        ...(rowSpan > 1 ? { "--pane-row-span": String(rowSpan) } : null)
      }) as CSSProperties,
    [effectiveColumnSpan, columnStart, rowIndex, rowSpan, shellMode, isFullscreenLayout, pane.isMaximized, controlPlacement]
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
        .catch(() => undefined);
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
    if (pane.mode === "LIVE") {
      // The Live conversation attaches files itself.
      window.dispatchEvent(new CustomEvent("space-live-pane-action", { detail: { paneId: pane.id, action: "attach" } }));
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
      setGenericImportNotice(`${uploaded.artifacts.length} file${uploaded.artifacts.length === 1 ? "" : "s"} uploaded to the room files.`);
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
    if (titleSavePending || paneUpdateBlockedReason) return;
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
    if (!canGeneratePaneTitle || titleGeneratePending || paneUpdateBlockedReason) return;
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

  async function loadOpenableChatHistory(query: string | undefined): Promise<TaskHistoryDialogItem[]> {
    const matches = (title: string) => !query || title.toLocaleLowerCase().includes(query.toLocaleLowerCase());
    const dotId = agentActionAvailability?.dotId ?? null;
    if (!dotId) {
      // Without a Dot only the active conversation is bound to this pane.
      const threadId = agentPaneIdentity?.threadId;
      if (!threadId) return [];
      const history = await api.codexHistory({ page: 1, pageSize: 50, dedupeTitles: true, q: query || undefined });
      return history.data.filter((item) => item.id === threadId);
    }
    const sessions = await api.dotCollection(dotId, "sessions");
    const seen = new Set<string>();
    return sessions.items
      .filter((item) => item.dotId === dotId && item.roomId === pane.roomId && item.threadId)
      .sort((left, right) => (right.updatedAt ?? "").localeCompare(left.updatedAt ?? ""))
      .flatMap((item) => {
        const threadId = item.threadId!;
        const title = item.title?.trim() || "Untitled task";
        if (seen.has(threadId) || !matches(title)) return [];
        seen.add(threadId);
        return [{
          id: threadId, rolloutPath: null, title, preview: "", model: null, reasoningEffort: null, cwd: null,
          archived: false, source: null, modelProvider: null, threadSource: null, firstUserMessage: "",
          updatedAt: item.updatedAt ?? null, recencyAt: item.updatedAt ?? null
        }];
      });
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
      if (resumeHistoryMode === "chat") {
        // Only this Chat's own conversations can be reopened (AgentPane.openThread); list exactly those.
        const items = await loadOpenableChatHistory(query);
        if (requestId !== resumeHistoryRequestRef.current) return;
        setResumeHistoryItems(items);
        setResumeHistoryPage(1);
        setResumeHistoryHasMore(false);
        return;
      }
      const history = await api.unifiedCliTasks({ page, pageSize: 50, q: query || undefined });
      if (requestId !== resumeHistoryRequestRef.current) return;
      const items: TaskHistoryDialogItem[] = history.threads;
      setResumeHistoryItems((current) => (options.append ? appendUniqueTaskHistoryItems(current, items) : items));
      setResumeHistoryPage(page);
      const totalPages = Math.ceil(history.total / history.pageSize);
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
      if (resumed.focusExisting) {
        await onOpenExistingPane(resumed.pane);
        setResumeHistoryOpen(false);
        return;
      }
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

  const canSwipeNavigate =
    !titleEditOpen &&
    fullscreenCount > 1 &&
    (shellMode === "mobile" || isFullscreenLayout || pane.isMaximized);
  const showFullscreenNav = isFullscreenLayout && fullscreenCount > 1 && shellMode !== "mobile";

  const handleTitleTouchStart = (event: React.TouchEvent<HTMLDivElement>) => {
    if (!canSwipeNavigate) return;
    if (event.touches.length !== 1) {
      titleTouchStartRef.current = null;
      return;
    }
    const touch = event.touches[0];
    if (!touch) {
      titleTouchStartRef.current = null;
      return;
    }
    titleTouchStartRef.current = {
      x: touch.clientX,
      y: touch.clientY,
      time: Date.now()
    };
  };

  const handleTitleTouchEnd = (event: React.TouchEvent<HTMLDivElement>) => {
    const start = titleTouchStartRef.current;
    titleTouchStartRef.current = null;
    if (!start || !canSwipeNavigate) return;
    const touch = event.changedTouches[0];
    if (!touch) return;
    const deltaX = touch.clientX - start.x;
    const deltaY = touch.clientY - start.y;
    const elapsed = Date.now() - start.time;
    const SWIPE_MIN_DISTANCE = 40;
    const SWIPE_MAX_TIME = 800;
    if (
      elapsed <= SWIPE_MAX_TIME &&
      Math.abs(deltaX) >= SWIPE_MIN_DISTANCE &&
      Math.abs(deltaX) > Math.abs(deltaY) * 1.2
    ) {
      if (deltaX < 0) {
        onFullscreenNavigate("next", pane.id);
      } else {
        onFullscreenNavigate("previous", pane.id);
      }
    }
  };

  const handleTitleTouchCancel = () => {
    titleTouchStartRef.current = null;
  };

  async function applyPaneCategoryColor(color: PaneCategoryColor | null) {
    if (color === pane.categoryColor || categoryColorPending || paneUpdateBlockedReason) return;
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
        : pane.mode === "HARNESS"
          ? [
              `Harness pane session ID: ${pane.id}`,
              `Harness service PID: ${harnessStatus?.pid ?? "inactive"}`,
              `Harness service state: ${harnessStatus?.enabled ? "ACTIVE" : "INACTIVE"}`,
              `Harness network mode: ${harnessStatus?.effectiveMode ?? "UNKNOWN"}`,
              ...(vpnRoutingPresentation && !maskSensitiveData
                ? [`Harness VPN: ${vpnRoutingPresentation.label}`, vpnRoutingPresentation.title]
                : [])
            ].join("\n")
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
    ...(!isTerminalLoginSession && !isRootPane && pane.mode === "TERMINAL" ? [{
      id: "new-task",
      label: "New task",
      title: "Start a new CLI task",
      ariaLabel: `New task ${title}`,
      icon: Plus,
      onClick: () => dispatchTerminalPaneAction(pane.id, { action: "new_task" })
    }] : []),
    ...(!isTerminalLoginSession ? [{
      id: "import",
      // Only Chat, CLI and Live panes consume files; other panes store them with the room's files.
      label: pane.mode === "CHAT" ? "Attach files to agent" : pane.mode === "TERMINAL" ? "Upload files" : pane.mode === "LIVE" ? "Attach files" : "Upload to room files",
      title: pane.mode === "CHAT" ? "Attach files to agent" : pane.mode === "TERMINAL" ? "Upload files to CLI" : pane.mode === "LIVE" ? "Attach files to the Live conversation" : "Upload files to this room's files",
      ariaLabel: `Import files ${title}`,
      icon: Paperclip,
      onClick: openPaneImport,
      disabled: usesGenericImport && genericImportPending
    }] : []),
    ...(pane.mode === "LIVE" ? [
      { id: "live-camera", label: "Camera", title: "Capture from camera", ariaLabel: `Camera ${title}`, icon: Camera, onClick: () => window.dispatchEvent(new CustomEvent("space-live-pane-action", { detail: { paneId: pane.id, action: "camera" } })) },
      { id: "live-screen", label: "Share screen", title: "Share screen", ariaLabel: `Share screen ${title}`, icon: Monitor, onClick: () => window.dispatchEvent(new CustomEvent("space-live-pane-action", { detail: { paneId: pane.id, action: "screen" } })) },
      { id: "live-real-view", label: "Real View", title: "Share a continuous view", ariaLabel: `Real View ${title}`, icon: Eye, onClick: () => window.dispatchEvent(new CustomEvent("space-live-pane-action", { detail: { paneId: pane.id, action: "real-view" } })) }
    ] : []),
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
            icon: ClipboardList,
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
            ...(!cliModeShortcutAvailable(terminalRuntimeId, "plan") ? [] : [{
              id: "plan",
              label: "Plan mode",
              title: "Enable Plan mode",
              ariaLabel: `Enable Plan mode ${title}`,
              icon: ClipboardList,
              shortcut: terminalPlanModeShortcut(terminalRuntimeId),
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
              // Re-enabled (operator, 2026-10-11): e7545036cd had hard-disabled the pane's entry to CLI task history.
              disabled: resumePending,
              hideable: false
            },
            {
              id: "stop",
              label: "Stop task",
              title: "Stop the running CLI task",
              ariaLabel: `Stop ${title}`,
              icon: CircleStop,
              tone: "danger" as const,
              shortcut: terminalStopShortcut(terminalRuntimeId),
              onClick: () => dispatchTerminalPaneAction(pane.id, { action: "stop_task" })
            },
            {
              id: "memory",
              label: "Save to memory",
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
              label: "Copy output",
              title: "Copy CLI contents",
              ariaLabel: `Copy CLI contents ${title}`,
              icon: Copy,
              onClick: () => dispatchTerminalPaneAction(pane.id, { action: "copy" })
            },
            {
              id: "paste",
              label: "Paste text",
              title: "Paste clipboard text into CLI",
              ariaLabel: `Paste into CLI ${title}`,
              icon: Clipboard,
              onClick: () => dispatchTerminalPaneAction(pane.id, { action: "paste" })
            },
            {
              id: "paste_file",
              label: "Paste as file",
              title: "Attach clipboard text as a TXT file into CLI",
              ariaLabel: `Attach clipboard as file ${title}`,
              icon: FileInput,
              onClick: () => dispatchTerminalPaneAction(pane.id, { action: "paste_file" })
            },
            {
              id: "reconnect",
              label: "Reconnect",
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
                label: "Interrupt command",
                title: "Interrupt the running root shell command",
                ariaLabel: `Stop ${title}`,
                icon: CircleStop,
                tone: "danger" as const,
                shortcut: "Ctrl+C",
                onClick: () => dispatchTerminalPaneAction(pane.id, { action: "control_key", key: "ctrl_c" })
              },
              {
                id: "copy",
                label: "Copy output",
                title: "Copy CLI contents",
                ariaLabel: `Copy CLI contents ${title}`,
                icon: Copy,
                onClick: () => dispatchTerminalPaneAction(pane.id, { action: "copy" })
              },
              {
                id: "paste",
                label: "Paste text",
                title: "Paste clipboard text into CLI",
                ariaLabel: `Paste into CLI ${title}`,
                icon: Clipboard,
                onClick: () => dispatchTerminalPaneAction(pane.id, { action: "paste" })
              },
              {
                id: "paste_file",
                label: "Paste as file",
                title: "Attach clipboard text as a TXT file into CLI",
                ariaLabel: `Attach clipboard as file ${title}`,
                icon: FileInput,
                onClick: () => dispatchTerminalPaneAction(pane.id, { action: "paste_file" })
              },
              {
                id: "reconnect",
                label: "Reconnect",
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
      icon: Columns2,
      onClick: () => onSplit(pane, "horizontal")
    }] : []),
    ...(!isTerminalLoginSession && shellMode !== "mobile"
      ? [
          {
            id: "grow-width",
            label: "Grow pane width",
            title: canGrowColumnSpan ? "Grow pane width" : "Already uses the available columns. Choose a multi-column layout to grow this pane.",
            ariaLabel: "Grow pane width",
            icon: MoveHorizontal,
            onClick: () => void onGrowColumnSpan(pane),
            disabled: !canGrowColumnSpan
          },
          {
            id: "reset-width",
            label: "Reset pane width",
            title: canResetColumnSpan ? "Reset pane width" : "Pane width is already at its default.",
            ariaLabel: "Reset pane width",
            icon: Shrink,
            onClick: () => void onResetColumnSpan(pane),
            disabled: !canResetColumnSpan,
            hideWhenDisabled: true
          }
        ]
      : [])
  ];
  if (pane.mode === "TERMINAL" || pane.mode === "CHAT") {
    rawPaneActions = sortPaneActionsByPreferredOrder(rawPaneActions, AGENT_PANE_ACTION_ORDER);
  }
  if (pane.mode === "YOUTUBE") {
    rawPaneActions = [
      ...(onToggleYouTubeFloating ? [
        {
          id: "youtube-float",
          label: isFloatingYouTube ? "Restore pane" : "Float mini player",
          title: isFloatingYouTube ? "Restore pane to grid" : "Float mini player",
          ariaLabel: isFloatingYouTube ? `Restore ${title}` : `Float ${title}`,
          icon: isFloatingYouTube ? Maximize2 : PictureInPicture2,
          onClick: onToggleYouTubeFloating
        }
      ] : []),
      {
        id: "youtube-toolbar",
        label: youtubeToolbarHidden ? "Show YouTube toolbar" : "Hide YouTube toolbar",
        title: youtubeToolbarHidden ? "Show YouTube toolbar" : "Hide YouTube toolbar",
        ariaLabel: youtubeToolbarHidden ? "Show YouTube toolbar" : "Hide YouTube toolbar",
        icon: youtubeToolbarHidden ? Eye : EyeOff,
        onClick: () => {
          const hidden = !youtubeToolbarHidden;
          setYoutubeToolbarHidden(hidden);
          try { localStorage.setItem(youtubeToolbarStorageKey, String(hidden)); } catch { /* Keep the current pane usable without storage. */ }
        }
      }
    ];
  }
  if (pane.mode === "BROWSER") {
    rawPaneActions = [
      {
        id: "add",
        label: "Add pane",
        title: "Add pane",
        ariaLabel: `Add pane from ${title}`,
        icon: Columns2,
        onClick: () => onSplit(pane, "horizontal")
      }
    ];
  }
  if (pane.mode === "DEMOS" || pane.mode === "FILES" || pane.mode === "DATABASES" || pane.mode === "T3CODE" || pane.mode === "JOB_APPLY" || pane.mode === "MAIL_COPILOT" || pane.mode === "MARKETING_COPILOT" || pane.mode === "FREELANCE_COPILOT") {
    rawPaneActions = [
      ...(!isTerminalLoginSession ? [{
        id: "add",
        label: "Add pane",
        title: "Add pane",
        ariaLabel: `Add pane from ${title}`,
        icon: Columns2,
        onClick: () => onSplit(pane, "horizontal")
      }] : []),
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
      ...(!isTerminalLoginSession && shellMode !== "mobile" ? [
        {
          id: "grow-width",
          label: "Grow pane width",
          title: canGrowColumnSpan ? "Grow pane width" : "Already uses the available columns. Choose a multi-column layout to grow this pane.",
          ariaLabel: "Grow pane width",
          icon: MoveHorizontal,
          onClick: () => void onGrowColumnSpan(pane),
          disabled: !canGrowColumnSpan
        },
        {
          id: "reset-width",
          label: "Reset pane width",
          title: canResetColumnSpan ? "Reset pane width" : "Pane width is already at its default.",
          ariaLabel: "Reset pane width",
          icon: Shrink,
          onClick: () => void onResetColumnSpan(pane),
          disabled: !canResetColumnSpan,
          hideWhenDisabled: true
        }
      ] : [])
    ];
  }
  // Stopping a task or cancelling a login is always safe, so Codex Off never blocks them; the
  // availability rules still disable Stop when nothing runs.
  const codexMutationActionIds = new Set([
    "new-task",
    "import",
    "generate-title",
    "plan",
    "resume",
    "memory",
    "reconnect",
    "add"
  ]);
  const clipboardReadable = Boolean(getSpaceRuntime().platform.clipboard?.readText);
  const paneActions: IconToolbarAction[] = rawPaneActions.map((action) => {
    if (codexMutationBlocked && codexMutationActionIds.has(action.id)) {
      return { ...action, disabled: true, title: codexDisabledReason };
    }
    if (action.disabled) return action;
    // Items that cannot run in the pane's current state are disabled and explain why.
    const reason =
      (action.id === "add" || action.id === "youtube-add-pane" ? addPaneBlockedReason : null) ??
      (paneUpdateBlockedReason && PANE_UPDATE_ACTION_IDS.has(action.id) ? paneUpdateBlockedReason : null) ??
      (pane.mode === "LIVE" && !livePaneActionsReady && LIVE_PANE_ACTION_IDS.has(action.id) ? "The Live pane is still loading." : null) ??
      (isTerminalPane
        ? terminalActionDisabledReason(action.id, terminalRuntimeId, terminalActionAvailability, clipboardReadable)
        : pane.mode === "CHAT"
          ? agentActionDisabledReason(action.id, agentActionAvailability)
          : null);
    return reason ? { ...action, disabled: true, title: reason } : action;
  });
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
      ].map((command) => {
        const reason = command.disabled ? null : agentActionDisabledReason(command.id, agentActionAvailability);
        return reason ? { ...command, disabled: true, title: reason } : command;
      })
    : [];
  const paneToolbar = usePersistentIconToolbar({
    actions: paneActions,
    hiddenStorageKey: paneToolbarStorageKeys.hidden,
    orderStorageKey: paneToolbarStorageKeys.order,
    nonPersistentActionIds: pane.mode === "CHAT" ? ["chat-target"] : [],
    preserveUnknownActionIds: pane.mode === "CHAT" || pane.mode === "TERMINAL" || pane.mode === "BROWSER" || pane.mode === "DEMOS" || pane.mode === "FILES" || pane.mode === "DATABASES" || pane.mode === "YOUTUBE" || pane.mode === "T3CODE" || pane.mode === "JOB_APPLY" || pane.mode === "MAIL_COPILOT" || pane.mode === "MARKETING_COPILOT" || pane.mode === "FREELANCE_COPILOT",
    closeOverflowOnDragStart: shellMode === "mobile"
  });
  const modernPrimaryActionLimit = modernPanePrimaryActionCount(shellMode);
  const paneToolbarMenuActions = usesCompactPaneActions ? paneToolbar.orderedActions : paneToolbar.visibleActions;
  const paneToolbarPrimaryActionCount = uiTheme !== "classic" || pane.mode === "YOUTUBE"
    ? Math.min(modernPrimaryActionLimit, modernPrimaryActionCapacity ?? modernPrimaryActionLimit)
    : paneToolbarMenuActions.length;
  const paneToolbarRenderedActions = usesCompactPaneActions || pane.mode === "DEMOS" || pane.mode === "FILES" || pane.mode === "DATABASES" || pane.mode === "T3CODE" || pane.mode === "JOB_APPLY" || pane.mode === "MAIL_COPILOT" || pane.mode === "MARKETING_COPILOT" || pane.mode === "FREELANCE_COPILOT"
    ? []
    : (uiTheme !== "classic" || pane.mode === "YOUTUBE"
        ? paneToolbarMenuActions.slice(0, paneToolbarPrimaryActionCount)
        : paneToolbarMenuActions);
  const paneOverflowCommands: PaneOverflowCommand[] = [
    ...paneTaskCommands,
    ...(pane.mode === "YOUTUBE" ? [
      ...(onToggleYouTubeFloating ? [{
        id: "youtube-float",
        label: isFloatingYouTube ? "Restore pane" : "Float mini player",
        ariaLabel: isFloatingYouTube ? "Restore pane" : "Float mini player",
        description: isFloatingYouTube
          ? "Restore YouTube player to grid"
          : "Float YouTube player as a draggable, resizable mini window",
        icon: isFloatingYouTube ? Maximize2 : PictureInPicture2,
        onClick: onToggleYouTubeFloating
      }] : []),
      {
        id: "youtube-toolbar",
        label: youtubeToolbarHidden ? "Show YouTube toolbar" : "Hide YouTube toolbar",
        ariaLabel: youtubeToolbarHidden ? "Show YouTube toolbar" : "Hide YouTube toolbar",
        description: "Show or hide all YouTube controls without interrupting playback",
        icon: youtubeToolbarHidden ? Eye : EyeOff,
        onClick: () => {
          const hidden = !youtubeToolbarHidden;
          setYoutubeToolbarHidden(hidden);
          try { localStorage.setItem(youtubeToolbarStorageKey, String(hidden)); } catch { /* Keep the current pane usable without storage. */ }
        }
      }, {
        id: "youtube-add-pane",
        label: "Add pane",
        ariaLabel: `Add pane from ${title}`,
      description: "Add a YouTube pane",
      icon: Columns2,
      onClick: () => onSplit(pane, "horizontal")
    }] : []),
    ...(uiTheme !== "classic" && shellMode !== "mobile" && !usesCompactPaneActions && pane.mode !== "YOUTUBE"
      ? paneToolbarMenuActions.slice(paneToolbarPrimaryActionCount).map((action) => ({
          id: `toolbar-action:${action.id}`,
          label: action.label,
          description: action.title,
          ariaLabel: action.ariaLabel,
          icon: action.icon,
          onClick: action.onClick,
          disabled: action.disabled
        }))
      : []),
    ...(shellMode !== "mobile" ? [
      {
        id: "pane-maximize-command",
        label: isFullscreenLayout || showRestoreIcon ? "Restore" : "Maximize",
        placement: "quick" as const,
        ariaLabel: maximizeLabel,
        description: isFullscreenLayout ? "Restore all panes from fullscreen view" : showRestoreIcon ? "Restore pane to grid" : "Maximize pane to fill the room",
        icon: isFullscreenLayout ? Grid2X2 : showRestoreIcon ? Minimize2 : Maximize2,
        disabled: Boolean(paneUpdateBlockedReason) && !isFullscreenLayout,
        title: paneUpdateBlockedReason && !isFullscreenLayout ? paneUpdateBlockedReason : undefined,
        onClick: () => {
          paneToolbar.closeMenus();
          if (isFullscreenLayout) {
            onRestoreLayout?.();
            return;
          }
          onTarget(pane.id);
          onMaximize(pane);
        }
      },
      {
        id: "pane-minimize-command",
        label: "Minimize",
        placement: "quick" as const,
        ariaLabel: `Minimize pane ${title}`,
        description: "Minimize pane to the bottom bar",
        icon: Minus,
        disabled: Boolean(paneUpdateBlockedReason),
        title: paneUpdateBlockedReason ?? undefined,
        onClick: () => {
          paneToolbar.closeMenus();
          onMinimize(pane);
        }
      }
    ] : [])
  ];
  useLayoutEffect(() => {
    // Retain the last measured desktop layout while hidden. Resetting it here
    // expands the toolbar only to collapse it again on the next room reveal.
    // The visible pass below still measures current geometry before paint.
    if (!isVisibleInShell) return;
    if (shellMode === "mobile") {
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

    const measurementInputs = JSON.stringify([
      isTerminalPane, modernPrimaryActionLimit, pane.mode,
      paneToolbarRenderedActions.length, pane.title, shellMode,
      titleEditOpen, uiTheme, vpnRoutingPresentation?.label, youtubeFloatFits
    ]);

    const measureHeaderLayout = () => {
      const headerWidth = headerElement.clientWidth;
      if (headerWidth <= 0) {
        // A hidden ancestor has no usable geometry. ResizeObserver will
        // measure again when the header receives its visible dimensions.
        return;
      }
      measuredHeaderInputsRef.current = measurementInputs;

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
      if (pane.mode === "YOUTUBE") {
        const actionWidth = actionButtons[0]?.offsetWidth || remToPx(2.25);
        const titleInlineWidth = titleEditOpen
          ? remToPx(12)
          : Math.min(
              Math.max(measureSingleLineTitleWidth(titleTextRef.current, 8), remToPx(8)),
              remToPx(16)
            );
        const nextCapacity = modernPanePrimaryActionCapacity({
          availableWidth: headerWidth,
          paddingLeft,
          paddingRight,
          badgeWidth,
          titleWidth: titleInlineWidth,
          fixedWidth: fixedInlineWidth,
          columnGap: headerGap,
          actionWidth,
          actionGap: actionsGap,
          maxActions: Math.min(modernPrimaryActionLimit, paneActions.length)
        });
        setYoutubeFloatFits(nextCapacity > 0);
        setIsHeaderActionsStacked(false);
        setModernPrimaryActionCapacity((current) => current === nextCapacity ? current : nextCapacity);
        return;
      }
      if (uiTheme !== "classic") {
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

    // On an unchanged room return, keep the measured header until ResizeObserver
    // delivers its initial sizes before paint. Reading here forces layout in
    // React's commit for every returning pane. Content changes still measure now.
    if (typeof ResizeObserver === "undefined" || measuredHeaderInputsRef.current !== measurementInputs) {
      measureHeaderLayout();
    }
    const resizeObserver = typeof ResizeObserver !== "undefined" ? new ResizeObserver((entries) => {
      // A reconnected observer reports every target again on warm return.
      // Reuse the header layout if all browser-delivered boxes are unchanged.
      const changed = entries.length === 0 || entries.some(({ target, contentRect }) => {
        const previous = observedHeaderBoxes.get(target);
        return !previous || previous.width !== contentRect.width || previous.height !== contentRect.height;
      });
      for (const { target, contentRect } of entries) {
        observedHeaderBoxes.set(target, { width: contentRect.width, height: contentRect.height });
      }
      if (changed) measureHeaderLayout();
    }) : null;
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
    pane.mode,
    paneToolbarRenderedActions.length,
    pane.title,
    shellMode,
    titleEditOpen,
    uiTheme,
    vpnRoutingPresentation?.label,
    youtubeFloatFits
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
      ref={paneArticleRef}
      className={`${pane.isMaximized ? "pane-card is-maximized" : "pane-card"}${pane.isMinimized ? " is-minimized" : ""}${isFloatingYouTube ? " is-floating-mini-player" : ""}${isPointerActive ? " is-pointer-active" : ""}${isTarget ? " is-target" : ""}${hasPendingCompletion ? " is-completion-pending" : ""}${pane.mode === "BROWSER" ? " browser-pane-card" : ""}${pane.mode === "YOUTUBE" ? " youtube-pane-card" : ""}${pane.mode === "CHAT" ? " chat-pane-card" : ""}${pane.mode === "T3CODE" ? " t3code-pane-card" : ""}${isVisibleInShell ? "" : " is-shell-hidden"}${draggedPaneId === pane.id ? " is-dragging" : ""}${dragOverPaneId === pane.id && draggedPaneId !== pane.id ? ` is-drop-target is-drop-target-${dragOverPosition ?? "before"}` : ""}`}
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
      data-drop-position={dragOverPaneId === pane.id && draggedPaneId !== pane.id ? (dragOverPosition ?? "before") : undefined}
      data-completion-state={completionState}
      data-minimized={pane.isMinimized ? "true" : "false"}
      data-shell-visible={isVisibleInShell ? "true" : "false"}
      aria-hidden={isPresentationInteractive && !isVisibleInShell ? true : undefined}
      aria-label={`${title} agent ${agentNumber}`}
      style={isFloatingYouTube ? {
        position: "fixed",
        left: `${floatLayout.x}px`,
        top: `${floatLayout.y}px`,
        width: `${floatLayout.width}px`,
        height: `${floatLayout.height}px`,
        zIndex: 1200,
        minWidth: "240px",
        minHeight: "160px",
        transform: youtubeDodgeShiftX > 0 ? `translateX(-${youtubeDodgeShiftX}px)` : undefined,
        transition: isPointerActive ? "none" : "transform 0.22s cubic-bezier(0.2, 0, 0, 1)"
      } : paneCardStyle}
      onPointerDownCapture={() => {
        lastPanePointerDownAtRef.current = performance.now();
        onTarget(pane.id);
      }}
      onDragOver={(event) => onPaneDragOver(event, pane.id)}
      onDragLeave={() => onPaneDragLeave(pane.id)}
      onDrop={(event) => {
        event.preventDefault();
        // Only the drop target carries a position; others fall back to App state.
        void onPaneDrop(pane.id, dragOverPaneId === pane.id ? dragOverPosition : undefined);
      }}
      onFocusCapture={(event) => {
        if (event.target instanceof Element && event.target.classList.contains("xterm-helper-textarea")) {
          // Programmatic .focus() is also trusted, so restoring or revealing a terminal must not steal
          // the active pane (9a56ff83a1); only focus that follows a real press in this pane retargets.
          if (event.isTrusted && performance.now() - lastPanePointerDownAtRef.current < 1_000) onTarget(pane.id);
          return;
        }
        onTarget(pane.id);
      }}
    >
      {usesGenericImport ? (
        <input
          ref={genericUploadInputRef}
          type="file"
          name="pane-import-files"
          multiple
          accept="*/*"
          hidden
          onChange={(event) => {
            const files = event.currentTarget.files ? Array.from(event.currentTarget.files) : [];
            event.currentTarget.value = "";
            if (files.length) void importGenericPaneFiles(files);
          }}
        />
      ) : null}
      {isFloatingYouTube ? (
        <header
          className="pane-card-header youtube-mini-float-header"
          onPointerDown={handleFloatHeaderPointerDown}
        >
          <GripVertical className="youtube-mini-float-drag-icon" aria-hidden="true" />
          <Youtube className="youtube-mini-float-icon" aria-hidden="true" />
          <span className="youtube-mini-float-title" title={title}>
            {title}
          </span>
          <div className="youtube-mini-float-actions">
            <button
              type="button"
              className="youtube-mini-float-btn"
              title={youtubeToolbarHidden ? "Show YouTube toolbar" : "Hide YouTube toolbar"}
              aria-label={youtubeToolbarHidden ? "Show YouTube toolbar" : "Hide YouTube toolbar"}
              onClick={() => {
                const hidden = !youtubeToolbarHidden;
                setYoutubeToolbarHidden(hidden);
                try { localStorage.setItem(youtubeToolbarStorageKey, String(hidden)); } catch {}
              }}
            >
              {youtubeToolbarHidden ? <Eye aria-hidden="true" /> : <EyeOff aria-hidden="true" />}
            </button>
            <button
              type="button"
              className="youtube-mini-float-btn"
              title="Restore pane to grid"
              aria-label="Restore pane to grid"
              onClick={onToggleYouTubeFloating}
            >
              <Maximize2 aria-hidden="true" />
            </button>
            <button
              type="button"
              className="youtube-mini-float-btn"
              title="Close mini player"
              aria-label="Close mini player"
              onClick={onToggleYouTubeFloating}
            >
              <X aria-hidden="true" />
            </button>
          </div>
        </header>
      ) : (
        <header
          ref={paneHeaderRef}
          className={isHeaderActionsStacked ? "is-actions-stacked" : undefined}
          data-fullscreen-nav={showFullscreenNav ? "true" : undefined}
          tabIndex={-1}
          title={title}
          draggable={!paneReorderPending && !titleEditOpen}
        onDragStart={(event) => {
          const target = event.target as HTMLElement | null;
          if (target?.closest('button, input, form, select, textarea, .pane-title-detail-content, .task-title-popover, .icon-context-menu, [role="menu"]')) {
            return;
          }
          const openDetails = paneHeaderRef.current?.querySelector<HTMLDetailsElement>('details.pane-title-details[open]');
          if (openDetails) openDetails.open = false;
          onPaneDragStart(event, pane);
        }}
        onDragEnd={onPaneDragEnd}
      >
        <div ref={paneBadgeRef} className="pane-header-identity" {...badgeTouchContext}>
          {(
            <div
              className={`pane-agent-badge${vpnRoutingPresentation ? ` has-vpn-routing is-${vpnRoutingPresentation.tone}` : ""}${draggedPaneId === pane.id ? " is-dragging" : ""}`}
              title={paneIdentityTitle}
              role="img"
              aria-label={paneIdentityTitle}
              data-category-color={pane.categoryColor ?? undefined}
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
              {pane.mode !== "LIVE" ? (
                <button
                  type="button"
                  role="menuitem"
                  disabled={Boolean(sessionInfoUnavailableReason)}
                  title={sessionInfoUnavailableReason ?? undefined}
                  onClick={() => void copyPaneIdentityInfo()}
                >
                  <Copy aria-hidden="true" />
                  Copy session info
                </button>
              ) : null}
              {!isTerminalLoginSession ? (
                <button
                  type="button"
                  role="menuitem"
                  disabled={titleSavePending || titleGeneratePending || Boolean(paneUpdateBlockedReason)}
                  title={paneUpdateBlockedReason ?? undefined}
                  onClick={() => {
                    setBadgeMenuPosition(null);
                    beginTitleEdit();
                  }}
                >
                  <Pencil aria-hidden="true" />
                  Edit pane title
                </button>
              ) : null}
              {canGeneratePaneTitle ? (
                <button
                  type="button"
                  role="menuitem"
                  disabled={titleSavePending || titleGeneratePending || Boolean(generateTitleBlockedReason)}
                  title={generateTitleBlockedReason ?? undefined}
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
                    title={paneUpdateBlockedReason ?? color}
                    disabled={categoryColorPending || Boolean(paneUpdateBlockedReason) || pane.categoryColor === color}
                    onClick={() => void applyPaneCategoryColor(color)}
                  />
                ))}
                <button
                  type="button"
                  className={`category-swatch none${pane.categoryColor === null ? " selected" : ""}`}
                  aria-label="Clear category color"
                  aria-pressed={pane.categoryColor === null}
                  title={paneUpdateBlockedReason ?? "No color"}
                  disabled={categoryColorPending || Boolean(paneUpdateBlockedReason) || pane.categoryColor === null}
                  onClick={() => void applyPaneCategoryColor(null)}
                >
                  <X aria-hidden="true" />
                </button>
              </div>
            </div>
          ) : null}
        </div>
        <div
          className="pane-title-block"
          data-swipe-nav={canSwipeNavigate ? "true" : undefined}
          onTouchStart={handleTitleTouchStart}
          onTouchEnd={handleTitleTouchEnd}
          onTouchCancel={handleTitleTouchCancel}
        >
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
                <button
                  type="submit"
                  className="pane-title-save"
                  title="Save pane title"
                  aria-label="Save pane title"
                  disabled={titleSavePending || titleGeneratePending}
                >
                  <Save aria-hidden="true" />
                </button>
                <button
                  type="button"
                  className="pane-title-cancel"
                  title="Cancel pane title"
                  aria-label="Cancel pane title"
                  onClick={cancelTitleEdit}
                  disabled={titleSavePending || titleGeneratePending}
                >
                  <Undo2 aria-hidden="true" />
                </button>
              </form>
            ) : (
              <>
                <TaskTitleDetails pane={pane} displayTitle={title} titleRef={titleTextRef} disabled={codexMutationBlocked} onRename={beginTitleEdit} onUpdated={onPaneUpdated} />
                {pane.cwd && (pane.cwd.includes("/var/worktrees/") || pane.cwd.includes("/worktrees/") || pane.cwd.includes("/agent-workspace/")) ? (
                  <WorktreeBadge
                    worktreePath={pane.cwd}
                    branch={pane.cwd.split("/").pop()}
                    onMerged={() => {
                      onPaneUpdated?.(pane);
                    }}
                    onRemoved={() => { onClose(pane.id); }}
                  />
                ) : null}
                {(pane.mode === "TERMINAL" || pane.mode === "CHAT" || pane.mode === "HARNESS") ? (
                  <PaneWorkingTimeBadge
                    paneId={pane.id}
                    paneCreatedAt={pane.createdAt}
                    categoryColor={pane.categoryColor}
                    isWorking={effectiveIsWorking}
                    screenWorkingMs={paneWorkingState.screenWorkingMs}
                  />
                ) : null}
              </>
            )}
          </div>
          {titleError ? (
            <small className="pane-title-hint" role="alert">
              {titleError}
            </small>
          ) : null}
        </div>
        <div className="pane-actions" ref={paneActionsRef}>
          {showFullscreenNav ? (
            <div className="pane-fullscreen-nav" role="group" aria-label={`Pane navigation, pane ${fullscreenIndex + 1} of ${fullscreenCount}`}>
              <button
                type="button"
                className="pane-fullscreen-nav-button"
                title="Previous pane"
                aria-label="Previous pane"
                disabled={fullscreenCount < 2}
                onClick={() => onFullscreenNavigate("previous", pane.id)}
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
                onClick={() => onFullscreenNavigate("next", pane.id)}
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
                  actionSections={pane.mode === "YOUTUBE" ? [] : undefined}
                  commandSectionLabel={pane.mode === "YOUTUBE" ? "Quick actions" : undefined}
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
                  plainActions={usesCompactPaneActions || pane.mode === "YOUTUBE" || pane.mode === "DEMOS" || pane.mode === "FILES" || pane.mode === "DATABASES" || pane.mode === "T3CODE" || pane.mode === "JOB_APPLY" || pane.mode === "MAIL_COPILOT" || pane.mode === "MARKETING_COPILOT" || pane.mode === "FREELANCE_COPILOT"}
                  popupId={paneActionsPopupId}
                  triggerRef={paneOverflowTriggerRef}
                />
              ) : (
                <DesktopActionManager
                  // YouTube's actions are already listed as Quick actions; the mobile sheet hides them the same way.
                  actions={pane.mode === "YOUTUBE" ? [] : paneToolbar.orderedActions}
                  commandSectionLabel={pane.mode === "YOUTUBE" || uiTheme !== "classic" ? "Quick actions" : "Task commands"}
                  commands={paneOverflowCommands}
                  hiddenActionIds={paneToolbar.hiddenActionIds}
                  label={`Pane actions ${title}`}
                  onClose={paneToolbar.closeMenus}
                  onHideAction={paneToolbar.hideAction}
                  onReorderAction={paneToolbar.moveAction}
                  onRunAction={(action) => {
                    paneToolbar.setIsOverflowOpen(false);
                    action.onClick();
                  }}
                  onRunCommand={(command) => {
                    paneToolbar.setIsOverflowOpen(false);
                    command.onClick();
                  }}
                  onShowAction={(actionId) => {
                    if (uiTheme !== "classic") {
                      paneToolbar.showActionInPrimary(actionId, paneToolbarPrimaryActionCount);
                    } else {
                      paneToolbar.showAction(actionId);
                    }
                  }}
                  onResetOrder={paneToolbar.resetOrder}
                  isOrderCustomized={paneToolbar.isOrderCustomized}
                  plainActions={usesCompactPaneActions || pane.mode === "YOUTUBE" || pane.mode === "DEMOS" || pane.mode === "FILES" || pane.mode === "DATABASES" || pane.mode === "T3CODE" || pane.mode === "JOB_APPLY" || pane.mode === "MARKETING_COPILOT" || pane.mode === "FREELANCE_COPILOT"}
                  preferPaneInside={pane.mode === "CHAT"}
                  primaryActionIds={uiTheme !== "classic" ? paneToolbarRenderedActions.map((action) => action.id) : undefined}
                  popupId={paneActionsPopupId}
                  triggerRef={paneOverflowTriggerRef}
                />
              )
            ) : null}
          </div>
          {shellMode !== "mobile" ? <button
            type="button"
            className={`pane-maximize-toggle${(showRestoreIcon || isFullscreenLayout) ? " is-active" : ""}`}
            title={paneUpdateBlockedReason && !isFullscreenLayout ? paneUpdateBlockedReason : maximizeLabel}
            aria-label={maximizeLabel}
            aria-pressed={showRestoreIcon || isFullscreenLayout}
            disabled={Boolean(paneUpdateBlockedReason) && !isFullscreenLayout}
            onClick={() => {
              paneToolbar.closeMenus();
              if (isFullscreenLayout) {
                onRestoreLayout?.();
                return;
              }
              onTarget(pane.id);
              onMaximize(pane);
            }}
          >
            {isFullscreenLayout ? (
              <Grid2X2 aria-hidden="true" />
            ) : showRestoreIcon ? (
              <Minimize2 aria-hidden="true" />
            ) : (
              <Maximize2 aria-hidden="true" />
            )}
          </button> : null}
          {shellMode !== "mobile" ? (
            <button
              type="button"
              className="pane-minimize-button"
              title={paneUpdateBlockedReason ?? "Minimize pane"}
              aria-label={`Minimize pane ${title}`}
              disabled={Boolean(paneUpdateBlockedReason)}
              onClick={() => {
                paneToolbar.closeMenus();
                onMinimize(pane);
              }}
            >
              <Minus aria-hidden="true" />
            </button>
          ) : null}
          <button
            type="button"
            className="pane-close-button"
            title="Close pane"
            aria-label="Close pane"
            onClick={() => onClose(pane.id)}
          >
            <X aria-hidden="true" />
          </button>
        </div>
      </header>
      )}
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
          <RecoverableSurface fallback={agentPaneLoadingFallback}>
            <LazyAgentPane
              pane={pane}
              codexEnvironment={codexEnvironment}
              workspaceTextSize={terminalFontSize}
              isVisible={isVisibleInShell && !pane.isMinimized}
              onSessionIdentityChange={setAgentPaneIdentity}
              onActionAvailabilityChange={handleAgentActionAvailabilityChange}
              onWorkingStateChange={handleWorkingStateChange}
            />
          </RecoverableSurface>
        ) : pane.mode === "TERMINAL" ? (
          <RecoverableSurface fallback={terminalPaneLoadingFallback} resetKey={pane.id}>
          <TerminalPane
            pane={pane}
            terminalFontSize={terminalFontSize}
            bootstrapBarrier={terminalBootstrapBarrier}
            shouldBootstrap={shouldBootstrapTerminal && !pane.id.startsWith("pane:optimistic-")}
            prefillInitialReplay={prefillInitialReplay}
            revealGeneration={revealGeneration}
            hideFloatingControls={hideCliFloats}
            isTarget={isTarget}
            isVisible={isTerminalOutputVisible}
            fullscreenLayout={isFullscreenLayout}
            presizeInFullscreen={presizeInFullscreen}
            cliDebugModeEnabled={cliDebugModeEnabled}
            observerOnly={terminalObserverOnly}
            maxImagePreviews={cliImagePreviewLimit}
            onCliDebugModeChange={onCliDebugModeChange}
            onSessionMetadataChange={setTerminalSessionMetadata}
            onActionAvailabilityChange={handleTerminalActionAvailabilityChange}
            onBootstrapped={handleTerminalBootstrapped}
            onPrefillReadyChange={handleTerminalPrefillReadyChange}
            onRevealReady={handleTerminalRevealReady}
            onWorkingStateChange={handleWorkingStateChange}
            oskOpen={oskOpen}
            mobile={shellMode === "mobile" || isCoarsePointer}
          />
          </RecoverableSurface>
        ) : pane.mode === "BROWSER" ? (
          <RecoverableSurface fallback={browserPaneLoadingFallback}>
            <LazyBrowserPane
              mobile={shellMode === "mobile" || isCoarsePointer}
              isVisible={isVisibleInShell}
              pane={pane}
              agentNumber={agentNumber}
              observerOnly={browserObserverOnly}
              uiTheme={uiTheme}
            />
          </RecoverableSurface>
        ) : pane.mode === "YOUTUBE" ? (
          <RecoverableSurface fallback={browserPaneLoadingFallback}>
            <LazyYouTubePane
              onVideoTitleChange={setYoutubeVideoTitle}
              toolbarHidden={youtubeToolbarHidden}
              pane={pane}
              agentNumber={agentNumber}
              observerOnly={browserObserverOnly}
              uiTheme={uiTheme}
              isFloating={isFloatingYouTube}
              onToggleFloat={onToggleYouTubeFloating}
            />
          </RecoverableSurface>
        ) : pane.mode === "VNC" ? (
          <RecoverableSurface fallback={browserPaneLoadingFallback}>
            <LazyVncPane pane={pane} observerOnly={browserObserverOnly} />
          </RecoverableSurface>
        ) : pane.mode === "HARNESS" && shouldLoadHarness ? (
          <RecoverableSurface fallback={browserPaneLoadingFallback}>
            <LazyHarnessPane pane={pane} workspaceTextSize={terminalFontSize} isVisible={isVisibleInShell} />
          </RecoverableSurface>
        ) : pane.mode === "HARNESS" ? (
          <div className="harness-pane" data-harness-deferred="true" aria-hidden="true" />
        ) : pane.mode === "LIVE" ? (
          <RecoverableSurface fallback={browserPaneLoadingFallback}>
            <LazyLivePane pane={pane} workspaceTextSize={terminalFontSize} mobile={shellMode === "mobile" || isCoarsePointer} onActionsReady={setLivePaneActionsReady} />
          </RecoverableSurface>
        ) : pane.mode === "FILES" ? (
          <RecoverableSurface fallback={browserPaneLoadingFallback} resetKey={pane.id}>
            <LazyFilesPane pane={pane} uiTheme={uiTheme} mobile={shellMode === "mobile" || isCoarsePointer} projectPath={roomProjectPath} />
          </RecoverableSurface>
        ) : pane.mode === "DATABASES" ? (
          <RecoverableSurface fallback={browserPaneLoadingFallback} resetKey={pane.id}>
            <LazyDatabasesPane pane={pane} uiTheme={uiTheme} mobile={shellMode === "mobile" || isCoarsePointer} projectPath={roomProjectPath} />
          </RecoverableSurface>
        ) : pane.mode === "DEMOS" ? (
          <RecoverableSurface fallback={browserPaneLoadingFallback}>
            <LazyDemosPane pane={pane} uiTheme={uiTheme} isVisible={isVisibleInShell} />
          </RecoverableSurface>
        ) : pane.mode === "JOB_APPLY" ? (
          <RecoverableSurface fallback={browserPaneLoadingFallback} resetKey={pane.id}>
            <LazyJobApplyPane
              pane={pane}
              isVisible={isVisibleInShell}
              terminal={(
                <TerminalPane
                  pane={pane}
                  terminalFontSize={terminalFontSize}
                  bootstrapBarrier={terminalBootstrapBarrier}
                  shouldBootstrap={shouldBootstrapTerminal && !pane.id.startsWith("pane:optimistic-")}
                  prefillInitialReplay={prefillInitialReplay}
                  revealGeneration={revealGeneration}
                  hideFloatingControls={hideCliFloats}
                  isTarget={isTarget}
                  isVisible={isTerminalOutputVisible}
                  fullscreenLayout={isFullscreenLayout}
                  presizeInFullscreen={presizeInFullscreen}
                  cliDebugModeEnabled={cliDebugModeEnabled}
                  observerOnly={terminalObserverOnly}
                  maxImagePreviews={cliImagePreviewLimit}
                  onCliDebugModeChange={onCliDebugModeChange}
                  onSessionMetadataChange={setTerminalSessionMetadata}
                  onActionAvailabilityChange={handleTerminalActionAvailabilityChange}
                  onBootstrapped={handleTerminalBootstrapped}
                  onPrefillReadyChange={handleTerminalPrefillReadyChange}
                  onRevealReady={handleTerminalRevealReady}
                  onWorkingStateChange={handleWorkingStateChange}
                  oskOpen={oskOpen}
                  mobile={shellMode === "mobile" || isCoarsePointer}
                />
              )}
              browser={(
                <RecoverableSurface fallback={browserPaneLoadingFallback}>
                  <LazyBrowserPane
                    mobile={shellMode === "mobile" || isCoarsePointer}
                    isVisible={isVisibleInShell}
                    pane={pane}
                    agentNumber={agentNumber}
                    observerOnly={browserObserverOnly}
                    uiTheme={uiTheme}
                  />
                </RecoverableSurface>
              )}
            />
          </RecoverableSurface>
        ) : pane.mode === "MARKETING_COPILOT" || pane.mode === "FREELANCE_COPILOT" ? (
          <RecoverableSurface fallback={browserPaneLoadingFallback} resetKey={pane.id}>
            <BrowserCopilotPane
              pane={pane}
              isVisible={isVisibleInShell}
              terminal={(
                <TerminalPane
                  pane={pane}
                  terminalFontSize={terminalFontSize}
                  bootstrapBarrier={terminalBootstrapBarrier}
                  shouldBootstrap={shouldBootstrapTerminal && !pane.id.startsWith("pane:optimistic-")}
                  prefillInitialReplay={prefillInitialReplay}
                  revealGeneration={revealGeneration}
                  hideFloatingControls={hideCliFloats}
                  isTarget={isTarget}
                  isVisible={isTerminalOutputVisible}
                  fullscreenLayout={isFullscreenLayout}
                  presizeInFullscreen={presizeInFullscreen}
                  cliDebugModeEnabled={cliDebugModeEnabled}
                  observerOnly={terminalObserverOnly}
                  maxImagePreviews={cliImagePreviewLimit}
                  onCliDebugModeChange={onCliDebugModeChange}
                  onSessionMetadataChange={setTerminalSessionMetadata}
                  onActionAvailabilityChange={handleTerminalActionAvailabilityChange}
                  onBootstrapped={handleTerminalBootstrapped}
                  onPrefillReadyChange={handleTerminalPrefillReadyChange}
                  onRevealReady={handleTerminalRevealReady}
                  onWorkingStateChange={handleWorkingStateChange}
                  oskOpen={oskOpen}
                  mobile={shellMode === "mobile" || isCoarsePointer}
                />
              )}
              browser={(
                <RecoverableSurface fallback={browserPaneLoadingFallback}>
                  <LazyBrowserPane
                    mobile={shellMode === "mobile" || isCoarsePointer}
                    isVisible={isVisibleInShell}
                    pane={pane}
                    agentNumber={agentNumber}
                    observerOnly={browserObserverOnly}
                    uiTheme={uiTheme}
                  />
                </RecoverableSurface>
              )}
            />
          </RecoverableSurface>
        ) : pane.mode === "MAIL_COPILOT" ? (
          <RecoverableSurface fallback={browserPaneLoadingFallback} resetKey={pane.id}>
            <LazyMailCopilotPane
              pane={pane}
              isVisible={isVisibleInShell}
              terminal={(
                <TerminalPane
                  pane={pane}
                  terminalFontSize={terminalFontSize}
                  bootstrapBarrier={terminalBootstrapBarrier}
                  shouldBootstrap={shouldBootstrapTerminal && !pane.id.startsWith("pane:optimistic-")}
                  prefillInitialReplay={prefillInitialReplay}
                  revealGeneration={revealGeneration}
                  hideFloatingControls={hideCliFloats}
                  isTarget={isTarget}
                  isVisible={isTerminalOutputVisible}
                  fullscreenLayout={isFullscreenLayout}
                  presizeInFullscreen={presizeInFullscreen}
                  cliDebugModeEnabled={cliDebugModeEnabled}
                  observerOnly={terminalObserverOnly}
                  maxImagePreviews={cliImagePreviewLimit}
                  onCliDebugModeChange={onCliDebugModeChange}
                  onSessionMetadataChange={setTerminalSessionMetadata}
                  onActionAvailabilityChange={handleTerminalActionAvailabilityChange}
                  onBootstrapped={handleTerminalBootstrapped}
                  onPrefillReadyChange={handleTerminalPrefillReadyChange}
                  onRevealReady={handleTerminalRevealReady}
                  onWorkingStateChange={handleWorkingStateChange}
                  oskOpen={oskOpen}
                  mobile={shellMode === "mobile" || isCoarsePointer}
                />
              )}
            />
          </RecoverableSurface>
        ) : pane.mode === "T3CODE" ? (
          <RecoverableSurface fallback={browserPaneLoadingFallback} resetKey={pane.id}>
            <LazyT3CodePane pane={pane} isVisible={isVisibleInShell} />
          </RecoverableSurface>
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
      {isFloatingYouTube ? (
        <div
          className="youtube-mini-float-resize-handle"
          onPointerDown={handleResizePointerDown}
          title="Drag to resize mini player"
          aria-hidden="true"
        />
      ) : null}
    </article>
  );
});

export function extractAgentResponseFromEvent(event: SpaceEvent): string | null {
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
