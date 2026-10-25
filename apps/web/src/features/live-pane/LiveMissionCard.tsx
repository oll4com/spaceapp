import { useEffect, useRef, useState } from "react";
import { readLiveMission, runLiveMissionAction, type LiveMissionSnapshot } from "./live-missions.js";

const pollMs = { active: 3000, idle: 10000 };
const isActive = (snapshot: LiveMissionSnapshot | null) => Boolean(snapshot && ["QUEUED", "RUNNING", "PAUSED"].includes(snapshot.mission.status));

export function LiveMissionCard({ roomId, className = "" }: { roomId?: string; className?: string }) {
  const [view, setView] = useState<{ roomId?: string; snapshot: LiveMissionSnapshot | null; error: string | null; loaded: boolean }>({ snapshot: null, error: null, loaded: false });
  const [goal, setGoal] = useState("");
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<{ roomId: string; message: string } | null>(null);
  const [refresh, setRefresh] = useState(0);
  const generation = useRef(0);
  const busyRef = useRef(false);
  const activeRoom = useRef(roomId);
  activeRoom.current = roomId;
  const mounted = useRef(true);
  const startRequest = useRef<{ roomId: string; goal: string; id: string } | null>(null);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { setGoal(""); setBusy(false); busyRef.current = false; startRequest.current = null; setActionError(null); }, [roomId]);

  useEffect(() => {
    if (!roomId || roomId === "global") return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      if (busyRef.current) { timer = setTimeout(() => { void load(); }, pollMs.active); return; }
      const revision = ++generation.current;
      let snapshot: LiveMissionSnapshot | null = null;
      try {
        snapshot = await readLiveMission(roomId);
        if (!disposed && revision === generation.current) setView({ roomId, snapshot, error: null, loaded: true });
      } catch (error) {
        if (!disposed && revision === generation.current) setView(previous => ({ roomId,
          snapshot: previous.roomId === roomId ? previous.snapshot : null, loaded: true,
          error: error instanceof Error ? error.message : "Mission status is unavailable." }));
      } finally {
        if (!disposed) timer = setTimeout(() => { void load(); }, isActive(snapshot) ? pollMs.active : pollMs.idle);
      }
    };
    void load();
    return () => { disposed = true; generation.current++; if (timer) clearTimeout(timer); };
  }, [roomId, refresh]);

  const current = view.roomId === roomId ? view : { snapshot: null, error: null, loaded: false };
  const snapshot = current.snapshot;
  const active = isActive(snapshot);
  const act = async (action: "start" | "pause" | "resume" | "cancel") => {
    if (!roomId || busyRef.current || !current.loaded || current.error) return;
    busyRef.current = true;
    setBusy(true);
    generation.current++;
    try {
      if (action === "start" && (startRequest.current?.goal !== goal || startRequest.current?.roomId !== roomId)) {
        startRequest.current = { roomId, goal, id: crypto.randomUUID() };
      }
      const result = await runLiveMissionAction({ roomId, action, goal, callId: startRequest.current?.id, provider: "ui", expectedMissionId: snapshot?.mission.id });
      if (mounted.current && activeRoom.current === roomId) {
        generation.current++;
        setView({ roomId, snapshot: result.snapshot, error: null, loaded: true });
        setActionError(null);
        if (action === "start") setGoal("");
        setRefresh(value => value + 1);
      }
    } catch (error) {
      if (mounted.current && activeRoom.current === roomId) setActionError({
        roomId, message: error instanceof Error ? error.message : "Mission request failed. Refresh before retrying."
      });
    } finally {
      if (mounted.current && activeRoom.current === roomId) { busyRef.current = false; setBusy(false); }
    }
  };

  if (!roomId || roomId === "global") return <section className={`live-mission-card ${className}`}>Select a room to use durable missions.</section>;
  const status = snapshot?.mission.status === "COMPLETED" && !snapshot.completionVerified ? "NEEDS VERIFICATION" : snapshot?.mission.status;
  const disabled = busy || !current.loaded || Boolean(current.error);
  return (
    <section className={`live-mission-card ${className}`} aria-label="Durable mission">
      <div className="live-mission-card-header">
        <strong>Mission &amp; TODO</strong>
        <span>{status ?? (current.loaded ? "No mission" : "Loading…")}</span>
        <button type="button" disabled={busy} onClick={() => { setActionError(null); setRefresh(value => value + 1); }}>Refresh mission</button>
      </div>
      <p>Progress is stored on the server and remains available after voice disconnects.</p>
      {current.error && <p role="alert">{current.error} Displayed progress may be stale.</p>}
      {actionError?.roomId === roomId && <p role="alert">{actionError.message}</p>}
      {snapshot && <>
        <h4>{snapshot.objective ?? "Room Agent mission"}</h4>
        <p>{snapshot.mission.statusReason}</p>
        {snapshot.steps.length > 0 && <>
          <p>Recorded steps: {snapshot.stepCount}</p>
          <ol>{snapshot.steps.map(step => <li key={step.stepId}>
            <strong>{step.label}</strong> — {step.status}
            <div>{step.verificationSummary}</div>
          </li>)}</ol>
          {snapshot.stepsTruncated && <p>Showing the latest {snapshot.steps.length} recorded steps.</p>}
        </>}
        <details open={snapshot.steps.length === 0}>
          <summary>Recorded actions: {snapshot.actionCount}</summary>
          {snapshot.actions.length === 0 ? <p>No execution receipts have been recorded yet.</p> : <ol>
            {snapshot.actions.map(action => <li key={action.actionId}>
              <strong>{action.actionType}</strong> — {action.status}
              <div>{action.statusReason}</div>
              {action.controlOperationId && <small>Operation: {action.controlOperationId}</small>}
            </li>)}
          </ol>}
          {snapshot.actionsTruncated && <p>Showing the latest {snapshot.actions.length} actions.</p>}
        </details>
        {active && <div className="live-mission-controls">
          {["RUNNING", "QUEUED"].includes(snapshot.mission.status) && <button type="button" disabled={disabled} onClick={() => { void act("pause"); }}>Pause mission</button>}
          {snapshot.mission.status === "PAUSED" && <button type="button" disabled={disabled} onClick={() => { void act("resume"); }}>Resume mission</button>}
          <button type="button" disabled={disabled} onClick={() => { void act("cancel"); }}>Stop mission</button>
        </div>}
      </>}
      {!active && <form onSubmit={event => { event.preventDefault(); void act("start"); }}>
        <label>Mission goal<textarea value={goal} maxLength={4000} disabled={busy} onChange={event => setGoal(event.target.value)} /></label>
        <button type="submit" disabled={disabled || !goal.trim()}>Start mission</button>
      </form>}
    </section>
  );
}
