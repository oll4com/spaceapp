import { useEffect, useState } from "react";
import { api, type GoogleAccountSummary } from "../../api.js";

const signInHint = "Select this account in a Browser or YouTube pane, then choose “Sign in to selected account” to connect its browser profile.";

function accountLabel(account: GoogleAccountSummary): string {
  const value = account.displayName || account.email;
  if (value !== account.email) return value;
  const [local, domain] = account.email.split("@");
  return local && domain ? `${local.slice(0, 2)}***@${domain}` : "Google account";
}

function browserStatusLabel(account: GoogleAccountSummary): string {
  if (account.browserStatus === "CONNECTED") return "Browser connected";
  if (account.browserStatus === "NOT_CONNECTED") return "Browser not connected";
  if (account.browserStatus === "REAUTHENTICATION_REQUIRED") return "Browser reauthentication required";
  return "Browser session unknown";
}

function browserStatusHint(account: GoogleAccountSummary): string | null {
  if (account.browserStatus === "NOT_CONNECTED") {
    return account.browserStatusReason === "OTHER_ACCOUNT"
      ? "This browser profile is signed in to a different Google account. Select this account in a Browser or YouTube pane and sign in to it there."
      : signInHint;
  }
  if (account.browserStatus === "REAUTHENTICATION_REQUIRED") return `Google ended this browser session. ${signInHint}`;
  if (account.browserStatus === "UNKNOWN") return "Check the browser session to verify the saved profile with Google.";
  return null;
}

export function formatBrowserCheckTime(value: string | null | undefined, now = Date.now()): string | null {
  const time = value ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(time)) return null;
  const minutes = Math.max(0, Math.round((now - time) / 60_000));
  if (minutes < 1) return "checked just now";
  if (minutes < 60) return `checked ${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `checked ${hours} h ago`;
  return `checked on ${new Date(time).toLocaleDateString("en-US", { month: "short", day: "numeric" })}`;
}

export function GoogleAccountsManager({ enabled, onAuthRefresh }: { enabled: boolean; onAuthRefresh: () => Promise<void> }) {
  const [accounts, setAccounts] = useState<GoogleAccountSummary[]>([]);
  const [loading, setLoading] = useState(enabled);
  const [loaded, setLoaded] = useState(false);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checkNotices, setCheckNotices] = useState<Record<string, string>>({});
  const [checkingId, setCheckingId] = useState<string | null>(null);

  async function reload() {
    const result = await api.listGoogleAccounts();
    setAccounts(result.accounts);
    setLoaded(true);
  }

  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    Promise.resolve().then(() => api.listGoogleAccounts()).then(result => { if (!disposed) { setAccounts(result.accounts); setLoaded(true); } })
      .catch(cause => { if (!disposed) setError(cause instanceof Error ? cause.message : "Google accounts could not be loaded."); })
      .finally(() => { if (!disposed) setLoading(false); });
    return () => { disposed = true; };
  }, [enabled]);

  async function setDefault(account: GoogleAccountSummary) {
    setPendingId(account.id); setError(null);
    try {
      await api.setPrimaryGoogleAccount(account.id);
      await reload();
      await onAuthRefresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Default Google account could not be changed.");
    } finally { setPendingId(null); }
  }

  async function remove(account: GoogleAccountSummary) {
    if (!window.confirm(`Remove ${accountLabel(account)} from this Space user?`)) return;
    setPendingId(account.id); setError(null);
    try {
      await api.removeGoogleAccount(account.id);
      await reload();
      await onAuthRefresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Google account could not be removed.");
    } finally { setPendingId(null); }
  }

  async function checkBrowser(account: GoogleAccountSummary) {
    setPendingId(account.id); setCheckingId(account.id); setError(null);
    setCheckNotices(current => { const next = { ...current }; delete next[account.id]; return next; });
    try {
      const result = await api.checkGoogleAccountBrowser(account.id);
      setAccounts(current => current.map(candidate => candidate.id === account.id ? result.account : candidate));
      if (result.check.status === "UNKNOWN") {
        setCheckNotices(current => ({ ...current, [account.id]: "The browser check could not reach Google. No sign-out was detected; the last verified state is shown." }));
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The browser session could not be checked.");
    } finally { setPendingId(null); setCheckingId(null); }
  }

  if (!enabled) return <p className="settings-flat-note">Configure Google OAuth to add accounts.</p>;
  return <section aria-label="Google accounts" className="google-accounts-manager">
    <div className="settings-flat-row" style={{ gridTemplateColumns: "1fr auto" }}>
      <span className="settings-flat-row-copy"><strong>Google accounts</strong><small>Use the same Space user with separate saved browser profiles.</small></span>
      <a className="button" href="/api/auth/google/accounts/link" aria-label="Add Google account">Add account</a>
    </div>
    {loading ? <p role="status">Loading Google accounts…</p> : null}
    {!loading && loaded && accounts.length === 0 ? <p className="settings-flat-note">No Google accounts linked yet.</p> : null}
    {accounts.map(account => {
      const label = accountLabel(account);
      const checked = formatBrowserCheckTime(account.browserCheckedAt);
      const hint = browserStatusHint(account);
      return <div className="settings-flat-row" key={account.id} style={{ gridTemplateColumns: "minmax(0, 1fr) auto", gap: "0.75rem" }}>
        <span className="settings-flat-row-copy" style={{ minWidth: 0 }}>
          <strong>{label}{account.isPrimary ? " · Default" : ""}</strong>
          <small data-sensitive-masked="manual">{accountLabel({ ...account, displayName: null })}</small>
          <small data-browser-status={account.browserStatus}>Space SSO linked · {browserStatusLabel(account)}{checked ? ` · ${checked}` : ""}</small>
          {hint ? <small>{hint}</small> : null}
          {checkNotices[account.id] ? <small role="status">{checkNotices[account.id]}</small> : null}
        </span>
        <span style={{ display: "flex", flexWrap: "wrap", gap: "0.4rem", justifyContent: "flex-end" }}>
          <button type="button" className="button" disabled={pendingId !== null} aria-label={`Check browser session for ${label}`} onClick={() => void checkBrowser(account)}>
            {checkingId === account.id ? "Checking…" : "Check browser"}
          </button>
          {!account.isPrimary ? <button type="button" className="button" disabled={pendingId !== null} aria-label={`Make ${label} default`} onClick={() => void setDefault(account)}>Set default</button> : null}
          <button type="button" className="button" disabled={pendingId !== null} aria-label={`Remove ${label}`} onClick={() => void remove(account)}>Remove</button>
        </span>
      </div>;
    })}
    {error ? <p role="alert">{error}</p> : null}
  </section>;
}
