// Uses the native catalog and native completion path; never overrides provider.opencode.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, writeFile, mkdir, rm, stat } from 'node:fs/promises';
import { isAbsolute, join, normalize } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
// OpenCode 2's model API (`opencode api GET /api/model`): free (every cost tier zero), tool-capable, active Zen
// models, newest first.
export function parseCatalog(text) {
  let models=[];
  try{models=JSON.parse(text)?.data??[];}catch{}
  return (Array.isArray(models)?models:[])
    .filter(model=>model?.providerID==='opencode'&&Array.isArray(model.cost)&&model.cost.length>0&&
      model.cost.every(tier=>tier?.input===0&&tier?.output===0)&&model.capabilities?.tools===true&&model.status==='active'&&model.enabled!==false)
    .map(model=>({id:`opencode/${model.id}`,name:model.name,api:{url:model.settings?.baseURL,npm:model.package},cost:model.cost[0],release:model.time?.released??0}))
    .sort((a,b)=>b.release-a.release);
}
function execute(args,env,cwd,timeout=60000){return new Promise(resolve=>{
  const child=spawn('opencode',args,{env,cwd,stdio:['ignore','pipe','pipe']});let stdout='';let stderr='';let timedOut=false;
  child.stdout.on('data',c=>stdout+=c);child.stderr.on('data',c=>stderr+=c);
  const timer=setTimeout(()=>{timedOut=true;child.kill('SIGTERM');setTimeout(()=>child.kill('SIGKILL'),2000).unref();},timeout);
  child.once('error',()=>{clearTimeout(timer);resolve({code:1,stdout,stderr});});
  child.once('close',code=>{clearTimeout(timer);resolve({code:timedOut?124:code,stdout,stderr});});
});}
const CHECK_FILE='spaceapp-check.txt';
const CHECK_PROMPT=`Use the read tool to read the file ${CHECK_FILE} in the current directory, then reply with exactly its contents and nothing else.`;
const events=stdout=>stdout.split('\n').flatMap(line=>{try{return [JSON.parse(line)];}catch{return [];}});
// A model counts as working only after a full tool cycle: it calls the read
// tool, receives the result and answers with the random token from the file.
// A plain completion is not enough; some free models fail on tool follow-ups. An OpenCode 2 standalone run ends
// right after the answer without printing its last step_finish (2.0.31, 2.0.32), so the clean exit closes the turn.
export function toolCycleSucceeded(result,token) {
  if(result.code!==0||!token)return false;
  const list=events(result.stdout);
  if(list.some(e=>e.type==='error'))return false;
  const tool=list.findIndex(e=>e.type==='tool_use'&&e.part?.tool==='read'&&e.part?.state?.status==='completed');
  if(tool<0)return false;
  const answer=list.findIndex((e,i)=>i>tool&&e.type==='text'&&e.part?.text?.includes(token));
  return answer>tool;
}
const MEMORY_DIRECTORY='/var/lib/spaceapp/memory';
// The 1.1.x default. Configs that still carry exactly this value get the new
// default; any other value is an owner policy and is preserved.
const LEGACY_EXTERNAL_DIRECTORY={'*':'ask',[MEMORY_DIRECTORY]:'allow',[`${MEMORY_DIRECTORY}/*`]:'allow'};
// The CLI wrapper gives each provider a private TMPDIR under its state volume
// (public-cli-wrapper.sh). Only that directory is pre-authorized for scratch
// files; the shared /tmp and every other external path still ask.
const PROVIDER_TMPDIR=/^\/var\/lib\/spaceapp-cli\/providers\/[a-z0-9-]+\/tmp$/;
export function scratchDirectory(tmpdir) {
  if(typeof tmpdir!=='string'||!isAbsolute(tmpdir))return null;
  const path=normalize(tmpdir).replace(/\/+$/,'');
  return PROVIDER_TMPDIR.test(path)?path:null;
}
const scratchRules=tmpdir=>{const scratch=scratchDirectory(tmpdir);return scratch?{[scratch]:'allow',[`${scratch}/*`]:'allow'}:{};};
// /etc holds the bootstrap instructions; models sometimes read /etc/spaceapp-installation-guide.md themselves,
// and the first task stopped at "Access external directory /etc" (1.1.5 lab, 2026-10-15). OpenCode's * also
// spans subdirectories: /etc is read-only for the CLI user, and root-only files there stay unreadable.
const BOOTSTRAP_DIRECTORY={'/etc/*':'allow'};
export function externalDirectoryDefault(tmpdir) {
  return {...LEGACY_EXTERNAL_DIRECTORY,...BOOTSTRAP_DIRECTORY,...scratchRules(tmpdir)};
}
const sameRules=(left,right)=>left!==null&&typeof left==='object'&&!Array.isArray(left)&&
  Object.keys(left).length===Object.keys(right).length&&Object.entries(right).every(([key,value])=>left[key]===value);
export function withBootstrap(config,{tmpdir}={}) {
  if(config.instructions!==undefined&&!Array.isArray(config.instructions))throw new Error('OpenCode instructions must be an array; existing settings were preserved.');
  const instructions=[...new Set([...(config.instructions??[]),
    '/etc/AGENTS.md','/etc/spaceapp-installation-guide.md',`${MEMORY_DIRECTORY}/*.md`])];
  const next={...config,instructions};
  // Respect an owner's explicit permission policy. Fresh installs authorize
  // only their shared private memory directory, the provider's private
  // scratch directory and the read-only /etc; other external paths still ask.
  const permission=config.permission;
  const unset=permission===undefined || (typeof permission==='object' && permission!==null &&
    !('*' in permission) && !('external_directory' in permission));
  // The earlier defaults (1.1.x, then 1.1.4/1.1.5 with the scratch rules) are upgraded; any other value is the owner's.
  const earlier=[LEGACY_EXTERNAL_DIRECTORY,{...LEGACY_EXTERNAL_DIRECTORY,...scratchRules(tmpdir)}];
  if(unset || (typeof permission==='object' && permission!==null &&
      earlier.some(rules=>sameRules(permission.external_directory,rules)))) {
    next.permission={...(permission??{}),external_directory:externalDirectoryDefault(tmpdir)};
  }
  return next;
}
// Big Pickle is the default first-run model; other free models are tried only when it fails the tool-call check.
export const DEFAULT_FREE_MODEL='opencode/big-pickle';
export function preferDefault(candidates){
  const first=candidates.filter(c=>c.id===DEFAULT_FREE_MODEL);
  return [...first,...candidates.filter(c=>c.id!==DEFAULT_FREE_MODEL)];
}
// Catalog (20 s) plus selection stays under the 130 s OpenCode credential-smoke timeout in the API.
const SELECTION_BUDGET_MS=100000;
export async function selectWorkingFreeModel({env=process.env,executeNative=execute}={}) {
  const directory=await mkdtemp(join(tmpdir(),'spaceapp-free-model-'));
  const isolated={PATH:env.PATH,LANG:env.LANG,USER:env.USER,OPENCODE_DISABLE_AUTOUPDATE:'true',HOME:directory,XDG_CONFIG_HOME:join(directory,'config'),XDG_DATA_HOME:join(directory,'data'),XDG_CACHE_HOME:join(directory,'cache'),XDG_STATE_HOME:join(directory,'state')};
  try {
    const deadline=Date.now()+SELECTION_BUDGET_MS;
    // --standalone everywhere: without it OpenCode 2 starts its per-user background service.
    // Overlapping OpenCode starts after the owner claim answer 503 (VM219 2026-10-20): 3 tries, 3 s apart; never a 4xx.
    let listed;
    for(let attempt=1;;attempt++){
      listed=await executeNative(['api','GET','/api/model','--standalone'],isolated,directory,20000);
      const transient=listed.code===124||/\bHTTP 503\b|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|fetch failed|socket hang up/i.test(listed.stderr??'');
      if(listed.code===0||!transient||attempt===3||deadline-Date.now()<3000+20000)break;
      await delay(3000);
    }
    if(listed.code!==0)throw new Error('Native OpenCode catalog could not be refreshed. Retry when online.');
    const candidates=preferDefault(parseCatalog(listed.stdout));
    const work=join(directory,'work');await mkdir(work);
    for(const candidate of candidates.slice(0,5)) {
      const remaining=deadline-Date.now(); if(remaining<10000)break;
      process.stderr.write(`Checking free OpenCode model: ${candidate.name}\n`);
      const token=`SPACEAPP-${randomBytes(6).toString('hex')}`;
      await writeFile(join(work,CHECK_FILE),token+'\n');
      const res=await executeNative(['run','--standalone','--format','json','--model',candidate.id,CHECK_PROMPT],isolated,work,Math.min(40000,remaining));
      if(toolCycleSucceeded(res,token)){
        return {...candidate,verification:'tool-call',verifiedAt:new Date().toISOString(),nativeSessionId:events(res.stdout).find(e=>e.sessionID)?.sessionID ?? null};
      }
    }
    throw new Error('No free OpenCode model completed a tool call. The app remains available; retry OpenCode later or choose a provider in Settings.');
  } finally {await rm(directory,{recursive:true,force:true});}
}
export async function configureFirstRun(env=process.env) {
  const configDir=env.XDG_CONFIG_HOME;
  if(!configDir)throw new Error('OpenCode config directory is required');
  const directory=join(configDir,'opencode');
  await mkdir(directory,{recursive:true});
  const path=join(directory,'opencode.json');
  const lock=join(directory,'.spaceapp-first-run.lock');
  const deadline=Date.now()+SELECTION_BUDGET_MS+20000;
  for(;;){
    try {await mkdir(lock);break;} catch(error){
      if(error.code!=='EEXIST')throw error;
      // A lock older than a whole selection was left by a killed run (OOM, SIGKILL); without this every start waited 120 s.
      const age=await stat(lock).then(info=>Date.now()-info.mtimeMs,()=>0);
      if(age>SELECTION_BUDGET_MS+20000){await rm(lock,{recursive:true,force:true});continue;}
      if(Date.now()>=deadline)throw new Error('OpenCode initialization is already running. Retry after it finishes.');
      await delay(500);
    }
  }
  try {
    const previous=await readFile(path,'utf8').catch(error=>{if(error.code!=='ENOENT')throw error;return null;});
    const config=previous===null?{}:JSON.parse(previous);
    // A failed free-model check still writes the bootstrap instructions and memory permissions: the wrapper
    // starts OpenCode anyway, and without them the first task stops at "Access external directory".
    // No model is saved, so the next launch checks again.
    let model=null,failure=null;
    if(!config.model)try{model=await selectWorkingFreeModel({env});}catch(error){failure=error;}
    const next=withBootstrap(model?{...config,model:model.id}:config,{tmpdir:env.TMPDIR});
    if(JSON.stringify(next)!==JSON.stringify(config)) {
      const current=await readFile(path,'utf8').catch(error=>{if(error.code!=='ENOENT')throw error;return null;});
      if(current!==previous)throw new Error('OpenCode configuration changed during discovery. Retry to preserve your settings.');
      await writeFile(path,JSON.stringify(next,null,2),{mode:0o600,flag:previous===null?'wx':'w'});
      if(model) {
        const memory='/var/lib/spaceapp/memory';await mkdir(memory,{recursive:true});
        await writeFile(join(memory,'installation-model.json'),JSON.stringify(model,null,2),{mode:0o600});
      }
    }
    if(failure)throw failure;
  } finally { await rm(lock,{recursive:true,force:true}); }
}
if(process.argv[1]===fileURLToPath(import.meta.url)) configureFirstRun().catch(e=>{process.stderr.write(e.message+'\n');process.exitCode=1;});
