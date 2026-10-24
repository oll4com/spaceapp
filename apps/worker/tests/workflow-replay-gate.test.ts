import { beforeAll, describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Worker, DeterminismViolationError } from "@temporalio/worker";
import { temporal } from "@temporalio/proto";

const FIXTURE_DIR = new URL("./fixtures/workflow-histories/", import.meta.url).pathname;
const WORKFLOWS_PATH = new URL("../src/workflows.ts", import.meta.url).pathname;
const PRE_PATCH_PATH = new URL("./support/pre-patch-workflows.ts", import.meta.url).pathname;
const MAINTENANCE_PATH = new URL("../src/memory-maintenance-workflows.ts", import.meta.url).pathname;
const MUTATION_PATH = new URL("../src/memory-mutation-workflows.ts", import.meta.url).pathname;
const PROBE_PATH = new URL("./support/determinism-probe-workflows.ts", import.meta.url).pathname;
const DRIFTED_PROBE_PATH = new URL("./support/determinism-probe-drifted-workflows.ts", import.meta.url).pathname;

type AnyRecord = Record<string, any>;

/**
 * Fixture loader: parse the recorded `{workflowId, history: {events}}` JSON into
 * a proto History via History.fromObject. (historyFromJSON is not used: this
 * tree resolves two protobufjs majors, and fromObject on the message class is
 * the reliable path.)
 */
function loadFixture(name: string): { workflowId: string; workflowType: string; history: AnyRecord } {
  const raw = JSON.parse(readFileSync(join(FIXTURE_DIR, name), "utf8")) as AnyRecord;
  const history = temporal.api.history.v1.History.fromObject(raw.history);
  const firstEvent = (raw.history?.events ?? [])[0] as AnyRecord | undefined;
  const workflowType = String(
    firstEvent?.workflowExecutionStartedEventAttributes?.workflowType?.name ?? "unknownWorkflow"
  );
  return { workflowId: String(raw.workflowId ?? `replay:${name}`), workflowType, history };
}

async function replayAll(workflowsPath: string, names: string[]): Promise<number> {
  const loaded = names.map((name) => ({ name, ref: loadFixture(name) }));
  const metaByWorkflowId = new Map(
    loaded.map(({ name, ref }) => [ref.workflowId, { name, workflowType: ref.workflowType }])
  );
  let count = 0;
  for await (const result of Worker.runReplayHistories(
    { workflowsPath, isolateExecutionTimeout: "30 seconds" } as never,
    loaded.map((entry) => entry.ref) as never
  )) {
    // ReplayResult carries its failure in `error` - rethrow naming the workflow and history file.
    const err = (result as { error?: Error }).error;
    if (err) {
      const meta = metaByWorkflowId.get(result.workflowId);
      const fixture = meta?.name ?? "unknown-fixture.json";
      const wfType = meta?.workflowType ?? "unknownWorkflow";
      err.message = `[workflow=${wfType} history=${fixture} workflowId=${result.workflowId}] ${err.message}`;
      throw err;
    }
    count += 1;
  }
  return count;
}

describe("replay determinism gate over recorded histories", () => {
  let fixtureNames: string[];

  beforeAll(() => {
    fixtureNames = readdirSync(FIXTURE_DIR).filter((n) => n.endsWith(".json"));
  });

  it("ships the full fixture set", () => {
    expect(fixtureNames.length).toBeGreaterThanOrEqual(11);
  });

  it("loads every fixture as a proto History with events", () => {
    for (const name of fixtureNames) {
      const { history } = loadFixture(name);
      expect(history.events.length, name).toBeGreaterThan(0);
    }
  });

  it("replays the current-workflow histories without nondeterminism", async () => {
    const count = await replayAll(WORKFLOWS_PATH, [
      "dummy-turn.json",
      "codex-app-server-turn.json",
      "dot-goal.json",
      "dot-goal-continue-as-new.json",
      "room-agent-supervisor.json",
      "room-agent-action.json"
    ]);
    expect(count).toBe(6); // the gate must never swallow replay failures
  }, 60_000);

  it("replays the pre-patch history against the patched module (marker-less legacy branch)", async () => {
    const count = await replayAll(WORKFLOWS_PATH, ["room-agent-supervisor-pre-patch.json"]);
    expect(count).toBe(1);
  }, 60_000);

  it("replays the pre-patch history against the pre-patch module", async () => {
    const count = await replayAll(PRE_PATCH_PATH, ["room-agent-supervisor-pre-patch.json"]);
    expect(count).toBe(1);
  }, 60_000);

  it("replays the memory histories against their own modules", async () => {
    const maintenance = await replayAll(MAINTENANCE_PATH, ["memory-maintenance.json", "memory-consolidation.json"]);
    expect(maintenance).toBe(2);
    const mutation = await replayAll(MUTATION_PATH, ["memory-mutation.json"]);
    expect(mutation).toBe(1);
  }, 60_000);

  it("rejects a drifted determinism probe with DeterminismViolationError", async () => {
    const clean = await replayAll(PROBE_PATH, ["determinism-probe.json"]);
    expect(clean).toBe(1); // sanity: the recorded probe replays clean
    await expect(replayAll(DRIFTED_PROBE_PATH, ["determinism-probe.json"])).rejects.toSatisfy((err: unknown) => {
      expect((err as Error).name).toBe("DeterminismViolationError");
      expect((err as Error).message).toMatch(/workflow=determinismProbeWorkflow history=determinism-probe\.json/);
      return true;
    });
  }, 60_000);
});
