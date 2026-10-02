import { Cpu, Grid2X2, PanelsTopLeft, Plus, SlidersHorizontal, Sparkles, Wrench } from "./app-icons.js";
import type { IconToolbarAction } from "../../icon-toolbar.js";

export const workspaceCategories = [
  { id: "create", label: "Create", description: "Add a pane or launch a coding assistant.", icon: Plus, color: "#94a3b8" },
  { id: "layout", label: "Pane layout", description: "Arrange panes and adjust their text and size.", icon: PanelsTopLeft, color: "#10b981" },
  { id: "docks", label: "Docks", description: "Your rooms, conversations and saved work.", icon: Grid2X2, color: "#f59e0b" },
  { id: "tools", label: "Workspace tools", description: "Utilities, connections and system insights.", icon: Wrench, color: "#a78bfa" },
  { id: "widgets", label: "Desktop widgets", description: "Widgets, timers and floating sticky notes.", icon: Sparkles, color: "#eab308" },
  { id: "utilities", label: "Utilities", description: "System tools, memory, assistance and window actions.", icon: Cpu, color: "#ec4899" },
  { id: "toggles", label: "Quick toggles", description: "Toggle workspace features and visual controls.", icon: SlidersHorizontal, color: "#38bdf8" }
] as const;
export type WorkspaceCategory = typeof workspaceCategories[number]["id"] | "room";
export const workspaceQuickActionIds = ["pane-layout", "font-down", "resources", "workspace-room"];
export const workspaceRoomActionIds = ["rename-room", "theme", "cli-floats", "resource-indicators", "minimized-bar", "previous-room", "next-room"];

export function workspaceActionCategory(id: string): WorkspaceCategory {
  if (id.startsWith("add-") || id === "create") return "create";
  if (["pane-layout", "pane-span-all", "font-down"].includes(id)) return "layout";
  if (id.startsWith("surface-") || id === "docks") return "docks";
  if (workspaceRoomActionIds.includes(id) || id === "workspace-room" || ["room-focus", "room-toolbar", "category-color-filter"].includes(id)) return "room";
  if (["debug-mode", "sensitive-data", "browser-fullscreen"].includes(id)) return "toggles";
  if (
    id === "sticky-note" ||
    id.startsWith("widget-")
  ) {
    return "widgets";
  }
  if (
    [
      "quick-links",
      "toggle-admin-mode",
      "memory-workspace",
      "system-resources",
      "resources",
      "benchmark",
      "token-usage",
      "server-restart",
      "system-analytics",
      "system-services",
      "setup-connections",
      "help",
      "vpn-city",
      "reload-room",
      "clip-tool",
      "snip-tool",
      "demo-mode"
    ].includes(id)
  ) {
    return "utilities";
  }
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
  "pane-layout": "Pane layout", "font-down": "Text size", "resources": "Resources", "workspace-room": "Room",
  "desktop-displays": "Displays", "room-toolbar": "Room toolbar",
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
  "widget-ai-quota": "AI Quota monitor",
  "widget-streaming-metrics": "Streaming metrics"
};
export function workspaceActionLabel(action: IconToolbarAction) { return labels[action.id] ?? action.label; }
export function workspaceActionToggle(action: IconToolbarAction): boolean | undefined {
  if (action.id === "browser-fullscreen") return Boolean(action.ariaPressed);
  if (action.id === "cli-floats") return !action.ariaPressed;
  if (action.id.startsWith("widget-") || ["resource-indicators", "sensitive-data", "debug-mode", "osk-keyboard", "vibe-music", "live-model", "minimized-bar"].includes(action.id)) return Boolean(action.ariaPressed);
  return undefined;
}
