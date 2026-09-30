import {
  defaultStreamingBotSettings,
  streamingBotSettingsSchema,
  type StreamingBotActivity,
  type StreamingBotPlatform,
  type StreamingBotSettings,
  type UpdateStreamingBotSettingsInput
} from "@space/contracts";
import { createSpacePgPool, type PgPoolLike } from "./space-store.js";
import { randomUUID } from "node:crypto";

export interface StreamingBotMemoryRecord {
  id: string;
  title: string;
  body: string;
  status: "PENDING" | "APPROVED";
  source: "OPERATOR" | "BOT" | "LEGACY";
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface StreamingBotMemoryInput {
  title: string;
  body: string;
  source: "OPERATOR" | "BOT";
}

export interface StreamingModerationActionRecord {
  id: string;
  platform: "YOUTUBE" | "TWITCH" | "DISCORD";
  accountId: string;
  channelId: string;
  userId: string;
  messageId: string;
  decision: "ALLOW" | "REVIEW" | "WARN" | "TIMEOUT_5M" | "TIMEOUT_30M";
  reason: string;
  durationSeconds: number | null;
  result: "PENDING" | "SUCCEEDED" | "FAILED" | "UNAVAILABLE" | "REVIEW" | "UNDONE";
  platformActionId: string | null;
  safeErrorCode: string | null;
  createdAt: string;
  updatedAt: string;
}

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
  accountId: string | null;
  channelId: string | null;
  authorId: string | null;
  messageId: string | null;
  protectedAccount: boolean;
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
  accountId?: string | null;
  channelId?: string | null;
  authorId?: string | null;
  messageId?: string | null;
  protectedAccount?: boolean;
  direction: "IN" | "OUT";
  author?: string | null;
  message: string;
  reply?: string | null;
  status: "REPLIED" | "SKIPPED" | "ERROR" | "TEST";
  createdAt: string;
}

export interface StreamingBotRepository {
  moderationStrikes(platform: StreamingBotPlatform, accountId: string, channelId: string, userId: string, since: string): Promise<number>;
  recordModerationAction(input: Omit<StreamingModerationActionRecord, "createdAt" | "updatedAt">): Promise<StreamingModerationActionRecord | null>;
  updateModerationAction(id: string, result: StreamingModerationActionRecord["result"], platformActionId?: string | null, safeErrorCode?: string | null): Promise<StreamingModerationActionRecord | null>;
  listModerationActions(limit: number): Promise<StreamingModerationActionRecord[]>;
  getModerationAction(id: string): Promise<StreamingModerationActionRecord | null>;
  claimMessage(platform: StreamingBotPlatform, accountId: string, messageId: string): Promise<boolean>;
  recentReplyCount(since: string): Promise<number>;
  saveMemory(input: StreamingBotMemoryInput): Promise<StreamingBotMemoryRecord>;
  listMemory(status: "PENDING" | "APPROVED", limit: number, query?: string): Promise<StreamingBotMemoryRecord[]>;
  getMemory(id: string): Promise<StreamingBotMemoryRecord | null>;
  countMemory(status: "PENDING" | "APPROVED"): Promise<number>;
  updateMemory(id: string, version: number, input: { title?: string; body?: string; status?: "PENDING" | "APPROVED" }): Promise<StreamingBotMemoryRecord | null>;
  deleteMemory(id: string): Promise<boolean>;
  clearMemoryRecords(): Promise<number>;
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
  return "id, platform, account_id, channel_id, author_id, message_id, protected_account, direction, author, message, reply, status, created_at AS \"createdAt\"";
}

function mapActivity(row: Record<string, unknown>): StreamingBotActivityRecord {
  return {
    id: String(row.id),
    platform: row.platform as StreamingBotPlatform,
    accountId: row.account_id === null ? null : String(row.account_id),
    channelId: row.channel_id === null ? null : String(row.channel_id),
    authorId: row.author_id === null ? null : String(row.author_id),
    messageId: row.message_id === null ? null : String(row.message_id),
    protectedAccount: row.protected_account === true,
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
  private readonly memories = new Map<string, StreamingBotMemoryRecord>();
  private readonly messageReceipts = new Set<string>();
  private readonly moderationActions = new Map<string, StreamingModerationActionRecord>();

  async moderationStrikes(platform: StreamingBotPlatform, accountId: string, channelId: string, userId: string, since: string): Promise<number> {
    return [...this.moderationActions.values()].filter(item => item.platform === platform && item.accountId === accountId && item.channelId === channelId && item.userId === userId && item.createdAt >= since && item.result === "SUCCEEDED" && ["WARN", "TIMEOUT_5M", "TIMEOUT_30M"].includes(item.decision)).length;
  }

  async recordModerationAction(input: Omit<StreamingModerationActionRecord, "createdAt" | "updatedAt">): Promise<StreamingModerationActionRecord | null> {
    if ([...this.moderationActions.values()].some(item => item.platform === input.platform && item.accountId === input.accountId && item.messageId === input.messageId)) return null;
    const now = nowIso();
    const item = { ...input, createdAt: now, updatedAt: now };
    this.moderationActions.set(item.id, item);
    return structuredClone(item);
  }

  async updateModerationAction(id: string, result: StreamingModerationActionRecord["result"], platformActionId: string | null = null, safeErrorCode: string | null = null): Promise<StreamingModerationActionRecord | null> {
    const item = this.moderationActions.get(id);
    if (!item) return null;
    const updated = { ...item, result, platformActionId, safeErrorCode, updatedAt: nowIso() };
    this.moderationActions.set(id, updated);
    return structuredClone(updated);
  }

  async listModerationActions(limit: number): Promise<StreamingModerationActionRecord[]> {
    return [...this.moderationActions.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, Math.max(1, Math.min(limit, 200))).map(item => structuredClone(item));
  }

  async getModerationAction(id: string): Promise<StreamingModerationActionRecord | null> {
    return structuredClone(this.moderationActions.get(id) ?? null);
  }

  async claimMessage(platform: StreamingBotPlatform, accountId: string, messageId: string): Promise<boolean> {
    const key = `${platform}\u0000${accountId}\u0000${messageId}`;
    if (this.messageReceipts.has(key)) return false;
    this.messageReceipts.add(key);
    return true;
  }

  async recentReplyCount(since: string): Promise<number> {
    return this.activity.filter(item => item.direction === "OUT" && item.status === "REPLIED" && item.createdAt >= since).length;
  }

  async saveMemory(input: StreamingBotMemoryInput): Promise<StreamingBotMemoryRecord> {
    const now = nowIso();
    const record: StreamingBotMemoryRecord = {
      id: `streaming-memory:${randomUUID()}`, title: input.title, body: input.body,
      status: input.source === "OPERATOR" ? "APPROVED" : "PENDING", source: input.source,
      version: 1, createdAt: now, updatedAt: now
    };
    this.memories.set(record.id, record);
    return structuredClone(record);
  }

  async listMemory(status: "PENDING" | "APPROVED", limit: number, query = ""): Promise<StreamingBotMemoryRecord[]> {
    const needle = query.toLowerCase();
    return [...this.memories.values()].filter(item => item.status === status &&
      `${item.title} ${item.body}`.toLowerCase().includes(needle))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, Math.max(1, Math.min(limit, 100))).map(item => structuredClone(item));
  }

  async countMemory(status: "PENDING" | "APPROVED"): Promise<number> {
    return [...this.memories.values()].filter(item => item.status === status).length;
  }

  async getMemory(id: string): Promise<StreamingBotMemoryRecord | null> {
    return structuredClone(this.memories.get(id) ?? null);
  }

  async updateMemory(id: string, version: number, input: { title?: string; body?: string; status?: "PENDING" | "APPROVED" }): Promise<StreamingBotMemoryRecord | null> {
    const current = this.memories.get(id);
    if (!current || current.version !== version) return null;
    const updated = { ...current, ...input, version: version + 1, updatedAt: nowIso() };
    this.memories.set(id, updated);
    return structuredClone(updated);
  }

  async deleteMemory(id: string): Promise<boolean> { return this.memories.delete(id); }

  async clearMemoryRecords(): Promise<number> {
    const count = this.memories.size;
    this.memories.clear();
    return count;
  }

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
      accountId: input.accountId ?? null,
      channelId: input.channelId ?? null,
      authorId: input.authorId ?? null,
      messageId: input.messageId ?? null,
      protectedAccount: input.protectedAccount ?? false,
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
  model_selection: unknown | null;
  fallback_model_selection: unknown | null;
  memory_enabled: boolean;
  moderation_enabled: boolean;
  jev_enabled: boolean;
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
    modelSelection: row.model_selection,
    fallbackModelSelection: row.fallback_model_selection,
    memoryEnabled: row.memory_enabled,
    moderationEnabled: row.moderation_enabled,
    jevEnabled: row.jev_enabled,
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

function mapMemory(row: Record<string, unknown>): StreamingBotMemoryRecord {
  return {
    id: String(row.id), title: String(row.title), body: String(row.body),
    status: row.status as StreamingBotMemoryRecord["status"],
    source: row.source as StreamingBotMemoryRecord["source"],
    version: Number(row.version),
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at)
  };
}

function mapModerationAction(row: Record<string, unknown>): StreamingModerationActionRecord {
  return {
    id: String(row.id), platform: row.platform as StreamingModerationActionRecord["platform"],
    accountId: String(row.account_id), channelId: String(row.channel_id), userId: String(row.user_id),
    messageId: String(row.message_id), decision: row.decision as StreamingModerationActionRecord["decision"],
    reason: String(row.reason), durationSeconds: row.duration_seconds === null ? null : Number(row.duration_seconds),
    result: row.result as StreamingModerationActionRecord["result"],
    platformActionId: row.platform_action_id === null ? null : String(row.platform_action_id),
    safeErrorCode: row.safe_error_code === null ? null : String(row.safe_error_code),
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at)
  };
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

  async moderationStrikes(platform: StreamingBotPlatform, accountId: string, channelId: string, userId: string, since: string): Promise<number> {
    const result = await this.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM streaming_moderation_actions
       WHERE platform=$1 AND account_id=$2 AND channel_id=$3 AND user_id=$4 AND created_at >= $5
         AND result='SUCCEEDED' AND decision IN ('WARN','TIMEOUT_5M','TIMEOUT_30M')`,
      [platform, accountId, channelId, userId, since]
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  async recordModerationAction(input: Omit<StreamingModerationActionRecord, "createdAt" | "updatedAt">): Promise<StreamingModerationActionRecord | null> {
    const result = await this.pool.query<Record<string, unknown>>(
      `INSERT INTO streaming_moderation_actions (id,platform,account_id,channel_id,user_id,message_id,decision,reason,duration_seconds,result,platform_action_id,safe_error_code)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT (platform,account_id,message_id) DO NOTHING
       RETURNING *`,
      [input.id,input.platform,input.accountId,input.channelId,input.userId,input.messageId,input.decision,input.reason,input.durationSeconds,input.result,input.platformActionId,input.safeErrorCode]
    );
    return result.rows[0] ? mapModerationAction(result.rows[0]) : null;
  }

  async updateModerationAction(id: string, result: StreamingModerationActionRecord["result"], platformActionId: string | null = null, safeErrorCode: string | null = null): Promise<StreamingModerationActionRecord | null> {
    const rows = await this.pool.query<Record<string, unknown>>(
      `UPDATE streaming_moderation_actions SET result=$2,platform_action_id=$3,safe_error_code=$4,updated_at=now() WHERE id=$1 RETURNING *`,
      [id,result,platformActionId,safeErrorCode]
    );
    return rows.rows[0] ? mapModerationAction(rows.rows[0]) : null;
  }

  async listModerationActions(limit: number): Promise<StreamingModerationActionRecord[]> {
    const result = await this.pool.query<Record<string, unknown>>(
      `SELECT * FROM streaming_moderation_actions ORDER BY created_at DESC LIMIT $1`, [Math.max(1, Math.min(limit, 200))]
    );
    return result.rows.map(mapModerationAction);
  }

  async getModerationAction(id: string): Promise<StreamingModerationActionRecord | null> {
    const result = await this.pool.query<Record<string, unknown>>(`SELECT * FROM streaming_moderation_actions WHERE id=$1`, [id]);
    return result.rows[0] ? mapModerationAction(result.rows[0]) : null;
  }

  async claimMessage(platform: StreamingBotPlatform, accountId: string, messageId: string): Promise<boolean> {
    const result = await this.pool.query(
      `INSERT INTO streaming_bot_message_receipts (platform, account_id, message_id)
       VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`, [platform, accountId, messageId]
    );
    return (result.rowCount ?? 0) === 1;
  }

  async recentReplyCount(since: string): Promise<number> {
    const result = await this.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM streaming_bot_activity
       WHERE direction = 'OUT' AND status = 'REPLIED' AND created_at >= $1`, [since]
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  static fromConnectionString(
    connectionString: string,
    poolOptions: { max?: number; idleTimeoutMillis?: number; connectionTimeoutMillis?: number } = {}
  ): PostgresStreamingBotRepository {
    return new PostgresStreamingBotRepository(createSpacePgPool(connectionString, poolOptions, 2), true);
  }

  async saveMemory(input: StreamingBotMemoryInput): Promise<StreamingBotMemoryRecord> {
    const id = `streaming-memory:${randomUUID()}`;
    const result = await this.pool.query<Record<string, unknown>>(
      `INSERT INTO streaming_bot_memory (id, title, body, status, source)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, title, body, status, source, version, created_at, updated_at`,
      [id, input.title, input.body, input.source === "OPERATOR" ? "APPROVED" : "PENDING", input.source]
    );
    return mapMemory(result.rows[0]!);
  }

  async listMemory(status: "PENDING" | "APPROVED", limit: number, query = ""): Promise<StreamingBotMemoryRecord[]> {
    const result = await this.pool.query<Record<string, unknown>>(
      `SELECT id, title, body, status, source, version, created_at, updated_at
       FROM streaming_bot_memory WHERE status = $1 AND ($2 = '' OR title ILIKE '%' || $2 || '%' OR body ILIKE '%' || $2 || '%')
       ORDER BY updated_at DESC LIMIT $3`,
      [status, query, Math.max(1, Math.min(limit, 100))]
    );
    return result.rows.map(mapMemory);
  }

  async countMemory(status: "PENDING" | "APPROVED"): Promise<number> {
    const result = await this.pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM streaming_bot_memory WHERE status = $1", [status]
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  async getMemory(id: string): Promise<StreamingBotMemoryRecord | null> {
    const result = await this.pool.query<Record<string, unknown>>(
      "SELECT id, title, body, status, source, version, created_at, updated_at FROM streaming_bot_memory WHERE id = $1", [id]
    );
    return result.rows[0] ? mapMemory(result.rows[0]) : null;
  }

  async updateMemory(id: string, version: number, input: { title?: string; body?: string; status?: "PENDING" | "APPROVED" }): Promise<StreamingBotMemoryRecord | null> {
    const result = await this.pool.query<Record<string, unknown>>(
      `UPDATE streaming_bot_memory SET title = COALESCE($3, title), body = COALESCE($4, body),
         status = COALESCE($5, status), version = version + 1, updated_at = now()
       WHERE id = $1 AND version = $2
       RETURNING id, title, body, status, source, version, created_at, updated_at`,
      [id, version, input.title ?? null, input.body ?? null, input.status ?? null]
    );
    return result.rows[0] ? mapMemory(result.rows[0]) : null;
  }

  async deleteMemory(id: string): Promise<boolean> {
    const result = await this.pool.query("DELETE FROM streaming_bot_memory WHERE id = $1", [id]);
    return (result.rowCount ?? 0) > 0;
  }

  async clearMemoryRecords(): Promise<number> {
    const result = await this.pool.query("DELETE FROM streaming_bot_memory");
    return result.rowCount ?? 0;
  }

  async getSettings(): Promise<StreamingBotSettings> {
    const result = await this.pool.query<BotSettingsRow>(
      `SELECT version, enabled, persona, platforms, facts, faq, instructions, guardrails,
              memory_enabled, moderation_enabled, jev_enabled, overlay_ticker_enabled, model_selection, fallback_model_selection, updated_by, updated_at
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
          updated_at = $12,
          moderation_enabled = $13,
          jev_enabled = $14,
          model_selection = $15::jsonb,
          fallback_model_selection = $16::jsonb
        WHERE singleton = true AND version = $1
        RETURNING version, enabled, persona, platforms, facts, faq, instructions, guardrails,
                  memory_enabled, moderation_enabled, jev_enabled, overlay_ticker_enabled, model_selection, fallback_model_selection, updated_by, updated_at
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
        input.updatedAt,
        input.settings.moderationEnabled,
        input.settings.jevEnabled,
        input.settings.modelSelection ? JSON.stringify(input.settings.modelSelection) : null,
        input.settings.fallbackModelSelection ? JSON.stringify(input.settings.fallbackModelSelection) : null
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
      `INSERT INTO streaming_bot_activity (id, platform, account_id, channel_id, author_id, message_id, protected_account, direction, author, message, reply, status, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       RETURNING ${activitySelect()}`,
      [input.id, input.platform, input.accountId ?? null, input.channelId ?? null, input.authorId ?? null, input.messageId ?? null,
        input.protectedAccount ?? false, input.direction, input.author ?? null, input.message, input.reply ?? null, input.status, input.createdAt]
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
    accountId: record.accountId,
    channelId: record.channelId,
    authorId: record.authorId,
    messageId: record.messageId,
    protectedAccount: record.protectedAccount,
    direction: record.direction,
    author: record.author,
    message: record.message,
    reply: record.reply,
    status: record.status,
    createdAt: record.createdAt
  };
}
