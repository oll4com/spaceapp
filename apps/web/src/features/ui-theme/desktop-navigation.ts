export type DesktopGroup = "rooms" | "create" | "workspace" | "tools" | "help" | "admin";
export const desktopGroups: { id: DesktopGroup; label: string }[] = [
  { id: "create", label: "Create" },
  { id: "workspace", label: "Workspace" },
  { id: "help", label: "Help" },
  { id: "admin", label: "Admin" }
];
const adminActions = new Set(["advanced-settings", "server-restart", "add-root-admin-cli", "surface-health", "token-usage", "surface-streaming", "benchmark"]);
export function desktopActionGroup(id: string): DesktopGroup {
  if (adminActions.has(id)) return "admin";
  if (id === "surface-rooms" || ["room-focus", "previous-room", "next-room"].includes(id)) return "rooms";
  if (id.startsWith("add-")) return "create";
  if (["help", "setup-connections", "sign-out", "reload-room", "print-window"].includes(id)) return "help";
  return "workspace";
}
export function desktopActionVisible(id: string, adminMode: boolean): boolean {
  return !["more-actions", "room-focus"].includes(id) && (adminMode || !adminActions.has(id));
}
export const desktopActionDescriptions: Record<string, string> = {
  "advanced-settings": "All installation settings, providers, connections, and diagnostics.",
  "surface-rooms": "Choose a room, create one, or organize your workspace.",
  "surface-room-agent": "Ask an assistant to coordinate work in this room.",
  "surface-shared-chat": "A shared conversation for everyone in the room.",
  "surface-media": "Images, recordings, and other media.",
  "surface-streaming": "Manage live broadcasts and overlays.",
  "surface-agent-files": "Preview and download files created by agents.",
  "surface-clipboard": "Saved text, notes, and plans.",
  "surface-tasks": "Follow tasks and their progress.",
  "surface-links": "Bookmarks and browser connections.",
  "surface-settings": "Appearance, notifications, and session preferences.",
  "token-usage": "Daily, weekly, and monthly token totals by provider and model.",
  "surface-health": "Inspect service health and connection status.",
  "surface-logs": "Review recent workspace activity.",
  "surface-agent-tools": "Browse tools and capabilities available to agents.",
  "surface-cli": "Manage coding tools and their connections.",
  "surface-agent-sessions": "Find previous work and resume sessions.",
  "add-cli": "Run an AI coding assistant in a terminal.",
  "add-chat": "Start a conversation with an AI assistant.",
  "add-browser": "Browse the web inside this room.",
  "add-harness": "Open a DeepSeek Harness coding session.",
  "add-live": "Start a live audio conversation with Gemini memory access.",
  "add-youtube": "Watch a video alongside your work.",
  "add-vnc": "Connect to a remote desktop.",
  "add-root-admin-cli": "Open a terminal with host administrator access.",
  "pane-layout": "Choose how panes are arranged in this room.",
  "pane-span-all": "Adjust the width of every pane.",
  "theme": "Choose a color theme for this room.",
  "font-down": "Adjust text size across your workspace.",
  "category-color-filter": "Show panes with a selected category color.",
  "resource-indicators": "Show live resource values and health alerts at the top right.",
  "cli-floats": "Show or hide floating CLI controls.",
  "sensitive-data": "Control whether private values are visible on screen.",
  "memory-workspace": "Search and organize what your agents remember.",
  "quick-links": "Open a favorite website quickly.",
  "clip-tool": "Capture an image to share with a pane.",
  "osk-keyboard": "Send special keys using an on-screen keyboard.",
  "vibe-music": "Listen to music while you work.",
  "server-restart": "Setup, updates, cleanup, and guarded server operations.",
  "setup-connections": "Set up missing tools or reconnect an account.",
  "help": "Learn about rooms, panes, and everyday actions.",
  "benchmark": "Measure model performance and compare results.",
  "room-focus": "Change how much screen space this room uses.",
  "reload-room": "Reload the app in this browser.",
  "vpn-city": "Rotate to a new egress city for NordVPN or Mullvad.",
  "print-window": "Print the current view.",
  "sign-out": "End your Space login on this browser."
};
