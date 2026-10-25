import { mkdtemp, writeFile, rm, symlink, appendFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createCanonicalSpaceMemoryBridge } from '../src/shared-state.js';
import { redactMemoryText } from '../src/store.js';
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, {recursive:true,force:true}); });
async function fixture() {
 const root=await mkdtemp(join(tmpdir(),'space-memory-retrieval-')); roots.push(root);
 const paths={indexPath:join(root,'gemini_history.md'),monthlyPath:join(root,'gemini_history_2026-09.md')};
 await writeFile(paths.indexPath,'# History\n\n- IndexOnly reference\n');
 await writeFile(paths.monthlyPath,'# September\n');
 return {root,paths,bridge:createCanonicalSpaceMemoryBridge(paths)};
}
const query={page:1,pageSize:25,sortOrder:'desc' as const,searchMode:'keyword' as const};
describe('canonical production retrieval',()=>{
 it('parses a large monthly file without blocking the event loop',async()=>{
  // Stable's 3.5 MB month held the API's loop for up to 15 s when it was parsed on the main thread (2026-10-24).
  const {bridge,paths}=await fixture();
  const entry=(n:number)=>`\n<!-- space-memory:id=memory:loop${String(n).padStart(6,'0')} -->\n## 2026-09-04 10:00 EEST - LoopProof ${n}\n\n${Array.from({length:8},(_,i)=>`- step ${i} of entry ${n} with enough words to look like a real note`).join('\n')}\n`;
  await appendFile(paths.monthlyPath,Array.from({length:2500},(_,n)=>entry(n)).join(''));
  let maxLagMs=0,last=Date.now();
  const timer=setInterval(()=>{const now=Date.now();maxLagMs=Math.max(maxLagMs,now-last-10);last=now;},10);
  const started=Date.now();
  const entries=await bridge.list({...query,q:'LoopProof 2499'});
  const parseMs=Date.now()-started;
  // The gap since the last tick counts too: a blocked loop resumes here before the overdue tick runs.
  maxLagMs=Math.max(maxLagMs,Date.now()-last-10);
  clearInterval(timer);
  expect(entries.some(e=>e.title.includes('LoopProof 2499'))).toBe(true);
  expect(parseMs).toBeGreaterThan(300);
  expect(maxLagMs).toBeLessThan(parseMs/2);
 },30_000);
 it('never returns provider secrets a memory file holds (security addendum step 1)',async()=>{
  // Assembled at runtime: no secret-shaped literal in the source. Synthetic values only.
  const stripe=['sk','live','51Synthetic'+'X'.repeat(30)+'z2k0'].join('_');
  const restricted=['rk','test','Synthetic'+'Y'.repeat(20)].join('_');
  const webhook='whsec'+'_'+'Synthetic'+'Z'.repeat(24);
  const aws='AKIA'+'SYNTHETIC0000000';
  const {bridge,paths}=await fixture();
  await appendFile(paths.monthlyPath,`\n## 2026-09-04 - StripeSwitchProof\n\n- Verified the new live Secret Key \`${stripe}\` and \`${restricted}\`, webhook secret ${webhook}, AWS ${aws}\n`);
  const [entry]=await bridge.list({...query,q:'StripeSwitchProof'});
  const text=JSON.stringify(entry);
  for(const secret of [stripe,restricted,webhook,aws]) expect(text).not.toContain(secret);
  expect(text).toContain('[REDACTED Stripe key]');
  expect(redactMemoryText(`pk_live_${'P'.repeat(24)}`)).toContain('pk_live_');
  expect(redactMemoryText(`aws_secret_access_key = ${'a'.repeat(40)}`)).toBe('aws_secret_access_key = [REDACTED]');
  expect(redactMemoryText(redactMemoryText(text))).toBe(redactMemoryText(text));
 });
 it('round trips marker, timestamp and room without leaking another room',async()=>{
  const {bridge}=await fixture();
  const saved=await bridge.save({scope:'ROOM',roomId:'room:alpha',title:'Isolated fact',body:'Durable audit body',provenance:'test'});
  expect(saved.scope).toBe('ROOM');
  const entries=await bridge.list({...query,q:'Durable audit',scope:'ROOM',roomId:'room:alpha'});
  expect(entries).toHaveLength(1);expect(entries[0]).toMatchObject({id:saved.id,createdAt:saved.createdAt,scope:'ROOM',roomId:'room:alpha'});
  expect(await bridge.list({...query,q:'Durable audit',scope:'ROOM',roomId:'room:beta'})).toEqual([]);
  expect(await bridge.list({...query,q:'Durable audit',scope:'SYSTEM'})).toEqual([]);
 });
 it('finds all months, index and domain rules, including new external writes and deletions',async()=>{
  const {bridge,root,paths}=await fixture();
  const old=join(root,'gemini_history_2026-02.md');
  await writeFile(old,'## 2026-02-01 - ArchiveOnly\n\n- Old durable knowledge\n');
  await writeFile(join(root,'gemini_core_access_infra.md'),'# Infrastructure\n\n- RuleOnly durable rule\n');
  expect((await bridge.list({...query,q:'ArchiveOnly'}))).toHaveLength(1);
  expect((await bridge.list({...query,q:'IndexOnly'}))).toHaveLength(1);
  expect((await bridge.list({...query,q:'RuleOnly'}))).toHaveLength(1);
  await appendFile(paths.monthlyPath,'\n## 2026-09-05 - ExternalCLIWrite\n\n- Changed outside the API\n');
  expect((await bridge.list({...query,q:'ExternalCLIWrite'}))).toHaveLength(1);
  await rm(old);expect(await bridge.list({...query,q:'ArchiveOnly'})).toEqual([]);
 });
 it('matches Greek accents and terms across lines; excludes archived and explicitly superseded facts',async()=>{
  const {bridge,paths}=await fixture();
  await writeFile(paths.monthlyPath,'<!-- space-memory:id=memory:old -->\n## 2026-09-01 - Μνήμη\n\n- παλιός κανόνας\n\n## 2026-09-05 - Μνήμη συστήματος\n\n- Ανάκτηση\n- supersedes=memory:old\n\n## 2026-09-04 - ArchivedOnly\n\n- lifecycle_status=ARCHIVED\n');
  expect((await bridge.list({...query,q:'Ποια ειναι η μνημη ανακτηση;'}))).toHaveLength(1);
  expect(await bridge.list({...query,q:'παλιος κανονας'})).toEqual([]);
  expect(await bridge.list({...query,q:'ArchivedOnly'})).toEqual([]);
 });
 it('indexes only the designated task-policy file and refreshes edits, deletion and replacement',async()=>{
  const {bridge,root}=await fixture();
  const policy=join(root,'agent_task_policies.md');
  await writeFile(policy,'# Rules\n\n- PolicyOnly clipboard opt-in\n');
  await writeFile(join(root,'private_notes.md'),'# Private\n\n- ExcludedOnly\n');
  expect(await bridge.list({...query,q:'PolicyOnly',scope:'SYSTEM'})).toHaveLength(1);
  expect(await bridge.list({...query,q:'PolicyOnly',scope:'ROOM',roomId:'room:alpha'})).toEqual([]);
  expect(await bridge.list({...query,q:'ExcludedOnly'})).toEqual([]);
  await writeFile(policy,'# Rules\n\n- ReplacedOnly\n');
  expect(await bridge.list({...query,q:'PolicyOnly'})).toEqual([]);
  expect(await bridge.list({...query,q:'ReplacedOnly'})).toHaveLength(1);
  await rm(policy); await symlink(join(root,'private_notes.md'),policy);
  expect(await bridge.list({...query,q:'ExcludedOnly'})).toEqual([]);
  expect(await bridge.list({...query,q:'ReplacedOnly'})).toEqual([]);
  await rm(policy);execFileSync('mkfifo',[policy]);
  expect(await bridge.list({...query,q:'ReplacedOnly'})).toEqual([]);
 });
 it('returns evidence beyond 10000 characters in an external record without changing identity',async()=>{
  const {bridge,paths}=await fixture();
  await writeFile(paths.monthlyPath,`## 2026-09-05 - Long external record\n\n${'Unrelated context. '.repeat(1200)}LateNeedle verified /external/archive-copy.\n`);
  const full=await bridge.list(query);
  const rows=await bridge.list({...query,q:'LateNeedle verified'});
  expect(rows).toHaveLength(1);
  expect(rows[0]?.body).toContain('LateNeedle verified /external/archive-copy.');
  expect(rows[0]?.body.length).toBeLessThanOrEqual(10000);
  expect(rows[0]?.id).toBe(full.find(r=>r.title==='Long external record')?.id);
 });
 it('fails promptly on configured FIFOs/symlinks and never returns a cached record for an unreadable source',async()=>{
  const {bridge,paths}=await fixture();
  await rm(paths.monthlyPath);execFileSync('mkfifo',[paths.monthlyPath]);
  await expect(bridge.list(query)).rejects.toThrow('regular file');
  await rm(paths.monthlyPath);await symlink(paths.indexPath,paths.monthlyPath);
  await expect(bridge.list(query)).rejects.toThrow('regular file');
 });
 it('keeps headings inside a saved body in the original room record',async()=>{
  const {bridge}=await fixture();
  const saved=await bridge.save({scope:'ROOM',roomId:'room:alpha',title:'Multiline note',body:'First line\n\n## Nested heading\nStill the same note',provenance:'test'});
  const rows=await bridge.list({...query,q:'Nested heading'});
  expect(rows).toHaveLength(1);expect(rows[0]).toMatchObject({id:saved.id,scope:'ROOM',roomId:'room:alpha'});
 });
 it('retrieves English backup rules from a Greek natural-language question without matching an unknown identifier',async()=>{
  const {bridge,root}=await fixture();
  await writeFile(join(root,'gemini_core_access_infra.md'),'# Backup rules\n\n- public-host backups belong on external storage /mnt/hetzner-backup.\n');
  expect(await bridge.list({...query,q:'Πώς αποθηκεύονται τα αντίγραφα ασφαλείας της public-host;'})).toHaveLength(1);
  expect(await bridge.list({...query,q:'Πώς αποθηκεύονται τα αντίγραφα ασφαλείας της VM99999;'})).toEqual([]);
 });
 it('redacts labeled credentials and bearer values before persistence and retrieval',async()=>{
  const {bridge}=await fixture();
  const body='Creds: fake@example.invalid / AuditSecret123 · Bearer fake-authorization-value';
  expect(redactMemoryText(body)).not.toContain('AuditSecret123');
  expect(redactMemoryText(body)).not.toContain('fake-authorization-value');
  await bridge.save({scope:'SYSTEM',title:'Credential fixture',body,provenance:'test'});
  expect(JSON.stringify(await bridge.list({...query,q:'Credential fixture'}))).not.toContain('AuditSecret123');
 });
});
