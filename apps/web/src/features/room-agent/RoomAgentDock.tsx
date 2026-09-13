import { runRoomPlaybackCommand } from "./room-playback-control.js";
import { Bot, CircleStop, MessageSquareX, Pause, Play, Send } from "../ui-theme/app-icons.js";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import type { Room, RoomAgentSession } from "@space/contracts";
import { api } from "../../api.js";
import { useOptionalVoiceInput } from "../voice-input/VoiceInputProvider.js";
import { VoiceInputButton } from "../voice-input/VoiceInputButton.js";

interface RoomAgentDockProps {
  activeRoom: Room | null;
  isCodexEnabled?: boolean;
  selectedBrowserPaneId?: string;
  refreshKey?: string | null;
}

function clientRequestId(): string {
  const suffix = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `room-agent-web:${suffix}`;
}

function messageTime(value: string | null): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(date);
}

function durationLabel(value: number): string {
  const totalSeconds = Math.max(0, Math.floor(value / 1_000));
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  return [hours ? `${hours}h` : null, minutes || hours ? `${minutes}m` : null, `${seconds}s`].filter(Boolean).join(" ");
}

export function RoomAgentDock({
  activeRoom,
  selectedBrowserPaneId,
  refreshKey = null
}: RoomAgentDockProps) {
  const voiceInput = useOptionalVoiceInput();
  const voiceOwnerId = `room-agent:${activeRoom?.id ?? "none"}`;
  const [session, setSession] = useState<RoomAgentSession | null>(null);
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(false);
  const [pendingCount, setPendingCount] = useState(0);
  const [stopping, setStopping] = useState(false);
  const [controlling, setControlling] = useState<"PAUSE" | "RESUME" | null>(null);
  const [clearing, setClearing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const activeRoomIdRef = useRef<string | null>(activeRoom?.id ?? null);
  const loadSequenceRef = useRef(0);
  const sendSequenceRef = useRef(0);
  const latestAppliedSendRef = useRef(0);
  const stopSequenceRef = useRef(0);
  const controlSequenceRef = useRef(0);
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
  const visibleMessages = useMemo(
    () => session?.messages.filter((message) => message.role === "user" || message.role === "assistant") ?? [],
    [session?.messages]
  );


  const loadSession = useCallback(async (roomId: string, showLoading = false) => {
    const sequence = ++loadSequenceRef.current;
    if (showLoading) setLoading(true);
    try {
      const next = await api.roomAgent(roomId);
      if (activeRoomIdRef.current !== roomId || loadSequenceRef.current !== sequence) return;
      setSession(next);
      setError(null);
    } catch (loadError) {
      if (activeRoomIdRef.current !== roomId || loadSequenceRef.current !== sequence) return;
      setError(loadError instanceof Error ? loadError.message : "Room Agent is unavailable.");
    } finally {
      if (activeRoomIdRef.current === roomId && loadSequenceRef.current === sequence) setLoading(false);
    }
  }, []);

  useEffect(() => {
    setDraft("");
    setError(null);
    sendSequenceRef.current += 1;
    stopSequenceRef.current += 1;
    controlSequenceRef.current += 1;
    clearSequenceRef.current += 1;
    roomGenerationRef.current += 1;
    setPendingCount(0);
    setStopping(false);
    setControlling(null);
    setClearing(false);

    if (!activeRoom) {
      loadSequenceRef.current += 1;
      setSession(null);
      return;
    }
    setSession(null);
    void loadSession(activeRoom.id, true);
  }, [activeRoom?.id, loadSession]);

  useEffect(() => {
    if (activeRoom && refreshKey) void loadSession(activeRoom.id);
  }, [activeRoom?.id, refreshKey, loadSession]);

  useEffect(() => {
    if (!activeRoom) return;
    const active = ["RUNNING", "PAUSED", "RECOVERING", "QUEUED"].includes(session?.status ?? "IDLE");
    const timer = window.setInterval(() => void loadSession(activeRoom.id), active ? 1_500 : 3_000);
    return () => window.clearInterval(timer);
  }, [activeRoom?.id, loadSession, session?.status]);

  useEffect(() => {
    const transcript = transcriptRef.current;
    if (transcript) transcript.scrollTop = transcript.scrollHeight;
  }, [visibleMessages.length, session?.statusReason]);

  async function submit(event?: FormEvent, contentOverride?: string): Promise<boolean> {
    event?.preventDefault();
    const content = (contentOverride ?? draft).trim();
    if (!activeRoom || session?.capabilities.canSend === false || !content) return false;
    const roomId = activeRoom.id;
    const generation = roomGenerationRef.current;
    const sequence = ++sendSequenceRef.current;
    const key = JSON.stringify([roomId, content, selectedBrowserPaneId]);
    const pending = pendingRequestsRef.current.get(key);
    if (pending?.inFlight) return false;
    const request = pending ?? { roomId, content, clientRequestId: clientRequestId(), selectedBrowserPaneId, inFlight: false };
    request.inFlight = true;
    pendingRequestsRef.current.set(key, request);
    const isCurrentRoom = () => activeRoomIdRef.current === roomId && roomGenerationRef.current === generation;
    setPendingCount(count => count + 1);
    if (event) voiceInput?.cancel(voiceOwnerId);
    setDraft(current => current.trim() === content ? "" : current);
    setError(null);
    try {
      let next = await api.sendRoomAgentMessage(roomId, content, request.clientRequestId, request.selectedBrowserPaneId);
      // Every command receipt is handled, even if a later independent request finished first.
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
        setSession(next);
      } else {
        // A slow older response may contain an older snapshot; fetch current durable state.
        void loadSession(roomId);
      }
      if (next.directCommand?.status === "FAILED") {
        setError(next.messages.filter(message => message.role === "assistant").at(-1)?.content ?? "The command could not be completed.");
        setDraft(current => current || content);
        return false;
      }
      return true;
    } catch (sendError) {
      if (!isCurrentRoom()) return false;
      setError(sendError instanceof Error ? sendError.message : "The prompt could not be queued.");
      setDraft(current => current || content);
      return false;
    } finally {
      request.inFlight = false;
      if (isCurrentRoom()) setPendingCount(count => Math.max(0, count - 1));
    }
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
        if (!(await submit(undefined, content))) throw new Error("Voice transcript could not be sent to the Room Agent.");
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
      const next = await api.stopRoomAgent(roomId, "Stopped from the Room Agent dock.");
      if (activeRoomIdRef.current !== roomId || stopSequenceRef.current !== sequence) return;
      setSession(next);
    } catch (stopError) {
      if (activeRoomIdRef.current !== roomId || stopSequenceRef.current !== sequence) return;
      setError(stopError instanceof Error ? stopError.message : "The Room Agent could not be stopped.");
    } finally {
      if (stopSequenceRef.current === sequence) setStopping(false);
    }
  }

  async function control(action: "PAUSE" | "RESUME") {
    if (!activeRoom || controlling || stopping) return;
    if (action === "PAUSE" && !session?.capabilities.canPause) return;
    if (action === "RESUME" && !session?.capabilities.canResume) return;
    const roomId = activeRoom.id;
    const sequence = ++controlSequenceRef.current;
    setControlling(action);
    setError(null);
    try {
      const next = await api.controlRoomAgent(
        roomId,
        action === "PAUSE" ? { action, reason: "Paused from the Room Agent dock." } : { action }
      );
      if (activeRoomIdRef.current !== roomId || controlSequenceRef.current !== sequence) return;
      setSession(next);
    } catch (controlError) {
      if (activeRoomIdRef.current !== roomId || controlSequenceRef.current !== sequence) return;
      setError(controlError instanceof Error ? controlError.message : `The Room Agent could not ${action.toLowerCase()}.`);
    } finally {
      if (controlSequenceRef.current === sequence) setControlling(null);
    }
  }

  async function clearConversation() {
    if (!activeRoom || clearing || session?.capabilities.canClear === false) return;
    if (!window.confirm("Clear the visible Room Agent history? The active goal and its durable evidence will be preserved.")) return;
    const roomId = activeRoom.id;
    const sequence = ++clearSequenceRef.current;
    setClearing(true);
    setError(null);
    try {
      const next = await api.clearRoomAgentTranscript(roomId);
      if (activeRoomIdRef.current !== roomId || clearSequenceRef.current !== sequence) return;
      setSession(next);
    } catch (clearError) {
      if (activeRoomIdRef.current !== roomId || clearSequenceRef.current !== sequence) return;
      setError(clearError instanceof Error ? clearError.message : "The Room Agent conversation could not be cleared.");
    } finally {
      if (clearSequenceRef.current === sequence) setClearing(false);
    }
  }

  function handleComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    voiceInput?.cancel(voiceOwnerId);
    void submit();
  }


  return (
    <section className="dock-panel room-agent-dock" aria-label="Room Agent chat">
      <header className="room-agent-head">
        <span className={`room-agent-status is-${(session?.status ?? "IDLE").toLowerCase()}`} role="status">
          {loading ? "Connecting…" : session?.status === "IDLE" || !session ? "Ready" : session.status.replaceAll("_", " ").toLowerCase()}
        </span>
        <span className="room-agent-room-name" title={activeRoom?.name}>{activeRoom?.name ?? "No room selected"}</span>
        <button
          type="button"
          className="room-agent-clear"
          onClick={() => void clearConversation()}
          disabled={!activeRoom || clearing || !visibleMessages.length || session?.capabilities.canClear === false}
          aria-label="Clear Room Agent history"
          title="Clear visible Room Agent history"
        >
          <MessageSquareX aria-hidden="true" />
        </button>
      </header>

      {pendingCount > 0 ? <p role="status" className="room-agent-pending">{pendingCount} request{pendingCount === 1 ? "" : "s"} pending</p> : null}

      {activeRoom && session ? (
        <div className="room-agent-goal">
          {session.activeMission || session.status !== "IDLE" ? (
            <p className="room-agent-goal-summary" role="status">{session.statusReason ?? "Working on your request…"}</p>
          ) : null}
          {session.activeMission ? (
            <div className="room-agent-goal-metrics" aria-label="Room Agent goal statistics">
              <span>{session.progress?.completedSteps ?? 0} / {session.progress?.totalSteps ?? 0} complete</span>
              <span>{session.activePaneIds?.length ?? 0} active panes</span>
              <span>{durationLabel(session.progress?.elapsedMs ?? 0)}</span>
              <span>Peak {session.progress?.peakConcurrency ?? 0}</span>
            </div>
          ) : (
            <div className="room-agent-goal-metrics" aria-label="Room plan statistics">
              <span>{session.roomInventory?.totalPanes ?? 0} panes</span>
              {(session.roomInventory?.pendingPlans ?? 0) > 0 ? <span>{session.roomInventory!.pendingPlans} pending</span> : null}
              {(session.roomInventory?.pausedPlans ?? 0) > 0 ? <span>{session.roomInventory!.pausedPlans} paused</span> : null}
              {(session.roomInventory?.runningPlans ?? 0) > 0 ? <span>{session.roomInventory!.runningPlans} running</span> : null}
            </div>
          )}
          {(session.queuedMissionCount ?? 0) > 0 ? <small>{session.queuedMissionCount} queued</small> : null}
        </div>
      ) : null}

      <div className="room-agent-transcript" ref={transcriptRef} aria-label="Room Agent transcript">
        {!activeRoom ? (
          <div className="room-agent-empty"><Bot aria-hidden="true" /><span>Select a room to supervise it.</span></div>
        ) : visibleMessages.length ? (
          visibleMessages.map((message) => (
            <article key={message.id} className={`room-agent-message is-${message.role}`}>
              <header>
                <strong>{message.role === "user" ? "You" : "Room Agent"}</strong>
                <time dateTime={message.createdAt ?? undefined}>{messageTime(message.createdAt)}</time>
              </header>
              <p>{message.content}</p>
            </article>
          ))
        ) : (
          <div className="room-agent-empty">
            <Bot aria-hidden="true" />
            <strong>What needs doing?</strong>
            <span>Give the Room Agent a task for this room.</span>
            <div className="room-agent-suggestions" aria-label="Suggested requests">
              {[
                ["Check progress", "Check the progress of this room's tasks and tell me what needs attention."],
                ["Continue pending work", "Continue the pending plans in this room and report what you complete."]
              ].map(([label, prompt]) => (
                <button key={label} type="button" disabled={session?.capabilities.canSend === false}
                  onClick={() => { setDraft(prompt!); composerRef.current?.focus(); }}>{label}</button>
              ))}
            </div>
          </div>
        )}
        {session?.missionSummary ? (
          <section className="room-agent-mission-report" aria-label="Room Agent mission report">
            <header><strong>Mission report</strong><span>{Math.round(session.missionSummary.successRate)}% success</span></header>
            <p>
              {session.missionSummary.completedTasks}/{session.missionSummary.totalTasks} completed · Peak {session.missionSummary.peakConcurrency} · {durationLabel(session.missionSummary.totalMs)} total
            </p>
            <small>
              Combined quality {session.missionSummary.averageQuality === null ? "unavailable" : `${Math.round(session.missionSummary.averageQuality)}/100 avg (${Math.round(session.missionSummary.minQuality ?? 0)}–${Math.round(session.missionSummary.maxQuality ?? 0)})`} · First response {session.missionSummary.averageFirstResponseMs === null ? "N/A" : `${durationLabel(session.missionSummary.averageFirstResponseMs)} avg`} · {session.missionSummary.retries} retries · {session.missionSummary.stalls} stalls · {session.missionSummary.blockedTasks} blocked
            </small>
          </section>
        ) : null}
      </div>

      {session && (session.capabilities.canPause || session.capabilities.canResume || session.capabilities.canStop) ? (
          <div className="room-agent-run-controls" aria-label="Task controls">
            {session?.capabilities.canPause ? (
              <button
                type="button"
                className="room-agent-pause"
                onClick={() => void control("PAUSE")}
                disabled={!activeRoom || controlling !== null || stopping}
                aria-label="Pause Room Agent"
              >
                <Pause aria-hidden="true" />
                <span>{controlling === "PAUSE" ? "Pausing" : "Pause"}</span>
              </button>
            ) : null}
            {session?.capabilities.canResume ? (
              <button
                type="button"
                className="room-agent-resume"
                onClick={() => void control("RESUME")}
                disabled={!activeRoom || controlling !== null || stopping}
                aria-label="Resume Room Agent"
              >
                <Play aria-hidden="true" />
                <span>{controlling === "RESUME" ? "Resuming" : "Resume"}</span>
              </button>
            ) : null}
            {session?.capabilities.canStop ? <button
              type="button"
              className="room-agent-stop"
              onClick={() => void stop()}
              disabled={!activeRoom || stopping || controlling !== null || !session?.capabilities.canStop}
              aria-label="Stop Room Agent"
            >
              <CircleStop aria-hidden="true" />
              <span>{stopping ? "Stopping" : "Stop"}</span>
            </button> : null}
          </div>
      ) : null}

      {error ? <p className="room-agent-error" role="alert">{error}</p> : null}
      {voiceOwned && voiceInput && voiceInput.status !== "idle" ? (
        <p className="room-agent-voice-status" role="status">
          {voiceInput.preview || (voiceInput.status === "recording" ? "Listening" : voiceInput.status === "connecting" ? "Connecting microphone" : "Transcribing")}
        </p>
      ) : null}

      <form className="room-agent-composer" onSubmit={(event) => void submit(event)}>
        <label className="room-agent-composer-label" htmlFor="room-agent-message">Message Room Agent</label>
        <textarea
          id="room-agent-message"
          ref={composerRef}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={handleComposerKeyDown}
          placeholder={activeRoom ? "What would you like to do?" : "Select a room first"}
          disabled={!activeRoom}
          rows={2}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="none"
          spellCheck={false}
          enterKeyHint="send"
          data-gramm="false"
          data-enable-grammarly="false"
        />
        <div className="room-agent-composer-actions">
          {voiceInput ? <VoiceInputButton label="Room Agent" active={Boolean(voiceOwned && voiceInput.status === "recording")} disabled={Boolean(voiceDisabled)} onClick={toggleVoiceCapture} onPrewarm={voiceInput.prewarm} /> : null}

          <span className="room-agent-composer-hint">Enter to send</span>
          <button
            type="submit"
            className="room-agent-send"
            disabled={!activeRoom || !draft.trim() || session?.capabilities.canSend === false}
            aria-label="Send to Room Agent"
            >
            <Send aria-hidden="true" />
            <span>Send</span>
          </button>
        </div>
      </form>
    </section>
  );
}
