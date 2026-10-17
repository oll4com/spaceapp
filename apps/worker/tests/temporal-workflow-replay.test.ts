/**
 * @fileoverview Replay determinism test suite.
 * Replays all checked-in workflow history fixtures against production workflow code using Worker.runReplayHistories,
 * and executes negative control tests proving that unpatched workflow changes throw DeterminismViolationError.
 */

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "@temporalio/worker";
import { DeterminismViolationError } from "@temporalio/workflow";
import proto from "@temporalio/proto";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const workerRoot = path.resolve(__dirname, "..");
const fixturesDir = path.resolve(__dirname, "fixtures/workflow-histories");

const workflowsPath = path.resolve(workerRoot, "src/workflows.ts");
const memoryMaintenanceWorkflowsPath = path.resolve(workerRoot, "src/memory-maintenance-workflows.ts");
const memoryMutationWorkflowsPath = path.resolve(workerRoot, "src/memory-mutation-workflows.ts");
const nonDeterministicWorkflowsPath = path.resolve(__dirname, "support/non-deterministic-workflows.ts");

interface LoadedHistoryFixture {
  fileName: string;
  workflowName: string;
  workflowId: string;
  workflowsPath: string;
  history: Record<string, unknown>;
}

const WORKFLOW_MODULE_BY_TYPE: Record<string, string> = {
  dotGoalWorkflow: workflowsPath,
  dummyTurnWorkflow: workflowsPath,
  codexAppServerTurnWorkflow: workflowsPath,
  roomAgentSupervisorWorkflow: workflowsPath,
  roomAgentActionWorkflow: workflowsPath,
  memoryMaintenanceWorkflow: memoryMaintenanceWorkflowsPath,
  memoryConsolidationWorkflow: memoryMaintenanceWorkflowsPath,
  memoryMutationWorkflow: memoryMutationWorkflowsPath
};

const WORKFLOW_ID_BY_FILE: Record<string, string> = {
  "roomAgentActionWorkflow.json": "space-room-action:action:fixture"
};

/**
 * Loads all JSON workflow history fixtures from the fixtures directory.
 * @returns Array of loaded history fixture descriptors
 */
async function loadHistoryFixtures(): Promise<LoadedHistoryFixture[]> {
  const entries = (await readdir(fixturesDir)).filter((f) => f.endsWith(".json")).sort();
  const fixtures: LoadedHistoryFixture[] = [];

  for (const fileName of entries) {
    const raw = await readFile(path.join(fixturesDir, fileName), "utf8");
    const parsed = JSON.parse(raw) as {
      events?: Array<{
        workflowExecutionStartedEventAttributes?: {
          workflowType?: { name?: string };
        };
      }>;
    };
    const workflowName =
      parsed.events?.[0]?.workflowExecutionStartedEventAttributes?.workflowType?.name ?? "unknownWorkflow";
    const modulePath = WORKFLOW_MODULE_BY_TYPE[workflowName];
    if (!modulePath) {
      throw new Error(`History fixture ${fileName} references unsupported workflow type "${workflowName}".`);
    }
    const historyProto = proto.temporal.api.history.v1.History.fromObject(parsed);
    fixtures.push({
      fileName,
      workflowName,
      workflowId: WORKFLOW_ID_BY_FILE[fileName] ?? `replay:${fileName.replace(/\.json$/, "")}`,
      workflowsPath: modulePath,
      history: historyProto as unknown as Record<string, unknown>
    });
  }

  return fixtures;
}

/**
 * Replays a list of history fixtures against a specified workflow bundle.
 * @param targetWorkflowsPath - Path to workflow source module
 * @param fixtures - Fixtures to replay
 */
async function replayFixturesForModule(
  targetWorkflowsPath: string,
  fixtures: LoadedHistoryFixture[]
): Promise<void> {
  const replayInputs = fixtures.map((f) => ({
    history: f.history,
    workflowId: f.workflowId
  }));
  const byWorkflowId = new Map(fixtures.map((f) => [f.workflowId, f]));

  for await (const result of Worker.runReplayHistories(
    { workflowsPath: targetWorkflowsPath },
    replayInputs
  )) {
    if (result.error) {
      const fixture = byWorkflowId.get(result.workflowId);
      const label = fixture
        ? `workflow "${fixture.workflowName}" in history file "${fixture.fileName}"`
        : `workflowId "${result.workflowId}"`;
      if (result.error instanceof DeterminismViolationError) {
        const wrapped = new DeterminismViolationError(
          `Replay determinism violation for ${label}: ${result.error.message}`
        );
        wrapped.stack = result.error.stack;
        throw wrapped;
      }
      throw new Error(`Replay failed for ${label}: ${result.error.message}`, {
        cause: result.error
      });
    }
  }
}

describe("Temporal workflow replay determinism gate", () => {
  it(
    "covers all 8 workflows plus the pre-patch supervisor branch and replays all recorded histories cleanly",
    async () => {
      const fixtures = await loadHistoryFixtures();
      const recordedWorkflowNames = new Set(fixtures.map((f) => f.workflowName));

      expect([...recordedWorkflowNames].sort()).toEqual(
        Object.keys(WORKFLOW_MODULE_BY_TYPE).sort()
      );

      const prePatchFixture = fixtures.find(
        (f) => f.fileName === "roomAgentSupervisorWorkflow.pre-patch.json"
      );
      expect(prePatchFixture).toBeDefined();
      const prePatchSerialized = JSON.stringify(prePatchFixture!.history);
      expect(prePatchSerialized).toContain("settleRoomAgentBackgroundMission");
      expect(prePatchSerialized).not.toContain("prepareRoomAgentBackgroundContinuation");

      const currentSupFixture = fixtures.find(
        (f) => f.fileName === "roomAgentSupervisorWorkflow.json"
      );
      expect(currentSupFixture).toBeDefined();
      expect(JSON.stringify(currentSupFixture!.history)).toContain(
        "prepareRoomAgentBackgroundContinuation"
      );

      for (const modulePath of new Set(Object.values(WORKFLOW_MODULE_BY_TYPE))) {
        const group = fixtures.filter((f) => f.workflowsPath === modulePath);
        await replayFixturesForModule(modulePath, group);
      }
    },
    120_000
  );

  it(
    "fails replay with DeterminismViolationError when a workflow variant adds an unpatched timer or activity",
    async () => {
      const fixtures = await loadHistoryFixtures();
      const dotGoalFixture = fixtures.find((f) => f.fileName === "dotGoalWorkflow.json");
      const dummyTurnFixture = fixtures.find((f) => f.fileName === "dummyTurnWorkflow.json");
      expect(dotGoalFixture).toBeDefined();
      expect(dummyTurnFixture).toBeDefined();

      await expect(
        replayFixturesForModule(nonDeterministicWorkflowsPath, [dotGoalFixture!])
      ).rejects.toThrow(DeterminismViolationError);

      await expect(
        replayFixturesForModule(nonDeterministicWorkflowsPath, [dotGoalFixture!])
      ).rejects.toThrow(/dotGoalWorkflow.*dotGoalWorkflow\.json/);

      await expect(
        replayFixturesForModule(nonDeterministicWorkflowsPath, [dummyTurnFixture!])
      ).rejects.toThrow(DeterminismViolationError);

      await expect(
        replayFixturesForModule(nonDeterministicWorkflowsPath, [dummyTurnFixture!])
      ).rejects.toThrow(/dummyTurnWorkflow.*dummyTurnWorkflow\.json/);
    },
    120_000
  );
});
