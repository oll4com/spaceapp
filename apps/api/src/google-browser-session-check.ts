import { randomUUID } from "node:crypto";
import { readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";

// Verifies a persistent Chrome profile against Google itself. Cookies, emails,
// names and tokens stay inside the browser page; only booleans leave it and only
// the classified status below is persisted.

export const googleBrowserStatusSchema = z.enum(["NOT_CONNECTED", "CONNECTED", "REAUTHENTICATION_REQUIRED", "UNKNOWN"]);
export type GoogleBrowserStatus = z.infer<typeof googleBrowserStatusSchema>;

export const googleBrowserStatusReasonSchema = z.enum([
  "VERIFIED",
  "PROFILE_MISSING",
  "NO_GOOGLE_SESSION",
  "OTHER_ACCOUNT",
  "SESSION_EXPIRED",
  "SESSION_LOST",
  "SIGNED_OUT",
  "SIGN_IN_PAGE",
  "NOT_CHECKED",
  "CHECK_FAILED",
  "BROWSER_UNAVAILABLE"
]);
export type GoogleBrowserStatusReason = z.infer<typeof googleBrowserStatusReasonSchema>;

const googleBrowserCheckSchema = z.object({
  version: z.literal(1),
  status: googleBrowserStatusSchema,
  reason: googleBrowserStatusReasonSchema,
  matchedBy: z.enum(["SUB", "EMAIL"]).nullable(),
  checkedAt: z.string().datetime(),
  connectedAt: z.string().datetime().nullable()
}).strict();
export type GoogleBrowserCheck = z.infer<typeof googleBrowserCheckSchema>;

const evidenceAccountSchema = z.object({
  subMatches: z.boolean(),
  emailMatches: z.boolean(),
  valid: z.boolean(),
  signedOut: z.boolean()
}).strict();
export const googleBrowserEvidenceSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), httpStatus: z.number().int(), accounts: z.array(evidenceAccountSchema).max(20) }).strict(),
  z.object({ ok: z.literal(false), httpStatus: z.number().int().nullable(), error: z.enum(["HTTP", "MALFORMED", "NETWORK"]) }).strict()
]);
export type GoogleBrowserEvidence = z.infer<typeof googleBrowserEvidenceSchema>;

/** Static first-party page used only as a same-origin context; it runs no Google script. */
export const googleBrowserCheckPageUrl = "https://accounts.google.com/robots.txt";

export function canonicalGoogleEmail(email: string): string {
  const lower = email.trim().toLowerCase();
  const at = lower.lastIndexOf("@");
  if (at < 1) return lower;
  const domain = lower.slice(at + 1);
  return domain === "gmail.com" || domain === "googlemail.com" ? `${lower.slice(0, at).replaceAll(".", "")}@gmail.com` : lower;
}

/**
 * Runs inside the profile's accounts.google.com page. It mirrors Chromium's own
 * ListAccounts parsing (email [3], valid [9], gaia id [10], signed out [14]).
 */
export function googleListAccountsExpression(expected: { sub: string; email: string }): string {
  const sub = JSON.stringify(expected.sub);
  const email = JSON.stringify(canonicalGoogleEmail(expected.email));
  return `(async () => {
  const expectedSub = ${sub};
  const expectedEmail = ${email};
  const canonical = (value) => {
    const lower = String(value).trim().toLowerCase();
    const at = lower.lastIndexOf("@");
    if (at < 1) return lower;
    const domain = lower.slice(at + 1);
    return domain === "gmail.com" || domain === "googlemail.com" ? lower.slice(0, at).split(".").join("") + "@gmail.com" : lower;
  };
  let response;
  try {
    response = await fetch("/ListAccounts?gpsia=1&source=ChromiumBrowser&json=standard", {
      method: "POST", credentials: "include", cache: "no-store", redirect: "error",
      headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: " "
    });
  } catch { return { ok: false, httpStatus: null, error: "NETWORK" }; }
  if (!response.ok) return { ok: false, httpStatus: response.status, error: "HTTP" };
  let data;
  try { data = JSON.parse((await response.text()).replace(/^\\)\\]\\}'\\s*/, "")); }
  catch { return { ok: false, httpStatus: response.status, error: "MALFORMED" }; }
  if (!Array.isArray(data) || !Array.isArray(data[1])) return { ok: false, httpStatus: response.status, error: "MALFORMED" };
  const accounts = [];
  for (const entry of data[1]) {
    if (!Array.isArray(entry) || entry.length < 4 || typeof entry[3] !== "string" || !entry[3]) continue;
    accounts.push({
      subMatches: typeof entry[10] === "string" && entry[10] === expectedSub,
      emailMatches: canonical(entry[3]) === expectedEmail,
      valid: typeof entry[9] === "number" ? entry[9] !== 0 : true,
      signedOut: typeof entry[14] === "number" ? entry[14] !== 0 : false
    });
    if (accounts.length === 20) break;
  }
  return { ok: true, httpStatus: response.status, accounts };
})()`;
}

const googleBrowserCheckResultSchema = z.object({
  status: googleBrowserStatusSchema,
  reason: googleBrowserStatusReasonSchema,
  checkedAt: z.string().datetime().nullable(),
  connectedAt: z.string().datetime().nullable()
});
export type GoogleBrowserCheckResult = z.infer<typeof googleBrowserCheckResultSchema>;

/** Validates a Browser Host IPC answer; anything unexpected is UNKNOWN, never a logout. */
export function normalizeGoogleBrowserCheckResult(value: unknown): GoogleBrowserCheckResult {
  const parsed = googleBrowserCheckResultSchema.safeParse(value);
  if (parsed.success) return { status: parsed.data.status, reason: parsed.data.reason, checkedAt: parsed.data.checkedAt, connectedAt: parsed.data.connectedAt };
  return { status: "UNKNOWN", reason: "CHECK_FAILED", checkedAt: null, connectedAt: null };
}

export function parseGoogleBrowserEvidence(value: unknown): GoogleBrowserEvidence {
  const parsed = googleBrowserEvidenceSchema.safeParse(value);
  return parsed.success ? parsed.data : { ok: false, httpStatus: null, error: "MALFORMED" };
}

/** A failed check never becomes a logout; it is returned as UNKNOWN and not persisted. */
export function classifyGoogleBrowserEvidence(
  evidence: GoogleBrowserEvidence,
  previous: Pick<GoogleBrowserCheck, "connectedAt"> | null,
  checkedAt: string
): GoogleBrowserCheck {
  const connectedAt = previous?.connectedAt ?? null;
  const result = (status: GoogleBrowserStatus, reason: GoogleBrowserStatusReason, matchedBy: GoogleBrowserCheck["matchedBy"] = null, connected = connectedAt): GoogleBrowserCheck =>
    ({ version: 1, status, reason, matchedBy, checkedAt, connectedAt: connected });
  if (!evidence.ok) return result("UNKNOWN", "CHECK_FAILED");
  const bySub = evidence.accounts.find(account => account.subMatches);
  const match = bySub ?? evidence.accounts.find(account => account.emailMatches);
  const matchedBy = bySub ? "SUB" : match ? "EMAIL" : null;
  if (match) {
    if (match.signedOut) return result("REAUTHENTICATION_REQUIRED", "SIGNED_OUT", matchedBy);
    if (!match.valid) return result("REAUTHENTICATION_REQUIRED", "SESSION_EXPIRED", matchedBy);
    return result("CONNECTED", "VERIFIED", matchedBy, checkedAt);
  }
  if (evidence.accounts.some(account => account.valid && !account.signedOut)) return result("NOT_CONNECTED", "OTHER_ACCOUNT");
  return connectedAt ? result("REAUTHENTICATION_REQUIRED", "SESSION_LOST") : result("NOT_CONNECTED", "NO_GOOGLE_SESSION");
}

export function googleBrowserCheckPathFor(profilePath: string): string {
  return `${profilePath}.browser-check.json`;
}

export async function readGoogleBrowserCheck(profilePath: string): Promise<GoogleBrowserCheck | null> {
  try {
    const parsed = googleBrowserCheckSchema.safeParse(JSON.parse(await readFile(googleBrowserCheckPathFor(profilePath), "utf8")));
    return parsed.success ? parsed.data : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) return null;
    throw error;
  }
}

export async function writeGoogleBrowserCheck(profilePath: string, check: GoogleBrowserCheck): Promise<void> {
  const path = googleBrowserCheckPathFor(profilePath);
  const temporary = `${path}.${randomUUID()}`;
  try {
    await writeFile(temporary, JSON.stringify(googleBrowserCheckSchema.parse(check)), { mode: 0o600, flag: "wx" });
    await rename(temporary, path);
  } finally { await unlink(temporary).catch(() => undefined); }
}

export interface GoogleBrowserStatusSummary {
  browserStatus: GoogleBrowserStatus;
  browserStatusReason: GoogleBrowserStatusReason;
  browserCheckedAt: string | null;
  browserConnectedAt: string | null;
}

/**
 * Settings/selector state. Only a Google check proves CONNECTED; a profile
 * directory, cookies or an arbitrary open page never do.
 */
export function summarizeGoogleBrowserStatus(input: { profileExists: boolean; check: GoogleBrowserCheck | null; activeUrls: Array<string | null> }): GoogleBrowserStatusSummary {
  const connectedAt = input.check?.connectedAt ?? null;
  if (!input.profileExists) return { browserStatus: "NOT_CONNECTED", browserStatusReason: "PROFILE_MISSING", browserCheckedAt: null, browserConnectedAt: connectedAt };
  if (input.check) return { browserStatus: input.check.status, browserStatusReason: input.check.reason, browserCheckedAt: input.check.checkedAt, browserConnectedAt: connectedAt };
  if (input.activeUrls.some(url => isGoogleAuthenticationUrl(url))) return { browserStatus: "NOT_CONNECTED", browserStatusReason: "SIGN_IN_PAGE", browserCheckedAt: null, browserConnectedAt: null };
  return { browserStatus: "UNKNOWN", browserStatusReason: "NOT_CHECKED", browserCheckedAt: null, browserConnectedAt: null };
}

/** Google authentication navigations that can change the profile's signed-in state. */
export function isGoogleAuthenticationUrl(raw: string | null | undefined): boolean {
  if (!raw) return false;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:") return false;
    if (url.hostname === "accounts.google.com") return url.pathname !== "/robots.txt";
    return /(^|\.)(google|youtube)\.com$/.test(url.hostname) && /^\/logout(?:$|\/)/i.test(url.pathname);
  } catch { return false; }
}

/**
 * Cheap pre-filter before launching Chrome: does the profile hold any Google
 * session cookie rows? Reads cookie names/expiry only, never values. Presence is
 * not evidence of a working login; only a ListAccounts check is.
 */
export async function googleSignInCookieState(profilePath: string): Promise<{ hasSignInCookies: boolean; modifiedMs: number | null }> {
  for (const relative of ["Default/Network/Cookies", "Default/Cookies"]) {
    const path = join(profilePath, relative);
    let modifiedMs: number;
    try { modifiedMs = (await stat(path)).mtimeMs; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      const chromeNow = (Date.now() + 11644473600000) * 1000;
      const row = db.prepare(`SELECT 1 FROM cookies WHERE (host_key IN ('google.com', '.google.com', 'youtube.com', '.youtube.com') OR host_key LIKE '%.google.com' OR host_key LIKE '%.youtube.com')
        AND name IN ('SID', '__Secure-1PSID', '__Secure-3PSID') AND (is_persistent = 0 OR expires_utc > ?) LIMIT 1`).get(chromeNow);
      return { hasSignInCookies: Boolean(row), modifiedMs };
    } finally { db.close(); }
  }
  return { hasSignInCookies: false, modifiedMs: null };
}

/**
 * Selector state of a shared CLI-account profile (e.g. a Gemini account). There is
 * no Google subject to verify it against, so it is read locally: SIGNED_IN when the
 * profile holds a Google session, NOT_CONNECTED when it has no profile or no
 * session, UNKNOWN when the cookie store cannot be read.
 */
export type CliAccountBrowserStatus = "SIGNED_IN" | "NOT_CONNECTED" | "UNKNOWN";
export async function cliAccountBrowserStatus(profilePath: string): Promise<CliAccountBrowserStatus> {
  try { return (await googleSignInCookieState(profilePath)).hasSignInCookies ? "SIGNED_IN" : "NOT_CONNECTED"; }
  catch { return "UNKNOWN"; }
}

const adoptionProbeSchema = z.object({
  version: z.literal(1),
  cookiesModifiedMs: z.number(),
  result: z.enum(["NO_SIGN_IN", "OTHER_ACCOUNT"]),
  checkedAt: z.string().datetime()
}).strict();

/** Remembers a definite "nothing to adopt" answer until the profile's cookies change. */
export async function readAdoptionProbe(profilePath: string): Promise<z.infer<typeof adoptionProbeSchema> | null> {
  try {
    const parsed = adoptionProbeSchema.safeParse(JSON.parse(await readFile(`${profilePath}.account-probe.json`, "utf8")));
    return parsed.success ? parsed.data : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) return null;
    throw error;
  }
}

export async function writeAdoptionProbe(profilePath: string, value: z.infer<typeof adoptionProbeSchema>): Promise<void> {
  const path = `${profilePath}.account-probe.json`;
  const temporary = `${path}.${randomUUID()}`;
  try {
    await writeFile(temporary, JSON.stringify(adoptionProbeSchema.parse(value)), { mode: 0o600, flag: "wx" });
    await rename(temporary, path);
  } finally { await unlink(temporary).catch(() => undefined); }
}
