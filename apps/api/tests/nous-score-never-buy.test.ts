import { describe, expect, it } from "vitest";
import { nousDecisionSchema } from "@space/contracts";
import { NEVER_BUY_ANSWER } from "../src/nous/allowances.js";
import { nousScoreErrors } from "../src/nous/score.js";

// 20/11 (363fd74a, "send the Olla CSV lists to the buyer" declined by the old Never-buy check, −5): a misfire of the rule is not Nous's decline.
describe("a decision declined by the Never-buy rule", () => {
  const NOW = Date.parse("2026-11-19T12:00:00.000Z");
  const ask = (id: string, title: string, recommendation: string, answer = NEVER_BUY_ANSWER) => nousDecisionSchema.parse({ id, ownerUserId: "user:operator",
    category: "DIRECTION", title, body: "Prediction: yes (90%)", options: [], recommendation, refs: {}, action: null, status: "DECLINED",
    answer, outcome: null, createdAt: "2026-11-19T11:00:00.000Z", answeredAt: "2026-11-19T11:26:00.000Z" });
  const declined = (...decisions: ReturnType<typeof ask>[]) => nousScoreErrors({ now: NOW, timeZone: "UTC", facts: [], decisions, lessons: [] })
    .reduce((sum, day) => sum + day.declined, 0);

  it("is charged while the ask still reads as a purchase, not when the check no longer matches it", () => {
    expect(declined(ask("nous_decision:72cbbc60", "NordVPN: ανανέωση 3 μηνών;", "Ναι, ανανέωση 3 μηνών ($37.47)"))).toBe(1);
    expect(declined(ask("nous_decision:363fd74a", "Olla: να στείλω τις λίστες CSV στον αγοραστή;", "Ναι: στέλνω τα CSV των αγοραστών"))).toBe(0);
    expect(declined(ask("nous_decision:op000001", "Olla: να στείλω τις λίστες CSV στον αγοραστή;", "Ναι", "Όχι"))).toBe(1);
  });
});
