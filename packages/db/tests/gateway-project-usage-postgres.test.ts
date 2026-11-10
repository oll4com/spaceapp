import { expect, it } from "vitest";
import { disposablePostgresUnavailableReason, startDisposablePostgres } from "./support/disposable-postgres.js";
import { loadMigrations } from "../src/migrations.js";
import { InMemoryGatewayRepository, PostgresGatewayRepository, type GatewayRequestLogInsert } from "../src/gateway-repository.js";

// Token usage by process (operator 5/11 17:26 BKK, plan clipboard:qH5emwVaV6yO): Postgres and its in-memory twin give the same day and minute rows.
const row = (requestId: string, requestedAt: string, project: string | null, extra: Partial<GatewayRequestLogInsert> = {}): GatewayRequestLogInsert => ({
  requestId, requestedAt, provider: "CLAUDE", accountId: null, apiKeyId: null, model: "claude-opus-5-5", reasoningEffort: null, serviceTier: null, transport: "http",
  status: "success", errorCode: null, latencyMs: 1, firstTokenMs: null, inputTokens: 1000, cachedInputTokens: 900, outputTokens: 10, reasoningTokens: null, costUsd: 0.25,
  compressionTokensSaved: null, stickyKind: null, stickyKeyHash: null, cacheCreationTokens: 50, clientName: "Claude Code", project, ...extra });

it.skipIf(disposablePostgresUnavailableReason() !== null)("groups request logs by owner-zone day, project, provider and account, and one project by UTC minute", async () => {
  const server = await startDisposablePostgres("gateway-project-usage");
  const pool = server.pool("postgres", 4);
  try {
    for (const item of await loadMigrations()) await pool.query(item.sql);
    const rows = [
      row("a", "2030-01-01T17:30:10.000Z", "pane:p1"), // 00:30 on 2 Jan in Bangkok
      row("b", "2030-01-01T16:30:00.000Z", "pane:p1"), // 23:30 on 1 Jan in Bangkok
      row("c", "2030-01-01T17:30:50.000Z", "nous", { provider: "ANTIGRAVITY", cacheCreationTokens: null, cachedInputTokens: null, costUsd: null }),
      row("d", "2030-01-01T17:31:05.000Z", "nous"),
      row("e", "2030-01-01T17:32:00.000Z", null), // untagged: by its client (a keyed row would read "key:<id>")
      row("f", "2030-01-01T17:32:30.000Z", null, { clientName: null }),
      row("w", "2030-01-01T17:33:00.000Z", "pane:p1", { source: "limit_warmup" }),
      // Untagged requests of a session that later ran under one pane tag count as that pane; a session seen under two panes stays untagged.
      row("g", "2030-01-01T17:34:00.000Z", null, { stickyKeyHash: "aaaaaaaaaaaaaaaa" }),
      row("h", "2030-01-03T00:00:00.000Z", "pane:p2", { stickyKeyHash: "aaaaaaaaaaaaaaaa" }),
      row("i", "2030-01-01T17:35:00.000Z", null, { stickyKeyHash: "bbbbbbbbbbbbbbbb" }),
      row("j", "2030-01-03T00:00:00.000Z", "pane:p1", { stickyKeyHash: "bbbbbbbbbbbbbbbb" }),
      row("k", "2030-01-03T00:00:00.000Z", "pane:p3", { stickyKeyHash: "bbbbbbbbbbbbbbbb" })
    ];
    const repository = new PostgresGatewayRepository(pool);
    const twin = new InMemoryGatewayRepository();
    await repository.insertRequestLogs(rows);
    await twin.insertRequestLogs(rows);
    const sorted = <T extends { day: string; project: string; provider: string }>(list: T[]) =>
      [...list].sort((left, right) => `${left.day}${left.project}${left.provider}`.localeCompare(`${right.day}${right.project}${right.provider}`));
    const days = sorted(await repository.projectUsage("2030-01-01T00:00:00.000Z", "2030-01-02T00:00:00.000Z", "Asia/Bangkok"));
    expect(days).toEqual(sorted(await twin.projectUsage("2030-01-01T00:00:00.000Z", "2030-01-02T00:00:00.000Z", "Asia/Bangkok")));
    expect(days).toEqual([
      { day: "2030-01-01", project: "pane:p1", provider: "CLAUDE", accountId: "", model: "claude-opus-5-5", requests: 1, inputTokens: 1000, cachedInputTokens: 900, cacheCreationTokens: 50, outputTokens: 10, costUsd: 0.25 },
      { day: "2030-01-02", project: "", provider: "CLAUDE", accountId: "", model: "claude-opus-5-5", requests: 1, inputTokens: 1000, cachedInputTokens: 900, cacheCreationTokens: 50, outputTokens: 10, costUsd: 0.25 },
      { day: "2030-01-02", project: "client:Claude Code", provider: "CLAUDE", accountId: "", model: "claude-opus-5-5", requests: 2, inputTokens: 2000, cachedInputTokens: 1800, cacheCreationTokens: 100, outputTokens: 20, costUsd: 0.5 },
      { day: "2030-01-02", project: "nous", provider: "ANTIGRAVITY", accountId: "", model: "claude-opus-5-5", requests: 1, inputTokens: 1000, cachedInputTokens: 0, cacheCreationTokens: 0, outputTokens: 10, costUsd: 0 },
      { day: "2030-01-02", project: "nous", provider: "CLAUDE", accountId: "", model: "claude-opus-5-5", requests: 1, inputTokens: 1000, cachedInputTokens: 900, cacheCreationTokens: 50, outputTokens: 10, costUsd: 0.25 },
      { day: "2030-01-02", project: "pane:p1", provider: "CLAUDE", accountId: "", model: "claude-opus-5-5", requests: 1, inputTokens: 1000, cachedInputTokens: 900, cacheCreationTokens: 50, outputTokens: 10, costUsd: 0.25 },
      { day: "2030-01-02", project: "pane:p2", provider: "CLAUDE", accountId: "", model: "claude-opus-5-5", requests: 1, inputTokens: 1000, cachedInputTokens: 900, cacheCreationTokens: 50, outputTokens: 10, costUsd: 0.25 }]);
    const minutes = sorted(await repository.projectUsage("2030-01-01T00:00:00.000Z", "2030-01-02T00:00:00.000Z", "Asia/Bangkok", "nous"));
    expect(minutes).toEqual(sorted(await twin.projectUsage("2030-01-01T00:00:00.000Z", "2030-01-02T00:00:00.000Z", "Asia/Bangkok", "nous")));
    expect(minutes.map(({ day, provider }) => [day, provider])).toEqual([["2030-01-01T17:30", "ANTIGRAVITY"], ["2030-01-01T17:31", "CLAUDE"]]);
  } finally {
    await server.stop();
  }
}, 180_000);
