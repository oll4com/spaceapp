import { useMemo, useState } from "react";
import { api } from "../../api.js";
import { useUiLanguage, uiText } from "../ui-language/ui-language.js";
import type { SecurityCopilotState, SecurityFindingView } from "./types.js";

const PRIORITIES = ["P0", "P1", "P2", "P3"] as const;
const PRIORITY_HINT: Record<(typeof PRIORITIES)[number], string> = { P0: "Exploited", P1: "Critical", P2: "High", P3: "Other" };
const STATUS_LABEL: Record<SecurityFindingView["status"], string> = {
  NEW: "New", TRIAGING: "Triaging", FIXING: "Fixing", FIXED: "Fixed", MITIGATED: "Mitigated", NOT_AFFECTED: "Not affected", ACCEPTED: "Accepted", FAILED: "Fix failed"
};
const OPERATOR_STATUSES: Array<SecurityFindingView["status"]> = ["ACCEPTED", "NOT_AFFECTED", "MITIGATED", "NEW"];
const OPERATOR_ACTION_LABEL: Partial<Record<SecurityFindingView["status"], string>> = { NEW: "Reopen", ACCEPTED: "Accept the risk", NOT_AFFECTED: "Mark not affected", MITIGATED: "Mark mitigated" };

/** The fleet's open findings, highest priority first: what Space found, on which host, from which source, and what the copilot does with it. */
export function FindingsView({ paneId, state, onChanged }: { paneId: string; state: SecurityCopilotState | null; onChanged(): void }) {
  const language = useUiLanguage();
  const t = (text: string, vars?: Record<string, string | number>) => uiText(language, text, vars);
  const [priority, setPriority] = useState<"ALL" | (typeof PRIORITIES)[number]>("ALL");
  const [hostId, setHostId] = useState("ALL");
  const [open, setOpen] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const hosts = useMemo(() => new Map((state?.hosts ?? []).map((host) => [host.id, host.label])), [state?.hosts]);
  const findings = (state?.findings ?? []).filter((finding) => (priority === "ALL" || finding.priority === priority) && (hostId === "ALL" || finding.hostId === hostId));

  if (!state) return <p className="jc-muted jc-empty">{t("Loading the fleet's findings…")}</p>;
  const counts = state.summary.openFindings;

  async function setStatus(finding: SecurityFindingView, status: SecurityFindingView["status"]) {
    if (busy || !note.trim()) { setMessage(t("Write why first: it stays with the finding.")); return; }
    setBusy(true);
    setMessage(null);
    try {
      await api.updateSecurityCopilotFinding(paneId, finding.id, status, note.trim());
      setMessage(t("{advisory}: {status}.", { advisory: finding.advisoryId, status: t(STATUS_LABEL[status]) }));
      setNote("");
      onChanged();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : t("That did not work."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="sc-findings">
      <div className="sc-counts" role="group" aria-label={t("Open findings by priority")}>
        <button type="button" className={`sc-count${priority === "ALL" ? " selected" : ""}`} aria-pressed={priority === "ALL"} onClick={() => setPriority("ALL")}>
          <strong>{counts.P0 + counts.P1 + counts.P2 + counts.P3}</strong><span>{t("All open")}</span>
        </button>
        {PRIORITIES.map((entry) => (
          <button key={entry} type="button" className={`sc-count priority-${entry.toLowerCase()}${priority === entry ? " selected" : ""}`} aria-pressed={priority === entry} onClick={() => setPriority(entry)}>
            <strong>{counts[entry]}</strong><span>{entry} · {t(PRIORITY_HINT[entry])}</span>
          </button>
        ))}
        <label className="jc-field sc-host-filter"><span>{t("Host")}</span>
          <select value={hostId} onChange={(event) => setHostId(event.target.value)}>
            <option value="ALL">{t("Every host")}</option>
            {state.hosts.map((host) => <option key={host.id} value={host.id}>{host.label}</option>)}
          </select>
        </label>
      </div>
      {state.summary.hosts.rebootRequired.length ? <p className="jc-notice sc-reboot" role="status">{t("Reboot pending on {hosts}: the copilot asks you before any reboot.", { hosts: state.summary.hosts.rebootRequired.join(", ") })}</p> : null}
      {message ? <p className="jc-message" role="status">{message}</p> : null}
      <ul className="jc-list sc-finding-list" aria-label={t("Open findings")}>
        {findings.map((finding) => (
          <li key={finding.id} className={`sc-finding priority-${finding.priority.toLowerCase()}`}>
            <button type="button" className="sc-finding-head" aria-expanded={open === finding.id} onClick={() => { setOpen(open === finding.id ? null : finding.id); setNote(""); }}>
              <span className={`jc-pill sc-priority priority-${finding.priority.toLowerCase()}`}>{finding.priority}</span>
              <strong className="sc-finding-id">{finding.advisoryId}</strong>
              {finding.kev ? <span className="jc-pill sc-kev" title={t("CISA Known Exploited Vulnerabilities")}>{t("Exploited")}</span> : null}
              <span className="sc-finding-host">{hosts.get(finding.hostId) ?? finding.hostId}</span>
              <span className={`jc-pill status-${finding.status.toLowerCase()}`}>{t(STATUS_LABEL[finding.status])}</span>
            </button>
            <p className="sc-finding-line">{finding.package} {finding.installedVersion}{finding.fixedVersion ? ` → ${finding.fixedVersion}` : ""} · {finding.sources.join(", ")}{finding.cvss !== null ? ` · CVSS ${finding.cvss}` : ""}</p>
            {open === finding.id ? (
              <div className="sc-finding-detail">
                <p>{finding.title}</p>
                {finding.aliases.length ? <p className="jc-muted">{t("Also: {aliases}", { aliases: finding.aliases.join(", ") })}</p> : null}
                {finding.references.length ? <p className="sc-refs">{finding.references.slice(0, 3).map((url) => <a key={url} href={url} target="_blank" rel="noreferrer noopener">{new URL(url).hostname}</a>)}</p> : null}
                {finding.confirmedBy ? <p className="jc-muted">{t("Confirmed on {source}", { source: finding.confirmedBy })}</p> : null}
                <label className="jc-field"><span>{t("Your decision and why")}</span>
                  <input value={note} maxLength={2000} placeholder={t("e.g. Plesk backported the fix on 21 Oct")} onChange={(event) => setNote(event.target.value)} /></label>
                <div className="jc-actions">
                  {OPERATOR_STATUSES.filter((status) => status !== finding.status).map((status) => (
                    <button key={status} type="button" className="jc-button" disabled={busy || !note.trim()} onClick={() => void setStatus(finding, status)}>
                      {t(OPERATOR_ACTION_LABEL[status] ?? status)}
                    </button>
                  ))}
                </div>
              </div>
            ) : null}
          </li>
        ))}
      </ul>
      {!findings.length ? <p className="jc-muted jc-empty">{state.hosts.length ? t("No open findings here.") : t("No hosts yet: the copilot discovers and inventories them when its agent runs.")}</p> : null}
    </div>
  );
}
