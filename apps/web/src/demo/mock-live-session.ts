import type { LiveSessionOptions, LiveSessionCallbacks, LiveSessionHandle } from "../features/live-pane/live-session.js";

/** Recorded conversation transport. No microphone, provider or network access. */
export async function openMockLiveSession(options: LiveSessionOptions, callbacks: LiveSessionCallbacks): Promise<LiveSessionHandle> {
  let closed = false, muted = Boolean(options.muted), sequence = 0;
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const audio = document.createElement("audio");
  audio.src = `${import.meta.env.BASE_URL}demo/media/hello-there.wav`;
  const later = (run: () => void, delay: number) => {
    const timer = setTimeout(() => { timers.delete(timer); if (!closed) run(); }, delay);
    timers.add(timer);
  };
  const transcript = (role: "user" | "assistant", text: string) => callbacks.onTranscriptUpdate?.({
    id: `mock-live:${options.paneId ?? "shared"}:${Date.now()}:${++sequence}`, role, text,
    timestamp: new Date().toISOString(), createdAtMs: Date.now(), roomId: options.roomId
  });
  const reply = (text: string) => {
    callbacks.onStatusChange?.("thinking");
    later(() => {
      transcript("assistant", text); callbacks.onStatusChange?.("speaking");
      callbacks.onAudioLevel?.(0.45, "assistant");
      if (!muted) void audio.play().catch(() => undefined);
      later(() => { callbacks.onAudioLevel?.(0, "assistant"); callbacks.onStatusChange?.("listening"); }, 1100);
    }, 450);
  };
  const send = (text: string) => { if (closed || !text.trim()) return; transcript("user", text); reply(`I received your message: ${text}. You can explore rooms, files, settings and workspace tools here. This demo conversation runs locally.`); };
  callbacks.onStatusChange?.("connecting");
  later(() => { callbacks.onStatusChange?.("listening"); if (!options.suppressGreeting) reply("Hello! Welcome to Space. Explore the workspace and try the controls. This is a recorded local conversation."); }, 100);
  return {
    close() { closed = true; for (const timer of timers) clearTimeout(timer); timers.clear(); audio.pause(); callbacks.onAudioLevel?.(0, "assistant"); callbacks.onStatusChange?.("idle"); },
    setMuted(value) { muted = value; audio.muted = value; }, isMuted: () => muted,
    sendTextMessage: send, sendInput: parts => send(parts.map(part => part.type === "text" ? part.text : `[${part.type} attachment]`).join(" ")),
    notify(text) { if (closed) return false; reply(text); return true; }
  };
}
