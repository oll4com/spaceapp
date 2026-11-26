import { describe, expect, it } from "vitest";
import { appointmentOccurrence, appointmentOverdue, appointmentSchema } from "../src/appointments.js";

// Operator 26/11 11:08 BKK (nous_msg:cfce1783): a daily call shows its next day once today's is over, Expired only after the period's last one.
// The EF-Start call: every weekday 09:00 PST from Wed 18/11 to Tue 24/11 (17:00Z, 30 minutes).
const efStart = {
  status: "UPCOMING" as const, timing: "FIXED" as const, timeZone: "America/Los_Angeles", deadlineAt: null,
  startsAt: "2026-11-18T17:00:00.000Z", endsAt: "2026-11-18T17:30:00.000Z", recurrence: { every: "WEEKDAY" as const, until: "2026-11-24" }
};
const at = (iso: string) => Date.parse(iso);

describe("recurring appointments", () => {
  it("stays on today's occurrence until it ends, then moves to the next day at the same time", () => {
    expect(appointmentOccurrence(efStart, at("2026-11-18T17:10:00Z")).startsAt).toBe("2026-11-18T17:00:00.000Z");
    const next = appointmentOccurrence(efStart, at("2026-11-18T17:31:00Z"));
    expect([next.startsAt, next.endsAt]).toEqual(["2026-11-19T17:00:00.000Z", "2026-11-19T17:30:00.000Z"]);
    expect(appointmentOverdue(efStart, at("2026-11-18T17:31:00Z"))).toBe(false);
  });

  it("skips the weekend for weekdays and keeps the wall time in its own zone", () => {
    expect(appointmentOccurrence(efStart, at("2026-11-20T18:00:00Z")).startsAt).toBe("2026-11-23T17:00:00.000Z");
    expect(appointmentOccurrence({ ...efStart, recurrence: { every: "DAY", until: "2026-11-24" } }, at("2026-11-20T18:00:00Z")).startsAt).toBe("2026-11-21T17:00:00.000Z");
    // Across the end of US daylight time (1/11): 09:00 Los Angeles is 16:00Z before and 17:00Z after.
    const autumn = { ...efStart, startsAt: "2026-10-30T16:00:00.000Z", endsAt: "2026-10-30T16:30:00.000Z", recurrence: { every: "DAY" as const, until: "2026-11-05" } };
    expect(appointmentOccurrence(autumn, at("2026-11-02T00:00:00Z")).startsAt).toBe("2026-11-02T17:00:00.000Z");
  });

  it("is Expired only after the period's last occurrence, which it then shows", () => {
    expect(appointmentOverdue(efStart, at("2026-11-24T17:20:00Z"))).toBe(false);
    expect(appointmentOverdue(efStart, at("2026-11-24T17:31:00Z"))).toBe(true);
    expect(appointmentOccurrence(efStart, at("2026-11-26T04:00:00Z")).startsAt).toBe("2026-11-24T17:00:00.000Z");
    expect(appointmentOverdue({ ...efStart, status: "DONE" as const }, at("2026-11-26T04:00:00Z"))).toBe(false);
  });

  it("moves a FLEXIBLE one's deadline with it and leaves a one-off one alone", () => {
    const flexible = { ...efStart, timing: "FLEXIBLE" as const, endsAt: null, deadlineAt: "2026-11-18T20:00:00.000Z", recurrence: { every: "DAY" as const, until: "2026-11-20" } };
    expect(appointmentOccurrence(flexible, at("2026-11-18T21:00:00Z")).deadlineAt).toBe("2026-11-19T20:00:00.000Z");
    expect(appointmentOverdue(flexible, at("2026-11-19T19:00:00Z"))).toBe(false);
    const once = { ...efStart, recurrence: null };
    expect(appointmentOccurrence(once, at("2026-11-26T00:00:00Z"))).toBe(once);
    expect(appointmentOverdue(once, at("2026-11-19T00:00:00Z"))).toBe(true);
  });

  it("takes only a DAY or WEEKDAY rule with a YYYY-MM-DD last day", () => {
    const row = { id: "a", ownerUserId: "u", title: "t", kind: "CALL", location: null, notes: null, sourceRef: null, format: null, remindersSent: [],
      createdAt: efStart.startsAt, updatedAt: efStart.startsAt, ...efStart };
    expect(appointmentSchema.safeParse(row).success).toBe(true);
    expect(appointmentSchema.safeParse({ ...row, recurrence: { every: "WEEK", until: "2026-11-24" } }).success).toBe(false);
    expect(appointmentSchema.safeParse({ ...row, recurrence: { every: "DAY", until: "24/11/2026" } }).success).toBe(false);
  });
});
