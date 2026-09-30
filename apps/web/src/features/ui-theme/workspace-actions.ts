import { Grid2X2, Music2, PanelLeft, PanelsTopLeft, Settings2, StickyNote, Wrench } from "./app-icons.js";
import type { IconToolbarAction } from "../../icon-toolbar.js";

export const workspaceCategories = [
  { id: "layout", label: "Layout", description: "Arrange panes and move between rooms.", icon: PanelsTopLeft, color: "#10b981" },
  { id: "docks", label: "Docks", description: "Your rooms, conversations and saved work.", icon: Grid2X2, color: "#f59e0b" },
  { id: "tools", label: "Tools", description: "Utilities, connections and system insights.", icon: Wrench, color: "#a78bfa" },
  { id: "widgets", label: "Notes & widgets", description: "Keep useful information close at hand.", icon: StickyNote, color: "#eab308" },
  { id: "media", label: "Media", description: "Music, voice and screen capture.", icon: Music2, color: "#f472b6" },
  { id: "view", label: "View", description: "Control what appears in your workspace.", icon: PanelLeft, color: "#38bdf8" },
  { id: "settings", label: "Settings", description: "Personalize Space and manage your account.", icon: Settings2, color: "#94a3b8" }
] as const;
export type WorkspaceCategory = typeof workspaceCategories[number]["id"];
export const workspaceQuickActionIds = ["pane-layout", "font-down", "resources"];

export function workspaceActionCategory(id: string): WorkspaceCategory {
  if (["surface-settings", "theme", "sensitive-data", "advanced-settings", "help", "setup-connections", "sign-out"].includes(id)) return "settings";
  if (["pane-layout", "pane-span-all", "previous-room", "next-room", "rename-room"].includes(id)) return "layout";
  if (["font-down", "category-color-filter", "cli-floats", "resource-indicators", "room-focus", "browser-fullscreen", "minimized-bar"].includes(id)) return "view";
  if (id.startsWith("widget-") || id === "sticky-note") return "widgets";
  if (["vibe-music", "live-model", "clip-tool"].includes(id)) return "media";
  if (id.startsWith("surface-")) return "docks";
  return "tools";
}
const labels: Record<string, string> = {
  "server-restart": "Manage",
  "surface-rooms": "Rooms",
  "surface-room-agent": "Room Agent", "surface-shared-chat": "Shared chat", "surface-tasks": "Tasks",
  "surface-agent-files": "Agent Files", "surface-agent-sessions": "Sessions", "surface-media": "Media",
  "surface-clipboard": "Clipboard", "surface-links": "Links", "surface-settings": "Settings",
  "surface-cli": "CLI tools",
  "surface-health": "Health", "surface-streaming": "Streaming", "memory-workspace": "Memory",
  "add-files": "File Manager", "add-demos": "Demo Projects", "add-empty-slots": "Empty slots",
  "system-analytics": "System analytics", "system-services": "System services", "system-resources": "System resources",
  "pane-layout": "Pane layout", "font-down": "Text size", "resources": "Resources",
  "resource-indicators": "Resource indicators", "cli-floats": "CLI controls", "sensitive-data": "Hide sensitive data",
  "debug-mode": "Debug (App diagnostics)",
  "demo-mode": "Demo mode",
  "browser-fullscreen": "Full screen browser",
  "vibe-music": "Music",
  "sticky-note": "Sticky note",
  "live-model": "Live voice model",
  "minimized-bar": "Minimized panes",
  "previous-room": "Previous room",
  "next-room": "Next room",
  create: "Create",
  docks: "Docks",
  "osk-keyboard": "On-screen keyboard",
  "widget-clock": "Clock widget",
  "widget-countdown-timer": "Countdown timer",
  "widget-pushup-reminder": "Push-up reminder",
  "widget-spaceapp-promo": "SpaceApp.dev promo",
  "widget-ai-quota": "AI Quota monitor"
};
export function workspaceActionLabel(action: IconToolbarAction) { return labels[action.id] ?? action.label; }
export function workspaceActionToggle(action: IconToolbarAction): boolean | undefined {
  if (action.id === "browser-fullscreen") return Boolean(action.ariaPressed);
  if (action.id === "cli-floats") return !action.ariaPressed;
  if (["resource-indicators", "sensitive-data", "debug-mode", "osk-keyboard", "vibe-music", "live-model", "minimized-bar", "widget-clock", "widget-countdown-timer", "widget-pushup-reminder", "widget-spaceapp-promo", "widget-ai-quota"].includes(action.id)) return Boolean(action.ariaPressed);
  return undefined;
}
