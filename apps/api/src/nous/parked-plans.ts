import { planIsParked, type ClipboardItem, type NousDecision, type PlanParked, type PlanResumeCondition, type PlanWaitsOn, type UpdatePlanProgressRequest } from "@space/contracts";

/**
 * Parked plans resume by themselves (operator 13/11 nous_msg:4080b166, plan clipboard:7S_jA46vDkU9): every 10 minutes Space checks each
 * parked plan's DATE, PLAN, TICKET and DECISION conditions, marks the met ones, and when every condition is met reopens the plan and tells
 * Nous, whose push then puts it on a pane with its next step. MANUAL conditions (NOUS, AGENT, OPERATOR, THIRD_PARTY) are Nous's to mark.
 */
export interface ParkedPlansDeps {
  /** Every plan, open and closed (the backfill, once per process). */
  plans(owner: string): Promise<ClipboardItem[]>;
  /** The plans parked now. */
  parked(owner: string): Promise<ClipboardItem[]>;
  get(owner: string, id: string): Promise<ClipboardItem | null>;
  update(owner: string, id: string, input: UpdatePlanProgressRequest): Promise<ClipboardItem>;
  /** A queue ticket's status ("DEPLOYED", ...), null when unknown. */
  ticketStatus(id: string): Promise<string | null>;
  onStable(id: string): Promise<boolean>;
  decision(owner: string, id: string): Promise<Pick<NousDecision, "status"> | null>;
  notice(owner: string, key: string, line: string): Promise<void>;
  now?: () => number;
}

const WAIT_WHO: Record<PlanWaitsOn["kind"], PlanResumeCondition["who"]> = { OPERATOR: "OPERATOR", DATE: "DATE", PROMOTE: "PROMOTE", THIRD_PARTY: "THIRD_PARTY", PLAN: "PLAN", NOUS: "NOUS", SERVER: "NOUS" };
const TICKET = /\bq-\d{8}-\d{6}-[0-9a-f]{4}\b/;

/** The park a plan gets from what it already records: its whole-plan wait and the open plans it depends on. Null when it needs none. */
export function derivedPark(plan: ClipboardItem, open: Set<string>, at: string): PlanParked | null {
  if (plan.parked || plan.source !== "PLAN") return null;
  const openStep = plan.steps.find((step) => step.status !== "COMPLETED");
  const closedWithWork = plan.isCompleted && plan.progressPercentage < 100 && Boolean(openStep);
  if (plan.isCompleted ? !closedWithWork : !plan.waitsOn) return null;
  const conditions: PlanResumeCondition[] = [];
  const wait = plan.waitsOn;
  if (wait) {
    const ticket = wait.kind === "PROMOTE" ? TICKET.exec(wait.what)?.[0] : undefined;
    conditions.push({ id: "c1", who: WAIT_WHO[wait.kind], what: wait.what, state: "OPEN", checkedAt: null, metAt: null, evidence: null,
      check: wait.kind === "DATE" && wait.until ? { kind: "DATE", at: wait.until } : ticket ? { kind: "TICKET", ticket, on: "stable" } : { kind: "MANUAL" } });
  }
  for (const id of plan.dependsOn ?? []) if (open.has(id)) conditions.push({ id: `c${conditions.length + 1}`, who: "PLAN", what: `Plan ${id} is done`, check: { kind: "PLAN", planId: id }, state: "OPEN", checkedAt: null, metAt: null, evidence: null });
  if (!conditions.length) conditions.push({ id: "c1", who: "NOUS", what: `Decide the open step "${openStep!.title}": resume it, or drop the steps left`, check: { kind: "MANUAL" }, state: "OPEN", checkedAt: null, metAt: null, evidence: null });
  return { reason: wait ? `Waits on ${wait.kind.toLowerCase().replace("_", " ")}: ${wait.what}` : `Closed at ${plan.progressPercentage}% with steps left`, since: plan.lastProgressAt ?? at, conditions, resumedAt: null };
}

/**
 * When a parked plan last moved (the park, a met condition, progress): the standing orders' hold and the Score's "Parked plans" count from it.
 * When every open condition is a DATE, nothing can move it before the latest of them, so the clock starts there.
 */
export function parkedSince(plan: ClipboardItem & { parked: PlanParked }): number {
  const open = plan.parked.conditions.filter((entry) => entry.state === "OPEN");
  const moved = Math.max(...[plan.parked.since, plan.lastProgressAt, ...plan.parked.conditions.map((entry) => entry.metAt)].filter((entry): entry is string => Boolean(entry)).map(Date.parse));
  return Math.max(moved, ...open.flatMap((entry) => open.every((condition) => condition.check.kind === "DATE") && entry.check.kind === "DATE" ? [Date.parse(entry.check.at)] : []));
}

export function createParkedPlans(deps: ParkedPlansDeps) {
  const now = deps.now ?? Date.now;
  const backfilled = new Set<string>();

  /** The evidence a machine check is met, null while it is not (or for MANUAL). */
  async function met(owner: string, condition: PlanResumeCondition, at: number): Promise<string | null> {
    const check = condition.check;
    if (check.kind === "DATE") return Date.parse(check.at) <= at ? `${check.at} passed` : null;
    if (check.kind === "PLAN") {
      const plan = await deps.get(owner, check.planId).catch(() => null);
      if (!plan) return `${check.planId} no longer exists`;
      return plan.isCompleted && !planIsParked(plan) ? `${check.planId} closed at ${plan.progressPercentage}%` : null;
    }
    if (check.kind === "TICKET") {
      if (check.on === "stable") return await deps.onStable(check.ticket).catch(() => false) ? `${check.ticket} is on stable` : null;
      return await deps.ticketStatus(check.ticket).catch(() => null) === "DEPLOYED" ? `${check.ticket} deployed to dev` : null;
    }
    if (check.kind === "DECISION") {
      const decision = await deps.decision(owner, check.id).catch(() => null);
      return decision && decision.status !== "OPEN" ? `${check.id} ${decision.status.toLowerCase()}` : null;
    }
    return null;
  }

  /** Parks every waiting or closed-with-work plan once (backfill), with conditions derived from its wait and dependencies. */
  async function backfill(owner: string, plans: ClipboardItem[]): Promise<number> {
    const at = new Date(now()).toISOString();
    const open = new Set(plans.filter((plan) => !plan.isCompleted).map((plan) => plan.id));
    let count = 0;
    for (const plan of plans) {
      const parked = derivedPark(plan, open, at);
      if (parked && await deps.update(owner, plan.id, { parked }).then(() => true, () => false)) count += 1;
    }
    if (count) await deps.notice(owner, "parked-backfill", `${count} waiting or closed plan${count === 1 ? " was" : "s were"} parked with conditions derived from their wait and dependencies `
      + "(see ## Parked plans): for each, check the reason and conditions, replace them with space_plan_update park where they are vague (a NOUS \"Decide the open step\" condition means you choose: resume it or drop its steps), and mark the met ones.");
    return count;
  }

  return {
    backfill,
    /** One pass for one owner: backfill once per process, then check every parked plan. Returns the plans resumed. */
    async check(owner: string): Promise<string[]> {
      if (!backfilled.has(owner)) {
        backfilled.add(owner);
        await backfill(owner, await deps.plans(owner));
      }
      const plans = await deps.parked(owner);
      const at = now();
      const iso = new Date(at).toISOString();
      const resumed: string[] = [];
      for (const plan of plans.filter(planIsParked)) {
        let changed = false;
        const conditions: PlanResumeCondition[] = [];
        for (const condition of plan.parked.conditions) {
          if (condition.state === "MET" || condition.check.kind === "MANUAL") { conditions.push(condition); continue; }
          const evidence = await met(owner, condition, at);
          changed = true;
          conditions.push(evidence ? { ...condition, state: "MET", metAt: iso, checkedAt: iso, evidence } : { ...condition, checkedAt: iso });
        }
        const allMet = conditions.every((condition) => condition.state === "MET");
        if (!changed && !allMet) continue;
        const parked: PlanParked = { ...plan.parked, conditions, ...(allMet ? { resumedAt: iso } : {}) };
        if (!allMet) { await deps.update(owner, plan.id, { parked }).catch(() => undefined); continue; }
        // Reopen: a closed plan with no open step gets one, or its derived 100 % would close it again.
        const reopen: UpdatePlanProgressRequest = !plan.isCompleted ? { parked, waitsOn: null }
          : { parked, waitsOn: null, executionStatus: "IN_PROGRESS",
            ...(plan.steps.some((step) => step.status !== "COMPLETED") ? {} : { steps: [...plan.steps, { id: `resume-${plan.steps.length + 1}`, order: plan.steps.length + 1, title: `Resume: ${plan.parked.reason}`.slice(0, 200),
              status: "PENDING", progress: 0, agent: null, notes: null, proof: null, startedAt: null, completedAt: null }] }) };
        const done = await deps.update(owner, plan.id, reopen).then(() => true, async () =>
          // A managed plan takes only the map: it is marked resumed and Nous restarts its execution.
          plan.isCompleted ? deps.update(owner, plan.id, { parked, waitsOn: null }).then(() => false, () => false) : false);
        resumed.push(plan.id);
        await deps.notice(owner, `parked-resumed:${plan.id}`, `Plan [${plan.id}] "${plan.title ?? plan.text.replace(/\s+/g, " ").slice(0, 80)}" ${done || !plan.isCompleted ? "resumed" : "has every resume condition met but could not be reopened (managed): reopen it"}: `
          + `every condition is met (${conditions.map((condition) => `${condition.id} ${condition.who}: ${condition.evidence ?? condition.what}`).join("; ")}). Put it on a pane at its minimum model with its next step now.`);
      }
      return resumed;
    }
  };
}
