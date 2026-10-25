import { beforeEach, expect, it, vi } from "vitest";
import { WorkflowNotFoundError } from "@temporalio/client";
import { TemporalRoomAgentWorkflowCoordinator } from "../src/room-agent.js";

const temporal = vi.hoisted(() => ({ signal: vi.fn(), close: vi.fn() }));
vi.mock("@temporalio/client", async (original) => ({
  ...await original<typeof import("@temporalio/client")>(),
  Connection: { connect: async () => ({ close: temporal.close }) },
  Client: class { workflow = { getHandle: () => ({ signal: temporal.signal }) }; }
}));
beforeEach(() => vi.resetAllMocks());
const coordinator = () => new TemporalRoomAgentWorkflowCoordinator({ address: "unused", namespace: "default", taskQueue: "proof" });

it("targets the exact mission instead of stopping newly queued work in the same room", async () => {
  await coordinator().stop("room:proof123", "Stop this mission", "mission:expected");
  expect(temporal.signal).toHaveBeenCalledWith(expect.any(String), { missionId: "mission:expected", reason: "Stop this mission" });
});

it("treats stopping a room without a supervisor as already stopped", async () => {
  temporal.signal.mockRejectedValue(new WorkflowNotFoundError("Not started", "room-supervisor:room:proof123"));
  await expect(coordinator().stop("room:proof123", "Stop")).resolves.toBeUndefined();
  expect(temporal.close).toHaveBeenCalledOnce();
});

it("does not hide transport failures when stopping real work", async () => {
  temporal.signal.mockRejectedValue(new Error("Transport unavailable"));
  await expect(coordinator().stop("room:proof123", "Stop")).rejects.toThrow("Transport unavailable");
  expect(temporal.close).toHaveBeenCalledOnce();
});
