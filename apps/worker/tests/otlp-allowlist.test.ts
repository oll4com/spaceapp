// Worker spans carry identifiers, types, attempts, status, stable error codes
// and durations only. The scenarios seed a prompt, a private file path, and an
// error message with a token and a URL; none of them may reach the collector.
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { outcomeAttributes, workerSpanAttributeAllowlist, workerSpanAttributes } from "../src/otlp-span-attributes.js";
import { captureWorkerLogs } from "../src/worker-log.js";
import { runTracedScenarios, secretMessage, secretPath, secretPrompt } from "./support/otlp-scenarios.js";
import { startFakeCollector, type FakeCollector } from "./support/otlp-temporal.js";

let env: TestWorkflowEnvironment;
let collector: FakeCollector;
/** Restores worker logging; replaced in beforeAll. */
let restoreLogs: () => void = () => undefined;

beforeAll(async () => {
  restoreLogs = captureWorkerLogs(() => undefined);
  env = await TestWorkflowEnvironment.createTimeSkipping();
  collector = await startFakeCollector();
  await runTracedScenarios(env, { collector });
}, 240_000);

afterAll(async () => {
  restoreLogs();
  await collector?.close();
  await env?.teardown();
});

describe("worker span attributes", () => {
  it("exports only allowlisted span attributes", () => {
    const spans = collector.spans();
    expect(spans.length).toBeGreaterThan(10);
    for (const span of spans) {
      for (const attribute of span.attributes) {
        expect(Object.keys(workerSpanAttributeAllowlist), `${span.name} ${attribute.key}`).toContain(attribute.key);
      }
    }
  });

  it("never exports the seeded prompt, path, message, token or URL", () => {
    const raw = collector.bodies.join("\n");
    expect(raw.length).toBeGreaterThan(1_000);
    for (const secret of [secretPrompt, "PROMPT-SEED", secretPath, "notes-SEED", secretMessage, "sk-SEED", "internal.example", "https://", "/home/"]) {
      expect(raw, secret).not.toContain(secret);
    }
  });

  it("drops values that do not match their kind", () => {
    expect(workerSpanAttributes({
      "space.workflow_id": "workflow:ok",
      "space.room_id": secretPath,
      "space.mission_id": "https://internal.example/secret",
      "space.reason_code": secretMessage,
      "space.attempt": 2.5,
      "space.queue_ms": -1,
      "space.duration_ms": 12.6,
      prompt: secretPrompt,
      "space.error_message": "boom"
    })).toEqual({ "space.workflow_id": "workflow:ok", "space.duration_ms": 13 });
    expect(outcomeAttributes("COMPLETED", null)).toEqual({ "space.outcome": "COMPLETED" });
    expect(outcomeAttributes("FAILED", "CODEX_APP_SERVER_TURN_TIMEOUT")).toMatchObject({ "space.outcome": "FAILED", "space.reason_code": "CODEX_APP_SERVER_TURN_TIMEOUT" });
    expect(outcomeAttributes("CANCELLED", "WORKFLOW_CANCELLED")).toMatchObject({ "space.category": "CANCELLED" });
  });
});
