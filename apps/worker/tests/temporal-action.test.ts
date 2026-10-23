import { afterAll, beforeAll, expect, it } from "vitest";
import { Context } from "@temporalio/activity";
import { Sandbox } from "./support/temporal-sandbox.js";

let sandbox: Sandbox;
beforeAll(async () => { sandbox = await Sandbox.create(); }, 60_000);
afterAll(async () => { await sandbox?.close(); });

it.each([undefined, "action:explicit"])("persists the patched background-action failure after all five retries (actionId=%s)", async actionId => {
  const input = { bridge: { roomId: "room:synthetic", missionId: "mission:synthetic" }, traceId: "trace:synthetic", ...(actionId ? { actionId } : {}) };
  const attempts: number[] = [];
  const failures: unknown[] = [];
  await sandbox.run({
    runRoomAgentBackgroundAction: received => {
      expect(received).toEqual(input);
      attempts.push(Context.current().info.attempt);
      throw Error("Synthetic transport failed");
    },
    failRoomAgentBackgroundAction: failure => { failures.push(failure); }
  }, async () => {
    const handle = await sandbox.start("roomAgentActionWorkflow", input, { workflowId: "space-room-action:action:legacy" });
    await expect(handle.result()).rejects.toMatchObject({ name: "WorkflowFailedError", cause: { name: "ActivityFailure" } });
    expect(attempts).toEqual([1, 2, 3, 4, 5]);
    expect(failures).toEqual([{ roomId: "room:synthetic", missionId: "mission:synthetic", actionId: actionId ?? "action:legacy", cancelled: false }]);
    const markers = (await handle.fetchHistory()).events!.flatMap(event => event.markerRecordedEventAttributes ?? []);
    expect(markers.some(marker => marker.markerName === "core_patch")).toBe(true);
  });
}, 30_000);
