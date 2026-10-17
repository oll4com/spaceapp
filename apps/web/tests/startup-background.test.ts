import { afterEach, describe, expect, it, vi } from "vitest";
import { createDemoRuntime } from "../src/demo/demo-runtime.js";
import { liveRuntime } from "../src/live/live-runtime.js";
import { installSpaceRuntime } from "../src/runtime/SpaceRuntime.js";
import { startupBackgroundDelay } from "../src/startup-background.js";

describe("startup background delay", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    installSpaceRuntime(liveRuntime);
  });

  it("defers non-critical startup work in the live app", () => {
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Mozilla/5.0 (X11; Linux x86_64) Chrome/150.0.0.0 Safari/537.36");
    installSpaceRuntime(liveRuntime);
    expect(startupBackgroundDelay()).toBe(4_000);
  });

  // The stable deploy's demo parity gate compares the demo's first render with its settled one; notices that land
  // seconds later failed it at random viewports (2026-10-15).
  it("runs it at once in the demo, so its first render is its settled one", () => {
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Mozilla/5.0 (X11; Linux x86_64) Chrome/150.0.0.0 Safari/537.36");
    installSpaceRuntime(createDemoRuntime().runtime);
    expect(startupBackgroundDelay()).toBe(0);
  });
});
