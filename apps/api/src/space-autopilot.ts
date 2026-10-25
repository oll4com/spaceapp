import {
  type ControlAction,
  type ControlOperation,
  type ControlResult,
  type ConcurrencyConflictOutcome,
  type TaskCompletionOutcome,
  type RecoveryActionOutcome,
  type AgentRoute
} from "@space/contracts";
import { makeSpaceId } from "@space/runtime";
import type { SpaceControl, ControlActor } from "./space-control.js";
import type { DecisionsService } from "./decisions-service.js";

export interface SpaceAutopilotOptions {
  spaceControl: SpaceControl;
  decisionsService: DecisionsService;
}

export interface AutopilotAgentRoute {
  available: boolean;
  agent: AgentRoute | null;
  confidence: number | null;
  tier: "mini" | "standard" | "frontier";
  degraded?: boolean;
}

export interface AutopilotModelTier {
  tier: "mini" | "standard" | "frontier";
  score: number;
  recommendedModel: string;
  reasoning?: string;
}

export interface AutopilotCycleInput {
  actor: ControlActor;
  roomId: string;
  prompt: string;
  targetFiles?: string[];
  plannedActions?: ControlAction[];
  dryRunFirst?: boolean;
}

export interface AutopilotCycleResult {
  success: boolean;
  cycleId: string;
  prompt: string;
  route: AutopilotAgentRoute;
  modelTier: AutopilotModelTier;
  concurrency?: ConcurrencyConflictOutcome;
  preflightValidated: boolean;
  operation?: ControlOperation;
  verification: {
    verified: boolean;
    stateRevision?: number;
    taskJudgement?: TaskCompletionOutcome;
    recoveryRecommendation?: RecoveryActionOutcome;
    details?: string;
  };
}

export function createSpaceAutopilot(options: SpaceAutopilotOptions) {
  const { spaceControl, decisionsService } = options;

  async function runCycle(input: AutopilotCycleInput): Promise<AutopilotCycleResult> {
    const cycleId = makeSpaceId("autopilot");
    const { actor, roomId, prompt, targetFiles = [], plannedActions, dryRunFirst = true } = input;

    // 1. INSPECT (Room state, active tasks)
    await spaceControl.inspect(actor, {
      section: "STATE",
      roomId,
      offset: 0,
      limit: 10
    });

    // 2. JEV DECIDE (route, model tier, concurrency conflict)
    const route = await decisionsService.routeAgentTask(prompt);
    const modelTier = await decisionsService.evaluateModelTier(prompt);
    let concurrency: ConcurrencyConflictOutcome | undefined;

    if (targetFiles.length > 0) {
      concurrency = await decisionsService.evaluateConcurrencyConflict({
        targetFiles,
        activeLockedFiles: [],
        taskDescription: prompt
      });
      if (concurrency.action === "wait" || concurrency.action === "queue") {
        return {
          success: false,
          cycleId,
          prompt,
          route,
          modelTier,
          concurrency,
          preflightValidated: false,
          verification: {
            verified: false,
            details: `Concurrency conflict: execution postponed with action '${concurrency.action}' for files: ${concurrency.conflictingFiles.join(", ")}`
          }
        };
      }
    }

    if (route.agent === "clarify" || (route.confidence !== null && route.confidence > 0.65 && route.agent === null)) {
      return {
        success: false,
        cycleId,
        prompt,
        route,
        modelTier,
        concurrency,
        preflightValidated: false,
        verification: {
          verified: false,
          details: "Execution halted: prompt is ambiguous or requires clarification before proceeding."
        }
      };
    }

    // Determine actions to execute
    let actions: ControlAction[] = plannedActions ?? [];
    if (actions.length === 0) {
      actions = [
        {
          kind: "pane",
          operation: "prompt",
          target: { state: "OPEN" },
          text: prompt,
          when: "NOW"
        }
      ];
    }

    // 3. DRY-RUN PREFLIGHT (if requested)
    let preflightValidated = false;
    if (dryRunFirst) {
      const preflightOp = await spaceControl.execute(
        actor,
        {
          roomId,
          requestId: `${cycleId}-preflight`,
          dryRun: true,
          actions
        },
        true
      );
      if (preflightOp.status === "FAILED") {
        const failureDetail = preflightOp.results.find((r: ControlResult) => r.status === "FAILED")?.detail ?? "Preflight failed.";
        return {
          success: false,
          cycleId,
          prompt,
          route,
          modelTier,
          concurrency,
          preflightValidated: false,
          operation: preflightOp,
          verification: {
            verified: false,
            details: `Dry-run preflight failed: ${failureDetail}`
          }
        };
      }
      preflightValidated = true;
    }

    // 4. EXECUTE (Full safety gate + audit trail enforced in spaceControl.execute)
    const operation = await spaceControl.execute(
      actor,
      {
        roomId,
        requestId: cycleId,
        dryRun: false,
        actions
      },
      true
    );

    // 5. VERIFY (Inspect state post-execution)
    const postInspection = (await spaceControl.inspect(actor, {
      section: "STATE",
      roomId,
      offset: 0,
      limit: 10
    })) as any;

    const opSuccess = operation.status === "COMPLETED";
    let recoveryRec: RecoveryActionOutcome | undefined;
    let taskJudgement: TaskCompletionOutcome | undefined;

    if (!opSuccess) {
      const firstError = operation.results.find((r: ControlResult) => r.status === "FAILED")?.detail ?? "Operation failed.";
      recoveryRec = await decisionsService.selectRecoveryAction({
        task: prompt,
        failedCommand: "space_execute",
        errorSnippet: firstError,
        attemptCount: 1
      });
    } else {
      taskJudgement = await decisionsService.judgeTaskCompletion({
        task: prompt,
        changedFiles: targetFiles,
        testOutput: operation.results.map((r: ControlResult) => r.detail).join("\n")
      });
    }

    return {
      success: opSuccess,
      cycleId,
      prompt,
      route,
      modelTier,
      concurrency,
      preflightValidated,
      operation,
      verification: {
        verified: opSuccess,
        stateRevision: postInspection?.revision ?? postInspection?.state?.revision,
        taskJudgement,
        recoveryRecommendation: recoveryRec,
        details: opSuccess ? "Autopilot cycle completed and verified successfully." : "Autopilot cycle encountered action failures."
      }
    };
  }

  return {
    runCycle
  };
}

export type SpaceAutopilot = ReturnType<typeof createSpaceAutopilot>;
