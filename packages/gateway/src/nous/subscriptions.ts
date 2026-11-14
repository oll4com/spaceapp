import { createHmac, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type pg from "pg";
import { z } from "zod";
import { TENANT_ID, type AdminAudit, type AdminCaller } from "./admin.js";
import { changeTenantPlan, setTenantKeyStatus, withTenant, type TenantPlan } from "./tenant-keys.js";

/**
 * K4-billing (plan clipboard:ZGz1LnD51ELH; decision 400c6404): subscriptions through Stripe Checkout on the web only, TEST MODE ONLY.
 * Plans, per month ex VAT, with the included AI as an allowance: Personal €9 ($100), Pro €24 ($400), Ultra €59 ($1,200); the trial is
 * 7 days with $20. The euro prices live in Stripe (NGW_STRIPE_PRICE_*); the code only maps a price id to its plan.
 * The webhook (`POST /stripe/webhook`, public listener) is verified by `Stripe-Signature`, recorded once per event id in
 * `ngw_stripe_events`, and moves the plan, the keys' status and the ledger period; the admin listener creates a tenant's Checkout session.
 */
const USD = 1_000_000; // micros
export const PLAN_ALLOWANCE_MICROS: Record<TenantPlan, number> = { TRIAL: 20 * USD, PERSONAL: 100 * USD, PRO: 400 * USD, ULTRA: 1_200 * USD };
export const TRIAL_DAYS = 7;
export const BILLING_ACTOR = "stripe:webhook";
export const SIGNATURE_TOLERANCE_SECONDS = 300;
type PaidPlan = Exclude<TenantPlan, "TRIAL">;
const PAID_PLANS = ["PERSONAL", "PRO", "ULTRA"] as const;

export interface BillingConfig { key: string; webhookSecret: string; prices: Record<PaidPlan, string>; successUrl: string; cancelUrl: string }

const TEST_KEY = /^(sk|rk)_test_[A-Za-z0-9]+$/;

/** Validates the billing settings; a live key is refused. */
export function billingConfig(input: BillingConfig): BillingConfig {
  // shortcut: test mode only; live billing waits on the operator's go (Stripe account, products, live key), then this check opens.
  if (/^(sk|rk)_live_/.test(input.key)) throw new Error("Stripe live keys are refused: Nous billing runs in test mode only until the operator approves live billing.");
  if (!TEST_KEY.test(input.key)) throw new Error("The Stripe key must be a test secret (sk_test_) or restricted (rk_test_) key.");
  if (!/^whsec_[A-Za-z0-9]+$/.test(input.webhookSecret)) throw new Error("The Stripe webhook secret must be a whsec_ secret.");
  for (const plan of PAID_PLANS) if (!/^price_[A-Za-z0-9]+$/.test(input.prices[plan] ?? "")) throw new Error(`NGW_STRIPE_PRICE_${plan} must be a Stripe price id.`);
  if (new Set(Object.values(input.prices)).size !== PAID_PLANS.length) throw new Error("Each plan needs its own Stripe price.");
  for (const url of [input.successUrl, input.cancelUrl]) if (!URL.canParse(url) || new URL(url).protocol !== "https:") throw new Error("Checkout success and cancel URLs must be https URLs.");
  return input;
}

/**
 * On when NGW_STRIPE_WEBHOOK_SECRET_WRAPPED_FILE is set: the key and the secret are KMS-wrapped files (as ngw-ops' Stripe key), the
 * prices and NGW_CHECKOUT_SUCCESS_URL / NGW_CHECKOUT_CANCEL_URL plain settings.
 */
export async function loadBilling(env: NodeJS.ProcessEnv, decrypt: ((wrapped: Buffer) => Promise<Buffer>) | null): Promise<BillingConfig | null> {
  const secretFile = env.NGW_STRIPE_WEBHOOK_SECRET_WRAPPED_FILE?.trim(), keyFile = env.NGW_STRIPE_KEY_WRAPPED_FILE?.trim();
  if (!secretFile) return null;
  if (!keyFile || !decrypt) throw new Error("NGW_STRIPE_WEBHOOK_SECRET_WRAPPED_FILE needs NGW_STRIPE_KEY_WRAPPED_FILE and the KMS key (NGW_KMS_KEY_NAME).");
  const unwrap = async (file: string) => (await decrypt(await readFile(file))).toString("utf8").trim();
  return billingConfig({ key: await unwrap(keyFile), webhookSecret: await unwrap(secretFile),
    prices: { PERSONAL: env.NGW_STRIPE_PRICE_PERSONAL?.trim() ?? "", PRO: env.NGW_STRIPE_PRICE_PRO?.trim() ?? "", ULTRA: env.NGW_STRIPE_PRICE_ULTRA?.trim() ?? "" },
    successUrl: env.NGW_CHECKOUT_SUCCESS_URL?.trim() ?? "", cancelUrl: env.NGW_CHECKOUT_CANCEL_URL?.trim() ?? "" });
}

/** `Stripe-Signature: t=<unix>,v1=<hex>[,v1=...]`: an HMAC-SHA256 of `<t>.<raw body>` with the endpoint secret, within 300 s. */
export function verifyStripeSignature(rawBody: Buffer, header: string | undefined, secret: string, nowSeconds: number): boolean {
  const pairs = (header ?? "").split(",").map((part) => [part.slice(0, part.indexOf("=")).trim(), part.slice(part.indexOf("=") + 1).trim()]);
  const t = pairs.find(([name]) => name === "t")?.[1] ?? "";
  if (!/^\d{1,12}$/.test(t) || Math.abs(nowSeconds - Number(t)) > SIGNATURE_TOLERANCE_SECONDS) return false;
  const expected = createHmac("sha256", secret).update(`${t}.`).update(rawBody).digest();
  return pairs.some(([name, value]) => {
    if (name !== "v1" || !/^[0-9a-f]{64}$/.test(value!)) return false;
    return timingSafeEqual(Buffer.from(value!, "hex"), expected);
  });
}

/** The form body of `POST /v1/checkout/sessions`; the tenant rides on the session and on the subscription's metadata. */
export function checkoutBody(config: BillingConfig, input: { tenantId: string; plan: PaidPlan; customerId: string | null }): string {
  const form = new URLSearchParams({ mode: "subscription", client_reference_id: input.tenantId, "line_items[0][price]": config.prices[input.plan],
    "line_items[0][quantity]": "1", success_url: config.successUrl, cancel_url: config.cancelUrl, "automatic_tax[enabled]": "true",
    "subscription_data[metadata][tenant_id]": input.tenantId });
  // Automatic tax needs the known customer's address; Checkout saves the one the customer enters.
  if (input.customerId) { form.set("customer", input.customerId); form.set("customer_update[address]", "auto"); }
  return form.toString();
}

export async function createCheckoutSession(config: BillingConfig, input: Parameters<typeof checkoutBody>[1], send: typeof fetch = fetch): Promise<{ id: string; url: string }> {
  const response = await send("https://api.stripe.com/v1/checkout/sessions", { method: "POST", signal: AbortSignal.timeout(15_000),
    headers: { authorization: `Bearer ${config.key}`, "content-type": "application/x-www-form-urlencoded" }, body: checkoutBody(config, input) });
  const json = await response.json().catch(() => null) as { id?: unknown; url?: unknown; error?: { code?: string } } | null;
  if (!response.ok || typeof json?.id !== "string" || typeof json.url !== "string")
    throw new Error(`Stripe refused the Checkout session (${response.status}${json?.error?.code ? ` ${json.error.code}` : ""}).`);
  return { id: json.id, url: json.url };
}

type Obj = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- Stripe's event objects, read field by field
export interface StripeEvent { id: string; type: string; created: number; data: { object: Obj } }

const tenantOf = (value: unknown) => typeof value === "string" && TENANT_ID.test(value) ? value : null;
const idOf = (value: unknown, prefix: string) => typeof value === "string" && new RegExp(`^${prefix}_[A-Za-z0-9]{1,64}$`).test(value) ? value : null;
const planOf = (config: BillingConfig, price: unknown) => PAID_PLANS.find((plan) => config.prices[plan] === price) ?? null;
const auditRow = (client: pg.PoolClient, tenantId: string, action: string, detail: object) =>
  client.query("INSERT INTO ngw_audit (tenant_id, actor, action, detail) VALUES ($1, $2, $3, $4)", [tenantId, BILLING_ACTOR, action, detail]);

async function linkCustomer(db: pg.Pool, tenantId: string, customer: string, subscription: string | null, eventId: string) {
  await withTenant(db, tenantId, async (client) => {
    await client.query(`INSERT INTO ngw_tenant_billing (tenant_id, stripe_customer_id, stripe_subscription_id) VALUES ($1, $2, $3) ON CONFLICT (tenant_id)
      DO UPDATE SET stripe_customer_id = EXCLUDED.stripe_customer_id, stripe_subscription_id = coalesce(EXCLUDED.stripe_subscription_id, ngw_tenant_billing.stripe_subscription_id),
      updated_at = now()`, [tenantId, customer, subscription]);
    await auditRow(client, tenantId, "billing.customer", { eventId, stripeCustomerId: customer, stripeSubscriptionId: subscription });
  });
}

/** The tenant's keys and whether billing (not a person) froze them last: only those are unfrozen by a paid subscription. */
async function keyState(db: pg.Pool, tenantId: string) {
  return withTenant(db, tenantId, async (client) => {
    const keys = (await client.query("SELECT plan, status FROM ngw_tenant_keys WHERE tenant_id = $1 AND status <> 'REVOKED'", [tenantId])).rows;
    const frozenBy = (await client.query("SELECT actor FROM ngw_audit WHERE tenant_id = $1 AND action = 'key.frozen' ORDER BY id DESC LIMIT 1", [tenantId])).rows[0]?.actor;
    return { plans: new Set(keys.map((row) => row.plan as TenantPlan)), active: keys.some((row) => row.status === "ACTIVE"),
      frozenByBilling: keys.some((row) => row.status === "FROZEN") && frozenBy === BILLING_ACTOR, storedSubscription: (await client.query(
        "SELECT stripe_subscription_id FROM ngw_tenant_billing WHERE tenant_id = $1", [tenantId])).rows[0]?.stripe_subscription_id as string | undefined };
  });
}

async function onSubscription(db: pg.Pool, config: BillingConfig, event: StripeEvent, tenantId: string, now: Date): Promise<string> {
  const sub = event.data.object;
  // Stripe does not order deliveries: an older subscription event than one already handled for the tenant changes nothing.
  if ((await db.query("SELECT 1 FROM ngw_stripe_events WHERE tenant_id = $1 AND type LIKE 'customer.subscription.%' AND created > to_timestamp($2)",
    [tenantId, event.created])).rowCount) return "stale";
  const state = await keyState(db, tenantId);
  if (event.type === "customer.subscription.deleted") {
    if (state.storedSubscription && state.storedSubscription !== sub.id) return "other_subscription"; // an older subscription ended after a new one began
    if (state.active) await setTenantKeyStatus(db, tenantId, "FROZEN", BILLING_ACTOR, "subscription ended");
    // The plan column has no "none": the tenant goes back to the trial pool with no allowance until a new subscription.
    await changeTenantPlan(db, { tenantId, plan: "TRIAL", allowanceMicros: 0, actor: BILLING_ACTOR, now });
    return "ended";
  }
  const customer = idOf(sub.customer, "cus");
  if (customer) await linkCustomer(db, tenantId, customer, idOf(sub.id, "sub"), event.id);
  const plan = planOf(config, sub.items?.data?.[0]?.price?.id);
  if (!plan) return "unknown_price";
  if (sub.status === "past_due" || sub.status === "unpaid") {
    if (state.active) await setTenantKeyStatus(db, tenantId, "FROZEN", BILLING_ACTOR, `subscription ${sub.status}`);
    return "frozen";
  }
  if (sub.status !== "active" && sub.status !== "trialing") return `status_${String(sub.status).replace(/[^a-z_]/g, "")}`; // incomplete: not paid yet
  // A plan change never rotates the key (changeTenantPlan); the current period's allowance follows the plan.
  if (state.plans.size !== 1 || !state.plans.has(plan)) await changeTenantPlan(db, { tenantId, plan, allowanceMicros: PLAN_ALLOWANCE_MICROS[plan], actor: BILLING_ACTOR, now });
  if (state.frozenByBilling) await setTenantKeyStatus(db, tenantId, "ACTIVE", BILLING_ACTOR, "subscription active");
  return `plan_${plan}`;
}

/** A paid subscription invoice (first or renewal) opens its service period with the plan's allowance; an earlier period ends there. */
async function onInvoicePaid(db: pg.Pool, config: BillingConfig, event: StripeEvent, tenantId: string): Promise<string> {
  const invoice = event.data.object;
  if (invoice.billing_reason !== "subscription_create" && invoice.billing_reason !== "subscription_cycle") return "not_a_period";
  // Line shapes: price at `pricing.price_details.price` (API 2025-03-31 and later) or `price.id` (earlier).
  const lines: Obj[] = Array.isArray(invoice.lines?.data) ? invoice.lines.data : [];
  const line = lines.find((item) => planOf(config, item.pricing?.price_details?.price ?? item.price?.id));
  const plan = line && planOf(config, line.pricing?.price_details?.price ?? line.price?.id);
  const start = Number(line?.period?.start) * 1000, end = Number(line?.period?.end) * 1000;
  if (!plan || !Number.isFinite(start) || !(end > start)) return "unknown_price";
  await withTenant(db, tenantId, async (client) => {
    await client.query("UPDATE ngw_tenant_period SET period_end = $2 WHERE tenant_id = $1 AND period_start < $2 AND period_end > $2", [tenantId, new Date(start)]);
    await client.query(`INSERT INTO ngw_tenant_period (tenant_id, period_start, period_end, allowance_micros, day) VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (tenant_id, period_start) DO UPDATE SET period_end = EXCLUDED.period_end, allowance_micros = EXCLUDED.allowance_micros`,
    [tenantId, new Date(start), new Date(end), PLAN_ALLOWANCE_MICROS[plan], new Date(start).toISOString().slice(0, 10)]);
    await auditRow(client, tenantId, "billing.period", { eventId: event.id, plan, start: new Date(start).toISOString(), end: new Date(end).toISOString() });
  });
  return `period_${plan}`;
}

/** One verified event: a replayed id changes nothing; an event that fails is not recorded, so Stripe's retry handles it again. */
export async function handleStripeEvent(db: pg.Pool, config: BillingConfig, event: StripeEvent, now = new Date()): Promise<{ outcome: string }> {
  if ((await db.query("SELECT 1 FROM ngw_stripe_events WHERE event_id = $1", [event.id])).rowCount) return { outcome: "duplicate" };
  const object = event.data.object;
  let tenantId: string | null = null, outcome = "ignored";
  if (event.type === "checkout.session.completed") {
    tenantId = tenantOf(object.client_reference_id);
    const customer = idOf(object.customer, "cus");
    if (tenantId && customer && object.mode === "subscription") { await linkCustomer(db, tenantId, customer, idOf(object.subscription, "sub"), event.id); outcome = "linked"; }
  } else if (event.type.startsWith("customer.subscription.") && ["created", "updated", "deleted"].includes(event.type.slice(22))) {
    tenantId = tenantOf(object.metadata?.tenant_id);
    if (tenantId) outcome = await onSubscription(db, config, event, tenantId, now);
  } else if (event.type === "invoice.paid") {
    tenantId = tenantOf((object.parent?.subscription_details ?? object.subscription_details)?.metadata?.tenant_id);
    if (tenantId) outcome = await onInvoicePaid(db, config, event, tenantId);
  }
  if (outcome === "ignored") tenantId = null;
  await db.query("INSERT INTO ngw_stripe_events (event_id, type, tenant_id, created, outcome) VALUES ($1, $2, $3, to_timestamp($4), $5) ON CONFLICT (event_id) DO NOTHING",
    [event.id, event.type.slice(0, 100), tenantId, event.created, outcome]);
  return { outcome };
}

const eventShape = z.object({ id: z.string().regex(/^evt_[A-Za-z0-9]{1,64}$/), type: z.string().min(1).max(100), created: z.number().int().positive(),
  data: z.object({ object: z.record(z.string(), z.unknown()) }) });

/** `POST /stripe/webhook` on the public listener: the raw body is kept for the signature (Stripe's events are far under 1 MiB). */
export function registerStripeWebhook(app: FastifyInstance, options: { db: pg.Pool; billing: BillingConfig; now?: () => Date }) {
  const now = options.now ?? (() => new Date());
  app.register(async (scope) => {
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser("*", { parseAs: "buffer", bodyLimit: 1024 * 1024 }, (_request, payload, done) => done(null, payload));
    scope.post("/stripe/webhook", async (request, reply) => {
      const raw = request.body;
      const signature = request.headers["stripe-signature"];
      if (!Buffer.isBuffer(raw) || !verifyStripeSignature(raw, typeof signature === "string" ? signature : undefined, options.billing.webhookSecret, Math.floor(now().getTime() / 1000)))
        return reply.code(400).send({ error: { code: "invalid_signature", message: "The Stripe signature is missing, wrong or too old." } });
      let parsed: unknown;
      try { parsed = JSON.parse(raw.toString("utf8")); } catch { parsed = null; }
      const event = eventShape.safeParse(parsed);
      if (!event.success) return reply.code(400).send({ error: { code: "invalid_event", message: "Not a Stripe event." } });
      return { received: true, ...(await handleStripeEvent(options.db, options.billing, event.data as StripeEvent, now())) };
    });
  });
}

const checkoutParams = z.object({ id: z.string().regex(TENANT_ID) });
const checkoutBodySchema = z.object({ plan: z.enum(PAID_PLANS) }).strict();

/** Admin listener (a person or service certificate): `POST /tenants/:id/checkout {plan}` answers the Checkout URL the web shows. */
export function registerCheckoutRoute(app: FastifyInstance, options: { db: pg.Pool; billing: BillingConfig; fetch?: typeof fetch;
  caller(request: FastifyRequest): AdminCaller; audit: AdminAudit }) {
  app.post("/tenants/:id/checkout", async (request, reply) => {
    const params = checkoutParams.safeParse(request.params), body = checkoutBodySchema.safeParse(request.body ?? {});
    if (!params.success || !body.success) return reply.code(400).send({ error: { code: "invalid_request", message: "A tenant id and plan PERSONAL, PRO or ULTRA are required." } });
    const tenantId = params.data.id;
    const customerId = await withTenant(options.db, tenantId, async (client) => (await client.query("SELECT stripe_customer_id FROM ngw_tenant_billing WHERE tenant_id = $1",
      [tenantId])).rows[0]?.stripe_customer_id as string | undefined) ?? null;
    let session: { id: string; url: string };
    try {
      session = await createCheckoutSession(options.billing, { tenantId, plan: body.data.plan, customerId }, options.fetch);
    } catch (error) {
      return reply.code(502).send({ error: { code: "stripe_unavailable", message: error instanceof Error ? error.message : "Stripe did not answer." } });
    }
    await options.audit(tenantId, options.caller(request).actor, "billing.checkout", { plan: body.data.plan, sessionId: session.id });
    return reply.header("cache-control", "no-store").send({ id: session.id, url: session.url });
  });
}
