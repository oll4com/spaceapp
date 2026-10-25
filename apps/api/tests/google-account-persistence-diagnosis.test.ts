import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { YouTubeAccountStore, youtubeAccountProfileKey } from '../src/youtube-accounts.js';
import { browserProfilePathFor, googleBrowserProfilePathFor } from '../src/browser-sessions.js';

describe('Google account selection persistence and browser profile identity', () => {
  // Stage 1 reproduced eviction at pane 65; Stage 4 removed it. Keep the same
  // boundaries as a regression gate for the protected 96-pane budget.
  it('keeps the selection of pane 0 past panes 65 and 96 without changing its profile key', async () => {
    const root = await mkdtemp(join(tmpdir(), 'google-selection-diagnosis-'));
    try {
      const store = new YouTubeAccountStore(root);
      await store.save('user:test', 'pane:0', 'google-a');
      const originalKey = youtubeAccountProfileKey('user:test', 'google-a');
      for (let i = 1; i < 65; i++) await store.save('user:test', `pane:${i}`, 'google-b');
      expect(await new YouTubeAccountStore(root).get('user:test', 'pane:0')).toBe('google-a');
      expect(youtubeAccountProfileKey('user:test', 'google-a')).toBe(originalKey);
      for (let i = 65; i < 96; i++) await store.save('user:test', `pane:${i}`, 'google-b');
      const restarted = new YouTubeAccountStore(root);
      const values = await Promise.all(Array.from({ length: 96 }, (_, i) => restarted.get('user:test', `pane:${i}`)));
      expect(values.filter(value => value === null)).toHaveLength(0);
      expect(values[0]).toBe('google-a');
      expect(values.slice(1)).toEqual(Array(95).fill('google-b'));
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('keeps A stable over ten A/B/A selections and store restarts in the same pane', async () => {
    const root = await mkdtemp(join(tmpdir(), 'google-selection-diagnosis-'));
    try {
      for (let i = 0; i < 10; i++) {
        for (const profileId of ['google-a', 'google-b', 'google-a']) {
          await new YouTubeAccountStore(root).save('user:test', 'pane:one', profileId);
          expect(await new YouTubeAccountStore(root).get('user:test', 'pane:one')).toBe(profileId);
        }
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('keeps legacy per-pane profiles separate while a verified account has one profile in every pane and room', () => {
    const key = youtubeAccountProfileKey('user:test', 'google-a')!;
    const original = browserProfilePathFor('/synthetic-profiles', 'room:one', 'pane:one', key);
    expect(browserProfilePathFor('/synthetic-profiles', 'room:one', 'pane:one', key)).toBe(original);
    expect(browserProfilePathFor('/synthetic-profiles', 'room:one', 'pane:two', key)).not.toBe(original);
    expect(browserProfilePathFor('/synthetic-profiles', 'room:two', 'pane:one', key)).not.toBe(original);
    expect(browserProfilePathFor('/synthetic-profiles', 'room:one', 'pane:one', undefined)).not.toBe(original);
    const verified = googleBrowserProfilePathFor('/synthetic-profiles', 'user:test', 'google_account:a');
    expect(verified).not.toContain('room');
    expect(googleBrowserProfilePathFor('/synthetic-profiles', 'user:test', 'google_account:a')).toBe(verified);
    expect(googleBrowserProfilePathFor('/synthetic-profiles', 'user:test', 'google_account:b')).not.toBe(verified);
    expect(googleBrowserProfilePathFor('/synthetic-profiles', 'user:other', 'google_account:a')).not.toBe(verified);
  });
});
