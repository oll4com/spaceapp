import { describe, expect, it } from "vitest";
import { planShownStatus } from "../src/plan-map.js";

const parked = { reason: "Waits on the pentest quote.", resumedAt: null, conditions: [{ what: "Call done", state: "MET" }, { what: "Synacktiv 25/11", state: "OPEN" }] };

describe("planShownStatus (operator 23/11: a parked plan at 69% read Done)", () => {
  it("reads a parked plan as PARKED with its reason and first open condition, never COMPLETED", () => {
    expect(planShownStatus({ status: "COMPLETED", progress: 69, steps: [{ status: "COMPLETED" }, { status: "BLOCKED" }], parked }))
      .toEqual({ status: "PARKED", reason: "Waits on the pentest quote.", waitsOn: "Synacktiv 25/11" });
  });
  it("reads a closed plan with an open step or under 100% as PARKED even with no park record", () => {
    expect(planShownStatus({ status: "COMPLETED", progress: 100, steps: [{ status: "COMPLETED" }, { status: "PENDING" }] }).status).toBe("PARKED");
    expect(planShownStatus({ status: "COMPLETED", progress: 80, parked: null })).toEqual({ status: "PARKED", reason: null, waitsOn: null });
  });
  it("keeps COMPLETED only when every step is completed, and a resumed park record is history", () => {
    expect(planShownStatus({ status: "COMPLETED", progress: 100, steps: [{ status: "COMPLETED" }], parked: { ...parked, resumedAt: "2026-11-22T10:00:00.000Z" } }).status).toBe("COMPLETED");
    expect(planShownStatus({ status: "IN_PROGRESS", progress: 40, steps: [{ status: "PENDING" }] }).status).toBe("IN_PROGRESS");
  });
});
