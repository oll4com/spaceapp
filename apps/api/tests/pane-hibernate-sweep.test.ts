import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { agentRuntimeRegistrySchema, agentRuntimeSchema, isHibernatedSession, PANE_HIBERNATED_REASON, paneHibernateMinutes, userSettingsSchema } from "@space/contracts";
import { InMemorySpaceStore } from "@space/runtime";
import { rememberSpaceTyped } from "../src/cli-prompt-submit.js";
import { CliTerminalManager } from "../src/cli-terminal.js";
import { hibernatablePanes, runsBackgroundJob, sweepHibernatePanes } from "../src/pane-hibernate-sweep.js";
import { enabledCliConfig, readyRuntimeAuth } from "./support/cli-runtimes-harness.js";

vi.spyOn(CliTerminalManager.prototype, "sampleHostMetrics").mockResolvedValue(undefined);

const NOW = Date.parse("2026-11-13T12:00:00.000Z");
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();

function fixture(minutes?: number) {
  // Sessions started two hours before NOW: a session is idle at most since it started.
  vi.useFakeTimers({ toFake: ["Date"], now: NOW - 120 * 60_000 });
  const store = new InMemorySpaceStore();
  const room = store.createRoom({ name: "Hibernate", initialPaneCount: 0 });
  const session = (title: string, runtimeId = "cli:claude") => {
    const pane = store.createPane({ roomId: room.id, title, mode: "TERMINAL", terminalRuntimeId: runtimeId });
    return store.createPaneCliSession({ paneId: pane.id, roomId: room.id, runtimeId, providerId: runtimeId.slice(4), agentId: runtimeId.slice(4), status: "RUNNING", purpose: "NORMAL" });
  };
  const [idle, done, recent, working, waiting, unknownSince, shell, backgroundJob] =
    ["idle", "done", "recent", "working", "waiting", "unknownSince", "shell", "backgroundJob"].map((title) => session(title));
  const details = {
    [idle!.paneId]: { status: "idle", since: ago(45), sessionId: idle!.sessionId, source: "native" },
    [done!.paneId]: { status: "done", since: ago(31), sessionId: done!.sessionId, source: "native" },
    [recent!.paneId]: { status: "idle", since: ago(20), sessionId: recent!.sessionId, source: "native" },
    [working!.paneId]: { status: "working", since: ago(90), sessionId: working!.sessionId, source: "native" },
    [waiting!.paneId]: { status: "waiting", reason: "Permission prompt", since: ago(90), sessionId: waiting!.sessionId, source: "native" },
    [unknownSince!.paneId]: { status: "idle", sessionId: unknownSince!.sessionId, source: "screen" },
    // Claude's background shells read as working (native "shell"): never asleep.
    [shell!.paneId]: { status: "working", reason: "Background shell", since: ago(90), sessionId: shell!.sessionId, source: "native" },
    [backgroundJob!.paneId]: { status: "idle", since: ago(90), sessionId: backgroundJob!.sessionId, source: "screen" }
  };
  vi.useRealTimers();
  if (minutes !== undefined) void store.updateUserSettings("user:operator", { paneHibernate: { minutes: minutes as 0 } });
  const deps = {
    store, now: NOW, readDetails: async () => details as never,
    backgroundJobs: async () => new Set([backgroundJob!.sessionId])
  };
  return { store, deps, details, room, idle: idle!, done: done! };
}

describe("Idle CLI panes hibernate (plan clipboard:YqhRIXfLAnfK step 2β, operator 13/11 14:47 BKK)", () => {
  it("defaults to 30 minutes, Off is 0, and an unknown stored value falls back to the default", () => {
    expect(paneHibernateMinutes(userSettingsSchema.parse({}))).toBe(30);
    expect(paneHibernateMinutes({ paneHibernate: { minutes: 0 } })).toBe(0);
    expect(paneHibernateMinutes({ paneHibernate: { minutes: 7 } })).toBe(30);
    expect(userSettingsSchema.parse({ paneHibernate: { minutes: 7 } }).paneHibernate).toBeUndefined();
  });

  it("picks only idle or done panes past the owner's minutes, never working, waiting, unknown-since or background-job panes", async () => {
    const { deps, idle, done } = fixture();
    expect((await hibernatablePanes(deps)).map(({ session }) => session.sessionId)).toEqual([idle.sessionId, done.sessionId]);
  });

  it("never sleeps a pane Space just prompted or whose CLI just started, whatever idle start the dashboard still shows (13/11 Felix/Max)", async () => {
    // pane:dqDMomh2BAJx slept at 20:41:25Z, 27 s after the scheduler typed task VeYqNEXNFozx (20:40:58Z) into it, reopened at 20:40:34Z.
    const { store, deps, details, room, idle, done } = fixture();
    rememberSpaceTyped(idle.sessionId, "Scheduled task “Max” (daily): run.", NOW - 27_000);
    const pane = store.createPane({ roomId: room.id, title: "reopened", mode: "TERMINAL", terminalRuntimeId: "cli:claude" });
    const reopened = store.createPaneCliSession({ paneId: pane.id, roomId: room.id, runtimeId: "cli:claude", providerId: "claude", agentId: "claude", status: "RUNNING", purpose: "NORMAL" });
    (details as Record<string, unknown>)[pane.id] = { status: "idle", since: ago(300), sessionId: reopened.sessionId, source: "native" };
    expect((await hibernatablePanes({ ...deps, now: Date.now() + 60_000 })).map(({ session }) => session.sessionId)).not.toContain(reopened.sessionId);
    expect((await hibernatablePanes(deps)).map(({ session }) => session.sessionId)).toEqual([done.sessionId]);
    // Idle the owner's minutes after Space's prompt, it sleeps.
    expect((await hibernatablePanes({ ...deps, now: NOW + 30 * 60_000 })).map(({ session }) => session.sessionId)).toContain(idle.sessionId);
  });

  it("does nothing when the owner turned it off", async () => {
    const { deps } = fixture(0);
    expect(await hibernatablePanes(deps)).toEqual([]);
  });

  it("stops each pane, marks its session sleeping and audits it", async () => {
    const { store, deps, idle, done } = fixture();
    const interrupt = vi.fn(async () => true);
    const slept = await sweepHibernatePanes({ ...deps, interrupt, makeTraceId: () => "trace:hibernate", onError: () => undefined });
    expect(slept).toEqual([idle.paneId, done.paneId]);
    expect(interrupt).toHaveBeenCalledWith(idle.sessionId, { content: PANE_HIBERNATED_REASON, traceId: "trace:hibernate" });
    const stored = await store.getPaneCliSession(idle.sessionId);
    expect(stored).toMatchObject({ status: "EXITED", isActive: false });
    expect(isHibernatedSession(stored)).toBe(true);
    expect(isHibernatedSession({ status: "EXITED", statusReason: "CLI session restarted by operator request." })).toBe(false);
  });

  it("counts a shell the CLI started later as a background job, but not its startup shell or a lazily started MCP server", async () => {
    const procs: Record<number, { comm: string; start: number; cmdline: string; children: number[] }> = {
      10: { comm: "claude", start: 1000, cmdline: "claude", children: [11, 12] },
      11: { comm: "bash", start: 1001, cmdline: "bash -c wrapper", children: [] },
      12: { comm: "sh", start: 9000, cmdline: "sh -c playwright-mcp --headless", children: [13] },
      13: { comm: "node", start: 9001, cmdline: "node playwright-mcp", children: [] },
      20: { comm: "claude", start: 1000, cmdline: "claude", children: [21] },
      21: { comm: "bash", start: 9000, cmdline: "bash -c source /home/x/.claude/shell-snapshots/s.sh && npm run dev", children: [] }
    };
    const read = async (pid: number) => procs[pid] ?? null;
    expect(await runsBackgroundJob(10, read)).toBe(false);
    expect(await runsBackgroundJob(20, read)).toBe(true);
    expect(await runsBackgroundJob(99, read)).toBe(false);
  });

  it("wakes a hibernated pane on its next message instead of starting a fresh conversation", async () => {
    const commandDir = await mkdtemp(join(tmpdir(), "space-hibernate-wake-"));
    const commandPath = join(commandDir, "codex-vscode-parity");
    await writeFile(commandPath, "#!/bin/sh\nexit 0\n", "utf8");
    await chmod(commandPath, 0o755);
    const store = new InMemorySpaceStore();
    const room = store.createRoom({ name: "Wake", initialPaneCount: 0 });
    const pane = store.createPane({ roomId: room.id, title: "Sleeper", mode: "TERMINAL", terminalRuntimeId: "cli:codex" });
    const slept = store.createPaneCliSession({ paneId: pane.id, roomId: room.id, runtimeId: "cli:codex", providerId: "codex", agentId: "codex", status: "RUNNING", purpose: "NORMAL" });
    store.updatePaneCliSession(slept.sessionId, { status: "EXITED", statusReason: PANE_HIBERNATED_REASON, exitCode: null, isActive: false });
    let resumedId: string | null = null;
    const wakeHibernatedPane = vi.fn(async () => {
      // What resumePaneCliTask does: a RESUME session of the same task.
      resumedId = store.createPaneCliSession({ paneId: pane.id, roomId: room.id, runtimeId: "cli:codex", providerId: "codex", agentId: "codex",
        status: "IDLE", purpose: "NORMAL", launchMode: "RESUME", cliTaskId: slept.cliTaskId, modelId: "gpt-5.6-sol", reasoningEffort: "xhigh" }).sessionId;
      return true;
    });
    const runtime = agentRuntimeSchema.parse({ id: "cli:codex", providerId: "codex", providerName: "Codex", agentId: "codex", agentName: "Codex CLI",
      displayName: "Codex CLI", capabilities: ["CLI"], ...readyRuntimeAuth, status: "ENABLED", statusReason: "Enabled for test.",
      commandName: "codex-vscode-parity", detectedCommandPath: commandPath, defaultModelId: null, supportedReasoningEfforts: [], checkedAt: "2026-11-13T00:00:00.000Z" });
    const generationId = "00000000-0000-4000-8000-000000000099";
    const attach = vi.fn(async (request: { identity: Record<string, unknown> }) => ({ attachmentId: "attachment:wake",
      session: { ...request.identity, generationId, pid: 5099, status: "RUNNING" as const, statusReason: "Running.", exitCode: null, signal: null,
        nextOutputSequence: 1, attachmentCount: 1, startedAt: "2026-11-13T00:00:00.000Z", endedAt: null },
      replay: [{ type: "output" as const, generationId, sequence: 0, stream: "stdout" as const, data: "OpenAI Codex\nmodel: gpt-5.6-sol xhigh  /model to change\n› " }] }));
    const manager = new CliTerminalManager({ store, config: await enabledCliConfig(commandDir), startupReadyTimeoutMs: 500, wakeHibernatedPane,
      codexBuildDefaultsProvider: async () => ({ modelId: "gpt-5.6-sol", reasoningEffort: "xhigh" }),
      discoverRuntimes: async () => agentRuntimeRegistrySchema.parse({ data: [runtime], checkedAt: "2026-11-13T00:00:00.000Z" }),
      hostClient: { inspect: async () => null, attach, input: async () => ({ accepted: true, acceptedAtMs: 1 }), close: async () => undefined } as never });

    const session = await manager.ensurePaneControlReady(pane, "req:wake");
    expect(wakeHibernatedPane).toHaveBeenCalledWith(pane, "req:wake");
    expect(session.sessionId).toBe(resumedId);
    expect(session.launchMode).toBe("RESUME");
    // Awake now: the hook never runs again for a pane whose last session did not sleep.
    expect(await manager.wakeHibernatedPane(pane, "req:again")).toBe(false);
    expect(wakeHibernatedPane).toHaveBeenCalledTimes(1);
  });
});
