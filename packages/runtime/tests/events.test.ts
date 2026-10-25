import { describe, expect, it } from "vitest";
import type { Event } from "@space/contracts";
import { SpaceEventBus } from "../src/index.js";

const event: Event = {
  id: "event:test-bus",
  roomId: "room:test-bus",
  paneId: null,
  turnId: null,
  workflowId: null,
  traceId: "trace:test-bus",
  type: "PANE_UPDATED",
  message: "Pane updated.",
  payload: {},
  createdAt: "2026-07-18T12:00:00.000Z"
};

describe("SpaceEventBus", () => {
  it("isolates subscriber and error-reporter exceptions", () => {
    const delivered: string[] = [];
    const reported: unknown[] = [];
    const bus = new SpaceEventBus({
      onSubscriberError: (error) => {
        reported.push(error);
        throw new Error("reporter failed");
      }
    });
    bus.subscribe(() => {
      throw new Error("subscriber failed");
    });
    bus.subscribe((next) => delivered.push(next.id));

    expect(() => bus.publish(event)).not.toThrow();
    expect(delivered).toEqual([event.id]);
    expect(reported).toHaveLength(1);
  });
});
