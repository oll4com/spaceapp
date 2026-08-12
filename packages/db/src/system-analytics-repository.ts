import { createSpacePgPool, type PgPoolLike } from "./space-store.js";
import type { SystemAnalyticsBackfill, SystemAnalyticsCoverage } from "@space/contracts";

export type SystemAnalyticsModelEventStatus = "RUNNING" | "COMPLETED" | "ABORTED" | "SESSION";
export type SystemAnalyticsResourceEntityType = "HOST" | "CLI_SESSION" | "SHARED_RUNTIME";

export interface SystemAnalyticsModelEventRecord {
  eventKey: string;
  source: "codex" | "opencode" | "session";
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
  listModelEvents(since: string): Promise<SystemAnalyticsModelEventRecord[]>;
  insertResourceSamples(samples: SystemAnalyticsResourceSample[]): Promise<void>;
  listResourceBuckets(input: { since: string; resolutionSeconds: 10 | 60 | 900 }): Promise<SystemAnalyticsResourceBucket[]>;
  rollupAndSweep(at: string): Promise<void>;
  getBackfill(): Promise<SystemAnalyticsBackfill>;
  setBackfill(input: SystemAnalyticsBackfill): Promise<void>;
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
    for (const event of events) this.modelEvents.set(event.eventKey, clone(event));
  }

  async listModelEvents(since: string): Promise<SystemAnalyticsModelEventRecord[]> {
    const sinceMs = Date.parse(since);
    return [...this.modelEvents.values()]
      .filter((event) => Date.parse(event.endedAt ?? event.startedAt) >= sinceMs || event.status === "RUNNING")
      .sort((left, right) => left.startedAt.localeCompare(right.startedAt))
      .map(clone);
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
    for (const [key, event] of this.modelEvents) {
      const activityExpired = Date.parse(event.endedAt ?? event.startedAt) < cutoff;
      const runningUpdateExpired = event.status === "RUNNING" && Date.parse(event.updatedAt) < cutoff;
      if ((event.status !== "RUNNING" && activityExpired) || runningUpdateExpired) this.modelEvents.delete(key);
    }
  }

  async getBackfill(): Promise<SystemAnalyticsBackfill> {
    return clone(this.backfill);
  }

  async setBackfill(input: SystemAnalyticsBackfill): Promise<void> {
    this.backfill = clone(input);
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
  constructor(private readonly pool: PgPoolLike, private readonly ownsPool = false) {}

  static fromConnectionString(
    connectionString: string,
    poolOptions: { max?: number; idleTimeoutMillis?: number; connectionTimeoutMillis?: number } = {}
  ): PostgresSystemAnalyticsRepository {
    return new PostgresSystemAnalyticsRepository(createSpacePgPool(connectionString, poolOptions, 2), true);
  }

  async upsertModelEvents(events: SystemAnalyticsModelEventRecord[]): Promise<void> {
    for (const event of events) {
      await this.pool.query(
        `
          INSERT INTO system_analytics_model_events (
            event_key, source, runtime_id, provider_id, model_id, room_id, pane_id, session_id,
            turn_id, status, coverage, turn_count, started_at, ended_at, tokens_in, tokens_out,
            tokens_reasoning, ttft_ms, duration_ms, updated_at
          ) VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20
          )
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
            updated_at = EXCLUDED.updated_at
        `,
        [
          event.eventKey, event.source, event.runtimeId, event.providerId, event.modelId,
          event.roomId, event.paneId, event.sessionId, event.turnId, event.status, event.coverage,
          event.turnCount, event.startedAt, event.endedAt, event.tokensIn, event.tokensOut, event.tokensReasoning,
          event.ttftMs, event.durationMs, event.updatedAt
        ]
      );
    }
  }

  async listModelEvents(since: string): Promise<SystemAnalyticsModelEventRecord[]> {
    const result = await this.pool.query<Record<string, unknown>>(
      `
        SELECT
          event_key AS "eventKey", source, runtime_id AS "runtimeId", provider_id AS "providerId",
          model_id AS "modelId", room_id AS "roomId", pane_id AS "paneId", session_id AS "sessionId",
          turn_id AS "turnId", status, coverage, turn_count AS "turnCount", started_at AS "startedAt", ended_at AS "endedAt",
          tokens_in AS "tokensIn", tokens_out AS "tokensOut", tokens_reasoning AS "tokensReasoning",
          ttft_ms AS "ttftMs", duration_ms AS "durationMs", updated_at AS "updatedAt"
        FROM system_analytics_model_events
        WHERE COALESCE(ended_at, started_at) >= $1 OR status = 'RUNNING'
        ORDER BY started_at ASC, event_key ASC
      `,
      [since]
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
      updatedAt: iso(row.updatedAt as Date | string)
    }));
  }

  async insertResourceSamples(samples: SystemAnalyticsResourceSample[]): Promise<void> {
    for (const sample of samples) {
      const at = bucketStart(sample.sampledAt, 10);
      await this.pool.query(
        `
          INSERT INTO system_analytics_resource_buckets (
            resolution_seconds, bucket_at, entity_type, entity_id, room_id, room_name, pane_id,
            pane_title, session_id, runtime_id, runtime_name, provider_id, model_id, sample_count,
            process_count, cpu_min, cpu_sum, cpu_max, rss_min, rss_sum, rss_max,
            memory_total_bytes, memory_available_bytes, swap_total_bytes, swap_used_bytes,
            page_cache_bytes, pressure
          ) VALUES (
            10, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 1,
            $13::integer,
            $14::double precision, $14::double precision, $14::double precision,
            $15::bigint, $15::numeric, $15::bigint,
            $16::bigint, $17::bigint, $18::bigint, $19::bigint, $20::bigint, $21::boolean
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
        [
          at, sample.entityType, sample.entityId, sample.roomId, sample.roomName, sample.paneId,
          sample.paneTitle, sample.sessionId, sample.runtimeId, sample.runtimeName, sample.providerId,
          sample.modelId, sample.processCount, sample.cpuOneCorePercent, sample.rssBytes,
          sample.memoryTotalBytes, sample.memoryAvailableBytes, sample.swapTotalBytes,
          sample.swapUsedBytes, sample.pageCacheBytes, sample.pressure
        ]
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
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await this.rollup(client, 10, 60, at, "3 hours");
      await this.rollup(client, 60, 900, at, "3 days");
      await client.query(`DELETE FROM system_analytics_resource_buckets WHERE resolution_seconds = 10 AND bucket_at < $1::timestamptz - interval '2 hours'`, [at]);
      await client.query(`DELETE FROM system_analytics_resource_buckets WHERE resolution_seconds = 60 AND bucket_at < $1::timestamptz - interval '48 hours'`, [at]);
      await client.query(`DELETE FROM system_analytics_resource_buckets WHERE resolution_seconds = 900 AND bucket_at < $1::timestamptz - interval '31 days'`, [at]);
      await client.query(
        `DELETE FROM system_analytics_model_events
         WHERE (status <> 'RUNNING' AND COALESCE(ended_at, started_at) < $1::timestamptz - interval '31 days')
            OR (status = 'RUNNING' AND updated_at < $1::timestamptz - interval '31 days')`,
        [at]
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release?.();
    }
  }

  private async rollup(
    client: { query(sql: string, values?: unknown[]): Promise<unknown> },
    sourceResolution: 10 | 60,
    targetResolution: 60 | 900,
    at: string,
    lookback: string
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
          min(cpu_min), sum(cpu_sum), max(cpu_max), min(rss_min), sum(rss_sum), max(rss_max),
          (array_agg(memory_total_bytes ORDER BY bucket_at DESC))[1],
          (array_agg(memory_available_bytes ORDER BY bucket_at DESC))[1],
          (array_agg(swap_total_bytes ORDER BY bucket_at DESC))[1],
          (array_agg(swap_used_bytes ORDER BY bucket_at DESC))[1],
          (array_agg(page_cache_bytes ORDER BY bucket_at DESC))[1],
          bool_or(pressure)
        FROM system_analytics_resource_buckets
        WHERE resolution_seconds = $2::integer AND bucket_at >= $3::timestamptz - $4::interval
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
      `,
      [targetResolution, sourceResolution, at, lookback]
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

  async dispose(): Promise<void> {
    if (!this.ownsPool) return;
    const closable = this.pool as PgPoolLike & { end?: () => Promise<void> };
    await closable.end?.();
  }
}
