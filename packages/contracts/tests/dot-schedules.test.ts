import { describe, expect, it } from "vitest";
import { describeDotScheduleRecurrence, isValidTimeZone, nextDotScheduleRun, zonedWallTimeToUtc } from "../src/index.js";

const iso = (ms: number | null) => ms === null ? null : new Date(ms).toISOString();
describe("Dot schedule times", () => {
  it("converts wall-clock times across daylight saving time", () => {
    expect(iso(zonedWallTimeToUtc(2026, 9, 10, 9, 0, "Europe/Athens"))).toBe("2026-10-10T06:00:00.000Z");
    expect(iso(zonedWallTimeToUtc(2026, 11, 10, 9, 0, "Europe/Athens"))).toBe("2026-12-10T07:00:00.000Z");
    expect(iso(nextDotScheduleRun({ kind: "DAILY", time: "09:00" }, "Europe/Athens", Date.parse("2026-10-24T07:00:00Z")))).toBe("2026-10-25T07:00:00.000Z");
  });
  it("finds the next weekly, one-time and interval occurrence strictly after now", () => {
    expect(iso(nextDotScheduleRun({ kind: "WEEKLY", days: [1, 3], time: "08:30" }, "Asia/Bangkok", Date.parse("2026-10-10T00:00:00Z")))).toBe("2026-10-12T01:30:00.000Z");
    expect(iso(nextDotScheduleRun({ kind: "DAILY", time: "09:00" }, "Europe/Athens", Date.parse("2026-10-10T06:00:00Z")))).toBe("2026-10-11T06:00:00.000Z");
    expect(nextDotScheduleRun({ kind: "ONCE", at: "2026-10-10T08:00:00Z" }, "UTC", Date.parse("2026-10-10T09:00:00Z"))).toBeNull();
    expect(iso(nextDotScheduleRun({ kind: "INTERVAL", minutes: 30 }, "UTC", Date.parse("2026-10-10T07:00:00Z")))).toBe("2026-10-10T07:30:00.000Z");
  });
  it("validates zones and describes schedules in English", () => {
    expect(isValidTimeZone("Europe/Athens")).toBe(true);
    expect(isValidTimeZone("Mars/Olympus")).toBe(false);
    expect(describeDotScheduleRecurrence({ kind: "WEEKLY", days: [1, 5], time: "07:00" }, "UTC")).toBe("Every Mon, Fri at 07:00 (UTC)");
    expect(describeDotScheduleRecurrence({ kind: "INTERVAL", minutes: 120 }, "UTC")).toBe("Every 2 h");
  });
});
