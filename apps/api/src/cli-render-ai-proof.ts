import {mkdir,writeFile,rm,realpath,lstat} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {SpaceConflictError,type SpaceStore} from '@space/runtime';
import type {Pane} from '@space/contracts';
import type {RoomPaneObservation} from './room-pane-control.js';
export const cliRenderAiDescription='Bounded real AI render fixture. [CLI_RENDER_AI:v1]';
export const cliRenderAiPrompt='SPACE_RENDER_AI_V1. Work only on this synthetic task. Do not use tools, inspect files, access the network, spawn agents, or modify anything. Write a numbered technical walkthrough of an imaginary in-memory key/value store, using plain text, Greek/CJK/combining Unicode examples and code blocks. Aim for 6000 words, stop after this one response, and finish with SPACE_RENDER_AI_COMPLETE. This is a bounded terminal rendering test; do not continue automatically.';
const dir=(root:string,roomId:string)=>{if(!/^room:[A-Za-z0-9_-]{6,80}$/.test(roomId))throw new SpaceConflictError('Invalid fixture room.');return join(resolve(root),'cli-render-fixtures',roomId.replace(':','_'));};
export async function createCliRenderAiRepository(root:string,roomId:string) {
  const cwd=dir(root,roomId);await mkdir(cwd,{recursive:true,mode:0o755});
  // A minimal synthetic Git repository with no operator content, credentials or remotes.
  await mkdir(join(cwd,'.git','objects'),{recursive:true});await mkdir(join(cwd,'.git','refs','heads'),{recursive:true});
  await writeFile(join(cwd,'.git','HEAD'),'ref: refs/heads/main\n',{flag:'wx',mode:0o644});
  await writeFile(join(cwd,'.git','config'),'[core]\n\trepositoryformatversion = 0\n\tbare = false\n',{flag:'wx',mode:0o644});
  await writeFile(join(cwd,'README.md'),'Synthetic CLI render fixture. No application or operator data.\n',{flag:'wx',mode:0o644});
  return cwd;
}
export async function cleanupCliRenderAiRepository(root:string,roomId:string) {
  const cwd=dir(root,roomId);
  try {const info=await lstat(cwd);if(info.isSymbolicLink()||await realpath(cwd)!==cwd)throw Error('Fixture path changed.');await rm(cwd,{recursive:true});}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
}
/** One fixed turn only. An API restart loses authorization instead of replaying it. */
export function createCliRenderAiController(options:{store:SpaceStore;root:string;inspect:(pane:Pane)=>Promise<RoomPaneObservation>;quota:(pane:Pane)=>Promise<{allowed:boolean}>;send:(pane:Pane,prompt:string,traceId:string)=>Promise<unknown>;interrupt:(pane:Pane)=>Promise<unknown>}) {
  const jobs=new Map<string,{paneId:string;sessionId:string;startedAt:number;timer:ReturnType<typeof setTimeout>;submitted:unknown;expired:boolean;busy:boolean}>();
  async function pane(roomId:string){const room=await options.store.getRoom(roomId),panes=await options.store.listPanes(roomId);if(room.kind!=='AGENT_PROOF'||room.description!==cliRenderAiDescription||panes.length!==1||panes[0]!.cwd!==dir(options.root,roomId))throw new SpaceConflictError('AI proof scope changed.');return panes[0]!;}
  return {
    async start(roomId:string,traceId:string){
      const p=await pane(roomId);if(jobs.has(roomId))return {submitted:false,reason:'ALREADY_SUBMITTED',manifest:{maxTurns:1,maxDurationMs:150000}};
      if(jobs.size>=8)throw new SpaceConflictError('AI proof capacity reached; close owned fixtures.');
      const session=await options.store.getActivePaneCliSession(p.id);if(!session)throw new SpaceConflictError('AI proof session is unavailable.');
      if(!(await options.quota(p)).allowed)throw new SpaceConflictError('The configured native quota does not permit this proof.');
      if(jobs.has(roomId))throw new SpaceConflictError("AI proof already submitted.");
      const job={paneId:p.id,sessionId:session.sessionId,startedAt:Date.now(),timer:undefined as unknown as ReturnType<typeof setTimeout>,submitted:null as unknown,expired:false,busy:true};
      jobs.set(roomId,job);
      job.timer=setTimeout(()=>{job.expired=true;void (async()=>{const active=await options.store.getActivePaneCliSession(p.id);if(active?.sessionId===job.sessionId)await options.interrupt(p);})().catch(()=>{});},150000);job.timer.unref();
      try{job.submitted=await options.send(p,cliRenderAiPrompt,traceId);return {submitted:true,sessionId:session.sessionId,modelId:session.modelId,runtimeId:session.runtimeId,manifest:{maxTurns:1,maxDurationMs:150000,quota:'EXISTING_NATIVE_QUOTA',costCap:'NO_OVERRIDE',requestedWords:6000}};}
      finally{job.busy=false;}
    },
    async state(roomId:string){const p=await pane(roomId),job=jobs.get(roomId);if(!job)return {status:'UNAVAILABLE',reason:'NO_OWNED_SUBMISSION'};
      const session=await options.store.getActivePaneCliSession(p.id);if(session?.sessionId!==job.sessionId)return {status:'UNAVAILABLE',reason:'SESSION_CHANGED'};
      const observed=await options.inspect(p);
      const tasks=observed.tasks.filter(t=>t.timing.source==='NATIVE'&&Date.parse(t.timing.startedAt??'')>=job.startedAt-1000).map(t=>({taskId:t.taskId,status:t.status,timing:t.timing,modelsUsed:t.modelsUsed}));
      const completed=tasks.some(t=>t.status==='COMPLETED');if(completed)clearTimeout(job.timer);
      return {status:job.expired?'INCOMPLETE':completed?'COMPLETED':'RUNNING',sessionId:job.sessionId,nativeTaskRef:observed.nativeTaskRef,tasks,submitted:!job.busy&&job.submitted!==null,
        responseObserved:observed.text?.includes('SPACE_RENDER_AI_COMPLETE')??false,
        usage:{inputTokens:null,outputTokens:null,reasoningTokens:null,totalTokens:null,source:'UNAVAILABLE'},
        output50k:{status:'INCOMPLETE',reason:'VERIFIED_OUTPUT_TOKEN_COUNTER_UNAVAILABLE'}};
    },
    dispose(roomId:string){const job=jobs.get(roomId);if(job){clearTimeout(job.timer);jobs.delete(roomId);}},
    async close(){
      const owned=[...jobs.entries()];for(const [,job] of owned)clearTimeout(job.timer);jobs.clear();
      await Promise.allSettled(owned.map(async([roomId,job])=>{const p=await pane(roomId);const session=await options.store.getActivePaneCliSession(p.id);if(session?.sessionId===job.sessionId)await options.interrupt(p);}));
    }
  };
}
