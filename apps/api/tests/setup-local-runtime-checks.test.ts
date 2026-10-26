import { describe, expect, it } from "vitest";
import { cp, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import * as checks from "../src/setup-local-runtime-checks.js";

describe("selected local runtime checks", () => {
  it("runs the actual sample demo and removes its owned process and temporary data", async () => {
    const root = await mkdtemp(join(tmpdir(), "setup-demo-check-"));
    // web/dist is a build output a clean checkout (public CI) does not have: the real sample server plus a minimal built page.
    const demos = await mkdtemp(join(tmpdir(), "setup-demo-root-"));
    const variant = join(demos, "project-2-crud-playground", "javascript-react-node");
    await cp(resolve("../../demos/project-2-crud-playground/javascript-react-node/server"), join(variant, "server"), { recursive: true });
    await mkdir(join(variant, "web", "dist"), { recursive: true });
    await writeFile(join(variant, "web", "dist", "index.html"), "<!doctype html><title>CRUD Playground</title>");
    try {
      await expect(checks.checkSetupDemoRuntime(demos, root)).resolves.toBeUndefined();
      expect(await readdir(root)).toEqual([]);
      await expect(checks.checkSetupDemoRuntime(join(root, "missing"), root)).rejects.toThrow();
      expect(await readdir(root)).toEqual([]);
    } finally { await rm(root, { recursive: true, force: true }); await rm(demos, { recursive: true, force: true }); }
  }, 15_000);

  it("exercises Git worktree creation and removal only in an owned scratch repository", async () => {
    const root = await mkdtemp(join(tmpdir(), "setup-worktree-check-"));
    try {
      await expect(checks.checkSetupWorktreeRuntime(root)).resolves.toBeUndefined();
      expect(await readdir(root)).toEqual([]);
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 15_000);
});
