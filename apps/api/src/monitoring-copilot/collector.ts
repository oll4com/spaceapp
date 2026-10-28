import {
  MONITORING_QUERY_MAX_SERIES, alertmanagerAlertSchema, monitoringCollectorUrlSchema,
  type AlertmanagerAlert, type MonitoringLogQuery, type MonitoringPromQuery, type MonitoringSeries
} from "@space/contracts";
import { SpaceConflictError } from "@space/runtime";

// The Monitoring Copilot's only network reach (plan clipboard:xkCJ9CeYZq4D): the collector's Alertmanager, Prometheus and Loki on
// the fleet's private bridge. Every URL is checked against the contract's 192.0.2.x shape again here, redirects are refused,
// answers are capped, and Loki answers with raw log lines ("streams") never leave this file except the guardian relay's own
// messages, which the watcher parses into its own fields.

const TIMEOUT_MS = 10_000;
const BODY_MAX = 5 * 1024 * 1024;
/** pve's guardian_notify.log as pve's promtail ships it. */
export const GUARDIAN_LOG_SELECTOR = '{host="pve",service_name="guardian"}';

export interface MonitoringTarget { job: string; instance: string; health: "up" | "down" | "unknown"; lastError: string; lastScrape: string | null; scrapeSeconds: number | null }
export interface GuardianLine { ns: string; line: string }

export interface MonitoringCollector {
  /** Alertmanager's active alerts that are neither silenced nor inhibited. */
  alerts(alertmanagerUrl: string): Promise<AlertmanagerAlert[]>;
  /** Guardian log lines after `afterNs` (exclusive), oldest first. */
  guardian(lokiUrl: string, afterNs: string, limit: number): Promise<GuardianLine[]>;
  promQuery(prometheusUrl: string, query: MonitoringPromQuery): Promise<{ resultType: string; series: MonitoringSeries[]; truncated: boolean }>;
  lokiQuery(lokiUrl: string, query: MonitoringLogQuery): Promise<{ resultType: string; series: MonitoringSeries[]; truncated: boolean }>;
  targets(prometheusUrl: string): Promise<MonitoringTarget[]>;
}

function base(url: string): string {
  // The stored setting already passed this; checking again keeps a test or a future caller from widening the reach.
  return monitoringCollectorUrlSchema.parse(url);
}

async function getJson(url: string): Promise<unknown> {
  const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(TIMEOUT_MS), headers: { accept: "application/json" } });
  const body = await response.text();
  if (body.length > BODY_MAX) throw new SpaceConflictError("The collector's answer is too large.");
  if (!response.ok) {
    // Prometheus and Loki explain a bad query in `error`; nothing else of the body is echoed.
    const detail = (() => { try { const parsed = JSON.parse(body) as { error?: unknown }; return typeof parsed.error === "string" ? parsed.error.slice(0, 300) : ""; } catch { return ""; } })();
    throw new SpaceConflictError(`The collector answered HTTP ${response.status}${detail ? `: ${detail}` : ""}.`);
  }
  try { return JSON.parse(body); } catch { throw new SpaceConflictError("The collector's answer is not JSON."); }
}

const asRecord = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const stringLabels = (value: unknown): Record<string, string> =>
  Object.fromEntries(Object.entries(asRecord(value)).filter(([key, entry]) => typeof entry === "string" && /^[A-Za-z_][A-Za-z0-9_]{0,99}$/.test(key)).slice(0, 30)
    .map(([key, entry]) => [key, (entry as string).slice(0, 300)]));

/** Prometheus-style `data` (vector, matrix or scalar) as series, at most MONITORING_QUERY_MAX_SERIES of them. */
export function seriesOf(data: unknown): { resultType: string; series: MonitoringSeries[]; truncated: boolean } {
  const record = asRecord(data);
  const resultType = typeof record.resultType === "string" ? record.resultType : "unknown";
  if (resultType === "streams") throw new SpaceConflictError("Log lines are not returned: use a LogQL metric query (count_over_time, rate, ...).");
  if (resultType === "scalar" || resultType === "string") {
    const value = Array.isArray(record.result) ? record.result : [];
    return { resultType, series: [{ labels: {}, points: [[Number(value[0]) || 0, String(value[1] ?? "")]] }], truncated: false };
  }
  const result = Array.isArray(record.result) ? record.result : [];
  const series = result.slice(0, MONITORING_QUERY_MAX_SERIES).map((entry) => {
    const item = asRecord(entry);
    const raw = Array.isArray(item.values) ? item.values : Array.isArray(item.value) ? [item.value] : [];
    const points = raw.filter((point): point is [unknown, unknown] => Array.isArray(point) && point.length === 2)
      .map(([at, value]) => [Number(at) || 0, String(value).slice(0, 40)] as [number, string]);
    return { labels: stringLabels(item.metric), points };
  });
  return { resultType, series, truncated: result.length > MONITORING_QUERY_MAX_SERIES };
}

function rangeParams(range: { minutes: number; stepSeconds: number } | undefined, now: number): URLSearchParams {
  const params = new URLSearchParams();
  if (!range) return params;
  const end = Math.floor(now / 1000);
  params.set("start", String(end - range.minutes * 60));
  params.set("end", String(end));
  params.set("step", String(range.stepSeconds));
  return params;
}

export function createMonitoringCollector(now: () => number = Date.now): MonitoringCollector {
  return {
    async alerts(alertmanagerUrl) {
      const body = await getJson(`${base(alertmanagerUrl)}/api/v2/alerts?active=true&silenced=false&inhibited=false`);
      if (!Array.isArray(body)) throw new SpaceConflictError("Alertmanager did not answer a list of alerts.");
      return body.slice(0, 2000).flatMap((entry) => {
        const parsed = alertmanagerAlertSchema.safeParse(entry);
        return parsed.success ? [parsed.data] : [];
      });
    },
    async guardian(lokiUrl, afterNs, limit) {
      const params = new URLSearchParams({ query: GUARDIAN_LOG_SELECTOR, start: (BigInt(afterNs) + 1n).toString(), end: `${now()}000000`, limit: String(limit), direction: "forward" });
      const data = asRecord(asRecord(await getJson(`${base(lokiUrl)}/loki/api/v1/query_range?${params}`)).data);
      if (data.resultType !== "streams") return [];
      const lines: GuardianLine[] = [];
      for (const stream of Array.isArray(data.result) ? data.result : []) {
        for (const value of Array.isArray(asRecord(stream).values) ? asRecord(stream).values as unknown[] : []) {
          if (Array.isArray(value) && typeof value[0] === "string" && /^\d{1,20}$/.test(value[0]) && typeof value[1] === "string") lines.push({ ns: value[0], line: value[1].slice(0, 2000) });
        }
      }
      return lines.sort((left, right) => (BigInt(left.ns) < BigInt(right.ns) ? -1 : BigInt(left.ns) > BigInt(right.ns) ? 1 : 0));
    },
    async promQuery(prometheusUrl, query) {
      const params = rangeParams(query.range, now());
      params.set("query", query.query);
      const body = asRecord(await getJson(`${base(prometheusUrl)}/api/v1/${query.range ? "query_range" : "query"}?${params}`));
      return seriesOf(body.data);
    },
    async lokiQuery(lokiUrl, query) {
      const params = rangeParams(query.range, now());
      params.set("query", query.query);
      params.set("limit", String(MONITORING_QUERY_MAX_SERIES));
      if (!query.range) params.set("time", `${now()}000000`);
      const body = asRecord(await getJson(`${base(lokiUrl)}/loki/api/v1/${query.range ? "query_range" : "query"}?${params}`));
      return seriesOf(body.data);
    },
    async targets(prometheusUrl) {
      const data = asRecord(asRecord(await getJson(`${base(prometheusUrl)}/api/v1/targets?state=active`)).data);
      const active = Array.isArray(data.activeTargets) ? data.activeTargets : [];
      return active.slice(0, 1000).map((entry) => {
        const item = asRecord(entry);
        const labels = stringLabels(item.labels);
        const health = item.health === "up" || item.health === "down" ? item.health : "unknown";
        return { job: labels.job ?? "", instance: labels.instance ?? "", health, lastError: typeof item.lastError === "string" ? item.lastError.slice(0, 200) : "",
          lastScrape: typeof item.lastScrape === "string" ? item.lastScrape : null, scrapeSeconds: typeof item.lastScrapeDuration === "number" ? item.lastScrapeDuration : null };
      });
    }
  };
}
