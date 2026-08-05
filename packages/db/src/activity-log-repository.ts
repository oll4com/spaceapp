import { createSpacePgPool } from "./space-store.js";
import type { PgClientLike, PgPoolLike } from "./space-store.js";

export interface ActivityLogSettingRecord {
  enabled: boolean;
  enabledAt: string | null;
  enabledByUserId: string | null;
  disabledAt: string | null;
  disabledByUserId: string | null;
  updatedAt: string;
}

export interface ActivityLogEventRecord {
  id: string;
  roomId: string | null;
  actorUserId: string | null;
  action: string;
  reason: string | null;
  traceId: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface SetActivityLogEnabledInput {
  enabled: boolean;
  actorUserId: string;
  at: string;
}

export interface CreateActivityLogEventInput {
  id: string;
  roomId: string | null;
  actorUserId: string | null;
  action: string;
  reason: string | null;
  traceId: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface ListActivityLogEventsInput {
  roomId?: string;
  action?: string;
  actorUserId?: string;
  hasReason?: boolean;
  page?: number;
  pageSize?: number;
}

export interface ListActivityLogEventsResult {
  items: ActivityLogEventRecord[];
  total: number;
}

export interface ActivityLogRepository {
  getSetting(): Promise<ActivityLogSettingRecord>;
  setEnabled(input: SetActivityLogEnabledInput): Promise<ActivityLogSettingRecord>;
  createEvent(input: CreateActivityLogEventInput): Promise<ActivityLogEventRecord>;
  listEvents(input?: ListActivityLogEventsInput): Promise<ListActivityLogEventsResult>;
  dispose(): Promise<void>;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

export class InMemoryActivityLogRepository implements ActivityLogRepository {
  private setting: ActivityLogSettingRecord = {
    enabled: false,
    enabledAt: null,
    enabledByUserId: null,
    disabledAt: null,
    disabledByUserId: null,
    updatedAt: new Date(0).toISOString()
  };
  private readonly events = new Map<string, ActivityLogEventRecord>();

  async getSetting(): Promise<ActivityLogSettingRecord> {
    return clone(this.setting);
  }

  async setEnabled(input: SetActivityLogEnabledInput): Promise<ActivityLogSettingRecord> {
    if (this.setting.enabled === input.enabled) return clone(this.setting);
    this.setting = input.enabled
      ? {
          ...this.setting,
          enabled: true,
          enabledAt: input.at,
          enabledByUserId: input.actorUserId,
          disabledAt: null,
          disabledByUserId: null,
          updatedAt: input.at
        }
      : {
          ...this.setting,
          enabled: false,
          disabledAt: input.at,
          disabledByUserId: input.actorUserId,
          updatedAt: input.at
        };
    return clone(this.setting);
  }

  async createEvent(input: CreateActivityLogEventInput): Promise<ActivityLogEventRecord> {
    if (!this.setting.enabled) {
      throw new Error("Activity log is disabled; room creation events are not captured.");
    }
    const record: ActivityLogEventRecord = { ...input, metadata: clone(input.metadata) };
    this.events.set(input.id, record);
    return clone(record);
  }

  async listEvents(input: ListActivityLogEventsInput = {}): Promise<ListActivityLogEventsResult> {
    const page = Math.max(1, Math.trunc(input.page ?? 1));
    const pageSize = Math.max(1, Math.min(input.pageSize ?? 25, 100));
    const sorted = [...this.events.values()].sort(
      (left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id)
    );
    const filtered = sorted.filter((event) => {
      if (input.roomId && event.roomId !== input.roomId) return false;
      if (input.action && event.action !== input.action) return false;
      if (input.actorUserId) {
        const actor = event.actorUserId ?? "";
        if (!actor.toLowerCase().includes(input.actorUserId.toLowerCase())) return false;
      }
      if (input.hasReason !== undefined && (event.reason !== null) !== input.hasReason) return false;
      return true;
    });
    const start = (page - 1) * pageSize;
    return {
      items: filtered.slice(start, start + pageSize).map(clone),
      total: filtered.length
    };
  }

  async dispose(): Promise<void> {}
}

type ActivityLogPool = PgPoolLike & { end?: () => Promise<void> };

type SettingRow = Omit<ActivityLogSettingRecord, "enabledAt" | "disabledAt" | "updatedAt"> & {
  enabledAt: Date | string | null;
  disabledAt: Date | string | null;
  updatedAt: Date | string;
};

type EventRow = Omit<
  ActivityLogEventRecord,
  "roomId" | "actorUserId" | "reason" | "createdAt"
> & {
  roomId: string | null;
  actorUserId: string | null;
  reason: string | null;
  createdAt: Date | string;
};

const settingSelect = `
  SELECT
    enabled,
    enabled_at AS "enabledAt",
    enabled_by_user_id AS "enabledByUserId",
    disabled_at AS "disabledAt",
    disabled_by_user_id AS "disabledByUserId",
    updated_at AS "updatedAt"
  FROM activity_log_settings
  WHERE singleton_id = 1
`;

const eventSelect = `
  SELECT
    id,
    room_id AS "roomId",
    actor_user_id AS "actorUserId",
    action,
    reason,
    trace_id AS "traceId",
    metadata,
    created_at AS "createdAt"
  FROM activity_log_events
`;

function mapSetting(row: SettingRow): ActivityLogSettingRecord {
  return {
    enabled: row.enabled,
    enabledAt: row.enabledAt ? iso(row.enabledAt) : null,
    enabledByUserId: row.enabledByUserId,
    disabledAt: row.disabledAt ? iso(row.disabledAt) : null,
    disabledByUserId: row.disabledByUserId,
    updatedAt: iso(row.updatedAt)
  };
}

function mapEvent(row: EventRow): ActivityLogEventRecord {
  return {
    id: row.id,
    roomId: row.roomId,
    actorUserId: row.actorUserId,
    action: row.action,
    reason: row.reason,
    traceId: row.traceId,
    metadata: (
      typeof row.metadata === "object" && row.metadata !== null
        ? row.metadata
        : {}
    ) as Record<string, unknown>,
    createdAt: iso(row.createdAt)
  };
}

export class PostgresActivityLogRepository implements ActivityLogRepository {
  constructor(
    private readonly pool: ActivityLogPool,
    private readonly ownsPool = false
  ) {}

  static fromConnectionString(
    connectionString: string,
    poolOptions: { max?: number; idleTimeoutMillis?: number; connectionTimeoutMillis?: number } = {}
  ): PostgresActivityLogRepository {
    return new PostgresActivityLogRepository(createSpacePgPool(connectionString, poolOptions, 2) as ActivityLogPool, true);
  }

  async getSetting(): Promise<ActivityLogSettingRecord> {
    const result = await this.pool.query<SettingRow>(settingSelect);
    if (!result.rows[0]) throw new Error("Activity log settings singleton is missing.");
    return mapSetting(result.rows[0]);
  }

  async setEnabled(input: SetActivityLogEnabledInput): Promise<ActivityLogSettingRecord> {
    return this.withTransaction(async (client) => {
      const currentResult = await client.query<SettingRow>(`${settingSelect} FOR UPDATE`);
      const current = currentResult.rows[0] ? mapSetting(currentResult.rows[0]) : null;
      if (!current) throw new Error("Activity log settings singleton is missing.");
      if (current.enabled === input.enabled) return current;

      if (input.enabled) {
        await client.query(
          `
            UPDATE activity_log_settings
            SET
              enabled = true,
              enabled_at = $1,
              enabled_by_user_id = $2,
              disabled_at = NULL,
              disabled_by_user_id = NULL,
              updated_at = $1
            WHERE singleton_id = 1
          `,
          [input.at, input.actorUserId]
        );
      } else {
        await client.query(
          `
            UPDATE activity_log_settings
            SET
              enabled = false,
              disabled_at = $1,
              disabled_by_user_id = $2,
              updated_at = $1
            WHERE singleton_id = 1
          `,
          [input.at, input.actorUserId]
        );
      }

      const updated = await client.query<SettingRow>(settingSelect);
      if (!updated.rows[0]) throw new Error("Activity log settings singleton is missing after update.");
      return mapSetting(updated.rows[0]);
    });
  }

  async createEvent(input: CreateActivityLogEventInput): Promise<ActivityLogEventRecord> {
    try {
      return await this.withTransaction(async (client) => {
        const settingResult = await client.query<SettingRow>(`${settingSelect} FOR SHARE`);
        const setting = settingResult.rows[0] ? mapSetting(settingResult.rows[0]) : null;
        if (!setting?.enabled) {
          throw new Error("Activity log is disabled; room creation events are not captured.");
        }
        const result = await client.query<EventRow>(
          `
            INSERT INTO activity_log_events (
              id, room_id, actor_user_id, action, reason, trace_id, metadata, created_at
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            RETURNING
              id,
              room_id AS "roomId",
              actor_user_id AS "actorUserId",
              action,
              reason,
              trace_id AS "traceId",
              metadata,
              created_at AS "createdAt"
          `,
          [
            input.id,
            input.roomId,
            input.actorUserId,
            input.action,
            input.reason,
            input.traceId,
            JSON.stringify(input.metadata),
            input.createdAt
          ]
        );
        return mapEvent(result.rows[0]!);
      });
    } catch (error) {
      if (typeof error === "object" && error && "code" in error && error.code === "23505") {
        throw new Error("Activity log event already exists.");
      }
      throw error;
    }
  }

  async listEvents(input: ListActivityLogEventsInput = {}): Promise<ListActivityLogEventsResult> {
    const conditions: string[] = [];
    const values: unknown[] = [];
    if (input.roomId) {
      values.push(input.roomId);
      conditions.push(`room_id = $${values.length}`);
    }
    if (input.action) {
      values.push(input.action);
      conditions.push(`action = $${values.length}`);
    }
    if (input.actorUserId) {
      values.push(`%${escapeLikePattern(input.actorUserId)}%`);
      conditions.push(`actor_user_id ILIKE $${values.length} ESCAPE '\\'`);
    }
    if (input.hasReason !== undefined) {
      conditions.push(input.hasReason ? "reason IS NOT NULL" : "reason IS NULL");
    }
    const where = conditions.length ? ` WHERE ${conditions.join(" AND ")}` : "";
    const page = Math.max(1, Math.trunc(input.page ?? 1));
    const pageSize = Math.max(1, Math.min(input.pageSize ?? 25, 100));
    const offset = (page - 1) * pageSize;
    values.push(pageSize, offset);

    const [rowsResult, totalResult] = await Promise.all([
      this.pool.query<EventRow>(
        `${eventSelect}${where} ORDER BY created_at DESC, id DESC LIMIT $${values.length - 1} OFFSET $${values.length}`,
        values
      ),
      this.pool.query<{ count: number | string }>(
        `SELECT COUNT(*) AS count FROM activity_log_events${where}`,
        values.slice(0, -2)
      )
    ]);
    return {
      items: rowsResult.rows.map(mapEvent),
      total: Number(totalResult.rows[0]?.count ?? 0)
    };
  }

  async dispose(): Promise<void> {
    if (this.ownsPool) await this.pool.end?.();
  }

  private async withTransaction<T>(operation: (client: PgClientLike) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    await client.query("BEGIN");
    try {
      const result = await operation(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release?.();
    }
  }
}
