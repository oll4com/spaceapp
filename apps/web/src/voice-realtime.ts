import { api } from "./api.js";
import type { VoiceTranscriptionDelay, VoiceTranscriptionLanguage, VoiceTranscriptionModel } from "@space/contracts";
import { DEMO_LOCAL_REPLY, getSpaceRuntime } from "./runtime/SpaceRuntime.js";

export interface VoiceRealtimeSessionOptions {
  model: VoiceTranscriptionModel;
  language: VoiceTranscriptionLanguage;
  delay: VoiceTranscriptionDelay;
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

  const close = () => {
    if (closed) return;
    closed = true;
    channel.close();
    connection.getSenders().forEach((sender) => sender.track?.stop());
    stream.getTracks().forEach((track) => {
      if (track.readyState === "live") track.stop();
    });
    connection.close();
  };

  const fail = (message: string) => {
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
      case "conversation.item.input_audio_transcription.delta":
        if (typeof typed.delta === "string" && typed.delta) {
          transcript += typed.delta;
          callbacks.onTranscriptDelta?.(transcript);
        }
        break;
      case "conversation.item.input_audio_transcription.completed": {
        const finalTranscript = typeof typed.transcript === "string" && typed.transcript.trim() ? typed.transcript : transcript;
        void callbacks.onTranscriptComplete?.(finalTranscript.trim());
        close();
        break;
      }
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

  connection.addEventListener("connectionstatechange", () => {
    if (closed) return;
    if (connection.connectionState === "failed" || connection.connectionState === "disconnected" || connection.connectionState === "closed") {
      fail("Voice Realtime connection closed unexpectedly.");
    }
  });

  for (const track of stream.getTracks().filter(isRecordingAudioTrack)) {
    connection.addTrack(track, stream);
  }

  try {
    const offer = await connection.createOffer();
    await connection.setLocalDescription(offer);
    if (!connection.localDescription?.sdp) {
      throw new Error("Voice Realtime call did not produce a local SDP offer.");
    }
    const answer = await api.createVoiceRealtimeCall({
      offerSdp: connection.localDescription.sdp,
      model: options.model,
      language: options.language,
      delay: options.delay
    });
    await connection.setRemoteDescription({ type: "answer", sdp: answer.answerSdp });
    await waitForDataChannelOpen(channel, 15000);
  } catch (error) {
    close();
    throw new Error(errorMessage(error, "Voice Realtime session failed to start."));
  }

  return {
    commit: () => {
      if (closed || committed || channel.readyState !== "open") return;
      committed = true;
      channel.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
      stream.getTracks().forEach((track) => {
        if (track.readyState === "live") track.stop();
      });
    },
    close
  };
}
