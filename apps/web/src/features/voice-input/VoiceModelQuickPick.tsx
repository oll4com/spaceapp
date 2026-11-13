import { LIVE_AUDIO_PROVIDERS, type LiveAudioProviderId } from "@space/contracts";
import { useVoiceInput } from "./VoiceInputProvider.js";
import { SENSEVOICE_GREEK_NOTE, senseVoiceForGreek, writeVoiceComposerSettings, type VoiceComposerSettings } from "../../voice-settings.js";

/** The Terminal footer's quick pick of the voice model, across the providers the server offers (Settings → Voice input has the rest). */
export function VoiceModelQuickPick() {
  const { settings, serverSettings } = useVoiceInput();
  const current = settings.provider || "google";
  const providers = [...new Set<LiveAudioProviderId>([current, ...(serverSettings?.providerOptions ?? [])])].filter((p) => LIVE_AUDIO_PROVIDERS[p]);
  const greek = senseVoiceForGreek(settings);
  return (
    <select className="terminal-model-chip has-label terminal-voice-model-pick" name="terminal-voice-model" aria-label="Voice model"
      title={greek ? SENSEVOICE_GREEK_NOTE : "Voice model"} value={`${current}:${settings.model}`}
      onChange={(event) => {
        const at = event.target.value.indexOf(":");
        const provider = event.target.value.slice(0, at) as LiveAudioProviderId;
        writeVoiceComposerSettings({
          ...settings,
          provider,
          model: event.target.value.slice(at + 1) as VoiceComposerSettings["model"],
          voice: provider === current ? settings.voice : LIVE_AUDIO_PROVIDERS[provider].defaultVoice as VoiceComposerSettings["voice"]
        });
      }}>
      {providers.map((provider) => (
        <optgroup key={provider} label={LIVE_AUDIO_PROVIDERS[provider].displayName}>
          {LIVE_AUDIO_PROVIDERS[provider].models.map((model) => (
            <option key={model.id} value={`${provider}:${model.id}`}>{model.label}</option>
          ))}
        </optgroup>
      ))}
    </select>
  );
}
