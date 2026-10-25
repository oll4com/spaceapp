import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import {
  canonicalGoogleEmail,
  classifyGoogleBrowserEvidence,
  googleBrowserCheckPathFor,
  googleListAccountsExpression,
  isGoogleAuthenticationUrl,
  normalizeGoogleBrowserCheckResult,
  parseGoogleBrowserEvidence,
  readGoogleBrowserCheck,
  summarizeGoogleBrowserStatus,
  writeGoogleBrowserCheck,
  type GoogleBrowserEvidence
} from '../src/google-browser-session-check.js';

const expected = { sub: '110000000000000000001', email: 'Test.User@gmail.com' };
// Shape returned by Google's ListAccounts: email [3], valid [9], gaia id [10], signed out [14].
const entry = (email: string, gaia: string, valid = 1, signedOut = 0) =>
  ['gaia.l.a', 1, 'Private Display Name', email, 'https://lh3.googleusercontent.com/private-photo', 1, 1, 0, null, valid, gaia, null, null, null, signedOut, 1];

async function evaluate(body: string | Error, status = 200, prefix = '') {
  const fetch = vi.fn(async () => {
    if (body instanceof Error) throw body;
    return { ok: status >= 200 && status < 300, status, text: async () => prefix + body };
  });
  const value = await vm.runInNewContext(googleListAccountsExpression(expected), { fetch });
  return { evidence: parseGoogleBrowserEvidence(JSON.parse(JSON.stringify(value))), fetch, raw: JSON.stringify(value) };
}

describe('Google ListAccounts evidence collected inside the profile page', () => {
  it('posts a same-origin credentialed request and returns only booleans', async () => {
    const { evidence, fetch, raw } = await evaluate(JSON.stringify(['gaia.l.a.r', [entry('test.user@gmail.com', expected.sub)]]));
    expect(fetch).toHaveBeenCalledWith('/ListAccounts?gpsia=1&source=ChromiumBrowser&json=standard', expect.objectContaining({ method: 'POST', credentials: 'include', redirect: 'error' }));
    expect(evidence).toEqual({ ok: true, httpStatus: 200, accounts: [{ subMatches: true, emailMatches: true, valid: true, signedOut: false }] });
    for (const secret of ['test.user', 'Private Display Name', 'private-photo', expected.sub]) expect(raw).not.toContain(secret);
  });

  it('matches a Gmail address by canonical email when Google reports another id', async () => {
    const { evidence } = await evaluate(JSON.stringify(['gaia.l.a.r', [entry('testuser@googlemail.com', '999')]]));
    expect(evidence.ok && evidence.accounts[0]).toEqual({ subMatches: false, emailMatches: true, valid: true, signedOut: false });
    expect(canonicalGoogleEmail(' Test.User@Gmail.com ')).toBe('testuser@gmail.com');
    expect(canonicalGoogleEmail('First.Last@example.com')).toBe('first.last@example.com');
  });

  it('strips an anti-XSSI prefix and fails closed on HTTP, network and malformed answers', async () => {
    expect((await evaluate(JSON.stringify(['gaia.l.a.r', []]), 200, ")]}'\n")).evidence).toEqual({ ok: true, httpStatus: 200, accounts: [] });
    expect((await evaluate('<html>Bad Request</html>', 400)).evidence).toEqual({ ok: false, httpStatus: 400, error: 'HTTP' });
    expect((await evaluate(new TypeError('Failed to fetch'))).evidence).toEqual({ ok: false, httpStatus: null, error: 'NETWORK' });
    expect((await evaluate('{"not":"a list"}')).evidence).toEqual({ ok: false, httpStatus: 200, error: 'MALFORMED' });
    expect((await evaluate('not json')).evidence).toEqual({ ok: false, httpStatus: 200, error: 'MALFORMED' });
    expect(parseGoogleBrowserEvidence({ ok: true, httpStatus: 200, accounts: [{ email: 'leak@example.com' }] })).toEqual({ ok: false, httpStatus: null, error: 'MALFORMED' });
  });

  it('embeds the expected identity as data, not code', () => {
    const expression = googleListAccountsExpression({ sub: '"); globalThis.pwned = 1; ("', email: 'a"b@example.com' });
    const context: Record<string, unknown> = { fetch: async () => { throw new Error('offline'); } };
    void vm.runInNewContext(expression, context);
    expect(context.pwned).toBeUndefined();
  });
});

describe('Google browser state classification', () => {
  const at = '2026-10-10T12:00:00.000Z';
  const ok = (accounts: Array<Partial<{ subMatches: boolean; emailMatches: boolean; valid: boolean; signedOut: boolean }>>): GoogleBrowserEvidence =>
    ({ ok: true, httpStatus: 200, accounts: accounts.map(account => ({ subMatches: false, emailMatches: false, valid: true, signedOut: false, ...account })) });

  it('reports Connected only for the verified account with a valid session', () => {
    expect(classifyGoogleBrowserEvidence(ok([{ subMatches: true }]), null, at)).toMatchObject({ status: 'CONNECTED', reason: 'VERIFIED', matchedBy: 'SUB', connectedAt: at });
    expect(classifyGoogleBrowserEvidence(ok([{ emailMatches: true }]), null, at)).toMatchObject({ status: 'CONNECTED', matchedBy: 'EMAIL' });
    expect(classifyGoogleBrowserEvidence(ok([{}]), null, at)).toMatchObject({ status: 'NOT_CONNECTED', reason: 'OTHER_ACCOUNT', matchedBy: null });
    expect(classifyGoogleBrowserEvidence(ok([]), null, at)).toMatchObject({ status: 'NOT_CONNECTED', reason: 'NO_GOOGLE_SESSION', connectedAt: null });
  });

  it('asks for reauthentication when Google expired, signed out or lost a previously verified session', () => {
    const previous = { connectedAt: '2026-10-09T08:00:00.000Z' };
    expect(classifyGoogleBrowserEvidence(ok([{ subMatches: true, valid: false }]), previous, at)).toMatchObject({ status: 'REAUTHENTICATION_REQUIRED', reason: 'SESSION_EXPIRED', connectedAt: previous.connectedAt });
    expect(classifyGoogleBrowserEvidence(ok([{ subMatches: true, signedOut: true }]), previous, at)).toMatchObject({ status: 'REAUTHENTICATION_REQUIRED', reason: 'SIGNED_OUT' });
    expect(classifyGoogleBrowserEvidence(ok([]), previous, at)).toMatchObject({ status: 'REAUTHENTICATION_REQUIRED', reason: 'SESSION_LOST' });
    expect(classifyGoogleBrowserEvidence(ok([{ valid: false }]), previous, at)).toMatchObject({ status: 'REAUTHENTICATION_REQUIRED', reason: 'SESSION_LOST' });
  });

  it('never turns a failed check into a logout', () => {
    const failed = classifyGoogleBrowserEvidence({ ok: false, httpStatus: 503, error: 'HTTP' }, { connectedAt: at }, at);
    expect(failed).toMatchObject({ status: 'UNKNOWN', reason: 'CHECK_FAILED', connectedAt: at });
    expect(normalizeGoogleBrowserCheckResult({ status: 'LOGGED_OUT', reason: 'X' })).toEqual({ status: 'UNKNOWN', reason: 'CHECK_FAILED', checkedAt: null, connectedAt: null });
    expect(normalizeGoogleBrowserCheckResult({ status: 'CONNECTED', reason: 'VERIFIED', checkedAt: at, connectedAt: at, email: 'leak@example.com' })).toEqual({ status: 'CONNECTED', reason: 'VERIFIED', checkedAt: at, connectedAt: at });
  });

  it('summarizes Settings state without trusting directories, cookies or open pages', () => {
    const check = classifyGoogleBrowserEvidence(ok([{ subMatches: true }]), null, at);
    expect(summarizeGoogleBrowserStatus({ profileExists: false, check, activeUrls: [] })).toMatchObject({ browserStatus: 'NOT_CONNECTED', browserStatusReason: 'PROFILE_MISSING' });
    expect(summarizeGoogleBrowserStatus({ profileExists: true, check, activeUrls: [] })).toEqual({ browserStatus: 'CONNECTED', browserStatusReason: 'VERIFIED', browserCheckedAt: at, browserConnectedAt: at });
    expect(summarizeGoogleBrowserStatus({ profileExists: true, check: null, activeUrls: ['https://accounts.google.com/v3/signin/identifier?flowName=x'] })).toMatchObject({ browserStatus: 'NOT_CONNECTED', browserStatusReason: 'SIGN_IN_PAGE' });
    expect(summarizeGoogleBrowserStatus({ profileExists: true, check: null, activeUrls: ['https://www.youtube.com/', null] })).toMatchObject({ browserStatus: 'UNKNOWN', browserStatusReason: 'NOT_CHECKED' });
  });

  it('recognizes Google sign-in, chooser, challenge and sign-out navigations only', () => {
    for (const url of ['https://accounts.google.com/ServiceLogin?continue=x', 'https://accounts.google.com/v3/signin/challenge/pwd', 'https://accounts.google.com/AccountChooser', 'https://www.youtube.com/logout', 'https://www.google.com/logout']) {
      expect(isGoogleAuthenticationUrl(url)).toBe(true);
    }
    for (const url of [null, '', 'about:blank', 'https://accounts.google.com/robots.txt', 'http://accounts.google.com/ServiceLogin', 'https://accounts.google.com.evil.test/ServiceLogin', 'https://www.youtube.com/watch?v=logout', 'https://myaccount.google.com/']) {
      expect(isGoogleAuthenticationUrl(url)).toBe(false);
    }
  });
});

describe('persisted browser check record', () => {
  it('stores only the classified state with private permissions and ignores corrupt files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'google-browser-check-'));
    try {
      const profile = join(root, 'profile');
      await mkdir(profile);
      expect(await readGoogleBrowserCheck(profile)).toBeNull();
      const check = classifyGoogleBrowserEvidence({ ok: true, httpStatus: 200, accounts: [{ subMatches: true, emailMatches: true, valid: true, signedOut: false }] }, null, '2026-10-10T12:00:00.000Z');
      await writeGoogleBrowserCheck(profile, check);
      expect(await readGoogleBrowserCheck(profile)).toEqual(check);
      const raw = await readFile(googleBrowserCheckPathFor(profile), 'utf8');
      expect(Object.keys(JSON.parse(raw)).sort()).toEqual(['checkedAt', 'connectedAt', 'matchedBy', 'reason', 'status', 'version']);
      const { stat } = await import('node:fs/promises');
      expect((await stat(googleBrowserCheckPathFor(profile))).mode & 0o777).toBe(0o600);
      await writeFile(googleBrowserCheckPathFor(profile), '{broken');
      expect(await readGoogleBrowserCheck(profile)).toBeNull();
      await writeFile(googleBrowserCheckPathFor(profile), JSON.stringify({ ...check, status: 'LOGGED_IN' }));
      expect(await readGoogleBrowserCheck(profile)).toBeNull();
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
