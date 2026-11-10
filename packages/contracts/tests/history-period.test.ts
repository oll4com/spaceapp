import { describe, expect, it } from "vitest";
import { historyPeriodDays, historySince, updateUserSettingsInputSchema, userSettingsSchema } from "../src/index.js";

// One history period for every history (operator 1/11 03:37 BKK): 7, 14, 30, 60 or 90 days, 90 by default and at most.
describe("history period", () => {
  it("reads 90 days when unset or unreadable and refuses anything else than the choices", () => {
    expect(historyPeriodDays(userSettingsSchema.parse({}))).toBe(90);
    expect(historyPeriodDays({ history: { periodDays: 30 } })).toBe(30);
    expect(historyPeriodDays({ history: { periodDays: 365 } })).toBe(90);
    expect(historyPeriodDays(userSettingsSchema.parse({ history: { periodDays: 365 } }))).toBe(90);
    expect(updateUserSettingsInputSchema.safeParse({ history: { periodDays: 120 } }).success).toBe(false);
    expect(updateUserSettingsInputSchema.safeParse({ history: { periodDays: 45 } }).success).toBe(false);
    expect(updateUserSettingsInputSchema.parse({ history: { periodDays: 7 } })).toEqual({ history: { periodDays: 7 } });
  });

  it("gives the oldest moment a history keeps", () => {
    expect(historySince({ history: { periodDays: 7 } }, Date.parse("2026-11-08T00:00:00.000Z"))).toBe("2026-11-01T00:00:00.000Z");
    expect(historySince(null, Date.parse("2026-11-01T00:00:00.000Z"))).toBe("2026-08-03T00:00:00.000Z");
  });
});
