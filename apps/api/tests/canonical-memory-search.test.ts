import { describe, expect, it, vi } from 'vitest';
import type { MemoryEntry, ListMemoryQuery } from '@space/contracts';
import { CanonicalMemorySearch, canonicalEmbeddingHash } from '../src/canonical-memory-search.js';
import { createMemoryEmbeddings } from '../src/memory-embedding-smoke.js';
import { getApiConfig } from '../src/config.js';
import { searchMemoryDocuments } from '@space/memory-graph';
import { createCanonicalSpaceMemoryBridge } from '@space/runtime';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const entry:MemoryEntry={id:'memory:fact',title:'Storage policy',body:'Keep backups outside the VM.',provenance:'canonical',scope:'ROOM',roomId:'room:alpha',createdAt:'2026-09-05T00:00:00.000Z'};
const query:ListMemoryQuery={page:1,pageSize:25,sortOrder:'desc',q:'durable recovery',scope:'ROOM',roomId:'room:alpha',searchMode:'semantic'};
function fixture(){
 let entries=[{...entry}];const indexed=new Map<string,string>();
 const embed=vi.fn(async(texts:string[])=>texts.map(()=>Array(1536).fill(.1)));
 const repository={list:async()=>[...indexed].map(([id,inputHash])=>({id,inputHash})),upsert:vi.fn(async(row:{id:string;hash:string})=>{indexed.set(row.id,row.hash);}),search:async()=>[...indexed].map(([id,inputHash])=>({id,inputHash,similarity:.8})),close:async()=>{}};
 const service=new CanonicalMemorySearch({canonical:{list:async(q)=>{const scoped=entries.filter(e=>(!q.scope||e.scope===q.scope)&&(!q.roomId||e.roomId===q.roomId));return q.q?searchMemoryDocuments(scoped,q.q):scoped;},save:async()=>entry},repository,provider:'test',model:'test',ready:async()=>true,embed});
 return {service,embed,repository,setEntries:(v:MemoryEntry[])=>{entries=v;}};
}
describe('canonical semantic index',()=>{
 it('keeps late keyword evidence when the same record also has a semantic hit',async()=>{
  const root=await mkdtemp(join(tmpdir(),'space-hybrid-evidence-'));
  try {
   const paths={indexPath:join(root,'gemini_history.md'),monthlyPath:join(root,'gemini_history_2026-09.md')};
   await writeFile(paths.indexPath,'# Index\n');
   await writeFile(paths.monthlyPath,`## 2026-09-05 - Long source\n\n${'Unrelated context. '.repeat(1200)}LateNeedle verified /external/recovery-copy.\n`);
   const canonical=createCanonicalSpaceMemoryBridge(paths);
   const all=await canonical.list({page:1,pageSize:25,sortOrder:'desc',searchMode:'keyword'});
   expect(all[0]?.body).not.toContain('LateNeedle');
   const record=all[0]!;
   const service=new CanonicalMemorySearch({canonical,provider:'test',model:'test',ready:async()=>true,embed:async()=>[],
    repository:{list:async()=>[],upsert:async()=>{},close:async()=>{},search:async()=>[{id:record.id,inputHash:canonicalEmbeddingHash(record),similarity:.9}]}});
   const results=await service.search({...query,scope:'SYSTEM',roomId:undefined,q:'LateNeedle verified'},[]);
   expect(results).toHaveLength(1);
   expect(results[0]?.body).toContain('LateNeedle verified /external/recovery-copy.');
   expect(results[0]?.body.length).toBeLessThanOrEqual(10000);
   expect(await service.search({...query,q:'LateNeedle verified'},[])).toEqual([]);
  } finally {await rm(root,{recursive:true,force:true});}
 });
 it('indexes once, skips unchanged records, and never serves stale/deleted/other-room vectors',async()=>{
  const f=fixture();expect((await f.service.sync()).updated).toBe(1);expect((await f.service.sync()).updated).toBe(0);expect(f.embed).toHaveBeenCalledTimes(1);
  expect(await f.service.search(query,[])).toHaveLength(1);
  expect(await f.service.search({...query,roomId:'room:beta'},[])).toEqual([]);
  f.setEntries([{...entry,body:'New recovery policy.'}]);expect(await f.service.search(query,[])).toEqual([]);
  expect((await f.service.coverage()).indexed).toBe(0);
  expect((await f.service.sync()).updated).toBe(1);expect((await f.service.coverage()).indexed).toBe(1);
  f.setEntries([]);expect(await f.service.search(query,[])).toEqual([]);
 });
 it('retries after provider failure and reports a sanitized failure',async()=>{
  const f=fixture();f.embed.mockRejectedValueOnce(new Error('secret provider response'));
  await expect(f.service.sync()).rejects.toThrow('synchronization failed');
  expect((await f.service.coverage()).error).not.toContain('secret provider response');
  expect((await f.service.sync()).updated).toBe(1);expect((await f.service.coverage()).error).toBeNull();
 });
 it('rejects incomplete batches without storing partial mappings',async()=>{
  const f=fixture();f.embed.mockResolvedValueOnce([]);await expect(f.service.sync()).rejects.toThrow();expect(f.repository.upsert).not.toHaveBeenCalled();
 });
 it('drops hits below the model\'s noise floor: 0.4 by default, 0.55 for the local bge-m3',async()=>{
  const search=(model:string,similarity:number)=>new CanonicalMemorySearch({canonical:{list:async()=>[entry],save:async()=>entry},provider:'codex-lb',model,
   ready:async()=>true,embed:async()=>[],repository:{list:async()=>[],upsert:async()=>{},close:async()=>{},search:async()=>[{id:entry.id,inputHash:canonicalEmbeddingHash(entry),similarity}]}})
   .search({...query,q:undefined},[]);
  expect([(await search('text-embedding-3-small',.45)).length,(await search('bge-m3',.45)).length,(await search('bge-m3',.6)).length]).toEqual([1,0,1]);
 });
 it('includes visibility changes in the embedding fingerprint',()=>{
  expect(canonicalEmbeddingHash(entry)).not.toBe(canonicalEmbeddingHash({...entry,scope:'SYSTEM',roomId:null}));
 });
});
describe('embedding batch transport',()=>{
 const config=getApiConfig({SPACE_MEMORY_EMBEDDING_PROVIDER:'codex-lb',SPACE_MEMORY_EMBEDDING_MODEL:'test-model',SPACE_MEMORY_EMBEDDING_KEY_FILE:'/private/test-key',SPACE_MEMORY_EMBEDDING_KEY_NAME:'space-memory-test',SPACE_MEMORY_EMBEDDING_BASE_URL:'http://127.0.0.1:2458/v1'});
 it('maps indexed provider responses back to the right canonical inputs',async()=>{
  const vectors=await createMemoryEmbeddings(config,['first','second'],{readFileImpl:async()=> 'fake-key',fetchImpl:async()=>({ok:true,status:200,json:async()=>({data:[{index:1,embedding:Array(1536).fill(2)},{index:0,embedding:Array(1536).fill(1)}]})})});
  expect(vectors[0]?.[0]).toBe(1);expect(vectors[1]?.[0]).toBe(2);
 });
 it('rejects duplicate indexes and nonfinite vectors',async()=>{
  await expect(createMemoryEmbeddings(config,['first','second'],{readFileImpl:async()=> 'fake-key',fetchImpl:async()=>({ok:true,status:200,json:async()=>({data:[{index:0,embedding:Array(1536).fill(1)},{index:0,embedding:Array(1536).fill(2)}]})})})).rejects.toThrow('ordering');
 });
});
