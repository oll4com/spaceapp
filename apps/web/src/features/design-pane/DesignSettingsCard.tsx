import { DESIGN_KIND } from "../copilot-kit/copilot-kind.js";
import { CopilotSettingsCard } from "../copilot-kit/CopilotSettingsCard.js";

/** Settings → Design: the copilot kit's settings card bound to the Design pane (settings.design). */
export function DesignSettingsCard() {
  return <CopilotSettingsCard kind={DESIGN_KIND} />;
}
