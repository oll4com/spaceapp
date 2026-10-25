import { describe, expect, it } from "vitest";
import { textToSend } from "../src/features/keyboard-autocorrect/send-layout.js";

const on = { enabled: true, supportedLanguages: ["el", "en"] };

describe("text a chat dock sends", () => {
  it("keeps Latin words inside Greek text as typed", () => {
    for (const text of ["ξεκίνησε μουσική στο youtube", "κλείσε τον Bob", "@Dana τρέξε τα tests"]) expect(textToSend(text, on)).toBe(text);
  });

  it("converts text typed wholly in the wrong layout, only with autocorrect on for Greek", () => {
    expect(textToSend("  veltiose mou ", on)).toBe("βελτίωσε μου");
    expect(textToSend("veltiose mou", { ...on, enabled: false })).toBe("veltiose mou");
    expect(textToSend("veltiose mou", { ...on, supportedLanguages: ["en"] })).toBe("veltiose mou");
  });

  it("leaves English, and spelling proposals that need confirmation, as typed", () => {
    expect(textToSend("open two codex panes", on)).toBe("open two codex panes");
    expect(textToSend("keybaord", on)).toBe("keybaord");
  });
});
