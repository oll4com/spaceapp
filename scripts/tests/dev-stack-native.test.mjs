import assert from "node:assert/strict";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import test from "node:test";
import { loadedPtyHelper, nativeHelperMode, prepareDevPtyDependency, prepareOwnedPtyHelper } from "../dev-stack-native.mjs";

const info = overrides => ({ file: true, symlink: false, nlink: 1, uid: 42, size: 128, mode: 0o644, ...overrides });
test("native permission plan adds only owner execute for the observed mode and is idempotent", () => {
  assert.equal(nativeHelperMode(info(), 42), 0o744);
  for (const mode of [0o744, 0o755, 0o700]) assert.equal(nativeHelperMode(info({ mode }), 42), mode);
});
test("unknown or unsafe helper identity and permissions are refused rather than broadened", () => {
  for (const change of [{ file: false }, { symlink: true }, { nlink: 2 }, { uid: 99 },
    { size: 0 }, { size: 9 * 1024 * 1024 }, { mode: 0o4644 }, { mode: 0o2644 },
    { mode: 0o1644 }, { mode: 0o666 }, { mode: 0o775 }, { mode: 0o640 }, { mode: 0o444 }]) {
    assert.throws(() => nativeHelperMode(info(change), 42), /DEV_STACK_NATIVE_HELPER/);
  }
});
test("only one actually loaded package binding selects its adjacent helper", () => {
  const root = resolve("owned", "node_modules", "node-pty");
  for (const dir of [join("prebuilds", "darwin-x64"), join("build", "Release"), join("build", "Debug")]) {
    assert.equal(loadedPtyHelper(root, [join(root, dir, "pty.node"), join(root, "lib", "index.js")]), join(root, dir, "spawn-helper"));
  }
  for (const paths of [[], [root + "-other" + sep + "pty.node"], [join(root,"a.node"),join(root,"b.node")]]) {
    assert.throws(() => loadedPtyHelper(root, paths), /DEV_STACK_NATIVE_HELPER/);
  }
});
test("Linux is a strict no-op, while Windows and unknown platforms are refused", () => {
  assert.deepEqual(prepareDevPtyDependency("not-a-real-checkout", { platform: "linux" }), { mode: "NOT_REQUIRED", platform: "linux" });
  for (const platform of ["win32", "freebsd"]) assert.throws(() => prepareDevPtyDependency("not-a-real-checkout", { platform }), /DEV_STACK_NATIVE_HELPER/);
});
test("Darwin refuses missing locked package rather than installing or guessing", () => {
  assert.throws(() => prepareDevPtyDependency("not-a-real-checkout", { platform: "darwin" }), /DEV_STACK_NATIVE_HELPER/);
});
test("Darwin refuses a changed package pin before native loading", () => {
  const root = fs.mkdtempSync(join(tmpdir(), "dev-pty-lock-"));
  try {
    fs.writeFileSync(join(root, "package-lock.json"), JSON.stringify({ packages: { "node_modules/node-pty": { version: "1.2.0" } } }), { flag: "wx" });
    assert.throws(() => prepareDevPtyDependency(root, { platform: "darwin" }), /DEV_STACK_NATIVE_HELPER/);
    assert.deepEqual(fs.readdirSync(root), ["package-lock.json"]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

const posixOnly = { skip: process.platform === "win32" ? "POSIX mode/UID semantics required" : false };
function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "dev-pty-")));
  const helper = join(root, "spawn-helper");
  fs.writeFileSync(helper, "#!/bin/sh\nexit 0\n", { flag: "wx", mode: 0o644 });
  fs.chmodSync(helper, 0o644);
  return { root, helper };
}
test("owned synthetic POSIX helper changes one bit, preserves bytes/inode and is idempotent", posixOnly, () => {
  const { root, helper } = fixture();
  try {
    const before = fs.statSync(helper), bytes = fs.readFileSync(helper);
    const receipt = prepareOwnedPtyHelper(root, helper);
    assert.equal(receipt.changed, true); assert.equal(receipt.beforeMode, "644"); assert.equal(receipt.afterMode, "744");
    assert.equal(fs.statSync(helper).mode & 0o7777, 0o744); assert.equal(fs.statSync(helper).ino, before.ino);
    assert.deepEqual(fs.readFileSync(helper), bytes); fs.accessSync(helper, fs.constants.X_OK);
    assert.equal(prepareOwnedPtyHelper(root, helper).changed, false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test("outside, symlinked and hardlinked synthetic helpers cannot be prepared", posixOnly, () => {
  const a = fixture(), b = fixture();
  try {
    assert.throws(() => prepareOwnedPtyHelper(a.root, b.helper), /DEV_STACK_NATIVE_HELPER/);
    fs.unlinkSync(a.helper); fs.symlinkSync(b.helper, a.helper);
    assert.throws(() => prepareOwnedPtyHelper(a.root, a.helper), /DEV_STACK_NATIVE_HELPER/);
    assert.equal(fs.statSync(b.helper).mode & 0o7777, 0o644);
    fs.unlinkSync(a.helper); fs.linkSync(b.helper, a.helper);
    assert.throws(() => prepareOwnedPtyHelper(a.root, a.helper), /DEV_STACK_NATIVE_HELPER/);
    assert.equal(fs.statSync(b.helper).mode & 0o7777, 0o644);
  } finally { fs.rmSync(a.root,{recursive:true,force:true}); fs.rmSync(b.root,{recursive:true,force:true}); }
});
test("a failed postcondition restores the original fixture mode and propagates failure", posixOnly, t => {
  const { root, helper } = fixture();
  const actual = fs.fchmodSync;
  let calls = 0, changed = false, descriptor;
  const bytes = fs.readFileSync(helper);
  const mocked = t.mock.method(fs, "fchmodSync", (fd, mode) => {
    calls++; descriptor = fd; actual(fd, mode);
    if (calls === 1) {
      assert.equal(fs.fstatSync(fd).mode & 0o7777, 0o744); changed = true;
      throw new Error("Synthetic failure after the actual owner-execute transition.");
    }
  });
  try {
    assert.throws(() => prepareOwnedPtyHelper(root, helper), /DEV_STACK_NATIVE_HELPER/);
    assert.equal(calls, 2); assert.equal(changed, true);
    assert.equal(fs.statSync(helper).mode & 0o7777, 0o644);
    assert.deepEqual(fs.readFileSync(helper), bytes);
    assert.throws(() => fs.fstatSync(descriptor), { code: "EBADF" });
  } finally { mocked.mock.restore(); fs.rmSync(root,{recursive:true,force:true}); }
});
test("runner prepares only up/rebuild under the lifecycle lease and before stopping a healthy stack", () => {
  const source = fs.readFileSync(new URL("../dev-stack.mjs", import.meta.url), "utf8");
  const main = source.slice(source.indexOf("export async function main"));
  assert.equal([...main.matchAll(/prepareDevPtyDependency\((?:state\.)?repoRoot\)/g)].length, 2);
  assert.match(main, /withLifecycleAdmission[\s\S]*action === "up"[\s\S]*readState[\s\S]*prepareDevPtyDependency\(repoRoot\)[\s\S]*up\(initState/);
  assert.match(main, /readState[\s\S]*action === "rebuild"[\s\S]*prepareDevPtyDependency[\s\S]*stopState\(state, false, \{ signal \}\)[\s\S]*checkCancelled\(\)[\s\S]*up\(state, releaseAdmission, handoffToUp\)/);
  const lifecycle = fs.readFileSync(new URL("../dev-stack-lifecycle.mjs", import.meta.url), "utf8");
  const admission = lifecycle.slice(lifecycle.indexOf("export async function withLifecycleAdmission"));
  assert.match(admission, /scope = cancellationScope\(events\)[\s\S]*lease = acquire\(repoRoot\)[\s\S]*result = await work/);
});
