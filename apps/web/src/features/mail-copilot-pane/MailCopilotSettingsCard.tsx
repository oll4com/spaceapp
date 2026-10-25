import { MAIL_COPILOT_KIND } from "../copilot-kit/copilot-kind.js";
import { CopilotSettingsCard } from "../copilot-kit/CopilotSettingsCard.js";

/** Settings → Mail Copilot: the copilot kit's settings card bound to Mail Copilot (settings.mailCopilot). */
export function MailCopilotSettingsCard() {
  return <CopilotSettingsCard kind={MAIL_COPILOT_KIND} />;
}
