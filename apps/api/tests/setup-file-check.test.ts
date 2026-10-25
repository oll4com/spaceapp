import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemorySpaceStore } from "@space/runtime";
import { authUserSchema } from "@space/contracts";
import { createSetupFunctionalChecks } from "../src/setup-local-runtime-checks.js";
import * as files from "../src/files-service.js";

afterEach(() => vi.restoreAllMocks());

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "setup-file-check-"));
  const store = new InMemorySpaceStore();
  store.upsertUser(authUserSchema.parse({ id: "user:owner", email: "owner@example.test", role: "ADMIN" }));
  store.upsertUser(authUserSchema.parse({ id: "user:reader", email: "reader@example.test", role: "USER" }));
  const checks = createSetupFunctionalChecks({ demoRoot: root, demoEnabled: false, workspaceRoot: root, scratchRoot: root, store });
  return { root, store, check: checks["pane:files"], close: () => rm(root, { recursive: true, force: true }) };
}

describe("owned File Manager setup round trip", () => {
  it("reads the bytes written through the existing file service and removes only its private check directory", async () => {
    const f = await fixture();
    try {
      await writeFile(join(f.root, "existing.txt"), "Operator data stays intact.");
      expect(f.check).toBeDefined();
      const realRead = files.readFileContent;
      let observed: string | null = null;
      vi.spyOn(files, "readFileContent").mockImplementation(async options => {
        observed = await readFile(options.targetPath, "utf8");
        return realRead(options);
      });
      await expect(f.check!.exercise("user:owner")).resolves.toBeUndefined();
      expect(observed).toMatch(/^SpaceApp owned file check: [a-f0-9-]+\n$/);
      expect(await readdir(f.root)).toEqual(["existing.txt"]);
      expect(await readFile(join(f.root, "existing.txt"), "utf8")).toBe("Operator data stays intact.");
    } finally { await f.close(); }
  });

  it("refuses an unprivileged or unknown actor before writing any fixture", async () => {
    const f = await fixture();
    try {
      expect(f.check).toBeDefined();
      await expect(f.check!.exercise("user:reader")).rejects.toThrow();
      await expect(f.check!.exercise("user:unknown")).rejects.toThrow();
      expect(await readdir(f.root)).toEqual([]);
    } finally { await f.close(); }
  });

  it("rejects a broken read-back and cleans its temporary directory on failure", async () => {
    const f = await fixture();
    try {
      expect(f.check).toBeDefined();
      const realRead = files.readFileContent;
      vi.spyOn(files, "readFileContent").mockImplementation(async options => ({ ...await realRead(options), content: "Wrong bytes" }));
      await expect(f.check!.exercise("user:owner")).rejects.toThrow("round trip");
      expect(await readdir(f.root)).toEqual([]);
    } finally { await f.close(); }
  });
});
