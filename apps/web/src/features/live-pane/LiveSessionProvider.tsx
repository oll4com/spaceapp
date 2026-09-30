import { createLiveHistorySync } from "./live-history-sync.js";
import { createContext, useContext, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { api } from "../../api.js";
import { createLiveCoordinator } from "./live-coordinator.js";
import { loadLivePaneConfig } from "./live-pane-config.js";
import type { LiveSessionOptions } from "./live-session.js";
import { loadLiveConversationSession } from "./live-session-loader.js";

export type LiveCoordinator = ReturnType<typeof createLiveCoordinator>;
const LiveContext = createContext<LiveCoordinator | null>(null);
export function useLiveCoordinator() { return useContext(LiveContext); }
const noopSubscribe = () => () => {};
const emptySnapshot = () => null;
export function useLiveSessionState() {
  const coordinator = useLiveCoordinator();
  return useSyncExternalStore(coordinator?.subscribe ?? noopSubscribe, coordinator?.getSnapshot ?? emptySnapshot);
}

function defaultOptions(): LiveSessionOptions {
  const cfg = loadLivePaneConfig("default");
  // Personal facts come from the authenticated owner, never another tab's cache.
  return {
    provider: cfg.provider, model: cfg.voiceModel ?? "gpt-live-1", language: cfg.language ?? "auto",
    voice: cfg.voice, opening: cfg.opening, prompt: [cfg.prompt, cfg.voicePrompt].filter(Boolean).join("\n\n"),
    delegatedModel: cfg.delegatedModel, delegatedType: "responses", delegatedReasoningEffort: cfg.reasoningEffort ?? "minimal",
    delegatedWebSearch: cfg.webSearch, delegatedPrompt: cfg.delegatedPrompt, audioDeviceId: cfg.selectedDeviceId,
    enableGeminiMemory: cfg.geminiMemoryEnabled, timeZone: cfg.timeZone,
    enableMcpTools: cfg.enableMcpTools, enableProfileMemory: cfg.enableProfileMemory
  };
}

/** Browser-owned lock automatically releases when a tab crashes or closes. */
export async function acquireLiveMicrophone(ownerId: string): Promise<() => void> {
  if (typeof navigator === "undefined" || !navigator.locks) return () => {};
  return new Promise((resolve, reject) => {
    void navigator.locks.request(`space.live.microphone:${ownerId}`, { ifAvailable: true }, async lock => {
      if (!lock) { reject(new Error("AI Live is active in another tab. Disconnect it there before connecting here.")); return; }
      await new Promise<void>(release => { resolve(release); });
    }).catch(reject);
  });
}

export function LiveSessionProvider({ ownerId, roomId, roomName = "", children }: {
  ownerId: string; roomId: string | null; roomName?: string; children: ReactNode;
}) {
  const audio = useRef<HTMLAudioElement>(null);
  const lastBroadcast = useRef("");
  const [coordinator] = useState(() => createLiveCoordinator({
    config: defaultOptions,
    history: createLiveHistorySync({ load: () => api.getLiveHistory(), save: (turns, owner) => api.saveLiveHistory(turns, owner), clear: room => api.clearVoiceRealtimeLogs(room), storage: window.localStorage,
      onError: message => window.dispatchEvent(new CustomEvent("space-live-debug", { detail: { message, type: "error" } })) }),
    acquireMicrophone: acquireLiveMicrophone,
    notifications: { list: () => api.getPendingWatches(), ack: (room, id) => api.ackWatch(room, id), visible: () => document.visibilityState === "visible" },
    storage: typeof window === "undefined" ? undefined : window.localStorage,
    context: (id, signal) => api.getLiveRoomContext(id, signal),
    open: async (options, callbacks, isCurrent) => {
      const [openLiveConversationSession, memory] = await Promise.all([
        loadLiveConversationSession(),
        api.getLivePersonalMemory().catch(() => ({ items: [] }))
      ]);
      if (!isCurrent()) throw new DOMException("Live connection cancelled.", "AbortError");
      return openLiveConversationSession({ ...options, personalMemories: memory.items }, callbacks);
    },
    onStream: stream => {
      if (audio.current) { audio.current.srcObject = stream; void audio.current.play().catch(() => undefined); }
    },
    onState: state => {
      const signature = `${state.roomId}:${state.status}:${state.muted}`;
      if (lastBroadcast.current !== signature) {
        lastBroadcast.current = signature;
        window.dispatchEvent(new CustomEvent("space-live-pane-status", { detail: { rail: true, roomId: state.roomId, status: state.status, muted: state.muted } }));
      }
      (window as any).__SPACE_ACTIVE_LIVE_SESSION__ = state.handle ? { handle: state.handle, source: "coordinator", roomId: state.roomId } : null;
    }
  }));
  useEffect(() => {
    coordinator.activate();
    const toggle = () => coordinator.toggle();
    const stop = () => coordinator.stop();
    const invalidate = (event: Event) => {
      const id = (event as CustomEvent<{ roomId: string }>).detail?.roomId;
      if (id) coordinator.invalidate(id);
    };
    window.addEventListener("space-live-rail-toggle", toggle);
    window.addEventListener("space-live-session-stop", stop);
    window.addEventListener("space-live-context-invalidated", invalidate);
    return () => {
      window.removeEventListener("space-live-rail-toggle", toggle);
      window.removeEventListener("space-live-session-stop", stop);
      window.removeEventListener("space-live-context-invalidated", invalidate);
      coordinator.dispose();
      if ((window as any).__SPACE_ACTIVE_LIVE_SESSION__?.source === "coordinator") (window as any).__SPACE_ACTIVE_LIVE_SESSION__ = null;
    };
  }, [coordinator]);
  useEffect(() => { coordinator.setOwner(ownerId); coordinator.setRoom(roomId, roomName); }, [coordinator, ownerId, roomId, roomName]);
  return <LiveContext.Provider value={coordinator}><audio ref={audio} id="space-live-rail-audio" autoPlay hidden />{children}</LiveContext.Provider>;
}
