export type { LiveInputPart, LiveSessionHandle, LiveTranscriptItem } from "./live-session.js";
export { mergeTranscriptText, getGreetingForThailandTime } from "./live-transcript.js";

// Callers check their existing session generation after loading, before any
// transport or microphone starts. Import errors use their existing error UI.
export async function loadLiveConversationSession(): Promise<typeof import("./live-session.js").openLiveConversationSession> {
  return (await import("./live-session.js")).openLiveConversationSession;
}
