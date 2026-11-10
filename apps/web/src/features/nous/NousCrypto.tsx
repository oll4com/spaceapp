import { useCallback, useEffect, useState } from "react";
import type { NousCryptoReport, NousCryptoRow, NousCryptoVerdict } from "@space/contracts";
import { api } from "../../api.js";
import { formatAppDateTime } from "../date-time-settings/date-time-settings.js";
import { DockButton, DockChips, DockSearch, DockState } from "../dock-kit/DockKit.js";
import { ChevronDown, ChevronRight, TrendingUp } from "../ui-theme/app-icons.js";
import { uiText, useUiLanguage } from "../ui-language/ui-language.js";

/**
 * Crypto (operator 3/11 22:33 BKK, nous_msg:e734994004dd): every method the crypto team tested, from its final table (the draft until
 * final-table.md exists). Counts and reasons on top; a method opens its registry facts and evidence only when clicked (operator rule 3/11).
 */
type T = (text: string, vars?: Record<string, string | number>) => string;
type Filter = "all" | "second" | NousCryptoVerdict;
const POLL_MS = 60_000;
export const VERDICTS: Record<NousCryptoVerdict, string> = { PASS: "Positive (pass ≥70%)", FAIL: "Failed", SKIP: "Skipped (not tested)", INSUFFICIENT: "Insufficient data",
  RESEARCH: "Research only", PENDING: "Pending", OTHER: "Other" };
const TONES: Record<NousCryptoVerdict, string> = { PASS: "approved", FAIL: "rejected", SKIP: "rejected", INSUFFICIENT: "applied", RESEARCH: "draft", PENDING: "in_progress", OTHER: "draft" };
const ORDER: NousCryptoVerdict[] = ["PASS", "PENDING", "FAIL", "SKIP", "INSUFFICIENT", "RESEARCH", "OTHER"];
const percent = (part: number, whole: number) => (whole ? `${(Math.round((part / whole) * 1000) / 10).toLocaleString()}%` : "–");
/** Days from the registry's hours ("2.5 d"); null when it states no hours. */
// Under a day in hours: "0 d" would read like a method that never ran.
export const daysRun = (hours: number | null) => (hours === null ? null : hours > 0 && hours < 24 ? `${hours.toLocaleString()} h` : `${(Math.round((hours / 24) * 10) / 10).toLocaleString()} d`);

export function NousCrypto({ active }: { active: boolean }) {
  const language = useUiLanguage();
  const t: T = (text, vars) => uiText(language, text, vars);
  const [report, setReport] = useState<NousCryptoReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [reason, setReason] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const load = useCallback(async () => {
    try { setReport((await api.nousCryptoReport()).report); setError(null); } catch (failure) { setError(failure instanceof Error && failure.message ? failure.message : "The crypto table could not be loaded."); }
  }, []);
  useEffect(() => {
    if (!active) return;
    void load();
    const timer = window.setInterval(() => void load(), POLL_MS);
    return () => window.clearInterval(timer);
  }, [active, load]);

  if (error && !report) return <div className="nous-decisions nous-programs"><p role="alert">{t(error)}</p><DockButton onClick={() => void load()}>{t("Retry")}</DockButton></div>;
  if (!report) return <div className="nous-decisions nous-programs"><DockState kind="loading" title={t("Loading the crypto table")} /></div>;
  if (!report.source || !report.rows.length) return <div className="nous-decisions nous-programs"><DockState kind="empty" icon={TrendingUp} title={t("No crypto table yet")}
    detail={t("This page reads the crypto team's final table (nous/crypto/final-table.md, or its draft) when it exists.")} /></div>;
  const total = report.rows.length;
  const retests = report.rows.filter((row) => row.retestOf);
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const matching = report.rows.filter((row) => words.every((word) => [row.id, row.method, row.category, row.registry?.where ?? ""].some((field) => field.toLowerCase().includes(word))));
  const test = (id: Filter) => (row: NousCryptoRow) => id === "all" || (id === "second" ? Boolean(row.retestOf || row.retests.length) : row.verdict === id);
  const shown = matching.filter(test(filter)).filter((row) => !reason || row.reasons.includes(reason));
  const toggle = (id: string) => setOpen((current) => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  const rejected = report.verdicts.FAIL + report.verdicts.SKIP;
  return (
    <div className="nous-decisions nous-programs nous-report" data-sensitive-masked="manual">
      <p className="nous-programs-total">{t(report.source.final ? "Final table" : "Draft of the final table")}: <strong>{report.source.title}</strong> · {t("file updated {date}", { date: formatAppDateTime(report.source.modifiedAt) })}
        {report.source.final ? null : <> · {t("the final table replaces it here by itself")}</>}</p>
      <section className="nous-report-funnel" aria-label={t("Methods by result")}>
        <h3>{t("{rows} rows: {methods} methods and {retests} second checks", { rows: total, methods: total - retests.length, retests: retests.length })}</h3>
        {ORDER.filter((verdict) => report.verdicts[verdict] || verdict !== "OTHER").map((verdict) => (
          <Bar key={verdict} label={t(VERDICTS[verdict])} value={report.verdicts[verdict]} base={total} note={percent(report.verdicts[verdict], total)} />
        ))}
        <Bar label={t("Passed to a second check (-n2)")} value={retests.length} base={total} note={percent(retests.length, total)} />
      </section>
      <details className="nous-report-section">
        <summary>{t("Why methods failed or were skipped")} <span>{rejected}</span></summary>
        <p className="nous-program-source">{t("Grouped by the words of each row's stated reason; a row can name more than one. Click a reason to list its methods.")}</p>
        <ul className="nous-report-reasons">
          {report.reasons.map((entry) => (
            <li key={entry.reason}><button type="button" aria-pressed={reason === entry.reason} onClick={() => setReason((current) => (current === entry.reason ? null : entry.reason))}>
              <span>{t(entry.reason)}</span><strong>{entry.ids.length}</strong><small>{percent(entry.ids.length, rejected)}</small></button></li>
          ))}
        </ul>
      </details>
      <details className="nous-report-section">
        <summary>{t("By category")} <span>{report.categories.length}</span></summary>
        <div className="nous-report-table"><table>
          <thead><tr><th scope="col">{t("Category")}</th><th scope="col">{t("Rows")}</th>{ORDER.filter((verdict) => verdict !== "OTHER").map((verdict) => <th key={verdict} scope="col">{t(VERDICTS[verdict])}</th>)}</tr></thead>
          <tbody>{report.categories.map((row) => (
            <tr key={row.category}><th scope="row">{row.category}</th><td>{row.total}</td>{ORDER.filter((verdict) => verdict !== "OTHER").map((verdict) => <td key={verdict}>{row.verdicts[verdict] ?? 0}</td>)}</tr>
          ))}</tbody>
        </table></div>
      </details>
      {report.notes.length ? <details className="nous-report-section">
        <summary>{t("How the table reads (its own notes)")}</summary>
        <ul className="nous-report-notes">{report.notes.map((note, index) => <li key={index}>{note}</li>)}</ul>
      </details> : null}
      <DockChips label={t("Show methods")} value={filter} onChange={setFilter} options={[
        { id: "all" as const, label: t("All"), count: matching.length },
        ...ORDER.filter((verdict) => report.verdicts[verdict]).map((verdict) => ({ id: verdict, label: t(VERDICTS[verdict]), count: matching.filter(test(verdict)).length })),
        { id: "second" as const, label: t("Second check"), count: matching.filter(test("second")).length }
      ]} />
      <div className="nous-programs-tools">
        <DockSearch value={query} onChange={setQuery} label={t("Search methods")} />
        {reason ? <DockButton onClick={() => setReason(null)}>{t("Reason: {reason} ×", { reason: t(reason) })}</DockButton> : null}
      </div>
      {shown.length ? <ul className="nous-report-rows">
        {shown.map((row) => <MethodRow key={row.id} row={row} expanded={open.has(row.id)} onToggle={() => toggle(row.id)} t={t} />)}
      </ul> : <p className="nous-programs-none">{t("No method matches.")}</p>}
    </div>
  );
}

export function Bar({ label, value, base, note }: { label: string; value: number; base: number; note?: string }) {
  return (
    <div className="nous-report-bar" title={`${label}: ${value.toLocaleString()}${note ? ` (${note})` : ""}`}>
      <span className="nous-report-bar-label">{label}</span>
      <span className="nous-report-bar-track" aria-hidden="true"><span style={{ width: `${base ? Math.max(value ? 0.6 : 0, (value / base) * 100) : 0}%` }} /></span>
      <strong>{value.toLocaleString()}</strong>{note ? <small>{note}</small> : null}
    </div>
  );
}

function MethodRow({ row, expanded, onToggle, t }: { row: NousCryptoRow; expanded: boolean; onToggle(): void; t: T }) {
  const bodyId = `nous-crypto-${row.id.replace(/[^A-Za-z0-9_-]/g, "")}`;
  const registry = row.registry ?? {};
  const field = (name: string) => Object.entries(registry).find(([key]) => key.toLowerCase() === name)?.[1] || null;
  const days = daysRun(row.hours);
  const fact = (label: string, value: string | null | undefined) => (value ? <><dt>{t(label)}</dt><dd>{value}</dd></> : null);
  return (
    <li className={`nous-program${expanded ? " is-open" : ""}`}>
      <button type="button" className="nous-program-head" aria-expanded={expanded} aria-controls={bodyId} onClick={onToggle}>
        <span className="nous-program-chevron" aria-hidden="true">{expanded ? <ChevronDown /> : <ChevronRight />}</span>
        <span className="nous-program-name"><b className="nous-report-id">{row.id}</b> {row.method}<small>{row.category}</small></span>
        <span className={`nous-program-status is-${TONES[row.verdict]}`}>{t(VERDICTS[row.verdict])}</span>
        {row.retests.length ? <span className="nous-program-benefit-count">{t("second check {ids}", { ids: row.retests.join(", ") })}</span> : null}
        {row.retestOf ? <span className="nous-program-benefit-count">{t("second check of {id}", { id: row.retestOf })}</span> : null}
        {days ? <span className="nous-program-next">{t("{days} run", { days })}</span> : null}
      </button>
      {expanded ? (
        <div id={bodyId} className="nous-program-body">
          <dl className="nous-goal-facts">
            {fact("Result", row.verdictText)}{fact("Success rate / sample", row.success)}{fact("Expected per month", row.monthly)}{fact("Capital", row.capital)}{fact("Risk", row.risk)}
            {fact("Where it ran", field("where"))}{fact("Test mode", field("test mode"))}{fact("Started", field("started"))}
            {fact("Hours logged", field("h logged") ? `${field("h logged")}${days ? ` (${days})` : ""}` : null)}
            {fact("Registry status", field("status"))}{fact("Owner", field("owner"))}{fact("Evidence", field("evidence"))}
            {row.reasons.length ? fact("Reason group", row.reasons.map((entry) => t(entry)).join(" · ")) : null}
            {fact("Source", row.sourceText)}
          </dl>
          {row.sources.length ? <><h4>{t("Source files")} <span>{row.sources.length}</span></h4>
            <ul className="nous-report-notes">{row.sources.map((source, index) => <li key={index}><b>{source.label}</b> <code>{source.path}{source.line ? `:${source.line}` : ""}</code></li>)}</ul></> : null}
        </div>
      ) : null}
    </li>
  );
}
