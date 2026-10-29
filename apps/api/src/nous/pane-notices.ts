import { z } from "zod";
import type { NeedsYouAsk, NotificationListQuery, NotificationRaiseInput, Pane, Room, SpaceNotification } from "@space/contracts";

/**
 * space_notify_operator (operator request 2026-10-17, plan clipboard:8FfXWclYUfOH): what only the operator's hands can do
 * (sign-in, password, CAPTCHA, a click bot protection blocks, a document or an answer only they have) reaches them as ONE
 * Space notification per pane, on that pane; a click takes them there. A new list for the same pane replaces the card's
 * items and alerts once more; the same list changes nothing. A card whose pane is gone is resolved.
 */
export const NOUS_PANE_NOTICE_PREFIX = "nous:pane:";
export const NOUS_GENERAL_NOTICE_KEY = "nous:general";

/** Needs you as questions (plan clipboard:5AQvaoSR-IZa): the card asks its first item's question; the operator's answer comes back to Nous. */
const askFields = {
  question: z.string().trim().min(1).max(300).optional().describe("The ONE question the operator answers from the card, in English (their answer reaches you as their message about this pane)."),
  options: z.array(z.string().trim().min(1).max(80)).min(1).max(6).optional().describe("The answers to pick from, at most 6."),
  recommended: z.string().trim().min(1).max(80).optional().describe("Your recommendation: one of the options.")
};

/**
 * Ask last (operator goal nous_goal:ee5a573e, 2026-10-27: «find the information yourself before you ask me»): every card, focus request
 * and question to the operator carries what Nous checked first; the card and the decision show it to the operator under "Checked first:".
 */
export const NOUS_ASK_LAST_RULE = "Ask last (operator goal ee5a573e, 2026-10-27): find it yourself first (Space Memory and operator facts, your own answers and notes, "
  + "pane reports and files, Vault, mail, DB, git, web, Live history) and list in `checked` (1-8 items) each source you consulted and what it showed; "
  + "ask the operator only for their hands, taste, money or a third party's approval.";
export const nousCheckedSchema = z.array(z.string().trim().min(3).max(200), { error: NOUS_ASK_LAST_RULE }).min(1, { error: NOUS_ASK_LAST_RULE }).max(8)
  .describe("What you checked before asking, 1-8 items: each a source and what it showed, e.g. \"Space Memory: no entry on X\", \"mail: no reply from Y since 27/10\".");
const CHECKED_HEADER = "\n\nChecked first:\n";
/** The "Checked first:" block the operator reads under a card or a decision; empty without items. */
export const checkedBlock = (checked: readonly string[] | undefined) => checked?.length ? `${CHECKED_HEADER}${checked.map((item) => `• ${item}`).join("\n")}` : "";
/** Text clipped to leave room for its checked block at the end, so the operator always sees what was checked. */
export function withCheckedBlock(text: string, checked: readonly string[] | undefined, max: number): string {
  const block = checkedBlock(checked);
  const room = max - block.length;
  return `${text.length > room ? `${text.slice(0, room - 1)}…` : text}${block}`;
}

export const notifyOperatorArgsSchema = z.object({
  room: z.string().trim().min(1).max(200).describe("The room's name as shown in the world (or its id)."),
  pane: z.string().trim().min(1).max(160).optional().describe("The pane that needs the operator; without it the card is the room's general one."),
  title: z.string().trim().min(1).max(80).describe("What waits there, in a few English words."),
  items: z.array(z.object({
    text: z.string().trim().min(1).max(200).describe("One thing only the operator can do, in English, at most 200 characters (details stay in the pane)."),
    ref: z.string().trim().min(1).max(120).optional().describe("The notification, decision or task id it comes from; a copilot question held for you goes to the operator with the card."),
    ...askFields
  })).min(1).max(12).describe("The whole list for that pane now: it replaces the card's earlier list."),
  checked: nousCheckedSchema
});
export type NotifyOperatorArgs = z.infer<typeof notifyOperatorArgsSchema>;

/**
 * space_focus_pane (Needs you, operator request 2026-10-24): an alias of space_notify_operator for one pane with one item. The card is the
 * focus: the operator's screen brings them to the pane for it (banner, maximize, focus, back when it resolves). One open card per pane.
 */
export const focusPaneSchema = z.object({
  room: z.string().trim().min(1).max(200).describe("The room's name as shown in the world (or its id)."),
  pane: z.string().trim().min(1).max(160).describe("A pane's name in that room (Andy, Bob, ...)."),
  reason: z.string().trim().min(1).max(200).describe("What only the operator can do or answer there, in one English line (it is the card's item)."),
  ref: z.string().trim().min(1).max(120).optional().describe("The notification, decision or task id it comes from; a copilot question held for you goes to the operator with the card."),
  ...askFields,
  checked: nousCheckedSchema
});
export const FOCUS_PANE_DESCRIPTION = "Bring the operator to a pane that needs their hands or their answer (a sign-in, CAPTCHA or browser handoff, a prompt only they "
  + "can answer): the same card as space_notify_operator with one item. Their screen offers Go now / Not now, switches room, maximizes the pane, focuses what needs "
  + "them and takes them back when the card resolves; resolve it with space_resolve_notification when nothing is left. Ask it as a question with options and your "
  + "recommendation: they can answer from the card without going, and the answer reaches you as their message about the pane. One open card per pane: the same reason "
  + "again changes nothing. Never for what you can answer yourself or for decisions (those go through space_ask_operator).";

export interface NousPaneNoticesDeps {
  notifications: {
    raise(input: NotificationRaiseInput, options?: { realert?: boolean }): Promise<SpaceNotification>;
    resolve(owner: string, dedupeKey: string): Promise<number>;
    list(owner: string, query: NotificationListQuery): Promise<SpaceNotification[]>;
    /** A copilot question held for Nous that an item names (`ref`) goes to the operator with the card (Ask Last step 7). */
    releaseHeldForNous?(owner: string, id: string): Promise<SpaceNotification | null>;
  };
  now?: () => number;
}

const bodyOf = (items: NotifyOperatorArgs["items"]) => items.map((item) => `• ${item.text}`).join("\n");
const live = (item: SpaceNotification) => item.status === "OPEN" || item.status === "READ";
/** The card's question: its first item that asks one (a recommendation that is not an option is dropped), answered through Nous. */
function askOf(items: NotifyOperatorArgs["items"]): NeedsYouAsk | null {
  const item = items.find((entry) => entry.question);
  if (!item?.question) return null;
  return { question: item.question, ...(item.options?.length ? { options: item.options } : {}),
    ...(item.recommended && item.options?.includes(item.recommended) ? { recommended: item.recommended } : {}), answer: { kind: "NOUS" } };
}

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
      const items = bodyOf(args.items);
      const body = `${items}${checkedBlock(args.checked)}`;
      const ask = askOf(args.items);
      const current = (await openCards(owner)).find((item) => item.dedupeKey === dedupeKey);
      // Other wording of what was checked is no new list: the operator is not alerted again for it.
      if (current && current.title === title && current.body.split(CHECKED_HEADER)[0] === items && JSON.stringify(current.payload.ask ?? null) === JSON.stringify(ask)) {
        return { ok: true, display: `The card for ${where} already lists this`, result: `Unchanged (${current.id}); the operator was not alerted again.` };
      }
      const card = await deps.notifications.raise({
        ownerUserId: owner, roomId: room.id, paneId: pane?.id ?? null, source: "NOUS", kind: "NEEDS_HANDS", severity: "ATTENTION", title, body,
        link: { roomId: room.id, ...(pane ? { paneId: pane.id } : {}) }, dedupeKey, telegram: null,
        payload: { items: args.items, checked: args.checked, alertAt: new Date(now()).toISOString(), ...(ask ? { ask } : {}) }
      }, { realert: Boolean(current) });
      for (const ref of new Set(args.items.map((item) => item.ref).filter((ref): ref is string => Boolean(ref)))) await deps.notifications.releaseHeldForNous?.(owner, ref).catch(() => null);
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
