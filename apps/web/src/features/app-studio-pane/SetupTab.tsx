import { useEffect, useState } from "react";
import { APP_STUDIO_DEVICES, type AppStudioPaneMetadata, type CopilotLaunchSettings, type Pane } from "@space/contracts";
import { api } from "../../api.js";
import { AgentAccountField, useCopilotAccounts } from "../copilot-kit/AgentAccountField.js";
import { copilotAgentLabel, loadPaneAccountProfileId, type CopilotRuntimeOption } from "../copilot-kit/copilot-runtimes.js";
import { SpaceToggle } from "../ui-controls/SpaceToggle.js";

type SetupStep = "devices" | "notifications" | "agent";
const STEP_LABELS: Record<SetupStep, string> = { devices: "Devices", notifications: "Notifications", agent: "Agent" };

/** Setup: the phones a preview captures by default, the notifications and the app builder. */
export function SetupTab({ pane, settings, runtimeOptions, switching, accountRevision = 0, onSettingsChange, onSwitchAgent, onSetDefault }: {
  pane: Pane;
  settings: AppStudioPaneMetadata;
  runtimeOptions: CopilotRuntimeOption[];
  switching: boolean;
  accountRevision?: number;
  onSettingsChange(settings: AppStudioPaneMetadata): void;
  onSwitchAgent(runtimeId: string, accountProfileId?: string): void;
  onSetDefault(): void;
}) {
  const [step, setStep] = useState<SetupStep>("devices");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [launch, setLaunch] = useState<CopilotLaunchSettings | null>(null);
  const runtimeId = pane.terminalRuntimeId ?? null;
  const runtimeLabel = runtimeId ? copilotAgentLabel(runtimeId, runtimeOptions.find((option) => option.runtime.id === runtimeId)?.runtime) : "";
  const cliAccounts = useCopilotAccounts(step === "agent" ? runtimeId : null);
  const [paneAccount, setPaneAccount] = useState<string | null>(null);
  const isDefault = Boolean(launch && runtimeId && launch.runtimeId === runtimeId && !launch.askOnLaunch && (launch.accountProfileId ?? null) === paneAccount);
  const current = settings.settings;

  useEffect(() => {
    if (step !== "agent") return;
    let cancelled = false;
    api.userSettings().then((user) => { if (!cancelled) setLaunch(user.appStudio ?? null); }).catch(() => undefined);
    void loadPaneAccountProfileId(pane.id, runtimeId).then((accountProfileId) => { if (!cancelled) setPaneAccount(accountProfileId); });
    return () => { cancelled = true; };
  }, [accountRevision, pane.id, runtimeId, step]);

  async function patch(label: string, update: Partial<AppStudioPaneMetadata["settings"]>) {
    if (busy) return;
    const next = { ...settings, settings: { ...current, ...update } };
    setBusy(true);
    setMessage(null);
    onSettingsChange(next);
    try {
      onSettingsChange((await api.updateAppStudioSettings(pane.id, next)).metadata);
      setMessage(`${label} saved.`);
    } catch (error) {
      onSettingsChange(settings);
      setMessage(error instanceof Error ? error.message : `${label} could not be saved.`);
    } finally {
      setBusy(false);
    }
  }
  function toggleDevice(id: string, on: boolean) {
    const devices = on ? APP_STUDIO_DEVICES.map((device) => device.id).filter((entry) => entry === id || current.devices.includes(entry)) : current.devices.filter((entry) => entry !== id);
    if (!devices.length) { setMessage("Keep at least one device."); return; }
    void patch("Devices", { devices });
  }

  return (
    <div className="jc-setup" role="tabpanel" id="jc-panel-setup" aria-labelledby="jc-tab-setup">
      <nav className="jc-steps" aria-label="Setup steps">
        {(["devices", "notifications", "agent"] as const).map((id, index) => (
          <button key={id} type="button" className={`jc-step${step === id ? " selected" : ""}`} aria-current={step === id ? "step" : undefined} onClick={() => setStep(id)}>
            <span className="jc-step-index">{index + 1}</span>{STEP_LABELS[id]}
          </button>
        ))}
      </nav>

      {step === "devices" ? (
        <div className="jc-form">
          <p className="jc-muted">The phones every preview captures unless the app builder names others. These ten cover most phones in use today.</p>
          {(["ANDROID", "IOS"] as const).map((platform) => (
            <section key={platform} className="jc-form-section" aria-label={platform === "IOS" ? "iPhone" : "Android"}>
              <h4>{platform === "IOS" ? "iPhone" : "Android"}</h4>
              {APP_STUDIO_DEVICES.filter((device) => device.platform === platform).map((device) => (
                <SpaceToggle key={device.id} label={device.label} detail={`${device.width}×${device.height}`} checked={current.devices.includes(device.id)} disabled={busy}
                  onChange={(checked) => toggleDevice(device.id, checked)} />
              ))}
            </section>
          ))}
        </div>
      ) : null}

      {step === "notifications" ? (
        <div className="jc-form">
          <SpaceToggle label="Paused" detail="The app builder takes no new brief while paused." checked={current.paused} disabled={busy} onChange={(checked) => void patch("Paused", { paused: checked })} />
          <SpaceToggle label="Needs-you notifications" detail="Questions from the app builder and briefs it could not finish." checked={current.notifications.needsYou} disabled={busy}
            onChange={(checked) => void patch("Notifications", { notifications: { ...current.notifications, needsYou: checked } })} />
          <SpaceToggle label="Done notifications" detail="A notification for every finished brief." checked={current.notifications.done} disabled={busy}
            onChange={(checked) => void patch("Notifications", { notifications: { ...current.notifications, done: checked } })} />
          <SpaceToggle label="Telegram" detail="These notifications also go to the paired Telegram bot (Settings → Telegram)." checked={current.notifications.telegram} disabled={busy}
            onChange={(checked) => void patch("Notifications", { notifications: { ...current.notifications, telegram: checked } })} />
        </div>
      ) : null}

      {step === "agent" ? (
        <div className="jc-form">
          <label className="jc-field">
            <span>App builder</span>
            <select value={runtimeId ?? ""} disabled={switching} onChange={(event) => { const next = event.target.value; if (next && next !== runtimeId) onSwitchAgent(next); }}>
              {!runtimeId ? <option value="">Choose a CLI…</option> : null}
              {runtimeOptions.map(({ runtime, ready, recommended }) => (
                <option key={runtime.id} value={runtime.id} disabled={!ready}>{runtime.displayName}{recommended ? " (recommended)" : ""}{ready ? "" : ` — ${runtime.statusReason}`}</option>
              ))}
            </select>
          </label>
          {runtimeId ? <AgentAccountField runtimeId={runtimeId} runtimeLabel={runtimeLabel} accounts={cliAccounts} value={paneAccount} disabled={switching} onChange={(profileId) => onSwitchAgent(runtimeId, profileId)} /> : null}
          <p className="jc-muted">Switching the app builder or its account restarts this pane's CLI session; the app's project folder stays. Claude Code is recommended.</p>
          <div className="jc-default-agent">
            <p className="jc-muted" role="status">
              {launch && !launch.askOnLaunch
                ? `New App Studio panes open with ${copilotAgentLabel(launch.runtimeId, runtimeOptions.find((option) => option.runtime.id === launch.runtimeId)?.runtime)}${launch.accountProfileId ? ` (${launch.accountProfileId} account)` : ""} without asking.`
                : "New App Studio panes ask which app builder to use."} Change it in Settings → App Studio.
            </p>
            <button type="button" className="jc-button" disabled={!runtimeId || switching || isDefault} onClick={() => {
              onSetDefault();
              if (runtimeId) setLaunch({ runtimeId, accountProfileId: paneAccount, askOnLaunch: false });
            }}>{isDefault ? "This is your default app builder" : "Set as default"}</button>
          </div>
        </div>
      ) : null}
      {message ? <p className="jc-message" role="status">{message}</p> : null}
    </div>
  );
}
