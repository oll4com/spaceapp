import { useEffect, useState } from "react";
import { MONITORING_COLLECTOR_DEFAULTS, monitoringCollectorUrlSchema, type CopilotLaunchSettings, type MonitoringCopilotPaneMetadata, type Pane } from "@space/contracts";
import { api } from "../../api.js";
import { AgentAccountField, useCopilotAccounts } from "../copilot-kit/AgentAccountField.js";
import { copilotAgentLabel, loadPaneAccountProfileId, type CopilotRuntimeOption } from "../copilot-kit/copilot-runtimes.js";
import { SpaceToggle } from "../ui-controls/SpaceToggle.js";

type SetupStep = "collector" | "autonomy" | "notifications" | "agent";
const STEP_LABELS: Record<SetupStep, string> = { collector: "Collector", autonomy: "Autonomy", notifications: "Notifications", agent: "Agent" };
type CollectorKey = keyof MonitoringCopilotPaneMetadata["settings"]["collector"];
const COLLECTOR_FIELDS: Array<[CollectorKey, string, string]> = [
  ["alertmanagerUrl", "Alertmanager", "Read every minute: the active alerts that are neither silenced nor inhibited."],
  ["prometheusUrl", "Prometheus", "Targets and PromQL queries, on demand."],
  ["lokiUrl", "Loki", "The guardian relay's messages every minute and count-only LogQL queries."]
];

/** Setup: where the collector is, how much the copilot may fix on its own, which alerts notify you, and the agent. */
export function SetupTab({ pane, settings, runtimeOptions, switching, accountRevision = 0, onSettingsChange, onSwitchAgent, onSetDefault }: {
  pane: Pane;
  settings: MonitoringCopilotPaneMetadata;
  runtimeOptions: CopilotRuntimeOption[];
  switching: boolean;
  accountRevision?: number;
  onSettingsChange(settings: MonitoringCopilotPaneMetadata): void;
  onSwitchAgent(runtimeId: string, accountProfileId?: string): void;
  onSetDefault(): void;
}) {
  const [step, setStep] = useState<SetupStep>("collector");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [launch, setLaunch] = useState<CopilotLaunchSettings | null>(null);
  const current = settings.settings;
  const [urls, setUrls] = useState(current.collector);
  const runtimeId = pane.terminalRuntimeId ?? null;
  const runtimeLabel = runtimeId ? copilotAgentLabel(runtimeId, runtimeOptions.find((option) => option.runtime.id === runtimeId)?.runtime) : "";
  const cliAccounts = useCopilotAccounts(step === "agent" ? runtimeId : null);
  const [paneAccount, setPaneAccount] = useState<string | null>(null);
  const isDefault = Boolean(launch && runtimeId && launch.runtimeId === runtimeId && !launch.askOnLaunch && (launch.accountProfileId ?? null) === paneAccount);
  const invalid = COLLECTOR_FIELDS.filter(([key]) => !monitoringCollectorUrlSchema.safeParse(urls[key]).success).map(([, label]) => label);
  const changed = COLLECTOR_FIELDS.some(([key]) => urls[key] !== current.collector[key]);

  useEffect(() => { setUrls(current.collector); }, [current.collector]);
  useEffect(() => {
    if (step !== "agent") return;
    let cancelled = false;
    api.userSettings().then((user) => { if (!cancelled) setLaunch(user.monitoringCopilot ?? null); }).catch(() => undefined);
    void loadPaneAccountProfileId(pane.id, runtimeId).then((accountProfileId) => { if (!cancelled) setPaneAccount(accountProfileId); });
    return () => { cancelled = true; };
  }, [accountRevision, pane.id, runtimeId, step]);

  async function patch(label: string, update: Partial<MonitoringCopilotPaneMetadata["settings"]>) {
    if (busy) return;
    const next = { ...settings, settings: { ...current, ...update } };
    setBusy(true);
    setMessage(null);
    onSettingsChange(next);
    try {
      onSettingsChange((await api.updateMonitoringCopilotSettings(pane.id, next)).metadata);
      setMessage(`${label} saved.`);
    } catch (error) {
      onSettingsChange(settings);
      setMessage(error instanceof Error ? error.message : `${label} could not be saved.`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="jc-setup" role="tabpanel" id="jc-panel-setup" aria-labelledby="jc-tab-setup">
      <nav className="jc-steps" aria-label="Setup steps">
        {(["collector", "autonomy", "notifications", "agent"] as const).map((id, index) => (
          <button key={id} type="button" className={`jc-step${step === id ? " selected" : ""}`} aria-current={step === id ? "step" : undefined} onClick={() => setStep(id)}>
            <span className="jc-step-index">{index + 1}</span>{STEP_LABELS[id]}
          </button>
        ))}
      </nav>

      {step === "collector" ? (
        <form className="jc-form" onSubmit={(event) => { event.preventDefault(); if (!invalid.length && changed) void patch("Collector", { collector: urls }); }}>
          <p className="jc-muted">The monitoring collector probes the fleet; Space only reads it. Addresses must be http://192.0.2.&lt;host&gt;:&lt;port&gt; on the private bridge.</p>
          {COLLECTOR_FIELDS.map(([key, label, detail]) => (
            <label key={key} className="jc-field"><span>{label}</span>
              <input value={urls[key]} maxLength={40} spellCheck={false} aria-invalid={!monitoringCollectorUrlSchema.safeParse(urls[key]).success}
                onChange={(event) => setUrls({ ...urls, [key]: event.target.value.trim() })} />
              <small className="jc-muted">{detail}</small>
            </label>
          ))}
          {invalid.length ? <p className="jc-message" role="status">Check {invalid.join(", ")}: use http://192.0.2.&lt;host&gt;:&lt;port&gt;.</p> : null}
          <div className="jc-actions">
            <button type="submit" className="jc-button primary" disabled={busy || !changed || invalid.length > 0}>Save collector</button>
            <button type="button" className="jc-button" disabled={busy} onClick={() => setUrls({ ...MONITORING_COLLECTOR_DEFAULTS })}>Use CT 210 defaults</button>
          </div>
          <SpaceToggle label="Paused" detail="The watch officer takes no new briefs while paused; Space keeps reading the alerts." checked={current.paused} disabled={busy} onChange={(checked) => void patch("Paused", { paused: checked })} />
        </form>
      ) : null}

      {step === "autonomy" ? (
        <div className="jc-form">
          <SpaceToggle label="Fix on its own" detail="Off (Assist): every change on a host waits for your approval here or through Nous. On: restarts, guest starts, config changes with a backup and cache clears run alone when they heal an alert that still fires, at most 4 an hour per host, each checked after; a failure alerts you at once."
            checked={current.autonomy === "FULL"} disabled={busy} onChange={(checked) => void patch("Autonomy", { autonomy: checked ? "FULL" : "ASSIST" })} />
          <p className="jc-muted">Reboots, deletes and anything outside those kinds always wait for a person.</p>
        </div>
      ) : null}

      {step === "notifications" ? (
        <div className="jc-form">
          <SpaceToggle label="Critical alerts" detail="A notification that needs your attention (and reaches Nous) for every critical alert; it resolves when the alert stops." checked={current.notifications.critical} disabled={busy}
            onChange={(checked) => void patch("Notifications", { notifications: { ...current.notifications, critical: checked } })} />
          <SpaceToggle label="Warnings" detail="A quiet notification in the list for every warning; no Nous turn." checked={current.notifications.warning} disabled={busy}
            onChange={(checked) => void patch("Notifications", { notifications: { ...current.notifications, warning: checked } })} />
          <SpaceToggle label="Guardian messages" detail="One card per kind of AI Guardian alert (backups, memory pressure, WAN, VPN); a recovery closes it." checked={current.notifications.guardian} disabled={busy}
            onChange={(checked) => void patch("Notifications", { notifications: { ...current.notifications, guardian: checked } })} />
          <SpaceToggle label="Telegram" detail="Off by default: the collector already sends critical alerts and guardian messages to Telegram itself." checked={current.notifications.telegram} disabled={busy}
            onChange={(checked) => void patch("Notifications", { notifications: { ...current.notifications, telegram: checked } })} />
        </div>
      ) : null}

      {step === "agent" ? (
        <div className="jc-form">
          <label className="jc-field">
            <span>Watch officer</span>
            <select value={runtimeId ?? ""} disabled={switching} onChange={(event) => { const next = event.target.value; if (next && next !== runtimeId) onSwitchAgent(next); }}>
              {!runtimeId ? <option value="">Choose a CLI…</option> : null}
              {runtimeOptions.map(({ runtime, ready, recommended }) => (
                <option key={runtime.id} value={runtime.id} disabled={!ready}>{runtime.displayName}{recommended ? " (recommended)" : ""}{ready ? "" : ` — ${runtime.statusReason}`}</option>
              ))}
            </select>
          </label>
          {runtimeId ? <AgentAccountField runtimeId={runtimeId} runtimeLabel={runtimeLabel} accounts={cliAccounts} value={paneAccount} disabled={switching} onChange={(profileId) => onSwitchAgent(runtimeId, profileId)} /> : null}
          <p className="jc-muted">Switching the watch officer or its account restarts this pane's CLI session; alerts, the feed and memory stay. Claude Code is recommended.</p>
          <div className="jc-default-agent">
            <p className="jc-muted" role="status">
              {launch && !launch.askOnLaunch
                ? `New Monitoring Copilot panes open with ${copilotAgentLabel(launch.runtimeId, runtimeOptions.find((option) => option.runtime.id === launch.runtimeId)?.runtime)}${launch.accountProfileId ? ` (${launch.accountProfileId} account)` : ""} without asking.`
                : "New Monitoring Copilot panes ask which watch officer to use."} Change it in Settings → Monitoring Copilot.
            </p>
            <button type="button" className="jc-button" disabled={!runtimeId || switching || isDefault} onClick={() => {
              onSetDefault();
              if (runtimeId) setLaunch({ runtimeId, accountProfileId: paneAccount, askOnLaunch: false });
            }}>{isDefault ? "This is your default watch officer" : "Set as default"}</button>
          </div>
        </div>
      ) : null}
      {message ? <p className="jc-message" role="status">{message}</p> : null}
    </div>
  );
}
