import { describe, expect, it } from "vitest";
import {
  lostRunningRunMessage,
  strandedQueuedRunMessage,
  sweepStrandedChatRuns,
  type ChatRunWorkflowState,
  type StrandedChatRunSweepDeps
} from "../src/stranded-chat-runs.js";

type Run = { runId: string; workflowId: string; sessionId: string; responseMessageId: string; status: "QUEUED" | "RUNNING" | "COMPLETED" | "FAILED" };

function fixture(runs: Run[], workflows: Record<string, ChatRunWorkflowState>) {
  const messages = new Map<string, { status: string; content: string }>();
  const sessions = new Map<string, string>(runs.map((run) => [run.sessionId, "RUNNING"]));
  const failures: Array<{ runId: string; message: string }> = [];
  const describes: string[] = [];
  const warnings: string[] = [];
  const compareAndSet = (from: Run["status"]) => async (runId: string, message: string) => {
    const run = runs.find((candidate) => candidate.runId === runId);
    if (!run || run.status !== from) return false;
    run.status = "FAILED";
    failures.push({ runId, message });
    return true;
  };
  const deps: StrandedChatRunSweepDeps = {
    repository: {
      listStaleQueuedRuns: async () => runs.filter((run) => run.status === "QUEUED"),
      listStaleRunningRuns: async () => runs.filter((run) => run.status === "RUNNING"),
      failStrandedRun: compareAndSet("QUEUED"),
      failLostRunningRun: compareAndSet("RUNNING")
    },
    workflowState: async (workflowId) => { describes.push(workflowId); return workflows[workflowId] ?? "NOT_FOUND"; },
    store: {
      updateSpaceAgentMessage: (messageId, input) => { messages.set(messageId, input); },
      getSpaceAgentSession: (sessionId) => (sessions.has(sessionId) ? { status: sessions.get(sessionId)! } : null),
      updateSpaceAgentSession: (sessionId, input) => { sessions.set(sessionId, input.status); }
    },
    warn: (_fields, message) => { warnings.push(message); },
    now: () => "2026-10-11T12:00:00.000Z"
  };
  return { deps, runs, messages, sessions, failures, describes, warnings };
}

const run = (id: string, status: Run["status"]): Run => ({
  runId: `agent_run:${id}`, workflowId: `workflow:${id}`, sessionId: `agent_session:${id}`, responseMessageId: `agent_msg:${id}`, status
});

describe("stranded Chat run sweep", () => {
  it("offers a retry for a QUEUED run whose workflow never started, after the API stopped between persist and start", async () => {
    const f = fixture([run("never-started", "QUEUED")], {});
    expect(await sweepStrandedChatRuns(f.deps)).toEqual({ queuedFailed: ["agent_run:never-started"], runningFailed: [] });
    expect(f.failures).toEqual([{ runId: "agent_run:never-started", message: strandedQueuedRunMessage }]);
    expect(f.messages.get("agent_msg:never-started")).toEqual({ status: "FAILED", content: strandedQueuedRunMessage });
    expect(f.sessions.get("agent_session:never-started")).toBe("READY");
  });

  it("marks a RUNNING run whose workflow ended without an outcome as unknown, without retrying it", async () => {
    // A single-attempt CLI/OpenCode turn whose worker was killed: the activity
    // timed out, the workflow failed and nothing recorded the run's outcome.
    const f = fixture([run("worker-killed", "RUNNING"), run("history-expired", "RUNNING")], {
      "workflow:worker-killed": "CLOSED", "workflow:history-expired": "NOT_FOUND"
    });
    expect(await sweepStrandedChatRuns(f.deps)).toEqual({ queuedFailed: [], runningFailed: ["agent_run:worker-killed", "agent_run:history-expired"] });
    expect(f.failures.map((failure) => failure.message)).toEqual([lostRunningRunMessage, lostRunningRunMessage]);
    expect(lostRunningRunMessage).toMatch(/unknown/);
    expect(f.messages.get("agent_msg:worker-killed")).toEqual({ status: "FAILED", content: lostRunningRunMessage });
    expect(f.sessions.get("agent_session:worker-killed")).toBe("READY");
  });

  it("never touches a run whose workflow Temporal still runs, or when Temporal cannot be asked", async () => {
    const f = fixture([run("queued-live", "QUEUED"), run("running-live", "RUNNING"), run("queued-unreachable", "QUEUED"), run("running-unreachable", "RUNNING")], {
      "workflow:queued-live": "RUNNING", "workflow:running-live": "RUNNING",
      "workflow:queued-unreachable": "UNKNOWN", "workflow:running-unreachable": "UNKNOWN"
    });
    expect(await sweepStrandedChatRuns(f.deps)).toEqual({ queuedFailed: [], runningFailed: [] });
    expect(f.failures).toEqual([]);
    expect(f.messages.size).toBe(0);
    expect([...f.sessions.values()]).toEqual(["RUNNING", "RUNNING", "RUNNING", "RUNNING"]);
    expect(f.describes).toHaveLength(4);
  });

  it("leaves the message and session alone when a worker moved the run on before the compare-and-set", async () => {
    const f = fixture([run("raced", "RUNNING")], { "workflow:raced": "CLOSED" });
    const failLost = f.deps.repository.failLostRunningRun;
    f.deps.repository.failLostRunningRun = async (runId, message) => {
      f.runs[0]!.status = "COMPLETED";
      return failLost(runId, message);
    };
    expect(await sweepStrandedChatRuns(f.deps)).toEqual({ queuedFailed: [], runningFailed: [] });
    expect(f.messages.size).toBe(0);
    expect(f.sessions.get("agent_session:raced")).toBe("RUNNING");
    expect(f.warnings).toEqual([]);
  });
});
