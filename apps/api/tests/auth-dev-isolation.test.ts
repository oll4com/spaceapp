import { describe, expect, it, vi } from "vitest";

const files = vi.hoisted(() => ({
  existsSync: vi.fn(() => true),
  readFileSync: vi.fn(() => JSON.stringify({ clientId: "installed-client", clientSecret: "installed-secret" }))
}));
vi.mock("node:fs", async (original) => ({ ...await original<typeof import("node:fs")>(), ...files }));
import { getAuthConfig } from "../src/auth.js";

describe("source development OAuth isolation", () => {
  it("does not probe installed files in dev or when Google auth is disabled", () => {
    for (const env of [{ SPACE_INSTANCE: "dev" }, { SPACE_GOOGLE_AUTH_DISABLED: "true" }]) {
      files.existsSync.mockClear(); files.readFileSync.mockClear();
      expect(getAuthConfig(env).googleClientId).toBeUndefined();
      expect(files.existsSync).not.toHaveBeenCalled();
      expect(files.readFileSync).not.toHaveBeenCalled();
    }
  });
  it("retains installed-instance discovery and explicit dev configuration", () => {
    expect(getAuthConfig({}).googleClientId).toBe("installed-client");
    expect(getAuthConfig({ SPACE_INSTANCE: "dev", SPACE_GOOGLE_CLIENT_ID: "own-client", SPACE_GOOGLE_CLIENT_SECRET: "own-secret" }))
      .toMatchObject({ googleClientId: "own-client", googleClientSecret: "own-secret" });
  });
});
