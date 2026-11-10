import { useEffect, useState } from "react";
import {
  DESIGN_ENGINE_LABELS, DESIGN_FORMATS, DESIGN_IMAGE_ENGINES, DESIGN_NETWORK_LABELS, DESIGN_TEMPLATE_IDS, DESIGN_TEMPLATE_LABELS,
  type CopilotLaunchSettings, type DesignBrandKit, type DesignImageEngine, type DesignPaneMetadata, type DesignTemplateId, type Pane
} from "@space/contracts";
import { api } from "../../api.js";
import { AgentAccountField, useCopilotAccounts } from "../copilot-kit/AgentAccountField.js";
import { copilotAgentLabel, loadPaneAccountProfileId, type CopilotRuntimeOption } from "../copilot-kit/copilot-runtimes.js";
import { SpaceToggle } from "../ui-controls/SpaceToggle.js";
import { useUiLanguage, uiText } from "../ui-language/ui-language.js";

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
  const language = useUiLanguage();
  const t = (text: string, vars?: Record<string, string | number>) => uiText(language, text, vars);
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
      setMessage(t("{label} saved.", { label: t(label) }));
    } catch (error) {
      onSettingsChange(settings);
      setMessage(error instanceof Error ? error.message : t("{label} could not be saved.", { label: t(label) }));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="jc-setup" role="tabpanel" id="jc-panel-setup" aria-labelledby="jc-tab-setup">
      <nav className="jc-steps" aria-label={t("Setup steps")}>
        {(["defaults", "requests", "agent"] as const).map((id, index) => (
          <button key={id} type="button" className={`jc-step${step === id ? " selected" : ""}`} aria-current={step === id ? "step" : undefined} onClick={() => setStep(id)}>
            <span className="jc-step-index">{index + 1}</span>{t(STEP_LABELS[id])}
          </button>
        ))}
      </nav>

      {step === "defaults" ? (
        <div className="jc-form">
          <label className="jc-field"><span>{t("Default format")}</span>
            <select value={current.defaultFormatId} disabled={busy} aria-label={t("Default format")} onChange={(event) => void patch("Default format", { defaultFormatId: event.target.value })}>
              {current.defaultFormatId.startsWith("custom-") ? <option value={current.defaultFormatId}>{current.defaultFormatId}</option> : null}
              {DESIGN_FORMATS.map((format) => <option key={format.id} value={format.id}>{t(DESIGN_NETWORK_LABELS[format.network])} · {t(format.label)} · {format.width}×{format.height}</option>)}
            </select><small className="jc-muted">{t("The size a new design and a request without a format start from.")}</small></label>
          <label className="jc-field"><span>{t("Default engine")}</span>
            <select value={current.defaultEngine} disabled={busy} aria-label={t("Default engine")} onChange={(event) => void patch("Default engine", { defaultEngine: event.target.value as DesignImageEngine })}>
              {DESIGN_IMAGE_ENGINES.map((id) => <option key={id} value={id}>{t(DESIGN_ENGINE_LABELS[id])}</option>)}
            </select><small className="jc-muted">{t("The AI model that draws pictures unless a request asks for another.")}</small></label>
          <label className="jc-field"><span>{t("Default template")}</span>
            <select value={current.defaultTemplateId} disabled={busy} aria-label={t("Default template")} onChange={(event) => void patch("Default template", { defaultTemplateId: event.target.value as DesignTemplateId })}>
              {DESIGN_TEMPLATE_IDS.map((id) => <option key={id} value={id}>{t(DESIGN_TEMPLATE_LABELS[id])}</option>)}
            </select><small className="jc-muted">{t("The layout the Studio starts with.")}</small></label>
          <label className="jc-field"><span>{t("Brand kit")}</span>
            <select value={current.brandKitId} disabled={busy} aria-label={t("Default brand kit")} onChange={(event) => void patch("Brand kit", { brandKitId: event.target.value })}>
              {brandKits.map((kit) => <option key={kit.id} value={kit.id}>{kit.name}</option>)}
            </select><small className="jc-muted">{t("The logo, colours and fonts used when a request names no brand kit.")}</small></label>
          <label className="jc-field"><span>{t("Motion length (seconds)")}</span>
            <input type="number" min={1} max={90} value={current.motion.defaultDurationSec} disabled={busy} aria-label={t("Motion length in seconds")}
              onChange={(event) => void patch("Motion length", { motion: { ...current.motion, defaultDurationSec: Math.max(1, Math.min(90, Number.parseInt(event.target.value, 10) || 8)) } })} /></label>
          <SpaceToggle label={t("Also make a GIF")} detail={t("Motion pieces come as an MP4 and a GIF.")} checked={current.motion.gif} disabled={busy} onChange={(checked) => void patch("GIF", { motion: { ...current.motion, gif: checked } })} />
        </div>
      ) : null}

      {step === "requests" ? (
        <div className="jc-form">
          <div className="jc-chips" role="radiogroup" aria-label={t("Requests from others")}>
            <button type="button" role="radio" aria-checked={current.requestAutonomy === "AUTO"} className={`jc-chip${current.requestAutonomy === "AUTO" ? " selected" : ""}`} disabled={busy}
              onClick={() => void patch("Requests", { requestAutonomy: "AUTO" })}>{t("Deliver automatically")}</button>
            <button type="button" role="radio" aria-checked={current.requestAutonomy === "APPROVAL"} className={`jc-chip${current.requestAutonomy === "APPROVAL" ? " selected" : ""}`} disabled={busy}
              onClick={() => void patch("Requests", { requestAutonomy: "APPROVAL" })}>{t("Needs my approval")}</button>
          </div>
          <p className="jc-muted">{current.requestAutonomy === "AUTO" ? t("Designs other agents and panes ask for go back to them as soon as the designer finishes.") : t("The designer's deliveries wait in the Requests tab until you approve them.")}</p>
          <SpaceToggle label={t("Paused")} detail={t("The designer takes no new request while paused; the Studio keeps working.")} checked={current.paused} disabled={busy} onChange={(checked) => void patch("Paused", { paused: checked })} />
          <SpaceToggle label={t("Needs-you notifications")} detail={t("Questions, approvals, failures and requests waiting for a Design pane.")} checked={current.notifications.needsYou} disabled={busy}
            onChange={(checked) => void patch("Notifications", { notifications: { ...current.notifications, needsYou: checked } })} />
          <SpaceToggle label={t("Delivered notifications")} detail={t("A notification for every design delivered to its requester.")} checked={current.notifications.delivered} disabled={busy}
            onChange={(checked) => void patch("Notifications", { notifications: { ...current.notifications, delivered: checked } })} />
          <SpaceToggle label={t("Telegram")} detail={t("These notifications also go to the paired Telegram bot (Settings → Telegram).")} checked={current.notifications.telegram} disabled={busy}
            onChange={(checked) => void patch("Notifications", { notifications: { ...current.notifications, telegram: checked } })} />
        </div>
      ) : null}

      {step === "agent" ? (
        <div className="jc-form">
          <label className="jc-field">
            <span>{t("Designer")}</span>
            <select value={runtimeId ?? ""} disabled={switching} onChange={(event) => { const next = event.target.value; if (next && next !== runtimeId) onSwitchAgent(next); }}>
              {!runtimeId ? <option value="">{t("Choose a CLI…")}</option> : null}
              {runtimeOptions.map(({ runtime, ready, recommended }) => (
                <option key={runtime.id} value={runtime.id} disabled={!ready}>{runtime.displayName}{recommended ? ` ${t("(recommended)")}` : ""}{ready ? "" : ` — ${runtime.statusReason}`}</option>
              ))}
            </select>
          </label>
          {runtimeId ? <AgentAccountField runtimeId={runtimeId} runtimeLabel={runtimeLabel} accounts={cliAccounts} value={paneAccount} disabled={switching} onChange={(profileId) => onSwitchAgent(runtimeId, profileId)} /> : null}
          <p className="jc-muted">{t("Switching the designer or its account restarts this pane's CLI session. Claude Code is recommended.")}</p>
          <div className="jc-default-agent">
            <p className="jc-muted" role="status">
              {launch && !launch.askOnLaunch
                ? t(launch.accountProfileId ? "New Design panes open with {agent} ({account} account) without asking." : "New Design panes open with {agent} without asking.",
                  { agent: copilotAgentLabel(launch.runtimeId, runtimeOptions.find((option) => option.runtime.id === launch.runtimeId)?.runtime), account: launch.accountProfileId ?? "" })
                : t("New Design panes ask which designer to use.")} {t("Change it in Settings → Design.")}
            </p>
            <button type="button" className="jc-button" disabled={!runtimeId || switching || isDefault} onClick={() => {
              onSetDefault();
              if (runtimeId) setLaunch({ runtimeId, accountProfileId: paneAccount, askOnLaunch: false });
            }}>{isDefault ? t("This is your default designer") : t("Set as default")}</button>
          </div>
        </div>
      ) : null}
      {message ? <p className="jc-message" role="status">{message}</p> : null}
    </div>
  );
}
