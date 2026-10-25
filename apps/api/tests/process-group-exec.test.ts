import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { execFileInProcessGroup, type ProcessGroupExecError } from "../src/process-group-exec.js";

async function isRunning(pid: number): Promise<boolean> {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3) !== "Z";
  } catch {
    return false;
  }
}

async function waitUntilStopped(pid: number, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await isRunning(pid))) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return !(await isRunning(pid));
}

function backgroundPid(error: unknown): number {
  const pid = Number.parseInt(String((error as ProcessGroupExecError).stdout).trim().split("\n")[0] ?? "", 10);
  expect(Number.isInteger(pid) && pid > 0).toBe(true);
  return pid;
}

describe.skipIf(process.platform === "win32")("execFileInProcessGroup", () => {
  it("returns stdout and stderr like execFile on success", async () => {
    await expect(execFileInProcessGroup("sh", ["-c", "printf out; printf err >&2"], { timeout: 5_000 }))
      .resolves.toEqual({ stdout: "out", stderr: "err" });
  });

  it("rejects with the exit code and captured output on failure", async () => {
    const error = await execFileInProcessGroup("sh", ["-c", "printf partial; exit 3"], { timeout: 5_000 })
      .catch((caught: unknown) => caught as ProcessGroupExecError);
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({ code: 3, killed: false, stdout: "partial" });
  });

  it("kills background descendants of the child on timeout", async () => {
    const startedAt = Date.now();
    const error = await execFileInProcessGroup(
      "sh",
      ["-c", "sleep 30 & echo $!; sleep 30"],
      { timeout: 1_500, killGraceMs: 500 }
    ).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "ETIMEDOUT", killed: true });
    expect(Date.now() - startedAt).toBeLessThan(10_000);
    await expect(waitUntilStopped(backgroundPid(error))).resolves.toBe(true);
  }, 20_000);

  it("escalates to SIGKILL when the process group ignores SIGTERM", async () => {
    const error = await execFileInProcessGroup(
      "sh",
      ["-c", "trap '' TERM; sleep 30 & echo $!; wait"],
      { timeout: 1_500, killGraceMs: 300 }
    ).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "ETIMEDOUT", killed: true });
    await expect(waitUntilStopped(backgroundPid(error))).resolves.toBe(true);
  }, 20_000);

  it("terminates the group when stdout exceeds maxBuffer", async () => {
    const error = await execFileInProcessGroup(
      "sh",
      ["-c", "sleep 30 & echo $!; sleep 0.5; head -c 4096 /dev/zero; sleep 30"],
      { timeout: 10_000, maxBuffer: 1_024, killGraceMs: 300 }
    ).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER", killed: true });
    await expect(waitUntilStopped(backgroundPid(error))).resolves.toBe(true);
  }, 20_000);

  it("terminates the group when aborted", async () => {
    const controller = new AbortController();
    const pending = execFileInProcessGroup("sh", ["-c", "sleep 30 & echo $!; sleep 30"], {
      signal: controller.signal,
      killGraceMs: 300
    }).catch((caught: unknown) => caught);
    setTimeout(() => controller.abort(), 1_500);
    const error = await pending;
    expect(error).toMatchObject({ code: "ABORT_ERR", killed: true });
    await expect(waitUntilStopped(backgroundPid(error))).resolves.toBe(true);
  }, 20_000);

  it("reports spawn failures without throwing synchronously", async () => {
    await expect(execFileInProcessGroup("/nonexistent/space-command", [], { timeout: 1_000 }))
      .rejects.toMatchObject({ code: "ENOENT" });
  });
});
