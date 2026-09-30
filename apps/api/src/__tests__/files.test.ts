import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { AuthUser } from "@space/contracts";
import {
  listDirectory,
  readFileContent,
  writeFileContent,
  createEntry,
  renameEntry,
  chmodEntry,
  deleteEntry,
  searchFiles,
  assertAccessAllowed,
  formatPermissions,
  formatOctalPermissions,
  FilesystemError
} from "../files-service.js";

const testOperatorUser: AuthUser = {
  id: "user:test-operator",
  email: "operator@space.local",
  role: "ADMIN"
};

const regularUser: AuthUser = {
  id: "user:test-regular",
  email: "user@space.local",
  role: "OPERATOR" // In space contracts, OPERATOR also has admin access
};

describe("Filesystem Service & Security", () => {
  let tempWorkspace: string;

  beforeEach(async () => {
    tempWorkspace = await mkdtemp(path.join(os.tmpdir(), "space-fs-test-"));
    // Setup test directory tree
    await mkdir(path.join(tempWorkspace, "subdir"), { recursive: true });
    await writeFile(path.join(tempWorkspace, "hello.txt"), "Hello, Spaceapp!", "utf-8");
    await writeFile(path.join(tempWorkspace, ".hidden.txt"), "Secret file", "utf-8");
  });

  afterEach(async () => {
    await rm(tempWorkspace, { recursive: true, force: true });
  });

  describe("assertAccessAllowed", () => {
    it("allows access inside workspace in user mode", () => {
      const result = assertAccessAllowed(path.join(tempWorkspace, "hello.txt"), "user", null, tempWorkspace);
      expect(result.resolvedPath).toBe(path.join(tempWorkspace, "hello.txt"));
      expect(result.isAdmin).toBe(false);
    });

    it("blocks access outside workspace in user mode", () => {
      expect(() => {
        assertAccessAllowed("/etc/passwd", "user", null, tempWorkspace);
      }).toThrow(FilesystemError);
    });

    it("allows access outside workspace in admin mode with ADMIN role", () => {
      const result = assertAccessAllowed("/etc/passwd", "admin", testOperatorUser, tempWorkspace);
      expect(result.resolvedPath).toBe("/etc/passwd");
      expect(result.isAdmin).toBe(true);
    });

    it("blocks admin mode if user has no admin credentials", () => {
      expect(() => {
        assertAccessAllowed("/etc/passwd", "admin", null, tempWorkspace);
      }).toThrow(FilesystemError);
    });
  });

  describe("listDirectory", () => {
    it("lists directory entries and filters hidden files by default", async () => {
      const res = await listDirectory({
        targetPath: tempWorkspace,
        showHidden: false,
        mode: "user",
        workspaceRoot: tempWorkspace
      });

      expect(res.currentPath).toBe(tempWorkspace);
      const names = res.entries.map((e) => e.name);
      expect(names).toContain("hello.txt");
      expect(names).toContain("subdir");
      expect(names).not.toContain(".hidden.txt");

      // Verify directory flag and permissions
      const dirEntry = res.entries.find((e) => e.name === "subdir");
      expect(dirEntry?.isDirectory).toBe(true);
      expect(dirEntry?.permissions).toBeDefined();
      expect(dirEntry?.octalPermissions).toBeDefined();

      const fileEntry = res.entries.find((e) => e.name === "hello.txt");
      expect(fileEntry?.isDirectory).toBe(false);
      expect(fileEntry?.size).toBe(16);
      expect(fileEntry?.mimeType).toBe("text/plain");
    });

    it("includes hidden files when showHidden is true", async () => {
      const res = await listDirectory({
        targetPath: tempWorkspace,
        showHidden: true,
        mode: "user",
        workspaceRoot: tempWorkspace
      });

      const names = res.entries.map((e) => e.name);
      expect(names).toContain(".hidden.txt");
    });

    it("includes birthtime and directory properties", async () => {
      const res = await listDirectory({
        targetPath: tempWorkspace,
        showHidden: false,
        mode: "user",
        workspaceRoot: tempWorkspace
      });

      const fileEntry = res.entries.find((e) => e.name === "hello.txt");
      expect(fileEntry?.birthtime).toBeDefined();

      const dirEntry = res.entries.find((e) => e.name === "subdir");
      expect(dirEntry?.birthtime).toBeDefined();
      expect(typeof dirEntry?.size).toBe("number");
    });
  });

  describe("readFileContent & writeFileContent", () => {
    it("reads text file content with metadata and marks read-only in user mode", async () => {
      const res = await readFileContent({
        targetPath: path.join(tempWorkspace, "hello.txt"),
        mode: "user",
        workspaceRoot: tempWorkspace
      });

      expect(res.isBinary).toBe(false);
      expect(res.content).toBe("Hello, Spaceapp!");
      expect(res.editable).toBe(false);
      expect(res.mimeType).toBe("text/plain");

      const adminRes = await readFileContent({
        targetPath: path.join(tempWorkspace, "hello.txt"),
        mode: "admin",
        user: testOperatorUser,
        workspaceRoot: tempWorkspace
      });
      expect(adminRes.editable).toBe(true);
    });

    it("blocks writing file content in user mode and allows it in admin mode", async () => {
      const filePath = path.join(tempWorkspace, "hello.txt");
      await expect(
        writeFileContent({
          targetPath: filePath,
          content: "User write attempt",
          mode: "user",
          workspaceRoot: tempWorkspace
        })
      ).rejects.toThrow(/requires Admin Mode/);

      const writeRes = await writeFileContent({
        targetPath: filePath,
        content: "Updated Content in Space",
        mode: "admin",
        user: testOperatorUser,
        workspaceRoot: tempWorkspace
      });

      expect(writeRes.ok).toBe(true);

      const readRes = await readFileContent({
        targetPath: filePath,
        mode: "user",
        workspaceRoot: tempWorkspace
      });
      expect(readRes.content).toBe("Updated Content in Space");
    });
  });

  describe("createEntry, renameEntry, deleteEntry", () => {
    it("blocks creation in user mode and allows in admin mode", async () => {
      const newDir = path.join(tempWorkspace, "new-folder");
      await expect(
        createEntry({
          targetPath: newDir,
          type: "directory",
          mode: "user",
          workspaceRoot: tempWorkspace
        })
      ).rejects.toThrow(/requires Admin Mode/);

      const createDirRes = await createEntry({
        targetPath: newDir,
        type: "directory",
        mode: "admin",
        user: testOperatorUser,
        workspaceRoot: tempWorkspace
      });
      expect(createDirRes.ok).toBe(true);
      expect(createDirRes.isDirectory).toBe(true);

      const newFile = path.join(newDir, "script.py");
      const createFileRes = await createEntry({
        targetPath: newFile,
        type: "file",
        mode: "admin",
        user: testOperatorUser,
        workspaceRoot: tempWorkspace
      });
      expect(createFileRes.ok).toBe(true);
      expect(createFileRes.isDirectory).toBe(false);
    });

    it("blocks rename in user mode and renames in admin mode", async () => {
      const oldPath = path.join(tempWorkspace, "hello.txt");
      const newPath = path.join(tempWorkspace, "greeting.txt");

      await expect(
        renameEntry({
          oldPath,
          newPath,
          mode: "user",
          workspaceRoot: tempWorkspace
        })
      ).rejects.toThrow(/requires Admin Mode/);

      const renameRes = await renameEntry({
        oldPath,
        newPath,
        mode: "admin",
        user: testOperatorUser,
        workspaceRoot: tempWorkspace
      });
      expect(renameRes.ok).toBe(true);

      const listRes = await listDirectory({
        targetPath: tempWorkspace,
        mode: "user",
        workspaceRoot: tempWorkspace
      });
      const names = listRes.entries.map((e) => e.name);
      expect(names).toContain("greeting.txt");
      expect(names).not.toContain("hello.txt");
    });

    it("blocks delete in user mode and deletes safely in admin mode", async () => {
      const targetFile = path.join(tempWorkspace, "hello.txt");
      await expect(
        deleteEntry({
          targetPath: targetFile,
          mode: "user",
          workspaceRoot: tempWorkspace
        })
      ).rejects.toThrow(/requires Admin Mode/);

      const deleteRes = await deleteEntry({
        targetPath: targetFile,
        mode: "admin",
        user: testOperatorUser,
        workspaceRoot: tempWorkspace
      });
      expect(deleteRes.ok).toBe(true);

      // Verify deletion of protected system directory is blocked even in admin mode
      await expect(
        deleteEntry({
          targetPath: "/etc",
          mode: "admin",
          user: testOperatorUser,
          workspaceRoot: tempWorkspace
        })
      ).rejects.toThrow("Deleting protected system directory (/etc) is prohibited.");
    });
  });

  describe("chmodEntry", () => {
    it("updates permissions in admin mode", async () => {
      const filePath = path.join(tempWorkspace, "hello.txt");
      const res = await chmodEntry({
        targetPath: filePath,
        octalPermissions: "0755",
        user: testOperatorUser,
        workspaceRoot: tempWorkspace
      });

      expect(res.ok).toBe(true);
      expect(res.octalPermissions).toBe("0755");
      expect(res.permissions).toBe("rwxr-xr-x");
    });
  });

  describe("searchFiles", () => {
    it("searches files matching query", async () => {
      const searchRes = await searchFiles({
        targetPath: tempWorkspace,
        query: "hello",
        mode: "user",
        workspaceRoot: tempWorkspace
      });

      expect(searchRes.query).toBe("hello");
      expect(searchRes.results.length).toBeGreaterThanOrEqual(1);
      expect(searchRes.results[0]?.name).toBe("hello.txt");
    });
  });
});
