import { beforeEach, describe, expect, it, vi } from "vitest";

const temporal = vi.hoisted(() => {
  class WorkflowNotFoundError extends Error {}
  return { connect: vi.fn(), describe: vi.fn(), WorkflowNotFoundError };
});
vi.mock("@temporalio/client", () => ({
  Connection: { connect: temporal.connect },
  Client: class { workflow = { getHandle: () => ({ describe: temporal.describe }) }; },
  WorkflowNotFoundError: temporal.WorkflowNotFoundError
}));
const states = vi.hoisted(() => ({ ids: [] as string[], seen: [] as string[] }));
vi.mock("../src/stranded-chat-runs.js", () => ({
  sweepStrandedChatRuns: async (deps: { workflowState(id: string): Promise<string> }) => {
    for (const id of states.ids) states.seen.push(await deps.workflowState(id));
  }
}));
const { createStrandedChatRunSweep } = await import("../src/stranded-chat-run-sweep.js");

const sweep = (overrides: { enableCodexTurns?: boolean; dotsRepository?: object | null } = {}) =>
  createStrandedChatRunSweep({ log: { warn: vi.fn() } } as any, {
    config: { enableCodexTurns: overrides.enableCodexTurns ?? true, temporalAddress: "t:7233", temporalNamespace: "ns" } as any,
    store: {} as any,
    dotsRepository: (overrides.dotsRepository === undefined ? {} : overrides.dotsRepository) as any
  }).sweepStrandedChatRuns();

describe("stranded Chat run sweep (Temporal side)", () => {
  beforeEach(() => {
    temporal.connect.mockReset(); temporal.describe.mockReset();
    states.ids = ["wf:a", "wf:b", "wf:c"]; states.seen = [];
  });

  it("does nothing without the Dots repository or Codex turns", async () => {
    await sweep({ dotsRepository: null });
    await sweep({ enableCodexTurns: false });
    expect(states.seen).toEqual([]);
    expect(temporal.connect).not.toHaveBeenCalled();
  });

  it("opens one connection per sweep, reads each workflow and closes it", async () => {
    const close = vi.fn();
    temporal.connect.mockResolvedValue({ close });
    temporal.describe
      .mockResolvedValueOnce({ status: { name: "RUNNING" } })
      .mockResolvedValueOnce({ status: { name: "COMPLETED" } })
      .mockRejectedValueOnce(new temporal.WorkflowNotFoundError("gone"));
    await sweep();
    expect(states.seen).toEqual(["RUNNING", "CLOSED", "NOT_FOUND"]);
    expect(temporal.connect).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("leaves every run UNKNOWN after Temporal is unreachable once", async () => {
    temporal.connect.mockRejectedValue(new Error("ECONNREFUSED"));
    await sweep();
    expect(states.seen).toEqual(["UNKNOWN", "UNKNOWN", "UNKNOWN"]);
    expect(temporal.connect).toHaveBeenCalledTimes(1);
  });
});
