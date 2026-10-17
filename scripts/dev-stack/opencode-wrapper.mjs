#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { confinedFile, opencodeEnvironment, verifyOpenCode } from './opencode-runtime.mjs';

// Copied verbatim by our orchestrator into its private cli/bin, never globally.
const state = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const version = (await readFile(await confinedFile(state, join(state, 'cli', 'opencode-version')), 'utf8')).trim();
const args = process.argv.slice(2);
if (args[0] === '--run-inner') args.shift();
if (['credential-smoke', 'login', 'auth', 'run', 'credential-install'].includes(args[0])) { console.error('This contributor wrapper opens the UI only; provider authentication/inference is disabled.'); process.exitCode = 64; }
else {
  const native = await verifyOpenCode(state, version, { inherited: process.env });
  if (args[0] === 'credential-status') { console.log('READY'); }
  else if (args[0] === 'credential-observation') { console.log(`OBSERVATION:${native.sha256}`); }
  else {
  const env = opencodeEnvironment(state, process.env);
  const child = spawn(native.executable, args, {
    stdio: 'inherit',
    env
  });
  child.once('error', () => { console.error('Pinned state-local OpenCode could not start.'); process.exitCode = 1; });
  child.once('exit', (code, signal) => { if (signal) process.kill(process.pid, signal); else process.exitCode = code ?? 1; });
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => child.kill(signal));
  }
}
