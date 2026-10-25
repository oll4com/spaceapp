import { randomUUID } from "node:crypto";
import { managedPlanStageResultSchema, sameStageCriterion, type ManagedPlanExecution, type ManagedPlanStageResult } from "@space/contracts";
import { PlanExecutionConflictError, type ManagedPlanExecutionPatch, type PlanExecutionRepository, type PlanExecutionEvent } from "@space/runtime";
import { CodexManagedTurnDeliveryError, CodexSettingsRejectedError } from "@space/codex-app-server";
import type { CodexAppServerSocketControlService, CodexNativeThread, CodexManagedTurnObservation } from "@space/codex-app-server";
import { recordRecoveryEvent } from "./api-metrics.js";
/** The native surface the controller drives. Codex's app-server service is used as is; Claude panes
 * implement it over their PTY and transcript (plan-execution-claude-driver.ts). */
export type ManagedTurnDriver = Pick<CodexAppServerSocketControlService, "readThread" | "readThreadSettings" | "listModels" | "updateThreadSettings" | "startManagedTurn" | "interruptTurn">;
export const planStageOutputSchema = {
    type: "object", additionalProperties: false, required: ["outcome", "summary", "evidence"],
    properties: {
        outcome: { type: "string", enum: ["CONTINUE", "COMPLETED", "BLOCKED"] },
        summary: { type: "string" },
        evidence: { type: "array", items: { type: "object", additionalProperties: false,
                required: ["criterion", "result"], properties: { criterion: { type: "string" }, result: { type: "string" } } } }
    }
};
export interface PlanExecutionControllerOptions {
    repository: PlanExecutionRepository;
    /** Rechecks persisted ADMIN, pane/session/thread/cwd identity and runtime enablement. */
    resolve(execution: ManagedPlanExecution): Promise<ManagedTurnDriver>;
    publish(execution: PlanExecutionEvent): Promise<void>;
    intervalMs?: number;
    leaseMs?: number;
    /** Starts only after native history reports a closed turn; active work has no deadline. */
    closedTurnObservationTimeoutMs?: number;
    /** Native turns (START attempts) one stage may use before the execution fails; see SPACE_PLAN_STAGE_MAX_ATTEMPTS. */
    maxStageAttempts?: number;
    onError?(error: unknown): void;
}
/** Default per-stage budget of native turns: CONTINUE results, corrections and model retries all count. */
export const DEFAULT_PLAN_STAGE_MAX_ATTEMPTS = 20;
export const PLAN_STAGE_ATTEMPT_LIMIT = "PLAN_STAGE_ATTEMPT_LIMIT";
const runnable = new Set(["RUNNING", "SWITCHING_MODEL", "RESUMING_STAGE", "WAITING_FOR_INPUT", "WAITING_FOR_MODEL"]);
/** One centrally scheduled executor. Durable intent precedes every native mutation.
 * SETTINGS are idempotently reconciled against native identity/history/settings.
 * START intents are never resent, including PREPARED intents with unknown delivery.
 */
export class PlanExecutionController {
    private readonly workerId = randomUUID();
    private readonly acknowledgedInterrupts = new Map<string,string>();
    private readonly unacceptedStarts = new Map<string,CodexManagedTurnDeliveryError>();
    private readonly observations = new Map<string,CodexManagedTurnObservation>();
    private readonly closedTurnObservedAt = new Map<string, number>();
    private timer: ReturnType<typeof setTimeout> | null = null;
    private running: Promise<void> | null = null;
    private closed = false;
    constructor(private readonly options: PlanExecutionControllerOptions) { }
    start(): void {
        if (this.closed || this.timer)
            return;
        const schedule = () => {
            this.timer = setTimeout(() => {
                this.timer = null;
                void this.tick().catch(error => this.options.onError?.(error)).finally(() => {
                    if (!this.closed)
                        schedule();
                });
            }, this.options.intervalMs ?? 1000);
            this.timer.unref();
        };
        schedule();
    }
    async close(): Promise<void> {
        this.closed = true;
        if (this.timer)
            clearTimeout(this.timer);
        this.timer = null;
        await this.running;
        for (const observation of this.observations.values()) observation.close();
        this.observations.clear();
        this.unacceptedStarts.clear();
        this.acknowledgedInterrupts.clear();
        this.closedTurnObservedAt.clear();
    }
    tick(): Promise<void> {
        if (this.closed)
            return Promise.resolve();
        if (this.running)
            return this.running;
        this.running = this.run().finally(() => { this.running = null; });
        return this.running;
    }
    async flushEvents(): Promise<void> {
        try {
            for (const event of await this.options.repository.listPendingEvents()) {
                await this.options.publish(event);
                await this.options.repository.acknowledgeEvent(event.executionId,event.revision);
            }
        } catch(error) {
            this.options.onError?.(error);
            // Retain unacknowledged revisions, including terminal executions.
            // Relay read/write outages must not stop otherwise valid native work.
        }
    }
    private async run(): Promise<void> {
        await this.flushEvents();
        for (const candidate of await this.options.repository.listActive()) {
            if (this.closed)
                break;
            if (!runnable.has(candidate.status))
                continue;
            try {
                await this.advance(candidate.id);
            }
            catch (error) {
                this.options.onError?.(error);
            }
        }
        await this.flushEvents();
    }
    private modelRetry(execution: ManagedPlanExecution, retryAfterMs?: number): ManagedPlanExecutionPatch {
        const delay = Math.max(1000, retryAfterMs ?? Math.min(300000, 1000 * 2 ** Math.min(execution.retryCount, 9)));
        recordRecoveryEvent("plan_model_retry", "SCHEDULED");
        return { status: 'WAITING_FOR_MODEL', statusReason: 'The stage model is unavailable. Waiting to retry.',
            retryCount: execution.retryCount + 1, nextRetryAt: new Date(Date.now() + delay).toISOString() };
    }
    private async advance(id: string): Promise<void> {
        const repo = this.options.repository;
        const leaseMs = this.options.leaseMs ?? 60000;
        let execution = await repo.claim(id, this.workerId, Date.now(), leaseMs);
        if (!execution?.lease)
            return;
        const lease = execution.lease;
        const save = async (patch: ManagedPlanExecutionPatch) => {
            execution = await repo.update(execution!.ownerUserId, id, execution!.revision, patch, lease, true);
        };
        // Revalidate after every await which precedes a command. An expired lease may
        // not be reacquired by this worker to finish an old async continuation.
        const fence = async () => {
            if (this.closed)
                throw new PlanExecutionConflictError("Controller is stopping.");
            const current = await repo.claim(id, this.workerId, Date.now(), leaseMs);
            if (!current?.lease || current.lease.epoch !== lease.epoch || current.revision !== execution!.revision || Date.parse(current.lease.expiresAt) <= Date.now())
                throw new PlanExecutionConflictError("Controller lease or revision changed.");
            execution = current;
        };
        const resolve = async () => {
            const control = await this.options.resolve(execution!);
            await fence();
            if (!control.readThread || !control.readThreadSettings)
                throw Error("Native execution inspection is unavailable.");
            return control;
        };
        const read = async (control: ManagedTurnDriver): Promise<CodexNativeThread> => {
            const thread = await control.readThread!(execution!.threadId);
            await fence();
            if (thread.id !== execution!.threadId || thread.cwd !== execution!.cwd ||
                thread.status === "notLoaded" || thread.status === "systemError")
                throw Error("Native execution identity is unavailable.");
            return thread;
        };
        try {
            if (!runnable.has(execution.status))
                return;
            if (execution.status === "WAITING_FOR_MODEL" && execution.nextRetryAt && Date.parse(execution.nextRetryAt) > Date.now()) return;
            let control = await resolve();
            let thread = await read(control);
            const stage = execution.snapshot.stages[execution.activeStageIndex];
            if (!stage)
                throw Error("Execution stage is invalid.");
            const prompt = [`Immutable whole-plan context (shared specification and constraints apply to this stage):\n${execution.snapshot.text}`,
                        `Execute only stage ${stage.order}: ${stage.title}. Do not execute other stages; their descriptions are context only.`, stage.instructions,
                        `Completion criteria (return each exact criterion with concrete evidence):\n${stage.completionCriteria.join('\n')}`,
                        execution.checkpoint ? `Previous checkpoint: ${execution.checkpoint}` : '',
                        execution.attempts.some(a => a.stageId === stage.id && ['INTERRUPTED','FAILED'].includes(a.status)) ? 'Recovery: inspect the previous native turn and repository for partial actions and side effects before acting. Preserve completed work; never blindly repeat an unsafe action. If its outcome cannot be established, return BLOCKED and request input.' : '',
                        execution.correctionCount ? 'Correction: the previous result was incomplete. Return valid structured evidence; do not repeat completed actions.' : '',
                        'Return CONTINUE for further work in this stage, COMPLETED only when every criterion is met, or BLOCKED for a real obstacle. Never mark progress via legacy PLAN APIs.'].filter(Boolean).join('\n\n');
            if (prompt.trim().length > 20000) {
                await save({ status: "BLOCKED", statusReason: "The complete stage prompt, including whole-plan context, exceeds the 20,000 character native limit. Prepare a shorter plan with all required specifications and constraints before starting another execution." });
                return;
            }
            const settleUnaccepted = async (commandId: string, error: CodexManagedTurnDeliveryError) => {
                const paused = execution!.interruptReason === 'PAUSE';
                const overridden = execution!.interruptReason === 'OVERRIDE';
                await save({ status: paused ? 'PAUSED' : overridden || error.delivery === 'NOT_SENT' ? 'RESUMING_STAGE' : 'BLOCKED',
                    statusReason: 'The native command was not accepted.',
                    ...(!paused && !overridden && error.retryableFailure ? this.modelRetry(execution!,error.retryableFailure.retryAfterMs) : {}),
                    pendingCommand: null, interruptCommand: null, interruptReason: null,
                    attempts: execution!.attempts.map(a => a.commandId === commandId ? {...a,status:'FAILED',completedAt:new Date().toISOString()} : a) });
                this.unacceptedStarts.delete(commandId);
            };
            const pending = execution.pendingCommand;
            if (pending?.type === "START") {
                const unaccepted = this.unacceptedStarts.get(pending.id);
                if (unaccepted) {
                    if (thread.turns.some(turn => turn.clientUserMessageIds.includes(pending.id))) throw Error('Native acceptance contradicts rejection.');
                    await settleUnaccepted(pending.id,unaccepted);
                    return;
                }
                const matches = thread.turns.filter(turn => turn.clientUserMessageIds.includes(pending.id));
                const native = pending.turnId ? thread.turns.find(turn => turn.id === pending.turnId) : matches[0];
                const newTurns = thread.turns.filter(turn => !pending.baselineTurnIds.includes(turn.id));
                if (!native || matches.length !== 1 || matches[0]?.id !== native.id ||
                    newTurns.length !== 1 || newTurns[0]?.id !== native.id || thread.turns.at(-1)?.id !== native.id)
                    throw Error("Native turn acceptance is ambiguous; the command will not be resent.");
                const acknowledged = execution.interruptCommand;
                if (acknowledged?.turnId === native.id && this.acknowledgedInterrupts.get(acknowledged.id) === native.id) {
                    await save({ interruptCommand: { ...acknowledged, status: 'SENT' } });
                    this.acknowledgedInterrupts.delete(acknowledged.id);
                }
                const attempt = execution.attempts.find(a => a.commandId === pending.id);
                if (!attempt)
                    throw Error("Native turn has no durable attempt.");
                const observation = this.observations.get(pending.id);
                const evidence = observation?.read();
                const actualSelection = evidence?.status === "VERIFIED" ? evidence.selection : attempt.actualSelection;
                const observed = { ...attempt, turnId: native.id, actualSelection, status: "RUNNING" as const };
                if (pending.turnId !== native.id || pending.status !== "SENT" || attempt.turnId !== native.id ||
                    attempt.status !== "RUNNING" || (actualSelection && !attempt.actualSelection)) {
                    await save({ pendingCommand: { ...pending, status: "SENT", turnId: native.id },
                        attempts: execution.attempts.map(a => a.id === attempt.id ? observed : a) });
                }
                if (evidence?.status === "INVALID") throw Error("Native observation continuity or configuration changed.");
                if (native.status === "inProgress") {
                    if (execution.interruptReason) {
                        let intent = execution.interruptCommand;
                        if (!intent) {
                            intent = { ...pending, id: randomUUID(), type: 'INTERRUPT', turnId: native.id, status: 'PREPARED', preparedAt: new Date().toISOString() };
                            await save({ interruptCommand: intent });
                        }
                        if (intent.turnId !== native.id || intent.stageId !== stage.id) throw Error('Interrupt identity mismatch.');
                        if (intent.status !== 'SENT') {
                            const command = intent;
                            control = await resolve();
                            try {
                                await control.interruptTurn({ threadId: execution.threadId, turnId: native.id, beforeSend: async () => {
                                    const currentControl = await resolve();
                                    const latest = await read(currentControl);
                                    if (latest.turns.at(-1)?.id !== native.id || latest.turns.at(-1)?.status !== 'inProgress')
                                        throw new PlanExecutionConflictError('Native turn closed before interrupt.');
                                    await resolve();
                                    await save({ interruptCommand: { ...command, status: 'UNKNOWN' } });
                                    await fence();
                                } });
                                // The exact native acknowledgment remains valid when a newer
                                // choice wins CAS. Reconcile it under the next tick's lease;
                                // never let this stale continuation overwrite that choice.
                                this.acknowledgedInterrupts.set(command.id,native.id);
                                await fence();
                                await save({ interruptCommand: { ...command, status: 'SENT' } });
                                this.acknowledgedInterrupts.delete(command.id);
                            } catch(error) {
                                if (error instanceof PlanExecutionConflictError) throw error;
                                // Retain the exact idempotent interrupt intent. Read native status
                                // before retrying; never infer stopped from an RPC acknowledgment.
                                await fence();
                            }
                        }
                        return;
                    }
                    if (thread.activeFlags.some(flag => flag === "waitingOnApproval" || flag === "waitingOnUserInput")) {
                        if (execution.status !== "WAITING_FOR_INPUT")
                            await save({ status: "WAITING_FOR_INPUT", statusReason: "Native turn requires approval or input." });
                    } else if (execution.status !== "RUNNING") {
                        await save({ status: "RUNNING", statusReason: null });
                    }
                    return;
                }
                // History and the retained observer use different connections. Closed
                // history can overtake its notification without losing continuity.
                // Preserve the receipt/START until that healthy observation resolves.
                if (!actualSelection && evidence?.status === "OBSERVING") {
                    const firstClosedAt = this.closedTurnObservedAt.get(pending.id) ?? Date.now();
                    this.closedTurnObservedAt.set(pending.id, firstClosedAt);
                    if (Date.now() - firstClosedAt >= (this.options.closedTurnObservationTimeoutMs ?? 10000)) {
                        await save({ status: "BLOCKED", statusReason: "The native turn closed, but its closure notification was not observed before the deadline. Review before resuming." });
                        return;
                    }
                    const statusReason = "Waiting for the native turn closure notification.";
                    if (execution.status !== "RUNNING" || execution.statusReason !== statusReason)
                        await save({ status: "RUNNING", statusReason });
                    return;
                }
                if (!actualSelection || actualSelection.threadId !== execution.threadId || actualSelection.turnId !== native.id ||
                    actualSelection.commandId !== pending.id || actualSelection.modelId !== pending.selection.modelId ||
                    actualSelection.reasoningEffort !== pending.selection.reasoningEffort || native.userMessageCount !== 1) {
                    await save({ status: "BLOCKED", statusReason: "Native turn configuration could not be verified because its observation is missing or inconsistent. The START command will not be resent." });
                    return;
                }
                if (native.status !== "completed") {
                    const controlled = execution.interruptReason === 'OVERRIDE' && execution.interruptCommand?.status === 'SENT' && execution.interruptCommand?.turnId === native.id;
                    await save({ status: native.status === "interrupted" ? controlled ? "RESUMING_STAGE" : "PAUSED" : "BLOCKED", statusReason: "Native turn stopped before stage completion.",
                        ...(native.status === 'failed' && native.retryableFailure && execution.interruptReason !== 'PAUSE' ? this.modelRetry(execution,native.retryableFailure.retryAfterMs) : {}),
                        pendingCommand: null, interruptCommand: null, interruptReason: null, attempts: execution.attempts.map(a => a.id === attempt.id ? { ...observed, status: native.status === 'interrupted' ? 'INTERRUPTED' : 'FAILED', completedAt: new Date().toISOString() } : a) });
                    return;
                }
                let result: ManagedPlanStageResult | null = null;
                if (native.itemsComplete && native.resultText) {
                    try {
                        result = managedPlanStageResultSchema.parse(JSON.parse(native.resultText));
                    }
                    catch { /* One bounded correction below. */ }
                }
                const sufficient = result && (result.outcome !== "COMPLETED" || stage.completionCriteria.every(criterion => result!.evidence.some(e => sameStageCriterion(e.criterion, criterion) && e.result.trim().length > 0)));
                const attempts = execution.attempts.map(a => a.id === attempt.id ? {
                    ...observed, status: "COMPLETED" as const, completedAt: new Date().toISOString(), result
                } : a);
                if (!sufficient) {
                    await save({ attempts, pendingCommand: null, interruptCommand: null, interruptReason: null, correctionCount: execution.correctionCount + 1,
                        status: execution.interruptReason === "PAUSE" ? "PAUSED" : execution.correctionCount === 0 ? "RESUMING_STAGE" : "BLOCKED",
                        statusReason: "Native result is incomplete or lacks criterion evidence." });
                    return;
                }
                const completedStageIds = result!.outcome === "COMPLETED" ? [...execution.completedStageIds, stage.id] : execution.completedStageIds;
                const done = completedStageIds.length === execution.snapshot.stages.length;
                await save({ attempts, pendingCommand: null, interruptCommand: null, interruptReason: null, completedStageIds, checkpoint: result!.summary, retryCount: 0, nextRetryAt: null,
                    activeStageIndex: done ? execution.activeStageIndex : execution.activeStageIndex + (result!.outcome === 'COMPLETED' ? 1 : 0),
                    correctionCount: result!.outcome === 'COMPLETED' ? 0 : execution.correctionCount,
                    status: result!.outcome === 'BLOCKED' ? 'BLOCKED' : done ? 'COMPLETED' : execution.interruptReason === 'PAUSE' ? 'PAUSED' : 'RESUMING_STAGE',
                    statusReason: result!.outcome === 'BLOCKED' ? result!.summary : null });
                return;
            }
            // Never interrupt or queue behind a user-owned turn.
            if (thread.status === "active" || thread.turns.some(turn => turn.status === "inProgress"))
                return;
            // A stage that keeps returning CONTINUE, failing with retryable errors or
            // being refused delivery would otherwise start native turns forever.
            const maxStageAttempts = Math.max(1, Math.trunc(this.options.maxStageAttempts ?? DEFAULT_PLAN_STAGE_MAX_ATTEMPTS));
            if (execution.attempts.filter(attempt => attempt.stageId === stage.id).length >= maxStageAttempts) {
                await save({ status: "FAILED", errorCode: PLAN_STAGE_ATTEMPT_LIMIT, pendingCommand: null, nextRetryAt: null,
                    statusReason: `Stage ${stage.order} used its limit of ${maxStageAttempts} native turns without completing. No further turn was sent. Review the stage, then start a new execution.` });
                return;
            }
            const selection = execution.overrides[stage.id] ?? { modelId: stage.modelId, reasoningEffort: stage.reasoningEffort };
            if (!control.startManagedTurn) throw Error("Native managed turn observation is unavailable.");
            const models = await control.listModels();
            await fence();
            if (!models.some(model => model.id === selection.modelId && model.supportedReasoningEfforts.includes(selection.reasoningEffort))) {
                await save(this.modelRetry(execution));
                return;
            }
            if (pending && (pending.type !== "SETTINGS" || pending.stageId !== stage.id || pending.selection.modelId !== selection.modelId || pending.selection.reasoningEffort !== selection.reasoningEffort)) throw Error("Settings intent does not match the stage selection.");
            const command = pending ?? { id: randomUUID(), type: "SETTINGS" as const, stageId: stage.id, turnId: null, selection,
                preparedAt: new Date().toISOString(), status: "PREPARED" as const, baselineTurnIds: thread.turns.map(t => t.id) };
            if (!pending) await save({ status: "SWITCHING_MODEL", pendingCommand: command, statusReason: null, nextRetryAt: null });
            control = await resolve();
            thread = await read(control);
            if (thread.status !== "idle" || thread.turns.some(turn => turn.status === 'inProgress') ||
                JSON.stringify(thread.turns.map(t => t.id)) !== JSON.stringify(command.baselineTurnIds))
                throw Error("Native activity changed before settings command.");
            await fence();
            const beforeSettings = await control.readThreadSettings!(execution.threadId);
            await fence();
            if (beforeSettings.cwd !== execution.cwd || beforeSettings.isTurnActive) throw Error("Native settings identity changed.");
            if (pending?.status === 'UNKNOWN' && (beforeSettings.modelId !== selection.modelId || beforeSettings.reasoningEffort !== selection.reasoningEffort)) {
                // Readback precedes retry permission for an uncertain settings write.
                // SETTINGS are idempotent, but an unchanged advertised model may be
                // temporarily rejected; do not hammer it at scheduler frequency.
                await resolve();
                await save({ ...this.modelRetry(execution), pendingCommand: { ...command, status: 'PREPARED' } });
                return;
            }
            if (!pending || beforeSettings.modelId !== selection.modelId || beforeSettings.reasoningEffort !== selection.reasoningEffort) try { await control.updateThreadSettings({ threadId: execution.threadId, model: selection.modelId, reasoningEffort: selection.reasoningEffort, beforeSend: async () => {
                    const latestControl = await resolve();
                    const latest = await read(latestControl);
                    if (latest.status !== "idle" || latest.turns.some(turn => turn.status === "inProgress") ||
                        JSON.stringify(latest.turns.map(turn => turn.id)) !== JSON.stringify(command.baselineTurnIds))
                        throw new PlanExecutionConflictError("Native activity changed before command send.");
                    await resolve();
                    await fence();
                } });
            } catch(error) {
                if (error instanceof PlanExecutionConflictError) throw error;
                await resolve();
                if (error instanceof CodexSettingsRejectedError) {
                    await save({ pendingCommand: error.retryableFailure ? { ...command, status: 'PREPARED' } : null,
                        ...(error.retryableFailure ? this.modelRetry(execution,error.retryableFailure.retryAfterMs) :
                            { status: 'BLOCKED' as const, statusReason: 'Native thread settings were rejected. Review the stage selection before resuming.' }) });
                } else await save({pendingCommand:{...command,status:'UNKNOWN'}, status:'RESUMING_STAGE', statusReason:'Reconciling native thread settings.'});
                return;
            }
            await fence();
            const settings = await control.readThreadSettings!(execution.threadId);
            await fence();
            if (settings.cwd !== execution.cwd || settings.modelId !== selection.modelId || settings.reasoningEffort !== selection.reasoningEffort || settings.isTurnActive)
                throw Error("Native stage settings were not confirmed.");
            await save({ pendingCommand: { ...command, status: "SENT" } });
            control = await resolve();
            thread = await read(control);
            if (thread.status !== "idle" || thread.turns.some(turn => turn.status === 'inProgress') || thread.modelId !== selection.modelId || thread.reasoningEffort !== selection.reasoningEffort ||
                JSON.stringify(thread.turns.map(t => t.id)) !== JSON.stringify(command.baselineTurnIds))
                throw Error("Native activity changed before stage start.");
            const start = { ...command, id: randomUUID(), type: "START" as const, preparedAt: new Date().toISOString() };
            await save({ pendingCommand: start, attempts: [...execution.attempts, { id: randomUUID(), stageId: stage.id, commandId: start.id, turnId: null,
                        ...selection, actualSelection: null, status: "PREPARED", startedAt: start.preparedAt, completedAt: null, result: null }] });
            control = await resolve();
            // START is durably prepared even if this process dies immediately here.
            await fence();
            try {
                const response = await control.startManagedTurn!({ threadId: execution.threadId, model: selection.modelId, reasoningEffort: selection.reasoningEffort,
                    clientUserMessageId: start.id, outputSchema: planStageOutputSchema, beforeSend: async () => {
                        const latestControl = await resolve();
                        const latest = await read(latestControl);
                        if (latest.status !== "idle" || latest.turns.some(turn => turn.status === "inProgress") ||
                            JSON.stringify(latest.turns.map(turn => turn.id)) !== JSON.stringify(command.baselineTurnIds))
                            throw new PlanExecutionConflictError("Native activity changed before command send.");
                        await resolve();
                        await fence();
                    },
                    prompt });
                this.observations.set(start.id,response.observation);
                await fence();
                await save({ status: "RUNNING", nextRetryAt: null, pendingCommand: { ...start, status: "SENT", turnId: response.turnId },
                    attempts: execution.attempts.map(a => a.commandId === start.id ? { ...a, status: "RUNNING", turnId: response.turnId } : a) });
            }
            catch (error) {
                if (error instanceof PlanExecutionConflictError)
                    throw error;
                if (error instanceof CodexManagedTurnDeliveryError && error.delivery !== 'UNKNOWN') {
                    // Retain a demonstrable non-acceptance receipt through a revision race.
                    // A new fenced tick applies it to the latest choice. Restart before its
                    // durable checkpoint loses this proof and must block, never guess.
                    this.unacceptedStarts.set(start.id,error);
                    await resolve();
                    await settleUnaccepted(start.id,error);
                } else await save({ status: "RUNNING", pendingCommand: { ...start, status: "UNKNOWN" }, statusReason: "Reconciling native command acceptance." });
            }
        }
        catch (error) {
            if (!(error instanceof PlanExecutionConflictError)) {
                // Do not expose raw RPC errors or user content through public status.
                await save({ status: "BLOCKED", statusReason: "Execution identity, authorization or native state could not be confirmed. Review before resuming." });
            }
        }
        finally {
            if (execution) {
                const latest = await repo.get(execution.ownerUserId,id);
                // Close only durably consumed observers, or a deliberately blocked execution.
                // A CAS failure may leave a newer override still awaiting this same receipt.
                execution = latest ?? execution;
                for (const command of execution.commands) {
                    if (command.type === 'INTERRUPT' && (command.id !== execution.interruptCommand?.id || !runnable.has(execution.status)))
                        this.acknowledgedInterrupts.delete(command.id);
                }
                for (const attempt of execution.attempts) {
                    if (runnable.has(execution.status) && execution.pendingCommand?.id === attempt.commandId) continue;
                    this.unacceptedStarts.delete(attempt.commandId);
                    this.observations.get(attempt.commandId)?.close();
                    this.observations.delete(attempt.commandId);
                    this.closedTurnObservedAt.delete(attempt.commandId);
                }
            }
            await repo.release(id, lease);
        }
    }
}
