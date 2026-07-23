import { createHmac } from "node:crypto";
import type { AuthUser } from "@space/contracts";

export interface SignedSessionPayload {
  user: AuthUser;
  exp: number;
}

const maximumEphemeralSessionTtlSeconds = 60 * 60 * 12;
const proofOperatorUserId = "user:operator-proof";
export const persistentOperatorSessionTtlSeconds = 60 * 60 * 24 * 400;

function signSessionToken(user: AuthUser, secret: string, ttlSeconds: number, nowMs: number): string {
  if (secret.length < 16) throw new Error("SPACE_SESSION_SECRET must be at least 16 characters.");
  const payload: SignedSessionPayload = { user, exp: Math.floor(nowMs / 1000) + ttlSeconds };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${sig}`;
}

export function signSessionTokenWithTtl(user: AuthUser, secret: string, ttlSeconds: number, nowMs = Date.now()): string {
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > maximumEphemeralSessionTtlSeconds) {
    throw new Error(`Session TTL must be an integer between 1 and ${maximumEphemeralSessionTtlSeconds} seconds.`);
  }
  return signSessionToken(user, secret, ttlSeconds, nowMs);
}

export function signPersistentOperatorSessionToken(user: AuthUser, secret: string, nowMs = Date.now()): string {
  if (user.id === proofOperatorUserId) throw new Error("Proof operators cannot receive persistent sessions.");
  return signSessionToken(user, secret, persistentOperatorSessionTtlSeconds, nowMs);
}
