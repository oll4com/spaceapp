import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

afterEach(() => vi.unstubAllGlobals());
import {
  compareSemver,
  createAppVersionReader,
  parseSemver,
  semverOffsetRecent
} from "../src/app-version.js";

describe("parseSemver", () => {
  it("parses plain versions and strips a leading v", () => {
    expect(parseSemver("v0.1.17")).toEqual({ major: 0, minor: 1, patch: 17, prerelease: null, build: null });
    expect(parseSemver("0.1.0")).toEqual({ major: 0, minor: 1, patch: 0, prerelease: null, build: null });
  });

  it.each(["1.02.3", "1.2.3-beta.01", "1.2.3-beta..1", "1.2.3+build..1", "9007199254740992.0.0"])("rejects invalid SemVer %s", (version) => {
    expect(parseSemver(version)).toBeNull();
  });

  it("rejects malformed inputs", () => {
    expect(parseSemver("not-a-version")).toBeNull();
    expect(parseSemver("")).toBeNull();
  });
});

describe("compareSemver", () => {
  it("orders versions ascending", () => {
    expect(compareSemver("v0.1.0", "v0.1.14")).toBeLessThan(0);
    expect(compareSemver("v0.1.14", "v0.1.10")).toBeGreaterThan(0);
    expect(compareSemver("v0.1.17", "v0.1.17")).toBe(0);
  });

  it("ranks major bumps above minor bumps", () => {
    expect(compareSemver("v0.9.99", "v1.0.0")).toBeLessThan(0);
    expect(compareSemver("v1.0.0", "v0.99.99")).toBeGreaterThan(0);
  });

  it.each([
    ["1.0.0-beta.2", "1.0.0-beta.10"],
    ["1.0.0-rc.9", "1.0.0-rc.10"],
    ["1.0.0-alpha", "1.0.0-alpha.1"],
    ["1.0.0-alpha.1", "1.0.0-alpha.beta"],
    ["1.0.0-9", "1.0.0-A"],
    ["1.0.0-Z", "1.0.0-a"],
    ["1.0.0-9007199254740992", "1.0.0-9007199254740993"],
    ["1.0.0-rc.10", "1.0.0"]
  ])("orders %s before %s using SemVer precedence", (older, newer) => {
    expect(compareSemver(older, newer)).toBeLessThan(0);
    expect(compareSemver(newer, older)).toBeGreaterThan(0);
  });

  it("ignores build metadata in precedence", () => {
    expect(compareSemver("1.2.3-beta.2+first", "1.2.3-beta.2+second")).toBe(0);
  });

  it("sorts prereleases before their release", () => {
    expect(compareSemver("v0.2.0-beta.1", "v0.2.0")).toBeLessThan(0);
    expect(compareSemver("v0.2.0", "v0.2.0-beta.1")).toBeGreaterThan(0);
  });
});

describe("semverOffsetRecent", () => {
  it("returns 0 when current is up to date", () => {
    expect(semverOffsetRecent("v0.1.17", "v0.1.17")).toBe(0);
    expect(semverOffsetRecent("v0.1.18", "v0.1.17")).toBe(0);
  });

  it("computes the largest component gap when behind", () => {
    expect(semverOffsetRecent("v0.1.0", "v0.1.14")).toBe(14);
    expect(semverOffsetRecent("v0.1.0", "v1.0.3")).toBe(3);
  });
});

describe("createAppVersionReader", () => {
  it("defaults to the packaged version rather than a placeholder", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }));
    const expected = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
    expect((await createAppVersionReader({}).status()).appRelease).toBe(`v${expected}`);
  });

  it("detects a later numeric prerelease update", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ tag_name: "v1.0.0-beta.10" }) }));
    expect((await createAppVersionReader({ appVersionEnv: "v1.0.0-beta.2" }).status()).updateAvailable).toBe(true);
  });

  it("offers the installer update command only on public installations", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ tag_name: "v1.1.3" }) }));
    const publicStatus = await createAppVersionReader({ appVersionEnv: "1.1.2", publicDistribution: true }).status();
    expect(publicStatus).toMatchObject({ updateAvailable: true, updateCommand: "npx --yes run-spaceapp@latest update" });
    expect((await createAppVersionReader({ appVersionEnv: "1.1.2" }).status()).updateCommand).toBeNull();
  });

  it("keeps updateAvailable false when no GitHub latest is reachable", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const realFetch = (globalThis as any).fetch;
    // Patch fetch to fail deterministically.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).fetch = async () => ({ ok: false, json: async () => ({}) });
    try {
      const reader = createAppVersionReader({
        appVersionEnv: "v0.1.99"
      });
      const status = await reader.status();
      expect(status.appRelease).toBe("v0.1.99");
      expect(status.updateAvailable).toBe(false);
      expect(status.githubLatest).toBeNull();
      expect(status.behindCount).toBe(0);
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (globalThis as any).fetch = realFetch;
    }
  });

  it("exposes current commit metadata from git state", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }));
    // Its own repository, so the test also runs where the tree is not a git checkout (the public export).
    const gitRoot = mkdtempSync(join(tmpdir(), "space-app-version-"));
    try {
      execFileSync("git", ["init", "-q"], { cwd: gitRoot });
      execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-q", "--allow-empty", "-m", "x"], { cwd: gitRoot });
      const status = await createAppVersionReader({ appVersionEnv: "v0.1.17", gitRoot }).status();
      expect(typeof status.appRelease).toBe("string");
      expect(status.currentCommit).toMatch(/^[0-9a-f]{40}$/);
      expect(typeof status.shortCommit).toBe("string");
      // A detached checkout (merge-queue builds, release worktrees) has no current branch.
      expect(status.currentBranch === null || typeof status.currentBranch === "string").toBe(true);
      expect(typeof status.dirty).toBe("boolean");
      expect(status.checkedAt).toBeTruthy();
    } finally {
      rmSync(gitRoot, { recursive: true, force: true });
    }
  });
});