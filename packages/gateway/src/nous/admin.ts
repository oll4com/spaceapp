import type { TLSSocket } from "node:tls";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import type pg from "pg";
import { z } from "zod";
import { openTenantPeriod } from "./ledger.js";
import { NOUS_TASKS } from "./routing.js";
import { registerSwitchRoutes } from "./switches.js";
import { deleteTenant, deleteTenantRows } from "./tenants.js";
import { changeTenantPlan, issueTenantKey, setTenantKeyStatus, withTenant } from "./tenant-keys.js";

/**
 * The Nous Gateway's admin listener (plan clipboard:_0qBSFCftZuD step 4, K5-admin; install plan §5 "Admin plane"): its own port on the
 * private network, TLS 1.3 with a client certificate from the ngw CA required, no shared token. The certificate names the caller:
 * `OU=person` (an operator's device) or `OU=service` (provisioning, Prometheus); its CN is the actor. Every call is audited in
 * `ngw_audit`. It serves the tenant key, ledger and routing APIs, the status JSON, and forwards the Space Gateway's own admin routes
 * (`/__space-gateway/*`: account sign-in, tests, reload) to the replica with a per-process token that never leaves memory.
 */
export const GLOBAL_AUDIT_TENANT = "*"; // audit rows of calls that name no tenant
export const TENANT_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/; // no ':' (ledger ids are `ngwreq:<tenant>:<uuid>`)

export interface AdminCaller { kind: "person" | "service"; name: string; actor: string }

export interface AdminListenerOptions {
  tls: { cert: string | Buffer; key: string | Buffer; ca: string | Buffer };
  db: pg.Pool;
  /** The replica's own app and the in-memory token its admin routes accept. */
  main: FastifyInstance;
  internalToken: string;
  status: () => unknown;
  /** When the deletion's second pass runs (default 16 min, after the longest stream). */
  secondDeletionPassMs?: number;
  /** Prometheus text for `GET /metrics` (K5-metrics). */
  metrics?: () => Promise<string>;
  /** Further routes (metrics, switches, deletion). */
  routes?: (app: FastifyInstance, helpers: { caller(request: FastifyRequest): AdminCaller; audit: AdminAudit }) => void;
}
export type AdminAudit = (tenantId: string, actor: string, action: string, detail?: object) => Promise<void>;

declare module "fastify" {
  interface FastifyRequest { ngwCaller?: AdminCaller }
}

/** The caller a verified client certificate names, or null. */
export function certificateCaller(socket: Pick<TLSSocket, "getPeerCertificate" | "authorized">): AdminCaller | null {
  if (!socket.authorized) return null;
  const subject = socket.getPeerCertificate()?.subject as Record<string, string | string[]> | undefined;
  const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value)?.trim() ?? "";
  const kind = first(subject?.OU), name = first(subject?.CN);
  if ((kind !== "person" && kind !== "service") || !/^[A-Za-z0-9][A-Za-z0-9_.@-]{0,63}$/.test(name)) return null;
  return { kind, name, actor: `${kind}:${name}` };
}

const tenantParams = z.object({ id: z.string().regex(TENANT_ID) });
const keyBody = z.object({ plan: z.enum(["TRIAL", "PERSONAL", "PRO", "ULTRA"]).optional(), region: z.string().regex(/^[a-z0-9-]{2,16}$/).optional(),
  riskTier: z.enum(["NEW", "TRUSTED"]).optional(), immediate: z.boolean().optional() }).strict();
const statusBody = z.object({ status: z.enum(["ACTIVE", "FROZEN", "REVOKED"]), reason: z.string().trim().min(1).max(500) }).strict();
const planBody = z.object({ plan: z.enum(["TRIAL", "PERSONAL", "PRO", "ULTRA"]), allowanceMicros: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER) }).strict();
const periodBody = z.object({ start: z.iso.datetime(), end: z.iso.datetime(), allowanceMicros: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  topupMicros: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0) }).strict();
const poolBody = z.object({ pool: z.string().regex(/^[a-z0-9-]{2,16}:(paid|trial)$/), fiveHourCapacityMicros: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER) }).strict();
const billingBody = z.object({ stripeCustomerId: z.string().regex(/^cus_[A-Za-z0-9]{1,64}$/) }).strict();
const routeBody = z.object({ models: z.array(z.string().regex(/^[a-z0-9][a-z0-9.-]{1,79}$/)).min(1) }).strict();

export async function startAdminListener(options: AdminListenerOptions, listen: { host: string; port: number }): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, bodyLimit: 1024 * 1024, trustProxy: false,
    https: { cert: options.tls.cert, key: options.tls.key, ca: options.tls.ca, requestCert: true, rejectUnauthorized: true, minVersion: "TLSv1.3" } });
  const audit: AdminAudit = async (tenantId, actor, action, detail = {}) => {
    await withTenant(options.db, tenantId, (client) => client.query("INSERT INTO ngw_audit (tenant_id, actor, action, detail) VALUES ($1, $2, $3, $4)",
      [tenantId, actor, action, detail]));
  };
  const caller = (request: FastifyRequest) => request.ngwCaller!;

  app.addHook("onRequest", async (request, reply) => {
    const found = certificateCaller(request.raw.socket as TLSSocket);
    if (!found) return reply.code(403).send({ error: { code: "forbidden", message: "A person or service certificate from the ngw CA is required." } });
    request.ngwCaller = found;
  });
  // Every call, refused or not, leaves one audit row (method, route, status; never a body).
  app.addHook("onResponse", async (request, reply) => {
    if (!request.ngwCaller || request.routeOptions.url === "/metrics") return; // a scrape every few seconds is not an admin action
    const tenant = (request.params as { id?: string } | undefined)?.id;
    await audit(tenant && TENANT_ID.test(tenant) ? tenant : GLOBAL_AUDIT_TENANT, request.ngwCaller.actor, "admin.call",
      { method: request.method, route: request.routeOptions.url ?? request.url.split("?")[0], status: reply.statusCode })
      .catch((error: unknown) => process.stderr.write(`nous-gateway admin audit failed: ${error instanceof Error ? error.message : "unknown"}\n`));
  });
  const personOnly = async (request: FastifyRequest, reply: FastifyReply) => {
    if (caller(request).kind !== "person") return reply.code(403).send({ error: { code: "person_required", message: "Only a person's certificate may do this." } });
  };
  const parse = <T>(schema: z.ZodType<T>, value: unknown, reply: FastifyReply): T | null => {
    const result = schema.safeParse(value ?? {});
    if (result.success) return result.data;
    void reply.code(400).send({ error: { code: "invalid_request", message: result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ") } });
    return null;
  };

  app.get("/status", async () => options.status());
  if (options.metrics) {
    const metrics = options.metrics;
    app.get("/metrics", async (_request, reply) => reply.type("text/plain; version=0.0.4; charset=utf-8").send(await metrics()));
  }

  // Tenant keys: issued only through here (provisioning, K4); the plaintext is answered once.
  app.post("/tenants/:id/key", async (request, reply) => {
    const params = parse(tenantParams, request.params, reply), body = params && parse(keyBody, request.body, reply);
    if (!params || !body) return reply;
    try {
      const { plainKey, key } = await issueTenantKey(options.db, { tenantId: params.id, actor: caller(request).actor, ...body });
      return reply.code(201).header("cache-control", "no-store").send({ key: plainKey, id: key.id, plan: key.plan, region: key.region, riskTier: key.riskTier,
        rotatedFrom: key.rotatedFrom });
    } catch (error) {
      if (error instanceof Error && /first key needs/.test(error.message)) return reply.code(400).send({ error: { code: "invalid_request", message: error.message } });
      throw error;
    }
  });
  app.post("/tenants/:id/status", async (request, reply) => {
    const params = parse(tenantParams, request.params, reply), body = params && parse(statusBody, request.body, reply);
    if (!params || !body) return reply;
    return { keys: await setTenantKeyStatus(options.db, params.id, body.status, caller(request).actor, body.reason) };
  });
  app.post("/tenants/:id/plan", async (request, reply) => {
    const params = parse(tenantParams, request.params, reply), body = params && parse(planBody, request.body, reply);
    if (!params || !body) return reply;
    await changeTenantPlan(options.db, { tenantId: params.id, ...body, actor: caller(request).actor });
    return { ok: true };
  });
  // The ledger: the plan's monthly AI and prepaid top-ups (the control plane's Stripe webhooks), and its current state.
  app.put("/tenants/:id/period", async (request, reply) => {
    const params = parse(tenantParams, request.params, reply), body = params && parse(periodBody, request.body, reply);
    if (!params || !body) return reply;
    const start = new Date(body.start), end = new Date(body.end);
    if (end <= start) return reply.code(400).send({ error: { code: "invalid_request", message: "end must be after start" } });
    await openTenantPeriod(options.db, { tenantId: params.id, start, end, allowanceMicros: body.allowanceMicros, topupMicros: body.topupMicros });
    await audit(params.id, caller(request).actor, "period.set", body);
    return { ok: true };
  });
  app.get("/tenants/:id/period", async (request, reply) => {
    const params = parse(tenantParams, request.params, reply);
    if (!params) return reply;
    const row = await withTenant(options.db, params.id, async (client) => (await client.query(`SELECT period_start, period_end, allowance_micros::text,
      topup_micros::text, spent_micros::text, reserved_micros::text, day::text, day_spent_micros::text FROM ngw_tenant_period
      WHERE tenant_id = $1 AND period_start <= now() AND period_end > now()`, [params.id])).rows[0]);
    return row ? { tenantId: params.id, ...row } : reply.code(404).send({ error: { code: "no_period", message: "The tenant has no current period." } });
  });

  // The tenant's Stripe customer, for the meter export.
  app.put("/tenants/:id/billing", async (request, reply) => {
    const params = parse(tenantParams, request.params, reply), body = params && parse(billingBody, request.body, reply);
    if (!params || !body) return reply;
    await withTenant(options.db, params.id, (client) => client.query(`INSERT INTO ngw_tenant_billing (tenant_id, stripe_customer_id) VALUES ($1, $2)
      ON CONFLICT (tenant_id) DO UPDATE SET stripe_customer_id = EXCLUDED.stripe_customer_id, updated_at = now()`, [params.id, body.stripeCustomerId]));
    await audit(params.id, caller(request).actor, "billing.customer", body);
    return { ok: true };
  });

  // Account deletion (K4, DPIA): keys revoked at once, the tenant's request data deleted; a second pass after the longest stream.
  app.delete("/tenants/:id", async (request, reply) => {
    const params = parse(tenantParams, request.params, reply);
    if (!params) return reply;
    const result = await deleteTenant(options.db, params.id, caller(request).actor);
    setTimeout(() => void deleteTenantRows(options.db, params.id).catch(() => undefined), options.secondDeletionPassMs ?? 16 * 60_000).unref();
    return result;
  });

  // Which pool each provider account serves, and the task routing lists: a person's decisions, audited.
  app.put("/accounts/:accountId/pool", { preHandler: personOnly }, async (request, reply) => {
    const accountId = (request.params as { accountId: string }).accountId;
    const body = parse(poolBody, request.body, reply);
    if (!body) return reply;
    await options.db.query(`INSERT INTO ngw_account_pools (account_id, pool, five_hour_capacity_micros) VALUES ($1, $2, $3) ON CONFLICT (account_id)
      DO UPDATE SET pool = EXCLUDED.pool, five_hour_capacity_micros = EXCLUDED.five_hour_capacity_micros, updated_at = now()`, [accountId, body.pool, body.fiveHourCapacityMicros]);
    await audit(GLOBAL_AUDIT_TENANT, caller(request).actor, "account.pool", { accountId, ...body });
    return { ok: true };
  });
  app.delete("/accounts/:accountId/pool", { preHandler: personOnly }, async (request) => {
    const accountId = (request.params as { accountId: string }).accountId;
    const removed = (await options.db.query("DELETE FROM ngw_account_pools WHERE account_id = $1", [accountId])).rowCount ?? 0;
    await audit(GLOBAL_AUDIT_TENANT, caller(request).actor, "account.pool_removed", { accountId });
    return { removed };
  });
  app.put("/routes/:task", { preHandler: personOnly }, async (request, reply) => {
    const task = (request.params as { task: string }).task;
    if (!(NOUS_TASKS as readonly string[]).includes(task)) return reply.code(404).send({ error: { code: "unknown_task", message: `No task '${task}'.` } });
    const body = parse(routeBody, request.body, reply);
    if (!body) return reply;
    await options.db.query(`INSERT INTO ngw_task_routes (task, models, set_by) VALUES ($1, $2, $3) ON CONFLICT (task)
      DO UPDATE SET models = EXCLUDED.models, set_by = EXCLUDED.set_by, set_at = now()`, [task, body.models, caller(request).actor]);
    await audit(GLOBAL_AUDIT_TENANT, caller(request).actor, "route.set", { task, models: body.models });
    return { ok: true };
  });

  // The Space Gateway's own admin routes (accounts, sign-in flows, tests, reload), for people only.
  app.all("/__space-gateway/*", { preHandler: personOnly }, async (request, reply) => {
    const headers = { ...request.headers };
    for (const name of ["x-space-internal-token", "host", "content-length"]) delete headers[name];
    const forwarded = await options.main.inject({ method: request.method as "GET", url: request.url, headers: { ...headers, "x-space-internal-token": options.internalToken },
      ...(request.body === undefined ? {} : { payload: request.body as object }) });
    return reply.code(forwarded.statusCode).header("content-type", String(forwarded.headers["content-type"] ?? "application/json")).send(forwarded.body);
  });

  registerSwitchRoutes(app, { db: options.db, caller, audit, personOnly });
  options.routes?.(app, { caller, audit });
  await app.listen({ host: listen.host, port: listen.port });
  return app;
}
