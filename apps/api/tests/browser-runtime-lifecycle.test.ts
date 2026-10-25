import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocketServer } from 'ws';
import { describe, expect, it, vi } from 'vitest';
import { defaultFreelanceCopilotPaneMetadata } from '@space/contracts';
import { InMemorySpaceStore } from '@space/runtime';
const mocks = vi.hoisted(() => ({ spawn: vi.fn(), xvfbPid: 0 }));
vi.mock('node:child_process', async importOriginal => ({ ...await importOriginal<typeof import('node:child_process')>(), spawn: mocks.spawn }));
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
import { allocateDisplay, createBrowserSessionManager, releaseDisplay } from '../src/browser-sessions.js';
import { getApiConfig } from '../src/config.js';

async function fixture(mode: 'BROWSER' | 'YOUTUBE' | 'FREELANCE_COPILOT' = 'YOUTUBE') {
  const root = await mkdtemp(join(tmpdir(), 'browser-lifecycle-'));
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise<void>(resolve => server.once('listening', resolve));
  const port = (server.address() as { port: number }).port;
  const cdpMethods: string[] = [];
  const scriptSources: string[] = [];
  let currentUrl: string | null = null;
  let targets = 0;
  server.on('connection', socket => socket.on('message', data => {
    const { id, method, sessionId, params } = JSON.parse(data.toString());
    cdpMethods.push(method);
    if (method === 'Page.addScriptToEvaluateOnNewDocument' && typeof params?.source === 'string') scriptSources.push(params.source);
    if (method === 'Page.navigate') currentUrl = params.url;
    if (method === 'Browser.close') {
      const chrome = children.find(child => child.command === process.execPath && child.exitCode === null && child.signalCode === null);
      if (chrome) { chrome.exitCode = 0; chrome.emit('exit', 0, null); }
    }
    const result = method === 'Target.createTarget' ? { targetId: `page:test:${++targets}` }
      : method === 'Target.attachToTarget' ? { sessionId: `cdp:${params.targetId}` }
      : method === 'Page.captureScreenshot' ? { data: 'iVBORw0KGgo=' }
      : method === 'Runtime.evaluate' ? { result: { value: { href: currentUrl === 'about:blank' ? null : currentUrl, title: 'Lifecycle proof', scrollX: 0, scrollY: 0, videoPaused: null } } }
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
    profileId: 'profile:lifecycle', profilePath: join(root, 'profile'), viewport: 'wide', targetUrl: null, status: 'READY', isActive: true });
  const manager = createBrowserSessionManager({ store, config: getApiConfig({ SPACE_BROWSER_SESSIONS_PROFILE_ROOT: root, SPACE_BROWSER_SESSIONS_ENABLED: 'true', SPACE_BROWSER_SESSIONS_CHROME_PATH: process.execPath, SPACE_BROWSER_SESSIONS_XVFB_PATH: '/fixture/Xvfb', SPACE_BROWSER_SESSIONS_XVFB_ENABLED: 'true' }) });
  return { manager, pane, store, session, children, cdpMethods, scriptSources, hold: () => { holdChrome = true; }, release: () => releaseChrome?.(),
    async cleanup() { await manager.closeAll(); for (const socket of server.clients) socket.terminate(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); } };
}

describe('managed browser runtime lifecycle', () => {
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
      const displays = Array.from({ length: 8 }, () => allocateDisplay());
      expect(displays.every(display => display !== null)).toBe(true);
      displays.forEach(display => { if (display !== null) releaseDisplay(display); });
    } finally { await f.cleanup(); }
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
      expect(pac).toContain('["upwork.com","SOCKS5 10.254.242.2:1080"]');
      expect(pac).toContain('return "SOCKS5 10.254.242.2:1080"');
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
      await expect(f.manager.getActive(other)).rejects.toThrow(/FREELANCE_EGRESS/);
      expect(chromes()).toHaveLength(2);
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
