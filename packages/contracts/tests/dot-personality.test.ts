import { describe, expect, it } from "vitest";
import { detectPromptTone, dotMoods, dotPersonalities, dotPersonalityInstructions, dotTones } from "../src/dot-personality.js";

describe("Dot tone detection", () => {
  it.each([
    ["Could you please summarize this? Thanks!", "polite"],
    ["Σε παρακαλώ, μπορείς να μου στείλεις το αρχείο; Ευχαριστώ!", "polite"],
    ["ευχαριστω πολυ γλυκε μου", "polite"],
    ["Fix it NOW!! Why didn't you do it?", "strict"],
    ["Γιατί δεν δουλεύει; Φτιάξ' το αμέσως!!", "strict"],
    ["THIS IS WRONG", "strict"],
    ["Please stop the server, thanks", "polite"],
    ["Regarding the Q3 report: please provide a summary of the deliverables and the deadline.\n1. Scope\n2. Budget", "professional"],
    ["Σχετικά με την αναφορά: χρειάζομαι σύνοψη των παραδοτέων και την προθεσμία.", "professional"],
    ["hey lol what's up", "casual"],
    ["χαχα ρε φίλε τι λες", "casual"],
    ["ρε φίλε χαχα, τι παίζει με το git rebase; πες μου στα γρήγορα 😄", "casual"],
    ["Γιατί δεν μου έχεις εξηγήσει ακόμα τι κάνει το git rebase;;; Πες το μου ΑΜΕΣΩΣ, γρήγορα!!", "strict"],
    ["Σχετικά με τη ροή εργασίας του repository, χρειάζομαι σύνοψη για το git rebase:\n1. Τι κάνει\n2. Πότε χρησιμοποιείται\n3. Κίνδυνοι", "professional"],
    ["List the files in the repo", "neutral"],
    ["Check the API and the CLI logs", "neutral"],
    ["", "neutral"]
  ] as const)("%s → %s", (text, tone) => expect(detectPromptTone(text)).toBe(tone));
});

describe("Dot personalities", () => {
  it("gives all six characters their own personality, greeting and valid reactions", () => {
    const characters = Object.keys(dotPersonalities);
    expect(characters).toEqual(["astronaut", "star", "robot", "comet", "moon", "planet"]);
    expect(new Set(characters.map((character) => dotPersonalities[character as "star"].archetype)).size).toBe(6);
    for (const personality of Object.values(dotPersonalities)) {
      for (const tone of dotTones) expect(dotMoods).toContain(personality.reactions[tone]);
      expect(dotMoods).toContain(personality.onReply);
    }
  });

  it("answers strict users in character: Nova sweetens, Byte stays professional, Luna keeps her distance", () => {
    expect(dotPersonalities.star.reactions.strict).toBe("comforting");
    expect(dotPersonalities.robot.reactions.strict).toBe("focused");
    expect(dotPersonalities.moon.reactions.strict).toBe("cool");
    const luna = dotPersonalityInstructions("moon");
    expect(luna).toContain("Calm observer");
    expect(luna).toContain("- Strict, impatient or annoyed: Keeps a distance");
    expect(luna).toContain("never accuracy, honesty, safety or effort");
  });
});
