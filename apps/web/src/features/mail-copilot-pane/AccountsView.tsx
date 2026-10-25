import { useState } from "react";
import { mailCopilotConsentUrl, type ConnectorAccountSummary, type MailCopilotPaneMetadata } from "@space/contracts";
import { api } from "../../api.js";
import { writeClipboardText } from "../clipboard-dock/clipboard-events.js";
import { Check, Copy, Mail, Plus } from "../ui-theme/app-icons.js";

/** What Space may do with an account's Gmail, from the capabilities the operator granted. */
export function gmailAccessLabel(account: Pick<ConnectorAccountSummary, "capabilities">): "full" | "read" | "none" {
  if (account.capabilities.includes("MAIL_ORGANIZE")) return "full";
  if (account.capabilities.includes("MAIL_READ")) return "read";
  return "none";
}

const ACCESS_TEXT = { full: "Full Gmail access", read: "Read-only", none: "No Gmail access" } as const;

/**
 * Full-access consent for one account: here, or as a one-use link copied to the browser where that Google account
 * is signed in (another Chrome profile), since Google consents for the accounts signed in to the browser that opens it.
 */
export function GmailConsentActions({ email, primary = false }: { email: string; primary?: boolean }) {
  const [status, setStatus] = useState<string | null>(null);
  async function copyLink() {
    setStatus("Copying…");
    try {
      const { url } = await api.connectorConsentLink(mailCopilotConsentUrl(email));
      await writeClipboardText(url);
      setStatus(`Copied. Open it within 10 minutes in a browser signed in to ${email}.`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "The link could not be copied.");
    }
  }
  return (
    <div className="jc-actions mc-consent">
      <a className={`jc-button${primary ? " primary" : ""}`} href={mailCopilotConsentUrl(email)}>Allow full Gmail access</a>
      <button type="button" className="jc-button" title="Copy a one-use link for another browser or Chrome profile" onClick={() => void copyLink()}>
        <Copy aria-hidden="true" /> Copy link
      </button>
      {status ? <span className="jc-muted" role="status">{status}</span> : null}
    </div>
  );
}

/** The accounts a pane works with: the chosen ones, or every account allowed for Space when none is chosen. */
export function paneAccounts(settings: MailCopilotPaneMetadata | null, accounts: ConnectorAccountSummary[]): ConnectorAccountSummary[] {
  const chosen = settings?.settings.accounts ?? [];
  return chosen.length === 0 ? accounts : accounts.filter((account) => chosen.includes(account.email));
}

/**
 * The pane's main surface before the mailbox: every Google account allowed for Space, what Space may do with
 * its Gmail, and the consent link that upgrades it to full access (read, label, archive, trash, draft, send).
 */
export function AccountsView({ settings, accounts, loading }: { settings: MailCopilotPaneMetadata | null; accounts: ConnectorAccountSummary[]; loading: boolean }) {
  const used = paneAccounts(settings, accounts);
  return (
    <section className="mc-accounts" aria-label="Mail accounts">
      <header className="mc-accounts-head">
        <Mail aria-hidden="true" />
        <div>
          <strong>Accounts</strong>
          <small>Mail Copilot works with the Google accounts allowed for Space. Full Gmail access lets it read, label, archive and reply; the mailbox opens here once an account has it.</small>
        </div>
      </header>
      {loading && accounts.length === 0 ? <p className="jc-muted jc-panel-loading" role="status">Loading accounts…</p> : null}
      {!loading && accounts.length === 0 ? (
        <div className="jc-empty">
          <strong>No Google account allowed yet</strong>
          <span>Allow one Google account and Mail Copilot shows its mail here.</span>
        </div>
      ) : null}
      <ul className="mc-account-list">
        {accounts.map((account) => {
          const access = gmailAccessLabel(account);
          const inPane = used.some((entry) => entry.accountId === account.accountId);
          return (
            <li key={account.accountId} className="mc-account" data-access={access} data-in-pane={inPane ? "true" : "false"}>
              <span className="mc-account-email">{account.email}</span>
              <span className={`jc-tag${access === "full" ? " accent" : ""}`}>{access === "full" ? <Check aria-hidden="true" /> : null} {ACCESS_TEXT[access]}</span>
              {!inPane ? <span className="jc-muted">Not used by this pane</span> : null}
              {access !== "full" ? <GmailConsentActions email={account.email} primary /> : null}
            </li>
          );
        })}
      </ul>
      <div className="jc-actions">
        <a className="jc-button" href={mailCopilotConsentUrl()}><Plus aria-hidden="true" /> Allow another Google account</a>
      </div>
    </section>
  );
}
