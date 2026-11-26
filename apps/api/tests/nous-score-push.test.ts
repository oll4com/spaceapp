// Score push (operator 13/11 07:23 BKK): an unworked Score variable over 5 % of a negative Score is a held item until a pane is opened or briefed on it.
import { describe, expect, it } from "vitest";
import { CLOSE_PARKED, scorePushItems } from "../src/nous/score-push.js";
import { itemActed, type NousTurnAct } from "../src/nous/turn-items.js";

const errors = { label: "Daily Nous errors", share: 50.3, points: -266.4, move: "open or brief a code-fix pane with these causes and counts: space_execute failed ×40 (−80)" };
const act = (name: string, args: Record<string, unknown>): NousTurnAct => ({ name, args, ok: true, subjects: [] });

describe("scorePushItems", () => {
  it("pushes nothing while the Score is not negative or every variable has a pane", () => {
    expect(scorePushItems(12, [errors])).toBeNull();
    expect(scorePushItems(-529.8, [])).toBeNull();
  });

  it("holds each unworked variable until an act names it, whatever the turn answered", () => {
    const push = scorePushItems(-529.8, [errors, { label: "Startup programs", share: 16.9, points: -89.5, move: "move its open entries" }])!;
    expect(push.line).toContain("Score -529.8");
    expect(push.line).toContain("- Daily Nous errors -266.4 (50.3% of the negative), no pane works on it: open or brief a code-fix pane");
    const [item] = push.items;
    expect(item).toMatchObject({ key: "score:Daily Nous errors", always: true });
    expect(itemActed(item!, [])).toBe(false);
    expect(itemActed(item!, [act("space_open_panes", { prompt: "Fix the Startup programs page" })])).toBe(false);
    expect(itemActed(item!, [{ ...act("space_copilot_brief", { brief: "Fix the causes of Daily Nous errors" }), ok: false }])).toBe(false);
    expect(itemActed(item!, [act("space_copilot_brief", { brief: "Fix the causes of daily nous errors: space_execute ×40" })])).toBe(true);
    expect(itemActed(item!, [act("space_nous_followup", { op: "add", text: "Daily Nous errors: Cody's fix ships with q-1, check at 12:00" })])).toBe(true);
  });

  it("W47 step 1: pushes each open plan past 24 h with no working pane and no recorded wait, whatever the Score, until a pane or a wait names it", () => {
    const plan = { id: "clipboard:zqVWdClsx_pA", title: "Space Link v2", points: -12, age: "1 d" };
    const push = scorePushItems(139.9, [errors], [plan])!;
    expect(push.items).toHaveLength(1);
    expect(push.line).not.toContain("Score 139.9");
    expect(push.line).toContain("- [clipboard:zqVWdClsx_pA] \"Space Link v2\" -12: open 1 d, no working pane, no recorded wait");
    const [item] = push.items;
    expect(item).toMatchObject({ key: "score-plan:clipboard:zqVWdClsx_pA", kind: "PLAN", always: true });
    expect(itemActed(item!, [act("space_plan_update", { id: "clipboard:other", percent: 50 })])).toBe(false);
    expect(itemActed(item!, [act("space_plan_update", { id: "clipboard:zqVWdClsx_pA", waitsOn: { kind: "THIRD_PARTY", what: "hz host owner" } })])).toBe(true);
    expect(itemActed(item!, [act("space_open_panes", { panes: [{ planId: "clipboard:zqVWdClsx_pA" }] })])).toBe(true);
    expect(scorePushItems(-10, [errors], [plan])!.items.map((entry) => entry.key)).toEqual(["score:Daily Nous errors", "score-plan:clipboard:zqVWdClsx_pA"]);
  });

  // 21/11 (Score −2980, Open plans 70%): a plan waiting open ages from its creation; the push asks to close it parked.
  it("pushes an open plan whose wait is recorded on it to be closed parked, in its own section", () => {
    const push = scorePushItems(-10, [], [{ id: "clipboard:w", title: "Partner reply", points: -202, age: "10 d", held: "waits on a third party: reply" }])!;
    expect(push.line).not.toContain("no recorded wait");
    expect(push.line).toContain("Open plans that only wait");
    expect(push.line).toContain(CLOSE_PARKED);
    expect(push.line).toContain("- [clipboard:w] \"Partner reply\" -202: open 10 d, no working pane, waits on a third party: reply");
    expect(itemActed(push.items[0]!, [act("space_plan_update", { id: "clipboard:w", executionStatus: "COMPLETED", park: { reason: "reply", conditions: [] } })])).toBe(true);
  });
});
