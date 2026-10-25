import { describe, expect, it, vi } from "vitest";
import { DOT_GOAL_STEP_PROMPT_MAX_CHARS, dotGoalStepMessage, type DotGoal } from "@space/contracts";
import { createDotGoalService, type DotGoalServiceDeps } from "../src/dot-goals.js";

/**
 * SIMULATED long-session continuation proof for Space Dots Goals.
 *
 * No provider, model, CLI or Codex process runs here. The "native thread" is a
 * deterministic fake that applies a worst-case provider-side compaction after
 * every step: it keeps only the most recent user messages verbatim and drops
 * everything older without a summary. Space does not compact anything itself;
 * it restates the Goal in each step message. The proof checks that the
 * objective, every "Done when" criterion and every recorded guidance decision
 * remain in the context the model still holds, and that the step budget stops
 * the session. It is not evidence of how any real provider compacts.
 */
const dotId = `dot:${"b".repeat(32)}`;
const owner = "user:1";

class SimulatedCompactingThread {
  private messages: string[] = [];
  constructor(private readonly retainedUserMessages: number) {}
  send(content: string) {
    this.messages.push(content);
    // Simulated native compaction: older turns are gone entirely.
    this.messages = this.messages.slice(-this.retainedUserMessages);
  }
  context() { return this.messages.join("\n\n"); }
}

function longSessionHarness(thread: SimulatedCompactingThread) {
  const goals = new Map<string, DotGoal>();
  const runs = new Map<string, string>();
  const at = () => new Date().toISOString();
  const session = { sessionId: "agent_session:long", paneId: "pane:long", roomId: "room:long", dotId, isActive: true,
    selectedProviderId: null, permissionMode: null };
  let latestRun: { runId: string; status: string; sessionId: string } | null = null;
  const repo = {
    create: vi.fn(async (input: { dotId: string; ownerUserId: string; roomId: string; sessionId: string; objective: string; milestones: string[]; criteria: string[]; budget: DotGoal["budget"] }) => {
      const goal: DotGoal = { goalId: "dot_goal:longsession1", dotId: input.dotId, ownerUserId: input.ownerUserId, roomId: input.roomId,
        sessionId: input.sessionId, objective: input.objective, milestones: input.milestones.map((title, i) => ({ id: `m${i + 1}`, title, status: "PENDING", note: null })),
        criteria: input.criteria, budget: input.budget, usage: { steps: 0, lastRunId: null, lastStepAt: null, consecutiveFailures: 0 },
        status: "ACTIVE", statusReason: null, steering: [], evidence: null, workflowId: "dot-goal:dot_goal:longsession1",
        createdAt: at(), updatedAt: at(), completedAt: null };
      goals.set(goal.goalId, goal); return goal;
    }),
    get: vi.fn(async (id: string) => goals.get(id) ?? null),
    getOwned: vi.fn(async (o: string, d: string, id: string) => o === owner && d === dotId ? goals.get(id) ?? null : null),
    openForSession: vi.fn(async (sessionId: string) => [...goals.values()].find((goal) => goal.sessionId === sessionId && ["ACTIVE", "PAUSED", "BLOCKED"].includes(goal.status)) ?? null),
    transition: vi.fn(async (id: string, from: string[], to: DotGoal["status"], reason: string | null) => {
      const goal = goals.get(id); if (!goal || !from.includes(goal.status)) return null;
      const next = { ...goal, status: to, statusReason: reason }; goals.set(id, next); return next;
    }),
    recordStep: vi.fn(async (id: string, runId: string, failed: boolean) => {
      const goal = goals.get(id)!; if (goal.usage.lastRunId === runId) return goal;
      const next = { ...goal, usage: { ...goal.usage, steps: goal.usage.steps + 1, lastRunId: runId, lastStepAt: at(), consecutiveFailures: failed ? goal.usage.consecutiveFailures + 1 : 0 } };
      goals.set(id, next); return next;
    }),
    addSteering: vi.fn(async (id: string, text: string) => {
      const goal = goals.get(id)!;
      const next = { ...goal, steering: [...goal.steering, { id: `s${goal.steering.length}`, text, createdAt: at(), deliveredAt: null }] }; goals.set(id, next); return next;
    }),
    markSteeringDelivered: vi.fn(async (id: string, ids: string[]) => {
      const goal = goals.get(id)!; goals.set(id, { ...goal, steering: goal.steering.map((entry) => ids.includes(entry.id) ? { ...entry, deliveredAt: at() } : entry) });
    }),
    updateMilestone: vi.fn(async (id: string, milestoneId: string, status: "IN_PROGRESS" | "DONE") => {
      const goal = goals.get(id)!; const next = { ...goal, milestones: goal.milestones.map((m) => m.id === milestoneId ? { ...m, status } : m) }; goals.set(id, next); return next;
    }),
    complete: vi.fn(async (id: string, evidence: DotGoal["evidence"]) => { const goal = goals.get(id)!; const next = { ...goal, status: "COMPLETED" as const, evidence }; goals.set(id, next); return next; }),
    list: vi.fn(), listOpen: vi.fn(), dispose: vi.fn()
  };
  const deps: DotGoalServiceDeps = {
    store: { getSpaceAgentSession: vi.fn(async () => session), getRoom: vi.fn(async () => ({ id: session.roomId, ownerUserId: owner })),
      getLatestSpaceAgentRun: vi.fn(async () => latestRun) } as never,
    dots: { get: vi.fn(async (o: string, id: string) => o === owner && id === dotId ? { dotId } : null),
      getRunSummary: vi.fn(async (runId: string) => runs.has(runId) ? { runId, sessionId: session.sessionId, status: runs.get(runId), clientRequestId: `goal-${runId}` } : null),
      hasPendingApproval: vi.fn(async () => false) } as never,
    goals: repo as never,
    workflow: { start: vi.fn(async () => undefined), wake: vi.fn(async () => undefined) },
    sendStep: vi.fn(async ({ content }: { content: string }) => {
      thread.send(content);
      const runId = `run:step-${runs.size + 1}`;
      runs.set(runId, "QUEUED");
      latestRun = { runId, status: "QUEUED", sessionId: session.sessionId };
      return { runId };
    }),
    interrupt: vi.fn(async () => undefined),
    submission: vi.fn(async () => null),
    atCapacity: vi.fn(async () => false),
    supportsGoalTools: () => true,
    audit: vi.fn(async () => undefined)
  };
  const service = createDotGoalService(deps);
  /** One workflow iteration: start a step, let the simulated model finish it, record it. */
  async function runStep(goalId: string) {
    const started = await service.step(goalId);
    if (started.state !== "STARTED") return started;
    runs.set(started.runId, "COMPLETED");
    latestRun = { runId: started.runId, status: "COMPLETED", sessionId: session.sessionId };
    await service.observe(goalId, started.runId);
    return started;
  }
  return { service, goals, deps, runStep };
}

describe("SIMULATED long Goal session through provider-side compaction", () => {
  it("keeps the objective, every criterion and every guidance decision in the retained context, then stops at the step budget", async () => {
    const thread = new SimulatedCompactingThread(2);
    const h = longSessionHarness(thread);
    const objective = "Migrate the reporting service to the new event schema.";
    const criteria = ["All reporting tests pass against the staging copy", "The migration runbook lists every rollback command"];
    const goal = await h.service.create(owner, dotId, { sessionId: "agent_session:long", objective,
      milestones: ["Map old events", "Write the migration", "Dry-run on staging"], criteria, budget: { maxSteps: 12 } }, null);
    const decisions: string[] = [];
    for (let step = 1; step <= 12; step++) {
      if (step === 3) decisions.push("Decision: use the staging copy of the database; never touch production.");
      if (step === 7) decisions.push("Decision: keep the old event table read-only until the dry run passes.");
      if (step === 3 || step === 7) await h.service.steer(owner, dotId, goal.goalId, { text: decisions.at(-1) }, null);
      expect(await h.runStep(goal.goalId)).toMatchObject({ state: "STARTED" });
      // After simulated compaction the model holds only the last two step messages.
      const retained = thread.context();
      expect(retained).toContain(`Objective: ${objective}`);
      for (const criterion of criteria) expect(retained).toContain(`- ${criterion}`);
      for (const decision of decisions) expect(retained, `step ${step} lost "${decision}"`).toContain(decision);
      expect(retained).toContain(`Goal step ${step} of at most 12.`);
    }
    expect(h.goals.get(goal.goalId)!.usage.steps).toBe(12);
    // The runaway session is cut at its budget, not continued.
    expect(await h.service.step(goal.goalId)).toMatchObject({ state: "DONE", goal: { status: "BUDGET_EXHAUSTED",
      statusReason: "The Goal used its step or time budget." } });
    expect(h.deps.sendStep).toHaveBeenCalledTimes(12);
    // Completion stays evidence-gated: a missing criterion is refused, never recorded as success.
    const reopened = { ...h.goals.get(goal.goalId)!, status: "ACTIVE" as const };
    h.goals.set(goal.goalId, reopened);
    expect(await h.service.tool("agent_session:long", "goal.complete", { evidence: [{ criterion: criteria[0], evidence: "npm test: 48 passed" }] }))
      .toMatchObject({ status: "BLOCKED", statusReason: `Provide evidence for: ${criteria[1]}` });
    expect(h.goals.get(goal.goalId)!.status).toBe("ACTIVE");
  });

  it("never cuts a criterion or the instruction from a maximal Goal and keeps unsent guidance pending", () => {
    const at = new Date().toISOString();
    const goal = {
      objective: `Objective start. ${"o".repeat(3970)} OBJECTIVE-END`,
      milestones: Array.from({ length: 20 }, (_, i) => ({ id: `m${i + 1}`, title: `Milestone ${i + 1} ${"t".repeat(280)}`, status: "PENDING" as const, note: null })),
      criteria: Array.from({ length: 10 }, (_, i) => `Criterion ${i + 1}: ${"c".repeat(480)} END-${i + 1}`),
      budget: { maxSteps: 200, maxMinutes: 1440 },
      usage: { steps: 4, lastRunId: null, lastStepAt: null, consecutiveFailures: 0 },
      steering: [
        { id: "s0", text: `Earlier decision ${"e".repeat(3000)}`, createdAt: at, deliveredAt: at },
        { id: "s1", text: `New decision ${"n".repeat(3000)}`, createdAt: at, deliveredAt: null }
      ]
    };
    const message = dotGoalStepMessage(goal, 5);
    expect(message.prompt.length).toBeLessThanOrEqual(DOT_GOAL_STEP_PROMPT_MAX_CHARS);
    for (const criterion of goal.criteria) expect(message.prompt).toContain(`- ${criterion}`);
    expect(message.prompt).toContain("Goal step 5 of at most 200.");
    expect(message.prompt).toContain("Objective: Objective start.");
    expect(message.prompt.endsWith("Do not repeat actions that already completed.")).toBe(true);
    expect(message.prompt).toContain("Read the complete Goal and all guidance with goal.status before acting.");
    // The new note did not fit: it is named, not silently dropped, and stays undelivered.
    expect(message.deliveredSteeringIds).toEqual([]);
    expect(message.prompt).toContain("1 new guidance note(s)");
  });

  it("restates a small Goal in full, including earlier guidance, without any omission notice", () => {
    const at = new Date().toISOString();
    const message = dotGoalStepMessage({ objective: "Ship the report", criteria: ["Report published"], budget: { maxSteps: 5, maxMinutes: 60 },
      milestones: [{ id: "m1", title: "Draft", status: "DONE", note: null }, { id: "m2", title: "Review", status: "IN_PROGRESS", note: null }],
      usage: { steps: 2, lastRunId: null, lastStepAt: null, consecutiveFailures: 0 },
      steering: [{ id: "s0", text: "Use the June figures.", createdAt: at, deliveredAt: at }, { id: "s1", text: "Add a summary table.", createdAt: at, deliveredAt: null }] }, 3);
    expect(message.prompt).toBe([
      "Goal step 3 of at most 5.", "Objective: Ship the report", "Milestones:\n- [x] m1: Draft\n- [~] m2: Review", "Done when:\n- Report published",
      "New guidance from me:\n- Add a summary table.", "Earlier guidance from me (still applies):\n- Use the June figures.",
      "Make concrete progress on the next unfinished milestone in this step. Record progress with goal.update, call goal.complete with evidence for every criterion only when all are met, or goal.block with a question if you need me. Do not repeat actions that already completed."
    ].join("\n\n"));
    expect(message.deliveredSteeringIds).toEqual(["s1"]);
  });
});
