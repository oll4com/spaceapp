import { JOB_COPILOT_KIND } from "../copilot-kit/copilot-kind.js";
import { CopilotSettingsCard } from "../copilot-kit/CopilotSettingsCard.js";

/** Settings → Job Copilot: the copilot kit's settings card bound to Job Copilot (settings.jobCopilot). */
export function JobCopilotSettingsCard() {
  return <CopilotSettingsCard kind={JOB_COPILOT_KIND} />;
}
