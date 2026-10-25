import { describe, expect, it } from "vitest";
import { createSpaceAutopilot } from "../space-autopilot.js";
import type { SpaceControl, ControlActor } from "../space-control.js";
import type { DecisionsService } from "../decisions-service.js";
import type { ControlOperation } from "@space/contracts";

describe("Space Autopilot Orchestrator", () => {
  const mockActor: ControlActor = { id: "user_test", role: "ADMIN" };

  it("runs full inspect -> decide -> dryRun preflight -> execute -> verify loop without external LLM", async () => {
    let inspectCount = 0;
    let executeCalls: any[] = [];
    let taskJudged = false;

    const mockSpaceControl = {
      async inspect(actor: ControlActor, query: any) {
        inspectCount++;
        return {
          revision: 42,
          state: { revision: 42, panes: [] }
        };
      },
      async execute(actor: ControlActor, raw: any, waitForCompletion: boolean) {
        executeCalls.push(raw);
        return {
          id: raw.requestId,
          actorId: actor.id,
          roomId: raw.roomId,
          requestId: raw.requestId,
          payloadHash: "mock-hash",
          status: "COMPLETED",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          results: [
            {
              index: 0,
              status: "COMPLETED",
              detail: "Action succeeded",
              evidence: { output: "OK" }
            }
          ],
          cancelRequested: false,
          command: raw,
          nextIndex: 1
        } as ControlOperation;
      }
    } as unknown as SpaceControl;

    const mockDecisionsService = {
      async routeAgentTask(prompt: string) {
        return {
          available: true,
          agent: "codex" as const,
          confidence: 0.95,
          tier: "frontier" as const
        };
      },
      async evaluateModelTier(prompt: string) {
        return {
          tier: "standard" as const,
          score: 3,
          recommendedModel: "gemini-3.8-flash"
        };
      },
      async evaluateConcurrencyConflict(input: any) {
        return {
          available: true,
          action: "allow" as const,
          conflictingFiles: [],
          confidence: 0.99
        };
      },
      async judgeTaskCompletion(input: any) {
        taskJudged = true;
        return {
          available: true,
          status: "YES" as const,
          confidence: 0.95
        };
      },
      async selectRecoveryAction(error: any) {
        return {
          available: true,
          action: "retry_same_agent" as const,
          confidence: 0.9
        };
      }
    } as unknown as DecisionsService;

    const autopilot = createSpaceAutopilot({
      spaceControl: mockSpaceControl,
      decisionsService: mockDecisionsService
    });

    const result = await autopilot.runCycle({
      actor: mockActor,
      roomId: "room_test_1",
      prompt: "Add a unit test for autopilot orchestrator",
      targetFiles: ["apps/api/src/space-autopilot.ts"],
      dryRunFirst: true
    });

    expect(result.success).toBe(true);
    expect(result.preflightValidated).toBe(true);
    expect(inspectCount).toBeGreaterThanOrEqual(2);
    expect(executeCalls).toHaveLength(2);
    expect(executeCalls[0].dryRun).toBe(true);
    expect(executeCalls[1].dryRun).toBe(false);
    expect(result.verification.verified).toBe(true);
    expect(result.verification.taskJudgement?.status).toBe("YES");
    expect(taskJudged).toBe(true);
  });

  it("halts execution when prompt is ambiguous and clarification is required", async () => {
    let executeCalled = false;

    const mockSpaceControl = {
      async inspect() { return { revision: 1 }; },
      async execute() { executeCalled = true; throw new Error("Should not execute"); }
    } as unknown as SpaceControl;

    const mockDecisionsService = {
      async routeAgentTask() {
        return {
          available: true,
          agent: "clarify" as const,
          confidence: 0.9,
          tier: "mini" as const
        };
      },
      async evaluateModelTier() {
        return { tier: "mini" as const, score: 1, recommendedModel: "gemini-3.8-flash-lite" };
      }
    } as unknown as DecisionsService;

    const autopilot = createSpaceAutopilot({
      spaceControl: mockSpaceControl,
      decisionsService: mockDecisionsService
    });

    const result = await autopilot.runCycle({
      actor: mockActor,
      roomId: "room_test_2",
      prompt: "do something"
    });

    expect(result.success).toBe(false);
    expect(executeCalled).toBe(false);
    expect(result.verification.details).toContain("ambiguous");
  });

  it("postpones execution when concurrency conflict is detected", async () => {
    let executeCalled = false;

    const mockSpaceControl = {
      async inspect() { return { revision: 1 }; },
      async execute() { executeCalled = true; throw new Error("Should not execute"); }
    } as unknown as SpaceControl;

    const mockDecisionsService = {
      async routeAgentTask() {
        return { available: true, agent: "codex" as const, confidence: 0.9, tier: "frontier" as const };
      },
      async evaluateModelTier() {
        return { tier: "frontier" as const, score: 5, recommendedModel: "claude-3.5-sonnet" };
      },
      async evaluateConcurrencyConflict(input: any) {
        return {
          available: true,
          action: "wait" as const,
          conflictingFiles: ["apps/api/src/app.ts"],
          confidence: 0.95
        };
      }
    } as unknown as DecisionsService;

    const autopilot = createSpaceAutopilot({
      spaceControl: mockSpaceControl,
      decisionsService: mockDecisionsService
    });

    const result = await autopilot.runCycle({
      actor: mockActor,
      roomId: "room_test_3",
      prompt: "Refactor core router",
      targetFiles: ["apps/api/src/app.ts"]
    });

    expect(result.success).toBe(false);
    expect(executeCalled).toBe(false);
    expect(result.concurrency?.action).toBe("wait");
  });

  it("selects recovery action when execution action fails", async () => {
    const mockSpaceControl = {
      async inspect() { return { revision: 1 }; },
      async execute(actor: any, raw: any) {
        if (raw.dryRun) {
          return { status: "COMPLETED", results: [] } as any;
        }
        return {
          status: "FAILED",
          results: [{ index: 0, status: "FAILED", detail: "Network timeout", error: "TIMEOUT" }]
        } as any;
      }
    } as unknown as SpaceControl;

    let recoverySelected = false;
    const mockDecisionsService = {
      async routeAgentTask() {
        return { available: true, agent: "shell_fast" as const, confidence: 0.9, tier: "mini" as const };
      },
      async evaluateModelTier() {
        return { tier: "mini" as const, score: 1, recommendedModel: "gemini-3.8-flash-lite" };
      },
      async selectRecoveryAction(error: any) {
        recoverySelected = true;
        return {
          available: true,
          action: "retry_same_agent" as const,
          confidence: 0.85
        };
      }
    } as unknown as DecisionsService;

    const autopilot = createSpaceAutopilot({
      spaceControl: mockSpaceControl,
      decisionsService: mockDecisionsService
    });

    const result = await autopilot.runCycle({
      actor: mockActor,
      roomId: "room_test_4",
      prompt: "Run quick ping"
    });

    expect(result.success).toBe(false);
    expect(recoverySelected).toBe(true);
    expect(result.verification.recoveryRecommendation?.action).toBe("retry_same_agent");
  });
});
