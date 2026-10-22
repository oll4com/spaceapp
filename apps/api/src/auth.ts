import { existsSync, readFileSync } from "node:fs";
import { createHash, createHmac, createPublicKey, randomBytes, scrypt as scryptCallback, timingSafeEqual, verify as verifySignature, type KeyObject, type ScryptOptions } from "node:crypto";
import { authUserSchema, resolveSpaceInstance, sessionCookieNameFor, type AuthUser, type LoginInput } from "@space/contracts";
import { persistentOperatorSessionTtlSeconds, signPersistentOperatorSessionToken, signSessionTokenWithTtl } from "@space/runtime";
import { ANTIGRAVITY_CLIENT_ID, ANTIGRAVITY_CLIENT_SECRET } from "./antigravity-usage-services.js";

// A dev instance on another port of the same host must not overwrite the stable session cookie.
const SESSION_COOKIE = sessionCookieNameFor(resolveSpaceInstance(process.env));
const CSRF_HEADER = "x-space-csrf-token";
const DEV_OPERATOR_EMAIL = "space@space.local";
const SCRYPT_MAXMEM_BYTES = 128 * 1024 * 1024;
export const operatorSessionTtlSeconds = persistentOperatorSessionTtlSeconds;

function deriveScrypt(password: string, salt: string, keylen: number, options: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(password, salt, keylen, { maxmem: SCRYPT_MAXMEM_BYTES, ...options }, (error, derivedKey) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(Buffer.from(derivedKey));
    });
  });
}

export interface AuthConfig {
  sessionSecret: string;
  operatorEmail?: string;
  operatorPasswordHash?: string;
  devLogin: boolean;
  /** "auto": Secure exactly when the request came over https (X-Forwarded-Proto from the trusted proxy). */
  secureCookies: boolean | "auto";
  googleClientId?: string;
  googleClientSecret?: string;
  googleRedirectUri?: string;
}

export interface GoogleAuthUserInfo {
  email: string;
  sub: string;
  name?: string;
  picture?: string;
}

export interface SessionPayload {
  user: AuthUser;
  exp: number;
  iat?: number;
  /** 2: a sliding operator session (security addendum step 12); absent on older cookies and ephemeral sessions. */
  v?: 2;
  /** The CSRF token clients derived from the cookie this one renewed, so their cached value keeps working. */
  lc?: string;
  /** One id for a session and all its renewals, so logging out ends every copy of it. */
  sid?: string;
}

export const cookieName = SESSION_COOKIE;
export const csrfHeaderName = CSRF_HEADER;

export function getAuthConfig(env: NodeJS.ProcessEnv): AuthConfig {
  let googleClientId = env.SPACE_GOOGLE_CLIENT_ID || env.GOOGLE_CLIENT_ID || undefined;
  let googleClientSecret = env.SPACE_GOOGLE_CLIENT_SECRET || env.GOOGLE_CLIENT_SECRET || undefined;
  if (!googleClientId) {
    try {
      const candidates = ["/opt/spaceapp/secrets/google-oauth.json", "/var/lib/spaceapp/google-oauth.json"];
      for (const p of candidates) {
        if (existsSync(p)) {
          const raw = JSON.parse(readFileSync(p, "utf8"));
          if (raw.clientId && raw.clientSecret) {
            googleClientId = raw.clientId;
            googleClientSecret = raw.clientSecret;
            break;
          }
        }
      }
    } catch {}
  }
  // The Antigravity OAuth client is shared with every Antigravity install, so an ID
  // token minted for any of them would satisfy the audience check. Google login
  // therefore needs an installation-specific client unless the shared one is
  // explicitly opted into (SPACE_GOOGLE_SHARED_CLIENT=true).
  if (!googleClientId && env.SPACE_GOOGLE_AUTH_DISABLED !== "true" && env.SPACE_GOOGLE_SHARED_CLIENT === "true") {
    googleClientId = ANTIGRAVITY_CLIENT_ID;
    googleClientSecret = ANTIGRAVITY_CLIENT_SECRET;
  }
  return {
    sessionSecret: env.SPACE_SESSION_SECRET ?? "",
    operatorEmail: env.SPACE_OPERATOR_EMAIL,
    operatorPasswordHash: env.SPACE_OPERATOR_PASSWORD_HASH,
    devLogin: env.NODE_ENV !== "production" && env.SPACE_DEV_LOGIN === "true",
    // NODE_ENV is unset on stable and dev, so the cookies of the https instances had no Secure flag (hardening step 11).
    secureCookies: env.NODE_ENV === "production" ? true : "auto",
    googleClientId,
    googleClientSecret,
    googleRedirectUri: env.SPACE_GOOGLE_REDIRECT_URI || env.GOOGLE_REDIRECT_URI || undefined
  };
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString("base64url");
  const N = 32768;
  const r = 8;
  const p = 1;
  const derived = await deriveScrypt(password, salt, 64, { N, r, p });
  return `scrypt$${N}$${r}$${p}$${salt}$${derived.toString("base64url")}`;
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const [scheme, nValue, rValue, pValue, salt, expectedHash] = encoded.split("$");
  if (scheme !== "scrypt" || !nValue || !rValue || !pValue || !salt || !expectedHash) {
    return false;
  }

  const N = Number.parseInt(nValue, 10);
  const r = Number.parseInt(rValue, 10);
  const p = Number.parseInt(pValue, 10);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) {
    return false;
  }

  const actual = await deriveScrypt(password, salt, 64, { N, r, p });
  const expected = Buffer.from(expectedHash, "base64url");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export async function authenticateLogin(input: LoginInput, config: AuthConfig): Promise<AuthUser | null> {
  if (config.devLogin && input.email === DEV_OPERATOR_EMAIL && input.password === "space-dev") {
    return { id: "user:dev-operator", email: DEV_OPERATOR_EMAIL, role: "ADMIN" };
  }

  if (!config.operatorEmail || !config.operatorPasswordHash) {
    return null;
  }

  if (input.email.toLowerCase() !== config.operatorEmail.toLowerCase()) {
    return null;
  }

  const ok = await verifyPassword(input.password, config.operatorPasswordHash);
  return ok ? { id: "user:operator", email: config.operatorEmail, role: "ADMIN" } : null;
}

const maximumEphemeralSessionTtlSeconds = 60 * 60 * 12;

export function signSessionWithTtl(user: AuthUser, secret: string, ttlSeconds: number, nowMs = Date.now()): string {
  if (secret.length < 16) throw new Error("SPACE_SESSION_SECRET must be at least 16 characters.");
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > maximumEphemeralSessionTtlSeconds) {
    throw new Error(`Session TTL must be an integer between 1 and ${maximumEphemeralSessionTtlSeconds} seconds.`);
  }
  const payload: SessionPayload = {
    user,
    exp: Math.floor(nowMs / 1000) + ttlSeconds,
    iat: Math.floor(nowMs / 1000)
  };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${sig}`;
}

export function signSession(user: AuthUser, secret: string, nowMs = Date.now(), carried: { iat?: number; lc?: string; sid?: string } = {}): string {
  if (user.id === "user:operator-proof") throw new Error("Proof operators cannot receive persistent sessions.");
  if (secret.length < 16) throw new Error("SPACE_SESSION_SECRET must be at least 16 characters.");
  const payload: SessionPayload = {
    user,
    exp: Math.floor(nowMs / 1000) + persistentOperatorSessionTtlSeconds,
    iat: carried.iat ?? Math.floor(nowMs / 1000),
    v: 2,
    sid: carried.sid ?? randomBytes(32).toString("hex"),
    ...(carried.lc ? { lc: carried.lc } : {})
  };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${sig}`;
}

/** The payload of a session token whose signature checks out (expiry and revocation are verifySession's job). */
export function signedSessionPayload(token: string | undefined, secret: string): SessionPayload | null {
  const [body, sig, ...rest] = (token ?? "").split(".");
  if (!body || !sig || rest.length || secret.length < 16) return null;
  const expected = Buffer.from(createHmac("sha256", secret).update(body).digest("base64url"));
  const actual = Buffer.from(sig);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as SessionPayload;
    return payload && typeof payload === "object" && typeof payload.exp === "number" ? payload : null;
  } catch {
    return null;
  }
}

function legacyCsrfToken(sessionToken: string, secret: string): string {
  return createHmac("sha256", secret).update(`csrf:${sessionToken}`).digest("base64url");
}

export function createCsrfToken(sessionToken: string | undefined, secret: string): string | null {
  if (!sessionToken || secret.length < 16) {
    return null;
  }
  // A sliding session keeps one CSRF token across its renewals: it names the session (user and issue time), not the cookie.
  const payload = signedSessionPayload(sessionToken, secret);
  if (payload?.v === 2 && typeof payload.iat === "number" && typeof payload.user?.id === "string") {
    return createHmac("sha256", secret).update(`csrf:v2:${payload.user.id}:${payload.iat}`).digest("base64url");
  }
  return legacyCsrfToken(sessionToken, secret);
}

const slidingSessionRenewBelowSeconds = Math.floor(persistentOperatorSessionTtlSeconds / 2);
const maximumEphemeralLifetimeSeconds = 60 * 60 * 12;

/**
 * The renewed cookie for a persistent operator session that is used (security addendum step 12): a sliding session with
 * less than half its 30 days left, or an older long-lived cookie (it moves to the 30-day lifetime on its next request).
 * The issue time stays, so revoking a user still ends it; null when nothing is due or the token is not one to renew.
 */
export function renewSessionIfDue(sessionToken: string | undefined, secret: string, nowMs = Date.now()): string | null {
  const payload = signedSessionPayload(sessionToken, secret);
  if (!payload || !sessionToken) return null;
  const now = Math.floor(nowMs / 1000);
  if (payload.exp <= now || payload.user?.id === "user:operator-proof") return null;
  const issuedAt = typeof payload.iat === "number" ? payload.iat : undefined;
  if (payload.v === 2) {
    if (payload.exp - now >= slidingSessionRenewBelowSeconds) return null;
    return signSession(payload.user, secret, nowMs, { iat: issuedAt, lc: payload.lc, sid: payload.sid });
  }
  // Ephemeral sessions (proofs, captures: at most 12 hours) are never stretched.
  if (issuedAt !== undefined && payload.exp - issuedAt <= maximumEphemeralLifetimeSeconds) return null;
  // The older cookie's own revocation key becomes the session id: logging out with the renewed cookie revokes it too.
  return signSession(payload.user, secret, nowMs, { iat: issuedAt, lc: legacyCsrfToken(sessionToken, secret), sid: tokenSignatureHash(sessionToken) });
}

export function verifyCsrfToken(sessionToken: string | undefined, submittedToken: unknown, secret: string): boolean {
  if (typeof submittedToken !== "string") {
    return false;
  }
  const expected = createCsrfToken(sessionToken, secret);
  if (!expected) {
    return false;
  }
  const matches = (candidate: string) => {
    const actualBuffer = Buffer.from(submittedToken);
    const expectedBuffer = Buffer.from(candidate);
    return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
  };
  // A client may still hold the token it derived from the cookie before a renewal.
  const carried = signedSessionPayload(sessionToken, secret)?.lc;
  return matches(expected) || matches(legacyCsrfToken(sessionToken!, secret)) || (typeof carried === "string" && matches(carried));
}

export function createAgentPostToken(secret: string, payload: string): string | null {
  if (secret.length < 16) {
    return null;
  }
  return createHmac("sha256", secret).update(`agent-post:${payload}`).digest("base64url");
}

export function verifyAgentPostToken(secret: string, submittedToken: unknown, payload: string): boolean {
  if (typeof submittedToken !== "string") {
    return false;
  }
  const expected = createAgentPostToken(secret, payload);
  if (!expected) {
    return false;
  }
  const actualBuffer = Buffer.from(submittedToken);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}

/** Durable backing for revocations (SEC-011); see @space/db SessionRevocationRepository. */
export interface SessionRevocationPersistence {
  load(nowMs: number): Promise<{ signatures: Array<[string, number]>; userEpochs: Array<[string, number]> }>;
  revokeSignature(signatureSha256: string, expiresAtMs: number): Promise<void>;
  revokeUser(userId: string, revokedBeforeMs: number): Promise<void>;
  pruneExpired(nowMs: number): Promise<number>;
}

// A session token is exactly "<body>.<sig>". Revocation keys on the segment verifySession checks, so a
// segment appended to a revoked token cannot produce another, unrevoked key (external review 2026-10-16).
function tokenSignatureHash(token: string): string {
  const parts = token.split(".");
  const sig = parts.length === 2 && parts[1] ? parts[1] : token;
  return createHash("sha256").update(sig).digest("hex");
}

/** A sliding session's id (64 hex characters, the form the revocation table stores); null otherwise. */
function sessionIdOf(token: string): string | null {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[0] ?? "", "base64url").toString("utf8")) as Partial<SessionPayload>;
    return typeof payload.sid === "string" && /^[0-9a-f]{64}$/.test(payload.sid) ? payload.sid : null;
  } catch {
    return null;
  }
}

export class SessionRevocationStore {
  // Keyed by SHA-256 of the token signature, the same form that is persisted.
  private readonly revokedSignatures = new Map<string, number>();
  private readonly userRevocationEpochs = new Map<string, number>();
  // Writes the database refused; retried on every cleanup tick and after a load (the upserts keep the maximum).
  private readonly unsavedSignatures = new Map<string, number>();
  private readonly unsavedUserEpochs = new Map<string, number>();
  // False from the start of a load until it succeeds: every session is refused meanwhile (fail closed).
  private loaded = true;
  private cleanupTimer: NodeJS.Timeout | null = null;
  private persistence: SessionRevocationPersistence | null = null;

  constructor(cleanupIntervalMs = 60_000) {
    this.cleanupTimer = setInterval(() => this.cleanup(), cleanupIntervalMs);
    if (this.cleanupTimer.unref) this.cleanupTimer.unref();
  }

  /** Loads persisted revocations so a restart does not re-validate logged-out sessions. */
  public async attachPersistence(persistence: SessionRevocationPersistence, nowMs = Date.now()): Promise<void> {
    this.persistence = persistence;
    this.loaded = false;
    const persisted = await persistence.load(nowMs);
    for (const [hash, expiresAt] of persisted.signatures) {
      this.revokedSignatures.set(hash, Math.max(this.revokedSignatures.get(hash) ?? 0, expiresAt));
    }
    for (const [userId, epoch] of persisted.userEpochs) {
      this.userRevocationEpochs.set(userId, Math.max(this.userRevocationEpochs.get(userId) ?? 0, epoch));
    }
    this.loaded = true;
    await this.saveUnsaved();
  }

  public detachPersistence(): void {
    this.persistence = null;
    this.loaded = true;
  }

  /** False while persisted revocations are configured but not loaded yet. */
  public isReady(): boolean {
    return this.loaded;
  }

  /** Revokes in memory at once; the returned promise settles when the revocation is durable. */
  public revokeToken(token: string, expiryMs?: number): Promise<void> {
    if (!token) return Promise.resolve();
    const hash = tokenSignatureHash(token);
    const ttl = expiryMs ?? (Date.now() + 400 * 24 * 60 * 60 * 1000);
    this.revokedSignatures.set(hash, ttl);
    // A renewed session is a new cookie with the same session id: logging out ends every copy of it.
    const sid = sessionIdOf(token);
    if (sid) this.revokedSignatures.set(sid, ttl);
    return Promise.all([this.saveSignature(hash, ttl), ...(sid ? [this.saveSignature(sid, ttl)] : [])]).then(() => undefined);
  }

  public revokeUser(userId: string, epochMs = Date.now()): Promise<void> {
    if (!userId) return Promise.resolve();
    this.userRevocationEpochs.set(userId, Math.max(this.userRevocationEpochs.get(userId) ?? 0, epochMs));
    return this.saveUserEpoch(userId, epochMs);
  }

  // A refused write stays queued and the caller still sees the error, so a logout is never reported saved early.
  private saveSignature(hash: string, ttl: number): Promise<void> {
    if (!this.persistence) return Promise.resolve();
    return this.persistence.revokeSignature(hash, ttl).then(() => {
      if ((this.unsavedSignatures.get(hash) ?? 0) <= ttl) this.unsavedSignatures.delete(hash);
    }, (error: unknown) => {
      this.unsavedSignatures.set(hash, Math.max(this.unsavedSignatures.get(hash) ?? 0, ttl));
      throw error;
    });
  }

  private saveUserEpoch(userId: string, epochMs: number): Promise<void> {
    if (!this.persistence) return Promise.resolve();
    return this.persistence.revokeUser(userId, epochMs).then(() => {
      if ((this.unsavedUserEpochs.get(userId) ?? 0) <= epochMs) this.unsavedUserEpochs.delete(userId);
    }, (error: unknown) => {
      this.unsavedUserEpochs.set(userId, Math.max(this.unsavedUserEpochs.get(userId) ?? 0, epochMs));
      throw error;
    });
  }

  private async saveUnsaved(): Promise<void> {
    for (const [hash, ttl] of [...this.unsavedSignatures]) await this.saveSignature(hash, ttl).catch(() => undefined);
    for (const [userId, epoch] of [...this.unsavedUserEpochs]) await this.saveUserEpoch(userId, epoch).catch(() => undefined);
  }

  public isRevoked(token: string, userId?: string, issuedAtMs?: number): boolean {
    if (!token || !this.loaded) return true;
    const hash = tokenSignatureHash(token);
    const exp = this.revokedSignatures.get(hash);
    if (exp !== undefined) {
      if (Date.now() > exp) {
        this.revokedSignatures.delete(hash);
      } else {
        return true;
      }
    }
    const sid = sessionIdOf(token);
    const sessionExp = sid ? this.revokedSignatures.get(sid) : undefined;
    if (sessionExp !== undefined && Date.now() <= sessionExp) return true;
    if (userId) {
      const userEpoch = this.userRevocationEpochs.get(userId);
      if (userEpoch !== undefined) {
        if (issuedAtMs !== undefined) {
          if (issuedAtMs < userEpoch) return true;
        } else {
          return true;
        }
      }
    }
    return false;
  }

  public getUserEpoch(userId: string): number | undefined {
    return this.userRevocationEpochs.get(userId);
  }

  public cleanup(): void {
    const now = Date.now();
    for (const [hash, exp] of this.revokedSignatures.entries()) {
      if (now > exp) this.revokedSignatures.delete(hash);
    }
    for (const [hash, exp] of this.unsavedSignatures.entries()) {
      if (now > exp) this.unsavedSignatures.delete(hash);
    }
    void this.saveUnsaved();
    void this.persistence?.pruneExpired(now).catch(() => undefined);
  }

  public close(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    this.persistence = null;
    this.loaded = true;
    this.revokedSignatures.clear();
    this.userRevocationEpochs.clear();
    this.unsavedSignatures.clear();
    this.unsavedUserEpochs.clear();
  }
}

export const defaultSessionRevocationStore = new SessionRevocationStore();

export function verifySession(
  token: string | undefined,
  secret: string,
  revocationStore?: SessionRevocationStore
): AuthUser | null {
  if (!token || secret.length < 16) {
    return null;
  }
  const segments = token.split(".");
  const store = revocationStore ?? defaultSessionRevocationStore;
  if (segments.length !== 2 || store.isRevoked(token)) {
    return null;
  }

  const [body, sig] = segments;
  if (!body || !sig) {
    return null;
  }

  const expected = createHmac("sha256", secret).update(body).digest("base64url");
  const actualBuffer = Buffer.from(sig);
  const expectedBuffer = Buffer.from(expected);
  if (actualBuffer.length !== expectedBuffer.length || !timingSafeEqual(actualBuffer, expectedBuffer)) {
    return null;
  }

  try {
    const parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as SessionPayload;
    if (typeof parsed !== "object" || parsed === null) {
      return null;
    }
    if (typeof parsed.exp !== "number" || !Number.isFinite(parsed.exp) || parsed.exp <= Math.floor(Date.now() / 1000)) {
      return null;
    }
    const user = authUserSchema.parse(parsed.user);
    const iatMs = typeof parsed.iat === "number" ? parsed.iat * 1000 : undefined;
    if (store.isRevoked(token, user.id, iatMs)) {
      return null;
    }
    return user;
  } catch {
    return null;
  }
}

export function signOAuthState(state: string, secret: string): string {
  if (!state || secret.length < 16) {
    throw new Error("Cannot sign OAuth state: invalid state or secret too short.");
  }
  const sig = createHmac("sha256", secret).update(`oauth-state:${state}`).digest("base64url");
  return `${state}.${sig}`;
}

export function verifyOAuthState(token: string | undefined, secret: string): string | null {
  if (!token || secret.length < 16) {
    return null;
  }
  const segments = token.split(".");
  const [rawState, sig] = segments;
  if (segments.length !== 2 || !rawState || !sig) {
    return null;
  }
  const expected = createHmac("sha256", secret).update(`oauth-state:${rawState}`).digest("base64url");
  const actualBuffer = Buffer.from(sig);
  const expectedBuffer = Buffer.from(expected);
  if (actualBuffer.length !== expectedBuffer.length || !timingSafeEqual(actualBuffer, expectedBuffer)) {
    return null;
  }
  return rawState;
}

export function generatePkcePair(): { codeVerifier: string; codeChallenge: string } {
  const codeVerifier = randomBytes(32).toString("base64url");
  const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
  return { codeVerifier, codeChallenge };
}

export function verifyPkce(codeVerifier: string, codeChallenge: string): boolean {
  if (!codeVerifier || !codeChallenge) return false;
  const computed = createHash("sha256").update(codeVerifier).digest("base64url");
  const compBuf = Buffer.from(computed);
  const chalBuf = Buffer.from(codeChallenge);
  return compBuf.length === chalBuf.length && timingSafeEqual(compBuf, chalBuf);
}

export function buildGoogleAuthUrl(input: {
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge?: string;
}): string {
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid email profile");
  url.searchParams.set("access_type", "online");
  url.searchParams.set("prompt", "select_account");
  url.searchParams.set("state", input.state);
  if (input.codeChallenge) {
    url.searchParams.set("code_challenge", input.codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");
  }
  return url.toString();
}


export async function exchangeGoogleCode(input: {
  code: string;
  clientId: string;
  clientSecret?: string;
  redirectUri: string;
  codeVerifier?: string;
  fetchImpl?: typeof fetch;
}): Promise<GoogleAuthUserInfo> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: input.code,
    redirect_uri: input.redirectUri,
    client_id: input.clientId
  });
  if (input.clientSecret) body.set("client_secret", input.clientSecret);
  if (input.codeVerifier) body.set("code_verifier", input.codeVerifier);

  const res = await fetchImpl("https://oauth2.googleapis.com/token", {
    signal: AbortSignal.timeout(10_000),
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body
  });
  if (!res.ok) throw new Error(`Google token exchange failed (${res.status}).`);
  const data = (await res.json()) as { id_token?: string };
  if (!data.id_token) throw new Error("No ID token returned by Google.");
  return verifyGoogleIdToken({ idToken: data.id_token, clientId: input.clientId, fetchImpl });
}

const GOOGLE_CERTS_URL = "https://www.googleapis.com/oauth2/v3/certs";
const GOOGLE_KEYS_REFETCH_MS = 60_000;
let googleKeys: { byKid: Map<string, KeyObject>; until: number; fetchedAt: number } | null = null;

/** Google's ID token signing key, from its published JWKS cached for its max-age; an unknown kid refetches at most once a minute. */
async function googleSigningKey(kid: string, fetchImpl: typeof fetch, nowMs: number): Promise<KeyObject> {
  const cached = googleKeys?.byKid.get(kid);
  if (cached && googleKeys!.until > nowMs) return cached;
  if (!googleKeys || googleKeys.until <= nowMs || nowMs - googleKeys.fetchedAt >= GOOGLE_KEYS_REFETCH_MS) {
    const res = await fetchImpl(GOOGLE_CERTS_URL, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error("Google token verification failed: signing keys unavailable.");
    const maxAge = Number(/max-age=(\d+)/.exec(res.headers.get("cache-control") ?? "")?.[1] ?? 3600);
    const { keys = [] } = (await res.json()) as { keys?: Array<JsonWebKey & { kid?: string }> };
    googleKeys = { fetchedAt: nowMs, until: nowMs + Math.min(maxAge, 86_400) * 1000,
      byKid: new Map(keys.filter((key) => key.kty === "RSA" && typeof key.kid === "string").map((key) => [key.kid!, createPublicKey({ key, format: "jwk" })])) };
  }
  const key = googleKeys.byKid.get(kid);
  if (!key) throw new Error("Google token verification failed: unknown signing key.");
  return key;
}

/** Verifies a Google ID token locally (hardening plan step 11): RS256 signature against Google's keys, then aud, iss, exp, email_verified. */
export async function verifyGoogleIdToken(input: {
  idToken: string;
  clientId?: string;
  fetchImpl?: typeof fetch;
}): Promise<GoogleAuthUserInfo> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const [encodedHeader, encodedPayload, signature, extra] = input.idToken.split(".");
  if (!encodedHeader || !encodedPayload || !signature || extra !== undefined) throw new Error("Google token verification failed.");
  let header: { alg?: unknown; kid?: unknown };
  let payload: {
    email?: unknown;
    sub?: unknown;
    aud?: unknown;
    iss?: unknown;
    exp?: unknown;
    email_verified?: unknown;
    name?: string;
    picture?: string;
  };
  try {
    header = JSON.parse(Buffer.from(encodedHeader, "base64url").toString("utf8"));
    payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8"));
  } catch {
    throw new Error("Google token verification failed.");
  }
  if (header.alg !== "RS256" || typeof header.kid !== "string") throw new Error("Google token verification failed.");
  const key = await googleSigningKey(header.kid, fetchImpl, Date.now());
  if (!verifySignature("RSA-SHA256", Buffer.from(`${encodedHeader}.${encodedPayload}`), key, Buffer.from(signature, "base64url"))) {
    throw new Error("Google token verification failed.");
  }
  if (typeof payload.email !== "string" || !payload.email || typeof payload.sub !== "string" || !payload.sub || payload.sub.length > 255) {
    throw new Error("Google token response missing required fields.");
  }
  if (!input.clientId || payload.aud !== input.clientId) {
    throw new Error("Google token audience mismatch.");
  }
  if (payload.iss !== "https://accounts.google.com" && payload.iss !== "accounts.google.com") {
    throw new Error("Google token issuer mismatch.");
  }
  if (typeof payload.exp !== "number" || payload.exp <= Math.floor(Date.now() / 1000)) {
    throw new Error("Google token has expired.");
  }
  if (payload.email_verified !== true) {
    throw new Error("Google email address is not verified.");
  }
  return {
    email: payload.email,
    sub: payload.sub,
    name: payload.name,
    picture: payload.picture
  };
}
