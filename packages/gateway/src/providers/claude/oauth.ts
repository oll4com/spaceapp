import { createHash, randomBytes } from "node:crypto";

/**
 * Claude subscription OAuth, with the protocol constants the Claude Code CLI uses (manual-code flow: the user
 * signs in on claude.ai and pastes back the `code#state` shown on the callback page). Changing them breaks sign-in.
 */
export const CLAUDE_OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"; // gitleaks:allow
export const CLAUDE_AUTHORIZE_URL = "https://claude.com/cai/oauth/authorize";
export const CLAUDE_TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
export const CLAUDE_REDIRECT_URI = "https://platform.claude.com/oauth/code/callback";
export const CLAUDE_OAUTH_SCOPES = "user:profile user:inference user:sessions:claude_code user:mcp_servers";
export const CLAUDE_OAUTH_BETA = "oauth-2025-04-20";
const OAUTH_TIMEOUT_MS = 30_000;

export interface ClaudeTokens {
  accessToken: string;
  refreshToken: string;
  expiresAtMs: number | null;
  scopes: string[];
  accountUuid: string | null;
  email: string | null;
  organizationUuid: string | null;
  organizationName: string | null;
}

export class ClaudeOAuthError extends Error {
  constructor(readonly code: string, message: string, readonly statusCode: number | null = null) {
    super(message);
  }
}

type Json = Record<string, unknown>;
const obj = (value: unknown): Json | null => (value && typeof value === "object" && !Array.isArray(value) ? value as Json : null);
const str = (value: unknown): string | null => (typeof value === "string" && value.length > 0 ? value : null);

export function generateClaudePkce(): { verifier: string; challenge: string; state: string } {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url"), state: randomBytes(32).toString("base64url") };
}

export function buildClaudeAuthorizationUrl(input: { challenge: string; state: string }): string {
  const params = new URLSearchParams({
    code: "true",
    client_id: CLAUDE_OAUTH_CLIENT_ID,
    response_type: "code",
    redirect_uri: CLAUDE_REDIRECT_URI,
    scope: CLAUDE_OAUTH_SCOPES,
    code_challenge: input.challenge,
    code_challenge_method: "S256",
    state: input.state
  });
  return `${CLAUDE_AUTHORIZE_URL}?${params.toString().replace(/\+/g, "%20")}`;
}

/** The callback page shows `code#state`; a full callback URL is accepted too. */
export function parseClaudeAuthorizationCode(pasted: string): { code: string; state: string | null } {
  const value = pasted.trim();
  if (/^https?:\/\//.test(value)) {
    const url = new URL(value);
    const code = url.searchParams.get("code");
    if (!code) throw new ClaudeOAuthError("invalid_code", "The address does not contain a sign-in code.");
    return { code, state: url.searchParams.get("state") };
  }
  const [code, state] = value.split("#");
  if (!code || !/^[A-Za-z0-9._~-]{8,}$/.test(code)) throw new ClaudeOAuthError("invalid_code", "Paste the code shown after signing in.");
  return { code, state: state ?? null };
}

function tokensFrom(payload: Json, nowMs: number, previous?: ClaudeTokens): ClaudeTokens {
  const accessToken = str(payload.access_token);
  const refreshToken = str(payload.refresh_token) ?? previous?.refreshToken ?? null;
  if (!accessToken || !refreshToken) throw new ClaudeOAuthError("invalid_response", "The Claude sign-in response is missing tokens.");
  const expiresIn = typeof payload.expires_in === "number" ? payload.expires_in : null;
  const account = obj(payload.account);
  const organization = obj(payload.organization);
  return {
    accessToken,
    refreshToken,
    expiresAtMs: expiresIn !== null ? nowMs + expiresIn * 1000 : null,
    scopes: (str(payload.scope) ?? CLAUDE_OAUTH_SCOPES).split(/\s+/).filter(Boolean),
    accountUuid: str(account?.uuid) ?? previous?.accountUuid ?? null,
    email: str(account?.email_address) ?? previous?.email ?? null,
    organizationUuid: str(organization?.uuid) ?? previous?.organizationUuid ?? null,
    organizationName: str(organization?.name) ?? previous?.organizationName ?? null
  };
}

async function postToken(body: Json, fetchImpl: typeof fetch): Promise<{ status: number; payload: Json }> {
  let response: Response;
  try {
    response = await fetchImpl(CLAUDE_TOKEN_URL, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(OAUTH_TIMEOUT_MS)
    });
  } catch (error) {
    throw new ClaudeOAuthError("transport_error", `Could not reach the Claude sign-in service: ${error instanceof Error ? error.message : "network error"}`);
  }
  const text = await response.text();
  let payload: Json = {};
  try { payload = obj(JSON.parse(text)) ?? {}; } catch { payload = { error: text.slice(0, 300) }; }
  return { status: response.status, payload };
}

function oauthError(payload: Json, status: number): ClaudeOAuthError {
  const error = obj(payload.error);
  const code = str(error?.type) ?? str(payload.error) ?? `http_${status}`;
  const message = str(error?.message) ?? str(payload.error_description) ?? `Claude sign-in failed (${status})`;
  return new ClaudeOAuthError(code, message, status);
}

export async function exchangeClaudeCode(input: { code: string; state: string; verifier: string; fetchImpl?: typeof fetch; now?: () => number }): Promise<ClaudeTokens> {
  const { status, payload } = await postToken({
    grant_type: "authorization_code", code: input.code, state: input.state, client_id: CLAUDE_OAUTH_CLIENT_ID,
    redirect_uri: CLAUDE_REDIRECT_URI, code_verifier: input.verifier
  }, input.fetchImpl ?? fetch);
  if (status >= 400) throw oauthError(payload, status);
  return tokensFrom(payload, (input.now ?? Date.now)());
}

/** Claude refresh tokens rotate: persist the returned one before the account is used again. */
export async function refreshClaudeToken(previous: ClaudeTokens, input: { fetchImpl?: typeof fetch; now?: () => number } = {}): Promise<ClaudeTokens> {
  const { status, payload } = await postToken({ grant_type: "refresh_token", refresh_token: previous.refreshToken, client_id: CLAUDE_OAUTH_CLIENT_ID },
    input.fetchImpl ?? fetch);
  if (status >= 400) {
    const error = oauthError(payload, status);
    // A dead refresh token needs a new sign-in; codex-lb's permanent-failure code for that case.
    if (status === 400 || status === 401) throw new ClaudeOAuthError("invalid_refresh_token", error.message, status);
    throw error;
  }
  return tokensFrom(payload, (input.now ?? Date.now)(), previous);
}
