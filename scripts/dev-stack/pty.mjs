import { chmod, lstat, realpath } from "node:fs/promises";
import { join, sep } from "node:path";

/** node-pty's macOS prebuild can arrive without its helper's owner execute bit. */
export async function preparePtyHelper(root, platform = process.platform, arch = process.arch) {
  if (platform !== "darwin") return;
  for (const relative of [`node_modules/node-pty/prebuilds/darwin-${arch}/spawn-helper`, "node_modules/node-pty/build/Release/spawn-helper"]) {
    const path = join(root, relative);
    let stat;
    try { stat = await lstat(path); } catch (error) { if (error.code === "ENOENT") continue; throw error; }
    if (!stat.isFile() || stat.isSymbolicLink() || !(await realpath(path)).startsWith(root + sep) || stat.uid !== process.getuid()) throw new Error("Refusing to change a PTY helper outside the owned checkout.");
    if (!(stat.mode & 0o100)) await chmod(path, stat.mode | 0o100);
  }
}
