/**
 * Connecting an email/calendar account leaves Space for Google or Microsoft and
 * comes back to `/?connector=<result>`. This is the message shown on return.
 */
export interface ConnectorResultMessage { tone: "notice" | "error"; text: string }

const retry = "Open a Dot's Tools view and connect again.";
const messages: Record<string, ConnectorResultMessage> = {
  connected: { tone: "notice", text: "Account connected. Your Dots can use it from now on. Each email and event waits for your approval unless you turn that off in Settings → Dots." },
  cancelled: { tone: "error", text: `The account was not connected: the sign-in was cancelled or the provider refused it. ${retry}` },
  expired: { tone: "error", text: `The sign-in took too long or was started in another tab. ${retry}` },
  session: { tone: "error", text: "The sign-in finished in a different Space session than the one that started it. Connect again from this window." },
  connector_sign_in_expired: { tone: "error", text: `The sign-in expired before it finished. ${retry}` },
  connector_no_email: { tone: "error", text: "The account has no verified email address, so it was not connected." },
  connector_no_offline_access: { tone: "error", text: "The provider did not grant lasting access. Remove Space's access in your account settings, then connect again from a Dot's Tools view." },
  connector_unavailable: { tone: "error", text: "That provider is not configured on this server." }
};

// Job Copilot Setup → Google account starts the flow with `source=job-copilot`.
const jobCopilotRetry = "Open Job Copilot Setup → Google account and choose Allow Gmail & Calendar again.";
const jobCopilotMessages: Record<string, ConnectorResultMessage> = {
  connected: { tone: "notice", text: "Gmail and Calendar allowed. Job Copilot now reads codes and mail, drafts replies and keeps your calendar with this Google account." },
  cancelled: { tone: "error", text: `Gmail and Calendar were not allowed: the sign-in was cancelled or Google refused it. ${jobCopilotRetry}` },
  expired: { tone: "error", text: `The sign-in took too long or was started in another tab. ${jobCopilotRetry}` },
  connector_sign_in_expired: { tone: "error", text: `The sign-in expired before it finished. ${jobCopilotRetry}` },
  connector_no_offline_access: { tone: "error", text: `Google did not grant lasting access. Remove Space's access in your Google Account settings, then ${jobCopilotRetry.charAt(0).toLowerCase()}${jobCopilotRetry.slice(1)}` }
};

// Mail Copilot Setup → Accounts starts the flow with `source=mail-copilot` (gmail.modify: read, label, archive, send).
const mailCopilotRetry = "Open Mail Copilot Setup → Accounts and choose Allow full Gmail access again.";
const mailCopilotMessages: Record<string, ConnectorResultMessage> = {
  connected: { tone: "notice", text: "Full Gmail access allowed. Mail Copilot now shows this account's mail and can reply, label and archive for you under your autonomy setting." },
  cancelled: { tone: "error", text: `Gmail access was not allowed: the sign-in was cancelled or Google refused it. ${mailCopilotRetry}` },
  expired: { tone: "error", text: `The sign-in took too long or was started in another tab. ${mailCopilotRetry}` },
  connector_sign_in_expired: { tone: "error", text: `The sign-in expired before it finished. ${mailCopilotRetry}` },
  connector_no_offline_access: { tone: "error", text: `Google did not grant lasting access. Remove Space's access in your Google Account settings, then ${mailCopilotRetry.charAt(0).toLowerCase()}${mailCopilotRetry.slice(1)}` }
};

export function connectorResultMessage(result: string | null, source: string | null = null): ConnectorResultMessage | null {
  if (!result) return null;
  if (source === "mail-copilot") return mailCopilotMessages[result] ?? messages[result] ?? { tone: "error", text: `Gmail access could not be allowed. ${mailCopilotRetry}` };
  if (source === "job-copilot") return jobCopilotMessages[result] ?? messages[result] ?? { tone: "error", text: `Gmail and Calendar could not be allowed. ${jobCopilotRetry}` };
  return messages[result] ?? { tone: "error", text: `The account could not be connected. ${retry}` };
}
