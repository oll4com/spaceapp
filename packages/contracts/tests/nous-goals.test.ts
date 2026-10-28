import { describe, expect, it } from "vitest";
import { NOUS_TURN_KINDS, NOUS_TURN_REASONS, nousGoalEditInputSchema, nousGoalsSettingsSchema, nousGoalUpdateArgsSchema, nousModelFor, nousModelsSettingsSchema, nousSettingsSchema, nousTurnFactsSchema, nousTurnKindOf, parseNousGoalCommand } from "../src/index.js";

// Nous Goals (operator request 2026-10-27, plan clipboard:DR51jZJEB0j1).
describe("Nous goals contracts", () => {
  it("reads /goal <text> as a new goal from the operator's exact words and /goal or /goals as the list", () => {
    expect(parseNousGoalCommand("/goal Sell 100 licences by December")).toEqual({ kind: "CREATE", text: "Sell 100 licences by December" });
    expect(parseNousGoalCommand("  /GOAL   κάνε το Job Copilot να βρει δουλειά  ")).toEqual({ kind: "CREATE", text: "κάνε το Job Copilot να βρει δουλειά" });
    expect(parseNousGoalCommand("/goals Sell more")).toEqual({ kind: "CREATE", text: "Sell more" });
    expect(parseNousGoalCommand("/goal")).toEqual({ kind: "LIST" });
    expect(parseNousGoalCommand("/goals\n")).toEqual({ kind: "LIST" });
    expect(parseNousGoalCommand("/goalkeeper rules")).toBeNull();
    expect(parseNousGoalCommand("my /goal is")).toBeNull();
    expect(parseNousGoalCommand("what is the goal?")).toBeNull();
  });

  it("gives goal turns their own kind with the strongest model and effort, their facts a goal id, and the settings a loop", () => {
    expect(NOUS_TURN_REASONS).toContain("GOAL");
    expect(NOUS_TURN_KINDS).toContain("goal");
    expect(nousTurnKindOf("GOAL")).toBe("goal");
    expect(nousModelsSettingsSchema.parse({}).goal).toEqual({ model: "claude-fable-5-1", effort: "max" });
    expect(nousModelFor(undefined, "GOAL")).toEqual({ model: "claude-fable-5-1", effort: "max" });
    // Settings saved before 2026-10-27 have no goal row: the default applies, the saved rows stay.
    expect(nousModelsSettingsSchema.parse({ inbox: { model: "claude-sonnet-5-5", effort: "low" } })).toMatchObject({ inbox: { model: "claude-sonnet-5-5", effort: "low" }, goal: { model: "claude-fable-5-1", effort: "max" } });
    expect(nousSettingsSchema.parse({}).goals).toEqual({ loop: true, gapSeconds: 60, backoffMinutes: 15, backoffMaxMinutes: 60, unchangedTurns: 3 });
    expect(nousGoalsSettingsSchema.safeParse({ backoffMinutes: 30, backoffMaxMinutes: 10 }).success).toBe(false);
    expect(nousGoalsSettingsSchema.safeParse({ gapSeconds: 5 }).success).toBe(false);
    expect(nousTurnFactsSchema.parse({ turnId: "nous_turn:a", ownerUserId: "user:operator", reason: "GOAL", status: "DONE", tools: {}, planPoints: 0, outcomes: [],
      startedAt: "2026-10-27T10:00:00.000Z", endedAt: "2026-10-27T10:01:00.000Z", goalId: "nous_goal:abcdef123456" }).goalId).toBe("nous_goal:abcdef123456");
    expect(nousTurnFactsSchema.parse({ turnId: "nous_turn:b", ownerUserId: "user:operator", reason: "INBOX", status: "DONE", tools: {}, planPoints: 0, outcomes: [],
      startedAt: "2026-10-27T10:00:00.000Z", endedAt: "2026-10-27T10:01:00.000Z" }).goalId).toBeNull();
  });

  it("keeps the text, the status and the order with the operator, and ACHIEVED with its evidence", () => {
    expect(nousGoalEditInputSchema.safeParse({}).success).toBe(false);
    expect(nousGoalEditInputSchema.safeParse({ status: "ACHIEVED" }).success).toBe(false);
    expect(nousGoalEditInputSchema.parse({ status: "PAUSED" })).toEqual({ status: "PAUSED" });
    expect(nousGoalUpdateArgsSchema.safeParse({ goal: "nous_goal:abcdef123456", achieved: { evidence: "short" } }).success).toBe(false);
    expect(nousGoalUpdateArgsSchema.safeParse({ goal: "nous_goal:abcdef123456", text: "new words" }).success).toBe(false);
    expect(nousGoalUpdateArgsSchema.parse({ goal: "nous_goal:abcdef123456", progress: 30, waitsOn: { kind: "OPERATOR", what: "the Stripe sign-in" } }).waitsOn).toEqual({ kind: "OPERATOR", what: "the Stripe sign-in", until: null });
  });
});
