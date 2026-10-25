import { MARKETING_COPILOT_KIND } from "../copilot-kit/copilot-kind.js";
import { CopilotSettingsCard } from "../copilot-kit/CopilotSettingsCard.js";

/** Settings → Marketing Copilot: the copilot kit's settings card bound to Marketing Copilot (settings.marketingCopilot). */
export function MarketingCopilotSettingsCard() {
  return <CopilotSettingsCard kind={MARKETING_COPILOT_KIND} />;
}
