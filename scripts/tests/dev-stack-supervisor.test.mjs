// 龙娘 · 2026-10-26: exercise control races, readiness failures, cancellation, ownership and redaction for #65.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, rm, access, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRedactedOutput, acquireLifetimeLock, requestControl, listenControl, waitForReady, StackSupervisor, runDevStack } from '../dev-stack/supervisor.mjs';

async function temporary(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'stack-supervisor-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { resolve, reject, promise };
}
function fixture(overrides = {}) {
  const events = [];
  const manager = new EventEmitter();
  manager.stopAll = async () => { events.push('children-stop'); };
  const runtime = {
    prepareRuntime: async () => { events.push('prepare'); return { env: {} }; },
    buildRuntime: async () => { events.push('build'); },
    prepareInfrastructure: async () => { events.push('infrastructure'); },
    startServices: async () => { events.push('start'); return async () => { events.push('watchers-stop'); }; },
    compose: async (config, args) => { events.push(`compose:${args.join(' ')}`); },
    ...overrides,
  };
  const supervisor = new StackSupervisor({
    config: { stateDir: '/unused', ports: { api: 14910, web: 14911 } },
    secrets: { setupToken: 'generated-token' }, runtime, manager,
    output: message => events.push(`output:${message}`),
    ready: async () => { events.push('ready'); },
    verifyState: async () => { events.push('verify'); },
    removeState: async () => { events.push('remove'); },
  });
  return { supervisor, events, manager, runtime };
}

test('chunk redactor conceals generated secrets across all chunk boundaries and UTF-8', () => {
  const secret = 'private-secret-12345';
  for (let cut = 1; cut < secret.length; cut++) {
    let actual = '';
    const output = createRedactedOutput([secret, 'other-secret'], (name, chunk) => { actual += chunk; });
    output.push('api', Buffer.from(`before ${secret.slice(0, cut)}`));
    output.push('api', Buffer.from(`${secret.slice(cut)} other-secret after 紫`));
    output.flush();
    assert.equal(actual, 'before [REDACTED] [REDACTED] after 紫');
  }
  let actual = '';
  const output = createRedactedOutput([secret], (name, chunk) => { actual += chunk; });
  for (const byte of Buffer.from(`紫 ${secret} 眼`)) output.push('api', Buffer.from([byte]));
  output.flush();
  assert.equal(actual, '紫 [REDACTED] 眼');
});

test('lifetime lock excludes simultaneous up and offline resets and does not follow symlinks', async t => {
  const dir = await temporary(t);
  const release = await acquireLifetimeLock(dir);
  await assert.rejects(acquireLifetimeLock(dir), /already running/);
  await release();
  await release();
  const release2 = await acquireLifetimeLock(dir);
  await release2();
  const other = path.join(dir, 'unrelated');
  await mkdir(other);
  await symlink(other, path.join(dir, '.dev-stack-lock'));
  await assert.rejects(acquireLifetimeLock(dir), /already running/);
  await access(other);
});

test('exclusive Unix control endpoint handles commands and reports execution errors', async t => {
  const dir = await temporary(t);
  const socket = path.join(dir, 'control.sock');
  const seen = [];
  const control = await listenControl(socket, async command => {
    seen.push(command);
    if (command === 'reset') throw new Error('state ownership denied');
  });
  t.after(() => { control.close(); control.destroyClients(); });
  await assert.rejects(listenControl(socket, async () => {}), { code: 'EADDRINUSE' });
  assert.equal((await requestControl(socket, 'down')).ok, true);
  await assert.rejects(requestControl(socket, 'reset'), /state ownership denied/);
  await assert.rejects(requestControl(socket, 'anything'), /Unknown supervisor/);
  assert.deepEqual(seen, ['down', 'reset']);
});

test('control timeout does not fall back into destructive offline actions', async t => {
  const dir = await temporary(t);
  const pending = deferred();
  const control = await listenControl(path.join(dir, 'control.sock'), () => pending.promise);
  t.after(() => { pending.resolve(); control.close(); control.destroyClients(); });
  await assert.rejects(requestControl(path.join(dir, 'control.sock'), 'reset', { timeoutMs: 20 }), /shutdown\/build may still be running/);
});

test('strict readiness requires JSON ok plus database, workflows and CLI host', async () => {
  const statuses = [
    { ok: true, dependencies: { database: 'RUNNING', worker: 'disabled', cliHost: 'RUNNING' } },
    { ok: false, dependencies: { database: 'RUNNING', worker: 'RUNNING', cliHost: 'RUNNING' } },
    { ok: true, dependencies: { database: 'RUNNING', worker: 'RUNNING', cliHost: 'RUNNING' } },
  ];
  let calls = 0;
  await waitForReady({ ports: { api: 14910 } }, {
    intervalMs: 1,
    fetchFn: async url => {
      assert.equal(url, 'http://127.0.0.1:14910/readyz?strict=1');
      return { ok: true, status: 200, json: async () => statuses[calls++] };
    },
  });
  assert.equal(calls, 3);
  await assert.rejects(waitForReady({ ports: { api: 14910 } }, {
    timeoutMs: 10, intervalMs: 1,
    fetchFn: async () => ({ ok: false, status: 503, json: async () => ({ ok: false }) }),
  }), /strict readiness timed out.*HTTP 503/);
});

test('readiness cancels promptly rather than waiting for its deadline', async () => {
  const controller = new AbortController();
  controller.abort(new Error('shutdown now'));
  await assert.rejects(waitForReady({ ports: { api: 14910 } }, { signal: controller.signal }), /shutdown now/);
});

test('normal shutdown stops watchers before children, verifies ownership and preserves volumes', async () => {
  const { supervisor, events } = fixture();
  await supervisor.start();
  await supervisor.stop();
  await supervisor.finished;
  assert.deepEqual(events.filter(event => !event.startsWith('output:')), ['prepare', 'build', 'infrastructure', 'start', 'ready', 'watchers-stop', 'children-stop', 'verify', 'compose:stop']);
});

test('reset removes state only after verified volume teardown and children cleanup', async () => {
  const { supervisor, events } = fixture();
  await supervisor.start();
  await supervisor.command('reset');
  await supervisor.finished;
  assert.deepEqual(events.slice(-6), ['watchers-stop', 'children-stop', 'verify', 'compose:down --volumes --remove-orphans', 'verify', 'remove']);
});

test('cleanup failure is visible, retains state and still attempts compose teardown', async () => {
  const { supervisor, manager, events } = fixture();
  await supervisor.start();
  manager.stopAll = async () => { events.push('children-failed'); throw new Error('cannot reap child'); };
  await assert.rejects(supervisor.command('reset'), /cannot reap child/);
  await assert.rejects(supervisor.finished, /cannot reap child/);
  assert.equal(events.includes('remove'), false);
  assert.ok(events.includes('compose:down --volumes --remove-orphans'));
});

test('ownership failure never invokes compose or removes files', async () => {
  const { supervisor, events } = fixture();
  await supervisor.start();
  supervisor.verifyState = async () => { throw new Error('ownership mismatch'); };
  await assert.rejects(supervisor.command('reset'), /ownership mismatch/);
  assert.equal(events.some(event => event.startsWith('compose:')), false);
  assert.equal(events.includes('remove'), false);
});

test('a reset arriving during shutdown is rejected until shutdown completes', async () => {
  const { supervisor, manager, events } = fixture();
  await supervisor.start();
  const pending = deferred();
  manager.stopAll = () => pending.promise;
  const shutdown = supervisor.stop();
  await assert.rejects(supervisor.command('reset'), /Shutdown is already pending/);
  await assert.rejects(supervisor.command('rebuild'), /Shutdown is already pending/);
  pending.resolve();
  await shutdown;
  assert.equal(events.includes('remove'), false);
});

test('service exit code zero still fails supervisor and performs orderly cleanup', async () => {
  const { supervisor, manager, events } = fixture();
  await supervisor.start();
  manager.emit('failure', { name: 'api', code: 0, signal: null });
  await assert.rejects(supervisor.finished, /Service api exited unexpectedly.*code 0/);
  assert.ok(events.includes('watchers-stop'));
  assert.ok(events.includes('compose:stop'));
});

test('startup cancellation waits for owned one-shots before resetting state', async () => {
  const entered = deferred();
  const exited = deferred();
  const { supervisor, events } = fixture({ buildRuntime: async (config, env, { signal }) => {
    entered.resolve();
    await new Promise((resolve, reject) => signal.addEventListener('abort', () => {
      events.push('build-aborted');
      exited.promise.then(() => reject(signal.reason));
    }, { once: true }));
  } });
  const startup = supervisor.start();
  await entered.promise;
  const resetting = supervisor.command('reset');
  await Promise.resolve();
  assert.equal(events.includes('remove'), false);
  exited.resolve();
  await assert.rejects(startup, /shutdown requested/);
  await resetting;
  assert.ok(events.indexOf('build-aborted') < events.indexOf('remove'));
  assert.equal(events.includes('start'), false);
});

test('rebuild serializes watcher cleanup, build and readiness; duplicate rebuild is rejected', async () => {
  const { supervisor, events } = fixture();
  await supervisor.start();
  const rebuilding = supervisor.command('rebuild');
  await assert.rejects(supervisor.command('rebuild'), /already pending/);
  await rebuilding;
  assert.deepEqual(events.filter(event => !event.startsWith('output:')).slice(5), ['watchers-stop', 'children-stop', 'build', 'infrastructure', 'start', 'ready']);
  await supervisor.stop();
});


test('actual foreground supervisor cancels startup through control reset and removes both owned state and lifetime lock', async t => {
  const root = await temporary(t);
  const templates = path.join(root, 'packages/run-spaceapp/templates');
  await mkdir(templates, { recursive: true });
  const digest = 'a'.repeat(64);
  await writeFile(path.join(templates, 'compose.yml'), `services:\n  postgres:\n    image: pgvector/pgvector:test@sha256:${digest}\n  temporal:\n    image: temporalio/auto-setup:test@sha256:${digest}\n`);
  await writeFile(path.join(root, 'Dockerfile'), 'RUN npm install @opencode/cli@2.0.32');
  const entered = deferred();
  const calls = [];
  const runtime = {
    prepareRuntime: async () => ({ env: {} }),
    buildRuntime: async (config, env, { signal }) => {
      entered.resolve();
      await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    },
    compose: async (config, args) => { calls.push(args); },
  };
  const foreground = runDevStack({ repoRoot: root, runtime });
  await entered.promise;
  await assert.rejects(runDevStack({ repoRoot: root, runtime }), /already running/);
  const result = await requestControl(path.join(root, '.dev-stack/control.sock'), 'reset');
  await foreground;
  assert.equal(result.ok, true);
  assert.deepEqual(calls, [['down', '--volumes', '--remove-orphans']]);
  await assert.rejects(access(path.join(root, '.dev-stack')), { code: 'ENOENT' });
  await assert.rejects(access(path.join(root, '.dev-stack-lock')), { code: 'ENOENT' });
});

test('startup errors preserve sanitized stderr details and cleanup still runs', async () => {
  const { supervisor, events } = fixture({ buildRuntime: async () => { throw Object.assign(new Error('build rejected'), { stderr: 'detail contains generated-token' }); } });
  await assert.rejects(supervisor.start(), /build rejected/);
  await assert.rejects(supervisor.finished, /build rejected\ndetail contains \[REDACTED\]/);
  assert.ok(events.includes('compose:stop'));
});


test('aggregate cleanup failures retain actionable child error details', async () => {
  const { supervisor, manager } = fixture();
  await supervisor.start();
  manager.stopAll = async () => { throw new AggregateError([Object.assign(new Error('SIGTERM denied'), { stderr: 'child process diagnostic' })], 'Failed to stop development processes'); };
  await assert.rejects(supervisor.stop(), /Failed to stop development processes\nSIGTERM denied\nchild process diagnostic/);
});

test('a genuine concurrent startup error remains visible when shutdown has already been requested', async () => {
  const entered = deferred();
  const failed = deferred();
  const { supervisor } = fixture({ buildRuntime: async () => { entered.resolve(); await failed.promise; throw new Error('compiler failure before cancellation completed'); } });
  const startup = supervisor.start();
  await entered.promise;
  const shutdown = supervisor.stop();
  failed.resolve();
  await assert.rejects(startup, /compiler failure/);
  await assert.rejects(shutdown, /compiler failure/);
  await assert.rejects(supervisor.finished, /compiler failure/);
});
