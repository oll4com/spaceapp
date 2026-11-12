import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { createSpacePgPool } from "../src/space-store.js";
import { loadMigrations } from "../src/migrations.js";
import { disposablePostgresUnavailableReason } from "./support/disposable-postgres.js";

const postgresUnavailable = disposablePostgresUnavailableReason();

/**
 * Nous's Fable defaults (operator decision 2026-10-24): stored per-kind choices equal to the old default (Opus 5.5 xhigh) move to
 * the new default of their kind once; any other explicit choice, and accounts without Nous models, are left alone.
 */
it.skipIf(postgresUnavailable)("moves only the old Opus 5.5 xhigh defaults of nous.models to the Fable defaults of each kind", async () => {
  const migrations = await loadMigrations();
  const index = migrations.findIndex((item) => item.filename.startsWith("0248_nous_fable_defaults"));
  expect(index).toBeGreaterThan(0);
  const root = await mkdtemp(`${tmpdir()}/space-pg-`);
  const socket = `${root}/socket`;
  await mkdir(socket); await chmod(socket, 0o777);
  const name = `space-nous-fable-${randomUUID()}`;
  const docker = (args: string[]) => execFileSync("docker", args, { encoding: "utf8", timeout: 30_000, stdio: ["ignore", "pipe", "pipe"] }).trim();
  const pool = createSpacePgPool(`postgresql://postgres@localhost/postgres?host=${encodeURIComponent(socket)}`, { max: 4 });
  let created = false;
  try {
    docker(["run", "--tmpfs", "/var/lib/postgresql/data", "--detach", "--rm", "--pull=never", "--name", name, "--network", "none", "--mount", `type=bind,source=${socket},target=/var/run/postgresql`,
      "--env", "POSTGRES_HOST_AUTH_METHOD=trust", "pgvector/pgvector:0.8.7-pg17-trixie", "-c", "listen_addresses="]);
    created = true;
    let ready = false;
    for (let i = 0; i < 100; i++) {
      try { if (docker(["exec", name, "cat", "/proc/1/comm"]) !== "postgres") throw Error(); await pool.query("SELECT 1"); ready = true; break; }
      catch { await new Promise(resolve => setTimeout(resolve, 250)); }
    }
    if (!ready) throw Error("Owned PostgreSQL did not become ready.");
    for (const item of migrations.slice(0, index)) await pool.query(item.sql);
    await pool.query(`INSERT INTO users(id,email,role) VALUES ('fable:a','a@fable.test','USER'),('fable:b','b@fable.test','USER'),('fable:c','c@fable.test','USER')`);
    const opus = { model: "claude-opus-5-5", effort: "xhigh" };
    // 0272 (R20-tok-1) runs here too: the goal loop's old defaults (a's) move, b's own numbers stay.
    const oldGoals = { loop: true, gapSeconds: 60, backoffMinutes: 15, backoffMaxMinutes: 60, unchangedTurns: 3 };
    const ownGoals = { loop: false, gapSeconds: 120, backoffMinutes: 15, backoffMaxMinutes: 90, unchangedTurns: 4 };
    const saved = (models: Record<string, unknown>, goals: Record<string, unknown>) => JSON.stringify({ uiZoom: 110, nous: { enabled: true, models, goals } });
    await pool.query(`INSERT INTO user_settings(user_id, settings) VALUES ('fable:a', $1::jsonb), ('fable:b', $2::jsonb), ('fable:c', '{"uiZoom": 90}'::jsonb)`,
      [saved({ operator: opus, decision: opus, inbox: opus, standing: opus, helper: opus }, oldGoals),
        saved({ operator: opus, decision: { model: "claude-sonnet-5-5", effort: "high" }, inbox: { model: "claude-opus-5-5", effort: "medium" }, standing: opus, helper: { model: "claude-haiku-5-5", effort: "low" } }, ownGoals)]);
    for (const item of migrations.slice(index)) await pool.query(item.sql);
    const rows = await pool.query<{ user_id: string; settings: { uiZoom: number; nous?: { enabled: boolean; models?: Record<string, unknown> } } }>(`SELECT user_id, settings FROM user_settings ORDER BY user_id`);
    const byUser = Object.fromEntries(rows.rows.map((row) => [row.user_id, row.settings]));
    const fableMax = { model: "claude-fable-5-1", effort: "max" };
    const fableHigh = { model: "claude-fable-5-1", effort: "high" };
    expect(byUser["fable:a"]).toEqual({ uiZoom: 110, nous: { enabled: true, models: { operator: fableMax, decision: fableMax, inbox: fableHigh, standing: fableHigh, helper: fableHigh },
      goals: { loop: true, gapSeconds: 600, backoffMinutes: 30, backoffMaxMinutes: 120, unchangedTurns: 2 } } });
    expect(byUser["fable:b"]).toEqual({ uiZoom: 110, nous: { enabled: true, models: { operator: fableMax, decision: { model: "claude-sonnet-5-5", effort: "high" },
      inbox: { model: "claude-opus-5-5", effort: "medium" }, standing: fableHigh, helper: { model: "claude-haiku-5-5", effort: "low" } }, goals: ownGoals } });
    expect(byUser["fable:c"]).toEqual({ uiZoom: 90 });
  } finally {
    await pool.end();
    if (created) docker(["stop", "--time", "5", name]);
    await rm(root, { recursive: true, force: true });
  }
}, 120_000);
