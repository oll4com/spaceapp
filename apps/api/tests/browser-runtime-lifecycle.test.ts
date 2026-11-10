import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
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
  it('starts any pane browser on the network route chosen for it, and an explicit "This server" restarts a routed Chrome (plan clipboard:iLvBs5eOMZjF)', async () => {
    const f = await fixture('BROWSER');
    try {
      const chromes = () => f.children.filter(child => child.command === process.execPath);
      f.store.setPaneBrowserRoute(f.pane.id, 'greece');
      await f.manager.getActive(f.pane);
      const args = chromes()[0]!.args;
      const pac = Buffer.from(args.find(arg => arg.startsWith('--proxy-pac-url='))!.split('base64,')[1]!, 'base64').toString('utf8');
      // Every site through the Greece route, localhost direct, no DIRECT fallback: a route that is down fails closed.
      expect(pac).toContain('return "SOCKS5 10.254.241.2:1080"');
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
      message: expect.stringMatching(/^The Browser Host is running but failed this request \(BROWSER_HOST_INTERNAL_ERROR: unrecognized_keys at input\.pane\.marketingCopilotMetadata \(keys: bookmarksView\)\)\. .*guarded restart/) });
    expect(heard).toEqual([{ paneId: 'pane:bob00001', roomId: 'room:cleo0001', code: 'BROWSER_HOST_INTERNAL_ERROR', issue: 'unrecognized_keys at input.pane.marketingCopilotMetadata (keys: bookmarksView)' }]);
    // A host that is down keeps its own answer; a non-function passes as it is.
    await expect(manager.getActive(pane as never)).rejects.toBe(down);
    expect(manager.health()).toBe('ok');
    stop();
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
