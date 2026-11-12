import type { MarketingMetric, MarketingPost, NousMarketingNumbers, NousMarketingPlatform, NousMarketingPostRow, NousMarketingReport, NousMarketingSource, NousSiteFunnel } from "@space/contracts";

/**
 * The Nous "Marketing" page and space_marketing_stats (operator 5/11 10:42 BKK, nous_msg:25daa8b6ebbf489499694f64, plan clipboard:netzt-nNvtBL):
 * every Marketing Copilot post numbered, per platform, with what it brought; the other stats sources; a score per post, per platform and overall.
 * Computed on request from the posts and the daily metrics (marketing_copilot_metrics, which also keeps the score's daily snapshots).
 */
/** What counts as full marks: a post seen 1000 times with 50 interactions scores 100; the outcomes' 30-day targets likewise. */
export const MARKETING_SCORE_TARGETS = { views: 1000, engaged: 50, starsGained30d: 50, npmWeek: 200, activeInstalls: 50, gaUsers30d: 2000 } as const;
/** The overall score: posts weigh this much, the outcomes (stars, downloads, installs, visitors) the rest. */
export const MARKETING_POSTS_WEIGHT = 0.6;
export const MARKETING_WINDOW_DAYS = 30;
/** Below this overall score marketing under-performs and the Nous Score charges it (operator 5/11: «αρνητική βαθμολογία ... η μη απόδοση»). */
export const MARKETING_SCORE_TARGET = 50;
export const MARKETING_SCORE_SOURCE = "MARKETING_SCORE";
const DAY_MS = 86_400_000;
/** A post that went out or was meant to: published, failed, being published, or approved and held for its time. */
const LISTED = new Set<MarketingPost["status"]>(["PUBLISHED", "FAILED", "PUBLISHING", "APPROVED"]);
/** The copilot reads posts with the platform's own words; each group is one number (the largest key, since several name the same count). */
const KEYS = {
  views: ["views", "impressions", "page_views", "plays"], replies: ["replies", "comments", "comments_from_others", "comment_count"],
  messages: ["messages", "dms", "dm", "inbound_messages"], likes: ["likes", "upvotes", "score", "reactions", "points"],
  shares: ["reposts", "retweets", "shares", "quotes"], saves: ["bookmarks", "saves"], clicks: ["clicks", "link_clicks", "url_clicks"],
  followers: ["followers", "followers_gained", "new_followers", "follows", "subscribers"]
} as const;
/** Which platform a referrer host is (GA4 sessionSource, GitHub's referrers). */
const REFERRERS: Array<[string, RegExp]> = [["X", /^(t\.co|x\.com|(mobile\.)?twitter\.com)$/], ["REDDIT", /(^|\.)reddit\.com$/], ["HACKER_NEWS", /^news\.ycombinator\.com$/],
  ["DEVTO", /^dev\.to$/], ["LINKEDIN", /((^|\.)linkedin\.com|^lnkd\.in)$/], ["YOUTUBE", /((^|\.)youtube\.com|^youtu\.be)$/], ["PRODUCT_HUNT", /(^|\.)producthunt\.com$/], ["GITHUB", /^github\.com$/]];
export const GA4_NEEDS = "a Google service account JSON key with Viewer on the GA4 properties of spaceapp.dev and oll4.com (SPACE_GA4_CREDENTIALS_FILE) and their property ids (SPACE_GA4_PROPERTIES=spaceapp.dev=<id>,oll4.com=<id>)";
export const GITHUB_TRAFFIC_NEEDS = "a GitHub token with push access to the repository (fine-grained: Administration read) as SPACE_GITHUB_TRAFFIC_TOKEN";

export function marketingNumbers(raw: Record<string, number>): NousMarketingNumbers {
  const max = (keys: readonly string[]) => keys.reduce<number | null>((best, key) => (typeof raw[key] === "number" ? Math.max(best ?? 0, raw[key]!) : best), null);
  return { views: max(KEYS.views), replies: max(KEYS.replies) ?? 0, messages: max(KEYS.messages) ?? 0,
    likes: (max(KEYS.likes) ?? 0) + (max(KEYS.shares) ?? 0) + (max(KEYS.saves) ?? 0), clicks: max(KEYS.clicks) ?? 0, followers: max(KEYS.followers) ?? 0 };
}
const ratio = (value: number, target: number) => Math.min(1, Math.log10(1 + Math.max(0, value)) / Math.log10(1 + target));
/** 0-100: half reach (views), half interactions (a click, message or follower weighs more than a like); without views, interactions alone. */
export function marketingPostScore(numbers: NousMarketingNumbers): number {
  const engaged = ratio(numbers.replies + numbers.likes + 2 * numbers.clicks + 3 * numbers.messages + 3 * numbers.followers, MARKETING_SCORE_TARGETS.engaged);
  return Math.round(100 * (numbers.views === null ? engaged : (ratio(numbers.views, MARKETING_SCORE_TARGETS.views) + engaged) / 2));
}
const mean = (values: number[]) => (values.length ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length) : null);
const dayOf = (at: number) => new Date(at).toISOString().slice(0, 10);

export function marketingPostRows(posts: MarketingPost[]): NousMarketingPostRow[] {
  const listed = posts.filter((post) => LISTED.has(post.status)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return listed.map((post, index) => {
    const measured = Object.keys(post.metrics).length > 0;
    const numbers = marketingNumbers(post.metrics);
    const times = [post.evidence.statsAt, post.evidence.metricsAt].filter((value): value is string => typeof value === "string").sort();
    return { number: index + 1, id: post.id, channel: post.channel, status: post.status, title: post.title, target: post.target, url: post.publishedUrl,
      at: post.publishedAt ?? post.updatedAt, measuredAt: times.at(-1) ?? null, ...numbers,
      score: post.status === "FAILED" ? 0 : post.status === "PUBLISHED" && measured ? marketingPostScore(numbers) : null,
      failure: typeof post.evidence.failure === "string" ? post.evidence.failure.slice(0, 500) : null, raw: post.metrics };
  }).reverse();
}

/** The newest value of a metric on or before a day, and (with `before`) the newest on or before `before`. */
function latest(metrics: MarketingMetric[], source: string, key: string, day: string): MarketingMetric | null {
  let found: MarketingMetric | null = null;
  for (const metric of metrics) if (metric.source === source && metric.key === key && metric.day <= day && (!found || metric.day > found.day)) found = metric;
  return found;
}
/** 0-100 from what marketing brought by a day: GitHub stars gained in 30 days, npm's last week, active installs, GA4 users; null: none recorded. */
export function marketingOutcomesScore(metrics: MarketingMetric[], day: string): number | null {
  const parts: number[] = [];
  const stars = latest(metrics, "GITHUB", "stars", day);
  const before = latest(metrics, "GITHUB", "stars", dayOf(Date.parse(`${day}T00:00:00Z`) - MARKETING_WINDOW_DAYS * DAY_MS))
    ?? metrics.filter((metric) => metric.source === "GITHUB" && metric.key === "stars" && metric.day <= day).sort((a, b) => a.day.localeCompare(b.day))[0];
  if (stars && before && before.day < stars.day) parts.push(ratio(stars.value - before.value, MARKETING_SCORE_TARGETS.starsGained30d));
  const npm = latest(metrics, "NPM", "downloads_week", day);
  if (npm) parts.push(ratio(npm.value, MARKETING_SCORE_TARGETS.npmWeek));
  const installs = latest(metrics, "INSTALLS", "active_7d", day);
  if (installs) parts.push(ratio(installs.value, MARKETING_SCORE_TARGETS.activeInstalls));
  const gaDay = metrics.filter((metric) => metric.source === "GA4" && metric.day <= day).reduce<string | null>((best, metric) => (!best || metric.day > best ? metric.day : best), null);
  if (gaDay) parts.push(ratio(metrics.filter((metric) => metric.source === "GA4" && metric.day === gaDay && metric.key.endsWith(":users_30d")).reduce((sum, metric) => sum + metric.value, 0), MARKETING_SCORE_TARGETS.gaUsers30d));
  return parts.length ? Math.round((100 * parts.reduce((sum, part) => sum + part, 0)) / parts.length) : null;
}

/** The overall score as of a moment: its posts of the 30 days before it (measured or failed) and the outcomes recorded by then. */
export function marketingScoreAsOf(rows: NousMarketingPostRow[], metrics: MarketingMetric[], at: number) {
  const scored = rows.filter((row) => row.score !== null && Date.parse(row.at) <= at && Date.parse(row.at) > at - MARKETING_WINDOW_DAYS * DAY_MS);
  const postsScore = mean(scored.map((row) => row.score!));
  const outcomesScore = marketingOutcomesScore(metrics, dayOf(at));
  const score = postsScore === null ? outcomesScore : outcomesScore === null ? postsScore
    : Math.round(MARKETING_POSTS_WEIGHT * postsScore + (1 - MARKETING_POSTS_WEIGHT) * outcomesScore);
  return { score, postsScore, outcomesScore, scored };
}

export interface MarketingMailCampaign { name: string; status: string; sent: number; replied: number; bounced: number; unsubscribed: number }
export interface MarketingReportInput {
  posts: MarketingPost[];
  metrics: MarketingMetric[];
  mail: MarketingMailCampaign[] | null;
  ga4Configured: boolean;
  trafficConfigured: boolean;
  devtoConfigured?: boolean;
  /** spaceapp.dev's own page views (site-visits.ts); absent where nothing reads them, as the copilot's snapshots. */
  site?: NousSiteFunnel | null;
  now: number;
}

export function buildMarketingReport(input: MarketingReportInput): NousMarketingReport {
  const { metrics, now } = input;
  const rows = marketingPostRows(input.posts);
  const today = marketingScoreAsOf(rows, metrics, now);
  const trend = (days: number) => {
    if (today.score === null) return null;
    const day = dayOf(now - days * DAY_MS);
    // The snapshot recorded then (within 3 days before), else the score recomputed as of then from today's records.
    const snapshot = latest(metrics, MARKETING_SCORE_SOURCE, "overall", day);
    const then = snapshot && snapshot.day >= dayOf(now - (days + 3) * DAY_MS) ? snapshot.value : marketingScoreAsOf(rows, metrics, now - days * DAY_MS).score;
    return then === null ? null : today.score - then;
  };
  const sum = (list: NousMarketingPostRow[]): NousMarketingNumbers => ({
    views: list.some((row) => row.views !== null) ? list.reduce((total, row) => total + (row.views ?? 0), 0) : null,
    replies: list.reduce((total, row) => total + row.replies, 0), messages: list.reduce((total, row) => total + row.messages, 0),
    likes: list.reduce((total, row) => total + row.likes, 0), clicks: list.reduce((total, row) => total + row.clicks, 0), followers: list.reduce((total, row) => total + row.followers, 0)
  });
  const count = (list: NousMarketingPostRow[]) => ({ posts: list.length, published: list.filter((row) => row.status === "PUBLISHED").length,
    failed: list.filter((row) => row.status === "FAILED").length, measured: list.filter((row) => row.status === "PUBLISHED" && Object.keys(row.raw).length > 0).length });
  // Referral visits: GA4's newest day (30 days) and GitHub's newest referrers (14 days), each host to its platform.
  const newestDay = (source: string) => metrics.filter((metric) => metric.source === source).reduce<string | null>((best, metric) => (!best || metric.day > best ? metric.day : best), null);
  const referrals = [["GA4", newestDay("GA4")], ["GITHUB_REFERRERS", newestDay("GITHUB_REFERRERS")]].flatMap(([source, day]) => metrics
    .filter((metric) => metric.source === source && metric.day === day && (source !== "GA4" || metric.key.includes(":ref:")))
    .map((metric) => ({ host: (source === "GA4" ? metric.key.split(":ref:")[1]! : metric.key).toLowerCase(), value: metric.value })));
  const visitsOf = (channel: string) => {
    const pattern = REFERRERS.find(([id]) => id === channel)?.[1];
    const matched = pattern ? referrals.filter((entry) => pattern.test(entry.host)) : [];
    return matched.length ? matched.reduce((total, entry) => total + entry.value, 0) : null;
  };
  const channels = [...new Set(rows.map((row) => row.channel))];
  const platforms: NousMarketingPlatform[] = channels.map((channel) => {
    const list = rows.filter((row) => row.channel === channel);
    return { channel, ...count(list), ...sum(list), visits: visitsOf(channel), score: mean(today.scored.filter((row) => row.channel === channel).map((row) => row.score!)) };
  }).sort((a, b) => (b.score ?? -1) - (a.score ?? -1) || b.posts - a.posts);
  const daysWithoutResult = Array.from({ length: 7 }, (_, index) => dayOf(now - index * DAY_MS))
    .filter((day) => !rows.some((row) => row.status === "PUBLISHED" && row.at.slice(0, 10) === day && (row.score ?? 0) > 0)).length;
  const published = rows.filter((row) => row.status === "PUBLISHED");
  // Days in a row below the target, today backwards, each recomputed as of its end; it stops at the first day at or above it or with no score.
  const first = rows.length ? Math.min(...rows.map((row) => Date.parse(row.at))) : now;
  let daysBelowTarget = 0;
  for (let at = now; at >= first; at -= DAY_MS) {
    const then = at === now ? today.score : marketingScoreAsOf(rows, metrics, at).score;
    if (then === null || then >= MARKETING_SCORE_TARGET) break;
    daysBelowTarget += 1;
  }
  return {
    generatedAt: new Date(now).toISOString(), score: today.score, postsScore: today.postsScore, outcomesScore: today.outcomesScore, trend7: trend(7), trend30: trend(30), daysWithoutResult, target: MARKETING_SCORE_TARGET, daysBelowTarget,
    totals: { ...count(rows), ...sum(rows), zeroReach: published.filter((row) => row.score === 0).length },
    platforms, posts: rows, sources: marketingSources(input, rows), site: input.site ?? null
  };
}

function marketingSources(input: MarketingReportInput, rows: NousMarketingPostRow[]): NousMarketingSource[] {
  const newest = (source: string, keep: (key: string) => boolean = () => true) => {
    const list = input.metrics.filter((metric) => metric.source === source && keep(metric.key));
    const day = list.reduce<string | null>((best, metric) => (!best || metric.day > best ? metric.day : best), null);
    return { day, values: Object.fromEntries(list.filter((metric) => metric.day === day).map((metric) => [metric.key, metric.value])) };
  };
  const posts = (channel: string) => rows.filter((row) => row.channel === channel && row.status === "PUBLISHED");
  const refreshed = (channel: string) => posts(channel).filter((row) => Object.keys(row.raw).length > 0).length;
  const ga = newest("GA4", (key) => !key.includes(":ref:"));
  const traffic = newest("GITHUB_TRAFFIC");
  const readouts = rows.filter((row) => row.status === "PUBLISHED" && !["HACKER_NEWS", "DEVTO"].includes(row.channel));
  const sent = input.mail?.filter((campaign) => campaign.sent > 0) ?? [];
  return [
    { id: "GA4", label: "Google Analytics 4", connected: input.ga4Configured || ga.day !== null, ...ga,
      detail: input.ga4Configured || ga.day ? "Users, sessions and views of the last 30 days per site, and sessions per referrer, every 3 hours." : `Not connected: needs ${GA4_NEEDS}.` },
    { id: "GITHUB", label: "GitHub repository", connected: true, ...newest("GITHUB"), detail: "Public numbers once a day: stars, forks, watchers, open issues and pull requests, release downloads." },
    { id: "GITHUB_TRAFFIC", label: "GitHub traffic", connected: input.trafficConfigured || traffic.day !== null, ...traffic,
      detail: input.trafficConfigured || traffic.day ? "Views, visitors, clones of GitHub's 14-day window and its referrers, once a day." : `Not connected: needs ${GITHUB_TRAFFIC_NEEDS}.` },
    { id: "NPM", label: "npm (run-spaceapp)", connected: true, ...newest("NPM"), detail: "Downloads of the installer package: the newest posted day and the last 7 posted days." },
    { id: "INSTALLS", label: "Self-hosted installs", connected: true, ...newest("INSTALLS"), detail: "Installations active in the last 7 days (opt-in telemetry)." },
    { id: "HACKER_NEWS", label: "Hacker News", connected: true, day: null, values: { posts: posts("HACKER_NEWS").length, read: refreshed("HACKER_NEWS") },
      detail: "Public API every 3 hours: points and comments of each published item." },
    { id: "DEVTO", label: "dev.to", connected: true, day: null, values: { posts: posts("DEVTO").length, read: refreshed("DEVTO") },
      detail: `Public API every 3 hours: reactions and comments of each article; ${input.devtoConfigured ? "views with the account's API key." : "views need the dev.to account's API key (SPACE_DEVTO_API_KEY)."}` },
    { id: "READOUTS", label: "Copilot readouts (X, Reddit, LinkedIn, YouTube, Product Hunt)", connected: true, day: null,
      values: { posts: readouts.length, read: readouts.filter((row) => Object.keys(row.raw).length > 0).length },
      detail: "The Marketing Copilot reads each post in its browser a day and a week after publishing. Automatic reads would need: a Reddit API app (the public JSON answers 403 to this server), an X API paid plan, a YouTube Data API key." },
    { id: "MAIL", label: "Mail campaigns", connected: input.mail !== null, day: null,
      values: { campaigns: sent.length, sent: sent.reduce((total, campaign) => total + campaign.sent, 0), replied: sent.reduce((total, campaign) => total + campaign.replied, 0),
        bounced: sent.reduce((total, campaign) => total + campaign.bounced, 0), unsubscribed: sent.reduce((total, campaign) => total + campaign.unsubscribed, 0) },
      detail: input.mail === null ? "Mail Campaigns is not running on this server." : "Sent, replied, bounced and unsubscribed of every campaign that sent (opens are not tracked)." }
  ];
}

/** The day's snapshot (overall, posts, outcomes, each platform), recorded by the stats collector so trends read history. */
export function marketingSnapshot(report: NousMarketingReport, day: string): MarketingMetric[] {
  const entries: Array<[string, number | null]> = [["overall", report.score], ["posts", report.postsScore], ["outcomes", report.outcomesScore],
    ...report.platforms.map((platform): [string, number | null] => [`channel:${platform.channel}`, platform.score])];
  return entries.filter((entry): entry is [string, number] => entry[1] !== null).map(([key, value]) => ({ day, source: MARKETING_SCORE_SOURCE, key, value }));
}

const signed = (value: number | null) => (value === null ? "–" : `${value >= 0 ? "+" : ""}${value}`);
const numbers = (row: NousMarketingNumbers) => `views ${row.views ?? "–"}, replies ${row.replies}, messages ${row.messages}, likes ${row.likes}, clicks ${row.clicks}, followers ${row.followers}`;

/** One line for Nous's world: the score, its trend and what costs it. */
export function marketingLine(report: NousMarketingReport): string {
  const recent = report.posts.filter((row) => Date.parse(row.at) > Date.parse(report.generatedAt) - 7 * DAY_MS);
  const best = report.platforms.find((platform) => platform.score !== null);
  return `Marketing (space_marketing_stats reads every post and source): score ${report.score ?? "–"}/100 (7 d ${signed(report.trend7)}, 30 d ${signed(report.trend30)}); `
    + `last 7 days ${recent.filter((row) => row.status === "PUBLISHED").length} published, ${recent.filter((row) => row.status === "FAILED").length} failed, `
    + `${report.daysWithoutResult} of 7 days without a post that brought anything; ${report.totals.zeroReach} published posts with no reach, `
    + `${report.totals.published - report.totals.measured} never measured${best ? `; best platform ${best.channel} ${best.score}` : ""}.`;
}

export const MARKETING_TOOL_PAGE = 100; // technical: one tool result's size; `offset` reads the rest
/** space_marketing_stats' text: the summary, the platforms, the sources, or one page of posts (optionally one platform's). */
export function marketingToolText(report: NousMarketingReport, args: { view?: "summary" | "posts" | "sources"; channel?: string; offset?: number }): string {
  if (args.view === "sources") return report.sources.map((source) => `- ${source.label} [${source.connected ? "connected" : "NOT CONNECTED"}]${source.day ? ` ${source.day}` : ""}: ${source.detail}`
    + `${Object.keys(source.values).length ? ` Values: ${Object.entries(source.values).map(([key, value]) => `${key} ${value}`).join(", ")}.` : ""}`).join("\n");
  if (args.view === "posts") {
    const list = report.posts.filter((row) => !args.channel || row.channel === args.channel.toUpperCase());
    const offset = Math.max(0, args.offset ?? 0);
    const page = list.slice(offset, offset + MARKETING_TOOL_PAGE);
    const lines = page.map((row) => `#${row.number} ${row.at.slice(0, 16)} ${row.channel} ${row.status} score ${row.score ?? "not measured"} · ${numbers(row)}`
      + ` · ${row.url ?? row.target ?? "(no link)"}${row.title ? ` · "${row.title.slice(0, 100)}"` : ""}${row.failure ? ` · failure: ${row.failure.slice(0, 160)}` : ""} [${row.id}]`);
    const more = offset + page.length < list.length ? `\n(${list.length - offset - page.length} more: offset ${offset + page.length})` : "";
    return `${list.length} posts${args.channel ? ` on ${args.channel.toUpperCase()}` : ""}, newest first (rows ${offset + 1}-${offset + page.length}):\n${lines.join("\n")}${more}`;
  }
  return [marketingLine(report),
    `Posts score ${report.postsScore ?? "–"}, outcomes score ${report.outcomesScore ?? "–"} (weights ${MARKETING_POSTS_WEIGHT}/${Math.round((1 - MARKETING_POSTS_WEIGHT) * 10) / 10}). Totals: ${report.totals.posts} posts, `
      + `${report.totals.published} published, ${report.totals.failed} failed, ${report.totals.measured} measured; ${numbers(report.totals)}.`,
    "Platforms:", ...report.platforms.map((platform) => `- ${platform.channel}: score ${platform.score ?? "–"}, ${platform.posts} posts (${platform.published} published, ${platform.failed} failed, `
      + `${platform.measured} measured), ${numbers(platform)}, visits to our sites ${platform.visits ?? "–"}`),
    `Sources not connected: ${report.sources.filter((source) => !source.connected).map((source) => source.label).join(", ") || "none"}. view "posts" lists every post (channel, offset); view "sources" every source.`].join("\n");
}

/** One read per owner a minute (the page polls every minute, the world line reads the cache). */
export function createNousMarketing(deps: { read(owner: string): Promise<MarketingReportInput> }) {
  const cache = new Map<string, { at: number; report: NousMarketingReport }>();
  async function report(owner: string): Promise<NousMarketingReport> {
    const held = cache.get(owner);
    if (held && Date.now() - held.at < 60_000) return held.report;
    const fresh = buildMarketingReport(await deps.read(owner));
    cache.set(owner, { at: Date.now(), report: fresh });
    return fresh;
  }
  return {
    report,
    /** The cached line; a stale or missing cache is read again in the background for the next turn. */
    line(owner: string): string | null {
      const held = cache.get(owner);
      if (!held || Date.now() - held.at >= 60_000) void report(owner).catch(() => undefined);
      return held ? marketingLine(held.report) : null;
    }
  };
}
