import { useEffect, useState } from "react";
import { APP_STUDIO_DEVICES, type AppStudioPaneMetadata, type CopilotLaunchSettings, type Pane } from "@space/contracts";
import { api } from "../../api.js";
import { AgentAccountField, useCopilotAccounts } from "../copilot-kit/AgentAccountField.js";
import { copilotAgentLabel, loadPaneAccountProfileId, type CopilotRuntimeOption } from "../copilot-kit/copilot-runtimes.js";
import { SpaceToggle } from "../ui-controls/SpaceToggle.js";
import { useUiLanguage, uiText } from "../ui-language/ui-language.js";

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
  const language = useUiLanguage();
  const t = (text: string, vars?: Record<string, string | number>) => uiText(language, text, vars);
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
      setMessage(t("{label} saved.", { label: t(label) }));
    } catch (error) {
      onSettingsChange(settings);
      setMessage(error instanceof Error ? error.message : t("{label} could not be saved.", { label: t(label) }));
    } finally {
      setBusy(false);
    }
  }
  function toggleDevice(id: string, on: boolean) {
    const devices = on ? APP_STUDIO_DEVICES.map((device) => device.id).filter((entry) => entry === id || current.devices.includes(entry)) : current.devices.filter((entry) => entry !== id);
    if (!devices.length) { setMessage(t("Keep at least one device.")); return; }
    void patch("Devices", { devices });
  }

  return (
    <div className="jc-setup" role="tabpanel" id="jc-panel-setup" aria-labelledby="jc-tab-setup">
      <nav className="jc-steps" aria-label={t("Setup steps")}>
        {(["devices", "notifications", "agent"] as const).map((id, index) => (
          <button key={id} type="button" className={`jc-step${step === id ? " selected" : ""}`} aria-current={step === id ? "step" : undefined} onClick={() => setStep(id)}>
            <span className="jc-step-index">{index + 1}</span>{t(STEP_LABELS[id])}
          </button>
        ))}
      </nav>

      {step === "devices" ? (
        <div className="jc-form">
          <p className="jc-muted">{t("The devices every preview captures unless the app builder names others. The ten phones cover most phones in use today; the tablet comes in portrait and landscape.")}</p>
          {(["ANDROID", "IOS"] as const).map((platform) => (
            <section key={platform} className="jc-form-section" aria-label={platform === "IOS" ? t("iPhone") : t("Android")}>
              <h4>{platform === "IOS" ? t("iPhone") : t("Android")}</h4>
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
          <SpaceToggle label={t("Paused")} detail={t("The app builder takes no new brief while paused.")} checked={current.paused} disabled={busy} onChange={(checked) => void patch("Paused", { paused: checked })} />
          <SpaceToggle label={t("Needs-you notifications")} detail={t("Questions from the app builder and briefs it could not finish.")} checked={current.notifications.needsYou} disabled={busy}
            onChange={(checked) => void patch("Notifications", { notifications: { ...current.notifications, needsYou: checked } })} />
          <SpaceToggle label={t("Done notifications")} detail={t("A notification for every finished brief.")} checked={current.notifications.done} disabled={busy}
            onChange={(checked) => void patch("Notifications", { notifications: { ...current.notifications, done: checked } })} />
          <SpaceToggle label="Telegram" detail={t("These notifications also go to the paired Telegram bot (Settings → Telegram).")} checked={current.notifications.telegram} disabled={busy}
            onChange={(checked) => void patch("Notifications", { notifications: { ...current.notifications, telegram: checked } })} />
        </div>
      ) : null}

      {step === "agent" ? (
        <div className="jc-form">
          <label className="jc-field">
            <span>{t("App builder")}</span>
            <select value={runtimeId ?? ""} disabled={switching} onChange={(event) => { const next = event.target.value; if (next && next !== runtimeId) onSwitchAgent(next); }}>
              {!runtimeId ? <option value="">{t("Choose a CLI…")}</option> : null}
              {runtimeOptions.map(({ runtime, ready, recommended }) => (
                <option key={runtime.id} value={runtime.id} disabled={!ready}>{runtime.displayName}{recommended ? ` (${t("recommended")})` : ""}{ready ? "" : ` — ${runtime.statusReason}`}</option>
              ))}
            </select>
          </label>
          {runtimeId ? <AgentAccountField runtimeId={runtimeId} runtimeLabel={runtimeLabel} accounts={cliAccounts} value={paneAccount} disabled={switching} onChange={(profileId) => onSwitchAgent(runtimeId, profileId)} /> : null}
          <p className="jc-muted">{t("Switching the app builder or its account restarts this pane's CLI session; the app's project folder stays. Claude Code is recommended.")}</p>
          <div className="jc-default-agent">
            <p className="jc-muted" role="status">
              {launch && !launch.askOnLaunch
                ? launch.accountProfileId
                  ? t("New App Studio panes open with {agent} ({account} account) without asking.", { agent: copilotAgentLabel(launch.runtimeId, runtimeOptions.find((option) => option.runtime.id === launch.runtimeId)?.runtime), account: launch.accountProfileId })
                  : t("New App Studio panes open with {agent} without asking.", { agent: copilotAgentLabel(launch.runtimeId, runtimeOptions.find((option) => option.runtime.id === launch.runtimeId)?.runtime) })
                : t("New App Studio panes ask which app builder to use.")} {t("Change it in Settings → App Studio.")}
            </p>
            <button type="button" className="jc-button" disabled={!runtimeId || switching || isDefault} onClick={() => {
              onSetDefault();
              if (runtimeId) setLaunch({ runtimeId, accountProfileId: paneAccount, askOnLaunch: false });
            }}>{isDefault ? t("This is your default app builder") : t("Set as default")}</button>
          </div>
        </div>
      ) : null}
      {message ? <p className="jc-message" role="status">{message}</p> : null}
    </div>
  );
}
