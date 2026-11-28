import type { NousMessage, SpaceNotification } from "@space/contracts";

/**
 * Operator 28/11 14:00 BKK (Dana's micro1 interview card, answered «δεν με ενδιαφέρει» from the pane board): the operator's own message about
 * an ask's pane, or naming the ask, written after it, answers it. Then Nous may close the card with a reason and pass the answer to the pane.
 * Null: the operator has not answered it, so the guards hold.
 */
export function operatorAnswerTo(item: Pick<SpaceNotification, "id" | "paneId" | "createdAt">, messages: NousMessage[]): NousMessage | null {
  const after = Date.parse(item.createdAt);
  return messages.filter((message) => message.kind === "OPERATOR" && message.meta.person === true && Date.parse(message.createdAt) > after
    && ((item.paneId && (message.meta.refs as { paneId?: unknown } | undefined)?.paneId === item.paneId) || (item.id && message.content.includes(item.id))))
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0] ?? null;
}
