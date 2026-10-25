export type ModerationDecision = "ALLOW" | "REVIEW" | "WARN" | "TIMEOUT_5M" | "TIMEOUT_30M";

export interface ModerationInput {
  message: string;
  previousStrikes: number;
  protectedAccount: boolean;
  jevVerdict?: "ABUSE" | "SEVERE" | "AMBIGUOUS" | "SAFE" | null;
}

export interface ModerationResult {
  decision: ModerationDecision;
  reason: "CLEAR_THREAT" | "DOXXING" | "SEVERE_ABUSE" | "REPEATED_ABUSE" | "ABUSE" | "AMBIGUOUS" | "NONE" | "PROTECTED";
  strike: boolean;
  durationSeconds: number | null;
}

/** Lowercase, no accents, final sigma as σ, curly apostrophes straight: one spelling for every policy pattern. */
export function normalizeChatText(text: string): string {
  return text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/ς/g, "σ").replace(/[\u2018\u2019\u02bc`]/g, "'").replace(/\s+/g, " ").trim();
}

// Greek has no \b in JS regexes (it is ASCII-only), so Greek patterns match substrings of the normalized text.
const clearThreatPattern = /\bi(?:'ll| will| am going to| am gonna|'m going to|'m gonna|m gonna| gonna| going to) (?:kill|murder|hurt) (?:you|u|the streamer)\b|θα σε σκοτωσω|θα σε βρω και θα σε|θα σου κανω κακο/;
const doxxingPattern = /\b(?:here is|this is|i found|i know) (?:the streamer'?s|your|his|her) (?:home )?(?:address|phone number)\b|η διευθυνση σου ειναι|το τηλεφωνο σου ειναι|βρηκα τη διευθυνση σου/;
const targetedInsultPattern = /\b(?:you are|you're|ur|u r) (?:a |an )?(?:idiot|moron|worthless)\b|εισαι (?:ηλιθιοσ|ηλιθια|αχρηστοσ|αχρηστη)/;
const candidatePattern = /\b(?:kill|murder|hurt|address|phone|idiot|moron|worthless|harass|dox|die|stupid|hate)\b|σκοτω|διευθυνσ|τηλεφων|ηλιθι|αχρηστ|μισω|θα σε βρω|θα σου κανω κακο/;

/** Cheap pre-filter: only these messages reach the policy (and Jev); it covers every policy phrase. */
export function isModerationCandidate(message: string): boolean {
  return candidatePattern.test(normalizeChatText(message));
}

/** Jev is advisory; final action and duration are always server policy. */
export function decideStreamingModeration(input: ModerationInput): ModerationResult {
  if (input.protectedAccount) return { decision: "ALLOW", reason: "PROTECTED", strike: false, durationSeconds: null };
  const text = normalizeChatText(input.message);
  const clearThreat = clearThreatPattern.test(text);
  const doxxing = doxxingPattern.test(text);
  if (clearThreat || doxxing || input.jevVerdict === "SEVERE") {
    return { decision: "TIMEOUT_30M", reason: clearThreat ? "CLEAR_THREAT" : doxxing ? "DOXXING" : "SEVERE_ABUSE", strike: true, durationSeconds: 1800 };
  }
  if (input.jevVerdict === "AMBIGUOUS") return { decision: "REVIEW", reason: "AMBIGUOUS", strike: false, durationSeconds: null };
  const targetedInsult = targetedInsultPattern.test(text);
  if (input.jevVerdict === "ABUSE" || (targetedInsult && input.jevVerdict !== "SAFE")) {
    if (input.previousStrikes >= 2) return { decision: "TIMEOUT_30M", reason: "REPEATED_ABUSE", strike: true, durationSeconds: 1800 };
    if (input.previousStrikes >= 1) return { decision: "TIMEOUT_5M", reason: "REPEATED_ABUSE", strike: true, durationSeconds: 300 };
    return { decision: "WARN", reason: "ABUSE", strike: true, durationSeconds: null };
  }
  return { decision: "ALLOW", reason: "NONE", strike: false, durationSeconds: null };
}
