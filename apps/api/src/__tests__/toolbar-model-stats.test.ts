import { describe, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { chmod, mkdir, readdir, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  collectOpenCodeStatsFromRows,
  parseCodexRolloutStats,
  readOpenCodeModelRows,
  readCodexRolloutTail,
  resolveCodexRolloutPaths,
  resolveRecentCodexRollouts,
  runSqliteSnapshotFallback
} from "../toolbar-model-stats.js";

describe("collectOpenCodeStatsFromRows", () => {
  const nowMs = 1_800_000_000_000;

  function messageRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      messageId: "msg_001",
      modelID: "deepseek-v4-flash-free",
      providerID: "opencode",
      msgCreated: nowMs - 60_000,
      msgTokensIn: 100,
      msgTokensOut: 50,
      msgTokensReasoning: 10,
      partType: "text",
      partTime: nowMs - 60_000,
      ...overrides
    };
  }

  it("aggregates one turn with message tokens", () => {
    const rows = [
      messageRow({ partType: "step-start", partTime: nowMs - 60_000 }),
      messageRow({ partType: "text", partTime: nowMs - 59_000 }),
      messageRow({ partType: "step-finish", partTime: nowMs - 50_000 })
    ];
    const result = collectOpenCodeStatsFromRows(rows);
    const entry = [...result.values()][0];
    expect(entry).toBeDefined();
    expect(entry?.modelId).toBe("deepseek-v4-flash-free");
    expect(entry?.turns).toBe(1);
    expect(entry?.tokensIn).toBe(100);
    expect(entry?.tokensOut).toBe(50);
    expect(entry?.tokensReasoning).toBe(10);
    expect(entry?.avgDurationMs).toBe(10_000);
    expect(entry?.avgTtftMs).toBeNull();
    expect(entry?.avgTokPerSec).toBe(5);
  });

  it("counts message tokens once even with many parts", () => {
    const rows = [
      messageRow({ partType: "step-start", partTime: nowMs - 60_000 }),
      messageRow({ partType: "reasoning", partTime: nowMs - 59_500 }),
      messageRow({ partType: "text", partTime: nowMs - 59_000 }),
      messageRow({ partType: "tool", partTime: nowMs - 58_000 }),
      messageRow({ partType: "step-finish", partTime: nowMs - 50_000 })
    ];
    const result = collectOpenCodeStatsFromRows(rows);
    const entry = [...result.values()][0];
    expect(entry?.tokensOut).toBe(50);
    expect(entry?.avgDurationMs).toBe(10_000);
  });

  it("counts distinct messages and averages their duration", () => {
    const rows = [
      messageRow({ messageId: "msg_001", partType: "step-start", partTime: nowMs - 60_000 }),
      messageRow({ messageId: "msg_001", partType: "step-finish", partTime: nowMs - 50_000 }),
      messageRow({ messageId: "msg_002", msgTokensOut: 70, partType: "step-start", partTime: nowMs - 40_000 }),
      messageRow({ messageId: "msg_002", msgTokensOut: 70, partType: "step-finish", partTime: nowMs - 20_000 })
    ];
    const entry = [...collectOpenCodeStatsFromRows(rows).values()][0];
    expect(entry?.turns).toBe(2);
    expect(entry?.tokensOut).toBe(120);
    expect(entry?.avgDurationMs).toBe(15_000);
    expect(entry?.avgTokPerSec).toBe(4);
  });

  it("separates models by model id", () => {
    const rows = [
      messageRow({ messageId: "msg_001", modelID: "deepseek-v4-flash-free" }),
      messageRow({ messageId: "msg_002", modelID: "kimi-k3", providerID: "legacy", msgTokensOut: 25 })
    ];
    const result = collectOpenCodeStatsFromRows(rows);
    expect(result.size).toBe(2);
  });

  it("drops turns with zero tokens and zero duration", () => {
    const rows = [messageRow({ msgTokensIn: 0, msgTokensOut: 0, msgTokensReasoning: 0 })];
    const result = collectOpenCodeStatsFromRows(rows);
    expect(result.size).toBe(0);
  });
});

describe("parseCodexRolloutStats", () => {
  const now = () => new Date(1_800_000_000_000);
  const modelKey = "codex\u0000gpt-5.6-sol";

  function turnContext(turnId: string, model?: string): string {
    return JSON.stringify({ type: "turn_context", payload: { turn_id: turnId, ...(model ? { model } : {}) } });
  }

  function taskComplete(turnId: string, completedAtSec: number, durationMs: number, ttftMs: number): string {
    return JSON.stringify({
      type: "event_msg",
      payload: {
        type: "task_complete",
        turn_id: turnId,
        completed_at: completedAtSec,
        duration_ms: durationMs,
        time_to_first_token_ms: ttftMs
      }
    });
  }

  function tokenCount(turnId: string, tokensIn: number, tokensOut: number): string {
    return JSON.stringify({
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          last_token_usage: {
            input_tokens: tokensIn,
            output_tokens: tokensOut,
            reasoning_output_tokens: 7
          }
        }
      }
    });
  }

  it("aggregates turns inside the window with ttft and tok/s", () => {
    const content = [
      turnContext("turn_1", "gpt-5.6-sol"),
      tokenCount("turn_1", 4000, 800),
      taskComplete("turn_1", 1_800_000_000 - 60, 20_000, 1_500),
      turnContext("turn_2", "gpt-5.6-sol"),
      tokenCount("turn_2", 4000, 1200),
      taskComplete("turn_2", 1_800_000_000 - 30, 25_000, 2_000)
    ].join("\n");
    const result = parseCodexRolloutStats(content, 10, now);
    const entry = result.get(modelKey);
    expect(entry).toBeDefined();
    expect(entry?.turns).toBe(2);
    expect(entry?.avgTtftMs).toBe(1_750);
    expect(entry?.avgDurationMs).toBe(22_500);
    expect(entry?.tokensIn).toBe(8_000);
    expect(entry?.tokensOut).toBe(2_000);
    expect(entry?.tokensReasoning).toBe(14);
    expect(entry?.avgTokPerSec).toBe(44.4);
  });

  it("keeps the final task_complete of a turn", () => {
    const content = [
      turnContext("turn_1", "gpt-5.6-sol"),
      taskComplete("turn_1", 1_800_000_000 - 60, 10_000, 900),
      taskComplete("turn_1", 1_800_000_000 - 30, 22_000, 1_400)
    ].join("\n");
    const result = parseCodexRolloutStats(content, 10, now);
    expect(result.get(modelKey)?.avgDurationMs).toBe(22_000);
    expect(result.get(modelKey)?.avgTtftMs).toBe(1_400);
  });

  it("excludes turns outside the window", () => {
    const content = [
      turnContext("turn_1", "gpt-5.6-sol"),
      taskComplete("turn_1", 1_700_000_000, 10_000, 900)
    ].join("\n");
    const result = parseCodexRolloutStats(content, 10, now);
    expect(result.size).toBe(0);
  });

  it("skips turns without a model", () => {
    const content = [
      turnContext("turn_1"),
      taskComplete("turn_1", 1_800_000_000 - 30, 10_000, 900)
    ].join("\n");
    const result = parseCodexRolloutStats(content, 10, now);
    expect(result.size).toBe(0);
  });

  it("shows an active turn immediately and uses the native provider", () => {
    const content = [
      JSON.stringify({
        timestamp: "2027-01-15T07:59:55.000Z",
        type: "session_meta",
        payload: { model_provider: "codex-lb" }
      }),
      turnContext("turn_active", "gpt-5.6-sol"),
      JSON.stringify({
        timestamp: "2027-01-15T07:59:58.000Z",
        type: "event_msg",
        payload: { type: "task_started", turn_id: "turn_active" }
      }),
      tokenCount("turn_active", 250, 25)
    ].join("\n");
    const entry = parseCodexRolloutStats(content, 10, now).get("codex-lb\u0000gpt-5.6-sol");
    expect(entry?.providerId).toBe("codex-lb");
    expect(entry?.turns).toBe(1);
    expect(entry?.tokensIn).toBe(250);
  });

  it("counts aborted turns using the top-level ISO timestamp", () => {
    const content = [
      turnContext("turn_aborted", "gpt-5.6-sol"),
      JSON.stringify({
        timestamp: "2027-01-15T07:59:50.000Z",
        type: "event_msg",
        payload: { type: "task_started", turn_id: "turn_aborted" }
      }),
      JSON.stringify({
        timestamp: "2027-01-15T07:59:59.000Z",
        type: "event_msg",
        payload: { type: "turn_aborted", turn_id: "turn_aborted" }
      })
    ].join("\n");
    const entry = parseCodexRolloutStats(content, 10, now).get(modelKey);
    expect(entry?.turns).toBe(1);
    expect(entry?.avgDurationMs).toBe(9_000);
  });
});

describe("runSqliteSnapshotFallback", () => {
  const execFileAsync = promisify(execFile);

  it("removes the temporary snapshot directory after use", async () => {
    const root = mkdtempSync(join(tmpdir(), "model-stats-leak-test-"));
    const dbPath = join(root, "state_5.sqlite");
    try {
      await execFileAsync("sqlite3", [dbPath, "create table t (v text); insert into t values ('x');"]);
      const dirsBefore = (await readdir(tmpdir())).filter((name) => name.startsWith("space-model-stats-"));
      const rows = await runSqliteSnapshotFallback<{ v?: unknown }>(dbPath, "select v from t;");
      expect(rows).toEqual([{ v: "x" }]);
      const dirsAfter = (await readdir(tmpdir())).filter((name) => name.startsWith("space-model-stats-"));
      expect(dirsAfter).toEqual(dirsBefore);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("batched Codex rollout resolution", () => {
  it("preserves primary precedence, deduplicates IDs and finds missing threads in per-home databases", async () => {
    const root = mkdtempSync(join(tmpdir(), "model-stats-batch-test-"));
    const execFileAsync = promisify(execFile);
    try {
      const alternate = join(root, "space-codex-homes", "alternate");
      await mkdir(alternate, { recursive: true });
      await execFileAsync("sqlite3", [join(root, "state_5.sqlite"),
        "create table threads(id text, rollout_path text); insert into threads values ('a','/primary/a'),('b','/primary/b');"]);
      await execFileAsync("sqlite3", [join(alternate, "state_5.sqlite"),
        "create table threads(id text, rollout_path text); insert into threads values ('a','/alternate/a'),('c','/alternate/c');"]);
      expect(await resolveCodexRolloutPaths(["a", "b", "a"], root)).toEqual(new Map([
        ["a", "/primary/a"], ["b", "/primary/b"]
      ]));
      expect(await resolveCodexRolloutPaths(["a", "c", "missing"], root)).toEqual(new Map([
        ["a", "/primary/a"], ["c", "/alternate/c"]
      ]));
      expect(await resolveCodexRolloutPaths([], root)).toEqual(new Map());
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("Codex rollout lookup caches", () => {
  const execFileAsync = promisify(execFile);

  it("keeps found paths and misses, and looks a missing thread up again only after five minutes", async () => {
    const root = mkdtempSync(join(tmpdir(), "model-stats-cache-test-"));
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const db = join(root, "state_5.sqlite");
      await execFileAsync("sqlite3", [db, "create table threads(id text, rollout_path text); insert into threads values ('a','/primary/a');"]);
      expect(await resolveCodexRolloutPaths(["a", "late"], root)).toEqual(new Map([["a", "/primary/a"]]));
      await execFileAsync("sqlite3", [db, "insert into threads values ('late','/primary/late');"]);
      expect(await resolveCodexRolloutPaths(["a", "late"], root)).toEqual(new Map([["a", "/primary/a"]]));
      vi.setSystemTime(Date.now() + 5 * 60_000);
      expect(await resolveCodexRolloutPaths(["a", "late"], root)).toEqual(new Map([["a", "/primary/a"], ["late", "/primary/late"]]));
    } finally {
      vi.useRealTimers();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("asks a state DB again only when its files changed, and serves later windows from the kept rows", async () => {
    const root = mkdtempSync(join(tmpdir(), "model-stats-recent-test-"));
    const db = join(root, "state_5.sqlite");
    const nowSec = Math.floor(Date.now() / 1000);
    try {
      await execFileAsync("sqlite3", [db, `create table threads(id text, rollout_path text, updated_at integer); insert into threads values ('new','/r/new',${nowSec - 10}),('old','/r/old',${nowSec - 300});`]);
      expect(await resolveRecentCodexRollouts((nowSec - 600) * 1000, root)).toEqual([
        { threadId: "new", rolloutPath: "/r/new" }, { threadId: "old", rolloutPath: "/r/old" }
      ]);
      // An unreadable DB proves the next answers come from the kept rows: a query would now fail.
      await chmod(db, 0o000);
      expect(await resolveRecentCodexRollouts((nowSec - 600) * 1000, root)).toHaveLength(2);
      expect(await resolveRecentCodexRollouts((nowSec - 60) * 1000, root)).toEqual([{ threadId: "new", rolloutPath: "/r/new" }]);
      await utimes(db, nowSec, nowSec + 5);
      expect(await resolveRecentCodexRollouts((nowSec - 600) * 1000, root)).toEqual([]);
    } finally {
      await chmod(db, 0o644).catch(() => undefined);
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("readCodexRolloutTail", () => {
  it("keeps the session_meta line of a rollout too large to read whole, so its provider is known", async () => {
    const root = mkdtempSync(join(tmpdir(), "space-rollout-tail-"));
    try {
      const path = join(root, "rollout.jsonl");
      const meta = JSON.stringify({ type: "session_meta", payload: { id: "s1", model_provider: "space-gateway" } });
      const filler = `${JSON.stringify({ type: "response_item", payload: { text: "x".repeat(1000) } })}\n`.repeat(9000);
      await writeFile(path, `${meta}\n${filler}${JSON.stringify({ type: "event_msg", payload: { type: "token_count" } })}\n`);
      const tail = await readCodexRolloutTail(path);
      expect(tail.startsWith(`${meta}\n`)).toBe(true);
      expect(tail.length).toBeLessThan(8 * 1024 * 1024 + meta.length + 2);
      expect(tail.trimEnd().endsWith('"token_count"}}')).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("readOpenCodeModelRows on an OpenCode 2 store", () => {
  it("turns each v2 step message into step-start, first output and step-finish rows", async () => {
    const execFileAsync = promisify(execFile);
    const root = mkdtempSync(join(tmpdir(), "space-opencode2-stats-"));
    const dbPath = join(root, "opencode.db");
    // Message shape recorded from OpenCode 2.0.31 (2026-10-16).
    const data = JSON.stringify({ type: "assistant", time: { created: 1_000, streamed: 4_000, completed: 5_000 },
      model: { id: "big-pickle", providerID: "opencode", variant: "default" },
      content: [{ type: "reasoning", text: "r", time: { created: 2_500, completed: 3_000 } }, { type: "text", text: "Done." }],
      tokens: { input: 60, output: 10, reasoning: 40, cache: { read: 0, write: 0 } } });
    try {
      await execFileAsync("sqlite3", [dbPath, [
        "create table session_v2 (id text primary key);",
        "create table session_message (id text primary key, session_id text, type text, seq integer, time_created integer, time_updated integer, data text);",
        `insert into session_message values ('msg_a', 'ses_v2stats', 'assistant', 1, 1000, 5000, '${data}');`,
        `insert into session_message values ('msg_u', 'ses_v2stats', 'user', 0, 900, 900, '{"type":"user","text":"hi"}');`
      ].join(" ")]);
      const rows = await readOpenCodeModelRows({ nativeSessionIds: ["ses_v2stats"], windowMinutes: 60, now: () => new Date(6_000), stateRoot: root, dbPath });
      expect(rows.map((row) => [row.partType, row.partTime])).toEqual([["step-start", 1_000], ["text", 2_500], ["step-finish", 5_000]]);
      expect([...collectOpenCodeStatsFromRows(rows).values()]).toEqual([expect.objectContaining({
        modelId: "big-pickle", providerId: "opencode", turns: 1, avgDurationMs: 4_000, tokensIn: 60, tokensOut: 10, tokensReasoning: 40
      })]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
