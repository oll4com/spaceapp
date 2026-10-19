import type { LucideIcon } from "../ui-theme/app-icons.js";

export type NonCliPaneType =
  | "chat"
  | "browser"
  | "files"
  | "databases"
  | "demos"
  | "youtube"
  | "vnc"
  | "live"
  | "harness"
  | "t3code"
  | "jobs"
  | "mail"
  | "marketing"
  | "freelance"
  | "design";

export interface PaneItemConfig {
  id: NonCliPaneType;
  actionId: string;
  label: string;
  description: string;
  icon: LucideIcon;
  requiresHarness?: boolean;
}
