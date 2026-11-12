/**
 * Delivery truth (12/11, nous_msg:51cbff86): a Nous send, prompt or model change that Space Control answered RUNNING or PENDING and that
 * later ends FAILED or BLOCKED (a queued prompt whose pane closed, an operator stop, a model change that failed) reaches Nous's inbox at
 * once, with Space Control's reason, instead of being found only by reading the pane.
 */
export interface LateControlOutcome {
  kind: "operation" | "schedule"; id: string; actorId: string; roomId: string; sourceRequestId: string | null; status: string; reason: string; paneIds: readonly string[];
}

export interface DeliveryTruthDeps {
  room(id: string): Promise<{ name: string } | null>;
  pane?(id: string): Promise<{ id: string; title: string; paneName?: string | null } | null>;
  notice(owner: string, key: string, line: string, soonMs?: number): Promise<void>;
}

export async function reportLateDelivery(deps: DeliveryTruthDeps, outcome: LateControlOutcome): Promise<void> {
  // Nous's room calls carry `nous:<turn>:<call>` (tools.ts roomCtx); its after-turn sends keep it as their schedule's source request.
  if (!outcome.sourceRequestId?.startsWith("nous:")) return;
  const room = (await deps.room(outcome.roomId).catch(() => null))?.name ?? outcome.roomId;
  const panes = await Promise.all(outcome.paneIds.map(async (id) => {
    const pane = await deps.pane?.(id).catch(() => null);
    return pane ? `${pane.paneName ?? pane.title} (${pane.id})` : id;
  }));
  const what = outcome.kind === "schedule" ? "queued send or model change" : "send or control";
  // One key per Nous call: the schedule and the operation it ran report the same failure once.
  await deps.notice(outcome.actorId, `delivery:${outcome.sourceRequestId}`, `Not delivered: your ${what} to ${panes.join(", ") || "the room"} in room "${room}" `
    + `(${outcome.sourceRequestId}, ${outcome.id}) ended ${outcome.status}: ${outcome.reason.replace(/\s+/g, " ").trim() || "no reason given"}. `
    + "The pane did not get it: fix the cause, then send again (space_send_to_pane) or tell the operator.", 5_000);
}
