import type { StreamingModerationAction } from "@space/contracts";
import { useCallback, useEffect, useState } from "react";
import { RefreshCw, ShieldCheck, Timer, Undo2 } from "../ui-theme/app-icons.js";
import { api } from "../../api.js";
import { DockButton, DockChips, DockIconButton, DockNotice, DockState } from "../dock-kit/DockKit.js";
import {
  moderationDecisionLabel,
  moderationResultLabel,
  providerLabel,
  readableCode
} from "./streaming-labels.js";

const resultTone: Record<StreamingModerationAction["result"], string> = {
  PENDING: "is-accent",
  SUCCEEDED: "is-success",
  FAILED: "is-danger",
  UNAVAILABLE: "",
  REVIEW: "is-warning",
  UNDONE: ""
};

type ModerationFilter = "ALL" | "REVIEW" | "TIMEOUTS" | "FAILED";

const filters: Record<ModerationFilter, { label: string; matches: (action: StreamingModerationAction) => boolean }> = {
  ALL: { label: "All", matches: () => true },
  REVIEW: { label: "Review", matches: (action) => action.result === "REVIEW" },
  TIMEOUTS: { label: "Timeouts", matches: (action) => action.durationSeconds !== null },
  FAILED: { label: "Failed", matches: (action) => action.result === "FAILED" || action.result === "UNAVAILABLE" }
};

export function StreamingModerationTab() {
  const [actions, setActions] = useState<StreamingModerationAction[]>([]);
  const [hasLoaded, setHasLoaded] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [filter, setFilter] = useState<ModerationFilter>("ALL");
  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      setActions((await api.streamingModerationActions()).actions);
      setError(null);
      setLoadFailed(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Moderation history could not be loaded.");
      setLoadFailed(true);
    } finally {
      setHasLoaded(true);
      setRefreshing(false);
    }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  async function act(id: string, action: () => Promise<unknown>, success: string, failure: string) {
    setBusy(id);
    setNotice(null);
    try { await action(); await refresh(); setNotice(success); }
    catch (cause) { setError(cause instanceof Error ? cause.message : failure); }
    finally { setBusy(null); }
  }
  const visible = actions.filter(filters[filter].matches);
  const chipOptions = (Object.keys(filters) as ModerationFilter[]).map((id) => ({ id, label: filters[id].label, count: actions.filter(filters[id].matches).length }));
  return <div className="streaming-bot-tab">
    <section className="streaming-section" aria-labelledby="streaming-moderation-heading">
      <div className="streaming-section-heading">
        <h3 id="streaming-moderation-heading" className="dock-kit-section-title">Moderation</h3>
        <DockIconButton label="Refresh moderation history" icon={RefreshCw} busy={refreshing} onClick={() => void refresh()} disabled={busy !== null || refreshing} />
      </div>
      <p className="streaming-hint">Warnings and 5 or 30 minute timeouts are separate from bot replies. Unclear messages wait in Review for your decision.</p>
      {error && actions.length ? <DockNotice onDismiss={() => setError(null)}>{error}</DockNotice> : null}
      {notice ? <DockNotice tone="success" onDismiss={() => setNotice(null)}>{notice}</DockNotice> : null}
      {actions.length ? <DockChips label="Moderation filter" options={chipOptions} value={filter} onChange={setFilter} /> : null}
      {!actions.length ? (
        !hasLoaded ? <DockState kind="loading" title="Loading moderation history…" />
          : loadFailed && error ? <DockState kind="error" title="Moderation history could not be loaded" detail={error} action={{ label: "Try again", onClick: () => void refresh() }} />
            : <DockState kind="empty" icon={ShieldCheck} title="No moderation actions yet" detail="Warnings and timeouts appear here once moderation is active." />
      ) : !visible.length ? <DockState kind="empty" icon={ShieldCheck} title="Nothing in this filter" detail="Choose another filter above." />
      : <ul className="streaming-bot-activity">
        {visible.map(action => <li key={action.id} className="dock-kit-card" data-result={action.result}>
          <div className="dock-kit-meta">
            <span className="dock-kit-card-title">{providerLabel(action.platform)} · {moderationDecisionLabel(action.decision)}</span>
            <span className={`dock-kit-badge ${resultTone[action.result] ?? ""}`}>{moderationResultLabel(action.result)}</span>
            <time className="dock-kit-meta-text" dateTime={action.createdAt}>{new Date(action.createdAt).toLocaleString()}</time>
          </div>
          {action.message ? <p className="streaming-moderation-message">{action.message}</p> : null}
          <p className="streaming-hint">
            {action.author ?? `Viewer ${action.userId}`} · {readableCode(action.reason)}{action.durationSeconds ? ` · ${action.durationSeconds / 60} minutes` : ""}
          </p>
          {action.safeErrorCode ? <small className="streaming-hint">Platform result: {readableCode(action.safeErrorCode)}</small> : null}
          {action.result === "SUCCEEDED" && action.durationSeconds ? (
            <div className="dock-kit-card-actions">
              <DockButton icon={Undo2} busy={busy === action.id} disabled={busy !== null}
                onClick={() => void act(action.id, () => api.undoStreamingModerationAction(action.id), "Timeout undone.", "The timeout could not be undone.")}>
                Undo timeout
              </DockButton>
            </div>
          ) : action.result === "REVIEW" ? (
            <div className="dock-kit-card-actions">
              <DockButton icon={Timer} busy={busy === action.id} disabled={busy !== null}
                onClick={() => void act(action.id, () => api.timeoutStreamingModerationReview(action.id, 300),
                  "Viewer timed out for 5 minutes.", "The timeout could not be applied.")}>
                Timeout 5 min
              </DockButton>
            </div>
          ) : null}
        </li>)}
      </ul>}
    </section>
  </div>;
}
