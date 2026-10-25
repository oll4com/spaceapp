import { Fragment, useEffect, useLayoutEffect, useRef, useState, useCallback } from "react";
import { Mic, MicOff, Phone, PhoneOff, Trash2, Wrench, X } from "../ui-theme/app-icons.js";
import { LiveStatsWindow } from "./LiveStatsWindow.js";
import { useLiveCoordinator, useLiveSessionState } from "./LiveSessionProvider.js";
import { SpaceToggle } from "../ui-controls/SpaceToggle.js";
import { LIVE_RAIL_CAPTIONS_DISABLED_STORAGE_KEY } from "./LiveRailContextMenu.js";
import { LiveCaption, LiveOrb, useLiveCaption, type LiveRailStatus } from "./useLiveRail.js";
import type { LiveTranscriptItem } from "./live-session.js";

const LIVE_STATUS_LABELS: Record<LiveRailStatus, string> = {
  idle: "Ready", connecting: "Connecting…", active: "Listening", listening: "You are speaking",
  thinking: "Thinking…", speaking: "Speaking", error: "Connection lost"
};

export function LiveRailSession() {
  const coordinator = useLiveCoordinator();
  const state = useLiveSessionState();
  const [roomOnly, setRoomOnly] = useState(false);
  const transcripts = (state?.transcripts ?? []).filter(item => !roomOnly || item.roomId === state?.roomId);
  const [conversationOpen, setConversationOpen] = useState(false);
  const status = state?.status ?? "idle";
  const statusLabel = !state?.enabled ? "Disconnected" : state.contextState !== "ready" ? "Updating room context…" : LIVE_STATUS_LABELS[status];
  const roomNames = new Map((state?.transcripts ?? []).filter(item => item.roomId && item.roomName && item.roomName !== item.roomId).map(item => [item.roomId!, item.roomName!]));
  if (state?.roomId && state.roomName) roomNames.set(state.roomId, state.roomName);
  const roomLabel = (item: LiveTranscriptItem) => (item.roomId && roomNames.get(item.roomId)) || item.roomName || "Other room";
  const [captionsDisabled, setCaptionsDisabled] = useState(() => window.localStorage?.getItem(LIVE_RAIL_CAPTIONS_DISABLED_STORAGE_KEY) === "true");
  const { item: captionItem, visible: captionVisible } = useLiveCaption(state?.transcripts ?? []);
  const captionsAllowed = state?.enabled === true && !captionsDisabled && !conversationOpen;
  const [captionAnchor, setCaptionAnchor] = useState<{ right: number; top: number } | null>(null);
  const [conversationPosition, setConversationPosition] = useState(() => ({ left: window.innerWidth <= 767 ? 8 : 280, top: window.innerWidth <= 767 ? 8 : 120 }));
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
  useLayoutEffect(() => {
    if (!captionVisible || !captionsAllowed) return;
    const place = () => {
      const orb = document.querySelector('[data-rail-id="live-model"]')?.getBoundingClientRect();
      setCaptionAnchor(orb?.width ? { right: window.innerWidth - orb.left + 12, top: orb.top + orb.height / 2 } : null);
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [captionVisible, captionsAllowed]);

  useEffect(() => {
    const conversation = () => setConversationOpen(open => !open);
    const stats = () => setStatsOpen(open => !open);
    window.addEventListener("space-live-rail-conversation-toggle", conversation);
    window.addEventListener("space-live-rail-stats-toggle", stats);
    window.addEventListener("space-live-rail-clear-conversation", handleClearConversation);
    const captions = () => setCaptionsDisabled(off => {
      try { window.localStorage.setItem(LIVE_RAIL_CAPTIONS_DISABLED_STORAGE_KEY, String(!off)); } catch {}
      return !off;
    });
    window.addEventListener("space-live-rail-captions-toggle", captions);
    return () => {
      window.removeEventListener("space-live-rail-captions-toggle", captions);
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
            <LiveOrb status={status} className="live-rail-conversation-orb" />
            <div className="live-rail-conversation-title">
              <strong>Live</strong>
              <span role="status">{statusLabel}{state?.roomName ? ` · ${state.roomName}` : ""}</span>
            </div>
            <div className="live-rail-conversation-actions">
              <button type="button" aria-label={state?.muted ? "Unmute" : "Mute"} title={state?.muted ? "Unmute microphone" : "Mute microphone"} aria-pressed={state?.muted === true} onClick={() => coordinator?.setMuted(!state?.muted)}>
                {state?.muted ? <MicOff aria-hidden="true" /> : <Mic aria-hidden="true" />}
              </button>
              <button type="button" className={state?.enabled ? "is-danger" : "is-primary"} aria-label={state?.enabled ? "Disconnect" : "Connect"} title={state?.enabled ? "End Live voice conversation" : "Start Live voice conversation"} onClick={() => coordinator?.toggle()}>
                {state?.enabled ? <PhoneOff aria-hidden="true" /> : <Phone aria-hidden="true" />}
              </button>
              <button type="button" aria-label="Clear conversation" title={roomOnly ? "Clear this room conversation" : "Clear conversation"} onClick={handleClearConversation}>
                <Trash2 aria-hidden="true" />
              </button>
              <button type="button" aria-label="Close Live conversation" title="Close" onClick={() => setConversationOpen(false)}>
                <X aria-hidden="true" />
              </button>
            </div>
          </header>
          {state?.error ? <p className="live-rail-conversation-error" role="alert">{state.error}</p> : null}
          <div className="live-rail-conversation-body" ref={conversationBodyRef} aria-live="polite" onScroll={(event) => {
            const body = event.currentTarget;
            shouldFollowTranscriptRef.current = body.scrollHeight - body.scrollTop - body.clientHeight < 24;
          }}>
            {transcripts.length === 0 ? (
              <div className="live-rail-conversation-empty">
                <LiveOrb status={status} className="live-rail-empty-orb" />
                <p>Your Live conversation will appear here.</p>
              </div>
            ) : transcripts.map((item, index) => {
              const previous = transcripts[index - 1];
              const isTool = Boolean(item.toolCall || item.id.startsWith("tool_"));
              const roomChanged = !roomOnly && item.roomId !== previous?.roomId;
              return (
                <Fragment key={item.id}>
                  {roomChanged ? <p className="live-rail-room-divider"><span>{roomLabel(item)}</span></p> : null}
                  <div className={`live-rail-message is-${item.role}${isTool ? " is-tool" : ""}`}>
                    {!isTool && (roomChanged || item.role !== previous?.role) ? <strong>{item.role === "user" ? "You" : item.role === "assistant" ? "Live" : "System"}</strong> : null}
                    {isTool ? (
                      <details><summary><Wrench aria-hidden="true" />{item.toolCall?.name ?? "Control tool"}<small>{item.toolCall?.status ?? "done"}</small></summary>
                        <span>{item.toolCall?.query}</span><span>{item.toolCall?.resultSummary ?? item.text}</span></details>
                    ) : <span>{item.text}</span>}
                  </div>
                </Fragment>
              );
            })}
          </div>
          <footer className="live-rail-conversation-footer">
            <SpaceToggle className="live-rail-room-toggle" label="This room only" checked={roomOnly} onChange={setRoomOnly} compact />
          </footer>
        </section>
      ) : null}
      {captionItem && captionsAllowed ? (
        <LiveCaption
          item={captionItem}
          visible={captionVisible}
          className="live-rail-caption"
          style={captionAnchor ? { right: captionAnchor.right, top: captionAnchor.top } : undefined}
        />
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
