import { createHmac, randomBytes, scrypt as scryptCallback, timingSafeEqual, type ScryptOptions } from "node:crypto";
import type { AuthUser, LoginInput } from "@space/contracts";
import { persistentOperatorSessionTtlSeconds, signPersistentOperatorSessionToken, signSessionTokenWithTtl } from "@space/runtime";

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
}

export interface SessionPayload {
  user: AuthUser;
  exp: number;
}

export const cookieName = SESSION_COOKIE;
export const csrfHeaderName = CSRF_HEADER;

export function getAuthConfig(env: NodeJS.ProcessEnv): AuthConfig {
  return {
    sessionSecret: env.SPACE_SESSION_SECRET ?? "",
    operatorEmail: env.SPACE_OPERATOR_EMAIL,
    operatorPasswordHash: env.SPACE_OPERATOR_PASSWORD_HASH,
    devLogin: env.NODE_ENV !== "production" && env.SPACE_DEV_LOGIN === "true",
    secureCookies: env.NODE_ENV === "production"
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
    return parsed.user;
  } catch {
    return null;
  }
}
