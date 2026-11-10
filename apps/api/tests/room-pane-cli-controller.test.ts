import { describe, expect, it, vi } from "vitest";
import { createRoomPaneCliController, OMP_FOLLOW_UP_ESCAPES_MS } from "../src/room-pane-cli-controller.js";
import { CliTaskNotResumableError } from "../src/unified-cli-task-registry.js";
import { SpaceConflictError } from "@space/runtime";

const pane = { id: "pane:one", roomId: "room:one", mode: "TERMINAL", terminalRuntimeId: "cli:claude", title: "One", isClosed: false };
const opus = { id: "claude:opus", displayName: "Opus", supportedReasoningEfforts: ["high", "max"], defaultReasoningEffort: "high" };

function fixture(runtimeId: string, options: { native?: () => Promise<unknown>; observation?: Record<string, unknown>; active?: boolean; deps?: Record<string, unknown> } = {}) {
  const session = { sessionId: "cli:one", runtimeId, purpose: "NORMAL", status: "RUNNING", isActive: true, accountProfileId: "main" };
  const sent: string[] = [];
  const controller = createRoomPaneCliController({
    store: { getActivePaneCliSession: async () => (options.active ? session : null), listPaneCliSessions: async () => [] } as never,
    spaceAgentAdapter: {} as never,
    config: {} as never,
    cliTerminalManager: { sendInput: async (_id: string, data: string) => { sent.push(data); } } as never,
    cliRuntimeVisibility: { isEnabled: async () => true } as never,
    unifiedCliTaskRegistry: { getTask: vi.fn() } as never,
    assertNoManagedModelMutation: async () => undefined,
    claudeAccountSwitchDeps: {} as never,
    inspectRoomCli: async () => ({ nativeMode: null, ...options.observation }) as never,
    commandRoomCli: vi.fn() as never,
    roomCliSession: async () => session as never,
    roomCliObservationCache: new Map(),
    readPaneCliModelSettings: vi.fn() as never,
    readPaneNativeModelSettings: (options.native ?? (async () => { throw new Error("no catalog"); })) as never,
    applyNativePaneModel: vi.fn() as never,
    readPaneOpenCodeModelSettings: vi.fn() as never,
    applyOpenCodePaneSelection: vi.fn() as never,
    resolveOpenCodeServerControl: vi.fn() as never,
    resumePaneCliTask: vi.fn() as never,
    waitForCodexThreadSettings: vi.fn() as never,
    ...options.deps
  });
  return { controller, sent };
}
const configure = (runtimeId: string, action: Record<string, unknown>, options?: Parameters<typeof fixture>[1]) =>
  fixture(runtimeId, options).controller.configure(pane as never, { type: "configure_pane", paneId: pane.id, ...action } as never, "trace:one");

describe("room pane CLI controller", () => {
  it("switches accounts only on Gemini and Claude Code panes", async () => {
    await expect(configure("cli:codex", { accountProfileId: "work" })).rejects.toThrow("Account profile switching is supported on Gemini and Claude Code panes.");
  });

  it("never opens Claude's /model menu: it names what blocks the switch instead", async () => {
    await expect(configure("cli:claude", { modelId: "opus" })).rejects.toThrow("The Claude model catalog is unavailable; try again shortly.");
    const working = async () => ({ models: [opus], isTurnActive: true, current: null });
    await expect(configure("cli:claude", { modelId: "opus" }, { native: working })).rejects.toThrow("Claude is working; change its model after the current turn.");
    const idle = async () => ({ models: [opus], isTurnActive: false, current: null });
    await expect(configure("cli:claude", { modelId: "gpt-9" }, { native: idle })).rejects.toThrow('"gpt-9" is no Claude model: Claude offers claude:opus (high/max).');
    // R74 (2026-11-05 REVIEW): an effort the family lacks is named too.
    await expect(configure("cli:claude", { modelId: "opus", reasoningEffort: "minimal" }, { native: idle })).rejects.toThrow('claude:opus has no effort "minimal": Claude offers');
  });

  it("changes a native mode only to one the CLI advertises and only from a mode it can see", async () => {
    await expect(configure("cli:claude", { nativeMode: "yolo" }, { observation: { nativeMode: "default", modes: ["default", "plan"] } }))
      .rejects.toThrow("The requested mode is not advertised by this CLI.");
    const hidden = fixture("cli:claude", { observation: { nativeMode: null, modes: ["default", "auto"] } });
    await expect(hidden.controller.configure(pane as never, { type: "configure_pane", paneId: pane.id, nativeMode: "auto" } as never, "trace:one"))
      .rejects.toThrow("The current native mode is not visible; inspect the CLI menu before switching.");
    expect(hidden.sent).toEqual([]);
  });

  it("stops an OMP turn, not only its pty command: Escape, then follow-ups after the command overlay closes (step 9, 3/11)", async () => {
    vi.useFakeTimers();
    try {
      const omp = fixture("cli:omp", { active: true });
      const stop = omp.controller.interrupt({ ...pane, terminalRuntimeId: "cli:omp" } as never, "trace:one");
      await vi.advanceTimersByTimeAsync(0);
      expect(omp.sent).toEqual(["\u001b"]);
      await vi.advanceTimersByTimeAsync(OMP_FOLLOW_UP_ESCAPES_MS[0]);
      expect(omp.sent).toEqual(["\u001b", "\u001b"]);
      await vi.advanceTimersByTimeAsync(OMP_FOLLOW_UP_ESCAPES_MS[1] - OMP_FOLLOW_UP_ESCAPES_MS[0]);
      await expect(stop).resolves.toMatchObject({ interrupted: true });
      expect(omp.sent).toEqual(["\u001b", "\u001b", "\u001b"]);
      // Two Escapes within 500 ms open OMP's rewind selector at an idle composer.
      expect(Math.min(OMP_FOLLOW_UP_ESCAPES_MS[0], OMP_FOLLOW_UP_ESCAPES_MS[1] - OMP_FOLLOW_UP_ESCAPES_MS[0])).toBeGreaterThan(500);
      const claude = fixture("cli:claude", { active: true });
      await claude.controller.interrupt(pane as never, "trace:one");
      expect(claude.sent).toEqual(["\u001b"]);
    } finally { vi.useRealTimers(); }
  });

  it("resumes a Codex pane only with a task to resume", async () => {
    const { controller } = fixture("cli:codex");
    await expect(controller.resume({ ...pane, terminalRuntimeId: "cli:codex" } as never, undefined, "trace:one"))
      .rejects.toThrow("Inspect task history and choose an existing native task to resume.");
    // Nothing to resume: Space Control's restart and reopen start a fresh session on this error (2/11).
    await expect(controller.resume({ ...pane, terminalRuntimeId: "cli:codex" } as never, undefined, "trace:one")).rejects.toBeInstanceOf(CliTaskNotResumableError);
  });

  // ADAPTER-013 (live 4/11): without a recorded reference Space typed /resume into Hermes and OMP, found no task by its title
  // and left the pane on the menu.
  it("resumes Hermes and OMP without a recorded reference in a fresh session, never through /resume", async () => {
    const source = { taskId: "cli_task:old", title: "Old task", session: { roomId: pane.roomId, sessionId: "cli:old" } };
    for (const runtimeId of ["cli:hermes", "cli:omp", "cli:claude"]) {
      const target = { ...pane, terminalRuntimeId: runtimeId };
      const unavailable = new SpaceConflictError("Exact native resume is unavailable; the existing pane was preserved.");
      const resumePaneCliTask = vi.fn(async (_pane: unknown, _input: unknown, _trace: string, _request: unknown, requireNative: boolean) => {
        if (requireNative) throw unavailable;
        return { pane: target, mode: "SPACE_FALLBACK" };
      });
      const commandRoomCli = vi.fn(async () => ({ sessionId: "cli:live" }));
      const deps = { resumePaneCliTask, commandRoomCli, unifiedCliTaskRegistry: { getTask: async () => source },
        cliTerminalManager: { ensurePaneControlReady: async () => ({ sessionId: "cli:live", status: "RUNNING" }) } };
      const { controller } = fixture(runtimeId, { deps });
      const resumed = await controller.resume(target as never, source.taskId, "trace:one");
      const none = await fixture(runtimeId, { deps: { ...deps, commandRoomCli: vi.fn(async () => ({})) } }).controller.resume(target as never, undefined, "trace:one");
      if (runtimeId === "cli:claude") {
        // Claude's /resume picker lists the task by its title, so it stays the fallback there.
        expect(resumed).toMatchObject({ phase: "NATIVE_RESUME_MENU" });
        expect(commandRoomCli).toHaveBeenCalledWith(target, expect.objectContaining({ command: "/resume", selection: "Old task" }), "trace:one");
        continue;
      }
      expect(resumed).toEqual({ paneId: pane.id, sessionId: "cli:live", mode: "SPACE_FALLBACK", state: "RUNNING" });
      expect(resumePaneCliTask).toHaveBeenCalledWith(target, { taskId: source.taskId }, "trace:one", undefined, false);
      expect(none).toEqual({ paneId: pane.id, sessionId: "cli:live", state: "RUNNING" });
      expect(commandRoomCli).not.toHaveBeenCalled();
    }
  });
});
