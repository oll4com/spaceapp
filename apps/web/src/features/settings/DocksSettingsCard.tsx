import { useEffect, useState, useMemo, useCallback, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { Grid2X2, RotateCcw, CircleAlert, GripVertical } from "../ui-theme/app-icons.js";
import { SpaceToggle } from "../ui-controls/SpaceToggle.js";
import {
  DOCK_DEFINITIONS,
  NON_HIDEABLE_DOCK_IDS,
  dockOrderRank,
  useDocksVisibility,
  type DockItemConfig
} from "../docks/use-docks-visibility.js";
import {
  sourceControlClient,
  SOURCE_CONTROL_CONNECTION_EVENT
} from "../source-control/client.js";
import "./flat-settings.css";
import "./docks-settings.css";

export interface DocksSettingsCardProps {
  gitPluginsActive?: boolean;
  isAdmin?: boolean;
  onNavigateToPlugins?: () => void;
}

export function DocksSettingsCard({
  gitPluginsActive,
  isAdmin = false,
  onNavigateToPlugins
}: DocksSettingsCardProps) {
  const { isDockVisible, showDock, hideDock, resetDocks, dockOrder, setDockOrder } = useDocksVisibility();
  const [drag, setDrag] = useState<{ id: string; over: string | null } | null>(null);
  const [internalGitActive, setInternalGitActive] = useState<boolean>(Boolean(gitPluginsActive));

  const checkGitConnections = useCallback(async (signal?: AbortSignal) => {
    try {
      const connections = await sourceControlClient.connections(signal);
      if (signal?.aborted) return;
      const isConnected = connections.some((c) => c.status === "CONNECTED");
      setInternalGitActive(isConnected);
    } catch {
      // If fetching fails or offline, fall back to passed prop
      if (!signal?.aborted && gitPluginsActive !== undefined) {
        setInternalGitActive(gitPluginsActive);
      }
    }
  }, [gitPluginsActive]);

  useEffect(() => {
    if (gitPluginsActive !== undefined) {
      setInternalGitActive(gitPluginsActive);
    }
  }, [gitPluginsActive]);

  useEffect(() => {
    const controller = new AbortController();
    void checkGitConnections(controller.signal);

    const handleConnectionChange = () => {
      void checkGitConnections();
    };

    window.addEventListener(SOURCE_CONTROL_CONNECTION_EVENT, handleConnectionChange);
    return () => {
      controller.abort();
      window.removeEventListener(SOURCE_CONTROL_CONNECTION_EVENT, handleConnectionChange);
    };
  }, [checkGitConnections]);

  const displayedDocks = useMemo<DockItemConfig[]>(() => {
    const rank = dockOrderRank(dockOrder);
    return DOCK_DEFINITIONS.filter((dock) => {
      if (dock.requiresAdmin && !isAdmin) return false;
      return true;
    }).sort((a, b) => rank(a.id) - rank(b.id));
  }, [isAdmin, dockOrder]);

  const moveDock = (id: string, target: number) => {
    const ids: string[] = displayedDocks.map((dock) => dock.id).filter((dockId) => dockId !== id);
    ids.splice(Math.max(0, Math.min(ids.length, target)), 0, id);
    setDockOrder(ids);
  };

  // Pointer events instead of HTML drag and drop so touch screens can reorder too.
  const startDrag = (event: ReactPointerEvent<HTMLButtonElement>, id: string) => {
    if (event.button !== 0) return;
    event.preventDefault();
    let over: string | null = null;
    setDrag({ id, over });
    const onMove = (move: PointerEvent) => {
      const targetId = document.elementFromPoint(move.clientX, move.clientY)?.closest<HTMLElement>("[data-dock-id]")?.dataset.dockId;
      over = targetId && targetId !== id ? targetId : null;
      setDrag({ id, over });
    };
    const onEnd = (end: PointerEvent) => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onEnd);
      window.removeEventListener("pointercancel", onEnd);
      setDrag(null);
      if (end.type === "pointerup" && over) moveDock(id, displayedDocks.findIndex((dock) => dock.id === over));
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onEnd);
    window.addEventListener("pointercancel", onEnd);
  };

  const handleOrderKey = (event: KeyboardEvent<HTMLButtonElement>, id: string, index: number) => {
    const step = event.key === "ArrowUp" ? -1 : event.key === "ArrowDown" ? 1 : 0;
    if (!step) return;
    event.preventDefault();
    const button = event.currentTarget;
    moveDock(id, index + step);
    // React moves the row's node when the order changes, which can drop focus.
    requestAnimationFrame(() => button.focus());
  };

  const visibleCount = useMemo(() => {
    return displayedDocks.filter((dock) => {
      if (dock.requiresGitPlugin && !internalGitActive) return false;
      return isDockVisible(dock.id);
    }).length;
  }, [displayedDocks, internalGitActive, isDockVisible]);

  const handleOpenPlugins = () => {
    if (onNavigateToPlugins) {
      onNavigateToPlugins();
      return;
    }
    const pluginsBtn = document.querySelector<HTMLButtonElement>(
      'button[aria-label="Plugins"], button[aria-label="Plugins settings"]'
    );
    if (pluginsBtn) {
      pluginsBtn.click();
      pluginsBtn.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  };

  return (
    <section
      className="agent-settings-card settings-flat-card docks-settings-card"
      aria-label="Workspace docks visibility settings"
    >
      <div className="agent-settings-section-title settings-flat-heading docks-settings-heading">
        <Grid2X2 aria-hidden="true" />
        <span>
          <strong>Workspace docks</strong>
          <small>Choose which docks appear in your workspace navigation and toolbar. Drag a dock to change its place.</small>
        </span>
        <div className="settings-flat-heading-actions">
          <button
            type="button"
            className="docks-settings-reset-btn"
            title="Reset dock visibility and order to defaults"
            aria-label="Reset dock visibility and order to defaults"
            onClick={resetDocks}
          >
            <RotateCcw aria-hidden="true" />
          </button>
        </div>
      </div>

      <div className="docks-toggle-list" role="group" aria-label="Dock toggles">
        {displayedDocks.map((dock, index) => {
          const isGitDock = dock.requiresGitPlugin;
          const isGitDisabled = isGitDock && !internalGitActive;
          const isLocked = Boolean(dock.locked || NON_HIDEABLE_DOCK_IDS.has(dock.id));

          let isChecked = isDockVisible(dock.id);
          let isDisabled = false;
          let detail = dock.description;
          let title: string | undefined;
          let badge = null;

          if (isLocked) {
            isChecked = true;
            isDisabled = true;
            detail = `${dock.description} Always visible to ensure you never lose access to workspace settings.`;
            title = "Always visible. Settings dock cannot be hidden.";
            badge = <span className="dock-status-badge is-muted">Always visible</span>;
          } else if (isGitDisabled) {
            isChecked = false;
            isDisabled = true;
            detail =
              "Default hidden: required plugin is not active. Cannot be enabled until it is activated.";
            title =
              "Default hidden because the required plugin is not active. Cannot be enabled until it is activated.";
            badge = <span className="dock-status-badge is-warning">Default hidden</span>;
          } else if (isGitDock && internalGitActive) {
            badge = <span className="dock-status-badge is-success">Plugin active</span>;
          }

          return (
            <div
              key={dock.id}
              data-dock-id={dock.id}
              className={`dock-item-row-container${drag?.id === dock.id ? " is-dragging" : ""}${drag?.over === dock.id ? " is-drag-over" : ""}`}
            >
              <button
                type="button"
                className="dock-order-handle"
                title={`Drag to move ${dock.label}, or use the arrow keys`}
                aria-label={`Move ${dock.label} dock (position ${index + 1} of ${displayedDocks.length})`}
                onPointerDown={(event) => startDrag(event, dock.id)}
                onKeyDown={(event) => handleOrderKey(event, dock.id, index)}
              >
                <GripVertical aria-hidden="true" />
              </button>
              <SpaceToggle
                className="settings-flat-row settings-flat-toggle-row dock-visibility-row"
                name={`dock-visibility-${dock.id}`}
                ariaLabel={`Toggle ${dock.label} dock visibility`}
                label={
                  <span className="docks-toggle-label-wrap">
                    <dock.icon className="dock-toggle-icon" aria-hidden="true" />
                    <span>{dock.label}</span>
                    {badge}
                  </span>
                }
                detail={detail}
                checked={isChecked}
                disabled={isDisabled}
                title={title}
                onChange={(checked) => {
                  if (isLocked) return;
                  if (checked) {
                    showDock(dock.id);
                  } else {
                    hideDock(dock.id);
                  }
                }}
              />
              {isGitDisabled ? (
                <div className="docks-plugin-notice" role="note">
                  <CircleAlert size={15} aria-hidden="true" />
                  <span>
                    Default hidden: Neither GitHub nor Gitea plugin is active. Cannot be enabled until at least
                    one of these plugins is activated.
                    <button
                      type="button"
                      className="docks-plugin-link"
                      onClick={handleOpenPlugins}
                    >
                      Configure Plugins
                    </button>
                  </span>
                </div>
              ) : null}
            </div>
          );
        })}
      </div>

      <p className="docks-summary-note">
        {visibleCount} of {displayedDocks.length} docks visible.
      </p>
    </section>
  );
}
