import { describe, expect, it } from "vitest";
import { labelIds } from "../src/features/nous/needs-you-ids.js";

// Operator 1/11 23:08 BKK: a Needs you card read "flq:U-Ji6bd-RQ2e" with no word of what it was.
describe("Needs you ids read as what they name", () => {
  it("names each id in the operator's language and keeps what the operator types or opens", () => {
    const text = "Answer flq:U-Ji6bd-RQ2e for Dana (pane:_P48qtXe8CPf) before plan clipboard:1cZ-YxU8zS2O; mailrev:AJYxemplyr0e waits. Approve data delete on qm:105?";
    expect(labelIds(text, "el")).toBe("Answer ερώτηση freelance for Dana before plan; email για έλεγχο waits. Approve data delete on VM 105?");
    expect(labelIds(text, "en")).toBe("Answer Freelance question for Dana before plan; mail review waits. Approve data delete on VM 105?");
    // A word that already names the id keeps the sentence (the translation keeps the id after its Greek noun).
    expect(labelIds("Απάντησε στην ερώτηση flq:U-Ji6bd-RQ2e του πλάνου clipboard:1cZ-YxU8zS2O.", "el")).toBe("Απάντησε στην ερώτηση του πλάνου.");
    // Tickets, code, links and unknown prefixes stay as written.
    const kept = "Run `space-queue approve q-20261101-175041-f9b4` for flq:U-Ji6bd-RQ2e, see https://example.com/x?pane=pane:abcdefgh and note:abcdefghij.";
    expect(labelIds(kept, "el")).toBe("Run `space-queue approve q-20261101-175041-f9b4` for ερώτηση freelance, see https://example.com/x?pane=pane:abcdefgh and note:abcdefghij.");
    expect(labelIds("Run `qm destroy 207` on pct:210", "el")).toBe("Run `qm destroy 207` on CT 210");
  });
});
