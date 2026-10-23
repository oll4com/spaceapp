/**
 * Replay determinism gate for all Temporal workflows.
 *
 * Replays the recorded histories in tests/fixtures/workflow-histories/
 * against the current workflow code (via the replay bundle, which maps the
 * pre-patch supervisor history to the current dispatcher). Any replay that
 * throws fails the suite: workflow code must stay deterministic with respect
 * to every recorded history.
 *
 * The negative control replays the dot-goal history against a bundle whose
 * dotGoalWorkflow sleeps an extra minute first; that MUST throw
 * DeterminismViolationError, proving the gate actually detects
 * nondeterministic changes.
 *
 * Note: DeterminismViolationError is exported from @temporalio/workflow in
 * SDK 1.24.0 (not from @temporalio/worker); the replay machinery throws that
 * same class.
 */
import { readdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { Worker } from "@temporalio/worker";
import { DeterminismViolationError } from "@temporalio/workflow";
import {
  replayVariantWorkflowsPath,
  replayWorkflowsPath,
  workflowBundlerOptions
} from "./support/temporal-test-env.js";

const historiesDir = fileURLToPath(new URL("./fixtures/workflow-histories/", import.meta.url));

// The installed tree has several nested copies of protobufjs, so
// @temporalio/common's historyFromJSON is broken here: its `instanceof Type`
// check fails because the History type was built from a different copy's
// Type class. Work around it by converting with the same protobufjs copy
// that @temporalio/proto used to build its types.
function historyFromJSON(history: any): unknown {
  // Resolve protobufjs relative to @temporalio/proto so we always get the
  // same copy its types were built from, whether npm nests it or hoists it.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const protoRequire = createRequire(require.resolve("@temporalio/proto/package.json"));
  const protojson = protoRequire("protobufjs/ext/protojson") as {
    fromJson: (type: unknown, json: unknown, options: unknown) => unknown;
  };
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const proto = require("@temporalio/proto") as any;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { patchProtobufRoot } = require("@temporalio/proto/lib/patch-protobuf-root") as {
    patchProtobufRoot: (p: any) => { lookupType: (name: string) => unknown };
  };
  const historyType = patchProtobufRoot(proto).lookupType("temporal.api.history.v1.History");

  const pascalCaseToConstantCase = (s: string): string =>
    s.replace(/[^\b][A-Z]/g, (m) => `${m[0]}_${m[1]}`).toUpperCase();
  const fixEnumValue = (obj: any, attr: string, prefix: string): any =>
    obj[attr] && {
      [attr]: obj[attr].startsWith(prefix) ? obj[attr] : `${prefix}_${pascalCaseToConstantCase(obj[attr])}`
    };
  // history.toJSON() emits Timestamps/Durations as {seconds, nanos} objects;
  // protojson wants strings. Convert recursively by field-name heuristics.
  const isTimeLike = (key: string): boolean =>
    key === "eventTime" || key === "closeTime" || key === "startTime" || key.endsWith("Time");
  const isDurationLike = (key: string): boolean =>
    key.endsWith("Timeout") ||
    key.endsWith("timeout") ||
    key.endsWith("Interval") ||
    key.endsWith("interval") ||
    key.endsWith("Backoff") ||
    key.endsWith("backoff") ||
    key === "backoffInterval";
  const fixTimestampsDurations = (key: string, value: any): any => {
    if (Array.isArray(value)) return value.map((v) => fixTimestampsDurations(key, v));
    if (value && typeof value === "object") {
      // Empty object where a Timestamp/Duration is expected: omit it.
      if (Object.keys(value).length === 0 && (isTimeLike(key) || isDurationLike(key))) {
        return undefined;
      }
      if (typeof value.seconds !== "undefined" && (isTimeLike(key) || isDurationLike(key))) {
        const seconds = value.seconds;
        const nanos = Number(value.nanos ?? 0);
        if (isTimeLike(key)) {
          const millis = Number(seconds) * 1000 + Math.floor(nanos / 1e6);
          return new Date(millis).toISOString();
        }
        // Duration: "123s" or "123.456s"
        return nanos === 0 ? `${seconds}s` : `${seconds}.${String(nanos).padStart(9, "0").replace(/0+$/, "")}s`;
      }
      const out: any = {};
      for (const [k, v] of Object.entries(value)) {
        const fixed = fixTimestampsDurations(k, v);
        if (fixed !== undefined) out[k] = fixed;
      }
      return out;
    }
    return value;
  };
  const fixHistoryEvent = (e: any): any => {
    const type = Object.keys(e).find((k) => k.endsWith("EventAttributes"));
    if (!type) throw new TypeError(`Missing attributes in history event: ${JSON.stringify(e)}`);
    const fixed = fixTimestampsDurations("", e);
    return {
      ...fixed,
      ...fixEnumValue(fixed, "eventType", "EVENT_TYPE"),
      [type]: {
        ...fixed[type],
        ...(fixed[type].taskQueue && {
          taskQueue: { ...fixed[type].taskQueue, ...fixEnumValue(fixed[type].taskQueue, "kind", "TASK_QUEUE_KIND") }
        }),
        ...fixEnumValue(fixed[type], "parentClosePolicy", "PARENT_CLOSE_POLICY"),
        ...fixEnumValue(fixed[type], "workflowIdReusePolicy", "WORKFLOW_ID_REUSE_POLICY"),
        ...fixEnumValue(fixed[type], "initiator", "CONTINUE_AS_NEW_INITIATOR"),
        ...fixEnumValue(fixed[type], "retryState", "RETRY_STATE")
      }
    };
  };
  if (typeof history !== "object" || history == null || !Array.isArray(history.events)) {
    throw new TypeError("Invalid history, expected an object with an array of events");
  }
  const fixed = { events: history.events.map(fixHistoryEvent) };
  const loaded = protojson.fromJson(historyType, fixed, { ignoreUnknownFields: true });
  if (loaded === null) throw new TypeError("Invalid history");
  return loaded;
}

async function historyFiles(): Promise<string[]> {
  let entries: string[] = [];
  try {
    entries = await readdir(historiesDir);
  } catch {
    entries = [];
  }
  return entries.filter((entry) => entry.endsWith(".json")).sort();
}

async function loadHistory(file: string): Promise<unknown> {
  const json = JSON.parse(await readFile(join(historiesDir, file), "utf8"));
  return historyFromJSON(json);
}

it("replays every recorded workflow history without a determinism violation", async () => {
  const files = await historyFiles();
  expect(
    files,
    "No recorded histories found. Run `npm run temporal:record-histories -w @space/worker` to record them."
  ).toHaveLength(9);
  for (const file of files) {
    const history = await loadHistory(file);
    await Worker.runReplayHistory(
      { workflowsPath: replayWorkflowsPath(), bundlerOptions: workflowBundlerOptions() },
      history as any,
      file.replace(/\.json$/, "")
    );
  }
}, 300_000);

it("rejects replay with DeterminismViolationError when workflow code changes", async () => {
  const history = await loadHistory("dot-goal.json");
  await expect(
    Worker.runReplayHistory(
      { workflowsPath: replayVariantWorkflowsPath(), bundlerOptions: workflowBundlerOptions() },
      history as any,
      "dot-goal"
    )
  ).rejects.toBeInstanceOf(DeterminismViolationError);
}, 300_000);
