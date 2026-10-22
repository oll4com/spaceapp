import { rollbackKeepingError } from "./rollback.js";
import { createSpacePgPool, type PgPoolLike } from "./space-store.js";
import type { SystemAnalyticsBackfill, SystemAnalyticsCoverage } from "@space/contracts";

export type SystemAnalyticsModelEventStatus = "RUNNING" | "COMPLETED" | "ABORTED" | "SESSION";
export type SystemAnalyticsResourceEntityType = "HOST" | "CLI_SESSION" | "SHARED_RUNTIME";

export type SystemAnalyticsRoute = "GATEWAY" | "DIRECT";

export interface SystemAnalyticsModelEventRecord {
  eventKey: string;
  source: "codex" | "opencode" | "session" | "claude" | "gateway";
  runtimeId: string;
  providerId: string;
  modelId: string;
  roomId: string | null;
  paneId: string | null;
  sessionId: string | null;
  turnId: string | null;
  status: SystemAnalyticsModelEventStatus;
  coverage: SystemAnalyticsCoverage;
  turnCount: number;
  startedAt: string;
  endedAt: string | null;
  tokensIn: number | null;
  tokensOut: number | null;
  tokensReasoning: number | null;
  ttftMs: number | null;
  durationMs: number | null;
  updatedAt: string;
  /** Through Space Gateway or direct; null for events stored before routes existed (they count as before). */
  route?: SystemAnalyticsRoute | null;
  /** A Space Gateway account id, or `cli:<runtime>/<profile>` for a direct account the gateway does not hold. */
  accountKey?: string | null;
  /** What the tokens would cost on the provider's API; null when the model has no price. */
  costUsd?: number | null;
  tokensCacheRead?: number | null;
  tokensCacheWrite?: number | null;
}

/** Fields a later read may not know (a re-read without the route keeps the stored one). */
const keptModelEventFields = ["route", "accountKey", "costUsd", "tokensCacheRead", "tokensCacheWrite"] as const;

/**
 * Model events of a window summed per everything the Token usage page splits them by, so the API never holds every
 * event (stable 2026-10-19: 293k rows for 30 days). Only visible events: not root, RUNNING only in a live session, and
 * each CLI turn once. Seqs are positions in the listing order the page always used: transcript, gateway and session
 * events by start, then each CLI turn where it first appeared. Groups come in order of their first event.
 */
export interface SystemAnalyticsModelEventGroup {
  /** The gateway's copy of a gateway call, or a transcript's copy of a direct one: each token once. */
  counted: boolean;
  gateway: boolean;
  runtimeId: string;
  providerId: string;
  modelId: string;
  status: SystemAnalyticsModelEventStatus;
  coverage: SystemAnalyticsCoverage;
  accountKey: string | null;
  /** tokensIn + tokensOut > 0 */
  hasTokens: boolean;
  liveSessionId: string | null;
  /** Start (epoch ms) of the `bucketMs` bucket the events ended in (started in, while running). */
  bucketAtMs: number;
  /** Sum of turnCount; unpriced turns, TTFT and duration weigh each event at least 1. */
  turns: number;
  unpricedTurns: number;
  tokensIn: number | null;
  tokensOut: number | null;
  tokensReasoning: number | null;
  costUsd: number | null;
  ttftSum: number;
  ttftWeight: number;
  durationSum: number;
  durationWeight: number;
  tokensCacheRead: number;
  tokensCacheWrite: number;
  /** Input minus cache reads and writes, at least 0 per event. */
  freshInput: number;
  firstAt: string;
  lastAt: string;
  firstSeq: number;
  lastSeq: number;
}

export interface SystemAnalyticsModelEventSummaryInput {
  since: string;
  liveSessionIds: readonly string[];
  bucketMs: number;
}

/**
 * A CLI turn read again after its pane closed is stored under the global key next to its old pane-keyed copy: count
 * each turn once, preferring the copy that knows its route, then the fullest. Gateway requests and Claude messages have
 * unique keys. The SQL in PostgresSystemAnalyticsRepository.summarizeModelEvents does the same.
 */
export function summarizeModelEventRecords(events: SystemAnalyticsModelEventRecord[], input: SystemAnalyticsModelEventSummaryInput): SystemAnalyticsModelEventGroup[] {
  const live = new Set(input.liveSessionIds);
  const kept: SystemAnalyticsModelEventRecord[] = [];
  const byTurn = new Map<string, SystemAnalyticsModelEventRecord>();
  const total = (event: SystemAnalyticsModelEventRecord) => (event.tokensIn ?? 0) + (event.tokensOut ?? 0);
  for (const event of events) {
    if (event.providerId === "root" || event.runtimeId === "cli:root" || (event.status === "RUNNING" && !(event.sessionId && live.has(event.sessionId)))) continue;
    if (event.source === "gateway" || event.source === "claude" || event.source === "session" || !event.turnId) { kept.push(event); continue; }
    const key = `${event.source}\u0000${event.runtimeId}\u0000${event.turnId}`;
    const other = byTurn.get(key);
    if (!other || (!other.route && event.route) || (Boolean(other.route) === Boolean(event.route) && total(event) > total(other))) byTurn.set(key, event);
  }
  const groups = new Map<string, SystemAnalyticsModelEventGroup>();
  [...kept, ...byTurn.values()].forEach((event, seq) => {
    const counted = event.source === "gateway" || event.route !== "GATEWAY";
    const liveSessionId = event.sessionId && live.has(event.sessionId) ? event.sessionId : null;
    const bucketAtMs = Math.floor(Date.parse(event.endedAt ?? event.startedAt) / input.bucketMs) * input.bucketMs;
    const groupKey = JSON.stringify([counted, event.source === "gateway", event.runtimeId, event.providerId, event.modelId, event.status,
      event.coverage, event.accountKey ?? null, total(event) > 0, liveSessionId, bucketAtMs]);
    const group = groups.get(groupKey) ?? {
      counted, gateway: event.source === "gateway", runtimeId: event.runtimeId, providerId: event.providerId, modelId: event.modelId,
      status: event.status, coverage: event.coverage, accountKey: event.accountKey ?? null, hasTokens: total(event) > 0, liveSessionId, bucketAtMs,
      turns: 0, unpricedTurns: 0, tokensIn: null, tokensOut: null, tokensReasoning: null, costUsd: null, ttftSum: 0, ttftWeight: 0,
      durationSum: 0, durationWeight: 0, tokensCacheRead: 0, tokensCacheWrite: 0, freshInput: 0,
      firstAt: event.startedAt, lastAt: event.endedAt ?? event.updatedAt ?? event.startedAt, firstSeq: seq, lastSeq: seq
    };
    const weight = Math.max(event.turnCount, 1);
    const add = (sum: number | null, value: number | null | undefined) => value === null || value === undefined ? sum : (sum ?? 0) + value;
    group.turns += Math.max(event.turnCount, 0);
    if (event.costUsd === null || event.costUsd === undefined) { if (total(event) > 0) group.unpricedTurns += weight; }
    group.tokensIn = add(group.tokensIn, event.tokensIn);
    group.tokensOut = add(group.tokensOut, event.tokensOut);
    group.tokensReasoning = add(group.tokensReasoning, event.tokensReasoning);
    group.costUsd = add(group.costUsd, event.costUsd);
    if (event.ttftMs !== null) { group.ttftSum += event.ttftMs * weight; group.ttftWeight += weight; }
    if (event.durationMs !== null) { group.durationSum += event.durationMs * weight; group.durationWeight += weight; }
    const read = event.tokensCacheRead ?? 0;
    const write = event.tokensCacheWrite ?? 0;
    group.tokensCacheRead += read;
    group.tokensCacheWrite += write;
    group.freshInput += Math.max((event.tokensIn ?? 0) - read - write, 0);
    if (event.startedAt < group.firstAt) group.firstAt = event.startedAt;
    const lastAt = event.endedAt ?? event.updatedAt ?? event.startedAt;
    if (lastAt > group.lastAt) group.lastAt = lastAt;
    group.lastSeq = seq;
    groups.set(groupKey, group);
  });
  return [...groups.values()];
}

export interface SystemAnalyticsResourceSample {
  sampledAt: string;
  entityType: SystemAnalyticsResourceEntityType;
  entityId: string;
  roomId: string | null;
  roomName: string | null;
  paneId: string | null;
  paneTitle: string | null;
  sessionId: string | null;
  runtimeId: string | null;
  runtimeName: string | null;
  providerId: string | null;
  modelId: string | null;
  processCount: number;
  cpuOneCorePercent: number;
  rssBytes: number;
  memoryTotalBytes: number | null;
  memoryAvailableBytes: number | null;
  swapTotalBytes: number | null;
  swapUsedBytes: number | null;
  pageCacheBytes: number | null;
  pressure: boolean | null;
}

export interface SystemAnalyticsResourceBucket extends Omit<SystemAnalyticsResourceSample, "sampledAt" | "cpuOneCorePercent" | "rssBytes"> {
  resolutionSeconds: 10 | 60 | 900;
  bucketAt: string;
  sampleCount: number;
  cpuMin: number;
  cpuSum: number;
  cpuMax: number;
  rssMin: number;
  rssSum: number;
  rssMax: number;
}

export interface SystemAnalyticsRepository {
  upsertModelEvents(events: SystemAnalyticsModelEventRecord[]): Promise<void>;
  /** Model events are token usage and are never deleted (operator rule 2026-10-18); a RUNNING turn not updated for 31 days is an orphan and only leaves the lists. */
  listModelEvents(since: string, providerIds?: readonly string[]): Promise<SystemAnalyticsModelEventRecord[]>;
  summarizeModelEvents(input: SystemAnalyticsModelEventSummaryInput): Promise<SystemAnalyticsModelEventGroup[]>;
  insertResourceSamples(samples: SystemAnalyticsResourceSample[]): Promise<void>;
  listResourceBuckets(input: { since: string; resolutionSeconds: 10 | 60 | 900 }): Promise<SystemAnalyticsResourceBucket[]>;
  /** Rolls up and sweeps resource buckets only; model events are never swept. */
  rollupAndSweep(at: string): Promise<void>;
  getBackfill(): Promise<SystemAnalyticsBackfill>;
  setBackfill(input: SystemAnalyticsBackfill): Promise<void>;
  /** A named import position (the last gateway log id, the last Claude message time, a finished one-time re-read). */
  getCursor(key: string): Promise<string | null>;
  setCursor(key: string, value: string): Promise<void>;
  dispose(): Promise<void>;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function bucketStart(at: string, seconds: number): string {
  const ms = Date.parse(at);
  const bucketMs = seconds * 1000;
  return new Date(Math.floor(ms / bucketMs) * bucketMs).toISOString();
}

const hourMs = 60 * 60 * 1000;

/**
 * Fixed lookbacks of the original rollup. They are still used for the first
 * rollup after process start, so samples written before a restart or during a
 * gap without successful rollups are aggregated once.
 */
const rollupCatchUpLookbackMs = { 60: 3 * hourMs, 900: 72 * hourMs } as const;

/**
 * Target buckets re-aggregated before the previous successful rollup. They
 * cover samples that were taken before that rollup but committed after its
 * snapshot (10 s samples are inserted asynchronously), and the 60 s buckets the
 * 10 s -> 60 s step rewrites in the same transaction.
 */
const rollupMarginBuckets = { 60: 5, 900: 2 } as const;

export interface SystemAnalyticsRollupWindows {
  /** Lower bound (inclusive) of 10 s source rows aggregated into 60 s buckets. */
  since60: string;
  /** Lower bound (inclusive) of 60 s source rows aggregated into 900 s buckets. */
  since900: string;
}

function alignDown(ms: number, seconds: number): number {
  const bucketMs = seconds * 1000;
  return Math.floor(ms / bucketMs) * bucketMs;
}

/**
 * Source windows for one rollup. Without a previous successful rollup in this
 * process it returns the original catch-up windows (3 h / 3 days). Otherwise it
 * returns only whole target buckets that can still change: those overlapping
 * the period since `lastRollupAt`, minus a safety margin. Windows start on a
 * target-bucket boundary, so every re-aggregated target bucket sees all of its
 * source rows and produces the same aggregate as the full-window rollup.
 */
export function systemAnalyticsRollupWindows(at: string, lastRollupAt: string | null): SystemAnalyticsRollupWindows {
  const atMs = Date.parse(at);
  const lastMs = lastRollupAt === null ? Number.NaN : Date.parse(lastRollupAt);
  if (!Number.isFinite(lastMs)) {
    return {
      since60: new Date(atMs - rollupCatchUpLookbackMs[60]).toISOString(),
      since900: new Date(atMs - rollupCatchUpLookbackMs[900]).toISOString()
    };
  }
  // A clock step backwards must never skip buckets.
  const fromMs = Math.min(lastMs, atMs);
  const since60 = alignDown(fromMs, 60) - rollupMarginBuckets[60] * 60_000;
  // 900 s buckets also change when the 60 s rows rewritten above change.
  const since900 = Math.min(alignDown(fromMs, 900) - rollupMarginBuckets[900] * 900_000, alignDown(since60, 900));
  return { since60: new Date(since60).toISOString(), since900: new Date(since900).toISOString() };
}

/** Splits a batch so no statement upserts the same bucket key twice; order per key is kept. */
function uniqueKeyRounds<T>(items: T[], keyOf: (item: T) => string): T[][] {
  const rounds: T[][] = [];
  const seen = new Map<string, number>();
  for (const item of items) {
    const key = keyOf(item);
    const round = seen.get(key) ?? 0;
    seen.set(key, round + 1);
    (rounds[round] ??= []).push(item);
  }
  return rounds;
}

export class InMemorySystemAnalyticsRepository implements SystemAnalyticsRepository {
  private readonly modelEvents = new Map<string, SystemAnalyticsModelEventRecord>();
  private readonly samples: SystemAnalyticsResourceSample[] = [];
  private backfill: SystemAnalyticsBackfill = {
    status: "PENDING",
    earliestAt: null,
    latestAt: null,
    errors: []
  };

  async upsertModelEvents(events: SystemAnalyticsModelEventRecord[]): Promise<void> {
    for (const event of events) {
      const existing = this.modelEvents.get(event.eventKey);
      const next = clone(event);
      for (const field of keptModelEventFields) (next as unknown as Record<string, unknown>)[field] = event[field] ?? existing?.[field] ?? null;
      this.modelEvents.set(event.eventKey, next);
    }
  }

  async listModelEvents(since: string, providerIds?: readonly string[]): Promise<SystemAnalyticsModelEventRecord[]> {
    const sinceMs = Date.parse(since);
    return [...this.modelEvents.values()]
      .filter((event) => !providerIds || providerIds.includes(event.providerId))
      .filter((event) => Date.parse(event.endedAt ?? event.startedAt) >= sinceMs
        || (event.status === "RUNNING" && Date.parse(event.updatedAt) >= Date.now() - 31 * 24 * 60 * 60 * 1000))
      .sort((left, right) => left.startedAt.localeCompare(right.startedAt))
      .map(clone);
  }

  async summarizeModelEvents(input: SystemAnalyticsModelEventSummaryInput): Promise<SystemAnalyticsModelEventGroup[]> {
    return summarizeModelEventRecords(await this.listModelEvents(input.since), input);
  }

  async insertResourceSamples(samples: SystemAnalyticsResourceSample[]): Promise<void> {
    this.samples.push(...samples.map(clone));
  }

  async listResourceBuckets(input: { since: string; resolutionSeconds: 10 | 60 | 900 }): Promise<SystemAnalyticsResourceBucket[]> {
    const sinceMs = Date.parse(input.since);
    const grouped = new Map<string, SystemAnalyticsResourceBucket>();
    for (const sample of this.samples) {
      if (Date.parse(sample.sampledAt) < sinceMs) continue;
      const at = bucketStart(sample.sampledAt, input.resolutionSeconds);
      const key = `${at}\u0000${sample.entityType}\u0000${sample.entityId}`;
      const existing = grouped.get(key);
      if (existing) {
        existing.sampleCount += 1;
        existing.processCount = sample.processCount;
        existing.cpuMin = Math.min(existing.cpuMin, sample.cpuOneCorePercent);
        existing.cpuSum += sample.cpuOneCorePercent;
        existing.cpuMax = Math.max(existing.cpuMax, sample.cpuOneCorePercent);
        existing.rssMin = Math.min(existing.rssMin, sample.rssBytes);
        existing.rssSum += sample.rssBytes;
        existing.rssMax = Math.max(existing.rssMax, sample.rssBytes);
      } else {
        grouped.set(key, {
          ...clone(sample),
          resolutionSeconds: input.resolutionSeconds,
          bucketAt: at,
          sampleCount: 1,
          cpuMin: sample.cpuOneCorePercent,
          cpuSum: sample.cpuOneCorePercent,
          cpuMax: sample.cpuOneCorePercent,
          rssMin: sample.rssBytes,
          rssSum: sample.rssBytes,
          rssMax: sample.rssBytes
        });
      }
    }
    return [...grouped.values()].sort((left, right) => left.bucketAt.localeCompare(right.bucketAt));
  }

  async rollupAndSweep(at: string): Promise<void> {
    const cutoff = Date.parse(at) - 31 * 24 * 60 * 60 * 1000;
    let write = 0;
    for (const sample of this.samples) {
      if (Date.parse(sample.sampledAt) >= cutoff) this.samples[write++] = sample;
    }
    this.samples.length = write;
  }

  async getBackfill(): Promise<SystemAnalyticsBackfill> {
    return clone(this.backfill);
  }

  async setBackfill(input: SystemAnalyticsBackfill): Promise<void> {
    this.backfill = clone(input);
  }

  private readonly cursors = new Map<string, string>();
  async getCursor(key: string): Promise<string | null> {
    return this.cursors.get(key) ?? null;
  }

  async setCursor(key: string, value: string): Promise<void> {
    this.cursors.set(key, value);
  }

  async dispose(): Promise<void> {}
}

type ResourceBucketRow = {
  resolutionSeconds: number;
  bucketAt: Date | string;
  entityType: SystemAnalyticsResourceEntityType;
  entityId: string;
  roomId: string | null;
  roomName: string | null;
  paneId: string | null;
  paneTitle: string | null;
  sessionId: string | null;
  runtimeId: string | null;
  runtimeName: string | null;
  providerId: string | null;
  modelId: string | null;
  sampleCount: number | string;
  processCount: number | string;
  cpuMin: number | string;
  cpuSum: number | string;
  cpuMax: number | string;
  rssMin: number | string;
  rssSum: number | string;
  rssMax: number | string;
  memoryTotalBytes: number | string | null;
  memoryAvailableBytes: number | string | null;
  swapTotalBytes: number | string | null;
  swapUsedBytes: number | string | null;
  pageCacheBytes: number | string | null;
  pressure: boolean | null;
};

function iso(value: Date | string): string {
  return new Date(value).toISOString();
}

function numeric(value: number | string | null): number | null {
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function mapResourceBucket(row: ResourceBucketRow): SystemAnalyticsResourceBucket {
  return {
    resolutionSeconds: row.resolutionSeconds as 10 | 60 | 900,
    bucketAt: iso(row.bucketAt),
    entityType: row.entityType,
    entityId: row.entityId,
    roomId: row.roomId,
    roomName: row.roomName,
    paneId: row.paneId,
    paneTitle: row.paneTitle,
    sessionId: row.sessionId,
    runtimeId: row.runtimeId,
    runtimeName: row.runtimeName,
    providerId: row.providerId,
    modelId: row.modelId,
    processCount: numeric(row.processCount) ?? 0,
    sampleCount: numeric(row.sampleCount) ?? 0,
    cpuMin: numeric(row.cpuMin) ?? 0,
    cpuSum: numeric(row.cpuSum) ?? 0,
    cpuMax: numeric(row.cpuMax) ?? 0,
    rssMin: numeric(row.rssMin) ?? 0,
    rssSum: numeric(row.rssSum) ?? 0,
    rssMax: numeric(row.rssMax) ?? 0,
    memoryTotalBytes: numeric(row.memoryTotalBytes),
    memoryAvailableBytes: numeric(row.memoryAvailableBytes),
    swapTotalBytes: numeric(row.swapTotalBytes),
    swapUsedBytes: numeric(row.swapUsedBytes),
    pageCacheBytes: numeric(row.pageCacheBytes),
    pressure: row.pressure
  };
}

export class PostgresSystemAnalyticsRepository implements SystemAnalyticsRepository {
  /** `at` of the last committed rollup in this process; null until the first catch-up commits. */
  private lastRollupAt: string | null = null;

  constructor(private readonly pool: PgPoolLike, private readonly ownsPool = false) {}

  static fromConnectionString(
    connectionString: string,
    poolOptions: { max?: number; idleTimeoutMillis?: number; connectionTimeoutMillis?: number } = {}
  ): PostgresSystemAnalyticsRepository {
    return new PostgresSystemAnalyticsRepository(createSpacePgPool(connectionString, poolOptions, 2), true);
  }

  async upsertModelEvents(events: SystemAnalyticsModelEventRecord[]): Promise<void> {
    // One statement per 500 events (an import brings tens of thousands); a key may appear once per statement.
    const unique = [...new Map(events.map((event) => [event.eventKey, event])).values()];
    for (let offset = 0; offset < unique.length; offset += 500) {
      const values: unknown[] = [];
      const tuples = unique.slice(offset, offset + 500).map((event) => {
        const row = [
          event.eventKey, event.source, event.runtimeId, event.providerId, event.modelId,
          event.roomId, event.paneId, event.sessionId, event.turnId, event.status, event.coverage,
          event.turnCount, event.startedAt, event.endedAt, event.tokensIn, event.tokensOut, event.tokensReasoning,
          event.ttftMs, event.durationMs, event.updatedAt, event.route ?? null, event.accountKey ?? null, event.costUsd ?? null,
          event.tokensCacheRead ?? null, event.tokensCacheWrite ?? null
        ];
        return `(${row.map((value) => { values.push(value); return `$${values.length}`; }).join(", ")})`;
      });
      await this.pool.query(
        `
          INSERT INTO system_analytics_model_events (
            event_key, source, runtime_id, provider_id, model_id, room_id, pane_id, session_id,
            turn_id, status, coverage, turn_count, started_at, ended_at, tokens_in, tokens_out,
            tokens_reasoning, ttft_ms, duration_ms, updated_at, route, account_key, cost_usd,
            tokens_cache_read, tokens_cache_write
          ) VALUES ${tuples.join(", ")}
          ON CONFLICT (event_key) DO UPDATE SET
            provider_id = EXCLUDED.provider_id,
            model_id = EXCLUDED.model_id,
            status = EXCLUDED.status,
            coverage = EXCLUDED.coverage,
            turn_count = EXCLUDED.turn_count,
            ended_at = EXCLUDED.ended_at,
            tokens_in = EXCLUDED.tokens_in,
            tokens_out = EXCLUDED.tokens_out,
            tokens_reasoning = EXCLUDED.tokens_reasoning,
            ttft_ms = EXCLUDED.ttft_ms,
            duration_ms = EXCLUDED.duration_ms,
            updated_at = EXCLUDED.updated_at,
            route = COALESCE(EXCLUDED.route, system_analytics_model_events.route),
            account_key = COALESCE(EXCLUDED.account_key, system_analytics_model_events.account_key),
            cost_usd = COALESCE(EXCLUDED.cost_usd, system_analytics_model_events.cost_usd),
            tokens_cache_read = COALESCE(EXCLUDED.tokens_cache_read, system_analytics_model_events.tokens_cache_read),
            tokens_cache_write = COALESCE(EXCLUDED.tokens_cache_write, system_analytics_model_events.tokens_cache_write)
        `,
        values
      );
    }
  }

  async listModelEvents(since: string, providerIds?: readonly string[]): Promise<SystemAnalyticsModelEventRecord[]> {
    const result = await this.pool.query<Record<string, unknown>>(
      `
        SELECT
          event_key AS "eventKey", source, runtime_id AS "runtimeId", provider_id AS "providerId",
          model_id AS "modelId", room_id AS "roomId", pane_id AS "paneId", session_id AS "sessionId",
          turn_id AS "turnId", status, coverage, turn_count AS "turnCount", started_at AS "startedAt", ended_at AS "endedAt",
          tokens_in AS "tokensIn", tokens_out AS "tokensOut", tokens_reasoning AS "tokensReasoning",
          ttft_ms AS "ttftMs", duration_ms AS "durationMs", updated_at AS "updatedAt", route, account_key AS "accountKey",
          cost_usd AS "costUsd", tokens_cache_read AS "tokensCacheRead", tokens_cache_write AS "tokensCacheWrite"
        FROM system_analytics_model_events
        WHERE (COALESCE(ended_at, started_at) >= $1 OR (status = 'RUNNING' AND updated_at >= now() - interval '31 days'))
          AND ($2::text[] IS NULL OR provider_id = ANY($2::text[]))
        ORDER BY started_at ASC, event_key ASC
      `,
      [since, providerIds ? [...providerIds] : null]
    );
    return result.rows.map((row) => ({
      eventKey: String(row.eventKey),
      source: row.source as SystemAnalyticsModelEventRecord["source"],
      runtimeId: String(row.runtimeId),
      providerId: String(row.providerId),
      modelId: String(row.modelId),
      roomId: row.roomId === null ? null : String(row.roomId),
      paneId: row.paneId === null ? null : String(row.paneId),
      sessionId: row.sessionId === null ? null : String(row.sessionId),
      turnId: row.turnId === null ? null : String(row.turnId),
      status: row.status as SystemAnalyticsModelEventStatus,
      coverage: row.coverage as SystemAnalyticsCoverage,
      turnCount: numeric(row.turnCount as number | string | null) ?? 0,
      startedAt: iso(row.startedAt as Date | string),
      endedAt: row.endedAt === null ? null : iso(row.endedAt as Date | string),
      tokensIn: numeric(row.tokensIn as number | string | null),
      tokensOut: numeric(row.tokensOut as number | string | null),
      tokensReasoning: numeric(row.tokensReasoning as number | string | null),
      ttftMs: numeric(row.ttftMs as number | string | null),
      durationMs: numeric(row.durationMs as number | string | null),
      updatedAt: iso(row.updatedAt as Date | string),
      route: (row.route as SystemAnalyticsRoute | null) ?? null,
      accountKey: row.accountKey === null ? null : String(row.accountKey),
      costUsd: numeric(row.costUsd as number | string | null),
      tokensCacheRead: numeric(row.tokensCacheRead as number | string | null),
      tokensCacheWrite: numeric(row.tokensCacheWrite as number | string | null)
    }));
  }

  /** summarizeModelEventRecords in SQL: the API receives a few thousand groups instead of every event of the window. */
  async summarizeModelEvents(input: SystemAnalyticsModelEventSummaryInput): Promise<SystemAnalyticsModelEventGroup[]> {
    const result = await this.pool.query<Record<string, unknown>>(
      `
        WITH visible AS (
          SELECT *, (source IN ('gateway', 'claude', 'session') OR COALESCE(turn_id, '') = '') AS kept
          FROM system_analytics_model_events
          WHERE (COALESCE(ended_at, started_at) >= $1 OR (status = 'RUNNING' AND updated_at >= now() - interval '31 days'))
            AND provider_id <> 'root' AND runtime_id <> 'cli:root'
            AND (status <> 'RUNNING' OR session_id = ANY($2::text[]))
        ), turns AS (
          SELECT DISTINCT ON (source, runtime_id, turn_id) *,
            first_value(started_at) OVER turn AS ord_at, first_value(event_key) OVER turn AS ord_key
          FROM visible
          WHERE NOT kept
          WINDOW turn AS (PARTITION BY source, runtime_id, turn_id ORDER BY started_at, event_key)
          ORDER BY source, runtime_id, turn_id, (route IS NOT NULL) DESC,
            COALESCE(tokens_in, 0) + COALESCE(tokens_out, 0) DESC, started_at, event_key
        ), listed AS (
          SELECT *, row_number() OVER (ORDER BY kind, ord_at, ord_key) AS seq
          FROM (
            SELECT source, runtime_id, provider_id, model_id, session_id, status, coverage, turn_count, started_at, ended_at, updated_at,
              tokens_in, tokens_out, tokens_reasoning, ttft_ms, duration_ms, route, account_key, cost_usd, tokens_cache_read, tokens_cache_write,
              0 AS kind, started_at AS ord_at, event_key AS ord_key
            FROM visible WHERE kept
            UNION ALL
            SELECT source, runtime_id, provider_id, model_id, session_id, status, coverage, turn_count, started_at, ended_at, updated_at,
              tokens_in, tokens_out, tokens_reasoning, ttft_ms, duration_ms, route, account_key, cost_usd, tokens_cache_read, tokens_cache_write,
              1, ord_at, ord_key
            FROM turns
          ) events
        )
        SELECT
          source = 'gateway' OR route IS DISTINCT FROM 'GATEWAY' AS counted,
          source = 'gateway' AS gateway,
          runtime_id AS "runtimeId", provider_id AS "providerId", model_id AS "modelId", status, coverage, account_key AS "accountKey",
          COALESCE(tokens_in, 0) + COALESCE(tokens_out, 0) > 0 AS "hasTokens",
          CASE WHEN session_id = ANY($2::text[]) THEN session_id END AS "liveSessionId",
          floor(extract(epoch FROM COALESCE(ended_at, started_at)) * 1000 / $3::numeric) * $3::numeric AS "bucketAtMs",
          sum(turn_count) AS turns,
          COALESCE(sum(GREATEST(turn_count, 1)) FILTER (WHERE cost_usd IS NULL AND COALESCE(tokens_in, 0) + COALESCE(tokens_out, 0) > 0), 0) AS "unpricedTurns",
          sum(tokens_in) AS "tokensIn", sum(tokens_out) AS "tokensOut", sum(tokens_reasoning) AS "tokensReasoning", sum(cost_usd) AS "costUsd",
          COALESCE(sum(ttft_ms * GREATEST(turn_count, 1)), 0) AS "ttftSum",
          COALESCE(sum(GREATEST(turn_count, 1)) FILTER (WHERE ttft_ms IS NOT NULL), 0) AS "ttftWeight",
          COALESCE(sum(duration_ms * GREATEST(turn_count, 1)), 0) AS "durationSum",
          COALESCE(sum(GREATEST(turn_count, 1)) FILTER (WHERE duration_ms IS NOT NULL), 0) AS "durationWeight",
          sum(COALESCE(tokens_cache_read, 0)) AS "tokensCacheRead", sum(COALESCE(tokens_cache_write, 0)) AS "tokensCacheWrite",
          sum(GREATEST(COALESCE(tokens_in, 0) - COALESCE(tokens_cache_read, 0) - COALESCE(tokens_cache_write, 0), 0)) AS "freshInput",
          min(started_at) AS "firstAt", max(COALESCE(ended_at, updated_at, started_at)) AS "lastAt",
          min(seq) - 1 AS "firstSeq", max(seq) - 1 AS "lastSeq"
        FROM listed
        GROUP BY 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11
        ORDER BY "firstSeq"
      `,
      [input.since, [...input.liveSessionIds], input.bucketMs]
    );
    return result.rows.map((row) => ({
      counted: row.counted === true,
      gateway: row.gateway === true,
      runtimeId: String(row.runtimeId),
      providerId: String(row.providerId),
      modelId: String(row.modelId),
      status: row.status as SystemAnalyticsModelEventStatus,
      coverage: row.coverage as SystemAnalyticsCoverage,
      accountKey: row.accountKey === null ? null : String(row.accountKey),
      hasTokens: row.hasTokens === true,
      liveSessionId: row.liveSessionId === null ? null : String(row.liveSessionId),
      bucketAtMs: Number(row.bucketAtMs),
      turns: Number(row.turns),
      unpricedTurns: Number(row.unpricedTurns),
      tokensIn: numeric(row.tokensIn as number | string | null),
      tokensOut: numeric(row.tokensOut as number | string | null),
      tokensReasoning: numeric(row.tokensReasoning as number | string | null),
      costUsd: numeric(row.costUsd as number | string | null),
      ttftSum: Number(row.ttftSum),
      ttftWeight: Number(row.ttftWeight),
      durationSum: Number(row.durationSum),
      durationWeight: Number(row.durationWeight),
      tokensCacheRead: Number(row.tokensCacheRead),
      tokensCacheWrite: Number(row.tokensCacheWrite),
      freshInput: Number(row.freshInput),
      firstAt: iso(row.firstAt as Date | string),
      lastAt: iso(row.lastAt as Date | string),
      firstSeq: Number(row.firstSeq),
      lastSeq: Number(row.lastSeq)
    }));
  }

  /**
   * One multi-row upsert per sampling tick instead of one statement (and one
   * implicit transaction) per entity. Rows are applied with the same per-row
   * semantics as before; a repeated bucket key within one batch goes into a
   * later statement so it accumulates instead of conflicting with itself.
   */
  async insertResourceSamples(samples: SystemAnalyticsResourceSample[]): Promise<void> {
    const rows = samples.map((sample) => ({
      bucket_at: bucketStart(sample.sampledAt, 10),
      entity_type: sample.entityType,
      entity_id: sample.entityId,
      room_id: sample.roomId,
      room_name: sample.roomName,
      pane_id: sample.paneId,
      pane_title: sample.paneTitle,
      session_id: sample.sessionId,
      runtime_id: sample.runtimeId,
      runtime_name: sample.runtimeName,
      provider_id: sample.providerId,
      model_id: sample.modelId,
      process_count: sample.processCount,
      cpu: sample.cpuOneCorePercent,
      rss: sample.rssBytes,
      memory_total_bytes: sample.memoryTotalBytes,
      memory_available_bytes: sample.memoryAvailableBytes,
      swap_total_bytes: sample.swapTotalBytes,
      swap_used_bytes: sample.swapUsedBytes,
      page_cache_bytes: sample.pageCacheBytes,
      pressure: sample.pressure
    }));
    for (const round of uniqueKeyRounds(rows, (row) => `${row.bucket_at}\u0000${row.entity_type}\u0000${row.entity_id}`)) {
      await this.pool.query(
        `
          INSERT INTO system_analytics_resource_buckets (
            resolution_seconds, bucket_at, entity_type, entity_id, room_id, room_name, pane_id,
            pane_title, session_id, runtime_id, runtime_name, provider_id, model_id, sample_count,
            process_count, cpu_min, cpu_sum, cpu_max, rss_min, rss_sum, rss_max,
            memory_total_bytes, memory_available_bytes, swap_total_bytes, swap_used_bytes,
            page_cache_bytes, pressure
          )
          SELECT
            10, s.bucket_at, s.entity_type, s.entity_id, s.room_id, s.room_name, s.pane_id,
            s.pane_title, s.session_id, s.runtime_id, s.runtime_name, s.provider_id, s.model_id, 1,
            s.process_count,
            s.cpu, s.cpu, s.cpu,
            s.rss::bigint, s.rss::numeric, s.rss::bigint,
            s.memory_total_bytes, s.memory_available_bytes, s.swap_total_bytes, s.swap_used_bytes,
            s.page_cache_bytes, s.pressure
          FROM jsonb_to_recordset($1::jsonb) AS s(
            bucket_at timestamptz, entity_type text, entity_id text, room_id text, room_name text,
            pane_id text, pane_title text, session_id text, runtime_id text, runtime_name text,
            provider_id text, model_id text, process_count integer, cpu double precision, rss numeric,
            memory_total_bytes bigint, memory_available_bytes bigint, swap_total_bytes bigint,
            swap_used_bytes bigint, page_cache_bytes bigint, pressure boolean
          )
          ON CONFLICT (resolution_seconds, bucket_at, entity_type, entity_id) DO UPDATE SET
            room_name = EXCLUDED.room_name,
            pane_title = EXCLUDED.pane_title,
            process_count = EXCLUDED.process_count,
            cpu_min = LEAST(system_analytics_resource_buckets.cpu_min, EXCLUDED.cpu_min),
            cpu_sum = system_analytics_resource_buckets.cpu_sum + EXCLUDED.cpu_sum,
            cpu_max = GREATEST(system_analytics_resource_buckets.cpu_max, EXCLUDED.cpu_max),
            rss_min = LEAST(system_analytics_resource_buckets.rss_min, EXCLUDED.rss_min),
            rss_sum = system_analytics_resource_buckets.rss_sum + EXCLUDED.rss_sum,
            rss_max = GREATEST(system_analytics_resource_buckets.rss_max, EXCLUDED.rss_max),
            sample_count = system_analytics_resource_buckets.sample_count + 1,
            memory_total_bytes = EXCLUDED.memory_total_bytes,
            memory_available_bytes = EXCLUDED.memory_available_bytes,
            swap_total_bytes = EXCLUDED.swap_total_bytes,
            swap_used_bytes = EXCLUDED.swap_used_bytes,
            page_cache_bytes = EXCLUDED.page_cache_bytes,
            pressure = EXCLUDED.pressure
        `,
        [JSON.stringify(round)]
      );
    }
  }

  async listResourceBuckets(input: { since: string; resolutionSeconds: 10 | 60 | 900 }): Promise<SystemAnalyticsResourceBucket[]> {
    const result = await this.pool.query<ResourceBucketRow>(
      `
        SELECT
          resolution_seconds AS "resolutionSeconds", bucket_at AS "bucketAt", entity_type AS "entityType",
          entity_id AS "entityId", room_id AS "roomId", room_name AS "roomName", pane_id AS "paneId",
          pane_title AS "paneTitle", session_id AS "sessionId", runtime_id AS "runtimeId",
          runtime_name AS "runtimeName", provider_id AS "providerId", model_id AS "modelId",
          sample_count AS "sampleCount", process_count AS "processCount", cpu_min AS "cpuMin",
          cpu_sum AS "cpuSum", cpu_max AS "cpuMax", rss_min AS "rssMin", rss_sum AS "rssSum",
          rss_max AS "rssMax", memory_total_bytes AS "memoryTotalBytes",
          memory_available_bytes AS "memoryAvailableBytes", swap_total_bytes AS "swapTotalBytes",
          swap_used_bytes AS "swapUsedBytes", page_cache_bytes AS "pageCacheBytes", pressure
        FROM system_analytics_resource_buckets
        WHERE resolution_seconds = $1 AND bucket_at >= $2
        ORDER BY bucket_at ASC, entity_type ASC, entity_id ASC
      `,
      [input.resolutionSeconds, input.since]
    );
    return result.rows.map(mapResourceBucket);
  }

  async rollupAndSweep(at: string): Promise<void> {
    const windows = systemAnalyticsRollupWindows(at, this.lastRollupAt);
    const client = await this.pool.connect();
    let rollbackFailed = false;
    try {
      await client.query("BEGIN");
      await this.rollup(client, 10, 60, windows.since60);
      await this.rollup(client, 60, 900, windows.since900);
      await client.query(`DELETE FROM system_analytics_resource_buckets WHERE resolution_seconds = 10 AND bucket_at < $1::timestamptz - interval '2 hours'`, [at]);
      await client.query(`DELETE FROM system_analytics_resource_buckets WHERE resolution_seconds = 60 AND bucket_at < $1::timestamptz - interval '48 hours'`, [at]);
      await client.query(`DELETE FROM system_analytics_resource_buckets WHERE resolution_seconds = 900 AND bucket_at < $1::timestamptz - interval '31 days'`, [at]);
      await client.query("COMMIT");
      // Advance only after a committed rollup; a failed run is retried from
      // the previous watermark by the next one.
      if (this.lastRollupAt === null || Date.parse(at) > Date.parse(this.lastRollupAt)) this.lastRollupAt = at;
    } catch (error) {
      rollbackFailed = await rollbackKeepingError(client);
      throw error;
    } finally {
      client.release?.(rollbackFailed || undefined);
    }
  }

  private async rollup(
    client: { query(sql: string, values?: unknown[]): Promise<unknown> },
    sourceResolution: 10 | 60,
    targetResolution: 60 | 900,
    since: string
  ): Promise<void> {
    await client.query(
      `
        INSERT INTO system_analytics_resource_buckets (
          resolution_seconds, bucket_at, entity_type, entity_id, room_id, room_name, pane_id,
          pane_title, session_id, runtime_id, runtime_name, provider_id, model_id, sample_count,
          process_count, cpu_min, cpu_sum, cpu_max, rss_min, rss_sum, rss_max,
          memory_total_bytes, memory_available_bytes, swap_total_bytes, swap_used_bytes,
          page_cache_bytes, pressure
        )
        SELECT
          $1::integer,
          to_timestamp(floor(extract(epoch FROM bucket_at) / $1::integer) * $1::integer),
          entity_type, entity_id,
          (array_agg(room_id ORDER BY bucket_at DESC))[1],
          (array_agg(room_name ORDER BY bucket_at DESC))[1],
          (array_agg(pane_id ORDER BY bucket_at DESC))[1],
          (array_agg(pane_title ORDER BY bucket_at DESC))[1],
          (array_agg(session_id ORDER BY bucket_at DESC))[1],
          (array_agg(runtime_id ORDER BY bucket_at DESC))[1],
          (array_agg(runtime_name ORDER BY bucket_at DESC))[1],
          (array_agg(provider_id ORDER BY bucket_at DESC))[1],
          (array_agg(model_id ORDER BY bucket_at DESC))[1],
          sum(sample_count)::integer,
          (array_agg(process_count ORDER BY bucket_at DESC))[1],
          min(cpu_min), sum(cpu_sum ORDER BY bucket_at DESC), max(cpu_max), min(rss_min), sum(rss_sum), max(rss_max),
          (array_agg(memory_total_bytes ORDER BY bucket_at DESC))[1],
          (array_agg(memory_available_bytes ORDER BY bucket_at DESC))[1],
          (array_agg(swap_total_bytes ORDER BY bucket_at DESC))[1],
          (array_agg(swap_used_bytes ORDER BY bucket_at DESC))[1],
          (array_agg(page_cache_bytes ORDER BY bucket_at DESC))[1],
          bool_or(pressure)
        FROM system_analytics_resource_buckets
        WHERE resolution_seconds = $2::integer AND bucket_at >= $3::timestamptz
        GROUP BY 2, entity_type, entity_id
        ON CONFLICT (resolution_seconds, bucket_at, entity_type, entity_id) DO UPDATE SET
          room_id = EXCLUDED.room_id, room_name = EXCLUDED.room_name,
          pane_id = EXCLUDED.pane_id, pane_title = EXCLUDED.pane_title,
          session_id = EXCLUDED.session_id, runtime_id = EXCLUDED.runtime_id,
          runtime_name = EXCLUDED.runtime_name, provider_id = EXCLUDED.provider_id,
          model_id = EXCLUDED.model_id, sample_count = EXCLUDED.sample_count,
          process_count = EXCLUDED.process_count, cpu_min = EXCLUDED.cpu_min,
          cpu_sum = EXCLUDED.cpu_sum, cpu_max = EXCLUDED.cpu_max,
          rss_min = EXCLUDED.rss_min, rss_sum = EXCLUDED.rss_sum, rss_max = EXCLUDED.rss_max,
          memory_total_bytes = EXCLUDED.memory_total_bytes,
          memory_available_bytes = EXCLUDED.memory_available_bytes,
          swap_total_bytes = EXCLUDED.swap_total_bytes, swap_used_bytes = EXCLUDED.swap_used_bytes,
          page_cache_bytes = EXCLUDED.page_cache_bytes, pressure = EXCLUDED.pressure
        WHERE (
          system_analytics_resource_buckets.room_id, system_analytics_resource_buckets.room_name,
          system_analytics_resource_buckets.pane_id, system_analytics_resource_buckets.pane_title,
          system_analytics_resource_buckets.session_id, system_analytics_resource_buckets.runtime_id,
          system_analytics_resource_buckets.runtime_name, system_analytics_resource_buckets.provider_id,
          system_analytics_resource_buckets.model_id, system_analytics_resource_buckets.sample_count,
          system_analytics_resource_buckets.process_count, system_analytics_resource_buckets.cpu_min,
          system_analytics_resource_buckets.cpu_sum, system_analytics_resource_buckets.cpu_max,
          system_analytics_resource_buckets.rss_min, system_analytics_resource_buckets.rss_sum,
          system_analytics_resource_buckets.rss_max, system_analytics_resource_buckets.memory_total_bytes,
          system_analytics_resource_buckets.memory_available_bytes, system_analytics_resource_buckets.swap_total_bytes,
          system_analytics_resource_buckets.swap_used_bytes, system_analytics_resource_buckets.page_cache_bytes,
          system_analytics_resource_buckets.pressure
        ) IS DISTINCT FROM (
          EXCLUDED.room_id, EXCLUDED.room_name, EXCLUDED.pane_id, EXCLUDED.pane_title,
          EXCLUDED.session_id, EXCLUDED.runtime_id, EXCLUDED.runtime_name, EXCLUDED.provider_id,
          EXCLUDED.model_id, EXCLUDED.sample_count, EXCLUDED.process_count, EXCLUDED.cpu_min,
          EXCLUDED.cpu_sum, EXCLUDED.cpu_max, EXCLUDED.rss_min, EXCLUDED.rss_sum, EXCLUDED.rss_max,
          EXCLUDED.memory_total_bytes, EXCLUDED.memory_available_bytes, EXCLUDED.swap_total_bytes,
          EXCLUDED.swap_used_bytes, EXCLUDED.page_cache_bytes, EXCLUDED.pressure
        )
      `,
      [targetResolution, sourceResolution, since]
    );
  }

  async getBackfill(): Promise<SystemAnalyticsBackfill> {
    const result = await this.pool.query<Record<string, unknown>>(
      `SELECT status, earliest_at AS "earliestAt", latest_at AS "latestAt", errors FROM system_analytics_ingest_cursors WHERE source_key = 'backfill'`
    );
    const row = result.rows[0];
    if (!row) return { status: "PENDING", earliestAt: null, latestAt: null, errors: [] };
    return {
      status: row.status as SystemAnalyticsBackfill["status"],
      earliestAt: row.earliestAt ? iso(row.earliestAt as Date | string) : null,
      latestAt: row.latestAt ? iso(row.latestAt as Date | string) : null,
      errors: Array.isArray(row.errors) ? row.errors.map(String).slice(0, 20) : []
    };
  }

  async setBackfill(input: SystemAnalyticsBackfill): Promise<void> {
    await this.pool.query(
      `
        INSERT INTO system_analytics_ingest_cursors (source_key, status, earliest_at, latest_at, errors, updated_at)
        VALUES ('backfill', $1, $2, $3, $4::jsonb, now())
        ON CONFLICT (source_key) DO UPDATE SET
          status = EXCLUDED.status,
          earliest_at = EXCLUDED.earliest_at,
          latest_at = EXCLUDED.latest_at,
          errors = EXCLUDED.errors,
          updated_at = EXCLUDED.updated_at
      `,
      [input.status, input.earliestAt, input.latestAt, JSON.stringify(input.errors.slice(0, 20))]
    );
  }

  async getCursor(key: string): Promise<string | null> {
    const result = await this.pool.query<{ value: string | null }>(
      `SELECT cursor_value AS value FROM system_analytics_ingest_cursors WHERE source_key = $1`, [key]);
    return result.rows[0]?.value ?? null;
  }

  async setCursor(key: string, value: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO system_analytics_ingest_cursors (source_key, cursor_value, status, updated_at) VALUES ($1, $2, 'COMPLETE', now())
        ON CONFLICT (source_key) DO UPDATE SET cursor_value = EXCLUDED.cursor_value, updated_at = now()`, [key, value]);
  }

  async dispose(): Promise<void> {
    if (!this.ownsPool) return;
    const closable = this.pool as PgPoolLike & { end?: () => Promise<void> };
    await closable.end?.();
  }
}
