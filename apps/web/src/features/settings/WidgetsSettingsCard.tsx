import React, { useMemo } from "react";
import {
  Clock3,
  Dumbbell,
  Gauge,
  Radio,
  Rocket,
  RotateCcw,
  Sparkles,
  Timer
} from "../ui-theme/app-icons.js";
import { SpaceToggle } from "../ui-controls/SpaceToggle.js";
import {
  useDesktopWidgets,
  useWidgetsVisibility,
  type DesktopWidgetId
} from "../desktop-widgets/index.js";
import "./flat-settings.css";
import "./docks-settings.css";

export interface WidgetItemConfig {
  id: DesktopWidgetId;
  label: string;
  description: string;
  icon: React.ComponentType<{ className?: string; "aria-hidden"?: boolean | "true" | "false" }>;
}

export const WIDGET_DEFINITIONS: WidgetItemConfig[] = [
  {
    id: "clock",
    label: "Clock widget",
    description: "Floating desktop clock with 12h/24h format and date.",
    icon: Clock3
  },
  {
    id: "countdown-timer",
    label: "Countdown timer",
    description: "Floating countdown timer with Pomodoro presets.",
    icon: Timer
  },
  {
    id: "pushup-reminder",
    label: "Push-up reminder",
    description: "Floating periodic workout reminder for push-ups.",
    icon: Dumbbell
  },
  {
    id: "spaceapp-promo",
    label: "SpaceApp.dev promo",
    description: "Floating banner promoting SpaceApp.dev (free, open source).",
    icon: Rocket
  },
  {
    id: "ai-quota",
    label: "AI Quota & Usage",
    description: "Which Codex, Antigravity and Claude accounts are ready, when the rest come back, and a chime when quota returns.",
    icon: Gauge
  },
  {
    id: "streaming-metrics",
    label: "Streaming metrics",
    description: "Floating live streaming metrics monitor for active audio/video feeds.",
    icon: Radio
  }
];

export function WidgetsSettingsCard() {
  const { isWidgetVisible, showWidget, hideWidget, resetWidgets } = useWidgetsVisibility();
  const { toggleWidget } = useDesktopWidgets();

  const visibleCount = useMemo(() => {
    return WIDGET_DEFINITIONS.filter((w) => isWidgetVisible(w.id)).length;
  }, [isWidgetVisible]);

  return (
    <section
      className="agent-settings-card settings-flat-card docks-settings-card widgets-settings-card"
      aria-label="Desktop widgets visibility settings"
    >
      <div className="agent-settings-section-title settings-flat-heading docks-settings-heading">
        <Sparkles aria-hidden="true" />
        <span>
          <strong>Desktop widgets</strong>
          <small>
            Choose which desktop widgets appear in your tools menu and workspace ({visibleCount} enabled).
          </small>
        </span>
        <div className="settings-flat-heading-actions">
          <button
            type="button"
            className="docks-settings-reset-btn"
            title="Reset widget visibility to defaults"
            aria-label="Reset widget visibility to defaults"
            onClick={resetWidgets}
          >
            <RotateCcw aria-hidden="true" />
          </button>
        </div>
      </div>

      <div className="docks-toggle-list" role="group" aria-label="Widget toggles">
        {WIDGET_DEFINITIONS.map((widget) => {
          const isVisible = isWidgetVisible(widget.id);

          return (
            <div key={widget.id} className="dock-item-row-container">
              <SpaceToggle
                className="settings-flat-row settings-flat-toggle-row dock-visibility-row"
                name={`widget-visibility-${widget.id}`}
                ariaLabel={`Toggle ${widget.label} visibility`}
                label={
                  <span className="docks-toggle-label-wrap">
                    <widget.icon className="dock-toggle-icon" aria-hidden="true" />
                    <span>{widget.label}</span>
                  </span>
                }
                detail={widget.description}
                checked={isVisible}
                onChange={(checked) => {
                  if (checked) {
                    showWidget(widget.id);
                  } else {
                    hideWidget(widget.id);
                    toggleWidget(widget.id, false);
                  }
                }}
              />
            </div>
          );
        })}
      </div>
    </section>
  );
}
