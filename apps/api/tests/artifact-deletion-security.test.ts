import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { InMemorySpaceStore } from "@space/runtime";
import { createApp, sweepExpiredBrowserArtifacts } from "../src/app.js";
import { getApiConfig } from "../src/config.js";
import { createCsrfToken, signSession } from "../src/auth.js";

let root: string;
let outside: string;
let store: InMemorySpaceStore;
const secret = "artifact-delete-fixture";
const session = signSession({ id: "user:delete-fixture", role: "ADMIN", email: "delete@space.local" }, secret);
const headers = { cookie: `space_session=${session}`, "x-space-csrf-token": createCsrfToken(session, secret)! };
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "artifact-delete-"));
  outside = await mkdtemp(join(tmpdir(), "artifact-outside-"));
  store = new InMemorySpaceStore();
  store.upsertUser({ id: "user:delete-fixture", role: "ADMIN", email: "delete@space.local" });
  await writeFile(join(outside, "sentinel.txt"), "outside sentinel");
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

function artifact(expired = false) {
  return store.createArtifact({ roomId: null, kind: "SCREENSHOT", mimeType: "image/png",
    storageUri: "space-artifact://browser-evidence/fixture/sentinel.txt", sha256: "a".repeat(64),
    byteSize: 16, metadata: {}, expiresAt: expired ? "2026-01-01T00:00:00.000Z" : null }).artifact;
}

it("rejects artifact deletion through a symlinked ancestor without deleting its record or outside bytes", async () => {
  await mkdir(join(root, "browser-evidence"));
  await symlink(outside, join(root, "browser-evidence", "fixture"));
  const file = artifact();
  const app = await createApp({ store, config: getApiConfig({ SPACE_ARTIFACT_ROOT: root, SPACE_LOG_LEVEL: "silent" }),
    auth: { sessionSecret: secret, devLogin: false, secureCookies: false } });
  try {
    const response = await app.inject({ method: "DELETE", url: `/api/artifacts/${encodeURIComponent(file.id)}`, headers });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe("PATH_UNSAFE");
    expect(store.getArtifact(file.id).deletedAt).toBeNull();
    expect(await readFile(join(outside, "sentinel.txt"), "utf8")).toBe("outside sentinel");
  } finally { await app.close(); }
});

it("reports unsafe expired-file cleanup without unlinking outside the artifact root", async () => {
  await mkdir(join(root, "browser-evidence"));
  await symlink(outside, join(root, "browser-evidence", "fixture"));
  const file = artifact(true);
  const result = await sweepExpiredBrowserArtifacts({ store, artifactRoot: root, at: "2026-10-03T00:00:00.000Z" });
  expect(result).toMatchObject({ softDeleted: 1, filesRemoved: 0, fileErrors: [{ artifactId: file.id }] });
  expect(await readFile(join(outside, "sentinel.txt"), "utf8")).toBe("outside sentinel");
});

it.each([false, true])("keeps missing-file deletion idempotent (existing parent: %s)", async parentExists => {
  if (parentExists) await mkdir(join(root, "browser-evidence", "fixture"), { recursive: true });
  const file = artifact();
  const app = await createApp({ store, config: getApiConfig({ SPACE_ARTIFACT_ROOT: root, SPACE_LOG_LEVEL: "silent" }),
    auth: { sessionSecret: secret, devLogin: false, secureCookies: false } });
  try {
    const response = await app.inject({ method: "DELETE", url: `/api/artifacts/${encodeURIComponent(file.id)}`, headers });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, artifactId: file.id });
    expect(store.listArtifacts().some(item => item.id === file.id)).toBe(false);
  } finally { await app.close(); }
});
