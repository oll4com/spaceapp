import { useState } from "react";
import { ExternalLink, Globe, Rocket, Sparkles } from "lucide-react";
import { DesktopWidgetContainer } from "./DesktopWidgetContainer.js";
import type { DesktopWidgetState, SpaceAppPromoWidgetConfig } from "./types.js";
import { DEFAULT_PROMO_CONFIG, loadWidgetConfig } from "./widget-storage.js";

interface SpaceAppPromoWidgetProps {
  state: DesktopWidgetState;
  isMultiColumn?: boolean;
  isHeaderDockActive?: boolean;
  onPositionChange: (x: number, y: number, dockedToRail?: boolean, dockPosition?: "rail" | "header") => void;
  onToggleMinimize: () => void;
  onClose: () => void;
  onFocus: () => void;
}

export function SpaceAppPromoWidget({
  state,
  isMultiColumn = false,
  isHeaderDockActive,
  onPositionChange,
  onToggleMinimize,
  onClose,
  onFocus
}: SpaceAppPromoWidgetProps) {
  const [config] = useState<SpaceAppPromoWidgetConfig>(() =>
    loadWidgetConfig("spaceapp-promo", DEFAULT_PROMO_CONFIG)
  );

  const minimizedSummary = (
    <span className="widget-promo-mini">
      SpaceApp.dev <Rocket aria-hidden="true" className="widget-promo-mini-icon" />
    </span>
  );

  const dockedSummary = (
    <div className="widget-docked-rail-body">
      <span className="widget-docked-title">Space</span>
      <span className="widget-docked-countdown">FREE</span>
    </div>
  );

  return (
    <DesktopWidgetContainer
      id="spaceapp-promo"
      title="SpaceApp.dev"
      icon={<Rocket className="widget-header-svg" />}
      x={state.x}
      y={state.y}
      zIndex={state.zIndex}
      minimized={state.minimized}
      dockedToRail={state.dockedToRail}
      dockPosition={state.dockPosition}
      isMultiColumn={isMultiColumn}
      isHeaderDockActive={isHeaderDockActive}
      minimizedSummary={minimizedSummary}
      dockedSummary={dockedSummary}
      onPositionChange={onPositionChange}
      onToggleMinimize={onToggleMinimize}
      onClose={onClose}
      onFocus={onFocus}
      className="widget-promo-container"
    >
      <div className="widget-promo-content">
        {/* Glow accent badge */}
        <div className="widget-promo-badge-row">
          <span className="widget-promo-badge">
            <Sparkles aria-hidden="true" className="widget-promo-badge-svg" />
            FREE &amp; OPEN SOURCE
          </span>
        </div>

        {/* Hero headline matching user image */}
        <div className="widget-promo-headline-box">
          <h2 className="widget-promo-headline">{config.headline}</h2>
          <div className="widget-promo-subheadline">{config.subheadline}</div>
          <div className="widget-promo-platform">{config.platformText}</div>
        </div>

        {/* Platform compatibility tags */}
        <div className="widget-promo-tags">
          <span className="widget-promo-tag">Linux</span>
          <span className="widget-promo-tag">macOS</span>
          <span className="widget-promo-tag">Windows</span>
          <span className="widget-promo-tag">Web</span>
        </div>

        {/* Action buttons: Visit link */}
        <div className="widget-promo-actions">
          <a
            href={config.url}
            target="_blank"
            rel="noopener noreferrer"
            className="widget-primary-btn widget-promo-visit-btn"
            title="Open spaceapp.dev in new tab"
          >
            <Globe aria-hidden="true" className="widget-btn-svg" />
            <span>spaceapp.dev</span>
            <ExternalLink aria-hidden="true" className="widget-promo-ext-svg" />
          </a>
        </div>
      </div>
    </DesktopWidgetContainer>
  );
}
