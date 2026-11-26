import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Unix socket paths hold about 104-108 bytes (sun_path), so a deep CI TMPDIR cannot hold a test's socket: such dirs go under /tmp instead. */
export function shortTmpRoot(base = tmpdir()): string {
  return process.platform === "win32" || base.length <= 40 ? base : "/tmp";
}

/** mkdtemp under a short root: for dirs that hold Unix sockets (pane host, Chrome's singleton socket via TMPDIR). */
export const mkdtempShort = (prefix: string) => mkdtemp(join(shortTmpRoot(), prefix));
