/**
 * CONNECTED is verified with Google; SIGNED_IN means the shared profile holds a Google
 * session (Gemini accounts, read locally); UNKNOWN is not evidence either way.
 */
export type BrowserAccountStatus = "NOT_CONNECTED" | "CONNECTED" | "SIGNED_IN" | "REAUTHENTICATION_REQUIRED" | "UNKNOWN";
export interface BrowserAccountProfile {
  profileId: string;
  displayName: string;
  /** Short name: the Gemini account name or the Google display name. */
  label?: string;
  email?: string | null;
  browserStatus?: BrowserAccountStatus;
}
export interface YouTubeAccounts {
  selectedProfileId: string | null;
  /** What the pane opens: the saved choice, or the primary Google account when nothing was chosen. */
  effectiveProfileId?: string | null;
  profiles: BrowserAccountProfile[];
}
/** A pane-only Chrome profile; never shared with other panes. */
export const privatePaneProfileId = "private:pane";

const isLinkedGoogleAccount = (profileId: string) => profileId.startsWith("google_account:");

/**
 * One menu row per Google identity. A linked Google account and a Gemini account with
 * the same email are the same person's account, so they share a row; `profiles` keeps
 * the linked account first.
 */
export interface AccountMenuEntry {
  key: string;
  group: "shared" | "private";
  title: string;
  detail: string;
  profiles: BrowserAccountProfile[];
}

function canonicalEmail(email: string): string {
  const lower = email.trim().toLowerCase();
  const at = lower.lastIndexOf("@");
  if (at < 1) return lower;
  const domain = lower.slice(at + 1);
  return domain === "gmail.com" || domain === "googlemail.com" ? `${lower.slice(0, at).replaceAll(".", "")}@gmail.com` : lower;
}

/** Where a row comes from; an older server sends no label, and its display name already says it. */
function entryDetail(profiles: BrowserAccountProfile[]): string {
  const gemini = profiles.filter(profile => !isLinkedGoogleAccount(profile.profileId) && profile.label).map(profile => `Gemini ${profile.label}`);
  const linked = profiles.some(profile => isLinkedGoogleAccount(profile.profileId));
  if (linked && !gemini.length) return "Linked Google account";
  return [...gemini, ...(linked ? ["Linked"] : [])].join(" · ");
}

/** Shared accounts first (linked Google accounts, then Gemini accounts), then the private pane profile. */
export function accountMenuEntries(accounts: YouTubeAccounts): AccountMenuEntry[] {
  const ordered = [
    ...accounts.profiles.filter(profile => isLinkedGoogleAccount(profile.profileId)),
    ...accounts.profiles.filter(profile => !isLinkedGoogleAccount(profile.profileId) && profile.profileId !== privatePaneProfileId)
  ];
  const byEmail = new Map<string, AccountMenuEntry>();
  const shared: AccountMenuEntry[] = [];
  for (const profile of ordered) {
    const email = profile.email ? canonicalEmail(profile.email) : null;
    const existing = email ? byEmail.get(email) : undefined;
    if (existing) { existing.profiles.push(profile); continue; }
    const entry: AccountMenuEntry = { key: profile.profileId, group: "shared", title: profile.email || profile.label || profile.displayName, detail: "", profiles: [profile] };
    if (email) byEmail.set(email, entry);
    shared.push(entry);
  }
  for (const entry of shared) entry.detail = entryDetail(entry.profiles);
  return [
    ...shared,
    { key: privatePaneProfileId, group: "private", title: "Private pane profile", detail: "Only this pane · not shared",
      profiles: [{ profileId: privatePaneProfileId, displayName: "Private pane profile" }] }
  ];
}

export function effectiveAccountId(accounts: YouTubeAccounts): string {
  return accounts.effectiveProfileId ?? accounts.selectedProfileId ?? privatePaneProfileId;
}

const signedIn = (status: BrowserAccountStatus | undefined) => status === "CONNECTED" || status === "SIGNED_IN";
export const accountNeedsSignIn = (status: BrowserAccountStatus | undefined) => status === "NOT_CONNECTED" || status === "REAUTHENTICATION_REQUIRED";

export function isAccountEntrySelected(entry: AccountMenuEntry, effectiveId: string): boolean {
  return entry.profiles.some(profile => profile.profileId === effectiveId);
}

/**
 * The profile a row stands for: the pane's current one when it belongs to the row,
 * otherwise a signed-in one (linked account first), otherwise the linked account.
 */
export function accountEntryProfile(entry: AccountMenuEntry, effectiveId: string): BrowserAccountProfile {
  return entry.profiles.find(profile => profile.profileId === effectiveId)
    ?? entry.profiles.find(profile => signedIn(profile.browserStatus))
    ?? entry.profiles[0]!;
}

/** What choosing a row opens: its current profile, unless that one needs sign-in and another of the row is signed in. */
export function accountEntryTarget(entry: AccountMenuEntry, effectiveId: string): string {
  const current = accountEntryProfile(entry, effectiveId);
  if (!accountNeedsSignIn(current.browserStatus)) return current.profileId;
  return (entry.profiles.find(profile => signedIn(profile.browserStatus)) ?? current).profileId;
}

export function accountEntryForProfile(accounts: YouTubeAccounts, profileId: string): AccountMenuEntry | undefined {
  return accountMenuEntries(accounts).find(entry => isAccountEntrySelected(entry, profileId));
}

/** Short selector label; UNKNOWN stays silent because it is not evidence either way. */
export function browserAccountStatusLabel(status: BrowserAccountStatus | undefined): string | null {
  if (signedIn(status)) return "Signed in";
  if (status === "NOT_CONNECTED") return "Sign-in needed";
  if (status === "REAUTHENTICATION_REQUIRED") return "Sign in again";
  return null;
}

export function browserAccountStatusHint(status: BrowserAccountStatus | undefined): string | null {
  if (status === "CONNECTED") return "Verified with Google";
  if (status === "SIGNED_IN") return "A Google session is saved in this account's browser profile";
  if (status === "NOT_CONNECTED") return "No Google session in this account's browser profile yet";
  if (status === "REAUTHENTICATION_REQUIRED") return "Google asks to sign in to this account again";
  return null;
}

/** Accessible row name: account, status, then where it comes from. */
export function accountMenuLabel(entry: AccountMenuEntry, effectiveId: string): string {
  const status = browserAccountStatusLabel(accountEntryProfile(entry, effectiveId).browserStatus);
  return [entry.title, status, entry.group === "shared" ? entry.detail : null].filter(Boolean).join(" · ");
}

/** Uses the server's account-specific sign-in URL; older servers fall back to a plain sign-in. */
export function googleSignInTarget(serverTarget: string, fallback: string): string {
  try {
    const url = new URL(serverTarget);
    if (url.origin === "https://accounts.google.com") return url.href;
  } catch { /* fall through */ }
  return fallback;
}

export interface YouTubeAccountSelection {
  selectedProfileId: string | null;
  targetUrl: string;
}
