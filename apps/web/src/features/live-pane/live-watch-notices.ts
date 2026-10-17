/**
 * Watches Live acknowledges without a word: a cancelled one (its pane closed) and the automatic watch of a prompt
 * Live did not send (agents' test rooms, the Room Agent). Their notices reached the operator's voice session and
 * were taken for the result of the operator's own request (2026-10-15).
 */
export function isSilentWatch(watch: { status?: string; auditTrail?: Array<{ detail?: string; evidence?: unknown }> }): boolean {
  if (watch.status === "CANCELLED") return true;
  const first = watch.auditTrail?.[0];
  const trace = (first?.evidence as { traceId?: unknown } | undefined)?.traceId;
  return Boolean(first?.detail?.startsWith("Auto-watch")) && typeof trace === "string" && !trace.startsWith("live:");
}
