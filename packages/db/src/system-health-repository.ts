import type { SystemHealthMetric, SystemHealthSeries } from "@space/contracts";
import { createSpacePgPool, type PgPoolLike } from "./space-store.js";

export interface SystemHealthRepository {
  insert(metrics: SystemHealthMetric[]): Promise<void>;
  history(
    since: string,
    resolution: 10 | 60 | 900,
    aggregateSeconds?: number,
  ): Promise<SystemHealthSeries[]>;
  sweep(at: string): Promise<void>;
  probe(): Promise<void>;
  dispose(): Promise<void>;
}
type Bucket = {
  id: string;
  label: string;
  unit: SystemHealthMetric["unit"];
  resolution: number;
  at: string;
  count: number;
  min: number;
  sum: number;
  max: number;
};
const bucketAt = (at: string, resolution: number) =>
  new Date(
    Math.floor(Date.parse(at) / (resolution * 1000)) * resolution * 1000,
  ).toISOString();
function series(
  buckets: Bucket[],
  aggregateSeconds: number,
): SystemHealthSeries[] {
  const merged = new Map<string, Bucket>();
  for (const bucket of buckets) {
    const at = bucketAt(bucket.at, aggregateSeconds);
    const key = `${bucket.id}:${at}`;
    const old = merged.get(key);
    merged.set(key, {
      ...bucket,
      at,
      count: bucket.count + (old?.count ?? 0),
      sum: bucket.sum + (old?.sum ?? 0),
      min: Math.min(bucket.min, old?.min ?? bucket.min),
      max: Math.max(bucket.max, old?.max ?? bucket.max),
    });
  }
  const grouped = new Map<string, SystemHealthSeries>();
  for (const b of merged.values()) {
    const s = grouped.get(b.id) ?? {
      id: b.id,
      label: b.label,
      unit: b.unit,
      points: [],
    };
    s.points.push({ at: b.at, min: b.min, avg: b.sum / b.count, max: b.max });
    grouped.set(b.id, s);
  }
  return [...grouped.values()]
    .slice(0, 128)
    .map((s) => ({
      ...s,
      points: s.points.sort((a, b) => a.at.localeCompare(b.at)).slice(-720),
    }));
}
export class InMemorySystemHealthRepository implements SystemHealthRepository {
  private buckets = new Map<string, Bucket>();
  async insert(metrics: SystemHealthMetric[]) {
    for (const m of metrics)
      if (m.value !== null)
        for (const resolution of [10, 60, 900]) {
          const at = bucketAt(m.sampledAt, resolution);
          const key = `${resolution}:${at}:${m.id}`;
          const old = this.buckets.get(key);
          this.buckets.set(key, {
            id: m.id,
            label: m.label,
            unit: m.unit,
            resolution,
            at,
            count: (old?.count ?? 0) + 1,
            min: Math.min(old?.min ?? m.value, m.value),
            sum: (old?.sum ?? 0) + m.value,
            max: Math.max(old?.max ?? m.value, m.value),
          });
        }
  }
  async history(
    since: string,
    resolution: 10 | 60 | 900,
    aggregateSeconds = resolution,
  ) {
    return series(
      [...this.buckets.values()].filter(
        (b) => b.resolution === resolution && b.at >= since,
      ),
      aggregateSeconds,
    );
  }
  async sweep(at: string) {
    for (const [key, b] of this.buckets)
      if (
        Date.parse(at) - Date.parse(b.at) >
        (b.resolution === 10
          ? 2 * 3600
          : b.resolution === 60
            ? 48 * 3600
            : 31 * 86400) *
          1000
      )
        this.buckets.delete(key);
  }
  async probe() {}
  async dispose() {
    this.buckets.clear();
  }
}
export class PostgresSystemHealthRepository implements SystemHealthRepository {
  constructor(private pool: PgPoolLike) {}
  static fromConnectionString(connectionString: string) {
    return new PostgresSystemHealthRepository(
      createSpacePgPool(connectionString, {
        max: 1,
        connectionTimeoutMillis: 2000,
      }),
    );
  }
  async insert(metrics: SystemHealthMetric[]) {
    const rows = metrics
      .filter((m) => m.value !== null)
      .flatMap((m) =>
        [10, 60, 900].map((resolution) => ({
          id: m.id,
          label: m.label,
          unit: m.unit,
          resolution,
          at: bucketAt(m.sampledAt, resolution),
          value: m.value,
        })),
      );
    if (!rows.length) return;
    await this.pool.query(
      `INSERT INTO system_health_metric_buckets
      (metric_id,label,unit,resolution_seconds,bucket_at,sample_count,value_min,value_sum,value_max)
      SELECT id,label,unit,resolution,at,1,value,value,value FROM jsonb_to_recordset($1::jsonb)
        AS x(id text,label text,unit text,resolution integer,at timestamptz,value double precision)
      ON CONFLICT (resolution_seconds,bucket_at,metric_id) DO UPDATE SET
        label=EXCLUDED.label, sample_count=system_health_metric_buckets.sample_count+1,
        value_min=LEAST(system_health_metric_buckets.value_min,EXCLUDED.value_min),
        value_sum=system_health_metric_buckets.value_sum+EXCLUDED.value_sum,
        value_max=GREATEST(system_health_metric_buckets.value_max,EXCLUDED.value_max)`,
      [JSON.stringify(rows)],
    );
  }
  async history(
    since: string,
    resolution: 10 | 60 | 900,
    aggregateSeconds = resolution,
  ) {
    const result = await this.pool.query<{
      id: string;
      label: string;
      unit: SystemHealthMetric["unit"];
      at: Date;
      count: number;
      min: number;
      sum: number;
      max: number;
    }>(
      `SELECT metric_id AS id,MAX(label) AS label,unit,
         to_timestamp(FLOOR(EXTRACT(EPOCH FROM bucket_at)/$3)*$3) AS at,
         SUM(sample_count) AS count,MIN(value_min) AS min,SUM(value_sum) AS sum,MAX(value_max) AS max
       FROM system_health_metric_buckets WHERE resolution_seconds=$1 AND bucket_at >= $2::timestamptz
       GROUP BY metric_id,unit,at ORDER BY at DESC,metric_id LIMIT 92160`,
      [resolution, since, aggregateSeconds],
    );
    return series(
      result.rows.map((b) => ({
        ...b,
        resolution,
        at: b.at.toISOString(),
        count: Number(b.count),
        min: Number(b.min),
        sum: Number(b.sum),
        max: Number(b.max),
      })),
      aggregateSeconds,
    );
  }
  async sweep(at: string) {
    await this.pool.query(
      `DELETE FROM system_health_metric_buckets WHERE bucket_at < $1::timestamptz -
      CASE resolution_seconds WHEN 10 THEN interval '2 hours' WHEN 60 THEN interval '48 hours' ELSE interval '31 days' END`,
      [at],
    );
  }
  async probe() {
    await this.pool.query("SELECT 1");
  }
  async dispose() {
    await (this.pool as PgPoolLike & { end?: () => Promise<void> }).end?.();
  }
}
