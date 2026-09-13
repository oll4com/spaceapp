import { api } from "./api.js";
import type { VoiceModelVoice, VoiceTranscriptionDelay, VoiceTranscriptionLanguage, VoiceTranscriptionModel } from "@space/contracts";
import { DEMO_LOCAL_REPLY, getSpaceRuntime } from "./runtime/SpaceRuntime.js";

export interface VoiceRealtimeSessionOptions {
  model: VoiceTranscriptionModel;
  language: VoiceTranscriptionLanguage;
  delay: VoiceTranscriptionDelay;
  voice?: VoiceModelVoice;
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
  commit: () => void;
  close: () => void;
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
  return typeof model === "string" && (model.startsWith("gpt-live-") || model === "gpt-transcribe");
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

  // Some browsers expose only packet/byte counters for outbound audio. Keep
  // the live track open for a conservative window before committing there.
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

export async function openVoiceRealtimeSession(
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

  const stream = await runtime.platform.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true
    }
  });

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
      } catch {
        // Safe ignore on close
      }
    }
    try {
      channel.close();
    } catch {
      // Safe ignore
    }
    connection.getSenders().forEach((sender) => sender.track?.stop());
    stream.getTracks().forEach((track) => {
      if (track.readyState === "live") track.stop();
    });
    try {
      connection.close();
    } catch {
      // Safe ignore
    }
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
    switch (typed.type) {
      case "session.input_transcript.delta":
      case "session.output_transcript.delta":
      case "response.audio_transcript.delta":
      case "conversation.item.input_audio_transcription.delta":
        if (typeof typed.delta === "string" && typed.delta) {
          transcript += typed.delta;
          callbacks.onTranscriptDelta?.(transcript);
        }
        break;
      case "session.input_transcript.done":
      case "session.output_transcript.done":
      case "response.audio_transcript.done":
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
    const answer = await api.createVoiceRealtimeCall({
      offerSdp: cleanOfferSdp,
      model: options.model,
      language: options.language,
      delay: options.delay,
      voice: options.voice,
      opening: options.opening,
      prompt: options.prompt,
      delegatedModel: options.delegatedModel,
      delegatedType: options.delegatedType,
      delegatedReasoningEffort: options.delegatedReasoningEffort,
      delegatedWebSearch: options.delegatedWebSearch,
      delegatedPrompt: options.delegatedPrompt
    });
    await connection.setRemoteDescription({ type: "answer", sdp: answer.answerSdp });
    await waitForDataChannelOpen(channel, 15000);
    readyAtMs = Date.now();
    initialAudioProgress = await readOutboundAudioProgress(audioSenders);
  } catch (error) {
    close();
    throw new Error(errorMessage(error, "Voice Realtime session failed to start."));
  }

  return {
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
          fail("No microphone audio was captured. Hold the microphone button briefly and try again.");
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
        if (isLiveTranscriptionModel(options.model)) {
          clearFallbackDoneTimer();
          fallbackDoneTimer = setTimeout(() => {
            if (!closed) {
              if (transcript.trim()) {
                void callbacks.onTranscriptComplete?.(transcript.trim());
                close();
              } else {
                fail("No speech was recognized. Hold the microphone button briefly and try again.");
              }
            }
          }, 2500);
        }
      })();
    },
    close
  };
}
