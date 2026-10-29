import { useEffect, useRef, useState, type FormEvent } from "react";
import type { LiveAudioProviderDescriptor, LiveAudioProviderId, SetupDraft } from "@space/contracts";

export type SetupVoiceChoice = SetupDraft["connectionChoices"][number];
export type SetupVoiceProvider = Omit<LiveAudioProviderDescriptor, "credentialEnvVars" | "credentialKeyFiles"> & {
  configured: boolean;
  credentialSource: "OWNER" | "INSTALLATION" | null;
  setupVerificationSupported?: boolean;
  setupUnavailableReason?: string | null;
};
export interface SetupVoiceClient {
  getSetupVoiceProviders(): Promise<{ providers: SetupVoiceProvider[] }>;
  saveSetupVoiceCredential(input: Record<string, string>): Promise<{ configured: boolean; credentialRef: string }>;
}

export function SetupVoiceConnection({ client, onChoice, onCheckAudio, initialChoice }: {
  client: SetupVoiceClient;
  onChoice: (choice: SetupVoiceChoice) => void | Promise<void>;
  onCheckAudio?: (choice: SetupVoiceChoice, options: { signal: AbortSignal; onStatus: (message: string) => void }) => Promise<void>;
  initialChoice?: SetupVoiceChoice;
}) {
  const [providers, setProviders] = useState<SetupVoiceProvider[]>([]);
  const [providerId, setProviderId] = useState<LiveAudioProviderId | null>(null);
  const [modelId, setModelId] = useState("");
  const [voiceId, setVoiceId] = useState("");
  const [credentialRef, setCredentialRef] = useState(initialChoice?.credentialRef);
  const [changingCredential, setChangingCredential] = useState(false);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const audioAbort = useRef<AbortController | null>(null);
  useEffect(() => () => { audioAbort.current?.abort(); }, []);
  const provider = providers.find(item => item.id === providerId);
  useEffect(() => {
    let active = true;
    void client.getSetupVoiceProviders().then(result => {
      if (!active) return;
      const eligible = result.providers.filter(item => item.models.length > 0);
      setProviders(eligible);
      const supported = eligible.filter(item => item.setupVerificationSupported !== false);
      const selected = eligible.find(item => item.id === initialChoice?.providerId) ?? supported.find(item => item.configured && item.id !== "local") ?? supported.find(item => item.id !== "local") ?? supported[0] ?? eligible[0];
      if (!selected) { setError("No compatible Live provider is available on this installation."); return; }
      setProviderId(selected.id);
      setModelId(selected.models.some(item => item.id === initialChoice?.modelId) ? initialChoice!.modelId! : selected.defaultModel);
      setVoiceId(selected.voices.some(item => item.id === initialChoice?.voiceId) ? initialChoice!.voiceId! : selected.defaultVoice);
    }).catch(() => { if (active) setError("Live connections could not be loaded. Try again."); });
    return () => { active = false; };
  }, [client]);
  function choice(ref = credentialRef): SetupVoiceChoice {
    return { featureId: "pane:live", providerId: providerId!, modelId, voiceId, ...(ref ? { credentialRef: ref } : {}) };
  }
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!providerId || pending) return;
    const form = event.currentTarget;
    const data = Object.fromEntries(new FormData(form).entries()) as Record<string, string>;
    form.reset();
    setPending(true); setError(null); setMessage(null);
    try {
      const result = await client.saveSetupVoiceCredential({ ...data, providerId });
      if (!result.configured) throw new Error("Connection was not saved.");
      setCredentialRef(result.credentialRef);
      await onChoice(choice(result.credentialRef));
      setProviders(current => current.map(item => item.id === providerId ? { ...item, configured: true, credentialSource: "OWNER" } : item));
      setChangingCredential(false);
      setMessage("Connection saved securely. Complete the audio check to verify Live.");
    } catch { setError("The connection could not be saved securely. Check the required fields and try again."); }
    finally { setPending(false); }
  }
  async function testAudio() {
    if (!onCheckAudio || pending) return;
    setPending(true); setError(null); setMessage(null);
    const controller = new AbortController(); audioAbort.current = controller;
    try {
      await onChoice(choice());
      if (controller.signal.aborted) return;
      await onCheckAudio(choice(), { signal: controller.signal, onStatus: (status) => { if (!controller.signal.aborted) setMessage(status); } });
    } catch { if (!controller.signal.aborted) setError("Live audio did not pass its microphone and playback check. Review the connection and try again."); }
    finally { if (!controller.signal.aborted) setPending(false); }
  }
  const credentialFields = providerId === "amazon" ? [
    { name: "accessKeyId", label: "AWS access key ID (required)", required: true },
    { name: "secretAccessKey", label: "AWS secret access key (required)", required: true },
    { name: "sessionToken", label: "AWS session token (optional)", required: false }
  ] : [{ name: providerId === "local" ? "token" : "apiKey", label: providerId === "local" ? "Local service token (required)" : "API key (required)", required: true }];
  return <section className="first-setup-voice" aria-label="Live audio connection" aria-busy={pending}>
    <h3>Connect Live audio</h3>
    <p>Audio goes to the provider you choose. Cloud providers may bill usage. The local service runs at the endpoint approved for this installation.</p>
    {provider && <>
      <label>Live provider<select value={providerId ?? ""} disabled={pending} onChange={event => {
        const next = providers.find(item => item.id === event.target.value)!;
        setProviderId(next.id); setModelId(next.defaultModel); setVoiceId(next.defaultVoice); setCredentialRef(undefined);
        setChangingCredential(false); setMessage(null); setError(null);
      }}>{providers.map(item => <option key={item.id} value={item.id} disabled={item.setupVerificationSupported === false}>{item.displayName}{item.setupVerificationSupported === false ? " — unavailable" : ""}</option>)}</select></label>
      {provider.setupVerificationSupported === false ? <p role="status">{provider.setupUnavailableReason ?? "Choose another provider or skip Live for now."}</p> : <>
      <label>Live model<select value={modelId} disabled={pending} onChange={event => setModelId(event.target.value)}>
        {provider.models.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
      </select></label>
      <label>Live voice<select value={voiceId} disabled={pending} onChange={event => setVoiceId(event.target.value)}>
        {provider.voices.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
      </select></label>
      {provider.configured && !changingCredential ? <div>
        <p>Reusing an authorized {provider.credentialSource === "OWNER" ? "owner" : "installation"} connection.</p>
        <button type="button" disabled={pending} onClick={() => setChangingCredential(true)}>Change connection</button>
      </div> : <form key={providerId} onSubmit={event => void save(event)} autoComplete="off">
        {credentialFields.map(field => <label key={field.name}>{field.label}<input name={field.name} type="password" required={field.required}
          autoComplete="new-password" spellCheck={false} disabled={pending} /></label>)}
        {providerId === "amazon" && <label>AWS region (required)<input name="region" type="text" required autoComplete="off" placeholder="us-east-1" disabled={pending} /></label>}
        <p>Credentials are encrypted on the server. They are excluded from the assistant, installation memory and browser storage.</p>
        <button type="submit" disabled={pending}>{pending ? "Saving…" : "Save connection"}</button>
      </form>}
      {onCheckAudio ? <button type="button" disabled={pending || !provider.configured || changingCredential} onClick={() => void testAudio()}>Test microphone and playback</button>
        : <p>Audio verification is unavailable on this installation.</p>}
      </>}
    </>}
    {message && <p role="status">{message}</p>}
    {error && <p role="alert">{error}</p>}
  </section>;
}
