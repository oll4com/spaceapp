import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';
import { browserProfilePathFor } from './browser-sessions.js';

const googleDomains = "(host_key IN ('google.com', '.google.com', 'youtube.com', '.youtube.com') OR host_key LIKE '%.google.com' OR host_key LIKE '%.youtube.com')";
const signedIn = `${googleDomains} AND name IN ('SID', '__Secure-1PSID', '__Secure-3PSID') AND (is_persistent = 0 OR expires_utc > ?)`;
const chromeNow = () => (Date.now() + 11644473600000) * 1000;

async function cookieFile(profile: string): Promise<string | null> {
  for (const relative of ['Default/Cookies', 'Default/Network/Cookies']) {
    const path = join(profile, relative);
    try { if ((await stat(path)).isFile()) return path; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  return null;
}

function hasSavedSignIn(path: string): boolean {
  const db = new DatabaseSync(path, { readOnly: true });
  try { return Boolean(db.prepare(`SELECT 1 FROM cookies WHERE ${signedIn} LIMIT 1`).get(chromeNow())); }
  finally { db.close(); }
}

/** Backend-only snapshot of saved Google sign-in. Never returns cookie values.
 * Call only while the destination pane has no active Chrome session. Each pane
 * keeps its own profile and process; an already signed-in destination is kept.
 * Peers MUST be derived from this user's selection metadata; profileKey scopes the selected account.
 */
export async function seedYouTubeSignIn(input: {
  profileRoot: string;
  profileKey: string;
  destination: { roomId: string; paneId: string };
  peers: Array<{ roomId: string; paneId: string }>;
}): Promise<boolean> {
  const target = browserProfilePathFor(input.profileRoot, input.destination.roomId, input.destination.paneId, input.profileKey);
  const existing = await cookieFile(target);
  if (existing && hasSavedSignIn(existing)) return false;
  const candidates: Array<{ profile: string; cookies: string; modified: number }> = [];
  for (const peer of input.peers) {
    if (peer.paneId === input.destination.paneId) continue;
    const profile = browserProfilePathFor(input.profileRoot, peer.roomId, peer.paneId, input.profileKey);
    const cookies = await cookieFile(profile);
    if (cookies && hasSavedSignIn(cookies)) candidates.push({ profile, cookies, modified: (await stat(cookies)).mtimeMs });
  }
  const source = candidates.sort((a, b) => b.modified - a.modified)[0];
  if (!source) return false;
  const destination = existing ?? join(target, source.cookies.slice(source.profile.length + 1));
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  const temporary = `${destination}.${randomUUID()}`;
  try {
    await writeFile(temporary, '', { mode: 0o600, flag: 'wx' });
    const db = new DatabaseSync(source.cookies, { readOnly: true });
    try { await backup(db, temporary); } finally { db.close(); }
    await chmod(temporary, 0o600);
    const snapshot = new DatabaseSync(temporary);
    try {
      snapshot.exec('PRAGMA journal_mode=DELETE');
      snapshot.exec(`DELETE FROM cookies WHERE NOT ${googleDomains}`);
      // Do not retain deleted third-party cookie records in free SQLite pages.
      snapshot.exec('VACUUM');
    } finally { snapshot.close(); }
    // Preserve Chrome's encryption metadata without copying browsing history,
    // passwords, other profile preferences or exposing credentials through API.
    let sourceState: Record<string, unknown> = {};
    try { sourceState = JSON.parse(await readFile(join(source.profile, 'Local State'), 'utf8')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (sourceState.os_crypt) {
      const statePath = join(target, 'Local State');
      let targetState: Record<string, unknown> = {};
      try { targetState = JSON.parse(await readFile(statePath, 'utf8')); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      const temporaryState = `${statePath}.${randomUUID()}`;
      try {
        await writeFile(temporaryState, JSON.stringify({ ...targetState, os_crypt: sourceState.os_crypt }), { mode: 0o600, flag: 'wx' });
        await rename(temporaryState, statePath);
      } finally { await unlink(temporaryState).catch(() => undefined); }
    }
    // Destination Chrome is stopped; stale journals must not replay old cookies.
    await unlink(`${destination}-wal`).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; });
    await unlink(`${destination}-shm`).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; });
    await rename(temporary, destination);
    return true;
  } finally { await unlink(temporary).catch(() => undefined); }
}
