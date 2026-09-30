import { consolidatedResourceActions, consolidatedManageActions } from "../server-actions/manage-navigation.js";
export type DesktopGroup = "rooms" | "create" | "workspace" | "tools" | "help" | "admin";
export const desktopGroups: { id: DesktopGroup; label: string }[] = [
  { id: "create", label: "Create" },
  { id: "workspace", label: "Workspace" }
];
const adminActions = new Set(["advanced-settings", "server-restart", "add-root-admin-cli", "surface-health", "system-resources", "token-usage", "surface-streaming", "system-analytics", "system-services", "demo-mode"]);
export function desktopActionGroup(id: string): DesktopGroup {
  if (id === "surface-rooms" || ["room-focus", "previous-room", "next-room"].includes(id)) return "rooms";
  if (id.startsWith("add-")) return "create";
  if (id === "toggle-admin-mode") return "tools";
  return "workspace";
}
export function desktopActionVisible(id: string, adminMode: boolean): boolean {
  return !consolidatedResourceActions.has(id) && !consolidatedManageActions.has(id) && !["more-actions", "room-focus"].includes(id) && (adminMode || !adminActions.has(id));
}
export const desktopActionDescriptions: Record<string, string> = {
  "advanced-settings": "All installation settings, providers, connections, and diagnostics.",
  "surface-rooms": "Choose a room, create one, or organize your workspace.",
  "surface-room-agent": "Ask an assistant to coordinate work in this room.",
  "surface-shared-chat": "A shared conversation for everyone in the room.",
  "surface-media": "Images, recordings, and other media.",
  "surface-streaming": "Manage live broadcasts and overlays.",
  "surface-agent-files": "Preview and download files created by agents.",
  "add-files": "Open the native file manager pane in this room.",
  "add-demos": "Open the Demo Projects pane: run a demo, preview it live and check its connections.",
  "add-empty-slots": "Add or remove empty positions in this room.",
  "surface-clipboard": "Saved text, notes, and plans.",
  "surface-tasks": "Follow tasks and their progress.",
  "surface-links": "Bookmarks and browser connections.",
  "surface-settings": "Appearance, notifications, and session preferences.",
  "token-usage": "Daily, weekly, and monthly token totals by provider and model.",
  "surface-health": "Inspect service health and connection status.",
  "system-resources": "Live system resources, detached CLI sessions, memory & CPU analysis.",
  "resources": "Inspect system resources, quotas, and account limits.",
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
  "memory-workspace": "Search and organize what your agents remember with an interactive canonical memory graph.",
  "quick-links": "Open a favorite website quickly.",
  "clip-tool": "Capture an image to share with a pane.",
  "osk-keyboard": "Send special keys using an on-screen keyboard.",
  "vibe-music": "Listen to music while you work.",
  "sticky-note": "Open a floating sticky note on your workspace.",
  "widget-clock": "Floating desktop clock with 12h/24h format and date.",
  "widget-countdown-timer": "Floating countdown timer with Pomodoro presets.",
  "widget-pushup-reminder": "Floating periodic workout reminder for push-ups.",
  "widget-spaceapp-promo": "Floating banner promoting SpaceApp.dev (Free & Open Source).",
  "widget-ai-quota": "Floating AI quota monitor with live animated gauges for Codex, Gemini, and Claude.",
  "server-restart": "Setup, updates, cleanup, and guarded server operations.",
  "setup-connections": "Set up missing tools or reconnect an account.",
  "help": "Learn about rooms, panes, and everyday actions.",
  "benchmark": "Run the Asteroids AI Championship and compare every free OpenCode model.",
  "room-focus": "Change how much screen space this room uses.",
  "reload-room": "Reload the app in this browser.",
  "browser-fullscreen": "Toggle full screen browser mode (F11).",
  "debug-mode": "Toggle global debug diagnostics (debug-on / debug-off) and technical event capture.",
  "vpn-city": "Rotate to a new egress city for NordVPN or Mullvad.",
  "sign-out": "End your Space login on this browser.",
  "system-analytics": "Live system telemetry, model performance, CPU & RAM, and CLI sessions.",
  "system-services": "Inspect and control systemd services, background workers, and timers.",
  "demo-mode": "Explore all Space App features with an interactive step-by-step guided tour.",
  "previous-room": "Move to the previous room in the saved order.",
  "next-room": "Move to the next room in the saved order.",
  "live-model": "Start or stop live voice conversation.",
  "create": "Create a new pane in this room.",
  "docks": "Open side surfaces and workspace tools.",
  "minimized-bar": "Show or hide the minimized panes bar.",
  "toggle-admin-mode": "Switch between User mode and Admin mode."
};
