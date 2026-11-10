import { expect } from "vitest";
import { InMemorySpaceStore } from "@space/runtime";
import type { CodexAppServerSocketControlService, CodexNativeThread } from "@space/codex-app-server";
import { PlanExecutionController } from "../../src/plan-execution-controller.js";

// A managed plan execution on an in-memory store with a fake native Codex control, shared by plan-execution-controller
// and plan-execution-proof tests.
export async function fixture(instructions = 'Do first', stages = [
        { id: 'one', order: 1, title: 'First', modelId: 'model-a', reasoningEffort: 'high', instructions, completionCriteria: ['First tested'] },
        { id: 'two', order: 2, title: 'Second', modelId: 'model-b', reasoningEffort: 'low', instructions: 'Do second', completionCriteria: ['Second tested'] }
    ], text = 'Plan') {
    const store = new InMemorySpaceStore();
    const plan = store.upsertClipboardItem({ ownerUserId: 'user:owner', source: 'PLAN', minimumModel: 'model-a', text, steps: stages });
    const execution = await store.planExecutions.create({ ownerUserId: 'user:owner', planId: plan.id, paneId: 'pane', sessionId: 'session', threadId: 'thread', cwd: '/project', requestId: 'request', snapshot: { text: plan.text, title: null, stages } });
    const thread: CodexNativeThread = { id: 'thread', cwd: '/project', modelId: 'global-default', reasoningEffort: 'medium', status: 'idle', activeFlags: [], turns: [] };
    const sent: Parameters<CodexAppServerSocketControlService['startTurn']>[0][] = [];
    let authorized = true;
    let timeout = false;
    const control: CodexAppServerSocketControlService = {
        listModels: async () => stages.map(s => ({ id: s.modelId, displayName: s.modelId, isDefault: false, defaultReasoningEffort: s.reasoningEffort, supportedReasoningEfforts: [s.reasoningEffort] })),
        readThread: async () => structuredClone(thread),
        readThreadSettings: async () => ({ ...thread, isTurnActive: thread.status === 'active' }),
        updateThreadSettings: async (i) => {
            const record = await store.planExecutions.get('user:owner', execution.id);
            expect(record?.pendingCommand).toMatchObject({ type: 'SETTINGS', selection: { modelId: i.model, reasoningEffort: i.reasoningEffort } });
            thread.modelId = i.model;
            thread.reasoningEffort = i.reasoningEffort;
        },
        interruptTurn: async () => { throw Error('must preserve unrelated turns'); },
        startTurn: async (i) => {
            const record = await store.planExecutions.get('user:owner', execution.id);
            expect(record?.pendingCommand).toMatchObject({ type: 'START', id: i.clientUserMessageId });
            expect(record?.lease).not.toBeNull();
            sent.push(i);
            thread.turns.push({ id: `turn-${sent.length}`, status: 'inProgress', clientUserMessageIds: [i.clientUserMessageId], userMessageCount:1, resultText: null, itemsComplete: true });
            thread.status = 'active';
            if (timeout)
                throw Error('timeout after accepted');
            return { turnId: `turn-${sent.length}`, status: 'inProgress' };
        }
    };
    control.startManagedTurn = async input => {
        const result = await control.startTurn(input);
        return {...result,observation:{close:()=>{},read:()=>{
            const turn=thread.turns.find(t=>t.id===result.turnId);
            return turn && turn.status !== 'inProgress'?{status:'VERIFIED',selection:{source:'NATIVE_ACCEPTED_TURN_CONFIGURATION',
                modelId:input.model!,reasoningEffort:input.reasoningEffort!,threadId:input.threadId,turnId:result.turnId,
                commandId:input.clientUserMessageId,observedAt:new Date().toISOString(),completedAt:new Date().toISOString(),
                transport:'CONTINUOUS_NATIVE_NOTIFICATIONS',providerTelemetry:false}}:{status:'OBSERVING',selection:null};
        }}};
    };
    const controller = new PlanExecutionController({ repository: store.planExecutions, resolve: async () => { if (!authorized)
            throw Error('identity changed'); return control; }, publish: async () => undefined });
    const read = () => store.planExecutions.get('user:owner', execution.id);
    const finish = (outcome = 'COMPLETED', criterion = 'First tested') => {
        thread.status = 'idle';
        Object.assign(thread.turns.at(-1)!, { status: 'completed', resultText: JSON.stringify({ outcome, summary: 'Verified checkpoint', evidence: [{ criterion, result: 'command test: passed' }] }) });
    };
    return { store, plan, execution, thread, sent, control, controller, read, finish, setAuthorized: (v: boolean) => authorized = v, setTimeout: (v: boolean) => timeout = v };
}
