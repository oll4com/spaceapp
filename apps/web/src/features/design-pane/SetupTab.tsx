import { useEffect, useState } from "react";
import {
  DESIGN_ENGINE_LABELS, DESIGN_FORMATS, DESIGN_IMAGE_ENGINES, DESIGN_NETWORK_LABELS, DESIGN_TEMPLATE_IDS, DESIGN_TEMPLATE_LABELS,
  type CopilotLaunchSettings, type DesignBrandKit, type DesignImageEngine, type DesignPaneMetadata, type DesignTemplateId, type Pane
} from "@space/contracts";
import { api } from "../../api.js";
import { AgentAccountField, useCopilotAccounts } from "../copilot-kit/AgentAccountField.js";
import { copilotAgentLabel, loadPaneAccountProfileId, type CopilotRuntimeOption } from "../copilot-kit/copilot-runtimes.js";
import { SpaceToggle } from "../ui-controls/SpaceToggle.js";

type SetupStep = "defaults" | "requests" | "agent";
const STEP_LABELS: Record<SetupStep, string> = { defaults: "Defaults", requests: "Requests", agent: "Agent" };

/** Setup: the pane's default format, engine, template and brand kit; how requests from others are delivered; and the designer. */
export function SetupTab({ pane, settings, brandKits, runtimeOptions, switching, accountRevision = 0, onSettingsChange, onSwitchAgent, onSetDefault }: {
  pane: Pane;
  settings: DesignPaneMetadata;
  brandKits: DesignBrandKit[];
  runtimeOptions: CopilotRuntimeOption[];
  switching: boolean;
  accountRevision?: number;
  onSettingsChange(settings: DesignPaneMetadata): void;
  onSwitchAgent(runtimeId: string, accountProfileId?: string): void;
  onSetDefault(): void;
}) {
  const [step, setStep] = useState<SetupStep>("defaults");
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
    api.userSettings().then((user) => { if (!cancelled) setLaunch(user.design ?? null); }).catch(() => undefined);
    void loadPaneAccountProfileId(pane.id, runtimeId).then((accountProfileId) => { if (!cancelled) setPaneAccount(accountProfileId); });
    return () => { cancelled = true; };
  }, [accountRevision, pane.id, runtimeId, step]);

  async function patch(label: string, update: Partial<DesignPaneMetadata["settings"]>) {
    if (busy) return;
    const next = { ...settings, settings: { ...current, ...update } };
    setBusy(true);
    setMessage(null);
    onSettingsChange(next);
    try {
      onSettingsChange((await api.updateDesignSettings(pane.id, next)).metadata);
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
        {(["defaults", "requests", "agent"] as const).map((id, index) => (
          <button key={id} type="button" className={`jc-step${step === id ? " selected" : ""}`} aria-current={step === id ? "step" : undefined} onClick={() => setStep(id)}>
            <span className="jc-step-index">{index + 1}</span>{STEP_LABELS[id]}
          </button>
        ))}
      </nav>

      {step === "defaults" ? (
        <div className="jc-form">
          <label className="jc-field"><span>Default format</span>
            <select value={current.defaultFormatId} disabled={busy} aria-label="Default format" onChange={(event) => void patch("Default format", { defaultFormatId: event.target.value })}>
              {current.defaultFormatId.startsWith("custom-") ? <option value={current.defaultFormatId}>{current.defaultFormatId}</option> : null}
              {DESIGN_FORMATS.map((format) => <option key={format.id} value={format.id}>{DESIGN_NETWORK_LABELS[format.network]} · {format.label} · {format.width}×{format.height}</option>)}
            </select></label>
          <label className="jc-field"><span>Default engine</span>
            <select value={current.defaultEngine} disabled={busy} aria-label="Default engine" onChange={(event) => void patch("Default engine", { defaultEngine: event.target.value as DesignImageEngine })}>
              {DESIGN_IMAGE_ENGINES.map((id) => <option key={id} value={id}>{DESIGN_ENGINE_LABELS[id]}</option>)}
            </select></label>
          <label className="jc-field"><span>Default template</span>
            <select value={current.defaultTemplateId} disabled={busy} aria-label="Default template" onChange={(event) => void patch("Default template", { defaultTemplateId: event.target.value as DesignTemplateId })}>
              {DESIGN_TEMPLATE_IDS.map((id) => <option key={id} value={id}>{DESIGN_TEMPLATE_LABELS[id]}</option>)}
            </select></label>
          <label className="jc-field"><span>Brand kit</span>
            <select value={current.brandKitId} disabled={busy} aria-label="Default brand kit" onChange={(event) => void patch("Brand kit", { brandKitId: event.target.value })}>
              {brandKits.map((kit) => <option key={kit.id} value={kit.id}>{kit.name}</option>)}
            </select></label>
          <label className="jc-field"><span>Motion length (seconds)</span>
            <input type="number" min={1} max={90} value={current.motion.defaultDurationSec} disabled={busy} aria-label="Motion length in seconds"
              onChange={(event) => void patch("Motion length", { motion: { ...current.motion, defaultDurationSec: Math.max(1, Math.min(90, Number.parseInt(event.target.value, 10) || 8)) } })} /></label>
          <SpaceToggle label="Also make a GIF" detail="Motion pieces come as an MP4 and a GIF." checked={current.motion.gif} disabled={busy} onChange={(checked) => void patch("GIF", { motion: { ...current.motion, gif: checked } })} />
        </div>
      ) : null}

      {step === "requests" ? (
        <div className="jc-form">
          <div className="jc-chips" role="radiogroup" aria-label="Requests from others">
            <button type="button" role="radio" aria-checked={current.requestAutonomy === "AUTO"} className={`jc-chip${current.requestAutonomy === "AUTO" ? " selected" : ""}`} disabled={busy}
              onClick={() => void patch("Requests", { requestAutonomy: "AUTO" })}>Deliver automatically</button>
            <button type="button" role="radio" aria-checked={current.requestAutonomy === "APPROVAL"} className={`jc-chip${current.requestAutonomy === "APPROVAL" ? " selected" : ""}`} disabled={busy}
              onClick={() => void patch("Requests", { requestAutonomy: "APPROVAL" })}>Needs my approval</button>
          </div>
          <p className="jc-muted">{current.requestAutonomy === "AUTO" ? "Designs other agents and panes ask for go back to them as soon as the designer finishes." : "The designer's deliveries wait in the Requests tab until you approve them."}</p>
          <SpaceToggle label="Paused" detail="The designer takes no new request while paused; the Studio keeps working." checked={current.paused} disabled={busy} onChange={(checked) => void patch("Paused", { paused: checked })} />
          <SpaceToggle label="Needs-you notifications" detail="Questions, approvals, failures and requests waiting for a Design pane." checked={current.notifications.needsYou} disabled={busy}
            onChange={(checked) => void patch("Notifications", { notifications: { ...current.notifications, needsYou: checked } })} />
          <SpaceToggle label="Delivered notifications" detail="A notification for every design delivered to its requester." checked={current.notifications.delivered} disabled={busy}
            onChange={(checked) => void patch("Notifications", { notifications: { ...current.notifications, delivered: checked } })} />
          <SpaceToggle label="Telegram" detail="These notifications also go to the paired Telegram bot (Settings → Telegram)." checked={current.notifications.telegram} disabled={busy}
            onChange={(checked) => void patch("Notifications", { notifications: { ...current.notifications, telegram: checked } })} />
        </div>
      ) : null}

      {step === "agent" ? (
        <div className="jc-form">
          <label className="jc-field">
            <span>Designer</span>
            <select value={runtimeId ?? ""} disabled={switching} onChange={(event) => { const next = event.target.value; if (next && next !== runtimeId) onSwitchAgent(next); }}>
              {!runtimeId ? <option value="">Choose a CLI…</option> : null}
              {runtimeOptions.map(({ runtime, ready, recommended }) => (
                <option key={runtime.id} value={runtime.id} disabled={!ready}>{runtime.displayName}{recommended ? " (recommended)" : ""}{ready ? "" : ` — ${runtime.statusReason}`}</option>
              ))}
            </select>
          </label>
          {runtimeId ? <AgentAccountField runtimeId={runtimeId} runtimeLabel={runtimeLabel} accounts={cliAccounts} value={paneAccount} disabled={switching} onChange={(profileId) => onSwitchAgent(runtimeId, profileId)} /> : null}
          <p className="jc-muted">Switching the designer or its account restarts this pane's CLI session. Claude Code is recommended.</p>
          <div className="jc-default-agent">
            <p className="jc-muted" role="status">
              {launch && !launch.askOnLaunch
                ? `New Design panes open with ${copilotAgentLabel(launch.runtimeId, runtimeOptions.find((option) => option.runtime.id === launch.runtimeId)?.runtime)}${launch.accountProfileId ? ` (${launch.accountProfileId} account)` : ""} without asking.`
                : "New Design panes ask which designer to use."} Change it in Settings → Design.
            </p>
            <button type="button" className="jc-button" disabled={!runtimeId || switching || isDefault} onClick={() => {
              onSetDefault();
              if (runtimeId) setLaunch({ runtimeId, accountProfileId: paneAccount, askOnLaunch: false });
            }}>{isDefault ? "This is your default designer" : "Set as default"}</button>
          </div>
        </div>
      ) : null}
      {message ? <p className="jc-message" role="status">{message}</p> : null}
    </div>
  );
}
