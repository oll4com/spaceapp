import { uiText } from "../ui-language/ui-language.js";

/**
 * Connecting an email/calendar account leaves Space for Google or Microsoft and
 * comes back to `/?connector=<result>`. This is the message shown on return.
 */
export interface ConnectorResultMessage { tone: "notice" | "error"; text: string }

type Translate = (text: string, vars?: Record<string, string | number>) => string;
const english: Translate = (text, vars) => uiText("en", text, vars);
const lowerFirst = (value: string) => `${value.charAt(0).toLowerCase()}${value.slice(1)}`;

/** `t` is the interface language's translator (useUiLanguage + uiText); without one the text stays English. */
export function connectorResultMessage(result: string | null, source: string | null = null, t: Translate = english): ConnectorResultMessage | null {
  if (!result) return null;
  const retry = t("Open a Dot's Tools view and connect again.");
  const messages: Record<string, ConnectorResultMessage> = {
    connected: { tone: "notice", text: t("Account connected. Your Dots can use it from now on. Each email and event waits for your approval unless you turn that off in Settings → Dots.") },
    cancelled: { tone: "error", text: `${t("The account was not connected: the sign-in was cancelled or the provider refused it.")} ${retry}` },
    expired: { tone: "error", text: `${t("The sign-in took too long or was started in another tab.")} ${retry}` },
    session: { tone: "error", text: t("The sign-in finished in a different Space session than the one that started it. Connect again from this window.") },
    connector_sign_in_expired: { tone: "error", text: `${t("The sign-in expired before it finished.")} ${retry}` },
    connector_no_email: { tone: "error", text: t("The account has no verified email address, so it was not connected.") },
    connector_no_offline_access: { tone: "error", text: t("The provider did not grant lasting access. Remove Space's access in your account settings, then connect again from a Dot's Tools view.") },
    connector_unavailable: { tone: "error", text: t("That provider is not configured on this server.") }
  };
  if (source === "mail-copilot") {
    // Mail Copilot Setup → Accounts starts the flow with `source=mail-copilot` (gmail.modify: read, label, archive, send).
    const mailRetry = t("Open Mail Copilot Setup → Accounts and choose Allow full Gmail access again.");
    const mailCopilotMessages: Record<string, ConnectorResultMessage> = {
      connected: { tone: "notice", text: t("Full Gmail access allowed. Mail Copilot now shows this account's mail and can reply, label and archive for you under your autonomy setting.") },
      cancelled: { tone: "error", text: `${t("Gmail access was not allowed: the sign-in was cancelled or Google refused it.")} ${mailRetry}` },
      expired: { tone: "error", text: `${t("The sign-in took too long or was started in another tab.")} ${mailRetry}` },
      connector_sign_in_expired: { tone: "error", text: `${t("The sign-in expired before it finished.")} ${mailRetry}` },
      connector_no_offline_access: { tone: "error", text: t("Google did not grant lasting access. Remove Space's access in your Google Account settings, then {retry}", { retry: lowerFirst(mailRetry) }) }
    };
    return mailCopilotMessages[result] ?? messages[result] ?? { tone: "error", text: `${t("Gmail access could not be allowed.")} ${mailRetry}` };
  }
  if (source === "job-copilot") {
    // Job Copilot Setup → Google account starts the flow with `source=job-copilot`.
    const jobCopilotRetry = t("Open Job Copilot Setup → Google account and choose Allow Gmail & Calendar again.");
    const jobCopilotMessages: Record<string, ConnectorResultMessage> = {
      connected: { tone: "notice", text: t("Gmail and Calendar allowed. Job Copilot now reads codes and mail, drafts replies and keeps your calendar with this Google account.") },
      cancelled: { tone: "error", text: `${t("Gmail and Calendar were not allowed: the sign-in was cancelled or Google refused it.")} ${jobCopilotRetry}` },
      expired: { tone: "error", text: `${t("The sign-in took too long or was started in another tab.")} ${jobCopilotRetry}` },
      connector_sign_in_expired: { tone: "error", text: `${t("The sign-in expired before it finished.")} ${jobCopilotRetry}` },
      connector_no_offline_access: { tone: "error", text: t("Google did not grant lasting access. Remove Space's access in your Google Account settings, then {retry}", { retry: lowerFirst(jobCopilotRetry) }) }
    };
    return jobCopilotMessages[result] ?? messages[result] ?? { tone: "error", text: `${t("Gmail and Calendar could not be allowed.")} ${jobCopilotRetry}` };
  }
  return messages[result] ?? { tone: "error", text: `${t("The account could not be connected.")} ${retry}` };
}
