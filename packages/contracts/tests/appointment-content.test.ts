import { describe, expect, it } from "vitest";
import { appointmentContentMissing, appointmentHoursOf, appointmentHoursSchema, appointmentJoinUrl, appointmentOutOfHours, appointmentScheduleMissing, appointmentSections,
  appointmentWithinHours } from "../src/appointment-content.js";

const BKK = { start: "11:00", end: "20:00", timeZone: "Asia/Bangkok" };

// Operator 4/11 14:39 BKK (nous_msg:a60162597d984866b79b9a2f): what every upcoming appointment must hold, read from its notes' sections.
describe("appointment content", () => {
  it("reads Greek or English headings in any case and keeps the lines under each", () => {
    const sections = appointmentSections("Intro line\nΤι είναι: webinar\nnot a test\nhttps://x.test: not a heading\nΕίσοδος: https://x.test\nΛογαριασμός: lab@example.invalid");
    expect(sections).toEqual([{ key: null, heading: null, text: "Intro line" }, { key: "what", heading: "Τι είναι", text: "webinar\nnot a test\nhttps://x.test: not a heading" },
      { key: "join", heading: "Είσοδος", text: "https://x.test\nΛογαριασμός: lab@example.invalid" }]);
  });

  it("names every missing section, an empty one and a join without its account; closed ones need none", () => {
    const full = "WHAT IT IS: a call\nHOW TO JOIN: https://meet.google.com/x (no sign-in)\nWHY IT MATTERS: stage 1\nWHAT YOU NEED: a headset\nSOURCE: task:abc";
    expect(appointmentContentMissing({ status: "UPCOMING", notes: full })).toEqual([]);
    expect(appointmentContentMissing({ status: "UPCOMING", notes: full.replace("WHY IT MATTERS: stage 1", "WHY IT MATTERS:") })).toEqual(["WHY IT MATTERS"]);
    expect(appointmentContentMissing({ status: "UPCOMING", notes: full.replace(" (no sign-in)", "") })).toEqual(["the account HOW TO JOIN signs in with (or \"no sign-in\")"]);
    expect(appointmentContentMissing({ notes: null })).toHaveLength(5);
    expect(appointmentContentMissing({ status: "DONE", notes: null })).toEqual([]);
    expect(appointmentContentMissing({ status: "CANCELLED", notes: "one line" })).toEqual([]);
  });

  it("needs an online one's location to start with its join link; a phone or place may be text (operator 13/11 16:00 BKK)", () => {
    const at = { status: "UPCOMING", timing: "FIXED", startsAt: "2099-11-14T05:00:00.000Z" };
    const refused = (format: string, location: string | null) => appointmentScheduleMissing({ ...at, format, location }, BKK).some((what) => what.startsWith("location"));
    for (const format of ["AI_INTERVIEW", "RECORDED_VIDEO", "LIVE_HUMAN_VIDEO", "WEBINAR", "TEST"]) {
      expect(refused(format, "Google Meet (link in the calendar invite)")).toBe(true);
      expect(refused(format, null)).toBe(true);
      expect(refused(format, "Link «Join My Webinar» στο mail https://x.test")).toBe(true);
    }
    expect(refused("WEBINAR", "https://teams.microsoft.com/l/x Meeting ID: 123 Passcode: ab")).toBe(false);
    expect(refused("AI_INTERVIEW", " https://mail.google.com/mail/u/0/#all/19a0 ")).toBe(false);
    expect(refused("PHONE", "+30 210 000 0000")).toBe(false);
    expect(refused("IN_PERSON", "Ermou 1, Athens")).toBe(false);
    expect(appointmentScheduleMissing({ ...at, status: "DONE", format: "WEBINAR", location: "in the mail" }, BKK)).toEqual([]);
  });

  // Operator 17/11 09:54 BKK (nous_msg:266ee062): strictly 11:00-20:00 Bangkok, ending by 20:00.
  it("keeps an appointment within the hours: starts at or after the start and ends by the end", () => {
    const within = (start: string, end?: string) => appointmentWithinHours({ startsAt: `2099-11-07T${start}:00+07:00`, endsAt: end ? `2099-11-07T${end}:00+07:00` : null }, BKK);
    expect(within("11:00", "11:30")).toBe(true);
    expect(within("10:59", "11:30")).toBe(false);
    expect(within("19:30", "20:00")).toBe(true);
    expect(within("19:45", "20:15")).toBe(false);
    expect(within("19:59")).toBe(true);
    expect(within("20:00")).toBe(false);
  });

  it("converts the other side's zone: 09:00 CET is 15:00 Bangkok, 14:00 CET is 20:00 Bangkok", () => {
    expect(appointmentWithinHours({ startsAt: "2099-11-07T09:00:00+01:00", endsAt: "2099-11-07T10:00:00+01:00" }, BKK)).toBe(true);
    expect(appointmentWithinHours({ startsAt: "2099-11-07T13:30:00+01:00", endsAt: "2099-11-07T14:00:00+01:00" }, BKK)).toBe(true);
    expect(appointmentWithinHours({ startsAt: "2099-11-07T14:00:00+01:00", endsAt: "2099-11-07T14:30:00+01:00" }, BKK)).toBe(false);
    // Hours set in Berlin read the same instant there.
    expect(appointmentWithinHours({ startsAt: "2099-11-07T15:00:00+07:00" }, { ...BKK, timeZone: "Europe/Berlin" })).toBe(false);
  });

  it("refuses a FLEXIBLE time outside the hours and flags a FIXED one; reads the setting with its defaults and the working zone", () => {
    const at = { status: "UPCOMING", format: "PHONE", location: "+30 210", startsAt: "2099-11-07T19:45:00+07:00", endsAt: "2099-11-07T20:15:00+07:00" };
    expect(appointmentScheduleMissing({ ...at, timing: "FLEXIBLE", deadlineAt: "2099-11-08T00:00:00Z" }, BKK))
      .toEqual(["a time within the appointment hours 11:00-20:00 Asia/Bangkok: start at or after 11:00, end by 20:00 (a FLEXIBLE one is timed by us)"]);
    expect(appointmentScheduleMissing({ ...at, timing: "FIXED" }, BKK)).toEqual([]);
    expect(appointmentOutOfHours({ ...at, kind: "CALL" }, BKK)).toContain("OUT_OF_HOURS");
    expect(appointmentOutOfHours({ ...at, kind: "DEADLINE" }, BKK)).toBeNull();
    expect(appointmentOutOfHours({ ...at, kind: "CALL", status: "DONE" }, BKK)).toBeNull();
    expect(appointmentHoursOf(undefined, "Asia/Bangkok")).toEqual(BKK);
    expect(appointmentHoursOf({ start: "09:00", end: "17:00", timeZone: "Europe/Athens" }, "Asia/Bangkok")).toEqual({ start: "09:00", end: "17:00", timeZone: "Europe/Athens" });
    expect(appointmentHoursOf({ start: "18:00", end: "09:00" }, "UTC")).toEqual({ ...BKK, timeZone: "UTC" });
    expect(appointmentHoursSchema.safeParse({ timeZone: "Mars/Base" }).success).toBe(false);
  });

  it("finds the join link in location, else in the HOW TO JOIN (ΕΙΣΟΔΟΣ) line", () => {
    expect(appointmentJoinUrl({ location: "https://meet.google.com/abc-defg-hij, then wait", notes: null })).toBe("https://meet.google.com/abc-defg-hij");
    expect(appointmentJoinUrl({ location: "Google Meet", notes: "WHAT IT IS: x\nΕΙΣΟΔΟΣ: Κουμπί στο mail (https://mail.google.com/mail/u/0/#all/19a0).\nWHY: y https://other.test" }))
      .toBe("https://mail.google.com/mail/u/0/#all/19a0");
    expect(appointmentJoinUrl({ location: "Google Meet", notes: "WHY IT MATTERS: https://other.test" })).toBeNull();
  });
});
