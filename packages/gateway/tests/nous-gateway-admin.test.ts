import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { request as httpsRequest } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { disposablePostgresUnavailableReason, startDisposablePostgres, type DisposablePostgres } from "../../db/tests/support/disposable-postgres.js";
import { startAdminListener } from "../src/nous/admin.js";
import { migrateNgw } from "../src/nous/migrate.js";
import { ngwAppGrantsSql } from "../src/nous/schema.js";
import { exportMeterDay } from "../src/nous/stripe-export.js";

// K5-admin: the mTLS admin listener with a throwaway CA (openssl), on a disposable PostgreSQL as the request-path role.
const unavailable = disposablePostgresUnavailableReason();

/** A test CA, the listener's certificate and client certificates; one client from another CA. */
export function testPki() {
  const dir = mkdtempSync(join(tmpdir(), "ngw-pki-"));
  const at = (name: string) => join(dir, name);
  const ssl = (...args: string[]) => execFileSync("openssl", args, { stdio: "pipe" });
  const ec = ["-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes"];
  for (const ca of ["ca", "rogue-ca"]) ssl("req", "-x509", ...ec, "-keyout", at(`${ca}.key`), "-out", at(`${ca}.crt`), "-subj", `/CN=${ca}`, "-days", "1");
  writeFileSync(at("san.ext"), "subjectAltName=IP:127.0.0.1\n");
  const issue = (name: string, subject: string, ca = "ca") => {
    ssl("req", ...ec, "-keyout", at(`${name}.key`), "-out", at(`${name}.csr`), "-subj", subject);
    ssl("x509", "-req", "-in", at(`${name}.csr`), "-CA", at(`${ca}.crt`), "-CAkey", at(`${ca}.key`), "-CAcreateserial", "-out", at(`${name}.crt`), "-days", "1",
      ...(name === "server" ? ["-extfile", at("san.ext")] : []));
    return { cert: readFileSync(at(`${name}.crt`)), key: readFileSync(at(`${name}.key`)) };
  };
  return { ca: readFileSync(at("ca.crt")), server: issue("server", "/CN=ngw-gateway-admin"), alice: issue("alice", "/OU=person/CN=alice"), bob: issue("bob", "/OU=person/CN=bob"),
    k4: issue("k4", "/OU=service/CN=k4"), rogue: issue("rogue", "/OU=person/CN=mallory", "rogue-ca") };
}

type Json = Record<string, unknown>;

export function callAdmin(port: number, ca: Buffer, who: { cert: Buffer; key: Buffer } | null, method: string, path: string, body?: unknown) {
  return new Promise<{ status: number; json: Json; text?: string }>((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = httpsRequest({ host: "127.0.0.1", port, method, path, ca, ...(who ?? {}), headers: payload ? { "content-type": "application/json" } : {} }, (res) => {
      let text = "";
      res.on("data", (chunk) => { text += chunk; });
      res.on("end", () => {
        try { resolve({ status: res.statusCode ?? 0, json: text ? JSON.parse(text) : null }); } catch { resolve({ status: res.statusCode ?? 0, json: null as never, text }); }
      });
    });
    req.on("error", reject);
    req.end(payload);
  });
}

describe.skipIf(unavailable)("Nous Gateway admin listener (mTLS)", () => {
  let server: DisposablePostgres;
  let ops: pg.Pool, app: pg.Pool;
  let admin: FastifyInstance, main: FastifyInstance;
  let pki: ReturnType<typeof testPki>;
  let port = 0;
  const call = (who: { cert: Buffer; key: Buffer } | null, method: string, path: string, body?: unknown) => callAdmin(port, pki.ca, who, method, path, body);

  beforeAll(async () => {
    pki = testPki();
    server = await startDisposablePostgres("ngw-admin");
    await server.createDatabase("ngw_admin");
    ops = server.pool("ngw_admin", 4);
    await migrateNgw(ops); // the gateway's own migration set, as an installation runs it
    await ops.query("CREATE ROLE ngw_app LOGIN");
    await ops.query(ngwAppGrantsSql("ngw_app"));
    await ops.query("GRANT SELECT, INSERT, UPDATE, DELETE ON space_gateway_request_logs TO ngw_app"); // as grants.sql does
    app = new pg.Pool({ host: server.socketDir, user: "ngw_app", database: "ngw_admin", max: 5 });
    main = Fastify();
    main.get("/__space-gateway/admin/ping", async (request, reply) => request.headers["x-space-internal-token"] === "in-memory-token" ? { ok: true }
      : reply.code(403).send({ error: "forbidden" }));
    admin = await startAdminListener({ tls: { ...pki.server, ca: pki.ca }, db: app, main, internalToken: "in-memory-token", status: () => ({ version: "test" }), secondDeletionPassMs: 300,
      metrics: async () => "ngw_open_requests 0\n" },
      { host: "127.0.0.1", port: 0 });
    port = (admin.server.address() as { port: number }).port;
  }, 120_000);

  afterAll(async () => {
    await admin?.close();
    await app?.end();
    await server?.stop();
  }, 60_000);

  it("requires a certificate of the ngw CA naming a person or a service", async () => {
    await expect(call(null, "GET", "/status")).rejects.toThrow();
    await expect(call(pki.rogue, "GET", "/status")).rejects.toThrow();
    expect(await call(pki.alice, "GET", "/status")).toEqual({ status: 200, json: { version: "test" } });
    expect(await call(pki.k4, "GET", "/metrics")).toEqual({ status: 200, json: null, text: "ngw_open_requests 0\n" });
    expect((await ops.query("SELECT count(*)::int AS n FROM ngw_audit WHERE detail->>'route' = '/metrics'")).rows[0].n).toBe(0);
  });

  it("issues tenant keys and opens periods for provisioning, keeps pools and routes for people, forwards the gateway's admin routes, audits every call", async () => {
    const issued = await call(pki.k4, "POST", "/tenants/t-1/key", { plan: "PERSONAL", region: "eu1", riskTier: "TRUSTED" });
    expect(issued.status).toBe(201);
    expect(issued.json.key).toMatch(/^sk-ngw-/);
    expect((await call(pki.k4, "POST", "/tenants/bad:id/key", { plan: "PERSONAL", region: "eu1", riskTier: "TRUSTED" })).status).toBe(400);
    expect((await call(pki.k4, "POST", "/tenants/t-2/key", {})).status).toBe(400);
    const start = new Date(Date.now() - 86_400_000).toISOString(), end = new Date(Date.now() + 29 * 86_400_000).toISOString();
    expect((await call(pki.k4, "PUT", "/tenants/t-1/period", { start, end, allowanceMicros: 5_000_000 })).status).toBe(200);
    expect((await call(pki.k4, "GET", "/tenants/t-1/period")).json).toMatchObject({ tenantId: "t-1", allowance_micros: "5000000", spent_micros: "0" });
    expect((await call(pki.k4, "POST", "/tenants/t-1/status", { status: "FROZEN", reason: "chargeback" })).json).toEqual({ keys: 1 });

    expect((await call(pki.k4, "PUT", "/accounts/acc-1/pool", { pool: "eu1:paid", fiveHourCapacityMicros: 400_000_000 })).status).toBe(403);
    expect((await call(pki.alice, "PUT", "/accounts/acc-1/pool", { pool: "eu1:paid", fiveHourCapacityMicros: 400_000_000 })).status).toBe(200);
    expect((await ops.query("SELECT pool FROM ngw_account_pools WHERE account_id = 'acc-1'")).rows).toEqual([{ pool: "eu1:paid" }]);
    expect((await call(pki.alice, "PUT", "/routes/think", { models: ["claude-haiku-5-5"] })).status).toBe(404);
    expect((await call(pki.alice, "PUT", "/routes/code", { models: ["claude-sonnet-5-5"] })).status).toBe(200);

    expect(await call(pki.alice, "GET", "/__space-gateway/admin/ping")).toEqual({ status: 200, json: { ok: true } });
    expect((await call(pki.k4, "GET", "/__space-gateway/admin/ping")).status).toBe(403);

    await new Promise((resolve) => setTimeout(resolve, 100));
    const audit = (await ops.query("SELECT tenant_id, actor, action, detail FROM ngw_audit ORDER BY id")).rows;
    expect(audit.filter((row) => row.action === "admin.call").length).toBeGreaterThanOrEqual(13);
    expect(audit).toEqual(expect.arrayContaining([
      expect.objectContaining({ tenant_id: "t-1", actor: "service:k4", action: "key.issue" }),
      expect.objectContaining({ tenant_id: "t-1", actor: "service:k4", action: "key.frozen" }),
      expect.objectContaining({ tenant_id: "*", actor: "person:alice", action: "account.pool" }),
      expect.objectContaining({ tenant_id: "*", actor: "person:alice", action: "route.set" }),
      expect.objectContaining({ tenant_id: "*", actor: "service:k4", action: "admin.call", detail: expect.objectContaining({ status: 403 }) })
    ]));
    expect(JSON.stringify(audit)).not.toContain(issued.json.key);
  });

  it("turns a scoped switch at once for a person, holds a global one for a second person, never for a service", async () => {
    expect((await call(pki.k4, "PUT", "/switches/model_off", { scope: "claude-opus-5-5", value: true, reason: "pool pressed" })).status).toBe(403);
    expect((await call(pki.alice, "PUT", "/switches/model_off", { scope: "claude-opus-5-5", value: true, reason: "pool pressed" })).status).toBe(200);
    expect((await call(pki.alice, "PUT", "/switches/provider_off", { scope: "DEEPSEEK", value: true, reason: "x" })).status).toBe(400);
    expect((await call(pki.alice, "PUT", "/switches/everything_off", { scope: "*", value: true, reason: "x" })).status).toBe(404);
    const pending = await call(pki.alice, "PUT", "/switches/all_included_ai_off", { scope: "*", value: true, reason: "provider outage" });
    expect(pending.status).toBe(202);
    expect((await call(pki.alice, "POST", `/switches/requests/${pending.json.pending}/approve`)).status).toBe(409); // not the same person
    let listed = (await call(pki.k4, "GET", "/switches")).json;
    expect(listed.switches).toEqual([expect.objectContaining({ name: "model_off", scope: "claude-opus-5-5", value: true, set_by: "person:alice" })]);
    expect(listed.pending).toHaveLength(1);
    expect((await call(pki.bob, "POST", `/switches/requests/${pending.json.pending}/approve`)).status).toBe(200);
    listed = (await call(pki.k4, "GET", "/switches")).json;
    expect(listed.switches).toEqual(expect.arrayContaining([expect.objectContaining({ name: "all_included_ai_off", scope: "*", value: true, set_by: "person:alice+person:bob" })]));
    expect(listed.pending).toEqual([]);
    expect((await call(pki.bob, "POST", `/switches/requests/${pending.json.pending}/approve`)).status).toBe(409); // once
  });

  it("deletes a tenant: keys revoked then gone, its request logs, usage rows and reservations deleted, billing sums and the audit kept", async () => {
    const uuid = "0f0e0d0c-0b0a-4908-8706-050403020100";
    for (const tenant of ["t-del", "t-del-2"]) {
      await call(pki.k4, "POST", `/tenants/${tenant}/key`, { plan: "PRO", region: "eu1", riskTier: "TRUSTED" });
      await call(pki.k4, "PUT", `/tenants/${tenant}/period`, { start: new Date(Date.now() - 86_400_000).toISOString(),
        end: new Date(Date.now() + 86_400_000).toISOString(), allowanceMicros: 1_000_000 });
      await ops.query("INSERT INTO space_gateway_request_logs (request_id, provider, model, status) VALUES ($1, 'CLAUDE', 'claude-sonnet-5-5', 'success')",
        [`ngwreq:${tenant}:${uuid}`]);
      await ops.query(`INSERT INTO ngw_usage (request_id, tenant_id, key_id, pool, provider, model, traffic_class, status, cost_micros)
        VALUES ($1, $2, 'k', 'eu1:paid:claude', 'claude', 'claude-sonnet-5-5', 'FOREGROUND', 'OK', 5)`, [`ngwreq:${tenant}:${uuid}`, tenant]);
      await ops.query("INSERT INTO ngw_usage_daily VALUES ($1, current_date, 'acc', 'claude-sonnet-5-5', 1, 10, 10, 5)", [tenant]);
    }
    const deleted = await call(pki.k4, "DELETE", "/tenants/t-del");
    expect(deleted.json).toEqual({ revoked: 1, requestLogs: 1, usage: 1, inflight: 0, keys: 1 });
    // A stream that was still running logs after the first pass; the second pass removes it.
    await ops.query("INSERT INTO space_gateway_request_logs (request_id, provider, model, status) VALUES ($1, 'CLAUDE', 'claude-sonnet-5-5', 'success')",
      ["ngwreq:t-del:1f0e0d0c-0b0a-4908-8706-050403020100"]);
    await new Promise((resolve) => setTimeout(resolve, 600));
    const left = async (sql: string, tenant: string) => (await ops.query(sql, [tenant])).rowCount;
    expect(await left("SELECT 1 FROM space_gateway_request_logs WHERE request_id LIKE $1 || ':%'", "ngwreq:t-del")).toBe(0);
    expect(await left("SELECT 1 FROM space_gateway_request_logs WHERE request_id LIKE $1 || ':%'", "ngwreq:t-del-2")).toBe(1);
    for (const table of ["ngw_tenant_keys", "ngw_usage"]) expect(await left(`SELECT 1 FROM ${table} WHERE tenant_id = $1`, "t-del")).toBe(0);
    for (const table of ["ngw_tenant_period", "ngw_usage_daily"]) expect(await left(`SELECT 1 FROM ${table} WHERE tenant_id = $1`, "t-del")).toBe(1);
    expect(await left("SELECT 1 FROM ngw_tenant_keys WHERE tenant_id = $1", "t-del-2")).toBe(1);
    expect((await ops.query("SELECT detail FROM ngw_audit WHERE tenant_id = 't-del' AND action = 'tenant.delete'")).rows).toHaveLength(1);
    // Append-only for every role, the owner included.
    await expect(ops.query("DELETE FROM ngw_audit WHERE tenant_id = 't-del'")).rejects.toThrow(/append-only/);
    await expect(ops.query("UPDATE ngw_audit SET actor = 'x'")).rejects.toThrow(/append-only/);
    await expect(app.query("DELETE FROM ngw_audit")).rejects.toThrow();
  });

  it("exports one Stripe meter event per tenant and day, recorded first, never re-sending or silently changing a sent day (no Stripe call)", async () => {
    const day = "2026-11-02";
    expect((await call(pki.k4, "PUT", "/tenants/t-bill/billing", { stripeCustomerId: "cus_Test123" })).status).toBe(200);
    expect((await call(pki.k4, "PUT", "/tenants/t-bill/billing", { stripeCustomerId: "acct_x" })).status).toBe(400);
    for (const [tenant, micros] of [["t-bill", 1_234_567], ["t-nocust", 50_000], ["t-zero", 4_000]] as const) {
      await ops.query("INSERT INTO ngw_usage_daily VALUES ($1, $2, 'acc', 'claude-sonnet-5-5', 1, 10, 10, $3)", [tenant, day, micros]);
    }
    const first = await exportMeterDay(ops, day);
    expect(first.map(({ tenantId, credits, status }) => ({ tenantId, credits, status }))).toEqual([
      { tenantId: "t-bill", credits: 123, status: "PENDING" }, { tenantId: "t-nocust", credits: 5, status: "NO_CUSTOMER" }]);
    expect(Object.fromEntries(new URLSearchParams(first[0]!.body!))).toEqual({ event_name: "nous_ai_credits", identifier: `ngw:t-bill:${day}`,
      timestamp: String(Date.parse(`${day}T23:59:59Z`) / 1000), "payload[stripe_customer_id]": "cus_Test123", "payload[value]": "123" });
    expect(first[1]!.body).toBeNull();
    expect(await exportMeterDay(ops, day)).toEqual(first); // a re-run is the same export
    await ops.query("UPDATE ngw_meter_exports SET status = 'SENT', stripe_event_id = 'evt_1' WHERE tenant_id = 't-bill'");
    await ops.query("UPDATE ngw_usage_daily SET cost_micros = 2_000_000 WHERE tenant_id = 't-bill' AND day = $1", [day]);
    const after = await exportMeterDay(ops, day);
    expect(after[0]).toMatchObject({ tenantId: "t-bill", credits: 200, status: "SENT", body: null, differsFromSent: true });
    expect((await ops.query("SELECT credits::int, status FROM ngw_meter_exports WHERE tenant_id = 't-bill'")).rows).toEqual([{ credits: 123, status: "SENT" }]);
    await expect(exportMeterDay(ops, "2026-13-01")).rejects.toThrow(/yyyy-mm-dd/);
  });
});

