import { describe, expect, it } from "vitest";
import type { ClipboardItem, Pane } from "@space/contracts";
import { InMemoryNousPlanMarksRepository } from "@space/db";
import type { DashboardAgentsSample } from "../src/room-routes.js";
import { nousPlanActivity, nousStalledPlansLine, renderNousPlanActivity } from "../src/nous/stalled-plans.js";

// Stalled plans (plan clipboard:8s0ZNiO3q5ZT S4).
const at = (time: string) => `2026-10-17T${time}:00.000Z`;
const plan = (id: string, title: string, percent: number, paneId: string | null, lastProgressAt = at("02:00")) =>
  ({ id, title, text: title, progressPercentage: percent, paneId, lastProgressAt, createdAt: at("01:00") }) as unknown as ClipboardItem;
const pane = (id: string, paneName: string) => ({ id, paneName, title: paneName }) as unknown as Pane;
const sample = (entries: Array<[Pane, string, string]>): DashboardAgentsSample => ({
  data: entries.map(([entry]) => entry), sampledAt: at("10:00"),
  activity: Object.fromEntries(entries.map(([entry, status]) => [entry.id, status])) as never,
  details: Object.fromEntries(entries.map(([entry, status, since]) => [entry.id, { status, since, source: "native" }])) as never
});

describe("stalled plans", () => {
  it("knows when each plan's percentage last changed, not when progress was last written", async () => {
    const marks = new InMemoryNousPlanMarksRepository();
    const samples = [{ sample: sample([[pane("pane:andy0001", "Andy"), "idle", at("08:00")]]) }];
    const first = await nousPlanActivity({ owner: "user:operator", plans: [plan("clipboard:a", "Alpha", 40, "pane:andy0001")], samples, marks, now: new Date(at("09:00")) });
    expect(first[0]).toMatchObject({ changedAt: at("02:00"), hours: 7, stalled: true });
    // The same 40% written again later does not move the mark; 55% does.
    const same = await nousPlanActivity({ owner: "user:operator", plans: [plan("clipboard:a", "Alpha", 40, "pane:andy0001", at("08:59"))], samples, marks, now: new Date(at("10:00")) });
    expect(same[0]).toMatchObject({ changedAt: at("02:00"), hours: 8 });
    const moved = await nousPlanActivity({ owner: "user:operator", plans: [plan("clipboard:a", "Alpha", 55, "pane:andy0001", at("10:30"))], samples, marks, now: new Date(at("10:30")) });
    expect(moved[0]).toMatchObject({ changedAt: at("10:30"), hours: 0, stalled: false });
  });

  it("calls a plan stalled after 6 hours only when its pane is idle or no open pane works on it", async () => {
    const samples = [{ sample: sample([[pane("pane:andy0001", "Andy"), "idle", at("08:00")], [pane("pane:bob00001", "Bob"), "working", at("09:55")],
      [pane("pane:cody0001", "Cody"), "waiting", at("09:00")]]) }];
    const items = await nousPlanActivity({ owner: "user:operator", now: new Date(at("10:00")), marks: new InMemoryNousPlanMarksRepository(), samples, plans: [
      plan("clipboard:a", "Alpha", 40, "pane:andy0001"), plan("clipboard:b", "Beta", 10, "pane:bob00001"), plan("clipboard:c", "Gamma", 10, "pane:cody0001"),
      plan("clipboard:d", "Delta", 70, "pane:gone0001"), plan("clipboard:e", "Epsilon", 0, null), plan("clipboard:f", "Zeta", 20, "pane:andy0001", at("06:00"))
    ] });
    expect(items.map((item) => [item.title, item.stalled])).toEqual([
      ["Alpha", true], ["Beta", false], ["Gamma", false], ["Delta", true], ["Epsilon", true], ["Zeta", false]
    ]);
    expect(renderNousPlanActivity(items).split("\n").slice(0, 2)).toEqual([
      "## Plan activity (when each open plan's % last changed, and its pane)",
      "- \"Alpha\" 40%: unchanged 8 h (since 2026-10-17 02:00 UTC); pane Andy idle since 2026-10-17 08:00 UTC — STALLED"
    ]);
    expect(nousStalledPlansLine(items)).toBe("Stalled 6+ h with an idle pane: \"Alpha\" (8 h, pane Andy idle since 2026-10-17 08:00 UTC); "
      + "\"Delta\" (8 h, no open pane); \"Epsilon\" (8 h, no open pane).");
    expect(nousStalledPlansLine(items.filter((item) => !item.stalled))).toBeNull();
  });

  it("never calls a plan stalled when its room could not be read", async () => {
    const items = await nousPlanActivity({ owner: "user:operator", now: new Date(at("10:00")), marks: new InMemoryNousPlanMarksRepository(),
      samples: [{ sample: null }], plans: [plan("clipboard:a", "Alpha", 40, "pane:andy0001")] });
    expect(items[0]).toMatchObject({ pane: null, stalled: false });
  });
});
