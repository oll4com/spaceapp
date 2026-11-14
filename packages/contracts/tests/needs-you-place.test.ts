import { describe, expect, it } from "vitest";
import { needsYouGroup, needsYouLayout, needsYouPlace, type SpaceNotification } from "../src/index.js";

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
  it("offers no Go on a Nous card with no pane, surface or plan (operator 13/11 nous_msg:0fa7d370: Go only reopened Needs you)", () => {
    expect(needsYouPlace(card({ source: "NOUS", kind: "NEEDS_HANDS", link: { roomId: "room:a" }, payload: {} }))).toBe("OFF_SPACE");
    expect(needsYouPlace(card({ source: "NOUS", kind: "NEEDS_HANDS", link: { roomId: "room:a" }, payload: { planId: "clipboard:plan0001" } }))).toBe("PANE");
    expect(needsYouPlace(card({ source: "NOUS", kind: "NEEDS_HANDS", link: { surface: "nous" }, payload: {} }))).toBe("PANE");
    expect(needsYouPlace({ ...card({ source: "NOUS", kind: "NEEDS_HANDS", link: {}, payload: {} }), paneId: "pane:iris" } as Card)).toBe("PANE");
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

// Plan clipboard:T2uboz26Oh3q §6 / S8: one layout per pane kind, from the record alone.
describe("needsYouLayout", () => {
  const decide = { question: "Send it?", options: ["Approve", "Decline"], answer: { kind: "COPILOT_DECISION" } };
  it("gives hands cards HANDS, wherever their pane is", () => {
    expect(needsYouLayout(card({ source: "BROWSER_HANDOFF", kind: "BROWSER_HANDOFF_REQUESTED" }))).toBe("HANDS");
    expect(needsYouLayout(card({ payload: { paneMode: "TERMINAL", ask: ask() } }))).toBe("HANDS");
    // A design pane's sign-in is hands, not a visual card.
    expect(needsYouLayout(card({ source: "DESIGN", kind: "SIGN_IN" }))).toBe("HANDS");
  });
  it("gives Security and Monitoring cards SECURITY, their reviews too", () => {
    expect(needsYouLayout(card({ source: "SECURITY_COPILOT", kind: "SECURITY_REVIEW", payload: { ask: decide } }))).toBe("SECURITY");
    expect(needsYouLayout(card({ source: "MONITORING_COPILOT", kind: "MONITORING_QUESTION", payload: { ask: { question: "Mute it?", answer: { kind: "COPILOT_QUESTION" } } } }))).toBe("SECURITY");
  });
  it("gives a studio's card, or options naming files, VISUAL", () => {
    expect(needsYouLayout(card({ source: "DESIGN", kind: "DESIGN_APPROVAL" }))).toBe("VISUAL");
    expect(needsYouLayout(card({ source: "VIDEO", kind: "VIDEO_QUESTION", payload: { ask: { question: "Which cut?", answer: { kind: "COPILOT_QUESTION" } } } }))).toBe("VISUAL");
    const variants = { question: "Which logo?", options: ["A: artifact:varA000001", "B: artifact:varB000001"], answer: { kind: "NOUS" } };
    expect(needsYouLayout(card({ source: "NOUS", kind: "NEEDS_HANDS", payload: { paneMode: "TERMINAL", ask: variants } }))).toBe("VISUAL");
  });
  it("gives approvals REVIEW and every other card QUESTION", () => {
    expect(needsYouLayout(card({ source: "MARKETING_COPILOT", kind: "REVIEW_REQUESTED", payload: { ask: decide, review: { id: "post:1", channel: "X", text: "Hi" } } }))).toBe("REVIEW");
    expect(needsYouLayout(card({ source: "MAIL_COPILOT", kind: "REVIEW_REQUESTED", payload: { ask: decide } }))).toBe("REVIEW");
    expect(needsYouLayout(card({ source: "JOB_COPILOT", kind: "QUESTION", payload: { ask: { question: "Grade?", answer: { kind: "COPILOT_QUESTION" } } } }))).toBe("QUESTION");
    expect(needsYouLayout(card({ source: "NOUS", kind: "NEEDS_HANDS", payload: { ask: { question: "Tonight?", options: ["Tonight", "Tomorrow"], answer: { kind: "NOUS" } } } }))).toBe("QUESTION");
  });
});
