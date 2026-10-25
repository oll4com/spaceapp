import {
  appDiagnosticsTechnicalEventSchema,
  type AppDiagnosticsTechnicalEvent
} from "@space/contracts";

export const APP_DIAGNOSTICS_PERFORMANCE_EVENT = "space:app-diagnostics-performance";

export type AppDiagnosticsPerformanceDetail = Omit<
  Extract<AppDiagnosticsTechnicalEvent, { category: "PERFORMANCE" }>,
  "sequence" | "occurredAt"
>;

export function parseAppDiagnosticsPerformanceDetail(
  value: unknown
): AppDiagnosticsPerformanceDetail | null {
  if (typeof value !== "object" || value === null) return null;
  const parsed = appDiagnosticsTechnicalEventSchema.safeParse({
    ...value,
    sequence: 0,
    occurredAt: "1970-01-01T00:00:00.000Z"
  });
  if (!parsed.success || parsed.data.category !== "PERFORMANCE") return null;
  const { sequence: _sequence, occurredAt: _occurredAt, ...detail } = parsed.data;
  return detail;
}

export function emitAppDiagnosticsPerformance(
  detail: AppDiagnosticsPerformanceDetail
): void {
  window.dispatchEvent(new CustomEvent<AppDiagnosticsPerformanceDetail>(
    APP_DIAGNOSTICS_PERFORMANCE_EVENT,
    { detail }
  ));
}
