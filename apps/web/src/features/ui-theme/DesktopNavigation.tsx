import { dispatchRailMenuChange, railPopoverPosition, useMenuWheel } from "../rail-popover.js";
import { Fragment, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import type { IconToolbarAction } from "../../icon-toolbar.js";
import { Check, ChevronLeft, ChevronRight, Cpu, EyeOff, Grid2X2, GripVertical, Minus, MoreHorizontal, Pin, Plus, Search, ShieldCheck, SlidersHorizontal, Sparkles, UserCheck, Wrench, X } from "./app-icons.js";
import { WorkspaceSurface } from "./WorkspaceSurface.js";
import { desktopActionDescriptions, desktopActionGroup, desktopActionVisible, desktopGroups, type DesktopGroup } from "./desktop-navigation.js";
import { WORKSPACE_MENU_CATEGORY_KEY, WORKSPACE_QUICK_ACTION_LIMIT, WORKSPACE_QUICK_ACTIONS_KEY, workspaceActionCategory, workspaceActionColor, workspaceActionLabel, workspaceActionToggle, workspaceCategories, workspaceFooterActionIds, workspacePageTabActionIds, workspaceQuickActionIds, type WorkspaceCategory } from "./workspace-actions.js";
import { ACTION_TO_LOWER_RAIL_ID, LOWER_RAIL_HIDDEN_KEY, LOWER_RAIL_NON_HIDEABLE, LOWER_RAIL_VISIBILITY_IDS, readHiddenRailIds } from "./use-rail-visibility.js";
import { LOWER_RAIL_IDS } from "./use-rail-order.js";
import { shouldPreserveForSnipTool } from "../snip-tool/snip-guard.js";
import { saveUserSettingDebounced } from "../user-settings/user-settings-manager.js";
import { useWidgetsVisibility, type DesktopWidgetId } from "../desktop-widgets/index.js";
import { dockOrderRank, useDocksVisibility } from "../docks/use-docks-visibility.js";
import "./desktop-navigation.css";

const navigationOpenEvent = "space:navigation-open";
const mobileWidth = 767;
const shortcutLabel = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘K" : "Ctrl+K";

function readQuickActionIds(): string[] {
  try {
    const raw = window.localStorage.getItem(WORKSPACE_QUICK_ACTIONS_KEY);
    if (raw === null) return [...workspaceQuickActionIds];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [...workspaceQuickActionIds];
    return [...new Set(parsed.filter((id): id is string => typeof id === "string"))].slice(0, WORKSPACE_QUICK_ACTION_LIMIT);
  } catch {
    return [...workspaceQuickActionIds];
  }
}

function readStoredCategory(): WorkspaceCategory | null {
  try {
    const value = window.localStorage.getItem(WORKSPACE_MENU_CATEGORY_KEY);
    return workspaceCategories.find(item => item.id === value)?.id ?? null;
  } catch {
    return null;
  }
}

// Terminals, editors and form fields keep Ctrl+K (readline uses it to kill a line).
function isTypingTarget(target: EventTarget | null) {
  if (!(target instanceof Element)) return false;
  if (target.closest(".xterm, [contenteditable=''], [contenteditable='true']")) return true;
  return target.matches("input, textarea, select") || (target as HTMLElement).isContentEditable === true;
}
export function DesktopNavigation({ actions, adminMode, canAdmin, onModeChange, onAction, footer, version, renderCreateTools, renderWorkspaceAction, onWorkspaceDetailChange, workspaceDetailActionIds = [], createOnly = false, docksOnly = false, toolsOnly = false, workspaceOnly = false, hiddenRailIds, emptySlots, availablePanes }: {
  createOnly?: boolean; docksOnly?: boolean; toolsOnly?: boolean; workspaceOnly?: boolean;
  actions: IconToolbarAction[]; adminMode: boolean; canAdmin: boolean;
  onModeChange: () => void;
  onAction: (action: IconToolbarAction, anchor: HTMLButtonElement, count?: number) => void;
  footer?: ReactNode; version?: ReactNode;
  workspaceDetailActionIds?: readonly string[];
  onWorkspaceDetailChange?: (id: string | null) => void;
  renderWorkspaceAction?: (id: string, options: { onBack: () => void; onNavigate: (id: string) => void; triggerRef: RefObject<HTMLButtonElement | null> }) => ReactNode;
  renderCreateTools?: (options: {
    query: string;
    onClose: () => void;
    triggerRef: RefObject<HTMLButtonElement | null>;
    paneCount?: number;
    onPaneCountChange?: (count: number | ((prev: number) => number)) => void;
    onNavigate?: (id: string) => void;
    availablePanes?: number;
  }) => ReactNode;
  hiddenRailIds?: string[];
  emptySlots?: {
    count: number;
    min: number;
    max: number;
    onIncrement: () => void;
    onDecrement: () => void;
  };
  availablePanes?: number;
}) {
  const instance = useId();
  const railOnly = createOnly || docksOnly || toolsOnly || workspaceOnly;
  const menuId = `workspace-navigation-${instance}`;
  const [persistedHiddenRailIds, setPersistedHiddenRailIds] = useState<string[]>(() => {
    if (typeof window === "undefined") return [];
    return readHiddenRailIds(LOWER_RAIL_HIDDEN_KEY, LOWER_RAIL_VISIBILITY_IDS, LOWER_RAIL_NON_HIDEABLE);
  });
  useEffect(() => {
    if (hiddenRailIds !== undefined) return;
    const update = () => {
      setPersistedHiddenRailIds(readHiddenRailIds(LOWER_RAIL_HIDDEN_KEY, LOWER_RAIL_VISIBILITY_IDS, LOWER_RAIL_NON_HIDEABLE));
    };
    window.addEventListener("storage", update);
    return () => window.removeEventListener("storage", update);
  }, [hiddenRailIds]);
  const activeHiddenRailIds = hiddenRailIds ?? persistedHiddenRailIds;
  const { isWidgetHidden } = useWidgetsVisibility();
  const [open, setOpen] = useState<DesktopGroup | null>(null);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<WorkspaceCategory>("docks");
  const [quickIds, setQuickIds] = useState<string[]>(readQuickActionIds);
  const [customizing, setCustomizing] = useState(false);
  const [quickNotice, setQuickNotice] = useState<string | null>(null);
  const [quickDrag, setQuickDrag] = useState<{ id: string; over: string | null } | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [detailHistory, setDetailHistory] = useState<string[]>([]);
  const detail = useRef<HTMLDivElement>(null);
  const detailTrigger = useRef<HTMLButtonElement | null>(null);
  const [compact, setCompact] = useState(false);
  const [mobile, setMobile] = useState(() => window.innerWidth <= mobileWidth);
  const nav = useRef<HTMLElement>(null);
  const triggers = useRef<Partial<Record<DesktopGroup, HTMLButtonElement | null>>>({});
  const menu = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const createTrigger = useRef<HTMLButtonElement | null>(null);
  useMenuWheel(menu, ".desktop-menu-action:not(:disabled), .cli-launcher-embedded button:not(:disabled)", Boolean(open) && !detailId, createTrigger, true);
  const { dockOrder } = useDocksVisibility();
  const CREATE_MENU_ORDER_KEY = "space:create-menu-top-order";
  const [createOrder, setCreateOrder] = useState<string[]>(() => {
    if (typeof window === "undefined") return [];
    try {
      const raw = window.localStorage.getItem(CREATE_MENU_ORDER_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      const list = Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
      if (list.length > 0) {
        let updated = list.filter((id) => id !== "add-empty-slots");
        const demosIdx = updated.indexOf("add-demos");
        const vncIdx = updated.indexOf("add-vnc");
        if (demosIdx !== -1 && vncIdx !== -1 && demosIdx > vncIdx) {
          // Demo projects was below VNC pane (at the bottom). Move it up one line!
          updated.splice(demosIdx, 1);
          const newVncIdx = updated.indexOf("add-vnc");
          updated.splice(newVncIdx, 0, "add-demos");
        }
        if (updated.length !== list.length || (demosIdx !== -1 && vncIdx !== -1 && demosIdx > vncIdx)) {
          try {
            window.localStorage.setItem(CREATE_MENU_ORDER_KEY, JSON.stringify(updated));
          } catch {}
        }
        return updated;
      }
      return [];
    } catch {
      return [];
    }
  });
  const [draggedCreateActionId, setDraggedCreateActionId] = useState<string | null>(null);
  const [dragOverCreateActionId, setDragOverCreateActionId] = useState<string | null>(null);
  const isDraggingRef = useRef(false);
  const maxAvailablePanes = availablePanes !== undefined ? Math.max(0, availablePanes) : 16;
  const maxAllowedPanes = Math.min(6, maxAvailablePanes);
  const initialPaneCount = maxAllowedPanes > 0 ? 1 : 0;
  const [paneCount, setPaneCount] = useState(initialPaneCount);

  useEffect(() => {
    if (availablePanes !== undefined) {
      const maxAllowed = Math.min(6, Math.max(0, availablePanes));
      if (maxAllowed === 0) {
        setPaneCount(0);
      } else {
        setPaneCount((prev) => Math.min(maxAllowed, Math.max(1, prev)));
      }
    }
  }, [availablePanes]);

  const handlePaneCountChange = (count: number | ((prev: number) => number)) => {
    setPaneCount((prev) => {
      const next = typeof count === "function" ? count(prev) : count;
      if (maxAllowedPanes === 0) return 0;
      return Math.min(maxAllowedPanes, Math.max(1, next));
    });
  };

  const [position, setPosition] = useState(() => ({
    left: 8,
    top: 56,
    height: typeof window !== "undefined" ? Math.max(520, window.innerHeight - 16) : 520
  }));
  const close = (restore = false) => {
    setOpen(null);
    setDetailId(null);
    setDetailHistory([]);
    setCustomizing(false);
    setQuickNotice(null);
    setPaneCount(maxAllowedPanes > 0 ? 1 : 0);
    if (restore && open) triggers.current[open]?.focus();
  };
  useLayoutEffect(() => {
    const toolbar = nav.current?.closest(".board-toolbar");
    const measure = () => {
      const shellMode = nav.current?.closest<HTMLElement>("[data-shell-mode]")?.dataset.shellMode;
      setCompact(Boolean(shellMode && shellMode !== "desktop") || (toolbar?.clientWidth || window.innerWidth) < (toolbar ? 1100 : 1000));
      setMobile(shellMode === "mobile" || (!shellMode && window.innerWidth <= mobileWidth));
    };
    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
    if (toolbar) observer?.observe(toolbar);
    window.addEventListener("resize", measure);
    measure();
    return () => { observer?.disconnect(); window.removeEventListener("resize", measure); };
  }, []);
  useEffect(() => {
    const dismiss = (event: Event) => {
      if ((event as CustomEvent<string>).detail !== instance) setOpen(null);
    };
    window.addEventListener(navigationOpenEvent, dismiss);
    return () => window.removeEventListener(navigationOpenEvent, dismiss);
  }, [instance]);
  useEffect(() => { setOpen(current => current === "workspace" ? current : null); setDetailId(null); setDetailHistory([]); setQuery(""); setPaneCount(maxAllowedPanes > 0 ? 1 : 0); }, [adminMode, maxAllowedPanes]);
  useEffect(() => {
    dispatchRailMenuChange();
  }, [open]);
  useEffect(() => {
    if (railOnly && !workspaceOnly) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.altKey || event.shiftKey || !(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "k") return;
      if (isTypingTarget(event.target)) return;
      const trigger = triggers.current.workspace;
      if (!trigger?.isConnected) return;
      event.preventDefault();
      if (open === "workspace") {
        search.current?.focus();
        search.current?.select();
        return;
      }
      trigger.click();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [railOnly, workspaceOnly, open]);
  const workspaceToolsOrder = [
    "osk-keyboard",
    "vibe-music",
    "live-model",
    "desktop-displays"
  ];
  const toolOrder = [
    "widget-clock",
    "widget-countdown-timer",
    "widget-pushup-reminder",
    "widget-spaceapp-promo",
    "widget-ai-quota",
    "widget-streaming-metrics",
    "toggle-admin-mode",
    "memory-workspace",
    "space-gateway",
    "demo-mode",
    "system-resources",
    "resources",
    "benchmark",
    "token-usage",
    "server-restart",
    "system-analytics",
    "system-services",
    "setup-connections",
    "help",
    "debug-mode",
    "gateway-compression",
    "resource-indicators",
    "cli-floats",
    "sensitive-data",
    "font-down",
    "vpn-city",
    "reload-room",
    "browser-fullscreen",
    "clip-tool",
    "snip-tool"
  ];
  const isToolsAction = (id: string) => {
    if (toolOrder.includes(id)) return true;
    const railId = ACTION_TO_LOWER_RAIL_ID[id] ?? (LOWER_RAIL_IDS.includes(id) ? id : undefined);
    return Boolean(railId && activeHiddenRailIds.includes(railId));
  };
  const visible = actions.filter(action => {
    if (action.id === "add-empty-slots") return false;
    if (action.id.startsWith("widget-")) {
      const widgetId = action.id.replace("widget-", "") as DesktopWidgetId;
      if (isWidgetHidden(widgetId)) return false;
    }
    if ((workspaceOnly || !railOnly) && action.id === "snip-tool" && actions.some(a => a.id === "clip-tool")) return false;
    if ((workspaceOnly || !railOnly) && action.id === "docks" && actions.some(a => a.id.startsWith("surface-"))) return false;
    if (mobile && action.id.startsWith("widget-")) return false;
    if ((workspaceOnly || !railOnly) && ["room-toolbar", "category-color-filter"].includes(action.id)) return false;
    if ((workspaceOnly || !railOnly) && ["room-focus", "previous-room", "next-room"].includes(action.id)) return true;
    if (!desktopActionVisible(action.id, adminMode && canAdmin)) return false;
    if (docksOnly) return action.id.startsWith("surface-");
    if (toolsOnly) return isToolsAction(action.id);
    return true;
  });
  const workspace = open === "workspace" && !docksOnly;
  useEffect(() => {
    if (!workspace) return;
    onWorkspaceDetailChange?.(detailId);
    return () => onWorkspaceDetailChange?.(null);
  }, [workspace, detailId, onWorkspaceDetailChange]);
  const actionCategory = workspaceActionCategory;
  // The Room tab exists only where the room settings page does.
  const visibleCategories = workspaceCategories.filter(item => item.id !== "room" || visible.some(action => action.id === "workspace-room"));
  const isPageTab = (id: WorkspaceCategory) => Boolean(renderWorkspaceAction && workspacePageTabActionIds[id]);
  const chooseCategory = (next: WorkspaceCategory) => {
    setCategory(next);
    try { window.localStorage.setItem(WORKSPACE_MENU_CATEGORY_KEY, next); } catch {}
  };
  useEffect(() => {
    if (!open || !detailId) return;
    if (!detailHistory.length && !visible.some(action => action.id === detailId)) setDetailId(null);
  }, [open, detailId, actions]);
  useLayoutEffect(() => {
    if (detailId) detail.current?.focus();
  }, [detailId]);
  const back = () => {
    if (detailHistory.length) {
      setDetailId(detailHistory.at(-1)!);
      setDetailHistory(detailHistory.slice(0, -1));
      return;
    }
    const previous = detailId;
    setDetailId(null);
    window.requestAnimationFrame(() => menu.current?.querySelector<HTMLButtonElement>(`[data-action-id="${previous}"]`)?.focus());
  };
  const navigate = (id: string) => {
    if (detailId) setDetailHistory(previous => [...previous, detailId]);
    setDetailId(id);
  };
  const isSearching = Boolean(query.trim());
  const searchableCount = visible.filter(action => !(renderCreateTools && action.id === "add-cli")).length;
  const railHidden = (id: string) => {
    const railId = ACTION_TO_LOWER_RAIL_ID[id] ?? (LOWER_RAIL_IDS.includes(id) ? id : undefined);
    return Boolean(railId && activeHiddenRailIds.includes(railId));
  };
  const toolsMenu = toolsOnly;
  const detailAction = visible.find(action => action.id === detailId);
  const detailLabel = detailAction ? workspaceActionLabel(detailAction) : "Workspace";
  const pinnedIds = quickIds.filter(id => !workspaceFooterActionIds.includes(id) && visible.some(action => action.id === id));
  const quick = workspace && !isSearching ? pinnedIds.flatMap(id => visible.filter(a => a.id === id)) : [];
  const saveQuickIds = (next: string[]) => {
    setQuickIds(next);
    try { window.localStorage.setItem(WORKSPACE_QUICK_ACTIONS_KEY, JSON.stringify(next)); } catch {}
    saveUserSettingDebounced("workspaceQuickActions", next);
  };
  const togglePin = (id: string) => {
    if (pinnedIds.includes(id)) {
      saveQuickIds(pinnedIds.filter(item => item !== id));
      setQuickNotice(null);
      return;
    }
    if (pinnedIds.length >= WORKSPACE_QUICK_ACTION_LIMIT) {
      setQuickNotice(`Quick access holds ${WORKSPACE_QUICK_ACTION_LIMIT} actions. Remove one first.`);
      return;
    }
    saveQuickIds([...pinnedIds, id]);
    setQuickNotice(null);
  };
  const moveQuick = (id: string, target: number) => {
    const next = pinnedIds.filter(item => item !== id);
    next.splice(Math.max(0, Math.min(next.length, target)), 0, id);
    saveQuickIds(next);
  };
  const footerActions = workspace ? workspaceFooterActionIds.flatMap(id => visible.filter(a => a.id === id)) : [];
  const matched = visible.filter(action => {
    if (renderCreateTools && action.id === "add-cli") return false;
    if (isSearching) return `${workspaceActionLabel(action)} ${action.label} ${desktopActionDescriptions[action.id] ?? ""}`.toLowerCase().includes(query.trim().toLowerCase());
    if (docksOnly || toolsOnly) return true;
    if (workspace) return !pinnedIds.includes(action.id) && !workspaceFooterActionIds.includes(action.id) && actionCategory(action.id) === category;
    const group = desktopActionGroup(action.id);
    return group === open;
  });
  const sortedMatched = useMemo(() => {
    if (toolsOnly || (workspace && ["widgets", "utilities", "toggles"].includes(category))) {
      return [...matched].sort((a, b) => {
        const aRailId = ACTION_TO_LOWER_RAIL_ID[a.id] ?? (LOWER_RAIL_IDS.includes(a.id) ? a.id : undefined);
        const bRailId = ACTION_TO_LOWER_RAIL_ID[b.id] ?? (LOWER_RAIL_IDS.includes(b.id) ? b.id : undefined);
        const aIsHiddenRail = Boolean(aRailId && activeHiddenRailIds.includes(aRailId));
        const bIsHiddenRail = Boolean(bRailId && activeHiddenRailIds.includes(bRailId));
        if (aIsHiddenRail && !bIsHiddenRail) return -1;
        if (!aIsHiddenRail && bIsHiddenRail) return 1;
        if (aIsHiddenRail && bIsHiddenRail) {
          const aRailIndex = aRailId ? LOWER_RAIL_IDS.indexOf(aRailId) : -1;
          const bRailIndex = bRailId ? LOWER_RAIL_IDS.indexOf(bRailId) : -1;
          return (aRailIndex === -1 ? 999 : aRailIndex) - (bRailIndex === -1 ? 999 : bRailIndex);
        }
        const ai = toolOrder.indexOf(a.id);
        const bi = toolOrder.indexOf(b.id);
        if (ai !== -1 && bi !== -1) return ai - bi;
        if (ai !== -1) return -1;
        if (bi !== -1) return 1;
        return 0;
      });
    }
    if (docksOnly || (workspace && category === "docks" && !isSearching)) {
      const rank = dockOrderRank(dockOrder);
      return [...matched].sort((a, b) => rank(a.id.replace(/^surface-/, "")) - rank(b.id.replace(/^surface-/, "")));
    }
    if (workspace && category === "tools") {
      return [...matched].sort((a, b) => {
        const ai = workspaceToolsOrder.indexOf(a.id);
        const bi = workspaceToolsOrder.indexOf(b.id);
        if (ai !== -1 && bi !== -1) return ai - bi;
        if (ai !== -1) return -1;
        if (bi !== -1) return 1;
        return 0;
      });
    }
    if ((open === "create" || createOnly) && !isSearching && createOrder.length > 0) {
      const sorted = [...matched].sort((a, b) => {
        const ai = createOrder.indexOf(a.id);
        const bi = createOrder.indexOf(b.id);
        if (ai !== -1 && bi !== -1) return ai - bi;
        if (ai !== -1) return -1;
        if (bi !== -1) return 1;
        return 0;
      });
      return sorted;
    }
    return matched;
  }, [matched, toolsOnly, workspace, category, isSearching, open, createOnly, createOrder, toolOrder, workspaceToolsOrder, activeHiddenRailIds, dockOrder]);
  const showCreateTools = Boolean(renderCreateTools && !docksOnly && !toolsOnly && (open === "create" || workspace && category === "create" && !isSearching || isSearching && !workspaceOnly));
  const searchGroups = workspace && isSearching ? workspaceCategories.flatMap(item => {
    const items = sortedMatched.filter(action => actionCategory(action.id) === item.id);
    return items.length ? [{ ...item, items }] : [];
  }) : [];
  const resultOrder = searchGroups.length ? searchGroups.flatMap(group => group.items) : sortedMatched;
  // Enter in the search field runs the first result, which carries a visible hint.
  const firstResultId = isSearching ? resultOrder.find(action => !action.disabled && action.id !== "add-empty-slots")?.id ?? null : null;
  useLayoutEffect(() => {
    if (!open) return;
    const reposition = () => {
      const rect = triggers.current[open]?.getBoundingClientRect();
      if (!rect) return;
      const viewport = window.visualViewport;
      const viewportTop = viewport?.offsetTop ?? 0;
      const viewportHeight = viewport?.height ?? window.innerHeight;
      const targetWidth = workspace ? 760 : docksOnly ? 220 : toolsOnly ? 260 : 280;
      const width = Math.min(targetWidth, window.innerWidth - 16);
      const railPosition = railPopoverPosition(triggers.current[open] ?? null, width);
      if (!mobile && railPosition) {
        setPosition({ left: railPosition.left, top: window.innerHeight - railPosition.bottom, height: railPosition.maxHeight });
        return;
      }
      const availableHeight = railOnly ? viewportHeight - 16 : Math.min(viewportHeight - 16, Math.max(520, viewportHeight - 16));
      const top = mobile ? viewportTop + 8 : Math.max(viewportTop + 8, Math.min(
        railOnly ? rect.top : rect.bottom + 6,
        viewportTop + viewportHeight - 8 - (railOnly ? availableHeight : 152)
      ));
      setPosition({
        left: mobile ? 8 : Math.max(8, Math.min(railOnly ? rect.left - width - 8 : rect.left, window.innerWidth - width - 8)),
        top,
        height: Math.max(100, Math.min(mobile ? viewportHeight - 16 : (railOnly ? viewportHeight - 16 : viewportTop + viewportHeight - top - 8), viewportTop + viewportHeight - top - 8))
      });
    };
    reposition();
    const menuObserver = typeof ResizeObserver !== "undefined" && menu.current ? new ResizeObserver(reposition) : null;
    if (menu.current) menuObserver?.observe(menu.current);
    const onScroll = (event: Event) => {
      if (menu.current && event.target instanceof Node && menu.current.contains(event.target)) return;
      reposition();
    };
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", onScroll, true);
    window.visualViewport?.addEventListener("resize", reposition);
    window.visualViewport?.addEventListener("scroll", reposition);
    return () => {
      menuObserver?.disconnect();
      window.removeEventListener("resize", reposition); window.removeEventListener("scroll", onScroll, true);
      window.visualViewport?.removeEventListener("resize", reposition); window.visualViewport?.removeEventListener("scroll", reposition);
    };
  }, [railOnly, open, workspace, mobile]);
  useEffect(() => {
    if (!open) return;
    if (!mobile && !window.matchMedia?.("(pointer: coarse)")?.matches) search.current?.focus();
    else menu.current?.focus();
    const dismiss = (event: PointerEvent) => {
      if (shouldPreserveForSnipTool(event)) return;
      if (event.button === 1 || isDraggingRef.current) return;
      const target = event.target as Node;
      if (menu.current?.contains(target) || Object.values(triggers.current).some(node => node?.contains(target))) return;
      setOpen(null);
    };
    document.addEventListener("pointerdown", dismiss, true);
    return () => document.removeEventListener("pointerdown", dismiss, true);
  }, [open, mobile]);
  const source = open ? triggers.current[open]?.closest<HTMLElement>("[data-shell-mode]") : null;
  const dragOverCreateActionIdRef = useRef<string | null>(null);

  const handleCreatePointerDown = (event: React.PointerEvent<HTMLElement>, actionId: string) => {
    if (event.button !== 0 || (open !== "create" && !createOnly) || isSearching || actionId === "add-empty-slots") return;

    const isHandle = (event.target as HTMLElement)?.closest(".desktop-menu-drag-handle") !== null;
    if ((event.pointerType === "touch" || mobile) && !isHandle) return;

    const startX = event.clientX;
    const startY = event.clientY;
    let dragStarted = false;

    const onPointerMove = (moveEvent: PointerEvent) => {
      const isTouch = moveEvent.pointerType === "touch" || event.pointerType === "touch";
      if (isTouch && !isHandle) return;
      const dist = Math.hypot(moveEvent.clientX - startX, moveEvent.clientY - startY);
      if (!dragStarted && (isHandle ? (isTouch ? dist > 8 : dist > 2) : dist > 6)) {
        dragStarted = true;
        isDraggingRef.current = true;
        setDraggedCreateActionId(actionId);
      }

      if (dragStarted) {
        moveEvent.preventDefault();
        const element = document.elementFromPoint(moveEvent.clientX, moveEvent.clientY);
        const targetOption = element?.closest<HTMLElement>(".desktop-menu-action");
        const targetId = targetOption?.dataset.actionId;
        if (targetId && targetId !== actionId && targetId !== "add-empty-slots") {
          dragOverCreateActionIdRef.current = targetId;
          setDragOverCreateActionId(targetId);
        } else {
          dragOverCreateActionIdRef.current = null;
          setDragOverCreateActionId(null);
        }
      }
    };

    const onPointerUp = (upEvent: PointerEvent) => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp, { capture: true });
      window.removeEventListener("pointercancel", onPointerUp, { capture: true });

      if (dragStarted) {
        upEvent.preventDefault();
        upEvent.stopPropagation();
        const targetId = dragOverCreateActionIdRef.current;
        if (targetId && targetId !== actionId && targetId !== "add-empty-slots") {
          const currentOrder = sortedMatched.map((a) => a.id);
          const sourceIndex = currentOrder.indexOf(actionId);
          const targetIndex = currentOrder.indexOf(targetId);
          if (sourceIndex !== -1 && targetIndex !== -1) {
            const nextOrder = [...currentOrder];
            nextOrder.splice(sourceIndex, 1);
            nextOrder.splice(targetIndex, 0, actionId);
            const emptyIdx = nextOrder.indexOf("add-empty-slots");
            if (emptyIdx !== -1) {
              nextOrder.splice(emptyIdx, 1);
              const vncIdx = nextOrder.indexOf("add-vnc");
              if (vncIdx !== -1) {
                nextOrder.splice(vncIdx + 1, 0, "add-empty-slots");
              } else {
                nextOrder.push("add-empty-slots");
              }
            }
            setCreateOrder(nextOrder);
            try {
              window.localStorage.setItem(CREATE_MENU_ORDER_KEY, JSON.stringify(nextOrder));
              saveUserSettingDebounced("createMenuOrder", nextOrder);
            } catch {}
          }
        }
        dragOverCreateActionIdRef.current = null;
        setDraggedCreateActionId(null);
        setDragOverCreateActionId(null);
        window.setTimeout(() => {
          isDraggingRef.current = false;
        }, 120);
      }
    };

    window.addEventListener("pointermove", onPointerMove, { passive: false });
    window.addEventListener("pointerup", onPointerUp, { capture: true });
    window.addEventListener("pointercancel", onPointerUp, { capture: true });
  };

  const handleQuickPointerDown = (event: React.PointerEvent<HTMLElement>, actionId: string) => {
    if (event.button !== 0) return;
    const startX = event.clientX;
    const startY = event.clientY;
    let dragging = false;
    let over: string | null = null;
    const onMove = (move: PointerEvent) => {
      if (!dragging && Math.hypot(move.clientX - startX, move.clientY - startY) > 6) {
        dragging = true;
        isDraggingRef.current = true;
        setQuickDrag({ id: actionId, over: null });
      }
      if (!dragging) return;
      move.preventDefault();
      const targetId = document.elementFromPoint(move.clientX, move.clientY)?.closest<HTMLElement>(".workspace-quick-actions .desktop-menu-action")?.dataset.actionId;
      over = targetId && targetId !== actionId ? targetId : null;
      setQuickDrag({ id: actionId, over });
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp, { capture: true });
      window.removeEventListener("pointercancel", onUp, { capture: true });
      if (!dragging) return;
      if (over) moveQuick(actionId, pinnedIds.indexOf(over));
      setQuickDrag(null);
      window.setTimeout(() => { isDraggingRef.current = false; }, 120);
    };
    window.addEventListener("pointermove", onMove, { passive: false });
    window.addEventListener("pointerup", onUp, { capture: true });
    window.addEventListener("pointercancel", onUp, { capture: true });
  };
  const renderAction = (action: IconToolbarAction, quickAction = false) => {
    const Icon = action.icon;
    const toggle = workspaceActionToggle(action);
    const reason = action.disabled ? action.disabledReason : undefined;
    const description = mobile ? undefined : reason ?? (workspace && !quickAction && !toolsMenu ? desktopActionDescriptions[action.id] : undefined);
    const label = quickAction || workspace || docksOnly || toolsOnly ? workspaceActionLabel(action) : action.label;
    const isCreateDraggable = (open === "create" || createOnly) && !isSearching && !action.disabled;
    const isDragging = draggedCreateActionId === action.id || quickDrag?.id === action.id;
    const isDragOver = dragOverCreateActionId === action.id || quickDrag?.over === action.id;
    const isOpen = toggle === undefined && Boolean(action.ariaPressed);
    const customize = customizing && workspace;
    const pinned = pinnedIds.includes(action.id);
    const showRailHidden = workspace && !quickAction && !customize && railHidden(action.id);
    // Quick access shortcuts to page tabs switch tabs instead of opening a second copy of the page.
    const quickTab = quickAction && workspace && !customize && renderWorkspaceAction
      ? (Object.keys(workspacePageTabActionIds) as WorkspaceCategory[]).find(id => workspacePageTabActionIds[id] === action.id && visibleCategories.some(item => item.id === id))
      : undefined;
    const customizeLabel = customize ? (quickAction || pinned ? `Remove ${label} from Quick access` : `Pin ${label} to Quick access`) : undefined;

    if (action.id === "add-empty-slots") {
      const emptySlotsCount = emptySlots?.count ?? 0;
      const canMinus = emptySlots ? emptySlots.count > emptySlots.min : false;
      const canPlus = emptySlots ? emptySlots.count < emptySlots.max : false;
      return (
        <div
          key={action.id}
          className={`desktop-menu-action desktop-empty-slots-action${action.disabled ? " is-disabled" : ""}`}
          data-action-id={action.id}
          role="button"
          tabIndex={0}
          title={reason ?? action.title}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              if (canPlus && emptySlots) emptySlots.onIncrement();
            } else if (e.key === "ArrowRight" || e.key === "+") {
              e.preventDefault();
              if (canPlus && emptySlots) emptySlots.onIncrement();
            } else if (e.key === "ArrowLeft" || e.key === "-") {
              e.preventDefault();
              if (canMinus && emptySlots) emptySlots.onDecrement();
            }
          }}
          onClick={() => {
            if (isDraggingRef.current) return;
            if (canPlus && emptySlots) emptySlots.onIncrement();
          }}
        >
          <Icon aria-hidden="true" />
          <span>
            <strong>{label}</strong>
            <small>{reason ? reason : `${emptySlotsCount} in room`}</small>
          </span>
          <span className="desktop-action-trailing" onClick={(e) => e.stopPropagation()}>
            <div
              className="cli-launcher-count-stepper"
              role="spinbutton"
              aria-valuenow={emptySlotsCount}
              aria-valuemin={emptySlots?.min ?? 0}
              aria-valuemax={emptySlots?.max ?? 16}
              aria-label="Empty slots count"
              onWheel={(e) => {
                e.preventDefault();
                e.stopPropagation();
                if (e.deltaY < 0 && canPlus) emptySlots?.onIncrement();
                else if (e.deltaY > 0 && canMinus) emptySlots?.onDecrement();
              }}
            >
              <button
                type="button"
                className="cli-count-btn cli-count-btn-minus"
                aria-label="Decrease empty slots"
                title="Decrease empty slots"
                disabled={!canMinus}
                onClick={(e) => {
                  e.stopPropagation();
                  emptySlots?.onDecrement();
                }}
              >
                <Minus aria-hidden="true" />
              </button>
              <span className="cli-count-value" title={`Empty slots (${emptySlots?.min ?? 0}-${emptySlots?.max ?? 16})`}>
                {emptySlotsCount}
              </span>
              <button
                type="button"
                className="cli-count-btn cli-count-btn-plus"
                aria-label="Increase empty slots"
                title="Increase empty slots"
                disabled={!canPlus}
                onClick={(e) => {
                  e.stopPropagation();
                  emptySlots?.onIncrement();
                }}
              >
                <Plus aria-hidden="true" />
              </button>
            </div>
          </span>
        </div>
      );
    }
    return <button key={action.id} type="button"
      className={`desktop-menu-action${isDragging ? " is-dragging" : ""}${isDragOver ? " is-drag-over" : ""}`}
      data-action-id={action.id}
      data-category={workspace ? actionCategory(action.id) : undefined}
      data-state={isOpen ? "open" : undefined}
      data-current={quickTab && category === quickTab && !detailId ? "true" : undefined}
      data-search-first={action.id === firstResultId ? "true" : undefined}
      data-pinned={customize && !quickAction ? String(pinned) : undefined}
      style={workspace ? { "--workspace-category-color": workspaceActionColor(action.id) } as CSSProperties : undefined}
      disabled={action.disabled && !customize}
      draggable={false}
      onDragStart={(e) => e.preventDefault()}
      onPointerDown={isCreateDraggable ? (e) => handleCreatePointerDown(e, action.id) : customize && quickAction ? (e) => handleQuickPointerDown(e, action.id) : undefined}
      onKeyDown={customize && quickAction ? event => {
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
        event.preventDefault();
        moveQuick(action.id, pinnedIds.indexOf(action.id) + (event.key === "ArrowLeft" ? -1 : 1));
      } : undefined}
      onWheel={action.onWheel} data-sensitive-ignore={action.dataSensitiveIgnore ? "true" : undefined}
      aria-label={customizeLabel ?? (toggle === undefined ? action.ariaLabel : label)}
      aria-pressed={customize ? (quickAction ? undefined : pinned) : toggle ?? action.ariaPressed}
      aria-haspopup={customize ? undefined : action.ariaHasPopup}
      title={customizeLabel ?? reason ?? action.title}
      onClick={event => {
        if (isDraggingRef.current) return;
        if (customize) {
          togglePin(action.id);
          return;
        }
        if (quickTab) {
          chooseCategory(quickTab); setQuery(""); setDetailId(null); setDetailHistory([]);
          return;
        }
        if (workspace && action.id === "docks") {
          chooseCategory("docks"); setQuery(""); setDetailId(null); setDetailHistory([]);
          return;
        }
        if (workspace && action.id === "osk-keyboard") {
          close();
        }
        if (workspace && renderWorkspaceAction && workspaceDetailActionIds.includes(action.id)) {
          detailTrigger.current = event.currentTarget;
          setDetailHistory([]);
          setDetailId(action.id);
          return;
        }
        const anchor = open ? triggers.current[open] : null;
        const countToRun = (open === "create" || createOnly) ? paneCount : 1;
        const isWidgetToggle = action.id.startsWith("widget-");
        if (workspace && action.id === "osk-keyboard") {
          // already closed above
        } else if (!isWidgetToggle && !workspace) {
          close();
        }
        if (anchor) {
          if (!isWidgetToggle && !workspace) anchor.focus();
          if (countToRun > 1) onAction(action, anchor, countToRun);
          else onAction(action, anchor);
        } else {
          action.onClick();
        }
      }}>
      <Icon aria-hidden="true" />
      <span><strong>{label}</strong>{description ? <small>{description}</small> : null}</span>
      <span className="desktop-action-trailing">
        {customize ? (quickAction ? <X className="desktop-action-pin" aria-hidden="true" /> : <Pin className="desktop-action-pin" data-pinned={pinned} aria-hidden="true" />) : <>
          {toggle !== undefined ? <small className="desktop-action-status" data-on={toggle}>{toggle ? "On" : "Off"}</small> : isOpen ? <small className="desktop-action-status" data-state="open">Open</small> : null}
          {showRailHidden ? <small className="desktop-action-rail-hidden" title="This control is hidden from the rail. Right-click the rail to show it again.">Hidden from rail</small> : null}
          {action.id === firstResultId ? <kbd className="desktop-action-enter-hint" aria-hidden="true" title="Press Enter to open">↵</kbd> : null}
        </>}
        {isCreateDraggable ? <GripVertical className="desktop-menu-drag-handle" aria-hidden="true" /> : null}
      </span>
    </button>;
  };
  const groups = docksOnly ? [{ id: "workspace" as const, label: "Docks" }]
    : createOnly ? [{ id: "create" as const, label: "Create" }]
    : toolsOnly ? [{ id: "tools" as const, label: "Tools" }]
    : workspaceOnly ? [{ id: "workspace" as const, label: "More" }]
    : desktopGroups.filter(group => !compact || ["create", "workspace"].includes(group.id));
  return <nav ref={nav} className={railOnly ? "desktop-create-rail" : "desktop-navigation"} data-compact={compact || undefined}
    aria-label={workspaceOnly ? "Workspace actions" : docksOnly ? "Docks" : createOnly ? "Create panes" : toolsOnly ? "Tools" : "Workspace navigation"}>
    {groups.map(group => {
      const isVisible = (workspaceOnly || docksOnly || toolsOnly ? visible.length > 0 : visible.some(a => desktopActionGroup(a.id) === group.id || group.id === "workspace" && desktopActionGroup(a.id) === "rooms"));
      if (!isVisible) return null;
      const isGroupActive = open === group.id;
      return (
        <button key={group.id} ref={node => { triggers.current[group.id] = node; }}
          className={railOnly ? `room-toolbar-visibility-button${isGroupActive ? " is-active" : ""}` : (isGroupActive ? "is-active" : undefined)} type="button"
          data-rail-id={workspaceOnly ? "more" : docksOnly ? "docks" : toolsOnly ? "tools" : createOnly ? "create" : undefined}
          aria-label={workspaceOnly ? "More workspace actions" : docksOnly ? "Show docks" : toolsOnly ? "Workspace tools" : createOnly ? "Create" : undefined}
          title={workspaceOnly ? "More workspace actions" : group.label} aria-haspopup="dialog" aria-expanded={open === group.id}
          aria-keyshortcuts={group.id === "workspace" && (!railOnly || workspaceOnly) ? "Control+K Meta+K" : undefined}
          aria-pressed={isGroupActive ? true : undefined}
          aria-controls={open === group.id ? menuId : undefined}
          onClick={event => {
            createTrigger.current = event.currentTarget; setQuery(""); setPaneCount(maxAllowedPanes > 0 ? 1 : 0);
            const storedCategory = readStoredCategory();
            setCategory(storedCategory && (storedCategory !== "room" || visible.some(action => action.id === "workspace-room")) ? storedCategory : "docks");
            setQuickIds(readQuickActionIds());
            setCustomizing(false);
            setQuickNotice(null);
            setDetailId(null);
            setDetailHistory([]);
            window.dispatchEvent(new CustomEvent(navigationOpenEvent, { detail: instance }));
            setOpen(open === group.id ? null : group.id);
          }}>
          {workspaceOnly ? <MoreHorizontal aria-hidden="true" /> : docksOnly ? <Grid2X2 aria-hidden="true" /> : createOnly ? <Plus aria-hidden="true" /> : toolsOnly ? <Wrench aria-hidden="true" /> : mobile ? group.id === "create" ? <Plus aria-hidden="true" /> : <Wrench aria-hidden="true" /> : <>{group.label}<ChevronRight className="desktop-menu-chevron" aria-hidden="true" /></>}
        </button>
      );
    })}
    {!railOnly && canAdmin ? <button type="button" className="desktop-mode-switch" aria-label="Admin mode" aria-pressed={adminMode}
      title={adminMode ? "Switch to User mode" : "Switch to Admin mode"} onClick={onModeChange}>
      {adminMode ? <ShieldCheck aria-hidden="true" /> : <UserCheck aria-hidden="true" />}<span>{adminMode ? "Admin mode" : "User mode"}</span>
    </button> : null}
    {createPortal(
      <>
        {open ? <>
          {mobile ? <div className="desktop-navigation-backdrop" onPointerDown={() => close(true)} /> : null}
          <div
            id={menuId} ref={menu}
            className={`desktop-navigation-menu${workspace ? " is-workspace" : ""}${docksOnly ? " is-docks" : ""}${toolsOnly ? " is-tools" : ""}${mobile ? " is-mobile" : ""}`}
            role="dialog" aria-modal={mobile || undefined}
            aria-label={docksOnly ? "Docks" : toolsOnly ? "Workspace tools" : workspace ? "Workspace" : isSearching ? "Find an action" : desktopGroups.find(g => g.id === open)?.label}
            tabIndex={-1} data-ui-theme={source?.dataset.uiTheme} data-color-mode={source?.dataset.colorMode} data-room-theme={source?.dataset.roomTheme}
            style={{ left: position.left, top: mobile || railOnly ? undefined : position.top, bottom: !mobile && railOnly ? window.innerHeight - position.top : mobile ? Math.max(8, window.innerHeight - position.top - position.height) : undefined, maxHeight: position.height, "--navigation-available-height": `${position.height}px` } as CSSProperties}
            onKeyDown={event => {
              if (event.defaultPrevented) return;
              if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); if (customizing) { setCustomizing(false); setQuickNotice(null); } else if (detailId) back(); else close(true); return; }
              if (event.key === "Enter" && event.target === search.current && !event.nativeEvent.isComposing) {
                const first = menu.current?.querySelector<HTMLButtonElement>('[data-search-first="true"]');
                if (first) { event.preventDefault(); first.click(); }
                return;
              }
              if (event.key === "Tab" && (mobile || workspace)) {
                const nodes = Array.from(menu.current?.querySelectorAll<HTMLElement>('input:not(:disabled), textarea:not(:disabled), select:not(:disabled), button:not(:disabled), a[href], [tabindex="0"]') ?? []).filter(node => node.tabIndex >= 0 && !node.closest('[hidden], [aria-hidden="true"]'));
                if (event.shiftKey && (document.activeElement === nodes[0] || document.activeElement === menu.current)) { event.preventDefault(); nodes.at(-1)?.focus(); }
                else if (!event.shiftKey && document.activeElement === nodes.at(-1)) { event.preventDefault(); nodes[0]?.focus(); }
                return;
              }
              if (detailId) return;
              if (!["ArrowDown", "ArrowUp"].includes(event.key)) return;
              const buttons = Array.from(menu.current?.querySelectorAll<HTMLButtonElement>(".desktop-menu-action:not(:disabled), .cli-launcher-embedded button:not(:disabled)") ?? []);
              if (!buttons.length) return;
              event.preventDefault();
              const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
              const next = index < 0 ? (event.key === "ArrowDown" ? 0 : buttons.length - 1) : (index + (event.key === "ArrowDown" ? 1 : buttons.length - 1)) % buttons.length;
              buttons[next]?.focus();
            }}
            onBlur={event => { if (!workspace && !mobile && !shouldPreserveForSnipTool(event) && event.relatedTarget && !event.currentTarget.contains(event.relatedTarget) && !Object.values(triggers.current).some(node => node?.contains(event.relatedTarget as Node))) setOpen(null); }}>
            <div className="desktop-menu-header">
              <label className="desktop-menu-search"><Search aria-hidden="true" />
                <input ref={search} aria-label={docksOnly ? "Find a dock" : toolsOnly ? "Find a tool" : "Find an action"}
                  placeholder={workspace ? `Search ${searchableCount} actions…` : "Find an action…"} value={query} onChange={event => { setDetailId(null); setDetailHistory([]); setQuery(event.target.value); }} />
                {workspace && isSearching ? <small className="desktop-menu-search-count" aria-live="polite">{matched.length === 1 ? "1 result" : `${matched.length} results`}</small> : null}
                {workspace && !isSearching && !mobile && (!railOnly || workspaceOnly) ? <kbd className="desktop-menu-shortcut" title={`Open Workspace from anywhere outside a terminal with ${shortcutLabel}`}>{shortcutLabel}</kbd> : null}
              </label>
              {workspace ? <button type="button" className="desktop-menu-customize" aria-pressed={customizing}
                aria-label={customizing ? "Finish customizing Quick access" : "Customize Quick access"}
                title={customizing ? "Finish customizing Quick access" : "Customize Quick access"}
                onClick={() => { setCustomizing(value => !value); setQuickNotice(null); setDetailId(null); setDetailHistory([]); }}>
                {customizing ? <Check aria-hidden="true" /> : <Pin aria-hidden="true" />}<span>{customizing ? "Done" : "Customize"}</span>
              </button> : null}
              <button type="button" className="desktop-menu-close" aria-label="Close menu" title="Close" onClick={() => close(true)}><X aria-hidden="true" /></button>
            </div>
            {workspace && !isSearching && !detailId && (quick.length > 0 || customizing) ? <div className="workspace-quick-actions" aria-label="Quick access" data-customizing={customizing || undefined}>
              {quick.map(a => renderAction(a, true))}
              {customizing ? Array.from({ length: Math.max(0, WORKSPACE_QUICK_ACTION_LIMIT - quick.length) }, (_, index) =>
                <span key={`slot-${index}`} className="workspace-quick-slot" aria-hidden="true">Empty slot</span>) : null}
            </div> : null}
            {customizing && workspace && !detailId ? <p className="workspace-customize-hint" role="status">
              {quickNotice ?? `Pick up to ${WORKSPACE_QUICK_ACTION_LIMIT} actions for Quick access. Click a pinned action to remove it; drag it or use the arrow keys to reorder.`}
            </p> : null}
            <div className={workspace ? `workspace-browser${isSearching && !detailId ? " is-searching" : ""}${detailId ? " has-detail" : ""}` : "desktop-menu-body"}>
            {workspace && (!isSearching || detailId) ? <div className="workspace-category-tabs" role="tablist" aria-label="Workspace categories" aria-orientation={mobile ? "horizontal" : "vertical"}>
              {visibleCategories.map(item => {
                const CategoryIcon = item.icon;
                const count = isPageTab(item.id) ? null : visible.filter(action => !pinnedIds.includes(action.id) && !workspaceFooterActionIds.includes(action.id) && actionCategory(action.id) === item.id).length;
                return <button key={item.id} id={`${menuId}-${item.id}`} type="button" role="tab" aria-label={item.label}
                aria-selected={category === item.id} aria-controls={`${menuId}-actions`} tabIndex={category === item.id ? 0 : -1}
                style={{ "--workspace-category-color": item.color } as CSSProperties}
                onKeyDown={event => {
                  if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
                  event.preventDefault(); event.stopPropagation();
                  const index = visibleCategories.findIndex(c => c.id === category);
                  const length = visibleCategories.length;
                  const next = event.key === "Home" ? 0 : event.key === "End" ? length - 1 : (index + (["ArrowRight", "ArrowDown"].includes(event.key) ? 1 : length - 1)) % length;
                  chooseCategory(visibleCategories[next]!.id);
                  setDetailId(null); setDetailHistory([]); setQuery("");
                  document.getElementById(`${menuId}-${visibleCategories[next]!.id}`)?.focus();
                }} onClick={() => { chooseCategory(item.id); setDetailId(null); setDetailHistory([]); setQuery(""); }}>
                <CategoryIcon aria-hidden="true" /><span>{item.label}</span>{count === null ? null : <small aria-hidden="true">{count}</small>}
              </button>; })}
            </div> : null}
            {detailId && renderWorkspaceAction ? <div id={`${menuId}-actions`} className="workspace-detail" role="tabpanel" aria-label={detailLabel}>
              <header className="workspace-detail-header">
                <button type="button" className="workspace-back" aria-label="Back to workspace actions" onClick={back}><ChevronLeft aria-hidden="true" /><span>Back</span></button>
                <strong>{detailLabel}</strong>
              </header>
              <div ref={detail} className="workspace-detail-content" tabIndex={-1} data-workspace-page={detailId}>
                <WorkspaceSurface>{renderWorkspaceAction(detailId, { onBack: back, onNavigate: navigate, triggerRef: detailTrigger })}</WorkspaceSurface>
              </div>
            </div> : <div id={`${menuId}-actions`} className={`desktop-menu-actions${workspace && ["tools", "widgets", "utilities", "toggles"].includes(category) || toolsOnly ? " is-tools-list" : ""}`} role={workspace && !isSearching ? "tabpanel" : undefined}
              aria-labelledby={workspace && !isSearching ? `${menuId}-${category}` : undefined}>
              {workspace && !isSearching && (!isPageTab(category) || customizing) ? <div className="workspace-section-heading">
                <strong>{workspaceCategories.find(item => item.id === category)?.label}</strong>
                {!mobile ? <small>{workspaceCategories.find(item => item.id === category)?.description}</small> : null}
              </div> : null}
              {workspace && isPageTab(category) && !isSearching && !customizing && renderWorkspaceAction ? (
                <div className="workspace-pane-layout-view" data-workspace-tab={category}>
                  <WorkspaceSurface>
                    {renderWorkspaceAction(workspacePageTabActionIds[category]!, { onBack: () => {}, onNavigate: navigate, triggerRef: detailTrigger })}
                  </WorkspaceSurface>
                </div>
              ) : toolsOnly && !isSearching ? (() => {
                const isHiddenRailAction = (a: IconToolbarAction) => railHidden(a.id);
                const isToolToggle = (a: IconToolbarAction) => !a.id.startsWith("widget-") && !isHiddenRailAction(a) && workspaceActionToggle(a) !== undefined;
                const category = (id: WorkspaceCategory) => workspaceCategories.find(item => item.id === id);
                const sections = [
                  { id: "widgets", label: category("widgets")?.label, color: category("widgets")?.color, icon: Sparkles, items: sortedMatched.filter(a => a.id.startsWith("widget-")) },
                  { id: "hidden", label: "Hidden from rail", color: undefined, icon: EyeOff, items: sortedMatched.filter(a => !a.id.startsWith("widget-") && isHiddenRailAction(a)) },
                  { id: "utilities", label: category("utilities")?.label, color: category("utilities")?.color, icon: Cpu, items: sortedMatched.filter(a => !a.id.startsWith("widget-") && !isHiddenRailAction(a) && !isToolToggle(a)) },
                  { id: "toggles", label: category("toggles")?.label, color: category("toggles")?.color, icon: SlidersHorizontal, items: sortedMatched.filter(isToolToggle) }
                ];
                return sections.filter(section => section.items.length).map(section => {
                  const SectionIcon = section.icon;
                  return <div key={section.id} className={`desktop-tools-widgets-section desktop-tools-${section.id}-section`} data-tools-section={section.id}
                    style={section.color ? { "--workspace-category-color": section.color } as CSSProperties : undefined}>
                    <div className="desktop-tools-widgets-header">
                      <SectionIcon aria-hidden="true" />
                      <span>{section.label}</span>
                    </div>
                    {section.items.map(a => renderAction(a))}
                  </div>;
                });
              })() : workspace && category === "tools" && !isSearching ? (
                <div className="workspace-tools-icons">{sortedMatched.map(a => renderAction(a))}</div>
              ) : searchGroups.length ? (
                searchGroups.map(group => {
                  const GroupIcon = group.icon;
                  return <Fragment key={group.id}>
                    <div className="workspace-search-group" data-category={group.id} style={{ "--workspace-category-color": group.color } as CSSProperties}>
                      <GroupIcon aria-hidden="true" /><span>{group.label}</span><small>{group.items.length}</small>
                    </div>
                    {group.items.map(a => renderAction(a))}
                  </Fragment>;
                })
              ) : (
                sortedMatched.map(a => renderAction(a))
              )}
              {showCreateTools ? renderCreateTools?.({
                query,
                onClose: () => close(),
                triggerRef: createTrigger,
                paneCount,
                onPaneCountChange: handlePaneCountChange,
                onNavigate: workspace ? navigate : undefined,
                availablePanes
              }) : null}
              {!matched.length && !showCreateTools && (!isPageTab(category) || isSearching || customizing) ? <p className="desktop-menu-empty">{isSearching ? "No matching actions. Try a different name." : "No actions available in this category."}</p> : null}
            </div>}
            </div>
            {(open === "help" || workspace) && !isSearching && (footer || footerActions.length) ? <div className="desktop-menu-footer">
              {footerActions.length ? <div className="workspace-footer-actions">{footerActions.map(action => {
                const FooterIcon = action.icon;
                return <button key={action.id} type="button" className="workspace-footer-action" data-action-id={action.id}
                  aria-label={action.ariaLabel} title={action.title} disabled={action.disabled}
                  onClick={() => { close(); action.onClick(); }}>
                  <FooterIcon aria-hidden="true" /><span>{workspaceActionLabel(action)}</span>
                </button>;
              })}</div> : null}
              {footer}
            </div> : null}
          </div>
        </> : null}
      </>,
      document.body)}
  </nav>;
}
