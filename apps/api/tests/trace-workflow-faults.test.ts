import { describe, expect, it } from "vitest";
import { temporal } from "@temporalio/proto";
import { readWorkflowTaskFaults } from "../src/trace-workflow-faults.js";

const { History } = temporal.api.history.v1;
const failed = (eventId: number, seconds: number, cause: number) => ({
  eventId, eventTime: { seconds, nanos: 500_000_000 }, eventType: 6,
  workflowTaskFailedEventAttributes: { cause, failure: { message: "secret user prompt" } }
});
// Real protobufjs-decoded history, as fetchHistory() returns it.
const decoded = (events: object[]) => History.decode(History.encode({ events } as never).finish());

describe("readWorkflowTaskFaults (EXT-G-5)", () => {
  it("names each workflow's task-fault cause and count, never the failure message", async () => {
    const histories: Record<string, () => Promise<unknown>> = {
      faulted: async () => decoded([{ eventId: 1, eventType: 1 }, failed(5, 1_700_000_000, 2), failed(9, 1_700_000_060, 1)]),
      clean: async () => decoded([{ eventId: 1, eventType: 1 }]),
      gone: async () => { throw new Error("workflow not found"); }
    };
    const client = { workflow: { getHandle: (id: string) => ({ fetchHistory: histories[id] as never }) } };
    const faults = await readWorkflowTaskFaults(client as never, ["faulted", "clean", "gone"]);
    expect(faults).toEqual([{
      workflowId: "faulted", cause: "WORKFLOW_TASK_FAILED_CAUSE_UNHANDLED_COMMAND", failures: 2, lastAt: "2023-11-14T22:14:20.500Z"
    }]);
    expect(JSON.stringify(faults)).not.toContain("secret");
  });
});
