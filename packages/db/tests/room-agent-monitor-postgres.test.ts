import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { createSpacePgPool } from "../src/space-store.js";
import { loadMigrations } from "../src/migrations.js";
import { disposablePostgresUnavailableReason } from "./support/disposable-postgres.js";

const postgresUnavailable = disposablePostgresUnavailableReason();

it.skipIf(postgresUnavailable)("keeps the room monitor switch, pane activity and the Room Agent feed in PostgreSQL", async () => {
  const migrations = await loadMigrations();
  expect(migrations.some(item => item.id === "0173_room_agent_monitor"), "Room monitor migration must exist").toBe(true);
  const root = await mkdtemp(`${tmpdir()}/space-pg-`);
  const socket = `${root}/socket`;
  await mkdir(socket); await chmod(socket, 0o777);
  const name = `space-room-monitor-${randomUUID()}`;
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
    for (const item of migrations) await pool.query(item.sql);
    // Every WORKSPACE room has an owner (MU-003, migration 0219).
    await pool.query(`INSERT INTO users(id,email,role) VALUES ('mon:owner','owner@mon.test','ADMIN');
      INSERT INTO rooms(id,name,trace_id,owner_user_id,room_order) VALUES ('mon:room1','One','mon:t1','mon:owner',1),('mon:room2','Two','mon:t2','mon:owner',2);
      INSERT INTO panes(id,room_id,title,mode,status,pane_order) VALUES ('mon:pane1','mon:room1','Bob','TERMINAL','IDLE',0),('mon:pane2','mon:room1','Dana','TERMINAL','IDLE',1);`);
    const { PostgresRoomAgentMonitorRepository } = await import("../src/room-agent-monitor-repository.js");
    const repository = new PostgresRoomAgentMonitorRepository(pool);

    expect(await repository.monitorEnabled("mon:room1")).toBe(true);
    await repository.setMonitorEnabled("mon:room1", false);
    expect(await repository.disabledRooms()).toEqual(new Set(["mon:room1"]));
    await repository.setMonitorEnabled("mon:room1", true);
    expect(await repository.monitorEnabled("mon:room1")).toBe(true);
    expect(await repository.autopilotEnabled("mon:room1")).toBe(true);
    await repository.setAutopilotEnabled("mon:room1", false);
    expect(await repository.autopilotEnabled("mon:room1")).toBe(false);
    expect(await repository.monitorEnabled("mon:room1")).toBe(true);
    await repository.setAutopilotEnabled("mon:room2", false);
    expect(await repository.monitorEnabled("mon:room2")).toBe(true);

    await repository.savePaneActivity([
      { paneId: "mon:pane1", roomId: "mon:room1", activity: "WORKING", reason: null, since: "2026-10-13T05:00:00.000Z" },
      { paneId: "mon:pane2", roomId: "mon:room1", activity: "WAITING", reason: "Permission prompt", since: null }
    ]);
    await repository.savePaneActivity([{ paneId: "mon:pane1", roomId: "mon:room1", activity: "DONE", reason: null, since: "2026-10-13T05:10:00.000Z" }]);
    expect((await repository.paneActivity("mon:room1")).sort((a, b) => a.paneId.localeCompare(b.paneId))).toEqual([
      { paneId: "mon:pane1", roomId: "mon:room1", activity: "DONE", reason: null, since: "2026-10-13T05:10:00.000Z" },
      { paneId: "mon:pane2", roomId: "mon:room1", activity: "WAITING", reason: "Permission prompt", since: null }
    ]);

    const finished = await repository.addEvent({ roomId: "mon:room1", paneId: "mon:pane1", paneName: "Bob", kind: "FINISHED", severity: "INFO",
      title: "Bob finished", detail: "Fix login" });
    const waiting = await repository.addEvent({ roomId: "mon:room1", paneId: "mon:pane2", paneName: "Dana", kind: "WAITING", severity: "ATTENTION",
      title: "Dana is waiting: Permission prompt", detail: null });
    expect((await repository.listEvents("mon:room1")).map(event => event.eventId)).toEqual([waiting.eventId, finished.eventId]);
    expect(await repository.listEvents("mon:room1", { paneId: "mon:pane2", statuses: ["OPEN"] })).toEqual([waiting]);
    expect(await repository.pendingCounts(["mon:room1", "mon:room2"])).toEqual({ "mon:room1": 1 });

    const escalated = await repository.updateEvent(waiting.eventId, { status: "ESCALATED", decision: "Asks to push to GitHub." }, ["OPEN"]);
    expect(escalated).toMatchObject({ status: "ESCALATED", decision: "Asks to push to GitHub." });
    // A writer that expected OPEN loses to the decision already taken.
    expect(await repository.updateEvent(waiting.eventId, { status: "HANDLED" }, ["OPEN"])).toBeNull();
    expect(await repository.pendingCounts(["mon:room1"])).toEqual({ "mon:room1": 1 });
    await repository.updateEvent(waiting.eventId, { status: "ACKED" });
    expect(await repository.pendingCounts(["mon:room1"])).toEqual({});
    expect((await repository.getEvent(waiting.eventId))?.decision).toBe("Asks to push to GitHub.");

    // Telegram notices only while the integration is connected and on, one per event.
    expect(await repository.enqueueTelegramNotice(escalated!)).toBe(false);
    await pool.query("UPDATE telegram_integrations SET connection_status = 'CONNECTED', is_enabled = true, enabled_at = now() - interval '1 minute' WHERE id = 'global'");
    expect(await repository.enqueueTelegramNotice(escalated!)).toBe(true);
    expect(await repository.enqueueTelegramNotice(escalated!)).toBe(false);
    const outbox = await pool.query<{ source_type: string; agent_label: string; task_title: string; final_response: string; status: string }>(
      "SELECT source_type, agent_label, task_title, final_response, status FROM telegram_notification_outbox WHERE source_key = $1", [`room-agent-event:${waiting.eventId}`]);
    expect(outbox.rows).toEqual([{ source_type: "ROOM_AGENT", agent_label: "Room Agent", task_title: "Dana is waiting: Permission prompt",
      final_response: "Asks to push to GitHub.", status: "PENDING" }]);
    await pool.query("DELETE FROM panes WHERE id = 'mon:pane1'");
    expect((await repository.getEvent(finished.eventId))?.paneId).toBeNull();
    expect((await repository.paneActivity("mon:room1")).map(record => record.paneId)).toEqual(["mon:pane2"]);
    expect(await repository.pruneEvents(new Date(Date.now() + 60_000).toISOString())).toBe(2);
    await expect(pool.query(`INSERT INTO room_agent_events(event_id,room_id,kind,severity,title) VALUES ('mon:bad','mon:room1','DEPLOYED','INFO','x')`)).rejects.toThrow();

    // W46: a deleted room keeps its events for the scorecard; a wait still open ends at the deletion.
    const since = new Date(Date.now() - 60_000).toISOString();
    const open = await repository.addEvent({ roomId: "mon:room2", paneId: null, paneName: "Eve", kind: "WAITING", severity: "ATTENTION", title: "Eve is waiting", detail: null });
    const done = await repository.addEvent({ roomId: "mon:room2", paneId: null, paneName: "Eve", kind: "STUCK", severity: "ATTENTION", title: "Eve is stuck", detail: null });
    await repository.updateEvent(done.eventId, { status: "HANDLED", decision: "Nous answered." });
    await pool.query("DELETE FROM rooms WHERE id = 'mon:room2'");
    const kept = await repository.listOwnerEvents("mon:owner", since);
    expect(kept.map(event => [event.eventId, event.status, event.decision])).toEqual([
      [done.eventId, "HANDLED", "Nous answered."], [open.eventId, "RESOLVED", "The room was deleted."]]);
    expect(await repository.listOwnerEvents("someone:else", since)).toEqual([]);
  } finally {
    await pool.end();
    if (created) docker(["stop", "--time", "5", name]);
    await rm(root, { recursive: true, force: true });
  }
}, 120_000);
