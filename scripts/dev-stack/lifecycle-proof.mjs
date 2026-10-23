#!/usr/bin/env node
// Real hosted acceptance. This is deliberately separate from the daemon-free unit suite.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { appendFile, lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractPins, loadOwner, locations, ownerLabel, readJson } from './state.mjs';
import { delay, descendants, processIdentity, sameProcess, stopRecorded } from './processes.mjs';
import { assertOwnedDocker, dockerEnvironment, run } from './resources.mjs';

if (!['linux', 'darwin'].includes(process.platform)) throw new Error('The real stack proof requires Linux or Intel macOS with an existing Docker daemon.');
const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const artifacts = resolve(process.env.SPACE_DEV_PROOF_DIR || '');
const proofRelative = relative(root, artifacts);
if (!process.env.SPACE_DEV_PROOF_DIR || !proofRelative || (!proofRelative.startsWith('..') && !isAbsolute(proofRelative))) throw new Error('SPACE_DEV_PROOF_DIR must be outside the checkout. Never upload the private state tree.');
await mkdir(artifacts, { recursive: true, mode: 0o700 });
const candidate = process.env.SPACE_DEV_CANDIDATE;
assert.match(candidate || '', /^[a-f0-9]{40}$/, 'An exact reviewed candidate SHA is required.');
assert.equal((await run('git', ['rev-parse', 'HEAD'], { cwd: root, env: dockerEnvironment() })).trim(), candidate);
const env = { ...dockerEnvironment(), CI: 'true', SPACE_DEV_REDACT_SETUP: 'true', SPACE_DEV_PROOF_DIR: artifacts, SPACE_DEV_CANDIDATE: candidate };
const nonce = randomBytes(12).toString('hex'), proofLabel = 'io.spaceapp.dev-stack.proof';
const sentinelName = `spaceapp-independent-${nonce}`, sentinelVolume = `${sentinelName}-data`;
const configs = [], checks = [], usedPorts = new Set([4910, 4911]);
let sentinel, sentinelRecord, sentinelContainerCreated = false, sentinelVolumeCreated = false, failure;
const mark = name => { checks.push(name); console.log(`[dev-stack-lifecycle] PASS ${name}`); };
const docker = (args, options = {}) => run('docker', args, { env: dockerEnvironment(), ...options });
const exists = async path => Boolean(await lstat(path).catch(e => { if (e.code === 'ENOENT') return null; throw e; }));
async function port() {
  for (;;) {
    const selected = await new Promise((done, reject) => { const server = createServer(); server.once('error', reject); server.listen(0, '127.0.0.1', () => { const selectedPort = server.address().port; server.close(() => done(selectedPort)); }); });
    if (!usedPorts.has(selected)) { usedPorts.add(selected); return selected; }
  }
}
async function configuration(suffix) {
  const settings = { ...env, SPACE_DEV_STATE_DIR: `.dev-stack-proof-${suffix}` };
  for (const key of ['API', 'WEB', 'POSTGRES', 'TEMPORAL']) settings[`SPACE_DEV_${key}_PORT`] = String(await port());
  const config = locations(root, settings);
  assert.equal(await exists(config.state), false, 'A proof must never adopt existing state.');
  configs.push({ config, env: settings });
  return { config, env: settings };
}
async function capture(settings, name) {
  const child = spawn(process.execPath, ['scripts/dev-stack.mjs'], { cwd: root, env: settings.env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', writes = Promise.resolve(), error;
  const file = join(artifacts, `${name}.log`);
  const log = chunk => { const text = chunk.toString(); output += text; writes = writes.then(() => appendFile(file, text, { mode: 0o600 })); };
  child.stdout.on('data', log); child.stderr.on('data', log);
  child.once('error', value => { error = value; });
  const closed = new Promise(done => child.once('close', async (code, signal) => { await writes; done({ code, signal }); }));
  const stack = { child, closed, output: () => output, error: () => error, ...settings };
  return stack;
}
async function waitReady(stack) {
  const deadline = Date.now() + 900000;
  while (Date.now() < deadline) {
    if (stack.error() || stack.child.exitCode !== null || stack.child.signalCode !== null) throw new Error('Stack exited before real readiness; see its retained redacted log.');
    try {
      const response = await fetch(`http://127.0.0.1:${stack.config.ports.api}/readyz`, { signal: AbortSignal.timeout(6000) });
      if (response.ok && (await response.json()).ok === true) return;
    } catch { /* Startup can legitimately take time before the API binds. */ }
    await delay(1000);
  }
  throw new Error('Stack readiness exceeded 15 minutes; no acceptance is claimed.');
}
async function processSnapshot(config) {
  const record = await readJson(config.supervisor), result = [];
  for (const item of record.children) {
    try { if (await sameProcess(item)) result.push(...await descendants(item)); }
    catch (error) {
      // Selected ownership context only; the strict guard remains fatal and is never retried.
      throw new Error(`Owned snapshot ${String(item.name).slice(0, 32)} pid=${item.pid} expected=${String(item.identity).slice(0, 160)}: ${error.message}`, { cause: error });
    }
  }
  return result;
}
async function assertStopped(records) { assert.equal((await Promise.all(records.map(record => sameProcess(record)))).some(Boolean), false, 'An owned source/PTY process survived cleanup.'); }
async function resources(owner, kind) {
  await assertOwnedDocker(owner);
  return (await docker([kind, 'ls', ...(kind === 'container' ? ['-a'] : []), '-q', '--filter', `label=com.docker.compose.project=${owner.project}`])).trim().split(/\s+/).filter(Boolean);
}
async function assertReset(config, owner, records) {
  await assertStopped(records);
  for (const kind of ['container', 'volume', 'network']) {
    assert.equal((await resources(owner, kind)).length, 0, `Owned ${kind} survived reset.`);
    assert.equal((await docker([kind, 'ls', ...(kind === 'container' ? ['-a'] : []), '-q', '--filter', `label=${ownerLabel}=${owner.nonce}`])).trim(), '');
  }
  assert.equal(await exists(config.state), false, 'Reset left the private state directory.');
}
async function assertSentinels() {
  assert(await sameProcess(sentinelRecord), 'Unrelated sentinel process was stopped.');
  for (const p of [4910, 4911]) assert.equal(await (await fetch(`http://127.0.0.1:${p}`, { signal: AbortSignal.timeout(3000) })).text(), nonce);
  assert.equal((await docker(['container', 'inspect', '--format', '{{.State.Running}}', sentinelName])).trim(), 'true');
  assert.equal((await docker(['volume', 'inspect', '--format', `{{index .Labels "${proofLabel}"}}`, sentinelVolume])).trim(), nonce);
}
async function action(settings, verb, options = {}) {
  return run(process.execPath, ['scripts/dev-stack.mjs', verb], { cwd: root, env: settings.env, output: text => process.stdout.write(text), timeout: 240000, ...options });
}
try {
  const sentinelSource = `const http=require('node:http'); const servers=[4910,4911].map(port=>http.createServer((_q,r)=>r.end(${JSON.stringify(nonce)})).listen(port,'127.0.0.1')); let ready=0; for(const s of servers){s.on('listening',()=>{if(++ready===2)process.send('ready')});s.on('error',()=>process.exit(1))}`;
  sentinel = spawn(process.execPath, ['-e', sentinelSource], { env: { PATH: process.env.PATH }, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  await new Promise((done, reject) => { sentinel.once('message', done); sentinel.once('error', reject); sentinel.once('exit', () => reject(new Error('Could not reserve synthetic installed ports 4910/4911.'))); });
  sentinelRecord = { pid: sentinel.pid, identity: await processIdentity(sentinel.pid) };
  const pins = extractPins(await readFile(join(root, 'packages/run-spaceapp/templates/compose.yml'), 'utf8'), await readFile(join(root, 'Dockerfile'), 'utf8'));
  await docker(['pull', pins.postgres], { timeout: 300000 });
  await docker(['volume', 'create', '--label', `${proofLabel}=${nonce}`, sentinelVolume]); sentinelVolumeCreated = true;
  await docker(['run', '-d', '--name', sentinelName, '--label', `${proofLabel}=${nonce}`, '--network', 'none', '--read-only', '--mount', `type=volume,source=${sentinelVolume},target=/sentinel`, '--entrypoint', '/bin/sh', pins.postgres, '-c', 'while :; do sleep 60; done']); sentinelContainerCreated = true;
  // Keep the shell simple, and assert it is really running before testing our cleanup.
  await assertSentinels();
  const first = await configuration('a'), stack = await capture(first, 'normal-stack');
  await waitReady(stack); const owner = await loadOwner(first.config);
  mark('normal workflows-enabled startup with installed ports 4910/4911 already occupied');
  const firstSecretHashes = await Promise.all(['postgres-password', 'session-secret'].map(async name => createHash('sha256').update(await readFile(join(first.config.state, 'secrets', name))).digest('hex')));
  await run(process.execPath, ['scripts/dev-stack/acceptance.mjs'], { cwd: root, env: first.env, timeout: 900000, output: text => process.stdout.write(text) });
  const records = await processSnapshot(first.config);
  assert((await resources(owner, 'volume')).length > 0);
  await action(first, 'down'); assert.equal((await stack.closed).code, 0);
  await assertStopped(records); assert.equal((await resources(owner, 'container')).length, 0);
  assert((await resources(owner, 'volume')).length > 0, 'down should retain the dev database volume.');
  await assertSentinels(); mark('down stops only owned services and preserves state/database and all independent sentinels');
  const manifestBefore = await readFile(first.config.manifest);
  const broken = { ...first.env, DOCKER_HOST: 'tcp://127.0.0.1:9' }; delete broken.DOCKER_CONTEXT; delete broken.DOCKER_TLS_VERIFY; delete broken.DOCKER_CERT_PATH;
  await assert.rejects(action(first, 'reset', { env: broken, timeout: 30000 }));
  assert.deepEqual(await readFile(first.config.manifest), manifestBefore); await assertSentinels();
  mark('failed Docker cleanup propagates failure and retains owned recovery state');
  await action(first, 'reset'); await assertReset(first.config, owner, records); await assertSentinels();
  mark('normal reset removes owned containers/volumes/networks/processes/state only');
  const second = await configuration('b'), failing = await capture(second, 'forced-failure-stack');
  assert(Object.values(second.config.ports).every(p => !Object.values(first.config.ports).includes(p)));
  await waitReady(failing); const secondOwner = await loadOwner(second.config);
  assert.notEqual(secondOwner.project, owner.project);
  const secondSecretHashes = await Promise.all(['postgres-password', 'session-secret'].map(async name => createHash('sha256').update(await readFile(join(second.config.state, 'secrets', name))).digest('hex')));
  assert(firstSecretHashes.every((hash, i) => hash !== secondSecretHashes[i]));
  mark('second fresh state uses alternate ports, project ownership and new generated secrets');
  const failureRecords = await processSnapshot(second.config), worker = (await readJson(second.config.supervisor)).children.find(x => x.name === 'worker');
  assert(worker && await sameProcess(worker)); process.kill(worker.pid, 'SIGKILL');
  let failureTimer;
  const result = await Promise.race([failing.closed, new Promise((_done, reject) => { failureTimer = setTimeout(() => reject(new Error('Required-child failure left a half-running stack.')), 180000); })]).finally(() => clearTimeout(failureTimer));
  assert.notEqual(result.code, 0); assert.match(failing.output(), /worker exited unexpectedly/);
  await assertStopped(failureRecords); assert.equal((await resources(secondOwner, 'container')).length, 0);
  assert(await exists(second.config.manifest)); await assertSentinels();
  mark('an actual killed worker is named, produces failure and stops the other owned services');
  await action(second, 'reset'); await assertReset(second.config, secondOwner, failureRecords); await assertSentinels();
  mark('failure-path reset cleans every owned resource and leaves unrelated sentinels alive');
  await run('git', ['diff', '--exit-code'], { cwd: root, env: dockerEnvironment() });
  assert.equal((await run('git', ['rev-parse', 'HEAD'], { cwd: root, env: dockerEnvironment() })).trim(), candidate);
  mark('exact candidate retained; every temporary reload canary restored byte-for-byte');
} catch (error) { failure = error; }
finally {
  for (const settings of [...configs].reverse()) if (await exists(settings.config.manifest)) {
    try { await action(settings, 'reset'); }
    catch (error) { failure ||= error; console.error('Owned recovery state remains; see the named lifecycle failure.'); }
  }
  // Proof-only sentinel removal is separately label-checked; the launcher never owns it.
  try {
    if (sentinelContainerCreated) { assert.equal((await docker(['container', 'inspect', '--format', `{{index .Config.Labels "${proofLabel}"}}`, sentinelName])).trim(), nonce); await docker(['container', 'rm', '-f', sentinelName]); }
    if (sentinelVolumeCreated) { assert.equal((await docker(['volume', 'inspect', '--format', `{{index .Labels "${proofLabel}"}}`, sentinelVolume])).trim(), nonce); await docker(['volume', 'rm', sentinelVolume]); }
    if (sentinelRecord) await stopRecorded([sentinelRecord]);
  } catch (error) { failure ||= error; }
  await writeFile(join(artifacts, 'lifecycle.json'), JSON.stringify({ source: candidate, platform: process.platform, status: failure ? 'FAIL' : 'PASS', checks, error: failure?.message || null, provider_inference: false }, null, 2) + '\n', { mode: 0o600 });
}
if (failure) throw failure;
