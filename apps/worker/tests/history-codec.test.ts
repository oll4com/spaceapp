import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { decodeHistory, encodeHistory } from "./trace-contracts/history-codec.js";

const checkoutRoot = "/recording-checkout";
const syntheticRoot = "/synthetic-spaceapp";
const stack = [
  `Error: message includes ${checkoutRoot}/message.ts:1:2`,
  `    at Object.activity (${checkoutRoot}/apps/worker/activity.ts:12:34)`,
  `    at ${checkoutRoot}/apps/worker/harness.ts:56:78`,
  `    at Module.run (file://${checkoutRoot}/apps/worker/entry.ts:90:12)`,
  `    at unrelated (${checkoutRoot}-other/apps/worker/activity.ts:12:34)`,
  "    at dependency (/external/node_modules/activity.ts:12:34)",
].join("\n");
const normalizedStack = stack
  .replace(`(${checkoutRoot}/apps/`, `(${syntheticRoot}/apps/`)
  .replace(`at ${checkoutRoot}/apps/`, `at ${syntheticRoot}/apps/`)
  .replace(`(file://${checkoutRoot}/apps/`, `(file://${syntheticRoot}/apps/`);
const payload = {
  metadata: { encoding: Buffer.from("json/plain").toString("base64") },
  data: Buffer.from(JSON.stringify({
    stackTrace: stack,
    nested: { stackTrace: stack },
    message: `${checkoutRoot}/payload.ts`,
  })).toString("base64"),
};

function exampleHistory() {
  return {
    events: [
      {
        eventId: "1",
        eventTime: "2026-08-20T12:34:56.123456789Z",
        eventType: "EVENT_TYPE_ACTIVITY_TASK_FAILED",
        activityTaskFailedEventAttributes: {
          scheduledEventId: "2",
          startedEventId: "3",
          identity: "synthetic-worker",
          retryState: "RETRY_STATE_NON_RETRYABLE_FAILURE",
          failure: {
            message: `${checkoutRoot}/failure-message.ts`,
            source: "TypeScriptSDK",
            stackTrace: stack,
            applicationFailureInfo: {
              type: "SyntheticFailure",
              nonRetryable: true,
              details: { payloads: [payload] },
            },
            cause: {
              message: "nested cause",
              stackTrace: stack,
              encodedAttributes: payload,
              timeoutFailureInfo: { timeoutType: "TIMEOUT_TYPE_START_TO_CLOSE" },
            },
          },
        },
      },
      {
        eventId: "4",
        eventType: "EVENT_TYPE_CHILD_WORKFLOW_EXECUTION_FAILED",
        childWorkflowExecutionFailedEventAttributes: {
          initiatedEventId: "5",
          startedEventId: "6",
          failure: { message: "child failure", stackTrace: stack },
        },
      },
      {
        eventId: "7",
        eventType: "EVENT_TYPE_WORKFLOW_EXECUTION_FAILED",
        workflowExecutionFailedEventAttributes: {
          failure: { message: "workflow failure", stackTrace: stack },
        },
      },
    ],
  };
}

test("normalizes only exact checkout locations in schema-defined failure stacks", () => {
  const original = exampleHistory();
  const expected = structuredClone(original);
  const activity = expected.events[0]!.activityTaskFailedEventAttributes!.failure;
  activity.stackTrace = normalizedStack;
  activity.cause.stackTrace = normalizedStack;
  expected.events[1]!.childWorkflowExecutionFailedEventAttributes!.failure.stackTrace = normalizedStack;
  expected.events[2]!.workflowExecutionFailedEventAttributes!.failure.stackTrace = normalizedStack;

  const result = JSON.parse(encodeHistory(decodeHistory(original), checkoutRoot));
  expect(result).toEqual(expected);
  expect(result.events[0].activityTaskFailedEventAttributes.failure.applicationFailureInfo.details.payloads[0])
    .toEqual(payload);
  expect(result.events[0].activityTaskFailedEventAttributes.failure.cause.encodedAttributes).toEqual(payload);
});

test("does not mutate the caller's protobuf message and is stable after normalization", () => {
  const history = decodeHistory(exampleHistory());
  const before = structuredClone(history);
  const first = encodeHistory(history, checkoutRoot);

  expect(structuredClone(history)).toEqual(before);
  expect(encodeHistory(decodeHistory(JSON.parse(first)), checkoutRoot)).toBe(first);
});

test("rejects an empty checkout prefix instead of changing arbitrary absolute paths", () => {
  for (const root of ["", "/", "\\"]) {
    expect(() => encodeHistory(decodeHistory(exampleHistory()), root)).toThrow("non-root checkout directory");
  }
});

test("normalizes the current checkout by default, including regex-special directory names", () => {
  const currentRoot = fileURLToPath(new URL("../../../", import.meta.url)).replace(/[/\\]+$/, "");
  const json = exampleHistory();
  json.events[0]!.activityTaskFailedEventAttributes!.failure.stackTrace =
    `Error: synthetic\n    at activity (${currentRoot}/apps/worker/activity.ts:1:2)`;
  const result = JSON.parse(encodeHistory(decodeHistory(json)));
  expect(result.events[0].activityTaskFailedEventAttributes.failure.stackTrace)
    .toBe(`Error: synthetic\n    at activity (${syntheticRoot}/apps/worker/activity.ts:1:2)`);

  const specialRoot = "/recording [candidate]+(1)";
  json.events[0]!.activityTaskFailedEventAttributes!.failure.stackTrace =
    `Error: synthetic\n    at activity (${specialRoot}/apps/worker/activity.ts:1:2)`;
  const specialResult = JSON.parse(encodeHistory(decodeHistory(json), specialRoot));
  expect(specialResult.events[0].activityTaskFailedEventAttributes.failure.stackTrace)
    .toBe(`Error: synthetic\n    at activity (${syntheticRoot}/apps/worker/activity.ts:1:2)`);
});

test("every stored history retains its digest and normalized JSON round-trip", async () => {
  const dir = new URL("./fixtures/workflow-histories/", import.meta.url);
  const manifest = JSON.parse(await readFile(new URL("manifest.json", dir), "utf8")) as {
    file: string;
    sha256: string;
  }[];
  for (const entry of manifest) {
    const text = await readFile(new URL(entry.file, dir), "utf8");
    expect(createHash("sha256").update(text).digest("hex"), entry.file).toBe(entry.sha256);
    expect(encodeHistory(decodeHistory(JSON.parse(text))), entry.file).toBe(text);
  }
});
