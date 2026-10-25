import { describe, expect, it } from "vitest";
import {
  AppDiagnosticsRepositoryConflictError,
  InMemoryAppDiagnosticsRepository
} from "../src/index.js";

const t0 = "2026-07-24T10:00:00.000Z";
const captureId = "app_debug_capture:abcdefgh1234";

function leaseInput(leaseId: string, at: string, expiresAt: string) {
  return {
    leaseId,
    captureId,
    clientId: "app_debug_client:abcdefgh1234",
    pageClientId: `app_debug_page:${leaseId.slice(-8)}`,
    userId: "user:admin",
    acquiredAt: at,
    expiresAt
  };
}

describe("InMemoryAppDiagnosticsRepository", () => {
  it("keeps enable and disable idempotent while creating one capture session", async () => {
    const repository = new InMemoryAppDiagnosticsRepository();
    expect(await repository.getSetting()).toMatchObject({ enabled: false, activeCaptureId: null });

    const enabled = await repository.setEnabled({
      isEnabled: true,
      captureId,
      actorUserId: "user:admin",
      at: t0
    });
    const repeated = await repository.setEnabled({
      isEnabled: true,
      captureId: "app_debug_capture:ignored1234",
      actorUserId: "user:admin",
      at: "2026-07-24T10:00:01.000Z"
    });

    expect(enabled.activeCaptureId).toBe(captureId);
    expect(repeated).toEqual(enabled);
    expect(await repository.listCaptures()).toHaveLength(1);

    const disabled = await repository.setEnabled({
      isEnabled: false,
      captureId: null,
      actorUserId: "user:admin",
      at: "2026-07-24T10:01:00.000Z"
    });
    const repeatedOff = await repository.setEnabled({
      isEnabled: false,
      captureId: null,
      actorUserId: "user:admin",
      at: "2026-07-24T10:02:00.000Z"
    });

    expect(disabled).toMatchObject({ enabled: false, activeCaptureId: null });
    expect(repeatedOff).toEqual(disabled);
    expect((await repository.listCaptures())[0]).toMatchObject({
      captureId,
      endedAt: "2026-07-24T10:01:00.000Z"
    });
  });

  it("allows only one active recorder and recovers after lease expiry", async () => {
    const repository = new InMemoryAppDiagnosticsRepository();
    await repository.setEnabled({ isEnabled: true, captureId, actorUserId: "user:admin", at: t0 });

    const first = await repository.acquireVideoLease(
      leaseInput("app_debug_lease:first1234", t0, "2026-07-24T10:01:30.000Z")
    );
    expect(first.status).toBe("ACTIVE");
    await expect(repository.acquireVideoLease(
      leaseInput("app_debug_lease:second123", "2026-07-24T10:00:30.000Z", "2026-07-24T10:02:00.000Z")
    )).rejects.toBeInstanceOf(AppDiagnosticsRepositoryConflictError);

    const second = await repository.acquireVideoLease(
      leaseInput("app_debug_lease:second123", "2026-07-24T10:01:31.000Z", "2026-07-24T10:03:01.000Z")
    );
    expect(second.status).toBe("ACTIVE");
    expect(await repository.getVideoLease(first.leaseId)).toMatchObject({ status: "EXPIRED" });

    const heartbeat = await repository.heartbeatVideoLease({
      leaseId: second.leaseId,
      captureId,
      userId: "user:admin",
      at: "2026-07-24T10:02:00.000Z",
      expiresAt: "2026-07-24T10:03:30.000Z"
    });
    expect(heartbeat.expiresAt).toBe("2026-07-24T10:03:30.000Z");
    await expect(repository.releaseVideoLease({
      leaseId: second.leaseId,
      userId: "user:admin",
      at: "2026-07-24T10:02:01.000Z"
    })).resolves.toMatchObject({ status: "RELEASED" });
  });

  it("rejects stale-capture segments and removes expired usage atomically", async () => {
    const repository = new InMemoryAppDiagnosticsRepository();
    await repository.setEnabled({ isEnabled: true, captureId, actorUserId: "user:admin", at: t0 });
    await repository.createSegment({
      segmentId: "app_debug_segment:technical1",
      captureId,
      clientId: "app_debug_client:abcdefgh1234",
      leaseId: null,
      kind: "TECHNICAL",
      relativePath: `${captureId}/technical/app_debug_segment-technical1.ndjson.gz`,
      mimeType: "application/x-ndjson+gzip",
      byteSize: 1_024,
      firstEventSequence: 1,
      lastEventSequence: 3,
      startedAt: t0,
      endedAt: "2026-07-24T10:00:02.000Z",
      expiresAt: "2026-07-25T10:00:02.000Z"
    });
    expect(await repository.getUsage()).toEqual({
      technicalBytes: 1_024,
      visualBytes: 0,
      totalBytes: 1_024,
      segmentCount: 1
    });

    await repository.setEnabled({
      isEnabled: false,
      captureId: null,
      actorUserId: "user:admin",
      at: "2026-07-24T10:01:00.000Z"
    });
    await expect(repository.createSegment({
      segmentId: "app_debug_segment:stale1234",
      captureId,
      clientId: "app_debug_client:abcdefgh1234",
      leaseId: null,
      kind: "TECHNICAL",
      relativePath: `${captureId}/technical/app_debug_segment-stale1234.ndjson.gz`,
      mimeType: "application/x-ndjson+gzip",
      byteSize: 12,
      firstEventSequence: 4,
      lastEventSequence: 4,
      startedAt: t0,
      endedAt: t0,
      expiresAt: "2026-07-25T10:00:00.000Z"
    })).rejects.toBeInstanceOf(AppDiagnosticsRepositoryConflictError);

    const expired = await repository.listExpiredSegments("2026-07-25T10:00:03.000Z");
    expect(expired.map((segment) => segment.segmentId)).toEqual(["app_debug_segment:technical1"]);
    await repository.deleteSegments(expired.map((segment) => segment.segmentId));
    await repository.pruneExpiredMetadata("2026-07-25T10:00:03.000Z");
    expect(await repository.getUsage()).toMatchObject({ totalBytes: 0, segmentCount: 0 });
    expect(await repository.listCaptures()).toHaveLength(0);
  });

  it("supports cursor and offset pagination with exact filtered counts", async () => {
    const repository = new InMemoryAppDiagnosticsRepository();
    await repository.setEnabled({ isEnabled: true, captureId, actorUserId: "user:admin", at: t0 });
    for (let index = 0; index < 5; index += 1) {
      const suffix = String(index).padStart(4, "0");
      const technical = index % 2 === 0;
      await repository.createSegment({
        segmentId: `app_debug_segment:${suffix}abcd`,
        captureId,
        clientId: "app_debug_client:abcdefgh1234",
        leaseId: null,
        kind: technical ? "TECHNICAL" : "DOM_SNAPSHOT",
        relativePath: `${captureId}/client/${suffix}`,
        mimeType: technical ? "application/x-ndjson+gzip" : "application/json+gzip",
        byteSize: 100 + index,
        firstEventSequence: index,
        lastEventSequence: index,
        startedAt: t0,
        endedAt: `2026-07-24T10:00:0${index}.000Z`,
        expiresAt: `2026-07-25T10:00:0${index}.000Z`
      });
    }

    const first = await repository.listSegments({ oldestFirst: true, limit: 2 });
    const second = await repository.listSegments({
      oldestFirst: true,
      afterEndedAt: first[1]!.endedAt,
      afterSegmentId: first[1]!.segmentId,
      limit: 2
    });
    const offsetPage = await repository.listSegments({ offset: 4, limit: 2 });

    expect(first.map((segment) => segment.segmentId)).toEqual([
      "app_debug_segment:0000abcd",
      "app_debug_segment:0001abcd"
    ]);
    expect(second.map((segment) => segment.segmentId)).toEqual([
      "app_debug_segment:0002abcd",
      "app_debug_segment:0003abcd"
    ]);
    expect(offsetPage.map((segment) => segment.segmentId)).toEqual([
      "app_debug_segment:0000abcd"
    ]);
    expect(await repository.countSegments({ captureId })).toBe(5);
    expect(await repository.countSegments({ kinds: ["DOM_SNAPSHOT", "VIDEO"] })).toBe(2);
  });

  it("enforces one technical segment per capture, client, and batch", async () => {
    const repository = new InMemoryAppDiagnosticsRepository();
    await repository.setEnabled({ isEnabled: true, captureId, actorUserId: "user:admin", at: t0 });
    const first = await repository.createSegment({
      segmentId: "app_debug_segment:batchfirst12",
      captureId,
      clientId: "app_debug_client:abcdefgh1234",
      batchId: "app_debug_batch:abcdefgh1234",
      batchFingerprint: "a".repeat(64),
      leaseId: null,
      kind: "TECHNICAL",
      relativePath: `${captureId}/technical/batch-first.ndjson.gz`,
      mimeType: "application/x-ndjson+gzip",
      byteSize: 100,
      firstEventSequence: 1,
      lastEventSequence: 1,
      startedAt: t0,
      endedAt: t0,
      expiresAt: "2026-07-25T10:00:00.000Z"
    });

    expect(await repository.getTechnicalSegmentByBatch(
      captureId,
      first.clientId,
      first.batchId!
    )).toEqual(first);
    await expect(repository.createSegment({
      ...first,
      segmentId: "app_debug_segment:batchsecond1",
      relativePath: `${captureId}/technical/batch-second.ndjson.gz`
    })).rejects.toMatchObject({ code: "SEGMENT_EXISTS" });
  });
});
