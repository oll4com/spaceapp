import { MONITORING_COPILOT_KIND } from "../copilot-kit/copilot-kind.js";
import { CopilotSettingsCard } from "../copilot-kit/CopilotSettingsCard.js";

/** Settings → Monitoring Copilot: the copilot kit's settings card bound to the Monitoring Copilot pane (settings.monitoringCopilot). */
export function MonitoringCopilotSettingsCard() {
  return <CopilotSettingsCard kind={MONITORING_COPILOT_KIND} />;
}
