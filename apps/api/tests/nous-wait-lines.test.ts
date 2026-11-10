// Queue item 39 (28/10 10:58 and 11:08 BKK): Alex/Jack's "Interrupted" flickered and its WAITING line reached Nous twice, two turns.
import { describe, expect, it } from "vitest";
import { createWaitLineGate, NOUS_WAIT_LINE_REPEAT_MS } from "../src/nous/wait-lines.js";

describe("WAITING inbox lines", () => {
  it("sends the same pane's same wait once an hour, a changed question or another pane at once", () => {
    let clock = 0;
    const gate = createWaitLineGate(() => clock);
    const interrupted = "Jack is waiting: Interrupted\n\n";
    expect(gate("pane:jack", "WAITING", interrupted)).toBe(true);
    clock += 15_000;
    expect(gate("pane:jack", "WAITING", interrupted)).toBe(false);
    clock += 10 * 60_000;
    expect(gate("pane:jack", "WAITING", interrupted)).toBe(false);
    expect(gate("pane:jack", "WAITING", "Jack is waiting: Question for you\n\nShip it?")).toBe(true);
    expect(gate("pane:jack", "STUCK", interrupted)).toBe(true);
    expect(gate("pane:kate", "WAITING", interrupted)).toBe(true);
    clock += NOUS_WAIT_LINE_REPEAT_MS;
    expect(gate("pane:jack", "WAITING", "Jack is waiting: Question for you\n\nShip it?")).toBe(true);
  });
});
