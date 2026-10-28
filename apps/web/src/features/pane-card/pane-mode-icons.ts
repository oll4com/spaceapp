import type { Pane } from "@space/contracts";
import { Boxes, Briefcase, CodeXml, Database, Film, FolderOpen, GitCompare, Globe, Handshake, Mail, Megaphone, MessageSquare, Mic, Monitor, Network, PenTool, Presentation, Radar, ShieldHalf, SquareCode, TabletSmartphone, Terminal, Youtube, type LucideIcon } from "../ui-theme/app-icons.js";

// One icon per pane type: pane headers, the Create menu and the pane visibility settings all use these.
export const modeIcons: Record<Pane["mode"], LucideIcon> = {
  CHAT: MessageSquare,
  CODE: CodeXml,
  BROWSER: Globe,
  REVIEW: GitCompare,
  SWARM: Boxes,
  DESIGN: PenTool,
  TERMINAL: Terminal,
  YOUTUBE: Youtube,
  VNC: Monitor,
  HARNESS: Network,
  LIVE: Mic,
  FILES: FolderOpen,
  DATABASES: Database,
  DEMOS: Presentation,
  T3CODE: SquareCode,
  JOB_APPLY: Briefcase,
  MAIL_COPILOT: Mail,
  MARKETING_COPILOT: Megaphone,
  FREELANCE_COPILOT: Handshake,
  APP_STUDIO: TabletSmartphone,
  SECURITY_COPILOT: ShieldHalf,
  MONITORING_COPILOT: Radar,
  VIDEO: Film
};
