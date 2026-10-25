import { describe, expect, it, vi } from "vitest";
import { InMemorySystemHealthRepository } from "@space/db";
import {
  systemHealthSnapshotSchema,
  type SystemHealthMetric,
} from "@space/contracts";
import {
  SystemHealthCollector,
  counterRates,
  defaultNetworkInterface,
  defaultIpv6NetworkInterface,
  parseDiskCounters,
  parseNetworkCounters,
} from "../src/system-health-collector.js";
import { RecentRequestWindow } from "../src/recent-request-window.js";
import { SystemHealthMonitor } from "../src/system-health-service.js";

describe("system health collection", () => {
  it("uses counter deltas and elapsed seconds, rejecting resets and initial samples", () => {
    expect(counterRates(undefined, { at: 1000, values: [100] })).toEqual([
      null,
    ]);
    expect(
      counterRates(
        { at: 1000, values: [100, 1000] },
        { at: 3000, values: [200, 900] },
      ),
    ).toEqual([50, null]);
    expect(
      counterRates({ at: 1000, values: [100] }, { at: 1000, values: [200] }),
    ).toEqual([null]);
  });
  it("parses kernel fields and chooses the default route by metric", () => {
    expect(parseDiskCounters("8 0 sda 0 0 20 0 0 0 10 0 0 60 0")).toEqual([
      { name: "sda", values: [10240, 5120, 60] },
    ]);
    expect(
      parseNetworkCounters(
        "lo: 1 0 0 0 0 0 0 0 2 0 0 0 0 0 0 0\neth0: 100 0 0 0 0 0 0 0 200 0 0 0 0 0 0 0",
      ),
    ).toEqual([{ name: "eth0", values: [100, 200] }]);
    expect(
      defaultNetworkInterface(
        "Iface Destination Gateway Flags RefCnt Use Metric\neth0 00000000 1 0003 0 0 100\ntun0 00000000 1 0003 0 0 10",
      ),
    ).toBe("tun0");
  });
  it("keeps missing samples null, handles no swap, excludes partitions and deduplicates concurrent reads", async () => {
    let now = Date.parse("2026-09-06T10:00:00Z"),
      sample = 0;
    const read = vi.fn(async (path: string) => {
      if (path === "/proc/stat")
        return sample === 0
          ? "cpu 100 0 0 900 0 0 0 0"
          : "cpu 200 0 0 1000 0 0 0 0";
      if (path === "/proc/meminfo")
        return "MemTotal: 1000 kB\nMemAvailable: 500 kB\nSwapTotal: 0 kB\nSwapFree: 0 kB";
      if (path === "/proc/diskstats")
        return `8 0 sda 0 0 ${20 + sample * 20} 0 0 0 10 0 0 60 0\n8 1 sda1 0 0 20 0 0 0 10 0 0 60 0`;
      if (path === "/sys/class/block/sda1/partition") return "1";
      throw new Error("unavailable");
    });
    const collector = new SystemHealthCollector({
      read,
      now: () => now,
      filesystem: async () => ({ blocks: 100, bavail: 25, bsize: 1024 }),
    });
    const [a, b] = await Promise.all([collector.sample(), collector.sample()]);
    expect(a).toBe(b);
    expect(a.metrics.find((m) => m.id === "cpu")?.value).toBeNull();
    expect(a.metrics.find((m) => m.id === "memory")?.value).toBe(50);
    expect(a.metrics.find((m) => m.id === "swap")?.value).toBeNull();
    expect(a.metrics.some((m) => m.id.includes("sda1"))).toBe(false);
    now += 2000;
    sample++;
    const next = await collector.sample();
    expect(next.metrics.find((m) => m.id === "cpu")?.value).toBe(50);
    expect(next.metrics.find((m) => m.id === "disk:sda:read")?.value).toBe(
      5120,
    );
    expect(next.metrics.find((m) => m.id === "disk-app")?.value).toBe(75);
  });
});
describe("IPv6 default routes", () => {
  it("handles IPv6-only default routes", () => {
    const zero = "0".repeat(32);
    expect(
      defaultIpv6NetworkInterface(
        `${zero} 00 ${zero} 00 ${zero} 00000400 0 0 00000001 eth0`,
      ),
    ).toBe("eth0");
    expect(
      defaultIpv6NetworkInterface(
        `${zero} 80 ${zero} 00 ${zero} 00000400 0 0 00000001 eth0`,
      ),
    ).toBeNull();
  });
});
describe("recent request health", () => {
  it("expires old errors and requires enough traffic before classifying a rate", () => {
    let now = 1_000_000;
    const window = new RecentRequestWindow(() => now);
    window.observe(500, 100);
    expect(window.snapshot().errorRatePercent).toBeNull();
    for (let i = 0; i < 99; i++) window.observe(200, 40);
    expect(window.snapshot()).toMatchObject({
      requestCount: 100,
      errorCount: 1,
      errorRatePercent: 1,
    });
    now += 301000;
    window.observe(200, 20);
    expect(window.snapshot()).toMatchObject({
      requestCount: 1,
      errorCount: 0,
      errorRatePercent: null,
    });
  });
});
describe("health history and service isolation", () => {
  it("retains weighted buckets, excludes null samples and sweeps short resolution history", async () => {
    const repo = new InMemorySystemHealthRepository();
    const metric: SystemHealthMetric = {
      id: "cpu",
      label: "CPU",
      group: "cpu",
      unit: "PERCENT",
      value: 20,
      detail: "",
      sampledAt: "2026-09-06T10:00:00.000Z",
    };
    await repo.insert([metric]);
    await repo.insert([
      { ...metric, value: 80, sampledAt: "2026-09-06T10:00:02.000Z" },
    ]);
    await repo.insert([{ ...metric, value: null }]);
    expect(
      (await repo.history("2026-09-06T09:00:00.000Z", 10))[0]?.points[0],
    ).toMatchObject({ min: 20, avg: 50, max: 80 });
    await repo.sweep("2026-09-06T13:00:00.000Z");
    expect(await repo.history("2026-09-06T09:00:00.000Z", 10)).toEqual([]);
    expect(await repo.history("2026-09-06T09:00:00.000Z", 900)).toHaveLength(1);
  });
  it("covers all 30 days with weighted hourly aggregates, retaining peaks", async () => {
    const repo = new InMemorySystemHealthRepository();
    const start = Date.parse("2026-08-07T00:00:00.000Z");
    for (let i = 0; i < 2880; i++)
      await repo.insert([
        {
          id: "cpu",
          label: "CPU",
          group: "cpu",
          unit: "PERCENT",
          value: (i % 4) * 20,
          detail: "",
          sampledAt: new Date(start + i * 900_000).toISOString(),
        },
      ]);
    const monitor = new SystemHealthMonitor({
      repository: repo,
      now: () => start + 30 * 86400_000,
      checks: [],
      requests: () => new RecentRequestWindow().snapshot(),
    });
    const result = await monitor.history("30d");
    const points = result.series[0]!.points;
    expect(points).toHaveLength(720);
    expect(points[0]).toMatchObject({
      at: new Date(start).toISOString(),
      min: 0,
      avg: 30,
      max: 60,
    });
    expect(points.at(-1)?.at).toBe(
      new Date(start + 719 * 3600_000).toISOString(),
    );
    await monitor.dispose();
  });
  it("does not accumulate hung service checks after repeated timeouts", async () => {
    vi.useFakeTimers();
    const check = vi.fn(() => new Promise<never>(() => {}));
    const monitor = new SystemHealthMonitor({
      repository: new InMemorySystemHealthRepository(),
      checks: [{ id: "hung", label: "Hung", collect: check }],
      requests: () => new RecentRequestWindow().snapshot(),
    });
    try {
      const first = monitor.snapshot();
      await vi.advanceTimersByTimeAsync(3001);
      await first;
      await vi.advanceTimersByTimeAsync(10001);
      await monitor.snapshot();
      await vi.advanceTimersByTimeAsync(3001);
      expect(check).toHaveBeenCalledTimes(1);
      await monitor.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
  it("keeps partial results and shares checks across concurrent requests", async () => {
    const read = async () => {
      throw new Error("missing");
    };
    const check = vi.fn(async () => ({
      status: "healthy" as const,
      detail: "Responding",
      values: [],
    }));
    const monitor = new SystemHealthMonitor({
      collector: new SystemHealthCollector({ read, filesystem: read }),
      repository: new InMemorySystemHealthRepository(),
      requests: () => new RecentRequestWindow().snapshot(),
      checks: [
        { id: "api", label: "API", collect: check },
        {
          id: "db",
          label: "Database",
          collect: async () => {
            throw new Error("private connection details");
          },
        },
      ],
    });
    const [a, b] = await Promise.all([monitor.snapshot(), monitor.snapshot()]);
    expect(check).toHaveBeenCalledTimes(1);
    expect(a.services).toEqual(b.services);
    expect(a.services[1]).toMatchObject({ status: "unavailable" });
    expect(JSON.stringify(a)).not.toContain("private connection");
    expect(systemHealthSnapshotSchema.safeParse(a).success).toBe(true);
    await monitor.dispose();
  });
});
