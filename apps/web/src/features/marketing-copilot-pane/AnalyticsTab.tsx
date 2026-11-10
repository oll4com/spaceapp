import { useEffect, useState } from "react";
import { MARKETING_CHANNEL_LABELS, type MarketingMetric, type MarketingPost } from "@space/contracts";
import { api } from "../../api.js";
import { useUiLanguage, uiText } from "../ui-language/ui-language.js";
import { ExternalLink } from "../ui-theme/app-icons.js";

const SOURCE_LABEL: Record<string, string> = { GITHUB: "GitHub", NPM: "npm", INSTALLS: "Self-hosted", GITHUB_TRAFFIC: "GitHub traffic", GITHUB_REFERRERS: "Visits (14 days) from" };
const KEY_LABEL: Record<string, string> = {
  stars: "Stars", forks: "Forks", watchers: "Watchers", open_issues: "Open issues", open_prs: "Open pull requests", release_downloads: "Release downloads",
  downloads_day: "Downloads (last day)", downloads_week: "Downloads (last week)", active_7d: "Active installs (7 days)",
  views_14d: "Views (14 days)", visitors_14d: "Unique visitors (14 days)", clones_14d: "Clones (14 days)", cloners_14d: "Unique cloners (14 days)"
};
const DAY_MS = 86_400_000;

export interface MetricRow { source: string; key: string; latest: number; day: string; week: number | null; month: number | null; trend: MarketingMetric[] }

/** Each series' latest value and its change against the value 7 and 30 days earlier (null without one). */
export function summarizeMetrics(metrics: MarketingMetric[]): MetricRow[] {
  const series = new Map<string, MarketingMetric[]>();
  for (const metric of metrics) series.set(`${metric.source}|${metric.key}`, [...(series.get(`${metric.source}|${metric.key}`) ?? []), metric]);
  return [...series.values()].map((points) => {
    const sorted = [...points].sort((a, b) => a.day.localeCompare(b.day));
    const latest = sorted.at(-1)!;
    const before = (days: number) => {
      const cutoff = new Date(Date.parse(latest.day) - days * DAY_MS).toISOString().slice(0, 10);
      const point = [...sorted].reverse().find((entry) => entry.day <= cutoff);
      return point ? latest.value - point.value : null;
    };
    return { source: latest.source, key: latest.key, latest: latest.value, day: latest.day, week: before(7), month: before(30), trend: sorted.slice(-12) };
  });
}
/** Growth is good for every number here except open issues and pull requests, whose change stays neutral. */
const UP_IS_GOOD = (key: string) => key !== "open_issues" && key !== "open_prs";
const compact = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });

/**
 * The stat tile's trend: the last 12 days as a 2px line in the de-emphasis hue with a 10% wash, the current day
 * as an accent end-dot ringed in the surface color; each day is a full-height hover target with its value.
 */
function Sparkline({ points, label }: { points: MarketingMetric[]; label: string }) {
  const language = useUiLanguage();
  const t = (text: string, vars?: Record<string, string | number>) => uiText(language, text, vars);
  if (points.length < 2) return null;
  const width = 120;
  const height = 32;
  const pad = 5;
  const values = points.map((point) => point.value);
  const min = Math.min(...values);
  const span = Math.max(...values) - min || 1;
  const x = (index: number) => pad + (index * (width - 2 * pad)) / (points.length - 1);
  const y = (value: number) => height - pad - ((value - min) * (height - 2 * pad)) / span;
  const line = points.map((point, index) => `${index ? "L" : "M"}${x(index).toFixed(1)},${y(point.value).toFixed(1)}`).join(" ");
  const last = points.length - 1;
  return (
    <svg className="mk-spark" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="xMinYMid meet" role="img" aria-label={t("{label}, last {count} days: {from} to {to}", { label, count: points.length, from: values[0]!, to: values[last]! })}>
      <path className="mk-spark-area" d={`${line} L${x(last).toFixed(1)},${height - pad} L${x(0).toFixed(1)},${height - pad} Z`} />
      <path className="mk-spark-line" d={line} />
      <circle className="mk-spark-dot" cx={x(last)} cy={y(values[last]!)} r={4} />
      {points.map((point, index) => (
        <rect key={point.day} className="mk-spark-hit" x={x(index) - (width - 2 * pad) / (points.length - 1) / 2} y={0} width={(width - 2 * pad) / (points.length - 1)} height={height}>
          <title>{`${point.day}: ${point.value}`}</title>
        </rect>
      ))}
    </svg>
  );
}

const change = (value: number | null) => value === null ? "—" : `${value >= 0 ? "+" : ""}${value}`;
const engagement = (post: MarketingPost) => Object.entries(post.metrics).map(([key, value]) => `${value} ${key.replace(/_/g, " ")}`).join(", ");

/** Analytics: the public numbers the daily job records (GitHub, npm) with their weekly and monthly change, and the posts that worked best. */
export function AnalyticsTab() {
  const language = useUiLanguage();
  const t = (text: string, vars?: Record<string, string | number>) => uiText(language, text, vars);
  const [data, setData] = useState<{ metrics: MarketingMetric[]; topPosts: MarketingPost[]; published: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    api.marketingAnalytics().then((response) => { if (!cancelled) setData(response); }, (caught: unknown) => { if (!cancelled) setError(caught instanceof Error ? caught.message : t("Analytics could not be loaded.")); });
    return () => { cancelled = true; };
  }, []);
  if (error) return <p className="jc-message" role="alert">{error}</p>;
  if (!data) return <p className="jc-muted jc-panel-loading" role="status">{t("Loading analytics…")}</p>;
  const rows = summarizeMetrics(data.metrics);
  // A source or metric Space has no label for is shown as the server named it.
  const sourceLabel = (source: string) => { const known = SOURCE_LABEL[source]; return known ? t(known) : source; };
  const metricLabel = (key: string) => { const known = KEY_LABEL[key]; return known ? t(known) : key; };
  return (
    <div className="mk-posts" role="tabpanel" id="jc-panel-analytics" aria-labelledby="jc-tab-analytics">
      {rows.length === 0 ? (
        <div className="jc-empty"><strong>{t("No numbers yet")}</strong><span>{t("Space records GitHub stars, forks, release downloads, npm downloads and active self-hosted installs once a day while a Marketing Copilot pane is open.")}</span></div>
      ) : (
        <ul className="mk-tiles" aria-label={t("Public numbers")}>
          {rows.map((row) => {
            const label = `${sourceLabel(row.source)} ${metricLabel(row.key).toLowerCase()}`;
            const tone = row.week === null || row.week === 0 || !UP_IS_GOOD(row.key) ? "flat" : row.week > 0 ? "up" : "down";
            return (
              <li key={`${row.source}|${row.key}`} className="mk-tile">
                <span className="mk-tile-label">{label}</span>
                <strong className="mk-tile-value" title={t("{value} on {day}", { value: row.latest, day: row.day })}>{compact.format(row.latest)}</strong>
                <span className={`mk-tile-delta ${tone}`}>{row.week === null ? t("No week to compare yet") : t("{change} in 7 days", { change: change(row.week) })}</span>
                <Sparkline points={row.trend} label={label} />
              </li>
            );
          })}
        </ul>
      )}
      {rows.length ? (
        <details className="mk-table-view">
          <summary>{t("Table view")}</summary>
        <table className="mk-metrics" aria-label={t("Public numbers table")}>
          <thead><tr><th scope="col">{t("Metric")}</th><th scope="col">{t("Now")}</th><th scope="col">{t("7 days")}</th><th scope="col">{t("30 days")}</th></tr></thead>
          <tbody>
            {rows.map((row) => (
              <tr key={`${row.source}|${row.key}`}>
                <th scope="row">{sourceLabel(row.source)} · {metricLabel(row.key)}</th>
                <td title={row.day}>{row.latest}</td><td>{change(row.week)}</td><td>{change(row.month)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        </details>
      ) : null}
      <section className="mk-group" aria-label={t("Top posts")}>
        <h4>{t("Top posts")} <span className="jc-muted">{t("{count} published", { count: data.published })}</span></h4>
        {data.topPosts.length === 0 ? <p className="jc-muted">{t("The copilot records each post's engagement a day and a week after it goes out.")}</p> : (
          <ul className="mk-post-list">
            {data.topPosts.map((post) => (
              <li key={post.id} className="mk-post">
                <div className="mk-post-head"><span className="jc-tag accent">{MARKETING_CHANNEL_LABELS[post.channel]}</span><span className="jc-muted">{engagement(post)}</span></div>
                <p className="mk-post-body">{post.title ?? post.body.slice(0, 200)}</p>
                {post.publishedUrl ? <a className="jc-button ghost" href={post.publishedUrl} target="_blank" rel="noreferrer noopener"><ExternalLink aria-hidden="true" /> {t("Open")}</a> : null}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
