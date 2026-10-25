import { createHash } from "node:crypto";
import { z } from "zod";
import { dotGoalBudgetState, type DotGoal, type DotProfile, type Pane } from "@space/contracts";
import type { SpaceStore } from "@space/runtime";
import type { DotDelegationsRepository, DotGoalsRepository, DotsRepository } from "@space/db";

/**
 * Space Dots Stage 4: explicit delegation between a user's Dots.
 *
 * A Dot asks another of the user's Dots to take on a task. After the owner
 * approves, the delegate gets its own Chat pane in the same room and a Goal
 * with only the task, the context the delegating Dot chose to pass and the
 * completion criteria — never the delegating conversation. Its step budget
 * never exceeds what remains of the delegating Dot's own Goal. When the Goal
 * finishes, stops or needs the user, the delegating conversation receives one
 * report per outcome. Space Control serializes changes to the same room.
 */
export const dotDelegateArgsSchema = z.object({
  to: z.string().trim().min(1).max(80),
  task: z.string().trim().min(1).max(4000),
  context: z.string().trim().max(4000).optional(),
  doneWhen: z.array(z.string().trim().min(1).max(500)).max(5).optional(),
  maxSteps: z.number().int().min(1).max(50).optional()
}).strict();
export type DotDelegateArgs = z.infer<typeof dotDelegateArgsSchema>;

export interface DotDelegationDeps {
  store: Pick<SpaceStore, "getSpaceAgentSession">;
  dots: Pick<DotsRepository, "list">;
  goals: Pick<DotGoalsRepository, "openForSession">;
  delegations: DotDelegationsRepository;
  /** Opens a Chat pane in the room for the delegate and returns it. */
  openPane(input: { owner: string; roomId: string; title: string }): Promise<Pane>;
  /** Starts the delegate's conversation in that pane. */
  startSession(input: { pane: Pane; owner: string; dotId: string }): Promise<{ sessionId: string }>;
  createGoal(owner: string, dotId: string, input: { sessionId: string; objective: string; criteria: string[]; budget: { maxSteps: number; maxMinutes: number } }): Promise<DotGoal>;
  closePane(paneId: string): Promise<void>;
  /** Sends a visible message into the delegating conversation; throws while it is busy. */
  report(input: { paneId: string; sessionId: string; ownerUserId: string; content: string; requestKey: string }): Promise<void>;
}

/** Finds the target Dot by name or slot among the owner's Dots. */
export function findDelegate(dots: DotProfile[], to: string, fromDotId: string): DotProfile | null {
  const wanted = to.trim().toLocaleLowerCase();
  const match = dots.find((dot) => dot.name.toLocaleLowerCase() === wanted || String(dot.slot) === wanted || dot.dotId === to.trim());
  return match && match.dotId !== fromDotId ? match : null;
}

export function createDotDelegationService(deps: DotDelegationDeps) {
  /** Runs an approved delegation. */
  async function delegate(session: { sessionId: string; dotId: string; roomId: string }, owner: string, raw: Record<string, unknown>) {
    const parsed = dotDelegateArgsSchema.safeParse(raw);
    if (!parsed.success) return { status: "BLOCKED" as const, statusReason: "dot.delegate needs to (a Dot's name), task and optional context, doneWhen and maxSteps." };
    const args = parsed.data;
    const dots = await deps.dots.list(owner);
    const from = dots.find((dot) => dot.dotId === session.dotId);
    const to = findDelegate(dots, args.to, session.dotId);
    if (!from || !to) return { status: "BLOCKED" as const, statusReason: `"${args.to}" is not another of the user's Dots.` };
    // Shared budget: the delegate never gets more steps than remain in the delegating Dot's own Goal.
    const parentGoal = await deps.goals.openForSession(session.sessionId);
    const parentLeft = parentGoal ? Math.floor(dotGoalBudgetState(parentGoal).stepsLeft) - 1 : null;
    if (parentLeft !== null && parentLeft < 1) return { status: "BLOCKED" as const, statusReason: "Your Goal has no steps left to share with another Dot." };
    const maxSteps = Math.max(1, Math.min(args.maxSteps ?? 8, parentLeft ?? 50));
    const pane = await deps.openPane({ owner, roomId: session.roomId, title: `${to.name} · for ${from.name}`.slice(0, 120) });
    try {
      const { sessionId } = await deps.startSession({ pane, owner, dotId: to.dotId });
      // Limited context: only what the delegating Dot chose to pass, never its conversation.
      const objective = [`Task from ${from.name}: ${args.task}`, args.context ? `Context from ${from.name}: ${args.context}` : null,
        "Work only on this task. When done, complete the Goal with evidence; if you need the user, block the Goal with your question."]
        .filter(Boolean).join("\n\n").slice(0, 4000);
      const goal = await deps.createGoal(owner, to.dotId, { sessionId, objective, criteria: args.doneWhen ?? [], budget: { maxSteps, maxMinutes: 120 } });
      const record = await deps.delegations.create({ ownerUserId: owner, roomId: session.roomId, fromDotId: from.dotId, fromSessionId: session.sessionId,
        toDotId: to.dotId, toSessionId: sessionId, goalId: goal.goalId, paneId: pane.id, task: args.task });
      return { status: "COMPLETED" as const, result: { delegationId: record.delegationId, to: to.name, paneId: pane.id, goalId: goal.goalId, maxSteps,
        next: `${to.name} is working on it in its own pane. Its result arrives here as a message; do not repeat the work meanwhile.` } };
    } catch (error) {
      await deps.closePane(pane.id).catch(() => undefined);
      return { status: "BLOCKED" as const, statusReason: `The delegation could not start: ${error instanceof Error ? error.message.slice(0, 300) : "unknown error"}` };
    }
  }

  /** Reports finished, stopped or blocked delegations to the delegating conversation; retried until delivered. */
  async function reportOutcomes(limit = 20): Promise<number> {
    let reported = 0;
    for (const item of await deps.delegations.unreported(limit)) {
      const session = await deps.store.getSpaceAgentSession(item.fromSessionId);
      if (!session?.isActive) { await deps.delegations.markReported(item.delegationId, item.goalStatus); continue; }
      const dots = await deps.dots.list(item.ownerUserId);
      const name = dots.find((dot) => dot.dotId === item.toDotId)?.name ?? "The other Dot";
      const evidence = Array.isArray(item.evidence)
        ? (item.evidence as Array<{ criterion?: string; evidence?: string }>).map((entry) => `- ${entry.criterion}: ${entry.evidence}`).join("\n") : "";
      const outcome = item.goalStatus === "COMPLETED" ? `finished it.${evidence ? `\nEvidence:\n${evidence}` : ""}`
        : item.goalStatus === "BLOCKED" ? `needs the user: ${item.goalStatusReason ?? "no reason given"}`
        : `stopped (${item.goalStatus.toLowerCase().replace("_", " ")}): ${item.goalStatusReason ?? "no reason given"}`;
      const content = `${name} reports on the task you delegated (“${item.task.slice(0, 200)}”): ${outcome}\nThe work is in ${name}'s pane in this room.`.slice(0, 7000);
      try {
        await deps.report({ paneId: session.paneId, sessionId: session.sessionId, ownerUserId: item.ownerUserId, content,
          requestKey: `delegation-${createHash("sha256").update(`${item.delegationId}:${item.goalStatus}`).digest("hex").slice(0, 40)}` });
      } catch {
        continue; // The delegating Dot is busy; the next sweep tries again.
      }
      if (await deps.delegations.markReported(item.delegationId, item.goalStatus)) reported += 1;
    }
    return reported;
  }
  return { delegate, reportOutcomes };
}
export type DotDelegationService = ReturnType<typeof createDotDelegationService>;
