import type { NotificationSource } from "@space/contracts";
import { AlertTriangle, Bell, type LucideIcon } from "../ui-theme/app-icons.js";
import { modeIcons } from "../pane-card/pane-mode-icons.js";
import { sideSurfaceMeta } from "../docks/side-surface-meta.js";

// A notification shows the icon its source already has as a pane type or dock (one icon per meaning).
export const notificationSourceIcons: Record<NotificationSource, LucideIcon> = {
  MAIL_COPILOT: modeIcons.MAIL_COPILOT,
  JOB_COPILOT: modeIcons.JOB_APPLY,
  MARKETING_COPILOT: modeIcons.MARKETING_COPILOT,
  FREELANCE_COPILOT: modeIcons.FREELANCE_COPILOT,
  DESIGN: modeIcons.DESIGN,
  APP_STUDIO: modeIcons.APP_STUDIO,
  SECURITY_COPILOT: modeIcons.SECURITY_COPILOT,
  VIDEO: modeIcons.VIDEO,
  ROOM_AGENT: sideSurfaceMeta["room-agent"].icon,
  COUNCIL: sideSurfaceMeta["shared-chat"].icon,
  NOUS: sideSurfaceMeta.nous.icon,
  // A CLI pane's own needs-you (space-progress needs-you): the CLI pane's icon.
  AGENT: modeIcons.TERMINAL,
  BROWSER_HANDOFF: modeIcons.BROWSER,
  ROOM_WATCHDOG: AlertTriangle,
  SYSTEM: Bell
};
