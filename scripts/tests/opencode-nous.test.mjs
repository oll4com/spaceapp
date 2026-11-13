import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { main, nousConfig, nousRequest, openCodeOutputReader, paneModel } from '../../deploy/docker/opencode-nous.mjs';

const token = 'tok_0123456789abcdefghij'; // synthetic MCP token; gitleaks:allow
const turn = (extra = {}) => ({ prompt: 'What waits?', system: 'You are Nous.', mcpUrl: 'http://spaceapp-core:4911/api/cli/nous/mcp', mcpToken: token, maxTurns: 40, ...extra });
const sink = () => { const chunks = []; return { chunks, stream: new Writable({ write(chunk, _encoding, done) { chunks.push(String(chunk)); done(); } }) }; };

test('a free-model Nous turn takes only a checked request and allows only Nous\'s tools, the token never in its config', () => {
  assert.deepEqual(nousRequest(turn({ stream: true })), { ...turn(), shell: false, stream: true });
  for (const request of [turn({ mcpUrl: 'http://evil.example/api/cli/other' }), turn({ mcpUrl: 'file:///api/cli/nous/mcp' }), turn({ mcpToken: 'short' }),
    turn({ maxTurns: 100 }), turn({ maxTurns: '40' }), turn({ prompt: ' ' }), turn({ system: 'x'.repeat(60_001) }), null]) {
    assert.equal(nousRequest(request), null, JSON.stringify(request)?.slice(0, 80));
  }
  const config = nousConfig(nousRequest(turn()));
  assert.deepEqual(config.permission, { '*': 'deny', 'space_nous_*': 'allow' });
  assert.equal(config.mcp.servers.space_nous.codemode, false);
  assert.equal(config.agent.nous.steps, 40);
  assert.ok(!JSON.stringify(config).includes(token));
  assert.equal(nousConfig(nousRequest(turn({ shell: true }))).permission.shell, 'allow');
});

test('the turn uses the model the Getting Started pane saved, else the first run\'s default', async () => {
  const root = await mkdtemp('/tmp/spaceapp-opencode-nous-');
  assert.equal(await paneModel(root), 'opencode/big-pickle');
  await mkdir(join(root, 'opencode'));
  await writeFile(join(root, 'opencode', 'opencode.json'), JSON.stringify({ model: 'opencode/minimax-m2.5-free' }));
  assert.equal(await paneModel(root), 'opencode/minimax-m2.5-free');
  // Only a free Zen model: a pane config pointing elsewhere does not move Nous onto a paid provider.
  await writeFile(join(root, 'opencode', 'opencode.json'), JSON.stringify({ model: 'anthropic/claude-sonnet-5-5' }));
  assert.equal(await paneModel(root), 'opencode/big-pickle');
});

test('OpenCode\'s events become Claude Code\'s stream-json, the last step\'s text is the answer and errors end as an error result', () => {
  const out = [];
  const reader = openCodeOutputReader({ stream: true }, 'opencode/big-pickle', (record) => out.push(record));
  reader.push('{"type":"step_start"}\n{"type":"text","part":{"text":"Checking."}}\n{"type":"step_finish","part":{"tokens":{"input":10,"output":2,"reasoning":1,"cache":{"read":4}}}}\n');
  reader.push('{"type":"step_start"}\n{"type":"text","part":{"text":"Two things wait."}}\n{"type":"step_fin');
  reader.push('ish","part":{"tokens":{"input":20,"output":5}}}\n');
  assert.deepEqual(out.filter((record) => record.event?.type === 'content_block_delta').map((record) => record.event.delta.text), ['Checking.', 'Two things wait.']);
  assert.deepEqual(reader.finish(0), { type: 'result', provider: 'opencode', subtype: 'success', is_error: false, result: 'Two things wait.', num_turns: 2,
    modelUsage: { 'opencode/big-pickle': { inputTokens: 30, outputTokens: 8, cacheReadInputTokens: 4 } } });
  const failed = openCodeOutputReader({ stream: false }, 'opencode/big-pickle', () => assert.fail('no drafts without stream'));
  failed.push('{"type":"text","part":{"text":"x"}}\n{"type":"error","error":{"data":{"message":"Free usage limit reached"}}}\n');
  assert.equal(failed.finish(1).result, 'Free usage limit reached');
  assert.equal(openCodeOutputReader({}, 'm', () => {}).finish(0).result, 'OpenCode gave no answer.');
});

test('a turn serves Nous\'s tools privately, waits for them, streams the answer and leaves nothing behind', async () => {
  const root = await mkdtemp('/tmp/spaceapp-opencode-nous-');
  const tmp = join(root, 'tmp');
  await mkdir(tmp);
  const bin = join(root, 'opencode');
  // The fake OpenCode: `serve` answers /api/mcp as connected once asked with its password; `run` reports what it got as events.
  await writeFile(bin, `#!/usr/bin/env node
const { readFileSync } = require('node:fs');
const [mode, ...args] = process.argv.slice(2);
if (mode === 'serve') {
  require('node:http').createServer((req, res) => {
    const ok = req.headers.authorization === 'Basic ' + Buffer.from('opencode:' + process.env.OPENCODE_SERVER_PASSWORD).toString('base64');
    res.end(JSON.stringify({ data: ok ? [{ name: 'space_nous', status: { status: 'connected' } }] : [] }));
  }).listen(0, '127.0.0.1', function () { console.log('opencode server listening on http://127.0.0.1:' + this.address().port); });
} else {
  const config = readFileSync(process.env.XDG_CONFIG_HOME + '/opencode/opencode.json', 'utf8');
  const report = { args, token: process.env.SPACE_NOUS_MCP_TOKEN, config, cwd: process.cwd(), stdin: readFileSync(0, 'utf8') };
  console.log(JSON.stringify({ type: 'step_start' }));
  console.log(JSON.stringify({ type: 'text', part: { text: JSON.stringify(report) } }));
  console.log(JSON.stringify({ type: 'step_finish', part: { tokens: { input: 1, output: 1 } } }));
}
`);
  await chmod(bin, 0o755);
  const { chunks, stream } = sink();
  const code = await main(JSON.stringify(turn({ stream: true })), { env: { PATH: process.env.PATH, TMPDIR: tmp }, out: stream, binary: bin });
  const records = chunks.join('').trim().split('\n').map((line) => JSON.parse(line));
  const result = records.at(-1);
  assert.equal(code, 0, result.result);
  assert.equal(result.subtype, 'success');
  const report = JSON.parse(result.result);
  assert.deepEqual(report.args, ['--server', report.args[1], '--format', 'json', '--agent', 'nous', '--title', 'Space Nous', '--model', 'opencode/big-pickle']);
  assert.equal(report.token, token);
  assert.equal(report.stdin, 'What waits?');
  assert.ok(!report.config.includes(token));
  assert.ok(records.some((record) => record.event?.type === 'content_block_delta'));
  assert.deepEqual(await readdir(tmp), []);
});
