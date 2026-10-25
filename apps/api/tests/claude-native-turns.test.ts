import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { InMemorySpaceStore } from "@space/runtime";
import {
  claudeProjectDirName,
  claudeTaskTimeline,
  createClaudeNativeRefRecorder,
  readClaudeNativeTurns,
  validClaudeTurnReadIdentity
} from "../src/claude-native-turns.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

const nativeSessionId = "85de09e6-3d1f-4e13-9173-142a9e9a36cf";
const observedAt = "2026-10-10T07:30:00.000Z";
const line = (value: Record<string, unknown>) => JSON.stringify(value);
const prompt = (timestamp: string, content: unknown, extra: Record<string, unknown> = {}) =>
  line({ type: "user", timestamp, promptId: `prompt-${timestamp}`, message: { role: "user", content }, ...extra });
const assistant = (timestamp: string, model = "claude-opus-5-5", effort = "xhigh") =>
  line({ type: "assistant", timestamp, effort, message: { model, content: [{ type: "text", text: "ok" }] } });
const turnDuration = (timestamp: string, durationMs: number) => line({ type: "system", subtype: "turn_duration", timestamp, durationMs });

it("builds Claude turns from prompts, assistant models and native turn durations", () => {
  const { tasks, modelId, reasoningEffort } = claudeTaskTimeline([
    prompt("2026-10-10T06:49:15.478Z", "<command-name>/model</command-name>"),
    prompt("2026-10-10T06:49:15.480Z", "<local-command-stdout>Kept model</local-command-stdout>"),
    prompt("2026-10-10T06:49:15.481Z", [{ type: "text", text: "Base directory for this skill" }], { isMeta: true }),
    prompt("2026-10-10T06:49:22.386Z", "continue"),
    assistant("2026-10-10T06:49:30.000Z"),
    prompt("2026-10-10T06:49:31.000Z", [{ type: "tool_result", content: "done" }]),
    assistant("2026-10-10T06:55:00.000Z", "claude-sonnet-5-5", "high"),
    turnDuration("2026-10-10T06:56:36.259Z", 433_918),
    prompt("2026-10-10T06:58:31.766Z", "<task-notification> <task-id>a1</task-id>"),
    assistant("2026-10-10T06:58:40.000Z", "claude-sonnet-5-5", "high"),
    turnDuration("2026-10-10T06:58:55.659Z", 23_913)
  ], false, observedAt);
  expect(tasks.map(task => [task.title, task.status, task.timing.startedAt, task.timing.completedAt, task.timing.durationMs])).toEqual([
    ["continue", "COMPLETED", "2026-10-10T06:49:22.386Z", "2026-10-10T06:56:36.259Z", 433_918],
    ["Background task notification", "COMPLETED", "2026-10-10T06:58:31.766Z", "2026-10-10T06:58:55.659Z", 23_913]
  ]);
  expect(tasks[0]!.modelsUsed.map(model => [model.modelId, model.reasoningEffort, model.completedAt])).toEqual([
    ["claude-opus-5-5", "xhigh", "2026-10-10T06:55:00.000Z"],
    ["claude-sonnet-5-5", "high", "2026-10-10T06:56:36.259Z"]
  ]);
  expect(tasks[0]!.modelsUsed[0]).toMatchObject({ providerId: "anthropic", source: "NATIVE", turnId: tasks[0]!.taskId });
  expect(tasks.every(task => task.timing.source === "NATIVE" && task.timing.observedAt === observedAt)).toBe(true);
  expect([modelId, reasoningEffort]).toEqual(["claude-sonnet-5-5", "high"]);
});

it("keeps the live turn running only while Claude reports busy, and closes interrupted or abandoned turns", () => {
  const lines = [
    prompt("2026-10-10T07:00:00.000Z", "first"),
    assistant("2026-10-10T07:00:10.000Z"),
    prompt("2026-10-10T07:00:12.000Z", [{ type: "text", text: "[Request interrupted by user]" }]),
    prompt("2026-10-10T07:01:00.000Z", "second"),
    assistant("2026-10-10T07:01:05.000Z"),
    // The CLI died without a turn_duration; the next prompt closes this turn at its last activity.
    prompt("2026-10-10T07:20:00.000Z", "third"),
    assistant("2026-10-10T07:20:04.000Z", "<synthetic>")
  ];
  const busy = claudeTaskTimeline(lines, true, observedAt).tasks;
  expect(busy.map(task => [task.title, task.status, task.timing.durationMs])).toEqual([
    ["first", "INTERRUPTED", 12_000],
    ["second", "INTERRUPTED", 5_000],
    ["third", "RUNNING", null]
  ]);
  expect(busy[2]!.modelsUsed).toEqual([]);
  const idle = claudeTaskTimeline(lines, false, observedAt).tasks;
  expect(idle.at(-1)).toMatchObject({ title: "third", status: "INTERRUPTED", timing: { completedAt: "2026-10-10T07:20:04.000Z", durationMs: 4_000 } });
  expect(claudeTaskTimeline(["not json", "", line({ type: "assistant", isSidechain: true, timestamp: "x" })], false, observedAt).tasks).toEqual([]);
});

it("flags a turn cut off by a server error until the next prompt, but not rate or sign-in limits", () => {
  const apiError = (timestamp: string, error: string) => line({ type: "assistant", timestamp, isApiErrorMessage: true, error,
    message: { model: "<synthetic>", content: [{ type: "text", text: "API Error: Connection lost mid-response." }] } });
  const cut = [prompt("2026-10-15T06:18:00.000Z", "deploy it"), assistant("2026-10-15T06:20:00.000Z"),
    apiError("2026-10-15T06:26:04.841Z", "server_error"), turnDuration("2026-10-15T06:26:04.852Z", 489_908)];
  expect(claudeTaskTimeline(cut, false, observedAt).apiError).toBe(true);
  expect(claudeTaskTimeline([...cut, prompt("2026-10-15T06:29:35.550Z", "<task-notification>")], true, observedAt).apiError).toBe(false);
  expect(claudeTaskTimeline([...cut, assistant("2026-10-15T06:27:00.000Z")], false, observedAt).apiError).toBe(false);
  expect(claudeTaskTimeline([cut[0]!, apiError("2026-10-15T06:26:04.841Z", "rate_limit")], false, observedAt).apiError).toBe(false);
});

// Operator order 2026-10-20: a pane stopped at its account's usage limit moves to Space Gateway (claude-limit-move.ts).
it("records the latest answer's account usage limit (429) with its reset, until the next prompt or answer", () => {
  const limit = line({ type: "assistant", timestamp: "2026-10-20T13:55:00.000Z", isApiErrorMessage: true, error: "rate_limit", apiErrorStatus: 429,
    quotaLimits: { status: "rejected", resetsAt: 1792258200, rateLimitType: "five_hour" },
    message: { model: "<synthetic>", content: [{ type: "text", text: "You've hit your session limit · resets 8:30pm (Europe/Athens)" }] } });
  const stopped = [prompt("2026-10-20T13:50:00.000Z", "build it"), assistant("2026-10-20T13:54:00.000Z"), limit];
  expect(claudeTaskTimeline(stopped, false, observedAt).rateLimit).toEqual({ at: "2026-10-20T13:55:00.000Z", resetsAt: new Date(1792258200_000).toISOString() });
  expect(claudeTaskTimeline(stopped, false, observedAt).apiError).toBe(false);
  expect(claudeTaskTimeline([...stopped, prompt("2026-10-20T14:01:00.000Z", "continue")], true, observedAt).rateLimit).toBeNull();
  expect(claudeTaskTimeline([...stopped, assistant("2026-10-20T14:02:00.000Z")], false, observedAt).rateLimit).toBeNull();
});

async function fixture(options: { environ?: string; procStart?: string; ancestors?: number[]; session?: Record<string, unknown> } = {}) {
  const root = await mkdtemp(join(tmpdir(), "claude-native-turns-"));
  roots.push(root);
  const procRoot = join(root, "proc"), configDir = join(root, "space-claude");
  const cwd = "/opt/spaceapp/var/worktrees/space/wt-mv219m70-6bed9c";
  const chain = options.ancestors ?? [4000, 3000];
  const writeStat = async (pid: number, ppid: number, start = "100") => {
    await mkdir(join(procRoot, String(pid)), { recursive: true });
    const fields = ["S", String(ppid), ...Array.from({ length: 17 }, () => "0"), start];
    await writeFile(join(procRoot, String(pid), "stat"), `${pid} (claude (x)) ${fields.join(" ")}`);
  };
  await writeStat(5000, chain[0]!, "148353311");
  for (const [index, pid] of chain.entries()) await writeStat(pid, chain[index + 1] ?? 1);
  await writeFile(join(procRoot, "5000", "environ"),
    options.environ ?? "HOME=/var/lib/spaceapp-user\0SPACE_PANE_ID=pane:aOkhY3lGc3Pt\0SPACE_CLI_SESSION_ID=cli_session:IvjjxTLwxQvE\0");
  await mkdir(join(configDir, "sessions"), { recursive: true });
  await writeFile(join(configDir, "sessions", "5000.json"), JSON.stringify({
    pid: 5000, sessionId: nativeSessionId, cwd, procStart: options.procStart ?? "148353311", status: "busy", kind: "interactive", ...options.session
  }));
  await writeFile(join(configDir, "sessions", "5000.aaaa.key"), "secret");
  await mkdir(join(configDir, "projects", claudeProjectDirName(cwd)), { recursive: true });
  await writeFile(join(configDir, "projects", claudeProjectDirName(cwd), `${nativeSessionId}.jsonl`), [
    prompt("2026-10-10T07:00:00.000Z", "deploy the fix"),
    assistant("2026-10-10T07:00:05.000Z")
  ].join("\n") + "\n");
  return { procRoot, configDir };
}

const identity = { paneId: "pane:aOkhY3lGc3Pt", sessionId: "cli_session:IvjjxTLwxQvE", rootPid: 3000 };

it("reads only the Claude process that descends from the pane host and carries this Space session identity", async () => {
  const paths = await fixture();
  const result = await readClaudeNativeTurns(identity, { ...paths, now: () => new Date(observedAt) });
  expect(result).toMatchObject({ nativeSessionId, busy: true, status: "busy", waitingFor: null, statusUpdatedAt: null, modelId: "claude-opus-5-5", reasoningEffort: "xhigh" });
  expect(result!.tasks.map(task => [task.title, task.status])).toEqual([["deploy the fix", "RUNNING"]]);
  expect(claudeProjectDirName("/work/repo/worktrees/wt-mv219m70-6bed9c.1")).toBe("-work-repo-worktrees-wt-mv219m70-6bed9c-1");
});

it("reports Claude's own live status: waiting with its reason, a finished turn with background shells as not busy, unknown values as null", async () => {
  const waiting = await readClaudeNativeTurns(identity, await fixture({ session: {
    status: "waiting", waitingFor: "  permission\n prompt ", statusUpdatedAt: Date.parse("2026-10-10T07:10:00.000Z")
  } }));
  expect(waiting).toMatchObject({ busy: false, status: "waiting", waitingFor: "permission prompt", statusUpdatedAt: "2026-10-10T07:10:00.000Z" });
  expect(waiting!.tasks.at(-1)!.status).toBe("INTERRUPTED");
  expect(await readClaudeNativeTurns(identity, await fixture({ session: { status: "shell" } }))).toMatchObject({ busy: false, status: "shell" });
  expect(await readClaudeNativeTurns(identity, await fixture({ session: { status: "idle", waitingFor: "stale" } })))
    .toMatchObject({ busy: false, status: "idle", waitingFor: null });
  expect(await readClaudeNativeTurns(identity, await fixture({ session: { status: "launching", statusUpdatedAt: "x" } })))
    .toMatchObject({ busy: false, status: null, statusUpdatedAt: null });
});

it("fails closed for another pane's session, a reused PID, or a process outside the pane host tree", async () => {
  expect(await readClaudeNativeTurns({ ...identity, sessionId: "cli_session:OtherSession1" }, await fixture())).toBeNull();
  expect(await readClaudeNativeTurns({ ...identity, paneId: "pane:OtherPane123" }, await fixture())).toBeNull();
  expect(await readClaudeNativeTurns(identity, await fixture({ procStart: "999" }))).toBeNull();
  expect(await readClaudeNativeTurns(identity, await fixture({ ancestors: [4000, 2000] }))).toBeNull();
  expect(await readClaudeNativeTurns({ ...identity, rootPid: null }, await fixture())).toBeNull();
});

it("validates the fixed launcher identity arguments", () => {
  expect(validClaudeTurnReadIdentity(identity)).toBe(true);
  expect(validClaudeTurnReadIdentity({ ...identity, paneId: "pane:../x" })).toBe(false);
  expect(validClaudeTurnReadIdentity({ ...identity, sessionId: "cli_session:a;b" })).toBe(false);
  expect(validClaudeTurnReadIdentity({ ...identity, rootPid: 1 })).toBe(false);
  expect(validClaudeTurnReadIdentity({ ...identity, rootPid: Number.NaN })).toBe(false);
});

it("reports Claude's saved session title, preferring a /rename title over its AI title", () => {
  const sessionId = nativeSessionId;
  const ai = (aiTitle: string) => line({ type: "ai-title", aiTitle, sessionId });
  const automatic = claudeTaskTimeline([
    prompt("2026-10-10T06:49:22.386Z", "Improve pane titles"),
    ai("Pane title summaries"),
    assistant("2026-10-10T06:49:30.000Z"),
    ai("Pane title summaries"),
  ], false, observedAt);
  expect([automatic.title, automatic.titleManual]).toEqual(["Pane title summaries", false]);
  expect(automatic.tasks).toHaveLength(1);
  const renamed = claudeTaskTimeline([
    ai("Pane title summaries"),
    line({ type: "custom-title", customTitle: "My pinned name", sessionId }),
    ai("Later automatic title"),
  ], false, observedAt);
  expect([renamed.title, renamed.titleManual]).toEqual(["My pinned name", true]);
  expect(claudeTaskTimeline([prompt("2026-10-10T06:49:22.386Z", "No title yet")], false, observedAt).title).toBeNull();
});

it("records the live Claude conversation on its task once a turn is written, so resume survives the process", async () => {
  const store = new InMemorySpaceStore();
  const room = store.createRoom({ name: "Claude native ref", initialPaneCount: 0 });
  const pane = store.createPane({ roomId: room.id, title: "Claude Code CLI", mode: "TERMINAL", terminalRuntimeId: "cli:claude", cwd: "/etc" });
  const session = store.createPaneCliSession({
    paneId: pane.id, roomId: room.id, runtimeId: "cli:claude", providerId: "anthropic", agentId: "claude",
    modelId: null, reasoningEffort: "medium", cwd: "/etc", status: "RUNNING", statusReason: "test session", isActive: true
  });
  const revisionId = session.cliTaskRevisionId!;
  const getRevision = vi.spyOn(store, "getCliTaskRevision");
  const record = createClaudeNativeRefRecorder(store);
  const turn = claudeTaskTimeline([prompt("2026-10-10T06:49:22.386Z", "continue")], true, observedAt).tasks;

  await record(session, { nativeSessionId, tasks: [] });
  expect(store.getCliTaskRevision(revisionId)?.nativeTaskRef ?? null).toBeNull();

  await record(session, { nativeSessionId, tasks: turn });
  expect(store.getCliTaskRevision(revisionId)?.nativeTaskRef).toBe(nativeSessionId);

  const readsAfterRecord = getRevision.mock.calls.length;
  await record(session, { nativeSessionId, tasks: turn });
  expect(getRevision.mock.calls.length).toBe(readsAfterRecord);
});
