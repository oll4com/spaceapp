import type {
  SystemHealthHistory,
  SystemHealthMetric,
  SystemHealthRange,
  SystemHealthRequests,
  SystemHealthService,
  SystemHealthSnapshot,
} from "@space/contracts";
import type { SystemHealthRepository } from "@space/db";
import { SystemHealthCollector } from "./system-health-collector.js";

export interface SystemHealthCheck {
  id: string;
  label: string;
  collect: () => Promise<
    Omit<SystemHealthService, "id" | "label" | "checkedAt">
  >;
}
export interface SystemHealthOptions {
  collector?: SystemHealthCollector;
  repository: SystemHealthRepository;
  checks: SystemHealthCheck[];
  requests: () => SystemHealthRequests;
  now?: () => number;
  onError?: () => void;
}
const ranges = {
  "1m": 60,
  "10m": 600,
  "1h": 3600,
  "7d": 7 * 86400,
  "30d": 30 * 86400,
};
export class SystemHealthMonitor {
  private collector: SystemHealthCollector;
  private services: SystemHealthService[] = [];
  private servicesLoadedAt = 0;
  private servicesInFlight: Promise<SystemHealthService[]> | null = null;
  private checksInFlight = new Map<
    string,
    ReturnType<SystemHealthCheck["collect"]>
  >();
  private retainInFlight: Promise<void> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private now: () => number;
  private lastSweep = 0;
  constructor(private options: SystemHealthOptions) {
    this.collector = options.collector ?? new SystemHealthCollector();
    this.now = options.now ?? Date.now;
  }
  start() {
    if (!this.timer) {
      this.timer = setInterval(
        () => void this.retain().catch(() => this.options.onError?.()),
        10_000,
      );
      this.timer.unref();
    }
  }
  private requestMetrics(): SystemHealthMetric[] {
    const r = this.options.requests();
    return [
      {
        id: "request-errors",
        label: "API error rate",
        group: "requests",
        unit: "PERCENT",
        value: r.errorRatePercent,
        total: 100,
        sampledAt: r.sampledAt,
        detail: "HTTP 5xx · Last 5 min · At least 20 requests",
      },
      {
        id: "request-p95",
        label: "API p95",
        group: "requests",
        unit: "MILLISECONDS",
        value: r.p95Ms,
        sampledAt: r.sampledAt,
        detail:
          "Response duration · Last 5 min · Approximate p95 (8% histogram bounds)",
      },
    ];
  }
  private loadServices(): Promise<SystemHealthService[]> {
    if (this.servicesInFlight) return this.servicesInFlight;
    if (this.services.length && this.now() - this.servicesLoadedAt < 10_000)
      return Promise.resolve(this.services);
    const request = Promise.all(
      this.options.checks.map(async (check) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          let collecting = this.checksInFlight.get(check.id);
          if (!collecting) {
            collecting = Promise.resolve().then(() => check.collect());
            this.checksInFlight.set(check.id, collecting);
            void collecting
              .finally(() => this.checksInFlight.delete(check.id))
              .catch(() => undefined);
          }
          const result = await Promise.race([
            collecting,
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => reject(new Error("timeout")), 3000);
            }),
          ]);
          return {
            ...result,
            id: check.id,
            label: check.label,
            checkedAt: new Date(this.now()).toISOString(),
          };
        } catch {
          return {
            id: check.id,
            label: check.label,
            status: "unavailable" as const,
            detail: "Health check unavailable. Retry on the next refresh.",
            checkedAt: new Date(this.now()).toISOString(),
            values: [],
          };
        } finally {
          if (timer) clearTimeout(timer);
        }
      }),
    ).then((services) => {
      this.services = services;
      this.servicesLoadedAt = this.now();
      return services;
    });
    this.servicesInFlight = request;
    void request
      .finally(() => {
        if (this.servicesInFlight === request) this.servicesInFlight = null;
      })
      .catch(() => undefined);
    return request;
  }
  async snapshot(): Promise<SystemHealthSnapshot> {
    const servicesRequest = this.loadServices();
    const [sample, services] = await Promise.all([
      this.collector.sample(),
      this.services.length ? Promise.resolve(this.services) : servicesRequest,
    ]);
    return {
      ...sample,
      metrics: [...sample.metrics, ...this.requestMetrics()],
      services,
      requests: this.options.requests(),
    };
  }
  retain(): Promise<void> {
    if (this.retainInFlight) return this.retainInFlight;
    const request = (async () => {
      const sample = await this.collector.sample();
      await this.options.repository.insert([
        ...sample.metrics,
        ...this.requestMetrics(),
      ]);
      if (this.now() - this.lastSweep >= 60_000) {
        await this.options.repository.sweep(sample.sampledAt);
        this.lastSweep = this.now();
      }
    })();
    this.retainInFlight = request;
    void request
      .finally(() => {
        if (this.retainInFlight === request) this.retainInFlight = null;
      })
      .catch(() => undefined);
    return request;
  }
  async history(range: SystemHealthRange): Promise<SystemHealthHistory> {
    const resolution = range === "7d" || range === "30d" ? 900 : 10;
    const since = new Date(this.now() - ranges[range] * 1000).toISOString();
    return {
      range,
      sampledAt: new Date(this.now()).toISOString(),
      series: await this.options.repository.history(
        since,
        resolution,
        range === "30d" ? 3600 : resolution,
      ),
    };
  }
  async dispose() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await Promise.allSettled([this.retainInFlight, this.servicesInFlight]);
    await this.options.repository.dispose();
  }
}
