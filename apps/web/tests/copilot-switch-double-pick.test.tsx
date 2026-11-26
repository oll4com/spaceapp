import { describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";

const apiMock = vi.hoisted(() => ({ updatePane: vi.fn(), createCliSession: vi.fn(), activeCliSession: vi.fn(), userSettings: vi.fn(), listCliAccountProfiles: vi.fn() }));
vi.mock("../src/api.js", () => ({ api: apiMock }));

import { useCopilotAgent } from "../src/features/copilot-kit/useCopilotAgent.js";
import type { CopilotKind } from "../src/features/copilot-kit/copilot-kind.js";

// 22/11 Bob review of 1605c7e13c: the guard read `switching`, still false while paneRunsRuntime awaited the live session.
describe("copilot agent switch", () => {
  it("restarts the CLI once when the agent is picked twice before the first pick settles", async () => {
    let release!: (value: unknown) => void;
    apiMock.activeCliSession.mockReturnValue(new Promise((resolve) => { release = resolve; }));
    apiMock.updatePane.mockResolvedValue({});
    apiMock.createCliSession.mockResolvedValue({});
    const pane = { id: "pane:bob", terminalRuntimeId: "cli:claude" };
    const { result } = renderHook(() => useCopilotAgent({ kind: {} as CopilotKind, pane, runtimeOptions: [], onNotice: () => undefined }));
    await act(async () => {
      const first = result.current.switchAgent("cli:claude", "main");
      const second = result.current.switchAgent("cli:claude", "main");
      release({ session: { runtimeId: "cli:gemini" } });
      await Promise.all([first, second]);
    });
    expect(apiMock.createCliSession).toHaveBeenCalledTimes(1);
    // The guard is released afterwards, so a later pick still switches.
    apiMock.activeCliSession.mockResolvedValue({ session: { runtimeId: "cli:gemini" } });
    await act(async () => { await result.current.switchAgent("cli:claude", "main"); });
    expect(apiMock.createCliSession).toHaveBeenCalledTimes(2);
  });
});
