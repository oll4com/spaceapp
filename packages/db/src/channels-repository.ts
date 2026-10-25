import { createHash, randomUUID } from "node:crypto";
import type { ChannelConversationKind, ChannelProvider } from "@space/contracts";
import { createSpacePgPool, type PgPoolLike } from "./space-store.js";

/** Slack and Teams conversations with Dots (Space Dots Stage 6). */
export interface ChannelIdentityRecord {
  identityId: string; provider: ChannelProvider; tenantId: string; externalUserId: string; ownerUserId: string; displayName: string | null; replyAddress: string; createdAt: string;
}
export interface ChannelThreadRecord {
  threadId: string; provider: ChannelProvider; tenantId: string; conversationId: string; threadKey: string; conversationKind: ChannelConversationKind;
  identityId: string; ownerUserId: string; dotId: string; sessionId: string | null; paneId: string | null; serviceUrl: string | null;
  replyInThread: boolean; lastDeliveredRunId: string | null; createdAt: string; updatedAt: string;
}
export interface ChannelOutboxRecord {
  /** Null for a direct message to a linked account that has no thread (`identityId`), for example a Dot's own message. */
  outboxId: string; threadId: string | null; identityId: string | null; sourceKey: string; kind: "RESULT" | "QUESTION" | "APPROVAL" | "NOTICE";
  target: "THREAD" | "DIRECT"; body: string; attempts: number;
}
export interface ChannelsRepository {
  /** Stores a one-time link code (only its hash) valid until `expiresAt`. */
  createLinkCode(owner: string, code: string, expiresAt: string): Promise<void>;
  /**
   * Uses a code once and links the external user. Null when the code is unknown, used or expired;
   * "LINKED_ELSEWHERE" when that account already belongs to another Space user (the code stays unused).
   */
  linkIdentity(code: string, identity: Omit<ChannelIdentityRecord, "identityId" | "ownerUserId" | "createdAt">): Promise<ChannelIdentityRecord | "LINKED_ELSEWHERE" | null>;
  /** Invalidates a code that was exposed, for example typed where others can read it. */
  burnLinkCode(code: string): Promise<void>;
  identity(provider: ChannelProvider, tenantId: string, externalUserId: string): Promise<ChannelIdentityRecord | null>;
  identities(owner: string): Promise<ChannelIdentityRecord[]>;
  identityById(identityId: string): Promise<ChannelIdentityRecord | null>;
  /** Keeps the direct-message address current (Teams addresses can change per bot registration). */
  updateReplyAddress(identityId: string, replyAddress: string): Promise<void>;
  unlink(owner: string, identityId: string): Promise<boolean>;
  /** Records an event id; false when it was already handled. */
  markEvent(provider: ChannelProvider, eventId: string): Promise<boolean>;
  thread(provider: ChannelProvider, tenantId: string, conversationId: string, threadKey: string): Promise<ChannelThreadRecord | null>;
  createThread(input: Omit<ChannelThreadRecord, "threadId" | "lastDeliveredRunId" | "replyInThread" | "createdAt" | "updatedAt">): Promise<ChannelThreadRecord>;
  updateThread(threadId: string, patch: Partial<Pick<ChannelThreadRecord, "sessionId" | "paneId" | "replyInThread" | "lastDeliveredRunId" | "serviceUrl">>): Promise<void>;
  threads(owner: string): Promise<ChannelThreadRecord[]>;
  threadById(threadId: string): Promise<ChannelThreadRecord | null>;
  /** The thread linked to a Dot conversation for one provider. */
  threadForSession(sessionId: string, provider: ChannelProvider): Promise<ChannelThreadRecord | null>;
  /** The most recent thread of a linked account (Teams needs its service URL to reach the user). */
  latestThreadForIdentity(identityId: string): Promise<ChannelThreadRecord | null>;
  /** Threads whose conversation exists, for the delivery sweep. */
  activeThreads(limit: number): Promise<ChannelThreadRecord[]>;
  /** Records a channel message once; false when it was already recorded. */
  queueInbox(threadId: string, eventId: string, text: string, requestKey: string): Promise<boolean>;
  /** Open requests of a thread, oldest first. */
  openInbox(threadId: string): Promise<Array<{ eventId: string; text: string; requestKey: string; status: "PENDING" | "SENT" }>>;
  markInbox(threadId: string, eventId: string, status: "SENT" | "DELIVERED" | "DROPPED"): Promise<void>;
  /** Adds an outbox row once per source key. A row without a thread is a direct message to `identityId`. */
  enqueue(input: Omit<ChannelOutboxRecord, "outboxId" | "attempts" | "identityId"> & { identityId?: string | null }): Promise<boolean>;
  /** Claims due rows for two minutes, so overlapping deliveries never send a row twice. */
  due(limit: number): Promise<ChannelOutboxRecord[]>;
  delivered(outboxId: string): Promise<void>;
  /** Schedules a retry with backoff, failing the row after `maxAttempts`. */
  retry(outboxId: string, error: string, maxAttempts: number): Promise<void>;
  /** Removes event ids older than the provider retry window. */
  pruneEvents(olderThanHours: number): Promise<number>;
  dispose(): Promise<void>;
}

const hash = (code: string) => createHash("sha256").update(`space-channel-link:${code}`).digest("hex");
const id = (prefix: string) => `${prefix}:${randomUUID().replace(/-/g, "")}`;
const iso = (value: unknown) => new Date(value as string).toISOString();
const identityColumns = `identity_id AS "identityId", provider, tenant_id AS "tenantId", external_user_id AS "externalUserId", owner_user_id AS "ownerUserId",
  display_name AS "displayName", reply_address AS "replyAddress", created_at AS "createdAt"`;
const threadColumns = `thread_id AS "threadId", provider, tenant_id AS "tenantId", conversation_id AS "conversationId", thread_key AS "threadKey",
  conversation_kind AS "conversationKind", identity_id AS "identityId", owner_user_id AS "ownerUserId", dot_id AS "dotId", session_id AS "sessionId",
  pane_id AS "paneId", service_url AS "serviceUrl", reply_in_thread AS "replyInThread", last_delivered_run_id AS "lastDeliveredRunId",
  created_at AS "createdAt", updated_at AS "updatedAt"`;
const mapIdentity = (row: ChannelIdentityRecord) => ({ ...row, createdAt: iso(row.createdAt) });
const mapThread = (row: ChannelThreadRecord) => ({ ...row, createdAt: iso(row.createdAt), updatedAt: iso(row.updatedAt) });

export class PostgresChannelsRepository implements ChannelsRepository {
  constructor(private pool: PgPoolLike) {}
  static fromConnectionString(url: string) { return new PostgresChannelsRepository(createSpacePgPool(url, { max: 2 })); }
  async createLinkCode(owner: string, code: string, expiresAt: string) {
    await this.pool.query(`INSERT INTO channel_link_codes(code_hash, owner_user_id, expires_at) VALUES ($1,$2,$3)`, [hash(code), owner, expiresAt]);
  }
  async linkIdentity(code: string, identity: Parameters<ChannelsRepository["linkIdentity"]>[1]) {
    const pending = (await this.pool.query<{ owner: string }>(`SELECT owner_user_id AS owner FROM channel_link_codes
      WHERE code_hash=$1 AND used_at IS NULL AND expires_at > now()`, [hash(code)])).rows[0];
    if (!pending) return null;
    const existing = await this.identity(identity.provider, identity.tenantId, identity.externalUserId);
    // An account linked to another Space user is never moved by a code; that user unlinks it first.
    if (existing && existing.ownerUserId !== pending.owner) return "LINKED_ELSEWHERE" as const;
    const used = (await this.pool.query<{ owner: string }>(`UPDATE channel_link_codes SET used_at=now()
      WHERE code_hash=$1 AND used_at IS NULL AND expires_at > now() RETURNING owner_user_id AS owner`, [hash(code)])).rows[0];
    if (!used) return null;
    const row = (await this.pool.query<ChannelIdentityRecord>(`INSERT INTO channel_identities(identity_id, provider, tenant_id, external_user_id, owner_user_id,
      display_name, reply_address) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (provider, tenant_id, external_user_id)
      DO UPDATE SET display_name=EXCLUDED.display_name, reply_address=EXCLUDED.reply_address
      WHERE channel_identities.owner_user_id=EXCLUDED.owner_user_id RETURNING ${identityColumns}`,
      [id("channel_identity"), identity.provider, identity.tenantId, identity.externalUserId, used.owner, identity.displayName?.slice(0, 200) ?? null,
        identity.replyAddress.slice(0, 300)])).rows[0];
    return row ? mapIdentity(row) : "LINKED_ELSEWHERE" as const;
  }
  async burnLinkCode(code: string) {
    await this.pool.query(`UPDATE channel_link_codes SET used_at=now() WHERE code_hash=$1 AND used_at IS NULL`, [hash(code)]);
  }
  async identity(provider: ChannelProvider, tenantId: string, externalUserId: string) {
    const row = (await this.pool.query<ChannelIdentityRecord>(`SELECT ${identityColumns} FROM channel_identities WHERE provider=$1 AND tenant_id=$2 AND external_user_id=$3`,
      [provider, tenantId, externalUserId])).rows[0];
    return row ? mapIdentity(row) : null;
  }
  async identities(owner: string) {
    return (await this.pool.query<ChannelIdentityRecord>(`SELECT ${identityColumns} FROM channel_identities WHERE owner_user_id=$1 ORDER BY created_at`, [owner])).rows.map(mapIdentity);
  }
  async identityById(identityId: string) {
    const row = (await this.pool.query<ChannelIdentityRecord>(`SELECT ${identityColumns} FROM channel_identities WHERE identity_id=$1`, [identityId])).rows[0];
    return row ? mapIdentity(row) : null;
  }
  async updateReplyAddress(identityId: string, replyAddress: string) {
    await this.pool.query(`UPDATE channel_identities SET reply_address=$2 WHERE identity_id=$1 AND reply_address IS DISTINCT FROM $2`, [identityId, replyAddress.slice(0, 300)]);
  }
  async unlink(owner: string, identityId: string) {
    return (await this.pool.query(`DELETE FROM channel_identities WHERE owner_user_id=$1 AND identity_id=$2 RETURNING identity_id`, [owner, identityId])).rows.length === 1;
  }
  async markEvent(provider: ChannelProvider, eventId: string) {
    return (await this.pool.query(`INSERT INTO channel_events(provider, event_id) VALUES ($1,$2) ON CONFLICT DO NOTHING RETURNING event_id`,
      [provider, eventId.slice(0, 300)])).rows.length === 1;
  }
  async thread(provider: ChannelProvider, tenantId: string, conversationId: string, threadKey: string) {
    const row = (await this.pool.query<ChannelThreadRecord>(`SELECT ${threadColumns} FROM channel_threads WHERE provider=$1 AND tenant_id=$2 AND conversation_id=$3 AND thread_key=$4`,
      [provider, tenantId, conversationId, threadKey])).rows[0];
    return row ? mapThread(row) : null;
  }
  async createThread(input: Parameters<ChannelsRepository["createThread"]>[0]) {
    // Two first messages at once create one thread; the second reads the first's row.
    const row = (await this.pool.query<ChannelThreadRecord>(`INSERT INTO channel_threads(thread_id, provider, tenant_id, conversation_id, thread_key, conversation_kind,
      identity_id, owner_user_id, dot_id, session_id, pane_id, service_url) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
      ON CONFLICT (provider, tenant_id, conversation_id, thread_key) DO NOTHING RETURNING ${threadColumns}`,
      [id("channel_thread"), input.provider, input.tenantId, input.conversationId, input.threadKey, input.conversationKind, input.identityId, input.ownerUserId,
        input.dotId, input.sessionId, input.paneId, input.serviceUrl])).rows[0];
    return row ? mapThread(row) : (await this.thread(input.provider, input.tenantId, input.conversationId, input.threadKey))!;
  }
  async updateThread(threadId: string, patch: Parameters<ChannelsRepository["updateThread"]>[1]) {
    const sets: string[] = [], values: unknown[] = [threadId];
    const set = (column: string, value: unknown) => { values.push(value); sets.push(`${column}=$${values.length}`); };
    if (patch.sessionId !== undefined) set("session_id", patch.sessionId);
    if (patch.paneId !== undefined) set("pane_id", patch.paneId);
    if (patch.replyInThread !== undefined) set("reply_in_thread", patch.replyInThread);
    if (patch.lastDeliveredRunId !== undefined) set("last_delivered_run_id", patch.lastDeliveredRunId);
    if (patch.serviceUrl !== undefined) set("service_url", patch.serviceUrl);
    if (!sets.length) return;
    await this.pool.query(`UPDATE channel_threads SET ${sets.join(", ")}, updated_at=now() WHERE thread_id=$1`, values);
  }
  async threads(owner: string) {
    return (await this.pool.query<ChannelThreadRecord>(`SELECT ${threadColumns} FROM channel_threads WHERE owner_user_id=$1 ORDER BY updated_at DESC LIMIT 50`, [owner])).rows.map(mapThread);
  }
  async threadById(threadId: string) {
    const row = (await this.pool.query<ChannelThreadRecord>(`SELECT ${threadColumns} FROM channel_threads WHERE thread_id=$1`, [threadId])).rows[0];
    return row ? mapThread(row) : null;
  }
  async threadForSession(sessionId: string, provider: ChannelProvider) {
    const row = (await this.pool.query<ChannelThreadRecord>(`SELECT ${threadColumns} FROM channel_threads WHERE session_id=$1 AND provider=$2
      ORDER BY updated_at DESC LIMIT 1`, [sessionId, provider])).rows[0];
    return row ? mapThread(row) : null;
  }
  async latestThreadForIdentity(identityId: string) {
    const row = (await this.pool.query<ChannelThreadRecord>(`SELECT ${threadColumns} FROM channel_threads WHERE identity_id=$1 ORDER BY updated_at DESC LIMIT 1`,
      [identityId])).rows[0];
    return row ? mapThread(row) : null;
  }
  async activeThreads(limit: number) {
    return (await this.pool.query<ChannelThreadRecord>(`SELECT ${threadColumns} FROM channel_threads WHERE session_id IS NOT NULL
      AND updated_at > now() - interval '14 days' ORDER BY updated_at DESC LIMIT $1`, [Math.min(500, Math.max(1, limit))])).rows.map(mapThread);
  }
  async queueInbox(threadId: string, eventId: string, text: string, requestKey: string) {
    return (await this.pool.query(`INSERT INTO channel_inbox(thread_id, event_id, text, request_key) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING event_id`,
      [threadId, eventId.slice(0, 300), text.slice(0, 8000), requestKey])).rows.length === 1;
  }
  async openInbox(threadId: string) {
    return (await this.pool.query<{ eventId: string; text: string; requestKey: string; status: "PENDING" | "SENT" }>(`SELECT event_id AS "eventId", text,
      request_key AS "requestKey", status FROM channel_inbox WHERE thread_id=$1 AND status IN ('PENDING','SENT') ORDER BY created_at, event_id LIMIT 50`, [threadId])).rows;
  }
  async markInbox(threadId: string, eventId: string, status: "SENT" | "DELIVERED" | "DROPPED") {
    await this.pool.query(`UPDATE channel_inbox SET status=$3, updated_at=now() WHERE thread_id=$1 AND event_id=$2`, [threadId, eventId, status]);
  }
  async enqueue(input: Parameters<ChannelsRepository["enqueue"]>[0]) {
    return (await this.pool.query(`INSERT INTO channel_outbox(outbox_id, thread_id, identity_id, source_key, kind, target, body) VALUES ($1,$2,$3,$4,$5,$6,$7)
      ON CONFLICT (source_key) DO NOTHING RETURNING outbox_id`, [id("channel_out"), input.threadId, input.identityId ?? null, input.sourceKey.slice(0, 300),
      input.kind, input.target, input.body.slice(0, 12000)])).rows.length === 1;
  }
  async due(limit: number) {
    return (await this.pool.query<ChannelOutboxRecord>(`UPDATE channel_outbox SET next_attempt_at=now() + interval '2 minutes'
      WHERE outbox_id IN (SELECT outbox_id FROM channel_outbox WHERE status='PENDING' AND next_attempt_at <= now() ORDER BY created_at
        LIMIT $1 FOR UPDATE SKIP LOCKED)
      RETURNING outbox_id AS "outboxId", thread_id AS "threadId", identity_id AS "identityId", source_key AS "sourceKey", kind, target, body, attempts`,
      [Math.min(100, Math.max(1, limit))])).rows;
  }
  async delivered(outboxId: string) {
    await this.pool.query(`UPDATE channel_outbox SET status='SENT', sent_at=now(), last_error=NULL WHERE outbox_id=$1`, [outboxId]);
  }
  async retry(outboxId: string, error: string, maxAttempts: number) {
    await this.pool.query(`UPDATE channel_outbox SET attempts=attempts+1, last_error=$2,
      status=CASE WHEN attempts+1 >= $3 THEN 'FAILED' ELSE 'PENDING' END,
      next_attempt_at=now() + make_interval(secs => LEAST(3600, 15 * power(2, attempts)))
      WHERE outbox_id=$1`, [outboxId, error.slice(0, 500), maxAttempts]);
  }
  async pruneEvents(olderThanHours: number) {
    return (await this.pool.query(`DELETE FROM channel_events WHERE received_at < now() - make_interval(hours => $1) RETURNING event_id`,
      [Math.max(1, Math.floor(olderThanHours))])).rows.length;
  }
  async dispose() { await (this.pool as PgPoolLike & { end?: () => Promise<void> }).end?.(); }
}
