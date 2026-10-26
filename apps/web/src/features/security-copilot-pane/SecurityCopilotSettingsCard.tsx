import { SECURITY_COPILOT_KIND } from "../copilot-kit/copilot-kind.js";
import { CopilotSettingsCard } from "../copilot-kit/CopilotSettingsCard.js";

/** Settings → Security Copilot: the copilot kit's settings card bound to the Security Copilot pane (settings.securityCopilot). */
export function SecurityCopilotSettingsCard() {
  return <CopilotSettingsCard kind={SECURITY_COPILOT_KIND} />;
}
