// The Design pane's request loop on the service (plan clipboard:URdc3U314lUH, P4): routing to a Design pane of the owner's
// rooms (the requester's room first), the queue without a pane, one kickoff for back-to-back requests, AUTO delivery and the
// APPROVAL gate, the Marketing callback, questions, failures, pins of library assets and the notifications they raise.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultDesignPaneMetadata, type Pane } from "@space/contracts";
import { InMemoryDesignRepository } from "@space/db";
import { InMemorySpaceStore } from "@space/runtime";
import { createDesignService, type DesignRenderInput } from "../src/design/service.js";
import { imageDimensions, sniffDesignMime } from "../src/design/images.js";
import { pngOf } from "./fixtures/design-png.js";

const owner = "user:design-owner";
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function fixture() {
  const artifactRoot = await mkdtemp(join(tmpdir(), "space-design-run-"));
  roots.push(artifactRoot);
  const store = new InMemorySpaceStore();
  const requesterRoom = store.createRoom({ name: "Work", initialPaneCount: 0 }, "trace:room", owner);
  const designRoom = store.createRoom({ name: "Studio", initialPaneCount: 0 }, "trace:room", owner);
  const requester = store.createPane({ roomId: requesterRoom.id, title: "Codex CLI", mode: "TERMINAL", terminalRuntimeId: "cli:codex" });
  const notifications: Array<{ action: "raise" | "resolve"; key: string; severity?: string; kind?: string }> = [];
  const kickoffs: string[] = [];
  const renders: DesignRenderInput[] = [];
  const attached: Array<{ postId: string; assets: Array<{ artifactId: string; label: string }> }> = [];
  const repository = new InMemoryDesignRepository();
  const service = createDesignService({
    repository, store, artifactRoot, brandRoot: "/opt/spaceapp/apps/web/public/brand",
    roomOwner: async (roomId) => store.getRoom(roomId).ownerUserId ?? null,
    render: async (_owner, input) => { renders.push(input); return { bytes: pngOf(input.width, input.height), mimeType: "image/png", width: input.width, height: input.height }; },
    generate: async (input) => ({ bytes: pngOf(1024, 576), mimeType: "image/png", model: "gemini-3.1-flash-image", text: null }),
    attachToMarketingPost: async (_owner, postId, assets) => { attached.push({ postId, assets }); },
    marketingPostExists: async (_owner, postId) => postId === "mktpost:post123",
    kickoff: { ready: async () => true, send: async (pane) => { kickoffs.push(pane.id); } },
    notifications: {
      raise: async (input) => { notifications.push({ action: "raise", key: input.dedupeKey!, severity: input.severity, kind: input.kind }); return {} as never; },
      resolve: async (_owner, key) => { notifications.push({ action: "resolve", key }); return 1; }
    }
  });
  const openDesign = (roomId = designRoom.id) => store.createPane({ roomId, title: "Design", mode: "DESIGN", terminalRuntimeId: "cli:claude" });
  const fromPane = { kind: "PANE" as const, paneId: requester.id, roomId: requesterRoom.id, label: "Codex CLI" };
  return { store, repository, service, requesterRoom, designRoom, requester, fromPane, notifications, kickoffs, renders, attached, openDesign };
}

describe("Design pane request loop", () => {
  it("reads the bytes, never the declared type, and their pixel size", () => {
    expect(sniffDesignMime(pngOf(1600, 900))).toBe("image/png");
    expect(imageDimensions(pngOf(1600, 900))).toEqual({ width: 1600, height: 900 });
    expect(sniffDesignMime(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>"))).toBeNull();
    expect(sniffDesignMime(Buffer.from("GIF89a\x10\x00\x20\x00", "latin1"))).toBe("image/gif");
    expect(imageDimensions(Buffer.from("GIF89a\x10\x00\x20\x00", "latin1"))).toEqual({ width: 16, height: 32 });
    const mp4 = Buffer.alloc(16); mp4.write("ftypisom", 4, "ascii");
    expect(sniffDesignMime(mp4)).toBe("video/mp4");
  });

  it("queues a request without a Design pane, raises 'Open a Design pane', and the first pane that opens takes it", async () => {
    const { service, fromPane, notifications, kickoffs, openDesign } = await fixture();
    const created = await service.createRequest(owner, fromPane, { brief: "LinkedIn banner for the 0.3 release", formatIds: ["linkedin-banner"], referenceArtifactIds: [] });
    expect(created).toMatchObject({ designPaneId: null, runStarted: false, request: { status: "QUEUED", formatIds: ["linkedin-banner"] } });
    expect(notifications).toEqual([{ action: "raise", key: `design:queued:${created.request.id}`, severity: "ATTENTION", kind: "DESIGN_QUEUED" }]);
    const pane = openDesign();
    const next = await service.takeNext(owner, pane);
    expect(next).toMatchObject({ done: false, request: { id: created.request.id, status: "TAKEN", designPaneId: pane.id }, formats: [{ id: "linkedin-banner", width: 1584, height: 396 }],
      engine: "NANO_BANANA", brandKit: { id: "dbrand:spaceapp" } });
    expect(notifications.at(-1)).toEqual({ action: "resolve", key: `design:queued:${created.request.id}` });
    expect(await service.takeNext(owner, pane)).toMatchObject({ done: true });
    expect(kickoffs).toEqual([]);
  });

  it("routes to the requester's room first, defaults the format to the pane's, and sends one kickoff for back-to-back requests", async () => {
    const { store, service, fromPane, requesterRoom, kickoffs, openDesign } = await fixture();
    openDesign();
    const sameRoom = openDesign(requesterRoom.id);
    const metadata = defaultDesignPaneMetadata();
    metadata.settings.defaultFormatId = "x";
    store.updateDesignMetadata(sameRoom.id, metadata);
    const [first, second] = await Promise.all([
      service.createRequest(owner, fromPane, { brief: "Post graphic", formatIds: [], referenceArtifactIds: [] }),
      service.createRequest(owner, fromPane, { brief: "Another one", formatIds: [], referenceArtifactIds: [] })
    ]);
    expect([first.designPaneId, second.designPaneId]).toEqual([sameRoom.id, sameRoom.id]);
    expect(first.request.formatIds).toEqual(["x"]);
    expect(kickoffs).toEqual([sameRoom.id]);
    // While the designer works on one, new requests wait for its loop instead of a second kickoff.
    await service.takeNext(owner, store.getPane(sameRoom.id));
    await service.createRequest(owner, fromPane, { brief: "Third", formatIds: [], referenceArtifactIds: [] });
    expect(kickoffs).toEqual([sameRoom.id]);
    await expect(service.createRequest(owner, fromPane, { brief: "x", formatIds: [], referenceArtifactIds: [], designPaneId: "pane:missing1" })).rejects.toThrow(/not found/);
    await expect(service.createRequest(owner, fromPane, { brief: "x", formatIds: [], referenceArtifactIds: [], callback: { kind: "MARKETING_POST", postId: "mktpost:nopost1" } })).rejects.toThrow(/not found/);
  });

  it("delivers AUTO with pinned Media assets, attaches them to a Marketing post and raises 'delivered'", async () => {
    const { store, service, fromPane, notifications, renders, attached, openDesign } = await fixture();
    const pane = openDesign();
    const created = await service.createRequest(owner, fromPane, { brief: "X post for the release", formatIds: ["x", "linkedin"], referenceArtifactIds: [],
      callback: { kind: "MARKETING_POST", postId: "mktpost:post123" } });
    const next = await service.takeNext(owner, pane);
    if (next.done) throw new Error("expected a request");
    const generated = await service.generateImage(owner, pane, { engine: "NANO_BANANA", prompt: "Orbit of terminals", formatId: "x", requestId: created.request.id });
    expect(generated.asset).toMatchObject({ engine: "NANO_BANANA", model: "gemini-3.1-flash-image", width: 1024, height: 576, pinned: true });
    const assets = [];
    for (const format of next.formats) {
      assets.push(await service.render(owner, pane, { templateId: "photo-headline", formatId: format.id, params: { headline: "SpaceApp 0.3" }, backgroundAssetId: generated.asset.id, requestId: created.request.id }));
    }
    expect(renders.map((input) => [input.width, input.height])).toEqual([[1600, 900], [1200, 627]]);
    expect(renders[0]).toMatchObject({ templateId: "photo-headline", params: { headline: "SpaceApp 0.3" }, imagePaths: { background: expect.stringContaining("design-x.png"), logo: "/opt/spaceapp/apps/web/public/brand/spaceapp-logo.svg" } });
    expect(assets[0]).toMatchObject({ width: 1600, height: 900, templateId: "photo-headline", parentAssetId: generated.asset.id, params: { values: { headline: "SpaceApp 0.3" }, backgroundAssetId: generated.asset.id } });
    const artifact = store.getArtifact(assets[0]!.artifactId);
    expect(artifact).toMatchObject({ kind: "IMAGE", mimeType: "image/png", roomId: pane.roomId, expiresAt: null });
    expect(artifact.pinnedAt).not.toBeNull();
    expect((await service.request(owner, created.request.id)).request.status).toBe("IN_PROGRESS");

    const delivered = await service.deliver(owner, pane, created.request.id, { assetIds: assets.map((asset) => asset.id), message: "Two sizes" });
    expect(delivered.request).toMatchObject({ status: "DELIVERED", message: "Two sizes" });
    expect(delivered.assets.map((asset) => [asset.artifactId, asset.width]).sort()).toEqual(assets.map((asset) => [asset.artifactId, asset.width]).sort());
    expect(attached).toEqual([{ postId: "mktpost:post123", assets: expect.arrayContaining([{ artifactId: assets[0]!.artifactId, label: "X post" }, { artifactId: assets[1]!.artifactId, label: "LinkedIn post" }]) }]);
    expect(notifications.filter((entry) => entry.action === "raise")).toEqual([{ action: "raise", key: `design:ready:${created.request.id}`, severity: "INFO", kind: "DESIGN_READY" }]);
    await expect(service.deliver(owner, pane, created.request.id, { assetIds: [assets[0]!.id] })).rejects.toThrow(/DELIVERED/);

    // A text edit re-renders the stored template; "Also make" another format keeps the chain of versions.
    const [edited] = await service.variants(owner, pane, assets[0]!.id, { params: { headline: "SpaceApp 0.3 is out" } });
    expect(edited).toMatchObject({ parentAssetId: assets[0]!.id, formatId: "x", params: { values: { headline: "SpaceApp 0.3 is out" } } });
    const [story] = await service.variants(owner, pane, generated.asset.id, { formatIds: ["story"] });
    expect(story).toMatchObject({ formatId: "story", width: 1080, height: 1920, templateId: "photo-headline", parentAssetId: generated.asset.id });
    expect((await service.listAssets(owner, { network: "INSTAGRAM", limit: 10 })).map((asset) => asset.id)).toEqual([story!.id]);

    // Leaving the library unpins the artifact: it expires like any other Media file.
    await service.deleteAsset(owner, story!.id);
    expect(store.getArtifact(story!.artifactId)).toMatchObject({ pinnedAt: null });
    expect(store.getArtifact(story!.artifactId).expiresAt).not.toBeNull();
  });

  it("holds deliveries under APPROVAL until the operator's yes, and handles questions, failures and cancellations", async () => {
    const { store, service, fromPane, notifications, openDesign } = await fixture();
    const pane = openDesign();
    const metadata = defaultDesignPaneMetadata();
    metadata.settings.requestAutonomy = "APPROVAL";
    const approvalPane = store.updateDesignMetadata(pane.id, metadata);
    const created = await service.createRequest(owner, fromPane, { brief: "Story", formatIds: ["story"], referenceArtifactIds: [] });
    await service.takeNext(owner, approvalPane);
    const asset = await service.render(owner, approvalPane, { templateId: "gradient-headline", formatId: "story", params: { headline: "Hi" }, requestId: created.request.id });
    const asked = await service.ask(owner, approvalPane, created.request.id, "Dark or light background?");
    expect(asked.request).toMatchObject({ question: "Dark or light background?", answer: null });
    expect(notifications.at(-1)).toMatchObject({ action: "raise", key: `design:question:${created.request.id}` });
    await service.answer(owner, created.request.id, "Dark");
    expect(notifications.at(-1)).toEqual({ action: "resolve", key: `design:question:${created.request.id}` });
    await expect(service.answer(owner, created.request.id, "Again")).rejects.toThrow(/no open question/);

    const held = await service.deliver(owner, approvalPane, created.request.id, { assetIds: [asset.id] });
    expect(held.request).toMatchObject({ status: "NEEDS_APPROVAL", resultAssetIds: [asset.id] });
    expect(notifications.at(-1)).toMatchObject({ action: "raise", key: `design:approval:${created.request.id}`, severity: "ATTENTION" });
    const approved = await service.approve(owner, created.request.id);
    expect(approved.request.status).toBe("DELIVERED");
    expect(notifications).toContainEqual({ action: "resolve", key: `design:approval:${created.request.id}` });

    const failing = await service.createRequest(owner, fromPane, { brief: "Impossible", formatIds: ["og"], referenceArtifactIds: [] });
    await service.takeNext(owner, approvalPane);
    expect((await service.fail(owner, approvalPane, failing.request.id, "The brief asks for a third party's logo")).request).toMatchObject({ status: "FAILED" });
    expect(notifications.at(-1)).toMatchObject({ action: "raise", key: `design:failed:${failing.request.id}` });
    const cancelled = await service.createRequest(owner, fromPane, { brief: "Never mind", formatIds: ["og"], referenceArtifactIds: [] });
    expect((await service.cancel(owner, cancelled.request.id, "Codex CLI")).request.status).toBe("CANCELLED");
    await expect(service.cancel(owner, cancelled.request.id, "Codex CLI")).rejects.toThrow(/CANCELLED/);
  });

  it("takes nothing while paused and never touches another owner's media", async () => {
    const { store, service, fromPane, kickoffs, openDesign } = await fixture();
    const pane = openDesign();
    const metadata = defaultDesignPaneMetadata();
    metadata.settings.paused = true;
    const paused = store.updateDesignMetadata(pane.id, metadata);
    const created = await service.createRequest(owner, fromPane, { brief: "Square", formatIds: ["square"], referenceArtifactIds: [] });
    expect(created.runStarted).toBe(false);
    expect(kickoffs).toEqual([]);
    expect(await service.takeNext(owner, paused)).toMatchObject({ done: true, paused: true });
    const strangerRoom = store.createRoom({ name: "Other", initialPaneCount: 0 }, "trace:room", "user:someone-else");
    const stranger = store.createArtifact({ roomId: strangerRoom.id, kind: "IMAGE", mimeType: "image/png", storageUri: "space-artifact://user-uploads/x/y.png", sha256: "a".repeat(64), byteSize: 10, metadata: {} });
    await expect(service.createRequest(owner, fromPane, { brief: "Use this", formatIds: ["square"], referenceArtifactIds: [stranger.artifact.id] })).rejects.toThrow(/not found in your rooms/);
    const other: Pane = store.createPane({ roomId: strangerRoom.id, title: "Shell", mode: "TERMINAL", terminalRuntimeId: "cli:codex" });
    await expect(service.takeNext(owner, other)).rejects.toThrow(/Design pane/);
  });
});
