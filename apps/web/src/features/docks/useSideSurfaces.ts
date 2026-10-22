import { useEffect, useMemo, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from "react";
import { getSpaceRuntime, type SpaceRuntime } from "../../runtime/SpaceRuntime.js";
import type { ShellMode } from "../pane-grid/pane-grid-layout.js";
import { SOURCE_CONTROL_CONNECTION_EVENT, sourceControlClient } from "../source-control/client.js";
import { openSystemHealth } from "../system-health/health-model.js";
import { writeDockSession, type DockSession } from "../workspace-session.js";
import type { SideSurface } from "./dock-types.js";
import { sideSurfaceMeta } from "./side-surface-meta.js";
import { DOCK_DEFINITIONS } from "./use-docks-visibility.js";

// Which dock (side surface) is active and whether it is shown: inline beside the
// board on desktop, as a modal drawer on compact shells.

export interface SideSurfacesContext {
  shellMode: ShellMode;
  /** Dock state restored from this tab's session. */
  restoredDock: DockSession | null;
  /** Desktop rail visibility: a server-synced user preference. */
  isDesktopSideSurfaceOpen: boolean;
  setIsDesktopSideSurfaceOpen: Dispatch<SetStateAction<boolean>>;
  runtimeKind: SpaceRuntime["kind"] | null;
  isAuthenticated: boolean | undefined;
  role: string | undefined;
  isDockHidden: (surface: SideSurface) => boolean;
}

export interface SideSurfaces {
  activeSideSurface: SideSurface;
  setActiveSideSurface: Dispatch<SetStateAction<SideSurface>>;
  isDesktopSideSurfaceOpen: boolean;
  setIsDesktopSideSurfaceOpen: Dispatch<SetStateAction<boolean>>;
  isCompactSideSurfaceOpen: boolean;
  setIsCompactSideSurfaceOpen: Dispatch<SetStateAction<boolean>>;
  compactSideSurfaceRef: RefObject<HTMLElement | null>;
  compactSideSurfaceTriggerRef: RefObject<HTMLElement | null>;
  /** A connected source-control provider exists. */
  sourceControlEnabled: boolean;
  setSourceControlEnabled: Dispatch<SetStateAction<boolean>>;
  /** Source Control works locally without a provider account. */
  sourceControlAvailable: boolean;
  isCompactShell: boolean;
  isSideSurfaceOpen: boolean;
  activeSideSurfaceLabel: string;
  activeSideSurfaceDockTitle: string;
  activeSideSurfaceCloseLabel: string;
  showInlineSideSurface: boolean;
  showOverlaySideSurface: boolean;
  /** The desktop dock stays mounted (hidden) once opened. */
  mountInlineSideSurface: boolean;
  availableDocks: SideSurface[];
  sideSurfaceToggleLabel: (surface: SideSurface) => string;
  closeCompactSideSurface: () => void;
  toggleSideSurface: (surface: SideSurface) => void;
  /** Previous/Next follow the room toolbar's dock buttons (`launcherActions`) as the user arranged them. */
  navigateDock: (direction: "prev" | "next", launcherActions?: readonly { id: string }[]) => void;
  /** Activates a dock and shows it in the current shell. */
  openSideSurface: (surface: SideSurface) => void;
}

export function useSideSurfaces({
  shellMode,
  restoredDock,
  isDesktopSideSurfaceOpen,
  setIsDesktopSideSurfaceOpen,
  runtimeKind,
  isAuthenticated,
  role,
  isDockHidden
}: SideSurfacesContext): SideSurfaces {
  const runtime = getSpaceRuntime();
  const [activeSideSurface, setActiveSideSurface] = useState<SideSurface>(() => (restoredDock?.surface as SideSurface | undefined) ?? "rooms");
  const [sourceControlEnabled, setSourceControlEnabled] = useState(false);
  const [isCompactSideSurfaceOpen, setIsCompactSideSurfaceOpen] = useState(() => restoredDock?.compactOpen ?? false);
  const compactSideSurfaceRef = useRef<HTMLElement>(null);
  const compactSideSurfaceTriggerRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    writeDockSession(runtime.platform.sessionStorage, { surface: activeSideSurface, desktopOpen: isDesktopSideSurfaceOpen, compactOpen: isCompactSideSurfaceOpen });
  }, [activeSideSurface, isDesktopSideSurfaceOpen, isCompactSideSurfaceOpen]);

  const isCompactShell = shellMode !== "desktop";
  const isSideSurfaceOpen = isCompactShell ? isCompactSideSurfaceOpen : isDesktopSideSurfaceOpen;
  const activeSideSurfaceLabel = sideSurfaceMeta[activeSideSurface].surfaceLabel;
  // The visible title uses the same short name as the dock button and Docks settings.
  const activeSideSurfaceDockTitle = useMemo(() => {
    const definition = DOCK_DEFINITIONS.find((dock) => dock.id === activeSideSurface);
    return definition?.label ?? (sideSurfaceMeta[activeSideSurface]?.surfaceLabel || activeSideSurface).replace(/ dock$/i, "");
  }, [activeSideSurface]);
  const activeSideSurfaceCloseLabel = `Close ${sideSurfaceMeta[activeSideSurface].label}`;
  const showInlineSideSurface = !isCompactShell && isDesktopSideSurfaceOpen;
  const showOverlaySideSurface = isCompactShell && isCompactSideSurfaceOpen;
  // Once opened, the desktop dock stays mounted (hidden) after closing so a
  // reopen keeps its cached docks, data, filters and scroll position. Compact
  // shells use the drawer instead, so the inline host is dropped there.
  const [inlineSideSurfaceRetained, setInlineSideSurfaceRetained] = useState(false);
  if (showInlineSideSurface && !inlineSideSurfaceRetained) setInlineSideSurfaceRetained(true);
  const mountInlineSideSurface = !isCompactShell && (showInlineSideSurface || inlineSideSurfaceRetained);

  function sideSurfaceToggleLabel(surface: SideSurface) {
    const verb = isSideSurfaceOpen && activeSideSurface === surface
      ? (isCompactShell ? "Close" : "Hide")
      : (isCompactShell || surface === "agent-files" ? "Open" : "Show");
    return `${verb} ${sideSurfaceMeta[surface].label}`;
  }

  function closeCompactSideSurface() {
    setIsCompactSideSurfaceOpen(false);
  }

  function toggleSideSurface(surface: SideSurface) {
    if (surface === "health" && role === "ADMIN") { openSystemHealth(); return; }
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

  const dockOrder: SideSurface[] = ["rooms", "nous", "notifications", "room-agent", "shared-chat", "media", "streaming", "agent-files", "clipboard", "tasks", "vault", "links", "settings", "cli", "agent-sessions"];
  // Source Control works locally without a provider account; personal dock hiding still applies.
  const sourceControlAvailable = runtimeKind === "live" && Boolean(isAuthenticated);
  if (sourceControlAvailable && !isDockHidden("source-control")) dockOrder.splice(dockOrder.indexOf("settings"), 0, "source-control");
  const availableDocks = dockOrder.filter((surface) =>
    (surface !== "streaming" || role === "ADMIN") && !isDockHidden(surface)
  );

  function openSideSurface(surface: SideSurface) {
    setActiveSideSurface(surface);
    if (isCompactShell) {
      setIsCompactSideSurfaceOpen(true);
    } else {
      setIsDesktopSideSurfaceOpen(true);
    }
  }

  function navigateDock(direction: "prev" | "next", launcherActions: readonly { id: string }[] = []) {
    // Previous/Next follow the dock buttons as the user arranged them.
    const launcherOrder = launcherActions
      .map((action) => action.id.startsWith("surface-") ? action.id.slice("surface-".length) as SideSurface : null)
      .filter((surface): surface is SideSurface => surface !== null && availableDocks.includes(surface));
    const order = [...launcherOrder, ...availableDocks.filter((surface) => !launcherOrder.includes(surface))];
    const currentIndex = order.indexOf(activeSideSurface);
    const offset = direction === "next" ? 1 : -1;
    const nextIndex = (currentIndex + offset + order.length) % order.length;
    const nextSurface = order[nextIndex];
    if (!nextSurface) return;
    openSideSurface(nextSurface);
  }

  return {
    activeSideSurface,
    setActiveSideSurface,
    isDesktopSideSurfaceOpen,
    setIsDesktopSideSurfaceOpen,
    isCompactSideSurfaceOpen,
    setIsCompactSideSurfaceOpen,
    compactSideSurfaceRef,
    compactSideSurfaceTriggerRef,
    sourceControlEnabled,
    setSourceControlEnabled,
    sourceControlAvailable,
    isCompactShell,
    isSideSurfaceOpen,
    activeSideSurfaceLabel,
    activeSideSurfaceDockTitle,
    activeSideSurfaceCloseLabel,
    showInlineSideSurface,
    showOverlaySideSurface,
    mountInlineSideSurface,
    availableDocks,
    sideSurfaceToggleLabel,
    closeCompactSideSurface,
    toggleSideSurface,
    navigateDock,
    openSideSurface
  };
}

/**
 * The compact drawer's focus trap, the admin redirect of the Health dock to System Health,
 * and the source-control connection subscription. Called where these effects ran in App.
 */
export function useSideSurfaceEffects(
  sideSurfaces: SideSurfaces,
  { runtimeKind, isAuthenticated, role, userId, startupReady = true }: {
    runtimeKind: SpaceRuntime["kind"] | null;
    isAuthenticated: boolean | undefined;
    role: string | undefined;
    userId: string | undefined;
    /** Delay the source-control probe until the first room is interactive. */
    startupReady?: boolean;
  }
): void {
  const {
    showOverlaySideSurface,
    compactSideSurfaceRef,
    compactSideSurfaceTriggerRef,
    closeCompactSideSurface,
    activeSideSurface,
    isSideSurfaceOpen,
    setIsDesktopSideSurfaceOpen,
    setIsCompactSideSurfaceOpen,
    setActiveSideSurface,
    setSourceControlEnabled,
    isCompactShell
  } = sideSurfaces;

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
      // A modal opened from inside the drawer (project picker, diff dialog) owns its own Escape and focus.
      const nestedModal = event.target instanceof Element ? event.target.closest('dialog[open], [aria-modal="true"]') : null;
      if (nestedModal && nestedModal !== drawer && drawer?.contains(nestedModal)) return;
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

  useEffect(() => {
    if (role === "ADMIN" && activeSideSurface === "health" && isSideSurfaceOpen) {
      setIsDesktopSideSurfaceOpen(false);
      setIsCompactSideSurfaceOpen(false);
      openSystemHealth();
    }
  }, [role, activeSideSurface, isSideSurfaceOpen]);

  useEffect(() => {
    if (!startupReady || runtimeKind !== "live" || !isAuthenticated) { setSourceControlEnabled(false); return; }
    const controller = new AbortController();
    const refreshConnections = async (event?: Event) => {
      try {
        const connections = await sourceControlClient.connections(controller.signal);
        if (controller.signal.aborted) return;
        const enabled = connections.some(connection => connection.status === "CONNECTED");
        setSourceControlEnabled(enabled);
        if (enabled && (event as CustomEvent | undefined)?.detail?.openDock) {
          setActiveSideSurface("source-control");
          if (isCompactShell) setIsCompactSideSurfaceOpen(true); else setIsDesktopSideSurfaceOpen(true);
        }
      } catch { if (!controller.signal.aborted) setSourceControlEnabled(false); }
    };
    void refreshConnections(); window.addEventListener(SOURCE_CONTROL_CONNECTION_EVENT, refreshConnections);
    return () => { controller.abort(); window.removeEventListener(SOURCE_CONTROL_CONNECTION_EVENT, refreshConnections); };
  }, [runtimeKind, isAuthenticated, userId, isCompactShell, startupReady]);
}
