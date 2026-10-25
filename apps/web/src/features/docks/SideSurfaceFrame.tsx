import type { ReactNode } from "react";
import { ChevronLeft, ChevronRight, X } from "../ui-theme/app-icons.js";
import { desktopActionDescriptions } from "../ui-theme/desktop-navigation.js";
import type { SideSurface } from "./dock-types.js";
import { DockKeepAliveHost } from "./DockKeepAliveHost.js";
import type { SideSurfaces } from "./useSideSurfaces.js";

interface SideSurfaceFrameProps {
  sideSurfaces: SideSurfaces;
  /** The room toolbar's actions in the user's order; Previous/Next dock follow its dock buttons. */
  launcherActions: readonly { id: string }[];
  renderSurface: (surface: SideSurface) => ReactNode;
  fallback: ReactNode;
}

function DockNavigationControls({ sideSurfaces, launcherActions, onClose }: {
  sideSurfaces: SideSurfaces;
  launcherActions: readonly { id: string }[];
  onClose: () => void;
}) {
  const { navigateDock, activeSideSurfaceCloseLabel } = sideSurfaces;
  return (
    <div className="dock-nav-controls">
      <button type="button" className="icon-button" aria-label="Previous dock" title="Previous dock"
        onClick={() => navigateDock("prev", launcherActions)}><ChevronLeft aria-hidden="true" /></button>
      <button type="button" className="icon-button" aria-label="Next dock" title="Next dock"
        onClick={() => navigateDock("next", launcherActions)}><ChevronRight aria-hidden="true" /></button>
      <button type="button" className="icon-button" aria-label={activeSideSurfaceCloseLabel}
        title={activeSideSurfaceCloseLabel}
        onClick={onClose}><X aria-hidden="true" /></button>
    </div>
  );
}

/** The desktop dock beside the board; it stays mounted (hidden) after the first open. */
export function InlineSideSurface({ sideSurfaces, launcherActions, renderSurface, fallback }: SideSurfaceFrameProps) {
  const { mountInlineSideSurface, showInlineSideSurface, activeSideSurface, activeSideSurfaceLabel, activeSideSurfaceDockTitle } = sideSurfaces;
  if (!mountInlineSideSurface) return null;
  return (
    <aside className="side-surface side-surface-inline" aria-label={activeSideSurfaceLabel} data-surface={activeSideSurface}
      style={showInlineSideSurface ? undefined : { display: "none" }}
      aria-hidden={showInlineSideSurface ? undefined : true}
      inert={showInlineSideSurface ? undefined : true}>
      <div className="desktop-dock-header">
        <span><strong>{activeSideSurfaceDockTitle}</strong><small>{desktopActionDescriptions[`surface-${activeSideSurface}`]}</small></span>
        <DockNavigationControls sideSurfaces={sideSurfaces} launcherActions={launcherActions} onClose={() => sideSurfaces.setIsDesktopSideSurfaceOpen(false)} />
      </div>
      <DockKeepAliveHost
        activeSurface={activeSideSurface}
        isOpen={showInlineSideSurface}
        renderSurface={renderSurface}
        fallback={fallback}
      />
    </aside>
  );
}

/** The modal dock drawer of compact shells. */
export function CompactSideSurfaceDrawer({ sideSurfaces, launcherActions, renderSurface, fallback }: SideSurfaceFrameProps) {
  const { showOverlaySideSurface, activeSideSurface, activeSideSurfaceLabel, activeSideSurfaceDockTitle, activeSideSurfaceCloseLabel, closeCompactSideSurface, compactSideSurfaceRef } = sideSurfaces;
  if (!showOverlaySideSurface) return null;
  return (
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
          <span><strong>{activeSideSurfaceDockTitle}</strong><small>{desktopActionDescriptions[`surface-${activeSideSurface}`]}</small></span>
          <DockNavigationControls sideSurfaces={sideSurfaces} launcherActions={launcherActions} onClose={closeCompactSideSurface} />
        </div>
        <DockKeepAliveHost
          activeSurface={activeSideSurface}
          isOpen={showOverlaySideSurface}
          renderSurface={renderSurface}
          fallback={fallback}
        />
      </aside>
    </>
  );
}
