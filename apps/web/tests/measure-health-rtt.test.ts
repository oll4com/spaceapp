import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { measureHealthRtt } from "../src/features/system-health/measure-health-rtt.js";
import { api } from "../src/api.js";
import * as SpaceRuntime from "../src/runtime/SpaceRuntime.js";

describe("measureHealthRtt", () => {
  const originalPerformance = globalThis.performance;

  beforeEach(() => {
    vi.restoreAllMocks();
    SpaceRuntime.installSpaceRuntime({
      kind: "live",
      api: {
        healthPing: vi.fn().mockResolvedValue({ ok: true }),
      } as unknown as SpaceRuntime.SpaceApiClient,
      events: { supported: false, open: vi.fn() } as unknown as SpaceRuntime.SpaceEventGateway,
      terminal: { supported: false, connect: vi.fn() } as unknown as SpaceRuntime.SpaceSocketGateway,
      browser: { supported: false, connect: vi.fn() } as unknown as SpaceRuntime.SpaceSocketGateway,
      platform: {
        localStorage: { getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn(), clear: vi.fn() },
      } as unknown as SpaceRuntime.PlatformGateway,
      reset: vi.fn(),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns 42 in demo runtime", async () => {
    vi.spyOn(SpaceRuntime, "getSpaceRuntimeKind").mockReturnValue("demo");
    const result = await measureHealthRtt();
    expect(result).toBe(42);
  });

  it("uses Resource Timing responseStart - requestStart when available", async () => {
    // Mock performance with entries where wall-clock is inflated (e.g. 500ms) but wire RTT is 210ms
    const mockEntries: PerformanceResourceTiming[] = [
      {
        name: "http://localhost/healthz",
        requestStart: 250,
        responseStart: 460, // 460 - 250 = 210ms wire RTT
      } as PerformanceResourceTiming,
    ];

    let callCount = 0;
    vi.stubGlobal("performance", {
      now: () => {
        callCount++;
        return callCount === 1 ? 0 : 500; // 500ms wall-clock elapsed
      },
      getEntriesByName: (url: string) => {
        if (url.includes("/healthz")) return mockEntries;
        return [];
      },
      clearResourceTimings: vi.fn(),
    });

    vi.stubGlobal("window", {
      location: { href: "http://localhost/" },
    });

    const result = await measureHealthRtt();
    expect(result).toBe(210);
  });

  it("falls back to wall-clock time if Resource Timing is unavailable", async () => {
    let callCount = 0;
    vi.stubGlobal("performance", {
      now: () => {
        callCount++;
        return callCount === 1 ? 100 : 315; // 215ms wall-clock
      },
      getEntriesByName: () => [],
    });

    const result = await measureHealthRtt();
    expect(result).toBe(215);
  });

  it("supports custom ping function", async () => {
    const customPing = vi.fn().mockResolvedValue(true);
    let callCount = 0;
    vi.stubGlobal("performance", {
      now: () => {
        callCount++;
        return callCount === 1 ? 50 : 150;
      },
      getEntriesByName: () => [],
    });

    const result = await measureHealthRtt(customPing);
    expect(customPing).toHaveBeenCalled();
    expect(result).toBe(100);
  });
});
