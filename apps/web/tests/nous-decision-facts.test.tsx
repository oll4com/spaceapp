// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ChatMarkdown } from "../src/features/agent-pane/ChatMarkdown.js";
import { decisionMarkdown } from "../src/features/nous/NousNeedsYou.js";
import { uiServerText } from "../src/features/ui-language/ui-language.js";

afterEach(cleanup);

// Stable 1/11 (nous_msg:40900116, Kate's proof): a decision card in Needs you showed the lines Space writes above its body in English, run
// together as one paragraph. Stored records carry them unprefixed and joined by single line breaks; new ones as "- " items.
const stored = [
  "Vault: 2 logins for partner.example: Partner (a@example.com), Partner 2",
  "Sign-ins for partner.example: OTHER (0 successful)",
  "Sign-ins for shop.example: GOOGLE with a@example.com (3 successful); PASSWORD as admin (1 successful)",
  "Sign-ins for new.example: Space never signed in there (do not call it an existing account)",
  "Connected Google accounts: a@example.com, b@example.com",
  "",
  "- Mail from partner.example in 30 days: a@example.com: 2 threads, newest 2026-10-28 \"Re: Partner\"",
  "- Mail with c@gmail.com in 30 days: none",
  "- Mail from quiet.example in 30 days: unknown (the mail read failed)",
  "",
  "Send the three partner applications."
].join("\n");

describe("Space's lines on a Nous decision (nous_msg:40900116)", () => {
  it("drops the account facts (Nous's, never the operator's: 2/11 09:49 BKK) and shows one line per mail fact, in the operator's language", () => {
    const { container } = render(<ChatMarkdown content={decisionMarkdown("el", stored)} />);
    const items = [...container.querySelectorAll("li")].map((item) => item.textContent?.trim());
    expect(container.textContent).not.toContain("@example.com");
    expect(items).toEqual([
      "Αλληλογραφία από partner.example τις τελευταίες 30 ημέρες: 2 νήματα σε συνδεδεμένο γραμματοκιβώτιο, νεότερο 2026-10-28 \"Re: Partner\"",
      "Αλληλογραφία με c@gmail.com τις τελευταίες 30 ημέρες: καμία",
      "Αλληλογραφία από quiet.example τις τελευταίες 30 ημέρες: άγνωστο (η ανάγνωση της αλληλογραφίας απέτυχε)"
    ]);
    // Nous's own text stays as written, outside the list.
    expect([...container.querySelectorAll("p")].at(-1)?.textContent).toBe("Send the three partner applications.");
  });

  it("keeps English as written, one line per fact", () => {
    const { container } = render(<ChatMarkdown content={decisionMarkdown("en", stored)} />);
    expect(container.querySelectorAll("li")).toHaveLength(3);
    expect(container.querySelector("li")?.textContent?.trim()).toBe("Mail from partner.example in 30 days: 2 threads in a connected mailbox, newest 2026-10-28 \"Re: Partner\"");
  });

  it("translates the same lines on Nous's cards (• items under Space's account facts)", () => {
    expect(uiServerText("el", "Space's account facts:\n• Vault: 1 login for upwork.com: Upwork\n• Connected Google accounts: a@example.com"))
      .toBe("Στοιχεία λογαριασμών του Space:\n• Vault: 1 σύνδεση για το upwork.com: Upwork\n• Συνδεδεμένοι λογαριασμοί Google: a@example.com");
  });
});
