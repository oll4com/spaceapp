import { useMemo } from "react";
import { PanelsTopLeft, RotateCcw } from "../ui-theme/app-icons.js";
import { SpaceToggle } from "../ui-controls/SpaceToggle.js";
import { uiText, useUiLanguage } from "../ui-language/ui-language.js";
import {
  NON_CLI_PANE_DEFINITIONS,
  usePanesVisibility,
  type PaneItemConfig
} from "../pane-visibility/use-panes-visibility.js";
import "./flat-settings.css";
import "./docks-settings.css";

export interface PanesSettingsCardProps {
  isHarnessEnabled?: boolean;
}

export function PanesSettingsCard({
  isHarnessEnabled = true
}: PanesSettingsCardProps) {
  const { isPaneVisible, showPane, hidePane, resetPanes } = usePanesVisibility();
  const language = useUiLanguage();
  const t = (text: string, vars?: Record<string, string | number>) => uiText(language, text, vars);

  const displayedPanes = useMemo<PaneItemConfig[]>(() => {
    return NON_CLI_PANE_DEFINITIONS;
  }, []);

  const visibleCount = useMemo(() => {
    return displayedPanes.filter((pane) => {
      if (pane.requiresHarness && !isHarnessEnabled) return false;
      return isPaneVisible(pane.id);
    }).length;
  }, [displayedPanes, isHarnessEnabled, isPaneVisible]);

  return (
    <section
      className="agent-settings-card settings-flat-card docks-settings-card panes-settings-card"
      aria-label={t("Workspace non-CLI panes visibility settings")}
    >
      <div className="agent-settings-section-title settings-flat-heading docks-settings-heading">
        <PanelsTopLeft aria-hidden="true" />
        <span>
          <strong>{t("Workspace panes")}</strong>
          <small>{t("Choose which non-CLI panes appear in your workspace creation menu and toolbar.")}</small>
        </span>
        <div className="settings-flat-heading-actions">
          <button
            type="button"
            className="docks-settings-reset-btn"
            title={t("Reset pane visibility to defaults")}
            aria-label={t("Reset pane visibility to defaults")}
            onClick={resetPanes}
          >
            <RotateCcw aria-hidden="true" />
          </button>
        </div>
      </div>

      <div className="docks-toggle-list" role="group" aria-label={t("Pane toggles")}>
        {displayedPanes.map((pane) => {
          const isHarnessPane = pane.requiresHarness;
          const isHarnessDisabled = Boolean(isHarnessPane && !isHarnessEnabled);

          let isChecked = isPaneVisible(pane.id);
          let isDisabled = false;
          let detail = t(pane.description);
          let title: string | undefined;
          let badge = null;

          if (isHarnessDisabled) {
            isChecked = false;
            isDisabled = true;
            detail = t("Default hidden: DeepSeek Harness is not enabled in settings.");
            title = t("Default hidden because DeepSeek Harness is disabled in settings.");
            badge = <span className="dock-status-badge is-warning">{t("Harness disabled")}</span>;
          }

          return (
            <div key={pane.id} className="dock-item-row-container">
              <SpaceToggle
                className="settings-flat-row settings-flat-toggle-row dock-visibility-row"
                name={`pane-visibility-${pane.id}`}
                ariaLabel={t("Toggle {label} pane visibility", { label: t(pane.label) })}
                label={
                  <span className="docks-toggle-label-wrap">
                    <pane.icon className="dock-toggle-icon" aria-hidden="true" />
                    <span>{t(pane.label)}</span>
                    {badge}
                  </span>
                }
                detail={detail}
                checked={isChecked}
                disabled={isDisabled}
                title={title}
                onChange={(checked) => {
                  if (isDisabled) return;
                  if (checked) {
                    showPane(pane.id);
                  } else {
                    hidePane(pane.id);
                  }
                }}
              />
            </div>
          );
        })}
      </div>

      <p className="docks-summary-note">
        {t("{count} of {total} panes visible.", { count: visibleCount, total: displayedPanes.length })}
      </p>
    </section>
  );
}
