import type { CSSProperties } from "react";
import { Check, Lock } from "../ui-theme/app-icons.js";
import {
  accountEntryForProfile, accountEntryProfile, accountEntryTarget, accountMenuEntries, accountMenuLabel, accountNeedsSignIn,
  browserAccountStatusHint, browserAccountStatusLabel, effectiveAccountId, isAccountEntrySelected,
  type AccountMenuEntry, type BrowserAccountStatus, type YouTubeAccounts
} from "./youtube-accounts.js";

type StatusTone = "ok" | "attention";
function statusTone(status: BrowserAccountStatus | undefined): StatusTone | undefined {
  if (status === "CONNECTED" || status === "SIGNED_IN") return "ok";
  return accountNeedsSignIn(status) ? "attention" : undefined;
}

// Clear, distinct hues that stay readable on the dark menu (no muddy yellows).
const avatarHues = [205, 225, 255, 280, 310, 335, 165, 185, 145, 10];
export function avatarHue(value: string): number {
  let hash = 0;
  for (const char of value) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return avatarHues[hash % avatarHues.length]!;
}

/** The account a pane trigger shows: its name, sign-in status and status tone. */
export function selectedAccountSummary(accounts: YouTubeAccounts): { name: string; status: string | null; tone?: StatusTone } {
  const effectiveId = effectiveAccountId(accounts);
  const entry = accountEntryForProfile(accounts, effectiveId);
  if (!entry) return { name: "Unavailable account", status: null };
  const { browserStatus } = accountEntryProfile(entry, effectiveId);
  return { name: entry.title, status: browserAccountStatusLabel(browserStatus), tone: statusTone(browserStatus) };
}

/** Content of the Google account menu shared by Browser and YouTube panes. */
export function GoogleAccountMenuItems({ accounts, onSelect, onSignIn, scope }: {
  accounts: YouTubeAccounts;
  onSelect(profileId: string): void;
  onSignIn(profileId: string): void;
  /** What a choice changes when it is not the whole pane ("This tab"). */
  scope?: string;
}) {
  const effectiveId = effectiveAccountId(accounts);
  const entries = accountMenuEntries(accounts);
  const shared = entries.filter(entry => entry.group === "shared");
  const needSignIn = shared.filter(entry => accountNeedsSignIn(accountEntryProfile(entry, effectiveId).browserStatus)).length;
  const selected = entries.find(entry => isAccountEntrySelected(entry, effectiveId));
  const selectedNeedsSignIn = selected ? accountNeedsSignIn(accountEntryProfile(selected, effectiveId).browserStatus) : false;
  const row = (entry: AccountMenuEntry) => {
    const { browserStatus } = accountEntryProfile(entry, effectiveId);
    const status = browserAccountStatusLabel(browserStatus);
    const tone = statusTone(browserStatus);
    const checked = isAccountEntrySelected(entry, effectiveId);
    const target = accountEntryTarget(entry, effectiveId);
    const avatarStyle = entry.group === "shared" ? { "--account-hue": avatarHue(entry.title) } as CSSProperties : undefined;
    return <button key={entry.key} type="button" role="menuitemradio" className="account-menu-item" data-profile-id={target} data-status={tone}
      aria-checked={checked} aria-label={accountMenuLabel(entry, effectiveId)}
      title={[entry.title, browserAccountStatusHint(browserStatus)].filter(Boolean).join("\n")} onClick={() => onSelect(target)}>
      <span className={`account-menu-avatar${entry.group === "private" ? " private" : ""}`} style={avatarStyle} aria-hidden="true">
        {entry.group === "private" ? <Lock /> : entry.title.charAt(0).toUpperCase()}
      </span>
      <span className="account-menu-copy" aria-hidden="true">
        <span className="account-menu-title">{entry.title}</span>
        <span className="account-menu-meta">
          {status ? <span className={`account-menu-status ${tone ?? ""}`}>{status}</span> : null}
          <span className="account-menu-detail">{entry.detail}</span>
        </span>
      </span>
      {checked ? <Check className="account-menu-check" aria-hidden="true" /> : <span aria-hidden="true" />}
    </button>;
  };
  return <>
    <div className="account-menu-head">
      <strong>Google account</strong>
      {scope ? <small className="account-menu-scope">{scope}</small> : null}
      {needSignIn ? <span className="account-menu-alert">{needSignIn === 1 ? "1 needs sign-in" : `${needSignIn} need sign-in`}</span> : null}
    </div>
    {shared.length ? <small className="account-menu-group">Shared by all panes</small> : null}
    {shared.map(row)}
    <small className="account-menu-group">This pane only</small>
    {entries.filter(entry => entry.group === "private").map(row)}
    <div className="account-menu-footer">
      <button type="button" role="menuitem" className={`account-menu-signin${selectedNeedsSignIn ? " attention" : ""}`} onClick={() => onSignIn(effectiveId)}>
        Sign in to selected account
      </button>
      <small>Sign in once per Google account. Every Browser and YouTube pane using that account stays signed in.</small>
    </div>
  </>;
}
