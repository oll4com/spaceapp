export type OskCliCommand = {
  id: string;
  label: string;
  text: string;
  enter?: boolean;
  action?: "plan" | "build" | "permissions" | "scroll_top" | "scroll_bottom";
  icon?: string;
};

export const OSK_ESC_COMMAND: OskCliCommand = { id: "esc", label: "Esc", text: "\u001b" };
export const OSK_ENTER_COMMAND: OskCliCommand = { id: "enter", label: "Enter", text: "\r" };

// Fixed display order, filled row by row into the two-column shortcuts menu.
// Usage never reorders it; Continue always takes the first (top-left) cell.
export const OSK_CLI_COMMANDS: readonly OskCliCommand[] = [
  { id: "continue", label: "continue", text: "continue", enter: true, icon: "Play" },
  { id: "plan_progress", label: "Plan completion percentage", text: "Plan completion percentage", enter: true, icon: "Gauge" },
  { id: "plan", label: "Plan mode", text: "", action: "plan", icon: "ClipboardList" },
  { id: "build", label: "Build mode", text: "", action: "build", icon: "Wrench" },
  { id: "permissions", label: "Permissions", text: "", action: "permissions", icon: "Shield" },
  { id: "model", label: "/model", text: "/model", enter: true, icon: "BrainCircuit" },
  { id: "memory", label: "Save to memory", text: "save to memory", enter: true, icon: "Save" },
  { id: "test", label: "test", text: "test", enter: true, icon: "Terminal" },
  { id: "deploy", label: "Deploy", text: "Deploy the project to Gitea and GitHub.", enter: true, icon: "Rocket" },
  { id: "promote", label: "Promote", text: "Promote the verified dev version to stable (space-queue promote --wait).", enter: true, icon: "ArrowUpCircle" },
  {
    id: "clean_worktree",
    label: "Clean worktree",
    text: "Inspect the worktree and workspace: check what changes have already landed in live/production versus unmerged work, safely archive or clean up leftover junk, temporary artifacts, and completed task directories, and keep only folders with active unfinished projects.",
    enter: true,
    icon: "Archive"
  },
  { id: "status", label: "/status", text: "/status", enter: true, icon: "Radio" },
  { id: "usage", label: "/usage", text: "/usage", enter: true, icon: "Activity" },
  { id: "resume", label: "/resume", text: "/resume", enter: true, icon: "History" },
  { id: "help", label: "/help", text: "/help", enter: true, icon: "CircleHelp" },
  { id: "scroll_top", label: "Scroll to top", text: "", action: "scroll_top", icon: "ArrowUpToLine" },
  { id: "scroll_bottom", label: "Scroll to bottom", text: "", action: "scroll_bottom", icon: "ArrowDownToLine" },
  // Destructive, so kept last and away from Continue.
  { id: "clear", label: "/clear", text: "/clear", enter: true, icon: "Eraser" }
] as const;

export const CLEAN_WORKTREE_PROMPT = OSK_CLI_COMMANDS.find((c) => c.id === "clean_worktree")!.text;
export const PROMOTE_PROMPT = OSK_CLI_COMMANDS.find((c) => c.id === "promote")!.text;

export const PINNED_CLI_SHORTCUT_ID = "continue";
// Runtime-specific transcript key (Codex Ctrl+T, Claude Code Ctrl+O); appended after the fixed list.
export const TRANSCRIPT_CLI_SHORTCUT_ID = "transcript";

// Shortcuts the operator may hide from the menu, in display order.
export const HIDEABLE_CLI_SHORTCUT_IDS: readonly string[] = [
  ...OSK_CLI_COMMANDS.map((command) => command.id).filter((id) => id !== PINNED_CLI_SHORTCUT_ID),
  TRANSCRIPT_CLI_SHORTCUT_ID
];

export function normalizeHiddenCliShortcuts(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const hidden = new Set(value.filter((id): id is string => typeof id === "string"));
  return HIDEABLE_CLI_SHORTCUT_IDS.filter((id) => hidden.has(id));
}

// Keeps the given order, drops hidden entries and never hides or moves Continue off the first cell.
export function orderVisibleCliShortcuts(commands: readonly OskCliCommand[], hiddenIds: readonly string[] = []): OskCliCommand[] {
  const hidden = new Set(hiddenIds);
  const visible = commands.filter((command) => command.id === PINNED_CLI_SHORTCUT_ID || !hidden.has(command.id));
  return [
    ...visible.filter((command) => command.id === PINNED_CLI_SHORTCUT_ID),
    ...visible.filter((command) => command.id !== PINNED_CLI_SHORTCUT_ID)
  ];
}



export type CliModeShortcut = { text: string; enter: boolean; prefix?: string } | { unavailable: string };

// TUIs whose current Plan/Build mode Space reads from the screen (cli-build-mode.ts).
const CLI_BUILD_MODE_RUNTIME_IDS: ReadonlySet<string> = new Set([
  "cli:opencode", "cli:codex", "cli:cursor", "cli:gemini", "cli:deepseek", "cli:copilot", "cli:claude",
  "cli:kimi", "cli:grok", "cli:hermes", "cli:omp", "cli:qoder", "cli:droid"
]);

const runtimeShortcutCommands = new Map<string, readonly OskCliCommand[]>();

/** The shortcut menu for one CLI: mode controls it does not have are left out instead of failing. */
export function cliShortcutCommandsForRuntime(runtimeId: string | null | undefined): readonly OskCliCommand[] {
  if (!runtimeId) return OSK_CLI_COMMANDS;
  let commands = runtimeShortcutCommands.get(runtimeId);
  if (!commands) {
    commands = OSK_CLI_COMMANDS.filter((command) =>
      command.action !== "plan" && command.action !== "build" && command.action !== "permissions"
        ? true
        : cliModeShortcutAvailable(runtimeId, command.action));
    runtimeShortcutCommands.set(runtimeId, commands);
  }
  return commands;
}

/** Whether a CLI has a native control for a mode shortcut, so menus can hide the ones it lacks. */
export function cliModeShortcutAvailable(runtimeId: string, action: "plan" | "build" | "permissions"): boolean {
  if (action === "build") {
    return runtimeId === "cli:autohand" || runtimeId === "cli:qwen" || CLI_BUILD_MODE_RUNTIME_IDS.has(runtimeId);
  }
  return !("unavailable" in resolveCliModeShortcut(runtimeId, action));
}

// Commands refer to the installed native TUIs, not provider/model names.
export function resolveCliModeShortcut(runtimeId: string, action: "plan" | "build" | "permissions"): CliModeShortcut {
  if (action === "build") {
    if (runtimeId === "cli:autohand") return { text: "/plan off", enter: true };
    if (runtimeId === "cli:qwen") return { text: "/approval-mode default", enter: true };
    if (!CLI_BUILD_MODE_RUNTIME_IDS.has(runtimeId)) return { unavailable: "This CLI does not expose this mode control." };
    // Remaining TUIs expose a mode cycle or a toggle, selected from live state.
    return { unavailable: "Build mode requires the current native CLI mode." };
  }
  const commands: Record<string, readonly [string, string]> = {
    "cli:codex": ["/plan", "/permissions"],
    "cli:claude": ["/plan", "/permissions"],
    "cli:gemini": ["/plan", "/permissions"],
    "cli:qwen": ["/plan", "/approval-mode"],
    "cli:autohand": ["/plan", "/permissions"],
    "cli:kimi": ["/plan", "/permission"],
    "cli:grok": ["/plan", "/always-approve"],
    "cli:cursor": ["/plan", "/settings"],
    "cli:copilot": ["/plan", "/permissions"],
    "cli:hermes": ["/plan", "/yolo"],
    // Oh My Pi and Qoder toggle Plan with /plan; Muse has /permissions but no Plan mode.
    "cli:omp": ["/plan", ""],
    "cli:qoder": ["/plan", ""],
    "cli:muse": ["", "/permissions"]
  };
  // Hermes /plan starts a task; let the operator supply that task before submitting.
  if (runtimeId === "cli:hermes" && action === "plan") return { text: "/plan ", enter: false };
  if (["cli:copilot", "cli:gemini"].includes(runtimeId) && action === "plan") return { text: "\u001b[Z", enter: false };
  if (runtimeId === "cli:deepseek") return { text: action === "plan" ? "\u001b[Z" : "\u0019", enter: false };
  // Qoder cycles its permission modes on Shift+Tab (app:cyclePermissionMode).
  if (runtimeId === "cli:qoder" && action === "permissions") return { text: "\u001b[Z", enter: false };
  // Droid toggles Spec mode on Shift+Tab and cycles its autonomy level on Ctrl+L.
  if (runtimeId === "cli:droid") return { text: action === "plan" ? "\u001b[Z" : "\u000c", enter: false };
  if (runtimeId === "cli:opencode") {
    if (action === "plan") return { text: "\t", enter: false };
    return { prefix: "\u0010", text: "auto-approve permissions", enter: false };
  }
  const command = commands[runtimeId]?.[action === "plan" ? 0 : 1];
  return command ? { text: command, enter: true } : { unavailable: "This CLI does not expose this mode control." };
}
