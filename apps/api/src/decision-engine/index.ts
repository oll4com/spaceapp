import type { JevDecideInput, JevDecideResult } from "@space/contracts";
import type { DecisionProvider, DecisionEngineOptions } from "./types.js";
import { RuleDecisionProvider } from "./providers/rule-provider.js";
import { JevDecisionProvider } from "./providers/jev-provider.js";
import { LayaDecisionProvider } from "./providers/laya-provider.js";

export * from "./types.js";
export * from "./providers/rule-provider.js";
export * from "./providers/jev-provider.js";
export * from "./providers/laya-provider.js";

export class DecisionEngine {
  private readonly providers: DecisionProvider[];

  constructor(options: DecisionEngineOptions = {}) {
    this.providers = options.providers ?? [
      new JevDecisionProvider(),
      new RuleDecisionProvider(),
      new LayaDecisionProvider()
    ];
  }

  async decide(request: JevDecideInput): Promise<JevDecideResult> {
    for (const provider of this.providers) {
      if (await provider.isAvailable()) {
        const result = await provider.decide(request);
        if (result.available) {
          return result;
        }
      }
    }
    // Final fallback to rule provider directly
    const ruleProvider = new RuleDecisionProvider();
    return ruleProvider.decide(request);
  }
}
