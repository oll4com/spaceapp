import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { answerOutput, isolatedEnvironment, main, opencodeCommand } from '../../deploy/docker/opencode-standalone.mjs';

const text = { modelId: 'opencode/big-pickle', prompt: 'Hello', timeoutMs: 45_000 };

test('the API\'s OpenCode requests run only --standalone, with bounded input', () => {
  assert.deepEqual(opencodeCommand('text', text).args, ['run', '--standalone', '--format', 'json', '--model', 'opencode/big-pickle', 'Hello']);
  assert.deepEqual(opencodeCommand('models', { provider: 'openrouter' }).args, ['api', 'GET', '/api/model', '--standalone']);
  for (const [mode, request] of [
    ['text', { ...text, prompt: 'x'.repeat(120 * 1024 + 1) }],
    ['text', { ...text, prompt: '' }],
    ['text', { ...text, modelId: '--help' }],
    ['text', { ...text, timeoutMs: 600_000 }],
    ['models', { provider: '../x' }],
    ['serve', {}]
  ]) assert.equal(opencodeCommand(mode, request), null, JSON.stringify(request).slice(0, 80));
});

test('a text answer reads no config, models read the owner\'s; neither opens the panes\' store', () => {
  const env = { PATH: '/usr/bin', XDG_CONFIG_HOME: '/var/lib/spaceapp-cli/providers/opencode/config', XDG_DATA_HOME: '/var/lib/spaceapp-cli/providers/opencode/data', OPENCODE_API_KEY: 'k' };
  const textEnv = isolatedEnvironment('text', '/tmp/s', env);
  const modelsEnv = isolatedEnvironment('models', '/tmp/s', env);
  assert.equal(textEnv.XDG_CONFIG_HOME, '/tmp/s/config');
  assert.equal(textEnv.OPENCODE_API_KEY, undefined);
  assert.equal(modelsEnv.XDG_CONFIG_HOME, env.XDG_CONFIG_HOME);
  for (const isolated of [textEnv, modelsEnv]) {
    assert.equal(isolated.OPENCODE_DISABLE_AUTOUPDATE, 'true');
    assert.equal(isolated.XDG_DATA_HOME, '/tmp/s/data');
    assert.equal(isolated.HOME, '/tmp/s');
  }
  assert.deepEqual(JSON.parse(answerOutput('models', JSON.stringify({ data: [{ id: 'a', providerID: 'opencode' }, { id: 'b', providerID: 'openrouter' }] }), 'opencode')),
    { data: [{ id: 'a', providerID: 'opencode' }] });
});

test('runs this container\'s opencode in a throwaway home and hands back its output', async () => {
  const bin = await mkdtemp(join(tmpdir(), 'spaceapp-fake-opencode-'));
  await writeFile(join(bin, 'opencode'), '#!/bin/sh\nprintf \'{"type":"text","part":{"text":"%s|%s"}}\\n\' "$*" "$XDG_DATA_HOME"\n');
  await chmod(join(bin, 'opencode'), 0o755);
  const path = process.env.PATH;
  process.env.PATH = `${bin}:${path}`;
  try {
    const answer = await main('text', JSON.stringify(text));
    assert.equal(answer.exitCode, 0);
    const [args, data] = JSON.parse(answer.stdout).part.text.split('|');
    assert.equal(args, 'run --standalone --format json --model opencode/big-pickle Hello');
    assert.match(data, /\/spaceapp-opencode-[^/]+\/data$/);
    assert.deepEqual(await main('text', 'not json'), { exitCode: 64, stdout: '' });
  } finally {
    process.env.PATH = path;
  }
});

test('a text answer runs with a config that denies every tool but read, at the default location', async () => {
  const bin = await mkdtemp(join(tmpdir(), 'spaceapp-fake-opencode-'));
  // The fake answers with whether a custom config path (refused by Zen) was set, then the config OpenCode 2 would load.
  await writeFile(join(bin, 'opencode'), '#!/bin/sh\necho "${OPENCODE_CONFIG:-default}"\ncat "$XDG_CONFIG_HOME/opencode/opencode.json" 2>/dev/null\n');
  await chmod(join(bin, 'opencode'), 0o755);
  const owner = await mkdtemp(join(tmpdir(), 'spaceapp-owner-config-'));
  const path = process.env.PATH, xdg = process.env.XDG_CONFIG_HOME;
  process.env.PATH = `${bin}:${path}`;
  process.env.XDG_CONFIG_HOME = owner;
  try {
    const answer = await main('text', JSON.stringify(text));
    assert.equal(answer.exitCode, 0);
    const [location, ...config] = answer.stdout.trim().split('\n');
    assert.equal(location, 'default');
    const { permission } = JSON.parse(config.join('\n'));
    assert.deepEqual(permission, { '*': 'deny', read: 'allow' });
    for (const tool of ['bash', 'execute', 'edit', 'write', 'webfetch', 'task']) assert.equal(permission[tool] ?? permission['*'], 'deny');
    await main('models', JSON.stringify({ provider: 'opencode' }));
    assert.deepEqual(await readdir(owner), [], 'models read the owner\'s config and get nothing written there');
  } finally {
    process.env.PATH = path;
    if (xdg === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = xdg;
  }
});
