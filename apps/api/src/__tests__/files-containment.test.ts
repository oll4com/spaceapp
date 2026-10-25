import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { listDirectory, readFileContent, searchFiles, writeFileContent, createEntry } from "../files-service.js";
import { unlinkWorkspaceFile } from "../workspace-filesystem.js";

describe("workspace filesystem containment", () => {
  let fixture: string;
  let root: string;
  let outside: string;
  beforeEach(async () => {
    fixture = await mkdtemp(path.join(os.tmpdir(), "space-containment-"));
    root = path.join(fixture, "workspace");
    outside = path.join(fixture, "outside");
    await mkdir(root);
    await mkdir(path.join(outside, "nested"), { recursive: true });
    await writeFile(path.join(outside, "secret.txt"), "OUTSIDE_SENTINEL");
    await writeFile(path.join(outside, "nested", "secret.txt"), "OUTSIDE_SENTINEL");
  });
  afterEach(async () => { await rm(fixture, { recursive: true, force: true }); });

  it("rejects a final symlink without reading its target", async () => {
    await symlink(path.join(outside, "secret.txt"), path.join(root, "secret.txt"));
    await expect(readFileContent({ targetPath: path.join(root, "secret.txt"), workspaceRoot: root }))
      .rejects.toMatchObject({ statusCode: 403 });
  });

  it.each(["read", "list", "search"])("rejects an ancestor symlink for %s", async (operation) => {
    await symlink(outside, path.join(root, "escape"));
    const targetPath = path.join(root, "escape", "nested");
    const options = { targetPath, workspaceRoot: root };
    const result = operation === "read"
      ? readFileContent({ ...options, targetPath: path.join(targetPath, "secret.txt") })
      : operation === "list" ? listDirectory(options) : searchFiles({ ...options, query: "secret" });
    await expect(result).rejects.toMatchObject({ statusCode: 403 });
  });

  it("rejects traversal and user writes, including nonexistent destinations", async () => {
    await expect(readFileContent({ targetPath: path.join(root, "../outside/secret.txt"), workspaceRoot: root }))
      .rejects.toMatchObject({ statusCode: 403 });
    for (const targetPath of [path.join(root, "new.txt"), path.join(outside, "secret.txt")]) {
      await expect(writeFileContent({ targetPath, content: "overwrite", workspaceRoot: root }))
        .rejects.toMatchObject({ statusCode: 403 });
      await expect(createEntry({ targetPath, type: "file", workspaceRoot: root }))
        .rejects.toMatchObject({ statusCode: 403 });
    }
    expect(await readFile(path.join(outside, "secret.txt"), "utf8")).toBe("OUTSIDE_SENTINEL");
  });

  it("never returns outside content while an ancestor is renamed and replaced", async () => {
    const active = path.join(root, "active");
    const parked = path.join(root, "parked");
    await mkdir(active);
    await writeFile(path.join(active, "secret.txt"), "INSIDE");
    let running = true;
    const racer = (async () => {
      while (running) {
        await rename(active, parked);
        await symlink(outside, active);
        await new Promise((resolve) => setImmediate(resolve));
        await rm(active);
        await rename(parked, active);
      }
    })();
    try {
      for (let i = 0; i < 100; i++) {
        const result = await readFileContent({ targetPath: path.join(active, "secret.txt"), workspaceRoot: root })
          .then((value) => value.content, () => null);
        expect(result === null || result === "INSIDE").toBe(true);
      }
    } finally {
      running = false;
      await racer;
    }
  });

  it("never unlinks outside bytes while an ancestor is renamed and replaced", async () => {
    const active = path.join(root, "active");
    const parked = path.join(root, "parked");
    await mkdir(active);
    await writeFile(path.join(active, "secret.txt"), "INSIDE");
    let running = true;
    const racer = (async () => {
      while (running) {
        await rename(active, parked);
        await symlink(outside, active);
        await new Promise(resolve => setImmediate(resolve));
        await rm(active);
        await rename(parked, active);
      }
    })();
    try {
      for (let i = 0; i < 100; i++) {
        await unlinkWorkspaceFile(root, path.join(active, "secret.txt")).catch(error => {
          expect(["NOT_FOUND", "PATH_UNSAFE"]).toContain(error.code);
        });
        expect(await readFile(path.join(outside, "secret.txt"), "utf8")).toBe("OUTSIDE_SENTINEL");
      }
    } finally { running = false; await racer; }
  });

  it("unlinks only the final symlink and rejects an out-of-root target", async () => {
    await symlink(path.join(outside, "secret.txt"), path.join(root, "link.txt"));
    await unlinkWorkspaceFile(root, path.join(root, "link.txt"));
    await expect(unlinkWorkspaceFile(root, path.join(outside, "secret.txt"))).rejects.toMatchObject({ code: "PATH_UNSAFE" });
    expect(await readFile(path.join(outside, "secret.txt"), "utf8")).toBe("OUTSIDE_SENTINEL");
  });

  it("keeps explicit authenticated host access available", async () => {
    const result = await readFileContent({ targetPath: path.join(outside, "secret.txt"), workspaceRoot: root,
      mode: "admin", user: { id: "operator", email: "operator@example.test", role: "ADMIN" } });
    expect(result.content).toBe("OUTSIDE_SENTINEL");
  });
});
