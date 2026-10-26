// 龙娘 · 2026-10-26: real React Refresh export inspection must not require a mounted runtime.
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const refreshRuntimeUrl = pathToFileURL(join(dirname(require.resolve("@vitejs/plugin-react")), "refresh-runtime.js")).href;

describe("Space API proxy during React Refresh registration", () => {
  beforeEach(() => vi.resetModules());

  it("allows the installed Vite React Refresh runtime to register exports before a provider mounts", async () => {
    const runtime = await import("../src/runtime/SpaceRuntime.js");
    const refresh = await import(/* @vite-ignore */ refreshRuntimeUrl);
    expect(runtime.getSpaceRuntimeKind()).toBeNull();
    expect(() => refresh.registerExportsForReactRefresh("SpaceRuntime.tsx", runtime)).not.toThrow();
    expect(runtime.getSpaceRuntimeKind()).toBeNull();
  });

  it("supports object reflection while preserving the missing-provider error for actual API access", async () => {
    const { api, eventGateway, terminalGateway, browserGateway, getSpaceRuntimeKind } = await import("../src/runtime/SpaceRuntime.js");
    expect(Object.prototype.toString.call(api)).toBe("[object Object]");
    expect(Reflect.get(api, "constructor")).toBe(Object);
    expect(Reflect.get(api, Symbol.toStringTag)).toBeUndefined();
    expect(String(api)).toBe("[object Object]");
    expect(getSpaceRuntimeKind()).toBeNull();
    expect(() => api.rooms).toThrow("SpaceRuntimeProvider is required");
    for (const gateway of [eventGateway, terminalGateway, browserGateway]) {
      expect(Object.prototype.toString.call(gateway)).toBe("[object SpaceRuntimeGateway]");
      expect(Object.getOwnPropertyDescriptor(gateway, Symbol.toStringTag)?.enumerable).toBe(false);
      expect(() => gateway.supported).toThrow("SpaceRuntimeProvider is required");
    }
  });
});
