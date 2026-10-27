import {
  canonicalVaultOrigin, decodeVaultBase32, generateVaultPassword, generateVaultTransportKey, openWithVaultPrivateKey, sealToVaultPublicKey,
  vaultBase64url, vaultHostFillRequestSchema, vaultHostSignupRequestSchema, vaultTotp, wipeVaultBytes, type VaultHostFillResult, type VaultHostTarget,
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
    inboxPublicKey: string; replyPublicKey: string; field: { minLength: number | null; maxLength: number | null };
  }): Promise<{ sealedPassword: VaultTransportEnvelope; sealedFields: VaultTransportEnvelope }>;
}

type Role = "USERNAME" | "PASSWORD" | "OTP" | "NEW_PASSWORD" | "CONFIRM_PASSWORD";
type FieldAction = "probe" | "focus" | "check" | "clear" | "submit";

/** One fixed script per action: the role, action and expected length are the only inputs, all chosen here. */
export function vaultFieldScript(role: Role, action: FieldAction, expectLength = 0): string {
  return `(() => {
  const role = ${JSON.stringify(role)}, action = ${JSON.stringify(action)}, expectLength = ${Number(expectLength) | 0};
  const usable = (el) => { const box = el.getBoundingClientRect(); const style = getComputedStyle(el);
    return box.width > 0 && box.height > 0 && style.visibility !== "hidden" && style.display !== "none" && !el.disabled && !el.readOnly; };
  const pick = (selector) => Array.from(document.querySelectorAll(selector)).filter(usable);
  const named = (el, pattern) => pattern.test(String(el.name) + " " + String(el.id));
  const passwords = pick('input[type="password"]');
  const fresh = passwords.filter((el) => /\\bnew-password\\b/.test(el.autocomplete));
  let el = null;
  if (role === "USERNAME") el = pick('input[autocomplete~="username"],input[autocomplete~="email"],input[type="email"]')[0]
    || pick('input[type="text"],input:not([type])').find((candidate) => named(candidate, /user|email|login/i)) || null;
  else if (role === "PASSWORD") el = passwords.find((candidate) => !/\\bnew-password\\b/.test(candidate.autocomplete)) || null;
  else if (role === "NEW_PASSWORD") el = fresh[0] || passwords[0] || null;
  else if (role === "CONFIRM_PASSWORD") el = (fresh.length > 1 ? fresh[1] : passwords[1]) || null;
  else if (role === "OTP") el = pick('input[autocomplete~="one-time-code"]')[0]
    || pick('input:not([type="password"])').find((candidate) => named(candidate, /otp|totp|2fa|mfa|verification|code/i)) || null;
  if (!el) return { found: false };
  if (action === "focus") { el.focus(); if (typeof el.select === "function") el.select(); return { found: true, focused: document.activeElement === el && document.hasFocus() }; }
  if (action === "check") return { found: true, filled: el.value.length === expectLength };
  if (action === "clear") { el.value = ""; el.dispatchEvent(new Event("input", { bubbles: true })); return { found: true }; }
  if (action === "submit") { const form = el.form; if (!form) return { found: true, submitted: false };
    if (typeof form.requestSubmit === "function") form.requestSubmit(); else form.submit(); return { found: true, submitted: true }; }
  return { found: true, maxLength: el.maxLength > 0 ? el.maxLength : null, minLength: el.minLength > 0 ? el.minLength : null,
    pattern: el.getAttribute("pattern"), passwordRules: el.getAttribute("passwordrules") };
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
  // freshDocument: this host takes the field in fill requests (the API sends it only to a host that says so).
  return { eligible: true, reason: null, targetId: page.targetId, frameId: frame.id, origin, document: typeof frame.loaderId === "string" ? frame.loaderId.slice(0, 128) : null, freshDocument: true };
}

async function isolatedWorld(page: SealedFillPage, frameId: string): Promise<number> {
  const world = await page.cdp.send<{ executionContextId?: number }>("Page.createIsolatedWorld", { frameId, worldName: "space-vault-fill", grantUniveralAccess: false }, page.sessionId);
  if (typeof world.executionContextId !== "number") throw new Error("NO_ISOLATED_WORLD");
  return world.executionContextId;
}

async function field(page: SealedFillPage, contextId: number, role: Role, action: FieldAction, expectLength?: number): Promise<Record<string, unknown>> {
  const answer = await page.cdp.send<{ result?: { value?: unknown }; exceptionDetails?: unknown }>("Runtime.evaluate",
    { expression: vaultFieldScript(role, action, expectLength), contextId, returnByValue: true, awaitPromise: false }, page.sessionId);
  // An exception's text could carry page content: it is never read, only treated as "not found".
  const value = answer.exceptionDetails ? null : answer.result?.value;
  return value && typeof value === "object" ? value as Record<string, unknown> : { found: false };
}

/** The answer's shape: `typed` once a value entered the page, `document` the top frame's document the fill ran in (null before the reload). */
type Answer = (status: VaultHostFillResult["status"], reason: string | null, sealedGenerated?: VaultTransportEnvelope | null, typed?: boolean) => VaultHostFillResult;
const answering = (document: () => string | null): Answer => (status, reason, sealedGenerated = null, typed = false) => ({ status, reason, sealedGenerated, typed, document: document() });

/** How long the reload before a fill may take; a page that never settles (a beforeunload dialog, a dead server) stops the fill. */
export const VAULT_FILL_RELOAD_TIMEOUT_MS = 15_000;
export interface SealedFillOptions { reloadTimeoutMs?: number }

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

export async function runSealedFill(page: SealedFillPage, broker: SealedFillBroker, rawRequest: unknown, now = new Date(), options: SealedFillOptions = {}): Promise<VaultHostFillResult> {
  if ((rawRequest as { mode?: unknown } | null)?.mode === "SIGNUP") return runSealedSignup(page, broker, rawRequest, options);
  let document: string | null = null;
  const result = answering(() => document);
  const parsed = vaultHostFillRequestSchema.safeParse(rawRequest);
  if (!parsed.success) return result("BLOCKED", "BAD_REQUEST");
  const request = parsed.data;
  let claims: VaultUseClaims;
  try { claims = await broker.verifyUse(request.capability, now); } catch { return result("BLOCKED", "CAPABILITY_INVALID"); }
  if (claims.paneId !== page.paneId) return result("BLOCKED", "PANE_MISMATCH");
  const roles: Role[] = request.mode === "TOTP" ? ["OTP"] : request.mode === "GENERATE" ? claims.generate?.roles ?? [] : claims.fields.filter((role) => role !== "OTP");
  if (roles.length === 0 || (request.mode === "TOTP" && !claims.fields.includes("OTP")) || (request.mode === "GENERATE" && !claims.generate)) return result("BLOCKED", "MODE_MISMATCH");

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
  document = reloaded ? await freshDocument(page, claims.frameId, options.reloadTimeoutMs ?? VAULT_FILL_RELOAD_TIMEOUT_MS) : (await readVaultTarget(page)).document ?? null;
  if (reloaded && !document) return result("BLOCKED", "NO_FRESH_DOCUMENT");
  const after = await sameTarget();
  if (after !== "OK") return after === "NOT_ELIGIBLE" ? result("BLOCKED", "NO_WEB_ORIGIN") : result("ORIGIN_MISMATCH", after);

  // Every field is found before any secret exists in this process. After a reload the missing field has its own code: the agent
  // redoes the steps that showed it, with navigate, click, type and press only, and the next fill needs no reload.
  const contextId = await isolatedWorld(page, claims.frameId);
  const constraints = new Map<Role, Record<string, unknown>>();
  for (const role of roles) {
    const probe = await field(page, contextId, role, "probe");
    if (probe.found !== true) return result("BLOCKED", reloaded ? "FIELD_NOT_FOUND_AFTER_RELOAD" : "FIELD_NOT_FOUND");
    constraints.set(role, probe);
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
        generated = generateVaultPassword({ maxLength: target.maxLength as number | null, minLength: target.minLength as number | null,
          pattern: target.pattern as string | null, passwordRules: target.passwordRules as string | null });
      } catch { return result("BLOCKED", "POLICY_UNSATISFIABLE"); }
      for (const role of roles) values.set(role, generated);
    } else {
      for (const role of roles) {
        const value = secrets[role];
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
  return typeIn(page, contextId, roles, values, sameTarget, claims.submit, sealedGenerated, result);
}

/**
 * Types each value into its field through Input.insertText, re-checking the live page before each; clears what it typed on any
 * stop. The answer says `typed` from the first insert on, even when the stop came after it (the scrub is best effort and cannot
 * reach a field a page script moved the focus to), so the API keeps the fence.
 */
async function typeIn(page: SealedFillPage, contextId: number, roles: Role[], values: Map<Role, string>, sameTarget: () => Promise<string>,
  submit: boolean, sealedGenerated: VaultTransportEnvelope | null, result: Answer): Promise<VaultHostFillResult> {
  const filled: Role[] = [];
  let typed = false;
  const scrub = async () => { for (const role of filled) await field(page, contextId, role, "clear").catch(() => undefined); };
  // A pane's Chrome has no focused window (Xvfb), where document.hasFocus() stays false; the fill emulates focus for its own duration.
  const emulateFocus = (enabled: boolean) => page.cdp.send("Emulation.setFocusEmulationEnabled", { enabled }, page.sessionId).catch(() => undefined);
  await emulateFocus(true);
  try {
    for (const role of roles) {
      const live = await sameTarget();
      if (live !== "OK") { await scrub(); return result("ORIGIN_MISMATCH", live, null, typed); }
      const focus = await field(page, contextId, role, "focus");
      if (focus.focused !== true) { await scrub(); return result("BLOCKED", "FOCUS_LOST", null, typed); }
      const value = values.get(role)!;
      typed = true;
      await page.cdp.send("Input.insertText", { text: value }, page.sessionId);
      filled.push(role);
      if ((await field(page, contextId, role, "check", value.length)).filled !== true) { await scrub(); return result("BLOCKED", "FILL_FAILED", null, typed); }
    }
    if (submit) {
      const live = await sameTarget();
      if (live !== "OK") { await scrub(); return result("ORIGIN_MISMATCH", live, null, typed); }
      const submitted = await field(page, contextId, roles[roles.length - 1]!, "submit");
      return submitted.submitted === true ? result("SUBMITTED", null, sealedGenerated, typed) : result("FILLED", "NO_FORM", sealedGenerated, typed);
    }
    return result("FILLED", null, sealedGenerated, typed);
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
  document = reloaded ? await freshDocument(page, request.frameId, options.reloadTimeoutMs ?? VAULT_FILL_RELOAD_TIMEOUT_MS) : (await readVaultTarget(page)).document ?? null;
  if (reloaded && !document) return result("BLOCKED", "NO_FRESH_DOCUMENT");
  const after = await sameTarget();
  if (after !== "OK") return after === "NOT_ELIGIBLE" ? result("BLOCKED", "NO_WEB_ORIGIN") : result("ORIGIN_MISMATCH", after);
  const roles: Role[] = request.roles;
  const contextId = await isolatedWorld(page, request.frameId);
  const constraints = new Map<Role, Record<string, unknown>>();
  for (const role of roles) {
    const probe = await field(page, contextId, role, "probe");
    if (probe.found !== true) return result("BLOCKED", reloaded ? "FIELD_NOT_FOUND_AFTER_RELOAD" : "FIELD_NOT_FOUND");
    constraints.set(role, probe);
  }
  const target = constraints.get("NEW_PASSWORD") ?? constraints.get(roles[0]!)!;
  const reply = await generateVaultTransportKey();
  const scope = { ownerUserId: request.ownerUserId, vaultId: request.vaultId, keyVersion: 1 };
  const values = new Map<Role, string>();
  let sealedPassword: VaultTransportEnvelope;
  try {
    const sealed = await broker.signup({ ownerUserId: request.ownerUserId, vaultId: request.vaultId, certificate: request.certificate, origin: request.origin,
      paneId: request.paneId, roles: request.roles, inboxPublicKey: request.inboxPublicKey, replyPublicKey: vaultBase64url.encode(reply.publicKey),
      field: { minLength: (target.minLength as number | null) ?? null, maxLength: (target.maxLength as number | null) ?? null } });
    const opened = await openWithVaultPrivateKey(reply.privateKey, reply.publicKey, sealed.sealedFields, scope);
    const secrets = JSON.parse(new TextDecoder().decode(opened)) as Partial<Record<Role, string>>;
    wipeVaultBytes(opened);
    for (const role of roles) {
      if (!secrets[role]) return result("BLOCKED", "BROKER_REFUSED");
      values.set(role, secrets[role]!);
    }
    sealedPassword = sealed.sealedPassword;
  } catch (error) {
    const reason = (error as { reason?: unknown } | null)?.reason;
    return result("BLOCKED", typeof reason === "string" && /^[A-Z][A-Z0-9_]{0,39}$/.test(reason) ? reason : "BROKER_REFUSED");
  } finally {
    wipeVaultBytes(reply.privateKey);
  }
  return typeIn(page, contextId, roles, values, sameTarget, request.submit, sealedPassword, result);
}
