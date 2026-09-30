export type DesktopWidgetId = "clock" | "countdown-timer" | "pushup-reminder" | "spaceapp-promo" | "ai-quota" | "streaming-metrics";

export interface DesktopWidgetState {
  id: DesktopWidgetId;
  enabled: boolean;
  x: number;
  y: number;
  minimized?: boolean;
  dockedToRail?: boolean;
  dockPosition?: "rail" | "header";
  zIndex?: number;
}

export interface ClockWidgetConfig {
  is24Hour: boolean;
  showSeconds: boolean;
}

export interface CountdownTimerWidgetConfig {
  durationSeconds: number;
  remainingSeconds: number;
  isRunning: boolean;
  isCompleted: boolean;
}

export interface PushupReminderWidgetConfig {
  intervalMinutes: number;
  targetReps: number;
  totalRepsToday: number;
  setsCompletedToday: number;
  remainingSeconds: number;
  isRunning: boolean;
  isAlertActive: boolean;
  lastActiveDate: string; // YYYY-MM-DD
}

export interface SpaceAppPromoWidgetConfig {
  headline: string;
  subheadline: string;
  platformText: string;
  url: string;
}

export interface AiQuotaWidgetConfig {
  activeTab: "all" | "antigravity" | "codex" | "api";
  windowMode: "5h" | "weekly";
  autoRefresh: boolean;
  refreshIntervalSeconds: number;
  miniCycleIntervalSeconds?: number;
}
