import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { existsSync, utimesSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { WebSocketServer, type WebSocket } from 'ws';
import { describe, expect, it, vi } from 'vitest';
import { InMemorySpaceStore } from '@space/runtime';
const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', async original => ({ ...await original<typeof import('node:child_process')>(), spawn: mocks.spawn }));
import { browserProfilePathFor, createBrowserSessionManager, googleBrowserProfilePathFor } from '../src/browser-sessions.js';
import { getApiConfig } from '../src/config.js';
import { readGoogleBrowserCheck, writeGoogleBrowserCheck } from '../src/google-browser-session-check.js';

// Synthetic profiles only: a cookies table with a session-cookie *name* and a
// Google answer simulated per launched Chrome. No real account data is used.
async function signedInProfile(path: string, marker: string) {
  await mkdir(join(path, 'Default'), { recursive: true });
  const db = new DatabaseSync(join(path, 'Default', 'Cookies'));
  db.exec('CREATE TABLE cookies (host_key TEXT, name TEXT, is_persistent INTEGER, expires_utc INTEGER)');
  db.prepare('INSERT INTO cookies VALUES (?, ?, 1, ?)').run('.google.com', 'SID', (Date.now() + 11644473600000 + 86_400_000) * 1000);
  db.close();
  await writeFile(join(path, 'marker.txt'), marker);
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'google-adoption-test-'));
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise<void>(resolve => server.once('listening', resolve));
  const commands: { method: string; params: any; sessionId?: string; child: number }[] = [];
  const children: any[] = [];
  // Which Google subjects each profile directory is signed in to.
  const signedIn = new Map<string, string[]>();
  let seq = 0;
  server.on('connection', (socket: WebSocket) => {
    const child = children.find(c => !c.connected); child.connected = true; child.socket = socket;
    const index = children.indexOf(child);
    const profile = String(child.args.find((arg: string) => arg.startsWith('--user-data-dir=')) ?? '').slice('--user-data-dir='.length);
    const pages = new Map<string, { targetId: string; type: string; url: string }>();
    child.pages = pages;
    socket.on('message', async raw => {
      const { id, method, params, sessionId } = JSON.parse(raw.toString());
      commands.push({ method, params, sessionId, child: index });
      let result: any = {};
      if (method === 'Target.createTarget') { const targetId = `page-${++seq}`; pages.set(targetId, { targetId, type: 'page', url: params.url }); result = { targetId }; }
      if (method === 'Target.attachToTarget') result = { sessionId: `cdp-${params.targetId}` };
      if (method === 'Target.getTargets') result = { targetInfos: [...pages.values()] };
      if (method === 'Target.closeTarget') { pages.delete(params.targetId); result = { success: true }; }
      if (method === 'Runtime.evaluate') {
        const expression = String(params.expression);
        if (expression.includes('ListAccounts')) {
          const expected = JSON.parse(/const expectedSub = ("[^"]*");/.exec(expression)![1]!);
          const subs = signedIn.get(profile) ?? [];
          // Like Chrome, a check request touches the profile's cookie store.
          const cookies = join(profile, 'Default', 'Cookies');
          if (existsSync(cookies)) { const later = new Date(Date.now() + 60_000); utimesSync(cookies, later, later); }
          result = { result: { value: { ok: true, httpStatus: 200, accounts: subs.map(sub => ({ subMatches: sub === expected, emailMatches: false, valid: true, signedOut: false })) } } };
        } else result = { result: { value: { scrolled: true, media: true, href: 'about:blank', title: 'Fixture', scrollX: 0, scrollY: 0 } } };
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
  const user = store.upsertUser({ id: 'user:adoption-owner', email: 'owner@example.test', role: 'ADMIN' });
  const primary = store.linkGoogleAccount(user.id, { sub: 'sub-primary', email: 'primary@example.test' });
  const second = store.linkGoogleAccount(user.id, { sub: 'sub-second', email: 'second@example.test' });
  const room = store.createRoom({ name: 'Adoption', initialPaneCount: 0 }, 'trace:test', user.id);
  const pane = store.createPane({ roomId: room.id, title: 'Own profile', mode: 'YOUTUBE' });
  const other = store.createPane({ roomId: room.id, title: 'Shared user', mode: 'BROWSER' });
  const manager = createBrowserSessionManager({ store, config: getApiConfig({ SPACE_BROWSER_SESSIONS_PROFILE_ROOT: root, SPACE_BROWSER_SESSIONS_ENABLED: 'true', SPACE_BROWSER_SESSIONS_CHROME_PATH: process.execPath, SPACE_BROWSER_SESSIONS_XVFB_ENABLED: 'false' }) });
  const operator = { holderType: 'OPERATOR' as const, holderId: user.id };
  const source = (profileKey: string | null = null) => ({ ownerUserId: user.id, roomId: room.id, paneId: pane.id, profileKey });
  return {
    root, store, user, primary, second, room, pane, other, manager, operator, source, signedIn, children, commands,
    paneDir: (profileKey: string | null = null) => browserProfilePathFor(root, room.id, pane.id, profileKey),
    accountDir: (accountId: string) => googleBrowserProfilePathFor(root, user.id, accountId),
    async cleanup() { await manager.closeAll(); server.clients.forEach(s => s.terminate()); await new Promise<void>(r => server.close(() => r())); await rm(root, { recursive: true, force: true }); }
  };
}

const legacyKey = 'a'.repeat(64);

describe('pane Google sign-in adoption into the shared account profile', () => {
  it('moves a verified pane profile into the account profile, keeping the pane legacy scopes in place', async () => {
    const f = await fixture();
    try {
      await signedInProfile(f.paneDir(), 'pane-sign-in');
      await signedInProfile(f.paneDir(legacyKey), 'legacy-scope');
      f.signedIn.set(f.paneDir(), ['sub-second']);
      await mkdir(f.accountDir(f.second.id), { recursive: true });
      await writeFile(join(f.accountDir(f.second.id), 'marker.txt'), 'empty-shared');
      const result = await f.manager.adoptPaneGoogleProfile!(f.source(), f.operator);
      expect(result).toEqual({ result: 'ADOPTED', accountId: f.second.id });
      expect(await readFile(join(f.accountDir(f.second.id), 'marker.txt'), 'utf8')).toBe('pane-sign-in');
      expect(await readFile(join(f.paneDir(legacyKey), 'marker.txt'), 'utf8')).toBe('legacy-scope');
      await expect(stat(join(f.accountDir(f.second.id), 'accounts'))).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await readGoogleBrowserCheck(f.accountDir(f.second.id))).toMatchObject({ status: 'CONNECTED', matchedBy: 'SUB' });
      const record = JSON.parse(await readFile(`${f.accountDir(f.second.id)}.adoption.json`, 'utf8'));
      expect(record.from).not.toMatch(/^\//);
      expect(await readFile(join(f.root, record.replaced, 'marker.txt'), 'utf8')).toBe('empty-shared');
      // The source and the existing shared profile were each checked with Google, then closed.
      expect(f.children).toHaveLength(2);
      expect(f.children.every((child: any) => child.exitCode === 0)).toBe(true);
    } finally { await f.cleanup(); }
  });

  it('never launches Chrome for a profile without Google session cookies and remembers other accounts', async () => {
    const f = await fixture();
    try {
      await mkdir(join(f.paneDir(), 'Default'), { recursive: true });
      expect(await f.manager.adoptPaneGoogleProfile!(f.source(), f.operator)).toEqual({ result: 'NO_SIGN_IN', accountId: null });
      expect(f.children).toHaveLength(0);
      await signedInProfile(f.paneDir(legacyKey), 'someone-else');
      f.signedIn.set(f.paneDir(legacyKey), ['sub-not-linked']);
      expect(await f.manager.adoptPaneGoogleProfile!(f.source(legacyKey), f.operator)).toEqual({ result: 'OTHER_ACCOUNT', accountId: null });
      expect(f.children).toHaveLength(1);
      expect(await f.manager.adoptPaneGoogleProfile!(f.source(legacyKey), f.operator)).toEqual({ result: 'OTHER_ACCOUNT', accountId: null });
      expect(f.children).toHaveLength(1);
      expect(await readFile(join(f.paneDir(legacyKey), 'marker.txt'), 'utf8')).toBe('someone-else');
      expect(await f.manager.adoptPaneGoogleProfile!({ ...f.source(), paneId: 'pane:missing' }, f.operator)).toEqual({ result: 'SOURCE_MISSING', accountId: null });
    } finally { await f.cleanup(); }
  });

  it('does not move a profile that a pane is using', async () => {
    const f = await fixture();
    try {
      await signedInProfile(f.paneDir(), 'in-use');
      f.signedIn.set(f.paneDir(), ['sub-primary']);
      await f.manager.startOrRestore({ pane: f.pane, targetUrl: 'about:blank', includeInitialFrame: false, traceId: 'trace' }, f.operator);
      expect(await f.manager.adoptPaneGoogleProfile!(f.source(), f.operator)).toEqual({ result: 'SOURCE_IN_USE', accountId: null });
      expect(await readFile(join(f.paneDir(), 'marker.txt'), 'utf8')).toBe('in-use');
    } finally { await f.cleanup(); }
  });

  it('leaves a profile alone while a Chrome outside this host still holds it', async () => {
    const f = await fixture();
    const { spawn } = await vi.importActual<typeof import('node:child_process')>('node:child_process');
    const holder = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)', '--', `--user-data-dir=${f.paneDir()}`], { stdio: 'ignore' });
    try {
      await signedInProfile(f.paneDir(), 'held');
      f.signedIn.set(f.paneDir(), ['sub-primary']);
      const { symlink } = await import('node:fs/promises');
      await symlink(`testhost-${holder.pid}`, join(f.paneDir(), 'SingletonLock'));
      expect(await f.manager.adoptPaneGoogleProfile!(f.source(), f.operator)).toEqual({ result: 'SOURCE_IN_USE', accountId: null });
      holder.kill('SIGKILL');
      await new Promise(resolve => holder.once('exit', resolve));
      expect(await f.manager.adoptPaneGoogleProfile!(f.source(), f.operator)).toEqual({ result: 'ADOPTED', accountId: f.primary.id });
      await expect(stat(join(f.accountDir(f.primary.id), 'SingletonLock'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { holder.kill('SIGKILL'); await f.cleanup(); }
  });

  it('replaces a never-connected shared profile that another pane has open, which then reconnects to the adopted sign-in', async () => {
    const f = await fixture();
    try {
      await signedInProfile(f.paneDir(), 'pane-sign-in');
      f.signedIn.set(f.paneDir(), ['sub-primary']);
      const shared = await f.manager.startOrRestore({ pane: f.other, googleAccount: { ownerUserId: f.user.id, accountId: f.primary.id }, targetUrl: 'about:blank', includeInitialFrame: false, traceId: 'trace' }, f.operator);
      expect(f.children).toHaveLength(1);
      const result = await f.manager.adoptPaneGoogleProfile!(f.source(), f.operator);
      expect(result).toEqual({ result: 'ADOPTED', accountId: f.primary.id });
      expect(f.children[0].exitCode).toBe(0);
      expect(await readFile(join(f.accountDir(f.primary.id), 'marker.txt'), 'utf8')).toBe('pane-sign-in');
      await f.manager.getActive(f.other);
      const relaunched = f.children.at(-1);
      expect(relaunched.args).toContain(`--user-data-dir=${shared.session.profilePath}`);
      expect(relaunched.exitCode).toBeNull();
    } finally { await f.cleanup(); }
  });

  it('keeps an already connected shared profile and only reports which account the pane holds', async () => {
    const f = await fixture();
    try {
      await signedInProfile(f.paneDir(), 'pane-sign-in');
      f.signedIn.set(f.paneDir(), ['sub-primary']);
      await mkdir(f.accountDir(f.primary.id), { recursive: true });
      await writeFile(join(f.accountDir(f.primary.id), 'marker.txt'), 'shared-session');
      await writeGoogleBrowserCheck(f.accountDir(f.primary.id), { version: 1, status: 'CONNECTED', reason: 'VERIFIED', matchedBy: 'SUB', checkedAt: '2026-10-10T10:00:00.000Z', connectedAt: '2026-10-10T10:00:00.000Z' });
      expect(await f.manager.adoptPaneGoogleProfile!(f.source(), f.operator)).toEqual({ result: 'ALREADY_CONNECTED', accountId: f.primary.id });
      expect(await readFile(join(f.accountDir(f.primary.id), 'marker.txt'), 'utf8')).toBe('shared-session');
      expect(await readFile(join(f.paneDir(), 'marker.txt'), 'utf8')).toBe('pane-sign-in');
    } finally { await f.cleanup(); }
  });

  it('never replaces a shared profile that holds a session, another account or an unverified state', async () => {
    const f = await fixture();
    try {
      await signedInProfile(f.paneDir(), 'pane-sign-in');
      f.signedIn.set(f.paneDir(), ['sub-primary']);
      // Closed, never checked (pre-upgrade), but actually signed in.
      await signedInProfile(f.accountDir(f.primary.id), 'shared-signed-in');
      f.signedIn.set(f.accountDir(f.primary.id), ['sub-primary']);
      expect(await f.manager.adoptPaneGoogleProfile!(f.source(), f.operator)).toEqual({ result: 'ALREADY_CONNECTED', accountId: f.primary.id });
      expect(await readFile(join(f.accountDir(f.primary.id), 'marker.txt'), 'utf8')).toBe('shared-signed-in');
      // Open in a pane and signed in to a different Google account: not killed, not replaced.
      await rm(`${f.accountDir(f.primary.id)}.browser-check.json`, { force: true });
      f.signedIn.set(f.accountDir(f.primary.id), ['sub-elsewhere']);
      await f.manager.startOrRestore({ pane: f.other, googleAccount: { ownerUserId: f.user.id, accountId: f.primary.id }, targetUrl: 'about:blank', includeInitialFrame: false, traceId: 'trace' }, f.operator);
      const running = f.children.at(-1);
      expect(await f.manager.adoptPaneGoogleProfile!(f.source(), f.operator)).toEqual({ result: 'TARGET_IN_USE', accountId: f.primary.id });
      expect(running.exitCode).toBeNull();
      await f.manager.stopPane(f.other.id);
      // Previously connected, now asking to reauthenticate: kept for the user to sign in again.
      await writeGoogleBrowserCheck(f.accountDir(f.primary.id), { version: 1, status: 'REAUTHENTICATION_REQUIRED', reason: 'SESSION_LOST', matchedBy: null, checkedAt: '2026-10-10T10:00:00.000Z', connectedAt: '2026-10-09T10:00:00.000Z' });
      expect(await f.manager.adoptPaneGoogleProfile!(f.source(), f.operator)).toEqual({ result: 'TARGET_IN_USE', accountId: f.primary.id });
      expect(await readFile(join(f.accountDir(f.primary.id), 'marker.txt'), 'utf8')).toBe('shared-signed-in');
      expect(await readFile(join(f.paneDir(), 'marker.txt'), 'utf8')).toBe('pane-sign-in');
    } finally { await f.cleanup(); }
  });

  it('gives an explicit account choice only that account and respects sessions that are active but not running', async () => {
    const f = await fixture();
    try {
      await signedInProfile(f.paneDir(), 'holds-primary');
      f.signedIn.set(f.paneDir(), ['sub-primary']);
      expect(await f.manager.adoptPaneGoogleProfile!({ ...f.source(), accountId: f.second.id }, f.operator)).toEqual({ result: 'OTHER_ACCOUNT', accountId: null });
      expect(await readFile(join(f.paneDir(), 'marker.txt'), 'utf8')).toBe('holds-primary');
      await rm(`${f.paneDir()}.account-probe.json`, { force: true });
      f.store.createPaneBrowserSession({ sessionId: 'browser_session:joined', paneId: f.other.id, roomId: f.room.id, ownerAgentId: null, agentNumber: 1,
        profileId: 'cli-account:x', profilePath: f.paneDir(), viewport: 'desktop', targetUrl: 'about:blank', streamMode: 'AUTO', resolvedStreamMode: 'INTERACTIVE',
        runtimeState: 'READY', capacityState: 'AVAILABLE', status: 'READY', statusReason: 'Ready.' } as never);
      expect(await f.manager.adoptPaneGoogleProfile!(f.source(), f.operator)).toEqual({ result: 'SOURCE_IN_USE', accountId: null });
    } finally { await f.cleanup(); }
  });

  it('remembers a definite answer even though the check itself touched the cookies', async () => {
    const f = await fixture();
    try {
      await signedInProfile(f.paneDir(), 'unlinked');
      f.signedIn.set(f.paneDir(), ['sub-not-linked']);
      expect((await f.manager.adoptPaneGoogleProfile!(f.source(), f.operator)).result).toBe('OTHER_ACCOUNT');
      expect((await f.manager.adoptPaneGoogleProfile!(f.source(), f.operator)).result).toBe('OTHER_ACCOUNT');
      expect(f.children).toHaveLength(1);
    } finally { await f.cleanup(); }
  });

  it('puts back pane scopes and shared profiles left behind by an interrupted move', async () => {
    const f = await fixture();
    try {
      await mkdir(join(`${f.paneDir()}.accounts-123`, 'x'), { recursive: true });
      await writeFile(join(`${f.paneDir()}.accounts-123`, 'x', 'marker.txt'), 'parked');
      await mkdir(`${f.accountDir(f.primary.id)}.replaced-123`, { recursive: true });
      await writeFile(join(`${f.accountDir(f.primary.id)}.replaced-123`, 'marker.txt'), 'shared');
      const restarted = createBrowserSessionManager({ store: f.store, config: getApiConfig({ SPACE_BROWSER_SESSIONS_PROFILE_ROOT: f.root, SPACE_BROWSER_SESSIONS_ENABLED: 'true', SPACE_BROWSER_SESSIONS_CHROME_PATH: process.execPath, SPACE_BROWSER_SESSIONS_XVFB_ENABLED: 'false' }) });
      await restarted.closeAll();
      expect(await readFile(join(f.paneDir(), 'accounts', 'x', 'marker.txt'), 'utf8')).toBe('parked');
      expect(await readFile(join(f.accountDir(f.primary.id), 'marker.txt'), 'utf8')).toBe('shared');
    } finally { await f.cleanup(); }
  });

  it('rejects another operator or an agent and never adopts in proof rooms', async () => {
    const f = await fixture();
    try {
      await signedInProfile(f.paneDir(), 'pane-sign-in');
      f.signedIn.set(f.paneDir(), ['sub-primary']);
      await expect(f.manager.adoptPaneGoogleProfile!(f.source(), { holderType: 'OPERATOR', holderId: 'user:other' })).rejects.toThrow(/owner/);
      await expect(f.manager.adoptPaneGoogleProfile!(f.source(), { holderType: 'AGENT', holderId: f.user.id })).rejects.toThrow(/owner/);
      const proof = f.store.createRoom({ name: 'Proof', kind: 'AGENT_PROOF', initialPaneCount: 0 } as never, 'trace', f.user.id);
      expect(await f.manager.adoptPaneGoogleProfile!({ ...f.source(), roomId: proof.id }, f.operator)).toEqual({ result: 'SOURCE_MISSING', accountId: null });
      expect(f.children).toHaveLength(0);
      expect(await readFile(join(f.paneDir(), 'marker.txt'), 'utf8')).toBe('pane-sign-in');
    } finally { await f.cleanup(); }
  });
});
