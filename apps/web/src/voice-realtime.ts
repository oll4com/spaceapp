import { api } from "./api.js";
import {
  inferProviderFromModel,
  type LiveAudioProviderId,
  type VoiceModelVoice,
  type VoiceTranscriptionDelay,
  type VoiceTranscriptionLanguage,
  type VoiceTranscriptionModel
} from "@space/contracts";
import { DEMO_LOCAL_REPLY, getSpaceRuntime } from "./runtime/SpaceRuntime.js";
import { noteVoiceRelayClose, voiceRelayCloseExplanation } from "./voice-relay-close.js";
import {
  createAudioContextWithFallback,
  downsampleBuffer,
  pcm16FromFloat32,
  arrayBufferToBase64,
  mergeTranscriptText
} from "./audio-pcm.js";

export interface VoiceRealtimeSessionOptions {
  provider?: LiveAudioProviderId;
  model: VoiceTranscriptionModel | string;
  language: VoiceTranscriptionLanguage;
  delay: VoiceTranscriptionDelay;
  voice?: VoiceModelVoice | string;
  opening?: string;
  prompt?: string;
  delegatedModel?: string;
  delegatedType?: "responses" | "client";
  delegatedReasoningEffort?: "minimal" | "low" | "medium" | "high" | "xhigh";
  delegatedWebSearch?: boolean;
  delegatedPrompt?: string;
}

export interface VoiceRealtimeSessionCallbacks {
  onTranscriptDelta?: (text: string) => void;
  onTranscriptComplete?: (text: string) => void | Promise<void>;
  onError?: (message: string) => void;
}

export interface VoiceRealtimeSessionHandle {
  // Opens the microphone for a session opened with deferCapture; a no-op otherwise.
  startCapture: () => Promise<void>;
  commit: () => void;
  close: () => void;
}

export interface VoiceRealtimeOpenOptions {
  // Connect without touching the microphone so a pre-warmed session sends no audio until startCapture.
  deferCapture?: boolean;
}

const MICROPHONE_CONSTRAINTS: MediaStreamConstraints = {
  audio: {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true
  }
};

const MIXED_LANGUAGE_TERMS_INSTRUCTION =
  "Keep English technical terms, commands, product names and code identifiers in Latin script exactly as spoken " +
  "(for example deploy, worktree, pane, commit, Codex, OpenCode); do not transliterate them into Greek.";

// Gemini Live: bias input transcription to Greek and English, as the Live pane does.
function googleInputTranscriptionConfig(language: VoiceTranscriptionLanguage): { languageCodes: string[] } {
  if (language === "el") return { languageCodes: ["el-GR", "el"] };
  if (language === "en") return { languageCodes: ["en-US", "en"] };
  return { languageCodes: ["el-GR", "el", "en-US", "en"] };
}

const MIN_INPUT_AUDIO_SAMPLES = 4_800;
const MIN_INPUT_AUDIO_DURATION_SECONDS = 0.12;
const FALLBACK_MIN_READY_MS = 240;
const COMMIT_WAIT_TIMEOUT_MS = 2_000;
const AUDIO_PROGRESS_POLL_MS = 25;

interface OutboundAudioProgress {
  samplesSent: number | null;
  sourceDurationSeconds: number | null;
  packetsSent: number;
  bytesSent: number;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function parseRealtimeEvent(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

function isRecordingAudioTrack(track: MediaStreamTrack): boolean {
  return track.kind === "audio" && track.readyState === "live";
}

export function isLiveConversationModel(model?: string): boolean {
  return typeof model === "string" && model.startsWith("gpt-live-") && model !== "gpt-live-transcribe";
}

export function isLiveTranscriptionModel(model?: string): boolean {
  return isLiveConversationModel(model);
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function addOptionalTotal(total: number | null, value: unknown): number | null {
  const next = finiteNumber(value);
  if (next === null) return total;
  return (total ?? 0) + next;
}

async function readOutboundAudioProgress(senders: RTCRtpSender[]): Promise<OutboundAudioProgress | null> {
  const reports = await Promise.all(senders.map(async (sender) => {
    try {
      return await sender.getStats();
    } catch {
      return null;
    }
  }));

  let foundReport = false;
  let samplesSent: number | null = null;
  let sourceDurationSeconds: number | null = null;
  let packetsSent = 0;
  let bytesSent = 0;

  for (const report of reports) {
    if (!report) continue;
    foundReport = true;
    report.forEach((raw) => {
      const stat = raw as RTCStats & {
        kind?: unknown;
        mediaType?: unknown;
        totalSamplesSent?: unknown;
        totalSamplesDuration?: unknown;
        packetsSent?: unknown;
        bytesSent?: unknown;
      };
      const mediaKind = stat.kind ?? stat.mediaType;
      if (mediaKind !== undefined && mediaKind !== "audio") return;
      if (stat.type === "outbound-rtp") {
        samplesSent = addOptionalTotal(samplesSent, stat.totalSamplesSent);
        packetsSent += finiteNumber(stat.packetsSent) ?? 0;
        bytesSent += finiteNumber(stat.bytesSent) ?? 0;
      } else if (stat.type === "media-source") {
        sourceDurationSeconds = addOptionalTotal(sourceDurationSeconds, stat.totalSamplesDuration);
      }
    });
  }

  return foundReport ? { samplesSent, sourceDurationSeconds, packetsSent, bytesSent } : null;
}

function hasMinimumOutboundAudio(
  baseline: OutboundAudioProgress,
  current: OutboundAudioProgress,
  readyElapsedMs: number
): boolean {
  if (baseline.samplesSent !== null && current.samplesSent !== null
    && current.samplesSent - baseline.samplesSent >= MIN_INPUT_AUDIO_SAMPLES) {
    return true;
  }

  const packetsAdvanced = current.packetsSent > baseline.packetsSent;
  const bytesAdvanced = current.bytesSent > baseline.bytesSent;
  if (!packetsAdvanced || !bytesAdvanced) return false;

  if (baseline.sourceDurationSeconds !== null && current.sourceDurationSeconds !== null
    && current.sourceDurationSeconds - baseline.sourceDurationSeconds >= MIN_INPUT_AUDIO_DURATION_SECONDS) {
    return true;
  }

  return readyElapsedMs >= FALLBACK_MIN_READY_MS;
}

async function waitForMinimumOutboundAudio(
  senders: RTCRtpSender[],
  initialBaseline: OutboundAudioProgress | null,
  readyAtMs: number,
  shouldContinue: () => boolean
): Promise<"ready" | "closed" | "timeout"> {
  let baseline = initialBaseline;
  const deadlineMs = Date.now() + COMMIT_WAIT_TIMEOUT_MS;

  while (shouldContinue()) {
    const current = await readOutboundAudioProgress(senders);
    if (!shouldContinue()) return "closed";
    if (current) {
      baseline ??= current;
      if (hasMinimumOutboundAudio(baseline, current, Date.now() - readyAtMs)) return "ready";
    }
    if (Date.now() >= deadlineMs) return "timeout";
    await new Promise<void>((resolve) => window.setTimeout(resolve, AUDIO_PROGRESS_POLL_MS));
  }

  return "closed";
}

async function waitForDataChannelOpen(channel: RTCDataChannel, timeoutMs: number): Promise<void> {
  if (channel.readyState === "open") return;
  await new Promise<void>((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error("Voice Realtime session timed out opening.")), timeoutMs);
    const handleOpen = () => {
      cleanup();
      resolve();
    };
    const handleError = () => {
      cleanup();
      reject(new Error("Voice Realtime data channel failed to open."));
    };
    const cleanup = () => {
      window.clearTimeout(timer);
      channel.removeEventListener("open", handleOpen);
      channel.removeEventListener("error", handleError);
    };
    channel.addEventListener("open", handleOpen, { once: true });
    channel.addEventListener("error", handleError, { once: true });
  });
}

/** Google Gemini Live voice transcription session via WebSocket proxy */
async function openGoogleVoiceSession(
  options: VoiceRealtimeSessionOptions,
  callbacks: VoiceRealtimeSessionCallbacks,
  openOptions: VoiceRealtimeOpenOptions = {}
): Promise<VoiceRealtimeSessionHandle> {
  const runtime = getSpaceRuntime();
  if (runtime.kind === "demo") {
    throw new Error(DEMO_LOCAL_REPLY);
  }
  if (!runtime.platform.userMediaSupported) {
    throw new Error("Microphone capture is not available in this browser.");
  }

  let closed = false;
  let committed = false;
  let setupComplete = false;
  // Only the user's own speech (inputTranscription) is ever a transcript; model replies are ignored.
  let transcript = "";
  let socket: WebSocket | null = null;
  let capture: {
    stream: MediaStream;
    audioContext: AudioContext;
    source: MediaStreamAudioSourceNode;
    processor: ScriptProcessorNode;
    silentGain: GainNode;
  } | null = null;

  const stopCapture = () => {
    if (!capture) return;
    const { stream, audioContext, source, processor, silentGain } = capture;
    capture = null;
    try {
      processor.disconnect();
      source.disconnect();
      silentGain.disconnect();
      void audioContext.close();
    } catch {}
    stream.getTracks().forEach((track) => {
      if (track.readyState === "live") track.stop();
    });
  };

  const close = () => {
    if (closed) return;
    closed = true;
    try {
      if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
        socket.close();
      }
    } catch {}
    stopCapture();
  };

  const fail = (message: string) => {
    if (closed) return;
    callbacks.onError?.(message);
    close();
  };

  const startCapture = async () => {
    if (capture || committed) return;
    if (closed) throw new Error("Google Gemini Live voice connection closed before recording started.");
    const stream = await runtime.platform.getUserMedia(MICROPHONE_CONSTRAINTS);
    if (closed || committed) {
      stream.getTracks().forEach((track) => track.stop());
      if (closed) throw new Error("Google Gemini Live voice connection closed before recording started.");
      return;
    }
    transcript = "";
    const audioContext = createAudioContextWithFallback();
    if (audioContext.state === "suspended") {
      void audioContext.resume();
    }
    const source = audioContext.createMediaStreamSource(stream);
    const processor = audioContext.createScriptProcessor(4096, 1, 1);
    const silentGain = audioContext.createGain();
    silentGain.gain.value = 0;
    source.connect(processor);
    processor.connect(silentGain);
    silentGain.connect(audioContext.destination);
    processor.onaudioprocess = (e) => {
      if (closed || !setupComplete || !socket || socket.readyState !== WebSocket.OPEN) return;
      const inputData = e.inputBuffer.getChannelData(0);
      const resampled = downsampleBuffer(inputData, audioContext.sampleRate, 16000);
      const pcm16 = pcm16FromFloat32(resampled);
      const base64Audio = arrayBufferToBase64(pcm16);

      try {
        socket.send(
          JSON.stringify({
            realtimeInput: {
              audio: {
                mimeType: "audio/pcm;rate=16000",
                data: base64Audio
              }
            }
          })
        );
      } catch {}
    };
    capture = { stream, audioContext, source, processor, silentGain };
  };

  // A direct start asks for the microphone first, so a denied permission fails before any provider call.
  if (!openOptions.deferCapture) await startCapture();

  let session: Awaited<ReturnType<typeof api.createVoiceRealtimeCall>>;
  try {
    session = await api.createVoiceRealtimeCall({
      provider: "google",
      model: options.model || "gemini-3.8-live",
      language: options.language,
      voice: (options.voice as VoiceModelVoice) || "Aoede",
      opening: options.opening,
      prompt: options.prompt
    });
  } catch (error) {
    close();
    throw error;
  }

  const rawWsUrl = session.websocketUrl;
  if (!rawWsUrl) {
    close();
    throw new Error("Google Gemini Live did not return a valid WebSocket proxy URL.");
  }
  const wsUrl = rawWsUrl.startsWith("/")
    ? `${window.location.protocol === "https:" ? "wss:" : "ws:"}//${window.location.host}${rawWsUrl}`
    : rawWsUrl;

  const openSocket = new WebSocket(wsUrl);
  socket = openSocket;

  openSocket.onopen = () => {
    if (capture?.audioContext.state === "suspended") {
      void capture.audioContext.resume();
    }
    const baseSystemPrompt =
      options.language === "el"
        ? "You are a real-time speech-to-text transcriber. Transcribe the user's spoken Greek accurately, concisely, and verbatim. Do not converse or output conversational filler."
        : options.language === "en"
          ? "You are a real-time speech-to-text transcriber. Transcribe the user's spoken English accurately, concisely, and verbatim. Do not converse or output conversational filler."
          : "You are a real-time speech-to-text transcriber. Accurately transcribe the user's speech verbatim in the language spoken (Greek or English). Do not converse or output conversational filler.";
    // Greek dictation for coding agents mixes in English terms; keep them as the agent expects to read them.
    const systemPrompt = options.language === "en"
      ? baseSystemPrompt
      : `${baseSystemPrompt} ${MIXED_LANGUAGE_TERMS_INSTRUCTION}`;

    openSocket.send(
      JSON.stringify({
        setup: {
          model: `models/${options.model || "gemini-3.8-live"}`,
          generationConfig: {
            responseModalities: ["AUDIO"]
          },
          systemInstruction: {
            parts: [{ text: systemPrompt }]
          },
          inputAudioTranscription: googleInputTranscriptionConfig(options.language)
        }
      })
    );
  };

  openSocket.onmessage = (event) => {
    if (closed) return;
    try {
      const raw = typeof event.data === "string" ? event.data : new TextDecoder().decode(event.data);
      const data = JSON.parse(raw) as {
        setupComplete?: Record<string, unknown>;
        serverContent?: {
          inputTranscription?: { text?: string };
        };
      };
      if (data.setupComplete) {
        setupComplete = true;
      }
      // Speech heard before capture started cannot belong to this recording.
      const heard = data.serverContent?.inputTranscription?.text;
      if (heard && capture) {
        transcript = mergeTranscriptText(transcript, heard);
        callbacks.onTranscriptDelta?.(transcript);
      }
    } catch {}
  };

  openSocket.onerror = () => {
    fail("Google Gemini Live voice connection failed.");
  };

  openSocket.onclose = (event) => {
    noteVoiceRelayClose("google", event.reason);
    if (!closed && !committed) {
      fail(voiceRelayCloseExplanation(event.reason, "Google Gemini Live") ?? "Google Gemini Live voice connection closed unexpectedly.");
    }
  };

  return {
    startCapture,
    commit: () => {
      if (closed || committed) return;
      committed = true;
      // Keep listening for the transcription of audio already sent, but capture nothing more.
      if (capture) {
        try {
          capture.processor.disconnect();
          capture.source.disconnect();
        } catch {}
        capture.stream.getTracks().forEach((track) => track.stop());
      }

      window.setTimeout(() => {
        const finalTranscript = transcript.trim();
        close();
        if (finalTranscript) {
          void callbacks.onTranscriptComplete?.(finalTranscript);
        } else {
          callbacks.onError?.("No speech was recognized. Start the microphone, speak, then stop it.");
        }
      }, 500);
    },
    close
  };
}

/** Local PC Qwen3 Greek voice transcription session */
async function openLocalVoiceSession(
  options: VoiceRealtimeSessionOptions,
  callbacks: VoiceRealtimeSessionCallbacks,
  openOptions: VoiceRealtimeOpenOptions = {}
): Promise<VoiceRealtimeSessionHandle> {
  const runtime = getSpaceRuntime();
  if (!runtime.platform.userMediaSupported) throw new Error("Microphone capture is not available.");

  let closed = false;
  let committed = false;
  let startSent = false;
  let transcript = "";
  let socket: WebSocket | null = null;
  let capture: {
    stream: MediaStream;
    audioContext: AudioContext;
    source: MediaStreamAudioSourceNode;
    processor: ScriptProcessorNode;
  } | null = null;

  const stopCapture = () => {
    if (!capture) return;
    const { stream, audioContext, source, processor } = capture;
    capture = null;
    try {
      processor.disconnect();
      source.disconnect();
      void audioContext.close();
    } catch {}
    stream.getTracks().forEach((t) => t.stop());
  };

  const close = () => {
    if (closed) return;
    closed = true;
    try {
      socket?.close();
    } catch {}
    stopCapture();
  };

  // The provider starts recognizing on "start", so it is sent only once the microphone is open.
  const sendStart = () => {
    if (startSent || !capture || !socket || socket.readyState !== WebSocket.OPEN) return;
    startSent = true;
    socket.send(JSON.stringify({ type: "start", sample_rate: 16000, language: options.language ?? "auto" }));
  };

  const startCapture = async () => {
    if (capture || committed) return;
    if (closed) throw new Error("Local voice provider connection closed before recording started.");
    const stream = await runtime.platform.getUserMedia(MICROPHONE_CONSTRAINTS);
    if (closed || committed) {
      stream.getTracks().forEach((t) => t.stop());
      if (closed) throw new Error("Local voice provider connection closed before recording started.");
      return;
    }
    transcript = "";
    const audioContext = createAudioContextWithFallback(16000);
    const source = audioContext.createMediaStreamSource(stream);
    const processor = audioContext.createScriptProcessor(4096, 1, 1);
    const silentGain = audioContext.createGain();
    silentGain.gain.value = 0;
    source.connect(processor);
    processor.connect(silentGain);
    silentGain.connect(audioContext.destination);
    processor.onaudioprocess = (e) => {
      if (closed || !startSent || !socket || socket.readyState !== WebSocket.OPEN) return;
      const inputData = e.inputBuffer.getChannelData(0);
      const pcm16 = pcm16FromFloat32(inputData);
      try {
        socket.send(pcm16);
      } catch {}
    };
    capture = { stream, audioContext, source, processor };
    sendStart();
  };

  if (!openOptions.deferCapture) await startCapture();

  let session: Awaited<ReturnType<typeof api.createLocalVoiceSession>>;
  try {
    session = await api.createLocalVoiceSession({
      paneId: "voice-input",
      language: options.language === "en" ? "en-US" : "el-GR",
      opening: options.opening,
      prompt: options.prompt
    });
  } catch (error) {
    close();
    throw error;
  }
  const wsUrl =
    typeof session.websocket_url === "string"
      ? session.websocket_url
      : typeof session.ws_url === "string"
        ? session.ws_url
        : typeof session.url === "string"
          ? session.url
          : "";
  if (!wsUrl) {
    close();
    throw new Error("Local voice provider did not return a WebSocket session URL.");
  }
  const openSocket = new WebSocket(wsUrl, typeof session.token === "string" ? [session.token] : undefined);
  openSocket.binaryType = "arraybuffer";
  socket = openSocket;

  openSocket.onopen = sendStart;

  openSocket.onmessage = (event) => {
    if (closed) return;
    try {
      const msg = JSON.parse(String(event.data)) as { type?: string; text?: string };
      if (msg.type === "user_transcript" && typeof msg.text === "string" && capture) {
        transcript = msg.text;
        callbacks.onTranscriptDelta?.(transcript);
      }
    } catch {}
  };

  openSocket.onerror = () => {
    if (!closed) {
      callbacks.onError?.("Local voice provider connection failed.");
      close();
    }
  };

  openSocket.onclose = () => {
    if (!closed && !committed) {
      callbacks.onError?.("Local voice provider connection closed unexpectedly.");
      close();
    }
  };

  return {
    startCapture,
    commit: () => {
      if (closed || committed) return;
      committed = true;
      if (capture) {
        try {
          capture.processor.disconnect();
        } catch {}
        capture.stream.getTracks().forEach((t) => t.stop());
      }
      window.setTimeout(() => {
        close();
        if (transcript.trim()) {
          void callbacks.onTranscriptComplete?.(transcript.trim());
        } else {
          callbacks.onError?.("No speech was recognized. Start the microphone, speak, then stop it.");
        }
      }, 400);
    },
    close
  };
}

/** OpenAI Realtime WebRTC voice transcription session */
async function openOpenAiVoiceSession(
  options: VoiceRealtimeSessionOptions,
  callbacks: VoiceRealtimeSessionCallbacks = {}
): Promise<VoiceRealtimeSessionHandle> {
  const runtime = getSpaceRuntime();
  if (runtime.kind === "demo") {
    throw new Error(DEMO_LOCAL_REPLY);
  }
  if (!runtime.platform.userMediaSupported) {
    throw new Error("Microphone capture is not available in this browser.");
  }
  if (!runtime.platform.peerConnectionSupported) {
    throw new Error("Realtime voice input is not available in this browser.");
  }

  const stream = await runtime.platform.getUserMedia(MICROPHONE_CONSTRAINTS);

  let closed = false;
  let committed = false;
  let transcript = "";
  const connection = runtime.platform.createPeerConnection();
  const channel = connection.createDataChannel("oai-events");
  const audioSenders: RTCRtpSender[] = [];

  let fallbackDoneTimer: ReturnType<typeof setTimeout> | null = null;

  const clearFallbackDoneTimer = () => {
    if (fallbackDoneTimer !== null) {
      clearTimeout(fallbackDoneTimer);
      fallbackDoneTimer = null;
    }
  };

  const close = () => {
    if (closed) return;
    closed = true;
    clearFallbackDoneTimer();
    if (isLiveTranscriptionModel(options.model) && channel.readyState === "open") {
      try {
        channel.send(JSON.stringify({ type: "session.close" }));
      } catch {}
    }
    try {
      channel.close();
    } catch {}
    connection.getSenders().forEach((sender) => sender.track?.stop());
    stream.getTracks().forEach((track) => {
      if (track.readyState === "live") track.stop();
    });
    try {
      connection.close();
    } catch {}
  };

  const fail = (message: string) => {
    if (closed) return;
    callbacks.onError?.(message);
    close();
  };

  channel.addEventListener("message", (event) => {
    const message = parseRealtimeEvent(String(event.data ?? ""));
    if (!message || typeof message !== "object") return;
    const typed = message as {
      type?: string;
      delta?: unknown;
      transcript?: unknown;
      error?: { message?: unknown };
    };
    // Dictation: only what the operator said. The model's own reply (output transcript) is never part of it.
    switch (typed.type) {
      case "session.input_transcript.delta":
      case "conversation.item.input_audio_transcription.delta":
        if (typeof typed.delta === "string" && typed.delta) {
          transcript += typed.delta;
          callbacks.onTranscriptDelta?.(transcript);
        }
        break;
      case "session.input_transcript.done":
      case "conversation.item.input_audio_transcription.completed": {
        clearFallbackDoneTimer();
        const payloadText =
          typeof typed.transcript === "string" && typed.transcript.trim()
            ? typed.transcript
            : typeof (typed as { text?: unknown }).text === "string" && String((typed as { text?: unknown }).text).trim()
              ? String((typed as { text?: unknown }).text)
              : transcript;
        const finalTranscript = payloadText.trim();
        void callbacks.onTranscriptComplete?.(finalTranscript);
        close();
        break;
      }
      case "session.error":
      case "conversation.item.input_audio_transcription.failed":
        fail(typeof typed.error?.message === "string" ? typed.error.message : "Voice transcription failed.");
        break;
      case "error":
        fail(typeof typed.error?.message === "string" ? typed.error.message : "Voice transcription failed.");
        break;
      default:
        break;
    }
  });

  channel.addEventListener("error", () => {
    fail("Voice Realtime connection failed.");
  });

  channel.addEventListener("close", () => {
    fail("Voice Realtime connection closed unexpectedly.");
  });

  connection.addEventListener("connectionstatechange", () => {
    if (closed) return;
    if (connection.connectionState === "failed" || connection.connectionState === "disconnected" || connection.connectionState === "closed") {
      fail("Voice Realtime connection closed unexpectedly.");
    }
  });

  for (const track of stream.getTracks().filter(isRecordingAudioTrack)) {
    audioSenders.push(connection.addTrack(track, stream));
  }

  let readyAtMs = 0;
  let initialAudioProgress: OutboundAudioProgress | null = null;
  try {
    const offer = await connection.createOffer();
    await connection.setLocalDescription(offer);
    const offerSdp = offer.sdp || connection.localDescription?.sdp;
    if (!offerSdp) {
      throw new Error("Voice Realtime call did not produce a local SDP offer.");
    }
    const cleanOfferSdp = offerSdp
      .split(/\r?\n/)
      .filter((line) => !line.startsWith("a=candidate:"))
      .join("\r\n");
    // Dictation only: without the Live pane's opening, prompt and delegation the server asks the model to
    // transcribe, not to converse (a conversing gpt-live session also bills spoken replies).
    const answer = await api.createVoiceRealtimeCall({
      provider: "openai",
      offerSdp: cleanOfferSdp,
      model: options.model,
      language: options.language,
      delay: options.delay,
      voice: options.voice as VoiceModelVoice
    });
    if (!answer.answerSdp) {
      throw new Error("OpenAI Live session did not return an SDP answer.");
    }
    await connection.setRemoteDescription({ type: "answer", sdp: answer.answerSdp });
    await waitForDataChannelOpen(channel, 15000);
    readyAtMs = Date.now();
    initialAudioProgress = await readOutboundAudioProgress(audioSenders);
  } catch (error) {
    close();
    throw new Error(errorMessage(error, "Voice Realtime session failed to start."));
  }

  return {
    startCapture: async () => {},
    commit: () => {
      if (closed || committed || channel.readyState !== "open") return;
      committed = true;
      void (async () => {
        const readiness = await waitForMinimumOutboundAudio(
          audioSenders,
          initialAudioProgress,
          readyAtMs,
          () => !closed && channel.readyState === "open"
        );
        if (readiness === "closed" || closed) return;
        if (readiness === "timeout") {
          fail("No microphone audio was captured. Check the microphone and try again.");
          return;
        }
        try {
          if (isLiveTranscriptionModel(options.model)) {
            channel.send(JSON.stringify({ type: "session.input_audio.mute" }));
          } else {
            channel.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
          }
        } catch (error) {
          fail(errorMessage(error, "Voice Realtime audio could not be submitted."));
          return;
        }
        stream.getTracks().forEach((track) => {
          if (track.readyState === "live") track.stop();
        });

        clearFallbackDoneTimer();
        fallbackDoneTimer = setTimeout(() => {
          if (!closed) {
            if (transcript.trim()) {
              void callbacks.onTranscriptComplete?.(transcript.trim());
              close();
            } else {
              fail("No speech was recognized. Start the microphone, speak, then stop it.");
            }
          }
        }, 2500);
      })();
    },
    close
  };
}

// OpenAI sends the microphone track inside its WebRTC offer, so it cannot connect before recording.
export function supportsDeferredVoiceCapture(options: Pick<VoiceRealtimeSessionOptions, "provider" | "model">): boolean {
  const provider = options.provider || inferProviderFromModel(options.model);
  return provider === "google" || provider === "local";
}

/** Open a multi-provider Voice Realtime session supporting Google Gemini Live, Local PC, and OpenAI */
export async function openVoiceRealtimeSession(
  options: VoiceRealtimeSessionOptions,
  callbacks: VoiceRealtimeSessionCallbacks = {},
  openOptions: VoiceRealtimeOpenOptions = {}
): Promise<VoiceRealtimeSessionHandle> {
  const provider = options.provider || inferProviderFromModel(options.model);
  if (openOptions.deferCapture && !supportsDeferredVoiceCapture(options)) {
    throw new Error("This voice provider cannot connect before recording starts.");
  }
  if (provider === "google") {
    return openGoogleVoiceSession(options, callbacks, openOptions);
  }
  if (provider === "local") {
    return openLocalVoiceSession(options, callbacks, openOptions);
  }
  return openOpenAiVoiceSession(options, callbacks);
}
