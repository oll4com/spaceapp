import { createLiveToolReplay } from "./live-tool-replay.js";
import { createGateway } from "@ai-sdk/gateway";
import { createIdentifiedLiveCommandOrigins, type LiveCommandRoom } from "./live-command-origin.js";

type Codec = ReturnType<ReturnType<typeof createGateway>["experimental_realtime"]>;
type SessionConfig = Parameters<Codec["buildSessionConfig"]>[0];
type ClientEvent = Parameters<Codec["serializeClientEvent"]>[0];

/** Transport-independent normalized Gateway protocol. Never mints credentials. */
export function createGatewayRealtimeController(options: {
  model: string;
  config: SessionConfig;
  send: (data: string) => void;
  captureCommandRoom: () => LiveCommandRoom;
  execute: (name: string, args: string, callId: string, origin: LiveCommandRoom) => Promise<string>;
  onReady: () => void;
  onAudio: (delta: string) => void;
  onInterrupt: () => void;
  onTranscript: (id: string, role: "user" | "assistant", text: string, delta: boolean) => void;
  onError: (message: string) => void;
}) {
  const codec = createGateway().experimental_realtime(options.model);
  const allowedTools = new Set(options.config.tools?.map((tool) => tool.name));
  const calls = new Set<string>();
  const results = createLiveToolReplay();
  const responses = new Set<string>();
  let ready = false;
  let closed = false;
  let pending = 0;
  let needsResponse = false;
  let needsInputResponse = false;
  let continuationOrigin: LiveCommandRoom = () => undefined;
  let queue = Promise.resolve();
  const send = (event: ClientEvent) => {
    if (!closed) options.send(JSON.stringify(codec.serializeClientEvent(event)));
  };
  const fail = (message: string) => {
    if (closed) return;
    closed = true;
    ready = false;
    origins.invalidate();
    options.onError(message);
  };
  const origins = createIdentifiedLiveCommandOrigins(options.captureCommandRoom, 4096, () => {
    fail("Overlapping voice commands could not be matched to their responses. Live is reconnecting; please repeat the latest command.");
  });
  const continueResponse = () => {
    if (!closed && ready && pending === 0 && responses.size === 0 && needsResponse) {
      needsResponse = false;
      const userResponse = needsInputResponse;
      needsInputResponse = false;
      if (!userResponse && !origins.expectContinuation(continuationOrigin)) return;
      send({ type: "response-create" });
    }
  };
  return {
    codec,
    start: () => send({ type: "session-update", config: options.config }),
    isReady: () => ready && !closed,
    updateInstructions: (instructions: string) => {
      options.config = { ...options.config, instructions };
      if (ready && !closed) send({ type: "session-update", config: options.config });
    },
    invalidateCommands: () => origins.invalidate(),
    close: () => { origins.invalidate(); closed = true; ready = false; },
    sendAudio: (audio: string) => { if (ready) send({ type: "input-audio-append", audio }); },
    sendText: (text: string) => {
      if (!ready || closed) throw new Error("Voice session is not ready.");
      if (!text.trim()) return;
      origins.beginInput();
      if (closed) throw new Error("The voice connection is restarting. Please repeat the latest command after reconnecting.");
      send({ type: "conversation-item-create", item: { type: "text-message", role: "user", text } });
      needsResponse = true;
      needsInputResponse = true;
      continueResponse();
    },
    receive: (raw: unknown) => {
      if (closed || !raw || typeof raw !== "object") return;
      const parsed = codec.parseServerEvent(raw);
      // Gateway currently emits one event per frame. Keep the codec boundary
      // explicit so a future SDK returning multiple events fails visibly.
      if (Array.isArray(parsed)) { fail("Unsupported Gateway event batch."); return; }
      const event = parsed;
      if (event.type === "error") { fail(event.message || "Gateway session failed."); return; }
      if (event.type === "session-updated") {
        if (!ready) { ready = true; options.onReady(); }
        return;
      }
      if (!ready) return;
      switch (event.type) {
        case "speech-started": options.onInterrupt(); origins.beginInput(); break;
        case "audio-delta":
          if (typeof event.delta === "string") options.onAudio(event.delta);
          break;
        case "input-transcription-completed":
          if (event.itemId && typeof event.transcript === "string") options.onTranscript(event.itemId, "user", event.transcript, false);
          break;
        case "audio-transcript-delta":
        case "text-delta":
          if (event.itemId && typeof event.delta === "string") options.onTranscript(event.itemId, "assistant", event.delta, true);
          break;
        case "audio-transcript-done":
          if (event.itemId && typeof event.transcript === "string") options.onTranscript(event.itemId, "assistant", event.transcript, false);
          break;
        case "text-done":
          if (event.itemId && typeof event.text === "string") options.onTranscript(event.itemId, "assistant", event.text, false);
          break;
        case "response-created":
          if (event.responseId) { origins.responseCreated(event.responseId); responses.add(event.responseId); }
          break;
        case "response-done":
          responses.delete(event.responseId);
          if (event.status === "failed" || event.status === "cancelled" || event.status === "incomplete") {
            fail(`Gateway response ${event.status}; dependent tools were stopped.`);
            return;
          }
          continueResponse();
          break;
        case "function-call-arguments-done": {
          if (!event.callId || typeof event.name !== "string" || typeof event.arguments !== "string") {
            fail("Invalid Gateway tool call."); return;
          }
          if (calls.has(event.callId)) {
            void results.run(event.callId, event.name, event.arguments, async () => "").then(output => {
              send({ type: "conversation-item-create", item: { type: "function-call-output", callId: event.callId, name: event.name, output } });
            }).catch(() => fail("Invalid Gateway replay."));
            return;
          }
          // Fail closed on an oversized session, never evict deduplication keys
          // and accidentally repeat side effects. Pending calls are serialized.
          if (calls.size >= 4096 || pending >= 32 || event.arguments.length > 128_000) {
            fail("Gateway tool execution limit reached."); return;
          }
          if (!allowedTools.has(event.name)) { fail("Gateway requested a tool not enabled in this session."); return; }
          try { const args = JSON.parse(event.arguments); if (!args || typeof args !== "object" || Array.isArray(args)) throw Error(); }
          catch { fail("Invalid Gateway tool arguments."); return; }
          calls.add(event.callId);
          origins.bindCall(event.callId, event.responseId);
          const origin = origins.captureCall(event.callId);
          continuationOrigin = origin;
          pending++;
          needsResponse = true;
          const previousQueue = queue;
          const result = results.run(event.callId, event.name, event.arguments, async () => {
            await previousQueue;
            if (closed) return JSON.stringify({ ok: false, code: "LIVE_SESSION_CLOSED" });
            return options.execute(event.name, event.arguments, event.callId, origin);
          });
          queue = previousQueue.then(async () => {
            if (closed) return;
            if (!allowedTools.has(event.name)) throw new Error("Gateway requested a tool not enabled in this session.");
            const args = JSON.parse(event.arguments);
            if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("Invalid Gateway tool arguments.");
            const output = await result;
            send({ type: "conversation-item-create", item: {
              type: "function-call-output", callId: event.callId, name: event.name, output
            } });
          }).catch(() => fail("Gateway tool execution failed; no automatic retry was made."))
            .finally(() => { pending--; continueResponse(); });
          break;
        }
      }
    }
  };
}
