import { useEffect, useState } from "react";
import type {
  CodexUsageAccountList,
  SystemAnalyticsCliSessionsResponse,
  SystemAnalyticsModelsResponse,
  SystemAnalyticsProcessesResponse,
} from "@space/contracts";
import { api } from "../../api.js";
import {
  formatHealthValue,
  numericHealthTone,
  toneLabels,
  type HealthThresholds,
} from "./health-model.js";

export type ProcessSort =
  | "rss"
  | "cpu"
  | "pid"
  | "uptime"
  | "name"
  | "state"
  | "threads";
export type ProcessSortDirection = "asc" | "desc";
export const processSortColumns: ReadonlyArray<{
  key: ProcessSort;
  label: string;
}> = [
  { key: "name", label: "Name / workspace" },
  { key: "cpu", label: "CPU" },
  { key: "rss", label: "Memory" },
  { key: "pid", label: "PID" },
  { key: "state", label: "State" },
  { key: "threads", label: "Threads" },
  { key: "uptime", label: "Uptime" },
];
/** Text columns read naturally ascending, numeric columns descending. */
export function processSortDefaultDirection(
  key: ProcessSort,
): ProcessSortDirection {
  return key === "name" || key === "state" ? "asc" : "desc";
}

export function HealthProcessTable({
  thresholds,
}: {
  thresholds: HealthThresholds;
}) {
  const [data, setData] = useState<SystemAnalyticsProcessesResponse | null>(
    null,
  );
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<ProcessSort>("cpu");
  const [direction, setDirection] = useState<ProcessSortDirection>("desc");
  const toggleSort = (key: ProcessSort) => {
    setDirection(
      key === sort
        ? direction === "asc"
          ? "desc"
          : "asc"
        : processSortDefaultDirection(key),
    );
    setSort(key);
    setPage(1);
  };
  const [ownership, setOwnership] = useState<
    "ALL" | "SPACE_CLI" | "SPACE_SHARED" | "OTHER"
  >("ALL");
  const [page, setPage] = useState(1);
  const [error, setError] = useState(false);
  useEffect(() => {
    let disposed = false,
      inFlight = false;
    const load = async () => {
      if (disposed || inFlight || document.visibilityState === "hidden") return;
      inFlight = true;
      try {
        const result = await api.systemAnalyticsProcesses({
          page,
          pageSize: 100,
          sort,
          direction,
          query: query || undefined,
          ownership,
        });
        if (!disposed) {
          setData(result);
          setError(false);
        }
      } catch {
        if (!disposed) setError(true);
      } finally {
        inFlight = false;
      }
    };
    const debounce = window.setTimeout(() => void load(), 250);
    const timer = window.setInterval(() => void load(), 10_000);
    document.addEventListener("visibilitychange", load);
    return () => {
      disposed = true;
      window.clearInterval(timer);
      window.clearTimeout(debounce);
      document.removeEventListener("visibilitychange", load);
    };
  }, [page, query, sort, direction, ownership]);
  return (
    <section className="health-panel">
      <header className="health-section-heading">
        <div>
          <h2>Processes</h2>
          <p>
            Live server processes · CPU is shown as a share of the whole server
          </p>
        </div>
        <span>{data?.pagination.totalItems ?? "—"} processes</span>
      </header>
      <div className="health-table-controls">
        <input
          name="health-process-query"
          aria-label="Search processes"
          placeholder="Search processes…"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setPage(1);
          }}
        />
        <select
          name="health-process-sort"
          aria-label="Sort processes"
          value={sort}
          onChange={(e) => {
            const key = e.target.value as ProcessSort;
            setSort(key);
            setDirection(processSortDefaultDirection(key));
            setPage(1);
          }}
        >
          <option value="cpu">CPU usage</option>
          <option value="rss">Memory usage</option>
          <option value="name">Name</option>
          <option value="pid">PID</option>
          <option value="state">State</option>
          <option value="threads">Threads</option>
          <option value="uptime">Uptime</option>
        </select>
        <select
          name="health-process-ownership"
          aria-label="Process ownership"
          value={ownership}
          onChange={(e) => {
            setOwnership(e.target.value as typeof ownership);
            setPage(1);
          }}
        >
          <option value="ALL">All processes</option>
          <option value="SPACE_CLI">Space CLI</option>
          <option value="SPACE_SHARED">Shared runtimes</option>
          <option value="OTHER">Other processes</option>
        </select>
      </div>
      {error && (
        <p role="status" className="health-error">
          Process data could not be refreshed. The last snapshot is shown.
        </p>
      )}
      <div className="health-table-scroll">
        <table>
          <thead>
            <tr>
              {processSortColumns.map((column) => {
                const active = sort === column.key;
                return (
                  <th
                    key={column.key}
                    aria-sort={
                      active
                        ? direction === "asc"
                          ? "ascending"
                          : "descending"
                        : "none"
                    }
                  >
                    <button
                      type="button"
                      className={`health-process-sort${active ? " is-active" : ""}`}
                      title={`Sort by ${column.label}`}
                      onClick={() => toggleSort(column.key)}
                    >
                      {column.label}
                      <span
                        aria-hidden="true"
                        className="health-process-sort-indicator"
                      >
                        {active ? (direction === "asc" ? "▲" : "▼") : "↕"}
                      </span>
                    </button>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {data?.data.map((p) => (
              <tr key={p.pid}>
                <td>
                  <strong>{p.name}</strong>
                  <small>
                    {[p.roomName, p.paneTitle].filter(Boolean).join(" / ") ||
                      p.ownership.replaceAll("_", " ").toLowerCase()}
                  </small>
                </td>
                <td
                  className={`health-table-value is-${numericHealthTone("cpu", p.cpuHostPercent, thresholds)}`}
                >
                  <span className="health-dot" /> {p.cpuHostPercent.toFixed(1)}%
                </td>
                <td className="health-table-value">
                  {formatHealthValue(p.rssBytes, "BYTES")}
                </td>
                <td>{p.pid}</td>
                <td>{p.state}</td>
                <td>{p.threadCount}</td>
                <td>{Math.floor(p.uptimeSeconds / 60)} min</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!data && (
        <p className="health-empty" role="status">
          Loading processes…
        </p>
      )}
      {data?.data.length === 0 && (
        <p className="health-empty">No matching processes.</p>
      )}
      <footer className="health-pagination">
        <small>
          {data
            ? `Updated ${new Date(data.sampledAt).toLocaleTimeString()}`
            : ""}
        </small>
        <button
          type="button"
          disabled={page <= 1}
          onClick={() => setPage((p) => p - 1)}
        >
          Previous
        </button>
        <span>Page {page}</span>
        <button
          type="button"
          disabled={!data || page >= data.pagination.totalPages}
          onClick={() => setPage((p) => p + 1)}
        >
          Next
        </button>
      </footer>
    </section>
  );
}

export function HealthAiPanel({
  onOpenUsage,
  models,
  accounts,
  onManage,
  thresholds,
  now,
}: {
  thresholds: HealthThresholds;
  now: number;
  onOpenUsage?: () => void;
  models: SystemAnalyticsModelsResponse | null;
  accounts: CodexUsageAccountList | null;
  onManage?: (id: "accounts" | "provider" | "cli") => void;
}) {
  const [sessions, setSessions] =
    useState<SystemAnalyticsCliSessionsResponse | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    let disposed = false,
      inFlight = false;
    const load = async () => {
      if (disposed || inFlight || document.visibilityState === "hidden") return;
      inFlight = true;
      try {
        const next = await api.systemAnalyticsCliSessions("10m");
        if (!disposed) {
          setSessions(next);
          setError(false);
        }
      } catch {
        if (!disposed) setError(true);
      } finally {
        inFlight = false;
      }
    };
    void load();
    const timer = window.setInterval(() => void load(), 10_000);
    document.addEventListener("visibilitychange", load);
    return () => {
      disposed = true;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", load);
    };
  }, []);
  const accountTone = (value: number | null, at: string | null) =>
    accounts?.isStale || !at || now - Date.parse(at) > 180_000
      ? "stale"
      : numericHealthTone("accounts", value, thresholds);
  const accountValue = (value: number | null, at: string | null) => {
    const tone = accountTone(value, at);
    return (
      <span className={`health-status is-${tone}`} title={toneLabels[tone]}>
        <i />
        {formatHealthValue(value, "PERCENT")}
      </span>
    );
  };
  return (
    <div className="health-stack">
      <section className="health-panel">
        <header className="health-section-heading">
          <div>
            <h2>Providers & accounts</h2>
            <p>Current allocation and remaining limits</p>
          </div>
          {onManage && (
            <button type="button" onClick={() => onManage("provider")}>
              Manage provider
            </button>
          )}
        </header>
        <div className="health-provider-grid">
          {models?.providers.map((p) => (
            <article key={p.providerId}>
              <small>{p.providerId}</small>
              <strong>{p.activeSessions} active sessions</strong>
              <span>
                {p.modelCount} models · {p.completedTurns} completed turns
              </span>
            </article>
          ))}
        </div>
        {accounts?.isStale && (
          <p className="health-error">Account data is stale.</p>
        )}
        <div className="health-table-scroll">
          <table>
            <thead>
              <tr>
                <th>Account</th>
                <th>5-hour remaining</th>
                <th>Weekly remaining</th>
              </tr>
            </thead>
            <tbody>
              {accounts?.data.map((a) => (
                <tr key={a.id}>
                  <td>{a.label}</td>
                  <td>
                    {accountValue(a.fiveHourRemainingPercent, a.sampledAt)}
                  </td>
                  <td>{accountValue(a.weeklyRemainingPercent, a.sampledAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {onManage && (
          <button type="button" onClick={() => onManage("accounts")}>
            Account details & credits
          </button>
        )}
      </section>
      <section className="health-panel">
        <header className="health-section-heading">
          <div>
            <h2>Active models</h2>
            <p>Global activity in the last 10 minutes</p>
          </div>
          {onOpenUsage && <button type="button" aria-label="Token usage history" onClick={onOpenUsage}>Token usage history</button>}
        </header>
        <div className="health-table-scroll">
          <table>
            <thead>
              <tr>
                <th>Model / provider</th>
                <th>Sessions</th>
                <th>Active turns</th>
                <th>Completed / aborted</th>
                <th>TTFT</th>
                <th>Tokens/sec</th>
                <th>Coverage</th>
              </tr>
            </thead>
            <tbody>
              {models?.models.map((m) => (
                <tr key={`${m.providerId}:${m.modelId}`}>
                  <td>
                    <strong>{m.modelId}</strong>
                    <small>{m.providerId}</small>
                  </td>
                  <td>{m.activeSessions}</td>
                  <td>{m.activeTurns}</td>
                  <td>
                    {m.completedTurns} / {m.abortedTurns}
                  </td>
                  <td>{formatHealthValue(m.avgTtftMs, "MILLISECONDS")}</td>
                  <td>{m.avgTokPerSec?.toFixed(1) ?? "—"}</td>
                  <td>{m.coverage.replaceAll("_", " ")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {models?.models.length === 0 && (
          <p className="health-empty">No recent model activity.</p>
        )}
      </section>
      <section className="health-panel">
        <header className="health-section-heading">
          <div>
            <h2>CLI sessions</h2>
            <p>Running and recently active sessions</p>
          </div>
          {onManage && (
            <button type="button" onClick={() => onManage("cli")}>
              Session maintenance
            </button>
          )}
        </header>
        {error && (
          <p className="health-error">Session data could not be refreshed.</p>
        )}
        <div className="health-table-scroll">
          <table>
            <thead>
              <tr>
                <th>Room / pane</th>
                <th>Runtime</th>
                <th>Model</th>
                <th>Status</th>
                <th>Attachments</th>
              </tr>
            </thead>
            <tbody>
              {sessions?.sessions.map((s) => (
                <tr key={s.sessionId}>
                  <td>
                    <strong>{s.paneTitle}</strong>
                    <small>{s.roomName}</small>
                  </td>
                  <td>{s.runtimeName}</td>
                  <td>{s.modelId ?? "—"}</td>
                  <td>
                    <span
                      className={`health-status is-${s.status === "RUNNING" ? "healthy" : s.status === "ERROR" ? "critical" : "disabled"}`}
                    >
                      <i />
                      {s.status}
                    </span>
                  </td>
                  <td>{s.attachmentCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
