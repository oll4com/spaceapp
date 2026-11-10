import process from "node:process";
import { pathToFileURL } from "node:url";
import pg from "pg";
import { meterEventsForDay } from "./ledger.js";

/**
 * The nightly usage export to Stripe (plan clipboard:_0qBSFCftZuD step 4, K5-stripe export; install plan §3.5): one meter event per
 * tenant and UTC day from `ngw_usage_daily`, its `identifier` `ngw:<tenant>:<day>` being Stripe's dedup key, recorded in
 * `ngw_meter_exports` before anything is sent. This slice only exports: it writes the rows and the request bodies for Stripe's
 * `POST /v1/billing/meter_events` and never calls Stripe. The ledger is the hard cap; Stripe is the commercial record only.
 * Runs as ngw_ops (BYPASSRLS): `SPACE_DATABASE_URL=<ngw_ops URL> node packages/gateway/dist/nous/stripe-export.js <yyyy-mm-dd> > events.jsonl`.
 * The sender (`createStripeMeterSender`) runs inside ngw-ops only.
 * shortcut: no automatic reconciliation against Stripe's meter summaries; a sent day whose sum changed and a row past the idempotency
 * window are logged for a person (plan §8).
 */
export const METER_EVENT_NAME = "nous_ai_credits";

export interface MeterExport {
  tenantId: string; day: string; identifier: string; credits: number; costMicros: number; stripeCustomerId: string | null;
  status: "PENDING" | "SENT" | "NO_CUSTOMER";
  /** Stripe's form body, or null when the tenant has no Stripe customer yet. */
  body: string | null;
  /** A row already sent with other credits: never corrected automatically (plan §8 "Stripe export failed, or a reconciliation difference"). */
  differsFromSent: boolean;
}

/** The form body of one meter event, stamped at the day's last second so it lands in that day's billing period. */
export function meterEventBody(event: { identifier: string; day: string; credits: number; stripeCustomerId: string }): string {
  return new URLSearchParams({ event_name: METER_EVENT_NAME, identifier: event.identifier, timestamp: String(Date.parse(`${event.day}T23:59:59Z`) / 1000),
    "payload[stripe_customer_id]": event.stripeCustomerId, "payload[value]": String(event.credits) }).toString();
}

/** Records the day's events (a re-run updates only rows not sent yet) and answers what to send. Tenants with no credits get none. */
export async function exportMeterDay(ops: pg.Pool, day: string): Promise<MeterExport[]> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || Number.isNaN(Date.parse(`${day}T00:00:00Z`))) throw new Error("day must be yyyy-mm-dd");
  const customers = new Map((await ops.query("SELECT tenant_id, stripe_customer_id FROM ngw_tenant_billing")).rows
    .map((row) => [row.tenant_id as string, row.stripe_customer_id as string]));
  const exports: MeterExport[] = [];
  for (const event of (await meterEventsForDay(ops, day)).filter((item) => item.credits > 0)) {
    const stripeCustomerId = customers.get(event.tenantId) ?? null;
    const row = (await ops.query(`INSERT INTO ngw_meter_exports (tenant_id, day, identifier, credits, cost_micros, stripe_customer_id, status)
      VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (tenant_id, day) DO UPDATE SET credits = EXCLUDED.credits, cost_micros = EXCLUDED.cost_micros,
        stripe_customer_id = EXCLUDED.stripe_customer_id, status = EXCLUDED.status, send_error = NULL, updated_at = now() WHERE ngw_meter_exports.status <> 'SENT'
      RETURNING status`, [event.tenantId, day, event.identifier, event.credits, event.costMicros, stripeCustomerId,
      stripeCustomerId ? "PENDING" : "NO_CUSTOMER"])).rows[0];
    const sent = row ? null : (await ops.query("SELECT credits FROM ngw_meter_exports WHERE tenant_id = $1 AND day = $2", [event.tenantId, day])).rows[0];
    exports.push({ ...event, stripeCustomerId, status: sent ? "SENT" : row.status,
      body: !sent && stripeCustomerId ? meterEventBody({ ...event, stripeCustomerId }) : null, differsFromSent: sent ? Number(sent.credits) !== event.credits : false });
  }
  return exports;
}

/** Stripe keeps an idempotency key 24 h; a row first tried longer ago than this is never re-sent automatically (it may have counted). */
export const STRIPE_RESEND_WINDOW_HOURS = 23;
const STRIPE_KEY = /^(rk|sk)_(live|test)_[A-Za-z0-9]+$/;

/**
 * Sends the PENDING meter events to Stripe (`POST /v1/billing/meter_events`), each with its identifier as the Idempotency-Key, and marks
 * them SENT with Stripe's request id. Null, so nothing is ever sent, unless NGW_MODE=nous and a Stripe key is configured. A row's first
 * try is recorded before the call; a 429, 5xx or network error stops this round (the next ops tick, a minute later, tries again with the
 * same key and body); another 4xx leaves the row PENDING with `send_error` (listed in the daily export's log) until an export re-run of its day or a person
 * clears it; 401/403 stop the round.
 */
export function createStripeMeterSender(options: { mode: string | undefined; key: string | null; fetch?: typeof fetch; now?: () => Date }) {
  if (options.mode !== "nous" || !options.key) return null;
  if (!STRIPE_KEY.test(options.key)) throw new Error("The Stripe key must be a restricted (rk_) or secret (sk_) live or test key.");
  const key = options.key, send = options.fetch ?? fetch, now = options.now ?? (() => new Date());
  return async function sendPending(ops: pg.Pool) {
    const at = now();
    const rows = (await ops.query(`SELECT tenant_id, to_char(day, 'YYYY-MM-DD') AS day, identifier, credits, stripe_customer_id FROM ngw_meter_exports
      WHERE status = 'PENDING' AND stripe_customer_id IS NOT NULL AND send_error IS NULL AND (send_started_at IS NULL OR send_started_at > $1::timestamptz - make_interval(hours => $2))
      ORDER BY day, tenant_id`, [at, STRIPE_RESEND_WINDOW_HOURS])).rows;
    const result = { sent: 0, failed: [] as { identifier: string; status: number; code: string | null }[], stopped: null as string | null };
    for (const row of rows) {
      await ops.query("UPDATE ngw_meter_exports SET send_started_at = coalesce(send_started_at, $3) WHERE tenant_id = $1 AND day = $2", [row.tenant_id, row.day, at]);
      let response: Response;
      try {
        response = await send("https://api.stripe.com/v1/billing/meter_events", { method: "POST", signal: AbortSignal.timeout(15_000),
          headers: { authorization: `Bearer ${key}`, "content-type": "application/x-www-form-urlencoded", "idempotency-key": row.identifier },
          body: meterEventBody({ identifier: row.identifier, day: row.day, credits: Number(row.credits), stripeCustomerId: row.stripe_customer_id }) });
      } catch (error) {
        result.stopped = `network: ${error instanceof Error ? error.message : "unknown"}`;
        break;
      }
      if (response.ok) {
        await ops.query("UPDATE ngw_meter_exports SET status = 'SENT', stripe_event_id = $3, updated_at = now() WHERE tenant_id = $1 AND day = $2",
          [row.tenant_id, row.day, response.headers.get("request-id")]);
        result.sent += 1;
        continue;
      }
      const code = await response.json().then((body: { error?: { code?: string } }) => body.error?.code ?? null, () => null);
      if (response.status === 429 || response.status >= 500 || response.status === 401 || response.status === 403) {
        result.stopped = `HTTP ${response.status}`;
        break;
      }
      await ops.query("UPDATE ngw_meter_exports SET send_error = $3 WHERE tenant_id = $1 AND day = $2", [row.tenant_id, row.day, `HTTP ${response.status} ${code ?? ""}`.trim()]);
      result.failed.push({ identifier: row.identifier, status: response.status, code });
    }
    return result;
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const url = process.env.SPACE_DATABASE_URL;
  const day = process.argv[2] ?? new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  if (!url) throw new Error("SPACE_DATABASE_URL (the ngw_ops connection) is required.");
  const ops = new pg.Pool({ connectionString: url, max: 1 });
  try {
    for (const item of await exportMeterDay(ops, day)) process.stdout.write(`${JSON.stringify(item)}\n`);
  } finally {
    await ops.end();
  }
}
