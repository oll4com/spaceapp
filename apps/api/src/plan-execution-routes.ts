import type { FastifyInstance, FastifyRequest } from "fastify";
import { preparePlanStages, startPlanExecutionRequestSchema, planStageOverrideRequestSchema, planExecutionControlRequestSchema, type ManagedPlanExecution, type StageModelSelection } from "@space/contracts";
import { PlanExecutionConflictError, type SpaceStore } from "@space/runtime";
import { executionControlPatch, stageOverridePatch, withPlanPaneMutation } from "./plan-execution-mutations.js";
import { PlanExecutionController, type PlanExecutionControllerOptions } from "./plan-execution-controller.js";
interface ExecutionTarget {
    paneId: string;
    sessionId: string;
    threadId: string;
    cwd: string;
}
interface Options extends Pick<PlanExecutionControllerOptions, 'resolve' | 'publish' | 'intervalMs' | 'maxStageAttempts'> {
    store: SpaceStore;
    target(owner: string, paneId: string, expectedSessionId?: string): Promise<ExecutionTarget>;
    assertStartControl(request: FastifyRequest, target: ExecutionTarget): Promise<void>;
    /** False on a dev instance, whose copied executions belong to stable. */
    autoStart?: boolean;
}
class ManagedPlanHttpError extends Error {
    constructor(message: string, readonly statusCode: number) { super(message); }
}
function httpError(message: string, statusCode: number): Error { return new ManagedPlanHttpError(message,statusCode); }
/** Shared mutation boundary for start and future managed control/override routes. */
export function assertManagedPlanMutationScope(request: FastifyRequest): void {
    if (request.user?.proofScope === 'READ_ONLY' || request.user?.automationScope === 'APP_DIAGNOSTICS')
        throw httpError('This session may not mutate managed plan executions.', 403);
}
export function registerPlanExecutionRoutes(app: FastifyInstance, options: Options): PlanExecutionController {
    const { store } = options;
    const controller = new PlanExecutionController({ ...options, repository: store.planExecutions,
        onError: error => app.log.error({ err: error }, 'Managed plan controller failed') });
    if (options.autoStart !== false) app.addHook('onReady', async () => controller.start());
    app.addHook('onClose', async () => controller.close());
    const owner = async (request: FastifyRequest) => {
        if (!request.user || request.user.role !== 'ADMIN' || request.user.automationScope)
            throw httpError('Administrator access is required.', 403);
        const actor = await store.getControlActor(request.user.id);
        if (!actor || actor.role !== 'ADMIN' || actor.automationScope)
            throw httpError('Administrator access is no longer available.', 403);
        return actor.id;
    };
    app.post<{
        Params: {
            id: string;
        };
    }>('/api/panes/:id/plan-executions', async (request, reply) => {
        assertManagedPlanMutationScope(request);
        const ownerUserId = await owner(request);
        const parsed = startPlanExecutionRequestSchema.safeParse(request.body);
        if (!parsed.success)
            throw httpError('Invalid plan execution request.', 400);
        const input = parsed.data;
        const target = await options.target(ownerUserId, request.params.id, input.expectedSessionId);
        await options.assertStartControl(request, target);
        const plan = await store.getClipboardItem(ownerUserId, input.planId);
        if (!plan || plan.source !== 'PLAN')
            throw httpError('PLAN was not found.', 404);
        const prepared = preparePlanStages(plan);
        if (prepared.issues.length)
            throw httpError(prepared.issues.join(' '), 409);
        try {
            const execution = await withPlanPaneMutation(store,target.paneId,async()=>{
                // Native configuration may have held the pane across asynchronous
                // router writes. Revalidate authority and identity after waiting.
                await owner(request);
                const current = await options.target(ownerUserId,target.paneId,input.expectedSessionId);
                if(current.sessionId !== target.sessionId || current.threadId !== target.threadId || current.cwd !== target.cwd)
                    throw httpError('Managed execution identity changed before creation.',409);
                await options.assertStartControl(request,current);
                return store.planExecutions.create({ ownerUserId, planId: plan.id, ...current, requestId: input.requestId,
                    snapshot: { text: plan.text, title: plan.title, stages: prepared.stages } }, true);
            });
            await controller.flushEvents();
            return reply.code(201).send(execution);
        }
        catch (error) {
            if (error instanceof PlanExecutionConflictError)
                throw httpError(error.message, 409);
            throw error;
        }
    });
    const authorizeMutation = async (request: FastifyRequest, execution: ManagedPlanExecution) => {
        await owner(request);
        const target = await options.target(execution.ownerUserId, execution.paneId, execution.sessionId);
        if (target.sessionId !== execution.sessionId || target.threadId !== execution.threadId || target.cwd !== execution.cwd || target.paneId !== execution.paneId)
            throw httpError('Managed execution identity changed.', 409);
        await options.assertStartControl(request, target);
        return options.resolve(execution);
    };
    const mutate = async (request: FastifyRequest, id: string, revision: number,
        change: { stageId: string; selection: StageModelSelection | null } | { action: 'pause' | 'resume' }) => {
        assertManagedPlanMutationScope(request);
        const ownerUserId = await owner(request);
        const execution = await store.planExecutions.get(ownerUserId, id);
        if (!execution) throw httpError('Plan execution was not found.', 404);
        if (execution.revision !== revision) throw httpError('Execution revision is stale.', 409);
        try {
            const control = await authorizeMutation(request, execution);
            const stage = execution.snapshot.stages.find(s => s.id === ('stageId' in change ? change.stageId : execution.snapshot.stages[execution.activeStageIndex]?.id));
            if (!stage) throw httpError('Stage was not found.', 404);
            if ('stageId' in change || change.action === 'resume') {
                const selection = 'selection' in change ? change.selection ?? stage : execution.overrides[stage.id] ?? stage;
                const models = await control.listModels();
                if (!models.some(m => m.id === selection.modelId && m.supportedReasoningEfforts.includes(selection.reasoningEffort)))
                    throw httpError('The selected model and reasoning effort are not advertised by this runtime.', 409);
            }
            const thread = await control.readThread?.(execution.threadId);
            if (!thread || thread.id !== execution.threadId || thread.cwd !== execution.cwd || ['notLoaded','systemError'].includes(thread.status))
                throw httpError('Native execution identity is unavailable.', 409);
            await authorizeMutation(request, execution);
            const patch = 'stageId' in change ? stageOverridePatch(execution, change.stageId, change.selection) : executionControlPatch(execution, change.action);
            const updated = await store.planExecutions.update(ownerUserId,id,revision,patch,undefined,true);
            await controller.flushEvents();
            return updated;
        } catch(error) {
            if (error instanceof PlanExecutionConflictError) throw httpError(error.message,409);
            if (error instanceof ManagedPlanHttpError) throw error;
            throw httpError('Managed execution authority or native state could not be confirmed.',409);
        }
    };
    app.patch<{Params:{id:string;stageId:string}}>('/api/plan-executions/:id/stages/:stageId/override', async request => {
        assertManagedPlanMutationScope(request);
        const parsed=planStageOverrideRequestSchema.safeParse(request.body);
        if(!parsed.success) throw httpError('Invalid stage override request.',400);
        return mutate(request,request.params.id,parsed.data.revision,{stageId:request.params.stageId,selection:parsed.data.selection});
    });
    app.post<{Params:{id:string}}>('/api/plan-executions/:id/control', async request => {
        assertManagedPlanMutationScope(request);
        const parsed=planExecutionControlRequestSchema.safeParse(request.body);
        if(!parsed.success) throw httpError('Invalid plan control request.',400);
        return mutate(request,request.params.id,parsed.data.revision,{action:parsed.data.action});
    });
    app.get<{
        Params: {
            id: string;
        };
    }>('/api/plan-executions/:id', async (request) => {
        const ownerUserId = await owner(request);
        const execution = await store.planExecutions.get(ownerUserId, request.params.id);
        if (!execution)
            throw httpError('Plan execution was not found.', 404);
        return execution;
    });
    app.get<{
        Params: {
            id: string;
        };
    }>('/api/panes/:id/plan-executions', async (request) => {
        const ownerUserId = await owner(request);
        return store.planExecutions.findForPane(ownerUserId, request.params.id);
    });
    return controller;
}
