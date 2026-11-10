import { describe, expect, it } from "vitest";
import { sameStageCriterion } from "@space/contracts";
import { PlanExecutionController } from "../src/plan-execution-controller.js";
import { fixture } from "./support/plan-execution-fixture.js";
describe('managed Codex execution', () => {
    it('runs different model/effort stages without a browser and projects evidence-backed progress', async () => {
        const f = await fixture();
        await f.controller.tick();
        expect(f.sent[0]).toMatchObject({ model: 'model-a', reasoningEffort: 'high', outputSchema: { type: 'object' } });
        f.finish();
        await f.controller.tick();
        await f.controller.tick();
        expect(f.sent[1]).toMatchObject({ model: 'model-b', reasoningEffort: 'low' });
        f.finish('COMPLETED', 'Second tested');
        await f.controller.tick();
        expect(await f.read()).toMatchObject({ status: 'COMPLETED', completedStageIds: ['one', 'two'], checkpoint: 'Verified checkpoint' });
        expect((await f.read())?.attempts.map(a => [a.modelId, a.reasoningEffort])).toEqual([['model-a', 'high'], ['model-b', 'low']]);
        expect(f.store.getClipboardItem('user:owner', f.plan.id)).toMatchObject({ isCompleted: true, progressPercentage: 100 });
        expect((await f.read())?.commands).toHaveLength(4);
    });
    it('continues multiple turns in the same stage', async () => {
        const f = await fixture();
        await f.controller.tick();
        f.finish('CONTINUE');
        await f.controller.tick();
        await f.controller.tick();
        expect(f.sent.map(s => s.model)).toEqual(['model-a', 'model-a']);
        expect(f.sent[1]?.prompt).toContain('Verified checkpoint');
        expect((await f.read())?.completedStageIds).toEqual([]);
    });
    it('allows one incomplete correction then blocks and rejects percentage completion', async () => {
        const f = await fixture();
        await f.controller.tick();
        expect(() => f.store.updateClipboardItemProgress('user:owner', f.plan.id, { progressPercentage: 100 })).toThrow();
        f.finish('COMPLETED', 'wrong criterion');
        await f.controller.tick();
        await f.controller.tick();
        expect(f.sent[1]?.prompt).toContain('Correction');
        f.finish('COMPLETED', 'wrong criterion');
        await f.controller.tick();
        await f.controller.tick();
        expect(await f.read()).toMatchObject({ status: 'BLOCKED', completedStageIds: [] });
        expect(f.sent).toHaveLength(2);
    });
    it('accepts a criterion echoed with other spacing or without its final period, never another or an empty one', async () => {
        for (const echoed of ['First tested.', '  First \n tested ']) {
            const f = await fixture();
            await f.controller.tick();
            f.finish('COMPLETED', echoed);
            await f.controller.tick();
            await f.controller.tick();
            expect((await f.read())?.completedStageIds).toEqual(['one']);
        }
        expect(sameStageCriterion('The reply contains SPACE_MANAGED_PLAN_STAGE_1_OK', 'The reply contains SPACE_MANAGED_PLAN_STAGE_1_OK.')).toBe(true);
        expect(sameStageCriterion('The reply contains SPACE_MANAGED_PLAN_STAGE_1_OK.', 'The reply contains SPACE_MANAGED_PLAN_STAGE_1_OK.')).toBe(true);
        expect(sameStageCriterion('The reply contains SPACE_MANAGED_PLAN_STAGE_2_OK', 'The reply contains SPACE_MANAGED_PLAN_STAGE_1_OK.')).toBe(false);
        expect(sameStageCriterion('the reply contains SPACE_MANAGED_PLAN_STAGE_1_OK', 'The reply contains SPACE_MANAGED_PLAN_STAGE_1_OK.')).toBe(false);
        expect(sameStageCriterion('The reply contains SPACE_MANAGED_PLAN_STAGE_1_OK', 'The reply contains SPACE_MANAGED_PLAN_STAGE_1_OK..')).toBe(false);
        expect(sameStageCriterion('The reply contains', 'The reply contains SPACE_MANAGED_PLAN_STAGE_1_OK.')).toBe(false);
        for (const blank of ['', '   ', '.', ' . ']) {
            expect(sameStageCriterion(blank, blank)).toBe(false);
            expect(sameStageCriterion('', blank)).toBe(false);
        }
        const f = await fixture();
        await f.controller.tick();
        f.finish('COMPLETED', 'First test');
        await f.controller.tick();
        await f.controller.tick();
        expect(f.sent[1]?.prompt).toContain('Correction');
        expect((await f.read())?.completedStageIds).toEqual([]);
    });
    it('reconciles accepted timeout by native client id without resending', async () => {
        const f = await fixture();
        f.setTimeout(true);
        await f.controller.tick();
        await f.controller.tick();
        expect(f.sent).toHaveLength(1);
        expect((await f.read())?.attempts[0]?.turnId).toBe('turn-1');
        f.finish();
        await f.controller.tick();
        expect((await f.read())?.status).toBe('BLOCKED');
        expect((await f.read())?.completedStageIds).toEqual([]);
    });
    it('blocks unknown acceptance and changed identity without new commands', async () => {
        const f = await fixture();
        f.control.startTurn = async () => { throw Error('timeout'); };
        await f.controller.tick();
        await f.controller.tick();
        expect((await f.read())?.status).toBe('BLOCKED');
        const g = await fixture();
        g.setAuthorized(false);
        await g.controller.tick();
        expect(g.sent).toHaveLength(0);
        expect((await g.read())?.status).toBe('BLOCKED');
    });
    it('waits for unrelated turns and approval instead of interrupting or advancing', async () => {
        const f = await fixture();
        f.thread.status = 'active';
        await f.controller.tick();
        expect(f.sent).toHaveLength(0);
        f.thread.status = 'idle';
        await f.controller.tick();
        f.thread.activeFlags = ['waitingOnApproval'];
        await f.controller.tick();
        expect((await f.read())?.status).toBe('WAITING_FOR_INPUT');
        expect(f.sent).toHaveLength(1);
    });
    it('does not attribute later native settings to an older managed turn', async () => {
        const f = await fixture();
        await f.controller.tick();
        f.finish();
        f.thread.turns.push({ id: 'foreign', status: 'completed', clientUserMessageIds: [], resultText: null, itemsComplete: true });
        await f.controller.tick();
        expect((await f.read())?.status).toBe('BLOCKED');
        expect((await f.read())?.completedStageIds).toEqual([]);
    });
});
it('fences stale revisions before turn/start after a long settings read', async () => {
    const f = await fixture();
    f.control.readThreadSettings = async () => {
        const e = (await f.read())!;
        await f.store.planExecutions.update(e.ownerUserId, e.id, e.revision, { status: 'PAUSED' });
        return { ...f.thread, isTurnActive: false };
    };
    await f.controller.tick();
    expect(f.sent).toHaveLength(0);
    expect((await f.read())?.status).toBe('PAUSED');
});
it('does not send from an expired worker after another controller claims its lease', async () => {
    const f = await fixture();
    f.control.listModels = async () => {
        const e = (await f.read())!;
        await f.store.planExecutions.release(e.id, e.lease!);
        await f.store.planExecutions.claim(e.id, 'replacement', Date.now(), 60000);
        return [{ id: 'model-a', displayName: 'A', isDefault: false, defaultReasoningEffort: 'high', supportedReasoningEfforts: ['high'] }];
    };
    await f.controller.tick();
    expect(f.sent).toHaveLength(0);
    expect((await f.read())?.pendingCommand).toBeNull();
});
it('checks identity once more at native send time', async () => {
    const f = await fixture();
    let sent = false;
    f.control.startTurn = async (input) => {
        f.setAuthorized(false);
        await input.beforeSend?.();
        sent = true;
        return { turnId: 'foreign', status: 'inProgress' };
    };
    await f.controller.tick();
    expect(sent).toBe(false);
});
it('rechecks native idle after the start socket handshake', async () => {
    const f = await fixture();
    let sent = false;
    f.control.startTurn = async (input) => {
        f.thread.status = 'active';
        f.thread.turns.push({ id: 'external', status: 'inProgress', itemsComplete: true, clientUserMessageIds: [], resultText: null });
        await input.beforeSend?.();
        sent = true;
        return { turnId: 'bad', status: 'inProgress' };
    };
    await f.controller.tick();
    expect(sent).toBe(false);
});
it('never substitutes late mutable defaults for retained accepted-turn evidence',async()=>{
 const f=await fixture();await f.controller.tick();f.finish();f.thread.modelId='late-default';await f.controller.tick();
 const e=(await f.read())!;expect(e.completedStageIds).toEqual(['one']);
 expect(e.attempts[0]?.actualSelection).toMatchObject({source:'NATIVE_ACCEPTED_TURN_CONFIGURATION',modelId:'model-a',turnId:'turn-1',providerTelemetry:false});
});
it('does not fabricate turn evidence from restored defaults after an observer is lost',async()=>{
 const f=await fixture();await f.controller.tick();await f.controller.close();f.finish();
 const restarted=new PlanExecutionController({repository:f.store.planExecutions,resolve:async()=>f.control,publish:async()=>{}});
 await restarted.tick();expect((await f.read())?.status).toBe('BLOCKED');expect((await f.read())?.attempts[0]?.actualSelection).toBeNull();
});
it('waits for unadvertised reasoning without silently choosing a default', async () => {
    const f = await fixture();
    f.control.listModels = async () => [{ id: 'model-a', displayName: 'A', isDefault: true, defaultReasoningEffort: 'low', supportedReasoningEfforts: ['low'] }];
    await f.controller.tick();
    expect(f.sent).toEqual([]);
    expect((await f.read())?.status).toBe('WAITING_FOR_MODEL');
});
it('blocks failed native turns even when the output claims completion', async () => {
    const f = await fixture();
    await f.controller.tick();
    f.finish();
    f.thread.turns[0]!.status = 'failed';
    await f.controller.tick();
    expect((await f.read())?.status).toBe('BLOCKED');
    expect((await f.read())?.attempts[0]?.actualSelection?.turnId).toBe('turn-1');
    expect((await f.read())?.completedStageIds).toEqual([]);
});
it('pauses an interrupted native turn without restarting it', async () => {
    const f = await fixture();
    await f.controller.tick();
    f.thread.turns[0]!.status = 'interrupted';
    f.thread.status = 'idle';
    await f.controller.tick();
    await f.controller.tick();
    expect((await f.read())?.status).toBe('PAUSED');
    expect((await f.read())?.attempts[0]?.actualSelection?.turnId).toBe('turn-1');
    expect(f.sent).toHaveLength(1);
});

it('rechecks permission after a slow native pre-send read',async()=>{
 const f=await fixture();let sent=false;
 f.control.startTurn=async input=>{
   f.control.readThread=async()=>{f.setAuthorized(false);return structuredClone(f.thread);};
   await input.beforeSend?.();sent=true;return {turnId:'bad',status:'inProgress'};
 };
 await f.controller.tick();expect(sent).toBe(false);
});

it('rejects a returned already-expired lease before settings or start sends',async()=>{
 const f=await fixture();const original=f.store.planExecutions.claim.bind(f.store.planExecutions);
 let delayed=false;let writes=0;
 f.control.listModels=async()=>{delayed=true;return [{id:'model-a',displayName:'A',isDefault:false,defaultReasoningEffort:'high',supportedReasoningEfforts:['high']}];};
 f.store.planExecutions.claim=async(...args)=>{const r=await original(...args);if(delayed&&r?.lease){r.lease.expiresAt=new Date(Date.now()+5).toISOString();await new Promise(resolve=>setTimeout(resolve,20));}return r;};
 f.control.updateThreadSettings=async()=>{writes++;};
 await f.controller.tick();expect(writes).toBe(0);expect(f.sent).toHaveLength(0);
});
it('rejects an oversized complete prompt locally before preparing any native command',async()=>{
 const f=await fixture();const e=(await f.read())!;
 const stages=e.snapshot.stages.map(s=>({...s,instructions:'x'.repeat(16000),completionCriteria:Array.from({length:30},(_,i)=>String(i).padStart(2,'0')+'y'.repeat(1998))}));
 await f.store.planExecutions.update(e.ownerUserId,e.id,e.revision,{status:'FAILED'});
 const large=await f.store.planExecutions.create({...e,requestId:'large',snapshot:{...e.snapshot,stages}});
 await f.store.planExecutions.update(large.ownerUserId,large.id,large.revision,{checkpoint:'z'.repeat(4000),correctionCount:1});
 await f.controller.tick();const result=(await f.store.planExecutions.get(large.ownerUserId,large.id))!;
 expect(result.status).toBe('BLOCKED');expect(result.statusReason).toContain('20,000');expect(result.commands).toEqual([]);expect(result.pendingCommand).toBeNull();expect(f.sent).toEqual([]);
});

it('keeps executing through publication rejection and replays terminal revisions after restart',async()=>{
 const f=await fixture();await f.controller.close();
 const delivered:string[]=[];
 const controller=new PlanExecutionController({repository:f.store.planExecutions,resolve:async()=>f.control,
   publish:async()=>{throw Error('event store unavailable');}});
 await controller.tick();f.finish();await controller.tick();await controller.tick();
 f.finish('COMPLETED','Second tested');await controller.tick();await controller.close();
 expect((await f.read())?.status).toBe('COMPLETED');
 expect(f.store.getClipboardItem('user:owner',f.plan.id)?.isCompleted).toBe(true);
 expect(await f.store.planExecutions.listActive()).toEqual([]);
 const pending=await f.store.planExecutions.listPendingEvents();
 expect(pending[0]?.revision).toBe(0);expect(pending.at(-1)?.status).toBe('COMPLETED');
 const restarted=new PlanExecutionController({repository:f.store.planExecutions,resolve:async()=>{throw Error('terminal must not resolve native');},publish:async event=>{delivered.push(event.id);}});
 await restarted.tick();await restarted.tick();
 expect(delivered).toEqual(pending.map(e=>e.id));expect(await f.store.planExecutions.listPendingEvents()).toEqual([]);
 expect(f.sent).toHaveLength(2);await restarted.close();
});
it('replays a delivered terminal revision after a lost acknowledgment using the same identity',async()=>{
 const f=await fixture();await f.controller.tick();f.finish();await f.controller.tick();await f.controller.tick();
 f.finish('COMPLETED','Second tested');
 const ack=f.store.planExecutions.acknowledgeEvent.bind(f.store.planExecutions);
 f.store.planExecutions.acknowledgeEvent=async()=>{throw Error('crash before ack');};
 await f.controller.tick();await f.controller.close();
 const pending=await f.store.planExecutions.listPendingEvents();expect(pending.at(-1)?.status).toBe('COMPLETED');
 const delivered:string[]=[];const restarted=new PlanExecutionController({repository:f.store.planExecutions,resolve:async()=>f.control,publish:async e=>{delivered.push(e.id);}});
 await restarted.tick();f.store.planExecutions.acknowledgeEvent=ack;await restarted.tick();await restarted.close();
 expect(delivered.filter(id=>id===pending[0]!.id).length).toBeGreaterThan(1);
 expect(await f.store.planExecutions.listPendingEvents()).toEqual([]);expect((await f.read())?.status).toBe('COMPLETED');
});
it('rejects a native turn that absorbed a concurrent user message even with accepted configuration',async()=>{
 const f=await fixture();await f.controller.tick();f.finish();f.thread.turns[0]!.userMessageCount=2;
 await f.controller.tick();expect((await f.read())?.status).toBe('BLOCKED');expect((await f.read())?.completedStageIds).toEqual([]);
});
it('does not let an outbox read outage prevent a valid native command',async()=>{
 const f=await fixture();f.store.planExecutions.listPendingEvents=async()=>{throw Error('relay read unavailable');};
 await expect(f.controller.tick()).resolves.toBeUndefined();expect(f.sent).toHaveLength(1);expect((await f.read())?.status).toBe('RUNNING');
});

it('sends the full 20,000 character boundary prompt with checkpoint and correction intact',async()=>{
 const checkpoint='z'.repeat(4000);
 const base=await fixture();await base.store.planExecutions.update('user:owner',base.execution.id,0,{checkpoint,correctionCount:1});await base.controller.tick();
 const length=20000-base.sent[0]!.prompt.length+'Do first'.length;
 const f=await fixture('x'.repeat(length));await f.store.planExecutions.update('user:owner',f.execution.id,0,{checkpoint,correctionCount:1});
 await f.controller.tick();expect(f.sent).toHaveLength(1);expect(f.sent[0]!.prompt).toHaveLength(20000);
 expect(f.sent[0]!.prompt).toContain('First tested');expect(f.sent[0]!.prompt).toContain(checkpoint);expect(f.sent[0]!.prompt).toContain('Correction:');
});

// The proof boundary (scripts/managed-plan-execution-proof.mjs, not in the public tree): plan-execution-proof.test.ts.

it('delivers shared specification and constraints from the immutable whole-plan snapshot to native execution', async () => {
    const text = '# Specification\nImplement an amber status indicator.\n# Constraints\nDo not deploy or change authentication.\n# Stage 1\nDo first';
    const f = await fixture(undefined, undefined, text);
    await f.controller.tick();
    expect(f.sent).toHaveLength(1);
    expect(f.sent[0]!.prompt).toContain(text);
    expect(f.sent[0]!.prompt).toContain('Execute only stage 1: First.');
    expect(f.sent[0]!.prompt).toContain('Do not execute other stages');
    await f.controller.close();
});
it('blocks oversized whole-plan context before any command rather than silently omitting it', async () => {
    const f = await fixture(undefined, undefined, 'Shared requirements: ' + 'x'.repeat(20000));
    await f.controller.tick();
    const result = (await f.read())!;
    expect(result.status).toBe('BLOCKED');
    expect(result.statusReason).toContain('whole-plan context');
    expect(result.statusReason).toContain('20,000');
    expect(result.commands).toEqual([]);
    expect(result.pendingCommand).toBeNull();
    expect(f.sent).toEqual([]);
    await f.controller.close();
});
