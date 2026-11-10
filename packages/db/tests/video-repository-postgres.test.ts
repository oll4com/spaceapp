// Video pane tables on a real, disposable PostgreSQL: migration 0242 applies on top of the full chain (pane metadata CHECK, the
// VIDEO notification source), and the repository round-trips requests (routing, the atomic take with stale re-queue, guarded
// transitions), assets (versions, filters, delete) and the activity feed. Skips with a reason when Docker or the image is missing.
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { defaultVideoPaneMetadata } from "@space/contracts";
import { PostgresVideoRepository } from "../src/video-repository.js";
import { applyPendingMigrations } from "../src/migration-runner.js";
import { loadMigrations } from "../src/migrations.js";
import { disposablePostgresUnavailableReason, startDisposablePostgres, type DisposablePostgres } from "./support/disposable-postgres.js";

const unavailable = disposablePostgresUnavailableReason();
const owner = "user:video";
const other = "user:video-other";

describe.skipIf(unavailable !== null)(`video repository on PostgreSQL${unavailable ? ` (skipped: ${unavailable})` : ""}`, () => {
  let server: DisposablePostgres;
  let pool: pg.Pool;
  let repository: PostgresVideoRepository;

  beforeAll(async () => {
    server = await startDisposablePostgres("video");
    await server.createDatabase("space_video");
    pool = server.pool("space_video", 4);
    const client = await pool.connect();
    try {
      await applyPendingMigrations(client, await loadMigrations());
    } finally {
      client.release();
    }
    await pool.query("INSERT INTO users(id, email, role) VALUES ($1, $2, 'OPERATOR'), ($3, $4, 'OPERATOR')", [owner, "video@space.local", other, "other@space.local"]);
    repository = new PostgresVideoRepository(pool as unknown as ConstructorParameters<typeof PostgresVideoRepository>[0]);
  }, 120_000);

  afterAll(async () => {
    await server?.stop();
  });

  it("adds the pane column with its version CHECK and the VIDEO notification source", async () => {
    const columns = await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name='panes' AND column_name='video_metadata'");
    expect(columns.rowCount).toBe(1);
    const check = await pool.query<{ def: string }>("SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname='panes_video_metadata_object'");
    expect(check.rows[0]?.def).toContain("version");
    expect(JSON.parse(JSON.stringify(defaultVideoPaneMetadata())).version).toBe(1);
    const source = await pool.query<{ def: string }>("SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname='space_notifications_source_check'");
    expect(source.rows[0]?.def).toContain("'VIDEO'");
    expect(source.rows[0]?.def).toContain("'APP_STUDIO'");
  });

  it("queues requests with their sources and options, takes the oldest routed or unrouted one atomically and re-queues stale work", async () => {
    const base = { ownerUserId: owner, requester: { kind: "PANE" as const, paneId: "pane:requester1", roomId: "room:room0001", label: "Codex CLI" }, options: {}, callback: null };
    const first = await repository.createRequest({ ...base, videoPaneId: null, brief: "A highlight reel", sources: [{ artifactId: "artifact:src12345" }], formatIds: ["youtube-short"],
      options: { technique: "highlights", narration: { text: "Welcome", language: "el" } } });
    const routed = await repository.createRequest({ ...base, videoPaneId: "pane:video-b", brief: "For pane B", sources: [{ url: "https://example.com/v", rightsConfirmed: true }], formatIds: ["x"],
      callback: { kind: "MARKETING_POST", postId: "mktpost:post123" } });
    expect(first).toMatchObject({ status: "QUEUED", resultAssetIds: [], question: null, takenAt: null, sources: [{ artifactId: "artifact:src12345" }], options: { technique: "highlights", narration: { text: "Welcome", language: "el" } } });
    expect(routed).toMatchObject({ callback: { kind: "MARKETING_POST", postId: "mktpost:post123" }, sources: [{ url: "https://example.com/v", rightsConfirmed: true }] });
    const [a, b] = await Promise.all([repository.takeNextRequest(owner, "pane:video-a", 60_000), repository.takeNextRequest(owner, "pane:video-a", 60_000)]);
    expect([a?.id, b?.id].filter(Boolean)).toEqual([first.id]);
    expect(await repository.takeNextRequest(owner, "pane:video-a", 60_000)).toBeNull();
    expect(await repository.takeNextRequest(owner, "pane:video-b", 60_000)).toMatchObject({ id: routed.id, status: "TAKEN", videoPaneId: "pane:video-b" });
    await pool.query("UPDATE video_requests SET updated_at = now() - interval '2 hours' WHERE id=$1", [first.id]);
    expect((await repository.takeNextRequest(owner, "pane:video-c", 60_000))?.id).toBe(first.id);
    expect(await repository.updateRequest(owner, first.id, { status: "DELIVERED" }, ["QUEUED"])).toBeNull();
    const delivered = await repository.updateRequest(owner, first.id, { status: "DELIVERED", resultAssetIds: ["vasset:asset123"], message: "Done", deliveredAt: new Date().toISOString() }, ["TAKEN", "IN_PROGRESS"]);
    expect(delivered).toMatchObject({ status: "DELIVERED", resultAssetIds: ["vasset:asset123"], message: "Done" });
    expect((await repository.listRequests(owner, { status: ["TAKEN"], limit: 10 })).map((row) => row.id)).toEqual([routed.id]);
    expect((await repository.listRequests(owner, { requesterPaneId: "pane:requester1", limit: 10 })).length).toBe(2);
    expect(await repository.listRequests(other, { limit: 10 })).toEqual([]);
    // Any number of formats since 31/10 (migration 0275), never none.
    await pool.query("INSERT INTO video_requests(id, owner_user_id, requester, brief, format_ids, status) VALUES ('vreq:manyfmt', $1, '{}', 'x', $2, 'QUEUED')", [owner, Array(9).fill("x")]);
    await expect(pool.query("INSERT INTO video_requests(id, owner_user_id, requester, brief, format_ids, status) VALUES ('vreq:nofmt', $1, '{}', 'x', $2, 'QUEUED')",
      [owner, []])).rejects.toThrow();
    await pool.query("DELETE FROM video_requests WHERE id = 'vreq:manyfmt'");
  });

  it("stores assets with their timeline, thumbnail and credits, filters by kind, and answers a deleted asset so its artifacts can be unpinned", async () => {
    const asset = { ownerUserId: owner, paneId: "pane:video-a", requestId: null, artifactId: "artifact:out12345", thumbnailArtifactId: "artifact:thumb1234", formatId: "square", width: 1080, height: 1080,
      durationSec: 31.5, mimeType: "video/mp4" as const, kind: "OUTPUT" as const, label: "Reel", description: "A 30 s reel of the launch", madeBy: { by: "AGENT" as const, runtimeId: "cli:claude", model: "claude-opus-5-5" },
      credits: "Track by X (ccMixter, CC BY)", timeline: { version: 1 as const, clips: [{ sourceIndex: 0, inSec: 0, outSec: 31.5, speed: 1 }], transition: "auto" as const, transitionSec: 0.4, filter: "none" as const,
        reframe: "FACE" as const, captions: { style: "karaoke" as const, language: null, position: "BOTTOM" as const }, overlays: [], narration: null, music: null, outputs: [{ formatId: "square" }] },
      parentAssetId: null, pinned: true };
    const parent = await repository.createAsset(asset);
    const child = await repository.createAsset({ ...asset, artifactId: "artifact:out67890", parentAssetId: parent.id, label: "Reel v2" });
    expect(parent).toMatchObject({ durationSec: 31.5, width: 1080, credits: asset.credits, timeline: { clips: [{ outSec: 31.5 }] }, madeBy: asset.madeBy });
    expect(child).toMatchObject({ parentAssetId: parent.id, label: "Reel v2" });
    const music = await repository.createAsset({ ...asset, artifactId: "artifact:music1234", thumbnailArtifactId: null, formatId: null, width: null, height: null, durationSec: 184, mimeType: "audio/mpeg", kind: "MUSIC", timeline: null, label: "Track" });
    expect(music).toMatchObject({ kind: "MUSIC", formatId: null, width: null, durationSec: 184 });
    expect((await repository.listAssets(owner, { kinds: ["MUSIC"], limit: 10 })).map((row) => row.id)).toEqual([music.id]);
    expect((await repository.listAssets(owner, { parentIds: [parent.id], limit: 10 })).map((row) => row.id)).toEqual([child.id]);
    expect((await repository.listAssets(owner, { formatIds: ["square"], limit: 10 })).map((row) => row.id)).toEqual([child.id, parent.id]);
    expect((await repository.listAssets(owner, { artifactIds: ["artifact:out67890"], limit: 10 })).map((row) => row.id)).toEqual([child.id]);
    expect(await repository.listAssets(other, { artifactIds: ["artifact:out67890"], limit: 10 })).toEqual([]);
    await expect(pool.query("UPDATE video_assets SET made_by = '[]'::jsonb WHERE id = $1", [parent.id])).rejects.toThrow();
    expect((await repository.updateAsset(owner, parent.id, { pinned: false, credits: null }))?.pinned).toBe(false);
    expect(await repository.deleteAsset(other, parent.id)).toBeNull();
    expect((await repository.deleteAsset(owner, parent.id))?.thumbnailArtifactId).toBe("artifact:thumb1234");
    expect((await repository.getAsset(owner, child.id))?.parentAssetId).toBeNull();
    await expect(repository.createAsset({ ...asset, kind: "PHOTO" as never })).rejects.toThrow();
  });

  it("appends the activity feed newest first per pane and request", async () => {
    await repository.createEvent({ ownerUserId: owner, paneId: "pane:video-a", requestId: "vreq:feed1234", assetId: null, type: "JOB_STARTED", message: "Transcribing", payload: { op: "transcribe" } });
    await repository.createEvent({ ownerUserId: owner, paneId: "pane:video-a", requestId: "vreq:feed1234", assetId: null, type: "DELIVERED", message: "Delivered", payload: { assets: 1 } });
    expect((await repository.listEvents(owner, { requestId: "vreq:feed1234", limit: 10 })).map((row) => row.type)).toEqual(["DELIVERED", "JOB_STARTED"]);
    expect(await repository.listEvents(other, { paneId: "pane:video-a", limit: 10 })).toEqual([]);
  });
});
