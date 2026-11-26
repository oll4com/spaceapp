/**
 * Score push (operator 13/11 07:23 BKK nous_msg:f2dfbd359901485c9ebcf655 «γιατί δεν πιέστηκες μόνος σου»): goal 84ba917a "always a positive
 * Score" had Daily Nous errors at 50 % of −530 in the world's "## Score levers now", and no turn opened or briefed a pane on it until the operator
 * asked: the levers were text, so a turn could end in words or NOTHING_NEW. While the Score is negative, each variable over 5 % of the negative
 * that no pane works on (score.ts levers, `uncovered`) is a hold A item (turn-items.ts) on every Score snapshot: the turn opens or briefs a
 * code-fix pane naming it, or records why it waits; words alone do not pass it (`always`).
 * Plan clipboard:nLYbDf3TqBPm step 1 (Open plans −105, W47 audit): whatever the Score, each open plan past 24 h with no working pane and no
 * recorded wait is a hold A item too, until a pane works on it or its wait is recorded (space_plan_update waitsOn).
 */
import type { NousTurnItem } from "./turn-items.js";

/** The move for an open plan whose whole wait is recorded on it: parked, Space brings it back, and its clock is its last move, not its creation. */
export const CLOSE_PARKED = "close it parked (space_plan_update executionStatus COMPLETED with park {reason, conditions}; already parked: executionStatus COMPLETED alone): "
  + "Space reopens it to a pane when its conditions are met, and parked it costs from its last move instead of from its creation";

/** A Score variable no working pane names: its breakdown label, share of the negative (%), points and the move that cuts it. */
export interface UnworkedScoreVariable { label: string; share: number; points: number; move: string }
/** An open plan past 24 h that no pane works on and no recorded wait explains (score.ts `paneless`). */
export interface PanelessPlan { id: string; title: string; points: number; age: string; /** Its wait, recorded on the plan: the move is closing it parked. */ held?: string }

export function scorePushItems(score: number, variables: readonly UnworkedScoreVariable[], plans: readonly PanelessPlan[] = []): { line: string; items: NousTurnItem[] } | null {
  // PLAN kind: it moves like a plan item, by an act that names it (its label as the ref).
  const unworked = score < 0 ? variables.map((variable): NousTurnItem => ({ key: `score:${variable.label}`, kind: "PLAN", refs: [variable.label], always: true,
    line: `${variable.label} ${variable.points} (${variable.share}% of the negative), no pane works on it: ${variable.move}` })) : [];
  const item = (plan: PanelessPlan, why: string): NousTurnItem => ({ key: `score-plan:${plan.id}`, kind: "PLAN", plan: plan.id, always: true,
    line: `[${plan.id}] "${plan.title}" ${plan.points}: open ${plan.age}, ${why}` });
  const paneless = plans.filter((plan) => !plan.held).map((plan) => item(plan, "no working pane, no recorded wait"));
  const waiting = plans.filter((plan) => plan.held).map((plan) => item(plan, `no working pane, ${plan.held}`));
  if (!unworked.length && !paneless.length && !waiting.length) return null;
  return { items: [...unworked, ...paneless, ...waiting], line: [
    ...(unworked.length ? [`Score ${score}: open or brief a code-fix pane now for each variable below, naming it in the pane's prompt or brief `
      + "(space_open_panes, space_copilot_brief, space_send_to_pane), or record why it waits (space_nous_followup add naming it in the note; no push while it is open):",
    ...unworked.map((item) => `- ${item.line}`)] : []),
    ...(paneless.length ? ["Open plans with no working pane for over 24 h: open or resume a pane on each and send its next step (space_open_panes, space_execute resume, "
      + `space_send_to_pane), or, when it only waits (the operator, a date, a third party, a promote, the server), ${CLOSE_PARKED}:`,
    ...paneless.map((item) => `- ${item.line}`)] : []),
    ...(waiting.length ? ["Open plans that only wait (the wait is recorded on the plan, no pane works on them): each costs more every day it stays open, "
      + `whatever the wait; ${CLOSE_PARKED}. A step that can run without the wait goes to a pane instead (space_send_to_pane):`,
    ...waiting.map((item) => `- ${item.line}`)] : [])].join("\n") };
}
