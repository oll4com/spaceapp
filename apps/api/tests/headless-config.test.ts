import { describe, expect, it } from "vitest";
import { getApiConfig } from "../src/config.js";

// K2 design §2 (plan clipboard:ZGz1LnD51ELH): SPACE_HEADLESS fixes its pairings; every contradiction refuses to start.
const headless = { SPACE_HEADLESS: "true", SPACE_RUNTIME_STORE: "postgres", SPACE_DATABASE_URL: "postgres://u@127.0.0.1/space" };

describe("SPACE_HEADLESS config", () => {
  it("is off by default and leaves SpaceApp settings alone", () => {
    const config = getApiConfig({ SPACE_RUNTIME_STORE: "postgres", SPACE_DATABASE_URL: headless.SPACE_DATABASE_URL });
    expect(config.headless).toBe(false);
    expect(config.multiUserEnabled).toBe(false);
    expect(config.optionalModules.size).toBeGreaterThan(0);
  });

  it("forces multi-user on and no optional modules", () => {
    for (const extra of [{}, { SPACE_OPTIONAL_MODULES: "none" }, { SPACE_MULTI_USER_ENABLED: "true" }]) {
      const config = getApiConfig({ ...headless, ...extra });
      expect(config).toMatchObject({ headless: true, multiUserEnabled: true, publicDistribution: false });
      expect(config.optionalModules.size).toBe(0);
    }
  });

  it("opens sign-up only for a headless server with a terms version", () => {
    expect(getApiConfig({ ...headless }).signupTermsVersion).toBeUndefined();
    expect(getApiConfig({ ...headless, SPACE_SIGNUP_TERMS_VERSION: " terms-2026-11 " }).signupTermsVersion).toBe("terms-2026-11");
    expect(getApiConfig({ SPACE_SIGNUP_TERMS_VERSION: "terms-2026-11" }).signupTermsVersion).toBeUndefined();
  });

  it("refuses to start on every forbidden pairing", () => {
    expect(() => getApiConfig({ ...headless, SPACE_RUNTIME_STORE: "memory" })).toThrow(/SPACE_RUNTIME_STORE=postgres/);
    expect(() => getApiConfig({ ...headless, SPACE_PUBLIC_DISTRIBUTION: "true" })).toThrow(/SPACE_PUBLIC_DISTRIBUTION/);
    expect(() => getApiConfig({ ...headless, SPACE_MULTI_USER_ENABLED: "false" })).toThrow(/multi-user/);
    for (const modules of ["all", "games", "design,video"]) {
      expect(() => getApiConfig({ ...headless, SPACE_OPTIONAL_MODULES: modules })).toThrow(/SPACE_OPTIONAL_MODULES/);
    }
  });
});
