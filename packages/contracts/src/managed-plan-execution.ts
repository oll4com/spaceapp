import { z } from "zod";
import type { PlanStep } from "./schemas.js";

export const stageModelSelectionSchema = z
  .object({
    modelId: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/),
    reasoningEffort: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/),
  })
  .strict();
export type StageModelSelection = z.infer<typeof stageModelSelectionSchema>;
export const managedPlanStageSchema = stageModelSelectionSchema
  .extend({
    id: z.string().trim().min(1).max(160),
    order: z.number().int().min(1),
    title: z.string().trim().min(1).max(200),
    instructions: z.string().trim().min(1).max(16000),
    completionCriteria: z
      .array(z.string().trim().min(1).max(2000))
      .min(1)
      .max(30),
  })
  .strict();
export type ManagedPlanStage = z.infer<typeof managedPlanStageSchema>;
export const managedPlanStageResultSchema = z
  .object({
    outcome: z.enum(["CONTINUE", "COMPLETED", "BLOCKED"]),
    summary: z.string().trim().min(1).max(4000),
    evidence: z
      .array(
        z
          .object({
            criterion: z.string().min(1).max(2000),
            result: z.string().min(1).max(4000),
          })
          .strict(),
      )
      .max(30),
  })
  .strict()
  .superRefine((result, ctx) => {
    if (result.outcome === "COMPLETED" && !result.evidence.length)
      ctx.addIssue({
        code: "custom",
        path: ["evidence"],
        message: "Completion requires criterion evidence.",
      });
  });
export type ManagedPlanStageResult = z.infer<
  typeof managedPlanStageResultSchema
>;
const stageCriterionKey = (text: string) => text.trim().replace(/\s+/g, " ").replace(/\.$/, "");
/** Models echo a criterion with other spacing or without its final period (Haiku, stable 2026-10-21); the words and case must match. */
export const sameStageCriterion = (evidence: string, criterion: string) =>
  stageCriterionKey(criterion) !== "" && stageCriterionKey(evidence) === stageCriterionKey(criterion);
export const managedPlanExecutionStatusSchema = z.enum([
  "RUNNING",
  "SWITCHING_MODEL",
  "RESUMING_STAGE",
  "WAITING_FOR_MODEL",
  "WAITING_FOR_INPUT",
  "PAUSED",
  "BLOCKED",
  "COMPLETED",
  "FAILED",
]);
export type ManagedPlanExecutionStatus = z.infer<
  typeof managedPlanExecutionStatusSchema
>;
export const managedPlanAttemptSchema = z
  .object({
    id: z.string(),
    stageId: z.string(),
    commandId: z.string(),
    turnId: z.string().nullable(),
    modelId: z.string(),
    reasoningEffort: z.string(),
    actualSelection: z.preprocess(value =>
      value && typeof value === "object" && "source" in value && value.source === "NATIVE_CURRENT_TURN" ? null : value,
      stageModelSelectionSchema.extend({ observedAt:z.string(),completedAt:z.string(),source:z.literal("NATIVE_ACCEPTED_TURN_CONFIGURATION"),
        threadId:z.string(),turnId:z.string(),commandId:z.string(),transport:z.literal("CONTINUOUS_NATIVE_NOTIFICATIONS"),providerTelemetry:z.literal(false)
      }).strict().nullable().default(null)) ,
    status: z.enum([
      "PREPARED",
      "RUNNING",
      "COMPLETED",
      "INTERRUPTED",
      "FAILED",
    ]),
    startedAt: z.string(),
    completedAt: z.string().nullable(),
    result: managedPlanStageResultSchema.nullable(),
  })
  .strict();
export const managedPlanCommandSchema = z.object({
  id: z.string(),
  type: z.enum(["START", "INTERRUPT", "SETTINGS"]),
  stageId: z.string(),
  turnId: z.string().nullable(),
  selection: stageModelSelectionSchema,
  preparedAt: z.string(),
  status: z.enum(["PREPARED", "SENT", "UNKNOWN"]),
  baselineTurnIds: z.array(z.string()),
}).strict();
export const managedPlanExecutionSchema = z
  .object({
    id: z.string(),
    ownerUserId: z.string(),
    planId: z.string(),
    paneId: z.string(),
    sessionId: z.string(),
    threadId: z.string(),
    cwd: z.string(),
    requestId: z.string(),
    snapshot: z
      .object({
        text: z.string(),
        title: z.string().nullable(),
        stages: z.array(managedPlanStageSchema).min(1),
      })
      .strict(),
    status: managedPlanExecutionStatusSchema,
    activeStageIndex: z.number().int().min(0),
    revision: z.number().int().min(0),
    eventCursor: z.number().int().min(-1).default(-1),
    events: z.array(z.object({ revision: z.number().int().min(0), status: managedPlanExecutionStatusSchema,
      activeStageIndex: z.number().int().min(0), createdAt: z.string() }).strict()).default([]),
    overrides: z.record(z.string(), stageModelSelectionSchema),
    attempts: z.array(managedPlanAttemptSchema),
    completedStageIds: z.array(z.string()),
    checkpoint: z.string().nullable(),
    correctionCount: z.number().int().min(0),
    pendingCommand: managedPlanCommandSchema.nullable(),
    interruptCommand: managedPlanCommandSchema.nullable().default(null),
    commands: z.array(managedPlanCommandSchema).default([]),
    interruptReason: z.enum(["OVERRIDE", "PAUSE"]).nullable(),
    nextRetryAt: z.string().nullable(),
    retryCount: z.number().int().min(0),
    statusReason: z.string().nullable(),
    /** Stable code of the limit or failure that ended a FAILED execution (e.g. PLAN_STAGE_ATTEMPT_LIMIT). */
    errorCode: z.string().regex(/^[A-Z][A-Z0-9_]{2,63}$/).nullable().optional(),
    lease: z
      .object({
        owner: z.string(),
        epoch: z.number().int().min(1),
        expiresAt: z.string(),
      })
      .strict()
      .nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .strict();
export type ManagedPlanExecution = z.infer<typeof managedPlanExecutionSchema>;
export type ManagedPlanAttempt = z.infer<typeof managedPlanAttemptSchema>;
export const startPlanExecutionRequestSchema = z
  .object({
    planId: z.string().min(1),
    expectedSessionId: z.string().min(1),
    requestId: z.string().min(1).max(160),
  })
  .strict();
export const planExecutionControlRequestSchema = z
  .object({
    action: z.enum(["pause", "resume"]),
    revision: z.number().int().min(0),
  })
  .strict();
export const planStageOverrideRequestSchema = z
  .object({
    selection: stageModelSelectionSchema.nullable(),
    revision: z.number().int().min(0),
  })
  .strict();
export type StartPlanExecutionRequest = z.infer<
  typeof startPlanExecutionRequestSchema
>;
export type PlanExecutionControlRequest = z.infer<
  typeof planExecutionControlRequestSchema
>;
export type PlanStageOverrideRequest = z.infer<
  typeof planStageOverrideRequestSchema
>;

/** Only explicit stage headings are executable; ordinary section headings are context. */
export function preparePlanStages(plan: { text: string; steps?: PlanStep[] }): {
  stages: ManagedPlanStage[];
  issues: string[];
} {
  const issues: string[] = [];
  const candidates: unknown[] = [];
  if (
    plan.steps?.some(
      (step) =>
        step.modelId ||
        step.reasoningEffort ||
        step.instructions ||
        step.completionCriteria,
    )
  ) {
    for (const step of plan.steps)
      candidates.push({
        id: step.id,
        order: step.order,
        title: step.title,
        modelId: step.modelId,
        reasoningEffort: step.reasoningEffort,
        instructions: step.instructions,
        completionCriteria: step.completionCriteria,
      });
  } else {
    const lines = plan.text.split(/\r?\n/);
    let fence: { char: string; length: number } | null = null;
    const visible = lines.map((line) => {
      const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
      if (fence) {
        if (
          marker &&
          marker[1]![0] === fence.char &&
          marker[1]!.length >= fence.length &&
          !marker[2]!.trim()
        )
          fence = null;
        return false;
      }
      if (marker) {
        fence = { char: marker[1]![0]!, length: marker[1]!.length };
        return false;
      }
      return true;
    });
    for (let i = 0; i < lines.length; i++) {
      if (!visible[i]) continue;
      const heading = /^(#{1,6})\s+(?:Stage|Στάδιο)\s+(\d+)\s*:\s*(.+)$/i.exec(
        lines[i]!,
      );
      if (!heading) continue;
      const assignments = [
        ...heading[3]!.matchAll(
          /\[([A-Za-z0-9][A-Za-z0-9._:-]*)\s*\/\s*([A-Za-z0-9_-]+)\]/g,
        ),
      ];
      const order = Number(heading[2]);
      let end = i + 1;
      while (
        end < lines.length &&
        (!visible[end] ||
          !new RegExp(`^#{1,${heading[1]!.length}}\\s`).test(lines[end]!))
      )
        end++;
      const body = lines
        .slice(i + 1, end)
        .join("\n")
        .trim();
      const criteria = lines
        .slice(i + 1, end)
        .filter((_, offset) => visible[i + 1 + offset])
        .flatMap((line) => {
          const match =
            /^\s*(?:Checks|Completion criteria|Acceptance criteria|Έλεγχοι|Ολοκλήρωση(?:\s+μόνο)?)\s*:\s*(.+)$/i.exec(
              line,
            );
          return match ? [match[1]!.trim()] : [];
        });
      if (assignments.length !== 1)
        issues.push(
          `Stage ${order} requires one unambiguous model/reasoning assignment.`,
        );
      candidates.push({
        id: `stage-${order}`,
        order,
        title: heading[3]!.replace(/\[[^\]]*\]/g, "").trim(),
        modelId: assignments[0]?.[1],
        reasoningEffort: assignments[0]?.[2],
        instructions: body,
        completionCriteria: criteria,
      });
      i = end - 1;
    }
  }
  const stages: ManagedPlanStage[] = [];
  for (const raw of candidates) {
    const result = managedPlanStageSchema.safeParse(raw);
    if (result.success) stages.push(result.data);
    else
      issues.push(
        ...result.error.issues.map(
          (issue) =>
            `Stage ${(raw as { order: number }).order}: ${issue.path.join(".")} ${issue.message}`,
        ),
      );
  }
  const ids = new Set<string>(),
    orders = new Set<number>();
  for (const stage of stages) {
    if (ids.has(stage.id) || orders.has(stage.order))
      issues.push(`Duplicate stage identity/order: ${stage.id}.`);
    ids.add(stage.id);
    orders.add(stage.order);
  }
  if (!candidates.length)
    issues.push(
      "This plan needs explicit executable stages with model, instructions and completion criteria.",
    );
  return { stages: stages.sort((a, b) => a.order - b.order), issues };
}
