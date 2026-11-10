// App Studio tables on a real, disposable PostgreSQL: migration 0236 applies on top of the full chain (pane metadata CHECK, the
// APP_STUDIO notification source, the status CHECK per row type), and the repository round-trips the feed (the atomic brief
// take, guarded transitions) and the latest preview per device and route (the replaced artifact, the route cap).
// Skips with a reason when Docker or the image is missing.
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresAppStudioRepository } from "../src/app-studio-repository.js";
import { applyPendingMigrations } from "../src/migration-runner.js";
import { loadMigrations } from "../src/migrations.js";
import { disposablePostgresUnavailableReason, startDisposablePostgres, type DisposablePostgres } from "./support/disposable-postgres.js";

const unavailable = disposablePostgresUnavailableReason();
const owner = "user:appstudio";
const other = "user:appstudio-other";
const paneId = "pane:appstudio01";

describe.skipIf(unavailable !== null)(`App Studio repository on PostgreSQL${unavailable ? ` (skipped: ${unavailable})` : ""}`, () => {
  let server: DisposablePostgres;
  let pool: pg.Pool;
  let repository: PostgresAppStudioRepository;

  beforeAll(async () => {
    server = await startDisposablePostgres("appstudio");
    await server.createDatabase("space_app_studio");
    pool = server.pool("space_app_studio", 4);
    const client = await pool.connect();
    try {
      await applyPendingMigrations(client, await loadMigrations());
    } finally {
      client.release();
    }
    await pool.query("INSERT INTO users(id, email, role) VALUES ($1, $2, 'OPERATOR'), ($3, $4, 'OPERATOR')", [owner, "apps@space.local", other, "other@space.local"]);
    await pool.query(`INSERT INTO rooms(id,name,trace_id,owner_user_id,room_order) VALUES ('room:appstudio01','Apps','trace:appstudio01','${owner}',0);
      INSERT INTO panes(id,room_id,title,mode,status,pane_order) VALUES ('${paneId}','room:appstudio01','App Studio','APP_STUDIO','IDLE',0)`);
    repository = new PostgresAppStudioRepository(pool as unknown as ConstructorParameters<typeof PostgresAppStudioRepository>[0]);
  }, 120_000);

  afterAll(async () => {
    await server?.stop();
  });

  it("adds the pane column with its version CHECK and the APP_STUDIO notification source", async () => {
    const check = await pool.query<{ def: string }>("SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname='panes_app_studio_metadata_object'");
    expect(check.rows[0]?.def).toContain("version");
    await expect(pool.query(`UPDATE panes SET app_studio_metadata='{"version":2}' WHERE id=$1`, [paneId])).rejects.toThrow();
    const source = await pool.query<{ def: string }>("SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname='space_notifications_source_check'");
    expect(source.rows[0]?.def).toContain("'APP_STUDIO'");
    expect(source.rows[0]?.def).toContain("'DESIGN'");
  });

  it("takes the oldest brief once, guards transitions and refuses a status the row type does not have", async () => {
    const first = await repository.createEvent({ ownerUserId: owner, paneId, type: "BRIEF", status: "PENDING", message: "Build a todo app", payload: { requester: "OPERATOR" } });
    const second = await repository.createEvent({ ownerUserId: owner, paneId, type: "BRIEF", status: "PENDING", message: "Add a settings screen", payload: {} });
    expect((await repository.takeNextBrief(owner, paneId))?.id).toBe(first.id);
    expect((await repository.takeNextBrief(owner, paneId))?.id).toBe(second.id);
    expect(await repository.takeNextBrief(owner, paneId)).toBeNull();
    expect(await repository.takeNextBrief(other, paneId)).toBeNull();
    const done = await repository.updateEvent(owner, first.id, { status: "DONE", payload: { result: "Two screens" } }, ["TAKEN"]);
    expect(done).toMatchObject({ status: "DONE", payload: { requester: "OPERATOR", result: "Two screens" } });
    expect(await repository.updateEvent(owner, first.id, { status: "FAILED" }, ["TAKEN"])).toBeNull();
    expect(await repository.updateEvent(other, second.id, { status: "DONE" }, ["TAKEN"])).toBeNull();
    const question = await repository.createEvent({ ownerUserId: owner, paneId, type: "QUESTION", status: "OPEN", message: "Light or dark theme?", payload: { options: ["Light", "Dark"] } });
    expect((await repository.listEvents(owner, paneId, { types: ["QUESTION"], status: ["OPEN"], limit: 5 })).map((row) => row.id)).toEqual([question.id]);
    expect((await repository.updateEvent(owner, question.id, { status: "ANSWERED", payload: { answer: "Dark" } }, ["OPEN"]))?.payload).toMatchObject({ answer: "Dark" });
    await expect(repository.createEvent({ ownerUserId: owner, paneId, type: "NOTE", status: "OPEN", message: "x", payload: {} })).rejects.toThrow();
    await expect(repository.createEvent({ ownerUserId: owner, paneId, type: "QUESTION", status: "DONE", message: "x", payload: {} })).rejects.toThrow();
    expect((await repository.listEvents(owner, paneId, { limit: 2 })).map((row) => row.id)).toEqual([question.id, second.id]);
    expect(await repository.getEvent(other, question.id)).toBeNull();
  });

  it("keeps the latest preview per device and route, returns the artifact it replaced and caps the routes", async () => {
    const put = (deviceId: string, route: string, artifactId: string) => repository.putPreview({ ownerUserId: owner, paneId, deviceId, route, artifactId });
    expect((await put("iphone-402x874", "/", "artifact:shot0001")).replacedArtifactId).toBeNull();
    expect((await put("iphone-402x874", "/", "artifact:shot0002")).replacedArtifactId).toBe("artifact:shot0001");
    await put("android-412x915", "/", "artifact:shot0003");
    await put("android-412x915", "/settings", "artifact:shot0004");
    expect((await repository.listPreviews(owner, paneId)).map((row) => [row.route, row.deviceId, row.artifactId])).toEqual([
      ["/", "android-412x915", "artifact:shot0003"], ["/", "iphone-402x874", "artifact:shot0002"], ["/settings", "android-412x915", "artifact:shot0004"]]);
    expect(await repository.listPreviews(other, paneId)).toEqual([]);
    await pool.query("UPDATE app_studio_previews SET captured_at = now() - interval '1 hour' WHERE route = '/'");
    expect(await repository.trimPreviewRoutes(owner, paneId, 1)).toEqual(expect.arrayContaining(["artifact:shot0002", "artifact:shot0003"]));
    expect((await repository.listPreviews(owner, paneId)).map((row) => row.route)).toEqual(["/settings"]);
    await expect(pool.query("INSERT INTO app_studio_previews(pane_id, device_id, route, owner_user_id, artifact_id) VALUES ($1, 'tablet-1', '/', $2, 'artifact:shot0009')", [paneId, owner])).rejects.toThrow();
    // 0316: the Galaxy Tab S10 FE+ ids have 4-digit sizes (0236 allowed only 3, so its previews failed); 5 digits still fail.
    for (const deviceId of ["android-900x1440", "android-1440x900"]) expect((await put(deviceId, "/", `artifact:tab${deviceId.slice(8, 12)}`)).replacedArtifactId).toBeNull();
    await expect(pool.query("INSERT INTO app_studio_previews(pane_id, device_id, route, owner_user_id, artifact_id) VALUES ($1, 'android-12345x900', '/', $2, 'artifact:shot0010')", [paneId, owner])).rejects.toThrow();
  });
});
