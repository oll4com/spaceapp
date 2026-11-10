import { writeFileSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { disposablePostgresUnavailableReason, startDisposablePostgres, type DisposablePostgres } from "../../db/tests/support/disposable-postgres.js";
import { claudeCostUsd } from "../src/pricing/pricing.js";
import { admit, meterEventsForDay, openTenantPeriod, poolCostByTenant, RESERVATION_TTL_MS, settle, sweepExpiredReservations, tenantPace } from "../src/nous/ledger.js";
import { continuesAt, estimateMicros, serveTenantTurn, tenantPool, tenantStickyKey, type LabProvider, type PoolAccount } from "../src/nous/lab-gateway.js";
import { NGW_SCHEMA_SQL, ngwAppGrantsSql } from "../src/nous/schema.js";
import { changeTenantPlan, createTenantKeyResolver, issueTenantKey, retireOverlappedKeys, ROTATION_OVERLAP_MS, setTenantKeyStatus, withTenant,
  type TenantKey, type TenantPlan } from "../src/nous/tenant-keys.js";

// Nous Gateway lab (plan clipboard:_0qBSFCftZuD step 3): its own disposable PostgreSQL, three request-path pools as three replicas,
// synthetic accounts and a mocked provider. No Space database, account or credential is used. NGW_LAB_RESULTS=<file> writes the figures.
const unavailable = disposablePostgresUnavailableReason();
const results: Record<string, unknown> = {};
const DAY = 86_400_000;
const MODEL = "claude-sonnet-5-5";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (check: () => Promise<boolean>, limitMs = 5_000) => {
  const started = Date.now();
  while (!(await check())) {
    if (Date.now() - started > limitMs) throw new Error(`not within ${limitMs} ms`);
    await sleep(5);
  }
  return Date.now() - started;
};
const nowSec = () => Date.now() / 1000;
const account = (accountId: string, pool: string, usedPercent: number, extra: Partial<PoolAccount> = {}): PoolAccount => ({
  accountId, pool, provider: "claude", status: "ACTIVE", usedPercent, primaryResetAt: nowSec() + 3_600, primaryWindowMinutes: 300,
  secondaryUsedPercent: 30, secondaryResetAt: nowSec() + 3 * 86_400, errorCount: 0, healthTier: 0, fiveHourCapacityMicros: 400_000_000, ...extra
});
const accounts: PoolAccount[] = [
  account("acc:eu-paid-1", "eu:paid", 40), account("acc:eu-paid-2", "eu:paid", 55), account("acc:eu-paid-3", "eu:paid", 20),
  account("acc:eu-trial-1", "eu:trial", 30), account("acc:eu-trial-2", "eu:trial", 45),
  account("acc:us-paid-1", "us:paid", 10), account("acc:us-paid-2", "us:paid", 35), account("acc:us-paid-3", "us:paid", 60)
];
const accountPriceUsd = Object.fromEntries(accounts.map((item) => [item.accountId, 100])); // Claude Max 5x, $100 a month
const usage = { inputTokens: 1_000, cacheReadInputTokens: 20_000, cacheCreationInputTokens: 500, outputTokens: 800 };
const provider: LabProvider = async () => ({ usage });

describe.skipIf(unavailable)("Nous Gateway lab: tenant keys, shared ledger, pacing and metering", () => {
  let server: DisposablePostgres;
  let ops: pg.Pool;
  let replicas: pg.Pool[];
  const periodStart = new Date(Math.floor(Date.now() / DAY) * DAY);
  const tenant = async (tenantId: string, plan: TenantPlan, allowanceMicros: number, region = "eu", riskTier: "NEW" | "TRUSTED" = "TRUSTED") => {
    const issued = await issueTenantKey(ops, { tenantId, actor: "lab", plan, region, riskTier });
    await openTenantPeriod(ops, { tenantId, start: periodStart, end: new Date(periodStart.getTime() + 30 * DAY), allowanceMicros });
    return issued;
  };
  const period = async (tenantId: string) => (await ops.query("SELECT * FROM ngw_tenant_period WHERE tenant_id = $1", [tenantId])).rows[0];

  beforeAll(async () => {
    server = await startDisposablePostgres("ngw-lab");
    await server.createDatabase("ngw_lab");
    ops = server.pool("ngw_lab", 4);
    await ops.query(NGW_SCHEMA_SQL);
    await ops.query(NGW_SCHEMA_SQL); // re-running the schema is a no-op
    await ops.query("CREATE ROLE ngw_app LOGIN");
    await ops.query(ngwAppGrantsSql("ngw_app"));
    replicas = [0, 1, 2].map(() => {
      const pool = new pg.Pool({ host: server.socketDir, user: "ngw_app", database: "ngw_lab", max: 20 });
      pool.on("error", () => {});
      return pool;
    });
  }, 120_000);

  afterAll(async () => {
    await Promise.all((replicas ?? []).map((pool) => pool.end()));
    await server?.stop();
    if (process.env.NGW_LAB_RESULTS) writeFileSync(process.env.NGW_LAB_RESULTS, `${JSON.stringify(results, null, 2)}\n`);
  }, 60_000);

  it("issues, rotates with a 24-hour overlap, revokes and freezes on every replica at once, changes plan without rotation", async () => {
    const resolvers = await Promise.all(replicas.map((pool) => createTenantKeyResolver(pool)));
    try {
      const first = await issueTenantKey(ops, { tenantId: "tenant:key", actor: "lab", plan: "PERSONAL", region: "eu", riskTier: "TRUSTED" });
      expect(first.plainKey).toMatch(/^sk-ngw-[A-Za-z0-9_-]{43}$/);
      expect(JSON.stringify((await ops.query("SELECT * FROM ngw_tenant_keys")).rows)).not.toContain(first.plainKey.slice(15));
      for (const resolver of resolvers) expect((await resolver.resolve(first.plainKey))?.tenantId).toBe("tenant:key");
      expect(await resolvers[0]!.resolve(first.plainKey.replace("sk-ngw-", "sk-sgw-"))).toBeNull();

      const rotated = await issueTenantKey(ops, { tenantId: "tenant:key", actor: "lab" });
      expect(rotated.key).toMatchObject({ rotatedFrom: first.key.id, plan: "PERSONAL", status: "ACTIVE" });
      for (const resolver of resolvers) {
        await until(async () => (await resolver.resolve(first.plainKey))?.notAfter instanceof Date); // the overlap reached the cache
        expect(await resolver.resolve(rotated.plainKey)).not.toBeNull();
      }
      const overlapEnd = (await ops.query("SELECT not_after FROM ngw_tenant_keys WHERE id = $1", [first.key.id])).rows[0].not_after as Date;
      expect(overlapEnd.getTime() - rotated.key.createdAt.getTime()).toBe(ROTATION_OVERLAP_MS);
      const dayLater = await createTenantKeyResolver(replicas[0]!, { now: () => overlapEnd.getTime() + 1 });
      expect(await dayLater.resolve(first.plainKey)).toBeNull();
      expect(await dayLater.resolve(rotated.plainKey)).not.toBeNull();
      await dayLater.close();
      expect(await retireOverlappedKeys(ops, new Date(overlapEnd.getTime() + 1))).toBe(1);

      // Incident: no overlap, the old key refused on all three replicas (each had it cached).
      const started = Date.now();
      const incident = await issueTenantKey(ops, { tenantId: "tenant:key", actor: "lab", immediate: true });
      const revocationMs = await Promise.all(resolvers.map(async (resolver) => {
        await until(async () => (await resolver.resolve(rotated.plainKey)) === null);
        return Date.now() - started;
      }));
      expect(Math.max(...revocationMs)).toBeLessThan(5_000);
      for (const resolver of resolvers) expect(await resolver.resolve(incident.plainKey)).not.toBeNull();

      await setTenantKeyStatus(ops, "tenant:key", "FROZEN", "lab", "chargeback");
      const freezeMs = await Promise.all(resolvers.map((resolver) => until(async () => (await resolver.resolve(incident.plainKey)) === null)));
      await setTenantKeyStatus(ops, "tenant:key", "ACTIVE", "lab", "chargeback resolved");
      for (const resolver of resolvers) await until(async () => (await resolver.resolve(incident.plainKey)) !== null);

      await openTenantPeriod(ops, { tenantId: "tenant:key", start: periodStart, end: new Date(periodStart.getTime() + 30 * DAY), allowanceMicros: 100_000_000 });
      await changeTenantPlan(ops, { tenantId: "tenant:key", plan: "PRO", allowanceMicros: 400_000_000, actor: "lab" });
      for (const resolver of resolvers) await until(async () => (await resolver.resolve(incident.plainKey))?.plan === "PRO");
      expect((await resolvers[0]!.resolve(incident.plainKey))?.id).toBe(incident.key.id);
      expect(Number((await period("tenant:key")).allowance_micros)).toBe(400_000_000);

      // Without a NOTIFY (a lost listener) the 5-second cache still bounds the worst case.
      let clock = Date.now();
      const deaf = await createTenantKeyResolver(replicas[1]!, { now: () => clock });
      expect(await deaf.resolve(incident.plainKey)).not.toBeNull();
      await deaf.close();
      await ops.query("UPDATE ngw_tenant_keys SET status = 'FROZEN' WHERE id = $1", [incident.key.id]);
      expect(await deaf.resolve(incident.plainKey)).not.toBeNull();
      clock += 5_000;
      expect(await deaf.resolve(incident.plainKey)).toBeNull();
      await ops.query("UPDATE ngw_tenant_keys SET status = 'ACTIVE' WHERE id = $1", [incident.key.id]);

      expect(await setTenantKeyStatus(ops, "tenant:key", "REVOKED", "lab", "account deleted")).toBe(1);
      for (const resolver of resolvers) await until(async () => (await resolver.resolve(incident.plainKey)) === null);
      const actions = (await ops.query("SELECT action FROM ngw_audit WHERE tenant_id = 'tenant:key' ORDER BY id")).rows.map((row) => row.action);
      expect(actions).toEqual(["key.issue", "key.rotate", "key.rotate_immediate", "key.frozen", "key.active", "plan.change", "key.revoked"]);
      results.keyLifecycle = { revocationMsPerReplica: revocationMs, freezeMsPerReplica: freezeMs, overlapHours: ROTATION_OVERLAP_MS / 3_600_000, cacheTtlMs: 5_000 };
    } finally {
      await Promise.all(resolvers.map((resolver) => resolver.close()));
    }
  });

  it("keeps tenants apart: row-level security for the request role, pools by plan, risk and region, sticky keys per tenant", async () => {
    const a = await tenant("tenant:a", "PRO", 400_000_000);
    const b = await tenant("tenant:b", "PERSONAL", 100_000_000);
    const trial = await tenant("tenant:trial", "TRIAL", 20_000_000);
    const fresh = await tenant("tenant:new", "ULTRA", 1_200_000_000, "eu", "NEW");
    const us = await tenant("tenant:us", "PRO", 400_000_000, "us");
    expect([a, b, trial, fresh, us].map((item) => tenantPool(item.key))).toEqual(["eu:paid", "eu:paid", "eu:trial", "eu:trial", "us:paid"]);

    const resolver = await createTenantKeyResolver(replicas[0]!);
    const served = new Map<string, Set<string>>();
    try {
      for (const item of [a, b, trial, fresh, us]) {
        const seen = new Set<string>();
        for (let i = 0; i < 12; i += 1) {
          const turn = await serveTenantTurn({ app: replicas[i % 3]!, resolver, accounts, provider }, { presentedKey: item.plainKey, model: MODEL, inputTokens: 1_000 });
          expect(turn.status).toBe(200);
          if (turn.status === 200) seen.add(turn.accountId);
        }
        served.set(item.key.tenantId, seen);
        for (const accountId of seen) expect(accounts.find((entry) => entry.accountId === accountId)?.pool).toBe(tenantPool(item.key));
      }
    } finally {
      await resolver.close();
    }

    await withTenant(replicas[1]!, "tenant:a", async (client) => {
      for (const table of ["ngw_tenant_keys", "ngw_tenant_period", "ngw_usage", "ngw_usage_daily", "ngw_audit"]) {
        const tenants = (await client.query(`SELECT DISTINCT tenant_id FROM ${table}`)).rows.map((row) => row.tenant_id);
        expect(tenants, table).toEqual(["tenant:a"]);
      }
      expect((await client.query("UPDATE ngw_tenant_period SET spent_micros = 0 WHERE tenant_id = 'tenant:b'")).rowCount).toBe(0);
    });
    await expect(withTenant(replicas[1]!, "tenant:a", (client) => client.query(`INSERT INTO ngw_usage (request_id, tenant_id, key_id, pool, provider, model,
      traffic_class, status, cost_micros) VALUES ('forged', 'tenant:b', 'k', 'eu:paid', 'claude', 'm', 'FOREGROUND', 'OK', 0)`))).rejects.toThrow(/row-level security/);
    expect((await replicas[2]!.query("SELECT count(*)::int AS n FROM ngw_usage")).rows[0].n).toBe(0); // no tenant set: nothing
    expect(tenantStickyKey("tenant:a", "claude", "session-1")).not.toBe(tenantStickyKey("tenant:b", "claude", "session-1"));
    results.isolation = Object.fromEntries([...served].map(([tenantId, ids]) => [tenantId, [...ids].sort()]));
  });

  it("holds today's allowance exactly with 200 parallel requests over three replicas, then settles each once", async () => {
    const { key } = await tenant("tenant:race", "PERSONAL", 100_000_000);
    const pressure = { fiveHourMeanPercent: 65, roomMicros: 10_000_000_000 }; // neither burst nor pressed
    const estimate = 250_000;
    const now = new Date();
    const cap = tenantPace({ capMicros: 100_000_000, spentMicros: 0, daySpentMicros: 0, periodEnd: new Date(periodStart.getTime() + 30 * DAY), now,
      fiveHourMeanPercent: pressure.fiveHourMeanPercent }).todayCapMicros;
    const outcomes = await Promise.all(Array.from({ length: 200 }, (_, i) => admit(replicas[i % 3]!, {
      requestId: `race:${i}`, key, pool: "eu:paid", trafficClass: "FOREGROUND", estimateMicros: estimate, pressure, now
    })));
    const admitted = outcomes.flatMap((outcome, i) => outcome.admitted ? [`race:${i}`] : []);
    expect(admitted.length).toBe(Math.floor(cap / estimate));
    expect(outcomes.filter((outcome) => !outcome.admitted).every((outcome) => !outcome.admitted && outcome.reason === "DAILY_ALLOWANCE")).toBe(true);
    const reservedPeak = Number((await period("tenant:race")).reserved_micros);
    expect(reservedPeak).toBe(admitted.length * estimate);

    const cost = (id: string) => 100_000 + (Number(id.slice(5)) * 7_919) % 150_000;
    const settlements = await Promise.all([...admitted, ...admitted].map((requestId, j) => settle(replicas[j % 3]!, {
      requestId, key, pool: "eu:paid", accountId: "acc:eu-paid-1", provider: "claude", model: MODEL, trafficClass: "FOREGROUND", status: "OK", costMicros: cost(requestId)
    })));
    expect(settlements.filter((item) => item.settled).length).toBe(admitted.length);
    const spent = admitted.reduce((sum, id) => sum + cost(id), 0);
    const after = await period("tenant:race");
    expect({ reserved: Number(after.reserved_micros), spent: Number(after.spent_micros), daySpent: Number(after.day_spent_micros) })
      .toEqual({ reserved: 0, spent, daySpent: spent });
    expect((await ops.query("SELECT count(*)::int AS n FROM ngw_inflight WHERE tenant_id = 'tenant:race'")).rows[0].n).toBe(0);
    expect(Number((await ops.query("SELECT sum(cost_micros) AS s FROM ngw_usage_daily WHERE tenant_id = 'tenant:race'")).rows[0].s)).toBe(spent);
    results.concurrency = { requests: 200, replicas: 3, estimateMicros: estimate, todayCapMicros: cap, admitted: admitted.length, reservedPeakMicros: reservedPeak,
      overshootMicros: Math.max(0, reservedPeak - cap), settledMicros: spent, duplicateSettlementsIgnored: admitted.length };
  });

  it("paces each tenant: daily allowance rolls forward, 2× burst only under 60%, background waits and weighted shares when pressed", async () => {
    const end = new Date("2026-12-01T00:00:00Z");
    const pace = (now: string, spentMicros: number, daySpentMicros: number, fiveHourMeanPercent: number) =>
      tenantPace({ capMicros: 30_000_000, spentMicros, daySpentMicros, periodEnd: end, now: new Date(now), fiveHourMeanPercent });
    expect(pace("2026-11-01T10:00:00Z", 0, 0, 65)).toEqual({ daysLeft: 30, allowanceTodayMicros: 1_000_000, burst: 1, todayCapMicros: 1_000_000 });
    expect(pace("2026-11-02T10:00:00Z", 0, 0, 65).allowanceTodayMicros).toBe(Math.floor(30_000_000 / 29)); // day 1 unspent rolls forward
    expect(pace("2026-11-01T10:00:00Z", 0, 0, 50).todayCapMicros).toBe(2_000_000);
    expect(pace("2026-11-30T10:00:00Z", 20_000_000, 0, 50)).toEqual({ daysLeft: 1, allowanceTodayMicros: 10_000_000, burst: 2, todayCapMicros: 10_000_000 });
    expect(pace("2026-11-15T10:00:00Z", 30_000_000, 0, 50).todayCapMicros).toBe(0);

    const calm = { fiveHourMeanPercent: 65, roomMicros: 10_000_000_000 };
    const { key } = await tenant("tenant:pace", "PERSONAL", 3_000_000); // $3 a month: $0.10 a day
    const ask = (requestId: string, estimateMicros: number, pressure = calm, trafficClass: "FOREGROUND" | "BACKGROUND" = "FOREGROUND") =>
      admit(replicas[0]!, { requestId, key, pool: "eu:paid", trafficClass, estimateMicros, pressure });
    const refused = await ask("pace:1", 150_000);
    expect(refused).toMatchObject({ admitted: false, reason: "DAILY_ALLOWANCE", retryAt: new Date(Math.floor(Date.now() / DAY) * DAY + DAY) });
    expect(continuesAt((refused as { retryAt: Date }).retryAt)).toBe("Your AI continues at 00:00 UTC.");
    expect(await ask("pace:2", 150_000, { fiveHourMeanPercent: 50, roomMicros: 10_000_000_000 })).toMatchObject({ admitted: true }); // burst
    await openTenantPeriod(ops, { tenantId: "tenant:pace", start: periodStart, end: new Date(periodStart.getTime() + 30 * DAY), allowanceMicros: 100_000 });
    expect(await ask("pace:3", 1)).toMatchObject({ admitted: false, reason: "MONTH_CAP" }); // the open reservation fills the month
    await openTenantPeriod(ops, { tenantId: "tenant:pace", start: periodStart, end: new Date(periodStart.getTime() + 30 * DAY), allowanceMicros: 100_000, topupMicros: 9_900_000 });
    expect(await ask("pace:4", 100_000)).toMatchObject({ admitted: true }); // a prepaid top-up opens it again

    const pressed = { fiveHourMeanPercent: 80, roomMicros: 7_000_000 };
    const weights: Array<[string, TenantPlan]> = [["tenant:fs-personal", "PERSONAL"], ["tenant:fs-pro", "PRO"], ["tenant:fs-ultra", "ULTRA"]];
    const keys: TenantKey[] = [];
    for (const [tenantId, plan] of weights) keys.push((await tenant(tenantId, plan, 3_000_000_000)).key);
    const share = (key: TenantKey, requestId: string, trafficClass: "FOREGROUND" | "BACKGROUND" = "FOREGROUND") =>
      admit(replicas[Number(requestId.split(":").pop()) % 3]!, { requestId, key, pool: "lab:pressed", trafficClass, estimateMicros: 100_000, pressure: pressed });
    expect(await share(keys[0]!, "bg:0", "BACKGROUND")).toMatchObject({ admitted: false, reason: "BACKGROUND_WAITS" });
    for (const key of keys) expect(await share(key, `${key.tenantId}:0`)).toMatchObject({ admitted: true });
    const flood = await Promise.all(Array.from({ length: 120 }, (_, i) => share(keys[i % 3]!, `${keys[i % 3]!.tenantId}:${i + 1}`)));
    expect(flood.filter((item) => !item.admitted).every((item) => !item.admitted && item.reason === "FAIR_SHARE")).toBe(true);
    const held = Object.fromEntries(await Promise.all(keys.map(async (key) => [key.plan,
      Number((await ops.query("SELECT sum(reserved_micros) AS s FROM ngw_inflight WHERE tenant_id = $1", [key.tenantId])).rows[0].s)])));
    expect(held).toEqual({ PERSONAL: 1_000_000, PRO: 2_000_000, ULTRA: 4_000_000 }); // 1 : 2 : 4 of the 7,000,000 room
    results.pacing = { dailyCapMicrosOf3UsdMonth: 100_000, burstAdmittedUnder60Percent: true, backgroundWaitsWhenPressed: true,
      fairShareHeldMicros: held, roomMicros: pressed.roomMicros };
  });

  it("meters per tenant at list cost, exports one idempotent event per tenant-day, prices the pool by share, survives crashes", async () => {
    const tenants = [await tenant("tenant:m1", "PERSONAL", 100_000_000), await tenant("tenant:m2", "PRO", 400_000_000), await tenant("tenant:m3", "ULTRA", 1_200_000_000)];
    const resolver = await createTenantKeyResolver(replicas[2]!);
    const perRequest = Math.round(claudeCostUsd(usage, MODEL)! * 1e6);
    try {
      const counts = [5, 10, 20];
      for (const [index, item] of tenants.entries()) {
        const turns = await Promise.all(Array.from({ length: counts[index]! }, (_, i) =>
          serveTenantTurn({ app: replicas[i % 3]!, resolver, accounts, provider }, { presentedKey: item.plainKey, model: MODEL, inputTokens: usage.inputTokens })));
        expect(turns.every((turn) => turn.status === 200 && turn.costMicros === perRequest)).toBe(true);
      }
      const day = new Date().toISOString().slice(0, 10);
      const events = (await meterEventsForDay(ops, day)).filter((event) => event.tenantId.startsWith("tenant:m"));
      expect(events).toEqual(tenants.map((item, index) => ({ identifier: `ngw:${item.key.tenantId}:${day}`, tenantId: item.key.tenantId, day,
        costMicros: counts[index]! * perRequest, credits: Math.round(counts[index]! * perRequest / 10_000) })));
      expect((await meterEventsForDay(ops, day)).filter((event) => event.tenantId.startsWith("tenant:m"))).toEqual(events); // a re-run is the same

      const month = await poolCostByTenant(ops, day.slice(0, 8) + "01", "2999-01-01", accountPriceUsd);
      const used = new Set((await ops.query("SELECT DISTINCT account_id FROM ngw_usage_daily WHERE cost_micros > 0")).rows.map((row) => row.account_id));
      expect(month.reduce((sum, row) => sum + row.poolCostUsd, 0)).toBeCloseTo(used.size * 100, 6);
      await expect(poolCostByTenant(ops, "2000-01-01", "2999-01-01", {})).rejects.toThrow(/No subscription price/);

      // A provider failure releases the reservation and charges nothing.
      const before = await period("tenant:m1");
      const failed = await serveTenantTurn({ app: replicas[0]!, resolver, accounts, provider: async () => { throw new Error("upstream 500"); } },
        { presentedKey: tenants[0]!.plainKey, model: MODEL, inputTokens: 1_000 });
      expect(failed.status).toBe(502);
      expect(await period("tenant:m1")).toMatchObject({ spent_micros: before.spent_micros, reserved_micros: "0" });
      expect((await serveTenantTurn({ app: replicas[0]!, resolver, accounts, provider }, { presentedKey: tenants[0]!.plainKey, model: "unpriced-model", inputTokens: 1 })).status).toBe(400);
      const exhausted = accounts.map((item) => ({ ...item, status: "QUOTA_EXCEEDED" as const, usedPercent: 100, resetAt: nowSec() + 1_800 }));
      const full = await serveTenantTurn({ app: replicas[0]!, resolver, accounts: exhausted, provider }, { presentedKey: tenants[0]!.plainKey, model: MODEL, inputTokens: 1_000 });
      expect(full).toMatchObject({ status: 429 });
      expect(full.status === 429 && full.message).toMatch(/^Your AI continues at \d{2}:\d{2} UTC\.$/); // never an account count

      // A replica dies mid-request: the reservation expires and goes back; a late settlement still counts once.
      const estimate = estimateMicros(MODEL, 1_000)!;
      expect(await admit(replicas[1]!, { requestId: "crash:1", key: tenants[0]!.key, pool: "eu:paid", trafficClass: "FOREGROUND", estimateMicros: estimate,
        pressure: { fiveHourMeanPercent: 65, roomMicros: 1e10 } })).toMatchObject({ admitted: true });
      expect(Number((await period("tenant:m1")).reserved_micros)).toBe(estimate);
      expect(await sweepExpiredReservations(ops, new Date(Date.now() + RESERVATION_TTL_MS + 1_000))).toBeGreaterThanOrEqual(1);
      expect(Number((await period("tenant:m1")).reserved_micros)).toBe(0);
      const late = { requestId: "crash:1", key: tenants[0]!.key, pool: "eu:paid", accountId: "acc:eu-paid-1", provider: "claude", model: MODEL,
        trafficClass: "FOREGROUND" as const, status: "OK" as const, costMicros: perRequest };
      expect(await settle(replicas[2]!, late)).toEqual({ settled: true });
      expect(await settle(replicas[0]!, late)).toEqual({ settled: false });
      expect(Number((await period("tenant:m1")).spent_micros)).toBe(Number(before.spent_micros) + perRequest);
      results.metering = { model: MODEL, usagePerRequest: usage, listCostMicrosPerRequest: perRequest, meterEvents: events,
        poolCostByTenantThisMonth: month.map((row) => ({ ...row, poolCostUsd: Math.round(row.poolCostUsd * 100) / 100 })) };
    } finally {
      await resolver.close();
    }
  });
});
