import { useEffect, useRef, useState, useCallback } from "react";
import { LiveStatsWindow } from "./LiveStatsWindow.js";
import { useLiveCoordinator, useLiveSessionState } from "./LiveSessionProvider.js";

export function LiveRailSession() {
  const coordinator = useLiveCoordinator();
  const state = useLiveSessionState();
  const [roomOnly, setRoomOnly] = useState(false);
  const transcripts = (state?.transcripts ?? []).filter(item => !roomOnly || item.roomId === state?.roomId);
  const [conversationOpen, setConversationOpen] = useState(false);
  const [conversationPosition, setConversationPosition] = useState(() => ({ left: window.innerWidth <= 768 ? 8 : 280, top: window.innerWidth <= 768 ? 8 : 120 }));
  const [statsOpen, setStatsOpen] = useState(false);
  const [statsPosition, setStatsPosition] = useState({ left: 340, top: 140 });
  const conversationBodyRef = useRef<HTMLDivElement | null>(null);
  const shouldFollowTranscriptRef = useRef(true);
  const dragRef = useRef<{ offsetX: number; offsetY: number; width: number; height: number } | null>(null);
  const handleClearConversation = useCallback(() => {
    if (roomOnly && coordinator?.getSnapshot().roomId) {
      void coordinator.clearRoom(coordinator.getSnapshot().roomId!);
    } else {
      void coordinator?.clearAll();
    }
  }, [coordinator, roomOnly]);
  useEffect(() => {
    const conversation = () => setConversationOpen(open => !open);
    const stats = () => setStatsOpen(open => !open);
    window.addEventListener("space-live-rail-conversation-toggle", conversation);
    window.addEventListener("space-live-rail-stats-toggle", stats);
    window.addEventListener("space-live-rail-clear-conversation", handleClearConversation);
    return () => {
      window.removeEventListener("space-live-rail-conversation-toggle", conversation);
      window.removeEventListener("space-live-rail-stats-toggle", stats);
      window.removeEventListener("space-live-rail-clear-conversation", handleClearConversation);
    };
  }, [handleClearConversation]);
  useEffect(() => {
    if (!conversationOpen || !shouldFollowTranscriptRef.current) return;
    const body = conversationBodyRef.current;
    if (body) body.scrollTop = body.scrollHeight;
  }, [conversationOpen, transcripts]);

  useEffect(() => {
    const move = (event: PointerEvent) => {
      if (!dragRef.current) return;
      const { width, height } = dragRef.current;
      setConversationPosition({
        left: Math.max(8, Math.min(window.innerWidth - width - 8, event.clientX - dragRef.current.offsetX)),
        top: Math.max(8, Math.min(window.innerHeight - height - 8, event.clientY - dragRef.current.offsetY))
      });
    };
    const end = () => { dragRef.current = null; };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
    };
  }, []);

  return (
    <>
      {conversationOpen ? (
        <section className="live-rail-conversation-window" aria-label="Live voice conversation" style={{ left: conversationPosition.left, top: conversationPosition.top }}>
          <header className="live-rail-conversation-header" onPointerDown={(event) => {
            if ((event.target as HTMLElement).closest("button")) return;
            const rect = event.currentTarget.parentElement?.getBoundingClientRect();
            if (rect) dragRef.current = {
              offsetX: event.clientX - rect.left,
              offsetY: event.clientY - rect.top,
              width: rect.width,
              height: rect.height
            };
          }}>
            <strong>Live · {state?.roomName || "No active room"}</strong>
            <div style={{ display: "flex", gap: "6px", alignItems: "center" }}>
              <button
                type="button"
                className="live-rail-clear-btn"
                title={roomOnly ? "Clear this room conversation" : "Clear conversation"}
                aria-label="Clear conversation"
                onClick={handleClearConversation}
              >
                Clear
              </button>
              <button type="button" aria-label="Close Live conversation" onClick={() => setConversationOpen(false)}>×</button>
            </div>
          </header>
          <div className="live-rail-session-controls">
            <span role="status">{state?.contextState === "ready" ? state.status : state?.enabled ? "Updating room context…" : "Disconnected"}</span>
            <button type="button" onClick={() => coordinator?.setMuted(!state?.muted)}>{state?.muted ? "Unmute" : "Mute"}</button>
            <button type="button" onClick={() => coordinator?.toggle()}>{state?.enabled ? "Disconnect" : "Connect"}</button>
            <label><input type="checkbox" checked={roomOnly} onChange={event => setRoomOnly(event.target.checked)} />This room only</label>
            {state?.error ? <p role="alert">{state.error}</p> : null}
          </div>
          <div className="live-rail-conversation-body" ref={conversationBodyRef} aria-live="polite" onScroll={(event) => {
            const body = event.currentTarget;
            shouldFollowTranscriptRef.current = body.scrollHeight - body.scrollTop - body.clientHeight < 24;
          }}>
            {transcripts.length === 0 ? (
              <p className="live-rail-conversation-empty">Your Live conversation will appear here.</p>
            ) : transcripts.map((item) => (
              <div key={item.id} className={`live-rail-message is-${item.role}`}>
                <strong>{item.role === "user" ? "You" : item.role === "assistant" ? "Live" : "System"}</strong>
                <small>{item.roomName}</small>{item.toolCall || item.id.startsWith("tool_") ? (
                  <details><summary>Tool details</summary><span>{item.toolCall?.name ?? "Control tool"} · {item.toolCall?.status ?? "done"}</span>
                    <span>{item.toolCall?.query}</span><span>{item.toolCall?.resultSummary ?? item.text}</span></details>
                ) : <span>{item.text}</span>}
              </div>
            ))}
          </div>
        </section>
      ) : null}
      {statsOpen ? (
        <LiveStatsWindow
          onClose={() => setStatsOpen(false)}
          position={statsPosition}
          onPositionChange={setStatsPosition}
        />
      ) : null}
    </>
  );
}
