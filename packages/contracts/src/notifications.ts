import { z } from "zod";
import type { UiLanguage } from "./ui-language.js";

/**
 * Space notifications: one record per thing a pane or service wants the operator to see, owned by a user,
 * delivered through the channels the user turned on (in-app badges and toasts, sound, browser desktop
 * notifications, Telegram) and kept in the Notification Center until read or acknowledged.
 */
export const NOTIFICATION_SOURCES = ["MAIL_COPILOT", "JOB_COPILOT", "MARKETING_COPILOT", "FREELANCE_COPILOT", "DESIGN", "APP_STUDIO", "VIDEO", "SECURITY_COPILOT", "MONITORING_COPILOT", "ROOM_AGENT", "COUNCIL", "NOUS", "BROWSER_HANDOFF", "ROOM_WATCHDOG", "SYSTEM", "AGENT"] as const;
export const notificationSourceSchema = z.enum(NOTIFICATION_SOURCES);
export type NotificationSource = z.infer<typeof notificationSourceSchema>;
/**
 * What only the operator's own hands can do: a CAPTCHA or browser handoff, a sign-in, a copilot's NEEDS_USER click. It reaches
 * them at once in the app, on the desktop and on Telegram and never waits for Nous (operator rule 2026-10-17, plan clipboard:xEQOrVRQgeAn).
 */
export const needsOperatorHands = (source: NotificationSource, kind: string) => source === "BROWSER_HANDOFF" || /SIGN_IN|LOGIN|CAPTCHA|HANDOFF|NEEDS_USER|NEEDS_YOU/i.test(kind);
export const NOTIFICATION_SOURCE_LABELS: Record<NotificationSource, string> = {
  MAIL_COPILOT: "Mail Copilot", JOB_COPILOT: "Job Copilot", MARKETING_COPILOT: "Marketing Copilot", FREELANCE_COPILOT: "Freelance Copilot", DESIGN: "Design", APP_STUDIO: "App Studio", VIDEO: "Video", SECURITY_COPILOT: "Security Copilot", MONITORING_COPILOT: "Monitoring Copilot", ROOM_AGENT: "Room Agent", COUNCIL: "Council", NOUS: "Nous", BROWSER_HANDOFF: "Browser", ROOM_WATCHDOG: "Room watchdog", SYSTEM: "Space", AGENT: "Agent"
};
/**
 * Needs you (operator request 2026-10-24): a notification on a pane whose kind needs the operator there (hands, a question, a review or
 * approval, a CLI prompt waiting for them, a CLI's explicit needs-you, Nous's card). The web brings them to the pane for it instead of
 * showing a toast, and takes them back when it resolves. Never INFO; failures, "posts due" and finished work stay toasts.
 */
export const NEEDS_YOU_KINDS = /^(NEEDS_HANDS|NEEDS_YOU|NEEDS_USER|QUESTION|REVIEW_REQUESTED|RULE_PROPOSED|CAMPAIGN_PROPOSED|CAMPAIGN_REVIEW|CLIENT_READY|HANDOFF_REQUESTED|BROWSER_HANDOFF_REQUESTED|WAITING|SIGN_IN|STUCK|USAGE_LIMIT|OVERLAP|(?:DESIGN|VIDEO)_(?:APPROVAL|QUESTION)|APP_STUDIO_QUESTION|SECURITY_(?:QUESTION|REVIEW)|MONITORING_(?:QUESTION|REVIEW))$/;
export const needsYou = (notification: { source: NotificationSource; kind: string; severity: NotificationSeverity; paneId: string | null; roomId: string | null }) =>
  Boolean(notification.paneId && notification.roomId) && notification.severity !== "INFO" && NEEDS_YOU_KINDS.test(notification.kind);

/** The copilots whose questions go to Nous first and are swept once answered (Ask Last step 7, 2026-10-27). */
export const COPILOT_QUESTION_SOURCES: readonly NotificationSource[] = ["JOB_COPILOT", "MAIL_COPILOT", "MARKETING_COPILOT", "FREELANCE_COPILOT", "DESIGN", "APP_STUDIO",
  "VIDEO", "SECURITY_COPILOT", "MONITORING_COPILOT"];
/** A copilot's question to the operator: its source, and a QUESTION kind or a `…:question:<id>` dedupe key. */
export const isCopilotQuestion = (notification: { source: NotificationSource; kind: string; dedupeKey: string | null }) =>
  COPILOT_QUESTION_SOURCES.includes(notification.source) && (/QUESTION/i.test(notification.kind) || /:question:/i.test(notification.dedupeKey ?? ""));
/**
 * What "Copilot questions go to Nous first" holds for Nous: a copilot's question, since queue item 32 (28/10 09:03 BKK: five cards the
 * operator dismissed within 11 s) a Mail Copilot NEEDS_USER card, and since 2/11 (operator 10:16 BKK «κλεισε οτι μπορεις να κανεις εσυ --
 * και αφησε μονο οτι πραγματικα θες απο εμας!!»: ~32 Needs you cards, about 15 his) every copilot's NEEDS_USER and every agent's needs-you:
 * Nous does it, hands it to an agent, closes it, or puts it on its own card for the operator. Sign-in, CAPTCHA and handoff kinds are never
 * held (other sources); Nous's own cards are not either.
 */
export const isNousFirstCard = (notification: { source: NotificationSource; kind: string; dedupeKey: string | null }) =>
  isCopilotQuestion(notification) || (COPILOT_QUESTION_SOURCES.includes(notification.source) && notification.kind === "NEEDS_USER")
  || (notification.source === "AGENT" && notification.kind === "NEEDS_YOU")
  || (NOUS_FIRST_REVIEWS.has(notification.source) && notification.kind === "REVIEW_REQUESTED");
/** The sources whose cards may be held for Nous (isNousFirstCard): the copilots and the agents' needs-you. */
export const NOUS_FIRST_SOURCES: readonly NotificationSource[] = [...COPILOT_QUESTION_SOURCES, "AGENT"];

/**
 * 2/11 (operator: two Mail Copilot cards for the same Google Cloud billing account): a needs-you card about what an open one of the same
 * source, kind and pane is about refreshes that one. The same mail thread or page, a shared account-like id or host, or most of the
 * shorter text's words in the other. Copilot questions and reviews are never merged (each is its own item).
 */
export const NEEDS_YOU_TOPIC_KINDS = /^(?:NEEDS_USER|NEEDS_YOU)$/;
// Mail providers' hosts name no topic (nearly every mail matches one).
const TOPIC_HOST_SKIP = /^(?:gmail|googlemail|google|outlook|hotmail|live|yahoo|icloud|proton|protonmail)\.[a-z.]+$/;
function topicOf(card: { title: string; body: string }) {
  const text = `${card.title}\n${card.body}`.slice(0, 2_000);
  const ids = (text.match(/\b(?=[A-Za-z0-9-]*\d)(?=[A-Za-z0-9-]*[A-Za-z])[A-Za-z0-9][A-Za-z0-9-]{7,}\b|\b\d{9,}\b/g) ?? []).map((id) => id.toLowerCase());
  const hosts = (text.toLowerCase().match(/\b(?:[a-z0-9-]+\.)+[a-z]{2,24}\b/g) ?? []).filter((host) => !TOPIC_HOST_SKIP.test(host.replace(/^www\./, "")));
  // The body's words (a copilot's card titles are all "<Copilot> needs you (<pane>)"), the title's when there is no body.
  const words = new Set(((card.body || card.title).slice(0, 2_000).toLowerCase().match(/[\p{L}\p{N}]{4,}/gu) ?? []));
  return { keys: new Set([...ids, ...hosts]), words };
}
export function sameNeedsYouTopic(left: { source: NotificationSource; kind: string; paneId: string | null; title: string; body: string; link?: { target?: string | null } },
  right: typeof left): boolean {
  if (left.source !== right.source || left.kind !== right.kind || left.paneId !== right.paneId || !NEEDS_YOU_TOPIC_KINDS.test(left.kind)) return false;
  const target = left.link?.target;
  if (target && target === right.link?.target && /^(?:thread|url):/.test(target)) return true;
  const [a, b] = [topicOf(left), topicOf(right)];
  if ([...a.keys].some((key) => b.keys.has(key))) return true;
  const [small, large] = a.words.size <= b.words.size ? [a.words, b.words] : [b.words, a.words];
  return small.size >= 4 && [...small].filter((word) => large.has(word)).length / small.size >= 0.6;
}
/** R24-2 (operator 1/11 11:50 BKK: «σου εχω ζητησει παρα πολλες φορές να κανεις εσυ τις αποδοχες»): these reviews are Nous's to approve first. */
const NOUS_FIRST_REVIEWS = new Set<NotificationSource>(["MARKETING_COPILOT", "FREELANCE_COPILOT"]);
/** The question's item id: the card's ask target, else the dedupe key's last `prefix:id` (job-apply:question:jobq:x → jobq:x). */
export function copilotQuestionItemId(notification: { dedupeKey: string | null; payload: Record<string, unknown> }): string | null {
  const answer = (notification.payload.ask as { answer?: { questionId?: unknown } } | undefined)?.answer;
  if (typeof answer?.questionId === "string") return answer.questionId;
  const parts = notification.dedupeKey?.split(":") ?? [];
  return parts.length >= 2 ? parts.slice(-2).join(":") : null;
}
/**
 * Operator 2/11 15:08 BKK («να μην φτανει σε εμενα το aprove και να το κανεις παντα ΕΣΥ ΑΠΟ ΤΗΝ ΣΤΙΓΜΉ ΠΟΥ ΕΙΝΣΑΙ ενεργοποιημενο!! αλλιως φυσικα να
 * ζηταει απο εμενα aprove»): the approvals "May send to third parties" covers: a Mail, Marketing, Freelance or Job review and a Mail campaign.
 * While Nous is on with that allowance, such a card is Nous's alone (`heldForNous.allowance`, no time limit): it reaches the operator only when
 * the allowance or Nous is turned off. Every surface reads this one predicate (the notification hold, the panes' "Nous reviewing").
 */
export const isNousApproval = (notification: { source: NotificationSource; kind: string }) =>
  (notification.kind === "REVIEW_REQUESTED" && NOUS_APPROVAL_SOURCES.has(notification.source))
  || (notification.source === "MAIL_COPILOT" && (notification.kind === "CAMPAIGN_REVIEW"
    // Operator 3/11 18:28 BKK («κανε το εσυ μην μου ερχονται τετοια Needs you!!!»): resuming a paused campaign is "May send"'s too.
    || notification.kind === "CAMPAIGN_PAUSED"));
const NOUS_APPROVAL_SOURCES = new Set<NotificationSource>(["MAIL_COPILOT", "MARKETING_COPILOT", "FREELANCE_COPILOT", "JOB_COPILOT"]);
/** The allowance a card is held for Nous under (`payload.heldForNous.allowance`, isNousApproval), or null for an hour's hold. */
export const heldUnderAllowance = (notification: { payload: Record<string, unknown> }): string | null => {
  const allowance = (notification.payload.heldForNous as { allowance?: unknown } | undefined)?.allowance;
  return typeof allowance === "string" ? allowance : null;
};
/**
 * Held for Nous until this time (`payload.heldForNous.until`), or for as long as the allowance it is held under is on: out of Needs you, the
 * banner, Telegram, push, the desktop pop-up and the pending counts (pane dots, rooms' "Needs attention").
 */
export function heldForNous(notification: { payload: Record<string, unknown> }, at = Date.now()): boolean {
  if (heldUnderAllowance(notification)) return true;
  const until = (notification.payload.heldForNous as { until?: unknown } | undefined)?.until;
  return typeof until === "string" && Date.parse(until) > at;
}

export const notificationSeveritySchema = z.enum(["INFO", "ATTENTION", "URGENT"]);
export type NotificationSeverity = z.infer<typeof notificationSeveritySchema>;
export const notificationStatusSchema = z.enum(["OPEN", "READ", "ACKED", "RESOLVED"]);
export type NotificationStatus = z.infer<typeof notificationStatusSchema>;

const isoDateTime = z.string().datetime({ offset: true });
export const notificationIdSchema = z.string().regex(/^notification:[A-Za-z0-9_-]{6,80}$/);

/** Where a click takes the operator: a room, a pane in it, a side surface, and a pane-specific target ("thread:<account>:<id>"). */
export const notificationLinkSchema = z.object({
  roomId: z.string().min(1).max(200).optional(),
  paneId: z.string().min(1).max(200).optional(),
  surface: z.string().min(1).max(60).optional(),
  target: z.string().min(1).max(500).optional()
}).strict();
export type NotificationLink = z.infer<typeof notificationLinkSchema>;
/**
 * Go to pane opens the item itself (operator 1/11 11:58 BKK «πρέπει πάντα να βλέπω ακριβώς την σελίδα ή το εμαιλ»): a needs-you producer
 * names it as the link's target, which the pane opens on Go now.
 */
export const needsYouTargetSchema = z.string().trim().max(500).regex(/^(?:browser|activity|setup|[a-z][a-z-]*:\S+)$/, "a target such as thread:<account>:<threadId> or url:https://…")
  .describe("What Go to pane opens in the pane: thread:<gmail account>:<threadId> (a Mail Copilot thread), url:https://… (that page in a browser pane: its open tab, else a new tab), "
    + "tab:<tabId> (a browser pane's tab), browser (a copilot's browser), or a copilot item: question:<id>, review:<id>, post:<id>, lead:<id>, request:<id>, campaign:<id>.");

/**
 * The mail a card is about (operator 12/11 23:19 BKK: the mail's preview inside the card, Go now opening that mail): the Mail review its target
 * or decision names, else one its items or words name (mailrev:…), and its thread target. Go opens `review:<id>` (the review and its thread) or the thread.
 */
export function needsYouMail(record: { body: string; payload: Record<string, unknown>; link?: { target?: string | null } | null }): { reviewId: string | null; account: string | null; threadId: string | null; target: string } | null {
  const target = record.link?.target ?? "";
  const thread = /^thread:([^:]+):(.+)$/.exec(target);
  const answer = (record.payload.ask as { answer?: { kind?: string; copilot?: string; item?: string; itemId?: string } } | undefined)?.answer;
  const items = Array.isArray(record.payload.items) ? record.payload.items as Array<{ ref?: unknown; text?: unknown }> : [];
  // shortcut: a card naming several reviews opens the first, until a card carries one review per item.
  const reviewId = /^review:(mailrev:[A-Za-z0-9_-]{6,80})$/.exec(target)?.[1]
    ?? (answer?.kind === "COPILOT_DECISION" && answer.copilot === "MAIL" && answer.item === "REVIEW" && /^mailrev:[A-Za-z0-9_-]{6,80}$/.test(answer.itemId ?? "") ? answer.itemId : undefined)
    ?? /\bmailrev:[A-Za-z0-9_-]{6,80}/.exec([...items.map((item) => `${String(item.ref ?? "")} ${String(item.text ?? "")}`), record.body].join("\n"))?.[0];
  if (!reviewId && !thread) return null;
  return { reviewId: reviewId ?? null, account: thread?.[1] ?? null, threadId: thread?.[2] ?? null, target: reviewId ? `review:${reviewId}` : target };
}

export const spaceNotificationSchema = z.object({
  id: notificationIdSchema,
  ownerUserId: z.string().min(1).max(200),
  roomId: z.string().min(1).max(200).nullable(),
  paneId: z.string().min(1).max(200).nullable(),
  source: notificationSourceSchema,
  /** Free kind inside the source ("MAIL_RECEIVED", "HANDOFF_REQUESTED", …). */
  kind: z.string().min(1).max(60),
  severity: notificationSeveritySchema,
  // Technical: a card's title and body (Telegram, push and the desktop pop-up take them); the whole text stays on the payload or link.
  title: z.string().min(1).max(200),
  body: z.string().max(2000),
  link: notificationLinkSchema,
  /** One open notification per key; raising the same key again refreshes it instead of adding another. */
  dedupeKey: z.string().max(200).nullable(),
  status: notificationStatusSchema,
  payload: z.record(z.string(), z.unknown()),
  createdAt: isoDateTime,
  updatedAt: isoDateTime,
  readAt: isoDateTime.nullable(),
  ackedAt: isoDateTime.nullable(),
  resolvedAt: isoDateTime.nullable()
}).strict();
export type SpaceNotification = z.infer<typeof spaceNotificationSchema>;

/**
 * Needs you as questions (operator request 2026-10-27, plan clipboard:5AQvaoSR-IZa): the ONE question a needs-you record asks, its
 * options (the recommended one marked) and where the operator's answer goes, kept in payload.ask. PANE: the pane's next prompt;
 * COPILOT_QUESTION: the copilot's own answer path; COPILOT_DECISION: approve or decline its review or rule; NOUS: Nous's message;
 * MAIL_FIX: an option acknowledges, words hand the mail to Mail Copilot's Send to AI; ACK: acknowledged only.
 */
export const needsYouAnswerKindSchema = z.enum(["PANE", "COPILOT_QUESTION", "COPILOT_DECISION", "NOUS", "MAIL_FIX", "ACK"]);
/** What answering an ask may set off (Nous Pro security review P1-2): a phone answers a NONE ask with act, any other with its signed decide. */
export const needsYouRiskSchema = z.enum(["NONE", "EXTERNAL", "DESTRUCTIVE", "RELEASE", "PAYMENT"]);
export type NeedsYouRisk = z.infer<typeof needsYouRiskSchema>;
export const needsYouAskSchema = z.object({
  question: z.string().trim().min(1).max(300),
  risk: needsYouRiskSchema.optional(),
  options: z.array(z.string().trim().min(1).max(80)).max(6).optional(),
  recommended: z.string().trim().min(1).max(80).optional(),
  /** R27-3: the answer is a one-time code (2FA, OTP): typed into the pane only, never kept on the record, in the ledger or with Nous. */
  code: z.literal(true).optional(),
  /**
   * Operator 4/11 18:42 BKK («δεν μου δινει θεση να γραφω το τηλεφωνο»: a card asked for a phone number and offered only Done / There is a
   * problem): the answer is a value the operator types (a phone, a name, an amount); the card leads with a text field and Send.
   */
  answerKind: z.literal("text").optional(),
  answer: z.object({
    kind: needsYouAnswerKindSchema,
    copilot: z.string().min(1).max(40).optional(),
    questionId: z.string().min(1).max(200).optional(),
    item: z.enum(["REVIEW", "RULE", "CAMPAIGN", "LEAD"]).optional(),
    itemId: z.string().min(1).max(200).optional(),
    account: z.string().min(1).max(320).optional(),
    threadId: z.string().min(1).max(200).optional()
  }).strict()
}).strict().refine((ask) => !ask.recommended || (ask.options ?? []).includes(ask.recommended), { message: "recommended must be one of the options", path: ["recommended"] });
export type NeedsYouAsk = z.infer<typeof needsYouAskSchema>;

/** An ask from a producer's own words, clipped to the schema's bounds (at most 6 options; a recommendation that is not an option is dropped). */
export function makeNeedsYouAsk(question: string, answer: NeedsYouAsk["answer"], options: readonly string[] = [], recommended?: string | null): NeedsYouAsk {
  const clip = (text: string, max: number) => { const value = text.replace(/\s+/g, " ").trim(); return value.length > max ? `${value.slice(0, max - 1)}…` : value; };
  const picks = [...new Set(options.map((option) => clip(option, 80)).filter(Boolean))].slice(0, 6);
  const best = recommended ? clip(recommended, 80) : "";
  return { question: clip(question, 300) || "What should happen next?", ...(picks.length ? { options: picks } : {}), ...(best && picks.includes(best) ? { recommended: best } : {}), answer };
}

/**
 * The ask's risk: its producer's own, else by where the answer goes. An acknowledgement, a word to Nous, a pane's prompt and a copilot's
 * question are NONE (a phone's answer to the last two goes to Nous, never typed, and Nous keeps its phone rule); a Security or Monitoring
 * decision changes a host (DESTRUCTIVE); every other decision or fix sends or changes something for the operator (EXTERNAL).
 */
export function needsYouAskRisk(notification: Pick<SpaceNotification, "source" | "title" | "body" | "payload">): NeedsYouRisk {
  const ask = needsYouAsk(notification);
  if (ask.risk) return ask.risk;
  if (["ACK", "NOUS", "PANE", "COPILOT_QUESTION"].includes(ask.answer.kind)) return "NONE";
  return ask.answer.kind === "COPILOT_DECISION" && (notification.source === "SECURITY_COPILOT" || notification.source === "MONITORING_COPILOT") ? "DESTRUCTIVE" : "EXTERNAL";
}

/** A record's ask: its payload.ask, or (older records and producers without one) the body's first line, answered through Nous. */
export function needsYouAsk(notification: Pick<SpaceNotification, "title" | "body" | "payload">): NeedsYouAsk {
  const parsed = needsYouAskSchema.safeParse(notification.payload.ask);
  if (parsed.success) return parsed.data;
  const first = notification.body.split("\n").map((line) => line.trim()).find(Boolean) ?? notification.title;
  return { question: first.length > 300 ? `${first.slice(0, 299)}…` : first, answer: { kind: "NOUS" } };
}

/**
 * Operator 2/11 13:15 BKK («το go to pane παει στο cli … πρεπει να με πηγαινει στο broswer στην σελιδα που ειναι συμπληρωμενα τα παντα»): a card a
 * CLI pane raised about a page names the browser pane holding it; Go now and Go to pane open that pane at that tab, never the CLI. The link
 * keeps the asking pane (dedupe, answers, Needs you).
 */
export const needsYouBrowserPageSchema = z.object({ roomId: z.string().min(1).max(200), paneId: z.string().min(1).max(200), target: needsYouTargetSchema.optional() });
export type NeedsYouBrowserPage = z.infer<typeof needsYouBrowserPageSchema>;
export function needsYouBrowserPage(notification: Pick<SpaceNotification, "payload">): NeedsYouBrowserPage | null {
  const parsed = needsYouBrowserPageSchema.safeParse(notification.payload?.browserPage);
  return parsed.success ? parsed.data : null;
}

// Panes whose own screen is where the operator's hands work happens (a browser, a copilot's browser, a VM).
const HANDS_PANE_MODES = new Set(["BROWSER", "YOUTUBE", "JOB_APPLY", "MARKETING_COPILOT", "FREELANCE_COPILOT", "VNC"]);
/**
 * Operator 3/11 19:25 BKK («δεν πρεπει να γινεται focus και αλλαγη οθονης στο χειριστη χωρις εγω να το εχω επιλεξει να παω»; a phone-only update
 * card on Cleo/Iris opened a browser): whether Space holds what a needs-you card asks for, so Go has somewhere to take the operator. A card
 * with a target or a browser page does, a copilot's or a browser's own card does, a card on a browser or VM pane does; an agent's or Nous's
 * card on any other pane with no target (steps on a phone, at a desk) does not: it is answered from the card, and offers no Go. The pane's
 * mode is the caller's, else the one the server stamped when it raised the card (`payload.paneMode`); a card with neither keeps its Go.
 */
export function needsYouHasPlace(notification: Pick<SpaceNotification, "source" | "link" | "payload">, paneMode?: string | null): boolean {
  if (notification.link?.target || needsYouBrowserPage(notification)) return true;
  if (notification.source !== "NOUS" && notification.source !== "AGENT") return true;
  const mode = paneMode ?? (typeof notification.payload?.paneMode === "string" ? notification.payload.paneMode : null);
  return mode === null || HANDS_PANE_MODES.has(mode);
}
/**
 * What a card with nowhere to go offers in place of its default Go now / Failed / Need links/steps (operator 3/11 19:30 BKK «αυτο επρεπε απλα να
 * μου ερχεται με needs you και να δινω feedback οτι το εκανα και ολα καλα»): sent as his words, they reach Nous (or the asking pane) and close it.
 */
export const NEEDS_YOU_DONE_ANSWERS = ["Done, all good", "There is a problem"] as const;

/** The header the web folds "What Nous checked" on (Nous's cards, pane-notices.ts); a translation keeps it as it is. */
export const NEEDS_YOU_CHECKED_HEADER = "\n\nChecked first:\n";
/**
 * Operator 1/11 23:09 BKK «needs you να ειναι στην γλώσσα που εχω ορισει»: a needs-you card's texts in the order the server translates them
 * (title, body before the checked block, the checked block, question, options); `from` names exactly that text.
 */
export function needsYouCardTexts(record: Pick<SpaceNotification, "title" | "body" | "payload">): { texts: string[]; from: string } {
  const ask = needsYouAsk(record);
  const split = record.body.lastIndexOf(NEEDS_YOU_CHECKED_HEADER);
  const texts = [record.title, split < 0 ? record.body : record.body.slice(0, split), split < 0 ? "" : record.body.slice(split + NEEDS_YOU_CHECKED_HEADER.length),
    ask.question, ...(ask.options ?? [])];
  return { texts, from: JSON.stringify(texts) };
}
/** `payload.translated`: the card in the operator's language; the record's own text is the original. */
/** `version`: the translator that made it (none: before 1/11 21:00 UTC); the server makes an older one again once. */
export interface NeedsYouTranslation { language: UiLanguage; from: string; title: string; body: string; question: string; options: string[]; version?: number }
/** The card's translation into `language`, only while it is the translation of the card's current text. */
export function needsYouTranslation(record: Pick<SpaceNotification, "title" | "body" | "payload">, language: UiLanguage): NeedsYouTranslation | null {
  const translated = record.payload.translated as Partial<NeedsYouTranslation> | undefined;
  return translated?.language === language && translated.from === needsYouCardTexts(record).from && typeof translated.title === "string"
    && typeof translated.body === "string" && typeof translated.question === "string" && Array.isArray(translated.options) ? translated as NeedsYouTranslation : null;
}

/**
 * Goal 7365014c-d: what "Always answer like this" stores for a needs-you card, or null when it may not: no recommended option, or a
 * handoff, sign-in, CAPTCHA or other hands item. The kind holds the source, the record kind, the question's shape (numbers as #), the
 * options and the recommended option itself, so a later card with the same question but another recommendation is never answered for them.
 */
export function needsYouAnswerKind(record: Pick<SpaceNotification, "source" | "kind" | "title" | "body" | "payload">): { key: string; label: string } | null {
  const ask = needsYouAsk(record);
  // R37-2: "Go now" is the operator going to the pane; no standing answer can go for them.
  if (!ask.recommended || ask.recommended === NEEDS_YOU_GO_NOW || record.source === "BROWSER_HANDOFF" || /SIGN_IN|LOGIN|CAPTCHA|HANDOFF|NEEDS_USER|NEEDS_HANDS/i.test(record.kind)) return null;
  // R15-2: a copilot review recommends only when vouched (R12-4), so its kind is the rail and the decision, never the review's own words.
  if (ask.answer.kind === "COPILOT_DECISION" && ask.answer.item === "REVIEW") {
    return { key: `needs-you:${record.source}:REVIEW:${ask.recommended}`, label: `answer "${ask.recommended}" on every vouched ${NOTIFICATION_SOURCE_LABELS[record.source]} review` };
  }
  const shape = ask.question.toLowerCase().replace(/\d+/g, "#").replace(/\s+/g, " ").trim();
  return { key: `needs-you:${record.source}:${record.kind}:${shape}:${(ask.options ?? []).join("|")}:${ask.recommended}`.slice(0, 2_000),
    label: `answer "${ask.recommended}" when ${record.source.toLowerCase().replace(/_/g, " ")} asks "${ask.question.slice(0, 160)}"` };
}

/** R27-2: the answer a Nous hands card recommends: the operator goes to the pane now, to the page it names (the card stays for the visit). */
export const NEEDS_YOU_GO_NOW = "Go now";

/** The end of an agent's needs-you question past 300 characters (the card's question); its whole ask is in the card's body. */
export const NEEDS_YOU_QUESTION_MORE = " … (the whole ask is under Details)";

/** R23-3 (operator «Θέλω να τα δω όλα αυτά»: icon and video options asked by id): the artifact ids a needs-you text names, each once, in order. */
export const artifactIdsIn = (text: string): string[] => [...new Set(text.match(/\bartifact:[A-Za-z0-9_-]{6,120}/g) ?? [])];

/**
 * R16-3 (operator rule 29/10 16:25 BKK, three «Now, one by one» answers in a day): an ask whose options are about WHEN to hand something
 * over (now against later, tomorrow, a batch); its «now» option, which Space answers with by day.
 */
export function needsYouTimingNow(record: Pick<SpaceNotification, "title" | "body" | "payload">): string | null {
  const options = needsYouAsk(record).options ?? [];
  const now = options.find((option) => /^\s*(?:right )?(?:now|τώρα)(?![a-z])/i.test(option));
  return now && options.some((option) => option !== now && /\b(?:later|tomorrow|batch|together)\b|all at once|αύριο|αργότερα|μετά|μαζί/i.test(option)) ? now : null;
}

/** The operator's answer to a needs-you record (POST /api/notifications/:id/answer): one of its options, words, or both. */
export const notificationAnswerInputSchema = z.object({
  option: z.string().trim().min(1).max(80).optional(),
  text: z.string().trim().min(1).max(2000).optional(),
  /** "Always answer like this": with the recommended option, the next card of this kind is answered with it (needsYouAnswerKind). */
  always: z.boolean().optional()
}).strict().refine((input) => input.option || input.text, { message: "Pick an option or write an answer." });
export type NotificationAnswerInput = z.infer<typeof notificationAnswerInputSchema>;
export const notificationAnswerResultSchema = z.object({ routed: needsYouAnswerKindSchema, display: z.string(), notification: spaceNotificationSchema.nullable() }).strict();
export type NotificationAnswerResult = z.infer<typeof notificationAnswerResultSchema>;

/** Technical: a card's body holds 2,000 characters (the stored column, Telegram and push); a longer text keeps its start and says the
 *  rest is in its source (the pane, copilot or record the card opens), so no producer cuts silently (plan clipboard:xCBrZwhCTzmC step 4). */
export const NOTIFICATION_BODY_MORE = "\n… (more in its source: open this card)";
const wholeOrMarkedBody = (value: unknown) => typeof value === "string" && value.length > 2000
  ? `${value.slice(0, 2000 - NOTIFICATION_BODY_MORE.length)}${NOTIFICATION_BODY_MORE}` : value ?? "";
/** Technical: a card's title is one line of 200 characters; a longer one ends with "…" (its body and source carry the rest). */
const lineOrMarkedTitle = (value: unknown) => typeof value === "string" && value.trim().length > 200 ? `${value.trim().slice(0, 199)}…` : value;
export const notificationRaiseInputSchema = z.object({
  ownerUserId: z.string().min(1).max(200),
  roomId: z.string().min(1).max(200).nullable().default(null),
  paneId: z.string().min(1).max(200).nullable().default(null),
  source: notificationSourceSchema,
  kind: z.string().min(1).max(60),
  severity: notificationSeveritySchema.default("INFO"),
  title: z.preprocess(lineOrMarkedTitle, z.string().trim().min(1).max(200)),
  body: z.preprocess(wholeOrMarkedBody, z.string().max(2000)),
  link: notificationLinkSchema.default({}),
  dedupeKey: z.string().max(200).nullable().default(null),
  payload: z.record(z.string(), z.unknown()).default({}),
  /** Producer override for Telegram (a pane setting); null follows the user's channel settings. */
  telegram: z.boolean().nullable().default(null)
}).strict();
export type NotificationRaiseInput = z.infer<typeof notificationRaiseInputSchema>;

/** What the shared event stream carries: ids only, never title or body, because every signed-in user receives every event. */
export const notificationStreamPayloadSchema = z.object({
  notificationId: notificationIdSchema,
  ownerUserId: z.string().min(1).max(200),
  source: notificationSourceSchema,
  kind: z.string().min(1).max(60),
  severity: notificationSeveritySchema,
  status: notificationStatusSchema,
  roomId: z.string().min(1).max(200).nullable(),
  paneId: z.string().min(1).max(200).nullable()
}).strict();
export type NotificationStreamPayload = z.infer<typeof notificationStreamPayloadSchema>;

export const notificationsPendingSchema = z.object({
  total: z.number().int().min(0),
  bySource: z.record(z.string(), z.number().int().min(0)),
  byRoom: z.record(z.string(), z.number().int().min(0)),
  byPane: z.record(z.string(), z.number().int().min(0)),
  latest: z.array(spaceNotificationSchema).max(50)
}).strict();
export type NotificationsPending = z.infer<typeof notificationsPendingSchema>;

/** A completed operator request, written by Nous and acknowledged in the Done tab. */
export const requestDonePayloadSchema = z.object({
  request: z.string().trim().min(1).max(300),
  summary: z.string().trim().min(1).max(600),
  planId: z.string().max(160).regex(/^clipboard:[A-Za-z0-9_-]+$/).optional(),
  tickets: z.array(z.string().regex(/^q-\d{8}-\d{6}-[0-9a-f]{4}$/)).max(20).optional(),
  where: z.enum(["stable", "dev", "no code"]),
  /** What Nous checked on the surface the operator uses and what it showed (31/10: "done" claimed three times without it). */
  verified: z.string().trim().min(10).max(300).optional()
}).strict();
export type RequestDonePayload = z.infer<typeof requestDonePayloadSchema>;

/**
 * Nous › Updates (operator 4/11 15:04 BKK, R73): what the operator must know, newest first: a program approved or rejected (written by the
 * programs registry itself) and other developments Nous posts with space_operator_update. The card shows title and body; `report` (the full
 * report, in the operator's agent language) and `links` open only when he selects the entry.
 */
export const OPERATOR_UPDATE_KIND = "OPERATOR_UPDATE";
export const operatorUpdateLinkSchema = z.object({
  label: z.string().trim().min(1).max(200),
  url: z.string().trim().url().max(2_000).refine((value) => /^https?:\/\//i.test(value), "Only http(s) links")
});
export const operatorUpdatePayloadSchema = z.object({
  report: z.string().trim().min(1).max(20_000),
  links: z.array(operatorUpdateLinkSchema).max(50).default([]),
  programId: z.string().min(1).max(200).optional()
});
export type OperatorUpdatePayload = z.infer<typeof operatorUpdatePayloadSchema>;

export const notificationListQuerySchema = z.object({
  /** NEEDS_YOU: the needs-you requests still waiting (open or read, not resolved or acknowledged) on panes that are still open. */
  /** WAITING: open or read (not resolved or acknowledged), any kind: what still waits, read whole instead of "the newest 200 of every status". */
  status: z.enum(["OPEN", "ALL", "NEEDS_YOU", "WAITING"]).default("ALL"),
  source: notificationSourceSchema.optional(),
  kind: z.string().min(1).max(60).optional(),
  dedupeKey: z.string().min(1).max(200).optional(),
  paneId: z.string().min(1).max(200).optional(),
  limit: z.number().int().min(1).max(200).default(50),
  before: isoDateTime.optional()
}).strict();
export type NotificationListQuery = z.infer<typeof notificationListQuerySchema>;

/** The user's channel settings; a source may turn its own delivery down further. */
export const notificationChannelOverridesSchema = z.object({
  inApp: z.boolean().optional(),
  desktop: z.boolean().optional(),
  telegram: z.boolean().optional(),
  push: z.boolean().optional()
}).strict();
const clockTimeSchema = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/, "Use HH:MM (24 hours).");
export const quietHoursSchema = z.object({ enabled: z.boolean().default(true), start: clockTimeSchema.default("23:00"), end: clockTimeSchema.default("09:00") }).strict();
export type QuietHours = z.infer<typeof quietHoursSchema>;
export const defaultQuietHours: QuietHours = { enabled: true, start: "23:00", end: "09:00" };
/** Appointment reminders (operator 2/11 15:22 BKK): minutes before every appointment; one in quiet hours goes just before they start. */
export const DEFAULT_APPOINTMENT_REMINDER_MINUTES = [1440, 180, 60];
export const appointmentRemindersSchema = z.object({
  enabled: z.boolean().default(true),
  leadMinutes: z.array(z.number().int().min(1).max(60 * 24 * 30)).default(DEFAULT_APPOINTMENT_REMINDER_MINUTES)
}).strict();
export type AppointmentReminders = z.infer<typeof appointmentRemindersSchema>;
/** A hand request: only the operator's hands can do it (a handoff, sign-in, CAPTCHA, needs-you, or Nous's per-pane card). */
export const isHandRequest = (source: NotificationSource, kind: string) => needsOperatorHands(source, kind) || (source === "NOUS" && kind === "NEEDS_HANDS");
export const notificationSettingsSchema = z.object({
  channels: z.object({
    /** Badges and the Notification Center. Off keeps the record but shows no badge. */
    inApp: z.boolean().default(true),
    toast: z.boolean().default(true),
    sound: z.boolean().default(true),
    /** Browser desktop notifications while Space is in the background (needs the browser's permission). */
    desktop: z.boolean().default(true),
    /** Telegram through the paired bot, for ATTENTION and URGENT notifications. */
    telegram: z.boolean().default(true),
    /** Push (FCM) to the user's registered Android devices, for ATTENTION and URGENT notifications, also with the app closed. */
    push: z.boolean().default(true)
  }).strict().default({ inApp: true, toast: true, sound: true, desktop: true, telegram: true, push: true }),
  perSource: z.partialRecord(notificationSourceSchema, notificationChannelOverridesSchema).default({}),
  /**
   * The operator's night (operator request 2026-10-20, plan clipboard:9XSwTPyxXP1W), in their working time zone: what needs their hands
   * (handoffs, sign-ins, CAPTCHAs, needs-you, Nous's cards) is recorded without alerts and comes as one morning batch. URGENT never waits.
   */
  quietHours: quietHoursSchema.default(defaultQuietHours),
  appointmentReminders: appointmentRemindersSchema.default({ enabled: true, leadMinutes: DEFAULT_APPOINTMENT_REMINDER_MINUTES })
}).strict();
export type NotificationSettings = z.infer<typeof notificationSettingsSchema>;
export const defaultNotificationSettings: NotificationSettings = notificationSettingsSchema.parse({});

export function resolveNotificationSettings(settings: NotificationSettings | null | undefined): NotificationSettings {
  return settings ? notificationSettingsSchema.parse(settings) : defaultNotificationSettings;
}

/** Whether one channel is on for a notification: the channel switch, then the source's own override. */
export function notificationChannelEnabled(settings: NotificationSettings, source: NotificationSource, channel: "inApp" | "desktop" | "telegram" | "push"): boolean {
  const override = settings.perSource[source]?.[channel];
  return override ?? settings.channels[channel];
}

/** An Android device of the user that receives Space notifications as FCM pushes (registered by the app's page). */
export const pushDeviceTokenSchema = z.string().regex(/^[A-Za-z0-9:_.-]{20,4096}$/);
/**
 * N2/R6 (operator 3/11): what reaches one phone. HANDS: what only the operator's hands can do and URGENT; NOUS (every device's default):
 * also what is not held for Nous and what Nous leaves to the operator; ALL: also the ATTENTION held for Nous. Quiet hours hold every level.
 */
export const pushLevelSchema = z.enum(["HANDS", "NOUS", "ALL"]);
export type PushLevel = z.infer<typeof pushLevelSchema>;
export const pushDeviceRegistrationSchema = z.object({
  token: pushDeviceTokenSchema,
  platform: z.literal("ANDROID").default("ANDROID"),
  appVersion: z.string().trim().min(1).max(40).nullable().default(null),
  // Left out (older apps, the web), the device keeps its level.
  level: pushLevelSchema.optional()
}).strict();
export type PushDeviceRegistration = z.infer<typeof pushDeviceRegistrationSchema>;
export const pushDeviceRemovalSchema = z.object({ token: pushDeviceTokenSchema }).strict();
/** A push device as the user's devices list shows it: never its token, only an id derived from it. */
export const pushDeviceIdSchema = z.string().regex(/^push_device:[0-9a-f]{24}$/);
export interface PushDevice { id: string; platform: "ANDROID"; appVersion: string | null; level: PushLevel; lastSeenAt: string; isCurrent: boolean }
