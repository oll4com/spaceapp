import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { InMemorySpaceStore } from '@space/runtime';
import { createApp } from '../src/app.js';
import { getApiConfig } from '../src/config.js';
import { sharedCliProfilePathFor, type BrowserSessionManager } from '../src/browser-sessions.js';
import { cliBrowserBridgeTokenHeader, issueCliBrowserBridgeToken } from '../src/cli-browser-bridge.js';
import { signinCardRefusal, signinTarget, siteAccountLine, tabGoogleAccounts, wantedAccount } from '../src/site-signin-account.js';
import type { Pane } from '@space/contracts';
import { youtubeAccountProfileKey } from '../src/youtube-accounts.js';

// Operator nous_msg:05e5af9f81ec45caa1f50f1b (6/11): the Job Copilot's Gmail tab opened in the primary Google account (operator7)
// and the card asked him to sign in to ntheogr inside it. The site's sign-in recipe names the account the tab must use.
describe('site sign-in account: which Google account a tab uses', () => {
  it('reads the site and the named account through Google sign-in and OAuth addresses', () => {
    const oauth = 'https://accounts.google.com/o/oauth2/v2/auth?client_id=x&redirect_uri=https%3A%2F%2Fhimalayas.app%2Fauth%2Fgoogle';
    const signIn = `https://accounts.google.com/v3/signin/identifier?continue=${encodeURIComponent(oauth)}&flowName=GlifWebSignIn`;
    expect(signinTarget(signIn)).toEqual({ site: 'himalayas.app', hintEmail: null, destination: oauth });
    expect(signinTarget('https://accounts.google.com/ServiceLogin?continue=https%3A%2F%2Fmail.google.com%2Fmail%2F&Email=NtheoGR%40gmail.com'))
      .toEqual({ site: 'google.com', hintEmail: 'ntheogr@gmail.com', destination: 'https://mail.google.com/mail/' });
    expect(signinTarget('https://mail.google.com/mail/u/?authuser=ntheogr@gmail.com')).toMatchObject({ site: 'google.com', hintEmail: 'ntheogr@gmail.com' });
    expect(signinTarget('https://himalayas.app/jobs')).toEqual({ site: 'himalayas.app', hintEmail: null, destination: null });
    expect(signinTarget('about:blank')).toEqual({ site: null, hintEmail: null, destination: null });
    expect(signinTarget(null)).toEqual({ site: null, hintEmail: null, destination: null });
  });

  it('picks the recipe account, the signed-in profile first, and never the primary account by default', () => {
    const choices = [
      { profileId: 'google_account:primary', email: 'operator@example.invalid', browserStatus: 'CONNECTED' },
      { profileId: 'google_account:ntheo', email: 'ntheogr@gmail.com', browserStatus: 'NOT_CONNECTED' },
      { profileId: 'nth', email: 'NtheoGR@gmail.com', browserStatus: 'SIGNED_IN' }
    ];
    expect(wantedAccount({ googleAccountEmail: 'ntheogr@gmail.com', browserProfileId: null }, null, choices))
      .toEqual({ email: 'ntheogr@gmail.com', profileId: 'nth', signedIn: true, source: 'recipe' });
    // The address's own account wins over the recipe.
    expect(wantedAccount({ googleAccountEmail: 'ntheogr@gmail.com', browserProfileId: null }, 'operator@example.invalid', choices))
      .toMatchObject({ email: 'operator@example.invalid', profileId: 'google_account:primary', source: 'address' });
    // A stored session profile id maps back to its account; an account Space has no profile for says so.
    expect(wantedAccount({ googleAccountEmail: null, browserProfileId: 'google-account:google_account:ntheo' }, null, choices))
      .toEqual({ email: 'ntheogr@gmail.com', profileId: 'google_account:ntheo', signedIn: false, source: 'recipe' });
    expect(wantedAccount({ googleAccountEmail: 'other@example.com', browserProfileId: null }, null, choices))
      .toEqual({ email: 'other@example.com', profileId: null, signedIn: false, source: 'recipe' });
    // The recipe's pinned profile wins among the email's profiles; an address hint still ranks by sign-in.
    expect(wantedAccount({ googleAccountEmail: 'ntheogr@gmail.com', browserProfileId: 'google-account:google_account:ntheo' }, null, choices))
      .toMatchObject({ profileId: 'google_account:ntheo', signedIn: false, source: 'recipe' });
    expect(wantedAccount({ googleAccountEmail: null, browserProfileId: 'google_account:ntheo' }, 'ntheogr@gmail.com', choices))
      .toMatchObject({ profileId: 'nth', source: 'address' });
    expect(wantedAccount(null, null, choices)).toBeNull();
    expect(wantedAccount({ googleAccountEmail: null, browserProfileId: null }, null, choices)).toBeNull();
  });

  it('names the wanted account and the tab\'s account in one line', () => {
    const base = { site: 'himalayas.app', activePageId: 'page:one', paneProfileId: 'google_account:primary',
      pane: { profileId: 'google_account:primary', email: 'operator@example.invalid', byDefault: true },
      tab: { profileId: 'google_account:primary', email: 'operator@example.invalid', byDefault: true } };
    const wanted = { email: 'ntheogr@gmail.com', profileId: 'nth', signedIn: false, source: 'recipe' as const };
    expect(siteAccountLine({ ...base, wanted, matches: false }, false)).toBe(
      "Google account ntheogr@gmail.com (site sign-in recipe for himalayas.app), NOT signed in; this tab is in operator@example.invalid (the pane's default account), not ntheogr@gmail.com.");
    expect(siteAccountLine({ ...base, wanted: { ...wanted, signedIn: true }, matches: false }, true)).toBe(
      "Google account ntheogr@gmail.com (site sign-in recipe for himalayas.app), signed in; this tab moved into its browser from operator@example.invalid (the pane's default account).");
    expect(siteAccountLine({ ...base, wanted: { ...wanted, profileId: null }, matches: false }, false)).toContain('has no browser profile in Space');
  });
});

describe('sign-in cards against the tab\'s Google account', () => {
  const pane = { id: 'pane:finn', mode: 'JOB_APPLY' } as Pane;
  const actor = { holderType: 'AGENT' as const, holderId: 'pane:cli' };
  const listing = { selectedProfileId: null, effectiveProfileId: 'primary', profiles: [
    { profileId: 'primary', displayName: 'p', email: 'operator@example.invalid', browserStatus: 'SIGNED_IN' },
    { profileId: 'nth', displayName: 'n', email: 'ntheogr@gmail.com', browserStatus: 'SIGNED_IN' }] };
  const setup = (tabProfile: string | null, ntheo = 'SIGNED_IN') => {
    const switchTab = vi.fn(async () => ({}));
    const accounts = { list: vi.fn(async () => ({ ...listing, profiles: listing.profiles.map((p) => p.profileId === 'nth' ? { ...p, browserStatus: ntheo } : p) })), switchTab };
    const listPages = vi.fn(async () => ({ activePageId: 'page:1', pages: [{ pageId: 'page:1', isActive: true, account: tabProfile ? { profileId: tabProfile, label: 'ntheogr@gmail.com' } : null }] }));
    return { deps: { accounts: accounts as never, listPages }, switchTab };
  };
  const ask = (deps: ReturnType<typeof setup>['deps'], text: string, mayMove = true) => signinCardRefusal(deps, 'user:op', pane, null, text, mayMove, 'trace:t', actor);

  it('names every tab\'s account and marks the primary one nobody chose', async () => {
    const { deps } = setup('nth');
    const listed = await tabGoogleAccounts(deps.accounts, async () => ({ activePageId: 'page:1', pages: [
      { pageId: 'page:1', isActive: true, account: { profileId: 'nth', label: 'ntheogr@gmail.com' } }, { pageId: 'page:2', isActive: false, account: null }] }), 'user:op', pane);
    expect(listed.pages.map((page) => page.google)).toEqual(['ntheogr@gmail.com', "operator@example.invalid (the pane's default: no account was chosen)"]);
  });

  it('raises no card for an account the tab already runs in and is signed in to', async () => {
    const { deps, switchTab } = setup('nth');
    expect(await ask(deps, 'Sign in to Himalayas with ntheogr@gmail.com')).toContain('already signed in');
    expect(switchTab).not.toHaveBeenCalled();
  });

  it('moves another account\'s tab instead of carding, and refuses when it cannot move', async () => {
    const signedIn = setup(null);
    // The account after the sign-in words is the one asked for, not the tab's account the card mentions first.
    expect(await ask(signedIn.deps, 'Finn\'s tab is in operator@example.invalid; please sign in to ntheogr@gmail.com')).toContain('this tab moved into its browser');
    expect(signedIn.switchTab).toHaveBeenCalledWith('user:op', pane, 'page:1', 'nth', false, 'trace:t', actor, undefined);
    expect(await ask(setup(null).deps, 'Sign in to ntheogr@gmail.com', false)).toMatch(/^This tab runs in google: operator@example.invalid .*switch the tab to ntheogr@gmail\.com first/);
    // Not signed in yet: the tab goes to Google's sign-in for that account in its browser, and the card forms.
    const signedOut = setup(null, 'NOT_CONNECTED');
    expect(await ask(signedOut.deps, 'Log in to ntheogr@gmail.com')).toBeNull();
    expect(signedOut.switchTab).toHaveBeenCalledWith('user:op', pane, 'page:1', 'nth', false, 'trace:t', actor, expect.stringContaining('Email=ntheogr%40gmail.com'));
  });

  it('lets password, code and unrelated cards through', async () => {
    const { deps, switchTab } = setup(null);
    expect(await ask(deps, 'Sign in to ntheogr@gmail.com: Google asks for the password')).toBeNull();
    expect(await ask(deps, 'Approve the post for ntheogr@gmail.com')).toBeNull();
    expect(await ask(deps, 'Sign in to other@example.com')).toBeNull();
    expect(switchTab).not.toHaveBeenCalled();
  });
});

describe('site sign-in account through the CLI bridge', () => {
  const store = new InMemorySpaceStore();
  const user = store.upsertUser({ id: 'user:signin-account-owner', email: 'operator7@example.test', role: 'ADMIN' });
  const primary = store.linkGoogleAccount(user.id, { sub: 'primary-sub', email: 'operator7@example.test' });
  store.createCliAccountProfile('cli:gemini', { runtimeId: 'cli:gemini', profileId: 'nth', displayName: 'nth' }, 'trace:gemini-nth');
  const room = store.createRoom({ name: 'Site account fixture', initialPaneCount: 0 }, 'trace', user.id);
  const cli = store.createPane({ roomId: room.id, title: 'T3 Code', mode: 'T3CODE' });
  const job = store.createPane({ roomId: room.id, title: 'Finn', mode: 'JOB_APPLY' });
  const session = store.createPaneBrowserSession({ sessionId: 'browser_session:site-account', paneId: job.id, roomId: room.id, ownerAgentId: 'agent:1', agentNumber: 1,
    profileId: `google-account:${primary.id}`, profilePath: '/tmp/site-account-synthetic', viewport: 'desktop', targetUrl: 'https://example.org/',
    currentUrl: 'https://example.org/', title: 'Example', status: 'READY', isActive: true });
  const start = vi.fn(async () => ({ session, frame: null, websocket: null }));
  const action = vi.fn(async () => ({ session: store.getActivePaneBrowserSession(job.id)!, frame: null, text: null }));
  const page = { pageId: 'page:one', kind: 'PAGE', url: 'https://example.org/', title: null, isActive: true, openerPageId: null, canGoBack: false, canGoForward: false, account: null };
  const manager: Record<string, unknown> = {
    startOrRestore: start, action, stopPane: vi.fn(async () => undefined), closeAll: async () => {},
    checkGoogleAccount: vi.fn(async () => ({ status: 'CONNECTED', reason: 'VERIFIED', checkedAt: '2026-11-06T00:00:00.000Z', connectedAt: '2026-11-06T00:00:00.000Z' })),
    adoptPaneGoogleProfile: vi.fn(async () => ({ result: 'NO_SIGN_IN', accountId: null })),
    listPages: vi.fn(async () => ({ sessionId: session.sessionId, activePageId: 'page:one', pages: [page] })),
    createPage: vi.fn(async () => ({ sessionId: session.sessionId, activePageId: 'page:new', pages: [page, { ...page, pageId: 'page:new' }] })),
    status: () => ({ enabled: true, statusReason: 'Test', defaultUrl: 'about:blank', checkedAt: new Date().toISOString() })
  };
  let app: Awaited<ReturnType<typeof createApp>>;
  let root: string;
  let token: string;
  const headers = () => ({ [cliBrowserBridgeTokenHeader]: token });
  const command = (body: Record<string, unknown>) => app.inject({ method: 'POST', url: '/api/cli/browser/commands', headers: headers(), payload: { targetPaneId: job.id, command: body } });
  const navigate = (url: string) => app.inject({ method: 'POST', url: '/api/cli/browser/actions', headers: headers(),
    payload: { actions: [{ toolId: 'browser:navigate', targetPaneId: job.id, action: { type: 'navigate', url } }] } });
  const nthKey = youtubeAccountProfileKey(user.id, 'nth')!;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'site-account-'));
    const config = getApiConfig({ SPACE_BROWSER_SESSIONS_ENABLED: 'true', SPACE_BROWSER_TOOL_BRIDGE_ENABLED: 'true', SPACE_INTERNAL_API_TOKEN: 'test-internal-token',
      SPACE_ARTIFACT_ROOT: root + '/browser-evidence', SPACE_BROWSER_SESSIONS_PROFILE_ROOT: root + '/profiles' });
    token = issueCliBrowserBridgeToken(config, { roomId: room.id, paneId: cli.id, cliSessionId: `t3code:${cli.id}` })!;
    app = await createApp({ store, config, browserSessionManager: manager as unknown as BrowserSessionManager,
      readGeminiAccountProfileDetails: async (profileId) => ({ authStatus: 'CONNECTED', email: `${profileId}@gemini.example.test` }),
      auth: { sessionSecret: 'test-site-account-secret', devLogin: false, secureCookies: false } });
    const recorded = await app.inject({ method: 'POST', url: '/api/cli/site-signins', headers: headers(),
      payload: { site: 'himalayas.app', method: 'GOOGLE', googleAccountEmail: 'nth@gemini.example.test', outcome: 'SUCCESS' } });
    expect(recorded.statusCode, recorded.body).toBe(200);
  }, 30000);
  afterAll(async () => { await app?.close(); if (root) await rm(root, { recursive: true, force: true }); }, 30000);

  it('says which account a copilot pane uses by default and each tab\'s account', async () => {
    const listed = await command({ type: 'LIST_ACCOUNTS' });
    expect(listed.statusCode, listed.body).toBe(200);
    expect(listed.json()).toMatchObject({ selectedProfileId: null, effectiveProfileId: primary.id, effectiveEmail: 'operator7@example.test', byDefault: true,
      tabs: [{ pageId: 'page:one', profileId: primary.id, email: 'operator7@example.test' }] });
    expect(listed.json().note).toContain('operator7@example.test (the primary Google account) by default');
    // Choosing stays the Browser, Freelance and Marketing panes' (a Job Copilot's account is the operator's choice).
    expect((await command({ type: 'SELECT_ACCOUNT', profileId: 'nth' })).statusCode).toBe(409);
  });

  it('opens a site in its recipe\'s Google account instead of the pane\'s default one', async () => {
    start.mockClear(); action.mockClear();
    const moved = await navigate('https://himalayas.app/login');
    expect(moved.statusCode, moved.body).toBe(200);
    expect(action).not.toHaveBeenCalled();
    expect(start).toHaveBeenLastCalledWith(expect.objectContaining({ sharedProfileKey: nthKey,
      accountTab: { pageId: 'page:one', profileId: 'nth', label: 'nth@gemini.example.test', url: 'https://himalayas.app/login' } }), expect.anything());
    const result = moved.json().results[0];
    expect(result.status).toBe('EXECUTED');
    expect(result.statusReason).toContain('Google account nth@gemini.example.test (site sign-in recipe for himalayas.app), NOT signed in');
    expect(result.statusReason).toContain("from operator7@example.test (the pane's default account)");

    // A site without a recipe navigates in place.
    start.mockClear();
    const plain = await navigate('https://example.org/about');
    expect(plain.json().results[0]).toMatchObject({ status: 'EXECUTED',
      statusReason: "Browser action executed through Space CLI mediation. Tab's Google account: google: operator7@example.test (the pane's default: no account was chosen)." });
    expect(action).toHaveBeenCalledTimes(1);
    expect(start).not.toHaveBeenCalled();
  });

  it('opens a new tab for the site straight in that account', async () => {
    start.mockClear();
    const created = await command({ type: 'CREATE_PAGE', url: 'https://himalayas.app/jobs' });
    expect(created.statusCode, created.body).toBe(200);
    expect(start).toHaveBeenLastCalledWith(expect.objectContaining({ sharedProfileKey: nthKey,
      accountTab: { pageId: 'page:new', profileId: 'nth', label: 'nth@gemini.example.test', url: 'https://himalayas.app/jobs' } }), expect.anything());
    expect(created.json().siteAccount).toContain("New tab opened in nth@gemini.example.test's browser");
  });

  it('puts a Google sign-in in the wanted account: the card names it, and a signed-in account needs no operator', async () => {
    const oauth = 'https://accounts.google.com/o/oauth2/v2/auth?client_id=x&redirect_uri=https%3A%2F%2Fhimalayas.app%2Fauth%2Fgoogle';
    store.updatePaneBrowserSession(session.sessionId, { currentUrl: `https://accounts.google.com/v3/signin/identifier?continue=${encodeURIComponent(oauth)}` });
    start.mockClear();
    const asked = await command({ type: 'REQUEST_HANDOFF', kind: 'LOGIN', reason: 'Google password needed', triedStored: true });
    expect(asked.statusCode, asked.body).toBe(200);
    const reason: string = asked.json().handoff.reason;
    expect(reason).toMatch(/^LOGIN: \[site:himalayas\.app\] Google account nth@gemini\.example\.test \(site sign-in recipe for himalayas\.app\), NOT signed in; this tab moved into its browser/);
    expect(reason).toContain('Stored method GOOGLE');
    // The operator signs in to exactly that account, in that account's browser.
    expect(start).toHaveBeenLastCalledWith(expect.objectContaining({ sharedProfileKey: nthKey,
      accountTab: expect.objectContaining({ pageId: 'page:one', profileId: 'nth', url: expect.stringMatching(/^https:\/\/accounts\.google\.com\/ServiceLogin\?.*Email=nth%40gemini/) }) }), expect.anything());
    expect(store.listBrowserHandoffRequests(room.id)).toHaveLength(1);
    await app.inject({ method: 'POST', url: '/api/cli/browser/commands', headers: headers(), payload: { targetPaneId: job.id, command: { type: 'CANCEL_HANDOFF' } } });

    // Signed in there (synthetic shared profile cookie): the tab moves to the consent page and the agent goes on alone.
    const profile = sharedCliProfilePathFor(root + '/profiles', nthKey);
    await mkdir(join(profile, 'Default'), { recursive: true });
    const db = new DatabaseSync(join(profile, 'Default', 'Cookies'));
    db.exec('CREATE TABLE cookies (host_key TEXT, name TEXT, is_persistent INTEGER, expires_utc INTEGER)');
    db.prepare('INSERT INTO cookies VALUES (?, ?, 1, ?)').run('.google.com', 'SID', (Date.now() + 11644473600000 + 86_400_000) * 1000);
    db.close();
    start.mockClear();
    const switched = await command({ type: 'REQUEST_HANDOFF', kind: 'LOGIN', reason: 'Google password needed', triedStored: true });
    expect(switched.statusCode, switched.body).toBe(200);
    expect(switched.json()).toMatchObject({ status: 'SWITCHED_ACCOUNT', account: 'nth@gemini.example.test' });
    expect(start).toHaveBeenLastCalledWith(expect.objectContaining({ accountTab: { pageId: 'page:one', profileId: 'nth', label: 'nth@gemini.example.test', url: oauth } }), expect.anything());
    expect(store.listBrowserHandoffRequests(room.id)).toHaveLength(1);
  });

  it('reports the account per browser session in the bridge context', async () => {
    const context = await app.inject({ url: '/api/cli/browser/context', headers: headers() });
    expect(context.statusCode).toBe(200);
    expect(context.json().browserSessions[0]).toMatchObject({ signin: { site: 'himalayas.app', googleAccountEmail: 'nth@gemini.example.test' },
      signinAccount: expect.stringContaining('Google account nth@gemini.example.test'),
      tabAccounts: [{ pageId: 'page:one', isActive: true, google: "operator7@example.test (the pane's default: no account was chosen)" }] });
  });
});
