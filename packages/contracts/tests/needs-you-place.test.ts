import { describe, expect, it } from "vitest";
import { needsYouGroup, needsYouPlace, type SpaceNotification } from "../src/index.js";

type Card = Parameters<typeof needsYouPlace>[0];
const card = (over: Partial<Pick<SpaceNotification, "source" | "kind" | "link" | "payload">>): Card => ({
  source: "AGENT", kind: "NEEDS_YOU", title: "Iris needs you", body: "Install 0.2.13 on the phone", link: { roomId: "room:a", paneId: "pane:iris" }, payload: {}, ...over
});
const ask = (extra: Record<string, unknown> = {}) => ({ question: "Did it install?", options: ["Go now", "Failed", "Need links/steps"], recommended: "Go now", answer: { kind: "PANE" }, ...extra });

// Plan clipboard:ytwWl09xNH0Z (operator 3/11 19:25 and 19:30 BKK): where the operator does what a card asks decides its buttons.
describe("needsYouPlace", () => {
  it("puts the 0.2.13 phone card off Space: an agent's card on a CLI pane with no page and no target", () => {
    const phone = card({ payload: { paneMode: "TERMINAL", ask: ask() } });
    expect(needsYouPlace(phone)).toBe("OFF_SPACE");
    expect(needsYouGroup(phone)).toBe("OFF_SPACE");
    // The pane's mode the caller knows wins over the stamped one.
    expect(needsYouPlace(card({ payload: { ask: ask() } }), "TERMINAL")).toBe("OFF_SPACE");
  });
  it("answers a value the card asks for here (operator 4/11 18:42 BKK: a phone number), wherever its pane is", () => {
    const value = { question: "Which phone goes on Form A?", answerKind: "text", answer: { kind: "NOUS" } };
    expect(needsYouPlace(card({ source: "NOUS", kind: "NEEDS_HANDS", payload: { paneMode: "TERMINAL", ask: value } }))).toBe("HERE");
    expect(needsYouGroup(card({ source: "NOUS", kind: "NEEDS_HANDS", payload: { paneMode: "BROWSER", ask: value } }))).toBe("QUESTIONS");
  });
  it("keeps a hands card in a pane when it names a page or a browser holds it", () => {
    expect(needsYouPlace(card({ link: { roomId: "room:a", paneId: "pane:iris", target: "url:https://www.upwork.com/nx/signup" }, payload: { paneMode: "TERMINAL" } }))).toBe("PANE");
    expect(needsYouPlace(card({ payload: { paneMode: "TERMINAL", browserPage: { roomId: "room:a", paneId: "pane:bob", target: "tab:p1" } } }))).toBe("PANE");
    expect(needsYouPlace(card({ source: "NOUS", kind: "NEEDS_HANDS", payload: { paneMode: "BROWSER" } }))).toBe("PANE");
    // A card raised before the mode was stamped keeps its Go.
    expect(needsYouPlace(card({ payload: {} }))).toBe("PANE");
  });
  it("sends handoffs and sign-ins to the pane, and answers questions, reviews and rules here", () => {
    expect(needsYouPlace(card({ source: "BROWSER_HANDOFF", kind: "BROWSER_HANDOFF_REQUESTED" }))).toBe("PANE");
    expect(needsYouPlace(card({ source: "JOB_COPILOT", kind: "SIGN_IN" }))).toBe("PANE");
    const question = card({ source: "JOB_COPILOT", kind: "QUESTION", payload: { ask: { question: "Grade?", answer: { kind: "COPILOT_QUESTION" } } } });
    expect(needsYouPlace(question)).toBe("HERE");
    expect(needsYouGroup(question)).toBe("QUESTIONS");
    expect(needsYouGroup(card({ source: "MAIL_COPILOT", kind: "REVIEW_REQUESTED", payload: { ask: { question: "Send it?", options: ["Approve", "Decline"], answer: { kind: "COPILOT_DECISION" } } } }))).toBe("APPROVALS");
    expect(needsYouGroup(card({ source: "DESIGN", kind: "DESIGN_APPROVAL" }))).toBe("APPROVALS");
    expect(needsYouGroup(card({ source: "BROWSER_HANDOFF", kind: "BROWSER_HANDOFF_REQUESTED" }))).toBe("PANE");
  });
  it("answers an agent's or Nous's own question here, wherever it was raised: its options are not the default Go now set", () => {
    const colour = ask({ options: ["Red", "Blue"], recommended: "Blue" });
    expect(needsYouPlace(card({ payload: { paneMode: "TERMINAL", ask: colour } }))).toBe("HERE");
    expect(needsYouGroup(card({ link: { roomId: "room:a", paneId: "pane:iris", target: "url:https://example.com" }, payload: { paneMode: "BROWSER", ask: colour } }))).toBe("QUESTIONS");
    expect(needsYouPlace(card({ source: "NOUS", kind: "NEEDS_HANDS", link: { target: "thread:me@x.com:1a" }, payload: { ask: ask({ options: ["Done", "Need links/steps"], recommended: "Done" }) } }))).toBe("HERE");
  });
});
