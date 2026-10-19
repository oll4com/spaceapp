import type { NousOverview } from "@space/contracts";
import { formatUserTime } from "../date-time-settings/date-time-settings.js";
import { DockState } from "../dock-kit/DockKit.js";
import { requestNousFocus } from "../nous-focus/nous-focus-events.js";
import { Nous } from "../ui-theme/app-icons.js";

/**
 * The Nous dock's Panes cards (operator request 2026-10-17, plan clipboard:MAongwnxq9Ro): every open pane with when Nous last
 * checked it, its verdict and the next check; due panes first and marked; a click takes the operator to the pane. Each card shows
 * the pane's newest report (plan clipboard:ot6-jLKOWDNC).
 */
const VERDICTS: Record<string, string> = {
  OK_WORKING: "Working fine", WAITING_OPERATOR: "Waits for you", WAITING_DATE: "Waits for a date", NEEDS_ACTION: "Needs action",
  BLOCKED: "Blocked", OPERATOR_TEST: "Your test pane"
};

export function NousPanesView({ overview }: { overview: NousOverview | null }) {
  if (!overview) return <DockState kind="loading" title="Loading the panes" />;
  const panes = [...(overview.panes ?? [])].sort((a, b) => Number(b.overdue) - Number(a.overdue) || a.room.localeCompare(b.room) || a.pane.localeCompare(b.pane));
  if (!panes.length) return <DockState kind="empty" icon={Nous} title="No open panes" detail="Nous checks every open pane here, with the time of its last check." />;
  const due = panes.filter((pane) => pane.overdue).length;
  return (
    <div className="nous-panes" role="list" aria-label={`Panes, ${due} due`}>
      {panes.map((pane) => (
        <button key={pane.paneId} type="button" role="listitem" className={`nous-pane-card${pane.overdue ? " is-overdue" : ""}`}
          aria-label={`${pane.room} · ${pane.pane}${pane.overdue ? ", due" : ""}`}
          onClick={() => requestNousFocus({ roomId: pane.roomId, paneId: pane.paneId, ownerUserId: null, immediate: true })}>
          <span className="nous-pane-card-head">
            <strong>{pane.pane}</strong>
            <span className="nous-muted">{pane.room}</span>
            {pane.verdict === "OPERATOR_TEST" ? <span className="nous-pane-badge">Keep open</span> : null}
          </span>
          <span className="nous-pane-card-state">{pane.state ?? "unknown"}{pane.verdict ? ` · ${VERDICTS[pane.verdict] ?? pane.verdict}` : ""}</span>
          {pane.note ? <span className="nous-pane-card-note">{pane.note}</span> : null}
          {pane.report ? <span className="nous-pane-card-report" title={pane.report.summary}>
            {`Reported ${formatUserTime(pane.report.at)} · ${pane.report.status.toLowerCase().replace(/_/g, " ")}: ${pane.report.summary}`}</span> : null}
          <span className="nous-pane-card-times">
            <span>{pane.checkedAt ? `Checked ${formatUserTime(pane.checkedAt)}` : "Never checked"}</span>
            <span className={pane.overdue ? "is-overdue" : undefined}>{pane.overdue ? "Due now" : `Next ${formatUserTime(pane.nextCheckAt ?? pane.dueAt)}`}</span>
          </span>
        </button>
      ))}
    </div>
  );
}
