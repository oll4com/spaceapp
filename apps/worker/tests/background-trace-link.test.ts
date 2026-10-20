import { expect, it } from "vitest";
import { parseTraceparent } from "@space/contracts";
import { prepareBackgroundContinuation } from "../src/room-background-continuation.js";
import { continuationFixture } from "./room-continuation-fixture.js";

it("persists a new background trace and a link to its originating request, including idempotent retries", async () => {
  const parent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
  const fixture = continuationFixture("OPEN_TYPES", parent);
  const prepared = await prepareBackgroundContinuation(fixture.input, fixture.store);
  expect(prepared.state).toBe("READY");
  if (prepared.state !== "READY") throw new Error("Expected a prepared background continuation");
  expect(prepared.item.turn.traceLink).toBe(parent);
  const context = parseTraceparent(prepared.item.turn.traceparent);
  expect(context).not.toBeNull();
  expect(context!.traceId).not.toBe(parseTraceparent(parent)!.traceId);
  const retried = await prepareBackgroundContinuation(fixture.input, fixture.store);
  expect(retried.state).toBe("READY");
  if (retried.state !== "READY") throw new Error("Expected the existing prepared continuation");
  expect(retried.item.turn.traceparent).toBe(prepared.item.turn.traceparent);
  expect(retried.item.turn.traceLink).toBe(parent);
});
