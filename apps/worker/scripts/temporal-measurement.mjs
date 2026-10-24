import { spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";

export function measureCommand(command, args, options = {}) {
  const started = performance.now();
  const result = spawnSync(command, args, options);
  const elapsedMs = performance.now() - started;
  if (result.error) throw result.error;
  return { elapsedMs, exitCode: result.status ?? 1, signal: result.signal ?? null };
}
