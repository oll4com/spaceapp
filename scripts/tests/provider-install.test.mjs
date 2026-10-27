import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CURSOR_ARCHIVE_SHA256, installProvider, providers, vendorManifest, verifyCursorArchive } from "../../deploy/docker/provider-install.mjs";

// npm 11 warns about install scripts that package.json allowScripts does not cover and is moving to blocking them
// (1.1.6 rehearsal: an allow-scripts warning on Claude Code's first install). Claude Code's postinstall puts its native
// binary in place, so only it is approved, for exactly its pinned version.
test("only Claude Code's pinned install script is approved", () => {
  assert.equal(providers.claude.allowScripts, true);
  assert.match(providers.claude.package, /^@anthropic-ai\/claude-code@\d+\.\d+\.\d+$/);
  for (const [name, entry] of Object.entries(providers)) if (name !== "claude") assert.equal(entry.allowScripts, undefined, name);
});

test("each npm provider installs from a lockfile resolved from its pinned vendor project (review INT5-C-F14)", async () => {
  assert.deepEqual(vendorManifest(providers.claude), { private: true, dependencies: { "@anthropic-ai/claude-code": "2.1.301" }, allowScripts: { "@anthropic-ai/claude-code@2.1.301": true } });
  assert.deepEqual(vendorManifest(providers.codex), { private: true, dependencies: { "@openai/codex": "0.145.0" } });
  for (const [name, entry] of Object.entries(providers)) {
    if (!entry.package) continue;
    // A changed pin needs node scripts/update-provider-locks.mjs.
    const lock = JSON.parse(await readFile(new URL(`../../deploy/docker/provider-locks/${name}.json`, import.meta.url), "utf8"));
    const [packageName, version] = Object.entries(vendorManifest(entry).dependencies)[0];
    assert.equal(lock.lockfileVersion, 3, name);
    assert.deepEqual(lock.packages[""].dependencies, { [packageName]: version }, name);
    assert.equal(lock.packages[`node_modules/${packageName}`].version, version, name);
    for (const [path, item] of Object.entries(lock.packages)) {
      if (!path || item.link) continue;
      assert.match(item.resolved, /^https:\/\/registry\.npmjs\.org\//, `${name} ${path}`);
      assert.match(item.integrity, /^sha512-/, `${name} ${path}`);
    }
  }
  const installer = await readFile(new URL("../../deploy/docker/provider-install.mjs", import.meta.url), "utf8");
  assert.match(installer, /execute\('npm',\['ci','--prefix',directory,'--no-audit','--no-fund'\]\)/);
  assert.doesNotMatch(installer, /'npm',\['install'/);
});

test("the Cursor agent archive is pinned by checksum and refused with other bytes before it is unpacked (review INT5-C-F14)", async () => {
  for (const arch of ["x64", "arm64"]) assert.match(CURSOR_ARCHIVE_SHA256[arch], /^[0-9a-f]{64}$/);
  assert.equal(providers.cursor.archive, true);
  assert.throws(() => verifyCursorArchive(Buffer.from("not the cursor agent"), "x64"), /pinned checksum/);
  assert.throws(() => verifyCursorArchive(Buffer.from("not the cursor agent"), "riscv64"), /pinned checksum/);
  if (!["x64", "arm64"].includes(process.arch)) return;
  const root = await mkdtemp(join(tmpdir(), "provider-install-cursor-"));
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("tampered archive");
  try {
    await assert.rejects(installProvider("cursor", root), /pinned checksum/);
    assert.deepEqual((await readdir(join(root, "cursor"))).filter((name) => name !== ".install-lock"), []);
  } finally {
    globalThis.fetch = realFetch;
    await rm(root, { recursive: true, force: true });
  }
});
