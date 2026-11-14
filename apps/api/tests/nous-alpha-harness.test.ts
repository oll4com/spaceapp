import { createHmac } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { disposablePostgresUnavailableReason, startDisposablePostgres, type DisposablePostgres } from "../../../packages/db/tests/support/disposable-postgres.js";
import { openTenantPeriod } from "../../../packages/gateway/src/nous/ledger.js";
import { migrateNgw } from "../../../packages/gateway/src/nous/migrate.js";
import { ngwAppGrantsSql } from "../../../packages/gateway/src/nous/schema.js";
import { billingConfig, PLAN_ALLOWANCE_MICROS, registerStripeWebhook, TRIAL_DAYS } from "../../../packages/gateway/src/nous/subscriptions.js";
import { issueTenantKey, withTenant } from "../../../packages/gateway/src/nous/tenant-keys.js";
import { createFakeCellDriver } from "../src/computer/cell-driver.js";
import { IDLE_TO_SLEEP_MS, createCellOrchestrator, createMemoryCellStore } from "../src/computer/cells.js";

// Private-alpha harness (plan clipboard:ZGz1LnD51ELH, p1-alpha-prep §4–§5): one wave of internal tenants (our own accounts) goes
// through sign-up keys, a Stripe test-mode subscription by signed webhook, a cell's create → sleep → wake, and the wave gate
// (wake p95 < 2 s and 0 cross-tenant reads). shortcut: fake cell driver and no Stripe call, so wake times are the fake's delays;
// rerun on the P1 cell host with the Firecracker driver and a Stripe test key before the first real wave.
const WAVE_WAKE_P95_MS = 2_000;
const TENANT_TABLES = ["ngw_tenant_keys", "ngw_tenant_period", "ngw_inflight", "ngw_usage", "ngw_usage_daily", "ngw_audit", "ngw_tenant_billing"];
const wave = Array.from({ length: 10 }, (_, i) => ({ tenantId: `internal-${String(i + 1).padStart(2, "0")}`, plan: i % 2 ? "PRO" as const : "PERSONAL" as const }));
const billing = billingConfig({ key: "sk_test_harness", webhookSecret: "whsec_harness", prices: { PERSONAL: "price_personal", PRO: "price_pro", ULTRA: "price_ultra" },
  successUrl: "https://nous.example/billing/done", cancelUrl: "https://nous.example/billing" });

describe.skipIf(disposablePostgresUnavailableReason())("Nous private-alpha harness", () => {
  let server: DisposablePostgres;
  let ops: pg.Pool, app: pg.Pool;
  let web: FastifyInstance;
  const now = new Date("2026-11-13T12:00:00Z"), nowSec = Math.floor(now.getTime() / 1000);
  let created = nowSec;
  const stripe = (type: string, object: object) => {
    const body = JSON.stringify({ id: `evt_${++created}`, type, created, data: { object } });
    const signature = `t=${nowSec},v1=${createHmac("sha256", billing.webhookSecret).update(`${nowSec}.${body}`).digest("hex")}`;
    return web.inject({ method: "POST", url: "/stripe/webhook", payload: body, headers: { "content-type": "application/json", "stripe-signature": signature } });
  };

  beforeAll(async () => {
    server = await startDisposablePostgres("ngw-alpha");
    await server.createDatabase("ngw_alpha");
    ops = server.pool("ngw_alpha", 4);
    await migrateNgw(ops);
    await ops.query("CREATE ROLE ngw_app LOGIN");
    await ops.query(ngwAppGrantsSql("ngw_app"));
    app = new pg.Pool({ host: server.socketDir, user: "ngw_app", database: "ngw_alpha", max: 5 });
    web = Fastify();
    registerStripeWebhook(web, { db: app, billing, now: () => now });
    await web.ready();
  }, 120_000);

  afterAll(async () => {
    await web?.close();
    await ops?.end();
    await app?.end();
    await server?.stop();
  });

  it("runs one wave from trial to paid, through a cell's sleep and wake, and opens the next wave", async () => {
    for (const { tenantId, plan } of wave) {
      await issueTenantKey(app, { tenantId, actor: "harness", plan: "TRIAL", region: "eu", riskTier: "NEW", now });
      await openTenantPeriod(app, { tenantId, start: now, end: new Date(now.getTime() + TRIAL_DAYS * 86_400_000), allowanceMicros: PLAN_ALLOWANCE_MICROS.TRIAL });
      const ids = { customer: `cus_${tenantId.replace("-", "")}`, subscription: `sub_${tenantId.replace("-", "")}` }; // Stripe ids are alphanumeric
      expect((await stripe("checkout.session.completed", { mode: "subscription", client_reference_id: tenantId, ...ids })).json()).toMatchObject({ outcome: "linked" });
      expect((await stripe("customer.subscription.created", { id: ids.subscription, customer: ids.customer, status: "active", metadata: { tenant_id: tenantId },
        items: { data: [{ price: { id: billing.prices[plan] } }] } })).json()).toMatchObject({ outcome: `plan_${plan}` });
    }
    const paid = (await ops.query("SELECT tenant_id, plan FROM ngw_tenant_keys WHERE status = 'ACTIVE' AND plan IN ('PERSONAL', 'PRO') ORDER BY tenant_id")).rows;
    expect(paid).toEqual(wave.map(({ tenantId, plan }) => ({ tenant_id: tenantId, plan })));

    // Cells: everyone signs in at once, goes idle, then comes back one by one (lab-like delays: restore 300 ms, ready 200 ms).
    let t = now.getTime();
    const driver = createFakeCellDriver({ advance: (ms) => (t += ms), delaysMs: { create: 900, restore: 300, syncClock: 5, waitReady: 200 } });
    const cells = createCellOrchestrator({ driver, store: createMemoryCellStore(), hosts: [{ id: "cell-1", ramMib: 131_072, maxAwake: 40 }], now: () => t });
    await Promise.all(wave.map(({ tenantId }) => cells.ensureAwake(tenantId)));
    t += IDLE_TO_SLEEP_MS;
    expect((await cells.tick()).slept.sort()).toEqual(wave.map(({ tenantId }) => tenantId));
    for (const { tenantId } of wave) expect((await cells.ensureAwake(tenantId)).from).toBe("SLEEPING");
    const [host] = await cells.hostMetrics();

    // Cross-tenant reads: as each tenant, every tenant table must show only its own rows (and its own key must show).
    let incidents = 0;
    for (const { tenantId } of wave) {
      await withTenant(app, tenantId, async (client) => {
        for (const table of TENANT_TABLES) incidents += (await client.query(`SELECT 1 FROM ${table} WHERE tenant_id <> $1`, [tenantId])).rowCount ?? 0;
        expect((await client.query("SELECT 1 FROM ngw_tenant_keys")).rowCount).toBe(1);
      });
    }
    expect((await app.query("SELECT 1 FROM ngw_tenant_keys")).rowCount).toBe(0); // no tenant set: nothing

    expect(host).toMatchObject({ awake: wave.length, sleeping: 0 });
    expect(host!.wakeP95Ms).toBeLessThan(WAVE_WAKE_P95_MS);
    expect(incidents).toBe(0);
  }, 120_000);
});
