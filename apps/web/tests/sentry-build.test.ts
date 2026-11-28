// @vitest-environment node
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Plugin } from "vite";
import { describe, expect, it, vi } from "vitest";
import { boundUpload, sentryWebBuild } from "../vite.sentry.js";

describe("private build-time source maps", () => {
  it("does not even load the uploader without a token, or in the dev server", async () => {
    const load = vi.fn();
    expect((await sentryWebBuild({}, "build", load)).sourcemap).toBe(false);
    expect((await sentryWebBuild({ SENTRY_AUTH_TOKEN: "synthetic" }, "serve", load)).sourcemap).toBe(false);
    expect(load).not.toHaveBeenCalled();
  });
  it("uploads hidden maps against the commit SHA and deletes them afterwards", async () => {
    const sentryVitePlugin = vi.fn(() => []);
    const load = vi.fn(async () => ({ sentryVitePlugin }));
    const config = await sentryWebBuild({ SENTRY_AUTH_TOKEN: "synthetic", SENTRY_RELEASE: "b".repeat(40), SENTRY_ORG: "test", SENTRY_PROJECT: "web" }, "build", load);
    expect(config.sourcemap).toBe("hidden");
    expect(sentryVitePlugin).toHaveBeenCalledWith(expect.objectContaining({ telemetry: false, release: { name: "b".repeat(40), inject: false }, sourcemaps: { assets: ["./dist/assets/**"], filesToDeleteAfterUpload: ["./dist/**/*.map"] } }));
  });
  it("a stalled upload ends the build step like a failed one: maps deleted, vite let go (q-20261127-223542-a6f7)", async () => {
    const dist = await mkdtemp(join(tmpdir(), "sentry-bound-"));
    try {
      await mkdir(join(dist, "assets"));
      await writeFile(join(dist, "assets", "app.js"), "x");
      await writeFile(join(dist, "assets", "app.js.map"), "{}");
      const exit = vi.fn();
      const stalled: Plugin = { name: "stalled", writeBundle: () => new Promise<void>(() => {}) };
      const bounded = boundUpload(stalled, { limitMs: 20, dist, exit }).writeBundle as () => Promise<void>;
      vi.useFakeTimers({ toFake: ["setTimeout"] });
      try {
        const done = bounded();
        await vi.advanceTimersByTimeAsync(20);
        await done;
        expect(await readdir(join(dist, "assets"))).toEqual(["app.js"]);
        await vi.advanceTimersByTimeAsync(30_000);
        expect(exit).toHaveBeenCalledOnce();
      } finally {
        vi.useRealTimers();
      }
      const quick = vi.fn(async () => {});
      await (boundUpload({ name: "quick", writeBundle: quick }, { limitMs: 20, dist, exit }).writeBundle as () => Promise<void>)();
      expect(quick).toHaveBeenCalledOnce();
      expect(exit).toHaveBeenCalledOnce();
    } finally {
      await rm(dist, { recursive: true, force: true });
    }
  });
});
