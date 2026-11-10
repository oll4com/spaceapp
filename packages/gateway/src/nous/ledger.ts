import type pg from "pg";
import { withTenant, type TenantKey, type TenantPlan } from "./tenant-keys.js";

/**
 * The tenant ledger of the Nous Gateway (plan clipboard:_0qBSFCftZuD step 3; install plan §3.2, plan v2 §4.4.4), shared by every
 * replica in Postgres instead of the Space Gateway's per-process `pendingByKey`: admission reserves a request's estimate under the
 * tenant's period row lock, settlement moves the real list cost from reserved to spent, and a reservation whose replica died expires.
 * shortcut: days are UTC days, not the tenant's local midnight; upgrade when tenants carry a time zone.
 */
export const MICROS_PER_CREDIT = 10_000; // 1 credit = $0.01 of list value
export const RESERVATION_TTL_MS = 10 * 60_000;
export const BURST_BELOW_PERCENT = 60;
export const PRESSED_ABOVE_PERCENT = 70;
export const BURST_MULTIPLIER = 2;
export const PRESSED_RETRY_MS = 60_000;
export const PLAN_WEIGHTS: Record<TenantPlan, number> = { TRIAL: 1, PERSONAL: 1, PRO: 2, ULTRA: 4 };

export type TrafficClass = "FOREGROUND" | "BACKGROUND";
/** A pool's state from its accounts' 5-hour windows: the mean use of its healthy accounts and the list value left in them. */
export interface PoolPressure { fiveHourMeanPercent: number; roomMicros: number }

const DAY_MS = 86_400_000;
const isoDay = (at: Date) => at.toISOString().slice(0, 10);
const dayStartMs = (at: Date) => Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate());

/**
 * `createApiBudgetPacer`'s formula per tenant: today's allowance = (cap − spent before today) ÷ days left with today, so what a day
 * leaves unspent rolls forward and the last day gets the whole remainder; while the pool is under 60% a day may take 2× from the
 * month's remainder, never more than that remainder.
 */
export function tenantPace(input: { capMicros: number; spentMicros: number; daySpentMicros: number; periodEnd: Date; now: Date; fiveHourMeanPercent: number }) {
  const daysLeft = Math.max(1, Math.ceil((input.periodEnd.getTime() - dayStartMs(input.now)) / DAY_MS));
  const leftAtDayStart = Math.max(0, input.capMicros - (input.spentMicros - input.daySpentMicros));
  const allowanceTodayMicros = Math.floor(leftAtDayStart / daysLeft);
  const burst = input.fiveHourMeanPercent < BURST_BELOW_PERCENT ? BURST_MULTIPLIER : 1;
  return { daysLeft, allowanceTodayMicros, burst, todayCapMicros: Math.min(leftAtDayStart, allowanceTodayMicros * burst) };
}

export type AdmissionRefusal = "NO_PERIOD" | "MONTH_CAP" | "DAILY_ALLOWANCE" | "BACKGROUND_WAITS" | "FAIR_SHARE";
export type Admission =
  | { admitted: true; reservedMicros: number; pace: ReturnType<typeof tenantPace>; leftTodayMicros: number; leftPeriodMicros: number }
  | { admitted: false; reason: AdmissionRefusal; retryAt: Date | null; pace: ReturnType<typeof tenantPace> | null };

/**
 * Reserves the estimate only if the month's cap and today's allowance still hold it with every open reservation counted. While the
 * pool is pressed (over 70%) BACKGROUND traffic waits first, and each tenant may hold at most its weight's share (Personal 1, Pro 2,
 * Ultra 4) of the pool's remaining room among the tenants with open requests there.
 * shortcut: the other tenants' weights are read without their locks, so the share holds within one request (±10% in the plan's L5).
 */
export async function admit(app: pg.Pool, input: {
  requestId: string; key: TenantKey; pool: string; trafficClass: TrafficClass; estimateMicros: number; pressure: PoolPressure; now?: Date;
}): Promise<Admission> {
  const now = input.now ?? new Date();
  const estimate = Math.max(0, Math.ceil(input.estimateMicros));
  return withTenant(app, input.key.tenantId, async (client) => {
    const period = (await client.query("SELECT *, day::text AS day_text FROM ngw_tenant_period WHERE tenant_id = $1 AND period_start <= $2 AND period_end > $2 FOR UPDATE",
      [input.key.tenantId, now])).rows[0];
    if (!period) return { admitted: false, reason: "NO_PERIOD", retryAt: null, pace: null };
    // The tenant's own reservations whose replica died go back here too, so a tenant never waits on the ops sweep.
    const expired = (await client.query("DELETE FROM ngw_inflight WHERE tenant_id = $1 AND period_start = $2 AND expires_at <= $3 RETURNING reserved_micros",
      [input.key.tenantId, period.period_start, now])).rows.reduce((sum, row) => sum + Number(row.reserved_micros), 0);
    if (expired > 0) await client.query("UPDATE ngw_tenant_period SET reserved_micros = reserved_micros - $3 WHERE tenant_id = $1 AND period_start = $2",
      [input.key.tenantId, period.period_start, expired]);
    const cap = Number(period.allowance_micros) + Number(period.topup_micros);
    const spent = Number(period.spent_micros), reserved = Number(period.reserved_micros) - expired;
    // `day` as text: pg reads a date column as local midnight, which a UTC day would misread east of Greenwich.
    const daySpent = period.day_text === isoDay(now) ? Number(period.day_spent_micros) : 0;
    const pace = tenantPace({ capMicros: cap, spentMicros: spent, daySpentMicros: daySpent, periodEnd: period.period_end, now,
      fiveHourMeanPercent: input.pressure.fiveHourMeanPercent });
    const refuse = (reason: AdmissionRefusal, retryAt: Date): Admission => ({ admitted: false, reason, retryAt, pace });
    if (spent + reserved + estimate > cap) return refuse("MONTH_CAP", period.period_end);
    if (daySpent + reserved + estimate > pace.todayCapMicros) return refuse("DAILY_ALLOWANCE", new Date(dayStartMs(now) + DAY_MS));
    if (input.pressure.fiveHourMeanPercent > PRESSED_ABOVE_PERCENT) {
      const pressedRetry = new Date(now.getTime() + PRESSED_RETRY_MS);
      if (input.trafficClass === "BACKGROUND") return refuse("BACKGROUND_WAITS", pressedRetry);
      const active = (await client.query("SELECT plan, tenants FROM ngw_pool_active_plans($1, $2)", [input.pool, now])).rows;
      const own = (await client.query("SELECT count(*)::int AS n, coalesce(sum(reserved_micros), 0)::bigint AS micros FROM ngw_inflight WHERE pool = $1 AND expires_at > $2",
        [input.pool, now])).rows[0];
      const weight = PLAN_WEIGHTS[input.key.plan];
      const totalWeight = active.reduce((sum, row) => sum + PLAN_WEIGHTS[row.plan as TenantPlan] * Number(row.tenants), 0) + (own.n > 0 ? 0 : weight);
      if (Number(own.micros) + estimate > input.pressure.roomMicros * weight / totalWeight) return refuse("FAIR_SHARE", pressedRetry);
    }
    await client.query("UPDATE ngw_tenant_period SET reserved_micros = reserved_micros + $3 WHERE tenant_id = $1 AND period_start = $2",
      [input.key.tenantId, period.period_start, estimate]);
    await client.query(`INSERT INTO ngw_inflight (request_id, tenant_id, period_start, pool, plan, traffic_class, reserved_micros, expires_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`, [input.requestId, input.key.tenantId, period.period_start, input.pool, input.key.plan,
      input.trafficClass, estimate, new Date(now.getTime() + RESERVATION_TTL_MS)]);
    return { admitted: true, reservedMicros: estimate, pace, leftTodayMicros: pace.todayCapMicros - (daySpent + reserved + estimate),
      leftPeriodMicros: cap - (spent + reserved + estimate) };
  });
}

export interface Settlement {
  requestId: string; key: TenantKey; pool: string; accountId: string | null; provider: string; model: string; trafficClass: TrafficClass;
  status: "OK" | "ERROR"; costMicros: number; inputTokens?: number; cachedInputTokens?: number; cacheWriteTokens?: number; outputTokens?: number; now?: Date;
}

/**
 * Moves the request's reservation into spent at its real list cost, writes the metadata-only usage row and the daily rollup, in one
 * transaction. A second settlement of the same request changes nothing (no double charge); one that arrives after its reservation
 * was swept still records the real cost once.
 */
export async function settle(app: pg.Pool, s: Settlement): Promise<{ settled: boolean }> {
  const now = s.now ?? new Date();
  const cost = Math.max(0, Math.round(s.costMicros));
  const tokens = [s.inputTokens ?? 0, s.cachedInputTokens ?? 0, s.cacheWriteTokens ?? 0, s.outputTokens ?? 0];
  return withTenant(app, s.key.tenantId, async (client) => {
    const inserted = await client.query(`INSERT INTO ngw_usage (request_id, tenant_id, key_id, pool, account_id, provider, model, traffic_class, status,
      input_tokens, cached_input_tokens, cache_write_tokens, output_tokens, cost_micros, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) ON CONFLICT (request_id) DO NOTHING`,
    [s.requestId, s.key.tenantId, s.key.id, s.pool, s.accountId, s.provider, s.model, s.trafficClass, s.status, ...tokens, cost, now]);
    if (!inserted.rowCount) return { settled: false };
    const held = (await client.query("DELETE FROM ngw_inflight WHERE request_id = $1 RETURNING reserved_micros, period_start", [s.requestId])).rows[0];
    await client.query(`UPDATE ngw_tenant_period SET reserved_micros = reserved_micros - $3, spent_micros = spent_micros + $4,
      day_spent_micros = CASE WHEN day = $5::date THEN day_spent_micros + $4 ELSE $4 END, day = $5::date
      WHERE tenant_id = $1 AND CASE WHEN $2::timestamptz IS NULL THEN period_start <= $6 AND period_end > $6 ELSE period_start = $2 END`,
    [s.key.tenantId, held?.period_start ?? null, held?.reserved_micros ?? 0, cost, isoDay(now), now]);
    await client.query(`INSERT INTO ngw_usage_daily (tenant_id, day, account_id, model, requests, input_tokens, output_tokens, cost_micros)
      VALUES ($1, $2, $3, $4, 1, $5, $6, $7) ON CONFLICT (tenant_id, day, account_id, model) DO UPDATE SET requests = ngw_usage_daily.requests + 1,
      input_tokens = ngw_usage_daily.input_tokens + EXCLUDED.input_tokens, output_tokens = ngw_usage_daily.output_tokens + EXCLUDED.output_tokens,
      cost_micros = ngw_usage_daily.cost_micros + EXCLUDED.cost_micros`,
    [s.key.tenantId, isoDay(now), s.accountId ?? "-", s.model, tokens[0]! + tokens[1]! + tokens[2]!, tokens[3]!, cost]);
    return { settled: true };
  });
}

/** Opens (or updates) a tenant's billing period: the plan's included AI plus prepaid top-ups, in micro-USD of list value. */
export async function openTenantPeriod(app: pg.Pool, input: { tenantId: string; start: Date; end: Date; allowanceMicros: number; topupMicros?: number }): Promise<void> {
  await withTenant(app, input.tenantId, (client) => client.query(`INSERT INTO ngw_tenant_period (tenant_id, period_start, period_end, allowance_micros, topup_micros, day)
    VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (tenant_id, period_start) DO UPDATE SET period_end = EXCLUDED.period_end,
    allowance_micros = EXCLUDED.allowance_micros, topup_micros = EXCLUDED.topup_micros`,
  [input.tenantId, input.start, input.end, input.allowanceMicros, input.topupMicros ?? 0, isoDay(input.start)]));
}

/** Ops job (BYPASSRLS): reservations of replicas that died go back to their tenants. Answers how many periods it gave back to. */
export async function sweepExpiredReservations(ops: pg.Pool, now = new Date()): Promise<number> {
  return (await ops.query(`WITH gone AS (DELETE FROM ngw_inflight WHERE expires_at <= $1 RETURNING tenant_id, period_start, reserved_micros),
    sums AS (SELECT tenant_id, period_start, sum(reserved_micros) AS micros FROM gone GROUP BY 1, 2)
    UPDATE ngw_tenant_period p SET reserved_micros = p.reserved_micros - sums.micros FROM sums
    WHERE p.tenant_id = sums.tenant_id AND p.period_start = sums.period_start`, [now])).rowCount ?? 0;
}

/**
 * The nightly meter events (Stripe meter `nous_ai_credits`): one per tenant and UTC day from the daily rollup, its identifier being
 * Stripe's dedup key, so a re-run sends the same events. Nothing is sent from the lab.
 */
export async function meterEventsForDay(ops: pg.Pool, day: string) {
  const rows = (await ops.query("SELECT tenant_id, sum(cost_micros)::bigint AS micros FROM ngw_usage_daily WHERE day = $1 GROUP BY tenant_id ORDER BY tenant_id",
    [day])).rows;
  return rows.map((row) => ({ identifier: `ngw:${row.tenant_id}:${day}`, tenantId: row.tenant_id as string, day, costMicros: Number(row.micros),
    credits: Math.round(Number(row.micros) / MICROS_PER_CREDIT) }));
}

/** Internal pool cost per tenant over [from, to): each account's subscription price × the tenant's share of its list value. */
export async function poolCostByTenant(ops: pg.Pool, from: string, to: string, accountPriceUsd: Record<string, number>) {
  const rows = (await ops.query(`SELECT tenant_id, account_id, sum(cost_micros)::bigint AS micros FROM ngw_usage_daily
    WHERE day >= $1 AND day < $2 AND cost_micros > 0 GROUP BY 1, 2`, [from, to])).rows.map((row) => ({ ...row, micros: Number(row.micros) }));
  const accountTotal = new Map<string, number>();
  for (const row of rows) accountTotal.set(row.account_id, (accountTotal.get(row.account_id) ?? 0) + row.micros);
  const tenants = new Map<string, { tenantId: string; listValueMicros: number; poolCostUsd: number }>();
  for (const row of rows) {
    const price = accountPriceUsd[row.account_id];
    if (price === undefined) throw new Error(`No subscription price for account ${row.account_id}`);
    const tenant = tenants.get(row.tenant_id) ?? { tenantId: row.tenant_id, listValueMicros: 0, poolCostUsd: 0 };
    tenant.listValueMicros += row.micros;
    tenant.poolCostUsd += price * row.micros / accountTotal.get(row.account_id)!;
    tenants.set(row.tenant_id, tenant);
  }
  return [...tenants.values()].sort((a, b) => a.tenantId.localeCompare(b.tenantId));
}
