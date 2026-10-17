import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile, mkdir, mkdtemp, realpath, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { composeDocument, extractPins, initialize, loadOwner, locations, ownerLabel, privateWrite, secrets, serviceEnvironment } from '../dev-stack/state.mjs';
import { descendants, LaunchBarrier, lineRedactor, processIdentity, sameProcess, stopRecorded } from '../dev-stack/processes.mjs';
import { assertOwnedDocker, composeArgs, diagnoseOwnedDocker, dockerEnvironment, removeOwnedDocker, run } from '../dev-stack/resources.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const pins = extractPins(await readFile(join(root, 'packages/run-spaceapp/templates/compose.yml'), 'utf8'), await readFile(join(root, 'Dockerfile'), 'utf8'));
async function sandbox(t) {
  const parent = await realpath(tmpdir());
  if (process.platform === 'win32') assert.match(parent, /^[FE]:[\\/]/i, 'Test temporary work must be on F: or E:.');
  const base = await mkdtemp(join(parent, 'space-dev-stack-test-'));
  t.after(async () => { assert.equal(await realpath(base), resolve(base)); assert(resolve(base).startsWith(parent)); await rm(base, { recursive: true, force: true }); });
  return locations(base);
}
test('pins are derived from the canonical image/version sources', () => {
  assert.match(pins.postgres, /^pgvector\/pgvector:.*@sha256:[a-f0-9]{64}$/);
  assert.match(pins.temporal, /^temporalio\/auto-setup:.*@sha256:[a-f0-9]{64}$/);
  assert.match(pins.opencode, /^\d+\.\d+\.\d+$/);
  assert.throws(() => extractPins('  postgres:\n    image: postgres:latest\n', 'opencode-ai@1.2.3'), /digest/);
  const sample = `services:\n  postgres:\n    image: postgres:test@sha256:${'a'.repeat(64)}\n  temporal:\n    image: temporal:test@sha256:${'b'.repeat(64)}\n`;
  assert.equal(extractPins(sample, 'opencode-ai@2.3.4').opencode, '2.3.4');
  assert.equal(extractPins(sample, 'opencode-ai@2.3.4').postgres, `postgres:test@sha256:${'a'.repeat(64)}`);
});
test('ports are isolated, distinct and explicitly configurable', () => {
  assert.equal(locations(root).ports.api, 4810);
  assert.equal(locations(root, { SPACE_DEV_API_PORT: '5810' }).ports.api, 5810);
  for (const value of ['4910', '4911', '0', '99999', '4810suffix', '0.0.0.0']) assert.throws(() => locations(root, { SPACE_DEV_API_PORT: value }));
  assert.throws(() => locations(root, { SPACE_DEV_API_PORT: '4811' }), /distinct/);
});
test('deletion targets are confined to named direct checkout children', () => {
  for (const value of ['..', '../data', '/', 'node_modules', '.git', '.dev-stack/../secrets', '/tmp/.dev-stack']) assert.throws(() => locations(root, { SPACE_DEV_STATE_DIR: value }));
  assert.equal(locations(root, { SPACE_DEV_STATE_DIR: '.dev-stack-isolated' }).state, join(resolve(root), '.dev-stack-isolated'));
});
test('fresh state generates unique owners and secrets; restart preserves consumed-token state', async t => {
  const config = await sandbox(t), owner = await initialize(config), initial = await secrets(config);
  assert.equal(owner.nonce.length, 32); assert.equal(owner.project, `spaceapp-dev-${owner.nonce.slice(0, 16)}`);
  assert.equal(new Set(Object.values(initial)).size, 3);
  assert.deepEqual(await initialize(config), owner);
  await rm(join(config.state, 'secrets/setup-token'));
  await initialize(config); assert.equal((await secrets(config)).token, '');
  const second = await initialize(locations(config.root, { SPACE_DEV_STATE_DIR: '.dev-stack-second' }));
  assert.notEqual(second.nonce, owner.nonce);
});
test('secret files and generated compose are private on supported POSIX hosts', { skip: process.platform === 'win32' }, async t => {
  const config = await sandbox(t); await initialize(config);
  await privateWrite(config.compose, '{}');
  for (const name of ['postgres-password', 'session-secret', 'setup-token']) assert.equal((await stat(join(config.state, 'secrets', name))).mode & 0o777, 0o600);
  assert.equal((await stat(config.compose)).mode & 0o777, 0o600);
  assert.equal((await stat(config.state)).mode & 0o777, 0o700);
});
test('an unknown existing directory is never adopted or deleted', async t => {
  const config = await sandbox(t); await mkdir(config.state);
  await assert.rejects(initialize(config)); await assert.rejects(loadOwner(config));
  assert((await stat(config.state)).isDirectory());
});
test('linked state and linked manifests are rejected before mutation', async t => {
  const config = await sandbox(t), outside = join(config.root, 'sentinel'); await mkdir(outside);
  await symlink(outside, config.state, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(initialize(config), /linked/); assert((await stat(outside)).isDirectory());
  await rm(config.state); const owner = await initialize(config); assert(owner);
});

test('linked private control directories are rejected without touching their target', async t => {
  const config = await sandbox(t); await initialize(config);
  const outside = join(config.root, 'sentinel'); await mkdir(outside);
  await rm(join(config.state, 'logs'), { recursive: true });
  await symlink(outside, join(config.state, 'logs'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(loadOwner(config), /linked/);
  assert((await stat(outside)).isDirectory());
});

test('private writers do not follow a linked output file', { skip: process.platform === 'win32' }, async t => {
  const config = await sandbox(t), outside = join(config.root, 'sentinel');
  await privateWrite(outside, 'unchanged'); await initialize(config);
  const file = join(config.state, 'compose.json'); await symlink(outside, file);
  await assert.rejects(privateWrite(file, 'replacement'), /linked/);
  assert.equal(await readFile(outside, 'utf8'), 'unchanged');
});
test('generated Docker services keep pins, loopback ports, generated ownership labels and no extra services', async t => {
  const config = await sandbox(t), owner = await initialize(config), secret = await secrets(config), doc = composeDocument(owner, pins, secret.password);
  assert.deepEqual(Object.keys(doc.services), ['postgres', 'temporal']);
  for (const service of Object.values(doc.services)) { assert.equal(service.labels[ownerLabel], owner.nonce); assert.match(service.image, /@sha256:/); for (const port of service.ports) assert.match(port, /^127\.0\.0\.1:/); }
  assert.equal(doc.volumes.postgres.labels[ownerLabel], owner.nonce); assert.equal(doc.networks.default.labels[ownerLabel], owner.nonce);
  assert.equal(doc.services.temporal.environment.POSTGRES_PWD, secret.password);
  const probe = doc.services.temporal.healthcheck.test[1];
  assert.match(probe, /cluster health --address temporal:7233/);
  assert.match(probe, /namespace describe --namespace spaceapp-dev --address temporal:7233/);
  assert(!probe.includes('127.0.0.1:7233'));
});
test('service environment isolates all writable state and never forwards provider credentials', async t => {
  const config = await sandbox(t), owner = await initialize(config), secret = await secrets(config);
  const env = serviceEnvironment(config, owner, secret, { PATH: '/node/bin:/usr/bin', HOME: '/owner/private', OPENAI_API_KEY: 'synthetic-should-not-propagate', SPACE_DEV_LOGIN: 'true', SPACE_INSTANCE_ENABLED_JOBS: 'plugin-skill-links', SPACE_LIBREOFFICE_PATH: '/owner/private/normalizer', SSH_AUTH_SOCK: '/owner/agent' });
  assert.equal(env.OPENAI_API_KEY, undefined); assert.equal(env.SSH_AUTH_SOCK, undefined); assert.equal(env.SPACE_DEV_LOGIN, 'false');
  assert.equal(env.HOME, join(config.state, 'home')); assert.equal(env.SPACE_API_ORIGIN, 'http://127.0.0.1:4810'); assert.equal(env.SPACEAPP_WORKFLOWS_ENABLED, 'true');
  assert.equal(env.SPACE_PERSONAL_GIT_ROOT, join(config.state, 'install/var/personal-source-control'));
  assert.equal(env.SPACE_AGENT_FILE_DOCX_WORK_ROOT, join(config.state, 'install/var/agent-docx-work'));
  assert.equal(env.SPACE_INSTANCE_ENABLED_JOBS, undefined); assert.equal(env.SPACE_LIBREOFFICE_PATH, undefined);
  assert.equal(env.SPACE_ENABLE_CLI_CHAT_TURNS, 'false'); assert.equal(env.SPACE_CLI_OPENCODE_CREDENTIAL_SMOKE, 'false');
  assert(Object.values(env).every(x => !x.includes('/owner/private') && !x.includes('/opt/spaceapp')));
});
test('Docker context forwarding is limited to control-plane connectivity', () => {
  assert.deepEqual(dockerEnvironment({ PATH: '/bin', DOCKER_CONTEXT: 'colima', OPENAI_API_KEY: 'synthetic', SPACE_SESSION_SECRET: 'synthetic' }), { PATH: '/bin', DOCKER_CONTEXT: 'colima' });
});
test('owned failure diagnostics redact split secrets and select health data without container environments', async t => {
  const config = await sandbox(t), owner = await initialize(config), calls = [];
  let output = '';
  const invoke = async (_command, args, options) => {
    calls.push(args);
    if (args[1] === 'ls') return args[0] === 'container' ? 'owned-container' : '';
    if (args.includes('{{json .Config.Labels}}')) return JSON.stringify({ [ownerLabel]: owner.nonce });
    if (args.includes('logs')) { options.output('synthetic-pass'); options.output('word\n'); return ''; }
    if (args.includes('{{json .State.Health}}')) { options.output('{"Status":"unhealthy","Output":"synthetic-password"}\n'); return ''; }
    throw new Error('Unexpected diagnostic command');
  };
  await diagnoseOwnedDocker(config, owner, { invoke, env: { PATH: '/synthetic' }, secrets: ['synthetic-password'], output: text => { output += text; } });
  assert(!output.includes('synthetic-password')); assert.match(output, /\[redacted\]/);
  assert(calls.some(args => args.includes('--tail') && args.includes('100')));
  assert(calls.some(args => args.includes('{{json .State.Health}}')));
  assert(!calls.some(args => args.includes('{{json .Config.Env}}') || (args.includes('inspect') && !args.includes('--format'))));
});
test('diagnostics run before owned down and a diagnostic failure cannot prevent cleanup', async t => {
  const config = await sandbox(t), owner = await initialize(config), calls = [];
  let down = false, output = '';
  const invoke = async (_command, args) => {
    calls.push(args);
    if (args[1] === 'ls') return args[0] === 'container' && !down ? 'owned-container' : '';
    if (args.includes('{{json .Config.Labels}}')) return JSON.stringify({ [ownerLabel]: owner.nonce });
    if (args.includes('logs')) throw new Error('Synthetic diagnostic failure must not escape into logs');
    if (args.includes('down')) { down = true; return ''; }
    throw new Error('Unexpected cleanup command');
  };
  await removeOwnedDocker(config, owner, { diagnose: true, invoke, env: {}, output: text => { output += text; } });
  assert(down); assert(calls.findIndex(args => args.includes('logs')) < calls.findIndex(args => args.includes('down')));
  assert.match(output, /diagnostics unavailable/); assert(!output.includes('Synthetic diagnostic failure'));
});
test('a foreign project resource prevents both diagnostic reads and cleanup', async t => {
  const config = await sandbox(t), owner = await initialize(config), calls = [];
  const invoke = async (_command, args) => { calls.push(args); return args[1] === 'ls' ? 'foreign' : JSON.stringify({ [ownerLabel]: 'not-ours' }); };
  await assert.rejects(removeOwnedDocker(config, owner, { diagnose: true, invoke, env: {} }), /Foreign/);
  assert(!calls.some(args => args.includes('logs') || args.includes('down') || args.includes('{{json .State.Health}}')));
});
test('redactor handles secrets split between stdout chunks', () => {
  let output = ''; const stream = lineRedactor(['synthetic-password', 'synthetic-token'], x => { output += x; });
  stream.chunk(Buffer.from('before synthetic-pass')); stream.chunk(Buffer.from('word\nsynthetic-to')); stream.chunk(Buffer.from('ken after')); stream.end();
  assert.equal(output, 'before [redacted]\n[redacted] after');
});
test('PID reuse never signals a process whose identity changed', async () => {
  const signals = []; assert.equal(await sameProcess({ pid: 12345, identity: 'old' }, async () => 'new'), false);
  await stopRecorded([{ pid: 12345, identity: 'old' }], { identity: async () => 'new', signal: (...args) => signals.push(args), timeout: 0 });
  assert.deepEqual(signals, []);
});

test('descendant discovery refuses a root reused during the ps snapshot', async () => {
  let current = 'original';
  await assert.rejects(descendants({ pid: 12345, identity: 'original' }, { identity: async () => current, list: async () => { current = 'replacement'; return { stdout: '12345 1\n12346 12345\n' }; } }), /replacement tree/);
});

test('shutdown drains a real spawned child paused before identity registration', { skip: process.platform === 'win32' }, async t => {
  const barrier = new LaunchBarrier(), children = [];
  let release, announce, child;
  const gate = new Promise(done => { release = done; }), spawned = new Promise(done => { announce = done; });
  t.after(async () => { release(); if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  const launch = barrier.track(async () => {
    child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
    await new Promise((done, reject) => { child.once('spawn', done); child.once('error', reject); });
    announce(); await gate;
    children.push({ pid: child.pid, identity: await processIdentity(child.pid) });
  });
  await spawned;
  const shutdown = (async () => { await barrier.stop(); await stopRecorded(children); })();
  await assert.rejects(barrier.track(() => { throw new Error('must not be admitted'); }), /shutdown/);
  release(); await launch; await shutdown;
  assert.equal(await processIdentity(child.pid), null, 'A child spawned across shutdown must not be orphaned.');
});
test('only a matching owned process receives termination', async () => {
  let alive = true; const signals = [];
  await stopRecorded([{ pid: 12345, identity: 'ours' }], { identity: async () => alive ? 'ours' : null, signal: (pid, action) => { signals.push([pid, action]); alive = false; }, timeout: 1 });
  assert.deepEqual(signals, [[12345, 'SIGTERM']]);
});
test('Docker cleanup refuses a foreign resource sharing the compose project', async () => {
  const owner = { nonce: 'a'.repeat(32), project: 'our-project' };
  const invoke = async (_command, args) => args[1] === 'ls' ? 'foreign-id\n' : JSON.stringify({ [ownerLabel]: 'foreign-owner' });
  await assert.rejects(assertOwnedDocker(owner, invoke), /Foreign container/);
});
test('Docker ownership failure propagates instead of claiming successful cleanup', async () => {
  await assert.rejects(assertOwnedDocker({ project: 'ours' }, async () => { throw new Error('daemon unavailable'); }), /daemon unavailable/);
});
test('compose invocation always names the exact owned project/file', () => {
  assert.deepEqual(composeArgs({ compose: '/private/compose.json' }, { project: 'ours' }, ['down', '--volumes']), ['compose', '--project-name', 'ours', '--file', '/private/compose.json', 'down', '--volumes']);
});
test('command output is redacted and a failed subprocess remains failure', async () => {
  const env = { ...process.env };
  const output = await run(process.execPath, ['-e', 'console.log("synthetic-secret")'], { env, secrets: ['synthetic-secret'] });
  assert.equal(output.trim(), '[redacted]');
  await assert.rejects(run(process.execPath, ['-e', 'process.exit(7)'], { env }), /failed \(7\)/);
});

test('a command timeout cannot be converted into success by its signal handler', async () => {
  await assert.rejects(run(process.execPath, ['-e', 'process.on("SIGTERM",()=>process.exit(0));setInterval(()=>{},1000)'], { env: { ...process.env }, timeout: 150 }), /timeout/);
});

test('a missing executable rejects promptly instead of leaving an identity wait', async () => {
  await assert.rejects(run('spaceapp-deliberately-missing-executable', [], { env: { ...process.env }, timeout: 200 }), /could not start/);
});
