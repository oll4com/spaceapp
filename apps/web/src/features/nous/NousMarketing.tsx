import { useCallback, useEffect, useState, type ReactNode } from "react";
import type { NousMarketingNumbers, NousMarketingPostRow, NousMarketingReport, NousSiteFunnel, NousSiteRow } from "@space/contracts";
import { api } from "../../api.js";
import { formatAppDateTime } from "../date-time-settings/date-time-settings.js";
import { DockButton, DockChips, DockSearch, DockState } from "../dock-kit/DockKit.js";
import { ChevronDown, ChevronRight, Megaphone } from "../ui-theme/app-icons.js";
import { uiText, useUiLanguage } from "../ui-language/ui-language.js";
import { Bar } from "./NousCrypto.js";

/**
 * Marketing (operator 5/11 10:42 BKK, nous_msg:25daa8b6ebbf, plan clipboard:netzt-nNvtBL): the overall marketing score and its trend on top,
 * each platform's score, the stats sources, then every Marketing Copilot post numbered; a post opens its numbers only when clicked.
 */
type T = (text: string, vars?: Record<string, string | number>) => string;
const POLL_MS = 60_000;
export const CHANNEL_LABELS: Record<string, string> = { X: "X", LINKEDIN: "LinkedIn", REDDIT: "Reddit", HACKER_NEWS: "Hacker News", PRODUCT_HUNT: "Product Hunt",
  DEVTO: "dev.to", BLOG: "Blog", YOUTUBE: "YouTube", GITHUB: "GitHub" };
const STATUS: Record<string, [string, string]> = { PUBLISHED: ["Published", "approved"], FAILED: ["Failed", "rejected"], APPROVED: ["Held (approved, not yet out)", "in_progress"],
  PUBLISHING: ["Publishing", "applied"] };
const channelLabel = (channel: string) => CHANNEL_LABELS[channel] ?? channel;
const signed = (value: number | null) => (value === null ? "–" : `${value > 0 ? "+" : value < 0 ? "−" : ""}${Math.abs(value)}`);
const count = (value: number | null) => (value === null ? "–" : value.toLocaleString());

export function NousMarketing({ active }: { active: boolean }) {
  const language = useUiLanguage();
  const t: T = (text, vars) => uiText(language, text, vars);
  const [report, setReport] = useState<NousMarketingReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [channel, setChannel] = useState("all");
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const load = useCallback(async () => {
    try { setReport((await api.nousMarketingReport()).report); setError(null); } catch (failure) { setError(failure instanceof Error && failure.message ? failure.message : "The marketing stats could not be loaded."); }
  }, []);
  useEffect(() => {
    if (!active) return;
    void load();
    const timer = window.setInterval(() => void load(), POLL_MS);
    return () => window.clearInterval(timer);
  }, [active, load]);

  if (error && !report) return <div className="nous-decisions nous-programs"><p role="alert">{t(error)}</p><DockButton onClick={() => void load()}>{t("Retry")}</DockButton></div>;
  if (!report) return <div className="nous-decisions nous-programs"><DockState kind="loading" title={t("Loading the marketing stats")} /></div>;
  if (!report.posts.length) return <div className="nous-decisions nous-programs"><DockState kind="empty" icon={Megaphone} title={t("No marketing posts yet")}
    detail={t("This page lists every post the Marketing Copilot publishes, with its numbers and score.")} /></div>;
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const shown = report.posts.filter((row) => (channel === "all" || row.channel === channel)
    && words.every((word) => [`#${row.number}`, row.title ?? "", row.target ?? "", row.url ?? "", channelLabel(row.channel)].some((field) => field.toLowerCase().includes(word))));
  const toggle = (id: string) => setOpen((current) => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  const { totals } = report;
  const tile = (label: string, value: string, tone = "") => <li className={tone}><span>{t(label)}</span><strong>{value}</strong></li>;
  return (
    <div className="nous-decisions nous-programs nous-report" data-sensitive-masked="manual">
      <ul className="nous-marketing-tiles" aria-label={t("Marketing performance")}>
        {tile("Marketing score", report.score === null ? "–" : `${report.score}/100`, "is-main")}
        {tile("7 days", signed(report.trend7), report.trend7 !== null && report.trend7 < 0 ? "is-down" : "")}
        {tile("30 days", signed(report.trend30), report.trend30 !== null && report.trend30 < 0 ? "is-down" : "")}
        {tile("Published", count(totals.published))}
        {tile("Failed", count(totals.failed), totals.failed ? "is-down" : "")}
        {tile("No reach", count(totals.zeroReach), totals.zeroReach ? "is-down" : "")}
        {tile("Not measured", count(totals.published - totals.measured))}
        {tile("Days without a result (7)", count(report.daysWithoutResult), report.daysWithoutResult > 3 ? "is-down" : "")}
      </ul>
      <p className="nous-programs-total">{t("Posts score {posts} · outcomes score {outcomes} (stars, downloads, installs, visitors) · updated {date}",
        { posts: report.postsScore ?? "–", outcomes: report.outcomesScore ?? "–", date: formatAppDateTime(report.generatedAt) })}</p>
      <section className="nous-report-funnel" aria-label={t("Score by platform")}>
        <h3>{t("Score by platform (last 30 days)")}</h3>
        {report.platforms.map((platform) => (
          <Bar key={platform.channel} label={channelLabel(platform.channel)} value={platform.score ?? 0} base={100}
            note={t("{posts} posts · {views} views · {replies} replies", { posts: platform.posts, views: count(platform.views), replies: platform.replies })} />
        ))}
      </section>
      <details className="nous-report-section">
        <summary>{t("Platforms in numbers")} <span>{report.platforms.length}</span></summary>
        <div className="nous-report-table"><table>
          <thead><tr>{["Platform", "Posts", "Published", "Failed", "Views", "Replies", "Messages", "Likes", "Clicks", "Followers", "Visits", "Score"].map((label) => <th key={label} scope="col">{t(label)}</th>)}</tr></thead>
          <tbody>{report.platforms.map((platform) => (
            <tr key={platform.channel}><th scope="row">{channelLabel(platform.channel)}</th>{[platform.posts, platform.published, platform.failed, platform.views, platform.replies, platform.messages,
              platform.likes, platform.clicks, platform.followers, platform.visits, platform.score].map((value, index) => <td key={index}>{count(value)}</td>)}</tr>
          ))}</tbody>
        </table></div>
      </details>
      <details className="nous-report-section">
        <summary>{t("Stats sources")} <span>{report.sources.filter((source) => source.connected).length}/{report.sources.length}</span></summary>
        <ul className="nous-report-notes">{report.sources.map((source) => (
          <li key={source.id}><b>{source.label}</b> <span className={`nous-program-status is-${source.connected ? "approved" : "rejected"}`}>{t(source.connected ? "Connected" : "Not connected")}</span>
            {" "}{source.detail}{Object.keys(source.values).length ? <> <small>{Object.entries(source.values).map(([key, value]) => `${key} ${value.toLocaleString()}`).join(" · ")}{source.day ? ` (${source.day})` : ""}</small></> : null}</li>
        ))}</ul>
      </details>
      {report.site ? <SiteFunnel site={report.site} t={t} /> : null}
      <DockChips label={t("Show posts")} value={channel} onChange={setChannel} options={[
        { id: "all", label: t("All"), count: report.posts.length },
        ...report.platforms.map((platform) => ({ id: platform.channel, label: channelLabel(platform.channel), count: platform.posts }))
      ]} />
      <div className="nous-programs-tools"><DockSearch value={query} onChange={setQuery} label={t("Search posts")} /></div>
      {shown.length ? <ul className="nous-report-rows">
        {shown.map((row) => <PostRow key={row.id} row={row} expanded={open.has(row.id)} onToggle={() => toggle(row.id)} t={t} />)}
      </ul> : <p className="nous-programs-none">{t("No post matches.")}</p>}
    </div>
  );
}

/** spaceapp.dev's own cookie-free page views (plan clipboard:hGoTZ_XwCuXn): the homepage's sections in the order met, then every page, origin and next step. */
function SiteFunnel({ site, t }: { site: NousSiteFunnel; t: T }) {
  const homeViews = site.pages.find((page) => page.key === "/")?.views ?? 0;
  const kinds = (groups: Array<[string, NousSiteRow[]]>) => groups.flatMap(([kind, rows]) => rows.map((row) => (
    <tr key={`${kind}:${row.key}`}><th scope="row">{t(kind)}</th><td>{row.key}</td><td>{count(row.views)}</td></tr>)));
  const table = (summary: string, total: number, head: string[], body: ReactNode) => (
    <details className="nous-report-section">
      <summary>{t(summary)} <span>{total}</span></summary>
      <div className="nous-report-table"><table>
        <thead><tr>{head.map((label) => <th key={label} scope="col">{t(label)}</th>)}</tr></thead>
        <tbody>{body}</tbody>
      </table></div>
    </details>
  );
  return (
    <>
      <section className="nous-report-funnel" aria-label={t("Site funnel (spaceapp.dev)")}>
        <h3>{t("Site funnel (spaceapp.dev)")}</h3>
        <p className="nous-programs-total">{t("{views} views since {since} · {internal} of our own left out · updated {date}", { views: site.views, since: formatAppDateTime(site.since),
          internal: site.internal, date: site.updatedAt ? formatAppDateTime(site.updatedAt) : "–" })}</p>
        {site.sections.map((section) => (
          <Bar key={section.id} label={section.id} value={section.reached} base={homeViews}
            note={t("{seconds}s median · {exits} left here · {clicks} clicks", { seconds: section.medianSeconds ?? "–", exits: section.exits, clicks: section.clicks })} />
        ))}
      </section>
      {table("Site pages", site.pages.length, ["Page", "Views", "Median seconds", "Median depth %", "Left the site"], site.pages.map((page) => (
        <tr key={page.key}><th scope="row">{page.key}</th>{[page.views, page.medianSeconds, page.medianDepth, page.leftSite].map((value, index) => <td key={index}>{count(value)}</td>)}</tr>)))}
      {table("Where visitors came from", site.referrers.length + site.sources.length + site.countries.length + site.screens.length, ["Kind", "Name", "Views"],
        kinds([["Site", site.referrers], ["Source", site.sources], ["Country", site.countries], ["Screen", site.screens]]))}
      {table("What visitors did next", site.next.length + site.actions.length, ["Kind", "Name", "Views"], kinds([["Next page", site.next], ["Action", site.actions]]))}
    </>
  );
}

function PostRow({ row, expanded, onToggle, t }: { row: NousMarketingPostRow; expanded: boolean; onToggle(): void; t: T }) {
  const bodyId = `nous-marketing-${row.id.replace(/[^A-Za-z0-9_-]/g, "")}`;
  const [status, tone] = STATUS[row.status] ?? [row.status, "draft"];
  const fact = (label: string, value: ReactNode) => (value !== null && value !== "" ? <><dt>{t(label)}</dt><dd>{value}</dd></> : null);
  const numbers = (entry: NousMarketingNumbers) => `${t("views")} ${count(entry.views)} · ${t("replies")} ${entry.replies} · ${t("likes")} ${entry.likes}`
    + `${entry.messages ? ` · ${t("messages")} ${entry.messages}` : ""}${entry.clicks ? ` · ${t("clicks")} ${entry.clicks}` : ""}`;
  return (
    <li className={`nous-program${expanded ? " is-open" : ""}`}>
      <button type="button" className="nous-program-head" aria-expanded={expanded} aria-controls={bodyId} onClick={onToggle}>
        <span className="nous-program-chevron" aria-hidden="true">{expanded ? <ChevronDown /> : <ChevronRight />}</span>
        <span className="nous-program-name"><b className="nous-report-id">#{row.number}</b> {row.title ?? row.target ?? row.id}<small>{channelLabel(row.channel)} · {formatAppDateTime(row.at)}</small></span>
        <span className={`nous-program-status is-${tone}`}>{t(status)}</span>
        <span className="nous-program-next">{row.score === null ? t("not measured") : t("score {score}", { score: row.score })}</span>
        <span className="nous-program-benefit-count">{numbers(row)}</span>
      </button>
      {expanded ? (
        <div id={bodyId} className="nous-program-body">
          <dl className="nous-goal-facts">
            {fact("Platform", channelLabel(row.channel))}{fact("Where", row.target)}
            {fact("Link", row.url ? <a href={row.url} target="_blank" rel="noreferrer noopener">{row.url}</a> : null)}
            {fact("Views", count(row.views))}{fact("Replies", row.replies)}{fact("Messages", row.messages)}{fact("Likes", row.likes)}{fact("Clicks", row.clicks)}{fact("Followers", row.followers)}
            {fact("Score", row.score === null ? t("not measured") : `${row.score}/100`)}
            {fact("Measured", row.measuredAt ? formatAppDateTime(row.measuredAt) : t("never"))}
            {fact("As read", Object.keys(row.raw).length ? Object.entries(row.raw).map(([key, value]) => `${key.replace(/_/g, " ")} ${value}`).join(" · ") : null)}
            {fact("Failure", row.failure)}
          </dl>
        </div>
      ) : null}
    </li>
  );
}
