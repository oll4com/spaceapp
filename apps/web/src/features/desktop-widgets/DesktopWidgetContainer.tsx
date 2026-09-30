import React, { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, ChevronUp, GripVertical, X } from "lucide-react";
import { useRailMenuDodge } from "../rail-popover.js";
import type { DesktopWidgetId } from "./types.js";
import { DOCK_WIDTH, DOCK_MARGIN_RIGHT, getRailTopBoundary } from "./widget-storage.js";

interface DesktopWidgetContainerProps {
  id: DesktopWidgetId;
  title: string;
  icon: React.ReactNode;
  x: number;
  y: number;
  zIndex?: number;
  minimized?: boolean;
  dockedToRail?: boolean;
  dockPosition?: "rail" | "header";
  isMultiColumn?: boolean;
  isHeaderDockActive?: boolean;
  hideTitleOnMinimize?: boolean;
  minimizedSummary?: React.ReactNode;
  dockedSummary?: React.ReactNode;
  isAlertActive?: boolean;
  onStopAlert?: () => void;
  onPositionChange: (x: number, y: number, dockedToRail?: boolean, dockPosition?: "rail" | "header") => void;
  onToggleMinimize: () => void;
  onClose: () => void;
  onFocus?: () => void;
  children: React.ReactNode;
  headerControls?: React.ReactNode;
  className?: string;
}


export function DesktopWidgetContainer({
  id,
  title,
  icon,
  x,
  y,
  zIndex = 120,
  minimized = false,
  dockedToRail = false,
  dockPosition,
  isMultiColumn = false,
  isHeaderDockActive,
  hideTitleOnMinimize = false,
  minimizedSummary,
  dockedSummary,
  isAlertActive = false,
  onStopAlert,
  onPositionChange,
  onToggleMinimize,
  onClose,
  onFocus,
  children,
  headerControls,
  className = ""
}: DesktopWidgetContainerProps) {
  const containerRef = useRef<HTMLElement | null>(null);
  const dragRef = useRef<{
    startX: number;
    startY: number;
    initX: number;
    initY: number;
    initCenterX: number;
    wasHeaderDocked: boolean;
    wasRailDocked: boolean;
  } | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [isDockedVisual, setIsDockedVisual] = useState(false);
  const [dragPosition, setDragPosition] = useState<{ x: number; y: number } | null>(null);
  const dragCleanupRef = useRef<(() => void) | null>(null);
  useEffect(() => () => dragCleanupRef.current?.(), []);

  const [toolbarTarget, setToolbarTarget] = useState<HTMLElement | null>(() =>
    typeof document !== "undefined" ? document.getElementById("toolbar-docked-widgets") : null
  );

  useEffect(() => {
    if (typeof document === "undefined") return;

    const findTarget = () => {
      const el = document.getElementById("toolbar-docked-widgets");
      setToolbarTarget((prev) => (prev === el ? prev : el));
    };

    findTarget();
    const frame = window.requestAnimationFrame(findTarget);

    const observer = new MutationObserver(() => {
      findTarget();
    });

    observer.observe(document.body, { childList: true, subtree: true });

    return () => {
      window.cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [isHeaderDockActive]);

  const headerAvailable = isHeaderDockActive !== undefined
    ? Boolean(isHeaderDockActive && toolbarTarget)
    : Boolean(toolbarTarget && (isMultiColumn || dockPosition === "header"));

  const isHeaderDocked = Boolean(
    headerAvailable &&
      minimized &&
      (dockPosition === "header" || dockedToRail) &&
      (!isDragging || dragRef.current?.wasHeaderDocked)
  );

  const isDocked = Boolean(
    minimized &&
      !isHeaderDocked &&
      (isDragging ? (dragRef.current?.wasRailDocked ? isDockedVisual : false) : dockedToRail)
  );

  const dodgeShiftX = useRailMenuDodge(containerRef, { x, y, isDragging });

  useEffect(() => {
    if (dockedToRail || isHeaderDocked || isDragging || typeof window === "undefined") return;

    const clampFloating = () => {
      const el = containerRef.current;
      const width = el?.offsetWidth || 280;
      const height = el?.offsetHeight || 160;
      const viewportW = window.innerWidth;
      const viewportH = window.innerHeight;

      const maxX = Math.max(12, viewportW - width - 12);
      const maxY = Math.max(48, viewportH - height - 12);

      const targetX = Math.min(Math.max(12, x), maxX);
      const targetY = Math.min(Math.max(48, y), maxY);

      if (targetX !== x || targetY !== y) {
        onPositionChange(targetX, targetY, false);
      }
    };

    clampFloating();

    window.addEventListener("resize", clampFloating);
    return () => {
      window.removeEventListener("resize", clampFloating);
    };
  }, [x, y, isDragging, onPositionChange, dockedToRail, isHeaderDocked]);

  const onDragHandlePointerDown = useCallback(
    (event: React.PointerEvent) => {
      // Ignore right clicks or clicks originating from inner buttons (unless stopping alert)
      if (event.pointerType === "mouse" && event.button !== 0) return;
      if (!isAlertActive && (event.target as HTMLElement).closest("button, input, select")) return;

      event.preventDefault();
      event.stopPropagation();
      dragCleanupRef.current?.();
      onFocus?.();

      const targetEl = containerRef.current;
      const pointerId = event.pointerId;
      try {
        targetEl?.setPointerCapture?.(pointerId);
      } catch {
        // Pointer capture fallback
      }

      const viewportW = typeof window !== "undefined" ? window.innerWidth : 1200;
      const viewportH = typeof window !== "undefined" ? window.innerHeight : 800;
      const snapDockX = Math.max(12, viewportW - DOCK_WIDTH - DOCK_MARGIN_RIGHT);

      const currentlyHeaderDocked = Boolean(
        headerAvailable &&
          minimized &&
          (dockPosition === "header" || dockedToRail)
      );
      const currentlyRailDocked = Boolean(dockedToRail && minimized && !currentlyHeaderDocked);

      let currentVisualX: number;
      let currentVisualY: number;

      if (currentlyHeaderDocked) {
        const rect = containerRef.current?.getBoundingClientRect();
        currentVisualX = rect ? rect.left : x;
        currentVisualY = rect ? rect.top : 8;
      } else if (currentlyRailDocked) {
        currentVisualX = snapDockX;
        currentVisualY = y;
      } else {
        currentVisualX = x - dodgeShiftX;
        currentVisualY = y;
      }

      setIsDragging(true);
      let dragZone: "header" | "rail" | "float" = currentlyHeaderDocked
        ? "header"
        : (currentlyRailDocked ? "rail" : "float");
      setIsDockedVisual(dragZone !== "float");

      let latest = { x: currentVisualX, y: currentVisualY };
      let frame: number | null = null;
      let hasMoved = false;
      setDragPosition(latest);

      const initialRect = containerRef.current?.getBoundingClientRect();
      const initialCenterX = initialRect && (initialRect.left > 0 || initialRect.width > 0)
        ? (initialRect.left + initialRect.width / 2)
        : currentVisualX + 40;

      dragRef.current = {
        startX: event.clientX,
        startY: event.clientY,
        initX: currentVisualX,
        initY: currentVisualY,
        initCenterX: initialCenterX,
        wasHeaderDocked: currentlyHeaderDocked,
        wasRailDocked: currentlyRailDocked
      };

      const handlePointerMove = (e: PointerEvent) => {
        if (!dragRef.current) return;
        const deltaX = e.clientX - dragRef.current.startX;
        const deltaY = e.clientY - dragRef.current.startY;

        if (Math.hypot(deltaX, deltaY) > 5) {
          hasMoved = true;
        }

        const minTop = getRailTopBoundary();

        let currentZone: "header" | "rail" | "float" = "float";

        if (minimized) {
          if (headerAvailable && e.clientY <= 65 && e.clientX >= 10 && e.clientX <= viewportW - 10) {
            currentZone = "header";
          } else if (e.clientX >= viewportW - 85 && e.clientY >= minTop - 20) {
            currentZone = "rail";
          } else {
            currentZone = "float";
          }
        } else {
          currentZone = "float";
        }

        let nextX: number;
        let nextY: number;

        if (dragRef.current.wasHeaderDocked) {
          nextX = dragRef.current.initX + deltaX;
          nextY = dragRef.current.initY + deltaY;
        } else if (currentZone === "rail") {
          nextX = snapDockX;
          nextY = Math.min(Math.max(minTop, dragRef.current.initY + deltaY), viewportH - 70);
        } else if (currentZone === "header") {
          nextX = Math.min(Math.max(12, e.clientX - 40), viewportW - 100);
          nextY = Math.min(Math.max(8, e.clientY - 15), 50);
        } else {
          nextX = Math.min(Math.max(12, dragRef.current.initX + deltaX), viewportW - 140);
          nextY = Math.min(Math.max(48, dragRef.current.initY + deltaY), viewportH - 60);
        }

        latest = { x: nextX, y: nextY };
        dragZone = currentZone;

        if (frame === null) {
          frame = window.requestAnimationFrame(() => {
            frame = null;
            setIsDockedVisual(currentZone !== "float");
            setDragPosition(latest);
          });
        }
      };

      const cleanup = () => {
        if (frame !== null) window.cancelAnimationFrame(frame);
        dragRef.current = null;
        try {
          if (targetEl && pointerId !== undefined) {
            targetEl.releasePointerCapture?.(pointerId);
          }
        } catch {
          // Ignore
        }
        window.removeEventListener("pointermove", handlePointerMove);
        window.removeEventListener("pointerup", handlePointerUp);
        window.removeEventListener("pointercancel", handlePointerUp);
        dragCleanupRef.current = null;
      };

      const handlePointerUp = () => {
        cleanup();
        setIsDragging(false);
        setDragPosition(null);

        if (!hasMoved) {
          // Click without dragging
          if (isAlertActive && onStopAlert) {
            onStopAlert();
          }
          return;
        }

        const finalDocked = Boolean(minimized && dragZone !== "float");
        const finalDockPos: "rail" | "header" | undefined = finalDocked
          ? (dragZone === "header" ? "header" : "rail")
          : undefined;

        let finalX = latest.x;
        let finalY = latest.y;

        const minTop = getRailTopBoundary();

        if (finalDocked) {
          if (finalDockPos === "header") {
            const toolbarEl = toolbarTarget ?? (typeof document !== "undefined" ? document.getElementById("toolbar-docked-widgets") : null);
            const widgetElements = toolbarEl
              ? Array.from(toolbarEl.querySelectorAll<HTMLElement>("[data-docked-header='true']"))
              : [];

            if (widgetElements.length > 0) {
              const deltaX = dragRef.current ? latest.x - dragRef.current.initX : 0;
              const myCenterX = dragRef.current?.wasHeaderDocked
                ? dragRef.current.initCenterX + deltaX
                : latest.x + 40;

              const siblings = widgetElements
                .map((el) => {
                  const widgetId = el.getAttribute("data-widget-id") as DesktopWidgetId | null;
                  const rect = el.getBoundingClientRect();
                  const storedX = Number(el.getAttribute("data-widget-x")) || 0;
                  return {
                    id: widgetId,
                    x: storedX,
                    centerX: rect.left + rect.width / 2
                  };
                })
                .filter((s): s is { id: DesktopWidgetId; x: number; centerX: number } => Boolean(s.id && s.id !== id));

              siblings.sort((a, b) => a.centerX - b.centerX);

              if (siblings.length === 0) {
                finalX = 100;
              } else {
                let targetIndex = 0;
                for (const sibling of siblings) {
                  if (myCenterX > sibling.centerX) {
                    targetIndex++;
                  }
                }

                if (targetIndex === 0) {
                  finalX = Math.max(10, siblings[0]!.x - 50);
                } else if (targetIndex >= siblings.length) {
                  finalX = siblings[siblings.length - 1]!.x + 50;
                } else {
                  const prevX = siblings[targetIndex - 1]!.x;
                  const nextX = siblings[targetIndex]!.x;
                  finalX = prevX < nextX ? (prevX + nextX) / 2 : prevX + 1;
                }
              }
              finalY = 8;
            } else {
              finalX = 100;
              finalY = 8;
            }
          } else {
            finalX = snapDockX;
            finalY = Math.min(Math.max(minTop, latest.y), viewportH - 70);
          }
        } else {
          finalX = Math.min(Math.max(12, latest.x), viewportW - 140);
          finalY = Math.min(Math.max(48, latest.y), viewportH - 60);
        }

        if (
          finalX !== x ||
          finalY !== y ||
          finalDocked !== Boolean(dockedToRail) ||
          finalDockPos !== dockPosition
        ) {
          onPositionChange(finalX, finalY, finalDocked, finalDockPos);
        }
      };

      dragCleanupRef.current = cleanup;
      window.addEventListener("pointermove", handlePointerMove);
      window.addEventListener("pointerup", handlePointerUp);
      window.addEventListener("pointercancel", handlePointerUp);
    },
    [x, y, dodgeShiftX, dockedToRail, minimized, onPositionChange, onFocus, isAlertActive, onStopAlert, dockPosition, isMultiColumn, isHeaderDockActive, headerAvailable, toolbarTarget]
  );

  const handleDoubleClick = useCallback(() => {
    if (isDocked || isHeaderDocked) {
      const viewportW = typeof window !== "undefined" ? window.innerWidth : 1200;
      onPositionChange(Math.max(12, viewportW - 260), y, false);
    }
  }, [isDocked, isHeaderDocked, onPositionChange, y]);

  if (isHeaderDocked && toolbarTarget) {
    const headerDragOffsetX =
      isDragging && dragPosition && dragRef.current
        ? dragPosition.x - dragRef.current.initX
        : 0;
    const headerDragOffsetY =
      isDragging && dragPosition && dragRef.current
        ? dragPosition.y - dragRef.current.initY
        : 0;

    return createPortal(
      <aside
        ref={containerRef}
        className={`desktop-float-widget is-minimized is-header-docked ${isAlertActive ? "is-alert" : ""} ${isDragging ? "is-dragging" : ""} ${className}`}
        data-widget-id={id}
        data-docked-header="true"
        data-widget-x={x}
        style={{
          zIndex: isDragging ? 9999 : zIndex,
          transform: isDragging ? `translate3d(${headerDragOffsetX}px, ${headerDragOffsetY}px, 0)` : undefined,
          transition: isDragging ? "none" : undefined
        }}
        onPointerDown={onDragHandlePointerDown}
        onDoubleClick={handleDoubleClick}
        onClick={() => {
          if (isAlertActive && onStopAlert) {
            onStopAlert();
          }
        }}
        role="region"
        aria-label={`${title} widget`}
        title="Drag left/right to reorder, drag down to undock, or double-click to float"
      >
        <div
          className="desktop-widget-docked-card"
          onPointerDown={onDragHandlePointerDown}
        >
          {dockedSummary ?? (
            <div className="desktop-widget-docked-default">
              <span className="desktop-widget-docked-title">{title}</span>
              {minimizedSummary}
            </div>
          )}
        </div>
      </aside>,
      toolbarTarget
    );
  }

  const viewportW = typeof window !== "undefined" ? window.innerWidth : 1200;
  const viewportH = typeof window !== "undefined" ? window.innerHeight : 800;
  const dockX = Math.max(12, viewportW - DOCK_WIDTH - DOCK_MARGIN_RIGHT);

  const visualX = dragPosition?.x ?? (isDocked ? dockX : Math.max(12, Math.min(x - dodgeShiftX, viewportW - 80)));
  const visualY = dragPosition?.y ?? Math.max(isDocked ? getRailTopBoundary() : 48, Math.min(y, viewportH - 40));

  return (
    <aside
      ref={containerRef}
      className={`desktop-float-widget ${minimized ? "is-minimized" : ""} ${isDocked ? "is-rail-docked" : ""} ${isDragging && isDockedVisual ? "is-header-preview" : ""} ${className}`}
      data-widget-id={id}
      data-docked-rail={isDocked ? "true" : undefined}
      style={{
        transform: `translate3d(${visualX}px, ${visualY}px, 0)`,
        transition: isDragging ? "none" : "transform 0.22s cubic-bezier(0.2, 0, 0, 1)",
        zIndex: isDragging ? 9999 : zIndex
      }}
      onPointerDown={onFocus}
      onDoubleClick={handleDoubleClick}
      onClick={() => {
        if (isAlertActive && onStopAlert) {
          onStopAlert();
        }
      }}
      role="region"
      aria-label={`${title} widget`}
    >
      {isDocked ? (
        <div
          className="desktop-widget-docked-card"
          onPointerDown={onDragHandlePointerDown}
          title="Drag up/down on rail, drag up to header toolbar, or pull left to desktop"
        >
          {dockedSummary ?? (
            <div className="desktop-widget-docked-default">
              <span className="desktop-widget-docked-title">{title}</span>
              {minimizedSummary}
            </div>
          )}
        </div>
      ) : (
        <div
          className="desktop-widget-header"
          onPointerDown={onDragHandlePointerDown}
          title="Drag to move widget"
        >
          <span className="desktop-widget-drag-handle" aria-hidden="true">
            <GripVertical className="desktop-widget-grip-icon" />
          </span>

          <span className="desktop-widget-icon" aria-hidden="true">
            {icon}
          </span>

          {(!minimized || !hideTitleOnMinimize) && (
            <h3 className="desktop-widget-title">{title}</h3>
          )}

          {minimized && minimizedSummary ? (
            <div className="desktop-widget-minimized-summary">{minimizedSummary}</div>
          ) : null}

          <div className="desktop-widget-header-actions" onPointerDown={(e) => e.stopPropagation()}>
            {headerControls}

            <button
              type="button"
              className="desktop-widget-btn-action"
              onClick={onToggleMinimize}
              aria-label={minimized ? `Expand ${title}` : `Minimize ${title}`}
              title={minimized ? "Expand" : "Minimize"}
            >
              {minimized ? <ChevronDown aria-hidden="true" /> : <ChevronUp aria-hidden="true" />}
            </button>

            <button
              type="button"
              className="desktop-widget-btn-action is-close"
              onClick={onClose}
              aria-label={`Close ${title}`}
              title="Close widget"
            >
              <X aria-hidden="true" />
            </button>
          </div>
        </div>
      )}

      {!minimized && !isDocked ? <div className="desktop-widget-body">{children}</div> : null}
    </aside>
  );
}
