import { useEffect, useState } from "react";
import { Clock3 } from "lucide-react";
import { DesktopWidgetContainer } from "./DesktopWidgetContainer.js";
import type { ClockWidgetConfig, DesktopWidgetState } from "./types.js";
import { DEFAULT_CLOCK_CONFIG, loadWidgetConfig, saveWidgetConfig } from "./widget-storage.js";
import { formatAppDate, DATE_TIME_SETTINGS_UPDATED_EVENT } from "../date-time-settings/date-time-settings.js";

interface ClockWidgetProps {
  state: DesktopWidgetState;
  isMultiColumn?: boolean;
  isHeaderDockActive?: boolean;
  onPositionChange: (x: number, y: number, dockedToRail?: boolean, dockPosition?: "rail" | "header") => void;
  onToggleMinimize: () => void;
  onClose: () => void;
  onFocus: () => void;
}

export function ClockWidget({
  state,
  isMultiColumn = false,
  isHeaderDockActive,
  onPositionChange,
  onToggleMinimize,
  onClose,
  onFocus
}: ClockWidgetProps) {
  const [time, setTime] = useState(() => new Date());
  const [config, setConfig] = useState<ClockWidgetConfig>(() =>
    loadWidgetConfig("clock", DEFAULT_CLOCK_CONFIG)
  );

  useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") {
        setTime(new Date());
      }
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  const updateConfig = (patch: Partial<ClockWidgetConfig>) => {
    setConfig((prev) => {
      const next = { ...prev, ...patch };
      saveWidgetConfig("clock", next);
      return next;
    });
  };

  const hoursRaw = time.getHours();
  const minutesRaw = time.getMinutes();
  const secondsRaw = time.getSeconds();

  let displayHours = hoursRaw;
  let ampm = "";

  if (!config.is24Hour) {
    ampm = hoursRaw >= 12 ? "PM" : "AM";
    displayHours = hoursRaw % 12 || 12;
  }

  const hoursStr = String(displayHours).padStart(2, "0");
  const minutesStr = String(minutesRaw).padStart(2, "0");
  const secondsStr = String(secondsRaw).padStart(2, "0");

  const weekdayStr = time.toLocaleDateString(undefined, { weekday: "short" });
  const dateStr = `${weekdayStr}, ${formatAppDate(time)}`;

  const tzName = Intl.DateTimeFormat().resolvedOptions().timeZone.replace(/_/g, " ");

  const minimizedSummary = (
    <span className="widget-clock-mini-time">
      {hoursStr}:{minutesStr} {ampm}
    </span>
  );

  const dockedSummary = (
    <div className="widget-docked-rail-body">
      <span className="widget-docked-title">Clock</span>
      <span className="widget-docked-countdown">{hoursStr}:{minutesStr}</span>
      {!config.is24Hour ? <span className="widget-docked-reps">{ampm}</span> : null}
    </div>
  );

  return (
    <DesktopWidgetContainer
      id="clock"
      title="Clock"
      icon={<Clock3 className="widget-header-svg" />}
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
      className="widget-clock-container"
    >
      <div className="widget-clock-content">
        <div className="widget-clock-display" aria-label={`Current time ${hoursStr}:${minutesStr}`}>
          <span className="widget-clock-digits">{hoursStr}</span>
          <span className="widget-clock-colon">:</span>
          <span className="widget-clock-digits">{minutesStr}</span>
          {config.showSeconds ? (
            <>
              <span className="widget-clock-colon is-faint">:</span>
              <span className="widget-clock-digits is-seconds">{secondsStr}</span>
            </>
          ) : null}
          {!config.is24Hour ? <span className="widget-clock-ampm">{ampm}</span> : null}
        </div>

        <div className="widget-clock-date-row">
          <span className="widget-clock-date">{dateStr}</span>
          <span className="widget-clock-tz" title={tzName}>
            {tzName.split("/").pop()}
          </span>
        </div>

        <div className="widget-clock-controls">
          <button
            type="button"
            className={`widget-tag-btn ${config.is24Hour ? "is-active" : ""}`}
            onClick={() => updateConfig({ is24Hour: !config.is24Hour })}
            title={config.is24Hour ? "Switch to 12-hour format" : "Switch to 24-hour format"}
          >
            {config.is24Hour ? "24H" : "12H"}
          </button>
          <button
            type="button"
            className={`widget-tag-btn ${config.showSeconds ? "is-active" : ""}`}
            onClick={() => updateConfig({ showSeconds: !config.showSeconds })}
            title={config.showSeconds ? "Hide seconds" : "Show seconds"}
          >
            SEC
          </button>
        </div>
      </div>
    </DesktopWidgetContainer>
  );
}
