import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isUserModeRestricted, listDirectory, readFileContent, searchFiles } from "../files-service.js";

const user = { id: "user:files-reader", email: "reader@space.local", role: "USER" as const };
const admin = { id: "user:files-admin", email: "admin@space.local", role: "ADMIN" as const };

describe("User Mode never exposes install secrets or runtime data", () => {
  let root: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "space-files-secrets-"));
    for (const dir of ["secrets", "var/artifacts", "backups", ".git", "apps/api", "projects/demo"]) {
      await mkdir(join(root, dir), { recursive: true });
    }
    await writeFile(join(root, ".env"), "SPACE_SESSION_SECRET=synthetic-secret\n");
    await writeFile(join(root, ".env.local"), "TOKEN=synthetic-local\n");
    await writeFile(join(root, ".env.example"), "SPACE_SESSION_SECRET=\n");
    await writeFile(join(root, "secrets", "telegram.json"), "{}");
    await writeFile(join(root, "var", "artifacts", "upload.png"), "png");
    await writeFile(join(root, "backups", "db.sql"), "dump");
    await writeFile(join(root, ".git", "config"), "[core]");
    await writeFile(join(root, "apps", "api", "index.ts"), "export {};");
    await writeFile(join(root, "projects", "demo", ".env"), "PROJECT_KEY=synthetic-project\n");
    await writeFile(join(root, "projects", "demo", "env-notes.md"), "notes");
  });
  afterAll(async () => { await rm(root, { recursive: true, force: true }); });

  it("classifies restricted locations relative to the workspace root", () => {
    for (const path of [".env", ".env.local", "secrets/telegram.json", "var/artifacts/upload.png", "backups/db.sql", ".git/config", "projects/demo/.env", "var", "var/worktrees/space/wt-1/.env",
      // Inside a managed worktree: Git metadata at any depth and the install root's restricted directories.
      "var/worktrees/space/wt-1/.git", "projects/demo/.git/config", "var/worktrees/space/wt-1/packages/x/.git/HEAD",
      "var/worktrees/space/wt-1/secrets/token.json", "var/worktrees/space/wt-1/backups/db.sql", "var/worktrees/space/wt-1/var/artifacts/a.png"]) {
      expect(isUserModeRestricted(join(root, path), root), path).toBe(true);
    }
    for (const path of ["", ".env.example", "apps/api/index.ts", "projects/demo/env-notes.md", "variables", "var/worktrees/space/wt-1/src/index.ts", "var/worktrees",
      "var/worktrees/space/wt-1", "var/worktrees/space/wt-1/docs/secrets-guide.md", "var/worktrees/space/wt-1/.github/workflows/ci.yml"]) {
      expect(isUserModeRestricted(join(root, path), root), path).toBe(false);
    }
  });

  it("rejects reads of secrets in User Mode for every role and allows them in Admin Mode", async () => {
    for (const path of [".env", "secrets/telegram.json", "var/artifacts/upload.png", "backups/db.sql", "projects/demo/.env"]) {
      await expect(readFileContent({ targetPath: join(root, path), mode: "user", user, workspaceRoot: root }), path)
        .rejects.toMatchObject({ statusCode: 403, code: "RESTRICTED_PATH" });
    }
    await expect(readFileContent({ targetPath: join(root, ".env"), mode: "user", user: admin, workspaceRoot: root }))
      .rejects.toMatchObject({ statusCode: 403 });
    await expect(readFileContent({ targetPath: join(root, ".env.example"), mode: "user", user, workspaceRoot: root }))
      .resolves.toMatchObject({ name: ".env.example" });
    await expect(readFileContent({ targetPath: join(root, ".env"), mode: "admin", user: admin, workspaceRoot: root }))
      .resolves.toMatchObject({ name: ".env" });
  });

  it("hides restricted entries from listings and search in User Mode", async () => {
    const listing = await listDirectory({ targetPath: root, mode: "user", user, workspaceRoot: root, showHidden: true });
    const names = listing.entries.map((entry) => entry.name).sort();
    expect(names).toEqual([".env.example", "apps", "projects"]);
    await expect(listDirectory({ targetPath: join(root, "var"), mode: "user", user, workspaceRoot: root }))
      .rejects.toMatchObject({ code: "RESTRICTED_PATH" });
    const found = await searchFiles({ query: "env", mode: "user", user, workspaceRoot: root, targetPath: root, showHidden: true } as Parameters<typeof searchFiles>[0]);
    // Glob "*env*" skips dotfiles; the point is that no secret path appears.
    expect(found.results.map((entry) => entry.path).filter((path) => isUserModeRestricted(path, root))).toEqual([]);
    expect(found.results.map((entry) => entry.name)).toContain("env-notes.md");
    const adminListing = await listDirectory({ targetPath: root, mode: "admin", user: admin, workspaceRoot: root, showHidden: true });
    expect(adminListing.entries.map((entry) => entry.name)).toContain(".env");
  });
});

describe("server-side host mode switch", () => {
  it("rejects Admin Mode for every role when SPACE_FILES_HOST_MODE is disabled", async () => {
    const { configureFilesHostMode, assertAccessAllowed } = await import("../files-service.js");
    const admin = { id: "user:host-admin", email: "host-admin@space.local", role: "ADMIN" as const };
    try {
      configureFilesHostMode(false);
      expect(() => assertAccessAllowed("/etc", "admin", admin)).toThrow(expect.objectContaining({ code: "HOST_MODE_DISABLED", statusCode: 403 }));
      configureFilesHostMode(true);
      expect(assertAccessAllowed("/etc", "admin", admin)).toMatchObject({ isAdmin: true });
    } finally {
      configureFilesHostMode(true);
    }
  });
});
