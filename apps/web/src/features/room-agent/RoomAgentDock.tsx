import { Bot, CircleStop, MessageSquareX, Pause, Play, Send } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import type { Room, RoomAgentSession, RoomAgentTaskResult } from "@space/contracts";
import { api } from "../../api.js";

interface RoomAgentDockProps {
  activeRoom: Room | null;
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

function TaskMetricsCard({ result }: { result: RoomAgentTaskResult }) {
  const score = result.combinedScore ?? result.reliabilityScore;
  return (
    <article className={`room-agent-task-card is-${result.state.toLowerCase().replace("_", "-")}`} role="group" tabIndex={0} aria-label={`${result.label} task metrics`}>
      <header><strong>{result.label}</strong><span>{result.state.replace("_", " ")}</span></header>
      <div className="room-agent-task-score"><strong>{Math.round(score)}/100</strong><small>{result.combinedScore === null ? "Reliability" : "Combined quality"}</small></div>
      <dl>
        <div><dt>Quality</dt><dd>{result.qualityScore === null ? "Unavailable" : `${Math.round(result.qualityScore)}/100`}</dd></div>
        <div><dt>Queue</dt><dd>{durationLabel(result.queueMs)}</dd></div>
        <div><dt>First response</dt><dd>{result.firstResponseMs === null ? "N/A" : durationLabel(result.firstResponseMs)}</dd></div>
        <div><dt>Execution</dt><dd>{durationLabel(result.executionMs)}</dd></div>
        <div><dt>Total</dt><dd>{durationLabel(result.totalMs)}</dd></div>
        <div><dt>Retries</dt><dd>{result.retries}</dd></div>
        <div><dt>Recoveries / stalls</dt><dd>{result.recoveries} / {result.stalls}</dd></div>
      </dl>
      {result.rubric ? (
        <dl className="room-agent-task-rubric" role="group" aria-label="AI quality rubric">
          <div><dt>Correctness · 30%</dt><dd>{Math.round(result.rubric.correctness)}</dd></div>
          <div><dt>Completeness · 25%</dt><dd>{Math.round(result.rubric.completeness)}</dd></div>
          <div><dt>Instruction adherence · 20%</dt><dd>{Math.round(result.rubric.instructionAdherence)}</dd></div>
          <div><dt>Evidence · 15%</dt><dd>{Math.round(result.rubric.evidence)}</dd></div>
          <div><dt>Clarity · 10%</dt><dd>{Math.round(result.rubric.clarity)}</dd></div>
        </dl>
      ) : <small>{result.qualityUnavailableReason ?? "Quality unavailable"}</small>}
      <p>{result.modelId ?? "Runtime default"} · {result.reasoningEffort ?? "default reasoning"}</p>
      <small>{result.verificationSummary}</small>
    </article>
  );
}

export function RoomAgentDock({ activeRoom, refreshKey = null }: RoomAgentDockProps) {
  const [session, setSession] = useState<RoomAgentSession | null>(null);
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [controlling, setControlling] = useState<"PAUSE" | "RESUME" | null>(null);
  const [clearing, setClearing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const activeRoomIdRef = useRef<string | null>(activeRoom?.id ?? null);
  const loadSequenceRef = useRef(0);
  const sendSequenceRef = useRef(0);
  const stopSequenceRef = useRef(0);
  const controlSequenceRef = useRef(0);
  const clearSequenceRef = useRef(0);
  const pendingRequestRef = useRef<{ roomId: string; content: string; clientRequestId: string } | null>(null);
  activeRoomIdRef.current = activeRoom?.id ?? null;
  const visibleMessages = useMemo(
    () => session?.messages.filter((message) => message.role === "user" || message.role === "assistant") ?? [],
    [session?.messages]
  );
  const transcriptItems = useMemo(() => [
    ...visibleMessages.map((message) => ({ type: "message" as const, at: message.createdAt ?? "", message })),
    ...(session?.taskResults ?? []).map((result) => ({ type: "task" as const, at: result.completedAt ?? "9999", result }))
  ].sort((left, right) => left.at.localeCompare(right.at)), [session?.taskResults, visibleMessages]);

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
      if (showLoading && activeRoomIdRef.current === roomId && loadSequenceRef.current === sequence) setLoading(false);
    }
  }, []);

  useEffect(() => {
    setDraft("");
    setError(null);
    sendSequenceRef.current += 1;
    stopSequenceRef.current += 1;
    controlSequenceRef.current += 1;
    clearSequenceRef.current += 1;
    setSending(false);
    setStopping(false);
    setControlling(null);
    setClearing(false);
    pendingRequestRef.current = null;
    if (!activeRoom) {
      loadSequenceRef.current += 1;
      setSession(null);
      return;
    }
    setSession(null);
    void loadSession(activeRoom.id, true);
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

  async function submit(event?: FormEvent) {
    event?.preventDefault();
    if (!activeRoom || sending || !draft.trim()) return;
    const roomId = activeRoom.id;
    const sequence = ++sendSequenceRef.current;
    const content = draft.trim();
    const pending = pendingRequestRef.current;
    const request = pending?.roomId === roomId && pending.content === content
      ? pending
      : { roomId, content, clientRequestId: clientRequestId() };
    pendingRequestRef.current = request;
    setSending(true);
    setError(null);
    try {
      const next = await api.sendRoomAgentMessage(roomId, content, request.clientRequestId);
      if (pendingRequestRef.current?.clientRequestId === request.clientRequestId) pendingRequestRef.current = null;
      if (activeRoomIdRef.current !== roomId || sendSequenceRef.current !== sequence) return;
      setSession(next);
      setDraft("");
    } catch (sendError) {
      if (activeRoomIdRef.current !== roomId || sendSequenceRef.current !== sequence) return;
      setError(sendError instanceof Error ? sendError.message : "The prompt could not be queued.");
    } finally {
      if (sendSequenceRef.current === sequence) setSending(false);
    }
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
    void submit();
  }

  return (
    <section className="dock-panel room-agent-dock" aria-label="Room Agent chat">
      <header className="room-agent-head">
        <span className="room-agent-mark" aria-hidden="true"><Bot /></span>
        <span>
          <h2>Room Agent</h2>
          <small>Persistent room supervisor</small>
        </span>
        <span className="room-agent-head-actions">
          <span className={`room-agent-status is-${(session?.status ?? "IDLE").toLowerCase()}`}>
            {loading ? "Loading" : session?.status ?? "Idle"}
          </span>
          <button
            type="button"
            className="room-agent-clear"
            onClick={() => void clearConversation()}
            disabled={!activeRoom || clearing || session?.capabilities.canClear === false}
            aria-label="Clear Room Agent history"
            title="Clear visible Room Agent history"
          >
            <MessageSquareX aria-hidden="true" />
          </button>
        </span>
      </header>

      {activeRoom ? (
        <div className="room-agent-goal" role="status" aria-live="polite">
          <div className="room-agent-goal-summary">
            <span>{session?.statusReason ?? (loading ? "Connecting to the room supervisor…" : "Room Agent is ready.")}</span>
            {session?.activeMission ? <strong>{session.activeMission.status}</strong> : null}
          </div>
          {session?.activeMission ? (
            <div className="room-agent-goal-metrics" aria-label="Room Agent goal statistics">
              <span><strong>{durationLabel(session.progress?.elapsedMs ?? 0)}</strong><small>Elapsed</small></span>
              <span><strong>{session.progress?.completedSteps ?? 0} / {session.progress?.totalSteps ?? 0} complete</strong><small>Plans</small></span>
              <span><strong>{session.activePaneIds?.length ?? 0} active panes</strong><small>Now</small></span>
              <span><strong>Peak {session.progress?.peakConcurrency ?? 0}</strong><small>Concurrency</small></span>
            </div>
          ) : (
            <div className="room-agent-goal-metrics" aria-label="Room plan statistics">
              <span><strong>{session?.roomInventory?.pendingPlans ?? 0} pending</strong><small>Plans</small></span>
              <span><strong>{session?.roomInventory?.pausedPlans ?? 0} paused</strong><small>Recovery</small></span>
              <span><strong>{session?.roomInventory?.runningPlans ?? 0} running</strong><small>Now</small></span>
              <span><strong>{session?.roomInventory?.totalPanes ?? 0} pane tasks</strong><small>Room</small></span>
            </div>
          )}
        </div>
      ) : null}

      <div className="room-agent-transcript" ref={transcriptRef} aria-label="Room Agent transcript">
        {!activeRoom ? (
          <div className="room-agent-empty"><Bot aria-hidden="true" /><span>Select a room to supervise it.</span></div>
        ) : transcriptItems.length ? (
          transcriptItems.map((item) => item.type === "message" ? (
            <article key={item.message.id} className={`room-agent-message is-${item.message.role}`}>
              <header>
                <strong>{item.message.role === "user" ? "You" : "Room Agent"}</strong>
                <time dateTime={item.message.createdAt ?? undefined}>{messageTime(item.message.createdAt)}</time>
              </header>
              <p>{item.message.content}</p>
            </article>
          ) : <TaskMetricsCard key={`task:${item.result.stepId}`} result={item.result} />)
        ) : (
          <div className="room-agent-empty"><Bot aria-hidden="true" /><span>Give the Room Agent a task for this room.</span></div>
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

      {error ? <p className="room-agent-error" role="alert">{error}</p> : null}

      <form className="room-agent-composer" onSubmit={(event) => void submit(event)}>
        <label htmlFor="room-agent-message">Message Room Agent</label>
        <textarea
          id="room-agent-message"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={handleComposerKeyDown}
          placeholder={activeRoom ? "Assign room work or add a follow-up…" : "Select a room first"}
          disabled={!activeRoom || sending}
          rows={3}
        />
        <div className="room-agent-composer-actions">
          <span className="room-agent-run-controls">
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
            <button
              type="button"
              className="room-agent-stop"
              onClick={() => void stop()}
              disabled={!activeRoom || stopping || controlling !== null || !session?.capabilities.canStop}
              aria-label="Stop Room Agent"
            >
              <CircleStop aria-hidden="true" />
              <span>{stopping ? "Stopping" : "Stop"}</span>
            </button>
          </span>
          <button
            type="submit"
            className="room-agent-send"
            disabled={!activeRoom || sending || !draft.trim() || session?.capabilities.canSend === false}
            aria-label="Send to Room Agent"
          >
            <Send aria-hidden="true" />
            <span>{sending ? "Queueing" : "Send"}</span>
          </button>
        </div>
      </form>
    </section>
  );
}
