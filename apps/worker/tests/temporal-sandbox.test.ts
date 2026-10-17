import { afterEach, beforeAll, beforeEach, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker, bundleWorkflowCode, type WorkflowBundleWithSourceMap } from '@temporalio/worker';
import { temporal } from '@temporalio/proto';
import { DeterminismViolationError } from '@temporalio/workflow';
import { Context } from '@temporalio/activity';
import { roomAgentSupervisorInputSchema } from '@space/contracts';
import { defaultPayloadConverter } from '@temporalio/common';
import { recordHistoryFixture, readHistoryFixtureNames } from './support/history-files.js';

const workflowsPath = fileURLToPath(new URL('./support/sandbox-workflows.ts', import.meta.url));
const loader = fileURLToPath(new URL('./support/history-variant-loader.cjs', import.meta.url));
const fixtureDir = fileURLToPath(new URL('./fixtures/workflow-histories/', import.meta.url));
const record = process.env.SPACE_RECORD_HISTORIES === '1';
let env: TestWorkflowEnvironment;
let current: WorkflowBundleWithSourceMap;
let legacy: WorkflowBundleWithSourceMap;
let negative: WorkflowBundleWithSourceMap;
let seq = 0;
const completed = { status: 'COMPLETED', message: 'synthetic', roomAgentOutcome: { status: 'VERIFIED', executedActionCount: 1, statusReason: 'synthetic' } };
/** Build a minimal synthetic turn accepted by the production input schema. */
const turn = (n = 0) => ({ roomId: 'room:synthetic', paneId: 'pane:synthetic', prompt: 'Synthetic test', agentRunId: `agent_run:${n}`, traceId: `trace:synthetic-${n}` });
/** Wrap a synthetic turn in a supervisor queue item. */
const item = (n = 0) => ({ missionId: 'mission:synthetic', turn: turn(n) });
/** Supply the synthetic room while allowing a scenario to set carried state. */
const supervisor = (extra = {}) => ({ roomId: 'room:synthetic', ...extra });

/** Bundle production workflows, optionally applying a guarded test-only variant. */
async function bundle(variant?: string) {
  return bundleWorkflowCode({ workflowsPath, webpackConfigHook(config) {
    if (variant) config.module!.rules!.unshift({ test: /[/\\]src[/\\]workflows\.ts$/, enforce: 'pre', use: [{ loader, options: { variant } }] });
    return config;
  } });
}
beforeAll(async () => {
  current = await bundle(); legacy = await bundle('legacy'); negative = await bundle('negative');
}, 90_000);
// A terminated long-lived supervisor may leave an in-flight activity on the test
// server. Isolate clocks and activity locks between scenarios.
// The first server startup can download the SDK-pinned binary on a cold runner.
beforeEach(async () => { env = await TestWorkflowEnvironment.createTimeSkipping(); }, 60_000);
afterEach(async () => { await env?.teardown(); }, 15_000);

/** Run isolated workers, including memory child queues, until the scenario finishes. */
async function run(activities: Record<string, (...args: any[]) => any>, fn: (queue: string) => Promise<void>, old = false) {
  const queue = `synthetic-${++seq}`;
  const queues = activities.refreshMemoryGraphSnapshot ? [queue, 'space-memory-maintenance', 'space-memory-mutations'] : [queue];
  const workers = await Promise.all(queues.map(taskQueue => Worker.create({
    connection: env.nativeConnection, taskQueue, workflowBundle: old ? legacy : current, activities, shutdownGraceTime: 0, shutdownForceTime: 3000,
  })));
  /** Keep every worker polling while unwinding all workers after success or failure. */
  async function nest(index: number): Promise<void> {
    if (index === workers.length) return fn(queue);
    await workers[index]!.runUntil(() => nest(index + 1));
  }
  await nest(0);
}
/** Fetch the original execution, rather than silently following continue-as-new. */
async function firstHistory(handle: any) {
  return env.client.workflow.getHandle(handle.workflowId, handle.firstExecutionRunId).fetchHistory();
}
/** Record scrubbed synthetic JSON only in explicit recorder mode; retain raw history in memory. */
async function capture(handle: any, name: string) {
  const history = await firstHistory(handle);
  if (record) {
    await recordHistoryFixture(fixtureDir, name, temporal.api.history.v1.History.create(history).toJSON());
  }
  return history;
}
/** Start a uniquely identified workflow with synthetic input on this scenario's queue. */
async function start(queue: string, type: string, input: unknown) {
  return env.client.workflow.start(type, { workflowId: `synthetic-${type}-${++seq}`, taskQueue: queue, args: [input] });
}
/** Bound real-time waits for activities, which run outside the virtual workflow clock. */
async function eventually(check: () => boolean) {
  // Bound real time: activity callbacks run outside the workflow's virtual clock.
  for (let n = 0; n < 1000; n++) { if (check()) return; await new Promise(r => setTimeout(r, 10)); }
  throw new Error('Synthetic activity milestone not reached');
}
/** Decode the actual server-recorded continue-as-new input for exact state assertions. */
function continuedInput(history: any) {
  const event = history.events.find((e: any) => e.workflowExecutionContinuedAsNewEventAttributes);
  expect(event, 'continue-as-new event').toBeDefined();
  return defaultPayloadConverter.fromPayload(event.workflowExecutionContinuedAsNewEventAttributes.input.payloads[0]);
}

it('runs both turn workflows in the real sandbox and retries transient activities', async () => {
  let dummyAttempts = 0, codexAttempts = 0;
  await run({
    recordDummyTurnStarted: () => { if (++dummyAttempts === 1) throw new Error('retry synthetic'); },
    recordDummyTurnCompleted: () => completed,
    runCodexAppServerTurn: () => { if (++codexAttempts === 1) throw new Error('retry synthetic'); return completed; },
  }, async queue => {
    for (const type of ['dummyTurnWorkflow', 'codexAppServerTurnWorkflow']) {
      const handle = await start(queue, type, turn());
      expect(await handle.result()).toEqual(completed);
      await capture(handle, type);
    }
  });
  expect(dummyAttempts).toBe(2); expect(codexAttempts).toBe(2);
}, 30_000);

it.each(['signal', 'timeout'])('wakes a waiting goal via %s', async mode => {
  let calls = 0;
  await run({ dotGoalStep: () => ++calls === 1 ? { state: 'PAUSED', runId: null, goalStatus: 'PAUSED' } : { state: 'DONE', runId: null, goalStatus: 'COMPLETED' } }, async queue => {
    const handle = await start(queue, 'dotGoalWorkflow', { goalId: 'goal:synthetic' });
    await eventually(() => calls === 1);
    if (mode === 'signal') await handle.signal('dotGoalWake');
    expect(await handle.result()).toEqual({ goalStatus: 'COMPLETED' });
    const history = await capture(handle, `dotGoalWorkflow-${mode}`);
    const fired = history.events!.filter(e => e.timerFiredEventAttributes);
    expect(fired).toHaveLength(mode === 'signal' ? 0 : 1);
    expect(calls).toBe(2);
  });
}, 30_000);

it('continues an unfinished goal as a new run', async () => {
  let calls = 0;
  await run({ dotGoalStep: () => ++calls <= 300 ? { state: 'WAITING', runId: null, goalStatus: 'ACTIVE' } : { state: 'DONE', runId: null, goalStatus: 'COMPLETED' } }, async queue => {
    const handle = await start(queue, 'dotGoalWorkflow', { goalId: 'goal:synthetic' });
    expect(await handle.result()).toEqual({ goalStatus: 'COMPLETED' });
    expect(continuedInput(await capture(handle, 'dotGoalWorkflow-continued'))).toEqual({ goalId: 'goal:synthetic' });
  });
  expect(calls).toBe(301);
}, 45_000);

it('records the background action failure path after retries, including its fallback action id', async () => {
  let attempts = 0; const failures: any[] = [];
  await run({ runRoomAgentBackgroundAction: () => { attempts++; throw new Error('synthetic transport failed'); }, failRoomAgentBackgroundAction: x => { failures.push(x); } }, async queue => {
    const handle = await env.client.workflow.start('roomAgentActionWorkflow', { workflowId: 'space-room-action:action:legacy', taskQueue: queue, args: [{ bridge: { roomId: 'room:synthetic', missionId: 'mission:synthetic' }, traceId: 'trace:synthetic' }] });
    await expect(handle.result()).rejects.toThrow();
    expect(attempts).toBe(5);
    expect(failures).toEqual([{ roomId: 'room:synthetic', missionId: 'mission:synthetic', actionId: 'action:legacy', cancelled: false }]);
    await capture(handle, 'roomAgentActionWorkflow');
  });
}, 30_000);

it('maintains memory despite exhausted refresh/reconcile failures and executes its real consolidation child', async () => {
  let refresh = 0, reconcile = 0, repairs = 0, mutations = 0;
  const snapshot = { sourceHash: 'synthetic-hash' };
  const audit = { id: 'audit:synthetic', workflowId: 'synthetic-consolidation-child' };
  await run({
    refreshMemoryGraphSnapshot: () => snapshot,
    refreshAllMonthsMemoryGraphSnapshot: () => { refresh++; throw new Error('synthetic'); },
    reconcileStaleSpaceAgentSessions: () => { reconcile++; throw new Error('synthetic'); },
    createScheduledMemoryAudit: () => audit,
    prepareMemoryConsolidation: () => ({ changeSetId: 'change:synthetic', run: audit }),
    executePersistedMemoryChangeSet: () => { if (++mutations === 1 || mutations === 3) throw new Error('retry synthetic'); return { status: 'COMPLETED' }; },
    finalizeMemoryRepair: () => { repairs++; return audit; },
  }, async queue => {
    const handle = await start(queue, 'memoryMaintenanceWorkflow', { traceId: 'trace:synthetic' });
    expect(await handle.result()).toEqual(snapshot);
    await capture(handle, 'memoryMaintenanceWorkflow');
    await capture(env.client.workflow.getHandle(audit.workflowId), 'memoryConsolidationWorkflow');
    const mutation = await start(queue, 'memoryMutationWorkflow', { changeSetId: 'change:synthetic', traceId: 'trace:synthetic' });
    expect(await mutation.result()).toEqual({ status: 'COMPLETED' });
    await capture(mutation, 'memoryMutationWorkflow');
  });
  expect([refresh, reconcile, repairs, mutations]).toEqual([3, 3, 1, 4]);
}, 30_000);

it.each([false, true])('supervisor carries pending state after 50 items and resumes exactly once (legacy=%s)', async old => {
  const finished: any[] = []; const executedIds: string[] = [];
  await run({
    checkRoomAgentSupervisorTurn: () => 'READY', runCodexAppServerTurn: input => { executedIds.push(input.agentRunId); return completed; },
    markRoomAgentMissionStarted: () => {}, markRoomAgentMissionFinished: x => { finished.push(x); },
    markRoomAgentMissionContinued: () => {}, discardRoomAgentSupervisorTurn: () => {},
    finishRoomAgentSupervisorTurn: x => { finished.push(x); },
  }, async queue => {
    const handle = await start(queue, 'roomAgentSupervisorWorkflow', supervisor({ processedCount: 49, pending: [item(1), item(2)] }));
    await eventually(() => finished.length >= 1);
    // Wait for the continuation to become durable, then drive the next run too.
    await eventuallyAsync(async () => (await firstHistory(handle)).events?.some(e => e.workflowExecutionContinuedAsNewEventAttributes) ?? false);
    const carried = roomAgentSupervisorInputSchema.parse(continuedInput(await capture(handle, `roomAgentSupervisorWorkflow-${old ? 'legacy' : 'current'}`)));
    expect(carried.processedCount).toBe(0);
    expect(carried.pending).toHaveLength(1);
    expect(carried.pending[0]!.turn.agentRunId).toBe('agent_run:2');
    await eventually(() => executedIds.length === 2);
    expect(finished).toHaveLength(1);
    expect(executedIds).toEqual(['agent_run:1', 'agent_run:2']);
    expect(finished[0].status).toBe('COMPLETED');
    expect(() => roomAgentSupervisorInputSchema.parse(carried)).not.toThrow();
    await env.client.workflow.getHandle(handle.workflowId).terminate('synthetic test complete');
  }, old);
}, 30_000);
/** Wait for a durable history milestone without advancing an idle workflow's clock. */
async function eventuallyAsync(check: () => Promise<boolean>) {
  for (let i = 0; i < 1000; i++) { if (await check()) return; await new Promise(r => setTimeout(r, 10)); }
  throw new Error('Workflow history milestone not reached');
}

it.each([false, true])('polls at one second and retains monitored missions after 250 polls (legacy=%s)', async old => {
  let calls = 0;
  await run({
    settleRoomAgentBackgroundMission: () => ++calls > 250,
    prepareRoomAgentBackgroundContinuation: () => ({ state: ++calls > 250 ? 'DONE' : 'WAITING' }),
  }, async queue => {
    const handle = await start(queue, 'roomAgentSupervisorWorkflow', supervisor({ monitoringMissionIds: ['mission:synthetic'] }));
    await expect(env.client.workflow.result(handle.workflowId, handle.firstExecutionRunId, { followRuns: false })).rejects.toThrow('continued as new');
    await eventuallyAsync(async () => (await firstHistory(handle)).events?.some(e => e.workflowExecutionContinuedAsNewEventAttributes) ?? false);
    const history = await capture(handle, `supervisor-polls-${old ? 'legacy' : 'current'}`);
    const input = roomAgentSupervisorInputSchema.parse(continuedInput(history));
    expect(input.monitoringMissionIds).toEqual(['mission:synthetic']); expect(input.pending).toEqual([]);
    const timers = history.events!.filter(e => e.timerStartedEventAttributes);
    expect(timers).toHaveLength(250);
    expect(timers.every(e => Number(e.timerStartedEventAttributes!.startToFireTimeout!.seconds) === 1)).toBe(true);
    expect(() => roomAgentSupervisorInputSchema.parse(input)).not.toThrow();
    await advanceUntil(() => calls >= 251);
    // The next execution must resume the carried mission and retire it once.
    // Advancing beyond several poll intervals must not settle it again.
    await env.sleep('3 seconds');
    expect(calls).toBe(251);
    await env.client.workflow.getHandle(handle.workflowId).terminate('synthetic complete');
  }, old);
}, 40_000);

it.each([false, true])('interrupts an active child and discards a queued mission on stop (legacy=%s)', async old => {
  let active = false; const endings: any[] = [];
  await run({
    checkRoomAgentSupervisorTurn: () => 'READY', markRoomAgentMissionStarted: () => {},
    runCodexAppServerTurn: async () => { active = true; const ctx = Context.current(); const timer = setInterval(() => ctx.heartbeat(), 20); try { await ctx.cancelled; } finally { clearInterval(timer); } },
    discardRoomAgentSupervisorTurn: () => {}, finishRoomAgentSupervisorTurn: x => { endings.push(x); },
    markRoomAgentMissionFinished: x => { endings.push(x); },
  }, async queue => {
    const handle = await start(queue, 'roomAgentSupervisorWorkflow', supervisor());
    await handle.signal('enqueueRoomAgentMission', item(1));
    await eventually(() => active);
    await handle.signal('enqueueRoomAgentMission', { ...item(2), missionId: 'mission:queued' });
    await handle.signal('stopRoomAgentMission', { missionId: null, reason: 'Synthetic stop' });
    await eventually(() => endings.length === 2);
    expect(endings.map(e => e.status)).toEqual(['INTERRUPTED', 'INTERRUPTED']);
    expect(endings.map(e => e.statusReason)).toEqual(['Synthetic stop', 'Synthetic stop']);
    await handle.terminate('synthetic complete');
    await capture(handle, `supervisor-stop-${old ? 'legacy' : 'current'}`);
  }, old);
}, 30_000);

it.each(['stop', 'follow-up'])('retires a prepared continuation if %s arrives before the activity reply', async mode => {
  const { continuationFixture } = await import('./room-continuation-fixture.js');
  const { prepareBackgroundContinuation, supervisorTurnState, discardSupervisorTurn, finishSupervisorTurn } = await import('../src/room-background-continuation.js');
  const c = continuationFixture();
  let prepared: any; let release!: () => void;
  const blocked = new Promise<void>(r => { release = r; });
  const discarded: any[] = []; const executed: any[] = [];
  await run({
    prepareRoomAgentBackgroundContinuation: async input => {
      const result = await prepareBackgroundContinuation(input, c.store);
      if (result.state === 'READY') prepared = result.item;
      await blocked;
      return result;
    },
    discardRoomAgentSupervisorTurn: async x => {
      await discardSupervisorTurn(x.item, x.reason, c.store);
      discarded.push(x);
    },
    checkRoomAgentSupervisorTurn: input => supervisorTurnState(input, c.store),
    runCodexAppServerTurn: x => { executed.push(x); return completed; },
    finishRoomAgentSupervisorTurn: input => finishSupervisorTurn(input, c.store),
  }, async queue => {
    const handle = await start(queue, 'roomAgentSupervisorWorkflow', { roomId: c.room.id, monitoringMissionIds: [c.initial.mission.id] });
    await advanceUntil(() => Boolean(prepared));
    if (mode === 'stop') {
      c.store.updateRoomAgentMission(c.initial.mission.id, { status: 'INTERRUPTED' });
      await handle.signal('stopRoomAgentMission', { missionId: null, reason: 'Synthetic stop' });
    } else {
      const followUp = c.enqueue('follow-up', 'Only inspect the room.');
      await handle.signal('enqueueRoomAgentMission', followUp.queueItem);
    }
    release();
    await eventually(() => discarded.length === 1);
    expect(c.store.getRoomAgentTurn(c.initial.mission.id, prepared.turn.agentRunId)?.run.status).toBe('INTERRUPTED');
    if (mode === 'follow-up') {
      await eventually(() => executed.length === 1);
      expect(executed[0].roomAgentOperatorRequest).toBe('Only inspect the room.');
    } else expect(executed).toHaveLength(0);
    await handle.terminate('synthetic complete');
  });
}, 30_000);

it('uses the legacy boolean settle contract and stops polling a settled mission', async () => {
  let settles = 0, prepares = 0;
  await run({
    settleRoomAgentBackgroundMission: () => { settles++; return true; },
    prepareRoomAgentBackgroundContinuation: () => { prepares++; return { state: 'WAITING' }; },
  }, async queue => {
    const handle = await start(queue, 'roomAgentSupervisorWorkflow', supervisor({ monitoringMissionIds: ['mission:synthetic'] }));
    await advanceUntil(() => settles === 1);
    await env.sleep('5 seconds');
    expect(settles).toBe(1); expect(prepares).toBe(0);
    await handle.terminate('synthetic complete');
    await capture(handle, 'supervisor-legacy-settled');
  }, true);
}, 30_000);

it('carries a prepared continuation into the next run and completes its stored mission exactly once', async () => {
  const { continuationFixture } = await import('./room-continuation-fixture.js');
  const { prepareBackgroundContinuation, supervisorTurnState, finishSupervisorTurn } = await import('../src/room-background-continuation.js');
  const c = continuationFixture();
  let preparations = 0; const executions: any[] = []; const completions: any[] = [];
  let prepared: any;
  await run({
    prepareRoomAgentBackgroundContinuation: async input => {
      preparations++;
      const result = await prepareBackgroundContinuation(input, c.store);
      if (result.state === 'READY') prepared = result.item;
      return result;
    },
    checkRoomAgentSupervisorTurn: input => supervisorTurnState(input, c.store),
    runCodexAppServerTurn: x => { executions.push(x); c.store.updateSpaceAgentRun(x.agentRunId, { status: 'COMPLETED' }); return completed; },
    finishRoomAgentSupervisorTurn: async x => { await finishSupervisorTurn(x, c.store); completions.push(x); },
  }, async queue => {
    const handle = await start(queue, 'roomAgentSupervisorWorkflow', { roomId: c.room.id, processedCount: 50, monitoringMissionIds: [c.initial.mission.id] });
    await advanceUntil(() => completions.length === 1);
    const carried = roomAgentSupervisorInputSchema.parse(continuedInput(await capture(handle, 'supervisor-prepared-carry')));
    expect(carried.pending).toEqual([prepared]);
    expect(executions.map(x => x.agentRunId)).toEqual([prepared.turn.agentRunId]);
    expect(completions[0]).toMatchObject({ item: { turn: { agentRunId: prepared.turn.agentRunId } }, status: 'COMPLETED' });
    expect(c.store.getRoomAgentMission(c.room.id, c.initial.mission.id)?.status).toBe('COMPLETED');
    expect(c.store.getRoomAgentTurn(c.initial.mission.id, prepared.turn.agentRunId)?.run.status).toBe('COMPLETED');
    await env.sleep('3 seconds');
    expect(preparations).toBe(1); expect(executions).toHaveLength(1); expect(completions).toHaveLength(1);
    await env.client.workflow.getHandle(handle.workflowId).terminate('synthetic complete');
  });
}, 30_000);

it('drains excess queue entries before continuing with at most 100 pending turns', async () => {
  let entered = false; let release!: () => void; let checks = 0;
  const blocked = new Promise<void>(r => { release = r; });
  await run({
    checkRoomAgentSupervisorTurn: async () => { if (++checks === 1) { entered = true; await blocked; } return 'SKIP'; },
    discardRoomAgentSupervisorTurn: () => {}, finishRoomAgentSupervisorTurn: () => {},
  }, async queue => {
    const handle = await start(queue, 'roomAgentSupervisorWorkflow', supervisor({ processedCount: 49, pending: [item(0)] }));
    await eventually(() => entered);
    for (let n = 1; n <= 105; n++) await handle.signal('enqueueRoomAgentMission', item(n));
    release();
    await eventuallyAsync(async () => (await firstHistory(handle)).events?.some(e => e.workflowExecutionContinuedAsNewEventAttributes) ?? false);
    const history = await capture(handle, 'supervisor-queue-bound');
    const carried = roomAgentSupervisorInputSchema.parse(continuedInput(history));
    expect(carried.pending).toHaveLength(100);
    expect(() => roomAgentSupervisorInputSchema.parse(carried)).not.toThrow();
    expect(carried.pending.map((i: any) => i.turn.agentRunId)).toEqual(Array.from({length:100}, (_, i) => `agent_run:${i+6}`));
    const checked = history.events!.filter(e => e.activityTaskScheduledEventAttributes?.activityType?.name === 'checkRoomAgentSupervisorTurn');
    expect(checked).toHaveLength(6);
    await env.client.workflow.getHandle(handle.workflowId).terminate('synthetic complete');
  });
}, 30_000);

it('executes allocation, send and verification within one mission using the in-memory activity fixture', async () => {
  const { continuationFixture } = await import('./room-continuation-fixture.js');
  const { prepareBackgroundContinuation, supervisorTurnState, discardSupervisorTurn, finishSupervisorTurn } = await import('../src/room-background-continuation.js');
  const c = continuationFixture(); let children = 0; let finished = 0;
  await run({
    prepareRoomAgentBackgroundContinuation: input => prepareBackgroundContinuation(input, c.store),
    checkRoomAgentSupervisorTurn: input => supervisorTurnState(input, c.store),
    discardRoomAgentSupervisorTurn: ({item, reason}) => discardSupervisorTurn(item, reason, c.store),
    finishRoomAgentSupervisorTurn: async input => { await finishSupervisorTurn(input, c.store); finished++; },
    runCodexAppServerTurn: input => {
      c.store.updateSpaceAgentRun(input.agentRunId, {status:'COMPLETED'});
      if (++children === 1) {
        expect(input.prompt).toContain('Open CLI and Chat, then send a story');
        c.store.createRoomAgentAction({...c.action, actionId:'action:send', idempotencyKey:'send-once', actionType:'SEND', evidence:{cli:'Story complete',chat:'Story complete'},statusReason:'Both tasks completed.'});
        return {...completed,roomAgentOutcome:{...completed.roomAgentOutcome,pendingActionIds:['action:send']}};
      }
      return completed;
    },
  }, async queue => {
    const handle = await start(queue, 'roomAgentSupervisorWorkflow', {roomId:c.room.id,monitoringMissionIds:[c.initial.mission.id]});
    await advanceUntil(() => finished > 0);
    expect(children).toBe(2); expect(finished).toBe(1);
    expect(c.store.listRoomAgentActions(c.initial.mission.id).filter(a=>a.actionType==='SEND')).toHaveLength(1);
    expect(c.store.getRoomAgentMission(c.room.id,c.initial.mission.id)?.status).toBe('COMPLETED');
    await handle.terminate('synthetic complete');
  });
}, 30_000);

it('preserves interrupted turns and their reasons across continue-as-new', async () => {
  const discarded: any[] = []; const finished: any[] = [];
  const interrupted = [1, 2].map(n => ({ item: item(n), reason: `Synthetic stop ${n}` }));
  await run({
    discardRoomAgentSupervisorTurn: x => { discarded.push(x); },
    finishRoomAgentSupervisorTurn: x => { finished.push(x); },
    runCodexAppServerTurn: () => { throw new Error('An interrupted turn must never execute'); },
  }, async queue => {
    const handle = await start(queue, 'roomAgentSupervisorWorkflow', supervisor({ processedCount: 49, interrupted }));
    await eventually(() => finished.length === 2);
    const carried = roomAgentSupervisorInputSchema.parse(continuedInput(await firstHistory(handle)));
    expect(carried.interrupted).toEqual(roomAgentSupervisorInputSchema.parse(supervisor({ interrupted: [interrupted[1]] })).interrupted);
    expect(carried.processedCount).toBe(0);
    expect(discarded.map(x => [x.item.turn.agentRunId, x.reason])).toEqual([
      ['agent_run:1', 'Synthetic stop 1'], ['agent_run:2', 'Synthetic stop 2'],
    ]);
    expect(finished.map(x => [x.item.turn.agentRunId, x.status, x.statusReason])).toEqual([
      ['agent_run:1', 'INTERRUPTED', 'Synthetic stop 1'], ['agent_run:2', 'INTERRUPTED', 'Synthetic stop 2'],
    ]);
    await env.client.workflow.getHandle(handle.workflowId).terminate('synthetic complete');
  });
}, 30_000);

it('ignores duplicate and invalid enqueue signals without losing a valid queued turn', async () => {
  let entered = false; let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const executed: string[] = []; const finished: any[] = [];
  await run({
    checkRoomAgentSupervisorTurn: async x => { if (x.turn.agentRunId === 'agent_run:1') { entered = true; await blocked; } return 'READY'; },
    runCodexAppServerTurn: x => { executed.push(x.agentRunId); return completed; },
    finishRoomAgentSupervisorTurn: x => { finished.push(x); },
  }, async queue => {
    const handle = await start(queue, 'roomAgentSupervisorWorkflow', supervisor({ pending: [item(1)] }));
    await eventually(() => entered);
    await handle.signal('enqueueRoomAgentMission', item(1));
    await handle.signal('enqueueRoomAgentMission', item(2));
    await handle.signal('enqueueRoomAgentMission', item(2));
    await handle.signal('enqueueRoomAgentMission', { malformed: true });
    await handle.signal('enqueueRoomAgentMission', { ...item(3), turn: { ...turn(3), roomId: 'room:foreign' } });
    release();
    await eventually(() => finished.length === 1);
    expect(executed).toEqual(['agent_run:1', 'agent_run:2']);
    expect(finished[0]).toMatchObject({ item: { turn: { agentRunId: 'agent_run:2' } }, status: 'COMPLETED' });
    await env.sleep('3 seconds');
    expect(executed).toEqual(['agent_run:1', 'agent_run:2']);
    expect(finished).toHaveLength(1);
    await handle.terminate('synthetic complete');
  });
}, 30_000);

/** Advance virtual time in bounded steps until an external activity milestone is observed. */
async function advanceUntil(check: () => boolean) {
  // Bound each clock advance. Unlocking time indefinitely can jump an idle
  // supervisor to its server timeout after the final activity completes.
  for (let step = 0; step < 30; step++) {
    if (check()) return;
    await env.sleep('1 second');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  expect(check(), 'virtual-time activity milestone').toBe(true);
}

it('replays every checked-in history using current production workflows and rejects an incompatible workflow', async () => {
  const names = await readHistoryFixtureNames(fixtureDir);
  const histories = [];
  for (const name of names) histories.push({ workflowId: name, history: temporal.api.history.v1.History.fromObject(JSON.parse(await readFile(join(fixtureDir, name), 'utf8'))) });
  const failures = [];
  for await (const result of Worker.runReplayHistories({ workflowBundle: current }, histories)) if (result.error) failures.push(`${result.workflowId}: ${result.error}`);
  expect(failures).toEqual([]);
  for (const name of ['dummyTurnWorkflow.json', 'dotGoalWorkflow-signal.json']) {
    const history = histories.find(h => h.workflowId === name)!;
    await expect(Worker.runReplayHistory({ workflowBundle: negative }, history.history), name).rejects.toBeInstanceOf(DeterminismViolationError);
  }
}, 45_000);
