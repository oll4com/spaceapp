import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import {
  chmod,
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rm,
  rmdir,
  rename,
  unlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import {
  appDiagnosticsEventBatchMaxBytes,
  appDiagnosticsEventBatchSchema,
  appDiagnosticsMaxSegments,
  appDiagnosticsQuotaBytes,
  appDiagnosticsSegmentListQuerySchema,
  appDiagnosticsSegmentMetadataSchema,
  appDiagnosticsSnapshotMaxBytes,
  appDiagnosticsStatusSchema,
  appDiagnosticsTechnicalQuotaBytes,
  appDiagnosticsVideoLeaseSchema,
  appDiagnosticsVideoLeaseTtlSeconds,
  appDiagnosticsVideoSegmentMaxBytes,
  appDiagnosticsVideoSegmentQuerySchema,
  appDiagnosticsVisualQuotaBytes,
  type AppDiagnosticsEventBatch,
  type AppDiagnosticsDomSnapshot,
  type AppDiagnosticsSegmentKind,
  type AppDiagnosticsSegmentMetadata,
  type AppDiagnosticsStatus,
  type AppDiagnosticsTechnicalEvent,
  type AppDiagnosticsVideoLease,
  type AppDiagnosticsVideoSegmentQuery
} from "@space/contracts";
import {
  AppDiagnosticsRepositoryConflictError,
  type AppDiagnosticsRepository,
  type AppDiagnosticsSegmentRecord,
  type AppDiagnosticsVideoLeaseRecord
} from "@space/db";

export type AppDiagnosticsServiceErrorCode =
  | "CAPTURE_INACTIVE"
  | "VIDEO_LEASE_HELD"
  | "VIDEO_LEASE_STALE"
  | "VIDEO_MIME_INVALID"
  | "VIDEO_MAGIC_INVALID"
  | "VIDEO_TOO_LARGE"
  | "BATCH_TOO_LARGE"
  | "BATCH_CONFLICT"
  | "SNAPSHOT_TOO_LARGE"
  | "QUOTA_EXCEEDED"
  | "SEGMENT_TIME_INVALID"
  | "SEGMENT_NOT_FOUND"
  | "SEGMENT_EXPIRED"
  | "SEGMENT_PATH_INVALID";

export class AppDiagnosticsServiceError extends Error {
  constructor(
    public readonly code: AppDiagnosticsServiceErrorCode,
    message: string,
    public readonly statusCode: number
  ) {
    super(message);
    this.name = "AppDiagnosticsServiceError";
  }
}

export interface AppDiagnosticsServiceOptions {
  repository: AppDiagnosticsRepository;
  root: string;
  cleanupRootOnDispose?: boolean;
  now?: () => Date;
  createId?: (prefix: string) => string;
  quotaPolicy?: {
    technicalQuotaBytes?: number;
    visualQuotaBytes?: number;
    maxSegments?: number;
  };
}

export interface UploadAppDiagnosticsVideoSegmentInput extends AppDiagnosticsVideoSegmentQuery {
  leaseId: string;
  sequence: number;
  userId: string;
  mimeType: string;
  bytes: Buffer;
}

export interface AppDiagnosticsEventBatchResult {
  captureId: string;
  acceptedEvents: number;
  acceptedSnapshots: number;
  firstSequence: number;
  lastSequence: number;
  expiresAt: string;
}

const webmMagic = Buffer.from([0x1a, 0x45, 0xdf, 0xa3]);
const videoMimePattern = /^video\/webm(?:;\s*codecs=(?:vp8|vp9))?$/i;
const routeDynamicSegmentPattern = /^(?:\d+|[0-9a-f]{8}-[0-9a-f-]{27,}|[A-Za-z0-9_-]{16,})$/i;
const appDiagnosticsSegmentIndexVersion = 1;
const appDiagnosticsClockSkewMs = 5 * 60 * 1_000;
const appDiagnosticsRetentionMs = 24 * 60 * 60 * 1_000;
const structuralRoles = new Set([
  "alert", "button", "cell", "checkbox", "dialog", "form", "grid", "gridcell",
  "heading", "link", "list", "listbox", "listitem", "main", "menu", "menuitem",
  "navigation", "option", "progressbar", "radio", "region", "row", "rowgroup",
  "search", "separator", "slider", "status", "switch", "tab", "table", "tabpanel",
  "textbox", "timer", "toolbar", "tree", "treeitem"
]);
const normalizedErrorNames = new Set([
  "AbortError", "AggregateError", "DOMException", "Error", "EvalError", "InternalError",
  "NetworkError", "NotAllowedError", "RangeError", "ReferenceError", "ResourceError",
  "SyntaxError", "TypeError", "URIError", "UnhandledRejection"
]);
const sensitiveTechnicalNamePattern = /(api[_-]?key|authorization|bearer|cookie|credential|password|secret|session|token)/i;
const safeCorrelationIdPattern = /^(?:correlation|req|request|trace):[A-Za-z0-9_-]{3,80}$/;

function defaultId(prefix: string): string {
  return `${prefix}:${crypto.randomUUID().replaceAll("-", "")}`;
}

function expiresAt(endedAt: string): string {
  return new Date(Date.parse(endedAt) + 24 * 60 * 60 * 1_000).toISOString();
}

function isFileSystemError(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function normalizeRoutePath(input: string): string {
  const path = input.split(/[?#]/, 1)[0] || "/";
  return `/${path.split("/")
    .filter(Boolean)
    .map((part) => (
      part.startsWith(":") ||
      (!routeDynamicSegmentPattern.test(part) && !sensitiveTechnicalNamePattern.test(part))
        ? part
        : ":id"
    ))
    .join("/")}`;
}

function normalizeStackFile(input: string): string {
  const withoutQuery = input.split(/[?#]/, 1)[0] ?? input;
  const parts = withoutQuery.split("/").filter(Boolean);
  const tail = parts.slice(-2).join("/");
  return normalizeRoutePath(`/${tail || basename(withoutQuery) || "unknown"}`);
}

function normalizeStructuralRole(input: string | undefined): string | undefined {
  return input && structuralRoles.has(input.toLowerCase()) ? input.toLowerCase() : undefined;
}

function normalizeTechnicalProperty(input: string | undefined, animation: boolean): string | undefined {
  if (!input) return undefined;
  if (animation) return input === "none" ? "none" : "active";
  if (input.startsWith("--")) return "custom-property";
  return /^[a-z][a-z-]{0,63}$/.test(input) && !sensitiveTechnicalNamePattern.test(input)
    ? input
    : "other";
}

function normalizeSnapshotStyle(
  style: AppDiagnosticsDomSnapshot["nodes"][number]["style"]
): AppDiagnosticsDomSnapshot["nodes"][number]["style"] {
  const display = new Set([
    "block", "contents", "flex", "flow-root", "grid", "inline", "inline-block",
    "inline-flex", "inline-grid", "list-item", "none", "table"
  ]);
  const visibility = new Set(["collapse", "hidden", "visible"]);
  const position = new Set(["absolute", "fixed", "relative", "static", "sticky"]);
  return {
    display: display.has(style.display) ? style.display : "other",
    visibility: visibility.has(style.visibility) ? style.visibility : "other",
    opacity: /^(?:0|1|0?\.\d{1,4})$/.test(style.opacity) ? style.opacity : "other",
    position: position.has(style.position) ? style.position : "other",
    transform: style.transform === "none" ? "none" : "active",
    animationName: style.animationName === "none" ? "none" : "active",
    transitionProperty: style.transitionProperty === "none" ? "none" : "active"
  };
}

function sanitizeDomSnapshot(snapshot: AppDiagnosticsDomSnapshot): AppDiagnosticsDomSnapshot {
  return {
    ...snapshot,
    nodes: snapshot.nodes.map((node) => ({
      ...node,
      ...(normalizeStructuralRole(node.role) ? { role: normalizeStructuralRole(node.role) } : { role: undefined }),
      classes: [],
      style: normalizeSnapshotStyle(node.style)
    }))
  };
}

function sanitizeTechnicalEvent(event: AppDiagnosticsTechnicalEvent): AppDiagnosticsTechnicalEvent {
  if (event.category === "NETWORK") {
    return {
      ...event,
      ...(event.pathTemplate ? { pathTemplate: normalizeRoutePath(event.pathTemplate) } : {}),
      ...(
        event.correlationId &&
        safeCorrelationIdPattern.test(event.correlationId) &&
        !sensitiveTechnicalNamePattern.test(event.correlationId)
          ? { correlationId: event.correlationId }
          : { correlationId: undefined }
      )
    };
  }
  if (event.category === "NAVIGATION") {
    return { ...event, pathTemplate: normalizeRoutePath(event.pathTemplate) };
  }
  if (event.category === "ERROR") {
    return {
      ...event,
      name: normalizedErrorNames.has(event.name) ? event.name : "Error",
      ...(
        event.code &&
        /^[A-Z][A-Z0-9_]{0,63}$/.test(event.code) &&
        !sensitiveTechnicalNamePattern.test(event.code)
          ? { code: event.code }
          : { code: undefined }
      ),
      stackLocations: event.stackLocations.map((location) => ({
        ...location,
        file: normalizeStackFile(location.file)
      }))
    };
  }
  if (event.category === "INTERACTION") {
    return {
      ...event,
      ...(normalizeStructuralRole(event.role) ? { role: normalizeStructuralRole(event.role) } : { role: undefined })
    };
  }
  if (event.category === "VISUAL") {
    return {
      ...event,
      ...(normalizeStructuralRole(event.role) ? { role: normalizeStructuralRole(event.role) } : { role: undefined }),
      ...(normalizeTechnicalProperty(event.propertyName, event.event.startsWith("ANIMATION"))
        ? { propertyName: normalizeTechnicalProperty(event.propertyName, event.event.startsWith("ANIMATION")) }
        : { propertyName: undefined })
    };
  }
  return event;
}

function toPublicLease(lease: AppDiagnosticsVideoLeaseRecord): AppDiagnosticsVideoLease {
  if (!lease.userId) {
    throw new AppDiagnosticsServiceError("VIDEO_LEASE_STALE", "The diagnostics recorder lease has no owner.", 409);
  }
  return appDiagnosticsVideoLeaseSchema.parse({ ...lease, userId: lease.userId });
}

export class AppDiagnosticsService {
  private readonly repository: AppDiagnosticsRepository;
  private readonly root: string;
  private readonly now: () => Date;
  private readonly createId: (prefix: string) => string;
  private readonly technicalQuotaBytes: number;
  private readonly visualQuotaBytes: number;
  private readonly maxSegments: number;
  private readonly cleanupRootOnDispose: boolean;
  private rootRealPath: string | null = null;
  private writeTail: Promise<void> = Promise.resolve();

  constructor(options: AppDiagnosticsServiceOptions) {
    this.repository = options.repository;
    this.root = resolve(options.root);
    this.now = options.now ?? (() => new Date());
    this.createId = options.createId ?? defaultId;
    this.technicalQuotaBytes = options.quotaPolicy?.technicalQuotaBytes ?? appDiagnosticsTechnicalQuotaBytes;
    this.visualQuotaBytes = options.quotaPolicy?.visualQuotaBytes ?? appDiagnosticsVisualQuotaBytes;
    this.maxSegments = Math.max(1, Math.trunc(options.quotaPolicy?.maxSegments ?? appDiagnosticsMaxSegments));
    this.cleanupRootOnDispose = options.cleanupRootOnDispose === true;
    if (
      this.cleanupRootOnDispose &&
      !this.root.startsWith(`${resolve(tmpdir())}${sep}space-app-diagnostics-`)
    ) {
      throw new Error("Ephemeral diagnostics roots must use the bounded system temporary prefix.");
    }
  }

  async initialize(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o755 });
    await chmod(this.root, 0o755);
    this.rootRealPath = await realpath(this.root);
    await this.sweepExpired();
    await this.reconcileSegmentIndexes();
    await this.writeStatusProjection();
  }

  async getStatus(): Promise<AppDiagnosticsStatus> {
    const checkedAt = this.now().toISOString();
    const [setting, usage, activeLease] = await Promise.all([
      this.repository.getSetting(),
      this.repository.getUsage(),
      this.repository.getActiveVideoLease(checkedAt)
    ]);
    return appDiagnosticsStatusSchema.parse({
      isEnabled: setting.enabled,
      captureId: setting.activeCaptureId,
      enabledAt: setting.enabledAt,
      enabledByUserId: setting.enabledByUserId,
      retentionHours: 24,
      quotaBytes: appDiagnosticsQuotaBytes,
      technicalQuotaBytes: appDiagnosticsTechnicalQuotaBytes,
      visualQuotaBytes: appDiagnosticsVisualQuotaBytes,
      usage,
      counters: {
        droppedEvents: setting.droppedEvents,
        quotaDrops: setting.quotaDrops,
        rejectedUploads: setting.rejectedUploads
      },
      recorder: activeLease
        ? {
            status: "ACTIVE",
            leaseId: activeLease.leaseId,
            clientId: activeLease.clientId,
            acquiredAt: activeLease.acquiredAt,
            heartbeatAt: activeLease.heartbeatAt,
            expiresAt: activeLease.expiresAt
          }
        : { status: "IDLE" },
      checkedAt
    });
  }

  async setEnabled(isEnabled: boolean, actorUserId: string): Promise<AppDiagnosticsStatus> {
    const at = this.now().toISOString();
    await this.repository.setEnabled({
      isEnabled,
      captureId: isEnabled ? this.createId("app_debug_capture") : null,
      actorUserId,
      at
    });
    await this.writeStatusProjection();
    return this.getStatus();
  }

  async ingestEventBatch(input: AppDiagnosticsEventBatch): Promise<AppDiagnosticsEventBatchResult> {
    const parsed = appDiagnosticsEventBatchSchema.parse(input);
    const serializedInputBytes = Buffer.byteLength(JSON.stringify(parsed));
    if (serializedInputBytes > appDiagnosticsEventBatchMaxBytes) {
      await this.repository.incrementCounters({ rejectedUploads: 1, droppedEvents: parsed.events.length });
      throw new AppDiagnosticsServiceError("BATCH_TOO_LARGE", "Diagnostics event batch exceeds 256 KiB.", 413);
    }
    await this.assertRetainableTimestamps([
      parsed.startedAt,
      parsed.endedAt,
      ...parsed.events.map((event) => event.occurredAt),
      ...parsed.snapshots.map((snapshot) => snapshot.capturedAt)
    ], parsed.events.length + parsed.droppedBeforeBatch);

    const sanitizedEvents = parsed.events.map(sanitizeTechnicalEvent);
    const sanitizedSnapshots = parsed.snapshots.map(sanitizeDomSnapshot);
    const technicalPayload = Buffer.from(sanitizedEvents.map((event) => JSON.stringify({
      captureId: parsed.captureId,
      clientId: parsed.clientId,
      batchId: parsed.batchId,
      ...event
    })).join("\n") + "\n");
    const technicalBytes = gzipSync(technicalPayload, { level: 6 });
    const snapshotSegments = sanitizedSnapshots.map((snapshot) => {
      const snapshotPayload = Buffer.from(JSON.stringify({
        captureId: parsed.captureId,
        clientId: parsed.clientId,
        batchId: parsed.batchId,
        ...snapshot
      }));
      if (snapshotPayload.byteLength > appDiagnosticsSnapshotMaxBytes) {
        return { snapshot, bytes: null };
      }
      return {
        snapshot,
        bytes: gzipSync(snapshotPayload, { level: 6 })
      };
    });
    if (snapshotSegments.some((segment) => segment.bytes === null)) {
      await this.repository.incrementCounters({ rejectedUploads: 1 });
      throw new AppDiagnosticsServiceError("SNAPSHOT_TOO_LARGE", "Diagnostics snapshot exceeds 256 KiB.", 413);
    }
    const batchFingerprint = createHash("sha256").update(JSON.stringify({
      captureId: parsed.captureId,
      clientId: parsed.clientId,
      batchId: parsed.batchId,
      firstSequence: parsed.firstSequence,
      lastSequence: parsed.lastSequence,
      startedAt: parsed.startedAt,
      endedAt: parsed.endedAt,
      droppedBeforeBatch: parsed.droppedBeforeBatch,
      events: sanitizedEvents,
      snapshots: sanitizedSnapshots
    })).digest("hex");
    const result: AppDiagnosticsEventBatchResult = {
      captureId: parsed.captureId,
      acceptedEvents: sanitizedEvents.length,
      acceptedSnapshots: sanitizedSnapshots.length,
      firstSequence: parsed.firstSequence,
      lastSequence: parsed.lastSequence,
      expiresAt: expiresAt(parsed.endedAt)
    };

    return this.withWriteLock(async () => {
      await this.assertActiveCapture(
        parsed.captureId,
        parsed.events.length + parsed.droppedBeforeBatch
      );
      const existingTechnical = await this.repository.getTechnicalSegmentByBatch(
        parsed.captureId,
        parsed.clientId,
        parsed.batchId
      );
      const preparedSnapshots = snapshotSegments.map(({ snapshot, bytes }) => {
        const segmentId = this.batchSnapshotSegmentId(parsed, snapshot.snapshotId);
        return {
          segment: {
            segmentId,
            captureId: parsed.captureId,
            clientId: parsed.clientId,
            batchId: parsed.batchId,
            batchFingerprint: null,
            leaseId: null,
            kind: "DOM_SNAPSHOT" as const,
            relativePath: this.relativeSegmentPath(
              parsed.captureId,
              parsed.clientId,
              "snapshots",
              `${segmentId.replaceAll(":", "-")}.json.gz`
            ),
            mimeType: "application/json+gzip" as const,
            byteSize: bytes!.byteLength,
            firstEventSequence: snapshot.anomalySequence,
            lastEventSequence: snapshot.anomalySequence,
            startedAt: snapshot.capturedAt,
            endedAt: snapshot.capturedAt,
            expiresAt: expiresAt(snapshot.capturedAt)
          },
          bytes: bytes!
        };
      });

      if (existingTechnical) {
        if (existingTechnical.batchFingerprint !== batchFingerprint) {
          await this.repository.incrementCounters({
            rejectedUploads: 1,
            droppedEvents: parsed.events.length + parsed.droppedBeforeBatch
          });
          throw new AppDiagnosticsServiceError(
            "BATCH_CONFLICT",
            "Diagnostics batch ID was already used with different content.",
            409
          );
        }
        const existingSegments = await this.repository.listSegments({
          captureId: parsed.captureId,
          batchId: parsed.batchId,
          limit: 10
        });
        const expectedSnapshotIds = new Set(preparedSnapshots.map(({ segment }) => segment.segmentId));
        const complete = existingSegments.length === preparedSnapshots.length + 1 &&
          existingSegments.some((segment) => segment.segmentId === existingTechnical.segmentId) &&
          existingSegments.filter((segment) => segment.kind === "DOM_SNAPSHOT").every((segment) => (
            expectedSnapshotIds.has(segment.segmentId)
          ));
        if (complete) {
          await Promise.all(existingSegments.map((segment) => this.resolveStoredFile(segment.relativePath)));
          return result;
        }
        await this.deleteStoredSegments(existingSegments);
      }

      for (const { segment } of preparedSnapshots) {
        await this.removeUnindexedPreparedFile(segment);
      }

      const technicalSegmentId = this.createId("app_debug_segment");
      const prepared = [{
        segment: {
          segmentId: technicalSegmentId,
          captureId: parsed.captureId,
          clientId: parsed.clientId,
          batchId: parsed.batchId,
          batchFingerprint,
          leaseId: null,
          kind: "TECHNICAL" as const,
          relativePath: this.relativeSegmentPath(
            parsed.captureId,
            parsed.clientId,
            "technical",
            `${technicalSegmentId.replaceAll(":", "-")}.ndjson.gz`
          ),
          mimeType: "application/x-ndjson+gzip" as const,
          byteSize: technicalBytes.byteLength,
          firstEventSequence: parsed.firstSequence,
          lastEventSequence: parsed.lastSequence,
          startedAt: parsed.startedAt,
          endedAt: parsed.endedAt,
          expiresAt: expiresAt(parsed.endedAt)
        },
        bytes: technicalBytes
      }, ...preparedSnapshots];
      const created: AppDiagnosticsSegmentRecord[] = [];
      try {
        for (const item of prepared) {
          created.push(await this.persistSegment(item.segment, item.bytes));
        }
      } catch (error) {
        await this.deleteStoredSegments(created);
        throw error;
      }

      if (parsed.droppedBeforeBatch > 0) {
        await this.repository.incrementCounters({ droppedEvents: parsed.droppedBeforeBatch });
      }
      await this.writeStatusProjection();
      return result;
    });
  }

  private batchSnapshotSegmentId(
    batch: Pick<AppDiagnosticsEventBatch, "captureId" | "clientId" | "batchId">,
    snapshotId: string
  ): string {
    const digest = createHash("sha256")
      .update(`${batch.captureId}\0${batch.clientId}\0${batch.batchId}\0${snapshotId}`)
      .digest("hex")
      .slice(0, 32);
    return `app_debug_segment:${digest}`;
  }

  private async deleteStoredSegments(segments: AppDiagnosticsSegmentRecord[]): Promise<void> {
    for (const segment of [...segments].reverse()) {
      await this.removeStoredFile(segment);
    }
    await this.repository.deleteSegments(segments.map((segment) => segment.segmentId));
  }

  private async removeUnindexedPreparedFile(segment: AppDiagnosticsSegmentRecord): Promise<void> {
    if (await this.repository.getSegment(segment.segmentId)) return;
    try {
      const path = await this.resolveStoredFile(segment.relativePath);
      await unlink(path);
      await this.removeSegmentIndex(segment.relativePath);
    } catch (error) {
      if (
        error instanceof AppDiagnosticsServiceError &&
        error.code === "SEGMENT_PATH_INVALID" &&
        await this.storedPathIsMissingWithoutSymlinks(segment.relativePath)
      ) {
        await this.removeSegmentIndex(segment.relativePath);
        return;
      }
      throw error;
    }
  }

  async acquireVideoLease(input: {
    clientId: string;
    pageClientId: string;
    userId: string;
  }): Promise<AppDiagnosticsVideoLease> {
    const status = await this.getStatus();
    if (!status.isEnabled || !status.captureId) {
      throw new AppDiagnosticsServiceError("CAPTURE_INACTIVE", "App diagnostics is disabled.", 409);
    }
    const acquiredAt = this.now().toISOString();
    try {
      const lease = await this.repository.acquireVideoLease({
        leaseId: this.createId("app_debug_lease"),
        captureId: status.captureId,
        clientId: input.clientId,
        pageClientId: input.pageClientId,
        userId: input.userId,
        acquiredAt,
        expiresAt: new Date(Date.parse(acquiredAt) + appDiagnosticsVideoLeaseTtlSeconds * 1_000).toISOString()
      });
      await this.writeStatusProjection();
      return toPublicLease(lease);
    } catch (error) {
      throw this.mapRepositoryError(error);
    }
  }

  async heartbeatVideoLease(
    leaseId: string,
    captureId: string,
    userId: string
  ): Promise<AppDiagnosticsVideoLease> {
    const at = this.now().toISOString();
    try {
      const lease = await this.repository.heartbeatVideoLease({
        leaseId,
        captureId,
        userId,
        at,
        expiresAt: new Date(Date.parse(at) + appDiagnosticsVideoLeaseTtlSeconds * 1_000).toISOString()
      });
      await this.writeStatusProjection();
      return toPublicLease(lease);
    } catch (error) {
      throw this.mapRepositoryError(error);
    }
  }

  async releaseVideoLease(leaseId: string, userId: string): Promise<AppDiagnosticsVideoLease> {
    try {
      const lease = await this.repository.releaseVideoLease({
        leaseId,
        userId,
        at: this.now().toISOString()
      });
      await this.writeStatusProjection();
      return toPublicLease(lease);
    } catch (error) {
      throw this.mapRepositoryError(error);
    }
  }

  async uploadVideoSegment(input: UploadAppDiagnosticsVideoSegmentInput): Promise<AppDiagnosticsSegmentMetadata> {
    const query = appDiagnosticsVideoSegmentQuerySchema.parse({
      startedAt: input.startedAt,
      endedAt: input.endedAt,
      firstEventSequence: input.firstEventSequence,
      lastEventSequence: input.lastEventSequence
    });
    if (!Number.isInteger(input.sequence) || input.sequence < 0 || input.sequence > 1_000_000) {
      throw new AppDiagnosticsServiceError("VIDEO_MAGIC_INVALID", "Video segment sequence is invalid.", 422);
    }
    if (!videoMimePattern.test(input.mimeType.trim())) {
      await this.repository.incrementCounters({ rejectedUploads: 1 });
      throw new AppDiagnosticsServiceError("VIDEO_MIME_INVALID", "Only WebM diagnostics video is accepted.", 415);
    }
    if (input.bytes.byteLength > appDiagnosticsVideoSegmentMaxBytes) {
      await this.repository.incrementCounters({ rejectedUploads: 1 });
      throw new AppDiagnosticsServiceError("VIDEO_TOO_LARGE", "Diagnostics video segment exceeds 4 MiB.", 413);
    }
    if (input.bytes.byteLength < webmMagic.byteLength || !input.bytes.subarray(0, 4).equals(webmMagic)) {
      await this.repository.incrementCounters({ rejectedUploads: 1 });
      throw new AppDiagnosticsServiceError("VIDEO_MAGIC_INVALID", "Diagnostics video is not a WebM container.", 415);
    }
    await this.assertRetainableTimestamps([query.startedAt, query.endedAt], 0);

    return this.withWriteLock(async () => {
      const lease = await this.repository.getVideoLease(input.leaseId);
      const setting = await this.repository.getSetting();
      const now = this.now().toISOString();
      if (
        !lease ||
        lease.status !== "ACTIVE" ||
        lease.userId !== input.userId ||
        lease.expiresAt <= now ||
        !setting.enabled ||
        setting.activeCaptureId !== lease.captureId
      ) {
        await this.repository.incrementCounters({ rejectedUploads: 1 });
        throw new AppDiagnosticsServiceError("VIDEO_LEASE_STALE", "The diagnostics recorder lease is stale.", 409);
      }
      const segmentId = this.createId("app_debug_segment");
      const segment = await this.persistSegment({
        segmentId,
        captureId: lease.captureId,
        clientId: lease.clientId,
        leaseId: lease.leaseId,
        kind: "VIDEO",
        relativePath: this.relativeSegmentPath(
          lease.captureId,
          lease.clientId,
          "video",
          `${String(input.sequence).padStart(8, "0")}-${segmentId.replaceAll(":", "-")}.webm`
        ),
        mimeType: "video/webm",
        byteSize: input.bytes.byteLength,
        firstEventSequence: query.firstEventSequence,
        lastEventSequence: query.lastEventSequence,
        startedAt: query.startedAt,
        endedAt: query.endedAt,
        expiresAt: expiresAt(query.endedAt)
      }, input.bytes);
      await this.writeStatusProjection();
      return this.toPublicSegment(segment);
    });
  }

  async listSegments(input: unknown): Promise<{
    data: AppDiagnosticsSegmentMetadata[];
    pagination: { page: number; pageSize: number; totalItems: number; totalPages: number };
  }> {
    const query = appDiagnosticsSegmentListQuerySchema.parse(input);
    const filters = {
      captureId: query.captureId,
      kind: query.kind,
      expiresAfter: this.now().toISOString()
    };
    const [active, totalItems] = await Promise.all([
      this.repository.listSegments({
        ...filters,
        limit: query.pageSize,
        offset: (query.page - 1) * query.pageSize
      }),
      this.repository.countSegments(filters)
    ]);
    return {
      data: active.map((segment) => this.toPublicSegment(segment)),
      pagination: {
        page: query.page,
        pageSize: query.pageSize,
        totalItems,
        totalPages: Math.ceil(totalItems / query.pageSize)
      }
    };
  }

  async openSegment(
    segmentId: string,
    _userId: string
  ): Promise<{ segment: AppDiagnosticsSegmentMetadata; path: string }> {
    const segment = await this.repository.getSegment(segmentId);
    if (!segment) {
      throw new AppDiagnosticsServiceError("SEGMENT_NOT_FOUND", "Diagnostics segment was not found.", 404);
    }
    if (segment.expiresAt <= this.now().toISOString()) {
      throw new AppDiagnosticsServiceError("SEGMENT_EXPIRED", "Diagnostics segment has expired.", 404);
    }
    return {
      segment: this.toPublicSegment(segment),
      path: await this.resolveStoredFile(segment.relativePath)
    };
  }

  async sweepExpired(): Promise<{ segmentsDeleted: number; leasesDeleted: number; capturesDeleted: number }> {
    return this.withWriteLock(async () => {
      const at = this.now().toISOString();
      const expired = await this.repository.listExpiredSegments(at);
      for (const segment of expired) {
        await this.removeStoredFile(segment);
      }
      const segmentsDeleted = await this.repository.deleteSegments(expired.map((segment) => segment.segmentId));
      const metadata = await this.repository.pruneExpiredMetadata(at);
      await this.removeEmptyDiagnosticsDirectories();
      await this.writeStatusProjection();
      return { segmentsDeleted, ...metadata };
    });
  }

  async dispose(): Promise<void> {
    try {
      await this.repository.dispose();
    } finally {
      if (this.cleanupRootOnDispose) {
        await rm(this.root, { recursive: true, force: true });
      }
    }
  }

  private async assertActiveCapture(captureId: string, droppedEvents: number): Promise<void> {
    const setting = await this.repository.getSetting();
    if (!setting.enabled || setting.activeCaptureId !== captureId) {
      await this.repository.incrementCounters({ rejectedUploads: 1, droppedEvents });
      throw new AppDiagnosticsServiceError("CAPTURE_INACTIVE", "The diagnostics capture is no longer active.", 409);
    }
  }

  private async assertRetainableTimestamps(timestamps: string[], droppedEvents: number): Promise<void> {
    const now = this.now().getTime();
    if (timestamps.some((timestamp) => {
      const value = Date.parse(timestamp);
      return value > now + appDiagnosticsClockSkewMs || value <= now - appDiagnosticsRetentionMs;
    })) {
      await this.repository.incrementCounters({ rejectedUploads: 1, droppedEvents });
      throw new AppDiagnosticsServiceError(
        "SEGMENT_TIME_INVALID",
        "Diagnostics timestamps fall outside the rolling retention window.",
        422
      );
    }
  }

  private async persistSegment(
    segment: AppDiagnosticsSegmentRecord,
    bytes: Buffer
  ): Promise<AppDiagnosticsSegmentRecord> {
    await this.enforceQuota(segment.kind, bytes.byteLength);
    const path = await this.prepareStoredFile(segment.relativePath);
    let created: AppDiagnosticsSegmentRecord | null = null;
    let contentWritten = false;
    try {
      await writeFile(path, bytes, {
        flag: "wx",
        mode: segment.kind === "VIDEO" ? 0o640 : 0o644
      });
      contentWritten = true;
      await chmod(path, segment.kind === "VIDEO" ? 0o640 : 0o644);
      created = await this.repository.createSegment(segment);
      await this.writeSegmentIndex(created, path);
      return created;
    } catch (error) {
      if (created) {
        await this.repository.deleteSegments([created.segmentId]).catch(() => undefined);
      }
      if (contentWritten) {
        await this.removeSegmentIndex(segment.relativePath).catch(() => undefined);
        await unlink(path).catch(() => undefined);
      }
      if (!contentWritten && isFileSystemError(error, "EEXIST")) {
        throw new AppDiagnosticsServiceError("SEGMENT_PATH_INVALID", "Diagnostics segment path already exists.", 409);
      }
      throw this.mapRepositoryError(error);
    }
  }

  private async enforceQuota(kind: AppDiagnosticsSegmentKind, incomingBytes: number): Promise<void> {
    const technical = kind === "TECHNICAL";
    const quota = technical ? this.technicalQuotaBytes : this.visualQuotaBytes;
    if (incomingBytes > quota) {
      await this.repository.incrementCounters({ quotaDrops: 1 });
      throw new AppDiagnosticsServiceError("QUOTA_EXCEEDED", "Diagnostics segment exceeds its storage quota.", 507);
    }
    let usage = await this.repository.getUsage();
    if (usage.segmentCount >= this.maxSegments) {
      let toRemove = usage.segmentCount - this.maxSegments + 1;
      let removedCount = 0;
      while (toRemove > 0) {
        const candidates = await this.repository.listSegments({
          oldestFirst: true,
          limit: Math.min(1_000, toRemove)
        });
        if (!candidates.length) break;
        await this.deleteStoredSegments(candidates);
        removedCount += candidates.length;
        toRemove -= candidates.length;
      }
      if (removedCount > 0) {
        await this.repository.incrementCounters({ quotaDrops: removedCount });
        usage = await this.repository.getUsage();
      }
      if (usage.segmentCount >= this.maxSegments) {
        await this.repository.incrementCounters({ quotaDrops: 1 });
        throw new AppDiagnosticsServiceError("QUOTA_EXCEEDED", "Diagnostics segment index is full.", 507);
      }
    }
    let current = technical ? usage.technicalBytes : usage.visualBytes;
    if (current + incomingBytes <= quota) return;

    let removedCount = 0;
    while (current + incomingBytes > quota) {
      const candidates = await this.repository.listSegments({
        kinds: technical ? ["TECHNICAL"] : ["DOM_SNAPSHOT", "VIDEO"],
        oldestFirst: true,
        limit: 1_000
      });
      if (!candidates.length) break;
      const removed: string[] = [];
      for (const segment of candidates) {
        await this.removeStoredFile(segment);
        removed.push(segment.segmentId);
        current -= segment.byteSize;
        if (current + incomingBytes <= quota) break;
      }
      await this.repository.deleteSegments(removed);
      removedCount += removed.length;
    }
    if (removedCount > 0) {
      await this.repository.incrementCounters({ quotaDrops: removedCount });
    }
    if (current + incomingBytes > quota) {
      await this.repository.incrementCounters({ quotaDrops: 1 });
      throw new AppDiagnosticsServiceError("QUOTA_EXCEEDED", "Diagnostics storage quota is exhausted.", 507);
    }
  }

  private toPublicSegment(segment: AppDiagnosticsSegmentRecord): AppDiagnosticsSegmentMetadata {
    return appDiagnosticsSegmentMetadataSchema.parse({
      segmentId: segment.segmentId,
      captureId: segment.captureId,
      clientId: segment.clientId,
      leaseId: segment.leaseId,
      kind: segment.kind,
      mimeType: segment.mimeType,
      byteSize: segment.byteSize,
      firstEventSequence: segment.firstEventSequence,
      lastEventSequence: segment.lastEventSequence,
      startedAt: segment.startedAt,
      endedAt: segment.endedAt,
      expiresAt: segment.expiresAt,
      downloadUrl: `/api/admin/app-diagnostics/segments/${encodeURIComponent(segment.segmentId)}/content`
    });
  }

  private relativeSegmentPath(
    captureId: string,
    clientId: string,
    category: "technical" | "snapshots" | "video",
    filename: string
  ): string {
    return join(captureId, clientId, category, filename);
  }

  private async prepareStoredFile(relativePath: string): Promise<string> {
    const target = this.resolveRelativePath(relativePath);
    const parent = dirname(target);
    await mkdir(parent, { recursive: true, mode: 0o755 });
    await this.assertSafeDirectory(parent);
    return target;
  }

  private async assertSafeDirectory(path: string): Promise<void> {
    const rootRealPath = this.rootRealPath ?? await realpath(this.root);
    const relative = path.slice(this.root.length).split(sep).filter(Boolean);
    let current = this.root;
    for (const part of relative) {
      current = join(current, part);
      const info = await lstat(current);
      if (info.isSymbolicLink() || !info.isDirectory()) {
        throw new AppDiagnosticsServiceError("SEGMENT_PATH_INVALID", "Diagnostics storage path is not a real directory.", 409);
      }
      await chmod(current, 0o755);
    }
    const currentRealPath = await realpath(path);
    if (currentRealPath !== rootRealPath && !currentRealPath.startsWith(`${rootRealPath}${sep}`)) {
      throw new AppDiagnosticsServiceError("SEGMENT_PATH_INVALID", "Diagnostics storage path escaped its root.", 409);
    }
  }

  private async resolveStoredFile(relativePath: string): Promise<string> {
    const target = this.resolveRelativePath(relativePath);
    const rootRealPath = this.rootRealPath ?? await realpath(this.root);
    const parts = relativePath.split(/[\\/]/).filter(Boolean);
    let current = this.root;
    try {
      for (const part of parts) {
        current = join(current, part);
        const info = await lstat(current);
        if (info.isSymbolicLink()) {
          throw new AppDiagnosticsServiceError("SEGMENT_PATH_INVALID", "Diagnostics segment path contains a symbolic link.", 409);
        }
      }
      const targetInfo = await lstat(target);
      if (!targetInfo.isFile()) {
        throw new AppDiagnosticsServiceError("SEGMENT_PATH_INVALID", "Diagnostics segment path is not a regular file.", 409);
      }
      const targetRealPath = await realpath(target);
      if (!targetRealPath.startsWith(`${rootRealPath}${sep}`)) {
        throw new AppDiagnosticsServiceError("SEGMENT_PATH_INVALID", "Diagnostics segment path escaped its root.", 409);
      }
      return target;
    } catch (error) {
      if (error instanceof AppDiagnosticsServiceError) throw error;
      throw new AppDiagnosticsServiceError("SEGMENT_PATH_INVALID", "Diagnostics segment path is unavailable.", 409);
    }
  }

  private resolveRelativePath(relativePath: string): string {
    if (
      !relativePath ||
      isAbsolute(relativePath) ||
      relativePath.includes("\0") ||
      relativePath.split(/[\\/]/).some((part) => part === ".." || part === "." || !part)
    ) {
      throw new AppDiagnosticsServiceError("SEGMENT_PATH_INVALID", "Diagnostics segment path is invalid.", 409);
    }
    const target = resolve(this.root, relativePath);
    if (!target.startsWith(`${this.root}${sep}`)) {
      throw new AppDiagnosticsServiceError("SEGMENT_PATH_INVALID", "Diagnostics segment path escaped its root.", 409);
    }
    return target;
  }

  private async removeStoredFile(segment: AppDiagnosticsSegmentRecord): Promise<void> {
    try {
      const path = await this.resolveStoredFile(segment.relativePath);
      await unlink(path);
    } catch (error) {
      if (
        error instanceof AppDiagnosticsServiceError &&
        error.code === "SEGMENT_PATH_INVALID"
      ) {
        await this.removeSegmentIndex(segment.relativePath);
        return;
      }
      if (!isFileSystemError(error, "ENOENT")) throw error;
    }
    await this.removeSegmentIndex(segment.relativePath);
  }

  private segmentIndexPayload(segment: AppDiagnosticsSegmentRecord): string {
    return JSON.stringify({
      version: appDiagnosticsSegmentIndexVersion,
      segmentId: segment.segmentId,
      captureId: segment.captureId,
      clientId: segment.clientId,
      leaseId: segment.leaseId,
      kind: segment.kind,
      relativePath: segment.relativePath,
      mimeType: segment.mimeType,
      byteSize: segment.byteSize,
      firstEventSequence: segment.firstEventSequence,
      lastEventSequence: segment.lastEventSequence,
      startedAt: segment.startedAt,
      endedAt: segment.endedAt,
      expiresAt: segment.expiresAt
    });
  }

  private async writeSegmentIndex(
    segment: AppDiagnosticsSegmentRecord,
    contentPath?: string
  ): Promise<void> {
    const path = contentPath ?? await this.resolveStoredFile(segment.relativePath);
    const destination = `${path}.meta.json`;
    const temporary = join(
      dirname(path),
      `.segment-index-${process.pid}-${Date.now()}-${segment.segmentId.replaceAll(":", "-")}.tmp`
    );
    try {
      await writeFile(temporary, this.segmentIndexPayload(segment), { mode: 0o644 });
      await rename(temporary, destination);
      await chmod(destination, 0o644);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  }

  private async removeSegmentIndex(relativePath: string): Promise<void> {
    const path = this.resolveRelativePath(`${relativePath}.meta.json`);
    try {
      const info = await lstat(path);
      if (info.isDirectory()) {
        throw new AppDiagnosticsServiceError(
          "SEGMENT_PATH_INVALID",
          "Diagnostics segment index is not a regular file.",
          409
        );
      }
      await unlink(path);
    } catch (error) {
      if (!isFileSystemError(error, "ENOENT")) throw error;
    }
  }

  private async reconcileSegmentIndexes(): Promise<void> {
    const at = this.now().toISOString();
    let missingSegments = 0;
    let afterEndedAt: string | undefined;
    let afterSegmentId: string | undefined;
    while (true) {
      const segments = await this.repository.listSegments({
        expiresAfter: at,
        oldestFirst: true,
        afterEndedAt,
        afterSegmentId,
        limit: 1_000
      });
      if (!segments.length) break;
      for (const segment of segments) {
        let contentPath: string;
        try {
          contentPath = await this.resolveStoredFile(segment.relativePath);
        } catch (error) {
          if (!await this.storedPathIsMissingWithoutSymlinks(segment.relativePath)) throw error;
          await this.removeSegmentIndex(segment.relativePath);
          await this.repository.deleteSegments([segment.segmentId]);
          missingSegments += 1;
          continue;
        }
        await chmod(contentPath, segment.kind === "VIDEO" ? 0o640 : 0o644);
        const destination = `${contentPath}.meta.json`;
        const expected = this.segmentIndexPayload(segment);
        let current: string | null = null;
        try {
          const info = await lstat(destination);
          if (info.isFile() && !info.isSymbolicLink() && info.size <= 16 * 1024) {
            current = await readFile(destination, "utf8");
          }
        } catch (error) {
          if (!isFileSystemError(error, "ENOENT")) throw error;
        }
        if (current !== expected) {
          await this.writeSegmentIndex(segment, contentPath);
        } else {
          await chmod(destination, 0o644);
        }
      }
      const last = segments.at(-1)!;
      afterEndedAt = last.endedAt;
      afterSegmentId = last.segmentId;
      if (segments.length < 1_000) break;
    }
    if (missingSegments > 0) {
      await this.repository.pruneExpiredMetadata(at);
    }
  }

  private async removeEmptyDiagnosticsDirectories(): Promise<void> {
    let entries: { name: string; isDir: boolean }[];
    try {
      entries = await readdir(this.root, { withFileTypes: true }).then((list) =>
        list.map((entry) => ({ name: entry.name, isDir: entry.isDirectory() }))
      );
    } catch (error) {
      if (isFileSystemError(error, "ENOENT")) return;
      throw error;
    }
    for (const entry of entries) {
      if (!entry.isDir || !entry.name.startsWith("app_debug_capture:")) continue;
      const captureDir = join(this.root, entry.name);
      let captureEmpty = true;
      let clientEntries: { name: string; isDir: boolean }[];
      try {
        clientEntries = await readdir(captureDir, { withFileTypes: true }).then((list) =>
          list.map((e) => ({ name: e.name, isDir: e.isDirectory() }))
        );
      } catch {
        continue;
      }
      for (const clientEntry of clientEntries) {
        if (!clientEntry.isDir || !clientEntry.name.startsWith("app_debug_client:")) {
          if (clientEntry.name !== "status.json" && !clientEntry.name.startsWith(".")) {
            captureEmpty = false;
          }
          continue;
        }
        const clientDir = join(captureDir, clientEntry.name);
        let clientEmpty = true;
        const kindDirs = ["technical", "snapshots", "video"];
        for (const kind of kindDirs) {
          const kindDir = join(clientDir, kind);
          try {
            const kindEntries = await readdir(kindDir);
            if (kindEntries.length > 0) {
              clientEmpty = false;
            } else {
              await rmdir(kindDir).catch(() => undefined);
            }
          } catch (error) {
            if (!isFileSystemError(error, "ENOENT")) throw error;
          }
        }
        if (clientEmpty) {
          const remaining = await readdir(clientDir).catch(() => [] as string[]);
          const onlyMeta = remaining.every((name) =>
            name === "status.json" || name.startsWith(".")
          );
          if (onlyMeta) {
            for (const name of remaining) {
              await unlink(join(clientDir, name)).catch(() => undefined);
            }
            await rmdir(clientDir).catch(() => undefined);
          } else {
            captureEmpty = false;
          }
        } else {
          captureEmpty = false;
        }
      }
      if (captureEmpty) {
        const remaining = await readdir(captureDir).catch(() => [] as string[]);
        const onlyMeta = remaining.every((name) =>
          name === "status.json" || name.startsWith(".")
        );
        if (onlyMeta) {
          for (const name of remaining) {
            await unlink(join(captureDir, name)).catch(() => undefined);
          }
          await rmdir(captureDir).catch(() => undefined);
        }
      }
    }
  }

  private async storedPathIsMissingWithoutSymlinks(relativePath: string): Promise<boolean> {
    let current = this.root;
    for (const part of relativePath.split(/[\\/]/).filter(Boolean)) {
      current = join(current, part);
      try {
        const info = await lstat(current);
        if (info.isSymbolicLink()) return false;
      } catch (error) {
        if (isFileSystemError(error, "ENOENT")) return true;
        throw error;
      }
    }
    return false;
  }

  private mapRepositoryError(error: unknown): Error {
    if (!(error instanceof AppDiagnosticsRepositoryConflictError)) {
      return error instanceof Error ? error : new Error("App diagnostics repository failed.");
    }
    if (error.code === "VIDEO_LEASE_HELD") {
      return new AppDiagnosticsServiceError("VIDEO_LEASE_HELD", error.message, 409);
    }
    if (error.code === "VIDEO_LEASE_STALE") {
      return new AppDiagnosticsServiceError("VIDEO_LEASE_STALE", error.message, 409);
    }
    if (error.code === "STALE_CAPTURE") {
      return new AppDiagnosticsServiceError("CAPTURE_INACTIVE", error.message, 409);
    }
    return error;
  }

  private async writeStatusProjection(): Promise<void> {
    const status = await this.getStatus();
    const destination = join(this.root, "status.json");
    const temporary = join(this.root, `.status-${process.pid}-${crypto.randomUUID()}.json`);
    try {
      await writeFile(temporary, JSON.stringify(status), { mode: 0o644 });
      await rename(temporary, destination);
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
  }

  private async withWriteLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.writeTail;
    let release: () => void = () => undefined;
    this.writeTail = new Promise<void>((resolvePromise) => {
      release = resolvePromise;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}
