import { useCallback, useMemo, useState } from "react";
import { importedJobPostingUrl, isDeferredJobApplication, isImportedJobApplication, jobPostingFromUrl, JOB_APPLY_NO_CONFIRMATION_NOTE, JOB_APPLY_UNRECORDED_ROLE, type JobApplication, type JobApplicationStatus, type JobApplyDiscoveredPosting, type JobApplyDiscoverResult, type UiLanguage } from "@space/contracts";
import { api } from "../../api.js";
import { SpaceToggle } from "../ui-controls/SpaceToggle.js";
import { uiText, useUiLanguage } from "../ui-language/ui-language.js";
import { Compass, ExternalLink, Plus, RefreshCw } from "../ui-theme/app-icons.js";

export const STATUS_ORDER: JobApplicationStatus[] = ["NEEDS_USER", "FILLING", "QUEUED", "SUBMITTED", "VERIFIED", "FAILED"];
export const STATUS_LABEL: Record<JobApplicationStatus, string> = {
  QUEUED: "Queued", FILLING: "Filling", NEEDS_USER: "Needs you", SUBMITTED: "Submitted", VERIFIED: "Verified", FAILED: "Failed"
};
const SITE_LABEL: Record<JobApplication["ats"], string> = { linkedin: "LinkedIn", greenhouse: "Greenhouse", ashby: "Ashby", lever: "Lever", workday: "Workday", indeed: "Indeed", other: "Other" };

export function relativeTime(iso: string, now = Date.now(), language: UiLanguage = "en"): string {
  const minutes = Math.round((now - new Date(iso).getTime()) / 60_000);
  if (minutes < 1) return uiText(language, "just now");
  if (minutes < 60) return uiText(language, "{count} min ago", { count: minutes });
  const hours = Math.round(minutes / 60);
  if (hours < 48) return uiText(language, "{count} h ago", { count: hours });
  return new Date(iso).toLocaleDateString();
}

/** When the row happened: the applied date once sent (or attempted), otherwise its last change. */
export function applicationWhen(application: Pick<JobApplication, "status" | "appliedAt" | "updatedAt">, now = Date.now(), language: UiLanguage = "en"): { text: string; title: string } {
  if (application.appliedAt && (application.status === "SUBMITTED" || application.status === "VERIFIED" || application.status === "FAILED")) {
    const when = relativeTime(application.appliedAt, now, language);
    return { text: application.status === "FAILED" ? uiText(language, "Tried {when}", { when }) : uiText(language, "Applied {when}", { when }), title: application.appliedAt };
  }
  return { text: relativeTime(application.updatedAt, now, language), title: application.updatedAt };
}

/** Splits pasted text into unique posting URLs; everything that is not an http(s) URL is dropped. */
export function postingsFromText(text: string) {
  const seen = new Set<string>();
  const postings = [];
  for (const line of text.split(/[\s,]+/)) {
    const posting = jobPostingFromUrl(line);
    if (!posting || seen.has(posting.url)) continue;
    seen.add(posting.url);
    postings.push(posting);
  }
  return postings;
}

/** Public ATS board search: tokens are company slugs; results queue one by one or the top N at once. */
function DiscoverPanel({ paneId, onQueued }: { paneId: string; onQueued(): void }) {
  const language = useUiLanguage();
  const t = (text: string, vars?: Record<string, string | number>) => uiText(language, text, vars);
  const [tokens, setTokens] = useState("");
  const [query, setQuery] = useState("");
  const [remote, setRemote] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<JobApplyDiscoverResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [queuedUrls, setQueuedUrls] = useState<Set<string>>(new Set());

  async function search() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const tokenList = tokens.split(/[\s,]+/).map((token) => token.trim().toLowerCase()).filter(Boolean).slice(0, 40);
      setResult(await api.discoverJobApplyPostings(paneId, { query: query.trim() || undefined, tokens: tokenList, remote: remote || undefined, limit: 100 }));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("Search failed."));
    } finally {
      setBusy(false);
    }
  }

  async function queue(postings: JobApplyDiscoveredPosting[]) {
    const urls = postings.filter((posting) => !posting.tracked && !queuedUrls.has(posting.url)).map((posting) => posting.url);
    if (urls.length === 0 || busy) return;
    setBusy(true);
    try {
      await api.addJobApplyQueue(paneId, urls);
      setQueuedUrls((current) => new Set([...current, ...urls]));
      onQueued();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("Queueing failed."));
    } finally {
      setBusy(false);
    }
  }

  const fresh = result?.postings.filter((posting) => !posting.tracked && !queuedUrls.has(posting.url)) ?? [];
  const boardCount = result?.scanned.filter((entry) => !entry.error).length ?? 0;
  const resultSummary = result ? [
    t("{postings} from {boards}", {
      postings: result.postings.length === 1 ? t("1 posting") : t("{count} postings", { count: result.postings.length }),
      boards: boardCount === 1 ? t("1 board") : t("{count} boards", { count: boardCount })
    }),
    ...(result.scanned.some((entry) => entry.error) ? [result.scanned.filter((entry) => entry.error).map((entry) => `${entry.ats}/${entry.board}: ${entry.error}`).join(", ")] : []),
    ...(result.truncated ? [t("more available")] : [])
  ].join(" · ") : "";
  return (
    <div className="jc-discover">
      <form className="jc-discover-form" onSubmit={(event) => { event.preventDefault(); void search(); }}>
        <label className="jc-field"><span>{t("Board tokens (company slugs, comma separated)")}</span><input value={tokens} placeholder="acme, globex, initech" aria-label={t("Board tokens")} onChange={(event) => setTokens(event.target.value)} /></label>
        <div className="jc-form-grid">
          <label className="jc-field"><span>{t("Title contains")}</span><input value={query} placeholder="backend engineer" aria-label={t("Title contains")} onChange={(event) => setQuery(event.target.value)} /></label>
          <SpaceToggle compact label={t("Remote only")} checked={remote} onChange={setRemote} />
        </div>
        <div className="jc-actions">
          <button type="submit" className="jc-button primary" disabled={busy}><Compass aria-hidden="true" /> {busy ? t("Searching…") : t("Search boards")}</button>
          {fresh.length > 0 ? <button type="button" className="jc-button" disabled={busy} onClick={() => void queue(fresh.slice(0, 10))}>{t("Queue top {count}", { count: Math.min(10, fresh.length) })}</button> : null}
          <span className="jc-muted">{t("Remembered board tokens (SITE memories tagged board-token) are scanned too.")}</span>
        </div>
      </form>
      {error ? <p className="jc-message" role="alert">{error}</p> : null}
      {result ? (
        <>
          <p className="jc-muted">{resultSummary}</p>
          <ul className="jc-list jc-discover-list" aria-label={t("Discovered postings")}>
            {result.postings.map((posting) => {
              const done = posting.tracked || queuedUrls.has(posting.url);
              return (
                <li key={posting.url} className="jc-row">
                  <div className="jc-row-main"><strong>{posting.company}</strong><span>{posting.role}</span></div>
                  <div className="jc-row-meta">
                    <span className="jc-muted">{posting.ats}</span>
                    {posting.location ? <span className="jc-muted">{posting.location}</span> : null}
                    {posting.remote ? <span className="jc-tag">{t("remote")}</span> : null}
                    {posting.postedAt ? <span className="jc-muted" title={posting.postedAt}>{relativeTime(posting.postedAt, Date.now(), language)}</span> : null}
                    <a href={posting.url} target="_blank" rel="noopener noreferrer" className="jc-icon-button" title={t("Open posting")} aria-label={t("Open {company} posting", { company: posting.company })}><ExternalLink aria-hidden="true" /></a>
                    <button type="button" className="jc-button" disabled={busy || done} onClick={() => void queue([posting])}>{posting.tracked ? t("Tracked") : queuedUrls.has(posting.url) ? t("Queued") : t("Queue")}</button>
                  </div>
                </li>
              );
            })}
          </ul>
        </>
      ) : null}
    </div>
  );
}

export function QueueTab({ applications, campaignStartedAt = null, paneId, selectedId, onSelect, onCreated, onRefresh }: {
  applications: JobApplication[];
  /** The last "Reset and start over": Space rows created before it are archived history. */
  campaignStartedAt?: string | null;
  paneId: string;
  selectedId: string | null;
  onSelect(id: string | null): void;
  onCreated(application: JobApplication): void;
  onRefresh(): void;
}) {
  const language = useUiLanguage();
  const t = (text: string, vars?: Record<string, string | number>) => uiText(language, text, vars);
  const [filter, setFilter] = useState<JobApplicationStatus | "ALL">("ALL");
  // Rows imported from an earlier tracker are history Space did not send: they stay out of the counts unless asked for.
  // So are rows archived by a reset.
  const [source, setSource] = useState<"SPACE" | "IMPORTED" | "ARCHIVED" | "ALL">("SPACE");
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [csvOpen, setCsvOpen] = useState(false);
  const [discoverOpen, setDiscoverOpen] = useState(false);
  const [csv, setCsv] = useState("");
  const sourceOf = useCallback((application: JobApplication) => isImportedJobApplication(application) ? "IMPORTED"
    : campaignStartedAt && application.createdAt < campaignStartedAt ? "ARCHIVED" : "SPACE", [campaignStartedAt]);
  const importedCount = useMemo(() => applications.filter((application) => sourceOf(application) === "IMPORTED").length, [applications, sourceOf]);
  const archivedCount = useMemo(() => applications.filter((application) => sourceOf(application) === "ARCHIVED").length, [applications, sourceOf]);
  const sourced = useMemo(() => source === "ALL" ? applications : applications.filter((application) => sourceOf(application) === source), [applications, source, sourceOf]);
  const counts = useMemo(() => {
    const result = new Map<JobApplicationStatus, number>();
    for (const application of sourced) result.set(application.status, (result.get(application.status) ?? 0) + 1);
    return result;
  }, [sourced]);
  const visible = useMemo(() => sourced.filter((application) => filter === "ALL" || application.status === filter), [sourced, filter]);
  const pending = useMemo(() => postingsFromText(draft), [draft]);

  async function addPostings() {
    if (pending.length === 0 || busy) return;
    setBusy(true);
    setMessage(null);
    let created = 0, existing = 0, failed = 0;
    for (const posting of pending) {
      try {
        const result = await api.createJobApplication({ ...posting, paneId, status: "QUEUED" });
        if (result.created) { created += 1; onCreated(result.application); } else existing += 1;
      } catch {
        failed += 1;
      }
    }
    setDraft("");
    setBusy(false);
    const tally = { created, existing, failed };
    setMessage(existing && failed ? t("{created} queued, {existing} already tracked, {failed} failed.", tally) : existing ? t("{created} queued, {existing} already tracked.", tally)
      : failed ? t("{created} queued, {failed} failed.", tally) : t("{created} queued.", tally));
  }

  // Check with Gmail: the API looks for each sent application's confirmation email in the Google accounts that allowed it.
  async function checkMail() {
    if (busy) return;
    setBusy(true);
    setMessage(t("Checking sent applications against Gmail…"));
    try {
      const result = await api.checkJobApplyMail(paneId);
      const unchecked = result.unchecked ?? 0;
      const failed = (result.accountErrors ?? []).map((error) => `${error.account} (${error.code})`).join(", ");
      setMessage(result.checked === 0 && unchecked === 0 ? t("No sent applications are waiting for a confirmation email.")
        : t("Checked {checked} sent applications in {accounts}: {confirmed} confirmed by email, {unconfirmed} without a confirmation email.",
          { checked: result.checked, accounts: result.accounts.join(", ") || t("no account read in full"), confirmed: result.confirmed, unconfirmed: result.unconfirmed })
          + (unchecked ? ` ${t("{unchecked} not checked: Gmail failed for {failed}. Check again later.", { unchecked, failed })}` : ""));
      onRefresh();
    } catch (error) {
      setMessage(t("Gmail check failed: {error}", { error: error instanceof Error ? error.message : t("unknown error") }));
    } finally {
      setBusy(false);
    }
  }

  async function importCsv() {
    if (!csv.trim() || busy) return;
    setBusy(true);
    setMessage(null);
    try {
      const result = await api.importJobApplyCsv({ csv, paneId });
      setCsv("");
      setCsvOpen(false);
      setMessage(t("Imported {imported}, duplicates {duplicates}, skipped {skipped}.", { imported: result.imported, duplicates: result.duplicates, skipped: result.skipped }));
      onRefresh();
    } catch (error) {
      setMessage(t("Import failed: {error}", { error: error instanceof Error ? error.message : t("unknown error") }));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="jc-queue" role="tabpanel" id="jc-panel-queue" aria-labelledby="jc-tab-queue">
      <div className="jc-queue-add">
        <textarea rows={2} value={draft} placeholder={t("Paste posting URLs, one per line. The copilot reads company and role when it opens them.")} aria-label={t("Posting URLs")}
          onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) void addPostings(); }} />
        <div className="jc-queue-add-actions">
          <button type="button" className="jc-button primary" disabled={pending.length === 0 || busy} onClick={() => void addPostings()}>
            <Plus aria-hidden="true" /> {pending.length > 1 ? t("Queue {count} postings", { count: pending.length }) : t("Queue posting")}
          </button>
          <button type="button" className={`jc-button ghost${discoverOpen ? " selected" : ""}`} aria-expanded={discoverOpen} onClick={() => setDiscoverOpen((open) => !open)}><Compass aria-hidden="true" /> {t("Discover")}</button>
          <button type="button" className="jc-button ghost" aria-expanded={csvOpen} onClick={() => setCsvOpen((open) => !open)}>{t("Import CSV")}</button>
          <button type="button" className="jc-button ghost" disabled={busy} title={t("Confirm sent applications by their confirmation emails in Gmail")} onClick={() => void checkMail()}>{t("Check with Gmail")}</button>
          <button type="button" className="jc-icon-button" title={t("Refresh")} aria-label={t("Refresh applications")} onClick={onRefresh}><RefreshCw aria-hidden="true" /></button>
        </div>
        {csvOpen ? (
          <div className="jc-queue-csv">
            <p className="jc-muted">{t("Earlier tracker CSV (id,company,board,role,geo,source,status,applied_date,notes). Rows with a known URL or id are skipped.")}</p>
            <textarea rows={5} value={csv} onChange={(event) => setCsv(event.target.value)} aria-label={t("Tracker CSV")} />
            <button type="button" className="jc-button" disabled={!csv.trim() || busy} onClick={() => void importCsv()}>{t("Import")}</button>
          </div>
        ) : null}
        {discoverOpen ? <DiscoverPanel paneId={paneId} onQueued={onRefresh} /> : null}
        {message ? <p className="jc-message" role="status">{message}</p> : null}
      </div>
      {importedCount > 0 || archivedCount > 0 ? (
        <div className="jc-chips" role="group" aria-label={t("Show applications from")}>
          {([["SPACE", "Space", applications.length - importedCount - archivedCount, "Applications Space queued or sent"],
            ...(importedCount > 0 ? [["IMPORTED", "Imported", importedCount, "History from your earlier campaign tracker; Space did not send these"] as const] : []),
            ...(archivedCount > 0 ? [["ARCHIVED", "Archived", archivedCount, "Applications from before the last reset; kept as history"] as const] : []),
            ["ALL", "All sources", applications.length, "Space, archived and imported applications"]] as const).map(([value, label, count, title]) => (
            <button key={value} type="button" aria-pressed={source === value} title={t(title)} className={`jc-chip${source === value ? " selected" : ""}`} onClick={() => setSource(value)}>{t(label)} {count}</button>
          ))}
        </div>
      ) : null}
      <div className="jc-chips" role="tablist" aria-label={t("Filter by status")}>
        <button type="button" role="tab" aria-selected={filter === "ALL"} className={`jc-chip${filter === "ALL" ? " selected" : ""}`} onClick={() => setFilter("ALL")}>{t("All")} {sourced.length}</button>
        {STATUS_ORDER.map((status) => (
          <button key={status} type="button" role="tab" aria-selected={filter === status} className={`jc-chip status-${status.toLowerCase()}${filter === status ? " selected" : ""}`} onClick={() => setFilter(status)}>
            {t(STATUS_LABEL[status])} {counts.get(status) ?? 0}
          </button>
        ))}
      </div>
      <ul className="jc-list" aria-label={t("Applications")}>
        {visible.length === 0 ? (
          <li className="jc-empty">
            <strong>{applications.length === 0 ? t("Nothing queued yet") : sourced.length === 0 && source === "SPACE" ? t("Space has not queued or sent anything yet") : t("No applications in this state")}</strong>
            <span>{applications.length === 0 ? t("Paste posting URLs above or import an earlier tracker. The copilot works through the queue when you start a run.")
              : sourced.length === 0 && source === "SPACE" ? t("Rows from your earlier tracker are under Imported.") : t("Pick another filter.")}</span>
          </li>
        ) : null}
        {visible.map((application) => {
          const imported = isImportedJobApplication(application);
          // An imported row's own URL is synthetic; its earlier tracker id usually names the real posting.
          const link = imported ? importedJobPostingUrl(application) : application.url;
          const when = applicationWhen(application, Date.now(), language);
          return (
          <li key={application.id} className={`jc-row${selectedId === application.id ? " selected" : ""}`} data-imported={imported ? "true" : undefined}>
            <button type="button" className="jc-row-main" aria-pressed={selectedId === application.id} onClick={() => onSelect(selectedId === application.id ? null : application.id)}>
              <strong>{application.company}</strong>
              <span className={application.role === JOB_APPLY_UNRECORDED_ROLE ? "jc-muted" : undefined}>{application.role === JOB_APPLY_UNRECORDED_ROLE ? t(application.role) : application.role}</span>
            </button>
            <div className="jc-row-meta">
              <span className={`jc-pill status-${application.status.toLowerCase()}`}>{t(STATUS_LABEL[application.status])}</span>
              {imported ? <span className="jc-tag" title={t("From an earlier campaign tracker; Space did not send it.")}>{t("Imported")}</span> : null}
              {isDeferredJobApplication(application)
                ? <span className="jc-tag warn" title={t("An employer limit stops this posting until {time}; the copilot takes it again from then.", { time: new Date(application.notBefore!).toLocaleString() })}>{t("Deferred until {date}", { date: new Date(application.notBefore!).toLocaleDateString() })}</span> : null}
              {application.status === "SUBMITTED" && application.notes?.includes(JOB_APPLY_NO_CONFIRMATION_NOTE)
                ? <span className="jc-tag warn" title={t("Check with Gmail found no confirmation email for this application.")}>{t("No email")}</span> : null}
              <span className="jc-muted">{t(SITE_LABEL[application.ats])}</span>
              <span className="jc-muted" title={when.title}>{when.text}</span>
              {application.evidenceArtifactIds.length > 0 ? <span className="jc-muted">{t("{count} evidence", { count: application.evidenceArtifactIds.length })}</span> : null}
              {link ? <a href={link} target="_blank" rel="noopener noreferrer" className="jc-icon-button" title={t("Open posting")} aria-label={t("Open {company} posting", { company: application.company })}><ExternalLink aria-hidden="true" /></a> : null}
            </div>
            {application.notes ? <p className="jc-notes">{application.notes}</p> : null}
          </li>
          );
        })}
      </ul>
    </div>
  );
}
