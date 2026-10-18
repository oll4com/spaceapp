import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { chmod, lstat, realpath, unlink } from 'node:fs/promises';
import { createConnection, createServer } from 'node:net';
import { join } from 'node:path';
import { sameProcess } from './processes.mjs';

const maxRequest = 1024, maxReply = 16384, maxConnections = 4, timeoutMs = 3000;
const socketName = /^p-[a-f0-9]{12}\.sock$/;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const failure = code => Object.assign(new Error(`Owned reload observation failed (${code}).`), { code });
const bound = (value, owner) => value.nonce === owner.nonce && value.pid === owner.pid && value.identity === owner.identity;
const exactKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join(',') === keys.sort().join(',');
const idle = value => value && !value.stopping && value.pending === null && value.queued === null && value.active === null && value.requested === value.completed;

/** Validate the versioned observation; legacy recovery records never qualify as proof. */
export function reloadObservation(value) {
  const sequence = number => Number.isSafeInteger(number) && number >= 0;
  assert(value?.version === 1 && sequence(value.revision) && sequence(value.requested) && sequence(value.completed) && value.completed <= value.requested && typeof value.stopping === 'boolean', 'Missing or malformed reload receipt.');
  for (const key of ['pending', 'queued', 'active']) {
    const slot = value[key];
    assert(slot === null || (slot && sequence(slot.generation) && slot.generation > 0 && slot.generation <= value.requested && ['api', 'packages'].includes(slot.kind) && (key !== 'queued' || slot.kind === 'packages')), 'Malformed reload phase receipt.');
  }
  return { version: value.version, revision: value.revision, requested: value.requested, pending: value.pending, queued: value.queued, active: value.active, completed: value.completed, stopping: value.stopping };
}

/** One bounded JSON line per half-closed connection; reject extra frames and unrecognized fields. */
export function parseReloadRequest(bytes, owner) {
  if (bytes.length > maxRequest || bytes.at(-1) !== 10) throw failure('MALFORMED_REQUEST');
  let value;
  try { value = JSON.parse(bytes.subarray(0, -1).toString('utf8')); } catch { throw failure('MALFORMED_REQUEST'); }
  if (!exactKeys(value, ['version', 'nonce', 'pid', 'identity', 'challenge']) || value.version !== 1 || !uuid.test(value.challenge) || !bound(value, owner)) throw failure('FOREIGN_REQUEST');
  return value;
}

/** Reserve at dispatch as well as connection admission; timed-out requests can still await publication. */
export function reserveReloadProofObservation(observations, socket) {
  if (observations.size >= maxConnections) throw failure('CAPACITY');
  observations.add(socket);
}

/**
 * Drain the write tail captured after request arrival, then synchronously select
 * the authoritative RAM snapshot. A newer publication is BUSY, never a stale
 * disk fallback; shutdown and failed publication are fatal. This observes work
 * without scheduling, blocking admission of, or changing a source reload.
 */
export async function observeReloadProof({ tail, closed, snapshot }) {
  if (closed()) throw failure('STOPPING');
  const captured = tail();
  try { await captured; } catch { throw failure('WRITE_FAILED'); }
  if (closed()) throw failure('STOPPING');
  if (captured !== tail()) return { status: 'BUSY', snapshot: null };
  const value = snapshot();
  const reload = reloadObservation(value.reload);
  if (reload.stopping) throw failure('STOPPING');
  return idle(reload) ? { status: 'OK', snapshot: value } : { status: 'BUSY', snapshot: null };
}

async function privateRun(config) {
  const state = await lstat(config.state), run = join(config.state, 'run'), info = await lstat(run);
  for (const item of [state, info]) if (!item.isDirectory() || item.isSymbolicLink() || (item.mode & 0o777) !== 0o700 || item.uid !== process.getuid()) throw failure('UNSAFE_DIRECTORY');
  if (await realpath(config.state) !== config.state || await realpath(run) !== run) throw failure('LINKED_DIRECTORY');
  return run;
}
async function privateSocket(config, name) {
  if (!socketName.test(name)) throw failure('UNSAFE_SOCKET_NAME');
  const run = await privateRun(config), file = join(run, name);
  if (Buffer.byteLength(file) > 100) throw failure('SOCKET_PATH_TOO_LONG');
  const info = await lstat(file);
  if (!info.isSocket() || info.isSymbolicLink() || (info.mode & 0o777) !== 0o600 || info.uid !== process.getuid()) throw failure('UNSAFE_SOCKET');
  return { file, info };
}

/** Create a private observation socket only; no HTTP/TCP endpoint or request-supplied path. */
export async function openReloadProofChannel(config, owner, observe) {
  const run = await privateRun(config), name = `p-${randomBytes(6).toString('hex')}.sock`, file = join(run, name);
  if (Buffer.byteLength(file) > 100) throw failure('SOCKET_PATH_TOO_LONG');
  const existing = await lstat(file).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (existing) throw failure('SOCKET_EXISTS');
  let closing = false, closePromise, owned;
  const connections = new Set(), observations = new Set();
  const server = createServer({ allowHalfOpen: true }, socket => {
    if (closing || connections.size >= maxConnections || observations.size >= maxConnections) { socket.destroy(); return; }
    connections.add(socket);
    const timer = setTimeout(() => socket.destroy(), timeoutMs), chunks = []; let bytes = 0;
    socket.on('error', () => {});
    socket.once('close', () => { clearTimeout(timer); connections.delete(socket); });
    socket.on('data', chunk => { bytes += chunk.length; if (bytes > maxRequest) socket.destroy(); else chunks.push(chunk); });
    socket.once('end', async () => {
      let request;
      try {
        if (closing || socket.destroyed) throw failure('STOPPING');
        request = parseReloadRequest(Buffer.concat(chunks), owner);
        reserveReloadProofObservation(observations, socket);
        const result = await observe();
        if (closing) throw failure('STOPPING');
        const reply = { version: 1, ...owner, challenge: request.challenge, ...result };
        const text = JSON.stringify(reply) + '\n';
        if (Buffer.byteLength(text) > maxReply) throw failure('REPLY_TOO_LARGE');
        socket.end(text);
      } catch (error) {
        if (request && !socket.destroyed) socket.end(JSON.stringify({ version: 1, ...owner, challenge: request.challenge, status: 'ERROR', code: ['STOPPING', 'WRITE_FAILED', 'REPLY_TOO_LARGE', 'CAPACITY'].includes(error.code) ? error.code : 'OBSERVATION_FAILED', snapshot: null }) + '\n');
        else socket.destroy();
      } finally { observations.delete(socket); }
    });
  });
  server.on('error', () => { closing = true; for (const socket of connections) socket.destroy(); });
  const close = () => closePromise ||= (async () => {
    closing = true;
    for (const socket of connections) socket.destroy();
    // net.Server.close may unlink its Unix path itself: verify ownership first.
    const beforeClose = await lstat(file).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (server.listening && (!owned || (beforeClose && (!beforeClose.isSocket() || beforeClose.isSymbolicLink() || beforeClose.dev !== owned.dev || beforeClose.ino !== owned.ino || beforeClose.uid !== owned.uid)))) {
      server.unref(); throw failure('SOCKET_REPLACED');
    }
    if (server.listening) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    if (owned) {
      const current = await lstat(file).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      if (current && (!current.isSocket() || current.isSymbolicLink() || current.dev !== owned.dev || current.ino !== owned.ino || current.uid !== owned.uid)) throw failure('SOCKET_REPLACED');
      if (current) await unlink(file);
    }
  })();
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(file, resolve); });
    const created = await lstat(file);
    if (!created.isSocket() || created.isSymbolicLink() || created.uid !== process.getuid()) throw failure('UNSAFE_SOCKET');
    owned = created;
    await chmod(file, 0o600);
    await privateSocket(config, name);
    return { name, stopAdmission() { closing = true; server.unref(); for (const socket of connections) socket.destroy(); }, close };
  } catch (error) { await close(); throw error; }
}

/** Request a fresh challenge-bound observation from the exact live owned supervisor. */
export async function queryReloadProof(config, owner, request, remainingMs) {
  const started = Date.now();
  if (!uuid.test(request.challenge) || !Number.isFinite(remainingMs) || remainingMs <= 0 || !await sameProcess(owner)) throw failure('INVALID_QUERY');
  const { file } = await privateSocket(config, owner.proofSocket);
  const remaining = Math.min(timeoutMs, remainingMs) - (Date.now() - started);
  if (remaining <= 0) throw failure('QUERY_TIMEOUT');
  const binding = { nonce: owner.nonce, pid: owner.pid, identity: owner.identity };
  const message = { version: 1, ...binding, challenge: request.challenge };
  return new Promise((resolve, reject) => {
    const socket = createConnection(file), chunks = []; let bytes = 0, settled = false;
    const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); socket.destroy(); if (error) reject(error); else resolve(value); };
    const timer = setTimeout(() => finish(failure('QUERY_TIMEOUT')), remaining);
    socket.once('connect', () => socket.end(JSON.stringify(message) + '\n'));
    socket.on('error', () => finish(failure('QUERY_TRANSPORT')));
    socket.on('data', chunk => { bytes += chunk.length; if (bytes > maxReply) finish(failure('REPLY_TOO_LARGE')); else chunks.push(chunk); });
    socket.once('end', () => {
      try {
        const body = Buffer.concat(chunks);
        if (body.at(-1) !== 10) throw failure('MALFORMED_REPLY');
        const value = JSON.parse(body.subarray(0, -1).toString('utf8'));
        if (!exactKeys(value, value.status === 'ERROR' ? ['version', 'nonce', 'pid', 'identity', 'challenge', 'status', 'snapshot', 'code'] : ['version', 'nonce', 'pid', 'identity', 'challenge', 'status', 'snapshot']) || value.version !== 1 || !bound(value, binding) || value.challenge !== request.challenge || !['OK', 'BUSY', 'ERROR'].includes(value.status)) throw failure('FOREIGN_REPLY');
        if (value.status === 'ERROR') throw failure(['STOPPING', 'WRITE_FAILED', 'REPLY_TOO_LARGE', 'CAPACITY'].includes(value.code) ? value.code : 'OBSERVATION_FAILED');
        if (value.status === 'BUSY' && value.snapshot !== null) throw failure('MALFORMED_REPLY');
        finish(null, value);
      } catch (error) { finish(error); }
    });
    socket.once('close', () => { if (!settled) finish(failure('QUERY_CLOSED')); });
  });
}
