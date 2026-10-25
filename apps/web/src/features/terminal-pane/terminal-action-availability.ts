import { resolveCliModeShortcut } from "../osk-keyboard/cli-shortcuts.js";

export type TerminalActionAvailability = {
  /** Any session (normal or login) has been loaded for the pane. */
  hasSession: boolean;
  /** Active NORMAL (non-login) session. */
  sessionActive: boolean;
  /** The terminal socket is attached and ready for input. */
  attached: boolean;
  /** This page may type into the terminal (not an observer or read-only proof view). */
  controllable: boolean;
  turnRunning: boolean;
  /** The screen changed in the last few seconds (spinners and timers keep redrawing while a CLI works). */
  screenActive: boolean;
  /** Stop was just sent; a second Ctrl+C in quick succession exits several CLIs. */
  stopCooldown: boolean;
  hasDraft: boolean;
  /** A session request or reconnect is in flight. */
  requestPending: boolean;
  /** A CLI shortcut or Plan mode change is in flight. */
  shortcutPending: boolean;
  uploading: boolean;
  /** Native mode read from the CLI footer; null when it is not visible. */
  planMode: "plan" | "build" | "other" | null;
  /** The CLI has drawn its prompt footer at least once in this session, so it finished starting. */
  promptSeen: boolean;
  /** The CLI runtime registry has loaded the pane's runtime, so New task can start it. */
  runtimeReady: boolean;
};

export function terminalActionAvailabilityEqual(left: TerminalActionAvailability, right: TerminalActionAvailability): boolean {
  return (Object.keys(left) as Array<keyof TerminalActionAvailability>).every((key) => left[key] === right[key]);
}

// Plan mode is typed natively (/plan) or cycled (Claude) by dedicated handlers for these runtimes.
const DEDICATED_PLAN_RUNTIMES = new Set(["cli:claude", "cli:gemini", "cli:qwen", "cli:omp"]);

export function terminalRuntimeHasPlanMode(runtimeId: string): boolean {
  return DEDICATED_PLAN_RUNTIMES.has(runtimeId) || !("unavailable" in resolveCliModeShortcut(runtimeId, "plan"));
}

// CLIs whose idle prompt footer always shows the native mode (cli-build-mode.ts, Claude's mode line).
// Until it first appears the TUI is still starting and swallows keys and typed text.
const PROMPT_FOOTER_RUNTIMES = new Set(["cli:opencode", "cli:codex", "cli:claude", "cli:cursor", "cli:gemini", "cli:deepseek", "cli:copilot"]);
const PROMPT_INPUT_ACTIONS = new Set(["plan", "memory", "paste", "paste_file", "import"]);

/** Interrupt keys other than Esc (Ctrl+C) exit most CLIs on a second press, so Stop needs a running turn. */
function stopNeedsRunningTurn(runtimeId: string): boolean {
  return runtimeId !== "cli:root";
}

/**
 * Why a CLI pane menu action cannot run right now, or null when it can. Every reason is shown as the
 * item's tooltip so a disabled item still explains itself.
 */
export function terminalActionDisabledReason(
  actionId: string,
  runtimeId: string,
  availability: TerminalActionAvailability | null,
  clipboardReadable: boolean
): string | null {
  if (actionId === "plan" && !terminalRuntimeHasPlanMode(runtimeId)) return "This CLI has no Plan mode control.";
  if (actionId === "new-task") {
    if (!availability?.runtimeReady) return "The CLI runtime is still loading.";
    return availability.requestPending ? "A CLI session request is in progress." : null;
  }
  if (actionId === "reconnect") return availability?.requestPending ? "Reconnecting…" : null;
  if (actionId === "copy") return availability?.hasSession ? null : "There is no CLI output to copy yet.";
  if (!["stop", "plan", "memory", "paste", "paste_file", "import"].includes(actionId)) return null;
  if (!availability?.sessionActive) return "Attach a running CLI first.";
  if (!availability.controllable) return "This terminal is read-only in this page.";
  if (PROMPT_INPUT_ACTIONS.has(actionId) && PROMPT_FOOTER_RUNTIMES.has(runtimeId) && !availability.promptSeen) {
    return "Wait for the CLI to finish starting.";
  }
  if (actionId === "import" || actionId === "paste_file") {
    if (availability.uploading) return "An upload is in progress.";
    if (actionId === "paste_file" && !clipboardReadable) return "This page cannot read the clipboard.";
    return null;
  }
  if (actionId === "paste") return clipboardReadable ? null : "This page cannot read the clipboard.";
  if (!availability.attached) return "Wait for the CLI to finish connecting.";
  if (actionId === "stop") {
    if (availability.stopCooldown) return "Stop was just sent. Wait a moment before sending it again.";
    // Typing also redraws the screen, so screen activity only counts with an empty prompt.
    const turnLikelyRunning = availability.turnRunning || (availability.screenActive && !availability.hasDraft);
    return stopNeedsRunningTurn(runtimeId) && !turnLikelyRunning ? "No running CLI task to stop." : null;
  }
  if (actionId === "plan") {
    if (availability.planMode === "plan") return "Plan mode is already on.";
    if (availability.shortcutPending) return "Another CLI shortcut is still running.";
    // Claude cycles modes with Shift+Tab, which works mid-turn and keeps the draft.
    if (runtimeId === "cli:claude") return null;
  }
  if (availability.turnRunning) return "Wait for the current CLI turn to finish.";
  if (availability.hasDraft) return "Send or clear the current CLI draft first.";
  return null;
}
