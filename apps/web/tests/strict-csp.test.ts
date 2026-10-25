import { afterEach, describe, expect, it } from "vitest";
import { enableStrictCspCompatibility } from "../src/strict-csp.js";

type ZodConfigHost = typeof globalThis & {
  __zod_globalConfig?: Record<string, unknown> & { jitless?: boolean };
};

const host = globalThis as ZodConfigHost;
const originalConfig = host.__zod_globalConfig;

afterEach(() => {
  if (originalConfig === undefined) delete host.__zod_globalConfig;
  else host.__zod_globalConfig = originalConfig;
});

describe("strict CSP compatibility", () => {
  it("preconfigures Zod's supported jitless mode without discarding existing global settings", () => {
    host.__zod_globalConfig = { existingSetting: "preserved" };
    const existingConfig = host.__zod_globalConfig;

    enableStrictCspCompatibility();

    expect(host.__zod_globalConfig).toBe(existingConfig);
    expect(host.__zod_globalConfig).toEqual({ existingSetting: "preserved", jitless: true });
  });
});
