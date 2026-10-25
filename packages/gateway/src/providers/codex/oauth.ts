import { createHash, randomBytes } from "node:crypto";

/**
 * ChatGPT (Codex) OAuth, ported from codex-lb `app/core/clients/oauth.py`, `app/core/auth/refresh.py` and
 * `app/core/auth/__init__.py` (MIT, Soju06/codex-lb). The protocol constants identify the client exactly like
 * the Codex CLI; changing them breaks sign-in.
 */
export const CODEX_AUTH_BASE_URL = "https://auth.openai.com";
export const CODEX_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const CODEX_OAUTH_ORIGINATOR = "codex_chatgpt_desktop";
export const CODEX_OAUTH_SCOPE = "openid profile email";
export const CODEX_OAUTH_REDIRECT_URI = "http://localhost:1455/auth/callback";
/** An access token older than this is refreshed before use. */
export const CODEX_TOKEN_REFRESH_INTERVAL_MS = 8 * 86_400_000;
const OAUTH_TIMEOUT_MS = 30_000;
const TOKEN_REFRESH_TIMEOUT_MS = 8_000;

export interface CodexTokens {
  accessToken: string;
  refreshToken: string;
  idToken: string;
}

export interface CodexAccountClaims {
  accountId: string | null;
  email: string | null;
  planType: string | null;
  workspaceId: string | null;
  workspaceLabel: string | null;
  seatType: string | null;
  chatgptUserId: string | null;
  expiresAtMs: number | null;
}

export interface CodexDeviceCode {
  verificationUrl: string;
  userCode: string;
  deviceAuthId: string;
  intervalSeconds: number;
  expiresInSeconds: number;
}

export class CodexOAuthError extends Error {
  constructor(readonly code: string, message: string, readonly statusCode: number | null = null) {
    super(message);
  }
}

type FetchLike = typeof fetch;
type JsonObject = Record<string, unknown>;

export function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier, "utf8").digest("base64url");
}

export function generatePkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: pkceChallenge(verifier) };
}

function withOfflineAccess(scope: string): string {
  return scope.split(/\s+/).includes("offline_access") ? scope : `${scope} offline_access`;
}

export function buildAuthorizationUrl(input: { state: string; codeChallenge: string; baseUrl?: string }): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: CODEX_OAUTH_CLIENT_ID,
    redirect_uri: CODEX_OAUTH_REDIRECT_URI,
    scope: withOfflineAccess(CODEX_OAUTH_SCOPE),
    code_challenge: input.codeChallenge,
    code_challenge_method: "S256",
    state: input.state,
    id_token_add_organizations: "true",
    codex_cli_simplified_flow: "true",
    originator: CODEX_OAUTH_ORIGINATOR
  });
  return `${(input.baseUrl ?? CODEX_AUTH_BASE_URL).replace(/\/+$/, "")}/oauth/authorize?${params.toString().replace(/\+/g, "%20")}`;
}

/** Reads `code` and `state` from the localhost callback URL the operator pastes back after browser sign-in. */
export function parseAuthorizationCallback(callbackUrl: string): { code: string; state: string } {
  let url: URL;
  try {
    url = new URL(callbackUrl.trim());
  } catch {
    throw new CodexOAuthError("invalid_callback", "Paste the full address from the browser after signing in.");
  }
  const error = url.searchParams.get("error");
  if (error) throw new CodexOAuthError(error, url.searchParams.get("error_description") ?? "Sign-in was not completed.");
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) throw new CodexOAuthError("invalid_callback", "The address does not contain a sign-in code.");
  return { code, state };
}

async function readJson(response: Response): Promise<JsonObject> {
  const text = await response.text();
  try {
    const data = JSON.parse(text) as unknown;
    return data && typeof data === "object" && !Array.isArray(data) ? data as JsonObject : { error: { message: String(data) } };
  } catch {
    return { error: { message: text.trim().slice(0, 500) } };
  }
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function errorCode(payload: JsonObject): string | null {
  const error = payload.error;
  if (error && typeof error === "object") {
    const record = error as JsonObject;
    return text(record.code) ?? text(record.error);
  }
  return text(error) ?? text(payload.error_code) ?? text(payload.code);
}

function errorMessage(payload: JsonObject): string | null {
  const error = payload.error;
  if (error && typeof error === "object") {
    const record = error as JsonObject;
    return text(record.message) ?? text(record.error_description);
  }
  if (typeof error === "string") return text(payload.error_description) ?? error;
  return text(payload.message);
}

function oauthError(payload: JsonObject, status: number): CodexOAuthError {
  return new CodexOAuthError(errorCode(payload) ?? `http_${status}`, errorMessage(payload) ?? `OAuth request failed (${status})`, status);
}

function parseTokens(payload: JsonObject, message = "OAuth response missing tokens"): CodexTokens {
  const accessToken = text(payload.access_token);
  const refreshToken = text(payload.refresh_token);
  const idToken = text(payload.id_token);
  if (!accessToken || !refreshToken || !idToken) throw new CodexOAuthError("invalid_response", message);
  return { accessToken, refreshToken, idToken };
}

function isPending(payload: JsonObject): boolean {
  const code = errorCode(payload);
  if (code === "authorization_pending" || code === "slow_down") return true;
  const status = text(payload.status)?.toLowerCase();
  return status === "pending" || status === "authorization_pending";
}

async function post(fetchImpl: FetchLike, url: string, body: string, contentType: string, timeoutMs: number): Promise<{ status: number; payload: JsonObject }> {
  let response: Response;
  try {
    response = await fetchImpl(url, { method: "POST", headers: { "content-type": contentType }, body, signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    throw new CodexOAuthError("transport_error", `Could not reach the ChatGPT sign-in service: ${error instanceof Error ? error.message : "network error"}`);
  }
  return { status: response.status, payload: await readJson(response) };
}

export async function exchangeAuthorizationCode(input: {
  code: string; codeVerifier: string; redirectUri?: string; baseUrl?: string; fetchImpl?: FetchLike;
}): Promise<CodexTokens> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: CODEX_OAUTH_CLIENT_ID,
    code: input.code,
    code_verifier: input.codeVerifier,
    redirect_uri: input.redirectUri ?? CODEX_OAUTH_REDIRECT_URI
  }).toString();
  const { status, payload } = await post(input.fetchImpl ?? fetch, `${(input.baseUrl ?? CODEX_AUTH_BASE_URL).replace(/\/+$/, "")}/oauth/token`,
    body, "application/x-www-form-urlencoded", OAUTH_TIMEOUT_MS);
  if (status >= 400) throw oauthError(payload, status);
  return parseTokens(payload);
}

export async function requestDeviceCode(input: { baseUrl?: string; fetchImpl?: FetchLike; now?: () => number } = {}): Promise<CodexDeviceCode> {
  const base = (input.baseUrl ?? CODEX_AUTH_BASE_URL).replace(/\/+$/, "");
  const { status, payload } = await post(input.fetchImpl ?? fetch, `${base}/api/accounts/deviceauth/usercode`,
    JSON.stringify({ client_id: CODEX_OAUTH_CLIENT_ID }), "application/json", OAUTH_TIMEOUT_MS);
  if (status === 404) {
    throw new CodexOAuthError("device_auth_unavailable", "Device code sign-in is not available. Use browser sign-in instead.", status);
  }
  if (status >= 400) throw new CodexOAuthError("device_auth_failed", `Device code request failed with status ${status}`, status);
  const userCode = text(payload.user_code) ?? text(payload.usercode);
  const deviceAuthId = text(payload.device_auth_id);
  if (!userCode || !deviceAuthId) throw new CodexOAuthError("invalid_response", "Device sign-in response is missing fields.");
  const interval = Number(payload.interval);
  let expiresIn = Number(payload.expires_in);
  if (!Number.isFinite(expiresIn) || expiresIn <= 0) {
    const expiresAt = text(payload.expires_at);
    const delta = expiresAt ? (Date.parse(expiresAt) - (input.now ?? Date.now)()) / 1000 : NaN;
    expiresIn = Number.isFinite(delta) && delta > 0 ? Math.trunc(delta) : 900;
  }
  return {
    verificationUrl: `${base}/codex/device`,
    userCode,
    deviceAuthId,
    intervalSeconds: Number.isFinite(interval) && interval > 0 ? Math.trunc(interval) : 5,
    expiresInSeconds: expiresIn
  };
}

/** Polls the device sign-in once; `null` while the user has not finished. */
export async function exchangeDeviceToken(input: {
  deviceAuthId: string; userCode: string; baseUrl?: string; fetchImpl?: FetchLike;
}): Promise<CodexTokens | null> {
  const base = (input.baseUrl ?? CODEX_AUTH_BASE_URL).replace(/\/+$/, "");
  const fetchImpl = input.fetchImpl ?? fetch;
  const { status, payload } = await post(fetchImpl, `${base}/api/accounts/deviceauth/token`,
    JSON.stringify({ device_auth_id: input.deviceAuthId, user_code: input.userCode }), "application/json", OAUTH_TIMEOUT_MS);
  if (status === 403 || status === 404) return null;
  if (status >= 400) {
    if (isPending(payload)) return null;
    throw oauthError(payload, status);
  }
  if (isPending(payload)) return null;
  const authorizationCode = text(payload.authorization_code);
  if (authorizationCode) {
    const codeVerifier = text(payload.code_verifier);
    if (!codeVerifier) throw new CodexOAuthError("invalid_response", "Device sign-in response is missing the code verifier.");
    return exchangeAuthorizationCode({ code: authorizationCode, codeVerifier, redirectUri: `${base}/deviceauth/callback`, baseUrl: base, fetchImpl });
  }
  return parseTokens(payload);
}

export interface CodexRefreshResult extends CodexTokens {
  claims: CodexAccountClaims;
}

/**
 * Exchanges a refresh token. ChatGPT refresh tokens rotate: the caller must persist the returned refresh token
 * before anything else uses the account, and only one holder may refresh a given token.
 */
export async function refreshAccessToken(refreshToken: string, input: { fetchImpl?: FetchLike; baseUrl?: string } = {}): Promise<CodexRefreshResult> {
  const { status, payload } = await post(input.fetchImpl ?? fetch, `${(input.baseUrl ?? CODEX_AUTH_BASE_URL).replace(/\/+$/, "")}/oauth/token`,
    JSON.stringify({ grant_type: "refresh_token", client_id: CODEX_OAUTH_CLIENT_ID, refresh_token: refreshToken, scope: CODEX_OAUTH_SCOPE }),
    "application/json", TOKEN_REFRESH_TIMEOUT_MS);
  if (status >= 400) throw oauthError(payload, status);
  const tokens = parseTokens(payload, "Refresh response missing tokens");
  return { ...tokens, claims: extractCodexClaims(tokens.idToken) };
}

export function shouldRefresh(lastRefreshMs: number, nowMs = Date.now()): boolean {
  return nowMs - lastRefreshMs > CODEX_TOKEN_REFRESH_INTERVAL_MS;
}

function decodeJwtPayload(token: string): JsonObject {
  const part = token.split(".")[1];
  if (!part) return {};
  try {
    const data = JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as unknown;
    return data && typeof data === "object" && !Array.isArray(data) ? data as JsonObject : {};
  } catch {
    return {};
  }
}

function firstText(record: JsonObject, keys: string[]): string | null {
  for (const key of keys) {
    const value = text(record[key]);
    if (value) return value.trim() || null;
  }
  return null;
}

/** Reads identity from an id_token without verifying it (the token came straight from the OAuth endpoint). */
export function extractCodexClaims(idToken: string, accountIdHint: string | null = null): CodexAccountClaims {
  const claims = decodeJwtPayload(idToken);
  const auth = (claims["https://api.openai.com/auth"] && typeof claims["https://api.openai.com/auth"] === "object"
    ? claims["https://api.openai.com/auth"] : {}) as JsonObject;
  const workspaceKeys = ["workspace_id", "chatgpt_workspace_id", "organization_id", "org_id", "tenant_id"];
  const labelKeys = ["workspace_label", "workspace_name", "organization_name", "org_name", "tenant_name"];
  const seatKeys = ["seat_type", "chatgpt_seat_type", "entitlement_type"];
  const exp = claims.exp;
  const expSeconds = typeof exp === "number" ? exp : typeof exp === "string" && /^\d+$/.test(exp) ? Number(exp) : null;
  return {
    accountId: accountIdHint ?? text(auth.chatgpt_account_id) ?? text(claims.chatgpt_account_id),
    email: text(claims.email),
    planType: text(auth.chatgpt_plan_type) ?? text(claims.chatgpt_plan_type),
    workspaceId: firstText(auth, workspaceKeys) ?? firstText(claims, workspaceKeys),
    workspaceLabel: firstText(auth, labelKeys) ?? firstText(claims, labelKeys),
    seatType: (firstText(auth, seatKeys) ?? firstText(claims, seatKeys))?.toLowerCase() ?? null,
    chatgptUserId: firstText(auth, ["chatgpt_user_id", "user_id", "chatgpt_account_user_id"])
      ?? firstText(claims, ["chatgpt_user_id", "chatgpt_account_user_id"]) ?? text(claims.sub),
    expiresAtMs: expSeconds === null ? null : Math.max(0, Math.trunc(expSeconds * 1000))
  };
}

/** Parses a Codex CLI `auth.json` (`tokens.{id_token,access_token,refresh_token,account_id}`, camelCase accepted). */
export function parseCodexAuthJson(raw: string): { tokens: CodexTokens; lastRefreshMs: number | null; claims: CodexAccountClaims } {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new CodexOAuthError("invalid_auth_json", "The file is not valid JSON.");
  }
  const record = (data && typeof data === "object" ? data : {}) as JsonObject;
  const tokens = (record.tokens && typeof record.tokens === "object" ? record.tokens : null) as JsonObject | null;
  if (!tokens) throw new CodexOAuthError("invalid_auth_json", "The file has no ChatGPT tokens. Sign in to Codex with ChatGPT first.");
  const idToken = text(tokens.id_token) ?? text(tokens.idToken);
  const accessToken = text(tokens.access_token) ?? text(tokens.accessToken);
  const refreshToken = text(tokens.refresh_token) ?? text(tokens.refreshToken);
  if (!idToken || !accessToken || !refreshToken) throw new CodexOAuthError("invalid_auth_json", "The file is missing a ChatGPT token.");
  const lastRefresh = text(record.last_refresh) ?? text(record.lastRefreshAt);
  const lastRefreshMs = lastRefresh ? Date.parse(lastRefresh) : NaN;
  return {
    tokens: { idToken, accessToken, refreshToken },
    lastRefreshMs: Number.isFinite(lastRefreshMs) ? lastRefreshMs : null,
    claims: extractCodexClaims(idToken, text(tokens.account_id) ?? text(tokens.accountId))
  };
}
