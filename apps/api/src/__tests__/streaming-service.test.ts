import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryStreamingRepository } from "@space/db";
import { InMemorySpaceStore } from "@space/runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StreamingCredentialStore } from "../streaming-credential-store.js";
import type {
  StreamingDiscoveredAccount,
  StreamingProviderAdapter,
  StreamingProviderMetricMap,
  StreamingTokenSet
} from "../streaming-providers.js";
import { StreamingProviderError } from "../streaming-providers.js";
import { StreamingService, StreamingServiceError } from "../streaming-service.js";

const roots: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function secretRoot(): Promise<StreamingCredentialStore> {
  const root = join(tmpdir(), `space-streaming-secrets-test-${crypto.randomUUID()}`);
  roots.push(root);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const store = new StreamingCredentialStore(root);
  await store.initialize();
  for (const provider of ["YOUTUBE", "TWITCH", "TIKTOK"] as const) {
    await writeFile(store.clientPath(provider), JSON.stringify({
      clientId: `${provider.toLowerCase()}-client`,
      clientSecret: `${provider.toLowerCase()}-secret`,
      redirectUri: `https://space.example/api/admin/streaming/providers/${provider}/oauth/callback`
    }), { mode: 0o600 });
  }
  return store;
}

function token(): StreamingTokenSet {
  return {
    accessToken: "access-token",
    refreshToken: "refresh-token",
    expiresAt: "2099-01-01T00:00:00.000Z",
    tokenType: "Bearer",
    scopes: ["scope"],
    grantSubject: "grant-one"
  };
}

function adapter(input: {
  provider?: "YOUTUBE" | "TWITCH" | "TIKTOK";
  accounts?: StreamingDiscoveredAccount[];
  collect?: StreamingProviderAdapter["collectMetrics"];
} = {}): StreamingProviderAdapter {
  const provider = input.provider ?? "YOUTUBE";
  return {
    provider,
    authorizationUrl: ({ state }) => `https://provider.example/authorize?state=${encodeURIComponent(state)}`,
    exchangeCode: vi.fn(async () => token()),
    refreshToken: vi.fn(async ({ token: current }) => current),
    revoke: vi.fn(async () => undefined),
    discoverAccounts: vi.fn(async () => input.accounts ?? [{
      externalAccountId: "channel-one",
      displayName: "Channel One",
      badge: "Channel One",
      grantSubject: "grant-one"
    }]),
    collectMetrics: input.collect ?? vi.fn(async () => ({}))
  };
}

function adapters(youtube: StreamingProviderAdapter) {
  return {
    YOUTUBE: youtube,
    TWITCH: adapter({ provider: "TWITCH" }),
    TIKTOK: adapter({ provider: "TIKTOK" })
  };
}

describe("StreamingService", () => {
  it("binds one-time OAuth state to the browser session and discovers multiple owned channels", async () => {
    const repository = new InMemoryStreamingRepository();
    const credentials = await secretRoot();
    const youtube = adapter({ accounts: [
      { externalAccountId: "channel-one", displayName: "One", badge: "One", grantSubject: "grant-one" },
      { externalAccountId: "channel-two", displayName: "Two", badge: "Two", grantSubject: "grant-one" }
    ] });
    const service = new StreamingService({ repository, credentialStore: credentials, store: new InMemorySpaceStore(), adapters: adapters(youtube) });
    const start = await service.startOAuth("YOUTUBE", "session-one");
    const state = new URL(start.authorizationUrl).searchParams.get("state")!;
    await expect(service.completeOAuth({ provider: "YOUTUBE", code: "code", state, sessionToken: "other-session" }))
      .rejects.toMatchObject({ code: "OAUTH_STATE_INVALID" });
    const result = await service.completeOAuth({ provider: "YOUTUBE", code: "code", state, sessionToken: "session-one" });
    expect(result.accounts).toHaveLength(2);
    expect((await service.catalog()).settings.tiles).toHaveLength(3);
    expect((await service.catalog()).accounts).toHaveLength(2);
    await expect(service.completeOAuth({ provider: "YOUTUBE", code: "replay", state, sessionToken: "session-one" }))
      .rejects.toBeInstanceOf(StreamingServiceError);
    expect(JSON.stringify(await repository.listAuthorizations())).not.toContain("access-token");
  });

  it("singleflights cached collection and returns last successful data as STALE", async () => {
    let now = new Date("2026-08-11T10:00:00.000Z");
    let fail = false;
    const collect = vi.fn(async (): Promise<StreamingProviderMetricMap> => {
      if (fail) throw new StreamingProviderError("YOUTUBE_NETWORK", "YouTube could not be reached.", true);
      await Promise.resolve();
      return { "youtube.channel.subscribers": { value: 42, state: "FRESH", sampledAt: now.toISOString() } };
    });
    const repository = new InMemoryStreamingRepository();
    const credentials = await secretRoot();
    await credentials.writeCredential("streaming-credential:one", {
      accessToken: "access-token", refreshToken: "refresh-token", expiresAt: "2099-01-01T00:00:00.000Z",
      tokenType: "Bearer", scopes: [], grantSubject: "grant-one"
    });
    const authorization = await repository.upsertAuthorization({
      id: "streaming-auth:one", provider: "YOUTUBE", externalGrantId: "grant-one",
      credentialRef: "streaming-credential:one", status: "ACTIVE", scopes: []
    });
    const account = await repository.upsertAccount({
      id: "streaming-account:one", authorizationId: authorization.id, provider: "YOUTUBE",
      externalAccountId: "channel-one", displayName: "Channel", badge: "Channel"
    });
    await repository.updateOverlaySettings({
      expectedVersion: 1,
      tiles: [{ metricKey: "youtube.channel.subscribers", accountId: account.id }],
      customTextEnabled: false,
      customText: "",
      updatedBy: "user:admin",
      updatedAt: now.toISOString()
    });
    const service = new StreamingService({
      repository,
      credentialStore: credentials,
      store: new InMemorySpaceStore(),
      adapters: adapters(adapter({ collect })),
      now: () => now
    });
    const [first, concurrent] = await Promise.all([service.overlaySnapshot(), service.overlaySnapshot()]);
    expect(first.tiles[0]).toMatchObject({ value: 42, state: "FRESH" });
    expect(concurrent.tiles[0]).toMatchObject({ value: 42, state: "FRESH" });
    expect(collect).toHaveBeenCalledTimes(1);
    now = new Date("2026-08-11T10:06:00.000Z");
    fail = true;
    expect((await service.overlaySnapshot()).tiles[0]).toMatchObject({ value: 42, state: "STALE" });
    expect(collect).toHaveBeenCalledTimes(2);
  });

  it("fails closed when the YouTube daily quota budget is exceeded", async () => {
    const repository = new InMemoryStreamingRepository();
    const credentials = await secretRoot();
    await credentials.writeCredential("streaming-credential:quota", {
      accessToken: "access-token", refreshToken: "refresh-token", expiresAt: "2099-01-01T00:00:00.000Z",
      tokenType: "Bearer", scopes: [], grantSubject: "grant-quota"
    });
    const authorization = await repository.upsertAuthorization({
      id: "streaming-auth:quota", provider: "YOUTUBE", externalGrantId: "grant-quota",
      credentialRef: "streaming-credential:quota", status: "ACTIVE", scopes: []
    });
    const account = await repository.upsertAccount({
      id: "streaming-account:quota", authorizationId: authorization.id, provider: "YOUTUBE",
      externalAccountId: "channel-quota", displayName: "Quota", badge: "Quota"
    });
    await repository.updateOverlaySettings({
      expectedVersion: 1,
      tiles: [{ metricKey: "youtube.channel.subscribers", accountId: account.id }],
      customTextEnabled: false, customText: "", updatedBy: "user:admin", updatedAt: "2026-08-11T10:00:00.000Z"
    });
    const youtube = adapter({ collect: vi.fn(async ({ quota }) => {
      quota.consume(8_001);
      return {};
    }) });
    const service = new StreamingService({ repository, credentialStore: credentials, store: new InMemorySpaceStore(), adapters: adapters(youtube) });
    expect((await service.overlaySnapshot()).tiles[0]?.state).toBe("ERROR");
    expect((await service.catalog()).accounts[0]?.safeErrorCode).toBe("YOUTUBE_QUOTA_BUDGET");
  });
});
