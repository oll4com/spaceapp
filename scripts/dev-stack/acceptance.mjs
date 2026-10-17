#!/usr/bin/env node
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { locations, loadOwner, readJson } from './state.mjs';
import { sameProcess, delay } from './processes.mjs';
import { browserProof, eventually } from './browser-proof.mjs';
import { assertLoopbackPublications, readOwnedPortPublications, run, dockerEnvironment } from './resources.mjs';
import { InteractiveTerminalProof, assertBrowserTerminal } from './terminal-proof.mjs';
import { extractPins } from './state.mjs';
import { verifyOpenCode } from './opencode-runtime.mjs';

const root = resolve(fileURLToPath(new URL('../..', import.meta.url))), config = locations(root, process.env), owner = await loadOwner(config);
const artifacts = process.env.SPACE_DEV_PROOF_DIR;
if (!artifacts) throw new Error('Set SPACE_DEV_PROOF_DIR to a private proof output directory outside the checkout/state.');
const proofRelative = relative(root, resolve(artifacts));
if (!proofRelative || (!proofRelative.startsWith('..') && !isAbsolute(proofRelative))) throw new Error('Proof output must be outside the checkout/state.');
await mkdir(artifacts, { recursive: true });
const origin = `http://127.0.0.1:${owner.ports.web}`, api = `http://127.0.0.1:${owner.ports.api}`;
let cookie = '', csrf = null, browser, terminal, interactive, password, token, ticketToken, native;
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
  token = await readFile(join(config.state, 'secrets/setup-token'), 'utf8');
  password = randomBytes(24).toString('hex'); const email = 'dev-stack-owner@example.invalid';
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
  ticketToken = ticket.token;
  const pins = extractPins(await readFile(join(root, 'packages/run-spaceapp/templates/compose.yml'), 'utf8'), await readFile(join(root, 'Dockerfile'), 'utf8'));
  const selected = await verifyOpenCode(config.state, pins.opencode);
  native = { version: selected.version, package: selected.package, relativeExecutable: selected.relativeExecutable, sha256: selected.sha256 };
  const url = new URL(`${api.replace('http:', 'ws:')}/api/panes/${encodeURIComponent(pane.id)}/cli/terminal`);
  for (const [k, v] of Object.entries({ sessionId: ticket.sessionId, token: ticket.token, clientId: randomUUID(), initialCols: '120', initialRows: '32' })) url.searchParams.set(k, v);
  terminal = new WebSocket(url, { headers: { cookie, origin } });
  interactive = new InteractiveTerminalProof(ticket.sessionId);
  terminal.on('open', () => interactive.open());
  terminal.on('error', error => interactive.error(error.code));
  terminal.on('close', code => interactive.close(code));
  terminal.on('message', chunk => { try { interactive.message(JSON.parse(chunk.toString())); } catch { interactive.fail('Malformed terminal WebSocket message.'); } });
  const currentSession = () => request(`/api/panes/${encodeURIComponent(pane.id)}/cli/session`);
  await eventually(async () => {
    interactive.assertHealthy();
    return interactive.live(await currentSession()) && interactive.sequence > 0;
  }, 'Current matching OpenCode API/WS session');
  browser = await browserProof({ state: config.state, origin, cookie, artifacts, paneId: pane.id });
  // Exercise real terminal keyboard input through the actual matching browser pane.
  // No Enter or provider/model command is sent: only a local palette and filter.
  const deadline = Date.now() + 120000;
  const waitInteractive = async (predicate, label) => eventually(async () => { interactive.assertHealthy(); const response = await currentSession(); return interactive.live(response) && await predicate(response); }, label, Math.max(1, deadline - Date.now()));
  let transition = await waitInteractive(response => interactive.beginScreenTransition('open', response), 'Known closed-menu pre-input screen');
  await browser.key('Ctrl+P');
  await waitInteractive(response => interactive.screenTransition(transition, response), 'Fresh pinned OpenCode command menu after Ctrl+P');
  await browser.screenshot('opencode-command-menu.png');
  const challenge = `spaceproof${randomBytes(8).toString('hex')}`;
  transition = await waitInteractive(response => interactive.beginScreenTransition('filter', response, challenge), 'Known unfiltered menu without the new challenge');
  await browser.key('text', challenge);
  await waitInteractive(response => interactive.screenTransition(transition, response), 'Fresh unique palette filter response on the current terminal screen');
  await browser.screenshot('opencode-filter-response.png');
  transition = await waitInteractive(response => interactive.beginScreenTransition('dismiss', response, challenge), 'Known current filtered menu before dismissal');
  await browser.key('Escape');
  await waitInteractive(response => interactive.screenTransition(transition, response), 'Fresh screen with the menu and challenge dismissed');
  transition = await waitInteractive(response => interactive.beginScreenTransition('open', response), 'Known closed-menu screen before reopening');
  await browser.key('Ctrl+P');
  await waitInteractive(response => interactive.screenTransition(transition, response), 'Fresh command menu after dismissal and reopening');
  const browserState = await browser.terminalState(); assertBrowserTerminal(browserState, pane.id);
  await browser.screenshot('opencode-pane.png');
  interactive.seal(await currentSession());
  await writeFile(join(artifacts, 'opencode-interactive-proof.json'), JSON.stringify({ source: process.env.SPACE_DEV_CANDIDATE, platform: process.platform, native, browser: browserState, terminal: interactive.diagnostic([cookie, ticket.token, password, token]), challenge, transitions: ['Ctrl+P -> fresh Commands and registered menu entries', 'unique palette filter -> fresh matching response', 'Escape -> fresh response', 'Ctrl+P -> fresh full command menu'], modelInference: false }, null, 2) + '\n', { mode: 0o600 });
  terminal.close(); marker('actual pinned OpenCode command menu, reversible filter, current API/WS and matching live browser pane; no model prompt sent');
  const services = await readOwnedPortPublications(config, owner);
  // Preserve actual selected metadata before validation, including failures; no environment or command fields.
  await writeFile(join(artifacts, 'docker-port-bindings.json'), JSON.stringify({ source: process.env.SPACE_DEV_CANDIDATE, platform: process.platform, services }, null, 2) + '\n', { mode: 0o600 });
  assertLoopbackPublications(services, owner.ports); marker('exact expected Docker service ports bind only loopback');
  // Read-only host socket listings: assert all relevant Node listeners use loopback as well.
  const sockets = await run(process.platform === 'darwin' ? 'lsof' : 'ss', process.platform === 'darwin' ? ['-nP', '-iTCP', '-sTCP:LISTEN'] : ['-ltn'], { env: dockerEnvironment() });
  for (const port of [owner.ports.api, owner.ports.web]) {
    const lines = sockets.split('\n').filter(x => new RegExp(`:${port}(?:\\s|$)`).test(x)); assert(lines.length > 0); assert(lines.every(x => x.includes(`127.0.0.1:${port}`)));
  } marker('API and Vite bind only loopback');
  marker('actual browser Getting Started and tested live terminal rendering');
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
} catch (error) {
  // Selected synthetic state only. Never serialize a session response, ticket,
  // cookie, websocket URL, environment or real provider/owner credentials.
  const failureBrowser = error.browserRuntime || browser?.diagnostic('interactive-proof');
  if (browser) await browser.failureScreenshot().catch(() => {});
  if (interactive) await writeFile(join(artifacts, 'opencode-failure.json'), JSON.stringify({ source: process.env.SPACE_DEV_CANDIDATE, platform: process.platform, native, terminal: interactive.diagnostic([cookie, cookie.split('=').slice(1).join('='), password, token, ticketToken, csrf?.csrfToken]), browser: await browser?.terminalState().catch(() => null), browserStartup: error.browserStartup, browserRuntime: failureBrowser }, null, 2) + '\n', { mode: 0o600 });
  throw error;
} finally {
  try { if (interactive) await writeFile(join(artifacts, 'opencode-terminal-stream.json'), JSON.stringify({ source: process.env.SPACE_DEV_CANDIDATE, platform: process.platform, ...interactive.streamEvidence([cookie, cookie.split('=').slice(1).join('='), password, token, ticketToken, csrf?.csrfToken]) }, null, 2) + '\n', { mode: 0o600 }); }
  finally { terminal?.close(); await browser?.close(); }
}
