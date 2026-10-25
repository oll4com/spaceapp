import { useCallback, useMemo, useState } from "react";
import { importedJobPostingUrl, isDeferredJobApplication, isImportedJobApplication, jobPostingFromUrl, JOB_APPLY_NO_CONFIRMATION_NOTE, JOB_APPLY_UNRECORDED_ROLE, type JobApplication, type JobApplicationStatus, type JobApplyDiscoveredPosting, type JobApplyDiscoverResult } from "@space/contracts";
import { api } from "../../api.js";
import { SpaceToggle } from "../ui-controls/SpaceToggle.js";
import { Compass, ExternalLink, Plus, RefreshCw } from "../ui-theme/app-icons.js";

export const STATUS_ORDER: JobApplicationStatus[] = ["NEEDS_USER", "FILLING", "QUEUED", "SUBMITTED", "VERIFIED", "FAILED"];
export const STATUS_LABEL: Record<JobApplicationStatus, string> = {
  QUEUED: "Queued", FILLING: "Filling", NEEDS_USER: "Needs you", SUBMITTED: "Submitted", VERIFIED: "Verified", FAILED: "Failed"
};
const SITE_LABEL: Record<JobApplication["ats"], string> = { linkedin: "LinkedIn", greenhouse: "Greenhouse", ashby: "Ashby", lever: "Lever", workday: "Workday", indeed: "Indeed", other: "Other" };

export function relativeTime(iso: string, now = Date.now()): string {
  const minutes = Math.round((now - new Date(iso).getTime()) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return new Date(iso).toLocaleDateString();
}

/** When the row happened: the applied date once sent (or attempted), otherwise its last change. */
export function applicationWhen(application: Pick<JobApplication, "status" | "appliedAt" | "updatedAt">, now = Date.now()): { text: string; title: string } {
  if (application.appliedAt && (application.status === "SUBMITTED" || application.status === "VERIFIED" || application.status === "FAILED")) {
    return { text: `${application.status === "FAILED" ? "Tried" : "Applied"} ${relativeTime(application.appliedAt, now)}`, title: application.appliedAt };
  }
  return { text: relativeTime(application.updatedAt, now), title: application.updatedAt };
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
      setError(caught instanceof Error ? caught.message : "Search failed.");
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
      setError(caught instanceof Error ? caught.message : "Queueing failed.");
    } finally {
      setBusy(false);
    }
  }

  const fresh = result?.postings.filter((posting) => !posting.tracked && !queuedUrls.has(posting.url)) ?? [];
  return (
    <div className="jc-discover">
      <form className="jc-discover-form" onSubmit={(event) => { event.preventDefault(); void search(); }}>
        <label className="jc-field"><span>Board tokens (company slugs, comma separated)</span><input value={tokens} placeholder="acme, globex, initech" aria-label="Board tokens" onChange={(event) => setTokens(event.target.value)} /></label>
        <div className="jc-form-grid">
          <label className="jc-field"><span>Title contains</span><input value={query} placeholder="backend engineer" aria-label="Title contains" onChange={(event) => setQuery(event.target.value)} /></label>
          <SpaceToggle compact label="Remote only" checked={remote} onChange={setRemote} />
        </div>
        <div className="jc-actions">
          <button type="submit" className="jc-button primary" disabled={busy}><Compass aria-hidden="true" /> {busy ? "Searching…" : "Search boards"}</button>
          {fresh.length > 0 ? <button type="button" className="jc-button" disabled={busy} onClick={() => void queue(fresh.slice(0, 10))}>Queue top {Math.min(10, fresh.length)}</button> : null}
          <span className="jc-muted">Remembered board tokens (SITE memories tagged board-token) are scanned too.</span>
        </div>
      </form>
      {error ? <p className="jc-message" role="alert">{error}</p> : null}
      {result ? (
        <>
          <p className="jc-muted">{result.postings.length} posting{result.postings.length === 1 ? "" : "s"} from {result.scanned.filter((entry) => !entry.error).length} board{result.scanned.filter((entry) => !entry.error).length === 1 ? "" : "s"}{result.scanned.some((entry) => entry.error) ? ` · ${result.scanned.filter((entry) => entry.error).map((entry) => `${entry.ats}/${entry.board}: ${entry.error}`).join(", ")}` : ""}{result.truncated ? " · more available" : ""}</p>
          <ul className="jc-list jc-discover-list" aria-label="Discovered postings">
            {result.postings.map((posting) => {
              const done = posting.tracked || queuedUrls.has(posting.url);
              return (
                <li key={posting.url} className="jc-row">
                  <div className="jc-row-main"><strong>{posting.company}</strong><span>{posting.role}</span></div>
                  <div className="jc-row-meta">
                    <span className="jc-muted">{posting.ats}</span>
                    {posting.location ? <span className="jc-muted">{posting.location}</span> : null}
                    {posting.remote ? <span className="jc-tag">remote</span> : null}
                    {posting.postedAt ? <span className="jc-muted" title={posting.postedAt}>{relativeTime(posting.postedAt)}</span> : null}
                    <a href={posting.url} target="_blank" rel="noopener noreferrer" className="jc-icon-button" title="Open posting" aria-label={`Open ${posting.company} posting`}><ExternalLink aria-hidden="true" /></a>
                    <button type="button" className="jc-button" disabled={busy || done} onClick={() => void queue([posting])}>{posting.tracked ? "Tracked" : queuedUrls.has(posting.url) ? "Queued" : "Queue"}</button>
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
    setMessage(`${created} queued${existing ? `, ${existing} already tracked` : ""}${failed ? `, ${failed} failed` : ""}.`);
  }

  // Check with Gmail: the API looks for each sent application's confirmation email in the Google accounts that allowed it.
  async function checkMail() {
    if (busy) return;
    setBusy(true);
    setMessage("Checking sent applications against Gmail…");
    try {
      const result = await api.checkJobApplyMail(paneId);
      setMessage(result.checked === 0 ? "No sent applications are waiting for a confirmation email."
        : `Checked ${result.checked} sent applications in ${result.accounts.join(", ")}: ${result.confirmed} confirmed by email, ${result.unconfirmed} without a confirmation email.`);
      onRefresh();
    } catch (error) {
      setMessage(`Gmail check failed: ${error instanceof Error ? error.message : "unknown error"}`);
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
      setMessage(`Imported ${result.imported}, duplicates ${result.duplicates}, skipped ${result.skipped}.`);
      onRefresh();
    } catch (error) {
      setMessage(`Import failed: ${error instanceof Error ? error.message : "unknown error"}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="jc-queue" role="tabpanel" id="jc-panel-queue" aria-labelledby="jc-tab-queue">
      <div className="jc-queue-add">
        <textarea rows={2} value={draft} placeholder="Paste posting URLs, one per line. The copilot reads company and role when it opens them." aria-label="Posting URLs"
          onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) void addPostings(); }} />
        <div className="jc-queue-add-actions">
          <button type="button" className="jc-button primary" disabled={pending.length === 0 || busy} onClick={() => void addPostings()}>
            <Plus aria-hidden="true" /> {pending.length > 1 ? `Queue ${pending.length} postings` : "Queue posting"}
          </button>
          <button type="button" className={`jc-button ghost${discoverOpen ? " selected" : ""}`} aria-expanded={discoverOpen} onClick={() => setDiscoverOpen((open) => !open)}><Compass aria-hidden="true" /> Discover</button>
          <button type="button" className="jc-button ghost" aria-expanded={csvOpen} onClick={() => setCsvOpen((open) => !open)}>Import CSV</button>
          <button type="button" className="jc-button ghost" disabled={busy} title="Confirm sent applications by their confirmation emails in Gmail" onClick={() => void checkMail()}>Check with Gmail</button>
          <button type="button" className="jc-icon-button" title="Refresh" aria-label="Refresh applications" onClick={onRefresh}><RefreshCw aria-hidden="true" /></button>
        </div>
        {csvOpen ? (
          <div className="jc-queue-csv">
            <p className="jc-muted">Earlier tracker CSV (id,company,board,role,geo,source,status,applied_date,notes). Rows with a known URL or id are skipped.</p>
            <textarea rows={5} value={csv} onChange={(event) => setCsv(event.target.value)} aria-label="Tracker CSV" />
            <button type="button" className="jc-button" disabled={!csv.trim() || busy} onClick={() => void importCsv()}>Import</button>
          </div>
        ) : null}
        {discoverOpen ? <DiscoverPanel paneId={paneId} onQueued={onRefresh} /> : null}
        {message ? <p className="jc-message" role="status">{message}</p> : null}
      </div>
      {importedCount > 0 || archivedCount > 0 ? (
        <div className="jc-chips" role="group" aria-label="Show applications from">
          {([["SPACE", "Space", applications.length - importedCount - archivedCount, "Applications Space queued or sent"],
            ...(importedCount > 0 ? [["IMPORTED", "Imported", importedCount, "History from your earlier campaign tracker; Space did not send these"] as const] : []),
            ...(archivedCount > 0 ? [["ARCHIVED", "Archived", archivedCount, "Applications from before the last reset; kept as history"] as const] : []),
            ["ALL", "All sources", applications.length, "Space, archived and imported applications"]] as const).map(([value, label, count, title]) => (
            <button key={value} type="button" aria-pressed={source === value} title={title} className={`jc-chip${source === value ? " selected" : ""}`} onClick={() => setSource(value)}>{label} {count}</button>
          ))}
        </div>
      ) : null}
      <div className="jc-chips" role="tablist" aria-label="Filter by status">
        <button type="button" role="tab" aria-selected={filter === "ALL"} className={`jc-chip${filter === "ALL" ? " selected" : ""}`} onClick={() => setFilter("ALL")}>All {sourced.length}</button>
        {STATUS_ORDER.map((status) => (
          <button key={status} type="button" role="tab" aria-selected={filter === status} className={`jc-chip status-${status.toLowerCase()}${filter === status ? " selected" : ""}`} onClick={() => setFilter(status)}>
            {STATUS_LABEL[status]} {counts.get(status) ?? 0}
          </button>
        ))}
      </div>
      <ul className="jc-list" aria-label="Applications">
        {visible.length === 0 ? (
          <li className="jc-empty">
            <strong>{applications.length === 0 ? "Nothing queued yet" : sourced.length === 0 && source === "SPACE" ? "Space has not queued or sent anything yet" : "No applications in this state"}</strong>
            <span>{applications.length === 0 ? "Paste posting URLs above or import an earlier tracker. The copilot works through the queue when you start a run."
              : sourced.length === 0 && source === "SPACE" ? "Rows from your earlier tracker are under Imported." : "Pick another filter."}</span>
          </li>
        ) : null}
        {visible.map((application) => {
          const imported = isImportedJobApplication(application);
          // An imported row's own URL is synthetic; its earlier tracker id usually names the real posting.
          const link = imported ? importedJobPostingUrl(application) : application.url;
          const when = applicationWhen(application);
          return (
          <li key={application.id} className={`jc-row${selectedId === application.id ? " selected" : ""}`} data-imported={imported ? "true" : undefined}>
            <button type="button" className="jc-row-main" aria-pressed={selectedId === application.id} onClick={() => onSelect(selectedId === application.id ? null : application.id)}>
              <strong>{application.company}</strong>
              <span className={application.role === JOB_APPLY_UNRECORDED_ROLE ? "jc-muted" : undefined}>{application.role}</span>
            </button>
            <div className="jc-row-meta">
              <span className={`jc-pill status-${application.status.toLowerCase()}`}>{STATUS_LABEL[application.status]}</span>
              {imported ? <span className="jc-tag" title="From an earlier campaign tracker; Space did not send it.">Imported</span> : null}
              {isDeferredJobApplication(application)
                ? <span className="jc-tag warn" title={`An employer limit stops this posting until ${new Date(application.notBefore!).toLocaleString()}; the copilot takes it again from then.`}>Deferred until {new Date(application.notBefore!).toLocaleDateString()}</span> : null}
              {application.status === "SUBMITTED" && application.notes?.includes(JOB_APPLY_NO_CONFIRMATION_NOTE)
                ? <span className="jc-tag warn" title="Check with Gmail found no confirmation email for this application.">No email</span> : null}
              <span className="jc-muted">{SITE_LABEL[application.ats]}</span>
              <span className="jc-muted" title={when.title}>{when.text}</span>
              {application.evidenceArtifactIds.length > 0 ? <span className="jc-muted">{application.evidenceArtifactIds.length} evidence</span> : null}
              {link ? <a href={link} target="_blank" rel="noopener noreferrer" className="jc-icon-button" title="Open posting" aria-label={`Open ${application.company} posting`}><ExternalLink aria-hidden="true" /></a> : null}
            </div>
            {application.notes ? <p className="jc-notes">{application.notes}</p> : null}
          </li>
          );
        })}
      </ul>
    </div>
  );
}
