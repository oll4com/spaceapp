import type {
  CodexResetCreditAvailability,
  CodexResetCreditRedemptionOutcome,
  CodexResetCreditRedemptionResponse
} from "@space/contracts";
import { SpaceFeatureDisabledError } from "@space/runtime";

/**
 * Codex weekly reset credits: what the toolbar dialog needs from a provider. Space Gateway implements it
 * (gateway/gateway-codex-services.ts); the SSH bridge to codex-lb on public-host was retired with codex-lb.
 */
export type CodexResetCreditsErrorCode = "AUTH_REQUIRED" | "PROVIDER_UNAVAILABLE" | "STALE_CREDIT" | "UNKNOWN_OUTCOME";

export interface CodexResetCreditsRedemptionResult {
  response: CodexResetCreditRedemptionResponse;
  audit: {
    outcome: CodexResetCreditRedemptionOutcome;
    usageVerified: boolean;
    creditIdHash: string | null;
  };
}

export interface CodexResetCreditsService {
  availability(): Promise<CodexResetCreditAvailability>;
  redeem(accountId: string, idempotencyKey: string): Promise<CodexResetCreditsRedemptionResult>;
}

const errorMessages: Record<CodexResetCreditsErrorCode, string> = {
  AUTH_REQUIRED: "The account must be authenticated again before a reset can be used.",
  PROVIDER_UNAVAILABLE: "Reset credits are temporarily unavailable.",
  STALE_CREDIT: "The selected reset credit is no longer available.",
  UNKNOWN_OUTCOME: "The reset result is unknown. Retry with the same request."
};

const errorCodes: Record<CodexResetCreditsErrorCode, string> = {
  AUTH_REQUIRED: "CODEX_RESET_AUTH_REQUIRED",
  PROVIDER_UNAVAILABLE: "CODEX_RESET_PROVIDER_UNAVAILABLE",
  STALE_CREDIT: "CODEX_RESET_STALE_CREDIT",
  UNKNOWN_OUTCOME: "CODEX_RESET_OUTCOME_UNKNOWN"
};

export class CodexResetCreditsError extends SpaceFeatureDisabledError {
  readonly bridgeCode: CodexResetCreditsErrorCode;

  constructor(code: CodexResetCreditsErrorCode) {
    super(errorCodes[code], errorMessages[code]);
    this.name = "CodexResetCreditsError";
    this.bridgeCode = code;
  }
}
