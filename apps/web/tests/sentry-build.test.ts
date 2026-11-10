// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { sentryWebBuild } from "../vite.sentry.js";

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
});
