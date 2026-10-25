import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { searchFiles } from "../files-service.js";

let root: string;
beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), "space-search-")); });
afterEach(async () => { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });
const user = { id: "operator", email: "operator@example.test", role: "ADMIN" as const };

async function fakeRg(script: string) {
  await writeFile(path.join(root, "rg"), `#!/bin/sh\n${script}\n`);
  await chmod(path.join(root, "rg"), 0o700);
  vi.stubEnv("PATH", `${root}:/usr/bin:/bin`);
}

describe("file search error semantics", () => {
  it("returns an explicit EMPTY_RESULT only for a successful search with no matches", async () => {
    const result = await searchFiles({ targetPath: root, query: "missing", mode: "admin", user });
    expect(result).toEqual({ query: "missing", results: [], totalCount: 0, code: "EMPTY_RESULT", truncated: false });
  });
  it("returns OK with matches and reports truncation at the limit", async () => {
    await writeFile(path.join(root, "match-a.txt"), "a");
    await writeFile(path.join(root, "match-b.txt"), "b");
    const host = await searchFiles({ targetPath: root, query: "match", mode: "admin", user, limit: 1 });
    expect(host).toMatchObject({ code: "OK", totalCount: 1, truncated: true });
    const workspace = await searchFiles({ targetPath: root, query: "match", workspaceRoot: root });
    expect(workspace).toMatchObject({ code: "OK", totalCount: 2, truncated: false });
    const workspaceEmpty = await searchFiles({ targetPath: root, query: "nothing", workspaceRoot: root });
    expect(workspaceEmpty).toMatchObject({ code: "EMPTY_RESULT", totalCount: 0 });
  });
  it("reports an unavailable search tool instead of returning zero matches", async () => {
    vi.stubEnv("PATH", root);
    await expect(searchFiles({ targetPath: root, query: "missing", mode: "admin", user }))
      .rejects.toMatchObject({ statusCode: 503, code: "TOOL_UNAVAILABLE" });
  });
  it("reports denied executable permissions instead of returning zero matches", async () => {
    await writeFile(path.join(root, "rg"), "#!/bin/sh\nexit 0\n");
    await chmod(path.join(root, "rg"), 0o600);
    vi.stubEnv("PATH", root);
    await expect(searchFiles({ targetPath: root, query: "missing", mode: "admin", user }))
      .rejects.toMatchObject({ statusCode: 403, code: "PERMISSION_DENIED" });
  });
  it("reports a search tool that exceeds its time limit as TIMEOUT", async () => {
    await fakeRg("exec sleep 30");
    await expect(searchFiles({ targetPath: root, query: "slow", mode: "admin", user }))
      .rejects.toMatchObject({ statusCode: 504, code: "TIMEOUT" });
  }, 20_000);
  it("reports permission errors from the search tool instead of returning zero matches", async () => {
    await fakeRg("echo 'rg: ./private: Permission denied (os error 13)' >&2\nexit 2");
    await expect(searchFiles({ targetPath: root, query: "file", mode: "admin", user }))
      .rejects.toMatchObject({ statusCode: 403, code: "PERMISSION_DENIED" });
  });
  it("does not hide an invalid search target as an empty search", async () => {
    await expect(searchFiles({ targetPath: path.join(root, "missing"), query: "file", mode: "admin", user }))
      .rejects.toMatchObject({ statusCode: 502, code: "SEARCH_FAILED" });
  });
  it.skipIf(process.getuid?.() === 0)("reports workspace directory permission denial with a structured code", async () => {
    await chmod(root, 0o000);
    try {
      await expect(searchFiles({ targetPath: root, query: "file", workspaceRoot: root }))
        .rejects.toMatchObject({ statusCode: 403, code: "PERMISSION_DENIED" });
    } finally { await chmod(root, 0o700); }
  });
});
