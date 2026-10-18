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
import { debounceSourceChanges } from '../dev-stack/reload-debounce.mjs';

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
  await privateWrite(config.compose, JSON.stringify(composeDocument(owner, pins, 'synthetic-password')));
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

test('pre-Compose startup state can be cleaned without invoking a missing Compose file', async t => {
  const config = await sandbox(t), owner = await initialize(config), calls = [];
  const invoke = async (_command, args) => { calls.push(args); assert.equal(args[1], 'ls'); return ''; };
  await removeOwnedDocker(config, owner, { volumes: true, invoke, env: {} });
  assert.equal(calls.some(args => args.includes('down')), false);
  assert.equal((await loadOwner(config)).nonce, owner.nonce);
});

test('a missing Compose file never hides owned containers networks or volumes', async t => {
  for (const kind of ['container', 'network', 'volume']) {
    const config = await sandbox(t), owner = await initialize(config), calls = [];
    const invoke = async (_command, args) => {
      calls.push(args);
      if (args[1] === 'ls') return args[0] === kind ? 'owned-resource' : '';
      if (args[1] === 'inspect') return JSON.stringify({ [ownerLabel]: owner.nonce });
      throw new Error('Missing Compose must not be passed to Docker.');
    };
    await assert.rejects(removeOwnedDocker(config, owner, { invoke, env: {} }), new RegExp(`Owned ${kind} remains`));
    assert.equal(calls.some(args => args.includes('down')), false);
    assert.equal((await loadOwner(config)).nonce, owner.nonce);
  }
});

test('cleanup refuses a directory in place of the generated Compose document', async t => {
  const config = await sandbox(t), owner = await initialize(config), calls = [];
  await mkdir(config.compose);
  const invoke = async (_command, args) => { calls.push(args); assert.equal(args[1], 'ls'); return ''; };
  await assert.rejects(removeOwnedDocker(config, owner, { invoke, env: {} }), /regular.*non-symlink/);
  assert.equal(calls.some(args => args.includes('down')), false);
});

test('cleanup refuses a linked Compose document without touching its target', { skip: process.platform === 'win32' }, async t => {
  const config = await sandbox(t), owner = await initialize(config), calls = [];
  const target = join(config.root, 'compose-sentinel'); await writeFile(target, 'unchanged');
  await symlink(target, config.compose);
  const invoke = async (_command, args) => { calls.push(args); assert.equal(args[1], 'ls'); return ''; };
  await assert.rejects(removeOwnedDocker(config, owner, { invoke, env: {} }), /regular.*non-symlink/);
  assert.equal(calls.some(args => args.includes('down')), false);
  assert.equal(await readFile(target, 'utf8'), 'unchanged');
});

test('a present Compose document still runs owned down and intentionally retains database volumes', async t => {
  const config = await sandbox(t), owner = await initialize(config), calls = [];
  await privateWrite(config.compose, JSON.stringify(composeDocument(owner, pins, 'synthetic-password')));
  const invoke = async (_command, args) => {
    calls.push(args);
    if (args[1] === 'ls') return args[0] === 'volume' ? 'retained-owned-volume' : '';
    if (args[1] === 'inspect') return JSON.stringify({ [ownerLabel]: owner.nonce });
    if (args.includes('down')) return '';
    throw new Error('Unexpected cleanup call');
  };
  await removeOwnedDocker(config, owner, { invoke, env: {} });
  assert.equal(calls.filter(args => args.includes('down')).length, 1);
  assert.equal(calls.find(args => args.includes('down')).includes('--volumes'), false);
});

test('a package edit keeps reload precedence in either event order and each later debounce window starts fresh', { timeout: 5000 }, async t => {
  const calls = []; let notify;
  const changes = debounceSourceChanges(kind => { calls.push(kind); notify(); });
  t.after(() => changes.stop());
  for (const sequence of [['packages', 'api'], ['api', 'packages'], ['api', 'packages', 'api'], ['api', 'api']]) {
    const fired = new Promise(resolvePromise => { notify = resolvePromise; });
    for (const kind of sequence) changes.change(kind);
    await fired;
    assert.equal(calls.at(-1), sequence.includes('packages') ? 'packages' : 'api');
  }
  assert.deepEqual(calls, ['packages', 'packages', 'packages', 'api']);
  assert(isPublicExportPath('scripts/dev-stack/reload-debounce.mjs'));
});

test('shutdown cancels a pending reload and ignores source notifications already queued by a closing watcher', { timeout: 5000 }, async () => {
  const calls = [], changes = debounceSourceChanges(kind => calls.push(kind));
  changes.change('packages'); changes.stop(); changes.change('api');
  await new Promise(resolvePromise => setTimeout(resolvePromise, 500));
  assert.deepEqual(calls, []);
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

const browserGrid = (cols = 153, rows = 46) => ({ paneId: 'tested-pane', status: 'attached', hasSession: 'true', hasWebsocket: 'true', hasError: 'false', width: 1105, geometry: { cols, rows, initialFitPending: false, fontsLoaded: true } });
const initialObserverGeometry = { generationId: 'same-original-generation', cols: 120, rows: 32 };
function browserGridProof() { const proof = screenProof(); proof.message({ type: 'output', data: closedFrame }); proof.pinGeneration(screenSession(initialObserverGeometry)); return proof; }
function acknowledgedGridProof() {
  const proof = browserGridProof(), state = browserGrid(), response = screenSession({ ...initialObserverGeometry, cols: 153, rows: 46 });
  assert.equal(proof.acknowledgeBrowserGeometry('tested-pane', state, response, state, 0), null);
  assert(proof.acknowledgeBrowserGeometry('tested-pane', state, response, state, 400));
  return { proof, state, response };
}

test('browser measured grid waits for actual API acknowledgment before the first latch instead of adopting the observer grid', async () => {
  const historical = screenProof(); historical.message({ type: 'output', data: closedFrame });
  const historicalTransition = await historical.beginScreenTransition('open', screenSession(initialObserverGeometry));
  historical.message({ type: 'output', data: menuFrame });
  await assert.rejects(historical.screenTransition(historicalTransition, screenSession({ ...initialObserverGeometry, cols: 153, rows: 46 })), /generation or geometry changed/, 'The old pre-input ordering reproduces the same guard family under a synthetic delayed resize.');
  const premature = browserGridProof();
  await assert.rejects(premature.beginScreenTransition('open', screenSession(initialObserverGeometry)), /acknowledgment is required/);
  const proof = browserGridProof(), state = browserGrid(), observer = screenSession(initialObserverGeometry), response = screenSession({ ...initialObserverGeometry, cols: 153, rows: 46 });
  assert.equal(proof.acknowledgeBrowserGeometry('tested-pane', state, observer, state, 0), null, 'The browser target153x46 is not acknowledged by observer120x32.');
  assert.equal(proof.geometry, null); assert.equal(proof.activeTransition, null);
  assert.equal(proof.acknowledgeBrowserGeometry('tested-pane', state, response, state, 400), null);
  assert.equal(proof.acknowledgeBrowserGeometry('tested-pane', state, response, state, 799), null, 'Two immediate agreeing reads cannot replace the400ms observation.');
  const ack = proof.acknowledgeBrowserGeometry('tested-pane', state, response, state, 800);
  assert.equal(ack.stableForMs, 400); assert.equal(ack.acknowledgedSamples, 2); assert.deepEqual(proof.initialGeometry, initialObserverGeometry);
  const transition = await proof.beginScreenTransition('open', response); assert.deepEqual(proof.geometry, response.session.terminalGeometry);
  proof.assertBrowserGeometry(state, 'tested-pane', 'before-key-Ctrl+P'); proof.message({ type: 'output', data: menuFrame });
  assert(await proof.screenTransition(transition, response));
});

test('a changing DOM sandwich or stale API clears startup samples and only pre-input dimensions may settle', () => {
  const proof = browserGridProof(), first = browserGrid(), second = browserGrid(150, 44), firstResponse = screenSession({ ...initialObserverGeometry, cols: 153, rows: 46 }), secondResponse = screenSession({ ...initialObserverGeometry, cols: 150, rows: 44 });
  assert.equal(proof.acknowledgeBrowserGeometry('tested-pane', first, firstResponse, first, 0), null);
  assert.equal(proof.acknowledgeBrowserGeometry('tested-pane', first, firstResponse, second, 400), null);
  assert.equal(proof.acknowledgeBrowserGeometry('tested-pane', second, firstResponse, second, 800), null);
  assert.equal(proof.acknowledgeBrowserGeometry('tested-pane', second, secondResponse, second, 1200), null);
  assert.equal(proof.acknowledgeBrowserGeometry('tested-pane', second, secondResponse, second, 1599), null);
  assert.equal(proof.acknowledgeBrowserGeometry('tested-pane', second, secondResponse, second, 1600).geometry.cols, 150);
  assert.equal(proof.geometry, null, 'Acknowledgment is not a screen/input latch.');
  assert.throws(() => proof.acknowledgeBrowserGeometry('tested-pane', second, secondResponse, second, 2000), /cannot be resampled/);
});

test('missing malformed pending or font-loading browser grids never establish readiness', () => {
  for (const geometry of [null, {}, { cols: 0, rows: 46 }, { cols: 401, rows: 46 }, { cols: 153, rows: 201 }, { cols: 153.5, rows: 46 }, { cols: 153, rows: 46 }, { ...browserGrid().geometry, initialFitPending: true }, { ...browserGrid().geometry, fontsLoaded: false }]) {
    const proof = browserGridProof(), state = { ...browserGrid(), geometry }, response = screenSession({ ...initialObserverGeometry, cols: 153, rows: 46 });
    assert.equal(proof.acknowledgeBrowserGeometry('tested-pane', state, response, state, 0), null);
    assert.equal(proof.acknowledgeBrowserGeometry('tested-pane', state, response, state, 400), null);
    assert.equal(proof.browserGeometry, null); assert.equal(proof.geometry, null);
  }
  for (const change of [{ paneId: 'foreign-pane' }, { status: 'closed' }, { hasError: 'true' }, { width: 0 }]) {
    const proof = browserGridProof(), state = { ...browserGrid(), ...change };
    assert.throws(() => proof.acknowledgeBrowserGeometry('tested-pane', state, screenSession(initialObserverGeometry), state, 0));
    assert.equal(proof.browserGeometry, null);
  }
});

test('first live generation is pinned before browser startup and cannot roll over during dimension rendezvous', () => {
  for (const geometry of [{ ...initialObserverGeometry, generationId: 'replacement-generation' }, null, { ...initialObserverGeometry, generationId: '' }, { ...initialObserverGeometry, cols: 401 }]) {
    const proof = browserGridProof(), state = browserGrid();
    assert.throws(() => proof.acknowledgeBrowserGeometry('tested-pane', state, screenSession(geometry), state, 400), /generation/);
    assert.equal(proof.expectedGenerationId, initialObserverGeometry.generationId); assert.equal(proof.browserGeometry, null);
  }
  const replaced = browserGridProof(), state = browserGrid(), response = screenSession(initialObserverGeometry); response.session.sessionId = 'replacement-session';
  assert.throws(() => replaced.acknowledgeBrowserGeometry('tested-pane', state, response, state, 0), /Fresh API/);
  const unpinned = screenProof(); assert.throws(() => unpinned.acknowledgeBrowserGeometry('tested-pane', state, screenSession(initialObserverGeometry), state, 0), /Pin the first live generation/);
});

test('acknowledged geometry cannot change before the first latch or after it and every keyboard grid is checked', async () => {
  const before = acknowledgedGridProof();
  await assert.rejects(before.proof.beginScreenTransition('open', screenSession({ ...before.response.session.terminalGeometry, cols: 154 })), /changed after browser\/API/);
  for (const change of [{ cols: 154 }, { rows: 47 }, { generationId: 'replacement-generation' }]) {
    const { proof, response } = acknowledgedGridProof(); await proof.beginScreenTransition('open', response); proof.message({ type: 'output', data: menuFrame });
    await assert.rejects(proof.screen(screenSession({ ...response.session.terminalGeometry, ...change })), /generation or geometry changed/);
    assert.equal(proof.diagnostic().geometryObservation.observedAPI.cols, change.cols || 153);
  }
  for (const change of [{ cols: 154 }, { rows: 47 }, { initialFitPending: true }, { fontsLoaded: false }]) {
    const { proof, state, response } = acknowledgedGridProof(); await proof.beginScreenTransition('open', response);
    assert.throws(() => proof.assertBrowserGeometry({ ...state, geometry: { ...state.geometry, ...change } }, 'tested-pane', 'before-key-filter'), /browser terminal grid differs/);
  }
  const foreign = acknowledgedGridProof();
  assert.throws(() => foreign.proof.assertBrowserGeometry({ ...foreign.state, paneId: 'foreign-pane' }, 'foreign-pane', 'before-key-filter'), /remain the acknowledged pane/);
});

test('rendezvous retains error close and truncated replay failures instead of resetting them into readiness', () => {
  for (const fail of [proof => proof.error('CONTROL_FAILURE'), proof => proof.close(1006), proof => proof.message({ type: 'status', status: 'EXITED', exitCode: 0 }), proof => proof.message({ type: 'status', status: 'RUNNING', replayContinuity: 'TRUNCATED' })]) {
    const proof = browserGridProof(), state = browserGrid(); fail(proof);
    assert.throws(() => proof.acknowledgeBrowserGeometry('tested-pane', state, screenSession(initialObserverGeometry), state, 400));
    assert.equal(proof.browserGeometry, null); assert.equal(proof.geometry, null);
  }
});

test('geometry failure evidence retains only bounded expected and observed fields without raw session or DOM secrets', async () => {
  const { proof, response } = acknowledgedGridProof(); await proof.beginScreenTransition('open', response);
  const changed = screenSession({ ...response.session.terminalGeometry, cols: 154 }); changed.session.websocket = { token: 'private-token', url: 'ws://private-url/' }; changed.session.password = 'private-password';
  await assert.rejects(proof.screen(changed, 'after-open'), /generation or geometry changed/);
  const value = proof.diagnostic(), evidence = proof.streamEvidence(), encoded = JSON.stringify({ value, evidence });
  assert.deepEqual(value.geometryObservation, { phase: 'after-open', sequence: proof.sequence, expected: response.session.terminalGeometry, observedAPI: changed.session.terminalGeometry });
  assert(!encoded.includes('private-token')); assert(!encoded.includes('private-url')); assert(!encoded.includes('private-password'));
  assert.deepEqual(evidence.initialGeometry, initialObserverGeometry); assert.deepEqual(evidence.browserGeometry.geometry, response.session.terminalGeometry);
  const clock = browserGridProof(), state = browserGrid(); assert.throws(() => clock.acknowledgeBrowserGeometry('tested-pane', state, screenSession(initialObserverGeometry), state, NaN), /clock must be finite/);
});

const { ReadinessEpoch } = await import('../dev-stack/readiness.mjs');
function readinessObservation(policy, outcome, now) {
  const probe = policy.beginProbe(); assert(probe, 'Only an active generation can be probed.');
  try { return policy.settle(probe, outcome, now); } finally { policy.release(probe); }
}

test('initial readiness preserves the existing HTTP startup deadline and unreachable attempt bound', () => {
  const waiting = new ReadinessEpoch(); waiting.start(1000);
  assert.equal(readinessObservation(waiting, 'unavailable', 181000).fatal, false);
  assert.equal(readinessObservation(waiting, 'unavailable', 181001).fatal, true);
  const unreachable = new ReadinessEpoch(); unreachable.start(0);
  for (let i = 1; i < 30; i++) assert.equal(readinessObservation(unreachable, 'unreachable', i * 4000).fatal, false);
  assert.equal(readinessObservation(unreachable, 'unreachable', 120000).fatal, true);
  const reset = new ReadinessEpoch(); reset.start(0);
  readinessObservation(reset, 'unreachable', 4000); assert.equal(readinessObservation(reset, 'ready', 8000).failures, 0);
});

test('intentional API restart clears the prior ready state and failures before the replacement is observed', () => {
  const policy = new ReadinessEpoch(); policy.start(0); readinessObservation(policy, 'ready', 1000);
  for (let i = 1; i <= 3; i++) assert.equal(readinessObservation(policy, 'unreachable', 1000 + i * 4000).fatal, false);
  policy.pause(); assert.equal(policy.beginProbe(), null); policy.start(600000);
  assert.deepEqual({ lastReady: policy.diagnostic().lastReady, failures: policy.diagnostic().failures }, { lastReady: null, failures: 0 });
  assert.equal(readinessObservation(policy, 'unreachable', 604000).fatal, false);
  assert.equal(readinessObservation(policy, 'unreachable', 608000).fatal, false);
  assert.equal(readinessObservation(policy, 'ready', 612000).failures, 0);
});

test('a long shared-package compilation consumes no replacement generation startup allowance', () => {
  const policy = new ReadinessEpoch(); policy.start(0); readinessObservation(policy, 'ready', 1000);
  policy.pause(); assert.equal(policy.beginProbe(), null); assert.equal(policy.diagnostic().paused, true);
  policy.start(900000); assert.equal(policy.diagnostic().deadline, 1080000);
  assert.equal(readinessObservation(policy, 'unavailable', 1079999).fatal, false);
  assert.equal(readinessObservation(policy, 'unavailable', 1080001).fatal, true);
  policy.pause(); policy.start(2000000);
  for (let i = 1; i <= 30; i++) assert.equal(readinessObservation(policy, 'unreachable', 2000000 + i * 4000).fatal, i === 30);
});

test('a late prior-epoch failure and finally cannot poison or unlock the current generation probe', async () => {
  const policy = new ReadinessEpoch(); policy.start(0);
  const old = policy.beginProbe(); let rejectOld;
  const pending = new Promise(resolvePromise => { rejectOld = resolvePromise; }).then(() => {
    try { return policy.settle(old, 'unreachable', 700000); } finally { policy.release(old); }
  });
  policy.pause(); policy.start(600000); const current = policy.beginProbe(); rejectOld();
  assert.equal(await pending, null); assert.equal(policy.diagnostic().failures, 0);
  assert.equal(policy.diagnostic().checking, true); assert.equal(policy.beginProbe(), null);
  assert.equal(policy.settle(current, 'ready', 700000).fatal, false); policy.release(current);
  assert.equal(policy.diagnostic().lastReady, true);
});

test('a late prior-epoch success cannot certify a replacement or erase its startup failures', async () => {
  const policy = new ReadinessEpoch(); policy.start(0); const old = policy.beginProbe(); let resolveOld;
  const pending = new Promise(resolvePromise => { resolveOld = resolvePromise; }).then(() => {
    try { return policy.settle(old, 'ready', 900000); } finally { policy.release(old); }
  });
  policy.pause(); policy.start(600000); readinessObservation(policy, 'unreachable', 604000);
  const current = policy.beginProbe(); resolveOld(); assert.equal(await pending, null);
  assert.equal(policy.diagnostic().lastReady, null); assert.equal(policy.diagnostic().failures, 1);
  assert.equal(policy.diagnostic().checking, true);
  assert.equal(policy.settle(current, 'unavailable', 780001).fatal, true); policy.release(current);
});

test('a ready replacement still fails after four sustained losses and a healthy response resets them', () => {
  for (const outcome of ['unavailable', 'unreachable']) {
    const policy = new ReadinessEpoch(); policy.start(0); readinessObservation(policy, 'ready', 1000);
    for (let i = 1; i <= 3; i++) assert.equal(readinessObservation(policy, outcome, 1000000 + i * 4000).fatal, false);
    assert.equal(readinessObservation(policy, 'ready', 1020000).failures, 0);
    for (let i = 1; i <= 4; i++) assert.equal(readinessObservation(policy, outcome, 1020000 + i * 4000).fatal, i === 4);
  }
});

test('only one matching readiness probe can settle and release each generation', () => {
  const policy = new ReadinessEpoch(); assert.equal(policy.beginProbe(), null);
  assert.throws(() => policy.start(NaN), /clock must be finite/); policy.start(0);
  assert.equal(policy.settle(null, 'ready', 0), null);
  const probe = policy.beginProbe(); assert.equal(policy.beginProbe(), null);
  assert.equal(policy.settle({ epoch: probe.epoch }, 'ready', 0), null);
  assert.throws(() => policy.settle(probe, 'unexpected', 0), /Invalid readiness/);
  assert.throws(() => policy.settle(probe, 'ready', NaN), /Invalid readiness/);
  assert.equal(policy.settle(probe, 'unreachable', 4000).failures, 1);
  assert.equal(policy.settle(probe, 'unreachable', 8000), null);
  assert.equal(policy.diagnostic().failures, 1); policy.release(probe);
  const successor = policy.beginProbe(); assert(successor); policy.release(probe);
  assert.equal(policy.beginProbe(), null, 'A late finally cannot release a newer probe in the same epoch.');
  policy.pause(); assert.equal(policy.settle(successor, 'ready', 9000), null); policy.release(successor);
  assert.equal(policy.diagnostic().paused, true);
  assert(isPublicExportPath('scripts/dev-stack/readiness.mjs'));
});

const { sourceReloadWorkspaces, sourceReloadBuildPlan, buildSourceServices } = await import('../dev-stack/source-build.mjs');

test('source reload preserves canonical workspace order and the complete API worker CLI dependency closure', async () => {
  const { readdir } = await import('node:fs/promises');
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const canonical = [...manifest.scripts.build.matchAll(/npm run build -w (@space\/[a-z-]+)/g)].map(x => x[1]);
  const packages = new Map();
  for (const directory of ['packages', 'apps']) for (const item of await readdir(join(root, directory), { withFileTypes: true })) {
    if (!item.isDirectory()) continue;
    const value = await readFile(join(root, directory, item.name, 'package.json'), 'utf8').then(JSON.parse).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (value) packages.set(value.name, value);
  }
  const required = new Set();
  const include = name => {
    if (required.has(name)) return; required.add(name);
    const value = packages.get(name); assert(value, `Missing required workspace ${name}`);
    for (const dependency of Object.keys({ ...value.dependencies, ...value.optionalDependencies, ...value.devDependencies }).filter(x => x.startsWith('@space/'))) include(dependency);
  };
  for (const name of ['@space/api', '@space/worker', '@space/cli-host']) include(name);
  assert.deepEqual(sourceReloadWorkspaces, canonical.filter(name => name !== '@space/web'));
  assert.deepEqual(sourceReloadWorkspaces.filter(name => required.has(name)), canonical.filter(name => required.has(name)));
  for (const name of required) {
    assert(sourceReloadWorkspaces.includes(name), `Reload omits ${name}`);
    const value = packages.get(name);
    for (const dependency of Object.keys({ ...value.dependencies, ...value.optionalDependencies, ...value.devDependencies }).filter(x => x.startsWith('@space/'))) assert(sourceReloadWorkspaces.indexOf(dependency) < sourceReloadWorkspaces.indexOf(name), `${dependency} must be built before ${name}`);
  }
  assert(sourceReloadWorkspaces.includes('@space/icons')); assert.equal(sourceReloadWorkspaces.length, required.size + 1);
  assert(isPublicExportPath('scripts/dev-stack/source-build.mjs'));
});

test('hot service builds finish strictly in canonical order with permissions before a replacement can launch', async () => {
  const calls = []; let active = 0, launched = false;
  const completion = buildSourceServices(async (executable, args) => {
    assert.equal(++active, 1, 'Builds must not overlap.'); assert.equal(launched, false);
    calls.push({ executable, args: [...args] }); await new Promise(resolvePromise => setImmediate(resolvePromise)); active--;
  }, () => false).then(() => { launched = true; });
  assert.equal(launched, false); await completion; assert.equal(launched, true);
  assert.deepEqual(calls, [...sourceReloadWorkspaces.map(name => ({ executable: 'npm', args: ['run', 'build', '-w', name] })), { executable: 'node', args: ['scripts/fix-build-permissions.mjs'] }]);
  assert(Object.isFrozen(sourceReloadBuildPlan)); assert(sourceReloadBuildPlan.every(step => Object.isFrozen(step) && Object.isFrozen(step.args)));
  assert.equal(calls.some(step => step.args.includes('@space/web') || step.args.includes('scripts/build-demo-projects.mjs')), false);
  assert.equal(calls.some(step => step.executable === 'npm' && step.args.length === 2), false, 'The frozen old full-root invocation would rebuild production web/demos on this path.');
});

test('failure in any shared service or permission build prevents all later commands and relaunch', async () => {
  for (let failureAt = 0; failureAt < sourceReloadBuildPlan.length; failureAt++) {
    const failure = new Error(`synthetic build failure ${failureAt}`), calls = []; let launched = false;
    await assert.rejects(buildSourceServices(async (executable, args) => {
      calls.push({ executable, args }); if (calls.length - 1 === failureAt) throw failure;
    }, () => false).then(() => { launched = true; }), error => error === failure);
    assert.equal(calls.length, failureAt + 1); assert.equal(launched, false);
  }
});

test('source rebuild cancellation before during and after commands never permits a later step or relaunch', async () => {
  const calls = []; await assert.rejects(buildSourceServices(async () => { calls.push('unexpected'); }, () => true), /cancelled before relaunch/); assert.equal(calls.length, 0);
  let stopping = false, release, launched = false;
  const pending = buildSourceServices(async executable => {
    calls.push(executable); await new Promise(resolvePromise => { release = resolvePromise; });
  }, () => stopping).then(() => { launched = true; });
  stopping = true; release(); await assert.rejects(pending, /cancelled before relaunch/);
  assert.equal(calls.length, 1); assert.equal(launched, false);
  stopping = false; let finished = 0;
  await assert.rejects(buildSourceServices(async () => { if (++finished === sourceReloadBuildPlan.length) stopping = true; }, () => stopping).then(() => { launched = true; }), /cancelled before relaunch/);
  assert.equal(finished, sourceReloadBuildPlan.length); assert.equal(launched, false);
});

const { ReloadReceipt } = await import('../dev-stack/reload-debounce.mjs');
const { reloadObservation, restorationCheckpoint } = await import('../dev-stack/acceptance-restoration.mjs');

// Unit-only identities/readiness/bytes exercise the join, not a native platform proof.
function restorationFixture() {
  const nonce = 'unit-only-restoration-owner';
  const receipt = (generation, revision = generation * 10) => ({ version: 1, revision, requested: generation, pending: null, queued: null, active: null, completed: generation, stopping: false });
  const record = (generation, offset = generation * 10) => ({ nonce, pid: 90, identity: 'unit-only:supervisor', reload: receipt(generation), children: ['api', 'cli-host', 'web', 'worker'].map((name, index) => ({ name, pid: offset + index + 100, identity: 'darwin:Sun Oct 18 01:00:00 2026' })) });
  const before = record(1);
  let current = record(2), clock = 0, pauses = 0, readiness = 0, bytes = Buffer.from('original shared output');
  const reply = (snapshot, request) => ({ version: 1, nonce, pid: before.pid, identity: before.identity, challenge: request.challenge, status: 'OK', snapshot: structuredClone(snapshot) });
  const options = { nonce, supervisor: before, before, changed: ['api', 'worker', 'cli-host'], timeout: 300000, observe: async request => reply(current, request), live: async () => true, ready: async () => { readiness++; return true; }, files: [{ name: 'compiled shared output', read: async () => bytes, expected: Buffer.from(bytes), forbidden: 'unit-canary' }], now: () => clock, pause: async () => { pauses++; clock += 300000; } };
  return { before, receipt, record, reply, options, get current() { return current; }, set current(value) { current = value; }, set bytes(value) { bytes = Buffer.from(value); }, get pauses() { return pauses; }, get readiness() { return readiness; } };
}

test('reload observations retain the exact debounce precedence and count every pending request', { timeout: 5000 }, async t => {
  const receipt = new ReloadReceipt(), observations = [], calls = []; let notify;
  const fired = new Promise(resolvePromise => { notify = resolvePromise; });
  const changes = debounceSourceChanges((kind, generation) => { calls.push({ kind, generation }); receipt.started(kind, generation); notify(); }, state => { receipt.debounced(state); observations.push(receipt.snapshot()); });
  t.after(() => changes.stop());
  changes.change('packages'); changes.change('api');
  assert.deepEqual(receipt.snapshot().pending, { generation: 2, kind: 'packages' });
  assert.equal(receipt.snapshot().requested, 2); assert.equal(receipt.snapshot().completed, 0);
  await fired;
  assert.deepEqual(calls, [{ kind: 'packages', generation: 2 }]);
  assert.equal(observations.at(-1).pending, null);
  receipt.finished(2, true);
  assert.equal(receipt.snapshot().completed, 2); assert.equal(receipt.snapshot().active, null);
  changes.stop(); changes.change('packages');
  assert.equal(receipt.snapshot().stopping, true); assert.equal(receipt.snapshot().requested, 2);
  assert(observations.every((item, index) => index === 0 || item.revision > observations[index - 1].revision));
});

test('completing an active reload cannot certify pending or queued work and failures never complete it', () => {
  const receipt = new ReloadReceipt();
  receipt.debounced({ requested: 1, pending: null, stopped: false }); receipt.started('api', 1);
  receipt.debounced({ requested: 2, pending: { kind: 'packages', generation: 2 }, stopped: false });
  receipt.debounced({ requested: 2, pending: null, stopped: false }); receipt.enqueued(2);
  receipt.finished(1, true);
  assert.equal(receipt.snapshot().completed, 1); assert.equal(receipt.snapshot().requested, 2);
  assert.deepEqual(receipt.snapshot().queued, { kind: 'packages', generation: 2 });
  const queued = receipt.releaseQueued(); assert.equal(queued, 2);
  assert.equal(receipt.snapshot().completed < receipt.snapshot().requested, true);
  receipt.started('packages', queued); receipt.finished(queued, false);
  assert.equal(receipt.snapshot().completed, 1);
  receipt.stop(); assert.equal(receipt.snapshot().stopping, true);
});

test('the old indistinguishable ready/live/original-byte state cannot pass without a reload receipt', async () => {
  const fixture = restorationFixture(); delete fixture.current.reload;
  assert(fixture.current.children.every(item => item.pid !== fixture.before.children.find(old => old.name === item.name).pid));
  await assert.rejects(restorationCheckpoint(fixture.options), /Missing or malformed reload receipt/);
  assert.equal(fixture.readiness, 0);
  assert(isPublicExportPath('scripts/dev-stack/acceptance-restoration.mjs'));
});

test('restoration waits through pending queued and active phases despite unchanged ready and original bytes', async () => {
  const fixture = restorationFixture(), final = fixture.record(3), states = ['pending', 'queued', 'active'].map((phase, index) => ({ ...fixture.record(2), reload: { ...fixture.receipt(3, 30 + index), completed: 2, [phase]: { kind: 'packages', generation: 3 } } }));
  final.reload.revision = 33;
  fixture.current = states.shift();
  fixture.options.pause = async () => { fixture.current = states.shift() || final; };
  const joined = await restorationCheckpoint(fixture.options);
  assert.equal(joined.reload.completed, 3); assert.equal(joined.reload.requested, 3);
  assert.equal(fixture.readiness, 1); assert.deepEqual(joined.children, final.children);
  assert.equal(joined.files[0].bytes, Buffer.byteLength('original shared output'));
  assert.match(joined.files[0].sha256, /^[a-f0-9]{64}$/);
});

test('a request arriving between the two observations prevents a mixed-generation handoff', async () => {
  const fixture = restorationFixture(), first = fixture.record(2), queued = { ...fixture.record(2), reload: { ...fixture.receipt(3, 31), completed: 2, queued: { kind: 'packages', generation: 3 } } }, final = fixture.record(3);
  final.reload.revision = 32;
  let reads = 0;
  fixture.options.observe = async request => fixture.reply(++reads === 1 ? first : reads === 2 ? queued : final, request);
  fixture.options.pause = async () => {};
  const joined = await restorationCheckpoint(fixture.options);
  assert.equal(reads, 4); assert.equal(fixture.readiness, 2); assert.equal(joined.reload.completed, 3);
});

test('same-second Darwin birth strings with changed verified PIDs are distinct restored identities', async () => {
  const fixture = restorationFixture();
  assert.equal(fixture.current.children[0].identity, fixture.before.children[0].identity);
  const live = new Map([fixture.current, ...fixture.current.children].map(item => [item.pid, item.identity]));
  fixture.options.live = item => sameProcess(item, async pid => live.get(pid) ?? null);
  const joined = await restorationCheckpoint(fixture.options);
  assert.notEqual(joined.children[0].pid, fixture.before.children[0].pid);
  assert.equal(joined.children[0].identity, fixture.before.children[0].identity);
});

test('old ready responses cannot certify an unchanged API or an unreplaced shared service', async () => {
  for (const name of ['api', 'worker', 'cli-host']) {
    const fixture = restorationFixture(); fixture.current.children.find(item => item.name === name).pid = fixture.before.children.find(item => item.name === name).pid;
    await assert.rejects(restorationCheckpoint(fixture.options), /existing 300s proof bound/);
    assert.equal(fixture.readiness, 0); assert.equal(fixture.pauses, 1);
  }
  const fixture = restorationFixture(); fixture.current = fixture.record(1, 200);
  await assert.rejects(restorationCheckpoint(fixture.options), /proof bound/);
  assert.equal(fixture.readiness, 0, 'New PIDs without a completed later request are insufficient.');
});

test('original source and compiled bytes and a fresh ready response are all required', async () => {
  for (const bytes of ['original shared output\n', 'original shared output unit-canary']) {
    const fixture = restorationFixture(); fixture.bytes = bytes;
    await assert.rejects(restorationCheckpoint(fixture.options), /proof bound/);
    assert.equal(fixture.readiness, 1);
  }
  const forbidden = restorationFixture(); forbidden.bytes = 'unit-canary'; forbidden.options.files[0].expected = Buffer.from('unit-canary');
  await assert.rejects(restorationCheckpoint(forbidden.options), /proof bound/);
  const unavailable = restorationFixture(); unavailable.options.ready = async () => false;
  await assert.rejects(restorationCheckpoint(unavailable.options), /proof bound/);
  const restored = restorationFixture(); restored.bytes = 'unit-canary'; restored.options.pause = async () => { restored.bytes = 'original shared output'; };
  assert.equal((await restorationCheckpoint(restored.options)).ready, true); assert.equal(restored.readiness, 2);
});

test('missing malformed decreasing and unversioned reload receipts cannot become proof', async () => {
  for (const mutate of [value => { value.version = 0; }, value => { delete value.pending; }, value => { value.requested = NaN; }, value => { value.completed = 3; }, value => { value.queued = { kind: 'api', generation: 2 }; }, value => { value.active = { kind: 'packages', generation: 0 }; }]) {
    const fixture = restorationFixture(); mutate(fixture.current.reload);
    await assert.rejects(restorationCheckpoint(fixture.options), /receipt/);
  }
  const decreasing = restorationFixture(); decreasing.current.reload.revision = 9;
  await assert.rejects(restorationCheckpoint(decreasing.options), /moved backwards/);
  const unversioned = restorationFixture(); unversioned.current.reload.revision = unversioned.before.reload.revision;
  await assert.rejects(restorationCheckpoint(unversioned.options), /without a new revision/);
  assert.throws(() => reloadObservation(null), /receipt/);
});

test('foreign supervisor records stopping and dead or duplicate idle children fail without retry', async () => {
  for (const mutate of [value => { value.nonce = 'foreign'; }, value => { value.pid++; }, value => { value.identity += ':changed'; }, value => { value.reload.stopping = true; }, value => { value.children.pop(); }, value => { value.children[1].pid = value.children[0].pid; }, value => { value.children[0].identity = null; }]) {
    const fixture = restorationFixture(); mutate(fixture.current);
    await assert.rejects(restorationCheckpoint(fixture.options)); assert.equal(fixture.pauses, 0);
  }
  const dead = restorationFixture(); dead.options.live = async item => item.pid === dead.current.pid;
  await assert.rejects(restorationCheckpoint(dead.options), /child identity changed/); assert.equal(dead.readiness, 0); assert.equal(dead.pauses, 0);
  const root = restorationFixture(); root.options.live = async () => false;
  await assert.rejects(restorationCheckpoint(root.options), /unbound|supervisor identity changed/); assert.equal(root.pauses, 0);
  const malformed = restorationFixture(), failure = new SyntaxError('unit-only incomplete private JSON'); malformed.options.observe = async () => { throw failure; };
  await assert.rejects(restorationCheckpoint(malformed.options), error => error === failure);
});

test('an identity changing around fresh readiness or inside the same idle receipt stays fatal', async () => {
  const fixture = restorationFixture(); let calls = 0;
  fixture.options.live = async item => item.pid === fixture.current.pid || ++calls <= 4;
  await assert.rejects(restorationCheckpoint(fixture.options), /child identity changed/); assert.equal(fixture.pauses, 0);
  const mixed = restorationFixture(); let reads = 0;
  mixed.options.observe = async request => { const value = structuredClone(mixed.current); if (++reads === 2) value.children[0].pid += 500; return mixed.reply(value, request); };
  await assert.rejects(restorationCheckpoint(mixed.options), /same idle reload receipt/); assert.equal(mixed.pauses, 0);
});

test('the strict actual lifecycle snapshot still rejects root churn after a successful restoration join', async () => {
  const source = await readFile(join(root, 'scripts/dev-stack/lifecycle-proof.mjs'), 'utf8');
  const body = source.slice(source.indexOf('async function processSnapshot('), source.indexOf('async function assertStopped('));
  assert(body.startsWith('async function processSnapshot('));
  const fixture = restorationFixture(), joined = await restorationCheckpoint(fixture.options), first = joined.children[0];
  let calls = 0, lists = 0;
  const identity = async pid => pid === first.pid && ++calls > 1 ? 'unit-only:late-replacement' : joined.children.find(item => item.pid === pid)?.identity;
  const snapshot = new Function('readJson', 'sameProcess', 'descendants', `return (${body});`)(async () => joined, item => sameProcess(item, identity), item => descendants(item, { identity, list: async () => { lists++; return { stdout: '' }; } }));
  await assert.rejects(snapshot({ supervisor: 'unit-only-unused-path' }), /root changed before descendant collection/);
  assert.equal(lists, 0, 'The guard rejects before adopting or collecting a replacement tree.');
});

test('the restoration helper cannot widen the original API or shared bounds or a remaining phase deadline', async () => {
  const fixture = restorationFixture();
  for (const timeout of [0, 150000, 300001, Infinity]) await assert.rejects(restorationCheckpoint({ ...fixture.options, timeout }), /boundary/);
  await assert.rejects(restorationCheckpoint({ ...fixture.options, until: 0 }), /existing 300s proof bound/);
  await assert.rejects(restorationCheckpoint({ ...fixture.options, until: NaN }), /deadline/);
});

const { observeReloadProof, openReloadProofChannel, parseReloadRequest, queryReloadProof, reserveReloadProofObservation } = await import('../dev-stack/reload-proof-channel.mjs');
const { randomUUID: proofChallenge } = await import('node:crypto');

test('an already known pending reload cannot pass through two stale disk reads while publication is held', async () => {
  const fixture = restorationFixture(); let memory = fixture.current, persisted = structuredClone(memory), tail = Promise.resolve(), releaseWrite, releasePause, paused = false, completed = false, snapshots = 0;
  fixture.options.observe = async request => {
    const result = await observeReloadProof({ tail: () => tail, closed: () => false, snapshot: () => { snapshots++; return structuredClone(memory); } });
    return { ...fixture.reply(null, request), ...result };
  };
  fixture.options.ready = async () => {
    if (memory.reload.requested === 2) {
      memory = { ...fixture.record(2), reload: { ...fixture.receipt(3, 31), completed: 2, pending: { kind: 'packages', generation: 3 } } };
      tail = new Promise(resolvePromise => { releaseWrite = resolvePromise; }).then(() => { persisted = structuredClone(memory); });
    }
    return true;
  };
  fixture.options.pause = async () => { paused = true; await new Promise(resolvePromise => { releasePause = resolvePromise; }); };
  const joining = restorationCheckpoint(fixture.options).then(value => { completed = true; return value; });
  await new Promise(resolvePromise => setImmediate(resolvePromise));
  assert.equal(persisted.reload.requested, 2); assert.equal(memory.reload.requested, 3);
  assert.equal(snapshots, 1, 'The second request must wait for its captured pending publication.');
  assert.equal(completed, false);
  releaseWrite(); await new Promise(resolvePromise => setImmediate(resolvePromise));
  assert.equal(paused, true); assert.equal(completed, false, 'Drained but pending RAM is BUSY, never idle disk generation2.');
  memory = fixture.record(3); memory.reload.revision = 32; persisted = structuredClone(memory); tail = Promise.resolve();
  releasePause();
  const joined = await joining;
  assert.equal(joined.reload.completed, 3); assert.equal(persisted.reload.completed, 3);
  assert.equal(joined.proofRequests.length, 2); assert.notEqual(...joined.proofRequests);
});

test('a tail added during a request drain is BUSY and cannot publish an earlier snapshot', async () => {
  let release, snapshots = 0;
  const first = new Promise(resolvePromise => { release = resolvePromise; }); let tail = first;
  const request = observeReloadProof({ tail: () => tail, closed: () => false, snapshot: () => { snapshots++; return restorationFixture().current; } });
  tail = first.then(() => {}); release();
  assert.deepEqual(await request, { status: 'BUSY', snapshot: null }); assert.equal(snapshots, 0);
});

test('publication rejection shutdown and malformed snapshots are fatal rather than BUSY', async () => {
  const settled = Promise.resolve();
  await assert.rejects(observeReloadProof({ tail: () => Promise.reject(new Error('unit publication error')), closed: () => false, snapshot: () => ({}) }), /WRITE_FAILED/);
  await assert.rejects(observeReloadProof({ tail: () => Promise.resolve(), closed: () => true, snapshot: () => ({}) }), /STOPPING/);
  let release, closed = false;
  const tail = new Promise(resolvePromise => { release = resolvePromise; });
  const pending = observeReloadProof({ tail: () => tail, closed: () => closed, snapshot: () => { throw new Error('Must not snapshot during shutdown'); } });
  closed = true; release(); await assert.rejects(pending, /STOPPING/);
  await assert.rejects(observeReloadProof({ tail: () => settled, closed: () => false, snapshot: () => ({ reload: {} }) }), /malformed reload receipt/);
  const fixture = restorationFixture(); fixture.current.reload.stopping = true;
  const resolved = Promise.resolve();
  await assert.rejects(observeReloadProof({ tail: () => resolved, closed: () => false, snapshot: () => fixture.current }), /STOPPING/);
});

test('fresh request binding rejects replayed foreign or missing channel responses without a file fallback', async () => {
  for (const mutate of [value => { value.challenge = proofChallenge(); }, value => { value.nonce = 'foreign'; }, value => { value.pid++; }, value => { value.identity = 'different'; }, value => { value.version = 0; }, value => { value.status = 'ERROR'; }, value => { value.status = 'BUSY'; }]) {
    const fixture = restorationFixture(); fixture.options.observe = async request => { const value = fixture.reply(fixture.current, request); mutate(value); return value; };
    await assert.rejects(restorationCheckpoint(fixture.options)); assert.equal(fixture.pauses, 0);
  }
  const replay = restorationFixture(); let first;
  replay.options.observe = async request => first ||= replay.reply(replay.current, request);
  await assert.rejects(restorationCheckpoint(replay.options), /stale or unbound/);
  await assert.rejects(restorationCheckpoint({ ...restorationFixture().options, observe: undefined }), /no file-only fallback/);
});

test('request parsing enforces one bounded owned message with no supplied paths or unknown fields', () => {
  const owner = { nonce: 'a'.repeat(32), pid: 90, identity: 'unit-only:supervisor' }, request = { version: 1, ...owner, challenge: proofChallenge() };
  const encoded = value => Buffer.from(JSON.stringify(value) + '\n');
  assert.deepEqual(parseReloadRequest(encoded(request), owner), request);
  for (const value of [{ ...request, path: '/foreign' }, { ...request, nonce: 'foreign' }, { ...request, pid: 91 }, { ...request, identity: 'other' }, { ...request, challenge: 'not-a-fresh-uuid' }, { ...request, version: 2 }]) assert.throws(() => parseReloadRequest(encoded(value), owner), /REQUEST/);
  for (const bytes of [Buffer.from('{}'), Buffer.concat([encoded(request), encoded(request)]), Buffer.from('x'.repeat(1025)), Buffer.from('{not-json}\n')]) assert.throws(() => parseReloadRequest(bytes, owner), /REQUEST/);
  assert(isPublicExportPath('scripts/dev-stack/reload-proof-channel.mjs'));
});

test('a completed request cannot qualify after the unchanged overall proof deadline', async () => {
  const fixture = restorationFixture(); let clock = 0;
  fixture.options.now = () => clock; fixture.options.ready = async () => { clock = 300000; return true; };
  await assert.rejects(restorationCheckpoint(fixture.options), /existing 300s proof bound/);
});

async function unixProofFixture(t, { allowReplaced = false } = {}) {
  const state = await realpath(await mkdtemp(join(tmpdir(), 'space-reload-proof-')));
  await chmod(state, 0o700); await mkdir(join(state, 'run'), { mode: 0o700 });
  const owner = { nonce: 'b'.repeat(32), pid: process.pid, identity: await processIdentity(process.pid) };
  const fixture = restorationFixture(), settled = Promise.resolve();
  const channel = await openReloadProofChannel({ state }, owner, () => observeReloadProof({ tail: () => settled, closed: () => false, snapshot: () => ({ ...fixture.current, ...owner }) }));
  t.after(async () => {
    try { if (allowReplaced) await assert.rejects(channel.close(), /SOCKET_REPLACED/); else await channel.close(); }
    finally { await rm(state, { recursive: true, force: true }); }
  });
  return { state, owner: { ...owner, proofSocket: channel.name }, channel };
}

test('real POSIX owned socket transports fresh observations and removes its own private path', { skip: process.platform === 'win32' }, async t => {
  const { state, owner, channel } = await unixProofFixture(t), file = join(state, 'run', channel.name);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  const first = await queryReloadProof({ state }, owner, { challenge: proofChallenge() }, 3000), second = await queryReloadProof({ state }, owner, { challenge: proofChallenge() }, 3000);
  assert.equal(first.status, 'OK'); assert.equal(first.snapshot.pid, process.pid); assert.notEqual(first.challenge, second.challenge);
  await assert.rejects(queryReloadProof({ state }, { ...owner, nonce: 'c'.repeat(32) }, { challenge: proofChallenge() }, 3000));
  await channel.close(); assert.equal(await stat(file).catch(error => error.code), 'ENOENT');
});

test('real POSIX channel shutdown destroys stalled clients without waiting for a request', { skip: process.platform === 'win32' }, async t => {
  const { createConnection } = await import('node:net');
  const { state, channel } = await unixProofFixture(t), socket = createConnection(join(state, 'run', channel.name));
  socket.on('error', () => {}); await new Promise(resolvePromise => socket.once('connect', resolvePromise));
  const closed = new Promise(resolvePromise => socket.once('close', resolvePromise));
  channel.stopAdmission(); await channel.close(); await closed;
  assert.equal(socket.destroyed, true);
});

test('real POSIX channel refuses linked directories and preserves a foreign replacement on cleanup', { skip: process.platform === 'win32' }, async t => {
  const { unlink } = await import('node:fs/promises');
  const { state, owner, channel } = await unixProofFixture(t, { allowReplaced: true }), file = join(state, 'run', channel.name);
  await unlink(file); await writeFile(file, 'unit-only-foreign-replacement', { mode: 0o600, flag: 'wx' });
  await assert.rejects(channel.close(), /SOCKET_REPLACED/);
  assert.equal(await readFile(file, 'utf8'), 'unit-only-foreign-replacement');
  // The failed close is deliberately retained for recovery and its handle is unref'd.
  const target = join(state, 'linked-run'); await mkdir(target, { mode: 0o700 });
  await rm(join(state, 'run'), { recursive: true, force: true }); await symlink(target, join(state, 'run'));
  await assert.rejects(openReloadProofChannel({ state }, owner, async () => ({ status: 'BUSY', snapshot: null })), /DIRECTORY/);
});

test('three held publications plus four preaccepted clients can reserve only four observation slots', () => {
  const held = new Set();
  for (let index = 0; index < 3; index++) reserveReloadProofObservation(held, { unitOnly: `timed-out-but-still-pending-${index}` });
  const preaccepted = Array.from({ length: 4 }, (_, index) => ({ unitOnly: `already-connected-${index}` }));
  reserveReloadProofObservation(held, preaccepted[0]);
  for (const socket of preaccepted.slice(1)) assert.throws(() => reserveReloadProofObservation(held, socket), /CAPACITY/);
  assert.equal(held.size, 4);
  held.delete(preaccepted[0]); reserveReloadProofObservation(held, preaccepted[1]);
  assert.equal(held.size, 4, 'Completion releases only one slot for a later actual request.');
});
