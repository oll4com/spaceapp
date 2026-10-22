import { Cpu, Grid2X2, Keyboard, PanelTopOpen, PanelsTopLeft, Plus, SlidersHorizontal, Sparkles } from "./app-icons.js";
import type { IconToolbarAction } from "../../icon-toolbar.js";

export const workspaceCategories = [
  { id: "create", label: "Create", description: "Add a pane or launch a coding assistant.", icon: Plus, color: "#94a3b8" },
  { id: "layout", label: "Pane layout", description: "Arrange panes and adjust their text and size.", icon: PanelsTopLeft, color: "#10b981" },
  { id: "room", label: "Room", description: "Name, theme, navigation and room controls.", icon: PanelTopOpen, color: "#818cf8" },
  { id: "docks", label: "Docks", description: "Rooms, files, clipboard and connections.", icon: Grid2X2, color: "#f59e0b" },
  { id: "tools", label: "Input & media", description: "Keyboard, music, live voice and displays.", icon: Keyboard, color: "#a78bfa" },
  { id: "widgets", label: "Desktop widgets", description: "Widgets, timers and floating sticky notes.", icon: Sparkles, color: "#84cc16" },
  { id: "utilities", label: "Utilities", description: "System tools, memory, assistance and window actions.", icon: Cpu, color: "#ec4899" },
  { id: "toggles", label: "Quick toggles", description: "Toggle workspace features and visual controls.", icon: SlidersHorizontal, color: "#38bdf8" }
] as const;
export type WorkspaceCategory = typeof workspaceCategories[number]["id"];
// Default Quick access pins; people can replace them from the Customize mode.
export const workspaceQuickActionIds = ["pane-layout", "font-down", "resources", "workspace-room"];
export const WORKSPACE_QUICK_ACTIONS_KEY = "space:workspace-quick-actions:v1";
export const WORKSPACE_MENU_CATEGORY_KEY = "space:workspace-menu-category:v1";
export const WORKSPACE_QUICK_ACTION_LIMIT = 4;
// Tabs that render a settings page inline instead of a list of cards.
export const workspacePageTabActionIds: Partial<Record<WorkspaceCategory, string>> = { layout: "pane-layout", room: "workspace-room" };
export const workspaceRoomActionIds = ["rename-room", "theme", "cli-floats", "resource-indicators", "minimized-bar", "previous-room", "next-room"];
// Rendered in the Workspace footer instead of a category grid.
export const workspaceFooterActionIds = ["sign-out"];
// Docks read as: navigate, collaborate, content, connections, then Settings last.
export const workspaceDockOrder = [
  "surface-rooms", "surface-nous", "surface-room-agent", "surface-shared-chat", "surface-tasks", "surface-vault", "surface-agent-sessions",
  "surface-agent-files", "surface-media", "surface-clipboard", "surface-links", "surface-streaming",
  "surface-cli", "surface-source-control", "surface-health", "surface-settings"
];
// Actions that also live on the rail keep the rail icon color everywhere.
const railActionColors: Record<string, string> = {
  "surface-rooms": "var(--rail-rooms-color, #0284c7)",
  "sticky-note": "var(--rail-sticky-color, #ca8a04)",
  "pane-layout": "var(--rail-layout-color, #10b981)",
  docks: "var(--rail-docks-color, #f59e0b)"
};

export function workspaceActionCategory(id: string): WorkspaceCategory {
  if (id.startsWith("add-") || id === "create") return "create";
  if (["pane-layout", "pane-span-all", "font-down"].includes(id)) return "layout";
  if (id.startsWith("surface-") || id === "docks") return "docks";
  if (workspaceRoomActionIds.includes(id) || id === "workspace-room" || ["room-focus", "room-toolbar", "category-color-filter"].includes(id)) return "room";
  if (["debug-mode", "gateway-compression", "sensitive-data", "browser-fullscreen"].includes(id)) return "toggles";
  if (
    id === "sticky-note" ||
    id.startsWith("widget-")
  ) {
    return "widgets";
  }
  if (
    [
      "quick-links",
      "agents-dashboard",
      "sign-out",
      "toggle-admin-mode",
      "memory-workspace",
      "space-gateway",
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
export function workspaceActionColor(id: string): string | undefined {
  const category = workspaceActionCategory(id);
  return railActionColors[id] ?? workspaceCategories.find(item => item.id === category)?.color;
}
const labels: Record<string, string> = {
  "server-restart": "Manage",
  "surface-rooms": "Rooms",
  "surface-nous": "Nous", "surface-room-agent": "Room Agent", "surface-shared-chat": "Council", "surface-tasks": "Tasks", "surface-vault": "Vault",
  "surface-agent-files": "Agent Files", "surface-agent-sessions": "Sessions", "surface-media": "Media",
  "surface-clipboard": "Clipboard", "surface-links": "Links", "surface-settings": "Settings",
  "surface-cli": "CLI tools",
  "surface-source-control": "Source Control",
  "surface-health": "Health", "surface-streaming": "Streaming", "memory-workspace": "Memory", "space-gateway": "Space Gateway",
  "add-files": "File Manager", "add-demos": "Demo Projects", "add-jobs": "Job Copilot", "add-mail": "Mail Copilot", "add-marketing": "Marketing Copilot", "add-freelance": "Freelance Copilot", "add-design": "Design", "add-app-studio": "App Studio", "add-vault": "Vault", "add-empty-slots": "Empty slots",
  "system-analytics": "System analytics", "system-services": "System services", "system-resources": "System resources",
  "pane-layout": "Pane layout", "font-down": "Text size", "resources": "Resources", "workspace-room": "Room",
  "desktop-displays": "Displays", "room-toolbar": "Room toolbar",
  "resource-indicators": "Resource indicators", "cli-floats": "CLI controls", "sensitive-data": "Hide sensitive data",
  "debug-mode": "Debug (App diagnostics)",
  "gateway-compression": "Context compression",
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
  "widget-ai-quota": "AI Quota & Usage",
  "widget-streaming-metrics": "Streaming metrics"
};
export function workspaceActionLabel(action: IconToolbarAction) { return labels[action.id] ?? action.label; }
export function workspaceActionToggle(action: IconToolbarAction): boolean | undefined {
  if (action.id === "browser-fullscreen") return Boolean(action.ariaPressed);
  if (action.id === "cli-floats") return !action.ariaPressed;
  if (action.id.startsWith("widget-") || ["resource-indicators", "sensitive-data", "debug-mode", "gateway-compression", "osk-keyboard", "vibe-music", "live-model", "minimized-bar"].includes(action.id)) return Boolean(action.ariaPressed);
  return undefined;
}
