export interface VoiceDelegationAuditEvent {
  actorUserId: string | null;
  action: string;
  createdAt: string;
  metadata: Record<string, unknown>;
}

export interface VoiceCostSummary {
  calls: number;
  knownCostCalls: number;
  estimatedCostUsd: number;
  averageLatencyMs: number | null;
  byProvider: Record<string, number>;
}

function telemetryOf(event: VoiceDelegationAuditEvent): Record<string, unknown> | null {
  const value = event.metadata.telemetry;
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export function summarizeVoiceDelegationCosts(
  events: readonly VoiceDelegationAuditEvent[],
  actorUserId: string,
  sinceMs: number
): VoiceCostSummary {
  const selected = events.filter(event => event.actorUserId === actorUserId && event.action === "voice.realtime.delegate" && Date.parse(event.createdAt) >= sinceMs);
  const telemetry = selected.map(telemetryOf).filter((value): value is Record<string, unknown> => value !== null);
  const costs = telemetry.map(value => typeof value.estimatedCostUsd === "number" && Number.isFinite(value.estimatedCostUsd) ? value.estimatedCostUsd : null).filter((value): value is number => value !== null);
  const latency = telemetry.map(value => typeof value.latencyMs === "number" && Number.isFinite(value.latencyMs) ? value.latencyMs : null).filter((value): value is number => value !== null);
  const byProvider: Record<string, number> = {};
  for (const value of telemetry) if (typeof value.provider === "string") byProvider[value.provider] = (byProvider[value.provider] ?? 0) + 1;
  return { calls: selected.length, knownCostCalls: costs.length, estimatedCostUsd: costs.reduce((sum, value) => sum + value, 0),
    averageLatencyMs: latency.length ? Math.round(latency.reduce((sum, value) => sum + value, 0) / latency.length) : null, byProvider };
}

export function isVoiceDailyBudgetExceeded(summary: VoiceCostSummary, budgetUsd: number | null): boolean {
  return budgetUsd != null && summary.estimatedCostUsd >= budgetUsd;
}
