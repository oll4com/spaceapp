import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

// The executors left app.ts (ARCH-001 step 45); the real command runs sudo, so spawn and the last-good file are faked.
const spawn = vi.hoisted(() => vi.fn());
const writeFile = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("../src/safe-child-process.js", async (importOriginal) => ({ ...await importOriginal<object>(), spawn }));
vi.mock("node:fs/promises", async (importOriginal) => ({ ...await importOriginal<object>(), writeFile }));

const { createCliModelsExecutors } = await import("../src/cli-models-executors.js");

function fakeChild(stdout: string) {
  const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), kill: vi.fn() });
  setImmediate(() => { child.stdout.emit("data", stdout); child.emit("close", 0); });
  return child;
}

describe("createCliModelsExecutors", () => {
  it("runs each runtime's models command once, caches it and keeps one executor per runtime", async () => {
    spawn.mockImplementation(() => fakeChild("model-a\nmodel-b\n"));
    const executor = createCliModelsExecutors();
    expect(executor("cli:kimi")).toBe(executor("cli:kimi"));

    expect(await executor("cli:kimi")()).toBe("model-a\nmodel-b\n");
    expect(await executor("cli:kimi")()).toBe("model-a\nmodel-b\n");
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn.mock.calls[0]!.slice(0, 2)).toEqual(["/usr/bin/sudo", ["-n", "/opt/spaceapp/bin/space-cli-vpn-broker", "exec", "cli:kimi", "models"]]);
    expect(writeFile).toHaveBeenCalledWith("/opt/spaceapp/var/kimi-models.last-good.json", expect.stringContaining("model-a"), "utf8");

    await executor("cli:deepseek")();
    expect(spawn.mock.calls[1]![1]).toEqual(["-n", "-u", "spaceapp-user", "--", "/opt/spaceapp/bin/deepseek-vscode-parity", "--run-inner", "models"]);
    expect(createCliModelsExecutors()("cli:kimi")).not.toBe(executor("cli:kimi"));
  });
});
