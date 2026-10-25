import { describe, expect, it } from "vitest";
import {
  systemAnalyticsRollupWindows,
  type SystemAnalyticsResourceSample
} from "../src/system-analytics-repository.js";

/**
 * A small in-memory model of the SQL in PostgresSystemAnalyticsRepository:
 * the 10 s accumulate-upsert, the GROUP BY rollup (latest-wins attributes,
 * sum/min/max, bool_or) with a `bucket_at >= since` source window, and the
 * retention sweep. It is used to run the original fixed windows (3 h / 3 days)
 * and the watermark windows side by side on the same event stream.
 */
type Resolution = 10 | 60 | 900;
interface Row {
  bucketMs: number;
  entityType: string;
  entityId: string;
  roomId: string | null;
  roomName: string | null;
  paneId: string | null;
  paneTitle: string | null;
  sessionId: string | null;
  runtimeId: string | null;
  runtimeName: string | null;
  providerId: string | null;
  modelId: string | null;
  sampleCount: number;
  processCount: number;
  cpuMin: number;
  cpuSum: number;
  cpuMax: number;
  rssMin: number;
  rssSum: number;
  rssMax: number;
  memoryTotalBytes: number | null;
  memoryAvailableBytes: number | null;
  swapTotalBytes: number | null;
  swapUsedBytes: number | null;
  pageCacheBytes: number | null;
  pressure: boolean | null;
}

const rowFields = [
  "bucketMs", "entityType", "entityId", "roomId", "roomName", "paneId", "paneTitle", "sessionId", "runtimeId",
  "runtimeName", "providerId", "modelId", "sampleCount", "processCount", "cpuMin", "cpuSum", "cpuMax", "rssMin",
  "rssSum", "rssMax", "memoryTotalBytes", "memoryAvailableBytes", "swapTotalBytes", "swapUsedBytes",
  "pageCacheBytes", "pressure"
] as const satisfies ReadonlyArray<keyof Row>;

/** Rows of one resolution, indexed by bucket time so windows and sweeps stay cheap. */
class FakeTable {
  readonly rows = new Map<string, Row>();
  private readonly times: number[] = [];
  private readonly keysByTime = new Map<number, Set<string>>();

  private firstIndexAtOrAfter(ms: number): number {
    let low = 0;
    let high = this.times.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (this.times[middle]! < ms) low = middle + 1;
      else high = middle;
    }
    return low;
  }

  set(key: string, row: Row): void {
    if (!this.rows.has(key)) {
      let keys = this.keysByTime.get(row.bucketMs);
      if (!keys) {
        keys = new Set();
        this.keysByTime.set(row.bucketMs, keys);
        this.times.splice(this.firstIndexAtOrAfter(row.bucketMs), 0, row.bucketMs);
      }
      keys.add(key);
    }
    this.rows.set(key, row);
  }

  *since(ms: number): Generator<Row> {
    for (let index = this.firstIndexAtOrAfter(ms); index < this.times.length; index += 1) {
      for (const key of this.keysByTime.get(this.times[index]!)!) yield this.rows.get(key)!;
    }
  }

  deleteBefore(ms: number): void {
    while (this.times.length && this.times[0]! < ms) {
      const time = this.times.shift()!;
      for (const key of this.keysByTime.get(time)!) this.rows.delete(key);
      this.keysByTime.delete(time);
    }
  }
}

class FakeBuckets {
  readonly tables = new Map<Resolution, FakeTable>([[10, new FakeTable()], [60, new FakeTable()], [900, new FakeTable()]]);
  aggregatedGroups = 0;
  changedRows = 0;

  private table(resolution: Resolution): FakeTable {
    return this.tables.get(resolution)!;
  }

  insertSample(sample: SystemAnalyticsResourceSample): void {
    const bucketMs = Math.floor(Date.parse(sample.sampledAt) / 10_000) * 10_000;
    const key = `${bucketMs}\u0000${sample.entityType}\u0000${sample.entityId}`;
    const existing = this.table(10).rows.get(key);
    if (!existing) {
      this.table(10).set(key, {
        bucketMs, entityType: sample.entityType, entityId: sample.entityId,
        roomId: sample.roomId, roomName: sample.roomName, paneId: sample.paneId, paneTitle: sample.paneTitle,
        sessionId: sample.sessionId, runtimeId: sample.runtimeId, runtimeName: sample.runtimeName,
        providerId: sample.providerId, modelId: sample.modelId, sampleCount: 1, processCount: sample.processCount,
        cpuMin: sample.cpuOneCorePercent, cpuSum: sample.cpuOneCorePercent, cpuMax: sample.cpuOneCorePercent,
        rssMin: sample.rssBytes, rssSum: sample.rssBytes, rssMax: sample.rssBytes,
        memoryTotalBytes: sample.memoryTotalBytes, memoryAvailableBytes: sample.memoryAvailableBytes,
        swapTotalBytes: sample.swapTotalBytes, swapUsedBytes: sample.swapUsedBytes,
        pageCacheBytes: sample.pageCacheBytes, pressure: sample.pressure
      });
      return;
    }
    // ON CONFLICT branch of insertResourceSamples (identity columns keep the first value).
    Object.assign(existing, {
      roomName: sample.roomName, paneTitle: sample.paneTitle, processCount: sample.processCount,
      cpuMin: Math.min(existing.cpuMin, sample.cpuOneCorePercent), cpuSum: existing.cpuSum + sample.cpuOneCorePercent,
      cpuMax: Math.max(existing.cpuMax, sample.cpuOneCorePercent), rssMin: Math.min(existing.rssMin, sample.rssBytes),
      rssSum: existing.rssSum + sample.rssBytes, rssMax: Math.max(existing.rssMax, sample.rssBytes),
      sampleCount: existing.sampleCount + 1, memoryTotalBytes: sample.memoryTotalBytes,
      memoryAvailableBytes: sample.memoryAvailableBytes, swapTotalBytes: sample.swapTotalBytes,
      swapUsedBytes: sample.swapUsedBytes, pageCacheBytes: sample.pageCacheBytes, pressure: sample.pressure
    });
  }

  rollup(source: 10 | 60, target: 60 | 900, sinceMs: number): void {
    const groups = new Map<string, { targetMs: number; members: Row[] }>();
    for (const row of this.table(source).since(sinceMs)) {
      const targetMs = Math.floor(row.bucketMs / (target * 1000)) * target * 1000;
      const key = `${targetMs}\u0000${row.entityType}\u0000${row.entityId}`;
      const group = groups.get(key);
      if (group) group.members.push(row);
      else groups.set(key, { targetMs, members: [row] });
    }
    for (const [key, { targetMs, members }] of groups) {
      this.aggregatedGroups += 1;
      // ORDER BY bucket_at DESC: latest-wins attributes and the cpu_sum order.
      members.sort((left, right) => right.bucketMs - left.bucketMs);
      const latest = members[0]!;
      const next: Row = {
        bucketMs: targetMs, entityType: latest.entityType, entityId: latest.entityId,
        roomId: latest.roomId, roomName: latest.roomName, paneId: latest.paneId, paneTitle: latest.paneTitle,
        sessionId: latest.sessionId, runtimeId: latest.runtimeId, runtimeName: latest.runtimeName,
        providerId: latest.providerId, modelId: latest.modelId, sampleCount: 0, processCount: latest.processCount,
        cpuMin: Number.POSITIVE_INFINITY, cpuSum: 0, cpuMax: Number.NEGATIVE_INFINITY,
        rssMin: Number.POSITIVE_INFINITY, rssSum: 0, rssMax: Number.NEGATIVE_INFINITY,
        memoryTotalBytes: latest.memoryTotalBytes, memoryAvailableBytes: latest.memoryAvailableBytes,
        swapTotalBytes: latest.swapTotalBytes, swapUsedBytes: latest.swapUsedBytes,
        pageCacheBytes: latest.pageCacheBytes, pressure: null
      };
      for (const row of members) {
        next.sampleCount += row.sampleCount;
        next.cpuMin = Math.min(next.cpuMin, row.cpuMin);
        next.cpuSum += row.cpuSum;
        next.cpuMax = Math.max(next.cpuMax, row.cpuMax);
        next.rssMin = Math.min(next.rssMin, row.rssMin);
        next.rssSum += row.rssSum;
        next.rssMax = Math.max(next.rssMax, row.rssMax);
        // bool_or ignores NULL inputs and is NULL only when every input is NULL.
        if (row.pressure !== null) next.pressure = Boolean(next.pressure) || row.pressure;
      }
      const previous = this.table(target).rows.get(key);
      if (!previous || rowFields.some((field) => previous[field] !== next[field])) this.changedRows += 1;
      this.table(target).set(key, next);
    }
  }

  sweep(atMs: number): void {
    this.table(10).deleteBefore(atMs - 2 * 3_600_000);
    this.table(60).deleteBefore(atMs - 48 * 3_600_000);
    this.table(900).deleteBefore(atMs - 31 * 86_400_000);
  }

  snapshot(resolution: Resolution): Record<string, Row> {
    return Object.fromEntries([...this.table(resolution).rows.entries()].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)));
  }
}

interface Algorithm {
  buckets: FakeBuckets;
  rollup(at: string): void;
  restart(): void;
}

function originalAlgorithm(): Algorithm {
  const buckets = new FakeBuckets();
  return {
    buckets,
    rollup(at) {
      const atMs = Date.parse(at);
      buckets.rollup(10, 60, atMs - 3 * 3_600_000);
      buckets.rollup(60, 900, atMs - 3 * 86_400_000);
      buckets.sweep(atMs);
    },
    restart() {}
  };
}

function watermarkAlgorithm(): Algorithm {
  const buckets = new FakeBuckets();
  let lastRollupAt: string | null = null;
  return {
    buckets,
    rollup(at) {
      const windows = systemAnalyticsRollupWindows(at, lastRollupAt);
      buckets.rollup(10, 60, Date.parse(windows.since60));
      buckets.rollup(60, 900, Date.parse(windows.since900));
      buckets.sweep(Date.parse(at));
      lastRollupAt = at;
    },
    restart() { lastRollupAt = null; }
  };
}

/** Deterministic pseudo-random numbers so failures are reproducible. */
function lcg(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 2 ** 32;
  };
}

type Event = { atMs: number; order: number; kind: "sample"; sample: SystemAnalyticsResourceSample }
  | { atMs: number; order: number; kind: "rollup" }
  | { atMs: number; order: number; kind: "restart" };

/**
 * 10 s samples for a host and a CLI session (the session appears late, is
 * renamed and toggles pressure), rollups every ~60 s with jitter, every 7th
 * sample committed 4.5 s after it was taken (so a rollup can run in between),
 * and an optional downtime window followed by a process restart.
 */
function timeline(input: {
  startMs: number;
  durationMs: number;
  withSession?: boolean;
  downtime?: [number, number];
  sampleEveryMs?: number;
  rollupEveryMs?: number;
}): Event[] {
  const sampleEveryMs = input.sampleEveryMs ?? 10_000;
  const rollupEveryMs = input.rollupEveryMs ?? 60_000;
  const random = lcg(42);
  const events: Event[] = [];
  let order = 0;
  const down = (ms: number) => Boolean(input.downtime && ms >= input.downtime[0] && ms < input.downtime[1]);
  for (let offset = 0, tick = 0; offset < input.durationMs; offset += sampleEveryMs, tick += 1) {
    const takenMs = input.startMs + offset + 3_000;
    if (down(takenMs)) continue;
    const sampledAt = new Date(takenMs).toISOString();
    const commitMs = tick % 7 === 3 ? takenMs + 4_500 : takenMs + 200;
    const host: SystemAnalyticsResourceSample = {
      sampledAt, entityType: "HOST", entityId: "host", roomId: null, roomName: null, paneId: null, paneTitle: null,
      sessionId: null, runtimeId: null, runtimeName: null, providerId: null, modelId: null,
      processCount: 200 + Math.floor(random() * 20), cpuOneCorePercent: Math.round(random() * 40_000) / 1000,
      rssBytes: 8_000_000_000 + Math.floor(random() * 1_000_000_000), memoryTotalBytes: 16_000_000_000,
      memoryAvailableBytes: 6_000_000_000 + Math.floor(random() * 1_000_000), swapTotalBytes: 1_000_000,
      swapUsedBytes: Math.floor(random() * 1_000), pageCacheBytes: 2_000_000_000, pressure: random() < 0.1
    };
    events.push({ atMs: commitMs, order: order++, kind: "sample", sample: host });
    if (input.withSession && offset >= 25 * 60_000) {
      events.push({
        atMs: commitMs, order: order++, kind: "sample",
        sample: {
          sampledAt, entityType: "CLI_SESSION", entityId: "cli_session:abc", roomId: "room:1",
          roomName: offset < 70 * 60_000 ? "Room before rename" : "Room after rename", paneId: "pane:1",
          paneTitle: "Pane", sessionId: "cli_session:abc", runtimeId: "cli:codex", runtimeName: "Codex",
          providerId: "codex", modelId: "gpt", processCount: 3, cpuOneCorePercent: Math.round(random() * 9_000) / 100,
          rssBytes: 300_000_000 + Math.floor(random() * 10_000_000), memoryTotalBytes: null,
          memoryAvailableBytes: null, swapTotalBytes: null, swapUsedBytes: null, pageCacheBytes: null,
          pressure: null
        }
      });
    }
  }
  for (let offset = rollupEveryMs; offset <= input.durationMs; offset += rollupEveryMs) {
    const atMs = input.startMs + offset + Math.floor(random() * 5_000);
    if (down(atMs)) continue;
    events.push({ atMs, order: order++, kind: "rollup" });
  }
  if (input.downtime) events.push({ atMs: input.downtime[1], order: order++, kind: "restart" });
  return events.sort((left, right) => left.atMs - right.atMs || left.order - right.order);
}

function run(events: Event[], algorithms: Algorithm[], afterRollup?: (atMs: number) => void): number {
  let lastRollupMs = 0;
  for (const event of events) {
    if (event.kind === "sample") for (const algorithm of algorithms) algorithm.buckets.insertSample(event.sample);
    else if (event.kind === "restart") for (const algorithm of algorithms) algorithm.restart();
    else {
      for (const algorithm of algorithms) algorithm.rollup(new Date(event.atMs).toISOString());
      lastRollupMs = event.atMs;
      afterRollup?.(event.atMs);
    }
  }
  // One final rollup after the last committed sample, as the next timer tick would do.
  const finalMs = Math.max(lastRollupMs, events.at(-1)?.atMs ?? 0) + 60_000;
  for (const algorithm of algorithms) algorithm.rollup(new Date(finalMs).toISOString());
  afterRollup?.(finalMs);
  return finalMs;
}

/** Aggregates of all samples ever inserted, without any retention sweep. */
function groundTruth(events: Event[]): FakeBuckets {
  const truth = new FakeBuckets();
  for (const event of events) if (event.kind === "sample") truth.insertSample(event.sample);
  truth.rollup(10, 60, Number.NEGATIVE_INFINITY);
  truth.rollup(60, 900, Number.NEGATIVE_INFINITY);
  return truth;
}

const startMs = Date.parse("2026-08-11T06:07:00.000Z");
// Simulations replay hours of 10 s samples; keep them clear of the default 5 s timeout on busy hosts.
const simulationTimeoutMs = 120_000;

/** Cheap string comparison first; the structural assertion only runs to print a readable diff. */
function expectSameBuckets(actual: Record<string, Row>, expected: Record<string, Row>): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) expect(actual).toEqual(expected);
}

describe("system analytics rollup windows", () => {
  it("returns the original catch-up windows without a watermark", () => {
    expect(systemAnalyticsRollupWindows("2026-08-11T08:00:09.123Z", null)).toEqual({
      since60: "2026-08-11T05:00:09.123Z",
      since900: "2026-08-08T08:00:09.123Z"
    });
  });

  it("returns target-aligned windows that cover the period since the last rollup", () => {
    const windows = systemAnalyticsRollupWindows("2026-08-11T08:01:10.000Z", "2026-08-11T08:00:09.000Z");
    expect(windows).toEqual({ since60: "2026-08-11T07:55:00.000Z", since900: "2026-08-11T07:30:00.000Z" });
    expect(Date.parse(windows.since60) % 60_000).toBe(0);
    expect(Date.parse(windows.since900) % 900_000).toBe(0);
    // The 900 s window always contains every 60 s bucket the first step may rewrite.
    for (let minute = 0; minute < 60; minute += 1) {
      const last = new Date(Date.parse("2026-08-11T08:00:00.000Z") + minute * 60_000 + 1_234).toISOString();
      const next = systemAnalyticsRollupWindows(new Date(Date.parse(last) + 60_000).toISOString(), last);
      expect(Date.parse(next.since900)).toBeLessThanOrEqual(Math.floor(Date.parse(next.since60) / 900_000) * 900_000);
    }
  });

  it("never skips buckets when the clock steps backwards", () => {
    expect(systemAnalyticsRollupWindows("2026-08-11T07:00:00.000Z", "2026-08-11T08:00:09.000Z")).toEqual({
      since60: "2026-08-11T06:55:00.000Z",
      since900: "2026-08-11T06:30:00.000Z"
    });
  });

  it("produces exactly the original buckets after every rollup, including late samples and a restart after downtime", () => {
    const events = timeline({
      startMs,
      durationMs: 75 * 60_000,
      withSession: true,
      downtime: [startMs + 38 * 60_000, startMs + 50 * 60_000]
    });
    const original = originalAlgorithm();
    const watermark = watermarkAlgorithm();
    let compared = 0;
    run(events, [original, watermark], () => {
      for (const resolution of [60, 900] as const) {
        expectSameBuckets(watermark.buckets.snapshot(resolution), original.buckets.snapshot(resolution));
      }
      compared += 1;
    });
    expect(compared).toBeGreaterThan(60);
    expect(Object.keys(watermark.buckets.snapshot(60)).length).toBeGreaterThan(100);
    // Same results while aggregating a small fraction of the groups.
    expect(watermark.buckets.aggregatedGroups * 3).toBeLessThan(original.buckets.aggregatedGroups);
    }, simulationTimeoutMs);

  it("matches the complete aggregates across the 10 s retention edge, where the full window rewrote truncated buckets", () => {
    const events = timeline({ startMs, durationMs: 2.5 * 3_600_000, withSession: true });
    const original = originalAlgorithm();
    const watermark = watermarkAlgorithm();
    const finalMs = run(events, [original, watermark]);
    const truth = groundTruth(events);

    const truth60 = truth.snapshot(60);
    const watermark60 = watermark.buckets.snapshot(60);
    for (const [key, row] of Object.entries(watermark60)) expect(row).toEqual(truth60[key]);
    expect(Object.keys(watermark60).length).toBe(Object.keys(truth60).length);
    expect(watermark.buckets.snapshot(900)).toEqual(truth.snapshot(900));

    // Buckets the retention sweep never reached are identical in both algorithms.
    const original60 = original.buckets.snapshot(60);
    const untouchedFromMs = finalMs - 2 * 3_600_000 + 60_000;
    for (const [key, row] of Object.entries(watermark60)) {
      if (row.bucketMs >= untouchedFromMs) expect(original60[key]).toEqual(row);
    }
    // The original full window re-aggregated buckets whose oldest 10 s rows had
    // already been swept, so it kept partial sample counts there.
    const truncated = Object.entries(original60).filter(([key, row]) => row.sampleCount < truth60[key]!.sampleCount);
    expect(truncated.length).toBeGreaterThan(10);
    }, simulationTimeoutMs);

  it("keeps complete 900 s buckets beyond the 48 h retention of 60 s rows while touching only recent buckets", () => {
    // Sparser samples and rollups keep 50 simulated hours cheap; windows are cadence-independent.
    const events = timeline({ startMs, durationMs: 50 * 3_600_000, sampleEveryMs: 60_000, rollupEveryMs: 300_000 });
    const watermark = watermarkAlgorithm();
    let steady: { rollups: number; groups: number; changed: number } | null = null;
    run(events, [watermark], (atMs) => {
      if (atMs < startMs + 3_600_000) return;
      steady ??= { rollups: 0, groups: watermark.buckets.aggregatedGroups, changed: watermark.buckets.changedRows };
      steady.rollups += 1;
    });
    const truth900 = groundTruth(events).snapshot(900);
    expect(watermark.buckets.snapshot(900)).toEqual(truth900);
    const full = Object.values(truth900).filter((row) => row.sampleCount === 15);
    expect(full.length).toBeGreaterThan(190);
    // Steady state for one entity: the window re-aggregates ~11 60 s groups and
    // 2-3 900 s groups per rollup, and only the 5 newest 60 s buckets and the
    // newest 900 s bucket actually change.
    const { rollups, groups, changed } = steady!;
    expect((watermark.buckets.aggregatedGroups - groups) / rollups).toBeLessThanOrEqual(15);
    expect((watermark.buckets.changedRows - changed) / rollups).toBeLessThanOrEqual(7);
    }, simulationTimeoutMs);
});
