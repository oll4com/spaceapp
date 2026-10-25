import type { LucideIcon } from "../ui-theme/app-icons.js";

export type SideSurface =
  | "rooms"
  | "nous"
  | "notifications"
  | "room-agent"
  | "shared-chat"
  | "media"
  | "streaming"
  | "source-control"
  | "agent-files"
  | "clipboard"
  | "tasks"
  | "vault"
  | "links"
  | "settings"
  | "health"
  | "cli"
  | "agent-sessions";

export interface DockItemDefinition {
  id: SideSurface;
  label: string;
  description: string;
  iconName: string;
  requiresGitPlugin?: boolean;
  requiresAdmin?: boolean;
  locked?: boolean;
}
