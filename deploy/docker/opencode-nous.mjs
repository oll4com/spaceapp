#!/usr/bin/env node
// Nous on a public install with no Claude Code signed in (Nous 13/11, goal 401b115b criterion 3): one Nous turn on the free OpenCode
// model the Getting Started pane uses (opencode-first-run.mjs saves it in this wrapper's config). A private `opencode serve` in a
// throwaway home exposes only Nous's tools (HTTP MCP back to core with the turn's token; the shell only when the owner's Shell setting
// is on); its events go out as Claude Code's stream-json, which the API already reads. Space's scripts/space-opencode-nous-turn.mjs
// without its gateway proxy: the free model needs no key, and nothing of the panes' store, sessions or logins is opened.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_FREE_MODEL } from './opencode-first-run.mjs';

const MCP_URL = /^https?:\/\/[A-Za-z0-9.-]+(?::\d{1,5})?\/api\/cli\/nous\/mcp$/;
const TOKEN = /^[A-Za-z0-9._-]{20,512}$/;
const FREE_MODEL = /^opencode\/[a-z0-9][a-z0-9._-]{0,100}$/;
// Space's NOUS_SYSTEM_MAX_CHARS, as in claude-agent.mjs.
const SYSTEM_MAX_CHARS = 60_000;
// The longest event line read: a tool event can carry a long tool answer, only the answer text matters here.
const MAX_LINE = 256 * 1024;
// The credential agent stops the action at 21 minutes; the turn ends first with its own message.
const TURN_MS = 20 * 60_000;

/** The checked request, or null when it is not one this helper runs. */
export function nousRequest(raw) {
  const { system = '', prompt, mcpUrl, mcpToken, maxTurns, shell, stream } = raw ?? {};
  if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 400_000 || typeof system !== 'string' || system.length > SYSTEM_MAX_CHARS ||
      typeof mcpUrl !== 'string' || !MCP_URL.test(mcpUrl) || typeof mcpToken !== 'string' || !TOKEN.test(mcpToken) ||
      !Number.isInteger(maxTurns) || maxTurns < 1 || maxTurns > 99) return null;
  return { system, prompt, mcpUrl, mcpToken, maxTurns, shell: shell === true, stream: stream === true };
}

/** The Getting Started pane's model: what the first run saved in this wrapper's config, else the first run's default. */
export async function paneModel(configHome) {
  const saved = configHome ? JSON.parse(await readFile(join(configHome, 'opencode', 'opencode.json'), 'utf8').catch(() => '{}'))?.model : null;
  return typeof saved === 'string' && FREE_MODEL.test(saved) ? saved : DEFAULT_FREE_MODEL;
}

/** OpenCode's whole configuration for one turn. A remote server outside Code Mode, so each Nous tool is its own tool. */
export function nousConfig(request) {
  return {
    autoupdate: false, share: 'disabled', instructions: [], plugin: [],
    // The token comes from the environment, never this file.
    mcp: { servers: { space_nous: { type: 'remote', url: request.mcpUrl, headers: { Authorization: 'Bearer {env:SPACE_NOUS_MCP_TOKEN}' }, enabled: true, oauth: false, codemode: false, timeout: 60_000 } } },
    // Zen refuses its free tier ("Free usage limit reached") to a request with none of OpenCode's own tools (hz lab 13/11): read stays,
    // confined to the turn's empty work folder by external_directory.
    permission: { '*': 'deny', read: 'allow', external_directory: 'deny', 'space_nous_*': 'allow', ...(request.shell ? { shell: 'allow' } : {}) },
    agent: { nous: { mode: 'primary', prompt: '{file:./system.md}', steps: request.maxTurns } }
  };
}

/** `opencode run --format json` events as Claude Code's stream-json: drafts while it runs, then one result record. */
export function openCodeOutputReader(request, model, emit) {
  let pending = '';
  let answer = '';
  let step = [];
  let steps = 0;
  let failure = null;
  const usage = { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0 };
  const count = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
  const line = (value) => {
    let event;
    try { event = JSON.parse(value); } catch { return; }
    const part = event?.part ?? {};
    if (event?.type === 'step_start') step = [];
    if (event?.type === 'text' && typeof part.text === 'string') {
      step.push(part.text);
      if (request.stream) {
        emit({ type: 'stream_event', event: { type: 'message_start' } });
        emit({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: part.text } } });
      }
    }
    if (event?.type === 'step_finish') {
      steps += 1;
      if (step.length) answer = step.join('\n\n');
      const tokens = part.tokens ?? {};
      usage.inputTokens += count(tokens.input); usage.outputTokens += count(tokens.output) + count(tokens.reasoning); usage.cacheReadInputTokens += count(tokens.cache?.read);
    }
    if (event?.type === 'error') failure ??= String(event.error?.data?.message ?? event.error?.message ?? 'OpenCode reported an error.').slice(0, 300);
  };
  return {
    push(chunk) {
      pending += chunk;
      let end;
      while ((end = pending.indexOf('\n')) >= 0) {
        const value = pending.slice(0, end);
        pending = pending.slice(end + 1);
        if (value.trim() && value.length <= MAX_LINE) line(value);
      }
      if (pending.length > MAX_LINE) pending = '';
    },
    finish(code, otherFailure = null) {
      if (pending.trim()) line(pending);
      // `opencode run` exits without the last step's step_finish (hz lab 13/11): that step's text is still the answer.
      if (step.length) answer = step.join('\n\n');
      const error = otherFailure ?? failure ?? (code !== 0 ? `OpenCode exited with code ${code ?? 'unknown'}.` : !answer.trim() ? 'OpenCode gave no answer.' : null);
      return { type: 'result', provider: 'opencode', subtype: error ? 'error' : 'success', is_error: Boolean(error), result: error ?? answer,
        num_turns: steps, ...(steps ? { modelUsage: { [model]: usage } } : {}) };
    }
  };
}

function waitForListening(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    let out = '';
    const timer = setTimeout(() => reject(new Error('OpenCode did not start its server.')), timeoutMs);
    child.stdout.setEncoding('utf8').on('data', (chunk) => {
      out = (out + chunk).slice(-4_096);
      const match = /listening on (http:\/\/127\.0\.0\.1:\d{1,5})/.exec(out);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    });
    child.once('close', () => { clearTimeout(timer); reject(new Error('OpenCode stopped before its server started.')); });
  });
}

/** The Nous tools must be connected before the prompt: OpenCode builds a turn's tools from what has connected when it starts. */
async function waitForTools(serverUrl, password, directory, timeoutMs, stopped) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && !stopped()) {
    const response = await fetch(`${serverUrl}/api/mcp`, { headers: { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`,
      'x-opencode-directory': encodeURIComponent(directory) }, signal: AbortSignal.timeout(5_000) }).catch(() => null);
    const status = response?.ok ? (await response.json().catch(() => null))?.data?.find((entry) => entry?.name === 'space_nous')?.status?.status : null;
    if (status === 'connected') return;
    if (status === 'failed' || status === 'needs_auth') break;
    await new Promise((done) => setTimeout(done, 250));
  }
  throw new Error('OpenCode could not connect the Nous tools.');
}

export async function main(input, { env = process.env, out = process.stdout, binary = 'opencode' } = {}) {
  const emit = (record) => out.write(`${JSON.stringify(record)}\n`);
  let raw = null;
  try { raw = JSON.parse(input); } catch { /* refused below */ }
  const request = nousRequest(raw);
  if (!request) { process.stderr.write('Invalid Nous request.\n'); return 64; }
  const model = await paneModel(env.XDG_CONFIG_HOME);
  const scratch = await mkdtemp(join(env.TMPDIR || tmpdir(), 'spaceapp-opencode-nous-'));
  const work = join(scratch, 'work');
  const children = [];
  let failure = null;
  const stop = (message) => {
    failure ??= message;
    for (const child of children) { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ } }
  };
  const timer = setTimeout(() => stop('OpenCode exceeded the Nous turn timeout.'), TURN_MS);
  // The credential agent stops this helper when the API stops the turn; OpenCode goes with it.
  const onTerm = () => stop('The turn was stopped.');
  process.once('SIGTERM', onTerm);
  const reader = openCodeOutputReader(request, model, emit);
  try {
    // The default config location: Zen refuses its free tier with a custom OPENCODE_CONFIG path.
    await mkdir(join(scratch, 'config', 'opencode'), { recursive: true, mode: 0o700 });
    await mkdir(work, { mode: 0o700 });
    await writeFile(join(scratch, 'config', 'opencode', 'opencode.json'), JSON.stringify(nousConfig(request)), { mode: 0o600 });
    await writeFile(join(scratch, 'config', 'opencode', 'system.md'), request.system || 'You are Nous.', { mode: 0o600 });
    const password = randomBytes(24).toString('hex');
    const childEnv = { PATH: env.PATH, LANG: 'C.UTF-8', USER: env.USER, HOME: scratch, TMPDIR: scratch, OPENCODE_DISABLE_AUTOUPDATE: 'true',
      OPENCODE_DISABLE_PROJECT_CONFIG: '1', XDG_CONFIG_HOME: join(scratch, 'config'), XDG_DATA_HOME: join(scratch, 'data'), XDG_STATE_HOME: join(scratch, 'state'),
      // The provider packages and model catalog OpenCode already fetched; nothing of the panes' sessions or settings.
      XDG_CACHE_HOME: env.XDG_CACHE_HOME || join(scratch, 'cache'), SPACE_NOUS_MCP_TOKEN: request.mcpToken, OPENCODE_SERVER_PASSWORD: password };
    const server = spawn(binary, ['serve', '--hostname', '127.0.0.1', '--port', '0'], { cwd: work, env: childEnv, detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
    children.push(server);
    const serverUrl = await waitForListening(server, 30_000);
    await waitForTools(serverUrl, password, work, 30_000, () => failure !== null);
    if (failure) throw new Error(failure);
    const child = spawn(binary, ['run', '--server', serverUrl, '--format', 'json', '--agent', 'nous', '--title', 'Space Nous', '--model', model],
      { cwd: work, env: childEnv, detached: true, stdio: ['pipe', 'pipe', 'ignore'] });
    children.push(child);
    child.stdout.setEncoding('utf8').on('data', (chunk) => reader.push(chunk));
    child.stdin.on('error', () => undefined);
    child.stdin.end(request.prompt);
    const code = await new Promise((done) => { child.once('error', () => done(1)); child.once('close', done); });
    const result = reader.finish(code, failure);
    emit(result);
    return result.is_error ? 1 : 0;
  } catch (error) {
    emit(reader.finish(1, failure ?? (error instanceof Error ? error.message : 'OpenCode could not run the turn.')));
    return 1;
  } finally {
    clearTimeout(timer);
    process.off('SIGTERM', onTerm);
    for (const child of children) { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ } }
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
  readStdin().then((input) => main(input)).then((code) => { process.exitCode = code; }, () => { process.exitCode = 1; });
}
