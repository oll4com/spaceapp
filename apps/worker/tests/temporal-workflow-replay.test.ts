import { DeterminismViolationError } from "@temporalio/workflow";
import { describe, expect, it } from "vitest";
import {
  loadRecordedHistoryFixtures,
  replayHistoryFixtures
} from "./support/temporal-test-harness.js";

describe("Temporal workflow replay determinism gate", () => {
  it(
    "replays every recorded workflow history fixture against current workflow code",
    async () => {
      const fixtures = loadRecordedHistoryFixtures();
      expect(fixtures.map((fixture) => fixture.fileName)).toEqual([
        "codex-app-server-turn-workflow.json",
        "dot-goal-workflow.json",
        "dummy-turn-workflow.json",
        "memory-consolidation-workflow.json",
        "memory-maintenance-workflow.json",
        "memory-mutation-workflow.json",
        "room-agent-action-workflow.json",
        "room-agent-supervisor-pre-patch.json",
        "room-agent-supervisor-workflow.json"
      ]);

      const workflowTypes = new Set(fixtures.map((fixture) => fixture.workflowType));
      expect(workflowTypes).toEqual(
        new Set([
          "dotGoalWorkflow",
          "dummyTurnWorkflow",
          "codexAppServerTurnWorkflow",
          "roomAgentSupervisorWorkflow",
          "roomAgentActionWorkflow",
          "memoryMaintenanceWorkflow",
          "memoryConsolidationWorkflow",
          "memoryMutationWorkflow"
        ])
      );

      await expect(replayHistoryFixtures(fixtures)).resolves.toBeUndefined();
    },
    180_000
  );

  it(
    "fails replay with DeterminismViolationError naming workflow and file when an unpatched timer is added",
    async () => {
      const fixtures = loadRecordedHistoryFixtures();
      const dotGoalFixture = fixtures.find((fixture) => fixture.fileName === "dot-goal-workflow.json");
      expect(dotGoalFixture).toBeDefined();

      let caught: unknown;
      try {
        await replayHistoryFixtures([dotGoalFixture!], { loaderMode: "inject-sleep" });
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(DeterminismViolationError);
      expect((caught as Error).message).toMatch(/dotGoalWorkflow/);
      expect((caught as Error).message).toMatch(/dot-goal-workflow\.json/);
    },
    120_000
  );

  it(
    "fails replay with DeterminismViolationError naming workflow and file when an unpatched activity is added",
    async () => {
      const fixtures = loadRecordedHistoryFixtures();
      const dummyTurnFixture = fixtures.find((fixture) => fixture.fileName === "dummy-turn-workflow.json");
      expect(dummyTurnFixture).toBeDefined();

      let caught: unknown;
      try {
        await replayHistoryFixtures([dummyTurnFixture!], { loaderMode: "inject-activity" });
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(DeterminismViolationError);
      expect((caught as Error).message).toMatch(/dummyTurnWorkflow/);
      expect((caught as Error).message).toMatch(/dummy-turn-workflow\.json/);
    },
    120_000
  );
});
