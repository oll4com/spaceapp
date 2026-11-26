import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { WebSocketServer } from 'ws';
import { describe, expect, it, vi } from 'vitest';
import { defaultFreelanceCopilotPaneMetadata } from '@space/contracts';
import { InMemorySpaceStore } from '@space/runtime';
const mocks = vi.hoisted(() => ({ spawn: vi.fn(), xvfbPid: 0, pactl: '[]' as string | null, chromeVersion: null as string | null }));
vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const { promisify } = await import('node:util');
  // pactl (the sound check of the idle sweep) answers from the test, null as a refusing sound server; the rest run.
  const execFile = Object.assign((command: string, ...rest: unknown[]) => {
    // `chrome --version` (the headless user agent, light browser step 5) answers from the test when it names a version.
    if (command === process.execPath && (rest[0] as string[])[0] === '--version' && mocks.chromeVersion) {
      const done = rest.at(-1) as (error: Error | null, stdout: string) => void;
      setImmediate(() => done(null, mocks.chromeVersion!));
      return new EventEmitter();
    }
    if (command !== 'pactl') return (actual.execFile as (...args: unknown[]) => unknown)(command, ...rest);
    const done = rest.at(-1) as (error: Error | null, stdout: string) => void;
    const answer = mocks.pactl;
    setImmediate(() => answer === null ? done(new Error('Connection failure: Access denied'), '') : done(null, answer));
    return new EventEmitter();
  }, { [promisify.custom]: (command: string, ...rest: unknown[]) => command === 'pactl'
    // The sweep's pactl runs through promisify (236385d7c5): answer it here too, or the real pactl's failure freezes nothing.
    ? (mocks.pactl === null ? Promise.reject(new Error('Connection failure: Access denied')) : Promise.resolve({ stdout: mocks.pactl, stderr: '' }))
    : ((actual.execFile as unknown as Record<symbol, (...args: unknown[]) => unknown>)[promisify.custom])(command, ...rest) });
  return { ...actual, spawn: mocks.spawn, execFile };
});
vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    accessSync: (path: string, mode?: number) => { if (!String(path).startsWith('/tmp/.X11-unix/')) actual.accessSync(path, mode); },
    // The display counts as ready only when its lock names the Xvfb the manager started.
    readFileSync: ((path: unknown, ...rest: unknown[]) => /^\/tmp\/\.X\d+-lock$/.test(String(path))
      ? `${String(mocks.xvfbPid).padStart(10)}\n`
      : (actual.readFileSync as (...args: unknown[]) => unknown)(path, ...rest)) as typeof actual.readFileSync
  };
});
import { ORPHAN_CHROME_GRACE_MS, allocateDisplay, browserSessionDisplayCapacity, createBrowserSessionManager, releaseDisplay, stopChromeAndDisplay } from '../src/browser-sessions.js';
import { getApiConfig } from '../src/config.js';

async function fixture(mode: 'BROWSER' | 'YOUTUBE' | 'FREELANCE_COPILOT' = 'YOUTUBE', profile = 'profile', cdpSendTimeoutMs?: number) {
  const root = await mkdtemp(join(tmpdir(), 'browser-lifecycle-'));
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise<void>(resolve => server.once('listening', resolve));
  const port = (server.address() as { port: number }).port;
  const cdpMethods: string[] = [];
  const scriptSources: string[] = [];
  let currentUrl: string | null = null;
  let targets = 0;
  // One Chrome window: the manager's moves of it (CPU plan 5.1); Target.getTargets lists the pages only once asked.
  const win = { left: 10, top: 10, width: 1440, height: 900, windowState: 'normal' };
  const windowMoves: unknown[] = [];
  // The pages' lifecycle states the manager set (light browser step 4), and whether the page plays a <video>/<audio>.
  const lifecycle: string[] = [];
  let mediaPlaying = false;
  let windowMovesFail = false;
  let listTargets = false;
  // A Chrome that stops answering (API audit 16/11): commands arrive and are never answered.
  let muted = false;
  server.on('connection', socket => socket.on('message', data => {
    const { id, method, sessionId, params } = JSON.parse(data.toString());
    cdpMethods.push(method);
    if (muted) return;
    if (method === 'Page.addScriptToEvaluateOnNewDocument' && typeof params?.source === 'string') scriptSources.push(params.source);
    if (method === 'Page.navigate') currentUrl = params.url;
    if (method === 'Browser.setWindowBounds' && windowMovesFail) { socket.send(JSON.stringify({ id, error: { code: -32000, message: 'Browser window not found' } })); return; }
    if (method === 'Browser.setWindowBounds') { windowMoves.push(params.bounds); Object.assign(win, params.bounds); }
    if (method === 'Page.setWebLifecycleState') lifecycle.push(`${params.state}:${sessionId}`);
    if (method === 'Browser.close') {
      const chrome = children.find(child => child.command === process.execPath && child.exitCode === null && child.signalCode === null);
      if (chrome) { chrome.exitCode = 0; chrome.emit('exit', 0, null); }
    }
    const result = method === 'Target.createTarget' ? { targetId: `page:test:${++targets}` }
      : method === 'Target.attachToTarget' ? { sessionId: `cdp:${params.targetId}` }
      : method === 'Page.captureScreenshot' ? { data: 'iVBORw0KGgo=' }
      : method === 'Runtime.evaluate' && String(params?.expression).includes("querySelectorAll('video, audio')") ? { result: { value: mediaPlaying } }
      : method === 'Runtime.evaluate' ? { result: { value: { href: currentUrl === 'about:blank' ? null : currentUrl, title: 'Lifecycle proof', scrollX: 0, scrollY: 0, videoPaused: null } } }
      : method === 'Browser.getWindowForTarget' ? { windowId: 1, bounds: { ...win } }
      : method === 'Target.getTargets' && listTargets ? { targetInfos: Array.from({ length: targets }, (_, index) => ({ targetId: `page:test:${index + 1}`, type: 'page' })) }
      : {};
    socket.send(JSON.stringify({ id, result, ...(sessionId ? { sessionId } : {}) }));
    if (method === 'Page.navigate') socket.send(JSON.stringify({ method: 'Page.loadEventFired', sessionId, params: {} }));
  }));
  const children: Array<EventEmitter & { command: string; args: string[]; env?: NodeJS.ProcessEnv; exitCode: number | null; signalCode: string | null; stdout: PassThrough; stderr: PassThrough; kill: (signal: string) => boolean }> = [];
  let releaseChrome: (() => void) | undefined;
  let holdChrome = false;
  mocks.spawn.mockImplementation((command: string, args: string[] = [], options?: { env?: NodeJS.ProcessEnv }) => {
    const pid = 40_000 + children.length;
    if (command === '/fixture/Xvfb') mocks.xvfbPid = pid;
    const child = Object.assign(new EventEmitter(), { command, args, env: options?.env, pid, exitCode: null as number | null, signalCode: null as string | null, stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), kill(signal: string) { child.signalCode = signal; child.emit('exit', null, signal); return true; } });
    children.push(child);
    if (command === process.execPath) {
      const ready = () => child.stderr.write(`DevTools listening on ws://127.0.0.1:${port}/\n`);
      if (holdChrome) releaseChrome = ready;
      else setTimeout(ready, 10);
    }
    return child;
  });
  const store = new InMemorySpaceStore();
  const room = store.createRoom({ name: 'Lifecycle proof', initialPaneCount: 0 });
  const pane = store.createPane({ roomId: room.id, title: 'Browser lifecycle', mode });
  const session = store.createPaneBrowserSession({ sessionId: 'browser_session:lifecycle', agentNumber: 1, paneId: pane.id, roomId: room.id,
    profileId: 'profile:lifecycle', profilePath: join(root, profile), viewport: 'wide', targetUrl: null, status: 'READY', isActive: true });
  const manager = createBrowserSessionManager({ store, config: getApiConfig({ SPACE_BROWSER_SESSIONS_PROFILE_ROOT: root, SPACE_BROWSER_SESSIONS_ENABLED: 'true', SPACE_BROWSER_SESSIONS_CHROME_PATH: process.execPath, SPACE_BROWSER_SESSIONS_XVFB_PATH: '/fixture/Xvfb', SPACE_BROWSER_SESSIONS_XVFB_ENABLED: 'true', SPACE_VPN_SOCKS_PROXIES: 'greece=10.20.1.2:1080,thailand=10.20.2.2:1080' }), cdpSendTimeoutMs });
  return { manager, pane, store, session, children, cdpMethods, scriptSources, windowMoves, lifecycle, playMedia: (on: boolean) => { mediaPlaying = on; }, failWindowMoves: (on: boolean) => { windowMovesFail = on; }, listTargets: () => { listTargets = true; }, mute: (on: boolean) => { muted = on; },
    hold: () => { holdChrome = true; }, release: () => releaseChrome?.(),
    async cleanup() { await manager.closeAll(); for (const socket of server.clients) socket.terminate(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); } };
}

describe('managed browser runtime lifecycle', () => {
  it('an unanswered command marks the Chrome; its next action fails at once and a probe that answers clears the mark', async () => {
    const f = await fixture('BROWSER', 'profile', 150);
    try {
      await f.manager.getActive(f.pane);
      f.mute(true);
      // Its frame's capture times out after 150 ms and marks the Chrome.
      await f.manager.getActive(f.pane).catch(() => undefined);
      f.mute(false);
      const startedAt = Date.now();
      const failed = await f.manager.getActive(f.pane).then(() => null, (error: unknown) => error as { errorCode?: string; details?: { paneId?: string; sessionId?: string; otherPanes?: string[] } });
      expect(failed?.errorCode).toBe('BROWSER_UNRESPONSIVE');
      expect(failed?.details).toMatchObject({ paneId: f.pane.id, sessionId: f.session.sessionId, otherPanes: [] });
      expect(Date.now() - startedAt).toBeLessThan(100);
      await vi.waitFor(() => f.manager.getActive(f.pane), { timeout: 2_000, interval: 50 });
      expect(f.cdpMethods).toContain('Browser.getVersion');
      expect(f.children.filter(child => child.command === process.execPath)).toHaveLength(1);
    } finally { await f.cleanup(); }
  });
  it.each([undefined, 'http://127.0.0.1:4911/browser-live-proof.html'])('restarts a stopped blank browser with target %s', async (targetUrl) => {
    const f = await fixture('BROWSER');
    try {
      await f.store.updatePaneBrowserSession(f.session.sessionId, { status: 'CLOSED', isActive: false, currentUrl: 'about:blank', targetUrl: 'about:blank' });
      const restarted = await f.manager.startOrRestore({ pane: f.pane, targetUrl, traceId: 'trace:restart' });
      expect(restarted.session.sessionId).not.toBe(f.session.sessionId);
      expect(restarted.session.status).toBe('READY');
      expect(restarted.session.currentUrl).toBe(targetUrl ?? null);
      expect(restarted.session.targetUrl).toBe(targetUrl ?? 'about:blank');
      expect(restarted.frame?.screenshotDataUrl).toBeTruthy();
    } finally { await f.cleanup(); }
  });
  it('concurrent page/frame requests start one Chrome and release every display on close', async () => {
    const f = await fixture();
    try {
      await Promise.all(Array.from({ length: 16 }, () => f.manager.getActive(f.pane)));
      expect(f.children.filter(child => child.command === process.execPath)).toHaveLength(1);
      expect(f.children.filter(child => child.command === '/fixture/Xvfb')).toHaveLength(1);
      await f.manager.stopPane(f.pane.id);
      expect(f.manager.capacity?.().activeSessions).toBe(0);
      expect(f.children.every(child => child.exitCode !== null || child.signalCode !== null)).toBe(true);
      expect(f.cdpMethods).toContain('Browser.close');
      expect(f.children.find(child => child.command === process.execPath)?.signalCode).toBeNull();
      const displays = Array.from({ length: browserSessionDisplayCapacity }, () => allocateDisplay());
      expect(displays.every(display => display !== null)).toBe(true);
      displays.forEach(display => { if (display !== null) releaseDisplay(display); });
    } finally { await f.cleanup(); }
  });
  it('a Chrome that outlives its stop keeps its display and Xvfb until it exits, then frees them once', async () => {
    const fake = (dies: boolean) => {
      const child = Object.assign(new EventEmitter(), { exitCode: null as number | null, signalCode: null as string | null,
        kill(signal: string) { if (dies) { child.signalCode = signal; child.emit('exit', null, signal); } return true; } });
      return child as unknown as import('node:child_process').ChildProcessWithoutNullStreams & typeof child;
    };
    const free = () => { const all: number[] = []; for (let d = allocateDisplay(); d !== null; d = allocateDisplay()) all.push(d); all.forEach(releaseDisplay); return all; };
    const chrome = fake(false), xvfb = fake(true), display = allocateDisplay()!;
    let freed = 0;
    await expect(stopChromeAndDisplay(chrome, undefined, xvfb, display, () => { freed += 1; })).rejects.toThrow(/Chrome did not exit/);
    expect(free()).not.toContain(display);
    expect(xvfb.signalCode).toBeNull();
    chrome.signalCode = 'SIGKILL';
    chrome.emit('exit', null, 'SIGKILL');
    await vi.waitFor(() => expect(freed).toBe(1));
    expect(xvfb.signalCode).toBe('SIGTERM');
    expect(free()).toContain(display);
    // A later close of the same dead profile frees nothing twice.
    await stopChromeAndDisplay(chrome, undefined, xvfb, display, () => { freed += 1; });
    expect(freed).toBe(1);
  });
  it('a launch with no free display takes the display of a Chrome that died on its own (13/11 "No Xvfb display is available")', async () => {
    const f = await fixture();
    const held: number[] = [];
    try {
      await f.manager.getActive(f.pane);
      const chrome = f.children.find(child => child.command === process.execPath)!;
      chrome.exitCode = 1;
      chrome.emit('exit', 1, null);
      for (let display = allocateDisplay(); display !== null; display = allocateDisplay()) held.push(display);
      const other = f.store.createPane({ roomId: f.pane.roomId, title: 'Scheduled scan', mode: 'BROWSER' });
      f.store.createPaneBrowserSession({ sessionId: 'browser_session:scan', agentNumber: 2, paneId: other.id, roomId: f.pane.roomId, profileId: 'profile:scan',
        profilePath: join(f.session.profilePath, '..', 'scan'), viewport: 'wide', targetUrl: null, status: 'READY', isActive: true });
      await f.manager.getActive(other);
      const xvfbs = f.children.filter(child => child.command === '/fixture/Xvfb');
      expect(xvfbs).toHaveLength(2);
      expect(xvfbs[0]!.signalCode).toBe('SIGTERM');
      expect(xvfbs[1]!.args[0]).toBe(xvfbs[0]!.args[0]);
    } finally { held.forEach(releaseDisplay); await f.cleanup(); }
  });
  const chrome157 = 'Google Chrome 157.0.8103.78 \n';
  it('launches a browser that holds no Google account headless, without Xvfb, and as Chrome to sites (light browser step 5)', async () => {
    mocks.chromeVersion = chrome157;
    const f = await fixture();
    try {
      await f.manager.getActive(f.pane);
      const chrome = f.children.find(child => child.command === process.execPath)!;
      expect(f.children.filter(child => child.command === '/fixture/Xvfb')).toHaveLength(0);
      expect(chrome.env?.DISPLAY).toBeUndefined();
      expect(chrome.args).toEqual(expect.arrayContaining(['--headless=new', '--screen-info={1280x720}',
        '--user-agent=Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36']));
    } finally { await f.cleanup(); mocks.chromeVersion = null; }
  });
  it.each([
    ['a Google sign-in', 'profile'],
    ['a Google account profile', 'google-accounts/owner/account'],
    ['a CLI account profile', 'cli-accounts/key']
  ])('keeps a browser with %s headed on Xvfb (light browser step 5)', async (kind, profile) => {
    mocks.chromeVersion = chrome157;
    const f = await fixture('YOUTUBE', profile);
    try {
      if (kind === 'a Google sign-in') {
        await mkdir(join(f.session.profilePath, 'Default', 'Network'), { recursive: true });
        const db = new DatabaseSync(join(f.session.profilePath, 'Default', 'Network', 'Cookies'));
        db.exec("CREATE TABLE cookies (host_key TEXT, name TEXT, is_persistent INTEGER, expires_utc INTEGER); INSERT INTO cookies VALUES ('.google.com', 'SID', 0, 0)");
        db.close();
      }
      await f.manager.getActive(f.pane);
      const chrome = f.children.find(child => child.command === process.execPath)!;
      expect(f.children.filter(child => child.command === '/fixture/Xvfb')).toHaveLength(1);
      expect(chrome.env?.DISPLAY).toMatch(/^:\d+$/);
      expect(chrome.args.some(arg => arg.startsWith('--headless') || arg.startsWith('--user-agent'))).toBe(false);
    } finally { await f.cleanup(); mocks.chromeVersion = null; }
  });
  it('minimizes an idle headless window, freezes its pages only then, and restores both on the next use (light browser step 5)', async () => {
    mocks.chromeVersion = chrome157;
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    const f = await fixture();
    const settle = async (done: () => boolean) => { for (let i = 0; i < 300 && !done(); i += 1) await new Promise(resolve => setTimeout(resolve, 10)); };
    try {
      await f.manager.getActive(f.pane);
      f.listTargets();
      await vi.advanceTimersByTimeAsync(360_000);
      await settle(() => f.lifecycle.length > 0);
      // Off the display does nothing headless (probe 13/11: still visible, rAF 60); a minimized page is hidden.
      expect(f.windowMoves).toEqual([{ windowState: 'minimized' }]);
      expect(f.lifecycle).toEqual(['frozen:cdp:page:test:1']);
      expect(f.cdpMethods.indexOf('Browser.setWindowBounds')).toBeLessThan(f.cdpMethods.indexOf('Page.setWebLifecycleState'));
      await f.manager.getActive(f.pane);
      expect(f.windowMoves).toEqual([{ windowState: 'minimized' }, { windowState: 'normal' }]);
      expect(f.lifecycle).toEqual(['frozen:cdp:page:test:1', 'active:cdp:page:test:1']);
    } finally { await f.cleanup(); vi.useRealTimers(); mocks.chromeVersion = null; }
  });
  it('moves a window nobody used for 5 minutes off the display, and back on its next use but not on a tab list read', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    const f = await fixture();
    // The sweep waits on the fake Chrome's socket, which runs on real time.
    const settle = async (done: () => boolean) => { for (let i = 0; i < 300 && !done(); i += 1) await new Promise(resolve => setTimeout(resolve, 10)); };
    try {
      await f.manager.getActive(f.pane);
      f.listTargets();
      await vi.advanceTimersByTimeAsync(60_000);
      await settle(() => f.cdpMethods.includes('Browser.getWindowForTarget'));
      await new Promise(resolve => setTimeout(resolve, 100));
      expect(f.windowMoves).toEqual([]);
      await vi.advanceTimersByTimeAsync(300_000);
      await settle(() => f.windowMoves.length > 0);
      expect(f.windowMoves).toEqual([{ left: 20_000, top: 0 }]);
      await f.manager.listPages(f.pane);
      expect(f.windowMoves).toHaveLength(1);
      await f.manager.getActive(f.pane);
      expect(f.windowMoves).toEqual([{ left: 20_000, top: 0 }, { left: 10, top: 10 }]);
    } finally { await f.cleanup(); vi.useRealTimers(); }
  });
  it('brings an off-display window back on an agent command and before a live view starts', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    const f = await fixture();
    const settle = async (done: () => boolean) => { for (let i = 0; i < 300 && !done(); i += 1) await new Promise(resolve => setTimeout(resolve, 10)); };
    const away = { left: 20_000, top: 0 }, home = { left: 10, top: 10 };
    try {
      await f.manager.getActive(f.pane);
      f.listTargets();
      await vi.advanceTimersByTimeAsync(360_000);
      await settle(() => f.windowMoves.length === 1);
      // The CLI CDP proxy sends this diagnostics read on an agent's command (cli-browser-cdp.test.ts, the pipe case).
      await f.manager.diagnostics?.(f.pane, false, 1);
      expect(f.windowMoves).toEqual([away, home]);
      await vi.advanceTimersByTimeAsync(360_000);
      await settle(() => f.windowMoves.length === 3);
      const stream = await f.manager.startFrameStream?.(f.session.sessionId, 'INTERACTIVE', () => undefined);
      expect(f.windowMoves).toEqual([away, home, away, home]);
      expect(f.cdpMethods.lastIndexOf('Browser.setWindowBounds')).toBeLessThan(f.cdpMethods.lastIndexOf('Page.startScreencast'));
      await stream?.stop();
    } finally { await f.cleanup(); vi.useRealTimers(); }
  });
  it('freezes the pages of an idle, silent browser with its window and thaws them before its next command (light browser step 4)', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    const f = await fixture();
    const settle = async (done: () => boolean) => { for (let i = 0; i < 300 && !done(); i += 1) await new Promise(resolve => setTimeout(resolve, 10)); };
    try {
      await f.manager.getActive(f.pane);
      f.listTargets();
      await vi.advanceTimersByTimeAsync(60_000);
      await settle(() => f.cdpMethods.includes('Browser.getWindowForTarget'));
      await new Promise(resolve => setTimeout(resolve, 100));
      expect(f.lifecycle).toEqual([]); // used a minute ago
      await vi.advanceTimersByTimeAsync(300_000);
      await settle(() => f.lifecycle.length > 0);
      expect(f.lifecycle).toEqual(['frozen:cdp:page:test:1']);
      // An agent command (the CLI CDP proxy's diagnostics read): the thaw is sent before anything else reaches the page.
      const before = f.cdpMethods.length;
      await f.manager.diagnostics?.(f.pane, false, 1);
      await f.manager.getActive(f.pane);
      expect(f.lifecycle).toEqual(['frozen:cdp:page:test:1', 'active:cdp:page:test:1']);
      const after = f.cdpMethods.slice(before).filter(method => method.startsWith('Page.') || method.startsWith('Runtime.') || method.startsWith('Input.'));
      expect(after[0]).toBe('Page.setWebLifecycleState');
    } finally { await f.cleanup(); vi.useRealTimers(); mocks.pactl = '[]'; }
  });
  it('never freezes a page playing media or a browser whose sound it cannot read, though the window leaves the display', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    const f = await fixture();
    const settle = async (done: () => boolean) => { for (let i = 0; i < 300 && !done(); i += 1) await new Promise(resolve => setTimeout(resolve, 10)); };
    const sweeps = () => f.cdpMethods.filter(method => method === 'Target.getTargets').length;
    try {
      await f.manager.getActive(f.pane);
      f.listTargets();
      f.playMedia(true);
      await vi.advanceTimersByTimeAsync(360_000);
      await settle(() => f.windowMoves.length === 1);
      await new Promise(resolve => setTimeout(resolve, 100));
      expect(f.windowMoves).toEqual([{ left: 20_000, top: 0 }]);
      expect(f.lifecycle).toEqual([]);
      // Silent page, but pactl refuses: no freeze. Once pactl answers, the next sweep freezes it.
      f.playMedia(false);
      mocks.pactl = null;
      let seen = sweeps();
      await vi.advanceTimersByTimeAsync(60_000);
      await settle(() => sweeps() > seen);
      await new Promise(resolve => setTimeout(resolve, 100));
      expect(f.lifecycle).toEqual([]);
      mocks.pactl = '[]';
      seen = sweeps();
      await vi.advanceTimersByTimeAsync(60_000);
      await settle(() => f.lifecycle.length > 0);
      expect(f.lifecycle).toEqual(['frozen:cdp:page:test:1']);
    } finally { await f.cleanup(); vi.useRealTimers(); mocks.pactl = '[]'; }
  });
  it('never freezes a page whose window stayed on the display: it would paint no frame after its thaw (light browser step 4)', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    const f = await fixture();
    const settle = async (done: () => boolean) => { for (let i = 0; i < 300 && !done(); i += 1) await new Promise(resolve => setTimeout(resolve, 10)); };
    const moveTries = () => f.cdpMethods.filter(method => method === 'Browser.setWindowBounds').length;
    try {
      await f.manager.getActive(f.pane);
      f.listTargets();
      f.failWindowMoves(true);
      await vi.advanceTimersByTimeAsync(360_000);
      await settle(() => moveTries() > 0);
      await new Promise(resolve => setTimeout(resolve, 100));
      expect(f.windowMoves).toEqual([]);
      expect(f.lifecycle).toEqual([]);
      // The next sweep moves it: now the page freezes, after the move.
      f.failWindowMoves(false);
      await vi.advanceTimersByTimeAsync(60_000);
      await settle(() => f.lifecycle.length > 0);
      expect(f.windowMoves).toEqual([{ left: 20_000, top: 0 }]);
      expect(f.lifecycle).toEqual(['frozen:cdp:page:test:1']);
      expect(f.cdpMethods.lastIndexOf('Browser.setWindowBounds')).toBeLessThan(f.cdpMethods.indexOf('Page.setWebLifecycleState'));
    } finally { await f.cleanup(); vi.useRealTimers(); mocks.pactl = '[]'; }
  });
  it('removes the logins Chrome saved in the profile before launching it, and nothing else', async () => {
    const f = await fixture('FREELANCE_COPILOT');
    try {
      const profile = join(f.session.profilePath, 'Default');
      await mkdir(profile, { recursive: true });
      // A saved password is autofilled and reaches an agent's page snapshot (2026-10-19); synthetic files only.
      for (const name of ['Login Data', 'Login Data-journal', 'Login Data For Account', 'Login Data For Account-wal', 'Cookies', 'Preferences']) {
        await writeFile(join(profile, name), 'synthetic');
      }
      await f.manager.getActive(f.pane);
      expect(f.children.filter(child => child.command === process.execPath)).toHaveLength(1);
      expect((await readdir(profile)).sort()).toEqual(['Cookies', 'Preferences']);
    } finally { await f.cleanup(); }
  });
  it('marks the last exit crashed so Chrome restores the session cookies, without the restore prompt (brief 20261101)', async () => {
    const f = await fixture('FREELANCE_COPILOT');
    try {
      const preferences = join(f.session.profilePath, 'Default', 'Preferences');
      await mkdir(join(f.session.profilePath, 'Default'), { recursive: true });
      await writeFile(preferences, JSON.stringify({ profile: { exit_type: 'Normal', name: 'Person 1' }, session: { restore_on_startup: 5 } }));
      await f.manager.getActive(f.pane);
      expect(JSON.parse(await readFile(preferences, 'utf8'))).toEqual({ profile: { exit_type: 'Crashed', name: 'Person 1' }, session: { restore_on_startup: 5 } });
      expect(f.children.find(child => child.command === process.execPath)?.args).toContain('--hide-crash-restore-bubble');
    } finally { await f.cleanup(); }
  });
  it('finishes late stream cleanup after Chrome exits instead of blocking the next account', async () => {
    const f = await fixture();
    try {
      await f.manager.getActive(f.pane);
      const stream = await f.manager.startFrameStream(f.session.sessionId, 'REALTIME', () => undefined);
      await f.manager.stopPane(f.pane.id);
      await new Promise(resolve => setTimeout(resolve, 25));
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          stream.stop(),
          new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('Stream cleanup hung on a closed CDP socket.')), 500); })
        ]);
      } finally { if (timeout) clearTimeout(timeout); }
      expect(f.manager.capacity?.().activeLiveWorkloads).toBe(0);
    } finally { await f.cleanup(); }
  });
  // Operator 14/11 21:53 BKK: 97 Chrome processes outlived the browser panes closed in SpaceApp.
  describe('a closed browser leaves no Chrome behind', () => {
    const chromes = (f: Awaited<ReturnType<typeof fixture>>) => f.children.filter(child => child.command === process.execPath);
    const alive = (f: Awaited<ReturnType<typeof fixture>>) => chromes(f).filter(child => child.exitCode === null && child.signalCode === null).length;
    it('closing the pane ends its Chrome, also when its stored session is gone or replaced', async () => {
      const f = await fixture('BROWSER');
      try {
        await f.manager.getActive(f.pane);
        expect(alive(f)).toBe(1);
        await f.manager.stopPane(f.pane.id);
        expect(alive(f)).toBe(0);
        // The row went inactive behind the host's back (a new session row, a lost stop): the next stop still ends the Chrome.
        const second = await f.manager.startOrRestore({ pane: f.pane, traceId: 'trace:second' });
        expect(alive(f)).toBe(1);
        await f.store.updatePaneBrowserSession(second.session.sessionId, { status: 'CLOSED', isActive: false });
        await f.manager.stopPane(f.pane.id);
        expect(alive(f)).toBe(0);
        expect(f.manager.capacity?.().activeSessions).toBe(0);
      } finally { await f.cleanup(); }
    });
    it('a browser stopped on a non-http page (a route change restart) starts again on its http target, not failing (19/11 set_route)', async () => {
      const f = await fixture('BROWSER');
      try {
        await f.store.updatePaneBrowserSession(f.session.sessionId, { status: 'CLOSED', isActive: false, currentUrl: 'chrome-error://chromewebdata/', targetUrl: 'https://example.com/' });
        const started = await f.manager.startOrRestore({ pane: f.pane, traceId: 'trace:non-http' });
        expect(started.session.targetUrl).toBe('https://example.com/');
        await f.store.updatePaneBrowserSession(started.session.sessionId, { status: 'CLOSED', isActive: false, currentUrl: 'chrome://newtab/', targetUrl: 'chrome://newtab/' });
        const again = await f.manager.startOrRestore({ pane: f.pane, traceId: 'trace:non-http-2' });
        expect(again.session.targetUrl).toMatch(/^(?:https?:|about:blank$)/);
      } finally { await f.cleanup(); }
    });
    it('the sweep closes the Chrome of a deleted room after the grace, logs it, and never one an open pane holds', async () => {
      const f = await fixture('BROWSER');
      const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
      try {
        await f.manager.getActive(f.pane);
        const now = Date.now();
        // Held: the open pane's active session.
        expect(await f.manager.sweepOrphanChromes!(now)).toBe(0);
        expect(await f.manager.sweepOrphanChromes!(now + 2 * ORPHAN_CHROME_GRACE_MS)).toBe(0);
        expect(alive(f)).toBe(1);
        // Room deleted while the Browser Host could not stop it: its rows are gone, its Chrome is not.
        await f.store.deleteRoom(f.pane.roomId);
        expect(await f.manager.sweepOrphanChromes!(now)).toBe(0);
        expect(alive(f)).toBe(1);
        expect(await f.manager.sweepOrphanChromes!(now + ORPHAN_CHROME_GRACE_MS - 1)).toBe(0);
        expect(await f.manager.sweepOrphanChromes!(now + ORPHAN_CHROME_GRACE_MS)).toBe(1);
        expect(alive(f)).toBe(0);
        expect(f.manager.capacity?.().activeSessions).toBe(0);
        const line = log.mock.calls.map(([text]) => String(text)).find(text => text.includes('browser_orphan_chrome_closed'));
        expect(JSON.parse(line!)).toMatchObject({ event: 'browser_orphan_chrome_closed', panes: [f.pane.id], tracked: true });
      } finally { log.mockRestore(); await f.cleanup(); }
    });
    it('the sweep closes the Chrome of a pane closed while its stop failed and closes its session', async () => {
      const f = await fixture('BROWSER');
      const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
      try {
        await f.manager.getActive(f.pane);
        await f.store.updatePane(f.pane.id, { isClosed: true });
        const now = Date.now();
        await f.manager.sweepOrphanChromes!(now);
        expect(await f.manager.sweepOrphanChromes!(now + ORPHAN_CHROME_GRACE_MS)).toBe(1);
        expect(alive(f)).toBe(0);
        expect((await f.store.getPaneBrowserSession(f.session.sessionId))?.isActive).toBe(false);
      } finally { log.mockRestore(); await f.cleanup(); }
    });
  });
  it('closing during startup waits for and stops that process without reviving the session', async () => {
    const f = await fixture();
    try {
      f.hold();
      const starting = f.manager.getActive(f.pane);
      await vi.waitFor(() => expect(f.children.some(child => child.command === process.execPath)).toBe(true));
      const stopping = f.manager.stopPane(f.pane.id);
      f.release();
      await Promise.allSettled([starting, stopping]);
      expect((await f.store.getPaneBrowserSession(f.session.sessionId))?.isActive).toBe(false);
      expect(await f.manager.getActive(f.pane)).toBeNull();
      expect(f.children.filter(child => child.command === process.execPath)).toHaveLength(1);
      expect(f.children.every(child => child.exitCode !== null || child.signalCode !== null)).toBe(true);
    } finally { await f.cleanup(); }
  });
  it('starts a Freelance Copilot pane\'s Chrome with its per-platform routes, and other panes without them', async () => {
    const freelance = await fixture('FREELANCE_COPILOT');
    try {
      await freelance.manager.getActive(freelance.pane);
      const args = freelance.children.find(child => child.command === process.execPath)?.args ?? [];
      const pacArg = args.find(arg => arg.startsWith('--proxy-pac-url=data:application/x-ns-proxy-autoconfig;base64,'));
      expect(pacArg).toBeTruthy();
      const pac = Buffer.from(pacArg!.split('base64,')[1]!, 'base64').toString('utf8');
      expect(pac).toContain('["upwork.com","SOCKS5 10.20.2.2:1080"]');
      expect(pac).toContain('return "SOCKS5 10.20.2.2:1080"');
      expect(args).toContain('--force-webrtc-ip-handling-policy=disable_non_proxied_udp');
      // The clock and languages of the Thailand exit; Chrome reports its own user agent and navigator values.
      expect(args).toContain('--accept-lang=en-US,en,th');
      expect(freelance.children.find(child => child.command === process.execPath)?.env?.TZ).toBe('Asia/Bangkok');
      expect(args.some(arg => arg.startsWith('--user-agent'))).toBe(false);
      expect(freelance.scriptSources.some(source => source.includes('navigator'))).toBe(false);
    } finally { await freelance.cleanup(); }
    const plain = await fixture('BROWSER');
    try {
      await plain.manager.getActive(plain.pane);
      const args = plain.children.find(child => child.command === process.execPath)?.args ?? [];
      expect(args.some(arg => arg.startsWith('--proxy-pac-url') || arg.startsWith('--accept-lang'))).toBe(false);
      expect(plain.children.find(child => child.command === process.execPath)?.env?.TZ).toBe(process.env.TZ);
    } finally { await plain.cleanup(); }
  });
  it('starts any pane browser on the network route chosen for it, and an explicit "This server" restarts a routed Chrome (plan clipboard:iLvBs5eOMZjF)', async () => {
    const f = await fixture('BROWSER');
    try {
      const chromes = () => f.children.filter(child => child.command === process.execPath);
      f.store.setPaneBrowserRoute(f.pane.id, 'greece');
      await f.manager.getActive(f.pane);
      const args = chromes()[0]!.args;
      const pac = Buffer.from(args.find(arg => arg.startsWith('--proxy-pac-url='))!.split('base64,')[1]!, 'base64').toString('utf8');
      // Every site through the Greece route, localhost direct, no DIRECT fallback: a route that is down fails closed.
      expect(pac).toContain('return "SOCKS5 10.20.1.2:1080"');
      expect(pac).not.toMatch(/return "DIRECT";\n}$/);
      expect(args).toContain('--force-webrtc-ip-handling-policy=disable_non_proxied_udp');
      expect(args).toContain('--accept-lang=en-US,en,el');
      expect(chromes()[0]!.env?.TZ).toBe('Europe/Athens');

      // A pane sharing the account that chose "This server" is refused while the Greece pane holds the Chrome.
      const other = f.store.createPane({ roomId: f.pane.roomId, title: 'direct', mode: 'BROWSER' });
      f.store.createPaneBrowserSession({ sessionId: 'browser_session:direct', agentNumber: 2, paneId: other.id, roomId: f.pane.roomId,
        profileId: 'profile:lifecycle', profilePath: f.session.profilePath, viewport: 'wide', targetUrl: null, status: 'READY', isActive: true });
      f.store.setPaneBrowserRoute(other.id, 'direct');
      await expect(f.manager.getActive(other)).rejects.toThrow(/BROWSER_ROUTE/);
      // Once the Greece pane is on "This server" too, its restart starts the account's Chrome with no proxy.
      f.store.setPaneBrowserRoute(f.pane.id, 'direct');
      await f.manager.stopPane(f.pane.id);
      await f.manager.getActive(other);
      expect(chromes().at(-1)!.args.some(arg => arg.startsWith('--proxy-pac-url'))).toBe(false);
    } finally { await f.cleanup(); }
  });
  it('restarts an account Chrome open without Freelance routes with them; the panes sharing it come back streaming', async () => {
    const f = await fixture('BROWSER');
    try {
      const chromes = () => f.children.filter(child => child.command === process.execPath);
      const addFreelance = (id: string) => {
        const pane = f.store.createPane({ roomId: f.pane.roomId, title: id, mode: 'FREELANCE_COPILOT' });
        f.store.createPaneBrowserSession({ sessionId: `browser_session:${id}`, agentNumber: 2, paneId: pane.id, roomId: f.pane.roomId,
          profileId: 'profile:lifecycle', profilePath: f.session.profilePath, viewport: 'wide', targetUrl: null, status: 'READY', isActive: true });
        return pane;
      };
      await f.manager.getActive(f.pane);
      const stream = await f.manager.startFrameStream!(f.session.sessionId, 'REALTIME', () => undefined);
      expect(chromes()[0]!.args.some(arg => arg.startsWith('--proxy-pac-url'))).toBe(false);

      await f.manager.getActive(addFreelance('freelance'));
      expect(chromes()).toHaveLength(2);
      expect(chromes()[0]!.exitCode !== null || chromes()[0]!.signalCode !== null).toBe(true);
      expect(chromes()[1]!.args.some(arg => arg.startsWith('--proxy-pac-url'))).toBe(true);
      // The Browser pane rejoins the Freelance Chrome on its own, and its live view streams from it.
      await vi.waitFor(() => expect(f.cdpMethods.filter(method => method === 'Page.startScreencast')).toHaveLength(2));
      await f.manager.getActive(f.pane);
      expect(chromes()).toHaveLength(2);
      await stream.stop();
      expect(f.cdpMethods).toContain('Page.stopScreencast');
      expect(f.manager.capacity?.().activeLiveWorkloads).toBe(0);

      // A second Freelance pane with other routes never restarts the first one's Chrome.
      const other = addFreelance('freelance-greece');
      const metadata = defaultFreelanceCopilotPaneMetadata();
      f.store.updateFreelanceCopilotMetadata(other.id, { ...metadata, settings: { ...metadata.settings, browserEgress: 'greece' } });
      await expect(f.manager.getActive(other)).rejects.toThrow(/BROWSER_ROUTE/);
      expect(chromes()).toHaveLength(2);
    } finally { await f.cleanup(); }
  });
  it('a pane on a Freelance Copilot\'s pane route shares its account Chrome in either order; a pane on another route moves to it (Leo on Dana\'s account, 16/11; Emma, 26/11)', async () => {
    const f = await fixture('FREELANCE_COPILOT');
    try {
      const chromes = () => f.children.filter(child => child.command === process.execPath);
      const addBrowser = (id: string, route: 'thailand' | 'greece' | 'direct') => {
        const pane = f.store.createPane({ roomId: f.pane.roomId, title: id, mode: 'MARKETING_COPILOT' });
        f.store.createPaneBrowserSession({ sessionId: `browser_session:${id}`, agentNumber: 2, paneId: pane.id, roomId: f.pane.roomId,
          profileId: 'profile:lifecycle', profilePath: f.session.profilePath, viewport: 'wide', targetUrl: null, status: 'READY', isActive: true });
        f.store.setPaneBrowserRoute(pane.id, route);
        return pane;
      };
      // The Freelance pane's default route is Thailand: a pane that chose Thailand joins its Chrome, no restart.
      await f.manager.getActive(f.pane);
      const leo = addBrowser('leo', 'thailand');
      await f.manager.getActive(leo);
      expect(chromes()).toHaveLength(1);
      // A pane on another chosen route joins too: it takes the Freelance route for good (26/11, Emma's CLI Browser on direct).
      const greece = addBrowser('greece', 'greece');
      await f.manager.getActive(greece);
      expect(chromes()).toHaveLength(1);
      expect(f.store.getPaneBrowserRoute(greece.id)).toBe('thailand');
      await f.manager.stopPane(greece.id);

      // The other order (a Browser Host restart): the Freelance pane restarts the Thailand pane's Chrome onto its routes, the pane comes back on it.
      const pac = () => Buffer.from(chromes().at(-1)!.args.find(arg => arg.startsWith('--proxy-pac-url='))!.split('base64,')[1]!, 'base64').toString('utf8');
      await f.manager.stopPane(f.pane.id);
      await f.manager.stopPane(leo.id);
      await f.store.updatePaneBrowserSession('browser_session:leo', { isActive: true, status: 'READY' });
      await f.store.updatePaneBrowserSession(f.session.sessionId, { isActive: true, status: 'READY' });
      await f.manager.getActive(leo);
      expect(pac()).not.toContain('upwork.com');
      await f.manager.getActive(f.pane);
      expect(pac()).toContain('upwork.com');
      const count = chromes().length;
      await f.manager.getActive(leo);
      expect(chromes()).toHaveLength(count);

      // Dana behind Emma (26/11): a pane on direct holds the Chrome; the Freelance pane restarts it onto its routes and the pane follows.
      await f.manager.stopPane(f.pane.id);
      await f.manager.stopPane(leo.id);
      await f.store.updatePaneBrowserSession(f.session.sessionId, { isActive: true, status: 'READY' });
      const emma = addBrowser('emma', 'direct');
      await f.manager.getActive(emma);
      expect(chromes().at(-1)!.args.some(arg => arg.startsWith('--proxy-pac-url'))).toBe(false);
      await f.manager.getActive(f.pane);
      expect(pac()).toContain('upwork.com');
      expect(f.store.getPaneBrowserRoute(emma.id)).toBe('thailand');
      expect(f.store.listAuditEvents().some(event => event.action === 'browser.route_adopted' && event.targetId === emma.id)).toBe(true);
    } finally { await f.cleanup(); }
  });
  it('streams Preview-only viewers by a screenshot a second and switches to the screencast while a faster viewer watches', async () => {
    const f = await fixture('BROWSER');
    try {
      await f.manager.getActive(f.pane);
      const count = (method: string) => f.cdpMethods.filter(sent => sent === method).length;
      const previewFrames: number[] = [];
      const preview = await f.manager.startFrameStream!(f.session.sessionId, 'PREVIEW', frame => { previewFrames.push(frame.sequence); });
      await vi.waitFor(() => expect(previewFrames).toHaveLength(1));
      expect(count('Page.startScreencast')).toBe(0);

      const realtime = await f.manager.startFrameStream!(f.session.sessionId, 'REALTIME', () => undefined);
      expect(count('Page.startScreencast')).toBe(1);
      const shots = count('Page.captureScreenshot');
      await new Promise(resolve => setTimeout(resolve, 1_200));
      expect(count('Page.captureScreenshot')).toBe(shots);

      // The Realtime viewer leaves: the screencast stops and the Preview viewer gets screenshots again.
      await realtime.stop();
      expect(count('Page.stopScreencast')).toBe(1);
      await vi.waitFor(() => expect(count('Page.captureScreenshot')).toBeGreaterThan(shots));
      await preview.stop();
      expect(f.manager.capacity?.().activeLiveWorkloads).toBe(0);
      expect(count('Page.stopScreencast')).toBe(1);
    } finally { await f.cleanup(); }
  });
  it('injects the YouTube ad-block document-start script by default', async () => {
    const f = await fixture();
    try {
      await f.manager.getActive(f.pane);
      const adBlock = f.scriptSources.find(source => source.includes('adBreakHeartbeatParams'));
      expect(adBlock).toBeTruthy();
      expect(adBlock).toContain('ytInitialPlayerResponse');
    } finally { await f.cleanup(); }
  });
});

describe('a Browser Host that fails a request itself (round 9 item 4: Cleo/Bob lost a day to "unavailable")', () => {
  it('passes its code and first zod issue through to the answer and tells Nous which pane it hit; other host errors stay as they were', async () => {
    const { SpaceFeatureDisabledError } = await import('@space/runtime');
    const { onBrowserHostInternalError, withBrowserHostErrorText } = await import('../src/browser-host-errors.js');
    const pane = { id: 'pane:bob00001', roomId: 'room:cleo0001' };
    const internal = new SpaceFeatureDisabledError('BROWSER_HOST_UNAVAILABLE', 'The Browser Host is unavailable.',
      { hostCode: 'BROWSER_HOST_INTERNAL_ERROR', hostIssue: 'unrecognized_keys at input.pane.marketingCopilotMetadata (keys: bookmarksView)' });
    const down = new SpaceFeatureDisabledError('BROWSER_HOST_UNAVAILABLE', 'The Browser Host is unavailable.', { hostCode: 'BROWSER_HOST_UNAVAILABLE' });
    const manager = withBrowserHostErrorText({
      startOrRestore: vi.fn(async () => { throw internal; }), getActive: vi.fn(async () => { throw down; }), health: () => 'ok'
    });
    const heard: unknown[] = [];
    const stop = onBrowserHostInternalError((event) => heard.push(event));
    const failed = await manager.startOrRestore({ pane } as never).catch((error: unknown) => error as InstanceType<typeof SpaceFeatureDisabledError>);
    expect(failed).toMatchObject({ errorCode: 'BROWSER_HOST_UNAVAILABLE',
      message: 'The Browser Host is running but failed this request (BROWSER_HOST_INTERNAL_ERROR: unrecognized_keys at input.pane.marketingCopilotMetadata (keys: bookmarksView)). No stale host is known, so a restart is not the fix: the message names the cause. Try once more in a few minutes (a timeout under load passes); if it fails the same way, report that message. Do not retry in a loop.' });
    expect(heard).toEqual([{ paneId: 'pane:bob00001', roomId: 'room:cleo0001', code: 'BROWSER_HOST_INTERNAL_ERROR', issue: 'unrecognized_keys at input.pane.marketingCopilotMetadata (keys: bookmarksView)', stale: false }]);
    // A host that is down keeps its own answer; a non-function passes as it is.
    await expect(manager.getActive(pane as never)).rejects.toBe(down);
    expect(manager.health()).toBe('ok');
    stop();
  });

  it('passes the host\'s own message through the proxy (redacted) and names a stale host only while the age check says so (14/11: memory, not a stale host)', async () => {
    const { BrowserHostError } = await import('@space/browser-host');
    const { getApiConfig } = await import('../src/config.js');
    const { createBrowserHostProxy } = await import('../src/browser-host-proxy.js');
    const { createBrowserHostStaleWatch, keepBrowserHostErrorMessages, withBrowserHostErrorText } = await import('../src/browser-host-errors.js');
    const client = keepBrowserHostErrorMessages({ getActive: async () => {
      throw new BrowserHostError('BROWSER_HOST_INTERNAL_ERROR', 'timeout exceeded when trying to connect to postgres://space:hunter2secret@db/space');
    } });
    const manager = withBrowserHostErrorText(createBrowserHostProxy({ config: getApiConfig({}), client: client as never }));
    const answer = () => manager.getActive({ id: 'pane:max00001', roomId: 'room:cleo0001' } as never).catch((error: Error) => error.message);
    expect(await answer()).toBe('The Browser Host is running but failed this request (BROWSER_HOST_INTERNAL_ERROR: timeout exceeded when trying to connect '
      + 'to postgres://[REDACTED]@db/space). No stale host is known, so a restart is not the fix: the message names the cause. Try once more in a few minutes (a timeout under load passes); if it fails the same way, report that message. Do not retry in a loop.');
    const watch = (startedAt: string) => createBrowserHostStaleWatch({ health: async () => ({ startedAt }), changedAt: async () => '2026-11-14T21:00:00.000Z' });
    await watch('2026-11-14T20:13:17.000Z').check();
    // Slice 17 (14/11): the exact place and command, never "tell Nous" (the answer reached Nous itself).
    expect(await answer()).toContain('The resident Browser Host started 2026-11-14 20:13 UTC, before the newest pane contracts, and refuses panes this way until '
      + "the operator's guarded Browser Host restart (Settings → Nous → Server operations → Restart a service, or `space-admin-action server-ops restart browser-host` by an agent the operator asks)");
    // A restarted host newer than the contracts: no hint again.
    await watch('2026-11-14T21:05:00.000Z').check();
    expect(await answer()).not.toContain('resident');
  });

  it('names a resident host older than the newest pane contract change once per host start, at most every 10 minutes', async () => {
    const { createBrowserHostStaleWatch, PANE_METADATA_SCHEMA_FILES } = await import('../src/browser-host-errors.js');
    expect(PANE_METADATA_SCHEMA_FILES).toContain('packages/contracts/src/marketing-copilot.ts');
    let now = Date.parse('2026-10-28T07:00:00.000Z');
    let startedAt = '2026-10-27T10:00:00.000Z';
    const watch = createBrowserHostStaleWatch({ health: async () => ({ startedAt }), changedAt: async () => '2026-10-28T02:00:00.000Z', now: () => now });
    expect(await watch.check()).toMatch(/^The resident Browser Host started 2026-10-27 10:00 UTC, before the newest change to the pane contracts it parses \(2026-10-28 02:00 UTC\)/);
    now += 11 * 60_000;
    expect(await watch.check()).toBeNull();
    // After a restart the new host is newer than the change: nothing to say.
    startedAt = '2026-10-28T07:05:00.000Z';
    now += 11 * 60_000;
    expect(await watch.check()).toBeNull();
  });

  it('says nothing about a resident host that reads newer pane rows fine (17/11, nous_msg:efe9585f: a restart card after every promote)', async () => {
    const { BrowserHostError } = await import('@space/browser-host');
    const { getApiConfig } = await import('../src/config.js');
    const { createBrowserHostProxy } = await import('../src/browser-host-proxy.js');
    const { createBrowserHostStaleWatch, keepBrowserHostErrorMessages, withBrowserHostErrorText } = await import('../src/browser-host-errors.js');
    const changedAt = async () => '2026-11-17T03:15:00.000Z';
    const now = () => Date.parse('2026-11-17T08:00:00.000Z');
    const written: string[] = [];
    const told = { read: () => null, write: (startedAt: string) => { written.push(startedAt); } };
    // A host older than the contracts that does not report the capability is still named.
    expect(await createBrowserHostStaleWatch({ health: async () => ({ startedAt: '2026-11-17T01:00:00.000Z' }), changedAt, now, told }).check())
      .toMatch(/^The resident Browser Host started 2026-11-17 01:00 UTC/);
    expect(written).toEqual(['2026-11-17T01:00:00.000Z']);
    // The same age with tolerantPaneRows: no line to Nous, nothing told, and the error text drops the stale-host hint.
    const tolerant = createBrowserHostStaleWatch({ health: async () => ({ startedAt: '2026-11-17T02:00:00.000Z', tolerantPaneRows: true }), changedAt, now, told });
    expect(await tolerant.check()).toBeNull();
    expect(written).toEqual(['2026-11-17T01:00:00.000Z']);
    const client = keepBrowserHostErrorMessages({ getActive: async () => { throw new BrowserHostError('BROWSER_HOST_INTERNAL_ERROR', 'timeout exceeded'); } });
    const manager = withBrowserHostErrorText(createBrowserHostProxy({ config: getApiConfig({}), client: client as never }));
    const answer = await manager.getActive({ id: 'pane:max00001', roomId: 'room:cleo0001' } as never).catch((error: Error) => error.message);
    expect(answer).not.toContain('resident');
    expect(answer).toContain('No stale host is known');
  });

  it('keeps the told host start across an API restart (round 2, 1/11: 50 restarts told the same host 22 times)', async () => {
    const { createBrowserHostStaleWatch, browserHostStaleToldStore } = await import('../src/browser-host-errors.js');
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const told = browserHostStaleToldStore(join(mkdtempSync(join(tmpdir(), 'stale-told-')), 'nested', 'told.json'));
    const deps = { health: async () => ({ startedAt: '2026-10-27T10:00:00.000Z' }), changedAt: async () => '2026-10-28T02:00:00.000Z', now: () => Date.parse('2026-10-28T07:00:00.000Z'), told };
    expect(await createBrowserHostStaleWatch(deps).check()).toMatch(/^The resident Browser Host started/);
    expect(told.read()).toBe('2026-10-27T10:00:00.000Z');
    expect(await createBrowserHostStaleWatch(deps).check()).toBeNull();
    expect(await createBrowserHostStaleWatch({ ...deps, told: browserHostStaleToldStore('/nonexistent/dir/x.json') }).check()).toMatch(/^The resident Browser Host started/);
  });
});
