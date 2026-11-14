import { createHmac } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { disposablePostgresUnavailableReason, startDisposablePostgres, type DisposablePostgres } from "../../db/tests/support/disposable-postgres.js";
import { migrateNgw } from "../src/nous/migrate.js";
import { ngwAppGrantsSql } from "../src/nous/schema.js";
import { billingConfig, checkoutBody, createCheckoutSession, PLAN_ALLOWANCE_MICROS, registerCheckoutRoute, registerStripeWebhook,
  verifyStripeSignature } from "../src/nous/subscriptions.js";
import { issueTenantKey } from "../src/nous/tenant-keys.js";
import { openTenantPeriod } from "../src/nous/ledger.js";

// K4-billing (test mode): signature, the live-key refusal and the Checkout body as pure checks; the webhook on a disposable PostgreSQL as
// the request-path role. No Stripe call: fetch is injected.
const config = billingConfig({ key: "sk_test_abc123", webhookSecret: "whsec_testsecret", prices: { PERSONAL: "price_personal", PRO: "price_pro", ULTRA: "price_ultra" },
  successUrl: "https://nous.example/billing/done", cancelUrl: "https://nous.example/billing" });
const sign = (body: string, t: number, secret = config.webhookSecret) => `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${body}`).digest("hex")}`;

describe("Nous billing (pure)", () => {
  it("refuses live and malformed keys", () => {
    expect(() => billingConfig({ ...config, key: "sk_live_abc" })).toThrow(/live keys are refused/);
    expect(() => billingConfig({ ...config, key: "rk_live_abc" })).toThrow(/live keys are refused/);
    expect(() => billingConfig({ ...config, key: "pk_test_abc" })).toThrow(/test secret/);
    expect(() => billingConfig({ ...config, prices: { ...config.prices, ULTRA: "price_pro" } })).toThrow(/own Stripe price/);
    expect(() => billingConfig({ ...config, successUrl: "http://nous.example" })).toThrow(/https/);
    expect(billingConfig({ ...config, key: "rk_test_abc" }).key).toBe("rk_test_abc");
  });

  it("verifies Stripe-Signature within 300 s", () => {
    const body = '{"id":"evt_1"}', now = 1_800_000_000;
    expect(verifyStripeSignature(Buffer.from(body), sign(body, now), config.webhookSecret, now)).toBe(true);
    expect(verifyStripeSignature(Buffer.from(body), `${sign(body, now)},v1=${"0".repeat(64)}`, config.webhookSecret, now + 300)).toBe(true);
    expect(verifyStripeSignature(Buffer.from(body), sign(body, now), config.webhookSecret, now + 301)).toBe(false); // too old
    expect(verifyStripeSignature(Buffer.from(body), sign(body, now, "whsec_other"), config.webhookSecret, now)).toBe(false);
    expect(verifyStripeSignature(Buffer.from(`${body} `), sign(body, now), config.webhookSecret, now)).toBe(false);
    expect(verifyStripeSignature(Buffer.from(body), undefined, config.webhookSecret, now)).toBe(false);
    expect(verifyStripeSignature(Buffer.from(body), `t=${now},v1=zz`, config.webhookSecret, now)).toBe(false);
  });

  it("builds the Checkout session and sends it with the key", async () => {
    const form = new URLSearchParams(checkoutBody(config, { tenantId: "t1", plan: "PRO", customerId: "cus_1" }));
    expect(Object.fromEntries(form)).toMatchObject({ mode: "subscription", client_reference_id: "t1", "line_items[0][price]": "price_pro", "automatic_tax[enabled]": "true",
      success_url: config.successUrl, cancel_url: config.cancelUrl, "subscription_data[metadata][tenant_id]": "t1", customer: "cus_1" });
    const calls: Array<[string, RequestInit]> = [];
    const send = (async (url: string, init: RequestInit) => { calls.push([url, init]); return Response.json({ id: "cs_test_1", url: "https://checkout.stripe.com/c/1" }); }) as typeof fetch;
    expect(await createCheckoutSession(config, { tenantId: "t1", plan: "PERSONAL", customerId: null }, send)).toEqual({ id: "cs_test_1", url: "https://checkout.stripe.com/c/1" });
    expect(calls[0]![0]).toBe("https://api.stripe.com/v1/checkout/sessions");
    expect((calls[0]![1].headers as Record<string, string>).authorization).toBe("Bearer sk_test_abc123");
    const refused = (async () => Response.json({ error: { code: "resource_missing" } }, { status: 400 })) as typeof fetch;
    await expect(createCheckoutSession(config, { tenantId: "t1", plan: "PERSONAL", customerId: null }, refused)).rejects.toThrow(/400 resource_missing/);
  });
});

const unavailable = disposablePostgresUnavailableReason();

describe.skipIf(unavailable)("Nous billing webhook", () => {
  let server: DisposablePostgres;
  let ops: pg.Pool, app: pg.Pool;
  let web: FastifyInstance;
  const now = new Date("2026-11-13T12:00:00Z"), nowSec = Math.floor(now.getTime() / 1000);
  let created = nowSec;
  const post = (event: object, signature?: string) => {
    const body = JSON.stringify(event);
    return web.inject({ method: "POST", url: "/stripe/webhook", payload: body, headers: { "content-type": "application/json; charset=utf-8", "stripe-signature": signature ?? sign(body, nowSec) } });
  };
  const subscription = (id: string, type: string, status: string, price: string, tenant = "acme") =>
    ({ id, type, created: ++created, data: { object: { id: "sub_1", customer: "cus_1", status, metadata: { tenant_id: tenant }, items: { data: [{ price: { id: price } }] } } } });
  const keys = async () => (await ops.query("SELECT id, key_hash, plan, status FROM ngw_tenant_keys WHERE tenant_id = 'acme' AND status <> 'REVOKED'")).rows;

  beforeAll(async () => {
    server = await startDisposablePostgres("ngw-billing");
    await server.createDatabase("ngw_billing");
    ops = server.pool("ngw_billing", 4);
    await migrateNgw(ops);
    await ops.query("CREATE ROLE ngw_app LOGIN");
    await ops.query(ngwAppGrantsSql("ngw_app"));
    app = new pg.Pool({ host: server.socketDir, user: "ngw_app", database: "ngw_billing", max: 5 });
    await issueTenantKey(app, { tenantId: "acme", actor: "test", plan: "PERSONAL", region: "eu", riskTier: "NEW", now });
    await openTenantPeriod(app, { tenantId: "acme", start: new Date("2026-11-01T00:00:00Z"), end: new Date("2026-12-01T00:00:00Z"), allowanceMicros: PLAN_ALLOWANCE_MICROS.PERSONAL });
    web = Fastify();
    registerStripeWebhook(web, { db: app, billing: config, now: () => now });
    await web.ready();
  }, 120_000);

  afterAll(async () => {
    await web?.close();
    await ops?.end();
    await app?.end();
    await server?.stop();
  });

  it("rejects a bad or old signature and records nothing", async () => {
    const event = { id: "evt_bad", type: "invoice.paid", created: nowSec, data: { object: {} } };
    expect((await post(event, "t=1,v1=00")).statusCode).toBe(400);
    expect((await post(event, sign(JSON.stringify(event), nowSec - 301))).statusCode).toBe(400);
    expect((await post(event, sign(JSON.stringify(event), nowSec, "whsec_other"))).statusCode).toBe(400);
    expect((await ops.query("SELECT 1 FROM ngw_stripe_events")).rowCount).toBe(0);
  });

  it("links the customer at checkout and ignores a replayed event id", async () => {
    const event = { id: "evt_checkout", type: "checkout.session.completed", created: ++created,
      data: { object: { mode: "subscription", client_reference_id: "acme", customer: "cus_1", subscription: "sub_1" } } };
    expect((await post(event)).json()).toMatchObject({ outcome: "linked" });
    expect((await post(event)).json()).toMatchObject({ outcome: "duplicate" });
    expect((await ops.query("SELECT stripe_customer_id, stripe_subscription_id FROM ngw_tenant_billing WHERE tenant_id = 'acme'")).rows).toEqual([
      { stripe_customer_id: "cus_1", stripe_subscription_id: "sub_1" }]);
    expect((await ops.query("SELECT count(*)::int AS n FROM ngw_audit WHERE tenant_id = 'acme' AND action = 'billing.customer'")).rows[0].n).toBe(1);
  });

  it("changes the plan without rotating the key", async () => {
    const before = await keys();
    expect((await post(subscription("evt_up", "customer.subscription.updated", "active", "price_pro"))).json()).toMatchObject({ outcome: "plan_PRO" });
    const after = await keys();
    expect(after).toEqual([{ ...before[0], plan: "PRO" }]);
    expect((await ops.query("SELECT allowance_micros::float AS a FROM ngw_tenant_period WHERE tenant_id = 'acme'")).rows[0].a).toBe(PLAN_ALLOWANCE_MICROS.PRO);
    // Stripe does not order deliveries: an older update changes nothing.
    const stale = { ...subscription("evt_old", "customer.subscription.updated", "active", "price_personal"), created: nowSec - 100 };
    expect((await post(stale)).json()).toMatchObject({ outcome: "stale" });
    expect((await keys())[0].plan).toBe("PRO");
  });

  it("past_due freezes the keys and active unfreezes the ones billing froze", async () => {
    expect((await post(subscription("evt_due", "customer.subscription.updated", "past_due", "price_pro"))).json()).toMatchObject({ outcome: "frozen" });
    expect((await keys()).map((key) => key.status)).toEqual(["FROZEN"]);
    expect((await post(subscription("evt_paid", "customer.subscription.updated", "active", "price_pro"))).json()).toMatchObject({ outcome: "plan_PRO" });
    expect((await keys()).map((key) => key.status)).toEqual(["ACTIVE"]);
  });

  it("opens the next period on invoice.paid", async () => {
    const event = { id: "evt_inv", type: "invoice.paid", created: ++created, data: { object: { billing_reason: "subscription_cycle",
      parent: { subscription_details: { metadata: { tenant_id: "acme" } } },
      lines: { data: [{ pricing: { price_details: { price: "price_pro" } }, period: { start: Date.parse("2026-11-20T00:00:00Z") / 1000, end: Date.parse("2026-12-20T00:00:00Z") / 1000 } }] } } } };
    expect((await post(event)).json()).toMatchObject({ outcome: "period_PRO" });
    const periods = (await ops.query("SELECT period_start, period_end, allowance_micros::float AS a FROM ngw_tenant_period WHERE tenant_id = 'acme' ORDER BY period_start")).rows;
    expect(periods.map((row) => [row.period_start.toISOString(), row.period_end.toISOString(), row.a])).toEqual([
      ["2026-11-01T00:00:00.000Z", "2026-11-20T00:00:00.000Z", PLAN_ALLOWANCE_MICROS.PRO], ["2026-11-20T00:00:00.000Z", "2026-12-20T00:00:00.000Z", PLAN_ALLOWANCE_MICROS.PRO]]);
  });

  it("answers 200 to unknown events and freezes on deletion", async () => {
    const unknown = await post({ id: "evt_unknown", type: "customer.created", created: ++created, data: { object: {} } });
    expect([unknown.statusCode, unknown.json().outcome]).toEqual([200, "ignored"]);
    expect((await post(subscription("evt_del", "customer.subscription.deleted", "canceled", "price_pro"))).json()).toMatchObject({ outcome: "ended" });
    expect((await keys()).map((key) => [key.plan, key.status])).toEqual([["TRIAL", "FROZEN"]]);
    expect((await ops.query("SELECT count(*)::int AS n FROM ngw_stripe_events")).rows[0].n).toBe(8);
  });

  it("creates a Checkout session for a tenant through the admin route", async () => {
    const admin = Fastify(), audits: unknown[][] = [];
    const send = (async (_url: string, init: RequestInit) => Response.json({ id: "cs_test_2", url: `https://checkout.stripe.com/c/2#${new URLSearchParams(String(init.body)).get("customer")}` })) as typeof fetch;
    registerCheckoutRoute(admin, { db: app, billing: config, fetch: send, caller: () => ({ kind: "service", name: "k4", actor: "service:k4" }),
      audit: async (...row) => { audits.push(row); } });
    const response = await admin.inject({ method: "POST", url: "/tenants/acme/checkout", payload: { plan: "ULTRA" } });
    expect([response.statusCode, response.json()]).toEqual([200, { id: "cs_test_2", url: "https://checkout.stripe.com/c/2#cus_1" }]);
    expect(audits).toEqual([["acme", "service:k4", "billing.checkout", { plan: "ULTRA", sessionId: "cs_test_2" }]]);
    expect((await admin.inject({ method: "POST", url: "/tenants/acme/checkout", payload: { plan: "TRIAL" } })).statusCode).toBe(400);
    await admin.close();
  });
});
