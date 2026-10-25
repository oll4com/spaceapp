import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { InMemorySpaceStore, PlanExecutionConflictError } from '@space/runtime';
import type { CodexAppServerSocketControlService, CodexNativeThread } from '@space/codex-app-server';
import { registerPlanExecutionRoutes } from '../src/plan-execution-routes.js';
import { PlanExecutionController } from '../src/plan-execution-controller.js';
const cleanup: Array<()=>Promise<void>>=[];
afterEach(async()=>{for(const close of cleanup.splice(0)) await close();});
async function fixture() {
 const store=new InMemorySpaceStore();const user={id:'user:owner',email:'owner@example.test',displayName:'Owner',role:'ADMIN' as const};await store.upsertUser(user);
 const stages=[{id:'one',order:1,title:'First',modelId:'model-a',reasoningEffort:'high',instructions:'Work',completionCriteria:['tested']},{id:'two',order:2,title:'Second',modelId:'model-b',reasoningEffort:'low',instructions:'Work next',completionCriteria:['tested']}];
 const plan=store.upsertClipboardItem({ownerUserId:user.id,source:'PLAN',minimumModel:'model-a',text:'Plan',steps:stages});
 const execution=await store.planExecutions.create({ownerUserId:user.id,planId:plan.id,paneId:'pane',sessionId:'session',threadId:'thread',cwd:'/project',requestId:'request',snapshot:{text:'Plan',title:null,stages}},true);
 const thread:CodexNativeThread={id:'thread',cwd:'/project',modelId:'old',reasoningEffort:'low',status:'idle',activeFlags:[],turns:[]};
 const sends:Parameters<CodexAppServerSocketControlService['startTurn']>[0][]=[];const interrupts:string[]=[];let settingsWrites=0;let notified=true;let authorized=true;let terminal=true;let scope:string|undefined;let session='session';
 const control:CodexAppServerSocketControlService={
  listModels:async()=>['model-a','model-b','model-c'].map(id=>({id,displayName:id,isDefault:false,defaultReasoningEffort:'high',supportedReasoningEfforts:['high','low']})),
  readThread:async()=>structuredClone(thread),readThreadSettings:async()=>({...thread,isTurnActive:thread.status==='active'}),
  updateThreadSettings:async input=>{await input.beforeSend?.();settingsWrites++;thread.modelId=input.model;thread.reasoningEffort=input.reasoningEffort;},
  interruptTurn:async input=>{await input.beforeSend?.();const e=(await read())!;expect(e.interruptReason).not.toBeNull();expect(e.interruptCommand).toMatchObject({type:'INTERRUPT',turnId:input.turnId});interrupts.push(input.turnId);},
  startTurn:async input=>{await input.beforeSend?.();sends.push(input);const id=`turn-${sends.length}`;thread.turns.push({id,status:'inProgress',clientUserMessageIds:[input.clientUserMessageId],userMessageCount:1,itemsComplete:true,resultText:null});thread.status='active';return {turnId:id,status:'inProgress'};}
 };
 control.startManagedTurn=async input=>{const response=await control.startTurn(input);return {...response,observation:{close:()=>{},read:()=>notified&&thread.turns.find(t=>t.id===response.turnId)!.status!=='inProgress'?{status:'VERIFIED',selection:{source:'NATIVE_ACCEPTED_TURN_CONFIGURATION',threadId:'thread',turnId:response.turnId,commandId:input.clientUserMessageId,modelId:input.model!,reasoningEffort:input.reasoningEffort!,observedAt:new Date().toISOString(),completedAt:new Date().toISOString(),transport:'CONTINUOUS_NATIVE_NOTIFICATIONS',providerTelemetry:false}}:{status:'OBSERVING',selection:null}}};};
 const resolve=async()=>{if(!authorized||session!=='session')throw Error('private credential failure');return control;};
 const app=Fastify();app.addHook('preHandler',async r=>{r.user={...user,proofScope:scope as 'READ_ONLY'};});
 let controller=registerPlanExecutionRoutes(app,{store,resolve,publish:async()=>{},intervalMs:600000,target:async()=>({paneId:'pane',sessionId:session,threadId:'thread',cwd:'/project'}),assertStartControl:async()=>{if(!terminal)throw Error('private terminal failure');}});
 cleanup.push(()=>app.close());
 const read=()=>store.planExecutions.get(user.id,execution.id);
 const override=async(model:string|null,stage='one',revision?:number)=>app.inject({method:'PATCH',url:`/api/plan-executions/${execution.id}/stages/${stage}/override`,payload:{selection:model?{modelId:model,reasoningEffort:'high'}:null,revision:revision??(await read())!.revision}});
 const action=async(action:'pause'|'resume',revision?:number)=>app.inject({method:'POST',url:`/api/plan-executions/${execution.id}/control`,payload:{action,revision:revision??(await read())!.revision}});
 const closeTurn=(status:'completed'|'interrupted'|'failed'='interrupted')=>{thread.status='idle';Object.assign(thread.turns.at(-1)!,{status,resultText:status==='completed'?JSON.stringify({outcome:'COMPLETED',summary:'tested checkpoint',evidence:[{criterion:'tested',result:'pass'}]}):null});};
 return {store,execution,plan,thread,control,sends,interrupts,read,override,action,closeTurn,tick:()=>controller.tick(),get settingsWrites(){return settingsWrites;},setNotified:(v:boolean)=>notified=v,setAuthorized:(v:boolean)=>authorized=v,setTerminal:(v:boolean)=>terminal=v,setScope:(v:string|undefined)=>scope=v,setSession:(v:string)=>session=v,restart:async()=>{await controller.close();controller=new PlanExecutionController({repository:store.planExecutions,resolve,publish:async()=>{}});cleanup.push(()=>controller.close());}};
}
describe('Stage3 controlled overrides and recovery',()=>{
 it('persists exact interrupt intent, waits for closure evidence, and resumes latest choice in same stage',async()=>{
  const f=await fixture();await f.tick();expect((await f.override('model-b')).statusCode).toBe(200);await f.tick();expect(f.interrupts).toEqual(['turn-1']);expect(f.sends).toHaveLength(1);
  expect((await f.override('model-c')).statusCode).toBe(200);f.setNotified(false);f.closeTurn();await f.tick();expect(f.sends).toHaveLength(1);expect((await f.read())!.pendingCommand?.type).toBe('START');
  expect((await f.read())!.interruptReason).toBe('OVERRIDE');expect((await f.read())!.interruptCommand?.turnId).toBe('turn-1');f.setNotified(true);await f.tick();await f.tick();expect(f.sends.map(s=>s.model),JSON.stringify(await f.read())).toEqual(['model-a','model-c']);expect(f.sends[1]!.prompt).toMatch(/partial/i);
  expect((await f.read())!.attempts[0]).toMatchObject({status:'INTERRUPTED',actualSelection:{turnId:'turn-1',modelId:'model-a'}});
  f.closeTurn('completed');await f.tick();await f.tick();expect(f.sends[2]).toMatchObject({model:'model-b',reasoningEffort:'low'});
 });
 it('CAS rejects stale rapid choices, validates before persistence, and resets to planned selection',async()=>{
  const f=await fixture();await f.tick();const revision=(await f.read())!.revision;
  expect((await f.override('model-b','one',revision)).statusCode).toBe(200);expect((await f.override('model-c','one',revision)).statusCode).toBe(409);
  const before=await f.read();expect((await f.override('missing')).statusCode).toBe(409);expect(await f.read()).toEqual(before);
  expect((await f.override(null)).statusCode).toBe(200);await f.tick();f.closeTurn();await f.tick();await f.tick();expect(f.sends[1]?.model).toBe('model-a');
 });
 it('future override never interrupts active turn and completion race never leaks into successor',async()=>{
  const f=await fixture();await f.tick();expect((await f.override('model-c','two')).statusCode).toBe(200);await f.tick();expect(f.interrupts).toEqual([]);
  f.closeTurn('completed');expect((await f.override('model-b')).statusCode).toBe(200);await f.tick();await f.tick();expect(f.sends[1]?.model).toBe('model-c');expect(f.interrupts).toEqual([]);
  expect((await f.override(null)).statusCode).toBe(409);
 });
 it('pause closes evidence before PAUSED; restart stays idle and explicit resume uses a fresh command',async()=>{
  const f=await fixture();await f.tick();await f.override('model-c');await f.tick();f.closeTurn();await f.tick();await f.tick();
  expect((await f.action('pause')).statusCode).toBe(200);await f.tick();f.closeTurn();await f.tick();const paused=(await f.read())!;expect(paused).toMatchObject({status:'PAUSED',pendingCommand:null,interruptCommand:null});expect(paused.attempts[1]!.actualSelection?.turnId).toBe('turn-2');
  await f.restart();await f.tick();expect((await f.read())!.commands).toEqual(paused.commands);expect(f.sends).toHaveLength(2);
  expect((await f.action('resume')).statusCode).toBe(200);await f.tick();expect(f.sends[2]).toMatchObject({model:'model-c'});expect(f.sends[2]!.clientUserMessageId).not.toBe(f.sends[1]!.clientUserMessageId);
 });
 it('external interruption pauses even with no explicit control and approval waits resume only with actual input',async()=>{
  const f=await fixture();await f.tick();f.thread.activeFlags=['waitingOnUserInput'];await f.tick();expect((await f.read())!.status).toBe('WAITING_FOR_INPUT');await f.tick();expect(f.sends).toHaveLength(1);
  f.thread.activeFlags=[];await f.tick();expect((await f.read())!.status).toBe('RUNNING');f.closeTurn();await f.tick();await f.tick();expect((await f.read())!.status).toBe('PAUSED');expect(f.sends).toHaveLength(1);
 });
 it.each(['scope','role','session','cwd','terminal'])('rejects %s loss with no control mutation',async fault=>{
  const f=await fixture();await f.tick();const before=await f.read();
  if(fault==='scope')f.setScope('READ_ONLY');if(fault==='role')await f.store.upsertUser({id:'user:owner',email:'owner@example.test',displayName:'Owner',role:'USER'});if(fault==='session')f.setSession('other');if(fault==='cwd')f.thread.cwd='/other';if(fault==='terminal')f.setTerminal(false);
  expect((await f.override('model-c')).statusCode).toBeGreaterThanOrEqual(400);expect((await f.action('pause')).statusCode).toBeGreaterThanOrEqual(400);expect(await f.read()).toEqual(before);expect(f.interrupts).toEqual([]);
 });
 it('recovers settings intent idempotently after restart without repeating confirmed settings',async()=>{
  const f=await fixture();const e=(await f.read())!;f.thread.modelId='model-a';f.thread.reasoningEffort='high';
  await f.store.planExecutions.update(e.ownerUserId,e.id,e.revision,{pendingCommand:{id:'settings',type:'SETTINGS',stageId:'one',turnId:null,selection:{modelId:'model-a',reasoningEffort:'high'},preparedAt:new Date().toISOString(),status:'UNKNOWN',baselineTurnIds:[]}});
  await f.restart();await f.tick();expect(f.sends).toHaveLength(1);expect(f.settingsWrites).toBe(0);
 });
 it('never resends a durable START with ambiguous acceptance after restart',async()=>{
  const f=await fixture();await f.tick();f.thread.turns=[];f.thread.status='idle';await f.restart();await f.tick();expect((await f.read())!.status).toBe('BLOCKED');expect((await f.action('resume')).statusCode).toBe(409);await f.tick();expect(f.sends).toHaveLength(1);
 });
 it('retries unavailable catalog with bounded persisted backoff and no early sends',async()=>{
  const f=await fixture();const models=f.control.listModels;f.control.listModels=async()=>[];await f.tick();let e=(await f.read())!;expect(e.status).toBe('WAITING_FOR_MODEL');expect(Date.parse(e.nextRetryAt!)).toBeGreaterThan(Date.now());await f.tick();expect((await f.read())!.retryCount).toBe(1);
  for(let i=0;i<9;i++){e=(await f.read())!;await f.store.planExecutions.update(e.ownerUserId,e.id,e.revision,{nextRetryAt:new Date(0).toISOString()});await f.tick();}e=(await f.read())!;expect(Date.parse(e.nextRetryAt!)-Date.now()).toBeLessThanOrEqual(300000);
  f.control.listModels=models;await f.store.planExecutions.update(e.ownerUserId,e.id,e.revision,{nextRetryAt:new Date(0).toISOString()});await f.restart();await f.tick();expect(f.sends).toHaveLength(1);
 });
});

it('late closure and revision CAS preserve a newer override and its still-valid evidence',async()=>{
 const f=await fixture();await f.tick();f.closeTurn('completed');const update=f.store.planExecutions.update.bind(f.store.planExecutions);let raced=false;
 f.store.planExecutions.update=async(...args)=>{if(!raced&&args[3].attempts){raced=true;expect((await f.override('model-c')).statusCode).toBe(200);}return update(...args);};
 await f.tick();expect((await f.read())!.overrides.one?.modelId).toBe('model-c');await f.tick();expect((await f.read())!.completedStageIds).toEqual(['one']);await f.tick();expect(f.sends[1]?.model).toBe('model-b');
});
it('late interrupt handshake cannot defeat pause or expired lease',async()=>{
 for(const fault of ['pause','lease']){const f=await fixture();await f.tick();await f.override('model-c');
 f.control.interruptTurn=async input=>{if(fault==='pause')await f.action('pause');else{const e=(await f.read())!;await f.store.planExecutions.release(e.id,e.lease!);await f.store.planExecutions.claim(e.id,'replacement',Date.now(),60000);}await input.beforeSend?.();f.interrupts.push(input.turnId);};
 await f.tick();expect(f.interrupts).toEqual([]);expect(f.sends).toHaveLength(1);if(fault==='pause')expect((await f.read())!.interruptReason).toBe('PAUSE');}
});
it('restart with active interrupt intent never invents closed evidence or resends START',async()=>{
 const f=await fixture();await f.tick();await f.override('model-c');await f.restart();await f.tick();expect(f.interrupts).toEqual(['turn-1']);f.closeTurn();await f.tick();expect((await f.read())!.status).toBe('BLOCKED');expect(f.sends).toHaveLength(1);expect((await f.read())!.attempts[0]!.actualSelection).toBeNull();
});
it('model-rejected native failure keeps checkpoint and retries only the closed attempt',async()=>{
 const f=await fixture();await f.tick();f.closeTurn('failed');Object.assign(f.thread.turns[0]!,{retryableFailure:{retryAfterMs:45000}});await f.tick();let e=(await f.read())!;
 expect(e.status).toBe('WAITING_FOR_MODEL');expect(e.pendingCommand).toBeNull();expect(e.attempts[0]).toMatchObject({status:'FAILED',actualSelection:{turnId:'turn-1'}});expect(Date.parse(e.nextRetryAt!)-Date.now()).toBeGreaterThan(43000);
 await f.tick();expect(f.sends).toHaveLength(1);await f.store.planExecutions.update(e.ownerUserId,e.id,e.revision,{nextRetryAt:new Date(0).toISOString()});await f.tick();expect(f.sends).toHaveLength(2);
});
it('known settings-send timeout reconciles applied settings without repeating them',async()=>{
 const f=await fixture();const write=f.control.updateThreadSettings;f.control.updateThreadSettings=async input=>{await write(input);throw Error('timeout after native setting');};
 await f.tick();await f.restart();await f.tick();expect(f.sends).toHaveLength(1);expect(f.settingsWrites).toBe(1);
});
it('known rejected sends back off, but acceptance timeouts never acquire retry permission',async()=>{
 const {CodexManagedTurnDeliveryError}=await import('@space/codex-app-server');
 const f=await fixture();f.control.startManagedTurn=async()=>{throw new CodexManagedTurnDeliveryError('REJECTED',{retryAfterMs:20000});};await f.tick();const e=(await f.read())!;
 expect(e).toMatchObject({status:'WAITING_FOR_MODEL',pendingCommand:null});expect(e.attempts[0]!.status).toBe('FAILED');expect(Date.parse(e.nextRetryAt!)-Date.now()).toBeGreaterThan(18000);
 const g=await fixture();g.control.startManagedTurn=async()=>{throw new CodexManagedTurnDeliveryError('UNKNOWN');};await g.tick();await g.restart();await g.tick();expect((await g.read())!.status).toBe('BLOCKED');expect((await g.read())!.pendingCommand).not.toBeNull();
});
it('a proven unsent START survives a simultaneous override without losing the latest choice',async()=>{
 const {CodexManagedTurnDeliveryError}=await import('@space/codex-app-server');const f=await fixture();const start=f.control.startManagedTurn!;let once=true;
 f.control.startManagedTurn=async input=>{if(once){once=false;await f.override('model-c');try{await input.beforeSend?.();}catch{throw new CodexManagedTurnDeliveryError('NOT_SENT');}}return start(input);};
 await f.tick();await f.tick();await f.tick();expect(f.sends.map(s=>s.model)).toEqual(['model-c']);expect((await f.read())!.overrides.one?.modelId).toBe('model-c');
});
it('repeated finished model failures increase backoff across accepted attempts',async()=>{
 const f=await fixture();await f.tick();f.closeTurn('failed');Object.assign(f.thread.turns[0]!,{retryableFailure:{}});await f.tick();let e=(await f.read())!;expect(e.retryCount).toBe(1);
 await f.store.planExecutions.update(e.ownerUserId,e.id,e.revision,{nextRetryAt:new Date(0).toISOString()});await f.tick();f.closeTurn('failed');Object.assign(f.thread.turns[1]!,{retryableFailure:{}});await f.tick();e=(await f.read())!;expect(e.retryCount).toBe(2);
});

it.each(['settings-intent','settings-confirmed','start-intent','accepted-start','closed-evidence'])('restart reconciliation at %s checkpoint',async boundary=>{
 const f=await fixture();const update=f.store.planExecutions.update.bind(f.store.planExecutions);let crashed=false;
 f.store.planExecutions.update=async(...args)=>{
  const patch=args[3];const result=await update(...args);
  if(!crashed && (boundary==='settings-intent'&&patch.pendingCommand?.type==='SETTINGS'&&patch.pendingCommand.status==='PREPARED'||
    boundary==='settings-confirmed'&&patch.pendingCommand?.type==='SETTINGS'&&patch.pendingCommand.status==='SENT'||
    boundary==='start-intent'&&patch.pendingCommand?.type==='START'&&!patch.pendingCommand.turnId||
    boundary==='accepted-start'&&patch.pendingCommand?.type==='START'&&Boolean(patch.pendingCommand.turnId)||
    boundary==='closed-evidence'&&patch.attempts?.some(a=>a.actualSelection))) {crashed=true;throw new PlanExecutionConflictError('simulated process loss after durable write');}
  return result;
 };
 await f.tick();if(boundary==='closed-evidence'){f.closeTurn('completed');await f.tick();}
 expect(crashed).toBe(true);await f.restart();await f.tick();
 if(boundary.startsWith('settings-'))expect(f.sends).toHaveLength(1);
 if(boundary==='start-intent'){expect(f.sends).toHaveLength(0);expect((await f.read())!.status).toBe('BLOCKED');}
 if(boundary==='accepted-start'){f.closeTurn('completed');await f.tick();expect(f.sends).toHaveLength(1);expect((await f.read())!.status).toBe('BLOCKED');}
 if(boundary==='closed-evidence'){expect((await f.read())!.completedStageIds).toEqual(['one']);await f.tick();expect(f.sends[1]?.model).toBe('model-b');}
});
it('an unacknowledged interrupt does not turn an external Stop into automatic continuation',async()=>{
 const f=await fixture();await f.tick();await f.override('model-c');f.control.interruptTurn=async input=>{await input.beforeSend?.();throw Error('interrupt transport ambiguous');};await f.tick();f.closeTurn();await f.tick();expect((await f.read())!.status).toBe('PAUSED');expect(f.sends).toHaveLength(1);
});
it('honors explicit Retry-After beyond the exponential backoff ceiling',async()=>{
 const f=await fixture();await f.tick();f.closeTurn('failed');Object.assign(f.thread.turns[0]!,{retryableFailure:{retryAfterMs:600000}});await f.tick();expect(Date.parse((await f.read())!.nextRetryAt!)-Date.now()).toBeGreaterThan(590000);
});
it('sanitizes status-bearing runtime errors at mutation routes',async()=>{
 const f=await fixture();f.control.listModels=async()=>{throw Object.assign(Error('private runtime token'),{statusCode:429});};const before=await f.read();const response=await f.override('model-c');expect(response.statusCode).toBeGreaterThanOrEqual(400);expect(response.body).not.toContain('private runtime token');expect(await f.read()).toEqual(before);
});
it('explains restart uncertainty without exposing runtime text or suggesting an unsafe resend',async()=>{
 const f=await fixture();await f.tick();await f.restart();f.closeTurn('completed');await f.tick();expect((await f.read())!.statusReason).toMatch(/observation|configuration/i);expect((await f.read())!.statusReason).toMatch(/not be resent/i);
});
it('completion that wins during override validation rejects the stale choice without successor leakage',async()=>{
 const f=await fixture();await f.tick();f.closeTurn('completed');const models=f.control.listModels;f.control.listModels=async()=>{await f.tick();return models();};
 const response=await f.override('model-c');expect(response.statusCode).toBe(409);expect((await f.read())!.overrides).toEqual({});f.control.listModels=models;await f.tick();expect(f.sends[1]?.model).toBe('model-b');
});
it.each(['override','pause'])('retains exact interrupt acknowledgment across a concurrent %s',async choice=>{
 const f=await fixture();await f.tick();await f.override('model-b');
 const interrupt=f.control.interruptTurn;
 f.control.interruptTurn=async input=>{
  await interrupt(input);f.closeTurn();
  expect((await (choice==='override'?f.override('model-c'):f.action('pause'))).statusCode).toBe(200);
 };
 await f.tick();await f.tick();await f.tick();
 expect((await f.read())!.attempts[0]!.actualSelection?.turnId).toBe('turn-1');
 if(choice==='override')expect(f.sends.map(s=>s.model)).toEqual(['model-a','model-c']);
 else {expect((await f.read())!.status).toBe('PAUSED');expect(f.sends).toHaveLength(1);}
 expect(f.interrupts).toEqual(['turn-1']);
});
it('paces advertised-but-rejected SETTINGS using native Retry-After without an early second write',async()=>{
 const {CodexSettingsRejectedError}=await import('@space/codex-app-server');const f=await fixture();let writes=0;
 f.control.updateThreadSettings=async input=>{await input.beforeSend?.();writes++;throw new CodexSettingsRejectedError({retryAfterMs:60000});};
 await f.tick();let e=(await f.read())!;expect(e.status).toBe('WAITING_FOR_MODEL');expect(e.retryCount).toBe(1);expect(Date.parse(e.nextRetryAt!)-Date.now()).toBeGreaterThan(58000);expect(e.pendingCommand?.type).toBe('SETTINGS');expect(e.attempts).toEqual([]);
 await f.tick();await f.restart();await f.tick();expect(writes).toBe(1);expect(f.sends).toEqual([]);
 await f.store.planExecutions.update(e.ownerUserId,e.id,e.revision,{nextRetryAt:new Date(0).toISOString()});await f.tick();e=(await f.read())!;expect(writes).toBe(2);expect(e.retryCount).toBe(2);expect(e.commands).toHaveLength(1);expect(e.statusReason).not.toContain('private');
});
it('backs off unknown unapplied SETTINGS only after readback; applied settings remain idempotent',async()=>{
 const f=await fixture();let writes=0;f.control.updateThreadSettings=async input=>{await input.beforeSend?.();writes++;throw Error('private timeout');};
 await f.tick();expect((await f.read())!.pendingCommand?.status).toBe('UNKNOWN');await f.tick();const e=(await f.read())!;
 expect(writes).toBe(1);expect(e.status).toBe('WAITING_FOR_MODEL');expect(e.retryCount).toBe(1);expect(f.sends).toEqual([]);
 await f.tick();expect(writes).toBe(1);
});
it('recovers a nonretryable SETTINGS rejection through a new override and Resume without losing checkpoint or history',async()=>{
 const {CodexSettingsRejectedError}=await import('@space/codex-app-server');const f=await fixture();
 const initial=(await f.read())!;await f.store.planExecutions.update(initial.ownerUserId,initial.id,initial.revision,{checkpoint:'Previously verified work'});
 const updateSettings=f.control.updateThreadSettings;
 f.control.updateThreadSettings=async input=>{await input.beforeSend?.();throw new CodexSettingsRejectedError();};
 await f.tick();const blocked=(await f.read())!;expect(blocked.status).toBe('BLOCKED');expect(blocked.commands).toHaveLength(1);const rejected=blocked.commands[0]!;
 expect(rejected).toMatchObject({type:'SETTINGS',selection:{modelId:'model-a'}});expect(f.sends).toEqual([]);
 expect((await f.override('model-c')).statusCode).toBe(200);expect((await f.action('resume')).statusCode).toBe(200);
 f.control.updateThreadSettings=updateSettings;await f.tick();const resumed=(await f.read())!;
 expect(f.sends).toHaveLength(1);expect(f.sends[0]).toMatchObject({model:'model-c',reasoningEffort:'high'});expect(f.sends[0]!.prompt).toContain('Previously verified work');
 expect(resumed.checkpoint).toBe('Previously verified work');expect(resumed.commands.find(c=>c.id===rejected.id)).toEqual(rejected);
 const freshSettings=resumed.commands.filter(c=>c.type==='SETTINGS'&&c.id!==rejected.id);expect(freshSettings).toHaveLength(1);expect(freshSettings[0]!.selection.modelId).toBe('model-c');
 expect(resumed.pendingCommand).toMatchObject({type:'START',selection:{modelId:'model-c'}});expect(resumed.status).toBe('RUNNING');
});
