import { describe, expect, it } from "vitest";
import { nousDecisionSchema, nousTurnFactsSchema } from "@space/contracts";
import { nousScoreErrors } from "../src/nous/score.js";

// 13/11 slice 5: a correction's lesson saved in a later turn (lessons-card-after-answer-misread cites nous_msg:40c57252) cost −5 beside the correction's −5.
describe("a lesson that cites a corrected operator message", () => {
  const NOW = Date.parse("2026-11-13T12:00:00.000Z");
  const correction = nousTurnFactsSchema.parse({ turnId: "nous_turn:c1", ownerUserId: "user:operator", reason: "OPERATOR", status: "DONE",
    startedAt: "2026-11-13T04:10:00.000Z", endedAt: "2026-11-13T04:12:00.000Z", planPoints: 0, tools: {},
    outcomes: [{ summary: "Misread the card answer", outcome: "SELF", correction: true, messageIds: ["nous_msg:40c57252aa11bb22cc33dd44"] }] });
  const lessons = (text: string) => nousScoreErrors({ now: NOW, timeZone: "UTC", facts: [correction], decisions: [],
    lessons: [{ key: "lessons-card-after-answer-misread", text, createdAt: "2026-11-13T04:20:07.000Z", updatedAt: "2026-11-13T04:20:07.000Z" }] })
    .reduce((sum, day) => sum + day.lessons, 0);

  it("costs nothing, by its short or full id; a self-found lesson and an incident citing another message still count", () => {
    expect(lessons("13/11 11:12 BKK, nous_msg:40c57252. I read the answer wrong.")).toBe(0);
    expect(lessons("Operator (nous_msg:40c57252aa11bb22cc33dd44) said so.")).toBe(0);
    expect(lessons("Self-found: nous_msg:99999999 was a new request.")).toBe(1);
    expect(lessons("Base nous_msg:40c57252.\n\n--- Incident (2026-11-13T06:00:00.000Z, saved as lessons-x):\nSelf-found again.")).toBe(1);
  });

  // 23/11 (lessons-1123-card-for-missing-button): the lesson cites the first complaint; the charged correction is a later message that repeats it.
  it("costs nothing when it cites the first complaint a charged correction repeats", () => {
    const repeat = nousTurnFactsSchema.parse({ ...correction, turnId: "nous_turn:c2",
      outcomes: [{ summary: "Same missing button again", outcome: "PENDING", correction: true, repeats: "nous_msg:931c907c42684176b742ba67", messageIds: ["nous_msg:b25510ce569e4b58879ef088"] }] });
    const count = (text: string) => nousScoreErrors({ now: NOW, timeZone: "UTC", facts: [repeat], decisions: [],
      lessons: [{ key: "lessons-1123-card-for-missing-button", text, createdAt: "2026-11-13T02:00:00.000Z", updatedAt: "2026-11-13T02:00:00.000Z" }] })
      .reduce((sum, day) => sum + day.lessons, 0);
    expect(count("Operator nous_msg:931c907c42684176b742ba67: no such option.")).toBe(0);
    expect(count("Self-found: nous_msg:99999999 was a new request.")).toBe(1);
  });
});

// 14/11 (lessons-prediction-misses-1112, lessons-prediction-misses): the ledger's misses re-recorded as lessons outside the REVIEW cost −5 beside each miss.
describe("a lesson that cites a decision the score charged", () => {
  const NOW = Date.parse("2026-11-13T12:00:00.000Z");
  const decision = (id: string, status: string, answer: string, prediction = "yes") => nousDecisionSchema.parse({ id, ownerUserId: "user:operator", category: "DIRECTION", title: "Ask",
    body: `Prediction: ${prediction} (90%)`, options: [], recommendation: null, refs: {}, action: null, status, answer, outcome: null,
    createdAt: "2026-11-13T01:00:00.000Z", answeredAt: "2026-11-13T02:00:00.000Z" });
  const decisions = [decision("nous_decision:missed123456", "APPROVED", "Yes", "no"), decision("nous_decision:declined1234", "DECLINED", "No"), decision("nous_decision:matched12345", "APPROVED", "Yes")];
  const lessons = (text: string) => nousScoreErrors({ now: NOW, timeZone: "UTC", facts: [], decisions,
    lessons: [{ key: "lessons-prediction-misses", text, createdAt: "2026-11-13T05:00:00.000Z", updatedAt: "2026-11-13T05:00:00.000Z" }] })
    .reduce((sum, day) => sum + day.lessons, 0);

  it("costs nothing for a prediction miss or a decline; one citing a decision charged nothing still counts", () => {
    expect(lessons("I predicted no on nous_decision:missed12; the operator approved.")).toBe(0);
    expect(lessons("nous_decision:declined1234 was declined: ask less.")).toBe(0);
    expect(lessons("nous_decision:matched12345 went as predicted, but I asked late.")).toBe(1);
  });
});
