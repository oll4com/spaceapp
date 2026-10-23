import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installLogin } from '../../deploy/docker/credential-install.mjs';
import { startCredentialAgent } from '../../deploy/docker/credential-agent.mjs';

const login = JSON.stringify({ tokens: { refresh_token: 'synthetic-refresh-token' } });
const payload = (files, conflict) => JSON.stringify({ files: Object.fromEntries(Object.entries(files).map(([name, text]) => [name, Buffer.from(text).toString('base64')])), conflict });

test('writes a login 0600 in a 0700 home and keeps a 0600 backup of the one it replaces', async () => {
  const root = await mkdtemp(join(tmpdir(), 'spaceapp-login-'));
  assert.equal(await installLogin('gemini', root, payload({ 'oauth_creds.json': login }, 'backup-and-replace')), 'IMPORTED');
  const file = join(root, '.gemini', 'oauth_creds.json');
  assert.equal(await readFile(file, 'utf8'), login);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.equal((await stat(join(root, '.gemini'))).mode & 0o777, 0o700);

  assert.equal(await installLogin('gemini', root, payload({ 'oauth_creds.json': '{"old":true}' }, 'skip-if-logged-in')), 'SKIPPED already-logged-in');
  const answer = await installLogin('gemini', root, payload({ 'oauth_creds.json': '{"new":true}' }, 'backup-and-replace'));
  const backup = answer.match(/^IMPORTED backup=(\S+)$/)?.[1];
  assert.ok(backup);
  assert.equal(await readFile(backup, 'utf8'), login);
  assert.equal((await stat(backup)).mode & 0o777, 0o600);
  assert.equal(await readFile(file, 'utf8'), '{"new":true}');
});

test('a Claude login also marks Claude Code onboarded, keeping its other settings', async () => {
  const root = await mkdtemp(join(tmpdir(), 'spaceapp-login-'));
  assert.equal(await installLogin('claude', root, payload({ '.credentials.json': login })), 'IMPORTED');
  assert.deepEqual(JSON.parse(await readFile(join(root, '.claude.json'), 'utf8')), { hasCompletedOnboarding: true });
  assert.equal((await stat(join(root, '.claude.json'))).mode & 0o777, 0o600);
  await writeFile(join(root, '.claude.json'), JSON.stringify({ userID: 'kept', hasCompletedOnboarding: false }), { mode: 0o600 });
  await installLogin('claude', root, payload({ '.credentials.json': login }));
  assert.deepEqual(JSON.parse(await readFile(join(root, '.claude.json'), 'utf8')), { userID: 'kept', hasCompletedOnboarding: true });
  // Other CLIs keep their settings untouched.
  const codex = await mkdtemp(join(tmpdir(), 'spaceapp-login-'));
  await installLogin('codex', codex, payload({ 'auth.json': login }));
  assert.deepEqual(await readdir(codex), ['auth.json']);
});

test('rejects unknown runtimes, file names outside the allowlist and damaged logins without writing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'spaceapp-login-'));
  assert.equal(await installLogin('hermes', root, payload({ 'auth.json': login })), 'FAILED not-supported-on-target');
  assert.equal(await installLogin('__proto__', root, payload({ 'auth.json': login })), 'FAILED not-supported-on-target');
  for (const name of ['../../.ssh/authorized_keys', '/etc/passwd', 'config.toml']) {
    assert.equal(await installLogin('codex', root, payload({ 'auth.json': login, [name]: 'x' })), 'FAILED rejected-file-name');
  }
  assert.equal(await installLogin('codex', root, payload({ 'auth.json': 'not json' })), 'FAILED unreadable-login-file');
  assert.equal(await installLogin('codex', root, 'not json'), 'FAILED unreadable-login-file');
  assert.equal(await installLogin('codex', root, payload({ 'auth.json': login }, 'overwrite-anything')), 'FAILED bad-request');
  assert.deepEqual(await readdir(root), []);
});

test('refuses to replace a login that is not a regular file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'spaceapp-login-'));
  await mkdir(join(root, 'auth.json'));
  assert.equal(await installLogin('codex', root, payload({ 'auth.json': login })), 'FAILED not-a-regular-file');
});

test('the command reads stdin and answers with one line', async () => {
  const root = await mkdtemp(join(tmpdir(), 'spaceapp-login-'));
  const script = new URL('../../deploy/docker/credential-install.mjs', import.meta.url);
  const out = execFileSync(process.execPath, [script.pathname, 'claude', root], { input: payload({ '.credentials.json': login }), encoding: 'utf8' });
  assert.equal(out, 'IMPORTED\n');
  assert.equal(await readFile(join(root, '.credentials.json'), 'utf8'), login);
});

test('the public wrapper routes credential-install to the installer with its own home', () => {
  const wrapper = readFileSync(new URL('../../deploy/docker/public-cli-wrapper.sh', import.meta.url), 'utf8');
  assert.match(wrapper, /credential-install\)\n[\s\S]*?exec node \/app\/deploy\/docker\/credential-install\.mjs "\$runtime_name" "\$state_root"/);
});

const ask = (socketPath, body) => new Promise((resolve, reject) => {
  let answer = '';
  const socket = connect(socketPath, () => socket.end(typeof body === 'string' ? body : JSON.stringify(body)));
  socket.setEncoding('utf8').on('data', (chunk) => { answer += chunk; }).on('error', reject).on('close', () => resolve(JSON.parse(answer)));
});

test('the credential agent runs only a wrapper\'s fixed credential actions, input on stdin', async () => {
  // Short path: Unix socket paths are limited to about 100 bytes.
  const root = await mkdtemp('/tmp/spaceapp-agent-');
  for (const name of ['codex-vscode-parity', 'opencode-vscode-parity']) {
    await writeFile(join(root, name), `#!/bin/sh
printf "%s %s\\n" "$1" "$(wc -c | tr -d '[:space:]')"
`);
    await chmod(join(root, name), 0o755);
  }
  const socketPath = join(root, 'credentials.sock');
  const server = await startCredentialAgent({ socketPath, commandPath: root });
  try {
    assert.equal((await stat(socketPath)).mode & 0o777, 0o660);
    assert.deepEqual(await ask(socketPath, { command: 'codex-vscode-parity', action: 'credential-status' }), { exitCode: 0, stdout: 'credential-status 0\n' });
    assert.deepEqual(await ask(socketPath, { command: 'codex-vscode-parity', action: 'credential-install', input: '{"files":{}}' }), { exitCode: 0, stdout: 'credential-install 12\n' });
    // 1.1.7 (decision B): the core image has no CLIs, so the smoke and the API's OpenCode calls run here too.
    assert.deepEqual(await ask(socketPath, { command: 'codex-vscode-parity', action: 'credential-smoke' }), { exitCode: 0, stdout: 'credential-smoke 0\n' });
    assert.deepEqual(await ask(socketPath, { command: 'opencode-vscode-parity', action: 'credential-observation' }), { exitCode: 0, stdout: 'credential-observation 0\n' });
    assert.deepEqual(await ask(socketPath, { command: 'opencode-vscode-parity', action: 'opencode-text', input: '{"prompt":"hi"}' }), { exitCode: 0, stdout: 'opencode-text 15\n' });
    assert.deepEqual(await ask(socketPath, { command: 'opencode-vscode-parity', action: 'opencode-models', input: '{"provider":"opencode"}' }), { exitCode: 0, stdout: 'opencode-models 23\n' });
    for (const body of [
      { command: '../codex-vscode-parity', action: 'credential-status' },
      { command: 'codex', action: 'credential-status' },
      { command: 'codex-vscode-parity', action: 'login' },
      { command: 'codex-vscode-parity', action: 'credential-status', input: 'unexpected' },
      { command: 'codex-vscode-parity', action: 'credential-smoke', input: 'unexpected' },
      { command: 'opencode-vscode-parity', action: 'credential-observation', input: 'unexpected' },
      { command: 'codex-vscode-parity', action: 'credential-status', extra: 'field' },
      { command: 'codex-vscode-parity', action: 'opencode-text', input: '{}' },
      { command: 'opencode-vscode-parity', action: 'opencode-text', input: 'x'.repeat(128 * 1024 + 1) },
      { command: 'opencode-vscode-parity', action: 'opencode-models', input: 'x'.repeat(257) },
      { command: 'opencode-vscode-parity', action: 'toString' },
      'not json'
    ]) {
      assert.deepEqual(await ask(socketPath, body), { exitCode: 64, stdout: 'FAILED bad-request\n' });
    }
  } finally {
    server.close();
  }
  await writeFile(socketPath, 'not a socket');
  await assert.rejects(() => startCredentialAgent({ socketPath, commandPath: root }), /Refusing to replace non-socket path/);
});

test('the public wrapper runs the API\'s OpenCode calls only for OpenCode, through the standalone helper', () => {
  const wrapper = readFileSync(new URL('../../deploy/docker/public-cli-wrapper.sh', import.meta.url), 'utf8');
  const branch = wrapper.match(/\n  opencode-text\|opencode-models\)\n[\s\S]*?\n    ;;\n/)?.[0] ?? '';
  assert.match(branch, /if \[ "\$runtime_name" != "opencode" \]; then\n[^\n]*\n      exit 64\n    fi/);
  assert.match(branch, /exec node \/app\/deploy\/docker\/opencode-standalone\.mjs "\$\{1#opencode-\}"/);
  // Before the generic launch, which would start OpenCode's TUI.
  assert.ok(wrapper.indexOf(branch) < wrapper.indexOf('ensure_runtime_dirs\nensure_optional_provider'));
});

test('the CLI container starts the credential agent as the CLI user next to the pane host', () => {
  const entrypoint = readFileSync(new URL('../../deploy/docker/cli-entrypoint.sh', import.meta.url), 'utf8');
  assert.match(entrypoint, /credential_agent_user=spaceapp\nif \[ "\$\{SPACEAPP_CLI_HOST_ROOT_ACCESS:-false\}" = "true" \]; then\n  credential_agent_user=root:spaceapp\nfi\ngosu "\$credential_agent_user" node \/app\/deploy\/docker\/credential-agent\.mjs &\n/);
  assert.equal(entrypoint.match(/credential-agent\.mjs/g).length, 1);
});
