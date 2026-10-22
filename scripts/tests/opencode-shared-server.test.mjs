import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureSharedServer } from '../../deploy/docker/opencode-shared-server.mjs';

// VM218 2026-10-20: two OpenCode panes started together in the Getting Started room; each ran its own --standalone server on
// the shared provider store and the second died ("Standalone server exited before reporting readiness"). The fake below
// behaves the same way: one server per store, a second one exits; /api/info answers with the server's Basic auth.
const fakeOpenCode = `#!/usr/bin/env node
const { mkdirSync, writeFileSync, readFileSync, appendFileSync } = require('node:fs');
const http = require('node:http');
const args = process.argv.slice(2);
const data = process.env.XDG_DATA_HOME;
appendFileSync(data + '/calls.log', args.join(' ') + '\\n');
if (args[0] !== 'serve') process.exit(2);
const lock = data + '/store.lock';
try { mkdirSync(lock); } catch { try { process.kill(Number(readFileSync(lock + '/pid', 'utf8')), 0); console.error('Error: Standalone server exited before reporting readiness'); process.exit(1); } catch {} }
writeFileSync(lock + '/pid', String(process.pid));
const expected = 'Basic ' + Buffer.from('opencode:' + process.env.OPENCODE_SERVER_PASSWORD).toString('base64');
http.createServer((req, res) => { res.statusCode = req.headers.authorization === expected && req.url === '/api/info' ? 200 : 401; res.end('{}'); })
  .listen(Number(args[args.indexOf('--port') + 1]), args[args.indexOf('--hostname') + 1]);
`;

async function freePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'spaceapp-shared-server-'));
  const bin = join(root, 'bin');
  const env = { PATH: `${bin}:${process.env.PATH}`, XDG_DATA_HOME: join(root, 'data'), XDG_STATE_HOME: join(root, 'state'),
    XDG_CONFIG_HOME: join(root, 'config'), OPENCODE_API_KEY: '' };
  for (const dir of [bin, env.XDG_DATA_HOME, env.XDG_STATE_HOME, join(env.XDG_CONFIG_HOME, 'opencode')]) await import('node:fs/promises').then((fs) => fs.mkdir(dir, { recursive: true }));
  await writeFile(join(bin, 'opencode'), fakeOpenCode);
  await chmod(join(bin, 'opencode'), 0o755);
  const port = await freePort();
  const pids = new Set();
  const ensure = async (overrides = {}) => { const server = await ensureSharedServer({ env: { ...env, ...overrides }, port, timeoutMs: 15_000 }); pids.add(server.pid); return server; };
  const serves = async () => (await readFile(join(env.XDG_DATA_HOME, 'calls.log'), 'utf8')).split('\n').filter((line) => line.startsWith('serve')).length;
  const close = async () => { for (const pid of pids) { try { process.kill(pid); } catch {} } await rm(root, { recursive: true, force: true }); };
  return { env, port, ensure, serves, close };
}

test('two pane starts at the same moment on one home attach to one shared server', async () => {
  const f = await fixture();
  try {
    const [first, second, third] = await Promise.all([f.ensure(), f.ensure(), f.ensure()]);
    assert.equal(first.url, `http://127.0.0.1:${f.port}`);
    assert.deepEqual([second.url, third.url], [first.url, first.url]);
    assert.equal(first.pid, second.pid);
    assert.equal(first.username, 'opencode');
    assert.match(first.password, /^[a-f0-9]{64}$/);
    assert.equal(await f.serves(), 1);
    // The password stays in the provider's state folder, readable only by the CLI user.
    const saved = await import('node:fs/promises').then((fs) => fs.stat(join(f.env.XDG_STATE_HOME, 'opencode', 'spaceapp-shared-server.json')));
    assert.equal(saved.mode & 0o777, 0o600);
  } finally { await f.close(); }
});

test('a dead shared server is started again by the next pane start', async () => {
  const f = await fixture();
  try {
    const first = await f.ensure();
    process.kill(first.pid, 'SIGKILL');
    await new Promise((resolve) => setTimeout(resolve, 300));
    const next = await f.ensure();
    assert.notEqual(next.pid, first.pid);
    assert.equal(next.url, first.url);
    assert.equal(await f.serves(), 2);
  } finally { await f.close(); }
});

test('a recorded PID that another process now has is never stopped (1.1.7 review: the record survives a container restart)', async () => {
  const f = await fixture();
  const { spawn } = await import('node:child_process');
  const other = spawn('sleep', ['300'], { stdio: 'ignore' });
  try {
    await import('node:fs/promises').then((fs) => fs.mkdir(join(f.env.XDG_STATE_HOME, 'opencode'), { recursive: true }));
    await writeFile(join(f.env.XDG_STATE_HOME, 'opencode', 'spaceapp-shared-server.json'),
      JSON.stringify({ pid: other.pid, port: f.port, fingerprint: 'from-before-the-restart', password: 'x'.repeat(64) }), { mode: 0o600 });
    const server = await f.ensure();
    assert.notEqual(server.pid, other.pid);
    assert.equal(await f.serves(), 1);
    assert.equal(other.exitCode, null);
    assert.equal(other.signalCode, null);
    process.kill(other.pid, 0);
  } finally { other.kill('SIGKILL'); await f.close(); }
});

test('changed OpenCode credentials or config restart the shared server; an unchanged start reuses it', async () => {
  const f = await fixture();
  try {
    const first = await f.ensure();
    assert.equal((await f.ensure()).pid, first.pid);
    const rekeyed = await f.ensure({ OPENCODE_API_KEY: 'changed' });
    assert.notEqual(rekeyed.pid, first.pid);
    await writeFile(join(f.env.XDG_CONFIG_HOME, 'opencode', 'opencode.json'), '{"model":"opencode/other-free"}');
    const reconfigured = await f.ensure({ OPENCODE_API_KEY: 'changed' });
    assert.notEqual(reconfigured.pid, rekeyed.pid);
    assert.equal(await f.serves(), 3);
  } finally { await f.close(); }
});

test('the wrapper attaches pane TUIs to the shared server; other OpenCode commands stay --standalone', async () => {
  const wrapper = await readFile(new URL('../../deploy/docker/public-cli-wrapper.sh', import.meta.url), 'utf8');
  const launch = wrapper.slice(wrapper.indexOf('# OpenCode 2 starts a per-user background service'));
  // A pane launch is a fresh TUI or a resumed one; subcommands (run, api, auth, models, serve) keep --standalone.
  assert.match(launch, /""\|--continue\|-c\) opencode_pane=1 ;;/);
  assert.match(launch, /\*\) set -- "\$@" --standalone ;;/);
  assert.match(launch, /node \/app\/deploy\/docker\/opencode-shared-server\.mjs/);
  assert.match(launch, /set -- --server "\$server_url" "\$@" "\$PWD"/);
  assert.ok(launch.indexOf('opencode-shared-server.mjs') > launch.indexOf('opencode-first-run.mjs'), 'the server starts after the first-run model choice');
});

test('every OpenCode the CLI image starts has its own update check off (1.1.7 devtest: its dialog took a pane\'s first prompt)', async () => {
  const wrapper = await readFile(new URL('../../deploy/docker/public-cli-wrapper.sh', import.meta.url), 'utf8');
  const opencodeCase = wrapper.slice(wrapper.indexOf('\n  opencode)'), wrapper.indexOf(';;', wrapper.indexOf('\n  opencode)')));
  assert.match(opencodeCase, /^\s+export OPENCODE_DISABLE_AUTOUPDATE=true$/m, 'the opencode case exports it before any OpenCode starts');
  // Updates are run-spaceapp's job: no other case or path turns OpenCode's own update back on.
  assert.doesNotMatch(wrapper, /OPENCODE_DISABLE_AUTOUPDATE=(?!true\b)/);
  assert.doesNotMatch(wrapper, /unset OPENCODE_DISABLE_AUTOUPDATE/);
});
