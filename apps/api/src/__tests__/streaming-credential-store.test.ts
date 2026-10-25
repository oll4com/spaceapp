import { chmod, mkdtemp, readdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
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
  it("reports a missing client file and tightens widened modes on files it owns, never through a symlink", async () => {
    const directory = await root();
    const store = new StreamingCredentialStore(directory);
    await store.initialize();
    expect(await store.readiness("YOUTUBE")).toMatchObject({ status: "UNCONFIGURED", clientFilePresent: false });
    const client = JSON.stringify({ clientId: "client", clientSecret: "secret", redirectUri: "https://space.example/callback" });
    await writeFile(store.clientPath("TWITCH"), client, { mode: 0o400 });
    expect(await store.readiness("TWITCH")).toMatchObject({ status: "READY" });
    expect((await stat(store.clientPath("TWITCH"))).mode & 0o777).toBe(0o400);
    // public-host drifted these files to 0620 (2026-10-09); the store heals them instead of failing every platform call.
    await writeFile(store.clientPath("YOUTUBE"), client);
    await chmod(store.clientPath("YOUTUBE"), 0o620);
    expect(await store.readiness("YOUTUBE")).toMatchObject({ status: "READY" });
    expect((await stat(store.clientPath("YOUTUBE"))).mode & 0o777).toBe(0o600);
    await store.writeCredential("streaming-credential:drift", { accessToken: "token" });
    const credentials = await readdir(join(directory, "credentials"));
    await chmod(join(directory, "credentials", credentials[0]!), 0o620);
    expect(await store.readCredential("streaming-credential:drift")).toEqual({ accessToken: "token" });
    // A symlink is followed for reading but never chmod-ed through.
    await writeFile(join(directory, "elsewhere.json"), client, { mode: 0o644 });
    await symlink(join(directory, "elsewhere.json"), store.clientPath("X"));
    expect(await store.readiness("X")).toMatchObject({ status: "ERROR", code: "CLIENT_FILE_PERMISSIONS" });
    expect((await stat(join(directory, "elsewhere.json"))).mode & 0o777).toBe(0o644);
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
