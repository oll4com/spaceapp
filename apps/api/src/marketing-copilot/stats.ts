import { createSign } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { MarketingMetric, MarketingPost } from "@space/contracts";
import type { MarketingCopilotService } from "./service.js";

/**
 * The Nous Marketing page's collector (operator 5/11 10:42 BKK, plan clipboard:netzt-nNvtBL): every 3 hours it refreshes the numbers of the
 * published posts a public API answers for (Hacker News, dev.to; Reddit answers 403 to this server and X, LinkedIn and YouTube need paid or
 * owner keys, so the copilot's browser readouts stay their numbers), reads Google Analytics 4 when a service account is configured, and
 * records the day's marketing score, so the page's 7- and 30-day trends read real history.
 */
export const MARKETING_STATS_INTERVAL_MS = 3 * 3_600_000;
const REQUEST_TIMEOUT_MS = 10_000;
const OPERATOR = "user:operator";

type Json = Record<string, unknown> | null;
const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null);
const pick = (entries: Array<[string, number | null]>) => Object.fromEntries(entries.filter((entry): entry is [string, number] => entry[1] !== null));

/** Where a post's public numbers are read, from its published URL; null: no public API for it. */
export function postStatsUrl(post: Pick<MarketingPost, "channel" | "publishedUrl">): string | null {
  const url = post.publishedUrl ?? "";
  if (post.channel === "HACKER_NEWS") {
    const id = /^https:\/\/news\.ycombinator\.com\/item\?id=(\d+)/.exec(url)?.[1];
    return id ? `https://hacker-news.firebaseio.com/v0/item/${id}.json` : null;
  }
  if (post.channel === "DEVTO") {
    const path = /^https:\/\/dev\.to\/([A-Za-z0-9_-]+)\/([A-Za-z0-9_-]+)\/?$/.exec(url);
    return path ? `https://dev.to/api/articles/${path[1]}/${path[2]}` : null;
  }
  return null;
}

/** A Hacker News item or a dev.to article as post metrics (the copilot's keys: score, comments, reactions, views). */
export function parsePostStats(channel: MarketingPost["channel"], body: Json): Record<string, number> | null {
  if (!body || typeof body !== "object") return null;
  if (channel === "HACKER_NEWS") return body.dead || body.deleted ? null : pick([["score", num(body.score)], ["comments", num(body.descendants)]]);
  if (channel === "DEVTO") return pick([["reactions", num(body.public_reactions_count)], ["comments", num(body.comments_count)], ["views", num(body.page_views_count)]]);
  return null;
}

export interface Ga4Config { credentialsFile: string; /** site → GA4 property id ("spaceapp.dev" → "123456789"). */ properties: Record<string, string> }
/** SPACE_GA4_CREDENTIALS_FILE (a service account's JSON key with Viewer on the properties) and SPACE_GA4_PROPERTIES ("spaceapp.dev=123,oll4.com=456"). */
export function ga4ConfigFromEnv(env: NodeJS.ProcessEnv = process.env): Ga4Config | null {
  const properties = Object.fromEntries((env.SPACE_GA4_PROPERTIES ?? "").split(",").map((pair) => pair.trim().split("=").map((part) => part.trim()))
    .filter((pair) => pair.length === 2 && /^[a-z0-9.-]+$/i.test(pair[0]!) && /^\d+$/.test(pair[1]!)));
  return env.SPACE_GA4_CREDENTIALS_FILE && Object.keys(properties).length ? { credentialsFile: env.SPACE_GA4_CREDENTIALS_FILE, properties } : null;
}

/**
 * A GA4 runReport answer (last 30 days by sessionSource, TOTAL aggregation) as daily metrics: `<site>:users_30d`, `:sessions_30d`, `:views_30d`
 * and every source's sessions as `<site>:ref:<source>` (the page maps reddit.com, t.co, news.ycombinator.com ... to their platforms).
 */
export function parseGa4Report(body: Json, day: string, site: string): MarketingMetric[] {
  const names = Array.isArray(body?.metricHeaders) ? (body.metricHeaders as Array<{ name?: unknown }>).map((header) => String(header.name)) : [];
  const rows = Array.isArray(body?.rows) ? body.rows as Array<{ dimensionValues?: Array<{ value?: unknown }>; metricValues?: Array<{ value?: unknown }> }> : [];
  const values = (list: Array<{ value?: unknown }> | undefined) => Object.fromEntries(names.map((name, index) => [name, Number(list?.[index]?.value ?? Number.NaN)]));
  const totals = Array.isArray(body?.totals) && body.totals[0] ? values((body.totals as Array<{ metricValues?: Array<{ value?: unknown }> }>)[0]!.metricValues)
    : Object.fromEntries(names.map((name) => [name, rows.reduce((sum, row) => sum + (Number(values(row.metricValues)[name]) || 0), 0)]));
  const out: MarketingMetric[] = [];
  const add = (key: string, value: unknown) => { if (typeof value === "number" && Number.isFinite(value)) out.push({ day, source: "GA4", key: `${site}:${key}`.slice(0, 80), value }); };
  add("users_30d", totals.activeUsers); add("sessions_30d", totals.sessions); add("views_30d", totals.screenPageViews);
  for (const row of rows) {
    const source = String(row.dimensionValues?.[0]?.value ?? "").toLowerCase();
    if (source && source !== "(not set)") add(`ref:${source}`, values(row.metricValues).sessions);
  }
  return out;
}

async function ga4Token(credentialsFile: string, fetchImpl: typeof fetch): Promise<string> {
  const key = JSON.parse(await readFile(credentialsFile, "utf8")) as { client_email?: string; private_key?: string };
  if (!key.client_email || !key.private_key) throw new Error("the GA4 credentials file is not a service account key");
  const at = Math.floor(Date.now() / 1000);
  const part = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const unsigned = `${part({ alg: "RS256", typ: "JWT" })}.${part({ iss: key.client_email, scope: "https://www.googleapis.com/auth/analytics.readonly",
    aud: "https://oauth2.googleapis.com/token", iat: at, exp: at + 3600 })}`;
  const assertion = `${unsigned}.${createSign("RSA-SHA256").update(unsigned).sign(key.private_key, "base64url")}`;
  const response = await fetchImpl("https://oauth2.googleapis.com/token", { method: "POST", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }) });
  const token = (await response.json().catch(() => null) as { access_token?: unknown } | null)?.access_token;
  if (!response.ok || typeof token !== "string") throw new Error(`Google token answered HTTP ${response.status}`);
  return token;
}

export async function fetchGa4Metrics(config: Ga4Config, day: string, fetchImpl: typeof fetch = fetch): Promise<{ metrics: MarketingMetric[]; errors: string[] }> {
  const token = await ga4Token(config.credentialsFile, fetchImpl);
  const metrics: MarketingMetric[] = [];
  const errors: string[] = [];
  for (const [site, property] of Object.entries(config.properties)) {
    const response = await fetchImpl(`https://analyticsdata.googleapis.com/v1beta/properties/${property}:runReport`, { method: "POST", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ dateRanges: [{ startDate: "30daysAgo", endDate: "today" }], dimensions: [{ name: "sessionSource" }],
        metrics: [{ name: "activeUsers" }, { name: "sessions" }, { name: "screenPageViews" }], metricAggregations: ["TOTAL"] }) }).catch((error: unknown) => error as Error);
    if (response instanceof Error || !response.ok) { errors.push(`GA4 ${site}: ${response instanceof Error ? response.message : `HTTP ${response.status}`}`); continue; }
    metrics.push(...parseGa4Report(await response.json() as Json, day, site));
  }
  return { metrics, errors };
}

export interface MarketingStatsDeps {
  service: Pick<MarketingCopilotService, "listPosts" | "recordPostStats" | "recordMetrics">;
  owners(): Promise<string[]>;
  /** The day's marketing score as metrics (nous/marketing.ts), recorded after the refresh. */
  snapshot?(owner: string, day: string): Promise<MarketingMetric[]>;
  ga4?: Ga4Config | null;
  /** SPACE_DEVTO_API_KEY: dev.to answers an article's page views only to its author's key. */
  devtoApiKey?: string | null;
  fetchImpl?: typeof fetch;
  log: { warn(obj: Record<string, unknown>, message: string): void };
  now?(): Date;
  intervalMs?: number;
}

export function createMarketingStatsCollector(deps: MarketingStatsDeps) {
  const fetchImpl = deps.fetchImpl ?? fetch;
  let timer: NodeJS.Timeout | null = null;
  let running = false;
  async function tick(): Promise<{ posts: number; metrics: number; errors: string[] }> {
    if (running) return { posts: 0, metrics: 0, errors: [] };
    running = true;
    const errors: string[] = [];
    let posts = 0;
    let recorded = 0;
    try {
      const day = (deps.now?.() ?? new Date()).toISOString().slice(0, 10);
      for (const owner of await deps.owners()) {
        // The key is the operator's dev.to account, like the site analytics. per_page 1000 is dev.to's largest page.
        const devtoViews = deps.devtoApiKey && owner === OPERATOR ? await fetchImpl("https://dev.to/api/articles/me/all?per_page=1000", {
          headers: { accept: "application/json", "user-agent": "space-marketing-stats", "api-key": deps.devtoApiKey }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
          .then((response) => (response.ok ? response.json() as Promise<Array<{ url?: unknown; page_views_count?: unknown }>> : Promise.reject(new Error(`HTTP ${response.status}`))))
          .then((list) => new Map(list.map((article) => [String(article.url), article.page_views_count])))
          .catch((error: unknown) => { errors.push(`dev.to views: ${error instanceof Error ? error.message : String(error)}`); return null; }) : null;
        for (const post of await deps.service.listPosts(owner, { status: ["PUBLISHED"] })) {
          const url = postStatsUrl(post);
          if (!url) continue;
          const body = await fetchImpl(url, { headers: { accept: "application/json", "user-agent": "space-marketing-stats" }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
            .then((response) => (response.ok ? response.json() as Promise<Json> : Promise.reject(new Error(`HTTP ${response.status}`))))
            .catch((error: unknown) => { errors.push(`${post.id}: ${error instanceof Error ? error.message : String(error)}`); return null; });
          const views = post.channel === "DEVTO" ? devtoViews?.get(post.publishedUrl?.replace(/\/$/, "") ?? "") : undefined;
          const stats = parsePostStats(post.channel, body && views !== undefined ? { ...body, page_views_count: views } : body);
          if (stats && Object.keys(stats).length) { await deps.service.recordPostStats(owner, post, stats); posts++; }
        }
        // Site analytics are the maintainer's data, like the repository traffic: only the operator's.
        if (deps.ga4 && owner === OPERATOR) {
          const ga = await fetchGa4Metrics(deps.ga4, day, fetchImpl).catch((error: unknown) => ({ metrics: [], errors: [`GA4: ${error instanceof Error ? error.message : String(error)}`] }));
          errors.push(...ga.errors);
          await deps.service.recordMetrics(owner, ga.metrics);
          recorded += ga.metrics.length;
        }
        if (deps.snapshot) {
          const snapshot = await deps.snapshot(owner, day).catch((error: unknown) => { errors.push(`score: ${error instanceof Error ? error.message : String(error)}`); return []; });
          await deps.service.recordMetrics(owner, snapshot);
          recorded += snapshot.length;
        }
      }
      if (errors.length) deps.log.warn({ errors }, "Marketing stats: some sources failed");
      return { posts, metrics: recorded, errors };
    } finally {
      running = false;
    }
  }
  return {
    tick,
    start() {
      timer = setInterval(() => void tick().catch((error) => deps.log.warn({ err: error }, "Marketing stats tick failed")), deps.intervalMs ?? MARKETING_STATS_INTERVAL_MS);
      timer.unref();
      setTimeout(() => void tick().catch((error) => deps.log.warn({ err: error }, "Marketing stats tick failed")), 180_000).unref();
    },
    stop() { if (timer) clearInterval(timer); timer = null; }
  };
}
