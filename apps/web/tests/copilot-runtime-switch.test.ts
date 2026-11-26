import { beforeEach, describe, expect, it, vi } from "vitest";

const apiMock = vi.hoisted(() => ({ updatePane: vi.fn(), createCliSession: vi.fn(), activeCliSession: vi.fn() }));
vi.mock("../src/api.js", () => ({ api: apiMock }));

import { paneRunsRuntime, restartPaneCli } from "../src/features/copilot-kit/copilot-runtimes.js";

// 20/11 Bob (Mail Copilot): the record said cli:claude while the old cli:gemini CLI ran on Antigravity's exhausted pool.
describe("copilot runtime switch", () => {
  const pane = { id: "pane:bob", terminalRuntimeId: "cli:claude" };
  beforeEach(() => { vi.clearAllMocks(); apiMock.updatePane.mockResolvedValue({}); });

  it("reads a pane whose live CLI runs another runtime than its record as not running it", async () => {
    apiMock.activeCliSession.mockResolvedValue({ session: { runtimeId: "cli:gemini" } });
    expect(await paneRunsRuntime(pane, "cli:claude")).toBe(false);
    apiMock.activeCliSession.mockResolvedValue({ session: { runtimeId: "cli:claude" } });
    expect(await paneRunsRuntime(pane, "cli:claude")).toBe(true);
    expect(await paneRunsRuntime(pane, "cli:codex")).toBe(false);
  });

  it("puts the runtime record back when the restart fails, and keeps it when the restart succeeds", async () => {
    apiMock.createCliSession.mockRejectedValueOnce(new Error("Another tab controls this terminal."));
    await expect(restartPaneCli(pane, "cli:gemini", null)).rejects.toThrow("Another tab");
    expect(apiMock.updatePane.mock.calls).toEqual([[pane.id, { terminalRuntimeId: "cli:gemini" }], [pane.id, { terminalRuntimeId: "cli:claude" }]]);
    apiMock.updatePane.mockClear();
    apiMock.createCliSession.mockResolvedValueOnce({});
    await restartPaneCli(pane, "cli:claude", "space-gateway");
    expect(apiMock.updatePane).not.toHaveBeenCalled();
    expect(apiMock.createCliSession).toHaveBeenCalledWith(pane.id, { runtimeId: "cli:claude", forceRestart: true, includeTranscript: false, accountProfileId: "space-gateway" });
  });
});
