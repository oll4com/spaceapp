import type { ReactNode } from "react";
import { ChevronLeft, ChevronRight, X } from "../ui-theme/app-icons.js";
import { desktopActionDescriptions } from "../ui-theme/desktop-navigation.js";
import type { SideSurface } from "./dock-types.js";
import { DockKeepAliveHost } from "./DockKeepAliveHost.js";
import { uiText, useUiLanguage } from "../ui-language/ui-language.js";
import type { SideSurfaces } from "./useSideSurfaces.js";

interface SideSurfaceFrameProps {
  sideSurfaces: SideSurfaces;
  /** The room toolbar's actions in the user's order; Previous/Next dock follow its dock buttons. */
  launcherActions: readonly { id: string }[];
  renderSurface: (surface: SideSurface) => ReactNode;
  fallback: ReactNode;
}

/** The dock's title, its line and its controls in the operator's language (ui-language.ts); English keeps the labels as they were. */
function DockHeader({ className, sideSurfaces, launcherActions, onClose }: {
  className: string;
  sideSurfaces: SideSurfaces;
  launcherActions: readonly { id: string }[];
  onClose: () => void;
}) {
  const language = useUiLanguage();
  const { navigateDock, activeSideSurface, activeSideSurfaceDockTitle, activeSideSurfaceCloseLabel } = sideSurfaces;
  const title = uiText(language, activeSideSurfaceDockTitle);
  const closeLabel = language === "en" ? activeSideSurfaceCloseLabel : uiText(language, "Close dock {name}", { name: title });
  return (
    <div className={className}>
      <span><strong>{title}</strong><small>{uiText(language, desktopActionDescriptions[`surface-${activeSideSurface}`] ?? "")}</small></span>
      <div className="dock-nav-controls">
        <button type="button" className="icon-button" aria-label={uiText(language, "Previous dock")} title={uiText(language, "Previous dock")}
          onClick={() => navigateDock("prev", launcherActions)}><ChevronLeft aria-hidden="true" /></button>
        <button type="button" className="icon-button" aria-label={uiText(language, "Next dock")} title={uiText(language, "Next dock")}
          onClick={() => navigateDock("next", launcherActions)}><ChevronRight aria-hidden="true" /></button>
        <button type="button" className="icon-button" aria-label={closeLabel} title={closeLabel}
          onClick={onClose}><X aria-hidden="true" /></button>
      </div>
    </div>
  );
}

/** The docks' loading line, in the operator's language. */
export function DockLoading() {
  return <div className="dock-muted-text" role="status">{uiText(useUiLanguage(), "Loading panel…")}</div>;
}

/** The desktop dock beside the board; it stays mounted (hidden) after the first open. */
export function InlineSideSurface({ sideSurfaces, launcherActions, renderSurface, fallback }: SideSurfaceFrameProps) {
  const { mountInlineSideSurface, showInlineSideSurface, activeSideSurface, activeSideSurfaceLabel } = sideSurfaces;
  if (!mountInlineSideSurface) return null;
  return (
    <aside className="side-surface side-surface-inline" aria-label={activeSideSurfaceLabel} data-surface={activeSideSurface}
      style={showInlineSideSurface ? undefined : { display: "none" }}
      aria-hidden={showInlineSideSurface ? undefined : true}
      inert={showInlineSideSurface ? undefined : true}>
      <DockHeader className="desktop-dock-header" sideSurfaces={sideSurfaces} launcherActions={launcherActions} onClose={() => sideSurfaces.setIsDesktopSideSurfaceOpen(false)} />
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
  const { showOverlaySideSurface, retainCompactSideSurface, activeSideSurface, activeSideSurfaceLabel, activeSideSurfaceCloseLabel, closeCompactSideSurface, compactSideSurfaceRef } = sideSurfaces;
  if (!showOverlaySideSurface && !retainCompactSideSurface) return null;
  return (
    <>
      {showOverlaySideSurface ? <button className="surface-dismiss-layer" type="button" aria-label={activeSideSurfaceCloseLabel} onClick={closeCompactSideSurface} /> : null}
      <aside
        ref={compactSideSurfaceRef}
        className="side-surface side-surface-drawer"
        role="dialog"
        aria-modal={showOverlaySideSurface ? true : undefined}
        aria-hidden={showOverlaySideSurface ? undefined : true}
        inert={showOverlaySideSurface ? undefined : true}
        style={showOverlaySideSurface ? undefined : { display: "none" }}
        aria-label={activeSideSurfaceLabel}
        data-surface={activeSideSurface}
        data-surface-mode="drawer"
      >
        <DockHeader className="surface-header" sideSurfaces={sideSurfaces} launcherActions={launcherActions} onClose={closeCompactSideSurface} />
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
