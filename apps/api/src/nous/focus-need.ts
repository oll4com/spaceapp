import { NEEDS_YOU_GO_NOW, sameNeedsYouTopic, type NotificationRaiseInput, type SpaceNotification } from "@space/contracts";
import { OPERATOR_ORDER_ID } from "../signin-readback.js";
import type { ChallengeAttempt } from "../browser-challenge-attempt.js";
export { CHALLENGE_ATTEMPT_ACTION, pageAddress, type ChallengeAttempt } from "../browser-challenge-attempt.js";
import { BOT_CHECK_ASK, cardAsk, CHECKOUT_CARD_FORM_READY, CHECKOUT_PAYMENT_ASK, DATA_ASK, documentAskMissing, FOCUS_REFUSED, noQuestionRefusal, ORDER_ITEM, stepsOrTimingRefusal } from "./tools.js";

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

const REFUSED = FOCUS_REFUSED;
// A challenge page goes stale within minutes; an older run says nothing about the page now.
const ATTEMPT_FRESH_MS = 30 * 60_000;
// The same window as Nous's own answered-twin check (R16-2 in pane-notices.ts).
const ANSWER_HOLDS_MS = 2 * 3_600_000;
const SOLVED = new Set(["CLEARED", "ALREADY_VERIFIED", "TOKEN_ISSUED"]);
/** Statuses that hand the next step back to the agent (choose tiles, read the text, inspect again), never a failure. */
const IN_LOOP = new Set(["IMAGE_CHALLENGE", "AUDIO_CHALLENGE", "TEXT_CHALLENGE", "STALE_CHALLENGE", "CHALLENGE_CHANGED", "IMAGE_NOT_READY", "SUBMITTED", "INVISIBLE_IDLE", "ACTION_REQUIRED"]);
const SOLVERS = "space_browser_cloudflare, space_browser_hcaptcha, space_browser_recaptcha, space_browser_press_hold, space_browser_slider_captcha, space_browser_text_captcha or space_browser_audio_captcha";
const SOLVER_FAILED = /\bsolver failed\b/i;
const SOURCES: Array<[string, RegExp]> = [["the Vault", /vault|θησαυροφυλάκ/i], ["mail", /\bmail|inbox|gmail|αλληλογραφ/i], ["Space Memory", /memory|μνήμη/i]];
const ANSWER_CHANGED = /since (?:the|their|that) answer|answer no longer holds/i;
const BANK_APPROVAL = /3-?d ?secure|\b3ds\b|bank(?:ing)?(?: |')?app|in the \S+ app\b|τράπεζ|τραπεζ/i;
/** The agent filled the Vault card (or the fill was refused, which it names). */
const VAULT_CARD_TRIED = /card[- _]?fill|fill\S*[^.\n|]*\bvault|vault[^.\n|]*\bfill|CARD_NEEDS_HOST_RESTART|CARD_NEEDS_HTTPS|NOT_DELEGATED|ORIGIN_MISMATCH/i;

const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
const hostOf = (url: string | null | undefined) => { try { return new URL(url ?? "").hostname.replace(/^www\./, ""); } catch { return null; } };


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
  // 2026-11-15 REVIEW (AADE/bank document card answered "download it yourself / search mail"): a document is fetched by the agent first.
  const fetchFirst = card ? null : documentAskMissing(text, checked);
  if (fetchFirst) return REFUSED(fetchFirst);
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
  // Last, so a card's more specific refusal (a document to fetch, a solver to run) names what to do first.
  // A copilot's or pane's card carries its question in payload.ask ("What should Mail Copilot do with this mail?").
  const asked = (input.payload?.ask as { question?: unknown } | undefined)?.question;
  return noQuestionRefusal(typeof asked === "string" ? { ...ask, texts: [...ask.texts, asked] } : ask);
}
