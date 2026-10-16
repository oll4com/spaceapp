/**
 * Replay determinism gate.
 *
 * Every history recorded under tests/fixtures/workflow-histories/ is replayed
 * against the current workflow code. If a workflow change alters the command
 * sequence for an existing history, replay fails here instead of stranding
 * in-flight production executions. The only sanctioned way to make a failing
 * replay pass is a replay-safe `patched()` change shipped together with
 * re-recorded histories — see the README in the fixtures directory.
 *
 * The negative test proves the gate bites: the same dot-goal history replayed
 * against a test-only variant with an extra timer must fail with a
 * DeterminismViolationError.
 */
import { describe, expect, it } from "vitest";
import { Worker } from "@temporalio/worker";
import protoPkg from "@temporalio/proto";

const { temporal } = protoPkg as unknown as typeof import("@temporalio/proto");
import { DeterminismViolationError } from "@temporalio/workflow";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const FIXTURES_DIR = fileURLToPath(new URL("./fixtures/workflow-histories", import.meta.url));
const WORKFLOWS_PATH = fileURLToPath(new URL("./temporal-workflows-entry.ts", import.meta.url));
const NONDETERMINISTIC_WORKFLOWS_PATH = fileURLToPath(
  new URL("./support/nondeterministic-workflows.ts", import.meta.url)
);

const REPLAY_TIMEOUT_MS = 300_000;

type ProtoHistory = ReturnType<typeof temporal.api.history.v1.History.fromObject>;

interface RecordedHistory {
  workflowId: string;
  history: ProtoHistory;
}

function loadFixtures(): Array<{ file: string } & RecordedHistory> {
  return readdirSync(FIXTURES_DIR)
    .filter((file) => file.endsWith(".json"))
    .sort()
    .map((file) => {
      const parsed = JSON.parse(readFileSync(`${FIXTURES_DIR}/${file}`, "utf8")) as {
        workflowId: string;
        history: unknown;
      };
      return { file, workflowId: parsed.workflowId, history: temporal.api.history.v1.History.fromObject(parsed.history) };
    });
}

async function replayAll(workflowsPath: string, fixtures: Array<{ file: string } & RecordedHistory>) {
  const results = new Map<string, { workflowId: string; error?: Error }>();
  for await (const result of Worker.runReplayHistories(
    {
      workflowsPath,
      // Same reasoning as the live tests: the workflow bundle is large.
      isolateExecutionTimeout: "60 seconds"
    },
    fixtures.map(({ workflowId, history }) => ({ workflowId, history }))
  )) {
    results.set(result.workflowId, result);
  }
  return fixtures.map((fixture) => ({ fixture, result: results.get(fixture.workflowId) }));
}

describe("workflow history replay gate", () => {
  it("has at least one recorded history per workflow, including the pre-patch supervisor branch", () => {
    const files = readdirSync(FIXTURES_DIR).filter((file) => file.endsWith(".json"));
    for (const prefix of [
      "dot-goal",
      "dummy-turn",
      "codex-turn",
      "room-action",
      "room-supervisor-current",
      "room-supervisor-pre-patch",
      "memory-maintenance",
      "memory-consolidation",
      "memory-mutation"
    ]) {
      expect(files.some((file) => file.startsWith(prefix)), `missing history fixture for ${prefix}`).toBe(true);
    }
  });

  it("replays every recorded history against the current workflow code", async () => {
    const fixtures = loadFixtures();
    expect(fixtures.length).toBeGreaterThan(0);
    const outcomes = await replayAll(WORKFLOWS_PATH, fixtures);
    for (const { fixture, result } of outcomes) {
      expect(result, `no replay result for ${fixture.file}`).toBeDefined();
      expect(
        result?.error,
        `replay of ${fixture.file} (workflow ${fixture.workflowId}) must stay deterministic`
      ).toBeUndefined();
    }
  }, REPLAY_TIMEOUT_MS);

  it("fails replay for a workflow variant that adds a timer (the gate bites)", async () => {
    const fixtures = loadFixtures().filter((fixture) => fixture.file.startsWith("dot-goal"));
    expect(fixtures.length).toBeGreaterThan(0);
    const outcomes = await replayAll(NONDETERMINISTIC_WORKFLOWS_PATH, fixtures.slice(0, 1));
    const [{ fixture, result }] = outcomes;
    expect(result?.error, `replay of ${fixture.file} against the variant must fail`).toBeInstanceOf(
      DeterminismViolationError
    );
  }, REPLAY_TIMEOUT_MS);
});
