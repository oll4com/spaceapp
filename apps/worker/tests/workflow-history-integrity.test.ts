import assert from "node:assert/strict";
import { it } from "vitest";
import { assertPrePatchSupervisor, assertSyntheticHistory } from "./support/workflow-history-fixtures.js";

it("rejects private data hidden inside a base64 JSON payload", () => {
  const text = JSON.stringify({ events: [{ workflowExecutionStartedEventAttributes: { input: { payloads: [{
    metadata: { encoding: Buffer.from("json/plain").toString("base64") },
    data: Buffer.from(JSON.stringify({ contact: "private-sentinel@example.invalid" })).toString("base64")
  }] } } }] });
  assert.ok(!text.includes("private-sentinel@example.invalid"));
  assert.throws(() => assertSyntheticHistory(text), /non-synthetic/);
});

it("does not accept a current supervisor history relabeled as pre-patch", () => {
  assert.throws(() => assertPrePatchSupervisor({ events: [{ activityTaskScheduledEventAttributes: {
    activityType: { name: "prepareRoomAgentBackgroundContinuation" }
  } }] }), /actual legacy boolean activity/);
});
