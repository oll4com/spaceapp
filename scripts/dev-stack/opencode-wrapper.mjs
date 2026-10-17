#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Copied verbatim by our orchestrator into its private cli/bin, never globally.
const state = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const provider = join(state, 'providers', 'opencode');
const executable = join(state, 'cli', 'vendor', 'opencode', 'node_modules', 'opencode-ai', 'bin', 'opencode');
const args = process.argv.slice(2);
if (args[0] === '--run-inner') args.shift();
if (args[0] === 'credential-status') { await readFile(executable); console.log('READY'); }
else if (args[0] === 'credential-observation') { console.log(`OBSERVATION:${createHash('sha256').update(await readFile(executable)).digest('hex')}`); }
else if (['credential-smoke', 'login', 'auth', 'run', 'credential-install'].includes(args[0])) { console.error('This contributor wrapper opens the UI only; provider authentication/inference is disabled.'); process.exitCode = 64; }
else {
  for (const folder of ['', 'tmp', 'config', 'data', 'cache', 'state']) await mkdir(join(provider, folder), { recursive: true, mode: 0o700 });
  const child = spawn(process.execPath, [executable, ...args], {
    stdio: 'inherit',
    env: { PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin', TERM: 'xterm-256color', LANG: 'en_US.UTF-8', HOME: provider, TMPDIR: join(provider, 'tmp'), XDG_CONFIG_HOME: join(provider, 'config'), XDG_DATA_HOME: join(provider, 'data'), XDG_CACHE_HOME: join(provider, 'cache'), XDG_STATE_HOME: join(provider, 'state'), OPENCODE_DISABLE_AUTOUPDATE: 'true', OPENCODE_DISABLE_SHARE: 'true' }
  });
  child.once('error', () => { console.error('Pinned state-local OpenCode could not start.'); process.exitCode = 1; });
  child.once('exit', (code, signal) => { if (signal) process.kill(process.pid, signal); else process.exitCode = code ?? 1; });
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => child.kill(signal));
}
