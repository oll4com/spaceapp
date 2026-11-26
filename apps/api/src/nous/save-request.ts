/**
 * The texts of a finished pane's memory save (standing orders, operator orders 2026-10-21), on their own so tools.ts (which records
 * what Nous sent) and standing-orders.ts (which verifies and lists it) share them without a dependency cycle.
 */
import { SPACE_INSTALL_ROOT } from "@space/contracts";

/** The web quick action's exact text: the CLI runs <install root>/bin/space-memory-save on it (bootstrap "Memory parity"). */
export const NOUS_SAVE_TEXT = "save to memory";
export const NOUS_SAVE_RETRY_TEXT = `Run ${SPACE_INSTALL_ROOT}/bin/space-memory-save with a title, tags and a body of what you learned in this pane, then print the returned id.`;
/** What counts as asking a pane to save: the quick action's exact text, or the script by name. */
export const NOUS_SAVE_REQUEST = /^\s*save to memory[.!]?\s*$|space-memory-save/i;
/** A text that only asks a pane to save to, or update its own entry in, Space Memory: it answers nothing on the pane's screen. */
export const nousMemoryOnly = (text: string): boolean => text.trim() === NOUS_SAVE_RETRY_TEXT
  || /^\s*(?:save (?:it |this )?to (?:space )?memory|update (?:your|its) (?:own )?space memory entry\b[^\n]*)[.!]?\s*$/i.test(text);

// WAITING too (operator 15/11 nous_msg:9f70dbbe: a pane that reported waiting was saved and closed under the operator).
const WAITING_REPORTS = new Set(["BLOCKED", "NEEDS_DECISION", "NEEDS_YOU", "QUESTION", "WAITING"]);
// A question ending the answer ("?", the Greek question mark, or ";" after Greek words: in code ";" ends a statement), or asking words in its last lines.
const ASK_END = /[?\u037e]\s*$|\p{Script=Greek}[^;]*;\s*$/u;
const ASK_WORDS = /\b(which (one|of)|would you like|do you want|want me to|shall i|should i|let me know (which|if|whether)|tell me which|your call|pick one)\b|(πείτε μου|πες μου|θέλετε|θέλεις|ποιο από|ποια από|να προχωρήσω|επιλέξτε|διαλέξτε)/i;
// A done answer's closing caveat ("I didn't open the transcript", "Not checked: ...", «Δεν έλεγξα ...»), when it asks nothing itself.
const RULE = /^(?:[-*_=]\s*){3,}$/;
const CAVEAT = /^(?:[-*•]\s*)?(?:(?:I (?:didn['’]t|did not|haven['’]t|have not)|not (?:checked|verified|tested|run)|skipped)\b|δεν (?:έλεγξα|άνοιξα|έτρεξα|έκανα|δοκίμασα))/i;
/**
 * Operator 8/11 20:08-20:09 BKK (Alex/Bob ended «Πείτε μου ποιο από τα δύο θέλετε» and Nous sent it "save to memory"): why a CLI pane idle at its
 * prompt is not finished, null when nothing says it waits: its last answer asks the operator, its report is blocked or needs a decision, or the
 * operator in person prompted it last (their own pane, answered and waiting for them).
 */
export function awaitsOperator(report: { status: string; summary: string; body: string | null } | null, operatorLast: boolean): string | null {
  if (operatorLast) return "the operator prompted it last and has not written since its answer";
  if (!report) return null;
  if (WAITING_REPORTS.has(report.status)) return `its last report is ${report.status.toLowerCase().replace("_", " ")}`;
  const lines = (report.body ?? report.summary).split("\n").map((line) => line.trim()).filter(Boolean);
  let end = lines.length;
  // 23/11 02:36Z Cody: «…στο dev μέσω του merge queue;», then "---" and «Δεν έλεγξα …»: the rule line hid the question and the pane got a sweep.
  while (end && (RULE.test(lines[end - 1]!) || (CAVEAT.test(lines[end - 1]!) && !ASK_END.test(lines[end - 1]!) && !ASK_WORDS.test(lines[end - 1]!)))) end--;
  const tail = lines.slice(Math.max(0, end - 3), end);
  const last = tail.at(-1) ?? "";
  // An answer closing on caveats is a done report (14/11 21:41Z, Bob's "...it's your call." to Nous, then "I didn't open..."): only a question asks.
  // shortcut: an ask without "?" followed by a caveat footer reads as done; add its words to the footer check if one turns up.
  const asks = ASK_END.test(last) || (end === lines.length && tail.some((line) => ASK_WORDS.test(line)));
  return asks ? `its last answer asks the operator ("${last.slice(0, 120)}")` : null;
}
