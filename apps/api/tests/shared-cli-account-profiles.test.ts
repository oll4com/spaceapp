import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { WebSocketServer, type WebSocket } from 'ws';
import { describe, expect, it, vi } from 'vitest';
import { InMemorySpaceStore } from '@space/runtime';
const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', async original => ({ ...await original<typeof import('node:child_process')>(), spawn: mocks.spawn }));
import { browserProfilePathFor, createBrowserSessionManager, sharedCliProfilePathFor } from '../src/browser-sessions.js';
import { getApiConfig } from '../src/config.js';

// Synthetic profiles: a marker file and a cookie row *name* only.
async function paneProfile(path: string, marker: string, signedIn: boolean) {
  await mkdir(join(path, 'Default'), { recursive: true });
  const db = new DatabaseSync(join(path, 'Default', 'Cookies'));
  db.exec('CREATE TABLE cookies (host_key TEXT, name TEXT, is_persistent INTEGER, expires_utc INTEGER)');
  if (signedIn) db.prepare('INSERT INTO cookies VALUES (?, ?, 1, ?)').run('.google.com', 'SID', (Date.now() + 11644473600000 + 86_400_000) * 1000);
  db.close();
  await writeFile(join(path, 'marker.txt'), marker);
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'shared-cli-profile-test-'));
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise<void>(resolve => server.once('listening', resolve));
  const children: any[] = [];
  let seq = 0;
  server.on('connection', (socket: WebSocket) => {
    const child = children.find(c => !c.connected); child.connected = true; child.socket = socket;
    const pages = new Map<string, { targetId: string; type: string; url: string }>();
    socket.on('message', async raw => {
      const { id, method, params, sessionId } = JSON.parse(raw.toString());
      let result: any = {};
      if (method === 'Target.createTarget') { const targetId = `page-${++seq}`; pages.set(targetId, { targetId, type: 'page', url: params.url }); result = { targetId }; }
      if (method === 'Target.attachToTarget') result = { sessionId: `cdp-${params.targetId}` };
      if (method === 'Target.getTargets') result = { targetInfos: [...pages.values()] };
      if (method === 'Target.closeTarget') { pages.delete(params.targetId); result = { success: true }; }
      if (method === 'Runtime.evaluate') result = { result: { value: { scrolled: true, media: true, href: 'about:blank', title: 'Fixture', scrollX: 0, scrollY: 0 } } };
      if (method === 'Browser.close') { child.exitCode = 0; child.emit('exit', 0, null); }
      socket.send(JSON.stringify({ id, result }));
      if (method === 'Page.navigate') socket.send(JSON.stringify({ method: 'Page.loadEventFired', sessionId, params: {} }));
    });
  });
  mocks.spawn.mockImplementation((_command: string, args: string[]) => {
    const child = Object.assign(new EventEmitter(), { args, exitCode: null, signalCode: null, stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), kill(signal: string) { child.signalCode = signal; child.emit('exit', null, signal); return true; } });
    children.push(child);
    setTimeout(() => child.stderr.write(`DevTools listening on ws://127.0.0.1:${(server.address() as { port: number }).port}/\n`), 1);
    return child;
  });
  const store = new InMemorySpaceStore();
  const user = store.upsertUser({ id: 'user:shared-cli', email: 'owner@example.test', role: 'ADMIN' });
  const room = store.createRoom({ name: 'Shared CLI accounts', initialPaneCount: 0 }, 'trace', user.id);
  const browser = store.createPane({ roomId: room.id, title: 'Browser', mode: 'BROWSER' });
  const youtube = store.createPane({ roomId: room.id, title: 'YouTube', mode: 'YOUTUBE' });
  const manager = createBrowserSessionManager({ store, config: getApiConfig({ SPACE_BROWSER_SESSIONS_PROFILE_ROOT: root, SPACE_BROWSER_SESSIONS_ENABLED: 'true', SPACE_BROWSER_SESSIONS_CHROME_PATH: process.execPath, SPACE_BROWSER_SESSIONS_XVFB_ENABLED: 'false' }) });
  const key = 'b'.repeat(64);
  const start = (pane = youtube, sharedProfileKey = key) => manager.startOrRestore({ pane, sharedProfileKey, profileKey: /^[a-f0-9]{64}$/.test(sharedProfileKey) ? sharedProfileKey : null, targetUrl: 'about:blank', includeInitialFrame: false, traceId: 'trace' });
  return {
    root, store, user, room, browser, youtube, manager, key, start, children,
    shared: sharedCliProfilePathFor(root, key),
    legacy: (pane = browser) => browserProfilePathFor(root, room.id, pane.id, key),
    async cleanup() { await manager.closeAll(); server.clients.forEach(s => s.terminate()); await new Promise<void>(r => server.close(() => r())); await rm(root, { recursive: true, force: true }); }
  };
}

describe('one shared Chrome profile per Gemini account', () => {
  it('joins the running pane that already holds the account, so the second pane is signed in at once', async () => {
    const f = await fixture();
    try {
      await paneProfile(f.legacy(), 'signed-in-browser', true);
      const running = await f.manager.startOrRestore({ pane: f.browser, profileKey: f.key, targetUrl: 'about:blank', includeInitialFrame: false, traceId: 'trace' });
      expect(running.session.profilePath).toBe(f.legacy());
      const joined = await f.start();
      expect(joined.session.profilePath).toBe(f.legacy());
      expect(joined.session.profileId).toBe(`cli-account:${f.key}`);
      expect(f.children).toHaveLength(1);
      expect((await f.manager.listPages!(f.youtube)).pages).toHaveLength(1);
      expect((await f.manager.listPages!(f.browser)).pages).toHaveLength(1);
    } finally { await f.cleanup(); }
  });

  it('moves the most recently signed-in pane profile into the shared profile once all panes closed it', async () => {
    const f = await fixture();
    try {
      await paneProfile(f.legacy(f.youtube), 'older-signed-out', false);
      await paneProfile(f.legacy(), 'signed-in-browser', true);
      const opened = await f.start();
      expect(opened.session.profilePath).toBe(f.shared);
      expect(await readFile(join(f.shared, 'marker.txt'), 'utf8')).toBe('signed-in-browser');
      await expect(stat(f.legacy())).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await readFile(join(f.legacy(f.youtube), 'marker.txt'), 'utf8')).toBe('older-signed-out');
      expect(JSON.parse(await readFile(`${f.shared}.adoption.json`, 'utf8'))).toMatchObject({ signedIn: true });
      const second = await f.manager.startOrRestore({ pane: f.browser, sharedProfileKey: f.key, profileKey: null, targetUrl: 'about:blank', includeInitialFrame: false, traceId: 'trace' });
      expect(second.session.profilePath).toBe(f.shared);
      expect(f.children).toHaveLength(1);
      await f.manager.stopPane(f.youtube.id); await f.manager.stopPane(f.browser.id);
      const reopened = await f.start();
      expect(reopened.session.profilePath).toBe(f.shared);
    } finally { await f.cleanup(); }
  });

  it('joins a pane still running the account even when an idle profile looks newer, and never moves that pane', async () => {
    const f = await fixture();
    try {
      await paneProfile(f.legacy(), 'running-older', true);
      const third = f.store.createPane({ roomId: f.room.id, title: 'Idle', mode: 'BROWSER' });
      await paneProfile(f.legacy(third), 'idle-newer', true);
      const { utimes } = await import('node:fs/promises');
      const old = new Date(Date.now() - 3_600_000);
      await utimes(join(f.legacy(), 'Default', 'Cookies'), old, old);
      const running = await f.manager.startOrRestore({ pane: f.browser, profileKey: f.key, targetUrl: 'about:blank', includeInitialFrame: false, traceId: 'trace' });
      const joined = await f.start();
      expect(joined.session.profilePath).toBe(f.legacy());
      await expect(stat(f.shared)).rejects.toMatchObject({ code: 'ENOENT' });
      // The running pane reconnecting with the shared key stays on its directory and process.
      const reconnected = await f.manager.startOrRestore({ pane: f.browser, sharedProfileKey: f.key, profileKey: f.key, includeInitialFrame: false, traceId: 'trace' });
      expect(reconnected.session.sessionId).toBe(running.session.sessionId);
      expect(f.children).toHaveLength(1);
      expect(f.children[0].exitCode).toBeNull();
    } finally { await f.cleanup(); }
  });

  it('never joins or moves a pane profile this service cannot open', async () => {
    const f = await fixture();
    const { chmod } = await import('node:fs/promises');
    try {
      await paneProfile(f.legacy(), 'locked-out', true);
      await chmod(join(f.legacy(), 'Default'), 0o000);
      const opened = await f.start();
      expect(opened.session.profilePath).toBe(f.shared);
      await chmod(join(f.legacy(), 'Default'), 0o700);
      expect(await readFile(join(f.legacy(), 'marker.txt'), 'utf8')).toBe('locked-out');
    } finally { await chmod(join(f.legacy(), 'Default'), 0o700).catch(() => undefined); await f.cleanup(); }
  });

  it('starts an empty shared profile when the account was never used and keeps accounts apart', async () => {
    const f = await fixture();
    try {
      const first = await f.start();
      expect(first.session.profilePath).toBe(f.shared);
      const other = await f.start(f.browser, 'c'.repeat(64));
      expect(other.session.profilePath).not.toBe(f.shared);
      expect(f.children).toHaveLength(2);
      await expect(f.start(f.browser, '../escape')).rejects.toThrow(/Invalid shared/);
    } finally { await f.cleanup(); }
  });

  it('is unavailable in proof rooms', async () => {
    const f = await fixture();
    try {
      const proof = f.store.createRoom({ name: 'Proof', kind: 'AGENT_PROOF', initialPaneCount: 0 } as never, 'trace', f.user.id);
      const pane = f.store.createPane({ roomId: proof.id, title: 'Proof', mode: 'BROWSER' });
      await expect(f.start(pane)).rejects.toThrow(/proof rooms/);
      expect(f.children).toHaveLength(0);
    } finally { await f.cleanup(); }
  });
});
