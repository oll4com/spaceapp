import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { TestWorkflowEnvironment } from "@temporalio/testing";
import { ApplicationFailure } from "@temporalio/activity";
import {
  ActivityRecorder,
  createTimeSkippingEnvironment,
  createSandboxWorker,
  stopSandboxWorker,
  turnResult
} from "./support/workflow-sandbox-kit.js";

const QUEUE = "test-turns";
const WORKFLOWS_PATH = new URL("../src/workflows.ts", import.meta.url).pathname;

type AnyRecord = Record<string, any>;

const expectCauseMessage = (error: unknown, pattern: RegExp): void => {
  const seen: string[] = [];
  let current: unknown = error;
  for (let i = 0; i < 8 && current; i++) {
    const c = current as AnyRecord;
    const text = [c.message, c.type, c.name].filter((x) => typeof x === "string" && x.length).join(" | ");
    if (text) seen.push(text);
    if (pattern.test(text)) return;
    current = c.cause;
  }
  throw new Error(`expected cause matching ${pattern}, saw: ${seen.join(" -> ")}`);
};

const baseInput = (overrides: Record<string, unknown> = {}) => ({
  roomId: "room:test",
  paneId: "pane:test",
  prompt: "Run it.",
  artifactIds: [],
  agentRunId: "agent-run-1",
  permissionMode: null,
  collaborationMode: "default",
  traceId: "trace-run-1",
  ...overrides
});

describe("real sandbox: turn workflows", () => {
  let env: TestWorkflowEnvironment;
  const rec = new ActivityRecorder({
    recordDummyTurnStarted: () => ({ workflowId: "wf:dummy" }),
    recordDummyTurnCompleted: () => ({ ok: true }),
    runCodexAppServerTurn: () => turnResult({ message: "turn done" }) as never,
    runOpenCodeAgentTurn: () => turnResult({ message: "opencode done" }) as never,
    runCliAgentTurn: () => turnResult({ message: "cli done" }) as never,
    runRoomAgentBackgroundAction: () => ({ ok: true }),
    failRoomAgentBackgroundAction: () => undefined
  });

  let workerBundle: { worker: unknown; running: Promise<void> } | undefined;

  beforeAll(async () => {
    env = await createTimeSkippingEnvironment();
    workerBundle = await createSandboxWorker(env, { taskQueue: QUEUE, workflowsPath: WORKFLOWS_PATH, activities: rec.acts });
  }, 60_000);

  afterAll(async () => {
    await stopSandboxWorker(workerBundle as never);
    await env?.teardown();
  }, 40_000);

  afterEach(() => {
    rec.restoreDefaults();
  });

  it("dummyTurnWorkflow books the turn in and out", async () => {
    const before = rec.count("recordDummyTurnStarted");
    const beforeDone = rec.count("recordDummyTurnCompleted");
    const result = await env.client.workflow.execute("dummyTurnWorkflow", {
      workflowId: "wf:test-dummy-happy", taskQueue: QUEUE, args: [baseInput()]
    });
    expect(rec.count("recordDummyTurnStarted") - before).toBe(1);
    expect(rec.count("recordDummyTurnCompleted") - beforeDone).toBe(1);
    expect(result).toEqual({ ok: true });
  }, 30_000);

  it("codexAppServerTurnWorkflow native-chat branch runs runCodexAppServerTurn (no-retry proxy)", async () => {
    const before = rec.count("runCodexAppServerTurn");
    const result = await env.client.workflow.execute("codexAppServerTurnWorkflow", {
      workflowId: "wf:test-turn-native", taskQueue: QUEUE,
      args: [baseInput({ agentSessionId: "session-1", agentAssistantMessageId: "assist-1" })]
    });
    expect(rec.count("runCodexAppServerTurn") - before).toBe(1);
    expect(rec.count("runOpenCodeAgentTurn")).toBe(0);
    expect(rec.count("runCliAgentTurn")).toBe(0);
    expect(result).toMatchObject({ message: "turn done" });
  }, 30_000);

  it("codexAppServerTurnWorkflow routes providerId=opencode to runOpenCodeAgentTurn", async () => {
    const before = rec.count("runOpenCodeAgentTurn");
    await env.client.workflow.execute("codexAppServerTurnWorkflow", {
      workflowId: "wf:test-turn-opencode", taskQueue: QUEUE, args: [baseInput({ providerId: "opencode" })]
    });
    expect(rec.count("runOpenCodeAgentTurn") - before).toBe(1);
    expect(rec.count("runCodexAppServerTurn")).toBe(0);
  }, 30_000);

  it("codexAppServerTurnWorkflow routes cli runtime ids to runCliAgentTurn", async () => {
    const before = rec.count("runCliAgentTurn");
    await env.client.workflow.execute("codexAppServerTurnWorkflow", {
      workflowId: "wf:test-turn-cli", taskQueue: QUEUE, args: [baseInput({ providerId: "cli:claude" })]
    });
    expect(rec.count("runCliAgentTurn") - before).toBe(1);
    expect(rec.count("runCodexAppServerTurn")).toBe(0);
  }, 30_000);

  it("native-chat branch runs runCodexAppServerTurn with the no-retry proxy (1 attempt on failure)", async () => {
    const before = rec.count("runCodexAppServerTurn");
    rec.impl.runCodexAppServerTurn = () => {
      throw ApplicationFailure.nonRetryable("native turn exploded", "NATIVE_TURN_EXPLODED");
    };
    await env.client.workflow.execute("codexAppServerTurnWorkflow", {
      workflowId: "wf:test-turn-native-fail", taskQueue: QUEUE,
      args: [baseInput({ agentSessionId: "session-1", agentAssistantMessageId: "assist-1" })]
    }).then(
      () => { throw new Error("expected failure"); },
      (error) => expectCauseMessage(error, /native turn exploded|NATIVE_TURN_EXPLODED/)
    );
    expect(rec.count("runCodexAppServerTurn") - before).toBe(1); // maximumAttempts: 1
  }, 30_000);

  it("room-agent branch uses the retrying proxy (retries before succeeding)", async () => {
    let attempts = 0;
    rec.impl.runCodexAppServerTurn = () => {
      attempts += 1;
      if (attempts < 3) throw ApplicationFailure.retryable(`attempt ${attempts} failed`, "ATTEMPT_FAILED");
      return turnResult({ message: "turn done" });
    };
    const result = await env.client.workflow.execute("codexAppServerTurnWorkflow", {
      workflowId: "wf:test-turn-roomagent-retry", taskQueue: QUEUE,
      args: [baseInput({ roomAgentMissionId: "mission:retry" })]
    });
    expect(attempts).toBe(3); // maximumAttempts: 5 lets it retry; the native proxy would stop at 1
    expect(result).toMatchObject({ message: "turn done" });
  }, 30_000);

  it("recordDummyTurnStarted exhausts its retry policy and the workflow fails", async () => {
    const before = rec.count("recordDummyTurnStarted");
    rec.impl.recordDummyTurnStarted = () => {
      throw ApplicationFailure.retryable("bookend is down", "BOOKEND_DOWN"); // retryable: exercise maximumAttempts=3
    };
    await env.client.workflow.execute("dummyTurnWorkflow", {
      workflowId: "wf:test-dummy-exhaust", taskQueue: QUEUE, args: [baseInput()]
    }).then(
      () => { throw new Error("expected failure"); },
      (error) => expectCauseMessage(error, /bookend is down|BOOKEND_DOWN/)
    );
    expect(rec.count("recordDummyTurnStarted") - before).toBe(3); // maximumAttempts 3
  }, 30_000);
});
