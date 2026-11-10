import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import multipart from "@fastify/multipart";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// EXT-G-2: host mode never deletes or renames over credential and config directories (real paths, symlinks resolved).
describe("files host mode credential guard", () => {
  let root: string;
  let home: string;
  let varDir: string;
  let app: FastifyInstance;
  const audits: Array<{ action: string; targetId?: string | null }> = [];

  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "space-files-guard-"));
    home = path.join(root, "home");
    varDir = path.join(root, "space-var");
    for (const dir of [".ssh", ".gnupg", ".config", ".codex", ".claude"]) await mkdir(path.join(home, dir), { recursive: true });
    await mkdir(varDir, { recursive: true });
    await mkdir(path.join(root, "workspace"), { recursive: true });
    vi.stubEnv("HOME", home);
    vi.stubEnv("SPACE_WORKSPACE_ROOT", path.join(root, "workspace"));
    vi.stubEnv("SPACE_VAR_DIR", varDir);
    const { registerFilesRoutes } = await import("../src/files-routes.js");
    app = Fastify();
    app.addHook("onRequest", async (request) => {
      request.user = { id: "operator", email: "operator@example.test", role: "ADMIN" };
    });
    await app.register(multipart);
    registerFilesRoutes(app, {
      store: {
        upsertUser: async (user) => user as never,
        recordAuditEvent: async (event) => { audits.push(event as never); return event as never; }
      }
    });
    await app.ready();
  });
  afterAll(async () => { await app?.close(); await rm(root, { recursive: true, force: true }); vi.unstubAllEnvs(); });

  const remove = (target: string, recursive = false) =>
    app.inject({ method: "DELETE", url: "/api/files/delete", payload: { path: target, recursive, mode: "admin" } });
  const move = (oldPath: string, newPath: string) =>
    app.inject({ method: "POST", url: "/api/files/rename", payload: { oldPath, newPath, mode: "admin" } });
  const write = (target: string, content: string) =>
    app.inject({ method: "PUT", url: "/api/files/write", payload: { path: target, content, mode: "admin" } });
  const create = (target: string, type: "file" | "directory" = "file") =>
    app.inject({ method: "POST", url: "/api/files/create", payload: { path: target, type, mode: "admin" } });
  const upload = (targetDir: string) => app.inject({
    method: "POST", url: "/api/files/upload", headers: { "content-type": "multipart/form-data; boundary=b" },
    payload: `--b\r\nContent-Disposition: form-data; name="mode"\r\n\r\nadmin\r\n`
      + `--b\r\nContent-Disposition: form-data; name="targetDir"\r\n\r\n${targetDir}\r\n`
      + `--b\r\nContent-Disposition: form-data; name="file"; filename="up.txt"\r\nContent-Type: text/plain\r\n\r\nuploaded\r\n--b--\r\n`
  });
  const chmodTo = (target: string, octalPermissions: string) =>
    app.inject({ method: "POST", url: "/api/files/chmod", payload: { path: target, octalPermissions, mode: "admin" } });

  it("refuses deleting inside, at or above a credential directory, and audits the refusal", async () => {
    const key = path.join(home, ".ssh", "id_test");
    await writeFile(key, "not-a-real-key");
    for (const [target, recursive] of [[key, false], [path.join(home, ".config"), true], [home, true], [path.join(varDir, "state.json"), false]] as const) {
      audits.length = 0;
      const reply = await remove(target, recursive);
      expect(reply.statusCode, target).toBe(403);
      expect(reply.json().error.code).toBe("PATH_DENIED");
      expect(audits).toEqual([expect.objectContaining({ action: "files.delete.refused", targetId: target })]);
    }
    expect(existsSync(key)).toBe(true);
  });

  it("resolves symlinks before it decides", async () => {
    const secret = path.join(home, ".gnupg", "secring.gpg");
    await writeFile(secret, "not-a-real-key");
    const link = path.join(root, "workspace", "gnupg-link");
    await symlink(path.join(home, ".gnupg"), link);
    const reply = await remove(path.join(link, "secring.gpg"));
    expect(reply.statusCode).toBe(403);
    expect(existsSync(secret)).toBe(true);
  });

  it("refuses renaming over, out of or into a credential directory", async () => {
    const auth = path.join(home, ".codex", "auth.json");
    await writeFile(auth, "original");
    const replacement = path.join(root, "workspace", "evil.json");
    await writeFile(replacement, "replaced");
    audits.length = 0;
    const over = await move(replacement, auth);
    expect(over.statusCode).toBe(403);
    expect(over.json().error.code).toBe("PATH_DENIED");
    expect(await readFile(auth, "utf8")).toBe("original");
    expect(audits).toEqual([expect.objectContaining({ action: "files.rename.refused" })]);

    const settings = path.join(home, ".claude", "settings.json");
    await writeFile(settings, "{}");
    expect((await move(settings, path.join(root, "workspace", "settings.json"))).statusCode).toBe(403);
    expect(existsSync(settings)).toBe(true);

    const fresh = path.join(root, "workspace", "fresh.txt");
    await writeFile(fresh, "new");
    expect((await move(fresh, path.join(home, ".config", "fresh.txt"))).statusCode).toBe(403); // outside the roots since EXT-G-2's move slice
  });

  it("deletes only inside the workspace and the CLI workspace root, and audits a refusal elsewhere", async () => {
    const inWorkspace = path.join(root, "workspace", "notes.txt");
    await writeFile(inWorkspace, "x");
    expect((await remove(inWorkspace)).statusCode).toBe(200);
    expect(existsSync(inWorkspace)).toBe(false);

    const cliRoot = path.join(root, "cli-workspaces");
    await mkdir(path.join(cliRoot, "pane"), { recursive: true });
    vi.stubEnv("SPACE_CLI_WORKSPACE_ROOT", cliRoot);
    expect((await remove(path.join(cliRoot, "pane"), true)).statusCode).toBe(200);
    expect((await remove(cliRoot, true)).statusCode).toBe(403); // a root itself stays
    expect(existsSync(cliRoot)).toBe(true);

    const outside = path.join(home, "notes.txt");
    await writeFile(outside, "x");
    const link = path.join(root, "workspace", "home-link");
    await symlink(home, link);
    for (const target of [outside, path.join(link, "notes.txt")]) {
      audits.length = 0;
      const reply = await remove(target);
      expect(reply.statusCode, target).toBe(403);
      expect(reply.json().error.code).toBe("PATH_DENIED");
      expect(audits).toEqual([expect.objectContaining({ action: "files.delete.refused", targetId: target })]);
    }
    expect(existsSync(outside)).toBe(true);
    expect((await remove(link)).statusCode).toBe(200); // the link itself lives in the workspace
    expect(existsSync(outside)).toBe(true);
  });

  it("moves and renames only inside the roots, both ends, and audits a refusal", async () => {
    const workspace = path.join(root, "workspace");
    const a = path.join(workspace, "a.txt");
    await writeFile(a, "a");
    expect((await move(a, path.join(workspace, "b.txt"))).statusCode).toBe(200);
    const cliRoot = path.join(root, "cli-move");
    await mkdir(cliRoot, { recursive: true });
    vi.stubEnv("SPACE_CLI_WORKSPACE_ROOT", cliRoot);
    expect((await move(path.join(workspace, "b.txt"), path.join(cliRoot, "b.txt"))).statusCode).toBe(200);

    const outside = path.join(home, "keep.txt");
    await writeFile(outside, "keep");
    const victim = path.join(workspace, "victim.txt");
    await writeFile(victim, "v");
    const link = path.join(workspace, "home-move-link");
    await symlink(home, link);
    for (const [from, to] of [
      [outside, path.join(workspace, "stolen.txt")], // out of the roots
      [victim, outside], // rename over a file outside the roots deletes it
      [victim, path.join(link, "keep.txt")], // the same through a symlinked parent
      [victim, path.join(root, "outside-new.txt")], // a new name outside the roots
      [cliRoot, path.join(workspace, "cli-moved")] // a root itself
    ]) {
      audits.length = 0;
      const reply = await move(from, to);
      expect(reply.statusCode, `${from} -> ${to}`).toBe(403);
      expect(reply.json().error.code).toBe("PATH_DENIED");
      expect(audits).toEqual([expect.objectContaining({ action: "files.rename.refused" })]);
    }
    expect(await readFile(outside, "utf8")).toBe("keep");
    expect(existsSync(victim)).toBe(true);
    expect(existsSync(cliRoot)).toBe(true);
  });

  it("changes permissions only inside the roots, following a final symlink, and audits a refusal", async () => {
    const inside = path.join(root, "workspace", "mode.txt");
    await writeFile(inside, "m");
    expect((await chmodTo(inside, "600")).statusCode).toBe(200);

    const outside = path.join(home, "mode.txt");
    await writeFile(outside, "m", { mode: 0o644 });
    const fileLink = path.join(root, "workspace", "mode-link");
    await symlink(outside, fileLink);
    for (const target of [outside, fileLink, path.join(root, "workspace")]) {
      audits.length = 0;
      const reply = await chmodTo(target, "777");
      expect(reply.statusCode, target).toBe(403);
      expect(reply.json().error.code).toBe("PATH_DENIED");
      expect(audits).toEqual([expect.objectContaining({ action: "files.chmod.refused", targetId: target })]);
    }
    expect((await stat(outside)).mode & 0o777).toBe(0o644);
  });

  it("writes, overwrites, creates and uploads only inside the roots, and audits a refusal", async () => {
    const workspace = path.join(root, "workspace");
    const inside = path.join(workspace, "w.txt");
    expect((await write(inside, "one")).statusCode).toBe(200);
    expect((await write(inside, "two")).statusCode).toBe(200);
    expect(await readFile(inside, "utf8")).toBe("two");
    expect((await create(path.join(workspace, "made", "c.txt"))).statusCode).toBe(200);
    expect((await upload(workspace)).statusCode).toBe(200); // a root itself takes uploads
    expect(await readFile(path.join(workspace, "up.txt"), "utf8")).toBe("uploaded");

    const outside = path.join(home, "keep-write.txt");
    await writeFile(outside, "keep");
    const link = path.join(workspace, "home-write-link");
    await symlink(home, link);
    const cases: Array<[string, () => Promise<{ statusCode: number; json: () => { error: { code: string } } }>, string]> = [
      ["write", () => write(outside, "overwritten"), outside],
      ["write", () => write(path.join(link, "keep-write.txt"), "overwritten"), path.join(link, "keep-write.txt")],
      ["write", () => write(path.join(root, "new-outside.txt"), "x"), path.join(root, "new-outside.txt")],
      ["create", () => create(path.join(root, "made-outside"), "directory"), path.join(root, "made-outside")],
      ["upload", () => upload(home), home],
      ["upload", () => upload(link), link]
    ];
    for (const [action, call, target] of cases) {
      audits.length = 0;
      const reply = await call();
      expect(reply.statusCode, `${action} ${target}`).toBe(403);
      expect(reply.json().error.code).toBe("PATH_DENIED");
      expect(audits).toEqual([expect.objectContaining({ action: `files.${action}.refused`, targetId: target })]);
    }
    expect(await readFile(outside, "utf8")).toBe("keep");
    expect(existsSync(path.join(root, "new-outside.txt"))).toBe(false);
    expect(existsSync(path.join(root, "made-outside"))).toBe(false);
    expect(existsSync(path.join(home, "up.txt"))).toBe(false);
  });
});
