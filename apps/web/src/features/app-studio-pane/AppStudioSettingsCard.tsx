import { APP_STUDIO_KIND } from "../copilot-kit/copilot-kind.js";
import { CopilotSettingsCard } from "../copilot-kit/CopilotSettingsCard.js";

/** Settings → App Studio: the copilot kit's settings card bound to the App Studio pane (settings.appStudio). */
export function AppStudioSettingsCard() {
  return <CopilotSettingsCard kind={APP_STUDIO_KIND} />;
}
