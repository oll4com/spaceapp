import type { NousTurnFacts } from "@space/contracts";
import type { NousChange, NousChangeCounts, NousChangesRepository, NousChangeVerdict } from "@space/db";

// Nous RSI change ledger (plan clipboard:CCIzkVBIbPpG step 1, docs/agents/nous-rsi.md): each shipped self-change is measured by code.

/** The window on each side of a change's deploy: the daily review's causes are counted over days, a week holds every weekday once. */
export const NOUS_CHANGE_WINDOW_MS = 7 * 86_400_000;
const TICKET = /\bq-(\d{4})(\d\d)(\d\d)-(\d\d)(\d\d)(\d\d)-[0-9a-f]{4}\b/;

/**
 * What a queue line says must fall: its own `metric:<…>` field, else the tools it names before "; fix:" (the cause and its evidence).
 * shortcut: a line naming no tool has no metric and stays UNMEASURED, until the REVIEW orders write `metric:` on every line (plan step 10).
 */
export function lineMetric(line: string): string | null {
  const named = /\bmetric:(\S+?)[;.\]]?(?:\s|$)/.exec(line)?.[1];
  if (named) return named;
  const tools = [...new Set(line.split("; fix:")[0]!.match(/\bspace_[a-z0-9_]+\b/g) ?? [])];
  return tools.length ? tools.map((tool) => `tool:${tool}`).join(",") : null;
}

/**
 * queue.md's lines that say DONE and name a merge-queue ticket: one change per ticket, the first line that names it.
 * shortcut: the deploy time is the ticket id's submit time (UTC); dev deploys minutes later and stable at the next promote, which puts
 * a few hours of the old code in the "after" week (against the change, never for it). Read the promote's time if verdicts need the hours.
 */
export function queueChanges(text: string): Array<Pick<NousChange, "ref" | "cause" | "metric" | "deployedAt">> {
  const seen = new Set<string>();
  return text.split("\n").flatMap((line) => {
    const ticket = /\bDONE\b/.test(line) ? TICKET.exec(line) : null;
    if (!ticket || seen.has(ticket[0])) return [];
    seen.add(ticket[0]);
    const [ref, year, month, day, hour, minute, second] = ticket;
    return [{ ref, cause: line.trim(), metric: lineMetric(line), deployedAt: `${year}-${month}-${day}T${hour}:${minute}:${second}.000Z` }];
  });
}

/**
 * Raw counts of a metric over the turns started in [from, to). `tool:<name>` is that tool's failed calls that were mistakes (failed minus
 * the gate's refusals); `tool:<name>~<text>` only its kept error texts holding <text> (no comma in it). Parts joined by a comma add up.
 * Null when the metric is not one this reads.
 */
export function countMetric(facts: NousTurnFacts[], metric: string, from: number, to: number): NousChangeCounts | null {
  const parts = metric.split(",").map((part) => /^tool:([a-z0-9_]+)(?:~(.+))?$/i.exec(part.trim()));
  if (parts.some((part) => !part)) return null;
  const turns = facts.filter((turn) => { const at = Date.parse(turn.startedAt); return at >= from && at < to; });
  let count = 0;
  for (const turn of turns) for (const part of parts) {
    const tool = turn.tools[part![1]!];
    if (!tool) continue;
    const text = part![2]?.toLowerCase();
    count += text ? (tool.errors ?? (tool.error ? [tool.error] : [])).filter((error) => error.toLowerCase().includes(text)).length : Math.max(tool.failed - tool.refused, 0);
  }
  return { count, turns: turns.length };
}

/**
 * Two counts as rates per turn (a busier week has more of everything): were the "after" week's share of the failures the same as its
 * share of the turns, how far off is it? Two standard deviations either way is a clear case; the rest is NO_EFFECT. A filter for clear
 * cases, not a proof: other changes shipped the same week.
 */
export function changeVerdict(before: NousChangeCounts, after: NousChangeCounts): NousChangeVerdict {
  if (!before.turns || !after.turns) return "UNMEASURED";
  const total = before.count + after.count, share = after.turns / (before.turns + after.turns);
  if (!total) return "NO_EFFECT";
  const z = (after.count - total * share) / Math.sqrt(total * share * (1 - share));
  return z <= -2 ? "KEPT" : z >= 2 ? "WORSE" : "NO_EFFECT";
}

export interface NousChangesDeps {
  repository: NousChangesRepository;
  /** nous/upgrades/queue.md, "" when it cannot be read. */
  queueText(): Promise<string>;
  /** Whether a merge-queue ticket's change runs on the operator's instance. */
  onStable(ticketId: string): Promise<boolean>;
  turnFacts(owner: string, since: string): Promise<NousTurnFacts[]>;
  now?: () => number;
}

export function createNousChanges(deps: NousChangesDeps) {
  const now = () => deps.now?.() ?? Date.now();
  return {
    /** Every DONE ticket that is live gets its row with the week before; every row whose week after has passed gets it and a verdict. */
    async tick(owner: string): Promise<void> {
      const rows = await deps.repository.list(owner);
      const known = new Set(rows.filter((row) => row.kind === "CODE").map((row) => row.ref));
      const fresh: Array<ReturnType<typeof queueChanges>[number]> = [];
      for (const change of queueChanges(await deps.queueText())) if (!known.has(change.ref) && await deps.onStable(change.ref).catch(() => false)) fresh.push(change);
      const due = rows.filter((row) => row.verdict === null && row.metric !== null && row.before !== null && Date.parse(row.deployedAt) + NOUS_CHANGE_WINDOW_MS <= now());
      if (!fresh.length && !due.length) return;
      const since = Math.min(...fresh.map((change) => Date.parse(change.deployedAt) - NOUS_CHANGE_WINDOW_MS), ...due.map((row) => Date.parse(row.deployedAt)));
      const facts = await deps.turnFacts(owner, new Date(since).toISOString());
      for (const change of fresh) {
        const at = Date.parse(change.deployedAt);
        const before = change.metric ? countMetric(facts, change.metric, at - NOUS_CHANGE_WINDOW_MS, at) : null;
        const row: NousChange = { ownerUserId: owner, kind: "CODE", ...change, metric: before ? change.metric : null, before, after: null,
          verdict: before ? null : "UNMEASURED", measuredAt: before ? null : new Date(now()).toISOString() };
        if (await deps.repository.add(row) && before && at + NOUS_CHANGE_WINDOW_MS <= now()) due.push(row);
      }
      for (const row of due) {
        const at = Date.parse(row.deployedAt);
        const after = countMetric(facts, row.metric!, at, at + NOUS_CHANGE_WINDOW_MS)!;
        await deps.repository.measured(owner, row.kind, row.ref, after, changeVerdict(row.before!, after), new Date(now()));
      }
    }
  };
}
