#!/usr/bin/env node
// Nous on a public install (operator decision 2026-10-27, B+C3): the Space API (spaceapp-core) has no Claude Code. Through the
// credential agent and the Claude wrapper it runs Nous's headless turns here, on the owner's own Claude login. `tools`: one Nous
// turn whose only tools are Nous's (HTTP MCP back to core with that turn's token; Bash only when the owner's Shell setting is on).
// `chat`: one answer with no tool (the pane board). The request checks are the private launcher's (claude_tools_agent_chat,
// claude_agent_chat). No session is saved: Nous's turns never fill the owner's Claude history or disk.
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,159}$/;
const EFFORT = /^(?:low|medium|high|xhigh|max)$/;
const MCP_URL = /^https?:\/\/[A-Za-z0-9.-]+(?::\d{1,5})?\/api\/cli\/nous\/mcp$/;
const TOKEN = /^[A-Za-z0-9._-]{20,512}$/;
// Space's NOUS_SYSTEM_MAX_CHARS: the system text is one argument to Claude Code, and Linux caps one at 131,072 bytes.
const SYSTEM_MAX_CHARS = 60_000;
// How Claude Code says the account is out of quota (the launcher's claude_quota_limited); the API pauses Nous on QUOTA_MESSAGE.
const QUOTA = /insufficient|pre-consumed quota|quota (?:exhausted|exceeded|failed)|exceeded your (?:current )?quota|credit balance|usage limit|session limit|hit your (?:session|weekly|usage) limit/i;
export const QUOTA_MESSAGE = 'Claude Code has no available tokens/quota right now: the account quota is exhausted.';
const maxOutputBytes = { chat: 1024 * 1024, tools: 256 * 1024 };

/** Claude Code's arguments, stdin and limits for a request, or null when the request is not one this helper runs. */
export function claudeAgentCommand(mode, request) {
  const { model, effort, prompt } = request ?? {};
  if (typeof model !== 'string' || !MODEL.test(model) || typeof effort !== 'string' || !EFFORT.test(effort)) return null;
  const head = ['--print', '--no-session-persistence', '--strict-mcp-config', '--model', model, '--effort', effort];
  if (mode === 'chat') {
    if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 12_000) return null;
    // One turn cannot use a tool's result, so no built-in or MCP tool.
    return { args: [...head, '--tools', '', '--output-format', 'text', '--max-turns', '1'], stdin: prompt, timeoutMs: 600_000, stream: false };
  }
  if (mode !== 'tools') return null;
  const { system = '', mcpUrl, mcpToken, maxTurns, shell, stream, fallbackModel } = request;
  if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 400_000 || typeof system !== 'string' || system.length > SYSTEM_MAX_CHARS ||
      typeof mcpUrl !== 'string' || !MCP_URL.test(mcpUrl) || typeof mcpToken !== 'string' || !TOKEN.test(mcpToken) ||
      !Number.isInteger(maxTurns) || maxTurns < 1 || maxTurns > 99 ||
      (fallbackModel !== undefined && (typeof fallbackModel !== 'string' || !MODEL.test(fallbackModel)))) return null;
  return {
    args: [...head, '--tools', shell === true ? 'Bash' : '', '--allowedTools', shell === true ? 'mcp__space_nous Bash' : 'mcp__space_nous',
      '--max-turns', String(maxTurns),
      ...(stream === true ? ['--output-format', 'stream-json', '--include-partial-messages', '--verbose'] : ['--output-format', 'json']),
      ...(fallbackModel ? ['--fallback-model', fallbackModel] : []), ...(system ? ['--append-system-prompt', system] : [])],
    stdin: prompt, timeoutMs: 20 * 60_000, stream: stream === true,
    // The turn's token goes to a private file, never into the process list.
    mcpConfig: { mcpServers: { space_nous: { type: 'http', url: mcpUrl, headers: { Authorization: `Bearer ${mcpToken}` } } } }
  };
}

/** Runs Claude Code: streamed stdout passes through as it comes, a plain answer goes out at the end; resolves the exit code. */
function runClaude(bin, args, command, { cwd, env, out, err }) {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    const limit = command.stream ? Infinity : maxOutputBytes[command.mcpConfig ? 'tools' : 'chat'];
    let stdout = '';
    let tail = '';
    let stderr = '';
    let timedOut = false;
    const stop = () => { try { child.kill('SIGTERM'); } catch { /* gone */ } };
    const timer = setTimeout(() => { timedOut = true; stop(); setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, 5_000).unref(); }, command.timeoutMs);
    // The credential agent stops this helper when the API stops the turn; Claude Code goes with it.
    process.once('SIGTERM', stop);
    child.stdout.setEncoding('utf8').on('data', (chunk) => {
      tail = (tail + chunk).slice(-4_096);
      if (command.stream) out.write(chunk);
      else if ((stdout += chunk).length > limit) stop();
    });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr = (stderr + chunk).slice(-8_192); });
    child.stdin.on('error', () => undefined);
    child.stdin.end(command.stdin);
    let finished = false;
    const done = (code) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      process.off('SIGTERM', stop);
      const status = timedOut ? 124 : code ?? 1;
      // Only a failed run may say quota: a finished turn quotes pane reports ("hit its Claude usage limit").
      const lastLine = tail.trimEnd().split('\n').at(-1) ?? '';
      if (status !== 0 && (QUOTA.test(stderr) || QUOTA.test(command.stream ? lastLine : stdout))) {
        err.write(`${QUOTA_MESSAGE}\n`);
        resolve(1);
        return;
      }
      if (!command.stream && stdout.length <= limit) out.write(stdout);
      if (status !== 0 && stderr) err.write(stderr);
      resolve(status);
    };
    child.once('error', () => done(1));
    child.once('close', done);
    // A process a Bash tool left behind may hold stdout open: the turn ends 2 s after Claude Code did.
    child.once('exit', (code) => setTimeout(() => done(code), 2_000).unref());
  });
}

export async function main(mode, input, bin, { env = process.env, out = process.stdout, err = process.stderr } = {}) {
  let request = null;
  try { request = JSON.parse(input); } catch { /* refused below */ }
  const command = claudeAgentCommand(mode, request);
  if (!command || typeof bin !== 'string' || !bin) {
    err.write('Invalid Nous request.\n');
    return 64;
  }
  // An empty key would hide the owner's subscription login.
  const childEnv = { ...env };
  if (!childEnv.ANTHROPIC_API_KEY) delete childEnv.ANTHROPIC_API_KEY;
  const cwd = join(env.HOME || tmpdir(), 'nous');
  await mkdir(cwd, { recursive: true, mode: 0o700 });
  const scratch = await mkdtemp(join(env.TMPDIR || tmpdir(), 'spaceapp-claude-agent-'));
  try {
    let args = command.args;
    if (command.mcpConfig) {
      const file = join(scratch, 'mcp.json');
      await writeFile(file, JSON.stringify(command.mcpConfig), { mode: 0o600 });
      args = ['--mcp-config', file, ...args];
    }
    return await runClaude(bin, args, command, { cwd, env: childEnv, out, err });
  } finally {
    await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function readStdin() {
  let text = '';
  for await (const chunk of process.stdin) {
    text += chunk;
    if (text.length > 1024 * 1024) throw new Error('request too large');
  }
  return text;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  readStdin().then((input) => main(process.argv[2], input, process.argv[3])).then((code) => { process.exitCode = code; }, () => { process.exitCode = 1; });
}
