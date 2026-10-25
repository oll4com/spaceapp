import type { createLiveHistorySync } from "./live-history-sync.js";
import type { ControlWatch, LiveRoomContext } from "@space/contracts";
import type { LiveInputPart, LiveSessionCallbacks, LiveSessionHandle, LiveSessionOptions, LiveTranscriptItem } from "./live-session.js";
import { updateLiveSessionStats } from "./live-stats.js";
import { isSilentWatch } from "./live-watch-notices.js";

import { liveDeclinedSince, liveUserTurn, noteLiveUserText, noteLiveUserTurn } from "./live-command-origin.js";

export type LiveStatus = "idle" | "connecting" | "active" | "listening" | "thinking" | "speaking" | "error";
export interface LiveCoordinatorState {
  ownerId: string; roomId: string | null; roomName: string;
  context: LiveRoomContext | null; contextState: "loading" | "ready" | "unavailable";
  status: LiveStatus; enabled: boolean; muted: boolean; error: string | null;
  transcripts: LiveTranscriptItem[]; handle: LiveSessionHandle | null;
}

/** Audio ownership is independent of room presentation and pane mounting. */
export function createLiveCoordinator(deps: {
  open: (options: LiveSessionOptions, callbacks: LiveSessionCallbacks, isCurrent: () => boolean) => Promise<LiveSessionHandle>;
  context: (roomId: string, signal: AbortSignal) => Promise<LiveRoomContext>;
  config: () => LiveSessionOptions;
  storage?: Pick<Storage, "getItem" | "setItem">;
  history?: ReturnType<typeof createLiveHistorySync>;
  acquireMicrophone?: (ownerId: string) => Promise<() => void>;
  onStream?: (stream: MediaStream) => void;
  onState?: (state: LiveCoordinatorState) => void;
  onTurn?: (item: LiveTranscriptItem) => void;
  notifications?: { list: () => Promise<ControlWatch[]>; ack: (roomId: string, id: string) => Promise<unknown>; visible: () => boolean };
  /** Further spoken notices (the Room Agent's questions for the operator), delivered after watches, one per round. */
  announcements?: { list: () => Promise<Array<{ id: string; roomId: string; roomName?: string; text: string }>>; ack: (id: string) => void };
}) {
  let state: LiveCoordinatorState = { ownerId: "", roomId: null, roomName: "", context: null, contextState: "unavailable", status: "idle", enabled: false, muted: false, error: null, transcripts: [], handle: null };
  const listeners = new Set<() => void>();
  let generation = 0;
  let roomGeneration = 0;
  let inputRoom: string | null = null;
  let commandEpoch = 0;
  let contextAbort: AbortController | null = null;
  let contextRead: Promise<void> | null = null;
  let refreshTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectAttempts = 0;
  let starting = false;
  let connecting: Promise<void> | null = null;
  let disposed = false;
  let contextDirty = false;
  let connectionOptions: LiveSessionOptions | null = null;
  let liveSessionId: string = crypto.randomUUID();
  let configured: Partial<LiveSessionOptions> = {};
  let releaseMicrophone: (() => void) | null = null;
  let hasConnected = false;
  let inputActive = false;
  let lastInputAt = 0;
  let connectStartedAt = 0, inputEndedAt = 0;
  let notificationTimer: ReturnType<typeof setTimeout> | null = null;
  let notificationBusy = false;
  let historyRead: Promise<void> = Promise.resolve();
  const key = () => `space.live.coordinator.v2:${state.ownerId}`;
  const persist = () => {
    if (!state.ownerId) return;
    try { deps.storage?.setItem(key(), JSON.stringify({ enabled: state.enabled, muted: state.muted, transcripts: state.transcripts.slice(-200), hasConnected, liveSessionId })); } catch {}
  };
  const patch = (change: Partial<LiveCoordinatorState>) => {
    state = { ...state, ...change };
    for (const listener of listeners) listener();
    deps.onState?.(state);
    if (!saveTimer) saveTimer = setTimeout(() => { saveTimer = null; persist(); }, 250);
  };
  const addTurn = (item: LiveTranscriptItem, persistTurn = true) => {
    const origin = item.roomId || inputRoom || state.roomId || undefined;
    const entry = { ...item, roomId: origin, roomName: item.roomName || (origin === state.roomId ? state.roomName : origin), createdAtMs: item.createdAtMs ?? Date.now() };
    const index = state.transcripts.findIndex(previous => previous.id === entry.id);
    const next = [...state.transcripts];
    if (index < 0) next.push({ ...entry, isDelta: false });
    else {
      const previous = next[index]!;
      next[index] = { ...previous, ...entry, roomId: previous.roomId, roomName: previous.roomName,
        isDelta: false, text: entry.isDelta ? previous.text + entry.text : entry.text || previous.text };
    }
    patch({ transcripts: next.slice(-200) });
    const turn = next[index < 0 ? next.length - 1 : index]!;
    if (turn.role === "user") noteLiveUserText(turn.text);
    deps.onTurn?.(turn); if (persistTurn) deps.history?.enqueue(turn);
  };
  const scheduleNotifications = () => {
    if (!deps.notifications || disposed || !state.enabled || notificationTimer) return;
    notificationTimer = setTimeout(() => { notificationTimer = null; void deliverNotifications(); }, 2000);
  };
  const deliverNotifications = async () => {
    if (!deps.notifications || !deps.history || notificationBusy || disposed || !state.enabled) return;
    if (!deps.notifications.visible() || !state.handle || inputActive || Date.now() - lastInputAt < 1500 || !["active", "listening"].includes(state.status)) { scheduleNotifications(); return; }
    notificationBusy = true;
    const version = generation;
    try {
      const watches = await deps.notifications.list();
      const notices: Array<{ id: string; roomId: string; roomName?: string; text: string; ack: () => unknown; silent?: boolean }> = watches.slice(0, 20).map(watch => ({
        id: `watch:${watch.id}`, roomId: watch.roomId, ack: () => deps.notifications!.ack(watch.roomId, watch.id),
        silent: isSilentWatch(watch),
        text: `${watch.paneDetails?.title ?? watch.paneId}: ${watch.status === "VERIFIED" ? "Task completed" : watch.status.toLowerCase()}. ${watch.reason ?? ""} (Room: ${watch.roomId})` }));
      if (deps.announcements) {
        const announcements = await deps.announcements.list().catch(() => []);
        notices.push(...announcements.slice(0, 10).map(notice => ({ id: `room-agent:${notice.id}`, roomId: notice.roomId, roomName: notice.roomName, text: notice.text, ack: () => deps.announcements!.ack(notice.id) })));
      }
      for (const notice of notices) {
        if (disposed || generation !== version || !deps.notifications.visible() || inputActive || Date.now() - lastInputAt < 1500 || !state.handle || !["active", "listening"].includes(state.status)) break;
        // A cancelled watch (its pane closed) is acknowledged only: neither spoken nor added to the conversation.
        if (notice.silent) { await notice.ack(); continue; }
        const id = notice.id;
        const alreadyPresented = state.transcripts.some(item => item.id === id);
        if (!alreadyPresented) {
          const item: LiveTranscriptItem = { id, roomId: notice.roomId, roomName: notice.roomName || notice.roomId, role: "system", timestamp: new Date().toISOString(), createdAtMs: Date.now(),
            text: notice.text };
          if (!await deps.history.persistNotification(item)) continue;
          if (generation !== version || disposed) return;
          addTurn(item, false);
          // Presentation is durable before ack. Audio is best effort and never
          // claimed as delivered based solely on a successful socket.send.
          if (deps.notifications.visible() && !inputActive && Date.now() - lastInputAt >= 1500 && ["active", "listening"].includes(state.status)) state.handle?.notify?.(item.text, id);
        }
        await notice.ack();
        if (!alreadyPresented) break;
      }
    } catch { /* Unacknowledged notifications remain durable on the server. */ }
    finally { notificationBusy = false; scheduleNotifications(); }
  };
  const cancelReconnect = () => { if (reconnectTimer) clearTimeout(reconnectTimer); reconnectTimer = null; };
  const refreshContext = (): Promise<void> => {
    if (disposed || !state.enabled || !state.roomId) return Promise.resolve();
    if (contextRead) return contextRead;
    const target = state.roomId;
    const version = roomGeneration;
    const abort = new AbortController(); contextAbort = abort;
    const pending = deps.context(target, abort.signal).then(context => {
      if (disposed || abort.signal.aborted || version !== roomGeneration || target !== state.roomId) return;
      if (context.roomId !== target) throw new Error("Live room context belongs to another room.");
      const changed = state.context?.revision !== context.revision;
      patch({ context, roomName: context.name, contextState: "ready", error: null });
      if (changed) state.handle?.updateContext?.(context);
    }).catch(error => {
      if (!abort.signal.aborted && version === roomGeneration && !disposed) patch({ contextState: "unavailable", error: error instanceof Error ? error.message : "Live context unavailable." });
    }).finally(() => {
      if (contextRead !== pending) return;
      contextRead = null;
      if (contextDirty) { contextDirty = false; void refreshContext(); }
    });
    contextRead = pending;
    return pending;
  };
  const scheduleReconnect = (resume?: () => Promise<LiveSessionHandle>) => {
    if (!state.enabled || disposed || reconnectTimer) return;
    const version = generation;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (version === generation && state.enabled && !disposed) void beginConnect(resume);
    }, Math.min(30_000, 500 * 2 ** Math.min(reconnectAttempts++, 6)));
  };
  const connect = async (resume?: () => Promise<LiveSessionHandle>) => {
    if (starting || disposed || !state.roomId || !state.ownerId) return;
    starting = true; cancelReconnect();
    const version = resume ? generation : ++generation;
    const old = state.handle;
    patch({ enabled: true, status: "connecting", handle: null, error: null }); persist();
    connectStartedAt = Date.now(); inputEndedAt = 0;
    if (!resume) old?.close();
    // The room context reaches the open session through updateContext; the microphone never waits for it.
    void refreshContext();
    await historyRead;
    if (version !== generation || disposed || !state.enabled) { if (version === generation) starting = false; return; }
    const current = () => version === generation && !disposed && state.enabled;
    const callbacks: LiveSessionCallbacks = {
      onInputStart: () => { if (current()) { if (!inputActive) inputRoom = state.roomId; inputActive = true; lastInputAt = Date.now(); } },
      onInputEnd: () => { if (current()) { inputActive = false; lastInputAt = inputEndedAt = Date.now(); } },
      onTranscriptUpdate: item => { if (current()) { if (item.role === "user") { lastInputAt = Date.now(); if (!item.isDelta) inputActive = false; } addTurn(item); } },
      onStatusChange: status => {
        if (!current()) return;
        patch({ status });
        if ((status === "active" || status === "listening") && connectStartedAt) { updateLiveSessionStats({ connectMs: Date.now() - connectStartedAt }); connectStartedAt = 0; }
        if (status === "speaking" && inputEndedAt) { updateLiveSessionStats({ lastReplyMs: Date.now() - inputEndedAt }); inputEndedAt = 0; }
        if (status === "idle" || status === "error") scheduleReconnect();
        else if (status === "active" || status === "listening") reconnectAttempts = 0;
      },
      onError: (message, options) => {
        if (!current()) return;
        // A rejected configuration fails again on every retry and each new session is billed.
        if (options?.retryable === false) { stop(); patch({ error: message, status: "error" }); return; }
        patch({ error: message, status: "error" }); scheduleReconnect();
      },
      onReconnect: resumeSession => { if (current()) { cancelReconnect(); scheduleReconnect(resumeSession); } },
      onRemoteStream: stream => { if (current()) deps.onStream?.(stream); }
    };
    try {
      if (!releaseMicrophone && deps.acquireMicrophone) {
        const release = await deps.acquireMicrophone(state.ownerId);
        if (!current()) { release(); return; }
        releaseMicrophone = release;
      }
      connectionOptions = { ...deps.config(), ...configured, userId: state.ownerId, liveSessionId, muted: state.muted, managedNotifications: true, roomId: state.roomId!, roomContext: state.context ?? undefined,
        transcripts: state.transcripts, suppressGreeting: hasConnected || state.transcripts.length > 0,
        // A command belongs to the room the user spoke in. It ends with navigation, stop or a later refusal, never
        // because the user kept talking or the room context failed to load (the tools read the room themselves).
        getCommandRoom: () => (inputRoom ?? state.roomId) === state.roomId ? state.roomId ?? undefined : undefined,
        captureCommandRoom: () => {
          const epoch = commandEpoch, room = inputRoom ?? state.roomId, turn = liveUserTurn();
          return () => epoch === commandEpoch && state.enabled && room === state.roomId && !liveDeclinedSince(turn)
            ? room ?? undefined : undefined;
        }
      };
      const handle = resume ? await resume() : await deps.open(connectionOptions, callbacks, current);
      if (!current()) { handle.close(); return; }
      handle.setMuted(state.muted);
      if (state.context && state.context.revision !== connectionOptions.roomContext?.revision) handle.updateContext?.(state.context);
      hasConnected = true;
      patch({ handle }); scheduleNotifications();
    } catch (error) {
      if (current()) {
        patch({ status: "error", error: error instanceof Error ? error.message : "Live connection failed." });
        if (!(error instanceof Error && /NotAllowed|permission|denied|another tab/i.test(error.name + error.message))) scheduleReconnect();
      }
    } finally { if (version === generation) starting = false; }
  };
  const beginConnect = (resume?: () => Promise<LiveSessionHandle>): Promise<void> => {
    if (connecting && starting) return connecting;
    const pending = connect(resume);
    connecting = pending;
    void pending.finally(() => { if (connecting === pending) connecting = null; });
    return pending;
  };
  const stop = () => {
    generation++; commandEpoch++; liveSessionId = crypto.randomUUID(); starting = false; inputActive = false; cancelReconnect();
    if (notificationTimer) clearTimeout(notificationTimer); notificationTimer = null;
    const handle = state.handle;
    patch({ enabled: false, handle: null, status: "idle", error: null }); persist();
    handle?.close(); releaseMicrophone?.(); releaseMicrophone = null;
  };
  return {
    getSnapshot: () => state,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    setOwner(ownerId: string) {
      if (ownerId === state.ownerId) return;
      stop(); roomGeneration++; contextAbort?.abort(); contextRead = null;
      let saved: Partial<LiveCoordinatorState> = {};
      try { saved = JSON.parse(deps.storage?.getItem(`space.live.coordinator.v2:${ownerId}`) || "{}"); } catch {}
      liveSessionId = (saved as { liveSessionId?: string }).liveSessionId || crypto.randomUUID();
      inputRoom = null; configured = {}; hasConnected = (saved as { hasConnected?: boolean }).hasConnected === true;
      patch({ ownerId, roomId: null, roomName: "", enabled: saved.enabled === true, muted: saved.muted === true, transcripts: Array.isArray(saved.transcripts) ? saved.transcripts.slice(-200) : [], context: null, contextState: "unavailable" });
      if (deps.history) {
        patch({ transcripts: [] });
        historyRead = deps.history.setOwner(ownerId).then(transcripts => { if (state.ownerId === ownerId && !disposed) patch({ transcripts }); });
      }
    },
    setRoom(roomId: string | null, roomName = "") {
      if (roomId === state.roomId) { if (state.enabled && !state.handle && !starting && !reconnectTimer) void beginConnect(); if (roomName && roomName !== state.roomName) { patch({ roomName }); void refreshContext(); } return; }
      roomGeneration++; commandEpoch++; contextAbort?.abort(); contextRead = null; contextDirty = false;
      patch({ roomId, roomName, context: null, contextState: roomId ? "loading" : "unavailable" });
      if (roomId && state.enabled) {
        void refreshContext();
        if (!state.handle && !starting && !reconnectTimer) void beginConnect();
      }
    },
    refreshContext,
    configure(options: Partial<LiveSessionOptions>) { if (!state.enabled) configured = options; },
    invalidate(roomId: string) {
      if (roomId !== state.roomId || !state.enabled || disposed) return;
      if (contextRead) { contextDirty = true; return; }
      if (!refreshTimer) refreshTimer = setTimeout(() => { refreshTimer = null; void refreshContext(); }, 250);
    },
    start: () => state.handle ? Promise.resolve() : beginConnect(),
    activate() {
      if (disposed && deps.history && state.ownerId) historyRead = deps.history.setOwner(state.ownerId).then(transcripts => { if (!disposed) patch({ transcripts }); });
      disposed = false;
    },
    stop,
    toggle: () => starting ? undefined : state.enabled ? stop() : void beginConnect(),
    setMuted(muted: boolean) { patch({ muted }); state.handle?.setMuted(muted); persist(); },
    send(parts: LiveInputPart[]) {
      if (!state.handle) throw new Error("Live is not connected.");
      if (!state.roomId) throw new Error("Open a room before talking to Live.");
      inputRoom = state.roomId; lastInputAt = Date.now(); noteLiveUserTurn();
      noteLiveUserText(parts.map(part => part.type === "text" ? part.text : "").join(" "));
      if (state.handle.sendInput) return state.handle.sendInput(parts);
      if (parts.some(p => p.type !== "text")) throw new Error("Attachments are unavailable for this voice provider.");
      for (const part of parts) if (part.type === "text") state.handle.sendTextMessage(part.text);
    },
    /** Stage 6 Real View: a silent frame, only on providers that stream video. */
    sendVideoFrame(frame: { dataUrl: string }) {
      if (!state.handle?.sendVideoFrame) throw new Error("Real View is unavailable for this voice provider.");
      state.handle.sendVideoFrame(frame);
    },
    canSendVideoFrames() { return Boolean(state.handle?.sendVideoFrame); },
    async clearRoom(roomId: string) {
      let syncError: string | null = null;
      try {
        await deps.history?.clearRoom(roomId, state.transcripts.filter(item => item.roomId === roomId).map(item => item.id));
      } catch (error) {
        syncError = error instanceof Error ? error.message : "Remote conversation could not be cleared.";
      }
      patch({
        transcripts: state.transcripts.filter(item => item.roomId !== roomId),
        ...(syncError ? { error: syncError } : {})
      });
      persist();
    },
    async clearAll() {
      let syncError: string | null = null;
      try {
        const roomIds = Array.from(new Set(state.transcripts.map(item => item.roomId).filter(Boolean))) as string[];
        for (const rId of roomIds) {
          await deps.history?.clearRoom(rId, state.transcripts.filter(item => item.roomId === rId).map(item => item.id));
        }
        if (state.roomId && !roomIds.includes(state.roomId)) {
          await deps.history?.clearRoom(state.roomId, []);
        }
      } catch (error) {
        syncError = error instanceof Error ? error.message : "Remote conversation could not be cleared.";
      }
      patch({
        transcripts: [],
        ...(syncError ? { error: syncError } : {})
      });
      persist();
    },
    addTurn,
    dispose() {
      const wanted = state.enabled; deps.history?.dispose();
      if (notificationTimer) clearTimeout(notificationTimer); notificationTimer = null;
      disposed = true; generation++; commandEpoch++; starting = false; cancelReconnect(); contextAbort?.abort(); contextRead = null;
      if (refreshTimer) clearTimeout(refreshTimer); refreshTimer = null;
      if (saveTimer) clearTimeout(saveTimer); saveTimer = null;
      state.handle?.close(); releaseMicrophone?.(); releaseMicrophone = null; state = { ...state, handle: null, status: "idle", enabled: wanted }; persist(); listeners.clear();
    }
  };
}
