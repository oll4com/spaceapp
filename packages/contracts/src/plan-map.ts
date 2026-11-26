import { z } from "zod";

/**
 * Plan map (operator request 2026-10-25): what a plan waits on, the plans it depends on and the date it must keep, so the
 * Nous dock and Nous's world show one picture of every plan. A wait on another plan is `dependsOn`, never `waitsOn`.
 * A leaf module: schemas.ts and nous.ts both import it (an import from schemas.ts into nous.ts made a cycle, 2026-10-25).
 */
export const planWaitsOnKindSchema = z.enum(["OPERATOR", "DATE", "PROMOTE", "THIRD_PARTY", "PLAN", "NOUS", "SERVER"]);
export type PlanWaitsOnKind = z.infer<typeof planWaitsOnKindSchema>;
export const planWaitsOnSchema = z.object({
  kind: planWaitsOnKindSchema,
  // Whole since 31/10 (was 200): what a plan or goal waits on is stored as JSON, with no column bound.
  what: z.string().trim().min(1),
  until: z.string().datetime({ offset: true }).nullable().default(null)
}).strict();
export type PlanWaitsOn = z.infer<typeof planWaitsOnSchema>;
/** The progress-update keys that change only the plan map and the model it needs: allowed on a managed plan too (its execution owns the rest). */
export const PLAN_MAP_KEYS = ["dependsOn", "dueAt", "waitsOn", "parked", "minimumModel", "minimumReasoning"] as const;

/**
 * Parked plans (operator 13/11 nous_msg:4080b166, plan clipboard:7S_jA46vDkU9): why a plan is parked (open, or closed with work left)
 * and what must happen for it to resume. Space checks the machine checks on the standing tick and resumes the plan when all are met;
 * MANUAL ones Nous records MET with evidence. `who` does it (DATE and PLAN do themselves).
 */
export const planResumeWhoSchema = z.enum(["NOUS", "AGENT", "OPERATOR", "THIRD_PARTY", "DATE", "PLAN", "PROMOTE"]);
export type PlanResumeWho = z.infer<typeof planResumeWhoSchema>;
const resumeTime = z.string().datetime({ offset: true });
export const planResumeCheckSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("DATE"), at: resumeTime }).strict(),
  /** Met when that plan is completed and not itself parked. */
  z.object({ kind: z.literal("PLAN"), planId: z.string().trim().min(1) }).strict(),
  /** Met when the merge-queue ticket is DEPLOYED on dev, or (on: stable) its commit is on stable's main. */
  z.object({ kind: z.literal("TICKET"), ticket: z.string().trim().regex(/^q-\d{8}-\d{6}-[0-9a-f]{4}$/), on: z.enum(["dev", "stable"]).default("dev") }).strict(),
  /** Met when the Nous decision is no longer OPEN. */
  z.object({ kind: z.literal("DECISION"), id: z.string().trim().min(1) }).strict(),
  z.object({ kind: z.literal("MANUAL") }).strict()
]);
export type PlanResumeCheck = z.infer<typeof planResumeCheckSchema>;
export const planResumeConditionSchema = z.object({
  id: z.string().trim().min(1).max(40).optional(),
  who: planResumeWhoSchema,
  what: z.string().trim().min(1),
  check: planResumeCheckSchema.default({ kind: "MANUAL" }),
  state: z.enum(["OPEN", "MET"]).default("OPEN"),
  checkedAt: resumeTime.nullable().default(null),
  metAt: resumeTime.nullable().default(null),
  evidence: z.string().trim().min(1).nullable().default(null)
}).strict();
export const planParkedSchema = z.object({
  reason: z.string().trim().min(1),
  since: resumeTime.default(() => new Date().toISOString()),
  conditions: z.array(planResumeConditionSchema).min(1)
    .transform((conditions) => conditions.map((condition, index) => ({ ...condition, id: condition.id ?? `c${index + 1}` }))),
  /** Set by Space when every condition was met and it reopened the plan; a resumed record stays as the plan's history. */
  resumedAt: resumeTime.nullable().default(null)
}).strict();
export type PlanParked = z.infer<typeof planParkedSchema>;
export type PlanResumeCondition = PlanParked["conditions"][number];
/** Parked now: a record that Space has not resumed. */
export const planIsParked = <T extends { parked?: PlanParked | null }>(plan: T): plan is T & { parked: PlanParked } => Boolean(plan.parked && !plan.parked.resumedAt);

/**
 * What a plan reads as (operator 23/11, phone: a plan parked at 69% read "Done"). Parking closes a plan (COMPLETED), so COMPLETED alone
 * is not done: a parked plan, or a closed one with work left, reads PARKED with its reason and the first open condition it waits on.
 */
export function planShownStatus(plan: {
  status: string; progress: number; steps?: ReadonlyArray<{ status: string }>;
  parked?: { reason: string; resumedAt?: string | null; conditions?: ReadonlyArray<{ what: string; state: string }> } | null;
}): { status: string; reason: string | null; waitsOn: string | null } {
  const parked = plan.parked && !plan.parked.resumedAt ? plan.parked : null;
  const workLeft = plan.progress < 100 || Boolean(plan.steps?.some((step) => step.status !== "COMPLETED"));
  if (!parked && !(plan.status === "COMPLETED" && workLeft)) return { status: plan.status, reason: null, waitsOn: null };
  return { status: "PARKED", reason: parked?.reason ?? null, waitsOn: parked?.conditions?.find((condition) => condition.state !== "MET")?.what ?? null };
}

/** Operator 22/11 (50 plans closed at 100% with steps still PENDING/IN_PROGRESS/BLOCKED): a plan that closes takes its open steps with it. */
export function closeOpenPlanSteps<S extends { status: string; progress: number; completedAt?: string | null }>(steps: S[], at = new Date().toISOString()): S[] {
  return steps.map((step) => step.status === "COMPLETED" || step.status === "FAILED" ? step : { ...step, status: "COMPLETED", progress: 100, completedAt: at });
}

/** Why `planId` may not depend on `dependsOn` (itself, a plan that is not open, a loop); null when it may. */
export function planDependencyProblem(planId: string | null, dependsOn: string[], plans: ReadonlyArray<{ id: string; dependsOn: string[] }>): string | null {
  if (planId && dependsOn.includes(planId)) return "A plan cannot depend on itself.";
  const known = new Map(plans.map((plan) => [plan.id, plan.dependsOn]));
  const missing = dependsOn.find((id) => !known.has(id));
  if (missing) return `Plan ${missing} is not an open plan.`;
  if (!planId) return null;
  known.set(planId, dependsOn);
  const walk = (id: string, path: string[]): string[] | null => {
    for (const next of known.get(id) ?? []) {
      if (next === planId) return [...path, id, next];
      if (path.includes(next)) continue;
      const loop = walk(next, [...path, id]);
      if (loop) return loop;
    }
    return null;
  };
  const loop = walk(planId, []);
  return loop ? `The dependency would loop: ${loop.join(" → ")}.` : null;
}
/**
 * `dependsOn` without the plans already completed, and why the rest may not be named (planDependencyProblem). A completed plan is a met
 * dependency, as the plan map reads it, so it is dropped rather than refused (15/11 13:42Z: "Plan clipboard:vStwchpvnWec is not an open plan"
 * three minutes after it was completed).
 */
export function checkPlanDependencies(planId: string | null, dependsOn: string[], plans: ReadonlyArray<{ id: string; dependsOn: string[]; done: boolean }>): { dependsOn: string[]; problem: string | null } {
  const done = new Set(plans.filter((plan) => plan.done && plan.id !== planId).map((plan) => plan.id));
  const open = dependsOn.filter((id) => !done.has(id));
  return { dependsOn: open, problem: planDependencyProblem(planId, open, plans.filter((plan) => !plan.done)) };
}
// Re-parking a plan that is still parked keeps its clock (the Score's "Parked plans" age), so re-parking never resets it.
export const keepParkedClock = (existing: PlanParked | null | undefined, next: PlanParked | null): PlanParked | null =>
  next && existing && !existing.resumedAt ? { ...next, since: existing.since } : next;
