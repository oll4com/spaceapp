import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AppVersionStatus } from "../src/live-api.js";
import { isUpdateAvailable, versionLabel, fetchAppVersion } from "../src/features/app-version/version-check.js";
import { api } from "../src/api.js";

vi.mock("../src/api.js", () => ({ api: { appVersion: vi.fn() } }));

const sample: AppVersionStatus = {
  appRelease: "v0.1.17",
  currentCommit: "deadbeef",
  shortCommit: "deadbee",
  currentBranch: "main",
  dirty: false,
  athensTag: "v2026.08.06.1",
  githubLatest: "v0.1.17",
  githubTagUrl: "https://github.com/oll4com/spaceapp/releases/tag/v0.1.17",
  updateAvailable: false,
  behindCount: 0,
  checkedAt: "2026-08-07T00:00:00Z",
};

describe("version-check helpers", () => {
  it("isUpdateAvailable is true only when update exists", () => {
    expect(isUpdateAvailable(sample)).toBe(false);
    expect(isUpdateAvailable({ ...sample, updateAvailable: true })).toBe(true);
    expect(isUpdateAvailable(null)).toBe(false);
  });

  it("versionLabel falls back to placeholder when no status", () => {
    expect(versionLabel(sample)).toBe("v0.1.17");
    expect(versionLabel(null)).toBe("…");
  });

  it("versionLabel prefers the latest GitHub tag over the local release", () => {
    expect(versionLabel({ ...sample, githubLatest: "v0.1.29" })).toBe("v0.1.29");
    expect(versionLabel({ ...sample, githubLatest: null })).toBe("v0.1.17");
  });
});

describe("fetchAppVersion", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("resolves with the api payload", async () => {
    vi.mocked(api.appVersion).mockResolvedValue(sample);
    await expect(fetchAppVersion()).resolves.toEqual(sample);
    expect(api.appVersion).toHaveBeenCalledOnce();
  });

  it("returns null on error", async () => {
    vi.mocked(api.appVersion).mockRejectedValue(new Error("boom"));
    await expect(fetchAppVersion()).resolves.toBeNull();
  });
});