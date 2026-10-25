/**
 * Google OAuth for Antigravity (Code Assist) accounts, with the installed-app client the Antigravity CLI uses (its
 * id and secret are public parts of the CLI, as Space already uses them in apps/api/src/antigravity-usage-services.ts).
 * Google refresh tokens do not rotate, so a Space Antigravity profile and Space Gateway can both hold the same sign-in.
 */
export const ANTIGRAVITY_CLIENT_ID = process.env.ANTIGRAVITY_CLIENT_ID ?? "";
export const ANTIGRAVITY_CLIENT_SECRET = process.env.ANTIGRAVITY_CLIENT_SECRET ?? "";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

export interface AntigravityTokens {
  accessToken: string | null;
  refreshToken: string;
  expiresAtMs: number | null;
  email: string | null;
  subject: string | null;
}

export class AntigravityAuthError extends Error {
  constructor(readonly code: string, message: string, readonly statusCode: number | null = null) {
    super(message);
  }
}

type Json = Record<string, unknown>;
const obj = (value: unknown): Json | null => (value && typeof value === "object" && !Array.isArray(value) ? value as Json : null);
const str = (value: unknown): string | null => (typeof value === "string" && value.length > 0 ? value : null);

function idTokenClaims(idToken: string | null): Json {
  const payload = idToken?.split(".")[1];
  if (!payload) return {};
  try { return obj(JSON.parse(Buffer.from(payload, "base64url").toString("utf8"))) ?? {}; } catch { return {}; }
}

/** The CLI's `antigravity-oauth-token` file: `{ token: { access_token, refresh_token, expiry }, id_token }`. */
export function parseAntigravityTokenFile(text: string): AntigravityTokens {
  let data: Json | null;
  try { data = obj(JSON.parse(text)); } catch { throw new AntigravityAuthError("invalid_token_file", "This is not an Antigravity sign-in file."); }
  const token = obj(data?.token);
  const refreshToken = str(token?.refresh_token);
  if (!refreshToken) throw new AntigravityAuthError("invalid_token_file", "The Antigravity sign-in has no refresh token.");
  const expiry = str(token?.expiry);
  const expiresAtMs = expiry ? Date.parse(expiry) : Number.NaN;
  const claims = idTokenClaims(str(data?.id_token));
  return {
    accessToken: str(token?.access_token),
    refreshToken,
    expiresAtMs: Number.isFinite(expiresAtMs) ? expiresAtMs : null,
    email: typeof claims.email === "string" && claims.email.includes("@") ? claims.email : null,
    subject: str(claims.sub)
  };
}

export async function refreshGoogleAccessToken(refreshToken: string, options: { fetchImpl?: typeof fetch; now?: () => number } = {}):
  Promise<{ accessToken: string; expiresAtMs: number }> {
  let response: Response;
  try {
    response = await (options.fetchImpl ?? fetch)(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: ANTIGRAVITY_CLIENT_ID, client_secret: ANTIGRAVITY_CLIENT_SECRET, refresh_token: refreshToken,
        grant_type: "refresh_token" }).toString(),
      signal: AbortSignal.timeout(20_000)
    });
  } catch (error) {
    throw new AntigravityAuthError("transport_error", `Could not reach Google sign-in: ${error instanceof Error ? error.message : "network error"}`);
  }
  let payload: Json = {};
  try { payload = obj(await response.json()) ?? {}; } catch { /* empty */ }
  if (!response.ok) {
    // A revoked or expired refresh token needs a new sign-in (invalid_grant is a permanent failure code).
    const code = str(payload.error) ?? `http_${response.status}`;
    throw new AntigravityAuthError(code, str(payload.error_description) ?? `Google sign-in returned HTTP ${response.status}`, response.status);
  }
  const accessToken = str(payload.access_token);
  if (!accessToken) throw new AntigravityAuthError("invalid_response", "Google sign-in returned no access token.");
  const expiresIn = typeof payload.expires_in === "number" ? payload.expires_in : 3600;
  return { accessToken, expiresAtMs: (options.now ?? Date.now)() + expiresIn * 1000 };
}
