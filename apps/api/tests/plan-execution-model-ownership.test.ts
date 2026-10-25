import Fastify from 'fastify';
import { afterEach, expect, it } from 'vitest';
import { InMemorySpaceStore } from '@space/runtime';
import * as mutations from '../src/plan-execution-mutations.js';
import { registerPlanExecutionRoutes } from '../src/plan-execution-routes.js';
const cleanups:Array<()=>Promise<void>>=[];
afterEach(async()=>{for(const cleanup of cleanups.splice(0))await cleanup();});
function deferred(){let resolve!:()=>void;const promise=new Promise<void>(r=>resolve=r);return {promise,resolve};}
async function fixture(){
 const store=new InMemorySpaceStore();const user={id:'user:owner',role:'ADMIN' as const,email:'owner@example.test',displayName:'Owner'};await store.upsertUser(user);
 const stages=[{id:'one',order:1,title:'First',modelId:'model-a',reasoningEffort:'high',instructions:'Work',completionCriteria:['tested']}];
 const plan=store.upsertClipboardItem({ownerUserId:user.id,source:'PLAN',text:'Plan',minimumModel:'model-a',steps:stages});
 const target={paneId:'pane',sessionId:'session',threadId:'thread',cwd:'/project'};
 const app=Fastify();app.addHook('preHandler',async request=>{request.user=user;});
 registerPlanExecutionRoutes(app,{store,target:async()=>target,assertStartControl:async()=>{},resolve:async()=>{throw Error('scheduler must not run');},publish:async()=>{},intervalMs:600000});
 cleanups.push(()=>app.close());await app.ready();
 const start=()=>app.inject({method:'POST',url:'/api/panes/pane/plan-executions',payload:{planId:plan.id,expectedSessionId:'session',requestId:'start'}});
 const writes:string[]=[];
 const change=(overrides:Partial<Parameters<typeof mutations.applyUnmanagedCodexModelSettings<{threadId:string}>>[2]>={})=>mutations.applyUnmanagedCodexModelSettings(store,'pane',{
  inspect:async()=>({threadId:'thread'}),assertCurrent:async()=>{},
  updateSettings:async(_selection,beforeSend)=>{await beforeSend();writes.push('native');},
  updateRouter:async()=>{writes.push('router');},finish:async()=>{writes.push('confirmed');},...overrides
 });
 return {store,start,change,writes,user,plan,target};
}
it('rejects stale Room Agent settings and router writes when managed start wins during inspection',async()=>{
 const f=await fixture();const inspected=deferred(),release=deferred();
 const change=f.change({inspect:async()=>{inspected.resolve();await release.promise;return {threadId:'thread'};}});
 const result=change.then(()=>null,error=>error);
 await inspected.promise;expect((await f.start()).statusCode).toBe(201);release.resolve();
 expect(await result).toMatchObject({message:expect.stringMatching(/managed/i)});expect(f.writes).toEqual([]);
});
it('serializes managed start through both the settings handshake and asynchronous router mutation',async()=>{
 const f=await fixture();const handshake=deferred(),send=deferred(),router=deferred(),routerDone=deferred();
 const change=f.change({updateSettings:async(_s,beforeSend)=>{handshake.resolve();await send.promise;await beforeSend();f.writes.push('native');},updateRouter:async()=>{router.resolve();await routerDone.promise;f.writes.push('router');}});
 await handshake.promise;
 let started=false;const starting=f.start().then(response=>{started=true;return response;});
 try {
  await new Promise(r=>setTimeout(r,15));expect(started).toBe(false);expect(await f.store.planExecutions.listActive()).toEqual([]);
  send.resolve();await router.promise;expect(started).toBe(false);expect(await f.store.planExecutions.listActive()).toEqual([]);
 } finally {send.resolve();routerDone.resolve();}
 await change;expect((await starting).statusCode).toBe(201);expect(f.writes).toEqual(['native','router','confirmed']);
});
it('fences session/thread authority again at the actual settings send and releases ownership on failure',async()=>{
 const f=await fixture();let valid=true;
 await expect(f.change({assertCurrent:async()=>{if(!valid)throw Error('session changed');},updateSettings:async(_s,beforeSend)=>{valid=false;await beforeSend();f.writes.push('native');}})).rejects.toThrow('session changed');
 expect(f.writes).toEqual([]);expect((await f.start()).statusCode).toBe(201);
});
it('rechecks ownership before router write when native settings completed',async()=>{
 const f=await fixture();
 await expect(f.change({updateSettings:async(_s,beforeSend)=>{
  await beforeSend();f.writes.push('native');
  // A pre-existing out-of-band owner must also be rejected, independent of the shared HTTP start lock.
  await f.store.planExecutions.create({ownerUserId:f.user.id,planId:f.plan.id,...f.target,requestId:'external',snapshot:{text:'Plan',title:null,stages:[{id:'one',order:1,title:'First',modelId:'model-a',reasoningEffort:'high',instructions:'Work',completionCriteria:['tested']}]}});
 }})).rejects.toThrow(/managed/i);expect(f.writes).toEqual(['native']);
});
