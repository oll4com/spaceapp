import type { MonitoringAction, MonitoringChartWindow, MonitoringCollectorConfig, MonitoringCollectorStatus, MonitoringCopilotPaneMetadata, MonitoringEvent, MonitoringRunStatus, MonitoringSeries } from "@space/contracts";

// The shapes /api/panes/:id/monitoring-copilot/state and /targets answer (apps/api/src/monitoring-copilot/service.ts alertView, summary, runView).
export interface MonitoringAlertView {
  id: string; alertname: string; severity: "CRITICAL" | "WARNING" | "INFO"; source: "PROMETHEUS" | "LOKI"; instance: string; job: string; summary: string; description: string;
  labels: Record<string, string>; state: "FIRING" | "RESOLVED"; startsAt: string; endsAt: string | null; lastSeenAt: string;
}
export interface MonitoringRunView { status: MonitoringRunStatus; paused: boolean; autonomy: "ASSIST" | "FULL"; openQuestions: number; openReviews: number; pendingBriefs: number }
export interface MonitoringSummary { firing: Record<"CRITICAL" | "WARNING" | "INFO", number>; top: MonitoringAlertView[]; collector: MonitoringCollectorStatus }
export interface MonitoringCopilotState { metadata: MonitoringCopilotPaneMetadata; collectorConfig?: MonitoringCollectorConfig; run: MonitoringRunView; summary: MonitoringSummary; alerts: MonitoringAlertView[]; actions: MonitoringAction[]; events: MonitoringEvent[] }
export interface MonitoringTargetView { job: string; instance: string; health: "up" | "down" | "unknown"; lastError: string; lastScrape: string | null; scrapeSeconds: number | null }
/** /charts (service.ts MONITORING_CHARTS): each chart's series over a fixed window, or the collector's error for that chart. */
export interface MonitoringChart { id: string; title: string; unit: "count" | "rate" | "percent" | "seconds" | "bytes"; series: MonitoringSeries[]; truncated: boolean; error: string | null }
export interface MonitoringCharts { window: MonitoringChartWindow; minutes: number; stepSeconds: number; charts: MonitoringChart[] }
