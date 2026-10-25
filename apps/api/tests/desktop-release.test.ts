import { beforeEach, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import { readFile, realpath, stat } from "node:fs/promises";
import { createDesktopLatestHandler, readDesktopRelease } from "../src/desktop-release.js";

vi.mock("node:fs/promises", () => ({ readFile: vi.fn(), realpath: vi.fn(), stat: vi.fn() }));
const directory = "/release";
const manifest = {
  name: "SpaceApp", version: "1.2.3", builtAt: "2026-10-09T00:00:00.000Z",
  targets: [
    { platform: "win32", format: "7z", filename: "SpaceApp-Windows-x64-v1.2.3.7z" },
    { platform: "win32", format: "zip", filename: "SpaceApp-Windows-x64-v1.2.3.zip" },
    { platform: "win32", format: "exe-installer", filename: "SpaceApp-Setup-1.2.3.exe" },
    { platform: "linux", format: "AppImage", filename: "SpaceApp-1.2.3-x86_64.AppImage" },
    { platform: "linux", format: "deb", filename: "spaceapp_1.2.3_amd64.deb" }
  ]
};
const fileInfo = (isFile = true, size = 42) => ({ isFile: () => isFile, size }) as Awaited<ReturnType<typeof stat>>;
async function response() {
  const app = Fastify();
  app.get("/api/desktop/latest", createDesktopLatestHandler(directory));
  try { return await app.inject("/api/desktop/latest"); } finally { await app.close(); }
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(readFile).mockResolvedValue(JSON.stringify(manifest));
  vi.mocked(realpath).mockImplementation(async (path) => String(path));
  vi.mocked(stat).mockResolvedValue(fileInfo());
});

describe("desktop release metadata", () => {
  it("returns only real manifest filenames and keeps the successful response contract", async () => {
    const result = await response();
    expect(result.statusCode).toBe(200);
    expect(result.headers["cache-control"]).toBe("no-store");
    expect(result.json()).toEqual({
      ...manifest,
      targets: manifest.targets.map((target) => ({ ...target, size: 42 })),
      download7zUrl: "/api/desktop/download/SpaceApp-Windows-x64-v1.2.3.7z",
      downloadZipUrl: "/api/desktop/download/SpaceApp-Windows-x64-v1.2.3.zip",
      installerUrl: "/api/desktop/download/SpaceApp-Setup-1.2.3.exe",
      appImageUrl: "/api/desktop/download/SpaceApp-1.2.3-x86_64.AppImage",
      debUrl: "/api/desktop/download/spaceapp_1.2.3_amd64.deb"
    });
  });

  it.each(["{broken", "null", "{}", JSON.stringify({ ...manifest, version: "" }), JSON.stringify({ ...manifest, version: "01.2.3" }), JSON.stringify({ ...manifest, targets: "bad" }), JSON.stringify({ ...manifest, builtAt: "bad" })])("rejects malformed metadata without an invented version", async (raw) => {
    vi.mocked(readFile).mockResolvedValue(raw);
    const result = await response();
    expect(result.statusCode).toBe(503);
    expect(result.json()).toEqual({ code: "DESKTOP_RELEASE_UNAVAILABLE", error: "Desktop update information is temporarily unavailable." });
    expect(result.headers["cache-control"]).toBe("no-store");
  });

  it("returns a sanitized unavailable response for missing manifests", async () => {
    vi.mocked(readFile).mockRejectedValue(new Error("private filesystem detail"));
    const result = await response();
    expect(result.statusCode).toBe(503);
    expect(result.body).not.toContain("private");
    expect(result.json()).not.toHaveProperty("version");
  });

  it.each(["../outside.exe", "nested/file.exe", "file..exe", "%2e%2e.exe"])("rejects unsafe target %s", async (filename) => {
    vi.mocked(readFile).mockResolvedValue(JSON.stringify({ ...manifest, targets: [{ ...manifest.targets[0], filename }] }));
    expect((await response()).statusCode).toBe(503);
    expect(stat).not.toHaveBeenCalled();
  });

  it("omits unavailable targets and returns null rather than broken URLs", async () => {
    vi.mocked(stat).mockImplementation(async (path) => {
      if (String(path).endsWith(".7z")) throw new Error("missing");
      return fileInfo();
    });
    const result = await readDesktopRelease(directory);
    expect(result.download7zUrl).toBeNull();
    expect(result.targets).toHaveLength(4);
    expect(result.installerUrl).toContain("SpaceApp-Setup-1.2.3.exe");
  });

  it.each([fileInfo(false), fileInfo(true, 0)])("rejects directories and empty artifact sets", async (info) => {
    vi.mocked(stat).mockResolvedValue(info);
    expect((await response()).statusCode).toBe(503);
  });

  it("allows in-directory aliases but rejects symlinks outside the release root", async () => {
    vi.mocked(realpath).mockImplementation(async (path) => {
      if (String(path).endsWith(".AppImage")) return "/release/SpaceApp-1.2.3.AppImage";
      if (String(path).endsWith(".7z")) return "/release-other/private.7z";
      return String(path);
    });
    const result = await readDesktopRelease(directory);
    expect(result.appImageUrl).toContain("x86_64.AppImage");
    expect(result.download7zUrl).toBeNull();
  });
});
