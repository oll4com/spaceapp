import { existsSync, readFileSync } from "node:fs";
import { createHash, createHmac, randomBytes, scrypt as scryptCallback, timingSafeEqual, type ScryptOptions } from "node:crypto";
import { authUserSchema, resolveSpaceInstance, sessionCookieNameFor, type AuthUser, type LoginInput } from "@space/contracts";
import { persistentOperatorSessionTtlSeconds, signPersistentOperatorSessionToken, signSessionTokenWithTtl } from "@space/runtime";
import { ANTIGRAVITY_CLIENT_ID, ANTIGRAVITY_CLIENT_SECRET } from "./antigravity-usage-services.js";
import { instanceSecretDirectories } from "./instance-storage.js";

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
  secureCookies: boolean;
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
}

export const cookieName = SESSION_COOKIE;
export const csrfHeaderName = CSRF_HEADER;

export function getAuthConfig(env: NodeJS.ProcessEnv): AuthConfig {
  let googleClientId = env.SPACE_GOOGLE_CLIENT_ID || env.GOOGLE_CLIENT_ID || undefined;
  let googleClientSecret = env.SPACE_GOOGLE_CLIENT_SECRET || env.GOOGLE_CLIENT_SECRET || undefined;
  if (!googleClientId) {
    try {
      const candidates = instanceSecretDirectories(env).map(dir => `${dir}/google-oauth.json`);
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
    secureCookies: env.NODE_ENV === "production",
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

export function signSession(user: AuthUser, secret: string, nowMs = Date.now()): string {
  if (user.id === "user:operator-proof") throw new Error("Proof operators cannot receive persistent sessions.");
  if (secret.length < 16) throw new Error("SPACE_SESSION_SECRET must be at least 16 characters.");
  const payload: SessionPayload = {
    user,
    exp: Math.floor(nowMs / 1000) + persistentOperatorSessionTtlSeconds,
    iat: Math.floor(nowMs / 1000)
  };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${sig}`;
}

export function createCsrfToken(sessionToken: string | undefined, secret: string): string | null {
  if (!sessionToken || secret.length < 16) {
    return null;
  }
  return createHmac("sha256", secret).update(`csrf:${sessionToken}`).digest("base64url");
}

export function verifyCsrfToken(sessionToken: string | undefined, submittedToken: unknown, secret: string): boolean {
  if (typeof submittedToken !== "string") {
    return false;
  }
  const expected = createCsrfToken(sessionToken, secret);
  if (!expected) {
    return false;
  }
  const actualBuffer = Buffer.from(submittedToken);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
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

function tokenSignatureHash(token: string): string {
  const parts = token.split(".");
  const sig = parts.length > 1 ? parts[parts.length - 1]! : token;
  return createHash("sha256").update(sig).digest("hex");
}

export class SessionRevocationStore {
  // Keyed by SHA-256 of the token signature, the same form that is persisted.
  private readonly revokedSignatures = new Map<string, number>();
  private readonly userRevocationEpochs = new Map<string, number>();
  private cleanupTimer: NodeJS.Timeout | null = null;
  private persistence: SessionRevocationPersistence | null = null;

  constructor(cleanupIntervalMs = 60_000) {
    this.cleanupTimer = setInterval(() => this.cleanup(), cleanupIntervalMs);
    if (this.cleanupTimer.unref) this.cleanupTimer.unref();
  }

  /** Loads persisted revocations so a restart does not re-validate logged-out sessions. */
  public async attachPersistence(persistence: SessionRevocationPersistence, nowMs = Date.now()): Promise<void> {
    this.persistence = persistence;
    const persisted = await persistence.load(nowMs);
    for (const [hash, expiresAt] of persisted.signatures) {
      this.revokedSignatures.set(hash, Math.max(this.revokedSignatures.get(hash) ?? 0, expiresAt));
    }
    for (const [userId, epoch] of persisted.userEpochs) {
      this.userRevocationEpochs.set(userId, Math.max(this.userRevocationEpochs.get(userId) ?? 0, epoch));
    }
  }

  public detachPersistence(): void {
    this.persistence = null;
  }

  /** Revokes in memory at once; the returned promise settles when the revocation is durable. */
  public revokeToken(token: string, expiryMs?: number): Promise<void> {
    if (!token) return Promise.resolve();
    const hash = tokenSignatureHash(token);
    const ttl = expiryMs ?? (Date.now() + 400 * 24 * 60 * 60 * 1000);
    this.revokedSignatures.set(hash, ttl);
    return this.persistence ? this.persistence.revokeSignature(hash, ttl) : Promise.resolve();
  }

  public revokeUser(userId: string, epochMs = Date.now()): Promise<void> {
    if (!userId) return Promise.resolve();
    this.userRevocationEpochs.set(userId, Math.max(this.userRevocationEpochs.get(userId) ?? 0, epochMs));
    return this.persistence ? this.persistence.revokeUser(userId, epochMs) : Promise.resolve();
  }

  public isRevoked(token: string, userId?: string, issuedAtMs?: number): boolean {
    if (!token) return true;
    const hash = tokenSignatureHash(token);
    const exp = this.revokedSignatures.get(hash);
    if (exp !== undefined) {
      if (Date.now() > exp) {
        this.revokedSignatures.delete(hash);
      } else {
        return true;
      }
    }
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
    void this.persistence?.pruneExpired(now).catch(() => undefined);
  }

  public close(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    this.persistence = null;
    this.revokedSignatures.clear();
    this.userRevocationEpochs.clear();
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
  const store = revocationStore ?? defaultSessionRevocationStore;
  if (store.isRevoked(token)) {
    return null;
  }

  const [body, sig] = token.split(".");
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
  const [rawState, sig] = token.split(".");
  if (!rawState || !sig) {
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

export async function verifyGoogleIdToken(input: {
  idToken: string;
  clientId?: string;
  fetchImpl?: typeof fetch;
}): Promise<GoogleAuthUserInfo> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const res = await fetchImpl(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(input.idToken)}`, {
    signal: AbortSignal.timeout(10_000)
  });
  if (!res.ok) {
    throw new Error("Google token verification failed.");
  }
  const payload = (await res.json()) as {
    email?: string;
    sub?: string;
    aud?: string;
    iss?: string;
    exp?: string | number;
    email_verified?: string | boolean;
    name?: string;
    picture?: string;
  };
  if (typeof payload.email !== "string" || !payload.email || typeof payload.sub !== "string" || !payload.sub || payload.sub.length > 255) {
    throw new Error("Google token response missing required fields.");
  }
  if (!input.clientId || payload.aud !== input.clientId) {
    throw new Error("Google token audience mismatch.");
  }
  if (payload.iss !== "https://accounts.google.com" && payload.iss !== "accounts.google.com") {
    throw new Error("Google token issuer mismatch.");
  }
  if (!Number.isFinite(Number(payload.exp)) || Number(payload.exp) <= Math.floor(Date.now() / 1000)) {
    throw new Error("Google token has expired.");
  }
  if (payload.email_verified !== true && payload.email_verified !== "true") {
    throw new Error("Google email address is not verified.");
  }
  return {
    email: payload.email,
    sub: payload.sub,
    name: payload.name,
    picture: payload.picture
  };
}
