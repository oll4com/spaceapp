import { describe, expect, it } from "vitest";
import { appointmentContentMissing, appointmentJoinUrl, appointmentScheduleMissing, appointmentSections } from "../src/appointment-content.js";

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
    const refused = (format: string, location: string | null) => appointmentScheduleMissing({ ...at, format, location }, "Asia/Bangkok").some((what) => what.startsWith("location"));
    for (const format of ["AI_INTERVIEW", "RECORDED_VIDEO", "LIVE_HUMAN_VIDEO", "WEBINAR", "TEST"]) {
      expect(refused(format, "Google Meet (link in the calendar invite)")).toBe(true);
      expect(refused(format, null)).toBe(true);
      expect(refused(format, "Link «Join My Webinar» στο mail https://x.test")).toBe(true);
    }
    expect(refused("WEBINAR", "https://teams.microsoft.com/l/x Meeting ID: 123 Passcode: ab")).toBe(false);
    expect(refused("AI_INTERVIEW", " https://mail.google.com/mail/u/0/#all/19a0 ")).toBe(false);
    expect(refused("PHONE", "+30 210 000 0000")).toBe(false);
    expect(refused("IN_PERSON", "Ermou 1, Athens")).toBe(false);
    expect(appointmentScheduleMissing({ ...at, status: "DONE", format: "WEBINAR", location: "in the mail" }, "Asia/Bangkok")).toEqual([]);
  });

  it("finds the join link in location, else in the HOW TO JOIN (ΕΙΣΟΔΟΣ) line", () => {
    expect(appointmentJoinUrl({ location: "https://meet.google.com/abc-defg-hij, then wait", notes: null })).toBe("https://meet.google.com/abc-defg-hij");
    expect(appointmentJoinUrl({ location: "Google Meet", notes: "WHAT IT IS: x\nΕΙΣΟΔΟΣ: Κουμπί στο mail (https://mail.google.com/mail/u/0/#all/19a0).\nWHY: y https://other.test" }))
      .toBe("https://mail.google.com/mail/u/0/#all/19a0");
    expect(appointmentJoinUrl({ location: "Google Meet", notes: "WHY IT MATTERS: https://other.test" })).toBeNull();
  });
});
