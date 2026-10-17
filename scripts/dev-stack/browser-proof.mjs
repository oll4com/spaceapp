import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import WebSocket from 'ws';
import { delay, descendants, processIdentity, sameProcess, stopRecorded } from './processes.mjs';
import { assertBrowserTerminal } from './terminal-proof.mjs';

export async function eventually(fn, label, timeout = 120000) {
  const until = Date.now() + timeout; let last;
  while (Date.now() < until) { try { const value = await fn(); if (value) return value; } catch (error) { if (error.fatal) throw error; last = error; } await delay(400); }
  throw new Error(`${label} did not succeed${last ? ` (${last.message})` : ''}.`);
}
export async function browserProof({ state, origin, cookie, artifacts, paneId }) {
  const binary = process.env.SPACE_DEV_BROWSER || (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : '/usr/bin/google-chrome');
  if (!existsSync(binary)) throw new Error('Hosted Chrome is missing. Set SPACE_DEV_BROWSER to an existing reviewed browser; no hidden download/fallback.');
  const profile = join(state, 'browser-proof'); await mkdir(profile, { mode: 0o700 });
  const child = spawn(binary, ['--headless=new', '--disable-dev-shm-usage', '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore', env: { PATH: process.env.PATH, HOME: join(state, 'home'), TMPDIR: join(state, 'tmp') } });
  let startError;
  child.once('error', error => { startError = error; });
  const identity = new Promise(done => { child.once('spawn', () => { void processIdentity(child.pid).then(value => done({ pid: child.pid, identity: value }), () => done(null)); }); child.once('error', () => done(null)); });
  let socket, next = 1; const pending = new Map();
  async function close() {
    if (socket?.readyState === WebSocket.OPEN) socket.close();
    const original = await identity;
    if (original && await sameProcess(original)) await stopRecorded(await descendants(original));
  }
  try {
    const [port, path] = (await eventually(async () => { if (startError || child.exitCode !== null) throw new Error('Hosted Chrome failed to start.'); return (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).trim(); }, 'Chrome CDP startup')).split('\n');
    socket = new WebSocket(`ws://127.0.0.1:${port}${path}`);
    await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
    socket.on('message', data => { const response = JSON.parse(data.toString()); const item = pending.get(response.id); if (item) { pending.delete(response.id); clearTimeout(item.timer); if (response.error) item.reject(new Error(response.error.message)); else item.resolve(response.result); } });
    const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
      const id = next++, timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP ${method} timed out.`)); }, 30000);
      pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
    const target = await send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
    const call = (method, params) => send(method, params, sessionId);
    const evaluate = async expression => { const result = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (result.exceptionDetails) throw new Error('Browser evaluation failed.'); return result.result.value; };
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
      if (text) await call('Input.dispatchKeyEvent', { type: 'char', text });
      else {
        const params = name === 'Ctrl+P' ? { key: 'p', code: 'KeyP', windowsVirtualKeyCode: 80, modifiers: 2 } : { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 };
        await call('Input.dispatchKeyEvent', { type: 'keyDown', ...params }); await call('Input.dispatchKeyEvent', { type: 'keyUp', ...params });
      }
    };
    return { evaluate, terminalState, key, async screenshot(name) { assertBrowserTerminal(await terminalState(), paneId); await writeFile(join(artifacts, name), Buffer.from((await call('Page.captureScreenshot', { format: 'png' })).data, 'base64')); }, close };
  } catch (error) { await close(); throw error; }
}
