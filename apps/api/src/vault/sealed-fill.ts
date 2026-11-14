import {
  canonicalVaultOrigin, decodeVaultBase32, isVaultCardRole, generateVaultPassword, generateVaultTransportKey, openWithVaultPrivateKey, sealToVaultPublicKey, vaultPolicyConstraints,
  vaultBase64url, vaultHostFillRequestSchema, vaultHostSignupRequestSchema, vaultTotp, wipeVaultBytes, type VaultGeneratePolicy, type VaultHostFillResult, type VaultHostTarget,
  type VaultTransportEnvelope, type VaultUseClaims
} from "@space/contracts";

// The Browser Host's sealed fill (plan clipboard:vEYtT6-bEN0J step 3, ADR-012). Runs in the Browser Host process only.
// The agent supplies nothing here: the capability is broker-signed and bound to this pane, target, frame and exact
// origin; the fields are found by fixed scripts in an isolated world (page scripts cannot patch them); the value enters
// the page only through Input.insertText; every step re-checks the live page; the answer is a status and a reason code.
// shortcut: JavaScript strings cannot be wiped; plaintext lives in this call's locals only and is never logged or returned.

export interface SealedFillCdp {
  send<T = Record<string, unknown>>(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<T>;
}
export interface SealedFillPage {
  cdp: SealedFillCdp;
  sessionId: string;
  targetId: string;
  paneId: string;
}
export interface SealedFillBroker {
  /** Signature (broker delegation key) and validity window of a use capability. */
  verifyUse(capability: unknown, now: Date): Promise<VaultUseClaims>;
  /** The broker consumes the capability's nonce once and returns the fields sealed to `replyPublicKey`. */
  openFill(input: { capability: unknown; keyEnvelope: unknown; fieldEnvelopes: unknown; replyPublicKey: string }): Promise<VaultTransportEnvelope>;
  /** NEW_ACCOUNT under a sign-up grant: the broker generates the password, sealed to the inbox and to `replyPublicKey`. */
  signup(input: {
    ownerUserId: string; vaultId: string; certificate: unknown; origin: string; paneId: string; roles: Array<"NEW_PASSWORD" | "CONFIRM_PASSWORD">;
    inboxPublicKey: string; replyPublicKey: string; field: { minLength: number | null; maxLength: number | null; symbols?: string; requireEachClass?: boolean };
  }): Promise<{ sealedPassword: VaultTransportEnvelope; sealedFields: VaultTransportEnvelope }>;
}

type Role = "USERNAME" | "PASSWORD" | "OTP" | "NEW_PASSWORD" | "CONFIRM_PASSWORD" | "CARD_NUMBER" | "CARD_EXPIRY" | "CARD_CVC" | "CARDHOLDER_NAME"
  /** A card's expiry in two boxes; both answer as CARD_EXPIRY. */
  | "CARD_EXPIRY_MONTH" | "CARD_EXPIRY_YEAR";
/** Card fields a page formats ("4242 4242 …", "07 / 28"): their check counts digits. */
const DIGIT_ROLES = /^CARD_(NUMBER|EXPIRY|CVC)/;

/**
 * The field the broker generates a sign-up password for, with the site's stated rules merged in (queue item 37). Symbols and
 * classes go only when the policy names them: a broker from before its reinstall takes lengths only and refuses other keys.
 */
export function signupField(field: { minLength: number | null; maxLength: number | null }, policy?: VaultGeneratePolicy):
  { minLength: number | null; maxLength: number | null; symbols?: string; requireEachClass?: boolean } {
  if (!policy) return field;
  const merged = vaultPolicyConstraints(field, policy);
  return { minLength: merged.field.minLength ?? null, maxLength: merged.field.maxLength ?? null,
    ...(policy.symbols !== undefined || policy.requireEachClass !== undefined ? { symbols: merged.base.symbols, requireEachClass: merged.base.requireEachClass } : {}) };
}
/** `present`: a probe that also finds a box the page keeps disabled or read-only for now. */
type FieldAction = "probe" | "present" | "focus" | "check" | "clear" | "submit";

/** One fixed script per action: the role, action and expected length are the only inputs, all chosen here. */
export function vaultFieldScript(role: Role, action: FieldAction, expectLength = 0): string {
  return `(() => {
  const role = ${JSON.stringify(role)}, action = ${JSON.stringify(action)}, expectLength = ${Number(expectLength) | 0};
  const usable = (el) => { const box = el.getBoundingClientRect(); const style = getComputedStyle(el);
    return box.width > 0 && box.height > 0 && style.visibility !== "hidden" && style.display !== "none" && (action === "present" || (!el.disabled && !el.readOnly)); };
  // Open shadow roots too (Reddit's login keeps its inputs in <faceplate-text-input>, 13/11); the document's own fields come first.
  const roots = [document];
  for (let i = 0; i < roots.length; i++) roots[i].querySelectorAll("*").forEach((node) => { if (node.shadowRoot) roots.push(node.shadowRoot); });
  const pick = (selector) => roots.flatMap((root) => Array.from(root.querySelectorAll(selector))).filter(usable);
  const focused = () => { let active = document.activeElement; while (active && active.shadowRoot && active.shadowRoot.activeElement) active = active.shadowRoot.activeElement; return active; };
  // A field in a shadow root belongs to no form; its form is the one around its host.
  const formOf = (node) => { if (node.form) return node.form; for (let host = node.getRootNode().host; host; host = host.getRootNode().host) { const form = host.form || host.closest("form"); if (form) return form; } return null; };
  const named = (el, pattern) => pattern.test(String(el.name) + " " + String(el.id));
  const passwords = pick('input[type="password"]');
  const fresh = passwords.filter((el) => /\\bnew-password\\b/.test(el.autocomplete));
  // A login secret a site keeps in a visible text field (timologio's SubscriptionKey): only with no password field, exactly one
  // field named for a secret, never a username, mail, VAT or one-time-code field.
  const secretText = () => { const found = pick('input[type="text"],input:not([type])').filter((candidate) => {
    const names = String(candidate.name) + " " + String(candidate.id) + " " + String(candidate.getAttribute("autocomplete"));
    return /subscription.?key|api.?key|secret|passcode/i.test(names) && !/user|mail|login|vat|otp|mfa|2fa|one.?time/i.test(names); });
    return found.length === 1 ? found[0] : null; };
  let el = null;
  if (role === "USERNAME") el = pick('input[autocomplete~="username"],input[autocomplete~="email"],input[type="email"]')[0]
    || pick('input[type="text"],input:not([type])').find((candidate) => named(candidate, /user|email|login/i)) || null;
  // A login's only password field whatever its autocomplete (Skimlinks marks it new-password, 14/11); with 2+ the new/confirm pair stays out.
  else if (role === "PASSWORD") el = passwords.find((candidate) => !/\\bnew-password\\b/.test(candidate.autocomplete)) || (passwords.length === 1 ? passwords[0] : passwords.length ? null : secretText());
  else if (role === "NEW_PASSWORD") el = fresh[0] || passwords[0] || null;
  else if (role === "CONFIRM_PASSWORD") { const first = fresh[0] || passwords[0];
    // The retype field: the next password field after the new one in its form, never the new field itself.
    el = (fresh.length > 1 ? fresh[1] : first && passwords.slice(passwords.indexOf(first) + 1).find((candidate) => formOf(candidate) === formOf(first))) || null; }
  else if (role === "OTP") el = pick('input[autocomplete~="one-time-code"]')[0]
    || pick('input:not([type="password"])').find((candidate) => named(candidate, /otp|totp|2fa|mfa|verification|code/i)) || null;
  // Card fields: the autocomplete token payment forms and frames (Stripe, Adyen, Braintree, Checkout.com) set, else the box's name.
  // shortcut: an expiry in <select> boxes is not found (FIELD_NOT_FOUND); add option picking when a checkout needs it.
  const card = (token, pattern, not) => pick('input[autocomplete~="' + token + '"]')[0] || pick('input:not([type]),input[type="text"],input[type="tel"],input[type="number"],input[type="password"]')
    .find((candidate) => named(candidate, pattern) && !(not && named(candidate, not))) || null;
  if (role === "CARD_NUMBER") el = card("cc-number", /card.?(number|num\\b|no\\b)|cc.?(number|num\\b)/i);
  else if (role === "CARD_EXPIRY") el = card("cc-exp", /expir|exp.?date|cc.?exp/i, /month|year|\\bmm\\b|\\byy/i);
  else if (role === "CARD_EXPIRY_MONTH") el = card("cc-exp-month", /exp.*(month|\\bmm\\b)/i);
  else if (role === "CARD_EXPIRY_YEAR") el = card("cc-exp-year", /exp.*(year|\\byy)/i);
  else if (role === "CARD_CVC") el = card("cc-csc", /cvc|cvv|csc|security.?code|card.?code/i);
  else if (role === "CARDHOLDER_NAME") el = card("cc-name", /card.?holder|holder.?name|name.?on.?card|cc.?name/i);
  if (!el) return { found: false };
  if (action === "focus") { el.focus(); if (typeof el.select === "function") el.select(); return { found: true, focused: focused() === el && document.hasFocus() }; }
  if (action === "check") return { found: true, filled: (${DIGIT_ROLES}.test(role) ? el.value.replace(/\\D/g, "") : el.value).length === expectLength };
  if (action === "clear") { el.value = ""; el.dispatchEvent(new Event("input", { bubbles: true })); return { found: true }; }
  if (action === "submit") { const form = formOf(el); if (!form) return { found: true, form: false };
    // Enter does nothing in a form with no submit button (DCMnetwork's "Log In" is an <input type="button"> with an onclick, 13/11):
    // a person clicks its one sign-in button there; none or several is left to the agent.
    const controls = Array.from(form.elements);
    if (!controls.some((c) => /^(submit|image)$/.test(c.type) && !c.disabled)) {
      const buttons = controls.filter((c) => c.type === "button" && usable(c)
        && /^\\s*(log ?in|sign ?(in|on|up)|register|create|join|submit|continue|next|save|change|update|confirm|σύνδεσ|είσοδ|εγγραφ)/i.test(c.value || c.textContent || c.getAttribute("aria-label") || ""));
      if (buttons.length !== 1) return { found: true, form: true, button: false };
      buttons[0].click(); return { found: true, form: true, clicked: true }; }
    el.focus(); return { found: true, form: true, focused: focused() === el && document.hasFocus() }; }
  return { found: true, maxLength: el.maxLength > 0 ? el.maxLength : null, minLength: el.minLength > 0 ? el.minLength : null,
    pattern: el.getAttribute("pattern"), passwordRules: el.getAttribute("passwordrules"), placeholder: el.getAttribute("placeholder") };
})()`;
}

interface FrameTree { frameTree?: { frame?: { id?: string; url?: string; loaderId?: string } } }

/**
 * The pane's live top frame: its ids, exact origin and document, or why a sealed fill cannot run there. A shared Chrome or a
 * second tab no longer refuses (operator decision 2026-10-18): the API fences the filled browser until this document is gone.
 */
export async function readVaultTarget(page: SealedFillPage): Promise<VaultHostTarget> {
  const tree = await page.cdp.send<FrameTree>("Page.getFrameTree", {}, page.sessionId);
  const frame = tree.frameTree?.frame;
  const origin = frame?.url ? canonicalVaultOrigin(frame.url)?.origin ?? null : null;
  if (!frame?.id || !origin) return { eligible: false, reason: "NO_WEB_ORIGIN", targetId: null, frameId: null, origin: null, document: null };
  // freshDocument and generatePolicy: this host takes those fields in fill requests (the API sends them only to a host that says so).
  // cards: this host fills mode CARD, payment frames included.
  return { eligible: true, reason: null, targetId: page.targetId, frameId: frame.id, origin, document: typeof frame.loaderId === "string" ? frame.loaderId.slice(0, 128) : null, freshDocument: true, generatePolicy: true, cards: true };
}

interface FrameNode { frame: { id: string; url?: string }; childFrames?: FrameNode[] }
export interface VaultFrame { sessionId: string; frameId: string; url: string }
/**
 * Every frame of the page, top frame first: its own, and each cross-site one (an OOPIF: Stripe's js.stripe.com, Adyen,
 * Braintree), which lives in another process and is reached through a session attached to its target. Chrome lists an OOPIF
 * as an iframe target whose parentFrameId is a frame of this page, so another tab's frames never match. The sessions this
 * attaches go into `attached`; the caller detaches them. A frame gone before it is attached is left out with its content.
 */
export async function vaultPageFrames(cdp: SealedFillCdp, sessionId: string, attached: string[]): Promise<VaultFrame[]> {
  const remote = (await cdp.send<{ targetInfos: Array<{ targetId: string; type: string; parentFrameId?: string }> }>("Target.getTargets")).targetInfos
    .filter((target) => target.type === "iframe");
  const frames: VaultFrame[] = [];
  const visit = async (node: FrameNode, session: string): Promise<void> => {
    frames.push({ sessionId: session, frameId: node.frame.id, url: node.frame.url ?? "" });
    for (const child of node.childFrames ?? []) if (!remote.some((target) => target.targetId === child.frame.id)) await visit(child, session);
    for (const target of remote.filter((target) => target.parentFrameId === node.frame.id)) {
      const child = await cdp.send<{ sessionId: string }>("Target.attachToTarget", { targetId: target.targetId, flatten: true }).catch(() => null);
      if (!child) continue;
      attached.push(child.sessionId);
      const tree = await cdp.send<{ frameTree: FrameNode }>("Page.getFrameTree", {}, child.sessionId).catch(() => null);
      if (tree) await visit(tree.frameTree, child.sessionId);
    }
  };
  await visit((await cdp.send<{ frameTree: FrameNode }>("Page.getFrameTree", {}, sessionId)).frameTree, sessionId);
  return frames;
}

/** Where a field's script runs: its frame's session (the page's own or an attached payment frame's) and isolated world there. */
interface Where { sessionId: string; contextId: number }

async function isolatedWorld(page: SealedFillPage, frameId: string, sessionId = page.sessionId): Promise<number> {
  const world = await page.cdp.send<{ executionContextId?: number }>("Page.createIsolatedWorld", { frameId, worldName: "space-vault-fill", grantUniveralAccess: false }, sessionId);
  if (typeof world.executionContextId !== "number") throw new Error("NO_ISOLATED_WORLD");
  return world.executionContextId;
}

async function field(page: SealedFillPage, at: Where, role: Role, action: FieldAction, expectLength?: number): Promise<Record<string, unknown>> {
  const answer = await page.cdp.send<{ result?: { value?: unknown }; exceptionDetails?: unknown }>("Runtime.evaluate",
    { expression: vaultFieldScript(role, action, expectLength), contextId: at.contextId, returnByValue: true, awaitPromise: false }, at.sessionId);
  // An exception's text could carry page content: it is never read, only treated as "not found".
  const value = answer.exceptionDetails ? null : answer.result?.value;
  return value && typeof value === "object" ? value as Record<string, unknown> : { found: false };
}

/**
 * A field ready to type into, or one the page keeps disabled or read-only for now: that one joins `late` and is typed after the
 * others once the page enables it (Oracle 7/11: the confirm box opens only after the new password passes the site's rules).
 */
async function locate(page: SealedFillPage, at: Where, role: Role, late: Set<Role>): Promise<Record<string, unknown> | null> {
  const probe = await field(page, at, role, "probe");
  if (probe.found === true) return probe;
  const present = await field(page, at, role, "present");
  if (present.found !== true) return null;
  late.add(role);
  return present;
}

/** A sign-up's or change's retype field gets the same password even when the call named only NEW_PASSWORD (SuccessFactors, 30/10). */
async function withConfirm(page: SealedFillPage, at: Where, roles: Role[], late: Set<Role>): Promise<Role[]> {
  if (!roles.includes("NEW_PASSWORD") || roles.includes("CONFIRM_PASSWORD")) return roles;
  return await locate(page, at, "CONFIRM_PASSWORD", late) ? [...roles, "CONFIRM_PASSWORD"] : roles;
}

/**
 * CARD: each card field in whichever frame of the page holds it, top frame first (Stripe puts each box in its own cross-site
 * frame); https frames only. The roles to type and where, or null when the number, expiry or security code is missing; the
 * name on card is typed only where the page asks for it. An expiry in two boxes is typed as month and year.
 */
async function cardFields(page: SealedFillPage, frames: VaultFrame[], roles: Role[], late: Set<Role>, constraints: Map<Role, Record<string, unknown>>):
  Promise<{ typed: Role[]; at: Map<Role, Where> } | null> {
  const worlds: Where[] = [];
  for (const frame of frames.filter((frame) => frame.url.startsWith("https://"))) {
    const contextId = await isolatedWorld(page, frame.frameId, frame.sessionId).catch(() => null);
    if (contextId !== null) worlds.push({ sessionId: frame.sessionId, contextId });
  }
  const at = new Map<Role, Where>();
  const find = async (role: Role) => {
    for (const where of worlds) {
      const probe = await locate(page, where, role, late);
      if (probe) { at.set(role, where); constraints.set(role, probe); return true; }
    }
    return false;
  };
  const typed: Role[] = [];
  for (const role of roles) {
    if (await find(role)) typed.push(role);
    else if (role === "CARD_EXPIRY" && await find("CARD_EXPIRY_MONTH") && await find("CARD_EXPIRY_YEAR")) typed.push("CARD_EXPIRY_MONTH", "CARD_EXPIRY_YEAR");
    else if (role !== "CARDHOLDER_NAME") return null;
  }
  return { typed, at };
}

/** The stored MM/YY as the box asks for it, read like Chrome's autofill does: its length limit and placeholder ("MM/YYYY", "MMYY", "YY"). */
export function cardExpiry(role: Role, stored: string | undefined, box: Record<string, unknown>): string | null {
  const [, month, year] = /^(\d{2})\/(\d{2})$/.exec(stored ?? "") ?? [];
  if (!month || !year) return null;
  const max = typeof box.maxLength === "number" ? box.maxLength : null;
  const placeholder = String(box.placeholder ?? "");
  if (role === "CARD_EXPIRY_MONTH") return month;
  if (role === "CARD_EXPIRY_YEAR") return max === 2 || /^\W*(yy|aa|jj)\W*$/i.test(placeholder) ? year : `20${year}`;
  return month + (max === 4 || max === 6 ? "" : "/") + (max === 6 || max === 7 || /yyyy|aaaa|jjjj/i.test(placeholder) ? `20${year}` : year);
}

/**
 * The answer's shape: `typed` once a value entered the page, `document` the top frame's document the fill ran in (null before the
 * reload), `fields` on a fill that typed: the fields filled and the ones still disabled.
 */
type Fields = NonNullable<VaultHostFillResult["fields"]>;
type Answer = (status: VaultHostFillResult["status"], reason: string | null, sealedGenerated?: VaultTransportEnvelope | null, typed?: boolean, fields?: Fields) => VaultHostFillResult;
const answering = (document: () => string | null): Answer => (status, reason, sealedGenerated = null, typed = false, fields) =>
  ({ status, reason, sealedGenerated, typed, document: document(), ...(fields && { fields }) });

/** How long the reload before a fill may take; a page that never settles (a beforeunload dialog, a dead server) stops the fill. */
export const VAULT_FILL_RELOAD_TIMEOUT_MS = 15_000;
/** How long a disabled field may take to open once the fields before it are typed; one still shut is named in the answer's `fields.disabled`. */
export const VAULT_LATE_FIELD_WAIT_MS = 3_000;
export interface SealedFillOptions { reloadTimeoutMs?: number; lateFieldWaitMs?: number }

/**
 * A fresh document before any field is looked for (Vault review 2026-10-22): a script an agent left in the page before the fill
 * (an input listener, a focus trap) would see the value the moment it is typed; a reloaded document carries none, and the
 * agent's automation sessions, whose init scripts could add one, were closed by the fence before the fill. Resolves to the
 * new document id once the top frame has a new loader and its document is interactive or complete; null when it never settles.
 */
async function freshDocument(page: SealedFillPage, frameId: string, timeoutMs: number): Promise<string | null> {
  const loaderOf = async () => { const frame = (await page.cdp.send<FrameTree>("Page.getFrameTree", {}, page.sessionId)).frameTree?.frame; return frame?.id === frameId && typeof frame.loaderId === "string" ? frame.loaderId.slice(0, 128) : null; };
  const before = await loaderOf();
  await page.cdp.send("Page.reload", { ignoreCache: false }, page.sessionId);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const loader = await loaderOf();
    if (loader && loader !== before) {
      const state = await page.cdp.send<{ result?: { value?: unknown } }>("Runtime.evaluate", { expression: "document.readyState", contextId: await isolatedWorld(page, frameId), returnByValue: true }, page.sessionId).catch(() => null);
      if (state?.result?.value === "complete" || state?.result?.value === "interactive") return loader;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return null;
}

/**
 * A document a form submission made (a sign-in step a POST answered) is never reloaded: Page.reload would post the form again
 * (13/11). shortcut: a GET form result is refused too (CDP names no method); read the entry's post data if one must be reloaded.
 */
async function formResult(page: SealedFillPage): Promise<boolean> {
  const history = await page.cdp.send<{ currentIndex?: number; entries?: Array<{ transitionType?: string }> }>("Page.getNavigationHistory", {}, page.sessionId).catch(() => null);
  return history?.entries?.[history.currentIndex ?? -1]?.transitionType === "form_submit";
}

export async function runSealedFill(page: SealedFillPage, broker: SealedFillBroker, rawRequest: unknown, now = new Date(), options: SealedFillOptions = {}): Promise<VaultHostFillResult> {
  if ((rawRequest as { mode?: unknown } | null)?.mode === "SIGNUP") return runSealedSignup(page, broker, rawRequest, options);
  const attached: string[] = [];
  try { return await sealedFill(page, broker, rawRequest, now, options, attached); }
  finally { for (const sessionId of attached) await page.cdp.send("Target.detachFromTarget", { sessionId }).catch(() => undefined); }
}

async function sealedFill(page: SealedFillPage, broker: SealedFillBroker, rawRequest: unknown, now: Date, options: SealedFillOptions, attached: string[]): Promise<VaultHostFillResult> {
  let document: string | null = null;
  const result = answering(() => document);
  const parsed = vaultHostFillRequestSchema.safeParse(rawRequest);
  if (!parsed.success) return result("BLOCKED", "BAD_REQUEST");
  const request = parsed.data;
  let claims: VaultUseClaims;
  try { claims = await broker.verifyUse(request.capability, now); } catch { return result("BLOCKED", "CAPABILITY_INVALID"); }
  if (claims.paneId !== page.paneId) return result("BLOCKED", "PANE_MISMATCH");
  // CARD types only card fields, FILL only login ones: a login fill never reaches a card, nor a card fill a password.
  const card = request.mode === "CARD";
  const roles: Role[] = request.mode === "TOTP" ? ["OTP"] : request.mode === "GENERATE" ? claims.generate?.roles ?? [] : claims.fields.filter((role) => role !== "OTP" && isVaultCardRole(role) === card) as Role[];
  if (roles.length === 0 || (request.mode === "TOTP" && !claims.fields.includes("OTP")) || (request.mode === "GENERATE" && !claims.generate)
    || (card && !roles.includes("CARD_NUMBER"))) return result("BLOCKED", "MODE_MISMATCH");

  const sameTarget = async (): Promise<"OK" | "TARGET_CHANGED" | "ORIGIN_CHANGED" | "NOT_ELIGIBLE"> => {
    const live = await readVaultTarget(page);
    if (!live.eligible) return "NOT_ELIGIBLE";
    if (live.targetId !== claims.targetId || live.frameId !== claims.frameId) return "TARGET_CHANGED";
    return live.origin === claims.origin ? "OK" : "ORIGIN_CHANGED";
  };
  const before = await sameTarget();
  if (before === "NOT_ELIGIBLE") return result("BLOCKED", "NO_WEB_ORIGIN");
  if (before !== "OK") return result("ORIGIN_MISMATCH", before);
  // A fresh document, still at the bound origin and frame, before any field is looked for; a document the API knows no agent
  // session scripted (freshDocument: false) is filled as it is, so a login that lives in one document keeps its step.
  const reloaded = request.freshDocument !== false;
  if (reloaded && await formResult(page)) return result("BLOCKED", "RELOAD_WOULD_RESUBMIT");
  document = reloaded ? await freshDocument(page, claims.frameId, options.reloadTimeoutMs ?? VAULT_FILL_RELOAD_TIMEOUT_MS) : (await readVaultTarget(page)).document ?? null;
  if (reloaded && !document) return result("BLOCKED", "NO_FRESH_DOCUMENT");
  const after = await sameTarget();
  if (after !== "OK") return after === "NOT_ELIGIBLE" ? result("BLOCKED", "NO_WEB_ORIGIN") : result("ORIGIN_MISMATCH", after);

  // Every field is found before any secret exists in this process. After a reload the missing field has its own code: the agent
  // redoes the steps that showed it, with navigate, click, type and press only, and the next fill needs no reload.
  const constraints = new Map<Role, Record<string, unknown>>();
  const late = new Set<Role>();
  let typedRoles: Role[] = roles;
  let at: (role: Role) => Where;
  if (card) {
    const found = await cardFields(page, await vaultPageFrames(page.cdp, page.sessionId, attached), roles, late, constraints);
    if (!found) return result("BLOCKED", reloaded ? "FIELD_NOT_FOUND_AFTER_RELOAD" : "FIELD_NOT_FOUND");
    typedRoles = found.typed;
    at = (role) => found.at.get(role)!;
  } else {
    const top: Where = { sessionId: page.sessionId, contextId: await isolatedWorld(page, claims.frameId) };
    at = () => top;
    for (const role of roles) {
      const probe = await locate(page, top, role, late);
      if (!probe) return result("BLOCKED", reloaded ? "FIELD_NOT_FOUND_AFTER_RELOAD" : "FIELD_NOT_FOUND");
      constraints.set(role, probe);
    }
    if (request.mode === "GENERATE") typedRoles = await withConfirm(page, top, roles, late);
  }

  const reply = await generateVaultTransportKey();
  const scope = { ownerUserId: claims.ownerUserId, vaultId: claims.vaultId, keyVersion: 1 };
  let values: Map<Role, string>;
  let generated: string | null = null;
  try {
    const sealed = await broker.openFill({ capability: request.capability, keyEnvelope: request.keyEnvelope, fieldEnvelopes: request.fieldEnvelopes, replyPublicKey: vaultBase64url.encode(reply.publicKey) });
    const opened = await openWithVaultPrivateKey(reply.privateKey, reply.publicKey, sealed, scope);
    const secrets = JSON.parse(new TextDecoder().decode(opened)) as Partial<Record<Role, string>>;
    wipeVaultBytes(opened);
    values = new Map();
    if (request.mode === "TOTP") {
      const seed = decodeVaultBase32(secrets.OTP ?? "");
      if (!seed) return result("BLOCKED", "OTP_SEED_INVALID");
      values.set("OTP", await vaultTotp(seed, now));
      wipeVaultBytes(seed);
    } else if (request.mode === "GENERATE") {
      const target = constraints.get("NEW_PASSWORD") ?? constraints.get(roles[0]!)!;
      try {
        // Queue item 37: the site's stated rules narrow the field's own (stricter wins, never under 8, fail closed).
        const merged = vaultPolicyConstraints({ maxLength: target.maxLength as number | null, minLength: target.minLength as number | null,
          pattern: target.pattern as string | null, passwordRules: target.passwordRules as string | null }, request.policy);
        generated = generateVaultPassword(merged.field, merged.base);
      } catch { return result("BLOCKED", "POLICY_UNSATISFIABLE"); }
      for (const role of typedRoles) values.set(role, generated);
    } else {
      for (const role of typedRoles) {
        const value = role.startsWith("CARD_EXPIRY") ? cardExpiry(role, secrets.CARD_EXPIRY, constraints.get(role)!) : secrets[role];
        if (!value) return result("BLOCKED", "FIELD_NOT_DELEGATED");
        values.set(role, value);
      }
    }
  } catch {
    return result("BLOCKED", "BROKER_REFUSED");
  } finally {
    wipeVaultBytes(reply.privateKey);
  }

  const sealedGenerated = generated && claims.generate
    ? await sealToVaultPublicKey(vaultBase64url.decode(claims.generate.inboxPublicKey), new TextEncoder().encode(generated), scope) : null;
  // The broker never submits a card form: the agent checks the amount and presses Pay itself.
  return typeIn(page, at, typedRoles, values, sameTarget, !card && claims.submit, sealedGenerated, result, late, options.lateFieldWaitMs ?? VAULT_LATE_FIELD_WAIT_MS);
}

/**
 * Types each value into its field through Input.insertText, re-checking the live page before each; clears what it typed on any
 * stop. The answer says `typed` from the first insert on, even when the stop came after it (the scrub is best effort and cannot
 * reach a field a page script moved the focus to), so the API keeps the fence. A late field is typed after the others once the
 * page enables it; one still disabled is named and the form is not submitted, so no agent presses submit past an empty box.
 */
async function typeIn(page: SealedFillPage, at: (role: Role) => Where, roles: Role[], values: Map<Role, string>, sameTarget: () => Promise<string>,
  submit: boolean, sealedGenerated: VaultTransportEnvelope | null, result: Answer, late: Set<Role>, lateWaitMs: number): Promise<VaultHostFillResult> {
  const filled: Role[] = [];
  const disabled: Role[] = [];
  let typed = false;
  // The blur is a person's Tab, for a site that checks the value on change rather than on input.
  const opens = async (role: Role) => {
    await page.cdp.send("Runtime.evaluate", { expression: "(() => { let active = document.activeElement; while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement; active?.blur(); })()", contextId: at(role).contextId, returnByValue: true }, at(role).sessionId).catch(() => undefined);
    const deadline = Date.now() + lateWaitMs;
    while ((await field(page, at(role), role, "probe")).found !== true) {
      if (Date.now() >= deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return true;
  };
  const scrub = async () => { for (const role of filled) await field(page, at(role), role, "clear").catch(() => undefined); };
  // A pane's Chrome has no focused window (Xvfb), where document.hasFocus() stays false; the fill emulates focus for its own
  // duration, in every frame session it types in.
  const sessions = [...new Set(roles.map((role) => at(role).sessionId))];
  const emulateFocus = async (enabled: boolean) => { for (const session of sessions) await page.cdp.send("Emulation.setFocusEmulationEnabled", { enabled }, session).catch(() => undefined); };
  await emulateFocus(true);
  try {
    for (const role of [...roles.filter((role) => !late.has(role)), ...roles.filter((role) => late.has(role))]) {
      if (late.has(role) && !await opens(role)) { disabled.push(role); continue; }
      const live = await sameTarget();
      if (live !== "OK") { await scrub(); return result("ORIGIN_MISMATCH", live, null, typed); }
      const focus = await field(page, at(role), role, "focus");
      if (focus.focused !== true) { await scrub(); return result("BLOCKED", "FOCUS_LOST", null, typed); }
      const value = values.get(role)!;
      typed = true;
      await page.cdp.send("Input.insertText", { text: value }, at(role).sessionId);
      filled.push(role);
      if ((await field(page, at(role), role, "check", DIGIT_ROLES.test(role) ? value.replace(/\D/g, "").length : value.length)).filled !== true) { await scrub(); return result("BLOCKED", "FILL_FAILED", null, typed); }
    }
    if (!filled.length) return result("BLOCKED", "FIELD_DISABLED", null, typed);
    // An expiry typed in two boxes answers as the one field the agent asked for.
    const named = (list: Role[]) => [...new Set(list.map((role) => role.startsWith("CARD_EXPIRY") ? "CARD_EXPIRY" : role))] as Fields["filled"];
    const fields = { filled: named(filled), disabled: named(disabled) };
    if (disabled.length) return result("FILLED", "FIELD_DISABLED", sealedGenerated, typed, fields);
    if (submit) {
      const live = await sameTarget();
      if (live !== "OK") { await scrub(); return result("ORIGIN_MISMATCH", live, null, typed); }
      const last = filled[filled.length - 1]!;
      const form = await field(page, at(last), last, "submit");
      if (form.form !== true) return result("FILLED", "NO_FORM", sealedGenerated, typed, fields);
      if (form.button === false) return result("FILLED", "NO_SUBMIT_BUTTON", sealedGenerated, typed, fields);
      if (form.clicked === true) return result("SUBMITTED", null, sealedGenerated, typed, fields);
      if (form.focused !== true) return result("FILLED", "FOCUS_LOST", sealedGenerated, typed, fields);
      // A person's Enter on the last field, never form.requestSubmit(): a submit no key or click started skips the page's own
      // handler, so the browser posts the form itself (AWS sign-in answered that post 400 Bad Request, 13/11).
      for (const type of ["keyDown", "keyUp"]) {
        await page.cdp.send("Input.dispatchKeyEvent", { type, key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13,
          ...(type === "keyDown" ? { text: "\r", unmodifiedText: "\r" } : {}) }, at(last).sessionId);
      }
      return result("SUBMITTED", null, sealedGenerated, typed, fields);
    }
    return result("FILLED", null, sealedGenerated, typed, fields);
  } catch {
    await scrub();
    return result("BLOCKED", "FILL_FAILED", null, typed);
  } finally {
    values.clear();
    await emulateFocus(false);
  }
}

/**
 * NEW_ACCOUNT under the operator's sign-up grant (option B). The request binds this pane's live target, frame and exact
 * origin; the fields are found before the broker is asked; the broker checks the grant and generates the password, sealed to
 * the inbox key (returned as is) and to this call's one-time reply key (opened here only to type it). A broker refusal comes
 * back as its reason code (DAILY_CAP, EXPIRED, REVOKED, ORIGIN_MISMATCH, ...).
 */
export async function runSealedSignup(page: SealedFillPage, broker: SealedFillBroker, rawRequest: unknown, options: SealedFillOptions = {}): Promise<VaultHostFillResult> {
  let document: string | null = null;
  const result = answering(() => document);
  const parsed = vaultHostSignupRequestSchema.safeParse(rawRequest);
  if (!parsed.success) return result("BLOCKED", "BAD_REQUEST");
  const request = parsed.data;
  if (request.paneId !== page.paneId) return result("BLOCKED", "PANE_MISMATCH");
  const sameTarget = async (): Promise<"OK" | "TARGET_CHANGED" | "ORIGIN_CHANGED" | "NOT_ELIGIBLE"> => {
    const live = await readVaultTarget(page);
    if (!live.eligible) return "NOT_ELIGIBLE";
    if (live.targetId !== request.targetId || live.frameId !== request.frameId) return "TARGET_CHANGED";
    return live.origin === request.origin ? "OK" : "ORIGIN_CHANGED";
  };
  const before = await sameTarget();
  if (before === "NOT_ELIGIBLE") return result("BLOCKED", "NO_WEB_ORIGIN");
  if (before !== "OK") return result("ORIGIN_MISMATCH", before);
  const reloaded = request.freshDocument !== false;
  if (reloaded && await formResult(page)) return result("BLOCKED", "RELOAD_WOULD_RESUBMIT");
  document = reloaded ? await freshDocument(page, request.frameId, options.reloadTimeoutMs ?? VAULT_FILL_RELOAD_TIMEOUT_MS) : (await readVaultTarget(page)).document ?? null;
  if (reloaded && !document) return result("BLOCKED", "NO_FRESH_DOCUMENT");
  const after = await sameTarget();
  if (after !== "OK") return after === "NOT_ELIGIBLE" ? result("BLOCKED", "NO_WEB_ORIGIN") : result("ORIGIN_MISMATCH", after);
  const roles: Role[] = request.roles;
  const top: Where = { sessionId: page.sessionId, contextId: await isolatedWorld(page, request.frameId) };
  const constraints = new Map<Role, Record<string, unknown>>();
  const late = new Set<Role>();
  for (const role of roles) {
    const probe = await locate(page, top, role, late);
    if (!probe) return result("BLOCKED", reloaded ? "FIELD_NOT_FOUND_AFTER_RELOAD" : "FIELD_NOT_FOUND");
    constraints.set(role, probe);
  }
  const typedRoles = await withConfirm(page, top, roles, late);
  const target = constraints.get("NEW_PASSWORD") ?? constraints.get(roles[0]!)!;
  const reply = await generateVaultTransportKey();
  const scope = { ownerUserId: request.ownerUserId, vaultId: request.vaultId, keyVersion: 1 };
  const values = new Map<Role, string>();
  let sealedPassword: VaultTransportEnvelope;
  try {
    const sealed = await broker.signup({ ownerUserId: request.ownerUserId, vaultId: request.vaultId, certificate: request.certificate, origin: request.origin,
      paneId: request.paneId, roles: request.roles, inboxPublicKey: request.inboxPublicKey, replyPublicKey: vaultBase64url.encode(reply.publicKey),
      field: signupField({ minLength: (target.minLength as number | null) ?? null, maxLength: (target.maxLength as number | null) ?? null }, request.policy) });
    const opened = await openWithVaultPrivateKey(reply.privateKey, reply.publicKey, sealed.sealedFields, scope);
    const secrets = JSON.parse(new TextDecoder().decode(opened)) as Partial<Record<Role, string>>;
    wipeVaultBytes(opened);
    for (const role of roles) {
      if (!secrets[role]) return result("BLOCKED", "BROKER_REFUSED");
      values.set(role, secrets[role]!);
    }
    if (!values.has("CONFIRM_PASSWORD") && typedRoles.includes("CONFIRM_PASSWORD")) values.set("CONFIRM_PASSWORD", values.get("NEW_PASSWORD")!);
    sealedPassword = sealed.sealedPassword;
  } catch (error) {
    const reason = (error as { reason?: unknown } | null)?.reason;
    return result("BLOCKED", typeof reason === "string" && /^[A-Z][A-Z0-9_]{0,39}$/.test(reason) ? reason : "BROKER_REFUSED");
  } finally {
    wipeVaultBytes(reply.privateKey);
  }
  return typeIn(page, () => top, typedRoles, values, sameTarget, request.submit, sealedPassword, result, late, options.lateFieldWaitMs ?? VAULT_LATE_FIELD_WAIT_MS);
}
