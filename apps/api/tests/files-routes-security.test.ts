import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import multipart from "@fastify/multipart";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

describe("filesystem HTTP security", () => {
  let root: string;
  let app: FastifyInstance;
  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "space-files-routes-"));
    vi.stubEnv("SPACE_WORKSPACE_ROOT", root);
    vi.stubEnv("SPACE_VAR_DIR", path.join(root, "var"));
    const { registerFilesRoutes } = await import("../src/files-routes.js");
    app = Fastify();
    app.addHook("onRequest", async (request) => {
      request.user = { id: "operator", email: "operator@example.test", role: "ADMIN" };
    });
    await app.register(multipart, { throwFileSizeLimit: false, limits: { fileSize: 8 } });
    registerFilesRoutes(app);
    await app.ready();
  });
  afterAll(async () => { await app?.close(); await rm(root, { recursive: true, force: true }); vi.unstubAllEnvs(); });

  it.each(["html", "svg", "xml"])("downloads active %s without app-origin privileges", async (extension) => {
    const target = path.join(root, `active.${extension}`);
    await writeFile(target, "<script>fetch('/api/rooms')</script>");
    const reply = await app.inject(`/api/files/raw?path=${encodeURIComponent(target)}`);
    expect(reply.statusCode).toBe(200);
    expect(reply.headers["content-disposition"]).toMatch(/^attachment;/);
    expect(reply.headers["x-content-type-options"]).toBe("nosniff");
    expect(reply.headers["content-security-policy"]).toMatch(/sandbox/);
    expect(reply.headers["cache-control"]).toBe("private, no-store");
  });

  it("streams an inert image inline and blocks raw symlink escape", async () => {
    const target = path.join(root, "image.png");
    await writeFile(target, "png-fixture");
    const reply = await app.inject(`/api/files/raw?path=${encodeURIComponent(target)}`);
    expect(reply.statusCode).toBe(200);
    expect(reply.headers["content-disposition"]).toMatch(/^inline;/);
    await symlink(path.join(root, "image.png"), path.join(root, "link.png"));
    const linked = await app.inject(`/api/files/raw?path=${encodeURIComponent(path.join(root, "link.png"))}`);
    expect(linked.statusCode).toBe(403);
  });

  it("preserves sandboxed inline PDF preview", async () => {
    const target = path.join(root, "document.pdf");
    await writeFile(target, "%PDF-1.7 fixture");
    const reply = await app.inject(`/api/files/raw?path=${encodeURIComponent(target)}`);
    expect(reply.statusCode).toBe(200);
    expect(reply.headers["content-disposition"]).toMatch(/^inline;/);
    expect(reply.headers["content-security-policy"]).toContain("sandbox");
    expect(reply.headers["x-content-type-options"]).toBe("nosniff");
  });

  function uploadBody(directory: string, content: string, terminate = true) {
    return `--boundary\r\nContent-Disposition: form-data; name="mode"\r\n\r\nadmin\r\n`
      + `--boundary\r\nContent-Disposition: form-data; name="targetDir"\r\n\r\n${directory}\r\n`
      + `--boundary\r\nContent-Disposition: form-data; name="file"; filename="upload.txt"\r\nContent-Type: text/plain\r\n\r\n${content}`
      + (terminate ? "\r\n--boundary--\r\n" : "");
  }

  it("rejects a truncated multipart file without replacing the original", async () => {
    const dir = path.join(root, "oversize");
    await mkdir(dir);
    await writeFile(path.join(dir, "upload.txt"), "original");
    const reply = await app.inject({ method: "POST", url: "/api/files/upload",
      headers: { "content-type": "multipart/form-data; boundary=boundary" }, payload: uploadBody(dir, "0123456789") });
    expect(reply.statusCode).toBe(413);
    expect(await readFile(path.join(dir, "upload.txt"), "utf8")).toBe("original");
    expect(await readdir(dir)).toEqual(["upload.txt"]);
  });

  it("cleans partial files when multipart parsing aborts", async () => {
    const dir = path.join(root, "aborted");
    await mkdir(dir);
    const reply = await app.inject({ method: "POST", url: "/api/files/upload",
      headers: { "content-type": "multipart/form-data; boundary=boundary" }, payload: uploadBody(dir, "partial", false) });
    expect(reply.statusCode).toBeGreaterThanOrEqual(400);
    expect(await readdir(dir)).toEqual([]);
  });

  it("publishes a complete upload with its exact bytes", async () => {
    const dir = path.join(root, "success");
    await mkdir(dir);
    const reply = await app.inject({ method: "POST", url: "/api/files/upload",
      headers: { "content-type": "multipart/form-data; boundary=boundary" }, payload: uploadBody(dir, "complete") });
    expect(reply.statusCode).toBe(200);
    expect(reply.json()).toMatchObject({ ok: true, uploadedCount: 1 });
    expect(await readFile(path.join(dir, "upload.txt"), "utf8")).toBe("complete");
    expect(await readdir(dir)).toEqual(["upload.txt"]);
  });
});
