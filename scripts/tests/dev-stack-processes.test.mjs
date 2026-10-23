import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

test('a child exit is reported and stopping terminates the owned child group', async t => {
  const { Processes } = await import('../dev-stack-processes.mjs');
  const directory = await mkdtemp(join(tmpdir(), 'dev-process-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const failures = [];
  const processes = new Processes({ root: directory, state: directory, project: 'test-dev-stack', env: process.env, secrets: ['sensitive-value'], onFailure: error => failures.push(error.message) });
  t.after(() => processes.stop());
  const normal = processes.start('running', process.execPath, ['-e', 'setInterval(()=>{},1000)']);
  const failed = processes.start('broken', process.execPath, ['-e', 'console.log("sensitive-value");process.exit(7)']);
  await failed.done;
  assert.equal(failures.length, 1);
  assert.match(failures[0], /broken.*7/);
  assert.doesNotMatch(await readFile(join(directory, 'logs/broken.log'), 'utf8'), /sensitive-value/);
  await processes.stop();
  assert.throws(() => process.kill(normal.child.pid, 0), { code: 'ESRCH' });
});
