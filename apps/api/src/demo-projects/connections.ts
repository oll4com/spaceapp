import { createHash, randomBytes } from "node:crypto";
import type { DemoConnection, DemoConnectionProvider } from "@space/contracts";
import type { DemoConnectionRecord, DemoProjectsRepository } from "@space/db";
import type { DemoCredentialStore } from "./credentials.js";
import {
  GoogleSheetsApi,
  googleAccessTokenExpired,
  googleAuthorizationUrl,
  googleExchangeCode,
  googleRedirectUri,
  googleRefreshAccessToken,
  googleRevoke,
  type GoogleClientSettings,
  type GoogleTokenSet
} from "./google-sheets.js";
import {
  SalesforceApi,
  salesforceAccessTokenExpired,
  salesforceApiVersion,
  salesforceAuthorizationUrl,
  salesforceExchangeCode,
  salesforceRedirectUri,
  salesforceRefreshAccessToken,
  salesforceRevoke,
  type SalesforceClientSettings,
  type SalesforceIdentity,
  type SalesforceTokenSet
} from "./salesforce.js";

const oauthAttemptTtlMs = 10 * 60_000;

export class DemoConnectionError extends Error {
  constructor(readonly code: string, message: string, readonly statusCode = 400) {
    super(message);
    this.name = "DemoConnectionError";
  }
}

export interface DemoConnectionsServiceOptions {
  repository: DemoProjectsRepository;
  credentialStore: DemoCredentialStore;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

export interface DemoSalesforceCredentials extends SalesforceClientSettings {
  accessToken: string | null;
  refreshToken: string | null;
  instanceUrl: string | null;
  issuedAt: string | null;
  expiresAt: string | null;
  scope: string | null;
  identity: SalesforceIdentity | null;
}

export interface DemoGoogleCredentials extends GoogleClientSettings {
  accessToken: string | null;
  refreshToken: string | null;
  expiresAt: string | null;
  scope: string | null;
  accountEmail: string | null;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function codeChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

function newId(prefix: string): string {
  return `${prefix}:${randomBytes(9).toString("hex")}`;
}

export function providerLabel(provider: DemoConnectionProvider): string {
  return provider === "salesforce" ? "Salesforce" : "Google Sheets";
}

export class DemoConnectionsService {
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;
  private readonly salesforceFlights = new Map<string, Promise<DemoSalesforceCredentials>>();
  private readonly googleFlights = new Map<string, Promise<DemoGoogleCredentials>>();

  constructor(private readonly options: DemoConnectionsServiceOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? (() => new Date());
  }

  private credentialRef(ownerUserId: string, provider: DemoConnectionProvider): string {
    return `demo-${provider}-${digest(ownerUserId).slice(0, 24)}`;
  }

  async listConnections(ownerUserId: string, publicOrigin: string): Promise<DemoConnection[]> {
    const records = await this.options.repository.listConnections(ownerUserId);
    const byProvider = new Map(records.map((record) => [record.provider, record]));
    return (["salesforce", "google-sheets"] as const).map((provider) =>
      this.toPublic(provider, byProvider.get(provider) ?? null, publicOrigin)
    );
  }

  private toPublic(provider: DemoConnectionProvider, record: DemoConnectionRecord | null, publicOrigin: string): DemoConnection {
    if (!record) {
      return {
        provider,
        status: "UNCONFIGURED",
        configured: false,
        label: "",
        detail: null,
        scopes: [],
        redirectUri: provider === "salesforce" ? salesforceRedirectUri(publicOrigin) : googleRedirectUri(publicOrigin),
        connectedAt: null,
        lastRefreshedAt: null,
        lastCheckedAt: null,
        safeErrorCode: null,
        safeErrorMessage: null
      };
    }
    return {
      provider,
      status: record.status,
      configured: Boolean(record.clientId),
      label: record.label,
      detail: record.detail,
      scopes: [...record.scopes],
      redirectUri: provider === "salesforce" ? salesforceRedirectUri(publicOrigin) : googleRedirectUri(publicOrigin),
      connectedAt: record.connectedAt,
      lastRefreshedAt: record.lastRefreshedAt,
      lastCheckedAt: record.lastCheckedAt,
      safeErrorCode: record.safeErrorCode,
      safeErrorMessage: record.safeErrorMessage
    };
  }

  async isConnected(ownerUserId: string, provider: DemoConnectionProvider): Promise<boolean> {
    const record = await this.options.repository.getConnection(ownerUserId, provider);
    return Boolean(record && record.status === "CONNECTED" && record.credentialRef);
  }

  async connectedProviders(ownerUserId: string): Promise<DemoConnectionProvider[]> {
    const records = await this.options.repository.listConnections(ownerUserId);
    return records.filter((record) => record.status === "CONNECTED" && record.credentialRef).map((record) => record.provider);
  }

  async saveSettings(
    ownerUserId: string,
    provider: DemoConnectionProvider,
    input: { clientId: string; clientSecret?: string | null; loginUrl?: string }
  ): Promise<DemoConnectionRecord> {
    const existing = await this.options.repository.getConnection(ownerUserId, provider);
    const existingCredentials = existing?.credentialRef
      ? await this.readCredentials(ownerUserId, provider).catch(() => null)
      : null;
    const clientSecret = input.clientSecret?.trim() ? input.clientSecret.trim() : (existingCredentials?.clientSecret ?? null);
    const clientChanged = Boolean(existing?.clientId) && existing?.clientId !== input.clientId;
    const base = {
      id: existing?.id ?? newId("demo-connection"),
      ownerUserId,
      provider,
      status: clientChanged && existing?.status === "CONNECTED" ? ("NEEDS_RECONNECT" as const) : (existing?.status ?? "UNCONFIGURED"),
      label: existing?.label ?? "",
      detail: existing?.detail ?? null,
      clientId: input.clientId,
      loginUrl: provider === "salesforce" ? (input.loginUrl ?? existing?.loginUrl ?? "https://login.salesforce.com") : null,
      scopes: [...(existing?.scopes ?? [])],
      credentialRef: existing?.credentialRef ?? null,
      connectedAt: existing?.connectedAt ?? null,
      lastRefreshedAt: existing?.lastRefreshedAt ?? null,
      lastCheckedAt: existing?.lastCheckedAt ?? null,
      safeErrorCode: clientChanged && existing?.status === "CONNECTED" ? "CLIENT_CHANGED" : (existing?.safeErrorCode ?? null),
      safeErrorMessage:
        clientChanged && existing?.status === "CONNECTED"
          ? "The client credentials changed. Reconnect the account."
          : (existing?.safeErrorMessage ?? null)
    };
    const record = await this.options.repository.upsertConnection(base);
    const reference = this.credentialRef(ownerUserId, provider);
    await this.options.credentialStore.write(reference, {
      provider,
      clientId: input.clientId,
      clientSecret,
      loginUrl: provider === "salesforce" ? base.loginUrl : null,
      accessToken: existingCredentials?.accessToken ?? null,
      refreshToken: existingCredentials?.refreshToken ?? null,
      instanceUrl: existingCredentials?.instanceUrl ?? null,
      issuedAt: existingCredentials?.issuedAt ?? null,
      expiresAt: existingCredentials?.expiresAt ?? null,
      scope: existingCredentials?.scope ?? null,
      accountEmail: existingCredentials?.accountEmail ?? null,
      identity: existingCredentials?.identity ?? null
    });
    return this.options.repository.upsertConnection({ ...record, credentialRef: reference });
  }

  private async readCredentials(
    ownerUserId: string,
    provider: DemoConnectionProvider
  ): Promise<DemoSalesforceCredentials & DemoGoogleCredentials> {
    const payload = await this.options.credentialStore.read(this.credentialRef(ownerUserId, provider));
    const stringOrNull = (value: unknown): string | null => (typeof value === "string" && value.length > 0 ? value : null);
    return {
      clientId: typeof payload.clientId === "string" ? payload.clientId : "",
      clientSecret: stringOrNull(payload.clientSecret),
      loginUrl: stringOrNull(payload.loginUrl) ?? "https://login.salesforce.com",
      accessToken: stringOrNull(payload.accessToken),
      refreshToken: stringOrNull(payload.refreshToken),
      instanceUrl: stringOrNull(payload.instanceUrl),
      issuedAt: stringOrNull(payload.issuedAt),
      expiresAt: stringOrNull(payload.expiresAt),
      scope: stringOrNull(payload.scope),
      accountEmail: stringOrNull(payload.accountEmail),
      identity: (payload.identity as SalesforceIdentity | null | undefined) ?? null
    };
  }

  private async writeCredentials(
    ownerUserId: string,
    provider: DemoConnectionProvider,
    credentials: Partial<DemoSalesforceCredentials & DemoGoogleCredentials>
  ): Promise<void> {
    const current = await this.readCredentials(ownerUserId, provider).catch(() => null);
    const merged = { ...(current ?? { provider }), ...credentials, provider };
    await this.options.credentialStore.write(this.credentialRef(ownerUserId, provider), { ...merged });
  }

  async startOAuth(input: {
    ownerUserId: string;
    provider: DemoConnectionProvider;
    sessionToken: string;
    publicOrigin: string;
  }): Promise<{ authorizationUrl: string; expiresAt: string; redirectUri: string }> {
    if (!input.sessionToken) throw new DemoConnectionError("DEMO_OAUTH_SESSION_REQUIRED", "A browser session is required.", 401);
    const record = await this.options.repository.getConnection(input.ownerUserId, input.provider);
    if (!record?.clientId) {
      throw new DemoConnectionError(
        "DEMO_CONNECTION_NOT_CONFIGURED",
        `Add the ${providerLabel(input.provider)} client credentials first.`,
        409
      );
    }
    const credentials = await this.readCredentials(input.ownerUserId, input.provider);
    const state = randomBytes(32).toString("base64url");
    const verifier = randomBytes(48).toString("base64url");
    const verifierRef = newId("demo-verifier");
    const createdAt = this.now();
    const expiresAt = new Date(createdAt.getTime() + oauthAttemptTtlMs).toISOString();
    const redirectUri = input.provider === "salesforce" ? salesforceRedirectUri(input.publicOrigin) : googleRedirectUri(input.publicOrigin);
    const expired = await this.options.repository.deleteExpiredOAuthAttempts(createdAt.toISOString());
    await Promise.all(expired.map((attempt) => this.options.credentialStore.delete(attempt.verifierRef)));
    await this.options.credentialStore.write(verifierRef, { codeVerifier: verifier });
    try {
      await this.options.repository.createOAuthAttempt({
        id: newId("demo-attempt"),
        ownerUserId: input.ownerUserId,
        provider: input.provider,
        stateHash: digest(state),
        sessionHash: digest(input.sessionToken),
        verifierRef,
        redirectUri,
        expiresAt
      });
    } catch (error) {
      await this.options.credentialStore.delete(verifierRef);
      throw error;
    }
    const settings = { clientId: credentials.clientId, clientSecret: credentials.clientSecret, loginUrl: credentials.loginUrl };
    const authorizationUrl =
      input.provider === "salesforce"
        ? salesforceAuthorizationUrl({ settings, redirectUri, state, codeChallenge: codeChallenge(verifier) })
        : googleAuthorizationUrl({ settings, redirectUri, state, codeChallenge: codeChallenge(verifier) });
    return { authorizationUrl, expiresAt, redirectUri };
  }

  async completeOAuth(input: {
    provider: DemoConnectionProvider;
    code: string;
    state: string;
    sessionToken: string;
    publicOrigin: string;
  }): Promise<DemoConnectionRecord> {
    const consumedAt = this.now().toISOString();
    const attempt = await this.options.repository.consumeOAuthAttempt({
      stateHash: digest(input.state),
      sessionHash: digest(input.sessionToken),
      consumedAt
    });
    if (!attempt || attempt.provider !== input.provider) {
      throw new DemoConnectionError("DEMO_OAUTH_STATE_INVALID", "The OAuth state is expired, reused, or belongs to another session.", 400);
    }
    let verifier = "";
    try {
      const stored = await this.options.credentialStore.read(attempt.verifierRef);
      verifier = typeof stored.codeVerifier === "string" ? stored.codeVerifier : "";
    } finally {
      await this.options.credentialStore.delete(attempt.verifierRef);
    }
    if (!verifier) throw new DemoConnectionError("DEMO_OAUTH_VERIFIER_MISSING", "The OAuth verifier is unavailable.", 400);
    const credentials = await this.readCredentials(attempt.ownerUserId, input.provider);
    if (input.provider === "salesforce") {
      const settings: SalesforceClientSettings = {
        clientId: credentials.clientId,
        clientSecret: credentials.clientSecret,
        loginUrl: credentials.loginUrl
      };
      const { tokens, identity } = await salesforceExchangeCode({
        settings,
        code: input.code,
        redirectUri: attempt.redirectUri,
        codeVerifier: verifier,
        fetchImpl: this.fetchImpl
      });
      await this.writeCredentials(attempt.ownerUserId, input.provider, {
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        instanceUrl: tokens.instanceUrl,
        issuedAt: tokens.issuedAt,
        expiresAt: tokens.expiresAt,
        scope: tokens.scope,
        identity
      });
      return this.options.repository.upsertConnection(
        await this.connectionBase(attempt.ownerUserId, input.provider, {
          status: "CONNECTED",
          label: identity?.displayName ?? "Salesforce account",
          detail: tokens.instanceUrl,
          scopes: [...(tokens.scope?.split(" ") ?? ["api", "refresh_token"])]
        })
      );
    }
    const settings: GoogleClientSettings = { clientId: credentials.clientId, clientSecret: credentials.clientSecret };
    const tokens = await googleExchangeCode({
      settings,
      code: input.code,
      redirectUri: attempt.redirectUri,
      codeVerifier: verifier,
      fetchImpl: this.fetchImpl
    });
    await this.writeCredentials(attempt.ownerUserId, input.provider, {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: tokens.expiresAt,
      scope: tokens.scope,
      accountEmail: tokens.accountEmail
    });
    return this.options.repository.upsertConnection(
      await this.connectionBase(attempt.ownerUserId, input.provider, {
        status: "CONNECTED",
        label: tokens.accountEmail ?? "Google account",
        detail: null,
        scopes: [...(tokens.scope?.split(" ") ?? ["spreadsheets"])]
      })
    );
  }

  private async connectionBase(
    ownerUserId: string,
    provider: DemoConnectionProvider,
    overrides: Partial<Omit<DemoConnectionRecord, "createdAt" | "updatedAt">>
  ): Promise<Omit<DemoConnectionRecord, "createdAt" | "updatedAt">> {
    const existing = await this.options.repository.getConnection(ownerUserId, provider);
    const credentials = await this.readCredentials(ownerUserId, provider).catch(() => null);
    const nowIso = this.now().toISOString();
    return {
      id: existing?.id ?? newId("demo-connection"),
      ownerUserId,
      provider,
      status: existing?.status ?? "UNCONFIGURED",
      label: existing?.label ?? "",
      detail: existing?.detail ?? null,
      clientId: credentials?.clientId ?? existing?.clientId ?? null,
      loginUrl: provider === "salesforce" ? (credentials?.loginUrl ?? existing?.loginUrl ?? "https://login.salesforce.com") : null,
      scopes: [...(existing?.scopes ?? [])],
      credentialRef: this.credentialRef(ownerUserId, provider),
      connectedAt: existing?.connectedAt ?? nowIso,
      lastRefreshedAt: existing?.lastRefreshedAt ?? null,
      lastCheckedAt: nowIso,
      safeErrorCode: null,
      safeErrorMessage: null,
      ...overrides
    };
  }

  async markStatus(
    ownerUserId: string,
    provider: DemoConnectionProvider,
    input: { status: DemoConnectionRecord["status"]; safeErrorCode?: string | null; safeErrorMessage?: string | null; lastRefreshedAt?: string | null }
  ): Promise<DemoConnectionRecord | null> {
    const existing = await this.options.repository.getConnection(ownerUserId, provider);
    if (!existing) return null;
    return this.options.repository.upsertConnection({
      ...existing,
      status: input.status,
      safeErrorCode: input.safeErrorCode ?? null,
      safeErrorMessage: input.safeErrorMessage ?? null,
      lastRefreshedAt: input.lastRefreshedAt ?? existing.lastRefreshedAt
    });
  }

  async disconnect(ownerUserId: string, provider: DemoConnectionProvider): Promise<void> {
    const credentials = await this.readCredentials(ownerUserId, provider).catch(() => null);
    if (credentials) {
      const token = credentials.refreshToken ?? credentials.accessToken;
      if (token) {
        if (provider === "salesforce") {
          await salesforceRevoke({ settings: { clientId: credentials.clientId, clientSecret: credentials.clientSecret, loginUrl: credentials.loginUrl }, token, fetchImpl: this.fetchImpl });
        } else {
          await googleRevoke({ token, fetchImpl: this.fetchImpl });
        }
      }
      await this.writeCredentials(ownerUserId, provider, {
        accessToken: null,
        refreshToken: null,
        expiresAt: null,
        scope: null,
        instanceUrl: null,
        identity: null
      });
    }
    const existing = await this.options.repository.getConnection(ownerUserId, provider);
    if (!existing) return;
    await this.options.repository.upsertConnection({
      ...existing,
      status: "UNCONFIGURED",
      label: "",
      detail: null,
      scopes: [],
      connectedAt: null,
      lastRefreshedAt: null,
      lastCheckedAt: this.now().toISOString(),
      safeErrorCode: null,
      safeErrorMessage: null
    });
  }

  async salesforceClient(ownerUserId: string): Promise<{ api: SalesforceApi; identity: SalesforceIdentity | null }> {
    const credentials = await this.salesforceCredentials(ownerUserId);
    return {
      api: new SalesforceApi(
        {
          accessToken: credentials.accessToken!,
          refreshToken: credentials.refreshToken,
          instanceUrl: credentials.instanceUrl!,
          issuedAt: credentials.issuedAt ?? new Date().toISOString(),
          expiresAt: credentials.expiresAt!,
          scope: credentials.scope,
          tokenType: "Bearer"
        },
        this.fetchImpl,
        salesforceApiVersion()
      ),
      identity: credentials.identity
    };
  }

  async salesforceCredentials(ownerUserId: string): Promise<DemoSalesforceCredentials> {
    const flight = this.salesforceFlights.get(ownerUserId);
    if (flight) return flight;
    const promise = this.loadSalesforce(ownerUserId).finally(() => this.salesforceFlights.delete(ownerUserId));
    this.salesforceFlights.set(ownerUserId, promise);
    return promise;
  }

  private async loadSalesforce(ownerUserId: string): Promise<DemoSalesforceCredentials> {
    const record = await this.options.repository.getConnection(ownerUserId, "salesforce");
    const credentials = await this.readCredentials(ownerUserId, "salesforce").catch(() => null);
    if (!record || !credentials || !credentials.accessToken || !credentials.instanceUrl) {
      throw new DemoConnectionError("DEMO_SALESFORCE_NOT_CONNECTED", "Salesforce is not connected for this user.", 409);
    }
    const tokenSet: SalesforceTokenSet = {
      accessToken: credentials.accessToken,
      refreshToken: credentials.refreshToken,
      instanceUrl: credentials.instanceUrl,
      issuedAt: credentials.issuedAt ?? new Date().toISOString(),
      expiresAt: credentials.expiresAt ?? new Date().toISOString(),
      scope: credentials.scope,
      tokenType: "Bearer"
    };
    if (!salesforceAccessTokenExpired(tokenSet, this.now())) return credentials;
    if (!credentials.refreshToken) {
      await this.markStatus(ownerUserId, "salesforce", {
        status: "NEEDS_RECONNECT",
        safeErrorCode: "SALESFORCE_REFRESH_MISSING",
        safeErrorMessage: "The Salesforce connection has no refresh token. Reconnect the account."
      });
      throw new DemoConnectionError("DEMO_SALESFORCE_RECONNECT", "The Salesforce connection must be reconnected.", 409);
    }
    try {
      const refreshed = await salesforceRefreshAccessToken({
        settings: { clientId: credentials.clientId, clientSecret: credentials.clientSecret, loginUrl: credentials.loginUrl },
        tokens: tokenSet,
        fetchImpl: this.fetchImpl
      });
      await this.writeCredentials(ownerUserId, "salesforce", {
        accessToken: refreshed.accessToken,
        refreshToken: refreshed.refreshToken,
        instanceUrl: refreshed.instanceUrl,
        issuedAt: refreshed.issuedAt,
        expiresAt: refreshed.expiresAt,
        scope: refreshed.scope
      });
      await this.markStatus(ownerUserId, "salesforce", { status: "CONNECTED", lastRefreshedAt: this.now().toISOString() });
      return {
        ...credentials,
        accessToken: refreshed.accessToken,
        refreshToken: refreshed.refreshToken,
        instanceUrl: refreshed.instanceUrl,
        issuedAt: refreshed.issuedAt,
        expiresAt: refreshed.expiresAt,
        scope: refreshed.scope
      };
    } catch (error) {
      const revoked = error instanceof Error && /REVOKED|REFRESH_MISSING/.test((error as { code?: string }).code ?? "");
      await this.markStatus(ownerUserId, "salesforce", {
        status: revoked ? "NEEDS_RECONNECT" : "ERROR",
        safeErrorCode: (error as { code?: string }).code ?? "SALESFORCE_REFRESH_FAILED",
        safeErrorMessage: error instanceof Error ? error.message.slice(0, 300) : "Salesforce refresh failed."
      });
      throw new DemoConnectionError("DEMO_SALESFORCE_RECONNECT", "The Salesforce connection must be reconnected.", 409);
    }
  }

  async googleSheetsClient(ownerUserId: string): Promise<GoogleSheetsApi> {
    const credentials = await this.googleCredentials(ownerUserId);
    return new GoogleSheetsApi(
      {
        accessToken: credentials.accessToken!,
        refreshToken: credentials.refreshToken,
        expiresAt: credentials.expiresAt!,
        scope: credentials.scope,
        accountEmail: credentials.accountEmail
      },
      this.fetchImpl
    );
  }

  async googleCredentials(ownerUserId: string): Promise<DemoGoogleCredentials> {
    const flight = this.googleFlights.get(ownerUserId);
    if (flight) return flight;
    const promise = this.loadGoogle(ownerUserId).finally(() => this.googleFlights.delete(ownerUserId));
    this.googleFlights.set(ownerUserId, promise);
    return promise;
  }

  private async loadGoogle(ownerUserId: string): Promise<DemoGoogleCredentials> {
    const record = await this.options.repository.getConnection(ownerUserId, "google-sheets");
    const credentials = await this.readCredentials(ownerUserId, "google-sheets").catch(() => null);
    if (!record || !credentials || !credentials.accessToken) {
      throw new DemoConnectionError("DEMO_GOOGLE_NOT_CONNECTED", "Google Sheets is not connected for this user.", 409);
    }
    const tokenSet: GoogleTokenSet = {
      accessToken: credentials.accessToken,
      refreshToken: credentials.refreshToken,
      expiresAt: credentials.expiresAt ?? new Date().toISOString(),
      scope: credentials.scope,
      accountEmail: credentials.accountEmail
    };
    if (!googleAccessTokenExpired(tokenSet, this.now())) return credentials;
    if (!credentials.refreshToken) {
      await this.markStatus(ownerUserId, "google-sheets", {
        status: "NEEDS_RECONNECT",
        safeErrorCode: "GOOGLE_REFRESH_MISSING",
        safeErrorMessage: "The Google connection has no refresh token. Reconnect the account."
      });
      throw new DemoConnectionError("DEMO_GOOGLE_RECONNECT", "The Google connection must be reconnected.", 409);
    }
    try {
      const refreshed = await googleRefreshAccessToken({
        settings: { clientId: credentials.clientId, clientSecret: credentials.clientSecret },
        tokens: tokenSet,
        fetchImpl: this.fetchImpl
      });
      await this.writeCredentials(ownerUserId, "google-sheets", {
        accessToken: refreshed.accessToken,
        refreshToken: refreshed.refreshToken,
        expiresAt: refreshed.expiresAt,
        scope: refreshed.scope,
        accountEmail: refreshed.accountEmail
      });
      await this.markStatus(ownerUserId, "google-sheets", { status: "CONNECTED", lastRefreshedAt: this.now().toISOString() });
      return {
        ...credentials,
        accessToken: refreshed.accessToken,
        refreshToken: refreshed.refreshToken,
        expiresAt: refreshed.expiresAt,
        scope: refreshed.scope,
        accountEmail: refreshed.accountEmail
      };
    } catch (error) {
      const revoked = error instanceof Error && /REVOKED|REFRESH_MISSING/.test((error as { code?: string }).code ?? "");
      await this.markStatus(ownerUserId, "google-sheets", {
        status: revoked ? "NEEDS_RECONNECT" : "ERROR",
        safeErrorCode: (error as { code?: string }).code ?? "GOOGLE_REFRESH_FAILED",
        safeErrorMessage: error instanceof Error ? error.message.slice(0, 300) : "Google refresh failed."
      });
      throw new DemoConnectionError("DEMO_GOOGLE_RECONNECT", "The Google connection must be reconnected.", 409);
    }
  }
}
