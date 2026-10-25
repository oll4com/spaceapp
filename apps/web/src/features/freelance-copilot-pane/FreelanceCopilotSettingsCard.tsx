import { FREELANCE_COPILOT_KIND } from "../copilot-kit/copilot-kind.js";
import { CopilotSettingsCard } from "../copilot-kit/CopilotSettingsCard.js";

/** Settings → Freelance Copilot: the copilot kit's settings card bound to Freelance Copilot (settings.freelanceCopilot). */
export function FreelanceCopilotSettingsCard() {
  return <CopilotSettingsCard kind={FREELANCE_COPILOT_KIND} />;
}
