import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// HTTP envelope of /api/files/search: success states EMPTY_RESULT or OK; a
// failure is an error response with a code, a bounded category and the
// request id, and never a raw internal error message.
describe("file search HTTP semantics", () => {
  let root: string;
  let bin: string;
  let app: FastifyInstance;
  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "space-files-search-"));
    bin = await mkdtemp(path.join(os.tmpdir(), "space-files-search-bin-"));
    vi.stubEnv("SPACE_WORKSPACE_ROOT", root);
    vi.stubEnv("SPACE_VAR_DIR", path.join(root, "var"));
    const { registerFilesRoutes } = await import("../src/files-routes.js");
    app = Fastify({ genReqId: () => "req:filessearch1" });
    app.addHook("onRequest", async (request) => {
      request.requestIdForSpace = request.id;
      request.user = { id: "operator", email: "operator@example.test", role: "ADMIN" };
    });
    registerFilesRoutes(app);
    await app.ready();
  });
  afterAll(async () => {
    await app?.close();
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
    await rm(bin, { recursive: true, force: true });
  });

  it("states EMPTY_RESULT for a search that ran and matched nothing", async () => {
    const reply = await app.inject(`/api/files/search?mode=admin&path=${encodeURIComponent(root)}&query=nothing-matches`);
    expect(reply.statusCode).toBe(200);
    expect(reply.json()).toMatchObject({ results: [], totalCount: 0, code: "EMPTY_RESULT" });
  });

  it("returns TOOL_UNAVAILABLE with a category and request id when the tool is missing", async () => {
    vi.stubEnv("PATH", bin); // restored by vi.unstubAllEnvs in afterAll
    const reply = await app.inject(`/api/files/search?mode=admin&path=${encodeURIComponent(root)}&query=anything`);
    expect(reply.statusCode).toBe(503);
    expect(reply.json()).toEqual({
      ok: false,
      error: { code: "TOOL_UNAVAILABLE", message: "File search tool is unavailable.", category: "TOOL_UNAVAILABLE", requestId: "req:filessearch1" }
    });
  });

  it("returns PERMISSION_DENIED when the tool reports a permission failure", async () => {
    await writeFile(path.join(bin, "rg"), "#!/bin/sh\necho 'rg: /secret/path: Permission denied (os error 13)' >&2\nexit 2\n");
    await chmod(path.join(bin, "rg"), 0o700);
    vi.stubEnv("PATH", `${bin}:/usr/bin:/bin`);
    const reply = await app.inject(`/api/files/search?mode=admin&path=${encodeURIComponent(root)}&query=anything`);
    expect(reply.statusCode).toBe(403);
    expect(reply.json().error).toMatchObject({ code: "PERMISSION_DENIED", category: "PERMISSION_DENIED" });
    expect(reply.body).not.toContain("/secret/path");
  });
});
