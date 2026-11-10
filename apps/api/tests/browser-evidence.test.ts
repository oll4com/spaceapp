import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildBrowserEvidenceTargetUrl, createBrowserEvidenceCapture } from "../src/browser-evidence.js";

describe("browser evidence target origin", () => {
  it("allows the instance's own https host and strips path/query/hash/userinfo", () => {
    expect(buildBrowserEvidenceTargetUrl("https://user:pw@space.example.test:4911/room?q=raw#frag")).toBe("https://space.example.test:4911/");
    expect(buildBrowserEvidenceTargetUrl("http://127.0.0.1:4911/x")).toBe("http://127.0.0.1:4911/");
  });

  it("rejects a plain http host that is not loopback", () => {
    expect(() => buildBrowserEvidenceTargetUrl("http://example.com/")).toThrow(/BROWSER_TARGET_BLOCKED|restricted/i);
  });

  it("captures only loopback or the instance's own host", async () => {
    const capture = createBrowserEvidenceCapture({ enabled: true, chromePath: "/nonexistent", artifactRoot: "/nonexistent", timeoutMs: 1_000,
      targetOrigin: "https://space.example.test:4911" });
    await expect(capture({ targetUrl: "https://example.com/", viewport: "desktop", traceId: "t" } as Parameters<typeof capture>[0])).rejects.toThrow(/restricted/i);
  });

  // DATA-001 (2026-11-03): 148 empty capture folders on stable had no artifact row; a failed capture leaves none.
  it("leaves no capture folder when Chrome never starts", async () => {
    const root = await mkdtemp(join(tmpdir(), "evidence-root-"));
    try {
      const capture = createBrowserEvidenceCapture({ enabled: true, chromePath: "/bin/false", artifactRoot: root, timeoutMs: 1_000,
        targetOrigin: "https://space.example.test:4911" });
      await expect(capture({ roomId: "room:x", targetUrl: "http://127.0.0.1:1/", viewport: "desktop", traceId: "t" } as Parameters<typeof capture>[0]))
        .rejects.toThrow();
      expect(await readdir(join(root, "browser-evidence")).catch(() => [])).toEqual([]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
