import { useCallback, useEffect, useMemo, useState } from "react";
import type { JobApplyEvent, NousJobApplicationRow, NousJobCompany, NousJobMail, NousJobReport } from "@space/contracts";
import { api } from "../../api.js";
import { formatAppDate, formatAppDateTime } from "../date-time-settings/date-time-settings.js";
import { DockButton, DockChips, DockSearch, DockState } from "../dock-kit/DockKit.js";
import { Briefcase, ChevronDown, ChevronRight, ExternalLink } from "../ui-theme/app-icons.js";
import { uiText, useUiLanguage } from "../ui-language/ui-language.js";

/**
 * Job applications (operator 3/11 22:33 BKK, nous_msg:e734994004dd): the funnel on top, every application below; a row opens its company's
 * mails and the copilot's events only when clicked (operator rule 3/11). Replies are per company (report.ts says why); stages are derived.
 */
type T = (text: string, vars?: Record<string, string | number>) => string;
type Filter = "sent" | "rejected" | "invited" | "process" | "noreply" | "notsent" | "all";
const PAGE = 100;
const POLL_MS = 300_000;
const SENT = new Set(["SUBMITTED", "VERIFIED"]);
const OUTCOMES: Record<NousJobCompany["outcome"], string> = { OFFER: "Offer", IN_PROCESS: "Test or interview open", INVITED: "Invited", REJECTED: "Rejected", NO_REPLY: "No reply" };
const STATUSES: Record<string, string> = { VERIFIED: "Confirmed", SUBMITTED: "Sent, not confirmed", FAILED: "Not sent (failed)", QUEUED: "Queued", FILLING: "Filling in", NEEDS_USER: "Needs you" };
const KINDS: Record<NousJobMail["kind"], string> = { REJECTION: "Rejection", TEST: "Test", INTERVIEW: "Interview", OFFER: "Offer", ACTION_NEEDED: "Action needed (no test or interview)" };
const percent = (part: number, whole: number) => (whole ? `${(Math.round((part / whole) * 1000) / 10).toLocaleString()}%` : "–");

export function NousJobs({ active }: { active: boolean }) {
  const language = useUiLanguage();
  const t: T = (text, vars) => uiText(language, text, vars);
  const [report, setReport] = useState<NousJobReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("sent");
  const [query, setQuery] = useState("");
  const [shown, setShown] = useState(PAGE);
  const [open, setOpen] = useState<string | null>(null);
  const load = useCallback(async () => {
    try { setReport((await api.nousJobReport()).report); setError(null); } catch (failure) { setError(failure instanceof Error && failure.message ? failure.message : "The applications could not be loaded."); }
  }, []);
  useEffect(() => {
    if (!active) return;
    void load();
    const timer = window.setInterval(() => void load(), POLL_MS);
    return () => window.clearInterval(timer);
  }, [active, load]);
  const companyOf = useMemo(() => new Map((report?.companies ?? []).flatMap((company) => company.applicationIds.map((id) => [id, company] as const))), [report]);
  const zone = report?.timeZone;
  const when = (iso: string | null | undefined) => (iso ? formatAppDateTime(iso, zone ? { timeZone: zone } : undefined) : "");
  // The chips follow the company's latest outcome (report.ts), so a company invited to a test and then rejected is Rejected, not Invited too (5/11).
  const outcomeOf = (row: NousJobApplicationRow) => companyOf.get(row.id)?.outcome;
  const tests: Record<Filter, (row: NousJobApplicationRow) => boolean> = {
    sent: (row) => SENT.has(row.status), all: () => true, notsent: (row) => !SENT.has(row.status),
    rejected: (row) => outcomeOf(row) === "REJECTED", invited: (row) => ["INVITED", "IN_PROCESS", "OFFER"].includes(outcomeOf(row) ?? ""),
    process: (row) => outcomeOf(row) === "IN_PROCESS", noreply: (row) => outcomeOf(row) === "NO_REPLY"
  };
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const matching = (report?.applications ?? []).filter((row) => {
    const outcome = outcomeOf(row);
    const fields = [row.company, row.role, row.platform, t(STATUSES[row.status] ?? row.status), outcome ? t(OUTCOMES[outcome]) : ""];
    return words.every((word) => fields.some((field) => field.toLowerCase().includes(word)));
  });
  const rows = matching.filter(tests[filter]);

  if (error && !report) return <div className="nous-decisions nous-programs"><p role="alert">{t(error)}</p><DockButton onClick={() => void load()}>{t("Retry")}</DockButton></div>;
  if (!report) return <div className="nous-decisions nous-programs"><DockState kind="loading" title={t("Loading the applications")} /></div>;
  if (!report.applications.length) return <div className="nous-decisions nous-programs"><DockState kind="empty" icon={Briefcase} title={t("No applications yet")} detail={t("The Job Copilot records every application here.")} /></div>;
  const { funnel } = report;
  return (
    <div className="nous-decisions nous-programs nous-report" data-sensitive-masked="manual">
      <p className="nous-programs-total">{t("{sent} applications sent to {companies} companies ({rows} rows in all)", { sent: funnel.applied.toLocaleString(), companies: funnel.companies.toLocaleString(), rows: funnel.rows.toLocaleString() })}
        {" · "}{t("read {date}", { date: when(report.generatedAt) })}</p>
      <section className="nous-report-funnel" aria-label={t("Funnel")}>
        <h3>{t("Applications")}</h3>
        <Bar label={t("Sent")} value={funnel.applied} base={funnel.applied} note={t("of {count} rows", { count: funnel.rows.toLocaleString() })} />
        <Bar label={t("Confirmed (verified)")} value={funnel.confirmed} base={funnel.applied} note={t("{percent} of sent", { percent: percent(funnel.confirmed, funnel.applied) })} />
        <h3>{t("Companies")} <span>{t("from their mails; stages derived")}</span></h3>
        <Bar label={t("Applied to")} value={funnel.companies} base={funnel.companies} />
        <Bar label={t("Rejected us")} value={funnel.rejected} base={funnel.companies} note={percent(funnel.rejected, funnel.companies)} />
        <Bar label={t("Invited to a test or interview")} value={funnel.invited} base={funnel.companies} note={percent(funnel.invited, funnel.companies)} />
        {funnel.passed.map((count, index) => (
          <Bar key={index} label={t("Passed stage {stage} (derived)", { stage: index + 1 })} value={count} base={funnel.companies}
            note={t("{percent} of companies · {share} of stage {stage}", { percent: percent(count, funnel.companies), share: percent(count, index ? funnel.passed[index - 1]! : funnel.invited), stage: index + 1 })} />
        ))}
        <Bar label={t("Offer")} value={funnel.offers} base={funnel.companies} note={percent(funnel.offers, funnel.companies)} />
        <Bar label={t("No reply yet")} value={funnel.noReply} base={funnel.companies} note={percent(funnel.noReply, funnel.companies)} />
      </section>
      <details className="nous-report-section">
        <summary>{t("Pending tests and interviews")} <span>{report.pending.length}</span></summary>
        {report.pending.length ? <ol className="nous-program-mails">{report.pending.map((mail) => (
          <li key={mail.id}><span className="nous-program-mail-when">{mail.deadline ? when(mail.deadline) : t("Deadline not stated")}{mail.deadline && Date.parse(mail.deadline) < Date.now() ? ` · ${t("deadline passed")}` : ""} · {t(KINDS[mail.kind])}</span>
            <span className="nous-program-mail-subject">{mail.company ?? t("No company we applied to")}: {mail.subject}</span>{mail.from ? <span className="nous-program-mail-who">{mail.from}</span> : null}</li>
        ))}</ol> : <p className="nous-goal-history-empty">{t("None open.")}</p>}
      </details>
      <details className="nous-report-section">
        <summary>{t("By platform")} <span>{report.platforms.length}</span></summary>
        <Table head={[t("Platform"), t("Sent"), t("Confirmed"), t("Companies"), t("Rejected us"), t("Invited")]}
          rows={report.platforms.map((row) => [row.platform, row.applied, `${row.confirmed} (${percent(row.confirmed, row.applied)})`, row.companies,
            `${row.rejected} (${percent(row.rejected, row.companies)})`, `${row.invited} (${percent(row.invited, row.companies)})`])} />
      </details>
      <details className="nous-report-section">
        <summary>{t("By week")} <span>{report.weeks.length}</span></summary>
        <Table head={[t("Week of"), t("Sent"), t("Confirmed"), t("Rejections"), t("Tests and interviews")]}
          rows={report.weeks.map((row) => [formatAppDate(`${row.week}T12:00:00Z`), row.applied, row.confirmed, row.rejections, row.invitations])} />
      </details>
      <details className="nous-report-section">
        <summary>{t("Not sent")} <span>{Object.values(report.notSent).reduce((sum, count) => sum + count, 0)}</span></summary>
        <Table head={[t("Status"), t("Rows")]} rows={Object.entries(report.notSent).map(([status, count]) => [t(STATUSES[status] ?? status), count])} />
      </details>
      {report.unmatched.length ? <details className="nous-report-section">
        <summary>{t("Mails naming no company we applied to")} <span>{report.unmatched.length}</span></summary>
        <Mails mails={report.unmatched} when={when} t={t} />
      </details> : null}
      <DockChips label={t("Show applications")} value={filter} onChange={(next) => { setFilter(next); setShown(PAGE); }} options={([
        ["sent", "Sent"], ["rejected", "Rejected"], ["invited", "Invited"], ["process", "Open test or interview"], ["noreply", "No reply"], ["notsent", "Not sent"], ["all", "All"]
      ] as Array<[Filter, string]>).map(([id, label]) => ({ id, label: t(label), count: matching.filter(tests[id]).length }))} />
      <div className="nous-programs-tools"><DockSearch value={query} onChange={(next) => { setQuery(next); setShown(PAGE); }} label={t("Search applications")} /></div>
      {rows.length ? <ul className="nous-report-rows">
        {rows.slice(0, shown).map((row) => <ApplicationRow key={row.id} row={row} company={companyOf.get(row.id) ?? null} expanded={open === row.id}
          onToggle={() => setOpen((current) => (current === row.id ? null : row.id))} when={when} t={t} />)}
      </ul> : <p className="nous-programs-none">{t("No application matches.")}</p>}
      {rows.length > shown ? <DockButton onClick={() => setShown((count) => count + PAGE)}>{t("Show {count} more of {left}", { count: Math.min(PAGE, rows.length - shown), left: rows.length - shown })}</DockButton> : null}
    </div>
  );
}

/** One funnel step: a single-hue bar against its group's first step, the number and its share beside it. */
function Bar({ label, value, base, note }: { label: string; value: number; base: number; note?: string }) {
  const width = base ? Math.max(value ? 0.6 : 0, (value / base) * 100) : 0;
  return (
    <div className="nous-report-bar" title={`${label}: ${value.toLocaleString()}${note ? ` (${note})` : ""}`}>
      <span className="nous-report-bar-label">{label}</span>
      <span className="nous-report-bar-track" aria-hidden="true"><span style={{ width: `${width}%` }} /></span>
      <strong>{value.toLocaleString()}</strong>{note ? <small>{note}</small> : null}
    </div>
  );
}

function Table({ head, rows }: { head: string[]; rows: Array<Array<string | number>> }) {
  return (
    <div className="nous-report-table"><table>
      <thead><tr>{head.map((cell) => <th key={cell} scope="col">{cell}</th>)}</tr></thead>
      <tbody>{rows.map((row, index) => <tr key={index}>{row.map((cell, at) => at ? <td key={at}>{typeof cell === "number" ? cell.toLocaleString() : cell}</td> : <th key={at} scope="row">{cell}</th>)}</tr>)}</tbody>
    </table></div>
  );
}

function Mails({ mails, when, t }: { mails: NousJobMail[]; when: (iso: string) => string; t: T }) {
  return (
    <ol className="nous-program-mails">
      {mails.map((mail) => (
        <li key={mail.id} className={`is-${mail.kind.toLowerCase()}`}>
          <span className="nous-program-mail-when">{when(mail.at)} · {t(KINDS[mail.kind])}{mail.deadline ? ` · ${t("deadline or start {date}", { date: when(mail.deadline) })}` : ""}{mail.open ? ` · ${t("open")}` : ""}</span>
          <span className="nous-program-mail-subject">{mail.subject || t("(no subject)")}</span>
          {mail.from || mail.account ? <span className="nous-program-mail-who">{[mail.from, mail.account].filter(Boolean).join(" → ")}</span> : null}
        </li>
      ))}
    </ol>
  );
}

function ApplicationRow({ row, company, expanded, onToggle, when, t }: { row: NousJobApplicationRow; company: NousJobCompany | null; expanded: boolean; onToggle(): void;
  when: (iso: string) => string; t: T }) {
  const bodyId = `nous-job-${row.id.replace(/[^A-Za-z0-9_-]/g, "")}`;
  const outcome = company?.outcome ?? null;
  const mails = company ? [...company.stages, ...company.rejections, ...company.offers, ...company.otherMails].sort((a, b) => a.at.localeCompare(b.at)) : [];
  return (
    <li className={`nous-program${expanded ? " is-open" : ""}`}>
      <button type="button" className="nous-program-head" aria-expanded={expanded} aria-controls={bodyId} onClick={onToggle}>
        <span className="nous-program-chevron" aria-hidden="true">{expanded ? <ChevronDown /> : <ChevronRight />}</span>
        <span className="nous-program-name">{row.company}<small>{row.role}</small></span>
        <span className={`nous-program-status is-${SENT.has(row.status) ? (row.status === "VERIFIED" ? "approved" : "applied") : "draft"}`}>{t(STATUSES[row.status] ?? row.status)}</span>
        {outcome && outcome !== "NO_REPLY" ? <span className={`nous-program-status is-${outcome === "REJECTED" ? "rejected" : outcome === "OFFER" ? "approved" : "in_progress"}`}>
          {t(OUTCOMES[outcome])}{company!.stages.length ? ` · ${t("{count} stages", { count: company!.stages.length })}` : ""}</span> : null}
        <span className="nous-program-next">{row.platform}{row.appliedAt ? ` · ${formatAppDate(row.appliedAt)}` : ""}</span>
      </button>
      {expanded ? (
        <div id={bodyId} className="nous-program-body">
          <dl className="nous-goal-facts">
            <dt>{t("Role")}</dt><dd>{row.role}</dd><dt>{t("Platform")}</dt><dd>{row.platform}</dd><dt>{t("Status")}</dt><dd>{t(STATUSES[row.status] ?? row.status)}</dd>
            {row.appliedAt ? <><dt>{t("Sent")}</dt><dd>{when(row.appliedAt)}</dd></> : null}<dt>{t("Added")}</dt><dd>{when(row.createdAt)}</dd>
            {company ? <><dt>{t("Applications to {company}", { company: company.name })}</dt><dd>{company.applicationIds.length}</dd></> : null}
          </dl>
          {/^https?:\/\//i.test(row.url) ? <a className="nous-program-link" href={row.url} target="_blank" rel="noopener noreferrer"><ExternalLink aria-hidden="true" />{t("Job posting")}</a> : null}
          <h4>{t("Mails from {company}", { company: company?.name ?? row.company })} <span>{mails.length}</span></h4>
          {mails.length ? <Mails mails={mails} when={when} t={t} /> : <p className="nous-goal-history-empty">{t("No mail recorded.")}</p>}
          {company && company.applicationIds.length > 1 && mails.length ? <small className="nous-program-source">{t("A company's mails rarely name the role, so they show under each of its applications.")}</small> : null}
          <CopilotEvents applicationId={row.id} when={when} t={t} />
        </div>
      ) : null}
    </li>
  );
}

/** The copilot's own record of the application (started, filled, sent, verified…), read when the row opens. */
function CopilotEvents({ applicationId, when, t }: { applicationId: string; when: (iso: string) => string; t: T }) {
  const [events, setEvents] = useState<JobApplyEvent[] | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    // shortcut: the route returns at most 500 events; an application has a few dozen. Page it with `since` if one ever has more.
    api.jobApplyEvents({ applicationId, limit: 500 }).then((result) => { if (live) setEvents(result.events); }, () => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [applicationId]);
  return (
    <>
      <h4>{t("Copilot events")} <span>{events?.length ?? ""}</span></h4>
      {failed ? <p className="nous-goal-history-empty">{t("The events could not be loaded.")}</p> : events === null ? <p className="nous-goal-history-empty">{t("Loading…")}</p>
        : events.length ? <ol className="nous-program-mails">{[...events].sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map((event) => (
          <li key={event.id}><span className="nous-program-mail-when">{when(event.createdAt)} · {event.type}</span><span className="nous-program-mail-who">{event.message}</span></li>
        ))}</ol> : <p className="nous-goal-history-empty">{t("No event recorded.")}</p>}
    </>
  );
}
