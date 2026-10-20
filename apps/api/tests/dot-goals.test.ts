import { describe, expect, it, vi } from "vitest";
import { dotGoalStepPrompt, type DotGoal } from "@space/contracts";
import { SpaceConflictError } from "@space/runtime";
import { createDotGoalService, DotGoalError, type DotGoalServiceDeps } from "../src/dot-goals.js";

const dotId = `dot:${"a".repeat(32)}`;
const now = new Date().toISOString();
function fixture(overrides: { runStatus?: string; pendingApproval?: boolean; sendError?: Error; atCapacity?: boolean;
  submissions?: Record<string, { runId: string; status: string }>; provider?: string | null; permissionMode?: string | null } = {}) {
  const goals = new Map<string, DotGoal>();
  const session = { sessionId: "agent_session:1", paneId: "pane:1", roomId: "room:1", dotId, isActive: true,
    selectedProviderId: overrides.provider ?? null, permissionMode: overrides.permissionMode ?? null };
  let run = overrides.runStatus ? { runId: "run:active", status: overrides.runStatus, sessionId: "agent_session:1" } : null;
  const repo = {
    create: vi.fn(async (input: { dotId: string; ownerUserId: string; roomId: string; sessionId: string; objective: string; milestones: string[]; criteria: string[]; budget: DotGoal["budget"] }) => {
      if ([...goals.values()].some((goal) => goal.sessionId === input.sessionId && ["ACTIVE", "PAUSED", "BLOCKED"].includes(goal.status))) {
        throw Object.assign(new Error("open"), { code: "DOT_GOAL_OPEN" });
      }
      const goal: DotGoal = { goalId: "dot_goal:abcdefgh1", dotId: input.dotId, ownerUserId: input.ownerUserId, roomId: input.roomId, sessionId: input.sessionId,
        objective: input.objective, milestones: input.milestones.map((title, i) => ({ id: `m${i + 1}`, title, status: "PENDING", note: null })),
        criteria: input.criteria, budget: input.budget, usage: { steps: 0, lastRunId: null, lastStepAt: null, consecutiveFailures: 0 },
        status: "ACTIVE", statusReason: null, steering: [], evidence: null, workflowId: "dot-goal:dot_goal:abcdefgh1", createdAt: now, updatedAt: now, completedAt: null };
      goals.set(goal.goalId, goal); return goal;
    }),
    get: vi.fn(async (id: string) => goals.get(id) ?? null),
    getOwned: vi.fn(async (owner: string, dot: string, id: string) => owner === "user:1" && dot === dotId ? goals.get(id) ?? null : null),
    openForSession: vi.fn(async (sessionId: string) => [...goals.values()].find((goal) => goal.sessionId === sessionId && ["ACTIVE", "PAUSED", "BLOCKED"].includes(goal.status)) ?? null),
    transition: vi.fn(async (id: string, from: string[], to: DotGoal["status"], reason: string | null) => {
      const goal = goals.get(id); if (!goal || !from.includes(goal.status)) return null;
      const next = { ...goal, status: to, statusReason: reason }; goals.set(id, next); return next;
    }),
    recordStep: vi.fn(async (id: string, runId: string, failed: boolean) => {
      const goal = goals.get(id)!; if (goal.usage.lastRunId === runId) return goal;
      const next = { ...goal, usage: { ...goal.usage, steps: goal.usage.steps + 1, lastRunId: runId, consecutiveFailures: failed ? goal.usage.consecutiveFailures + 1 : 0 } };
      goals.set(id, next); return next;
    }),
    addSteering: vi.fn(async (id: string, text: string) => {
      const goal = goals.get(id)!; if (!["ACTIVE", "PAUSED", "BLOCKED"].includes(goal.status)) return null;
      const next = { ...goal, steering: [...goal.steering, { id: `s${goal.steering.length}`, text, createdAt: now, deliveredAt: null }] }; goals.set(id, next); return next;
    }),
    markSteeringDelivered: vi.fn(async (id: string, ids: string[]) => {
      const goal = goals.get(id)!; goals.set(id, { ...goal, steering: goal.steering.map((entry) => ids.includes(entry.id) ? { ...entry, deliveredAt: now } : entry) });
    }),
    updateMilestone: vi.fn(async (id: string, milestoneId: string, status: "IN_PROGRESS" | "DONE") => {
      const goal = goals.get(id)!; if (!goal.milestones.some((m) => m.id === milestoneId)) return null;
      const next = { ...goal, milestones: goal.milestones.map((m) => m.id === milestoneId ? { ...m, status } : m) }; goals.set(id, next); return next;
    }),
    complete: vi.fn(async (id: string, evidence: DotGoal["evidence"]) => { const goal = goals.get(id)!; const next = { ...goal, status: "COMPLETED" as const, evidence }; goals.set(id, next); return next; }),
    list: vi.fn(), listOpen: vi.fn(), dispose: vi.fn()
  };
  const deps: DotGoalServiceDeps = {
    store: { getSpaceAgentSession: vi.fn(async () => session), getRoom: vi.fn(async () => ({ id: "room:1", ownerUserId: "user:1" })),
      getLatestSpaceAgentRun: vi.fn(async () => run) } as never,
    dots: { get: vi.fn(async (owner: string, id: string) => owner === "user:1" && id === dotId ? { dotId } : null),
      getRunSummary: vi.fn(async (runId: string) => run && run.runId === runId ? { runId, sessionId: run.sessionId, status: run.status,
        clientRequestId: runId === "run:step" ? "goal-abc" : "user-request" } : null),
      hasPendingApproval: vi.fn(async () => overrides.pendingApproval ?? false) } as never,
    goals: repo as never,
    workflow: { start: vi.fn(async () => undefined), wake: vi.fn(async () => undefined) },
    sendStep: vi.fn(async () => { if (overrides.sendError) throw overrides.sendError; run = { runId: "run:step", status: "QUEUED", sessionId: "agent_session:1" }; return { runId: "run:step" }; }),
    interrupt: vi.fn(async () => undefined),
    submission: vi.fn(async (_pane: string, key: string) => overrides.submissions?.[key] ?? null),
    atCapacity: vi.fn(async () => overrides.atCapacity ?? false),
    supportsGoalTools: (value) => (!value.selectedProviderId || value.selectedProviderId === "codex") && value.permissionMode !== "ask_for_approval",
    audit: vi.fn(async () => undefined)
  };
  return { service: createDotGoalService(deps), deps, goals, setRun: (status: string) => { run = { runId: "run:step", status, sessionId: "agent_session:1" }; } };
}
const input = { sessionId: "agent_session:1", objective: "Ship the report", milestones: ["Draft", "Review"], criteria: ["Report published"], budget: { maxSteps: 2 } };

describe("Dot Goals", () => {
  it("creates one open Goal per conversation for the owner's Dot and starts its workflow", async () => {
    const { service, deps } = fixture();
    const goal = await service.create("user:1", dotId, input, null);
    expect(goal).toMatchObject({ status: "ACTIVE", budget: { maxSteps: 2, maxMinutes: 180 }, milestones: [{ id: "m1", title: "Draft" }, { id: "m2" }] });
    expect(deps.workflow!.start).toHaveBeenCalledWith(goal.goalId, undefined);
    await expect(service.create("user:1", dotId, input, null)).rejects.toMatchObject({ status: 409, code: "DOT_GOAL_OPEN" });
    await expect(service.create("user:2", dotId, input, null)).rejects.toBeInstanceOf(DotGoalError);
  });

  it("starts each step once with an idempotent key, delivers guidance, and waits while a run is active", async () => {
    const { service, deps, setRun } = fixture();
    const goal = await service.create("user:1", dotId, input, null);
    await service.steer("user:1", dotId, goal.goalId, { text: "Use the Q3 numbers" }, null);
    const first = await service.step(goal.goalId);
    expect(first).toMatchObject({ state: "STARTED", runId: "run:step" });
    const [call] = vi.mocked(deps.sendStep).mock.calls[0]!;
    expect(call.content).toContain("Goal step 1 of at most 2.");
    expect(call.content).toContain("Use the Q3 numbers");
    expect(call.requestKey).toMatch(/^goal-[a-f0-9]{40}$/);
    expect(first.goal.steering[0]!.deliveredAt).not.toBeNull();
    expect(await service.step(goal.goalId)).toMatchObject({ state: "BUSY", runId: "run:step" });
    setRun("COMPLETED");
    expect((await service.observe(goal.goalId, "run:step")).goal.usage.steps).toBe(1);
    expect((await service.observe(goal.goalId, "run:step")).goal.usage.steps).toBe(1);
    expect(vi.mocked(deps.sendStep).mock.calls[0]![0].requestKey).not.toBe((await service.step(goal.goalId), vi.mocked(deps.sendStep).mock.calls[1]![0].requestKey));
  });

  it("never counts the user's own turns as Goal steps and recovers a replayed step by run id", async () => {
    const { service, deps } = fixture({ runStatus: "COMPLETED" });
    const goal = await service.create("user:1", dotId, input, null);
    expect((await service.observe(goal.goalId, "run:active")).goal.usage.steps).toBe(0);
    expect((await service.observe(goal.goalId, "run:unknown")).run).toBe("MISSING");
    await service.step(goal.goalId);
    vi.mocked(deps.store.getLatestSpaceAgentRun).mockResolvedValueOnce({ runId: "run:other", status: "COMPLETED", sessionId: "agent_session:1" } as never);
    expect((await service.observe(goal.goalId, "run:step")).run).toBe("QUEUED");
  });

  it("stops at the budget, after three failures, or when the conversation closes", async () => {
    const budget = fixture();
    const goal = await budget.service.create("user:1", dotId, { ...input, budget: { maxSteps: 1 } }, null);
    await budget.service.step(goal.goalId); budget.setRun("COMPLETED"); await budget.service.observe(goal.goalId, "run:step");
    expect(await budget.service.step(goal.goalId)).toMatchObject({ state: "DONE", goal: { status: "BUDGET_EXHAUSTED" } });
    const failing = fixture();
    const unstable = await failing.service.create("user:1", dotId, input, null);
    failing.goals.set(unstable.goalId, { ...unstable, usage: { ...unstable.usage, consecutiveFailures: 3 } });
    expect(await failing.service.step(unstable.goalId)).toMatchObject({ state: "DONE", goal: { status: "FAILED" } });
  });

  it("waits instead of sending while an approval is pending or the Dot is at its task limit", async () => {
    const pending = fixture({ pendingApproval: true });
    const goal = await pending.service.create("user:1", dotId, input, null);
    expect(await pending.service.step(goal.goalId)).toMatchObject({ state: "WAITING" });
    expect(pending.deps.sendStep).not.toHaveBeenCalled();
    const busy = fixture({ atCapacity: true });
    const limited = await busy.service.create("user:1", dotId, input, null);
    expect(await busy.service.step(limited.goalId)).toMatchObject({ state: "WAITING" });
    expect(busy.deps.sendStep).not.toHaveBeenCalled();
    const conflicted = fixture({ sendError: new SpaceConflictError("The selected Dot session changed. Reconnect before sending.") });
    const changed = await conflicted.service.create("user:1", dotId, input, null);
    expect(await conflicted.service.step(changed.goalId)).toMatchObject({ state: "WAITING" });
  });

  it("reconciles a step submitted before a crash instead of rebuilding and resending it", async () => {
    const { createHash } = await import("node:crypto");
    const key = (step: number) => `goal-${createHash("sha256").update(`dot_goal:abcdefgh1:${step}`).digest("hex").slice(0, 40)}`;
    const done = fixture({ submissions: { [key(1)]: { runId: "run:old", status: "COMPLETED" } } });
    const goal = await done.service.create("user:1", dotId, input, null);
    const stepped = await done.service.step(goal.goalId);
    expect(stepped.goal.usage).toMatchObject({ steps: 1, lastRunId: "run:old" });
    expect(vi.mocked(done.deps.sendStep).mock.calls[0]![0]).toMatchObject({ requestKey: key(2) });
    const running = fixture({ submissions: { [key(1)]: { runId: "run:inflight", status: "RUNNING" } } });
    const inflight = await running.service.create("user:1", dotId, input, null);
    expect(await running.service.step(inflight.goalId)).toMatchObject({ state: "BUSY", runId: "run:inflight" });
    expect(running.deps.sendStep).not.toHaveBeenCalled();
  });

  it("refuses Goals the Dot could never report on", async () => {
    await expect(fixture({ provider: "opencode" }).service.create("user:1", dotId, input, null)).rejects.toMatchObject({ code: "DOT_GOAL_PROVIDER" });
    await expect(fixture({ permissionMode: "ask_for_approval" }).service.create("user:1", dotId, input, null)).rejects.toMatchObject({ code: "DOT_GOAL_PROVIDER" });
  });

  it("resumes a blocked Goal after the user answers", async () => {
    const { service } = fixture();
    const goal = await service.create("user:1", dotId, input, null);
    await service.tool("agent_session:1", "goal.block", { reason: "Which currency?" });
    expect(await service.step(goal.goalId)).toMatchObject({ state: "PAUSED", goal: { status: "BLOCKED" } });
    await service.steer("user:1", dotId, goal.goalId, { text: "Use EUR" }, null);
    expect((await service.control("user:1", dotId, goal.goalId, { action: "RESUME" }, null)).status).toBe("ACTIVE");
  });

  it("pauses, resumes and cancels with the current run interrupted", async () => {
    const { service, deps } = fixture({ runStatus: "RUNNING" });
    const goal = await service.create("user:1", dotId, input, null);
    expect((await service.control("user:1", dotId, goal.goalId, { action: "PAUSE" }, null)).status).toBe("PAUSED");
    expect(await service.step(goal.goalId)).toMatchObject({ state: "PAUSED" });
    await expect(service.control("user:1", dotId, goal.goalId, { action: "PAUSE" }, null)).rejects.toMatchObject({ status: 409 });
    expect((await service.control("user:1", dotId, goal.goalId, { action: "RESUME" }, null)).status).toBe("ACTIVE");
    expect((await service.control("user:1", dotId, goal.goalId, { action: "CANCEL" }, null)).status).toBe("CANCELLED");
    expect(deps.interrupt).toHaveBeenCalledWith("pane:1", "Goal cancelled by the user.");
    expect(deps.workflow!.wake).toHaveBeenCalledTimes(3);
    await expect(service.control("user:2", dotId, goal.goalId, { action: "CANCEL" }, null)).rejects.toMatchObject({ status: 404 });
  });

  it("lets the Dot record progress and complete only with evidence for every criterion and finished milestones", async () => {
    const { service } = fixture();
    const goal = await service.create("user:1", dotId, input, null);
    expect((await service.tool("agent_session:1", "goal.status", {})).result).toMatchObject({ objective: "Ship the report", remaining: { stepsLeft: 2 } });
    expect(await service.tool("agent_session:1", "goal.complete", { evidence: [{ criterion: "Report published", evidence: "https://example" }] }))
      .toMatchObject({ status: "BLOCKED", statusReason: expect.stringMatching(/m1, m2/) });
    await service.tool("agent_session:1", "goal.update", { milestoneId: "m1", status: "DONE" });
    await service.tool("agent_session:1", "goal.update", { milestoneId: "m2", status: "DONE" });
    expect(await service.tool("agent_session:1", "goal.complete", { evidence: [{ criterion: "Something else", evidence: "x" }] }))
      .toMatchObject({ status: "BLOCKED", statusReason: expect.stringMatching(/Report published/) });
    expect(await service.tool("agent_session:1", "goal.complete", { evidence: [{ criterion: "report published", evidence: "Published at /docs/q3.pdf" }] }))
      .toMatchObject({ status: "COMPLETED" });
    expect(await service.tool("agent_session:1", "goal.status", {})).toMatchObject({ status: "BLOCKED", statusReason: "This conversation has no open Goal." });
    void goal;
  });
});

it("writes a bounded, visible step prompt", () => {
  const prompt = dotGoalStepPrompt({ objective: "x".repeat(4000), milestones: [], criteria: [], budget: { maxSteps: 5, maxMinutes: 60 },
    usage: { steps: 0, lastRunId: null, lastStepAt: null, consecutiveFailures: 0 }, steering: [] }, 1);
  expect(prompt.length).toBeLessThanOrEqual(7900);
  expect(prompt).toContain("Goal step 1 of at most 5.");
});
