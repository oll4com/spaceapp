import type { ChildProcess } from "node:child_process";
import type { Socket } from "node:net";
import { createInterface } from "node:readline";
import { spawn } from "./safe-child-process.js";

/**
 * One long-lived launcher reader (`<runtime>-vscode-parity native-turns --serve`) instead of one sudo
 * launcher per read: a JSON request per stdin line, a `{id, result}` answer per stdout line.
 * `read` answers `undefined` while the server is unavailable (it would not start, or it died with the
 * read in flight), so the caller falls back to its one-shot launcher read. A server that ends before
 * its first answer (an older launcher, dev without sudo) is left alone for a minute; one that answered
 * starts again at the next read. A read that times out answers null and restarts the server.
 */
export function createNativeReadServer<T>(options: {
  command: string;
  args: string[];
  timeoutMs?: number;
  now?: () => number;
}) {
  const timeoutMs = options.timeoutMs ?? 3_000;
  const now = options.now ?? Date.now;
  const pending = new Map<number, (value: T | null | undefined) => void>();
  let child: ChildProcess | null = null;
  let answered = false;
  let unavailableUntil = 0;
  let nextId = 0;

  const ended = (target: ChildProcess) => {
    if (child !== target) return;
    child = null;
    if (!answered) unavailableUntil = now() + 60_000;
    for (const settle of pending.values()) settle(undefined);
    pending.clear();
  };

  const start = (): ChildProcess => {
    const started = spawn(options.command, options.args, { stdio: ["pipe", "pipe", "ignore"], env: { PATH: "/usr/bin:/bin" } });
    child = started;
    answered = false;
    started.on("error", () => ended(started));
    started.on("exit", () => ended(started));
    started.stdin?.on("error", () => started.kill());
    if (started.stdout) {
      createInterface({ input: started.stdout, crlfDelay: Infinity }).on("line", (line) => {
        let message: { id?: unknown; result?: T | null };
        try { message = JSON.parse(line) as typeof message; } catch { return; }
        const settle = typeof message.id === "number" ? pending.get(message.id) : undefined;
        if (!settle) return;
        pending.delete(message.id as number);
        answered = true;
        settle(message.result ?? null);
      });
    }
    // The API exits without waiting for its reader; the reader ends at the closed stdin.
    started.unref();
    (started.stdin as Socket | null)?.unref?.();
    (started.stdout as Socket | null)?.unref?.();
    return started;
  };

  return {
    read(request: Record<string, unknown>): Promise<T | null | undefined> {
      if (now() < unavailableUntil) return Promise.resolve(undefined);
      const target = child ?? start();
      const id = ++nextId;
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          if (!pending.delete(id)) return;
          resolve(null);
          target.kill();
        }, timeoutMs);
        pending.set(id, (value) => {
          clearTimeout(timer);
          resolve(value);
        });
        target.stdin?.write(`${JSON.stringify({ ...request, id })}\n`);
      });
    },
    stop() {
      child?.kill();
    }
  };
}
