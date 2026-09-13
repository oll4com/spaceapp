import { api } from "../../api.js";
import type { LivePersonalMemoryItem } from "../../live-api.js";
import type {
  VoiceModelVoice,
  VoiceTranscriptionDelay,
  VoiceTranscriptionLanguage,
  VoiceTranscriptionModel,
  MemoryEntry
} from "@space/contracts";
import { getSpaceRuntime, DEMO_LOCAL_REPLY } from "../../runtime/SpaceRuntime.js";

export interface LiveSessionOptions {
  paneId?: string;
  model: VoiceTranscriptionModel | string;
  language?: VoiceTranscriptionLanguage;
  delay?: VoiceTranscriptionDelay;
  voice?: VoiceModelVoice;
  opening?: string;
  prompt?: string;
  delegatedModel?: string;
  delegatedType?: "responses" | "client";
  delegatedReasoningEffort?: "minimal" | "low" | "medium" | "high" | "xhigh";
  delegatedWebSearch?: boolean;
  delegatedPrompt?: string;
  audioDeviceId?: string;
  enableGeminiMemory?: boolean;
  micSilenceWarnMs?: number;
  timeZone?: string;
  personalMemories?: LivePersonalMemoryItem[];
}

export type LiveInputPart =
  | { type: "text"; text: string }
  | { type: "image"; dataUrl: string; filename?: string }
  | { type: "file"; dataUrl: string; filename: string; mimeType: string };

export interface LiveTranscriptItem {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
  isDelta?: boolean;
  timestamp: string;
  createdAtMs?: number;
  toolCall?: {
    name: string;
    query?: string;
    resultSummary?: string;
    status: "running" | "done" | "error";
  };
}

export interface LiveSessionCallbacks {
  onStatusChange?: (status: "idle" | "connecting" | "active" | "listening" | "speaking" | "error") => void;
  onTranscriptUpdate?: (item: LiveTranscriptItem) => void;
  onPersonalMemoryUpdate?: (item: LivePersonalMemoryItem) => void;
  onRemoteStream?: (stream: MediaStream) => void;
  onAudioLevel?: (level: number, source: "user" | "assistant") => void;
  onMicSilence?: (silent: boolean) => void;
  onLogEvent?: (type: string, payload: unknown) => void;
  onError?: (message: string) => void;
}

export interface LiveSessionHandle {
  close: () => void;
  setMuted: (muted: boolean) => void;
  isMuted: () => boolean;
  sendTextMessage: (text: string) => void;
  sendInput?: (parts: LiveInputPart[]) => void | Promise<void>;
}

function pcm16FromFloat32(input: Float32Array): ArrayBuffer {
  const output = new ArrayBuffer(input.length * 2);
  const view = new DataView(output);
  for (let i = 0; i < input.length; i += 1) {
    const sample = Math.max(-1, Math.min(1, input[i] ?? 0));
    view.setInt16(i * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
  }
  return output;
}

async function openLocalVoiceConversationSession(
  options: LiveSessionOptions,
  callbacks: LiveSessionCallbacks,
  paneId: string
): Promise<LiveSessionHandle> {
  const stream = await getSpaceRuntime().platform.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
  const session = await api.createLocalVoiceSession({ paneId, language: options.language === "en" ? "en-US" : "el-GR", opening: options.opening, prompt: options.prompt });
  const wsUrl = typeof session.websocket_url === "string" ? session.websocket_url : typeof session.ws_url === "string" ? session.ws_url : typeof session.url === "string" ? session.url : "";
  if (!wsUrl) {
    stream.getTracks().forEach((track) => track.stop());
    throw new Error("Local voice provider did not return a WebSocket session URL.");
  }
  const socket = new WebSocket(wsUrl, typeof session.token === "string" ? [session.token] : undefined);
  socket.binaryType = "arraybuffer";
  const audioContext = new AudioContext();
  const source = audioContext.createMediaStreamSource(stream);
  const processor = audioContext.createScriptProcessor(4096, 1, 1);
  const output = audioContext.createGain();
  output.gain.value = 1;
  source.connect(processor);
  processor.connect(output);
  output.connect(audioContext.destination);
  let muted = false;
  let closed = false;
  const playPcm = (buffer: ArrayBuffer) => {
    const samples = new Int16Array(buffer);
    const audio = audioContext.createBuffer(1, samples.length, 16000);
    const channel = audio.getChannelData(0);
    for (let i = 0; i < samples.length; i += 1) channel[i] = (samples[i] ?? 0) / 32768;
    const node = audioContext.createBufferSource();
    node.buffer = audio;
    node.connect(audioContext.destination);
    node.start();
  };
  socket.onopen = () => { callbacks.onStatusChange?.("active"); socket.send(JSON.stringify({ type: "start", sample_rate: 16000, language: options.language ?? "auto" })); };
  socket.onmessage = (event) => {
    if (event.data instanceof ArrayBuffer) { playPcm(event.data); return; }
    try {
      const message = JSON.parse(String(event.data)) as { type?: string; text?: string; message?: string; audio_base64?: string };
      if (message.audio_base64) playPcm(Uint8Array.from(atob(message.audio_base64), (char) => char.charCodeAt(0)).buffer);
      if (message.type === "user_transcript" || message.type === "assistant_text") callbacks.onTranscriptUpdate?.({ id: `${message.type}-${Date.now()}`, role: message.type === "user_transcript" ? "user" : "assistant", text: message.text ?? "", timestamp: new Date().toISOString() });
      if (message.type === "speaking") callbacks.onStatusChange?.("speaking");
      if (message.type === "listening") callbacks.onStatusChange?.("listening");
      if (message.type === "error") callbacks.onError?.(message.message ?? "Local voice provider error.");
    } catch { /* Ignore malformed provider events. */ }
  };
  socket.onerror = () => callbacks.onError?.("Local voice provider connection failed.");
  socket.onclose = () => { if (!closed) callbacks.onStatusChange?.("error"); };
  processor.onaudioprocess = (event) => { if (!muted && socket.readyState === WebSocket.OPEN) socket.send(pcm16FromFloat32(event.inputBuffer.getChannelData(0))); };
  return {
    close: () => { closed = true; socket.close(); processor.disconnect(); source.disconnect(); output.disconnect(); audioContext.close(); stream.getTracks().forEach((track) => track.stop()); callbacks.onStatusChange?.("idle"); },
    setMuted: (next) => { muted = next; stream.getAudioTracks().forEach((track) => { track.enabled = !next; }); if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: next ? "mute" : "unmute" })); },
    isMuted: () => muted,
    sendTextMessage: (text) => { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "text", text })); }
  };
}

/** Serialize only client events supported by the Space Live bridge. */
export function createLiveClientEvent(
  type: "response.create" | "session.input_audio.mute" | "session.input_audio.unmute" | "session.close"
) {
  return JSON.stringify({ type });
}

export function createLiveInstructionsAppend(content: string, eventId = "live_opening_greeting"): string {
  return JSON.stringify({ type: "session.instructions.append", event_id: eventId, delegation_id: null, content });
}

export function createLiveCommentaryAppend(text: string, eventId = "live_commentary"): string {
  return JSON.stringify({ type: "session.commentary.append", event_id: eventId, delegation_id: null, content: text });
}

export const SAVE_PERSONAL_MEMORY_TOOL = {
  type: "function",
  name: "save_personal_memory",
  description:
    "Saves or updates a fact, preference, user profile attribute (e.g. user name, nicknames, rules, personal instructions, hobbies, habits) into the persistent Personal Live Memory.",
  parameters: {
    type: "object",
    properties: {
      key: {
        type: "string",
        description: "The identifier or topic of the memory (e.g. 'userName', 'favoriteCoffee', 'projectGoal', 'userRule')."
      },
      value: {
        type: "string",
        description: "The fact, description, or detail to remember (e.g. 'Νικόλας', 'Prefers Greek language in conversation')."
      },
      category: {
        type: "string",
        enum: ["profile", "preference", "fact", "instruction", "note"],
        description: "Category of the memory. Defaults to 'profile' or 'preference'."
      }
    },
    required: ["key", "value"]
  }
};

export const SEARCH_PERSONAL_MEMORY_TOOL = {
  type: "function",
  name: "search_personal_memory",
  description:
    "Searches and retrieves the user's personal profile, name (Νικόλας), personal facts, habits, and private preferences from Personal Live Memory. ALWAYS use this tool (or the active Personal Live Memory Profile) when the user asks what you know about them, asks about their name/identity, or asks to read their personal memory ('διάβασε την προσωπική σου μνήμη', 'ποιος είμαι', 'τι ξέρεις για μένα').",
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Optional search keyword to filter personal memories. If omitted, returns all personal memories."
      }
    }
  }
};

export const CURRENT_TIME_TOOL = {
  type: "function",
  name: "get_current_time",
  description:
    "Gets the current live date, day of the week, and exact time down to the second. Defaults to Thailand time (Asia/Bangkok, UTC+7), or any specified timezone.",
  parameters: {
    type: "object",
    properties: {
      timeZone: {
        type: "string",
        description: "Optional IANA timezone name (e.g. 'Asia/Bangkok', 'Europe/Athens', 'UTC'). Defaults to 'Asia/Bangkok'."
      }
    }
  }
};

export const SEARCH_WEB_TOOL = {
  type: "function",
  name: "search_web",
  description:
    "Searches the web and live internet for current news, facts, weather forecasts, articles, businesses, or real-time web knowledge.",
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "The search query to look up on the internet (e.g. 'weather in Bangkok', 'latest news', 'who won the match')."
      }
    },
    required: ["query"]
  }
};

export const FETCH_WEB_PAGE_TOOL = {
  type: "function",
  name: "fetch_web_page",
  description:
    "Fetches and reads the clean text content of any website, URL, or domain (e.g. 'https://www.ola.gr', 'ola.gr') to inspect what is on the site.",
  parameters: {
    type: "object",
    properties: {
      url: {
        type: "string",
        description: "The website URL or domain name to fetch and inspect."
      }
    },
    required: ["url"]
  }
};

export const GEMINI_MEMORY_TOOL = {
  type: "function",
  name: "recall_gemini_memory",
  description:
    "Searches technical developer documentation, system state, server logs, Proxmox VM configs, deployment procedures, codebase architecture, and historical project notes from the Gemini documentation graph. Do NOT use this tool for user personal identity or personal memory (use search_personal_memory instead).",
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Keywords or search term to query technical Gemini memory (e.g. 'Proxmox backup status', 'deploy procedure', 'Asteroids game rules')"
      },
      limit: {
        type: "number",
        description: "Maximum number of entries to return (default 3, max 5)"
      }
    },
    required: ["query"]
  }
};

export function formatCurrentTimeForModel(timeZone = "Asia/Bangkok"): string {
  try {
    const now = new Date();
    const formatted = new Intl.DateTimeFormat("en-US", {
      timeZone,
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false
    }).format(now);
    const dayOfWeek = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "long" }).format(now);
    const tzLabel = timeZone === "Asia/Bangkok" ? "Thailand Time (ICT, UTC+7)" : timeZone;
    return JSON.stringify({
      currentDate: formatted,
      dayOfWeek,
      timeZone,
      tzLabel,
      timestamp: now.toISOString()
    });
  } catch {
    const now = new Date();
    return JSON.stringify({
      currentDate: now.toUTCString(),
      dayOfWeek: new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "long" }).format(now),
      timeZone: "UTC",
      timestamp: now.toISOString()
    });
  }
}

export function getGreetingForThailandTime(userName = "Νικόλας", timeZone = "Asia/Bangkok"): string {
  try {
    const hourStr = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour: "numeric",
      hour12: false
    }).format(new Date());
    const hour = parseInt(hourStr, 10);
    const raw = userName.trim();
    const vocativeName = raw.endsWith("ς") ? raw.slice(0, -1) : raw;
    if (hour >= 5 && hour < 12) {
      return `Καλημέρα ${vocativeName}, τι κάνεις;`;
    }
    return `Καλησπέρα ${vocativeName}, τι κάνεις;`;
  } catch {
    const raw = userName.trim();
    const vocativeName = raw.endsWith("ς") ? raw.slice(0, -1) : raw;
    return `Καλησπέρα ${vocativeName}, τι κάνεις;`;
  }
}

export function formatPersonalMemoryForModel(items: LivePersonalMemoryItem[]): string {
  if (!items || items.length === 0) {
    return "No personal memory entries recorded yet.";
  }
  return items
    .map((m, idx) => `[Personal Memory #${idx + 1}] (${m.category || "profile"}): ${m.key} = ${m.value}`)
    .join("\n");
}

export function formatWebSearchResultsForModel(
  results: Array<{ title: string; snippet: string; url?: string }>,
  query: string
): string {
  if (!results || results.length === 0) {
    return `No internet search results found for: "${query}".`;
  }
  const formatted = results
    .map((r, idx) => `[Result #${idx + 1}: ${r.title}${r.url ? ` (${r.url})` : ""}]\n${r.snippet}`)
    .join("\n\n");
  return `Internet search results for "${query}":\n\n${formatted}`;
}

export function formatWebPageForModel(data: { url: string; title: string; text: string }): string {
  if (!data || !data.text) {
    return `Could not extract text from website: ${data?.url || "unknown"}.`;
  }
  return `Website content for ${data.url} (${data.title || "Untitled"}):\n\n${data.text}`;
}

export function formatMemoryForModel(entries: MemoryEntry[], query: string, limit = 3): string {
  if (!entries || entries.length === 0) {
    return `No memory records found in Gemini memory for query: "${query}".`;
  }
  const selected = entries.slice(0, limit);
  const formatted = selected
    .map((entry, idx) => {
      const cleanBody = entry.body.replace(/<!--[\s\S]*?-->/g, "").trim().slice(0, 1000);
      return `[Memory #${idx + 1}: ${entry.title} (${entry.provenance})]\n${cleanBody}`;
    })
    .join("\n\n");
  return `Found ${entries.length} memory records. Top ${selected.length} matches:\n\n${formatted}`;
}

export async function openLiveConversationSession(
  options: LiveSessionOptions,
  callbacks: LiveSessionCallbacks = {}
): Promise<LiveSessionHandle> {
  if (options.model === "local-qwen3-greek") {
    return openLocalVoiceConversationSession(options, callbacks, options.paneId ?? "live");
  }
  const runtime = getSpaceRuntime();
  if (runtime.kind === "demo") {
    throw new Error(DEMO_LOCAL_REPLY);
  }
  if (!runtime.platform.userMediaSupported) {
    throw new Error("Microphone capture is not available in this browser.");
  }
  if (!runtime.platform.peerConnectionSupported) {
    throw new Error("Realtime WebRTC voice input is not available in this browser.");
  }

  callbacks.onStatusChange?.("connecting");

  const tz = options.timeZone || "Asia/Bangkok";
  const userName =
    options.personalMemories?.find((m) => m.key.toLowerCase() === "username")?.value || "Νικόλας";
  const dynamicGreeting = getGreetingForThailandTime(userName, tz);
  const effectiveOpening = options.opening !== undefined ? options.opening : dynamicGreeting;

  const audioConstraints: MediaTrackConstraints = {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true
  };
  if (options.audioDeviceId) {
    audioConstraints.deviceId = { ideal: options.audioDeviceId };
  }

  const stream = await runtime.platform.getUserMedia({ audio: audioConstraints });
  for (const track of stream.getAudioTracks()) {
    track.enabled = true;
  }

  let closed = false;
  let muted = false;

  let micAudioCtx: AudioContext | null = null;
  let micAnimId: number | null = null;
  let analyserStream: MediaStream | null = null;
  let assistantSpeaking = false;
  let userSpeaking = false;
  let silenceTimer: ReturnType<typeof setTimeout> | null = null;

  const pendingCallsByItemId = new Map<string, { id: string; name: string; callId: string; arguments: string }>();
  const pendingCallsByCallId = new Map<string, { id: string; name: string; callId: string; arguments: string }>();
  const pendingCallIds = new Set<string>();
  const executedCallIds = new Set<string>();
  const pendingFunctionItemIds = new Set<string>();
  const activeResponseIds = new Set<string>();
  let hasPendingToolOutputs = false;

  const isResponseInProgress = () => activeResponseIds.size > 0;

  const maybeTriggerToolsResponse = () => {
    if (closed || channel.readyState !== "open") return;
    if (isResponseInProgress()) return;
    if (pendingCallIds.size > 0 || pendingFunctionItemIds.size > 0) return;
    if (!hasPendingToolOutputs) return;

    hasPendingToolOutputs = false;
    callbacks.onLogEvent?.("tools.batch_completed", { executedCalls: Array.from(executedCallIds) });
    try {
      channel.send(JSON.stringify({ type: "response.create" }));
    } catch (err) {
      console.warn("Failed to trigger response.create after tool calls:", err);
    }
  };

  let openingInstructionsSent = false;
  let openingResponseRequested = false;

  try {
    const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
    if (AudioContextClass) {
      micAudioCtx = new AudioContextClass();
      if (micAudioCtx.state === "suspended") {
        void micAudioCtx.resume();
      }
      analyserStream = typeof stream.clone === "function" ? stream.clone() : stream;
      const micSource = micAudioCtx.createMediaStreamSource(analyserStream);
      const analyser = micAudioCtx.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.3;
      micSource.connect(analyser);
      const dataArray = new Uint8Array(analyser.frequencyBinCount);

      const micSilenceWarnMs = options.micSilenceWarnMs ?? 3000;
      let silentSince: number | null = null;
      let silenceWarned = false;

      const monitorAudio = () => {
        if (closed) return;
        analyser.getByteFrequencyData(dataArray);
        let sum = 0;
        for (let i = 0; i < dataArray.length; i++) {
          sum += dataArray[i] ?? 0;
        }
        const avg = sum / dataArray.length;
        const normalized = Math.min(1, avg / 128);
        callbacks.onAudioLevel?.(normalized, "user");

        if (!muted && !assistantSpeaking && channel.readyState === "open") {
          if (normalized > 0.05) {
            if (silentSince !== null) {
              silentSince = null;
              if (silenceWarned) {
                silenceWarned = false;
                callbacks.onMicSilence?.(false);
              }
            }
          } else if (silentSince === null) {
            silentSince = Date.now();
          } else if (!silenceWarned && Date.now() - silentSince >= micSilenceWarnMs) {
            silenceWarned = true;
            callbacks.onLogEvent?.("mic.no_audio_detected", { durationMs: Date.now() - silentSince });
            callbacks.onMicSilence?.(true);
          }
        } else if (silentSince !== null) {
          silentSince = null;
          if (silenceWarned) {
            silenceWarned = false;
            callbacks.onMicSilence?.(false);
          }
        }

        if (!muted) {
          if (normalized > 0.05) {
            if (!userSpeaking) {
              userSpeaking = true;
              callbacks.onStatusChange?.("listening");
            }
            if (silenceTimer) {
              clearTimeout(silenceTimer);
              silenceTimer = null;
            }
          } else if (userSpeaking) {
            if (!silenceTimer) {
              silenceTimer = setTimeout(() => {
                userSpeaking = false;
                silenceTimer = null;
                if (!assistantSpeaking) {
                  callbacks.onStatusChange?.("active");
                }
              }, 700);
            }
          }
        }

        micAnimId = requestAnimationFrame(monitorAudio);
      };
      micAnimId = requestAnimationFrame(monitorAudio);
    }
  } catch (err) {
    console.warn("AudioContext microphone analyser warning:", err);
  }

  const connection = runtime.platform.createPeerConnection();
  const channel = connection.createDataChannel("oai-events");

  let remoteAudioEl: HTMLAudioElement | null = null;
  let audioCtx: AudioContext | null = null;

  connection.addEventListener("track", (event) => {
    const remoteStream =
      event.streams && event.streams[0]
        ? event.streams[0]
        : new MediaStream([event.track]);

    // 1. Notify UI component so its mounted <audio> element plays the stream
    callbacks.onRemoteStream?.(remoteStream);

    // 2. Play via DOM-attached HTMLAudioElement as secondary path
    try {
      if (!remoteAudioEl) {
        remoteAudioEl = document.createElement("audio");
        remoteAudioEl.autoplay = true;
        remoteAudioEl.setAttribute("playsinline", "true");
        remoteAudioEl.style.display = "none";
        document.body.appendChild(remoteAudioEl);
      }
      remoteAudioEl.srcObject = remoteStream;
      remoteAudioEl.play().catch((err) => console.warn("Live audio element play warning:", err));
    } catch (err) {
      console.warn("DOM audio element warning:", err);
    }

    // 3. Play via Web Audio API directly to speaker destination
    try {
      const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
      if (AudioContextClass) {
        if (!audioCtx || audioCtx.state === "closed") {
          audioCtx = new AudioContextClass();
        }
        if (audioCtx.state === "suspended") {
          void audioCtx.resume();
        }
        const source = audioCtx.createMediaStreamSource(remoteStream);
        source.connect(audioCtx.destination);
      }
    } catch (err) {
      console.warn("AudioContext speaker routing warning:", err);
    }
  });

  const fail = (msg: string) => {
    if (closed) return;
    callbacks.onError?.(msg);
    callbacks.onStatusChange?.("error");
    close();
  };

  const close = () => {
    if (closed) return;
    closed = true;
    callbacks.onStatusChange?.("idle");
    if (silenceTimer) {
      clearTimeout(silenceTimer);
      silenceTimer = null;
    }
    pendingCallIds.clear();
    executedCallIds.clear();
    pendingFunctionItemIds.clear();
    activeResponseIds.clear();
    hasPendingToolOutputs = false;
    try {
      if (channel.readyState === "open") {
        channel.send(JSON.stringify({ type: "session.close" }));
      }
    } catch {}
    try {
      channel.close();
    } catch {}
    try {
      if (remoteAudioEl) {
        remoteAudioEl.pause();
        remoteAudioEl.srcObject = null;
        if (remoteAudioEl.parentNode) {
          remoteAudioEl.parentNode.removeChild(remoteAudioEl);
        }
        remoteAudioEl = null;
      }
    } catch {}
    try {
      if (audioCtx && audioCtx.state !== "closed") {
        void audioCtx.close();
      }
      audioCtx = null;
    } catch {}
    if (micAnimId !== null) {
      cancelAnimationFrame(micAnimId);
      micAnimId = null;
    }
    try {
      if (micAudioCtx && micAudioCtx.state !== "closed") {
        void micAudioCtx.close();
      }
      micAudioCtx = null;
    } catch {}
    try {
      if (analyserStream && analyserStream !== stream) {
        analyserStream.getTracks().forEach((t) => t.stop());
      }
    } catch {}
    connection.getSenders().forEach((s) => s.track?.stop());
    stream.getTracks().forEach((t) => t.stop());
    try {
      connection.close();
    } catch {}
  };

  for (const track of stream.getAudioTracks()) {
    connection.addTrack(track, stream);
  }

  let activeUserMsgId: string | null = null;
  let userTurnStartTime = 0;
  let activeAssistantMsgId: string | null = null;
  let assistantTurnStartTime = 0;
  let hasDelegatedAssistantText = false;
  const itemIdToTurnId = new Map<string, string>();

  channel.addEventListener("open", () => {
    callbacks.onStatusChange?.("active");
    callbacks.onLogEvent?.("channel.open", { readyState: channel.readyState });
    try {
      channel.send(JSON.stringify({ type: "session.input_audio.unmute" }));
    } catch (err) {
      console.warn("Failed to unmute live audio input:", err);
    }
  });

  channel.addEventListener("close", () => {
    callbacks.onLogEvent?.("channel.close", {});
    if (!closed) {
      fail("Live session channel closed unexpectedly.");
    }
  });

  channel.addEventListener("error", () => {
    callbacks.onLogEvent?.("channel.error", {});
    if (!closed) {
      fail("Live session DataChannel error.");
    }
  });

  const executeFunctionCall = async (callId: string, name: string, argsStr: string) => {
    if (!callId || executedCallIds.has(callId)) return;
    executedCallIds.add(callId);
    pendingCallIds.add(callId);
    hasPendingToolOutputs = true;

    try {
      if (name === "save_personal_memory") {
        let parsedKey = "";
        let parsedValue = "";
        let parsedCategory = "profile";
        try {
          const parsedArgs = JSON.parse(argsStr) as { key?: string; value?: string; category?: string };
          parsedKey = parsedArgs.key?.trim() || "";
          parsedValue = parsedArgs.value?.trim() || "";
          if (parsedArgs.category) parsedCategory = parsedArgs.category.trim();
        } catch {}

        const toolMsgId = `tool_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
        callbacks.onTranscriptUpdate?.({
          id: toolMsgId,
          role: "system",
          text: `Saving to personal memory: ${parsedKey} = ${parsedValue}`,
          timestamp: new Date().toLocaleTimeString(),
          toolCall: {
            name: "save_personal_memory",
            query: `${parsedKey}: ${parsedValue}`,
            status: "running"
          }
        });

        let outputText = "";
        try {
          const res = await api.saveLivePersonalMemory({
            key: parsedKey,
            value: parsedValue,
            category: parsedCategory
          });
          if (res?.item) {
            callbacks.onPersonalMemoryUpdate?.(res.item);
          }
          outputText = `Successfully saved to personal memory: "${parsedKey}": "${parsedValue}" (Category: ${parsedCategory}). Now confirm warmly to the user in Greek that you saved this permanently into their personal memory.`;
          callbacks.onTranscriptUpdate?.({
            id: toolMsgId,
            role: "system",
            text: `Saved to personal memory: ${parsedKey} = ${parsedValue}`,
            timestamp: new Date().toLocaleTimeString(),
            toolCall: {
              name: "save_personal_memory",
              query: `${parsedKey}: ${parsedValue}`,
              resultSummary: `Saved ${parsedKey}`,
              status: "done"
            }
          });
        } catch (err) {
          outputText = `Error saving personal memory: ${err instanceof Error ? err.message : String(err)}`;
          callbacks.onTranscriptUpdate?.({
            id: toolMsgId,
            role: "system",
            text: `Failed to save personal memory: ${outputText}`,
            timestamp: new Date().toLocaleTimeString(),
            toolCall: {
              name: "save_personal_memory",
              query: `${parsedKey}: ${parsedValue}`,
              resultSummary: "Save error",
              status: "error"
            }
          });
        }

        if (channel.readyState === "open") {
          try {
            channel.send(
              JSON.stringify({
                type: "response.item.create",
                item: {
                  type: "function_call_output",
                  call_id: callId,
                  output: outputText
                }
              })
            );
          } catch (err) {
            console.warn("Failed to send save_personal_memory output:", err);
          }
        }
      } else if (name === "search_personal_memory") {
        let parsedQuery = "";
        try {
          const parsedArgs = JSON.parse(argsStr) as { query?: string };
          parsedQuery = parsedArgs.query?.trim() || "";
        } catch {}

        const toolMsgId = `tool_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
        callbacks.onTranscriptUpdate?.({
          id: toolMsgId,
          role: "system",
          text: `Searching personal memory${parsedQuery ? ` for: "${parsedQuery}"` : ""}`,
          timestamp: new Date().toLocaleTimeString(),
          toolCall: {
            name: "search_personal_memory",
            query: parsedQuery,
            status: "running"
          }
        });

        let outputText = "";
        try {
          const res = await api.getLivePersonalMemory();
          let items = res.items || [];
          if (parsedQuery) {
            const q = parsedQuery.toLowerCase();
            items = items.filter(
              (i) =>
                i.key.toLowerCase().includes(q) ||
                i.value.toLowerCase().includes(q) ||
                (i.category && i.category.toLowerCase().includes(q))
            );
          }
          outputText = formatPersonalMemoryForModel(items);
          callbacks.onTranscriptUpdate?.({
            id: toolMsgId,
            role: "system",
            text: `Recalled ${items.length} personal memory records`,
            timestamp: new Date().toLocaleTimeString(),
            toolCall: {
              name: "search_personal_memory",
              query: parsedQuery,
              resultSummary: `${items.length} records found`,
              status: "done"
            }
          });
        } catch (err) {
          outputText = `Error searching personal memory: ${err instanceof Error ? err.message : String(err)}`;
          callbacks.onTranscriptUpdate?.({
            id: toolMsgId,
            role: "system",
            text: `Failed to search personal memory: ${outputText}`,
            timestamp: new Date().toLocaleTimeString(),
            toolCall: {
              name: "search_personal_memory",
              query: parsedQuery,
              resultSummary: "Search error",
              status: "error"
            }
          });
        }

        if (channel.readyState === "open") {
          try {
            channel.send(
              JSON.stringify({
                type: "response.item.create",
                item: {
                  type: "function_call_output",
                  call_id: callId,
                  output: outputText
                }
              })
            );
          } catch (err) {
            console.warn("Failed to send search_personal_memory output:", err);
          }
        }
      } else if (name === "get_current_time") {
        let parsedTz = options.timeZone || "Asia/Bangkok";
        try {
          const parsedArgs = JSON.parse(argsStr) as { timeZone?: string };
          if (parsedArgs.timeZone) parsedTz = parsedArgs.timeZone;
        } catch {}

        const toolMsgId = `tool_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
        const outputText = formatCurrentTimeForModel(parsedTz);
        let displayTime = "";
        try {
          const parsed = JSON.parse(outputText) as { currentDate?: string };
          displayTime = parsed.currentDate || outputText;
        } catch {
          displayTime = outputText;
        }

        callbacks.onTranscriptUpdate?.({
          id: toolMsgId,
          role: "system",
          text: `Checked current time (${parsedTz}): ${displayTime}`,
          timestamp: new Date().toLocaleTimeString(),
          toolCall: {
            name: "get_current_time",
            query: parsedTz,
            resultSummary: displayTime,
            status: "done"
          }
        });

        if (channel.readyState === "open") {
          try {
            channel.send(
              JSON.stringify({
                type: "response.item.create",
                item: {
                  type: "function_call_output",
                  call_id: callId,
                  output: outputText
                }
              })
            );
          } catch (err) {
            console.warn("Failed to send time tool output:", err);
          }
        }
      } else if (name === "search_web") {
        let parsedQuery = "";
        try {
          const parsedArgs = JSON.parse(argsStr) as { query?: string };
          parsedQuery = parsedArgs.query || "";
        } catch {}

        const toolMsgId = `tool_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
        callbacks.onTranscriptUpdate?.({
          id: toolMsgId,
          role: "system",
          text: `Searching internet for: "${parsedQuery}"`,
          timestamp: new Date().toLocaleTimeString(),
          toolCall: {
            name: "search_web",
            query: parsedQuery,
            status: "running"
          }
        });

        let outputText = "";
        try {
          const searchResp = await api.liveSearch({ query: parsedQuery });
          outputText = formatWebSearchResultsForModel(searchResp.results, parsedQuery);
          callbacks.onTranscriptUpdate?.({
            id: toolMsgId,
            role: "system",
            text: `Found ${searchResp.results.length} internet search results for: "${parsedQuery}"`,
            timestamp: new Date().toLocaleTimeString(),
            toolCall: {
              name: "search_web",
              query: parsedQuery,
              resultSummary: `Found ${searchResp.results.length} results`,
              status: "done"
            }
          });
        } catch (err) {
          outputText = `Error searching web: ${err instanceof Error ? err.message : String(err)}`;
          callbacks.onTranscriptUpdate?.({
            id: toolMsgId,
            role: "system",
            text: `Failed to search internet: ${outputText}`,
            timestamp: new Date().toLocaleTimeString(),
            toolCall: {
              name: "search_web",
              query: parsedQuery,
              resultSummary: "Search error",
              status: "error"
            }
          });
        }

        if (channel.readyState === "open") {
          try {
            channel.send(
              JSON.stringify({
                type: "response.item.create",
                item: {
                  type: "function_call_output",
                  call_id: callId,
                  output: outputText
                }
              })
            );
          } catch (err) {
            console.warn("Failed to send search_web output:", err);
          }
        }
      } else if (name === "fetch_web_page") {
        let parsedUrl = "";
        try {
          const parsedArgs = JSON.parse(argsStr) as { url?: string };
          parsedUrl = parsedArgs.url || "";
        } catch {}

        const toolMsgId = `tool_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
        callbacks.onTranscriptUpdate?.({
          id: toolMsgId,
          role: "system",
          text: `Fetching website: ${parsedUrl}`,
          timestamp: new Date().toLocaleTimeString(),
          toolCall: {
            name: "fetch_web_page",
            query: parsedUrl,
            status: "running"
          }
        });

        let outputText = "";
        try {
          const fetchResp = await api.liveFetchUrl({ url: parsedUrl });
          outputText = formatWebPageForModel(fetchResp);
          callbacks.onTranscriptUpdate?.({
            id: toolMsgId,
            role: "system",
            text: `Read website: ${fetchResp.title || parsedUrl} (${fetchResp.text.length} chars)`,
            timestamp: new Date().toLocaleTimeString(),
            toolCall: {
              name: "fetch_web_page",
              query: parsedUrl,
              resultSummary: fetchResp.title || "Page fetched",
              status: "done"
            }
          });
        } catch (err) {
          outputText = `Error fetching website: ${err instanceof Error ? err.message : String(err)}`;
          callbacks.onTranscriptUpdate?.({
            id: toolMsgId,
            role: "system",
            text: `Failed to fetch website: ${outputText}`,
            timestamp: new Date().toLocaleTimeString(),
            toolCall: {
              name: "fetch_web_page",
              query: parsedUrl,
              resultSummary: "Fetch error",
              status: "error"
            }
          });
        }

        if (channel.readyState === "open") {
          try {
            channel.send(
              JSON.stringify({
                type: "response.item.create",
                item: {
                  type: "function_call_output",
                  call_id: callId,
                  output: outputText
                }
              })
            );
          } catch (err) {
            console.warn("Failed to send fetch_web_page output:", err);
          }
        }
      } else if (name === "recall_gemini_memory") {
        let parsedQuery = "";
        let parsedLimit = 3;
        try {
          const parsedArgs = JSON.parse(argsStr) as { query?: string; limit?: number };
          parsedQuery = parsedArgs.query || "";
          if (typeof parsedArgs.limit === "number") parsedLimit = parsedArgs.limit;
        } catch {}

        const toolMsgId = `tool_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
        callbacks.onTranscriptUpdate?.({
          id: toolMsgId,
          role: "system",
          text: `Recalling Gemini memory for: "${parsedQuery}"`,
          timestamp: new Date().toLocaleTimeString(),
          toolCall: {
            name: "recall_gemini_memory",
            query: parsedQuery,
            status: "running"
          }
        });

        let outputText = "";
        try {
          const cleanQuery = parsedQuery.trim().slice(0, 200);
          let memoryResp = await api.memory({
            ...(cleanQuery ? { q: cleanQuery } : {}),
            searchMode: "keyword"
          });
          if ((!memoryResp.data || memoryResp.data.length === 0) && cleanQuery.length > 15) {
            const keywords = cleanQuery
              .replace(/[^\w\s\u0370-\u03ff]/gi, " ")
              .split(/\s+/)
              .filter((w) => w.length > 3)
              .slice(0, 3)
              .join(" ")
              .slice(0, 200);
            if (keywords) {
              const fallbackResp = await api.memory({ q: keywords, searchMode: "keyword" });
              if (fallbackResp.data && fallbackResp.data.length > 0) {
                memoryResp = fallbackResp;
              }
            }
          }
          if (!memoryResp.data || memoryResp.data.length === 0) {
            const recentResp = await api.memory({ searchMode: "keyword" });
            if (recentResp.data && recentResp.data.length > 0) {
              memoryResp = { ...recentResp, data: recentResp.data.slice(0, parsedLimit) };
            }
          }
          outputText = formatMemoryForModel(memoryResp.data, cleanQuery, parsedLimit);
          const isPersonalQuery = /user|profile|name|preference|identity|who am i|ποιος|όνομα|προσωπικ|βιογραφικ/i.test(cleanQuery);
          if (isPersonalQuery) {
            outputText += `\n\n[CRITICAL NOTE FOR ASSISTANT: The user's name is permanently confirmed as Νικόλας in Personal Live Memory. The records above from Gemini Memory are strictly technical system/project documentation. You must ALWAYS address the user as Νικόλας and recall personal facts from Personal Live Memory, NEVER claiming that the user name is unconfirmed.]`;
          }
          callbacks.onTranscriptUpdate?.({
            id: toolMsgId,
            role: "system",
            text: `Recalled ${memoryResp.data.length} records from Gemini memory for: "${cleanQuery || "(recent)"}"`,
            timestamp: new Date().toLocaleTimeString(),
            toolCall: {
              name: "recall_gemini_memory",
              query: cleanQuery || "(recent)",
              resultSummary: `Found ${memoryResp.data.length} entries`,
              status: "done"
            }
          });
        } catch (err) {
          outputText = `Error querying Gemini memory: ${err instanceof Error ? err.message : String(err)}`;
          callbacks.onTranscriptUpdate?.({
            id: toolMsgId,
            role: "system",
            text: `Failed to recall Gemini memory: ${outputText}`,
            timestamp: new Date().toLocaleTimeString(),
            toolCall: {
              name: "recall_gemini_memory",
              query: parsedQuery,
              resultSummary: "Error querying memory",
              status: "error"
            }
          });
        }

        if (channel.readyState === "open") {
          const itemPayload = {
            type: "function_call_output",
            call_id: callId,
            output: outputText
          };
          try {
            channel.send(
              JSON.stringify({
                type: "response.item.create",
                item: itemPayload
              })
            );
          } catch (err) {
            console.warn("Failed to send function call output:", err);
          }
        }
      } else {
        if (channel.readyState === "open") {
          try {
            channel.send(
              JSON.stringify({
                type: "response.item.create",
                item: {
                  type: "function_call_output",
                  call_id: callId,
                  output: JSON.stringify({ error: `Tool ${name || "unknown"} not supported.` })
                }
              })
            );
          } catch (err) {
            console.warn("Failed to send unsupported tool output:", err);
          }
        }
      }
    } finally {
      pendingCallIds.delete(callId);
      const entry = pendingCallsByCallId.get(callId);
      if (entry?.id) {
        pendingFunctionItemIds.delete(entry.id);
      }
      maybeTriggerToolsResponse();
    }
  };

  channel.addEventListener("message", async (event) => {
    let rawMsg: Record<string, unknown>;
    try {
      rawMsg = JSON.parse(String(event.data ?? "{}"));
    } catch {
      return;
    }

    const isDelegatedEvent =
      rawMsg.type === "response.event" &&
      typeof rawMsg.event === "object" &&
      rawMsg.event !== null;

    const msg = isDelegatedEvent ? (rawMsg.event as Record<string, unknown>) : rawMsg;
    const type = typeof msg.type === "string" ? msg.type : "";

    callbacks.onLogEvent?.(isDelegatedEvent ? `delegated:${type}` : type || "message", rawMsg);

    switch (type) {
      case "session.started":
      case "session.created":
        callbacks.onStatusChange?.("active");
        if (effectiveOpening?.trim() && !openingInstructionsSent && channel.readyState === "open") {
          openingInstructionsSent = true;
          callbacks.onLogEvent?.("session.opening_instructions_append", { greeting: effectiveOpening });
          try {
            channel.send(
              createLiveInstructionsAppend(
                `Immediately say this greeting exactly once, then pause and listen: "${effectiveOpening.trim()}". Do not repeat it on later turns.`,
                "live_opening_greeting"
              )
            );
          } catch {}
        }
        break;

      case "session.instructions.appended":
        if (effectiveOpening?.trim() && !openingResponseRequested && channel.readyState === "open") {
          openingResponseRequested = true;
          callbacks.onLogEvent?.("session.opening_greeting_triggered", { greeting: effectiveOpening });
          try {
            channel.send(createLiveClientEvent("response.create"));
          } catch {}
        }
        break;

      case "session.input_audio.unmuted":
        callbacks.onLogEvent?.("session.input_audio.unmuted", { unmuted: true });
        break;

      case "session.input_audio.muted":
        callbacks.onLogEvent?.("session.input_audio.muted", { muted: true });
        break;

      case "input_audio_buffer.speech_started":
      case "session.input_audio.speech_started": {
        callbacks.onStatusChange?.("listening");
        assistantSpeaking = false;
        activeAssistantMsgId = null;
        hasDelegatedAssistantText = false;
        userTurnStartTime = Date.now();
        const rawItemId = typeof msg.item_id === "string" && msg.item_id ? msg.item_id : null;
        activeUserMsgId = rawItemId || `user_${userTurnStartTime}_${Math.random().toString(36).slice(2, 6)}`;
        if (rawItemId) {
          itemIdToTurnId.set(rawItemId, activeUserMsgId);
        }
        break;
      }

      case "input_audio_buffer.speech_stopped":
      case "session.input_audio.speech_stopped":
        callbacks.onStatusChange?.("active");
        break;

      case "conversation.item.created": {
        const item = msg.item as { id?: string; role?: string } | undefined;
        if (item?.id) {
          if (item.role === "user") {
            if (activeUserMsgId) {
              itemIdToTurnId.set(item.id, activeUserMsgId);
            } else {
              userTurnStartTime = Date.now();
              activeUserMsgId = item.id;
              itemIdToTurnId.set(item.id, item.id);
            }
          } else if (item.role === "assistant") {
            activeAssistantMsgId = item.id;
            assistantTurnStartTime = Date.now();
            activeUserMsgId = null;
          }
        }
        break;
      }

      case "response.created": {
        assistantSpeaking = true;
        callbacks.onStatusChange?.("speaking");
        activeUserMsgId = null;
        userTurnStartTime = 0;
        hasDelegatedAssistantText = false;
        assistantTurnStartTime = Date.now();
        const resp = msg.response as { id?: string } | undefined;
        if (resp && typeof resp.id === "string" && resp.id) {
          activeResponseIds.add(resp.id);
          activeAssistantMsgId = resp.id;
        } else {
          const tempId = `resp_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
          activeResponseIds.add(tempId);
          if (!activeAssistantMsgId) {
            activeAssistantMsgId = tempId;
          }
        }
        break;
      }

      case "response.output_item.added": {
        const item = msg.item as { id?: string; type?: string; name?: string; call_id?: string } | undefined;
        if (item?.id) {
          if (item.type === "function_call") {
            pendingFunctionItemIds.add(item.id);
            hasPendingToolOutputs = true;
            const callId = item.call_id || "";
            const entry = {
              id: item.id,
              name: item.name || "",
              callId,
              arguments: ""
            };
            pendingCallsByItemId.set(item.id, entry);
            if (callId) {
              pendingCallsByCallId.set(callId, entry);
              pendingCallIds.add(callId);
            }
          } else {
            assistantSpeaking = true;
            callbacks.onStatusChange?.("speaking");
            activeUserMsgId = null;
            userTurnStartTime = 0;
            activeAssistantMsgId = item.id;
            assistantTurnStartTime = Date.now();
          }
        }
        break;
      }

      case "response.audio.started":
      case "output_audio_buffer.started":
        assistantSpeaking = true;
        callbacks.onStatusChange?.("speaking");
        activeUserMsgId = null;
        break;

      case "response.audio.done":
      case "output_audio_buffer.stopped":
        callbacks.onStatusChange?.("active");
        break;

      case "session.input_transcript.delta":
      case "conversation.item.input_audio_transcription.delta": {
        const delta = typeof msg.delta === "string" ? msg.delta : "";
        if (delta) {
          const rawItemId = typeof msg.item_id === "string" && msg.item_id ? msg.item_id : null;
          const turnId =
            (rawItemId && itemIdToTurnId.get(rawItemId)) ||
            rawItemId ||
            activeUserMsgId ||
            (activeUserMsgId = `user_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`);
          if (rawItemId && !itemIdToTurnId.has(rawItemId)) {
            itemIdToTurnId.set(rawItemId, turnId);
          }
          const turnTime = userTurnStartTime || Date.now();
          callbacks.onTranscriptUpdate?.({
            id: turnId,
            role: "user",
            text: delta,
            isDelta: true,
            createdAtMs: turnTime,
            timestamp: new Date(turnTime).toLocaleTimeString()
          });
        }
        break;
      }

      case "session.input_transcript.done":
      case "conversation.item.input_audio_transcription.completed": {
        const text =
          typeof msg.transcript === "string" && msg.transcript.trim()
            ? msg.transcript.trim()
            : typeof msg.text === "string"
              ? msg.text.trim()
              : "";
        if (text) {
          const rawItemId = typeof msg.item_id === "string" && msg.item_id ? msg.item_id : null;
          const turnId =
            (rawItemId && itemIdToTurnId.get(rawItemId)) ||
            rawItemId ||
            activeUserMsgId ||
            `user_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
          const turnTime = userTurnStartTime || Date.now();
          callbacks.onTranscriptUpdate?.({
            id: turnId,
            role: "user",
            text,
            isDelta: false,
            createdAtMs: turnTime,
            timestamp: new Date(turnTime).toLocaleTimeString()
          });
          activeUserMsgId = null;
          userTurnStartTime = 0;
        }
        break;
      }

      case "response.output_text.delta": {
        const delta = typeof msg.delta === "string" ? msg.delta : "";
        if (delta) {
          hasDelegatedAssistantText = true;
          assistantSpeaking = true;
          callbacks.onStatusChange?.("speaking");
          const id =
            (typeof msg.item_id === "string" && msg.item_id) ||
            (typeof msg.response_id === "string" && msg.response_id) ||
            activeAssistantMsgId ||
            (activeAssistantMsgId = `assistant_${Date.now()}`);
          const turnTime = assistantTurnStartTime || Date.now();
          callbacks.onTranscriptUpdate?.({
            id,
            role: "assistant",
            text: delta,
            isDelta: true,
            createdAtMs: turnTime,
            timestamp: new Date(turnTime).toLocaleTimeString()
          });
        }
        break;
      }

      case "response.audio_transcript.delta":
      case "session.output_transcript.delta":
      case "response.text.delta": {
        if (hasDelegatedAssistantText) {
          break;
        }
        const delta = typeof msg.delta === "string" ? msg.delta : "";
        if (delta) {
          assistantSpeaking = true;
          callbacks.onStatusChange?.("speaking");
          const id =
            (typeof msg.item_id === "string" && msg.item_id) ||
            (typeof msg.response_id === "string" && msg.response_id) ||
            activeAssistantMsgId ||
            (activeAssistantMsgId = `assistant_${Date.now()}`);
          const turnTime = assistantTurnStartTime || Date.now();
          callbacks.onTranscriptUpdate?.({
            id,
            role: "assistant",
            text: delta,
            isDelta: true,
            createdAtMs: turnTime,
            timestamp: new Date(turnTime).toLocaleTimeString()
          });
        }
        break;
      }

      case "response.output_text.done": {
        const text =
          typeof msg.text === "string" && msg.text.trim()
            ? msg.text.trim()
            : typeof msg.transcript === "string"
              ? msg.transcript.trim()
              : "";
        if (text) {
          hasDelegatedAssistantText = true;
          const id =
            (typeof msg.item_id === "string" && msg.item_id) ||
            (typeof msg.response_id === "string" && msg.response_id) ||
            activeAssistantMsgId ||
            `assistant_${Date.now()}`;
          const turnTime = assistantTurnStartTime || Date.now();
          callbacks.onTranscriptUpdate?.({
            id,
            role: "assistant",
            text,
            isDelta: false,
            createdAtMs: turnTime,
            timestamp: new Date(turnTime).toLocaleTimeString()
          });
        }
        activeAssistantMsgId = null;
        break;
      }

      case "response.audio_transcript.done":
      case "session.output_transcript.done":
      case "response.text.done": {
        if (hasDelegatedAssistantText) {
          break;
        }
        const text =
          typeof msg.transcript === "string" && msg.transcript.trim()
            ? msg.transcript.trim()
            : typeof msg.text === "string"
              ? msg.text.trim()
              : "";
        if (text) {
          const id =
            (typeof msg.item_id === "string" && msg.item_id) ||
            (typeof msg.response_id === "string" && msg.response_id) ||
            activeAssistantMsgId ||
            `assistant_${Date.now()}`;
          const turnTime = assistantTurnStartTime || Date.now();
          callbacks.onTranscriptUpdate?.({
            id,
            role: "assistant",
            text,
            isDelta: false,
            createdAtMs: turnTime,
            timestamp: new Date(turnTime).toLocaleTimeString()
          });
        }
        activeAssistantMsgId = null;
        break;
      }

      case "response.output_item.done": {
        const item = msg.item as { id?: string; type?: string; name?: string; call_id?: string; arguments?: string } | undefined;
        if (item?.id) {
          pendingFunctionItemIds.delete(item.id);
        }
        if (item?.type === "function_call" && item.call_id) {
          const entry = pendingCallsByCallId.get(item.call_id) || (item.id ? pendingCallsByItemId.get(item.id) : undefined);
          const name = item.name || entry?.name || "";
          const argsStr = item.arguments || entry?.arguments || "{}";
          pendingCallIds.add(item.call_id);
          hasPendingToolOutputs = true;
          void executeFunctionCall(item.call_id, name, argsStr);
        } else {
          assistantSpeaking = false;
          callbacks.onStatusChange?.("active");
          activeAssistantMsgId = null;
          hasDelegatedAssistantText = false;
        }
        break;
      }

      case "response.completed":
      case "response.done": {
        assistantSpeaking = false;
        callbacks.onStatusChange?.("active");
        activeAssistantMsgId = null;
        hasDelegatedAssistantText = false;
        pendingFunctionItemIds.clear();

        const resp = msg.response as { id?: string; output?: Array<Record<string, unknown>> } | undefined;
        if (resp?.id) {
          activeResponseIds.delete(resp.id);
        } else {
          activeResponseIds.clear();
        }

        if (resp && Array.isArray(resp.output)) {
          for (const item of resp.output) {
            if (item && item.type === "function_call" && typeof item.call_id === "string" && item.call_id) {
              const callId = item.call_id;
              const name = (typeof item.name === "string" && item.name) || "";
              const argsStr = (typeof item.arguments === "string" && item.arguments) || "{}";
              if (!executedCallIds.has(callId)) {
                pendingCallIds.add(callId);
                hasPendingToolOutputs = true;
                void executeFunctionCall(callId, name, argsStr);
              }
            }
          }
        }

        maybeTriggerToolsResponse();
        break;
      }

      case "response.function_call_arguments.delta": {
        const itemId = typeof msg.item_id === "string" ? msg.item_id : "";
        const callId = typeof msg.call_id === "string" ? msg.call_id : "";
        const delta = typeof msg.delta === "string" ? msg.delta : "";
        const entry = (callId ? pendingCallsByCallId.get(callId) : undefined) || (itemId ? pendingCallsByItemId.get(itemId) : undefined);
        if (entry && delta) {
          entry.arguments += delta;
        }
        break;
      }

      case "response.function_call_arguments.done": {
        const callId = typeof msg.call_id === "string" ? msg.call_id : "";
        const entry = (callId ? pendingCallsByCallId.get(callId) : undefined) || (typeof msg.item_id === "string" ? pendingCallsByItemId.get(msg.item_id) : undefined);
        const itemId = typeof msg.item_id === "string" ? msg.item_id : (entry?.id || "");
        if (itemId) {
          pendingFunctionItemIds.delete(itemId);
        }
        const name = (typeof msg.name === "string" && msg.name) || entry?.name || "";
        const argsStr = (typeof msg.arguments === "string" && msg.arguments) || entry?.arguments || "{}";

        if (callId) {
          pendingCallIds.add(callId);
          hasPendingToolOutputs = true;
          void executeFunctionCall(callId, name, argsStr);
        }
        break;
      }

      case "error":
      case "session.error": {
        const errObj = (msg.error || rawMsg.error) as { message?: string } | undefined;
        fail(errObj?.message || "An error occurred during the live conversation session.");
        break;
      }

      default:
        break;
    }
  });

  try {
    try {
      const transceivers = connection.getTransceivers();
      for (const t of transceivers) {
        if (t.sender.track?.kind === "audio") {
          t.direction = "sendrecv";
        }
      }
    } catch {}

    const offer = await connection.createOffer();
    await connection.setLocalDescription(offer);


    if (connection.iceGatheringState && connection.iceGatheringState !== "complete") {
      await new Promise<void>((resolve) => {
        let settled = false;
        const done = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          connection.removeEventListener("icegatheringstatechange", onState);
          resolve();
        };
        const timer = setTimeout(done, 150);
        function onState() {
          if (connection.iceGatheringState === "complete") done();
        }
        connection.addEventListener("icegatheringstatechange", onState);
      });
    }

    if (!connection.localDescription?.sdp) {
      throw new Error("Could not create local WebRTC SDP offer.");
    }

    const tz = options.timeZone || "Asia/Bangkok";
    let formattedDate = "";
    try {
      formattedDate = new Intl.DateTimeFormat("en-US", {
        timeZone: tz,
        weekday: "long",
        year: "numeric",
        month: "long",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false
      }).format(new Date());
    } catch {
      formattedDate = new Date().toUTCString();
    }
    const tzLabel = tz === "Asia/Bangkok" ? "Thailand Time (ICT, UTC+7)" : tz;

    const effectiveMemories =
      options.personalMemories && options.personalMemories.length > 0
        ? options.personalMemories
        : [
            {
              id: "mem_user_name",
              key: "userName",
              value: userName,
              category: "profile" as const,
              createdAt: "2026-09-12T00:00:00.000Z",
              updatedAt: "2026-09-12T00:00:00.000Z"
            }
          ];
    const personalMemorySummary = formatPersonalMemoryForModel(effectiveMemories);

    const personalMemoryInstruction = `\nCRITICAL USER IDENTITY & PERSONAL LIVE MEMORY:
- The user you are conversing with is ${userName}.
- You ALWAYS know that the user's name is ${userName}. NEVER say that you do not know his name or that there is no confirmed name! You must ALWAYS address him warmly by his name (${userName}) in every conversation.
- When greeting or starting the conversation, greet with "${dynamicGreeting}" ONLY ONCE at the start of the session (on the very first turn). In ALL subsequent turns of the conversation, DO NOT repeat "Καλησπέρα" or "Καλημέρα" or any greeting. Respond directly to what the user said without re-greeting.
- His personal profile and preferences are stored in your Personal Live Memory Profile below:
${personalMemorySummary}
- When asked "τι ξέρεις για μένα", "διάβασε την προσωπική σου μνήμη", "ποιος είμαι", or about his profile, answer directly with warmth using his Personal Live Memory (name: ${userName} and any saved personal facts). You can also call search_personal_memory to search his personal memory.
- NEVER call recall_gemini_memory to search for the user's personal identity or name. recall_gemini_memory is ONLY for technical server/project documentation.
- You have permanent, fast Personal Live Memory. Whenever the user tells you to remember something, save their name, save facts, or remember preferences, you MUST immediately call save_personal_memory to persist it into Personal Live Memory.
- After saving to personal memory, confirm clearly and warmly in Greek to ${userName} that it is saved.`;

    const timeInstruction = `\nCurrent Date and Time: ${formattedDate} (${tzLabel}). You are always aware of the exact current time, day of the week, and date in Thailand (${tz}). You have access to get_current_time to check live time down to the second.`;
    const searchInstruction = `\nYou have access to search_web to search the internet for live facts, weather, and news, and fetch_web_page to inspect websites and domains (like ola.gr). Always search the web or fetch websites when the user asks for current web information or about a specific site.`;
    const memoryInstruction =
      options.enableGeminiMemory !== false
        ? "\nYou have access to the recall_gemini_memory tool ONLY for technical developer documentation, system configs, Proxmox VMs, deployment procedures, and technical project notes. NEVER use it for user personal identity or personal facts."
        : "";

    const combinedPrompt = `${options.prompt || ""}${personalMemoryInstruction}${timeInstruction}${searchInstruction}${memoryInstruction}`.trim();

    const tools: Array<Record<string, unknown>> = [
      SAVE_PERSONAL_MEMORY_TOOL,
      SEARCH_PERSONAL_MEMORY_TOOL,
      CURRENT_TIME_TOOL,
      SEARCH_WEB_TOOL,
      FETCH_WEB_PAGE_TOOL
    ];
    if (options.enableGeminiMemory !== false) {
      tools.push(GEMINI_MEMORY_TOOL);
    }

    const answer = await api.createVoiceRealtimeCall({
      offerSdp: connection.localDescription.sdp,
      model: (options.model as VoiceTranscriptionModel) || "gpt-live-1",
      language: options.language || "auto",
      delay: options.delay || "minimal",
      voice: options.voice || "gleam",
      opening: effectiveOpening?.trim() || undefined,
      prompt: combinedPrompt || undefined,
      delegatedModel: options.delegatedModel || "gpt-5.6-terra",
      delegatedType: options.delegatedType || "responses",
      delegatedReasoningEffort: options.delegatedReasoningEffort || "medium",
      delegatedWebSearch: options.delegatedWebSearch ?? true,
      delegatedPrompt: options.delegatedPrompt || undefined,
      tools
    });

    await connection.setRemoteDescription({ type: "answer", sdp: answer.answerSdp });
  } catch (err) {
    fail(err instanceof Error ? err.message : "Failed to establish WebRTC live call.");
    throw err;
  }

  const sendInput = async (parts: LiveInputPart[]) => {
    if (channel.readyState !== "open" || parts.length === 0) return;
    const content: Array<Record<string, unknown>> = [];
    for (const part of parts) {
      if (part.type === "text" && part.text.trim()) {
        content.push({ type: "input_text", text: part.text.trim() });
        continue;
      }
      if (part.type !== "image" && part.type !== "file") continue;
      try {
        const match = part.dataUrl.match(/^data:([^;,]+)?;base64,(.*)$/);
        if (!match) throw new Error("Attachment data is invalid.");
        const bytes = Uint8Array.from(atob(match[2] ?? ""), (char) => char.charCodeAt(0));
        const file = new File([bytes], part.filename || "attachment", {
          type: part.type === "file" ? part.mimeType : match[1] || "image/jpeg"
        });
        const result = await api.analyzeLiveAttachment({
          file,
          model: options.delegatedModel || "gpt-4o-mini",
          prompt: options.delegatedPrompt
        });
        if (result.text?.trim()) {
          content.push({ type: "input_text", text: `[${part.filename || "attachment"} analysis]\n${result.text.trim()}` });
        }
      } catch (err) {
        callbacks.onLogEvent?.("input.attachment_failed", { message: err instanceof Error ? err.message : String(err) });
        callbacks.onError?.(`Attachment analysis failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (content.length === 0 || channel.readyState !== "open") return;
    try {
      channel.send(JSON.stringify({ type: "response.item.create", item: { type: "message", role: "user", content } }));
      channel.send(createLiveClientEvent("response.create"));
    } catch (err) {
      callbacks.onLogEvent?.("input.send_failed", { message: err instanceof Error ? err.message : String(err) });
    }
  };

  return {
    close,
    setMuted: (val: boolean) => {
      muted = val;
      stream.getAudioTracks().forEach((track) => {
        track.enabled = !val;
      });
      if (channel.readyState === "open") {
        try {
          channel.send(JSON.stringify({ type: val ? "session.input_audio.mute" : "session.input_audio.unmute" }));
        } catch {}
      }
    },
    isMuted: () => muted,
    sendTextMessage: (text: string) => { void sendInput([{ type: "text", text }]); },
    sendInput
  };
}
