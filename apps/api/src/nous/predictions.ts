import { NEEDS_YOU_GO_NOW, nousAnswerIntent, type NousDecision, type SpaceNotification } from "@space/contracts";
import { foldWords } from "./retrieval.js";

type Predicted = Pick<NousDecision, "recommendation" | "body"> & { refs?: { prediction?: { answer: string } } };

/**
 * Goal 7365014c (zero approvals by 30/11, learn from every yes and no): how often the operator answered as Nous predicted. A decision's
 * prediction is the «Πρόβλεψη: ναι (90%)» / "Prediction: no" line of its recommendation or body; a card's is its ask's recommended option.
 */
export function decisionPrediction(decision: Predicted): "APPROVE" | "DECLINE" | null {
  // R12-11: the prediction the server stored wins over the text.
  const stored = decision.refs?.prediction?.answer.toLowerCase();
  if (stored) return stored === "yes" ? "APPROVE" : stored === "no" ? "DECLINE" : null;
  const word = /(?:Πρόβλεψη|Prediction)\s*:\s*([^\s(.,;:]+)/iu.exec(`${decision.recommendation ?? ""}\n${decision.body ?? ""}`)?.[1]?.toLowerCase();
  if (!word) return null;
  if (/^(?:ναι|yes|approve|έγκριση)/u.test(word)) return "APPROVE";
  return /^(?:όχι|οχι|no|decline|απόρριψη)/u.test(word) ? "DECLINE" : null;
}

/**
 * R11-3 (29/10: the ledger stored predicted = null for f229736d «Πρόβλεψη: (α)+(β)+(γ) (80%)» and 47f01ad9 «Πρόβλεψη: επιλογή 1 …»): a
 * prediction that names an option, not yes or no: its text before the "(N%)".
 */
export function decisionPredictedOption(decision: Predicted): string | null {
  if (decisionPrediction(decision)) return null;
  if (decision.refs?.prediction) return decision.refs.prediction.answer;
  const text = /(?:Πρόβλεψη|Prediction)\s*:\s*([^\n]+?)\s*(?:\(\s*\d{1,3}\s*%\s*\)|$)/imu.exec(`${decision.recommendation ?? ""}\n${decision.body ?? ""}`)?.[1]?.trim();
  return text ? text.replace(/[.…]+$/u, "").trim().slice(0, 200) || null : null;
}

/** R12-11: an ask's prediction from its «Πρόβλεψη» / "Prediction" line, as the server stores it ("yes", "no" or the option); null without one. */
export function textPrediction(decision: Predicted): { answer: string; confidence: number | null; written?: true } | null {
  const yesNo = decisionPrediction(decision);
  const answer = yesNo ? (yesNo === "APPROVE" ? "yes" : "no") : decisionPredictedOption(decision);
  if (!answer) return null;
  const percent = /(?:Πρόβλεψη|Prediction)\s*:[^\n]*?\(\s*(\d{1,3})\s*%\s*\)/iu.exec(`${decision.recommendation ?? ""}\n${decision.body ?? ""}`)?.[1];
  return { answer, confidence: percent && Number(percent) <= 100 ? Number(percent) : null };
}

/** An option's marks: letters or numbers in parentheses or after "option"/«επιλογή», else its case-folded words. */
function optionMarks(text: string): Set<string> {
  const lower = text.toLowerCase();
  const marks = [...lower.matchAll(/\(\s*([\p{L}]|\d{1,2})\s*\)|(?:option|επιλογή|επιλογη)\s*([\p{L}]|\d{1,2})\b|^\s*([\p{L}]|\d{1,2})\s*[).:]/gmu)].map((match) => match[1] ?? match[2] ?? match[3]!);
  if (marks.length) return new Set(marks);
  // "α, β και γ", "1 and 3": a list of single letters or numbers is that set of options.
  const tokens = lower.split(/[^\p{L}\p{N}]+/u).filter((token) => token && token !== "και" && token !== "and");
  if (tokens.length && tokens.every((token) => /^(?:\p{L}|\d{1,2})$/u.test(token))) return new Set(tokens);
  return new Set([lower.replace(/\s+/g, " ").trim()]);
}

/**
 * Whether the operator answered as an option prediction said: an APPROVED decision chose its recommended option, an ANSWERED one is
 * read from their words (the option's letter or number is enough, case-folded); a DECLINED one chose none.
 */
export function optionPredictionMatched(predicted: string, decision: Pick<NousDecision, "recommendation"> & { refs?: { prediction?: { written?: true } } },
  status: string, answer: string | null): boolean | null {
  if (decision.refs?.prediction?.written) return writtenPredictionMatched(predicted, status, answer);
  if (status === "DECLINED") return false;
  const said = status === "APPROVED" ? decision.recommendation ?? "" : status === "ANSWERED" ? answer ?? "" : "";
  if (!said.trim()) return null;
  const want = optionMarks(predicted);
  const got = optionMarks(said);
  if ([...want].some((mark) => mark.length > 2) || [...got].some((mark) => mark.length > 2)) {
    const [a, b] = [predicted.toLowerCase(), said.toLowerCase()];
    return a.includes(b.trim()) || b.includes(a.trim());
  }
  return want.size === got.size && [...want].every((mark) => got.has(mark));
}

const YES_NO = new Set(["yes", "ναι", "οχι"]);
const lead = (text: string): "APPROVE" | "DECLINE" | null => {
  const word = text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().match(/\p{L}+/u)?.[0];
  return word === "yes" || word === "ναι" || word === "ok" || word === "οκ" ? "APPROVE" : word === "no" || word === "οχι" ? "DECLINE" : null;
};
// What the operator said: the button, else their words read as a bare yes or no, else the yes or no their words lead with.
const answerLead = (status: string, answer: string | null) =>
  status === "APPROVED" ? "APPROVE" : status === "DECLINED" ? "DECLINE" : answer ? nousAnswerIntent(answer) ?? lead(answer) : null;
const stems = (text: string) => new Set(foldWords(text).filter((word) => !YES_NO.has(word)).map((word) => word.slice(0, 5)));

/**
 * Goal 7365014c step 2 (6/11: 26 of 42 misses were written answers): a predicted written answer ("yes, but all in one week") matches when
 * its yes or no agrees with the operator's and at least half of its other words (accent-folded, first 5 letters) are in what they wrote.
 */
export function writtenPredictionMatched(predicted: string, status: string, answer: string | null): boolean | null {
  const want = lead(predicted);
  const got = answerLead(status, answer);
  if (want && got && want !== got) return false;
  const words = stems(predicted);
  if (!words.size) return want && got ? want === got : null;
  const said = stems(answer ?? "");
  if (!said.size) return status === "ANSWERED" ? null : false;
  return [...words].filter((word) => said.has(word)).length * 2 >= words.size;
}

/** 14/11: a yes or no prediction matches a written answer that leads with the same yes or no («Ναι, 12:15 στο PC μου»), not only the buttons. */
export function yesNoPredictionMatched(predicted: "APPROVE" | "DECLINE", status: string, answer: string | null): boolean {
  return answerLead(status, answer) === predicted;
}

export interface PredictionScore { matched: number; total: number }

/** Decisions answered since `since` by the operator (not an "Always approve" or away grant) and Nous's cards answered since then. */
export function predictionAccuracy(decisions: NousDecision[], cards: SpaceNotification[], since: string): { decisions: PredictionScore; cards: PredictionScore } {
  const scored = { decisions: { matched: 0, total: 0 }, cards: { matched: 0, total: 0 } };
  for (const decision of decisions) {
    if ((decision.answeredAt ?? "") < since || !["APPROVED", "DECLINED", "ANSWERED"].includes(decision.status)) continue;
    if (/^Approved by (?:your "Always approve"|away grant|allowance )/.test(decision.answer ?? "")) continue;
    const predicted = decisionPrediction(decision);
    if (!predicted) {
      // R11-3: an option prediction counts too.
      const option = decisionPredictedOption(decision);
      const matched = option ? optionPredictionMatched(option, decision, decision.status, decision.answer) : null;
      if (matched === null) continue;
      scored.decisions.total += 1;
      if (matched) scored.decisions.matched += 1;
      continue;
    }
    scored.decisions.total += 1;
    if (yesNoPredictionMatched(predicted, decision.status, decision.answer)) scored.decisions.matched += 1;
  }
  for (const card of cards) {
    const matched = cardAnswerMatched(card, since);
    if (matched === null) continue;
    scored.cards.total += 1;
    if (matched) scored.cards.matched += 1;
  }
  return scored;
}

/** A card the operator answered since `since` against its recommended option: whether they chose it; null when not scored. */
// R21-pred-1 (ledger 166 «ειναι ετοιμο εβαλα καρτα -- προχωρησε την χρεωση» on "Card added", 168 «ναι δουλεψε μια χαρα» on "Installed, download works",
// both scored MISS): words that say yes or that the act is done confirm a recommended option that is itself the affirmative one.
const NOT_AFFIRMATIVE = /\b(fail\w*|still|need|not|no|cannot|can'?t|later|tomorrow|skip|stop|cancel|decline|reject)\b|δεν|όχι|οχι|αργότερα|αυριο|αύριο/iu;
// JavaScript's \b sees no Greek letter as a word character: the word ends at a space, a mark or the end. R60 (2-3/11: «στο προσθεσα», «μολις
// ανεβασα», «τον αλλαξα» scored MISS): the act done with its object («άλλαξα» alone is also "I changed my mind"), after «μόλις» too.
const DONE_WORDS = /^\s*(?:μόλις\s+|μολις\s+)?(?:ναι|ok|οκ|έτοιμο|ετοιμο|είναι έτοιμο|ειναι ετοιμο|έγινε|εγινε|το έκανα|το εκανα|έκανα|εκανα|έβαλα|εβαλα|δουλεύει|δουλευει|δούλεψε|δουλεψε|(?:στο |το |τα )?(?:πρόσθεσα|προσθεσα|ανέβασα|ανεβασα)|(?:τον|την|το|τα) (?:άλλαξα|αλλαξα)|done|ready|did it|installed|works|it works|yes)(?=$|[\s,.!;:—–-])/iu;
// R74 (4/11 UNICEF card: «Ναι, όλα Όχι» answered «ναι σε όλα …» scored MISS): an option opening with yes is affirmative though it says no later,
// when it is the card's only option that opens with yes.
const YES_FIRST = /^\s*(?:ναι|yes)(?=$|[\s,.!;:—–-])/iu;
export function cardWordsConfirm(recommended: string | null | undefined, words: string | null | undefined, intent: "APPROVE" | "DECLINE" | null, options: readonly string[] = []): boolean {
  const yesFirst = !!recommended && YES_FIRST.test(recommended) && !options.some((option) => option !== recommended && YES_FIRST.test(option));
  if (!recommended || !words?.trim() || (NOT_AFFIRMATIVE.test(recommended) && !yesFirst) || /\?\s*$/u.test(words)) return false;
  return intent === "APPROVE" || DONE_WORDS.test(words);
}

export function cardAnswerMatched(card: SpaceNotification, since: string): boolean | null {
  const recommended = (card.payload.ask as { recommended?: unknown } | undefined)?.recommended;
  const answer = card.payload.answer as { text?: unknown; at?: unknown; by?: unknown } | undefined;
  // Space's own answers, on "Always answer like this" (7365014c-d) or the standing timing answer (R16-3), are not the operator's.
  if (typeof recommended !== "string" || typeof answer?.text !== "string" || String(answer.at ?? card.updatedAt) < since || answer.by === "ALWAYS" || answer.by === "TIMING") return null;
  // R38: a "Go now" visit (R27-2) only takes the operator to the work; while the card still waits its outcome is unknown, so it is not scored yet.
  if (answer.text === NEEDS_YOU_GO_NOW && (card.status === "OPEN" || card.status === "READ")) return null;
  return cardTextMatched(card.payload.ask as { recommended?: unknown; options?: unknown }, answer.text);
}

// "I'll type it" options: the operator typing the value is that option (R38: 27/10 a postal address and a postal code scored MISS).
// R60 (2/11 0c53714e: the IBAN typed on «Στέλνω ελληνικό IBAN + ΑΦΜ» scored MISS): "I send it" is the same.
const TYPE_IT = /^(?:i'?ll|i will)\s+(?:type|write|enter|send)\b|^θα\s+(?:το\s+)?(?:γράψω|γραψω|πληκτρολογήσω|πληκτρολογησω|στείλω|στειλω)|^(?:στέλνω|στελνω)(?=\s|$)/iu;
/**
 * The one matcher of a card's stored answer against its recommended option, for the scorecard, the REVIEW and the decision ledger (R38):
 * the option itself or with a note (R19-3: "<option>: <note>"); else, when the answer is no option of the card, a typed value on an
 * "I'll type it" option, or words confirming the affirmative option (R21-pred-1). Any other text, or another option, is a miss.
 */
export function cardTextMatched(ask: { recommended?: unknown; options?: unknown }, stored: string): boolean {
  const recommended = typeof ask.recommended === "string" ? ask.recommended : "";
  const text = stored.trim();
  if (!recommended || !text) return false;
  if (text === recommended || text.startsWith(`${recommended}: `)) return true;
  const options = Array.isArray(ask.options) ? ask.options.filter((option): option is string => typeof option === "string") : [];
  if (options.some((option) => text === option || text.startsWith(`${option}: `))) return false;
  const intent = nousAnswerIntent(text);
  if (TYPE_IT.test(recommended)) return intent !== "DECLINE" && !/[?;]\s*$/u.test(text);
  return cardWordsConfirm(recommended, text, intent, options);
}

export const predictionText = ({ matched, total }: PredictionScore) => total ? `${matched} of ${total} as predicted (${Math.round((100 * matched) / total)}%)` : "none to score";
