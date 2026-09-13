export type OskCliCommand = {
  id: string;
  label: string;
  text: string;
  enter?: boolean;
  action?: "plan" | "build" | "permissions";
};

export const OSK_CLI_COMMANDS: readonly OskCliCommand[] = [
  { id: "continue", label: "continue", text: "continue", enter: true },
  { id: "memory", label: "Save to memory", text: "save to memory", enter: true },
  { id: "plan", label: "Plan mode", text: "", action: "plan" },
  { id: "build", label: "Build mode", text: "", action: "build" },
  { id: "plan_progress", label: "Plan completion percentage", text: "Plan completion percentage", enter: true },
  { id: "deploy", label: "Deploy", text: "Deploy the project to Gitea and GitHub.", enter: true },
  { id: "permissions", label: "Permissions", text: "", action: "permissions" },
  { id: "model", label: "/model", text: "/model", enter: true },
  { id: "resume", label: "/resume", text: "/resume", enter: true },
  { id: "usage", label: "/usage", text: "/usage", enter: true },
  { id: "clear", label: "/clear", text: "/clear", enter: true },
  { id: "help", label: "/help", text: "/help", enter: true },
  { id: "status", label: "/status", text: "/status", enter: true }
] as const;


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
