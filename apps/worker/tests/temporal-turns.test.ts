import { afterAll, beforeAll, expect, it } from "vitest";
import { Context } from "@temporalio/activity";
import { ApplicationFailure } from "@temporalio/common";
import { dummyTurnInputSchema } from "@space/contracts";
import { Sandbox } from "./support/temporal-sandbox.js";

let sandbox: Sandbox;
beforeAll(async () => { sandbox = await Sandbox.create(); }, 60_000);
afterAll(async () => { await sandbox?.close(); });

const turn = dummyTurnInputSchema.parse({ roomId: "room:synthetic", paneId: "pane:synthetic", prompt: "Synthetic task", traceId: "trace:synthetic" });

it("runs the real dummy workflow, preserving activity order and retrying a transient failure", async () => {
  const calls: string[] = [];
  const result = { workflowId: "workflow:synthetic", ...turn, status: "COMPLETED", message: "Done" };
  await sandbox.run({
    recordDummyTurnStarted: (input) => { expect(input).toEqual(turn); calls.push(`start:${Context.current().info.attempt}`); },
    recordDummyTurnCompleted: (input) => {
      expect(input).toEqual(turn);
      const attempt = Context.current().info.attempt;
      calls.push(`complete:${attempt}`);
      if (attempt === 1) throw ApplicationFailure.retryable("Synthetic transient failure", "SYNTHETIC_RETRY");
      return result;
    }
  }, async () => {
    expect(await (await sandbox.start("dummyTurnWorkflow", turn)).result()).toEqual(result);
  });
  expect(calls).toEqual(["start:1", "complete:1", "complete:2"]);
}, 30_000);

it.each([
  ["opencode", { providerId: "opencode" }, "runOpenCodeAgentTurn"],
  ["CLI", { providerId: "cli:claude" }, "runCliAgentTurn"],
  ["native", { agentSessionId: "session:synthetic", agentAssistantMessageId: "message:synthetic" }, "runCodexAppServerTurn"],
  ["room agent", { roomAgentMissionId: "mission:synthetic" }, "runCodexAppServerTurn"]
])("routes a real %s turn to its activity with its configured retries", async (_, extra, activityName) => {
  const input = { ...turn, ...extra };
  const attempts: number[] = [];
  const result = { status: "COMPLETED", message: "Synthetic completion" };
  await sandbox.run({
    [activityName]: (received) => {
      expect(received).toEqual(input);
      const attempt = Context.current().info.attempt;
      attempts.push(attempt);
      // OpenCode/CLI intentionally allow only one attempt.
      if (activityName === "runCodexAppServerTurn" && attempt === 1) throw Error("Synthetic transient failure");
      return result;
    }
  }, async () => {
    const handle = await sandbox.start("codexAppServerTurnWorkflow", input);
    expect(await handle.result()).toEqual(result);
    const history = await handle.fetchHistory();
    const scheduled = history.events!.find(event => event.activityTaskScheduledEventAttributes)!.activityTaskScheduledEventAttributes!;
    expect(scheduled.activityType!.name).toBe(activityName);
    expect(scheduled.retryPolicy!.maximumAttempts).toBe(activityName === "runCodexAppServerTurn" ? 5 : 1);
    const timeout = Number(scheduled.startToCloseTimeout!.seconds);
    // The test server caps the native workflow's 100-year activity timeout.
    if ("agentSessionId" in extra) expect(timeout).toBeGreaterThan(86_400);
    else expect(timeout).toBe("providerId" in extra ? extra.providerId === "opencode" ? 2400 : 1800 : 86_400);
  });
  expect(attempts).toEqual(activityName === "runCodexAppServerTurn" ? [1, 2] : [1]);
}, 30_000);
