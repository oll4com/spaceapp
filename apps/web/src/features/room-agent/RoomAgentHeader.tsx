import { useState } from "react";
import type { Room, RoomAgentPaneStripItem, RoomAgentSession, RoomAgentStatus } from "@space/contracts";
import { ChevronDown, ChevronUp, MessageSquareX, SlidersHorizontal } from "../ui-theme/app-icons.js";
import { DockIconButton, DockToolbar } from "../dock-kit/DockKit.js";
import { SpaceToggle } from "../ui-controls/SpaceToggle.js";
import {
  roomAgentDesktopNotificationsEnabled, roomAgentDesktopNotificationsSupported, setRoomAgentDesktopNotifications
} from "./room-agent-notifications.js";
import { RoomAgentPaneStrip, paneStripSummary } from "./RoomAgentPaneStrip.js";

const statusLabels: Record<RoomAgentStatus, string> = {
  IDLE: "Ready",
  QUEUED: "Queued",
  RUNNING: "Answering",
  PAUSED: "Paused",
  RECOVERING: "Recovering",
  BLOCKED: "Needs attention"
};

const statusTones: Record<RoomAgentStatus, string> = {
  IDLE: "is-success",
  QUEUED: "is-accent",
  RUNNING: "is-accent",
  PAUSED: "is-warning",
  RECOVERING: "is-warning",
  BLOCKED: "is-warning"
};

/** Status, room, one line about the panes (opens their list), settings and Clear. */
export function RoomAgentHeader({ room, session, loading, clearing, canClear, onClear, onAskPane, onOpenPane, onMonitorChange, switchingMonitor }: {
  room: Room | null;
  session: RoomAgentSession | null;
  loading: boolean;
  clearing: boolean;
  canClear: boolean;
  onClear(): void;
  onAskPane(item: RoomAgentPaneStripItem): void;
  onOpenPane?: (paneId: string) => void;
  onMonitorChange(settings: { enabled?: boolean; autopilot?: boolean }): void;
  switchingMonitor: boolean;
}) {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [panesOpen, setPanesOpen] = useState(false);
  const [desktopAlerts, setDesktopAlerts] = useState(roomAgentDesktopNotificationsEnabled);
  const status = session?.status ?? "IDLE";
  const panes = session?.paneStrip ?? [];
  const waiting = panes.some((item) => item.activity === "WAITING");
  return (
    <div className="room-agent-header">
      <DockToolbar
        className="room-agent-head"
        summary={room ? (
          <>
            <span className={`dock-kit-badge room-agent-status ${loading ? "" : statusTones[status]}`} data-status={loading ? "CONNECTING" : status} role="status">
              {loading ? "Connecting…" : statusLabels[status]}
            </span>
            <span className="room-agent-room-name" title={room.name}>{room.name}</span>
          </>
        ) : (
          <span className="room-agent-room-name">No room selected</span>
        )}
      >
        {room && session?.monitor ? (
          <DockIconButton
            label="Room Agent settings"
            icon={SlidersHorizontal}
            aria-expanded={settingsOpen}
            aria-controls="room-agent-settings"
            className={settingsOpen ? "is-active" : undefined}
            onClick={() => setSettingsOpen((open) => !open)}
          />
        ) : null}
        <DockIconButton label="Clear Room Agent history" icon={MessageSquareX} tone="danger" onClick={onClear}
          disabled={!room || clearing || !canClear} busy={clearing} />
      </DockToolbar>

      {room && session?.paneStrip ? (
        <button type="button" className="room-agent-summary" data-attention={waiting ? "true" : undefined} aria-expanded={panesOpen}
          aria-controls="room-agent-pane-list" disabled={!panes.length} onClick={() => setPanesOpen((open) => !open)}>
          <span>{paneStripSummary(panes)}</span>
          {panes.length ? (panesOpen ? <ChevronUp aria-hidden="true" /> : <ChevronDown aria-hidden="true" />) : null}
        </button>
      ) : null}

      {room && panesOpen && panes.length ? (
        <RoomAgentPaneStrip id="room-agent-pane-list" items={panes} onOpenPane={onOpenPane} onAsk={onAskPane} />
      ) : null}

      {room && session?.monitor && settingsOpen ? (
        <div className="room-agent-settings" id="room-agent-settings" role="group" aria-label="Room Agent settings">
          <SpaceToggle compact className="room-agent-setting" label="Monitor this room" detail="Watch every pane and report what finishes or needs you."
            ariaLabel="Monitor this room" checked={session.monitor.enabled} disabled={switchingMonitor} onChange={(enabled) => onMonitorChange({ enabled })} />
          {session.monitor.autopilot !== undefined ? (
            <SpaceToggle compact className="room-agent-setting" label="Answer prompts for me"
              detail="Ordinary approvals are answered; protected and destructive ones still come to you."
              ariaLabel="Let the Room Agent answer pane prompts" checked={session.monitor.autopilot}
              disabled={switchingMonitor || !session.monitor.enabled} onChange={(autopilot) => onMonitorChange({ autopilot })} />
          ) : null}
          {roomAgentDesktopNotificationsSupported() ? (
            <SpaceToggle compact className="room-agent-setting" label="Desktop alerts" detail="Notify me when something needs me while Space is in the background."
              ariaLabel="Desktop notifications when a pane needs you" checked={desktopAlerts}
              onChange={(enabled) => void setRoomAgentDesktopNotifications(enabled).then(setDesktopAlerts)} />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
