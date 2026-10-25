import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { InMemorySpaceStore } from '@space/runtime';
import { registerPlanExecutionRoutes } from '../src/plan-execution-routes.js';
async function fixture(publish: () => Promise<void> = async () => {}) {
    const app = Fastify();
    const store = new InMemorySpaceStore();
    const user = { id: 'user:owner', email: 'owner@example.test', displayName: 'Owner', role: 'ADMIN' as const };
    await store.upsertUser(user);
    let identity = 'session:one';
    let allowed = true;
    let role = 'ADMIN';
    const plan = store.upsertClipboardItem({ ownerUserId: user.id, source: 'PLAN', minimumModel: 'model-a', text: 'Plan', steps: [{ id: 'first', order: 1, title: 'First', modelId: 'model-a', reasoningEffort: 'high', instructions: 'Work', completionCriteria: ['test passes'] }] });
    app.addHook('preHandler', async (request) => { request.user = { ...user, role: role as 'ADMIN' }; });
    const service = registerPlanExecutionRoutes(app, {
        store,
        target: async (_owner, paneId, expectedSessionId) => { if (expectedSessionId && expectedSessionId !== identity)
            throw Error('Session changed'); return { sessionId: identity, threadId: 'thread:one', cwd: '/project', paneId }; },
        assertStartControl: async () => { if (!allowed)
            throw Error('Terminal control required'); },
        resolve: async () => { throw Error('not used'); }, publish, intervalMs: 60000
    });
    const start = () => app.inject({ method: 'POST', url: '/api/panes/pane:one/plan-executions', payload: { planId: plan.id, expectedSessionId: 'session:one', requestId: 'request:one' } });
    return { app, store, service, plan, start, setSession: (v: string) => identity = v, setAllowed: (v: boolean) => allowed = v, setRole: (v: string) => role = v };
}
describe('managed plan routes', () => {
    it('starts durably, deduplicates request and discovers status for a pane', async () => {
        const f = await fixture();
        try {
            const first = await f.start();
            expect(first.statusCode).toBe(201);
            const id = first.json().id;
            expect((await f.start()).json().id).toBe(id);
            expect((await f.app.inject({ url: `/api/plan-executions/${id}` })).json().id).toBe(id);
            expect((await f.app.inject({ url: '/api/panes/pane:one/plan-executions' })).json().id).toBe(id);
            expect(f.store.getClipboardItem('user:owner', f.plan.id)?.steps[0]?.status).toBe('IN_PROGRESS');
        }
        finally {
            await f.app.close();
        }
    });
    it('rejects missing ownership, changed session, nonadmin and terminal control denial before persistence', async () => {
        const f = await fixture();
        try {
            f.setSession('session:other');
            expect((await f.start()).statusCode).toBeGreaterThanOrEqual(400);
            f.setSession('session:one');
            f.setAllowed(false);
            expect((await f.start()).statusCode).toBeGreaterThanOrEqual(400);
            f.setAllowed(true);
            f.setRole('USER');
            expect((await f.start()).statusCode).toBe(403);
            f.setRole('ADMIN');
            expect((await f.app.inject({ method: 'POST', url: '/api/panes/pane:one/plan-executions', payload: { planId: 'other', expectedSessionId: 'session:one', requestId: 'other' } })).statusCode).toBe(404);
            expect(await f.store.planExecutions.listActive()).toEqual([]);
        }
        finally {
            await f.app.close();
        }
    });
});

it('keeps initial create and PLAN projection durable when publication fails or its response is lost',async()=>{
 let reject=true;const f=await fixture(async()=>{if(reject)throw Error('event write failed');});
 try {
  const first=await f.start();expect(first.statusCode).toBe(201);const id=first.json().id;
  expect((await f.store.planExecutions.listPendingEvents()).map(e=>[e.executionId,e.revision])).toEqual([[id,0]]);
  expect(f.store.getClipboardItem('user:owner',f.plan.id)?.steps[0]?.status).toBe('IN_PROGRESS');
  // Simulate a lost create response: retrying the same request must not add a second execution/event.
  const replay=await f.start();expect(replay.json().id).toBe(id);expect(await f.store.planExecutions.listActive()).toHaveLength(1);
  reject=false;await f.service.flushEvents();expect(await f.store.planExecutions.listPendingEvents()).toEqual([]);
 }finally{await f.app.close();}
});
