// Score push (operator 13/11 07:23 BKK): an unworked Score variable over 5 % of a negative Score is a held item until a pane is opened or briefed on it.
import { describe, expect, it } from "vitest";
import { scorePushItems } from "../src/nous/score-push.js";
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
});
