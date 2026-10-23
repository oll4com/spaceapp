import { afterEach, expect, it } from 'vitest';
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readHistoryFixtureNames, recordHistoryFixture } from './support/history-files.js';

const directories: string[] = [];
/** Isolate recorder tests from checked-in histories and clean up after each scenario. */
async function directory() {
  const path = await mkdtemp(join(tmpdir(), 'space-history-'));
  directories.push(path);
  return path;
}
afterEach(async () => { for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true }); });

it('retains original and intermediate histories across recordings and deduplicates identical bytes', async () => {
  const path = await directory();
  const original = await recordHistoryFixture(path, 'workflow', { events: [{ eventId: '1' }] });
  const originalBytes = await readFile(join(path, original), 'utf8');
  const second = await recordHistoryFixture(path, 'workflow', { events: [{ eventId: '2' }] });
  const third = await recordHistoryFixture(path, 'workflow', { events: [{ eventId: '3' }] });
  expect(await recordHistoryFixture(path, 'workflow', { events: [{ eventId: '2' }] })).toBe(second);
  expect(await readFile(join(path, original), 'utf8')).toBe(originalBytes);
  expect(JSON.parse(await readFile(join(path, second), 'utf8')).events[0].eventId).toBe('2');
  expect(await readHistoryFixtureNames(path)).toEqual([original, second, third].sort());
});

it.each(['delete', 'rename', 'add'])('rejects %s of a compatibility fixture without a manifest update', async operation => {
  const path = await directory();
  await recordHistoryFixture(path, 'supervisor-polls-legacy', { events: [] });
  const file = join(path, 'supervisor-polls-legacy.json');
  if (operation === 'delete') await rm(file);
  if (operation === 'rename') await rename(file, join(path, 'renamed.json'));
  if (operation === 'add') await writeFile(join(path, 'unlisted.json'), '{}');
  await expect(readHistoryFixtureNames(path)).rejects.toThrow('Workflow-history manifest mismatch');
});

it('rejects duplicate manifest entries and unsafe fixture names', async () => {
  const path = await directory();
  await writeFile(join(path, 'manifest.txt'), 'duplicate.json\nduplicate.json\n');
  await expect(readHistoryFixtureNames(path)).rejects.toThrow('Invalid');
  await expect(recordHistoryFixture(path, '../outside', {})).rejects.toThrow('Invalid');
});
