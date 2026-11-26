// spawn and execFile for the API: a call that passes no env gets the API's environment without Space's own
// credentials (childProcessEnv). The 1.1.5 internal review (2026-10-16) found about 60 spawns that inherited
// SPACE_SESSION_SECRET and SPACE_DATABASE_URL because they set no env; a test keeps every API module on this file.
import * as childProcess from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
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

/**
 * Spawns per program (`spawnLabel`) since the previous call; `event_loop.load` logs them, the daily API audit reads them.
 * A "helper …" label ran in the exec helper: no fork of this process.
 */
export function takeSpawnCounts(): Record<string, number> {
  const counts = Object.fromEntries([...spawned].sort((a, b) => b[1] - a[1]));
  spawned.clear();
  return counts;
}

const countSpawn = (label: string) => spawned.set(label, (spawned.get(label) ?? 0) + 1);

// Node's call shapes: (command, args?, options?, callback?); options is the first plain object after the args.
function withSafeEnv(args: unknown[], count = true): unknown[] {
  if (count) countSpawn(spawnLabel(String(args[0]), Array.isArray(args[1]) ? args[1].map(String) : []));
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

// Exec helper (speed audit 14/11): a fork copies the caller's page tables, 77-170 ms of blocked event loop per command at the
// API's ~1 GB against 1.5 ms in a small process. Buffered commands (promisified execFile, execGit) run in
// scripts/space-exec-helper.mjs, started once at boot; a call it cannot take (no helper, an AbortSignal, an option that does
// not serialize) runs here as before.
const execHelperPath = fileURLToPath(new URL("../../../scripts/space-exec-helper.mjs", import.meta.url));
export type ExecHelperReply = {
  error: ({ message: string; code?: string | number | null } & Record<string, unknown>) | null;
  stdout: string | Buffer;
  stderr: string | Buffer;
  timedOut: boolean;
};
let execHelper: childProcess.ChildProcess | null = null;
let execHelperCalls = 0;
const execHelperWaiting = new Map<number, (reply: ExecHelperReply) => void>();

/** Starts the exec helper and returns its pid; the API calls it at boot, while its own process is still small to fork. */
export function startExecHelper(): number | undefined {
  if (execHelper || !existsSync(execHelperPath)) return execHelper?.pid;
  const helper = childProcess.fork(execHelperPath, [], { serialization: "advanced", env: childProcessEnv() });
  execHelper = helper;
  // Never the reason this process stays alive.
  helper.unref();
  helper.channel?.unref();
  helper.on("error", () => undefined);
  helper.on("message", (reply: ExecHelperReply & { id: number }) => {
    execHelperWaiting.get(reply.id)?.(reply);
    execHelperWaiting.delete(reply.id);
  });
  helper.once("exit", () => {
    if (execHelper !== helper) return;
    execHelper = null;
    // Its commands may have run in part: they fail like a killed child, never run twice.
    for (const answer of execHelperWaiting.values()) {
      answer({ error: { message: "The exec helper exited.", code: "EXEC_HELPER_EXITED" }, stdout: "", stderr: "", timedOut: false });
    }
    execHelperWaiting.clear();
    setTimeout(startExecHelper, 5_000).unref();
  });
  return helper.pid;
}

/** Stops the exec helper (tests); later commands run in this process. */
export function stopExecHelper(): void {
  const helper = execHelper;
  execHelper = null;
  helper?.kill();
}

/**
 * Runs a buffered command in the exec helper with Node's execFile options. With `groupTimeoutMs` the command leads its own
 * process group, which the timeout kills whole (utf8 output, no size limit, spawn's options). Null when the call has to run
 * in this process.
 */
export function execInHelper(file: string, args: readonly string[], options: Record<string, unknown>, groupTimeoutMs = 0): Promise<ExecHelperReply> | null {
  const helper = execHelper;
  if (!helper?.connected || options.signal) return null;
  const id = (execHelperCalls += 1);
  try {
    helper.send({ id, file, args, options, groupTimeoutMs });
  } catch {
    return null;
  }
  countSpawn(`helper ${spawnLabel(file, args)}`);
  return new Promise((resolve) => {
    // A helper that does not answer well past the command's own timeout is stuck: its exit fails what waits and starts a new one.
    const limitMs = groupTimeoutMs || Number(options.timeout) || 0;
    const stuck = limitMs > 0 ? setTimeout(() => helper.kill("SIGKILL"), limitMs + 10_000) : undefined;
    stuck?.unref();
    execHelperWaiting.set(id, (reply) => {
      clearTimeout(stuck);
      resolve(reply);
    });
  });
}

// promisify(execFile) must keep resolving to { stdout, stderr } like Node's own execFile, and rejecting with its error
// (code, killed, signal, cmd) carrying stdout and stderr.
Object.defineProperty(execFile, promisify.custom, {
  value: (...args: unknown[]) => {
    const safe = withSafeEnv(args, false);
    const hasArgs = Array.isArray(safe[1]);
    const file = String(safe[0]);
    const fileArgs = hasArgs ? (safe[1] as unknown[]).map(String) : [];
    const viaHelper = execInHelper(file, fileArgs, safe[hasArgs ? 2 : 1] as Record<string, unknown>);
    if (!viaHelper) {
      countSpawn(spawnLabel(file, fileArgs));
      return (promisify(childProcess.execFile) as (...a: unknown[]) => Promise<unknown>)(...safe);
    }
    return viaHelper.then(({ error, stdout, stderr }) => {
      if (error) throw Object.assign(new Error(error.message), error, { stdout, stderr });
      return { stdout, stderr };
    });
  }
});
