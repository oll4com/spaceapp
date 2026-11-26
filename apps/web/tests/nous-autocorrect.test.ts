import { describe, expect, it } from "vitest";
import { applyCorrection, autocorrect, undoCorrection, type DesktopSpell } from "../src/features/nous/nous-autocorrect.js";

const dict: Record<string, string[]> = { teh: ["the"], μερα: ["μέτρα", "μέρα"], καλημερα: ["καλήμερα", "καλημέρα"], ποτε: ["πότε", "ποτέ"], recieve: ["receive"], qwzx: ["quiz"], nous: ["nose"] };
const spell: DesktopSpell = { isMisspelled: (w) => w.toLowerCase() in dict, suggestions: (w) => dict[w.toLowerCase()] ?? [] };
const type = (text: string, kept = new Set<string>()) => {
  const c = autocorrect(text, text.length, spell, kept);
  return c ? { c, ...applyCorrection(text, c) } : null;
};

describe("Nous autocorrect (Gboard-like)", () => {
  it("corrects the word before a space or punctuation, Greek and English alike", () => {
    expect(type("see teh ")?.text).toBe("see the ");
    expect(type("καλη μερα,")?.text).toBe("καλη μέρα,");
    expect(type("I recieve.")?.caret).toBe("I receive.".length);
  });

  it("leaves correct words, words mid-typing, far guesses, links and names alone", () => {
    expect(type("hello ")).toBeNull();
    expect(type("teh")).toBeNull();
    expect(type("qwzx ")).toBeNull();
    expect(type("https://x.io/teh ")).toBeNull();
    expect(type("myTeh ")).toBeNull();
    expect(type("teh ", new Set(["teh"]))).toBeNull();
  });

  it("puts a missing Greek accent first and never guesses between two stresses", () => {
    expect(type("μερα ")?.c.replacement).toBe("μέρα");
    expect(type("καλημερα ")).toBeNull();
    expect(type("ποτε;")).toBeNull();
  });

  it("Backspace right after a correction brings the typed word back, keeping the space", () => {
    const r = type("see teh ")!;
    expect(undoCorrection(r.text, r.caret, r.c)).toEqual({ text: "see teh ", caret: 8 });
    expect(undoCorrection(r.text + "x", r.caret + 1, r.c)).toBeNull();
    expect(undoCorrection(r.text, r.caret - 1, r.c)).toBeNull();
  });
});
