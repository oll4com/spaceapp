#!/usr/bin/env node
// The Space API (spaceapp-core) cannot see this container's CLI logins, and the persistent pane host must
// not serve credential checks. This agent runs one wrapper's fixed credential action for it: one JSON
// request line in, one JSON answer line out, on a socket next to the pane host socket.
import { execFile } from 'node:child_process';
import { chmod, lstat, unlink } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const actions = new Set(['credential-status', 'credential-install']);
const wrapper = /^[a-z][a-z0-9-]{0,40}-vscode-parity$/;
const maxRequestBytes = 600 * 1024;
const maxInputBytes = 512 * 1024;

export function runAction(request, commandPath) {
  const { command, action, input } = request ?? {};
  if (typeof command !== 'string' || !wrapper.test(command) || !actions.has(action) ||
      (input !== undefined && (action !== 'credential-install' || typeof input !== 'string' || input.length > maxInputBytes))) {
    return Promise.resolve({ exitCode: 64, stdout: 'FAILED bad-request\n' });
  }
  return new Promise((resolve) => {
    const child = execFile(join(commandPath, command), [action], { encoding: 'utf8', timeout: 120_000, maxBuffer: 16 * 1024 }, (error, stdout) => {
      resolve({ exitCode: !error ? 0 : typeof error.code === 'number' ? error.code : 1, stdout: String(stdout ?? '').slice(0, 4096) });
    });
    child.stdin.on('error', () => undefined);
    child.stdin.end(typeof input === 'string' ? input : '');
  });
}

export async function startCredentialAgent({ socketPath, commandPath, socketMode = 0o660 }) {
  const stale = await lstat(socketPath).catch(() => null);
  if (stale?.isSocket()) await unlink(socketPath);
  else if (stale) throw new Error(`Refusing to replace non-socket path ${socketPath}.`);
  // allowHalfOpen: the request ends the client's side; the answer still goes back on ours.
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    let body = '';
    socket.setEncoding('utf8');
    socket.setTimeout(150_000, () => socket.destroy());
    socket.on('error', () => undefined);
    socket.on('data', (chunk) => {
      body += chunk;
      if (body.length > maxRequestBytes) socket.destroy();
    });
    socket.on('end', async () => {
      let request = null;
      try { request = JSON.parse(body); } catch { /* answered as a bad request */ }
      const answer = await runAction(request, commandPath).catch(() => ({ exitCode: 1, stdout: 'FAILED write-failed\n' }));
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
    commandPath: process.env.SPACE_CLI_COMMAND_PATH || '/usr/local/bin'
  }).catch((error) => {
    process.stderr.write(`credential agent: ${error.message}\n`);
    process.exitCode = 1;
  });
}
