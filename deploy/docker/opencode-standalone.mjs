#!/usr/bin/env node
// The Space API (spaceapp-core) has no OpenCode (1.1.7, decision B). Through the credential agent and the
// OpenCode wrapper it asks this container's OpenCode for a text answer (the Room Agent) or a provider's models
// (the model bench). Every run is --standalone in a throwaway home, so it never opens the panes' store.
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// `opencode run` takes the prompt as one argument (Linux caps one at 128 KiB).
const maxPromptBytes = 120 * 1024;
const maxOutputBytes = { text: 1024 * 1024, models: 2 * 1024 * 1024 };

/** The command a request asks for, or null when the request is not one this helper runs. */
export function opencodeCommand(mode, request) {
  if (mode === 'text') {
    const { modelId, prompt, timeoutMs } = request ?? {};
    if (typeof modelId !== 'string' || !/^[A-Za-z0-9._-]{1,80}\/[A-Za-z0-9._:/-]{1,200}$/.test(modelId) ||
        typeof prompt !== 'string' || !prompt || Buffer.byteLength(prompt) > maxPromptBytes ||
        !Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 110_000) return null;
    return { args: ['run', '--standalone', '--format', 'json', '--model', modelId, prompt], timeoutMs };
  }
  if (mode === 'models') {
    const { provider } = request ?? {};
    if (typeof provider !== 'string' || !/^[a-z0-9-]{1,40}$/.test(provider)) return null;
    return { args: ['api', 'GET', '/api/model', '--standalone'], timeoutMs: 20_000, provider };
  }
  return null;
}

/** Text: OpenCode's JSON events as they are (the API reads the answer). Models: only the asked provider's. */
export function answerOutput(mode, stdout, provider) {
  if (mode === 'text') return stdout;
  const data = JSON.parse(stdout)?.data;
  return JSON.stringify({ data: (Array.isArray(data) ? data : []).filter((model) => model?.providerID === provider) });
}

/** Scratch data, state and cache. Models read the owner's config (its providers); a text answer reads none. */
export function isolatedEnvironment(mode, scratch, env = process.env) {
  return {
    PATH: env.PATH, LANG: 'C.UTF-8', USER: env.USER, HOME: scratch, TMPDIR: scratch, OPENCODE_DISABLE_AUTOUPDATE: 'true',
    XDG_CONFIG_HOME: mode === 'models' && env.XDG_CONFIG_HOME ? env.XDG_CONFIG_HOME : join(scratch, 'config'),
    XDG_DATA_HOME: join(scratch, 'data'), XDG_STATE_HOME: join(scratch, 'state'), XDG_CACHE_HOME: join(scratch, 'cache'),
    ...(mode === 'models' && env.OPENCODE_API_KEY ? { OPENCODE_API_KEY: env.OPENCODE_API_KEY } : {})
  };
}

function runOpenCode(args, env, cwd, timeoutMs, limit) {
  return new Promise((resolve) => {
    const child = spawn('opencode', args, { env, cwd, stdio: ['ignore', 'pipe', 'ignore'] });
    let stdout = '';
    const stop = () => { try { child.kill('SIGKILL'); } catch {} };
    const timer = setTimeout(stop, timeoutMs);
    // The agent stops this helper when the API leaves; OpenCode goes with it.
    process.once('SIGTERM', stop);
    child.stdout.setEncoding('utf8').on('data', (chunk) => {
      stdout += chunk;
      if (Buffer.byteLength(stdout) > limit) stop();
    });
    child.once('error', () => { clearTimeout(timer); resolve({ code: 1, stdout: '' }); });
    child.once('close', (code) => { clearTimeout(timer); resolve({ code: code ?? 1, stdout }); });
  });
}

async function readStdin() {
  let text = '';
  for await (const chunk of process.stdin) {
    text += chunk;
    if (text.length > 256 * 1024) throw new Error('request too large');
  }
  return text;
}

export async function main(mode, input) {
  let request = null;
  try { request = JSON.parse(input); } catch { /* refused below */ }
  const command = opencodeCommand(mode, request);
  if (!command) return { exitCode: 64, stdout: '' };
  const scratch = await mkdtemp(join(tmpdir(), 'spaceapp-opencode-'));
  try {
    if (mode === 'text') {
      // A text answer runs no tool but read, in its empty scratch folder: this container holds the owner's CLI logins.
      // The default config location: Zen refuses its free tier with a custom OPENCODE_CONFIG path or with every tool denied.
      await mkdir(join(scratch, 'config', 'opencode'), { recursive: true, mode: 0o700 });
      await writeFile(join(scratch, 'config', 'opencode', 'opencode.json'), JSON.stringify({ permission: { '*': 'deny', read: 'allow' } }), { mode: 0o600 });
    }
    const result = await runOpenCode(command.args, isolatedEnvironment(mode, scratch), scratch, command.timeoutMs, maxOutputBytes[mode]);
    if (result.code !== 0 && !result.stdout.trim()) return { exitCode: 1, stdout: '' };
    return { exitCode: result.code === 0 ? 0 : 1, stdout: answerOutput(mode, result.stdout, command.provider) };
  } catch {
    return { exitCode: 1, stdout: '' };
  } finally {
    await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  readStdin().then((input) => main(process.argv[2], input)).then(({ exitCode, stdout }) => {
    process.stdout.write(stdout);
    process.exitCode = exitCode;
  }, () => { process.exitCode = 1; });
}
