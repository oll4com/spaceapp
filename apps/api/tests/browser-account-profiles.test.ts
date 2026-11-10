import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { WebSocketServer } from 'ws';
import { describe, expect, it, vi } from 'vitest';
import { InMemorySpaceStore } from '@space/runtime';
const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', async original => ({ ...await original<typeof import('node:child_process')>(), spawn: mocks.spawn }));
import { createBrowserSessionManager } from '../src/browser-sessions.js';
import { getApiConfig } from '../src/config.js';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'profile-test-'));
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise<void>(resolve => server.once('listening', resolve));
  const commands: { method: string; params: any; sessionId?: string }[] = [];
  const children: any[] = [];
  let seq = 0;
  let targetGate: Promise<void> | undefined;
  let releaseTarget: (() => void) | undefined;
  server.on('connection', socket => {
    const child = children.find(c => !c.connected); child.connected = true; child.socket = socket;
    const pages = new Map<string, { targetId: string; type: string; url: string }>();
    child.pages = pages;
    child.waiting = new Set<string>(); child.held = [] as (() => void)[];
    socket.on('message', async raw => {
      const { id, method, params, sessionId } = JSON.parse(raw.toString());
      commands.push({ method, params, sessionId });
      // Like Chrome, a page waiting for the debugger answers nothing on its session until it is resumed.
      if (child.waiting.has(sessionId) && method !== 'Runtime.runIfWaitingForDebugger') await new Promise<void>(r => child.held.push(r));
      if (method === 'Runtime.runIfWaitingForDebugger' && child.waiting.delete(sessionId)) child.held.splice(0).forEach((r: () => void) => r());
      let result: any = {};
      if (method === 'Target.createTarget') { await targetGate; const targetId = `page-${++seq}`; pages.set(targetId, { targetId, type: 'page', url: params.url }); result = { targetId }; }
      if (method === 'Target.attachToTarget') result = { sessionId: `cdp-${params.targetId}` };
      if (method === 'Target.getTargets') result = { targetInfos: [...pages.values()] };
      if (method === 'Target.closeTarget') { pages.delete(params.targetId); result = { success: true }; }
      if (method === 'Page.captureScreenshot') result = { data: 'iVBORw0KGgo=' };
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
  const user = store.upsertUser({ id: 'user:profile-owner', email: 'owner@example.test', role: 'ADMIN' });
  const account = store.linkGoogleAccount(user.id, { sub: 'verified-a', email: user.email });
  const room = store.createRoom({ name: 'Account profiles', initialPaneCount: 0 }, 'trace:test', user.id);
  const panes = [store.createPane({ roomId: room.id, title: 'One', mode: 'BROWSER' }), store.createPane({ roomId: room.id, title: 'Two', mode: 'YOUTUBE' })];
  const manager = createBrowserSessionManager({ store, config: getApiConfig({ SPACE_BROWSER_SESSIONS_PROFILE_ROOT: root, SPACE_BROWSER_SESSIONS_ENABLED: 'true', SPACE_BROWSER_SESSIONS_CHROME_PATH: process.execPath, SPACE_BROWSER_SESSIONS_XVFB_ENABLED: 'false' }) });
  const start = (pane = panes[0]!, ownerUserId = user.id, accountId = account.id) => manager.startOrRestore({ pane, googleAccount: { ownerUserId, accountId }, targetUrl: 'about:blank', includeInitialFrame: false, traceId: 'trace:test' });
  return { store, user, account, panes, manager, start, commands, children, root, holdTarget() { targetGate = new Promise<void>(r => { releaseTarget = r; }); }, releaseTarget() { releaseTarget?.(); targetGate = undefined; }, async cleanup() { await manager.closeAll(); server.clients.forEach(s => s.terminate()); await new Promise<void>(r => server.close(() => r())); await rm(root, { recursive: true, force: true }); } };
}

describe('verified account browser profiles', () => {
  it('shares one writer across concurrent panes and keeps each pane’s tabs private', async () => {
    const f = await fixture();
    try {
      const [a,b] = await Promise.all(f.panes.map(p => f.start(p)));
      expect(a.session.profilePath).toBe(b.session.profilePath);
      expect(f.children).toHaveLength(1);
      const one = await f.manager.listPages!(f.panes[0]!);
      const two = await f.manager.listPages!(f.panes[1]!);
      expect(one.pages).toHaveLength(1); expect(two.pages).toHaveLength(1);
      expect(one.activePageId).not.toBe(two.activePageId);
      await expect(f.manager.activatePage!(f.panes[0]!, two.activePageId!, 'trace')).rejects.toThrow(/not found/);
      await expect(f.manager.closePage!(f.panes[0]!, two.activePageId!, 'trace')).rejects.toThrow(/not found/);
      const added = await f.manager.createPage!(f.panes[0]!, 'about:blank', true, 'trace');
      expect(added.pages).toHaveLength(2);
      expect((await f.manager.listPages!(f.panes[1]!)).pages).toHaveLength(1);
      await f.manager.stopPane(f.panes[0]!.id);
      expect(f.children[0].exitCode).toBeNull();
      expect((await f.manager.listPages!(f.panes[1]!)).activePageId).toBe(two.activePageId);
      await f.manager.stopPane(f.panes[1]!.id);
      expect(f.commands.filter(c => c.method === 'Browser.close')).toHaveLength(1);
      expect(f.children[0].exitCode).toBe(0);
      const reopened = await f.start();
      expect(reopened.session.profilePath).toBe(a.session.profilePath);
      expect(f.children).toHaveLength(2);
    } finally { await f.cleanup(); }
  });
  it('opens every page of a pane that shares Chrome in its own window, so no pane is a hidden background tab', async () => {
    const f = await fixture();
    try {
      await f.start(f.panes[0]!);
      await f.start(f.panes[1]!);
      await f.manager.createPage!(f.panes[0]!, 'about:blank', false, 'trace');
      const created = f.commands.filter(c => c.method === 'Target.createTarget').map(c => c.params);
      // The first pane was alone when its page opened; later pages open while the Chrome is shared.
      expect(created[0]).not.toHaveProperty('newWindow');
      expect(created.slice(1).every(p => p.newWindow === true)).toBe(true);
      expect(created).toHaveLength(3);
    } finally { await f.cleanup(); }
  });
  it('rejects a forged owner/account pair before launching Chrome', async () => {
    const f = await fixture();
    try {
      await expect(f.start(f.panes[0], 'user:other')).rejects.toThrow(/account|owner/i);
      expect(f.children).toHaveLength(0);
    } finally { await f.cleanup(); }
  });
  it('releases stale streaming capacity when a crashed profile is recovered', async () => {
    const f = await fixture();
    try {
      const opened = await f.start();
      const stream = await f.manager.startFrameStream(opened.session.sessionId, 'REALTIME', () => undefined);
      expect(f.manager.capacity!().activeLiveWorkloads).toBe(1);
      f.children[0].signalCode = 'SIGKILL'; f.children[0].emit('exit', null, 'SIGKILL'); f.children[0].socket.terminate();
      await f.manager.getActive(f.panes[0]!);
      expect(f.children).toHaveLength(2);
      // The live view moves to the new Chrome (2ff0383c4f): the crashed Chrome's slot is released and the stream holds one slot, not two.
      expect(f.manager.capacity!().activeLiveWorkloads).toBe(1);
      await stream.stop();
      expect(f.manager.capacity!().activeLiveWorkloads).toBe(0);
    } finally { await f.cleanup(); }
  });
  it('keeps the replacement stream slot when a stream handle from before the crash stops late', async () => {
    const f = await fixture();
    try {
      const opened = await f.start();
      const stale = await f.manager.startFrameStream!(opened.session.sessionId, 'REALTIME', () => undefined);
      f.children[0].signalCode = 'SIGKILL'; f.children[0].emit('exit', null, 'SIGKILL'); f.children[0].socket.terminate();
      await f.manager.getActive(f.panes[0]!);
      const fresh = await f.manager.startFrameStream!(opened.session.sessionId, 'REALTIME', () => undefined);
      expect(f.manager.capacity!().activeLiveWorkloads).toBe(1);
      // The dead stream's viewer goes away only now; the replacement stream keeps its slot.
      await stale.stop();
      expect(f.manager.capacity!().activeLiveWorkloads).toBe(1);
      expect(f.commands.filter(c => c.method === 'Page.stopScreencast')).toHaveLength(0);
      await fresh.stop();
      expect(f.manager.capacity!().activeLiveWorkloads).toBe(0);
      expect(f.commands.filter(c => c.method === 'Page.stopScreencast')).toHaveLength(1);
    } finally { await f.cleanup(); }
  });
  it('serializes final close against a new pane and isolates a different operator', async () => {
    const f = await fixture();
    try {
      await f.start();
      await expect(f.manager.startOrRestore({ pane: f.panes[1]!, googleAccount: { ownerUserId: f.user.id, accountId: f.account.id }, traceId: 'trace' }, { holderType: 'OPERATOR', holderId: 'user:other' })).rejects.toThrow(/owner/);
      await Promise.all([f.manager.stopPane(f.panes[0]!.id), f.start(f.panes[1])]);
      expect((await f.manager.listPages!(f.panes[1]!)).pages).toHaveLength(1);
      expect(f.children.filter(c => c.exitCode === null && c.signalCode === null)).toHaveLength(1);
    } finally { await f.cleanup(); }
  });
  it('rejects a tab creation that finishes after its pane has closed', async () => {
    const f = await fixture();
    try {
      await Promise.all(f.panes.map(p => f.start(p)));
      f.holdTarget();
      const creating = f.manager.createPage!(f.panes[0]!, 'about:blank', false, 'trace');
      const result = creating.then(() => 'unexpected success', () => 'closed');
      await vi.waitFor(() => expect(f.commands.filter(c => c.method === 'Target.createTarget')).toHaveLength(3));
      await f.manager.stopPane(f.panes[0]!.id);
      f.releaseTarget();
      expect(await result).toBe('closed');
      expect(f.children[0].pages.size).toBe(1);
      expect((await f.manager.listPages!(f.panes[1]!)).pages).toHaveLength(1);
    } finally { f.releaseTarget(); await f.cleanup(); }
  });
  it('hands the pane back to the opener when its active popup closes itself', async () => {
    const f = await fixture();
    try {
      await f.start();
      const first = (await f.manager.listPages!(f.panes[0]!)).activePageId!;
      const opener = (await f.manager.createPage!(f.panes[0]!, 'about:blank', false, 'trace')).pages.find(p => p.pageId !== first)!.pageId;
      // A sign-in button on the second tab opens a popup; the operator switches to it and the site closes it.
      const chrome = f.children[0];
      chrome.pages.set('popup-1', { targetId: 'popup-1', type: 'page', url: 'about:blank' });
      chrome.socket.send(JSON.stringify({ method: 'Target.attachedToTarget', params: { sessionId: 'cdp-popup-1', waitingForDebugger: true, targetInfo: { targetId: 'popup-1', type: 'page', openerId: opener } } }));
      await vi.waitFor(async () => expect((await f.manager.listPages!(f.panes[0]!)).pages.map(p => p.pageId)).toContain('popup-1'));
      expect((await f.manager.activatePage!(f.panes[0]!, 'popup-1', 'trace')).activePageId).toBe('popup-1');
      chrome.pages.delete('popup-1');
      chrome.socket.send(JSON.stringify({ method: 'Target.detachedFromTarget', params: { sessionId: 'cdp-popup-1', targetId: 'popup-1' } }));
      await vi.waitFor(async () => expect((await f.manager.listPages!(f.panes[0]!)).activePageId).toBe(opener));
      // Closing the active tab moves off it first, so its detach changes nothing.
      expect((await f.manager.closePage!(f.panes[0]!, opener, 'trace')).activePageId).toBe(first);
      chrome.socket.send(JSON.stringify({ method: 'Target.detachedFromTarget', params: { sessionId: `cdp-${opener}`, targetId: opener } }));
      expect((await f.manager.listPages!(f.panes[0]!)).activePageId).toBe(first);
    } finally { await f.cleanup(); }
  });
  it('shows a popup opened by the page the pane shows, but not one opened by a background tab', async () => {
    const f = await fixture();
    try {
      await f.start();
      const shown = (await f.manager.listPages!(f.panes[0]!)).activePageId!;
      const background = (await f.manager.createPage!(f.panes[0]!, 'about:blank', false, 'trace')).pages.find(p => p.pageId !== shown)!.pageId;
      const chrome = f.children[0];
      const openPopup = (id: string, openerId: string) => {
        chrome.pages.set(id, { targetId: id, type: 'page', url: 'about:blank' });
        chrome.socket.send(JSON.stringify({ method: 'Target.attachedToTarget', params: { sessionId: `cdp-${id}`, waitingForDebugger: true, targetInfo: { targetId: id, type: 'page', openerId } } }));
      };
      openPopup('popup-bg', background);
      await vi.waitFor(async () => expect((await f.manager.listPages!(f.panes[0]!)).pages.map(p => p.pageId)).toContain('popup-bg'));
      expect((await f.manager.listPages!(f.panes[0]!)).activePageId).toBe(shown);
      // "Continue with Google" on the watched page: the operator must see the account chooser.
      openPopup('popup-google', shown);
      await vi.waitFor(async () => expect((await f.manager.listPages!(f.panes[0]!)).activePageId).toBe('popup-google'));
      // The popup closes itself after the login and the view returns to its opener.
      chrome.pages.delete('popup-google');
      chrome.socket.send(JSON.stringify({ method: 'Target.detachedFromTarget', params: { sessionId: 'cdp-popup-google', targetId: 'popup-google' } }));
      await vi.waitFor(async () => expect((await f.manager.listPages!(f.panes[0]!)).activePageId).toBe(shown));
    } finally { await f.cleanup(); }
  });
  it('resumes a popup that answers only after the resume, and writes its request guard first', async () => {
    const f = await fixture();
    try {
      await f.start();
      const shown = (await f.manager.listPages!(f.panes[0]!)).activePageId!;
      const chrome = f.children[0];
      // A noopener link in Gmail ("Confirm your email address"): the tab stayed blank and wedged the pane.
      chrome.waiting.add('cdp-popup-mail');
      chrome.pages.set('popup-mail', { targetId: 'popup-mail', type: 'page', url: '' });
      chrome.socket.send(JSON.stringify({ method: 'Target.attachedToTarget', params: { sessionId: 'cdp-popup-mail', waitingForDebugger: true, targetInfo: { targetId: 'popup-mail', type: 'page', openerId: shown } } }));
      await vi.waitFor(async () => expect((await f.manager.listPages!(f.panes[0]!)).activePageId).toBe('popup-mail'));
      const sent = f.commands.filter(c => c.sessionId === 'cdp-popup-mail').map(c => c.method);
      expect(sent.indexOf('Fetch.enable')).toBeGreaterThanOrEqual(0);
      expect(sent.indexOf('Fetch.enable')).toBeLessThan(sent.indexOf('Runtime.runIfWaitingForDebugger'));
    } finally { await f.cleanup(); }
  });
  it('uses distinct writers for different verified accounts', async () => {
    const f = await fixture();
    try {
      const b = f.store.linkGoogleAccount(f.user.id, { sub: 'verified-b', email: 'b@example.test' });
      const a = await f.start(); const other = await f.start(f.panes[1], f.user.id, b.id);
      expect(a.session.profilePath).not.toBe(other.session.profilePath);
      expect(f.children).toHaveLength(2);
    } finally { await f.cleanup(); }
  });
});
