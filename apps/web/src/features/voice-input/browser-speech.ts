import type { VoiceTranscriptionLanguage } from "@space/contracts";
import { MICROPHONE_CONSTRAINTS, type VoiceRealtimeSessionHandle } from "../../voice-realtime.js";
import { createAudioContextWithFallback, downsampleBuffer, pcm16FromFloat32 } from "../../audio-pcm.js";

/**
 * The browser's own speech recognition (Web Speech API: Chrome, Edge, Safari): free, no Space key and no tokens
 * (operator 31/10). Space's paid voice relay stays an explicit choice in Settings → Voice input, never a fallback.
 */
interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}
type SpeechRecognitionConstructor = new () => SpeechRecognitionLike;

const RELAY_HINT = "Use Chrome, or choose the Space voice relay in Settings → Voice input.";
const errorText: Record<string, string> = {
  "not-allowed": "Microphone permission was not granted.",
  "audio-capture": "No microphone was found.",
  "service-not-allowed": `This browser does not allow its speech recognition here. ${RELAY_HINT}`,
  network: `The browser's speech recognition could not reach its service. ${RELAY_HINT}`,
  "language-not-supported": "This browser cannot recognize the chosen language. Choose another one in Settings → Voice input."
};

function recognitionConstructor(): SpeechRecognitionConstructor | null {
  if (typeof window === "undefined") return null;
  const speech = window as unknown as { SpeechRecognition?: SpeechRecognitionConstructor; webkitSpeechRecognition?: SpeechRecognitionConstructor };
  return speech.SpeechRecognition ?? speech.webkitSpeechRecognition ?? null;
}

/** SpaceApp Desktop's own recognizer (whisper.cpp on the PC, `apps/desktop/src/main/local-speech.ts`). */
interface DesktopSpeech {
  prepare: () => Promise<{ ready: boolean; progress: number; error?: string }>;
  transcribe: (pcm: Uint8Array, lang: VoiceTranscriptionLanguage) => Promise<{ text?: string; error?: string }>;
}
const inDesktopApp = () => typeof window !== "undefined" && "spaceDesktop" in window;
const desktopSpeech = () => (window as unknown as { spaceDesktop?: { speech?: DesktopSpeech } }).spaceDesktop?.speech;
const DESKTOP_UPDATE = "This SpaceApp Desktop version has no free speech recognition: update SpaceApp, or choose the Space voice relay in Settings → Voice input.";

/**
 * Who recognizes speech for the free engine: SpaceApp Desktop on the PC (Electron has no key for Google's speech service, so its
 * Web Speech always ends in "network"), else the browser; null when neither can.
 */
export function browserSpeechEngine(): "desktop" | "browser" | null {
  if (inDesktopApp()) return desktopSpeech() ? "desktop" : null;
  return recognitionConstructor() ? "browser" : null;
}
export const browserSpeechSupported = (): boolean => browserSpeechEngine() !== null;

/** Greek or English; Auto is Greek when the browser lists Greek among its languages. */
export function browserSpeechLang(language: VoiceTranscriptionLanguage, languages: readonly string[] = navigator.languages ?? []): string {
  if (language === "el") return "el-GR";
  if (language === "en") return "en-US";
  return languages.some((entry) => entry.toLowerCase().startsWith("el")) ? "el-GR" : "en-US";
}

type SpeechCallbacks = {
  onTranscriptDelta: (text: string) => void;
  onTranscriptComplete: (text: string) => void;
  onError: (message: string) => void;
};

/** Records at 16 kHz until commit(), then the desktop app transcribes the take on the PC; close() drops it. */
async function openDesktopSpeechSession(speech: DesktopSpeech, lang: VoiceTranscriptionLanguage, callbacks: SpeechCallbacks): Promise<VoiceRealtimeSessionHandle> {
  const state = await speech.prepare();
  if (state.error) throw new Error(state.error);
  if (!state.ready) {
    throw new Error(`SpaceApp is downloading its free speech recognition for this PC, once (${Math.floor(state.progress * 100)}% of 590 MB). Try again when it is done.`);
  }
  const stream = await navigator.mediaDevices.getUserMedia(MICROPHONE_CONSTRAINTS);
  let audioContext: AudioContext, source: MediaStreamAudioSourceNode, processor: ScriptProcessorNode;
  try {
    audioContext = createAudioContextWithFallback(16000);
    source = audioContext.createMediaStreamSource(stream);
    processor = audioContext.createScriptProcessor(4096, 1, 1);
  } catch (error) {
    stream.getTracks().forEach((track) => track.stop());
    throw error;
  }
  const chunks: Float32Array[] = [];
  processor.onaudioprocess = (event) => chunks.push(new Float32Array(event.inputBuffer.getChannelData(0)));
  source.connect(processor);
  processor.connect(audioContext.destination);
  let ended = false;
  const release = () => {
    ended = true;
    processor.disconnect();
    source.disconnect();
    stream.getTracks().forEach((track) => track.stop());
    void audioContext.close().catch(() => {});
  };
  return {
    startCapture: async () => {},
    commit: () => {
      if (ended) return;
      release();
      const take = new Float32Array(chunks.reduce((length, chunk) => length + chunk.length, 0));
      let offset = 0;
      for (const chunk of chunks) {
        take.set(chunk, offset);
        offset += chunk.length;
      }
      const pcm = new Uint8Array(pcm16FromFloat32(downsampleBuffer(take, audioContext.sampleRate, 16000)));
      if (!pcm.byteLength) return callbacks.onTranscriptComplete("");
      speech.transcribe(pcm, lang).then(
        (result) => (result.error ? callbacks.onError(result.error) : callbacks.onTranscriptComplete(result.text ?? "")),
        (error) => callbacks.onError(error instanceof Error ? error.message : String(error))
      );
    },
    close: () => { if (!ended) release(); }
  };
}

/** Starts listening at once; commit() stops and delivers what was heard, close() drops it. */
export async function openBrowserSpeechSession(language: VoiceTranscriptionLanguage, callbacks: SpeechCallbacks): Promise<VoiceRealtimeSessionHandle> {
  if (inDesktopApp()) {
    const speech = desktopSpeech();
    if (!speech) throw new Error(DESKTOP_UPDATE);
    // Whisper hears Auto itself, take by take: the PC's language list does not decide Greek or English.
    return openDesktopSpeechSession(speech, language, callbacks);
  }
  const lang = browserSpeechLang(language);
  const Recognition = recognitionConstructor();
  if (!Recognition) throw new Error(`This browser has no speech recognition. ${RELAY_HINT}`);
  const recognition = new Recognition();
  recognition.lang = lang;
  recognition.continuous = true;
  recognition.interimResults = true;
  let heard = "";
  let ended = false;
  recognition.onresult = (event) => {
    heard = Array.from(event.results, (result) => result[0]?.transcript.trim() ?? "").filter(Boolean).join(" ");
    callbacks.onTranscriptDelta(heard);
  };
  recognition.onerror = (event) => {
    // No speech ends as an empty take; aborted is our own close.
    if (ended || event.error === "no-speech" || event.error === "aborted") return;
    ended = true;
    callbacks.onError(errorText[event.error] ?? `Speech recognition failed (${event.error}).`);
  };
  recognition.onend = () => {
    if (ended) return;
    ended = true;
    callbacks.onTranscriptComplete(heard);
  };
  recognition.start();
  return {
    startCapture: async () => {},
    commit: () => { if (!ended) recognition.stop(); },
    close: () => {
      ended = true;
      recognition.abort();
    }
  };
}
