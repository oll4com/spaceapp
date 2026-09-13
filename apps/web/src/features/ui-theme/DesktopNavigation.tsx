import { railPopoverPosition, useMenuWheel } from "../rail-popover.js";
import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import type { IconToolbarAction } from "../../icon-toolbar.js";
import { ChevronRight, Grid2X2, MoreHorizontal, Plus, Search, ShieldCheck, UserCheck, Wrench, X } from "./app-icons.js";
import { desktopActionDescriptions, desktopActionGroup, desktopActionVisible, desktopGroups, type DesktopGroup } from "./desktop-navigation.js";
import { workspaceActionCategory, workspaceActionLabel, workspaceActionToggle, workspaceCategories, workspaceQuickActionIds, type WorkspaceCategory } from "./workspace-actions.js";
import "./desktop-navigation.css";

const navigationOpenEvent = "space:navigation-open";
const mobileWidth = 768;
export function DesktopNavigation({ actions, adminMode, canAdmin, onModeChange, onAction, footer, version, renderCreateTools, createOnly = false, docksOnly = false, toolsOnly = false, workspaceOnly = false }: {
  createOnly?: boolean; docksOnly?: boolean; toolsOnly?: boolean; workspaceOnly?: boolean;
  actions: IconToolbarAction[]; adminMode: boolean; canAdmin: boolean;
  onModeChange: () => void;
  onAction: (action: IconToolbarAction, anchor: HTMLButtonElement) => void;
  footer?: ReactNode; version?: ReactNode;
  renderCreateTools?: (options: { query: string; onClose: () => void; triggerRef: RefObject<HTMLButtonElement | null> }) => ReactNode;
}) {
  const instance = useId();
  const railOnly = createOnly || docksOnly || toolsOnly || workspaceOnly;
  const menuId = `workspace-navigation-${instance}`;
  const [open, setOpen] = useState<DesktopGroup | null>(null);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<WorkspaceCategory>("work");
  const [compact, setCompact] = useState(false);
  const [mobile, setMobile] = useState(() => window.innerWidth <= mobileWidth);
  const nav = useRef<HTMLElement>(null);
  const triggers = useRef<Partial<Record<DesktopGroup, HTMLButtonElement | null>>>({});
  const menu = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const createTrigger = useRef<HTMLButtonElement | null>(null);
  useMenuWheel(menu, ".desktop-menu-action:not(:disabled), .cli-launcher-embedded button:not(:disabled)", Boolean(open), createTrigger, true);
  const [position, setPosition] = useState(() => ({
    left: 8,
    top: 56,
    height: typeof window !== "undefined" ? Math.max(520, window.innerHeight - 16) : 520
  }));
  const close = (restore = false) => {
    setOpen(null);
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
  useEffect(() => { setOpen(null); setQuery(""); }, [adminMode]);
  const toolOrder = ["vpn-city", "reload-room", "clip-tool", "resource-indicators", "cli-floats", "quick-links", "font-down", "pane-span-all", "sensitive-data"];
  const visible = actions.filter(action => {
    if ((workspaceOnly || !railOnly) && ["room-focus", "previous-room", "next-room"].includes(action.id)) return true;
    if (!desktopActionVisible(action.id, adminMode && canAdmin)) return false;
    if (docksOnly) return action.id.startsWith("surface-");
    if (toolsOnly) return toolOrder.includes(action.id);
    return true;
  });
  const workspace = open === "workspace" && !docksOnly;
  const isSearching = Boolean(query.trim());
  const quick = workspace && !isSearching ? workspaceQuickActionIds.flatMap(id => visible.filter(a => a.id === id)) : [];
  const matched = visible.filter(action => {
    if (renderCreateTools && action.id === "add-cli") return false;
    if (isSearching) return `${workspaceActionLabel(action)} ${action.label} ${desktopActionDescriptions[action.id] ?? ""}`.toLowerCase().includes(query.trim().toLowerCase());
    if (docksOnly || toolsOnly) return true;
    const group = desktopActionGroup(action.id);
    if (workspace) return !workspaceQuickActionIds.includes(action.id) && (group === "workspace" || group === "rooms" || (compact || workspaceOnly) && ["help", "admin"].includes(group)) && workspaceActionCategory(action.id) === category;
    return group === open;
  });
  const showCreateTools = Boolean(renderCreateTools && !docksOnly && !toolsOnly && !workspaceOnly && (open === "create" || isSearching));
  useLayoutEffect(() => {
    if (!open) return;
    const reposition = () => {
      const rect = triggers.current[open]?.getBoundingClientRect();
      if (!rect) return;
      const viewport = window.visualViewport;
      const viewportTop = viewport?.offsetTop ?? 0;
      const viewportHeight = viewport?.height ?? window.innerHeight;
      const width = Math.min(workspace ? 560 : 360, window.innerWidth - 16);
      const railPosition = railPopoverPosition(triggers.current[open] ?? null, menu.current?.getBoundingClientRect().width || width);
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
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
    window.visualViewport?.addEventListener("resize", reposition);
    window.visualViewport?.addEventListener("scroll", reposition);
    return () => {
      menuObserver?.disconnect();
      window.removeEventListener("resize", reposition); window.removeEventListener("scroll", reposition, true);
      window.visualViewport?.removeEventListener("resize", reposition); window.visualViewport?.removeEventListener("scroll", reposition);
    };
  }, [railOnly, open, workspace, mobile]);
  useEffect(() => {
    if (!open) return;
    if (!mobile && !window.matchMedia?.("(pointer: coarse)")?.matches) search.current?.focus();
    else menu.current?.focus();
    const dismiss = (event: PointerEvent) => {
      if (event.button === 1) return;
      const target = event.target as Node;
      if (menu.current?.contains(target) || Object.values(triggers.current).some(node => node?.contains(target))) return;
      setOpen(null);
    };
    document.addEventListener("pointerdown", dismiss, true);
    return () => document.removeEventListener("pointerdown", dismiss, true);
  }, [open, mobile]);
  const source = open ? triggers.current[open]?.closest<HTMLElement>("[data-shell-mode]") : null;
  const renderAction = (action: IconToolbarAction, quickAction = false) => {
    const Icon = action.icon;
    const toggle = workspaceActionToggle(action);
    const reason = action.disabled ? action.disabledReason : undefined;
    const label = quickAction || workspace || docksOnly || toolsOnly ? workspaceActionLabel(action) : action.label;
    return <button key={action.id} type="button" className="desktop-menu-action" disabled={action.disabled}
      onWheel={action.onWheel} data-sensitive-ignore={action.dataSensitiveIgnore ? "true" : undefined}
      aria-label={toggle === undefined ? action.ariaLabel : label} aria-pressed={toggle ?? action.ariaPressed}
      aria-haspopup={action.ariaHasPopup}
      title={reason ?? action.title}
      onClick={() => { const anchor = open ? triggers.current[open] : null; close(); if (anchor) { anchor.focus(); onAction(action, anchor); } }}>
      <Icon aria-hidden="true" />
      <span><strong>{label}</strong>{reason ? <small>{reason}</small> : null}</span>
      {toggle !== undefined ? <small className="desktop-action-status" data-on={toggle}>{toggle ? "On" : "Off"}</small> : action.ariaPressed ? <small className="desktop-action-status">Open</small> : null}
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
          createTrigger.current = event.currentTarget; setQuery(""); setCategory("work");
          window.dispatchEvent(new CustomEvent(navigationOpenEvent, { detail: instance }));
          setOpen(open === group.id ? null : group.id);
        }}>
        {workspaceOnly ? <MoreHorizontal aria-hidden="true" /> : docksOnly ? <Grid2X2 aria-hidden="true" /> : createOnly ? <Plus aria-hidden="true" /> : toolsOnly ? <Wrench aria-hidden="true" /> : <>{group.label}<ChevronRight className="desktop-menu-chevron" aria-hidden="true" /></>}
      </button> : null)}
    {!railOnly && canAdmin ? <button type="button" className="desktop-mode-switch" aria-label="Admin mode" aria-pressed={adminMode}
      title={adminMode ? "Switch to User mode" : "Switch to Admin mode"} onClick={onModeChange}>
      {adminMode ? <ShieldCheck aria-hidden="true" /> : <UserCheck aria-hidden="true" />}<span>{adminMode ? "Admin mode" : "User mode"}</span>
    </button> : null}
    {!railOnly && version ? <div className="desktop-toolbar-version">{version}</div> : null}
    {open ? createPortal(<>
      {mobile ? <div className="desktop-navigation-backdrop" onPointerDown={() => close(true)} /> : null}
      <div id={menuId} ref={menu} className={`desktop-navigation-menu${workspace ? " is-workspace" : ""}${mobile ? " is-mobile" : ""}`}
        role="dialog" aria-modal={mobile || undefined}
        aria-label={docksOnly ? "Docks" : toolsOnly ? "Workspace tools" : isSearching ? "Find an action" : workspace ? "Workspace" : desktopGroups.find(g => g.id === open)?.label}
        tabIndex={-1} data-ui-theme={source?.dataset.uiTheme} data-color-mode={source?.dataset.colorMode} data-room-theme={source?.dataset.roomTheme}
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
        {workspace && !isSearching ? <div className="workspace-category-tabs" role="tablist" aria-label="Workspace categories">
          {workspaceCategories.map(item => <button key={item.id} id={`${menuId}-${item.id}`} type="button" role="tab"
            aria-selected={category === item.id} aria-controls={`${menuId}-actions`} tabIndex={category === item.id ? 0 : -1}
            onKeyDown={event => {
              if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
              event.preventDefault();
              const index = workspaceCategories.findIndex(c => c.id === category);
              const next = event.key === "Home" ? 0 : event.key === "End" ? 3 : (index + (event.key === "ArrowRight" ? 1 : 3)) % 4;
              setCategory(workspaceCategories[next]!.id);
              document.getElementById(`${menuId}-${workspaceCategories[next]!.id}`)?.focus();
            }} onClick={() => setCategory(item.id)}>{item.label}</button>)}
        </div> : null}
        <div id={`${menuId}-actions`} className="desktop-menu-actions" role={workspace && !isSearching ? "tabpanel" : undefined}
          aria-labelledby={workspace && !isSearching ? `${menuId}-${category}` : undefined}>
          {matched.map(a => renderAction(a))}
          {showCreateTools ? renderCreateTools?.({ query, onClose: () => close(), triggerRef: createTrigger }) : null}
          {!matched.length && !showCreateTools ? <p className="desktop-menu-empty">{isSearching ? "No matching actions. Try a different name." : "No actions available in this category."}</p> : null}
        </div>
        {(open === "help" || workspace && category === "settings" && compact) && !isSearching && footer ? <div className="desktop-menu-footer">{footer}</div> : null}
      </div>
    </>, document.body) : null}
  </nav>;
}
