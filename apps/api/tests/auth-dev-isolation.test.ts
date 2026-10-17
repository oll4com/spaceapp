import { describe, expect, it, vi } from "vitest";

vi.mock("node:fs", async (original) => ({
  ...await original<typeof import("node:fs")>(),
  existsSync: vi.fn(() => true),
  readFileSync: vi.fn(() => JSON.stringify({ clientId: "installed-client", clientSecret: "installed-secret" }))
}));

import { existsSync, readFileSync } from "node:fs";
import { getAuthConfig } from "../src/auth.js";

describe("disabled Google auth in the contributor stack", () => {
  it("does not read installed OAuth credentials", () => {
    vi.mocked(existsSync).mockClear();
    vi.mocked(readFileSync).mockClear();
    const config = getAuthConfig({ SPACE_GOOGLE_AUTH_DISABLED: "true" });
    expect(config.googleClientId).toBeUndefined();
    expect(existsSync).not.toHaveBeenCalled();
    expect(readFileSync).not.toHaveBeenCalled();
  });
});
