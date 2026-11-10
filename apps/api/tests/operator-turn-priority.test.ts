import { describe, expect, it } from "vitest";
import { paceCapApplies } from "../../../packages/gateway/src/router/balancer.js";
import { noteOperatorPaneInput, OPERATOR_TURN_GRACE_MS, operatorTurnPanes } from "../src/queue-operator-grants.js";

// Operator bug 7/11 01:08 BKK «γιατι δεν δουλευει?» (plan clipboard:1NF6u6gcCwtj): a question the operator typed into pane:w8RtZEb4MtiM was
// held as background work ("429 Space Gateway is holding background work ... attempt 9/10").
describe("operator turns are priority panes for Space Gateway's pace cap", () => {
  it("never holds a prompt the operator typed into a pane, until its turn ends plus the grace; a Nous-sent prompt still is", async () => {
    const t0 = Date.parse("2026-11-07T01:08:00.000Z");
    const alive = new Map<string, number>();
    let working = new Set<string>();
    const panes = (at: number) => operatorTurnPanes(alive, async () => working, at);
    // The operator types a question and presses Enter; pane:nous-sent only ever gets Nous's prompts (they never reach noteOperatorPromoteLine).
    noteOperatorPaneInput("pane:operator-typed", "γιατι δεν δουλευει?\r", t0);
    working = new Set(["pane:operator-typed", "pane:nous-sent"]);
    const exempt = new Set(await panes(t0 + 1_000));
    expect(paceCapApplies("pane:operator-typed", exempt)).toBe(false);
    expect(paceCapApplies("pane:nous-sent", exempt)).toBe(true);
    // A long turn stays exempt while it works (Nous's job asks every minute), past the grace counted from the line.
    for (let minute = 1; minute <= 30; minute += 1) expect(await panes(t0 + minute * 60_000)).toContain("pane:operator-typed");
    // The turn ends: the grace still covers it, then a later (Nous) prompt there is held again.
    working = new Set();
    expect(await panes(t0 + 30 * 60_000 + OPERATOR_TURN_GRACE_MS - 1)).toContain("pane:operator-typed");
    working = new Set(["pane:operator-typed"]);
    expect(await panes(t0 + 30 * 60_000 + OPERATOR_TURN_GRACE_MS)).not.toContain("pane:operator-typed");
  });
});
