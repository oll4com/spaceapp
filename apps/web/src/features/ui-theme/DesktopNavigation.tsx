import { dispatchRailMenuChange, railPopoverPosition, useMenuWheel } from "../rail-popover.js";
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "motion/react";
import type { IconToolbarAction } from "../../icon-toolbar.js";
import { ChevronRight, Grid2X2, GripVertical, Minus, MoreHorizontal, Plus, Search, ShieldCheck, SlidersHorizontal, Sparkles, UserCheck, Wrench, X } from "./app-icons.js";
import { desktopActionDescriptions, desktopActionGroup, desktopActionVisible, desktopGroups, type DesktopGroup } from "./desktop-navigation.js";
import { workspaceActionCategory, workspaceActionLabel, workspaceActionToggle, workspaceCategories, workspaceQuickActionIds, type WorkspaceCategory } from "./workspace-actions.js";
import { ACTION_TO_LOWER_RAIL_ID, LOWER_RAIL_HIDDEN_KEY, LOWER_RAIL_NON_HIDEABLE, LOWER_RAIL_VISIBILITY_IDS, readHiddenRailIds } from "./use-rail-visibility.js";
import { LOWER_RAIL_IDS } from "./use-rail-order.js";
import "./desktop-navigation.css";

const navigationOpenEvent = "space:navigation-open";
const mobileWidth = 768;
export function DesktopNavigation({ actions, adminMode, canAdmin, onModeChange, onAction, footer, version, renderCreateTools, createOnly = false, docksOnly = false, toolsOnly = false, workspaceOnly = false, hiddenRailIds, emptySlots }: {
  createOnly?: boolean; docksOnly?: boolean; toolsOnly?: boolean; workspaceOnly?: boolean;
  actions: IconToolbarAction[]; adminMode: boolean; canAdmin: boolean;
  onModeChange: () => void;
  onAction: (action: IconToolbarAction, anchor: HTMLButtonElement, count?: number) => void;
  footer?: ReactNode; version?: ReactNode;
  renderCreateTools?: (options: {
    query: string;
    onClose: () => void;
    triggerRef: RefObject<HTMLButtonElement | null>;
    paneCount?: number;
    onPaneCountChange?: (count: number | ((prev: number) => number)) => void;
  }) => ReactNode;
  hiddenRailIds?: string[];
  emptySlots?: {
    count: number;
    min: number;
    max: number;
    onIncrement: () => void;
    onDecrement: () => void;
  };
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
  const [open, setOpen] = useState<DesktopGroup | null>(null);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<WorkspaceCategory>("docks");
  const [compact, setCompact] = useState(false);
  const [mobile, setMobile] = useState(() => window.innerWidth <= mobileWidth);
  const nav = useRef<HTMLElement>(null);
  const triggers = useRef<Partial<Record<DesktopGroup, HTMLButtonElement | null>>>({});
  const menu = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const createTrigger = useRef<HTMLButtonElement | null>(null);
  useMenuWheel(menu, ".desktop-menu-action:not(:disabled), .cli-launcher-embedded button:not(:disabled)", Boolean(open), createTrigger, true);
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
  const isDraggingCreateRef = useRef(false);
  const [paneCount, setPaneCount] = useState(1);
  const [position, setPosition] = useState(() => ({
    left: 8,
    top: 56,
    height: typeof window !== "undefined" ? Math.max(520, window.innerHeight - 16) : 520
  }));
  const close = (restore = false) => {
    setOpen(null);
    setPaneCount(1);
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
  useEffect(() => { setOpen(null); setQuery(""); setPaneCount(1); }, [adminMode]);
  useEffect(() => {
    dispatchRailMenuChange();
  }, [open]);
  const toolOrder = [
    "widget-clock",
    "widget-countdown-timer",
    "widget-pushup-reminder",
    "widget-spaceapp-promo",
    "widget-ai-quota",
    "toggle-admin-mode",
    "memory-workspace",
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
    "resource-indicators",
    "cli-floats",
    "sensitive-data",
    "font-down",
    "vpn-city",
    "reload-room",
    "browser-fullscreen",
    "clip-tool"
  ];
  const visible = actions.filter(action => {
    if (action.id === "add-empty-slots") return false;
    if ((workspaceOnly || !railOnly) && ["room-focus", "previous-room", "next-room"].includes(action.id)) return true;
    if (!desktopActionVisible(action.id, adminMode && canAdmin)) return false;
    if (docksOnly) return action.id.startsWith("surface-");
    if (toolsOnly) {
      if (toolOrder.includes(action.id)) return true;
      const railId = ACTION_TO_LOWER_RAIL_ID[action.id] ?? (LOWER_RAIL_IDS.includes(action.id) ? action.id : undefined);
      if (railId && activeHiddenRailIds.includes(railId)) return true;
      return false;
    }
    return true;
  });
  const visibleCategories = mobile ? workspaceCategories.filter((item) => item.id !== "widgets") : workspaceCategories;
  const workspace = open === "workspace" && !docksOnly;
  const isSearching = Boolean(query.trim());
  const quick = workspace && !isSearching ? workspaceQuickActionIds.flatMap(id => visible.filter(a => a.id === id)) : [];
  const matched = visible.filter(action => {
    if (renderCreateTools && action.id === "add-cli") return false;
    if (isSearching) return `${workspaceActionLabel(action)} ${action.label} ${desktopActionDescriptions[action.id] ?? ""}`.toLowerCase().includes(query.trim().toLowerCase());
    if (docksOnly || toolsOnly) return true;
    const group = desktopActionGroup(action.id);
    if (workspace) return !workspaceQuickActionIds.includes(action.id) && group !== "create" && workspaceActionCategory(action.id) === category;
    return group === open;
  });
  const sortedMatched = useMemo(() => {
    if (toolsOnly) {
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
  }, [matched, toolsOnly, isSearching, open, createOnly, createOrder, toolOrder, activeHiddenRailIds]);
  const showCreateTools = Boolean(renderCreateTools && !docksOnly && !toolsOnly && !workspaceOnly && (open === "create" || isSearching));
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
      if (event.button === 1 || isDraggingCreateRef.current) return;
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
        isDraggingCreateRef.current = true;
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
            } catch {}
          }
        }
        dragOverCreateActionIdRef.current = null;
        setDraggedCreateActionId(null);
        setDragOverCreateActionId(null);
        window.setTimeout(() => {
          isDraggingCreateRef.current = false;
        }, 120);
      }
    };

    window.addEventListener("pointermove", onPointerMove, { passive: false });
    window.addEventListener("pointerup", onPointerUp, { capture: true });
    window.addEventListener("pointercancel", onPointerUp, { capture: true });
  };

  const renderAction = (action: IconToolbarAction, quickAction = false) => {
    const Icon = action.icon;
    const toggle = workspaceActionToggle(action);
    const reason = action.disabled ? action.disabledReason : undefined;
    const description = mobile ? undefined : reason ?? (workspace && !quickAction ? desktopActionDescriptions[action.id] : undefined);
    const label = quickAction || workspace || docksOnly || toolsOnly ? workspaceActionLabel(action) : action.label;
    const isCreateDraggable = (open === "create" || createOnly) && !isSearching && !action.disabled;
    const isDragging = draggedCreateActionId === action.id;
    const isDragOver = dragOverCreateActionId === action.id;

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
            if (isDraggingCreateRef.current) return;
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
      data-category={workspace ? workspaceActionCategory(action.id) : undefined}
      style={workspace ? { "--workspace-category-color": workspaceCategories.find(item => item.id === workspaceActionCategory(action.id))?.color } as CSSProperties : undefined}
      disabled={action.disabled}
      draggable={false}
      onDragStart={(e) => e.preventDefault()}
      onPointerDown={isCreateDraggable ? (e) => handleCreatePointerDown(e, action.id) : undefined}
      onWheel={action.onWheel} data-sensitive-ignore={action.dataSensitiveIgnore ? "true" : undefined}
      aria-label={toggle === undefined ? action.ariaLabel : label} aria-pressed={toggle ?? action.ariaPressed}
      aria-haspopup={action.ariaHasPopup}
      title={reason ?? action.title}
      onClick={() => {
        if (isDraggingCreateRef.current) return;
        const anchor = open ? triggers.current[open] : null;
        const countToRun = (open === "create" || createOnly) ? paneCount : 1;
        const isWidgetToggle = action.id.startsWith("widget-");
        if (!isWidgetToggle) {
          close();
        }
        if (anchor) {
          if (!isWidgetToggle) anchor.focus();
          if (countToRun > 1) onAction(action, anchor, countToRun);
          else onAction(action, anchor);
        } else {
          action.onClick();
        }
      }}>
      <Icon aria-hidden="true" />
      <span><strong>{label}</strong>{description ? <small>{description}</small> : null}</span>
      <span className="desktop-action-trailing">
        {toggle !== undefined ? <small className="desktop-action-status" data-on={toggle}>{toggle ? "On" : "Off"}</small> : action.ariaPressed ? <small className="desktop-action-status">Open</small> : null}
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
    {groups.map(group => (workspaceOnly || docksOnly || toolsOnly ? visible.length > 0 : visible.some(a => desktopActionGroup(a.id) === group.id || group.id === "workspace" && desktopActionGroup(a.id) === "rooms")) ?
      <button key={group.id} ref={node => { triggers.current[group.id] = node; }}
        className={railOnly ? "room-toolbar-visibility-button" : undefined} type="button"
        data-rail-id={workspaceOnly ? "more" : docksOnly ? "docks" : toolsOnly ? "tools" : createOnly ? "create" : undefined}
        aria-label={workspaceOnly ? "More workspace actions" : docksOnly ? "Show docks" : toolsOnly ? "Workspace tools" : createOnly ? "Create" : undefined}
        title={workspaceOnly ? "More workspace actions" : group.label} aria-haspopup="dialog" aria-expanded={open === group.id}
        aria-controls={open === group.id ? menuId : undefined}
        onClick={event => {
          createTrigger.current = event.currentTarget; setQuery(""); setCategory("docks"); setPaneCount(1);
          window.dispatchEvent(new CustomEvent(navigationOpenEvent, { detail: instance }));
          setOpen(open === group.id ? null : group.id);
        }}>
        {workspaceOnly ? <MoreHorizontal aria-hidden="true" /> : docksOnly ? <Grid2X2 aria-hidden="true" /> : createOnly ? <Plus aria-hidden="true" /> : toolsOnly ? <Wrench aria-hidden="true" /> : mobile ? group.id === "create" ? <Plus aria-hidden="true" /> : <Wrench aria-hidden="true" /> : <>{group.label}<ChevronRight className="desktop-menu-chevron" aria-hidden="true" /></>}
      </button> : null)}
    {!railOnly && canAdmin ? <button type="button" className="desktop-mode-switch" aria-label="Admin mode" aria-pressed={adminMode}
      title={adminMode ? "Switch to User mode" : "Switch to Admin mode"} onClick={onModeChange}>
      {adminMode ? <ShieldCheck aria-hidden="true" /> : <UserCheck aria-hidden="true" />}<span>{adminMode ? "Admin mode" : "User mode"}</span>
    </button> : null}
    {createPortal(
      <AnimatePresence>
        {open ? <>
          {mobile ? <div className="desktop-navigation-backdrop" onPointerDown={() => close(true)} /> : null}
          <motion.div
            id={menuId} ref={menu}
            className={`desktop-navigation-menu${workspace ? " is-workspace" : ""}${docksOnly ? " is-docks" : ""}${toolsOnly ? " is-tools" : ""}${mobile ? " is-mobile" : ""}`}
            role="dialog" aria-modal={mobile || undefined}
            aria-label={docksOnly ? "Docks" : toolsOnly ? "Workspace tools" : isSearching ? "Find an action" : workspace ? "Workspace" : desktopGroups.find(g => g.id === open)?.label}
            tabIndex={-1} data-ui-theme={source?.dataset.uiTheme} data-color-mode={source?.dataset.colorMode} data-room-theme={source?.dataset.roomTheme}
            initial={{ opacity: 0, scale: 0.97, y: -6 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.97, y: -6 }}
            transition={{ duration: 0.18, ease: [0.4, 0, 0.2, 1] }}
            style={{ left: position.left, top: mobile || railOnly ? undefined : position.top, bottom: !mobile && railOnly ? window.innerHeight - position.top : mobile ? Math.max(8, window.innerHeight - position.top - position.height) : undefined, maxHeight: position.height, "--navigation-available-height": `${position.height}px` } as CSSProperties}
            onKeyDown={event => {
              if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(true); return; }
              if (event.key === "Tab" && mobile) {
                const nodes = Array.from(menu.current?.querySelectorAll<HTMLElement>('input, button:not(:disabled)') ?? []).filter(node => node.tabIndex >= 0);
                if (event.shiftKey && (document.activeElement === nodes[0] || document.activeElement === menu.current)) { event.preventDefault(); nodes.at(-1)?.focus(); }
                else if (!event.shiftKey && document.activeElement === nodes.at(-1)) { event.preventDefault(); nodes[0]?.focus(); }
                return;
              }
              if (!["ArrowDown", "ArrowUp"].includes(event.key)) return;
              const buttons = Array.from(menu.current?.querySelectorAll<HTMLButtonElement>(".desktop-menu-action:not(:disabled), .cli-launcher-embedded button:not(:disabled)") ?? []);
              if (!buttons.length) return;
              event.preventDefault();
              const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
              const next = index < 0 ? (event.key === "ArrowDown" ? 0 : buttons.length - 1) : (index + (event.key === "ArrowDown" ? 1 : buttons.length - 1)) % buttons.length;
              buttons[next]?.focus();
            }}
            onBlur={event => { if (!mobile && event.relatedTarget && !event.currentTarget.contains(event.relatedTarget) && !Object.values(triggers.current).some(node => node?.contains(event.relatedTarget as Node))) setOpen(null); }}>
            <div className="desktop-menu-header">
              <label className="desktop-menu-search"><Search aria-hidden="true" />
                <input ref={search} aria-label={docksOnly ? "Find a dock" : toolsOnly ? "Find a tool" : "Find an action"}
                  placeholder="Find an action…" value={query} onChange={event => setQuery(event.target.value)} />
              </label>
              <button type="button" className="desktop-menu-close" aria-label="Close menu" title="Close" onClick={() => close(true)}><X aria-hidden="true" /></button>
            </div>
            {quick.length ? <div className="workspace-quick-actions" aria-label="Quick access">{quick.map(a => renderAction(a, true))}</div> : null}
            {workspace ? <div className="workspace-menu-heading">
              <span><strong>Workspace</strong><small>Everything you need, in one place</small></span>
              <span className="workspace-menu-hint">{isSearching ? `${matched.length} results` : "Browse by category"}</span>
            </div> : null}
            <div className={workspace ? `workspace-browser${isSearching ? " is-searching" : ""}` : "desktop-menu-body"}>
            {workspace && !isSearching ? <div className="workspace-category-tabs" role="tablist" aria-label="Workspace categories" aria-orientation={mobile ? "horizontal" : "vertical"}>
              {visibleCategories.map(item => {
                const CategoryIcon = item.icon;
                const count = visible.filter(action => !workspaceQuickActionIds.includes(action.id) && desktopActionGroup(action.id) !== "create" && workspaceActionCategory(action.id) === item.id).length;
                return <button key={item.id} id={`${menuId}-${item.id}`} type="button" role="tab" aria-label={item.label}
                aria-selected={category === item.id} aria-controls={`${menuId}-actions`} tabIndex={category === item.id ? 0 : -1}
                style={{ "--workspace-category-color": item.color } as CSSProperties}
                onKeyDown={event => {
                  if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
                  event.preventDefault(); event.stopPropagation();
                  const index = visibleCategories.findIndex(c => c.id === category);
                  const length = visibleCategories.length;
                  const next = event.key === "Home" ? 0 : event.key === "End" ? length - 1 : (index + (["ArrowRight", "ArrowDown"].includes(event.key) ? 1 : length - 1)) % length;
                  setCategory(visibleCategories[next]!.id);
                  document.getElementById(`${menuId}-${visibleCategories[next]!.id}`)?.focus();
                }} onClick={() => setCategory(item.id)}>
                <CategoryIcon aria-hidden="true" /><span>{item.label}</span><small aria-hidden="true">{count}</small>
              </button>; })}
            </div> : null}
            <div id={`${menuId}-actions`} className="desktop-menu-actions" role={workspace && !isSearching ? "tabpanel" : undefined}
              aria-labelledby={workspace && !isSearching ? `${menuId}-${category}` : undefined}>
              {workspace && !isSearching ? <div className="workspace-section-heading">
                <strong>{workspaceCategories.find(item => item.id === category)?.label}</strong>
                {!mobile ? <small>{workspaceCategories.find(item => item.id === category)?.description}</small> : null}
              </div> : null}
              {toolsOnly && !isSearching ? (() => {
                const isToolToggle = (a: IconToolbarAction) => {
                  if (a.id.startsWith("widget-")) return false;
                  const railId = ACTION_TO_LOWER_RAIL_ID[a.id] ?? (LOWER_RAIL_IDS.includes(a.id) ? a.id : undefined);
                  if (railId && activeHiddenRailIds.includes(railId)) return false;
                  return workspaceActionToggle(a) !== undefined;
                };
                return (
                  <>
                    {sortedMatched.some(a => a.id.startsWith("widget-")) ? (
                      <div className="desktop-tools-widgets-section">
                        <div className="desktop-tools-widgets-header">
                          <Sparkles aria-hidden="true" />
                          <span>Desktop Widgets</span>
                        </div>
                        {sortedMatched.filter(a => a.id.startsWith("widget-")).map(a => renderAction(a))}
                      </div>
                    ) : null}
                    {sortedMatched.filter(a => !a.id.startsWith("widget-") && !isToolToggle(a)).map(a => renderAction(a))}
                    {sortedMatched.some(isToolToggle) ? (
                      <div className="desktop-tools-widgets-section desktop-tools-toggles-section">
                        <div className="desktop-tools-widgets-header">
                          <SlidersHorizontal aria-hidden="true" />
                          <span>Quick Toggles</span>
                        </div>
                        {sortedMatched.filter(isToolToggle).map(a => renderAction(a))}
                      </div>
                    ) : null}
                  </>
                );
              })() : (
                sortedMatched.map(a => renderAction(a))
              )}
              {showCreateTools ? renderCreateTools?.({
                query,
                onClose: () => close(),
                triggerRef: createTrigger,
                paneCount,
                onPaneCountChange: setPaneCount
              }) : null}
              {!matched.length && !showCreateTools ? <p className="desktop-menu-empty">{isSearching ? "No matching actions. Try a different name." : "No actions available in this category."}</p> : null}
            </div>
            </div>
            {(open === "help" || workspace) && !isSearching && footer ? <div className="desktop-menu-footer">{footer}</div> : null}
          </motion.div>
        </> : null}
      </AnimatePresence>,
      document.body)}
  </nav>;
}
