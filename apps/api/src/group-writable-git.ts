import { spawn } from "./safe-child-process.js";
import type { ChildProcessWithoutNullStreams } from "node:child_process";

/** Exit status the umask wrapper reports when the git binary is missing. */
export const GIT_NOT_FOUND_EXIT_CODE = 127;

/**
 * Spawns git with umask 002. The API runs as the service user while pane CLIs
 * run as another member of its group; a umask 022 checkout would leave them
 * unable to edit files or update the index. The wrapper script is fixed and git
 * arguments stay positional, so nothing caller-supplied is shell-interpreted.
 * Off Windows the child leads its own process group so timeouts can kill hooks.
 */
export function spawnGroupWritableGit(args: string[], env: NodeJS.ProcessEnv): ChildProcessWithoutNullStreams {
  if (process.platform === "win32") return spawn("git", args, { env });
  return spawn("/bin/sh", ["-c", 'umask 002 && exec git "$@"', "git", ...args], { env, detached: true });
}
