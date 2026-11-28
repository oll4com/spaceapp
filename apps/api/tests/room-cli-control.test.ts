import { describe, expect, it, vi } from "vitest";
import { createRoomCliControl } from "../src/room-cli-control.js";
import { roomPromptFingerprint } from "../src/room-terminal-screen.js";

const pane = { id: "pane:one", roomId: "room:one", mode: "TERMINAL", terminalRuntimeId: "cli:codex", title: "One", isClosed: false };
const session = { sessionId: "cli:one", runtimeId: "cli:codex", purpose: "NORMAL", status: "RUNNING" };

function fixture(screens: string[], stored: Record<string, unknown> = pane, terminal: { queue?: () => Promise<void>; observe?: () => Promise<void>; input?: (signal?: AbortSignal) => Promise<void> } = {}) {
  let revision = 0;
  const sent: string[] = [];
  const waits: unknown[] = [];
  const reportWatchdog = vi.fn();
  const control = createRoomCliControl({
    store: {
      getPane: async () => stored,
      getActivePaneCliSession: async () => session,
      listPaneCliSessions: async () => [session]
    } as never,
    reportWatchdog,
    cliTerminalManager: {
      runSerializedTerminalMutation: async (_id: string, run: () => Promise<unknown>) => { await terminal.queue?.(); return run(); },
      observeRoomScreen: async () => { await terminal.observe?.(); return { text: screens[Math.min(revision, screens.length - 1)]!, revision }; },
      observeRoomScreenUndimmed: async () => screens[Math.min(revision, screens.length - 1)]!,
      // sendInput(session, data, trace, marker, key, waitForComposer, signal)
      sendInput: async (_id: string, data: string, ...rest: unknown[]) => { waits.push(rest[3]); await terminal.input?.(rest[4] as AbortSignal | undefined); sent.push(data); revision++; }
    } as never,
    cliRuntimeRegistryCache: { read: vi.fn() } as never,
    assertPaneCliRuntimeEnabled: async () => undefined,
    readPaneCliModelSettings: vi.fn(),
    readPaneOpenCodeModelSettings: vi.fn(),
    resolveOpenCodeServerControl: vi.fn(),
    readPaneNativeModelSettings: vi.fn(),
    loadNativeCliModels: vi.fn() as never,
    antigravityUsageProvider: vi.fn(),
    recordClaudeNativeRef: vi.fn() as never
  });
  return { control, sent, waits, reportWatchdog };
}

describe("room CLI control", () => {
  it("acts only on an open AI terminal's current session", async () => {
    const { control } = fixture([""]);
    await expect(control.roomCliSession({ ...pane, mode: "BROWSER" } as never)).rejects.toThrow("Room CLI controls require an AI terminal.");
    await expect(control.roomCliSession({ ...pane, terminalRuntimeId: "cli:root" } as never)).rejects.toThrow("Room CLI controls require an AI terminal.");
    await expect(fixture([""], { ...pane, isClosed: true }).control.roomCliSession(pane as never)).rejects.toThrow("Reopen the pane before controlling its CLI.");
    await expect(control.roomCliSession(pane as never, "cli:other")).rejects.toThrow("The target CLI session is unavailable or changed.");
    expect(await control.roomCliSession(pane as never, "cli:one")).toBe(session);
  });

  it("answers only the question that was inspected, and only a pane that waits", async () => {
    const { control, sent } = fixture(["Working on it…"]);
    await expect(control.commandRoomCli(pane as never, { answer: "1", expectedPromptFingerprint: "stale" } as never, "trace:one"))
      .rejects.toThrow("The pane's question changed since it was inspected");
    await expect(control.commandRoomCli(pane as never, { answer: "1" } as never, "trace:one")).rejects.toThrow("The pane is not waiting for an answer");
    expect(sent).toEqual([]);
  });

  it("reports a command the CLI rejected, and clears the pane's cached observation first", async () => {
    const { control } = fixture(["› ", "› /nope\nUnknown command: /nope"]);
    control.roomCliObservationCache.set(pane.id, { expires: Date.now() + 60_000, data: {} as never });
    await expect(control.commandRoomCli(pane as never, { command: "/nope" } as never, "trace:one")).rejects.toThrow("The CLI rejected the command.");
    expect(control.roomCliObservationCache.has(pane.id)).toBe(false);
  });

  // 4/11: a narrow Claude /model menu, scrolled past its title and hints, stayed open after a failed switch;
  // native_command "/model sonnet" then went into the menu as keys and its Enter picked the highlighted row.
  it("closes a native menu left open before it types a command, so the command arrives whole", async () => {
    const scrolledMenu = ["   ↓ 2. Opus                 Opus 5.5 ·", "                             Best for", "      … +3 models", "",
      "   ◐ Medium effort (default) ←/→ to", "   adjust                                 ↓"].join("\n");
    const { control, sent } = fixture([scrolledMenu, "────\n❯ \n────", "❯ /model sonnet", "  ⎿  Set model to Sonnet 5.5"]);
    await control.commandRoomCli(pane as never, { command: "/model sonnet" } as never, "trace:one");
    expect(sent).toEqual(["\u001b", "/model sonnet", "\r"]);
  });

  // 2/11 (load 45 on 24 cores): the 8 s counted the wait behind the pane's previous command, and a timeout pressed Ctrl+C and Esc into the CLI.
  it("gives a command its 8 s from when it starts, not from its wait in the pane's queue", async () => {
    vi.useFakeTimers();
    try {
      const { control, sent, reportWatchdog } = fixture(["› ", "› ok"], pane, { queue: () => new Promise((resolve) => setTimeout(resolve, 20_000)) });
      const answer = control.commandRoomCli(pane as never, { key: "ENTER" } as never, "trace:one");
      await vi.advanceTimersByTimeAsync(20_500);
      await expect(answer).resolves.toMatchObject({ key: "ENTER" });
      expect(sent).toEqual(["\r"]);
      expect(reportWatchdog).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops a command past 8 s without pressing anything into the CLI, and tells the room's watchdog", async () => {
    vi.useFakeTimers();
    let releaseRead!: () => void;
    const reading = new Promise<void>((resolve) => { releaseRead = resolve; });
    try {
      const { control, sent, reportWatchdog } = fixture(["› "], pane, { observe: () => reading });
      const answer = control.commandRoomCli(pane as never, { command: "/model" } as never, "trace:one");
      const failed = expect(answer).rejects.toThrow(/took over 8 s; it was stopped before its next step and nothing more was typed/);
      await vi.advanceTimersByTimeAsync(8_000);
      await failed;
      // The screen read returns late: the command types nothing, and no interrupt or Esc was ever sent.
      releaseRead();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(sent).toEqual([]);
      expect(reportWatchdog).toHaveBeenCalledTimes(1);
      expect(reportWatchdog.mock.calls[0]![0]).toMatchObject({ type: "ROOM_WATCHDOG_ALERT", paneId: pane.id, payload: { kind: "ROOM_FREEZE_PREVENTED", started: true, command: "/model" } });
    } finally {
      releaseRead();
      vi.useRealTimers();
    }
  });

  // 28/11 Nous Cloud box: Nous answered Bob's Gemini trust question; the answer waited for the composer that question holds back, and the
  // watchdog named the task title "Hygiene sweeps (Space)", which Nous read as another pane.
  it("types an answer without waiting for a composer, and names the pane as Nous knows it when the watchdog stops one", async () => {
    const question = "Do you trust this folder?\n● 1. Trust folder\n  2. Don't trust";
    const bob = { ...pane, paneName: "Bob", title: "Hygiene sweeps (Space)" };
    const { control, waits } = fixture([question, "› "], bob);
    await control.commandRoomCli(bob as never, { answer: "1", expectedPromptFingerprint: roomPromptFingerprint(question) } as never, "trace:one");
    expect(waits[0]).toBe("question");
    const long = fixture([question, question, "› "], bob, {});
    await long.control.commandRoomCli(bob as never, { answer: "Trust it", submit: true, expectedPromptFingerprint: roomPromptFingerprint(question) } as never, "trace:two").catch(() => undefined);
    expect(long.waits[0]).toBe("question");
    vi.useFakeTimers();
    try {
      const stuck = fixture([question], bob, { input: () => new Promise<void>(() => undefined) });
      const answer = stuck.control.commandRoomCli(bob as never, { answer: "1", expectedPromptFingerprint: roomPromptFingerprint(question) } as never, "trace:three");
      const failed = expect(answer).rejects.toThrow('the answer in pane "Bob · Hygiene sweeps (Space)" (pane:one, cli:codex) took over 8 s');
      await vi.advanceTimersByTimeAsync(8_000);
      await failed;
    } finally {
      vi.useRealTimers();
    }
  });

  // 7/11 Bruno/Kate: a scheduled task's prompt into a reopened OpenCode pane waited 45 s for its composer after the 8 s watchdog gave up,
  // holding the pane's lock, so the next tick's prompt queued behind it.
  it("ends a timed-out prompt's wait for the CLI's composer, so it no longer holds the pane's lock", async () => {
    vi.useFakeTimers();
    try {
      let waiting: AbortSignal | undefined;
      const input = (signal?: AbortSignal) => new Promise<void>((_, reject) => { waiting = signal; signal?.addEventListener("abort", () => reject(signal.reason)); });
      const { control, sent } = fixture(["› "], pane, { input });
      const answer = control.commandRoomCli(pane as never, { answer: "Run the daily check.", expectedPromptFingerprint: roomPromptFingerprint("› ") } as never, "trace:one");
      const failed = expect(answer).rejects.toThrow(/took over 8 s/);
      await vi.advanceTimersByTimeAsync(8_000);
      await failed;
      expect(waiting?.aborted).toBe(true);
      expect(sent).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("drops a command that waited 30 s in the pane's queue: it never types once its turn comes", async () => {
    vi.useFakeTimers();
    try {
      const { control, sent, reportWatchdog } = fixture(["› "], pane, { queue: () => new Promise((resolve) => setTimeout(resolve, 40_000)) });
      const answer = control.commandRoomCli(pane as never, { command: "/model" } as never, "trace:one");
      const failed = expect(answer).rejects.toThrow(/waited 30 s behind the pane's previous command and was not typed/);
      await vi.advanceTimersByTimeAsync(30_000);
      await failed;
      await vi.advanceTimersByTimeAsync(15_000);
      expect(sent).toEqual([]);
      expect(reportWatchdog.mock.calls[0]![0]).toMatchObject({ payload: { started: false } });
    } finally {
      vi.useRealTimers();
    }
  });
});
