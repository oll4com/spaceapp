import { runRoomPlaybackCommand } from "./room-playback-control.js";
import { Bot } from "../ui-theme/app-icons.js";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import type { Room, RoomAgentPaneStripItem, RoomAgentSession } from "@space/contracts";
import { api } from "../../api.js";
import { useOptionalVoiceInput } from "../voice-input/VoiceInputProvider.js";
import { useKeyboardAutocorrectSettings } from "../keyboard-autocorrect/keyboard-autocorrect-settings.js";
import { textToSend } from "../keyboard-autocorrect/send-layout.js";
import { useIsDockActive } from "../docks/dock-active-context.js";
import { DockNotice, DockState, useDockConfirm } from "../dock-kit/DockKit.js";
import { paneStripName } from "./RoomAgentPaneStrip.js";
import { RoomAgentHeader } from "./RoomAgentHeader.js";
import { RoomAgentTimeline, type RoomAgentPendingMessage } from "./RoomAgentTimeline.js";
import { RoomAgentComposer } from "./RoomAgentComposer.js";
import { useRoomAgentStream } from "./use-room-agent-stream.js";
import "./room-agent-dock.css";

interface RoomAgentDockProps {
  activeRoom: Room | null;
  /** Kept for App compatibility; the Room Agent works whether or not the Codex CLI is enabled. */
  isCodexEnabled?: boolean;
  selectedBrowserPaneId?: string;
  refreshKey?: string | null;
  /** Opens (and restores) a pane of the room, as the Agents Dashboard does. */
  onOpenPane?: (paneId: string) => void;
}

function clientRequestId(): string {
  const suffix = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `room-agent-web:${suffix}`;
}

const suggestions = ["What do you see in the room?", "What needs me?", "Continue pending work"];
const roomAgentSessionCache = new Map<string, RoomAgentSession>();
/** While an answer is written the stream carries it; polling only backs it up. */
const ANSWERING_POLL_MS = 3_000;
const IDLE_POLL_MS = 20_000;

/**
 * The Room Agent as one conversation for the whole room: a header with the room in one line, the timeline (answers,
 * tools, monitor events, confirmations) and the composer. The answer streams in over the dock's own stream.
 */
export function RoomAgentDock({ activeRoom, selectedBrowserPaneId, refreshKey = null, onOpenPane }: RoomAgentDockProps) {
  const voiceInput = useOptionalVoiceInput();
  const voiceOwnerId = `room-agent:${activeRoom?.id ?? "none"}`;
  const isDockActive = useIsDockActive();
  const { confirm, confirmDialog } = useDockConfirm();
  const { settings: autocorrectSettings } = useKeyboardAutocorrectSettings();
  const [session, setSession] = useState<RoomAgentSession | null>(() =>
    activeRoom?.id ? roomAgentSessionCache.get(activeRoom.id) ?? null : null
  );
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(false);
  const [pending, setPending] = useState<Array<RoomAgentPendingMessage & { roomId: string }>>([]);
  const [stopping, setStopping] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [replying, setReplying] = useState(false);
  const [switchingMonitor, setSwitchingMonitor] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const activeRoomIdRef = useRef<string | null>(activeRoom?.id ?? null);
  const loadSequenceRef = useRef(0);
  const sendSequenceRef = useRef(0);
  const latestAppliedSendRef = useRef(0);
  const stopSequenceRef = useRef(0);
  const clearSequenceRef = useRef(0);
  const pendingRequestsRef = useRef(new Map<string, { roomId: string; content: string; clientRequestId: string; selectedBrowserPaneId?: string; inFlight: boolean }>());
  const roomGenerationRef = useRef(0);
  activeRoomIdRef.current = activeRoom?.id ?? null;
  const voiceOwned = voiceInput?.ownerId === voiceOwnerId;
  const voiceDisabled = !activeRoom || session?.capabilities.canSend === false || !voiceInput?.settings.enabled ||
    !voiceInput.serverSettings?.enabled || voiceInput.settingsLoading ||
    Boolean(voiceInput.ownerId && !voiceOwned) ||
    Boolean(voiceOwned && voiceInput.status !== "recording");

  useEffect(() => () => voiceInput?.cancel(voiceOwnerId), [voiceInput?.cancel, voiceOwnerId]);
  useEffect(() => {
    if (!activeRoom) voiceInput?.cancel(voiceOwnerId);
  }, [activeRoom?.id, voiceInput?.cancel, voiceOwnerId]);

  const loadSession = useCallback(async (roomId: string, showLoading = false) => {
    const sequence = ++loadSequenceRef.current;
    if (showLoading) setLoading(true);
    try {
      const next = await api.roomAgent(roomId);
      if (activeRoomIdRef.current !== roomId || loadSequenceRef.current !== sequence) return;
      roomAgentSessionCache.set(roomId, next);
      setSession(next);
      setError(null);
    } catch (loadError) {
      if (activeRoomIdRef.current !== roomId || loadSequenceRef.current !== sequence) return;
      setError(loadError instanceof Error ? loadError.message : "Room Agent is unavailable.");
    } finally {
      if (activeRoomIdRef.current === roomId && loadSequenceRef.current === sequence) setLoading(false);
    }
  }, []);

  const applySession = useCallback((roomId: string, next: RoomAgentSession) => {
    roomAgentSessionCache.set(roomId, next);
    setSession(next);
  }, []);

  const stream = useRoomAgentStream(activeRoom?.id ?? null, Boolean(activeRoom) && isDockActive, (roomId) => {
    if (activeRoomIdRef.current === roomId) void loadSession(roomId);
  });

  useEffect(() => {
    setDraft("");
    setError(null);
    setPending([]);
    sendSequenceRef.current += 1;
    stopSequenceRef.current += 1;
    clearSequenceRef.current += 1;
    roomGenerationRef.current += 1;
    setStopping(false);
    setClearing(false);
    setReplying(false);

    if (!activeRoom) {
      loadSequenceRef.current += 1;
      setSession(null);
      return;
    }
    const cached = roomAgentSessionCache.get(activeRoom.id);
    setSession(cached ?? null);
    void loadSession(activeRoom.id, !cached);
  }, [activeRoom?.id, loadSession]);

  useEffect(() => {
    if (activeRoom && refreshKey) void loadSession(activeRoom.id);
  }, [activeRoom?.id, refreshKey, loadSession]);

  const answering = session?.status === "RUNNING" || session?.status === "QUEUED";
  const roomPending = pending.filter((message) => message.roomId === activeRoom?.id);
  useEffect(() => {
    if (!activeRoom || !isDockActive) return;
    const timer = window.setInterval(() => void loadSession(activeRoom.id), answering || roomPending.length ? ANSWERING_POLL_MS : IDLE_POLL_MS);
    return () => window.clearInterval(timer);
  }, [activeRoom?.id, loadSession, answering, roomPending.length, isDockActive]);

  async function send(contentOverride?: string): Promise<boolean> {
    const typed = (contentOverride ?? draft).trim();
    const content = textToSend(typed, autocorrectSettings);
    if (!activeRoom || session?.capabilities.canSend === false || !content) return false;
    const roomId = activeRoom.id;
    const generation = roomGenerationRef.current;
    const sequence = ++sendSequenceRef.current;
    const key = JSON.stringify([roomId, content, selectedBrowserPaneId]);
    const previous = pendingRequestsRef.current.get(key);
    if (previous?.inFlight) return false;
    const request = previous ?? { roomId, content, clientRequestId: clientRequestId(), selectedBrowserPaneId, inFlight: false };
    request.inFlight = true;
    pendingRequestsRef.current.set(key, request);
    const isCurrentRoom = () => activeRoomIdRef.current === roomId && roomGenerationRef.current === generation;
    setDraft((current) => current.trim() === typed || current.trim() === content ? "" : current);
    setError(null);
    setPending((current) => [...current, { id: `pending:${request.clientRequestId}`, roomId, content, createdAt: new Date().toISOString() }]);
    try {
      let next = await api.sendRoomAgentMessage(roomId, content, request.clientRequestId, request.selectedBrowserPaneId);
      // Every playback receipt is acknowledged, even if the operator moved to another room meanwhile.
      if (!isCurrentRoom()) {
        if (next.directCommand?.music) await api.acknowledgeRoomAgentCommand(roomId, request.clientRequestId, false);
        pendingRequestsRef.current.delete(key);
        return false;
      }
      if (next.directCommand?.music) {
        const ok = await runRoomPlaybackCommand(roomId, request.clientRequestId, { type: "MUSIC", ...next.directCommand.music });
        const receipt = next.directCommand;
        next = await api.acknowledgeRoomAgentCommand(roomId, request.clientRequestId, ok);
        next.directCommand = { ...receipt, status: ok ? "COMPLETED" : "FAILED", music: undefined };
        if (!isCurrentRoom()) { pendingRequestsRef.current.delete(key); return false; }
      }
      pendingRequestsRef.current.delete(key);
      if (sequence >= latestAppliedSendRef.current) {
        latestAppliedSendRef.current = sequence;
        applySession(roomId, next);
      } else {
        // A slow older response may hold an older snapshot; read the current one.
        void loadSession(roomId);
      }
      if (next.directCommand?.status === "FAILED") {
        setError(next.messages.filter((message) => message.role === "assistant").at(-1)?.content ?? "The command could not be completed.");
        setDraft((current) => current || content);
        return false;
      }
      return true;
    } catch (sendError) {
      if (!isCurrentRoom()) return false;
      // The Room Agent is still answering (409): the request is not saved, so the next send is a new request.
      if ((sendError as { status?: number }).status === 409) pendingRequestsRef.current.delete(key);
      setError(sendError instanceof Error ? sendError.message : "The message could not be sent.");
      setDraft((current) => current || content);
      return false;
    } finally {
      request.inFlight = false;
      setPending((current) => current.filter((message) => message.id !== `pending:${request.clientRequestId}`));
    }
  }

  function submit(event?: FormEvent) {
    event?.preventDefault();
    if (event) voiceInput?.cancel(voiceOwnerId);
    void send();
  }

  function toggleVoiceCapture() {
    if (!voiceInput || !activeRoom) return;
    if (voiceOwned && voiceInput.status === "recording") {
      voiceInput.stop(voiceOwnerId);
      return;
    }
    const roomId = activeRoom.id;
    const base = draft;
    const insertMode = voiceInput.settings.insertMode;
    const compose = (text: string) => insertMode === "replace" ? text : [base.trim(), text.trim()].filter(Boolean).join("\n");
    void voiceInput.start({
      id: voiceOwnerId,
      onTranscriptDelta: (text) => {
        if (activeRoomIdRef.current === roomId) setDraft(compose(text));
      },
      onTranscriptComplete: async (text) => {
        if (activeRoomIdRef.current !== roomId) return;
        const content = compose(text);
        setDraft(content);
        if (!(await send(content))) throw new Error("Voice transcript could not be sent to the Room Agent.");
      },
      onError: (message) => {
        if (activeRoomIdRef.current === roomId) setError(message);
      }
    });
  }

  async function stop() {
    if (!activeRoom || stopping || !session?.capabilities.canStop) return;
    const roomId = activeRoom.id;
    const sequence = ++stopSequenceRef.current;
    setStopping(true);
    setError(null);
    try {
      const next = await api.stopRoomAgent(roomId, "Stopped from the Room Agent.");
      if (activeRoomIdRef.current !== roomId || stopSequenceRef.current !== sequence) return;
      applySession(roomId, next);
    } catch (stopError) {
      if (activeRoomIdRef.current !== roomId || stopSequenceRef.current !== sequence) return;
      setError(stopError instanceof Error ? stopError.message : "The Room Agent could not be stopped.");
    } finally {
      if (stopSequenceRef.current === sequence) setStopping(false);
    }
  }

  async function clearConversation() {
    if (!activeRoom || clearing || session?.capabilities.canClear === false) return;
    const roomId = activeRoom.id;
    const accepted = await confirm({
      title: "Clear Room Agent history?",
      message: "The visible conversation is cleared. Running work and saved evidence are kept.",
      confirmLabel: "Clear history"
    });
    if (!accepted || activeRoomIdRef.current !== roomId) return;
    const sequence = ++clearSequenceRef.current;
    setClearing(true);
    setError(null);
    try {
      const next = await api.clearRoomAgentTranscript(roomId);
      if (activeRoomIdRef.current !== roomId || clearSequenceRef.current !== sequence) return;
      setPending([]);
      applySession(roomId, next);
    } catch (clearError) {
      if (activeRoomIdRef.current !== roomId || clearSequenceRef.current !== sequence) return;
      setError(clearError instanceof Error ? clearError.message : "The Room Agent conversation could not be cleared.");
    } finally {
      if (clearSequenceRef.current === sequence) setClearing(false);
    }
  }

  async function setMonitor(settings: { enabled?: boolean; autopilot?: boolean }) {
    if (!activeRoom) return;
    const roomId = activeRoom.id;
    setSwitchingMonitor(true);
    try {
      const next = await api.setRoomAgentMonitor(roomId, settings);
      if (activeRoomIdRef.current === roomId) applySession(roomId, next);
    } catch (monitorError) {
      if (activeRoomIdRef.current === roomId) setError(monitorError instanceof Error ? monitorError.message : "The room monitor could not be switched.");
    } finally {
      setSwitchingMonitor(false);
    }
  }

  async function answerEvent(eventId: string, input: { answer?: string; decline?: boolean }): Promise<boolean> {
    if (!activeRoom) return false;
    const roomId = activeRoom.id;
    try {
      const next = await api.answerRoomAgentEvent(roomId, eventId, input);
      if (activeRoomIdRef.current !== roomId) return false;
      applySession(roomId, next);
      return true;
    } catch (answerError) {
      if (activeRoomIdRef.current === roomId) setError(answerError instanceof Error ? answerError.message : "The answer could not be sent.");
      return false;
    }
  }

  async function dismissEvent(eventId: string) {
    if (!activeRoom) return;
    const roomId = activeRoom.id;
    try {
      const next = await api.acknowledgeRoomAgentEvent(roomId, eventId);
      if (activeRoomIdRef.current === roomId) applySession(roomId, next);
    } catch (dismissError) {
      if (activeRoomIdRef.current === roomId) setError(dismissError instanceof Error ? dismissError.message : "The event could not be dismissed.");
    }
  }

  /** Yes and No go through the conversation like any message; Yes names the token so the server runs that action. */
  async function replyToConfirmation(token: string, yes: boolean) {
    if (replying) return;
    setReplying(true);
    try {
      await send(yes ? `Yes, go ahead (confirm ${token})` : "No");
    } finally {
      setReplying(false);
    }
  }

  function askAboutPane(item: RoomAgentPaneStripItem) {
    setDraft((current) => `@${paneStripName(item)} ${current.replace(/^@\S+\s*/, "")}`);
    composerRef.current?.focus();
  }

  const messages = session?.messages ?? [];
  const firstLoadFailed = Boolean(activeRoom && !session && error && !messages.length && !roomPending.length);
  const awaitingFirstLoad = Boolean(activeRoom && !session && !error && !roomPending.length);
  const empty = !activeRoom ? (
    <DockState kind="empty" icon={Bot} title="Select a room to talk to its Room Agent." detail="The Room Agent works inside the room you have open." />
  ) : awaitingFirstLoad ? (
    <DockState kind="loading" title="Connecting to the Room Agent…" />
  ) : firstLoadFailed ? (
    <DockState kind="error" title="The Room Agent could not be reached" detail={error}
      action={{ label: "Try again", onClick: () => { setError(null); void loadSession(activeRoom.id, true); } }} />
  ) : (
    <div className="room-agent-start">
      <DockState kind="empty" icon={Bot} title="What needs doing?" detail="Ask about the room, or tell the Room Agent what to do in its panes." />
      <div className="room-agent-suggestions" role="group" aria-label="Suggested requests">
        {suggestions.map((prompt) => (
          <button key={prompt} type="button" className="dock-kit-chip" disabled={session?.capabilities.canSend === false}
            onClick={() => { setDraft(prompt); composerRef.current?.focus(); }}>{prompt}</button>
        ))}
      </div>
    </div>
  );

  return (
    <section className="dock-panel room-agent-dock" aria-label="Room Agent chat">
      <RoomAgentHeader room={activeRoom} session={session} loading={loading} clearing={clearing}
        canClear={messages.length > 0 && session?.capabilities.canClear !== false} onClear={() => void clearConversation()}
        onAskPane={askAboutPane} onOpenPane={onOpenPane} onMonitorChange={(settings) => void setMonitor(settings)} switchingMonitor={switchingMonitor} />

      {activeRoom && session?.status === "BLOCKED" ? (
        <DockNotice tone="warning" className="room-agent-blocked">{session.statusReason}</DockNotice>
      ) : null}

      <RoomAgentTimeline
        conversationId={activeRoom?.id ?? null}
        messages={activeRoom ? messages : []}
        pending={roomPending}
        stream={stream}
        isVisible={isDockActive}
        empty={empty}
        busyReplying={replying}
        onConfirmReply={(token, yes) => void replyToConfirmation(token, yes)}
        onAnswerEvent={answerEvent}
        onDismissEvent={(eventId) => void dismissEvent(eventId)}
        onOpenPane={onOpenPane}
      />

      {error && !firstLoadFailed ? (
        <DockNotice className="room-agent-error" onDismiss={() => setError(null)}>{error}</DockNotice>
      ) : null}
      {voiceOwned && voiceInput && voiceInput.status !== "idle" ? (
        <DockNotice tone="info" className="room-agent-voice-status">
          {voiceInput.preview || (voiceInput.status === "recording" ? "Listening" : voiceInput.status === "connecting" ? "Connecting microphone" : "Transcribing")}
        </DockNotice>
      ) : null}
      <RoomAgentComposer
        composerRef={composerRef}
        draft={draft}
        onDraftChange={setDraft}
        onSubmit={submit}
        onKeyboardSend={() => { voiceInput?.cancel(voiceOwnerId); void send(); }}
        onStop={() => void stop()}
        running={Boolean(answering || session?.activeMission)}
        canSend={session?.capabilities.canSend !== false}
        canStop={Boolean(session?.capabilities.canStop)}
        stopping={stopping}
        disabled={!activeRoom}
        panes={session?.paneStrip ?? []}
        voice={voiceInput ? { active: Boolean(voiceOwned && voiceInput.status === "recording"), disabled: Boolean(voiceDisabled), onClick: toggleVoiceCapture,
          onPrewarm: voiceInput.prewarm } : undefined}
      />
      {confirmDialog}
    </section>
  );
}
