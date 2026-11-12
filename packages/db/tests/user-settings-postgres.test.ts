import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { createSpacePgPool, PostgresSpaceStore } from "../src/space-store.js";
import { loadMigrations } from "../src/migrations.js";
import { disposablePostgresUnavailableReason } from "./support/disposable-postgres.js";

const postgresUnavailable = disposablePostgresUnavailableReason();

// Overlapping PATCHes of one user must all land: a read-merge-write without a lock lost one of them
// (2026-10-13: the app's start-up settings write put back a jobCopilot default that had just been cleared).
it.skipIf(postgresUnavailable)("keeps every one of a user's overlapping settings writes", async () => {
  const migrations = await loadMigrations();
  const root = await mkdtemp(`${tmpdir()}/space-pg-`);
  const socket = `${root}/socket`;
  await mkdir(socket); await chmod(socket, 0o777);
  const name = `space-user-settings-${randomUUID()}`;
  const docker = (args: string[]) => execFileSync("docker", args, { encoding: "utf8", timeout: 30_000, stdio: ["ignore", "pipe", "pipe"] }).trim();
  const pool = createSpacePgPool(`postgresql://postgres@localhost/postgres?host=${encodeURIComponent(socket)}`, { max: 12 });
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
    for (const item of migrations) await pool.query(item.sql);
    await pool.query(`INSERT INTO users(id,email,role) VALUES ('settings:a','a@settings.test','USER'),('settings:b','b@settings.test','USER')`);
    const store = new PostgresSpaceStore(pool);

    // A first write for a user without a row, raced by a second one.
    await Promise.all([store.updateUserSettings("settings:b", { uiZoom: 120 }), store.updateUserSettings("settings:b", { terminalFontSize: 15 })]);
    expect(await store.getUserSettings("settings:b")).toMatchObject({ uiZoom: 120, terminalFontSize: 15 });

    for (let round = 0; round < 20; round += 1) {
      await store.updateUserSettings("settings:a", { jobCopilot: { runtimeId: "cli:claude", accountProfileId: "work", askOnLaunch: false } });
      // Clearing the default while unrelated keys are written at the same moment.
      await Promise.all([
        store.updateUserSettings("settings:a", { jobCopilot: null }),
        store.updateUserSettings("settings:a", { uiZoom: 100 + round }),
        store.updateUserSettings("settings:a", { dateTime: { timeFormat: round % 2 ? "12h" : "24h" } }),
        store.updateUserSettings("settings:a", { roomExtraEmptySlots: { [`room-${round}`]: 1 } })
      ]);
      const settings = await store.getUserSettings("settings:a");
      expect(settings.jobCopilot ?? null).toBeNull();
      expect(settings.uiZoom).toBe(100 + round);
      expect(settings.dateTime.timeFormat).toBe(round % 2 ? "12h" : "24h");
      expect(settings.roomExtraEmptySlots?.[`room-${round}`]).toBe(1);
    }
    // Nested maps still merge across writes.
    expect(Object.keys((await store.getUserSettings("settings:a")).roomExtraEmptySlots ?? {})).toHaveLength(20);

    // CPU report 12/11 (plan 1.4): a store keeps the parsed settings until the row changes, by another process (a second store here) or by
    // plain SQL such as a migration's, which leaves updated_at as it was.
    const other = new PostgresSpaceStore(pool);
    const kept = await store.getUserSettings("settings:b");
    expect(await store.getUserSettings("settings:b")).toBe(kept);
    await other.updateUserSettings("settings:b", { uiZoom: 130 });
    expect(await store.getUserSettings("settings:b")).toMatchObject({ uiZoom: 130, terminalFontSize: 15 });
    await pool.query(`UPDATE user_settings SET settings = jsonb_set(settings, '{terminalFontSize}', '17') WHERE user_id = 'settings:b'`);
    expect(await store.getUserSettings("settings:b")).toMatchObject({ uiZoom: 130, terminalFontSize: 17 });
  } finally {
    await pool.end();
    if (created) docker(["stop", "--time", "5", name]);
    await rm(root, { recursive: true, force: true });
  }
}, 120_000);
