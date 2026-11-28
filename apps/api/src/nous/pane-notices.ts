import { z } from "zod";
import { artifactIdsIn, heldUnderAllowance, NEEDS_YOU_COMPLETION_OPTION, NEEDS_YOU_GO_NOW, needsYouMail, needsYouTargetSchema, needsYouTimingNow, NOTIFICATION_SOURCE_LABELS, type NeedsYouAsk, type NotificationListQuery, type NotificationRaiseInput, type Pane, type Room, type SpaceNotification } from "@space/contracts";
import { isBrowserPane } from "../pane-guards.js";
import { heldForNousNote } from "./copilot-questions.js";
import type { MemoryEntryLite } from "./operator-facts.js";
import { cardTextMatched } from "./predictions.js";
import { inSlices } from "./retrieval.js";

/**
 * space_notify_operator (operator request 2026-10-17, plan clipboard:8FfXWclYUfOH): what only the operator's hands can do
 * (sign-in, password, CAPTCHA, a click bot protection blocks, a document or an answer only they have) reaches them as ONE
 * Space notification per pane, on that pane; a click takes them there. A new list for the same pane replaces the card's
 * items and alerts once more; the same list changes nothing. A card whose pane is gone is resolved.
 */
export const NOUS_PANE_NOTICE_PREFIX = "nous:pane:";
export const NOUS_GENERAL_NOTICE_KEY = "nous:general";
/** A plan's Needs you item, one per plan, with no pane (plan-needs-you.ts; operator 13/11 nous_msg:2e24947d). */
export const NOUS_PLAN_NOTICE_PREFIX = "nous:plan:";
/** A closed pane's asks no plan carries (plan-needs-you.ts `carry`, 15/11 nous_msg:9f70dbbe); contracts `needsYou` lists it without a pane. */
export const CLOSED_PANE_NOTICE_PREFIX = "nous:closed-pane:";
const nousKey = (key: string | null) => Boolean(key?.startsWith(NOUS_PANE_NOTICE_PREFIX) || key?.startsWith(NOUS_PLAN_NOTICE_PREFIX) || key === NOUS_GENERAL_NOTICE_KEY);

/** Needs you as questions (plan clipboard:5AQvaoSR-IZa): the card asks its first item's question; the operator's answer comes back to Nous. */
/** Operator rule 13/11 nous_msg:83c0acb8 supersedes R20-asks-2 (cc31fdd2): the operator gets focus at the one step only they can do, never a list. */
const stepsField = { steps: z.array(z.string().trim().min(3).max(300)).min(1).max(10).optional()
  .describe("Leave empty: a card carries no steps for the operator (operator rule 13/11 nous_msg:83c0acb8). Do every step yourself and raise the card at the one only they can do; a card with steps is refused.") };
/** nous_msg:0cb8d563: the Agent Files an item is about, shown on the card as chips that open them. */
const filesField = { files: z.array(z.string().trim().regex(/^artifact:[A-Za-z0-9_-]{6,80}$/)).min(1).max(20).optional()
  .describe("The Agent Files this item is about (artifact:<id>): the card shows each as a chip that opens it.") };
const ruleDiffers = z.string().trim().min(3).max(200).optional()
  .describe("Only when Space answered that an operator rule, a memory, its records or an open card already answers this item (R65, R66): how this case differs, or why that does not answer it (shown on the card).");
const triedStored = z.string().trim().min(3).max(200).optional()
  .describe("A sign-in item at a site where the Vault holds a login or Space signed in before (R66): the stored method the pane tried and why it failed (shown on the card).");
const askFields = {
  // 2026-11-28 REVIEW (Loom card 4e5047eb answered «ποια ειναι η Loom τι αφορά;;»): a choice names what it is about before it asks.
  about: z.string().trim().min(10).max(200).optional().describe("Required with options (not hands work): what this is, in one line for an operator who has never heard of it, "
    + "e.g. \"Loom: Atlassian's screen-recording service, billed to your Gmail since March; no Space feature uses it\". The card shows it first."),
  question: z.string().trim().min(1).max(300).optional().describe("The ONE question the operator answers from the card, in English (their answer reaches you as their message about this pane)."),
  options: z.array(z.string().trim().min(1).max(80)).min(1).max(6).optional().describe("The answers to pick from, at most 6."),
  recommended: z.string().trim().min(1).max(80).optional().describe("Your recommendation: one of the options; required whenever you give options."),
  code: z.literal(true).optional().describe("R27-3: the item asks the operator for a one-time code (2FA, OTP, SMS) that only reaches them: they type it on the card and "
    + "it goes straight into this pane's prompt; Space keeps it nowhere (not the card, the ledger, notes or your conversation). `question` says which site and where "
    + "the code arrives; no options, link or steps."),
  answerKind: z.literal("text").optional().describe("The item asks for a value only the operator has (a phone number, a name, an amount, an address): the card shows a "
    + "text field and Send, and what they type reaches you as their answer. A question without options (not sign-in or install work) is asked so by default.")
};

/**
 * Ask last (operator goal nous_goal:ee5a573e, 2026-10-27: «find the information yourself before you ask me»): every card, focus request
 * and question to the operator carries what Nous checked first; the card and the decision show it to the operator under "Checked first:".
 */
export const NOUS_ASK_LAST_RULE = "Ask last (operator goal ee5a573e, 2026-10-27): find it yourself first (Space Memory and operator facts, your own answers and notes, "
  + "pane reports and files, Vault, mail, DB, git, web, Live history) and list in `checked` (1-8 items) each source you consulted and what it showed; "
  // 23/11 REVIEW (1 of 54 asks refused for missing checked): the refusal shows the value's form, so the retry carries it.
  + "ask the operator only for their hands, taste, money or a third party's approval. "
  + "Example: \"checked\": [\"Space Memory: no entry on X\", \"mail: no reply from Y since 27/10\"].";
/** 14/11 (prediction misses x10 of 7 d, Dana's rule 6, Space Memory b78789c1): 7 predicted a plain yes and got the operator's own value or
 * scope (5), a plan id they had written an hour before (B1/B2 12/11) or a company fact Space Memory held (Turso 12/11). */
export const NOUS_PREDICT_FROM_WORDS = "Predict from the operator's own words first: a value, scope or combination they wrote on this subject (chat or a card answer) is the answer, "
  + "so act on it or predict exactly that, not a plain yes; a personal or company fact is read from Space Memory, and a guess keeps a low confidence.";
/** R12-11 (29/10: 5 of the day's 17 decisions had no prediction and could not be scored): every decision and every card question predicts. */
export const NOUS_PREDICTION_RULE = "Every decision carries a prediction (goal 7365014c criterion 3): give space_ask_operator `prediction` {answer: \"yes\", \"no\" or one "
  + "of the options word for word, or with no options the words you expect, e.g. \"yes, but by Friday\"; confidence 0-100} (or end the recommendation with \"Prediction: yes|no|option N (X %)\"), and give every card item with options "
  + "its `recommended` option. " + NOUS_PREDICT_FROM_WORDS;
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
  room: z.string().trim().min(1).max(200).optional().describe("The room's name as shown in the world (or its id); with `plan` and no pane, the plan's room by default."),
  pane: z.string().trim().min(1).max(160).optional().describe("The pane that needs the operator. Give it, or `plan` when no pane works on it (a card with neither never shows in Needs you)."),
  plan: z.string().trim().regex(/^clipboard:[A-Za-z0-9_-]{6,80}$/).optional().describe("The plan (clipboard:<id>) the card is about. Without a pane the card is that plan's "
    + "Needs you item (one per plan; it opens the plan); with a pane it ties the card to the plan, so it moves to the plan when the pane closes."),
  title: z.string().trim().min(1).max(80).describe("What waits there, in a few English words."),
  items: z.array(z.object({
    text: z.string().trim().min(1).max(200).describe("One thing only the operator can do, in English, at most 200 characters (details stay in the pane)."),
    ref: z.string().trim().min(1).max(120).optional().describe("The notification, decision or task id it comes from; a copilot question held for you goes to the operator with the card."),
    since: z.string().trim().min(3).max(200).optional().describe("What changed since the operator answered the same question (R16-2); the card shows it as \"Since then\"."),
    ruleDiffers,
    triedStored,
    target: needsYouTargetSchema.optional(),
    ...askFields,
    ...stepsField,
    ...filesField
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
  since: z.string().trim().min(3).max(200).optional().describe("What changed since the operator answered the same question (R16-2); the card shows it as \"Since then\"."),
  ruleDiffers,
  triedStored,
  target: needsYouTargetSchema.optional(),
  ...askFields,
  ...stepsField,
  ...filesField,
  checked: nousCheckedSchema
});
export const FOCUS_PANE_DESCRIPTION = "Bring the operator to a pane that needs their hands or their answer (a sign-in, CAPTCHA or browser handoff, a prompt only they "
  + "can answer): the same card as space_notify_operator with one item. Their screen offers Go now / Not now, switches room, maximizes the pane, focuses what needs "
  + "them and takes them back when the card resolves; give `target` (the mail thread, the page) so it opens exactly what needs them; resolve it with space_resolve_notification when nothing is left. Ask it as a question with options and your "
  + "recommendation: they can answer from the card without going, and the answer reaches you as their message about the pane. One open card per pane: the same reason "
  + "again changes nothing. Never for what you can answer yourself or for decisions (those go through space_ask_operator).";

export interface NousPaneNoticesDeps {
  notifications: {
    raise(input: NotificationRaiseInput, options?: { realert?: boolean }): Promise<SpaceNotification>;
    resolve(owner: string, dedupeKey: string, reason?: string): Promise<number>;
    list(owner: string, query: NotificationListQuery): Promise<SpaceNotification[]>;
    /** R16-8: a held copilot card an item names (`ref`) stays held and is answered through Nous's card. */
    get?(owner: string, id: string): Promise<SpaceNotification | null>;
    addPayload?(owner: string, id: string, payload: Record<string, unknown>): Promise<SpaceNotification | null>;
    releaseHeldForNous?(owner: string, id: string, add?: { body?: string; payload?: Record<string, unknown> }): Promise<SpaceNotification | null>;
  };
  /** R11-2 (6): the operator-rule memories, to take a card item's recommended option from the rule that answers its question. */
  operatorRules?(): Promise<Array<{ id: string; title: string; body: string }>>;
  /** R13-7: the owner's decision-ledger rows since a time, newest first (the operator's earlier answers to cards). */
  ledger?(owner: string, since: string): Promise<Array<{ source: string; title: string; answer: string; at: string; ref?: string | null; predicted?: string | null; match?: boolean | null }>>;
  now?: () => number;
  /** The owner's quiet hours now (night): a "now or later?" question waits for the morning instead of being refused. */
  quiet?(owner: string): Promise<boolean>;
  /** A sign-in card's Google account against the tab it opens (site-signin-account.ts): why no card forms, or null. */
  signinCard?(input: NotificationRaiseInput): Promise<string | null>;
  /** R23-3: whether an artifact a card names opens for the owner (not deleted, in one of their rooms): Needs you shows it. */
  artifactOpens?(owner: string, id: string): Promise<boolean>;
  /** A gone pane's open asks move to their plan's item before its card resolves (plan-needs-you.ts `carry`). */
  carry?(owner: string, paneId: string): Promise<number>;
  /** A plan's open pane (its room and pane), for a plan's card raised with no pane: Go takes the operator there (operator 13/11 15:37 BKK). */
  planPane?(owner: string, planId: string): Promise<{ roomId: string; paneId: string } | null>;
  /** 16/11 REVIEW: whether a code card's page is open near its pane (needs-you-browser-page.ts `createCodePageOpen`). */
  codePageOpen?(owner: string, pane: Pane, target: string | undefined, text: string): Promise<boolean>;
  /** 16/11 REVIEW: when the pane last reported (its newest pane report), null with none. */
  paneReportAt?(owner: string, paneId: string): Promise<string | null>;
}

/**
 * R65 (goal ee5a573e: 3/11 a Hetzner pay card asked what the operator had answered on 2/11 «Όχι ακόμα», and the DAC7 item a company fact memory held):
 * a card question's stems: accents folded, letters cut to 5 (Greek inflects: πλήρωσες, πληρώνεις), numbers whole ("129,50", "0.2.13"), 3 characters or
 * more, function words out.
 */
export const foldText = (text: string) => text.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
const CARD_STOP_WORDS = new Set(["the", "and", "for", "with", "you", "your", "this", "that", "what", "which", "from", "have", "has", "are", "was", "were", "will", "would",
  "should", "can", "could", "did", "does", "not", "now", "yet", "any", "all", "its", "our", "out", "there", "here", "then", "than", "into", "about", "answer", "operator", "my",
  "του", "της", "των", "τον", "την", "τις", "τους", "και", "για", "απο", "στο", "στη", "στην", "στα", "στον", "που", "θα", "δεν", "μην", "ειναι", "εχεις", "εχει", "μου", "σου",
  "μας", "σας", "ναι", "οχι", "αυτο", "αυτη", "ποιο", "ποια", "πως", "τωρα", "ακομα", "ηδη"]);
export function cardStems(text: string): Set<string> {
  return new Set((foldText(text).match(/[\p{L}\p{N}]+(?:[.,]\p{N}+)*/gu) ?? []).filter((word) => word.length >= 3 && !CARD_STOP_WORDS.has(word))
    .map((word) => /\p{N}/u.test(word) ? word : word.slice(0, 5)));
}
export interface CardMemoryEntry { id: string; title: string; body: string; rule: boolean; stems: Set<string> }
const cardMemoryKept = new WeakMap<MemoryEntryLite, CardMemoryEntry>();
/**
 * R65's memory for cards: each entry with its stems, kept by the entry (memoryEntries hands an unchanged block's entry back), so a memory save stems
 * its new entry only: stemming all 4,468 held the API's main thread 554 ms on every save (stable 14/11). The first build runs in slices.
 */
export async function cardMemoryEntries(entries: MemoryEntryLite[]): Promise<CardMemoryEntry[]> {
  await inSlices(entries, (entry) => cardMemoryKept.has(entry) || cardMemoryKept.set(entry, { id: entry.id, title: entry.title, body: entry.body,
    rule: entry.tags.some((tag) => /^operator-rules?$/i.test(tag)), stems: cardStems(`${entry.title} ${entry.body}`) }));
  return entries.map((entry) => cardMemoryKept.get(entry)!);
}
/** R65: how many of a card question's stems a text holds, and their share of the question's. */
export function sharedStems(question: Set<string>, text: Set<string>): { shared: number; share: number } {
  const shared = [...question].filter((stem) => text.has(stem)).length;
  return { shared, share: question.size ? shared / question.size : 0 };
}
/**
 * R65: the operator's earlier answer to the same question: a "My answer to "…"" rule (Space saves the operator's card answers so) whose quoted
 * question holds at least two of this one's stems and half of them. Only the quoted question counts: matched against a whole rule's text, short
 * questions met 5 unrelated rules in 13 (4/11 evaluation, ~/agent-workspace/active/20261104-nous-r65/eval.txt).
 */
export function answersSameQuestion(question: Set<string>, rule: { title: string }): boolean {
  const quoted = /My answer to "(.+?)":/.exec(rule.title)?.[1];
  if (!quoted) return false;
  const { shared, share } = sharedStems(question, cardStems(quoted));
  return shared >= 2 && share >= 0.5;
}
/** R65: a memory entry that holds a fact question: three of its stems at least, and 60 % of them. */
export function holdsFact(question: Set<string>, text: Set<string>): boolean {
  const { shared, share } = sharedStems(question, text);
  return shared >= 3 && share >= 0.6;
}
/** R66 (4/11: W-8BEN, DeepInfra Turnstile, Skroutz return, Sentry card and X sign-in each reached the operator on two cards): two card texts on one
 * subject by their words: two stems at least, and half of the shorter text's. */
export function sameCardSubject(left: string, right: string): boolean {
  const [a, b] = [cardStems(left), cardStems(right)];
  const { shared } = sharedStems(a, b);
  return shared >= 2 && shared / Math.min(a.size, b.size) >= 0.5;
}

/** R12-1: a decision title's words (case-folded letters and digits, at least 3 characters, common words left out). */
const TITLE_STOP_WORDS = new Set(["the", "and", "for", "with", "this", "that", "from", "into", "του", "της", "των", "και", "για", "στο", "στη", "στην", "από", "με", "να"]);
export const titleWords = (title: string) => new Set((title.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}._-]{2,}/gu) ?? []).filter((word) => !TITLE_STOP_WORDS.has(word)));

const HANDS_ITEM = /sign[- ]?in|log[- ]?in|captcha|password|passcode|2fa|\botp\b|verification code|handoff/i;
const questionShape = (question: string) => question.toLowerCase().replace(/\d+/g, "#").replace(/\s+/g, " ").trim();
/**
 * R13-7 (cards predicted 13 of 26): the option the operator picked the last 2 times Nous asked the same question (its shape: digits
 * aside), when both agree and it is one of this item's options; else (2026-10-30 REVIEW: cards 54 %) R16-9's base rate over the answers
 * to that question; null otherwise and for hands items (sign-in, CAPTCHA, handoff).
 */
export function ledgerRecommendation(item: { text: string; question?: string; options?: string[] }, rows: Array<{ source: string; title: string; answer: string; at: string }>):
  { option: string; answers: number } | null {
  if (!item.question || !item.options?.length || HANDS_ITEM.test(`${item.text} ${item.question}`)) return null;
  const shape = questionShape(item.question);
  const same = rows.filter((row) => row.source === "NEEDS_YOU:NOUS" && questionShape(row.title) === shape).sort((left, right) => right.at.localeCompare(left.at));
  const last = same.slice(0, 2).map((row) => row.answer.split(": ")[0]!.trim());
  if (last.length === 2 && last[0] === last[1] && item.options.includes(last[0]!) && !NEEDS_YOU_COMPLETION_OPTION.test(last[0]!)) return { option: last[0]!, answers: 2 };
  return baseRateRecommendation(same.map((row) => ({ source: "NEEDS_YOU:NOUS", kind: "NOUS:QUESTION", answer: row.answer })), { source: "NOUS", kind: "QUESTION", options: item.options });
}

/**
 * R16-9 (29/10: 15 of 32 card and rail answers carried no prediction): a needs-you card with options and none recommended takes the option
 * the operator chose in at least 80 % of their last answers to that kind (same source and kind, options of this card, 5 or more in 30 days).
 */
export function baseRateRecommendation(rows: Array<{ source: string; kind: string; answer: string }>, card: { source: string; kind: string; options: readonly string[] }):
  { option: string; answers: number } | null {
  // Goal 7365014c (ledger 21-26/11: 4 of the last 11 Mail flag answers were typed orders to act, «κανε οσα ζητησε η google», yet "Ignore it"
  // stayed at 100 %): every answer of the kind counts, and it agrees with the option only as the ledger scores it (cardTextMatched).
  const all = rows.filter((row) => row.source === `NEEDS_YOU:${card.source}` && row.kind === `${card.source}:${card.kind}`).map((row) => row.answer.trim());
  const answers = all.map((answer) => answer.split(": ")[0]!.trim()).filter((answer) => card.options.includes(answer));
  // 2/11 rule 4 (operator: a .gr domain flag said «Recommended "I handled it" by your last 6 answers»): a Mail Copilot flag learns from 2 answers.
  const mailFlag = card.source === "MAIL_COPILOT" && card.kind === "NEEDS_USER";
  if (answers.length < (mailFlag ? 2 : 5)) return null;
  const counts = new Map<string, number>();
  for (const answer of answers) counts.set(answer, (counts.get(answer) ?? 0) + 1);
  const [option, count] = [...counts].sort((left, right) => right[1] - left[1])[0]!;
  // Operator 16/11 21:55 BKK («δεν ειπα ποτε done»): a completion ("Done", "Signed in") is never predicted, the operator says it; the mail flag's
  // "I handled it" stays, since it routes the flag to Nous rather than closing anything (2/11 rule 4).
  if (!mailFlag && NEEDS_YOU_COMPLETION_OPTION.test(option)) return null;
  const agree = all.filter((answer) => cardTextMatched({ recommended: option, options: card.options }, answer)).length;
  return count / answers.length >= 0.8 && agree / all.length >= 0.8 ? { option, answers: all.length } : null;
}

const RULE_STOP_WORDS = new Set(["the", "and", "for", "with", "that", "this", "what", "which", "should", "would", "from", "your", "have", "will", "into", "them", "they",
  // 30/10 12:10 BKK: a Mail archive rule and a "never ask again about 1.1.9" rule answered Braintrust and Contra cards on words like these.
  "never", "again", "always", "about", "every", "done", "asks", "asked", "question", "questions", "answer", "operator", "please", "still", "there", "here",
  "then", "only", "just", "more", "some", "each", "over", "need", "needs", "must", "does", "make", "made", "daily",
  "όταν", "αυτό", "αυτή", "είναι", "πρέπει", "θέλω", "θελω", "μετά", "πριν", "ποτέ", "ξανά", "πάντα"]);
/** Status options any rule's text may hold in passing ("done"): a rule never recommends them. */
// R24-2 (31/10 X Premium: an unrelated rule recommended "Failed"): nor the options Space adds to a hands card.
const GENERIC_OPTION = /^(?:done|yes|no|ok|okay|installed|finished|completed|failed|need links|ναι|όχι|οχι|έγινε)\b/i;
const ruleWords = (text: string) => new Set((text.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}_-]{3,}/gu) ?? []).filter((word) => !RULE_STOP_WORDS.has(word)));
/**
 * R11-2 (6) (REVIEW 29/10: card predictions 12 of 25, 4 cards answered against the recommendation): the operator-rule memory that answers an
 * item's question (at least two of its words, and exactly one of the item's options named in the rule) sets its recommended option.
 */
export function ruleRecommendation(item: { question?: string; options?: string[] }, rules: Array<{ id: string; title: string; body: string }>): { option: string; rule: { id: string; title: string } } | null {
  if (!item.question || !item.options?.length) return null;
  const asked = ruleWords(item.question);
  let best: { option: string; rule: { id: string; title: string }; score: number } | null = null;
  for (const rule of rules) {
    const text = `${rule.title}\n${rule.body}`.toLowerCase();
    const shared = [...ruleWords(text)].filter((word) => asked.has(word)).length;
    if (shared < 2) continue;
    // An option the rule names only after a negation ("never fixed price", «ποτέ») is not the rule's answer.
    const named = item.options.filter((option) => !GENERIC_OPTION.test(option.trim()) && [...text.matchAll(new RegExp(`(?:^|[^\\p{L}\\p{N}])${option.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:$|[^\\p{L}\\p{N}])`, "gu"))]
      .some((match) => !/(?:^|[^\p{L}])(?:never|not|no|don't|do not|avoid|μην|ποτέ|όχι)\s+(?:\S+\s+)?$/u.test(text.slice(Math.max(0, match.index - 20), match.index + 1))));
    if (named.length !== 1) continue;
    if (!best || shared > best.score) best = { option: named[0]!, rule: { id: rule.id, title: rule.title }, score: shared };
  }
  return best ? { option: best.option, rule: best.rule } : null;
}

/** A match of `pattern` in `text` that no negation ("never delete", "not paid") just before it turns around. */
// Folded first (slice 28): the Greek words below are unaccented and memory text is often typed without accents.
const affirms = (raw: string, pattern: RegExp) => { const text = foldText(raw); return [...text.matchAll(new RegExp(pattern.source, "giu"))]
  .some((match) => !/(?:^|[^\p{L}])(?:never|not|no|don't|do not|avoid|without|μην|μη|δεν|ποτε|οχι|χωρις)\s+(?:\S+\s+)?$/iu.test(text.slice(Math.max(0, match.index - 20), match.index))); };
/**
 * 1056 (13/11 REVIEW: Vault→keep and Pavago→skip were answered against the recommendation): the operator's principle rules, which name no option
 * so `ruleRecommendation` misses them: what marks a saved rule as the principle, and a recommended pick (with its card's text) against it.
 * shortcut: six principles in English wording (keep over delete and the agent sends also in Greek); add one here when a REVIEW finds another principle a card went against.
 */
const PRINCIPLES: Array<{ name: string; rule: RegExp; greek?: RegExp; against: (pick: string, context: string) => boolean }> = [
  // Slice 28 (decision 3ca0aa75, 15/11: «ελευθερώσει ~19 GB» predicted yes, answered «δώσε δίσκο»): the operator's rules are Greek
  // («Δεν σβήνεται τίποτα» 1734fb8c, «Σβήνεις …;: Κράτησέ τες» 613a0486), so both sides also read folded Greek.
  { name: "keep over delete", rule: /\bkeep\b[^.\n]*\b(?:over|instead of|rather than|before|not)\b[^.\n]*\b(?:delet|remov|discard)/i,
    greek: /(?:^|[^\p{L}])(?:δεν|μην|μη|ποτε|τιποτα)\s+(?:\S+\s+)?(?:σβην|σβησ|διαγραφ|διαγραψ)|(?:σβην|σβησ|διαγραφ|διαγραψ)[^\n;]*;[^\n]*κρατ/u,
    against: (pick) => affirms(pick, /\b(?:delet(?:e|ing)|remov(?:e|ing)|discard(?:ing)?|purg(?:e|ing)|eras(?:e|ing)|wip(?:e|ing))\b|(?<!\p{L})(?:σβησ|σβην|διαγραφ|διαγραψ|ελευθερωσ|καθαρισ)/u) },
  { name: "a free option first", rule: /\bfree\b[^.\n]*\b(?:first|over|before|instead of|rather than)\b|\bfree (?:solution|option|tier|alternative)s?\b/i,
    against: (pick, context) => affirms(pick, /\b(?:paid|pay(?:ing)?|buy(?:ing)?|purchas(?:e|ing)|subscri(?:be|bing|ption)|premium|upgrad(?:e|ing))\b|[$€£]\s?\d/)
      && affirms(context, /\bfree\b|\bopen[- ]source\b|\bself[- ]host/) },
  // Operator 27/11 (nous_msg:865bdcbe, rule space_memory:11beca47 «ποτε … λυση αγορας οταν διαθετουμε δωρεαν»; eb2e9d84 «δεν εχουμε το e2b;»): card
  // 279efb10 asked which server to order and named no free option, so the principle above never fired. Any buy/rent/order ask goes against this one.
  { name: "what we already own before a purchase (servers, credits, free tiers in Space Memory)",
    rule: /\bnever\b[^.\n]*\b(?:buy|purchas|pay|rent)\w*\b[^.\n]*\b(?:free|already (?:have|own))\b/i,
    greek: /αγορ\p{L}*[^\n]*(?:οταν|αφου|εφοσον)[^\n]*(?:δωρεαν|διαθετουμε|ηδη εχουμε)/u,
    against: (pick, context) => !/^(?:no|skip|not now|later|wait|οχι|αργοτερα)(?!\p{L})/u.test(foldText(pick).trim())
      && !affirms(pick, /\bfree\b|\bcredits?\b|\balready (?:have|own)\b|\bour own\b|(?<!\p{L})(?:δωρεαν|ηδη|δικ\p{L}* μας)(?!\p{L})/u)
      && affirms(`${pick}\n${context}`, /\b(?:buy(?:ing)?|purchas(?:e|ing)|rent(?:ing)?|subscrib(?:e|ing)|(?:new |recurring )?monthly cost|per month|order (?:the |a |an |one )?(?:[\w-]+ ){0,3}(?:server|host|vps|instance|machine|plan))\b|(?<!\p{L})(?:αγορασ|αγοραζ|νοικιαζ|νοικιασ|ενοικιασ|μηνιαιο κοστος|νεο κοστος)/u) },
  { name: "the operator reads funding mail before it is sent", rule: /\bfunding\b[^\n]*\b(?:mail|e-?mail)s?\b[^\n]*\bbefore\b[^\n]*\bsen[dt]\b/i,
    against: (pick, context) => /\b(?:funding|grant|investor|fundrais\w*|accelerator)s?\b/i.test(`${pick}\n${context}`) && affirms(pick, /\bsend(?:ing)?\b/)
      && !/\b(?:review|read|draft|approv\w*|show)\b/i.test(pick) },
  // 983 (6/11 REVIEW: Eight Sleep send answered against the recommendation; «κανε το εσυ … αυτα πρεπει να τα κανεις εσυ» 3/11): a send the
  // operator hands back. Only words that name the operator in either voice ("myself", "manually", "from your Gmail"): "send it yourself" or
  // «στείλ' το εσύ» reads both ways (the operator to the agent, or Nous to the operator), so it is not a pick here.
  { name: "the agent sends what the operator said to send", rule: /\b(?:do it yourself|send (?:it|them) yourself|the agent sends?)\b/i,
    greek: /(?<!\p{L})(?:κανε|στειλε) (?:το|τα|τη|την) εσυ(?!\p{L})|πρεπει να τα κανεις εσυ/u,
    against: (pick, context) => /\b(?:send|sent|mail|e-?mail|reply|forward)\b|(?<!\p{L})(?:στειλ|στελν|αποστολ|απαντησ)/iu.test(foldText(`${pick}\n${context}`))
      && affirms(pick, /\b(?:send|reply|submit|forward)\w*\b[^.\n]*\b(?:myself|manually|by hand|from your (?:own )?(?:gmail|mailbox|inbox|account))\b|\boperator sends?\b|(?<!\p{L})(?:στειλ|στελν)\p{L}* (?:\S+ )?(?:εγω|μονος μου)(?!\p{L})/u) },
  // 23/11 REVIEW (ledger 1762: «Μεταφορά σε τράπεζα, με ρητή επιφύλαξη» predicted, «Απόρριψη των κρατήσεων, επιμονή στα 12.000» answered; rule
  // space_memory:763c4398): a third party's disputed money claim, where a pick that takes the partial sum or a compromise goes against the rule.
  { name: "reject disputed deductions and insist on the full amount", rule: /\b(?:reject|refuse)\w*\b[^.\n]*\bdeductions?\b|\binsist\w* on the full\b/i,
    greek: /(?<!\p{L})απορριψ\p{L}* (?:\S+ )?κρατησ/u,
    against: (pick, context) => /\b(?:deposit|refund|deduction|reimburse\w*|withh[eo]ld|settlement)s?\b|(?<!\p{L})(?:εγγυησ|επιστροφ|κρατησ)|[$€£฿]\s?\d|\d\s?(?:thb|eur|usd)\b/iu.test(foldText(`${pick}\n${context}`))
      && affirms(pick, /\b(?:accept\w*|compromise|settle|split|partial|transfer)\b|(?<!\p{L})(?:δεχ|αποδεχ|αποδοχ|συμβιβασ|μεταφορ|μοιρασ)/u)
      && !affirms(pick, /\b(?:reject|refuse|insist)\w*|(?<!\p{L})(?:απορριψ|απορρι|επιμον)/u) },
  // 23/11 REVIEW (ledger 1813, Kate's Village Global card: «Θα σου πω το μηνιαίο ποσό» recommended, «Γράψε: pre-revenue, founder-funded, δεν
  // δίνω αριθμό» answered; rule space_memory:763c4398): a third party's form asking for his business figures gets the status, never a number.
  { name: "state the status without a figure on a third party's form", rule: /\bpre-revenue\b|\bwithout (?:a|any) (?:figure|number)\b/i,
    greek: /(?<!\p{L})δεν δινω (?:\S+ )?(?:αριθμ|νουμερ|ποσ)/u,
    against: (pick, context) => /\b(?:burn|runway|revenue|mrr|arr)\b|(?<!\p{L})(?:εσοδ|τζιρ)/iu.test(foldText(`${pick}\n${context}`))
      && affirms(pick, /\b(?:i'?ll|i will|let me)\s+(?:\S+\s+)?(?:give|tell|send|share)\b[^.\n]*\b(?:amount|figure|number|burn|runway)\b|(?<!\p{L})θα (?:σου )?(?:πω|δωσω|στειλω)(?!\p{L})/u) },
];
/** Whether a pick goes against any principle at all, read before the saved rules are (a card raise must not wait on the memory read). */
export const principleAgainst = (pick: string, context: string) => PRINCIPLES.some((principle) => principle.against(pick, context));
const follows = (principle: (typeof PRINCIPLES)[number], text: string) => principle.rule.test(text) || Boolean(principle.greek?.test(foldText(text)));
/** 1056: the saved principle rules a recommended pick contradicts (the card's or decision's text is `context`). */
export function principleConflicts(pick: string, context: string, rules: Array<{ id: string; title: string; body: string }>): Array<{ principle: string; rule: { id: string; title: string } }> {
  return PRINCIPLES.flatMap((principle) => {
    const rule = principle.against(pick, context) ? rules.find((entry) => follows(principle, `${entry.title}\n${entry.body}`)) : undefined;
    return rule ? [{ principle: principle.name, rule: { id: rule.id, title: rule.title } }] : [];
  });
}
/**
 * 23/11 REVIEW (Village Global): a card another producer raised (an agent, a copilot) never passed Nous's principle hold, so its own pick stood
 * against the operator's rule. The one option that follows the principle its pick goes against (and goes against none), else null.
 */
export function principlePick(pick: string, context: string, options: string[], rules: Array<{ id: string; title: string; body: string }>): { option: string; principle: string; rule: { id: string; title: string } } | null {
  for (const hit of principleConflicts(pick, context, rules)) {
    const principle = PRINCIPLES.find((entry) => entry.name === hit.principle)!;
    const follow = options.filter((option) => follows(principle, option) && !principleConflicts(option, context, rules).length);
    if (follow.length === 1) return { option: follow[0]!, ...hit };
  }
  return null;
}

const CANNOT_WORK = /\b(?:cannot|can't|can not|won't work|doesn't work|does not work|not possible|impossible)\b|(?<!\p{L})(?:δεν (?:γινεται|δουλευει|λειτουργει|μπορει|περναει)|αδυνατ)/u;
/**
 * 1155 (18/11 REVIEW: 4 Azure/Microsoft account cards answered against the recommendation): the saved operator rules that say a step cannot
 * work and name a name the card names (a capitalised word not opening its sentence: Azure, Microsoft, example.invalid's Olla).
 * shortcut: names only, so a rule about "the account" with no name is missed; add subject words when a REVIEW finds such a miss.
 */
// Space's own nouns name no third party (25/11 example.invalid and Gshopper mail-review approves: "Mail Copilot" tied 17 unrelated rules, the hold led to ruleDiffers and an operator card).
const SPACE_WORDS = /^(?:space|nous|vault|operator|mail|copilots?|marketing|freelance|job|design|security|monitoring|studio|reviews?|campaigns?|memory|gateway|agents?|files?|plans?|panes?|rooms?|approve)$/;
export function cannotWorkRules(card: string, rules: Array<{ id: string; title: string; body: string }>): Array<{ id: string; title: string }> {
  const names = new Set(card.split(/[.!?:;\n]+/).flatMap((sentence) => sentence.trim().split(/[\s,()«»"]+/).slice(1))
    .filter((word) => /^\p{Lu}\p{L}{2,}/u.test(word)).map((word) => foldText(word).replace(/[^\p{L}\d]+$/u, "")).filter((name) => !SPACE_WORDS.test(name)));
  return names.size ? rules.filter((rule) => {
    const text = foldText(`${rule.title}\n${rule.body}`);
    return CANNOT_WORK.test(text) && [...names].some((name) => new RegExp(`(?<![\\p{L}\\d])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\d])`, "u").test(text));
  }).map((rule) => ({ id: rule.id, title: rule.title })) : [];
}

type GateNoted = NotifyOperatorArgs["items"][number] & { answersSource?: string };
/** S5: the gate notes the operator reads under "Checked first:", not in the item; with several items each names its item. */
const gateNotes = (items: GateNoted[]) => items.flatMap((item) => [
  item.ruleDiffers ? `Differs from what Space holds: ${item.ruleDiffers}` : "", item.triedStored ? `Stored sign-in tried: ${item.triedStored}` : "",
  item.answersSource ? `It answers the ${item.answersSource}'s question` : ""
].filter(Boolean).map((note) => items.length > 1 ? `${item.text}: ${note}` : note));
/** The notes and `since` of a card's items, so a changed one still updates the card. */
const noteKey = (items: unknown) => JSON.stringify((Array.isArray(items) ? items as Array<Record<string, unknown>> : []).map((item) => [item.since, item.ruleDiffers, item.triedStored, item.answersSource]));
const bodyOf = (items: NotifyOperatorArgs["items"]) => items.map((item) => `• ${item.about ? `${item.about}\n  ` : ""}${item.text}${(item.steps ?? []).map((step, index) => `\n  ${index + 1}. ${step}`).join("")}`).join("\n");
/** R20-asks-2: what only the operator's hands do (a sign-in, a code, a payment set-up, an install), which needs the page's link (13/11: no steps). */
/** R24-2: a payment-method result card (its options report a state) and a `checked` line that says what the billing page showed. */
const PAYMENT_WORDS = /\b(?:card|payment method|payment|billing)\b/i;
const RESULT_OPTION = /^(?:done|saved|added|card added|updated|set|ready|completed)\b/i;
const RESULT_OPTION_EL = /^(?:ναι|έγινε|εγινε|το έκανα|το εκανα|έκανα|εκανα|έτοιμο|ετοιμο|ολοκληρώθηκε|αποθηκεύτηκε|προστέθηκε)(?=$|[\s,.!;:—–-])/iu;
const PAGE_SEEN = /\b(?:page|screen|space_look)\b.*\b(?:shows?|showed|lists?|listed|has|had|no card|empty)\b|\b(?:cannot|can't|could not) (?:see|open|reach)\b/i;
/** R21-3: a status the operator reports after acting, never the recommended answer of a hands card without their base rate. */
/** R60: the hands extras in Greek, and what says each extra in either language (an option Nous wrote itself counts). */
const EXTRAS_EL = ["Απέτυχε", "Χρειάζομαι link/βήματα"];
const EXTRA_SAME = [/^(?:failed|απέτυχε)/i, /^(?:need (?:links|help)|χρειάζομαι (?:link|βήματα|οδηγίες)|θέλω βοήθεια)/i];
// The Greek words end on a lookahead: \b sees no word edge after a Greek letter, so «Έγινε» was never held.
const STATUS_OPTION = /^(?:(?:done|installed|finished|completed|ready|signed in)\b|(?:έγινε|έτοιμο|ολοκληρώθηκε)(?!\p{L}))/iu;
// 14/11 REVIEW (Dana's rule 4: Mercor interview, npm security key, Space Link, Braintrust identity video asked with no link, «δωσε μου λινκ»).
const MID_FLOW = /captcha|puzzle|\bsms\b|verification code|passcode|2fa|\bmfa\b|\botp\b|security key|selfie|identity (?:video|check|verification)/i;
const HANDS_WORK = /sign[- ]?in|log[- ]?in|captcha|password|passcode|2fa|\bmfa\b|\botp\b|verification code|\bsms\b|handoff|billing|install|interview|security key|passkey|selfie|identity (?:video|check|verification)|\bpersona\b|link spaceapp|συνέντευξ|ταυτοποίησ/i;
/** 13/11 (an office ERP invoices card held for its link): work in a tool with no web address, named instead of the link. */
const OFFLINE_TOOL = /\bERP\b|\bdesktop (?:app|application|program|software|client)\b|\boffline\b|\bPOS\b|cash register|ταμειακ|\bprinter\b|εκτυπωτ/i;
export const NOUS_HANDS_RULE = "A card for the operator's hands opens the exact page: its https link or `target` (the tab), and no steps (operator rule 13/11 nous_msg:83c0acb8: "
  + "focus only when needed, at the one step only they can do); work in an offline tool (a desktop ERP) names that tool instead of the link.";
type LinkedItem = Pick<NotifyOperatorArgs["items"][number], "text"> & Partial<Pick<NotifyOperatorArgs["items"][number], "question" | "steps" | "target" | "code">>;
/** The hands items of a card that open no page: no https link, no `target`, no offline tool named. */
export function handsItemsMissingLink<T extends LinkedItem>(items: T[]): T[] {
  // `steps` still counts as where the link is: signinCard (focus-need.ts) refuses the steps themselves.
  return items.filter((item) => { const words = [item.text, item.question ?? "", ...(item.steps ?? [])].join("\n");
    return !item.code && HANDS_WORK.test(`${item.text} ${item.question ?? ""}`) && !item.target && !/https:\/\/\S+/.test(words) && !OFFLINE_TOOL.test(words); });
}
// 14/11 (operator correction 824bd787 «Δώσε μου λινκ να κάνω accept»): asking them to act on a site or a pane opens it too.
const ACT_ON = /\b(?:open|go to|visit|check|look at|review|accept|approve|confirm|click|press|test|try)\b|(?<!\p{L})(?:άνοιξε|δες|μπες|έλεγξε|αποδέξου|έγκρινε|πάτα)(?!\p{L})/iu;
const ON_SITE = /\b(?:site|website|web ?page|page|dashboard|portal|console|url)\b|σελίδα|ιστότοπ|ιστοσελίδ/iu;
const ON_PANE = /\b(?:pane|tab)\b/i;
export const NOUS_ACT_LINK_RULE = "It asks the operator to act on a site or a pane, so the card opens it: give the item its `target` (url:https://… for the page, "
  + "tab:<id> for a browser pane's tab) or put the page's https link in its text; for a pane, raise the card on that pane (`pane`).";
/** The items asking the operator to act on a site (or a pane, when the card is on none) that open nothing: no https link, no `target`, no offline tool. */
export function actItemsMissingLink<T extends LinkedItem>(items: T[], onPane: boolean): T[] {
  return items.filter((item) => { const said = `${item.text} ${item.question ?? ""}`; const words = [said, ...(item.steps ?? [])].join("\n");
    return !item.code && !item.target && !/https:\/\/\S+/.test(words) && !OFFLINE_TOOL.test(words) && ACT_ON.test(said) && (ON_SITE.test(said) || (!onPane && ON_PANE.test(said))); });
}
// Nous errors 24/11 (b25510ce «Press «Συγχρονισμός του Vault» on the spaceapp-hz row» → «ανοιξε το … μεσω browser … δεν χρειαζεσαι εμενα», 931c907c
// «σου ειπα εσυ να κανεις την συνδεση»): pressing a control on a page is an agent's job in a browser pane; paying, sending, buying stay the operator's.
const PRESS = /\b(?:press|click|tap|toggle)\b|(?<!\p{L})(?:πάτα|πάτησε|πατήστε|πατησε|πατα)(?!\p{L})/iu;
const OPERATOR_CLICK = /\b(?:pay|send|buy|subscribe|checkout|purchase|order|bot|robot|human|accept|agree|consent|sign)\w*|πληρ|αγορ|στείλ|στειλ|αποδοχ|συναίν/iu;
function agentClickItems<T extends LinkedItem>(items: T[]): T[] {
  return items.filter((item) => { const said = `${item.text} ${item.question ?? ""}`;
    return !item.code && PRESS.test(said) && !HANDS_WORK.test(said) && !OPERATOR_CLICK.test(said); });
}
const live = (item: SpaceNotification) => item.status === "OPEN" || item.status === "READ";
// 13/11 Cartesia card: a pane agent's own needs-you card (`agentNeedsYouKey` in pane-reports.ts) joins Nous's duplicate check, so one ask is one card.
const agentAsk = (item: SpaceNotification) => item.source === "AGENT" && Boolean(item.dedupeKey?.startsWith("agent:needs-you:"));
/** The card's question: `lead` (the newest item with a target) when it asks, else its first item that asks one (a recommendation that is not an
 * option is dropped), answered through Nous. */
function askOf(items: NotifyOperatorArgs["items"], lead?: NotifyOperatorArgs["items"][number]): NeedsYouAsk | null {
  // R27-3: a one-time code is the card's question, typed by the operator and sent into the pane, never through Nous.
  const code = items.find((entry) => entry.code);
  if (code) return { question: code.question ?? code.text, code: true, answer: { kind: "PANE" } };
  const asks = (entry: NotifyOperatorArgs["items"][number]) => Boolean(entry.question || entry.answerKind === "text");
  const goes = (entry: NotifyOperatorArgs["items"][number]) => !entry.code && entry.recommended === NEEDS_YOU_GO_NOW && entry.options?.[0] === NEEDS_YOU_GO_NOW;
  // Operator nous_msg:4b36b80e (6/11): an item that joins the card with its own page asks first, its Go now on top, not under an older item's question.
  // Brief 20261103 (goal 7365014c): with no item asking, the first one Space gave the Go now options is the card's question.
  const item = (lead && (asks(lead) || goes(lead)) ? lead : undefined) ?? items.find(asks) ?? items.find(goes);
  if (!item) return null;
  return { question: item.question ?? item.text, ...(item.answerKind === "text" ? { answerKind: "text" as const } : {}), ...(item.options?.length ? { options: item.options } : {}),
    ...(item.recommended && item.options?.includes(item.recommended) ? { recommended: item.recommended } : {}), answer: { kind: "NOUS" } };
}

/** Every notification the query matches, page by page (the list answers 200 at most). */
export async function allNotifications(list: (owner: string, query: NotificationListQuery) => Promise<SpaceNotification[]>, owner: string,
  query: Omit<NotificationListQuery, "limit" | "before">): Promise<SpaceNotification[]> {
  const out: SpaceNotification[] = [];
  for (let before: string | undefined; ;) {
    const page = await list(owner, { ...query, limit: 200, ...(before ? { before } : {}) });
    out.push(...page);
    if (page.length < 200) return out;
    before = page.at(-1)!.createdAt;
  }
}

export function createNousPaneNotices(deps: NousPaneNoticesDeps) {
  const now = deps.now ?? Date.now;
  const paymentHeld = new Map<string, number>();
  // Every waiting Nous card (until 31/10 among the newest 200 Nous records of any status, so an older open card was missed).
  const openCards = async (owner: string) => (await allNotifications(deps.notifications.list, owner, { status: "WAITING", source: "NOUS" }))
    .filter((item) => item.source === "NOUS" && live(item) && nousKey(item.dedupeKey));

  return {
    /** The room and pane are already the owner's (resolved by the tool). */
    /** R20-ask-1's account facts stay Nous's (its tool's holds): the card never carries them (operator 2/11 09:49 BKK). */
    async notify(owner: string, room: Room | null, pane: Pane | null, args: NotifyOperatorArgs): Promise<{ ok: boolean; display: string; result: string; refused?: boolean }> {
      const dedupeKey = pane ? `${NOUS_PANE_NOTICE_PREFIX}${pane.id}` : args.plan ? `${NOUS_PLAN_NOTICE_PREFIX}${args.plan}` : NOUS_GENERAL_NOTICE_KEY;
      const where = pane ? `${pane.paneName ?? pane.title} in ${room?.name ?? "its room"}` : room?.name ?? `plan ${args.plan ?? "?"}`;
      const title = args.title;
      // R11-2 (6): an operator rule that answers an item's question sets its recommended option, and the item says which rule.
      // R13-7: else the operator's last 2 agreeing answers to the same question set it.
      const rules = deps.operatorRules ? await deps.operatorRules().catch(() => []) : [];
      const ledger = deps.ledger && args.items.some((item) => item.question)
        ? await deps.ledger(owner, new Date(now() - 90 * 86_400_000).toISOString()).catch(() => []) : [];
      if (rules.length || ledger.length) args = { ...args, items: args.items.map((item) => {
        const hit = rules.length && !item.ruleDiffers ? ruleRecommendation(item, rules) : null;
        // 30/10 12:10 BKK: a rule agreeing with Nous's own recommendation adds nothing to the card.
        if (hit && hit.option === item.recommended) return item;
        if (hit) return { ...item, recommended: hit.option, text: `${item.text} (Recommended "${hit.option}" by your rule [${hit.rule.id}] "${hit.rule.title.slice(0, 80)}".)` };
        const found = ledgerRecommendation(item, ledger);
        return found ? { ...item, recommended: found.option, text: `${item.text} (Recommended "${found.option}" by your last ${found.answers} answers.)` } : item;
      }) };
      // R16-2 (29/10: three cards for the 4 allowance switches in 50 minutes, the third answered «Δεν καταλαβαίνω την ερώτηση σου!!»): a question
      // the operator answered on a Nous card in the last 2 hours is not asked again unless the item says what changed since.
      const answered = ledger.filter((row) => row.source === "NEEDS_YOU:NOUS" && Date.parse(row.at) >= now() - 2 * 3_600_000);
      for (const item of args.items) {
        const asked = item.question && !item.since ? titleWords(item.question) : new Set<string>();
        const twin = asked.size >= 2 ? answered.find((row) => [...asked].filter((word) => titleWords(row.title).has(word)).length / asked.size >= 0.6) : undefined;
        // W45 step 2: R16-2 and the by-day timing rule below are holds (REFUSED), final for the same item (2/11: 2 and 4 stored FAILED).
        if (twin) return { ok: false, refused: true, display: "The operator already answered this", result: `The operator answered "${twin.title.slice(0, 120)}"${twin.ref ? ` (card ${twin.ref})` : ""} at `
          + `${twin.at.slice(11, 16)} UTC: "${twin.answer.slice(0, 160)}". Nothing raised. Do not call it again with this item; state the server's fact instead of asking them to `
          + "confirm it, or give the item `since` naming what changed since that answer." };
      }
      // Operator 13/11 07:12 BKK (plan clipboard:T2uboz26Oh3q S5): `since`, `ruleDiffers` and `triedStored` stay item fields, never words in the item;
      // the card shows `since` as "Since then" and the others under "Checked first:" (`gateNotes`).
      // 2026-10-30 REVIEW (R16-3 for Nous's own cards): by day the operator's standing answer to "now or later?" is now, one by one.
      const timing = args.items.find((item) => item.question && needsYouTimingNow({ title: "", body: "", payload: { ask: { question: item.question, options: item.options ?? [], answer: { kind: "NOUS" } } } }));
      if (timing && !(await deps.quiet?.(owner).catch(() => false))) {
        return { ok: false, refused: true, display: "Asked when, by day", result: `"${timing.question!.slice(0, 120)}" asks when: by day the operator's standing answer is now, one by one `
          + "(operator rule 29/10 16:25 BKK). Nothing raised. Do not call it again with this question; request the handoff or do the step now, and in their quiet hours ask in the morning." };
      }
      // R24-2 (cards predicted 31 of 60 in 7 days to 1/11; 6 of the 8 payment-method result cards missed: «I added payment methods, don't know
      // what else you want», «check and tell me the exact problem», «open the browser on the page»): whether a card or billing role is saved
      // is on the site's billing page, which a pane looks at itself. Held once an hour unless `checked` says what that page showed.
      const payment = args.items.find((item) => item.question && item.options?.some((option) => RESULT_OPTION.test(option.trim()))
        && PAYMENT_WORDS.test(`${item.text} ${item.question}`));
      const paymentKey = payment ? `${owner}\n${questionShape(payment.question!)}` : "";
      if (payment && !(args.checked ?? []).some((line) => PAGE_SEEN.test(line)) && now() - (paymentHeld.get(paymentKey) ?? -Infinity) > 3_600_000) {
        paymentHeld.set(paymentKey, now());
        return { ok: false, refused: true, display: "Look at the billing page first", result: `"${payment.question!.slice(0, 120)}": a card or billing setting `
          + "shows on the site's billing page: have the pane look at it (space_look, browser content) and tell the operator what it shows; raise the card only "
          + "for what needs their hands there, with the page and what it showed in `checked` (R24-2: 6 of 8 such cards in 7 days were answered otherwise). Nothing raised." };
      }
      // 4/11 REVIEW (cards went as recommended 44 % in 7 days; 3 answered against a "Done"/"Yes": 0.2.13 was not in Updates, the Authenticator
      // account, a Hetzner payment): an item recommending Done or Yes has a `checked` line about the same thing, saying what showed its prerequisite.
      // R74 (4/11 15:58 BKK: «Έκανες τα τεστ WeCP του Meridial;» recommended «Το έκανα», answered «πέρασε need you … θα το κανω απο εκει»): Greek too.
      const affirms = (answer: string | null | undefined) => !!answer && (RESULT_OPTION.test(answer.trim()) || /^yes\b/i.test(answer.trim()) || RESULT_OPTION_EL.test(answer.trim()));
      const unproved = args.items.find((item) => item.question && affirms(item.recommended)
        && !(args.checked ?? []).some((line) => { const words = titleWords(`${item.text} ${item.question}`); return [...titleWords(line)].some((word) => words.has(word)); }));
      if (unproved) {
        const rows = ledger.filter((row) => row.source === "NEEDS_YOU:NOUS" && row.match != null && affirms(row.predicted));
        return { ok: false, refused: true, display: "Show what proves it first", result: `"${unproved.question!.slice(0, 120)}" recommends "${unproved.recommended}": add to \`checked\` `
          + "the source that shows its prerequisite and what it showed, naming the same thing (e.g. \"app Updates: lists 0.2.13\"), then raise the card. "
          + (rows.length ? `Your cards recommending Done or Yes went as recommended ${rows.filter((row) => row.match).length} of ${rows.length} times in 90 days. ` : "") + "Nothing raised." };
      }
      // R27-3: a one-time code goes from the card straight into its pane's prompt: one a card, on a pane, with nothing to pick from.
      const codes = args.items.filter((item) => item.code);
      if (codes.length && (!pane || codes.length > 1 || codes.some((item) => item.options?.length))) return { ok: false, refused: true, display: "A code item goes to its pane",
        result: "A one-time code item (`code: true`) is typed into its pane's prompt: one a card, on a pane, with a question and no options. Nothing raised." };
      // 16/11 REVIEW (nous_msg:33444df3: a Shopify SMS code card on Dino/Bob said a code was sent; no Shopify tab was open, nothing showed it sent): a code
      // card goes while its page is open and the pane reported in the last 15 minutes (a browser pane makes no reports). Cannot tell: it goes.
      const code = codes[0];
      if (code && pane) {
        const open = await deps.codePageOpen?.(owner, pane, code.target, `${code.text}\n${code.question ?? ""}`).catch(() => null);
        const reportAt = deps.paneReportAt && !isBrowserPane(pane) ? await deps.paneReportAt(owner, pane.id).catch(() => undefined) : undefined;
        const age = reportAt ? now() - Date.parse(reportAt) : 0;
        const why = open === false ? "no tab at its site is open" : reportAt === null ? `${where} has made no report`
          : age >= 15 * 60_000 ? `${where}'s newest report is ${Math.floor(age / 60_000)} min old` : null;
        if (why) return { ok: false, refused: true, display: "Reopen the page and request the code first", result: `A one-time code card goes only while its page `
          + `waits for the code, and ${why}. Have the pane reopen the page, request the code there and report what the site showed, then raise the card with `
          + "that tab as `target`. Nothing raised." };
      }
      // 21/11 REVIEW (5 hands cards answered against the recommendation: SMS window closed, AWS puzzle not open, Braintrust browser closed): a hands
      // card goes while its page is live: a tab target some browser holds; an address target, for a step mid-flow, a tab at its site near the pane
      // (opening the address afresh lands at the start, not at the step). Cannot tell: it goes.
      const stale = pane && deps.codePageOpen ? args.items.find((item) => !item.code && HANDS_WORK.test(`${item.text} ${item.question ?? ""}`)
        && (item.target?.startsWith("tab:") || (item.target?.startsWith("url:") && MID_FLOW.test(`${item.text} ${item.question ?? ""}`)))) : undefined;
      if (stale && pane && await deps.codePageOpen!(owner, pane, stale.target, `${stale.text}\n${stale.question ?? ""}`).catch(() => null) === false) {
        return { ok: false, refused: true, display: "Bring the page back to that step first", result: `"${stale.text.slice(0, 120)}": no browser holds its page `
          + `(${stale.target}). Have the pane reopen the page at the step only the operator can do and report what it shows, then raise the card with that tab `
          + "as `target`. Nothing raised." };
      }
      // R20-asks-2 (operator rule cc31fdd2, 13/11 nous_msg:83c0acb8): a hands item opens its page (link or target), no steps; one asked with options also offers
      // "Failed" and "Need links/steps" (7 of 36 cards on 30/10 were answered against a «Done/Installed» recommendation).
      // R23-3 (31/10, operator «Θέλω να τα δω όλα αυτά»: icon and video options asked by id): Needs you shows every artifact a card names,
      // so one that does not open for the owner would show nothing.
      for (const id of new Set(args.items.flatMap((item) => artifactIdsIn([item.text, item.question ?? "", ...(item.options ?? []), ...(item.files ?? [])].join("\n"))))) {
        if (deps.artifactOpens && !await deps.artifactOpens(owner, id).catch(() => false)) return { ok: false, refused: true, display: "A named artifact does not open",
          result: `${id} is no artifact of your rooms (deleted, mistyped, or another owner's): Needs you shows each artifact a card names. Name it by its exact id `
            + "(space_files_list artifacts) or leave it out. Nothing raised." };
      }
      // Operator 27/11 (card 279efb10 «Which server do you order?»: «δεν επριεχει τα αρχεια … δεν περιεχει το πλανο»): an item saying something is in
      // Agent Files or attached carries those files, and a question with options names its pane or its plan, so the card opens the why.
      const unattached = args.items.find((item) => !item.files?.length && /\bagent files\b|\battach(?:ed|ments?)\b/i.test(`${item.text} ${item.question ?? ""}`)
        && !artifactIdsIn(`${item.text} ${item.question ?? ""}`).length);
      if (unattached) return { ok: false, refused: true, display: "Attach the files it names", result: `"${unattached.text.slice(0, 120)}" names files in Agent Files `
        + "but carries none: give the item `files` with each one's artifact:<id> (space_files_list artifacts), so the card shows them. Nothing raised." };
      const unexplained = args.items.find((item) => item.options?.length && !item.about && !item.code && !item.target && !HANDS_WORK.test(`${item.text} ${item.question ?? ""}`));
      if (unexplained) return { ok: false, refused: true, display: "Say what this is", result: `"${(unexplained.question ?? unexplained.text).slice(0, 120)}": a choice `
        + "gives `about`, one line saying what this is for an operator who has never heard of it (the service, the order, the release, and why it reached them), "
        + "so they answer it instead of asking back (2026-11-28 REVIEW: Loom, the server order). Nothing raised." };
      const planless = !pane && !args.plan ? args.items.find((item) => item.options?.length) : undefined;
      if (planless) return { ok: false, refused: true, display: "Name the plan the question comes from", result: `"${(planless.question ?? planless.text).slice(0, 120)}": `
        + "a question with options on a card with no pane names its `plan` (clipboard:<id>), so the operator can open why it is asked; a choice that is a decision "
        + "goes through space_ask_operator. Nothing raised." };
      const bare = handsItemsMissingLink(args.items);
      if (bare.length) return { ok: false, refused: true, display: "A hands card needs its link", result: `"${bare[0]!.text.slice(0, 120)}": ${NOUS_HANDS_RULE} Nothing raised.` };
      const unlinked = actItemsMissingLink(args.items, Boolean(pane));
      if (unlinked.length) return { ok: false, refused: true, display: "A card needs its link", result: `"${unlinked[0]!.text.slice(0, 120)}": ${NOUS_ACT_LINK_RULE} Nothing raised.` };
      const clicks = agentClickItems(args.items);
      if (clicks.length) return { ok: false, refused: true, display: "An agent presses it", result: `"${clicks[0]!.text.slice(0, 120)}": pressing a control on a page `
        + "is an agent's work: have a browser pane open the page and press it (space_browser, or a pane with the browser), then read what the page shows. "
        + "A card goes to the operator only for what their hands alone can do there (sign-in, a code, a payment, a send). Nothing raised." };
      const extras = ["Failed", "Need links/steps"];
      const hands = (item: NotifyOperatorArgs["items"][number]) => HANDS_WORK.test(`${item.text} ${item.question ?? ""}`);
      // Operator 13/11 15:37 BKK («δεν καταλαβαίνω καν τι αφορά»): a plan's card shows no item as a bare free-text box: it asks with its options, is hands work,
      // or says it wants a typed value (answerKind "text").
      const vague = !pane && args.plan ? args.items.find((item) => item.question && !item.code && !item.options?.length && item.answerKind !== "text" && !hands(item)) : undefined;
      if (vague) return { ok: false, refused: true, display: "A plan card asks with its options", result: `"${vague.text.slice(0, 120)}": a plan's card item `
        + "is a question in the operator's language with its options and your recommendation (a yes/no is Approve / Reject), hands work with its link, or "
        + "answerKind \"text\" for a value they type. Nothing raised." };
      const goNow = (item: NotifyOperatorArgs["items"][number]) => ({ ...item, ...(hands(item) ? { question: item.question ?? item.text } : {}), options: [NEEDS_YOU_GO_NOW, ...extras], recommended: NEEDS_YOU_GO_NOW });
      // The ask a card raised before brief 20261103 carries (only hands items took the Go now options): the same list is no reason to alert again.
      const askBefore = askOf(args.items.map((item) => !item.code && !item.options?.length && hands(item) ? goNow(item) : item));
      args = { ...args, items: args.items.map((item) => {
        if (item.code) return item;
        // Operator 4/11 18:42 BKK («δεν μου δινει θεση να γραφω το τηλεφωνο»): a question without options asks for a value, typed on the card.
        if (item.answerKind === "text" || (item.question && !item.options?.length && !hands(item))) return { ...item, answerKind: "text" as const };
        // R27-2 (Mercor card 11:52 went unscored; the operator answered «open the page and go to the point» 2/2): an item without options
        // asks whether they go now, and recommends it; since brief 20261103 (goal 7365014c: Cleo/Iris and Cleo/Dana cards stored no
        // recommendation and counted as "no prediction") every item, not only hands work.
        if (!item.options?.length) return goNow(item);
        if (!hands(item)) return item;
        // R60 (1/11 Twitch 2FA: «Έγινε, Απέτυχε, Θέλω βοήθεια» got "Failed" and "Need links/steps" too): the extras speak the options' language,
        // and an option saying the same in either language is the extra.
        const greek = item.options.some((option) => /\p{Script=Greek}/u.test(option));
        return { ...item, options: [...item.options, ...(greek ? EXTRAS_EL : extras).filter((_, index) => !item.options!.some((option) => EXTRA_SAME[index]!.test(option)))].slice(0, 6) };
      }) };
      // R21-3 (REVIEW 1/11: cards predicted 30 of 57 against decisions 80 %; 31/10 NVIDIA → "Need links/steps", Lendable → «Βάλε agent να το κανει»):
      // a hands item never recommends a status ("Done", "Installed"); since 16/11 21:55 BKK not even by the base rate.
      const doneGuess = args.items.find((item) => item.question && item.options?.length && item.recommended && STATUS_OPTION.test(item.recommended.trim())
        && HANDS_WORK.test(`${item.text} ${item.question}`));
      if (doneGuess) return { ok: false, refused: true, display: `"${doneGuess.recommended}" is no recommendation for a hands card`, result: `"${(doneGuess.question ?? doneGuess.text).slice(0, 120)}": `
        + `"${doneGuess.recommended}" is never recommended on a hands card: only the operator says it is done (16/11); hands cards recommending a status were wrong `
        + "most (REVIEW 1/11: 30 of 57). Recommend what they will pick (\"Need links/steps\", or what they will do), or have an agent do it. Nothing raised." };
      // R60 (1/11 X Premium card recommended "Failed", answered "Updated the card"): the fallback a card offers is never its prediction.
      const fallback = args.items.find((item) => item.recommended && /^(?:failed|απέτυχε)$/i.test(item.recommended.trim()));
      if (fallback) return { ok: false, refused: true, display: `"${fallback.recommended}" is no recommendation`, result: `"${(fallback.question ?? fallback.text).slice(0, 120)}": `
        + `"${fallback.recommended}" is the fallback the card offers, never a prediction: recommend what the operator will do, or "Need links/steps". Nothing raised.` };
      // R12-11: a card question with options names the one Nous expects the operator to pick (hands-only items without options need none).
      const unpredicted = args.items.find((item) => item.options?.length && !(item.recommended && item.options.includes(item.recommended)));
      // Daily Nous errors 14/11 (9/11 03:03): the answer names the field to add, like the fallback refusal above.
      if (unpredicted) return { ok: false, refused: true, display: "Asked without a recommended option", result: `"${(unpredicted.question ?? unpredicted.text).slice(0, 120)}" has options and no recommended one: ${NOUS_PREDICTION_RULE} Nothing raised.` };
      // R16-8 (19:11 BKK: the MOBILE BUZZ refund reached the operator twice, the Mail card 6123bb27 released by card 1a969a7e's ref): a held
      // copilot card an item names stays held and is answered through this card; it resolves when this card is answered or resolved.
      const held = new Map<string, SpaceNotification>();
      for (const ref of new Set(args.items.map((item) => item.ref).filter((ref): ref is string => Boolean(ref)))) {
        const found = await deps.notifications.get?.(owner, ref).catch(() => null);
        if (found && live(found) && found.payload.heldForNous) held.set(ref, found);
      }
      // Operator 2/11 15:08 BKK («να μην φτανει σε εμενα το aprove»): an approval "May send" covers is Nous's to decide, never put on his card.
      const yours = [...held.values()].find((found) => heldUnderAllowance(found));
      if (yours) return { ok: false, refused: true, display: "This approval is yours, not the operator's", result: `${yours.id} is held for you under "May send to third parties": `
        + `decide it yourself (approve, edit, revise or reject: ${heldForNousNote(yours).trim()}). The operator sees it only if he turns the allowance off. Nothing raised.` };
      if (held.size) args = { ...args, items: args.items.map((item) => item.ref && held.has(item.ref)
        ? { ...item, answersSource: NOTIFICATION_SOURCE_LABELS[held.get(item.ref)!.source] } : item) };
      // Operator 13/11 07:12 BKK (plan clipboard:T2uboz26Oh3q S2): a card naming no pane that answers a held card is about that card's pane: it joins
      // that pane's Nous card (one per pane), so the card opens the pane.
      const heir = pane || args.plan ? undefined : [...held.values()].find((found) => found.roomId && found.paneId);
      const roomId = heir?.roomId ?? room?.id ?? null;
      const paneId = pane?.id ?? heir?.paneId ?? null;
      const key = heir ? `${NOUS_PANE_NOTICE_PREFIX}${heir.paneId}` : dedupeKey;
      // Go to pane opens the item (operator 1/11 11:58 BKK): the newest item's target (nous_msg:4b36b80e: the page an item joining the card brings),
      // else the target of the card an item answers (`ref`).
      const lead = args.items.findLast((item) => item.target);
      let target = lead?.target;
      for (const ref of target ? [] : args.items.map((item) => item.ref).filter((ref): ref is string => Boolean(ref))) {
        const found = held.get(ref) ?? await deps.notifications.get?.(owner, ref).catch(() => null);
        if (found?.link.target && found.paneId === paneId) { target = found.link.target; break; }
      }
      // Operator 12/11 23:19 BKK: an item naming a Mail review (its ref or words, mailrev:…) opens that review and its mail, without Nous naming it.
      target ??= needsYouMail({ body: "", payload: { items: args.items } })?.target;
      // R27-2: a hands card on a browser pane opens the exact page the operator acts on.
      if (pane && isBrowserPane(pane) && !/^(?:url|tab):/.test(target ?? "") && args.items.some((item) => !item.code && HANDS_WORK.test(`${item.text} ${item.question ?? ""}`))) {
        return { ok: false, refused: true, display: "A hands card on a browser pane needs its page", result: `${where} is a browser pane: give the hands item \`target\` `
          + "\"url:https://…\" (the exact page to act on) or \"tab:<tabId>\" (space_browser_tabs lists them), so Go now opens it (R27-2: the operator answered «open the "
          + "page and go to the point»). Nothing raised." };
      }
      // Operator 13/11 15:37 BKK («παταω go to pane και δεν κανει τιποτα»): a plan's card stays off any pane (one per plan), its link names the plan's open pane.
      const planPane = !paneId && args.plan ? await deps.planPane?.(owner, args.plan).catch(() => null) ?? null : null;
      const items = bodyOf(args.items);
      const body = `${items}${checkedBlock([...(args.checked ?? []), ...gateNotes(args.items)])}`;
      const ask = askOf(args.items, lead);
      const current = (await openCards(owner)).find((item) => item.dedupeKey === key);
      // Other wording of what was checked is no new list: the operator is not alerted again for it (a changed gate note is one, as when it was in the item).
      if (current && current.title === title && current.body.split(CHECKED_HEADER)[0] === items && [ask, askBefore].some((same) => JSON.stringify(current.payload.ask ?? null) === JSON.stringify(same))
        && (current.link.target ?? null) === (target ?? null) && noteKey(current.payload.items) === noteKey(args.items)) {
        return { ok: true, display: `The card for ${where} already lists this`, result: `Unchanged (${current.id}); the operator was not alerted again.` };
      }
      const raise: NotificationRaiseInput = {
        ownerUserId: owner, roomId, paneId, source: "NOUS", kind: "NEEDS_HANDS", severity: "ATTENTION", title, body,
        link: { ...(roomId ? { roomId } : {}), ...(paneId ? { paneId, ...(target ? { target } : {}) } : planPane ?? {}) }, dedupeKey: key, telegram: null,
        payload: { items: args.items, checked: args.checked, ...(args.plan ? { planId: args.plan } : {}), ...(args.items.some((item) => item.files) ? { files: [...new Set(args.items.flatMap((item) => item.files ?? []))] } : {}), alertAt: new Date(now()).toISOString(), ...(ask ? { ask } : {}) }
      };
      const signinRefused = await deps.signinCard?.(raise).catch(() => null);
      if (signinRefused) return { ok: false, refused: true, display: signinRefused.startsWith("Not raised: nothing shows an account") ? "No account shows at that site yet" : signinRefused.startsWith("Not raised: a bot check comes last") ? "Fill the page first" : signinRefused.includes("nous_msg:83c0acb8") ? "Not needed: focus only when needed" : "The tab runs in another Google account", result: signinRefused };
      const card = await deps.notifications.raise(raise, { realert: Boolean(current) });
      for (const ref of held.keys()) await deps.notifications.addPayload?.(owner, ref, { heldForNous: { until: new Date(now() + 30 * 86_400_000).toISOString(), card: card.id } }).catch(() => null);
      return { ok: true, display: `${current ? "Updated" : "Sent"} the operator's card for ${where} (${args.items.length} item${args.items.length === 1 ? "" : "s"})`,
        result: `Notification ${card.id}. Resolve it with space_resolve_notification when nothing is left there.` };
    },

    /** Daily Nous errors 13/11 (agent cards 079c6e5a AWS code, 85a5c16a npm: held for Nous up to an hour while each notify and focus on their pane was
     *  refused as "already asks"): Nous forwarding a pane agent's held card shows it now, Nous's note first and its pick as the recommendation.
     *  Null when it is not held for Nous (shown already, or an allowance's). */
    async release(owner: string, card: SpaceNotification, items: Array<{ text: string; question?: string; recommended?: string; steps?: string[] }>): Promise<SpaceNotification | null> {
      if (!card.payload.heldForNous || heldUnderAllowance(card) || !deps.notifications.releaseHeldForNous) return null;
      const ask = card.payload.ask as NeedsYouAsk | undefined;
      const pick = items.find((item) => item.recommended && ask?.options?.includes(item.recommended))?.recommended;
      const note = items.map((item) => [item.text, item.question, ...item.steps ?? [], item.recommended ? `Recommended: "${item.recommended}".` : ""].filter(Boolean).join(" ")).join("\n");
      // Nous's note leads: a body over 2,000 characters keeps its start.
      return deps.notifications.releaseHeldForNous(owner, card.id, { body: `Nous: ${note}\n\n${card.body}`, payload: { nousItems: items, ...(pick ? { ask: { ...ask, recommended: pick } } : {}) } });
    },
    /** R66: every open Nous card (every pane) and every open pane agent's needs-you card, for the duplicate-subject check before a new item. */
    async open(owner: string): Promise<SpaceNotification[]> {
      return [...await openCards(owner), ...(await allNotifications(deps.notifications.list, owner, { status: "WAITING", source: "AGENT" })).filter((item) => agentAsk(item) && live(item))];
    },
    /** 13/11 REVIEW (one npm 2FA link on 3 cards): Nous's pane cards and agents' needs-you cards raised since `since` that are closed now, for the same check. */
    async closedSince(owner: string, since: number): Promise<SpaceNotification[]> {
      const out: SpaceNotification[] = [];
      for (const source of ["NOUS", "AGENT"] as const) {
        for (let before: string | undefined; ;) {
          const page = await deps.notifications.list(owner, { status: "ALL", source, limit: 200, ...(before ? { before } : {}) });
          const fresh = page.filter((item) => Date.parse(item.createdAt) >= since);
          // 17/11 (card 1e91952e resolved unread by its pane's done): a card closed with no read and no answer never reached the operator, so it asks nothing.
          out.push(...fresh.filter((item) => !live(item) && (item.readAt || item.payload.answer) && (agentAsk(item) || (item.source === "NOUS" && nousKey(item.dedupeKey)))));
          if (page.length < 200 || fresh.length < page.length) break;
          before = page.at(-1)!.createdAt;
        }
      }
      return out;
    },

    /** The world's section: Nous's open cards, so it can update or resolve them; empty when there are none. */
    async summary(owner: string, names: { room(id: string | null): string | null; pane(id: string | null): string | null }): Promise<string> {
      const cards = await openCards(owner);
      if (!cards.length) return "";
      // Inbox upgrade step 3 (plan clipboard:LkwKdOOh2mXK: a Huawei CAPTCHA card stayed after its work moved to the audio solver): each card's age,
      // and its cause ending (work moved elsewhere or ended) resolves it, not only the operator's hands.
      return ["## Your cards to the operator (space_notify_operator: one per pane; resolve with space_resolve_notification when done, or when its work "
        + "moved elsewhere or ended: a card whose cause is gone is a stale card)",
        ...cards.map((card) => {
          const items = Array.isArray(card.payload.items) ? card.payload.items.length : card.body.split("\n").length;
          return `- [${card.id}] ${card.title} · ${names.pane(card.paneId) ?? (typeof card.payload.planId === "string" ? `plan ${card.payload.planId}` : "no pane")} in ${names.room(card.roomId) ?? "a room"} · ${items} item${items === 1 ? "" : "s"} · since ${card.createdAt.slice(11, 16)} UTC${card.status === "READ" ? " · read" : ""}`;
        })].join("\n");
    },

    /** Cards of panes that are no longer open are resolved (the world calls this with the owner's open panes). */
    async reconcile(owner: string, openPaneIds: ReadonlySet<string>): Promise<number> {
      let resolved = 0;
      for (const card of await openCards(owner)) {
        const paneId = card.dedupeKey?.startsWith(NOUS_PANE_NOTICE_PREFIX) ? card.dedupeKey.slice(NOUS_PANE_NOTICE_PREFIX.length) : null;
        if (!paneId || openPaneIds.has(paneId)) continue;
        // Its asks move to the plan the pane worked on first (operator 13/11 nous_msg:2e24947d), as on PANE_CLOSED (browser-handoff.ts).
        // A failed move keeps the card (operator 15/11 nous_msg:9f70dbbe: an ask never leaves Needs you unanswered).
        if (await Promise.resolve(deps.carry?.(owner, paneId)).then(() => false, () => true)) continue;
        resolved += await deps.notifications.resolve(owner, card.dedupeKey!, "its pane is gone");
      }
      return resolved;
    }
  };
}
export type NousPaneNotices = ReturnType<typeof createNousPaneNotices>;
