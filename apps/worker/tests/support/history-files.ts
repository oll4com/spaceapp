import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { serializeHistory } from './history-json.js';

/** Read the explicit compatibility manifest; only the initial recorder may create it. */
async function readManifest(directory: string, allowMissing = false): Promise<string[]> {
  let text: string;
  try { text = await readFile(join(directory, 'manifest.txt'), 'utf8'); }
  catch (error) {
    if (allowMissing && (error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const names = text.trim().split('\n').filter(Boolean);
  if (!names.length || new Set(names).size !== names.length || names.some(name => !/^[A-Za-z0-9_-]+\.json$/.test(name))) {
    throw new Error('Invalid or empty workflow-history manifest');
  }
  return names.sort();
}

/** Fail on missing, renamed or unlisted JSON histories before attempting replay. */
export async function readHistoryFixtureNames(directory: string): Promise<string[]> {
  const expected = await readManifest(directory);
  const actual = (await readdir(directory)).filter(name => name.endsWith('.json')).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`Workflow-history manifest mismatch: missing=${expected.filter(n => !actual.includes(n)).join(',')}; unlisted=${actual.filter(n => !expected.includes(n)).join(',')}`);
  }
  return expected;
}

/** Write a fixture exclusively, accepting an existing file only when its bytes match. */
async function writeExclusive(path: string, content: string): Promise<boolean> {
  try { await writeFile(path, content, { flag: 'wx' }); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    return await readFile(path, 'utf8') === content;
  }
}

/** Preserve baseline and earlier revisions; append distinct recordings to the replay manifest. */
export async function recordHistoryFixture(directory: string, name: string, history: unknown): Promise<string> {
  if (!/^[A-Za-z0-9_-]+$/.test(name)) throw new Error('Invalid workflow-history name');
  await mkdir(directory, { recursive: true });
  const content = serializeHistory(history);
  let filename = `${name}.json`;
  if (!await writeExclusive(join(directory, filename), content)) {
    filename = `${name}--${createHash('sha256').update(content).digest('hex')}.json`;
    if (!await writeExclusive(join(directory, filename), content)) throw new Error('Workflow-history hash collision');
  }
  const names = await readManifest(directory, true);
  await writeFile(join(directory, 'manifest.txt'), [...new Set([...names, filename])].sort().join('\n') + '\n');
  return filename;
}
