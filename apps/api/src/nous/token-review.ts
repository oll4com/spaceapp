import type { NousTurnFacts } from "@space/contracts";
import type { GatewaySavingsDailyRow, GatewayUsageHistoryPoint } from "@space/db";
import { lostAtResetText, type NousLostRow } from "./lost-tokens.js";
import { NOUS_SCORE_WEIGHTS } from "./score.js";

/**
 * The daily REVIEW's token table (plan clipboard:ctqx7SPqkWR2 step 6, operator 1/11 10:38 BKK «τα tokens usage να είναι ουσιαστικά»):
 * what Nous spent per turn kind and per goal over the review's 24 hours against the 24 before, the ten most expensive gateway
 * projects (panes, Nous, helpers) of the last whole UTC day against the day before with their context a request, and each
 * subscription account's 5-hour peak. Read only; nothing here changes a token row.
 */
export interface TokenReviewInput {
  facts: NousTurnFacts[];
  projects: GatewaySavingsDailyRow[];
  accounts: Array<{ label: string; provider: string; fiveHour: GatewayUsageHistoryPoint[] }>;
  /** A gateway project tag ("pane:…", "nous", "agent-chat") or a goal id → a readable name. */
  names: Map<string, string>;
  since: string;
  /** The last whole UTC day (YYYY-MM-DD). */
  day: string;
  /** Every subscription week that reset in the last 7 days and what it left unused (operator 5/11); absent when the Gateway cannot tell. */
  lost?: NousLostRow[];
}

const usd = (value: number) => `$${value.toFixed(2)}`;
const tokens = (value: number) => value >= 1e9 ? `${(value / 1e9).toFixed(2)}B` : value >= 1e6 ? `${(value / 1e6).toFixed(1)}M` : value >= 1e3 ? `${Math.round(value / 1e3)}k` : String(Math.round(value));
const sum = <T>(rows: T[], key: (row: T) => string, cost: (row: T) => number) => {
  const out = new Map<string, { cost: number; count: number }>();
  for (const row of rows) { const entry = out.get(key(row)) ?? { cost: 0, count: 0 }; entry.cost += cost(row); entry.count += 1; out.set(key(row), entry); }
  return out;
};

export function renderTokenReview({ facts, projects, accounts, names, since, day, lost }: TokenReviewInput): string {
  const before = new Date(Date.parse(since) - 86_400_000).toISOString();
  const now = facts.filter((turn) => turn.startedAt >= since);
  const then = facts.filter((turn) => turn.startedAt >= before && turn.startedAt < since);
  const kinds = [sum(now, (turn) => turn.reason, (turn) => turn.costUsd ?? 0), sum(then, (turn) => turn.reason, (turn) => turn.costUsd ?? 0)] as const;
  const kindLine = [...kinds[0].entries()].sort((a, b) => b[1].cost - a[1].cost).map(([reason, entry]) => {
    const old = kinds[1].get(reason);
    return `${reason} ${usd(entry.cost)} / ${entry.count} turns (before ${old ? `${usd(old.cost)} / ${old.count}` : "none"})`;
  });
  const total = (rows: NousTurnFacts[]) => usd(rows.reduce((value, turn) => value + (turn.costUsd ?? 0), 0));
  const goals = [sum(now.filter((turn) => turn.goalId), (turn) => turn.goalId!, (turn) => turn.costUsd ?? 0), sum(then.filter((turn) => turn.goalId), (turn) => turn.goalId!, (turn) => turn.costUsd ?? 0)] as const;
  const goalLine = [...goals[0].entries()].sort((a, b) => b[1].cost - a[1].cost).slice(0, 10).map(([goal, entry]) => {
    const old = goals[1].get(goal);
    return `"${names.get(goal) ?? goal}" ${usd(entry.cost)} / ${entry.count} turns (before ${old ? `${usd(old.cost)} / ${old.count}` : "none"})`;
  });
  const previous = new Date(Date.parse(`${day}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
  const byProject = (date: string) => {
    const out = new Map<string, { cost: number; input: number; requests: number }>();
    for (const row of projects.filter((entry) => entry.day === date)) {
      const key = row.project || `(untagged ${row.client || row.provider})`;
      const entry = out.get(key) ?? { cost: 0, input: 0, requests: 0 };
      entry.cost += row.costUsd; entry.input += row.inputTokens; entry.requests += row.requests;
      out.set(key, entry);
    }
    return out;
  };
  const [today, yesterday] = [byProject(day), byProject(previous)];
  const per = (entry: { input: number; requests: number }) => entry.requests ? tokens(entry.input / entry.requests) : "n/a";
  const projectLine = [...today.entries()].sort((a, b) => b[1].cost - a[1].cost).slice(0, 10).map(([project, entry]) => {
    const old = yesterday.get(project);
    return `${names.get(project) ?? project} ${usd(entry.cost)}, ${tokens(entry.input)} in over ${entry.requests} requests, ${per(entry)} a request`
      + ` (before ${old ? `${usd(old.cost)}, ${per(old)} a request` : "none"})`;
  });
  const peaks = accounts.map((account) => {
    const window = account.fiveHour.filter((point) => point.recordedAt >= since);
    if (!window.length) return `${account.label} no 5-hour sample`;
    const peak = window.reduce((best, point) => point.usedPercent > best.usedPercent ? point : best);
    const full = window.filter((point) => point.usedPercent >= 100);
    return `${account.label} peak ${Math.round(peak.usedPercent)}% at ${peak.recordedAt.slice(11, 16)} UTC${full.length ? `, at 100% from ${full[0]!.recordedAt.slice(11, 16)} UTC` : ""}`;
  });
  return [
    "## Tokens (plan clipboard:ctqx7SPqkWR2 step 6: every token useful, no 5-hour window at 100% while the weeks have room)",
    `- Nous by turn kind, last 24 h (total ${total(now)}, the 24 h before ${total(then)}): ${kindLine.join("; ") || "no turns"}`,
    `- Goals by cost: ${goalLine.join("; ") || "no goal turns"}`,
    `- The 10 most expensive gateway projects on ${day} UTC against ${previous}: ${projectLine.join("; ") || "no gateway rollup"}`,
    `- 5-hour peaks, last 24 h: ${peaks.join("; ") || "no subscription account"}`,
    ...(lost ? [`- Lost at weekly resets (room a week left unused when it reset; UTC), last 24 h: ${lostAtResetText(lost.filter((row) => row.resetAt >= since), (at) => `${at.slice(5, 10)} ${at.slice(11, 16)}`)}`
      + `; last 7 days: ${lostAtResetText(lost, (at) => `${at.slice(5, 10)} ${at.slice(11, 16)}`)}. Room lost is work not done: name which panes could have used it.`
      // Operator 5/11 (nous_msg:b489788c): the Score's own variable, as the Score counts it (weeks that left 1% or more).
      + ` The Score's Lost tokens variable: ${Math.round(lost.filter((row) => row.lostPercent >= 1).reduce((sum, row) => sum + row.lostPercent, 0) * NOUS_SCORE_WEIGHTS.lostAtResetPerPoint)} points for these 7 days (${NOUS_SCORE_WEIGHTS.lostAtResetPerPoint} a point).`] : []),
    "- Name what grew and why. A pane over 200k a request is not compacting; a waiting goal or a repeated inbox line taking turns is a cause for nous/upgrades/queue.md."
  ].join("\n");
}
