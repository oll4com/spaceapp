import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { assertOnlyLockAdded, embedImageLock, imagetoolsDigest, resolveImageDigests } from "../embed-image-lock.mjs";

const execFileAsync = promisify(execFile);
const digest = (char) => `sha256:${char.repeat(64)}`;
const registry = { core: digest("a"), cli: digest("b"), browser: digest("c") };
const fakeInspect = async (ref) => registry[ref.match(/spaceapp-(core|cli|browser):/)[1]];

async function candidate(t, { runtimeVersion = "9.9.9", lock = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-embed-lock-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const pkg = join(root, "run-spaceapp");
  await mkdir(join(pkg, "templates"), { recursive: true });
  await mkdir(join(pkg, "src"));
  await writeFile(join(pkg, "package.json"), JSON.stringify({
    name: "run-spaceapp", version: "9.9.9", spaceappRuntimeVersion: runtimeVersion, gitHead: "f".repeat(40),
    files: ["src/", "templates/"]
  }, null, 2));
  await writeFile(join(pkg, "src", "index.mjs"), "export const launcher = true;\n");
  await writeFile(join(pkg, "templates", "compose.yml"), "services: {}\n");
  if (lock) await writeFile(join(pkg, "templates", "images.lock.json"), "{}\n");
  const { stdout } = await execFileAsync("npm", ["pack", pkg, "--pack-destination", root, "--json"]);
  return { root, tarball: join(root, JSON.parse(stdout)[0].filename) };
}

test("the registry's index digest is read for each SpaceApp image of the runtime version", async () => {
  const asked = [];
  const lock = await resolveImageDigests("1.1.7", async (ref) => { asked.push(ref); return fakeInspect(ref); });
  assert.deepEqual(asked, ["ghcr.io/oll4com/spaceapp-core:1.1.7", "ghcr.io/oll4com/spaceapp-cli:1.1.7", "ghcr.io/oll4com/spaceapp-browser:1.1.7"]);
  assert.deepEqual(lock, { schemaVersion: 1, runtimeVersion: "1.1.7", images: registry });
  await assert.rejects(() => resolveImageDigests("1.1.7", async () => "sha256:short"), /images\.lock\.json/);
  const run = async (command, args) => {
    assert.deepEqual([command, ...args.slice(0, 4), args.at(-1)], ["docker", "buildx", "imagetools", "inspect", "ghcr.io/oll4com/spaceapp-core:1.1.7", "{{json .Manifest}}"]);
    return { stdout: JSON.stringify({ mediaType: "application/vnd.oci.image.index.v1+json", digest: digest("d"), size: 1 }) };
  };
  assert.equal(await imagetoolsDigest("ghcr.io/oll4com/spaceapp-core:1.1.7", run), digest("d"));
});

test("the pinned package is the tested candidate plus the lock, nothing else", async (t) => {
  const { root, tarball } = await candidate(t);
  const result = await embedImageLock({ tarball, runtimeVersion: "9.9.9", outDir: join(root, "pinned"), inspect: fakeInspect });
  assert.equal(result.tarball, join(root, "pinned", "run-spaceapp-9.9.9.tgz"));
  const check = join(root, "check");
  await mkdir(check);
  await execFileAsync("tar", ["-xzf", result.tarball, "-C", check]);
  assert.deepEqual(JSON.parse(await readFile(join(check, "package", "templates", "images.lock.json"), "utf8")),
    { schemaVersion: 1, runtimeVersion: "9.9.9", images: registry });
  assert.equal(await readFile(join(check, "package", "src", "index.mjs"), "utf8"), "export const launcher = true;\n");
  assert.equal(JSON.parse(await readFile(join(check, "package", "package.json"), "utf8")).gitHead, "f".repeat(40));
});

test("a candidate for another runtime, or one that already carries a lock, is refused", async (t) => {
  const other = await candidate(t, { runtimeVersion: "9.9.8" });
  await assert.rejects(() => embedImageLock({ tarball: other.tarball, runtimeVersion: "9.9.9", outDir: join(other.root, "out"), inspect: fakeInspect }), /not runtime 9\.9\.9/);
  const locked = await candidate(t, { lock: true });
  await assert.rejects(() => embedImageLock({ tarball: locked.tarball, runtimeVersion: "9.9.9", outDir: join(locked.root, "out"), inspect: fakeInspect }), /already carries/);
});

test("any other difference from the tested candidate stops the release", () => {
  const tested = new Map([["package.json", "1"], ["src/index.mjs", "2"]]);
  assert.doesNotThrow(() => assertOnlyLockAdded(tested, new Map([...tested, ["templates/images.lock.json", "L"]]), "L"));
  assert.throws(() => assertOnlyLockAdded(tested, new Map([["package.json", "1"], ["src/index.mjs", "X"], ["templates/images.lock.json", "L"]]), "L"), /changed or missing: src\/index\.mjs/);
  assert.throws(() => assertOnlyLockAdded(tested, new Map([...tested, ["templates/images.lock.json", "L"], ["extra.js", "E"]]), "L"), /unexpected: extra\.js/);
  assert.throws(() => assertOnlyLockAdded(tested, tested, "L"), /images\.lock\.json is missing/);
});
