import {
  Activity,
  Archive,
  Bell,
  Bot,
  Clipboard,
  FolderOpen,
  GitBranch,
  Images,
  Link as LinkIcon,
  ListTodo,
  MessagesSquare,
  PanelLeft,
  Radio,
  Settings,
  Terminal,
  type LucideIcon,
  AgentFiles
} from "../ui-theme/app-icons.js";
import type { SideSurface } from "./dock-types.js";

export const sideSurfaceMeta: Record<SideSurface, { icon: LucideIcon; label: string; surfaceLabel: string }> = {
  rooms: { icon: PanelLeft, label: "rooms", surfaceLabel: "Rooms" },
  notifications: { icon: Bell, label: "notifications", surfaceLabel: "Notifications" },
  "room-agent": { icon: Bot, label: "room agent", surfaceLabel: "Room Agent" },
  "shared-chat": { icon: MessagesSquare, label: "council", surfaceLabel: "Council" },
  media: { icon: Images, label: "media dock", surfaceLabel: "Media dock" },
  streaming: { icon: Radio, label: "streaming dock", surfaceLabel: "Streaming dock" },
  "source-control": { icon: GitBranch, label: "source control", surfaceLabel: "Source Control" },
  "agent-files": { icon: AgentFiles, label: "Agent Files", surfaceLabel: "Agent Files" },
  clipboard: { icon: Clipboard, label: "clipboard", surfaceLabel: "Clipboard" },
  tasks: { icon: ListTodo, label: "tasks", surfaceLabel: "Tasks" },
  links: { icon: LinkIcon, label: "links", surfaceLabel: "Links" },
  settings: { icon: Settings, label: "settings dock", surfaceLabel: "Settings dock" },
  health: { icon: Activity, label: "health dock", surfaceLabel: "Health dock" },
  cli: { icon: Terminal, label: "cli dock", surfaceLabel: "CLI dock" },
  "agent-sessions": { icon: Archive, label: "agent session history", surfaceLabel: "Agent Session History" }
};
