import { copilotQuestionItemId, heldForNous, heldUnderAllowance, isCopilotQuestion, isNousApproval, isNousFirstCard, type NotificationSource, type SpaceNotification } from "@space/contracts";
import { NOUS_APPROVAL_ALLOWANCE, type NotificationService } from "../notifications/service.js";
import { questionMemoryTerms, type CopilotMemoryHit } from "@space/db";
import { QUESTION_ACT_LINE, REVIEW_ACT_LINE, type NousTurnItem } from "./turn-items.js";
import { recallEntries } from "./operator-facts.js";
import { fitWhole } from "./retrieval.js";

/** Which copilot sources a wired copilot service answers for: only their questions can be checked against the open items. */
export const COPILOT_SOURCE_OF = { job: "JOB_COPILOT", mail: "MAIL_COPILOT", marketing: "MARKETING_COPILOT", freelance: "FREELANCE_COPILOT", design: "DESIGN",
  appStudio: "APP_STUDIO", video: "VIDEO", security: "SECURITY_COPILOT", monitoring: "MONITORING_COPILOT" } as const satisfies Record<string, NotificationSource>;

/**
 * Ask Last step 7, every minute (like the decisions withdrawn once decided in the rail): (a) a copilot question record whose question no
 * longer waits (answered in the rail or by Nous, closed, or its pane gone) is RESOLVED, never deleted: 286 such records of 13-24/10 sat
 * unresolved; (b) a question held for Nous goes to the operator once its hour ends or Nous no longer holds questions (off, paused).
 * An owner whose open items cannot be read is left alone that minute. A question is resolved only after it was missing for
 * NOUS_QUESTION_GONE_MS: on 28/10 02:31 one read of the open items came back without two Job questions that still waited in the rail
 * (and were answered at 02:35), and a resolved held question never reaches the operator.
 */
export const NOUS_QUESTION_GONE_MS = 2 * 60_000;

const REVIEW_COPILOT: Partial<Record<NotificationSource, "MARKETING" | "FREELANCE" | "MAIL" | "JOB">> = { MARKETING_COPILOT: "MARKETING", FREELANCE_COPILOT: "FREELANCE",
  MAIL_COPILOT: "MAIL", JOB_COPILOT: "JOB" };
const flat = (text: string) => text.replace(/\s+/g, " ").trim();
/** What a card held for Nous asks of it in its hour: the end of its inbox line. */
export function heldForNousNote(item: Pick<SpaceNotification, "id" | "source" | "kind" | "paneId" | "payload" | "dedupeKey">): string {
  if (item.source === "MAIL_COPILOT" && item.kind === "NEEDS_USER") {
    return ` (held for you up to 60 min, not shown to the operator: when the mail needs nobody (information, the operator's own forms) resolve it with space_resolve_notification ${item.id}, else put it on the pane's card with ref ${item.id} and your recommended option)`;
  }
  // R24-2 (operator 1/11 11:50 BKK «σου εχω ζητησει παρα πολλες φορές να κανεις εσυ τις αποδοχες σε αυτο το σημειο»): a Marketing or Freelance
  // review is Nous's to approve; the line carries the item, its text and the exact call, so the approval needs no other read.
  // Operator 2/11 15:08 BKK («να μην φτανει σε εμενα το aprove»): an approval held under "May send" never goes to the operator; Nous is woken each hour.
  const yours = heldUnderAllowance(item) ? "held for you while \"May send\" is on: it never goes to the operator, decide it now (you are woken for it every hour until you do)"
    : "held for you up to 60 min, not shown to the operator";
  if (item.source === "MAIL_COPILOT" && item.kind === "CAMPAIGN_REVIEW") {
    const campaign = String(item.payload.campaignId ?? reviewItemId(item));
    const cancel = { type: "COPILOT", copilot: "MAIL", item: "CAMPAIGN", itemId: campaign, paneId: item.paneId, decision: "cancel" };
    return ` (${yours}. Mail campaign ${campaign}: read every mail it sends with space_mail_campaigns {"campaign":"${campaign}","offset":0} page by page; if every one keeps to the `
      + `operator's rules approve it with space_mail_campaign_approve {"campaign":"${campaign}","fingerprint":"<the fingerprint the read showed>"}, else decline it with `
      + `space_ask_operator category EXTERNAL, action ${JSON.stringify(cancel)}: with "May send" on both run at once.)`;
  }
  if (item.source === "MAIL_COPILOT" && item.kind === "CAMPAIGN_PAUSED") {
    const campaign = String(item.payload.campaignId ?? "");
    return ` (${yours}. Mail campaign ${campaign} paused, its reason above. If the cause is gone (an outage the server did not resume by itself, a cause`
      + ` you dealt with), resume it with space_mail_campaign_resume {"campaign":"${campaign}"}: only who was not sent yet gets it. A bounce or complaint pause`
      + ` stays paused until you have checked the list; then resolve this card with space_resolve_notification ${item.id}. Never ask the operator to resume.)`;
  }
  const copilot = REVIEW_COPILOT[item.source];
  if (copilot && item.kind === "REVIEW_REQUESTED") {
    const review = (item.payload.review ?? {}) as { id?: unknown; channel?: unknown; text?: unknown };
    const itemId = reviewItemId(item);
    const action = { type: "COPILOT", copilot, item: "REVIEW", itemId, paneId: item.paneId, decision: "approve" };
    return ` (${yours}. Operator 1/11 11:50 BKK: you approve these reviews yourself. Review ${itemId}`
      + `${typeof review.text === "string" ? `, its text (pane data): "${flat(review.text)}"` : ""}. If it keeps to the copilot's facts and the operator's rules, approve it now: `
      + `space_ask_operator category EXTERNAL, action ${JSON.stringify(action)} (decision "edit" with text for your own version), refs.sendKind `
      + `"${copilot.toLowerCase()}-${typeof review.channel === "string" ? review.channel.toLowerCase() : "review"}": with "May send" on it runs at once. `
      + `If it should not go out, the same call with decision "${copilot === "MAIL" || copilot === "JOB" ? "reject" : "revise"}" and a note (back to the copilot) or "reject" runs at once too (R24-3)`
      + `${heldUnderAllowance(item) ? "" : "; after the hour it goes to the operator"}.)`;
  }
  // 2/11 (operator 10:16 BKK «κλεισε οτι μπορεις να κανεις εσυ -- και αφησε μονο οτι πραγματικα θες απο εμας!!»): an agent's needs-you and every
  // other copilot NEEDS_USER are Nous's first; only hands, money, ID, his own tests or a send he asked to read go on to the operator.
  if (!isCopilotQuestion(item) && (item.kind === "NEEDS_USER" || item.kind === "NEEDS_YOU")) {
    return ` (held for you up to 60 min, not shown to the operator: do it yourself or have an agent do it (space_send_to_pane ${JSON.stringify({ pane: item.paneId })} with the answer or the way: `
      + `a code in a connected mailbox, the Vault's login, an agent's browser), or resolve it with space_resolve_notification ${item.id} when it needs nobody (information, done, a duplicate); `
      + `only what needs the operator's own hands, money, ID, his own tests or a send he asked to read goes on his card with ref ${item.id} and your recommended option)`;
  }
  // Plan clipboard:7L5KyWp3kQsP step 1: the exact answer call, so no read stands between Nous and the answer.
  const question = isCopilotQuestion(item) ? copilotQuestionItemId(item) : null;
  const call = question ? ` ${JSON.stringify({ copilot: item.source.replace(/_COPILOT$/, ""), question, answer: "<the answer>" })}` : "";
  return ` (held for you up to 60 min, not shown to the operator: answer it with space_copilot_answer${call} when you can find the answer`
    + ` yourself, else put it on the pane's card with ref ${item.id})`;
}

const reviewItemId = (item: Pick<SpaceNotification, "payload">) => String((item.payload.review as { id?: unknown } | undefined)?.id
  ?? (item.payload.ask as { answer?: { itemId?: unknown } } | undefined)?.answer?.itemId ?? item.payload.campaignId ?? "");
/** R37-1: a Marketing or Freelance review held for Nous is a hold-A item: its turn comes back to it until Nous decides it (turn-items.ts). */
export function heldReviewItem(item: Pick<SpaceNotification, "id" | "source" | "kind" | "paneId" | "payload">, line: string): NousTurnItem | null {
  const review = isNousApproval(item) && item.payload.heldForNous ? reviewItemId(item) : "";
  return review ? { key: `review:${review}`, kind: "REVIEW", line, review, notification: item.id } : null;
}

/** A card held for Nous as every turn shows it: the card, and what memory holds about it (step 2). */
export interface HeldCopilotQuestion { card: SpaceNotification; memory?: string[] }

/** The copilot memory each question source keeps (copilot-memory-search.ts labels); the others keep none. */
export const COPILOT_MEMORY_LABEL: Partial<Record<string, string>> = { JOB_COPILOT: "Job Copilot memory", FREELANCE_COPILOT: "Freelance Copilot memory",
  MARKETING_COPILOT: "Marketing Copilot memory", MAIL_COPILOT: "Mail Copilot memory", SECURITY_COPILOT: "Security Copilot memory", MONITORING_COPILOT: "Monitoring Copilot memory" };

/**
 * Step 2: what Space already holds about a card held for Nous, recalled when it is held: that copilot's own memory (queue item 34) and Space
 * Memory, by the question's words. Whole entries within the retrieved-section bound; the rest are named with how to read them.
 */
export async function heldQuestionRecall(item: Pick<SpaceNotification, "source" | "title" | "body">, deps: {
  copilot?(query: string): Promise<CopilotMemoryHit[]>; space?(): Promise<string>;
}): Promise<string[]> {
  const query = questionMemoryTerms(item.body || item.title).join(" ");
  const label = COPILOT_MEMORY_LABEL[item.source];
  const [copilot, space] = await Promise.all([
    label && deps.copilot ? deps.copilot(query).catch(() => []) : [],
    deps.space ? deps.space().then((text) => recallEntries(text, query)).catch(() => []) : []
  ]);
  return fitWhole([
    ...copilot.filter((hit) => hit.source === label).map((hit) => ({ whole: `${hit.id} "${flat(hit.key ?? "")}" → ${flat(hit.text)}`, name: hit.id })),
    ...space.map((entry) => ({ whole: `${entry.id} "${flat(entry.title)}" → ${flat(entry.body)}`, name: entry.id }))
  ], "space_memory_recall reads them").map((line) => line.replace(/^- /, ""));
}

/** The recall Space attached to a held card (step 2). */
const recallOf = (item: SpaceNotification): string[] => Array.isArray(item.payload.recall) ? item.payload.recall.filter((line): line is string => typeof line === "string") : [];

/** The inbox line of a card held for Nous (the same text the pinned section lists). */
export function heldCardLine(item: SpaceNotification, memory: readonly string[] = recallOf(item)): string {
  return `${item.source} ${item.kind}: ${item.title}${item.body ? ` — ${flat(item.body)}` : ""} [${item.id}]${typeof item.payload.heldUntil === "string" ? " (held for the morning)" : ""}`
    + heldForNousNote(item) + (memory.length ? `; memory holds: ${memory.join("; ")}` : "");
}

/** The ids an act names a held card by: its notification id, the copilot's question id, a review's id. */
function heldCardRefs(item: SpaceNotification): string[] {
  const review = (item.payload.review as { id?: unknown } | undefined)?.id;
  // 2/11: an agent's needs-you moves by a text to its pane too (named by its id, as the held line gives it).
  return [item.id, isCopilotQuestion(item) ? copilotQuestionItemId(item) : null, typeof review === "string" ? review : null,
    item.source === "AGENT" ? item.paneId : null].filter((ref): ref is string => Boolean(ref));
}

/** Plan clipboard:7L5KyWp3kQsP step 1: a held card is a hold A item; R37-1 reviews keep their stricter decision acts in every turn. */
export function heldQuestionItem(item: SpaceNotification, line = heldCardLine(item)): NousTurnItem {
  return heldReviewItem(item, line) ?? { key: `question:${item.id}`, kind: "QUESTION", line, refs: heldCardRefs(item) };
}

/**
 * Step 1's pinned section: every card held for Nous and not yet answered, in every turn whatever its kind, with its age and what is left of
 * its hour (1/11 17:10 UTC: an INBOX turn batched jobq:Tcoa0D_0Vp3t with other lines and ended NOTHING_NEW; nothing showed it again).
 * A card Nous already put on its own card (R16-8) is forwarded and left out.
 */
export function renderHeldQuestions(held: readonly HeldCopilotQuestion[], at: number): string {
  if (!held.length) return "";
  const hhmm = (iso: string) => iso.slice(11, 16);
  const lines = held.map(({ card, memory }) => {
    const hold = (card.payload.heldForNous ?? {}) as { until?: unknown; hourEnded?: unknown };
    const left = Math.round((Date.parse(String(hold.until ?? "")) - at) / 60_000);
    const asked = Math.max(0, Math.round((at - Date.parse(card.createdAt)) / 60_000));
    return `- ${heldCardLine(card, memory)} · asked ${hhmm(card.createdAt)} UTC, ${asked} min ago; `
      + (heldUnderAllowance(card) ? "yours while \"May send\" is on: it never goes to the operator" : typeof hold.hourEnded === "string" ? `its hour ran out at ${hhmm(hold.hourEnded)} UTC: held ${Math.max(0, left)} min more while you are woken for it, then it goes to the operator`
        : left > 0 ? `${left} min of its hold left, then it goes to the operator` : "its hold ran out: it goes to the operator once you were woken for it twice");
  });
  return [`## Copilot questions held for you (answer now)`,
    `Each waits for you, not the operator. For questions: ${QUESTION_ACT_LINE}. For reviews: ${REVIEW_ACT_LINE}. A turn that ends without one of these is held and you are woken again at once.`,
    ...lines].join("\n");
}

/** A held card whose hour ended reaches the operator only after Nous was shown it in this many turns (step 1: "a second wake already happened"). */
export const NOUS_QUESTION_MIN_WAKES = 2;
/**
 * Technical bound, not a policy: while Nous is on but runs no turn (low-spend CRITICAL, a held inbox), a card whose hour ended is woken for
 * at most this long past its hour, then goes to the operator anyway, so no question waits for a turn that never comes.
 */
export const NOUS_QUESTION_REWAKE_MS = 60 * 60_000;
/** An approval held under "May send" wakes Nous again this often while it waits (operator 2/11 15:08 BKK: never the operator instead). */
export const NOUS_APPROVAL_REWAKE_MS = 60 * 60_000;
/** Each wake after the hour holds the card this much longer (the stores show a card in Needs you once its `until` passed). */
export const NOUS_QUESTION_REWAKE_STEP_MS = 10 * 60_000;

export async function sweepCopilotQuestions(deps: {
  notifications: Pick<NotificationService, "unresolvedBySource" | "setStatus" | "releaseHeldForNous" | "get" | "addPayload">;
  sources: readonly NotificationSource[];
  openItemIds(owner: string): Promise<Set<string>>;
  paneOpen(paneId: string): Promise<boolean>;
  /** R10-13: a held Freelance or Marketing NEEDS_USER card that a later Nous brief to its pane answered (the copilot took it). */
  answeredByNousBrief?(item: SpaceNotification): Promise<boolean>;
  holds(owner: string): Promise<boolean>;
  /** Nous is on with "May send" (coversApproval): the approvals held under it stay Nous's. */
  covers?(owner: string): Promise<boolean>;
  /** Step 1: how many Nous turns showed the held card, and a wake for it now (an urgent inbox line carrying its item). */
  shown?(owner: string, id: string): number;
  rewake?(item: SpaceNotification): Promise<void>;
  /** Notification id → when the sweep first found its question gone; kept by the caller across minutes. */
  missingSince: Map<string, number>;
  now?: () => number;
}): Promise<{ resolved: number; released: number; rewoken?: number }> {
  const now = deps.now ?? Date.now;
  const byOwner = new Map<string, SpaceNotification[]>();
  for (const source of deps.sources) {
    for (const item of await deps.notifications.unresolvedBySource(source)) {
      if (isNousFirstCard(item) || isNousApproval(item)) byOwner.set(item.ownerUserId, [...(byOwner.get(item.ownerUserId) ?? []), item]);
    }
  }
  let resolved = 0;
  let released = 0;
  let rewoken = 0;
  for (const [owner, items] of byOwner) {
    const open = await deps.openItemIds(owner).catch(() => null);
    let holds: boolean | null = null;
    let covers: boolean | null = null;
    // Item 35: with the rail unreadable nothing is resolved or released for a missing item; a covered approval needs no rail item and is still held (brief 20261103).
    for (const item of open ? items : items.filter(isNousApproval)) {
      // A Mail NEEDS_USER card has no rail item: the Mail service resolves it when the operator settles the thread; here only its pane and hour count.
      const itemId = isCopilotQuestion(item) ? copilotQuestionItemId(item) : null;
      if ((itemId && open && !open.has(itemId)) || (item.paneId && !(await deps.paneOpen(item.paneId)))) {
        const since = deps.missingSince.get(item.id) ?? now();
        deps.missingSince.set(item.id, since);
        if (now() - since >= NOUS_QUESTION_GONE_MS) {
          deps.missingSince.delete(item.id);
          if (await deps.notifications.setStatus(owner, item.id, "RESOLVED")) resolved += 1;
        }
        // Neither resolved nor released while it may be answered: the next minutes tell.
        continue;
      }
      deps.missingSince.delete(item.id);
      // Operator 2/11 15:08 BKK: a covered approval not yet held under the allowance (held before the rule, or already released to the
      // operator) becomes Nous's now: it leaves Needs you, and Nous is woken for it.
      if (isNousApproval(item) && !heldUnderAllowance(item) && item.severity !== "URGENT") {
        covers ??= await deps.covers?.(owner).catch(() => false) ?? false;
        if (covers && await deps.notifications.addPayload(owner, item.id, { heldForNous: { until: new Date(now() + NOUS_APPROVAL_REWAKE_MS).toISOString(), allowance: NOUS_APPROVAL_ALLOWANCE } })) {
          await deps.rewake?.(item);
          rewoken += 1;
          continue;
        }
      }
      if (!item.payload.heldForNous) continue;
      // R16-8: a card Nous put on its own card is answered there: it ends when Nous's card is answered or resolved, never released beside it.
      const card = (item.payload.heldForNous as { card?: unknown }).card;
      if (typeof card === "string") {
        const nous = await deps.notifications.get(owner, card).catch(() => undefined);
        if (nous !== undefined && (!nous || nous.status === "ACKED" || nous.status === "RESOLVED") && await deps.notifications.setStatus(owner, item.id, "RESOLVED")) resolved += 1;
        continue;
      }
      // R10-13 (28/10 22:13 BKK, operator «δεν καταλαβαινω τι θες απο εμενα?»: Freelance notes addressed to Nous reached Needs you while a
      // Nous brief had answered them): the brief the copilot took after the card answers it, so it never reaches the operator.
      if (item.kind === "NEEDS_USER" && deps.answeredByNousBrief && await deps.answeredByNousBrief(item).catch(() => false)) {
        if (await deps.notifications.setStatus(owner, item.id, "RESOLVED")) resolved += 1;
        continue;
      }
      // Operator 2/11 15:08 BKK: an approval held under "May send" stays Nous's while Nous and the allowance are on: its hour ending wakes
      // Nous again and holds it another hour, never the operator; with either off it goes to the operator the usual way (released below).
      const hold = item.payload.heldForNous as { until?: unknown; hourEnded?: unknown; allowance?: unknown };
      if (heldUnderAllowance(item)) {
        covers ??= await deps.covers?.(owner).catch(() => false) ?? false;
        if (covers && Date.parse(String(hold.until ?? "")) > now()) continue;
        if (covers && await deps.notifications.addPayload(owner, item.id, { heldForNous: { ...hold, until: new Date(now() + NOUS_APPROVAL_REWAKE_MS).toISOString() } })) {
          await deps.rewake?.(item);
          rewoken += 1;
          continue;
        }
        if (!covers && await deps.notifications.releaseHeldForNous(owner, item.id)) released += 1;
        continue;
      }
      holds ??= await deps.holds(owner).catch(() => false);
      if (holds && heldForNous(item, now())) continue;
      // Step 1: an hour that ran out before Nous saw the card in two turns holds it a little longer and wakes Nous again instead
      // (`hourEnded` keeps when its hour ran out, for the NOUS_QUESTION_REWAKE_MS bound).
      const hourEnded = String(hold.hourEnded ?? hold.until ?? "");
      if (holds && deps.shown && deps.rewake && deps.shown(owner, item.id) < NOUS_QUESTION_MIN_WAKES && now() - Date.parse(hourEnded) < NOUS_QUESTION_REWAKE_MS
        && await deps.notifications.addPayload(owner, item.id, { heldForNous: { ...hold, hourEnded, until: new Date(now() + NOUS_QUESTION_REWAKE_STEP_MS).toISOString() } })) {
        await deps.rewake(item);
        rewoken += 1;
        continue;
      }
      if (await deps.notifications.releaseHeldForNous(owner, item.id)) released += 1;
    }
  }
  return { resolved, released, ...(rewoken ? { rewoken } : {}) };
}
