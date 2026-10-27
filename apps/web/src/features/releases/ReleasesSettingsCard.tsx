import type { DeployQueueTicket, ReleaseActionResponse, ReleasesReport } from "@space/contracts";
import { useCallback, useEffect, useState } from "react";
import { api } from "../../api.js";
import { RefreshCw } from "../ui-theme/app-icons.js";
import "../deploy-queue/deploy-queue.css";
import "./releases.css";

export interface ReleasesClient {
  releases(): Promise<ReleasesReport>;
  promoteRelease(): Promise<ReleaseActionResponse>;
  approveHotfix(ticketId: string): Promise<ReleaseActionResponse>;
}

const REFRESH_MS = 15_000;
const PROMOTION_BUSY = new Set(["QUEUED", "INTEGRATING", "VERIFYING", "DEPLOYING"]);

function short(commit: string | null): string {
  return commit ? commit.slice(0, 9) : "unknown";
}

function promotionState(ticket: DeployQueueTicket | null): { tone: string; label: string } | null {
  if (!ticket) return null;
  if (PROMOTION_BUSY.has(ticket.status)) return { tone: "busy", label: ticket.status === "QUEUED" ? "Promotion queued" : "Promoting" };
  if (ticket.status === "DEPLOYED") return { tone: "ok", label: "Last promotion succeeded" };
  if (ticket.status === "CANCELLED") return { tone: "idle", label: "Last promotion cancelled" };
  return { tone: "bad", label: "Last promotion failed" };
}

export function ReleasesSettingsCard({ client = api }: { client?: ReleasesClient }) {
  const [report, setReport] = useState<ReleasesReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setReport(await client.releases());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Releases could not be loaded.");
    }
  }, [client]);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [load]);

  const run = useCallback(async (action: () => Promise<ReleaseActionResponse>) => {
    setBusy(true);
    setMessage(null);
    try {
      setMessage((await action()).message);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "The action failed.");
    } finally {
      setBusy(false);
      setConfirming(false);
      await load();
    }
  }, [load]);

  // Text sits in divs: the Modern theme makes dock paragraphs, spans and strong text inherit their colour.
  if (!report) {
    return (
      <section className="releases-card" aria-label="Releases">
        {error ? <div className="releases-error" role="alert">{error}</div> : <div className="releases-muted">Loading releases…</div>}
      </section>
    );
  }

  if (!report.available) {
    return (
      <section className="releases-card" aria-label="Releases">
        <div className="releases-muted">There is no dev instance on this server. Changes deploy straight to this instance.</div>
      </section>
    );
  }

  const promotion = promotionState(report.promotion);
  // A running promotion or dev deploy never blocks the next one (operator 2026-10-21): only one already shipping dev's verified commit does.
  const shipping = Boolean(report.promotion && PROMOTION_BUSY.has(report.promotion.status) && report.promotion.sha === report.dev.verifiedCommit);
  const upToDate = report.pendingCount === 0;
  const blocked = !report.managedHere ? "You are on the test copy (dev). Promote from your everyday Space (stable)."
    : shipping ? "The promotion in progress already ships everything that is on dev."
      : upToDate ? "Stable already runs everything that is on dev."
        : null;

  return (
    <section className="releases-card" aria-label="Releases">
      <div className="releases-versions">
        <div className="releases-version">
          <span className="releases-dot tone-ok" aria-hidden="true" />
          <div className="releases-version-copy">
            <div className="releases-version-name">Stable · your everyday Space</div>
            <div className="releases-muted">The version you work in.</div>
          </div>
          <code title={report.stable.commit ?? undefined}>{short(report.stable.commit)}</code>
        </div>
        <div className="releases-version">
          <span className="releases-dot tone-warn" aria-hidden="true" />
          <div className="releases-version-copy">
            <div className="releases-version-name">Dev · the test copy</div>
            <div className="releases-muted">
              {report.defaultTarget === "dev" ? "Agent changes land here first." : "Agent changes go straight to stable."}{" "}
              <a href={report.dev.url} target="_blank" rel="noopener noreferrer">Open dev</a>
            </div>
          </div>
          <code title={report.dev.commit ?? undefined}>{short(report.dev.commit)}</code>
        </div>
      </div>

      <div className="releases-status">
        {promotion && report.promotion ? (
          <span className={`deploy-queue-chip tone-${promotion.tone}`} title={report.promotion.note ?? undefined}>{promotion.label}</span>
        ) : <div className="releases-muted">No promotion yet.</div>}
        <button type="button" className="deploy-queue-refresh" onClick={() => void load()} aria-label="Refresh releases" title="Refresh">
          <RefreshCw size={14} aria-hidden="true" />
        </button>
      </div>
      {error ? <div className="releases-error" role="alert">{error}</div> : null}
      {message ? <div role="status" className="releases-message">{message}</div> : null}

      <div className="releases-pending-block">
        <h4>On dev, not yet on stable ({report.pendingCount})</h4>
        {report.pending.length ? (
          <ul className="releases-pending">
            {report.pending.map((change) => <li key={change.commit}>{change.summary}</li>)}
          </ul>
        ) : <div className="releases-muted">Nothing is waiting.</div>}
      </div>

      {confirming ? (
        <div className="releases-confirm" role="group" aria-label="Confirm promotion">
          <div>
            Stable builds and restarts once (about 5 minutes). CLI sessions keep running, and a failed check rolls stable back
            automatically. Promote {report.pendingCount} change{report.pendingCount === 1 ? "" : "s"} now?
          </div>
          <div className="releases-actions">
            <button type="button" className="releases-primary" disabled={busy} onClick={() => void run(() => client.promoteRelease())}>
              {busy ? "Promoting…" : "Promote now"}
            </button>
            <button type="button" disabled={busy} onClick={() => setConfirming(false)}>Cancel</button>
          </div>
        </div>
      ) : (
        <div className="releases-actions">
          <button type="button" className="releases-primary" disabled={Boolean(blocked) || busy} onClick={() => setConfirming(true)}>
            Promote dev to stable
          </button>
          {blocked ? <div className="releases-muted">{blocked}</div> : null}
        </div>
      )}

      {report.hotfixes.length ? (
        <div className="releases-pending-block">
          <h4>Urgent fixes waiting for your approval</h4>
          <ul className="releases-hotfixes">
            {report.hotfixes.map((hotfix) => (
              <li key={hotfix.id} className="releases-hotfix">
                <div className="releases-version-copy">
                  <div className="releases-version-name">{hotfix.summary || hotfix.branch}</div>
                  <div className="releases-muted"><code>{hotfix.sha.slice(0, 10)}</code> · {hotfix.branch}</div>
                </div>
                <button type="button" disabled={busy || !report.managedHere} onClick={() => void run(() => client.approveHotfix(hotfix.id))}>
                  Approve
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
