import { describe, expect, it } from "vitest";
import { nousDecisionSchema } from "@space/contracts";
import { nousScoreErrors } from "../src/nous/score.js";

// 12/11 04:54 (Plesk 2e8ad90b + e02eaed6, open together, both answered no): one wrong prediction was charged as two misses.
describe("a prediction miss on a twin ask", () => {
  const NOW = Date.parse("2026-11-12T12:00:00.000Z");
  const ask = (id: string, title: string, createdAt: string, answeredAt: string) => nousDecisionSchema.parse({ id, ownerUserId: "user:operator",
    category: "DIRECTION", title, body: "Prediction: yes (80%)", options: [], recommendation: null, refs: {}, action: null, status: "ANSWERED",
    answer: "Όχι, δεν πληρώνουμε", outcome: null, createdAt, answeredAt });
  const misses = (...decisions: ReturnType<typeof ask>[]) => nousScoreErrors({ now: NOW, timeZone: "UTC", facts: [], decisions, lessons: [] })
    .reduce((sum, day) => sum + day.predictionMisses, 0);
  const first = ask("nous_decision:2e8ad90b", "Plesk του public-host: να περάσουμε σε Web Admin μηνιαίο (~$17/μήνα) αντί για ανανέωση του Web Pro με €280,39 στις 25/11;",
    "2026-11-12T04:50:00.000Z", "2026-11-12T05:10:00.000Z");
  const reworded = "Plesk: να περάσουμε από Web Pro (~$330/έτος) σε Web Admin (~$187/έτος) πριν τις 25/11;";

  it("is charged once while both were open; a later re-ask or another subject is charged again", () => {
    expect(misses(first)).toBe(1);
    expect(misses(first, ask("nous_decision:e02eaed6", reworded, "2026-11-12T04:54:00.000Z", "2026-11-12T05:11:00.000Z"))).toBe(1);
    expect(misses(first, ask("nous_decision:later001", reworded, "2026-11-12T06:00:00.000Z", "2026-11-12T06:30:00.000Z"))).toBe(2);
    expect(misses(first, ask("nous_decision:other001", "Turso: ποιο έτος ίδρυσης γράφουμε στη φόρμα;", "2026-11-12T04:55:00.000Z", "2026-11-12T05:12:00.000Z"))).toBe(2);
  });
});
