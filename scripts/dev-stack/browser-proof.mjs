import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import WebSocket from 'ws';
import { delay, descendants, processIdentity, sameProcess, stopRecorded } from './processes.mjs';
import { assertBrowserTerminal } from './terminal-proof.mjs';

const execute = promisify(execFile);
export function assertBrowserRunning(child, startError) {
  if (startError || child.exitCode !== null || child.signalCode !== null) throw Object.assign(new Error(`Hosted Chrome ended before CDP (${startError?.code || child.signalCode || child.exitCode}).`), { fatal: true });
}
export function safeBrowserStderr(text) {
  return String(text).replace(/wss?:\/\/[^\s"']+/gi, '[redacted websocket endpoint]').replace(/((?:token|password|secret|cookie)=)[^\s"']+/gi, '$1[redacted]').slice(-6000);
}
export function proofBrowserArguments(profile, { platform = process.platform, ci = process.env.CI } = {}) {
  // Only a fresh task-owned proof profile reaches this helper. Chromium documents
  // this Mac test switch to avoid real-keychain dialogs; no owner browser changes.
  return ['--headless=new', '--disable-dev-shm-usage', '--no-first-run', '--no-default-browser-check', '--disable-background-networking', ...(platform === 'darwin' && ci === 'true' ? ['--use-mock-keychain'] : []), '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'];
}
export function selectedBrowserDiagnostic({ profile, tmpdir, binaryVersion, versionError, child, startError, stderr, socket, failedCdpMethod, ciMockKeychainConfigured = false }, phase) {
  return { platform: process.platform, phase, profile, tmpdir, binaryVersion, versionError, ciMockKeychainConfigured, exitCode: child.exitCode, signalCode: child.signalCode, startErrorCode: startError?.code ?? null, cdpSocketState: socket?.readyState ?? null, failedCdpMethod: failedCdpMethod ?? null, stderr: safeBrowserStderr(stderr) };
}
export async function syntheticCookieCapability(call, value, diagnostic = () => null) {
  assert(typeof value === 'string' && /^[a-z0-9]{1,64}$/.test(value), 'Only the synthetic local challenge is permitted.');
  const url = 'http://127.0.0.1/', name = 'spaceapp-dev-proof';
  let phase = 'enable', failure;
  try {
    await call('Network.enable'); phase = 'set';
    assert.equal((await call('Network.setCookie', { url, name, value, httpOnly: true, sameSite: 'Lax' })).success, true, 'Synthetic cookie set must report success.');
    phase = 'get'; const jar = await call('Network.getCookies', { urls: [url] }), matching = jar.cookies?.filter(cookie => cookie.name === name);
    assert.equal(matching?.length, 1, 'Exactly one synthetic cookie must be read back.');
    assert(matching[0].value === value && matching[0].httpOnly === true && matching[0].sameSite === 'Lax' && matching[0].domain === '127.0.0.1', 'Synthetic cookie value and native attributes must match.');
  } catch (error) { error.browserRuntime = diagnostic(`synthetic-cookie-${phase}`); failure = error; }
  try {
    phase = 'delete'; await call('Network.deleteCookies', { url, name });
    phase = 'delete-readback'; const jar = await call('Network.getCookies', { urls: [url] });
    assert(Array.isArray(jar.cookies) && !jar.cookies.some(cookie => cookie.name === name), 'Synthetic cookie deletion must be read back.');
  } catch (error) {
    if (failure) failure.cookieCleanupError = { name: error.name, phase };
    else { error.browserRuntime = diagnostic(`synthetic-cookie-${phase}`); failure = error; }
  }
  if (failure) throw failure;
  return { syntheticLoopbackOnly: true, httpOnly: true, sameSite: 'Lax', exactSetGetMatch: true, deletionReadback: true, navigationOrFetchSent: false, valueRecorded: false };
}

export async function typeTerminalFilter(call, text) {
  assert(typeof text === 'string' && /^[a-z0-9]{1,64}$/.test(text), 'Only the synthetic local palette filter is permitted.');
  // Chromium's keyboard event text has a tiny UTF-16 buffer. Await each actual
  // character event: preserve the challenge/order without a paste or Enter.
  for (const character of text) await call('Input.dispatchKeyEvent', { type: 'char', text: character });
}

export async function eventually(fn, label, timeout = 120000) {
  const until = Date.now() + timeout; let last;
  while (Date.now() < until) { try { const value = await fn(); if (value) return value; } catch (error) { if (error.fatal) throw error; last = error; } await delay(400); }
  throw new Error(`${label} did not succeed${last ? ` (${last.message})` : ''}.`);
}
async function openProofBrowser(state) {
  const binary = process.env.SPACE_DEV_BROWSER || (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : '/usr/bin/google-chrome');
  if (!existsSync(binary)) throw new Error('Hosted Chrome is missing. Set SPACE_DEV_BROWSER to an existing reviewed browser; no hidden download/fallback.');
  const profile = join(state, 'browser-proof'); await mkdir(profile, { mode: 0o700 });
  const env = { PATH: process.env.PATH, HOME: join(state, 'home'), TMPDIR: join(state, 'tmp') };
  let binaryVersion = null, versionError = null;
  try { binaryVersion = (await execute(binary, ['--version'], { env, timeout: 10000, maxBuffer: 4096, killSignal: 'SIGKILL', encoding: 'utf8' })).stdout.trim().slice(0, 160); }
  catch (error) { versionError = { name: error.name, code: error.code ?? null, signal: error.signal ?? null }; }
  const args = proofBrowserArguments(profile), ciMockKeychainConfigured = args.includes('--use-mock-keychain');
  const child = spawn(binary, args, { stdio: ['ignore', 'ignore', 'pipe'], env });
  let startError, stderr = '';
  child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-8192); });
  child.once('error', error => { startError = error; });
  const identity = new Promise(done => { child.once('spawn', () => { void processIdentity(child.pid).then(value => done({ pid: child.pid, identity: value }), () => done(null)); }); child.once('error', () => done(null)); });
  let socket, next = 1, failedCdpMethod = null; const pending = new Map();
  const diagnostic = phase => selectedBrowserDiagnostic({ profile, tmpdir: env.TMPDIR, binaryVersion, versionError, child, startError, stderr, socket, failedCdpMethod, ciMockKeychainConfigured }, phase);
  async function close() {
    if (socket?.readyState === WebSocket.OPEN) socket.close();
    const original = await identity;
    if (original && await sameProcess(original)) await stopRecorded(await descendants(original));
  }
  try {
    const [port, path] = (await eventually(async () => { assertBrowserRunning(child, startError); return (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).trim(); }, 'Chrome CDP startup')).split('\n');
    socket = new WebSocket(`ws://127.0.0.1:${port}${path}`);
    await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
    socket.on('message', data => { const response = JSON.parse(data.toString()); const item = pending.get(response.id); if (item) { pending.delete(response.id); clearTimeout(item.timer); if (response.error) { failedCdpMethod = item.method; item.reject(new Error(response.error.message)); } else item.resolve(response.result); } });
    const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
      const id = next++, timer = setTimeout(() => { pending.delete(id); failedCdpMethod = method; reject(new Error(`CDP ${method} timed out.`)); }, 30000);
      pending.set(id, { resolve, reject, timer, method }); socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
    const version = await send('Browser.getVersion');
    const target = await send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
    const call = (method, params) => send(method, params, sessionId);
    const evaluate = async expression => { const result = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (result.exceptionDetails) throw new Error('Browser evaluation failed.'); return result.result.value; };
    return { call, evaluate, close, diagnostic, version: { product: version.product, protocolVersion: version.protocolVersion, binaryVersion, ciMockKeychainConfigured } };
  } catch (error) {
    error.browserStartup = diagnostic('startup');
    await close(); throw error;
  }
}
export async function browserKeyboardCapability({ state, artifacts, challenge }) {
  const proof = { source: process.env.SPACE_DEV_CANDIDATE, platform: process.platform, challengeLength: challenge.length, phase: 'browser-startup', cookie: null, baseline: null, perCharacter: null, ok: false };
  let browser;
  try {
    browser = await openProofBrowser(state);
    const { call, evaluate } = browser; proof.browser = browser.version;
    proof.phase = 'synthetic-loopback-cookie';
    proof.cookie = await syntheticCookieCapability(call, challenge, browser.diagnostic);
    proof.phase = 'blank-page-keyboard';
    // Task-owned about:blank only; no account, external page, app session or model.
    await call('Page.enable');
    await eventually(() => evaluate('Boolean(document.body)'), 'Synthetic blank-page readiness', 10000);
    await evaluate('document.body.innerHTML = "<textarea id=filter></textarea>"; document.getElementById("filter").focus()');
    try {
      await call('Input.dispatchKeyEvent', { type: 'char', text: challenge });
      proof.baseline = { rejected: false, deliveredExactText: await evaluate(`document.getElementById('filter').value === ${JSON.stringify(challenge)}`) };
    } catch (error) {
      if (!/Invalid ['"]text['"] parameter/.test(error.message)) throw error;
      proof.baseline = { rejected: true, error: 'Invalid text parameter', deliveredNoText: await evaluate('document.getElementById("filter").value === ""') };
      assert.equal(proof.baseline.deliveredNoText, true);
    }
    await evaluate('document.getElementById("filter").value = ""; document.getElementById("filter").focus()');
    await typeTerminalFilter(call, challenge);
    assert.equal(await evaluate(`document.getElementById('filter').value === ${JSON.stringify(challenge)}`), true, 'Actual Chrome must receive every serial character in exact order.');
    proof.perCharacter = { eventCount: challenge.length, maxUtf16UnitsPerEvent: 1, deliveredExactText: true, enterOrPasteSent: false };
    proof.phase = 'complete'; proof.ok = true; return proof;
  } catch (error) { proof.error = { name: error.name, message: error.message.slice(0, 300) }; if (error.browserStartup) proof.startup = error.browserStartup; else if (browser) proof.runtime = error.browserRuntime || browser.diagnostic(proof.phase); if (error.cookieCleanupError) proof.cookieCleanupError = error.cookieCleanupError; throw error;
  } finally { await mkdir(artifacts, { recursive: true }); await writeFile(join(artifacts, 'early-browser-keyboard-capability.json'), JSON.stringify(proof, null, 2) + '\n', { mode: 0o600 }); await browser?.close(); }
}
export async function browserProof({ state, origin, cookie, artifacts, paneId }) {
  const { call, evaluate, close, diagnostic } = await openProofBrowser(state);
  try {
    await call('Page.enable'); await call('Network.enable');
    const index = cookie.indexOf('=');
    assert(index > 0); await call('Network.setCookie', { url: origin, name: cookie.slice(0, index), value: cookie.slice(index + 1), httpOnly: true, sameSite: 'Lax' });
    await call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
    await call('Page.navigate', { url: `${origin}/` });
    await eventually(() => evaluate('document.body.innerText.toLowerCase().includes("getting started")'), 'Actual Getting Started web room');
    await evaluate(`(() => { const room = [...document.querySelectorAll('button,[role="button"]')].find(x => /getting started/i.test(x.textContent || x.getAttribute('title') || '')); room?.click(); return Boolean(room); })()`);
    const paneExpression = `document.querySelector('[data-space-pane-id="' + CSS.escape(${JSON.stringify(paneId)}) + '"]')`;
    const terminalState = () => evaluate(`(() => { const pane = ${paneExpression}, terminal = pane?.querySelector('.terminal-pane'); if (!terminal) return null; return { paneId: pane.dataset.spacePaneId, status: terminal.dataset.terminalStatus, hasSession: terminal.dataset.terminalHasSession, hasWebsocket: terminal.dataset.terminalHasWebsocket, hasError: terminal.dataset.terminalHasError, width: terminal.querySelector('.xterm-screen')?.getBoundingClientRect().width || 0 }; })()`);
    await eventually(async () => { const current = await terminalState(); assertBrowserTerminal(current, paneId); return current; }, 'Matching attached error-free terminal in the actual browser');
    await mkdir(artifacts, { recursive: true });
    const key = async (name, text) => {
      assertBrowserTerminal(await terminalState(), paneId);
      assert.equal(await evaluate(`(() => { const input = ${paneExpression}?.querySelector('.xterm-helper-textarea'); input?.focus(); return document.activeElement === input; })()`), true, 'Keyboard must target the tested terminal.');
      if (text) await typeTerminalFilter(call, text);
      else {
        const params = name === 'Ctrl+P' ? { key: 'p', code: 'KeyP', windowsVirtualKeyCode: 80, modifiers: 2 } : { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 };
        await call('Input.dispatchKeyEvent', { type: 'keyDown', ...params }); await call('Input.dispatchKeyEvent', { type: 'keyUp', ...params });
      }
    };
    const capture = async name => writeFile(join(artifacts, name), Buffer.from((await call('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
    return { evaluate, terminalState, key, diagnostic, async screenshot(name) { assertBrowserTerminal(await terminalState(), paneId); await capture(name); }, async failureScreenshot() { await capture('opencode-failure.png'); }, close };
  } catch (error) { error.browserRuntime = diagnostic('application-browser'); await close(); throw error; }
}
