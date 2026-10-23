/**
 * dummyTurnWorkflow and codexAppServerTurnWorkflow on the real
 * time-skipping test server (issue #60), including activity retry
 * behavior.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ActivityStubs, buildActivities } from "./activity-stubs.js";
import { dummyTurnResult, nativeTurnInput, roomAgentTurnInput } from "./stubs.js";
import { createSandboxEnv, MAIN_TASK_QUEUE, type SandboxEnv } from "./sandbox.js";

const stubs = new ActivityStubs();
let env: SandboxEnv;

beforeAll(async () => {
  env = await createSandboxEnv();
  await env.startWorker(MAIN_TASK_QUEUE, buildActivities(stubs));
}, 120000);

beforeEach(() => stubs.reset());

afterAll(async () => {
  await env.teardown();
}, 60000);

function startWorkflow(name: string, workflowId: string, input: unknown) {
  return env.testEnv.client.workflow.start(name, {
    taskQueue: MAIN_TASK_QUEUE,
    workflowId,
    args: [input]
  });
}

describe("dummyTurnWorkflow", () => {
  it("records the start and the completion of a dummy turn", async () => {
    const input = nativeTurnInput("room-turn-01", "dummy");

    const handle = await startWorkflow("dummyTurnWorkflow", "dummy-turn-test-01", input);
    const result = await handle.result();

    expect(result).toEqual(dummyTurnResult(input));
    expect(stubs.callsOf("recordDummyTurnStarted")[0]).toMatchObject({
      roomId: input.roomId,
      paneId: input.paneId,
      traceId: input.traceId
    });
    expect(stubs.count("recordDummyTurnCompleted")).toBe(1);
  }, 60000);

  it("retries a failing completion activity and finishes on the third attempt", async () => {
    const input = nativeTurnInput("room-turn-01", "retry");
    stubs.override("recordDummyTurnCompleted", (turnInput, index) => {
      if (index < 2) throw new Error("synthetic completion failure");
      return dummyTurnResult(turnInput);
    });

    const handle = await startWorkflow("dummyTurnWorkflow", "dummy-turn-test-02", input);
    const result = await handle.result();

    expect(result.status).toBe("COMPLETED");
    expect(stubs.count("recordDummyTurnCompleted")).toBe(3);
  }, 60000);

  it("fails the turn after exhausting the start-activity retries", async () => {
    const input = nativeTurnInput("room-turn-01", "fail");
    stubs.override("recordDummyTurnStarted", () => {
      throw new Error("synthetic start failure");
    });

    const handle = await startWorkflow("dummyTurnWorkflow", "dummy-turn-test-03", input);

    await expect(handle.result()).rejects.toThrow();
    expect(stubs.count("recordDummyTurnStarted")).toBe(3);
    expect(stubs.count("recordDummyTurnCompleted")).toBe(0);
  }, 60000);
});

describe("codexAppServerTurnWorkflow", () => {
  it("runs a native chat turn through the native activity group", async () => {
    const input = nativeTurnInput("room-turn-02", "native");

    const handle = await startWorkflow("codexAppServerTurnWorkflow", "turn-test-native-01", input);
    const result = await handle.result();

    expect(result.status).toBe("COMPLETED");
    expect(stubs.count("runCodexAppServerTurn")).toBe(1);
    const turnCall = stubs.callsOf("runCodexAppServerTurn")[0];
    expect(turnCall).toMatchObject({ agentSessionId: input.agentSessionId });
    expect(turnCall).not.toHaveProperty("roomAgentMissionId");
    expect(stubs.count("runOpenCodeAgentTurn")).toBe(0);
    expect(stubs.count("runCliAgentTurn")).toBe(0);
  }, 60000);

  it("runs a room-agent mission turn through the room-agent activity group", async () => {
    const input = roomAgentTurnInput("room-turn-02", "mission-0001", "agent");

    const handle = await startWorkflow("codexAppServerTurnWorkflow", "turn-test-room-agent-01", input);
    const result = await handle.result();

    expect(result.status).toBe("COMPLETED");
    expect(result.roomAgentOutcome).toMatchObject({ status: "VERIFIED", executedActionCount: 1 });
    expect(stubs.callsOf("runCodexAppServerTurn")[0]).toMatchObject({
      roomAgentMissionId: "mission-0001"
    });
  }, 60000);

  it("routes opencode provider turns to runOpenCodeAgentTurn", async () => {
    const input = { ...nativeTurnInput("room-turn-02", "opencode"), providerId: "opencode" };

    const handle = await startWorkflow("codexAppServerTurnWorkflow", "turn-test-opencode-01", input);
    const result = await handle.result();

    expect(result.status).toBe("COMPLETED");
    expect(stubs.count("runOpenCodeAgentTurn")).toBe(1);
    expect(stubs.count("runCodexAppServerTurn")).toBe(0);
  }, 60000);

  it("runs CLI provider turns without retries and fails the turn on the first error", async () => {
    const input = { ...nativeTurnInput("room-turn-02", "cli"), providerId: "cli:claude" };
    stubs.override("runCliAgentTurn", () => {
      throw new Error("synthetic CLI failure");
    });

    const handle = await startWorkflow("codexAppServerTurnWorkflow", "turn-test-cli-01", input);

    await expect(handle.result()).rejects.toThrow();
    expect(stubs.count("runCliAgentTurn")).toBe(1);
  }, 60000);

  it("retries a failing room-agent turn activity and completes once it recovers", async () => {
    const input = roomAgentTurnInput("room-turn-02", "mission-0002", "retry");
    stubs.override("runCodexAppServerTurn", (turnInput, index) => {
      if (index < 4) throw new Error("synthetic turn failure");
      return {
        workflowId: "space-turn:" + turnInput.traceId,
        roomId: turnInput.roomId,
        paneId: turnInput.paneId,
        traceId: turnInput.traceId,
        status: "COMPLETED",
        message: "Recovered on the fifth attempt."
      };
    });

    const handle = await startWorkflow("codexAppServerTurnWorkflow", "turn-test-retry-01", input);
    const result = await handle.result();

    expect(result.status).toBe("COMPLETED");
    expect(stubs.count("runCodexAppServerTurn")).toBe(5);
  }, 60000);
});
