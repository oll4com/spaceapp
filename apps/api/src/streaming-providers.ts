import type {
  StreamingAnalyticsPeriod,
  StreamingMetricKey,
  StreamingMetricState,
  StreamingOAuthProvider
} from "@space/contracts";
import {
  streamingProviderScopes,
  type StreamingProviderClient
} from "./streaming-credential-store.js";

export interface StreamingTokenSet {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: string | null;
  tokenType: string;
  scopes: string[];
  grantSubject: string | null;
}

export interface StreamingDiscoveredAccount {
  externalAccountId: string;
  displayName: string;
  badge: string;
  grantSubject: string;
}

export interface StreamingProviderMetricValue {
  value: number | string | null;
  state: StreamingMetricState;
  sampledAt: string;
}

export type StreamingProviderMetricMap = Partial<Record<StreamingMetricKey, StreamingProviderMetricValue>>;

export interface StreamingQuotaConsumer {
  consume(units: number): void;
}

export interface StreamingProviderAdapter {
  readonly provider: StreamingOAuthProvider;
  authorizationUrl(input: {
    client: StreamingProviderClient;
    state: string;
    codeChallenge: string;
  }): string;
  exchangeCode(input: {
    client: StreamingProviderClient;
    code: string;
    codeVerifier: string;
  }): Promise<StreamingTokenSet>;
  refreshToken(input: {
    client: StreamingProviderClient;
    token: StreamingTokenSet;
  }): Promise<StreamingTokenSet>;
  revoke(input: { client: StreamingProviderClient; token: StreamingTokenSet }): Promise<void>;
  discoverAccounts(input: {
    client: StreamingProviderClient;
    token: StreamingTokenSet;
  }): Promise<StreamingDiscoveredAccount[]>;
  collectMetrics(input: {
    client: StreamingProviderClient;
    token: StreamingTokenSet;
    account: StreamingDiscoveredAccount;
    metricKeys: StreamingMetricKey[];
    analyticsPeriod: StreamingAnalyticsPeriod;
    quota: StreamingQuotaConsumer;
  }): Promise<StreamingProviderMetricMap>;
}

export class StreamingProviderError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly transient: boolean,
    readonly status: number | null = null
  ) {
    super(message);
    this.name = "StreamingProviderError";
  }
}

type FetchLike = typeof fetch;

function nowIso(): string {
  return new Date().toISOString();
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new StreamingProviderError("PROVIDER_RESPONSE_INVALID", "The provider returned an invalid response.", false);
  }
  return value as Record<string, unknown>;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function numberValue(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function providerHttpError(provider: StreamingOAuthProvider, response: Response): StreamingProviderError {
  const transient = response.status === 408 || response.status === 429 || response.status >= 500;
  return new StreamingProviderError(
    `${provider}_HTTP_${response.status}`,
    `${provider} returned HTTP ${response.status}.`,
    transient,
    response.status
  );
}

async function requestJson(
  fetcher: FetchLike,
  provider: StreamingOAuthProvider,
  url: string,
  init: RequestInit
): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetcher(url, { ...init, signal: AbortSignal.timeout(15_000) });
  } catch {
    throw new StreamingProviderError(`${provider}_NETWORK`, `${provider} could not be reached.`, true);
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw providerHttpError(provider, response);
  }
  try {
    return asRecord(await response.json());
  } catch {
    throw new StreamingProviderError(`${provider}_RESPONSE_INVALID`, `${provider} returned invalid JSON.`, false, response.status);
  }
}

async function requestEmpty(
  fetcher: FetchLike,
  provider: StreamingOAuthProvider,
  url: string,
  init: RequestInit
): Promise<void> {
  let response: Response;
  try {
    response = await fetcher(url, { ...init, signal: AbortSignal.timeout(15_000) });
  } catch {
    throw new StreamingProviderError(`${provider}_NETWORK`, `${provider} could not be reached.`, true);
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw providerHttpError(provider, response);
  }
  await response.body?.cancel().catch(() => undefined);
}

function formBody(entries: Record<string, string | null | undefined>): URLSearchParams {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(entries)) if (value) body.set(key, value);
  return body;
}

function tokenSet(payload: Record<string, unknown>, previous?: StreamingTokenSet): StreamingTokenSet {
  const accessToken = stringValue(payload.access_token);
  if (!accessToken) throw new StreamingProviderError("TOKEN_RESPONSE_INVALID", "The provider token response was incomplete.", false);
  const expiresIn = numberValue(payload.expires_in);
  const scopeValue = payload.scope;
  const scopes = Array.isArray(scopeValue)
    ? scopeValue.filter((value): value is string => typeof value === "string")
    : typeof scopeValue === "string"
      ? scopeValue.split(/[ ,]+/).filter(Boolean)
      : previous?.scopes ?? [];
  return {
    accessToken,
    refreshToken: stringValue(payload.refresh_token) ?? previous?.refreshToken ?? null,
    expiresAt: expiresIn === null ? previous?.expiresAt ?? null : new Date(Date.now() + Math.max(0, expiresIn - 60) * 1000).toISOString(),
    tokenType: stringValue(payload.token_type) ?? previous?.tokenType ?? "Bearer",
    scopes,
    grantSubject: previous?.grantSubject ?? jwtSubject(stringValue(payload.id_token))
  };
}

function jwtSubject(token: string | null): string | null {
  if (!token) return null;
  const part = token.split(".")[1];
  if (!part) return null;
  try {
    const parsed = asRecord(JSON.parse(Buffer.from(part, "base64url").toString("utf8")));
    return stringValue(parsed.sub);
  } catch {
    return null;
  }
}

function bearerHeaders(token: StreamingTokenSet, extra: Record<string, string> = {}): Record<string, string> {
  return { Authorization: `Bearer ${token.accessToken}`, ...extra };
}

function metric(value: number | string | null, state: StreamingMetricState = "FRESH", sampledAt = nowIso()): StreamingProviderMetricValue {
  return { value, state, sampledAt };
}

function durationSeconds(startedAt: unknown): number | null {
  const value = stringValue(startedAt);
  if (!value) return null;
  const start = Date.parse(value);
  return Number.isFinite(start) ? Math.max(0, Math.floor((Date.now() - start) / 1000)) : null;
}

class YouTubeAdapter implements StreamingProviderAdapter {
  readonly provider = "YOUTUBE" as const;

  constructor(private readonly fetcher: FetchLike) {}

  authorizationUrl(input: { client: StreamingProviderClient; state: string; codeChallenge: string }): string {
    const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    url.search = formBody({
      client_id: input.client.clientId,
      redirect_uri: input.client.redirectUri,
      response_type: "code",
      scope: streamingProviderScopes.YOUTUBE.join(" "),
      access_type: "offline",
      prompt: "consent",
      include_granted_scopes: "true",
      state: input.state,
      code_challenge: input.codeChallenge,
      code_challenge_method: "S256"
    }).toString();
    return url.toString();
  }

  async exchangeCode(input: { client: StreamingProviderClient; code: string; codeVerifier: string }): Promise<StreamingTokenSet> {
    const payload = await requestJson(this.fetcher, this.provider, "https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: formBody({
        code: input.code,
        client_id: input.client.clientId,
        client_secret: input.client.clientSecret,
        redirect_uri: input.client.redirectUri,
        grant_type: "authorization_code",
        code_verifier: input.codeVerifier
      })
    });
    return tokenSet(payload);
  }

  async refreshToken(input: { client: StreamingProviderClient; token: StreamingTokenSet }): Promise<StreamingTokenSet> {
    if (!input.token.refreshToken) throw new StreamingProviderError("YOUTUBE_REFRESH_MISSING", "YouTube refresh access is unavailable.", false);
    const payload = await requestJson(this.fetcher, this.provider, "https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: formBody({
        refresh_token: input.token.refreshToken,
        client_id: input.client.clientId,
        client_secret: input.client.clientSecret,
        grant_type: "refresh_token"
      })
    });
    return tokenSet(payload, input.token);
  }

  async revoke(input: { client: StreamingProviderClient; token: StreamingTokenSet }): Promise<void> {
    void input.client;
    await requestEmpty(this.fetcher, this.provider, "https://oauth2.googleapis.com/revoke", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: formBody({ token: input.token.refreshToken ?? input.token.accessToken })
    });
  }

  async discoverAccounts(input: { client: StreamingProviderClient; token: StreamingTokenSet }): Promise<StreamingDiscoveredAccount[]> {
    void input.client;
    const url = new URL("https://www.googleapis.com/youtube/v3/channels");
    url.search = formBody({ part: "id,snippet", mine: "true", maxResults: "50" }).toString();
    const payload = await requestJson(this.fetcher, this.provider, url.toString(), { headers: bearerHeaders(input.token) });
    const accounts = asArray(payload.items).flatMap((value) => {
      const item = asRecord(value);
      const snippet = asRecord(item.snippet ?? {});
      const id = stringValue(item.id);
      const title = stringValue(snippet.title);
      if (!id || !title) return [];
      return [{ externalAccountId: id, displayName: title, badge: title, grantSubject: input.token.grantSubject ?? id }];
    });
    if (!accounts.length) throw new StreamingProviderError("YOUTUBE_CHANNELS_EMPTY", "No owned YouTube channels were found.", false);
    return accounts;
  }

  async collectMetrics(input: {
    client: StreamingProviderClient;
    token: StreamingTokenSet;
    account: StreamingDiscoveredAccount;
    metricKeys: StreamingMetricKey[];
    analyticsPeriod: StreamingAnalyticsPeriod;
    quota: StreamingQuotaConsumer;
  }): Promise<StreamingProviderMetricMap> {
    void input.client;
    const keys = new Set(input.metricKeys);
    const result: StreamingProviderMetricMap = {};
    const channelKeys = [...keys].some((key) => key.startsWith("youtube.channel."));
    const liveKeys = [...keys].some((key) => key.startsWith("youtube.live."));
    const analyticsKeys = [...keys].some((key) => key.startsWith("youtube.analytics."));

    if (channelKeys) {
      input.quota.consume(1);
      const url = new URL("https://www.googleapis.com/youtube/v3/channels");
      url.search = formBody({ part: "statistics", id: input.account.externalAccountId, maxResults: "1" }).toString();
      const payload = await requestJson(this.fetcher, this.provider, url.toString(), { headers: bearerHeaders(input.token) });
      const statistics = asRecord(asRecord(asArray(payload.items)[0] ?? {}).statistics ?? {});
      if (keys.has("youtube.channel.subscribers")) result["youtube.channel.subscribers"] = metric(numberValue(statistics.subscriberCount));
      if (keys.has("youtube.channel.total_views")) result["youtube.channel.total_views"] = metric(numberValue(statistics.viewCount));
      if (keys.has("youtube.channel.public_videos")) result["youtube.channel.public_videos"] = metric(numberValue(statistics.videoCount));
    }

    if (liveKeys) {
      input.quota.consume(1);
      const broadcastUrl = new URL("https://www.googleapis.com/youtube/v3/liveBroadcasts");
      broadcastUrl.search = formBody({ part: "id,snippet,status", mine: "true", broadcastStatus: "active", maxResults: "1" }).toString();
      const broadcastPayload = await requestJson(this.fetcher, this.provider, broadcastUrl.toString(), { headers: bearerHeaders(input.token) });
      const broadcastValue = asArray(broadcastPayload.items)[0];
      if (!broadcastValue) {
        for (const key of keys) if (key.startsWith("youtube.live.")) result[key] = metric(null, "OFFLINE");
      } else {
        const broadcast = asRecord(broadcastValue);
        const snippet = asRecord(broadcast.snippet ?? {});
        const videoId = stringValue(broadcast.id);
        const sampledAt = nowIso();
        let statistics: Record<string, unknown> = {};
        let liveDetails: Record<string, unknown> = {};
        if (videoId) {
          input.quota.consume(1);
          const videoUrl = new URL("https://www.googleapis.com/youtube/v3/videos");
          videoUrl.search = formBody({ part: "statistics,liveStreamingDetails", id: videoId, maxResults: "1" }).toString();
          const videoPayload = await requestJson(this.fetcher, this.provider, videoUrl.toString(), { headers: bearerHeaders(input.token) });
          const video = asRecord(asArray(videoPayload.items)[0] ?? {});
          statistics = asRecord(video.statistics ?? {});
          liveDetails = asRecord(video.liveStreamingDetails ?? {});
        }
        if (keys.has("youtube.live.concurrent_viewers")) result["youtube.live.concurrent_viewers"] = metric(numberValue(liveDetails.concurrentViewers), "FRESH", sampledAt);
        if (keys.has("youtube.live.likes")) result["youtube.live.likes"] = metric(numberValue(statistics.likeCount), "FRESH", sampledAt);
        if (keys.has("youtube.live.duration")) result["youtube.live.duration"] = metric(durationSeconds(liveDetails.actualStartTime ?? snippet.actualStartTime ?? snippet.scheduledStartTime), "FRESH", sampledAt);
        if (keys.has("youtube.live.total_chat_count")) {
          const liveChatId = stringValue(snippet.liveChatId);
          if (!liveChatId) {
            result["youtube.live.total_chat_count"] = metric(null, "UNAVAILABLE", sampledAt);
          } else {
            input.quota.consume(5);
            const chatUrl = new URL("https://www.googleapis.com/youtube/v3/liveChat/messages");
            chatUrl.search = formBody({ part: "id", liveChatId, maxResults: "2000" }).toString();
            const chatPayload = await requestJson(this.fetcher, this.provider, chatUrl.toString(), { headers: bearerHeaders(input.token) });
            result["youtube.live.total_chat_count"] = metric(
              numberValue(asRecord(chatPayload.pageInfo ?? {}).totalResults) ?? asArray(chatPayload.items).length,
              "FRESH",
              sampledAt
            );
          }
        }
      }
    }

    if (analyticsKeys) {
      const end = new Date();
      const start = new Date(end.getTime() - (input.analyticsPeriod - 1) * 24 * 60 * 60 * 1000);
      const date = (value: Date) => value.toISOString().slice(0, 10);
      const url = new URL("https://youtubeanalytics.googleapis.com/v2/reports");
      url.search = formBody({
        ids: `channel==${input.account.externalAccountId}`,
        startDate: date(start),
        endDate: date(end),
        metrics: "views,estimatedMinutesWatched,averageViewDuration,subscribersGained,subscribersLost"
      }).toString();
      const payload = await requestJson(this.fetcher, this.provider, url.toString(), { headers: bearerHeaders(input.token) });
      const row = asArray(asArray(payload.rows)[0]);
      const views = numberValue(row[0]);
      const minutes = numberValue(row[1]);
      const average = numberValue(row[2]);
      const gained = numberValue(row[3]);
      const lost = numberValue(row[4]);
      if (keys.has("youtube.analytics.views")) result["youtube.analytics.views"] = metric(views);
      if (keys.has("youtube.analytics.watch_hours")) result["youtube.analytics.watch_hours"] = metric(minutes === null ? null : Math.round((minutes / 60) * 10) / 10);
      if (keys.has("youtube.analytics.average_view_duration")) result["youtube.analytics.average_view_duration"] = metric(average);
      if (keys.has("youtube.analytics.subscribers_gained")) result["youtube.analytics.subscribers_gained"] = metric(gained);
      if (keys.has("youtube.analytics.subscribers_lost")) result["youtube.analytics.subscribers_lost"] = metric(lost);
      if (keys.has("youtube.analytics.net_subscribers")) result["youtube.analytics.net_subscribers"] = metric(gained === null || lost === null ? null : gained - lost);
    }

    return result;
  }
}

class TwitchAdapter implements StreamingProviderAdapter {
  readonly provider = "TWITCH" as const;

  constructor(private readonly fetcher: FetchLike) {}

  authorizationUrl(input: { client: StreamingProviderClient; state: string; codeChallenge: string }): string {
    const url = new URL("https://id.twitch.tv/oauth2/authorize");
    url.search = formBody({
      client_id: input.client.clientId,
      redirect_uri: input.client.redirectUri,
      response_type: "code",
      scope: streamingProviderScopes.TWITCH.join(" "),
      state: input.state,
      force_verify: "true",
      code_challenge: input.codeChallenge,
      code_challenge_method: "S256"
    }).toString();
    return url.toString();
  }

  async exchangeCode(input: { client: StreamingProviderClient; code: string; codeVerifier: string }): Promise<StreamingTokenSet> {
    return tokenSet(await requestJson(this.fetcher, this.provider, "https://id.twitch.tv/oauth2/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: formBody({
        client_id: input.client.clientId,
        client_secret: input.client.clientSecret,
        code: input.code,
        grant_type: "authorization_code",
        redirect_uri: input.client.redirectUri,
        code_verifier: input.codeVerifier
      })
    }));
  }

  async refreshToken(input: { client: StreamingProviderClient; token: StreamingTokenSet }): Promise<StreamingTokenSet> {
    if (!input.token.refreshToken) throw new StreamingProviderError("TWITCH_REFRESH_MISSING", "Twitch refresh access is unavailable.", false);
    return tokenSet(await requestJson(this.fetcher, this.provider, "https://id.twitch.tv/oauth2/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: formBody({
        client_id: input.client.clientId,
        client_secret: input.client.clientSecret,
        refresh_token: input.token.refreshToken,
        grant_type: "refresh_token"
      })
    }), input.token);
  }

  async revoke(input: { client: StreamingProviderClient; token: StreamingTokenSet }): Promise<void> {
    await requestEmpty(this.fetcher, this.provider, "https://id.twitch.tv/oauth2/revoke", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: formBody({ client_id: input.client.clientId, token: input.token.accessToken })
    });
  }

  private headers(client: StreamingProviderClient, token: StreamingTokenSet): Record<string, string> {
    return bearerHeaders(token, { "Client-Id": client.clientId });
  }

  async discoverAccounts(input: { client: StreamingProviderClient; token: StreamingTokenSet }): Promise<StreamingDiscoveredAccount[]> {
    const payload = await requestJson(this.fetcher, this.provider, "https://api.twitch.tv/helix/users", {
      headers: this.headers(input.client, input.token)
    });
    const user = asRecord(asArray(payload.data)[0] ?? {});
    const id = stringValue(user.id);
    const displayName = stringValue(user.display_name);
    const login = stringValue(user.login);
    if (!id || !displayName) throw new StreamingProviderError("TWITCH_ACCOUNT_MISSING", "Twitch did not return the connected broadcaster.", false);
    return [{ externalAccountId: id, displayName, badge: login ? `@${login}` : displayName, grantSubject: id }];
  }

  async collectMetrics(input: {
    client: StreamingProviderClient;
    token: StreamingTokenSet;
    account: StreamingDiscoveredAccount;
    metricKeys: StreamingMetricKey[];
    analyticsPeriod: StreamingAnalyticsPeriod;
    quota: StreamingQuotaConsumer;
  }): Promise<StreamingProviderMetricMap> {
    void input.analyticsPeriod;
    void input.quota;
    const keys = new Set(input.metricKeys);
    const result: StreamingProviderMetricMap = {};
    const headers = this.headers(input.client, input.token);
    if (keys.has("twitch.followers")) {
      const url = new URL("https://api.twitch.tv/helix/channels/followers");
      url.search = formBody({ broadcaster_id: input.account.externalAccountId, first: "1" }).toString();
      const payload = await requestJson(this.fetcher, this.provider, url.toString(), { headers });
      result["twitch.followers"] = metric(numberValue(payload.total));
    }
    if (keys.has("twitch.subscribers") || keys.has("twitch.subscriber_points")) {
      const url = new URL("https://api.twitch.tv/helix/subscriptions");
      url.search = formBody({ broadcaster_id: input.account.externalAccountId, first: "1" }).toString();
      const payload = await requestJson(this.fetcher, this.provider, url.toString(), { headers });
      if (keys.has("twitch.subscribers")) result["twitch.subscribers"] = metric(numberValue(payload.total));
      if (keys.has("twitch.subscriber_points")) result["twitch.subscriber_points"] = metric(numberValue(payload.points));
    }
    if (keys.has("twitch.concurrent_viewers") || keys.has("twitch.live_duration")) {
      const url = new URL("https://api.twitch.tv/helix/streams");
      url.search = formBody({ user_id: input.account.externalAccountId, first: "1" }).toString();
      const payload = await requestJson(this.fetcher, this.provider, url.toString(), { headers });
      const streamValue = asArray(payload.data)[0];
      if (!streamValue) {
        if (keys.has("twitch.concurrent_viewers")) result["twitch.concurrent_viewers"] = metric(null, "OFFLINE");
        if (keys.has("twitch.live_duration")) result["twitch.live_duration"] = metric(null, "OFFLINE");
      } else {
        const stream = asRecord(streamValue);
        if (keys.has("twitch.concurrent_viewers")) result["twitch.concurrent_viewers"] = metric(numberValue(stream.viewer_count));
        if (keys.has("twitch.live_duration")) result["twitch.live_duration"] = metric(durationSeconds(stream.started_at));
      }
    }
    return result;
  }
}

class TikTokAdapter implements StreamingProviderAdapter {
  readonly provider = "TIKTOK" as const;

  constructor(private readonly fetcher: FetchLike) {}

  authorizationUrl(input: { client: StreamingProviderClient; state: string; codeChallenge: string }): string {
    const url = new URL("https://www.tiktok.com/v2/auth/authorize/");
    url.search = formBody({
      client_key: input.client.clientId,
      redirect_uri: input.client.redirectUri,
      response_type: "code",
      scope: streamingProviderScopes.TIKTOK.join(","),
      state: input.state,
      code_challenge: input.codeChallenge,
      code_challenge_method: "S256"
    }).toString();
    return url.toString();
  }

  async exchangeCode(input: { client: StreamingProviderClient; code: string; codeVerifier: string }): Promise<StreamingTokenSet> {
    return tokenSet(await requestJson(this.fetcher, this.provider, "https://open.tiktokapis.com/v2/oauth/token/", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: formBody({
        client_key: input.client.clientId,
        client_secret: input.client.clientSecret,
        code: input.code,
        grant_type: "authorization_code",
        redirect_uri: input.client.redirectUri,
        code_verifier: input.codeVerifier
      })
    }));
  }

  async refreshToken(input: { client: StreamingProviderClient; token: StreamingTokenSet }): Promise<StreamingTokenSet> {
    if (!input.token.refreshToken) throw new StreamingProviderError("TIKTOK_REFRESH_MISSING", "TikTok refresh access is unavailable.", false);
    return tokenSet(await requestJson(this.fetcher, this.provider, "https://open.tiktokapis.com/v2/oauth/token/", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: formBody({
        client_key: input.client.clientId,
        client_secret: input.client.clientSecret,
        refresh_token: input.token.refreshToken,
        grant_type: "refresh_token"
      })
    }), input.token);
  }

  async revoke(input: { client: StreamingProviderClient; token: StreamingTokenSet }): Promise<void> {
    await requestEmpty(this.fetcher, this.provider, "https://open.tiktokapis.com/v2/oauth/revoke/", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: formBody({
        client_key: input.client.clientId,
        client_secret: input.client.clientSecret,
        token: input.token.accessToken
      })
    });
  }

  private async profile(input: {
    token: StreamingTokenSet;
    fields: string;
  }): Promise<Record<string, unknown>> {
    const url = new URL("https://open.tiktokapis.com/v2/user/info/");
    url.search = formBody({ fields: input.fields }).toString();
    const payload = await requestJson(this.fetcher, this.provider, url.toString(), { headers: bearerHeaders(input.token) });
    return asRecord(asRecord(payload.data ?? {}).user ?? {});
  }

  async discoverAccounts(input: { client: StreamingProviderClient; token: StreamingTokenSet }): Promise<StreamingDiscoveredAccount[]> {
    void input.client;
    const user = await this.profile({ token: input.token, fields: "open_id,display_name" });
    const id = stringValue(user.open_id);
    const displayName = stringValue(user.display_name);
    if (!id || !displayName) throw new StreamingProviderError("TIKTOK_ACCOUNT_MISSING", "TikTok did not return the connected profile.", false);
    return [{ externalAccountId: id, displayName, badge: displayName, grantSubject: id }];
  }

  async collectMetrics(input: {
    client: StreamingProviderClient;
    token: StreamingTokenSet;
    account: StreamingDiscoveredAccount;
    metricKeys: StreamingMetricKey[];
    analyticsPeriod: StreamingAnalyticsPeriod;
    quota: StreamingQuotaConsumer;
  }): Promise<StreamingProviderMetricMap> {
    void input.client;
    void input.account;
    void input.analyticsPeriod;
    void input.quota;
    const keys = new Set(input.metricKeys);
    const user = await this.profile({ token: input.token, fields: "open_id,follower_count,likes_count,video_count" });
    const result: StreamingProviderMetricMap = {};
    if (keys.has("tiktok.followers")) result["tiktok.followers"] = metric(numberValue(user.follower_count));
    if (keys.has("tiktok.total_likes")) result["tiktok.total_likes"] = metric(numberValue(user.likes_count));
    if (keys.has("tiktok.public_videos")) result["tiktok.public_videos"] = metric(numberValue(user.video_count));
    return result;
  }
}

export function createStreamingProviderAdapters(fetcher: FetchLike = fetch): Record<StreamingOAuthProvider, StreamingProviderAdapter> {
  return {
    YOUTUBE: new YouTubeAdapter(fetcher),
    TWITCH: new TwitchAdapter(fetcher),
    TIKTOK: new TikTokAdapter(fetcher)
  };
}

export function parseStreamingTokenSet(value: Record<string, unknown>): StreamingTokenSet {
  const accessToken = stringValue(value.accessToken);
  if (!accessToken) throw new Error("Streaming credential token is invalid.");
  return {
    accessToken,
    refreshToken: stringValue(value.refreshToken),
    expiresAt: stringValue(value.expiresAt),
    tokenType: stringValue(value.tokenType) ?? "Bearer",
    scopes: asArray(value.scopes).filter((scope): scope is string => typeof scope === "string"),
    grantSubject: stringValue(value.grantSubject)
  };
}

export function serializeStreamingTokenSet(token: StreamingTokenSet): Record<string, unknown> {
  return {
    accessToken: token.accessToken,
    refreshToken: token.refreshToken,
    expiresAt: token.expiresAt,
    tokenType: token.tokenType,
    scopes: token.scopes,
    grantSubject: token.grantSubject
  };
}
