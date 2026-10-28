import type { RoomAgentPaneStripItem } from "@space/contracts";
import { ExternalLink } from "../ui-theme/app-icons.js";
import { DockIconButton } from "../dock-kit/DockKit.js";

const modeLabels: Partial<Record<RoomAgentPaneStripItem["mode"], string>> = {
  BROWSER: "Browser", FILES: "Files", LIVE: "Live", HARNESS: "Harness", YOUTUBE: "YouTube", VNC: "Desktop",
  DATABASES: "Databases", DEMOS: "Demos", T3CODE: "T3 Code", JOB_APPLY: "Job Copilot", MAIL_COPILOT: "Mail Copilot", MARKETING_COPILOT: "Marketing Copilot", FREELANCE_COPILOT: "Freelance Copilot", APP_STUDIO: "App Studio", VIDEO: "Video", SECURITY_COPILOT: "Security Copilot", MONITORING_COPILOT: "Monitoring Copilot", TERMINAL: "Shell"
};

export function paneStripName(item: RoomAgentPaneStripItem): string {
  return item.paneName ?? item.title;
}

export function paneActivityLabel(item: RoomAgentPaneStripItem): string {
  switch (item.activity) {
    case "WORKING": return "Working";
    case "WAITING": return item.reason ?? "Waiting";
    case "DONE": return "Done";
    case "IDLE": return item.reason ?? "Idle";
    case "UNKNOWN": return "Unknown";
    default: return modeLabels[item.mode] ?? item.mode;
  }
}

/** "3 panes · 1 working · 1 waiting": the room in one line. */
export function paneStripSummary(items: RoomAgentPaneStripItem[]): string {
  if (!items.length) return "No panes open";
  const count = (activity: RoomAgentPaneStripItem["activity"]) => items.filter((item) => item.activity === activity).length;
  return [
    `${items.length} pane${items.length === 1 ? "" : "s"}`,
    count("WORKING") ? `${count("WORKING")} working` : null,
    count("WAITING") ? `${count("WAITING")} waiting` : null,
    count("DONE") ? `${count("DONE")} done` : null
  ].filter(Boolean).join(" · ");
}

/** Every open pane of the room with its live activity; a row starts a question to the Room Agent about that pane. */
export function RoomAgentPaneStrip({ id, items, onAsk, onOpenPane }: {
  id?: string;
  items: RoomAgentPaneStripItem[];
  onAsk(item: RoomAgentPaneStripItem): void;
  onOpenPane?: (paneId: string) => void;
}) {
  if (!items.length) return null;
  return (
    <ul className="room-agent-pane-list" id={id} aria-label="Room panes">
      {items.map((item) => {
        const name = paneStripName(item);
        const task = item.taskTitle ?? (item.title !== name ? item.title : null);
        return (
          <li key={item.paneId} className="room-agent-pane" data-activity={item.activity}>
            <span className="room-agent-pane-dot" aria-hidden="true" />
            <button type="button" className="room-agent-pane-ask" title={`Ask the Room Agent about ${name}`} onClick={() => onAsk(item)}>
              <strong>{name}</strong>
              {task ? <span className="room-agent-pane-task">{task}</span> : null}
            </button>
            <span className="room-agent-pane-state" title={item.modelId ? `Model: ${item.modelId}` : undefined}>
              {paneActivityLabel(item)}{item.isMinimized ? " · minimized" : ""}
            </span>
            {onOpenPane ? (
              <DockIconButton label={`Open ${name}`} icon={ExternalLink} onClick={() => onOpenPane(item.paneId)} />
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
