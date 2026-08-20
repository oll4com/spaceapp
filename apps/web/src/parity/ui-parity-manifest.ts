import type { Pane } from "@space/contracts";

export const UI_PARITY_MANIFEST_VERSION = "space-ui-parity-v1" as const;

export const UI_PARITY_VIEWPORTS = [
  { id: "desktop", width: 1365, height: 900 },
  { id: "laptop", width: 1280, height: 800 },
  { id: "tablet", width: 834, height: 1112 },
  { id: "mobile", width: 390, height: 844 }
] as const;

export const UI_PARITY_PANE_MODES = [
  "CHAT", "CODE", "BROWSER", "REVIEW", "SWARM", "DESIGN", "TERMINAL", "YOUTUBE", "VNC"
] as const satisfies readonly Pane["mode"][];

export const UI_PARITY_REACHABLE_STATES = [
  "loading", "empty", "ready", "disabled", "error",
  "authenticated", "unauthenticated", "login-error",
  "idle", "running", "stopped", "completed", "interrupted",
  "maximized", "minimized", "focused", "selected",
  "desktop-menu", "tablet-drawer", "mobile-drawer", "confirmation-dialog"
] as const;

export type UiParitySurface =
  | "auth" | "rooms" | "toolbar" | "pane" | "chat" | "cli" | "browser" | "youtube" | "vnc"
  | "review" | "code" | "swarm" | "design" | "media" | "streaming" | "clipboard" | "tasks" | "links"
  | "settings" | "health" | "memory" | "quick-links" | "help" | "music"
  | "admin" | "responsive";

export type UiParityAction = {
  id: string;
  surface: UiParitySurface;
  action: string;
  runtimes: readonly ["live", "demo"];
  exercisedBy: readonly string[];
};

export const UI_PARITY_SURFACE_EVIDENCE = {
  auth: ["tests/smoke.test.tsx", "tests/demo-app.test.tsx"],
  rooms: ["tests/responsive-shell.test.tsx", "tests/demo-store.test.ts", "tests/room-pane-composer.test.tsx"],
  toolbar: ["tests/responsive-shell.test.tsx", "tests/toolbar-metrics.test.tsx", "tests/demo-app.test.tsx"],
  pane: ["tests/responsive-shell.test.tsx", "tests/pane-layout-menu.test.tsx"],
  chat: ["tests/agent-pane.test.tsx", "tests/codex-chat-ui.test.tsx", "tests/demo-app.test.tsx"],
  cli: ["tests/terminal-pane.test.tsx", "tests/terminal-pane-upload.test.tsx", "tests/cli-launcher-menu.test.tsx"],
  browser: ["tests/browser-pane.test.tsx", "tests/browser-canvas.test.tsx"],
  youtube: ["tests/youtube-pane.test.tsx"],
  review: ["tests/smoke.test.tsx", "tests/demo-app.test.tsx"],
  code: ["tests/smoke.test.tsx", "tests/demo-app.test.tsx"],
  swarm: ["tests/smoke.test.tsx", "tests/demo-app.test.tsx"],
  design: ["tests/smoke.test.tsx", "tests/demo-app.test.tsx"],
  media: ["tests/media-dock.test.tsx", "tests/demo-app.test.tsx"],
  streaming: ["tests/streaming-dock.test.tsx", "tests/streaming-overlay.test.tsx", "tests/streaming-demo.test.tsx"],
  clipboard: ["tests/clipboard-dock.test.tsx", "tests/clipboard-capture.test.tsx", "tests/demo-app.test.tsx"],
  tasks: ["tests/task-dock.test.tsx", "tests/demo-store.test.ts"],
  links: ["tests/user-links.test.tsx", "tests/responsive-shell.test.tsx", "tests/demo-app.test.tsx"],
  settings: ["tests/smoke.test.tsx", "tests/telegram-integration-card.test.tsx", "tests/demo-app.test.tsx"],
  health: ["tests/smoke.test.tsx", "tests/demo-app.test.tsx"],
  memory: ["tests/memory-workspace.test.tsx", "tests/desktop-memory-graph.test.tsx", "tests/demo-app.test.tsx"],
  "quick-links": ["tests/responsive-shell.test.tsx", "tests/demo-app.test.tsx"],
  help: ["tests/help-navigation.test.tsx", "tests/help-page.test.tsx"],
  music: ["tests/vibe-music-player.test.tsx", "tests/responsive-shell.test.tsx"],
  vnc: ["tests/vnc-pane.test.tsx", "tests/demo-app.test.tsx"],
  admin: ["tests/admin-codex-tools.test.tsx", "tests/responsive-shell.test.tsx", "tests/demo-app.test.tsx"],
  responsive: ["tests/responsive-shell.test.tsx", "tests/icon-toolbar-scroll.test.tsx"]
} as const satisfies Record<UiParitySurface, readonly string[]>;

function actions(surface: UiParitySurface, names: readonly string[]): UiParityAction[] {
  return names.map((action) => ({
    id: `${surface}.${action}`,
    surface,
    action,
    runtimes: ["live", "demo"],
    exercisedBy: UI_PARITY_SURFACE_EVIDENCE[surface]
  }));
}

export const UI_PARITY_ACTIONS = [
  ...actions("auth", [
    "load-authenticated", "load-unauthenticated", "submit-login", "login-error", "sign-out", "sign-in-again"
  ]),
  ...actions("rooms", [
    "select", "previous", "next", "rename", "reorder", "delete-confirm", "delete-cancel",
    "create-2", "create-3", "create-6", "create-8", "create-16", "pane-cap-16",
    "compose-pane-mix", "compose-all-codex", "compose-runtime-disabled", "compose-capacity-disabled"
  ]),
  ...actions("toolbar", [
    "metric-all", "metric-cli", "metric-ram", "metric-cpu", "metric-swap", "metric-provider",
    "toggle-rooms", "toggle-room-agent", "toggle-media", "toggle-clipboard", "toggle-tasks", "toggle-links",
    "toggle-settings", "toggle-health", "open-memory", "open-quick-links", "pane-layout",
    "room-theme", "toggle-cli-floats", "workspace-text-size", "add-chat", "add-cli",
    "add-browser", "add-youtube", "add-review", "reload", "clip-tool", "print", "add-root-cli",
    "server-actions", "more-actions", "music", "help", "maximize-room", "restore-room"
  ]),
  ...actions("pane", [
    "rename", "import-files", "generate-title", "move", "split-add", "grow", "reset-width",
    "target", "more-actions", "maximize", "restore", "minimize", "restore-minimized",
    "restore-all", "close-confirm", "close-cancel", "responsive-select"
  ]),
  ...actions("chat", [
    "load-transcript", "compose", "send", "attach", "voice", "model", "reasoning",
    "collaboration-mode", "goal-create", "goal-clear", "run", "stop", "completed", "error",
    "copy", "reconnect", "resume-history", "save-memory"
  ]),
  ...actions("cli", [
    "launch-codex", "launch-claude", "launch-opencode", "launch-kimi", "launch-grok", "launch-root",
    "attach", "input", "local-reply", "upload", "image-preview", "model", "reasoning",
    "plan-mode", "resume", "interrupt", "copy", "reconnect", "save-memory", "ended-float"
  ]),
  ...actions("browser", [
    "start", "stop", "new-tab", "activate-tab", "close-tab", "url-input", "navigate",
    "viewport-desktop", "viewport-tablet", "viewport-mobile", "stream-auto", "stream-silent",
    "stream-preview", "stream-interactive", "stream-realtime", "join", "release-control",
    "expand", "bookmarks", "bookmark-add", "bookmark-open", "bookmark-import", "bookmark-export",
    "capture", "record", "record-stop", "record-cancel", "diagnostics", "playback"
  ]),
  ...actions("youtube", [
    "render-pane-mode", "start", "url-lock", "stream-realtime", "live", "input", "reload", "retry", "empty"
  ]),
  ...actions("vnc", [
    "render-pane-mode", "connect-dialog", "preset-select", "custom-host", "password",
    "connect", "disconnect", "fullscreen", "connected", "connecting", "error", "closed", "empty"
  ]),
  ...actions("review", [
    "render-pane-mode", "empty", "latest-turn", "running", "completed", "error"
  ]),
  ...actions("code", [
    "render-pane-mode", "empty", "latest-turn", "running", "completed", "error"
  ]),
  ...actions("swarm", [
    "render-pane-mode", "empty", "latest-turn", "running", "completed", "error"
  ]),
  ...actions("design", [
    "render-pane-mode", "empty", "latest-turn", "running", "completed", "error"
  ]),
  ...actions("media", [
    "load", "upload", "preview", "open", "retention", "delete-confirm", "delete-cancel", "empty", "error"
  ]),
  ...actions("streaming", [
    "provider-readiness", "connect-another", "verify-account", "remove-account", "disconnect-authorization",
    "toggle-metrics", "tile-limit-12", "drag-order", "keyboard-order", "analytics-period",
    "draft-preview", "save-overlay", "session-activation", "stale", "offline", "classic", "modern"
  ]),
  ...actions("clipboard", [
    "load", "search", "filter", "create", "copy", "delete", "clear-confirm", "clear-cancel", "pause", "empty", "error"
  ]),
  ...actions("tasks", [
    "load", "search", "filter", "create", "status", "copy", "start", "delete", "clear-confirm", "clear-cancel", "empty", "error"
  ]),
  ...actions("links", [
    "load", "search", "create", "edit", "quick-toggle", "open-same-tab", "open-new-tab",
    "delete-confirm", "delete-cancel", "empty", "error"
  ]),
  ...actions("settings", [
    "provider", "telegram-refresh", "voice-refresh", "voice-enabled", "voice-language",
    "voice-insert", "cli-preview-limit", "agent-refresh", "agent-tools",
    "toolbar-customize", "reset-local-settings", "error"
  ]),
  ...actions("health", [
    "ready", "launch-readiness", "storage", "worker", "observability", "events", "runtime",
    "audit", "imports", "tools", "loading", "error"
  ]),
  ...actions("memory", [
    "open", "overview", "graph", "search", "node", "issues", "issue-update", "change-sets",
    "change-create", "change-review", "change-execute", "change-reconcile", "rollback",
    "consolidation-audit", "consolidation-repair", "empty", "error", "close"
  ]),
  ...actions("quick-links", [
    "open", "search", "activate", "empty", "error", "close"
  ]),
  ...actions("help", [
    "open", "direct-route", "back-workspace", "keyboard", "mobile"
  ]),
  ...actions("music", [
    "open", "play", "pause", "volume", "station", "persistent-playback", "metadata-error", "close"
  ]),
  ...actions("admin", [
    "restart-open", "restart-confirm", "restart-cancel", "history-preview", "history-confirm",
    "history-cancel", "cli-reap", "memory-reclaim", "provider-switch", "speed-defaults",
    "mcp-smoke", "memory-smoke", "codex-handshake", "codex-turn-smoke", "diagnostics",
    "local-simulated-status"
  ]),
  ...actions("responsive", [
    "desktop-shell", "tablet-shell", "mobile-shell", "mobile-room-focus", "mobile-pane-switcher",
    "mobile-room-drawer", "mobile-action-sheet", "focus-trap", "escape-restore", "toolbar-wrap",
    "title-overflow", "loading", "empty", "disabled", "error"
  ])
] as const satisfies readonly UiParityAction[];
