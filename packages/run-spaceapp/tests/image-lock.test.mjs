import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { imageDigestEnv, localImageRefs, PACKAGE_IMAGE_LOCK, parseImageLock, readImageLock } from "../src/image-lock.mjs";
import { createDefaultConfig, renderRuntimeEnv } from "../src/index.mjs";

const digest = (char) => `sha256:${char.repeat(64)}`;
const lock = { schemaVersion: 1, runtimeVersion: "1.1.7", images: { core: digest("a"), cli: digest("b"), browser: digest("c") } };

test("a source checkout carries no image lock and keeps pulling by tag", () => {
  assert.equal(PACKAGE_IMAGE_LOCK, null);
  assert.deepEqual(imageDigestEnv("1.1.7"), ["SPACEAPP_CORE_IMAGE_DIGEST=", "SPACEAPP_CLI_IMAGE_DIGEST=", "SPACEAPP_BROWSER_IMAGE_DIGEST="]);
});

test("a lock pins the digests of its own runtime version only", () => {
  assert.deepEqual(imageDigestEnv("1.1.7", lock), [
    `SPACEAPP_CORE_IMAGE_DIGEST=@${digest("a")}`,
    `SPACEAPP_CLI_IMAGE_DIGEST=@${digest("b")}`,
    `SPACEAPP_BROWSER_IMAGE_DIGEST=@${digest("c")}`
  ]);
  // A rollback to another runtime version has no digests in this package: it pulls by tag.
  assert.deepEqual(imageDigestEnv("1.1.6", lock), ["SPACEAPP_CORE_IMAGE_DIGEST=", "SPACEAPP_CLI_IMAGE_DIGEST=", "SPACEAPP_BROWSER_IMAGE_DIGEST="]);
  const env = renderRuntimeEnv(createDefaultConfig({ version: "1.1.7" }), lock);
  assert.match(env, /^SPACEAPP_IMAGE_TAG=1\.1\.7\nSPACEAPP_CORE_IMAGE_DIGEST=@sha256:a{64}\n/m);
});

test("an invalid lock is refused instead of falling back to tags", async () => {
  for (const bad of [
    { ...lock, schemaVersion: 2 },
    { ...lock, runtimeVersion: "latest" },
    { ...lock, images: { core: digest("a"), cli: digest("b") } },
    { ...lock, images: { ...lock.images, browser: "sha256:short" } },
    { ...lock, images: { ...lock.images, extra: digest("d") } }
  ]) assert.throws(() => parseImageLock(JSON.stringify(bad)), /images\.lock\.json/);
  const dir = await mkdtemp(join(tmpdir(), "spaceapp-image-lock-"));
  assert.equal(readImageLock(join(dir, "missing.json")), null);
  await writeFile(join(dir, "images.lock.json"), "{not json");
  assert.throws(() => readImageLock(join(dir, "images.lock.json")), /invalid image lock/);
  await writeFile(join(dir, "images.lock.json"), JSON.stringify(lock));
  assert.deepEqual(readImageLock(join(dir, "images.lock.json")), lock);
});

test("pinned images are looked up by digest first, since a digest pull leaves no local tag", () => {
  assert.deepEqual(localImageRefs("core", "1.1.7", digest("a")), [`ghcr.io/oll4com/spaceapp-core@${digest("a")}`, "ghcr.io/oll4com/spaceapp-core:1.1.7"]);
  assert.deepEqual(localImageRefs("cli", "1.1.7", null), ["ghcr.io/oll4com/spaceapp-cli:1.1.7"]);
});
