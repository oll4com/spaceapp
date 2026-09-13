import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { cliAccountProfileIdSchema } from '@space/contracts';
import { z } from 'zod';

const selectionSchema = z.object({ profileId: cliAccountProfileIdSchema.nullable(), updatedAt: z.number() }).strict();
const stateSchema = z.object({ panes: z.record(z.string(), selectionSchema) }).strict();
export const selectYouTubeAccountSchema = z.object({ profileId: cliAccountProfileIdSchema.nullable() }).strict();

export function youtubeAccountProfileKey(userId: string, profileId: string | null): string | undefined {
  return profileId === null ? undefined : createHash('sha256').update(JSON.stringify([userId, cliAccountProfileIdSchema.parse(profileId)])).digest('hex');
}

export function youtubeAccountSignInUrl(email: string | null): string {
  const url = new URL('https://accounts.google.com/ServiceLogin');
  url.searchParams.set('service', 'youtube');
  url.searchParams.set('continue', 'https://www.youtube.com/');
  if (email && z.string().email().safeParse(email).success) url.searchParams.set('Email', email);
  return url.href;
}

export function googleAccountSignInUrl(email: string | null): string {
  const url = new URL('https://accounts.google.com/ServiceLogin');
  url.searchParams.set('continue', 'https://www.google.com/');
  if (email && z.string().email().safeParse(email).success) url.searchParams.set('Email', email);
  return url.href;
}

// Selection metadata only. Google web authentication remains inside Chrome.
export class YouTubeAccountStore {
  private tails = new Map<string, Promise<unknown>>();
  constructor(private root: string) {}
  private path(userId: string) { return join(this.root, createHash('sha256').update(userId).digest('hex') + '.json'); }
  private async read(userId: string): Promise<z.infer<typeof stateSchema>> {
    try { return stateSchema.parse(JSON.parse(await readFile(this.path(userId), 'utf8'))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { panes: {} }; throw error; }
  }
  async get(userId: string, paneId: string): Promise<string | null> {
    await this.tails.get(userId)?.catch(() => undefined);
    return (await this.read(userId)).panes[paneId]?.profileId ?? null;
  }
  async knownPanes(userId: string): Promise<string[]> {
    await this.tails.get(userId)?.catch(() => undefined);
    return Object.keys((await this.read(userId)).panes);
  }
  async save(userId: string, paneId: string, profileId: string | null) {
    const selection = selectionSchema.parse({ profileId, updatedAt: Date.now() });
    const next = (this.tails.get(userId) ?? Promise.resolve()).catch(() => undefined).then(async () => {
      const state = await this.read(userId);
      selection.updatedAt = Math.max(selection.updatedAt, ...Object.values(state.panes).map(value => value.updatedAt + 1));
      state.panes[paneId] = selection;
      state.panes = Object.fromEntries(Object.entries(state.panes).sort((a, b) => b[1].updatedAt - a[1].updatedAt).slice(0, 64));
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
  async removeProofState(userId: string) {
    if (!userId.includes(':proof:room:')) throw new Error('Only disposable proof account selections can be removed here.');
    await this.tails.get(userId)?.catch(() => undefined);
    await unlink(this.path(userId)).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; });
  }
}
