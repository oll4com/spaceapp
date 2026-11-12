/**
 * Which Google account a browser tab must use for a site (operator nous_msg:05e5af9f81ec45caa1f50f1b, 6/11): the site sign-in recipe's
 * googleAccountEmail / browserProfileId, or the account a Google sign-in page names, never the pane's default (primary) account by accident.
 */
import type { BrowserHostActorContext } from "@space/browser-host";
import { siteSigninKeySchema, type Pane, type SiteSignin } from "@space/contracts";
import type { PaneBrowserAccountControl } from "./pane-browser-routes.js";
import { siteSigninFor } from "./site-signins.js";
import { googleAccountSignInUrl } from "./youtube-accounts.js";

/** Google's own sites hold many accounts: only an explicit account in the address (authuser, Email, login_hint) picks one there. */
const GOOGLE_SITES = new Set(["google.com", "youtube.com", "gmail.com", "googleusercontent.com"]);
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SIGNED_IN = new Set(["CONNECTED", "SIGNED_IN"]);

export interface SigninTarget {
  /** The registrable domain whose sign-in recipe applies (a Google sign-in page stands for the site it continues to). */
  site: string | null;
  /** The account the address itself names (Google sign-in hint or authuser), lower-case. */
  hintEmail: string | null;
  /** Where a Google sign-in page continues to (its continue address, followed to the deepest one); null for other pages. */
  destination: string | null;
}

function domainOf(url: URL): string | null {
  const key = siteSigninKeySchema.safeParse({ site: url.href });
  return key.success ? key.data.site : null;
}

/** The site and explicit account of an address; Google's sign-in and OAuth pages read through their continue/redirect address. */
export function signinTarget(address: string | null | undefined): SigninTarget {
  let url: URL;
  try { url = new URL(address ?? ""); } catch { return { site: null, hintEmail: null, destination: null }; }
  if (url.protocol !== "https:" && url.protocol !== "http:") return { site: null, hintEmail: null, destination: null };
  let site = domainOf(url);
  let hintEmail: string | null = null;
  let destination: string | null = null;
  // Nested continue addresses (sign-in → OAuth consent → the site) are followed a few levels at most.
  for (let depth = 0; depth < 4 && site && GOOGLE_SITES.has(site); depth += 1) {
    for (const key of ["Email", "login_hint", "authuser", "email"]) {
      const value = url.searchParams.get(key)?.trim().toLowerCase();
      if (!hintEmail && value && EMAIL.test(value)) hintEmail = value;
    }
    const key = ["continue", "redirect_uri", "followup", "next"].find((name) => /^https?:\/\//.test(url.searchParams.get(name) ?? ""));
    if (!key) break;
    try { url = new URL(url.searchParams.get(key)!); } catch { break; }
    // An OAuth callback is never opened by itself: the consent page it came from stays the destination.
    if (key === "continue") destination = url.href;
    const nextSite = domainOf(url);
    if (!nextSite) break;
    site = nextSite;
  }
  return { site, hintEmail, destination };
}

export interface AccountChoice { profileId: string; email?: string | null; label?: string | null; browserStatus?: string }
export interface WantedAccount {
  email: string;
  /** The account's browser profile in Space (a linked Google account or a Gemini account); null when Space has none for it. */
  profileId: string | null;
  signedIn: boolean;
  /** Why this account: the site's sign-in recipe or the address itself. */
  source: "recipe" | "address";
}

const storedProfileId = (value: string) => value.startsWith("google-account:") ? value.slice("google-account:".length) : value;

/** The account a recipe (or an explicit address hint) wants among the owner's browser accounts. */
export function wantedAccount(recipe: Pick<SiteSignin, "googleAccountEmail" | "browserProfileId"> | null, hintEmail: string | null,
  choices: AccountChoice[]): WantedAccount | null {
  const email = (hintEmail ?? recipe?.googleAccountEmail ?? null)?.trim().toLowerCase() || null;
  const source = hintEmail ? "address" : "recipe";
  const signedIn = (choice: AccountChoice) => SIGNED_IN.has(choice.browserStatus ?? "");
  if (email) {
    const matches = choices.filter((choice) => choice.email?.trim().toLowerCase() === email);
    // The recipe's own profile first (12/11: github.com's recipe pins the profile holding its session, not the email's first match),
    // then the profile signed in to that account; between two signed-in ones, the linked Google account.
    const pinned = !hintEmail && recipe?.browserProfileId ? storedProfileId(recipe.browserProfileId) : null;
    const ranked = [...matches].sort((left, right) => Number(right.profileId === pinned) - Number(left.profileId === pinned)
      || Number(signedIn(right)) - Number(signedIn(left))
      || Number(right.profileId.startsWith("google_account:")) - Number(left.profileId.startsWith("google_account:")));
    const best = ranked[0];
    return { email, profileId: best?.profileId ?? null, signedIn: best ? signedIn(best) : false, source };
  }
  if (recipe?.browserProfileId) {
    const id = storedProfileId(recipe.browserProfileId);
    const choice = choices.find((candidate) => candidate.profileId === id);
    if (choice?.email) return { email: choice.email.toLowerCase(), profileId: choice.profileId, signedIn: signedIn(choice), source: "recipe" };
  }
  return null;
}

export interface TabAccount { profileId: string | null; email: string | null; byDefault: boolean }
export interface SiteAccountCheck {
  site: string | null;
  wanted: WantedAccount;
  /** The account the tab runs in now. */
  tab: TabAccount;
  /** The tab already runs in the wanted account's profile. */
  matches: boolean;
  activePageId: string | null;
  /** The pane's own account (a tab in it carries no account of its own), where a new tab opens. */
  paneProfileId: string | null;
  pane: TabAccount;
}

export type ListPages = (pane: Pane) => Promise<{ activePageId: string | null; pages: Array<{ pageId: string; isActive: boolean; account?: { profileId: string; label: string | null } | null }> }>;

/** Builds the check from the site's recipe and the pane's accounts and tabs (the active tab unless pageId names one). */
export async function checkSiteAccount(deps: {
  store: object;
  accounts: Pick<PaneBrowserAccountControl, "list">;
  listPages?: ListPages;
}, owner: string, pane: Pane, address: string | null | undefined, pageId?: string | null): Promise<SiteAccountCheck | null> {
  const target = signinTarget(address);
  if (!target.site && !target.hintEmail) return null;
  const recipe = target.site && !GOOGLE_SITES.has(target.site) ? await siteSigninFor(deps.store, owner, target.site) : null;
  if (!target.hintEmail && !recipe?.googleAccountEmail && !recipe?.browserProfileId) return null;
  const listing = await deps.accounts.list(owner, pane);
  const wanted = wantedAccount(recipe, target.hintEmail, listing.profiles);
  if (!wanted) return null;
  const pages = deps.listPages ? await deps.listPages(pane).catch(() => null) : null;
  const page = pages?.pages.find((entry) => pageId ? entry.pageId === pageId : entry.isActive) ?? null;
  const own = page?.account ?? null;
  const tabProfileId = own ? own.profileId : listing.effectiveProfileId;
  const emailOf = (profileId: string | null) => profileId ? listing.profiles.find((choice) => choice.profileId === profileId)?.email ?? null : null;
  const tab: TabAccount = { profileId: tabProfileId, email: own?.label ?? emailOf(tabProfileId), byDefault: !own && listing.selectedProfileId === null };
  const matches = wanted.profileId !== null ? wanted.profileId === tabProfileId : tab.email?.toLowerCase() === wanted.email;
  return { site: target.site, wanted, tab, matches, activePageId: page?.pageId ?? pages?.activePageId ?? null, paneProfileId: listing.effectiveProfileId,
    pane: { profileId: listing.effectiveProfileId, email: emailOf(listing.effectiveProfileId), byDefault: listing.selectedProfileId === null } };
}

const describeTab = (tab: TabAccount) => tab.email ? `${tab.email}${tab.byDefault ? " (the pane's default account)" : ""}` : "the pane's own profile";

/** One line for the agent and the operator's card: the account wanted, its state, and the tab's account. */
export function siteAccountLine(check: SiteAccountCheck, moved: boolean): string {
  const why = check.wanted.source === "address" ? "named by the sign-in page" : `site sign-in recipe${check.site ? ` for ${check.site}` : ""}`;
  if (check.wanted.profileId === null) {
    return `Google account ${check.wanted.email} (${why}) has no browser profile in Space (not linked or signed in in any pane browser); this tab is in ${describeTab(check.tab)}, not ${check.wanted.email}.`;
  }
  const state = check.wanted.signedIn ? "signed in" : "NOT signed in";
  if (check.matches || moved) return `Google account ${check.wanted.email} (${why}), ${state}${moved ? `; this tab moved into its browser from ${describeTab(check.tab)}` : "; this tab runs in it"}.`;
  return `Google account ${check.wanted.email} (${why}), ${state}; this tab is in ${describeTab(check.tab)}, not ${check.wanted.email}.`;
}

/** Freelance Copilot tabs keep the pane's account (its platform routes); every other Google account pane can move a tab. */
export const canMoveTab = (pane: Pane) => pane.mode !== "FREELANCE_COPILOT" && pane.mode !== "YOUTUBE";

/**
 * Moves the tab into the wanted account's browser with `url` when it runs in another account. Returns whether it moved; a failure
 * (an older Browser Host, Freelance Copilot) leaves the tab where it is and the caller says so in its line.
 */
export async function moveTabToWantedAccount(accounts: Pick<PaneBrowserAccountControl, "switchTab">, owner: string, pane: Pane,
  check: SiteAccountCheck, url: string | undefined, signIn: boolean, traceId: string, actor: BrowserHostActorContext): Promise<{ moved: boolean; error: string | null }> {
  if (check.matches || check.wanted.profileId === null || !check.activePageId) return { moved: false, error: null };
  if (!canMoveTab(pane)) return { moved: false, error: `${pane.mode} tabs keep the pane's Google account.` };
  try {
    // A tab back in the pane's own account carries no account of its own.
    const profileId = check.wanted.profileId === check.paneProfileId ? null : check.wanted.profileId;
    // Not signed in: the tab opens Google's sign-in for exactly that account, in that account's browser.
    await accounts.switchTab(owner, pane, check.activePageId, profileId, false, traceId, actor, signIn ? googleAccountSignInUrl(check.wanted.email) : url);
    return { moved: true, error: null };
  } catch (error) {
    return { moved: false, error: error instanceof Error ? error.message.slice(0, 200) : "The tab could not move." };
  }
}

/**
 * Each tab with the Google account it runs in (`google`), as every tab, navigate and status result names it: the tab's own account, else the
 * pane's, marked when nobody chose it (the primary account by default).
 */
export async function tabGoogleAccounts<T extends Awaited<ReturnType<ListPages>>>(accounts: Pick<PaneBrowserAccountControl, "list">,
  listPages: (pane: Pane) => Promise<T>, owner: string, pane: Pane): Promise<Omit<T, "pages"> & { pages: Array<T["pages"][number] & { google: string }> }> {
  const [listing, pages] = await Promise.all([accounts.list(owner, pane), listPages(pane)]);
  const paneEmail = listing.profiles.find((choice) => choice.profileId === listing.effectiveProfileId)?.email ?? null;
  const paneAccount = !paneEmail ? "none (the pane's own profile)"
    : `${paneEmail}${listing.selectedProfileId === null ? " (the pane's default: no account was chosen)" : ""}`;
  return { ...pages, pages: pages.pages.map((page) => ({ ...page, google: page.account ? page.account.label ?? page.account.profileId : paneAccount })) };
}

// A card asks the operator to sign in; one that asks for a password or code Google itself shows goes through as it is.
const SIGNIN_ASK = /sign[- ]?in|log[- ]?in|σύνδεσ|συνδέσ|συνδεθ/i;
const SECRET_ASK = /password|passcode|κωδικ|\bcode\b|2fa|\bmfa\b|\botp\b|verif/i;

/**
 * A sign-in card (an agent's needs-you, a Nous hands card) that names one of the owner's Google accounts, against the tab it opens
 * (operator nous_msg:05e5af9f81ec45caa1f50f1b: a card asked to sign in to ntheogr@gmail.com on a tab running in another account's browser).
 * Returns why no card forms, or null when it may: the tab runs in that account and it is signed in, no card; another account's tab moves into
 * that account's browser (onto Google's sign-in for it when it is not signed in, and then the card forms); a tab that cannot move is refused.
 */
export async function signinCardRefusal(deps: { accounts: Pick<PaneBrowserAccountControl, "list" | "switchTab">; listPages: ListPages },
  owner: string, pane: Pane, pageId: string | null, text: string, mayMove: boolean, traceId: string, actor: BrowserHostActorContext): Promise<string | null> {
  if (!SIGNIN_ASK.test(text) || SECRET_ASK.test(text)) return null;
  const folded = text.toLowerCase();
  // The account named first after the sign-in words ("the tab is in A; sign in to B" asks for B).
  const after = folded.search(SIGNIN_ASK);
  const named = (await deps.accounts.list(owner, pane)).profiles.flatMap((choice) => choice.email ? [{ email: choice.email, at: folded.indexOf(choice.email.toLowerCase(), after) }] : [])
    .filter((entry) => entry.at >= 0).sort((a, b) => a.at - b.at)[0]?.email;
  if (!named) return null;
  // The account the card names reads like a Google sign-in page's own hint.
  const check = await checkSiteAccount({ store: {}, ...deps }, owner, pane, googleAccountSignInUrl(named), pageId);
  // No browser of that account in Space yet: signing in is how it gets one.
  if (!check || check.wanted.profileId === null) return null;
  const email = check.wanted.email;
  if (check.matches) {
    return check.wanted.signedIn ? `${email} is already signed in in this tab's browser (google: ${email}): no sign-in card. Go on yourself (the site's `
      + "\"Sign in with Google\" picks it). Nothing raised." : null;
  }
  const move = mayMove ? await moveTabToWantedAccount(deps.accounts, owner, pane, check, undefined, !check.wanted.signedIn, traceId, actor)
    : { moved: false, error: "the operator or an agent holds this browser" };
  if (move.moved) return check.wanted.signedIn ? `${siteAccountLine(check, true)} It is signed in: go on there yourself, no sign-in card. Nothing raised.` : null;
  return `This tab runs in google: ${describeTab(check.tab)}, not ${email}: switch the tab to ${email} first (space_browser_select_account or the tab's `
    + `account menu)${move.error ? `; it could not move by itself (${move.error})` : ""}. Nothing raised.`;
}
