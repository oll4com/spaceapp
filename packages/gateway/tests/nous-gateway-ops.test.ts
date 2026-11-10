import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { disposablePostgresUnavailableReason, startDisposablePostgres, type DisposablePostgres } from "../../db/tests/support/disposable-postgres.js";
import { migrateNgw } from "../src/nous/migrate.js";
import { createOpsJobs, daysToExport, runOps } from "../src/nous/ops.js";
import { createStripeMeterSender } from "../src/nous/stripe-export.js";

// K5-ops: the singleton's schedule and its advisory lock, on a disposable PostgreSQL as ngw_ops would run it.
const unavailable = disposablePostgresUnavailableReason();

describe.skipIf(unavailable)("Nous Gateway ops singleton", () => {
  let server: DisposablePostgres;
  let ops: pg.Pool;
  let url = "";
  beforeAll(async () => {
    server = await startDisposablePostgres("ngw-ops");
    await server.createDatabase("ngw_ops");
    ops = server.pool("ngw_ops", 4);
    await migrateNgw(ops);
    url = `postgresql://postgres@/ngw_ops?host=${encodeURIComponent(server.socketDir)}`;
  }, 120_000);
  afterAll(async () => { await server?.stop(); }, 60_000);

  it("runs the sweeps every tick, the partitions once a day, and the export once after its hour for every day since the last exported one", async () => {
    const usage = (day: string) => ops.query("INSERT INTO ngw_usage_daily VALUES ('t-1', $1, 'acc', 'claude-sonnet-5-5', 1, 10, 10, 500000)", [day]);
    for (const day of ["2026-10-27", "2026-10-31", "2026-11-02", "2026-11-03"]) await usage(day);
    await ops.query(`INSERT INTO ngw_meter_exports (tenant_id, day, identifier, credits, cost_micros, status, stripe_event_id)
      VALUES ('t-1', '2026-10-29', 'ngw:t-1:2026-10-29', 50, 500000, 'SENT', 'evt_old')`);
    expect(await daysToExport(ops, new Date("2026-11-03T02:00:00Z"))).toEqual(["2026-10-31", "2026-11-02"]); // 10-27 was before the last export

    let at = new Date("2026-11-03T01:59:00Z");
    const lines: Record<string, unknown>[] = [];
    const jobs = createOpsJobs(ops, { now: () => at, log: (line) => lines.push(line) });
    await jobs.tick();
    await jobs.tick();
    expect(lines.map((line) => line.job)).toEqual(["reservation_sweep", "key_retirement", "partitions", "reservation_sweep", "key_retirement"]);
    expect(lines[2]!.changes).toEqual([]); // the migration made this month and the next two already
    lines.length = 0;
    at = new Date("2026-11-03T02:00:00Z");
    await jobs.tick();
    await jobs.tick();
    expect(lines.filter((line) => line.job === "meter_export")).toEqual([expect.objectContaining({ days: {
      "2026-10-31": { pending: 0, noCustomer: 1 }, "2026-11-02": { pending: 0, noCustomer: 1 } } })]);
    expect((await ops.query("SELECT to_char(day, 'YYYY-MM-DD') AS day, status FROM ngw_meter_exports ORDER BY day")).rows.map((row) => `${row.day} ${row.status}`))
      .toEqual(["2026-10-29 SENT", "2026-10-31 NO_CUSTOMER", "2026-11-02 NO_CUSTOMER"]);
    expect(() => createOpsJobs(ops, { exportAt: "2am" })).toThrow(/HH:MM/);
  });

  it("lets one copy hold the lock; a second waits and takes over when the first stops", async () => {
    const run = (name: string) => {
      const controller = new AbortController();
      const states: string[] = [];
      const done = runOps({ connectionString: url, signal: controller.signal, tickMs: 20, lockRetryMs: 20, now: () => new Date("2026-11-03T01:00:00Z"),
        log: (line) => { if (line.state) states.push(String(line.state)); } });
      return { name, states, done, stop: () => controller.abort() };
    };
    const until = async (check: () => boolean) => { for (let i = 0; i < 250 && !check(); i += 1) await new Promise((resolve) => setTimeout(resolve, 20)); };
    const first = run("first");
    await until(() => first.states.includes("holding the ops lock"));
    const second = run("second");
    await until(() => second.states.length > 0);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(second.states).toEqual(["waiting for the ops lock"]);
    first.stop();
    await first.done;
    await until(() => second.states.includes("holding the ops lock"));
    expect(second.states).toEqual(["waiting for the ops lock", "holding the ops lock"]);
    second.stop();
    await second.done;
  });

  it("sends nothing without NGW_MODE=nous and a key; sends PENDING events once with their identifier as the idempotency key, never past its window", async () => {
    expect(createStripeMeterSender({ mode: undefined, key: "rk_test_abc" })).toBeNull();
    expect(createStripeMeterSender({ mode: "nous", key: null })).toBeNull();
    expect(() => createStripeMeterSender({ mode: "nous", key: "pk_test_abc" })).toThrow(/restricted/);
    const day = "2026-11-01";
    await ops.query("DELETE FROM ngw_meter_exports");
    await ops.query(`INSERT INTO ngw_meter_exports (tenant_id, day, identifier, credits, cost_micros, stripe_customer_id, status, send_started_at) VALUES
      ('t-a', $1, 'ngw:t-a:${day}', 12, 120000, 'cus_A', 'PENDING', NULL), ('t-b', $1, 'ngw:t-b:${day}', 7, 70000, 'cus_B', 'PENDING', NULL),
      ('t-c', $1, 'ngw:t-c:${day}', 3, 30000, 'cus_C', 'PENDING', now() - interval '30 hours'), ('t-d', $1, 'ngw:t-d:${day}', 3, 30000, NULL, 'NO_CUSTOMER', NULL)`, [day]);
    const calls: { key: string | null; auth: string | null; body: URLSearchParams }[] = [];
    const answers = [500, 200, 400];
    const fetchStub = (async (_url: string, init: RequestInit) => {
      const headers = new Headers(init.headers);
      calls.push({ key: headers.get("idempotency-key"), auth: headers.get("authorization"), body: new URLSearchParams(String(init.body)) });
      const status = answers.shift() ?? 200;
      return new Response(JSON.stringify(status === 200 ? { object: "billing.meter_event" } : { error: { code: "resource_missing" } }),
        { status, headers: { "request-id": `req_${calls.length}` } });
    }) as typeof fetch;
    const send = createStripeMeterSender({ mode: "nous", key: "rk_test_abc", fetch: fetchStub })!;
    const lines: Record<string, unknown>[] = [];
    const jobs = createOpsJobs(ops, { now: () => new Date("2026-11-03T01:00:00Z"), log: (line) => lines.push(line), sendMeterEvents: send });
    await jobs.tick(); // 500: the round stops after t-a
    await jobs.tick(); // t-a again (same key and body) 200, t-b 400
    await jobs.tick(); // nothing left to try: no line
    expect(calls.map((call) => call.key)).toEqual([`ngw:t-a:${day}`, `ngw:t-a:${day}`, `ngw:t-b:${day}`]);
    expect(calls[0]!.auth).toBe("Bearer rk_test_abc");
    expect(Object.fromEntries(calls[1]!.body)).toMatchObject({ event_name: "nous_ai_credits", "payload[stripe_customer_id]": "cus_A", "payload[value]": "12" });
    expect(lines.filter((line) => line.job === "stripe_send")).toEqual([
      expect.objectContaining({ sent: 0, stopped: "HTTP 500", level: "warn" }),
      expect.objectContaining({ sent: 1, failed: [{ identifier: `ngw:t-b:${day}`, status: 400, code: "resource_missing" }] })]);
    expect((await ops.query("SELECT tenant_id, status, stripe_event_id, send_error FROM ngw_meter_exports ORDER BY tenant_id")).rows).toEqual([
      { tenant_id: "t-a", status: "SENT", stripe_event_id: "req_2", send_error: null },
      { tenant_id: "t-b", status: "PENDING", stripe_event_id: null, send_error: "HTTP 400 resource_missing" },
      { tenant_id: "t-c", status: "PENDING", stripe_event_id: null, send_error: null }, { tenant_id: "t-d", status: "NO_CUSTOMER", stripe_event_id: null, send_error: null }]);
  });
});
