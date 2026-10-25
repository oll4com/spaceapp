import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { YouTubeAccountStore, selectYouTubeAccountSchema, youtubeAccountProfileKey, youtubeAccountSignInUrl } from '../src/youtube-accounts.js';
import { browserProfilePathFor } from '../src/browser-sessions.js';

describe('YouTube Google account isolation', () => {
  it('remembers selections after restart, isolates panes/users and serializes saves', async () => {
    const root = await mkdtemp(join(tmpdir(), 'youtube-accounts-'));
    try {
      const store = new YouTubeAccountStore(root);
      await Promise.all([store.save('user:one', 'pane:one', 'google-1'), store.save('user:one', 'pane:two', 'google-2'), store.save('user:one', 'pane:one', 'google-3')]);
      const restarted = new YouTubeAccountStore(root);
      expect(await restarted.get('user:one', 'pane:one')).toBe('google-3');
      expect(await restarted.get('user:one', 'pane:two')).toBe('google-2');
      expect(await restarted.get('user:one', 'pane:new')).toBeNull();
      expect(await restarted.get('user:two', 'pane:one')).toBeNull();
      const path = join(root, (await readdir(root))[0]!);
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      expect(await readFile(path, 'utf8')).not.toMatch(/email|token|cookie|password/);
      await restarted.save('user:one', 'pane:one', null);
      expect(await new YouTubeAccountStore(root).get('user:one', 'pane:one')).toBeNull();
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('uses stable private Chrome directories without changing the existing pane profile', () => {
    const a = youtubeAccountProfileKey('user:one', 'google-1')!;
    expect(a).toBe(youtubeAccountProfileKey('user:one', 'google-1'));
    expect(a).not.toBe(youtubeAccountProfileKey('user:one', 'google-2'));
    expect(a).not.toBe(youtubeAccountProfileKey('user:two', 'google-1'));
    expect(youtubeAccountProfileKey('user:one', null)).toBeUndefined();
    expect(browserProfilePathFor('/profiles', 'room:one', 'pane:one')).toBe('/profiles/room_one/pane_one');
    expect(browserProfilePathFor('/profiles', 'room:one', 'pane:one', a)).toBe(`/profiles/room_one/pane_one/accounts/${a}`);
    expect(() => browserProfilePathFor('/profiles', 'room:one', 'pane:one', '../../other')).toThrow();
    expect(selectYouTubeAccountSchema.safeParse({ profileId: 'google-1', profilePath: '/private' }).success).toBe(false);
  });
  it('opens the official Google sign-in with an email hint and a fixed YouTube return URL', () => {
    const url = new URL(youtubeAccountSignInUrl('test.user+youtube@example.com'));
    expect(url.origin).toBe('https://accounts.google.com');
    expect(url.searchParams.get('continue')).toBe('https://www.youtube.com/');
    expect(url.searchParams.get('Email')).toBe('test.user+youtube@example.com');
    expect(new URL(youtubeAccountSignInUrl(null)).searchParams.has('Email')).toBe(false);
  });
  it('keeps selections for all 96 panes and removes only disposable proof selections', async () => {
    const root = await mkdtemp(join(tmpdir(), 'youtube-accounts-'));
    try {
      const store = new YouTubeAccountStore(root);
      for (let i=0; i<300; i++) await store.save('user:one', `pane:${i}`, 'google-1');
      const value = JSON.parse(await readFile(join(root, (await readdir(root))[0]!), 'utf8'));
      expect(Object.keys(value.panes)).toHaveLength(300);
      expect(await new YouTubeAccountStore(root).get('user:one', 'pane:0')).toBe('google-1');
      expect(await new YouTubeAccountStore(root).get('user:one', 'pane:95')).toBe('google-1');
      await expect(store.removeProofState('user:one')).rejects.toThrow();
      await store.save('user:one:proof:room:test', 'pane:proof', 'google-1');
      await store.removeProofState('user:one:proof:room:test');
      expect(await store.get('user:one:proof:room:test', 'pane:proof')).toBeNull();
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
