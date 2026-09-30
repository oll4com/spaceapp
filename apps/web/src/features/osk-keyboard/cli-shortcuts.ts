export type OskCliCommand = {
  id: string;
  label: string;
  text: string;
  enter?: boolean;
  action?: "plan" | "build" | "permissions";
  icon?: string;
};

export const OSK_ESC_COMMAND: OskCliCommand = { id: "esc", label: "Esc", text: "\u001b" };
export const OSK_ENTER_COMMAND: OskCliCommand = { id: "enter", label: "Enter", text: "\r" };

export const OSK_CLI_COMMANDS: readonly OskCliCommand[] = [
  { id: "continue", label: "continue", text: "continue", enter: true, icon: "Play" },
  { id: "memory", label: "Save to memory", text: "save to memory", enter: true, icon: "Save" },
  { id: "plan", label: "Plan mode", text: "", action: "plan", icon: "ClipboardList" },
  { id: "build", label: "Build mode", text: "", action: "build", icon: "Wrench" },
  { id: "plan_progress", label: "Plan completion percentage", text: "Plan completion percentage", enter: true, icon: "Gauge" },
  { id: "deploy", label: "Deploy", text: "Deploy the project to Gitea and GitHub.", enter: true, icon: "Rocket" },
  { id: "permissions", label: "Permissions", text: "", action: "permissions", icon: "Shield" },
  { id: "model", label: "/model", text: "/model", enter: true, icon: "BrainCircuit" },
  { id: "resume", label: "/resume", text: "/resume", enter: true, icon: "History" },
  { id: "usage", label: "/usage", text: "/usage", enter: true, icon: "Activity" },
  { id: "clear", label: "/clear", text: "/clear", enter: true, icon: "Eraser" },
  { id: "help", label: "/help", text: "/help", enter: true, icon: "CircleHelp" },
  { id: "status", label: "/status", text: "/status", enter: true, icon: "Radio" },
  { id: "test", label: "test", text: "test", enter: true, icon: "Terminal" },
  {
    id: "clean_worktree",
    label: "Clean worktree",
    text: "Inspect the worktree and workspace: check what changes have already landed in live/production versus unmerged work, safely archive or clean up leftover junk, temporary artifacts, and completed task directories, and keep only folders with active unfinished projects.",
    enter: true,
    icon: "Archive"
  }
] as const;

export const CLEAN_WORKTREE_PROMPT = OSK_CLI_COMMANDS.find((c) => c.id === "clean_worktree")!.text;



export type CliModeShortcut = { text: string; enter: boolean; prefix?: string } | { unavailable: string };

// Commands refer to the installed native TUIs, not provider/model names.
export function resolveCliModeShortcut(runtimeId: string, action: "plan" | "build" | "permissions"): CliModeShortcut {
  if (action === "build") {
    if (runtimeId === "cli:autohand") return { text: "/plan off", enter: true };
    if (runtimeId === "cli:qwen") return { text: "/approval-mode default", enter: true };
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
    "cli:hermes": ["/plan", "/yolo"]
  };
  // Hermes /plan starts a task; let the operator supply that task before submitting.
  if (runtimeId === "cli:hermes" && action === "plan") return { text: "/plan ", enter: false };
  if (["cli:copilot", "cli:gemini"].includes(runtimeId) && action === "plan") return { text: "\u001b[Z", enter: false };
  if (runtimeId === "cli:deepseek") return { text: action === "plan" ? "\u001b[Z" : "\u0019", enter: false };
  if (runtimeId === "cli:opencode") {
    if (action === "plan") return { text: "\t", enter: false };
    return { prefix: "\u0010", text: "auto-approve permissions", enter: false };
  }
  const command = commands[runtimeId]?.[action === "plan" ? 0 : 1];
  return command ? { text: command, enter: true } : { unavailable: "This CLI does not expose this mode control." };
}
