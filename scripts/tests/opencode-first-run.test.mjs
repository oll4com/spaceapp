import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {mkdir,mkdtemp,rm,utimes,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {parseCatalog,preferDefault,toolCycleSucceeded,selectWorkingFreeModel,withBootstrap,scratchDirectory,externalDirectoryDefault,configureFirstRun} from '../../deploy/docker/opencode-first-run.mjs';
// The 2026-10-11 macOS first-agent run stopped at "Access external directory
// /tmp" because nobody answered the prompt. The wrapper's private TMPDIR is
// the only scratch directory authorized in advance; /tmp still asks.
const PROVIDER_TMP='/var/lib/spaceapp-cli/providers/opencode/tmp';
// OpenCode evaluates permission rules in order and the last matching rule wins.
const decide=(rules,path)=>{
 const match=(pattern,value)=>new RegExp('^'+pattern.replace(/[.+^${}()|[\]\\]/g,'\\$&').replace(/\*/g,'.*').replace(/\?/g,'.')+'$').test(value);
 return Object.entries(rules).filter(([pattern])=>match(pattern,path)).at(-1)?.[1];
};
const line=e=>JSON.stringify(e);
const toolRun=token=>[line({type:'step_start'}),line({type:'tool_use',part:{type:'tool',tool:'read',state:{status:'completed'}}}),line({type:'step_finish'}),line({type:'step_start'}),line({type:'text',part:{text:token}}),line({type:'step_finish'})].join('\n');
// OpenCode 2 /api/model entries (shape recorded from 2.0.31/2.0.32 on 2026-10-16/17).
const entry=(id,cost=0,released=1788000000000)=>({id,providerID:'opencode',name:id,status:'active',enabled:true,
 cost:[{input:cost,output:cost,cache:{read:0,write:0}}],capabilities:{tools:true},time:{released}});
const catalog=(...models)=>JSON.stringify({data:models});
test('only native explicitly zero-priced tool models are eligible',()=>{
 assert.deepEqual(parseCatalog(catalog(entry('free'),entry('paid',1))).map(x=>x.id),['opencode/free']);
 // A paid tier, a disabled model or another provider is never a free candidate; newest release first.
 const tiered={...entry('tiered'),cost:[{input:0,output:0},{input:1,output:2}]};
 assert.deepEqual(parseCatalog(catalog(entry('older',0,1),tiered,{...entry('off'),enabled:false},{...entry('other'),providerID:'yunwu'},entry('newer',0,2))).map(x=>x.id),
  ['opencode/newer','opencode/older']);
});
test('only a completed read tool call followed by the file token counts as working',()=>{
 const token='SPACEAPP-0123456789ab';
 assert.equal(toolCycleSucceeded({code:0,stdout:toolRun(token)},token),true);
 // OpenCode 2 standalone runs exit right after the answer without the last step_finish.
 assert.equal(toolCycleSucceeded({code:0,stdout:toolRun(token).split('\n').slice(0,-1).join('\n')},token),true);
 assert.equal(toolCycleSucceeded({code:0,stdout:''},token),false);
 // A plain completion without the tool call is not enough.
 assert.equal(toolCycleSucceeded({code:0,stdout:[line({type:'text',part:{text:token}}),line({type:'step_finish'})].join('\n')},token),false);
 // The tool ran but the follow-up turn failed upstream.
 assert.equal(toolCycleSucceeded({code:0,stdout:[line({type:'tool_use',part:{tool:'read',state:{status:'completed'}}}),line({type:'error',error:{name:'APIError'}})].join('\n')},token),false);
 // A different token (a guessed answer) does not count.
 assert.equal(toolCycleSucceeded({code:0,stdout:toolRun('SPACEAPP-guess')},token),false);
 assert.equal(toolCycleSucceeded({code:1,stdout:toolRun(token)},token),false);
});
test('a model that fails the tool cycle falls through to another free model without provider override',async()=>{
 const calls=[];
 const selected=await selectWorkingFreeModel({executeNative:async(args,env,cwd)=>{
 calls.push(args); assert.equal(env.OPENCODE_API_KEY,undefined); assert.equal(env.OPENCODE_DISABLE_AUTOUPDATE,'true');
 if(args[0]==='api')return {code:0,stdout:catalog(entry('unavailable'),entry('working'))};
 const token=readFileSync(join(cwd,'spaceapp-check.txt'),'utf8').trim();
 assert.match(token,/^SPACEAPP-[0-9a-f]{12}$/);
 if(args.includes('opencode/unavailable'))return {code:0,stdout:[line({type:'tool_use',part:{tool:'read',state:{status:'completed'}}}),line({type:'error'})].join('\n')};
 return {code:0,stdout:toolRun(token)};
 }});
 assert.equal(selected.id,'opencode/working');assert.equal(selected.verification,'tool-call');assert.equal(calls.length,3);
 // OpenCode 2 would start its per-user background service without --standalone.
 assert.deepEqual(calls[0],['api','GET','/api/model','--standalone']);assert.deepEqual(calls[1].slice(0,2),['run','--standalone']);
});

test('bootstrap loads installation memory and authorizes only its external directory',()=>{
 const c=withBootstrap({model:'owner/model',instructions:['/owner/rules.md']});
 assert.equal(c.model,'owner/model');
 assert.ok(c.instructions.includes('/owner/rules.md'));
 assert.ok(c.instructions.includes('/var/lib/spaceapp/memory/*.md'));
 assert.equal(c.permission.external_directory['*'],'ask');
 assert.equal(c.permission.external_directory['/var/lib/spaceapp/memory/*'],'allow');
 assert.deepEqual(withBootstrap(c),c);
});
test('an explicit owner permission policy is preserved, including global denial',()=>{
 for(const permission of ['deny',{'*':'deny'},{external_directory:'deny'},{external_directory:{'*':'deny'}},
   {external_directory:{'*':'ask','/var/lib/spaceapp/memory':'allow','/var/lib/spaceapp/memory/*':'deny'}}]){
  const c=withBootstrap({model:'owner/model',permission},{tmpdir:PROVIDER_TMP});
  assert.deepEqual(c.permission,permission);
 }
 assert.throws(()=>withBootstrap({instructions:'invalid'}),/existing settings were preserved/);
});

test('first run pre-authorizes the provider scratch directory and the read-only /etc, never /tmp',()=>{
 const rules=withBootstrap({}, {tmpdir:PROVIDER_TMP}).permission.external_directory;
 assert.deepEqual(rules,{'*':'ask','/var/lib/spaceapp/memory':'allow','/var/lib/spaceapp/memory/*':'allow',
  '/etc/*':'allow',[PROVIDER_TMP]:'allow',[`${PROVIDER_TMP}/*`]:'allow'});
 assert.equal(decide(rules,`${PROVIDER_TMP}/*`),'allow');
 assert.equal(decide(rules,'/var/lib/spaceapp/memory/*'),'allow');
 // 1.1.5 lab: Big Pickle read /etc/spaceapp-installation-guide.md itself and the first task stopped at the prompt.
 // OpenCode's * spans subdirectories, so this is all of /etc, read-only for the CLI user.
 assert.equal(decide(rules,'/etc/*'),'allow');
 assert.equal(decide(rules,'/etc/ssl/*'),'allow');
 for(const path of ['/tmp/*','/tmp','/var/lib/spaceapp-cli/providers/opencode/*','/var/lib/spaceapp-cli/*','/workspaces/*','/root/*'])
  assert.equal(decide(rules,path),'ask',path);
});
test('only the wrapper-owned provider TMPDIR becomes a scratch rule',()=>{
 assert.equal(scratchDirectory(PROVIDER_TMP+'/'),PROVIDER_TMP);
 for(const value of [undefined,'','/','/tmp','/tmp/','/var/tmp','relative/tmp','/var/lib/spaceapp-cli/providers/*/tmp',
   '/var/lib/spaceapp-cli/providers/opencode','/var/lib/spaceapp-cli/providers/opencode/tmp/../../../../tmp'])
  assert.equal(scratchDirectory(value),null,String(value));
 assert.deepEqual(externalDirectoryDefault('/tmp'),{'*':'ask','/var/lib/spaceapp/memory':'allow','/var/lib/spaceapp/memory/*':'allow','/etc/*':'allow'});
});
test('the unchanged 1.1.x default is upgraded once; the result is stable',()=>{
 const legacy={model:'opencode/big-pickle',permission:{edit:'allow',external_directory:{'*':'ask','/var/lib/spaceapp/memory':'allow','/var/lib/spaceapp/memory/*':'allow'}}};
 const upgraded=withBootstrap(legacy,{tmpdir:PROVIDER_TMP});
 assert.equal(upgraded.permission.edit,'allow');
 assert.equal(upgraded.permission.external_directory[`${PROVIDER_TMP}/*`],'allow');
 assert.equal(upgraded.permission.external_directory['/etc/*'],'allow');
 assert.deepEqual(withBootstrap(upgraded,{tmpdir:PROVIDER_TMP}),upgraded);
 // The 1.1.4/1.1.5 default (memory and scratch, no /etc) is upgraded too; an owner-edited policy is not.
 const earlier={external_directory:{'*':'ask','/var/lib/spaceapp/memory':'allow','/var/lib/spaceapp/memory/*':'allow',[PROVIDER_TMP]:'allow',[`${PROVIDER_TMP}/*`]:'allow'}};
 assert.equal(withBootstrap({permission:earlier},{tmpdir:PROVIDER_TMP}).permission.external_directory['/etc/*'],'allow');
 const owned={external_directory:{...earlier.external_directory,'/srv/*':'allow'}};
 assert.deepEqual(withBootstrap({permission:owned},{tmpdir:PROVIDER_TMP}).permission,owned);
});
test('bootstrap instructions send temporary files to TMPDIR instead of /tmp',()=>{
 for(const file of ['starter-memory/AGENTS.md','starter-memory/installation-guide.md']){
  const text=readFileSync(join(import.meta.dirname,'../..',file),'utf8');
  assert.match(text,/temporary file[\s\S]{0,120}`\$TMPDIR`/i,file);
  assert.match(text,/not use `\/tmp`|never `\/tmp`/,file);
 }
});
test('configureFirstRun writes the scratch rule for the wrapper TMPDIR',async()=>{
 const root=await mkdtemp(join(tmpdir(),'spaceapp-first-run-'));
 try{
  const config=join(root,'config');await mkdir(join(config,'opencode'),{recursive:true});
  await writeFile(join(config,'opencode','opencode.json'),JSON.stringify({model:'owner/model'}));
  await configureFirstRun({XDG_CONFIG_HOME:config,TMPDIR:PROVIDER_TMP});
  const written=JSON.parse(readFileSync(join(config,'opencode','opencode.json'),'utf8'));
  assert.equal(written.model,'owner/model');
  assert.equal(written.permission.external_directory[`${PROVIDER_TMP}/*`],'allow');
  assert.equal(decide(written.permission.external_directory,'/tmp/*'),'ask');
 }finally{await rm(root,{recursive:true,force:true});}
});

test('a failed free-model check still writes the bootstrap and memory permissions',async()=>{
 // 2026-10-14 Windows 1.1.5 lab: the check failed on first launch, the wrapper started OpenCode anyway with no
 // config, and the first task stopped at "Access external directory /var/lib/spaceapp/memory".
 const root=await mkdtemp(join(tmpdir(),'spaceapp-first-run-'));
 try{
  const config=join(root,'config');
  await assert.rejects(configureFirstRun({XDG_CONFIG_HOME:config,TMPDIR:PROVIDER_TMP,PATH:''}),/catalog could not be refreshed/);
  const written=JSON.parse(readFileSync(join(config,'opencode','opencode.json'),'utf8'));
  assert.equal(written.model,undefined);
  assert.ok(written.instructions.includes('/etc/spaceapp-installation-guide.md'));
  assert.equal(decide(written.permission.external_directory,'/var/lib/spaceapp/memory/*'),'allow');
 }finally{await rm(root,{recursive:true,force:true});}
});

test('Big Pickle is tried first, then the newest free models',async()=>{
 assert.deepEqual(preferDefault([{id:'opencode/new-free'},{id:'opencode/big-pickle'}]).map(x=>x.id),['opencode/big-pickle','opencode/new-free']);
 const tried=[];
 const selected=await selectWorkingFreeModel({executeNative:async(args,env,cwd)=>{
  if(args[0]==='api')return {code:0,stdout:catalog(entry('new-free'),entry('big-pickle'))};
  tried.push(args[args.indexOf('--model')+1]);
  if(args.includes('opencode/big-pickle'))return {code:0,stdout:line({type:'error'})};
  return {code:0,stdout:toolRun(readFileSync(join(cwd,'spaceapp-check.txt'),'utf8').trim())};
 }});
 assert.deepEqual(tried,['opencode/big-pickle','opencode/new-free']);
 assert.equal(selected.id,'opencode/new-free');
});

test('a lock left by a killed first run is broken instead of making every start wait',async()=>{
 const root=await mkdtemp(join(tmpdir(),'spaceapp-first-run-'));
 try{
  const config=join(root,'config');await mkdir(join(config,'opencode','.spaceapp-first-run.lock'),{recursive:true});
  const old=new Date(Date.now()-10*60*1000);
  await utimes(join(config,'opencode','.spaceapp-first-run.lock'),old,old);
  await writeFile(join(config,'opencode','opencode.json'),JSON.stringify({model:'owner/model'}));
  const started=Date.now();
  await configureFirstRun({XDG_CONFIG_HOME:config,TMPDIR:PROVIDER_TMP});
  assert.ok(Date.now()-started<5000);
  assert.equal(JSON.parse(readFileSync(join(config,'opencode','opencode.json'),'utf8')).model,'owner/model');
 }finally{await rm(root,{recursive:true,force:true});}
});

// VM219 2026-10-20: right after the owner claim several OpenCode starts overlap in the CLI container and the catalog answers 503.
test('the catalog call is retried after a 503 from overlapping starts, then the selection goes on as before',async()=>{
 const listings=[];
 const selected=await selectWorkingFreeModel({executeNative:async(args,env,cwd)=>{
  if(args[0]==='api'){listings.push(Date.now());return listings.length===1?{code:1,stdout:'',stderr:'HTTP 503 Service Unavailable\n'}:{code:0,stdout:catalog(entry('big-pickle'))};}
  return {code:0,stdout:toolRun(readFileSync(join(cwd,'spaceapp-check.txt'),'utf8').trim())};
 }});
 assert.equal(selected.id,'opencode/big-pickle');assert.equal(listings.length,2);
 assert.ok(listings[1]-listings[0]>=2900,'3 s apart');
});

test('three failed catalog calls (503, timeout, connection) fail as before, within the budget',async()=>{
 const answers=[{code:1,stdout:'',stderr:'HTTP 503 Service Unavailable'},{code:124,stdout:'',stderr:''},{code:1,stdout:'',stderr:'Error: connect ECONNREFUSED 127.0.0.1:4096'}];
 let listings=0;const started=Date.now();
 await assert.rejects(selectWorkingFreeModel({executeNative:async(args)=>{if(args[0]==='api')return answers[listings++];throw new Error('no model run');}}),/catalog could not be refreshed/);
 assert.equal(listings,3);assert.ok(Date.now()-started<100000);
});

test('a 4xx catalog answer is not retried',async()=>{
 let listings=0;
 await assert.rejects(selectWorkingFreeModel({executeNative:async(args)=>{if(args[0]==='api'){listings++;return {code:1,stdout:'',stderr:'HTTP 401 Unauthorized'};}throw new Error('no model run');}}),/catalog could not be refreshed/);
 assert.equal(listings,1);
});
