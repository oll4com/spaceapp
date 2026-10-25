import { useState } from "react";
import type { JobApplication, JobApplyStats } from "@space/contracts";
import { api } from "../../api.js";
import { useDockConfirm } from "../dock-kit/DockKit.js";

const OPEN_STATUSES = new Set<JobApplication["status"]>(["QUEUED", "FILLING", "NEEDS_USER"]);

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

/** "Reset and start over" for a new job search: says what changes and what stays before anything happens; deletes nothing. */
export function StartOver({ campaignStartedAt, stats, applications, onDone }: {
  campaignStartedAt: string | null;
  stats: JobApplyStats | null;
  applications: JobApplication[];
  onDone(): void;
}) {
  const { confirm, confirmDialog } = useDockConfirm();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const open = applications.filter((application) => OPEN_STATUSES.has(application.status)).length;
  const sent = stats ? stats.totals.applied + stats.earlier.archived.sent + stats.earlier.imported.sent : null;

  async function startOver() {
    const accepted = await confirm({
      title: "Reset Job Copilot and start over?",
      message: (
        <div className="jc-start-over-detail">
          <p>This will:</p>
          <ul>
            <li>stop the copilot in every Job Copilot pane where it is running;</li>
            <li>close {plural(open, "open posting")} (queued, in progress or waiting for you) as Failed; they stay listed and can be queued again;</li>
            <li>start the counters and the per-day history from zero today.</li>
          </ul>
          <p>Kept: {sent === null ? "every sent application" : `all ${plural(sent, "sent application")}`} as archived history (Job Copilot still never applies to the same posting twice), your profile, CV, the answers the copilot has learned, and the mailbox.</p>
          <p><strong>Nothing is deleted.</strong></p>
        </div>
      ),
      confirmLabel: "Reset and start over",
      tone: "danger"
    });
    if (!accepted) return;
    setBusy(true);
    setMessage(null);
    try {
      const { reset } = await api.resetJobApply(campaignStartedAt);
      setMessage(`Started over: ${plural(reset.closed, "open posting")} closed, ${plural(reset.runsStopped, "run")} stopped. Nothing was deleted.`);
      onDone();
    } catch (caught) {
      setMessage(caught instanceof Error ? caught.message : "The reset failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="jc-form-section jc-start-over" aria-label="Start over">
      <h4>Start over</h4>
      <p className="jc-muted">
        {campaignStartedAt ? `Counting since the reset on ${new Date(campaignStartedAt).toLocaleDateString("en", { month: "short", day: "numeric", year: "numeric" })}. ` : ""}
        For a new job search: the counters restart from zero and earlier applications become archived history. Nothing is deleted.
      </p>
      <div>
        <button type="button" className="jc-button ghost danger" disabled={busy} onClick={() => void startOver()}>Reset and start over…</button>
      </div>
      {message ? <p className="jc-message" role="status">{message}</p> : null}
      {confirmDialog}
    </section>
  );
}
