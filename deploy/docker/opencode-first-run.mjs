// Uses the native catalog and native completion path; never overrides provider.opencode.
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
export function parseCatalog(text) {
  const candidates=[];
  for(const match of text.matchAll(/^opencode\/([^\r\n]+)\r?\n(\{[\s\S]*?^\})/gm)){
    try{const model=JSON.parse(match[2]);if(model.providerID==='opencode'&&model.cost?.input===0&&model.cost?.output===0&&model.capabilities?.toolcall===true&&model.status==='active')candidates.push({id:`opencode/${model.id}`,name:model.name,api:model.api,cost:model.cost,release:model.release_date??''});}catch{}
  }
  return candidates.sort((a,b)=>b.release.localeCompare(a.release));
}
function execute(args,env,cwd,timeout=60000){return new Promise(resolve=>{
  const child=spawn('opencode',args,{env,cwd,stdio:['ignore','pipe','pipe']});let stdout='';let stderr='';let timedOut=false;
  child.stdout.on('data',c=>stdout+=c);child.stderr.on('data',c=>stderr+=c);
  const timer=setTimeout(()=>{timedOut=true;child.kill('SIGTERM');setTimeout(()=>child.kill('SIGKILL'),2000).unref();},timeout);
  child.once('error',()=>{clearTimeout(timer);resolve({code:1,stdout,stderr});});
  child.once('close',code=>{clearTimeout(timer);resolve({code:timedOut?124:code,stdout,stderr});});
});}
export function completionSucceeded(result) {
  if(result.code!==0)return false;
  const events=result.stdout.split('\n').flatMap(line=>{try{return [JSON.parse(line)];}catch{return [];}});
  return !events.some(e=>e.type==='error')&&events.some(e=>e.type==='text'&&e.part?.text?.includes('SPACEAPP_READY'))&&events.some(e=>e.type==='step_finish');
}
export async function selectWorkingFreeModel({env=process.env,executeNative=execute}={}) {
  const directory=await mkdtemp(join(tmpdir(),'spaceapp-free-model-'));
  const isolated={PATH:env.PATH,LANG:env.LANG,USER:env.USER,HOME:directory,XDG_CONFIG_HOME:join(directory,'config'),XDG_DATA_HOME:join(directory,'data'),XDG_CACHE_HOME:join(directory,'cache'),XDG_STATE_HOME:join(directory,'state')};
  try {
    const deadline=Date.now()+100000;
    const listed=await executeNative(['models','opencode','--refresh','--verbose'],isolated,directory,20000);
    if(listed.code!==0)throw new Error('Native OpenCode catalog could not be refreshed. Retry when online.');
    const candidates=parseCatalog(listed.stdout);
    for(const candidate of candidates.slice(0,5)) {
      const remaining=deadline-Date.now(); if(remaining<5000)break;
      process.stderr.write(`Checking free OpenCode model: ${candidate.name}\n`);
      const res=await executeNative(['run','--format','json','--model',candidate.id,'Reply exactly SPACEAPP_READY. Do not use tools.'],isolated,directory,Math.min(25000,remaining));
      if(completionSucceeded(res)){
        const events=res.stdout.split('\n').flatMap(line=>{try{return [JSON.parse(line)];}catch{return [];}});
        return {...candidate,verifiedAt:new Date().toISOString(),nativeSessionId:events.find(e=>e.sessionID)?.sessionID ?? null};
      }
    }
    throw new Error('No free OpenCode model completed a request. The app remains available; retry OpenCode later or choose a provider in Settings.');
  } finally {await rm(directory,{recursive:true,force:true});}
}
export async function configureFirstRun(env=process.env) {
  const configDir=env.XDG_CONFIG_HOME;
  if(!configDir)throw new Error('OpenCode config directory is required');
  const directory=join(configDir,'opencode');
  await mkdir(directory,{recursive:true});
  const path=join(directory,'opencode.json');
  const lock=join(directory,'.spaceapp-first-run.lock');
  const deadline=Date.now()+110000;
  for(;;){
    try {await mkdir(lock);break;} catch(error){
      if(error.code!=='EEXIST')throw error;
      if(Date.now()>=deadline)throw new Error('OpenCode initialization is already running. Retry after it finishes.');
      await delay(500);
    }
  }
  try {
    const previous=await readFile(path,'utf8').catch(error=>{if(error.code!=='ENOENT')throw error;return null;});
    const config=previous===null?{}:JSON.parse(previous);
    if(config.model)return; // Preserve an owner's choice, including a paid provider.
    const model=await selectWorkingFreeModel({env});
    const current=await readFile(path,'utf8').catch(error=>{if(error.code!=='ENOENT')throw error;return null;});
    if(current!==previous)throw new Error('OpenCode configuration changed during discovery. Retry to preserve your settings.');
    await writeFile(path,JSON.stringify({...config,model:model.id},null,2),{mode:0o600,flag:previous===null?'wx':'w'});
    const memory='/var/lib/spaceapp/memory';await mkdir(memory,{recursive:true});
    await writeFile(join(memory,'installation-model.json'),JSON.stringify(model,null,2),{mode:0o600});
  } finally { await rm(lock,{recursive:true,force:true}); }
}
if(process.argv[1]===fileURLToPath(import.meta.url)) configureFirstRun().catch(e=>{process.stderr.write(e.message+'\n');process.exitCode=1;});
