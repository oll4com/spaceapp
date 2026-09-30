import { describe, expect, it } from "vitest";
import { DecisionEngine } from "../decision-engine/index.js";
import { RuleDecisionProvider } from "../decision-engine/providers/rule-provider.js";
import { LayaDecisionProvider } from "../decision-engine/providers/laya-provider.js";

describe("DecisionEngine provider abstraction", () => {
  it("uses local RuleDecisionProvider when external providers are unavailable", async () => {
    const laya = new LayaDecisionProvider();
    const rule = new RuleDecisionProvider();
    const engine = new DecisionEngine({ providers: [laya, rule] });

    expect(await laya.isAvailable()).toBe(false);
    expect(await rule.isAvailable()).toBe(true);

    const result = await engine.decide({
      state: "rm -rf /opt/spaceapp",
      questions: {
        is_destructive: {
          type: "noul",
          instructions: "Is this destructive?"
        }
      }
    });

    expect(result.available).toBe(true);
    if (result.available) {
      expect(result.model).toBe("rule-deterministic-v1");
      expect(result.answers["is_destructive"]).toEqual({ noul: 0.95 });
    }
  });

  it("gracefully falls back when provider fails", async () => {
    const failingProvider = {
      id: "failing",
      name: "Failing Provider",
      isAvailable: async () => true,
      decide: async () => ({ available: false as const, reason: "Network timeout", degraded: true as const })
    };
    const rule = new RuleDecisionProvider();
    const engine = new DecisionEngine({ providers: [failingProvider, rule] });

    const result = await engine.decide({
      state: "cat package.json",
      questions: {
        is_destructive: {
          type: "noul",
          instructions: "Is this destructive?"
        }
      }
    });

    expect(result.available).toBe(true);
    if (result.available) {
      expect(result.model).toBe("rule-deterministic-v1");
    }
  });
});
