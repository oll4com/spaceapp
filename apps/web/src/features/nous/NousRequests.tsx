import { useCallback, useEffect, useState } from "react";
import type { NousOperatorRequest, NousRequestStatus } from "@space/contracts";
import { api } from "../../api.js";
import { formatUserTime } from "../date-time-settings/date-time-settings.js";
import { DockButton, DockSearch, DockState } from "../dock-kit/DockKit.js";
import { ListChecks } from "../ui-theme/app-icons.js";
import { useNousUiIds, useNousUiState } from "./nous-ui-state.js";
import { useUiLanguage, uiText } from "../ui-language/ui-language.js";
import "./nous-requests.css";

/**
 * Requests (operator 31/10 09:55 BKK, plan clipboard:2NOOFNJDUIMO): every message the operator sent Nous, newest first, one under the
 * other, each with whether Nous completed it. The server derives the status from exact links (GET /api/nous/requests); Clear hides none.
 */
const STATUS_LABELS: Record<NousRequestStatus, string> = { DONE: "Done", ANSWERED: "Answered", IN_PROGRESS: "In progress", WAITS_FOR_YOU: "Waits for you", NOT_DONE: "Not done", NOT_ANSWERED: "Not answered yet" };
const STATUSES = Object.keys(STATUS_LABELS) as NousRequestStatus[];
type Filter = NousRequestStatus | "ALL";
const isFilter = (value: unknown): value is Filter => value === "ALL" || (typeof value === "string" && Object.hasOwn(STATUS_LABELS, value));
const WHERE_LABELS = { stable: "Live on stable", dev: "Live on dev", "no code": "No code" } as const;
const POLL_MS = 20_000;
const messageOf = (error: unknown, fallback: string) => (error instanceof Error && error.message ? error.message : fallback);
/** The newest page replaces what it covers (a row whose status left the filter goes); pages loaded further back stay. */
const olderThan = (latest: NousOperatorRequest[], loaded: NousOperatorRequest[]) => {
  const oldest = latest.at(-1)?.createdAt;
  return oldest === undefined ? [] : loaded.filter((request) => request.createdAt < oldest);
};
const isText = (value: unknown): value is string => typeof value === "string";
const SEARCH_DELAY_MS = 300;
/** A list shows only for the filter and search it was loaded with. */
type RequestList = { key: string; requests: NousOperatorRequest[]; hasMore: boolean; counts?: Record<NousRequestStatus, number> };

/** The Requests tab's badge (operator 1/11 03:41 BKK): how many requests are In progress or Not done (6/11), read with the dock's other counts. */
export function useRequestsInProgress(active: boolean) {
  const [count, setCount] = useState(0);
  useEffect(() => {
    if (!active) return;
    const load = () => void api.nousRequests(undefined, undefined, 1).then((page) => setCount((page.counts?.IN_PROGRESS ?? 0) + (page.counts?.NOT_DONE ?? 0)), () => undefined);
    load();
    const timer = window.setInterval(load, POLL_MS);
    return () => window.clearInterval(timer);
  }, [active]);
  return count;
}

export function NousRequests({ active, onOpenPlan }: { active: boolean; onOpenPlan(id: string): void }) {
  // One state: the newest page's poll refreshes the rows and never brings back "Load earlier" once the oldest page is in.
  // The status filter (operator 31/10 13:03 BKK), each with how many there are; a list shows only for the filter it was loaded with.
  const [filter, setFilter] = useNousUiState<Filter>("requests.status", "ALL", isFilter);
  // Keyword search over every request (operator 6/11 13:02 BKK): the server keeps those holding any word, accents folded, with the status filter.
  const [search, setSearch] = useNousUiState<string>("requests.search", "", isText);
  const [q, setQ] = useState(search.trim().slice(0, 200));
  useEffect(() => { const timer = window.setTimeout(() => setQ(search.trim().slice(0, 200)), SEARCH_DELAY_MS); return () => window.clearTimeout(timer); }, [search]);
  const key = `${filter}\n${q}`;
  const [loaded, setList] = useState<RequestList | null>(null);
  const list = loaded?.key === key ? loaded : null;
  const requests = list?.requests ?? null;
  const [error, setError] = useState<string | null>(null);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const summaries = useNousUiIds("requests.done");
  const loadLatest = useCallback(async () => {
    const page = await api.nousRequests(undefined, filter === "ALL" ? undefined : filter, undefined, q || undefined);
    setList((current) => {
      const older = current?.key === key ? olderThan(page.requests, current.requests) : [];
      return { key, requests: [...page.requests, ...older], hasMore: older.length ? current!.hasMore : page.hasMore, counts: page.counts };
    });
    setError(null);
  }, [filter, q, key]);
  useEffect(() => {
    if (!active) return;
    const load = () => void loadLatest().catch((failure: unknown) => setError(messageOf(failure, "Your requests could not be loaded.")));
    load();
    const timer = window.setInterval(load, POLL_MS);
    return () => window.clearInterval(timer);
  }, [active, loadLatest]);
  const loadEarlier = async () => {
    const oldest = requests?.at(-1);
    if (!oldest) return;
    setLoadingEarlier(true);
    try {
      const page = await api.nousRequests(oldest.messageId, filter === "ALL" ? undefined : filter, undefined, q || undefined);
      setList((current) => current?.key !== key ? current : { ...current,
        requests: [...current.requests, ...page.requests.filter((request) => !current.requests.some((known) => known.messageId === request.messageId))], hasMore: page.hasMore });
    } catch (failure) { setError(messageOf(failure, "Earlier requests could not be loaded.")); } finally { setLoadingEarlier(false); }
  };
  const counts = loaded?.counts;
  const language = useUiLanguage();
  const t = (text: string, vars?: Record<string, string | number>) => uiText(language, text, vars);
  return (
    <div className="nous-decisions nous-requests" data-sensitive-masked="manual">
      <select className="dock-kit-select nous-requests-filter" aria-label={t("Status")} value={filter} onChange={(event) => setFilter(event.currentTarget.value as Filter)}>
        <option value="ALL">{t("All")}{counts ? ` (${STATUSES.reduce((sum, status) => sum + counts[status], 0)})` : ""}</option>
        {STATUSES.map((status) => <option key={status} value={status}>{t(STATUS_LABELS[status])}{counts ? ` (${counts[status]})` : ""}</option>)}
      </select>
      <DockSearch className="nous-requests-search" name="requests-search" label={t("Search requests")} placeholder={t("Search requests: any of the words")} value={search} onChange={setSearch} />
      {error ? <p className="nous-muted" role="alert">{error}</p> : null}
      {requests === null && !error ? <DockState kind="loading" title={t("Loading your requests")} /> : null}
      {requests?.length === 0 ? (q ? <DockState kind="empty" icon={ListChecks} title={t("No requests match “{q}”", { q })} />
        : filter === "ALL" ? <DockState kind="empty" icon={ListChecks} title={t("No requests yet")} detail={t("Every message you send Nous appears here, with whether it is done.")} />
        : <DockState kind="empty" icon={ListChecks} title={t("No requests: {status}", { status: t(STATUS_LABELS[filter]) })} />) : null}
      {requests?.map((request) => (
        <article key={request.messageId} className={`nous-request is-${request.status.toLowerCase()}`} aria-label={request.text || t("Files only")} data-message-id={request.messageId}>
          <div className="nous-request-meta">
            <time dateTime={request.createdAt}>{formatUserTime(request.createdAt, { withDate: true })}</time>
            <span className={`nous-request-status is-${request.status.toLowerCase()}`}>
              {t(STATUS_LABELS[request.status])}{request.status === "IN_PROGRESS" && request.planPercent !== undefined ? ` · ${request.planPercent}%` : ""}
            </span>
          </div>
          <p className="nous-request-text">{request.text || t("Files only")}</p>
          {request.doneSummary ? (
            <details className="nous-request-done" open={summaries.has(request.messageId)} onToggle={(event) => summaries.setOpen(request.messageId, event.currentTarget.open)}>
              <summary>{t("What was done")}</summary>
              <p className="nous-done-summary">{request.doneSummary}</p>
              <p className="nous-muted">{[request.where ? t(WHERE_LABELS[request.where]) : null, ...(request.tickets ?? [])].filter(Boolean).join(" · ")}</p>
            </details>
          ) : null}
          {request.planId ? (
            <DockButton className="nous-request-plan" onClick={() => onOpenPlan(request.planId!)}>
              {t("Open plan")}{request.planPercent !== undefined ? ` · ${request.planPercent}%` : ""}
            </DockButton>
          ) : null}
        </article>
      ))}
      {list?.hasMore && requests?.length ? <DockButton className="nous-load-earlier" busy={loadingEarlier} disabled={loadingEarlier} onClick={() => void loadEarlier()}>{t("Load earlier requests")}</DockButton> : null}
    </div>
  );
}
