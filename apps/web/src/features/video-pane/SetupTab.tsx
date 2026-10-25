import { useEffect, useState } from "react";
import {
  VIDEO_CAPTION_STYLES, VIDEO_FILTERS, VIDEO_REFRAME_MODES, VIDEO_TECHNIQUE_LABELS, VIDEO_TECHNIQUES, VIDEO_TIMELINE_MAX_OUTPUTS, VIDEO_TRANSITIONS, VIDEO_TTS_ENGINES, VIDEO_TTS_LANGUAGES,
  type CopilotLaunchSettings, type Pane, type VideoCaptionStyle, type VideoFilter, type VideoPaneMetadata, type VideoReframeMode, type VideoTechnique, type VideoTransition, type VideoTtsEngine
} from "@space/contracts";
import { api } from "../../api.js";
import type { VideoToolsStatus } from "../../live-api.js";
import { AgentAccountField, useCopilotAccounts } from "../copilot-kit/AgentAccountField.js";
import { copilotAgentLabel, loadPaneAccountProfileId, type CopilotRuntimeOption } from "../copilot-kit/copilot-runtimes.js";
import { SpaceToggle } from "../ui-controls/SpaceToggle.js";
import { FormatPicker, languageName, optionLabel } from "./StudioView.js";

type SetupStep = "defaults" | "requests" | "tools" | "agent";
const STEP_LABELS: Record<SetupStep, string> = { defaults: "Defaults", requests: "Requests", tools: "Tools", agent: "Agent" };
const REFRAME_LABELS: Record<VideoReframeMode, string> = { OFF: "Letterbox", CENTER: "Centre crop", FACE: "Follow faces" };
export const VIDEO_TOOLS_INSTALL = "node /opt/spaceapp/scripts/space-video-tools-setup.mjs --install";
const select = <T extends string>(label: string, value: T, options: readonly T[], onChange: (next: T) => void, disabled: boolean, labels?: Partial<Record<T, string>>, hint?: string) => (
  <label className="jc-field"><span>{label}</span>
    <select value={value} disabled={disabled} aria-label={label} onChange={(event) => onChange(event.target.value as T)}>{options.map((id) => <option key={id} value={id}>{labels?.[id] ?? optionLabel(id)}</option>)}</select>
    {hint ? <small className="jc-muted">{hint}</small> : null}</label>
);

/** Setup: the pane's defaults (formats, technique, look, captions, narration, music levels); how requests from others are delivered; the tools; the editor. */
export function SetupTab({ pane, settings, runtimeOptions, switching, accountRevision = 0, onSettingsChange, onSwitchAgent, onSetDefault }: {
  pane: Pane;
  settings: VideoPaneMetadata;
  runtimeOptions: CopilotRuntimeOption[];
  switching: boolean;
  accountRevision?: number;
  onSettingsChange(settings: VideoPaneMetadata): void;
  onSwitchAgent(runtimeId: string, accountProfileId?: string): void;
  onSetDefault(): void;
}) {
  const [step, setStep] = useState<SetupStep>("defaults");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [launch, setLaunch] = useState<CopilotLaunchSettings | null>(null);
  const [tools, setTools] = useState<VideoToolsStatus | null | undefined>(undefined);
  const [voice, setVoice] = useState(settings.settings.narration.voice);
  const runtimeId = pane.terminalRuntimeId ?? null;
  const runtimeLabel = runtimeId ? copilotAgentLabel(runtimeId, runtimeOptions.find((option) => option.runtime.id === runtimeId)?.runtime) : "";
  const cliAccounts = useCopilotAccounts(step === "agent" ? runtimeId : null);
  const [paneAccount, setPaneAccount] = useState<string | null>(null);
  const isDefault = Boolean(launch && runtimeId && launch.runtimeId === runtimeId && !launch.askOnLaunch && (launch.accountProfileId ?? null) === paneAccount);
  const current = settings.settings;
  const languages = Object.keys(VIDEO_TTS_LANGUAGES).filter((tag) => VIDEO_TTS_LANGUAGES[tag]!.includes(current.narration.engine));

  useEffect(() => {
    if (step !== "agent") return;
    let cancelled = false;
    api.userSettings().then((user) => { if (!cancelled) setLaunch(user.video ?? null); }).catch(() => undefined);
    void loadPaneAccountProfileId(pane.id, runtimeId).then((accountProfileId) => { if (!cancelled) setPaneAccount(accountProfileId); });
    return () => { cancelled = true; };
  }, [accountRevision, pane.id, runtimeId, step]);
  useEffect(() => {
    if (step !== "tools" || tools !== undefined) return;
    let cancelled = false;
    api.videoTools().then((response) => { if (!cancelled) setTools(response.tools); }).catch(() => { if (!cancelled) setTools(null); });
    return () => { cancelled = true; };
  }, [step, tools]);

  async function patch(label: string, update: Partial<VideoPaneMetadata["settings"]>) {
    if (busy) return;
    const next = { ...settings, settings: { ...current, ...update } };
    setBusy(true);
    setMessage(null);
    onSettingsChange(next);
    try {
      onSettingsChange((await api.updateVideoSettings(pane.id, next)).metadata);
      setMessage(`${label} saved.`);
    } catch (error) {
      onSettingsChange(settings);
      setMessage(error instanceof Error ? error.message : `${label} could not be saved.`);
    } finally {
      setBusy(false);
    }
  }
  const toggleFormat = (id: string) => {
    const next = current.defaultFormatIds.includes(id) ? current.defaultFormatIds.filter((entry) => entry !== id) : [...current.defaultFormatIds, id];
    if (next.length && next.length <= VIDEO_TIMELINE_MAX_OUTPUTS) void patch("Default formats", { defaultFormatIds: next });
  };
  // An engine that does not speak the chosen language falls back to English, which both speak.
  const setEngine = (engine: VideoTtsEngine) => void patch("Narration", { narration: { ...current.narration, engine, language: VIDEO_TTS_LANGUAGES[current.narration.language]?.includes(engine) ? current.narration.language : "en" } });

  return (
    <div className="jc-setup" role="tabpanel" id="jc-panel-setup" aria-labelledby="jc-tab-setup">
      <nav className="jc-steps" aria-label="Setup steps">
        {(["defaults", "requests", "tools", "agent"] as const).map((id, index) => (
          <button key={id} type="button" className={`jc-step${step === id ? " selected" : ""}`} aria-current={step === id ? "step" : undefined} onClick={() => setStep(id)}>
            <span className="jc-step-index">{index + 1}</span>{STEP_LABELS[id]}
          </button>
        ))}
      </nav>

      {step === "defaults" ? (
        <div className="jc-form">
          <div className="jc-field"><span>Default formats</span>
            <FormatPicker label="Default formats" value={current.defaultFormatIds} onToggle={toggleFormat} disabled={busy} />
            <small className="jc-muted">Preselected in the Studio and used by requests that name no format (at least one, at most {VIDEO_TIMELINE_MAX_OUTPUTS}).</small></div>
          {select("Technique", current.technique, VIDEO_TECHNIQUES, (technique: VideoTechnique) => void patch("Technique", { technique }), busy, VIDEO_TECHNIQUE_LABELS, "How the editor finds the cuts.")}
          {select("Reframe", current.reframe, VIDEO_REFRAME_MODES, (reframe: VideoReframeMode) => void patch("Reframe", { reframe }), busy, REFRAME_LABELS, "How a source of another shape fills the output.")}
          {select("Transition", current.transition, VIDEO_TRANSITIONS, (transition: VideoTransition) => void patch("Transition", { transition }), busy)}
          {select("Filter", current.filter, VIDEO_FILTERS, (filter: VideoFilter) => void patch("Filter", { filter }), busy)}
          {select("Captions", current.captions, VIDEO_CAPTION_STYLES, (captions: VideoCaptionStyle) => void patch("Captions", { captions }), busy)}
          {select("Narration engine", current.narration.engine, VIDEO_TTS_ENGINES, setEngine, busy, { kokoro: "Kokoro (fast, 8 languages)", chatterbox: "Chatterbox (23 languages, voice cloning)" })}
          {select("Narration language", current.narration.language, languages, (language) => void patch("Narration", { narration: { ...current.narration, language } }), busy, Object.fromEntries(languages.map((tag) => [tag, languageName(tag)])))}
          <label className="jc-field"><span>Narration voice</span>
            <input value={voice} maxLength={60} disabled={busy} aria-label="Narration voice" onChange={(event) => setVoice(event.target.value)}
              onBlur={() => { if (voice.trim() && voice.trim() !== current.narration.voice) void patch("Narration", { narration: { ...current.narration, voice: voice.trim() } }); }} />
            <small className="jc-muted">The engine's voice name (Kokoro: af_heart, am_adam…).</small></label>
          <div className="vd-row">
            <label className="jc-field"><span>Music level (dB)</span>
              <input type="number" min={-40} max={0} value={current.music.volumeDb} disabled={busy} aria-label="Music level in dB"
                onChange={(event) => void patch("Music", { music: { ...current.music, volumeDb: Math.max(-40, Math.min(0, Number.parseInt(event.target.value, 10) || 0)) } })} /></label>
            <label className="jc-field"><span>Duck under speech (dB)</span>
              <input type="number" min={-30} max={0} value={current.music.duckDb} disabled={busy} aria-label="Music ducking in dB"
                onChange={(event) => void patch("Music", { music: { ...current.music, duckDb: Math.max(-30, Math.min(0, Number.parseInt(event.target.value, 10) || 0)) } })} /></label>
          </div>
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
          <p className="jc-muted">{current.requestAutonomy === "AUTO" ? "Videos other agents and panes ask for go back to them as soon as the editor finishes." : "The editor's deliveries wait in the Requests tab until you approve them."}</p>
          <SpaceToggle label="Paused" detail="The editor takes no new request while paused; the Studio keeps working." checked={current.paused} disabled={busy} onChange={(checked) => void patch("Paused", { paused: checked })} />
          <SpaceToggle label="Needs-you notifications" detail="Questions, approvals, failures and requests waiting for a Video pane." checked={current.notifications.needsYou} disabled={busy}
            onChange={(checked) => void patch("Notifications", { notifications: { ...current.notifications, needsYou: checked } })} />
          <SpaceToggle label="Delivered notifications" detail="A notification for every video delivered to its requester." checked={current.notifications.delivered} disabled={busy}
            onChange={(checked) => void patch("Notifications", { notifications: { ...current.notifications, delivered: checked } })} />
          <SpaceToggle label="Telegram" detail="These notifications also go to the paired Telegram bot (Settings → Telegram)." checked={current.notifications.telegram} disabled={busy}
            onChange={(checked) => void patch("Notifications", { notifications: { ...current.notifications, telegram: checked } })} />
        </div>
      ) : null}

      {step === "tools" ? (
        <div className="jc-form vd-tools" aria-label="Tools">
          {tools === undefined ? <p className="jc-muted" role="status">Checking the tools…</p> : tools?.ok ? <p role="status">All video tools are installed.</p> : (
            <>
              <p role="status">{tools === null ? "The tools' status could not be read." : `Missing: ${(tools.missing ?? []).join(", ") || "unknown"}.`}{tools?.error ? ` ${tools.error}` : ""}</p>
              <p className="jc-muted">Install them once, as the agent user, with:</p>
              <code>{VIDEO_TOOLS_INSTALL}</code>
            </>
          )}
          <button type="button" className="jc-button" onClick={() => setTools(undefined)}>Check again</button>
        </div>
      ) : null}

      {step === "agent" ? (
        <div className="jc-form">
          <label className="jc-field">
            <span>Editor</span>
            <select value={runtimeId ?? ""} disabled={switching} onChange={(event) => { const next = event.target.value; if (next && next !== runtimeId) onSwitchAgent(next); }}>
              {!runtimeId ? <option value="">Choose a CLI…</option> : null}
              {runtimeOptions.map(({ runtime, ready, recommended }) => (
                <option key={runtime.id} value={runtime.id} disabled={!ready}>{runtime.displayName}{recommended ? " (recommended)" : ""}{ready ? "" : ` — ${runtime.statusReason}`}</option>
              ))}
            </select>
          </label>
          {runtimeId ? <AgentAccountField runtimeId={runtimeId} runtimeLabel={runtimeLabel} accounts={cliAccounts} value={paneAccount} disabled={switching} onChange={(profileId) => onSwitchAgent(runtimeId, profileId)} /> : null}
          <p className="jc-muted">Switching the editor or its account restarts this pane's CLI session. Claude Code is recommended.</p>
          <div className="jc-default-agent">
            <p className="jc-muted" role="status">
              {launch && !launch.askOnLaunch
                ? `New Video panes open with ${copilotAgentLabel(launch.runtimeId, runtimeOptions.find((option) => option.runtime.id === launch.runtimeId)?.runtime)}${launch.accountProfileId ? ` (${launch.accountProfileId} account)` : ""} without asking.`
                : "New Video panes ask which editor to use."} Change it in Settings → Video.
            </p>
            <button type="button" className="jc-button" disabled={!runtimeId || switching || isDefault} onClick={() => {
              onSetDefault();
              if (runtimeId) setLaunch({ runtimeId, accountProfileId: paneAccount, askOnLaunch: false });
            }}>{isDefault ? "This is your default editor" : "Set as default"}</button>
          </div>
        </div>
      ) : null}
      {message ? <p className="jc-message" role="status">{message}</p> : null}
    </div>
  );
}
