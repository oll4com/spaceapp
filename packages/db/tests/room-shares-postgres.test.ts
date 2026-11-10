import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { createSpacePgPool, PostgresSpaceStore } from "../src/space-store.js";
import { loadMigrations } from "../src/migrations.js";
import { disposablePostgresUnavailableReason } from "./support/disposable-postgres.js";

const postgresUnavailable = disposablePostgresUnavailableReason();

it.skipIf(postgresUnavailable)("stores room shares and pane owners: upsert, list, shared rooms, cascade with the room and the user", async () => {
  const migrations = await loadMigrations();
  expect(migrations.some(item => item.id === "0210_room_shares"), "Room shares migration must exist").toBe(true);
  const root = await mkdtemp(`${tmpdir()}/space-pg-`);
  const socket = `${root}/socket`;
  await mkdir(socket); await chmod(socket, 0o777);
  const name = `space-room-shares-${randomUUID()}`;
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
    await pool.query("INSERT INTO users(id,email,role) VALUES ('user:share-a','a@share.test','USER'),('user:share-b','b@share.test','USER')");
    const store = new PostgresSpaceStore(pool);
    const room = await store.createRoom({ name: "Shared", initialPaneCount: 0 }, "trace:share", "user:share-a");
    const pane = await store.createPane({ roomId: room.id, title: "Bob", mode: "CHAT" }, "trace:share");
    expect(await store.getPaneOwner(pane.id)).toBeNull();
    await store.setPaneOwner(pane.id, "user:share-b");
    expect(await store.getPaneOwner(pane.id)).toBe("user:share-b");
    expect((await store.listPanes(room.id))[0]?.id).toBe(pane.id);

    const share = { roomId: room.id, userId: "user:share-b", permission: "VIEW" as const, createdBy: "user:share-a", createdAt: "2026-10-16T12:00:00.000Z" };
    expect(await store.setRoomShare(share)).toEqual(share);
    expect(await store.setRoomShare({ ...share, permission: "COLLABORATE" })).toMatchObject({ permission: "COLLABORATE" });
    expect(await store.listRoomShares(room.id)).toHaveLength(1);
    expect(await store.getRoomShare(room.id, "user:share-b")).toMatchObject({ permission: "COLLABORATE" });
    expect((await store.listSharedRooms("user:share-b")).map((item) => item.id)).toEqual([room.id]);
    expect(await store.listSharedRooms("user:share-a")).toEqual([]);
    expect(await store.deleteRoomShare(room.id, "user:share-b")).toBe(true);
    expect(await store.deleteRoomShare(room.id, "user:share-b")).toBe(false);
    expect(await store.getRoomShare(room.id, "user:share-b")).toBeNull();

    await store.setRoomShare(share);
    await pool.query("DELETE FROM users WHERE id = 'user:share-b'");
    expect(await store.listRoomShares(room.id)).toEqual([]);
    expect(await store.getPaneOwner(pane.id)).toBeNull();
    await expect(pool.query("INSERT INTO room_shares(room_id,user_id,permission,created_by) VALUES ($1,'user:share-a','EDIT','user:share-a')", [room.id])).rejects.toThrow();
    // MU-003: a WORKSPACE room needs an owner; Agent Proof rooms may stay ownerless.
    await expect(store.createRoom({ name: "Ownerless", initialPaneCount: 0 })).rejects.toThrow(/rooms_workspace_owner_required/);
    expect((await store.createRoom({ name: "Proof", kind: "AGENT_PROOF", initialPaneCount: 0 })).ownerUserId).toBeNull();
  } finally {
    await pool.end();
    if (created) docker(["stop", "--time", "5", name]);
    await rm(root, { recursive: true, force: true });
  }
}, 120_000);
