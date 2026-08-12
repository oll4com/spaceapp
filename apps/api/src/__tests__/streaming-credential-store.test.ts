import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { StreamingCredentialStore } from "../streaming-credential-store.js";

const roots: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), "space-streaming-secrets-"));
  roots.push(value);
  return value;
}

describe("StreamingCredentialStore", () => {
  it("fails closed when provider client files are absent or too permissive", async () => {
    const directory = await root();
    const store = new StreamingCredentialStore(directory);
    await store.initialize();
    expect(await store.readiness("YOUTUBE")).toMatchObject({ status: "UNCONFIGURED", clientFilePresent: false });
    await writeFile(store.clientPath("YOUTUBE"), JSON.stringify({
      clientId: "client",
      clientSecret: "secret",
      redirectUri: "https://space.example/callback"
    }), { mode: 0o644 });
    expect(await store.readiness("YOUTUBE")).toMatchObject({ status: "ERROR", code: "CLIENT_FILE_PERMISSIONS" });
  });

  it("atomically rotates opaque credential files with 0700/0600 permissions", async () => {
    const directory = await root();
    const store = new StreamingCredentialStore(directory);
    await store.writeCredential("streaming-credential:one", { accessToken: "first", refreshToken: "refresh" });
    await store.writeCredential("streaming-credential:one", { accessToken: "second", refreshToken: "refresh" });
    expect(await store.readCredential("streaming-credential:one")).toEqual({ accessToken: "second", refreshToken: "refresh" });
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
    expect((await stat(join(directory, "credentials"))).mode & 0o777).toBe(0o700);
    const files = (await import("node:fs/promises")).readdir(join(directory, "credentials"));
    const names = await files;
    expect(names).toHaveLength(1);
    expect((await stat(join(directory, "credentials", names[0]!))).mode & 0o777).toBe(0o600);
    expect(await readFile(join(directory, "credentials", names[0]!), "utf8")).not.toContain("streaming-credential:one");
  });
});
