// 龙娘 · 2026-10-26：为 SpaceApp #65 新建真实进程与进程组回收回归测试。
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { ProcessManager } from '../dev-stack/processes.mjs';

const posix = process.platform !== 'win32';
const persistent = 'setInterval(() => {}, 1000)';

function managerFor(t, options) {
  const manager = new ProcessManager(options);
  t.after(() => manager.stopAll());
  return manager;
}

async function waitFor(check, timeout = 2_000) {
  const deadline = performance.now() + timeout;
  while (!(await check())) {
    if (performance.now() >= deadline) throw new Error('Timed out waiting for child process state');
    await delay(10);
  }
}

async function alive(pid) {
  try {
    process.kill(pid, 0);
    if (process.platform === 'linux') {
      // Orphan zombies have already terminated; container init may reap them later.
      const status = await readFile(`/proc/${pid}/status`, 'utf8');
      if (/^State:\s+Z/m.test(status)) return false;
    }
    return true;
  } catch (error) {
    if (error.code === 'ESRCH' || error.code === 'ENOENT') return false;
    throw error;
  }
}

test('pipes stdout and stderr with the process name and returns its child', { skip: !posix }, async (t) => {
  const output = [];
  const manager = managerFor(t, { onOutput: (name, chunk, stream) => output.push({ name, text: chunk.toString(), stream }) });
  const failures = [];
  manager.on('failure', (event) => failures.push(event));
  const child = manager.start('output', process.execPath, ['-e', `process.stdout.write('hello'); process.stderr.write('warning'); ${persistent}`]);
  assert.equal(manager.get('output'), child);
  assert.equal(manager.get('missing'), undefined);
  await waitFor(() => output.some((item) => item.text.includes('hello')) && output.some((item) => item.text.includes('warning')));
  assert.ok(output.every((item) => item.name === 'output'));
  assert.ok(output.some((item) => item.stream === 'stdout' && item.text === 'hello'));
  assert.ok(output.some((item) => item.stream === 'stderr' && item.text === 'warning'));
  await manager.stop('output');
  assert.equal(manager.get('output'), undefined);
  assert.deepEqual(failures, []);
});

test('reports even a successful unexpected exit and a failed spawn once', { skip: !posix }, async (t) => {
  const manager = managerFor(t);
  const events = [];
  manager.on('failure', (event) => events.push(event));
  const exited = once(manager, 'failure');
  manager.start('exit-zero', process.execPath, ['-e', 'process.exit(0)']);
  const [event] = await exited;
  assert.equal(event.name, 'exit-zero');
  assert.equal(event.code, 0);
  assert.equal(event.signal, null);
  assert.equal(event.error, undefined);
  const failed = once(manager, 'failure');
  manager.start('missing', '/spaceapp-no-such-command-65', []);
  const [spawnFailure] = await failed;
  assert.equal(spawnFailure.name, 'missing');
  assert.equal(spawnFailure.error.code, 'ENOENT');
  await delay(30);
  assert.equal(events.length, 2);
});

test('rejects duplicate starts and permits restart after concurrent stops', { skip: !posix }, async (t) => {
  const manager = managerFor(t);
  const failures = [];
  manager.on('failure', (event) => failures.push(event));
  const first = manager.start('service', process.execPath, ['-e', persistent]);
  assert.throws(() => manager.start('service', process.execPath, ['-e', persistent]), /already tracked/);
  await Promise.all([manager.stop('service'), manager.stop('service')]);
  const second = manager.start('service', process.execPath, ['-e', persistent]);
  assert.notEqual(second.pid, first.pid);
  await manager.stopAll();
  await manager.stop('missing');
  assert.deepEqual(failures, []);
});

test('stop cleans up a real grandchild in the spawned process group', { skip: !posix }, async (t) => {
  let output = '';
  const manager = managerFor(t, { onOutput: (_name, chunk) => { output += chunk; } });
  const child = manager.start('family', process.execPath, ['--input-type=module', '-e', `
    import { spawn } from 'node:child_process';
    const grandchild = spawn(process.execPath, ['-e', ${JSON.stringify(persistent)}], { stdio: 'ignore' });
    console.log(grandchild.pid);
    ${persistent};
  `]);
  await waitFor(() => output.includes('\n'));
  const grandchildPid = Number(output.trim());
  assert.ok(await alive(grandchildPid));
  await manager.stop('family');
  await waitFor(async () => !(await alive(child.pid)) && !(await alive(grandchildPid)));
});

test('stopAll cleans descendants after the group leader has already exited', { skip: !posix }, async (t) => {
  let output = '';
  const manager = managerFor(t, { onOutput: (_name, chunk) => { output += chunk; } });
  const failed = once(manager, 'failure');
  manager.start('orphan-family', process.execPath, ['--input-type=module', '-e', `
    import { spawn } from 'node:child_process';
    const grandchild = spawn(process.execPath, ['-e', ${JSON.stringify(persistent)}], { stdio: 'ignore' });
    console.log(grandchild.pid);
    grandchild.unref();
  `]);
  await failed;
  await waitFor(() => output.includes('\n'));
  const grandchildPid = Number(output.trim());
  assert.ok(await alive(grandchildPid));
  await manager.stopAll();
  await waitFor(async () => !(await alive(grandchildPid)));
});

test('escalates TERM-resistant children within a bounded grace period', { skip: !posix }, async (t) => {
  let ready = false;
  const manager = managerFor(t, { onOutput: () => { ready = true; } });
  const failures = [];
  manager.on('failure', (event) => failures.push(event));
  const child = manager.start('stubborn', process.execPath, ['-e', `process.on('SIGTERM', () => {}); console.log('ready'); ${persistent}`]);
  await waitFor(() => ready);
  const started = performance.now();
  await manager.stop('stubborn');
  const duration = performance.now() - started;
  assert.ok(duration >= 2_800, `grace period too short: ${duration}ms`);
  assert.ok(duration < 4_500, `stop exceeded its bound: ${duration}ms`);
  assert.equal(child.signalCode, 'SIGKILL');
  assert.deepEqual(failures, []);
});