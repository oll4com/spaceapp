import { chmod, lstat } from "node:fs/promises";
import type { Server } from "node:http";
import { dirname } from "node:path";

/** Rebind an unlinked listener without closing existing upgraded WebSockets. */
export function maintainSocketPath(server: Server, socketPath: string): () => void {
  let stopped = false;
  let pending = false;
  const check = async () => {
    if (stopped || pending || !server.listening) return;
    pending = true;
    try {
      try {
        await lstat(socketPath);
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") return;
      }
      const parent = await lstat(dirname(socketPath));
      if (!parent.isDirectory() || parent.isSymbolicLink() || stopped) return;
      // A live upgraded connection belongs to the HTTP/WebSocket server, not
      // its listening handle. Closing only the listener preserves these clients.
      await chmod(dirname(socketPath), 0o770);
      if (stopped) return;
      server.close();
      await new Promise<void>((resolve, reject) => {
        const failed = (error: Error) => { server.off("listening", ready); reject(error); };
        const ready = () => { server.off("error", failed); resolve(); };
        server.once("error", failed);
        server.once("listening", ready);
        server.listen(socketPath);
      });
      await chmod(socketPath, 0o660);
    } catch {
      // Never terminate an active CLI because control-path maintenance failed.
    } finally {
      pending = false;
    }
  };
  const timer = setInterval(() => void check(), 2_000);
  timer.unref();
  void check();
  return () => { stopped = true; clearInterval(timer); };
}
