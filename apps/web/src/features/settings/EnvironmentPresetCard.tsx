import { CheckCircle2, RotateCcw, SlidersHorizontal, Sparkles, X } from "../ui-theme/app-icons.js";
import { useEnvironmentPreset } from "./use-environment-preset.js";
import "./environment-preset.css";

export interface EnvironmentPresetCardProps {
  isAdmin?: boolean;
  canManageCliRuntimes?: boolean;
  userId?: string;
}

export function EnvironmentPresetCard({
  isAdmin = false,
  canManageCliRuntimes = false,
  userId
}: EnvironmentPresetCardProps) {
  const {
    preset,
    isActivating,
    activationProgress,
    activationStepLabel,
    activationComplete,
    restoredCustom,
    dismissBanners,
    switchToMax,
    switchToCustom
  } = useEnvironmentPreset({ isAdmin, canManageCliRuntimes, userId });

  return (
    <section
      className="settings-environment-preset-card"
      aria-label="Workspace environment preset"
    >
      <div className="environment-preset-header">
        <div className="environment-preset-icon-badge">
          <SlidersHorizontal className="environment-preset-icon" aria-hidden="true" />
        </div>
        <div className="environment-preset-title-wrap">
          <div className="environment-preset-heading-row">
            <strong>Workspace environment</strong>
            <span className={`environment-preset-mode-tag ${preset === "max" ? "is-max" : "is-custom"}`}>
              {preset === "max" ? "MAX" : "CUSTOM"}
            </span>
          </div>
          <small>
            {preset === "max"
              ? "Max: every dock, pane, widget and AI coding tool is on."
              : "Custom: only the docks, panes, widgets and AI coding tools you picked are on."}
          </small>
        </div>
      </div>

      <div className="environment-preset-controls" role="group" aria-label="Select workspace environment">
        <button
          type="button"
          className={`environment-pill ${preset === "custom" ? "is-active" : ""}`}
          aria-label="Custom environment"
          aria-pressed={preset === "custom"}
          disabled={isActivating}
          onClick={switchToCustom}
        >
          <span className="environment-pill-icon-box" aria-hidden="true">
            <SlidersHorizontal className="environment-pill-icon" />
          </span>
          <span className="environment-pill-content">
            <span className="environment-pill-name">Custom</span>
            <span className="environment-pill-hint">Only your picks</span>
          </span>
          {preset === "custom" && (
            <span className="environment-pill-indicator" aria-hidden="true" />
          )}
        </button>

        <button
          type="button"
          className={`environment-pill ${preset === "max" ? "is-active" : ""}`}
          aria-label="Max environment"
          aria-pressed={preset === "max"}
          disabled={isActivating}
          onClick={switchToMax}
        >
          <span className="environment-pill-icon-box" aria-hidden="true">
            <Sparkles className="environment-pill-icon" />
          </span>
          <span className="environment-pill-content">
            <span className="environment-pill-name">Max</span>
            <span className="environment-pill-hint">Everything on</span>
          </span>
          {preset === "max" && (
            <span className="environment-pill-indicator" aria-hidden="true" />
          )}
        </button>
      </div>

      <div className="environment-preset-note">Switch at any time: going back to Custom restores your picks.</div>

      {isActivating && (
        <div className="environment-progress-container" role="status" aria-live="polite">
          <div className="environment-progress-header">
            <span>{activationStepLabel}</span>
            <span>{activationProgress}%</span>
          </div>
          <div className="environment-progress-bar-rail">
            <div
              className={`environment-progress-bar-fill ${preset === "custom" ? "is-custom" : "is-max"}`}
              style={{ width: `${activationProgress}%` }}
            />
          </div>
        </div>
      )}

      {activationComplete && preset === "max" && !isActivating && (
        <div className="environment-status-banner is-success" role="status">
          <CheckCircle2 aria-hidden="true" />
          <span className="environment-status-banner-text">
            Done: every dock, pane and AI coding tool is now on.
          </span>
          <button
            type="button"
            className="environment-status-banner-dismiss"
            onClick={dismissBanners}
            title="Dismiss notification"
            aria-label="Dismiss notification"
          >
            <X aria-hidden="true" />
          </button>
        </div>
      )}

      {restoredCustom && !isActivating && (
        <div className="environment-status-banner is-custom-restored" role="status">
          <RotateCcw aria-hidden="true" />
          <span className="environment-status-banner-text">
            Switched to Custom environment. Your picks are back.
          </span>
          <button
            type="button"
            className="environment-status-banner-dismiss"
            onClick={dismissBanners}
            title="Dismiss notification"
            aria-label="Dismiss notification"
          >
            <X aria-hidden="true" />
          </button>
        </div>
      )}
    </section>
  );
}
