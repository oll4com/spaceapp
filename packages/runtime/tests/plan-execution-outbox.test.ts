import { expect, it } from 'vitest';
import { InMemoryPlanExecutionRepository } from '../src/index.js';
const input = { ownerUserId: 'user:owner', planId: 'clipboard:plan', paneId: 'pane:one', sessionId: 'session:one', threadId: 'thread:one', cwd: '/project', requestId: 'request:one', snapshot: { text: 'Plan', title: null, stages: [{ id: 'one', order: 1, title: 'Work', instructions: 'Work', completionCriteria: ['Verified'], modelId: 'model-a', reasoningEffort: 'high' }] } };
it('retains initial and terminal outbox revisions independently of active executions', async () => {
    const repo = new InMemoryPlanExecutionRepository();
    const e = await repo.create(input);
    await repo.update(e.ownerUserId, e.id, 0, { status: 'FAILED' });
    expect(await repo.listActive()).toEqual([]);
    expect((await repo.listPendingEvents()).map(x => [x.id, x.revision, x.status])).toEqual([[`${e.id}:0`, 0, 'RUNNING'], [`${e.id}:1`, 1, 'FAILED']]);
    const restarted = new InMemoryPlanExecutionRepository(repo.snapshot());
    await restarted.acknowledgeEvent(e.id, 0);
    await restarted.acknowledgeEvent(e.id, 0);
    expect((await restarted.listPendingEvents()).map(x => x.revision)).toEqual([1]);
});
