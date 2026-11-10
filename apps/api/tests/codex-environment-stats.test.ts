import { describe, expect, it, vi } from "vitest";
import { createCodexEnvironmentStats } from "../src/codex-environment-stats.js";

describe("Codex environment stats", () => {
  it("leaves the host stats out and logs when they cannot be read", async () => {
    const log = { warn: vi.fn() };
    const error = new Error("proc unreadable");
    const { readCodexEnvironmentHostStats } = createCodexEnvironmentStats({ log } as any, {
      store: {} as any,
      hostStatsProvider: async () => { throw error; }
    });

    await expect(readCodexEnvironmentHostStats()).resolves.toBeUndefined();
    expect(log.warn).toHaveBeenCalledWith({ err: error }, "Codex environment host stats collection failed.");
  });
});
