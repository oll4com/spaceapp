import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { cliAccountProfileIdSchema } from '@space/contracts';
import { z } from 'zod';

/** Explicit per-pane profile that is not shared with other panes (a colon never occurs in CLI profile ids). */
export const privatePaneProfileId = 'private:pane';
const browserAccountIdSchema = z.union([cliAccountProfileIdSchema, z.string().regex(/^google_account:[A-Za-z0-9_-]{1,80}$/), z.literal(privatePaneProfileId)]);
const selectionSchema = z.object({ profileId: browserAccountIdSchema.nullable(), updatedAt: z.number() }).strict();
const stateSchema = z.object({ panes: z.record(z.string(), selectionSchema) }).strict();
// signIn opens Google's sign-in in the selected profile (with the account's email hint when known).
export const selectYouTubeAccountSchema = z.object({ profileId: browserAccountIdSchema.nullable(), signIn: z.boolean().optional() }).strict();

export function youtubeAccountProfileKey(userId: string, profileId: string | null): string | undefined {
  return profileId === null ? undefined : createHash('sha256').update(JSON.stringify([userId, cliAccountProfileIdSchema.parse(profileId)])).digest('hex');
}

/**
 * The Chrome profile Freelance Copilot panes opened for an account from 2026-10-17 until 2026-10-21, when they moved to the
 * account's one shared profile (operator request); kept so the browser census still names a browser that runs on one.
 */
export function freelanceProfileKey(userId: string, profileId: string): string {
  return createHash('sha256').update(JSON.stringify(['freelance', userId, profileId])).digest('hex');
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
  async initializeSelection(userId: string, paneId: string, profileId: string | null): Promise<string | null> {
    return this.save(userId, paneId, profileId, true);
  }
  async save(userId: string, paneId: string, profileId: string | null, onlyIfMissing = false): Promise<string | null> {
    const selection = selectionSchema.parse({ profileId, updatedAt: Date.now() });
    const next = (this.tails.get(userId) ?? Promise.resolve()).catch(() => undefined).then(async () => {
      const state = await this.read(userId);
      if (onlyIfMissing && Object.hasOwn(state.panes, paneId)) return state.panes[paneId]!.profileId;
      selection.updatedAt = Math.max(selection.updatedAt, ...Object.values(state.panes).map(value => value.updatedAt + 1));
      state.panes[paneId] = selection;
      // Pane selections must survive room churn and reopening. Evicting the oldest
      // entry silently changes a still-valid pane's browser identity.
      await mkdir(this.root, { recursive: true, mode: 0o700 });
      const temporary = this.path(userId) + '.' + randomUUID();
      try {
        await writeFile(temporary, JSON.stringify(state), { mode: 0o600, flag: 'wx' });
        await rename(temporary, this.path(userId));
      } finally { await unlink(temporary).catch(() => undefined); }
      return selection.profileId;
    });
    this.tails.set(userId, next);
    try { return await next; } finally { if (this.tails.get(userId) === next) this.tails.delete(userId); }
  }
  async removeProofState(userId: string) {
    if (!userId.includes(':proof:room:')) throw new Error('Only disposable proof account selections can be removed here.');
    await this.tails.get(userId)?.catch(() => undefined);
    await unlink(this.path(userId)).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; });
  }
}
