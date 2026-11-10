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

const WAITING_REPORTS = new Set(["BLOCKED", "NEEDS_DECISION", "NEEDS_YOU", "QUESTION"]);
// A question ending the answer ("?", the Greek question mark, or ";" after Greek words: in code ";" ends a statement), or asking words in its last lines.
const ASK_END = /[?\u037e]\s*$|\p{Script=Greek}[^;]*;\s*$/u;
const ASK_WORDS = /\b(which (one|of)|would you like|do you want|want me to|shall i|should i|let me know (which|if|whether)|tell me which|your call|pick one)\b|(πείτε μου|πες μου|θέλετε|θέλεις|ποιο από|ποια από|να προχωρήσω|επιλέξτε|διαλέξτε)/i;
/**
 * Operator 8/11 20:08-20:09 BKK (Alex/Bob ended «Πείτε μου ποιο από τα δύο θέλετε» and Nous sent it "save to memory"): why a CLI pane idle at its
 * prompt is not finished, null when nothing says it waits: its last answer asks the operator, its report is blocked or needs a decision, or the
 * operator in person prompted it last (their own pane, answered and waiting for them).
 */
export function awaitsOperator(report: { status: string; summary: string; body: string | null } | null, operatorLast: boolean): string | null {
  if (operatorLast) return "the operator prompted it last and has not written since its answer";
  if (!report) return null;
  if (WAITING_REPORTS.has(report.status)) return `its last report is ${report.status.toLowerCase().replace("_", " ")}`;
  const tail = (report.body ?? report.summary).split("\n").map((line) => line.trim()).filter(Boolean).slice(-3);
  const last = tail.at(-1) ?? "";
  const asks = ASK_END.test(last) || tail.some((line) => ASK_WORDS.test(line));
  return asks ? `its last answer asks the operator ("${last.slice(0, 120)}")` : null;
}
