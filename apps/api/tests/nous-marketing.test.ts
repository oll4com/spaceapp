import { describe, expect, it } from "vitest";
import type { MarketingMetric, MarketingPost } from "@space/contracts";
import { buildMarketingReport, GA4_NEEDS, marketingNumbers, marketingPostScore, marketingSnapshot, marketingToolText } from "../src/nous/marketing.js";
import { createMarketingStatsCollector, ga4ConfigFromEnv, parseGa4Report, parsePostStats, postStatsUrl } from "../src/marketing-copilot/stats.js";

// Nous › Marketing (operator 5/11 10:42 BKK, plan clipboard:netzt-nNvtBL): every post numbered, per platform, a score per post, platform and overall.
const NOW = Date.parse("2026-11-05T12:00:00.000Z");
let n = 0;
const post = (channel: MarketingPost["channel"], status: MarketingPost["status"], at: string, metrics: Record<string, number> = {}, extra: Partial<MarketingPost> = {}): MarketingPost => ({
  id: `mktpost:p${String((n += 1)).padStart(9, "0")}`, ownerUserId: "user:operator", paneId: null, campaignId: null, channel, kind: "POST", target: null, title: `Post ${n}`,
  body: "text", assets: [], status, scheduledAt: null, reviewNote: null, ruleId: null, publishedUrl: status === "PUBLISHED" ? `https://example.com/${n}` : null,
  publishedAt: status === "PUBLISHED" ? at : null, evidence: Object.keys(metrics).length ? { metricsAt: at } : {}, metrics, createdAt: at, updatedAt: at, ...extra });
const metric = (day: string, source: string, key: string, value: number): MarketingMetric => ({ day, source, key, value });

describe("marketing scoring", () => {
  it("reads the copilot's own words as one set of numbers", () => {
    // Real readouts of 3-4/11: X counts comments and replies alike, Reddit's score and upvotes are one count, its own comments do not count.
    expect(marketingNumbers({ likes: 0, views: 13, comments: 1 })).toEqual({ views: 13, replies: 1, messages: 0, likes: 0, clicks: 0, followers: 0 });
    expect(marketingNumbers({ score: 1, replies: 1, upvotes: 0, comments_own: 2, comments_from_others: 2 })).toMatchObject({ views: null, replies: 2, likes: 1 });
    expect(marketingNumbers({ likes: 2, reposts: 1, quotes: 1, bookmarks: 3 }).likes).toBe(2 + 1 + 3);
  });
  it("scores a post 0-100 from reach and interactions, interactions alone when views are unknown", () => {
    const zero = marketingNumbers({});
    expect(marketingPostScore(zero)).toBe(0);
    expect(marketingPostScore({ ...zero, views: 1000, replies: 50 })).toBe(100);
    expect(marketingPostScore({ ...zero, replies: 50 })).toBe(100);
    expect(marketingPostScore({ ...zero, views: 1000 })).toBe(50);
    const small = marketingPostScore({ ...zero, views: 13, replies: 1 });
    expect(small).toBeGreaterThan(0);
    expect(small).toBeLessThan(marketingPostScore({ ...zero, views: 13, replies: 1, messages: 1 }));
  });
  it("numbers every post that went out (oldest #1, newest first), scores failed as 0, platforms, overall and trends", () => {
    n = 0;
    const posts = [
      post("X", "PUBLISHED", "2026-10-20T10:00:00.000Z", { views: 100, likes: 4 }),
      post("REDDIT", "PUBLISHED", "2026-11-04T10:00:00.000Z", { score: 3, comments: 2 }),
      post("REDDIT", "PUBLISHED", "2026-11-04T11:00:00.000Z", { score: 0 }),
      post("X", "FAILED", "2026-11-03T10:00:00.000Z", {}, { evidence: { failure: "Browser Host unavailable" } }),
      post("HACKER_NEWS", "PUBLISHED", "2026-11-05T09:00:00.000Z"),
      post("X", "DRAFT", "2026-11-05T09:30:00.000Z"),
      post("LINKEDIN", "APPROVED", "2026-11-05T10:00:00.000Z")
    ];
    const metrics = [metric("2026-10-01", "GITHUB", "stars", 10), metric("2026-11-05", "GITHUB", "stars", 60), metric("2026-11-05", "NPM", "downloads_week", 200),
      metric("2026-10-29", "MARKETING_SCORE", "overall", 20), metric("2026-11-04", "GITHUB_REFERRERS", "reddit.com", 7), metric("2026-11-04", "GITHUB_REFERRERS", "news.ycombinator.com", 2)];
    const report = buildMarketingReport({ posts, metrics, mail: [{ name: "Launch", status: "DONE", sent: 40, replied: 3, bounced: 1, unsubscribed: 0 }], ga4Configured: false, trafficConfigured: false, now: NOW });
    expect(report.posts.map((row) => row.number)).toEqual([6, 5, 4, 3, 2, 1]);
    expect(report.posts.find((row) => row.status === "FAILED")).toMatchObject({ score: 0, failure: "Browser Host unavailable" });
    expect(report.posts.find((row) => row.channel === "HACKER_NEWS")?.score).toBeNull();
    expect(report.posts.find((row) => row.channel === "LINKEDIN")).toMatchObject({ status: "APPROVED", score: null });
    expect(report.totals).toMatchObject({ posts: 6, published: 4, failed: 1, measured: 3, zeroReach: 1 });
    const reddit = report.platforms.find((platform) => platform.channel === "REDDIT")!;
    expect(reddit).toMatchObject({ posts: 2, replies: 2, likes: 3, visits: 7 });
    expect(reddit.score).toBe(Math.round((marketingPostScore(marketingNumbers({ score: 3, comments: 2 })) + 0) / 2));
    // Posts (X 100 views + 4 likes, the two Reddit ones, the failed X) and outcomes (50 stars of 50 gained, 200 of 200 downloads) weigh 0.6/0.4.
    expect(report.outcomesScore).toBe(100);
    expect(report.score).toBe(Math.round(0.6 * report.postsScore! + 0.4 * 100));
    expect(report.trend7).toBe(report.score! - 20);
    expect(report.daysWithoutResult).toBe(6);
    expect(report).toMatchObject({ target: 50, daysBelowTarget: report.score! < 50 ? expect.any(Number) : 0 });
    expect(report.sources.find((source) => source.id === "GA4")).toMatchObject({ connected: false, detail: `Not connected: needs ${GA4_NEEDS}.` });
    expect(report.sources.find((source) => source.id === "MAIL")?.values).toMatchObject({ campaigns: 1, sent: 40, replied: 3 });
    expect(marketingSnapshot(report, "2026-11-05")).toContainEqual({ day: "2026-11-05", source: "MARKETING_SCORE", key: "overall", value: report.score });
    const page = marketingToolText(report, { view: "posts", channel: "reddit" });
    expect(page).toMatch(/^2 posts on REDDIT/);
    expect(page).toContain("#4 2026-11-04T11:00 REDDIT PUBLISHED score 0");
    expect(marketingToolText(report, {})).toContain("Sources not connected: Google Analytics 4, GitHub traffic");
  });
});

describe("marketing stats collector", () => {
  it("parses Hacker News, dev.to and GA4 answers", () => {
    expect(postStatsUrl({ channel: "HACKER_NEWS", publishedUrl: "https://news.ycombinator.com/item?id=50365885" })).toBe("https://hacker-news.firebaseio.com/v0/item/50365885.json");
    expect(postStatsUrl({ channel: "DEVTO", publishedUrl: "https://dev.to/space_app_fc7f/nous-one-mind-1cm2" })).toBe("https://dev.to/api/articles/space_app_fc7f/nous-one-mind-1cm2");
    expect(postStatsUrl({ channel: "REDDIT", publishedUrl: "https://www.reddit.com/r/selfhosted/comments/1xmwbwz/" })).toBeNull();
    expect(parsePostStats("HACKER_NEWS", { by: "ntheogr", descendants: 0, id: 50365885, kids: [50365891], score: 2, type: "story" })).toEqual({ score: 2, comments: 0 });
    expect(parsePostStats("HACKER_NEWS", { id: 1, dead: true, score: 1 })).toBeNull();
    expect(parsePostStats("DEVTO", { type_of: "article", public_reactions_count: 4, comments_count: 1, page_views_count: null })).toEqual({ reactions: 4, comments: 1 });
    const ga = parseGa4Report({ metricHeaders: [{ name: "activeUsers" }, { name: "sessions" }, { name: "screenPageViews" }],
      rows: [{ dimensionValues: [{ value: "Reddit.com" }], metricValues: [{ value: "5" }, { value: "6" }, { value: "9" }] }, { dimensionValues: [{ value: "(not set)" }], metricValues: [{ value: "1" }, { value: "1" }, { value: "1" }] }],
      totals: [{ metricValues: [{ value: "40" }, { value: "52" }, { value: "130" }] }] }, "2026-11-05", "spaceapp.dev");
    expect(ga).toEqual([metric("2026-11-05", "GA4", "spaceapp.dev:users_30d", 40), metric("2026-11-05", "GA4", "spaceapp.dev:sessions_30d", 52),
      metric("2026-11-05", "GA4", "spaceapp.dev:views_30d", 130), metric("2026-11-05", "GA4", "spaceapp.dev:ref:reddit.com", 6)]);
    expect(ga4ConfigFromEnv({ SPACE_GA4_CREDENTIALS_FILE: "/k.json", SPACE_GA4_PROPERTIES: "spaceapp.dev=123, oll4.com=456,bad=x" }))
      .toEqual({ credentialsFile: "/k.json", properties: { "spaceapp.dev": "123", "oll4.com": "456" } });
    expect(ga4ConfigFromEnv({ SPACE_GA4_PROPERTIES: "spaceapp.dev=123" })).toBeNull();
  });
  it("refreshes the posts a public API answers for and records the day's snapshot", async () => {
    const hn = post("HACKER_NEWS", "PUBLISHED", "2026-11-04T14:19:00.000Z", {}, { publishedUrl: "https://news.ycombinator.com/item?id=50365885" });
    const x = post("X", "PUBLISHED", "2026-11-04T14:19:00.000Z", { views: 3 });
    const recorded: Array<{ id: string; metrics: Record<string, number> }> = [];
    const metrics: MarketingMetric[] = [];
    const fetched: string[] = [];
    const collector = createMarketingStatsCollector({
      service: { listPosts: async () => [hn, x], recordPostStats: async (_owner, entry, values) => { recorded.push({ id: entry.id, metrics: values }); return null; },
        recordMetrics: async (_owner, list) => { metrics.push(...list); } },
      owners: async () => ["user:operator"], snapshot: async (_owner, day) => [metric(day, "MARKETING_SCORE", "overall", 12)],
      fetchImpl: (async (url: string) => { fetched.push(url); return new Response(JSON.stringify({ score: 5, descendants: 2 }), { status: 200 }); }) as unknown as typeof fetch,
      log: { warn: () => undefined }, now: () => new Date(NOW)
    });
    expect(await collector.tick()).toMatchObject({ posts: 1, metrics: 1, errors: [] });
    expect(fetched).toEqual(["https://hacker-news.firebaseio.com/v0/item/50365885.json"]);
    expect(recorded).toEqual([{ id: hn.id, metrics: { score: 5, comments: 2 } }]);
    expect(metrics).toEqual([metric("2026-11-05", "MARKETING_SCORE", "overall", 12)]);
  });
  it("adds a dev.to article's views from the author's key", async () => {
    const devto = post("DEVTO", "PUBLISHED", "2026-11-04T14:19:00.000Z", {}, { publishedUrl: "https://dev.to/space_app/nous-1cm2/" });
    const recorded: Array<Record<string, number>> = [];
    const keys: Array<string | null> = [];
    const collector = createMarketingStatsCollector({
      service: { listPosts: async () => [devto], recordPostStats: async (_owner, _entry, values) => { recorded.push(values); return null; }, recordMetrics: async () => undefined },
      owners: async () => ["user:operator"], devtoApiKey: "k",
      fetchImpl: (async (url: string, init?: RequestInit) => {
        keys.push(new Headers(init?.headers).get("api-key"));
        return new Response(JSON.stringify(url.includes("/me/") ? [{ url: "https://dev.to/space_app/nous-1cm2", page_views_count: 140 }]
          : { public_reactions_count: 4, comments_count: 1 }), { status: 200 });
      }) as unknown as typeof fetch,
      log: { warn: () => undefined }, now: () => new Date(NOW)
    });
    expect(await collector.tick()).toMatchObject({ posts: 1, errors: [] });
    expect(keys).toEqual(["k", null]);
    expect(recorded).toEqual([{ reactions: 4, comments: 1, views: 140 }]);
  });
});
