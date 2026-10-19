import { describe, expect, it, vi } from "vitest";
import type { Pane } from "@space/contracts";
import {
  createPaneWorkingTime,
  paneWorkingTimeResponse,
  type PaneWorkingTimeCliSession,
  type PaneWorkingTimeDeps
} from "../src/pane-working-time.js";
import type { NativeTaskExecution } from "../src/room-task-telemetry.js";

const createdAt = "2026-10-10T08:00:00.000Z";
const startMs = Date.parse("2026-10-10T10:00:00.000Z");

function pane(overrides: Partial<Pane> = {}): Pane {
  return { id: "pane:working1", mode: "TERMINAL", status: "IDLE", createdAt, isClosed: false, ...overrides } as Pane;
}

function task(id: string, status: NativeTaskExecution["status"], timing: { startedAt?: string; durationMs?: number | null }): NativeTaskExecution {
  return {
    taskId: id, title: id, status, modelsUsed: [],
    timing: { startedAt: timing.startedAt ?? null, completedAt: null, durationMs: timing.durationMs ?? null, source: "NATIVE", observedAt: createdAt }
  } as NativeTaskExecution;
}

function session(runtimeId: string, overrides: Partial<PaneWorkingTimeCliSession> = {}): PaneWorkingTimeCliSession {
  return { sessionId: "cli_session:working1", runtimeId, purpose: "NORMAL", status: "RUNNING", codexThreadId: "thread-1", ...overrides };
}

function service(overrides: Partial<PaneWorkingTimeDeps<PaneWorkingTimeCliSession>> = {}) {
  let nowMs = startMs;
  const deps = {
    latestCliSession: vi.fn(async () => session("cli:codex")),
    codexTasks: vi.fn(async () => [task("turn-1", "COMPLETED", { durationMs: 60_000 }), task("turn-2", "COMPLETED", { durationMs: 30_000 })]),
    openCodeTasks: vi.fn(async () => null),
    sessionRootPid: vi.fn(async () => 4242),
    geminiTasks: vi.fn(async () => null),
    claudeTasks: vi.fn(async () => null),
    inspectNonCli: vi.fn(async () => ({ state: "IDLE" as const, tasks: [] })),
    now: () => nowMs,
    ...overrides
  };
  return { deps, workingTime: createPaneWorkingTime(deps), advance: (ms: number) => { nowMs += ms; } };
}

describe("pane working time", () => {
  it("counts finished durations only (the badge adds the running turn) and caps at the pane age", () => {
    const observation = {
      state: "RUNNING" as const,
      tasks: [
        task("done", "COMPLETED", { durationMs: 120_000 }),
        task("running", "RUNNING", { startedAt: new Date(startMs - 45_000).toISOString() }),
        task("untimed", "UNKNOWN", {})
      ]
    };
    expect(paneWorkingTimeResponse(pane(), observation, startMs)).toEqual({
      paneId: "pane:working1", cumulativeWorkingMs: 120_000, isWorking: true, state: "RUNNING"
    });
    expect(paneWorkingTimeResponse(pane({ createdAt: new Date(startMs - 10_000).toISOString() }), observation, startMs).cumulativeWorkingMs).toBe(10_000);
    expect(paneWorkingTimeResponse(pane({ status: "RUNNING" }), null, startMs)).toEqual({
      paneId: "pane:working1", cumulativeWorkingMs: 0, isWorking: true, state: "RUNNING"
    });
  });

  it("reads only the Codex task timeline for a Codex pane", async () => {
    const { deps, workingTime } = service();
    await expect(workingTime.read(pane())).resolves.toEqual({
      paneId: "pane:working1", cumulativeWorkingMs: 90_000, isWorking: false, state: "IDLE"
    });
    expect(deps.codexTasks).toHaveBeenCalledWith("thread-1");
    expect(deps.inspectNonCli).not.toHaveBeenCalled();
    expect(deps.openCodeTasks).not.toHaveBeenCalled();
    expect(deps.sessionRootPid).not.toHaveBeenCalled();
  });

  it("selects the native timeline source by runtime", async () => {
    const opencode = service({
      latestCliSession: vi.fn(async () => session("cli:opencode")),
      openCodeTasks: vi.fn(async () => [task("oc", "RUNNING", { startedAt: new Date(startMs - 5_000).toISOString() })])
    });
    await expect(opencode.workingTime.read(pane())).resolves.toMatchObject({ cumulativeWorkingMs: 0, state: "RUNNING", isWorking: true });

    const gemini = service({
      latestCliSession: vi.fn(async () => session("cli:gemini")),
      geminiTasks: vi.fn(async () => [task("g", "COMPLETED", { durationMs: 7_000 })])
    });
    await expect(gemini.workingTime.read(pane())).resolves.toMatchObject({ cumulativeWorkingMs: 7_000, state: "IDLE" });
    expect(gemini.deps.geminiTasks).toHaveBeenCalledWith({ paneId: "pane:working1", sessionId: "cli_session:working1", rootPid: 4242 });

    const claude = service({
      latestCliSession: vi.fn(async () => session("cli:claude")),
      claudeTasks: vi.fn(async () => ({ tasks: [task("c", "COMPLETED", { durationMs: 3_000 })], busy: true }))
    });
    await expect(claude.workingTime.read(pane())).resolves.toMatchObject({ cumulativeWorkingMs: 3_000, state: "RUNNING" });

    const deepseek = service({ latestCliSession: vi.fn(async () => session("cli:deepseek")) });
    await expect(deepseek.workingTime.read(pane())).resolves.toMatchObject({ cumulativeWorkingMs: 0, state: "IDLE" });
    expect(deepseek.deps.codexTasks).not.toHaveBeenCalled();

    // Unavailable native history (null) counts as no working time, like the
    // full inspection's untimed placeholder task.
    const geminiUnavailable = service({ latestCliSession: vi.fn(async () => session("cli:gemini")) });
    await expect(geminiUnavailable.workingTime.read(pane())).resolves.toMatchObject({ cumulativeWorkingMs: 0 });
  });

  it("reports missing, non-normal and exited sessions like the full inspection", async () => {
    await expect(service({ latestCliSession: vi.fn(async () => null) }).workingTime.read(pane()))
      .resolves.toMatchObject({ cumulativeWorkingMs: 0, state: "UNKNOWN" });
    await expect(service({ latestCliSession: vi.fn(async () => session("cli:codex", { purpose: "AUTH" })) }).workingTime.read(pane()))
      .resolves.toMatchObject({ cumulativeWorkingMs: 0, state: "UNKNOWN" });
    await expect(service({ latestCliSession: vi.fn(async () => session("cli:codex", { status: "EXITED" })) }).workingTime.read(pane()))
      .resolves.toMatchObject({ cumulativeWorkingMs: 90_000, state: "EXITED" });
  });

  it("keeps the room controller inspection for chat and harness panes", async () => {
    const { deps, workingTime } = service({
      inspectNonCli: vi.fn(async () => ({ state: "RUNNING" as const, tasks: [task("chat", "COMPLETED", { durationMs: 2_000 })] }))
    });
    await expect(workingTime.read(pane({ mode: "CHAT" }))).resolves.toMatchObject({ cumulativeWorkingMs: 2_000, state: "RUNNING" });
    expect(deps.latestCliSession).not.toHaveBeenCalled();
  });

  it("falls back to the pane status when the observation fails", async () => {
    const { workingTime } = service({ codexTasks: vi.fn(async () => { throw new Error("rollout unavailable"); }) });
    await expect(workingTime.read(pane({ status: "RUNNING" }))).resolves.toEqual({
      paneId: "pane:working1", cumulativeWorkingMs: 0, isWorking: true, state: "RUNNING"
    });
  });

  it("shares one observation between concurrent polls and refreshes it well within one client poll", async () => {
    let resolveTasks!: (tasks: NativeTaskExecution[]) => void;
    const running = [task("turn", "RUNNING", { startedAt: new Date(startMs - 10_000).toISOString() })];
    const { deps, workingTime, advance } = service({
      codexTasks: vi.fn()
        .mockImplementationOnce(() => new Promise<NativeTaskExecution[]>((resolve) => { resolveTasks = resolve; }))
        .mockResolvedValue([task("turn", "COMPLETED", { durationMs: 20_000 })])
    });

    const first = workingTime.read(pane());
    const second = workingTime.read(pane());
    await vi.waitFor(() => expect(resolveTasks).toBeTypeOf("function"));
    resolveTasks(running);
    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ cumulativeWorkingMs: 0, state: "RUNNING" }),
      expect.objectContaining({ cumulativeWorkingMs: 0, state: "RUNNING" })
    ]);
    expect(deps.codexTasks).toHaveBeenCalledTimes(1);

    // Within the TTL the cached timeline is reused; the running turn is the badge's to count.
    advance(4_000);
    await expect(workingTime.read(pane())).resolves.toMatchObject({ cumulativeWorkingMs: 0, state: "RUNNING" });
    expect(deps.codexTasks).toHaveBeenCalledTimes(1);

    // The working -> idle transition shows up on the first poll after the
    // 5 s TTL, far inside the 15 s client poll interval.
    advance(1_000);
    await expect(workingTime.read(pane())).resolves.toMatchObject({ cumulativeWorkingMs: 20_000, state: "IDLE", isWorking: false });
    expect(deps.codexTasks).toHaveBeenCalledTimes(2);
  });
});
