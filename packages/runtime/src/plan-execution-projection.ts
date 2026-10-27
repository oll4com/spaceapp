import { planStepSchema, sameStageCriterion, type ClipboardItem, type ManagedPlanExecution } from "@space/contracts";
import { PlanExecutionConflictError } from "./plan-execution-repository.js";
/** Projection accepts only repository state, never a public progress payload. */
export function managedPlanProjection(execution: ManagedPlanExecution): Pick<ClipboardItem, 'steps' | 'isCompleted' | 'executionStatus' | 'progressPercentage' | 'activeAgent' | 'lastProgressAt'> {
    const stages = execution.snapshot.stages;
    if (new Set(execution.completedStageIds).size !== execution.completedStageIds.length ||
        execution.completedStageIds.some((id, index) => stages[index]?.id !== id))
        throw new PlanExecutionConflictError("Completed stages must be a contiguous prefix.");
    for (const id of execution.completedStageIds) {
        const stage = stages.find(s => s.id === id)!;
        if (!execution.attempts.some(a => a.stageId === id && a.turnId && a.status === 'COMPLETED' && a.actualSelection &&
            a.actualSelection.source === 'NATIVE_ACCEPTED_TURN_CONFIGURATION' && a.actualSelection.threadId===execution.threadId &&
            a.actualSelection.turnId===a.turnId && a.actualSelection.commandId===a.commandId &&
            a.actualSelection.modelId===a.modelId && a.actualSelection.reasoningEffort===a.reasoningEffort && a.result?.outcome === 'COMPLETED'  && stage.completionCriteria.every(c => a.result!.evidence.some(e => sameStageCriterion(e.criterion, c) && e.result.trim()))))
            throw new PlanExecutionConflictError("Stage completion requires native selection and criterion evidence.");
    }
    const done = execution.completedStageIds.length === stages.length;
    if ((execution.status === 'COMPLETED') !== done)
        throw new PlanExecutionConflictError("Execution completion does not match its stages.");
    const steps = stages.map((stage, index) => {
        const complete = execution.completedStageIds.includes(stage.id);
        const attempts = execution.attempts.filter(a => a.stageId === stage.id);
        const last = attempts.at(-1);
        return planStepSchema.parse({ ...stage, status: complete ? 'COMPLETED' : index === execution.activeStageIndex ? 'IN_PROGRESS' : 'PENDING',
            progress: complete ? 100 : 0, agent: last?.actualSelection?.modelId ?? null,
            notes: last?.result?.summary.slice(0, 1000) ?? null,
            proof: complete ? last?.result?.evidence.map(e => `${e.criterion}: ${e.result}`).join('\n').slice(0, 1000) : null,
            startedAt: attempts[0]?.startedAt ?? null, completedAt: complete ? last?.completedAt ?? null : null });
    });
    return { steps, isCompleted: done, executionStatus: done ? 'COMPLETED' : 'IN_PROGRESS',
        progressPercentage: Math.floor(execution.completedStageIds.length / stages.length * 100),
        activeAgent: done ? null : steps[execution.activeStageIndex]?.agent ?? null, lastProgressAt: execution.updatedAt };
}
