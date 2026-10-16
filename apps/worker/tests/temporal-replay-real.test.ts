import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "@temporalio/worker";
import { temporal } from "@temporalio/proto";
import { describe, expect, it } from "vitest";
import { bountyWorkflowsPath } from "./support/temporal-bounty.js";
import { historyDirectory, type RecordedWorkflowHistory } from "./support/temporal-history.js";

const workflowTypes = [
  "dummyTurnWorkflow", "codexAppServerTurnWorkflow", "roomAgentSupervisorWorkflow",
  "roomAgentActionWorkflow", "dotGoalWorkflow", "memoryMaintenanceWorkflow",
  "memoryConsolidationWorkflow", "memoryMutationWorkflow"
];

async function readHistories(): Promise<Array<RecordedWorkflowHistory & { file: string }>> {
  const names = (await readdir(historyDirectory)).filter((name) => name.endsWith(".json")).sort();
  if (names.length === 0) throw new Error("No recorded histories. Run npm run temporal:record-histories -w @space/worker.");
  return Promise.all(names.map(async (name) => {
    const record = JSON.parse(await readFile(join(historyDirectory, name), "utf8")) as RecordedWorkflowHistory;
    if (!record.workflowId || !record.workflowType || !record.history) throw new Error(`Invalid history envelope: ${name}`);
    // Restore Long, byte and enum fields before passing this protobuf JSON to Core.
    const history = temporal.api.history.v1.History.fromObject(record.history as Record<string, unknown>);
    return { ...record, history, file: name };
  }));
}

describe("real Temporal history replay gate", () => {
  it("covers all eight production workflows and the pre-patch supervisor branch", async () => {
    const histories = await readHistories();
    for (const type of workflowTypes) expect(histories.some((history) => history.workflowType === type), type).toBe(true);
    const prePatch = histories.find((history) => history.workflowType === "roomAgentSupervisorWorkflow" && history.file.includes("pre-patch"));
    expect(prePatch, "A real pre-patch supervisor history is required").toBeDefined();
    const events = (prePatch?.history as { events?: Array<{ activityTaskScheduledEventAttributes?: { activityType?: { name?: string } }; markerRecordedEventAttributes?: { markerName?: string } }> })?.events ?? [];
    const scheduled = events.flatMap((event) => event.activityTaskScheduledEventAttributes?.activityType?.name ?? []);
    expect(scheduled).toContain("markRoomAgentMissionStarted");
    expect(scheduled).toContain("markRoomAgentMissionFinished");
    expect(scheduled).not.toContain("prepareRoomAgentBackgroundContinuation");
    expect(events.some((event) => event.markerRecordedEventAttributes?.markerName === "core_patch")).toBe(false);
  });

  it("replays every recorded history against the current production workflows", async () => {
    const histories = await readHistories();
    const byId = new Map(histories.map((record) => [record.workflowId, record]));
    let replayed = 0;
    for await (const result of Worker.runReplayHistories(
      { workflowsPath: bountyWorkflowsPath },
      histories.map(({ workflowId, history }) => ({ workflowId, history }))
    )) {
      const record = byId.get(result.workflowId);
      if (result.error) throw new Error(`Replay failed: ${record?.workflowType} in ${record?.file}: ${String(result.error)}`, { cause: result.error });
      replayed += 1;
    }
    expect(replayed).toBe(histories.length);
  }, 120_000);

  it("rejects an extra timer with a named workflow/history determinism error", async () => {
    const record = (await readHistories()).find((history) => history.workflowType === "dummyTurnWorkflow");
    expect(record, "A real dummyTurnWorkflow recording is required").toBeDefined();
    if (!record) throw new Error("Missing dummyTurnWorkflow history");
    let failure: unknown;
    try {
      await Worker.runReplayHistory({
        workflowsPath: fileURLToPath(new URL("./fixtures/temporal-divergent-workflow.ts", import.meta.url))
      }, record.history, record.workflowId);
    } catch (error) {
      failure = error;
    }
    expect(failure, `${record.workflowType}: ${record.file} must reject the inserted timer`).toBeInstanceOf(Error);
    expect((failure as Error).name, `${record.workflowType}: ${record.file}`).toBe("DeterminismViolationError");
    const diagnostic = `${record.workflowType} in ${record.file}: ${(failure as Error).name}: ${(failure as Error).message}`;
    expect(diagnostic).toContain("dummyTurnWorkflow");
    expect(diagnostic).toContain(record.file);
    console.info(`Expected negative replay failure: ${diagnostic}`);
  }, 120_000);
});
