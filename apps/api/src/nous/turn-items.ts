/**
 * Work a background turn must move before it may answer NOTHING_NEW (operator 31/10 22:19 BKK «δεν προχωράς τίποτα μόνο σου», plan
 * clipboard:ZWJJdBgHm64Z hold A): a request that looks finished, an operator request waiting 3+ minutes behind a busy pane, idle capacity
 * while work waits, a STALLED plan, and every open request of the requests sweep. On 31/10 such lines reached INBOX turns that answered
 * NOTHING_NEW, and Space consumed them with nothing done (11:18 UTC: "edd94aec looks finished", no tool call, no answer).
 */
export interface NousTurnItem {
  /** Stable across turns: the same item held again keeps its key. */
  key: string;
  kind: "REQUEST" | "PLAN" | "UTILIZATION" | "STUCK" | "QUESTION" | "REVIEW";
  /** The item's own line: what it is and what to do (the hold repeats it). */
  line: string;
  messageId?: string;
  plan?: string;
  /** The pane doing it, by id, and as "Room/Pane" (Nous names panes either way). */
  pane?: string;
  paneName?: string;
  /** The open request's note key (request-done.ts). */
  requestKey?: string;
  /** QUESTION: the ids an act names it by (the card's notification id, the copilot's question or review id). */
  refs?: string[];
  /** R37-1: a copilot review held for Nous, by its item id (mktpost:…, flmsg:…) and its card (notification:…). */
  review?: string;
  notification?: string;
}
/** A tool call of the turn (helpers' calls count for their parent turn); `subjects` are toolSubjects' pane and plan keys. */
export interface NousTurnAct { name: string; args: Record<string, unknown>; ok: boolean; subjects: string[] }

/**
 * Technical bound, not a policy: a model that keeps answering NOTHING_NEW must not start turns forever. After this many holds the items
 * go to the chat, where the operator sees what Nous left.
 */
export const NOUS_ITEM_HOLDS = 2;

/** The acts that move an item (plan clipboard:ZWJJdBgHm64Z A); space_nous_outcome too, which the "looks finished" line itself offers. */
const DISPATCH = new Set(["space_send_to_pane", "space_copilot_brief", "space_open_panes", "space_execute"]);
const dispatches = (act: NousTurnAct) => DISPATCH.has(act.name)
  && (act.name !== "space_execute" || /"operation":"(?:prompt|open|reopen|start|resume)"/.test(JSON.stringify(act.args)));
function counts(act: NousTurnAct): boolean {
  if (!act.ok) return false;
  switch (act.name) {
    case "space_request_done": case "space_nous_outcome": case "space_plan_update": return true;
    // Round 2 (1/11 10:42-10:58 UTC: nine held turns whose act was a follow-up naming the request): a follow-up is the wait recorded.
    case "space_nous_followup": return act.args.op === "add";
    case "space_open_requests": return Array.isArray(act.args.close) && act.args.close.length > 0;
    case "space_pane_checked": return /^WAITING_/.test(String(act.args.verdict ?? ""));
    default: return dispatches(act);
  }
}
/** The act names the item: its message id, plan, open request or pane (by id, or by name as toolSubjects keys it). */
function names(act: NousTurnAct, item: NousTurnItem): boolean {
  const text = JSON.stringify(act.args).toLowerCase();
  const refs = [item.messageId, item.plan, item.requestKey, item.pane, ...(item.refs ?? [])].filter((ref): ref is string => Boolean(ref)).map((ref) => ref.toLowerCase());
  const panes = [item.pane, item.paneName].filter((ref): ref is string => Boolean(ref)).map((ref) => `pane ${ref.toLowerCase()}`);
  // A call's own {room, pane} too (space_pane_checked is no toolSubjects tool), keyed the way toolSubjects keys a pane.
  const pane = typeof act.args.pane === "string" ? act.args.pane.trim().toLowerCase() : "";
  const own = pane ? `pane ${/pane:[a-z0-9_-]+/.exec(pane)?.[0] ?? `${String(act.args.room ?? "").trim().toLowerCase()}/${pane}`}` : null;
  return refs.some((ref) => text.includes(ref)) || [...act.subjects, ...(own ? [own] : [])].some((subject) => panes.includes(subject));
}
/** R35-1: a stuck pane moves only by a control act on it (a text sent to it waits like the ones before). */
const unsticks = (act: NousTurnAct) => act.ok && (["space_restart_pane", "space_stop_pane", "space_close_pane"].includes(act.name)
  || (act.name === "space_execute" && /"operation":"(?:restart|stop|cancel|close|reopen|resume|start)"/.test(JSON.stringify(act.args))));
/**
 * Plan clipboard:7L5KyWp3kQsP step 1 (1/11 17:10 UTC: jobq:Tcoa0D_0Vp3t reached an INBOX turn that ended NOTHING_NEW, then sat 9.5 h in Needs
 * you while Job memory held the answer): a copilot question held for Nous moves only by its answer, its forward to the operator (a card with
 * its ref and `checked`, a decision), its close, a brief that answers it, or a recorded reason it stays held (an outcome or follow-up naming it).
 */
const QUESTION_ACTS = new Set(["space_copilot_answer", "space_ask_operator", "space_notify_operator", "space_focus_pane", "space_resolve_notification",
  "space_copilot_brief", "space_nous_outcome", "space_send_to_pane", "space_answer_pane"]);
const settles = (act: NousTurnAct) => act.ok && (QUESTION_ACTS.has(act.name) || (act.name === "space_nous_followup" && act.args.op === "add"));
/** R37-1: a held review moves only by Nous's decision on it (approve, edit, revise, reject), a card that asks it, or its card resolved. */
const REVIEW_ACTS = new Set(["space_ask_operator", "space_notify_operator", "space_focus_pane", "space_resolve_notification", "space_mail_campaign_approve",
  "space_mail_campaign_resume"]);
const decides = (act: NousTurnAct, item: NousTurnItem) => act.ok && REVIEW_ACTS.has(act.name)
  && [item.review, item.notification].some((ref) => ref && JSON.stringify(act.args).includes(ref));
export const itemActed = (item: NousTurnItem, acts: readonly NousTurnAct[]): boolean =>
  item.kind === "REVIEW" ? acts.some((act) => decides(act, item))
    : item.kind === "QUESTION" ? acts.some((act) => settles(act) && names(act, item))
    : item.kind === "UTILIZATION" ? acts.some((act) => act.ok && dispatches(act))
    : item.kind === "STUCK" ? acts.some((act) => unsticks(act) && names(act, item)) : acts.some((act) => counts(act) && names(act, item));
export const unhandledItems = (items: readonly NousTurnItem[], acts: readonly NousTurnAct[]): NousTurnItem[] => items.filter((item) => !itemActed(item, acts));

/** What moves a held copilot question (the hold line and the pinned section say it the same way). */
export const QUESTION_ACT_LINE = "answer it with space_copilot_answer (the copilot's own memory and Space Memory hold most answers), or forward it to the operator "
  + "(space_notify_operator / space_focus_pane with its ref and checked, or space_ask_operator), or say why it stays held (space_nous_outcome or a space_nous_followup naming its id)";

/** What moves a held review, including when it is pinned or woken again with the held questions. */
export const REVIEW_ACT_LINE = "a copilot review held for you gets your space_ask_operator COPILOT REVIEW call (approve, edit, revise or reject: the line names it), or its card resolved if decided";

/** The hold line: the turn's NOTHING_NEW was not taken while these items had no act (held copilot questions and reviews: whatever the turn answered). */
export function renderItemsHold(reason: string, items: readonly NousTurnItem[], silent = true): string {
  const questions = items.filter((item) => item.kind === "QUESTION").length;
  const question = questions ? ` A copilot question held for you (${questions}) holds any turn that ends without an act on it, words or not: ${QUESTION_ACT_LINE}.` : "";
  if (!silent && questions === items.length) return `Held: your ${reason} turn ended while ${questions === 1 ? "a copilot question" : `${questions} copilot questions`} held for you below had no act.${question}`;
  return `Held: your ${reason} turn ${silent ? "answered NOTHING_NEW" : "ended"} while ${items.length === 1 ? "an item" : `${items.length} items`} below had no act (operator 31/10 22:19 BKK: `
    + "Nous moves work on its own, not only when he asks). Act on each now: a request you checked finished in this turn goes to Done, one at a time with that check (space_request_done, or space_open_requests close of that one); "
    + "a request or plan that waits gets its next step sent to a pane (space_send_to_pane, space_copilot_brief, space_open_panes, space_execute prompt) "
    + "naming its id or plan, or its wait recorded (space_plan_update waitsOn, space_pane_checked WAITING_*, a space_nous_followup naming it); idle capacity gets parallel work started; "
    + "a stuck pane is restarted, stopped or closed (space_restart_pane, space_stop_pane, space_close_pane, space_execute); "
    + `${REVIEW_ACT_LINE}. `
    + `If something blocks an item, write it in words instead of NOTHING_NEW.${question}`;
}

/** What the chat gets once the holds are spent: the items Nous left without an act. */
export function renderItemsLeft(items: readonly NousTurnItem[]): string {
  return `I left ${items.length === 1 ? "this item" : `these ${items.length} items`} without an act after ${NOUS_ITEM_HOLDS} reminders:\n`
    + items.map((item) => `- ${item.line.replace(/\s+/g, " ").trim().slice(0, 300)}`).join("\n");
}
