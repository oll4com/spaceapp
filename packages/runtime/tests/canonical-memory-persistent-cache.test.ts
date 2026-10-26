import { appendFile, chmod, mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createCanonicalSpaceMemoryBridge } from '../src/shared-state.js';
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, {recursive:true,force:true}); });
const query={page:1,pageSize:25,sortOrder:'desc' as const,searchMode:'keyword' as const};
async function fixture() {
 const root=await mkdtemp(join(tmpdir(),'space-memory-cache-')); roots.push(root);
 const paths={indexPath:join(root,'docs','gemini_history.md'),monthlyPath:join(root,'docs','gemini_history_2026-10.md')};
 await mkdir(join(root,'docs'));
 await writeFile(paths.indexPath,'# History\n\n- IndexOnly reference\n');
 await writeFile(paths.monthlyPath,'# October\n\n## 2026-10-12 - CachedFact\n\n- Persistent parse cache body\n');
 const cacheDir=join(root,'cache');
 return {root,paths,cacheDir,open:()=>createCanonicalSpaceMemoryBridge(paths,{persistentCacheDir:cacheDir})};
}
// Each list() parses its sources in a fresh worker thread that imports @space/memory-graph (about a second per
// source on an idle host, 2026-10-24), so these cases get a bound sized to that work, like the save tests' lock case.
const parseBound=15_000;
describe('persistent parse cache for recall',()=>{
 it('writes private entries and returns identical results from a new process-like reader',async()=>{
  const {cacheDir,open}=await fixture();
  const first=await open().list({...query,q:'CachedFact'});
  expect(first).toHaveLength(1);
  expect((await stat(cacheDir)).mode&0o777).toBe(0o700);
  const files=await readdir(cacheDir);
  expect(files.length).toBeGreaterThanOrEqual(2);
  for (const file of files) expect((await stat(join(cacheDir,file))).mode&0o777).toBe(0o600);
  expect(await open().list({...query,q:'CachedFact'})).toEqual(first);
 },parseBound);
 it('reparses a source whose fingerprint changed and ignores corrupt entries',async()=>{
  const {cacheDir,paths,open}=await fixture();
  await open().list({...query,q:'CachedFact'});
  await appendFile(paths.monthlyPath,'\n## 2026-10-12 - LaterFact\n\n- Written after the cache\n');
  expect(await open().list({...query,q:'LaterFact'})).toHaveLength(1);
  for (const file of await readdir(cacheDir)) await writeFile(join(cacheDir,file),'{not json');
  expect(await open().list({...query,q:'CachedFact'})).toHaveLength(1);
 },parseBound);
 it('does not use a cache directory that other users can read',async()=>{
  const {cacheDir,open}=await fixture();
  await mkdir(cacheDir); await chmod(cacheDir,0o755);
  expect(await open().list({...query,q:'CachedFact'})).toHaveLength(1);
  expect(await readdir(cacheDir)).toEqual([]);
 },parseBound);
});
