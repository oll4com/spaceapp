import Fastify from "fastify";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { InMemorySpaceStore } from "@space/runtime";
import { registerArtifactReadRoutes } from "../src/artifact-read-routes.js";
import { FilesystemError } from "../src/filesystem-error.js";
import { withPngMetadata } from "../src/design/images.js";
import { pngOf } from "./fixtures/design-png.js";

let app: ReturnType<typeof Fastify>;
let root: string;
let store: InMemorySpaceStore;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "artifact-routes-"));
  await mkdir(join(root, "browser-evidence", "fixture"), { recursive: true });
  store = new InMemorySpaceStore();
  app = Fastify();
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof FilesystemError) return reply.status(error.statusCode).send({ code: error.code });
    return reply.send(error);
  });
  registerArtifactReadRoutes(app, { store, artifactRoot: root, routeOptions: {} });
});
afterEach(async () => { await app.close(); await rm(root, { recursive: true, force: true }); });

function artifact(filename: string, mimeType: string, agentFile = false) {
  return store.createArtifact({ roomId: null, kind: "EXPORT", mimeType,
    storageUri: agentFile ? `space-artifact://agent-files/room_fixture/pane_fixture/session_fixture/2026-10-03/${filename}`
      : `space-artifact://browser-evidence/fixture/${filename}`, byteSize: 7, sha256: "a".repeat(64),
    metadata: agentFile ? { collection: "AGENT_FILES", originalFilename: filename } : {} }).artifact;
}

it("registers paginated artifact reads without the application bootstrap", async () => {
  artifact("one.txt", "text/plain"); artifact("two.txt", "text/plain");
  const response = await app.inject("/api/artifacts?page=2&pageSize=1");
  expect(response.statusCode).toBe(200);
  expect(response.json().data).toHaveLength(1);
  expect(response.json().pagination).toEqual({ page: 2, pageSize: 1, totalItems: 2, totalPages: 2 });
});

it("keeps active content as a sandboxed attachment and rejects symlink reads", async () => {
  const file = artifact("active.html", "text/html");
  await writeFile(join(root, "browser-evidence", "fixture", "active.html"), "<script>1</script>");
  const url = `/api/artifacts/${encodeURIComponent(file.id)}/file`;
  const response = await app.inject(url);
  expect(response.statusCode).toBe(200);
  expect(response.headers["content-disposition"]).toMatch(/^attachment;/);
  expect(response.headers["content-security-policy"]).toContain("sandbox");
  expect(response.headers["x-content-type-options"]).toBe("nosniff");
  expect(response.headers["cache-control"]).toBe("private, no-store");
  await rm(join(root, "browser-evidence", "fixture", "active.html"));
  await writeFile(join(root, "sentinel.txt"), "sentinel");
  await symlink(join(root, "sentinel.txt"), join(root, "browser-evidence", "fixture", "active.html"));
  expect((await app.inject(url)).statusCode).toBe(403);
});

it("lets the browser cache image files, whose bytes never change", async () => {
  const file = artifact("photo.png", "image/png");
  await writeFile(join(root, "browser-evidence", "fixture", "photo.png"), "png");
  const response = await app.inject(`/api/artifacts/${encodeURIComponent(file.id)}/file`);
  expect(response.statusCode).toBe(200);
  expect(response.headers["cache-control"]).toBe("private, max-age=86400, stale-while-revalidate=604800");
  expect(response.headers["content-security-policy"]).toContain("sandbox");
});

it("serves byte ranges of a video so a player can scrub it (Video pane, 2026-10-21)", async () => {
  const file = artifact("clip.mp4", "video/mp4");
  await writeFile(join(root, "browser-evidence", "fixture", "clip.mp4"), "0123456789");
  const whole = await app.inject(`/api/artifacts/${encodeURIComponent(file.id)}/file`);
  expect(whole.statusCode).toBe(200);
  expect(whole.headers["accept-ranges"]).toBe("bytes");
  expect(whole.headers["content-length"]).toBe("10");
  const part = await app.inject({ url: `/api/artifacts/${encodeURIComponent(file.id)}/file`, headers: { range: "bytes=2-5" } });
  expect(part.statusCode).toBe(206);
  expect(part.headers["content-range"]).toBe("bytes 2-5/10");
  expect(part.body).toBe("2345");
  const tail = await app.inject({ url: `/api/artifacts/${encodeURIComponent(file.id)}/file`, headers: { range: "bytes=-3" } });
  expect([tail.statusCode, tail.body]).toEqual([206, "789"]);
  const open = await app.inject({ url: `/api/artifacts/${encodeURIComponent(file.id)}/file`, headers: { range: "bytes=8-" } });
  expect([open.statusCode, open.headers["content-range"], open.body]).toEqual([206, "bytes 8-9/10", "89"]);
  expect((await app.inject({ url: `/api/artifacts/${encodeURIComponent(file.id)}/file`, headers: { range: "bytes=20-30" } })).statusCode).toBe(416);
});

it("previews an Agent Files video in byte ranges, so a long YouTube download plays and seeks at once", async () => {
  const file = artifact("talk.mp4", "video/mp4", true);
  const directory = join(root, "agent-files", "room_fixture", "pane_fixture", "session_fixture", "2026-10-03");
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "talk.mp4"), "0123456789");
  const url = `/api/artifacts/${encodeURIComponent(file.id)}/preview`;
  const whole = await app.inject(url);
  expect([whole.statusCode, whole.headers["accept-ranges"], whole.headers["content-type"], whole.body]).toEqual([200, "bytes", "video/mp4", "0123456789"]);
  const part = await app.inject({ url, headers: { range: "bytes=4-" } });
  expect([part.statusCode, part.headers["content-range"], part.body]).toEqual([206, "bytes 4-9/10", "456789"]);
  expect((await app.inject({ url, headers: { range: "bytes=10-" } })).statusCode).toBe(416);
});

it("preserves plain text preview and forced Agent File download", async () => {
  const file = artifact("note.txt", "text/plain", true);
  const directory = join(root, "agent-files", "room_fixture", "pane_fixture", "session_fixture", "2026-10-03");
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "note.txt"), "content");
  const preview = await app.inject(`/api/artifacts/${encodeURIComponent(file.id)}/preview`);
  expect(preview.statusCode).toBe(200);
  expect(preview.body).toBe("content");
  expect(preview.headers["x-space-preview-truncated"]).toBe("false");
  expect(preview.headers["content-type"]).toContain("text/plain");
  const download = await app.inject(`/api/artifacts/${encodeURIComponent(file.id)}/download`);
  expect(download.statusCode).toBe(200);
  expect(download.headers["content-disposition"]).toContain('attachment; filename="note.txt";');
  expect(download.headers["content-disposition"]).toContain("filename*=UTF-8''note.txt");
  expect(download.body).toBe("content");
});

it("answers the Details dialog: an image's measured size and the metadata a design PNG carries inside", async () => {
  const design = { formatId: "linkedin", width: 1200, height: 627, description: "6 AI models played chess. Zero checkmates.", madeBy: { by: "AGENT", runtimeId: "cli:claude", model: "claude-opus-5-5" } };
  const png = artifact("design-linkedin.png", "image/png");
  await writeFile(join(root, "browser-evidence", "fixture", "design-linkedin.png"),
    withPngMetadata(pngOf(1200, 627), { Description: design.description, Software: "SpaceApp Design", "spaceapp:design": JSON.stringify(design) }));
  const response = await app.inject(`/api/artifacts/${encodeURIComponent(png.id)}/metadata`);
  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({
    artifact: { id: png.id, filename: expect.stringMatching(/\.png$/), mimeType: "image/png", sha256: "a".repeat(64) },
    image: { width: 1200, height: 627 },
    embedded: { Description: design.description, Software: "SpaceApp Design" },
    design: { formatId: "linkedin", madeBy: { by: "AGENT", runtimeId: "cli:claude", model: "claude-opus-5-5" } }
  });

  // A JPEG has its size and nothing inside; a text file is not read; a deleted artifact is gone.
  const jpeg = artifact("photo.jpg", "image/jpeg");
  const sof = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x02, 0x73, 0x04, 0xb0, 0x03, 0, 0, 0, 0, 0, 0, 0, 0]);
  await writeFile(join(root, "browser-evidence", "fixture", "photo.jpg"), sof);
  expect((await app.inject(`/api/artifacts/${encodeURIComponent(jpeg.id)}/metadata`)).json()).toMatchObject({ image: { width: 1200, height: 627 }, embedded: {}, design: null });
  const note = artifact("note.txt", "text/plain");
  expect((await app.inject(`/api/artifacts/${encodeURIComponent(note.id)}/metadata`)).json()).toMatchObject({ image: null, embedded: {}, design: null });
  store.deleteArtifact(png.id);
  expect((await app.inject(`/api/artifacts/${encodeURIComponent(png.id)}/metadata`)).statusCode).toBeGreaterThanOrEqual(400);
});
