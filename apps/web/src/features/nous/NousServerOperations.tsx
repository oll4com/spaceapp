import type { ReleaseActionResponse, ReleasesReport } from "@space/contracts";
import { useCallback, useEffect, useState } from "react";
import { api, SpaceApiError, type ServerOpsService, type ServerOpsStatus, type ServerOpsUnit } from "../../api.js";
import { formatUserTime } from "../date-time-settings/date-time-settings.js";
import { DockButton } from "../dock-kit/DockKit.js";
import { uiText, useUiLanguage } from "../ui-language/ui-language.js";
import "./nous-server-operations.css";

export interface ServerOpsClient {
  serverOps(): Promise<ServerOpsStatus>;
  runServerOp(op: "clean-disk" | "deploy-remotes" | "clean-worktrees" | "restart", service?: ServerOpsService): Promise<{ message: string }>;
  releases(): Promise<ReleasesReport>;
  promoteRelease(): Promise<ReleaseActionResponse>;
}
type OpId = "promote" | "deploy-remotes" | "clean-disk" | "clean-worktrees" | "restart";

const OPS: Array<{ id: OpId; label: string; confirm: string }> = [
  { id: "promote", label: "Promote dev to stable", confirm: "Stable builds and restarts once (about 5 minutes). CLI sessions keep running; a failed check rolls stable back." },
  { id: "deploy-remotes", label: "Push to GitHub and Gitea", confirm: "Pushes stable's verified main to GitHub and Gitea. Never a force push." },
  { id: "clean-disk", label: "Clean disk", confirm: "Runs the daily retention now: logs, caches, orphan and merged clean worktrees, superseded CLI versions. Records are never deleted." },
  { id: "clean-worktrees", label: "Clean worktrees", confirm: "Removes merged, clean worktrees. One with changes, unmerged work or an open pane stays." },
  { id: "restart", label: "Restart a service", confirm: "The guarded restart: refused while a merge queue is busy or, for the pane hosts, while a CLI session runs." }
];
const SERVICES: Array<{ id: ServerOpsService; label: string }> = [{ id: "browser-host", label: "Browser Host" }, { id: "pane-hosts", label: "Pane hosts (CLI panes)" }];

type T = (text: string, vars?: Record<string, string | number>) => string;
const unitLine = (t: T, unit: ServerOpsUnit) => unit.state === "running" ? (unit.startedAt ? t("Running since {time}.", { time: formatUserTime(unit.startedAt) }) : t("Running since now."))
  : unit.result ? `${t(unit.result === "success" ? "Last run succeeded" : "Last run failed")}${unit.finishedAt ? ` · ${formatUserTime(unit.finishedAt)}` : ""}.` : t("Not run yet.");
// The API's answers with a number or an id in them (server-ops-routes.ts) as table keys; the fixed ones are keys as they are, anything else stays as written.
const ANSWERS: Array<[RegExp, string]> = [
  [/^Removed (?<cleaned>\d+) worktrees, kept (?<kept>\d+)\.$/, "Removed {cleaned} worktrees, kept {kept}."],
  [/^(?<service>\S+) restarted and ready\.$/, "{service} restarted and ready."],
  [/^Not restarted: (?<count>\d+) sessions are running on it\.$/, "Not restarted: {count} sessions are running on it."],
  [/^(?<action>\S+) is already running\.$/, "{action} is already running."],
  [/^(?<action>\S+) failed; the API log has the cause\.$/, "{action} failed; the API log has the cause."]
];
const answer = (t: T, text: string) => {
  for (const [pattern, key] of ANSWERS) { const groups = pattern.exec(text)?.groups; if (groups) return t(key, groups); }
  return t(text);
};

/** Settings → Nous → Operations (operator nous_msg:5249d11d): the guarded server operations, ADMIN only; gone where the API has no route (public installs). */
export function NousServerOperations({ client = api }: { client?: ServerOpsClient }) {
  const [status, setStatus] = useState<ServerOpsStatus | "hidden" | null>(null);
  const [release, setRelease] = useState<ReleasesReport | null>(null);
  const [confirming, setConfirming] = useState<OpId | null>(null);
  const [service, setService] = useState<ServerOpsService>("browser-host");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const language = useUiLanguage();
  const t: T = (text, vars) => uiText(language, text, vars);

  const load = useCallback(async () => {
    try { setStatus(await client.serverOps()); } catch (caught) {
      if (caught instanceof SpaceApiError && caught.status === 404) return setStatus("hidden");
      setResult(caught instanceof Error ? caught.message : "Operations could not be loaded.");
    }
    setRelease(await client.releases().catch(() => null));
  }, [client]);
  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 15_000);
    return () => window.clearInterval(timer);
  }, [load]);

  if (status === "hidden") return null;
  const run = async (op: OpId) => {
    setBusy(true);
    setResult(null);
    try {
      setResult((op === "promote" ? await client.promoteRelease() : await client.runServerOp(op, op === "restart" ? service : undefined)).message);
    } catch (caught) {
      setResult(caught instanceof Error ? caught.message : "The operation failed.");
    } finally {
      setBusy(false);
      setConfirming(null);
      await load();
    }
  };
  const live = status;
  const state: Record<OpId, string> = {
    promote: release?.promotion ? t("Last promotion {id} · {status}. {count} change(s) on dev.", { id: release.promotion.id, status: release.promotion.status, count: release.pendingCount })
      : t("{count} change(s) on dev; no promotion yet.", { count: release?.pendingCount ?? 0 }),
    "deploy-remotes": live ? [unitLine(t, live.deployRemotes), ...live.deployRemotes.lines].join(" ") : "",
    "clean-disk": live ? unitLine(t, live.cleanDisk) : "",
    "clean-worktrees": t("Removes only what is merged and clean."),
    restart: live ? live.services.map((item) => `${t(SERVICES.find((entry) => entry.id === item.id)?.label ?? item.id)}: ${t(item.state)}`).join(" · ") : ""
  };

  return (
    <section className="nous-server-ops" aria-label={t("Server operations")} aria-busy={busy || !status}>
      <div className="settings-flat-subheading">
        <strong>{t("Operations")}</strong>
        <small>{t(!live ? "Loading operations…" : !live.managedHere ? "Operations run only on the stable instance."
          : live.queueActive ? "The stable merge queue is busy; operations wait until it is idle." : "Each one asks you to confirm first and is recorded in the audit log.")}</small>
      </div>
      {OPS.map((op) => (
        <div key={op.id} className="settings-flat-row nous-server-ops-row">
          <span className="settings-flat-row-copy"><strong>{t(op.label)}</strong><small>{confirming === op.id ? t(op.confirm) : state[op.id]}</small></span>
          <div className="nous-server-ops-actions">
            {op.id === "restart" ? (
              <select aria-label={t("Service to restart")} value={service} disabled={busy} onChange={(event) => setService(event.target.value as ServerOpsService)}>
                {SERVICES.map((item) => <option key={item.id} value={item.id}>{t(item.label)}</option>)}
              </select>
            ) : null}
            {confirming === op.id ? <>
              <DockButton tone="primary" busy={busy} disabled={busy} aria-label={t("Confirm: {label}", { label: t(op.label) })} onClick={() => void run(op.id)}>{t("Confirm")}</DockButton>
              <DockButton disabled={busy} aria-label={t("Cancel: {label}", { label: t(op.label) })} onClick={() => setConfirming(null)}>{t("Cancel")}</DockButton>
            </> : (
              <DockButton disabled={busy || !live?.managedHere} aria-label={t(op.label)} onClick={() => { setResult(null); setConfirming(op.id); }}>
                {t(op.id === "restart" ? "Restart" : "Run")}
              </DockButton>
            )}
          </div>
        </div>
      ))}
      <div role="status" className="nous-server-ops-result">{result ? answer(t, result) : null}</div>
    </section>
  );
}
