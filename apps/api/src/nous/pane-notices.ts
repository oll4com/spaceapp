import { z } from "zod";
import type { NotificationListQuery, NotificationRaiseInput, Pane, Room, SpaceNotification } from "@space/contracts";

/**
 * space_notify_operator (operator request 2026-10-17, plan clipboard:8FfXWclYUfOH): what only the operator's hands can do
 * (sign-in, password, CAPTCHA, a click bot protection blocks, a document or an answer only they have) reaches them as ONE
 * Space notification per pane, on that pane; a click takes them there. A new list for the same pane replaces the card's
 * items and alerts once more; the same list changes nothing. A card whose pane is gone is resolved.
 */
export const NOUS_PANE_NOTICE_PREFIX = "nous:pane:";
export const NOUS_GENERAL_NOTICE_KEY = "nous:general";

export const notifyOperatorArgsSchema = z.object({
  room: z.string().trim().min(1).max(200).describe("The room's name as shown in the world (or its id)."),
  pane: z.string().trim().min(1).max(160).optional().describe("The pane that needs the operator; without it the card is the room's general one."),
  title: z.string().trim().min(1).max(80).describe("What waits there, in a few English words."),
  items: z.array(z.object({
    text: z.string().trim().min(1).max(200).describe("One thing only the operator can do, in English, at most 200 characters (details stay in the pane)."),
    ref: z.string().trim().min(1).max(120).optional().describe("The notification, decision or task id it comes from.")
  })).min(1).max(12).describe("The whole list for that pane now: it replaces the card's earlier list.")
});
export type NotifyOperatorArgs = z.infer<typeof notifyOperatorArgsSchema>;

/**
 * space_focus_pane (Needs you, operator request 2026-10-24): an alias of space_notify_operator for one pane with one item. The card is the
 * focus: the operator's screen brings them to the pane for it (banner, maximize, focus, back when it resolves). One open card per pane.
 */
export const focusPaneSchema = z.object({
  room: z.string().trim().min(1).max(200).describe("The room's name as shown in the world (or its id)."),
  pane: z.string().trim().min(1).max(160).describe("A pane's name in that room (Andy, Bob, ...)."),
  reason: z.string().trim().min(1).max(200).describe("What only the operator can do or answer there, in one English line (it is the card's item).")
});
export const FOCUS_PANE_DESCRIPTION = "Bring the operator to a pane that needs their hands or their answer (a sign-in, CAPTCHA or browser handoff, a prompt only they "
  + "can answer): the same card as space_notify_operator with one item. Their screen offers Go now / Not now, switches room, maximizes the pane, focuses what needs "
  + "them and takes them back when the card resolves; resolve it with space_resolve_notification when nothing is left. One open card per pane: the same reason "
  + "again changes nothing. Never for what you can answer yourself or for decisions (those go through space_ask_operator).";

export interface NousPaneNoticesDeps {
  notifications: {
    raise(input: NotificationRaiseInput, options?: { realert?: boolean }): Promise<SpaceNotification>;
    resolve(owner: string, dedupeKey: string): Promise<number>;
    list(owner: string, query: NotificationListQuery): Promise<SpaceNotification[]>;
  };
  now?: () => number;
}

const bodyOf = (items: NotifyOperatorArgs["items"]) => items.map((item) => `• ${item.text}`).join("\n");
const live = (item: SpaceNotification) => item.status === "OPEN" || item.status === "READ";

export function createNousPaneNotices(deps: NousPaneNoticesDeps) {
  const now = deps.now ?? Date.now;
  const openCards = async (owner: string) => (await deps.notifications.list(owner, { status: "ALL", source: "NOUS", limit: 200 }))
    .filter((item) => item.source === "NOUS" && live(item) && (item.dedupeKey?.startsWith(NOUS_PANE_NOTICE_PREFIX) || item.dedupeKey === NOUS_GENERAL_NOTICE_KEY));

  return {
    /** The room and pane are already the owner's (resolved by the tool). */
    async notify(owner: string, room: Room, pane: Pane | null, args: NotifyOperatorArgs): Promise<{ ok: boolean; display: string; result: string }> {
      const dedupeKey = pane ? `${NOUS_PANE_NOTICE_PREFIX}${pane.id}` : NOUS_GENERAL_NOTICE_KEY;
      const where = pane ? `${pane.paneName ?? pane.title} in ${room.name}` : room.name;
      const title = args.title;
      const body = bodyOf(args.items);
      const current = (await openCards(owner)).find((item) => item.dedupeKey === dedupeKey);
      if (current && current.title === title && current.body === body) {
        return { ok: true, display: `The card for ${where} already lists this`, result: `Unchanged (${current.id}); the operator was not alerted again.` };
      }
      const card = await deps.notifications.raise({
        ownerUserId: owner, roomId: room.id, paneId: pane?.id ?? null, source: "NOUS", kind: "NEEDS_HANDS", severity: "ATTENTION", title, body,
        link: { roomId: room.id, ...(pane ? { paneId: pane.id } : {}) }, dedupeKey, telegram: null,
        payload: { items: args.items, alertAt: new Date(now()).toISOString() }
      }, { realert: Boolean(current) });
      return { ok: true, display: `${current ? "Updated" : "Sent"} the operator's card for ${where} (${args.items.length} item${args.items.length === 1 ? "" : "s"})`,
        result: `Notification ${card.id}. Resolve it with space_resolve_notification when nothing is left there.` };
    },

    /** The world's section: Nous's open cards, so it can update or resolve them; empty when there are none. */
    async summary(owner: string, names: { room(id: string | null): string | null; pane(id: string | null): string | null }): Promise<string> {
      const cards = await openCards(owner);
      if (!cards.length) return "";
      return ["## Your cards to the operator (space_notify_operator: one per pane; resolve with space_resolve_notification when done)",
        ...cards.map((card) => {
          const items = Array.isArray(card.payload.items) ? card.payload.items.length : card.body.split("\n").length;
          return `- [${card.id}] ${card.title} · ${names.pane(card.paneId) ?? "no pane"} in ${names.room(card.roomId) ?? "a room"} · ${items} item${items === 1 ? "" : "s"}${card.status === "READ" ? " · read" : ""}`;
        })].join("\n");
    },

    /** Cards of panes that are no longer open are resolved (the world calls this with the owner's open panes). */
    async reconcile(owner: string, openPaneIds: ReadonlySet<string>): Promise<number> {
      let resolved = 0;
      for (const card of await openCards(owner)) {
        const paneId = card.dedupeKey?.startsWith(NOUS_PANE_NOTICE_PREFIX) ? card.dedupeKey.slice(NOUS_PANE_NOTICE_PREFIX.length) : null;
        if (paneId && !openPaneIds.has(paneId)) resolved += await deps.notifications.resolve(owner, card.dedupeKey!);
      }
      return resolved;
    }
  };
}
export type NousPaneNotices = ReturnType<typeof createNousPaneNotices>;
