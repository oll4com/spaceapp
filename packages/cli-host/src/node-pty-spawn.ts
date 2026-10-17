import { createRequire } from "node:module";
import type { CliHostSpawn } from "./types.js";

const require = createRequire(import.meta.url);
let cachedSpawn: typeof import("node-pty").spawn | null = null;

function resolveNodePtySpawn(): typeof import("node-pty").spawn {
  if (!cachedSpawn) {
    const nodePty = require("node-pty") as typeof import("node-pty");
    cachedSpawn = nodePty.spawn;
  }
  return cachedSpawn;
}

/**
 * Disable the PTY interrupt characters (ISIG) for every CLI pane so that
 * Ctrl-C is delivered to the CLI as the byte 0x03 (its own interrupt/cancel
 * key) instead of SIGINT. Without this, an accidental Ctrl-C kills the whole
 * CLI tree and the pane exits. Admin-initiated termination (SIGTERM/SIGHUP)
 * and app-level exits (Ctrl-D, /exit) are unaffected.
 */
export const spawnNodePty: CliHostSpawn = (spec) =>
  resolveNodePtySpawn()("/bin/sh", ["-c", '/usr/bin/stty -isig; exec "$@"', "space-cli-host", spec.command, ...spec.args], {
    name: "xterm-256color",
    cols: spec.cols,
    rows: spec.rows,
    cwd: spec.cwd,
    env: spec.env
  });
