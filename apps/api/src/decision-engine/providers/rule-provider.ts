import type { JevDecideInput, JevDecideResult } from "@space/contracts";
import type { DecisionProvider } from "../types.js";

export class RuleDecisionProvider implements DecisionProvider {
  readonly id = "rule";
  readonly name = "Local Deterministic Rule Provider";

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async decide(request: JevDecideInput): Promise<JevDecideResult> {
    const answers: Record<string, unknown> = {};
    const stateStr = typeof request.state === "string" ? request.state : JSON.stringify(request.state);

    for (const [key, q] of Object.entries(request.questions)) {
      if (q.type === "noul") {
        const lower = stateStr.toLowerCase();
        let val = 0.1;
        if (key === "is_destructive") {
          val = /rm\s+-r|drop\s+table|mkfs|truncate\s+table|delete\s+from|git\s+reset\s+--hard/i.test(lower) ? 0.95 : 0.05;
        } else if (key === "has_silent_failure") {
          val = /traceback|fatal error|unhandled rejection|panic:|econnrefused/i.test(lower) ? 0.95 : 0.05;
        } else if (key === "needs_browser") {
          val = /https?:\/\/|browser|navigate|playwright|chrome|screenshot/i.test(lower) ? 0.9 : 0.05;
        }
        answers[key] = { noul: val };
      } else if (q.type === "choice") {
        const options = Object.keys(q.criteria);
        answers[key] = { choice: options[0] ?? null };
      } else if (q.type === "score") {
        answers[key] = { score: 3 };
      }
    }

    return {
      available: true,
      answers,
      model: "rule-deterministic-v1",
      usage: { inputTokens: 0, outputTokens: 0, cost: 0 },
      latencyMs: 1
    };
  }
}
