// Nous RSI change ledger (plan clipboard:CCIzkVBIbPpG step 1): queue.md's DONE tickets become rows measured from raw turn facts.
import { describe, expect, it } from "vitest";
import { nousTurnFactsSchema, type NousTurnFacts } from "@space/contracts";
import { InMemoryNousChangesRepository } from "@space/db";
import { changeVerdict, countMetric, createNousChanges, lineMetric, queueChanges, NOUS_CHANGE_WINDOW_MS } from "../src/nous/rsi/changes.js";

const owner = "user:operator";
const DAY = 86_400_000;
const deployed = Date.parse("2026-11-10T12:00:00.000Z");
let turnSeq = 0;
const turn = (at: number, tools: NousTurnFacts["tools"] = {}): NousTurnFacts => nousTurnFactsSchema.parse({ turnId: `turn-${turnSeq++}`, ownerUserId: owner, reason: "INBOX", status: "DONE",
  tools, planPoints: 0, outcomes: [], startedAt: new Date(at).toISOString(), endedAt: new Date(at + 1000).toISOString() });
const failed = (n: number, errors: string[] = []) => ({ space_db_query: { calls: n + 1, failed: n, refused: 0, errors } });

// The shapes queue.md really has (28/11): a numbered DONE, an OPEN closed in place, a DONE "already shipped" naming the same ticket again.
const QUEUE = [
  "1. DONE 27/10 q-20261110-120000-8149 — [27/10 1c] space_db_query guessed columns (~57 in 7 days); fix: the column list in the description.",
  "- OPEN 2026-11-28 REVIEW: cards answered by a question back; evidence: 3 cards; fix: refuse a card (space_ask_operator) with no context. [DONE 2026-11-28 q-20261110-120100-08a5]",
  "- DONE 2026-11-22 (already shipped, no new code: 7fd91c8846 q-20261110-120000-8149) was OPEN 2026-11-18 REVIEW: something else",
  "- OPEN 2026-11-28 REVIEW: space_mail_read failed on HTML; evidence: 4; fix: htmlToText",
  "- DONE 2026-11-27 q-20261127-090000-aaaa REVIEW: 42703 guesses; metric:tool:space_db_query~42703; evidence: 12; fix: columns in the error."
].join("\n");

describe("Nous RSI change ledger", () => {
  it("reads one change per DONE ticket, with the tools its cause names as the metric", () => {
    const changes = queueChanges(QUEUE);
    expect(changes.map((change) => [change.ref, change.metric, change.deployedAt])).toEqual([
      ["q-20261110-120000-8149", "tool:space_db_query", "2026-11-10T12:00:00.000Z"],
      // The tool is named only in the fix: nothing countable, the row will say UNMEASURED.
      ["q-20261110-120100-08a5", null, "2026-11-10T12:01:00.000Z"],
      ["q-20261127-090000-aaaa", "tool:space_db_query~42703", "2026-11-27T09:00:00.000Z"]
    ]);
    expect(lineMetric("- OPEN x: a (space_note, space_lessons); evidence: 2; fix: y")).toBe("tool:space_note,tool:space_lessons");
  });

  it("counts mistakes (failed minus refused) or matching error texts, inside the window only", () => {
    const facts = [turn(deployed - DAY, { space_db_query: { calls: 5, failed: 4, refused: 1, errors: ["42703 column x does not exist", "42P01 no table", "42703 again"] } }),
      turn(deployed - 8 * DAY, failed(9)), turn(deployed + DAY, failed(1))];
    expect(countMetric(facts, "tool:space_db_query", deployed - NOUS_CHANGE_WINDOW_MS, deployed)).toEqual({ count: 3, turns: 1 });
    expect(countMetric(facts, "tool:space_db_query~42703", deployed - NOUS_CHANGE_WINDOW_MS, deployed)).toEqual({ count: 2, turns: 1 });
    expect(countMetric(facts, "tool:space_db_query,tool:space_note", deployed, deployed + NOUS_CHANGE_WINDOW_MS)).toEqual({ count: 1, turns: 1 });
    expect(countMetric(facts, "predictions", deployed, deployed + DAY)).toBeNull();
  });

  it("gives a verdict only to a clear case, as rates per turn", () => {
    expect(changeVerdict({ count: 57, turns: 3000 }, { count: 8, turns: 3000 })).toBe("KEPT");
    expect(changeVerdict({ count: 8, turns: 3000 }, { count: 30, turns: 3000 })).toBe("WORSE");
    expect(changeVerdict({ count: 12, turns: 3000 }, { count: 9, turns: 3000 })).toBe("NO_EFFECT");
    // Twice the failures in a week with twice the turns is the same rate.
    expect(changeVerdict({ count: 20, turns: 1000 }, { count: 40, turns: 2000 })).toBe("NO_EFFECT");
    expect(changeVerdict({ count: 0, turns: 500 }, { count: 0, turns: 500 })).toBe("NO_EFFECT");
    expect(changeVerdict({ count: 5, turns: 0 }, { count: 0, turns: 500 })).toBe("UNMEASURED");
  });

  it("a tick records live tickets with the week before, then the week after once it has passed; counts never move again", async () => {
    const repository = new InMemoryNousChangesRepository();
    const facts = [...Array.from({ length: 20 }, (_, index) => turn(deployed - (index % 6 + 1) * DAY, failed(2))), ...Array.from({ length: 20 }, (_, index) => turn(deployed + (index % 6 + 1) * DAY))];
    let now = deployed + DAY;
    const asked: string[] = [];
    const changes = createNousChanges({ repository, queueText: async () => QUEUE, onStable: async (id) => id !== "q-20261127-090000-aaaa",
      turnFacts: async (_owner, since) => { asked.push(since); return facts; }, now: () => now });

    await changes.tick(owner);
    let rows = await repository.list(owner);
    // The third ticket is not on stable yet: no row.
    expect(rows.map((row) => [row.ref, row.verdict, row.before, row.after])).toEqual([
      ["q-20261110-120000-8149", null, { count: 40, turns: 20 }, null],
      ["q-20261110-120100-08a5", "UNMEASURED", null, null]
    ]);
    expect(asked).toEqual([new Date(deployed - NOUS_CHANGE_WINDOW_MS).toISOString()]);

    now = deployed + NOUS_CHANGE_WINDOW_MS + 1;
    await changes.tick(owner);
    rows = await repository.list(owner);
    expect(rows[0]).toMatchObject({ verdict: "KEPT", after: { count: 0, turns: 20 }, measuredAt: new Date(now).toISOString() });

    // Old failures reclassified or new ones written later do not reach a measured row.
    facts.push(turn(deployed + DAY, failed(50)));
    now += 30 * DAY;
    await changes.tick(owner);
    expect((await repository.list(owner))[0]).toMatchObject({ verdict: "KEPT", after: { count: 0, turns: 20 } });
  });

  it("back-fills an old ticket in one tick: before, after and verdict", async () => {
    const repository = new InMemoryNousChangesRepository();
    const facts = [turn(deployed - DAY, failed(3)), turn(deployed + DAY, failed(40))];
    await createNousChanges({ repository, queueText: async () => QUEUE.split("\n")[0]!, onStable: async () => true, turnFacts: async () => facts, now: () => deployed + 20 * DAY }).tick(owner);
    expect(await repository.list(owner)).toMatchObject([{ kind: "CODE", before: { count: 3, turns: 1 }, after: { count: 40, turns: 1 }, verdict: "WORSE" }]);
  });
});
