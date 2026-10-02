import { existsSync, readFileSync } from "node:fs";
import { createHmac, randomBytes, scrypt as scryptCallback, timingSafeEqual, type ScryptOptions } from "node:crypto";
import { authUserSchema, type AuthUser, type LoginInput } from "@space/contracts";
import { persistentOperatorSessionTtlSeconds, signPersistentOperatorSessionToken, signSessionTokenWithTtl } from "@space/runtime";
import { ANTIGRAVITY_CLIENT_ID, ANTIGRAVITY_CLIENT_SECRET } from "./antigravity-usage-services.js";

const SESSION_COOKIE = "space_session";
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
  if (!googleClientId && env.SPACE_GOOGLE_AUTH_DISABLED !== "true") {
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

export function signSessionWithTtl(user: AuthUser, secret: string, ttlSeconds: number): string {
  return signSessionTokenWithTtl(user, secret, ttlSeconds);
}

export function signSession(user: AuthUser, secret: string): string {
  return signPersistentOperatorSessionToken(user, secret);
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

export function verifySession(token: string | undefined, secret: string): AuthUser | null {
  if (!token || secret.length < 16) {
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
    if (parsed.exp <= Math.floor(Date.now() / 1000)) {
      return null;
    }
    return authUserSchema.parse(parsed.user);
  } catch {
    return null;
  }
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

export function decodeGoogleIdToken(idToken: string): GoogleAuthUserInfo {
  const segment = idToken.split(".")[1];
  if (!segment) throw new Error("Invalid ID token format.");
  const payload = JSON.parse(Buffer.from(segment, "base64url").toString("utf8")) as {
    email?: string;
    sub?: string;
    name?: string;
    picture?: string;
  };
  if (!payload.email || !payload.sub) {
    throw new Error("Google ID token missing required email or sub claim.");
  }
  return {
    email: payload.email,
    sub: payload.sub,
    name: payload.name,
    picture: payload.picture
  };
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
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body
  });
  if (!res.ok) {
    const errorText = await res.text().catch(() => "");
    throw new Error(`Google token exchange failed (${res.status}): ${errorText}`);
  }
  const data = (await res.json()) as { id_token?: string; access_token?: string };
  if (data.id_token) {
    return decodeGoogleIdToken(data.id_token);
  }
  if (data.access_token) {
    const userInfoRes = await fetchImpl("https://openidconnect.googleapis.com/v1/userinfo", {
      headers: { authorization: `Bearer ${data.access_token}` }
    });
    if (!userInfoRes.ok) throw new Error("Failed to fetch Google user info.");
    const info = (await userInfoRes.json()) as { email: string; sub: string; name?: string; picture?: string };
    return { email: info.email, sub: info.sub, name: info.name, picture: info.picture };
  }
  throw new Error("No id_token or access_token returned by Google.");
}

export async function verifyGoogleIdToken(input: {
  idToken: string;
  clientId?: string;
  fetchImpl?: typeof fetch;
}): Promise<GoogleAuthUserInfo> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const res = await fetchImpl(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(input.idToken)}`);
  if (!res.ok) {
    throw new Error("Google token verification failed.");
  }
  const payload = (await res.json()) as { email?: string; sub?: string; aud?: string; name?: string; picture?: string };
  if (!payload.email || !payload.sub) {
    throw new Error("Google token response missing required fields.");
  }
  if (input.clientId && payload.aud && payload.aud !== input.clientId) {
    throw new Error("Google token audience mismatch.");
  }
  return {
    email: payload.email,
    sub: payload.sub,
    name: payload.name,
    picture: payload.picture
  };
}
