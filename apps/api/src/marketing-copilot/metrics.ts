import { readFile } from "node:fs/promises";
import type { MarketingMetric, Pane, Room } from "@space/contracts";
import { GITHUB_DEFAULT_REPO } from "../app-version.js";
import { INSTALL_PINGS_PATH, summarizeInstallPings } from "../install-telemetry-routes.js";
import type { MarketingCopilotService } from "./service.js";

/** The public installer's npm package. */
export const SPACEAPP_NPM_PACKAGE = "run-spaceapp";
/** Install pings are ADMIN data (System Analytics): only the operator's pane records the active installations. */
const OPERATOR = "user:operator";
const DEFAULT_INTERVAL_MS = 6 * 3_600_000;
const REQUEST_TIMEOUT_MS = 10_000;

async function json(fetchImpl: typeof fetch, url: string, token?: string): Promise<unknown> {
  const response = await fetchImpl(url, {
    headers: { accept: "application/json", "user-agent": "space-marketing-copilot", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  });
  if (!response.ok) throw new Error(`${new URL(url).host} answered HTTP ${response.status}`);
  return response.json();
}
const numberAt = (value: unknown, key: string): number | null => {
  const raw = (value as Record<string, unknown> | null)?.[key];
  return typeof raw === "number" && Number.isFinite(raw) ? raw : null;
};

/**
 * Today's public numbers: the GitHub repository (stars, forks, watchers, open issues, release downloads) and the npm
 * installer's downloads. Unauthenticated public APIs; a source that fails is skipped, the others still count.
 */
export async function fetchPublicMetrics(day: string, fetchImpl: typeof fetch = fetch, repo = GITHUB_DEFAULT_REPO): Promise<{ metrics: MarketingMetric[]; errors: string[] }> {
  const metrics: MarketingMetric[] = [];
  const errors: string[] = [];
  const add = (source: string, key: string, value: number | null) => { if (value !== null) metrics.push({ day, source, key, value }); };
  await Promise.all([
    json(fetchImpl, `https://api.github.com/repos/${repo}`).then((body) => {
      add("GITHUB", "stars", numberAt(body, "stargazers_count"));
      add("GITHUB", "forks", numberAt(body, "forks_count"));
      add("GITHUB", "watchers", numberAt(body, "subscribers_count"));
      add("GITHUB", "open_issues", numberAt(body, "open_issues_count"));
    }).catch((error: unknown) => { errors.push(`GitHub: ${error instanceof Error ? error.message : String(error)}`); }),
    json(fetchImpl, `https://api.github.com/repos/${repo}/releases?per_page=100`).then((body) => {
      const releases = Array.isArray(body) ? body as Array<{ assets?: Array<{ download_count?: unknown }> }> : [];
      add("GITHUB", "release_downloads", releases.reduce((total, release) => total + (release.assets ?? []).reduce((sum, asset) => sum + (typeof asset.download_count === "number" ? asset.download_count : 0), 0), 0));
    }).catch((error: unknown) => { errors.push(`GitHub releases: ${error instanceof Error ? error.message : String(error)}`); }),
    ...(["last-day", "last-week"] as const).map((period) => json(fetchImpl, `https://api.npmjs.org/downloads/point/${period}/${SPACEAPP_NPM_PACKAGE}`)
      .then((body) => add("NPM", period === "last-day" ? "downloads_day" : "downloads_week", numberAt(body, "downloads")))
      .catch((error: unknown) => { errors.push(`npm ${period}: ${error instanceof Error ? error.message : String(error)}`); }))
  ]);
  return { metrics, errors };
}

/**
 * The repository's traffic over GitHub's 14-day window: views, unique visitors, clones, unique cloners and the top 5
 * referrers. GitHub keeps traffic for 14 days and shows it only with push access, so it needs a token; a daily
 * record turns it into history.
 */
export async function fetchRepoTraffic(day: string, token: string, fetchImpl: typeof fetch = fetch, repo = GITHUB_DEFAULT_REPO): Promise<{ metrics: MarketingMetric[]; errors: string[] }> {
  const metrics: MarketingMetric[] = [];
  const errors: string[] = [];
  const add = (source: string, key: string, value: number | null) => { if (value !== null) metrics.push({ day, source, key, value }); };
  const base = `https://api.github.com/repos/${repo}/traffic`;
  await Promise.all([
    ...(["views", "clones"] as const).map((kind) => json(fetchImpl, `${base}/${kind}`, token).then((body) => {
      add("GITHUB_TRAFFIC", `${kind}_14d`, numberAt(body, "count"));
      add("GITHUB_TRAFFIC", kind === "views" ? "visitors_14d" : "cloners_14d", numberAt(body, "uniques"));
    }).catch((error: unknown) => { errors.push(`GitHub traffic ${kind}: ${error instanceof Error ? error.message : String(error)}`); })),
    json(fetchImpl, `${base}/popular/referrers`, token).then((body) => {
      for (const entry of (Array.isArray(body) ? body : []).slice(0, 5)) {
        const referrer = (entry as { referrer?: unknown }).referrer;
        if (typeof referrer === "string" && referrer) add("GITHUB_REFERRERS", referrer.slice(0, 80), numberAt(entry, "count"));
      }
    }).catch((error: unknown) => { errors.push(`GitHub referrers: ${error instanceof Error ? error.message : String(error)}`); })
  ]);
  return { metrics, errors };
}

export interface MarketingCopilotMetricsDeps {
  service: Pick<MarketingCopilotService, "recordMetrics" | "metricsDigest">;
  store: { listRooms(): Promise<Room[]> | Room[]; listPanes(roomId: string): Promise<Pane[]> | Pane[] };
  fetchImpl?: typeof fetch;
  log: { warn(obj: Record<string, unknown>, message: string): void };
  now?(): Date;
  intervalMs?: number;
  firstDelayMs?: number;
  installPingsPath?: string;
  /** Reads the repository's traffic (SPACE_GITHUB_TRAFFIC_TOKEN); without it traffic is not recorded. */
  githubTrafficToken?: string;
}

/**
 * Once a day per owner of a Marketing Copilot pane: today's public numbers are recorded, and once a week a summary
 * lands in that pane's Activity. Repeated ticks the same day replace the day's values.
 */
export function createMarketingCopilotMetrics(deps: MarketingCopilotMetricsDeps) {
  let timer: NodeJS.Timeout | null = null;
  let first: NodeJS.Timeout | null = null;
  let running = false;
  async function tick(): Promise<{ owners: number; metrics: number }> {
    if (running) return { owners: 0, metrics: 0 };
    running = true;
    try {
      const owners = new Map<string, Pane>();
      for (const room of await deps.store.listRooms()) {
        if (!room.ownerUserId || owners.has(room.ownerUserId)) continue;
        const pane = (await deps.store.listPanes(room.id)).find((candidate) => candidate.mode === "MARKETING_COPILOT" && !candidate.isClosed);
        if (pane) owners.set(room.ownerUserId, pane);
      }
      if (!owners.size) return { owners: 0, metrics: 0 };
      const at = deps.now?.() ?? new Date();
      const day = at.toISOString().slice(0, 10);
      const { metrics, errors } = await fetchPublicMetrics(day, deps.fetchImpl);
      // Repository traffic is maintainer data, like the install pings: only the operator's pane records it.
      const traffic = deps.githubTrafficToken && owners.has(OPERATOR) ? await fetchRepoTraffic(day, deps.githubTrafficToken, deps.fetchImpl) : { metrics: [], errors: [] };
      if (errors.length || traffic.errors.length) deps.log.warn({ errors: [...errors, ...traffic.errors] }, "Marketing Copilot metrics: some sources failed");
      // Opt-in telemetry's daily active event: installations active in the last 7 days, the project's own excluded.
      const active = await readFile(deps.installPingsPath ?? INSTALL_PINGS_PATH, "utf8")
        .then((log): MarketingMetric[] => [{ day, source: "INSTALLS", key: "active_7d", value: summarizeInstallPings(log, at.getTime()).summary.active7d }], () => []);
      for (const [owner, pane] of owners) {
        await deps.service.recordMetrics(owner, owner === OPERATOR ? [...metrics, ...active, ...traffic.metrics] : metrics);
        await deps.service.metricsDigest(owner, pane);
      }
      return { owners: owners.size, metrics: metrics.length };
    } finally {
      running = false;
    }
  }
  return {
    tick,
    start() {
      first = setTimeout(() => void tick().catch((error) => deps.log.warn({ err: error }, "Marketing Copilot metrics tick failed")), deps.firstDelayMs ?? 120_000);
      first.unref();
      timer = setInterval(() => void tick().catch((error) => deps.log.warn({ err: error }, "Marketing Copilot metrics tick failed")), deps.intervalMs ?? DEFAULT_INTERVAL_MS);
      timer.unref();
    },
    stop() {
      if (first) clearTimeout(first);
      if (timer) clearInterval(timer);
      first = null;
      timer = null;
    }
  };
}
