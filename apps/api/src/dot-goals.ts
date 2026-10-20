import { createHash } from "node:crypto";
import { z } from "zod";
import { Client, Connection, WorkflowExecutionAlreadyStartedError, WorkflowNotFoundError } from "@temporalio/client";
import type { FastifyInstance, FastifyRequest, RouteShorthandOptions } from "fastify";
import {
  createDotGoalInputSchema,
  defaultDotGoalBudget,
  DOT_GOAL_SIGNAL,
  dotGoalBudgetState,
  dotGoalControlInputSchema,
  dotGoalStepMessage,
  dotGoalSteerInputSchema,
  dotGoalWorkflowId,
  dotIdSchema,
  type DotGoal
} from "@space/contracts";
import { SpaceConflictError, SpaceNotFoundError, type SpaceStore } from "@space/runtime";
import type { DotGoalsRepository, DotsRepository } from "@space/db";
import { traceparentForTraceId, workflowCorrelationMemo } from "./trace-context.js";

/**
 * Space Dots Stage 4: Goals.
 *
 * The owner sets a Goal on a Dot conversation. A Temporal workflow drives it:
 * each step is an ordinary Chat turn started here with an idempotent request
 * key, so a retried step never sends twice. Steps stop on completion, a
 * blocking question, cancellation, three consecutive failures or the budget.
 */
export interface DotGoalWorkflowCoordinator {
  start(goalId: string, traceId?: string): Promise<void>;
  wake(goalId: string): Promise<void>;
  /** Starts the Goal's workflow when none is running; true when it had to start one. */
  ensure?(goalId: string): Promise<boolean>;
}
export class TemporalDotGoalWorkflowCoordinator implements DotGoalWorkflowCoordinator {
  constructor(private readonly options: { address: string; namespace: string; taskQueue: string }) {}
  private async client<T>(action: (client: Client) => Promise<T>): Promise<T> {
    const connection = await Connection.connect({ address: this.options.address, connectTimeout: "5s" });
    try { return await action(new Client({ connection, namespace: this.options.namespace })); }
    finally { await connection.close(); }
  }
  /** Start a goal once; carry optional HTTP ancestry in memo without changing the workflow input. */
  start(goalId: string, traceId?: string) {
    return this.client(async (client) => {
      try {
        await client.workflow.start("dotGoalWorkflow", { workflowId: dotGoalWorkflowId(goalId), taskQueue: this.options.taskQueue,
          args: [{ goalId }], workflowIdReusePolicy: "REJECT_DUPLICATE",
          memo: workflowCorrelationMemo({ traceId, traceparent: traceparentForTraceId(traceId) }) });
      } catch (error) { if (!(error instanceof WorkflowExecutionAlreadyStartedError)) throw error; }
    });
  }
  wake(goalId: string) {
    return this.client(async (client) => {
      try { await client.workflow.getHandle(dotGoalWorkflowId(goalId)).signal(DOT_GOAL_SIGNAL); }
      catch (error) { if (!(error instanceof WorkflowNotFoundError)) throw error; }
    });
  }
  ensure(goalId: string) {
    return this.client(async (client) => {
      try {
        await client.workflow.start("dotGoalWorkflow", { workflowId: dotGoalWorkflowId(goalId), taskQueue: this.options.taskQueue,
          args: [{ goalId }], workflowIdReusePolicy: "ALLOW_DUPLICATE" });
        return true;
      } catch (error) {
        if (error instanceof WorkflowExecutionAlreadyStartedError) return false;
        throw error;
      }
    });
  }
}
export function createDotGoalWorkflowCoordinator(options: { enabled: boolean; address: string; namespace: string; taskQueue: string }): DotGoalWorkflowCoordinator | null {
  return options.enabled ? new TemporalDotGoalWorkflowCoordinator(options) : null;
}

export interface DotGoalServiceDeps {
  store: SpaceStore;
  dots: DotsRepository;
  goals: DotGoalsRepository;
  workflow: DotGoalWorkflowCoordinator | null;
  /** Sends a visible Chat turn in the Goal's conversation (idempotent by request key). */
  sendStep(input: { paneId: string; sessionId: string; ownerUserId: string; content: string; requestKey: string }): Promise<{ runId: string }>;
  interrupt(paneId: string, reason: string): Promise<void>;
  /** A step this Goal already submitted under its request key, if any (survives retries and restarts). */
  submission(paneId: string, requestKey: string): Promise<{ runId: string; status: string } | null>;
  /** Whether the Dot is at its concurrent-task limit for autonomous work. */
  atCapacity(session: { sessionId: string; dotId: string; roomId: string }): Promise<boolean>;
  /** Goal tools need the native tool gateway: the Codex provider outside ask-for-approval mode. */
  supportsGoalTools(session: { selectedProviderId: string | null; permissionMode: string | null }): boolean;
  audit(request: FastifyRequest | null, action: string, roomId: string, metadata: Record<string, unknown>): Promise<void>;
}
export class DotGoalError extends Error {
  constructor(readonly status: 400 | 404 | 409 | 503, readonly code: string, message: string) { super(message); }
}

export type DotGoalStepState =
  | { state: "STARTED" | "BUSY"; runId: string; goal: DotGoal }
  | { state: "PAUSED" | "WAITING" | "DONE"; goal: DotGoal };

function requestKeyFor(goalId: string, step: number): string {
  return `goal-${createHash("sha256").update(`${goalId}:${step}`).digest("hex").slice(0, 40)}`;
}

export function createDotGoalService(deps: DotGoalServiceDeps) {
  async function activeSession(goal: DotGoal) {
    const session = await deps.store.getSpaceAgentSession(goal.sessionId);
    return session?.isActive && session.dotId === goal.dotId ? session : null;
  }
  async function finish(goal: DotGoal, status: DotGoal["status"], reason: string) {
    return (await deps.goals.transition(goal.goalId, ["ACTIVE", "PAUSED"], status, reason)) ?? goal;
  }

  async function create(owner: string, dotId: string, raw: unknown, request: FastifyRequest | null): Promise<DotGoal> {
    const input = createDotGoalInputSchema.parse(raw);
    if (!deps.workflow) throw new DotGoalError(503, "DOT_GOALS_UNAVAILABLE", "Goals need the Space worker runtime.");
    if (!await deps.dots.get(owner, dotId)) throw new DotGoalError(404, "DOT_NOT_FOUND", "Dot was not found.");
    const session = await deps.store.getSpaceAgentSession(input.sessionId);
    if (!session?.isActive || session.dotId !== dotId) throw new DotGoalError(409, "DOT_GOAL_SESSION", "Open this Dot's conversation before setting a Goal.");
    const room = await deps.store.getRoom(session.roomId);
    if (room.ownerUserId !== owner) throw new DotGoalError(404, "DOT_NOT_FOUND", "Dot was not found.");
    if (!deps.supportsGoalTools({ selectedProviderId: session.selectedProviderId ?? null, permissionMode: session.permissionMode ?? null })) {
      throw new DotGoalError(409, "DOT_GOAL_PROVIDER", "Goals need a Codex model and a permission mode other than Ask for approval, so the Dot can report progress.");
    }
    let goal: DotGoal;
    try {
      goal = await deps.goals.create({ dotId, ownerUserId: owner, roomId: session.roomId, sessionId: session.sessionId,
        objective: input.objective, milestones: input.milestones, criteria: input.criteria, budget: { ...defaultDotGoalBudget, ...input.budget } });
    } catch (error) {
      if ((error as { code?: string }).code === "DOT_GOAL_OPEN") throw new DotGoalError(409, "DOT_GOAL_OPEN", "This conversation already has an open Goal.");
      throw error;
    }
    try { await deps.workflow.start(goal.goalId, request?.id); }
    catch {
      goal = await finish(goal, "FAILED", "The Goal runtime could not start. Try again.");
      throw new DotGoalError(503, "DOT_GOAL_RUNTIME", "The Goal runtime could not start. Try again.");
    }
    await deps.audit(request, "dot.goal.create", goal.roomId, { dotId, goalId: goal.goalId });
    return goal;
  }

  async function control(owner: string, dotId: string, goalId: string, raw: unknown, request: FastifyRequest | null): Promise<DotGoal> {
    const { action } = dotGoalControlInputSchema.parse(raw);
    const goal = await deps.goals.getOwned(owner, dotId, goalId);
    if (!goal) throw new DotGoalError(404, "DOT_GOAL_NOT_FOUND", "Goal was not found.");
    const next = action === "PAUSE" ? await deps.goals.transition(goalId, ["ACTIVE"], "PAUSED", "Paused by the user.")
      : action === "RESUME" ? await deps.goals.transition(goalId, ["PAUSED", "BLOCKED"], "ACTIVE", null)
      : await deps.goals.transition(goalId, ["ACTIVE", "PAUSED", "BLOCKED"], "CANCELLED", "Cancelled by the user.");
    if (!next) throw new DotGoalError(409, "DOT_GOAL_STATE", `The Goal cannot ${action.toLowerCase()} while it is ${goal.status.toLowerCase()}.`);
    if (action === "CANCEL") {
      const session = await activeSession(goal);
      const run = session ? await deps.store.getLatestSpaceAgentRun(session.sessionId) : null;
      if (session && run && (run.status === "QUEUED" || run.status === "RUNNING")) await deps.interrupt(session.paneId, "Goal cancelled by the user.").catch(() => undefined);
    }
    await deps.workflow?.wake(goalId).catch(() => undefined);
    await deps.audit(request, "dot.goal.control", goal.roomId, { dotId, goalId, action });
    return next;
  }

  async function steer(owner: string, dotId: string, goalId: string, raw: unknown, request: FastifyRequest | null): Promise<DotGoal> {
    const { text } = dotGoalSteerInputSchema.parse(raw);
    const goal = await deps.goals.getOwned(owner, dotId, goalId);
    if (!goal) throw new DotGoalError(404, "DOT_GOAL_NOT_FOUND", "Goal was not found.");
    const next = await deps.goals.addSteering(goalId, text);
    if (!next) throw new DotGoalError(409, "DOT_GOAL_STATE", "Guidance can be added only to an open Goal, up to 50 notes.");
    await deps.workflow?.wake(goalId).catch(() => undefined);
    await deps.audit(request, "dot.goal.steer", goal.roomId, { dotId, goalId });
    return next;
  }

  /** One workflow iteration: start the next step, or report why not. Idempotent per step number. */
  async function step(goalId: string): Promise<DotGoalStepState> {
    let goal = await deps.goals.get(goalId);
    if (!goal) throw new DotGoalError(404, "DOT_GOAL_NOT_FOUND", "Goal was not found.");
    if (goal.status === "PAUSED" || goal.status === "BLOCKED") return { state: "PAUSED", goal };
    if (goal.status !== "ACTIVE") return { state: "DONE", goal };
    const session = await activeSession(goal);
    if (!session) return { state: "DONE", goal: await finish(goal, "CANCELLED", "The Goal's conversation was closed.") };
    const latest = await deps.store.getLatestSpaceAgentRun(session.sessionId);
    if (latest && (latest.status === "QUEUED" || latest.status === "RUNNING")) return { state: "BUSY", runId: latest.runId, goal };
    // A step submitted before a crash or retry is reconciled, never rebuilt and resent.
    for (let guard = 0; guard < 3; guard++) {
      const key = requestKeyFor(goal.goalId, goal.usage.steps + 1);
      const existing = await deps.submission(session.paneId, key);
      if (!existing) break;
      if (existing.status === "QUEUED" || existing.status === "RUNNING") return { state: "BUSY", runId: existing.runId, goal };
      goal = await deps.goals.recordStep(goal.goalId, existing.runId, existing.status !== "COMPLETED") ?? goal;
    }
    // An approval request belongs to the owner; the Goal waits instead of sending around it.
    if (await deps.dots.hasPendingApproval(session.sessionId)) return { state: "WAITING", goal };
    if (goal.usage.consecutiveFailures >= 3) return { state: "DONE", goal: await finish(goal, "FAILED", "Three consecutive steps failed.") };
    if (dotGoalBudgetState(goal).exhausted) return { state: "DONE", goal: await finish(goal, "BUDGET_EXHAUSTED", "The Goal used its step or time budget.") };
    if (await deps.atCapacity({ sessionId: session.sessionId, dotId: goal.dotId, roomId: goal.roomId })) return { state: "WAITING", goal };
    const stepNumber = goal.usage.steps + 1;
    // Only guidance that fitted in this step's message is marked delivered; the rest stays pending.
    const message = dotGoalStepMessage(goal, stepNumber);
    const pendingSteering = message.deliveredSteeringIds;
    let runId: string;
    try {
      ({ runId } = await deps.sendStep({ paneId: session.paneId, sessionId: session.sessionId, ownerUserId: goal.ownerUserId,
        content: message.prompt, requestKey: requestKeyFor(goal.goalId, stepNumber) }));
    } catch (error) {
      // A busy conversation, a pending request or a changed session is a reason to wait, not to fail the Goal.
      if (error instanceof SpaceConflictError) return { state: "WAITING", goal };
      if (error instanceof SpaceNotFoundError) return { state: "DONE", goal: await finish(goal, "CANCELLED", "The Goal's pane was closed.") };
      throw error;
    }
    await deps.goals.markSteeringDelivered(goal.goalId, pendingSteering);
    goal = (await deps.goals.get(goalId)) ?? goal;
    // A cancel or pause that raced this send stops the step it would have missed.
    if (goal.status === "CANCELLED") await deps.interrupt(session.paneId, "Goal cancelled by the user.").catch(() => undefined);
    return { state: "STARTED", runId, goal };
  }

  /** Records a finished step once and returns whether the workflow should continue. */
  async function observe(goalId: string, runId: string): Promise<{ run: string; goal: DotGoal }> {
    const goal = await deps.goals.get(goalId);
    if (!goal) throw new DotGoalError(404, "DOT_GOAL_NOT_FOUND", "Goal was not found.");
    const run = await deps.dots.getRunSummary(runId);
    if (!run || run.sessionId !== goal.sessionId) return { run: "MISSING", goal };
    if (run.status === "QUEUED" || run.status === "RUNNING") return { run: run.status, goal };
    // Only steps the Goal started count against its budget; a user's own turn does not.
    if (!run.clientRequestId?.startsWith("goal-")) return { run: run.status, goal };
    const updated = await deps.goals.recordStep(goalId, runId, run.status !== "COMPLETED") ?? goal;
    return { run: run.status, goal: updated };
  }

  /** Goal tools for the Dot gateway; bound to the calling conversation's open Goal. */
  async function tool(sessionId: string, toolId: string, args: Record<string, unknown>): Promise<{ status: "COMPLETED" | "BLOCKED"; statusReason: string | null; result?: unknown }> {
    const goal = await deps.goals.openForSession(sessionId);
    if (!goal) return { status: "BLOCKED", statusReason: "This conversation has no open Goal." };
    switch (toolId) {
      case "goal.status": return { status: "COMPLETED", statusReason: null, result: { goalId: goal.goalId, status: goal.status, objective: goal.objective,
        milestones: goal.milestones, criteria: goal.criteria, budget: goal.budget, usage: goal.usage, remaining: dotGoalBudgetState(goal),
        guidance: goal.steering.map((entry) => entry.text) } };
      case "goal.update": {
        const input = z.object({ milestoneId: z.string().regex(/^m[0-9]{1,2}$/), status: z.enum(["IN_PROGRESS", "DONE"]), note: z.string().max(1000).optional() }).strict().safeParse(args);
        if (!input.success) return { status: "BLOCKED", statusReason: "goal.update needs milestoneId and status IN_PROGRESS or DONE." };
        const next = await deps.goals.updateMilestone(goal.goalId, input.data.milestoneId, input.data.status, input.data.note ?? null);
        return next ? { status: "COMPLETED", statusReason: null, result: { milestones: next.milestones } }
          : { status: "BLOCKED", statusReason: "Milestone not found, or the Goal is not active." };
      }
      case "goal.complete": {
        const input = z.object({ evidence: z.array(z.object({ criterion: z.string().trim().min(1).max(500), evidence: z.string().trim().min(1).max(2000) }).strict()).min(1).max(10) }).strict().safeParse(args);
        if (!input.success) return { status: "BLOCKED", statusReason: "goal.complete needs evidence for each criterion." };
        const covered = new Set(input.data.evidence.map((entry) => entry.criterion.trim().toLocaleLowerCase()));
        const missing = goal.criteria.filter((criterion) => !covered.has(criterion.trim().toLocaleLowerCase()));
        if (missing.length) return { status: "BLOCKED", statusReason: `Provide evidence for: ${missing.join("; ").slice(0, 900)}` };
        const unfinished = goal.milestones.filter((milestone) => milestone.status !== "DONE").map((milestone) => milestone.id);
        if (unfinished.length) return { status: "BLOCKED", statusReason: `Finish or update milestones first: ${unfinished.join(", ")}.` };
        const next = await deps.goals.complete(goal.goalId, input.data.evidence);
        return next ? { status: "COMPLETED", statusReason: null, result: { status: next.status } } : { status: "BLOCKED", statusReason: "The Goal is not active." };
      }
      case "goal.block": {
        const input = z.object({ reason: z.string().trim().min(1).max(1000) }).strict().safeParse(args);
        if (!input.success) return { status: "BLOCKED", statusReason: "goal.block needs a reason." };
        const next = await deps.goals.transition(goal.goalId, ["ACTIVE"], "BLOCKED", input.data.reason);
        return next ? { status: "COMPLETED", statusReason: null, result: { status: next.status } } : { status: "BLOCKED", statusReason: "The Goal is not active." };
      }
      default: return { status: "BLOCKED", statusReason: "Unknown Goal tool." };
    }
  }
  /** Restarts the driver of any open Goal whose workflow has ended (crash, history limit, operator restart). */
  async function reconcile(limit = 50): Promise<number> {
    if (!deps.workflow?.ensure) return 0;
    let restarted = 0;
    for (const goal of await deps.goals.listOpen(limit)) {
      if (await deps.workflow.ensure(goal.goalId).catch(() => false)) restarted += 1;
    }
    return restarted;
  }
  return { create, control, steer, step, observe, tool, reconcile };
}
export type DotGoalService = ReturnType<typeof createDotGoalService>;

export function registerDotGoalRoutes(app: FastifyInstance, service: DotGoalService | null, deps: { goals: DotGoalsRepository } | null, options: {
  routeOptions: RouteShorthandOptions;
  authenticatedOwner: (request: FastifyRequest) => Promise<string>;
}) {
  const params = z.object({ dotId: dotIdSchema }).strict();
  const goalParams = z.object({ dotId: dotIdSchema, goalId: z.string().regex(/^dot_goal:[A-Za-z0-9_-]{8,64}$/) }).strict();
  const failure = (reply: import("fastify").FastifyReply, error: unknown) => {
    if (error instanceof DotGoalError) return reply.code(error.status).send({ error: { code: error.code, message: error.message } });
    if (error instanceof z.ZodError) return reply.code(400).send({ error: { code: "DOT_GOAL_INVALID", message: "Goal request is invalid." } });
    throw error;
  };
  const user = (action: (request: FastifyRequest, owner: string, goals: DotGoalService, repo: DotGoalsRepository) => Promise<unknown>) =>
    async (request: FastifyRequest, reply: import("fastify").FastifyReply) => {
      if (!request.user) return reply.code(401).send({ error: { code: "UNAUTHENTICATED", message: "Sign in to use Dots." } });
      if (request.user.automationScope || request.user.proofScope === "READ_ONLY") {
        return reply.code(403).send({ error: { code: "DOTS_SCOPE_FORBIDDEN", message: "An interactive user session is required." } });
      }
      if (!service || !deps) return reply.code(503).send({ error: { code: "DOT_GOALS_UNAVAILABLE", message: "Goals are unavailable." } });
      try { return await action(request, await options.authenticatedOwner(request), service, deps.goals); }
      catch (error) { return failure(reply, error); }
    };
  app.get("/api/dots/:dotId/goals", options.routeOptions, user(async (request, owner, _service, goals) => {
    const { dotId } = params.parse(request.params);
    const { sessionId } = z.object({ sessionId: z.string().trim().min(1).max(200).optional() }).strict().parse(request.query);
    return { dotId, items: await goals.list(owner, dotId, sessionId) };
  }));
  app.post("/api/dots/:dotId/goals", options.routeOptions, user(async (request, owner, goals) => {
    const { dotId } = params.parse(request.params);
    return { goal: await goals.create(owner, dotId, request.body ?? {}, request) };
  }));
  app.post("/api/dots/:dotId/goals/:goalId/control", options.routeOptions, user(async (request, owner, goals) => {
    const { dotId, goalId } = goalParams.parse(request.params);
    return { goal: await goals.control(owner, dotId, goalId, request.body ?? {}, request) };
  }));
  app.post("/api/dots/:dotId/goals/:goalId/steer", options.routeOptions, user(async (request, owner, goals) => {
    const { dotId, goalId } = goalParams.parse(request.params);
    return { goal: await goals.steer(owner, dotId, goalId, request.body ?? {}, request) };
  }));
  const internalGoal = z.object({ goalId: z.string().regex(/^dot_goal:[A-Za-z0-9_-]{8,64}$/) }).strict();
  app.post("/api/internal/dots/goals/step", options.routeOptions, async (request, reply) => {
    if (!service) return reply.code(503).send({ error: { code: "DOT_GOALS_UNAVAILABLE", message: "Goals are unavailable." } });
    try { return await service.step(internalGoal.parse(request.body ?? {}).goalId); }
    catch (error) { return failure(reply, error); }
  });
  app.post("/api/internal/dots/goals/observe", options.routeOptions, async (request, reply) => {
    if (!service) return reply.code(503).send({ error: { code: "DOT_GOALS_UNAVAILABLE", message: "Goals are unavailable." } });
    try {
      const input = internalGoal.extend({ runId: z.string().trim().min(1).max(200) }).strict().parse(request.body ?? {});
      return await service.observe(input.goalId, input.runId);
    } catch (error) { return failure(reply, error); }
  });
}
