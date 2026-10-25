import { z } from "zod";

/**
 * Google Sheets connector: OAuth with offline access, refresh handling and the
 * Sheets v4 calls used by the Salesforce → Sheets demo. Column layout is
 * explicit so the demo can verify its own row with a read-back.
 */
export const googleSheetsScopes = ["https://www.googleapis.com/auth/spreadsheets", "openid", "email"] as const;
export const demoSheetHeaders = [
  "Operation ID",
  "Created At",
  "Account ID",
  "Account Name",
  "Contact ID",
  "Contact Name",
  "Email",
  "Project",
  "Variant"
] as const;
export const demoSheetHeaderWidth = demoSheetHeaders.length;

export interface GoogleClientSettings {
  clientId: string;
  clientSecret: string | null;
}

export interface GoogleTokenSet {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: string;
  scope: string | null;
  accountEmail: string | null;
}

export class GoogleSheetsError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly statusCode = 502,
    readonly retryable = false
  ) {
    super(message);
    this.name = "GoogleSheetsError";
  }
}

const tokenResponseSchema = z
  .object({
    access_token: z.string().min(8),
    refresh_token: z.string().min(8).optional(),
    expires_in: z.union([z.number(), z.string()]).optional(),
    scope: z.string().optional(),
    id_token: z.string().optional()
  })
  .loose();

export function googleRedirectUri(publicOrigin: string): string {
  return `${publicOrigin.replace(/\/+$/, "")}/api/demo-projects/connections/google-sheets/callback`;
}

export function googleAuthorizationUrl(input: {
  settings: GoogleClientSettings;
  redirectUri: string;
  state: string;
  codeChallenge: string;
}): string {
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", input.settings.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", googleSheetsScopes.join(" "));
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("include_granted_scopes", "true");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("state", input.state);
  url.searchParams.set("code_challenge", input.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

function decodeIdTokenEmail(idToken: string | undefined): string | null {
  if (!idToken) return null;
  const segment = idToken.split(".")[1];
  if (!segment) return null;
  try {
    const payload = JSON.parse(Buffer.from(segment, "base64url").toString("utf8")) as { email?: unknown };
    return typeof payload.email === "string" ? payload.email : null;
  } catch {
    return null;
  }
}

function parseTokenResponse(payload: unknown): GoogleTokenSet {
  const parsed = tokenResponseSchema.safeParse(payload);
  if (!parsed.success) throw new GoogleSheetsError("GOOGLE_TOKEN_INVALID", "The Google token response was not understood.");
  const expiresInSeconds = Number(parsed.data.expires_in ?? 3600);
  return {
    accessToken: parsed.data.access_token,
    refreshToken: parsed.data.refresh_token ?? null,
    expiresAt: new Date(Date.now() + Math.max(60, expiresInSeconds - 120) * 1000).toISOString(),
    scope: parsed.data.scope ?? null,
    accountEmail: decodeIdTokenEmail(parsed.data.id_token)
  };
}

export function googleAccessTokenExpired(tokens: GoogleTokenSet, now = new Date()): boolean {
  return Date.parse(tokens.expiresAt) <= now.getTime() + 60_000;
}

async function readGoogleError(response: Response): Promise<{ code: string; message: string }> {
  const text = await response.text().catch(() => "");
  try {
    const payload = JSON.parse(text) as { error?: string | { message?: string; status?: string }; error_description?: string };
    if (typeof payload.error === "string") {
      return { code: payload.error, message: payload.error_description ?? payload.error };
    }
    if (payload.error && typeof payload.error === "object") {
      return { code: payload.error.status ?? "GOOGLE_ERROR", message: payload.error.message ?? "Google API error" };
    }
  } catch {
    // Fall through to the raw body.
  }
  return { code: `GOOGLE_HTTP_${response.status}`, message: (text || `HTTP ${response.status}`).slice(0, 300) };
}

export async function googleExchangeCode(input: {
  settings: GoogleClientSettings;
  code: string;
  redirectUri: string;
  codeVerifier: string;
  fetchImpl?: typeof fetch;
}): Promise<GoogleTokenSet> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: input.code,
    redirect_uri: input.redirectUri,
    client_id: input.settings.clientId,
    code_verifier: input.codeVerifier
  });
  if (input.settings.clientSecret) body.set("client_secret", input.settings.clientSecret);
  const response = await fetchImpl("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body
  });
  if (!response.ok) {
    const error = await readGoogleError(response);
    throw new GoogleSheetsError(error.code, `Google rejected the authorization code: ${error.message}`, 400);
  }
  return parseTokenResponse(await response.json());
}

export async function googleRefreshAccessToken(input: {
  settings: GoogleClientSettings;
  tokens: GoogleTokenSet;
  fetchImpl?: typeof fetch;
}): Promise<GoogleTokenSet> {
  if (!input.tokens.refreshToken) {
    throw new GoogleSheetsError("GOOGLE_REFRESH_MISSING", "The Google connection has no refresh token. Reconnect the account.", 409);
  }
  const fetchImpl = input.fetchImpl ?? fetch;
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: input.tokens.refreshToken,
    client_id: input.settings.clientId
  });
  if (input.settings.clientSecret) body.set("client_secret", input.settings.clientSecret);
  const response = await fetchImpl("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body
  });
  if (!response.ok) {
    const error = await readGoogleError(response);
    const revoked = error.code === "invalid_grant";
    throw new GoogleSheetsError(
      revoked ? "GOOGLE_REFRESH_REVOKED" : error.code,
      revoked ? "The Google authorization was revoked or expired. Reconnect the account." : `Google refresh failed: ${error.message}`,
      revoked ? 409 : 502
    );
  }
  const refreshed = parseTokenResponse(await response.json());
  return { ...refreshed, refreshToken: refreshed.refreshToken ?? input.tokens.refreshToken, accountEmail: refreshed.accountEmail ?? input.tokens.accountEmail };
}

export async function googleRevoke(input: { token: string; fetchImpl?: typeof fetch }): Promise<void> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const url = new URL("https://oauth2.googleapis.com/revoke");
  url.searchParams.set("token", input.token);
  await fetchImpl(url, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" } }).catch(() => undefined);
}

export interface SpreadsheetMetadata {
  spreadsheetId: string;
  title: string;
  spreadsheetUrl: string | null;
  tabs: string[];
}

export interface SheetAppendResult {
  updatedRange: string | null;
  updatedRows: number;
  updatedCells: number;
}

export interface SheetRowMatch {
  rowNumber: number;
  values: string[];
}

export class GoogleSheetsApi {
  constructor(
    private readonly tokens: GoogleTokenSet,
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  private async request(path: string, init: RequestInit = {}): Promise<unknown> {
    const response = await this.fetchImpl(`https://sheets.googleapis.com/v4${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${this.tokens.accessToken}`,
        accept: "application/json",
        ...(init.body ? { "content-type": "application/json" } : {}),
        ...((init.headers as Record<string, string> | undefined) ?? {})
      }
    });
    const text = await response.text().catch(() => "");
    if (!response.ok) {
      let payload: unknown = null;
      try {
        payload = JSON.parse(text);
      } catch {
        payload = null;
      }
      const error = payload as { error?: { message?: string; status?: string; code?: number } } | null;
      const status = error?.error?.status ?? `GOOGLE_HTTP_${response.status}`;
      const unauthorized = response.status === 401 || status === "UNAUTHENTICATED";
      const forbidden = response.status === 403;
      const retryable = response.status >= 500 || response.status === 429;
      throw new GoogleSheetsError(
        unauthorized ? "GOOGLE_SESSION_EXPIRED" : forbidden ? "GOOGLE_FORBIDDEN" : status,
        unauthorized
          ? "The Google session is no longer valid. Reconnect the account."
          : forbidden
            ? "Google denied access to this spreadsheet. Check that the connected account can edit it."
            : `Google Sheets error: ${error?.error?.message ?? text.slice(0, 200)}`,
        unauthorized ? 409 : 502,
        retryable
      );
    }
    return text.length > 0 ? JSON.parse(text) : {};
  }

  async getSpreadsheet(spreadsheetId: string): Promise<SpreadsheetMetadata> {
    const payload = (await this.request(
      `/spreadsheets/${encodeURIComponent(spreadsheetId)}?fields=spreadsheetId,properties.title,spreadsheetUrl,sheets.properties`
    )) as {
      spreadsheetId?: string;
      properties?: { title?: string };
      spreadsheetUrl?: string;
      sheets?: Array<{ properties?: { title?: string } }>;
    };
    return {
      spreadsheetId: payload.spreadsheetId ?? spreadsheetId,
      title: payload.properties?.title ?? "Untitled spreadsheet",
      spreadsheetUrl: payload.spreadsheetUrl ?? `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`,
      tabs: (payload.sheets ?? []).map((sheet) => sheet.properties?.title ?? "").filter((title) => title.length > 0)
    };
  }

  async getValues(spreadsheetId: string, range: string): Promise<string[][]> {
    const payload = (await this.request(
      `/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}?majorDimension=ROWS`
    )) as { values?: string[][] };
    return (payload.values ?? []).map((row) => row.map((cell) => String(cell ?? "")));
  }

  async appendRow(spreadsheetId: string, tab: string, values: string[]): Promise<SheetAppendResult> {
    const payload = (await this.request(
      `/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(`${tab}!A1`)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
      { method: "POST", body: JSON.stringify({ majorDimension: "ROWS", values: [values] }) }
    )) as { updates?: { updatedRange?: string; updatedRows?: number; updatedCells?: number } };
    return {
      updatedRange: payload.updates?.updatedRange ?? null,
      updatedRows: payload.updates?.updatedRows ?? 0,
      updatedCells: payload.updates?.updatedCells ?? 0
    };
  }

  async createSpreadsheet(input: { title: string; tab: string }): Promise<SpreadsheetMetadata> {
    const payload = (await this.request("/spreadsheets", {
      method: "POST",
      body: JSON.stringify({
        properties: { title: input.title },
        sheets: [{ properties: { title: input.tab } }]
      })
    })) as {
      spreadsheetId?: string;
      properties?: { title?: string };
      spreadsheetUrl?: string;
      sheets?: Array<{ properties?: { title?: string } }>;
    };
    if (!payload.spreadsheetId) throw new GoogleSheetsError("GOOGLE_CREATE_FAILED", "Google did not return a spreadsheet id.");
    return {
      spreadsheetId: payload.spreadsheetId,
      title: payload.properties?.title ?? input.title,
      spreadsheetUrl: payload.spreadsheetUrl ?? `https://docs.google.com/spreadsheets/d/${payload.spreadsheetId}/edit`,
      tabs: (payload.sheets ?? []).map((sheet) => sheet.properties?.title ?? input.tab)
    };
  }

  /** Finds an existing row by its Operation ID so a retry never duplicates a row. */
  async findRowByOperationId(spreadsheetId: string, tab: string, operationKey: string): Promise<SheetRowMatch | null> {
    const rows = await this.getValues(spreadsheetId, `${tab}!A1:A`);
    for (let index = 0; index < rows.length; index += 1) {
      const value = rows[index]?.[0] ?? "";
      if (value === operationKey) return { rowNumber: index + 1, values: rows[index] ?? [] };
    }
    return null;
  }

  async findRowByRange(spreadsheetId: string, tab: string, rowNumber: number): Promise<string[]> {
    const rows = await this.getValues(spreadsheetId, `${tab}!A${rowNumber}:I${rowNumber}`);
    return rows[0] ?? [];
  }

  async ensureHeader(spreadsheetId: string, tab: string): Promise<boolean> {
    const rows = await this.getValues(spreadsheetId, `${tab}!A1:I1`);
    const header = rows[0] ?? [];
    const normalized = demoSheetHeaders.map((value) => value.toLowerCase());
    const matches = header.length >= demoSheetHeaders.length && header.slice(0, demoSheetHeaders.length).every((cell, index) => cell.trim().toLowerCase() === normalized[index]);
    return matches;
  }

  async writeHeader(spreadsheetId: string, tab: string): Promise<void> {
    await this.request(
      `/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(`${tab}!A1:I1`)}?valueInputOption=RAW`,
      { method: "PUT", body: JSON.stringify({ majorDimension: "ROWS", values: [[...demoSheetHeaders]] }) }
    );
  }
}
