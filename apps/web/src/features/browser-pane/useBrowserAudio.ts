import { getSpaceVolume, subscribeSpaceVolume } from '../../space-audio.js';
import { useEffect, useState } from "react";
import { browserStreamWebSocketServerMessageSchema } from "@space/contracts";
import { api } from "../../api.js";
import { getSpaceRuntime } from "../../runtime/SpaceRuntime.js";

type AudioState = "idle" | "connecting" | "playing" | "blocked";
type Listener = { paneId: string; sessionId: string; update: (state: AudioState) => void };
const listeners = new Map<symbol, Listener>();
let state: AudioState = "idle";
let owner: Listener | null = null;
let socket: WebSocket | null = null;
let context: AudioContext | null = null;
let gain: GainNode | null = null;
let unsubscribeVolume: (() => void) | null = null;
let generation = 0;
let retry: number | null = null;
let nextTime = 0;
let sampleRate = 48000;
let channels = 2;

function publish(next: AudioState) {
  state = next;
  listeners.forEach(listener => listener.update(next));
}

function unlock() {
  if (!context || context.state === "closed") return;
  void context.resume().then(() => {
    if (context?.state === "running") publish("playing");
  }).catch(() => undefined);
}

function stop() {
  generation++;
  if (retry !== null) window.clearTimeout(retry);
  retry = null;
  socket?.close();
  socket = null;
  if (context) { context.onstatechange = null; void context.close().catch(() => undefined); }
  unsubscribeVolume?.();
  unsubscribeVolume = null;
  gain?.disconnect();
  gain = null;
  context = null;
  nextTime = 0;
  owner = null;
  window.removeEventListener("pointerdown", unlock);
  window.removeEventListener("keydown", unlock);
}

async function connect(listener: Listener) {
  const current = ++generation;
  publish("connecting");
  const reconnect = () => {
    if (current !== generation || retry !== null || listeners.size === 0) return;
    publish("connecting");
    retry = window.setTimeout(() => { retry = null; void connect(listener); }, 2000);
  };
  try {
    const ticket = await api.browserAudioStreamTicket(listener.paneId);
    if (current !== generation) return;
    if (ticket.websocket.sessionId !== listener.sessionId) { reconnect(); return; }
    const url = api.browserAudioWebSocketUrl(ticket.websocket);
    if (!url) return;
    const ws = new WebSocket(url);
    socket = ws;
    ws.binaryType = "arraybuffer";
    ws.addEventListener("message", event => {
      if (current !== generation) return;
      if (typeof event.data === "string") {
        try {
          const message = browserStreamWebSocketServerMessageSchema.parse(JSON.parse(event.data));
          if (message.type !== "audioReady" || message.paneId !== listener.paneId || message.sessionId !== listener.sessionId) return;
          sampleRate = message.sampleRate;
          channels = message.channels;
          if (!context) {
            const Constructor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
            if (!Constructor) return;
            context = new Constructor({ sampleRate });
            gain = context.createGain();
            gain.gain.value = getSpaceVolume();
            gain.connect(context.destination);
            unsubscribeVolume = subscribeSpaceVolume(volume => { if (gain) gain.gain.value = volume; });
            context.onstatechange = () => publish(context?.state === "running" ? "playing" : "blocked");
          }
          publish(context.state === "running" ? "playing" : "blocked");
          unlock();
        } catch { /* Ignore invalid control frames. */ }
        return;
      }
      // Do not accumulate audio while browser autoplay is suspended.
      if (!context || !gain || context.state !== "running" || !(event.data instanceof ArrayBuffer) || event.data.byteLength % 2) return;
      const samples = new Int16Array(event.data);
      const frames = Math.floor(samples.length / channels);
      if (!frames || frames > sampleRate) return;
      const buffer = context.createBuffer(channels, frames, sampleRate);
      for (let channel = 0; channel < channels; channel++) {
        const output = buffer.getChannelData(channel);
        for (let i = 0; i < frames; i++) output[i] = (samples[i * channels + channel] ?? 0) / 32768;
      }
      const now = context.currentTime;
      if (nextTime < now + 0.06 || nextTime > now + 0.16) nextTime = now + 0.06;
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(gain);
      source.start(nextTime);
      nextTime += buffer.duration;
    });
    ws.addEventListener("close", reconnect);
    ws.addEventListener("error", () => ws.close());
  } catch { reconnect(); }
}

function reconcile() {
  // The managed browser host provides one mixed audio sink. Subscribe once per
  // Space tab, even when several Internet / YouTube panes are mounted.
  if (owner && [...listeners.values()].some(listener => listener.paneId === owner?.paneId && listener.sessionId === owner?.sessionId)) return;
  stop();
  const next = listeners.values().next().value as Listener | undefined;
  if (!next) { publish("idle"); return; }
  owner = next;
  window.addEventListener("pointerdown", unlock);
  window.addEventListener("keydown", unlock);
  void connect(next);
}

export function useBrowserAudio(paneId: string, sessionId: string | undefined, enabled = true) {
  const [audioState, setAudioState] = useState<AudioState>("idle");
  useEffect(() => {
    if (!enabled || !sessionId || getSpaceRuntime().kind !== "live" || typeof api.browserAudioStreamTicket !== "function") return;
    const key = Symbol();
    listeners.set(key, { paneId, sessionId, update: setAudioState });
    setAudioState(state);
    reconcile();
    return () => { listeners.delete(key); reconcile(); };
  }, [enabled, paneId, sessionId]);
  return { audioState, resumeAudio: unlock };
}
