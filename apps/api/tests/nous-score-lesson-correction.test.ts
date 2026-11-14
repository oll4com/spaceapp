import { describe, expect, it } from "vitest";
import { nousTurnFactsSchema } from "@space/contracts";
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
});
