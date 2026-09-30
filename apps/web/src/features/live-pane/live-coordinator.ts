import type { createLiveHistorySync } from "./live-history-sync.js";
import type { ControlWatch, LiveRoomContext } from "@space/contracts";
import type { LiveInputPart, LiveSessionCallbacks, LiveSessionHandle, LiveSessionOptions, LiveTranscriptItem } from "./live-session.js";

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
  let configured: Partial<LiveSessionOptions> = {};
  let releaseMicrophone: (() => void) | null = null;
  let hasConnected = false;
  let inputActive = false;
  let lastInputAt = 0;
  let notificationTimer: ReturnType<typeof setTimeout> | null = null;
  let notificationBusy = false;
  let historyRead: Promise<void> = Promise.resolve();
  const key = () => `space.live.coordinator.v2:${state.ownerId}`;
  const persist = () => {
    if (!state.ownerId) return;
    try { deps.storage?.setItem(key(), JSON.stringify({ enabled: state.enabled, muted: state.muted, transcripts: state.transcripts.slice(-200), hasConnected })); } catch {}
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
      for (const watch of watches.slice(0, 20)) {
        if (disposed || generation !== version || !deps.notifications.visible() || inputActive || Date.now() - lastInputAt < 1500 || !state.handle || !["active", "listening"].includes(state.status)) break;
        const id = `watch:${watch.id}`;
        const alreadyPresented = state.transcripts.some(item => item.id === id);
        if (!alreadyPresented) {
          const item: LiveTranscriptItem = { id, roomId: watch.roomId, roomName: watch.roomId, role: "system", timestamp: new Date().toISOString(), createdAtMs: Date.now(),
            text: `${watch.paneDetails?.title ?? watch.paneId}: ${watch.status === "VERIFIED" ? "Task completed" : watch.status.toLowerCase()}. ${watch.reason ?? ""} (Room: ${watch.roomId})` };
          if (!await deps.history.persistNotification(item)) continue;
          if (generation !== version || disposed) return;
          addTurn(item, false);
          // Presentation is durable before ack. Audio is best effort and never
          // claimed as delivered based solely on a successful socket.send.
          if (deps.notifications.visible() && !inputActive && Date.now() - lastInputAt >= 1500 && ["active", "listening"].includes(state.status)) state.handle?.notify?.(item.text, id);
        }
        await deps.notifications.ack(watch.roomId, watch.id);
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
    if (!resume) old?.close();
    await Promise.all([refreshContext(), historyRead]);
    if (version !== generation || disposed || !state.enabled) { if (version === generation) starting = false; return; }
    const current = () => version === generation && !disposed && state.enabled;
    const callbacks: LiveSessionCallbacks = {
      onInputStart: () => { if (current()) { if (!inputActive) { inputRoom = state.roomId; commandEpoch++; } inputActive = true; lastInputAt = Date.now(); } },
      onInputEnd: () => { if (current()) { inputActive = false; lastInputAt = Date.now(); } },
      onTranscriptUpdate: item => { if (current()) { if (item.role === "user") { lastInputAt = Date.now(); if (!item.isDelta) inputActive = false; } addTurn(item); } },
      onStatusChange: status => {
        if (!current()) return;
        patch({ status });
        if (status === "idle" || status === "error") scheduleReconnect();
        else if (status === "active" || status === "listening") reconnectAttempts = 0;
      },
      onError: message => { if (current()) { patch({ error: message, status: "error" }); scheduleReconnect(); } },
      onReconnect: resumeSession => { if (current()) { cancelReconnect(); scheduleReconnect(resumeSession); } },
      onRemoteStream: stream => { if (current()) deps.onStream?.(stream); }
    };
    try {
      if (!releaseMicrophone && deps.acquireMicrophone) {
        const release = await deps.acquireMicrophone(state.ownerId);
        if (!current()) { release(); return; }
        releaseMicrophone = release;
      }
      connectionOptions = { ...deps.config(), ...configured, muted: state.muted, managedNotifications: true, roomId: state.roomId!, roomContext: state.context ?? undefined,
        transcripts: state.transcripts, suppressGreeting: hasConnected || state.transcripts.length > 0,
        getCommandRoom: () => state.contextState === "ready" && inputRoom === state.roomId ? state.roomId ?? undefined : undefined,
        captureCommandRoom: () => {
          const epoch = commandEpoch, room = inputRoom;
          return () => epoch === commandEpoch && state.enabled && state.contextState === "ready" && room === state.roomId
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
    generation++; commandEpoch++; starting = false; inputActive = false; cancelReconnect();
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
      if (state.contextState !== "ready") throw new Error("Room context is still loading. Please try again.");
      inputRoom = state.roomId; commandEpoch++; lastInputAt = Date.now();
      if (state.handle.sendInput) return state.handle.sendInput(parts);
      if (parts.some(p => p.type !== "text")) throw new Error("Attachments are unavailable for this voice provider.");
      for (const part of parts) if (part.type === "text") state.handle.sendTextMessage(part.text);
    },
    async clearRoom(roomId: string) {
      try {
        await deps.history?.clearRoom(roomId, state.transcripts.filter(item => item.roomId === roomId).map(item => item.id));
        patch({ transcripts: state.transcripts.filter(item => item.roomId !== roomId) }); persist();
      } catch (error) { patch({ error: error instanceof Error ? error.message : "Conversation could not be cleared." }); }
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
