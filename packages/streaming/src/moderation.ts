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

/** Jev is advisory; final action and duration are always server policy. */
export function decideStreamingModeration(input: ModerationInput): ModerationResult {
  if (input.protectedAccount) return { decision: "ALLOW", reason: "PROTECTED", strike: false, durationSeconds: null };
  const text = input.message.trim();
  const clearThreat = /\b(?:i (?:will|am going to|m gonna) (?:kill|murder|hurt) you|i(?:'ll| will) (?:kill|murder) (?:the streamer|you))\b/i.test(text) ||
    /(?:θα σε σκοτώσω|θα σε βρω και θα σε|θα σου κάνω κακό)/iu.test(text);
  const doxxing = /\b(?:here is|this is|i found|i know) (?:the streamer'?s|your|his|her) (?:home )?(?:address|phone number)\b/i.test(text) ||
    /(?:η διεύθυνσή σου είναι|το τηλέφωνό σου είναι|βρήκα τη διεύθυνσή σου)/iu.test(text);
  if (clearThreat || doxxing || input.jevVerdict === "SEVERE") {
    return { decision: "TIMEOUT_30M", reason: clearThreat ? "CLEAR_THREAT" : doxxing ? "DOXXING" : "SEVERE_ABUSE", strike: true, durationSeconds: 1800 };
  }
  if (input.jevVerdict === "AMBIGUOUS") return { decision: "REVIEW", reason: "AMBIGUOUS", strike: false, durationSeconds: null };
  const targetedInsult = /\b(?:you are|you'?re) (?:a |an )?(?:idiot|moron|worthless)\b/i.test(text) ||
    /(?:είσαι|εισαι)\s+(?:ηλίθιος|ηλιθιος|ηλίθια|ηλιθια|άχρηστος|αχρηστος|άχρηστη|αχρηστη)/iu.test(text);
  if (input.jevVerdict === "ABUSE" || (targetedInsult && input.jevVerdict !== "SAFE")) {
    if (input.previousStrikes >= 2) return { decision: "TIMEOUT_30M", reason: "REPEATED_ABUSE", strike: true, durationSeconds: 1800 };
    if (input.previousStrikes >= 1) return { decision: "TIMEOUT_5M", reason: "REPEATED_ABUSE", strike: true, durationSeconds: 300 };
    return { decision: "WARN", reason: "ABUSE", strike: true, durationSeconds: null };
  }
  return { decision: "ALLOW", reason: "NONE", strike: false, durationSeconds: null };
}
