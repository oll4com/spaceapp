import { createSign } from "node:crypto";
import { readFile } from "node:fs/promises";

// FCM HTTP v1 pushes to the Android app: an OAuth2 access token from a JWT signed with the Firebase service
// account key (node:crypto, no Google SDK), then one data message per device token.

/** The service account fields the sender uses; the key file stays outside the repository. */
export interface FcmServiceAccount { project_id: string; client_email: string; private_key: string }
export type FcmSendResult = "SENT" | "INVALID_TOKEN" | "FAILED";
export interface FcmSender { send(token: string, data: Record<string, string>): Promise<FcmSendResult> }

const TOKEN_URI = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/firebase.messaging";
const base64url = (value: string) => Buffer.from(value).toString("base64url");

export function createFcmSender(account: FcmServiceAccount, options: { fetch?: typeof fetch; now?: () => number } = {}): FcmSender {
  const fetchImpl = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  let cached: { token: string; expiresAt: number } | null = null;

  async function accessToken(): Promise<string> {
    if (cached && cached.expiresAt > now()) return cached.token;
    const iat = Math.floor(now() / 1000);
    const unsigned = `${base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${base64url(JSON.stringify({ iss: account.client_email, scope: SCOPE, aud: TOKEN_URI, iat, exp: iat + 3600 }))}`;
    const signature = createSign("RSA-SHA256").update(unsigned).sign(account.private_key).toString("base64url");
    const response = await fetchImpl(TOKEN_URI, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${unsigned}.${signature}` }).toString(), signal: AbortSignal.timeout(10_000) });
    const body = await response.json().catch(() => ({})) as { access_token?: string; expires_in?: number };
    if (!response.ok || !body.access_token) throw new Error(`FCM access token request failed (HTTP ${response.status}).`);
    // Google issues one-hour tokens: kept for 55 minutes.
    cached = { token: body.access_token, expiresAt: now() + Math.min(body.expires_in ?? 3600, 3600) * 1000 - 300_000 };
    return cached.token;
  }

  return {
    async send(token, data) {
      const response = await fetchImpl(`https://fcm.googleapis.com/v1/projects/${encodeURIComponent(account.project_id)}/messages:send`, {
        method: "POST", headers: { authorization: `Bearer ${await accessToken()}`, "content-type": "application/json" },
        // Data only and high priority: the app's messaging service shows it, also with the app closed.
        body: JSON.stringify({ message: { token, data, android: { priority: "HIGH", ttl: "86400s" } } }), signal: AbortSignal.timeout(10_000) });
      if (response.ok) return "SENT";
      if (response.status === 401) cached = null;
      const error = (await response.json().catch(() => ({})) as { error?: { status?: string; details?: Array<{ errorCode?: string }> } }).error;
      const code = error?.details?.find((detail) => detail.errorCode)?.errorCode ?? error?.status;
      return code === "UNREGISTERED" || code === "INVALID_ARGUMENT" ? "INVALID_TOKEN" : "FAILED";
    }
  };
}

/** The service account key, or null (push off) when no file is configured, it is unreadable or lacks a field. */
export async function loadFcmServiceAccount(path: string | null): Promise<FcmServiceAccount | null> {
  if (!path) return null;
  try {
    const key = JSON.parse(await readFile(path, "utf8")) as Partial<FcmServiceAccount> & { type?: string };
    if (key.type !== "service_account" || !key.project_id || !key.client_email || !key.private_key) return null;
    return { project_id: key.project_id, client_email: key.client_email, private_key: key.private_key };
  } catch {
    return null;
  }
}
