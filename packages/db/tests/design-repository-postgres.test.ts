// Design pane tables on a real, disposable PostgreSQL: migration 0230 applies on top of the full chain (pane metadata CHECK, the
// DESIGN notification source), and the repository round-trips brand kits, requests (routing, the atomic take with stale
// re-queue, guarded transitions), assets (versions, filters, delete) and the activity feed.
// Skips with a reason when Docker or the image is missing.
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { defaultDesignPaneMetadata, SPACEAPP_BRAND_KIT } from "@space/contracts";
import { PostgresDesignRepository } from "../src/design-repository.js";
import { applyPendingMigrations } from "../src/migration-runner.js";
import { loadMigrations } from "../src/migrations.js";
import { disposablePostgresUnavailableReason, startDisposablePostgres, type DisposablePostgres } from "./support/disposable-postgres.js";

const unavailable = disposablePostgresUnavailableReason();
const owner = "user:design";
const other = "user:design-other";

describe.skipIf(unavailable !== null)(`design repository on PostgreSQL${unavailable ? ` (skipped: ${unavailable})` : ""}`, () => {
  let server: DisposablePostgres;
  let pool: pg.Pool;
  let repository: PostgresDesignRepository;

  beforeAll(async () => {
    server = await startDisposablePostgres("design");
    await server.createDatabase("space_design");
    pool = server.pool("space_design", 4);
    const client = await pool.connect();
    try {
      await applyPendingMigrations(client, await loadMigrations());
    } finally {
      client.release();
    }
    await pool.query("INSERT INTO users(id, email, role) VALUES ($1, $2, 'OPERATOR'), ($3, $4, 'OPERATOR')", [owner, "design@space.local", other, "other@space.local"]);
    repository = new PostgresDesignRepository(pool as unknown as ConstructorParameters<typeof PostgresDesignRepository>[0]);
  }, 120_000);

  afterAll(async () => {
    await server?.stop();
  });

  it("adds the pane column with its version CHECK and the DESIGN notification source", async () => {
    const columns = await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name='panes' AND column_name='design_metadata'");
    expect(columns.rowCount).toBe(1);
    const check = await pool.query<{ def: string }>("SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname='panes_design_metadata_object'");
    expect(check.rows[0]?.def).toContain("version");
    expect(JSON.parse(JSON.stringify(defaultDesignPaneMetadata())).version).toBe(1);
    const source = await pool.query<{ def: string }>("SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname='space_notifications_source_check'");
    expect(source.rows[0]?.def).toContain("'DESIGN'");
    expect(source.rows[0]?.def).toContain("'FREELANCE_COPILOT'");
  });

  it("round-trips brand kits per owner and never stores the built-in id", async () => {
    const kit = await repository.createBrandKit({ ownerUserId: owner, name: "oll4", colors: { ...SPACEAPP_BRAND_KIT.colors, primary: "#FF8800" }, fonts: { heading: "Inter", body: "Inter" },
      logos: ["artifact:logo123"], voice: null });
    expect(kit).toMatchObject({ builtIn: false, name: "oll4", colors: { primary: "#FF8800" }, logos: ["artifact:logo123"] });
    expect(await repository.getBrandKit(other, kit.id)).toBeNull();
    expect((await repository.updateBrandKit(owner, kit.id, { name: "oll4 studio" }))?.name).toBe("oll4 studio");
    expect((await repository.listBrandKits(owner)).map((row) => row.id)).toEqual([kit.id]);
    await expect(pool.query("INSERT INTO design_brand_kits(id, owner_user_id, name, colors, fonts) VALUES ('dbrand:spaceapp', $1, 'x', '{}', '{}')", [owner])).rejects.toThrow();
    expect(await repository.deleteBrandKit(other, kit.id)).toBe(false);
    expect(await repository.deleteBrandKit(owner, kit.id)).toBe(true);
  });

  it("queues requests, takes the oldest routed or unrouted one atomically and re-queues stale work", async () => {
    const base = { ownerUserId: owner, requester: { kind: "PANE" as const, paneId: "pane:requester1", roomId: "room:room0001", label: "Codex CLI" }, engine: null, brandKitId: null,
      referenceArtifactIds: [], callback: null };
    const first = await repository.createRequest({ ...base, designPaneId: null, brief: "LinkedIn banner", formatIds: ["linkedin-banner"] });
    const routed = await repository.createRequest({ ...base, designPaneId: "pane:design-b", brief: "For pane B", formatIds: ["x"], callback: { kind: "MARKETING_POST", postId: "mktpost:post123" } });
    expect(first).toMatchObject({ status: "QUEUED", resultAssetIds: [], question: null, takenAt: null, requester: { label: "Codex CLI" } });
    expect(routed.callback).toEqual({ kind: "MARKETING_POST", postId: "mktpost:post123" });
    expect(first).toMatchObject({ templateId: null, params: null });
    const [a, b] = await Promise.all([repository.takeNextRequest(owner, "pane:design-a", 60_000), repository.takeNextRequest(owner, "pane:design-a", 60_000)]);
    expect([a?.id, b?.id].filter(Boolean)).toEqual([first.id]);
    expect(await repository.takeNextRequest(owner, "pane:design-a", 60_000)).toBeNull();
    const takenByB = await repository.takeNextRequest(owner, "pane:design-b", 60_000);
    expect(takenByB).toMatchObject({ id: routed.id, status: "TAKEN", designPaneId: "pane:design-b" });
    expect(takenByB?.takenAt).not.toBeNull();
    await pool.query("UPDATE design_requests SET updated_at = now() - interval '2 hours' WHERE id=$1", [first.id]);
    expect((await repository.takeNextRequest(owner, "pane:design-c", 60_000))?.id).toBe(first.id);
    expect(await repository.updateRequest(owner, first.id, { status: "DELIVERED" }, ["QUEUED"])).toBeNull();
    const delivered = await repository.updateRequest(owner, first.id, { status: "DELIVERED", resultAssetIds: ["dasset:asset123"], message: "Done", deliveredAt: new Date().toISOString() }, ["TAKEN", "IN_PROGRESS"]);
    expect(delivered).toMatchObject({ status: "DELIVERED", resultAssetIds: ["dasset:asset123"], message: "Done" });
    expect((await repository.listRequests(owner, { status: ["TAKEN"], limit: 10 })).map((row) => row.id)).toEqual([routed.id]);
    expect((await repository.listRequests(owner, { requesterPaneId: "pane:requester1", limit: 10 })).length).toBe(2);
    expect(await repository.listRequests(other, { limit: 10 })).toEqual([]);
    // Any number of formats since 31/10 (migration 0275), never none.
    await pool.query("INSERT INTO design_requests(id, owner_user_id, requester, brief, format_ids, status) VALUES ('dreq:manyfmt', $1, '{}', 'x', $2, 'QUEUED')", [owner, Array(9).fill("x")]);
    await expect(pool.query("INSERT INTO design_requests(id, owner_user_id, requester, brief, format_ids, status) VALUES ('dreq:nofmt', $1, '{}', 'x', $2, 'QUEUED')",
      [owner, []])).rejects.toThrow();
    await pool.query("DELETE FROM design_requests WHERE id = 'dreq:manyfmt'");
    // The Studio's template and its fields, as a requester chose them (migration 0233).
    const templated = await repository.createRequest({ ...base, designPaneId: "pane:design-c", brief: "Release card", formatIds: ["x"], templateId: "release-announcement",
      params: { headline: "SpaceApp 0.3", colors: { primary: "#67d9f5" } } });
    expect(await repository.getRequest(owner, templated.id)).toMatchObject({ templateId: "release-announcement", params: { headline: "SpaceApp 0.3", colors: { primary: "#67d9f5" } } });
  });

  it("stores assets with versions and filters, and answers a deleted asset so its artifact can be unpinned", async () => {
    const asset = { ownerUserId: owner, paneId: "pane:design-a", requestId: null, artifactId: "artifact:art12345", formatId: "x", width: 1600, height: 900, mimeType: "image/png" as const,
      engine: "TEMPLATE" as const, model: null, label: "Release", prompt: null, templateId: "photo-headline" as const, params: { headline: "SpaceApp 0.3" }, brandKitId: "dbrand:spaceapp", parentAssetId: null,
      description: 'Template photo-headline: headline "SpaceApp 0.3"', madeBy: { by: "AGENT" as const, runtimeId: "cli:claude", model: "claude-opus-5-5" }, pinned: true };
    const parent = await repository.createAsset(asset);
    const child = await repository.createAsset({ ...asset, artifactId: "artifact:art67890", parentAssetId: parent.id, params: { headline: "SpaceApp 0.3 is out" } });
    expect(child).toMatchObject({ parentAssetId: parent.id, params: { headline: "SpaceApp 0.3 is out" }, width: 1600, pinned: true });
    // What it shows and who made it (migration 0234); later versions by parent.
    expect(parent).toMatchObject({ description: asset.description, madeBy: asset.madeBy });
    expect((await repository.listAssets(owner, { parentIds: [parent.id], limit: 10 })).map((row) => row.id)).toEqual([child.id]);
    await expect(pool.query("UPDATE design_assets SET made_by = '[]'::jsonb WHERE id = $1", [parent.id])).rejects.toThrow();
    expect((await repository.listAssets(owner, { formatIds: ["x"], limit: 10 })).map((row) => row.id)).toEqual([child.id, parent.id]);
    expect(await repository.listAssets(owner, { formatIds: ["story"], limit: 10 })).toEqual([]);
    expect((await repository.listAssets(owner, { ids: [parent.id], limit: 10 })).map((row) => row.id)).toEqual([parent.id]);
    expect((await repository.updateAsset(owner, parent.id, { pinned: false }))?.pinned).toBe(false);
    expect(await repository.deleteAsset(other, parent.id)).toBeNull();
    expect((await repository.deleteAsset(owner, parent.id))?.artifactId).toBe("artifact:art12345");
    expect((await repository.getAsset(owner, child.id))?.parentAssetId).toBeNull();
    await expect(repository.createAsset({ ...asset, mimeType: "image/svg+xml" as never })).rejects.toThrow();
  });

  it("appends the activity feed newest first per pane and request", async () => {
    await repository.createEvent({ ownerUserId: owner, paneId: "pane:design-a", requestId: "dreq:feed1234", assetId: null, type: "REQUEST_TAKEN", message: "Taken", payload: {} });
    await repository.createEvent({ ownerUserId: owner, paneId: "pane:design-a", requestId: "dreq:feed1234", assetId: null, type: "DELIVERED", message: "Delivered", payload: { assets: 1 } });
    expect((await repository.listEvents(owner, { requestId: "dreq:feed1234", limit: 10 })).map((row) => row.type)).toEqual(["DELIVERED", "REQUEST_TAKEN"]);
    expect(await repository.listEvents(other, { paneId: "pane:design-a", limit: 10 })).toEqual([]);
  });
});
