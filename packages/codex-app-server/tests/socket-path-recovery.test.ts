import { EventEmitter } from "node:events";
import type { Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { maintainSocketPath } from "../src/socket-path-recovery.js";

const fs = vi.hoisted(() => ({ lstat: vi.fn(), chmod: vi.fn() }));
vi.mock("node:fs/promises", () => fs);

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

function listener() {
  const server = Object.assign(new EventEmitter(), { listening: true });
  const close = vi.fn(() => { server.listening = false; return server; });
  const listen = vi.fn(() => {
    server.listening = true;
    server.emit("listening");
    return server;
  });
  return Object.assign(server, { close, listen });
}

afterEach(() => {
  vi.useRealTimers();
  vi.resetAllMocks();
});

describe("socket path recovery lifecycle", () => {
  it.each(["lstat", "chmod"])("does not reopen an intentionally closed listener while %s is pending", async (phase) => {
    vi.useFakeTimers();
    const pending = gate();
    const entered = gate();
    fs.lstat.mockImplementation(async (path: string) => {
      if (path === "/synthetic/app.sock") {
        if (phase === "lstat") { entered.release(); await pending.promise; }
        throw Object.assign(new Error("synthetic unlinked socket"), { code: "ENOENT" });
      }
      return { isDirectory: () => true, isSymbolicLink: () => false };
    });
    fs.chmod.mockImplementation(async () => {
      if (phase === "chmod") { entered.release(); await pending.promise; }
    });
    const server = listener();
    const stop = maintainSocketPath(server as unknown as Server, "/synthetic/app.sock");
    try {
      await entered.promise;
      // Transport failure or explicit shutdown closes the listening handle
      // while filesystem maintenance still owns an in-flight operation.
      server.close();
      pending.release();
      await vi.advanceTimersByTimeAsync(0);
      expect(server.listen).not.toHaveBeenCalled();
      expect(server.listening).toBe(false);
    } finally { pending.release(); stop(); }
  });

  it("rebinds a missing path while the listener is still live", async () => {
    vi.useFakeTimers();
    fs.lstat.mockImplementation(async (path: string) => {
      if (path === "/synthetic/app.sock") throw Object.assign(new Error("synthetic unlinked socket"), { code: "ENOENT" });
      return { isDirectory: () => true, isSymbolicLink: () => false };
    });
    fs.chmod.mockResolvedValue(undefined);
    const server = listener();
    const stop = maintainSocketPath(server as unknown as Server, "/synthetic/app.sock");
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(server.close).toHaveBeenCalledOnce();
      expect(server.listen).toHaveBeenCalledExactlyOnceWith("/synthetic/app.sock");
      expect(server.listening).toBe(true);
    } finally { stop(); }
  });
});
