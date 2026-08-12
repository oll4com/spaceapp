import type { StreamingOAuthProvider } from "@space/contracts";
import { StreamingCredentialStore, type StreamingProviderClient } from "./credential-store.js";

export interface StreamingTokenSet {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: string | null;
  tokenType: string;
  scopes: string[];
  grantSubject: string | null;
}

export function parseStreamingTokenSet(payload: Record<string, unknown>): StreamingTokenSet {
  const accessToken = typeof payload.accessToken === "string" ? payload.accessToken : "";
  const refreshToken = typeof payload.refreshToken === "string" ? payload.refreshToken : null;
  const expiresAt = typeof payload.expiresAt === "string" ? payload.expiresAt : null;
  const tokenType = typeof payload.tokenType === "string" ? payload.tokenType : "Bearer";
  const scopes = Array.isArray(payload.scopes)
    ? payload.scopes.filter((value): value is string => typeof value === "string")
    : [];
  const grantSubject = typeof payload.grantSubject === "string" ? payload.grantSubject : null;
  if (!accessToken) throw new Error("Streaming token set is missing the access token.");
  return { accessToken, refreshToken, expiresAt, tokenType, scopes, grantSubject };
}

export function serializeStreamingTokenSet(token: StreamingTokenSet): Record<string, unknown> {
  return { ...token };
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Provider token response was invalid.");
  }
  return value as Record<string, unknown>;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function numberValue(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function formBody(entries: Record<string, string | null | undefined>): URLSearchParams {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(entries)) if (value) body.set(key, value);
  return body;
}

function tokenSet(payload: Record<string, unknown>, previous?: StreamingTokenSet): StreamingTokenSet {
  const accessToken = stringValue(payload.access_token);
  if (!accessToken) throw new Error("Provider token response was incomplete.");
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
    grantSubject: previous?.grantSubject ?? null
  };
}

export interface StreamingTokenManagerOptions {
  credentialStore: StreamingCredentialStore;
  fetchImpl?: typeof fetch;
  refreshThresholdSeconds?: number;
}

export class StreamingTokenManager {
  private readonly cache = new Map<string, StreamingTokenSet>();
  private readonly flights = new Map<string, Promise<StreamingTokenSet>>();
  private readonly fetchImpl: typeof fetch;
  private readonly refreshThresholdSeconds: number;

  constructor(private readonly options: StreamingTokenManagerOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.refreshThresholdSeconds = options.refreshThresholdSeconds ?? 300;
  }

  async getToken(provider: StreamingOAuthProvider, credentialRef: string): Promise<StreamingTokenSet> {
    const cached = this.cache.get(credentialRef);
    if (cached && !this.needsRefresh(cached)) return cached;
    const flight = this.flights.get(credentialRef);
    if (flight) return flight;
    const promise = this.loadToken(provider, credentialRef);
    this.flights.set(credentialRef, promise);
    try {
      return await promise;
    } finally {
      this.flights.delete(credentialRef);
    }
  }

  invalidate(credentialRef: string): void {
    this.cache.delete(credentialRef);
  }

  private needsRefresh(token: StreamingTokenSet): boolean {
    if (!token.expiresAt) return false;
    const expiresAt = Date.parse(token.expiresAt);
    if (!Number.isFinite(expiresAt)) return false;
    return expiresAt - Date.now() < this.refreshThresholdSeconds * 1000;
  }

  private async loadToken(provider: StreamingOAuthProvider, credentialRef: string): Promise<StreamingTokenSet> {
    const payload = await this.options.credentialStore.readCredential(credentialRef);
    const token = parseStreamingTokenSet(payload);
    if (!this.needsRefresh(token)) {
      this.cache.set(credentialRef, token);
      return token;
    }
    if (!token.refreshToken) {
      this.cache.set(credentialRef, token);
      return token;
    }
    const client = await this.options.credentialStore.readClient(provider);
    const refreshed = await this.refresh(provider, client, token);
    const refreshedWithSubject = { ...refreshed, grantSubject: refreshed.grantSubject ?? token.grantSubject };
    await this.options.credentialStore.writeCredential(credentialRef, serializeStreamingTokenSet(refreshedWithSubject));
    this.cache.set(credentialRef, refreshedWithSubject);
    return refreshedWithSubject;
  }

  private async refresh(provider: StreamingOAuthProvider, client: StreamingProviderClient, token: StreamingTokenSet): Promise<StreamingTokenSet> {
    if (provider === "YOUTUBE") {
      const payload = await this.requestJson("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: formBody({
          refresh_token: token.refreshToken,
          client_id: client.clientId,
          client_secret: client.clientSecret,
          grant_type: "refresh_token"
        })
      });
      return tokenSet(payload, token);
    }
    if (provider === "TWITCH") {
      const payload = await this.requestJson("https://id.twitch.tv/oauth2/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: formBody({
          refresh_token: token.refreshToken,
          client_id: client.clientId,
          client_secret: client.clientSecret,
          grant_type: "refresh_token"
        })
      });
      return tokenSet(payload, token);
    }
    throw new Error(`${provider} token refresh is not supported by the streaming bot.`);
  }

  private async requestJson(url: string, init: RequestInit): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await this.fetchImpl(url, { ...init, signal: AbortSignal.timeout(15_000) });
    } catch {
      throw new Error("Provider token endpoint could not be reached.");
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`Provider token endpoint returned HTTP ${response.status}.`);
    }
    try {
      return asRecord(await response.json());
    } catch {
      throw new Error("Provider token endpoint returned invalid JSON.");
    }
  }
}