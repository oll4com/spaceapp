import { describe, expect, it, vi } from "vitest";
import { createStreamingProviderAdapters, type StreamingTokenSet } from "../streaming-providers.js";

const client = {
  clientId: "client-id",
  clientSecret: "client-secret",
  redirectUri: "https://space.example/api/admin/streaming/providers/YOUTUBE/oauth/callback"
};

const token: StreamingTokenSet = {
  accessToken: "access-token",
  refreshToken: "refresh-token",
  expiresAt: "2099-01-01T00:00:00.000Z",
  tokenType: "Bearer",
  scopes: [],
  grantSubject: "grant-one"
};

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
}

describe("streaming provider adapters", () => {
  it("uses read-only YouTube and Analytics scopes without broadcast creation scopes", () => {
    const adapters = createStreamingProviderAdapters(vi.fn() as unknown as typeof fetch);
    const url = new URL(adapters.YOUTUBE.authorizationUrl({ client, state: "state", codeChallenge: "challenge" }));
    const scopes = url.searchParams.get("scope")?.split(" ") ?? [];
    expect(scopes).toContain("https://www.googleapis.com/auth/youtube.readonly");
    expect(scopes).toContain("https://www.googleapis.com/auth/yt-analytics.readonly");
    expect(scopes.join(" ")).not.toMatch(/youtube\.force-ssl|youtube\.upload|broadcast/i);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  });

  it("collects Twitch followers/subscriptions and returns OFFLINE live metrics without deprecated view_count", async () => {
    const urls: string[] = [];
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      urls.push(url);
      if (url.includes("channels/followers")) return json({ total: 123, data: [] });
      if (url.includes("subscriptions")) return json({ total: 45, points: 52, data: [] });
      return json({ data: [] });
    }) as unknown as typeof fetch;
    const result = await createStreamingProviderAdapters(fetcher).TWITCH.collectMetrics({
      client,
      token,
      account: { externalAccountId: "broadcaster", displayName: "Broadcaster", badge: "@broadcaster", grantSubject: "broadcaster" },
      metricKeys: ["twitch.followers", "twitch.subscribers", "twitch.subscriber_points", "twitch.concurrent_viewers", "twitch.live_duration"],
      analyticsPeriod: 28,
      quota: { consume: () => undefined }
    });
    expect(result["twitch.followers"]?.value).toBe(123);
    expect(result["twitch.subscribers"]?.value).toBe(45);
    expect(result["twitch.subscriber_points"]?.value).toBe(52);
    expect(result["twitch.concurrent_viewers"]?.state).toBe("OFFLINE");
    expect(urls.join(" ")).not.toContain("view_count");
  });

  it("uses only official TikTok user.info.stats profile fields", async () => {
    const urls: string[] = [];
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      urls.push(String(input));
      return json({ data: { user: { open_id: "profile", follower_count: 10, likes_count: 20, video_count: 3 } } });
    }) as unknown as typeof fetch;
    const adapters = createStreamingProviderAdapters(fetcher);
    const auth = new URL(adapters.TIKTOK.authorizationUrl({ client, state: "state", codeChallenge: "challenge" }));
    expect(auth.searchParams.get("scope")?.split(",")).toEqual(["user.info.basic", "user.info.stats"]);
    const result = await adapters.TIKTOK.collectMetrics({
      client,
      token,
      account: { externalAccountId: "profile", displayName: "Profile", badge: "Profile", grantSubject: "profile" },
      metricKeys: ["tiktok.followers", "tiktok.total_likes", "tiktok.public_videos"],
      analyticsPeriod: 28,
      quota: { consume: () => undefined }
    });
    expect(result["tiktok.followers"]?.value).toBe(10);
    expect(result["tiktok.total_likes"]?.value).toBe(20);
    expect(result["tiktok.public_videos"]?.value).toBe(3);
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain("open.tiktokapis.com/v2/user/info/");
    expect(urls[0]).not.toMatch(/live|stream/i);
  });
});
