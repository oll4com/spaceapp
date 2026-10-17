/** Development checkout prerequisite only. No provider, spawn or recursive chmod. */
import fs from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { basename, dirname, join, sep } from "node:path";

function requireCondition(condition) {
  if (!condition) throw new Error("DEV_STACK_NATIVE_HELPER: unexpected dependency identity, ownership or permissions; reinstall the locked dependencies in an owned checkout.");
}

export function nativeHelperMode(info, uid) {
  requireCondition(info.file && !info.symlink && info.nlink === 1 && info.uid === uid &&
    Number.isSafeInteger(info.size) && info.size > 0 && info.size <= 8 * 1024 * 1024 &&
    Number.isInteger(info.mode) && info.mode >= 0 && info.mode <= 0o7777 &&
    (info.mode & 0o7022) === 0 && (info.mode & 0o600) === 0o600);
  if (info.mode & 0o100) return info.mode;
  requireCondition(info.mode === 0o644);
  return info.mode | 0o100;
}

export function loadedPtyHelper(packageRoot, cachePaths) {
  const bindings = cachePaths.filter(file => file.startsWith(packageRoot + sep) && file.endsWith(".node"));
  requireCondition(bindings.length === 1);
  return join(dirname(bindings[0]), "spawn-helper");
}

/** This file primitive is also exercised on owned synthetic POSIX fixtures. */
export function prepareOwnedPtyHelper(packageRoot, helper) {
  requireCondition(typeof process.getuid === "function" && fs.constants.O_NOFOLLOW !== undefined);
  requireCondition(fs.realpathSync(packageRoot) === packageRoot && helper.startsWith(packageRoot + sep) &&
    basename(helper) === "spawn-helper" && fs.realpathSync(helper) === helper);
  const fd = fs.openSync(helper, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  let attempted = false;
  let originalMode;
  let verifyRestoration;
  try {
    const original = fs.fstatSync(fd);
    const snapshot = stat => ({ file: stat.isFile(), symlink: stat.isSymbolicLink(),
      nlink: stat.nlink, uid: stat.uid, size: stat.size, mode: stat.mode & 0o7777 });
    originalMode = original.mode & 0o7777;
    const targetMode = nativeHelperMode(snapshot(original), process.getuid());
    const executable = () => {
      try { fs.accessSync(helper, fs.constants.X_OK); return true; }
      catch (error) { if (error.code !== "EACCES") throw error; return false; }
    };
    const digest = () => {
      const named = fs.lstatSync(helper), current = fs.fstatSync(fd);
      requireCondition(named.isFile() && !named.isSymbolicLink() && named.dev === original.dev &&
        named.ino === original.ino && current.size === original.size);
      nativeHelperMode(snapshot(named), process.getuid());
      nativeHelperMode(snapshot(current), process.getuid());
      const bytes = Buffer.alloc(original.size);
      let offset = 0;
      while (offset < bytes.length) {
        const read = fs.readSync(fd, bytes, offset, bytes.length - offset, offset);
        requireCondition(read > 0); offset += read;
      }
      return createHash("sha256").update(bytes).digest("hex");
    };
    const beforeHash = digest();
    requireCondition(executable() === Boolean(originalMode & 0o100));
    verifyRestoration = () => requireCondition((fs.fstatSync(fd).mode & 0o7777) === originalMode &&
      digest() === beforeHash && executable() === Boolean(originalMode & 0o100));
    if (targetMode !== originalMode) {
      attempted = true;
      fs.fchmodSync(fd, targetMode);
    }
    requireCondition((fs.fstatSync(fd).mode & 0o7777) === targetMode && executable() && digest() === beforeHash);
    return { changed: attempted, beforeMode: originalMode.toString(8), afterMode: targetMode.toString(8),
      helperSha256: beforeHash, helperBytesUnchanged: true };
  } catch {
    if (attempted) {
      try { fs.fchmodSync(fd, originalMode); verifyRestoration(); }
      catch { throw new Error("DEV_STACK_NATIVE_RESTORE_REQUIRED: owned dependency permission preparation failed; inspect before retrying."); }
    }
    throw new Error("DEV_STACK_NATIVE_HELPER: permission prerequisite could not be verified; no service was started.");
  } finally { fs.closeSync(fd); }
}

export function prepareDevPtyDependency(repoRoot, { platform = process.platform } = {}) {
  if (platform === "linux") return { mode: "NOT_REQUIRED", platform };
  requireCondition(platform === "darwin");
  try {
    const root = fs.realpathSync(repoRoot);
    const lock = JSON.parse(fs.readFileSync(join(root, "package-lock.json"), "utf8"));
    requireCondition(lock.packages?.["node_modules/node-pty"]?.version === "1.1.0");
    const require = createRequire(join(root, "packages", "cli-host", "package.json"));
    const packageRoot = dirname(require.resolve("node-pty/package.json"));
    requireCondition(packageRoot === join(root, "node_modules", "node-pty") && fs.realpathSync(packageRoot) === packageRoot);
    requireCondition(require("node-pty/package.json").version === "1.1.0");
    require("node-pty"); // Observe the actual loaded binding; do not spawn a PTY here.
    const helper = loadedPtyHelper(packageRoot, Object.keys(require.cache));
    const receipt = prepareOwnedPtyHelper(packageRoot, helper);
    return { mode: "DEV_PTY_HELPER_PREPARED", platform, version: "1.1.0", ...receipt };
  } catch (error) {
    if (error.message.startsWith("DEV_STACK_NATIVE_")) throw error;
    throw new Error("DEV_STACK_NATIVE_HELPER: install the locked native dependency in this owned checkout before starting services.");
  }
}
