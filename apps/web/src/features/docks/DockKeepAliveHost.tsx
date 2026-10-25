import { memo, useEffect, useState, type ReactNode } from "react";
import type { SideSurface } from "./dock-types.js";
import { RecoverableSurface } from "../SurfaceErrorBoundary.js";
import { DockActiveContext } from "./dock-active-context.js";

export interface DockKeepAliveHostProps {
  activeSurface: SideSurface;
  isOpen: boolean;
  renderSurface: (surface: SideSurface) => ReactNode;
  fallback: ReactNode;
  className?: string;
  prewarmSurfaces?: SideSurface[];
}

export function DockKeepAliveHost({
  activeSurface,
  isOpen,
  renderSurface,
  fallback,
  className = "dock-keep-alive-host",
  prewarmSurfaces
}: DockKeepAliveHostProps) {
  const [visitedSurfaces, setVisitedSurfaces] = useState<Set<SideSurface>>(() => {
    const initial = new Set<SideSurface>([activeSurface]);
    if (prewarmSurfaces) {
      for (const s of prewarmSurfaces) {
        initial.add(s);
      }
    }
    return initial;
  });

  useEffect(() => {
    if (isOpen && activeSurface) {
      setVisitedSurfaces((current) => {
        if (current.has(activeSurface)) return current;
        const next = new Set(current);
        next.add(activeSurface);
        return next;
      });
    }
  }, [activeSurface, isOpen]);

  useEffect(() => {
    if (prewarmSurfaces && prewarmSurfaces.length > 0) {
      setVisitedSurfaces((current) => {
        let changed = false;
        const next = new Set(current);
        for (const s of prewarmSurfaces) {
          if (!next.has(s)) {
            next.add(s);
            changed = true;
          }
        }
        return changed ? next : current;
      });
    }
  }, [prewarmSurfaces]);

  return (
    <div
      className={className}
      style={{
        display: "flex",
        flexDirection: "column",
        flex: "1 1 auto",
        minHeight: 0,
        height: "100%",
        width: "100%",
        overflow: "hidden"
      }}
    >
      {Array.from(visitedSurfaces).map((surface) => {
        const isActive = isOpen && surface === activeSurface;
        return (
          <div
            key={surface}
            className={`dock-cache-slot${isActive ? " is-active" : " is-hidden"}`}
            data-dock-id={surface}
            aria-hidden={!isActive}
            style={{
              display: isActive ? "flex" : "none",
              flexDirection: "column",
              flex: "1 1 auto",
              minHeight: 0,
              height: "100%",
              width: "100%",
              overflow: "hidden"
            }}
          >
            <DockCacheSlotContent
              surface={surface}
              isActive={isActive}
              renderSurface={renderSurface}
              fallback={fallback}
            />
          </div>
        );
      })}
    </div>
  );
}

interface DockCacheSlotContentProps {
  surface: SideSurface;
  isActive: boolean;
  renderSurface: (surface: SideSurface) => ReactNode;
  fallback: ReactNode;
}

// A cached dock that stays hidden skips re-rendering on every App render; it
// renders once when it is deactivated and again with fresh props when shown.
const DockCacheSlotContent = memo(function DockCacheSlotContent({
  surface,
  isActive,
  renderSurface,
  fallback
}: DockCacheSlotContentProps) {
  return (
    <DockActiveContext.Provider value={isActive}>
      <RecoverableSurface resetKey={surface} fallback={fallback}>
        {renderSurface(surface)}
      </RecoverableSurface>
    </DockActiveContext.Provider>
  );
}, (previous, next) => !previous.isActive && !next.isActive && previous.surface === next.surface);
