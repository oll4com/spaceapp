import type { JevDecideInput, JevDecideResult } from "@space/contracts";
import type { DecisionProvider } from "../types.js";

/**
 * Laya Decision Provider (Staging Placeholder).
 * Designed for future local ONNX/llama decision weights on host VM when allocated.
 */
export class LayaDecisionProvider implements DecisionProvider {
  readonly id = "laya";
  readonly name = "Laya Local Neural Model (Staging)";

  async isAvailable(): Promise<boolean> {
    // Staging mode: not enabled by default on public-host to preserve CPU/RAM
    return false;
  }

  async decide(_request: JevDecideInput): Promise<JevDecideResult> {
    return {
      available: false,
      reason: "Laya local neural provider is currently in staging/disabled; falling back to Jev/Rules.",
      degraded: true
    };
  }
}
