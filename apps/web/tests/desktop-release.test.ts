import { describe, expect, it } from "vitest";
import {
  compareDesktopVersions,
  desktopReleaseDownloadUrl,
  desktopUpdateIsDownloadOnly,
  isDesktopVersionNewer,
  parseDesktopRelease
} from "../src/features/desktop-titlebar/desktop-release.js";

describe("desktop release versions", () => {
  it("orders prereleases by SemVer 2.0 precedence", () => {
    const ascending = [
      "1.0.0-alpha",
      "1.0.0-alpha.1",
      "1.0.0-alpha.beta",
      "1.0.0-beta",
      "1.0.0-beta.2",
      "1.0.0-beta.11",
      "1.0.0-rc.1",
      "1.0.0"
    ];
    for (let index = 1; index < ascending.length; index += 1) {
      expect(compareDesktopVersions(ascending[index - 1]!, ascending[index]!)).toBe(-1);
      expect(compareDesktopVersions(ascending[index]!, ascending[index - 1]!)).toBe(1);
    }
  });

  it("offers an update from a prerelease to its release and between prereleases", () => {
    expect(isDesktopVersionNewer("0.1.22", "0.1.22-beta.1")).toBe(true);
    expect(isDesktopVersionNewer("0.1.22-beta.2", "0.1.22-beta.1")).toBe(true);
    expect(isDesktopVersionNewer("0.1.22-beta.1", "0.1.22")).toBe(false);
    expect(isDesktopVersionNewer("0.1.22-beta.1", "0.1.21")).toBe(true);
    expect(isDesktopVersionNewer("0.1.21", "0.1.21")).toBe(false);
  });

  it("compares long numeric identifiers without precision loss and ignores build metadata", () => {
    expect(compareDesktopVersions("1.0.0-9007199254740993", "1.0.0-9007199254740992")).toBe(1);
    expect(compareDesktopVersions("1.0.0+build.2", "1.0.0+build.1")).toBe(0);
    expect(compareDesktopVersions("v0.1.21", "0.1.21")).toBe(0);
  });

  it("fails closed for unknown or malformed versions", () => {
    expect(isDesktopVersionNewer("0.1.22", "unknown")).toBe(false);
    expect(isDesktopVersionNewer("0.1.22", "")).toBe(false);
    expect(isDesktopVersionNewer("0.1.22", undefined)).toBe(false);
    expect(isDesktopVersionNewer("latest", "0.1.21")).toBe(false);
    expect(compareDesktopVersions("01.1.0", "1.1.0")).toBeNull();
    expect(compareDesktopVersions("1.0.0-01", "1.0.0")).toBeNull();
    expect(compareDesktopVersions("1.0", "1.0.0")).toBeNull();
  });
});

describe("desktop release payload", () => {
  const payload = {
    version: "0.1.21",
    name: "SpaceApp",
    builtAt: "2026-10-04T13:12:48.164Z",
    download7zUrl: "/api/desktop/download/SpaceApp-Windows-x64-v0.1.21.7z",
    downloadZipUrl: "/api/desktop/download/SpaceApp-Windows-x64-v0.1.21.zip",
    installerUrl: "/api/desktop/download/SpaceApp-Setup-0.1.21.exe",
    appImageUrl: "/api/desktop/download/SpaceApp-0.1.21-x86_64.AppImage",
    debUrl: "/api/desktop/download/spaceapp_0.1.21_amd64.deb"
  };

  it("picks the verified artifact for the current platform", () => {
    const release = parseDesktopRelease(payload);
    expect(desktopReleaseDownloadUrl(release, "win32")).toBe(payload.installerUrl);
    expect(desktopReleaseDownloadUrl(release, "linux")).toBe(payload.appImageUrl);
    expect(desktopReleaseDownloadUrl(release, "darwin")).toBeNull();
    expect(desktopReleaseDownloadUrl(parseDesktopRelease({ ...payload, installerUrl: null }), "win32")).toBe(payload.downloadZipUrl);
    expect(desktopReleaseDownloadUrl(parseDesktopRelease({ ...payload, appImageUrl: null }), "linux")).toBe(payload.debUrl);
  });

  it("rejects malformed payloads and URLs outside the download route", () => {
    expect(parseDesktopRelease(null)).toBeNull();
    expect(parseDesktopRelease({ code: "DESKTOP_RELEASE_UNAVAILABLE" })).toBeNull();
    expect(parseDesktopRelease({ ...payload, version: "next" })).toBeNull();
    const release = parseDesktopRelease({
      ...payload,
      installerUrl: "https://example.com/SpaceApp-Setup.exe",
      downloadZipUrl: "/api/desktop/download/",
      download7zUrl: "/api/desktop/download/../secrets"
    });
    expect(release).not.toBeNull();
    expect(desktopReleaseDownloadUrl(release, "win32")).toBeNull();
  });
});

describe("desktop update path", () => {
  it("downloads through the page for Linux apps before 0.1.25, whose script updater cannot work", () => {
    expect(desktopUpdateIsDownloadOnly("linux", "0.1.23")).toBe(true);
    expect(desktopUpdateIsDownloadOnly("linux", "0.1.24")).toBe(true);
    expect(desktopUpdateIsDownloadOnly("linux", undefined)).toBe(true);
    expect(desktopUpdateIsDownloadOnly("linux", "0.1.25")).toBe(false);
    expect(desktopUpdateIsDownloadOnly("win32", "0.1.23")).toBe(false);
  });
});
