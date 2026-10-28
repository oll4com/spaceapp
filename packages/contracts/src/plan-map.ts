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
  what: z.string().trim().min(1).max(200),
  until: z.string().datetime({ offset: true }).nullable().default(null)
}).strict();
export type PlanWaitsOn = z.infer<typeof planWaitsOnSchema>;
/** The progress-update keys that change only the plan map: allowed on a managed plan too (its execution owns the rest). */
export const PLAN_MAP_KEYS = ["dependsOn", "dueAt", "waitsOn"] as const;

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
