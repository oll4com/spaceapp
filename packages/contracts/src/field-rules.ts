import type { z } from "zod";

/**
 * Business rule checked inside several superRefine blocks: a field is set exactly when a condition holds, required when
 * it does and refused when it does not (ARCH-002). The caller says what "set" means (truthy, or not null).
 */
export function fieldOnlyWhen(
  ctx: z.RefinementCtx,
  rule: { when: boolean; present: boolean; path: string; required: string; forbidden: string }
): void {
  if (rule.when && !rule.present) ctx.addIssue({ code: "custom", path: [rule.path], message: rule.required });
  if (!rule.when && rule.present) ctx.addIssue({ code: "custom", path: [rule.path], message: rule.forbidden });
}
