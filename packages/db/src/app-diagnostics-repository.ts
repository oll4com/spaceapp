import { createSpacePgPool } from "./space-store.js";
import type {
  AppDiagnosticsSegmentKind,
  AppDiagnosticsVideoLeaseStatus
} from "@space/contracts";
import type { PgClientLike, PgPoolLike } from "./space-store.js";

const retentionMs = 24 * 60 * 60 * 1_000;

export type AppDiagnosticsRepositoryConflictCode =
  | "CAPTURE_ID_REQUIRED"
  | "STALE_CAPTURE"
  | "VIDEO_LEASE_HELD"
  | "VIDEO_LEASE_STALE"
  | "SEGMENT_INVALID"
  | "SEGMENT_EXISTS";

export class AppDiagnosticsRepositoryConflictError extends Error {
  constructor(
    public readonly code: AppDiagnosticsRepositoryConflictCode,
    message: string
  ) {
    super(message);
    this.name = "AppDiagnosticsRepositoryConflictError";
  }
}

export interface AppDiagnosticsSettingRecord {
  enabled: boolean;
  activeCaptureId: string | null;
  enabledAt: string | null;
  enabledByUserId: string | null;
  disabledAt: string | null;
  disabledByUserId: string | null;
  droppedEvents: number;
  quotaDrops: number;
  rejectedUploads: number;
  updatedAt: string;
}

export interface AppDiagnosticsCaptureRecord {
  captureId: string;
  startedAt: string;
  startedByUserId: string | null;
  endedAt: string | null;
  endedByUserId: string | null;
}

export interface AppDiagnosticsVideoLeaseRecord {
  leaseId: string;
  captureId: string;
  clientId: string;
  pageClientId: string;
  userId: string | null;
  status: AppDiagnosticsVideoLeaseStatus;
  acquiredAt: string;
  heartbeatAt: string;
  expiresAt: string;
  releasedAt: string | null;
}

export interface AppDiagnosticsSegmentRecord {
  segmentId: string;
  captureId: string;
  clientId: string;
  batchId?: string | null;
  batchFingerprint?: string | null;
  leaseId: string | null;
  kind: AppDiagnosticsSegmentKind;
  relativePath: string;
  mimeType: "application/x-ndjson+gzip" | "application/json+gzip" | "video/webm";
  byteSize: number;
  firstEventSequence: number | null;
  lastEventSequence: number | null;
  startedAt: string;
  endedAt: string;
  expiresAt: string;
}

export interface AppDiagnosticsUsage {
  technicalBytes: number;
  visualBytes: number;
  totalBytes: number;
  segmentCount: number;
}

export interface SetAppDiagnosticsEnabledInput {
  isEnabled: boolean;
  captureId: string | null;
  actorUserId: string;
  at: string;
}

export interface AcquireAppDiagnosticsVideoLeaseRecordInput {
  leaseId: string;
  captureId: string;
  clientId: string;
  pageClientId: string;
  userId: string;
  acquiredAt: string;
  expiresAt: string;
}

export interface HeartbeatAppDiagnosticsVideoLeaseInput {
  leaseId: string;
  captureId: string;
  userId: string;
  at: string;
  expiresAt: string;
}

export interface ReleaseAppDiagnosticsVideoLeaseInput {
  leaseId: string;
  userId: string;
  at: string;
}

export interface AppDiagnosticsSegmentListInput {
  captureId?: string;
  batchId?: string;
  kind?: AppDiagnosticsSegmentKind;
  kinds?: AppDiagnosticsSegmentKind[];
  expiresAfter?: string;
  oldestFirst?: boolean;
  afterEndedAt?: string;
  afterSegmentId?: string;
  offset?: number;
  limit?: number;
}

export interface AppDiagnosticsCounterIncrement {
  droppedEvents?: number;
  quotaDrops?: number;
  rejectedUploads?: number;
}

export interface AppDiagnosticsRepository {
  getSetting(): Promise<AppDiagnosticsSettingRecord>;
  setEnabled(input: SetAppDiagnosticsEnabledInput): Promise<AppDiagnosticsSettingRecord>;
  listCaptures(): Promise<AppDiagnosticsCaptureRecord[]>;
  getActiveVideoLease(at: string): Promise<AppDiagnosticsVideoLeaseRecord | null>;
  getVideoLease(leaseId: string): Promise<AppDiagnosticsVideoLeaseRecord | null>;
  acquireVideoLease(input: AcquireAppDiagnosticsVideoLeaseRecordInput): Promise<AppDiagnosticsVideoLeaseRecord>;
  heartbeatVideoLease(input: HeartbeatAppDiagnosticsVideoLeaseInput): Promise<AppDiagnosticsVideoLeaseRecord>;
  releaseVideoLease(input: ReleaseAppDiagnosticsVideoLeaseInput): Promise<AppDiagnosticsVideoLeaseRecord>;
  createSegment(input: AppDiagnosticsSegmentRecord): Promise<AppDiagnosticsSegmentRecord>;
  getSegment(segmentId: string): Promise<AppDiagnosticsSegmentRecord | null>;
  getTechnicalSegmentByBatch(
    captureId: string,
    clientId: string,
    batchId: string
  ): Promise<AppDiagnosticsSegmentRecord | null>;
  listSegments(input?: AppDiagnosticsSegmentListInput): Promise<AppDiagnosticsSegmentRecord[]>;
  countSegments(input?: AppDiagnosticsSegmentListInput): Promise<number>;
  listExpiredSegments(at: string): Promise<AppDiagnosticsSegmentRecord[]>;
  deleteSegments(segmentIds: string[]): Promise<number>;
  getUsage(): Promise<AppDiagnosticsUsage>;
  incrementCounters(input: AppDiagnosticsCounterIncrement): Promise<AppDiagnosticsSettingRecord>;
  pruneExpiredMetadata(at: string): Promise<{ leasesDeleted: number; capturesDeleted: number }>;
  dispose(): Promise<void>;
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function assertSegmentRetention(segment: AppDiagnosticsSegmentRecord): void {
  if (Date.parse(segment.expiresAt) - Date.parse(segment.endedAt) !== retentionMs) {
    throw new AppDiagnosticsRepositoryConflictError(
      "SEGMENT_INVALID",
      "Diagnostics segments must expire exactly 24 hours after they end."
    );
  }
  if (
    Date.parse(segment.endedAt) < Date.parse(segment.startedAt) ||
    segment.byteSize < 0 ||
    !Number.isSafeInteger(segment.byteSize)
  ) {
    throw new AppDiagnosticsRepositoryConflictError("SEGMENT_INVALID", "Diagnostics segment metadata is invalid.");
  }
}

function assertSegmentCursor(input: AppDiagnosticsSegmentListInput): void {
  if ((input.afterEndedAt === undefined) !== (input.afterSegmentId === undefined)) {
    throw new Error("Diagnostics segment cursor requires endedAt and segmentId.");
  }
}

export class InMemoryAppDiagnosticsRepository implements AppDiagnosticsRepository {
  private setting: AppDiagnosticsSettingRecord = {
    enabled: false,
    activeCaptureId: null,
    enabledAt: null,
    enabledByUserId: null,
    disabledAt: null,
    disabledByUserId: null,
    droppedEvents: 0,
    quotaDrops: 0,
    rejectedUploads: 0,
    updatedAt: new Date(0).toISOString()
  };
  private readonly captures = new Map<string, AppDiagnosticsCaptureRecord>();
  private readonly leases = new Map<string, AppDiagnosticsVideoLeaseRecord>();
  private readonly segments = new Map<string, AppDiagnosticsSegmentRecord>();

  async getSetting(): Promise<AppDiagnosticsSettingRecord> {
    return clone(this.setting);
  }

  async setEnabled(input: SetAppDiagnosticsEnabledInput): Promise<AppDiagnosticsSettingRecord> {
    if (this.setting.enabled === input.isEnabled) return clone(this.setting);

    if (input.isEnabled) {
      if (!input.captureId) {
        throw new AppDiagnosticsRepositoryConflictError("CAPTURE_ID_REQUIRED", "A capture ID is required.");
      }
      if (this.captures.has(input.captureId)) {
        throw new AppDiagnosticsRepositoryConflictError("STALE_CAPTURE", "Capture ID already exists.");
      }
      this.captures.set(input.captureId, {
        captureId: input.captureId,
        startedAt: input.at,
        startedByUserId: input.actorUserId,
        endedAt: null,
        endedByUserId: null
      });
      this.setting = {
        ...this.setting,
        enabled: true,
        activeCaptureId: input.captureId,
        enabledAt: input.at,
        enabledByUserId: input.actorUserId,
        disabledAt: null,
        disabledByUserId: null,
        updatedAt: input.at
      };
      return clone(this.setting);
    }

    const captureId = this.setting.activeCaptureId;
    if (captureId) {
      const capture = this.captures.get(captureId);
      if (capture) {
        this.captures.set(captureId, {
          ...capture,
          endedAt: input.at,
          endedByUserId: input.actorUserId
        });
      }
      for (const [leaseId, lease] of this.leases) {
        if (lease.captureId === captureId && lease.status === "ACTIVE") {
          this.leases.set(leaseId, { ...lease, status: "REVOKED", releasedAt: input.at });
        }
      }
    }
    this.setting = {
      ...this.setting,
      enabled: false,
      activeCaptureId: null,
      disabledAt: input.at,
      disabledByUserId: input.actorUserId,
      updatedAt: input.at
    };
    return clone(this.setting);
  }

  async listCaptures(): Promise<AppDiagnosticsCaptureRecord[]> {
    return [...this.captures.values()]
      .sort((left, right) => left.startedAt.localeCompare(right.startedAt))
      .map(clone);
  }

  async getActiveVideoLease(at: string): Promise<AppDiagnosticsVideoLeaseRecord | null> {
    this.expireLeases(at);
    const lease = [...this.leases.values()].find((candidate) => candidate.status === "ACTIVE");
    return lease ? clone(lease) : null;
  }

  async getVideoLease(leaseId: string): Promise<AppDiagnosticsVideoLeaseRecord | null> {
    const lease = this.leases.get(leaseId);
    return lease ? clone(lease) : null;
  }

  async acquireVideoLease(
    input: AcquireAppDiagnosticsVideoLeaseRecordInput
  ): Promise<AppDiagnosticsVideoLeaseRecord> {
    this.expireLeases(input.acquiredAt);
    if (!this.setting.enabled || this.setting.activeCaptureId !== input.captureId) {
      throw new AppDiagnosticsRepositoryConflictError("STALE_CAPTURE", "The diagnostics capture is no longer active.");
    }
    if ([...this.leases.values()].some((lease) => lease.status === "ACTIVE")) {
      throw new AppDiagnosticsRepositoryConflictError("VIDEO_LEASE_HELD", "Another diagnostics recorder is active.");
    }
    const lease: AppDiagnosticsVideoLeaseRecord = {
      ...input,
      status: "ACTIVE",
      heartbeatAt: input.acquiredAt,
      releasedAt: null
    };
    this.leases.set(lease.leaseId, lease);
    return clone(lease);
  }

  async heartbeatVideoLease(
    input: HeartbeatAppDiagnosticsVideoLeaseInput
  ): Promise<AppDiagnosticsVideoLeaseRecord> {
    this.expireLeases(input.at);
    const lease = this.leases.get(input.leaseId);
    if (
      !lease ||
      lease.status !== "ACTIVE" ||
      lease.captureId !== input.captureId ||
      lease.userId !== input.userId ||
      !this.setting.enabled ||
      this.setting.activeCaptureId !== input.captureId
    ) {
      throw new AppDiagnosticsRepositoryConflictError("VIDEO_LEASE_STALE", "The diagnostics recorder lease is stale.");
    }
    const updated = { ...lease, heartbeatAt: input.at, expiresAt: input.expiresAt };
    this.leases.set(input.leaseId, updated);
    return clone(updated);
  }

  async releaseVideoLease(
    input: ReleaseAppDiagnosticsVideoLeaseInput
  ): Promise<AppDiagnosticsVideoLeaseRecord> {
    const lease = this.leases.get(input.leaseId);
    if (!lease || lease.userId !== input.userId) {
      throw new AppDiagnosticsRepositoryConflictError("VIDEO_LEASE_STALE", "The diagnostics recorder lease is stale.");
    }
    if (lease.status !== "ACTIVE") return clone(lease);
    const updated: AppDiagnosticsVideoLeaseRecord = {
      ...lease,
      status: "RELEASED",
      releasedAt: input.at
    };
    this.leases.set(input.leaseId, updated);
    return clone(updated);
  }

  async createSegment(input: AppDiagnosticsSegmentRecord): Promise<AppDiagnosticsSegmentRecord> {
    assertSegmentRetention(input);
    if (!this.setting.enabled || this.setting.activeCaptureId !== input.captureId) {
      throw new AppDiagnosticsRepositoryConflictError("STALE_CAPTURE", "The diagnostics capture is no longer active.");
    }
    if (this.segments.has(input.segmentId)) {
      throw new AppDiagnosticsRepositoryConflictError("SEGMENT_EXISTS", "Diagnostics segment already exists.");
    }
    if (
      input.kind === "TECHNICAL" &&
      input.batchId &&
      [...this.segments.values()].some((segment) => (
        segment.kind === "TECHNICAL" &&
        segment.captureId === input.captureId &&
        segment.clientId === input.clientId &&
        segment.batchId === input.batchId
      ))
    ) {
      throw new AppDiagnosticsRepositoryConflictError("SEGMENT_EXISTS", "Diagnostics batch already exists.");
    }
    if (input.leaseId) {
      const lease = this.leases.get(input.leaseId);
      if (!lease || lease.status !== "ACTIVE" || lease.captureId !== input.captureId) {
        throw new AppDiagnosticsRepositoryConflictError("VIDEO_LEASE_STALE", "The diagnostics recorder lease is stale.");
      }
    }
    this.segments.set(input.segmentId, clone(input));
    return clone(input);
  }

  async getSegment(segmentId: string): Promise<AppDiagnosticsSegmentRecord | null> {
    const segment = this.segments.get(segmentId);
    return segment ? clone(segment) : null;
  }

  async getTechnicalSegmentByBatch(
    captureId: string,
    clientId: string,
    batchId: string
  ): Promise<AppDiagnosticsSegmentRecord | null> {
    const segment = [...this.segments.values()].find((candidate) => (
      candidate.kind === "TECHNICAL" &&
      candidate.captureId === captureId &&
      candidate.clientId === clientId &&
      candidate.batchId === batchId
    ));
    return segment ? clone(segment) : null;
  }

  async listSegments(input: AppDiagnosticsSegmentListInput = {}): Promise<AppDiagnosticsSegmentRecord[]> {
    assertSegmentCursor(input);
    const limit = Math.max(1, Math.min(input.limit ?? 10_000, 10_000));
    const offset = Math.max(0, Math.trunc(input.offset ?? 0));
    const kinds = input.kinds ? new Set(input.kinds) : null;
    const after = input.afterEndedAt && input.afterSegmentId
      ? { endedAt: input.afterEndedAt, segmentId: input.afterSegmentId }
      : null;
    return [...this.segments.values()]
      .filter((segment) => !input.captureId || segment.captureId === input.captureId)
      .filter((segment) => !input.batchId || segment.batchId === input.batchId)
      .filter((segment) => !input.kind || segment.kind === input.kind)
      .filter((segment) => !kinds || kinds.has(segment.kind))
      .filter((segment) => !input.expiresAfter || segment.expiresAt > input.expiresAfter)
      .filter((segment) => {
        if (!after) return true;
        const order = segment.endedAt.localeCompare(after.endedAt) ||
          segment.segmentId.localeCompare(after.segmentId);
        return input.oldestFirst ? order > 0 : order < 0;
      })
      .sort((left, right) => {
        const order = left.endedAt.localeCompare(right.endedAt) || left.segmentId.localeCompare(right.segmentId);
        return input.oldestFirst ? order : -order;
      })
      .slice(offset, offset + limit)
      .map(clone);
  }

  async countSegments(input: AppDiagnosticsSegmentListInput = {}): Promise<number> {
    const kinds = input.kinds ? new Set(input.kinds) : null;
    return [...this.segments.values()]
      .filter((segment) => !input.captureId || segment.captureId === input.captureId)
      .filter((segment) => !input.batchId || segment.batchId === input.batchId)
      .filter((segment) => !input.kind || segment.kind === input.kind)
      .filter((segment) => !kinds || kinds.has(segment.kind))
      .filter((segment) => !input.expiresAfter || segment.expiresAt > input.expiresAfter)
      .length;
  }

  async listExpiredSegments(at: string): Promise<AppDiagnosticsSegmentRecord[]> {
    return [...this.segments.values()]
      .filter((segment) => segment.expiresAt <= at)
      .sort((left, right) => left.expiresAt.localeCompare(right.expiresAt))
      .map(clone);
  }

  async deleteSegments(segmentIds: string[]): Promise<number> {
    let deleted = 0;
    for (const segmentId of new Set(segmentIds)) {
      if (this.segments.delete(segmentId)) deleted += 1;
    }
    return deleted;
  }

  async getUsage(): Promise<AppDiagnosticsUsage> {
    let technicalBytes = 0;
    let visualBytes = 0;
    for (const segment of this.segments.values()) {
      if (segment.kind === "TECHNICAL") technicalBytes += segment.byteSize;
      else visualBytes += segment.byteSize;
    }
    return {
      technicalBytes,
      visualBytes,
      totalBytes: technicalBytes + visualBytes,
      segmentCount: this.segments.size
    };
  }

  async incrementCounters(input: AppDiagnosticsCounterIncrement): Promise<AppDiagnosticsSettingRecord> {
    this.setting = {
      ...this.setting,
      droppedEvents: this.setting.droppedEvents + Math.max(0, Math.trunc(input.droppedEvents ?? 0)),
      quotaDrops: this.setting.quotaDrops + Math.max(0, Math.trunc(input.quotaDrops ?? 0)),
      rejectedUploads: this.setting.rejectedUploads + Math.max(0, Math.trunc(input.rejectedUploads ?? 0))
    };
    return clone(this.setting);
  }

  async pruneExpiredMetadata(at: string): Promise<{ leasesDeleted: number; capturesDeleted: number }> {
    this.expireLeases(at);
    let leasesDeleted = 0;
    for (const [leaseId, lease] of this.leases) {
      if (lease.status !== "ACTIVE") {
        this.leases.delete(leaseId);
        leasesDeleted += 1;
      }
    }
    let capturesDeleted = 0;
    for (const [captureId, capture] of this.captures) {
      const hasSegments = [...this.segments.values()].some((segment) => segment.captureId === captureId);
      if (capture.endedAt && !hasSegments) {
        this.captures.delete(captureId);
        capturesDeleted += 1;
      }
    }
    return { leasesDeleted, capturesDeleted };
  }

  async dispose(): Promise<void> {}

  private expireLeases(at: string): void {
    for (const [leaseId, lease] of this.leases) {
      if (lease.status === "ACTIVE" && lease.expiresAt <= at) {
        this.leases.set(leaseId, { ...lease, status: "EXPIRED", releasedAt: at });
      }
    }
  }
}

type DiagnosticsPool = PgPoolLike & { end?: () => Promise<void> };

type SettingRow = Omit<
  AppDiagnosticsSettingRecord,
  "enabledAt" | "disabledAt" | "updatedAt" | "droppedEvents" | "quotaDrops" | "rejectedUploads"
> & {
  enabledAt: Date | string | null;
  disabledAt: Date | string | null;
  updatedAt: Date | string;
  droppedEvents: number | string;
  quotaDrops: number | string;
  rejectedUploads: number | string;
};

type CaptureRow = Omit<AppDiagnosticsCaptureRecord, "startedAt" | "endedAt"> & {
  startedAt: Date | string;
  endedAt: Date | string | null;
};

type LeaseRow = Omit<
  AppDiagnosticsVideoLeaseRecord,
  "acquiredAt" | "heartbeatAt" | "expiresAt" | "releasedAt"
> & {
  acquiredAt: Date | string;
  heartbeatAt: Date | string;
  expiresAt: Date | string;
  releasedAt: Date | string | null;
};

type SegmentRow = Omit<
  AppDiagnosticsSegmentRecord,
  "byteSize" | "firstEventSequence" | "lastEventSequence" | "startedAt" | "endedAt" | "expiresAt"
> & {
  byteSize: number | string;
  firstEventSequence: number | string | null;
  lastEventSequence: number | string | null;
  startedAt: Date | string;
  endedAt: Date | string;
  expiresAt: Date | string;
};

const settingSelect = `
  SELECT
    enabled,
    active_capture_id AS "activeCaptureId",
    enabled_at AS "enabledAt",
    enabled_by_user_id AS "enabledByUserId",
    disabled_at AS "disabledAt",
    disabled_by_user_id AS "disabledByUserId",
    dropped_events AS "droppedEvents",
    quota_drops AS "quotaDrops",
    rejected_uploads AS "rejectedUploads",
    updated_at AS "updatedAt"
  FROM app_diagnostics_settings
  WHERE singleton_id = 1
`;

const captureSelect = `
  SELECT
    capture_id AS "captureId",
    started_at AS "startedAt",
    started_by_user_id AS "startedByUserId",
    ended_at AS "endedAt",
    ended_by_user_id AS "endedByUserId"
  FROM app_diagnostics_captures
`;

const leaseSelect = `
  SELECT
    lease_id AS "leaseId",
    capture_id AS "captureId",
    client_id AS "clientId",
    page_client_id AS "pageClientId",
    user_id AS "userId",
    status,
    acquired_at AS "acquiredAt",
    heartbeat_at AS "heartbeatAt",
    expires_at AS "expiresAt",
    released_at AS "releasedAt"
  FROM app_diagnostics_video_leases
`;

const segmentSelect = `
  SELECT
    segment_id AS "segmentId",
    capture_id AS "captureId",
    client_id AS "clientId",
    batch_id AS "batchId",
    batch_fingerprint AS "batchFingerprint",
    lease_id AS "leaseId",
    kind,
    relative_path AS "relativePath",
    mime_type AS "mimeType",
    byte_size AS "byteSize",
    first_event_sequence AS "firstEventSequence",
    last_event_sequence AS "lastEventSequence",
    started_at AS "startedAt",
    ended_at AS "endedAt",
    expires_at AS "expiresAt"
  FROM app_diagnostics_segments
`;

function mapSetting(row: SettingRow): AppDiagnosticsSettingRecord {
  return {
    ...row,
    enabledAt: row.enabledAt ? iso(row.enabledAt) : null,
    disabledAt: row.disabledAt ? iso(row.disabledAt) : null,
    updatedAt: iso(row.updatedAt),
    droppedEvents: Number(row.droppedEvents),
    quotaDrops: Number(row.quotaDrops),
    rejectedUploads: Number(row.rejectedUploads)
  };
}

function mapCapture(row: CaptureRow): AppDiagnosticsCaptureRecord {
  return {
    ...row,
    startedAt: iso(row.startedAt),
    endedAt: row.endedAt ? iso(row.endedAt) : null
  };
}

function mapLease(row: LeaseRow): AppDiagnosticsVideoLeaseRecord {
  return {
    ...row,
    acquiredAt: iso(row.acquiredAt),
    heartbeatAt: iso(row.heartbeatAt),
    expiresAt: iso(row.expiresAt),
    releasedAt: row.releasedAt ? iso(row.releasedAt) : null
  };
}

function mapSegment(row: SegmentRow): AppDiagnosticsSegmentRecord {
  return {
    ...row,
    byteSize: Number(row.byteSize),
    firstEventSequence: row.firstEventSequence === null ? null : Number(row.firstEventSequence),
    lastEventSequence: row.lastEventSequence === null ? null : Number(row.lastEventSequence),
    startedAt: iso(row.startedAt),
    endedAt: iso(row.endedAt),
    expiresAt: iso(row.expiresAt)
  };
}

export class PostgresAppDiagnosticsRepository implements AppDiagnosticsRepository {
  constructor(
    private readonly pool: DiagnosticsPool,
    private readonly ownsPool = false
  ) {}

  static fromConnectionString(
    connectionString: string,
    poolOptions: { max?: number; idleTimeoutMillis?: number; connectionTimeoutMillis?: number } = {}
  ): PostgresAppDiagnosticsRepository {
    return new PostgresAppDiagnosticsRepository(createSpacePgPool(connectionString, poolOptions, 2) as DiagnosticsPool, true);
  }

  async getSetting(): Promise<AppDiagnosticsSettingRecord> {
    const result = await this.pool.query<SettingRow>(settingSelect);
    if (!result.rows[0]) throw new Error("App diagnostics singleton is missing.");
    return mapSetting(result.rows[0]);
  }

  async setEnabled(input: SetAppDiagnosticsEnabledInput): Promise<AppDiagnosticsSettingRecord> {
    return this.withTransaction(async (client) => {
      const currentResult = await client.query<SettingRow>(`${settingSelect} FOR UPDATE`);
      const current = currentResult.rows[0] ? mapSetting(currentResult.rows[0]) : null;
      if (!current) throw new Error("App diagnostics singleton is missing.");
      if (current.enabled === input.isEnabled) return current;

      if (input.isEnabled) {
        if (!input.captureId) {
          throw new AppDiagnosticsRepositoryConflictError("CAPTURE_ID_REQUIRED", "A capture ID is required.");
        }
        await client.query(
          `
            INSERT INTO app_diagnostics_captures (
              capture_id, started_at, started_by_user_id
            ) VALUES ($1, $2, $3)
          `,
          [input.captureId, input.at, input.actorUserId]
        );
        await client.query(
          `
            UPDATE app_diagnostics_settings
            SET
              enabled = true,
              active_capture_id = $1,
              enabled_at = $2,
              enabled_by_user_id = $3,
              disabled_at = NULL,
              disabled_by_user_id = NULL,
              updated_at = $2
            WHERE singleton_id = 1
          `,
          [input.captureId, input.at, input.actorUserId]
        );
      } else {
        if (current.activeCaptureId) {
          await client.query(
            `
              UPDATE app_diagnostics_captures
              SET ended_at = $2, ended_by_user_id = $3
              WHERE capture_id = $1 AND ended_at IS NULL
            `,
            [current.activeCaptureId, input.at, input.actorUserId]
          );
          await client.query(
            `
              UPDATE app_diagnostics_video_leases
              SET status = 'REVOKED', released_at = COALESCE(released_at, $2)
              WHERE capture_id = $1 AND status = 'ACTIVE'
            `,
            [current.activeCaptureId, input.at]
          );
        }
        await client.query(
          `
            UPDATE app_diagnostics_settings
            SET
              enabled = false,
              active_capture_id = NULL,
              disabled_at = $1,
              disabled_by_user_id = $2,
              updated_at = $1
            WHERE singleton_id = 1
          `,
          [input.at, input.actorUserId]
        );
      }

      const updated = await client.query<SettingRow>(settingSelect);
      if (!updated.rows[0]) throw new Error("App diagnostics singleton is missing after update.");
      return mapSetting(updated.rows[0]);
    });
  }

  async listCaptures(): Promise<AppDiagnosticsCaptureRecord[]> {
    const result = await this.pool.query<CaptureRow>(`${captureSelect} ORDER BY started_at ASC, capture_id ASC`);
    return result.rows.map(mapCapture);
  }

  async getActiveVideoLease(at: string): Promise<AppDiagnosticsVideoLeaseRecord | null> {
    await this.expireLeases(this.pool, at);
    const result = await this.pool.query<LeaseRow>(
      `${leaseSelect} WHERE status = 'ACTIVE' ORDER BY acquired_at DESC LIMIT 1`
    );
    return result.rows[0] ? mapLease(result.rows[0]) : null;
  }

  async getVideoLease(leaseId: string): Promise<AppDiagnosticsVideoLeaseRecord | null> {
    const result = await this.pool.query<LeaseRow>(`${leaseSelect} WHERE lease_id = $1`, [leaseId]);
    return result.rows[0] ? mapLease(result.rows[0]) : null;
  }

  async acquireVideoLease(
    input: AcquireAppDiagnosticsVideoLeaseRecordInput
  ): Promise<AppDiagnosticsVideoLeaseRecord> {
    try {
      return await this.withTransaction(async (client) => {
        const settingResult = await client.query<SettingRow>(`${settingSelect} FOR UPDATE`);
        const setting = settingResult.rows[0] ? mapSetting(settingResult.rows[0]) : null;
        await this.expireLeases(client, input.acquiredAt);
        if (!setting?.enabled || setting.activeCaptureId !== input.captureId) {
          throw new AppDiagnosticsRepositoryConflictError("STALE_CAPTURE", "The diagnostics capture is no longer active.");
        }
        const active = await client.query<LeaseRow>(
          `${leaseSelect} WHERE status = 'ACTIVE' ORDER BY acquired_at DESC LIMIT 1`
        );
        if (active.rows.length) {
          throw new AppDiagnosticsRepositoryConflictError("VIDEO_LEASE_HELD", "Another diagnostics recorder is active.");
        }
        const result = await client.query<LeaseRow>(
          `
            INSERT INTO app_diagnostics_video_leases (
              lease_id, capture_id, client_id, page_client_id, user_id,
              status, acquired_at, heartbeat_at, expires_at
            )
            VALUES ($1, $2, $3, $4, $5, 'ACTIVE', $6, $6, $7)
            RETURNING
              lease_id AS "leaseId",
              capture_id AS "captureId",
              client_id AS "clientId",
              page_client_id AS "pageClientId",
              user_id AS "userId",
              status,
              acquired_at AS "acquiredAt",
              heartbeat_at AS "heartbeatAt",
              expires_at AS "expiresAt",
              released_at AS "releasedAt"
          `,
          [
            input.leaseId,
            input.captureId,
            input.clientId,
            input.pageClientId,
            input.userId,
            input.acquiredAt,
            input.expiresAt
          ]
        );
        return mapLease(result.rows[0]!);
      });
    } catch (error) {
      if (typeof error === "object" && error && "code" in error && error.code === "23505") {
        throw new AppDiagnosticsRepositoryConflictError("VIDEO_LEASE_HELD", "Another diagnostics recorder is active.");
      }
      throw error;
    }
  }

  async heartbeatVideoLease(
    input: HeartbeatAppDiagnosticsVideoLeaseInput
  ): Promise<AppDiagnosticsVideoLeaseRecord> {
    const result = await this.pool.query<LeaseRow>(
      `
        UPDATE app_diagnostics_video_leases AS lease
        SET heartbeat_at = $4, expires_at = $5
        FROM app_diagnostics_settings AS setting
        WHERE
          lease.lease_id = $1
          AND lease.capture_id = $2
          AND lease.user_id = $3
          AND lease.status = 'ACTIVE'
          AND lease.expires_at > $4
          AND setting.singleton_id = 1
          AND setting.enabled = true
          AND setting.active_capture_id = $2
        RETURNING
          lease.lease_id AS "leaseId",
          lease.capture_id AS "captureId",
          lease.client_id AS "clientId",
          lease.page_client_id AS "pageClientId",
          lease.user_id AS "userId",
          lease.status,
          lease.acquired_at AS "acquiredAt",
          lease.heartbeat_at AS "heartbeatAt",
          lease.expires_at AS "expiresAt",
          lease.released_at AS "releasedAt"
      `,
      [input.leaseId, input.captureId, input.userId, input.at, input.expiresAt]
    );
    if (!result.rows[0]) {
      await this.expireLeases(this.pool, input.at);
      throw new AppDiagnosticsRepositoryConflictError("VIDEO_LEASE_STALE", "The diagnostics recorder lease is stale.");
    }
    return mapLease(result.rows[0]);
  }

  async releaseVideoLease(
    input: ReleaseAppDiagnosticsVideoLeaseInput
  ): Promise<AppDiagnosticsVideoLeaseRecord> {
    return this.withTransaction(async (client) => {
      const currentResult = await client.query<LeaseRow>(
        `${leaseSelect} WHERE lease_id = $1 FOR UPDATE`,
        [input.leaseId]
      );
      const current = currentResult.rows[0] ? mapLease(currentResult.rows[0]) : null;
      if (!current || current.userId !== input.userId) {
        throw new AppDiagnosticsRepositoryConflictError("VIDEO_LEASE_STALE", "The diagnostics recorder lease is stale.");
      }
      if (current.status !== "ACTIVE") return current;
      const result = await client.query<LeaseRow>(
        `
          UPDATE app_diagnostics_video_leases
          SET status = 'RELEASED', released_at = $2
          WHERE lease_id = $1
          RETURNING
            lease_id AS "leaseId",
            capture_id AS "captureId",
            client_id AS "clientId",
            page_client_id AS "pageClientId",
            user_id AS "userId",
            status,
            acquired_at AS "acquiredAt",
            heartbeat_at AS "heartbeatAt",
            expires_at AS "expiresAt",
            released_at AS "releasedAt"
        `,
        [input.leaseId, input.at]
      );
      return mapLease(result.rows[0]!);
    });
  }

  async createSegment(input: AppDiagnosticsSegmentRecord): Promise<AppDiagnosticsSegmentRecord> {
    assertSegmentRetention(input);
    try {
      return await this.withTransaction(async (client) => {
        const settingResult = await client.query<SettingRow>(`${settingSelect} FOR SHARE`);
        const setting = settingResult.rows[0] ? mapSetting(settingResult.rows[0]) : null;
        if (!setting?.enabled || setting.activeCaptureId !== input.captureId) {
          throw new AppDiagnosticsRepositoryConflictError("STALE_CAPTURE", "The diagnostics capture is no longer active.");
        }
        if (input.leaseId) {
          const leaseResult = await client.query<LeaseRow>(
            `${leaseSelect} WHERE lease_id = $1 AND status = 'ACTIVE' AND capture_id = $2`,
            [input.leaseId, input.captureId]
          );
          if (!leaseResult.rows[0]) {
            throw new AppDiagnosticsRepositoryConflictError("VIDEO_LEASE_STALE", "The diagnostics recorder lease is stale.");
          }
        }
        const result = await client.query<SegmentRow>(
          `
            INSERT INTO app_diagnostics_segments (
              segment_id, capture_id, client_id, batch_id, batch_fingerprint, lease_id, kind, relative_path,
              mime_type, byte_size, first_event_sequence, last_event_sequence,
              started_at, ended_at, expires_at
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
            RETURNING
              segment_id AS "segmentId",
              capture_id AS "captureId",
              client_id AS "clientId",
              batch_id AS "batchId",
              batch_fingerprint AS "batchFingerprint",
              lease_id AS "leaseId",
              kind,
              relative_path AS "relativePath",
              mime_type AS "mimeType",
              byte_size AS "byteSize",
              first_event_sequence AS "firstEventSequence",
              last_event_sequence AS "lastEventSequence",
              started_at AS "startedAt",
              ended_at AS "endedAt",
              expires_at AS "expiresAt"
          `,
          [
            input.segmentId,
            input.captureId,
            input.clientId,
            input.batchId ?? null,
            input.batchFingerprint ?? null,
            input.leaseId,
            input.kind,
            input.relativePath,
            input.mimeType,
            input.byteSize,
            input.firstEventSequence,
            input.lastEventSequence,
            input.startedAt,
            input.endedAt,
            input.expiresAt
          ]
        );
        return mapSegment(result.rows[0]!);
      });
    } catch (error) {
      if (typeof error === "object" && error && "code" in error && error.code === "23505") {
        throw new AppDiagnosticsRepositoryConflictError("SEGMENT_EXISTS", "Diagnostics segment already exists.");
      }
      throw error;
    }
  }

  async getSegment(segmentId: string): Promise<AppDiagnosticsSegmentRecord | null> {
    const result = await this.pool.query<SegmentRow>(`${segmentSelect} WHERE segment_id = $1`, [segmentId]);
    return result.rows[0] ? mapSegment(result.rows[0]) : null;
  }

  async getTechnicalSegmentByBatch(
    captureId: string,
    clientId: string,
    batchId: string
  ): Promise<AppDiagnosticsSegmentRecord | null> {
    const result = await this.pool.query<SegmentRow>(
      `${segmentSelect} WHERE capture_id = $1 AND client_id = $2 AND batch_id = $3 AND kind = 'TECHNICAL'`,
      [captureId, clientId, batchId]
    );
    return result.rows[0] ? mapSegment(result.rows[0]) : null;
  }

  async listSegments(input: AppDiagnosticsSegmentListInput = {}): Promise<AppDiagnosticsSegmentRecord[]> {
    assertSegmentCursor(input);
    const conditions: string[] = [];
    const values: unknown[] = [];
    if (input.captureId) {
      values.push(input.captureId);
      conditions.push(`capture_id = $${values.length}`);
    }
    if (input.batchId) {
      values.push(input.batchId);
      conditions.push(`batch_id = $${values.length}`);
    }
    if (input.kind) {
      values.push(input.kind);
      conditions.push(`kind = $${values.length}`);
    }
    if (input.kinds?.length) {
      values.push(input.kinds);
      conditions.push(`kind = ANY($${values.length}::text[])`);
    }
    if (input.expiresAfter) {
      values.push(input.expiresAfter);
      conditions.push(`expires_at > $${values.length}`);
    }
    if (input.afterEndedAt && input.afterSegmentId) {
      values.push(input.afterEndedAt, input.afterSegmentId);
      const comparison = input.oldestFirst ? ">" : "<";
      conditions.push(`(ended_at, segment_id) ${comparison} ($${values.length - 1}::timestamptz, $${values.length}::text)`);
    }
    values.push(Math.max(1, Math.min(input.limit ?? 10_000, 10_000)));
    values.push(Math.max(0, Math.trunc(input.offset ?? 0)));
    const where = conditions.length ? ` WHERE ${conditions.join(" AND ")}` : "";
    const direction = input.oldestFirst ? "ASC" : "DESC";
    const result = await this.pool.query<SegmentRow>(
      `${segmentSelect}${where} ORDER BY ended_at ${direction}, segment_id ${direction} LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values
    );
    return result.rows.map(mapSegment);
  }

  async countSegments(input: AppDiagnosticsSegmentListInput = {}): Promise<number> {
    const conditions: string[] = [];
    const values: unknown[] = [];
    if (input.captureId) {
      values.push(input.captureId);
      conditions.push(`capture_id = $${values.length}`);
    }
    if (input.batchId) {
      values.push(input.batchId);
      conditions.push(`batch_id = $${values.length}`);
    }
    if (input.kind) {
      values.push(input.kind);
      conditions.push(`kind = $${values.length}`);
    }
    if (input.kinds?.length) {
      values.push(input.kinds);
      conditions.push(`kind = ANY($${values.length}::text[])`);
    }
    if (input.expiresAfter) {
      values.push(input.expiresAfter);
      conditions.push(`expires_at > $${values.length}`);
    }
    const where = conditions.length ? ` WHERE ${conditions.join(" AND ")}` : "";
    const result = await this.pool.query<{ count: number | string }>(
      `SELECT COUNT(*) AS count FROM app_diagnostics_segments${where}`,
      values
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  async listExpiredSegments(at: string): Promise<AppDiagnosticsSegmentRecord[]> {
    const result = await this.pool.query<SegmentRow>(
      `${segmentSelect} WHERE expires_at <= $1 ORDER BY expires_at ASC, segment_id ASC`,
      [at]
    );
    return result.rows.map(mapSegment);
  }

  async deleteSegments(segmentIds: string[]): Promise<number> {
    if (!segmentIds.length) return 0;
    const result = await this.pool.query(
      "DELETE FROM app_diagnostics_segments WHERE segment_id = ANY($1::text[])",
      [Array.from(new Set(segmentIds))]
    );
    return result.rowCount ?? 0;
  }

  async getUsage(): Promise<AppDiagnosticsUsage> {
    const result = await this.pool.query<{
      technicalBytes: number | string;
      visualBytes: number | string;
      totalBytes: number | string;
      segmentCount: number | string;
    }>(
      `
        SELECT
          COALESCE(SUM(byte_size) FILTER (WHERE kind = 'TECHNICAL'), 0) AS "technicalBytes",
          COALESCE(SUM(byte_size) FILTER (WHERE kind <> 'TECHNICAL'), 0) AS "visualBytes",
          COALESCE(SUM(byte_size), 0) AS "totalBytes",
          COUNT(*) AS "segmentCount"
        FROM app_diagnostics_segments
      `
    );
    const row = result.rows[0]!;
    return {
      technicalBytes: Number(row.technicalBytes),
      visualBytes: Number(row.visualBytes),
      totalBytes: Number(row.totalBytes),
      segmentCount: Number(row.segmentCount)
    };
  }

  async incrementCounters(input: AppDiagnosticsCounterIncrement): Promise<AppDiagnosticsSettingRecord> {
    const result = await this.pool.query<SettingRow>(
      `
        UPDATE app_diagnostics_settings
        SET
          dropped_events = dropped_events + $1,
          quota_drops = quota_drops + $2,
          rejected_uploads = rejected_uploads + $3
        WHERE singleton_id = 1
        RETURNING
          enabled,
          active_capture_id AS "activeCaptureId",
          enabled_at AS "enabledAt",
          enabled_by_user_id AS "enabledByUserId",
          disabled_at AS "disabledAt",
          disabled_by_user_id AS "disabledByUserId",
          dropped_events AS "droppedEvents",
          quota_drops AS "quotaDrops",
          rejected_uploads AS "rejectedUploads",
          updated_at AS "updatedAt"
      `,
      [
        Math.max(0, Math.trunc(input.droppedEvents ?? 0)),
        Math.max(0, Math.trunc(input.quotaDrops ?? 0)),
        Math.max(0, Math.trunc(input.rejectedUploads ?? 0))
      ]
    );
    return mapSetting(result.rows[0]!);
  }

  async pruneExpiredMetadata(at: string): Promise<{ leasesDeleted: number; capturesDeleted: number }> {
    return this.withTransaction(async (client) => {
      await this.expireLeases(client, at);
      const leases = await client.query(
        "DELETE FROM app_diagnostics_video_leases WHERE status <> 'ACTIVE'"
      );
      const captures = await client.query(
        `
          DELETE FROM app_diagnostics_captures AS capture
          WHERE
            capture.ended_at IS NOT NULL
            AND NOT EXISTS (
              SELECT 1 FROM app_diagnostics_segments AS segment
              WHERE segment.capture_id = capture.capture_id
            )
        `
      );
      return {
        leasesDeleted: leases.rowCount ?? 0,
        capturesDeleted: captures.rowCount ?? 0
      };
    });
  }

  async dispose(): Promise<void> {
    if (this.ownsPool) await this.pool.end?.();
  }

  private async expireLeases(client: Pick<PgPoolLike, "query">, at: string): Promise<void> {
    await client.query(
      `
        UPDATE app_diagnostics_video_leases
        SET status = 'EXPIRED', released_at = COALESCE(released_at, $1)
        WHERE status = 'ACTIVE' AND expires_at <= $1
      `,
      [at]
    );
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
