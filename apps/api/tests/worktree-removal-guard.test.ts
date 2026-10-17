import { mkdir, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execGit, WorktreeService } from "../src/worktrees/worktree-service.js";
import { registerWorktreeRoutes } from "../src/worktrees/worktree-routes.js";
import { assertRemovableWorktreePath, parseForceFlag } from "../src/worktrees/worktree-removal-guard.js";

const exists = (path: string) => stat(path).then(() => true, () => false);

describe("worktree removal guard", () => {
  let base: string;
  let repo: string;
  let storage: string;
  let outside: string;
  let service: WorktreeService;

  beforeAll(async () => {
    base = await mkdtemp(join(tmpdir(), "space-wt-guard-"));
    repo = join(base, "repo");
    storage = join(base, "managed");
    outside = join(base, "outside");
    await mkdir(repo);
    await mkdir(storage);
    await mkdir(join(outside, "nested"), { recursive: true });
    await writeFile(join(outside, "nested", "keep.txt"), "keep");
    await execGit(repo, ["init", "-b", "main"]);
    await execGit(repo, ["config", "user.name", "Guard Test"]);
    await execGit(repo, ["config", "user.email", "guard@space.local"]);
    await mkdir(join(repo, "src"));
    await writeFile(join(repo, "src", "index.ts"), "export {};\n");
    await execGit(repo, ["add", "."]);
    await execGit(repo, ["commit", "-m", "init"]);
    service = new WorktreeService(storage);
  });

  afterAll(async () => {
    await rm(base, { recursive: true, force: true });
  });

  async function app(role?: "ADMIN" | "OPERATOR" | "USER"): Promise<FastifyInstance> {
    const server = Fastify();
    server.addHook("onRequest", async (request) => {
      (request as unknown as { user?: { role: string } }).user = role ? { role } : undefined;
    });
    registerWorktreeRoutes(server, {
      service,
      managedWorktreesRoot: storage,
      authorizeDestructive: (request) => {
        const current = (request as unknown as { user?: { role: string } }).user?.role;
        return current === "ADMIN" || current === "OPERATOR";
      }
    });
    return server;
  }

  it("accepts only linked worktree roots or managed leftovers", async () => {
    const worktree = await service.createWorktree({ repoPath: repo, roomId: "room:guard", paneId: "pane:guard", branchName: "feat/guard", baseBranch: "main", linkModules: false });
    // The registry keeps the creating pane, also after later status writes, so the Room Agent knows where it works.
    await service.recordWorktree({ worktreePath: worktree.worktreePath, status: "ACTIVE" });
    expect(await service.getRecordedWorktree(worktree.worktreePath)).toMatchObject({ roomId: "room:guard", paneId: "pane:guard" });
    await expect(assertRemovableWorktreePath(worktree.worktreePath, storage)).resolves.toMatchObject({ kind: "LINKED_WORKTREE" });
    await expect(assertRemovableWorktreePath(repo, storage)).rejects.toMatchObject({ code: "NOT_A_WORKTREE", statusCode: 409 });
    await expect(assertRemovableWorktreePath(join(repo, "src"), storage)).rejects.toMatchObject({ code: "NOT_A_WORKTREE" });
    await expect(assertRemovableWorktreePath(join(worktree.worktreePath, "src"), storage)).rejects.toMatchObject({ code: "NOT_A_WORKTREE" });
    await expect(assertRemovableWorktreePath(outside, storage)).rejects.toMatchObject({ code: "NOT_A_WORKTREE" });
    await expect(assertRemovableWorktreePath(storage, storage)).rejects.toMatchObject({ code: "NOT_A_WORKTREE" });
    await expect(assertRemovableWorktreePath("relative/path", storage)).rejects.toMatchObject({ code: "INVALID_WORKTREE_PATH" });

    const leftover = join(storage, "leftover");
    await mkdir(leftover);
    await expect(assertRemovableWorktreePath(leftover, storage)).resolves.toMatchObject({ kind: "MANAGED_LEFTOVER" });
    const escape = join(storage, "escape-link");
    await symlink(outside, escape);
    await expect(assertRemovableWorktreePath(escape, storage)).rejects.toMatchObject({ code: "NOT_A_WORKTREE" });
    await expect(assertRemovableWorktreePath(join(storage, "missing"), storage)).resolves.toMatchObject({ kind: "MISSING" });
  });

  it("treats leftovers as removable when the managed root sits inside an enclosing checkout", async () => {
    const install = join(base, "install");
    const managed = join(install, "var", "worktrees");
    await mkdir(join(managed, "stale-checkout", "deep"), { recursive: true });
    await execGit(install, ["init", "-b", "main"]);
    await expect(assertRemovableWorktreePath(join(managed, "stale-checkout"), managed)).resolves.toMatchObject({ kind: "MANAGED_LEFTOVER" });
    await expect(assertRemovableWorktreePath(install, managed)).rejects.toMatchObject({ code: "NOT_A_WORKTREE" });
    await expect(assertRemovableWorktreePath(join(install, "var"), managed)).rejects.toMatchObject({ code: "NOT_A_WORKTREE" });
    const nestedRepo = join(managed, "nested-repo");
    await mkdir(join(nestedRepo, "src"), { recursive: true });
    await execGit(nestedRepo, ["init", "-b", "main"]);
    await expect(assertRemovableWorktreePath(nestedRepo, managed)).rejects.toMatchObject({ code: "NOT_A_WORKTREE" });
    await expect(assertRemovableWorktreePath(join(nestedRepo, "src"), managed)).rejects.toMatchObject({ code: "NOT_A_WORKTREE" });
  });

  it("parses only explicit true force values", () => {
    expect(parseForceFlag("true")).toBe(true);
    expect(parseForceFlag("1")).toBe(true);
    expect(parseForceFlag(true)).toBe(true);
    for (const value of ["false", "0", "", "yes", undefined, null, 1]) expect(parseForceFlag(value)).toBe(false);
  });

  it("never deletes a main checkout or an arbitrary directory through the route", async () => {
    const server = await app("ADMIN");
    try {
      for (const path of [repo, outside, join(outside, "nested")]) {
        const response = await server.inject({ method: "DELETE", url: `/api/worktrees?path=${encodeURIComponent(path)}&force=true` });
        expect(response.statusCode).toBe(409);
        expect(response.json().error.code).toBe("NOT_A_WORKTREE");
      }
      expect(await exists(join(repo, "src", "index.ts"))).toBe(true);
      expect(await exists(join(outside, "nested", "keep.txt"))).toBe(true);
    } finally {
      await server.close();
    }
  });

  it("the service itself refuses to delete a main checkout or an arbitrary directory, even with force", async () => {
    for (const target of [outside, join(outside, "nested"), repo]) {
      for (const force of [false, true]) {
        await expect(service.removeWorktree(target, force), `${target} force=${force}`).rejects.toMatchObject({ code: "NOT_A_WORKTREE" });
      }
    }
    expect(await exists(join(outside, "nested", "keep.txt"))).toBe(true);
    expect(await exists(join(repo, "src", "index.ts"))).toBe(true);
  });

  it("requires ADMIN or OPERATOR for listing, creation, merge, removal and cleanup", async () => {
    const worktree = await service.createWorktree({ repoPath: repo, roomId: "room:guard-role", branchName: "feat/guard-role", baseBranch: "main", linkModules: false });
    for (const role of [undefined, "USER"] as const) {
      const server = await app(role);
      try {
        const removal = await server.inject({ method: "DELETE", url: `/api/worktrees?path=${encodeURIComponent(worktree.worktreePath)}&force=true` });
        expect(removal.statusCode).toBe(403);
        const merge = await server.inject({ method: "POST", url: "/api/worktrees/merge", payload: { path: worktree.worktreePath } });
        expect(merge.statusCode).toBe(403);
        const clean = await server.inject({ method: "POST", url: "/api/worktrees/clean", payload: { repoPath: repo, dryRun: true } });
        expect(clean.statusCode).toBe(403);
        const list = await server.inject({ method: "GET", url: `/api/worktrees?repoPath=${encodeURIComponent(repo)}` });
        expect(list.statusCode).toBe(403);
        const create = await server.inject({ method: "POST", url: "/api/worktrees", payload: { repoPath: repo, branchName: "feat/guard-user", baseBranch: "main" } });
        expect(create.statusCode).toBe(403);
      } finally {
        await server.close();
      }
    }
    expect(await exists(worktree.worktreePath)).toBe(true);

    const operator = await app("OPERATOR");
    try {
      const removal = await operator.inject({ method: "DELETE", url: `/api/worktrees?path=${encodeURIComponent(worktree.worktreePath)}&force=true` });
      expect(removal.statusCode).toBe(200);
      expect(await exists(worktree.worktreePath)).toBe(false);
      expect(await exists(join(repo, "src", "index.ts"))).toBe(true);
    } finally {
      await operator.close();
    }
  });
});
