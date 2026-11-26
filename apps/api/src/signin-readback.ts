import { siteSigninDomain, type SiteSignin } from "@space/contracts";

// Operator nous_msg:fcea1c9e1c704703949edd86 (7/11, Oracle): an agent reset the password again and again and pressed Sign In blind
// behind the Vault fence, then asked the operator for a sign-in the Vault already held. Three guards share these marks: a reset waits
// for the last one to be tried and read back, and a sign-in handoff or card waits until the stored Vault login was tried and read back.

/** The pause after a Vault password reset before another one at the same site (the operator's "N minutes"). */
export const RESET_WAIT_MS = 15 * 60_000;
/** The site record's history reason a Vault password reset writes (durable, so the wait survives an API restart). */
export const VAULT_RESET_REASON = "Vault password reset";

// shortcut: tried and read marks live in this API process; a restart forgets them and the agent fills and reads once more. Persist if that bites.
const marks = new Map<string, { tried?: number; read?: number }>();
const markKey = (owner: string, url: string) => { try { return `${owner}\n${siteSigninDomain(url)}`; } catch { return null; } };

/** "tried": a Vault login was filled into the site; "read": the agent read the page back (space_browser_page_readout). */
export function markSignin(owner: string, url: string, what: "tried" | "read", at = Date.now()): void {
  const key = markKey(owner, url);
  if (key) marks.set(key, { ...marks.get(key), [what]: at });
}

/**
 * The site record's reason an authenticator key saved into the Vault writes (space_vault_save_totp_from_qr). Operator nous_msg:e3d9b230
 * (20/11, Braintrust): a swap was reported done with the key saved but the site's Change-2FA never confirmed.
 */
export const VAULT_OTP_SWAP_REASON = "Authenticator key saved into the Vault, unproven until a signed-out Vault-only sign-in succeeds";

/** The newest swap of the record has no proof yet: no Vault login submitted after it (PENDING) followed by a SUCCESS no operator handoff recorded. */
export function otpSwapUnproven(signin: SiteSignin | null): boolean {
  const history = signin?.history ?? [];
  const swap = history.findLastIndex((event) => event.reason === VAULT_OTP_SWAP_REASON);
  if (swap < 0) return false;
  const after = history.slice(swap + 1);
  const tried = after.findIndex((event) => event.outcome === "PENDING");
  // An operator handoff's SUCCESS means the operator's own code signed in, which proves nothing about the Vault key.
  return tried < 0 || !after.slice(tried + 1).some((event) => event.outcome === "SUCCESS" && !event.by.startsWith("OPERATOR:"));
}

/** A `done` report from a pane whose authenticator swap is unproven: why it is refused, else null. */
export function otpSwapDoneHold(signins: readonly SiteSignin[], paneId: string): string | null {
  const open = signins.filter((signin) => otpSwapUnproven(signin)
    && signin.history.findLast((event) => event.reason === VAULT_OTP_SWAP_REASON)?.by.endsWith(`:${paneId}`));
  return open.length ? `The authenticator key for ${open.map((signin) => signin.site).join(", ")} is saved into the Vault, but no sign-in proved it, so the swap is not done: confirm the site's 2FA change, sign out, sign in with space_vault_request_fill (submit: true) and space_vault_request_totp_fill only (never the operator's code), read the page back with space_browser_page_readout, and record SUCCESS with space_site_signin_record. If it cannot be proven, report blocked or failed. Nothing reported.` : null;
}

export function lastVaultReset(signin: SiteSignin | null): number {
  return Math.max(0, ...(signin?.history ?? []).filter((event) => event.reason === VAULT_RESET_REASON).map((event) => Date.parse(event.at)));
}

/** What is missing before the stored Vault login counts as tried: FILL it (none since the last reset), READ the page after it, or nothing. */
export function readBackMissing(owner: string, url: string, signin: SiteSignin | null): "FILL" | "READ" | null {
  const key = markKey(owner, url);
  const mark = key ? marks.get(key) : undefined;
  if (!mark?.tried || mark.tried <= lastVaultReset(signin)) return "FILL";
  return !mark.read || mark.read < mark.tried ? "READ" : null;
}

export function readBackStep(missing: "FILL" | "READ", site: string): string {
  return missing === "FILL"
    ? `The Vault holds the login for ${site} and it was not tried since its last reset: fill it with space_vault_request_fill (submit: true), read the page with space_browser_page_readout (masked path, title and the page's error or success text), and record the outcome. Request the operator only if that readout shows the stored login fails.`
    : `The Vault login for ${site} was filled, but the page after it was never read: call space_browser_page_readout (masked path, title and the page's error or success text), act on what it shows and record the outcome. Request the operator only if it shows the stored login fails.`;
}

/** A new Vault password reset at a site whose last one is under RESET_WAIT_MS old, or was never tried and read back: the refusal code, else null. */
export function resetHold(owner: string, url: string, signin: SiteSignin | null, now = Date.now()): "RESET_PENDING" | null {
  const reset = lastVaultReset(signin);
  return reset && (now - reset < RESET_WAIT_MS || readBackMissing(owner, url, signin)) ? "RESET_PENDING" : null;
}

/** A sign-in or password ask: the agent's own hands when the Vault holds the login. */
export const VAULT_SIGNIN_ASK = /\bsign(?:ed|ing)?[-_ ]?in\b|\blog(?:ged|ging)?[-_ ]?in\b|\blogin\b|password|credential|σύνδεσ|συνδεθ/i;
/** 13/11 18:56 BKK (nous_msg:6734ba76: a CLI web-auth link to approve with the operator's security key, refused for a Vault login): no stored password passes these. */
// DEV3D-037: "CLI" counts only beside a web auth or login; a pane's card names its CLI and a sign-in all the time.
export const DEVICE_APPROVAL = /security[- ]key|hardware[- ]key|yubi ?key|webauthn|\bfido2?\b|passkey|windows hello|\/login\/cli\/|\bcli\b[^.\n]{0,40}\bweb[- ]?(?:auth\w*|log[- ]?in|sign[- ]?in)\b|\bdevice (?:code|authori[sz]ation|login)\b|\bapprove\b[^.\n]{0,40}\b(?:log[- ]?in|sign[- ]?in)\b[^.\n]{0,20}\blink\b/i;
/** What stays the operator's even then: a bot check, a push or code on their phone, a camera or ID, a card or payment (mailed codes: mailCodeHold). */
export const OPERATOR_HANDS = new RegExp(String.raw`captcha|turnstile|puzzle|i am human|not a robot|\bpush\b|phone|\bsms\b|authenticator|\b2fa\b|\bmfa\b|\botp\b|one[- ]time|\bcodes?\b|passkey|camera|selfie|passport|identity|\bcard\b|\bpay|iban|\bbank\b|κάμερα|κινητ|κάρτα|πληρω|ταυτότητ|${DEVICE_APPROVAL.source}`, "i");

/** A Vault list item as agents see it: its label and the Google account it belongs to (usernames stay sealed). */
export type VaultLoginRef = { label?: unknown; account?: unknown };

/** The accounts a sign-in ask names: the e-mail addresses in its reason and the sign-in page's own hint, lower-case. */
export function namedAccounts(...texts: Array<string | null | undefined>): string[] {
  return [...new Set(texts.flatMap((text) => text?.toLowerCase().match(/[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+/g) ?? []))];
}

/** A stored login of one of the accounts: its Google account, or a word of its label that is the address or its user name. */
function loginOfAccount(login: VaultLoginRef, accounts: readonly string[]): boolean {
  const words = typeof login.label === "string" ? login.label.toLowerCase().split(/[\s,;()<>[\]]+/) : [];
  const account = typeof login.account === "string" ? login.account.trim().toLowerCase() : "";
  return accounts.some((email) => account === email || words.includes(email) || words.includes(email.split("@")[0]!));
}

/**
 * A sign-in handoff or card for a site whose login the Vault holds (the record's handle, or a Vault login for the site) while that login
 * was not filled and read back since its last reset: the next step for the agent, else null. `vaultLogins` null (agent access off, not
 * known): the agent cannot fill, so the ask passes. When the ask names `accounts`, only a login of one of them holds it (20/11 Cody:
 * info@example.invalid held by four other google.com logins, which would sign in the wrong account).
 */
export async function vaultSigninHold(owner: string, site: string, signin: SiteSignin | null,
  vaultLogins: () => Promise<number | readonly VaultLoginRef[] | null>, accounts: readonly string[] = []): Promise<string | null> {
  const listed = await vaultLogins().catch(() => null);
  if (listed === null) return null;
  const named = accounts.length > 0;
  const logins = typeof listed === "number" ? listed : listed.filter((login) => !named || loginOfAccount(login, accounts)).length;
  const recordAccounts = [signin?.siteAccountEmail, signin?.googleAccountEmail].map((email) => email?.toLowerCase());
  const recorded = Boolean(signin?.vaultHandle) && (!named || recordAccounts.some((email) => email && accounts.includes(email)));
  if (!recorded && logins === 0) return null;
  const missing = readBackMissing(owner, site, signin);
  return missing ? readBackStep(missing, site) : null;
}

/*
 * Operator nous_msg:fe72e061203043b6af2039e9 (7/11 14:12 BKK, third time: Reddit 2/11, Oracle 7/11, Upwork 7/11): no password reset or
 * account recovery while the stored sign-in works. Every reset path (Vault generate-fill, a reset or forgot-password page opened through
 * the browser bridge, a handoff, a Nous card or decision, a support message about the password) asks `resetRefusal` first.
 */
/** A recorded SUCCESS this recent means the stored sign-in works. */
export const WORKING_SIGNIN_MS = 30 * 24 * 3_600_000;
/** Sign-in methods with no site password to reset. */
const NO_PASSWORD_METHODS = new Set(["GOOGLE", "APPLE", "LINKEDIN", "GITHUB", "MICROSOFT"]);
/** The only override: the operator's order, by its Nous message id. */
export const OPERATOR_ORDER_ID = /^nous_msg:[A-Za-z0-9_-]{6,80}$/;
/** A reset, recovery or forgot-password ask, in a reason, a card or a message (English or Greek). */
export const RESET_ASK = /\bforgot\b|\breset\b|\brecover(?:y|ing)?\b|new password|change (?:the |my |your )?password|password (?:change|reset)|unlock (?:the |my )?account|ξ[εέ]χασ|επαναφορ|ανάκτησ|ανακτησ|αλλαγ\S* κωδικ/i;
/** A reset or forgot-password page, by its address. */
export const RESET_URL = /forgot|reset[-_]?password|password[-_/]?reset|\/recover|account[-_]?recovery|lost[-_]?password|\/reset\b/i;

/** The refusal when the stored sign-in works (a SUCCESS in WORKING_SIGNIN_MS with no later failure, or a method without a password), else null. */
export function workingSignin(signin: SiteSignin | null, now = Date.now()): string | null {
  if (!signin) return null;
  // 26/11 (civo.com: SUCCESS 18/11 10:49Z, then failures up to 26/11): a failure after the last success means the stored password no longer works.
  const failedSince = Boolean(signin.lastFailureAt && signin.lastSuccessAt && Date.parse(signin.lastFailureAt) > Date.parse(signin.lastSuccessAt));
  const success = signin.lastSuccessAt && !failedSince && now - Date.parse(signin.lastSuccessAt) < WORKING_SIGNIN_MS ? signin.lastSuccessAt : null;
  if (!success && !NO_PASSWORD_METHODS.has(signin.method)) return null;
  return `Stored sign-in works (SUCCESS ${signin.lastSuccessAt ? signin.lastSuccessAt.slice(0, 10) : "not recorded"}, method ${signin.method}). Sign in with it; a reset needs the operator's explicit order.`;
}

/** `refusal`: the reset is refused; `override`: it goes ahead on the operator's order, which the caller records in its audit. */
export function resetRefusal(signin: SiteSignin | null, operatorOrder?: string | null, now = Date.now()): { refusal: string | null; override: string | null } {
  const refusal = workingSignin(signin, now);
  if (!refusal) return { refusal: null, override: null };
  return operatorOrder && OPERATOR_ORDER_ID.test(operatorOrder) ? { refusal: null, override: operatorOrder } : { refusal, override: null };
}
