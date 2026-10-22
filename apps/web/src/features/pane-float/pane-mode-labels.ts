import type { Pane } from "@space/contracts";
import { cliRuntimeLabel } from "../../cli-runtime-presentation.js";

// Display labels for pane modes and the titles of new and minimized panes.

const paneModeLabels: Record<Pane["mode"], string> = {
  CHAT: "Chat",
  CODE: "Code",
  BROWSER: "Browser",
  REVIEW: "Review",
  SWARM: "Swarm",
  DESIGN: "Design",
  TERMINAL: "CLI",
  YOUTUBE: "YouTube",
  VNC: "VNC",
  HARNESS: "Harness",
  LIVE: "Live",
  FILES: "Files",
  DATABASES: "Databases",
  DEMOS: "Demo Projects",
  T3CODE: "T3 Code",
  JOB_APPLY: "Job Copilot",
  MAIL_COPILOT: "Mail Copilot",
  MARKETING_COPILOT: "Marketing Copilot",
  FREELANCE_COPILOT: "Freelance Copilot",
  APP_STUDIO: "App Studio"
};

export function paneModeLabel(mode: Pane["mode"]): string {
  return paneModeLabels[mode];
}

/** Title of a new pane: the mode label and its position in the room. */
export function paneTitleForMode(mode: Pane["mode"], index: number): string {
  return `${paneModeLabel(mode)} ${index}`;
}

export function formatPaneFullTitle(pane: Pick<Pane, "mode" | "title"> & { paneName?: string | null }): string {
  const baseTitle = pane.mode === "TERMINAL" ? pane.title.replace(/^Terminal\b/i, "CLI") : pane.title;
  if (!pane.paneName) return baseTitle;
  if (!baseTitle || baseTitle.trim().toLowerCase() === pane.paneName.trim().toLowerCase()) return pane.paneName;
  return `${pane.paneName} · ${baseTitle}`;
}

/** Second line of a minimized pane card: the task title, or the CLI / pane type when there is none. */
export function minimizedPaneSubtitle(pane: Pick<Pane, "mode" | "title" | "terminalRuntimeId"> & { paneName?: string | null }): string {
  const baseTitle = pane.mode === "TERMINAL" ? pane.title.replace(/^Terminal\b/i, "CLI") : pane.title;
  if (pane.paneName && baseTitle && baseTitle.trim().toLowerCase() !== pane.paneName.trim().toLowerCase()) return baseTitle;
  if (pane.mode === "TERMINAL") return cliRuntimeLabel(pane.terminalRuntimeId) ?? "CLI";
  return paneModeLabel(pane.mode);
}
