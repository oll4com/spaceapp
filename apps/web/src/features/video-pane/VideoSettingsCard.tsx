import { VIDEO_KIND } from "../copilot-kit/copilot-kind.js";
import { CopilotSettingsCard } from "../copilot-kit/CopilotSettingsCard.js";

/** Settings → Video: the copilot kit's settings card bound to the Video pane (settings.video). */
export function VideoSettingsCard() {
  return <CopilotSettingsCard kind={VIDEO_KIND} />;
}
