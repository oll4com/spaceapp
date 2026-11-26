import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LinkFileError, pullLinkFile, type LinkCall } from "../src/instance-link/files.js";
import type { InstanceLinks } from "../src/instance-link/routes.js";
import { historicalToolHold } from "../src/nous/tool-holds.js";
import { createNousTools } from "../src/nous/tools.js";

const ctx = { owner: "user:operator", turnId: "nous_turn:rf25", callId: "toolu_rf25", traceId: "trace:rf25" };
const link = {
  id: "link:hz",
  label: "SpaceApp example.invalid",
  origins: ["https://example.invalid"],
  deviceId: "appdev:hz",
  scopes: ["read", "act", "manage"],
  createdAt: "2026-11-13T00:00:00.000Z",
  lastSeenAt: "2026-11-24T10:00:00.000Z",
  connected: true
};

const tempDirs: string[] = [];
afterEach(() => {
  while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe("2026-11-25 REVIEW: space_remote_file folder and invalid/missing remote paths", () => {
  it("pullLinkFile returns directory listing for folder paths instead of throwing", async () => {
    const call: LinkCall = vi.fn(async () => ({
      status: 200,
      headers: {},
      bytes: new Uint8Array(),
      body: {
        path: "income-research",
        folder: true,
        entries: [{ name: "13067306.html", folder: false, size: 120 }, { name: "ai", folder: true, size: null }]
      }
    }));
    const result = await pullLinkFile(call, { path: "income-research" }, () => { throw new Error("should not pick destination for folder"); });
    expect(result).toEqual({
      folder: true,
      path: "income-research",
      entries: [{ name: "13067306.html", folder: false }, { name: "ai", folder: true }]
    });
  });

  it("pullLinkFile preserves / in nested remote paths (no %2F) and rejects traversal paths with refused LinkFileError", async () => {
    const dir = mkdtempSync(join(tmpdir(), "space-link-file-"));
    tempDirs.push(dir);
    const payload = Buffer.from("nested content\n");
    const sha256 = createHash("sha256").update(payload).digest("hex");
    const requestedPaths: string[] = [];
    const call: LinkCall = async (_method, path) => {
      requestedPaths.push(path);
      if (path.startsWith("/api/nous/files/stat")) {
        return { status: 200, headers: {}, bytes: new Uint8Array(), body: { path: "income-research/13067306.html", folder: false, size: payload.length, sha256 } };
      }
      return {
        status: 206,
        headers: { "content-range": `bytes 0-${payload.length - 1}/${payload.length}` },
        bytes: new Uint8Array(payload),
        body: null
      };
    };
    const dest = join(dir, "13067306.html");
    const got = await pullLinkFile(call, { path: "income-research/13067306.html" }, () => ({ absolute: dest, shown: "nous/link-files/hz/13067306.html" }));
    expect(got).toMatchObject({ folder: false, shown: "nous/link-files/hz/13067306.html", size: payload.length, sha256, already: false });
    expect(readFileSync(dest, "utf8")).toBe("nested content\n");
    expect(requestedPaths).toEqual([
      "/api/nous/files/stat?path=income-research/13067306.html",
      "/api/nous/files/content?path=income-research/13067306.html"
    ]);
    expect(requestedPaths.every((p) => !/%2f/i.test(p))).toBe(true);

    const untouched = vi.fn();
    for (const bad of ["../secret.txt", "a/../b.md", "income-research\\file.md", "income-research%2Ffile.md", "%2e%2e/x"]) {
      await expect(pullLinkFile(untouched, { path: bad }, () => ({ absolute: dest, shown: "x" }))).rejects.toMatchObject({
        status: 400,
        code: "MOBILE_BAD_PATH",
        refused: true
      });
    }
    expect(untouched).not.toHaveBeenCalled();
  });

  it("space_remote_file returns ok:true directory listing for folders (non-empty and empty)", async () => {
    const request = vi.fn(async (_owner: string, _ref: string, _method: string, path: string) => ({
      link,
      scopes: link.scopes,
      status: 200,
      headers: {},
      bytes: new Uint8Array(),
      rttMs: 10,
      body: path.includes("empty-dir")
        ? { path: "empty-dir", folder: true, entries: [] }
        : { path: "income-research", folder: true, entries: [{ name: "13067306.html", folder: false }, { name: "ai", folder: true }] }
    }));
    const links: InstanceLinks = { list: async () => [link], peers: async () => [], parity: async () => { throw new Error("unused"); }, lend: async () => { throw new Error("unused"); }, request: request as unknown as InstanceLinks["request"] };
    const tools = createNousTools({ instanceLinks: () => links, files: { ownFile: (p: string) => ({ absolute: p, shown: p }) } } as never);

    const listed = await tools.execute("space_remote_file", { instance: "spaceapp-hz", direction: "pull", path: "income-research" }, ctx as never);
    expect(listed).toEqual({
      ok: true,
      display: "Read directory listing for income-research on SpaceApp example.invalid",
      result: "income-research is a folder on SpaceApp example.invalid; its files: 13067306.html, ai/. Pull one of these files with space_remote_file."
    });

    const empty = await tools.execute("space_remote_file", { instance: "spaceapp-hz", direction: "pull", path: "empty-dir" }, ctx as never);
    expect(empty).toEqual({
      ok: true,
      display: "Read directory listing for empty-dir on SpaceApp example.invalid",
      result: "empty-dir is a folder on SpaceApp example.invalid; its files: (empty). Pull one of these files with space_remote_file."
    });
  });

  it("space_remote_file holds traversal paths and remote 400/404 responses with guidance, while keeping 500 as a failure", async () => {
    const request = vi.fn(async (_owner: string, _ref: string, _method: string, path: string) => {
      if (path.includes("bad400")) {
        return { link, scopes: link.scopes, status: 400, headers: {}, bytes: new Uint8Array(), rttMs: 5,
          body: { error: { code: "MOBILE_BAD_PATH", message: "Only /api/ paths without traversal." } } };
      }
      if (path.includes("missing")) {
        return { link, scopes: link.scopes, status: 404, headers: {}, bytes: new Uint8Array(), rttMs: 5,
          body: { error: { code: "NOT_FOUND", message: "No file or folder missing.md under the agent workspace. Nearest existing folder: .. Closest names there: income-research." } } };
      }
      return { link, scopes: link.scopes, status: 500, headers: {}, bytes: new Uint8Array(), rttMs: 5, body: { error: { code: "INTERNAL", message: "boom" } } };
    });
    const links: InstanceLinks = { list: async () => [link], peers: async () => [], parity: async () => { throw new Error("unused"); }, lend: async () => { throw new Error("unused"); }, request: request as unknown as InstanceLinks["request"] };
    const tools = createNousTools({ instanceLinks: () => links, files: { ownFile: (p: string) => ({ absolute: p, shown: p }) } } as never);

    const traversal = await tools.execute("space_remote_file", { instance: "spaceapp-hz", direction: "pull", path: "../etc/passwd" }, ctx as never);
    expect(traversal).toMatchObject({ ok: false, refused: true, result: expect.stringContaining("traversal") });

    const bad400 = await tools.execute("space_remote_file", { instance: "spaceapp-hz", direction: "pull", path: "bad400" }, ctx as never);
    expect(bad400).toMatchObject({ ok: false, refused: true, result: expect.stringContaining("MOBILE_BAD_PATH") });

    const missing404 = await tools.execute("space_remote_file", { instance: "spaceapp-hz", direction: "pull", path: "missing.md" }, ctx as never);
    expect(missing404).toMatchObject({ ok: false, refused: true, result: expect.stringContaining("Nearest existing folder") });

    const server500 = await tools.execute("space_remote_file", { instance: "spaceapp-hz", direction: "pull", path: "crash.md" }, ctx as never);
    expect(server500.ok).toBe(false);
    expect(server500.refused).toBeUndefined();
    expect(server500.result).toContain("It answered 500");

    expect(new LinkFileError("x", { status: 404, refused: true })).toMatchObject({ status: 404, refused: true });
  });

  it("historicalToolHold recognizes the 24/11 folder, 400 MOBILE_BAD_PATH and 404 NOT_FOUND samples, while keeping 500/transport failures counted", () => {
    expect(historicalToolHold("space_remote_file", 'It answered 400: {"error":{"code":"MOBILE_BAD_PATH","message":"Only /api/ paths without traversal."}}')).toBe(true);
    expect(historicalToolHold("space_remote_file", 'It answered 404: {"error":{"code":"NOT_FOUND","message":"No file or folder income-fallback-20261124.md under the agent workspace."}}')).toBe(true);
    expect(historicalToolHold("space_remote_file", "income-research is a folder there; give one of its files: 13067306.html, ai/.")).toBe(true);
    expect(historicalToolHold("space_remote_file", 'It answered 500: {"error":{"code":"INTERNAL","message":"boom"}}')).toBe(false);
    expect(historicalToolHold("space_remote_file", "The pieces add up to SHA-256 aaa, not the bbb it named")).toBe(false);
  });
});
