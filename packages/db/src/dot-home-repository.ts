import { randomUUID } from "node:crypto";
import { agentRunCostSchema, agentRunUsageSchema, dotFeedCursor, dotUserSettingsFrom, parseDotFeedCursor, projectDotFeedRow, summarizeDotProactiveUsage,
  updateDotUserSettingsSchema, type DotFeed, type DotFeedItem, type DotFeedMessageRow, type DotProactiveUsage, type DotProactiveUsageEntry,
  type DotUserSettings, type UpdateDotUserSettings } from "@space/contracts";
import { createSpacePgPool, type PgPoolLike } from "./space-store.js";

/** Space Dots Stage 8: the user's Dot settings and each Dot's continuous feed across rooms. */
export interface DotHomeRepository {
  settings(owner: string): Promise<DotUserSettings>;
  /** Null when a referenced Dot is not the owner's. Proactive settings merge field by field. */
  updateSettings(owner: string, patch: UpdateDotUserSettings): Promise<DotUserSettings | null>;
  /**
   * The Dot's feed across the owner's workspace rooms. Asked from an Agent Proof room (`roomId`), it holds only
   * that room: proofs never show the owner's conversations, and proof work never enters the real feed.
   */
  feed(owner: string, dotId: string, page: { before?: string; after?: string; limit: number; roomId?: string | null }): Promise<DotFeed | null>;
  /** Moves the read marker forward to the item at `cursor`; returns what is still unread. A proof room never moves it. */
  markRead(owner: string, dotId: string, cursor: string, roomId?: string | null): Promise<{ unread: number } | null>;
  /**
   * What a turn in `sessionId` should know from the rest of the feed: the latest messages of the
   * Dot's other conversations since this conversation last spoke, and notices not yet given to the model.
   */
  conversationContext(owner: string, dotId: string, sessionId: string): Promise<{
    messages: Array<Pick<DotFeedItem, "author" | "origin" | "content" | "createdAt">>;
    notices: Array<{ entryId: string; content: string; createdAt: string }>;
  }>;
  markNoticesDelivered(dotId: string, entryIds: string[]): Promise<void>;
  /** False when a notice about the same source already exists for this Dot. */
  addNotice(input: { dotId: string; content: string; link: { label: string; url: string } | null; sourceHash: string | null }): Promise<boolean>;
  /** Which of these sources the Dot already sent a notice about. */
  noticedSources(dotId: string, sourceHashes: string[]): Promise<Set<string>>;
  /** Owners with a connected account whose proactive check is due and not turned off. */
  dueProactiveOwners(now: string, limit: number): Promise<Array<{ owner: string; nextCheckAt: string | null }>>;
  /** Moves the next check only if nobody else did (compare-and-set on the observed value). */
  claimProactive(owner: string, observed: string | null, next: string): Promise<boolean>;
  proactiveState(owner: string): Promise<DotProactiveState>;
  saveProactiveState(owner: string, state: Omit<DotProactiveState, "nextCheckAt">): Promise<void>;
  /** Records one model call of a proactive check; usage rows are never deleted (Record Retention Invariant 2026-10-20). */
  addProactiveUsage(owner: string, entry: DotProactiveUsageEntry): Promise<void>;
  /** Totals of the owner's proactive model calls in the last `days` days. */
  proactiveUsage(owner: string, days: number, now?: string): Promise<DotProactiveUsage>;
  dispose(): Promise<void>;
}
export interface DotProactiveState {
  nextCheckAt: string | null;
  /** Newest item seen per source key (for example `mail:<accountId>`), as an ISO time. */
  cursors: Record<string, string>;
  noticesDay: string | null;
  noticesToday: number;
  lastCheckedAt: string | null;
  lastError: string | null;
}

const FEED_MAX = 100;
const ms = (column: string) => `date_trunc('milliseconds', ${column})`;
// Fixed SQL only. A message belongs to the feed when its Dot and its room are the owner's; $4 is the proof room, if any.
const inScope = `(CASE WHEN $4::text IS NULL THEN r.kind = 'WORKSPACE' ELSE s.room_id = $4::text END)`;
function feedSql(direction: "before" | "after" | null): string {
  const order = direction === "after" ? "ASC" : "DESC";
  const after = (ts: string, id: string) => direction === null ? "" : `AND (${ms(ts)}, ${id}) ${direction === "after" ? ">" : "<"} ($5::timestamptz, $6)`;
  return `SELECT * FROM (
    (SELECT m.message_id AS id, m.role, m.content, m.status, ${ms("m.created_at")} AS "createdAt", m.session_id AS "sessionId", s.room_id AS "roomId",
      COALESCE(rp.run_id, rr.run_id) AS "runId", COALESCE(rp.client_request_id, rr.client_request_id) AS "clientRequestId",
      NOT EXISTS (SELECT 1 FROM space_agent_messages p WHERE p.session_id=m.session_id
        AND (p.created_at, p.message_id) < (m.created_at, m.message_id)) AS "conversationStart",
      false AS notice, NULL::jsonb AS link,
      CASE WHEN m.role = 'user' AND jsonb_typeof(rp.execution_context->'attachments') = 'array'
        THEN (SELECT jsonb_agg(jsonb_build_object('name', f.value->>'name', 'mimeType', f.value->>'mimeType') ORDER BY f.n)
          FROM jsonb_array_elements(rp.execution_context->'attachments') WITH ORDINALITY f(value, n) WHERE f.n <= 8) END AS attachments
    FROM space_agent_messages m
    JOIN space_dots d ON d.dot_id=m.dot_id AND d.owner_user_id=$1
    JOIN space_agent_sessions s ON s.session_id=m.session_id
    JOIN rooms r ON r.id=s.room_id AND r.owner_user_id=$1
    LEFT JOIN space_agent_runs rp ON rp.prompt_message_id=m.message_id
    LEFT JOIN space_agent_runs rr ON rr.response_message_id=m.message_id
    WHERE m.dot_id=$2 AND m.role IN ('user','assistant') AND ${inScope} ${after("m.created_at", "m.message_id")}
    ORDER BY ${ms("m.created_at")} ${order}, m.message_id ${order} LIMIT $3)
    UNION ALL
    (SELECT e.entry_id, 'assistant', e.content, 'COMPLETED', ${ms("e.created_at")}, NULL, NULL, NULL, NULL, false, true, e.link, NULL::jsonb
    FROM dot_feed_entries e JOIN space_dots d ON d.dot_id=e.dot_id AND d.owner_user_id=$1
    WHERE e.dot_id=$2 AND $4::text IS NULL ${after("e.created_at", "e.entry_id")}
    ORDER BY ${ms("e.created_at")} ${order}, e.entry_id ${order} LIMIT $3)
  ) feed ORDER BY "createdAt" ${order}, id ${order} LIMIT $3`;
}
// Cursors carry milliseconds; compare at that precision so the item at the cursor counts as read. Proof rooms have no unread count.
const unreadSql = `SELECT count(*)::int AS unread FROM (
  SELECT 1 FROM space_agent_messages m JOIN dot_feed_state f ON f.dot_id=m.dot_id
    JOIN space_agent_sessions s ON s.session_id=m.session_id JOIN rooms r ON r.id=s.room_id AND r.kind='WORKSPACE'
    WHERE m.dot_id=$1 AND m.role='assistant' AND m.status='COMPLETED' AND m.content <> '' AND date_trunc('milliseconds', m.created_at) > f.last_read_at
  UNION ALL SELECT 1 FROM dot_feed_entries e JOIN dot_feed_state f ON f.dot_id=e.dot_id WHERE e.dot_id=$1 AND date_trunc('milliseconds', e.created_at) > f.last_read_at
  LIMIT 99) unread`;
const lastActiveSql = `SELECT GREATEST(
  (SELECT max(m.updated_at) FROM space_agent_messages m JOIN space_agent_sessions s ON s.session_id=m.session_id JOIN rooms r ON r.id=s.room_id
    WHERE m.dot_id=$1 AND m.role='assistant' AND m.status IN ('RUNNING','COMPLETED') AND (CASE WHEN $2::text IS NULL THEN r.kind = 'WORKSPACE' ELSE s.room_id = $2::text END)),
  (SELECT max(created_at) FROM dot_feed_entries WHERE dot_id=$1 AND $2::text IS NULL)) AS "lastActiveAt"`;

function feedRow(row: Record<string, unknown>): DotFeedMessageRow {
  return { ...row, createdAt: new Date(row.createdAt as string).toISOString() } as unknown as DotFeedMessageRow;
}

export class PostgresDotHomeRepository implements DotHomeRepository {
  constructor(private pool: PgPoolLike) {}
  static fromConnectionString(url: string) { return new PostgresDotHomeRepository(createSpacePgPool(url, { max: 3 })); }
  /** The owner's Agent Proof room, when `roomId` is one; null for a workspace room or none. */
  private async proofRoom(owner: string, roomId: string | null | undefined): Promise<string | null> {
    if (!roomId) return null;
    const row = (await this.pool.query<{ kind: string }>(`SELECT kind FROM rooms WHERE id=$1 AND owner_user_id=$2`, [roomId, owner])).rows[0];
    return row?.kind === "AGENT_PROOF" ? roomId : null;
  }
  private async ownsDot(owner: string, dotId: string): Promise<boolean> {
    return (await this.pool.query(`SELECT 1 FROM space_dots WHERE owner_user_id=$1 AND dot_id=$2`, [owner, dotId])).rows.length === 1;
  }
  async settings(owner: string) {
    const row = (await this.pool.query<{ defaultDotId: string | null; settings: Record<string, unknown>; updatedAt: string }>(
      `SELECT s.default_dot_id AS "defaultDotId", s.settings, s.updated_at AS "updatedAt" FROM dot_user_settings s
       LEFT JOIN space_dots d ON d.dot_id=s.default_dot_id AND d.owner_user_id=s.owner_user_id
       WHERE s.owner_user_id=$1 AND (s.default_dot_id IS NULL OR d.dot_id IS NOT NULL)`, [owner])).rows[0];
    return dotUserSettingsFrom(row ? { ...row, updatedAt: new Date(row.updatedAt).toISOString() } : null);
  }
  async updateSettings(owner: string, input: UpdateDotUserSettings) {
    const patch = updateDotUserSettingsSchema.parse(input);
    for (const dotId of [patch.defaultDotId, patch.proactive?.dotId]) {
      if (dotId && !await this.ownsDot(owner, dotId)) return null;
    }
    const { defaultDotId, proactive, ...rest } = patch;
    // Top-level settings replace their field; proactive settings merge field by field.
    await this.pool.query(`INSERT INTO dot_user_settings(owner_user_id, default_dot_id, settings, updated_at)
      VALUES ($1, $2, jsonb_set($4::jsonb, '{proactive}', $5::jsonb), now())
      ON CONFLICT (owner_user_id) DO UPDATE SET
        default_dot_id=CASE WHEN $3 THEN EXCLUDED.default_dot_id ELSE dot_user_settings.default_dot_id END,
        settings=jsonb_set(dot_user_settings.settings || $4::jsonb, '{proactive}',
          COALESCE(dot_user_settings.settings->'proactive', '{}'::jsonb) || $5::jsonb),
        updated_at=now()`,
      [owner, defaultDotId ?? null, defaultDotId !== undefined, JSON.stringify(rest), JSON.stringify(proactive ?? {})]);
    return this.settings(owner);
  }
  async feed(owner: string, dotId: string, page: { before?: string; after?: string; limit: number; roomId?: string | null }) {
    if (!await this.ownsDot(owner, dotId)) return null;
    const proofRoom = await this.proofRoom(owner, page.roomId);
    if (page.before && page.after) throw new Error("Use either before or after.");
    const limit = Math.min(FEED_MAX, Math.max(1, page.limit));
    const direction = page.before ? "before" : page.after ? "after" : null;
    const cursor = page.before ?? page.after;
    const position = cursor ? parseDotFeedCursor(cursor) : null;
    // One extra row tells whether older items remain; filtered rows still advance the cursor.
    const rows = (await this.pool.query<Record<string, unknown>>(feedSql(direction),
      position ? [owner, dotId, limit + 1, proofRoom, position.createdAt, position.id] : [owner, dotId, limit + 1, proofRoom])).rows.map(feedRow);
    const more = rows.length > limit;
    const window = rows.slice(0, limit);
    const chronological = direction === "after" ? window : [...window].reverse();
    const items = chronological.map(projectDotFeedRow).filter((item): item is DotFeedItem => item !== null);
    const oldest = chronological[0];
    const newest = chronological.at(-1);
    const [unread, lastActive] = await Promise.all([
      proofRoom ? Promise.resolve({ rows: [{ unread: 0 }] }) : this.pool.query<{ unread: number }>(unreadSql, [dotId]),
      this.pool.query<{ lastActiveAt: string | null }>(lastActiveSql, [dotId, proofRoom])
    ]);
    const lastActiveAt = lastActive.rows[0]?.lastActiveAt;
    return {
      dotId, scope: proofRoom ? "ROOM" as const : "DOT" as const, items,
      nextBefore: direction !== "after" && more && oldest ? dotFeedCursor(oldest) : null,
      latestCursor: newest ? dotFeedCursor(newest) : page.after ?? null,
      lastActiveAt: lastActiveAt ? new Date(lastActiveAt).toISOString() : null,
      unread: unread.rows[0]?.unread ?? 0
    };
  }
  async markRead(owner: string, dotId: string, cursor: string, roomId?: string | null) {
    if (!await this.ownsDot(owner, dotId)) return null;
    const { createdAt } = parseDotFeedCursor(cursor);
    if (await this.proofRoom(owner, roomId)) return { unread: 0 };
    // Never ahead of now, never backwards.
    await this.pool.query(`INSERT INTO dot_feed_state(dot_id, last_read_at, updated_at) VALUES ($1, LEAST($2::timestamptz, now()), now())
      ON CONFLICT (dot_id) DO UPDATE SET last_read_at=GREATEST(dot_feed_state.last_read_at, EXCLUDED.last_read_at), updated_at=now()`,
      [dotId, createdAt]);
    return { unread: (await this.pool.query<{ unread: number }>(unreadSql, [dotId])).rows[0]?.unread ?? 0 };
  }
  async conversationContext(owner: string, dotId: string, sessionId: string) {
    if (!await this.ownsDot(owner, dotId)) return { messages: [], notices: [] };
    // A proof conversation stays apart: it neither sees the owner's conversations nor takes the Dot's notices.
    const room = (await this.pool.query<{ kind: string }>(`SELECT r.kind FROM space_agent_sessions s JOIN rooms r ON r.id=s.room_id WHERE s.session_id=$1`,
      [sessionId])).rows[0];
    if (room && room.kind !== "WORKSPACE") return { messages: [], notices: [] };
    const rows = (await this.pool.query<Record<string, unknown>>(`SELECT m.message_id AS id, m.role, m.content, m.status,
        m.created_at AS "createdAt", m.session_id AS "sessionId", s.room_id AS "roomId",
        COALESCE(rp.run_id, rr.run_id) AS "runId", COALESCE(rp.client_request_id, rr.client_request_id) AS "clientRequestId",
        false AS "conversationStart"
      FROM space_agent_messages m
      JOIN space_agent_sessions s ON s.session_id=m.session_id
      JOIN rooms r ON r.id=s.room_id AND r.owner_user_id=$1 AND r.kind='WORKSPACE'
      LEFT JOIN space_agent_runs rp ON rp.prompt_message_id=m.message_id
      LEFT JOIN space_agent_runs rr ON rr.response_message_id=m.message_id
      WHERE m.dot_id=$2 AND m.session_id<>$3 AND m.role IN ('user','assistant') AND m.status='COMPLETED'
        AND m.created_at > COALESCE((SELECT max(created_at) FROM space_agent_messages WHERE session_id=$3 AND status='COMPLETED'), '-infinity')
      ORDER BY m.created_at DESC, m.message_id DESC LIMIT 16`, [owner, dotId, sessionId])).rows.map(feedRow);
    const messages = rows.reverse().map(projectDotFeedRow)
      .filter((item): item is DotFeedItem => item?.kind === "MESSAGE").slice(-8)
      .map(({ author, origin, content, createdAt }) => ({ author, origin, content, createdAt }));
    const notices = (await this.pool.query<{ entryId: string; content: string; createdAt: string }>(`SELECT entry_id AS "entryId", content,
        created_at AS "createdAt" FROM dot_feed_entries WHERE dot_id=$1 AND delivered_to_model_at IS NULL ORDER BY created_at DESC LIMIT 5`, [dotId]))
      .rows.reverse().map((row) => ({ ...row, createdAt: new Date(row.createdAt).toISOString() }));
    return { messages, notices };
  }
  async markNoticesDelivered(dotId: string, entryIds: string[]) {
    if (!entryIds.length) return;
    await this.pool.query(`UPDATE dot_feed_entries SET delivered_to_model_at=now() WHERE dot_id=$1 AND entry_id=ANY($2::text[])
      AND delivered_to_model_at IS NULL`, [dotId, entryIds]);
  }
  async addNotice(input: { dotId: string; content: string; link: { label: string; url: string } | null; sourceHash: string | null }) {
    const inserted = await this.pool.query(`INSERT INTO dot_feed_entries(entry_id, dot_id, kind, content, link, source_hash)
      VALUES ($1, $2, 'NOTICE', $3, $4::jsonb, $5) ON CONFLICT (dot_id, source_hash) DO NOTHING RETURNING entry_id`,
      [`dot_notice:${randomUUID().replace(/-/g, "")}`, input.dotId, input.content.slice(0, 4000), input.link ? JSON.stringify(input.link) : null, input.sourceHash]);
    return inserted.rows.length === 1;
  }
  async noticedSources(dotId: string, sourceHashes: string[]) {
    if (!sourceHashes.length) return new Set<string>();
    const rows = await this.pool.query<{ hash: string }>(`SELECT source_hash AS hash FROM dot_feed_entries WHERE dot_id=$1 AND source_hash=ANY($2::text[])`,
      [dotId, sourceHashes]);
    return new Set(rows.rows.map((row) => row.hash));
  }
  async dueProactiveOwners(now: string, limit: number) {
    const rows = await this.pool.query<{ owner: string; nextCheckAt: string | null }>(`SELECT DISTINCT c.owner_user_id AS owner, p.next_check_at AS "nextCheckAt"
      FROM connector_accounts c
      LEFT JOIN dot_proactive_state p ON p.owner_user_id=c.owner_user_id
      LEFT JOIN dot_user_settings s ON s.owner_user_id=c.owner_user_id
      WHERE COALESCE(s.settings->'proactive'->>'enabled', 'true') <> 'false' AND (p.next_check_at IS NULL OR p.next_check_at <= $1::timestamptz)
      ORDER BY p.next_check_at NULLS FIRST LIMIT $2`, [now, Math.max(1, Math.min(100, limit))]);
    return rows.rows.map((row) => ({ owner: row.owner, nextCheckAt: row.nextCheckAt ? new Date(row.nextCheckAt).toISOString() : null }));
  }
  async claimProactive(owner: string, observed: string | null, next: string) {
    const claimed = await this.pool.query(`INSERT INTO dot_proactive_state(owner_user_id, next_check_at, updated_at) VALUES ($1, $3::timestamptz, now())
      ON CONFLICT (owner_user_id) DO UPDATE SET next_check_at=EXCLUDED.next_check_at, updated_at=now()
      WHERE dot_proactive_state.next_check_at IS NOT DISTINCT FROM $2::timestamptz RETURNING owner_user_id`, [owner, observed, next]);
    return claimed.rows.length === 1;
  }
  async proactiveState(owner: string) {
    const row = (await this.pool.query<Record<string, unknown>>(`SELECT next_check_at AS "nextCheckAt", cursors, notices_day::text AS "noticesDay",
      notices_today AS "noticesToday", last_checked_at AS "lastCheckedAt", last_error AS "lastError" FROM dot_proactive_state WHERE owner_user_id=$1`, [owner])).rows[0];
    const iso = (value: unknown) => value ? new Date(value as string).toISOString() : null;
    return row ? { nextCheckAt: iso(row.nextCheckAt), cursors: (row.cursors ?? {}) as Record<string, string>,
      noticesDay: (row.noticesDay as string | null) ?? null, noticesToday: Number(row.noticesToday ?? 0),
      lastCheckedAt: iso(row.lastCheckedAt), lastError: (row.lastError as string | null) ?? null }
      : { nextCheckAt: null, cursors: {}, noticesDay: null, noticesToday: 0, lastCheckedAt: null, lastError: null };
  }
  async saveProactiveState(owner: string, state: Omit<DotProactiveState, "nextCheckAt">) {
    await this.pool.query(`INSERT INTO dot_proactive_state(owner_user_id, cursors, notices_day, notices_today, last_checked_at, last_error, updated_at)
      VALUES ($1, $2::jsonb, $3::date, $4, $5::timestamptz, $6, now())
      ON CONFLICT (owner_user_id) DO UPDATE SET cursors=EXCLUDED.cursors, notices_day=EXCLUDED.notices_day, notices_today=EXCLUDED.notices_today,
        last_checked_at=EXCLUDED.last_checked_at, last_error=EXCLUDED.last_error, updated_at=now()`,
      [owner, JSON.stringify(state.cursors), state.noticesDay, state.noticesToday, state.lastCheckedAt, state.lastError?.slice(0, 500) ?? null]);
  }
  async addProactiveUsage(owner: string, entry: DotProactiveUsageEntry) {
    await this.pool.query(`INSERT INTO dot_proactive_usage(usage_id, owner_user_id, dot_id, called_at, model, status, candidates, notices, usage, cost)
      VALUES ($1, $2, $3, $4::timestamptz, $5, $6, $7, $8, $9::jsonb, $10::jsonb)`, [`dot_proactive_usage:${randomUUID().replace(/-/g, "")}`, owner, entry.dotId,
      entry.calledAt, entry.model.slice(0, 200), entry.status, entry.candidates, entry.notices, JSON.stringify(agentRunUsageSchema.parse(entry.usage)),
      JSON.stringify(agentRunCostSchema.parse(entry.cost))]);
  }
  async proactiveUsage(owner: string, days: number, now = new Date().toISOString()) {
    const window = Math.max(1, Math.min(30, Math.floor(days)));
    const rows = await this.pool.query<{ calledAt: string; dotId: string | null; model: string; status: "COMPLETED" | "FAILED"; candidates: number;
      notices: number; usage: unknown; cost: unknown }>(`SELECT called_at AS "calledAt", dot_id AS "dotId", model, status, candidates, notices, usage, cost
      FROM dot_proactive_usage WHERE owner_user_id=$1 AND called_at > $2::timestamptz - make_interval(days => $3) AND called_at <= $2::timestamptz
      ORDER BY called_at DESC LIMIT 5000`, [owner, now, window]);
    // A row this build cannot read counts as a call with unknown usage and cost, never as zero.
    const unknownCost = { status: "UNKNOWN" as const, amountUsd: null, source: null, observedAt: null, priceCatalogVersion: null, reason: "The recorded cost could not be read." };
    return summarizeDotProactiveUsage(rows.rows.map((row) => ({ ...row, calledAt: new Date(row.calledAt).toISOString(),
      usage: agentRunUsageSchema.safeParse(row.usage).data ?? { status: "UNKNOWN" as const, reason: "The recorded usage could not be read." },
      cost: agentRunCostSchema.safeParse(row.cost).data ?? unknownCost })), window);
  }
  async dispose() { await (this.pool as PgPoolLike & { end?: () => Promise<void> }).end?.(); }
}
