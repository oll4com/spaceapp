import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execute = promisify(execFile);

/** POSIX ps is available on the supported Linux/macOS hosts. Never signal a PID. */
export async function devProcessIdentity(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 1) return null;
  try {
    const { stdout } = await execute("ps", ["-p", String(pid), "-o", "lstart=", "-o", "comm="], { timeout: 3000, maxBuffer: 16384, env: { PATH: "/usr/bin:/bin", LC_ALL: "C" } });
    const identity = stdout.trim();
    if (!identity) throw new Error("Process start identity could not be read.");
    return identity;
  } catch (error) {
    try { process.kill(pid, 0); } catch (probe) { if (probe.code === "ESRCH") return null; }
    throw error;
  }
}

export async function devSupervisorIsAlive(record, readIdentity = devProcessIdentity) {
  const current = await readIdentity(record.pid);
  if (current === null) return false;
  // Old records cannot prove PID reuse. Preserve their conservative behavior.
  return typeof record.identity !== "string" || record.identity === current;
}
