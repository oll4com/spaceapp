import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
  buildCodexAppServerProcessEnv,
  runCodexAppServerStdioTurnSession,
  type CodexAppServerStdioProcess
} from "../src/index.js";

const threadId = "thread:goal-completion";
const objective = "Finish both steps and deliver the final answer";

class GoalCompletionProcess extends EventEmitter implements CodexAppServerStdioProcess {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly methods: string[] = [];
  killed = false;
  ready = false;
  finishDuringRecoveryRead = false;
  omitActiveSnapshot = false;
  completedSnapshotWithHeartbeat = false;
  currentFinished = false;
  omitFinalItem = false;
  snapshotTurnId = "turn:two";
  phasedSnapshot = false;
  advanceOnFinalRead = false;
  readonly stdin = { write: (chunk: string) => {
    for (const line of chunk.trim().split("\n")) {
      const request = JSON.parse(line);
      this.methods.push(request.method);
      if (request.id === undefined) continue;
      let result: unknown = {};
      switch (request.method) {
        case "initialize": result = { userAgent: "goal-order-test" }; break;
        case "configRequirements/read": result = { requirements: null }; break;
        case "thread/start": case "thread/resume": result = { thread: { id: threadId } }; break;
        case "thread/goal/get": result = { goal: this.recover ? this.goal("complete") : null }; break;
        case "thread/read":
          result = { thread: { id: threadId, turns: [
            { id: "turn:one", status: "completed", items: [{ type: "agentMessage", text: "First step completed" }] },
            ...(this.omitActiveSnapshot ? [] : [
              { id: this.snapshotTurnId, status: this.completedSnapshotWithHeartbeat || this.currentFinished ? "completed" : "inProgress",
                items: [
                  ...(this.phasedSnapshot ? [{ type: "agentMessage", phase: "commentary", text: "Preparing the answer" }] : []),
                  { type: "agentMessage", ...(this.phasedSnapshot ? { phase: "final_answer" } : {}),
                    text: this.completedSnapshotWithHeartbeat || this.currentFinished
                      ? "FINAL ANSWER: both steps completed" : "Preparing the final answer" }
                ] }
            ]),
            ...(this.advanceOnFinalRead && this.currentFinished ? [{ id: "turn:newer", status: "completed",
              items: [{ type: "agentMessage", text: "A different turn's result" }] }] : [])
          ] } };
          if (this.advanceOnFinalRead && this.currentFinished) {
            this.notice("turn/started", { turn: { id: "turn:newer", status: "inProgress" } });
            this.notice("item/completed", { turnId: "turn:newer", item: { type: "agentMessage", text: "A different turn's result" } });
            this.notice("turn/completed", { turn: { id: "turn:newer", status: "completed" } });
          }
          if (this.finishDuringRecoveryRead) {
            this.notice("turn/started", { turn: { id: "turn:two", status: "inProgress" } });
            this.finishCurrentTurn();
          }
          if (this.completedSnapshotWithHeartbeat) this.notice("thread/tokenUsage/updated", {});
          break;
        case "thread/goal/set": result = { goal: this.goal("active") }; break;
      }
      this.send({ id: request.id, result });
      if (request.method === "thread/goal/set") this.begin();
      if (request.method === "thread/goal/get" && this.completedSnapshotWithHeartbeat) this.begin();
      if (request.method === "thread/read" && this.recover) queueMicrotask(() => { this.ready = true; });
    }
    return true;
  } };

  constructor(readonly recover = false) { super(); }
  kill() { this.killed = true; return true; }
  private goal(status: string) { return { threadId, objective, status, tokenBudget: null,
    tokensUsed: 0, timeUsedSeconds: 0, createdAt: 1, updatedAt: 2 }; }
  private send(value: unknown) { queueMicrotask(() => this.stdout.emit("data", JSON.stringify(value) + "\n")); }
  private notice(method: string, params: Record<string, unknown>) { this.send({ method, params: { threadId, ...params } }); }

  private begin() {
    this.notice("turn/started", { turn: { id: "turn:one", status: "inProgress" } });
    this.notice("item/completed", { turnId: "turn:one", item: { type: "agentMessage", text: "First step completed" } });
    this.notice("turn/completed", { turn: { id: "turn:one", status: "completed" } });
    this.notice("turn/started", { turn: { id: "turn:two", status: "inProgress" } });
    this.notice("item/completed", { turnId: "turn:two", item: { type: "agentMessage", text: "Preparing the final answer" } });
    queueMicrotask(() => { this.ready = true; });
  }

  terminalGoal(turnId?: string, otherThread = false, status = "complete") {
    this.notice("thread/goal/updated", {
      ...(otherThread ? { threadId: "thread:unrelated" } : {}),
      ...(turnId ? { turnId } : {}), goal: this.goal(status)
    });
  }

  finishCurrentTurn() {
    this.currentFinished = true;
    if (!this.omitFinalItem) this.notice("item/completed", { turnId: "turn:two", item: { type: "agentMessage", text: "FINAL ANSWER: both steps completed" } });
    this.notice("turn/completed", { turn: { id: "turn:two", status: "completed" } });
  }

  replayPreviousTurn(includeStart = false) {
    if (includeStart) this.notice("turn/started", { turn: { id: "turn:one", status: "inProgress" } });
    this.notice("item/completed", { turnId: "turn:one", item: { type: "agentMessage", text: "STALE first step" } });
    this.notice("turn/completed", { turn: { id: "turn:one", status: "completed" } });
  }
}

function start(fake: GoalCompletionProcess) {
  const running = runCodexAppServerStdioTurnSession({
    command: "codex", prompt: objective, goalObjective: objective,
    ...(fake.recover ? { threadId } : {}),
    timeoutMs: 2_000, goalProgressGraceMs: 1_000,
    env: buildCodexAppServerProcessEnv({ baseEnv: {}, codexHome: "/tmp/goal-completion-test", credential: null }),
    spawnProcess: () => fake
  });
  void running.catch(() => {});
  return running;
}

const drain = () => new Promise<void>(resolve => setImmediate(resolve));

describe("Goal completion waits for the current turn", () => {
  it("keeps the completed turn identity when a newer turn arrives during the final read", async () => {
    const fake = new GoalCompletionProcess();
    fake.advanceOnFinalRead = true;
    const running = start(fake);
    try {
      await vi.waitFor(() => expect(fake.ready).toBe(true));
      fake.terminalGoal();
      fake.finishCurrentTurn();
      expect(await running).toMatchObject({ turnId: "turn:two", agentMessageText: "FINAL ANSWER: both steps completed" });
    } finally {
      fake.finishCurrentTurn(); fake.terminalGoal("turn:two"); await running.catch(() => {});
    }
  });

  it.each([false, true])("reads the completed turn before closing when its final item notification is missing (phased: %s)", async phasedSnapshot => {
    const fake = new GoalCompletionProcess();
    fake.omitFinalItem = true;
    fake.phasedSnapshot = phasedSnapshot;
    const running = start(fake);
    try {
      await vi.waitFor(() => expect(fake.ready).toBe(true));
      fake.terminalGoal();
      fake.finishCurrentTurn();
      expect(await running).toMatchObject({ turnId: "turn:two", agentMessageText: "FINAL ANSWER: both steps completed" });
      expect(fake.methods.filter(method => method === "thread/read")).toHaveLength(1);
      expect(fake.methods).not.toContain("turn/start");
    } finally {
      fake.finishCurrentTurn(); fake.terminalGoal("turn:two"); await running.catch(() => {});
    }
  });

  it("does not use a different turn's persisted answer", async () => {
    const fake = new GoalCompletionProcess();
    fake.omitFinalItem = true;
    fake.snapshotTurnId = "turn:unrelated";
    const running = start(fake);
    try {
      await vi.waitFor(() => expect(fake.ready).toBe(true));
      fake.terminalGoal();
      fake.finishCurrentTurn();
      expect(await running).toMatchObject({ turnId: "turn:two", agentMessageText: "Preparing the final answer" });
    } finally {
      fake.finishCurrentTurn(); fake.terminalGoal("turn:two"); await running.catch(() => {});
    }
  });

  it.each([undefined, "turn:two", "turn:one"])("does not use an earlier completed turn when terminal turnId is %s", async terminalTurnId => {
    const fake = new GoalCompletionProcess();
    const running = start(fake);
    try {
      await vi.waitFor(() => expect(fake.ready).toBe(true));
      fake.terminalGoal(terminalTurnId);
      await drain();
      expect(fake.killed).toBe(false);
      fake.finishCurrentTurn();
      const result = await running;
      expect(result).toMatchObject({ turnId: "turn:two", turnStatus: "completed", goalStatus: "complete",
        agentMessageText: "FINAL ANSWER: both steps completed" });
      expect(fake.methods.filter(method => method === "thread/goal/set")).toHaveLength(1);
      expect(fake.methods).not.toContain("turn/start");
    } finally {
      fake.finishCurrentTurn(); fake.terminalGoal("turn:two"); await running.catch(() => {});
    }
  });

  it("ignores another thread's terminal goal even when the objective matches", async () => {
    const fake = new GoalCompletionProcess();
    const running = start(fake);
    try {
      await vi.waitFor(() => expect(fake.ready).toBe(true));
      fake.terminalGoal("turn:two", true);
      fake.finishCurrentTurn();
      await drain();
      expect(fake.killed).toBe(false);
      fake.terminalGoal();
      expect(await running).toMatchObject({ goalStatus: "complete", agentMessageText: "FINAL ANSWER: both steps completed" });
    } finally {
      fake.terminalGoal("turn:two"); await running.catch(() => {});
    }
  });

  it("waits for a durable active turn when recovering an already terminal goal", async () => {
    const fake = new GoalCompletionProcess(true);
    const running = start(fake);
    try {
      await vi.waitFor(() => expect(fake.ready).toBe(true));
      expect(fake.killed).toBe(false);
      fake.finishCurrentTurn();
      expect(await running).toMatchObject({ turnId: "turn:two", goalStatus: "complete",
        agentMessageText: "FINAL ANSWER: both steps completed" });
      expect(fake.methods).not.toContain("thread/goal/set");
      expect(fake.methods).not.toContain("turn/start");
    } finally {
      fake.finishCurrentTurn(); await running.catch(() => {});
    }
  });

  it.each([false, true])("ignores delayed earlier-turn events (repeated start: %s)", async includeStart => {
    const fake = new GoalCompletionProcess();
    const running = start(fake);
    try {
      await vi.waitFor(() => expect(fake.ready).toBe(true));
      fake.terminalGoal();
      fake.replayPreviousTurn(includeStart);
      await drain();
      expect(fake.killed).toBe(false);
      fake.finishCurrentTurn();
      expect(await running).toMatchObject({ turnId: "turn:two", agentMessageText: "FINAL ANSWER: both steps completed" });
    } finally {
      fake.finishCurrentTurn(); fake.terminalGoal("turn:two"); await running.catch(() => {});
    }
  });

  it.each([false, true])("keeps completion observed while an older recovery snapshot is in flight (omitted turn: %s)", async omitActiveSnapshot => {
    const fake = new GoalCompletionProcess(true);
    fake.finishDuringRecoveryRead = true;
    fake.omitActiveSnapshot = omitActiveSnapshot;
    const running = start(fake);
    try {
      expect(await running).toMatchObject({ turnId: "turn:two", turnStatus: "completed", goalStatus: "complete",
        agentMessageText: "FINAL ANSWER: both steps completed" });
      expect(fake.methods).not.toContain("turn/start");
    } finally {
      fake.finishCurrentTurn(); await running.catch(() => {});
    }
  });

  it("does not replace the final answer with an older turn before the terminal goal update", async () => {
    const fake = new GoalCompletionProcess();
    const running = start(fake);
    try {
      await vi.waitFor(() => expect(fake.ready).toBe(true));
      fake.finishCurrentTurn();
      fake.replayPreviousTurn();
      fake.terminalGoal("turn:one");
      expect(await running).toMatchObject({ turnId: "turn:two", agentMessageText: "FINAL ANSWER: both steps completed" });
    } finally {
      fake.finishCurrentTurn(); fake.terminalGoal("turn:two"); await running.catch(() => {});
    }
  });

  it("accepts a completed recovery snapshot despite an unrelated progress notification", async () => {
    const fake = new GoalCompletionProcess(true);
    fake.completedSnapshotWithHeartbeat = true;
    const running = start(fake);
    try {
      expect(await running).toMatchObject({ turnId: "turn:two", turnStatus: "completed", goalStatus: "complete",
        agentMessageText: "FINAL ANSWER: both steps completed" });
      expect(fake.methods).not.toContain("turn/start");
    } finally {
      fake.finishCurrentTurn(); await running.catch(() => {});
    }
  });

  it.each(["paused", "blocked", "budgetLimited", "usageLimited"])("drains the final turn without resubmission for %s", async status => {
    const fake = new GoalCompletionProcess();
    const running = start(fake);
    try {
      await vi.waitFor(() => expect(fake.ready).toBe(true));
      fake.terminalGoal(undefined, false, status);
      await drain();
      expect(fake.killed).toBe(false);
      fake.finishCurrentTurn();
      expect(await running).toMatchObject({ turnId: "turn:two", goalStatus: status,
        agentMessageText: "FINAL ANSWER: both steps completed" });
      expect(fake.methods).not.toContain("turn/start");
    } finally {
      fake.finishCurrentTurn(); fake.terminalGoal("turn:two", false, status); await running.catch(() => {});
    }
  });
});
