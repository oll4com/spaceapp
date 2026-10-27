import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { advanceWorkspaceMovementReminder } from "@space/contracts";
import { Bell, BellOff, BellRing, Check, Dumbbell, Pause, Play, RotateCcw, Volume2 } from "../ui-theme/app-icons.js";
import type { DesktopWidgetState, PushupReminderWidgetConfig } from "./types.js";
import { DesktopWidgetContainer } from "./DesktopWidgetContainer.js";
import {
  DEFAULT_PUSHUP_CONFIG,
  loadWidgetConfig,
  saveWidgetConfig,
  WIDGET_CONFIG_CHANGED_EVENT
} from "./widget-storage.js";
import { playChime } from "./audio-chime.js";

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
        lastActiveDate: today,
        isAlertActive: false
      };
    }
    return loaded;
  });

  useEffect(() => {
    const handler = (e: Event) => {
      const customEvent = e as CustomEvent<{ id: string; config: PushupReminderWidgetConfig }>;
      if (customEvent.detail?.id === "pushup-reminder" && customEvent.detail.config) {
        setConfig(customEvent.detail.config);
      }
    };
    window.addEventListener(WIDGET_CONFIG_CHANGED_EVENT, handler);
    return () => window.removeEventListener(WIDGET_CONFIG_CHANGED_EVENT, handler);
  }, []);

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
    if (config.soundEnabled === false) return;
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
  }, [stopAlertSound, config.soundEnabled]);

  // Stop sound on unmount
  useEffect(() => {
    return () => {
      stopAlertSound();
    };
  }, [stopAlertSound]);

  const updateConfig = useCallback(
    (partial: Partial<PushupReminderWidgetConfig>) => {
      setConfig((prev) => {
        const next = { ...prev, ...partial };
        saveWidgetConfig("pushup-reminder", next);
        return next;
      });
    },
    []
  );

  // Timer tick for workout countdown. The deadline is absolute, so a tab whose
  // timers are throttled in the background still alerts on time, and the state
  // updater stays pure (storage is written by the effect below, not per tick).
  const deadlineRef = useRef<number | null>(null);
  useEffect(() => {
    if (!config.isRunning || config.isAlertActive) {
      deadlineRef.current = null;
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
      return;
    }
    deadlineRef.current = Date.now() + config.remainingSeconds * 1000;
    timerRef.current = setInterval(() => {
      const deadline = deadlineRef.current;
      if (deadline === null) return;
      const remaining = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
      setConfig((prev) => {
        const next = advanceWorkspaceMovementReminder(prev, remaining);
        // Time is up: the shared reminder function raised the pushup workout alert and reset the interval.
        if (next.isAlertActive && !prev.isAlertActive) deadlineRef.current = null;
        return next.remainingSeconds === prev.remainingSeconds && next.isAlertActive === prev.isAlertActive ? prev : next;
      });
    }, 1000);
    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    };
    // remainingSeconds seeds the deadline only when the countdown (re)starts or the interval changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config.isRunning, config.isAlertActive, config.intervalMinutes]);

  // Persist the countdown sparingly: the alert transition syncs to the server,
  // ordinary ticks are saved locally every 15 seconds instead of every second.
  const lastPersistedRef = useRef<{ remainingSeconds: number; isAlertActive: boolean } | null>(null);
  useEffect(() => {
    if (!config.isRunning) return;
    const last = lastPersistedRef.current;
    const alertTransition = config.isAlertActive && !last?.isAlertActive;
    if (!alertTransition && config.remainingSeconds % 15 !== 0) return;
    if (last && last.remainingSeconds === config.remainingSeconds && last.isAlertActive === config.isAlertActive) return;
    lastPersistedRef.current = { remainingSeconds: config.remainingSeconds, isAlertActive: config.isAlertActive };
    saveWidgetConfig("pushup-reminder", config, { syncToServer: alertTransition });
  }, [config]);

  // Audio alert playback
  const prevAlertActiveRef = useRef(config.isAlertActive);
  useEffect(() => {
    if (!prevAlertActiveRef.current && config.isAlertActive) {
      startAlertSound();
    } else if (!config.isAlertActive) {
      stopAlertSound();
    }
    prevAlertActiveRef.current = config.isAlertActive;
  }, [config.isAlertActive, startAlertSound, stopAlertSound]);

  const handleDismissAlert = useCallback(() => {
    stopAlertSound();
    playChime("click");
    updateConfig({
      remainingSeconds: config.intervalMinutes * 60,
      isAlertActive: false
    });
  }, [stopAlertSound, config.intervalMinutes, updateConfig]);

  const handleLogDone = useCallback(
    (repsToAdd?: number) => {
      stopAlertSound();
      playChime("log-done");
      const addCount = repsToAdd ?? config.targetReps;
      updateConfig({
        totalRepsToday: config.totalRepsToday + addCount,
        setsCompletedToday: config.setsCompletedToday + 1,
        remainingSeconds: config.intervalMinutes * 60,
        isAlertActive: false,
        isRunning: true
      });
    },
    [config.targetReps, config.totalRepsToday, config.setsCompletedToday, config.intervalMinutes, stopAlertSound, updateConfig]
  );

  const handleSnooze = useCallback(
    (minutes: number) => {
      stopAlertSound();
      playChime("click");
      updateConfig({
        remainingSeconds: minutes * 60,
        isAlertActive: false,
        isRunning: true
      });
    },
    [stopAlertSound, updateConfig]
  );

  const handleIntervalChange = useCallback(
    (minutes: number) => {
      playChime("click");
      updateConfig({
        intervalMinutes: minutes,
        remainingSeconds: minutes * 60
      });
    },
    [updateConfig]
  );

  const handleTargetRepsChange = useCallback(
    (delta: number) => {
      playChime("click");
      const next = Math.max(5, Math.min(100, config.targetReps + delta));
      updateConfig({ targetReps: next });
    },
    [config.targetReps, updateConfig]
  );

  const handleToggleRunning = useCallback(() => {
    playChime("click");
    updateConfig({ isRunning: !config.isRunning });
  }, [config.isRunning, updateConfig]);

  const handleResetToday = useCallback(() => {
    playChime("click");
    updateConfig({
      totalRepsToday: 0,
      setsCompletedToday: 0
    });
  }, [updateConfig]);

  const handleTestAlert = () => {
    stopAlertSound();
    playChime("click");
    updateConfig({
      isAlertActive: true,
      alertReason: "pushups"
    });
  };

  const formatCountdown = (totalSeconds: number): string => {
    const mins = Math.floor(totalSeconds / 60);
    const secs = totalSeconds % 60;
    return `${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
  };

  const progressFraction = useMemo(() => {
    const total = config.intervalMinutes * 60;
    if (total <= 0) return 0;
    const elapsed = total - config.remainingSeconds;
    return Math.max(0, Math.min(1, elapsed / total));
  }, [config.intervalMinutes, config.remainingSeconds]);

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
      {config.isAlertActive ? "Time's up!" : formatCountdown(config.remainingSeconds)}
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
        <span className="widget-docked-countdown">
          {formatCountdown(config.remainingSeconds)}
        </span>
      )}
    </div>
  );

  const headerControls = (
    <>
      {config.isAlertActive ? (
        <button
          type="button"
          className="desktop-widget-btn-action is-alert-stop-btn"
          onClick={handleDismissAlert}
          title="Stop alarm / Dismiss alert"
          aria-label="Stop alarm"
        >
          <BellRing aria-hidden="true" className="widget-header-svg is-ringing" />
          <span>Stop</span>
        </button>
      ) : null}
      <button
        type="button"
        className="desktop-widget-btn-action"
        onClick={handleTestAlert}
        title="Test push-up workout alert"
        aria-label="Test workout alert"
      >
        <Volume2 aria-hidden="true" className="widget-header-svg" />
      </button>
      <button
        type="button"
        className={`desktop-widget-btn-action ${config.soundEnabled === false ? "is-muted" : ""}`}
        onClick={() => {
          playChime("click");
          updateConfig({ soundEnabled: config.soundEnabled === false });
        }}
        title={config.soundEnabled === false ? "Sound muted (click to unmute)" : "Sound enabled (click to mute)"}
        aria-label={config.soundEnabled === false ? "Unmute sound" : "Mute sound"}
      >
        {config.soundEnabled === false ? (
          <BellOff aria-hidden="true" className="widget-header-svg" />
        ) : (
          <Bell aria-hidden="true" className="widget-header-svg" />
        )}
      </button>
    </>
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
      onStopAlert={handleDismissAlert}
      headerControls={headerControls}
      onPositionChange={onPositionChange}
      onToggleMinimize={onToggleMinimize}
      onClose={onClose}
      onFocus={onFocus}
      className={`widget-pushup-container ${config.isAlertActive ? "is-alert" : ""}`}
    >
      <div className="widget-pushup-content">
        <div className="widget-pushups-panel">
          {/* Urgent reminder alert banner when time is up */}
          {config.isAlertActive ? (
            <div className="widget-pushup-banner" role="alert">
              <div className="widget-pushup-banner-header">
                <BellRing className="widget-banner-icon is-ringing" />
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
                  className="widget-secondary-btn is-stop-alert"
                  onClick={handleDismissAlert}
                  title="Stop alarm and dismiss alert"
                >
                  <BellOff className="widget-btn-svg" /> Stop Alert
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
              <span className="widget-pushup-label">
                {config.isAlertActive ? "Time is up!" : "Next set in"}
              </span>
              <span className={`widget-pushup-time ${config.isAlertActive ? "is-alert" : ""}`}>
                {config.isAlertActive ? (
                  <>
                    <BellRing className="widget-timer-bell-icon" /> ALERT!
                  </>
                ) : (
                  formatCountdown(config.remainingSeconds)
                )}
              </span>
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
      </div>
    </DesktopWidgetContainer>
  );
}
