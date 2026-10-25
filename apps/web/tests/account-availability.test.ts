import { describe, expect, it } from "vitest";
import {
  availabilityLabel,
  bestAvailability,
  classifyQuota,
  compareAvailability,
  formatUntil,
  matchesAvailabilityFilter,
  quotaCapacity,
} from "../src/features/toolbar-metrics/account-availability.js";
import type { DateTimeSettings } from "../src/features/date-time-settings/date-time-settings.js";

const clock = Date.parse("2026-10-11T10:00:00.000Z");
const at = (minutes: number) => new Date(clock + minutes * 60_000).toISOString();
const settings: DateTimeSettings = { timeZone: "UTC", timeFormat: "24h", dateFormat: "DD/MM/YYYY" };

describe("account availability", () => {
  it("separates usable, back-soon and week-exhausted accounts", () => {
    expect(classifyQuota({ fiveHourRemainingPercent: 40, weeklyRemainingPercent: 80 }, clock)).toEqual({ state: "available", backAt: null });
    expect(classifyQuota({ fiveHourRemainingPercent: 0, fiveHourResetAt: at(52), weeklyRemainingPercent: 80 }, clock))
      .toEqual({ state: "soon", backAt: at(52) });
    expect(classifyQuota({ fiveHourRemainingPercent: 100, weeklyRemainingPercent: 0, weeklyResetAt: at(3 * 24 * 60) }, clock))
      .toEqual({ state: "exhausted", backAt: at(3 * 24 * 60) });
    expect(classifyQuota({ fiveHourRemainingPercent: null, weeklyRemainingPercent: null }, clock)).toEqual({ state: "unknown", backAt: null });
  });

  it("reports a weekly limit that resets within one 5h window as back soon", () => {
    expect(classifyQuota({ fiveHourRemainingPercent: 0, weeklyRemainingPercent: 0.4, weeklyResetAt: at(150) }, clock))
      .toEqual({ state: "soon", backAt: at(150) });
    expect(classifyQuota({ weeklyRemainingPercent: 0, weeklyResetAt: null }, clock).state).toBe("exhausted");
  });

  it("honours a provider threshold such as the Codex routing floor", () => {
    expect(classifyQuota({ fiveHourRemainingPercent: 2, weeklyRemainingPercent: 50 }, clock).state).toBe("available");
    expect(classifyQuota({ fiveHourRemainingPercent: 2, weeklyRemainingPercent: 50 }, clock, 3).state).toBe("soon");
  });

  it("rates a multi-group account by its best group and earliest return", () => {
    expect(bestAvailability([
      { state: "exhausted", backAt: at(3000) },
      { state: "soon", backAt: at(90) },
      { state: "soon", backAt: at(30) },
    ])).toEqual({ state: "soon", backAt: at(30) });
    expect(bestAvailability([])).toEqual({ state: "unknown", backAt: null });
  });

  it("orders available accounts by headroom, then the soonest returns, then offline", () => {
    const entry = (title: string, state: "available" | "soon" | "exhausted" | "offline", capacity: number, backAt: string | null = null) =>
      ({ title, capacity, availability: { state, backAt } });
    const sorted = [
      entry("offline", "offline", -1),
      entry("week", "exhausted", 0, at(2000)),
      entry("later", "soon", 0, at(200)),
      entry("sooner", "soon", 0, at(20)),
      entry("tight", "available", 12),
      entry("roomy", "available", 90),
    ].sort(compareAvailability).map((item) => item.title);
    expect(sorted).toEqual(["roomy", "tight", "sooner", "later", "week", "offline"]);
  });

  it("formats when an account is usable again", () => {
    expect(formatUntil(at(52), clock, settings)).toBe("in 52m");
    expect(formatUntil(at(200), clock, settings)).toBe("in 3h 20m");
    expect(formatUntil(at(120), clock, settings)).toBe("in 2h");
    expect(formatUntil(at(-5), clock, settings)).toBe("now");
    expect(formatUntil(at(3 * 24 * 60 + 8), clock, settings)).toMatch(/^Wed 10:08$/);
    expect(formatUntil(null, clock, settings)).toBeNull();
    expect(availabilityLabel({ state: "soon", backAt: at(52) }, clock, settings)).toBe("Back in 52m");
    expect(availabilityLabel({ state: "soon", backAt: null }, clock, settings)).toBe("Limit reached");
    expect(availabilityLabel({ state: "exhausted", backAt: at(3000) }, clock, settings)).toBe("Week exhausted");
  });

  it("measures headroom and matches filters", () => {
    expect(quotaCapacity([{ fiveHourRemainingPercent: 20, weeklyRemainingPercent: 90 }, { fiveHourRemainingPercent: 70, weeklyRemainingPercent: 60 }])).toBe(60);
    expect(quotaCapacity([{ fiveHourRemainingPercent: null, weeklyRemainingPercent: null }])).toBe(-1);
    expect(matchesAvailabilityFilter("soon", "all")).toBe(true);
    expect(matchesAvailabilityFilter("offline", "available")).toBe(false);
    expect(matchesAvailabilityFilter("exhausted", "exhausted")).toBe(true);
  });
});
