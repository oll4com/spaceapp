import Fastify from "fastify";
import { link, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { dotWorkspacePath, type DotDeliverable } from "@space/contracts";
import type { DotDeliverablesRepository } from "@space/db";
import { createDotDeliverablesService, registerDotDeliverableRoutes, resolveWorkspacePath } from "../src/dot-deliverables.js";

const dotId = `dot:${"d".repeat(32)}`;
const roots: string[] = [];
const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture(options: { maxBytes?: number } = {}) {
  const root = await mkdtemp(join(tmpdir(), "dot-deliverables-")); roots.push(root);
  const workspace = dotWorkspacePath(dotId, root);
  await mkdir(join(workspace, "reports"), { recursive: true });
  await writeFile(join(workspace, "reports", "summary.md"), "# Summary\nAll good.");
  await writeFile(join(workspace, "page.html"), "<script>alert(1)</script>");
  await writeFile(join(root, "secret.txt"), "outside");
  await symlink(join(root, "secret.txt"), join(workspace, "link.txt"));
  const versions: DotDeliverable[] = [];
  let artifacts = 0;
  const deliverables: DotDeliverablesRepository = {
    latest: vi.fn(async (_dot, name) => versions.filter((item) => item.name === name).sort((a, b) => b.version - a.version)[0] ?? null),
    bySource: vi.fn(async (_dot, name, sourceSha256) => versions.find((item) => item.name === name && item.sourceSha256 === sourceSha256) ?? null),
    addVersion: vi.fn(async (input) => {
      const version = { ...input, deliverableId: `dot_deliverable:${String(versions.length + 1).padStart(32, "0")}`,
        version: versions.filter((item) => item.name === input.name).length + 1, createdAt: "2026-10-11T09:00:00.000Z" };
      delete (version as Record<string, unknown>).ownerUserId;
      versions.push(version as DotDeliverable); return version as DotDeliverable;
    }),
    list: vi.fn(async () => versions),
    dispose: vi.fn(async () => undefined)
  };
  const publishArtifact = vi.fn(async (input: { roomId: string; filename: string; mimeType: string; buffer: Buffer }) => ({
    id: `artifact:${++artifacts}`, sha256: (await import("node:crypto")).createHash("sha256").update(input.buffer).digest("hex"),
    byteSize: input.buffer.byteLength, mimeType: input.mimeType }) as never);
  const service = createDotDeliverablesService({
    store: { getRoom: vi.fn(async (roomId: string) => roomId === "room:own" ? { id: roomId, ownerUserId: "user:1" } : { id: roomId, ownerUserId: "user:2" }) } as never,
    dots: { get: vi.fn(async (owner: string, id: string) => owner === "user:1" && id === dotId ? { dotId, name: "Luna" } : null) } as never,
    deliverables, workspaceRoot: root, maxBytes: options.maxBytes ?? 1024 * 1024, publishArtifact, audit: vi.fn(async () => undefined)
  });
  return { root, workspace, service, versions, publishArtifact };
}

describe("Dot workspace paths", () => {
  it("stay inside the workspace and never follow links out", async () => {
    const { workspace, root } = await fixture();
    expect(await resolveWorkspacePath(workspace, "reports/summary.md", "file")).toBe(join(await import("node:fs/promises").then((fs) => fs.realpath(workspace)), "reports", "summary.md"));
    await expect(resolveWorkspacePath(workspace, "../secret.txt", "file")).rejects.toThrow();
    await expect(resolveWorkspacePath(workspace, "/etc/passwd", "file")).rejects.toThrow();
    await expect(resolveWorkspacePath(workspace, "link.txt", "file")).rejects.toMatchObject({ code: "DOT_WORKSPACE_LINK" });
    await expect(resolveWorkspacePath(workspace, "reports", "file")).rejects.toMatchObject({ code: "DOT_WORKSPACE_KIND" });
    await expect(resolveWorkspacePath(workspace, "missing.txt", "file")).rejects.toMatchObject({ status: 404 });
    await expect(resolveWorkspacePath(join(root, "never-created"), "", "directory")).rejects.toMatchObject({ code: "DOT_WORKSPACE_EMPTY" });
  });
});

describe("Dot deliverables", () => {
  it("publish a workspace file as numbered versions and skip unchanged content", async () => {
    const { service, workspace, publishArtifact } = await fixture();
    const first = await service.publish("user:1", dotId, { path: "reports/summary.md", roomId: "room:own" }, "USER", null);
    expect(first).toMatchObject({ unchanged: false, deliverable: { name: "reports/summary.md", version: 1, artifactId: "artifact:1", publishedBy: "USER" } });
    expect(publishArtifact).toHaveBeenCalledWith(expect.objectContaining({ roomId: "room:own", dotName: "Luna", filename: "summary.md", mimeType: "text/markdown" }));
    expect(await service.publish("user:1", dotId, { path: "reports/summary.md", roomId: "room:own" }, "USER", null)).toMatchObject({ unchanged: true, deliverable: { version: 1 } });
    await writeFile(join(workspace, "reports", "summary.md"), "# Summary\nUpdated.");
    expect(await service.publish("user:1", dotId, { path: "reports/summary.md", roomId: "room:own" }, "DOT", null)).toMatchObject({ unchanged: false, deliverable: { version: 2, publishedBy: "DOT" } });
    expect(publishArtifact).toHaveBeenCalledTimes(2);
    await expect(service.publish("user:1", dotId, { path: "reports/summary.md", roomId: "room:foreign" }, "USER", null)).rejects.toMatchObject({ status: 404 });
    await expect(service.publish("user:2", dotId, { path: "reports/summary.md", roomId: "room:own" }, "USER", null)).rejects.toMatchObject({ status: 404 });
    await expect(service.publish("user:1", dotId, { path: "link.txt", roomId: "room:own" }, "USER", null)).rejects.toMatchObject({ code: "DOT_WORKSPACE_LINK" });
    // A Dot's request pins the content: a file changed after the approval request is not published.
    const pinned = await service.fingerprint("user:1", dotId, "reports/summary.md");
    await writeFile(join(workspace, "reports", "summary.md"), "# Summary\nChanged after the request.");
    await expect(service.publish("user:1", dotId, { path: "reports/summary.md", roomId: "room:own" }, "DOT", null, pinned))
      .rejects.toMatchObject({ code: "DOT_DELIVERABLE_CHANGED" });
    // Hard links into other files are refused.
    await link(join(workspace, "reports", "summary.md"), join(workspace, "hard.md"));
    await expect(service.publish("user:1", dotId, { path: "hard.md", roomId: "room:own" }, "USER", null)).rejects.toMatchObject({ code: "DOT_WORKSPACE_CHANGED" });
  });

  it("refuse files larger than Agent Files accept", async () => {
    const { service } = await fixture({ maxBytes: 4 });
    await expect(service.publish("user:1", dotId, { path: "reports/summary.md", roomId: "room:own" }, "USER", null)).rejects.toMatchObject({ status: 413 });
  });

  it("serve folders and files safely to the owner", async () => {
    const { service } = await fixture();
    let user: Record<string, unknown> | null = { id: "user:1", role: "USER" };
    const server = Fastify(); apps.push(server);
    server.addHook("preHandler", async (request) => { request.user = user as never; });
    registerDotDeliverableRoutes(server, service, { routeOptions: {}, authenticatedOwner: async (request) => request.user!.id });
    const base = `/api/dots/${encodeURIComponent(dotId)}`;
    const root = (await server.inject({ url: `${base}/workspace` })).json();
    expect(root).toMatchObject({ dotId, folder: "", exists: true });
    expect(root.entries[0]).toMatchObject({ name: "reports", kind: "directory" });
    expect((await server.inject({ url: `${base}/workspace?folder=reports` })).json().entries).toMatchObject([{ name: "summary.md", kind: "file" }]);
    expect((await server.inject({ url: `${base}/workspace?folder=..` })).statusCode).toBe(400);
    const markdown = await server.inject({ url: `${base}/workspace/file?path=reports%2Fsummary.md` });
    expect(markdown.statusCode).toBe(200);
    expect(markdown.body).toBe("# Summary\nAll good.");
    expect(markdown.headers["content-disposition"]).toMatch(/^inline/);
    expect(markdown.headers["content-security-policy"]).toMatch(/sandbox/);
    expect(markdown.headers["x-content-type-options"]).toBe("nosniff");
    // HTML never renders in Space's origin: it downloads.
    expect((await server.inject({ url: `${base}/workspace/file?path=page.html` })).headers["content-disposition"]).toMatch(/^attachment/);
    expect((await server.inject({ url: `${base}/workspace/file?path=reports%2Fsummary.md&download=1` })).headers["content-disposition"]).toMatch(/^attachment; filename\*=UTF-8''summary.md/);
    expect((await server.inject({ url: `${base}/workspace/file?path=..%2Fsecret.txt` })).statusCode).toBe(400);
    expect((await server.inject({ url: `${base}/workspace/file?path=link.txt` })).statusCode).toBe(400);
    const published = await server.inject({ method: "POST", url: `${base}/deliverables`, payload: { path: "reports/summary.md", roomId: "room:own" } });
    expect(published.json()).toMatchObject({ unchanged: false, deliverable: { version: 1 } });
    expect((await server.inject({ url: `${base}/deliverables` })).json().items).toHaveLength(1);
    user = { id: "user:1", role: "USER", automationScope: "cli" };
    expect((await server.inject({ url: `${base}/workspace` })).statusCode).toBe(403);
    user = { id: "user:2", role: "USER" };
    expect((await server.inject({ url: `${base}/workspace` })).statusCode).toBe(404);
  });
});
