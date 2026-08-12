import {
  defaultStreamingBotSettings,
  streamingBotSettingsSchema,
  type StreamingBotActivity,
  type StreamingBotPlatform,
  type StreamingBotSettings,
  type UpdateStreamingBotSettingsInput
} from "@space/contracts";
import { createSpacePgPool, type PgPoolLike } from "./space-store.js";

export interface StreamingBotChatStateRecord {
  platform: StreamingBotPlatform;
  accountId: string;
  chatId: string;
  cursor: string | null;
  lastPolledAt: string | null;
  lastReplyAt: string | null;
  pendingCount: number;
}

export interface StreamingBotQuotaRecord {
  provider: "YOUTUBE";
  day: string;
  unitsConsumed: number;
}

export interface StreamingBotActivityRecord {
  id: string;
  platform: StreamingBotPlatform;
  direction: "IN" | "OUT";
  author: string | null;
  message: string;
  reply: string | null;
  status: "REPLIED" | "SKIPPED" | "ERROR" | "TEST";
  createdAt: string;
}

export interface CreateStreamingBotActivityInput {
  id: string;
  platform: StreamingBotPlatform;
  direction: "IN" | "OUT";
  author?: string | null;
  message: string;
  reply?: string | null;
  status: "REPLIED" | "SKIPPED" | "ERROR" | "TEST";
  createdAt: string;
}

export interface StreamingBotRepository {
  getSettings(): Promise<StreamingBotSettings>;
  updateSettings(input: {
    expectedVersion: number;
    settings: UpdateStreamingBotSettingsInput;
    updatedBy: string;
    updatedAt: string;
  }): Promise<StreamingBotSettings>;
  getChatState(platform: StreamingBotPlatform, accountId: string, chatId: string): Promise<StreamingBotChatStateRecord | null>;
  upsertChatState(input: StreamingBotChatStateRecord): Promise<StreamingBotChatStateRecord>;
  listChatStates(): Promise<StreamingBotChatStateRecord[]>;
  getQuota(provider: "YOUTUBE", day: string): Promise<StreamingBotQuotaRecord>;
  consumeQuota(provider: "YOUTUBE", day: string, units: number): Promise<StreamingBotQuotaRecord>;
  listActivity(limit: number): Promise<StreamingBotActivityRecord[]>;
  appendActivity(input: CreateStreamingBotActivityInput): Promise<StreamingBotActivityRecord>;
  pruneActivity(keep: number): Promise<number>;
  clearBotMemory(roomId: string): Promise<number>;
  dispose(): Promise<void>;
}

export class StreamingBotSettingsVersionConflictError extends Error {
  constructor(readonly currentVersion: number) {
    super(`Streaming bot settings changed at version ${currentVersion}.`);
    this.name = "StreamingBotSettingsVersionConflictError";
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

function defaultSettings(): StreamingBotSettings {
  return streamingBotSettingsSchema.parse({
    ...defaultStreamingBotSettings,
    updatedAt: nowIso(),
    updatedBy: null
  });
}

function activitySelect(): string {
  return "id, platform, direction, author, message, reply, status, created_at AS \"createdAt\"";
}

function mapActivity(row: Record<string, unknown>): StreamingBotActivityRecord {
  return {
    id: String(row.id),
    platform: row.platform as StreamingBotPlatform,
    direction: row.direction as "IN" | "OUT",
    author: row.author === null ? null : String(row.author),
    message: String(row.message),
    reply: row.reply === null ? null : String(row.reply),
    status: row.status as "REPLIED" | "SKIPPED" | "ERROR" | "TEST",
    createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : String(row.createdAt)
  };
}

export class InMemoryStreamingBotRepository implements StreamingBotRepository {
  private settings: StreamingBotSettings = defaultSettings();
  private readonly chatStates = new Map<string, StreamingBotChatStateRecord>();
  private readonly quotas = new Map<string, StreamingBotQuotaRecord>();
  private readonly activity: StreamingBotActivityRecord[] = [];

  async getSettings(): Promise<StreamingBotSettings> {
    return structuredClone(this.settings);
  }

  async updateSettings(input: {
    expectedVersion: number;
    settings: UpdateStreamingBotSettingsInput;
    updatedBy: string;
    updatedAt: string;
  }): Promise<StreamingBotSettings> {
    if (this.settings.version !== input.expectedVersion) {
      throw new StreamingBotSettingsVersionConflictError(this.settings.version);
    }
    this.settings = streamingBotSettingsSchema.parse({
      ...input.settings,
      version: this.settings.version + 1,
      updatedAt: input.updatedAt,
      updatedBy: input.updatedBy
    });
    return structuredClone(this.settings);
  }

  async getChatState(platform: StreamingBotPlatform, accountId: string, chatId: string): Promise<StreamingBotChatStateRecord | null> {
    return this.chatStates.get(`${platform}\u0000${accountId}\u0000${chatId}`) ?? null;
  }

  async upsertChatState(input: StreamingBotChatStateRecord): Promise<StreamingBotChatStateRecord> {
    const record = { ...input };
    this.chatStates.set(`${input.platform}\u0000${input.accountId}\u0000${input.chatId}`, record);
    return structuredClone(record);
  }

  async listChatStates(): Promise<StreamingBotChatStateRecord[]> {
    return [...this.chatStates.values()].map((state) => structuredClone(state));
  }

  async getQuota(provider: "YOUTUBE", day: string): Promise<StreamingBotQuotaRecord> {
    const key = `${provider}\u0000${day}`;
    const existing = this.quotas.get(key);
    if (existing) return structuredClone(existing);
    const record = { provider, day, unitsConsumed: 0 };
    this.quotas.set(key, record);
    return structuredClone(record);
  }

  async consumeQuota(provider: "YOUTUBE", day: string, units: number): Promise<StreamingBotQuotaRecord> {
    const key = `${provider}\u0000${day}`;
    const existing = this.quotas.get(key) ?? { provider, day, unitsConsumed: 0 };
    const record = { ...existing, unitsConsumed: existing.unitsConsumed + units };
    this.quotas.set(key, record);
    return structuredClone(record);
  }

  async listActivity(limit: number): Promise<StreamingBotActivityRecord[]> {
    return this.activity.slice(0, Math.max(1, limit)).map((item) => structuredClone(item));
  }

  async appendActivity(input: CreateStreamingBotActivityInput): Promise<StreamingBotActivityRecord> {
    const record: StreamingBotActivityRecord = {
      id: input.id,
      platform: input.platform,
      direction: input.direction,
      author: input.author ?? null,
      message: input.message,
      reply: input.reply ?? null,
      status: input.status,
      createdAt: input.createdAt
    };
    this.activity.unshift(record);
    return structuredClone(record);
  }

  async pruneActivity(keep: number): Promise<number> {
    const removed = Math.max(0, this.activity.length - keep);
    this.activity.length = Math.min(this.activity.length, keep);
    return removed;
  }

  async clearBotMemory(_roomId: string): Promise<number> {
    return 0;
  }

  async dispose(): Promise<void> {}
}

interface BotSettingsRow {
  version: number;
  enabled: boolean;
  persona: unknown;
  platforms: unknown;
  facts: unknown;
  faq: unknown;
  instructions: string;
  guardrails: unknown;
  memory_enabled: boolean;
  overlay_ticker_enabled: boolean;
  updated_by: string | null;
  updated_at: Date;
}

function mapSettings(row: BotSettingsRow): StreamingBotSettings {
  return streamingBotSettingsSchema.parse({
    version: row.version,
    enabled: row.enabled,
    persona: row.persona,
    platforms: row.platforms,
    facts: row.facts,
    faq: row.faq,
    instructions: row.instructions,
    guardrails: row.guardrails,
    memoryEnabled: row.memory_enabled,
    overlayTickerEnabled: row.overlay_ticker_enabled,
    updatedAt: row.updated_at.toISOString(),
    updatedBy: row.updated_by
  });
}

interface ChatStateRow {
  platform: StreamingBotPlatform;
  account_id: string;
  chat_id: string;
  cursor: string | null;
  last_polled_at: Date | null;
  last_reply_at: Date | null;
  pending_count: number;
}

function mapChatState(row: ChatStateRow): StreamingBotChatStateRecord {
  return {
    platform: row.platform,
    accountId: row.account_id,
    chatId: row.chat_id,
    cursor: row.cursor,
    lastPolledAt: row.last_polled_at ? row.last_polled_at.toISOString() : null,
    lastReplyAt: row.last_reply_at ? row.last_reply_at.toISOString() : null,
    pendingCount: row.pending_count
  };
}

interface QuotaRow {
  provider: "YOUTUBE";
  day: Date;
  units_consumed: number;
}

function mapQuota(row: QuotaRow): StreamingBotQuotaRecord {
  return {
    provider: row.provider,
    day: row.day instanceof Date ? row.day.toISOString().slice(0, 10) : String(row.day),
    unitsConsumed: row.units_consumed
  };
}

export class PostgresStreamingBotRepository implements StreamingBotRepository {
  constructor(private readonly pool: PgPoolLike, private readonly ownsPool = false) {}

  static fromConnectionString(
    connectionString: string,
    poolOptions: { max?: number; idleTimeoutMillis?: number; connectionTimeoutMillis?: number } = {}
  ): PostgresStreamingBotRepository {
    return new PostgresStreamingBotRepository(createSpacePgPool(connectionString, poolOptions, 2), true);
  }

  async getSettings(): Promise<StreamingBotSettings> {
    const result = await this.pool.query<BotSettingsRow>(
      `SELECT version, enabled, persona, platforms, facts, faq, instructions, guardrails,
              memory_enabled, overlay_ticker_enabled, updated_by, updated_at
       FROM streaming_bot_settings WHERE singleton = true`
    );
    if (!result.rows[0]) return defaultSettings();
    return mapSettings(result.rows[0]);
  }

  async updateSettings(input: {
    expectedVersion: number;
    settings: UpdateStreamingBotSettingsInput;
    updatedBy: string;
    updatedAt: string;
  }): Promise<StreamingBotSettings> {
    const result = await this.pool.query<BotSettingsRow>(
      `
        UPDATE streaming_bot_settings SET
          version = version + 1,
          enabled = $2,
          persona = $3::jsonb,
          platforms = $4::jsonb,
          facts = $5::jsonb,
          faq = $6::jsonb,
          instructions = $7,
          guardrails = $8::jsonb,
          memory_enabled = $9,
          overlay_ticker_enabled = $10,
          updated_by = $11,
          updated_at = $12
        WHERE singleton = true AND version = $1
        RETURNING version, enabled, persona, platforms, facts, faq, instructions, guardrails,
                  memory_enabled, overlay_ticker_enabled, updated_by, updated_at
      `,
      [
        input.expectedVersion,
        input.settings.enabled,
        JSON.stringify(input.settings.persona),
        JSON.stringify(input.settings.platforms),
        JSON.stringify(input.settings.facts),
        JSON.stringify(input.settings.faq),
        input.settings.instructions,
        JSON.stringify(input.settings.guardrails),
        input.settings.memoryEnabled,
        input.settings.overlayTickerEnabled,
        input.updatedBy,
        input.updatedAt
      ]
    );
    if (!result.rows[0]) {
      const current = await this.getSettings();
      throw new StreamingBotSettingsVersionConflictError(current.version);
    }
    return mapSettings(result.rows[0]);
  }

  async getChatState(platform: StreamingBotPlatform, accountId: string, chatId: string): Promise<StreamingBotChatStateRecord | null> {
    const result = await this.pool.query<ChatStateRow>(
      `SELECT platform, account_id, chat_id, cursor, last_polled_at, last_reply_at, pending_count
       FROM streaming_chat_state WHERE platform = $1 AND account_id = $2 AND chat_id = $3`,
      [platform, accountId, chatId]
    );
    return result.rows[0] ? mapChatState(result.rows[0]) : null;
  }

  async upsertChatState(input: StreamingBotChatStateRecord): Promise<StreamingBotChatStateRecord> {
    const result = await this.pool.query<ChatStateRow>(
      `
        INSERT INTO streaming_chat_state (platform, account_id, chat_id, cursor, last_polled_at, last_reply_at, pending_count)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (platform, account_id, chat_id) DO UPDATE SET
          cursor = EXCLUDED.cursor,
          last_polled_at = EXCLUDED.last_polled_at,
          last_reply_at = EXCLUDED.last_reply_at,
          pending_count = EXCLUDED.pending_count
        RETURNING platform, account_id, chat_id, cursor, last_polled_at, last_reply_at, pending_count
      `,
      [
        input.platform, input.accountId, input.chatId, input.cursor,
        input.lastPolledAt, input.lastReplyAt, input.pendingCount
      ]
    );
    return mapChatState(result.rows[0]!);
  }

  async listChatStates(): Promise<StreamingBotChatStateRecord[]> {
    const result = await this.pool.query<ChatStateRow>(
      `SELECT platform, account_id, chat_id, cursor, last_polled_at, last_reply_at, pending_count
       FROM streaming_chat_state ORDER BY last_polled_at DESC NULLS LAST`
    );
    return result.rows.map(mapChatState);
  }

  async getQuota(provider: "YOUTUBE", day: string): Promise<StreamingBotQuotaRecord> {
    const result = await this.pool.query<QuotaRow>(
      `SELECT provider, day, units_consumed FROM streaming_bot_quota WHERE provider = $1 AND day = $2`,
      [provider, day]
    );
    if (result.rows[0]) return mapQuota(result.rows[0]);
    return { provider, day, unitsConsumed: 0 };
  }

  async consumeQuota(provider: "YOUTUBE", day: string, units: number): Promise<StreamingBotQuotaRecord> {
    const result = await this.pool.query<QuotaRow>(
      `
        INSERT INTO streaming_bot_quota (provider, day, units_consumed)
        VALUES ($1, $2, $3)
        ON CONFLICT (provider, day) DO UPDATE SET units_consumed = streaming_bot_quota.units_consumed + EXCLUDED.units_consumed
        RETURNING provider, day, units_consumed
      `,
      [provider, day, units]
    );
    return mapQuota(result.rows[0]!);
  }

  async listActivity(limit: number): Promise<StreamingBotActivityRecord[]> {
    const result = await this.pool.query<Record<string, unknown>>(
      `SELECT ${activitySelect()} FROM streaming_bot_activity ORDER BY created_at DESC LIMIT $1`,
      [Math.max(1, Math.min(limit, 500))]
    );
    return result.rows.map(mapActivity);
  }

  async appendActivity(input: CreateStreamingBotActivityInput): Promise<StreamingBotActivityRecord> {
    const result = await this.pool.query<Record<string, unknown>>(
      `INSERT INTO streaming_bot_activity (id, platform, direction, author, message, reply, status, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING ${activitySelect()}`,
      [input.id, input.platform, input.direction, input.author ?? null, input.message, input.reply ?? null, input.status, input.createdAt]
    );
    return mapActivity(result.rows[0]!);
  }

  async pruneActivity(keep: number): Promise<number> {
    const result = await this.pool.query<{ deleted: number }>(
      `DELETE FROM streaming_bot_activity
       WHERE id IN (
         SELECT id FROM streaming_bot_activity ORDER BY created_at DESC OFFSET $1
       )`,
      [Math.max(1, keep)]
    );
    return result.rowCount ?? 0;
  }

  async clearBotMemory(roomId: string): Promise<number> {
    const result = await this.pool.query<{ deleted: number }>(
      `DELETE FROM memory_records WHERE room_id = $1`,
      [roomId]
    );
    return result.rowCount ?? 0;
  }

  async dispose(): Promise<void> {
    if (!this.ownsPool) return;
    const maybeEnd = (this.pool as PgPoolLike & { end?: () => Promise<void> }).end;
    if (maybeEnd) await maybeEnd.call(this.pool);
  }
}

export function toPublicActivity(record: StreamingBotActivityRecord): StreamingBotActivity {
  return {
    id: record.id,
    platform: record.platform,
    direction: record.direction,
    author: record.author,
    message: record.message,
    reply: record.reply,
    status: record.status,
    createdAt: record.createdAt
  };
}