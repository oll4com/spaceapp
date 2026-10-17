import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, copyFile, readFile, mkdir, mkdtemp, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { composeDocument, extractPins, initialize, loadOwner, locations, ownerLabel, privateWrite, secrets, serviceEnvironment } from '../dev-stack/state.mjs';
import { descendants, LaunchBarrier, lineRedactor, processIdentity, sameProcess, stopRecorded } from '../dev-stack/processes.mjs';
import { assertLoopbackPublications, assertOwnedDocker, composeArgs, diagnoseOwnedDocker, dockerEnvironment, readOwnedPortPublications, removeOwnedDocker, run } from '../dev-stack/resources.mjs';
import { confinedFile, nativePackage, opencodeEnvironment, resolveOpenCode, verifyOpenCode } from '../dev-stack/opencode-runtime.mjs';
import { InteractiveTerminalProof, assertBrowserTerminal } from '../dev-stack/terminal-proof.mjs';
import { knownHelperRepair } from '../dev-stack/pty-capability.mjs';
import { isPublicExportPath } from '../public-export.mjs';
import { assertBrowserRunning, eventually, proofBrowserArguments, safeBrowserStderr, selectedBrowserDiagnostic, syntheticCookieCapability, typeTerminalFilter } from '../dev-stack/browser-proof.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
test('only Darwin CI proof browsers request a mock keychain and every other browser argument stays unchanged', () => {
  const profile = '/private/.dev-stack-proof/browser-proof';
  const original = ['--headless=new', '--disable-dev-shm-usage', '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'];
  for (const platform of ['linux', 'win32', 'darwin']) for (const ci of ['false', '', 'TRUE', '1', true, null]) assert.deepEqual(proofBrowserArguments(profile, { platform, ci }), original);
  for (const platform of ['linux', 'win32']) assert.deepEqual(proofBrowserArguments(profile, { platform, ci: 'true' }), original);
  const permitted = proofBrowserArguments(profile, { platform: 'darwin', ci: 'true' });
  assert.equal(permitted.filter(arg => arg === '--use-mock-keychain').length, 1);
  assert.deepEqual(permitted.filter(arg => arg !== '--use-mock-keychain'), original);
  assert.equal(permitted.some(arg => arg.includes('password-store')), false);
});
function syntheticCookieFixture({ mutate = cookie => cookie, retainAfterDelete = false } = {}) {
  let cookie; const calls = [];
  const call = async (method, params) => {
    calls.push({ method, params });
    if (method === 'Network.enable') return {};
    if (method === 'Network.setCookie') { cookie = mutate({ ...params, domain: '127.0.0.1' }); return { success: true }; }
    if (method === 'Network.getCookies') return { cookies: cookie ? [cookie] : [] };
    if (method === 'Network.deleteCookies') { if (!retainAfterDelete) cookie = null; return {}; }
    throw new Error('Unexpected synthetic cookie command');
  };
  return { call, calls };
}
test('early cookie capability sets and reads exact synthetic HttpOnly Lax attributes then verifies deletion', async () => {
  const fixture = syntheticCookieFixture(), value = 'spaceproof0123456789abcdef';
  const proof = await syntheticCookieCapability(fixture.call, value);
  assert.deepEqual(fixture.calls.map(x => x.method), ['Network.enable', 'Network.setCookie', 'Network.getCookies', 'Network.deleteCookies', 'Network.getCookies']);
  assert.deepEqual(fixture.calls[1].params, { url: 'http://127.0.0.1/', name: 'spaceapp-dev-proof', value, httpOnly: true, sameSite: 'Lax' });
  assert.equal(proof.exactSetGetMatch, true); assert.equal(proof.deletionReadback, true); assert.equal(proof.navigationOrFetchSent, false); assert.equal(proof.valueRecorded, false);
});
test('wrong stored cookie value or attributes fail while the synthetic cookie is still deleted', async () => {
  for (const override of [{ value: 'wrong' }, { httpOnly: false }, { sameSite: 'None' }, { domain: 'other.invalid' }]) {
    const fixture = syntheticCookieFixture({ mutate: cookie => ({ ...cookie, ...override }) });
    await assert.rejects(syntheticCookieCapability(fixture.call, 'spaceproof0123456789abcdef'), /value and native attributes/);
    assert.equal(fixture.calls.filter(x => x.method === 'Network.deleteCookies').length, 1);
    assert.equal(fixture.calls.at(-1).method, 'Network.getCookies');
  }
});
test('cookie deletion requires an empty readback and never converts a retained cookie into success', async () => {
  const fixture = syntheticCookieFixture({ retainAfterDelete: true });
  await assert.rejects(syntheticCookieCapability(fixture.call, 'spaceproof0123456789abcdef'), /deletion must be read back/);
  assert.equal(fixture.calls.filter(x => x.method === 'Network.setCookie').length, 1);
});
test('cookie cleanup retains the original timeout and pre-cleanup failure snapshot without a retry or parameters', async () => {
  const original = new Error('CDP Network.setCookie timed out.'), calls = [];
  const call = async method => { calls.push(method); if (method === 'Network.enable') return {}; if (method === 'Network.setCookie') throw original; throw new TypeError('synthetic cleanup failed'); };
  await assert.rejects(syntheticCookieCapability(call, 'spaceproof0123456789abcdef', phase => ({ phase, failedCdpMethod: 'Network.setCookie' })), error => error === original);
  assert.deepEqual(calls, ['Network.enable', 'Network.setCookie', 'Network.deleteCookies']);
  assert.deepEqual(original.browserRuntime, { phase: 'synthetic-cookie-set', failedCdpMethod: 'Network.setCookie' });
  assert.deepEqual(original.cookieCleanupError, { name: 'TypeError', phase: 'delete' });
});
test('post-CDP diagnostics retain selected failure state and redact endpoints without exposing request parameters', () => {
  const selected = selectedBrowserDiagnostic({ profile: '/private/profile', tmpdir: '/private/tmp', binaryVersion: 'Synthetic Chrome', versionError: null, child: { exitCode: null, signalCode: 'SIGTRAP', env: { secret: 'must-not-appear' } }, startError: null, stderr: 'cookie=private-cookie ws://127.0.0.1/private-session', socket: { readyState: 3, url: 'must-not-appear' }, failedCdpMethod: 'Network.setCookie', params: { value: 'must-not-appear' } }, 'application-browser');
  assert.equal(selected.failedCdpMethod, 'Network.setCookie'); assert.equal(selected.phase, 'application-browser'); assert.equal(selected.cdpSocketState, 3); assert.equal(selected.signalCode, 'SIGTRAP');
  assert(!JSON.stringify(selected).includes('must-not-appear')); assert(!selected.stderr.includes('private-cookie')); assert(!selected.stderr.includes('private-session'));
});
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

// Synthetic schema fixture derived from Compose v2.38.2 ps.go; not a captured live response.
const publishedPorts = { postgres: 54329, temporal: 47233 };
function portFixture() {
  return [
    { Service: 'postgres', Publishers: [{ URL: '127.0.0.1', TargetPort: 5432, PublishedPort: 54329, Protocol: 'tcp' }], NetworkSettingsPorts: { '5432/tcp': [{ HostIp: '127.0.0.1', HostPort: '54329' }] } },
    { Service: 'temporal', Publishers: [{ URL: '', TargetPort: 7234, PublishedPort: 0, Protocol: 'tcp' }, { URL: '127.0.0.1', TargetPort: 7233, PublishedPort: 47233, Protocol: 'tcp' }], NetworkSettingsPorts: { '7234/tcp': null, '7233/tcp': [{ HostIp: '127.0.0.1', HostPort: '47233' }] } }
  ];
}
test('port proof distinguishes exposed container ports from exact loopback host publications', () => {
  const services = portFixture();
  // Preserve the observed old empty-URL assertion failure against the documented synthetic schema.
  assert.throws(() => { for (const service of services) for (const binding of service.Publishers) assert.equal(binding.URL, '127.0.0.1'); });
  assert.doesNotThrow(() => assertLoopbackPublications(services, publishedPorts));
});
test('positive published ports with empty, wildcard or IPv6 host addresses always fail', () => {
  for (const host of ['', '0.0.0.0', '::', '::1', '[::]', 'localhost']) {
    const services = portFixture(); services[0].Publishers[0].URL = host;
    assert.throws(() => assertLoopbackPublications(services, publishedPorts), /host address/);
  }
  const contradictory = portFixture(); contradictory[1].Publishers[0].URL = '0.0.0.0';
  assert.throws(() => assertLoopbackPublications(contradictory, publishedPorts), /unpublished/);
});
test('missing, extra, mismatched, duplicated or malformed Compose publications fail', () => {
  for (const mutate of [
    services => { services[0].Publishers = []; },
    services => { services[0].Publishers.push({ URL: '127.0.0.1', TargetPort: 5432, PublishedPort: 54330, Protocol: 'tcp' }); },
    services => { services[0].Publishers[0].TargetPort = 5433; },
    services => { services[0].Publishers[0].Protocol = 'udp'; },
    services => { services[0].Publishers.push({ ...services[0].Publishers[0] }); },
    services => { services[1].Publishers[0].PublishedPort = '0'; },
    services => { services[1].Service = 'postgres'; },
    services => { services.pop(); }
  ]) { const services = portFixture(); mutate(services); assert.throws(() => assertLoopbackPublications(services, publishedPorts)); }
});
test('selected engine inspection independently rejects missing, wildcard, extra or mismatched bindings', () => {
  for (const mutate of [
    services => { services[0].NetworkSettingsPorts['5432/tcp'] = null; },
    services => { services[0].NetworkSettingsPorts['5432/tcp'][0].HostIp = ''; },
    services => { services[0].NetworkSettingsPorts['5432/tcp'][0].HostIp = '0.0.0.0'; },
    services => { services[0].NetworkSettingsPorts['5432/tcp'][0].HostIp = '::'; },
    services => { services[0].NetworkSettingsPorts['5432/tcp'][0].HostPort = '54330'; },
    services => { services[0].NetworkSettingsPorts['5433/tcp'] = [{ HostIp: '127.0.0.1', HostPort: '54329' }]; },
    services => { services[1].NetworkSettingsPorts['7234/tcp'] = [{ HostIp: '127.0.0.1', HostPort: '47234' }]; },
    services => { services[0].NetworkSettingsPorts['5432/tcp'].push({ HostIp: '127.0.0.1', HostPort: '54329' }); }
  ]) { const services = portFixture(); mutate(services); assert.throws(() => assertLoopbackPublications(services, publishedPorts)); }
});
test('port evidence reads only owned selected metadata and never returns Compose commands or environment', async () => {
  const owner = { nonce: 'owned', project: 'owned-project' }, fixture = portFixture(), calls = [];
  const ids = ['a'.repeat(64), 'b'.repeat(64)];
  const invoke = async (command, args) => {
    calls.push([command, ...args]);
    if (args.includes('ls')) return args[0] === 'container' ? ids.join('\n') : '';
    if (args.includes('{{json .Config.Labels}}')) return JSON.stringify({ [ownerLabel]: owner.nonce });
    if (args[0] === 'compose') return fixture.map((service, i) => JSON.stringify({ ...service, ID: ids[i], Command: 'must-not-be-retained', Env: ['must-not-be-retained'] })).join('\n');
    if (args.includes('{{json .NetworkSettings.Ports}}')) return JSON.stringify(fixture[ids.indexOf(args.at(-1))].NetworkSettingsPorts);
    throw new Error('Unexpected port proof command');
  };
  const selected = await readOwnedPortPublications({ compose: 'private-compose.json' }, owner, { invoke, env: {} });
  assert.deepEqual(selected, fixture); assert.doesNotThrow(() => assertLoopbackPublications(selected, publishedPorts));
  assert.equal(JSON.stringify(selected).includes('must-not-be-retained'), false);
  assert.equal(calls.some(call => call.includes('{{json .Config.Env}}')), false);
  assert.equal(calls.filter(call => call.includes('{{json .NetworkSettings.Ports}}')).length, 2);
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
    if (args.some(arg => arg.includes('"oomKilled":'))) { options.output('{"status":"running","oomKilled":false,"error":"synthetic-password"}\n'); return ''; }
    if (args[0] === '-ltn' || args[0] === '-nP') return `LISTEN 127.0.0.1:${owner.ports.temporal}\nLISTEN 0.0.0.0:11111 unrelated-must-not-be-retained`;
    throw new Error('Unexpected diagnostic command');
  };
  await diagnoseOwnedDocker(config, owner, { invoke, env: { PATH: '/synthetic' }, secrets: ['synthetic-password'], output: text => { output += text; } });
  assert(!output.includes('synthetic-password')); assert.match(output, /\[redacted\]/);
  assert(calls.some(args => args.includes('--tail') && args.includes('100')));
  assert(calls.some(args => args.includes('{{json .State.Health}}')));
  assert(calls.some(args => args.some(arg => arg.includes('"oomKilled":'))));
  assert(output.includes(`127.0.0.1:${owner.ports.temporal}`)); assert(!output.includes('unrelated-must-not-be-retained'));
  assert(!calls.some(args => args.includes('{{json .Config.Env}}') || (args.includes('inspect') && !args.includes('--format'))));
});
test('diagnostics run before owned down and a diagnostic failure cannot prevent cleanup', async t => {
  const config = await sandbox(t), owner = await initialize(config), calls = [];
  let down = false, output = '';
  const invoke = async (_command, args, options) => {
    calls.push(args);
    if (args[1] === 'ls') return args[0] === 'container' && !down ? 'owned-container' : '';
    if (args.includes('{{json .Config.Labels}}')) return JSON.stringify({ [ownerLabel]: owner.nonce });
    if (args.includes('logs')) throw new Error('Synthetic diagnostic failure must not escape into logs');
    if (args.includes('{{json .State.Health}}') || args.some(arg => arg.includes('"oomKilled":'))) { options.output('{}\n'); return ''; }
    if (args[0] === '-ltn' || args[0] === '-nP') return '';
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
const bootA = '11111111-1111-4111-8111-111111111111', bootB = '22222222-2222-4222-8222-222222222222';
function virtualLinux(boot, ticks = '42') {
  const stat = `12345 (synthetic process) ${['S', ...Array(18).fill('0'), ticks].join(' ')}`;
  return path => path === '/proc/sys/kernel/random/boot_id' ? Promise.resolve(boot + '\n')
    : path === '/proc/12345/stat' ? Promise.resolve(stat) : Promise.reject(new Error('Unexpected virtual proc read'));
}
test('Linux identities distinguish same-PID start ticks and kernel boots using virtual proc reads', async () => {
  const identify = (boot, ticks) => processIdentity(12345, { platform: 'linux', read: virtualLinux(boot, ticks) });
  assert.equal(await identify(bootA, '42'), `linux:${bootA}:42`);
  assert.notEqual(await identify(bootA, '43'), await identify(bootA, '42'));
  assert.notEqual(await identify(bootB, '42'), await identify(bootA, '42'));
});
test('only a same-boot same-tick virtual process is signalled; reuse and reboot cannot be adopted', async () => {
  const record = { pid: 12345, identity: `linux:${bootA}:42` }, signals = [];
  for (const read of [virtualLinux(bootA, '43'), virtualLinux(bootB, '42')]) {
    const identity = pid => processIdentity(pid, { platform: 'linux', read });
    assert.equal(await sameProcess(record, identity), false);
    await stopRecorded([record], { identity, signal: (...args) => signals.push(args), timeout: 0 });
  }
  assert.deepEqual(signals, []);
  let live = true;
  const identity = pid => live ? processIdentity(pid, { platform: 'linux', read: virtualLinux(bootA) }) : null;
  assert.equal(await sameProcess(record, identity), true);
  await stopRecorded([record], { identity, signal: (...args) => { signals.push(args); live = false; }, timeout: 0 });
  assert.deepEqual(signals, [[12345, 'SIGTERM']]);
});
test('unavailable or malformed kernel identity and legacy Linux records fail closed without signals', async () => {
  for (const boot of ['', 'not-a-boot-id']) await assert.rejects(processIdentity(12345, { platform: 'linux', read: virtualLinux(boot) }), /boot identity/);
  await assert.rejects(processIdentity(12345, { platform: 'linux', read: async () => { throw Object.assign(new Error('Synthetic missing boot identity'), { code: 'ENOENT' }); } }), /missing boot identity/);
  await assert.rejects(processIdentity(12345, { platform: 'linux', read: virtualLinux(bootA, 'invalid') }), /process identity/);
  const signals = [];
  await assert.rejects(stopRecorded([{ pid: 12345, identity: 'linux:42' }], { identity: async () => 'linux:42', signal: (...args) => signals.push(args), timeout: 0 }), /Legacy or invalid Linux process record/);
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

async function nativeFixture(t, platform = 'linux', arch = 'x64') {
  const config = await sandbox(t); await initialize(config);
  const name = nativePackage(platform, arch), modules = join(config.state, 'cli/vendor/opencode/node_modules');
  const core = join(modules, 'opencode-ai/package.json'), selected = join(modules, name, 'package.json'), executable = join(modules, name, 'bin/opencode');
  await mkdir(join(modules, 'opencode-ai'), { recursive: true }); await mkdir(join(modules, name, 'bin'), { recursive: true });
  await writeFile(core, JSON.stringify({ name: 'opencode-ai', version: pins.opencode, optionalDependencies: { [name]: pins.opencode } }));
  await writeFile(selected, JSON.stringify({ name, version: pins.opencode }));
  await writeFile(executable, `#!/bin/sh\nif [ "$1" = '--version' ]; then printf '%s\\n' '${pins.opencode}'; else printf '%s\\n' "$PWD" "$HOME"; fi\n`); await chmod(executable, 0o700);
  return { config, core, selected, executable, name };
}
test('native OpenCode resolves the exact confined optional binary rather than the postinstall placeholder', async t => {
  const fixture = await nativeFixture(t);
  const native = await resolveOpenCode(fixture.config.state, pins.opencode, { platform: 'linux', arch: 'x64' });
  assert.equal(native.executable, fixture.executable); assert.equal(native.package, fixture.name); assert.match(native.sha256, /^[a-f0-9]{64}$/);
  assert.equal(nativePackage('darwin', 'x64'), 'opencode-darwin-x64-baseline');
  assert.throws(() => nativePackage('win32', 'x64'), /Unsupported/);
  assert.throws(() => nativePackage('linux', 'unknown'), /Unsupported/);
});
test('the public source export retains every new runtime and capability proof module', () => {
  for (const name of ['opencode-runtime.mjs', 'pty-capability.mjs', 'capability-proof.mjs', 'terminal-proof.mjs']) assert.equal(isPublicExportPath(`scripts/dev-stack/${name}`), true, name);
});
test('native version verification executes the selected file directly with only a private provider environment', async t => {
  const { config, executable } = await nativeFixture(t); let calls = 0;
  const invoke = async (file, args, options) => {
    calls++; assert.equal(file, executable); assert.deepEqual(args, ['--version']); assert.equal(options.timeout, 15000);
    assert.equal(options.env.OPENAI_API_KEY, undefined); assert.equal(options.env.SSH_AUTH_SOCK, undefined);
    assert.equal(options.env.HOME, join(config.state, 'providers/opencode')); assert.equal(options.cwd, options.env.HOME);
    return pins.opencode + '\n';
  };
  await verifyOpenCode(config.state, pins.opencode, { platform: 'linux', arch: 'x64', invoke, inherited: { PATH: '/reviewed', OPENAI_API_KEY: 'must-not-inherit', SSH_AUTH_SOCK: 'must-not-inherit' } });
  assert.equal(calls, 1);
  let failure;
  await assert.rejects(verifyOpenCode(config.state, pins.opencode, { platform: 'linux', arch: 'x64', invoke: async () => '0.0.0', observe: async value => { failure = value; } }), /Actual private.*version/);
  assert.equal(failure.ok, false); assert.equal(failure.stage, 'actual-native-version'); assert.equal(failure.actualVersion, '0.0.0'); assert.equal(failure.error.code, 'VERSION_MISMATCH'); assert.equal(failure.native.relativeExecutable.includes('node_modules'), true);
  assert.equal(opencodeEnvironment(config.state, { ANTHROPIC_API_KEY: 'secret' }).ANTHROPIC_API_KEY, undefined);
});
test('wrong core/native version, missing optional dependency and linked package paths fail closed', async t => {
  const fixture = await nativeFixture(t);
  const original = JSON.parse(await readFile(fixture.core, 'utf8'));
  for (const core of [{ ...original, version: '0.0.0' }, { ...original, optionalDependencies: {} }]) {
    await writeFile(fixture.core, JSON.stringify(core)); await assert.rejects(resolveOpenCode(fixture.config.state, pins.opencode, { platform: 'linux', arch: 'x64' }), /mismatch/);
  }
  await writeFile(fixture.core, JSON.stringify(original));
  await writeFile(fixture.selected, JSON.stringify({ name: fixture.name, version: '0.0.0' }));
  await assert.rejects(resolveOpenCode(fixture.config.state, pins.opencode, { platform: 'linux', arch: 'x64' }), /mismatch/);
  const external = join(fixture.config.root, 'foreign'); await mkdir(external);
  const link = join(fixture.config.state, 'linked'); await symlink(external, link, process.platform === 'win32' ? 'junction' : 'dir');
  await writeFile(join(external, 'binary'), 'foreign sentinel');
  await assert.rejects(confinedFile(fixture.config.state, join(link, 'binary')), /linked/);
  await assert.rejects(confinedFile(fixture.config.state, join(external, 'binary')), /physical private root/);
  assert.equal(await readFile(join(external, 'binary'), 'utf8'), 'foreign sentinel');
});
test('actual private wrapper preserves the requested pane cwd while keeping provider HOME private', { skip: process.platform === 'win32' }, async t => {
  const { config } = await nativeFixture(t, process.platform, process.arch);
  const bin = join(config.state, 'cli/bin');
  for (const name of ['opencode-wrapper.mjs', 'opencode-runtime.mjs']) await copyFile(join(root, 'scripts/dev-stack', name), join(bin, name));
  await writeFile(join(config.state, 'cli/opencode-version'), pins.opencode);
  const output = await run(process.execPath, [join(bin, 'opencode-wrapper.mjs')], { cwd: join(config.state, 'workspaces'), env: { PATH: process.env.PATH }, timeout: 15000 });
  assert.deepEqual(output.trim().split('\n'), [join(config.state, 'workspaces'), join(config.state, 'providers/opencode')]);
});
const liveSession = () => ({ session: { sessionId: 'tested', runtimeId: 'cli:opencode', status: 'RUNNING', isActive: true, exitCode: null } });
function liveProof() { const proof = new InteractiveTerminalProof('tested'); proof.open(); proof.message({ type: 'status', status: 'RUNNING' }); assert.equal(proof.live(liveSession()), true); return proof; }
test('the historical module-error/brand substring false positive is explicitly rejected', () => {
  const output = "Error: Cannot find module '/private/opencode-ai/bin/opencode'\nMODULE_NOT_FOUND\nCLI process exited (code 1)";
  assert.equal(/opencode/i.test(output), true, 'The old assertion accepts this actual error family.');
  const proof = liveProof(); proof.message({ type: 'output', data: output });
  assert.throws(() => proof.live(liveSession()), /bootstrap\/exit failure/);
  const split = liveProof(); split.message({ type: 'output', data: 'MODULE_NOT_' }); split.message({ type: 'output', data: 'FOUND opencode' }); assert.throws(() => split.live(liveSession()), /bootstrap\/exit failure/);
});
test('RUNNING cannot survive a terminal error, exit, WebSocket error or close', () => {
  for (const end of [p => p.message({ type: 'status', status: 'ERROR' }), p => p.message({ type: 'status', status: 'EXITED' }), p => p.message({ type: 'status', status: 'RUNNING', exitCode: 0 }), p => p.message({ type: 'error', code: 'CLI_TERMINAL_SETUP_FAILED' }), p => p.error('ECONNRESET'), p => p.close(1008)]) {
    const proof = liveProof(); end(proof); proof.message({ type: 'status', status: 'RUNNING' }); assert.throws(() => proof.live(liveSession()));
  }
  const proof = liveProof(); proof.message({ type: 'status', status: 'IDLE' }); assert.equal(proof.live(liveSession()), false);
});
test('each interactive result needs a fresh matching active RUNNING API session', () => {
  for (const response of [null, { session: { ...liveSession().session, sessionId: 'another' } }, { session: { ...liveSession().session, runtimeId: 'cli:other' } }, { session: { ...liveSession().session, isActive: false } }, { session: { ...liveSession().session, status: 'EXITED' } }, { session: { ...liveSession().session, exitCode: 0 } }]) assert.throws(() => liveProof().live(response), /Fresh API/);
  assert.equal(liveProof().live({ session: { ...liveSession().session, status: 'IDLE' } }), false);
});
test('menu and unique filter evidence must arrive after the corresponding input barrier', () => {
  const proof = liveProof(), menu = 'Commands\nSwitch model\nSwitch agent\nExit the app';
  proof.message({ type: 'output', data: menu }); let barrier = proof.barrier(); assert.equal(proof.menu(barrier), false);
  proof.message({ type: 'output', data: 'opencode' }); assert.equal(proof.menu(barrier), false);
  proof.message({ type: 'output', data: menu }); assert.equal(proof.menu(barrier), true);
  proof.message({ type: 'output', data: 'spaceproof-unique' }); barrier = proof.barrier(); assert.equal(proof.challenge(barrier, 'spaceproof-unique'), false);
  proof.message({ type: 'output', data: 'Search: spaceproof-unique' }); assert.equal(proof.challenge(barrier, 'spaceproof-unique'), false);
  proof.message({ type: 'output', data: 'No results found' }); assert.equal(proof.challenge(barrier, 'spaceproof-unique'), true);
});
test('browser proof rejects unrelated, disconnected, empty or erroneous terminal panes', () => {
  const state = { paneId: 'tested', status: 'attached', hasSession: 'true', hasWebsocket: 'true', hasError: 'false', width: 1200 };
  assert.doesNotThrow(() => assertBrowserTerminal(state, 'tested'));
  for (const change of [{ paneId: 'unrelated' }, { status: 'closed' }, { hasSession: 'false' }, { hasWebsocket: 'false' }, { hasError: 'true' }, { width: 0 }]) assert.throws(() => assertBrowserTerminal({ ...state, ...change }, 'tested'));
});
test('interactive fatal latch ends only after verified success, allowing later intentional HMR/cleanup', () => {
  const proof = liveProof(); proof.seal(liveSession()); proof.close(1000); assert.equal(proof.diagnostic().websocket.fatal, null);
  const failed = liveProof(); failed.close(1000); assert.throws(() => failed.seal(liveSession()));
});
test('synthetic terminal diagnostics are bounded, selected and redact supplied/query secrets', () => {
  const proof = liveProof(); proof.message({ type: 'output', data: 'x'.repeat(8000) + '\nprivate-cookie http://local/?token=private-ticket\n' });
  const value = proof.diagnostic(['private-cookie', 'private-ticket']); assert(value.syntheticTerminalExcerpt.length <= 6000);
  assert.equal(JSON.stringify(value).includes('private-cookie'), false); assert.equal(JSON.stringify(value).includes('private-ticket'), false);
  assert.deepEqual(Object.keys(value.currentSession), ['sessionId', 'status', 'isActive', 'exitCode']);
});
test('known Darwin helper repair refuses any unpinned, linked, foreign, changed or already executable metadata', () => {
  const record = { platform: 'darwin', arch: 'x64', version: '1.1.0', sha256: '46a4455777c6122d7e71cd706ea4b37b19bedd297684be8b6dabb833ff2a3965', mode: 0o644, uid: 123, nlink: 1 };
  assert.equal(knownHelperRepair(record, 123), true);
  for (const change of [{ platform: 'linux' }, { arch: 'other' }, { version: '1.1.1' }, { sha256: 'changed' }, { mode: 0o755 }, { uid: 124 }, { nlink: 2 }]) assert.equal(knownHelperRepair({ ...record, ...change }, 123), false);
  assert.equal(knownHelperRepair(record, null), false);
});
test('CDP typing preserves the exact long filter through serial bounded character events and propagates failure', async () => {
  const challenge = 'spaceproof0123456789abcdef', events = [];
  let active = false;
  const call = async (method, params) => {
    assert.equal(active, false, 'Input events must be awaited in order.'); active = true;
    try {
      assert.equal(method, 'Input.dispatchKeyEvent'); assert.equal(params.type, 'char');
      if (params.text.length >= 4) throw new Error("Invalid 'text' parameter");
      await new Promise(done => setTimeout(done, 1)); events.push(params.text);
    } finally { active = false; }
  };
  await assert.rejects(call('Input.dispatchKeyEvent', { type: 'char', text: challenge }), /Invalid 'text'/);
  await typeTerminalFilter(call, challenge);
  assert.equal(events.join(''), challenge); assert.equal(events.length, challenge.length); assert(events.every(text => text.length === 1));
  for (const text of ['bad\rinput', 'bad\ninput', '\u0010', 'UPPERCASE', '']) await assert.rejects(typeTerminalFilter(call, text), /synthetic local palette filter/);
  let attempts = 0;
  await assert.rejects(typeTerminalFilter(async () => { if (++attempts === 3) throw new Error('Typed transport failure'); }, challenge), /Typed transport failure/);
  assert.equal(attempts, 3, 'A failed event must stop typing rather than mask/retry it.');
});
test('a short fresh capability state cannot adopt or delete an existing owned instance', async t => {
  const config = await sandbox(t), owner = await initialize(config, { fresh: true }), secret = await secrets(config);
  await assert.rejects(initialize(config, { fresh: true }), /refusing adoption/);
  assert.deepEqual(await secrets(config), secret); assert.equal((await loadOwner(config)).nonce, owner.nonce);
  assert.equal((await initialize(config)).nonce, owner.nonce, 'Default named dev-stack resume remains unchanged.');
});
test('a signalled Chrome fails immediately and bounded startup diagnostics redact control endpoints', async () => {
  let calls = 0;
  await assert.rejects(eventually(() => { calls++; assertBrowserRunning({ exitCode: null, signalCode: 'SIGTRAP' }); }, 'Virtual Chrome'), /SIGTRAP/);
  assert.equal(calls, 1, 'A dead child must not consume the full startup wait.');
  assert.doesNotThrow(() => assertBrowserRunning({ exitCode: null, signalCode: null }));
  const text = safeBrowserStderr('x'.repeat(8000) + ' DevTools listening on ws://127.0.0.1:1234/devtools/browser/private-endpoint token=private-token\n');
  assert(text.length <= 6000); assert(!text.includes('private-endpoint')); assert(!text.includes('private-token')); assert(!text.includes('ws://'));
});

const screenGeometry = { generationId: 'synthetic-host-generation', cols: 100, rows: 20 };
const screenSession = (geometry = screenGeometry) => ({ session: { ...liveSession().session, terminalGeometry: geometry } });
const menuFrame = '\x1b[2J\x1b[HCommands\r\nSearch: \r\nSwitch model\r\nConnect provider';
const closedFrame = '\x1b[2J\x1b[HAsk anything...\r\nctrl+p commands';
function screenProof() { const proof = liveProof(); proof.message({ type: 'status', status: 'RUNNING', replayContinuity: 'COMPLETE' }); return proof; }

test('complete ANSI screen projection proves fresh menu filter dismissal and reopen while the old contiguous predicate rejects redraw deltas', async () => {
  const proof = screenProof(), response = screenSession(), value = 'spaceproof0123456789abcdef';
  proof.message({ type: 'output', data: closedFrame });
  let transition = await proof.beginScreenTransition('open', response);
  assert.equal(await proof.screenTransition(transition, response), null, 'No output after the input barrier cannot pass.');
  proof.message({ type: 'output', data: menuFrame }); assert(await proof.screenTransition(transition, response));
  transition = await proof.beginScreenTransition('filter', response, value); const barrier = transition.sequence;
  // Synthetic ANSI cursor-addressing control, not a recovered historical frame.
  for (const data of ['\x1b[2;9Hspace', '\x1b[3;1H\x1b[JNo results found', '\x1b[2;1', '4Hproof0123', '\x1b[5;1Hunrelated redraw', '\x1b[2;23H456789abcdef']) proof.message({ type: 'output', data });
  assert.equal(proof.challenge(barrier, value), false, 'The historical stripped-text predicate cannot reconstruct these deltas.');
  const filtered = await proof.screenTransition(transition, response); assert(filtered?.text.includes(value)); assert(filtered.text.includes('No results found'));
  transition = await proof.beginScreenTransition('dismiss', response, value);
  proof.message({ type: 'output', data: closedFrame }); assert(await proof.screenTransition(transition, response));
  transition = await proof.beginScreenTransition('open', response);
  proof.message({ type: 'output', data: menuFrame }); assert(await proof.screenTransition(transition, response));
  await assert.rejects(proof.screenTransition(transition, response), /current pre-input transition/);
  proof.seal(response); assert.equal(proof.sealed, true);
});

test('a stale preexisting or wrong current challenge cannot satisfy the projected screen proof', async () => {
  const value = 'spaceproof0123456789abcdef', response = screenSession(), stale = screenProof();
  stale.message({ type: 'output', data: `${menuFrame}\r\n${value}` });
  assert.equal(await stale.beginScreenTransition('filter', response, value), null);
  stale.message({ type: 'output', data: '\x1b[8;1Hunrelated fresh output' });
  assert.equal(await stale.beginScreenTransition('filter', response, value), null);
  const wrong = screenProof(); wrong.message({ type: 'output', data: menuFrame });
  const transition = await wrong.beginScreenTransition('filter', response, value);
  wrong.message({ type: 'output', data: '\x1b[2J\x1b[HCommands\r\nspaceproof0123456789abcdeg\r\nNo results found' });
  assert.equal(await wrong.screenTransition(transition, response), null);
  wrong.message({ type: 'output', data: '\x1b[8;1Hunrelated fresh output' });
  assert.equal(await wrong.screenTransition(transition, response), null);
  wrong.message({ type: 'output', data: `\x1b[2J\x1b[HCommands\r\n${value}\r\nNo results found` });
  wrong.message({ type: 'output', data: '\x1b[2;1H\x1b[2Kwrong-current-value' });
  assert.equal(wrong.challenge(transition.sequence, value), true, 'The historical concatenated predicate accepts a value already erased from the screen.');
  assert.equal(await wrong.screenTransition(transition, response), null, 'Only the current visible full challenge can pass.');
});

test('projection refuses missing invalid and post-baseline changed generation or geometry', async () => {
  for (const geometry of [null, { ...screenGeometry, generationId: '' }, { ...screenGeometry, cols: 0 }, { ...screenGeometry, cols: 401 }, { ...screenGeometry, rows: 201 }, { ...screenGeometry, rows: 2.5 }]) {
    const proof = screenProof(); proof.message({ type: 'output', data: closedFrame });
    await assert.rejects(proof.screen(screenSession(geometry)), /generation-bound terminal geometry/);
  }
  for (const change of [{ generationId: 'different-host-generation' }, { cols: 101 }, { rows: 21 }]) {
    const proof = screenProof(); proof.message({ type: 'output', data: closedFrame });
    await proof.beginScreenTransition('open', screenSession()); proof.message({ type: 'output', data: menuFrame });
    await assert.rejects(proof.screen(screenSession({ ...screenGeometry, ...change })), /generation or geometry changed/);
  }
});

test('missing truncated or oversized replay fails closed instead of projecting a retained tail', async () => {
  const missing = liveProof(); missing.message({ type: 'output', data: menuFrame });
  await assert.rejects(missing.screen(screenSession()), /complete terminal replay/);
  const truncated = screenProof(); truncated.message({ type: 'status', status: 'RUNNING', replayContinuity: 'TRUNCATED' });
  truncated.message({ type: 'status', status: 'RUNNING', replayContinuity: 'COMPLETE' });
  await assert.rejects(truncated.screen(screenSession()), /replay is truncated/);
  const oversized = screenProof(); oversized.message({ type: 'output', data: 'x'.repeat(8 * 1024 * 1024 + 1) });
  await assert.rejects(oversized.screen(screenSession()), /exceeds the projection limit/);
  assert.equal(oversized.frames.length, 0);
});

test('an error or close during awaited screen projection cannot approve a live transition', async () => {
  for (const fail of [proof => proof.error('SYNTHETIC_ERROR'), proof => proof.close(1006), proof => proof.message({ type: 'status', status: 'EXITED', exitCode: 0 })]) {
    const proof = screenProof(); proof.message({ type: 'output', data: closedFrame });
    const projecting = proof.screen(screenSession()); fail(proof);
    await assert.rejects(projecting);
  }
});

test('retained full synthetic frames redact generated secrets across event boundaries without changing sequence offsets', () => {
  const proof = screenProof();
  proof.message({ type: 'output', data: 'before-private-' }); proof.message({ type: 'output', data: 'cookie-after ?tok' }); proof.message({ type: 'output', data: 'en=private-query\n' });
  const value = proof.streamEvidence(['private-cookie']), text = value.frames.map(frame => frame.data).join('');
  assert(!text.includes('private-cookie')); assert(!text.includes('private-query'));
  assert.deepEqual(value.frames.map(frame => [frame.sequence, frame.data.length]), proof.frames.map(frame => [frame.sequence, frame.data.length]));
  assert.equal(value.completeReplay, true);
});
