import { NEEDS_YOU_GO_NOW, sameNeedsYouTopic, type NotificationRaiseInput, type SpaceNotification } from "@space/contracts";
import { OPERATOR_ORDER_ID } from "../signin-readback.js";
import type { ChallengeAttempt } from "../browser-challenge-attempt.js";
export { CHALLENGE_ATTEMPT_ACTION, pageAddress, type ChallengeAttempt } from "../browser-challenge-attempt.js";
import { BOT_CHECK_ASK, CHECKOUT_CARD_FORM_READY, CHECKOUT_PAYMENT_ASK, ORDER_ITEM } from "./tools.js";

/**
 * Operator rule 13/11 11:21 BKK (nous_msg:83c0acb8, request nous_msg:40c57252): «μου δινει focus οταν και αν χρειαζεται!! -- που αφορα captcha
 * που δεν μπορει να περάσει με το εσωτερικο εργαλειο που εχουμε ή καποιο δεδομενο που δεν ξερει π.χ. καρτα!!». A hands card (an agent's needs-you,
 * Nous's space_notify_operator and space_focus_pane, all through signinCard in wiring.ts) reaches the operator only for (a) a CAPTCHA the internal
 * solver tried on that page and could not pass, (b) data the agent cannot get (a card at its field; personal data the Vault, mail and memory lack),
 * never with (c) steps or a time of day, and (d) never again for what the operator already answered.
 */

/** The audit action every solver run writes (the CDP challenge route, the text CAPTCHA command), on the CLI pane and the browser pane. */
export interface FocusNeedDeps {
  /** The newest solver run recorded on the pane, or null. */
  latestAttempt(paneId: string): Promise<ChallengeAttempt | null>;
  /** The pane's agent needs-you cards (every status). */
  agentCards(owner: string, paneId: string): Promise<SpaceNotification[]>;
  /** How many payment cards the owner's Vault lets agents fill; null when it cannot be told (no Vault, agent access off). */
  vaultCards?(owner: string): Promise<number | null>;
  now?: () => number;
}

const REFUSED = (why: string) => `Not raised: ${why} (operator rule 13/11 nous_msg:83c0acb8: focus only when it is needed, for a CAPTCHA the internal solver cannot pass or data the agent cannot know, such as a card). Nothing raised.`;
// A challenge page goes stale within minutes; an older run says nothing about the page now.
const ATTEMPT_FRESH_MS = 30 * 60_000;
// The same window as Nous's own answered-twin check (R16-2 in pane-notices.ts).
const ANSWER_HOLDS_MS = 2 * 3_600_000;
const SOLVED = new Set(["CLEARED", "ALREADY_VERIFIED", "TOKEN_ISSUED"]);
/** Statuses that hand the next step back to the agent (choose tiles, read the text, inspect again), never a failure. */
const IN_LOOP = new Set(["IMAGE_CHALLENGE", "AUDIO_CHALLENGE", "TEXT_CHALLENGE", "STALE_CHALLENGE", "CHALLENGE_CHANGED", "IMAGE_NOT_READY", "SUBMITTED", "INVISIBLE_IDLE", "ACTION_REQUIRED"]);
const SOLVERS = "space_browser_cloudflare, space_browser_hcaptcha, space_browser_recaptcha, space_browser_press_hold, space_browser_slider_captcha or space_browser_text_captcha";
const SOLVER_FAILED = /\bsolver failed\b/i;
const DATA_ASK = /\b(?:your|the operator'?s)\s+(?:(?:full|legal)\s+name|(?:phone|mobile|telephone)\s+number|(?:home\s+|postal\s+|billing\s+|street\s+)?address|post\s?code|zip(?:\s+code)?|iban|vat(?:\s+(?:number|id))?|tax\s+(?:id|number)|date\s+of\s+birth|birth\s?date|passport(?:\s+number)?|id\s+(?:card\s+)?number|national\s+id|bank\s+account(?:\s+number)?|e-?mail\s+address)\b|τηλέφωνό\s+σου|διεύθυνσή\s+(?:σου|σας)|(?<!\p{L})(?:ΑΦΜ|ΑΜΚΑ)(?!\p{L})|ημερομηνία\s+γέννησης|διαβατηρίου|αριθμό\s+ταυτότητας/iu;
const SOURCES: Array<[string, RegExp]> = [["the Vault", /vault|θησαυροφυλάκ/i], ["mail", /\bmail|inbox|gmail|αλληλογραφ/i], ["Space Memory", /memory|μνήμη/i]];
const STEP_VERB = String.raw`(?:open|go\s+to|visit|navigate|click|tap|press|hit|select|choose|pick|enter|type|paste|fill|sign\s+in|log\s+in|copy|scroll|approve|confirm|accept|tick|upload|download|install|run|switch|ανοίξτε|άνοιξε|πήγαινε|πάτα|πατήστε|πάτησε|επίλεξε|επιλέξτε|γράψε|πληκτρολόγησε|συνδέσου|μπες|κάνε\s+κλικ|αντίγραψε|επικόλλησε|βάλε)(?!\p{L})`;
const NUMBERED_STEP = new RegExp(String.raw`(?:^|\s)(?:\d{1,2}[.)]|step\s+\d{1,2}:?|βήμα\s+\d{1,2}:?)\s*(?:then\s+)?${STEP_VERB}`, "giu");
const STEPS_LABEL = /(?:^|\n)\s*(?:steps|instructions|βήματα|οδηγίες)\s*:/iu;
const WHEN_QUESTION = /\b(?:when|what time)\b[^?\n]{0,60}\b(?:focus|bring you|hand (?:it )?over|(?:are|will) you (?:be )?(?:free|available|around))\b|(?:πότε|τι ώρα)(?!\p{L})[^?\n]{0,60}(?:focus|διαθέσιμ|ελεύθερ|μπορείς)/iu;
const NOW_OPTION = /^\s*(?:(?:right|go)\s+)?now(?![a-z])|^\s*τώρα/i;
const TIME_OPTION = /\b(?:later|tonight|tomorrow|this (?:evening|afternoon|morning)|in the (?:evening|afternoon|morning)|batch|\d{1,2}:\d{2}|\d{1,2}\s?(?:am|pm))\b|(?:^|\s)at \d{1,2}\b|αργότερα|απόψε|αύριο|το (?:βράδυ|πρωί|απόγευμα)|στις \d/i;
// 13/11 lessons-hands-cards-ready-now (nous_msg:d1f0bc5e): 6 cards asked «Είσαι έτοιμος τώρα…;» / "Ready now to…?" (Link SpaceApp, npm key, pairing QR); the operator wants the act and its link.
const READY_QUESTION = /(?:\bare\s+you\s+ready\b|\bready\s+now\b|(?:^|[:\n]\s*)ready\s+to\b|(?:είσαι|είστε)\s+[εέ]τοιμ\p{L}*|[εέ]τοιμ(?:ος|η|οι)\s+τώρα)[^?;\u037e\n]{0,240}[?;\u037e]/iu;
// 14/11 REVIEW (queue: 22 cards answered against the recommendation in 24 h; Link SpaceApp, npm key, pairing QR): the readiness came as an option
// («Έτοιμος τώρα», "Ready now"), so a card asking the act itself still predicted readiness and missed.
const READY_OPTION = /^\s*(?:i'?m\s+|i\s+am\s+|είμαι\s+)?(?:ready\s+(?:now|to)\b|[εέ]τοιμ(?:ος|η|οι)(?!\p{L})|[εέ]τοιμ\p{L}*\s+τώρα)/iu;
// 13/11 ledger (plan USQ6ktIIN_1D step 3): 9 hands cards asked whether the operator will do the act («Θα βάλεις την κάρτα…;», «Μπαίνεις τώρα στο Stripe…;»,
// "Can you type the code now?", "When will you do it?"); every answer was a MISS: "open it and give me focus", "do it yourself" or "give me the link".
// 14/11: "When do you do the Mercor Domain Expert interview?" (17:27Z, after this guard reached stable) asked the same without "will".
const WILL_YOU_QUESTION = /(?:\bwill\s+you\b|\bwhen\s+(?:do|can|could|would|are)\s+you\b|(?:^|[\s«"(])πότε\s+\p{L}+(?:εις|είς|άς)(?!\p{L})|\b(?:can|could)\s+you\b[^?\n]{0,200}\bnow\b|(?:^|[\s«"(])θα\s+\p{L}+εις(?!\p{L})|\p{L}+(?:εις|είς|άς)\s+(?:ξανά|τώρα)(?!\p{L}))[^?;\u037e\n]{0,240}[?;\u037e]/iu;
const ANSWER_CHANGED = /since (?:the|their|that) answer|answer no longer holds/i;
const BANK_APPROVAL = /3-?d ?secure|\b3ds\b|bank(?:ing)?(?: |')?app|in the \S+ app\b|τράπεζ|τραπεζ/i;
/** The agent filled the Vault card (or the fill was refused, which it names). */
const VAULT_CARD_TRIED = /card[- _]?fill|fill\S*[^.\n|]*\bvault|vault[^.\n|]*\bfill|CARD_NEEDS_HOST_RESTART|CARD_NEEDS_HTTPS|NOT_DELEGATED|ORIGIN_MISMATCH/i;

const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
/** What the card asks the operator, without what it says was checked: Nous's items, or the agent's summary, needs and options. */
export function cardAsk(input: Pick<NotificationRaiseInput, "title" | "body" | "payload">): { texts: string[]; options: string[][]; steps: string[] } {
  const items = Array.isArray(input.payload?.items) ? input.payload.items as Array<Record<string, unknown>> : null;
  if (items) return { texts: [input.title, ...items.flatMap((item) => [item.text, item.question].filter((text): text is string => typeof text === "string"))],
    options: items.map((item) => strings(item.options)), steps: items.flatMap((item) => strings(item.steps)) };
  return { texts: [input.title, input.body], options: [strings(input.payload?.options)], steps: [] };
}
const hostOf = (url: string | null | undefined) => { try { return new URL(url ?? "").hostname.replace(/^www\./, ""); } catch { return null; } };

/** (c) Steps for the operator or a time of day for the focus; the operator's own order in `checked` overrides. */
export function stepsOrTimingRefusal(ask: ReturnType<typeof cardAsk>): string | null {
  const text = ask.texts.join("\n");
  if (ask.steps.length || (text.match(NUMBERED_STEP)?.length ?? 0) >= 2 || STEPS_LABEL.test(text)) {
    return REFUSED("a card carries no steps for the operator. Do every step yourself up to the one only they can do, then hand them focus there with no list");
  }
  if (WHEN_QUESTION.test(text) || ask.options.some((options) => options.some((option) => NOW_OPTION.test(option)) && options.some((option) => TIME_OPTION.test(option)))) {
    return REFUSED("focus is never scheduled for a time of day. Raise the card when the step is ready, and only then");
  }
  if (READY_QUESTION.test(text) || ask.options.some((options) => options.some((option) => READY_OPTION.test(option)))) {
    return REFUSED("a card never asks whether the operator is ready. Ask for the act itself with its link or target (a fresh code, link or QR made the moment they press Go now is fine); they answer by doing it");
  }
  if (WILL_YOU_QUESTION.test(text)) {
    return REFUSED("a card never asks whether or when the operator will do the act. Do it yourself when the Vault, mail or memory hold what it needs; otherwise bring the page to the one step only they can do and ask for that act with its link (\"Enter the card at the Cartesia checkout\"); they answer by doing it");
  }
  return null;
}

export async function focusNeedHold(deps: FocusNeedDeps, input: NotificationRaiseInput): Promise<string | null> {
  const now = deps.now?.() ?? Date.now();
  const checked = strings(input.payload?.checked);
  if (checked.some((line) => OPERATOR_ORDER_ID.test(ORDER_ITEM.exec(line)?.[1] ?? ""))) return null;
  const ask = cardAsk(input);
  const text = ask.texts.join("\n");
  const shape = stepsOrTimingRefusal(ask);
  if (shape) return shape;
  // (b) A card number or CVC is data no agent holds, handed over at the card field only.
  const card = CHECKOUT_PAYMENT_ASK.test(text);
  // ...unless the Vault holds a card: the agent fills it and pays; the operator only approves 3-D Secure (13/11 nous_msg:40c57252, nous_msg:ce2b295632).
  if (card && !BANK_APPROVAL.test(text) && !checked.some((line) => VAULT_CARD_TRIED.test(line)) && (await deps.vaultCards?.(input.ownerUserId) ?? 0) > 0) {
    return REFUSED("the Vault holds the operator's card. Bring the page to the card form, fill it with space_vault_card_fill, check the total and press Pay yourself; raise a card only for the 3-D Secure approval in the bank app (\"card fields filled from the Vault…\" in `checked`), or name the fill's refusal in `checked`");
  }
  if (card && !checked.some((line) => CHECKOUT_CARD_FORM_READY.test(line))) {
    return REFUSED("a card is asked at its field. Bring the page to the card form yourself (sign-in, plan, amount, every other field), then raise it and say so in `checked` (\"at the card form: …\")");
  }
  // shortcut: the Vault, mail and memory are searched by the agent and named in `checked`; a server-side lookup would need each store's search here.
  if (!card && DATA_ASK.test(text)) {
    const missing = SOURCES.filter(([, named]) => !checked.some((line) => named.test(line))).map(([name]) => name);
    if (missing.length) return REFUSED(`this data may already be known. Search ${missing.join(", ")} for it and name each one and what it showed in \`checked\`; ask only for what none of them holds`);
  }
  // (a) A CAPTCHA goes to the operator once the internal solver tried this page and could not pass it.
  if (!card && BOT_CHECK_ASK.test(text) && !DATA_ASK.test(text)) {
    // shortcut: a card on no pane has no solver run to read; it passes as before.
    const attempt = input.paneId ? await deps.latestAttempt(input.paneId) : null;
    const target = input.link?.target ?? null;
    const samePage = attempt && Date.parse(attempt.at) >= now - ATTEMPT_FRESH_MS
      && (!target?.startsWith("url:") || hostOf(target.slice(4)) === hostOf(attempt.url))
      && (!target?.startsWith("tab:") || target.slice(4) === attempt.pageId);
    if (input.paneId && !samePage) return REFUSED(`no internal solver ran on this page in the last 30 minutes. Run ${SOLVERS} on it first; raise the card only if it cannot pass`);
    if (attempt && samePage && SOLVED.has(attempt.status)) return REFUSED(`the solver answered ${attempt.status} on this page. Look at the page and go on`);
    if (attempt && samePage && IN_LOOP.has(attempt.status) && !checked.some((line) => SOLVER_FAILED.test(line))) {
      return REFUSED(`the solver answered ${attempt.status}: its next step is yours (choose the tiles, read the text, inspect again). Finish its loop; if it still cannot pass, say "solver failed: …" in \`checked\``);
    }
  }
  // (d) An agent's card about what the operator answered on this pane in the last 2 hours (Nous's cards have heldAnswer and R16-2).
  if (input.source === "AGENT" && input.paneId && !checked.some((line) => ANSWER_CHANGED.test(line))) {
    const answered = (await deps.agentCards(input.ownerUserId, input.paneId)).filter((item) => item.source === "AGENT" && item.kind === "NEEDS_YOU");
    for (const item of answered) {
      const answer = item.payload.answer as { text?: unknown; at?: unknown } | undefined;
      if (typeof answer?.text !== "string" || answer.text === NEEDS_YOU_GO_NOW || typeof answer.at !== "string" || Date.parse(answer.at) < now - ANSWER_HOLDS_MS) continue;
      if (sameNeedsYouTopic({ ...input, link: input.link ?? {} }, item)) {
        return REFUSED(`the operator answered this at ${answer.at.slice(11, 16)} UTC: "${answer.text.slice(0, 160)}". Act on that answer; if something changed since, say what in \`checked\` ("since the answer: …")`);
      }
    }
  }
  return null;
}
