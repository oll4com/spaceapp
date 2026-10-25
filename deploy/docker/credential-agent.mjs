#!/usr/bin/env node
// The Space API (spaceapp-core) cannot see this container's CLI logins, and the persistent pane host must
// not serve credential checks. This agent runs one wrapper's fixed credential action for it: one JSON
// request line in, one JSON answer line out, on a socket next to the pane host socket.
import { execFile } from 'node:child_process';
import { chmod, lstat, unlink } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Per action: the input it takes (bytes, 0 = none), its time limit and how much of its stdout goes back.
// credential-smoke/-observation, opencode-text/-models: the core image has no CLIs (1.1.7, decision B); they run this container's.
const actions = new Map([
  ['credential-status', { input: 0, timeout: 120_000, stdout: 4096 }],
  ['credential-install', { input: 512 * 1024, timeout: 120_000, stdout: 4096 }],
  ['credential-smoke', { input: 0, timeout: 190_000, stdout: 4096 }],
  ['credential-observation', { input: 0, timeout: 10_000, stdout: 256 }],
  ['opencode-text', { command: 'opencode-vscode-parity', input: 128 * 1024, timeout: 120_000, stdout: 1024 * 1024 }],
  ['opencode-models', { command: 'opencode-vscode-parity', input: 256, timeout: 60_000, stdout: 2 * 1024 * 1024 }]
]);
const wrapper = /^[a-z][a-z0-9-]{0,40}-vscode-parity$/;
const maxRequestBytes = 600 * 1024;
// Each request runs a wrapper for up to 190 s: more than this many at once answer 'busy' instead of piling up processes.
export const maxConcurrentActions = 4;

export function runAction(request, commandPath) {
  const { command, action, input, ...extra } = request ?? {};
  const limits = typeof action === 'string' ? actions.get(action) : undefined;
  if (typeof command !== 'string' || !wrapper.test(command) || !limits || (limits.command && command !== limits.command) ||
      Object.keys(extra).length ||
      (input !== undefined && (!limits.input || typeof input !== 'string' || Buffer.byteLength(input) > limits.input))) {
    return Promise.resolve({ exitCode: 64, stdout: 'FAILED bad-request\n' });
  }
  return new Promise((resolve) => {
    const child = execFile(join(commandPath, command), [action], { encoding: 'utf8', timeout: limits.timeout, maxBuffer: Math.max(16 * 1024, limits.stdout) }, (error, stdout) => {
      resolve({ exitCode: !error ? 0 : typeof error.code === 'number' ? error.code : 1, stdout: String(stdout ?? '').slice(0, limits.stdout) });
    });
    child.stdin.on('error', () => undefined);
    child.stdin.end(typeof input === 'string' ? input : '');
  });
}

export async function startCredentialAgent({ socketPath, commandPath, socketMode = 0o660, maxConcurrent = maxConcurrentActions }) {
  let running = 0;
  const stale = await lstat(socketPath).catch(() => null);
  if (stale?.isSocket()) await unlink(socketPath);
  else if (stale) throw new Error(`Refusing to replace non-socket path ${socketPath}.`);
  // allowHalfOpen: the request ends the client's side; the answer still goes back on ours.
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    let body = '';
    socket.setEncoding('utf8');
    // The longest action (credential-smoke, 190 s) still answers. shortcut: a client that leaves after its
    // half-close is not seen, so an OpenCode answer runs to its own timeoutMs; add a cancel message if that matters.
    socket.setTimeout(210_000, () => socket.destroy());
    socket.on('error', () => undefined);
    socket.on('data', (chunk) => {
      body += chunk;
      if (body.length > maxRequestBytes) socket.destroy();
    });
    socket.on('end', async () => {
      let request = null;
      try { request = JSON.parse(body); } catch { /* answered as a bad request */ }
      if (running >= maxConcurrent) {
        socket.end(`${JSON.stringify({ exitCode: 75, stdout: 'FAILED busy\n' })}\n`);
        return;
      }
      running += 1;
      const answer = await runAction(request, commandPath).catch(() => ({ exitCode: 1, stdout: 'FAILED write-failed\n' }))
        .finally(() => { running -= 1; });
      socket.end(`${JSON.stringify(answer)}\n`);
    });
  });
  await new Promise((resolve, reject) => server.once('error', reject).listen(socketPath, resolve));
  await chmod(socketPath, socketMode);
  return server;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  startCredentialAgent({
    socketPath: process.env.SPACEAPP_CREDENTIAL_SOCKET || '/run/spaceapp-cli/credentials.sock',
    commandPath: '/usr/local/bin'
  }).catch((error) => {
    process.stderr.write(`credential agent: ${error.message}\n`);
    process.exitCode = 1;
  });
}
