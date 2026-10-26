import { mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createCanonicalSpaceMemoryBridge } from '../src/shared-state.js';
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, {recursive:true,force:true}); });
async function fixture() {
 const root=await mkdtemp(join(tmpdir(),'space-memory-save-')); roots.push(root);
 const paths={indexPath:join(root,'gemini_history.md'),monthlyPath:join(root,'gemini_history_2026-10.md'),lockPath:join(root,'gemini_history_2026-10.md.lock')};
 await writeFile(paths.indexPath,'# History\n');
 return {paths,bridge:createCanonicalSpaceMemoryBridge(paths)};
}
const input={scope:'SYSTEM' as const,title:'Queue rule',body:'Deploy only through the merge queue.',provenance:'test'};
const query={page:1,pageSize:25,sortOrder:'desc' as const,searchMode:'keyword' as const};
describe('canonical memory save',()=>{
 it('returns the existing entry for an identical title and body instead of appending',async()=>{
  const {paths,bridge}=await fixture();
  const first=await bridge.save(input);
  const second=await bridge.save(input);
  expect(second).toMatchObject({id:first.id,createdAt:first.createdAt});
  expect((await readFile(paths.monthlyPath,'utf8')).match(/space-memory:id=/g)).toHaveLength(1);
  const changed=await bridge.save({...input,body:'Deploy only through the merge queue to dev.'});
  expect(changed.id).not.toBe(first.id);
 });
 it('names the new month file after its own month',async()=>{
  const {paths,bridge}=await fixture();
  await bridge.save(input);
  expect((await readFile(paths.monthlyPath,'utf8')).split('\n')[0]).toBe('# Space Memory 2026-10');
 });
 it('removes a stale lock left by a dead writer but waits for a live one',async()=>{
  const {paths,bridge}=await fixture();
  await writeFile(paths.lockPath,'2147483646 2026-10-01T00:00:00.000Z\n');
  const old=new Date(Date.now()-60_000); await utimes(paths.lockPath,old,old);
  await expect(bridge.save(input)).resolves.toMatchObject({title:'Queue rule'});
  await writeFile(paths.lockPath,`${process.pid} ${new Date().toISOString()}\n`);
  await utimes(paths.lockPath,old,old);
  await expect(bridge.save({...input,title:'Blocked'})).rejects.toMatchObject({code:'EEXIST'});
  await rm(paths.lockPath);
 },15_000);
 it('hides a record that a newer save supersedes',async()=>{
  const {bridge}=await fixture();
  const old=await bridge.save({...input,title:'Old queue rule'});
  await bridge.save({...input,title:'New queue rule',body:`Deploy through the merge queue to dev.\nsupersedes=${old.id}`});
  const titles=(await bridge.list({...query,q:'merge queue'})).map(e=>e.title);
  expect(titles).toContain('New queue rule');
  expect(titles).not.toContain('Old queue rule');
 },15_000); // list() parses each source in a fresh worker thread (about a second per source)
});
