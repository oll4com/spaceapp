import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemorySpaceStore } from "@space/runtime";
import {
  inspectCodexCliCompletion,
  resolveCodexCliRolloutPath,
  sweepCodexCliCompletions
} from "../src/codex-cli-completion.js";

const execFileAsync = promisify(execFile);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function jsonl(records: unknown[]): string {
  return `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
}

describe("Codex CLI completion correlation", () => {
  it("returns the matching Unicode final response after the durable submit time", () => {
    const submittedAtMs = Date.parse("2026-07-14T10:00:00.000Z");
    const content = jsonl([
      { type: "turn_context", timestamp: "2026-07-14T09:59:55.000Z", payload: { turn_id: "turn:old" } },
      {
        type: "response_item",
        timestamp: "2026-07-14T09:59:56.000Z",
        payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "old response" }] }
      },
      {
        type: "event_msg",
        timestamp: "2026-07-14T09:59:57.000Z",
        payload: { type: "task_complete", turn_id: "turn:old", last_agent_message: "old response" }
      },
      { type: "turn_context", timestamp: "2026-07-14T10:00:01.000Z", payload: { turn_id: "turn:new" } },
      { type: "event_msg", timestamp: "2026-07-14T10:00:02.000Z", payload: { type: "user_message", turn_id: "turn:new" } },
      {
        type: "response_item",
        timestamp: "2026-07-14T10:00:03.000Z",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Ολοκληρώθηκε σωστά ✅\nΧωρίς περικοπή." }]
        }
      },
      {
        type: "event_msg",
        timestamp: "2026-07-14T10:00:04.000Z",
        payload: { type: "task_complete", turn_id: "turn:new", completed_at: 1784023204 }
      }
    ]);

    expect(inspectCodexCliCompletion(content, { submittedAtMs })).toEqual({
      status: "COMPLETED",
      turnId: "turn:new",
      finalResponse: "Ολοκληρώθηκε σωστά ✅\nΧωρίς περικοπή.",
      completedAt: "2026-07-14T10:00:04.000Z"
    });
  });

  it("recovers the final answer when the marker was created mid-turn (turn_context predates submittedAt)", () => {
    const submittedAtMs = Date.parse("2026-08-13T12:49:26.382Z");
    const content = jsonl([
      { type: "turn_context", timestamp: "2026-08-13T12:40:19.654Z", payload: { turn_id: "turn:mid" } },
      {
        type: "response_item",
        timestamp: "2026-08-13T12:50:08.772Z",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Δουλεύω ακόμα…" }]
        }
      },
      {
        type: "response_item",
        timestamp: "2026-08-13T13:00:33.923Z",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Ολοκληρώθηκε ✅" }]
        }
      },
      {
        type: "event_msg",
        timestamp: "2026-08-13T13:00:34.043Z",
        payload: { type: "task_complete", turn_id: "turn:mid" }
      }
    ]);

    expect(inspectCodexCliCompletion(content, { submittedAtMs })).toEqual({
      status: "COMPLETED",
      turnId: "turn:mid",
      finalResponse: "Ολοκληρώθηκε ✅",
      completedAt: "2026-08-13T13:00:34.043Z"
    });
  });

  it("deduplicates repeated task_complete records and prefers last_agent_message", () => {
    const content = jsonl([
      { type: "turn_context", timestamp: "2026-07-14T10:00:01.000Z", payload: { turn_id: "turn:duplicate" } },
      {
        type: "event_msg",
        timestamp: "2026-07-14T10:00:03.000Z",
        payload: { type: "task_complete", turn_id: "turn:duplicate", last_agent_message: "Final from Codex" }
      },
      {
        type: "event_msg",
        timestamp: "2026-07-14T10:00:04.000Z",
        payload: { type: "task_complete", turn_id: "turn:duplicate", last_agent_message: "Final from Codex" }
      }
    ]);

    expect(inspectCodexCliCompletion(content, {
      submittedAtMs: Date.parse("2026-07-14T10:00:00.000Z")
    })).toEqual({
      status: "COMPLETED",
      turnId: "turn:duplicate",
      finalResponse: "Final from Codex",
      completedAt: "2026-07-14T10:00:03.000Z"
    });
  });

  it("keeps completed turns pending until a final response exists and ignores aborted turns", () => {
    const submittedAtMs = Date.parse("2026-07-14T10:00:00.000Z");
    expect(inspectCodexCliCompletion(jsonl([
      { type: "turn_context", timestamp: "2026-07-14T10:00:01.000Z", payload: { turn_id: "turn:missing" } },
      {
        type: "event_msg",
        timestamp: "2026-07-14T10:00:03.000Z",
        payload: { type: "task_complete", turn_id: "turn:missing", last_agent_message: null }
      }
    ]), { submittedAtMs })).toEqual({
      status: "PENDING",
      turnId: "turn:missing",
      safeErrorCode: "CODEX_CLI_FINAL_RESPONSE_PENDING"
    });

    expect(inspectCodexCliCompletion(jsonl([
      { type: "turn_context", timestamp: "2026-07-14T10:00:01.000Z", payload: { turn_id: "turn:aborted" } },
      {
        type: "event_msg",
        timestamp: "2026-07-14T10:00:02.000Z",
        payload: { type: "turn_aborted", turn_id: "turn:aborted" }
      }
    ]), { submittedAtMs })).toEqual({ status: "ABORTED", turnId: "turn:aborted" });
  });

  it("does not publish an attachment acknowledgement while the Room Agent Goal is active", () => {
    const submittedAtMs = Date.parse("2026-08-10T04:40:14.000Z");
    const content = jsonl([
      { type: "turn_context", timestamp: "2026-08-10T04:40:15.000Z", payload: { turn_id: "turn:seed" } },
      { type: "event_msg", timestamp: "2026-08-10T04:40:15.100Z", payload: { type: "user_message", turn_id: "turn:seed" } },
      { type: "event_msg", timestamp: "2026-08-10T04:40:18.222Z", payload: { type: "task_complete", turn_id: "turn:seed", last_agent_message: "The attachments are ready." } },
      { type: "event_msg", timestamp: "2026-08-10T04:40:18.226Z", payload: { type: "thread_goal_updated", goal: { status: "active" } } },
      { type: "turn_context", timestamp: "2026-08-10T04:40:18.230Z", payload: { turn_id: "turn:goal" } },
      { type: "event_msg", timestamp: "2026-08-10T04:40:18.232Z", payload: { type: "task_started", turn_id: "turn:goal" } },
      { type: "event_msg", timestamp: "2026-08-10T04:40:26.000Z", payload: { type: "agent_message", message: "Still working." } }
    ]);

    expect(inspectCodexCliCompletion(content, { submittedAtMs })).toEqual({
      status: "PENDING",
      turnId: "turn:goal"
    });
  });

  it("publishes the final Goal response instead of the earlier attachment acknowledgement", () => {
    const submittedAtMs = Date.parse("2026-08-10T04:40:14.000Z");
    const content = jsonl([
      { type: "turn_context", timestamp: "2026-08-10T04:40:15.000Z", payload: { turn_id: "turn:seed" } },
      { type: "event_msg", timestamp: "2026-08-10T04:40:18.000Z", payload: { type: "task_complete", turn_id: "turn:seed", last_agent_message: "The attachments are ready." } },
      { type: "event_msg", timestamp: "2026-08-10T04:40:18.100Z", payload: { type: "thread_goal_updated", goal: { status: "active" } } },
      { type: "turn_context", timestamp: "2026-08-10T04:40:18.200Z", payload: { turn_id: "turn:goal" } },
      { type: "event_msg", timestamp: "2026-08-10T04:40:18.300Z", payload: { type: "task_started", turn_id: "turn:goal" } },
      { type: "response_item", timestamp: "2026-08-10T04:41:00.000Z", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Η εργασία ολοκληρώθηκε." }] } },
      { type: "event_msg", timestamp: "2026-08-10T04:41:00.100Z", payload: { type: "thread_goal_updated", goal: { status: "complete" } } },
      { type: "event_msg", timestamp: "2026-08-10T04:41:00.200Z", payload: { type: "task_complete", turn_id: "turn:goal" } }
    ]);

    expect(inspectCodexCliCompletion(content, { submittedAtMs })).toEqual({
      status: "COMPLETED",
      turnId: "turn:goal",
      finalResponse: "Η εργασία ολοκληρώθηκε.",
      completedAt: "2026-08-10T04:41:00.200Z"
    });
  });

  it("resolves only the rollout owned by the pane CLI session", async () => {
    const codexHome = await mkdtemp(join(tmpdir(), "space-codex-cli-completion-"));
    roots.push(codexHome);
    const paneId = "pane:test";
    const sessionId = "cli_session:test";
    const runtimeKey = "pane_test--cli_session_test";
    const sessionsRoot = join(codexHome, "space-codex-homes", runtimeKey, "sessions", "2026", "07", "14");
    const rolloutPath = join(sessionsRoot, "rollout-owned.jsonl");
    await mkdir(sessionsRoot, { recursive: true });
    await writeFile(rolloutPath, "{}\n", "utf8");
    await execFileAsync("sqlite3", [
      join(codexHome, "state_5.sqlite"),
      "CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL, thread_source TEXT, agent_path TEXT);",
      `INSERT INTO threads (id, rollout_path, thread_source, agent_path) VALUES ('thread:owned', '${rolloutPath.replaceAll("'", "''")}', 'user', NULL);`
    ]);

    await expect(resolveCodexCliRolloutPath({ codexHome, paneId, sessionId, threadId: "thread:owned" })).resolves.toEqual({
      status: "READY",
      rolloutPath
    });

    const outsideRoot = await mkdtemp(join(tmpdir(), "space-codex-cli-completion-outside-"));
    roots.push(outsideRoot);
    const outsidePath = join(outsideRoot, "rollout-outside.jsonl");
    await writeFile(outsidePath, "{}\n", "utf8");
    await execFileAsync("sqlite3", [
      join(codexHome, "state_5.sqlite"),
      `INSERT INTO threads (id, rollout_path, thread_source, agent_path) VALUES ('thread:outside', '${outsidePath.replaceAll("'", "''")}', 'user', NULL);`
    ]);
    await expect(resolveCodexCliRolloutPath({ codexHome, paneId, sessionId, threadId: "thread:outside" })).resolves.toEqual({
      status: "UNSAFE",
      safeErrorCode: "CODEX_CLI_ROLLOUT_OUTSIDE_SESSION"
    });

    const linkedPath = join(sessionsRoot, "rollout-linked.jsonl");
    await symlink(outsidePath, linkedPath);
    await execFileAsync("sqlite3", [
      join(codexHome, "state_5.sqlite"),
      `INSERT INTO threads (id, rollout_path, thread_source, agent_path) VALUES ('thread:linked', '${linkedPath.replaceAll("'", "''")}', 'user', NULL);`,
      `INSERT INTO threads (id, rollout_path, thread_source, agent_path) VALUES ('thread:internal', '${rolloutPath.replaceAll("'", "''")}', 'user', '/internal/smoke.md');`
    ]);
    await expect(resolveCodexCliRolloutPath({ codexHome, paneId, sessionId, threadId: "thread:linked" })).resolves.toEqual({
      status: "UNSAFE",
      safeErrorCode: "CODEX_CLI_ROLLOUT_OUTSIDE_SESSION"
    });
    await expect(resolveCodexCliRolloutPath({ codexHome, paneId, sessionId, threadId: "thread:internal" })).resolves.toEqual({
      status: "EXCLUDED",
      safeErrorCode: "CODEX_CLI_THREAD_EXCLUDED"
    });
  });

  it("recovers a late-bound durable marker after restart and completes it exactly once", async () => {
    const store = new InMemorySpaceStore();
    const room = store.createRoom({ name: "Restart recovery", initialPaneCount: 0 });
    const pane = store.createPane({ roomId: room.id, title: "Codex terminal", mode: "TERMINAL", cwd: "/etc" });
    const session = store.createPaneCliSession({
      sessionId: "cli_session:restart-recovery",
      roomId: room.id,
      paneId: pane.id,
      runtimeId: "cli:codex",
      providerId: "codex",
      agentId: "codex",
      modelId: "gpt-5.6-sol",
      reasoningEffort: "high",
      cwd: "/etc",
      codexThreadId: null,
      status: "RUNNING",
      statusReason: "Running",
      isActive: true
    });
    store.createCodexCliTurnMarker({
      sessionId: session.sessionId,
      roomId: room.id,
      paneId: pane.id,
      clientTurnMarker: "browser-marker-restart",
      submittedAt: "2026-07-14T10:00:00.000Z"
    });
    const completion = jsonl([
      { type: "turn_context", timestamp: "2026-07-14T10:00:01.000Z", payload: { turn_id: "turn:restart" } },
      {
        type: "event_msg",
        timestamp: "2026-07-14T10:00:04.000Z",
        payload: { type: "task_complete", turn_id: "turn:restart", last_agent_message: "Recovered completion" }
      }
    ]);
    const dependencies = {
      store,
      workerId: "worker:restart-recovery",
      codexHome: "/unused",
      resolveRolloutPath: async () => ({ status: "READY" as const, rolloutPath: "/owned/rollout.jsonl" }),
      readRollout: async () => completion
    };

    await expect(sweepCodexCliCompletions({
      ...dependencies,
      now: () => new Date("2026-07-14T10:00:05.000Z")
    })).resolves.toEqual({ claimed: 1, completed: 0, deferred: 1, ignored: 0, failed: 0 });

    store.updatePaneCliSession(session.sessionId, { codexThreadId: "019f0000-0000-7000-8000-000000000001" });
    await expect(sweepCodexCliCompletions({
      ...dependencies,
      now: () => new Date("2026-07-14T10:00:10.000Z")
    })).resolves.toEqual({ claimed: 1, completed: 1, deferred: 0, ignored: 0, failed: 0 });
    await expect(sweepCodexCliCompletions({
      ...dependencies,
      now: () => new Date("2026-07-14T10:00:20.000Z")
    })).resolves.toEqual({ claimed: 0, completed: 0, deferred: 0, ignored: 0, failed: 0 });

    expect(store.listEvents(room.id).filter((event) => event.type === "TURN_STARTED")).toEqual([
      expect.objectContaining({
        paneId: pane.id,
        payload: expect.objectContaining({ clientTurnMarker: "browser-marker-restart", runtimeId: "cli:codex" })
      })
    ]);
    expect(store.listEvents(room.id).filter((event) => event.type === "TURN_COMPLETED")).toHaveLength(1);
    expect(store.listEvents(room.id).find((event) => event.type === "TURN_COMPLETED")?.payload).toMatchObject({
      clientTurnMarker: "browser-marker-restart"
    });
  });

  function longTurnFixture(name: string) {
    const store = new InMemorySpaceStore();
    const room = store.createRoom({ name, initialPaneCount: 0 });
    const pane = store.createPane({ roomId: room.id, title: "Codex terminal", mode: "TERMINAL", cwd: "/etc" });
    const session = store.createPaneCliSession({
      roomId: room.id,
      paneId: pane.id,
      runtimeId: "cli:codex",
      providerId: "codex",
      agentId: "codex",
      modelId: "gpt-5.6-sol",
      reasoningEffort: "high",
      cwd: "/etc",
      codexThreadId: "019f0000-0000-7000-8000-000000000051",
      status: "RUNNING",
      statusReason: "Running",
      isActive: true
    });
    store.createCodexCliTurnMarker({
      sessionId: session.sessionId,
      roomId: room.id,
      paneId: pane.id,
      clientTurnMarker: `browser-marker-${name}`,
      submittedAt: "2026-07-14T10:00:00.000Z"
    });
    const started = { type: "turn_context", timestamp: "2026-07-14T10:00:01.000Z", payload: { turn_id: "turn:long" } };
    return { store, room, session, started };
  }

  it("keeps waiting on a terminal turn that runs for hours and still notifies its completion", async () => {
    const { store, room, started } = longTurnFixture("Long turn");
    let content = jsonl([started]);
    let clock = Date.parse("2026-07-14T10:00:05.000Z");
    const sweep = () => sweepCodexCliCompletions({
      store,
      workerId: "worker:long-turn",
      codexHome: "/unused",
      now: () => new Date(clock),
      resolveRolloutPath: async () => ({ status: "READY", rolloutPath: "/owned/rollout.jsonl" }),
      readRollout: async () => content
    });

    // Two and a half hours of 30s sweeps used to exhaust the 240-check budget after about two hours.
    for (; clock < Date.parse("2026-07-14T12:30:00.000Z"); clock += 30_000) {
      await expect(sweep()).resolves.toMatchObject({ completed: 0, ignored: 0, failed: 0 });
    }
    content = jsonl([
      started,
      {
        type: "event_msg",
        timestamp: "2026-07-14T12:29:00.000Z",
        payload: { type: "task_complete", turn_id: "turn:long", last_agent_message: "Long task finished" }
      }
    ]);
    clock += 5 * 60_000;
    await expect(sweep()).resolves.toMatchObject({ completed: 1, failed: 0 });
    expect(store.listEvents(room.id).filter((event) => event.type === "TURN_COMPLETED")).toHaveLength(1);
  });

  it("stops waiting on a turn once its CLI exited, but still completes a turn the exited CLI finished", async () => {
    const sweep = (store: InMemorySpaceStore, content: string, clock: string) => sweepCodexCliCompletions({
      store,
      workerId: "worker:exited",
      codexHome: "/unused",
      now: () => new Date(clock),
      resolveRolloutPath: async () => ({ status: "READY", rolloutPath: "/owned/rollout.jsonl" }),
      readRollout: async () => content
    });
    const stuck = longTurnFixture("Exited turn");
    await expect(sweep(stuck.store, jsonl([stuck.started]), "2026-07-14T10:00:05.000Z")).resolves.toMatchObject({ deferred: 1, ignored: 0 });
    stuck.store.updatePaneCliSession(stuck.session.sessionId, { status: "EXITED", isActive: false });
    await expect(sweep(stuck.store, jsonl([stuck.started]), "2026-07-14T10:10:00.000Z")).resolves.toMatchObject({ claimed: 1, deferred: 0, ignored: 1 });
    expect(stuck.store.listEvents(stuck.room.id).filter((event) => event.type === "TURN_FAILED")).toEqual([
      expect.objectContaining({ payload: expect.objectContaining({ safeErrorCode: "CODEX_CLI_SESSION_ENDED" }) })
    ]);

    const finished = longTurnFixture("Exited after finishing");
    finished.store.updatePaneCliSession(finished.session.sessionId, { status: "EXITED", isActive: false });
    await expect(sweep(finished.store, jsonl([finished.started, {
      type: "event_msg",
      timestamp: "2026-07-14T10:00:03.000Z",
      payload: { type: "task_complete", turn_id: "turn:long", last_agent_message: "Done before exit" }
    }]), "2026-07-14T10:00:05.000Z")).resolves.toMatchObject({ completed: 1, ignored: 0 });
  });

  it("backs off after the first hour and gives up on a turn only by its age", async () => {
    const { store, started } = longTurnFixture("Stuck turn");
    const defer = vi.spyOn(store, "deferCodexCliTurnMarker");
    const logs: Array<{ status: string; safeErrorCode: string | null }> = [];
    const sweepAt = (iso: string) => sweepCodexCliCompletions({
      store,
      workerId: "worker:stuck-turn",
      codexHome: "/unused",
      now: () => new Date(iso),
      log: (record) => logs.push(record),
      resolveRolloutPath: async () => ({ status: "READY", rolloutPath: "/owned/rollout.jsonl" }),
      readRollout: async () => jsonl([started])
    });
    const lastDelayMs = () => {
      const input = defer.mock.calls.at(-1)![0];
      return Date.parse(input.nextCheckAt) - Date.parse(input.now);
    };

    await expect(sweepAt("2026-07-14T10:00:05.000Z")).resolves.toMatchObject({ deferred: 1 });
    expect(lastDelayMs()).toBe(2_000);
    await expect(sweepAt("2026-07-14T12:00:00.000Z")).resolves.toMatchObject({ deferred: 1 });
    expect(lastDelayMs()).toBe(2 * 60_000);
    await expect(sweepAt("2026-07-14T17:00:00.000Z")).resolves.toMatchObject({ deferred: 1 });
    expect(lastDelayMs()).toBe(5 * 60_000);
    await expect(sweepAt("2026-07-15T10:00:00.000Z")).resolves.toMatchObject({ deferred: 0, failed: 1 });
    expect(logs.at(-1)).toMatchObject({ status: "FAILED", safeErrorCode: "CODEX_CLI_COMPLETION_TIMEOUT" });
  });

  it("isolates a failing marker so the rest of the batch still completes", async () => {
    const store = new InMemorySpaceStore();
    const room = store.createRoom({ name: "Sweep isolation", initialPaneCount: 0 });
    const panes = ["Broken terminal", "Healthy terminal"].map((title, index) => {
      const pane = store.createPane({ roomId: room.id, title, mode: "TERMINAL", cwd: "/etc" });
      const session = store.createPaneCliSession({
        roomId: room.id,
        paneId: pane.id,
        runtimeId: "cli:codex",
        providerId: "codex",
        agentId: "codex",
        modelId: "gpt-5.6-sol",
        reasoningEffort: "high",
        cwd: "/etc",
        codexThreadId: `019f0000-0000-7000-8000-00000000004${index}`,
        status: "RUNNING",
        statusReason: "Running",
        isActive: true
      });
      store.createCodexCliTurnMarker({
        sessionId: session.sessionId,
        roomId: room.id,
        paneId: pane.id,
        clientTurnMarker: `browser-marker-isolation-${index}`,
        submittedAt: "2026-07-14T10:00:00.000Z"
      });
      return pane;
    });
    const logs: Array<{ status: string; safeErrorCode: string | null }> = [];

    await expect(sweepCodexCliCompletions({
      store,
      workerId: "worker:isolation",
      codexHome: "/unused",
      now: () => new Date("2026-07-14T10:00:05.000Z"),
      log: (record) => logs.push(record),
      resolveRolloutPath: async ({ paneId }) => {
        if (paneId === panes[0]!.id) throw new Error("rollout index unavailable");
        return { status: "READY", rolloutPath: "/owned/rollout.jsonl" };
      },
      readRollout: async () => jsonl([
        { type: "turn_context", timestamp: "2026-07-14T10:00:01.000Z", payload: { turn_id: "turn:isolation" } },
        {
          type: "event_msg",
          timestamp: "2026-07-14T10:00:04.000Z",
          payload: { type: "task_complete", turn_id: "turn:isolation", last_agent_message: "Healthy completion" }
        }
      ])
    })).resolves.toEqual({ claimed: 2, completed: 1, deferred: 1, ignored: 0, failed: 0 });
    expect(logs).toContainEqual(expect.objectContaining({ status: "DEFERRED", safeErrorCode: "CODEX_CLI_SWEEP_ERROR" }));
    expect(store.listEvents(room.id).filter((event) => event.type === "TURN_COMPLETED")).toEqual([
      expect.objectContaining({ paneId: panes[1]!.id })
    ]);
  });

  it("marks aborted terminal turns ignored without emitting completion", async () => {
    const store = new InMemorySpaceStore();
    const room = store.createRoom({ name: "Aborted turn", initialPaneCount: 0 });
    const pane = store.createPane({ roomId: room.id, title: "Codex terminal", mode: "TERMINAL", cwd: "/etc" });
    const session = store.createPaneCliSession({
      roomId: room.id,
      paneId: pane.id,
      runtimeId: "cli:codex",
      providerId: "codex",
      agentId: "codex",
      modelId: "gpt-5.6-sol",
      reasoningEffort: "high",
      cwd: "/etc",
      codexThreadId: "019f0000-0000-7000-8000-000000000002",
      status: "RUNNING",
      statusReason: "Running",
      isActive: true
    });
    store.createCodexCliTurnMarker({
      sessionId: session.sessionId,
      roomId: room.id,
      paneId: pane.id,
      clientTurnMarker: "browser-marker-aborted",
      submittedAt: "2026-07-14T10:00:00.000Z"
    });

    await expect(sweepCodexCliCompletions({
      store,
      workerId: "worker:aborted",
      codexHome: "/unused",
      now: () => new Date("2026-07-14T10:00:05.000Z"),
      resolveRolloutPath: async () => ({ status: "READY", rolloutPath: "/owned/rollout.jsonl" }),
      readRollout: async () => jsonl([
        { type: "turn_context", timestamp: "2026-07-14T10:00:01.000Z", payload: { turn_id: "turn:aborted" } },
        { type: "event_msg", timestamp: "2026-07-14T10:00:03.000Z", payload: { type: "turn_aborted", turn_id: "turn:aborted" } }
      ])
    })).resolves.toEqual({ claimed: 1, completed: 0, deferred: 0, ignored: 1, failed: 0 });
    expect(store.listEvents(room.id).filter((event) => event.type === "TURN_COMPLETED")).toHaveLength(0);
    expect(store.listEvents(room.id).filter((event) => event.type === "TURN_FAILED")).toEqual([
      expect.objectContaining({
        paneId: pane.id,
        type: "TURN_FAILED",
        payload: expect.objectContaining({
          clientTurnMarker: "browser-marker-aborted",
          safeErrorCode: "CODEX_CLI_TURN_ABORTED"
        })
      })
    ]);
  });
});
