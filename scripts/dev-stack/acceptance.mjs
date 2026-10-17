#!/usr/bin/env node
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripVTControlCharacters } from 'node:util';
import WebSocket from 'ws';
import { locations, loadOwner, readJson } from './state.mjs';
import { sameProcess, delay } from './processes.mjs';
import { browserProof, eventually } from './browser-proof.mjs';
import { assertLoopbackPublications, readOwnedPortPublications, run, dockerEnvironment } from './resources.mjs';

const root = resolve(fileURLToPath(new URL('../..', import.meta.url))), config = locations(root, process.env), owner = await loadOwner(config);
const artifacts = process.env.SPACE_DEV_PROOF_DIR;
if (!artifacts) throw new Error('Set SPACE_DEV_PROOF_DIR to a private proof output directory outside the checkout/state.');
const proofRelative = relative(root, resolve(artifacts));
if (!proofRelative || (!proofRelative.startsWith('..') && !isAbsolute(proofRelative))) throw new Error('Proof output must be outside the checkout/state.');
await mkdir(artifacts, { recursive: true });
const origin = `http://127.0.0.1:${owner.ports.web}`, api = `http://127.0.0.1:${owner.ports.api}`;
let cookie = '', csrf = null, browser, terminal;
const checks = [];
async function request(path, body, expected = 200) {
  const response = await fetch(`${api}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { ...(cookie ? { cookie } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(csrf ? { [csrf.headerName]: csrf.csrfToken } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15000) });
  assert.equal(response.status, expected, `${path} status (no credentials/response body included)`);
  if (response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
  return response.json();
}
const marker = name => { checks.push(name); console.log(`[dev-stack-proof] PASS ${name}`); };
async function pid(name) { return (await readJson(config.supervisor)).children.find(x => x.name === name); }
try {
  await eventually(async () => { const response = await fetch(`${api}/readyz`, { signal: AbortSignal.timeout(3000) }); const value = await response.json(); return response.ok && value.ok === true; }, 'Workflows-enabled readyz'); marker('real readiness');
  assert.equal((await (await fetch(`${origin}/readyz`)).json()).ok, true); marker('Vite forwards to the isolated API port');
  for (const name of ['postgres-password', 'session-secret', 'setup-token']) assert.equal((await stat(join(config.state, 'secrets', name))).mode & 0o777, 0o600);
  assert.equal((await stat(config.compose)).mode & 0o777, 0o600); marker('all generated secret/config files0600');
  const token = await readFile(join(config.state, 'secrets/setup-token'), 'utf8');
  const password = randomBytes(24).toString('hex'), email = 'dev-stack-owner@example.invalid';
  const claimed = await request('/api/setup/claim', { token, email, password }); assert.equal(claimed.isAuthenticated, true);
  await request('/api/setup/claim', { token, email, password }, 409); marker('normal one-use owner claim');
  await request('/api/auth/login', { email, password }); csrf = await request('/api/auth/csrf'); marker('normal owner sign-in');
  const starter = await request('/api/setup/starter-room', {}); assert.equal(starter.room.name, 'Getting Started');
  await request('/api/setup/finish', {});
  const catalog = await request(`/api/panes?roomId=${encodeURIComponent(starter.room.id)}`);
  let pane = catalog.data.find(x => x.terminalRuntimeId === 'cli:opencode');
  if (!pane) pane = await request('/api/panes', { roomId: starter.room.id, title: 'OpenCode CLI', mode: 'TERMINAL', terminalRuntimeId: 'cli:opencode', cwd: join(config.state, 'workspaces') });
  const started = await request(`/api/panes/${encodeURIComponent(pane.id)}/cli/session`, { runtimeId: 'cli:opencode' });
  const ticket = started.websocket; assert(ticket?.token && ticket.sessionId);
  const url = new URL(`${api.replace('http:', 'ws:')}/api/panes/${encodeURIComponent(pane.id)}/cli/terminal`);
  for (const [k, v] of Object.entries({ sessionId: ticket.sessionId, token: ticket.token, clientId: randomUUID(), initialCols: '120', initialRows: '32' })) url.searchParams.set(k, v);
  terminal = new WebSocket(url, { headers: { cookie, origin } });
  let ui = '', running = false, terminalError;
  terminal.on('error', error => { terminalError = error; });
  terminal.on('message', chunk => { const event = JSON.parse(chunk.toString()); if (event.type === 'output') ui += event.data; if (event.type === 'status' && event.status === 'RUNNING') running = true; });
  await eventually(async () => {
    const current = await request(`/api/panes/${encodeURIComponent(pane.id)}/cli/session`);
    running ||= current?.session?.status === 'RUNNING';
    if (terminalError) throw new Error('Actual CLI terminal WebSocket failed.');
    return running && /opencode/i.test(stripVTControlCharacters(ui));
  }, 'Real pinned OpenCode PTY terminal UI'); marker('source CLI host/PTY and actual OpenCode UI; no model prompt sent');
  const services = await readOwnedPortPublications(config, owner);
  // Preserve actual selected metadata before validation, including failures; no environment or command fields.
  await writeFile(join(artifacts, 'docker-port-bindings.json'), JSON.stringify({ source: process.env.SPACE_DEV_CANDIDATE, platform: process.platform, services }, null, 2) + '\n', { mode: 0o600 });
  assertLoopbackPublications(services, owner.ports); marker('exact expected Docker service ports bind only loopback');
  // Read-only host socket listings: assert all relevant Node listeners use loopback as well.
  const sockets = await run(process.platform === 'darwin' ? 'lsof' : 'ss', process.platform === 'darwin' ? ['-nP', '-iTCP', '-sTCP:LISTEN'] : ['-ltn'], { env: dockerEnvironment() });
  for (const port of [owner.ports.api, owner.ports.web]) {
    const lines = sockets.split('\n').filter(x => new RegExp(`:${port}(?:\\s|$)`).test(x)); assert(lines.length > 0); assert(lines.every(x => x.includes(`127.0.0.1:${port}`)));
  } marker('API and Vite bind only loopback');
  browser = await browserProof({ state: config.state, origin, cookie, artifacts }); marker('actual browser Getting Started/terminal rendering');
  const css = join(root, 'apps/web/src/styles.css'), originalCss = await readFile(css), canary = `proof-${randomUUID()}`;
  const timeOrigin = await browser.evaluate('performance.timeOrigin');
  try {
    await writeFile(css, Buffer.concat([originalCss, Buffer.from(`\nhtml { --space-dev-proof: "${canary}"; }\n`)]));
    await eventually(() => browser.evaluate(`getComputedStyle(document.documentElement).getPropertyValue('--space-dev-proof').includes(${JSON.stringify(canary)})`), 'Browser CSS HMR');
    assert.equal(await browser.evaluate('performance.timeOrigin'), timeOrigin, 'CSS hot reload must not require navigation/reload');
    await browser.screenshot('web-hmr.png'); marker('real web CSS HMR without page navigation');
  } finally { await writeFile(css, originalCss); }
  const apiSource = join(root, 'apps/api/src/server.ts'), originalApi = await readFile(apiSource), oldApi = await pid('api');
  try {
    await writeFile(apiSource, Buffer.concat([originalApi, Buffer.from(`\n// dev-stack reload proof ${canary}\n`)]));
    await eventually(async () => { const next = await pid('api'); return next && next.pid !== oldApi.pid && await sameProcess(next); }, 'API source restart');
    await eventually(async () => (await (await fetch(`${api}/readyz`)).json()).ok === true, 'Ready after API restart'); marker('API source restart and readiness');
  } finally { await writeFile(apiSource, originalApi); }
  // Wait for the restoration-triggered API restart before testing a package rebuild.
  await delay(1500);
  const workerBefore = await pid('worker'), apiBefore = await pid('api');
  const packageFile = join(root, 'packages/contracts/src/index.ts'), originalPackage = await readFile(packageFile);
  try {
    await writeFile(packageFile, Buffer.concat([originalPackage, Buffer.from(`\nexport const spaceDevStackProofCanary = ${JSON.stringify(canary)};\n`)]));
    await eventually(async () => { const w = await pid('worker'), p = await pid('api'); return w && p && w.pid !== workerBefore.pid && p.pid !== apiBefore.pid && await sameProcess(w) && await sameProcess(p); }, 'Rebuilt package picked up by API/worker', 300000);
    await eventually(async () => (await (await fetch(`${api}/readyz`)).json()).ok === true, 'Ready after package rebuild'); marker('shared package rebuilt and API/worker restarted');
    assert((await readFile(join(root, 'packages/contracts/dist/index.js'), 'utf8')).includes(canary), 'Changed shared package source must actually reach built output');
  } finally { await writeFile(packageFile, originalPackage); }
  await writeFile(join(artifacts, 'acceptance.json'), JSON.stringify({ source: process.env.SPACE_DEV_CANDIDATE, platform: process.platform, checks, model_inference: false, real_operator_data: false }, null, 2) + '\n');
} finally { terminal?.close(); await browser?.close(); }
