import { getSpaceRuntime } from "../../runtime/SpaceRuntime.js";

export interface SetupVoiceAudioClient {
  startSetupVoiceCheck(draftRevision: number): Promise<{ checkId: string; websocketUrl: string; sampleRate: 16000 }>;
}

export function setupPcm16(input: Float32Array, sampleRate: number): ArrayBuffer {
  if (!Number.isFinite(sampleRate) || sampleRate < 16000 || sampleRate > 192000) throw new Error("Unsupported microphone sample rate.");
  const ratio = sampleRate / 16000;
  const result = new ArrayBuffer(Math.floor(input.length / ratio) * 2);
  const view = new DataView(result);
  for (let index = 0; index < result.byteLength / 2; index++) {
    const start = Math.floor(index * ratio); const end = Math.min(input.length, Math.floor((index + 1) * ratio));
    let sum = 0; for (let offset = start; offset < end; offset++) sum += input[offset] ?? 0;
    const value = Math.max(-1, Math.min(1, sum / Math.max(1, end - start)));
    view.setInt16(index * 2, Math.round(value * (value < 0 ? 32768 : 32767)), true);
  }
  return result;
}

/** Called only from the explicit test button. It never persists audio or text. */
export async function runSetupVoiceAudioCheck(client: SetupVoiceAudioClient, draftRevision: number,
  options: { signal?: AbortSignal; onStatus?: (message: string) => void } = {}): Promise<void> {
  let stream: MediaStream | undefined; let context: AudioContext | undefined; let socket: WebSocket | undefined;
  let source: MediaStreamAudioSourceNode | undefined; let processor: ScriptProcessorNode | undefined; let gain: GainNode | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined; let onAbort: (() => void) | undefined;
  const playing = new Set<AudioBufferSourceNode>();
  const aborted = () => { if (options.signal?.aborted) throw new Error("Audio check was cancelled."); };
  try {
    aborted();
    options.onStatus?.("Allow the microphone, then speak a short sentence and listen for the reply.");
    stream = await getSpaceRuntime().platform.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    aborted();
    const check = await client.startSetupVoiceCheck(draftRevision);
    aborted();
    if (check.sampleRate !== 16000 || !/^[a-f0-9-]{36}$/.test(check.checkId) || check.websocketUrl !== `/api/setup/voice/checks/${check.checkId}/audio`) {
      throw new Error("The server returned an incompatible audio check.");
    }
    context = new AudioContext(); await context.resume(); aborted();
    const url = new URL(check.websocketUrl, location.href); url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
    socket = new WebSocket(url); socket.binaryType = "arraybuffer";
    const audioContext = context; const audioSocket = socket;
    source = context.createMediaStreamSource(stream); processor = context.createScriptProcessor(4096, 1, 1);
    gain = context.createGain(); gain.gain.value = 0;
    source.connect(processor); processor.connect(gain); gain.connect(context.destination);
    processor.onaudioprocess = event => {
      if (audioSocket.readyState !== WebSocket.OPEN || audioSocket.bufferedAmount > 256 * 1024 || options.signal?.aborted) return;
      audioSocket.send(setupPcm16(event.inputBuffer.getChannelData(0), audioContext.sampleRate));
    };
    let playedBytes = 0; let nextPlaybackTime = 0;
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (passed: boolean) => {
        if (settled) return; settled = true;
        if (passed) resolve(); else reject(new Error("Microphone and playback could not be verified."));
      };
      onAbort = () => finish(false); options.signal?.addEventListener("abort", onAbort, { once: true });
      if (options.signal?.aborted) { finish(false); return; }
      timer = setTimeout(() => finish(false), 45_000);
      audioSocket.onmessage = event => {
        if (settled) return;
        if (event.data instanceof ArrayBuffer) {
          if (!event.data.byteLength || event.data.byteLength % 2 || event.data.byteLength > 64 * 1024) { finish(false); return; }
          const data = new DataView(event.data); const output = audioContext.createBuffer(1, data.byteLength / 2, 16000);
          const channel = output.getChannelData(0);
          for (let index = 0; index < channel.length; index++) channel[index] = data.getInt16(index * 2, true) / 32768;
          const node = audioContext.createBufferSource(); node.buffer = output; node.connect(audioContext.destination); playing.add(node);
          node.onended = () => {
            playing.delete(node); if (settled) return;
            playedBytes += data.byteLength;
            if (playedBytes >= 9600 && audioSocket.readyState === WebSocket.OPEN) audioSocket.send(JSON.stringify({ type: "playback-complete", playedBytes }));
          };
          const start = Math.max(audioContext.currentTime, nextPlaybackTime); nextPlaybackTime = start + output.duration; node.start(start);
          return;
        }
        try {
          const message = JSON.parse(String(event.data));
          if (message.type === "verified") { options.onStatus?.("Microphone and playback verified by the server."); finish(true); }
          else if (message.type === "failed") finish(false);
          else if (message.type === "listening") options.onStatus?.("Speak a short sentence. The service will reply through your speakers.");
        } catch { finish(false); }
      };
      audioSocket.onerror = () => finish(false); audioSocket.onclose = () => finish(false);
    });
  } finally {
    clearTimeout(timer); if (onAbort) options.signal?.removeEventListener("abort", onAbort);
    if (processor) processor.onaudioprocess = null;
    for (const node of playing) { node.onended = null; try { node.stop(); } catch {} } playing.clear();
    processor?.disconnect(); source?.disconnect(); gain?.disconnect();
    if (socket) { socket.onmessage = null; socket.onerror = null; socket.onclose = null; if (socket.readyState < WebSocket.CLOSING) socket.close(); }
    stream?.getTracks().forEach(track => track.stop());
    if (context && context.state !== "closed") await context.close().catch(() => undefined);
  }
}
