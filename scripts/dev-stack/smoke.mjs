// Dragon, 2026-10-26: isolated full-stack owner and real OpenCode terminal acceptance.
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';
import { loadConfig, assertOwnedState } from './state.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const config = await loadConfig(root, process.env);
await assertOwnedState(config);
const state = config.stateDir;
const api = `http://127.0.0.1:${config.ports.api}`;
const web = `http://127.0.0.1:${config.ports.web}`;
let cookie = '';
let csrf = null;
const proof = { mode: 'FULL_STACK_OPENCODE_TUI', passed: false, checks: {}, checkedAt: new Date().toISOString() };
let stage = 'readiness';
const sensitive = new Set();
// Longniang, 2026-10-28: keep both real pane transports alive through the concurrent RUNNING proof.
const terminalSockets = new Set();
function safeMessage(error) {
  let message = error instanceof Error ? error.message : 'Unknown acceptance error';
  for (const value of sensitive) if (value) message = message.replaceAll(value, '[REDACTED]');
  return message.replace(/([?&]token=)[^&\s]+/gi, '$1[REDACTED]').slice(0, 1200);
}
async function request(path, method = 'GET', body, expectedStatus) {
  const response = await fetch(`${api}${path}`, {
    method, redirect: 'error', signal: AbortSignal.timeout(30_000),
    headers: { ...(cookie ? { cookie } : {}), ...(csrf && method !== 'GET' ? { [csrf.headerName]: csrf.csrfToken } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  if (expectedStatus !== undefined) {
    assert.equal(response.status, expectedStatus, `${method} ${path}: HTTP ${response.status}, expected ${expectedStatus}`);
    return null;
  }
  assert(response.ok, `${method} ${path}: HTTP ${response.status}`);
  const sessionCookie = response.headers.getSetCookie().find(value => /^space_session(?:_dev)?=/.test(value));
  if (sessionCookie) { cookie = sessionCookie.split(';', 1)[0]; sensitive.add(cookie); sensitive.add(cookie.split('=', 2)[1]); }
  return response.json();
}
async function terminalOutput(ticket) {
  assert(ticket?.token && ticket.sessionId && ticket.paneId, 'Missing terminal ticket');
  sensitive.add(ticket.token);
  const url = new URL(`${api.replace('http:', 'ws:')}/api/panes/${encodeURIComponent(ticket.paneId)}/cli/terminal`);
  url.search = new URLSearchParams({ sessionId: ticket.sessionId, token: ticket.token,
    clientId: randomUUID(), initialCols: '120', initialRows: '36' }).toString();
  return new Promise((resolveOutput, reject) => {
    const socket = new WebSocket(url, { headers: { cookie }, handshakeTimeout: 15_000 });
    terminalSockets.add(socket);
    let output = ''; let ready = false; let settled = false; let failure;
    const finish = (error) => {
      if (error) failure = error;
      if (settled) return;
      settled = true; clearTimeout(timeout);
      if (error) { socket.close(); reject(error); }
      else {
        const connection = {
          proof: { ready, outputBytes: Buffer.byteLength(output), outputSha256: createHash('sha256').update(output).digest('hex') },
          assertOpen: () => { if (failure) throw failure; assert.equal(socket.readyState, WebSocket.OPEN, 'Terminal transport closed during concurrent pane proof'); },
        };
        resolveOutput(connection);
      }
    };
    const timeout = setTimeout(() => finish(new Error('Timed out waiting for real terminal ready and printable output')), 90_000);
    socket.on('message', data => {
      try {
        const message = JSON.parse(data.toString());
        if (message.type === 'error') return finish(new Error('Terminal reported an error'));
        if (message.type === 'status' && ['EXITED', 'ERROR'].includes(message.status)) return finish(new Error('Terminal exited during acceptance'));
        if (message.type === 'ready') ready = true;
        if (message.type === 'output' && typeof message.data === 'string') output += message.data;
        // ANSI cursor motion alone is not evidence of a rendered terminal UI.
        const printable = output.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x20\x7f]/g, '');
        if (ready && printable.length >= 12) finish();
      } catch { finish(new Error('Invalid terminal protocol frame')); }
    });
    socket.on('error', () => finish(new Error('Terminal WebSocket connection failed')));
    socket.on('close', () => finish(new Error('Terminal closed during concurrent pane proof')));
  });
}

try {
  const health = await request('/readyz?strict=1');
  assert.equal(health.ok, true);
  for (const dependency of ['database', 'worker', 'cliHost']) assert.equal(health.dependencies?.[dependency], 'RUNNING', `${dependency} is not ready`);
  proof.checks.readiness = { database: 'RUNNING', worker: 'RUNNING', cliHost: 'RUNNING' };
  const page = await fetch(web, { signal: AbortSignal.timeout(15_000), redirect: 'error' });
  assert.equal(page.status, 200); assert((await page.text()).includes('id="root"'), 'Web app HTML is missing');
  proof.checks.web = true;
  stage = 'owner-claim';
  const status = await request('/api/setup/status');
  assert.equal(status.setupRequired, true, 'Use a fresh isolated stack; reset before repeating owner claim acceptance');
  // Only this stack-generated test token is read; passwords stay in memory.
  const token = (await readFile(resolve(state, 'secrets/setup-token'), 'utf8')).trim(); sensitive.add(token);
  const email = `dev-stack-${randomBytes(8).toString('hex')}@example.invalid`;
  const password = randomBytes(32).toString('base64url');
  sensitive.add(email); sensitive.add(password);
  const claim = await request('/api/setup/claim', 'POST', { token, email, password });
  assert.equal(claim.isAuthenticated, true); assert.equal(claim.user?.role, 'ADMIN'); assert(cookie, 'Claim did not set the session cookie');
  if (process.env.SPACE_DEV_SMOKE_KEEP_OWNER === '1') {
    // Explicit opt-in: synthetic disposable fixture only, never a cookie, ticket or setup token.
    await writeFile(resolve(state, 'test-owner.json'), `${JSON.stringify({ email, password })}\n`, { mode: 0o600, flag: 'wx' });
    proof.checks.syntheticOwnerFixtureSaved = true;
  }
  const ownerId = claim.user.id;
  stage = 'owner-logout-login';
  csrf = await request('/api/auth/csrf');
  sensitive.add(csrf.csrfToken);
  await request('/api/auth/logout', 'POST', {});
  cookie = ''; csrf = null;
  await request('/api/rooms', 'GET', undefined, 401);
  await request('/api/auth/login', 'POST', { email, password: `${password}-wrong` }, 401);
  const login = await request('/api/auth/login', 'POST', { email, password });
  assert.equal(login.user?.id, ownerId); assert.equal(login.isAuthenticated, true); assert(cookie);
  csrf = await request('/api/auth/csrf');
  sensitive.add(csrf.csrfToken);
  proof.checks.ownerClaimLogoutLogin = true;
  stage = 'getting-started';
  const rooms = await request('/api/rooms');
  const starter = rooms.data?.find(room => room.id === claim.starterRoomId);
  assert.equal(starter?.name, 'Getting Started');
  assert(starter?.id && starter.id === claim.starterRoomId, 'Getting Started must be the seeded starter room');
  // Longniang, 2026-10-28: public room paths use the existing sanitized room-ID namespace.
  const roomSlug = starter.id.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'room';
  const roomWorkspace = resolve(state, 'workspaces', roomSlug);
  assert(roomWorkspace.startsWith(resolve(state, 'workspaces') + '/'), 'Room workspace must remain inside the isolated development root');
  proof.checks.gettingStarted = true;
  stage = 'opencode-pane-create';
  const panes = await request(`/api/rooms/${encodeURIComponent(starter.id)}/panes`, 'POST', {
    panes: [{ mode: 'TERMINAL', terminalRuntimeId: 'cli:opencode' }, { mode: 'TERMINAL', terminalRuntimeId: 'cli:opencode' }]
  });
  assert.equal(panes.data?.length, 2, 'Expected two real OpenCode panes');
  const sessions = await Promise.all(panes.data.map(async pane => {
    assert(pane?.id); assert.equal(pane.terminalRuntimeId, 'cli:opencode');
    const sessionPath = `/api/panes/${encodeURIComponent(pane.id)}/cli/session`;
    await request(sessionPath, 'POST', { runtimeId: 'cli:opencode', includeTranscript: false });
    const active = await request(`${sessionPath}?includeTranscript=false`);
    assert(['IDLE', 'RUNNING'].includes(active?.session?.status), 'Allocated session must be IDLE or RUNNING');
    assert.equal(active?.session?.isActive, true);
    assert.equal(active?.runtime?.id, 'cli:opencode');
    assert.equal(active?.session?.cwd, roomWorkspace, 'Allocated terminal must use this room directory inside the isolated development workspace');
    return { paneId: pane.id, sessionPath, active };
  }));
  assert.equal(new Set(sessions.map(entry => entry.active.session.sessionId)).size, 2, 'Panes must have distinct host sessions');
  stage = 'opencode-concurrent-websocket-output';
  const connections = await Promise.all(sessions.map(entry => terminalOutput(entry.active.websocket)));
  stage = 'opencode-concurrent-running';
  let statuses;
  for (let attempt = 0; attempt < 30; attempt++) {
    for (const connection of connections) connection.assertOpen();
    statuses = await Promise.all(sessions.map(async entry => {
      const after = await request(`${entry.sessionPath}?includeTranscript=false`);
      assert.equal(after?.session?.sessionId, entry.active.session.sessionId, 'Terminal session changed after attach');
      assert.equal(after?.session?.isActive, true);
      assert(['IDLE', 'RUNNING'].includes(after.session.status), 'Unexpected attached session status');
      return after.session.status;
    }));
    if (statuses.every(status => status === 'RUNNING')) break;
    await delay(250);
  }
  assert.deepEqual(statuses, ['RUNNING', 'RUNNING']);
  await delay(5000);
  for (const connection of connections) connection.assertOpen();
  for (const entry of sessions) {
    const final = await request(`${entry.sessionPath}?includeTranscript=false`);
    assert.equal(final?.session?.sessionId, entry.active.session.sessionId);
    assert.equal(final?.session?.status, 'RUNNING');
    assert.equal(final?.session?.isActive, true);
  }
  proof.checks.terminalWorkspaceIsolated = true;
  proof.checks.concurrentTerminals = { count: 2, distinctSessions: true, statuses, overlapMs: 5000, terminals: connections.map(connection => connection.proof) };
  proof.passed = true;
} catch (error) {
  // Do not serialize server bodies, cookies, terminal text, tokens or generated passwords.
  proof.failure = safeMessage(error);
  proof.failedStage = stage;
  process.exitCode = 1;
} finally {
  for (const socket of terminalSockets) socket.terminate();
  await writeFile(resolve(state, 'smoke-proof.json'), `${JSON.stringify(proof, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify(proof));
}
