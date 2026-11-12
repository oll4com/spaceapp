import { spawn } from "node:child_process";
import { once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

const execFileAsync = vi.hoisted(() => vi.fn());
vi.mock("../src/safe-child-process.js", async (importOriginal) => {
  const { promisify } = await import("node:util");
  return { ...await importOriginal<object>(), execFile: Object.assign(() => undefined, { [promisify.custom]: execFileAsync }) };
});

const { createDeepSeekHarnessServiceController } = await import("../src/service-restarts.js");

afterEach(() => { vi.useRealTimers(); });

describe("DeepSeek Harness pid", () => {
  it("asks systemd once while the pid's process runs, again when it ends, a minute after no pid, and after Space restarts it (CPU plan 4.3)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const harness = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    await once(harness, "spawn");
    let mainPid = String(harness.pid);
    execFileAsync.mockImplementation(async (_command: string, args: string[]) => ({ stdout: args.includes("--property=MainPID") ? `${mainPid}\n` : "", stderr: "" }));
    const asks = () => execFileAsync.mock.calls.filter(([, args]) => (args as string[]).includes("--property=MainPID")).length;
    const controller = createDeepSeekHarnessServiceController();
    try {
      expect(await Promise.all([controller.mainPid(), controller.mainPid()])).toEqual([harness.pid, harness.pid]);
      expect(await controller.mainPid()).toBe(harness.pid);
      expect(asks()).toBe(1);
      expect(await controller.mainPid({ fresh: true })).toBe(harness.pid);
      expect(asks()).toBe(2);
    } finally {
      harness.kill();
    }
    await once(harness, "exit");
    mainPid = "0";
    expect(await controller.mainPid()).toBeNull();
    expect(asks()).toBe(3);
    vi.setSystemTime(Date.now() + 59_000);
    expect(await controller.mainPid()).toBeNull();
    expect(asks()).toBe(3);
    vi.setSystemTime(Date.now() + 2_000);
    expect(await controller.mainPid()).toBeNull();
    expect(asks()).toBe(4);
    mainPid = String(process.pid);
    await controller.restart();
    expect(await controller.mainPid()).toBe(process.pid);
    expect(asks()).toBe(5);
  });
});
