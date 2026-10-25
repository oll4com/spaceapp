import { readFile, statfs } from "node:fs/promises";
import { cpus, uptime } from "node:os";
import type { SystemHealthMetric } from "@space/contracts";
import {
  parseMeminfo,
  parseProcStat,
  calculateCpuUsagePercent,
  type ProcCpuSample,
} from "./host-stats.js";

export interface HealthCollectorSample {
  sampledAt: string;
  metrics: SystemHealthMetric[];
  coreCount: number;
  uptimeSeconds: number;
}
export interface HealthCollectorOptions {
  read?: (path: string) => Promise<string>;
  filesystem?: (
    path: string,
  ) => Promise<{ blocks: number; bavail: number; bsize: number }>;
  now?: () => number;
}
type Counter = { at: number; values: number[] };
export function counterRates(
  previous: Counter | undefined,
  next: Counter,
): Array<number | null> {
  const seconds = previous ? (next.at - previous.at) / 1000 : 0;
  return next.values.map((value, i) => {
    const old = previous?.values[i];
    return old === undefined ||
      seconds <= 0 ||
      value < old ||
      !Number.isFinite(value)
      ? null
      : (value - old) / seconds;
  });
}
export function parseNetworkCounters(
  raw: string,
): Array<{ name: string; values: number[] }> {
  return raw.split("\n").flatMap((line) => {
    const match = /^\s*([A-Za-z0-9_.-]+):\s*(.*)$/.exec(line);
    if (!match || match[1] === "lo") return [];
    const fields = match[2]!.trim().split(/\s+/).map(Number);
    return fields.length >= 16 && fields.every(Number.isFinite)
      ? [{ name: match[1]!, values: [fields[0]!, fields[8]!] }]
      : [];
  });
}
export function defaultNetworkInterface(raw: string): string | null {
  return (
    raw
      .split("\n")
      .slice(1)
      .map((line) => line.trim().split(/\s+/))
      .filter(
        (f) =>
          f[1] === "00000000" && (Number.parseInt(f[3] ?? "0", 16) & 1) !== 0,
      )
      .sort((a, b) => Number(a[6]) - Number(b[6]))[0]?.[0] ?? null
  );
}
export function defaultIpv6NetworkInterface(raw: string): string | null {
  return (
    raw
      .split("\n")
      .map((line) => line.trim().split(/\s+/))
      .filter(
        (f) =>
          f.length >= 10 &&
          f[0] === "0".repeat(32) &&
          f[1] === "00" &&
          f[9] !== "lo" &&
          (Number.parseInt(f[8] ?? "0", 16) & 1) !== 0,
      )
      .sort(
        (a, b) => Number.parseInt(a[5]!, 16) - Number.parseInt(b[5]!, 16),
      )[0]?.[9] ?? null
  );
}
export function parseDiskCounters(
  raw: string,
): Array<{ name: string; values: number[] }> {
  return raw.split("\n").flatMap((line) => {
    const f = line.trim().split(/\s+/);
    const name = f[2] ?? "";
    if (
      f.length < 14 ||
      !/^[A-Za-z0-9_-]+$/.test(name) ||
      /^(loop|ram|fd|sr|dm-)/.test(name)
    )
      return [];
    const values = [Number(f[5]) * 512, Number(f[9]) * 512, Number(f[12])];
    return values.every(Number.isFinite) ? [{ name, values }] : [];
  });
}

/** Shared, single-flight OS sampling. No process scans, provider calls, or writes. */
export class SystemHealthCollector {
  private read: (path: string) => Promise<string>;
  private filesystem: NonNullable<HealthCollectorOptions["filesystem"]>;
  private now: () => number;
  private previousCpu: ProcCpuSample | null = null;
  private counters = new Map<string, Counter>();
  private cached: HealthCollectorSample | null = null;
  private inFlight: Promise<HealthCollectorSample> | null = null;
  constructor(options: HealthCollectorOptions = {}) {
    this.read = options.read ?? ((path) => readFile(path, "utf8"));
    this.filesystem = options.filesystem ?? ((path) => statfs(path));
    this.now = options.now ?? Date.now;
  }
  sample(): Promise<HealthCollectorSample> {
    if (this.inFlight) return this.inFlight;
    if (this.cached && this.now() - Date.parse(this.cached.sampledAt) < 1800)
      return Promise.resolve(this.cached);
    const request = this.collect().then((sample) => {
      this.cached = sample;
      return sample;
    });
    this.inFlight = request;
    void request
      .finally(() => {
        if (this.inFlight === request) this.inFlight = null;
      })
      .catch(() => undefined);
    return request;
  }
  private async collect(): Promise<HealthCollectorSample> {
    const now = this.now();
    const sampledAt = new Date(now).toISOString();
    const [
      cpuRaw,
      memRaw,
      disksRaw,
      networkRaw,
      routesRaw,
      ipv6RoutesRaw,
      rootFs,
      appFs,
    ] = await Promise.all([
      this.read("/proc/stat").catch(() => null),
      this.read("/proc/meminfo").catch(() => null),
      this.read("/proc/diskstats").catch(() => null),
      this.read("/proc/net/dev").catch(() => null),
      this.read("/proc/net/route").catch(() => null),
      this.read("/proc/net/ipv6_route").catch(() => null),
      this.filesystem("/").catch(() => null),
      this.filesystem("/opt/spaceapp").catch(() => null),
    ] as const);
    const metrics: SystemHealthMetric[] = [];
    const add = (
      id: string,
      label: string,
      group: SystemHealthMetric["group"],
      unit: SystemHealthMetric["unit"],
      value: number | null,
      detail: string,
      total?: number | null,
    ) => {
      metrics.push({
        id,
        label,
        group,
        unit,
        value:
          value !== null && Number.isFinite(value) ? Math.max(value, 0) : null,
        detail,
        sampledAt,
        ...(total === undefined ? {} : { total }),
      });
    };
    const cpu =
      cpuRaw && /^cpu\s+\d+/m.test(cpuRaw) ? parseProcStat(cpuRaw) : null;
    add(
      "cpu",
      "CPU",
      "cpu",
      "PERCENT",
      cpu && this.previousCpu
        ? calculateCpuUsagePercent(this.previousCpu, cpu)
        : null,
      "Total server CPU utilization",
      100,
    );
    this.previousCpu = cpu;
    const memory = memRaw ? parseMeminfo(memRaw) : null;
    add(
      "memory",
      "Memory",
      "memory",
      "PERCENT",
      memory?.memory.usagePercent ?? null,
      "Server RAM in use, excluding available cache",
      100,
    );
    add(
      "memory-used",
      "Memory used",
      "memory",
      "BYTES",
      memory?.memory.usedBytes ?? null,
      "Used server RAM",
      memory?.memory.totalBytes ?? null,
    );
    add(
      "memory-available",
      "Memory available",
      "memory",
      "BYTES",
      memory?.memory.totalBytes != null && memory.memory.usedBytes != null
        ? memory.memory.totalBytes - memory.memory.usedBytes
        : null,
      "RAM available to applications",
    );
    add(
      "swap",
      "Swap",
      "swap",
      "PERCENT",
      memory?.swap.usagePercent ?? null,
      memory?.swap.totalBytes === 0
        ? "No swap configured"
        : "Server swap in use",
      100,
    );
    add(
      "swap-used",
      "Swap used",
      "swap",
      "BYTES",
      memory?.swap.usedBytes ?? null,
      "Swap allocation",
      memory?.swap.totalBytes ?? null,
    );
    for (const [id, label, path, fs] of [
      ["root", "Root disk", "/", rootFs],
      ["app", "Space disk", "/opt/spaceapp", appFs],
    ] as const) {
      const total = fs ? fs.blocks * fs.bsize : null;
      const free = fs ? fs.bavail * fs.bsize : null;
      add(
        `disk-${id}`,
        label,
        "disk",
        "PERCENT",
        total && free !== null ? ((total - free) / total) * 100 : null,
        path,
        100,
      );
      add(
        `disk-${id}-free`,
        `${label} free`,
        "disk",
        "BYTES",
        free,
        path,
        total,
      );
    }
    const seen = new Set<string>();
    const diskRows = disksRaw ? parseDiskCounters(disksRaw).slice(0, 32) : [];
    const partitions = await Promise.all(
      diskRows.map((row) =>
        this.read(`/sys/class/block/${row.name}/partition`).then(
          () => true,
          () => false,
        ),
      ),
    );
    for (const row of diskRows
      .filter((_row, i) => !partitions[i])
      .slice(0, 8)) {
      const key = `disk:${row.name}`;
      seen.add(key);
      const next = { at: now, values: row.values };
      const [read, write, busy] = counterRates(this.counters.get(key), next);
      this.counters.set(key, next);
      add(
        `${key}:read`,
        `${row.name} read`,
        "disk",
        "BYTES_PER_SECOND",
        read ?? null,
        `Read throughput · ${row.name}`,
      );
      add(
        `${key}:write`,
        `${row.name} write`,
        "disk",
        "BYTES_PER_SECOND",
        write ?? null,
        `Write throughput · ${row.name}`,
      );
      add(
        `${key}:busy`,
        `${row.name} active`,
        "disk",
        "PERCENT",
        busy == null ? null : Math.min(100, busy / 10),
        `Device busy time · ${row.name}`,
        100,
      );
    }
    const defaultInterface =
      (routesRaw ? defaultNetworkInterface(routesRaw) : null) ??
      (ipv6RoutesRaw ? defaultIpv6NetworkInterface(ipv6RoutesRaw) : null);
    const interfaces = (networkRaw ? parseNetworkCounters(networkRaw) : [])
      .filter(
        (row) =>
          !/^(veth|docker|br-)/.test(row.name) || row.name === defaultInterface,
      )
      .sort(
        (a, b) =>
          Number(b.name === defaultInterface) -
          Number(a.name === defaultInterface),
      )
      .slice(0, 8);
    const speeds = await Promise.all(
      interfaces.map((row) =>
        this.read(`/sys/class/net/${row.name}/speed`).then(
          (v) => Number(v.trim()),
          () => null,
        ),
      ),
    );
    for (const [i, row] of interfaces.entries()) {
      const key = `network:${row.name}`;
      seen.add(key);
      const next = { at: now, values: row.values };
      const [rx, tx] = counterRates(this.counters.get(key), next);
      this.counters.set(key, next);
      const detail = `${row.name}${row.name === defaultInterface ? " · Default route" : ""}`;
      add(
        `${key}:rx`,
        `${row.name} receive`,
        "network",
        "BYTES_PER_SECOND",
        rx ?? null,
        detail,
      );
      add(
        `${key}:tx`,
        `${row.name} send`,
        "network",
        "BYTES_PER_SECOND",
        tx ?? null,
        detail,
      );
      const speed = speeds[i];
      const capacity = speed && speed > 0 ? (speed * 1_000_000) / 8 : null;
      add(
        `${key}:usage`,
        `${row.name} utilization`,
        "network",
        "PERCENT",
        capacity && rx != null && tx != null
          ? Math.min(100, (Math.max(rx, tx) / capacity) * 100)
          : null,
        capacity
          ? `${detail} · ${speed} Mbps full duplex`
          : `${detail} · Link capacity unavailable`,
        100,
      );
    }
    for (const group of ["disk", "network"] as const) {
      if (!metrics.some((m) => m.id.startsWith(`${group}:`))) {
        const previous =
          this.cached?.metrics.filter((m) => m.id.startsWith(`${group}:`)) ??
          [];
        if (previous.length)
          metrics.push(
            ...previous.map((m) => ({
              ...m,
              value: null,
              sampledAt,
              detail: "Device telemetry unavailable",
            })),
          );
        else
          add(
            `${group}-telemetry`,
            group === "disk" ? "Disk I/O" : "Network traffic",
            group,
            "BYTES_PER_SECOND",
            null,
            "Device telemetry unavailable",
          );
      }
    }
    for (const key of this.counters.keys())
      if (!seen.has(key)) this.counters.delete(key);
    return {
      sampledAt,
      metrics,
      coreCount: Math.max(1, cpus().length),
      uptimeSeconds: uptime(),
    };
  }
}
