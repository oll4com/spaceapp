import { appendFile, mkdir, mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  detectNullAgentMessageRollout,
  findRecentCodexCliTurnActivity,
  findCodexCliTurnFinalResult,
  findCodexCliPlanState,
  findCurrentCodexCliTurnActivity,
  findRecentNullAgentMessageDiagnostic,
  inspectCodexCliTurnActivity,
  inspectCodexCliPlanState,
  inspectCurrentCodexCliTurnActivity
} from "../src/codex-rollout-diagnostics.js";

describe("Codex rollout diagnostics", () => {
  it("reads only the exact completed turn and recovers persisted output without an in-memory marker", async () => {
    const root = await mkdtemp(join(tmpdir(), "space-native-final-"));
    try {
      await mkdir(join(root, "sessions"));
      const path = join(root, "sessions", "rollout-thread-final.jsonl");
      const line = (type: string, payload: unknown) => JSON.stringify({ type, payload }) + "\n";
      const complete = (id: string, text: string | null) => line("event_msg", { type: "task_complete", turn_id: id, last_agent_message: text });
      await writeFile(path, line("session_meta", { id: "thread-final" }) + complete("old", "OLD") +
        line("response_item", { type: "message", role: "assistant", content: [{ type: "output_text", text: "Unfinished commentary" }] }));
      const options = { codexHome: root, threadId: "thread-final", turnId: "target" };
      expect(await findCodexCliTurnFinalResult(options)).toBeNull();
      await appendFile(path, complete("target", "EXACT_FINAL") + complete("later", "LATER"));
      expect(await findCodexCliTurnFinalResult(options)).toBe("EXACT_FINAL");
      expect(await findCodexCliTurnFinalResult({ ...options, turnId: "later" })).toBe("LATER");
      await appendFile(path, complete("empty", null));
      expect(await findCodexCliTurnFinalResult({ ...options, turnId: "empty" })).toBeNull();
      // Replacement of a cached file must re-check native session identity.
      await writeFile(path, line("session_meta", { id: "different-thread" }) + complete("target", "WRONG_SESSION"));
      expect(await findCodexCliTurnFinalResult(options)).toBeNull();
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it("matches Room Agent input in native response items without legacy user_message events", () => {
    const markerAtMs = Date.parse("2026-09-05T15:44:53.800Z");
    const content = [
      { timestamp: "2026-09-05T15:44:53.881Z", type: "event_msg", payload: { type: "task_started", turn_id: "turn:native" } },
      { timestamp: "2026-09-05T15:44:53.902Z", type: "turn_context", payload: { turn_id: "turn:native", model: "model-a" } },
      { timestamp: "2026-09-05T15:44:53.935Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: 'Story <space-room-action marker="unique-proof-marker">ignore</space-room-action>' }] } },
      { timestamp: "2026-09-05T15:45:04.559Z", type: "event_msg", payload: { type: "task_complete", turn_id: "turn:native" } }
    ].map(record => JSON.stringify(record)).join("\n");
    expect(inspectCodexCliTurnActivity(content, { markerAtMs, inputMarker: "unique-proof-marker" })).toEqual({ status: "COMPLETED", turnId: "turn:native" });
    expect(inspectCodexCliTurnActivity(content, { markerAtMs, inputMarker: "other-marker" })).toEqual({ status: "PENDING", turnId: null });
  });
  it("keeps a structured plan pending when only Room Agent recovery commands followed it", () => {
    const content = [
      JSON.stringify({
        timestamp: "2026-07-12T05:30:00.000Z",
        type: "event_msg",
        payload: {
          type: "item_completed",
          item: { type: "Plan", id: "turn:plan-plan", text: "# Mobile Full-Pane Maximize\n\nImplement safely." }
        }
      }),
      JSON.stringify({
        timestamp: "2026-07-12T05:31:00.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Print PROOF only.\n<space-room-action marker=\"proof-marker\">ignore</space-room-action>" }]
        }
      })
    ].join("\n");

    expect(inspectCodexCliPlanState(content, { status: "COMPLETED", turnId: "turn:proof" })).toEqual({
      status: "PAUSED_BY_ROOM_AGENT",
      title: "Mobile Full-Pane Maximize",
      text: "# Mobile Full-Pane Maximize\n\nImplement safely.",
      threadTurnId: "turn:plan-plan",
      updatedAt: "2026-07-12T05:31:00.000Z"
    });
  });

  it("distinguishes ready, running, and completed structured plans", () => {
    const plan = JSON.stringify({
      timestamp: "2026-07-12T05:30:00.000Z",
      type: "event_msg",
      payload: { type: "item_completed", item: { type: "Plan", id: "turn:plan-plan", text: "# Ship the change" } }
    });
    const implement = JSON.stringify({
      timestamp: "2026-07-12T05:32:00.000Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Implement the plan." }]
      }
    });

    expect(inspectCodexCliPlanState(plan, { status: "COMPLETED", turnId: "turn:plan" })?.status).toBe("READY");
    expect(inspectCodexCliPlanState(`${plan}\n${implement}`, { status: "RUNNING", turnId: "turn:implementation" })?.status).toBe("RUNNING");
    expect(inspectCodexCliPlanState(`${plan}\n${implement}`, { status: "COMPLETED", turnId: "turn:implementation" })?.status).toBe("COMPLETED");
    expect(inspectCodexCliPlanState(`${plan}\n${implement}`, { status: "ABORTED", turnId: "turn:implementation" })?.status).toBe("PAUSED_BY_ROOM_AGENT");
  });

  it("reports the latest Codex turn as running after earlier turns completed", () => {
    const activity = inspectCurrentCodexCliTurnActivity(
      [
        JSON.stringify({ type: "turn_context", payload: { turn_id: "turn:completed" } }),
        JSON.stringify({ type: "event_msg", payload: { type: "task_complete", turn_id: "turn:completed" } }),
        JSON.stringify({ type: "turn_context", payload: { turn_id: "turn:running" } }),
        JSON.stringify({ type: "event_msg", payload: { type: "task_started", turn_id: "turn:running" } })
      ].join("\n")
    );

    expect(activity).toEqual({ status: "RUNNING", turnId: "turn:running" });
  });

  it("recognizes a completed tail even when its turn context is outside the read window", () => {
    const activity = inspectCurrentCodexCliTurnActivity(
      JSON.stringify({ type: "event_msg", payload: { type: "task_complete", turn_id: "turn:tail" } })
    );

    expect(activity).toEqual({ status: "COMPLETED", turnId: "turn:tail" });
  });

  it("tracks only the Codex turn started after a floating terminal submit marker", () => {
    const markerAtMs = Date.parse("2026-07-11T10:00:00.000Z");
    const running = inspectCodexCliTurnActivity(
      [
        JSON.stringify({
          type: "turn_context",
          timestamp: "2026-07-11T09:59:58.000Z",
          payload: { turn_id: "turn:previous", cwd: "/etc" }
        }),
        JSON.stringify({
          type: "event_msg",
          timestamp: "2026-07-11T09:59:59.000Z",
          payload: { type: "task_complete", turn_id: "turn:previous", completed_at: 1783763999 }
        }),
        JSON.stringify({
          type: "turn_context",
          timestamp: "2026-07-11T10:00:01.000Z",
          payload: { turn_id: "turn:current", cwd: "/etc" }
        }),
        JSON.stringify({
          type: "event_msg",
          timestamp: "2026-07-11T10:00:02.000Z",
          payload: { type: "user_message", turn_id: "turn:current" }
        })
      ].join("\n"),
      { markerAtMs }
    );

    expect(running).toEqual({ status: "RUNNING", turnId: "turn:current" });

    const completed = inspectCodexCliTurnActivity(
      [
        JSON.stringify({
          type: "turn_context",
          timestamp: "2026-07-11T10:00:01.000Z",
          payload: { turn_id: "turn:current", cwd: "/etc" }
        }),
        JSON.stringify({
          type: "event_msg",
          timestamp: "2026-07-11T10:00:02.000Z",
          payload: { type: "user_message", turn_id: "turn:current" }
        }),
        JSON.stringify({
          type: "event_msg",
          timestamp: "2026-07-11T10:00:04.000Z",
          payload: { type: "task_complete", turn_id: "turn:current", completed_at: 1783764004 }
        })
      ].join("\n"),
      { markerAtMs, turnId: "turn:current" }
    );

    expect(completed).toEqual({ status: "COMPLETED", turnId: "turn:current" });

    const aborted = inspectCodexCliTurnActivity(
      [
        JSON.stringify({
          type: "turn_context",
          timestamp: "2026-07-11T10:00:01.000Z",
          payload: { turn_id: "turn:current", cwd: "/etc" }
        }),
        JSON.stringify({
          type: "event_msg",
          timestamp: "2026-07-11T10:00:03.000Z",
          payload: { type: "turn_aborted", turn_id: "turn:current" }
        })
      ].join("\n"),
      { markerAtMs, turnId: "turn:current" }
    );

    expect(aborted).toEqual({ status: "ABORTED", turnId: "turn:current" });
  });

  it("keeps a marked Room Agent task running across an attachment seed and automatic Goal continuation", () => {
    const markerAtMs = Date.parse("2026-08-10T04:40:14.000Z");
    const content = [
      JSON.stringify({
        type: "turn_context",
        timestamp: "2026-08-10T04:40:15.000Z",
        payload: { turn_id: "turn:attachment-seed" }
      }),
      JSON.stringify({
        type: "event_msg",
        timestamp: "2026-08-10T04:40:15.100Z",
        payload: { type: "user_message", turn_id: "turn:attachment-seed" }
      }),
      JSON.stringify({
        type: "event_msg",
        timestamp: "2026-08-10T04:40:18.222Z",
        payload: {
          type: "task_complete",
          turn_id: "turn:attachment-seed",
          last_agent_message: "The attachments are ready."
        }
      }),
      JSON.stringify({
        type: "event_msg",
        timestamp: "2026-08-10T04:40:18.226Z",
        payload: { type: "thread_goal_updated", goal: { status: "active" } }
      }),
      JSON.stringify({
        type: "turn_context",
        timestamp: "2026-08-10T04:40:18.230Z",
        payload: { turn_id: "turn:goal-continuation" }
      }),
      JSON.stringify({
        type: "event_msg",
        timestamp: "2026-08-10T04:40:18.232Z",
        payload: { type: "task_started", turn_id: "turn:goal-continuation" }
      })
    ].join("\n");

    expect(inspectCodexCliTurnActivity(content, { markerAtMs })).toEqual({
      status: "RUNNING",
      turnId: "turn:goal-continuation"
    });
    expect(inspectCurrentCodexCliTurnActivity(content)).toEqual({
      status: "RUNNING",
      turnId: "turn:goal-continuation"
    });
  });

  it("completes a marked Room Agent task only after its Goal reaches a terminal status", () => {
    const markerAtMs = Date.parse("2026-08-10T04:40:14.000Z");
    const records = [
      { type: "turn_context", timestamp: "2026-08-10T04:40:15.000Z", payload: { turn_id: "turn:seed" } },
      { type: "event_msg", timestamp: "2026-08-10T04:40:15.100Z", payload: { type: "user_message", turn_id: "turn:seed" } },
      { type: "event_msg", timestamp: "2026-08-10T04:40:18.000Z", payload: { type: "task_complete", turn_id: "turn:seed", last_agent_message: "The attachments are ready." } },
      { type: "event_msg", timestamp: "2026-08-10T04:40:18.100Z", payload: { type: "thread_goal_updated", goal: { status: "active" } } },
      { type: "turn_context", timestamp: "2026-08-10T04:40:18.200Z", payload: { turn_id: "turn:goal" } },
      { type: "event_msg", timestamp: "2026-08-10T04:40:18.300Z", payload: { type: "task_started", turn_id: "turn:goal" } },
      { type: "event_msg", timestamp: "2026-08-10T04:41:00.000Z", payload: { type: "thread_goal_updated", goal: { status: "complete" } } },
      { type: "event_msg", timestamp: "2026-08-10T04:41:00.100Z", payload: { type: "task_complete", turn_id: "turn:goal", last_agent_message: "Finished." } }
    ];

    expect(inspectCodexCliTurnActivity(records.map((record) => JSON.stringify(record)).join("\n"), { markerAtMs })).toEqual({
      status: "COMPLETED",
      turnId: "turn:goal"
    });
  });

  it("requires the durable Room Agent input marker before attributing a recovered CLI turn", () => {
    const markerAtMs = Date.parse("2026-07-11T10:00:00.000Z");
    const content = [
      JSON.stringify({
        type: "turn_context",
        timestamp: "2026-07-11T10:00:01.000Z",
        payload: { turn_id: "turn:unrelated" }
      }),
      JSON.stringify({
        type: "event_msg",
        timestamp: "2026-07-11T10:00:02.000Z",
        payload: { type: "user_message", turn_id: "turn:unrelated", message: "unrelated operator input" }
      }),
      JSON.stringify({
        type: "turn_context",
        timestamp: "2026-07-11T10:00:03.000Z",
        payload: { turn_id: "turn:room-agent" }
      }),
      JSON.stringify({
        type: "event_msg",
        timestamp: "2026-07-11T10:00:04.000Z",
        payload: {
          type: "user_message",
          turn_id: "turn:room-agent",
          message: "Finish the pane.\n\nspace-room-action:7b2363fe-8d49-4eca-9ad9-6a56f2f73b9f"
        }
      })
    ].join("\n");

    expect(inspectCodexCliTurnActivity(content, {
      markerAtMs,
      inputMarker: "7b2363fe-8d49-4eca-9ad9-6a56f2f73b9f"
    })).toEqual({ status: "RUNNING", turnId: "turn:room-agent" });
    expect(inspectCodexCliTurnActivity(content, {
      markerAtMs,
      inputMarker: "00000000-0000-4000-8000-000000000000"
    })).toEqual({ status: "PENDING", turnId: null });
  });

  it("detects completed turns with no visible assistant message without copying transcript text", () => {
    const diagnostic = detectNullAgentMessageRollout(
      "/var/lib/spaceapp-user/.codex/sessions/2026/07/06/rollout-test.jsonl",
      [
        JSON.stringify({
          type: "session_meta",
          payload: {
            id: "019f36ae-0fa4-7373-8b14-89e9fb3a7181",
            cwd: "/etc"
          }
        }),
        JSON.stringify({
          type: "turn_context",
          payload: {
            turn_id: "019f36ae-78fe-7051-81c2-3576473e0e55",
            cwd: "/etc"
          }
        }),
        JSON.stringify({
          type: "event_msg",
          payload: {
            type: "task_complete",
            turn_id: "019f36ae-78fe-7051-81c2-3576473e0e55",
            last_agent_message: null,
            completed_at: 1783328850,
            duration_ms: 19143,
            transcript: "private text must not be copied"
          }
        })
      ].join("\n")
    );

    expect(diagnostic).toMatchObject({
      rolloutPath: "/var/lib/spaceapp-user/.codex/sessions/2026/07/06/rollout-test.jsonl",
      sessionId: "019f36ae-0fa4-7373-8b14-89e9fb3a7181",
      turnId: "019f36ae-78fe-7051-81c2-3576473e0e55",
      cwd: "/etc"
    });
    expect(diagnostic?.message).toContain("last_agent_message:null");
    expect(diagnostic?.message).not.toContain("private text");
  });

  it("ignores older null assistant messages when a since timestamp is provided", () => {
    const diagnostic = detectNullAgentMessageRollout(
      "/var/lib/spaceapp-user/.codex/sessions/2026/07/06/rollout-test.jsonl",
      [
        JSON.stringify({ type: "session_meta", payload: { id: "thread:test", cwd: "/etc" } }),
        JSON.stringify({
          type: "event_msg",
          payload: {
            type: "task_complete",
            turn_id: "turn:old",
            last_agent_message: null,
            completed_at: 1783330000
          }
        }),
        JSON.stringify({
          type: "event_msg",
          payload: {
            type: "task_complete",
            turn_id: "turn:new",
            last_agent_message: null,
            completed_at: 1783330500
          }
        })
      ].join("\n"),
      { sinceMs: 1783330200 * 1000 }
    );

    expect(diagnostic).toMatchObject({
      turnId: "turn:new"
    });
    expect(
      detectNullAgentMessageRollout(
        "/var/lib/spaceapp-user/.codex/sessions/2026/07/06/rollout-test.jsonl",
        [
          JSON.stringify({ type: "session_meta", payload: { id: "thread:test", cwd: "/etc" } }),
          JSON.stringify({
            type: "event_msg",
            payload: { type: "task_complete", turn_id: "turn:old", last_agent_message: null, completed_at: 1783330000 }
          })
        ].join("\n"),
        { sinceMs: 1783330200 * 1000 }
      )
    ).toBeNull();
  });

  it("finds only recent matching rollout diagnostics under the Codex home", async () => {
    const root = await mkdtemp(join(tmpdir(), "space-codex-rollouts-"));
    const day = join(root, "sessions", "2026", "07", "06");
    const rolloutPath = join(day, "rollout-test.jsonl");
    const unrelatedRolloutPath = join(day, "rollout-unrelated.jsonl");
    await mkdir(day, { recursive: true });
    await writeFile(
      unrelatedRolloutPath,
      [
        JSON.stringify({ type: "session_meta", payload: { id: "thread:other", cwd: "/etc" } }),
        JSON.stringify({
          type: "event_msg",
          payload: { type: "task_complete", turn_id: "turn:other", last_agent_message: null, completed_at: Date.now() / 1000 }
        })
      ].join("\n"),
      "utf8"
    );
    await writeFile(
      rolloutPath,
      [
        JSON.stringify({ type: "session_meta", payload: { id: "thread:test", cwd: "/etc" } }),
        JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "δες τα backup των τελευταιων 24 ωρων" } }),
        JSON.stringify({
          type: "event_msg",
          payload: { type: "task_complete", turn_id: "turn:test", last_agent_message: null, completed_at: Date.now() / 1000 }
        })
      ].join("\n"),
      "utf8"
    );

    await expect(
      findRecentNullAgentMessageDiagnostic({
        codexHome: root,
        threadId: "thread:test",
        cwd: "/etc",
        inputText: "δες τα backup των τελευταιων 24 ωρων",
        sinceMs: Date.now() - 10_000
      })
    ).resolves.toMatchObject({
      rolloutPath,
      sessionId: "thread:test",
      turnId: "turn:test",
      cwd: "/etc"
    });

    await expect(
      findRecentNullAgentMessageDiagnostic({
        codexHome: root,
        threadId: "thread:test",
        cwd: "/tmp/other",
        inputText: "δες τα backup των τελευταιων 24 ωρων",
        sinceMs: Date.now() - 10_000
      })
    ).resolves.toBeNull();

    await expect(
      findRecentNullAgentMessageDiagnostic({
        codexHome: root,
        threadId: "thread:test",
        cwd: "/etc",
        inputText: "unrelated prompt",
        sinceMs: Date.now() - 10_000
      })
    ).resolves.toBeNull();
  });

  it("does not surface a null assistant diagnostic from another Codex thread", async () => {
    const root = await mkdtemp(join(tmpdir(), "space-codex-rollout-thread-scope-"));
    const day = join(root, "sessions", "2026", "07", "25");
    const currentRolloutPath = join(day, "rollout-current.jsonl");
    const foreignRolloutPath = join(day, "rollout-foreign.jsonl");
    const now = Date.now();
    await mkdir(day, { recursive: true });
    await writeFile(
      currentRolloutPath,
      [
        JSON.stringify({ type: "session_meta", payload: { id: "thread:current", cwd: "/etc" } }),
        JSON.stringify({
          type: "event_msg",
          payload: { type: "task_complete", turn_id: "turn:current", last_agent_message: null, completed_at: now / 1000 }
        })
      ].join("\n"),
      "utf8"
    );
    await writeFile(
      foreignRolloutPath,
      [
        JSON.stringify({ type: "session_meta", payload: { id: "thread:foreign", cwd: "/etc" } }),
        JSON.stringify({
          type: "event_msg",
          payload: { type: "task_complete", turn_id: "turn:foreign", last_agent_message: null, completed_at: now / 1000 }
        })
      ].join("\n"),
      "utf8"
    );
    await utimes(currentRolloutPath, new Date(now - 1_000), new Date(now - 1_000));
    await utimes(foreignRolloutPath, new Date(now), new Date(now));

    await expect(
      findRecentNullAgentMessageDiagnostic({
        codexHome: root,
        threadId: "thread:current",
        cwd: "/etc",
        sinceMs: now - 10_000
      })
    ).resolves.toMatchObject({
      rolloutPath: currentRolloutPath,
      sessionId: "thread:current",
      turnId: "turn:current"
    });
  });

  it("returns activity only from the marked Codex CLI thread", async () => {
    const root = await mkdtemp(join(tmpdir(), "space-codex-turn-activity-"));
    const day = join(root, "sessions", "2026", "07", "11");
    const markerAtMs = Date.now() - 1_000;
    await mkdir(day, { recursive: true });
    await writeFile(
      join(day, "rollout-other.jsonl"),
      [
        JSON.stringify({ type: "session_meta", payload: { id: "thread:other", cwd: "/etc" } }),
        JSON.stringify({
          type: "turn_context",
          timestamp: new Date(markerAtMs + 100).toISOString(),
          payload: { turn_id: "turn:other" }
        })
      ].join("\n"),
      "utf8"
    );
    const currentRolloutPath = join(day, "rollout-current.jsonl");
    await writeFile(
      currentRolloutPath,
      [
        JSON.stringify({ type: "session_meta", payload: { id: "thread:current", cwd: "/etc" } }),
        JSON.stringify({
          type: "turn_context",
          timestamp: new Date(markerAtMs + 200).toISOString(),
          payload: { turn_id: "turn:current" }
        }),
        JSON.stringify({
          type: "event_msg",
          timestamp: new Date(markerAtMs + 300).toISOString(),
          payload: { type: "user_message", turn_id: "turn:current" }
        })
      ].join("\n"),
      "utf8"
    );
    const currentRolloutMtimeMs = (await stat(currentRolloutPath)).mtimeMs;

    await expect(
      findRecentCodexCliTurnActivity({
        codexHome: root,
        threadId: "thread:current",
        markerAtMs
      })
    ).resolves.toEqual({ status: "RUNNING", turnId: "turn:current", lastActivityAtMs: currentRolloutMtimeMs });
  });

  it("parses a rollout again only when its size or mtime changed", async () => {
    const codexHome = await mkdtemp(join(tmpdir(), "codex-rollout-cache-"));
    try {
      const rollout = join(codexHome, "rollout-cache.jsonl");
      const turn = (id: string) => `${JSON.stringify({ type: "turn_context", payload: { turn_id: id } })}\n`;
      execFileSync("sqlite3", [join(codexHome, "state_5.sqlite"),
        `create table threads(id text, rollout_path text); insert into threads values ('thread-a','${rollout}');`]);
      const fixedTime = new Date("2026-10-24T10:00:00.000Z");
      await writeFile(rollout, turn("t1"));
      await utimes(rollout, fixedTime, fixedTime);
      expect(await findCurrentCodexCliTurnActivity({ codexHome, threadId: "thread-a" })).toEqual({ status: "RUNNING", turnId: "t1" });
      expect(await findCodexCliPlanState({ codexHome, threadId: "thread-a" })).toBeNull();
      // Same size and mtime: the kept results come back without a read (and no state DB is asked again).
      await writeFile(rollout, turn("t9"));
      await utimes(rollout, fixedTime, fixedTime);
      await rm(join(codexHome, "state_5.sqlite"));
      expect(await findCurrentCodexCliTurnActivity({ codexHome, threadId: "thread-a" })).toEqual({ status: "RUNNING", turnId: "t1" });
      await appendFile(rollout, `${JSON.stringify({ type: "event_msg", payload: { type: "task_complete", turn_id: "t9" } })}\n`);
      expect(await findCurrentCodexCliTurnActivity({ codexHome, threadId: "thread-a" })).toEqual({ status: "COMPLETED", turnId: "t9" });
      expect(await findCodexCliPlanState({ codexHome, threadId: "thread-a" })).toBeNull();
    } finally {
      await rm(codexHome, { recursive: true, force: true });
    }
  });
});
