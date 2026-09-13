import type { IconToolbarAction } from "../../icon-toolbar.js";

export const workspaceCategories = [
  { id: "work", label: "Work" },
  { id: "view", label: "View" },
  { id: "tools", label: "Tools" },
  { id: "settings", label: "Settings" }
] as const;
export type WorkspaceCategory = typeof workspaceCategories[number]["id"];
export const workspaceQuickActionIds = ["pane-layout", "font-down", "resources"];

export function workspaceActionCategory(id: string): WorkspaceCategory {
  if (["surface-settings", "theme", "sensitive-data", "advanced-settings", "help", "setup-connections", "sign-out"].includes(id)) return "settings";
  if (["pane-layout", "pane-span-all", "font-down", "category-color-filter", "cli-floats", "resource-indicators", "resources", "room-focus", "previous-room", "next-room", "rename-room"].includes(id)) return "view";
  if (["surface-logs", "surface-agent-tools", "surface-cli", "surface-health", "surface-streaming"].includes(id)) return "tools";
  if (id.startsWith("surface-") || id === "memory-workspace") return "work";
  return "tools";
}
const labels: Record<string, string> = {
  "surface-rooms": "Rooms",
  "surface-room-agent": "Room Agent", "surface-shared-chat": "Shared chat", "surface-tasks": "Tasks",
  "surface-agent-files": "Agent Files", "surface-agent-sessions": "Sessions", "surface-media": "Media",
  "surface-clipboard": "Clipboard", "surface-links": "Links", "surface-settings": "Settings",
  "surface-logs": "Activity log", "surface-agent-tools": "Agent tools", "surface-cli": "CLI tools",
  "surface-health": "Health", "surface-streaming": "Streaming", "memory-workspace": "Memory",
  "pane-layout": "Layout", "font-down": "Text size", "resources": "Resources",
  "resource-indicators": "Resource indicators", "cli-floats": "CLI controls", "sensitive-data": "Hide sensitive data"
};
export function workspaceActionLabel(action: IconToolbarAction) { return labels[action.id] ?? action.label; }
export function workspaceActionToggle(action: IconToolbarAction): boolean | undefined {
  if (action.id === "cli-floats") return !action.ariaPressed;
  if (["resource-indicators", "sensitive-data", "osk-keyboard"].includes(action.id)) return Boolean(action.ariaPressed);
  return undefined;
}
