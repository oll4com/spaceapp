import { CheckCircle2, RotateCcw, SlidersHorizontal, Sparkles, X } from "../ui-theme/app-icons.js";
import { uiText, useUiLanguage } from "../ui-language/ui-language.js";
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
    activationText,
    activationComplete,
    restoredCustom,
    dismissBanners,
    switchToMax,
    switchToCustom
  } = useEnvironmentPreset({ isAdmin, canManageCliRuntimes, userId });
  const language = useUiLanguage();
  const t = (text: string, vars?: Record<string, string | number>) => uiText(language, text, vars);

  return (
    <section
      className="settings-environment-preset-card"
      aria-label={t("Workspace environment preset")}
    >
      <div className="environment-preset-header">
        <div className="environment-preset-icon-badge">
          <SlidersHorizontal className="environment-preset-icon" aria-hidden="true" />
        </div>
        <div className="environment-preset-title-wrap">
          <div className="environment-preset-heading-row">
            <strong>{t("Workspace environment")}</strong>
            <span className={`environment-preset-mode-tag ${preset === "max" ? "is-max" : "is-custom"}`}>
              {preset === "max" ? t("MAX") : t("CUSTOM")}
            </span>
          </div>
          <small>
            {preset === "max"
              ? t("Max: every dock, pane, widget and AI coding tool is on.")
              : t("Custom: only the docks, panes, widgets and AI coding tools you picked are on.")}
          </small>
        </div>
      </div>

      <div className="environment-preset-controls" role="group" aria-label={t("Select workspace environment")}>
        <button
          type="button"
          className={`environment-pill ${preset === "custom" ? "is-active" : ""}`}
          aria-label={t("Custom environment")}
          aria-pressed={preset === "custom"}
          disabled={isActivating}
          onClick={switchToCustom}
        >
          <span className="environment-pill-icon-box" aria-hidden="true">
            <SlidersHorizontal className="environment-pill-icon" />
          </span>
          <span className="environment-pill-content">
            <span className="environment-pill-name">{t("Custom")}</span>
            <span className="environment-pill-hint">{t("Only your picks")}</span>
          </span>
          {preset === "custom" && (
            <span className="environment-pill-indicator" aria-hidden="true" />
          )}
        </button>

        <button
          type="button"
          className={`environment-pill ${preset === "max" ? "is-active" : ""}`}
          aria-label={t("Max environment")}
          aria-pressed={preset === "max"}
          disabled={isActivating}
          onClick={switchToMax}
        >
          <span className="environment-pill-icon-box" aria-hidden="true">
            <Sparkles className="environment-pill-icon" />
          </span>
          <span className="environment-pill-content">
            <span className="environment-pill-name">{t("Max")}</span>
            <span className="environment-pill-hint">{t("Everything on")}</span>
          </span>
          {preset === "max" && (
            <span className="environment-pill-indicator" aria-hidden="true" />
          )}
        </button>
      </div>

      <div className="environment-preset-note">{t("Switch at any time: going back to Custom restores your picks.")}</div>

      {isActivating && (
        <div className="environment-progress-container" role="status" aria-live="polite">
          <div className="environment-progress-header">
            <span>{t(activationText.text, activationText.vars)}</span>
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
            {t("Done: every dock, pane and AI coding tool is now on.")}
          </span>
          <button
            type="button"
            className="environment-status-banner-dismiss"
            onClick={dismissBanners}
            title={t("Dismiss notification")}
            aria-label={t("Dismiss notification")}
          >
            <X aria-hidden="true" />
          </button>
        </div>
      )}

      {restoredCustom && !isActivating && (
        <div className="environment-status-banner is-custom-restored" role="status">
          <RotateCcw aria-hidden="true" />
          <span className="environment-status-banner-text">
            {t("Switched to Custom environment. Your picks are back.")}
          </span>
          <button
            type="button"
            className="environment-status-banner-dismiss"
            onClick={dismissBanners}
            title={t("Dismiss notification")}
            aria-label={t("Dismiss notification")}
          >
            <X aria-hidden="true" />
          </button>
        </div>
      )}
    </section>
  );
}
