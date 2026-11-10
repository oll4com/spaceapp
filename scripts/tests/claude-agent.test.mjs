import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chmod, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { connect } from 'node:net';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { claudeAgentCommand, main, QUOTA_MESSAGE } from '../../deploy/docker/claude-agent.mjs';
import { startCredentialAgent } from '../../deploy/docker/credential-agent.mjs';

const token = 'tok_0123456789abcdefghij'; // synthetic MCP token; gitleaks:allow
const turn = (extra = {}) => ({ model: 'claude-sonnet-5-5', effort: 'medium', prompt: 'What waits?', system: 'You are Nous.', mcpUrl: 'http://spaceapp-core:4911/api/cli/nous/mcp', mcpToken: token, maxTurns: 40, ...extra });
const sink = () => { const chunks = []; return { chunks, stream: new Writable({ write(chunk, _encoding, done) { chunks.push(String(chunk)); done(); } }) }; };

test('a Nous turn runs only Nous\'s tools, the token never in the process list; the pane board runs none', () => {
  const tools = claudeAgentCommand('tools', turn({ stream: true }));
  assert.deepEqual(tools.args, ['--print', '--no-session-persistence', '--strict-mcp-config', '--model', 'claude-sonnet-5-5', '--effort', 'medium',
    '--tools', '', '--allowedTools', 'mcp__space_nous', '--max-turns', '40', '--output-format', 'stream-json', '--include-partial-messages', '--verbose',
    '--append-system-prompt', 'You are Nous.']);
  assert.equal(tools.stdin, 'What waits?');
  assert.ok(!tools.args.some((arg) => arg.includes(token)));
  assert.deepEqual(tools.mcpConfig, { mcpServers: { space_nous: { type: 'http', url: 'http://spaceapp-core:4911/api/cli/nous/mcp', headers: { Authorization: `Bearer ${token}` } } } });
  const shell = claudeAgentCommand('tools', turn({ shell: true, fallbackModel: 'claude-haiku-5-5' }));
  assert.deepEqual(shell.args.slice(7, 11), ['--tools', 'Bash', '--allowedTools', 'mcp__space_nous Bash']);
  assert.ok(shell.args.includes('--output-format') && shell.args[shell.args.indexOf('--output-format') + 1] === 'json');
  assert.equal(shell.args[shell.args.indexOf('--fallback-model') + 1], 'claude-haiku-5-5');
  // Space 1.2's persona and shell note are 20,804 characters (the 1.2.0 lab: every turn was refused at the old 20,000).
  assert.ok(claudeAgentCommand('tools', turn({ system: 'x'.repeat(20_804) })));
  assert.ok(claudeAgentCommand('tools', turn({ system: 'ν'.repeat(60_000) })));
  const chat = claudeAgentCommand('chat', { model: 'claude-haiku-5-5', effort: 'low', prompt: 'Summarize.' });
  assert.deepEqual(chat.args.slice(7), ['--tools', '', '--output-format', 'text', '--max-turns', '1']);
  assert.equal(chat.mcpConfig, undefined);
  for (const [mode, request] of [
    ['tools', turn({ mcpUrl: 'http://evil.example/api/cli/other' })],
    ['tools', turn({ mcpUrl: 'file:///api/cli/nous/mcp' })],
    ['tools', turn({ mcpToken: 'short' })],
    ['tools', turn({ mcpToken: `${token} --dangerously-skip-permissions` })],
    ['tools', turn({ maxTurns: 100 })],
    ['tools', turn({ maxTurns: '40' })],
    ['tools', turn({ model: '--model x' })],
    ['tools', turn({ effort: 'ultra' })],
    ['tools', turn({ fallbackModel: '' })],
    ['tools', turn({ prompt: ' ' })],
    ['tools', turn({ system: 'x'.repeat(60_001) })],
    ['chat', { model: 'claude-haiku-5-5', effort: 'low', prompt: 'x'.repeat(12_001) }],
    ['shell', turn()],
    ['tools', null]
  ]) assert.equal(claudeAgentCommand(mode, request), null, JSON.stringify(request)?.slice(0, 80));
});

test('a turn streams Claude Code\'s lines, writes its MCP config privately and removes it, and keeps no empty API key', async () => {
  const root = await mkdtemp('/tmp/spaceapp-claude-agent-');
  const bin = join(root, 'claude');
  // The fake Claude Code reports what it got: its MCP config, cwd, key and stdin, as stream-json lines.
  await writeFile(bin, `#!/bin/sh
config=""; while [ $# -gt 0 ]; do [ "$1" = "--mcp-config" ] && config="$2"; shift; done
printf '{"type":"system","config":%s,"mode":"%s"}\\n' "$(cat "$config")" "$(stat -c %a "$config")"
printf '{"type":"stream_event","cwd":"%s","key":"%s","stdin":"%s"}\\n' "$PWD" "\${ANTHROPIC_API_KEY-unset}" "$(cat)"
printf '{"type":"result","result":"done"}\\n'
`);
  await chmod(bin, 0o755);
  const out = sink();
  const err = sink();
  const code = await main('tools', JSON.stringify(turn({ stream: true })), bin, { env: { PATH: process.env.PATH, HOME: root, TMPDIR: root, ANTHROPIC_API_KEY: '' }, out: out.stream, err: err.stream });
  assert.equal(code, 0, err.chunks.join(''));
  const lines = out.chunks.join('').trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(lines[0].config.mcpServers.space_nous.headers, { Authorization: `Bearer ${token}` });
  assert.equal(lines[0].mode, '600');
  assert.deepEqual(lines[1], { type: 'stream_event', cwd: join(root, 'nous'), key: 'unset', stdin: 'What waits?' });
  assert.deepEqual(lines[2], { type: 'result', result: 'done' });
  assert.deepEqual((await readdir(root)).sort(), ['claude', 'nous']);
  assert.equal(await main('tools', '{"model":', bin, { env: { HOME: root }, out: out.stream, err: err.stream }), 64);
});

test('only a failed turn is a quota stop', async () => {
  const root = await mkdtemp('/tmp/spaceapp-claude-agent-');
  const run = async (script, mode = 'tools', request = turn({ stream: true })) => {
    await writeFile(join(root, 'claude'), `#!/bin/sh\ncat >/dev/null\n${script}\n`);
    await chmod(join(root, 'claude'), 0o755);
    const out = sink();
    const err = sink();
    const code = await main(mode, JSON.stringify(request), join(root, 'claude'), { env: { PATH: process.env.PATH, HOME: root, TMPDIR: root }, out: out.stream, err: err.stream });
    return { code, out: out.chunks.join(''), err: err.chunks.join('') };
  };
  assert.deepEqual(await run('echo "You\'ve hit your usage limit · resets 3pm" >&2; exit 1'), { code: 1, out: '', err: `${QUOTA_MESSAGE}\n` });
  assert.deepEqual(await run('printf \'{"type":"result","is_error":true,"result":"Credit balance is too low"}\\n\'; exit 1'),
    { code: 1, out: '{"type":"result","is_error":true,"result":"Credit balance is too low"}\n', err: `${QUOTA_MESSAGE}\n` });
  // A finished turn may quote a pane's report.
  assert.equal((await run('printf \'{"type":"result","result":"Oscar hit its Claude usage limit"}\\n\'')).code, 0);
  assert.deepEqual(await run('echo "Invalid API key" >&2; exit 1'), { code: 1, out: '', err: 'Invalid API key\n' });
  // The pane board's answer is plain text, given only at the end.
  assert.deepEqual(await run('printf "One line."', 'chat', { model: 'claude-haiku-5-5', effort: 'low', prompt: 'Summarize.' }), { code: 0, out: 'One line.', err: '' });
});

/** Reads a streamed answer: the wrapper's bytes, then RS + the end record. The client keeps its side open, as the API does. */
const askStream = (socketPath, body, { closeAfter } = {}) => new Promise((resolve, reject) => {
  let answer = '';
  const socket = connect(socketPath, () => socket.write(`${JSON.stringify(body)}\n`));
  socket.setEncoding('utf8').on('data', (chunk) => {
    answer += chunk;
    if (closeAfter && answer.includes(closeAfter)) socket.end();
  }).on('error', reject).on('close', () => {
    const end = answer.lastIndexOf('\n\x1e');
    resolve(end < 0 ? { raw: answer } : { body: answer.slice(0, end), end: JSON.parse(answer.slice(end + 2)) });
  });
});

test('the credential agent streams a Nous turn, in its own slots, and stops it when the API leaves', async () => {
  const root = await mkdtemp('/tmp/spaceapp-agent-');
  await writeFile(join(root, 'claude-vscode-parity'), `#!/bin/sh
case "$1" in
  agent-tools)
    trap 'echo stopped > ${root}/stopped; exit 143' TERM
    printf 'line one\\n'; sleep 0.3; printf 'line two %s\\n' "$(cat)"; echo "warn" >&2
    if [ -e ${root}/hold ]; then sleep 30 & wait; fi
    exit 3 ;;
  agent-chat) printf 'board %s' "$(cat)" ;;
  credential-status) sleep 1; printf 'READY\\n' ;;
esac
`);
  await chmod(join(root, 'claude-vscode-parity'), 0o755);
  await writeFile(join(root, 'codex-vscode-parity'), '#!/bin/sh\nprintf "%s\\n" "$1"\n');
  await chmod(join(root, 'codex-vscode-parity'), 0o755);
  const socketPath = join(root, 'credentials.sock');
  const server = await startCredentialAgent({ socketPath, commandPath: root, maxConcurrent: 1, maxConcurrentAgent: 1 });
  try {
    const ask = (body) => new Promise((resolve, reject) => {
      let answer = '';
      const socket = connect(socketPath, () => socket.end(JSON.stringify(body)));
      socket.setEncoding('utf8').on('data', (chunk) => { answer += chunk; }).on('error', reject).on('close', () => resolve(JSON.parse(answer)));
    });
    // A busy credential slot does not hold a turn back.
    const slow = ask({ command: 'codex-vscode-parity', action: 'credential-status' });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.deepEqual(await askStream(socketPath, { command: 'claude-vscode-parity', action: 'agent-tools', input: '{"prompt":"p"}' }),
      { body: 'line one\nline two {"prompt":"p"}\n', end: { exitCode: 3, stderr: 'warn\n' } });
    assert.deepEqual(await slow, { exitCode: 0, stdout: 'credential-status\n' });
    assert.deepEqual(await ask({ command: 'claude-vscode-parity', action: 'agent-chat', input: 'x' }), { exitCode: 0, stdout: 'board x' });
    for (const body of [
      { command: 'codex-vscode-parity', action: 'agent-tools', input: '{}' },
      { command: 'claude-vscode-parity', action: 'agent-tools', input: 'x'.repeat(1024 * 1024 + 1) },
      { command: 'claude-vscode-parity', action: 'agent-chat', input: 'x'.repeat(64 * 1024 + 1) }
    ]) assert.deepEqual(await askStream(socketPath, body), { raw: `${JSON.stringify({ exitCode: 64, stdout: 'FAILED bad-request\n' })}\n` });
    // The API stops the turn: the agent stops the wrapper.
    await writeFile(join(root, 'hold'), '');
    const held = askStream(socketPath, { command: 'claude-vscode-parity', action: 'agent-tools', input: '{}' }, { closeAfter: 'line two' });
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.deepEqual(await askStream(socketPath, { command: 'claude-vscode-parity', action: 'agent-chat', input: 'x' }), { raw: `${JSON.stringify({ exitCode: 75, stdout: 'FAILED busy\n' })}\n` });
    const stopped = await held;
    assert.match(stopped.body, /^line one\nline two/);
    assert.equal(stopped.end.exitCode, 143);
    assert.equal(await readFile(join(root, 'stopped'), 'utf8'), 'stopped\n');
    // Its slot is free again.
    assert.deepEqual(await ask({ command: 'claude-vscode-parity', action: 'agent-chat', input: 'y' }), { exitCode: 0, stdout: 'board y' });
  } finally {
    server.close();
  }
});

test('the public wrapper runs Nous\'s turns only for a signed-in Claude Code, through the agent helper', () => {
  const wrapper = readFileSync(new URL('../../deploy/docker/public-cli-wrapper.sh', import.meta.url), 'utf8');
  const branch = wrapper.match(/\n  agent-tools\|agent-chat\)\n[\s\S]*?\n    ;;\n/)?.[0] ?? '';
  assert.match(branch, /if \[ "\$runtime_name" != "claude" \]; then\n[^\n]*\n      exit 64\n    fi/);
  assert.match(branch, /if ! credential_ready; then\n[^\n]*\n      exit 77\n    fi/);
  assert.match(branch, /ensure_optional_provider >&2\n    exec node \/app\/deploy\/docker\/claude-agent\.mjs "\$\{1#agent-\}" "\$command_name"/);
  // Before the generic launch, which would start Claude Code's TUI.
  assert.ok(wrapper.indexOf(branch) < wrapper.indexOf('ensure_runtime_dirs\nensure_optional_provider'));
});
