import { describe, expect, it } from "vitest";
import {
  terminalActionAvailabilityEqual,
  terminalActionDisabledReason,
  terminalRuntimeHasPlanMode,
  type TerminalActionAvailability
} from "../src/features/terminal-pane/terminal-action-availability.js";

const ready: TerminalActionAvailability = {
  hasSession: true,
  sessionActive: true,
  attached: true,
  controllable: true,
  turnRunning: false,
  screenActive: false,
  stopCooldown: false,
  hasDraft: false,
  requestPending: false,
  shortcutPending: false,
  uploading: false,
  planMode: "build",
  promptSeen: true,
  runtimeReady: true
};

const AGENT_RUNTIMES = [
  "cli:opencode", "cli:codex", "cli:claude", "cli:gemini", "cli:autohand", "cli:qwen", "cli:kimi", "cli:grok",
  "cli:deepseek", "cli:cursor", "cli:copilot", "cli:hermes", "cli:omp", "cli:qoder", "cli:muse", "cli:droid"
];
const MENU_ACTIONS = ["new-task", "stop", "plan", "memory", "copy", "paste", "paste_file", "import", "reconnect"];
const reason = (actionId: string, runtimeId: string, availability: TerminalActionAvailability | null = ready, clipboard = true) =>
  terminalActionDisabledReason(actionId, runtimeId, availability, clipboard);

describe("CLI pane action availability", () => {
  it("offers Plan mode only for runtimes with a native Plan control", () => {
    // Muse has no Plan mode; the pane menu also hides Plan for it (cliModeShortcutAvailable).
    expect(AGENT_RUNTIMES.filter((runtimeId) => !terminalRuntimeHasPlanMode(runtimeId))).toEqual(["cli:muse"]);
    expect(reason("plan", "cli:muse")).toBe("This CLI has no Plan mode control.");
  });

  it.each(AGENT_RUNTIMES)("keeps every %s action that can run on an idle attached CLI enabled", (runtimeId) => {
    const disabled = Object.fromEntries(MENU_ACTIONS.map((actionId) => [actionId, reason(actionId, runtimeId)]).filter(([, value]) => value));
    const expected: Record<string, string> = { stop: "No running CLI task to stop." };
    if (!terminalRuntimeHasPlanMode(runtimeId)) expected.plan = "This CLI has no Plan mode control.";
    expect(disabled).toEqual(expected);
  });

  it("disables session actions until a CLI is attached and controllable", () => {
    for (const actionId of ["stop", "plan", "memory", "paste", "paste_file", "import"]) {
      expect(reason(actionId, "cli:codex", null)).toBe("Attach a running CLI first.");
      expect(reason(actionId, "cli:codex", { ...ready, sessionActive: false, attached: false })).toBe("Attach a running CLI first.");
      expect(reason(actionId, "cli:codex", { ...ready, controllable: false })).toBe("This terminal is read-only in this page.");
    }
    for (const actionId of ["stop", "plan", "memory"]) {
      expect(reason(actionId, "cli:codex", { ...ready, attached: false, turnRunning: true })).toBe("Wait for the CLI to finish connecting.");
    }
    // Upload and paste queue input until the socket reattaches.
    expect(reason("import", "cli:codex", { ...ready, attached: false })).toBeNull();
    expect(reason("paste", "cli:codex", { ...ready, attached: false })).toBeNull();
    expect(reason("copy", "cli:codex", null)).toBe("There is no CLI output to copy yet.");
  });

  it("waits for a starting CLI to draw its prompt before sending keys or text into it", () => {
    const starting = { ...ready, planMode: null, promptSeen: false };
    for (const actionId of ["plan", "memory", "paste", "paste_file", "import"]) {
      expect(reason(actionId, "cli:opencode", starting)).toBe("Wait for the CLI to finish starting.");
      expect(reason(actionId, "cli:codex", starting)).toBe("Wait for the CLI to finish starting.");
    }
    // Copy, New task and Reconnect never type into the CLI; Stop follows the turn.
    for (const actionId of ["copy", "new-task", "reconnect"]) expect(reason(actionId, "cli:opencode", starting)).toBeNull();
    // CLIs without a reliable prompt footer cannot be read, so they are not held back.
    expect(reason("memory", "cli:kimi", starting)).toBeNull();
    // Once seen, a later turn that hides the footer does not disable pasting again.
    expect(reason("paste", "cli:codex", { ...ready, planMode: null })).toBeNull();
  });

  it("lets screen activity enable Stop when the turn heuristics miss a running task", () => {
    expect(reason("stop", "cli:gemini", { ...ready, screenActive: true })).toBeNull();
    // Typing redraws the prompt too; that is not a running task.
    expect(reason("stop", "cli:gemini", { ...ready, screenActive: true, hasDraft: true })).toBe("No running CLI task to stop.");
    expect(reason("stop", "cli:gemini", { ...ready, turnRunning: true, stopCooldown: true })).toBe(
      "Stop was just sent. Wait a moment before sending it again."
    );
  });

  it("only allows Stop while a turn runs, except in the root shell", () => {
    expect(reason("stop", "cli:gemini")).toBe("No running CLI task to stop.");
    expect(reason("stop", "cli:gemini", { ...ready, turnRunning: true })).toBeNull();
    expect(reason("stop", "cli:opencode", { ...ready, turnRunning: true })).toBeNull();
    expect(reason("stop", "cli:root")).toBeNull();
  });

  it("guards Plan mode and Save to memory against running turns, drafts and an active Plan mode", () => {
    expect(reason("plan", "cli:codex", { ...ready, planMode: "plan" })).toBe("Plan mode is already on.");
    expect(reason("plan", "cli:claude", { ...ready, planMode: "plan" })).toBe("Plan mode is already on.");
    expect(reason("plan", "cli:codex", { ...ready, turnRunning: true })).toBe("Wait for the current CLI turn to finish.");
    expect(reason("plan", "cli:gemini", { ...ready, hasDraft: true })).toBe("Send or clear the current CLI draft first.");
    expect(reason("plan", "cli:opencode", { ...ready, shortcutPending: true })).toBe("Another CLI shortcut is still running.");
    // Claude's Shift+Tab cycle works mid-turn and keeps the draft.
    expect(reason("plan", "cli:claude", { ...ready, turnRunning: true, hasDraft: true })).toBeNull();
    expect(reason("memory", "cli:codex", { ...ready, turnRunning: true })).toBe("Wait for the current CLI turn to finish.");
    expect(reason("memory", "cli:codex", { ...ready, hasDraft: true })).toBe("Send or clear the current CLI draft first.");
  });

  it("disables clipboard, upload, New task and Reconnect while they cannot run", () => {
    expect(reason("paste", "cli:codex", ready, false)).toBe("This page cannot read the clipboard.");
    expect(reason("paste_file", "cli:codex", ready, false)).toBe("This page cannot read the clipboard.");
    expect(reason("import", "cli:codex", { ...ready, uploading: true })).toBe("An upload is in progress.");
    expect(reason("new-task", "cli:codex", { ...ready, runtimeReady: false })).toBe("The CLI runtime is still loading.");
    expect(reason("new-task", "cli:codex", null)).toBe("The CLI runtime is still loading.");
    expect(reason("new-task", "cli:codex", { ...ready, requestPending: true })).toBe("A CLI session request is in progress.");
    expect(reason("reconnect", "cli:codex", { ...ready, requestPending: true })).toBe("Reconnecting…");
    expect(reason("reconnect", "cli:codex", null)).toBeNull();
    expect(reason("move", "cli:codex", null)).toBeNull();
  });

  it("compares availability snapshots by value", () => {
    expect(terminalActionAvailabilityEqual(ready, { ...ready })).toBe(true);
    expect(terminalActionAvailabilityEqual(ready, { ...ready, hasDraft: true })).toBe(false);
  });
});
