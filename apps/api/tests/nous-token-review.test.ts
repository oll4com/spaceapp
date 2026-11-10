import { describe, expect, it } from "vitest";
import type { NousTurnFacts } from "@space/contracts";
import type { GatewaySavingsDailyRow } from "@space/db";
import { renderTokenReview } from "../src/nous/token-review.js";

// Plan clipboard:ctqx7SPqkWR2 step 6: the REVIEW's token table, from the 1/11 measurements.
describe("Nous daily token table", () => {
  const since = "2026-11-01T20:00:00.000Z";
  const turn = (reason: NousTurnFacts["reason"], at: string, costUsd: number, goalId: string | null = null) => ({ reason, startedAt: at, costUsd, goalId }) as NousTurnFacts;
  const project = (day: string, name: string, costUsd: number, inputTokens: number, requests: number) =>
    ({ day, provider: "CLAUDE", model: "claude-opus-5-5", client: "claude-code", project: name, requests, inputTokens, costUsd }) as GatewaySavingsDailyRow;

  it("lists Nous per turn kind and goal against the day before, the costliest panes with their context a request, and the 5-hour peaks", () => {
    const text = renderTokenReview({
      facts: [turn("GOAL", "2026-11-01T21:00:00.000Z", 2.5, "nous_goal:nvidia000001"), turn("GOAL", "2026-11-01T22:00:00.000Z", 1.5, "nous_goal:nvidia000001"),
        turn("INBOX", "2026-11-01T23:00:00.000Z", 3), turn("GOAL", "2026-10-31T21:00:00.000Z", 9, "nous_goal:nvidia000001")],
      projects: [project("2026-11-01", "pane:finn", 205, 795_000_000, 1_500), project("2026-10-31", "pane:finn", 150, 600_000_000, 1_000), project("2026-11-01", "nous", 80, 100_000_000, 300)],
      accounts: [{ label: "lab@spaceapp.dev", provider: "CLAUDE", fiveHour: [
        { window: "PRIMARY", quotaKey: "", usedPercent: 60, resetAt: null, recordedAt: "2026-11-01T22:00:00.000Z" },
        { window: "PRIMARY", quotaKey: "", usedPercent: 100, resetAt: null, recordedAt: "2026-11-01T23:10:00.000Z" }] },
      { label: "dev@spaceapp.dev", provider: "CLAUDE", fiveHour: [] }],
      names: new Map([["pane:finn", "Cleo/Finn"], ["nous_goal:nvidia000001", "NVIDIA learning access"]]), since, day: "2026-11-01"
    });
    expect(text).toContain("total $7.00, the 24 h before $9.00");
    expect(text).toContain("GOAL $4.00 / 2 turns (before $9.00 / 1); INBOX $3.00 / 1 turns (before none)");
    expect(text).toContain('"NVIDIA learning access" $4.00 / 2 turns (before $9.00 / 1)');
    expect(text).toContain("Cleo/Finn $205.00, 795.0M in over 1500 requests, 530k a request (before $150.00, 600k a request); nous $80.00");
    expect(text).toContain("lab@spaceapp.dev peak 100% at 23:10 UTC, at 100% from 23:10 UTC; dev@spaceapp.dev no 5-hour sample");
  });
});
