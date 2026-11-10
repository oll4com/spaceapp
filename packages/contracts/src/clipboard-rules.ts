import type { z } from "zod";

type ClipboardPlanFields = {
  source: string;
  title?: string | null;
  minimumModel?: string | null;
  minimumReasoning?: string | null;
  dependsOn?: unknown;
  dueAt?: string | null;
};

/**
 * Business rule shared by the clipboard create request and the store's upsert input: title, minimum model and reasoning
 * belong to PLAN items, and a PLAN needs a minimum model (ARCH-002). The create request also keeps dependencies and due
 * dates to plans (`dependsOnAndDueAt`); the upsert input never checked them.
 */
export function planOnlyFields(input: ClipboardPlanFields, context: z.RefinementCtx, options: { dependsOnAndDueAt: boolean }): void {
  if (input.source !== "PLAN" && input.title != null) {
    context.addIssue({ code: "custom", path: ["title"], message: "Clipboard item titles are allowed only for PLAN items." });
  }
  if (options.dependsOnAndDueAt && input.source !== "PLAN" && (input.dependsOn != null || input.dueAt != null)) {
    context.addIssue({ code: "custom", path: [input.dependsOn != null ? "dependsOn" : "dueAt"], message: "Dependencies and due dates are allowed only for PLAN items." });
  }
  if (input.source === "PLAN" && (!input.minimumModel || input.minimumModel.trim().length === 0)) {
    context.addIssue({ code: "custom", path: ["minimumModel"], message: "Minimum model is required for PLAN items." });
  }
  if (input.source !== "PLAN" && input.minimumReasoning != null) {
    context.addIssue({ code: "custom", path: ["minimumReasoning"], message: "Reasoning recommendations are allowed only for PLAN items." });
  }
  if (input.source !== "PLAN" && input.minimumModel != null) {
    context.addIssue({ code: "custom", path: ["minimumModel"], message: "Minimum model is allowed only for PLAN items." });
  }
}
