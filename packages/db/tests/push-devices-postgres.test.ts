import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { createSpacePgPool } from "../src/space-store.js";
import { loadMigrations } from "../src/migrations.js";
import { PostgresSpaceNotificationsRepository } from "../src/space-notifications-repository.js";
import { disposablePostgresUnavailableReason } from "./support/disposable-postgres.js";

const postgresUnavailable = disposablePostgresUnavailableReason();

it.skipIf(postgresUnavailable)("keeps each user's FCM push tokens: one row per token, moved to the last user, disabled and re-enabled", async () => {
  const migrations = await loadMigrations();
  expect(migrations.some(item => item.id === "0209_space_push_devices"), "Push devices migration must exist").toBe(true);
  const root = await mkdtemp(`${tmpdir()}/space-pg-`);
  const socket = `${root}/socket`;
  await mkdir(socket); await chmod(socket, 0o777);
  const name = `space-push-devices-${randomUUID()}`;
  const docker = (args: string[]) => execFileSync("docker", args, { encoding: "utf8", timeout: 30_000, stdio: ["ignore", "pipe", "pipe"] }).trim();
  const pool = createSpacePgPool(`postgresql://postgres@localhost/postgres?host=${encodeURIComponent(socket)}`, { max: 4 });
  let created = false;
  try {
    docker(["run", "--detach", "--rm", "--pull=never", "--name", name, "--network", "none", "--mount", `type=bind,source=${socket},target=/var/run/postgresql`,
      "--env", "POSTGRES_HOST_AUTH_METHOD=trust", "pgvector/pgvector:0.8.7-pg17-trixie", "-c", "listen_addresses="]);
    created = true;
    let ready = false;
    for (let i = 0; i < 100; i++) {
      try { if (docker(["exec", name, "cat", "/proc/1/comm"]) !== "postgres") throw Error(); await pool.query("SELECT 1"); ready = true; break; }
      catch { await new Promise(resolve => setTimeout(resolve, 250)); }
    }
    if (!ready) throw Error("Owned PostgreSQL did not become ready.");
    for (const item of migrations) await pool.query(item.sql);
    await pool.query("INSERT INTO users(id,email,role) VALUES ('push:a','a@push.test','ADMIN'),('push:b','b@push.test','USER')");
    const repository = new PostgresSpaceNotificationsRepository(pool);
    const phone = `phone-a:${"x".repeat(40)}`;
    const tablet = `tablet-a:${"y".repeat(40)}`;
    await repository.registerPushDevice("push:a", { token: phone, platform: "ANDROID", appVersion: "0.1.24" });
    await repository.registerPushDevice("push:a", { token: tablet, platform: "ANDROID", appVersion: null });
    expect((await repository.pushTokens("push:a")).sort()).toEqual([phone, tablet].sort());
    // N2/R6: every device starts on NOUS; a level set stays when a later registration names none; pushTokens filters by level.
    await repository.registerPushDevice("push:a", { token: tablet, platform: "ANDROID", appVersion: null, level: "HANDS" });
    await repository.registerPushDevice("push:a", { token: tablet, platform: "ANDROID", appVersion: null });
    expect((await repository.pushDevices("push:a")).map((device) => [device.token, device.level]).sort()).toEqual([[phone, "NOUS"], [tablet, "HANDS"]].sort());
    expect(await repository.pushTokens("push:a", ["NOUS", "ALL"])).toEqual([phone]);
    await expect(pool.query(`UPDATE space_push_devices SET level = 'LOUD' WHERE token = $1`, [tablet])).rejects.toThrow();
    // FCM said the token is gone: no pushes until the app registers it again.
    await repository.disablePushDevice(phone);
    expect(await repository.pushTokens("push:a")).toEqual([tablet]);
    await repository.registerPushDevice("push:a", { token: phone, platform: "ANDROID", appVersion: "0.1.24" });
    expect(await repository.pushTokens("push:a")).toContain(phone);
    // Another user signs in on the same device: the token moves, the first user no longer gets its pushes.
    await repository.registerPushDevice("push:b", { token: phone, platform: "ANDROID", appVersion: "0.1.24" });
    expect(await repository.pushTokens("push:a")).toEqual([tablet]);
    expect(await repository.pushTokens("push:b")).toEqual([phone]);
    expect(await repository.removePushDevice("push:a", phone)).toBe(false);
    expect(await repository.removePushDevice("push:b", phone)).toBe(true);
    expect(await repository.pushTokens("push:b")).toEqual([]);
    await pool.query("DELETE FROM users WHERE id = 'push:a'");
    expect((await pool.query("SELECT count(*)::int AS n FROM space_push_devices")).rows[0]).toEqual({ n: 0 });
    await expect(pool.query("INSERT INTO space_push_devices(token,user_id,platform) VALUES ('short','push:b','ANDROID')")).rejects.toThrow();
  } finally {
    await pool.end();
    if (created) docker(["stop", "--time", "5", name]);
    await rm(root, { recursive: true, force: true });
  }
}, 120_000);
