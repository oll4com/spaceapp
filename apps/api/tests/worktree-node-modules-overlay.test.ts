import { lstat, mkdir, mkdtemp, readdir, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execGit, WorktreeService } from "../src/worktrees/worktree-service.js";

describe("worktree node_modules overlay", () => {
  let base: string;
  let repo: string;
  let service: WorktreeService;

  beforeAll(async () => {
    base = await mkdtemp(join(tmpdir(), "space-wt-overlay-"));
    repo = join(base, "repo");
    await mkdir(join(repo, "node_modules", "left-pad"), { recursive: true });
    await mkdir(join(repo, "node_modules", ".bin"), { recursive: true });
    await writeFile(join(repo, "node_modules", ".package-lock.json"), "{}\n");
    await writeFile(join(repo, "node_modules", "left-pad", "index.js"), "module.exports = 1;\n");
    await mkdir(join(repo, "node_modules", "@grpc", "proto-loader"), { recursive: true });
    await writeFile(join(repo, "node_modules", "@grpc", "proto-loader", "index.js"), "module.exports = 4;\n");
    await writeFile(join(repo, "node_modules", ".bin", "vitest"), "#!/bin/sh\n");
    await mkdir(join(repo, "apps", "api", "node_modules", "nanoid"), { recursive: true });
    await writeFile(join(repo, "apps", "api", "node_modules", "nanoid", "index.js"), "module.exports = 2;\n");
    await writeFile(join(repo, ".gitignore"), "node_modules/\n");
    await execGit(repo, ["init", "-b", "main"]);
    await execGit(repo, ["config", "user.name", "Overlay Test"]);
    await execGit(repo, ["config", "user.email", "overlay@space.local"]);
    await writeFile(join(repo, "apps", "api", "package.json"), "{}\n");
    await execGit(repo, ["add", "."]);
    await execGit(repo, ["commit", "-m", "init"]);
    service = new WorktreeService(join(base, "managed"));
  });

  afterAll(async () => {
    await rm(base, { recursive: true, force: true });
  });

  it("links every package individually, scoped ones and bins too, so npm inside the worktree cannot rewrite the source tree", async () => {
    const worktree = await service.createWorktree({
      repoPath: repo,
      roomId: "room:overlay",
      branchName: "feat/overlay",
      baseBranch: "main",
      linkModules: true
    });
    const root = join(worktree.worktreePath, "node_modules");
    expect((await lstat(root)).isSymbolicLink()).toBe(false);
    expect((await lstat(root)).isDirectory()).toBe(true);
    // 2026-10-29 20:03 UTC: npm emptied 124 scoped packages of the live tree through linked scope folders and rewrote its hidden
    // lockfile through the linked file. Scope folders and .bin are real, each package a link; npm's own dot files stay out.
    expect((await readdir(root)).sort()).toEqual([".bin", "@grpc", "left-pad"]);
    expect(await readlink(join(root, "left-pad"))).toBe(join(repo, "node_modules", "left-pad"));
    expect((await lstat(join(root, "@grpc"))).isSymbolicLink()).toBe(false);
    expect(await readlink(join(root, "@grpc", "proto-loader"))).toBe(join(repo, "node_modules", "@grpc", "proto-loader"));
    expect((await lstat(join(root, ".bin"))).isSymbolicLink()).toBe(false);
    expect(await readlink(join(root, ".bin", "vitest"))).toBe(join(repo, "node_modules", ".bin", "vitest"));
    // What npm does to a scoped package it replaces, inside the worktree: the source's stays whole.
    await rm(join(root, "@grpc", "proto-loader"), { recursive: true, force: true });
    await mkdir(join(root, "@grpc", "proto-loader"));
    expect(await readdir(join(repo, "node_modules", "@grpc", "proto-loader"))).toEqual(["index.js"]);

    const nested = join(worktree.worktreePath, "apps", "api", "node_modules");
    expect((await lstat(nested)).isDirectory()).toBe(true);
    expect(await readlink(join(nested, "nanoid"))).toBe(join(repo, "apps", "api", "node_modules", "nanoid"));

    // Replacing a package inside the worktree (what npm does) must leave the source tree intact.
    await rm(join(nested, "nanoid"), { recursive: true, force: true });
    await mkdir(join(nested, "nanoid"));
    await writeFile(join(nested, "nanoid", "index.js"), "module.exports = 3;\n");
    expect((await lstat(join(repo, "apps", "api", "node_modules", "nanoid", "index.js"))).isFile()).toBe(true);
    expect((await readdir(join(repo, "apps", "api", "node_modules", "nanoid")))).toEqual(["index.js"]);
  });

  it("converts a worktree's old overlay in place, and leaves a node_modules npm installed or one linked to another tree alone", async () => {
    const old = join(base, "old");
    const modules = join(old, "node_modules");
    await mkdir(modules, { recursive: true });
    for (const name of ["left-pad", "@grpc", ".bin", ".package-lock.json"]) await symlink(join(repo, "node_modules", name), join(modules, name));
    expect(await WorktreeService.repairNodeModules(repo, old)).toBe(1);
    expect((await readdir(modules)).sort()).toEqual([".bin", "@grpc", "left-pad"]);
    expect(await readlink(join(modules, "@grpc", "proto-loader"))).toBe(join(repo, "node_modules", "@grpc", "proto-loader"));
    expect(await readlink(join(modules, "left-pad"))).toBe(join(repo, "node_modules", "left-pad"));
    expect(await WorktreeService.repairNodeModules(repo, old)).toBe(0);

    const installed = join(base, "installed");
    await mkdir(join(installed, "node_modules", "@grpc", "grpc-js"), { recursive: true });
    await writeFile(join(installed, "node_modules", ".package-lock.json"), "{}\n");
    const linked = join(base, "linked");
    await mkdir(linked);
    await symlink(join(base, "installed", "node_modules"), join(linked, "node_modules"));
    for (const tree of [installed, linked]) expect(await WorktreeService.repairNodeModules(repo, tree)).toBe(0);
    expect((await readdir(join(installed, "node_modules"))).sort()).toEqual([".package-lock.json", "@grpc"]);
    expect(await readdir(join(installed, "node_modules", "@grpc"))).toEqual(["grpc-js"]);
  });
});
