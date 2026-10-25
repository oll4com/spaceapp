import { z } from "zod";
import { dotIdSchema } from "./dots.js";

/**
 * Space Dots Stage 4: provider-neutral Goals.
 *
 * A Goal runs as ordinary Chat turns ("steps") in one Dot session, driven by a
 * Temporal workflow on the server. It continues while the browser is closed,
 * survives worker restarts, and stops on completion, cancellation, a blocking
 * question or its budget. The Dot reports progress through goal tools; the
 * owner can pause, resume, cancel and steer it.
 */
export const DOT_GOAL_SIGNAL = "dotGoalWake";
export const dotGoalStatusSchema = z.enum(["ACTIVE", "PAUSED", "COMPLETED", "BLOCKED", "CANCELLED", "BUDGET_EXHAUSTED", "FAILED"]);
/** BLOCKED waits for the user's answer and can resume; the other statuses are final. */
export const dotGoalOpenStatuses = ["ACTIVE", "PAUSED", "BLOCKED"] as const;
export const dotGoalMilestoneSchema = z.object({
  id: z.string().regex(/^m[0-9]{1,2}$/),
  title: z.string().trim().min(1).max(300),
  status: z.enum(["PENDING", "IN_PROGRESS", "DONE"]),
  note: z.string().max(1000).nullable()
}).strict();
export const dotGoalBudgetSchema = z.object({
  maxSteps: z.number().int().min(1).max(200),
  maxMinutes: z.number().int().min(5).max(1440)
}).strict();
export const dotGoalUsageSchema = z.object({
  steps: z.number().int().min(0),
  lastRunId: z.string().max(200).nullable(),
  lastStepAt: z.iso.datetime().nullable(),
  consecutiveFailures: z.number().int().min(0)
}).strict();
export const dotGoalSteeringSchema = z.object({
  id: z.string().min(1).max(80),
  text: z.string().trim().min(1).max(4000),
  createdAt: z.iso.datetime(),
  deliveredAt: z.iso.datetime().nullable()
}).strict();
export const dotGoalEvidenceSchema = z.object({ criterion: z.string().trim().min(1).max(500), evidence: z.string().trim().min(1).max(2000) }).strict();
export const dotGoalSchema = z.object({
  goalId: z.string().regex(/^dot_goal:[A-Za-z0-9_-]{8,64}$/),
  dotId: dotIdSchema,
  ownerUserId: z.string().min(1).max(200),
  roomId: z.string().min(1).max(200),
  sessionId: z.string().min(1).max(200),
  objective: z.string().trim().min(1).max(4000),
  milestones: z.array(dotGoalMilestoneSchema).max(20),
  criteria: z.array(z.string().trim().min(1).max(500)).max(10),
  budget: dotGoalBudgetSchema,
  usage: dotGoalUsageSchema,
  status: dotGoalStatusSchema,
  statusReason: z.string().max(1000).nullable(),
  steering: z.array(dotGoalSteeringSchema).max(50),
  evidence: z.array(dotGoalEvidenceSchema).max(10).nullable(),
  workflowId: z.string().min(1).max(300),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  completedAt: z.iso.datetime().nullable()
}).strict();
export const createDotGoalInputSchema = z.object({
  sessionId: z.string().trim().min(1).max(200),
  objective: z.string().trim().min(1).max(4000),
  milestones: z.array(z.string().trim().min(1).max(300)).max(20).default([]),
  criteria: z.array(z.string().trim().min(1).max(500)).max(10).default([]),
  budget: dotGoalBudgetSchema.partial().default({})
}).strict();
export const dotGoalControlInputSchema = z.object({ action: z.enum(["PAUSE", "RESUME", "CANCEL"]) }).strict();
export const dotGoalSteerInputSchema = z.object({ text: z.string().trim().min(1).max(4000) }).strict();
export const defaultDotGoalBudget = { maxSteps: 20, maxMinutes: 180 } as const;
export type DotGoal = z.infer<typeof dotGoalSchema>;
export type DotGoalStatus = z.infer<typeof dotGoalStatusSchema>;
export type DotGoalMilestone = z.infer<typeof dotGoalMilestoneSchema>;
export type CreateDotGoalInput = z.infer<typeof createDotGoalInputSchema>;

export function dotGoalWorkflowId(goalId: string): string { return `dot-goal:${goalId}`; }

/** Remaining budget, in steps and minutes, given the goal's creation time. */
export function dotGoalBudgetState(goal: Pick<DotGoal, "budget" | "usage" | "createdAt">, now = Date.now()) {
  const elapsedMinutes = Math.max(0, (now - Date.parse(goal.createdAt)) / 60_000);
  return { stepsLeft: Math.max(0, goal.budget.maxSteps - goal.usage.steps), minutesLeft: Math.max(0, goal.budget.maxMinutes - elapsedMinutes),
    exhausted: goal.usage.steps >= goal.budget.maxSteps || elapsedMinutes >= goal.budget.maxMinutes };
}

/** Upper bound of one Goal step message (the Chat message limit is 8,000 characters). */
export const DOT_GOAL_STEP_PROMPT_MAX_CHARS = 7900;
const dotGoalStepInstruction = "Make concrete progress on the next unfinished milestone in this step. Record progress with goal.update, call goal.complete with evidence for every criterion only when all are met, or goal.block with a question if you need me. Do not repeat actions that already completed.";
type DotGoalStepInput = Pick<DotGoal, "objective" | "milestones" | "criteria" | "budget" | "usage" | "steering">;
type MilestoneDetail = "FULL" | "SHORT" | "IDS";

/**
 * The visible user message that starts one Goal step, and the guidance notes it
 * delivers. Each step restates the Goal because the provider may compact or
 * truncate earlier turns natively; Space never summarizes the conversation.
 * The step header, every "Done when" criterion and the closing instruction are
 * never shortened. All guidance, new and earlier, is restated while it fits.
 * Over the limit, Space leaves out in order: the oldest earlier guidance,
 * milestone detail, the newest undelivered guidance (which stays pending) and
 * finally the objective's tail, and names what it left out with a pointer to
 * goal.status.
 */
export function dotGoalStepMessage(goal: DotGoalStepInput, step: number): { prompt: string; deliveredSteeringIds: string[] } {
  const header = `Goal step ${step} of at most ${goal.budget.maxSteps}.`;
  const criteria = `Done when:\n${goal.criteria.length ? goal.criteria.map((criterion) => `- ${criterion}`).join("\n") : "- The objective is fully achieved."}`;
  const pending = goal.steering.filter((entry) => !entry.deliveredAt);
  const earlier = goal.steering.filter((entry) => entry.deliveredAt);
  const mark = (status: DotGoalMilestone["status"]) => status === "DONE" ? "x" : status === "IN_PROGRESS" ? "~" : " ";
  const milestoneText = (detail: MilestoneDetail) => !goal.milestones.length ? "- (none set; work toward the objective directly)"
    : detail === "IDS" ? goal.milestones.map((milestone) => `[${mark(milestone.status)}] ${milestone.id}`).join(" ")
      : goal.milestones.map((milestone) => `- [${mark(milestone.status)}] ${milestone.id}: ${detail === "SHORT" && milestone.title.length > 60
        ? `${milestone.title.slice(0, 59)}…` : milestone.title}`).join("\n");
  const state = { objective: goal.objective, objectiveShortened: false, milestones: "FULL" as MilestoneDetail,
    pendingCount: pending.length, earlierCount: earlier.length };
  const build = () => {
    const shownEarlier = earlier.slice(earlier.length - state.earlierCount);
    const omitted = [
      state.objectiveShortened ? "the end of the objective" : null,
      state.milestones !== "FULL" && goal.milestones.length ? "milestone titles" : null,
      pending.length > state.pendingCount ? `${pending.length - state.pendingCount} new guidance note(s)` : null,
      earlier.length > state.earlierCount ? `${earlier.length - state.earlierCount} earlier guidance note(s)` : null
    ].filter(Boolean);
    return [
      header,
      `Objective: ${state.objective}`,
      `Milestones:\n${milestoneText(state.milestones)}`,
      criteria,
      ...(state.pendingCount ? [`New guidance from me:\n${pending.slice(0, state.pendingCount).map((entry) => `- ${entry.text}`).join("\n")}`] : []),
      ...(shownEarlier.length ? [`Earlier guidance from me (still applies):\n${shownEarlier.map((entry) => `- ${entry.text}`).join("\n")}`] : []),
      ...(omitted.length ? [`Not shown to fit the message limit: ${omitted.join("; ")}. Read the complete Goal and all guidance with goal.status before acting.`] : []),
      dotGoalStepInstruction
    ].join("\n\n");
  };
  const fits = () => build().length <= DOT_GOAL_STEP_PROMPT_MAX_CHARS;
  while (!fits() && state.earlierCount > 0) state.earlierCount--;
  if (!fits()) state.milestones = "SHORT";
  if (!fits()) state.milestones = "IDS";
  while (!fits() && state.pendingCount > 0) state.pendingCount--;
  if (!fits()) {
    // Criteria (at most 10 x 500 characters), header and instruction always leave room for part of the objective.
    state.objectiveShortened = true;
    const overflow = build().length - DOT_GOAL_STEP_PROMPT_MAX_CHARS;
    state.objective = `${goal.objective.slice(0, Math.max(0, goal.objective.length - overflow - 1))}…`;
  }
  return { prompt: build(), deliveredSteeringIds: pending.slice(0, state.pendingCount).map((entry) => entry.id) };
}

export function dotGoalStepPrompt(goal: DotGoalStepInput, step: number): string {
  return dotGoalStepMessage(goal, step).prompt;
}
