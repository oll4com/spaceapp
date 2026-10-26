import { createHash, randomUUID } from "node:crypto";
import { WebSocket, type RawData } from "ws";
import { LIVE_AUDIO_PROVIDERS, isLiveAudioProviderId, type SetupDraft } from "@space/contracts";
import type { SpaceStore } from "@space/runtime";
import type { SpaceApiConfig } from "./config.js";
import type { SetupVoiceCredentials } from "./setup-voice-credentials.js";
import { createVoiceCheckWire, supportsSetupVoiceProvider, type VoiceCheckWire, type VoiceCheckChoice } from "./setup-voice-wire.js";
import type { SetupVoiceCredential } from "./setup-voice-credentials.js";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const proofLifetimeMs = 10 * 60_000;
const checkLifetimeMs = 45_000;
const minimumAudioBytes = 9_600; // 300 ms of mono PCM16 at 16 kHz.
const maxFrameBytes = 64 * 1024;
const maxInputBytes = 1_600_000;
const fail = () => new Error("Live audio needs a current compatible connection and microphone/playback check.");
type Subject = { fingerprint: string; credential: SetupVoiceCredential; choice: VoiceCheckChoice; draft: SetupDraft };
type Check = { ownerId: string; fingerprint: string; wire?: VoiceCheckWire;
  expiresAt: number; attached: boolean; stop?: () => void; timer: ReturnType<typeof setTimeout> };

/** Audio and transcript content stay in transit; only a scoped digest is retained. */
export class SetupVoiceVerification {
  private readonly checks = new Map<string, Check>();
  constructor(private readonly options: { store: SpaceStore; credentials: SetupVoiceCredentials; config: SpaceApiConfig }) {}
  private connectionId(ownerId: string) { return `setup:voice:${hash(ownerId).slice(0, 32)}`; }
  private async subject(ownerId: string): Promise<Subject> {
    const state = await this.options.store.getSetupExecutionState(ownerId);
    const draft = state?.draft;
    const choice = draft?.connectionChoices.find(item => item.featureId === "pane:live");
    if (!draft?.requestedFeatureIds.includes("pane:live") || !isLiveAudioProviderId(choice?.providerId) || !choice.modelId || !choice.voiceId ||
      !supportsSetupVoiceProvider(choice.providerId) ||
      !LIVE_AUDIO_PROVIDERS[choice.providerId].models.some(model => model.id === choice.modelId && model.capabilities.bidirectionalAudio && model.capabilities.speechToSpeech) ||
      !LIVE_AUDIO_PROVIDERS[choice.providerId].voices.some(voice => voice.id === choice.voiceId)) throw fail();
    const credential = await this.options.credentials.resolve(ownerId, choice.providerId);
    if (!credential || (choice.credentialRef && !this.options.credentials.ownsReference(ownerId, choice.providerId, choice.credentialRef))) throw fail();
    const fingerprint = hash(JSON.stringify({ version: "voice-duplex:v2", ownerId, draftId: draft.id,
      revision: draft.revision, choice, endpoints: [this.options.config.localVoiceProviderUrl, this.options.config.googleVoiceBaseUrl,
        this.options.config.voiceTranscriptionBaseUrl, this.options.config.vercelVoiceBaseUrl], credential: hash(JSON.stringify(credential)) }));
    return { fingerprint, credential, choice: { providerId: choice.providerId, modelId: choice.modelId, voiceId: choice.voiceId }, draft };
  }
  async currentFingerprint(ownerId: string): Promise<string | null> {
    let subject: Subject;
    try { subject = await this.subject(ownerId); } catch { return null; }
    const saved = await this.options.store.getSetupConnectionVerification(this.connectionId(ownerId));
    const age = saved?.verifiedAt ? Date.now() - Date.parse(saved.verifiedAt) : Infinity;
    return saved?.state === "CONNECTED" && saved.fingerprintHash === subject.fingerprint && age >= 0 && age < proofLifetimeMs
      ? subject.fingerprint : null;
  }
  /**
   * Finishing asks the provider whether the saved Live connection still works (review 2026-10-21 #4: an unchanged local
   * key is no proof that the provider still accepts it). It opens the selected provider session and closes it as soon as
   * the provider confirms it; no audio is sent, nothing is stored. False on refusal, error or 15 s without confirmation.
   */
  async reauthorize(ownerId: string, timeoutMs = 15_000): Promise<boolean> {
    let wire: VoiceCheckWire;
    try { const subject = await this.subject(ownerId); wire = await createVoiceCheckWire(this.options.config, subject.choice, subject.credential); }
    catch { return false; }
    return await new Promise<boolean>((resolve) => {
      let settled = false;
      const upstream = new WebSocket(wire.url, wire.protocols, { headers: wire.headers, maxPayload: maxFrameBytes, followRedirects: false });
      const finish = (accepted: boolean) => {
        if (settled) return;
        settled = true; clearTimeout(timer);
        if (upstream.readyState === WebSocket.CONNECTING) upstream.terminate(); else if (upstream.readyState === WebSocket.OPEN) upstream.close();
        resolve(accepted);
      };
      const timer = setTimeout(() => finish(false), timeoutMs); timer.unref();
      upstream.on("open", () => {
        if (settled) return;
        upstream.send(wire.start());
        if (wire.readyOnOpen) finish(true);
      });
      upstream.on("message", (raw: RawData, binary: boolean) => {
        try {
          const data = Buffer.isBuffer(raw) ? raw : Array.isArray(raw) ? Buffer.concat(raw) : Buffer.from(raw);
          const event = wire.receive(data, binary);
          if (event.failed) finish(false); else if (event.ready) finish(true);
        } catch { finish(false); }
      });
      upstream.on("unexpected-response", () => finish(false));
      upstream.on("error", () => finish(false));
      upstream.on("close", () => finish(false));
    });
  }
  async begin(ownerId: string, draftRevision: number) {
    for (const [id, check] of this.checks) if (check.expiresAt <= Date.now()) this.discard(id);
    if (this.checks.size >= 64 || [...this.checks.values()].some(check => check.ownerId === ownerId)) throw fail();
    const subject = await this.subject(ownerId);
    if (subject.draft.revision !== draftRevision) throw fail();
    const checkId = randomUUID();
    // Reserve before the network call so two tabs cannot create parallel provider sessions.
    const timer = setTimeout(() => this.discard(checkId), checkLifetimeMs); timer.unref();
    const check: Check = { ownerId, fingerprint: subject.fingerprint,
      expiresAt: Date.now() + checkLifetimeMs, attached: false, timer };
    this.checks.set(checkId, check);
    try {
      check.wire = await createVoiceCheckWire(this.options.config, subject.choice, subject.credential);
      if ((await this.subject(ownerId)).fingerprint !== subject.fingerprint || !this.checks.has(checkId)) throw fail();
      return { checkId, websocketUrl: `/api/setup/voice/checks/${checkId}/audio`, sampleRate: 16000 as const };
    } catch { this.discard(checkId); throw fail(); }
  }
  async attach(ownerId: string, checkId: string, client: WebSocket): Promise<void> {
    const check = this.checks.get(checkId);
    if (!check || check.ownerId !== ownerId || check.attached || !check.wire || check.expiresAt <= Date.now()) {
      client.close(1008, "audio_check_invalid"); return;
    }
    check.attached = true;
    const wire = check.wire;
    const upstream = new WebSocket(wire.url, wire.protocols, {
      headers: wire.headers, maxPayload: maxFrameBytes, followRedirects: false
    });
    let ready = false;
    let stopped = false; let confirming = false; let inputBytes = 0; let totalInputBytes = 0; let outputBytes = 0; let speechObserved = false;
    const pending: Buffer[] = [];
    const pendingOutput: Buffer[] = []; let pendingOutputBytes = 0;
    const send = (data: Buffer | string) => {
      if (!stopped && client.readyState === WebSocket.OPEN && client.bufferedAmount + Buffer.byteLength(data) <= maxFrameBytes * 4) client.send(data);
      else stop();
    };
    const stop = () => {
      if (stopped) return;
      stopped = true; pending.length = 0; pendingOutput.length = 0; pendingOutputBytes = 0; clearTimeout(check.timer); this.checks.delete(checkId);
      if (upstream.readyState === WebSocket.CONNECTING) upstream.terminate(); else if (upstream.readyState === WebSocket.OPEN) upstream.close();
      if (client.readyState === WebSocket.OPEN) client.close(1000, "audio_check_ended");
    };
    check.stop = stop;
    const pcm = (data: Buffer) => {
      if (inputBytes < minimumAudioBytes || data.length < 2 || data.length % 2 || data.length > maxFrameBytes) return;
      // Transcription can arrive after audio. Keep a bounded transient queue;
      // nothing is played or verified until the provider observes speech.
      if (!speechObserved) {
        pendingOutputBytes += data.length;
        if (pendingOutputBytes > maxFrameBytes * 4 || pendingOutput.length >= 32) { stop(); return; }
        pendingOutput.push(data); return;
      }
      outputBytes += data.length;
      if (outputBytes > maxInputBytes) { stop(); return; }
      send(data);
    };
    const buffer = (data: RawData) => Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data);
    client.on("message", (raw: RawData, binary: boolean) => {
      if (stopped || confirming) return;
      const data = buffer(raw);
      if (data.length > maxFrameBytes) { stop(); return; }
      if (binary) {
        if (data.length % 2 || data.length < 2 || (totalInputBytes += data.length) > maxInputBytes) { stop(); return; }
        // Silence cannot prove microphone input; no samples or content are retained.
        let energy = 0; for (let offset = 0; offset < data.length; offset += 2) energy += Math.abs(data.readInt16LE(offset));
        if (energy / (data.length / 2) >= 32) inputBytes += data.length;
        if (ready && upstream.readyState === WebSocket.OPEN) {
          if (upstream.bufferedAmount > maxFrameBytes * 4) { stop(); return; }
          upstream.send(wire.input(data));
        } else if (pending.length < 8) pending.push(data); else stop();
        return;
      }
      let message: { type?: string }; try { message = JSON.parse(data.toString()); } catch { stop(); return; }
      if (message.type !== "playback-complete" || inputBytes < minimumAudioBytes || outputBytes < minimumAudioBytes || !speechObserved) return;
      confirming = true;
      void (async () => {
        try {
          if ((await this.subject(ownerId)).fingerprint !== check.fingerprint || check.expiresAt <= Date.now()) throw fail();
          const now = new Date().toISOString();
          await this.options.store.upsertSetupConnectionVerification({ connectionId: this.connectionId(ownerId), state: "CONNECTED",
            reasonCode: null, fingerprintHash: check.fingerprint, verifiedAt: now, updatedAt: now });
          send(JSON.stringify({ type: "verified" }));
        } catch { send(JSON.stringify({ type: "failed" })); }
        finally { stop(); }
      })();
    });
    const listening = () => {
      if (ready || stopped) return;
      ready = true;
      for (const data of pending) upstream.send(wire.input(data)); pending.length = 0;
      send(JSON.stringify({ type: "listening" }));
    };
    upstream.on("open", () => {
      if (stopped) return;
      upstream.send(wire.start());
      if (wire.readyOnOpen) listening();
    });
    upstream.on("message", (raw: RawData, binary: boolean) => {
      if (stopped) return;
      const data = buffer(raw); if (data.length > maxFrameBytes) { stop(); return; }
      try {
        const event = wire.receive(data, binary);
        if (event.failed) { stop(); return; }
        if (event.ready) listening();
        if (!ready) return;
        if (inputBytes >= minimumAudioBytes && event.transcript) {
          speechObserved = true;
          for (const audio of pendingOutput) pcm(audio);
          pendingOutput.length = 0; pendingOutputBytes = 0;
        }
        for (const audio of event.audio ?? []) pcm(audio);
      } catch { stop(); }
    });
    client.on("close", stop); client.on("error", stop); upstream.on("close", stop); upstream.on("error", stop);
  }
  private discard(id: string) { const check = this.checks.get(id); if (!check) return; clearTimeout(check.timer); check.stop?.(); this.checks.delete(id); }
  close(): void { for (const id of this.checks.keys()) this.discard(id); }
}
