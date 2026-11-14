import { clipboardItemSchema, planIsParked, planParkedSchema, type ClipboardItem, type UpdatePlanProgressRequest } from "@space/contracts";
import { describe, expect, it } from "vitest";
import { createParkedPlans, derivedPark, parkedSince } from "../src/nous/parked-plans.js";

const NOW = Date.parse("2026-11-13T10:00:00.000Z");
const step = (order: number, status: "PENDING" | "COMPLETED") => ({ id: `step-${order}`, order, title: `Step ${order}`, status });
const plan = (id: string, patch: Record<string, unknown> = {}): ClipboardItem => clipboardItemSchema.parse({
  id: `clipboard:${id}`, text: id, title: id, source: "PLAN", minimumModel: "m", occurrenceCount: 1, characterCount: id.length,
  createdAt: "2026-11-01T00:00:00.000Z", lastUsedAt: "2026-11-01T00:00:00.000Z", lastProgressAt: "2026-11-02T00:00:00.000Z", ...patch
});
const park = (conditions: unknown[]) => planParkedSchema.parse({ reason: "Waits", since: "2026-11-05T00:00:00.000Z", conditions });

function harness(plans: ClipboardItem[], extra: { tickets?: Record<string, string>; stable?: string[]; decisions?: Record<string, string> } = {}) {
  const byId = new Map(plans.map((entry) => [entry.id, entry]));
  const updates: Array<[string, UpdatePlanProgressRequest]> = [];
  const notices: Array<[string, string]> = [];
  const checker = createParkedPlans({
    plans: async () => [...byId.values()],
    parked: async () => [...byId.values()].filter(planIsParked),
    get: async (_owner, id) => byId.get(id) ?? null,
    update: async (_owner, id, input) => {
      updates.push([id, input]);
      const next = { ...byId.get(id)!, ...(input.parked !== undefined ? { parked: input.parked } : {}), ...(input.executionStatus ? { executionStatus: input.executionStatus, isCompleted: false } : {}) };
      byId.set(id, next);
      return next;
    },
    ticketStatus: async (id) => extra.tickets?.[id] ?? null,
    onStable: async (id) => Boolean(extra.stable?.includes(id)),
    decision: async (_owner, id) => extra.decisions?.[id] ? { status: extra.decisions[id] as "OPEN" } : null,
    notice: async (_owner, key, line) => { notices.push([key, line]); },
    now: () => NOW
  });
  return { checker, byId, updates, notices };
}

describe("parked plans resume by themselves (operator 13/11 nous_msg:4080b166)", () => {
  it("marks met machine checks, leaves MANUAL ones, and reopens a closed plan with a resume step once every condition is met", async () => {
    const closed = plan("closed01", { isCompleted: true, executionStatus: "COMPLETED", progressPercentage: 100, steps: [step(1, "COMPLETED")], parked: park([
      { who: "DATE", what: "After the 12th", check: { kind: "DATE", at: "2026-11-12T00:00:00.000Z" } },
      { who: "PLAN", what: "The base plan closes", check: { kind: "PLAN", planId: "clipboard:base0001" } },
      { who: "PROMOTE", what: "Fix on stable", check: { kind: "TICKET", ticket: "q-20261113-010203-abcd", on: "stable" } },
      { who: "OPERATOR", what: "Answers", check: { kind: "DECISION", id: "nous_decision:abc12345" } }]) });
    const waiting = plan("waiting1", { parked: park([
      { who: "DATE", what: "Next year", check: { kind: "DATE", at: "2027-01-01T00:00:00.000Z" } },
      { who: "NOUS", what: "Check the vendor" },
      { who: "AGENT", what: "Deployed to dev", check: { kind: "TICKET", ticket: "q-20261113-010203-ffff", on: "dev" } }]) });
    const base = plan("base0001", { isCompleted: true, executionStatus: "COMPLETED", progressPercentage: 100 });
    const { checker, byId, updates, notices } = harness([closed, waiting, base], { stable: ["q-20261113-010203-abcd"], tickets: { "q-20261113-010203-ffff": "DEPLOYED" }, decisions: { "nous_decision:abc12345": "ANSWERED" } });
    expect(await checker.check("user:one")).toEqual(["clipboard:closed01"]);
    const [, reopen] = updates.find(([id, input]) => id === "clipboard:closed01" && input.executionStatus)!;
    expect(reopen).toMatchObject({ executionStatus: "IN_PROGRESS", waitsOn: null, parked: { resumedAt: "2026-11-13T10:00:00.000Z" } });
    expect(reopen.steps!.at(-1)).toMatchObject({ title: "Resume: Waits", status: "PENDING" });
    expect(reopen.parked!.conditions.map((entry) => entry.evidence)).toEqual(["2026-11-12T00:00:00.000Z passed", "clipboard:base0001 closed at 100%",
      "q-20261113-010203-abcd is on stable", "nous_decision:abc12345 answered"]);
    expect(notices.find(([key]) => key === "parked-resumed:clipboard:closed01")![1]).toContain("resumed");
    const still = byId.get("clipboard:waiting1")!.parked!;
    expect(still.resumedAt).toBeNull();
    expect(still.conditions.map((entry) => [entry.state, entry.checkedAt])).toEqual([["OPEN", "2026-11-13T10:00:00.000Z"], ["OPEN", null], ["MET", "2026-11-13T10:00:00.000Z"]]);
    // A second pass: the resumed plan is no longer parked; nothing new is written for the waiting one's MANUAL condition.
    expect(await checker.check("user:one")).toEqual([]);
  });

  it("parkedSince: the latest move (park, met condition, progress), or the latest date waited for when every open condition is a DATE", () => {
    const met = { state: "MET", metAt: "2026-11-07T00:00:00.000Z" };
    const of = (conditions: unknown[]) => parkedSince(plan("since001", { parked: park(conditions) }) as Parameters<typeof parkedSince>[0]);
    expect(new Date(of([{ who: "NOUS", what: "x", ...met }, { who: "NOUS", what: "y" }])).toISOString()).toBe("2026-11-07T00:00:00.000Z");
    expect(new Date(of([{ who: "DATE", what: "d", check: { kind: "DATE", at: "2026-11-20T00:00:00.000Z" } }])).toISOString()).toBe("2026-11-20T00:00:00.000Z");
    expect(new Date(of([{ who: "DATE", what: "d", check: { kind: "DATE", at: "2026-11-20T00:00:00.000Z" } }, { who: "NOUS", what: "y" }])).toISOString()).toBe("2026-11-05T00:00:00.000Z");
  });

  it("backfills a park once from the plan's wait and open dependencies, and tells Nous to refine it", async () => {
    const closedWithWork = plan("ro5ukMcJ", { isCompleted: true, executionStatus: "COMPLETED", progressPercentage: 60, steps: [step(1, "COMPLETED"), step(2, "PENDING")] });
    const promote = plan("promote1", { isCompleted: true, executionStatus: "COMPLETED", progressPercentage: 80, steps: [step(1, "PENDING")],
      waitsOn: { kind: "PROMOTE", what: "q-20261113-010203-abcd reaches stable", until: null }, dependsOn: ["clipboard:openbase"] });
    const openWait = plan("openwait", { waitsOn: { kind: "DATE", what: "Monday", until: "2026-11-16T00:00:00.000Z" } });
    const done = plan("donedone", { isCompleted: true, executionStatus: "COMPLETED", progressPercentage: 100, steps: [step(1, "COMPLETED")] });
    const openBase = plan("openbase");
    expect(derivedPark(done, new Set(), "x")).toBeNull();
    expect(derivedPark(openBase, new Set(), "x")).toBeNull();
    const { checker, byId, notices } = harness([closedWithWork, promote, openWait, done, openBase]);
    await checker.check("user:one");
    expect(byId.get("clipboard:ro5ukMcJ")!.parked).toMatchObject({ reason: "Closed at 60% with steps left", since: "2026-11-02T00:00:00.000Z",
      conditions: [{ id: "c1", who: "NOUS", what: 'Decide the open step "Step 2": resume it, or drop the steps left', check: { kind: "MANUAL" } }] });
    expect(byId.get("clipboard:promote1")!.parked!.conditions).toMatchObject([{ who: "PROMOTE", check: { kind: "TICKET", ticket: "q-20261113-010203-abcd", on: "stable" } },
      { id: "c2", who: "PLAN", check: { kind: "PLAN", planId: "clipboard:openbase" } }]);
    expect(byId.get("clipboard:openwait")!.parked!.conditions).toMatchObject([{ who: "DATE", check: { kind: "DATE", at: "2026-11-16T00:00:00.000Z" }, state: "OPEN" }]);
    expect(byId.get("clipboard:donedone")!.parked).toBeNull();
    expect(notices.filter(([key]) => key === "parked-backfill")).toHaveLength(1);
    expect(notices[0]![1]).toContain("3 waiting or closed plans were parked");
    // Once per process.
    await checker.check("user:one");
    expect(notices.filter(([key]) => key === "parked-backfill")).toHaveLength(1);
  });
});
