import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';

export const youtubePlaybackSchema = z.object({
  videoId: z.string().regex(/^(?:[\w-]{11})?$/),
  playlistId: z.string().regex(/^[\w-]{8,150}$/).nullable(),
  index: z.number().int().min(0).max(10000),
  seconds: z.number().finite().min(0).max(604800),
  title: z.string().max(500),
  updatedAt: z.number().finite().positive()
}).strict().refine((value) => Boolean(value.videoId || value.playlistId), 'A video or playlist is required.');
type Playback = z.infer<typeof youtubePlaybackSchema>;
const stateSchema = z.object({ panes: z.record(z.string(), youtubePlaybackSchema) });

// Playback metadata only. Chrome credentials stay in the existing private profile.
export class YouTubePlaybackStore {
  private tails = new Map<string, Promise<unknown>>();
  constructor(private root: string) {}
  private path(userId: string) { return join(this.root, createHash('sha256').update(userId).digest('hex') + '.json'); }
  private async read(userId: string): Promise<{ panes: Record<string, Playback> }> {
    try { return stateSchema.parse(JSON.parse(await readFile(this.path(userId), 'utf8'))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { panes: {} }; throw error; }
  }
  async removeProofState(userId: string) {
    if (!userId.includes(':proof:room:')) throw new Error('Only disposable proof playback can be removed here.');
    await this.tails.get(userId)?.catch(() => undefined);
    await unlink(this.path(userId)).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; });
  }
  async get(userId: string, paneId: string) {
    await this.tails.get(userId)?.catch(() => undefined);
    const state = await this.read(userId);
    return state.panes[paneId] ?? Object.values(state.panes).sort((a, b) => b.updatedAt - a.updatedAt)[0] ?? null;
  }
  async save(userId: string, paneId: string, input: Playback) {
    const playback = youtubePlaybackSchema.parse(input);
    // A bad client clock must not make later real progress impossible to save.
    playback.updatedAt = Math.min(playback.updatedAt, Date.now() + 60000);
    const next = (this.tails.get(userId) ?? Promise.resolve()).catch(() => undefined).then(async () => {
      const state = await this.read(userId);
      if ((state.panes[paneId]?.updatedAt ?? 0) > playback.updatedAt) return;
      state.panes[paneId] = playback;
      state.panes = Object.fromEntries(Object.entries(state.panes).sort((a, b) => b[1].updatedAt - a[1].updatedAt).slice(0, 32));
      await mkdir(this.root, { recursive: true, mode: 0o700 });
      const temporary = this.path(userId) + '.' + randomUUID();
      try {
        await writeFile(temporary, JSON.stringify(state), { mode: 0o600, flag: 'wx' });
        await rename(temporary, this.path(userId));
      } finally { await unlink(temporary).catch(() => undefined); }
    });
    this.tails.set(userId, next);
    try { await next; } finally { if (this.tails.get(userId) === next) this.tails.delete(userId); }
  }
}

export function youtubeBrowserPlayback(raw: string | null, title: string | null): Playback | null {
  try {
    const url = new URL(raw ?? '');
    if (!['https:', 'http:'].includes(url.protocol) || !/^(www\.|m\.)?youtube\.com$/.test(url.hostname)) return null;
    const videoId = url.pathname.startsWith('/shorts/') ? url.pathname.split('/')[2] : url.searchParams.get('v');
    if (!videoId) return null;
    const t = url.searchParams.get('t') ?? '0';
    const playback = youtubePlaybackSchema.safeParse({ videoId, playlistId: url.searchParams.get('list'),
      index: Math.max(0, Number(url.searchParams.get('index') ?? 1) - 1),
      seconds: /^\d+(?:\.\d+)?s?$/.test(t) ? Number(t.replace(/s$/, '')) : 0,
      title: (title ?? '').slice(0, 500), updatedAt: Date.now() });
    return playback.success ? playback.data : null;
  } catch { return null; }
}
