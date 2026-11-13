/**
 * Score push (operator 13/11 07:23 BKK nous_msg:f2dfbd359901485c9ebcf655 «γιατί δεν πιέστηκες μόνος σου»): goal 84ba917a "always a positive
 * Score" had Daily Nous errors at 50 % of −530 in the world's "## Score levers now", and no turn opened or briefed a pane on it until the operator
 * asked: the levers were text, so a turn could end in words or NOTHING_NEW. While the Score is negative, each variable over 5 % of the negative
 * that no pane works on (score.ts levers, `uncovered`) is a hold A item (turn-items.ts) on every Score snapshot: the turn opens or briefs a
 * code-fix pane naming it, or records why it waits; words alone do not pass it (`always`).
 */
import type { NousTurnItem } from "./turn-items.js";

/** A Score variable no working pane names: its breakdown label, share of the negative (%), points and the move that cuts it. */
export interface UnworkedScoreVariable { label: string; share: number; points: number; move: string }

export function scorePushItems(score: number, variables: readonly UnworkedScoreVariable[]): { line: string; items: NousTurnItem[] } | null {
  if (score >= 0 || !variables.length) return null;
  // PLAN kind: it moves like a plan item, by an act that names it (its label as the ref).
  const items = variables.map((variable): NousTurnItem => ({ key: `score:${variable.label}`, kind: "PLAN", refs: [variable.label], always: true,
    line: `${variable.label} ${variable.points} (${variable.share}% of the negative), no pane works on it: ${variable.move}` }));
  return { items, line: [`Score ${score}: open or brief a code-fix pane now for each variable below, naming it in the pane's prompt or brief `
    + "(space_open_panes, space_copilot_brief, space_send_to_pane), or record why it waits (space_nous_followup add naming it):",
  ...items.map((item) => `- ${item.line}`)].join("\n") };
}
