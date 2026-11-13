#!/usr/bin/env node
// The Space API (spaceapp-core) cannot see this container's CLI logins, and the persistent pane host must
// not serve credential checks. This agent runs one wrapper's fixed credential action for it: one JSON
// request line in, one JSON answer line out, on a socket next to the pane host socket. A streamed action
// (Nous's turns) sends the wrapper's stdout as it comes, then one end line: RS (\x1e) + {exitCode, stderr};
// its client keeps its side open after the request line, and ending it stops the action.
import { execFile, spawn } from 'node:child_process';
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
  ['opencode-models', { command: 'opencode-vscode-parity', input: 256, timeout: 60_000, stdout: 2 * 1024 * 1024 }],
  // Nous on a public install (operator decision 2026-10-27): its Claude Code turns (up to 20 minutes, streamed) and the pane
  // board's one answer, on the owner's own Claude login, in their own slots so a long turn never blocks a credential check.
  ['agent-tools', { command: 'claude-vscode-parity', input: 1024 * 1024, timeout: 21 * 60_000, stdout: 64 * 1024 * 1024, stream: true, pool: 'agent' }],
  ['agent-chat', { command: 'claude-vscode-parity', input: 64 * 1024, timeout: 610_000, stdout: 1024 * 1024, pool: 'agent' }],
  // The same turn on the Getting Started pane's free OpenCode model while no Claude Code is signed in (Nous 13/11).
  ['opencode-nous', { command: 'opencode-vscode-parity', input: 1024 * 1024, timeout: 21 * 60_000, stdout: 64 * 1024 * 1024, stream: true, pool: 'agent' }]
]);
const wrapper = /^[a-z][a-z0-9-]{0,40}-vscode-parity$/;
// A Nous request is JSON in JSON: its 1 MB input escaped once more.
const maxRequestBytes = 2.5 * 1024 * 1024;
// Each request runs a wrapper for up to 190 s: more than this many at once answer 'busy' instead of piling up processes.
export const maxConcurrentActions = 4;
// Nous's operator, background and goal turns, a helper and the pane board at once.
export const maxConcurrentAgentActions = 6;

/** The limits of a request this agent runs, or null for any other request. */
function limitsOf(request) {
  const { command, action, input, ...extra } = request ?? {};
  const limits = typeof action === 'string' ? actions.get(action) : undefined;
  if (typeof command !== 'string' || !wrapper.test(command) || !limits || (limits.command && command !== limits.command) ||
      Object.keys(extra).length ||
      (input !== undefined && (!limits.input || typeof input !== 'string' || Buffer.byteLength(input) > limits.input))) return null;
  return limits;
}

export function runAction(request, commandPath) {
  const limits = limitsOf(request);
  if (!limits || limits.stream) return Promise.resolve({ exitCode: 64, stdout: 'FAILED bad-request\n' });
  const { command, action, input } = request;
  return new Promise((resolve) => {
    const child = execFile(join(commandPath, command), [action], { encoding: 'utf8', timeout: limits.timeout, maxBuffer: Math.max(16 * 1024, limits.stdout) }, (error, stdout) => {
      resolve({ exitCode: !error ? 0 : typeof error.code === 'number' ? error.code : 1, stdout: String(stdout ?? '').slice(0, limits.stdout) });
    });
    child.stdin.on('error', () => undefined);
    child.stdin.end(typeof input === 'string' ? input : '');
  });
}

/** A streamed action: the wrapper's stdout goes to the socket as it comes; resolves its exit code and stderr's tail. */
export function streamAction(request, commandPath, socket) {
  const limits = limitsOf(request);
  return new Promise((resolve) => {
    // Its own process group: a stop reaches Claude Code and whatever its tools started.
    const child = spawn(join(commandPath, request.command), [request.action], { stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    let sent = 0;
    let stderr = '';
    let finished = false;
    const stop = () => { try { process.kill(-child.pid, 'SIGTERM'); } catch { /* gone */ } };
    const timer = setTimeout(stop, limits.timeout);
    // The API stopped the turn or went away: the turn stops too.
    socket.once('end', stop).once('close', stop);
    const done = (code) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      socket.off('end', stop).off('close', stop);
      child.stdout.destroy();
      resolve({ exitCode: typeof code === 'number' ? code : 1, stderr });
    };
    child.stdout.on('data', (chunk) => {
      if (finished) return;
      sent += chunk.length;
      if (sent > limits.stdout) stop();
      else socket.write(chunk);
    });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr = (stderr + chunk).slice(-2_048); });
    child.once('error', () => done(1));
    child.once('close', done);
    // A process it left behind may hold stdout open: the action ends 2 s after the wrapper did.
    child.once('exit', (code) => setTimeout(() => done(code), 2_000).unref());
    child.stdin.on('error', () => undefined);
    child.stdin.end(typeof request.input === 'string' ? request.input : '');
  });
}

export async function startCredentialAgent({ socketPath, commandPath, socketMode = 0o660, maxConcurrent = maxConcurrentActions, maxConcurrentAgent = maxConcurrentAgentActions }) {
  const pools = { credential: { running: 0, max: maxConcurrent }, agent: { running: 0, max: maxConcurrentAgent } };
  const stale = await lstat(socketPath).catch(() => null);
  if (stale?.isSocket()) await unlink(socketPath);
  else if (stale) throw new Error(`Refusing to replace non-socket path ${socketPath}.`);
  // allowHalfOpen: the request ends the client's side; the answer still goes back on ours.
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    let body = '';
    let started = false;
    socket.setEncoding('utf8');
    // The longest credential action (credential-smoke, 190 s) still answers; a request's own limit raises it below.
    // shortcut: a client that leaves after its half-close is seen only by streamed actions, so an OpenCode answer runs
    // to its own timeoutMs; add a cancel message if that matters.
    socket.setTimeout(210_000, () => socket.destroy());
    socket.on('error', () => undefined);
    // A request runs at its line's end (a streamed client keeps its side open) or at the client's half-close.
    const start = async () => {
      if (started) return;
      started = true;
      const newline = body.indexOf('\n');
      let request = null;
      try { request = JSON.parse(newline < 0 ? body : body.slice(0, newline)); } catch { /* answered as a bad request */ }
      const limits = limitsOf(request);
      const pool = pools[limits?.pool ?? 'credential'];
      if (pool.running >= pool.max) {
        socket.end(`${JSON.stringify({ exitCode: 75, stdout: 'FAILED busy\n' })}\n`);
        return;
      }
      pool.running += 1;
      if (limits) socket.setTimeout(Math.max(210_000, limits.timeout + 30_000));
      try {
        if (limits?.stream) {
          const end = await streamAction(request, commandPath, socket);
          if (!socket.destroyed) socket.end(`\n\x1e${JSON.stringify(end)}\n`);
          return;
        }
        const answer = await runAction(request, commandPath).catch(() => ({ exitCode: 1, stdout: 'FAILED write-failed\n' }));
        socket.end(`${JSON.stringify(answer)}\n`);
      } finally {
        pool.running -= 1;
      }
    };
    socket.on('data', (chunk) => {
      if (started) return;
      body += chunk;
      if (body.length > maxRequestBytes) socket.destroy();
      else if (body.includes('\n')) void start();
    });
    socket.on('end', () => void start());
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
