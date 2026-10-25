import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import type { Pane } from "@space/contracts";
import { getSpaceRuntime } from "../../runtime/SpaceRuntime.js";
import { readStoredBoolean } from "../../stored-boolean.js";
import { LiveRailContextMenu } from "./LiveRailContextMenu.js";
import type { LiveTranscriptItem } from "./live-session.js";

// The lower rail's Live voice button: the shared Live session status it mirrors,
// its right-click menu and the per-browser choice to hide its animated graphic.

const LIVE_RAIL_GRAPHIC_DISABLED_STORAGE_KEY = "space.liveRail.graphicDisabled.v1";

export type LiveRailStatus = "idle" | "connecting" | "active" | "listening" | "thinking" | "speaking" | "error";

export interface LiveRail {
  liveRailStatus: LiveRailStatus;
  liveRailContextMenu: { x: number; y: number } | null;
  setLiveRailContextMenu: (menu: { x: number; y: number } | null | ((current: { x: number; y: number } | null) => { x: number; y: number } | null)) => void;
  isLiveRailGraphicDisabled: boolean;
  toggleLiveRailGraphic: () => void;
}

/** `panes`: a Live pane in the active room also reports its status here. */
export function useLiveRail(panes: Pane[]): LiveRail {
  const [liveRailStatus, setLiveRailStatus] = useState<LiveRailStatus>("idle");
  const [liveRailContextMenu, setLiveRailContextMenu] = useState<{ x: number; y: number } | null>(null);
  const [isLiveRailGraphicDisabled, setIsLiveRailGraphicDisabled] = useState<boolean>(() => readStoredBoolean(LIVE_RAIL_GRAPHIC_DISABLED_STORAGE_KEY));

  const toggleLiveRailGraphic = useCallback(() => {
    setIsLiveRailGraphicDisabled((prev) => {
      const next = !prev;
      try {
        getSpaceRuntime().platform.localStorage.setItem(LIVE_RAIL_GRAPHIC_DISABLED_STORAGE_KEY, String(next));
      } catch {}
      return next;
    });
  }, []);

  useEffect(() => {
    const handleToggle = () => {
      toggleLiveRailGraphic();
    };
    window.addEventListener("space-live-rail-graphic-toggle", handleToggle);
    return () => {
      window.removeEventListener("space-live-rail-graphic-toggle", handleToggle);
    };
  }, [toggleLiveRailGraphic]);

  useEffect(() => {
    const handleLiveStatus = (event: Event) => {
      const detail = (event as CustomEvent<{ paneId?: string; rail?: boolean; status?: LiveRailStatus }>).detail;
      if (detail.rail && detail.status) {
        setLiveRailStatus(detail.status);
        return;
      }
      const livePane = panes.find((pane) => pane.id === detail?.paneId && pane.mode === "LIVE");
      if (livePane && detail.status) setLiveRailStatus(detail.status);
    };
    window.addEventListener("space-live-pane-status", handleLiveStatus);
    return () => window.removeEventListener("space-live-pane-status", handleLiveStatus);
  }, [panes]);

  return { liveRailStatus, liveRailContextMenu, setLiveRailContextMenu, isLiveRailGraphicDisabled, toggleLiveRailGraphic };
}

/** Tooltip of the Live voice controls for each status. */
export function liveRailTitle(status: LiveRailStatus): string {
  return status === "listening"
    ? "User speaking..."
    : status === "speaking"
    ? "Agent speaking..."
    : status === "active"
    ? "Live voice active (Listening)"
    : status === "connecting"
    ? "Connecting Live voice model..."
    : status === "thinking"
    ? "Live voice is thinking..."
    : status === "error"
    ? "Live voice disconnected. Tap to retry."
    : "Start Live voice conversation";
}

/** The Live voice button of the lower rail with its right-click menu. */
export function LiveRailButton({ liveRail, onActivate, disabled }: { liveRail: LiveRail; onActivate: () => void; disabled: boolean }) {
  const { liveRailStatus, setLiveRailContextMenu, isLiveRailGraphicDisabled } = liveRail;
  return (
      <button
        type="button"
        className={`room-toolbar-visibility-button room-live-rail-button ${
          isLiveRailGraphicDisabled ? "is-graphic-disabled" : ""
        } ${
          liveRailStatus === "active" || liveRailStatus === "listening" || liveRailStatus === "thinking" || liveRailStatus === "speaking" ? "is-connected" : ""
        } ${liveRailStatus === "listening" ? "is-listening is-user-speaking" : ""} ${
          liveRailStatus === "speaking" ? "is-speaking is-agent-speaking" : ""
        } ${liveRailStatus === "connecting" ? "is-connecting" : ""}`}
        title={liveRailTitle(liveRailStatus)}
        data-rail-id="live-model"
        data-live-status={liveRailStatus}
        data-graphic-disabled={isLiveRailGraphicDisabled ? "true" : undefined}
        aria-label={
          liveRailStatus === "connecting"
            ? "Connecting Live voice model"
            : liveRailStatus === "listening"
            ? "User speaking"
            : liveRailStatus === "speaking"
            ? "Agent speaking"
            : liveRailStatus === "thinking"
            ? "Live voice is thinking"
            : liveRailStatus === "error"
            ? "Retry Live voice conversation"
            : "Start Live voice conversation"
        }
        aria-pressed={liveRailStatus !== "idle" && liveRailStatus !== "error"}
        aria-busy={liveRailStatus === "connecting"}
        onClick={onActivate}
        // A mouse click must not focus the orb: a later key press would light the theme's focus ring around it.
        onMouseDown={(event) => event.preventDefault()}
        onContextMenu={(event) => {
          event.preventDefault();
          event.stopPropagation();
          setLiveRailContextMenu((current) => current ? null : { x: event.clientX, y: event.clientY });
        }}
        disabled={disabled}
      >
        {!isLiveRailGraphicDisabled ? <LiveOrb status={liveRailStatus} /> : null}
      </button>
  );
}

/** Glass sphere with a light "liquid" whose level, color and motion follow the Live status. */
export function LiveOrb({ status, className = "" }: { status: LiveRailStatus; className?: string }) {
  return (
    <span className={`live-orb ${className}`} data-live-status={status} aria-hidden="true">
      <span className="live-orb-liquid">
        <span className="live-orb-wave is-back" />
        <span className="live-orb-wave is-front" />
      </span>
      <span className="live-orb-iris" />
      <span className="live-orb-shine" />
    </span>
  );
}

/** The right-click menu of the Live voice button; it stays mounted while the button is hidden. */
export function LiveRailMenu({ liveRail }: { liveRail: LiveRail }) {
  const { liveRailContextMenu, setLiveRailContextMenu, isLiveRailGraphicDisabled, toggleLiveRailGraphic } = liveRail;
  if (!liveRailContextMenu) return null;
  return (
    <LiveRailContextMenu
      x={liveRailContextMenu.x}
      y={liveRailContextMenu.y}
      isGraphicDisabled={isLiveRailGraphicDisabled}
      onToggleGraphic={toggleLiveRailGraphic}
      onClose={() => setLiveRailContextMenu(null)}
    />
  );
}

const LIVE_CAPTION_HOLD_MS = 6000;

/** The latest spoken phrase and whether to show it: history present at mount is never captioned,
 *  and a caption fades LIVE_CAPTION_HOLD_MS after its last update. */
export function useLiveCaption(transcripts: LiveTranscriptItem[]) {
  const item = transcripts.findLast(entry => (entry.role === "user" || entry.role === "assistant") && !entry.toolCall && !entry.id.startsWith("tool_") && entry.text.trim());
  const key = item ? `${item.id}:${item.text}` : "";
  const initialKeyRef = useRef(key);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (!key || key === initialKeyRef.current) return;
    // shortcut: freshness comes from createdAtMs (first chunk of a turn), 60 s covers one long answer; upgrade if turns get longer.
    if (Date.now() - (item?.createdAtMs ?? Date.now()) > 60_000) return;
    initialKeyRef.current = "";
    setVisible(true);
    const timer = window.setTimeout(() => setVisible(false), LIVE_CAPTION_HOLD_MS);
    return () => window.clearTimeout(timer);
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  return { item, visible };
}

/** Gemini-style caption card: the user's words in italics, at most three lines with the newest words in view. */
export function LiveCaption({ item, visible, className = "", style }: { item: LiveTranscriptItem; visible: boolean; className?: string; style?: CSSProperties }) {
  const textRef = useRef<HTMLParagraphElement | null>(null);
  useLayoutEffect(() => {
    const text = textRef.current;
    if (!text) return;
    text.scrollTop = text.scrollHeight;
    text.dataset.overflowing = String(text.scrollHeight > text.clientHeight + 1);
  }, [item.text, visible]);
  return (
    <div className={`live-caption is-${item.role}${visible ? " is-visible" : ""} ${className}`} style={style} aria-hidden="true">
      <p ref={textRef}>{item.text}</p>
    </div>
  );
}
