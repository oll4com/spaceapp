// spawn and execFile for the API: a call that passes no env gets the API's environment without Space's own
// credentials (childProcessEnv). The 1.1.5 internal review (2026-10-16) found about 60 spawns that inherited
// SPACE_SESSION_SECRET and SPACE_DATABASE_URL because they set no env; a test keeps every API module on this file.
import * as childProcess from "node:child_process";
import { promisify } from "node:util";
import { childProcessEnv } from "./child-process-env.js";

// Node's call shapes: (command, args?, options?, callback?); options is the first plain object after the args.
function withSafeEnv(args: unknown[]): unknown[] {
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
