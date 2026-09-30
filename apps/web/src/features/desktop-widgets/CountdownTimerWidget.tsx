import { useCallback, useEffect, useRef, useState } from "react";
import { Pause, Play, RotateCcw, Timer } from "lucide-react";
import { playChime } from "./audio-chime.js";
import { DesktopWidgetContainer } from "./DesktopWidgetContainer.js";
import type { CountdownTimerWidgetConfig, DesktopWidgetState } from "./types.js";
import { DEFAULT_TIMER_CONFIG, loadWidgetConfig, saveWidgetConfig } from "./widget-storage.js";

const PRESET_DURATIONS = [
  { label: "1m", seconds: 60 },
  { label: "5m", seconds: 5 * 60 },
  { label: "15m", seconds: 15 * 60 },
  { label: "25m", seconds: 25 * 60 },
  { label: "45m", seconds: 45 * 60 }
];

interface CountdownTimerWidgetProps {
  state: DesktopWidgetState;
  isMultiColumn?: boolean;
  isHeaderDockActive?: boolean;
  onPositionChange: (x: number, y: number, dockedToRail?: boolean, dockPosition?: "rail" | "header") => void;
  onToggleMinimize: () => void;
  onClose: () => void;
  onFocus: () => void;
}

export function CountdownTimerWidget({
  state,
  isMultiColumn = false,
  isHeaderDockActive,
  onPositionChange,
  onToggleMinimize,
  onClose,
  onFocus
}: CountdownTimerWidgetProps) {
  const [config, setConfig] = useState<CountdownTimerWidgetConfig>(() =>
    loadWidgetConfig("countdown-timer", DEFAULT_TIMER_CONFIG)
  );

  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const updateConfig = useCallback((patch: Partial<CountdownTimerWidgetConfig>) => {
    setConfig((prev) => {
      const next = { ...prev, ...patch };
      saveWidgetConfig("countdown-timer", next);
      return next;
    });
  }, []);

  useEffect(() => {
    if (!config.isRunning) {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
      return;
    }

    timerRef.current = setInterval(() => {
      setConfig((prev) => {
        if (prev.remainingSeconds <= 1) {
          playChime("timer-done");
          const next = {
            ...prev,
            remainingSeconds: 0,
            isRunning: false,
            isCompleted: true
          };
          saveWidgetConfig("countdown-timer", next);
          return next;
        }

        const next = {
          ...prev,
          remainingSeconds: prev.remainingSeconds - 1,
          isCompleted: false
        };
        saveWidgetConfig("countdown-timer", next);
        return next;
      });
    }, 1000);

    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [config.isRunning]);

  const toggleRunning = () => {
    playChime("click");
    if (config.remainingSeconds === 0) {
      // If completed, restart from full duration
      updateConfig({
        remainingSeconds: config.durationSeconds || 25 * 60,
        isRunning: true,
        isCompleted: false
      });
      return;
    }
    updateConfig({ isRunning: !config.isRunning });
  };

  const resetTimer = () => {
    playChime("click");
    updateConfig({
      remainingSeconds: config.durationSeconds,
      isRunning: false,
      isCompleted: false
    });
  };

  const selectPreset = (seconds: number) => {
    playChime("click");
    updateConfig({
      durationSeconds: seconds,
      remainingSeconds: seconds,
      isRunning: false,
      isCompleted: false
    });
  };

  const adjustMinutes = (delta: number) => {
    playChime("click");
    const newRemaining = Math.max(10, Math.min(3600 * 12, config.remainingSeconds + delta * 60));
    const newDuration = Math.max(newRemaining, config.durationSeconds + (delta > 0 ? delta * 60 : 0));
    updateConfig({
      durationSeconds: newDuration,
      remainingSeconds: newRemaining,
      isCompleted: false
    });
  };

  const formatTime = (secs: number) => {
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    if (m >= 60) {
      const h = Math.floor(m / 60);
      const remM = m % 60;
      return `${String(h).padStart(2, "0")}:${String(remM).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
    }
    return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  };

  const progressFraction =
    config.durationSeconds > 0
      ? Math.max(0, Math.min(1, config.remainingSeconds / config.durationSeconds))
      : 0;

  const minimizedSummary = (
    <span
      className={`widget-timer-mini ${config.isCompleted ? "is-done" : ""}`}
      onClick={(e) => {
        if (config.isCompleted) {
          e.stopPropagation();
          resetTimer();
        }
      }}
      title={config.isCompleted ? "Click to reset timer" : undefined}
    >
      {formatTime(config.remainingSeconds)}
      {config.isRunning ? <span className="widget-pulse-dot" /> : null}
    </span>
  );

  const dockedSummary = (
    <div
      className={`widget-docked-rail-body ${config.isCompleted ? "is-alert" : ""}`}
      onClick={(e) => {
        if (config.isCompleted) {
          e.stopPropagation();
          resetTimer();
        }
      }}
      title={config.isCompleted ? "Click to reset timer" : "Countdown Timer"}
    >
      <span className="widget-docked-title">Timer</span>
      <span className="widget-docked-countdown">{formatTime(config.remainingSeconds)}</span>
      {config.isCompleted ? (
        <span className="widget-docked-alert-action">DONE!</span>
      ) : (
        <span className="widget-docked-reps">{config.isRunning ? "RUNNING" : "PAUSED"}</span>
      )}
    </div>
  );

  return (
    <DesktopWidgetContainer
      id="countdown-timer"
      title="Countdown Timer"
      icon={<Timer className="widget-header-svg" />}
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
      isAlertActive={config.isCompleted}
      onStopAlert={resetTimer}
      onPositionChange={onPositionChange}
      onToggleMinimize={onToggleMinimize}
      onClose={onClose}
      onFocus={onFocus}
      className={`widget-timer-container ${config.isCompleted ? "is-completed" : ""}`}
    >
      <div className="widget-timer-content">
        <div className="widget-timer-display-box">
          <div className="widget-timer-time" aria-live="polite">
            {formatTime(config.remainingSeconds)}
          </div>
          {config.isCompleted ? (
            <div className="widget-timer-completed-badge">Time is up! 🎉</div>
          ) : null}
        </div>

        {/* Visual progress bar */}
        <div className="widget-timer-progress-track" role="progressbar" aria-valuenow={Math.round(progressFraction * 100)} aria-valuemin={0} aria-valuemax={100}>
          <div
            className="widget-timer-progress-fill"
            style={{ width: `${progressFraction * 100}%` }}
          />
        </div>

        {/* Quick presets */}
        <div className="widget-timer-presets" aria-label="Timer presets">
          {PRESET_DURATIONS.map((preset) => (
            <button
              key={preset.label}
              type="button"
              className={`widget-tag-btn ${config.durationSeconds === preset.seconds && !config.isRunning ? "is-active" : ""}`}
              onClick={() => selectPreset(preset.seconds)}
            >
              {preset.label}
            </button>
          ))}
        </div>

        {/* Controls */}
        <div className="widget-timer-action-row">
          <button
            type="button"
            className="widget-icon-btn is-adjust"
            onClick={() => adjustMinutes(-1)}
            title="Subtract 1 minute"
          >
            -1m
          </button>

          <button
            type="button"
            className={`widget-primary-btn ${config.isRunning ? "is-running" : ""}`}
            onClick={toggleRunning}
            aria-label={config.isRunning ? "Pause timer" : "Start timer"}
          >
            {config.isRunning ? (
              <>
                <Pause aria-hidden="true" className="widget-btn-svg" /> Pause
              </>
            ) : (
              <>
                <Play aria-hidden="true" className="widget-btn-svg" /> Start
              </>
            )}
          </button>

          <button
            type="button"
            className="widget-icon-btn"
            onClick={resetTimer}
            title="Reset timer"
            aria-label="Reset timer"
          >
            <RotateCcw aria-hidden="true" className="widget-btn-svg" />
          </button>

          <button
            type="button"
            className="widget-icon-btn is-adjust"
            onClick={() => adjustMinutes(1)}
            title="Add 1 minute"
          >
            +1m
          </button>
        </div>
      </div>
    </DesktopWidgetContainer>
  );
}
