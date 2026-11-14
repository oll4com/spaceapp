import { LIVE_AUDIO_PROVIDERS, type LiveAudioProviderId } from "@space/contracts";
import { useVoiceInput } from "./VoiceInputProvider.js";
import { SENSEVOICE_GREEK_NOTE, senseVoiceForGreek, writeVoiceComposerSettings, type VoiceComposerSettings } from "../../voice-settings.js";
import { Mic, RefreshCw } from "../ui-theme/app-icons.js";
import { SettingsActionMenu } from "../settings/SettingsActionMenu.js";
import { SettingsLabel } from "../settings/SettingsLabel.js";
import { SpaceToggle } from "../ui-controls/SpaceToggle.js";
import { browserSpeechEngine, browserSpeechLang } from "./browser-speech.js";

export function VoiceSettingsCard() {
  const voiceInput = useVoiceInput();
  const settings = voiceInput.settings;
  const serverSettings = voiceInput.serverSettings;
  const loading = voiceInput.settingsLoading;
  const error = voiceInput.settingsError;

  function updateVoiceSettings(patch: Partial<VoiceComposerSettings>) {
    const next = { ...settings, ...patch };
    writeVoiceComposerSettings(next);
  }

  const availableProviders: LiveAudioProviderId[] =
    serverSettings?.providerOptions && serverSettings.providerOptions.length > 0
      ? serverSettings.providerOptions
      : ["google", "openai", "local", "vercel"];
  const currentProvider = settings.provider || "google";
  const providerDescriptor = LIVE_AUDIO_PROVIDERS[currentProvider];

  const languageOptions = serverSettings?.languageOptions ?? ["auto", "el", "en"];
  const providerModelIds = providerDescriptor?.models.map((m) => m.id);
  const modelOptions = providerModelIds && providerModelIds.length > 0 ? providerModelIds : (serverSettings?.modelOptions ?? ["gemini-3.8-live"]);

  const providerVoiceIds = providerDescriptor?.voices.map((v) => v.id);
  const voiceOptions = providerVoiceIds && providerVoiceIds.length > 0 ? providerVoiceIds : (serverSettings?.voiceOptions ?? ["Aoede"]);
  const browser = settings.engine === "browser";
  const speechEngine = browserSpeechEngine();
  const browserSupported = speechEngine !== null;
  const ready = browser ? browserSupported : Boolean(serverSettings?.enabled);
  const statusLabel = ready ? "READY" : browser ? "UNAVAILABLE" : "DISABLED";
  const statusToneValue = ready ? "ok" : "warn";
  const statusText = !browser
    ? serverSettings?.statusReason ?? (loading ? "Voice settings loading" : "Voice settings unavailable")
    : speechEngine === "desktop"
      ? "Free: Whisper on this PC, Greek or English (a one-time 590 MB download). No Space key, no tokens."
      : browserSupported
        ? "Free: this browser's own speech recognition, Greek or English. No Space key, no tokens."
        : "spaceDesktop" in window
          ? "This SpaceApp Desktop version has no free speech recognition: update SpaceApp, or choose the Space voice relay."
          : "This browser has no speech recognition: use Chrome, or choose the Space voice relay.";

  return (
    <section className="provider-settings-card settings-flat-card voice-settings-card" aria-label="Voice input settings">
      <div className="agent-settings-section-title settings-flat-heading">
        <Mic aria-hidden="true" />
        <span>
          <strong>Voice input</strong>
          <small>{statusText}</small>
        </span>
        <div className="settings-flat-heading-actions">
          <span className={`status ${statusToneValue}`}>{statusLabel}</span>
          <SettingsActionMenu
            label="Voice input actions"
            disabled={loading}
            actions={[{
              id: "refresh",
              label: "Refresh voice status",
              icon: RefreshCw,
              onSelect: () => void voiceInput.refreshServerSettings()
            }]}
          />
        </div>
      </div>
      {error ? (
        <div className="validation-result bad" role="alert">
          <strong>VOICE_SETTINGS_ERROR</strong>
          <small>{error}</small>
        </div>
      ) : null}
      <SpaceToggle
        className="settings-flat-row settings-flat-toggle-row voice-toggle"
        name="voice-input-enabled"
        label="Voice input"
        help="Shows the microphone in Chat and attached CLI panes. Off hides the microphone controls."
        checked={settings.enabled}
        onChange={(enabled) => updateVoiceSettings({ enabled })}
      />
      <label className="settings-flat-row">
        <SettingsLabel label="Engine" help="Browser speech recognition is free; the Space voice relay bills Space's provider key." />
        <select name="voice-input-engine" value={settings.engine} onChange={(event) => updateVoiceSettings({ engine: event.target.value as VoiceComposerSettings["engine"] })}>
          <option value="browser">Browser speech recognition (free)</option>
          <option value="relay">Space voice relay (paid)</option>
        </select>
      </label>
      {browser ? null : <>
      <label className="settings-flat-row">
        <SettingsLabel label="Voice provider" help="The provider of the relay's live speech engine. Changing it picks that provider's default model and voice." />
        <select
          name="voice-input-provider"
          value={currentProvider}
          onChange={(event) => {
            const provider = event.target.value as LiveAudioProviderId;
            const desc = LIVE_AUDIO_PROVIDERS[provider];
            updateVoiceSettings({
              provider,
              model: desc?.defaultModel || (provider === "google" ? "gemini-3.8-live" : "gpt-transcribe"),
              voice: desc?.defaultVoice || (provider === "google" ? "Aoede" : "alloy")
            });
          }}
        >
          {availableProviders.map((p) => (
            <option key={p} value={p}>
              {LIVE_AUDIO_PROVIDERS[p]?.displayName || p}
            </option>
          ))}
        </select>
      </label>
      <label className="settings-flat-row">
        <SettingsLabel label="Voice model" help="The relay's audio and speech model." />
        <select name="voice-input-model" value={settings.model} onChange={(event) => updateVoiceSettings({ model: event.target.value as VoiceComposerSettings["model"] })}>
          {modelOptions.map((model) => {
            const badge = providerDescriptor?.models.find((m) => m.id === model)?.badge;
            return <option key={model} value={model}>{badge ? `${model} · ${badge}` : model}</option>;
          })}
        </select>
      </label>
      <label className="settings-flat-row">
        <SettingsLabel label="Voice" help="The voice tone the relay's speech model uses." />
        <select name="voice-input-voice" value={settings.voice} onChange={(event) => updateVoiceSettings({ voice: event.target.value as VoiceComposerSettings["voice"] })}>
          {voiceOptions.map((voice) => (
            <option key={voice} value={voice}>
              {voice.charAt(0).toUpperCase() + voice.slice(1)}
            </option>
          ))}
        </select>
      </label>
      </>}
      <label className="settings-flat-row">
        <SettingsLabel label="Language" help="The language you speak. With the browser engine, Auto is Greek when your browser lists Greek, else English." />
        <select name="voice-input-language" value={settings.language} onChange={(event) => updateVoiceSettings({ language: event.target.value as VoiceComposerSettings["language"] })}>
          {languageOptions.map((language) => (
            <option key={language} value={language}>
              {language === "auto" ? "Auto" : language === "el" ? "Greek" : "English"}
            </option>
          ))}
        </select>
      </label>
      {!browser && senseVoiceForGreek(settings) ? <p className="settings-flat-note voice-settings-help" role="note">{SENSEVOICE_GREEK_NOTE}</p> : null}
      <label className="settings-flat-row">
        <SettingsLabel label="Insert mode" help="How finished speech enters the prompt: added after what you typed, or replacing it." />
        <select name="voice-input-insert-mode" value={settings.insertMode} onChange={(event) => updateVoiceSettings({ insertMode: event.target.value as VoiceComposerSettings["insertMode"] })}>
          <option value="append">Append</option>
          <option value="replace">Replace</option>
        </select>
      </label>
      {browser ? null : <>
      <SpaceToggle
        className="settings-flat-row settings-flat-toggle-row voice-toggle"
        name="voice-input-prewarm"
        label="Pre-warm connection"
        help="Opens the relay connection early to reduce the delay before the first words."
        checked={settings.prewarm}
        onChange={(prewarm) => updateVoiceSettings({ prewarm })}
      />
      <div className="voice-advanced-settings" style={{ margin: "6px 0" }}>
        <details className="settings-flat-details" style={{ cursor: "pointer" }}>
          <summary className="settings-flat-summary" style={{ color: "var(--room-text, #f4efe5)", fontSize: "0.78rem", padding: "4px 0" }}>
            <strong>Live model & delegation settings</strong>
          </summary>
          <div style={{ display: "flex", flexDirection: "column", gap: "8px", marginTop: "8px" }}>
            <label className="settings-flat-row">
              <SettingsLabel label="Opening" help="Optional first words the voice session starts with." />
              <input
                type="text"
                name="voice-input-opening"
                value={settings.opening}
                placeholder="Optional first words..."
                onChange={(event) => updateVoiceSettings({ opening: event.target.value })}
              />
            </label>
            <label className="settings-flat-row">
              <SettingsLabel label="System prompt" help="The instructions the voice model follows in the voice session." />
              <input
                type="text"
                name="voice-input-prompt"
                value={settings.prompt}
                placeholder="Instructions for voice model..."
                onChange={(event) => updateVoiceSettings({ prompt: event.target.value })}
              />
            </label>
            <label className="settings-flat-row">
              <SettingsLabel label="Delegated model" help="The backend model the voice session hands reasoning to." />
              <select
                name="voice-delegated-model"
                value={settings.delegatedModel}
                onChange={(event) => updateVoiceSettings({ delegatedModel: event.target.value })}
              >
                <option value="gpt-6-astra">gpt-6-astra</option>
                <option value="gpt-4o">gpt-4o</option>
                <option value="gpt-4o-mini">gpt-4o-mini</option>
              </select>
            </label>
            <label className="settings-flat-row">
              <SettingsLabel label="Reasoning effort" help="How deeply the delegated model reasons." />
              <select
                name="voice-reasoning-effort"
                value={settings.delegatedReasoningEffort}
                onChange={(event) => updateVoiceSettings({ delegatedReasoningEffort: event.target.value as VoiceComposerSettings["delegatedReasoningEffort"] })}
              >
                <option value="minimal">minimal</option>
                <option value="low">low</option>
                <option value="medium">medium</option>
                <option value="high">high</option>
                <option value="xhigh">xhigh</option>
              </select>
            </label>
            <SpaceToggle
              className="settings-flat-row settings-flat-toggle-row voice-toggle"
              name="voice-delegated-web-search"
              label="Web search"
              help="Allows the delegated model to search the web."
              checked={settings.delegatedWebSearch}
              onChange={(delegatedWebSearch) => updateVoiceSettings({ delegatedWebSearch })}
            />
            <label className="settings-flat-row">
              <SettingsLabel label="Delegated prompt" help="Instructions for the delegated backend model." />
              <input
                type="text"
                name="voice-delegated-prompt"
                value={settings.delegatedPrompt}
                placeholder="Add instructions for backend model..."
                onChange={(event) => updateVoiceSettings({ delegatedPrompt: event.target.value })}
              />
            </label>
          </div>
        </details>
      </div>
      </>}
      <p className="settings-flat-note voice-settings-help">
        {browser ? `Uses ${speechEngine === "desktop" ? "Whisper on this PC" : "this browser's speech recognition"} (${speechEngine === "desktop" && settings.language === "auto" ? "Greek or English, heard per take" : browserSpeechLang(settings.language)}).` : `Uses ${providerDescriptor?.displayName || currentProvider} ${settings.model} (${settings.voice}).`} Finished speech is submitted immediately.
      </p>
    </section>
  );
}
