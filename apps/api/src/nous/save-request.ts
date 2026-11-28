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

/** Why a pane is not a finished pane to close (standing-orders.ts `closeoutSkipReason`). */
export type CloseoutSkip = "always-on" | "browser-held" | "busy" | "unknown" | "fresh" | "operator-test" | "keep-open" | "waiting-operator" | "card-check" | "task" | "managed" | "plan-open" | "board-waits" | "board-check" | "awaits-operator" | "scheduled" | "prompted" | "operator-pane" | "pending-deliverables";
/** The exit of a pane that cannot answer its save, in the refusals and the tick's lines alike. */
export const NOUS_SAVE_YOURSELF = "save its state yourself (space_memory_save naming its pane id or \"Room/Pane\"), then close it";
/**
 * Plan clipboard:CTVaL1V3kAFM step 9 (a refusal read "kept open (plan-open)" and named no way on): what each reason asks of Nous next, the act
 * that frees the pane or what it waits for. One table for the save and close refusals (tools.ts) and the tick's lines; the type makes a new reason name its step.
 */
export const CLOSEOUT_NEXT: Record<CloseoutSkip, string> = {
  "always-on": "the Mail Copilot works the mail as it arrives and is never finished; leave it open and wait for the operator to close it themselves",
  scheduled: "its Marketing Copilot has an approved post scheduled, or its schedule could not be read; wait for the post to go out: it closes once nothing is scheduled",
  "browser-held": "its browser is in use under a control lease, a handoff or a Vault fence; wait for the holder to release it",
  busy: "it is not done or idle; wait for the turn to end, or read what it shows and act on that (space_read_pane)",
  unknown: "Space could not read its browser or when it finished; try again later",
  "operator-pane": "the operator opened or prompted it; wait for the operator: only their own close order closes it",
  "awaits-operator": "the operator prompted it last, or its last answer asks a question or its report waits; a question you know the answer to: answer it (space_answer_pane); else raise it (space_notify_operator) and wait for the operator's answer",
  prompted: "a prompt was typed since it finished, or one is queued for it; wait for the turn that prompt starts to end",
  "operator-test": "the operator's own test pane, with \"Close your own panes too\" off; wait for the operator to close it",
  "waiting-operator": "a card, a decision or a copilot item on it is open for the operator; wait for the operator's answer: it closes once that is resolved",
  "keep-open": "your space_pane_checked holds it until its next check; a verified save with no prompt since, or an OK_WORKING/NEEDS_ACTION verdict, clears it",
  "card-check": "read the pane (space_pane_reports); nothing left for the operator: resolve it (space_resolve_notification); still theirs: space_pane_checked WAITING_OPERATOR with nextCheckInMinutes",
  task: "a task bound to it runs now, is due within the hour, or ran and is not marked done; wait for the turn of its run, or mark it done, remove its schedule or bind it to another pane (space_task_update)",
  managed: "a managed plan execution runs in it; wait for the turn of its step: the pane is free once the execution ends",
  "pending-deliverables": "its worktree holds uncommitted changes or unmerged commits, or git did not answer; have the pane commit and deliver them (space_send_to_pane)",
  "plan-open": "its linked plan has a step that can run, or waits for the operator's answer; send the pane that step (space_send_to_pane), or record the step done or what the plan waits on (space_plan_update)",
  "board-waits": "the board reads its last answer as a wait and it finished only now; read it (space_pane_reports) and wait for the turn's finished time to pass: its line then asks for your check",
  "board-check": "the board reads its last answer as a wait, with nothing open for the operator; read it (space_pane_reports): its task done, send it exactly \"save to memory\" (space_send_to_pane) and close it once the save is verified",
  fresh: "it finished only now; its work done, send it exactly \"save to memory\" (space_send_to_pane) and close it once the save is verified"
};

// WAITING too (operator 15/11 nous_msg:9f70dbbe: a pane that reported waiting was saved and closed under the operator).
const WAITING_REPORTS = new Set(["BLOCKED", "NEEDS_DECISION", "NEEDS_YOU", "QUESTION", "WAITING"]);
/**
 * Operator 28/11 09:40 BKK (nous_msg:57f3908d69dd4398a16e20fe, «διορθωσε τον κώδικα σου!!»): a waiting, needs-decision or blocked report with
 * nothing moved since for STALE_WAIT_MS is a finished pane's, once no card, decision or question of the operator waits on it (closeoutSkipReason).
 */
export const STALE_WAIT_MS = 30 * 60_000;
const STALE_WAIT_REPORTS = new Set(["WAITING", "NEEDS_DECISION", "BLOCKED"]);
type MovedReport = { status: string; at: string; source?: string };
/**
 * Plan clipboard:CTVaL1V3kAFM step 2: the one reading of "this report no longer holds its pane", for the tick and the tools alike (each had its own
 * clock, and the tick lacked the progress rule). `newest` is the pane's newest report of any kind, `since` when its state last changed; the clock
 * is the newest of the three. A waiting, needs-decision or blocked report settles once nothing moved for STALE_WAIT_MS; a progress or started one
 * once Space's own turn end followed it and nothing moved for as long (operator 28/11 nous_msg:d2faedf0: scheduled runs report their result as progress).
 */
export function reportSettled(report: MovedReport, newest: MovedReport | null | undefined, since: string | null | undefined, now: number): boolean {
  const times = [report.at, newest?.at, since].map((at) => Date.parse(at ?? "")).filter(Number.isFinite);
  if (!times.length || now - Math.max(...times) < STALE_WAIT_MS) return false;
  return STALE_WAIT_REPORTS.has(report.status)
    || ((report.status === "PROGRESS" || report.status === "STARTED") && newest?.status === "TURN_END" && newest.source === "AUTO" && newest.at >= report.at);
}
/** A pane's own work is open: its newest work report (`last`) is not done or failed and has not settled. Needs-you and question reports never settle. */
export const workOpen = (last: MovedReport | null | undefined, newest: MovedReport | null | undefined, since: string | null | undefined, now: number): boolean =>
  Boolean(last) && last!.status !== "DONE" && last!.status !== "FAILED" && !reportSettled(last!, newest, since, now);
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
