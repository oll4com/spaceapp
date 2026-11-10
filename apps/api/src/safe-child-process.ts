// spawn and execFile for the API: a call that passes no env gets the API's environment without Space's own
// credentials (childProcessEnv). The 1.1.5 internal review (2026-10-16) found about 60 spawns that inherited
// SPACE_SESSION_SECRET and SPACE_DATABASE_URL because they set no env; a test keeps every API module on this file.
import * as childProcess from "node:child_process";
import { promisify } from "node:util";
import { childProcessEnv } from "./child-process-env.js";

/**
 * What a spawn runs, through the git umask (`sh -c … "$@"`) and sudo wrappers: the program's file name and its first two
 * plain words (no ids, paths, hashes or values), e.g. "git merge-base dev", "gemini-vscode-parity native-turns".
 */
export function spawnLabel(command: string, args: readonly string[]): string {
  let argv = [command, ...args];
  const name = () => argv[0]!.split("/").at(-1)!;
  if (name() === "sh" && argv[1] === "-c" && argv.length > 3) argv = argv.slice(3);
  const program = name() === "sudo" ? argv.findIndex((arg, index) => index > 0 && arg.includes("/")) : 0;
  if (program > 0) argv = argv.slice(program);
  return [name(), ...argv.slice(1).filter((arg) => /^[a-z][a-z-]*$/.test(arg)).slice(0, 2)].join(" ");
}

// API audit 4/11: forks held ~30 % of stable's main thread (each copies the 1-2 GB process) and nothing named the programs.
const spawned = new Map<string, number>();

/** Spawns per program (`spawnLabel`) since the previous call; `event_loop.load` logs them, the daily API audit reads them. */
export function takeSpawnCounts(): Record<string, number> {
  const counts = Object.fromEntries([...spawned].sort((a, b) => b[1] - a[1]));
  spawned.clear();
  return counts;
}

// Node's call shapes: (command, args?, options?, callback?); options is the first plain object after the args.
function withSafeEnv(args: unknown[]): unknown[] {
  const label = spawnLabel(String(args[0]), Array.isArray(args[1]) ? args[1].map(String) : []);
  spawned.set(label, (spawned.get(label) ?? 0) + 1);
  const out = [...args];
  const index = Array.isArray(out[1]) ? 2 : 1;
  const options = out[index];
  if (options !== null && typeof options === "object") {
    const given = options as { env?: NodeJS.ProcessEnv };
    if (given.env === undefined) out[index] = { ...given, env: childProcessEnv() };
  } else if (options === undefined && index === out.length) {
    out.push({ env: childProcessEnv() });
  } else {
    out.splice(index, 0, { env: childProcessEnv() });
  }
  return out;
}

export const spawn = ((...args: unknown[]) =>
  (childProcess.spawn as (...a: unknown[]) => childProcess.ChildProcess)(...withSafeEnv(args))) as typeof childProcess.spawn;

export const execFile = ((...args: unknown[]) =>
  (childProcess.execFile as (...a: unknown[]) => childProcess.ChildProcess)(...withSafeEnv(args))) as typeof childProcess.execFile;

// promisify(execFile) must keep resolving to { stdout, stderr } like Node's own execFile.
Object.defineProperty(execFile, promisify.custom, {
  value: (...args: unknown[]) => (promisify(childProcess.execFile) as (...a: unknown[]) => Promise<unknown>)(...withSafeEnv(args))
});
