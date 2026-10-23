/**
 * Sandbox tests for dummyTurnWorkflow and codexAppServerTurnWorkflow on a
 * real time-skipping test server. Covers the full dummy flow, all four
 * provider branches of the turn router, and activity retry behavior.
 */
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { cliChatTurnDefaultRuntimeIds } from "@space/contracts";
import { isCliChatTurnProviderId, isNativeChatTurn } from "../src/turn-runtime-policy.js";
import {
  createTemporalTestEnv,
  testWorkflowsPath,
  TEST_MAIN_TASK_QUEUE,
  type TemporalTestEnv
} from "./support/temporal-test-env.js";
import { createWorkflowStubs, type WorkflowStubs } from "./support/workflow-stubs.js";

let tenv: TemporalTestEnv;
let stubs: WorkflowStubs;

beforeAll(async () => {
  stubs = createWorkflowStubs();
  tenv = await createTemporalTestEnv(testWorkflowsPath(), stubs.activities);
}, 240_000);

afterAll(async () => {
  await tenv.teardown();
}, 120_000);

beforeEach(() => {
  stubs.reset();
  stubs.clearCalls();
});

const baseTurn = (traceId: string) => ({
  roomId: "room:turn-test",
  paneId: "pane:turn-test",
  prompt: "Run the turn.",
  traceId
});

async function runTurn(input: Record<string, unknown>, workflowId: string) {
  const handle = await tenv.client.workflow.start("codexAppServerTurnWorkflow", {
    taskQueue: TEST_MAIN_TASK_QUEUE,
    workflowId,
    args: [input]
  });
  return handle.result();
}

it("runs the dummy turn start -> complete flow", async () => {
  const handle = await tenv.client.workflow.start("dummyTurnWorkflow", {
    taskQueue: TEST_MAIN_TASK_QUEUE,
    workflowId: "dummy-turn-test",
    args: [baseTurn("trace:dummy-1")]
  });
  const result = await handle.result();
  expect(result).toMatchObject({ roomId: "room:turn-test", paneId: "pane:turn-test", status: "COMPLETED" });
  expect(stubs.callCount("recordDummyTurnStarted")).toBe(1);
  expect(stubs.callCount("recordDummyTurnCompleted")).toBe(1);
  expect(stubs.lastCall("recordDummyTurnCompleted")![0]).toMatchObject({ traceId: "trace:dummy-1" });
}, 120_000);

it('routes providerId "opencode" to runOpenCodeAgentTurn', async () => {
  const result = await runTurn({ ...baseTurn("trace:opencode-1"), providerId: "opencode" }, "turn-opencode-test");
  expect(result.status).toBe("COMPLETED");
  expect(stubs.callCount("runOpenCodeAgentTurn")).toBe(1);
  expect(stubs.callCount("runCliAgentTurn")).toBe(0);
  expect(stubs.callCount("runCodexAppServerTurn")).toBe(0);
}, 120_000);

it("routes CLI provider ids to runCliAgentTurn", async () => {
  const providerId = cliChatTurnDefaultRuntimeIds[0]!;
  expect(isCliChatTurnProviderId(providerId)).toBe(true);
  const result = await runTurn({ ...baseTurn("trace:cli-1"), providerId }, "turn-cli-test");
  expect(result.status).toBe("COMPLETED");
  expect(stubs.callCount("runCliAgentTurn")).toBe(1);
  expect(stubs.callCount("runOpenCodeAgentTurn")).toBe(0);
  expect(stubs.callCount("runCodexAppServerTurn")).toBe(0);
}, 120_000);

it("routes native chat turns to runCodexAppServerTurn (native proxy)", async () => {
  const input = {
    ...baseTurn("trace:native-1"),
    agentSessionId: "session:native-1",
    agentAssistantMessageId: "agent_msg:native-1"
  };
  expect(isNativeChatTurn(input as never)).toBe(true);
  const result = await runTurn(input, "turn-native-test");
  expect(result.status).toBe("COMPLETED");
  expect(stubs.callCount("runCodexAppServerTurn")).toBe(1);
  expect(stubs.callCount("runOpenCodeAgentTurn")).toBe(0);
  expect(stubs.callCount("runCliAgentTurn")).toBe(0);
}, 120_000);

it("routes default turns to runCodexAppServerTurn (room-agent proxy)", async () => {
  const input = { ...baseTurn("trace:default-1"), providerId: null };
  expect(isNativeChatTurn(input as never)).toBe(false);
  expect(isCliChatTurnProviderId(input.providerId)).toBe(false);
  const result = await runTurn(input, "turn-default-test");
  expect(result.status).toBe("COMPLETED");
  expect(stubs.callCount("runCodexAppServerTurn")).toBe(1);
  expect(stubs.callCount("runOpenCodeAgentTurn")).toBe(0);
  expect(stubs.callCount("runCliAgentTurn")).toBe(0);
}, 120_000);

it("retries a failing turn activity and succeeds once it recovers", async () => {
  let attempts = 0;
  stubs.set("runCodexAppServerTurn", (input: { roomId: string; paneId: string; traceId: string }) => {
    attempts += 1;
    if (attempts <= 2) throw new Error(`transient turn failure ${attempts}`);
    return {
      workflowId: `turn:${input.traceId}`,
      roomId: input.roomId,
      paneId: input.paneId,
      traceId: input.traceId,
      status: "COMPLETED",
      message: "recovered"
    };
  });
  // Default branch uses the room-agent proxy with 5 max attempts.
  const result = await runTurn({ ...baseTurn("trace:retry-1"), providerId: null }, "turn-retry-test");
  expect(result.status).toBe("COMPLETED");
  expect(stubs.callCount("runCodexAppServerTurn")).toBe(3);
}, 180_000);

it("fails the workflow after the turn activity exhausts its retries", async () => {
  stubs.set("runCodexAppServerTurn", () => {
    throw new Error("persistent turn failure");
  });
  const error = await runTurn({ ...baseTurn("trace:retry-2"), providerId: null }, "turn-retry-exhausted-test").then(
    () => null,
    (e: unknown) => e as Error & { cause?: unknown }
  );
  expect(error).not.toBeNull();
  // The activity error surfaces nested in the workflow failure cause chain.
  const chain: string[] = [];
  for (let current: unknown = error; current instanceof Error; current = (current as { cause?: unknown }).cause) {
    chain.push(current.message);
  }
  expect(chain.join("\n")).toMatch(/persistent turn failure/);
  // Room-agent turn proxy: ROOM_AGENT_TURN_ACTIVITY_MAX_ATTEMPTS = 5.
  expect(stubs.callCount("runCodexAppServerTurn")).toBe(5);
}, 180_000);
