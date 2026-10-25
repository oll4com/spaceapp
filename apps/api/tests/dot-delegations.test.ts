import { describe, expect, it, vi } from "vitest";
import type { DotGoal, DotProfile } from "@space/contracts";
import type { DotDelegationRecord, DotDelegationsRepository } from "@space/db";
import { createDotDelegationService, findDelegate } from "../src/dot-delegations.js";

const dots = ["Orbit", "Nova", "Byte"].map((name, index) => ({ dotId: `dot:${String(index + 1).repeat(32)}`, name, slot: index + 1 }) as DotProfile);
const at = "2026-10-11T08:00:00.000Z";
const parentGoal = (steps: number, maxSteps = 20) => ({ goalId: "dot_goal:parent01", budget: { maxSteps, maxMinutes: 600 }, usage: { steps },
  createdAt: new Date().toISOString() }) as unknown as DotGoal;
function fixture(options: { parent?: DotGoal | null; createGoalFails?: boolean; reportFails?: boolean; delegatorActive?: boolean } = {}) {
  const records: Array<DotDelegationRecord & { goalStatus?: string; goalStatusReason?: string | null; evidence?: unknown }> = [];
  const delegations: DotDelegationsRepository = {
    create: vi.fn(async (input) => { const record = { ...input, delegationId: `dot_delegation:${"a".repeat(32)}`, reportedStatus: null, createdAt: at };
      records.push(record); return record; }),
    unreported: vi.fn(async () => records.filter((record) => record.goalStatus && record.reportedStatus !== record.goalStatus)
      .map((record) => ({ ...record, goalStatus: record.goalStatus!, goalStatusReason: record.goalStatusReason ?? null, evidence: record.evidence ?? null }))),
    markReported: vi.fn(async (id, status) => { const record = records.find((item) => item.delegationId === id)!; if (record.reportedStatus === status) return false;
      record.reportedStatus = status; return true; }),
    list: vi.fn(async () => []),
    dispose: vi.fn(async () => undefined)
  };
  const deps = {
    store: { getSpaceAgentSession: vi.fn(async (sessionId: string) => ({ sessionId, paneId: "pane:orbit", isActive: options.delegatorActive ?? true })) } as never,
    dots: { list: vi.fn(async () => dots) },
    goals: { openForSession: vi.fn(async () => options.parent ?? null) },
    delegations,
    openPane: vi.fn(async (input: { title: string }) => ({ id: "pane:nova", title: input.title }) as never),
    startSession: vi.fn(async () => ({ sessionId: "agent_session:nova" })),
    createGoal: vi.fn(async (_owner: string, dotId: string, input: { budget: { maxSteps: number } }) => {
      if (options.createGoalFails) throw new Error("Goals need a Codex model");
      return { goalId: "dot_goal:child001", dotId, budget: input.budget } as unknown as DotGoal;
    }),
    closePane: vi.fn(async () => undefined),
    report: vi.fn(async () => { if (options.reportFails) throw new Error("busy"); })
  };
  return { service: createDotDelegationService(deps), deps, records };
}
const session = { sessionId: "agent_session:orbit", dotId: dots[0]!.dotId, roomId: "room:1" };

describe("Dot delegation", () => {
  it("finds another of the user's Dots by name or slot, never itself", () => {
    expect(findDelegate(dots, "nova", dots[0]!.dotId)?.name).toBe("Nova");
    expect(findDelegate(dots, "3", dots[0]!.dotId)?.name).toBe("Byte");
    expect(findDelegate(dots, "Orbit", dots[0]!.dotId)).toBeNull();
    expect(findDelegate(dots, "Luna", dots[0]!.dotId)).toBeNull();
  });

  it("gives the delegate its own pane, only the task and context, and a Goal within the remaining budget", async () => {
    const { service, deps, records } = fixture({ parent: parentGoal(15) });
    const result = await service.delegate(session, "user:1", { to: "Nova", task: "Compare three supplier quotes", context: "Budget is 2,000 EUR",
      doneWhen: ["A table with prices"], maxSteps: 12 });
    expect(result).toMatchObject({ status: "COMPLETED", result: { to: "Nova", paneId: "pane:nova", goalId: "dot_goal:child001", maxSteps: 4 } });
    expect(deps.openPane).toHaveBeenCalledWith({ owner: "user:1", roomId: "room:1", title: "Nova · for Orbit" });
    const [, dotId, goalInput] = deps.createGoal.mock.calls[0]!;
    expect(dotId).toBe(dots[1]!.dotId);
    expect(goalInput).toMatchObject({ sessionId: "agent_session:nova", criteria: ["A table with prices"], budget: { maxSteps: 4 } });
    expect((goalInput as { objective: string }).objective).toMatch(/^Task from Orbit: Compare three supplier quotes\n\nContext from Orbit: Budget is 2,000 EUR/);
    expect(records[0]).toMatchObject({ fromDotId: dots[0]!.dotId, toDotId: dots[1]!.dotId, goalId: "dot_goal:child001", task: "Compare three supplier quotes" });
  });

  it("refuses unknown or self targets, an exhausted budget, and cleans up when the Goal cannot start", async () => {
    expect(await fixture().service.delegate(session, "user:1", { to: "Orbit", task: "x" })).toMatchObject({ status: "BLOCKED" });
    expect(await fixture().service.delegate(session, "user:1", { task: "x" })).toMatchObject({ status: "BLOCKED" });
    expect(await fixture({ parent: parentGoal(19) }).service.delegate(session, "user:1", { to: "Nova", task: "x" }))
      .toMatchObject({ status: "BLOCKED", statusReason: expect.stringMatching(/no steps left/) });
    const failing = fixture({ createGoalFails: true });
    expect(await failing.service.delegate(session, "user:1", { to: "Nova", task: "x" })).toMatchObject({ status: "BLOCKED", statusReason: expect.stringMatching(/could not start/) });
    expect(failing.deps.closePane).toHaveBeenCalledWith("pane:nova");
    expect(failing.records).toHaveLength(0);
  });

  it("reports each outcome once to the delegating conversation and retries while it is busy", async () => {
    const busy = fixture({ reportFails: true });
    await busy.service.delegate(session, "user:1", { to: "Nova", task: "Compare quotes" });
    busy.records[0]!.goalStatus = "COMPLETED";
    busy.records[0]!.evidence = [{ criterion: "Table", evidence: "Sheet link" }];
    expect(await busy.service.reportOutcomes()).toBe(0);
    expect(busy.records[0]!.reportedStatus).toBeNull();

    const ok = fixture();
    await ok.service.delegate(session, "user:1", { to: "Nova", task: "Compare quotes" });
    ok.records[0]!.goalStatus = "BLOCKED";
    ok.records[0]!.goalStatusReason = "Which currency?";
    expect(await ok.service.reportOutcomes()).toBe(1);
    expect(ok.deps.report).toHaveBeenLastCalledWith(expect.objectContaining({ sessionId: "agent_session:orbit", paneId: "pane:orbit",
      content: expect.stringMatching(/^Nova reports on the task you delegated \(“Compare quotes”\): needs the user: Which currency\?/),
      requestKey: expect.stringMatching(/^delegation-[a-f0-9]{40}$/) }));
    expect(await ok.service.reportOutcomes()).toBe(0);
    ok.records[0]!.goalStatus = "COMPLETED";
    ok.records[0]!.evidence = [{ criterion: "Table", evidence: "Sheet link" }];
    expect(await ok.service.reportOutcomes()).toBe(1);
    expect(ok.deps.report).toHaveBeenLastCalledWith(expect.objectContaining({ content: expect.stringMatching(/finished it\.\nEvidence:\n- Table: Sheet link/) }));

    const gone = fixture({ delegatorActive: false });
    await gone.service.delegate(session, "user:1", { to: "Nova", task: "x" });
    gone.records[0]!.goalStatus = "FAILED";
    await gone.service.reportOutcomes();
    expect(gone.deps.report).not.toHaveBeenCalled();
    expect(gone.records[0]!.reportedStatus).toBe("FAILED");
  });
});
