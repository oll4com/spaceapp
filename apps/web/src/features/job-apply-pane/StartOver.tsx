import { useState } from "react";
import type { JobApplication, JobApplyStats } from "@space/contracts";
import { api } from "../../api.js";
import { useDockConfirm } from "../dock-kit/DockKit.js";
import { uiText, useUiLanguage } from "../ui-language/ui-language.js";

const OPEN_STATUSES = new Set<JobApplication["status"]>(["QUEUED", "FILLING", "NEEDS_USER"]);


/** "Reset and start over" for a new job search: says what changes and what stays before anything happens; deletes nothing. */
export function StartOver({ campaignStartedAt, stats, applications: tracked, onDone }: {
  campaignStartedAt: string | null;
  stats: JobApplyStats | null;
  applications: JobApplication[];
  onDone(): void;
}) {
  const language = useUiLanguage();
  const t = (text: string, vars?: Record<string, string | number>) => uiText(language, text, vars);
  const { confirm, confirmDialog } = useDockConfirm();
  const postings = (count: number) => count === 1 ? t("1 open posting") : t("{count} open postings", { count });
  const applications = (count: number) => count === 1 ? t("1 sent application") : t("{count} sent applications", { count });
  const runs = (count: number) => count === 1 ? t("1 run") : t("{count} runs", { count });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const open = tracked.filter((application) => OPEN_STATUSES.has(application.status)).length;
  const sent = stats ? stats.totals.applied + stats.earlier.archived.sent + stats.earlier.imported.sent : null;

  async function startOver() {
    const accepted = await confirm({
      title: t("Reset Job Copilot and start over?"),
      message: (
        <div className="jc-start-over-detail">
          <p>{t("This will:")}</p>
          <ul>
            <li>{t("stop the copilot in every Job Copilot pane where it is running;")}</li>
            <li>{t("close {postings} (queued, in progress or waiting for you) as Failed; they stay listed and can be queued again;", { postings: postings(open) })}</li>
            <li>{t("start the counters and the per-day history from zero today.")}</li>
          </ul>
          <p>{t("Kept: {sent} as archived history (Job Copilot still never applies to the same posting twice), your profile, CV, the answers the copilot has learned, and the mailbox.",
            { sent: sent === null ? t("every sent application") : t("all {applications}", { applications: applications(sent) }) })}</p>
          <p><strong>{t("Nothing is deleted.")}</strong></p>
        </div>
      ),
      confirmLabel: t("Reset and start over"),
      tone: "danger"
    });
    if (!accepted) return;
    setBusy(true);
    setMessage(null);
    try {
      const { reset } = await api.resetJobApply(campaignStartedAt);
      setMessage(t("Started over: {closed} closed, {runs} stopped. Nothing was deleted.", { closed: postings(reset.closed), runs: runs(reset.runsStopped) }));
      onDone();
    } catch (caught) {
      setMessage(caught instanceof Error ? caught.message : t("The reset failed."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="jc-form-section jc-start-over" aria-label={t("Start over")}>
      <h4>{t("Start over")}</h4>
      <p className="jc-muted">
        {campaignStartedAt ? `${t("Counting since the reset on {date}.", { date: new Date(campaignStartedAt).toLocaleDateString(language === "el" ? "el" : "en", { month: "short", day: "numeric", year: "numeric" }) })} ` : ""}
        {t("For a new job search: the counters restart from zero and earlier applications become archived history. Nothing is deleted.")}
      </p>
      <div>
        <button type="button" className="jc-button ghost danger" disabled={busy} onClick={() => void startOver()}>{t("Reset and start over…")}</button>
      </div>
      {message ? <p className="jc-message" role="status">{message}</p> : null}
      {confirmDialog}
    </section>
  );
}
