import type { NousDecision, SpaceNotification } from "@space/contracts";

/**
 * Goal 7365014c (zero approvals by 30/11, learn from every yes and no): how often the operator answered as Nous predicted. A decision's
 * prediction is the «Πρόβλεψη: ναι (90%)» / "Prediction: no" line of its recommendation or body; a card's is its ask's recommended option.
 */
export function decisionPrediction(decision: Pick<NousDecision, "recommendation" | "body">): "APPROVE" | "DECLINE" | null {
  const word = /(?:Πρόβλεψη|Prediction)\s*:\s*([^\s(.,;:]+)/iu.exec(`${decision.recommendation ?? ""}\n${decision.body ?? ""}`)?.[1]?.toLowerCase();
  if (!word) return null;
  if (/^(?:ναι|yes|approve|έγκριση)/u.test(word)) return "APPROVE";
  return /^(?:όχι|οχι|no|decline|απόρριψη)/u.test(word) ? "DECLINE" : null;
}

export interface PredictionScore { matched: number; total: number }

/** Decisions answered since `since` by the operator (not an "Always approve" or away grant) and Nous's cards answered since then. */
export function predictionAccuracy(decisions: NousDecision[], cards: SpaceNotification[], since: string): { decisions: PredictionScore; cards: PredictionScore } {
  const scored = { decisions: { matched: 0, total: 0 }, cards: { matched: 0, total: 0 } };
  for (const decision of decisions) {
    if ((decision.answeredAt ?? "") < since || !["APPROVED", "DECLINED", "ANSWERED"].includes(decision.status)) continue;
    if (/^Approved by (?:your "Always approve"|away grant)/.test(decision.answer ?? "")) continue;
    const predicted = decisionPrediction(decision);
    if (!predicted) continue;
    scored.decisions.total += 1;
    if (decision.status === (predicted === "APPROVE" ? "APPROVED" : "DECLINED")) scored.decisions.matched += 1;
  }
  for (const card of cards) {
    const recommended = (card.payload.ask as { recommended?: unknown } | undefined)?.recommended;
    const answer = card.payload.answer as { text?: unknown; at?: unknown; by?: unknown } | undefined;
    // Space's own answer on "Always answer like this" (7365014c-d) is not the operator's.
    if (typeof recommended !== "string" || typeof answer?.text !== "string" || String(answer.at ?? card.updatedAt) < since || answer.by === "ALWAYS") continue;
    scored.cards.total += 1;
    if (answer.text.trim() === recommended) scored.cards.matched += 1;
  }
  return scored;
}

export const predictionText = ({ matched, total }: PredictionScore) => total ? `${matched} of ${total} as predicted (${Math.round((100 * matched) / total)}%)` : "none to score";
