import { describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  collectOpenCodeStatsFromRows,
  parseCodexRolloutStats,
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
