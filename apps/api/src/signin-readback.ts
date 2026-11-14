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
export const DEVICE_APPROVAL = /security[- ]key|hardware[- ]key|yubi ?key|webauthn|\bfido2?\b|passkey|windows hello|\/login\/cli\/|\bcli\b[^.\n]{0,40}\b(?:web[- ]?auth\w*|auth\w*|log[- ]?in|sign[- ]?in)\b|\bdevice (?:code|authori[sz]ation|login)\b|\bapprove\b[^.\n]{0,40}\b(?:log[- ]?in|sign[- ]?in)\b[^.\n]{0,20}\blink\b/i;
/** What stays the operator's even then: a bot check, a push or code on their phone, a camera or ID, a card or payment (mailed codes: mailCodeHold). */
export const OPERATOR_HANDS = new RegExp(String.raw`captcha|turnstile|puzzle|i am human|not a robot|\bpush\b|phone|\bsms\b|authenticator|\b2fa\b|\bmfa\b|\botp\b|one[- ]time|\bcodes?\b|passkey|camera|selfie|passport|identity|\bcard\b|\bpay|iban|\bbank\b|κάμερα|κινητ|κάρτα|πληρω|ταυτότητ|${DEVICE_APPROVAL.source}`, "i");

/**
 * A sign-in handoff or card for a site whose login the Vault holds (the record's handle, or a Vault login for the site) while that login
 * was not filled and read back since its last reset: the next step for the agent, else null. `vaultLogins` null (agent access off, not
 * known): the agent cannot fill, so the ask passes.
 */
export async function vaultSigninHold(owner: string, site: string, signin: SiteSignin | null, vaultLogins: () => Promise<number | null>): Promise<string | null> {
  const logins = await vaultLogins().catch(() => null);
  if (logins === null || (!signin?.vaultHandle && logins === 0)) return null;
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

/** The refusal when the stored sign-in works (a SUCCESS in WORKING_SIGNIN_MS, or a method without a password), else null. */
export function workingSignin(signin: SiteSignin | null, now = Date.now()): string | null {
  if (!signin) return null;
  const success = signin.lastSuccessAt && now - Date.parse(signin.lastSuccessAt) < WORKING_SIGNIN_MS ? signin.lastSuccessAt : null;
  if (!success && !NO_PASSWORD_METHODS.has(signin.method)) return null;
  return `Stored sign-in works (SUCCESS ${signin.lastSuccessAt ? signin.lastSuccessAt.slice(0, 10) : "not recorded"}, method ${signin.method}). Sign in with it; a reset needs the operator's explicit order.`;
}

/** `refusal`: the reset is refused; `override`: it goes ahead on the operator's order, which the caller records in its audit. */
export function resetRefusal(signin: SiteSignin | null, operatorOrder?: string | null, now = Date.now()): { refusal: string | null; override: string | null } {
  const refusal = workingSignin(signin, now);
  if (!refusal) return { refusal: null, override: null };
  return operatorOrder && OPERATOR_ORDER_ID.test(operatorOrder) ? { refusal: null, override: operatorOrder } : { refusal, override: null };
}
