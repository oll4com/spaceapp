import { describe, expect, it } from "vitest";
import { decideStreamingModeration, isModerationCandidate } from "../src/moderation.js";

describe("streaming moderation policy", () => {
  it("does not punish criticism, capitals, or an isolated swear", () => {
    for (const message of ["THIS STREAM IS BORING", "I disagree with the streamer", "damn, that was bad"]) {
      expect(decideStreamingModeration({ message, previousStrikes: 0, protectedAccount: false }).decision).toBe("ALLOW");
    }
  });
  it("uses warning, five minutes, then thirty minutes for repeated abuse", () => {
    expect([0, 1, 2].map(previousStrikes => decideStreamingModeration({ message: "abusive message", previousStrikes, protectedAccount: false, jevVerdict: "ABUSE" }).decision))
      .toEqual(["WARN", "TIMEOUT_5M", "TIMEOUT_30M"]);
  });
  it("applies the same escalation to clear targeted insults if Jev is unavailable", () => {
    expect([0, 1, 2].map(previousStrikes => decideStreamingModeration({ message: "You're an idiot", previousStrikes, protectedAccount: false }).decision))
      .toEqual(["WARN", "TIMEOUT_5M", "TIMEOUT_30M"]);
    expect(decideStreamingModeration({ message: "Είσαι ηλίθιος", previousStrikes: 0, protectedAccount: false }).decision).toBe("WARN");
    expect(decideStreamingModeration({ message: "You're an idiot", previousStrikes: 0, protectedAccount: false, jevVerdict: "SAFE" }).decision).toBe("ALLOW");
  });
  it("reserves uncertain cases for review and protects operator/moderator accounts", () => {
    expect(decideStreamingModeration({ message: "maybe abuse", previousStrikes: 0, protectedAccount: false, jevVerdict: "AMBIGUOUS" }).decision).toBe("REVIEW");
    expect(decideStreamingModeration({ message: "I will kill you", previousStrikes: 0, protectedAccount: true, jevVerdict: "SEVERE" }).decision).toBe("ALLOW");
  });
  it("applies a thirty minute timeout to explicit threats without Jev", () => {
    expect(decideStreamingModeration({ message: "I will kill you", previousStrikes: 0, protectedAccount: false })).toMatchObject({ decision: "TIMEOUT_30M", durationSeconds: 1800 });
  });
  it("matches accents, final sigma, curly apostrophes and spoken contractions", () => {
    const decide = (message: string) => decideStreamingModeration({ message, previousStrikes: 0, protectedAccount: false }).decision;
    expect(decide("ΕΙΣΑΙ ΗΛΙΘΙΟΣ")).toBe("WARN");
    expect(decide("εισαι αχρηστος")).toBe("WARN");
    expect(decide("You\u2019re an idiot")).toBe("WARN");
    expect(decide("I'm gonna kill you")).toBe("TIMEOUT_30M");
    expect(decide("i am going to hurt the streamer")).toBe("TIMEOUT_30M");
    expect(decide("Θα σε βρω και θα σε κανονίσω")).toBe("TIMEOUT_30M");
    expect(decide("θα σου κάνω κακό")).toBe("TIMEOUT_30M");
  });
  it("sends every policy phrase through the pre-filter and leaves ordinary chat alone", () => {
    for (const message of ["Είσαι άχρηστος", "ΗΛΙΘΙΕ", "θα σε βρω", "I\u2019ll kill you", "here is your address", "βρήκα τη διεύθυνσή σου"]) {
      expect(isModerationCandidate(message), message).toBe(true);
    }
    for (const message of ["great stream!", "τι ώρα είναι το επόμενο live;", "what model is this?"]) {
      expect(isModerationCandidate(message), message).toBe(false);
    }
  });
});
