import { describe, expect, it } from "vitest";
import type { ClipboardItem, Pane } from "@space/contracts";
import { InMemoryNousPlanMarksRepository, type PaneReport } from "@space/db";
import type { DashboardAgentsSample } from "../src/room-routes.js";
import { nousPlanActivity, planFingerprint, renderNousPlanActivity, renderStandingPlansPrompt } from "../src/nous/stalled-plans.js";

// Stalled plans (plan clipboard:8s0ZNiO3q5ZT S4; standing orders 2026-10-21).
const at = (time: string) => `2026-10-17T${time}:00.000Z`;
const plan = (id: string, title: string, percent: number, paneId: string | null, lastProgressAt = at("02:00"), extra: Partial<ClipboardItem> = {}) =>
  ({ id, title, text: title, progressPercentage: percent, paneId, lastProgressAt, createdAt: at("01:00"), executionStatus: "IN_PROGRESS", steps: [], ...extra }) as unknown as ClipboardItem;
const pane = (id: string, paneName: string) => ({ id, paneName, title: paneName }) as unknown as Pane;
const sample = (entries: Array<[Pane, string, string]>): DashboardAgentsSample => ({
  data: entries.map(([entry]) => entry), sampledAt: at("10:00"),
  activity: Object.fromEntries(entries.map(([entry, status]) => [entry.id, status])) as never,
  details: Object.fromEntries(entries.map(([entry, status, since]) => [entry.id, { status, since, source: "native" }])) as never
});
const report = (paneId: string, time: string, summary: string): PaneReport =>
  ({ id: `report:${paneId}`, roomId: "room:main0001", paneId, at: at(time), source: "AUTO", status: "TURN_END", summary, planId: null, step: null, percent: null, ticket: null, next: null, needs: null, body: null });

describe("stalled plans", () => {
  it("knows when each plan last moved (its percentage or a step's status), not when progress was last written", async () => {
    const marks = new InMemoryNousPlanMarksRepository();
    const samples = [{ sample: sample([[pane("pane:andy0001", "Andy"), "idle", at("08:00")]]) }];
    const steps = (status: string) => [{ id: "step-1", order: 1, title: "Build", status, progress: 0, agent: null, notes: null, proof: null, startedAt: null, completedAt: null }] as never;
    const first = await nousPlanActivity({ owner: "user:operator", plans: [plan("clipboard:a", "Alpha", 40, "pane:andy0001", at("02:00"), { steps: steps("PENDING") })], samples, marks, now: new Date(at("09:00")) });
    expect(first[0]).toMatchObject({ changedAt: at("02:00"), hours: 7, stalled: true, reason: "unchanged 7 h", status: "IN_PROGRESS", nextStep: "1. Build (PENDING)" });
    // The same 40% written again later does not move the mark; a step's status does, and so does 55%.
    const same = await nousPlanActivity({ owner: "user:operator", plans: [plan("clipboard:a", "Alpha", 40, "pane:andy0001", at("08:59"), { steps: steps("PENDING") })], samples, marks, now: new Date(at("10:00")) });
    expect(same[0]).toMatchObject({ changedAt: at("02:00"), hours: 8 });
    const step = await nousPlanActivity({ owner: "user:operator", plans: [plan("clipboard:a", "Alpha", 40, "pane:andy0001", at("08:59"), { steps: steps("IN_PROGRESS") })], samples, marks, now: new Date(at("10:15")) });
    expect(step[0]).toMatchObject({ changedAt: at("10:15"), hours: 0, stalled: false, reason: null });
    const moved = await nousPlanActivity({ owner: "user:operator", plans: [plan("clipboard:a", "Alpha", 55, "pane:andy0001", at("10:30"), { steps: steps("IN_PROGRESS") })], samples, marks, now: new Date(at("10:30")) });
    expect(moved[0]).toMatchObject({ changedAt: at("10:30"), hours: 0, stalled: false });
    expect(planFingerprint({ executionStatus: "PAUSED", steps: steps("DONE") } as never)).toBe("PAUSED|1:DONE");
  });

  it("calls a plan stalled when it has not moved for 3 hours whatever its pane does, has no open pane, its pane has waited an hour, or works silently for two", async () => {
    const samples = [{ sample: sample([[pane("pane:andy0001", "Andy"), "idle", at("08:00")], [pane("pane:bob00001", "Bob"), "working", at("09:55")],
      [pane("pane:cody0001", "Cody"), "waiting", at("09:00")], [pane("pane:dave0001", "Dave"), "working", at("07:00")], [pane("pane:erin0001", "Erin"), "working", at("07:00")]]) }];
    const items = await nousPlanActivity({ owner: "user:operator", now: new Date(at("10:00")), marks: new InMemoryNousPlanMarksRepository(), samples,
      reports: [report("pane:erin0001", "09:30", "Still building the export."), report("pane:andy0001", "08:00", "Done with step 2.")],
      executions: [{ planId: "clipboard:a", paneId: "pane:andy0001" }], plans: [
        plan("clipboard:a", "Alpha", 40, "pane:andy0001"), plan("clipboard:b", "Beta", 10, "pane:bob00001", at("09:30")), plan("clipboard:c", "Gamma", 10, "pane:cody0001", at("09:30")),
        plan("clipboard:d", "Delta", 70, "pane:gone0001", at("09:30")), plan("clipboard:e", "Epsilon", 0, null, at("09:30")), plan("clipboard:f", "Zeta", 20, "pane:andy0001", at("09:00")),
        plan("clipboard:g", "Eta", 30, "pane:dave0001", at("09:30")), plan("clipboard:h", "Theta", 30, "pane:erin0001", at("09:30"))
      ] });
    expect(items.map((item) => [item.title, item.stalled, item.reason])).toEqual([
      ["Alpha", true, "unchanged 8 h"], ["Beta", false, null], ["Gamma", true, "pane waiting 1 h"], ["Delta", true, "no open pane"], ["Epsilon", true, "no open pane"],
      ["Zeta", false, null], ["Eta", true, "pane working with no report for 3 h"], ["Theta", false, null]
    ]);
    expect(items[0]).toMatchObject({ managed: true, lastReport: '08:00 UTC turn end: "Done with step 2."', lastNudgedAt: null });
    expect(renderNousPlanActivity(items).split("\n").slice(0, 2)).toEqual([
      "## Plan activity (when each open plan last moved, and its pane; STALLED plans come to you in Standing orders turns)",
      "- \"Alpha\" 40%: unchanged 8 h (since 2026-10-17 02:00 UTC); pane Andy idle since 2026-10-17 08:00 UTC — STALLED (unchanged 8 h) · managed by plan execution"
    ]);
    const prompt = renderStandingPlansPrompt(items).split("\n");
    expect(prompt[0]).toBe("## Stalled plans (operator rule: every open plan moves to 100%; take exactly one concrete action per plan now)");
    expect(prompt).toHaveLength(6);
    expect(prompt[1]).toBe("- [clipboard:a] \"Alpha\" IN_PROGRESS 40% · unchanged 8 h (since 2026-10-17 02:00 UTC) · pane Andy idle since 2026-10-17 08:00 UTC"
      + " · last report 08:00 UTC turn end: \"Done with step 2.\" · STALLED: unchanged 8 h · managed by plan execution: do not change its steps, nudge only its pane");
    expect(prompt[4]).toContain("[clipboard:e] \"Epsilon\" IN_PROGRESS 0% · unchanged 0.5 h");
    expect(renderStandingPlansPrompt(items.filter((item) => !item.stalled))).toBe("");
  });

  it("never calls a plan stalled when its room could not be read", async () => {
    const items = await nousPlanActivity({ owner: "user:operator", now: new Date(at("10:00")), marks: new InMemoryNousPlanMarksRepository(),
      samples: [{ sample: null }], plans: [plan("clipboard:a", "Alpha", 40, "pane:andy0001")] });
    expect(items[0]).toMatchObject({ pane: null, stalled: false, reason: null });
  });
});
