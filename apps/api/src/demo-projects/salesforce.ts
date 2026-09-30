import { z } from "zod";

/**
 * Salesforce connector: authorization-code OAuth with PKCE, refresh-token
 * rotation and a small REST client. Tokens never leave this module's callers;
 * the demo apps only see the mediated results.
 */
export const salesforceScopes = ["api", "refresh_token", "openid"] as const;

export interface SalesforceClientSettings {
  clientId: string;
  clientSecret: string | null;
  loginUrl: string;
}

export interface SalesforceTokenSet {
  accessToken: string;
  refreshToken: string | null;
  instanceUrl: string;
  issuedAt: string;
  expiresAt: string;
  scope: string | null;
  tokenType: string;
}

export interface SalesforceIdentity {
  displayName: string;
  username: string | null;
  organizationId: string | null;
  userId: string | null;
}

export class SalesforceError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly statusCode = 502,
    readonly retryable = false,
    readonly duplicateResult: unknown = null
  ) {
    super(message);
    this.name = "SalesforceError";
  }
}

const tokenResponseSchema = z
  .object({
    access_token: z.string().min(8),
    refresh_token: z.string().min(8).optional(),
    instance_url: z.string().min(8),
    id: z.string().optional(),
    scope: z.string().optional(),
    token_type: z.string().optional(),
    issued_at: z.string().optional()
  })
  .loose();

const errorResponseSchema = z
  .object({
    error: z.string().optional(),
    error_description: z.string().optional(),
    message: z.string().optional()
  })
  .loose();

const salesforceApiErrorSchema = z.array(
  z
    .object({
      message: z.string().optional(),
      errorCode: z.string().optional(),
      duplicateResult: z.any().optional()
    })
    .loose()
);

const defaultApiVersion = "v60.0";

export function salesforceApiVersion(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.SPACE_DEMO_SALESFORCE_API_VERSION?.trim();
  return configured && /^v\d{2}\.\d$/.test(configured) ? configured : defaultApiVersion;
}

export function salesforceRedirectUri(publicOrigin: string): string {
  return `${publicOrigin.replace(/\/+$/, "")}/api/demo-projects/connections/salesforce/callback`;
}

export function salesforceAuthorizationUrl(input: {
  settings: SalesforceClientSettings;
  redirectUri: string;
  state: string;
  codeChallenge: string;
  apiVersion?: string;
}): string {
  const url = new URL("/services/oauth2/authorize", input.settings.loginUrl);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", input.settings.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("scope", salesforceScopes.join(" "));
  url.searchParams.set("state", input.state);
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("code_challenge", input.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

function tokenExpiry(issuedAt: string): string {
  // Salesforce access tokens are valid for roughly two hours; refresh 5 minutes early.
  return new Date(Date.parse(issuedAt) + 115 * 60 * 1000).toISOString();
}

function parseTokenResponse(payload: unknown): SalesforceTokenSet {
  const parsed = tokenResponseSchema.safeParse(payload);
  if (!parsed.success) {
    throw new SalesforceError("SALESFORCE_TOKEN_INVALID", "The Salesforce token response was not understood.", 502);
  }
  const issuedAt = parsed.data.issued_at ? new Date(Number(parsed.data.issued_at)).toISOString() : new Date().toISOString();
  return {
    accessToken: parsed.data.access_token,
    refreshToken: parsed.data.refresh_token ?? null,
    instanceUrl: parsed.data.instance_url.replace(/\/+$/, ""),
    issuedAt,
    expiresAt: tokenExpiry(issuedAt),
    scope: parsed.data.scope ?? null,
    tokenType: parsed.data.token_type ?? "Bearer"
  };
}

async function readError(response: Response): Promise<{ code: string; message: string }> {
  const text = await response.text().catch(() => "");
  const parsed = errorResponseSchema.safeParse(safeJson(text));
  if (parsed.success) {
    const code = parsed.data.error ?? "SALESFORCE_ERROR";
    const message = parsed.data.error_description ?? parsed.data.message ?? code;
    return { code, message: message.slice(0, 300) };
  }
  return { code: "SALESFORCE_ERROR", message: (text || `HTTP ${response.status}`).slice(0, 300) };
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function salesforceAccessTokenExpired(tokens: SalesforceTokenSet, now = new Date()): boolean {
  return Date.parse(tokens.expiresAt) <= now.getTime() + 60_000;
}

export async function salesforceExchangeCode(input: {
  settings: SalesforceClientSettings;
  code: string;
  redirectUri: string;
  codeVerifier: string;
  fetchImpl?: typeof fetch;
}): Promise<{ tokens: SalesforceTokenSet; identity: SalesforceIdentity | null }> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: input.code,
    redirect_uri: input.redirectUri,
    client_id: input.settings.clientId,
    code_verifier: input.codeVerifier
  });
  if (input.settings.clientSecret) body.set("client_secret", input.settings.clientSecret);
  const response = await fetchImpl(new URL("/services/oauth2/token", input.settings.loginUrl), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body
  });
  if (!response.ok) {
    const error = await readError(response);
    throw new SalesforceError(error.code, `Salesforce rejected the authorization code: ${error.message}`, 400);
  }
  const tokens = parseTokenResponse(await response.json());
  const identity = await salesforceIdentity(tokens, fetchImpl).catch(() => null);
  return { tokens, identity };
}

export async function salesforceRefreshAccessToken(input: {
  settings: SalesforceClientSettings;
  tokens: SalesforceTokenSet;
  fetchImpl?: typeof fetch;
}): Promise<SalesforceTokenSet> {
  if (!input.tokens.refreshToken) {
    throw new SalesforceError("SALESFORCE_REFRESH_MISSING", "The Salesforce connection has no refresh token. Reconnect the account.", 409);
  }
  const fetchImpl = input.fetchImpl ?? fetch;
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: input.tokens.refreshToken,
    client_id: input.settings.clientId
  });
  if (input.settings.clientSecret) body.set("client_secret", input.settings.clientSecret);
  const response = await fetchImpl(new URL("/services/oauth2/token", input.settings.loginUrl), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body
  });
  if (!response.ok) {
    const error = await readError(response);
    const revoked = error.code === "invalid_grant";
    throw new SalesforceError(
      revoked ? "SALESFORCE_REFRESH_REVOKED" : error.code,
      revoked
        ? "The Salesforce refresh token was revoked or expired. Reconnect the account."
        : `Salesforce refresh failed: ${error.message}`,
      revoked ? 409 : 502
    );
  }
  const refreshed = parseTokenResponse(await response.json());
  return { ...refreshed, refreshToken: refreshed.refreshToken ?? input.tokens.refreshToken };
}

export async function salesforceRevoke(input: {
  settings: SalesforceClientSettings;
  token: string;
  fetchImpl?: typeof fetch;
}): Promise<void> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const url = new URL("/services/oauth2/revoke", input.settings.loginUrl);
  url.searchParams.set("token", input.token);
  await fetchImpl(url, { method: "POST", headers: { accept: "application/json" } }).catch(() => undefined);
}

async function salesforceIdentity(tokens: SalesforceTokenSet, fetchImpl: typeof fetch): Promise<SalesforceIdentity | null> {
  const response = await fetchImpl(`${tokens.instanceUrl}/services/oauth2/userinfo`, {
    headers: { authorization: `Bearer ${tokens.accessToken}`, accept: "application/json" }
  });
  if (!response.ok) return null;
  const payload = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (!payload) return null;
  const display = typeof payload.name === "string" ? payload.name : typeof payload.preferred_username === "string" ? payload.preferred_username : null;
  return {
    displayName: display ?? "Salesforce account",
    username: typeof payload.preferred_username === "string" ? payload.preferred_username : null,
    organizationId: typeof payload.organization_id === "string" ? payload.organization_id : null,
    userId: typeof payload.sub === "string" ? payload.sub : null
  };
}

export interface SalesforceAccountRecord {
  id: string;
  name: string;
  createdAt: string | null;
  contactId: string | null;
  contactName: string | null;
}

export interface SalesforceAccountPage {
  data: SalesforceAccountRecord[];
  totalItems: number;
  instanceUrl: string;
}

export interface CreateSalesforceAccountInput {
  name: string;
  website?: string | null;
  phone?: string | null;
  externalId?: string | null;
  externalIdField?: string | null;
}

export interface CreateSalesforceContactInput {
  accountId: string;
  lastName: string;
  firstName?: string | null;
  email?: string | null;
  phone?: string | null;
}

export class SalesforceApi {
  constructor(
    private readonly tokens: SalesforceTokenSet,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly apiVersion: string = salesforceApiVersion()
  ) {}

  get instanceUrl(): string {
    return this.tokens.instanceUrl;
  }

  private async request(path: string, init: RequestInit = {}): Promise<unknown> {
    const response = await this.fetchImpl(`${this.tokens.instanceUrl}/services/data/${this.apiVersion}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${this.tokens.accessToken}`,
        accept: "application/json",
        ...(init.body ? { "content-type": "application/json" } : {}),
        ...((init.headers as Record<string, string> | undefined) ?? {})
      }
    });
    const text = await response.text().catch(() => "");
    const payload = safeJson(text);
    if (!response.ok) {
      const apiError = salesforceApiErrorSchema.safeParse(payload);
      const first = apiError.success ? apiError.data[0] : undefined;
      const code = first?.errorCode ?? `SALESFORCE_HTTP_${response.status}`;
      const message = first?.message ?? text.slice(0, 300) ?? `HTTP ${response.status}`;
      const duplicateResult = first?.duplicateResult ?? null;
      const sessionExpired = code === "INVALID_SESSION_ID" || response.status === 401;
      const retryable = code === "REQUEST_LIMIT_EXCEEDED" || code === "DUPLICATES_DETECTED" || response.status >= 500 || response.status === 429;
      throw new SalesforceError(
        sessionExpired ? "SALESFORCE_SESSION_EXPIRED" : code,
        sessionExpired ? "The Salesforce session is no longer valid. Reconnect the account." : `Salesforce API error: ${message}`,
        sessionExpired ? 409 : 502,
        retryable,
        duplicateResult
      );
    }
    return payload;
  }

  async listAccounts(input: { search?: string; page: number; pageSize: number }): Promise<SalesforceAccountPage> {
    const offset = (input.page - 1) * input.pageSize;
    const where = input.search
      ? `WHERE Name LIKE '%${input.search.replace(/[\\'%_]/g, (character) => (character === "'" ? "\\'" : `\\${character}`))}%'`
      : "";
    const query = `SELECT Id, Name, CreatedDate, (SELECT Id, Name FROM Contacts ORDER BY CreatedDate DESC LIMIT 1) FROM Account ${where} ORDER BY CreatedDate DESC LIMIT ${input.pageSize} OFFSET ${offset}`;
    const payload = (await this.request(`/query?q=${encodeURIComponent(query)}`)) as {
      records?: Array<{ Id?: string; Name?: string; CreatedDate?: string; Contacts?: { records?: Array<{ Id?: string; Name?: string }> } }>;
      totalSize?: number;
    };
    const countPayload = (await this.request(`/query?q=${encodeURIComponent(`SELECT COUNT() FROM Account ${where}`)}`)) as {
      totalSize?: number;
    };
    const records = payload.records ?? [];
    return {
      instanceUrl: this.tokens.instanceUrl,
      totalItems: countPayload.totalSize ?? records.length,
      data: records.map((record) => {
        const contact = record.Contacts?.records?.[0];
        return {
          id: record.Id ?? "",
          name: record.Name ?? "",
          createdAt: record.CreatedDate ?? null,
          contactId: contact?.Id ?? null,
          contactName: contact?.Name ?? null
        };
      })
    };
  }

  async createAccount(input: CreateSalesforceAccountInput): Promise<{ id: string; created: boolean }> {
    const body: Record<string, unknown> = { Name: input.name };
    if (input.website) body.Website = input.website;
    if (input.phone) body.Phone = input.phone;
    if (input.externalId && input.externalIdField) {
      const field = input.externalIdField.replace(/[^A-Za-z0-9_]/g, "");
      const result = (await this.request(
        `/sobjects/Account/${field}/${encodeURIComponent(input.externalId)}`,
        {
          method: "PATCH",
          headers: { "Sforce-Duplicate-Rule-Header": "allowSave=true" },
          body: JSON.stringify(body)
        }
      )) as { id?: string; created?: boolean; success?: boolean };
      if (result.id) return { id: result.id, created: result.created ?? true };
      throw new SalesforceError("SALESFORCE_UPSERT_FAILED", "Salesforce did not return an Account id.", 502, true);
    }
    const result = (await this.request("/sobjects/Account", {
      method: "POST",
      headers: { "Sforce-Duplicate-Rule-Header": "allowSave=true" },
      body: JSON.stringify(body)
    })) as {
      id?: string;
      success?: boolean;
      errors?: unknown[];
    };
    if (!result.id) {
      throw new SalesforceError("SALESFORCE_ACCOUNT_FAILED", "Salesforce did not return an Account id.", 502, true);
    }
    return { id: result.id, created: true };
  }

  async createContact(input: CreateSalesforceContactInput): Promise<{ id: string }> {
    const body: Record<string, unknown> = { LastName: input.lastName, AccountId: input.accountId };
    if (input.firstName) body.FirstName = input.firstName;
    if (input.email) body.Email = input.email;
    if (input.phone) body.Phone = input.phone;
    try {
      const result = (await this.request("/sobjects/Contact", {
        method: "POST",
        headers: { "Sforce-Duplicate-Rule-Header": "allowSave=true" },
        body: JSON.stringify(body)
      })) as { id?: string };
      if (!result.id) throw new SalesforceError("SALESFORCE_CONTACT_FAILED", "Salesforce did not return a Contact id.", 502, true);
      return { id: result.id };
    } catch (error) {
      if (
        error instanceof SalesforceError &&
        (error.code === "DUPLICATES_DETECTED" ||
          /duplicate/i.test(error.message) ||
          /Use one of these records/i.test(error.message))
      ) {
        let matchedId: string | null = null;

        // 1. Check duplicateResult from Salesforce API error body
        const matchResults = (error.duplicateResult as { matchResults?: Array<{ matchRecords?: Array<{ record?: { Id?: string } }> }> })
          ?.matchResults;
        if (Array.isArray(matchResults)) {
          for (const mr of matchResults) {
            for (const rec of mr?.matchRecords ?? []) {
              if (rec?.record?.Id) {
                matchedId = rec.record.Id;
                break;
              }
            }
            if (matchedId) break;
          }
        }

        // 2. Query by email
        if (!matchedId && input.email) {
          const safeEmail = input.email.replace(/[\\']/g, (c) => `\\${c}`);
          const query = `SELECT Id FROM Contact WHERE Email = '${safeEmail}' ORDER BY CreatedDate DESC LIMIT 1`;
          const payload = (await this.request(`/query?q=${encodeURIComponent(query)}`).catch(() => null)) as {
            records?: Array<{ Id?: string }>;
          } | null;
          matchedId = payload?.records?.[0]?.Id ?? null;
        }

        // 3. Query by AccountId + LastName
        if (!matchedId && input.lastName) {
          const safeLast = input.lastName.replace(/[\\']/g, (c) => `\\${c}`);
          const query = `SELECT Id FROM Contact WHERE AccountId = '${input.accountId}' AND LastName = '${safeLast}' ORDER BY CreatedDate DESC LIMIT 1`;
          const payload = (await this.request(`/query?q=${encodeURIComponent(query)}`).catch(() => null)) as {
            records?: Array<{ Id?: string }>;
          } | null;
          matchedId = payload?.records?.[0]?.Id ?? null;
        }

        // 4. Org-wide query by LastName (and FirstName if provided)
        if (!matchedId && input.lastName) {
          const safeLast = input.lastName.replace(/[\\']/g, (c) => `\\${c}`);
          const safeFirst = input.firstName ? input.firstName.replace(/[\\']/g, (c) => `\\${c}`) : null;
          const firstClause = safeFirst ? ` AND FirstName = '${safeFirst}'` : "";
          const query = `SELECT Id FROM Contact WHERE LastName = '${safeLast}'${firstClause} ORDER BY CreatedDate DESC LIMIT 1`;
          const payload = (await this.request(`/query?q=${encodeURIComponent(query)}`).catch(() => null)) as {
            records?: Array<{ Id?: string }>;
          } | null;
          matchedId = payload?.records?.[0]?.Id ?? null;
        }

        if (matchedId) {
          return { id: matchedId };
        }
      }
      throw error;
    }
  }

  async readAccount(id: string): Promise<{ id: string; name: string } | null> {
    try {
      const result = (await this.request(`/sobjects/Account/${encodeURIComponent(id)}`)) as { Id?: string; Name?: string };
      return result.Id ? { id: result.Id, name: result.Name ?? "" } : null;
    } catch (error) {
      if (error instanceof SalesforceError && error.code === "NOT_FOUND") return null;
      throw error;
    }
  }

  async readContact(id: string): Promise<{ id: string; name: string } | null> {
    try {
      const result = (await this.request(`/sobjects/Contact/${encodeURIComponent(id)}`)) as {
        Id?: string;
        Name?: string;
        FirstName?: string;
        LastName?: string;
      };
      if (!result.Id) return null;
      const name = result.Name ?? [result.FirstName, result.LastName].filter(Boolean).join(" ");
      return { id: result.Id, name };
    } catch (error) {
      if (error instanceof SalesforceError && error.code === "NOT_FOUND") return null;
      throw error;
    }
  }

  async deleteAccount(id: string): Promise<void> {
    try {
      await this.request(`/sobjects/Account/${encodeURIComponent(id)}`, { method: "DELETE" });
    } catch (error) {
      if (error instanceof SalesforceError && (error.code === "NOT_FOUND" || error.statusCode === 404)) return;
      throw error;
    }
  }

  async deleteContact(id: string): Promise<void> {
    try {
      await this.request(`/sobjects/Contact/${encodeURIComponent(id)}`, { method: "DELETE" });
    } catch (error) {
      if (error instanceof SalesforceError && (error.code === "NOT_FOUND" || error.statusCode === 404)) return;
      throw error;
    }
  }
}
