import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import workerPkg from "@temporalio/worker";
import protoPkg from "@temporalio/proto";

const { Worker, bundleWorkflowCode } = workerPkg;
const { temporal } = protoPkg;

const THIS_DIR = dirname(fileURLToPath(import.meta.url));
const WORKER_ROOT = resolve(THIS_DIR, "..");
const FIXTURES_DIR = join(THIS_DIR, "fixtures/workflow-histories");

function deserializeFixtureToProtoHistory(raw: { events: Array<Record<string, any>> }) {
  const E = temporal.api.enums.v1.EventType;
  const decodePayloads = (p: any) => {
    if (!p?.payloads) return p;
    return {
      payloads: p.payloads.map((item: any) => ({
        metadata: item.metadata
          ? Object.fromEntries(
              Object.entries(item.metadata).map(([k, v]) => [k, Buffer.from(String(v), "base64")])
            )
          : {},
        data: Buffer.from(String(item.data), "base64")
      }))
    };
  };

  const events = raw.events.map((ev) => {
    const copy: Record<string, any> = {
      eventId: Number(ev.eventId),
      eventTime: ev.eventTime,
      eventType: typeof ev.eventType === "string" ? E[ev.eventType as keyof typeof E] : ev.eventType
    };
    if (ev.workflowExecutionStartedEventAttributes) {
      copy.workflowExecutionStartedEventAttributes = {
        ...ev.workflowExecutionStartedEventAttributes,
        input: decodePayloads(ev.workflowExecutionStartedEventAttributes.input)
      };
    }
    if (ev.workflowTaskScheduledEventAttributes) {
      copy.workflowTaskScheduledEventAttributes = ev.workflowTaskScheduledEventAttributes;
    }
    if (ev.workflowTaskStartedEventAttributes) {
      copy.workflowTaskStartedEventAttributes = ev.workflowTaskStartedEventAttributes;
    }
    if (ev.workflowTaskCompletedEventAttributes) {
      copy.workflowTaskCompletedEventAttributes = ev.workflowTaskCompletedEventAttributes;
    }
    if (ev.markerRecordedEventAttributes) {
      const details: Record<string, any> = {};
      for (const [k, v] of Object.entries(ev.markerRecordedEventAttributes.details || {})) {
        details[k] = decodePayloads(v);
      }
      copy.markerRecordedEventAttributes = {
        ...ev.markerRecordedEventAttributes,
        details
      };
    }
    if (ev.activityTaskScheduledEventAttributes) {
      copy.activityTaskScheduledEventAttributes = {
        ...ev.activityTaskScheduledEventAttributes,
        input: decodePayloads(ev.activityTaskScheduledEventAttributes.input)
      };
    }
    if (ev.activityTaskStartedEventAttributes) {
      copy.activityTaskStartedEventAttributes = ev.activityTaskStartedEventAttributes;
    }
    if (ev.activityTaskCompletedEventAttributes) {
      copy.activityTaskCompletedEventAttributes = {
        ...ev.activityTaskCompletedEventAttributes,
        result: decodePayloads(ev.activityTaskCompletedEventAttributes.result)
      };
    }
    if (ev.timerStartedEventAttributes) {
      copy.timerStartedEventAttributes = ev.timerStartedEventAttributes;
    }
    if (ev.workflowExecutionCompletedEventAttributes) {
      copy.workflowExecutionCompletedEventAttributes = {
        ...ev.workflowExecutionCompletedEventAttributes,
        result: decodePayloads(ev.workflowExecutionCompletedEventAttributes.result)
      };
    }
    return copy;
  });

  return temporal.api.history.v1.History.create({ events });
}

describe("Temporal real V8 sandbox workflow replay determinism gate (#60)", () => {
  const bundles = new Map<string, { code: string }>();

  beforeAll(async () => {
    if (!existsSync(join(WORKER_ROOT, "dist", "workflows.js"))) {
      try {
        execFileSync("npx", ["tsc", "-p", join(WORKER_ROOT, "tsconfig.json")], { stdio: "ignore" });
      } catch {
        // tsc emits the workflow JS files into dist/ even when non-workflow activity type declarations are unbuilt
      }
    }
    for (const name of ["workflows", "memory-maintenance-workflows", "memory-mutation-workflows"]) {
      const workflowsPath = join(WORKER_ROOT, "dist", `${name}.js`);
      const bundle = await bundleWorkflowCode({ workflowsPath });
      bundles.set(name, bundle);
    }
  }, 60_000);

  it("replays all 9 recorded workflow history fixtures (including both current and pre-patch supervisor branches) with zero determinism violations", async () => {
    const files = (await readdir(FIXTURES_DIR)).filter((f) => f.endsWith(".json")).sort();
    expect(files).toEqual([
      "codexAppServerTurnWorkflow.json",
      "dotGoalWorkflow.json",
      "dummyTurnWorkflow.json",
      "memoryConsolidationWorkflow.json",
      "memoryMaintenanceWorkflow.json",
      "memoryMutationWorkflow.json",
      "roomAgentActionWorkflow.json",
      "roomAgentSupervisorWorkflow-current.json",
      "roomAgentSupervisorWorkflow-legacy.json"
    ]);

    const byBundle = new Map<string, Array<{ workflowId: string; history: any }>>();
    for (const file of files) {
      const raw = JSON.parse(await readFile(join(FIXTURES_DIR, file), "utf8"));
      const history = deserializeFixtureToProtoHistory(raw);
      const list = byBundle.get(raw.bundle) ?? [];
      list.push({ workflowId: `${raw.workflowId}:${file}`, history });
      byBundle.set(raw.bundle, list);
    }

    for (const [bundleName, histories] of byBundle.entries()) {
      const workflowBundle = bundles.get(bundleName)!;
      const results = [];
      for await (const res of Worker.runReplayHistories({ workflowBundle }, histories)) {
        if (res.error) {
          throw new Error(`Determinism replay failed for ${res.workflowId} (${bundleName}): ${res.error.message}`);
        }
        results.push(res);
      }
      expect(results).toHaveLength(histories.length);
    }
  }, 60_000);

  it("fails replay with DeterminismViolationError when a workflow history diverges from the workflow code (negative gate check)", async () => {
    const raw = JSON.parse(await readFile(join(FIXTURES_DIR, "dotGoalWorkflow.json"), "utf8"));
    // Mutate event 5 from ACTIVITY_TASK_SCHEDULED (dotGoalStep) into an unexpected TIMER_STARTED
    const mutated = structuredClone(raw);
    mutated.events[4] = {
      eventId: 5,
      eventTime: { seconds: 1700000004, nanos: 0 },
      eventType: "EVENT_TYPE_TIMER_STARTED",
      timerStartedEventAttributes: {
        timerId: "unexpected-sleep",
        workflowTaskCompletedEventId: 4,
        startToFireTimeout: { seconds: 1, nanos: 0 }
      }
    };
    const badHistory = deserializeFixtureToProtoHistory(mutated);
    const workflowBundle = bundles.get("workflows")!;

    await expect(
      Worker.runReplayHistory({ workflowBundle }, badHistory, "replay:dotGoalWorkflow:diverged")
    ).rejects.toThrow(/Nondeterminism error|DeterminismViolationError/i);
  }, 30_000);
});
