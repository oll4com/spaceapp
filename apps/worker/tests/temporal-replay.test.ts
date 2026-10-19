import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { defaultPayloadConverter } from "@temporalio/common";
import temporalProto from "@temporalio/proto";
import { Worker } from "@temporalio/worker";
import { DeterminismViolationError } from "@temporalio/workflow";
import { test } from "vitest";
import { bundle, type History } from "./support/temporal/harness.js";

const fixtureDirectory = new URL("./fixtures/workflow-histories/", import.meta.url);
const { temporal } = temporalProto;
const requiredWorkflows = [
  "dotGoalWorkflow", "dummyTurnWorkflow", "codexAppServerTurnWorkflow",
  "roomAgentSupervisorWorkflow", "roomAgentActionWorkflow",
  "memoryMaintenanceWorkflow", "memoryConsolidationWorkflow", "memoryMutationWorkflow"
];

async function fixtures() {
  const names = (await readdir(fixtureDirectory)).filter(name => name.endsWith(".json")).sort();
  assert.ok(names.length > 0, "Missing committed workflow histories; ordinary tests never record replacements");
  const records: { filename: string; workflowId: string; workflowType: string; branch: string; history: History }[] = [];
  for (const filename of names) {
    const envelope = JSON.parse(await readFile(new URL(filename, fixtureDirectory), "utf8"));
    assert.equal(envelope.schemaVersion, 1, `${filename}: unsupported fixture schema`);
    assert.ok(typeof envelope.workflowId === "string" && envelope.workflowId.length > 0, `${filename}: missing original workflowId`);
    assert.ok(envelope.branch === "current" || envelope.branch === "legacy", `${filename}: missing workflow branch`);
    const history = temporal.api.history.v1.History.fromObject(envelope.history);
    assert.ok(history.events?.length, `${filename}: empty history`);
    const started = history.events[0]?.workflowExecutionStartedEventAttributes;
    assert.ok(started, `${filename}: first event must start the workflow`);
    assert.equal(started.workflowType?.name, envelope.workflowType, `${filename}: wrong workflow type`);
    if (envelope.workflowType === "roomAgentSupervisorWorkflow") {
      // Check the recorded commands, not just the envelope's branch label.
      const patchIds = history.events.flatMap(event => {
        const marker = event.markerRecordedEventAttributes;
        if (marker?.markerName !== "core_patch") return [];
        const payload = marker.details?.["patch-data"]?.payloads?.[0];
        assert.ok(payload, `${filename}: missing patch marker data`);
        const data = defaultPayloadConverter.fromPayload(payload) as { id?: string };
        assert.equal(typeof data.id, "string", `${filename}: invalid patch marker data`);
        return [data.id];
      });
      const hasCurrentPatch = patchIds.includes("room-background-continuation-v1");
      assert.equal(hasCurrentPatch, envelope.branch === "current", `${filename}: history does not prove its supervisor branch`);
      if (envelope.branch === "legacy") {
        const activityTypes = history.events.map(event => event.activityTaskScheduledEventAttributes?.activityType?.name);
        assert.ok(activityTypes.includes("markRoomAgentMissionStarted") || activityTypes.includes("settleRoomAgentBackgroundMission"),
          `${filename}: legacy history must execute a legacy-only activity`);
        assert.ok(!activityTypes.includes("checkRoomAgentSupervisorTurn") && !activityTypes.includes("prepareRoomAgentBackgroundContinuation"),
          `${filename}: legacy history contains current-only activities`);
      }
    }
    records.push({ filename, workflowId: envelope.workflowId, workflowType: envelope.workflowType, branch: envelope.branch, history });
  }
  for (const workflowType of requiredWorkflows) {
    assert.ok(records.some(record => record.workflowType === workflowType && record.branch === "current"),
      `Missing current history for ${workflowType}`);
  }
  assert.ok(records.some(record => record.workflowType === "roomAgentSupervisorWorkflow" && record.branch === "legacy"),
    "Missing pre-patch roomAgentSupervisorWorkflow history");
  for (const name of [
    ...requiredWorkflows, "roomAgentSupervisorWorkflow-legacy", "roomAgentSupervisorWorkflow-legacy-settle",
    "roomAgentSupervisorWorkflow-current-rollover", "roomAgentSupervisorWorkflow-current-successor",
    "roomAgentSupervisorWorkflow-legacy-rollover", "roomAgentSupervisorWorkflow-legacy-successor",
    "dotGoalWorkflow-wake", "dotGoalWorkflow-rollover"
  ]) assert.ok(records.some(record => record.filename === `${name}.json`), `Missing immutable baseline history: ${name}`);
  return records;
}

test("all committed synthetic histories replay against the current production workflows", async () => {
  const records = await fixtures();
  const workflowBundle = await bundle();
  let replayed = 0;
  // The SDK yields one result per input history, in input order. Inspect every error.
  for await (const result of Worker.runReplayHistories({ workflowBundle }, records)) {
    const fixture = records[replayed++];
    assert.ok(fixture, "Replay returned more histories than supplied");
    assert.equal(result.workflowId, fixture.workflowId, `${fixture.filename}: workflow identity changed`);
    assert.equal(result.error, undefined,
      `${fixture.workflowType}: ${fileURLToPath(new URL(fixture.filename, fixtureDirectory))}: ${result.error?.stack ?? result.error}`);
  }
  assert.equal(replayed, records.length, "Replay must consume every committed history");
}, 90_000);

test("an extra unpatched timer is rejected by the replay gate", async () => {
  const records = await fixtures();
  const fixture = records.find(record => record.workflowType === "dotGoalWorkflow" && record.branch === "current")!;
  const workflowBundle = await bundle("nondeterministic");
  let replayed = 0;
  for await (const result of Worker.runReplayHistories({ workflowBundle }, [fixture])) {
    replayed++;
    assert.equal(result.workflowId, fixture.workflowId);
    assert.ok(result.error instanceof DeterminismViolationError,
      `${fixture.filename}: extra timer must fail with DeterminismViolationError, got ${result.error?.stack ?? "success"}`);
  }
  assert.equal(replayed, 1, "The negative control must actually replay its saved history");
}, 60_000);
