export type DesktopWidgetId =
  | "clock"
  | "countdown-timer"
  | "pushup-reminder"
  | "spaceapp-promo"
  | "ai-quota"
  | "streaming-metrics";

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

export type ReminderType = "pushups" | "tokens";

export interface PushupReminderWidgetConfig {
  reminderType?: ReminderType;
  tokenProvider?: "all" | "gemini" | "codex";
  proOnly?: boolean;
  intervalMinutes: number;
  targetReps: number;
  totalRepsToday: number;
  setsCompletedToday: number;
  remainingSeconds: number;
  isRunning: boolean;
  isAlertActive: boolean;
  alertReason?: "pushups" | "tokens";
  soundEnabled?: boolean;
  lastActiveDate: string; // YYYY-MM-DD
}

export interface SpaceAppPromoWidgetConfig {
  headline: string;
  subheadline: string;
  platformText: string;
  url: string;
}

export type AiQuotaTab = "all" | "codex" | "antigravity" | "claude" | "api";
export type AiQuotaAlertProvider = "all" | "codex" | "gemini" | "claude";

export interface AiQuotaWidgetConfig {
  activeTab: AiQuotaTab;
  availabilityFilter?: "all" | "available" | "soon" | "exhausted";
  showAllAccounts?: boolean;
  autoRefresh: boolean;
  refreshIntervalSeconds: number;
  // Reset alerts, formerly the separate AI Token Reminder widget.
  alertsEnabled?: boolean;
  alertProvider?: AiQuotaAlertProvider;
  proOnly?: boolean;
  soundEnabled?: boolean;
}
