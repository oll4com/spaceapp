import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
  buildCodexAppServerProcessEnv,
  createCodexAppServerControlService,
  resolveCodexAppServerRequestUserInput,
  runCodexAppServerStdioGoalSession,
  runCodexAppServerStdioTurnSession,
  type CodexAppServerStdioProcess
} from "../src/index.js";

function testEnv() {
  return buildCodexAppServerProcessEnv({
    baseEnv: {},
    codexHome: "/tmp/codex-app-server-protocol-test-home",
    credential: null
  });
}

type ProtocolMessage = {
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
};

class ProtocolFakeProcess extends EventEmitter implements CodexAppServerStdioProcess {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly writes: ProtocolMessage[] = [];
  killed = false;
  configError = false;
  threadStartError = false;
  runtimeModel: string | null = null;
  resumeFailures = 0;
  hangTurn = false;
  completeInterrupt = true;
  turnAgentMessageText: string | null = null;
  deferTurnNotifications = false;
  recoveredTurn: {
    id: string;
    status: "completed" | "interrupted" | "failed" | "inProgress";
    text?: string;
    inputMarker?: string;
  } | null = null;
  recoveredTurnCompletesAfterReads = 0;
  recoveredTurnReadCount = 0;
  latestRecoveredTurn: {
    id: string;
    status: "completed";
    text: string;
  } | null = null;
  recoveredGoalStatus: "active" | "complete" | null = null;
  recoveredGoalObjective = "Finish the task completely";
  completeActiveGoalAfterGet = false;
  emitRecoveredGoalUpdateAfterGet = false;
  emitLateSeedCompletionAfterGoalUpdate = false;
  completeGoalAfterSet = false;
  goalFallbackTurnsBeforeComplete = 0;
  goalFallbackTurnCount = 0;
  goalObjectiveAfterSet: string | null = null;
  requirements: Record<string, unknown> | null = null;

  readonly stdin = {
    write: (chunk: string) => {
      for (const line of chunk.split("\n")) {
        if (!line.trim()) continue;
        const message = JSON.parse(line) as ProtocolMessage;
        this.writes.push(message);
        this.respond(message);
      }
      return true;
    }
  };

  kill(): boolean {
    this.killed = true;
    return true;
  }

  completeHungTurn() {
    this.emitJson({
      method: "turn/completed",
      params: {
        threadId: "thread:new-persistent",
        turn: { id: "turn:protocol", status: "completed" }
      }
    });
  }

  completeInterruptedTurn(threadId = "thread:new-persistent", turnId = "turn:protocol") {
    this.emitJson({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "interrupted" } } });
  }

  private emitJson(message: unknown) {
    queueMicrotask(() => this.stdout.emit("data", `${JSON.stringify(message)}\n`));
  }

  private respond(message: ProtocolMessage) {
    if (message.method === "turn/interrupt") {
      this.emitJson({ id: message.id, result: {} });
      if (this.completeInterrupt) this.completeInterruptedTurn(message.params?.threadId as string, message.params?.turnId as string);
    }
    if (message.method === "initialize") {
      this.emitJson({
        id: message.id,
        result: {
          userAgent: "fake-codex",
          codexHome: "/tmp/codex-app-server-protocol-test-home",
          platformFamily: "unix",
          platformOs: "linux"
        }
      });
    }
    if (message.method === "configRequirements/read") {
      this.emitJson(this.configError
        ? { id: message.id, error: { message: "secret requirements failure detail" } }
        : { id: message.id, result: { requirements: this.requirements } });
    }
    if (message.method === "config/read") {
      this.emitJson({
        id: message.id,
        result: { config: { model: "gpt-configured", model_reasoning_effort: "high", plan_mode_reasoning_effort: "xhigh" }, origins: {} }
      });
    }
    if (message.method === "collaborationMode/list") {
      this.emitJson({
        id: message.id,
        result: {
          data: [
            { name: "Default", mode: "default", model: "gpt-default", reasoning_effort: "medium" },
            { name: "Plan", mode: "plan", model: "gpt-plan", reasoning_effort: "high" }
          ]
        }
      });
    }
    if (message.method === "model/list") {
      this.emitJson({
        id: message.id,
        result: {
          data: [
            {
              model: "gpt-6-astra",
              displayName: "GPT-6-Astra",
              isDefault: false,
              hidden: true,
              defaultReasoningEffort: "medium",
              supportedReasoningEfforts: [
                { reasoningEffort: "medium", description: "Balanced" },
                { reasoningEffort: "ultra", description: "Delegated" }
              ]
            },
            {
              model: "gpt-reserve",
              displayName: "GPT Reserve",
              isDefault: false,
              hidden: true,
              defaultReasoningEffort: "medium",
              supportedReasoningEfforts: [{ reasoningEffort: "medium" }]
            },
            {
              id: "catalog:gpt-default",
              model: "gpt-default",
              displayName: "GPT Default",
              isDefault: true,
              hidden: false,
              defaultReasoningEffort: "medium",
              supportedReasoningEfforts: [
                { reasoningEffort: "medium", description: "Fast" },
                { reasoningEffort: "high", description: "Deep" }
              ]
            }
          ],
          nextCursor: null
        }
      });
    }
    if (message.method === "thread/start") {
      this.emitJson(this.threadStartError
        ? { id: message.id, error: { message: "secret thread failure detail" } }
        : { id: message.id, result: { thread: { id: "thread:new-persistent" }, model: this.runtimeModel } });
    }
    if (message.method === "thread/resume") {
      this.emitJson({
        id: message.id,
        ...(this.resumeFailures-- > 0 ? { error: { message: "private resume failure detail" } }
          : { result: { thread: { id: message.params?.threadId }, model: this.runtimeModel } })
      });
    }
    if (message.method === "thread/read") {
      this.recoveredTurnReadCount += 1;
      const recoveredStatus =
        this.recoveredTurn?.status === "inProgress" &&
        this.recoveredTurnReadCount > this.recoveredTurnCompletesAfterReads
          ? "completed"
          : this.recoveredTurn?.status;
      this.emitJson({
        id: message.id,
        result: {
          thread: {
            id: message.params?.threadId,
            turns: [
              ...(this.recoveredTurn
                ? [{
                    id: this.recoveredTurn.id,
                    status: recoveredStatus,
                    items: [
                      ...(this.recoveredTurn.inputMarker
                        ? [{ id: "item:recovered-input", type: "userMessage", content: this.recoveredTurn.inputMarker }]
                        : []),
                      ...(this.recoveredTurn.text
                        ? [{ id: "item:recovered", type: "agentMessage", text: this.recoveredTurn.text }]
                        : [])
                    ]
                  }]
                : []),
              ...(this.latestRecoveredTurn
                ? [{
                    id: this.latestRecoveredTurn.id,
                    status: this.latestRecoveredTurn.status,
                    items: [{
                      id: "item:latest-recovered",
                      type: "agentMessage",
                      text: this.latestRecoveredTurn.text
                    }]
                  }]
                : [])
            ]
          }
        }
      });
    }
    if (message.method === "turn/start") {
      const threadId = message.params?.threadId;
      if (this.goalFallbackTurnsBeforeComplete > 0 && this.goalObjectiveAfterSet) {
        this.goalFallbackTurnCount += 1;
        const turnId = `turn:goal-fallback-${this.goalFallbackTurnCount}`;
        const finalPass = this.goalFallbackTurnCount >= this.goalFallbackTurnsBeforeComplete;
        const goal = {
          threadId,
          objective: this.goalObjectiveAfterSet,
          status: "complete",
          tokenBudget: null,
          tokensUsed: 250,
          timeUsedSeconds: 3,
          createdAt: 1,
          updatedAt: 2
        };
        this.emitJson({ id: message.id, result: { turn: { id: turnId, status: "inProgress" } } });
        this.emitJson({
          method: "turn/started",
          params: { threadId, turn: { id: turnId, status: "inProgress" } }
        });
        this.emitJson({
          method: "item/completed",
          params: {
            threadId,
            turnId,
            item: {
              id: `item:goal-fallback-${this.goalFallbackTurnCount}`,
              type: "agentMessage",
              text: finalPass
                ? "The fallback Goal turn completed the task."
                : "The fallback Goal turn made progress and left the Goal active."
            }
          }
        });
        if (finalPass) {
          this.emitJson({
            method: "thread/goal/updated",
            params: { threadId, turnId, goal }
          });
        }
        this.emitJson({
          method: "turn/completed",
          params: { threadId, turn: { id: turnId, status: "completed" } }
        });
        return;
      }
      this.emitJson({ id: message.id, result: { turn: { id: "turn:protocol", status: "inProgress" } } });
      if (this.hangTurn) return;
      const emitCompletion = () => {
        if (this.turnAgentMessageText) {
          this.emitJson({
            method: "item/completed",
            params: {
              threadId,
              turnId: "turn:protocol",
              item: { id: "item:agent-message", type: "agentMessage", text: this.turnAgentMessageText }
            }
          });
        }
        this.emitJson({
          method: "turn/completed",
          params: { threadId, turn: { id: "turn:protocol", status: "completed" } }
        });
      };
      if (this.deferTurnNotifications) setTimeout(emitCompletion, 0);
      else emitCompletion();
    }
    if (message.method === "thread/goal/get") {
      const goal = this.recoveredGoalStatus
        ? {
            threadId: message.params?.threadId,
            objective: this.recoveredGoalObjective,
            status: this.recoveredGoalStatus,
            tokenBudget: null,
            tokensUsed: this.recoveredGoalStatus === "complete" ? 1200 : 0,
            timeUsedSeconds: this.recoveredGoalStatus === "complete" ? 90 : 0,
            createdAt: 1,
            updatedAt: this.recoveredGoalStatus === "complete" ? 2 : 1
          }
        : null;
      this.emitJson({
        id: message.id,
        result: { goal }
      });
      if (this.emitRecoveredGoalUpdateAfterGet && goal) {
        this.emitJson({
          method: "thread/goal/updated",
          params: { threadId: message.params?.threadId, turnId: "turn:stale-goal", goal }
        });
      }
      if (this.completeActiveGoalAfterGet && goal?.status === "active") {
        this.emitJson({
          method: "turn/started",
          params: {
            threadId: message.params?.threadId,
            turn: { id: "turn:resumed-active-goal", status: "inProgress" }
          }
        });
        this.emitJson({
          method: "item/completed",
          params: {
            threadId: message.params?.threadId,
            turnId: "turn:resumed-active-goal",
            item: { id: "item:resumed-goal", type: "agentMessage", text: "Resumed active goal completed." }
          }
        });
        this.emitJson({
          method: "thread/goal/updated",
          params: {
            threadId: message.params?.threadId,
            turnId: "turn:resumed-active-goal",
            goal: { ...goal, status: "complete", tokensUsed: 1200, timeUsedSeconds: 90, updatedAt: 2 }
          }
        });
        this.emitJson({
          method: "turn/completed",
          params: {
            threadId: message.params?.threadId,
            turn: { id: "turn:resumed-active-goal", status: "completed" }
          }
        });
      }
    }
    if (message.method === "thread/goal/set") {
      this.goalObjectiveAfterSet = typeof message.params?.objective === "string"
        ? message.params.objective
        : null;
      const goal = {
        threadId: message.params?.threadId,
        objective: message.params?.objective,
        status: message.params?.status ?? "active",
        tokenBudget: message.params?.tokenBudget ?? null,
        tokensUsed: 0,
        timeUsedSeconds: 0,
        createdAt: 1,
        updatedAt: 1
      };
      this.emitJson({
        id: message.id,
        result: { goal }
      });
      if (this.completeGoalAfterSet) {
        this.emitJson({
          method: "turn/started",
          params: {
            threadId: message.params?.threadId,
            turn: { id: "turn:new-goal", status: "inProgress" }
          }
        });
        this.emitJson({
          method: "item/completed",
          params: {
            threadId: message.params?.threadId,
            turnId: "turn:new-goal",
            item: { id: "item:new-goal", type: "agentMessage", text: "The new identical request ran again." }
          }
        });
        this.emitJson({
          method: "thread/goal/updated",
          params: {
            threadId: message.params?.threadId,
            turnId: "turn:new-goal",
            goal: { ...goal, status: "complete", tokensUsed: 100, timeUsedSeconds: 2, updatedAt: 2 }
          }
        });
        if (this.emitLateSeedCompletionAfterGoalUpdate) {
          this.emitJson({
            method: "turn/started",
            params: {
              threadId: message.params?.threadId,
              turn: { id: "turn:protocol", status: "inProgress" }
            }
          });
          this.emitJson({
            method: "turn/completed",
            params: {
              threadId: message.params?.threadId,
              turn: { id: "turn:protocol", status: "completed" }
            }
          });
        }
        setTimeout(() => this.emitJson({
          method: "turn/completed",
          params: {
            threadId: message.params?.threadId,
            turn: { id: "turn:new-goal", status: "completed" }
          }
        }), this.emitLateSeedCompletionAfterGoalUpdate ? 10 : 0);
      }
    }
    if (message.method === "thread/goal/clear") {
      this.emitJson({ id: message.id, result: { cleared: true } });
    }
  }
}

class GoalParityFakeProcess extends EventEmitter implements CodexAppServerStdioProcess {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly writes: ProtocolMessage[] = [];
  killed = false;
  private goalObjective = "Finish the task completely";

  readonly stdin = {
    write: (chunk: string) => {
      for (const line of chunk.split("\n")) {
        if (!line.trim()) continue;
        const message = JSON.parse(line) as ProtocolMessage;
        this.writes.push(message);
        this.respond(message);
      }
      return true;
    }
  };

  kill(): boolean {
    this.killed = true;
    return true;
  }

  private emitJson(message: unknown) {
    queueMicrotask(() => this.stdout.emit("data", `${JSON.stringify(message)}\n`));
  }

  private goal(status: "active" | "complete") {
    return {
      threadId: "thread:goal-parity",
      objective: this.goalObjective,
      status,
      tokenBudget: null,
      tokensUsed: status === "complete" ? 1200 : 0,
      timeUsedSeconds: status === "complete" ? 90 : 0,
      createdAt: 1,
      updatedAt: status === "complete" ? 2 : 1
    };
  }

  private finishGoalAfterUserInput() {
    this.emitJson({
      method: "item/completed",
      params: {
        threadId: "thread:goal-parity",
        turnId: "turn:goal-1",
        item: { id: "item:first", type: "agentMessage", text: "First pass complete; continuing." }
      }
    });
    this.emitJson({
      method: "turn/completed",
      params: {
        threadId: "thread:goal-parity",
        turn: { id: "turn:goal-1", status: "completed" }
      }
    });
    this.emitJson({
      method: "turn/started",
      params: {
        threadId: "thread:goal-parity",
        turn: { id: "turn:goal-2", status: "inProgress" }
      }
    });
    this.emitJson({
      method: "item/completed",
      params: {
        threadId: "thread:goal-parity",
        turnId: "turn:goal-2",
        item: { id: "item:final", type: "agentMessage", text: "The task is fully finished." }
      }
    });
    this.emitJson({
      method: "thread/goal/updated",
      params: {
        threadId: "thread:goal-parity",
        turnId: "turn:goal-2",
        goal: this.goal("complete")
      }
    });
    this.emitJson({
      method: "turn/completed",
      params: {
        threadId: "thread:goal-parity",
        turn: { id: "turn:goal-2", status: "completed" }
      }
    });
  }

  private respond(message: ProtocolMessage) {
    if (message.method === "thread/read") {
      this.emitJson({ id: message.id, result: { thread: { id: "thread:goal-parity", turns: [{
        id: "turn:goal-2", status: "completed", items: [{ type: "agentMessage", text: "The task is fully finished." }]
      }] } } });
    }
    if (message.method === "initialize") {
      this.emitJson({ id: message.id, result: { userAgent: "fake-codex" } });
    }
    if (message.method === "configRequirements/read") {
      this.emitJson({ id: message.id, result: { requirements: null } });
    }
    if (message.method === "thread/start") {
      this.emitJson({ id: message.id, result: { thread: { id: "thread:goal-parity" } } });
    }
    if (message.method === "thread/settings/update") {
      this.emitJson({ id: message.id, result: {} });
    }
    if (message.method === "thread/goal/set") {
      if (typeof message.params?.objective === "string") this.goalObjective = message.params.objective;
      this.emitJson({ id: message.id, result: { goal: this.goal("active") } });
      this.emitJson({
        method: "turn/started",
        params: {
          threadId: "thread:goal-parity",
          turn: { id: "turn:goal-1", status: "inProgress" }
        }
      });
      this.emitJson({
        method: "item/tool/requestUserInput",
        id: "request:user-input",
        params: {
          threadId: "thread:goal-parity",
          turnId: "turn:goal-1",
          itemId: "item:user-input",
          autoResolutionMs: null,
          questions: [{
            id: "implementation_choice",
            header: "Implementation",
            question: "How should I continue?",
            isOther: true,
            isSecret: false,
            options: [
              { label: "Continue (Recommended)", description: "Finish with the safest complete implementation." },
              { label: "Stop", description: "End before completion." }
            ]
          }]
        }
      });
    }
    if (message.id === "request:user-input" && message.result) {
      this.finishGoalAfterUserInput();
    }
    if (message.method === "turn/start") {
      this.emitJson({ id: message.id, result: { turn: { id: "turn:legacy", status: "inProgress" } } });
      this.emitJson({
        method: "turn/started",
        params: {
          threadId: "thread:goal-parity",
          turn: { id: "turn:legacy", status: "inProgress" }
        }
      });
      this.emitJson({
        method: "turn/completed",
        params: {
          threadId: "thread:goal-parity",
          turn: { id: "turn:legacy", status: "completed" }
        }
      });
    }
  }
}

describe("Codex App Server bounded turn sequence", () => {
  it("acknowledges user-input requests without fabricating user authorization", () => {
    expect(resolveCodexAppServerRequestUserInput({
      method: "item/tool/requestUserInput",
      id: "request:choices",
      params: {
        questions: [
          {
            id: "implementation_choice",
            isSecret: false,
            options: [
              { label: "Stop (Not Recommended)", description: "Stop before the task is complete." },
              { label: "Safe (Recommended)", description: "Take the safest complete path." }
            ]
          },
          {
            id: "missing_context",
            isSecret: false,
            options: null
          }
        ]
      }
    })).toEqual({
      answers: {
        implementation_choice: { answers: [] },
        missing_context: { answers: [] }
      }
    });
  });

  it("never invents answers for secret user-input questions", () => {
    expect(resolveCodexAppServerRequestUserInput({
      method: "item/tool/requestUserInput",
      id: "request:secret",
      params: {
        questions: [{
          id: "password",
          isSecret: true,
          options: null
        }]
      }
    })).toEqual({
      answers: {
        password: { answers: [] }
      }
    });
  });

  it("has no wall-clock deadline when timeoutMs is explicitly null", async () => {
    vi.useFakeTimers();
    const fake = new ProtocolFakeProcess();
    fake.hangTurn = true;
    let outcome: "resolved" | "rejected" | null = null;
    let rejection: unknown = null;

    try {
      const turn = runCodexAppServerStdioTurnSession({
        command: "codex",
        env: testEnv(),
        prompt: "continue until finished",
        timeoutMs: null,
        spawnProcess: () => fake
      }).then(
        (value) => {
          outcome = "resolved";
          return value;
        },
        (error) => {
          outcome = "rejected";
          rejection = error;
          return null;
        }
      );
      await vi.advanceTimersByTimeAsync(60_001);

      expect(outcome).toBeNull();
      fake.completeHungTurn();
      await expect(turn).resolves.toMatchObject({ turnStatus: "completed" });
      expect(rejection).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps one app-server session alive across automatic goal continuations and user-input requests", async () => {
    const fake = new GoalParityFakeProcess();
    const handledRequests: string[] = [];
    const checkpoints: Array<{ threadId: string; turnId: string | null }> = [];

    const state = await runCodexAppServerStdioTurnSession({
      command: "codex",
      env: testEnv(),
      prompt: "Finish the task completely",
      goalObjective: "Finish the task completely",
      model: "gpt-goal-parity",
      reasoningEffort: "high",
      timeoutMs: null,
      serverRequestHandler: async (request) => {
        handledRequests.push(request.method ?? "");
        return resolveCodexAppServerRequestUserInput(request);
      },
      onCheckpoint: async (checkpoint) => checkpoints.push(checkpoint),
      spawnProcess: () => fake
    });

    expect(fake.writes.some((message) => message.method === "turn/start")).toBe(false);
    expect(fake.writes.find((message) => message.method === "thread/settings/update")?.params).toEqual({
      threadId: "thread:goal-parity",
      model: "gpt-goal-parity",
      effort: "high"
    });
    expect(fake.writes.find((message) => message.method === "thread/goal/set")?.params).toMatchObject({
      objective: "Finish the task completely",
      status: "active",
      tokenBudget: null
    });
    expect(fake.writes.find((message) => message.id === "request:user-input")?.result).toEqual({
      answers: {
        implementation_choice: { answers: [] }
      }
    });
    expect(handledRequests).toEqual(["item/tool/requestUserInput"]);
    expect(checkpoints.at(-1)).toEqual({ threadId: "thread:goal-parity", turnId: "turn:goal-2" });
    expect(state).toMatchObject({
      threadId: "thread:goal-parity",
      turnId: "turn:goal-2",
      turnStatus: "completed",
      goalStatus: "complete",
      completedNotificationSeen: true,
      agentMessageText: "The task is fully finished."
    });
  });

  it("starts a fallback turn when Goal activation emits no automatic turn", async () => {
    const fake = new ProtocolFakeProcess();
    fake.goalFallbackTurnsBeforeComplete = 1;

    const state = await runCodexAppServerStdioTurnSession({
      command: "codex",
      env: testEnv(),
      prompt: "Finish the task completely",
      goalObjective: "Finish the task completely",
      timeoutMs: 100,
      goalProgressGraceMs: 1,
      serverRequestHandler: resolveCodexAppServerRequestUserInput,
      spawnProcess: () => fake
    });

    const goalSetIndex = fake.writes.findIndex((message) => message.method === "thread/goal/set");
    const fallbackIndex = fake.writes.findIndex((message) => message.method === "turn/start");
    expect(goalSetIndex).toBeGreaterThanOrEqual(0);
    expect(fallbackIndex).toBeGreaterThan(goalSetIndex);
    expect(fake.writes[fallbackIndex]?.params?.input).toEqual([
      expect.objectContaining({
        type: "text",
        text: "Finish the task completely"
      })
    ]);
    expect(state).toMatchObject({
      turnId: "turn:goal-fallback-1",
      turnStatus: "completed",
      goalStatus: "complete",
      completedNotificationSeen: true,
      agentMessageText: "The fallback Goal turn completed the task."
    });
  });

  it("keeps starting fallback continuations while the Goal remains active", async () => {
    const fake = new ProtocolFakeProcess();
    fake.goalFallbackTurnsBeforeComplete = 2;

    const state = await runCodexAppServerStdioTurnSession({
      command: "codex",
      env: testEnv(),
      prompt: "Continue until the full task is done",
      goalObjective: "Continue until the full task is done",
      timeoutMs: 150,
      goalProgressGraceMs: 1,
      serverRequestHandler: resolveCodexAppServerRequestUserInput,
      spawnProcess: () => fake
    });

    expect(fake.writes.filter((message) => message.method === "turn/start")).toHaveLength(2);
    expect(state).toMatchObject({
      turnId: "turn:goal-fallback-2",
      turnStatus: "completed",
      goalStatus: "complete",
      completedNotificationSeen: true,
      agentMessageText: "The fallback Goal turn completed the task."
    });
  });

  it("does not start a fallback turn when durable state already has an active Goal turn", async () => {
    const fake = new ProtocolFakeProcess();
    fake.recoveredTurn = {
      id: "turn:delayed-native-goal",
      status: "inProgress"
    };
    fake.recoveredTurnCompletesAfterReads = Number.MAX_SAFE_INTEGER;
    const controller = new AbortController();
    const cancellation = new Error("stop after durable Goal probe");
    // Cancel once the durable probe was sent: a fixed 20 ms delay raced it on a loaded host.
    const cancellationTimer = setInterval(() => {
      if (fake.writes.some((message) => message.method === "thread/read")) controller.abort(cancellation);
    }, 5);

    try {
      const turn = runCodexAppServerStdioTurnSession({
        command: "codex",
        env: testEnv(),
        prompt: "Continue until the full task is done",
        goalObjective: "Continue until the full task is done",
        timeoutMs: null,
        goalProgressGraceMs: 1,
        signal: controller.signal,
        serverRequestHandler: resolveCodexAppServerRequestUserInput,
        spawnProcess: () => fake
      });

      await expect(turn).rejects.toBe(cancellation);
      expect(fake.writes.some((message) => message.method === "thread/read")).toBe(true);
      expect(fake.writes.some((message) => message.method === "turn/start")).toBe(false);
    } finally {
      clearInterval(cancellationTimer);
    }
  });

  it("preserves the complete native Chat prompt in the Goal objective", async () => {
    const fake = new GoalParityFakeProcess();
    const objective = `begin-${"x".repeat(7_900)}-end`;

    await runCodexAppServerStdioTurnSession({
      command: "codex",
      env: testEnv(),
      prompt: objective,
      goalObjective: objective,
      timeoutMs: 1000,
      serverRequestHandler: resolveCodexAppServerRequestUserInput,
      spawnProcess: () => fake
    });

    expect(objective.length).toBeGreaterThan(4_000);
    expect(fake.writes.find((message) => message.method === "thread/goal/set")?.params?.objective).toBe(objective);
  });

  it("seeds image attachments in a context-only turn before starting the Goal", async () => {
    const fake = new GoalParityFakeProcess();
    const checkpoints: Array<{ threadId: string; turnId: string | null }> = [];

    await runCodexAppServerStdioTurnSession({
      command: "codex",
      env: testEnv(),
      prompt: "Use the attached screenshot to finish the task.",
      goalObjective: "Use the attached screenshot to finish the task.",
      imageAttachments: [{
        artifactId: "artifact:image-1",
        mimeType: "image/png",
        storageUri: "file:///opt/spaceapp/var/artifacts/image-1.png",
        sha256: "a".repeat(64),
        path: "/opt/spaceapp/var/artifacts/image-1.png"
      }],
      timeoutMs: 1000,
      serverRequestHandler: resolveCodexAppServerRequestUserInput,
      onCheckpoint: async (checkpoint) => checkpoints.push(checkpoint),
      spawnProcess: () => fake
    });

    const seed = fake.writes.find((message) => message.method === "turn/start");
    const goal = fake.writes.find((message) => message.method === "thread/goal/set");
    expect(seed?.params?.input).toEqual([
      {
        type: "text",
        text: "Ingest the attached images as context for the next Goal. Do not analyze them, take actions, or begin the user's task in this turn. Reply only that the attachments are ready.",
        text_elements: []
      },
      { type: "localImage", path: "/opt/spaceapp/var/artifacts/image-1.png" }
    ]);
    expect(seed?.params?.input).not.toContainEqual(expect.objectContaining({ text: "Use the attached screenshot to finish the task." }));
    expect(goal?.params?.objective).toBe("Use the attached screenshot to finish the task.");
    expect(fake.writes.indexOf(seed!)).toBeLessThan(fake.writes.indexOf(goal!));
    expect(checkpoints.filter((checkpoint) => checkpoint.turnId === "turn:legacy")).toHaveLength(1);
  });

  it("does not let a stale terminal Goal and image-seed completion finish the new Goal", async () => {
    const fake = new ProtocolFakeProcess();
    const oldMarker = "space-durable-turn:workflow:old-image-goal";
    const newMarker = "space-durable-turn:workflow:new-image-goal";
    fake.recoveredGoalStatus = "complete";
    fake.recoveredGoalObjective = [
      "Use the attached screenshot to finish the task.",
      "",
      `<space-durable-turn marker="${oldMarker}">Internal recovery marker; do not mention it in your response.</space-durable-turn>`
    ].join("\n");
    fake.emitRecoveredGoalUpdateAfterGet = true;
    fake.emitLateSeedCompletionAfterGoalUpdate = true;
    fake.completeGoalAfterSet = true;

    const state = await runCodexAppServerStdioTurnSession({
      command: "codex",
      env: testEnv(),
      prompt: "Use the attached screenshot to finish the task.",
      goalObjective: "Use the attached screenshot to finish the task.",
      threadId: "thread:stale-image-goal",
      recoveryMarker: newMarker,
      imageAttachments: [{
        artifactId: "artifact:image-stale-goal",
        mimeType: "image/png",
        storageUri: "file:///opt/spaceapp/var/artifacts/image-stale-goal.png",
        sha256: "b".repeat(64),
        path: "/opt/spaceapp/var/artifacts/image-stale-goal.png"
      }],
      timeoutMs: 1000,
      spawnProcess: () => fake
    });

    const objective = fake.writes.find((message) => message.method === "thread/goal/set")?.params?.objective;
    expect(objective).toContain(newMarker);
    expect(objective).not.toContain(oldMarker);
    expect(state).toMatchObject({
      turnId: "turn:new-goal",
      turnStatus: "completed",
      goalStatus: "complete",
      agentMessageText: "The new identical request ran again."
    });
  });

  it("does not swallow a continuation-turn checkpoint failure after goal completion", async () => {
    const fake = new GoalParityFakeProcess();

    await expect(runCodexAppServerStdioTurnSession({
      command: "codex",
      env: testEnv(),
      prompt: "Finish the task completely",
      goalObjective: "Finish the task completely",
      timeoutMs: 1000,
      serverRequestHandler: () => ({
        answers: {
          implementation_choice: { answers: ["Continue (Recommended)"] }
        }
      }),
      onCheckpoint: async (checkpoint) => {
        if (checkpoint.turnId === "turn:goal-2") {
          throw new Error("final goal checkpoint failed");
        }
      },
      spawnProcess: () => fake
    })).rejects.toThrow("final goal checkpoint failed");
  });

  it("recovers a completed durable goal turn without imposing a fallback deadline", async () => {
    const fake = new ProtocolFakeProcess();
    fake.recoveredTurn = {
      id: "turn:goal-before-worker-restart",
      status: "completed",
      text: "The durable goal was already completed."
    };
    fake.recoveredGoalStatus = "complete";

    const state = await runCodexAppServerStdioTurnSession({
      command: "codex",
      env: testEnv(),
      prompt: "must not be sent again",
      goalObjective: "Finish the task completely",
      threadId: "thread:goal-before-worker-restart",
      resumeTurnId: "turn:goal-before-worker-restart",
      timeoutMs: null,
      spawnProcess: () => fake
    });

    expect(fake.writes.some((message) => message.method === "turn/start")).toBe(false);
    expect(fake.writes.some((message) => message.method === "thread/goal/set")).toBe(false);
    expect(fake.writes.some((message) => message.method === "thread/goal/get")).toBe(true);
    expect(state).toMatchObject({
      threadId: "thread:goal-before-worker-restart",
      turnId: "turn:goal-before-worker-restart",
      turnStatus: "completed",
      goalStatus: "complete",
      completedNotificationSeen: true,
      agentMessageText: "The durable goal was already completed."
    });
  });

  it("recovers the latest completed goal turn when the final checkpoint was not persisted", async () => {
    const fake = new ProtocolFakeProcess();
    fake.recoveredTurn = {
      id: "turn:goal-checkpoint-1",
      status: "completed",
      text: "An earlier continuation completed."
    };
    fake.latestRecoveredTurn = {
      id: "turn:goal-checkpoint-2",
      status: "completed",
      text: "The final continuation completed the task."
    };
    fake.recoveredGoalStatus = "complete";

    const state = await runCodexAppServerStdioTurnSession({
      command: "codex",
      env: testEnv(),
      prompt: "Finish the task completely",
      goalObjective: "Finish the task completely",
      threadId: "thread:goal-final-checkpoint-gap",
      resumeTurnId: "turn:goal-checkpoint-1",
      timeoutMs: 1000,
      spawnProcess: () => fake
    });

    expect(state).toMatchObject({
      turnId: "turn:goal-checkpoint-2",
      turnStatus: "completed",
      goalStatus: "complete",
      agentMessageText: "The final continuation completed the task."
    });
  });

  it("recovers a terminal Goal when completion won the race before the first turn checkpoint", async () => {
    const fake = new ProtocolFakeProcess();
    const recoveryMarker = "space-durable-turn:workflow:same-run";
    fake.latestRecoveredTurn = {
      id: "turn:goal-completed-before-checkpoint",
      status: "completed",
      text: "The Goal completed before its turn id was persisted."
    };
    fake.recoveredGoalStatus = "complete";
    fake.recoveredGoalObjective = [
      "Finish the task completely",
      "",
      `<space-durable-turn marker="${recoveryMarker}">Internal recovery marker; do not mention it in your response.</space-durable-turn>`
    ].join("\n");

    const state = await runCodexAppServerStdioTurnSession({
      command: "codex",
      env: testEnv(),
      prompt: "Finish the task completely",
      goalObjective: "Finish the task completely",
      threadId: "thread:goal-completed-before-checkpoint",
      recoveryMarker,
      timeoutMs: 1000,
      spawnProcess: () => fake
    });

    expect(fake.writes.some((message) => message.method === "thread/goal/set")).toBe(false);
    expect(state).toMatchObject({
      turnId: "turn:goal-completed-before-checkpoint",
      turnStatus: "completed",
      goalStatus: "complete",
      agentMessageText: "The Goal completed before its turn id was persisted."
    });
  });

  it("runs an identical later prompt when it belongs to a different workflow", async () => {
    const fake = new ProtocolFakeProcess();
    const oldMarker = "space-durable-turn:workflow:old-run";
    const newMarker = "space-durable-turn:workflow:new-run";
    fake.latestRecoveredTurn = {
      id: "turn:old-identical-goal",
      status: "completed",
      text: "The old identical request completed."
    };
    fake.recoveredGoalStatus = "complete";
    fake.recoveredGoalObjective = [
      "Finish the task completely",
      "",
      `<space-durable-turn marker="${oldMarker}">Internal recovery marker; do not mention it in your response.</space-durable-turn>`
    ].join("\n");
    fake.completeGoalAfterSet = true;

    const state = await runCodexAppServerStdioTurnSession({
      command: "codex",
      env: testEnv(),
      prompt: "Finish the task completely",
      goalObjective: "Finish the task completely",
      threadId: "thread:repeated-identical-prompt",
      recoveryMarker: newMarker,
      timeoutMs: 1000,
      spawnProcess: () => fake
    });

    const objective = fake.writes.find((message) => message.method === "thread/goal/set")?.params?.objective;
    expect(objective).toContain(newMarker);
    expect(objective).not.toContain(oldMarker);
    expect(state).toMatchObject({
      turnId: "turn:new-goal",
      goalStatus: "complete",
      agentMessageText: "The new identical request ran again."
    });
  });

  it("reattaches to an active persisted goal when restart happened before the first turn checkpoint", async () => {
    const fake = new ProtocolFakeProcess();
    fake.recoveredGoalStatus = "active";
    fake.completeActiveGoalAfterGet = true;

    const state = await runCodexAppServerStdioTurnSession({
      command: "codex",
      env: testEnv(),
      prompt: "Finish the task completely",
      goalObjective: "Finish the task completely",
      threadId: "thread:goal-before-turn-checkpoint",
      timeoutMs: 1000,
      spawnProcess: () => fake
    });

    expect(fake.writes.some((message) => message.method === "thread/goal/get")).toBe(true);
    expect(fake.writes.some((message) => message.method === "thread/goal/set")).toBe(false);
    expect(fake.writes.some((message) => message.method === "turn/start")).toBe(false);
    expect(state).toMatchObject({
      threadId: "thread:goal-before-turn-checkpoint",
      turnId: "turn:resumed-active-goal",
      turnStatus: "completed",
      goalStatus: "complete",
      agentMessageText: "Resumed active goal completed."
    });
  });

  it("preserves the final agent message emitted before turn completion", async () => {
    const fake = new ProtocolFakeProcess();
    fake.deferTurnNotifications = true;
    fake.turnAgentMessageText = [
      "```space-room-actions",
      '{"version":1,"actions":[{"toolId":"room:inspect","action":{"type":"inspect"}}]}',
      "```"
    ].join("\n");

    const state = await runCodexAppServerStdioTurnSession({
      command: "codex",
      env: testEnv(),
      prompt: "inspect the room",
      timeoutMs: 1000,
      spawnProcess: () => fake
    });

    expect(state.agentMessageText).toBe(fake.turnAgentMessageText);
    expect(state.completedNotificationSeen).toBe(true);
  });

  it("checkpoints a fresh durable thread and turn before waiting for completion", async () => {
    const fake = new ProtocolFakeProcess();
    const checkpoints: Array<{ threadId: string; turnId: string | null }> = [];

    await runCodexAppServerStdioTurnSession({
      command: "codex",
      env: testEnv(),
      prompt: "persist this turn before waiting",
      ephemeral: false,
      onCheckpoint: async (checkpoint) => checkpoints.push(checkpoint),
      timeoutMs: 1000,
      spawnProcess: () => fake
    });

    expect(checkpoints).toEqual([
      { threadId: "thread:new-persistent", turnId: null },
      { threadId: "thread:new-persistent", turnId: "turn:protocol" }
    ]);
  });

  it("recovers an already-completed durable turn without sending the initial prompt twice", async () => {
    const fake = new ProtocolFakeProcess();
    fake.recoveredTurn = {
      id: "turn:before-worker-restart",
      status: "completed",
      text: "Recovered completion from durable thread history."
    };

    const state = await runCodexAppServerStdioTurnSession({
      command: "codex",
      env: testEnv(),
      prompt: "must not be sent again",
      threadId: "thread:before-worker-restart",
      resumeTurnId: "turn:before-worker-restart",
      recoveryPrompt: "Continue only unfinished work after the worker restart.",
      timeoutMs: 1000,
      spawnProcess: () => fake
    });

    expect(fake.writes.map((message) => message.method)).toEqual([
      "initialize",
      "initialized",
      "configRequirements/read",
      "thread/resume",
      "thread/read"
    ]);
    expect(fake.writes.some((message) => message.method === "turn/start")).toBe(false);
    expect(state).toMatchObject({
      threadId: "thread:before-worker-restart",
      turnId: "turn:before-worker-restart",
      turnStatus: "completed",
      completedNotificationSeen: true,
      agentMessageText: "Recovered completion from durable thread history."
    });
  });

  it("finds a marker-matched turn when the worker stopped before persisting its turn id", async () => {
    const fake = new ProtocolFakeProcess();
    fake.recoveredTurn = {
      id: "turn:accepted-before-checkpoint",
      status: "completed",
      text: "Recovered after the narrow turn checkpoint window.",
      inputMarker: "space-durable-turn:run-before-checkpoint"
    };
    const checkpoints: Array<{ threadId: string; turnId: string | null }> = [];

    const state = await runCodexAppServerStdioTurnSession({
      command: "codex",
      env: testEnv(),
      prompt: "must not be sent twice",
      threadId: "thread:accepted-before-checkpoint",
      recoveryMarker: "space-durable-turn:run-before-checkpoint",
      onCheckpoint: async (checkpoint) => checkpoints.push(checkpoint),
      timeoutMs: 1000,
      spawnProcess: () => fake
    });

    expect(fake.writes.some((message) => message.method === "turn/start")).toBe(false);
    expect(checkpoints.at(-1)).toEqual({
      threadId: "thread:accepted-before-checkpoint",
      turnId: "turn:accepted-before-checkpoint"
    });
    expect(state).toMatchObject({
      turnId: "turn:accepted-before-checkpoint",
      turnStatus: "completed",
      agentMessageText: "Recovered after the narrow turn checkpoint window."
    });
  });

  it("polls a still-active durable turn to completion without starting another turn", async () => {
    const fake = new ProtocolFakeProcess();
    fake.recoveredTurn = {
      id: "turn:still-active-after-restart",
      status: "inProgress",
      text: "Completed while the replacement worker monitored it."
    };
    fake.recoveredTurnCompletesAfterReads = 1;

    const state = await runCodexAppServerStdioTurnSession({
      command: "codex",
      env: testEnv(),
      prompt: "must not be duplicated",
      threadId: "thread:still-active-after-restart",
      resumeTurnId: "turn:still-active-after-restart",
      recoveryPollIntervalMs: 1,
      timeoutMs: 1000,
      spawnProcess: () => fake
    });

    expect(fake.recoveredTurnReadCount).toBe(2);
    expect(fake.writes.some((message) => message.method === "turn/start")).toBe(false);
    expect(state).toMatchObject({
      turnId: "turn:still-active-after-restart",
      turnStatus: "completed",
      completedNotificationSeen: true
    });
  });

  it("waits for native interruption before terminating its app-server process", async () => {
    const fake = new ProtocolFakeProcess();
    fake.hangTurn = true;
    fake.completeInterrupt = false;
    const controller = new AbortController();
    const turn = runCodexAppServerStdioTurnSession({
      command: "codex",
      env: testEnv(),
      prompt: "wait for cancellation",
      timeoutMs: 30_000,
      signal: controller.signal,
      spawnProcess: () => fake
    });
    await vi.waitFor(() => expect(fake.writes.some((message) => message.method === "turn/start")).toBe(true));

    const rejected = expect(turn).rejects.toThrow("Room Agent stop requested.");
    controller.abort(new Error("Room Agent stop requested."));
    await vi.waitFor(() => expect(fake.writes.find(message => message.method === "turn/interrupt")?.params)
      .toEqual({ threadId: "thread:new-persistent", turnId: "turn:protocol" }));
    expect(fake.killed).toBe(false);
    fake.completeInterruptedTurn("thread:unrelated", "turn:unrelated");
    await new Promise(resolve => setImmediate(resolve));
    expect(fake.killed).toBe(false);
    fake.completeInterruptedTurn();
    await rejected;
    expect(fake.killed).toBe(true);
    expect(fake.writes.filter(message => message.method === "turn/start")).toHaveLength(1);
  });

  it("bounds missing native interruption and preserves cancellation as an error", async () => {
    const fake = new ProtocolFakeProcess();
    fake.hangTurn = true;
    fake.completeInterrupt = false;
    const controller = new AbortController();
    const turn = runCodexAppServerStdioTurnSession({ command: "codex", env: testEnv(), prompt: "wait", signal: controller.signal, spawnProcess: () => fake });
    await vi.waitFor(() => expect(fake.writes.some(message => message.method === "turn/start")).toBe(true));
    vi.useFakeTimers();
    try {
      const rejected = expect(turn).rejects.toThrow("Stop");
      controller.abort(new Error("Stop"));
      await vi.advanceTimersByTimeAsync(4999);
      expect(fake.killed).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await rejected;
      expect(fake.killed).toBe(true);
    } finally { vi.useRealTimers(); }
  });

  it("allows worker shutdown to detach without interrupting durable native work", async () => {
    const fake = new ProtocolFakeProcess();
    fake.hangTurn = true;
    const controller = new AbortController();
    const turn = runCodexAppServerStdioTurnSession({ command: "codex", env: testEnv(), prompt: "wait", signal: controller.signal,
      shouldInterruptOnAbort: reason => !(reason instanceof Error && reason.message === "WORKER_SHUTDOWN"), spawnProcess: () => fake });
    await vi.waitFor(() => expect(fake.writes.some(message => message.method === "turn/start")).toBe(true));
    const rejected = expect(turn).rejects.toThrow("WORKER_SHUTDOWN");
    controller.abort(new Error("WORKER_SHUTDOWN"));
    await rejected;
    expect(fake.writes.some(message => message.method === "turn/interrupt")).toBe(false);
    expect(fake.killed).toBe(true);
  });

  it("negotiates experimental API, validates requirements, starts a thread, and forwards Plan", async () => {
    const fake = new ProtocolFakeProcess();
    fake.requirements = {
      allowedApprovalPolicies: ["on-request"],
      allowedApprovalsReviewers: ["user"],
      allowedSandboxModes: ["workspace-write"]
    };
    const validations: unknown[] = [];

    const state = await runCodexAppServerStdioTurnSession({
      command: "codex",
      env: testEnv(),
      prompt: "sensitive prompt",
      permissionMode: "ask_for_approval",
      collaborationMode: "plan",
      requirementsValidator: (requirements) => validations.push(requirements),
      timeoutMs: 1000,
      spawnProcess: () => fake
    });

    expect(fake.writes.map((message) => message.method)).toEqual([
      "initialize",
      "initialized",
      "configRequirements/read",
      "collaborationMode/list",
      "thread/start",
      "turn/start"
    ]);
    expect(fake.writes[0]?.params).toMatchObject({
      capabilities: { experimentalApi: true, requestAttestation: false }
    });
    expect(fake.writes.find((message) => message.method === "thread/start")?.params).toMatchObject({
      sandbox: "workspace-write",
      approvalPolicy: "on-request",
      approvalsReviewer: "user"
    });
    expect(fake.writes.find((message) => message.method === "turn/start")?.params).toMatchObject({
      collaborationMode: {
        mode: "plan",
        settings: {
          model: "gpt-plan",
          reasoning_effort: "high",
          developer_instructions: null
        }
      }
    });
    expect(validations).toHaveLength(1);
    expect(state).toMatchObject({ threadId: "thread:new-persistent", turnStatus: "completed" });
  });

  it.each([null, "reported-runtime", "x".repeat(201)])("uses only bounded runtime model evidence (%s)", async (reported) => {
    const fake = new ProtocolFakeProcess();
    fake.runtimeModel = reported;
    const state = await runCodexAppServerStdioTurnSession({ command: "codex", env: testEnv(),
      prompt: "Simple task", model: "requested-model", timeoutMs: 1000, spawnProcess: () => fake });
    expect(state.runtimeModelAtStart).toBe(reported && reported.length <= 200 ? reported : null);
  });

  it("resumes an existing thread with exact full-access overrides before starting a turn", async () => {
    const fake = new ProtocolFakeProcess();

    await runCodexAppServerStdioTurnSession({
      command: "codex",
      env: testEnv(),
      prompt: "continue",
      threadId: "thread:existing",
      permissionMode: "full_access",
      timeoutMs: 1000,
      spawnProcess: () => fake
    });

    expect(fake.writes.map((message) => message.method)).toEqual([
      "initialize",
      "initialized",
      "configRequirements/read",
      "thread/resume",
      "turn/start"
    ]);
    expect(fake.writes.find((message) => message.method === "thread/resume")?.params).toMatchObject({
      threadId: "thread:existing",
      sandbox: "danger-full-access",
      approvalPolicy: "never",
      approvalsReviewer: "user"
    });
  });

  it("allows inherited sessions to continue when requirements RPC fails", async () => {
    const fake = new ProtocolFakeProcess();
    fake.configError = true;

    await runCodexAppServerStdioTurnSession({
      command: "codex",
      env: testEnv(),
      prompt: "legacy inherited permissions",
      timeoutMs: 1000,
      spawnProcess: () => fake
    });

    expect(fake.writes.some((message) => message.method === "thread/start")).toBe(true);
  });

  it("fails closed for explicit permissions when requirements RPC fails", async () => {
    const fake = new ProtocolFakeProcess();
    fake.configError = true;

    await expect(runCodexAppServerStdioTurnSession({
      command: "codex",
      env: testEnv(),
      prompt: "explicit permissions",
      permissionMode: "full_access",
      timeoutMs: 1000,
      spawnProcess: () => fake
    })).rejects.toThrow("Codex runtime requirements could not be validated.");
    expect(fake.writes.some((message) => message.method === "thread/start")).toBe(false);
  });

  it("fails closed when runtime requirement allowlists have an invalid shape", async () => {
    const fake = new ProtocolFakeProcess();
    fake.requirements = {
      allowedApprovalPolicies: ["never"],
      allowedApprovalsReviewers: ["user"],
      allowedSandboxModes: "danger-full-access"
    };

    await expect(runCodexAppServerStdioTurnSession({
      command: "codex",
      env: testEnv(),
      prompt: "invalid runtime requirements",
      permissionMode: "full_access",
      timeoutMs: 1000,
      spawnProcess: () => fake
    })).rejects.toThrow("Codex runtime requirements could not be validated.");
    expect(fake.writes.some((message) => message.method === "thread/start")).toBe(false);
  });

  it("does not expose app-server error details", async () => {
    const fake = new ProtocolFakeProcess();
    fake.threadStartError = true;

    let error: unknown;
    try {
      await runCodexAppServerStdioTurnSession({
        command: "codex",
        env: testEnv(),
        prompt: "trigger sanitized failure",
        timeoutMs: 1000,
        spawnProcess: () => fake
      });
    } catch (currentError) {
      error = currentError;
    }

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("Codex App Server thread/start returned an error.");
    expect((error as Error).message).not.toContain("secret thread failure detail");
  });

  it("retries a rejected resume once on the same thread before submitting input", async () => {
    const fake = new ProtocolFakeProcess();
    fake.resumeFailures = 1;
    const result = await runCodexAppServerStdioTurnSession({ command: "codex", env: testEnv(),
      threadId: "thread:interrupted", prompt: "Continue the conversation", timeoutMs: 3000, spawnProcess: () => fake });
    expect(result.threadId).toBe("thread:interrupted");
    expect(fake.writes.filter(m => m.method === "thread/resume").map(m => m.params?.threadId))
      .toEqual(["thread:interrupted", "thread:interrupted"]);
    expect(fake.writes.filter(m => m.method === "turn/start")).toHaveLength(1);
    expect(fake.writes.some(m => m.method === "thread/start")).toBe(false);
  });

  it("bounds persistent resume failures without starting a replacement conversation", async () => {
    const fake = new ProtocolFakeProcess();
    fake.resumeFailures = 5;
    await expect(runCodexAppServerStdioTurnSession({ command: "codex", env: testEnv(),
      threadId: "thread:interrupted", prompt: "Continue", timeoutMs: 3000, spawnProcess: () => fake }))
      .rejects.toThrow("Codex App Server thread/resume returned an error.");
    expect(fake.writes.filter(m => m.method === "thread/resume")).toHaveLength(2);
    expect(fake.writes.some(m => ["thread/start", "turn/start"].includes(m.method ?? ""))).toBe(false);
  });
});

describe("Codex App Server goal sequence", () => {
  it("creates a persistent thread before setting a goal", async () => {
    const fake = new ProtocolFakeProcess();

    const result = await runCodexAppServerStdioGoalSession({
      command: "codex",
      env: testEnv(),
      action: { type: "set", objective: "Ship parity", tokenBudget: 1200 },
      timeoutMs: 1000,
      spawnProcess: () => fake
    });

    expect(fake.writes.map((message) => message.method)).toEqual([
      "initialize",
      "initialized",
      "configRequirements/read",
      "thread/start",
      "thread/goal/set"
    ]);
    expect(fake.writes.find((message) => message.method === "thread/start")?.params).toMatchObject({
      ephemeral: false
    });
    expect(fake.writes.find((message) => message.method === "thread/goal/set")?.params).toEqual({
      threadId: "thread:new-persistent",
      objective: "Ship parity",
      tokenBudget: 1200
    });
    expect(result.goal).toMatchObject({ objective: "Ship parity", status: "active" });
  });

  it("clears a goal on an existing thread without starting another thread", async () => {
    const fake = new ProtocolFakeProcess();

    const result = await runCodexAppServerStdioGoalSession({
      command: "codex",
      env: testEnv(),
      threadId: "thread:existing",
      action: { type: "clear" },
      timeoutMs: 1000,
      spawnProcess: () => fake
    });

    expect(fake.writes.some((message) => message.method === "thread/start")).toBe(false);
    expect(fake.writes.find((message) => message.method === "thread/goal/clear")?.params).toEqual({
      threadId: "thread:existing"
    });
    expect(result).toMatchObject({ threadId: "thread:existing", goal: null, cleared: true });
  });
});

describe("Codex App Server control service", () => {
  it("exposes normalized requirements, configured model, models, collaboration, set-goal, and clear-goal methods", async () => {
    const processes: ProtocolFakeProcess[] = [];
    const service = createCodexAppServerControlService({
      command: "codex",
      env: testEnv(),
      timeoutMs: 1000,
      spawnProcess: () => {
        const process = new ProtocolFakeProcess();
        processes.push(process);
        return process;
      }
    });

    await expect(service.readConfigRequirements()).resolves.toBeNull();
    await expect(service.readConfiguredModel()).resolves.toEqual({ model: "gpt-configured", reasoningEffort: "high" });
    expect(processes.at(-1)?.writes.find((message) => message.method === "config/read")?.params).toEqual({ includeLayers: false });
    await expect(service.listModels()).resolves.toEqual([
      {
        id: "gpt-6-astra",
        displayName: "GPT-6-Astra",
        description: undefined,
        isDefault: false,
        defaultReasoningEffort: "medium",
        supportedReasoningEfforts: ["medium", "ultra"],
        reasoningOptions: [
          { reasoningEffort: "medium", description: "Balanced" },
          { reasoningEffort: "ultra", description: "Delegated" }
        ]
      },
      {
        id: "gpt-default",
        displayName: "GPT Default",
        description: undefined,
        isDefault: true,
        defaultReasoningEffort: "medium",
        supportedReasoningEfforts: ["medium", "high"],
        reasoningOptions: [
          { reasoningEffort: "medium", description: "Fast" },
          { reasoningEffort: "high", description: "Deep" }
        ]
      }
    ]);
    await expect(service.listCollaborationModes()).resolves.toEqual([
      { name: "Default", mode: "default", model: "gpt-default", reasoning_effort: "medium" },
      { name: "Plan", mode: "plan", model: "gpt-plan", reasoning_effort: "high" }
    ]);
    await expect(service.setGoal({ objective: "Ship control service" })).resolves.toMatchObject({
      threadId: "thread:new-persistent",
      goal: { objective: "Ship control service" },
      cleared: null
    });
    await expect(service.clearGoal("thread:existing")).resolves.toEqual({
      threadId: "thread:existing",
      goal: null,
      cleared: true
    });
    expect(processes).toHaveLength(6);
  });
});
