import type { VoiceTranscriptionLanguage } from "@space/contracts";
import type { VoiceRealtimeSessionHandle } from "../../voice-realtime.js";

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

export const browserSpeechSupported = (): boolean => recognitionConstructor() !== null;

/** Greek or English; Auto is Greek when the browser lists Greek among its languages. */
export function browserSpeechLang(language: VoiceTranscriptionLanguage, languages: readonly string[] = navigator.languages ?? []): string {
  if (language === "el") return "el-GR";
  if (language === "en") return "en-US";
  return languages.some((entry) => entry.toLowerCase().startsWith("el")) ? "el-GR" : "en-US";
}

/** Starts listening at once; commit() stops and delivers what was heard, close() drops it. */
export function openBrowserSpeechSession(lang: string, callbacks: {
  onTranscriptDelta: (text: string) => void;
  onTranscriptComplete: (text: string) => void;
  onError: (message: string) => void;
}): VoiceRealtimeSessionHandle {
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
