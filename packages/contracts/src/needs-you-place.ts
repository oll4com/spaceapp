import { NEEDS_YOU_GO_NOW, needsYouAsk, needsYouHasPlace, type SpaceNotification } from "./notifications.js";

/**
 * Where the operator does what a needs-you card asks (plan clipboard:ytwWl09xNH0Z, operator 3/11 19:25 and 19:30 BKK: a phone-only update card
 * moved his screen to an unrelated browser). OFF_SPACE: on his phone, by mail he sends, in real life; answered on the card ("Done, all good" /
 * "There is a problem"), never a Go. HERE: a question, decision or approval answered on the card. PANE: his hands in a pane (a sign-in, a
 * CAPTCHA, a browser handoff, a page that waits for him); the only cards with Go, and only when he clicks it. Derived from the record alone.
 */
export type NeedsYouPlace = "OFF_SPACE" | "HERE" | "PANE";
/** The Needs you list's groups, in this order (design.md §3.3). */
export const NEEDS_YOU_GROUPS = ["OFF_SPACE", "QUESTIONS", "APPROVALS", "PANE"] as const;
export type NeedsYouGroup = (typeof NEEDS_YOU_GROUPS)[number];

type Card = Pick<SpaceNotification, "source" | "kind" | "title" | "body" | "link" | "payload">;
const HANDS_KINDS = /HANDOFF|SIGN_IN|LOGIN|CAPTCHA/i;
const APPROVAL_KINDS = /REVIEW|APPROVAL|RULE_PROPOSED|CAMPAIGN/;

export function needsYouPlace(card: Card, paneMode?: string | null): NeedsYouPlace {
  if (card.source === "BROWSER_HANDOFF" || HANDS_KINDS.test(card.kind)) return "PANE";
  if ((card.source === "NOUS" && card.kind === "NEEDS_HANDS") || (card.source === "AGENT" && card.kind === "NEEDS_YOU")) {
    // Its own answers (not the default Go now / Failed / Need links/steps) make it a question answered here, wherever it was raised.
    const ask = needsYouAsk(card);
    const options = ask.options ?? [];
    // A value to type (operator 4/11 18:42 BKK: a phone number) is answered here too.
    if (ask.answerKind === "text" || (options.length && !options.includes(NEEDS_YOU_GO_NOW))) return "HERE";
    return needsYouHasPlace(card, paneMode) ? "PANE" : "OFF_SPACE";
  }
  return "HERE";
}

export function needsYouGroup(card: Card, paneMode?: string | null): NeedsYouGroup {
  const place = needsYouPlace(card, paneMode);
  if (place !== "HERE") return place;
  return needsYouAsk(card).answer.kind === "COPILOT_DECISION" || APPROVAL_KINDS.test(card.kind) ? "APPROVALS" : "QUESTIONS";
}
