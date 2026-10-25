import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemoryAppDiagnosticsRepository } from "@space/db";
import type { AppDiagnosticsSegmentRecord } from "@space/db";
import {
  AppDiagnosticsService,
  AppDiagnosticsServiceError
} from "../src/app-diagnostics.js";

const roots: string[] = [];
const captureStartedAt = "2026-07-24T10:00:00.000Z";

class FailingSnapshotRepository extends InMemoryAppDiagnosticsRepository {
  override async createSegment(input: AppDiagnosticsSegmentRecord): Promise<AppDiagnosticsSegmentRecord> {
    if (input.kind === "DOM_SNAPSHOT") {
      throw new Error("snapshot write failed");
    }
    return super.createSegment(input);
  }
}

async function setup(options: {
  technicalQuotaBytes?: number;
  visualQuotaBytes?: number;
  maxSegments?: number;
  repository?: InMemoryAppDiagnosticsRepository;
} = {}) {
  const root = await mkdtemp(join(tmpdir(), "space-app-diagnostics-"));
  roots.push(root);
  const repository = options.repository ?? new InMemoryAppDiagnosticsRepository();
  let nowMs = Date.parse(captureStartedAt);
  let nextId = 0;
  const service = new AppDiagnosticsService({
    repository,
    root,
    now: () => new Date(nowMs),
    createId: (prefix) => `${prefix}:test${String(++nextId).padStart(8, "0")}`,
    quotaPolicy: {
      technicalQuotaBytes: options.technicalQuotaBytes,
      visualQuotaBytes: options.visualQuotaBytes,
      maxSegments: options.maxSegments
    }
  });
  await service.initialize();
  return {
    root,
    repository,
    service,
    setNow: (value: string) => {
      nowMs = Date.parse(value);
    }
  };
}

function technicalBatch(captureId: string) {
  return {
    captureId,
    clientId: "app_debug_client:abcdefgh1234",
    batchId: "app_debug_batch:abcdefgh1234",
    firstSequence: 1,
    lastSequence: 2,
    startedAt: "2026-07-24T10:00:00.100Z",
    endedAt: "2026-07-24T10:00:02.000Z",
    droppedBeforeBatch: 3,
    events: [
      {
        sequence: 1,
        occurredAt: "2026-07-24T10:00:00.100Z",
        category: "NETWORK" as const,
        transport: "HTTP" as const,
        phase: "COMPLETE" as const,
        method: "GET" as const,
        pathTemplate: "/api/rooms/123456789012345678",
        status: 200,
        durationMs: 12,
        correlationId: "sk-proj_private-correlation"
      },
      {
        sequence: 2,
        occurredAt: "2026-07-24T10:00:00.200Z",
        category: "ERROR" as const,
        name: "TypeError",
        code: "RENDER_FAILED",
        stackLocations: [
          { file: "/home/operator/private/project/src/App.tsx", line: 42, column: 8 },
          { file: "/assets/password/App.tsx", line: 43, column: 9 }
        ]
      }
    ],
    snapshots: [
      {
        snapshotId: "app_debug_snapshot:abcdefgh1234",
        anomalySequence: 2,
        capturedAt: "2026-07-24T10:00:00.210Z",
        truncated: false,
        nodes: [
          {
            index: 0,
            parentIndex: null,
            tag: "main",
            role: "main",
            classes: ["workspace-shell", "password-hunter2"],
            style: {
              display: "grid",
              visibility: "visible",
              opacity: "1",
              position: "relative",
              transform: "none",
              animationName: "password-hunter2",
              transitionProperty: "opacity"
            }
          }
        ]
      }
    ]
  };
}

function webm(byteSize = 700): Buffer {
  const value = Buffer.alloc(byteSize);
  value.set([0x1a, 0x45, 0xdf, 0xa3], 0);
  return value;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("AppDiagnosticsService", () => {
  it("removes only bounded ephemeral roots when an in-memory service is disposed", async () => {
    const root = await mkdtemp(join(tmpdir(), "space-app-diagnostics-"));
    const service = new AppDiagnosticsService({
      repository: new InMemoryAppDiagnosticsRepository(),
      root,
      cleanupRootOnDispose: true
    });
    await service.initialize();
    await service.dispose();

    await expect(stat(root)).rejects.toMatchObject({ code: "ENOENT" });
    expect(() => new AppDiagnosticsService({
      repository: new InMemoryAppDiagnosticsRepository(),
      root: "/opt/spaceapp/var/app-diagnostics",
      cleanupRootOnDispose: true
    })).toThrow(/bounded system temporary prefix/);
  });

  it("makes completed batch retries idempotent and rejects conflicting batch reuse", async () => {
    const { repository, service } = await setup();
    const enabled = await service.setEnabled(true, "user:admin");
    const batch = technicalBatch(enabled.captureId!);

    const first = await service.ingestEventBatch(batch);
    const firstSegments = await repository.listSegments({ captureId: enabled.captureId! });
    const firstCounters = (await service.getStatus()).counters;

    await expect(service.ingestEventBatch(batch)).resolves.toEqual(first);
    expect(await repository.listSegments({ captureId: enabled.captureId! })).toEqual(firstSegments);
    expect((await service.getStatus()).counters).toEqual(firstCounters);

    await expect(service.ingestEventBatch({
      ...batch,
      events: batch.events.map((event) => (
        event.category === "NETWORK" ? { ...event, status: 201 } : event
      ))
    })).rejects.toMatchObject({ code: "BATCH_CONFLICT" });
    expect(await repository.listSegments({ captureId: enabled.captureId! })).toEqual(firstSegments);
  });

  it("replaces an orphaned deterministic snapshot file left by an interrupted write", async () => {
    const { root, repository, service } = await setup();
    const enabled = await service.setEnabled(true, "user:admin");
    const batch = technicalBatch(enabled.captureId!);
    const snapshotId = batch.snapshots[0]!.snapshotId;
    const digest = createHash("sha256")
      .update(`${batch.captureId}\0${batch.clientId}\0${batch.batchId}\0${snapshotId}`)
      .digest("hex")
      .slice(0, 32);
    const segmentId = `app_debug_segment:${digest}`;
    const relativePath = join(
      batch.captureId,
      batch.clientId,
      "snapshots",
      `${segmentId.replaceAll(":", "-")}.json.gz`
    );
    await mkdir(join(root, dirname(relativePath)), { recursive: true });
    await writeFile(join(root, relativePath), Buffer.from("interrupted snapshot write"));

    await expect(service.ingestEventBatch(batch)).resolves.toMatchObject({
      acceptedEvents: 2,
      acceptedSnapshots: 1
    });
    expect(await repository.getSegment(segmentId)).toMatchObject({ relativePath });
    expect(gunzipSync(await readFile(join(root, relativePath))).toString("utf8"))
      .toContain(snapshotId);
  });

  it("removes an indexed partial batch before retrying the same content", async () => {
    const { root, repository, service } = await setup();
    const enabled = await service.setEnabled(true, "user:admin");
    const batch = technicalBatch(enabled.captureId!);
    await service.ingestEventBatch(batch);
    const firstSegments = await repository.listSegments({
      captureId: enabled.captureId!,
      batchId: batch.batchId
    });
    const firstTechnical = firstSegments.find((segment) => segment.kind === "TECHNICAL")!;
    const snapshot = firstSegments.find((segment) => segment.kind === "DOM_SNAPSHOT")!;
    await Promise.all([
      unlink(join(root, snapshot.relativePath)),
      unlink(join(root, `${snapshot.relativePath}.meta.json`))
    ]);
    await repository.deleteSegments([snapshot.segmentId]);

    await expect(service.ingestEventBatch(batch)).resolves.toMatchObject({
      acceptedEvents: 2,
      acceptedSnapshots: 1
    });
    const retried = await repository.listSegments({
      captureId: enabled.captureId!,
      batchId: batch.batchId
    });
    expect(retried).toHaveLength(2);
    expect(retried.find((segment) => segment.kind === "TECHNICAL")?.segmentId)
      .not.toBe(firstTechnical.segmentId);
    expect(retried.find((segment) => segment.kind === "DOM_SNAPSHOT")?.segmentId)
      .toBe(snapshot.segmentId);
  });

  it("rolls back every persisted segment when a later snapshot write fails", async () => {
    const repository = new FailingSnapshotRepository();
    const { root, service } = await setup({ repository });
    const enabled = await service.setEnabled(true, "user:admin");

    await expect(service.ingestEventBatch(technicalBatch(enabled.captureId!)))
      .rejects.toThrow("snapshot write failed");
    expect(await repository.listSegments({ captureId: enabled.captureId! })).toEqual([]);
    expect((await readdir(root, { recursive: true })).filter((entry) => (
      entry.endsWith(".gz") || entry.endsWith(".meta.json")
    ))).toEqual([]);
  });

  it("evicts the oldest segment when the bounded segment index reaches capacity", async () => {
    const { repository, service } = await setup({ maxSegments: 2 });
    const enabled = await service.setEnabled(true, "user:admin");
    await service.ingestEventBatch(technicalBatch(enabled.captureId!));

    const secondBatch = {
      ...technicalBatch(enabled.captureId!),
      batchId: "app_debug_batch:secondbatch12",
      firstSequence: 3,
      lastSequence: 3,
      startedAt: "2026-07-24T10:00:03.000Z",
      endedAt: "2026-07-24T10:00:03.000Z",
      droppedBeforeBatch: 0,
      events: [{
        sequence: 3,
        occurredAt: "2026-07-24T10:00:03.000Z",
        category: "LIFECYCLE" as const,
        event: "MOUNT" as const
      }],
      snapshots: []
    };
    await service.ingestEventBatch(secondBatch);

    const segments = await repository.listSegments({ captureId: enabled.captureId! });
    expect(segments).toHaveLength(2);
    expect(segments.some((segment) => segment.firstEventSequence === 3)).toBe(true);
    expect((await service.getStatus()).counters.quotaDrops).toBe(1);
  });

  it("stores only normalized gzip technical data and rejects late batches after OFF", async () => {
    const { root, repository, service } = await setup();
    const enabled = await service.setEnabled(true, "user:admin");
    expect(enabled.isEnabled).toBe(true);
    expect(enabled.captureId).toMatch(/^app_debug_capture:/);

    const result = await service.ingestEventBatch(technicalBatch(enabled.captureId!));
    expect(result.acceptedEvents).toBe(2);
    expect(result.acceptedSnapshots).toBe(1);
    expect(result.expiresAt).toBe("2026-07-25T10:00:02.000Z");

    const segments = await repository.listSegments({ captureId: enabled.captureId! });
    expect(segments.map((segment) => segment.kind).sort()).toEqual(["DOM_SNAPSHOT", "TECHNICAL"]);
    await expect(service.listSegments({
      captureId: enabled.captureId!,
      page: 2,
      pageSize: 1
    })).resolves.toMatchObject({
      data: [{ captureId: enabled.captureId! }],
      pagination: { page: 2, pageSize: 1, totalItems: 2, totalPages: 2 }
    });
    const technical = segments.find((segment) => segment.kind === "TECHNICAL")!;
    const payload = gunzipSync(await readFile(join(root, technical.relativePath))).toString("utf8");
    const sidecarPath = join(root, `${technical.relativePath}.meta.json`);
    const sidecar = JSON.parse(await readFile(sidecarPath, "utf8"));
    expect(payload).toContain("/api/rooms/:id");
    expect(payload).toContain("/src/App.tsx");
    expect(payload).not.toContain("123456789012345678");
    expect(payload).not.toContain("/home/operator/private");
    expect(payload).not.toContain("private-correlation");
    expect(payload).not.toContain("/password/");
    expect(sidecar).toMatchObject({
      version: 1,
      segmentId: technical.segmentId,
      captureId: technical.captureId,
      clientId: technical.clientId,
      kind: "TECHNICAL",
      relativePath: technical.relativePath,
      expiresAt: technical.expiresAt
    });
    expect(sidecar).not.toHaveProperty("userId");
    expect((await stat(root)).mode & 0o777).toBe(0o755);
    expect((await stat(join(root, technical.relativePath))).mode & 0o777).toBe(0o644);
    expect((await stat(sidecarPath)).mode & 0o777).toBe(0o644);
    expect((await service.getStatus()).counters.droppedEvents).toBe(3);

    const snapshot = segments.find((segment) => segment.kind === "DOM_SNAPSHOT")!;
    const snapshotPath = join(root, snapshot.relativePath);
    const snapshotPayload = gunzipSync(await readFile(snapshotPath)).toString("utf8");
    expect(snapshotPayload).not.toContain("password-hunter2");
    expect(snapshotPayload).not.toContain("workspace-shell");
    expect(snapshotPayload).toContain("\"animationName\":\"active\"");
    await Promise.all([
      unlink(sidecarPath),
      chmod(join(root, technical.relativePath), 0o600),
      chmod(snapshotPath, 0o600)
    ]);
    await service.initialize();
    expect(JSON.parse(await readFile(sidecarPath, "utf8"))).toMatchObject({
      segmentId: technical.segmentId,
      relativePath: technical.relativePath
    });
    expect((await stat(join(root, technical.relativePath))).mode & 0o777).toBe(0o644);
    expect((await stat(snapshotPath)).mode & 0o777).toBe(0o644);

    await unlink(join(root, technical.relativePath));
    await service.initialize();
    expect(await repository.getSegment(technical.segmentId)).toBeNull();
    await expect(readFile(sidecarPath)).rejects.toMatchObject({ code: "ENOENT" });

    await service.setEnabled(false, "user:admin");
    await expect(service.ingestEventBatch(technicalBatch(enabled.captureId!)))
      .rejects.toMatchObject({ code: "CAPTURE_INACTIVE" });
  });

  it("enforces one recorder, WebM magic bytes, and oldest-first visual quota eviction", async () => {
    const { root, repository, service, setNow } = await setup({ visualQuotaBytes: 1_000 });
    const status = await service.setEnabled(true, "user:admin");
    const captureId = status.captureId!;
    const lease = await service.acquireVideoLease({
      clientId: "app_debug_client:abcdefgh1234",
      pageClientId: "app_debug_page:abcdefgh1234",
      userId: "user:admin"
    });

    await expect(service.acquireVideoLease({
      clientId: "app_debug_client:otherclient12",
      pageClientId: "app_debug_page:otherclient12",
      userId: "user:admin"
    })).rejects.toMatchObject({ code: "VIDEO_LEASE_HELD" });

    await expect(service.uploadVideoSegment({
      leaseId: lease.leaseId,
      sequence: 0,
      userId: "user:admin",
      mimeType: "video/webm",
      bytes: Buffer.from("not webm"),
      startedAt: "2026-07-24T10:00:00.000Z",
      endedAt: "2026-07-24T10:00:30.000Z",
      firstEventSequence: 1,
      lastEventSequence: 2
    })).rejects.toMatchObject({ code: "VIDEO_MAGIC_INVALID" });

    const first = await service.uploadVideoSegment({
      leaseId: lease.leaseId,
      sequence: 0,
      userId: "user:admin",
      mimeType: "video/webm",
      bytes: webm(),
      startedAt: "2026-07-24T10:00:00.000Z",
      endedAt: "2026-07-24T10:00:30.000Z",
      firstEventSequence: 1,
      lastEventSequence: 2
    });
    const storedFirst = await repository.getSegment(first.segmentId);
    expect(storedFirst).not.toBeNull();
    setNow("2026-07-24T10:00:31.000Z");
    const heartbeat = await service.heartbeatVideoLease(lease.leaseId, captureId, "user:admin");
    expect(heartbeat.status).toBe("ACTIVE");
    const second = await service.uploadVideoSegment({
      leaseId: lease.leaseId,
      sequence: 1,
      userId: "user:admin",
      mimeType: "video/webm;codecs=vp8",
      bytes: webm(),
      startedAt: "2026-07-24T10:00:30.000Z",
      endedAt: "2026-07-24T10:01:00.000Z",
      firstEventSequence: 3,
      lastEventSequence: 4
    });

    expect(await repository.getSegment(first.segmentId)).toBeNull();
    expect(await repository.getSegment(second.segmentId)).not.toBeNull();
    await expect(readFile(join(root, `${storedFirst!.relativePath}.meta.json`)))
      .rejects.toMatchObject({ code: "ENOENT" });
    const storedSecond = await repository.getSegment(second.segmentId);
    expect((await stat(join(root, storedSecond!.relativePath))).mode & 0o777).toBe(0o640);
    expect(JSON.parse(await readFile(join(root, `${storedSecond!.relativePath}.meta.json`), "utf8")))
      .toMatchObject({ segmentId: second.segmentId, kind: "VIDEO" });
    await chmod(join(root, storedSecond!.relativePath), 0o600);
    await service.initialize();
    expect((await stat(join(root, storedSecond!.relativePath))).mode & 0o777).toBe(0o640);
    expect((await service.getStatus()).counters.quotaDrops).toBe(1);
  });

  it("publishes concurrent status updates without sharing a temporary path", async () => {
    vi.spyOn(Date, "now").mockReturnValue(123_456_789);
    const { root, service } = await setup();
    const status = await service.setEnabled(true, "user:admin");
    const lease = await service.acquireVideoLease({
      clientId: "app_debug_client:abcdefgh1234",
      pageClientId: "app_debug_page:abcdefgh1234",
      userId: "user:admin"
    });

    await expect(Promise.all([
      service.heartbeatVideoLease(lease.leaseId, status.captureId!, "user:admin"),
      service.heartbeatVideoLease(lease.leaseId, status.captureId!, "user:admin")
    ])).resolves.toHaveLength(2);

    const projected = JSON.parse(await readFile(join(root, "status.json"), "utf8"));
    expect(projected).toMatchObject({
      isEnabled: true,
      captureId: status.captureId,
      recorder: { status: "ACTIVE", leaseId: lease.leaseId }
    });
    expect((await readdir(root)).filter((entry) => entry.startsWith(".status-"))).toEqual([]);
  });

  it("denies expired downloads at the exact 24-hour boundary and rejects symlink paths", async () => {
    const { root, repository, service, setNow } = await setup();
    const status = await service.setEnabled(true, "user:admin");
    await expect(service.ingestEventBatch({
      ...technicalBatch(status.captureId!),
      endedAt: "2026-07-26T10:00:00.000Z"
    })).rejects.toMatchObject({ code: "SEGMENT_TIME_INVALID" });
    const result = await service.ingestEventBatch(technicalBatch(status.captureId!));
    const technical = (await repository.listSegments({ kind: "TECHNICAL" }))[0]!;

    setNow(result.expiresAt);
    await expect(service.openSegment(technical.segmentId, "user:admin"))
      .rejects.toMatchObject({ code: "SEGMENT_EXPIRED" });
    await service.sweepExpired();
    expect(await repository.getSegment(technical.segmentId)).toBeNull();
    await expect(readFile(join(root, `${technical.relativePath}.meta.json`))).rejects.toMatchObject({ code: "ENOENT" });

    setNow("2026-07-25T10:00:03.000Z");
    const next = await service.setEnabled(false, "user:admin");
    expect(next.isEnabled).toBe(false);
    const reenabled = await service.setEnabled(true, "user:admin");
    const outside = join(root, "outside.webm");
    await writeFile(outside, webm());
    await mkdir(join(root, reenabled.captureId!, "video"), { recursive: true });
    const relativePath = `${reenabled.captureId}/video/link.webm`;
    await symlink(outside, join(root, relativePath));
    await repository.createSegment({
      segmentId: "app_debug_segment:symlink1234",
      captureId: reenabled.captureId!,
      clientId: "app_debug_client:abcdefgh1234",
      leaseId: null,
      kind: "VIDEO",
      relativePath,
      mimeType: "video/webm",
      byteSize: 700,
      firstEventSequence: 1,
      lastEventSequence: 2,
      startedAt: "2026-07-25T10:00:03.000Z",
      endedAt: "2026-07-25T10:00:04.000Z",
      expiresAt: "2026-07-26T10:00:04.000Z"
    });
    await expect(service.openSegment("app_debug_segment:symlink1234", "user:admin"))
      .rejects.toBeInstanceOf(AppDiagnosticsServiceError);
    await expect(service.openSegment("app_debug_segment:symlink1234", "user:admin"))
      .rejects.toMatchObject({ code: "SEGMENT_PATH_INVALID" });
  });
});
