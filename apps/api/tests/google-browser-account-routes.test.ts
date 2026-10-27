import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { InMemorySpaceStore } from '@space/runtime';
import { createApp } from '../src/app.js';
import { getApiConfig } from '../src/config.js';
import { signSession, createCsrfToken } from '../src/auth.js';
import { googleBrowserProfilePathFor, sharedCliProfilePathFor } from '../src/browser-sessions.js';
import { youtubeAccountProfileKey } from '../src/youtube-accounts.js';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { BrowserSessionManager } from '../src/browser-sessions.js';
import { classifyGoogleBrowserEvidence, writeGoogleBrowserCheck } from '../src/google-browser-session-check.js';

describe('verified browser account selection compatibility', () => {
  const store = new InMemorySpaceStore();
  const user = store.upsertUser({ id: 'user:browser-owner', email: 'browser-owner@example.test', role: 'ADMIN' });
  const stranger = store.upsertUser({ id: 'user:browser-stranger', email: 'stranger@example.test', role: 'ADMIN' });
  const account = store.linkGoogleAccount(user.id, { sub: 'browser-owner', email: user.email });
  const foreign = store.linkGoogleAccount(stranger.id, { sub: 'foreign-account', email: stranger.email });
  const token = signSession(user, 'test-browser-account-secret');
  const headers = { cookie: `space_session=${token}`, 'x-space-csrf-token': createCsrfToken(token, 'test-browser-account-secret')! };
  const room = store.createRoom({ name: 'Owned account fixture', initialPaneCount: 0 }, 'trace', user.id);
  const start = vi.fn(async () => ({ session: { sessionId: 'browser_session:test' }, frame: null, websocket: null }));
  const stop = vi.fn(async () => undefined);
  const check = vi.fn(async (): Promise<unknown> => ({ status: 'CONNECTED', reason: 'VERIFIED', checkedAt: '2026-10-10T12:00:00.000Z', connectedAt: '2026-10-10T12:00:00.000Z' }));
  const adopt = vi.fn(async (): Promise<unknown> => ({ result: 'NO_SIGN_IN', accountId: null }));
  const manager: Record<string, unknown> = {};
  let app: Awaited<ReturnType<typeof createApp>>;
  let root: string;
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'route-test-'));
    Object.assign(manager, { startOrRestore: start, stopPane: stop, checkGoogleAccount: check, adoptPaneGoogleProfile: adopt, closeAll: async () => {}, status: () => ({ enabled: true, statusReason: 'Test', defaultUrl: 'about:blank', checkedAt: new Date().toISOString() }) });
    app = await createApp({ store, browserSessionManager: manager as unknown as BrowserSessionManager,
      readGeminiAccountProfileDetails: async profileId => ({ authStatus: 'CONNECTED', email: `${profileId}@gemini.example.test` }),
      config: getApiConfig({ SPACE_ARTIFACT_ROOT: root + '/browser-evidence', SPACE_BROWSER_SESSIONS_PROFILE_ROOT: root + '/profiles' }),
      auth: { sessionSecret: 'test-browser-account-secret', devLogin: false, secureCookies: false } });
  }, 30000);
  afterAll(async () => { await app?.close(); if (root) await rm(root, { recursive: true, force: true }); }, 30000);
  it.each(['BROWSER','YOUTUBE'] as const)('selects an owned registry ID for %s and passes a verified scope to the host', async mode => {
    const pane = store.createPane({ roomId: room.id, title: 'Selection', mode });
    const path = `/api/panes/${pane.id}/${mode.toLowerCase()}/accounts`;
    const selection = await app.inject({ method: 'PUT', url: path, headers, payload: { profileId: account.id } });
    expect(selection.statusCode).toBe(200);
    expect(selection.json().selectedProfileId).toBe(account.id);
    expect((await app.inject({ method: 'GET', url: path, headers })).json().profiles).toEqual(expect.arrayContaining([expect.objectContaining({ profileId: account.id, displayName: expect.stringMatching(/^Google account · /) })]));
    const opened = await app.inject({ method: 'POST', url: `/api/panes/${pane.id}/browser/session`, headers, payload: { targetUrl: 'about:blank', includeInitialFrame: false } });
    expect(opened.statusCode).toBeLessThan(300);
    expect(start).toHaveBeenLastCalledWith(expect.objectContaining({ googleAccount: { ownerUserId: user.id, accountId: account.id }, profileKey: null }), expect.anything());
    const denied = await app.inject({ method: 'PUT', url: path, headers, payload: { profileId: foreign.id } });
    expect(denied.statusCode).toBe(404);
  });
  it('moves one tab into another account with a server-derived identity, and refuses old hosts and Freelance panes', async () => {
    const tabsRoom = store.createRoom({ name: 'Tab account fixture', initialPaneCount: 0 }, 'trace', user.id);
    const pane = store.createPane({ roomId: tabsRoom.id, title: 'Andy', mode: 'MARKETING_COPILOT' });
    if (!store.getCliAccountProfile('cli:gemini', 'ind')) store.createCliAccountProfile('cli:gemini', { runtimeId: 'cli:gemini', profileId: 'ind', displayName: 'ind' }, 'trace:gemini-tab');
    const page = { pageId: 'page:two', kind: 'PAGE', url: 'https://example.com/', title: null, isActive: true, openerPageId: null, canGoBack: false, canGoForward: false };
    let pages: Array<Record<string, unknown>> = [{ ...page, account: null }];
    const listPages = vi.fn(async () => ({ sessionId: 'browser_session:test', activePageId: 'page:two', pages }));
    Object.assign(manager, { listPages });
    const url = (paneId = pane.id) => `/api/panes/${paneId}/browser/pages/page:two/account`;
    start.mockClear();

    const linked = await app.inject({ method: 'POST', url: url(), headers, payload: { profileId: account.id } });
    expect(linked.statusCode, linked.body).toBe(200);
    expect(linked.json().pages).toHaveLength(1);
    expect(start).toHaveBeenLastCalledWith({ pane: expect.objectContaining({ id: pane.id }), googleAccount: { ownerUserId: user.id, accountId: account.id },
      accountTab: { pageId: 'page:two', profileId: account.id, label: user.email }, traceId: expect.any(String) }, expect.anything());
    await app.inject({ method: 'POST', url: url(), headers, payload: { profileId: 'ind', signIn: true } });
    expect(start).toHaveBeenLastCalledWith(expect.objectContaining({ sharedProfileKey: youtubeAccountProfileKey(user.id, 'ind'),
      accountTab: { pageId: 'page:two', profileId: 'ind', label: 'ind@gemini.example.test', url: expect.stringMatching(/^https:\/\/accounts\.google\.com\/ServiceLogin\?.*Email=ind%40gemini/) } }), expect.anything());
    await app.inject({ method: 'POST', url: url(), headers, payload: { profileId: null } });
    expect(start).toHaveBeenLastCalledWith({ pane: expect.objectContaining({ id: pane.id }), accountTab: { pageId: 'page:two', profileId: null, label: null }, traceId: expect.any(String) }, expect.anything());
    expect((await app.inject({ method: 'POST', url: url(), headers, payload: { profileId: foreign.id } })).statusCode).toBe(404);

    start.mockClear();
    pages = [page];
    const oldHost = await app.inject({ method: 'POST', url: url(), headers, payload: { profileId: account.id } });
    expect(oldHost.statusCode).toBe(409);
    expect(oldHost.body).toContain('BROWSER_HOST_RESTART_REQUIRED');
    const freelance = store.createPane({ roomId: tabsRoom.id, title: 'Freelance', mode: 'FREELANCE_COPILOT' });
    expect((await app.inject({ method: 'POST', url: url(freelance.id), headers, payload: { profileId: account.id } })).statusCode).toBe(409);
    expect(start).not.toHaveBeenCalled();
    delete manager.listPages;
  });
  it('opens a Marketing Copilot bookmark in a new tab of its Google account, straight in that account', async () => {
    const bookmarksRoom = store.createRoom({ name: 'Bookmark fixture', initialPaneCount: 0 }, 'trace', user.id);
    const pane = store.createPane({ roomId: bookmarksRoom.id, title: 'Andy', mode: 'MARKETING_COPILOT' });
    if (!store.getCliAccountProfile('cli:gemini', 'ind')) store.createCliAccountProfile('cli:gemini', { runtimeId: 'cli:gemini', profileId: 'ind', displayName: 'ind' }, 'trace:gemini-bookmark');
    const blank = { pageId: 'page:blank', kind: 'PAGE', url: 'about:blank', title: null, isActive: true, openerPageId: null, canGoBack: false, canGoForward: false };
    let pages: Array<Record<string, unknown>> = [{ ...blank, account: null }];
    const createPage = vi.fn(async () => ({ sessionId: 'browser_session:test', activePageId: 'page:blank', pages }));
    const closePage = vi.fn(async () => ({ sessionId: 'browser_session:test', activePageId: null, pages: [] }));
    Object.assign(manager, { createPage, closePage, listPages: vi.fn(async () => ({ sessionId: 'browser_session:test', activePageId: 'page:blank', pages })) });
    const save = async (payload: Record<string, unknown>) => {
      const saved = await app.inject({ method: 'POST', url: '/api/marketing-copilot/bookmarks', headers, payload });
      expect(saved.statusCode, saved.body).toBe(200);
      return saved.json().bookmark as { id: string };
    };
    const open = (id: string) => app.inject({ method: 'POST', url: `/api/panes/${pane.id}/marketing-copilot/bookmarks/${id}/open`, headers, payload: {} });
    try {
      start.mockClear();
      const x = await save({ url: 'https://x.com/home', profileId: 'ind', accountLabel: 'ind@gemini.example.test' });
      expect((await open(x.id)).statusCode).toBe(200);
      // A blank tab moves into the other account's Chrome with the address, so x.com never loads in the pane's account.
      expect(createPage).toHaveBeenLastCalledWith(expect.objectContaining({ id: pane.id }), undefined, true, expect.any(String), expect.anything());
      expect(start).toHaveBeenLastCalledWith(expect.objectContaining({ sharedProfileKey: youtubeAccountProfileKey(user.id, 'ind'),
        accountTab: { pageId: 'page:blank', profileId: 'ind', label: 'ind@gemini.example.test', url: 'https://x.com/home' } }), expect.anything());
      expect((await app.inject({ method: 'GET', url: '/api/marketing-copilot/bookmarks', headers })).json().bookmarks).toEqual(expect.arrayContaining([expect.objectContaining({ id: x.id, accountLabel: 'ind@gemini.example.test' })]));

      // The pane's own account: a plain new tab.
      start.mockClear();
      const hn = await save({ url: 'https://news.ycombinator.com/', profileId: null });
      expect((await open(hn.id)).statusCode).toBe(200);
      expect(createPage).toHaveBeenLastCalledWith(expect.objectContaining({ id: pane.id }), 'https://news.ycombinator.com/', true, expect.any(String), expect.anything());
      expect(start).not.toHaveBeenCalled();

      // A host without per-tab accounts refuses, and the blank tab it opened closes again.
      pages = [blank];
      const oldHost = await open(x.id);
      expect(oldHost.statusCode).toBe(409);
      expect(oldHost.body).toContain('BROWSER_HOST_RESTART_REQUIRED');
      expect(closePage).toHaveBeenCalledWith(expect.objectContaining({ id: pane.id }), 'page:blank', expect.any(String), expect.anything());
      expect((await app.inject({ method: 'POST', url: '/api/marketing-copilot/bookmarks', headers, payload: { url: 'javascript:alert(1)' } })).statusCode).toBe(422);
    } finally {
      delete manager.createPage;
      delete manager.closePage;
      delete manager.listPages;
    }
  });
  it('lets a Job Copilot pane choose its browser account through the Browser account routes', async () => {
    const copilotRoom = store.createRoom({ name: 'Job Copilot account fixture', initialPaneCount: 0 }, 'trace', user.id);
    const pane = store.createPane({ roomId: copilotRoom.id, title: 'Job Copilot', mode: 'JOB_APPLY' });
    const path = `/api/panes/${pane.id}/browser/accounts`;
    const listed = await app.inject({ method: 'GET', url: path, headers });
    expect(listed.statusCode, listed.body).toBe(200);
    expect(listed.json().profiles).toEqual(expect.arrayContaining([expect.objectContaining({ profileId: account.id, email: user.email })]));
    const selection = await app.inject({ method: 'PUT', url: path, headers, payload: { profileId: account.id } });
    expect(selection.statusCode, selection.body).toBe(200);
    expect(selection.json()).toEqual({ selectedProfileId: account.id, targetUrl: expect.any(String) });
    // The account chosen in a Job Copilot pane is also the copilot's Google account for mail and calendar.
    const profile = await app.inject({ method: 'GET', url: '/api/job-apply/profile', headers });
    expect(profile.json().profile.google).toEqual({ email: user.email, capabilities: [], available: false });
    const opened = await app.inject({ method: 'POST', url: `/api/panes/${pane.id}/browser/session`, headers, payload: { targetUrl: 'about:blank', includeInitialFrame: false } });
    expect(opened.statusCode).toBeLessThan(300);
    expect(start).toHaveBeenLastCalledWith(expect.objectContaining({ googleAccount: { ownerUserId: user.id, accountId: account.id } }), expect.anything());
    const youtube = store.createPane({ roomId: copilotRoom.id, title: 'Not a browser', mode: 'YOUTUBE' });
    expect((await app.inject({ method: 'GET', url: `/api/panes/${youtube.id}/browser/accounts`, headers })).statusCode).toBe(409);
  });
  it('opens a new Job Copilot pane with the previous one\'s account, view and tabs', async () => {
    const copilotRoom = store.createRoom({ name: 'Job Copilot continuity', initialPaneCount: 0 }, 'trace', user.id);
    const createPane = async () => {
      const created = await app.inject({ method: 'POST', url: '/api/panes', headers, payload: { roomId: copilotRoom.id, title: 'Job Copilot', mode: 'JOB_APPLY' } });
      expect(created.statusCode, created.body).toBe(200);
      return created.json() as { id: string };
    };
    const first = await createPane();
    expect((await app.inject({ method: 'PUT', url: `/api/panes/${first.id}/browser/accounts`, headers, payload: { profileId: 'private:pane' } })).statusCode).toBe(200);
    const session = store.createPaneBrowserSession({ paneId: first.id, roomId: copilotRoom.id, ownerAgentId: null, agentNumber: 1, profileId: 'private', profilePath: '/tmp/profile',
      viewport: 'mobile', targetUrl: 'https://www.linkedin.com/jobs/', streamMode: 'AUTO', resolvedStreamMode: 'PREVIEW', runtimeState: 'READY', capacityState: 'AVAILABLE', controlState: 'UNCONTROLLED',
      pages: [], activePageId: null, workerHeartbeatAt: null, queuePosition: null });
    store.updatePaneBrowserSession(session.sessionId, { status: 'CLOSED', activePageId: 'page:2', pages: [
      { pageId: 'page:1', kind: 'PAGE', url: 'https://www.linkedin.com/jobs/view/1', title: 'Job 1', isActive: false, openerPageId: null, canGoBack: false, canGoForward: false },
      { pageId: 'page:2', kind: 'PAGE', url: 'https://boards.greenhouse.io/acme/jobs/2', title: 'Acme', isActive: true, openerPageId: null, canGoBack: false, canGoForward: false },
      { pageId: 'page:3', kind: 'PAGE', url: 'chrome://settings', title: 'Settings', isActive: false, openerPageId: null, canGoBack: false, canGoForward: false }
    ] });
    store.updatePane(first.id, { isClosed: true, status: 'CLOSED' });

    const second = await createPane();
    expect((await app.inject({ method: 'GET', url: `/api/panes/${second.id}/browser/accounts`, headers })).json().selectedProfileId).toBe('private:pane');
    const createPage = vi.fn(async () => ({}));
    manager.createPage = createPage;
    try {
      const opened = await app.inject({ method: 'POST', url: `/api/panes/${second.id}/browser/session`, headers, payload: { targetUrl: 'about:blank', viewport: 'desktop', includeInitialFrame: false } });
      expect(opened.statusCode, opened.body).toBeLessThan(300);
      expect(start).toHaveBeenLastCalledWith(expect.objectContaining({ viewport: 'mobile', targetUrl: 'https://boards.greenhouse.io/acme/jobs/2' }), expect.anything());
      await vi.waitFor(() => expect(createPage).toHaveBeenCalledTimes(1));
      expect(createPage).toHaveBeenCalledWith(expect.objectContaining({ id: second.id }), 'https://www.linkedin.com/jobs/view/1', false, expect.anything(), expect.anything());
    } finally {
      delete manager.createPage;
    }
    // Only before the pane's own first session: later starts are its own.
    store.createPaneBrowserSession({ paneId: second.id, roomId: copilotRoom.id, ownerAgentId: null, agentNumber: 1, profileId: 'private', profilePath: '/tmp/profile2',
      viewport: 'desktop', targetUrl: 'about:blank', streamMode: 'AUTO', resolvedStreamMode: 'PREVIEW', runtimeState: 'READY', capacityState: 'AVAILABLE', controlState: 'UNCONTROLLED',
      pages: [], activePageId: null, workerHeartbeatAt: null, queuePosition: null });
    await app.inject({ method: 'POST', url: `/api/panes/${second.id}/browser/session`, headers, payload: { targetUrl: 'about:blank', viewport: 'desktop', includeInitialFrame: false } });
    expect(start).toHaveBeenLastCalledWith(expect.objectContaining({ viewport: 'desktop', targetUrl: 'about:blank' }), expect.anything());
  });
  it('opens a new Marketing Copilot pane with the previous Marketing pane\'s account and tabs, never a Job Copilot pane\'s', async () => {
    const room = store.createRoom({ name: 'Marketing Copilot continuity', initialPaneCount: 0 }, 'trace', user.id);
    const createPane = async (mode: 'MARKETING_COPILOT' | 'JOB_APPLY') => {
      const created = await app.inject({ method: 'POST', url: '/api/panes', headers, payload: { roomId: room.id, title: mode, mode } });
      expect(created.statusCode, created.body).toBe(200);
      return created.json() as { id: string };
    };
    const first = await createPane('MARKETING_COPILOT');
    expect((await app.inject({ method: 'PUT', url: `/api/panes/${first.id}/browser/accounts`, headers, payload: { profileId: 'private:pane' } })).statusCode).toBe(200);
    const session = store.createPaneBrowserSession({ paneId: first.id, roomId: room.id, ownerAgentId: null, agentNumber: 1, profileId: 'private', profilePath: '/tmp/profile',
      viewport: 'desktop', targetUrl: 'https://x.com/home', streamMode: 'AUTO', resolvedStreamMode: 'PREVIEW', runtimeState: 'READY', capacityState: 'AVAILABLE', controlState: 'UNCONTROLLED',
      pages: [], activePageId: null, workerHeartbeatAt: null, queuePosition: null });
    store.updatePaneBrowserSession(session.sessionId, { status: 'CLOSED', activePageId: 'page:1', pages: [
      { pageId: 'page:1', kind: 'PAGE', url: 'https://x.com/home', title: 'Home / X', isActive: true, openerPageId: null, canGoBack: false, canGoForward: false }
    ] });
    store.updatePane(first.id, { isClosed: true, status: 'CLOSED' });
    // A Job Copilot pane closed later in the same room keeps its own account to itself.
    const job = await createPane('JOB_APPLY');
    store.updatePane(job.id, { isClosed: true, status: 'CLOSED' });

    const second = await createPane('MARKETING_COPILOT');
    expect((await app.inject({ method: 'GET', url: `/api/panes/${second.id}/browser/accounts`, headers })).json().selectedProfileId).toBe('private:pane');
    const opened = await app.inject({ method: 'POST', url: `/api/panes/${second.id}/browser/session`, headers, payload: { targetUrl: 'about:blank', viewport: 'desktop', includeInitialFrame: false } });
    expect(opened.statusCode, opened.body).toBeLessThan(300);
    expect(start).toHaveBeenLastCalledWith(expect.objectContaining({ targetUrl: 'https://x.com/home' }), expect.anything());
  });

  it.each(['BROWSER','YOUTUBE'] as const)('uses the primary account for a new %s pane while preserving an explicit pane choice', async mode => {
    const created = await app.inject({ method: 'POST', url: '/api/panes', headers, payload: { roomId: room.id, title: 'New pane', mode } });
    expect(created.statusCode, created.body).toBe(200);
    const pane = created.json();
    const path = `/api/panes/${pane.id}/${mode.toLowerCase()}/accounts`;
    const initial = await app.inject({ method: 'GET', url: path, headers });
    expect(initial.statusCode, initial.body).toBe(200);
    expect(initial.json().selectedProfileId).toBe(account.id);
    const opened = await app.inject({ method: 'POST', url: `/api/panes/${pane.id}/browser/session`, headers, payload: { targetUrl: 'about:blank', includeInitialFrame: false } });
    expect(opened.statusCode).toBeLessThan(300);
    expect(start).toHaveBeenLastCalledWith(expect.objectContaining({ googleAccount: { ownerUserId: user.id, accountId: account.id } }), expect.anything());
    expect((await app.inject({ method: 'PUT', url: path, headers, payload: { profileId: null } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: path, headers })).json().selectedProfileId).toBeNull();
  });
  it('opens Freelance Copilot panes on the account\'s one shared Chrome like every other browser pane (operator 2026-10-21)', async () => {
    if (!store.getCliAccountProfile('cli:gemini', 'ind')) store.createCliAccountProfile('cli:gemini', { runtimeId: 'cli:gemini', profileId: 'ind', displayName: 'ind' }, 'trace:gemini-freelance');
    const freelanceRoom = store.createRoom({ name: 'Freelance Copilot profile', initialPaneCount: 0 }, 'trace', user.id);
    const createPane = async (mode: string) => {
      const created = await app.inject({ method: 'POST', url: '/api/panes', headers, payload: { roomId: freelanceRoom.id, title: mode, mode } });
      expect(created.statusCode, created.body).toBe(200);
      return created.json() as { id: string };
    };
    const accountsOf = async (paneId: string) => (await app.inject({ method: 'GET', url: `/api/panes/${paneId}/browser/accounts`, headers })).json();
    const openedWith = async (paneId: string) => {
      const opened = await app.inject({ method: 'POST', url: `/api/panes/${paneId}/browser/session`, headers, payload: { targetUrl: 'about:blank', includeInitialFrame: false } });
      expect(opened.statusCode, opened.body).toBeLessThan(300);
      return start.mock.calls.at(-1)![0] as Record<string, unknown>;
    };
    const browser = await createPane('BROWSER');
    const first = await createPane('FREELANCE_COPILOT');
    expect((await accountsOf(first.id)).selectedProfileId).toBe(account.id);
    const opened = await openedWith(first.id);
    expect(opened).toMatchObject({ googleAccount: { ownerUserId: user.id, accountId: account.id }, profileKey: null });
    expect(opened.sharedProfileKey).toBeUndefined();
    expect((await openedWith(browser.id)).googleAccount).toEqual(opened.googleAccount);
    // The menu shows the same sign-in as every other pane's.
    expect((await accountsOf(first.id)).profiles).toEqual((await accountsOf(browser.id)).profiles);
    // A later Freelance pane continues the account.
    store.updatePane(first.id, { isClosed: true, status: 'CLOSED' });
    const second = await createPane('FREELANCE_COPILOT');
    expect((await accountsOf(second.id)).selectedProfileId).toBe(account.id);
    // A Gemini account opens the one profile every pane opens for it.
    expect((await app.inject({ method: 'PUT', url: `/api/panes/${second.id}/browser/accounts`, headers, payload: { profileId: 'ind' } })).statusCode).toBe(200);
    const gemini = await openedWith(second.id);
    expect(gemini.googleAccount).toBeUndefined();
    expect(gemini.sharedProfileKey).toBe(youtubeAccountProfileKey(user.id, 'ind'));
  });
  it('opens a bookmark in Browser and Freelance panes; a Freelance bookmark of another account reopens the pane in that account', async () => {
    if (!store.getCliAccountProfile('cli:gemini', 'ind')) store.createCliAccountProfile('cli:gemini', { runtimeId: 'cli:gemini', profileId: 'ind', displayName: 'ind' }, 'trace:gemini-freelance-bookmark');
    const freelanceRoom = store.createRoom({ name: 'Freelance bookmark fixture', initialPaneCount: 0 }, 'trace', user.id);
    const created = await app.inject({ method: 'POST', url: '/api/panes', headers, payload: { roomId: freelanceRoom.id, title: 'Freelance Copilot', mode: 'FREELANCE_COPILOT' } });
    expect(created.statusCode, created.body).toBe(200);
    const pane = created.json() as { id: string };
    const pages = { sessionId: 'browser_session:test', activePageId: 'page:fiverr', pages: [] };
    const createPage = vi.fn(async () => pages);
    Object.assign(manager, { createPage, listPages: vi.fn(async () => pages) });
    const save = async (payload: Record<string, unknown>) => (await app.inject({ method: 'POST', url: '/api/marketing-copilot/bookmarks', headers, payload })).json().bookmark as { id: string };
    const open = (id: string) => app.inject({ method: 'POST', url: `/api/panes/${pane.id}/marketing-copilot/bookmarks/${id}/open`, headers, payload: {} });
    try {
      // The pane's account: a plain new tab, the browser stays.
      const own = await save({ url: 'https://www.upwork.com/nx/find-work/', profileId: account.id, accountLabel: user.email });
      start.mockClear(); stop.mockClear();
      expect((await open(own.id)).statusCode).toBe(200);
      expect(createPage).toHaveBeenLastCalledWith(expect.objectContaining({ id: pane.id }), 'https://www.upwork.com/nx/find-work/', true, expect.any(String), expect.anything());
      expect(stop).not.toHaveBeenCalled();
      // Every browser pane with a Google account opens the same bookmarks (operator 2026-10-21).
      const browserPane = store.createPane({ roomId: freelanceRoom.id, title: 'Browser', mode: 'BROWSER' });
      expect((await app.inject({ method: 'POST', url: `/api/panes/${browserPane.id}/marketing-copilot/bookmarks/${own.id}/open`, headers, payload: {} })).statusCode).toBe(200);
      expect(createPage).toHaveBeenLastCalledWith(expect.objectContaining({ id: browserPane.id }), 'https://www.upwork.com/nx/find-work/', true, expect.any(String), expect.anything());
      // Another account: the Freelance pane reopens in that account (its routes) with the page, never a tab in another Chrome.
      const fiverr = await save({ url: 'https://www.fiverr.com/users/oll4_com/manage_gigs', profileId: 'ind', accountLabel: 'ind@gemini.example.test' });
      createPage.mockClear(); start.mockClear();
      const opened = await open(fiverr.id);
      expect(opened.statusCode, opened.body).toBe(200);
      expect(stop).toHaveBeenCalledWith(pane.id, expect.any(String), expect.anything());
      expect(createPage).not.toHaveBeenCalled();
      expect(start).toHaveBeenCalledTimes(1);
      expect(start).toHaveBeenLastCalledWith(expect.objectContaining({ sharedProfileKey: youtubeAccountProfileKey(user.id, 'ind'), targetUrl: 'https://www.fiverr.com/users/oll4_com/manage_gigs' }), expect.anything());
      expect(start.mock.calls.at(-1)![0]).not.toHaveProperty('accountTab');
      expect((await app.inject({ method: 'GET', url: `/api/panes/${pane.id}/browser/accounts`, headers })).json().selectedProfileId).toBe('ind');
    } finally {
      delete manager.createPage;
      delete manager.listPages;
    }
  });
  it('keeps a pre-existing pane without a selection on its original saved pane profile', async () => {
    const pane = store.createPane({ roomId: room.id, title: 'Existing pane', mode: 'BROWSER' });
    const selected = await app.inject({ method: 'GET', url: `/api/panes/${pane.id}/browser/accounts`, headers });
    expect(selected.statusCode).toBe(200);
    expect(selected.json().selectedProfileId).toBeNull();
  });
  it('reports profile presence without claiming an authenticated Google browser session', async () => {
    const path = '/api/auth/google/accounts';
    const missing = await app.inject({ method: 'GET', url: path, headers });
    expect(missing.statusCode).toBe(200);
    expect(missing.json().accounts.find((entry: { id: string }) => entry.id === account.id).browserStatus).toBe('NOT_CONNECTED');
    const profile = googleBrowserProfilePathFor(root + '/profiles', user.id, account.id);
    await mkdir(profile, { recursive: true });
    const present = await app.inject({ method: 'GET', url: path, headers });
    expect(present.json().accounts.find((entry: { id: string }) => entry.id === account.id).browserStatus).toBe('UNKNOWN');
  });
  it('shows Connected only from a persisted Google check of the account profile', async () => {
    const profile = googleBrowserProfilePathFor(root + '/profiles', user.id, account.id);
    await mkdir(profile, { recursive: true });
    const at = '2026-10-10T12:00:00.000Z';
    await writeGoogleBrowserCheck(profile, classifyGoogleBrowserEvidence({ ok: true, httpStatus: 200, accounts: [{ subMatches: true, emailMatches: true, valid: true, signedOut: false }] }, null, at));
    const listed = (await app.inject({ method: 'GET', url: '/api/auth/google/accounts', headers })).json().accounts.find((entry: { id: string }) => entry.id === account.id);
    expect(listed).toMatchObject({ browserStatus: 'CONNECTED', browserStatusReason: 'VERIFIED', browserCheckedAt: at, browserConnectedAt: at });
    const pane = store.createPane({ roomId: room.id, title: 'Status pane', mode: 'BROWSER' });
    const choices = (await app.inject({ method: 'GET', url: `/api/panes/${pane.id}/browser/accounts`, headers })).json().profiles;
    expect(choices.find((entry: { profileId: string }) => entry.profileId === account.id)).toMatchObject({ browserStatus: 'CONNECTED' });
  });
  it('lists each Gemini account with its email and the sign-in state of its shared profile', async () => {
    if (!store.getCliAccountProfile('cli:gemini', 'ind')) store.createCliAccountProfile('cli:gemini', { runtimeId: 'cli:gemini', profileId: 'ind', displayName: 'ind' }, 'trace:gemini-status');
    // Its own room: the shared fixture room holds a 16-pane budget.
    const statusRoom = store.createRoom({ name: 'Gemini status fixture', initialPaneCount: 0 }, 'trace', user.id);
    const pane = store.createPane({ roomId: statusRoom.id, title: 'Gemini status', mode: 'BROWSER' });
    const geminiEntry = async () => (await app.inject({ method: 'GET', url: `/api/panes/${pane.id}/browser/accounts`, headers })).json().profiles
      .find((entry: { profileId: string }) => entry.profileId === 'ind');
    expect(await geminiEntry()).toEqual({ profileId: 'ind', displayName: 'Gemini account · ind', label: 'ind', email: 'ind@gemini.example.test', browserStatus: 'NOT_CONNECTED' });
    // Synthetic shared profile: cookie row names only.
    const profile = sharedCliProfilePathFor(root + '/profiles', youtubeAccountProfileKey(user.id, 'ind')!);
    await mkdir(join(profile, 'Default'), { recursive: true });
    const db = new DatabaseSync(join(profile, 'Default', 'Cookies'));
    db.exec('CREATE TABLE cookies (host_key TEXT, name TEXT, is_persistent INTEGER, expires_utc INTEGER)');
    expect((await geminiEntry()).browserStatus).toBe('NOT_CONNECTED');
    db.prepare('INSERT INTO cookies VALUES (?, ?, 1, ?)').run('.google.com', 'SID', (Date.now() + 11644473600000 + 86_400_000) * 1000);
    db.close();
    expect((await geminiEntry()).browserStatus).toBe('SIGNED_IN');
    expect((await app.inject({ method: 'GET', url: `/api/panes/${pane.id}/browser/accounts`, headers })).json().profiles
      .find((entry: { profileId: string }) => entry.profileId === account.id)).toMatchObject({ label: user.email, email: user.email });
  });
  it('checks only an owned account through the Browser Host and keeps host failures out of logout state', async () => {
    const url = `/api/auth/google/accounts/${encodeURIComponent(account.id)}/browser-check`;
    const checked = await app.inject({ method: 'POST', url, headers, payload: {} });
    expect(checked.statusCode, checked.body).toBe(200);
    expect(checked.json().check).toMatchObject({ status: 'CONNECTED', reason: 'VERIFIED' });
    expect(check).toHaveBeenLastCalledWith({ ownerUserId: user.id, accountId: account.id }, true, { holderType: 'OPERATOR', holderId: user.id });
    expect(checked.json().account.id).toBe(account.id);
    expect((await app.inject({ method: 'POST', url: `/api/auth/google/accounts/${encodeURIComponent(foreign.id)}/browser-check`, headers, payload: {} })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url, headers: { cookie: headers.cookie }, payload: {} })).statusCode).toBe(403);
    check.mockRejectedValueOnce(new Error('Unsupported Browser host IPC method checkGoogleAccount.'));
    expect((await app.inject({ method: 'POST', url, headers, payload: {} })).json().check).toMatchObject({ status: 'UNKNOWN', reason: 'BROWSER_UNAVAILABLE' });
    const saved = manager.checkGoogleAccount;
    delete manager.checkGoogleAccount;
    try {
      expect((await app.inject({ method: 'POST', url, headers, payload: {} })).json().check).toMatchObject({ status: 'UNKNOWN', reason: 'BROWSER_UNAVAILABLE' });
    } finally { manager.checkGoogleAccount = saved; }
  });
  it.each(['BROWSER','YOUTUBE'] as const)('opens Google sign-in with the verified account hint only when %s sign-in is requested', async mode => {
    const pane = store.createPane({ roomId: room.id, title: 'Sign-in pane', mode });
    const path = `/api/panes/${pane.id}/${mode.toLowerCase()}/accounts`;
    const normal = (await app.inject({ method: 'PUT', url: path, headers, payload: { profileId: account.id } })).json();
    expect(new URL(normal.targetUrl).hostname).not.toBe('accounts.google.com');
    const signIn = await app.inject({ method: 'PUT', url: path, headers, payload: { profileId: account.id, signIn: true } });
    expect(signIn.statusCode, signIn.body).toBe(200);
    const target = new URL(signIn.json().targetUrl);
    expect(target.origin + target.pathname).toBe('https://accounts.google.com/ServiceLogin');
    expect(target.searchParams.get('Email')).toBe(user.email);
    expect(target.searchParams.get('continue')).toBe(mode === 'YOUTUBE' ? 'https://www.youtube.com/' : 'https://www.google.com/');
    expect((await app.inject({ method: 'PUT', url: path, headers, payload: { profileId: null, signIn: true } })).json().targetUrl).not.toMatch(/accounts\.google\.com/);
  });
  describe('one Google sign-in for every pane', () => {
    const sharedKeys = new Set<string>();
    const openPane = async (mode: 'BROWSER' | 'YOUTUBE') => {
      const pane = store.createPane({ roomId: room.id, title: 'Shared sign-in', mode });
      const opened = await app.inject({ method: 'POST', url: `/api/panes/${pane.id}/browser/session`, headers, payload: { targetUrl: 'about:blank', includeInitialFrame: false } });
      expect(opened.statusCode, opened.body).toBeLessThan(300);
      return { pane, input: start.mock.lastCall![0] as Record<string, unknown> };
    };
    it.each(['BROWSER','YOUTUBE'] as const)('opens a %s pane without a choice on the primary account profile', async mode => {
      adopt.mockResolvedValueOnce({ result: 'NO_SIGN_IN', accountId: null });
      const { pane, input } = await openPane(mode);
      expect(input).toMatchObject({ googleAccount: { ownerUserId: user.id, accountId: account.id }, profileKey: null });
      expect(adopt).toHaveBeenLastCalledWith({ ownerUserId: user.id, roomId: room.id, paneId: pane.id, profileKey: null }, { holderType: 'OPERATOR', holderId: user.id });
      const listed = (await app.inject({ method: 'GET', url: `/api/panes/${pane.id}/${mode.toLowerCase()}/accounts`, headers })).json();
      expect(listed).toMatchObject({ selectedProfileId: null, effectiveProfileId: account.id });
    });
    it('moves a pane sign-in into the shared account it verifiably holds and remembers that account', async () => {
      const second = store.linkGoogleAccount(user.id, { sub: 'browser-owner-second', email: 'second@example.test' });
      adopt.mockResolvedValueOnce({ result: 'ADOPTED', accountId: second.id });
      const { pane, input } = await openPane('YOUTUBE');
      expect(input).toMatchObject({ googleAccount: { ownerUserId: user.id, accountId: second.id } });
      expect((await app.inject({ method: 'GET', url: `/api/panes/${pane.id}/youtube/accounts`, headers })).json()).toMatchObject({ selectedProfileId: second.id, effectiveProfileId: second.id });
      store.removeGoogleAccount(user.id, second.id, true);
    });
    it('keeps the pane on its own signed-in profile while the shared profile is busy', async () => {
      adopt.mockResolvedValueOnce({ result: 'TARGET_IN_USE', accountId: account.id });
      const { pane, input } = await openPane('BROWSER');
      expect(input).not.toHaveProperty('googleAccount');
      expect(input).toMatchObject({ profileKey: null });
      expect((await app.inject({ method: 'GET', url: `/api/panes/${pane.id}/browser/accounts`, headers })).json().selectedProfileId).toBeNull();
    });
    it('keeps a pane signed in to an unlinked Google account private', async () => {
      adopt.mockResolvedValueOnce({ result: 'OTHER_ACCOUNT', accountId: null });
      const { pane, input } = await openPane('BROWSER');
      expect(input).not.toHaveProperty('googleAccount');
      expect((await app.inject({ method: 'GET', url: `/api/panes/${pane.id}/browser/accounts`, headers })).json()).toMatchObject({ selectedProfileId: 'private:pane', effectiveProfileId: 'private:pane' });
      adopt.mockClear();
      await app.inject({ method: 'POST', url: `/api/panes/${pane.id}/browser/session`, headers, payload: { targetUrl: 'about:blank', includeInitialFrame: false } });
      expect(adopt).not.toHaveBeenCalled();
      expect(start.mock.lastCall![0]).not.toHaveProperty('googleAccount');
    });
    it('never swaps the profile of a running pane on reconnect', async () => {
      const pane = store.createPane({ roomId: room.id, title: 'Running', mode: 'YOUTUBE' });
      store.createPaneBrowserSession({ sessionId: 'browser_session:running', paneId: pane.id, roomId: room.id, ownerAgentId: null, agentNumber: 1,
        profileId: `profile:${room.id.replace(':', '_')}:${pane.id.replace(':', '_')}`, profilePath: '/profiles/pane', viewport: 'desktop', targetUrl: 'https://www.youtube.com/',
        streamMode: 'AUTO', resolvedStreamMode: 'INTERACTIVE', runtimeState: 'READY', capacityState: 'AVAILABLE', status: 'READY', statusReason: 'Ready.' } as never);
      adopt.mockClear();
      const opened = await app.inject({ method: 'POST', url: `/api/panes/${pane.id}/browser/session`, headers, payload: { includeInitialFrame: false } });
      expect(opened.statusCode, opened.body).toBeLessThan(300);
      expect(adopt).not.toHaveBeenCalled();
      expect(start.mock.lastCall![0]).not.toHaveProperty('googleAccount');
      expect(start.mock.lastCall![0]).toMatchObject({ profileKey: null });
    });
    it.each(['BROWSER','YOUTUBE'] as const)('opens a Gemini account selected in a %s pane on its one shared profile', async mode => {
      if (!store.getCliAccountProfile('cli:gemini', 'ind')) store.createCliAccountProfile('cli:gemini', { runtimeId: 'cli:gemini', profileId: 'ind', displayName: 'ind' }, 'trace:gemini-shared');
      const pane = store.createPane({ roomId: room.id, title: 'Gemini account', mode });
      const chosen = await app.inject({ method: 'PUT', url: `/api/panes/${pane.id}/${mode.toLowerCase()}/accounts`, headers, payload: { profileId: 'ind' } });
      expect(chosen.statusCode, chosen.body).toBe(200);
      const choices = (await app.inject({ method: 'GET', url: `/api/panes/${pane.id}/${mode.toLowerCase()}/accounts`, headers })).json();
      expect(choices.profiles).toEqual(expect.arrayContaining([expect.objectContaining({ profileId: 'ind', displayName: 'Gemini account · ind', label: 'ind' })]));
      adopt.mockClear();
      await app.inject({ method: 'POST', url: `/api/panes/${pane.id}/browser/session`, headers, payload: { targetUrl: 'about:blank', includeInitialFrame: false } });
      const input = start.mock.lastCall![0] as Record<string, unknown>;
      expect(input.sharedProfileKey).toMatch(/^[a-f0-9]{64}$/);
      // The same key lets an older Browser Host fall back to the pane's own legacy profile.
      expect(input.profileKey).toBe(input.sharedProfileKey);
      expect(input).not.toHaveProperty('googleAccount');
      expect(adopt).not.toHaveBeenCalled();
      sharedKeys.add(String(input.sharedProfileKey));
      expect(sharedKeys.size).toBe(1);
    });
    it('keeps a running default pane on its account when the primary changes and limits explicit choices to that account', async () => {
      const extra = store.createRoom({ name: 'Primary change fixture', initialPaneCount: 0 }, 'trace', user.id);
      const second = store.linkGoogleAccount(user.id, { sub: 'browser-owner-third', email: 'third@example.test' });
      const pane = store.createPane({ roomId: extra.id, title: 'Running default', mode: 'BROWSER' });
      store.createPaneBrowserSession({ sessionId: 'browser_session:default-running', paneId: pane.id, roomId: extra.id, ownerAgentId: null, agentNumber: 1,
        profileId: `google-account:${account.id}`, profilePath: '/profiles/primary', viewport: 'desktop', targetUrl: 'about:blank',
        streamMode: 'AUTO', resolvedStreamMode: 'INTERACTIVE', runtimeState: 'READY', capacityState: 'AVAILABLE', status: 'READY', statusReason: 'Ready.' } as never);
      store.setPrimaryGoogleAccount(user.id, second.id);
      try {
        await app.inject({ method: 'POST', url: `/api/panes/${pane.id}/browser/session`, headers, payload: { includeInitialFrame: false } });
        expect(start.mock.lastCall![0]).toMatchObject({ googleAccount: { accountId: account.id } });
        const explicit = store.createPane({ roomId: extra.id, title: 'Explicit', mode: 'BROWSER' });
        store.createPaneBrowserSession({ sessionId: 'browser_session:explicit-prior', paneId: explicit.id, roomId: extra.id, ownerAgentId: null, agentNumber: 1,
          profileId: `profile:${extra.id.replace(':', '_')}:${explicit.id.replace(':', '_')}`, profilePath: '/profiles/pane', viewport: 'desktop', targetUrl: 'about:blank',
          streamMode: 'AUTO', resolvedStreamMode: 'INTERACTIVE', runtimeState: 'STOPPED', capacityState: 'AVAILABLE', status: 'CLOSED', statusReason: 'Closed.', isActive: false } as never);
        await app.inject({ method: 'PUT', url: `/api/panes/${explicit.id}/browser/accounts`, headers, payload: { profileId: second.id } });
        adopt.mockResolvedValueOnce({ result: 'ADOPTED', accountId: account.id });
        await app.inject({ method: 'POST', url: `/api/panes/${explicit.id}/browser/session`, headers, payload: { targetUrl: 'about:blank', includeInitialFrame: false } });
        expect(adopt).toHaveBeenLastCalledWith(expect.objectContaining({ accountId: second.id, paneId: explicit.id }), expect.anything());
        // Even if a host reported another account, the explicit choice stands.
        expect(start.mock.lastCall![0]).toMatchObject({ googleAccount: { accountId: second.id } });
      } finally {
        store.setPrimaryGoogleAccount(user.id, account.id);
        store.removeGoogleAccount(user.id, second.id, true);
      }
    });
    it('opens the explicit private pane profile and survives a failing older host', async () => {
      // A second room: the first one already holds its 16-pane budget.
      const extra = store.createRoom({ name: 'Older host fixture', initialPaneCount: 0 }, 'trace', user.id);
      const pane = store.createPane({ roomId: extra.id, title: 'Private', mode: 'YOUTUBE' });
      const chosen = await app.inject({ method: 'PUT', url: `/api/panes/${pane.id}/youtube/accounts`, headers, payload: { profileId: 'private:pane' } });
      expect(chosen.statusCode, chosen.body).toBe(200);
      expect(chosen.json().targetUrl).toBe('https://www.youtube.com/');
      // An older host cannot move sign-ins: keep the pane's own profile unless the shared one is verified.
      const profile = googleBrowserProfilePathFor(root + '/profiles', user.id, account.id);
      await mkdir(profile, { recursive: true });
      await writeGoogleBrowserCheck(profile, classifyGoogleBrowserEvidence({ ok: true, httpStatus: 200, accounts: [] }, null, '2026-10-10T12:00:00.000Z'));
      const unverified = store.createPane({ roomId: extra.id, title: 'Older host', mode: 'BROWSER' });
      adopt.mockRejectedValueOnce(new Error('Unsupported Browser host IPC method adoptPaneGoogleProfile.'));
      expect((await app.inject({ method: 'POST', url: `/api/panes/${unverified.id}/browser/session`, headers, payload: { targetUrl: 'about:blank', includeInitialFrame: false } })).statusCode).toBeLessThan(300);
      expect(start.mock.lastCall![0]).not.toHaveProperty('googleAccount');
      await writeGoogleBrowserCheck(profile, classifyGoogleBrowserEvidence({ ok: true, httpStatus: 200, accounts: [{ subMatches: true, emailMatches: true, valid: true, signedOut: false }] }, null, '2026-10-10T12:00:00.000Z'));
      const verified = store.createPane({ roomId: extra.id, title: 'Older host verified', mode: 'BROWSER' });
      adopt.mockRejectedValueOnce(new Error('Unsupported Browser host IPC method adoptPaneGoogleProfile.'));
      expect((await app.inject({ method: 'POST', url: `/api/panes/${verified.id}/browser/session`, headers, payload: { targetUrl: 'about:blank', includeInitialFrame: false } })).statusCode).toBeLessThan(300);
      expect(start.mock.lastCall![0]).toMatchObject({ googleAccount: { accountId: account.id } });
    });
  });
});
