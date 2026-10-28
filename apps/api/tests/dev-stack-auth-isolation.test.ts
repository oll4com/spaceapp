// Longniang, 2026-10-28: opt out explicitly without changing other dev deployments.
import { beforeEach, describe, expect, it, vi } from "vitest";

const installedPath = "/opt/spaceapp/secrets/google-oauth.json";
const fallbackPath = "/var/lib/spaceapp/google-oauth.json";
const fakeClient = { clientId: "test-only-installed-client", clientSecret: "test-only-installed-secret" };
const filesystem = vi.hoisted(() => ({ existsSync: vi.fn(), readFileSync: vi.fn() }));

vi.mock("node:fs", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:fs")>(),
  existsSync: filesystem.existsSync,
  readFileSync: filesystem.readFileSync
}));

import { getAuthConfig } from "../src/auth.js";

beforeEach(() => {
  filesystem.existsSync.mockReset().mockImplementation((path) => String(path) === installedPath);
  // Every read is synthetic. This test never opens an actual installed secret.
  filesystem.readFileSync.mockReset().mockImplementation((path) => {
    if (![installedPath, fallbackPath].includes(String(path))) throw new Error("Unexpected file read in auth isolation test");
    return JSON.stringify(fakeClient);
  });
});

describe("development stack OAuth credential isolation", () => {
  it.each(["dev", "stable"])("never probes installed OAuth files when %s explicitly disables discovery", (instance) => {
    const auth = getAuthConfig({ SPACE_INSTANCE: instance, SPACE_GOOGLE_AUTH_DISABLED: "true" });
    expect(auth.googleClientId).toBeUndefined();
    expect(auth.googleClientSecret).toBeUndefined();
    expect(filesystem.existsSync).not.toHaveBeenCalled();
    expect(filesystem.readFileSync).not.toHaveBeenCalled();
  });

  it("preserves existing dev-instance discovery unless explicitly disabled", () => {
    const auth = getAuthConfig({ SPACE_INSTANCE: "dev" });
    expect(auth.googleClientId).toBe(fakeClient.clientId);
    expect(auth.googleClientSecret).toBe(fakeClient.clientSecret);
    expect(filesystem.existsSync).toHaveBeenCalledExactlyOnceWith(installedPath);
    expect(filesystem.readFileSync).toHaveBeenCalledExactlyOnceWith(installedPath, "utf8");
  });

  it("preserves default stable-instance discovery of an existing installed client", () => {
    const auth = getAuthConfig({});
    expect(auth.googleClientId).toBe(fakeClient.clientId);
    expect(auth.googleClientSecret).toBe(fakeClient.clientSecret);
    expect(filesystem.existsSync).toHaveBeenCalledExactlyOnceWith(installedPath);
    expect(filesystem.readFileSync).toHaveBeenCalledExactlyOnceWith(installedPath, "utf8");
  });

  it("preserves stable-instance fallback discovery when only the second candidate exists", () => {
    filesystem.existsSync.mockImplementation((path) => String(path) === fallbackPath);
    const auth = getAuthConfig({ SPACE_INSTANCE: "stable" });
    expect(auth.googleClientId).toBe(fakeClient.clientId);
    expect(auth.googleClientSecret).toBe(fakeClient.clientSecret);
    expect(filesystem.existsSync.mock.calls.map(([path]) => path)).toEqual([installedPath, fallbackPath]);
    expect(filesystem.readFileSync).toHaveBeenCalledExactlyOnceWith(fallbackPath, "utf8");
  });

  it("retains explicit contributor client configuration without consulting installed files", () => {
    const auth = getAuthConfig({ SPACE_INSTANCE: "dev", SPACE_GOOGLE_CLIENT_ID: "test-explicit-client", SPACE_GOOGLE_CLIENT_SECRET: "test-explicit-secret" });
    expect(auth.googleClientId).toBe("test-explicit-client");
    expect(auth.googleClientSecret).toBe("test-explicit-secret");
    expect(filesystem.existsSync).not.toHaveBeenCalled();
    expect(filesystem.readFileSync).not.toHaveBeenCalled();
  });
});
