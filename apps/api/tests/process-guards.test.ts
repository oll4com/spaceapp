import { describe, expect, it, vi } from "vitest";
import { createProcessGuardHandlers, isRecoverableBackgroundError } from "../src/process-guards.js";

function harness() {
  const log = { error: vi.fn(), fatal: vi.fn() };
  const shutdown = vi.fn(async () => undefined);
  const exit = vi.fn();
  const handlers = createProcessGuardHandlers({ log, shutdown, exit, exitDelayMs: 50 });
  return { log, shutdown, exit, handlers };
}

describe("process guards", () => {
  it("recognises the Temporal retry-after-close fault", () => {
    expect(isRecoverableBackgroundError(new Error("Channel has been shut down"))).toBe(true);
    expect(isRecoverableBackgroundError(new Error("Channel has been shut down by someone"))).toBe(false);
    expect(isRecoverableBackgroundError(new TypeError("x is not a function"))).toBe(false);
    expect(isRecoverableBackgroundError(undefined)).toBe(false);
  });

  it("logs unhandled rejections without ending the process", () => {
    const { log, shutdown, exit, handlers } = harness();
    handlers.onUnhandledRejection(new Error("background failure"), Promise.resolve());
    expect(log.error).toHaveBeenCalledTimes(1);
    expect(shutdown).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
  });

  it("keeps serving after a recoverable background exception", () => {
    const { log, shutdown, exit, handlers } = harness();
    handlers.onUncaughtException(new Error("Channel has been shut down"), "uncaughtException");
    expect(log.error).toHaveBeenCalledTimes(1);
    expect(log.fatal).not.toHaveBeenCalled();
    expect(shutdown).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
  });

  it("shuts down gracefully once and exits with code 1 on unknown exceptions", async () => {
    const { log, shutdown, exit, handlers } = harness();
    handlers.onUncaughtException(new Error("boom"), "uncaughtException");
    handlers.onUncaughtException(new Error("boom again"), "uncaughtException");
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
    expect(log.fatal).toHaveBeenCalledTimes(2);
    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it("forces the exit when the graceful shutdown hangs", async () => {
    const log = { error: vi.fn(), fatal: vi.fn() };
    const exit = vi.fn();
    const handlers = createProcessGuardHandlers({ log, shutdown: () => new Promise(() => {}), exit, exitDelayMs: 20 });
    handlers.onUncaughtException(new Error("boom"), "uncaughtException");
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
  });
});
