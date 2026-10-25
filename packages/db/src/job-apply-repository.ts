import { randomBytes } from "node:crypto";
import { createSpacePgPool, type PgPoolLike } from "./space-store.js";

/** Job Copilot: candidate profile (one per owner), the application tracker, memory, fields, events and runs. */
export interface JobApplyProfileRecord {
  ownerUserId: string;
  candidate: Record<string, unknown>;
  qaBank: unknown[];
  cvArtifactId: string | null;
  coverLetterArtifactId: string | null;
  cvText: string | null;
  mailbox: Record<string, unknown> | null;
  mailboxPasswordEncrypted: string | null;
  mailboxVerifiedAt: string | null;
  /** The Google account (email) whose Gmail and Calendar the copilot uses through the owner's Google connector. */
  googleEmail: string | null;
  /** The last "Reset and start over"; null when counting from the first application. */
  campaignStartedAt: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface JobApplyProfilePatch {
  candidate?: Record<string, unknown>;
  qaBank?: unknown[];
  cvArtifactId?: string | null;
  coverLetterArtifactId?: string | null;
  cvText?: string | null;
  mailbox?: Record<string, unknown> | null;
  mailboxPasswordEncrypted?: string | null;
  mailboxVerifiedAt?: string | null;
  googleEmail?: string | null;
}
export interface JobApplicationRecord {
  id: string;
  ownerUserId: string;
  paneId: string | null;
  company: string;
  role: string;
  ats: string;
  url: string;
  status: string;
  evidenceArtifactIds: string[];
  externalConfirmation: string | null;
  notes: string | null;
  appliedAt: string | null;
  queuePosition: number | null;
  notBefore: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface JobApplicationCreateRecord {
  ownerUserId: string;
  paneId: string | null;
  company: string;
  role: string;
  ats: string;
  url: string;
  status: string;
  notes: string | null;
  queuePosition?: number | null;
}
export interface JobApplicationPatch {
  paneId?: string | null;
  company?: string;
  role?: string;
  status?: string;
  evidenceArtifactIds?: string[];
  externalConfirmation?: string | null;
  notes?: string | null;
  appliedAt?: string | null;
  queuePosition?: number | null;
  notBefore?: string | null;
}

export interface JobApplyMemoryRecord {
  id: string;
  ownerUserId: string;
  kind: string;
  key: string | null;
  text: string;
  site: string | null;
  company: string | null;
  tags: string[];
  source: string;
  confidence: number;
  uses: number;
  pinned: boolean;
  lastUsedAt: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface JobApplyMemoryCreateRecord {
  ownerUserId: string;
  kind: string;
  key: string | null;
  text: string;
  site: string | null;
  company: string | null;
  tags: string[];
  source: string;
  confidence: number;
  pinned: boolean;
}
export interface JobApplyMemoryPatch {
  kind?: string;
  key?: string | null;
  text?: string;
  site?: string | null;
  company?: string | null;
  tags?: string[];
  source?: string;
  confidence?: number;
  pinned?: boolean;
}
export interface JobApplyMemoryQuery {
  /** Free text; Postgres full-text search, the in-memory twin scores token overlap. */
  query?: string | null;
  site?: string | null;
  company?: string | null;
  kinds?: string[];
  /** Exact normalized keys (answer bank hits for a form's labels). */
  keys?: string[];
  pinnedOnly?: boolean;
  limit: number;
}

export interface JobApplicationFieldRecord {
  id: string;
  applicationId: string;
  ownerUserId: string;
  stepIndex: number;
  stepTitle: string | null;
  label: string;
  fieldType: string;
  refHint: string | null;
  value: string | null;
  source: string;
  filledAt: string;
  verifiedAt: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface JobApplicationFieldUpsert {
  stepIndex: number;
  stepTitle: string | null;
  label: string;
  fieldType: string;
  refHint: string | null;
  value: string | null;
  source: string;
  verifiedAt: string | null;
}

export interface JobApplyEventRecord {
  id: string;
  ownerUserId: string;
  paneId: string | null;
  applicationId: string | null;
  runId: string | null;
  type: string;
  message: string;
  payload: Record<string, unknown>;
  artifactId: string | null;
  createdAt: string;
}
export interface JobApplyEventCreateRecord {
  ownerUserId: string;
  paneId: string | null;
  applicationId: string | null;
  runId: string | null;
  type: string;
  message: string;
  payload: Record<string, unknown>;
  artifactId: string | null;
}
export interface JobApplyEventFilter {
  applicationId?: string;
  runId?: string;
  paneId?: string;
  types?: string[];
  since?: string;
  limit: number;
}

export interface JobApplyRunRecord {
  id: string;
  ownerUserId: string;
  paneId: string;
  status: string;
  counters: Record<string, number>;
  currentApplicationId: string | null;
  kickoffSentAt: string | null;
  startedAt: string;
  pausedAt: string | null;
  stoppedAt: string | null;
  lastActivityAt: string;
  createdAt: string;
  updatedAt: string;
}
export interface JobApplyRunPatch {
  status?: string;
  counters?: Record<string, number>;
  currentApplicationId?: string | null;
  kickoffSentAt?: string | null;
  pausedAt?: string | null;
  stoppedAt?: string | null;
  lastActivityAt?: string;
}

/** Applications per day (in a zone), status and scope; IMPORTED is the earlier tracker, ARCHIVED predates `since`. */
export interface JobApplicationStatsRow {
  day: string;
  status: string;
  scope: "CURRENT" | "IMPORTED" | "ARCHIVED";
  count: number;
}

export interface JobApplyRepository {
  getProfile(owner: string): Promise<JobApplyProfileRecord | null>;
  /** Owners whose Job Copilot works with a Google account (mail triage runs for them). */
  listGoogleProfileOwners(): Promise<string[]>;
  upsertProfile(owner: string, patch: JobApplyProfilePatch): Promise<JobApplyProfileRecord>;
  listApplications(owner: string, filter: { status?: string; limit: number }): Promise<JobApplicationRecord[]>;
  getApplication(owner: string, id: string): Promise<JobApplicationRecord | null>;
  getApplicationByUrl(owner: string, url: string): Promise<JobApplicationRecord | null>;
  createApplication(input: JobApplicationCreateRecord): Promise<JobApplicationRecord>;
  updateApplication(owner: string, id: string, patch: JobApplicationPatch): Promise<JobApplicationRecord | null>;
  /** Only QUEUED rows may be removed; everything else is history. Returns false when nothing was deleted. */
  deleteQueuedApplication(owner: string, id: string): Promise<boolean>;
  /** Applications of one site that reached `statuses` since `sinceIso` (daily pacing caps). */
  countApplications(owner: string, ats: string, statuses: string[], sinceIso: string): Promise<number>;
  /** QUEUED rows in queue order (then creation order); `paneId` narrows to one pane's rows plus unassigned ones. */
  listQueue(owner: string, paneId: string | null): Promise<JobApplicationRecord[]>;
  /** Starts counting again when the campaign start is still `expected` (compare-and-set); null when it moved meanwhile. */
  resetCampaign(owner: string, expected: string | null): Promise<string | null>;
  /** RUNNING and PAUSED runs of every pane of the owner. */
  listActiveRuns(owner: string): Promise<JobApplyRunRecord[]>;
  /** Counts by day (YYYY-MM-DD of applied_at, else updated_at, in `tz`), status and scope. */
  applicationStats(owner: string, input: { tz: string; since: string | null; importedUrlPrefix: string }): Promise<JobApplicationStatsRow[]>;
  nextQueuePosition(owner: string): Promise<number>;
  setQueueOrder(owner: string, applicationIds: string[]): Promise<void>;

  listMemory(owner: string, query: JobApplyMemoryQuery): Promise<JobApplyMemoryRecord[]>;
  getMemory(owner: string, id: string): Promise<JobApplyMemoryRecord | null>;
  createMemory(input: JobApplyMemoryCreateRecord): Promise<JobApplyMemoryRecord>;
  /** Keyed memories (answers) are one per kind+key+site+company: an existing row is refreshed. */
  upsertMemoryByKey(input: JobApplyMemoryCreateRecord & { key: string }): Promise<JobApplyMemoryRecord>;
  updateMemory(owner: string, id: string, patch: JobApplyMemoryPatch): Promise<JobApplyMemoryRecord | null>;
  deleteMemory(owner: string, id: string): Promise<boolean>;
  touchMemory(owner: string, ids: string[], usedAtIso: string): Promise<void>;
  countMemory(owner: string): Promise<number>;

  listFields(owner: string, applicationId: string): Promise<JobApplicationFieldRecord[]>;
  upsertFields(owner: string, applicationId: string, fields: JobApplicationFieldUpsert[], filledAtIso: string): Promise<JobApplicationFieldRecord[]>;
  updateField(owner: string, id: string, patch: { value?: string | null; source?: string; verifiedAt?: string | null }): Promise<JobApplicationFieldRecord | null>;
  countFields(owner: string, applicationId: string): Promise<number>;

  createEvent(input: JobApplyEventCreateRecord): Promise<JobApplyEventRecord>;
  listEvents(owner: string, filter: JobApplyEventFilter): Promise<JobApplyEventRecord[]>;

  getActiveRun(paneId: string): Promise<JobApplyRunRecord | null>;
  getRun(owner: string, id: string): Promise<JobApplyRunRecord | null>;
  createRun(input: { ownerUserId: string; paneId: string; status: string }): Promise<JobApplyRunRecord>;
  updateRun(owner: string, id: string, patch: JobApplyRunPatch): Promise<JobApplyRunRecord | null>;
  listRuns(owner: string, paneId: string, limit: number): Promise<JobApplyRunRecord[]>;
  dispose(): Promise<void>;
}

export function newJobApplicationId(): string {
  return `jobapp:${randomBytes(9).toString("base64url")}`;
}
export function newJobApplyMemoryId(): string {
  return `jobmem:${randomBytes(9).toString("base64url")}`;
}
export function newJobApplicationFieldId(): string {
  return `jobfield:${randomBytes(9).toString("base64url")}`;
}
export function newJobApplyEventId(): string {
  return `jobevt:${randomBytes(9).toString("base64url")}`;
}
export function newJobApplyRunId(): string {
  return `jobrun:${randomBytes(9).toString("base64url")}`;
}

const profileColumns = `owner_user_id AS "ownerUserId", candidate, qa_bank AS "qaBank", cv_artifact_id AS "cvArtifactId",
  cover_letter_artifact_id AS "coverLetterArtifactId", cv_text AS "cvText", mailbox, mailbox_password_encrypted AS "mailboxPasswordEncrypted",
  mailbox_verified_at AS "mailboxVerifiedAt", google_email AS "googleEmail", campaign_started_at AS "campaignStartedAt", created_at AS "createdAt", updated_at AS "updatedAt"`;
const applicationColumns = `id, owner_user_id AS "ownerUserId", pane_id AS "paneId", company, role, ats, url, status,
  evidence_artifact_ids AS "evidenceArtifactIds", external_confirmation AS "externalConfirmation", notes, applied_at AS "appliedAt",
  queue_position AS "queuePosition", not_before AS "notBefore", created_at AS "createdAt", updated_at AS "updatedAt"`;
const memoryColumns = `id, owner_user_id AS "ownerUserId", kind, key, text, site, company, tags, source, confidence, uses, pinned,
  last_used_at AS "lastUsedAt", created_at AS "createdAt", updated_at AS "updatedAt"`;
const fieldColumns = `id, application_id AS "applicationId", owner_user_id AS "ownerUserId", step_index AS "stepIndex", step_title AS "stepTitle",
  label, field_type AS "fieldType", ref_hint AS "refHint", value, source, filled_at AS "filledAt", verified_at AS "verifiedAt",
  created_at AS "createdAt", updated_at AS "updatedAt"`;
const eventColumns = `id, owner_user_id AS "ownerUserId", pane_id AS "paneId", application_id AS "applicationId", run_id AS "runId", type, message,
  payload, artifact_id AS "artifactId", created_at AS "createdAt"`;
const runColumns = `id, owner_user_id AS "ownerUserId", pane_id AS "paneId", status, counters, current_application_id AS "currentApplicationId",
  kickoff_sent_at AS "kickoffSentAt", started_at AS "startedAt", paused_at AS "pausedAt", stopped_at AS "stoppedAt", last_activity_at AS "lastActivityAt",
  created_at AS "createdAt", updated_at AS "updatedAt"`;
const iso = (value: unknown) => value === null || value === undefined ? null : new Date(value as string).toISOString();

function profileRecord(row: Record<string, unknown>): JobApplyProfileRecord {
  return { ...(row as unknown as JobApplyProfileRecord), mailboxVerifiedAt: iso(row.mailboxVerifiedAt), campaignStartedAt: iso(row.campaignStartedAt), createdAt: iso(row.createdAt)!, updatedAt: iso(row.updatedAt)! };
}
function applicationRecord(row: Record<string, unknown>): JobApplicationRecord {
  return { ...(row as unknown as JobApplicationRecord), evidenceArtifactIds: Array.isArray(row.evidenceArtifactIds) ? row.evidenceArtifactIds as string[] : [],
    queuePosition: typeof row.queuePosition === "number" ? row.queuePosition : null,
    appliedAt: iso(row.appliedAt), notBefore: iso(row.notBefore), createdAt: iso(row.createdAt)!, updatedAt: iso(row.updatedAt)! };
}
function memoryRecord(row: Record<string, unknown>): JobApplyMemoryRecord {
  return { ...(row as unknown as JobApplyMemoryRecord), tags: Array.isArray(row.tags) ? row.tags as string[] : [], confidence: Number(row.confidence),
    uses: Number(row.uses), lastUsedAt: iso(row.lastUsedAt), createdAt: iso(row.createdAt)!, updatedAt: iso(row.updatedAt)! };
}
function fieldRecord(row: Record<string, unknown>): JobApplicationFieldRecord {
  return { ...(row as unknown as JobApplicationFieldRecord), filledAt: iso(row.filledAt)!, verifiedAt: iso(row.verifiedAt), createdAt: iso(row.createdAt)!, updatedAt: iso(row.updatedAt)! };
}
function eventRecord(row: Record<string, unknown>): JobApplyEventRecord {
  return { ...(row as unknown as JobApplyEventRecord), payload: row.payload && typeof row.payload === "object" ? row.payload as Record<string, unknown> : {}, createdAt: iso(row.createdAt)! };
}
function runRecord(row: Record<string, unknown>): JobApplyRunRecord {
  return { ...(row as unknown as JobApplyRunRecord), counters: row.counters && typeof row.counters === "object" ? row.counters as Record<string, number> : {},
    kickoffSentAt: iso(row.kickoffSentAt), startedAt: iso(row.startedAt)!, pausedAt: iso(row.pausedAt), stoppedAt: iso(row.stoppedAt),
    lastActivityAt: iso(row.lastActivityAt)!, createdAt: iso(row.createdAt)!, updatedAt: iso(row.updatedAt)! };
}

/** `websearch_to_tsquery` accepts free operator text safely; an empty query matches nothing. */
function searchText(query: string | null | undefined): string | null {
  const text = (query ?? "").replace(/[^\p{L}\p{N}\s'"-]+/gu, " ").trim();
  return text.length > 0 ? text.slice(0, 500) : null;
}

export class PostgresJobApplyRepository implements JobApplyRepository {
  constructor(private pool: PgPoolLike) {}
  static fromConnectionString(url: string) { return new PostgresJobApplyRepository(createSpacePgPool(url, { max: 2 })); }

  async getProfile(owner: string) {
    const row = (await this.pool.query<Record<string, unknown>>(`SELECT ${profileColumns} FROM job_apply_profiles WHERE owner_user_id=$1`, [owner])).rows[0];
    return row ? profileRecord(row) : null;
  }
  async listGoogleProfileOwners() {
    return (await this.pool.query<{ owner_user_id: string }>(`SELECT owner_user_id FROM job_apply_profiles WHERE google_email IS NOT NULL ORDER BY owner_user_id`)).rows.map((row) => row.owner_user_id);
  }
  async upsertProfile(owner: string, patch: JobApplyProfilePatch) {
    // COALESCE keeps untouched columns; explicit nulls clear the mailbox and artifacts.
    const has = (key: keyof JobApplyProfilePatch) => Object.hasOwn(patch, key);
    const row = (await this.pool.query<Record<string, unknown>>(`INSERT INTO job_apply_profiles(owner_user_id, candidate, qa_bank, cv_artifact_id,
        cover_letter_artifact_id, cv_text, mailbox, mailbox_password_encrypted, mailbox_verified_at, google_email)
      VALUES ($1, COALESCE($2::jsonb, '{}'::jsonb), COALESCE($3::jsonb, '[]'::jsonb), $4, $5, $6, $7::jsonb, $8, $9, $18)
      ON CONFLICT (owner_user_id) DO UPDATE SET
        candidate = CASE WHEN $10 THEN COALESCE($2::jsonb, '{}'::jsonb) ELSE job_apply_profiles.candidate END,
        qa_bank = CASE WHEN $11 THEN COALESCE($3::jsonb, '[]'::jsonb) ELSE job_apply_profiles.qa_bank END,
        cv_artifact_id = CASE WHEN $12 THEN $4 ELSE job_apply_profiles.cv_artifact_id END,
        cover_letter_artifact_id = CASE WHEN $13 THEN $5 ELSE job_apply_profiles.cover_letter_artifact_id END,
        cv_text = CASE WHEN $14 THEN $6 ELSE job_apply_profiles.cv_text END,
        mailbox = CASE WHEN $15 THEN $7::jsonb ELSE job_apply_profiles.mailbox END,
        mailbox_password_encrypted = CASE WHEN $16 THEN $8 ELSE job_apply_profiles.mailbox_password_encrypted END,
        mailbox_verified_at = CASE WHEN $17 THEN $9 ELSE job_apply_profiles.mailbox_verified_at END,
        google_email = CASE WHEN $19 THEN $18 ELSE job_apply_profiles.google_email END,
        updated_at = now()
      RETURNING ${profileColumns}`, [owner,
      patch.candidate ? JSON.stringify(patch.candidate) : null, patch.qaBank ? JSON.stringify(patch.qaBank) : null,
      patch.cvArtifactId ?? null, patch.coverLetterArtifactId ?? null, patch.cvText ?? null,
      patch.mailbox ? JSON.stringify(patch.mailbox) : null, patch.mailboxPasswordEncrypted ?? null, patch.mailboxVerifiedAt ?? null,
      has("candidate"), has("qaBank"), has("cvArtifactId"), has("coverLetterArtifactId"), has("cvText"), has("mailbox"),
      has("mailboxPasswordEncrypted"), has("mailboxVerifiedAt"), patch.googleEmail ?? null, has("googleEmail")])).rows[0]!;
    return profileRecord(row);
  }
  async listApplications(owner: string, filter: { status?: string; limit: number }) {
    const rows = filter.status
      ? (await this.pool.query<Record<string, unknown>>(`SELECT ${applicationColumns} FROM job_applications WHERE owner_user_id=$1 AND status=$2 ORDER BY updated_at DESC LIMIT $3`, [owner, filter.status, filter.limit])).rows
      : (await this.pool.query<Record<string, unknown>>(`SELECT ${applicationColumns} FROM job_applications WHERE owner_user_id=$1 ORDER BY updated_at DESC LIMIT $2`, [owner, filter.limit])).rows;
    return rows.map(applicationRecord);
  }
  async getApplication(owner: string, id: string) {
    const row = (await this.pool.query<Record<string, unknown>>(`SELECT ${applicationColumns} FROM job_applications WHERE owner_user_id=$1 AND id=$2`, [owner, id])).rows[0];
    return row ? applicationRecord(row) : null;
  }
  async getApplicationByUrl(owner: string, url: string) {
    const row = (await this.pool.query<Record<string, unknown>>(`SELECT ${applicationColumns} FROM job_applications WHERE owner_user_id=$1 AND url=$2`, [owner, url])).rows[0];
    return row ? applicationRecord(row) : null;
  }
  async createApplication(input: JobApplicationCreateRecord) {
    const row = (await this.pool.query<Record<string, unknown>>(`INSERT INTO job_applications(id, owner_user_id, pane_id, company, role, ats, url, status, notes, queue_position)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING ${applicationColumns}`,
      [newJobApplicationId(), input.ownerUserId, input.paneId, input.company, input.role, input.ats, input.url, input.status, input.notes, input.queuePosition ?? null])).rows[0]!;
    return applicationRecord(row);
  }
  async updateApplication(owner: string, id: string, patch: JobApplicationPatch) {
    const has = (key: keyof JobApplicationPatch) => Object.hasOwn(patch, key);
    const row = (await this.pool.query<Record<string, unknown>>(`UPDATE job_applications SET
        pane_id = CASE WHEN $3 THEN $4 ELSE pane_id END,
        company = CASE WHEN $5 THEN $6 ELSE company END,
        role = CASE WHEN $7 THEN $8 ELSE role END,
        status = CASE WHEN $9 THEN $10 ELSE status END,
        evidence_artifact_ids = CASE WHEN $11 THEN $12::jsonb ELSE evidence_artifact_ids END,
        external_confirmation = CASE WHEN $13 THEN $14 ELSE external_confirmation END,
        notes = CASE WHEN $15 THEN $16 ELSE notes END,
        applied_at = CASE WHEN $17 THEN $18 ELSE applied_at END,
        queue_position = CASE WHEN $19 THEN $20 ELSE queue_position END,
        not_before = CASE WHEN $21 THEN $22::timestamptz ELSE not_before END,
        updated_at = now()
      WHERE owner_user_id=$1 AND id=$2 RETURNING ${applicationColumns}`,
      [owner, id, has("paneId"), patch.paneId ?? null, has("company"), patch.company ?? null, has("role"), patch.role ?? null,
        has("status"), patch.status ?? null, has("evidenceArtifactIds"), JSON.stringify(patch.evidenceArtifactIds ?? []),
        has("externalConfirmation"), patch.externalConfirmation ?? null, has("notes"), patch.notes ?? null,
        has("appliedAt"), patch.appliedAt ?? null, has("queuePosition"), patch.queuePosition ?? null, has("notBefore"), patch.notBefore ?? null])).rows[0];
    return row ? applicationRecord(row) : null;
  }
  async deleteQueuedApplication(owner: string, id: string) {
    const result = await this.pool.query(`DELETE FROM job_applications WHERE owner_user_id=$1 AND id=$2 AND status='QUEUED'`, [owner, id]);
    return (result.rowCount ?? 0) > 0;
  }
  async countApplications(owner: string, ats: string, statuses: string[], sinceIso: string) {
    const row = (await this.pool.query<{ count: string }>(`SELECT count(*)::text AS count FROM job_applications
      WHERE owner_user_id=$1 AND ats=$2 AND status = ANY($3::text[]) AND COALESCE(applied_at, updated_at) >= $4`, [owner, ats, statuses, sinceIso])).rows[0];
    return Number.parseInt(row?.count ?? "0", 10);
  }
  async listQueue(owner: string, paneId: string | null) {
    // A posting whose pane was closed or deleted belongs to no pane, so another Job Copilot pane can start it.
    const rows = (await this.pool.query<Record<string, unknown>>(`SELECT ${applicationColumns} FROM job_applications AS a
      WHERE owner_user_id=$1 AND status='QUEUED' AND ($2::text IS NULL OR pane_id IS NULL OR pane_id=$2
        OR NOT EXISTS (SELECT 1 FROM panes AS p WHERE p.id=a.pane_id AND NOT p.is_closed))
      ORDER BY queue_position NULLS LAST, created_at ASC, id ASC`, [owner, paneId])).rows;
    return rows.map(applicationRecord);
  }
  async resetCampaign(owner: string, expected: string | null) {
    // Millisecond precision: the client sends back the ISO string it was given.
    const updated = (await this.pool.query<{ campaignStartedAt: unknown }>(`UPDATE job_apply_profiles
      SET campaign_started_at = date_trunc('milliseconds', now()), updated_at = now()
      WHERE owner_user_id=$1 AND campaign_started_at IS NOT DISTINCT FROM $2::timestamptz
      RETURNING campaign_started_at AS "campaignStartedAt"`, [owner, expected])).rows[0];
    if (updated) return iso(updated.campaignStartedAt);
    if (expected !== null) return null;
    // No profile yet: the first reset creates it; a concurrent one wins the insert and this one reports the move.
    const inserted = (await this.pool.query<{ campaignStartedAt: unknown }>(`INSERT INTO job_apply_profiles (owner_user_id, campaign_started_at)
      VALUES ($1, date_trunc('milliseconds', now())) ON CONFLICT (owner_user_id) DO NOTHING
      RETURNING campaign_started_at AS "campaignStartedAt"`, [owner])).rows[0];
    return inserted ? iso(inserted.campaignStartedAt) : null;
  }
  async applicationStats(owner: string, input: { tz: string; since: string | null; importedUrlPrefix: string }) {
    return (await this.pool.query<JobApplicationStatsRow>(`SELECT to_char(COALESCE(applied_at, updated_at) AT TIME ZONE $2, 'YYYY-MM-DD') AS day, status,
        CASE WHEN starts_with(url, $3) THEN 'IMPORTED' WHEN $4::timestamptz IS NOT NULL AND created_at < $4::timestamptz THEN 'ARCHIVED' ELSE 'CURRENT' END AS scope,
        count(*)::int AS count
      FROM job_applications WHERE owner_user_id=$1 GROUP BY 1, 2, 3`, [owner, input.tz, input.importedUrlPrefix, input.since])).rows;
  }
  async nextQueuePosition(owner: string) {
    const row = (await this.pool.query<{ next: string }>(`SELECT (COALESCE(max(queue_position), -1) + 1)::text AS next FROM job_applications WHERE owner_user_id=$1 AND status='QUEUED'`, [owner])).rows[0];
    return Number.parseInt(row?.next ?? "0", 10);
  }
  async setQueueOrder(owner: string, applicationIds: string[]) {
    // WITH ORDINALITY counts from 1; queue positions are 0-based like the in-memory twin.
    await this.pool.query(`UPDATE job_applications AS a SET queue_position = o.position - 1, updated_at = now()
      FROM unnest($2::text[]) WITH ORDINALITY AS o(id, position) WHERE a.owner_user_id=$1 AND a.id=o.id AND a.status='QUEUED'`, [owner, applicationIds]);
  }

  async listMemory(owner: string, query: JobApplyMemoryQuery) {
    const text = searchText(query.query);
    const keys = query.keys && query.keys.length > 0 ? query.keys : null;
    const kinds = query.kinds && query.kinds.length > 0 ? query.kinds : null;
    const rows = (await this.pool.query<Record<string, unknown>>(`SELECT ${memoryColumns},
        CASE WHEN $2::text IS NULL THEN 0 ELSE ts_rank(search, websearch_to_tsquery('simple', $2)) END AS rank,
        ($3::text[] IS NOT NULL AND key = ANY($3::text[])) AS key_hit
      FROM job_apply_memory
      WHERE owner_user_id=$1
        AND ($4::text[] IS NULL OR kind = ANY($4::text[]))
        AND ($5::text IS NULL OR site IS NULL OR site=$5)
        AND ($6::text IS NULL OR company IS NULL OR lower(company)=lower($6))
        AND (NOT $7::boolean OR pinned)
        AND (($2::text IS NULL AND $3::text[] IS NULL) OR ($2::text IS NOT NULL AND search @@ websearch_to_tsquery('simple', $2)) OR ($3::text[] IS NOT NULL AND key = ANY($3::text[])))
      ORDER BY key_hit DESC, pinned DESC, rank DESC, (site IS NOT NULL) DESC, (company IS NOT NULL) DESC, uses DESC, updated_at DESC
      LIMIT $8`, [owner, text, keys, kinds, query.site ?? null, query.company ?? null, query.pinnedOnly === true, query.limit])).rows;
    // rank and key_hit only order the rows; a memory carrying them fails the strict memory schema.
    return rows.map(({ rank: _rank, key_hit: _keyHit, ...row }) => memoryRecord(row));
  }
  async getMemory(owner: string, id: string) {
    const row = (await this.pool.query<Record<string, unknown>>(`SELECT ${memoryColumns} FROM job_apply_memory WHERE owner_user_id=$1 AND id=$2`, [owner, id])).rows[0];
    return row ? memoryRecord(row) : null;
  }
  async createMemory(input: JobApplyMemoryCreateRecord) {
    const row = (await this.pool.query<Record<string, unknown>>(`INSERT INTO job_apply_memory(id, owner_user_id, kind, key, text, site, company, tags, source, confidence, pinned)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8::text[],$9,$10,$11) RETURNING ${memoryColumns}`,
      [newJobApplyMemoryId(), input.ownerUserId, input.kind, input.key, input.text, input.site, input.company, input.tags, input.source, input.confidence, input.pinned])).rows[0]!;
    return memoryRecord(row);
  }
  async upsertMemoryByKey(input: JobApplyMemoryCreateRecord & { key: string }) {
    const row = (await this.pool.query<Record<string, unknown>>(`INSERT INTO job_apply_memory(id, owner_user_id, kind, key, text, site, company, tags, source, confidence, pinned)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8::text[],$9,$10,$11)
      ON CONFLICT (owner_user_id, kind, key, scope) WHERE key IS NOT NULL DO UPDATE SET
        text = EXCLUDED.text, tags = CASE WHEN cardinality(EXCLUDED.tags) > 0 THEN EXCLUDED.tags ELSE job_apply_memory.tags END,
        source = EXCLUDED.source, confidence = EXCLUDED.confidence, pinned = job_apply_memory.pinned OR EXCLUDED.pinned, updated_at = now()
      RETURNING ${memoryColumns}`,
      [newJobApplyMemoryId(), input.ownerUserId, input.kind, input.key, input.text, input.site, input.company, input.tags, input.source, input.confidence, input.pinned])).rows[0]!;
    return memoryRecord(row);
  }
  async updateMemory(owner: string, id: string, patch: JobApplyMemoryPatch) {
    const has = (key: keyof JobApplyMemoryPatch) => Object.hasOwn(patch, key);
    const row = (await this.pool.query<Record<string, unknown>>(`UPDATE job_apply_memory SET
        kind = CASE WHEN $3 THEN $4 ELSE kind END,
        key = CASE WHEN $5 THEN $6 ELSE key END,
        text = CASE WHEN $7 THEN $8 ELSE text END,
        site = CASE WHEN $9 THEN $10 ELSE site END,
        company = CASE WHEN $11 THEN $12 ELSE company END,
        tags = CASE WHEN $13 THEN $14::text[] ELSE tags END,
        source = CASE WHEN $15 THEN $16 ELSE source END,
        confidence = CASE WHEN $17 THEN $18 ELSE confidence END,
        pinned = CASE WHEN $19 THEN $20 ELSE pinned END,
        updated_at = now()
      WHERE owner_user_id=$1 AND id=$2 RETURNING ${memoryColumns}`,
      [owner, id, has("kind"), patch.kind ?? null, has("key"), patch.key ?? null, has("text"), patch.text ?? null, has("site"), patch.site ?? null,
        has("company"), patch.company ?? null, has("tags"), patch.tags ?? [], has("source"), patch.source ?? null, has("confidence"), patch.confidence ?? null,
        has("pinned"), patch.pinned ?? false])).rows[0];
    return row ? memoryRecord(row) : null;
  }
  async deleteMemory(owner: string, id: string) {
    const result = await this.pool.query(`DELETE FROM job_apply_memory WHERE owner_user_id=$1 AND id=$2`, [owner, id]);
    return (result.rowCount ?? 0) > 0;
  }
  async touchMemory(owner: string, ids: string[], usedAtIso: string) {
    if (ids.length === 0) return;
    await this.pool.query(`UPDATE job_apply_memory SET uses = uses + 1, last_used_at = $3 WHERE owner_user_id=$1 AND id = ANY($2::text[])`, [owner, ids, usedAtIso]);
  }
  async countMemory(owner: string) {
    const row = (await this.pool.query<{ count: string }>(`SELECT count(*)::text AS count FROM job_apply_memory WHERE owner_user_id=$1`, [owner])).rows[0];
    return Number.parseInt(row?.count ?? "0", 10);
  }

  async listFields(owner: string, applicationId: string) {
    const rows = (await this.pool.query<Record<string, unknown>>(`SELECT ${fieldColumns} FROM job_application_fields WHERE owner_user_id=$1 AND application_id=$2
      ORDER BY step_index ASC, created_at ASC, id ASC`, [owner, applicationId])).rows;
    return rows.map(fieldRecord);
  }
  async upsertFields(owner: string, applicationId: string, fields: JobApplicationFieldUpsert[], filledAtIso: string) {
    const records: JobApplicationFieldRecord[] = [];
    for (const field of fields) {
      const row = (await this.pool.query<Record<string, unknown>>(`INSERT INTO job_application_fields(id, application_id, owner_user_id, step_index, step_title, label, field_type, ref_hint, value, source, filled_at, verified_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
        ON CONFLICT (application_id, step_index, label) DO UPDATE SET
          step_title = COALESCE(EXCLUDED.step_title, job_application_fields.step_title), field_type = EXCLUDED.field_type,
          ref_hint = COALESCE(EXCLUDED.ref_hint, job_application_fields.ref_hint), value = EXCLUDED.value, source = EXCLUDED.source,
          filled_at = EXCLUDED.filled_at, verified_at = COALESCE(EXCLUDED.verified_at, job_application_fields.verified_at), updated_at = now()
        RETURNING ${fieldColumns}`,
        [newJobApplicationFieldId(), applicationId, owner, field.stepIndex, field.stepTitle, field.label, field.fieldType, field.refHint, field.value, field.source, filledAtIso, field.verifiedAt])).rows[0]!;
      records.push(fieldRecord(row));
    }
    return records;
  }
  async updateField(owner: string, id: string, patch: { value?: string | null; source?: string; verifiedAt?: string | null }) {
    const has = (key: "value" | "source" | "verifiedAt") => Object.hasOwn(patch, key);
    const row = (await this.pool.query<Record<string, unknown>>(`UPDATE job_application_fields SET
        value = CASE WHEN $3 THEN $4 ELSE value END, source = CASE WHEN $5 THEN $6 ELSE source END,
        verified_at = CASE WHEN $7 THEN $8 ELSE verified_at END, updated_at = now()
      WHERE owner_user_id=$1 AND id=$2 RETURNING ${fieldColumns}`,
      [owner, id, has("value"), patch.value ?? null, has("source"), patch.source ?? null, has("verifiedAt"), patch.verifiedAt ?? null])).rows[0];
    return row ? fieldRecord(row) : null;
  }
  async countFields(owner: string, applicationId: string) {
    const row = (await this.pool.query<{ count: string }>(`SELECT count(*)::text AS count FROM job_application_fields WHERE owner_user_id=$1 AND application_id=$2`, [owner, applicationId])).rows[0];
    return Number.parseInt(row?.count ?? "0", 10);
  }

  async createEvent(input: JobApplyEventCreateRecord) {
    const row = (await this.pool.query<Record<string, unknown>>(`INSERT INTO job_apply_events(id, owner_user_id, pane_id, application_id, run_id, type, message, payload, artifact_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9) RETURNING ${eventColumns}`,
      [newJobApplyEventId(), input.ownerUserId, input.paneId, input.applicationId, input.runId, input.type, input.message, JSON.stringify(input.payload ?? {}), input.artifactId])).rows[0]!;
    return eventRecord(row);
  }
  async listEvents(owner: string, filter: JobApplyEventFilter) {
    const rows = (await this.pool.query<Record<string, unknown>>(`SELECT ${eventColumns} FROM job_apply_events
      WHERE owner_user_id=$1 AND ($2::text IS NULL OR application_id=$2) AND ($3::text IS NULL OR run_id=$3) AND ($4::text IS NULL OR pane_id=$4)
        AND ($5::timestamptz IS NULL OR date_trunc('milliseconds', created_at) > $5) AND ($7::text[] IS NULL OR type = ANY($7))
      ORDER BY created_at DESC, id DESC LIMIT $6`, [owner, filter.applicationId ?? null, filter.runId ?? null, filter.paneId ?? null, filter.since ?? null, filter.limit, filter.types?.length ? filter.types : null])).rows;
    return rows.map(eventRecord);
  }

  async getActiveRun(paneId: string) {
    const row = (await this.pool.query<Record<string, unknown>>(`SELECT ${runColumns} FROM job_apply_runs WHERE pane_id=$1 AND status IN ('RUNNING','PAUSED') ORDER BY created_at DESC LIMIT 1`, [paneId])).rows[0];
    return row ? runRecord(row) : null;
  }
  async getRun(owner: string, id: string) {
    const row = (await this.pool.query<Record<string, unknown>>(`SELECT ${runColumns} FROM job_apply_runs WHERE owner_user_id=$1 AND id=$2`, [owner, id])).rows[0];
    return row ? runRecord(row) : null;
  }
  async createRun(input: { ownerUserId: string; paneId: string; status: string }) {
    const row = (await this.pool.query<Record<string, unknown>>(`INSERT INTO job_apply_runs(id, owner_user_id, pane_id, status, counters)
      VALUES ($1,$2,$3,$4,'{"taken":0,"submitted":0,"verified":0,"failed":0,"needsUser":0}'::jsonb) RETURNING ${runColumns}`,
      [newJobApplyRunId(), input.ownerUserId, input.paneId, input.status])).rows[0]!;
    return runRecord(row);
  }
  async updateRun(owner: string, id: string, patch: JobApplyRunPatch) {
    const has = (key: keyof JobApplyRunPatch) => Object.hasOwn(patch, key);
    const row = (await this.pool.query<Record<string, unknown>>(`UPDATE job_apply_runs SET
        status = CASE WHEN $3 THEN $4 ELSE status END,
        counters = CASE WHEN $5 THEN $6::jsonb ELSE counters END,
        current_application_id = CASE WHEN $7 THEN $8 ELSE current_application_id END,
        kickoff_sent_at = CASE WHEN $9 THEN $10 ELSE kickoff_sent_at END,
        paused_at = CASE WHEN $11 THEN $12 ELSE paused_at END,
        stopped_at = CASE WHEN $13 THEN $14 ELSE stopped_at END,
        last_activity_at = CASE WHEN $15 THEN $16 ELSE last_activity_at END,
        updated_at = now()
      WHERE owner_user_id=$1 AND id=$2 RETURNING ${runColumns}`,
      [owner, id, has("status"), patch.status ?? null, has("counters"), JSON.stringify(patch.counters ?? {}), has("currentApplicationId"), patch.currentApplicationId ?? null,
        has("kickoffSentAt"), patch.kickoffSentAt ?? null, has("pausedAt"), patch.pausedAt ?? null, has("stoppedAt"), patch.stoppedAt ?? null,
        has("lastActivityAt"), patch.lastActivityAt ?? null])).rows[0];
    return row ? runRecord(row) : null;
  }
  async listActiveRuns(owner: string) {
    const rows = (await this.pool.query<Record<string, unknown>>(`SELECT ${runColumns} FROM job_apply_runs WHERE owner_user_id=$1 AND status IN ('RUNNING','PAUSED') ORDER BY created_at`, [owner])).rows;
    return rows.map(runRecord);
  }
  async listRuns(owner: string, paneId: string, limit: number) {
    const rows = (await this.pool.query<Record<string, unknown>>(`SELECT ${runColumns} FROM job_apply_runs WHERE owner_user_id=$1 AND pane_id=$2 ORDER BY created_at DESC LIMIT $3`, [owner, paneId, limit])).rows;
    return rows.map(runRecord);
  }
  async dispose() { await (this.pool as PgPoolLike & { end?: () => Promise<void> }).end?.(); }
}
