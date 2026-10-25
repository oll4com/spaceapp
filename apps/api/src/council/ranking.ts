import {
  COUNCIL_CLAIM_MAX_CHARS, COUNCIL_MAX_CLAIMS, COUNCIL_TOP,
  type CouncilPosition, type CouncilRankingEntry, type CouncilReview
} from "@space/contracts";

/** A reviewer agrees with a position when it scores it 7 or more. */
export const COUNCIL_AGREE_SCORE = 7;
/** A position reaches the Top 3 first when at least two thirds of the reviewers agree with it. */
export const COUNCIL_QUALIFY_SHARE = 2 / 3;

const round2 = (value: number) => Math.round(value * 100) / 100;

/**
 * Deterministic consensus: the mean score, the share of reviewers scoring 7+, and the spread of the scores.
 * Qualified positions come first, then a higher mean, a smaller spread, and more independent answers behind it.
 */
export function rankCouncilPositions(positions: readonly CouncilPosition[], reviews: readonly CouncilReview[]): CouncilRankingEntry[] {
  const done = reviews.filter((review) => review.status === "DONE");
  const support = new Map(positions.map((position) => [position.id, position.support]));
  return positions.map((position) => {
    const scores = done.flatMap((review) => review.scores.find((score) => score.positionId === position.id)?.score ?? []);
    const count = scores.length;
    const mean = count ? scores.reduce((sum, score) => sum + score, 0) / count : 0;
    const agreeShare = count ? scores.filter((score) => score >= COUNCIL_AGREE_SCORE).length / count : 0;
    const spread = count ? Math.sqrt(scores.reduce((sum, score) => sum + (score - mean) ** 2, 0) / count) : 0;
    return { positionId: position.id, mean: round2(mean), agreeShare: round2(agreeShare), spread: round2(spread), reviewers: count,
      qualified: count > 0 && agreeShare >= COUNCIL_QUALIFY_SHARE - 1e-9 };
  }).sort((left, right) => Number(right.qualified) - Number(left.qualified) || right.mean - left.mean || left.spread - right.spread
    || (support.get(right.positionId) ?? 0) - (support.get(left.positionId) ?? 0)
    || left.positionId.localeCompare(right.positionId, undefined, { numeric: true }));
}

/**
 * The answers the council agreed on: qualified positions only, at most `count`. When nothing qualified, the best one
 * alone, so the final answer still leads with something and says the agreement was weak.
 */
export function councilTopEntries(ranking: readonly CouncilRankingEntry[], count = COUNCIL_TOP): CouncilRankingEntry[] {
  const agreed = ranking.filter((entry) => entry.qualified).slice(0, count);
  return agreed.length ? agreed : ranking.slice(0, 1);
}

/** The Top 3 all reached the plan's agreement target, so another review round would add little. */
export function councilAgreementReached(ranking: readonly CouncilRankingEntry[], target: number): boolean {
  const top = ranking.slice(0, COUNCIL_TOP);
  return top.length > 0 && top.every((entry) => entry.reviewers > 0 && entry.agreeShare >= target - 1e-9);
}

/** "8.4/10 · 5 of 6 agree": the line the final answer quotes for a Top-3 position. */
export function consensusLine(entry: CouncilRankingEntry): string {
  const agree = Math.round(entry.agreeShare * entry.reviewers);
  return `${entry.mean.toFixed(1)}/10 · ${agree} of ${entry.reviewers} agree`;
}

export const clip = (text: string, max: number) => text.length > max ? `${text.slice(0, Math.max(0, max - 1))}…` : text;

const MODEL_NAMES = /\b(?:anthropic|claude(?:\s+code)?|opus|sonnet|haiku|fable|openai|chat\s?gpt|gpt[-\s]?[0-9][\w.-]*|codex|astra|gemini|google\s+deepmind|deepmind|bard|deepseek|qwen|kimi|grok|llama|mistral|opencode)\b/gi;

/** Removes who-wrote-it hints ("As Claude, …") so the merge and the reviews stay anonymous. */
export function anonymizeModelText(text: string): string {
  return text.replace(MODEL_NAMES, "a model");
}

/** Email addresses and phone numbers never leave in the coordinator's draft of the personal context. */
export function scrubContactDetails(text: string): string {
  return text
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email removed]")
    .replace(/\+?\d(?:[\s.()-]?\d){9,13}/g, (match) => (match.replace(/\D/g, "").length >= 10 ? "[phone removed]" : match));
}

/** Short claims from a free-text answer when a model did not return them: its first bullet points or sentences. */
export function deriveClaims(text: string): string[] {
  const lines = text.split(/\n+/).map((line) => line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "").replace(/[#*_`]/g, "").trim()).filter((line) => line.length >= 12);
  const pieces = lines.length >= 2 ? lines : text.split(/(?<=[.!;])\s+/).map((sentence) => sentence.trim()).filter((sentence) => sentence.length >= 12);
  return pieces.slice(0, COUNCIL_MAX_CLAIMS).map((piece) => clip(piece, COUNCIL_CLAIM_MAX_CHARS));
}

/** Fisher-Yates with an injectable random source, so tests can fix the order. */
export function shuffled<T>(items: readonly T[], random: () => number = Math.random): T[] {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const other = Math.floor(random() * (index + 1));
    [copy[index], copy[other]] = [copy[other]!, copy[index]!];
  }
  return copy;
}
