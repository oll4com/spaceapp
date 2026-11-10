import { readFile } from "node:fs/promises";
import process from "node:process";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import pg from "pg";
import { sweepExpiredReservations } from "./ledger.js";
import { gcpKmsDecrypter } from "./kms.js";
import { createStripeMeterSender, exportMeterDay, STRIPE_RESEND_WINDOW_HOURS } from "./stripe-export.js";
import { retireOverlappedKeys } from "./tenant-keys.js";

/**
 * ngw-ops, the Nous Gateway's singleton jobs (plan clipboard:_0qBSFCftZuD step 4, K5-ops; install plan §2, §6 item 9): one process holds
 * the advisory lock and runs them, a second copy waits for it. Every minute the reservation sweep and the overlapped-key retirement; once
 * a UTC day the request-log partitions (ngw_0002) and, after `NGW_STRIPE_EXPORT_AT` (02:00 UTC), the meter export of every day with usage
 * since the newest exported day, so an outage loses no day; every minute the Stripe sender, when a KMS-wrapped Stripe key is configured
 * (`NGW_STRIPE_KEY_WRAPPED_FILE`, unwrapped with `NGW_KMS_KEY_NAME` at start, kept in memory). Runs as ngw_ops (BYPASSRLS), only with NGW_MODE=nous:
 * `NGW_MODE=nous SPACE_DATABASE_URL=<ngw_ops URL> node packages/gateway/dist/nous/ops.js`.
 * shortcut: the usage pollers, token refreshers and warm-up still run in every replica (main.ts); they move here with the capacity forecast.
 */
export const OPS_LOCK_KEY = 7_234_298_706; // only ngw-ops takes it

export type OpsLog = (line: Record<string, unknown>) => void;

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/** The days the export covers at `now`: every day with usage after the newest exported one, and yesterday (a re-run sends nothing twice). */
export async function daysToExport(ops: pg.Pool, now: Date): Promise<string[]> {
  const today = now.toISOString().slice(0, 10);
  const yesterday = new Date(Date.parse(`${today}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
  const missed = (await ops.query(`SELECT DISTINCT to_char(day, 'YYYY-MM-DD') AS day FROM ngw_usage_daily WHERE day < $1::date
    AND day > coalesce((SELECT max(day) FROM ngw_meter_exports), '-infinity'::date)`, [today])).rows.map((row) => row.day as string);
  return [...new Set([...missed, yesterday])].sort();
}

export type MeterSender = NonNullable<ReturnType<typeof createStripeMeterSender>>;

export function createOpsJobs(ops: pg.Pool, options: { exportAt?: string; now?: () => Date; log?: OpsLog; sendMeterEvents?: MeterSender | null } = {}) {
  const exportAt = options.exportAt || "02:00";
  if (!HHMM.test(exportAt)) throw new Error("NGW_STRIPE_EXPORT_AT must be HH:MM (UTC).");
  const now = options.now ?? (() => new Date());
  const log = options.log ?? (() => {});
  let partitionsOn: string | null = null;
  let exportedOn: string | null = null;
  // A failed job is logged and tried again at the next tick; the daily ones count as done only when they succeed. Null logs nothing.
  const job = async (name: string, run: () => Promise<Record<string, unknown> | null>) => {
    try {
      const result = await run();
      if (result) log({ event: "ngw.ops", job: name, ...result });
      return true;
    } catch (error) {
      log({ event: "ngw.ops", job: name, level: "error", error: error instanceof Error ? error.message : "unknown" });
      return false;
    }
  };
  return {
    async tick() {
      const at = now();
      const today = at.toISOString().slice(0, 10);
      await job("reservation_sweep", async () => ({ periods: await sweepExpiredReservations(ops, at) }));
      await job("key_retirement", async () => ({ keys: await retireOverlappedKeys(ops, at) }));
      if (partitionsOn !== today && await job("partitions", async () => ({ changes: (await ops.query("SELECT ngw_request_log_partitions() AS changes")).rows[0].changes })))
        partitionsOn = today;
      if (exportedOn !== today && at.toISOString().slice(11, 16) >= exportAt && await job("meter_export", async () => {
        const days: Record<string, Record<string, number>> = {};
        for (const day of await daysToExport(ops, at)) {
          const items = await exportMeterDay(ops, day);
          days[day] = { pending: items.filter((item) => item.status === "PENDING").length, noCustomer: items.filter((item) => item.status === "NO_CUSTOMER").length };
          // Plan §8: a sent day whose usage changed is never corrected automatically; the operator reconciles it.
          for (const item of items.filter((entry) => entry.differsFromSent)) log({ event: "ngw.ops", job: "meter_export", level: "warn", differsFromSent: item.identifier });
        }
        // Plan §8: rows first tried longer ago than Stripe's idempotency window may have counted; a person checks them in Stripe.
        const unsent = (await ops.query(`SELECT identifier FROM ngw_meter_exports WHERE status = 'PENDING'
          AND send_started_at <= $1::timestamptz - make_interval(hours => $2)`, [at, STRIPE_RESEND_WINDOW_HOURS])).rows.map((row) => row.identifier as string);
        const refused = (await ops.query("SELECT identifier, send_error FROM ngw_meter_exports WHERE status = 'PENDING' AND send_error IS NOT NULL")).rows
          .map((row) => `${row.identifier} ${row.send_error}`);
        return { days, ...(unsent.length || refused.length ? { level: "warn", unsentPastIdempotencyWindow: unsent, refusedByStripe: refused } : {}) };
      })) exportedOn = today;
      const send = options.sendMeterEvents;
      if (send) await job("stripe_send", async () => {
        const result = await send(ops);
        return result.sent || result.failed.length || result.stopped ? { ...result, ...(result.failed.length || result.stopped ? { level: "warn" } : {}) } : null;
      });
    }
  };
}

/** Takes the ops lock (waiting while another copy holds it), then ticks until `signal` aborts or the lock's connection is lost. */
export async function runOps(options: { connectionString: string; signal: AbortSignal; exportAt?: string; log?: OpsLog; tickMs?: number; lockRetryMs?: number;
  now?: () => Date; sendMeterEvents?: MeterSender | null }) {
  const log = options.log ?? (() => {});
  const lock = new pg.Client({ connectionString: options.connectionString });
  let lost: Error | null = null;
  const onLost = (error?: Error) => { lost ??= error ?? new Error("the ops lock connection ended"); };
  lock.on("error", onLost);
  lock.on("end", () => onLost());
  await lock.connect();
  const pool = new pg.Pool({ connectionString: options.connectionString, max: 2 });
  try {
    let waiting = false;
    while (!options.signal.aborted && !(await lock.query("SELECT pg_try_advisory_lock($1) AS ok", [OPS_LOCK_KEY])).rows[0].ok) {
      if (!waiting) log({ event: "ngw.ops", state: "waiting for the ops lock" });
      waiting = true;
      await sleep(options.lockRetryMs ?? 30_000, undefined, { signal: options.signal }).catch(() => {});
    }
    if (options.signal.aborted) return;
    log({ event: "ngw.ops", state: "holding the ops lock" });
    const jobs = createOpsJobs(pool, { exportAt: options.exportAt, now: options.now, log, sendMeterEvents: options.sendMeterEvents });
    while (!options.signal.aborted) {
      if (lost) throw lost; // another copy may hold the lock now; systemd restarts this one, which then waits
      await jobs.tick();
      await sleep(options.tickMs ?? 60_000, undefined, { signal: options.signal }).catch(() => {});
    }
  } finally {
    await pool.end();
    lock.removeAllListeners("end");
    await lock.end().catch(() => {});
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.env.NGW_MODE !== "nous") throw new Error("ngw-ops runs only with NGW_MODE=nous.");
  const connectionString = process.env.SPACE_DATABASE_URL;
  if (!connectionString) throw new Error("SPACE_DATABASE_URL (the ngw_ops connection) is required.");
  const log: OpsLog = (line) => console.log(JSON.stringify(line));
  const { NGW_STRIPE_KEY_WRAPPED_FILE: wrapped, NGW_KMS_KEY_NAME: keyName, GOOGLE_APPLICATION_CREDENTIALS: credentialConfigFile } = process.env;
  if (wrapped && (!keyName || !credentialConfigFile)) throw new Error("NGW_STRIPE_KEY_WRAPPED_FILE needs NGW_KMS_KEY_NAME and GOOGLE_APPLICATION_CREDENTIALS.");
  const stripeKey = wrapped ? (await gcpKmsDecrypter({ keyName: keyName!, credentialConfigFile: credentialConfigFile! })(await readFile(wrapped))).toString("utf8").trim() : null;
  const sendMeterEvents = createStripeMeterSender({ mode: process.env.NGW_MODE, key: stripeKey });
  log({ event: "ngw.ops", state: sendMeterEvents ? `Stripe sender on (${stripeKey!.includes("_live_") ? "live" : "test"} key)` : "Stripe sender off: no key configured" });
  const controller = new AbortController();
  for (const signal of ["SIGTERM", "SIGINT"] as const) process.once(signal, () => controller.abort());
  await runOps({ connectionString, signal: controller.signal, exportAt: process.env.NGW_STRIPE_EXPORT_AT, log, sendMeterEvents });
}
