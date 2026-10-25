import { mkdtemp, rm, stat, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { YouTubePlaybackStore, youtubePlaybackSchema } from '../src/youtube-playback-state.js';
const initial = { videoId: 'abcdefghijk', playlistId: null, index: 0, seconds: 42, title: 'Video', updatedAt: 100 };
describe('YouTube playback persistence', () => {
  it('survives process replacement, isolates users and serializes concurrent/out-of-order saves', async () => {
    const root = await mkdtemp(join(tmpdir(), 'youtube-playback-'));
    try {
      const store = new YouTubePlaybackStore(root);
      await Promise.all([
        store.save('user:one', 'pane:one', { ...initial, updatedAt: 300, seconds: 82 }),
        store.save('user:one', 'pane:one', { ...initial, updatedAt: 200, seconds: 12 }),
        store.save('user:one', 'pane:two', { ...initial, updatedAt: 400, seconds: 99 })
      ]);
      const restarted = new YouTubePlaybackStore(root);
      expect(await restarted.get('user:one', 'pane:one')).toMatchObject({ seconds: 82 });
      expect(await restarted.get('user:one', 'pane:new')).toMatchObject({ seconds: 99 });
      expect(await restarted.get('user:two', 'pane:one')).toBeNull();
      expect((await stat(join(root, (await readdir(root))[0]!))).mode & 0o777).toBe(0o600);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('rejects unbounded progress and secret-shaped extra fields', () => {
    expect(youtubePlaybackSchema.safeParse({ ...initial, seconds: Infinity }).success).toBe(false);
    expect(youtubePlaybackSchema.safeParse({ ...initial, cookies: 'not-accepted' }).success).toBe(false);
    expect(youtubePlaybackSchema.safeParse({ ...initial, videoId: '' }).success).toBe(false);
  });
});
