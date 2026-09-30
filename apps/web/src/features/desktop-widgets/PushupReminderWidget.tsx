import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Dumbbell, Flame, Pause, Play, RotateCcw } from "lucide-react";
import { playChime } from "./audio-chime.js";
import { DesktopWidgetContainer } from "./DesktopWidgetContainer.js";
import type { DesktopWidgetState, PushupReminderWidgetConfig } from "./types.js";
import { DEFAULT_PUSHUP_CONFIG, loadWidgetConfig, saveWidgetConfig } from "./widget-storage.js";

const INTERVAL_OPTIONS = [15, 20, 30, 45, 60];

interface PushupReminderWidgetProps {
  state: DesktopWidgetState;
  isMultiColumn?: boolean;
  isHeaderDockActive?: boolean;
  onPositionChange: (x: number, y: number, dockedToRail?: boolean, dockPosition?: "rail" | "header") => void;
  onToggleMinimize: () => void;
  onClose: () => void;
  onFocus: () => void;
}

export function PushupReminderWidget({
  state,
  isMultiColumn = false,
  isHeaderDockActive,
  onPositionChange,
  onToggleMinimize,
  onClose,
  onFocus
}: PushupReminderWidgetProps) {
  const [config, setConfig] = useState<PushupReminderWidgetConfig>(() => {
    const loaded = loadWidgetConfig("pushup-reminder", DEFAULT_PUSHUP_CONFIG);
    const today = new Date().toISOString().slice(0, 10);
    // Auto reset daily tally if day rolled over
    if (loaded.lastActiveDate !== today) {
      return {
        ...loaded,
        totalRepsToday: 0,
        setsCompletedToday: 0,
        lastActiveDate: today
      };
    }
    return loaded;
  });

  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const alertAudioTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopAlertSound = useCallback(() => {
    if (alertAudioTimerRef.current) {
      clearInterval(alertAudioTimerRef.current);
      alertAudioTimerRef.current = null;
    }
  }, []);

  const startAlertSound = useCallback(() => {
    stopAlertSound();
    playChime("pushup-alert");
    let ringsCount = 1;
    const maxRings = 5;
    alertAudioTimerRef.current = setInterval(() => {
      ringsCount += 1;
      if (ringsCount >= maxRings) {
        stopAlertSound();
      }
      playChime("pushup-alert");
    }, 1000);
  }, [stopAlertSound]);

  // Handle alert sound lifecycle: chime for 5 seconds on alert trigger, stop when dismissed
  const prevAlertActiveRef = useRef(config.isAlertActive);
  useEffect(() => {
    if (!prevAlertActiveRef.current && config.isAlertActive) {
      startAlertSound();
    } else if (!config.isAlertActive) {
      stopAlertSound();
    }
    prevAlertActiveRef.current = config.isAlertActive;
  }, [config.isAlertActive, startAlertSound, stopAlertSound]);

  useEffect(() => {
    return () => {
      stopAlertSound();
    };
  }, [stopAlertSound]);

  const updateConfig = useCallback((patch: Partial<PushupReminderWidgetConfig>) => {
    setConfig((prev) => {
      const next = { ...prev, ...patch };
      saveWidgetConfig("pushup-reminder", next);
      return next;
    });
  }, []);

  // Interval countdown loop
  useEffect(() => {
    if (!config.isRunning || config.isAlertActive) {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
      return;
    }

    timerRef.current = setInterval(() => {
      setConfig((prev) => {
        if (prev.remainingSeconds <= 1) {
          const next = {
            ...prev,
            remainingSeconds: 0,
            isAlertActive: true
          };
          saveWidgetConfig("pushup-reminder", next);
          return next;
        }

        const next = {
          ...prev,
          remainingSeconds: prev.remainingSeconds - 1
        };
        saveWidgetConfig("pushup-reminder", next);
        return next;
      });
    }, 1000);

    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [config.isRunning, config.isAlertActive]);

  const handleLogDone = (customReps?: number) => {
    stopAlertSound();
    const repsToAdd = customReps ?? config.targetReps;
    playChime("log-done");
    updateConfig({
      totalRepsToday: config.totalRepsToday + repsToAdd,
      setsCompletedToday: config.setsCompletedToday + 1,
      remainingSeconds: config.intervalMinutes * 60,
      isAlertActive: false,
      isRunning: true
    });
  };

  const handleSnooze = (minutes = 5) => {
    stopAlertSound();
    playChime("click");
    updateConfig({
      remainingSeconds: minutes * 60,
      isAlertActive: false,
      isRunning: true
    });
  };

  const handleIntervalChange = (newIntervalMinutes: number) => {
    stopAlertSound();
    playChime("click");
    updateConfig({
      intervalMinutes: newIntervalMinutes,
      remainingSeconds: newIntervalMinutes * 60,
      isAlertActive: false
    });
  };

  const handleTargetRepsChange = (delta: number) => {
    playChime("click");
    const nextTarget = Math.max(5, Math.min(100, config.targetReps + delta));
    updateConfig({ targetReps: nextTarget });
  };

  const handleToggleRunning = () => {
    stopAlertSound();
    playChime("click");
    updateConfig({ isRunning: !config.isRunning });
  };

  const handleResetToday = () => {
    stopAlertSound();
    playChime("click");
    updateConfig({
      totalRepsToday: 0,
      setsCompletedToday: 0,
      remainingSeconds: config.intervalMinutes * 60,
      isAlertActive: false
    });
  };

  const formatCountdown = (secs: number) => {
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  };

  const progressFraction = Math.max(
    0,
    Math.min(1, config.remainingSeconds / (config.intervalMinutes * 60 || 1))
  );

  const displayTitle = state.minimized ? "Push-up" : "Push-up Reminder";

  const minimizedSummary = (
    <span
      className={`widget-pushup-mini ${config.isAlertActive ? "is-alert" : ""}`}
      onClick={(e) => {
        if (config.isAlertActive) {
          e.stopPropagation();
          handleLogDone();
        }
      }}
      title={config.isAlertActive ? "Click to stop alert and log set" : undefined}
    >
      {config.isAlertActive ? "Push-ups!" : formatCountdown(config.remainingSeconds)}
    </span>
  );

  const dockedSummary = (
    <div
      className={`widget-docked-rail-body ${config.isAlertActive ? "is-alert" : ""}`}
      onClick={(e) => {
        if (config.isAlertActive) {
          e.stopPropagation();
          handleLogDone();
        }
      }}
      title={config.isAlertActive ? "Click to stop notification and log set" : "Push-up workout reminder"}
    >
      <span className="widget-docked-title">Push-up</span>
      {config.isAlertActive ? (
        <>
          <span className="widget-docked-alert-tag">ALERT!</span>
          <span className="widget-docked-alert-action">✓ Stop</span>
        </>
      ) : (
        <span className="widget-docked-countdown">{formatCountdown(config.remainingSeconds)}</span>
      )}
    </div>
  );

  return (
    <DesktopWidgetContainer
      id="pushup-reminder"
      title={displayTitle}
      icon={<Dumbbell className="widget-header-svg" />}
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
      isAlertActive={config.isAlertActive}
      onStopAlert={() => handleLogDone()}
      onPositionChange={onPositionChange}
      onToggleMinimize={onToggleMinimize}
      onClose={onClose}
      onFocus={onFocus}
      className={`widget-pushup-container ${config.isAlertActive ? "is-alert" : ""}`}
    >
      <div className="widget-pushup-content">
        {/* Urgent reminder alert banner when time is up */}
        {config.isAlertActive ? (
          <div className="widget-pushup-banner" role="alert">
            <div className="widget-pushup-banner-header">
              <Flame className="widget-banner-icon" />
              <strong>Time for {config.targetReps} Push-ups!</strong>
            </div>
            <p className="widget-pushup-banner-sub">Drop down and power through your set!</p>

            <div className="widget-pushup-banner-actions">
              <button
                type="button"
                className="widget-primary-btn is-alert-action"
                onClick={() => handleLogDone()}
              >
                <Check className="widget-btn-svg" /> Completed (+{config.targetReps})
              </button>
              <button
                type="button"
                className="widget-secondary-btn"
                onClick={() => handleSnooze(5)}
              >
                Snooze 5m
              </button>
            </div>
          </div>
        ) : null}

        {/* Next set countdown & stats overview */}
        <div className="widget-pushup-status-card">
          <div className="widget-pushup-timer-col">
            <span className="widget-pushup-label">Next set in</span>
            <span className="widget-pushup-time">{formatCountdown(config.remainingSeconds)}</span>
          </div>

          <div className="widget-pushup-stats-col">
            <span className="widget-pushup-label">Today</span>
            <div className="widget-pushup-total-score">
              <strong>{config.totalRepsToday}</strong>
              <small>reps ({config.setsCompletedToday} sets)</small>
            </div>
          </div>
        </div>

        {/* Interval Progress Bar */}
        <div className="widget-timer-progress-track">
          <div
            className="widget-timer-progress-fill is-pushup-fill"
            style={{ width: `${progressFraction * 100}%` }}
          />
        </div>

        {/* Interval options row */}
        <div className="widget-pushup-config-row">
          <span className="widget-config-label">Interval:</span>
          <div className="widget-pushup-interval-pills">
            {INTERVAL_OPTIONS.map((min) => (
              <button
                key={min}
                type="button"
                className={`widget-tag-btn ${config.intervalMinutes === min ? "is-active" : ""}`}
                onClick={() => handleIntervalChange(min)}
              >
                {min}m
              </button>
            ))}
          </div>
        </div>

        {/* Target reps row */}
        <div className="widget-pushup-config-row">
          <span className="widget-config-label">Target per set:</span>
          <div className="widget-pushup-reps-adjuster">
            <button
              type="button"
              className="widget-mini-step-btn"
              onClick={() => handleTargetRepsChange(-5)}
              title="Minus 5 push-ups"
            >
              -5
            </button>
            <span className="widget-reps-val">{config.targetReps} reps</span>
            <button
              type="button"
              className="widget-mini-step-btn"
              onClick={() => handleTargetRepsChange(5)}
              title="Add 5 push-ups"
            >
              +5
            </button>
          </div>
        </div>

        {/* Bottom action controls */}
        <div className="widget-pushup-actions-row">
          <button
            type="button"
            className="widget-primary-btn"
            onClick={() => handleLogDone()}
            title="Log set done now and reset interval timer"
          >
            <Check aria-hidden="true" className="widget-btn-svg" /> Log Set (+{config.targetReps})
          </button>

          <button
            type="button"
            className={`widget-icon-btn ${config.isRunning ? "is-active" : ""}`}
            onClick={handleToggleRunning}
            title={config.isRunning ? "Pause interval timer" : "Resume interval timer"}
            aria-label={config.isRunning ? "Pause interval timer" : "Resume interval timer"}
          >
            {config.isRunning ? (
              <Pause aria-hidden="true" className="widget-btn-svg" />
            ) : (
              <Play aria-hidden="true" className="widget-btn-svg" />
            )}
          </button>

          <button
            type="button"
            className="widget-icon-btn"
            onClick={handleResetToday}
            title="Reset today's push-up counts"
            aria-label="Reset daily push-up count"
          >
            <RotateCcw aria-hidden="true" className="widget-btn-svg" />
          </button>
        </div>
      </div>
    </DesktopWidgetContainer>
  );
}
