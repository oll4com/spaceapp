// The Design pane's operator routes (plan clipboard:URdc3U314lUH, P4): settings and view, the Studio's render and generate, the
// library, requests and brand kits; a 409 on other pane modes and the owner's own media only.
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemorySpaceStore, SpaceEventBus } from "@space/runtime";
import type { Event } from "@space/contracts";
import { createApp } from "../src/app.js";
import { cliBrowserBridgeTokenHeader, issueCliBrowserBridgeToken } from "../src/cli-browser-bridge.js";
import { getApiConfig } from "../src/config.js";
import type { DesignRenderInput } from "../src/design/service.js";
import { pngOf } from "./fixtures/design-png.js";

vi.setConfig({ testTimeout: 30_000 });
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "space-design-routes-"));
  roots.push(root);
  // No Design gateway key: generation answers DESIGN_ENGINE_UNAVAILABLE while templates work.
  const config = getApiConfig({ SPACE_ARTIFACT_ROOT: root, SPACE_DESIGN_GATEWAY_KEY_FILE: join(root, "missing.key"), SPACE_LOG_LEVEL: "silent" });
  const store = new InMemorySpaceStore();
  const eventBus = new SpaceEventBus();
  const roomEvents: Event[] = [];
  eventBus.subscribe((event) => { if (event.type === "DESIGN_UPDATED" || event.type === "ARTIFACT_CREATED") roomEvents.push(event); });
  const renders: DesignRenderInput[] = [];
  const app = await createApp({ store, config, eventBus, jobApplyMailTriage: false, marketingCopilotScheduler: false,
    designRender: async (_owner, input) => { renders.push(input); return { bytes: pngOf(input.width, input.height), mimeType: "image/png", width: input.width, height: input.height }; },
    designKickoff: async () => undefined,
    auth: { sessionSecret: "test-secret-with-enough-length", devLogin: true, secureCookies: false } });
  const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "space@space.local", password: "space-dev" } });
  const cookie = `space_session=${login.cookies.find((entry) => entry.name === "space_session")?.value}`;
  const csrf = await app.inject({ method: "GET", url: "/api/auth/csrf", headers: { cookie } });
  const headers = { cookie, "x-space-csrf-token": csrf.json().csrfToken as string };
  const room = (await app.inject({ method: "POST", url: "/api/rooms", headers, payload: { name: "Design", initialPaneCount: 0 } })).json();
  const pane = store.createPane({ roomId: room.id, title: "Design", mode: "DESIGN", terminalRuntimeId: "cli:claude" });
  return { app, store, room, pane, headers, renders, roomEvents, url: `/api/panes/${encodeURIComponent(pane.id)}/design` };
}

describe("Design pane routes", () => {
  it("keeps the pane's settings and view, and answers 409 on other panes", async () => {
    const { app, store, room, headers, url } = await fixture();
    try {
      const settings = await app.inject({ method: "GET", url: `${url}/settings`, headers });
      expect(settings.json().metadata.settings).toMatchObject({ defaultFormatId: "square", requestAutonomy: "AUTO", brandKitId: "dbrand:spaceapp" });
      const updated = await app.inject({ method: "PUT", url: `${url}/settings`, headers, payload: { version: 1, settings: { requestAutonomy: "APPROVAL", defaultFormatId: "linkedin-banner" } } });
      expect(updated.statusCode).toBe(200);
      expect(updated.json().metadata.settings).toMatchObject({ requestAutonomy: "APPROVAL", defaultFormatId: "linkedin-banner", paused: false });
      expect((await app.inject({ method: "PUT", url: `${url}/settings`, headers, payload: { version: 1, settings: { brandKitId: "dbrand:missing1" } } })).statusCode).toBe(404);
      expect((await app.inject({ method: "PUT", url: `${url}/settings`, headers, payload: { version: 1, settings: { canvas: true } } })).statusCode).toBe(422);
      const view = await app.inject({ method: "PUT", url: `${url}/view`, headers, payload: { tab: "LIBRARY", formatId: "x" } });
      expect(view.json().view).toMatchObject({ tab: "LIBRARY", formatId: "x", requestId: null });
      // Settings saved later keep the view.
      await app.inject({ method: "PUT", url: `${url}/settings`, headers, payload: { version: 1, settings: { paused: true } } });
      const browser = store.createPane({ roomId: room.id, title: "Browser", mode: "BROWSER" });
      expect((await app.inject({ method: "GET", url: `/api/panes/${encodeURIComponent(browser.id)}/design/settings`, headers })).statusCode).toBe(409);
      expect((await app.inject({ method: "GET", url: `${url}/settings` })).statusCode).toBe(401);
      expect((await app.inject({ method: "GET", url: "/api/design/formats", headers })).json().formats).toContainEqual(expect.objectContaining({ id: "yt-banner", networkLabel: "YouTube" }));
    } finally { await app.close(); }
  });

  it("renders templates into pinned Media assets, lists and deletes them, and refuses generation without the gateway key", async () => {
    const { app, store, pane, headers, renders, roomEvents, url } = await fixture();
    try {
      const sizes: Array<[string, number, number]> = [["x", 1600, 900], ["story", 1080, 1920], ["linkedin-banner", 1584, 396]];
      const ids: string[] = [];
      for (const [formatId, width, height] of sizes) {
        const response = await app.inject({ method: "POST", url: `${url}/render`, headers, payload: { templateId: "gradient-headline", formatId, params: { headline: "SpaceApp" } } });
        expect(response.statusCode).toBe(200);
        expect(response.json().asset).toMatchObject({ formatId, width, height, engine: "TEMPLATE", mimeType: "image/png", pinned: true });
        ids.push(response.json().asset.id);
        expect(store.getArtifact(response.json().asset.artifactId)).toMatchObject({ kind: "IMAGE", roomId: pane.roomId, paneId: pane.id, expiresAt: null });
      }
      expect(renders.map((input) => [input.width, input.height, input.safeArea?.left])).toEqual([[1600, 900, 0], [1080, 1920, 60], [1584, 396, 420]]);
      expect(roomEvents.some((event) => event.type === "ARTIFACT_CREATED")).toBe(true);
      expect(roomEvents.some((event) => event.type === "DESIGN_UPDATED" && event.paneId === pane.id)).toBe(true);
      expect((await app.inject({ method: "POST", url: `${url}/render`, headers, payload: { templateId: "nope", formatId: "x" } })).statusCode).toBe(422);
      expect((await app.inject({ method: "POST", url: `${url}/render`, headers, payload: { templateId: "quote-card", formatId: "custom-10x10" } })).statusCode).toBe(422);

      expect((await app.inject({ method: "GET", url: `${url}/assets?network=LINKEDIN`, headers })).json().assets.map((asset: { id: string }) => asset.id)).toEqual([ids[2]]);
      const variants = await app.inject({ method: "POST", url: `${url}/assets/${encodeURIComponent(ids[0]!)}/variants`, headers, payload: { formatIds: ["og", "square"] } });
      expect(variants.json().assets.map((asset: { formatId: string; parentAssetId: string }) => [asset.formatId, asset.parentAssetId])).toEqual([["og", ids[0]], ["square", ids[0]]]);
      expect((await app.inject({ method: "DELETE", url: `${url}/assets/${encodeURIComponent(ids[1]!)}`, headers })).json()).toEqual({ deleted: true });
      expect((await app.inject({ method: "DELETE", url: `${url}/assets/${encodeURIComponent(ids[1]!)}`, headers })).statusCode).toBe(404);

      // A cropped version from the Studio's editor: typed by its bytes, kept as a version of the original.
      const boundary = "----studio-crop";
      const form = (fields: Record<string, string>, bytes: Buffer) => Buffer.concat([
        ...Object.entries(fields).map(([name, value]) => Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`)),
        Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="design.png"\r\nContent-Type: image/png\r\n\r\n`), bytes, Buffer.from(`\r\n--${boundary}--\r\n`)]);
      const multipart = { ...headers, "content-type": `multipart/form-data; boundary=${boundary}` };
      const cropped = await app.inject({ method: "POST", url: `${url}/assets`, headers: multipart, payload: form({ formatId: "custom-800x450", parentAssetId: ids[0]! }, pngOf(800, 450)) });
      expect(cropped.statusCode).toBe(200);
      // It inherits what its original shows; the operator made it.
      expect(cropped.json().asset).toMatchObject({ engine: "UPLOAD", formatId: "custom-800x450", width: 800, height: 450, parentAssetId: ids[0],
        description: 'Template gradient-headline: headline "SpaceApp"', madeBy: { by: "OPERATOR", runtimeId: null, model: null } });
      expect((await app.inject({ method: "POST", url: `${url}/assets`, headers: multipart, payload: form({ formatId: "x" }, Buffer.from("<svg/>")) })).statusCode).toBe(409);

      const generate = await app.inject({ method: "POST", url: `${url}/generate`, headers, payload: { engine: "NANO_BANANA", prompt: "A calm orbit", formatId: "square" } });
      expect(generate.statusCode).toBe(503);
      expect(generate.json().error.code).toBe("DESIGN_ENGINE_UNAVAILABLE");
      expect((await app.inject({ method: "POST", url: `${url}/generate`, headers, payload: { engine: "TEMPLATE", prompt: "x", formatId: "square" } })).statusCode).toBe(422);
    } finally { await app.close(); }
  });

  it("queues the operator's own requests, delivers them from the Studio and manages brand kits", async () => {
    const { app, headers, url } = await fixture();
    try {
      const created = await app.inject({ method: "POST", url: `${url}/requests`, headers, payload: { brief: "Banner for the docs", formatIds: ["blog-hero"] } });
      expect(created.statusCode).toBe(200);
      const requestId = created.json().request.id as string;
      expect(created.json().request).toMatchObject({ requester: { kind: "OPERATOR", label: "You" }, status: "QUEUED" });
      expect((await app.inject({ method: "GET", url: `${url}/requests`, headers })).json().requests.map((entry: { id: string }) => entry.id)).toEqual([requestId]);
      const asset = (await app.inject({ method: "POST", url: `${url}/render`, headers, payload: { templateId: "wide-banner", formatId: "blog-hero", requestId } })).json().asset;
      const delivered = await app.inject({ method: "POST", url: `${url}/requests/${encodeURIComponent(requestId)}/deliver`, headers, payload: { assetIds: [asset.id] } });
      expect(delivered.json()).toMatchObject({ request: { status: "DELIVERED" }, assets: [{ assetId: asset.id, artifactId: asset.artifactId, label: "Blog hero", width: 1600, height: 900 }] });
      const detail = (await app.inject({ method: "GET", url: `${url}/requests/${encodeURIComponent(requestId)}`, headers })).json();
      expect(detail.events.map((event: { type: string }) => event.type)).toContain("DELIVERED");
      expect((await app.inject({ method: "POST", url: `${url}/requests/${encodeURIComponent(requestId)}/cancel`, headers })).statusCode).toBe(409);

      const kits = await app.inject({ method: "GET", url: "/api/design/brand-kits", headers });
      expect(kits.json().brandKits.map((kit: { id: string; builtIn: boolean }) => [kit.id, kit.builtIn])).toEqual([["dbrand:spaceapp", true]]);
      const kit = (await app.inject({ method: "POST", url: "/api/design/brand-kits", headers, payload: { name: "oll4", colors: { background: "#101010", surface: "#202020", text: "#FFFFFF", primary: "#FF8800", accent: "#FFAA44" },
        fonts: { heading: "Inter", body: "Inter" }, logos: [], voice: null } })).json().brandKit;
      expect(kit).toMatchObject({ name: "oll4", builtIn: false });
      expect((await app.inject({ method: "PUT", url: `/api/design/brand-kits/${encodeURIComponent(kit.id)}`, headers, payload: { name: "oll4 studio" } })).json().brandKit.name).toBe("oll4 studio");
      expect((await app.inject({ method: "PUT", url: "/api/design/brand-kits/dbrand:spaceapp", headers, payload: { name: "Mine" } })).statusCode).toBe(409);
      expect((await app.inject({ method: "DELETE", url: "/api/design/brand-kits/dbrand:spaceapp", headers })).statusCode).toBe(409);
      expect((await app.inject({ method: "POST", url: "/api/design/brand-kits", headers, payload: { name: "Bad", colors: { background: "red" }, fonts: { heading: "Inter", body: "Inter" }, logos: [], voice: null } })).statusCode).toBe(422);
      expect((await app.inject({ method: "POST", url: "/api/design/brand-kits", headers, payload: { name: "Logo", colors: kit.colors, fonts: kit.fonts, logos: ["artifact:notmine1"], voice: null } })).statusCode).toBe(404);
      expect((await app.inject({ method: "DELETE", url: `/api/design/brand-kits/${encodeURIComponent(kit.id)}`, headers })).json()).toEqual({ deleted: true });
    } finally { await app.close(); }
  });
});

describe("Design agent bridge", () => {
  it("lets any CLI pane request a design and read the brand kits, keeps worker tools to the Design pane, and types uploads by their bytes", async () => {
    const root = await mkdtemp(join(tmpdir(), "space-design-bridge-"));
    roots.push(root);
    const wrapper = join(root, "codex-vscode-parity");
    await writeFile(wrapper, "#!/bin/sh\nexit 0\n", "utf8");
    await chmod(wrapper, 0o755);
    const config = getApiConfig({
      SPACE_CLI_ENABLED: "true", SPACE_CLI_COMMAND_PATH: root, SPACE_CLI_HOST_SOCKET: join(root, "pane-host.sock"), SPACE_CLI_CODEX_CREDENTIAL_SMOKE: "true",
      SPACE_CLI_WORKSPACE_ROOT: join(root, "workspaces"), SPACE_BROWSER_TOOL_BRIDGE_ENABLED: "true", SPACE_INTERNAL_API_TOKEN: "internal-token-for-design-bridge-tests", SPACE_ARTIFACT_ROOT: root, SPACE_LOG_LEVEL: "silent"
    });
    const store = new InMemorySpaceStore();
    const kickoffs: string[] = [];
    const app = await createApp({ store, config, jobApplyMailTriage: false, marketingCopilotScheduler: false, designKickoff: async (pane) => { kickoffs.push(pane.id); },
      designRender: async (_owner, input) => ({ bytes: pngOf(input.width, input.height), mimeType: "image/png", width: input.width, height: input.height }),
      auth: { sessionSecret: "test-secret-with-enough-length", devLogin: true, secureCookies: false } });
    try {
      const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "space@space.local", password: "space-dev" } });
      const cookie = `space_session=${login.cookies.find((entry) => entry.name === "space_session")?.value}`;
      const csrf = await app.inject({ method: "GET", url: "/api/auth/csrf", headers: { cookie } });
      const room = (await app.inject({ method: "POST", url: "/api/rooms", headers: { cookie, "x-space-csrf-token": csrf.json().csrfToken }, payload: { name: "Work", initialPaneCount: 0 } })).json();
      const tokenFor = (paneId: string, roomId: string = room.id) => {
        const session = store.createPaneCliSession({ paneId, roomId, runtimeId: "cli:codex", providerId: "codex", agentId: "codex", status: "RUNNING", purpose: "NORMAL" });
        return { [cliBrowserBridgeTokenHeader]: issueCliBrowserBridgeToken(config, { roomId, paneId, cliSessionId: session.sessionId })! };
      };
      const shell = store.createPane({ roomId: room.id, title: "Codex CLI", mode: "TERMINAL", terminalRuntimeId: "cli:codex" });
      const design = store.createPane({ roomId: room.id, title: "Design", mode: "DESIGN", terminalRuntimeId: "cli:codex" });
      const requester = { ...tokenFor(shell.id), "content-type": "application/json" };
      const designToken = tokenFor(design.id);
      const worker = { ...designToken, "content-type": "application/json" };
      const cli = "/api/cli/design";

      expect((await app.inject({ method: "GET", url: `${cli}/formats` })).statusCode).toBe(401);
      expect((await app.inject({ method: "GET", url: `${cli}/formats`, headers: requester })).json().templates).toHaveLength(8);
      const created = (await app.inject({ method: "POST", url: `${cli}/requests`, headers: requester, payload: { brief: "X post for the release", formatIds: ["x"] } })).json();
      expect(created).toMatchObject({ designPaneId: design.id, runStarted: true, request: { requester: { kind: "PANE", paneId: shell.id, label: expect.stringContaining("Codex CLI") } } });
      expect(kickoffs).toEqual([design.id]);
      expect((await app.inject({ method: "POST", url: `${cli}/next`, headers: requester, payload: {} })).statusCode).toBe(409);
      // Every agent picks a brand kit for its requests, like the operator in the Studio.
      expect((await app.inject({ method: "GET", url: `${cli}/brand-kits`, headers: requester })).json().brandKits).toEqual(expect.arrayContaining([expect.objectContaining({ id: "dbrand:spaceapp" })]));

      const next = (await app.inject({ method: "POST", url: `${cli}/next`, headers: worker, payload: {} })).json();
      expect(next).toMatchObject({ done: false, request: { id: created.request.id }, formats: [{ id: "x", width: 1600, height: 900 }] });
      // Every design the agent makes names the model that made it.
      expect((await app.inject({ method: "POST", url: `${cli}/render`, headers: worker, payload: { templateId: "photo-headline", formatId: "x", params: { headline: "0.3" } } })).statusCode).toBe(422);
      const rendered = (await app.inject({ method: "POST", url: `${cli}/render`, headers: worker, payload: { templateId: "photo-headline", formatId: "x", params: { headline: "0.3" }, requestId: created.request.id,
        madeByModel: "gpt-6-astra" } })).json();
      expect(rendered.asset).toMatchObject({ description: 'Template photo-headline: headline "0.3"', madeBy: { by: "AGENT", runtimeId: "cli:codex", model: "gpt-6-astra" } });

      const boundary = "----design-test";
      const multipart = (fields: Record<string, string>, filename: string, bytes: Buffer) => Buffer.concat([
        ...Object.entries(fields).map(([name, value]) => Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`)),
        Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`), bytes, Buffer.from(`\r\n--${boundary}--\r\n`)
      ]);
      const mp4 = Buffer.alloc(64); mp4.write("ftypisom", 4, "ascii");
      const uploadHeaders = { ...designToken, "content-type": `multipart/form-data; boundary=${boundary}` };
      const about = { description: "Release motion: the 0.3 headline over the orbit, 6 s loop", madeByModel: "gpt-6.1-sol" };
      const uploaded = await app.inject({ method: "POST", url: `${cli}/assets`, headers: uploadHeaders,
        // Every field space_design_save_asset sends (8, over the multipart plugin's default of 4).
        payload: multipart({ formatId: "x", engine: "MOTION", label: "Release motion", prompt: "Release motion, 6 s loop", requestId: created.request.id, parentAssetId: rendered.asset.id, ...about }, "release.mp4", mp4) });
      expect(uploaded.statusCode).toBe(200);
      expect(uploaded.json().asset).toMatchObject({ mimeType: "video/mp4", engine: "MOTION", width: 1600, height: 900, label: "Release motion", prompt: "Release motion, 6 s loop", parentAssetId: rendered.asset.id,
        description: about.description, madeBy: { by: "AGENT", runtimeId: "cli:codex", model: "gpt-6.1-sol" } });
      expect(store.getArtifact(uploaded.json().asset.artifactId)).toMatchObject({ kind: "VIDEO", roomId: room.id });
      // An upload without what it shows or without the model is refused.
      expect((await app.inject({ method: "POST", url: `${cli}/assets`, headers: uploadHeaders, payload: multipart({ formatId: "x", madeByModel: "gpt-6.1-sol" }, "hero.png", pngOf(1600, 900)) })).statusCode).toBe(422);
      expect((await app.inject({ method: "POST", url: `${cli}/assets`, headers: uploadHeaders, payload: multipart({ formatId: "x", description: "Hero" }, "hero.png", pngOf(1600, 900)) })).statusCode).toBe(422);
      const svg = await app.inject({ method: "POST", url: `${cli}/assets`, headers: uploadHeaders,
        payload: multipart({ formatId: "x", ...about }, "logo.png", Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>")) });
      expect(svg.statusCode).toBe(409);

      const delivered = (await app.inject({ method: "POST", url: `${cli}/deliver`, headers: worker, payload: { requestId: created.request.id, assetIds: [rendered.asset.id, uploaded.json().asset.id] } })).json();
      expect(delivered.request.status).toBe("DELIVERED");
      const waited = (await app.inject({ method: "POST", url: `${cli}/requests/${encodeURIComponent(created.request.id)}/wait`, headers: requester, payload: { waitMs: 0 } })).json();
      expect(waited.assets.map((asset: { artifactId: string }) => asset.artifactId).sort()).toEqual([rendered.asset.artifactId, uploaded.json().asset.artifactId].sort());
      // The requester sees what each design shows, who made it and whether its measured size is the format's (not read for video).
      expect(waited.assets).toEqual(expect.arrayContaining([
        expect.objectContaining({ assetId: rendered.asset.id, matchesFormat: true, description: 'Template photo-headline: headline "0.3"', madeBy: { by: "AGENT", runtimeId: "cli:codex", model: "gpt-6-astra" }, replacedBy: null }),
        expect.objectContaining({ assetId: uploaded.json().asset.id, matchesFormat: null, description: about.description })]));
      // space_design_asset_file: the designer reads an asset's bytes, typed by the stored type, only from its own room; a requester only
      // what its own delivered requests carry.
      const assetFile = (id: string) => `${cli}/assets/${encodeURIComponent(id)}/file`;
      const file = await app.inject({ method: "GET", url: assetFile(rendered.asset.id), headers: designToken });
      expect(file.statusCode).toBe(200);
      expect(file.headers["content-type"]).toMatch(/^image\/png/);
      expect(file.rawPayload.subarray(1, 4).toString()).toBe("PNG");
      const requesterFile = await app.inject({ method: "GET", url: assetFile(rendered.asset.id), headers: tokenFor(shell.id) });
      expect(requesterFile.statusCode).toBe(200);
      expect(requesterFile.rawPayload.subarray(1, 4).toString()).toBe("PNG");
      const elsewhere = store.createRoom({ name: "Studio", initialPaneCount: 0 }, "trace:room", room.ownerUserId);
      const otherDesign = store.createPane({ roomId: elsewhere.id, title: "Design", mode: "DESIGN", terminalRuntimeId: "cli:codex" });
      expect((await app.inject({ method: "GET", url: assetFile(rendered.asset.id), headers: tokenFor(otherDesign.id, elsewhere.id) })).statusCode).toBe(404);
      expect((await app.inject({ method: "GET", url: assetFile("dasset:missing1"), headers: designToken })).statusCode).toBe(404);
      // Another pane's request stays private to it.
      const other = store.createPane({ roomId: room.id, title: "Claude", mode: "TERMINAL", terminalRuntimeId: "cli:codex" });
      expect((await app.inject({ method: "GET", url: `${cli}/requests/${encodeURIComponent(created.request.id)}`, headers: tokenFor(other.id) })).statusCode).toBe(404);
      expect((await app.inject({ method: "GET", url: assetFile(rendered.asset.id), headers: tokenFor(other.id) })).statusCode).toBe(404);
    } finally { await app.close(); }
  });
});
