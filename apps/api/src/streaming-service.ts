import { createHash, randomBytes } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  streamingCatalogResponseSchema,
  streamingDisconnectAuthorizationResponseSchema,
  streamingMetricDefinitions,
  streamingOAuthStartResponseSchema,
  streamingOverlaySnapshotSchema,
  streamingVerifyAccountResponseSchema,
  updateStreamingOverlaySettingsInputSchema,
  type StreamingAuthorization,
  type StreamingCatalogResponse,
  type StreamingDisconnectAuthorizationResponse,
  type StreamingMetricKey,
  type StreamingMetricTileSnapshot,
  type StreamingOAuthProvider,
  type StreamingOAuthStartResponse,
  type StreamingOverlaySettings,
  type StreamingOverlaySnapshot,
  type StreamingOverlayTile,
  type StreamingPlatformAccount,
  type StreamingVerifyAccountResponse,
  type UpdateStreamingOverlaySettingsInput,
  type StreamingBotTickerItem
} from "@space/contracts";
import {
  StreamingSettingsVersionConflictError,
  type StreamingAuthorizationRecord,
  type StreamingPlatformAccountRecord,
  type StreamingRepository
} from "@space/db";
import type { SpaceStore } from "@space/runtime";
import type { ActiveAgentCountProvider } from "./active-agent-count.js";
import { StreamingCredentialStore, streamingProviderScopes } from "./streaming-credential-store.js";
import {
  createStreamingProviderAdapters,
  parseStreamingTokenSet,
  serializeStreamingTokenSet,
  StreamingProviderError,
  type StreamingDiscoveredAccount,
  type StreamingProviderAdapter,
  type StreamingProviderMetricMap,
  type StreamingProviderMetricValue,
  type StreamingTokenSet
} from "./streaming-providers.js";

const providerList: StreamingOAuthProvider[] = ["YOUTUBE", "TWITCH", "TIKTOK"];
const oauthAttemptTtlMs = 10 * 60 * 1000;

export class StreamingServiceError extends Error {
  constructor(readonly code: string, message: string, readonly statusCode: number) {
    super(message);
    this.name = "StreamingServiceError";
  }
}

export { StreamingSettingsVersionConflictError };

interface CachedMetricGroup {
  expiresAt: number;
  values: StreamingProviderMetricMap;
}

interface StreamingServiceOptions {
  repository: StreamingRepository;
  credentialStore: StreamingCredentialStore;
  store: SpaceStore;
  activeAgentCountProvider?: ActiveAgentCountProvider;
  adapters?: Record<StreamingOAuthProvider, StreamingProviderAdapter>;
  now?: () => Date;
  youtubeDailyQuotaBudget?: number;
  cleanupCredentialRootOnDispose?: boolean;
  botTickerProvider?: () => Promise<{ enabled: boolean; ticker: StreamingBotTickerItem[] }>;
}

class YouTubeQuotaGovernor {
  private date = "";
  private used = 0;

  constructor(private readonly budget: number, private readonly now: () => Date) {}

  consume(units: number): void {
    const date = this.now().toISOString().slice(0, 10);
    if (date !== this.date) {
      this.date = date;
      this.used = 0;
    }
    if (!Number.isFinite(units) || units <= 0 || this.used + units > this.budget) {
      throw new StreamingProviderError(
        "YOUTUBE_QUOTA_BUDGET",
        `The configured YouTube daily quota budget of ${this.budget} units is exhausted.`,
        true,
        429
      );
    }
    this.used += Math.ceil(units);
  }
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function randomId(prefix: string): string {
  return `${prefix}:${randomBytes(18).toString("base64url")}`;
}

function codeChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

function safeProviderFailure(error: unknown): { code: string; message: string; transient: boolean } {
  if (error instanceof StreamingProviderError) {
    return { code: error.code.slice(0, 100), message: error.message.slice(0, 500), transient: error.transient };
  }
  return { code: "PROVIDER_FAILED", message: "The provider request failed.", transient: true };
}

function publicAccount(record: StreamingPlatformAccountRecord): StreamingPlatformAccount {
  return {
    id: record.id,
    authorizationId: record.authorizationId,
    provider: record.provider,
    externalAccountId: record.externalAccountId,
    displayName: record.displayName,
    badge: record.badge,
    status: record.status,
    analyticsPeriod: record.analyticsPeriod,
    verifiedAt: record.verifiedAt,
    safeErrorCode: record.safeErrorCode,
    safeErrorMessage: record.safeErrorMessage,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt
  };
}

function publicAuthorization(record: StreamingAuthorizationRecord, accountCount: number): StreamingAuthorization {
  return {
    id: record.id,
    provider: record.provider,
    status: record.status,
    scopes: record.scopes,
    accountCount,
    lastRefreshedAt: record.lastRefreshedAt,
    safeErrorCode: record.safeErrorCode,
    safeErrorMessage: record.safeErrorMessage,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt
  };
}

function metricDefinition(key: StreamingMetricKey) {
  const definition = streamingMetricDefinitions.find((candidate) => candidate.key === key);
  if (!definition) throw new StreamingServiceError("METRIC_UNKNOWN", `Streaming metric ${key} is not supported.`, 422);
  return definition;
}

type ProviderMetricGroup = "YOUTUBE_CHANNEL" | "YOUTUBE_LIVE" | "YOUTUBE_ANALYTICS" | "TWITCH_CHANNEL" | "TWITCH_LIVE" | "TIKTOK_PROFILE";

function metricGroup(key: StreamingMetricKey): ProviderMetricGroup | "SPACE" {
  if (key.startsWith("space.")) return "SPACE";
  if (key.startsWith("youtube.channel.")) return "YOUTUBE_CHANNEL";
  if (key.startsWith("youtube.live.")) return "YOUTUBE_LIVE";
  if (key.startsWith("youtube.analytics.")) return "YOUTUBE_ANALYTICS";
  if (key === "twitch.concurrent_viewers" || key === "twitch.live_duration") return "TWITCH_LIVE";
  if (key.startsWith("twitch.")) return "TWITCH_CHANNEL";
  return "TIKTOK_PROFILE";
}

function groupTtl(group: ProviderMetricGroup): number {
  switch (group) {
    case "YOUTUBE_LIVE": return 60_000;
    case "TWITCH_LIVE": return 15_000;
    case "YOUTUBE_ANALYTICS": return 15 * 60_000;
    case "YOUTUBE_CHANNEL":
    case "TWITCH_CHANNEL":
    case "TIKTOK_PROFILE":
      return 5 * 60_000;
  }
}

function staleValues(values: StreamingProviderMetricMap): StreamingProviderMetricMap {
  return Object.fromEntries(
    Object.entries(values).map(([key, value]) => [key, value ? { ...value, state: "STALE" } : value])
  ) as StreamingProviderMetricMap;
}

function tokenNeedsRefresh(token: StreamingTokenSet, now: Date): boolean {
  return token.expiresAt !== null && Date.parse(token.expiresAt) <= now.getTime() + 60_000;
}

export class StreamingService {
  private readonly adapters: Record<StreamingOAuthProvider, StreamingProviderAdapter>;
  private readonly now: () => Date;
  private readonly quota: YouTubeQuotaGovernor;
  private readonly metricCache = new Map<string, CachedMetricGroup>();
  private readonly metricFlights = new Map<string, Promise<StreamingProviderMetricMap>>();
  private readonly tokenFlights = new Map<string, Promise<StreamingTokenSet>>();
  private spaceCache: { expiresAt: number; values: Record<string, StreamingProviderMetricValue> } | null = null;

  constructor(private readonly options: StreamingServiceOptions) {
    this.adapters = options.adapters ?? createStreamingProviderAdapters();
    this.now = options.now ?? (() => new Date());
    this.quota = new YouTubeQuotaGovernor(options.youtubeDailyQuotaBudget ?? 8_000, this.now);
  }

  async initialize(): Promise<void> {
    await this.options.credentialStore.initialize();
  }

  async catalog(): Promise<StreamingCatalogResponse> {
    const [providers, authorizations, accounts, settings] = await Promise.all([
      Promise.all(providerList.map((provider) => this.options.credentialStore.readiness(provider))),
      this.options.repository.listAuthorizations(),
      this.options.repository.listAccounts(),
      this.options.repository.getOverlaySettings()
    ]);
    const accountCount = new Map<string, number>();
    for (const account of accounts) accountCount.set(account.authorizationId, (accountCount.get(account.authorizationId) ?? 0) + 1);
    return streamingCatalogResponseSchema.parse({
      providers,
      metrics: streamingMetricDefinitions,
      authorizations: authorizations.map((authorization) => publicAuthorization(authorization, accountCount.get(authorization.id) ?? 0)),
      accounts: accounts.map(publicAccount),
      settings
    });
  }

  async startOAuth(provider: StreamingOAuthProvider, sessionToken: string): Promise<StreamingOAuthStartResponse> {
    if (!sessionToken) throw new StreamingServiceError("OAUTH_SESSION_REQUIRED", "A valid Space browser session is required.", 401);
    const readiness = await this.options.credentialStore.readiness(provider);
    if (readiness.status !== "READY") throw new StreamingServiceError(readiness.code, readiness.message, 503);
    const client = await this.options.credentialStore.readClient(provider);
    const state = randomBytes(32).toString("base64url");
    const verifier = randomBytes(48).toString("base64url");
    const verifierCredentialRef = randomId("streaming-verifier");
    const createdAt = this.now();
    const expiresAt = new Date(createdAt.getTime() + oauthAttemptTtlMs).toISOString();

    const expired = await this.options.repository.deleteExpiredOAuthAttempts(createdAt.toISOString());
    await Promise.all(expired.map((attempt) => this.options.credentialStore.deleteCredential(attempt.verifierCredentialRef)));
    await this.options.credentialStore.writeCredential(verifierCredentialRef, { codeVerifier: verifier });
    try {
      await this.options.repository.createOAuthAttempt({
        id: randomId("streaming-attempt"),
        provider,
        stateHash: digest(state),
        sessionHash: digest(sessionToken),
        verifierCredentialRef,
        redirectUri: client.redirectUri,
        expiresAt
      });
    } catch (error) {
      await this.options.credentialStore.deleteCredential(verifierCredentialRef);
      throw error;
    }

    return streamingOAuthStartResponseSchema.parse({
      provider,
      authorizationUrl: this.adapters[provider].authorizationUrl({ client, state, codeChallenge: codeChallenge(verifier) }),
      expiresAt
    });
  }

  async completeOAuth(input: {
    provider: StreamingOAuthProvider;
    code: string;
    state: string;
    sessionToken: string;
  }): Promise<{ authorization: StreamingAuthorizationRecord; accounts: StreamingPlatformAccountRecord[] }> {
    if (!input.code || !input.state || !input.sessionToken) {
      throw new StreamingServiceError("OAUTH_CALLBACK_INVALID", "The OAuth callback is incomplete.", 400);
    }
    const consumedAt = this.now().toISOString();
    const attempt = await this.options.repository.consumeOAuthAttempt({
      stateHash: digest(input.state),
      sessionHash: digest(input.sessionToken),
      consumedAt
    });
    if (!attempt || attempt.provider !== input.provider) {
      throw new StreamingServiceError("OAUTH_STATE_INVALID", "The OAuth state is expired, reused, or belongs to another session.", 400);
    }
    const client = await this.options.credentialStore.readClient(input.provider);
    if (client.redirectUri !== attempt.redirectUri) {
      await this.options.credentialStore.deleteCredential(attempt.verifierCredentialRef);
      throw new StreamingServiceError("OAUTH_REDIRECT_CHANGED", "The provider callback configuration changed during OAuth.", 400);
    }
    let verifier = "";
    try {
      const stored = await this.options.credentialStore.readCredential(attempt.verifierCredentialRef);
      verifier = typeof stored.codeVerifier === "string" ? stored.codeVerifier : "";
    } finally {
      await this.options.credentialStore.deleteCredential(attempt.verifierCredentialRef);
    }
    if (!verifier) throw new StreamingServiceError("OAUTH_VERIFIER_MISSING", "The OAuth verifier is unavailable.", 400);

    const adapter = this.adapters[input.provider];
    const exchanged = await adapter.exchangeCode({ client, code: input.code, codeVerifier: verifier });
    const discovered = await adapter.discoverAccounts({ client, token: exchanged });
    const grantSubject = exchanged.grantSubject ?? discovered[0]?.grantSubject;
    if (!grantSubject) throw new StreamingServiceError("OAUTH_GRANT_SUBJECT_MISSING", "The provider grant could not be identified.", 502);
    const token: StreamingTokenSet = { ...exchanged, grantSubject };
    const existing = (await this.options.repository.listAuthorizations()).find(
      (authorization) => authorization.provider === input.provider && authorization.externalGrantId === grantSubject
    );
    const credentialRef = existing?.credentialRef ?? randomId("streaming-credential");
    await this.options.credentialStore.writeCredential(credentialRef, serializeStreamingTokenSet(token));
    const authorization = await this.options.repository.upsertAuthorization({
      id: existing?.id ?? randomId("streaming-auth"),
      provider: input.provider,
      externalGrantId: grantSubject,
      credentialRef,
      status: "ACTIVE",
      scopes: token.scopes.length ? token.scopes : streamingProviderScopes[input.provider],
      safeErrorCode: null,
      safeErrorMessage: null,
      lastRefreshedAt: consumedAt
    });
    const accounts: StreamingPlatformAccountRecord[] = [];
    for (const account of discovered) {
      accounts.push(await this.options.repository.upsertAccount({
        id: randomId("streaming-account"),
        authorizationId: authorization.id,
        provider: input.provider,
        externalAccountId: account.externalAccountId,
        displayName: account.displayName,
        badge: account.badge,
        status: "ACTIVE",
        verifiedAt: consumedAt,
        safeErrorCode: null,
        safeErrorMessage: null
      }));
    }
    return { authorization, accounts };
  }

  async verifyAccount(accountId: string): Promise<StreamingVerifyAccountResponse> {
    const account = await this.requiredAccount(accountId);
    const authorization = await this.requiredAuthorization(account.authorizationId);
    if (authorization.status !== "ACTIVE") {
      throw new StreamingServiceError("AUTHORIZATION_INACTIVE", "The provider authorization is not active.", 409);
    }
    try {
      const client = await this.options.credentialStore.readClient(account.provider);
      const token = await this.activeToken(authorization, client);
      const discovered = await this.adapters[account.provider].discoverAccounts({ client, token });
      if (!discovered.some((candidate) => candidate.externalAccountId === account.externalAccountId)) {
        throw new StreamingProviderError("ACCOUNT_NOT_OWNED", "The connected grant no longer exposes this account.", false);
      }
      const updated = await this.options.repository.updateAccount({
        id: account.id,
        status: "ACTIVE",
        verifiedAt: this.now().toISOString(),
        safeErrorCode: null,
        safeErrorMessage: null
      });
      return streamingVerifyAccountResponseSchema.parse({ account: publicAccount(updated) });
    } catch (error) {
      const safe = safeProviderFailure(error);
      await this.options.repository.updateAccount({
        id: account.id,
        status: "ERROR",
        safeErrorCode: safe.code,
        safeErrorMessage: safe.message
      });
      throw new StreamingServiceError(safe.code, safe.message, safe.transient ? 503 : 422);
    }
  }

  async removeAccount(accountId: string): Promise<StreamingPlatformAccount> {
    const deleted = await this.options.repository.deleteAccount(accountId);
    if (!deleted) throw new StreamingServiceError("ACCOUNT_NOT_FOUND", "The streaming account was not found.", 404);
    this.invalidateAccount(accountId);
    return publicAccount(deleted);
  }

  async disconnectAuthorization(authorizationId: string): Promise<StreamingDisconnectAuthorizationResponse> {
    const authorization = await this.requiredAuthorization(authorizationId);
    try {
      const client = await this.options.credentialStore.readClient(authorization.provider);
      const token = parseStreamingTokenSet(await this.options.credentialStore.readCredential(authorization.credentialRef));
      await this.adapters[authorization.provider].revoke({ client, token });
      const accounts = (await this.options.repository.listAccounts()).filter((account) => account.authorizationId === authorization.id);
      await this.options.repository.deleteAuthorization(authorization.id);
      await this.options.credentialStore.deleteCredential(authorization.credentialRef);
      accounts.forEach((account) => this.invalidateAccount(account.id));
      return streamingDisconnectAuthorizationResponseSchema.parse({
        authorizationId,
        status: "REVOKED",
        disconnected: true
      });
    } catch (error) {
      const safe = safeProviderFailure(error);
      const status = safe.transient ? "REVOKE_PENDING" : "ERROR";
      await this.options.repository.setAuthorizationStatus({
        id: authorization.id,
        status,
        safeErrorCode: safe.code,
        safeErrorMessage: safe.message
      });
      return streamingDisconnectAuthorizationResponseSchema.parse({ authorizationId, status, disconnected: false });
    }
  }

  async updateOverlaySettings(input: UpdateStreamingOverlaySettingsInput, updatedBy: string): Promise<StreamingOverlaySettings> {
    const parsed = updateStreamingOverlaySettingsInputSchema.parse(input);
    const accounts = new Map((await this.options.repository.listAccounts()).map((account) => [account.id, account]));
    for (const tile of parsed.tiles) {
      const definition = metricDefinition(tile.metricKey);
      if (definition.provider === "SPACE") continue;
      const account = tile.accountId ? accounts.get(tile.accountId) : null;
      if (!account || account.provider !== definition.provider || account.status === "DISCONNECTED") {
        throw new StreamingServiceError("OVERLAY_ACCOUNT_INVALID", `The account for ${definition.label} is unavailable.`, 422);
      }
    }
    return this.options.repository.updateOverlaySettings({
      ...parsed,
      updatedBy,
      updatedAt: this.now().toISOString()
    });
  }

  async overlaySnapshot(): Promise<StreamingOverlaySnapshot> {
    const settings = await this.options.repository.getOverlaySettings();
    const accounts = new Map((await this.options.repository.listAccounts()).map((account) => [account.id, account]));
    const authorizations = new Map((await this.options.repository.listAuthorizations()).map((authorization) => [authorization.id, authorization]));
    const grouped = new Map<string, { account: StreamingPlatformAccountRecord; authorization: StreamingAuthorizationRecord; group: ProviderMetricGroup; tiles: StreamingOverlayTile[] }>();
    for (const tile of settings.tiles) {
      if (!tile.accountId || metricGroup(tile.metricKey) === "SPACE") continue;
      const account = accounts.get(tile.accountId);
      const authorization = account ? authorizations.get(account.authorizationId) : null;
      const group = metricGroup(tile.metricKey);
      if (!account || !authorization || group === "SPACE") continue;
      const period = tile.analyticsPeriod ?? account.analyticsPeriod;
      const key = `${account.id}\u0000${group}\u0000${period}`;
      const entry = grouped.get(key) ?? { account, authorization, group, tiles: [] };
      entry.tiles.push(tile);
      grouped.set(key, entry);
    }
    const collected = new Map<string, StreamingProviderMetricMap>();
    await Promise.all([...grouped.entries()].map(async ([key, group]) => {
      collected.set(key, await this.collectProviderGroup(group.account, group.authorization, group.group, group.tiles));
    }));
    const space = await this.collectSpaceMetrics();
    const tiles: StreamingMetricTileSnapshot[] = settings.tiles.map((tile) => {
      const definition = metricDefinition(tile.metricKey);
      if (definition.provider === "SPACE") {
        const current = space[tile.metricKey];
        return {
          metricKey: tile.metricKey,
          accountId: null,
          provider: "SPACE",
          label: definition.label,
          badge: "Space",
          value: current?.value ?? null,
          state: current?.state ?? "UNAVAILABLE",
          sampledAt: current?.sampledAt ?? null
        };
      }
      const account = tile.accountId ? accounts.get(tile.accountId) : null;
      const authorization = account ? authorizations.get(account.authorizationId) : null;
      const group = metricGroup(tile.metricKey);
      const period = tile.analyticsPeriod ?? account?.analyticsPeriod ?? 28;
      const key = account && group !== "SPACE" ? `${account.id}\u0000${group}\u0000${period}` : "";
      const current = key ? collected.get(key)?.[tile.metricKey] : null;
      const inactive = !authorization || authorization.status !== "ACTIVE" || !account || account.status === "DISCONNECTED";
      return {
        metricKey: tile.metricKey,
        accountId: tile.accountId,
        provider: definition.provider,
        label: definition.label,
        badge: account?.badge ?? "Unavailable",
        value: current?.value ?? null,
        state: inactive ? "UNAVAILABLE" : current?.state ?? "ERROR",
        sampledAt: current?.sampledAt ?? null
      };
    });
    return streamingOverlaySnapshotSchema.parse({
      generatedAt: this.now().toISOString(),
      settingsVersion: settings.version,
      tiles,
      customTextEnabled: settings.customTextEnabled,
      customText: settings.customText,
      ...(this.options.botTickerProvider
        ? await this.options.botTickerProvider()
        : { botTickerEnabled: false, botTicker: [] })
    });
  }

  async dispose(): Promise<void> {
    await this.options.repository.dispose();
    if (this.options.cleanupCredentialRootOnDispose) {
      const allowedPrefix = `${tmpdir().replace(/\/$/, "")}/space-streaming-secrets-`;
      if (!this.options.credentialStore.root.startsWith(allowedPrefix)) {
        throw new Error("Refusing to clean a non-temporary streaming credential root.");
      }
      await rm(this.options.credentialStore.root, { recursive: true, force: true });
    }
  }

  private async collectSpaceMetrics(): Promise<Record<string, StreamingProviderMetricValue>> {
    const now = this.now().getTime();
    if (this.spaceCache && this.spaceCache.expiresAt > now) return this.spaceCache.values;
    const sampledAt = this.now().toISOString();
    const rooms = await this.options.store.listRooms();
    const [activity, activeAgentCount] = await Promise.all([
      this.options.store.listRunningCliSessionCountsByRoom(),
      this.options.activeAgentCountProvider
        ? this.options.activeAgentCountProvider()
        : this.options.store.countActiveSpaceAgentSessions()
    ]);
    const values = {
      "space.rooms": { value: rooms.length, state: "FRESH", sampledAt },
      "space.active_agents": { value: activeAgentCount, state: "FRESH", sampledAt },
      "space.active_cli_sessions": {
        value: activity.reduce((sum, room) => sum + room.runningCliCount, 0),
        state: "FRESH",
        sampledAt
      }
    } satisfies Record<string, StreamingProviderMetricValue>;
    this.spaceCache = { expiresAt: now + 10_000, values };
    return values;
  }

  private async collectProviderGroup(
    account: StreamingPlatformAccountRecord,
    authorization: StreamingAuthorizationRecord,
    group: ProviderMetricGroup,
    tiles: StreamingOverlayTile[]
  ): Promise<StreamingProviderMetricMap> {
    if (authorization.status !== "ACTIVE" || account.status === "DISCONNECTED") return {};
    const period = tiles[0]?.analyticsPeriod ?? account.analyticsPeriod;
    const cacheKey = `${account.id}\u0000${group}\u0000${period}`;
    const cached = this.metricCache.get(cacheKey);
    if (cached && cached.expiresAt > this.now().getTime()) return cached.values;
    const active = this.metricFlights.get(cacheKey);
    if (active) return active;
    const flight = (async () => {
      try {
        const client = await this.options.credentialStore.readClient(account.provider);
        const token = await this.activeToken(authorization, client);
        const adapterAccount: StreamingDiscoveredAccount = {
          externalAccountId: account.externalAccountId,
          displayName: account.displayName,
          badge: account.badge,
          grantSubject: authorization.externalGrantId
        };
        const values = await this.adapters[account.provider].collectMetrics({
          client,
          token,
          account: adapterAccount,
          metricKeys: tiles.map((tile) => tile.metricKey),
          analyticsPeriod: period,
          quota: account.provider === "YOUTUBE" ? this.quota : { consume: () => undefined }
        });
        this.metricCache.set(cacheKey, { expiresAt: this.now().getTime() + groupTtl(group), values });
        if (account.status === "ERROR" || account.safeErrorCode || account.safeErrorMessage) {
          await this.options.repository.updateAccount({ id: account.id, status: "ACTIVE", safeErrorCode: null, safeErrorMessage: null });
        }
        return values;
      } catch (error) {
        const safe = safeProviderFailure(error);
        await this.options.repository.updateAccount({
          id: account.id,
          status: "ERROR",
          safeErrorCode: safe.code,
          safeErrorMessage: safe.message
        }).catch(() => undefined);
        return cached ? staleValues(cached.values) : Object.fromEntries(
          tiles.map((tile) => [tile.metricKey, { value: null, state: "ERROR", sampledAt: this.now().toISOString() }])
        ) as StreamingProviderMetricMap;
      }
    })().finally(() => this.metricFlights.delete(cacheKey));
    this.metricFlights.set(cacheKey, flight);
    return flight;
  }

  private async activeToken(
    authorization: StreamingAuthorizationRecord,
    client: Awaited<ReturnType<StreamingCredentialStore["readClient"]>>
  ): Promise<StreamingTokenSet> {
    const current = this.tokenFlights.get(authorization.id);
    if (current) return current;
    const token = parseStreamingTokenSet(await this.options.credentialStore.readCredential(authorization.credentialRef));
    if (!tokenNeedsRefresh(token, this.now())) return token;
    const flight = (async () => {
      const refreshed = await this.adapters[authorization.provider].refreshToken({ client, token });
      await this.options.credentialStore.writeCredential(authorization.credentialRef, serializeStreamingTokenSet(refreshed));
      await this.options.repository.setAuthorizationStatus({
        id: authorization.id,
        status: "ACTIVE",
        safeErrorCode: null,
        safeErrorMessage: null,
        lastRefreshedAt: this.now().toISOString()
      });
      return refreshed;
    })().finally(() => this.tokenFlights.delete(authorization.id));
    this.tokenFlights.set(authorization.id, flight);
    return flight;
  }

  private async requiredAccount(id: string): Promise<StreamingPlatformAccountRecord> {
    const account = await this.options.repository.getAccount(id);
    if (!account) throw new StreamingServiceError("ACCOUNT_NOT_FOUND", "The streaming account was not found.", 404);
    return account;
  }

  private async requiredAuthorization(id: string): Promise<StreamingAuthorizationRecord> {
    const authorization = await this.options.repository.getAuthorization(id);
    if (!authorization) throw new StreamingServiceError("AUTHORIZATION_NOT_FOUND", "The streaming authorization was not found.", 404);
    return authorization;
  }

  private invalidateAccount(accountId: string): void {
    for (const key of this.metricCache.keys()) if (key.startsWith(`${accountId}\u0000`)) this.metricCache.delete(key);
  }
}
