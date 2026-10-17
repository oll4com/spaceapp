import { spawn } from "./safe-child-process.js";

/**
 * execFile-compatible runner that owns the whole process tree of its child.
 *
 * `execFile`'s `timeout` signals only the direct child, so shell wrappers that
 * fork pipelines or helper scripts leave those descendants running (reparented
 * to PID 1) after a timeout. This runner starts the child as the leader of a
 * new process group and, on timeout, abort or maxBuffer overflow, sends
 * SIGTERM to the whole group and SIGKILL after `killGraceMs`.
 *
 * Limitation: signals reach only processes the API user may signal. When the
 * child re-executes through sudo as another user, the group signal reaches
 * sudo itself, which relays SIGTERM to the command it runs; SIGKILL cannot be
 * relayed, and a command that sudo moves to its own session (use_pty with a
 * terminal) is outside this group. Wrappers must therefore still bound their
 * own long-running work (for example with timeout(1)).
 */
export interface ProcessGroupExecOptions {
  /** Milliseconds before the process group is terminated; 0 disables it. */
  timeout?: number;
  /** Largest stdout or stderr size in bytes before the group is terminated. */
  maxBuffer?: number;
  /** Delay between SIGTERM and SIGKILL for the process group. */
  killGraceMs?: number;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  signal?: AbortSignal;
}

export interface ProcessGroupExecError extends Error {
  code: number | string | null;
  killed: boolean;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

const defaultMaxBuffer = 1024 * 1024;
const defaultKillGraceMs = 2_000;

function commandError(
  message: string,
  details: Pick<ProcessGroupExecError, "code" | "killed" | "signal" | "stdout" | "stderr">
): ProcessGroupExecError {
  return Object.assign(new Error(message), details) as ProcessGroupExecError;
}

export function execFileInProcessGroup(
  file: string,
  args: readonly string[],
  options: ProcessGroupExecOptions = {}
): Promise<{ stdout: string; stderr: string }> {
  const timeoutMs = Math.max(0, options.timeout ?? 0);
  const maxBuffer = Math.max(0, options.maxBuffer ?? defaultMaxBuffer);
  const killGraceMs = Math.max(0, options.killGraceMs ?? defaultKillGraceMs);
  const ownGroup = process.platform !== "win32";

  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(commandError("The operation was aborted", { code: "ABORT_ERR", killed: false, signal: null, stdout: "", stderr: "" }));
      return;
    }
    const child = spawn(file, [...args], {
      cwd: options.cwd,
      env: options.env,
      detached: ownGroup,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });
    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let terminationCode: string | null = null;
    let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
    let killTimer: ReturnType<typeof setTimeout> | null = null;
    let abandonTimer: ReturnType<typeof setTimeout> | null = null;

    const signalGroup = (signal: NodeJS.Signals) => {
      if (ownGroup && child.pid) {
        try {
          process.kill(-child.pid, signal);
          return;
        } catch {
          // The group may already be gone; fall back to the direct child.
        }
      }
      try {
        child.kill(signal);
      } catch {
        // Already exited.
      }
    };

    const cleanup = () => {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
      if (abandonTimer) clearTimeout(abandonTimer);
      options.signal?.removeEventListener("abort", onAbort);
    };

    const finish = (error: ProcessGroupExecError | null) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve({ stdout, stderr });
    };

    const terminate = (code: string) => {
      if (terminationCode) return;
      terminationCode = code;
      signalGroup("SIGTERM");
      killTimer = setTimeout(() => {
        signalGroup("SIGKILL");
        // Descendants that cannot be signalled may keep the pipes open; do not
        // wait for them forever once the group has been killed.
        abandonTimer = setTimeout(() => {
          child.stdout?.destroy();
          child.stderr?.destroy();
          finish(commandError(`Command failed: ${file}`, {
            code: terminationCode, killed: true, signal: "SIGKILL", stdout, stderr
          }));
        }, killGraceMs);
      }, killGraceMs);
    };

    function onAbort() {
      terminate("ABORT_ERR");
    }

    const collect = (stream: "stdout" | "stderr", chunk: string) => {
      const bytes = Buffer.byteLength(chunk);
      if (stream === "stdout") {
        stdoutBytes += bytes;
        if (stdoutBytes <= maxBuffer) stdout += chunk;
        else terminate("ERR_CHILD_PROCESS_STDIO_MAXBUFFER");
      } else {
        stderrBytes += bytes;
        if (stderrBytes <= maxBuffer) stderr += chunk;
        else terminate("ERR_CHILD_PROCESS_STDIO_MAXBUFFER");
      }
    };

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => collect("stdout", chunk));
    child.stderr?.on("data", (chunk: string) => collect("stderr", chunk));
    child.once("error", (error: NodeJS.ErrnoException) => {
      finish(commandError(error.message, {
        code: error.code ?? null, killed: false, signal: null, stdout, stderr
      }));
    });
    child.once("close", (exitCode: number | null, exitSignal: NodeJS.Signals | null) => {
      if (terminationCode) {
        finish(commandError(`Command failed: ${file}`, {
          code: terminationCode, killed: true, signal: exitSignal, stdout, stderr
        }));
        return;
      }
      if (exitCode === 0) {
        finish(null);
        return;
      }
      finish(commandError(`Command failed: ${file}`, {
        code: exitCode, killed: false, signal: exitSignal, stdout, stderr
      }));
    });

    if (timeoutMs > 0) timeoutTimer = setTimeout(() => terminate("ETIMEDOUT"), timeoutMs);
    options.signal?.addEventListener("abort", onAbort, { once: true });
  });
}
