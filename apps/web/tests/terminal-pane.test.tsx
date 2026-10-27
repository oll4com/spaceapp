import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { AgentRuntime, Pane, PaneCliModelSettings } from "@space/contracts";
import { LiveSpaceApp as App } from "../src/live/LiveSpaceApp.js";
import { liveRuntime } from "../src/live/live-runtime.js";
import { SpaceRuntimeProvider } from "../src/runtime/SpaceRuntime.js";
import {
  accumulateTouchScrollLines,
  scrollXtermByTouchLines,
  terminalPendingInputAdmission,
  claudePlanModeShiftTabCount,
  floatingTurnPauseSequence,
  floatingTurnControlStopLabel,
  isTerminalScreenRunningText,
  buildTerminalCliSessionRequest,
  buildTerminalVoiceSubmit,
  cliReadyMatchesExpectedIdentity,
  createTerminalReconnectCoordinator,
  createTerminalReplayWriteQueue,
  encodeSgrMouseWheel,
  wheelDeltaPx,
  isNonMutatingTerminalProtocolResponse,
  isRetryableCliReconnectError,
  reasonixShortcutSequence,
  shouldReconnectTerminalSocket,
  nameTerminalInput,
  shouldRefocusTerminalAfterInput,
  shouldRefreshCliModelSettings,
  terminalControlKeySequence,
  TerminalPane
} from "../src/features/terminal-pane/TerminalPane.js";
import { CodexModelPicker } from "../src/features/codex-model-picker/CodexModelPicker.js";
import { terminalPlanModeAction } from "../src/features/pane-card/PaneCard.js";
import { openDesktopMenu, workspaceAction } from "./responsive-shell-fixture.js";
import { SpaceApiError } from "../src/runtime/SpaceRuntime.js";
import { VoiceInputProvider } from "../src/features/voice-input/VoiceInputProvider.js";

const csrfHeaderName = "x-space-csrf-token";
const readyRuntimeAuth = {
  adapterStatus: "ENABLED",
  authMode: "NONE",
  authState: "READY",
  authReason: "Runtime credentials are verified.",
  canStartLogin: false
} as const satisfies Pick<AgentRuntime, "adapterStatus" | "authMode" | "authState" | "authReason" | "canStartLogin">;

function paginated<T>(data: T[]) {
  return {
    data,
    pagination: { page: 1, pageSize: 100, totalItems: data.length, totalPages: data.length ? 1 : 0 }
  };
}

function pane(id: string, mode: "CHAT" | "TERMINAL" | "BROWSER", title: string, options: { fresh?: boolean } = {}): Pane {
  const createdAt = options.fresh === true ? new Date().toISOString() : "2026-07-05T00:00:00.000Z";
  return {
    id,
    roomId: "room:cli",
    title,
    titleSource: "auto",
    mode,
    status: "IDLE",
    providerId: null,
    modelId: null,
    reasoningEffort: "medium",
    cwd: "/opt/spaceapp",
    terminalRuntimeId: null,
    order: mode === "CHAT" ? 0 : mode === "TERMINAL" ? 1 : 2,
    columnSpan: 1,
    isMaximized: false,
    isMinimized: false,
    isClosed: false,
    split: { parentId: null, direction: null, size: null },
    categoryColor: null,
    vncTarget: null,
    createdAt,
    updatedAt: createdAt
  };
}

function selectableModelSettings(): PaneCliModelSettings {
  return {
    sessionId: "cli_session:model-picker",
    threadId: "11111111-1111-4111-8111-111111111111",
    current: { modelId: "gpt-5.6-mini", reasoningEffort: "medium" },
    models: [
      {
        id: "gpt-5.6-sol",
        displayName: "Sol",
        description: "Latest frontier model.",
        isDefault: true,
        defaultReasoningEffort: "max",
        supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
        reasoningOptions: [
          { reasoningEffort: "low", description: "Fast." },
          { reasoningEffort: "medium", description: "Balanced." },
          { reasoningEffort: "high", description: "Thorough." },
          { reasoningEffort: "xhigh", description: "Very thorough." },
          { reasoningEffort: "max", description: "Maximum." },
          { reasoningEffort: "ultra", description: "Ultimate." }
        ]
      },
      {
        id: "gpt-5.6-mini",
        displayName: "Mini",
        isDefault: false,
        defaultReasoningEffort: "medium",
        supportedReasoningEfforts: ["low", "medium", "high", "xhigh"]
      }
    ],
    controlMode: "DIRECT",
    isTurnActive: false
  };
}

function successfulModelSwitch(modelId: string, reasoningEffort: string) {
  return Promise.resolve({
    current: { modelId, reasoningEffort },
    message: null
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

// Since c91150ed5c the selected model row also renders its reasoning-effort badge ("MiniMedium").
const miniModelOption = /^Mini/;

describe("Space terminal panes", () => {
  it("scrolls the same number of CLI lines for one long touch or many short touch events", () => {
    const travel = [4, 6, 3, 7, 9, 5, 11, 6, 9];
    const trace = (moves: number[]) => moves.reduce((state, deltaY) => {
      const next = accumulateTouchScrollLines(state.pendingPx, deltaY, 18);
      return { lines: state.lines + next.lines, pendingPx: next.pendingPx };
    }, { lines: 0, pendingPx: 0 });
    expect(trace(travel)).toEqual(trace([travel.reduce((sum, value) => sum + value, 0)]));
    expect(trace([4, -4, 3, -3])).toEqual({ lines: 0, pendingPx: 0 });
    expect(trace([17, 1, -1, -17])).toEqual({ lines: 0, pendingPx: 0 });
  });

  it("turns wheel travel into one Claude wheel report per terminal line", () => {
    const lines = (deltaY: number, deltaMode: number) => accumulateTouchScrollLines(0, wheelDeltaPx(deltaY, deltaMode, 18, 360), 18).lines;
    expect(lines(100, 0)).toBe(5);
    expect(lines(-3, 1)).toBe(-3);
    expect(lines(1, 2)).toBe(20);
    expect(lines(4, 0)).toBe(0);
  });

  it("scrolls xterm by touch lines within buffer boundaries", () => {
    const scrollLines = vi.fn();
    const mockTerminal = {
      buffer: {
        active: {
          viewportY: 10,
          baseY: 20
        }
      },
      scrollLines
    } as unknown as Parameters<typeof scrollXtermByTouchLines>[0];

    // Middle of buffer: scroll down (lines > 0)
    expect(scrollXtermByTouchLines(mockTerminal, 3)).toBe(true);
    expect(scrollLines).toHaveBeenCalledWith(3);

    // Middle of buffer: scroll up (lines < 0)
    scrollLines.mockClear();
    expect(scrollXtermByTouchLines(mockTerminal, -3)).toBe(true);
    expect(scrollLines).toHaveBeenCalledWith(-3);

    // Zero lines: no scroll
    scrollLines.mockClear();
    expect(scrollXtermByTouchLines(mockTerminal, 0)).toBe(false);
    expect(scrollLines).not.toHaveBeenCalled();

    // At bottom: cannot scroll down further
    const bottomTerminal = {
      buffer: { active: { viewportY: 20, baseY: 20 } },
      scrollLines
    } as unknown as Parameters<typeof scrollXtermByTouchLines>[0];
    scrollLines.mockClear();
    expect(scrollXtermByTouchLines(bottomTerminal, 2)).toBe(false);
    expect(scrollLines).not.toHaveBeenCalled();
    // But can scroll up from bottom
    expect(scrollXtermByTouchLines(bottomTerminal, -2)).toBe(true);
    expect(scrollLines).toHaveBeenCalledWith(-2);

    // At top: cannot scroll up further
    const topTerminal = {
      buffer: { active: { viewportY: 0, baseY: 20 } },
      scrollLines
    } as unknown as Parameters<typeof scrollXtermByTouchLines>[0];
    scrollLines.mockClear();
    expect(scrollXtermByTouchLines(topTerminal, -2)).toBe(false);
    expect(scrollLines).not.toHaveBeenCalled();
    // But can scroll down from top
    expect(scrollXtermByTouchLines(topTerminal, 2)).toBe(true);
    expect(scrollLines).toHaveBeenCalledWith(2);

    // Null terminal
    expect(scrollXtermByTouchLines(null, 2)).toBe(false);
  });

  it("encodes SGR mouse wheel sequences with first-cell fallback for non-finite cells", () => {
    expect(encodeSgrMouseWheel(120, 20, 30)).toBe("\u001b[<65;20;30M");
    expect(encodeSgrMouseWheel(-120, 12, 5)).toBe("\u001b[<64;12;5M");
    expect(encodeSgrMouseWheel(120, Number.NaN, Number.POSITIVE_INFINITY)).toBe("\u001b[<65;1;1M");
    expect(encodeSgrMouseWheel(-1, 0, 0)).toBe("\u001b[<64;1;1M");
  });

  it("admits queued terminal input only within the bounded pending queue", () => {
    expect(terminalPendingInputAdmission({ length: 0, queuedBytes: 0 }, 10)).toBe(true);
    // 43d8295883 raised the pending queue byte limit from 32_000 to 1_000_000.
    expect(terminalPendingInputAdmission({ length: 0, queuedBytes: 999_995 }, 5)).toBe(true);
    expect(terminalPendingInputAdmission({ length: 0, queuedBytes: 999_995 }, 6)).toBe(false);
    expect(terminalPendingInputAdmission({ length: 255, queuedBytes: 0 }, 1)).toBe(true);
    expect(terminalPendingInputAdmission({ length: 256, queuedBytes: 0 }, 1)).toBe(false);
    expect(terminalPendingInputAdmission({ length: 5, queuedBytes: 0 }, 0)).toBe(true);
  });

  it("builds safe append and atomic replace voice submissions without empty sends", () => {
    expect(buildTerminalVoiceSubmit("  νέο μήνυμα  ", "existing", "append")).toEqual({
      data: " νέο μήνυμα",
      enter: "\r",
      replace: false
    });
    expect(buildTerminalVoiceSubmit("new message", "existing ", "append")).toEqual({
      data: "new message",
      enter: "\r",
      replace: false
    });
    expect(buildTerminalVoiceSubmit("replacement", "[File #1] old", "replace")).toEqual({
      data: "replacement",
      enter: "\r",
      replace: true
    });
    expect(buildTerminalVoiceSubmit("first\nsecond\u001bthird", "", "append")).toEqual({
      data: "first second third",
      enter: "\r",
      replace: false
    });
    expect(buildTerminalVoiceSubmit("   ", "existing", "append")).toBeNull();
  });

  it("keeps shared-history provider badges horizontal inside task rows", () => {
    const styles = readFileSync("src/styles.css", "utf8");

    expect(styles).toMatch(
      /\.vscode-codex-task-row\s+\.cli-task-history-provider\s*\{[^}]*display:\s*inline-flex/s
    );
  });

  it("omits stale pane launch settings from automatic reconnect requests", () => {
    const cliPane = { ...pane("pane:reconnect", "TERMINAL", "Codex"), reasoningEffort: "max" as const, cwd: "/etc" };

    expect(buildTerminalCliSessionRequest(cliPane, "cli:codex", {}, true)).toEqual({
      runtimeId: "cli:codex",
      includeTranscript: false
    });
    expect(buildTerminalCliSessionRequest(cliPane, "cli:codex", { modelId: "gpt-5.6-sol", forceRestart: true })).toEqual({
      runtimeId: "cli:codex",
      modelId: "gpt-5.6-sol",
      reasoningEffort: "max",
      cwd: "/etc",
      forceRestart: true,
      includeTranscript: false
    });
    expect(buildTerminalCliSessionRequest(cliPane, "cli:claude", { forceRestart: true, resume: true })).toEqual({
      runtimeId: "cli:claude",
      reasoningEffort: "max",
      cwd: "/etc",
      forceRestart: true,
      resume: true,
      includeTranscript: false
    });
  });

  it("writes progressive replay frames in order and drains output queued during replay", async () => {
    const firstWriteGate = deferred<void>();
    const writes: string[] = [];
    const yieldControl = vi.fn(async () => undefined);
    const queue = createTerminalReplayWriteQueue(async (data) => {
      writes.push(`start:${data}`);
      if (data === "persisted-1") await firstWriteGate.promise;
      writes.push(`end:${data}`);
    }, yieldControl);

    queue.enqueue("persisted-1");
    queue.enqueue("persisted-2");
    await Promise.resolve();
    expect(writes).toEqual(["start:persisted-1"]);

    const drained = queue.drain();
    queue.enqueue("live-during-replay");
    firstWriteGate.resolve();
    await drained;

    expect(writes).toEqual([
      "start:persisted-1",
      "end:persisted-1",
      "start:persisted-2",
      "end:persisted-2",
      "start:live-during-replay",
      "end:live-during-replay"
    ]);
    expect(yieldControl).toHaveBeenCalledTimes(2);
  });

  it("does not yield between replay frames while they are only being staged", async () => {
    const writes: string[] = [];
    const yieldControl = vi.fn(async () => undefined);
    let replayIsWritable = false;
    const queue = createTerminalReplayWriteQueue(
      async (data) => {
        writes.push(data);
      },
      yieldControl,
      () => replayIsWritable
    );

    queue.enqueue("staged-1");
    queue.enqueue("staged-2");
    await queue.drain();

    expect(writes).toEqual(["staged-1", "staged-2"]);
    expect(yieldControl).not.toHaveBeenCalled();

    replayIsWritable = true;
    queue.enqueue("visible-3");
    await queue.drain();

    expect(writes).toEqual(["staged-1", "staged-2", "visible-3"]);
    expect(yieldControl).toHaveBeenCalledTimes(1);
  });

  it("coalesces CLI session creation and accepts one disconnect per current socket generation", async () => {
    const coordinator = createTerminalReconnectCoordinator();
    const requestGate = deferred<string>();
    const createSession = vi.fn(() => requestGate.promise);

    const firstRequest = coordinator.runSessionRequest(createSession);
    const overlappingRequest = coordinator.runSessionRequest(createSession);
    expect(firstRequest).toBe(overlappingRequest);
    expect(createSession).toHaveBeenCalledTimes(1);

    requestGate.resolve("attached");
    await expect(firstRequest).resolves.toBe("attached");
    await expect(coordinator.runSessionRequest(async () => "reconnected")).resolves.toBe("reconnected");

    const firstGeneration = coordinator.beginSocketGeneration();
    expect(coordinator.markDisconnected(firstGeneration)).toBe(true);
    expect(coordinator.markDisconnected(firstGeneration)).toBe(false);

    const replacementGeneration = coordinator.beginSocketGeneration();
    expect(coordinator.markDisconnected(firstGeneration)).toBe(false);
    expect(coordinator.markDisconnected(replacementGeneration)).toBe(true);
    coordinator.invalidateSocketGeneration(replacementGeneration);
    expect(coordinator.isCurrentSocketGeneration(replacementGeneration)).toBe(false);
  });

  it("retries only network, rate-limit, and server failures during automatic CLI reconnect", () => {
    expect(isRetryableCliReconnectError(new TypeError("Failed to fetch"))).toBe(true);
    expect(isRetryableCliReconnectError(new SpaceApiError("offline", { status: 0 }))).toBe(true);
    expect(isRetryableCliReconnectError(new SpaceApiError("rate limited", { status: 429 }))).toBe(true);
    expect(isRetryableCliReconnectError(new SpaceApiError("unavailable", { status: 503 }))).toBe(true);
    expect(isRetryableCliReconnectError(new SpaceApiError("closed", { status: 409, code: "PANE_CLOSED" }))).toBe(false);
    expect(isRetryableCliReconnectError(new SpaceApiError("conflict", { status: 409, code: "CONFLICT" }))).toBe(false);
    expect(isRetryableCliReconnectError(new SpaceApiError("not found", { status: 404, code: "NOT_FOUND" }))).toBe(false);
    expect(isRetryableCliReconnectError(new Error("client-side logic failure"))).toBe(false);
  });

  it("does not reconnect a terminal socket superseded by this browser", () => {
    expect(shouldReconnectTerminalSocket({ type: "close", code: 4001 } as CloseEvent)).toBe(false);
    expect(shouldReconnectTerminalSocket({ type: "close", code: 1006 } as CloseEvent)).toBe(true);
    expect(shouldReconnectTerminalSocket(new Event("error"))).toBe(true);
  });

  it("names xterm's generated textarea for browser form diagnostics", () => {
    const textarea = document.createElement("textarea");

    nameTerminalInput(textarea);

    expect(textarea.getAttribute("name")).toBe("terminal-input");
  });

  it("models Claude Code's unlabeled default permission mode", () => {
    expect(claudePlanModeShiftTabCount("Claude Code\n? for shortcuts · ← for agents")).toBe(2);
    expect(claudePlanModeShiftTabCount("Claude Code\naccept edits on (shift+tab to cycle) · ← for agents")).toBe(1);
    expect(claudePlanModeShiftTabCount("Claude Code\nplan mode on (shift+tab to cycle) · ← for agents")).toBe(0);
    expect(claudePlanModeShiftTabCount("Claude Code\nbypass permissions on (shift+tab to cycle) · ← for agents")).toBe(4);
    expect(claudePlanModeShiftTabCount("Claude Code\nauto mode on (shift+tab to cycle) · ← for agents")).toBe(3);
    expect(claudePlanModeShiftTabCount("Claude Code CLI session allocated by Space.")).toBeNull();
  });

  it("maps DeepSeek Reasonix stop and mode shortcuts to their native terminal bytes", () => {
    expect(terminalControlKeySequence("ctrl_c")).toBe("\u0003");
    expect(terminalControlKeySequence("shift_tab")).toBe("\u001b[Z");
    expect(terminalControlKeySequence("escape")).toBe("\u001b");
    expect(reasonixShortcutSequence({
      altKey: false,
      code: "KeyY",
      ctrlKey: true,
      defaultPrevented: false,
      key: "γ",
      metaKey: false,
      shiftKey: false
    })).toBe("\u0019");
    expect(reasonixShortcutSequence({
      altKey: false,
      code: "Tab",
      ctrlKey: false,
      defaultPrevented: false,
      key: "Tab",
      metaKey: false,
      shiftKey: true
    })).toBe("\u001b[Z");
    expect(reasonixShortcutSequence({
      altKey: false,
      code: "Tab",
      ctrlKey: false,
      defaultPrevented: true,
      key: "ISO_Left_Tab",
      metaKey: false,
      shiftKey: true
    })).toBe("\u001b[Z");
    expect(reasonixShortcutSequence({
      altKey: false,
      code: "KeyY",
      ctrlKey: true,
      defaultPrevented: true,
      key: "y",
      metaKey: false,
      shiftKey: false
    })).toBeNull();
  });

  it("maps the floating turn pause to Ctrl-C for every CLI runtime except Codex, Claude, Muse, Oh My Pi and Droid (ESC)", () => {
    expect(floatingTurnPauseSequence("cli:hermes")).toBe("\u0003");
    expect(floatingTurnPauseSequence("cli:claude")).toBe("\u001b");
    expect(floatingTurnPauseSequence("cli:gemini")).toBe("\u0003");
    expect(floatingTurnPauseSequence("cli:qwen")).toBe("\u0003");
    expect(floatingTurnPauseSequence("cli:kimi")).toBe("\u0003");
    expect(floatingTurnPauseSequence("cli:grok")).toBe("\u0003");
    expect(floatingTurnPauseSequence("cli:deepseek")).toBe("\u0003");
    expect(floatingTurnPauseSequence("cli:cursor")).toBe("\u0003");
    expect(floatingTurnPauseSequence("cli:copilot")).toBe("\u0003");
    expect(floatingTurnPauseSequence("cli:autohand")).toBe("\u0003");
    expect(floatingTurnPauseSequence("cli:opencode")).toBe("\u0003");
    expect(floatingTurnPauseSequence("cli:codex")).toBe("\u001b");
    expect(floatingTurnPauseSequence("cli:omp")).toBe("\u001b");
    expect(floatingTurnPauseSequence("cli:droid")).toBe("\u001b");
    expect(floatingTurnPauseSequence("cli:qoder")).toBe("\u0003");
    expect(floatingTurnPauseSequence("cli:muse")).toBe("\u001b");
    expect(floatingTurnPauseSequence(null)).toBe("\u0003");
  });

  it("labels the floating stop button per CLI runtime", () => {
    expect(floatingTurnControlStopLabel("cli:hermes")).toBe("Stop Hermes");
    expect(floatingTurnControlStopLabel("cli:claude")).toBe("Stop Claude");
    expect(floatingTurnControlStopLabel("cli:codex")).toBe("Stop Codex");
    expect(floatingTurnControlStopLabel("cli:gemini")).toBe("Stop Gemini");
    expect(floatingTurnControlStopLabel("cli:qwen")).toBe("Stop Qwen");
    expect(floatingTurnControlStopLabel("cli:kimi")).toBe("Stop Kimi");
    expect(floatingTurnControlStopLabel("cli:grok")).toBe("Stop Grok");
    expect(floatingTurnControlStopLabel("cli:deepseek")).toBe("Stop DeepSeek");
    expect(floatingTurnControlStopLabel("cli:cursor")).toBe("Stop Cursor");
    expect(floatingTurnControlStopLabel("cli:copilot")).toBe("Stop Copilot");
    expect(floatingTurnControlStopLabel("cli:autohand")).toBe("Stop Autohand");
    expect(floatingTurnControlStopLabel("cli:omp")).toBe("Stop Oh My Pi");
    expect(floatingTurnControlStopLabel("cli:qoder")).toBe("Stop Qoder");
    expect(floatingTurnControlStopLabel("cli:muse")).toBe("Stop Muse Code");
    expect(floatingTurnControlStopLabel("cli:droid")).toBe("Stop Droid");
    expect(floatingTurnControlStopLabel("cli:does-not-exist")).toBe("Stop CLI");
  });

  it("detects running CLI turn indicators from terminal screen text", () => {
    expect(isTerminalScreenRunningText("Working (31m 27s • esc to interrupt)")).toBe(true);
    expect(isTerminalScreenRunningText("Working (2s • esc to interrupt)")).toBe(true);
    expect(isTerminalScreenRunningText("thinking...")).toBe(true);
    expect(isTerminalScreenRunningText("● working · 15s")).toBe(true);
    expect(isTerminalScreenRunningText("ctrl+c to interrupt")).toBe(true);
    expect(isTerminalScreenRunningText("Thinking for 2m 48s (esc to cancel)")).toBe(true);
    // Captured busy screens: Qoder/Qwen keep their placeholder visible, Cursor says "ctrl+c to stop".
    expect(isTerminalScreenRunningText(" ⠸ Generating... (esc to cancel, 1s)   ? for shortcuts\n──────\n YOLO Shift+Tab to Auto Mode\n──────\n *   Type your message or @path/to/file", "cli:qoder")).toBe(true);
    expect(isTerminalScreenRunningText("──────\n YOLO Shift+Tab to Auto Mode\n──────\n *   Type your message or @path/to/file", "cli:qoder")).toBe(false);
    expect(isTerminalScreenRunningText("  ⬢ Generating..  ctrl+c to stop\n → Add a follow-up", "cli:cursor")).toBe(true);
    expect(isTerminalScreenRunningText(" ⠋ Executing...  (Press ESC to stop)\n Auto… Claude Opus 5.5 API credits (High)\n│ > Enter to steer · Ctrl+Enter to queue │", "cli:droid")).toBe(true);
    // Oh My Pi 18.12.1: an idle prompt names "thinking effort"; a turn puts a spinner and its time on the rail.
    expect(isTerminalScreenRunningText(" π > ◔ GPT-6 Sol > 🌳 …c8ec ▶─3%────┃──1.1M─\n╰─                     ⇧⇥ to change thinking effort", "cli:omp")).toBe(false);
    expect(isTerminalScreenRunningText("  ⎋ Running requested shell command\n ⠋ 3s > ◔ GPT-6 Sol > 🌳 …c8ec ▶─3%────┃──1.1M─\n╰─", "cli:omp")).toBe(true);
    expect(isTerminalScreenRunningText("Running command: npm run build")).toBe(true);
    expect(isTerminalScreenRunningText("Running test...")).toBe(true);
    expect(isTerminalScreenRunningText("❯ ask anything")).toBe(false);
    expect(isTerminalScreenRunningText("› Ask Codex to do anything")).toBe(false);
    expect(isTerminalScreenRunningText("• Waiting for background terminal (5h 18m 10s • esc to interrupt)\n\n› Ask Codex to do anything")).toBe(false);
    expect(isTerminalScreenRunningText("Ask OpenCode...")).toBe(false);
    expect(isTerminalScreenRunningText("")).toBe(false);
  });

  it("detects Claude Code turns from its spinner and permission footer, including narrow panes", () => {
    const footer = "  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents";
    const runningFooter = "  ⏵⏵ bypass permissions on (shift+tab to cycle) · esc to interrupt · ← for agents";
    expect(isTerminalScreenRunningText(`✻ Deliberating…\n────\n❯ \n────\n${runningFooter}`, "cli:claude")).toBe(true);
    expect(isTerminalScreenRunningText(`* Razzmatazzing… (35s · ↓ 8.8k tokens)\n────\n❯ \n────\n${runningFooter}`, "cli:claude")).toBe(true);
    // A 60-column pane truncates the footer and drops "← for agents".
    expect(isTerminalScreenRunningText("────\n❯ \n────\n  ⏵⏵ bypass permissions on (shift+tab to cycle) · esc to …", "cli:claude")).toBe(true);
    // A 58-column pane cuts it to "esc t…"; a frame without the spinner line is still a running turn.
    expect(isTerminalScreenRunningText("\n\n────\n❯ \n────\n  ⏵⏵ bypass permissions on (shift+tab to cycle) · esc t…", "cli:claude")).toBe(true);
    expect(isTerminalScreenRunningText(`✻ Baked for 35s · done 10:01 AM\n────\n❯ \n────\n${footer}`, "cli:claude")).toBe(false);
    // Conversation text that merely mentions thinking must not keep an idle Claude pane running.
    expect(isTerminalScreenRunningText(`⏺ I was thinking about the lighthouse.\n────\n❯ \n────\n${footer}`, "cli:claude")).toBe(false);
    expect(isTerminalScreenRunningText("────\n❯ Think about tides\n────\n  ⏵⏵ bypass permissions on (shift+tab to cycle)", "cli:claude")).toBe(false);
    expect(isTerminalScreenRunningText("────\n❯ \n────\n  ? for shortcuts", "cli:claude")).toBe(false);
    // Without a recognizable Claude screen the generic indicators still apply.
    expect(isTerminalScreenRunningText("Running command: npm run build", "cli:claude")).toBe(true);
    expect(isTerminalScreenRunningText(`⏺ thinking\n${footer}`)).toBe(true);
  });

  it("reads Claude's main turn from the footer above its background agent panel", () => {
    const panel = [
      "",
      "  ● main",
      "  ◯ Explore   Running command: npm test…     4m 59s · ↓ 125.1k tokens",
      "  ◯ Plan      thinking about the rollout     7m 13s · ↓ 231.2k tokens",
      "  ◯ reviewer  Working through the diff       2m 3s · ↓ 12.4k tokens",
      "  ◯ general-purpose  1h 58m 48s · ↓ 893.4k tokens · 1 queued"
    ].join("\n");
    // Agents working while the main prompt is idle are not a main turn.
    expect(isTerminalScreenRunningText(`────\n❯ \n────\n  ⏵⏵ bypass permissions on · 3 shells · ← for agents · ↓ …\n${panel}`, "cli:claude")).toBe(false);
    expect(isTerminalScreenRunningText(`────\n❯ \n────\n  ⏵⏵ bypass permissions on · 1 shell · esc to …\n${panel}`, "cli:claude")).toBe(true);
    // Background shells drop the footer hints; the mode label still identifies the footer.
    expect(isTerminalScreenRunningText("⏺ Running command: npm test finished.\n────\n❯ \n────\n  ⏵⏵ bypass permissions on · 3 shells · ↓ to manage", "cli:claude")).toBe(false);
  });

  it("reads Claude's permission mode while background shells or agents run and in narrow panes", () => {
    const panel = ["", "  ● main", "  ◯ Plan  Inspecting…  7m 13s · ↓ 231.2k tokens", "  ◯ Explore  Counting…  4m 59s · ↓ 125.1k tokens", "  ◯ general-purpose  1h 58m 48s · ↓ 893.4k tokens"].join("\n");
    const prompt = "────\n❯ \n────\n";
    expect(claudePlanModeShiftTabCount(`${prompt}  ⏵⏵ bypass permissions on · 3 shells · ← for agents · ↓ …`)).toBe(4);
    expect(claudePlanModeShiftTabCount(`${prompt}  ⏸ plan mode on (shift+tab to cycle) · ← for agents · ↓ …\n${panel}`)).toBe(0);
    expect(claudePlanModeShiftTabCount(`${prompt}  ⏵⏵ accept edits on · 1 shell · ← for agents\n${panel}`)).toBe(1);
    expect(claudePlanModeShiftTabCount(`${prompt}  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for a…`)).toBe(4);
    expect(claudePlanModeShiftTabCount(`${prompt}  ⏵⏵ auto mode on · 2 shells`)).toBe(3);
    // A footer quoted in the conversation is not the current mode.
    expect(claudePlanModeShiftTabCount(`⏵⏵ accept edits on · 3 shells\n⏺ That was the earlier footer.\n${prompt}  ⏸ plan mode on · 1 shell`)).toBe(0);
    expect(claudePlanModeShiftTabCount(`⏵⏵ accept edits on · 3 shells\n⏺ That was the earlier footer.\n${prompt}`)).toBeNull();
  });

  it("does not infer Claude's current permission mode from conversation or stale transcript text", () => {
    expect(claudePlanModeShiftTabCount("Assistant: plan mode on is useful for design tasks.\n❯")).toBeNull();
    expect(claudePlanModeShiftTabCount("Earlier footer: bypass permissions on\n❯\n? for shortcuts only")).toBeNull();
    expect(
      claudePlanModeShiftTabCount(
        "Assistant: the previous state was plan mode on.\n❯\naccept edits on (shift+tab to cycle) · ← for agents"
      )
    ).toBe(1);
  });

  it("does not refocus the terminal after xterm focus reports", () => {
    expect(shouldRefocusTerminalAfterInput("\u001b[I")).toBe(false);
    expect(shouldRefocusTerminalAfterInput("\u001b[O")).toBe(false);
    expect(shouldRefocusTerminalAfterInput("\u001b[?1;2c")).toBe(false);
    expect(shouldRefocusTerminalAfterInput("\u001b]11;rgb:0909/0b0b/0c0c\u001b\\")).toBe(false);
    expect(shouldRefocusTerminalAfterInput("draft text")).toBe(true);
  });

  it("does not refocus the terminal after mouse reports, so a pointer move does not close an open pane menu", () => {
    expect(shouldRefocusTerminalAfterInput("\u001b[<35;12;4M")).toBe(false);
    expect(shouldRefocusTerminalAfterInput("\u001b[<35;12;4M\u001b[<35;13;4M")).toBe(false);
    expect(shouldRefocusTerminalAfterInput("\u001b[<0;12;4m")).toBe(false);
    expect(shouldRefocusTerminalAfterInput("\u001b[<35;12;4Mx")).toBe(true);
  });

  it("classifies only complete xterm protocol replies as non-mutating input", () => {
    expect(isNonMutatingTerminalProtocolResponse("\u001b[2;15R")).toBe(true);
    expect(isNonMutatingTerminalProtocolResponse("\u001b[?1;2c")).toBe(true);
    expect(
      isNonMutatingTerminalProtocolResponse(
        "\u001b[?1;2c\u001b]11;rgb:0909/0b0b/0c0c\u001b\\"
      )
    ).toBe(true);
    expect(isNonMutatingTerminalProtocolResponse("\u001b[A")).toBe(false);
    expect(isNonMutatingTerminalProtocolResponse("\u001b[?1;2ctyped text")).toBe(false);
  });

  it("arms runtime model refresh after submitted input but not passive terminal output", () => {
    expect(shouldRefreshCliModelSettings("output", "status repainted")).toBe(false);
    expect(shouldRefreshCliModelSettings("input", "/model\r")).toBe(true);
    expect(shouldRefreshCliModelSettings("input", "draft text")).toBe(false);
  });

  it("shows the runtime model id instead of falling back to the first catalog model", () => {
    render(
      <CodexModelPicker
        settings={{
          sessionId: "cli_session:runtime-model",
          threadId: "11111111-1111-4111-8111-111111111111",
          current: { modelId: "gpt-5.5", reasoningEffort: "xhigh" },
          models: [
            {
              id: "gpt-5.6-sol",
              displayName: "GPT-5.6-Sol",
              isDefault: true,
              defaultReasoningEffort: "medium",
              supportedReasoningEfforts: ["medium", "high"]
            }
          ],
          controlMode: "DIRECT",
          isTurnActive: false
        }}
        onSwitch={vi.fn(successfulModelSwitch)}
      />
    );

    expect(screen.getByRole("button", { name: /current gpt-5\.5 · xhigh/i })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /current GPT-5\.6-Sol/i })).toBeNull();
  });

  it("hides the reasoning section and shows only the model name for OpenCode runtimes", () => {
    render(
      <CodexModelPicker
        settings={{
          sessionId: "cli_session:opencode-model",
          threadId: null,
          current: { modelId: "opencode/deepseek-v4-flash-free", reasoningEffort: "auto" },
          models: [
            {
              id: "opencode/deepseek-v4-flash-free",
              displayName: "DeepSeek V4 Flash Free",
              isDefault: true,
              defaultReasoningEffort: "auto",
              supportedReasoningEfforts: [],
              reasoningOptions: []
            },
            {
              id: "legacy/kimi-k3",
              displayName: "Kimi K3",
              isDefault: false,
              defaultReasoningEffort: "auto",
              supportedReasoningEfforts: [],
              reasoningOptions: []
            }
          ],
          controlMode: "OPENCODE",
          isTurnActive: false
        }}
        onSwitch={vi.fn(successfulModelSwitch)}
      />
    );

    const trigger = screen.getByRole("button", { name: /current deepseek v4 flash free/i });
    expect(trigger.getAttribute("aria-label")).toContain("DeepSeek V4 Flash Free");
    expect(trigger.getAttribute("aria-label")).not.toContain("auto");

    fireEvent.click(trigger);
    const picker = screen.getByRole("dialog", { name: "Model and reasoning" });
    expect(picker).toBeTruthy();
    expect(within(picker).queryByText("Reasoning")).toBeNull();
    expect(within(picker).getByText("Applies to subsequent turns in this session")).toBeTruthy();
    expect(within(picker).getByRole("radio", { name: "Kimi K3" })).toBeTruthy();
  });

  it("shows a disabled detecting state instead of a guessed model", () => {
    render(
      <CodexModelPicker
        settings={{
          sessionId: "cli_session:detecting-model",
          threadId: "11111111-1111-4111-8111-111111111111",
          current: null,
          models: [
            {
              id: "gpt-5.6-sol",
              displayName: "GPT-5.6-Sol",
              isDefault: true,
              defaultReasoningEffort: "medium",
              supportedReasoningEfforts: ["medium", "high"]
            }
          ],
          controlMode: "DIRECT",
          isTurnActive: false
        }}
        onSwitch={vi.fn(successfulModelSwitch)}
      />
    );

    const detecting = screen.getByRole("button", { name: /detecting model/i });
    expect(detecting).toHaveProperty("disabled", true);
    expect(detecting.textContent).toBe("Detecting model…");
  });

  it("starts as a 44px icon circle, opens as a left-growing pill, and keeps model selection draft-only", () => {
    const onSwitch = vi.fn(successfulModelSwitch);
    render(<CodexModelPicker settings={selectableModelSettings()} onSwitch={onSwitch} />);

    const trigger = screen.getByRole("button", { name: /current Mini · medium/i });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(trigger.classList.contains("is-expanded")).toBe(false);
    expect(trigger.textContent).toBe("");
    expect(trigger.querySelector("svg")).toBeTruthy();

    fireEvent.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(trigger.classList.contains("is-expanded")).toBe(true);
    expect(trigger.textContent).toContain("Mini · Medium");
    const picker = screen.getByRole("dialog", { name: "Model and reasoning" });
    expect(picker).toBeTruthy();
    expect(within(picker).getByText("Until the next Build/Plan switch")).toBeTruthy();

    const solOption = screen.getByRole("radio", { name: "Sol" });
    fireEvent.click(solOption);
    expect(onSwitch).not.toHaveBeenCalled();
    expect(screen.queryByRole("radio", { name: miniModelOption })).toBeNull();
    expect(screen.getByRole("button", { name: "Back to models" })).toBeTruthy();
    expect(screen.getByRole("radio", { name: "ultra" })).toBeTruthy();
  });

  it("keeps the model popover within the available pane height", () => {
    const { container } = render(
      <div className="terminal-stage">
        <CodexModelPicker settings={selectableModelSettings()} onSwitch={vi.fn(successfulModelSwitch)} />
      </div>
    );
    const stage = container.querySelector<HTMLElement>(".terminal-stage");
    const trigger = screen.getByRole("button", { name: /current Mini · medium/i });
    vi.spyOn(stage!, "getBoundingClientRect").mockReturnValue({ top: 100 } as DOMRect);
    vi.spyOn(trigger, "getBoundingClientRect").mockReturnValue({ top: 420 } as DOMRect);

    fireEvent.click(trigger);

    expect(screen.getByRole("dialog", { name: "Model and reasoning" }).style.maxHeight).toBe("301px");
  });

  it("keeps the model popover within the available chat shell height", () => {
    const { container } = render(
      <div className="codex-chat-shell">
        <CodexModelPicker settings={selectableModelSettings()} onSwitch={vi.fn(successfulModelSwitch)} />
      </div>
    );
    const shell = container.querySelector<HTMLElement>(".codex-chat-shell");
    const trigger = screen.getByRole("button", { name: /current Mini · medium/i });
    vi.spyOn(shell!, "getBoundingClientRect").mockReturnValue({ top: 120 } as DOMRect);
    vi.spyOn(trigger, "getBoundingClientRect").mockReturnValue({ top: 420 } as DOMRect);

    fireEvent.click(trigger);

    expect(screen.getByRole("dialog", { name: "Model and reasoning" }).style.maxHeight).toBe("281px");
  });

  it("keeps model names stable and exposes the selected reasoning as a description", () => {
    render(<CodexModelPicker settings={selectableModelSettings()} onSwitch={vi.fn(successfulModelSwitch)} />);
    fireEvent.click(screen.getByRole("button", { name: /current Mini · medium/i }));

    const selected = screen.getByRole("radio", { name: "Mini" });
    expect(selected.getAttribute("aria-checked")).toBe("true");
    expect(selected.getAttribute("aria-description")).toBe("Reasoning effort: Medium");
    expect(selected.querySelector(".terminal-model-option-effort-badge")?.textContent).toBe("Medium");
    expect(screen.getByRole("radio", { name: "Sol" }).getAttribute("aria-description")).toBeNull();
  });

  it("shows a check icon on the active reasoning effort", () => {
    render(<CodexModelPicker settings={selectableModelSettings()} onSwitch={vi.fn(successfulModelSwitch)} />);

    fireEvent.click(screen.getByRole("button", { name: /current Mini · medium/i }));
    fireEvent.click(screen.getByRole("radio", { name: miniModelOption }));

    const activeReasoning = screen.getByRole("radio", { name: "medium" });
    expect(activeReasoning.getAttribute("aria-checked")).toBe("true");
    expect(activeReasoning.querySelector(".terminal-model-selection-check")).toBeTruthy();
  });

  it("keeps an open model draft when a background catalog refresh arrives", async () => {
    const initial = selectableModelSettings();
    const { rerender } = render(
      <CodexModelPicker settings={initial} onSwitch={vi.fn(successfulModelSwitch)} />
    );

    fireEvent.click(screen.getByRole("button", { name: /current Mini · medium/i }));
    fireEvent.click(screen.getByRole("radio", { name: "Sol" }));
    expect(screen.getByRole("radio", { name: "ultra" })).toBeTruthy();

    rerender(
      <CodexModelPicker
        settings={{
          ...initial,
          current: { modelId: "gpt-5.6-mini", reasoningEffort: "high" },
          models: initial.models.map((model) => ({ ...model, description: `${model.displayName} refreshed` }))
        }}
        onSwitch={vi.fn(successfulModelSwitch)}
      />
    );

    await waitFor(() => expect(screen.getByRole("radio", { name: "ultra" })).toBeTruthy());
    expect(screen.queryByRole("radio", { name: miniModelOption })).toBeNull();
  });

  it("shows Codex labels for known reasoning efforts and preserves future identifiers", () => {
    const settings = selectableModelSettings();
    settings.models[0] = {
      ...settings.models[0]!,
      supportedReasoningEfforts: [...settings.models[0]!.supportedReasoningEfforts, "turbo"],
      reasoningOptions: [
        ...(settings.models[0]!.reasoningOptions ?? []),
        { reasoningEffort: "turbo", description: "Future effort." }
      ]
    };
    render(<CodexModelPicker settings={settings} onSwitch={vi.fn(successfulModelSwitch)} />);

    fireEvent.click(screen.getByRole("button", { name: /current Mini · medium/i }));
    fireEvent.click(screen.getByRole("radio", { name: "Sol" }));

    const radioLabel = (name: string) => screen.getByRole("radio", { name }).querySelector("span")?.textContent;
    expect(radioLabel("xhigh")).toBe("XHigh");
    expect(radioLabel("max")).toBe("Max");
    expect(radioLabel("ultra")).toBe("Ultra");
    expect(radioLabel("turbo")).toBe("turbo");
  });

  it("closes after a successful reasoning selection, restores focus, and collapses after exactly three seconds", async () => {
    vi.useFakeTimers();
    try {
      const onSwitch = vi.fn(successfulModelSwitch);
      render(<CodexModelPicker settings={selectableModelSettings()} onSwitch={onSwitch} />);
      const trigger = screen.getByRole("button", { name: /current Mini · medium/i });
      fireEvent.click(trigger);
      fireEvent.click(screen.getByRole("radio", { name: miniModelOption }));

      await act(async () => {
        fireEvent.click(screen.getByRole("radio", { name: "high" }));
      });

      expect(onSwitch).toHaveBeenCalledWith("gpt-5.6-mini", "high", null);
      expect(screen.queryByRole("dialog", { name: "Model and reasoning" })).toBeNull();
      expect(document.activeElement).toBe(trigger);
      expect(trigger.classList.contains("is-expanded")).toBe(true);
      expect(trigger.textContent).toContain("Mini · High");

      act(() => vi.advanceTimersByTime(2_999));
      expect(trigger.classList.contains("is-expanded")).toBe(true);
      act(() => vi.advanceTimersByTime(1));
      expect(trigger.classList.contains("is-expanded")).toBe(false);
      expect(trigger.textContent).toBe("");
    } finally {
      vi.runOnlyPendingTimers();
      vi.useRealTimers();
    }
  });

  it("keeps the menu open and shows the runtime confirmation diagnostic when the switch fails", async () => {
    const diagnostic =
      "CODEX_RUNTIME_MODEL_SETTINGS_UNCONFIRMED: Codex accepted the runtime model update, but Space could not confirm it after 12 checks. " +
      "Expected gpt-5.6-mini · high; last observed gpt-5.6-mini · medium.";
    const onSwitch = vi.fn(async () => {
      throw new Error(diagnostic);
    });
    render(<CodexModelPicker settings={selectableModelSettings()} onSwitch={onSwitch} />);
    fireEvent.click(screen.getByRole("button", { name: /current Mini · medium/i }));
    fireEvent.click(screen.getByRole("radio", { name: miniModelOption }));
    fireEvent.click(screen.getByRole("radio", { name: "high" }));

    expect((await screen.findByRole("alert")).textContent).toBe(diagnostic);
    expect(screen.getByRole("dialog", { name: "Model and reasoning" })).toBeTruthy();
  });

  it("treats the active reasoning as a no-op with the same close and three-second pill behavior", async () => {
    vi.useFakeTimers();
    try {
      const onSwitch = vi.fn(successfulModelSwitch);
      render(<CodexModelPicker settings={selectableModelSettings()} onSwitch={onSwitch} />);
      const trigger = screen.getByRole("button", { name: /current Mini · medium/i });
      fireEvent.click(trigger);
      fireEvent.click(screen.getByRole("radio", { name: miniModelOption }));
      fireEvent.click(screen.getByRole("radio", { name: "medium" }));

      expect(onSwitch).not.toHaveBeenCalled();
      expect(screen.queryByRole("dialog", { name: "Model and reasoning" })).toBeNull();
      expect(document.activeElement).toBe(trigger);
      expect(trigger.classList.contains("is-expanded")).toBe(true);
      act(() => vi.advanceTimersByTime(3_000));
      expect(trigger.classList.contains("is-expanded")).toBe(false);
    } finally {
      vi.runOnlyPendingTimers();
      vi.useRealTimers();
    }
  });

  it("collapses on Escape and outside click, and restores trigger focus on Escape", () => {
    render(<CodexModelPicker settings={selectableModelSettings()} onSwitch={vi.fn(successfulModelSwitch)} />);
    const trigger = screen.getByRole("button", { name: /current Mini · medium/i });
    fireEvent.click(trigger);
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Model and reasoning" })).toBeNull();
    expect(trigger.classList.contains("is-expanded")).toBe(false);
    expect(document.activeElement).toBe(trigger);

    fireEvent.click(trigger);
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("dialog", { name: "Model and reasoning" })).toBeNull();
    expect(trigger.classList.contains("is-expanded")).toBe(false);
  });

  it("cancels the collapse timer when reopened and when unmounted", async () => {
    vi.useFakeTimers();
    const clearTimeoutSpy = vi.spyOn(window, "clearTimeout");
    try {
      const { unmount } = render(<CodexModelPicker settings={selectableModelSettings()} onSwitch={vi.fn(successfulModelSwitch)} />);
      const trigger = screen.getByRole("button", { name: /current Mini · medium/i });
      fireEvent.click(trigger);
      fireEvent.click(screen.getByRole("radio", { name: miniModelOption }));
      fireEvent.click(screen.getByRole("radio", { name: "medium" }));

      fireEvent.click(trigger);
      expect(screen.getByRole("dialog", { name: "Model and reasoning" })).toBeTruthy();
      act(() => vi.advanceTimersByTime(3_000));
      expect(trigger.classList.contains("is-expanded")).toBe(true);

      fireEvent.click(screen.getByRole("radio", { name: miniModelOption }));
      fireEvent.click(screen.getByRole("radio", { name: "medium" }));
      const clearCallsBeforeUnmount = clearTimeoutSpy.mock.calls.length;
      unmount();
      expect(clearTimeoutSpy.mock.calls.length).toBeGreaterThan(clearCallsBeforeUnmount);
    } finally {
      act(() => vi.runOnlyPendingTimers());
      clearTimeoutSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it("shows the server-confirmed model when a requested model falls back to reasoning-only", async () => {
    vi.useFakeTimers();
    try {
      const onSwitch = vi.fn(async () => ({
        current: { modelId: "gpt-5.6-mini", reasoningEffort: "high" },
        message: "The previous model was retained."
      }));
      render(<CodexModelPicker settings={selectableModelSettings()} onSwitch={onSwitch} />);
      const trigger = screen.getByRole("button", { name: /current Mini · medium/i });
      fireEvent.click(trigger);
      fireEvent.click(screen.getByRole("radio", { name: "Sol" }));

      await act(async () => {
        fireEvent.click(screen.getByRole("radio", { name: "high" }));
      });

      expect(onSwitch).toHaveBeenCalledWith("gpt-5.6-sol", "high", null);
      expect(trigger.textContent).toContain("Mini · High");
      expect(trigger.textContent).not.toContain("Sol");
    } finally {
      act(() => vi.runOnlyPendingTimers());
      vi.useRealTimers();
    }
  });

  it("does not re-expand after Escape dismisses an in-flight switch", async () => {
    const pending = deferred<Awaited<ReturnType<typeof successfulModelSwitch>>>();
    render(<CodexModelPicker settings={selectableModelSettings()} onSwitch={() => pending.promise} />);
    const trigger = screen.getByRole("button", { name: /current Mini · medium/i });
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("radio", { name: miniModelOption }));
    fireEvent.click(screen.getByRole("radio", { name: "high" }));
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(trigger.classList.contains("is-expanded")).toBe(false);

    await act(async () => {
      pending.resolve({ current: { modelId: "gpt-5.6-mini", reasoningEffort: "high" }, message: null });
      await pending.promise;
    });

    expect(screen.queryByRole("dialog", { name: "Model and reasoning" })).toBeNull();
    expect(trigger.classList.contains("is-expanded")).toBe(false);
    expect(trigger.textContent).toBe("");
  });

  it("does not re-expand after an outside click dismisses an in-flight switch", async () => {
    const pending = deferred<Awaited<ReturnType<typeof successfulModelSwitch>>>();
    render(<CodexModelPicker settings={selectableModelSettings()} onSwitch={() => pending.promise} />);
    const trigger = screen.getByRole("button", { name: /current Mini · medium/i });
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("radio", { name: miniModelOption }));
    fireEvent.click(screen.getByRole("radio", { name: "high" }));
    fireEvent.pointerDown(document.body);
    expect(trigger.classList.contains("is-expanded")).toBe(false);

    await act(async () => {
      pending.resolve({ current: { modelId: "gpt-5.6-mini", reasoningEffort: "high" }, message: null });
      await pending.promise;
    });

    expect(screen.queryByRole("dialog", { name: "Model and reasoning" })).toBeNull();
    expect(trigger.classList.contains("is-expanded")).toBe(false);
  });

  it("does not create a confirmation timer when an in-flight switch resolves after unmount", async () => {
    vi.useFakeTimers();
    const setTimeoutSpy = vi.spyOn(window, "setTimeout");
    try {
      const pending = deferred<Awaited<ReturnType<typeof successfulModelSwitch>>>();
      const { unmount } = render(<CodexModelPicker settings={selectableModelSettings()} onSwitch={() => pending.promise} />);
      fireEvent.click(screen.getByRole("button", { name: /current Mini · medium/i }));
      fireEvent.click(screen.getByRole("radio", { name: miniModelOption }));
      fireEvent.click(screen.getByRole("radio", { name: "high" }));
      unmount();
      const confirmationTimersBeforeResolve = setTimeoutSpy.mock.calls.filter((call) => call[1] === 3_000).length;

      await act(async () => {
        pending.resolve({ current: { modelId: "gpt-5.6-mini", reasoningEffort: "high" }, message: null });
        await pending.promise;
      });

      expect(setTimeoutSpy.mock.calls.filter((call) => call[1] === 3_000)).toHaveLength(confirmationTimersBeforeResolve);
    } finally {
      act(() => vi.runOnlyPendingTimers());
      setTimeoutSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it("matches ready identities to three panes even when their render order changes", () => {
    const reorderedPanes = [
      { paneId: "pane:third", sessionId: "cli_session:third" },
      { paneId: "pane:first", sessionId: "cli_session:first" },
      { paneId: "pane:second", sessionId: "cli_session:second" }
    ];
    const readyEnvelopes = [
      { paneId: "pane:third", sessionId: "cli_session:third" },
      { paneId: "pane:first", sessionId: "cli_session:first" },
      { paneId: "pane:first", sessionId: "cli_session:first" }
    ];

    expect(
      reorderedPanes.map((expected, index) =>
        cliReadyMatchesExpectedIdentity(readyEnvelopes[index]!, expected)
      )
    ).toEqual([true, true, false]);
  });

  it("auto-attaches enabled Codex CLI sessions by default", async () => {
    const cliPane = pane("pane:cli", "TERMINAL", "Codex CLI", { fresh: true });
    const requestBodies: Array<{ url: string; body: string }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        const method = init?.method ?? "GET";
        if (init?.body) requestBodies.push({ url, body: String(init.body) });
        if (method === "GET" && url === "/api/cli/runtimes") {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              data: [
                {
                  id: "cli:codex",
                  providerId: "codex",
                  providerName: "Codex",
                  agentId: "codex",
                  agentName: "Codex CLI",
                  displayName: "Codex CLI",
                  capabilities: ["CLI"],
                  ...readyRuntimeAuth,
                  status: "ENABLED",
                  statusReason: "Codex CLI command and credential smoke are verified.",
                  commandName: "codex",
                  detectedCommandPath: "/opt/spaceapp/bin/codex",
                  defaultModelId: null,
                  supportedReasoningEfforts: ["medium", "high"],
                  checkedAt: "2026-07-05T00:00:00.000Z"
                },
                {
                  id: "cli:claude",
                  providerId: "anthropic",
                  providerName: "Anthropic",
                  agentId: "claude",
                  agentName: "Claude Code CLI",
                  displayName: "Claude Code CLI",
                  capabilities: ["CLI"],
                  ...readyRuntimeAuth,
                  status: "ENABLED",
                  statusReason: "Claude Code CLI direct operator parity is verified.",
                  commandName: "claude",
                  detectedCommandPath: "/opt/spaceapp/bin/claude",
                  defaultModelId: null,
                  supportedReasoningEfforts: ["medium", "high"],
                  checkedAt: "2026-07-05T00:00:00.000Z"
                },
                {
                  id: "cli:gemini",
                  providerId: "google",
                  providerName: "Google",
                  agentId: "gemini",
                  agentName: "Gemini CLI",
                  displayName: "Gemini CLI",
                  capabilities: ["CLI"],
                  ...readyRuntimeAuth,
                  status: "ENABLED",
                  statusReason: "Gemini CLI direct operator parity is verified.",
                  commandName: "gemini-vscode-parity",
                  detectedCommandPath: "/opt/spaceapp/bin/gemini-vscode-parity",
                  defaultModelId: null,
                  supportedReasoningEfforts: [],
                  checkedAt: "2026-07-21T00:00:00.000Z"
                },
                {
                  id: "cli:opencode",
                  providerId: "opencode",
                  providerName: "OpenCode",
                  agentId: "opencode",
                  agentName: "OpenCode CLI",
                  displayName: "OpenCode CLI",
                  capabilities: ["CLI"],
                  ...readyRuntimeAuth,
                  status: "ENABLED",
                  statusReason: "OpenCode CLI direct operator parity is verified.",
                  commandName: "opencode",
                  detectedCommandPath: "/opt/spaceapp/bin/opencode",
                  defaultModelId: null,
                  supportedReasoningEfforts: [],
                  checkedAt: "2026-07-05T00:00:00.000Z"
                },
                {
                  id: "cli:qwen",
                  providerId: "alibaba",
                  providerName: "Alibaba Coding Plan International",
                  agentId: "qwen",
                  agentName: "Qwen Code CLI",
                  displayName: "Qwen Code CLI",
                  capabilities: ["CLI"],
                  ...readyRuntimeAuth,
                  status: "ENABLED",
                  statusReason: "Qwen Code direct operator parity is verified.",
                  commandName: "qwen-vscode-parity",
                  detectedCommandPath: "/opt/spaceapp/bin/qwen-vscode-parity",
                  defaultModelId: null,
                  supportedReasoningEfforts: [],
                  checkedAt: "2026-07-21T00:00:00.000Z"
                },
                {
                  id: "cli:kimi",
                  providerId: "kimi-code",
                  providerName: "Kimi Code Subscription",
                  agentId: "kimi",
                  agentName: "Kimi Code CLI",
                  displayName: "Kimi Code CLI",
                  capabilities: ["CLI"],
                  ...readyRuntimeAuth,
                  status: "ENABLED",
                  statusReason: "Kimi Code subscription direct operator parity is verified.",
                  commandName: "kimi",
                  detectedCommandPath: "/opt/spaceapp/bin/kimi",
                  defaultModelId: null,
                  supportedReasoningEfforts: [],
                  checkedAt: "2026-07-05T00:00:00.000Z"
                },
                {
                  id: "cli:grok",
                  providerId: "xai",
                  providerName: "Grok Build",
                  agentId: "grok",
                  agentName: "Grok Build CLI",
                  displayName: "Grok Build CLI",
                  capabilities: ["CLI"],
                  ...readyRuntimeAuth,
                  status: "ENABLED",
                  statusReason: "Grok Build account direct operator parity is verified.",
                  commandName: "grok-vscode-parity",
                  detectedCommandPath: "/opt/spaceapp/bin/grok-vscode-parity",
                  defaultModelId: null,
                  supportedReasoningEfforts: [],
                  checkedAt: "2026-07-20T00:00:00.000Z"
                },
                {
                  id: "cli:root",
                  providerId: "root",
                  providerName: "Root",
                  agentId: "root",
                  agentName: "Root Shell",
                  displayName: "CLI ROOT",
                  capabilities: ["CLI"],
                  ...readyRuntimeAuth,
                  status: "ENABLED",
                  statusReason: "Dedicated root shell host is enabled.",
                  commandName: "/bin/bash",
                  detectedCommandPath: "/bin/bash",
                  defaultModelId: null,
                  supportedReasoningEfforts: [],
                  checkedAt: "2026-07-05T00:00:00.000Z"
                }
              ],
              checkedAt: "2026-07-05T00:00:00.000Z"
            })
          };
        }
        if (method === "GET" && url === "/api/panes/pane%3Acli/cli/session?includeTranscript=false") {
          return { ok: true, status: 200, json: async () => null };
        }
        if (method === "GET" && url === "/api/auth/csrf") {
          return { ok: true, status: 200, json: async () => ({ csrfToken: "csrf:test", headerName: csrfHeaderName }) };
        }
        if (method === "POST" && url === "/api/panes/pane%3Acli/cli/session") {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              session: {
                sessionId: "cli_session:auto",
                paneId: cliPane.id,
                roomId: cliPane.roomId,
                runtimeId: "cli:codex",
                providerId: "codex",
                agentId: "codex",
                modelId: null,
                reasoningEffort: "medium",
                cwd: "/opt/spaceapp/var/cli-workspaces/room_cli/pane_cli/cli_session_auto",
                status: "IDLE",
                statusReason: "CLI session allocated.",
                exitCode: null,
                isActive: true,
                codexThreadId: "019f3805-9299-7b92-b70c-cd4d49b02774",
                startedAt: "2026-07-05T00:00:00.000Z",
                updatedAt: "2026-07-05T00:00:00.000Z",
                endedAt: null
              },
              transcript: [
                {
                  chunkId: "cli_chunk:auto",
                  sessionId: "cli_session:auto",
                  paneId: cliPane.id,
                  roomId: cliPane.roomId,
                  sequence: 0,
                  stream: "system",
                  content: "Codex CLI session allocated by Space.",
                  createdAt: "2026-07-05T00:00:00.000Z"
                }
              ],
              websocket: null
            })
          };
        }
        throw new Error(`Missing fixture for ${method} ${url}`);
      })
    );

    render(
      <SpaceRuntimeProvider runtime={liveRuntime}>
        <VoiceInputProvider><TerminalPane pane={cliPane} terminalFontSize={12} /></VoiceInputProvider>
      </SpaceRuntimeProvider>
    );

    await new Promise((resolve) => setTimeout(resolve, 1500));
    // eslint-disable-next-line no-console
    console.log("PROBE requests:", JSON.stringify(requestBodies), "fetchCalls:", JSON.stringify((globalThis.fetch as unknown as { mock: { calls: Array<Array<unknown>> } }).mock?.calls?.map(([input]) => String(input))), "paneAgeMs:", Date.now() - new Date(cliPane.createdAt).getTime(), "createdAt:", cliPane.createdAt);

    await new Promise((resolve) => setTimeout(resolve, 1500));
    // eslint-disable-next-line no-console
    console.log("PROBE requests:", JSON.stringify(requestBodies), "fetchCalls:", JSON.stringify((globalThis.fetch as unknown as { mock: { calls: Array<Array<unknown>> } }).mock?.calls?.map(([input]) => String(input))), "paneAgeMs:", Date.now() - new Date(cliPane.createdAt).getTime(), "createdAt:", cliPane.createdAt);

    expect(await screen.findByText("Codex CLI session allocated by Space.", undefined, { timeout: 5000 })).toBeTruthy();
    await waitFor(
      () =>
        expect(
          requestBodies.some(
            (request) =>
              request.url === "/api/panes/pane%3Acli/cli/session" &&
              request.body.includes("\"runtimeId\":\"cli:codex\"")
          )
        ).toBe(true),
      { timeout: 5000 }
    );
    const automaticAttach = requestBodies.find(
      (request) => request.url === "/api/panes/pane%3Acli/cli/session"
    );
    expect(automaticAttach).toBeTruthy();
    expect(JSON.parse(automaticAttach?.body ?? "{}")).toEqual({
      runtimeId: "cli:codex",
      reasoningEffort: "medium",
      cwd: "/opt/spaceapp",
      includeTranscript: false
    });
  });

  it("renders CLI panes with runtime gates and creates TERMINAL panes from the toolbar", async () => {
    window.localStorage.clear();
    window.localStorage.setItem("space.paneToolbar.sharedCodex.hiddenActionIds", JSON.stringify(["resume"]));
    Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: 1440 });
    Object.defineProperty(window, "innerHeight", { configurable: true, writable: true, value: 900 });
    window.dispatchEvent(new Event("resize"));
    const requests: string[] = [];
    const requestBodies: Array<{ url: string; body: string }> = [];
    const terminalPaneActions: unknown[] = [];
    const recordTerminalPaneAction = (event: Event) => {
      if (event instanceof CustomEvent) terminalPaneActions.push(event.detail);
    };
    window.addEventListener("space:terminal-pane-action", recordTerminalPaneAction);
    const originalMediaDevices = navigator.mediaDevices;
    const originalClipboard = navigator.clipboard;
    const writeClipboardText = vi.fn(async () => undefined);
    const originalPlay = HTMLMediaElement.prototype.play;
    const originalGetContext = HTMLCanvasElement.prototype.getContext;
    const originalToBlob = HTMLCanvasElement.prototype.toBlob;
    const cliPane = pane("pane:cli", "TERMINAL", "Codex CLI");
    let currentCliPane = cliPane;
    const chatPane = pane("pane:chat", "CHAT", "Planner");
    const browserPane = pane("pane:browser", "BROWSER", "Browser 3");
    const createdCliPanes = new Map<string, Pane>();
    const browserTimestamp = "2026-07-05T00:00:00.000Z";
    const browserSessionResponse = {
      session: {
        sessionId: "browser_session:pane_browser",
        paneId: browserPane.id,
        roomId: browserPane.roomId,
        ownerAgentId: "agent:3",
        agentNumber: 3,
        profileId: "profile:pane_browser",
        profilePath: "/opt/spaceapp/var/artifacts/browser-profiles/room_cli/pane_browser/browser_session",
        viewport: "desktop",
        targetUrl: "https://www.google.com/",
        currentUrl: "https://www.google.com/",
        title: "Olla",
        status: "READY",
        statusReason: "Page ready.",
        lastFrameAt: browserTimestamp,
        isActive: true,
        startedAt: browserTimestamp,
        updatedAt: browserTimestamp,
        endedAt: null
      },
      frame: {
        sessionId: "browser_session:pane_browser",
        paneId: browserPane.id,
        roomId: browserPane.roomId,
        status: "READY",
        viewport: "desktop",
        currentUrl: "https://www.google.com/",
        title: "Olla",
        screenshotDataUrl: "data:image/png;base64,aGVsbG8=",
        capturedAt: browserTimestamp
      },
      websocket: null
    };
    const cliTurnCompletedEvent = {
      id: "event:cli-turn-completed",
      roomId: "room:cli",
      paneId: cliPane.id,
      turnId: "turn:cli-finished",
      workflowId: "workflow:cli-finished",
      traceId: "req:cli-turn-finished",
      type: "TURN_COMPLETED" as const,
      message: "CLI turn finished.",
      payload: {
        metadata: {
          codexAppServer: {
            agentMessageText: "CLI task finished."
          }
        }
      },
      createdAt: "2026-07-05T00:00:01.000Z"
    };
    const chatTurnCompletedEvent = {
      id: "event:chat-turn-completed",
      roomId: "room:cli",
      paneId: chatPane.id,
      turnId: "turn:chat-finished",
      workflowId: "workflow:chat-finished",
      traceId: "req:chat-turn-finished",
      type: "TURN_COMPLETED" as const,
      message: "Planner turn finished.",
      payload: {
        metadata: {
          codexAppServer: {
            agentMessageText: "Planner task finished."
          }
        }
      },
      createdAt: "2026-07-05T00:00:02.000Z"
    };
    const newCliPane = {
      ...pane("pane:new-cli", "TERMINAL", "CLI 5"),
      terminalRuntimeId: "cli:codex"
    };
    const createdRoomPanes: ReturnType<typeof pane>[] = [];
    let roomCliCount = 0;
    let roomCliActivityFailure = false;
    const roomFixtures = [{
      id: "room:cli",
      name: "CLI Room",
      description: null,
      paneCap: 16,
      createdAt: "2026-07-05T00:00:00.000Z",
      updatedAt: "2026-07-05T00:00:00.000Z",
      archivedAt: null,
      traceId: "req:room"
    }];
    const screenStream = {
      getVideoTracks: () => [{ getSettings: () => ({ width: 12, height: 8 }) }],
      getTracks: () => [{ stop: vi.fn() }]
    };
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getDisplayMedia: vi.fn(async () => screenStream) }
    });
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: writeClipboardText }
    });
    HTMLMediaElement.prototype.play = vi.fn(async () => undefined);
    HTMLCanvasElement.prototype.getContext = vi.fn(() => ({ drawImage: vi.fn() })) as unknown as typeof HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.toBlob = vi.fn((callback: BlobCallback) => {
      callback(new Blob([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], { type: "image/png" }));
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        const method = init?.method ?? "GET";
        requests.push(`${method} ${url}`);
        if (init?.body) requestBodies.push({ url, body: String(init.body) });

        if (method === "POST" && url === "/api/rooms") {
          const createdRoom = {
            id: "room:new",
            name: "Room 2",
            description: null,
            paneCap: 16,
            createdAt: "2026-07-05T00:00:00.000Z",
            updatedAt: "2026-07-05T00:00:00.000Z",
            archivedAt: null,
            traceId: "req:new-room"
          };
          roomFixtures.push(createdRoom);
          return {
            ok: true,
            status: 200,
            json: async () => createdRoom
          };
        }

        if (method === "GET" && url === "/api/rooms/cli-activity") {
          if (roomCliActivityFailure) {
            return {
              ok: false,
              status: 503,
              json: async () => ({ error: { code: "UPSTREAM_UNAVAILABLE", message: "Temporary CLI activity failure" } })
            };
          }
          return {
            ok: true,
            status: 200,
            json: async () => ({
              data: [{ roomId: "room:cli", runningCliCount: roomCliCount }],
              sampledAt: "2026-07-20T12:00:00.000Z"
            })
          };
        }

        if (method === "PATCH" && url === "/api/rooms/room%3Acli") {
          const body = JSON.parse(String(init?.body ?? "{}")) as { name?: string };
          const roomFixture = roomFixtures[0]!;
          const updatedRoomFixture = {
            ...roomFixture,
            name: body.name ?? roomFixture.name,
            updatedAt: "2026-07-05T00:00:01.000Z",
            traceId: "req:room-rename"
          };
          roomFixtures[0] = updatedRoomFixture;
          return {
            ok: true,
            status: 200,
            json: async () => updatedRoomFixture
          };
        }

        if (method === "PATCH" && url === "/api/panes/pane%3Acli") {
          const body = JSON.parse(String(init?.body ?? "{}")) as {
            title?: string;
            isMaximized?: boolean;
            isMinimized?: boolean;
            columnSpan?: number;
          };
          currentCliPane = {
            ...currentCliPane,
            title: body.title ?? currentCliPane.title,
            columnSpan: body.columnSpan ?? currentCliPane.columnSpan,
            isMaximized: body.isMinimized === true ? false : body.isMaximized ?? currentCliPane.isMaximized,
            isMinimized: body.isMaximized === true ? false : body.isMinimized ?? currentCliPane.isMinimized,
            updatedAt: "2026-07-05T00:00:02.000Z"
          };
          return {
            ok: true,
            status: 200,
            json: async () => currentCliPane
          };
        }

        if (method === "POST" && url === "/api/panes") {
          const body = JSON.parse(String(init?.body ?? "{}")) as {
            roomId?: string;
            title?: string;
            mode?: "CHAT" | "TERMINAL" | "BROWSER";
            cwd?: string;
            terminalRuntimeId?: string;
          };
          if (body.roomId === "room:new") {
            const createdPane = pane(`pane:new-room-${createdRoomPanes.length + 1}`, body.mode ?? "TERMINAL", body.title ?? "CLI");
            createdRoomPanes.push({ ...createdPane, roomId: "room:new", order: createdRoomPanes.length });
            return { ok: true, status: 200, json: async () => createdRoomPanes.at(-1) };
          }
          if (body.terminalRuntimeId === "cli:root") {
            const createdPane = {
              ...pane("pane:root", "TERMINAL", "CLI ROOT"),
              cwd: "/etc",
              terminalRuntimeId: "cli:root"
            };
            createdCliPanes.set(createdPane.id, createdPane);
            return {
              ok: true,
              status: 200,
              json: async () => createdPane
            };
          }
          if (body.terminalRuntimeId === "cli:claude") {
            const createdPane = {
              ...pane("pane:claude", "TERMINAL", "Claude Code CLI"),
              cwd: "/etc",
              terminalRuntimeId: "cli:claude"
            };
            createdCliPanes.set(createdPane.id, createdPane);
            return {
              ok: true,
              status: 200,
              json: async () => createdPane
            };
          }
          if (body.terminalRuntimeId === "cli:gemini") {
            const createdPane = {
              ...pane("pane:gemini", "TERMINAL", "Gemini CLI"),
              cwd: "/etc",
              terminalRuntimeId: "cli:gemini"
            };
            createdCliPanes.set(createdPane.id, createdPane);
            return {
              ok: true,
              status: 200,
              json: async () => createdPane
            };
          }
          if (body.terminalRuntimeId === "cli:opencode") {
            const createdPane = {
              ...pane("pane:opencode", "TERMINAL", "OpenCode CLI"),
              cwd: "/etc",
              terminalRuntimeId: "cli:opencode"
            };
            createdCliPanes.set(createdPane.id, createdPane);
            return {
              ok: true,
              status: 200,
              json: async () => createdPane
            };
          }
          if (body.terminalRuntimeId === "cli:qwen") {
            const createdPane = {
              ...pane("pane:qwen", "TERMINAL", "Qwen Code CLI"),
              cwd: "/etc",
              terminalRuntimeId: "cli:qwen"
            };
            createdCliPanes.set(createdPane.id, createdPane);
            return {
              ok: true,
              status: 200,
              json: async () => createdPane
            };
          }
          if (body.terminalRuntimeId === "cli:kimi") {
            const createdPane = {
              ...pane("pane:kimi", "TERMINAL", "Kimi Code CLI"),
              cwd: "/etc",
              terminalRuntimeId: "cli:kimi"
            };
            createdCliPanes.set(createdPane.id, createdPane);
            return {
              ok: true,
              status: 200,
              json: async () => createdPane
            };
          }
          if (body.terminalRuntimeId === "cli:grok") {
            const createdPane = {
              ...pane("pane:grok", "TERMINAL", "Grok Build CLI"),
              cwd: "/etc",
              terminalRuntimeId: "cli:grok"
            };
            createdCliPanes.set(createdPane.id, createdPane);
            return {
              ok: true,
              status: 200,
              json: async () => createdPane
            };
          }
          createdCliPanes.set(newCliPane.id, newCliPane);
          return { ok: true, status: 200, json: async () => newCliPane };
        }

        if (method === "GET" && url === "/api/panes/pane%3Akimi/cli/session?includeTranscript=false") {
          return { ok: true, status: 200, json: async () => null };
        }

        if (method === "GET" && url === "/api/panes/pane%3Agrok/cli/session?includeTranscript=false") {
          return { ok: true, status: 200, json: async () => null };
        }

        if (method === "GET" && url === "/api/panes/pane%3Aopencode/cli/session?includeTranscript=false") {
          return { ok: true, status: 200, json: async () => null };
        }

        if (method === "GET" && url === "/api/panes/pane%3Aclaude/cli/session?includeTranscript=false") {
          return { ok: true, status: 200, json: async () => null };
        }

        if (method === "GET" && url === "/api/panes/pane%3Agemini/cli/session?includeTranscript=false") {
          return { ok: true, status: 200, json: async () => null };
        }

        if (method === "GET" && url === "/api/panes/pane%3Aqwen/cli/session?includeTranscript=false") {
          return { ok: true, status: 200, json: async () => null };
        }

        if (method === "POST" && url === "/api/panes/pane%3Aclaude/cli/session") {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              session: {
                sessionId: "cli_session:claude",
                paneId: "pane:claude",
                roomId: "room:cli",
                runtimeId: "cli:claude",
                providerId: "anthropic",
                agentId: "claude",
                modelId: null,
                reasoningEffort: "medium",
                cwd: "/etc",
                codexThreadId: null,
                status: "IDLE",
                statusReason: "Claude Code CLI session allocated.",
                exitCode: null,
                isActive: true,
                startedAt: "2026-07-05T00:00:00.000Z",
                updatedAt: "2026-07-05T00:00:00.000Z",
                endedAt: null
              },
              transcript: [],
              websocket: null
            })
          };
        }

        if (method === "POST" && url === "/api/panes/pane%3Agemini/cli/session") {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              session: {
                sessionId: "cli_session:gemini",
                paneId: "pane:gemini",
                roomId: "room:cli",
                runtimeId: "cli:gemini",
                providerId: "google",
                agentId: "gemini",
                modelId: null,
                reasoningEffort: "medium",
                cwd: "/etc",
                codexThreadId: null,
                status: "IDLE",
                statusReason: "Gemini CLI session allocated.",
                exitCode: null,
                isActive: true,
                startedAt: "2026-07-21T00:00:00.000Z",
                updatedAt: "2026-07-21T00:00:00.000Z",
                endedAt: null
              },
              transcript: [],
              websocket: null
            })
          };
        }

        if (method === "POST" && url === "/api/panes/pane%3Aopencode/cli/session") {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              session: {
                sessionId: "cli_session:opencode",
                paneId: "pane:opencode",
                roomId: "room:cli",
                runtimeId: "cli:opencode",
                providerId: "cloudflare-workers-ai",
                agentId: "opencode",
                modelId: null,
                reasoningEffort: "medium",
                cwd: "/etc",
                codexThreadId: null,
                status: "IDLE",
                statusReason: "OpenCode CLI session allocated.",
                exitCode: null,
                isActive: true,
                startedAt: "2026-07-05T00:00:00.000Z",
                updatedAt: "2026-07-05T00:00:00.000Z",
                endedAt: null
              },
              transcript: [],
              websocket: null
            })
          };
        }

        if (method === "POST" && url === "/api/panes/pane%3Aqwen/cli/session") {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              session: {
                sessionId: "cli_session:qwen",
                paneId: "pane:qwen",
                roomId: "room:cli",
                runtimeId: "cli:qwen",
                providerId: "alibaba",
                agentId: "qwen",
                modelId: null,
                reasoningEffort: "medium",
                cwd: "/etc",
                codexThreadId: null,
                status: "IDLE",
                statusReason: "Qwen Code CLI session allocated.",
                exitCode: null,
                isActive: true,
                startedAt: "2026-07-21T00:00:00.000Z",
                updatedAt: "2026-07-21T00:00:00.000Z",
                endedAt: null
              },
              transcript: [],
              websocket: null
            })
          };
        }

        if (method === "POST" && url === "/api/panes/pane%3Akimi/cli/session") {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              session: {
                sessionId: "cli_session:kimi",
                paneId: "pane:kimi",
                roomId: "room:cli",
                runtimeId: "cli:kimi",
                providerId: "kimi-code",
                agentId: "kimi",
                modelId: null,
                reasoningEffort: "medium",
                cwd: "/etc",
                codexThreadId: null,
                status: "IDLE",
                statusReason: "Kimi Code CLI session allocated.",
                exitCode: null,
                isActive: true,
                startedAt: "2026-07-17T00:00:00.000Z",
                updatedAt: "2026-07-17T00:00:00.000Z",
                endedAt: null
              },
              transcript: [],
              websocket: null
            })
          };
        }

        if (method === "POST" && url === "/api/panes/pane%3Agrok/cli/session") {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              session: {
                sessionId: "cli_session:grok",
                paneId: "pane:grok",
                roomId: "room:cli",
                runtimeId: "cli:grok",
                providerId: "xai",
                agentId: "grok",
                modelId: null,
                reasoningEffort: "medium",
                cwd: "/etc",
                codexThreadId: null,
                status: "IDLE",
                statusReason: "Grok Build CLI session allocated.",
                exitCode: null,
                isActive: true,
                startedAt: "2026-07-20T00:00:00.000Z",
                updatedAt: "2026-07-20T00:00:00.000Z",
                endedAt: null
              },
              transcript: [],
              websocket: null
            })
          };
        }

        if (method === "POST" && url === "/api/panes/pane%3Acli/title/generate") {
          currentCliPane = {
            ...currentCliPane,
            title: "Summarize deployment blockers",
            updatedAt: "2026-07-05T00:00:03.000Z"
          };
          return {
            ok: true,
            status: 200,
            json: async () => currentCliPane
          };
        }

        if (method === "POST" && url === "/api/panes/pane%3Acli/cli/resume") {
          currentCliPane = {
            ...currentCliPane,
            title: "Resume selected task",
            cwd: "/opt/spaceapp",
            updatedAt: "2026-07-05T00:00:04.000Z"
          };
          return {
            ok: true,
            status: 200,
            json: async () => ({
              pane: currentCliPane,
              session: {
                sessionId: "cli_session:resumed",
                paneId: cliPane.id,
                roomId: cliPane.roomId,
                runtimeId: "cli:codex",
                providerId: "codex",
                agentId: "codex",
                modelId: null,
                reasoningEffort: "medium",
                cwd: "/opt/spaceapp",
                codexThreadId: "019f-resume-selected",
                status: "IDLE",
                statusReason: "CLI session allocated.",
                exitCode: null,
                isActive: true,
                startedAt: "2026-07-05T00:00:04.000Z",
                updatedAt: "2026-07-05T00:00:04.000Z",
                endedAt: null
              },
              runtime: {
                id: "cli:codex",
                providerId: "codex",
                providerName: "Codex",
                agentId: "codex",
                agentName: "Codex CLI",
                displayName: "Codex CLI",
                capabilities: ["CLI"],
                ...readyRuntimeAuth,
                status: "ENABLED",
                statusReason: "Codex CLI command and credential smoke are verified.",
                commandName: "codex",
                detectedCommandPath: "/opt/spaceapp/bin/codex",
                defaultModelId: null,
                supportedReasoningEfforts: ["medium", "high"],
                checkedAt: "2026-07-05T00:00:04.000Z"
              },
              transcript: [
                {
                  chunkId: "cli_chunk:resumed",
                  sessionId: "cli_session:resumed",
                  paneId: cliPane.id,
                  roomId: cliPane.roomId,
                  sequence: 0,
                  stream: "system",
                  content: "Resuming Resume selected task from Codex history.",
                  byteLength: 47,
                  createdAt: "2026-07-05T00:00:04.000Z"
                }
              ],
              websocket: null
            })
          };
        }

        if (method === "POST" && url.startsWith("/api/artifacts/uploads")) {
          return { ok: true, status: 200, json: async () => ({ artifacts: [] }) };
        }

        if (method === "POST" && url.startsWith("/api/artifacts/file-uploads")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              artifacts: [
                {
                  id: "artifact:browser-import",
                  roomId: "room:cli",
                  paneId: "pane:browser",
                  turnId: null,
                  workflowId: null,
                  kind: "EXPORT",
                  mimeType: "text/plain",
                  storageUri: "space-artifact://user-uploads/browser-note.txt",
                  sha256: "1".repeat(64),
                  byteSize: 4,
                  metadata: { source: "USER_UPLOAD", originalFilename: "browser-note.txt" },
                  createdAt: browserTimestamp,
                  traceId: "req:browser-import"
                }
              ]
            })
          };
        }

        const payloads: Record<string, unknown> = {
          "/api/auth/me": {
            user: { id: "user:operator", email: "space@space.local", role: "ADMIN" },
            isAuthenticated: true,
            isSetupRequired: false
          },
          "/readyz": {
            ok: true,
            dependencies: {
              store: "postgres",
              runtimeStore: "postgres",
              eventBus: "in-process",
              temporal: "enabled",
              worker: "RUNNING",
              codexTurns: "enabled",
              codexLb: "configured"
            }
          },
          "/api/rooms": paginated(roomFixtures),
          "/api/providers": paginated([]),
          "/api/provider-settings": {
            defaultProviderId: "headroom-gateway",
            titleGenerationModelId: null,
            titleGenerationReasoningEffort: "low",
            updatedAt: "2026-07-06T00:00:00.000Z"
          },
          "/api/models": paginated([]),
          "/api/skills": paginated([]),
          "/api/imports": { data: [], pagination: { page: 1, pageSize: 25, totalItems: 0, totalPages: 0 } },
          "/api/admin": { status: "ok", mode: "dev", storageWarning: "" },
          "/api/mcp": {
            data: [],
            gateway: {
              id: "mcp-gateway",
              status: "DISABLED",
              statusReason: "MCP discovery metadata is not verified.",
              targetSpecVersion: "2025-11-25",
              approvalMode: "DISABLED",
              serverCount: 0,
              toolCount: 0,
              lastDiscoveryAt: null
            },
            servers: [],
            tools: [],
            pagination: { page: 1, pageSize: 100, totalItems: 0, totalPages: 0 }
          },
          "/api/admin/mcp/discovery-smoke": { data: null },
          "/api/admin/memory/embedding-smoke": { data: null },
          "/api/admin/memory/vector-readiness": {
            data: {
              id: "memory-vector-readiness",
              status: "DISABLED",
              code: "VECTOR_STORE_NOT_POSTGRES",
              message: "Vector store is not ready.",
              runtimeStore: "postgres",
              extensionInstalled: false,
              extensionVersion: null,
              embeddingColumnReady: false,
              embeddingDimensions: null,
              expectedDimensions: 1536,
              vectorIndexReady: false,
              checkedAt: "2026-07-05T00:00:00.000Z"
            }
          },
          "/api/admin/codex-app-server": {
            id: "codex-app-server",
            status: "READY",
            reasonCode: "CONFIG_SAFE",
            statusReason: "Codex App Server config is safe.",
            transport: "stdio",
            command: "codex",
            socketPath: null,
            websocketUrl: null,
            schemasGenerated: true,
            schemaManifest: null,
            lastCheckedAt: "2026-07-05T00:00:00.000Z"
          },
          "/api/admin/codex-app-server/handshake": { data: null },
          "/api/admin/codex-app-server/turn-smoke": { data: null },
          "/api/admin/storage": {
            id: "space-storage",
            status: "VERIFIED",
            statusReason: "Storage ready.",
            root: { path: "/", deviceId: "100", sizeBytes: 1, availableBytes: 1, usedPercent: 0 },
            app: { path: "/opt/spaceapp", deviceId: "200", sizeBytes: 1, availableBytes: 1, usedPercent: 0 },
            dedicatedAppVolume: true,
            minimumRecommendedFreeBytes: 1,
            checkedAt: "2026-07-05T00:00:00.000Z"
          },
          "/api/admin/observability": {
            service: "space-api",
            generatedAt: "2026-07-05T00:00:00.000Z",
            runtime: {
              startedAt: "2026-07-05T00:00:00.000Z",
              uptimeSeconds: 1,
              nodeVersion: "v22.23.0",
              pid: 207,
              memory: { rssBytes: 1, heapUsedBytes: 1, heapTotalBytes: 1, externalBytes: 0, arrayBuffersBytes: 0 }
            },
            totals: { requestCount: 1, errorCount: 0, errorRate: 0, p50Ms: 1, p95Ms: 1, p99Ms: 1 },
            endpoints: []
          },
          "/api/admin/worker": {
            id: "space-worker",
            status: "RUNNING",
            statusReason: "Temporal worker pollers are visible.",
            address: "127.0.0.1:7233",
            namespace: "default",
            taskQueue: "space-agent-turns",
            reachable: true,
            workflowPollerCount: 1,
            activityPollerCount: 1,
            pollerCount: 2,
            pollerIdentities: ["space-worker@test"],
            lastPollerAccessAt: "2026-07-05T00:00:00.000Z",
            checkedAt: "2026-07-05T00:00:00.000Z"
          },
          "/api/panes?roomId=room%3Acli": paginated([
            chatPane,
            currentCliPane,
            browserPane,
            ...createdCliPanes.values()
          ]),
          "/api/swarm?roomId=room%3Acli": {
            tasks: [],
            locks: [],
            messages: [],
            reconciles: [],
            executionStatus: "DISABLED",
            statusReason: "Swarm execution is control-plane only."
          },
          "/api/turns?roomId=room%3Acli": paginated([]),
          "/api/events?roomId=room%3Acli&pageSize=50&sortOrder=desc": {
            data: [chatTurnCompletedEvent, cliTurnCompletedEvent],
            pagination: { page: 1, pageSize: 50, totalItems: 2, totalPages: 1 }
          },
          "/api/browser/status": {
            enabled: true,
            statusReason: "Managed Chrome browser sessions are enabled.",
            defaultUrl: "https://www.google.com/",
            checkedAt: browserTimestamp
          },
          "/api/panes/pane%3Abrowser/browser/session": browserSessionResponse,
          "/api/marketing-copilot/bookmarks": { bookmarks: [] },
          "/api/panes/pane%3Acli/cli/session?includeTranscript=false": {
            session: {
              sessionId: "cli_session:debug-badge",
              paneId: cliPane.id,
              roomId: cliPane.roomId,
              runtimeId: "cli:codex",
              providerId: "codex",
              agentId: "codex",
              modelId: null,
              reasoningEffort: "medium",
              cwd: "/etc",
              codexThreadId: "019f3805-9299-7b92-b70c-cd4d49b02774",
              status: "IDLE",
              statusReason: "CLI session allocated.",
              exitCode: null,
              isActive: true,
              startedAt: "2026-07-05T00:00:00.000Z",
              updatedAt: "2026-07-05T00:00:00.000Z",
              endedAt: null
            },
            transcript: [
              {
                chunkId: "cli_chunk:debug-badge",
                sessionId: "cli_session:debug-badge",
                paneId: cliPane.id,
                roomId: cliPane.roomId,
                sequence: 0,
                stream: "system",
                content: "Codex CLI session allocated by Space.",
                byteLength: 37,
                createdAt: "2026-07-05T00:00:00.000Z"
              }
            ],
            websocket: null
          },
          "/api/panes?roomId=room%3Anew": paginated(createdRoomPanes),
          "/api/swarm?roomId=room%3Anew": {
            tasks: [],
            locks: [],
            messages: [],
            reconciles: [],
            executionStatus: "DISABLED",
            statusReason: "Swarm execution is control-plane only."
          },
          "/api/turns?roomId=room%3Anew": paginated([]),
          "/api/events?roomId=room%3Anew&pageSize=50&sortOrder=desc": {
            data: [],
            pagination: { page: 1, pageSize: 50, totalItems: 0, totalPages: 0 }
          },
          "/api/rooms/room%3Acli/agent-history": paginated([]),
          "/api/cli/tasks?page=1&pageSize=50": {
            threads: [
              {
                id: "cli_session:history-selected",
                taskId: "cli_session:history-selected",
                title: "Resume selected task",
                runtimeId: "cli:codex",
                providerId: "codex",
                providerLabel: "Codex",
                modelProvider: "codex",
                preview: "Space CLI task from history",
                model: "gpt-5.5",
                reasoningEffort: "high",
                cwd: "/opt/spaceapp",
                archived: false,
                source: "space",
                threadSource: "cli:codex",
                rolloutPath: null,
                firstUserMessage: "Space CLI task from history",
                updatedAt: "2026-07-05T00:00:04.000Z",
                recencyAt: "2026-07-05T00:00:04.000Z"
              }
            ],
            total: 1,
            page: 1,
            pageSize: 50
          },
          "/api/cli/tasks?page=1&pageSize=50&q=older+prompt": {
            threads: [
              {
                id: "cli_session:history-selected",
                taskId: "cli_session:history-selected",
                title: "Resume selected task",
                runtimeId: "cli:codex",
                providerId: "codex",
                providerLabel: "Codex",
                modelProvider: "codex",
                preview: "Space CLI task from history",
                model: "gpt-5.5",
                reasoningEffort: "high",
                cwd: "/opt/spaceapp",
                archived: false,
                source: "space",
                threadSource: "cli:codex",
                rolloutPath: null,
                firstUserMessage: "Find this older prompt",
                updatedAt: "2026-07-05T00:00:04.000Z",
                recencyAt: "2026-07-05T00:00:04.000Z"
              }
            ],
            total: 1,
            page: 1,
            pageSize: 50
          },
          "/api/cli/runtimes": {
            data: [
              {
                id: "web:codex-app-server",
                providerId: "codex",
                providerName: "Codex",
                agentId: "codex-app-server",
                agentName: "Codex Web Chat",
                displayName: "Codex Web Chat",
                capabilities: ["WEB_CHAT"],
                status: "ENABLED",
                statusReason: "Codex App Server is configured for Space-native web chat.",
                commandName: null,
                detectedCommandPath: null,
                defaultModelId: "codex-app-server-default",
                supportedReasoningEfforts: ["medium"],
                checkedAt: "2026-07-05T00:00:00.000Z"
              },
              {
                id: "cli:codex",
                providerId: "codex",
                providerName: "Codex",
                agentId: "codex",
                agentName: "Codex CLI",
                displayName: "Codex CLI",
                capabilities: ["CLI"],
                ...readyRuntimeAuth,
                status: "ENABLED",
                statusReason: "Codex CLI command and credential smoke are verified.",
                commandName: "codex",
                detectedCommandPath: "/opt/spaceapp/bin/codex",
                defaultModelId: null,
                supportedReasoningEfforts: ["medium", "high"],
                checkedAt: "2026-07-05T00:00:00.000Z"
              },
              {
                id: "cli:claude",
                providerId: "anthropic",
                providerName: "Claude Code via Legacy",
                agentId: "claude",
                agentName: "Claude Code CLI",
                displayName: "Claude Code CLI",
                capabilities: ["CLI"],
                ...readyRuntimeAuth,
                status: "ENABLED",
                statusReason: "Claude Code via Legacy direct operator parity is verified.",
                commandName: "claude-vscode-parity",
                detectedCommandPath: "/opt/spaceapp/bin/claude-vscode-parity",
                defaultModelId: null,
                supportedReasoningEfforts: [],
                checkedAt: "2026-07-05T00:00:00.000Z"
              },
              {
                id: "cli:gemini",
                providerId: "google",
                providerName: "Google",
                agentId: "gemini",
                agentName: "Gemini CLI",
                displayName: "Gemini CLI",
                capabilities: ["CLI"],
                ...readyRuntimeAuth,
                status: "ENABLED",
                statusReason: "Gemini CLI Google OAuth credentials are verified.",
                commandName: "gemini-vscode-parity",
                detectedCommandPath: "/opt/spaceapp/bin/gemini-vscode-parity",
                defaultModelId: null,
                supportedReasoningEfforts: [],
                checkedAt: "2026-07-21T00:00:00.000Z"
              },
              {
                id: "cli:opencode",
                providerId: "cloudflare-workers-ai",
                providerName: "OpenCode",
                agentId: "opencode",
                agentName: "OpenCode CLI",
                displayName: "OpenCode CLI",
                capabilities: ["CLI"],
                ...readyRuntimeAuth,
                status: "ENABLED",
                statusReason: "OpenCode CLI direct operator parity is verified.",
                commandName: "opencode-vscode-parity",
                detectedCommandPath: "/opt/spaceapp/bin/opencode-vscode-parity",
                defaultModelId: null,
                supportedReasoningEfforts: [],
                checkedAt: "2026-07-05T00:00:00.000Z"
              },
              {
                id: "cli:qwen",
                providerId: "alibaba",
                providerName: "Alibaba Coding Plan International",
                agentId: "qwen",
                agentName: "Qwen Code CLI",
                displayName: "Qwen Code CLI",
                capabilities: ["CLI"],
                ...readyRuntimeAuth,
                status: "ENABLED",
                statusReason: "Qwen Code International Coding Plan credentials are verified.",
                commandName: "qwen-vscode-parity",
                detectedCommandPath: "/opt/spaceapp/bin/qwen-vscode-parity",
                defaultModelId: null,
                supportedReasoningEfforts: [],
                checkedAt: "2026-07-21T00:00:00.000Z"
              },
              {
                id: "cli:kimi",
                providerId: "kimi-code",
                providerName: "Kimi Code Subscription",
                agentId: "kimi",
                agentName: "Kimi Code CLI",
                displayName: "Kimi Code CLI",
                capabilities: ["CLI"],
                ...readyRuntimeAuth,
                status: "ENABLED",
                statusReason: "Kimi Code subscription direct operator parity is verified.",
                commandName: "kimi-vscode-parity",
                detectedCommandPath: "/opt/spaceapp/bin/kimi-vscode-parity",
                defaultModelId: null,
                supportedReasoningEfforts: [],
                checkedAt: "2026-07-17T00:00:00.000Z"
              },
              {
                id: "cli:grok",
                providerId: "xai",
                providerName: "Grok Build",
                agentId: "grok",
                agentName: "Grok Build CLI",
                displayName: "Grok Build CLI",
                capabilities: ["CLI"],
                ...readyRuntimeAuth,
                status: "ENABLED",
                statusReason: "Grok Build account direct operator parity is verified.",
                commandName: "grok-vscode-parity",
                detectedCommandPath: "/opt/spaceapp/bin/grok-vscode-parity",
                defaultModelId: null,
                supportedReasoningEfforts: [],
                checkedAt: "2026-07-20T00:00:00.000Z"
              },
              {
                id: "cli:root",
                providerId: "root",
                providerName: "Root",
                agentId: "root",
                agentName: "Root Shell",
                displayName: "CLI ROOT",
                capabilities: ["CLI"],
                status: "ENABLED",
                statusReason: "Dedicated root shell host is enabled.",
                commandName: "/bin/bash",
                detectedCommandPath: "/bin/bash",
                defaultModelId: null,
                supportedReasoningEfforts: [],
                checkedAt: "2026-07-17T00:00:00.000Z"
              }
            ],
            checkedAt: "2026-07-05T00:00:00.000Z"
          },
          "/api/auth/csrf": { csrfToken: "csrf:test", headerName: csrfHeaderName }
        };

        if (method === "GET" && url === "/api/rooms?all=true") {
          return { ok: true, status: 200, json: async () => payloads["/api/rooms"] };
        }
        if (!(url in payloads)) {
          throw new Error(`Missing fixture for ${method} ${url}`);
        }

        return {
          ok: true,
          status: 200,
          json: async () => payloads[url]
        };
      })
    );

    try {
      render(<App />);

      expect(await screen.findByLabelText("CLI pane Codex CLI")).toBeTruthy();
      const initialRoomButton = await screen.findByRole("button", { name: "Open CLI Room" });
      await waitFor(() => expect(initialRoomButton.querySelector(".room-cli-badge")?.textContent).toBe("Panes 3"));
      expect(screen.queryByText("019f3805")).toBeNull();
      expect(window.localStorage.getItem("space.showSessionDebugIds")).toBe("true");
      // Dock and CLI-float toggles live in the Workspace navigation menu (9e0ba4b9c6, 4d2bc9d1a4).
      fireEvent.click(await workspaceAction(/^(Open|Show) settings dock$/));
      expect(await screen.findByText("Settings")).toBeTruthy();
      expect(screen.queryByText("Debug messages")).toBeNull();
      expect(screen.queryByLabelText("Session debug IDs")).toBeNull();
      expect(screen.queryByLabelText("Show terminal debug messages")).toBeNull();
      expect(window.localStorage.getItem("space.showSessionDebugIds")).toBe("true");
      await waitFor(() => expect(screen.queryByText("019f3805")).toBeNull());
      const browserCard = await screen.findByLabelText("Browser 3 agent 3");
      expect(browserCard).toBeTruthy();
      // The lazily loaded browser pane can take over 1 s to load under test-runner load.
      expect(await screen.findByLabelText("Browser URL Browser 3", {}, { timeout: 10_000 })).toBeTruthy();
      expect(await screen.findByLabelText("PC view Browser 3")).toBeTruthy();
      expect(await screen.findByLabelText("Tablet view Browser 3")).toBeTruthy();
      expect(await screen.findByLabelText("Mobile view Browser 3")).toBeTruthy();
      expect(await screen.findByRole("img", { name: "Browser 3 browser frame" })).toBeTruthy();
      expect(screen.queryByText("Browser pool is disabled until storage and worker gates pass.")).toBeNull();
      expect(screen.queryByText("No turns yet")).toBeNull();
      expect(await screen.findByText("Codex CLI session allocated by Space.")).toBeTruthy();
      const plannerCard = await screen.findByLabelText("Planner agent 1");
      const cliCard = await screen.findByLabelText("Codex CLI agent 2");
      expect(cliCard.querySelector(".pane-agent-badge")?.getAttribute("title")).toContain("Codex CLI session");
      expect(plannerCard.getAttribute("data-completion-state")).toBe("acknowledged");
      expect(plannerCard.className.includes("is-completion-pending")).toBe(false);
      // The lazily loaded chat pane, like the browser pane above, can take over 1 s under test-runner load.
      await waitFor(() =>
        expect(plannerCard.querySelector('[data-workspace-text-size="12"]')).toBeTruthy(),
        { timeout: 10_000 }
      );
      expect(screen.queryByRole("status", { name: "Planner ended" })).toBeNull();
      expect(cliCard.getAttribute("data-completion-state")).toBe("acknowledged");
      expect(screen.queryByRole("status", { name: "Codex CLI ended" })).toBeNull();
      fireEvent.click(await workspaceAction("Hide CLI floats"));
      expect(screen.queryByRole("status", { name: "Codex CLI ended" })).toBeNull();
      expect(cliCard.getAttribute("data-completion-state")).toBe("acknowledged");
      expect(cliCard.className).not.toContain("is-completion-pending");
      fireEvent.click(await workspaceAction("Show CLI floats"));
      expect(screen.queryByRole("status", { name: "Codex CLI ended" })).toBeNull();
      fireEvent.pointerDown(browserCard);
      await waitFor(() => expect(browserCard.className).toContain("is-target"));
      expect(cliCard.getAttribute("data-completion-state")).toBe("acknowledged");
      expect(plannerCard.className.includes("is-target")).toBe(false);
      const cliTextarea = document.createElement("textarea");
      cliTextarea.className = "xterm-helper-textarea";
      cliCard.append(cliTextarea);
      cliTextarea.focus();
      await waitFor(() => expect(browserCard.className).toContain("is-target"));
      expect(cliCard.className.includes("is-target")).toBe(false);
      fireEvent.pointerDown(cliCard);
      await waitFor(() => expect(cliCard.className).toContain("is-target"));
      expect(cliCard.getAttribute("data-completion-state")).toBe("acknowledged");
      await waitFor(() => expect(screen.queryByRole("status", { name: "Codex CLI ended" })).toBeNull());
      expect(browserCard.className.includes("is-target")).toBe(false);
      expect(screen.queryByLabelText("Split width Codex CLI")).toBeNull();
      expect(screen.queryByLabelText("Split height Codex CLI")).toBeNull();
      // Since af3398ff50 CLI panes keep every quick action, including Add pane, in the More pane actions menu.
      const cliPaneActionsTrigger = () => cliCard.querySelector<HTMLButtonElement>(".pane-actions-overflow > button")!;
      const openCliPaneActions = async () => {
        fireEvent.click(cliPaneActionsTrigger());
        return screen.findByRole("menu", { name: /^Pane actions / });
      };
      const addPaneFromCli = within(await openCliPaneActions()).getByRole("menuitem", { name: "Add pane from Codex CLI" });
      expect((addPaneFromCli as HTMLButtonElement).disabled).toBe(false);
      fireEvent.click(cliPaneActionsTrigger());
      await waitFor(() => expect(screen.queryByRole("menu", { name: /^Pane actions / })).toBeNull());
      expect(screen.queryByLabelText("Import files Codex CLI")).toBeNull();
      expect(screen.queryByLabelText("Enable Plan mode Codex CLI")).toBeNull();
      expect(screen.queryByLabelText("Resume Codex CLI")).toBeNull();
      // The default Modern theme keeps its own migrated toolbar preferences (30040ccc45, 172180e9f5).
      await waitFor(() =>
        expect(JSON.parse(window.localStorage.getItem("space.modern.toolbar.pane.sharedCodex.hiddenActionIds.v1") ?? "[]")).not.toContain("resume")
      );
      expect(screen.queryByLabelText("Stop Codex CLI")).toBeNull();
      expect(screen.queryByLabelText("Save Codex CLI to memory")).toBeNull();
      expect(screen.queryByLabelText("Copy CLI contents Codex CLI")).toBeNull();
      expect(screen.queryByLabelText("Reconnect CLI Codex CLI")).toBeNull();
      expect(await screen.findByLabelText("More pane actions Codex CLI")).toBeTruthy();
      expect(within(cliCard).getByText("Codex CLI")).toBeTruthy();
      expect(within(cliCard).queryByRole("button", { name: "Edit pane title Codex CLI" })).toBeNull();
      expect(within(cliCard).queryByRole("button", { name: "Generate pane title with AI Codex CLI" })).toBeNull();
      expect(cliCard.querySelector(".pane-title-tools")).toBeNull();
      const cliBadge = cliCard.querySelector(".pane-agent-badge") as HTMLElement;
      expect(cliBadge).toBeTruthy();
      fireEvent.contextMenu(cliBadge, { clientX: 40, clientY: 80 });
      const badgeMenu = await screen.findByRole("menu", { name: "Pane menu Codex CLI" });
      expect(within(badgeMenu).getByRole("menuitem", { name: "Copy session info" })).toBeTruthy();
      expect(within(badgeMenu).getByRole("menuitem", { name: "Edit pane title" })).toBeTruthy();
      expect(within(badgeMenu).getByRole("menuitem", { name: "Generate pane title" })).toBeTruthy();
      expect(screen.queryByRole("menu", { name: "Pane menu Codex CLI" })).toBeTruthy();
      fireEvent.click(within(badgeMenu).getByRole("menuitem", { name: "Copy session info" }));
      // This test's fixture serves the active "debug-badge" session that the pane attaches.
      await waitFor(() => expect(writeClipboardText).toHaveBeenLastCalledWith([
        "CLI session ID: cli_session:debug-badge",
        "Codex thread ID: 019f3805-9299-7b92-b70c-cd4d49b02774"
      ].join("\n")));
      await waitFor(() => expect(screen.queryByRole("menu", { name: "Pane menu Codex CLI" })).toBeNull());
      const initialPaneActionLabels = Array.from(cliCard.querySelectorAll(".pane-actions > button")).map((button) => button.getAttribute("aria-label"));
      expect(initialPaneActionLabels).toEqual([]);
      expect(cliCard.querySelectorAll(".pane-actions-fixed button")).toHaveLength(4);
      // Browser panes expose only Add pane since ebe85a1e7a/fcfb6237cd (no Import files or Target action).
      expect(screen.queryByLabelText("Import files Browser 3")).toBeNull();
      expect(screen.queryByLabelText("Interrupt CLI Codex CLI")).toBeNull();
      expect(screen.queryByLabelText("Target Codex CLI")).toBeNull();
      expect(screen.queryByLabelText("Increase CLI font size Codex CLI")).toBeNull();
      expect(screen.queryByLabelText("Decrease CLI font size Codex CLI")).toBeNull();

      fireEvent.contextMenu(cliCard.querySelector(".pane-agent-badge") as HTMLElement, { clientX: 40, clientY: 80 });
      fireEvent.click(within(await screen.findByRole("menu", { name: "Pane menu Codex CLI" })).getByRole("menuitem", { name: "Edit pane title" }));
      const titleInput = await screen.findByLabelText("Pane title");
      expect(await screen.findByLabelText("Save pane title")).toBeTruthy();
      expect(await screen.findByLabelText("Cancel pane title")).toBeTruthy();
      fireEvent.change(titleInput, { target: { value: "Deploy task" } });
      fireEvent.click(await screen.findByLabelText("Save pane title"));
      await waitFor(() =>
        expect(
          requestBodies.some((request) => request.url === "/api/panes/pane%3Acli" && request.body.includes("\"title\":\"Deploy task\""))
        ).toBe(true)
      );
      expect(within(cliCard).getByText("Deploy task")).toBeTruthy();

      const panePatchCount = requestBodies.filter((request) => request.url === "/api/panes/pane%3Acli").length;
      fireEvent.contextMenu(cliCard.querySelector(".pane-agent-badge") as HTMLElement, { clientX: 40, clientY: 80 });
      fireEvent.click(within(await screen.findByRole("menu", { name: "Pane menu Deploy task" })).getByRole("menuitem", { name: "Edit pane title" }));
      const cancelledTitleInput = await screen.findByLabelText("Pane title");
      fireEvent.change(cancelledTitleInput, { target: { value: "Discarded title" } });
      fireEvent.click(await screen.findByLabelText("Cancel pane title"));
      expect(screen.queryByLabelText("Pane title")).toBeNull();
      expect(within(cliCard).getByText("Deploy task")).toBeTruthy();
      expect(requestBodies.filter((request) => request.url === "/api/panes/pane%3Acli")).toHaveLength(panePatchCount);

      fireEvent.contextMenu(cliCard.querySelector(".pane-agent-badge") as HTMLElement, { clientX: 40, clientY: 80 });
      fireEvent.click(within(await screen.findByRole("menu", { name: "Pane menu Deploy task" })).getByRole("menuitem", { name: "Edit pane title" }));
      const savedTitleInput = await screen.findByLabelText("Pane title");
      fireEvent.change(savedTitleInput, { target: { value: "Rollback checklist" } });
      fireEvent.click(await screen.findByLabelText("Save pane title"));
      await waitFor(() =>
        expect(
          requestBodies.some(
            (request) => request.url === "/api/panes/pane%3Acli" && request.body.includes("\"title\":\"Rollback checklist\"")
          )
        ).toBe(true)
      );
      expect(within(cliCard).getByText("Rollback checklist")).toBeTruthy();

      fireEvent.contextMenu(cliCard.querySelector(".pane-agent-badge") as HTMLElement, { clientX: 40, clientY: 80 });
      fireEvent.click(within(await screen.findByRole("menu", { name: "Pane menu Rollback checklist" })).getByRole("menuitem", { name: "Generate pane title" }));
      await waitFor(() => expect(requests).toContain("POST /api/panes/pane%3Acli/title/generate"));
      expect(within(cliCard).getByText("Summarize deployment blockers")).toBeTruthy();

      // Uploading needs a CLI that has drawn its prompt; until then the item says why instead of failing.
      const cliActionsForUpload = await openCliPaneActions();
      const uploadItem = within(cliActionsForUpload).getByRole("menuitem", { name: "Import files Summarize deployment blockers" }) as HTMLButtonElement;
      expect(uploadItem.disabled).toBe(true);
      expect(uploadItem.title).toBe("Wait for the CLI to finish starting.");
      fireEvent.click(uploadItem);
      expect(screen.queryByText("Attach a CLI session before uploading files.")).toBeNull();
      fireEvent.keyDown(cliActionsForUpload, { key: "Escape" });

      // Since 4d2bc9d1a4 the text size and room theme pickers open inline inside the Workspace menu.
      fireEvent.click(await workspaceAction("Workspace text size"));
      fireEvent.click(await screen.findByRole("option", { name: "13 px" }));
      expect(window.localStorage.getItem("space.terminal.fontSize")).toBe("13");
      expect(plannerCard.querySelector('[data-workspace-text-size="13"]')).toBeTruthy();
      expect(cliCard.querySelector('[data-workspace-text-size="13"]')).toBeTruthy();
      expect(screen.getByRole("listbox", { name: "Workspace text size" })).toBeTruthy();
      fireEvent.click(screen.getByRole("option", { name: "12 px" }));
      expect(window.localStorage.getItem("space.terminal.fontSize")).toBe("12");

      expect(screen.queryByText("Forest")).toBeNull();
      fireEvent.keyDown(screen.getByRole("dialog", { name: "Workspace" }), { key: "Escape" });
      fireEvent.click(await workspaceAction("Room theme"));
      expect(screen.queryByRole("listbox", { name: "Workspace text size" })).toBeNull();
      fireEvent.click(await screen.findByRole("menuitemradio", { name: "Forest" }));
      expect(window.localStorage.getItem("space.room.theme")).toBe("forest");
      // The embedded picker stays open until dismissed; Escape closes it, then the Workspace menu.
      fireEvent.keyDown(screen.getByRole("menu", { name: "Room theme options" }), { key: "Escape" });
      const workspaceMenuAfterTheme = screen.queryByRole("dialog", { name: "Workspace" });
      if (workspaceMenuAfterTheme) fireEvent.keyDown(workspaceMenuAfterTheme, { key: "Escape" });
      await waitFor(() => expect(screen.queryByText("Forest")).toBeNull());

      fireEvent.click(await screen.findByLabelText("Rename CLI Room"));
      const roomNameInput = await screen.findByLabelText("Room name");
      fireEvent.change(roomNameInput, { target: { value: "Ops Room" } });
      fireEvent.submit(roomNameInput.closest("form") as HTMLFormElement);
      await waitFor(() =>
        expect(
          requestBodies.some(
            (request) => request.url === "/api/rooms/room%3Acli" && request.body.includes("\"name\":\"Ops Room\"")
          )
        ).toBe(true)
      );
      expect(await screen.findByRole("heading", { name: "Ops Room" })).toBeTruthy();
      // The desktop Rooms dock is already open inline (2b004d2569), so there is no "Show rooms" step.
      expect(screen.getByRole("button", { name: "Hide rooms" })).toBeTruthy();
      expect(await screen.findByLabelText("Open Ops Room")).toBeTruthy();

      // Room actions (theme, add-pane launchers) moved from the room toolbar into the Workspace menu
      // (9e0ba4b9c6, 4d2bc9d1a4); their per-action hide/show/reorder customization is gone from the toolbar.
      expect(screen.queryByLabelText("Room theme")).toBeNull();
      expect(screen.queryByLabelText("More room actions")).toBeNull();

      // CLI pane actions live only in the pane menu (af3398ff50): they cannot be hidden and reorder there,
      // persisted under the Modern theme's own key (30040ccc45).
      const paneActionManager = await openCliPaneActions();
      expect(within(paneActionManager).queryByRole("menuitemcheckbox")).toBeNull();
      expect(within(paneActionManager).getAllByRole("menuitem").length).toBeGreaterThan(0);
      const copyCliAction = within(paneActionManager).getByRole("menuitem", { name: "Copy CLI contents Summarize deployment blockers" });
      const planAction = within(paneActionManager).getByRole("menuitem", { name: "Enable Plan mode Summarize deployment blockers" });
      fireEvent.dragStart(copyCliAction);
      fireEvent.dragOver(planAction);
      fireEvent.drop(planAction);
      fireEvent.dragEnd(copyCliAction);
      const modernPaneOrderKey = "space.modern.toolbar.pane.sharedCodex.actionOrder.v1";
      await waitFor(() => expect(window.localStorage.getItem(modernPaneOrderKey)).toContain("\"copy\""));
      const storedPaneOrder = JSON.parse(window.localStorage.getItem(modernPaneOrderKey) ?? "[]") as string[];
      expect(storedPaneOrder.indexOf("copy")).toBeLessThan(storedPaneOrder.indexOf("plan"));
      if (screen.queryByRole("menu", { name: /^Pane actions / })) fireEvent.click(cliPaneActionsTrigger());
      await waitFor(() => expect(screen.queryByRole("menu", { name: /^Pane actions / })).toBeNull());

      expect(screen.queryByLabelText("browser dock")).toBeNull();
      expect(screen.queryByLabelText("Open Chrome browser")).toBeNull();
      expect(screen.queryByLabelText("Open browser bookmarks")).toBeNull();
      expect(screen.queryByLabelText("Import browser bookmarks")).toBeNull();
      expect(screen.queryByLabelText("Join browser session")).toBeNull();
      expect(screen.queryByText("Safe Chrome mode will use persistent user-owned profiles")).toBeNull();
      expect(screen.queryByText("GATED")).toBeNull();

      fireEvent.pointerDown(browserCard);
      await waitFor(() => expect(browserCard.className).toContain("is-target"));
      // Since eb8ecc2f71 the Workspace Clip Tool opens the inline Snip Tool aimed at the active pane;
      // the drag-to-capture upload pipeline is covered by tests/snip-tool.test.tsx.
      fireEvent.click(await workspaceAction("Clip Tool"));
      // Since 057664cd0d the compact capsule names its target; the destination select lives in the editor.
      expect(await screen.findByRole("button", { name: /^Capture full screen for .*Browser 3/ }, { timeout: 10_000 })).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Close Snip Tool" }));
      await waitFor(() => expect(screen.queryByRole("region", { name: "Snip Tool" })).toBeNull());
      const workspaceMenuAfterSnip = screen.queryByRole("dialog", { name: "Workspace" });
      if (workspaceMenuAfterSnip) fireEvent.keyDown(workspaceMenuAfterSnip, { key: "Escape" });

      fireEvent.click(await screen.findByLabelText("More browser actions Browser 3"));
      fireEvent.click(await screen.findByLabelText("Browser bookmarks Browser 3"));
      await waitFor(() => expect(requests).toContain("GET /api/marketing-copilot/bookmarks"));
      expect(await screen.findByText("No bookmarks yet")).toBeTruthy();

      // Since 8d7e305950 a hidden dock stays mounted (inert, aria-hidden), so check its accessible role.
      fireEvent.click(await screen.findByLabelText("Hide rooms"));
      await waitFor(() => expect(screen.queryByRole("complementary", { name: "Rooms" })).toBeNull());
      expect(window.localStorage.getItem("space.roomsRailHidden")).toBe("true");
      const activityRequestsWhileHidden = requests.filter((request) => request === "GET /api/rooms/cli-activity").length;
      roomCliCount = 5;
      await Promise.resolve();
      expect(requests.filter((request) => request === "GET /api/rooms/cli-activity")).toHaveLength(activityRequestsWhileHidden);
      fireEvent.click(await screen.findByLabelText("Show rooms"));
      expect(await screen.findByRole("complementary", { name: "Rooms" })).toBeTruthy();
      await waitFor(() =>
        expect(requests.filter((request) => request === "GET /api/rooms/cli-activity").length).toBeGreaterThan(
          activityRequestsWhileHidden
        )
      );
      await waitFor(() => expect(screen.getByRole("button", { name: "Open Ops Room" }).querySelector(".room-cli-badge")?.textContent).toBe("Panes 3"));

      roomCliActivityFailure = true;
      fireEvent.click(await screen.findByLabelText("Hide rooms"));
      await waitFor(() => expect(screen.queryByRole("complementary", { name: "Rooms" })).toBeNull());
      fireEvent.click(await screen.findByLabelText("Show rooms"));
      expect(await screen.findByRole("complementary", { name: "Rooms" })).toBeTruthy();
      await waitFor(() => expect(screen.getByRole("button", { name: "Open Ops Room" }).querySelector(".room-cli-badge")?.textContent).toBe("Panes 3"));
      roomCliActivityFailure = false;

      // Resume CLI task lives in the pane menu (af3398ff50). It must stay usable: e7545036cd made it
      // permanently disabled, which is reported as a product regression rather than accepted here.
      const resumeCliAction = within(await openCliPaneActions()).getByRole("menuitem", { name: "Resume Summarize deployment blockers" });
      expect((resumeCliAction as HTMLButtonElement).disabled).toBe(false);
      fireEvent.click(resumeCliAction);
      await waitFor(() => expect(requests).toContain("GET /api/cli/tasks?page=1&pageSize=50"));
      const resumeDialog = await screen.findByRole("dialog", { name: "Resume CLI task" });
      const historyRow = await within(resumeDialog).findByRole("button", { name: "Codex task Resume selected task" });
      expect(historyRow.querySelector("small, time")).toBeNull();
      const historySearch = within(resumeDialog).getByRole("searchbox", { name: "Search CLI tasks" });
      fireEvent.change(historySearch, { target: { value: "older prompt" } });
      await waitFor(() =>
        expect(requests).toContain("GET /api/cli/tasks?page=1&pageSize=50&q=older+prompt")
      );
      fireEvent.click(within(resumeDialog).getByRole("button", { name: "Clear task search" }));
      expect((historySearch as HTMLInputElement).value).toBe("");
      expect(document.activeElement).toBe(historySearch);
      fireEvent.click(await within(resumeDialog).findByRole("button", { name: "Codex task Resume selected task" }));
      await waitFor(() => expect(requests).toContain("POST /api/panes/pane%3Acli/cli/resume"));
      expect(
        requestBodies.some(
          (request) => request.url === "/api/panes/pane%3Acli/cli/resume" && request.body.includes("\"taskId\":\"cli_session:history-selected\"")
        )
      ).toBe(true);
      expect(within(cliCard).getByText("Resume selected task")).toBeTruthy();

      fireEvent.click(within(await openCliPaneActions()).getByRole("menuitem", { name: /^Add pane from / }));
      await waitFor(() => expect(requests).toContain("POST /api/panes"));
      expect(
        requestBodies.some(
          (request) =>
            request.url === "/api/panes" &&
            request.body.includes("\"mode\":\"TERMINAL\"") &&
            request.body.includes("\"parentId\":\"pane:cli\"") &&
            request.body.includes("\"direction\":\"horizontal\"")
        )
      ).toBe(true);

      // Since 9e0ba4b9c6 the CLI launcher lives in the desktop Create menu, with OpenCode first.
      async function createFromCliLauncher(optionName: string) {
        const paneRequestsBefore = requestBodies.filter((request) => request.url === "/api/panes").length;
        const { menu: selector } = await openDesktopMenu("Create");
        await within(selector).findByRole("button", { name: "Add OpenCode CLI" });
        expect(Array.from(selector.querySelectorAll(".cli-launcher-option")).map((item) => item.getAttribute("aria-label"))).toEqual([
          "Add OpenCode CLI",
          "Add Codex CLI",
          "Add Claude Code CLI",
          "Add Gemini CLI",
          "Add Qwen Code CLI",
          "Add Kimi Code CLI",
          "Add Grok Build CLI"
        ]);
        expect(selector.querySelectorAll(".cli-launcher-option img[data-terminal-runtime-brand]")).toHaveLength(7);
        expect(selector.querySelectorAll(".cli-launcher-option .lucide-terminal")).toHaveLength(0);
        expect(within(selector).queryByText("CLI ROOT")).toBeNull();
        fireEvent.click(within(selector).getByRole("button", { name: optionName }));
        await waitFor(() =>
          expect(requestBodies.filter((request) => request.url === "/api/panes")).toHaveLength(paneRequestsBefore + 1)
        );
        return JSON.parse(requestBodies.filter((request) => request.url === "/api/panes").at(-1)?.body ?? "{}") as Record<string, unknown>;
      }

      // CLI pane quick actions live in each pane's menu (af3398ff50). Since ffcdaead18 Plan mode stays
      // disabled, with its reason as the tooltip, until the CLI attaches; these fixtures never open a
      // terminal socket, so the item must be offered but must not reach the terminal when clicked.
      const planModeActions = new Set(["ensure_plan_mode", "enter_native_plan_mode", "enable_plan_mode"]);
      async function expectPlanModeWaitsForAttach(paneTitle: string, paneId: string) {
        fireEvent.click(await screen.findByRole("button", { name: `More pane actions ${paneTitle}` }));
        const menu = await screen.findByRole("menu", { name: `Pane actions ${paneTitle}` });
        const plan = within(menu).getByRole("menuitem", { name: `Enable Plan mode ${paneTitle}` }) as HTMLButtonElement;
        expect(plan.disabled).toBe(true);
        expect(plan.title).toMatch(/^Attach a running CLI first\./);
        fireEvent.click(plan);
        await act(async () => Promise.resolve());
        expect(terminalPaneActions.filter((detail) => {
          const action = detail as { paneId?: string; action?: string };
          return action.paneId === paneId && planModeActions.has(action.action ?? "");
        })).toEqual([]);
        fireEvent.keyDown(menu, { key: "Escape" });
        await waitFor(() => expect(screen.queryByRole("menu", { name: `Pane actions ${paneTitle}` })).toBeNull());
      }
      // Once attached, the same item sends the runtime's own Plan control: Claude cycles to Plan mode,
      // Gemini and Qwen enter their native Plan mode.
      expect(terminalPlanModeAction("cli:claude")).toEqual({ action: "ensure_plan_mode" });
      expect(terminalPlanModeAction("cli:gemini")).toEqual({ action: "enter_native_plan_mode", runtimeId: "cli:gemini" });
      expect(terminalPlanModeAction("cli:qwen")).toEqual({ action: "enter_native_plan_mode", runtimeId: "cli:qwen" });

      // New CLI panes default to the room project directory /opt/spaceapp since eda97abab6.
      const codexCreate = await createFromCliLauncher("Add Codex CLI");
      expect(codexCreate).toMatchObject({ roomId: "room:cli", title: "CLI 5", mode: "TERMINAL" });
      expect(codexCreate).not.toHaveProperty("terminalRuntimeId");

      const claudeCreate = await createFromCliLauncher("Add Claude Code CLI");
      expect(claudeCreate).toMatchObject({
        roomId: "room:cli",
        title: "Claude Code CLI",
        mode: "TERMINAL",
        terminalRuntimeId: "cli:claude",
        cwd: "/opt/spaceapp"
      });
      await expectPlanModeWaitsForAttach("Claude Code CLI", "pane:claude");

      const geminiCreate = await createFromCliLauncher("Add Gemini CLI");
      expect(geminiCreate).toMatchObject({
        roomId: "room:cli",
        title: "Gemini CLI",
        mode: "TERMINAL",
        terminalRuntimeId: "cli:gemini",
        cwd: "/opt/spaceapp"
      });
      await expectPlanModeWaitsForAttach("Gemini CLI", "pane:gemini");

      const openCodeCreate = await createFromCliLauncher("Add OpenCode CLI");
      expect(openCodeCreate).toMatchObject({
        roomId: "room:cli",
        title: "OpenCode CLI",
        mode: "TERMINAL",
        terminalRuntimeId: "cli:opencode",
        cwd: "/opt/spaceapp"
      });

      const qwenCreate = await createFromCliLauncher("Add Qwen Code CLI");
      expect(qwenCreate).toMatchObject({
        roomId: "room:cli",
        title: "Qwen Code CLI",
        mode: "TERMINAL",
        terminalRuntimeId: "cli:qwen",
        cwd: "/opt/spaceapp"
      });
      await expectPlanModeWaitsForAttach("Qwen Code CLI", "pane:qwen");

      const kimiCreate = await createFromCliLauncher("Add Kimi Code CLI");
      expect(kimiCreate).toMatchObject({
        roomId: "room:cli",
        title: "Kimi Code CLI",
        mode: "TERMINAL",
        terminalRuntimeId: "cli:kimi",
        cwd: "/opt/spaceapp"
      });

      const grokCreate = await createFromCliLauncher("Add Grok Build CLI");
      expect(grokCreate).toMatchObject({
        roomId: "room:cli",
        title: "Grok Build CLI",
        mode: "TERMINAL",
        terminalRuntimeId: "cli:grok",
        cwd: "/opt/spaceapp"
      });

      for (const [paneTitle, runtimeId, paneId] of [
        ["Claude Code CLI", "cli:claude", "pane:claude"],
        ["Gemini CLI", "cli:gemini", "pane:gemini"],
        ["OpenCode CLI", "cli:opencode", "pane:opencode"],
        ["Qwen Code CLI", "cli:qwen", "pane:qwen"],
        ["Kimi Code CLI", "cli:kimi", "pane:kimi"],
        ["Grok Build CLI", "cli:grok", "pane:grok"]
      ] as const) {
        const runtimeCard = await screen.findByLabelText(`${paneTitle} agent` , { exact: false });
        const destructiveResumeRequestsBefore = requestBodies.filter(
          (request) =>
            request.url === `/api/panes/${encodeURIComponent(paneId)}/cli/session` &&
            request.body.includes(`"runtimeId":"${runtimeId}"`) &&
            request.body.includes('"forceRestart":true') &&
            request.body.includes('"resume":true')
        ).length;
        fireEvent.click(within(runtimeCard).getByRole("button", { name: `More pane actions ${paneTitle}` }));
        const runtimeActions = await screen.findByRole("menu", { name: `Pane actions ${paneTitle}` });
        const runtimeResume = within(runtimeActions).getByRole("menuitem", { name: `Resume ${paneTitle}` });
        expect((runtimeResume as HTMLButtonElement).disabled).toBe(false);
        fireEvent.click(runtimeResume);
        const sharedHistoryDialog = await screen.findByRole("dialog", { name: "Resume CLI task" });
        expect(within(sharedHistoryDialog).getByText(`Continue a task in ${paneTitle} with ${paneTitle}; the runtime stays unchanged.`, { exact: false })).toBeTruthy();
        expect(requestBodies.filter(
          (request) =>
            request.url === `/api/panes/${encodeURIComponent(paneId)}/cli/session` &&
            request.body.includes(`"runtimeId":"${runtimeId}"`) &&
            request.body.includes('"forceRestart":true') &&
            request.body.includes('"resume":true')
        )).toHaveLength(destructiveResumeRequestsBefore);
        fireEvent.click(within(sharedHistoryDialog).getByRole("button", { name: "Close resume task history" }));
        await waitFor(() =>
          expect(screen.queryByRole("dialog", { name: "Resume CLI task" })).toBeNull()
        );
      }

      fireEvent.click(await workspaceAction("Add CLI ROOT"));
      await waitFor(() =>
        expect(
          requestBodies.some(
            (request) =>
              request.url === "/api/panes" &&
              request.body.includes("\"terminalRuntimeId\":\"cli:root\"") &&
              request.body.includes("\"cwd\":\"/opt/spaceapp\"")
          )
        ).toBe(true)
      );
      const rootCard = (await screen.findByLabelText("CLI pane CLI ROOT")).closest("article") ?? document.body;
      expect(within(rootCard).queryByLabelText(/Enable Plan mode/)).toBeNull();
      expect(within(rootCard).queryByLabelText(/Resume CLI task/)).toBeNull();
      expect(within(rootCard).queryByLabelText(/Save CLI task to memory/)).toBeNull();
      expect(within(rootCard).queryByLabelText(/Generate pane title with AI/)).toBeNull();
      fireEvent.click(within(rootCard).getByRole("button", { name: "More pane actions CLI ROOT" }));
      const rootActions = await screen.findByRole("menu", { name: "Pane actions CLI ROOT" });
      for (const label of [
        "Upload files",
        "Interrupt command",
        "Copy output",
        "Reconnect",
        "Move pane",
        "Add pane",
        "Grow pane width"
      ]) {
        expect(within(rootActions).getByText(label)).toBeTruthy();
      }
      fireEvent.keyDown(rootActions, { key: "Escape" });
      await waitFor(() =>
        expect(screen.queryByRole("menu", { name: "Pane actions CLI ROOT" })).toBeNull()
      );

      Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: 768 });
      window.dispatchEvent(new Event("resize"));
      fireEvent.click(await screen.findByLabelText("Open rooms"));
      const roomsDrawer = await screen.findByRole("dialog", { name: "Rooms" });
      expect(within(roomsDrawer).queryByTitle("Create 2-pane room")).toBeNull();
      expect(within(roomsDrawer).queryByTitle("Create 16-pane room")).toBeNull();
      const newRoomButton = within(roomsDrawer).getByRole("button", { name: "New room" });
      const roomRequestsBefore = requestBodies.filter((request) => request.url === "/api/rooms").length;
      const paneRequestsBefore = requestBodies.filter((request) => request.url === "/api/panes").length;
      fireEvent.click(newRoomButton);
      fireEvent.click(newRoomButton);

      await waitFor(() =>
        expect(requestBodies.filter((request) => request.url === "/api/rooms")).toHaveLength(roomRequestsBefore + 1)
      );
      expect(requestBodies.filter((request) => request.url === "/api/rooms").at(-1)).toMatchObject({
        url: "/api/rooms",
        body: expect.stringContaining("\"initialPaneCount\":0")
      });
      expect(requestBodies.filter((request) => request.url === "/api/panes")).toHaveLength(paneRequestsBefore);
      expect(createdRoomPanes).toEqual([]);
      const createdRoomButton = await within(roomsDrawer).findByRole("button", { name: "Open Room 2" });
      expect(createdRoomButton.querySelector(".room-cli-badge")?.textContent).toBe("Panes 0");
      // The Add panes composer starts collapsed (b91c3d2bc1, 7eb9ef49dc) and targets the new room.
      expect(await within(roomsDrawer).findByText("Add panes to Room 2")).toBeTruthy();
      fireEvent.click(within(roomsDrawer).getByRole("button", { name: /^Add panes to /, expanded: false }));
      expect(await within(roomsDrawer).findByRole("button", { name: "Choose panes to add" })).toBeTruthy();
      expect(screen.getByRole("dialog", { name: "Rooms" })).toBeTruthy();
      expect(screen.queryByLabelText("CLI pane CLI 1")).toBeNull();
    } finally {
      window.removeEventListener("space:terminal-pane-action", recordTerminalPaneAction);
      Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: originalMediaDevices });
      Object.defineProperty(navigator, "clipboard", { configurable: true, value: originalClipboard });
      HTMLMediaElement.prototype.play = originalPlay;
      HTMLCanvasElement.prototype.getContext = originalGetContext;
      HTMLCanvasElement.prototype.toBlob = originalToBlob;
    }
    // The Workspace-menu flows, lazily loaded Chat/Browser/Snip panes and the per-runtime Resume
    // dialogs take 35-60 s under parallel test-runner load, so 60 s timed out intermittently.
  }, 120_000);
});
