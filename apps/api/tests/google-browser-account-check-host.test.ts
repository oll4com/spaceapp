import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { WebSocketServer, type WebSocket } from 'ws';
import { describe, expect, it, vi } from 'vitest';
import { InMemorySpaceStore } from '@space/runtime';
const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', async original => ({ ...await original<typeof import('node:child_process')>(), spawn: mocks.spawn }));
import { createBrowserSessionManager, googleBrowserProfilePathFor } from '../src/browser-sessions.js';
import { getApiConfig } from '../src/config.js';
import { googleBrowserCheckPathFor, readGoogleBrowserCheck } from '../src/google-browser-session-check.js';

type Evidence = { ok: true; httpStatus: number; accounts: Array<{ subMatches: boolean; emailMatches: boolean; valid: boolean; signedOut: boolean }> } | { ok: false; httpStatus: number | null; error: string };
const connected: Evidence = { ok: true, httpStatus: 200, accounts: [{ subMatches: true, emailMatches: true, valid: true, signedOut: false }] };

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'google-check-test-'));
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise<void>(resolve => server.once('listening', resolve));
  const commands: { method: string; params: any; sessionId?: string }[] = [];
  const children: any[] = [];
  let evidence: Evidence = connected;
  let seq = 0;
  server.on('connection', (socket: WebSocket) => {
    const child = children.find(c => !c.connected); child.connected = true; child.socket = socket;
    const pages = new Map<string, { targetId: string; type: string; url: string }>();
    child.pages = pages;
    socket.on('message', async raw => {
      const { id, method, params, sessionId } = JSON.parse(raw.toString());
      commands.push({ method, params, sessionId });
      let result: any = {};
      if (method === 'Target.createTarget') { const targetId = `page-${++seq}`; pages.set(targetId, { targetId, type: 'page', url: params.url }); result = { targetId }; }
      if (method === 'Target.attachToTarget') result = { sessionId: `cdp-${params.targetId}` };
      if (method === 'Target.getTargets') result = { targetInfos: [...pages.values()] };
      if (method === 'Target.closeTarget') { pages.delete(params.targetId); result = { success: true }; }
      if (method === 'Page.captureScreenshot') result = { data: 'iVBORw0KGgo=' };
      if (method === 'Runtime.evaluate') {
        result = String(params.expression).includes('ListAccounts')
          ? { result: { value: evidence } }
          : { result: { value: { scrolled: true, media: true, href: 'about:blank', title: 'Fixture', scrollX: 0, scrollY: 0 } } };
      }
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
  const user = store.upsertUser({ id: 'user:check-owner', email: 'owner@example.test', role: 'ADMIN' });
  const account = store.linkGoogleAccount(user.id, { sub: 'verified-a', email: 'Owner.Account@gmail.com' });
  const room = store.createRoom({ name: 'Account checks', initialPaneCount: 0 }, 'trace:test', user.id);
  const pane = store.createPane({ roomId: room.id, title: 'One', mode: 'BROWSER' });
  const manager = createBrowserSessionManager({ store, config: getApiConfig({ SPACE_BROWSER_SESSIONS_PROFILE_ROOT: root, SPACE_BROWSER_SESSIONS_ENABLED: 'true', SPACE_BROWSER_SESSIONS_CHROME_PATH: process.execPath, SPACE_BROWSER_SESSIONS_XVFB_ENABLED: 'false' }) });
  const identity = { ownerUserId: user.id, accountId: account.id };
  const profilePath = googleBrowserProfilePathFor(root, user.id, account.id);
  const start = () => manager.startOrRestore({ pane, googleAccount: identity, targetUrl: 'about:blank', includeInitialFrame: false, traceId: 'trace:test' });
  return {
    store, user, account, pane, manager, identity, profilePath, start, commands, children, root,
    setEvidence(next: Evidence) { evidence = next; },
    probeCommands: () => commands.filter(c => c.method === 'Runtime.evaluate' && String(c.params.expression).includes('ListAccounts')),
    async cleanup() { await manager.closeAll(); server.clients.forEach(s => s.terminate()); await new Promise<void>(r => server.close(() => r())); await rm(root, { recursive: true, force: true }); }
  };
}

describe('Browser Host Google account checks', () => {
  it('reports a missing profile without launching Chrome or creating the profile', async () => {
    const f = await fixture();
    try {
      await expect(f.manager.checkGoogleAccount!(f.identity, true)).resolves.toMatchObject({ status: 'NOT_CONNECTED', reason: 'PROFILE_MISSING' });
      expect(f.children).toHaveLength(0);
      await expect(stat(f.profilePath)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { await f.cleanup(); }
  });

  it('cold-checks a closed profile in a private page, persists only the state and closes Chrome again', async () => {
    const f = await fixture();
    try {
      await mkdir(f.profilePath, { recursive: true });
      const result = await f.manager.checkGoogleAccount!(f.identity, true, { holderType: 'OPERATOR', holderId: f.user.id });
      expect(result).toMatchObject({ status: 'CONNECTED', reason: 'VERIFIED' });
      expect(result.connectedAt).toBe(result.checkedAt);
      expect(f.children).toHaveLength(1);
      expect(f.children[0].args).toContain(`--user-data-dir=${f.profilePath}`);
      expect(f.commands.find(c => c.method === 'Target.createTarget')?.params).toEqual({ url: 'about:blank', background: true });
      expect(f.commands.filter(c => c.method === 'Page.navigate').map(c => c.params.url)).toEqual(['https://accounts.google.com/robots.txt']);
      expect(f.commands.some(c => c.method === 'Fetch.enable')).toBe(false);
      expect(f.commands.filter(c => c.method === 'Target.closeTarget')).toHaveLength(1);
      expect(f.commands.filter(c => c.method === 'Browser.close')).toHaveLength(1);
      expect(f.children[0].exitCode).toBe(0);
      const raw = await readFile(googleBrowserCheckPathFor(f.profilePath), 'utf8');
      expect(raw).not.toMatch(/owner|gmail|verified-a/i);
      expect(await readGoogleBrowserCheck(f.profilePath)).toMatchObject({ status: 'CONNECTED', matchedBy: 'SUB' });
    } finally { await f.cleanup(); }
  });

  it('checks an open profile in place without adding a page to the pane or launching another writer', async () => {
    const f = await fixture();
    try {
      await f.start();
      const before = await f.manager.listPages!(f.pane);
      const result = await f.manager.checkGoogleAccount!(f.identity, false);
      expect(result.status).toBe('CONNECTED');
      expect(f.children).toHaveLength(1);
      expect(f.children[0].exitCode).toBeNull();
      const after = await f.manager.listPages!(f.pane);
      expect(after.pages.map(page => page.pageId)).toEqual(before.pages.map(page => page.pageId));
      expect(f.children[0].pages.size).toBe(1);
    } finally { await f.cleanup(); }
  });

  it('keeps the last verified state when a later check fails and never launches for a background check', async () => {
    const f = await fixture();
    try {
      await mkdir(f.profilePath, { recursive: true });
      await f.manager.checkGoogleAccount!(f.identity, true);
      f.setEvidence({ ok: false, httpStatus: null, error: 'NETWORK' });
      await expect(f.manager.checkGoogleAccount!(f.identity, true)).resolves.toMatchObject({ status: 'UNKNOWN', reason: 'CHECK_FAILED' });
      expect(await readGoogleBrowserCheck(f.profilePath)).toMatchObject({ status: 'CONNECTED' });
      const launches = f.children.length;
      await expect(f.manager.checkGoogleAccount!(f.identity, false)).resolves.toMatchObject({ status: 'CONNECTED' });
      expect(f.children).toHaveLength(launches);
      f.setEvidence({ ok: true, httpStatus: 200, accounts: [] });
      await expect(f.manager.checkGoogleAccount!(f.identity, true)).resolves.toMatchObject({ status: 'REAUTHENTICATION_REQUIRED', reason: 'SESSION_LOST' });
    } finally { await f.cleanup(); }
  });

  it('rejects another operator, an agent and an account outside the registry', async () => {
    const f = await fixture();
    try {
      await mkdir(f.profilePath, { recursive: true });
      await expect(f.manager.checkGoogleAccount!(f.identity, true, { holderType: 'OPERATOR', holderId: 'user:other' })).rejects.toThrow(/does not belong/);
      await expect(f.manager.checkGoogleAccount!(f.identity, true, { holderType: 'AGENT', holderId: f.user.id })).rejects.toThrow(/does not belong/);
      await expect(f.manager.checkGoogleAccount!({ ownerUserId: 'user:other', accountId: f.account.id }, true)).rejects.toThrow(/not found/);
      expect(f.children).toHaveLength(0);
    } finally { await f.cleanup(); }
  });

  it('re-checks after a pane leaves a Google sign-in page', async () => {
    const f = await fixture();
    try {
      await f.start();
      const pageSession = f.commands.find(c => c.method === 'Page.navigate')?.sessionId;
      expect(pageSession).toBeTruthy();
      const send = (url: string) => f.children[0].socket.send(JSON.stringify({ method: 'Page.frameNavigated', sessionId: pageSession, params: { frame: { id: 'main', url } } }));
      send('https://accounts.google.com/v3/signin/identifier');
      send('https://www.google.com/');
      await vi.waitFor(async () => expect(await readGoogleBrowserCheck(f.profilePath)).toMatchObject({ status: 'CONNECTED' }), { timeout: 12_000, interval: 100 });
      expect(f.probeCommands()).toHaveLength(1);
      expect(f.children).toHaveLength(1);
    } finally { await f.cleanup(); }
  }, 20_000);
});
