import { describe, expect, it } from "vitest";
import { appointmentContentMissing, appointmentSections } from "../src/appointment-content.js";

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
});
