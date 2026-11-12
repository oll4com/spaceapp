import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { createSpacePgPool, PostgresSpaceStore } from "../src/space-store.js";
import { loadMigrations } from "../src/migrations.js";
import { disposablePostgresUnavailableReason } from "./support/disposable-postgres.js";

const postgresUnavailable = disposablePostgresUnavailableReason();

it.skipIf(postgresUnavailable)("expires an untaken handoff request past its TTL and keeps an accepted one while the operator's lease is alive", async () => {
  const migrations = await loadMigrations();
  const root = await mkdtemp(`${tmpdir()}/space-pg-`);
  const socket = `${root}/socket`;
  await mkdir(socket); await chmod(socket, 0o777);
  const name = `space-handoff-expiry-${randomUUID()}`;
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
    await pool.query(`INSERT INTO users(id,email,role) VALUES ('handoff:operator','op@handoff.test','OPERATOR');
      INSERT INTO rooms(id,name,trace_id,owner_user_id,room_order) VALUES ('handoff:room0001','Handoff','handoff:trace001','handoff:operator',0);
      INSERT INTO panes(id,room_id,title,mode,status,pane_order) VALUES ('handoff:pane0001','handoff:room0001','Browser','BROWSER','IDLE',0);
      INSERT INTO pane_browser_sessions(session_id,pane_id,room_id,agent_number,profile_id,profile_path,viewport,status)
        VALUES ('handoff:session01','handoff:pane0001','handoff:room0001',1,'handoff:profile01','/tmp/ho-profile','desktop','READY');`);
    const store = new PostgresSpaceStore(pool);
    // The same owned PostgreSQL checks the pane browser's network route (migration 0271, plan clipboard:iLvBs5eOMZjF): one per pane, upserted.
    expect(await store.getPaneBrowserRoute("handoff:pane0001")).toBeNull();
    await store.setPaneBrowserRoute("handoff:pane0001", "greece");
    await store.setPaneBrowserRoute("handoff:pane0001", "direct");
    expect(await store.getPaneBrowserRoute("handoff:pane0001")).toBe("direct");
    await expect(pool.query("INSERT INTO pane_browser_routes (pane_id, route) VALUES ('handoff:pane0001', 'moon') ON CONFLICT (pane_id) DO UPDATE SET route = excluded.route")).rejects.toThrow(/check/);
    const request = { sessionId: "handoff:session01", paneId: "handoff:pane0001", roomId: "handoff:room0001", requestedByType: "AGENT" as const, requestedById: "cli:handoff-agent", ttlSeconds: 30 };
    const backdate = (id: string) => pool.query("UPDATE browser_handoff_requests SET expires_at = now() - interval '1 second' WHERE handoff_request_id = $1", [id]);

    // An untaken request past its TTL is EXPIRED: the active lookup, status readers and the pane no longer see it as REQUESTED.
    const untaken = await store.createBrowserHandoffRequest({ ...request, reason: "CAPTCHA nobody took" });
    expect(await store.getActiveBrowserHandoffRequest("handoff:session01")).toMatchObject({ handoffRequestId: untaken.handoffRequestId, status: "REQUESTED" });
    await backdate(untaken.handoffRequestId);
    expect(await store.getActiveBrowserHandoffRequest("handoff:session01")).toBeNull();
    expect(await store.getBrowserHandoffRequest(untaken.handoffRequestId)).toMatchObject({ status: "EXPIRED", expiredAt: expect.any(String) });

    // An accepted handoff stays active past the request's TTL while the operator's control lease is alive.
    await pool.query(`INSERT INTO browser_control_leases(lease_id,session_id,pane_id,room_id,holder_type,holder_id,status,expires_at)
      VALUES ('handoff:lease001','handoff:session01','handoff:pane0001','handoff:room0001','OPERATOR','handoff:operator','ACTIVE',now() + interval '60 seconds')`);
    const held = await store.createBrowserHandoffRequest({ ...request, reason: "LOGIN on the phone" });
    await store.updateBrowserHandoffRequest(held.handoffRequestId, {
      status: "ACCEPTED", operatorUserId: "handoff:operator", operatorEmail: "op@handoff.test", operatorRole: "OPERATOR", controlLeaseId: "handoff:lease001"
    });
    await backdate(held.handoffRequestId);
    expect(await store.getActiveBrowserHandoffRequest("handoff:session01")).toMatchObject({ handoffRequestId: held.handoffRequestId, status: "ACCEPTED" });
    await expect(store.createBrowserHandoffRequest({ ...request, reason: "another request" })).rejects.toThrow("already has an active handoff request");
    // Once the operator's lease is gone, the stale accepted handoff expires too.
    await pool.query("UPDATE browser_control_leases SET status = 'RELEASED', released_at = now() WHERE lease_id = 'handoff:lease001'");
    expect(await store.getActiveBrowserHandoffRequest("handoff:session01")).toBeNull();
    expect(await store.getBrowserHandoffRequest(held.handoffRequestId)).toMatchObject({ status: "EXPIRED" });

    // A lease nobody marked EXPIRED (the acquire's answer was lost) stops reading as operator control at its expiry.
    await store.createBrowserControlLease({ sessionId: "handoff:session01", paneId: "handoff:pane0001", roomId: "handoff:room0001",
      holderType: "OPERATOR", holderId: "handoff:operator", ttlSeconds: 60 });
    expect(await store.getActivePaneBrowserSession("handoff:pane0001")).toMatchObject({ controlState: "OPERATOR" });
    await pool.query("UPDATE browser_control_leases SET expires_at = now() - interval '1 second' WHERE session_id = 'handoff:session01' AND status = 'ACTIVE'");
    expect(await store.getActivePaneBrowserSession("handoff:pane0001")).toMatchObject({ controlState: "UNCONTROLLED" });
  } finally {
    await pool.end();
    if (created) docker(["stop", "--time", "5", name]);
    await rm(root, { recursive: true, force: true });
  }
}, 120_000);
