import Fastify from "fastify";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { InMemorySpaceStore } from "@space/runtime";
import { registerArtifactReadRoutes } from "../src/artifact-read-routes.js";
import { FilesystemError } from "../src/filesystem-error.js";

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
