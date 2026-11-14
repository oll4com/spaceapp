import Fastify from "fastify";
import { registerSpaceControlRoutes } from "../src/space-control-routes.js";
import { describe,it,expect,vi } from "vitest";
import { InMemorySpaceStore } from "@space/runtime";
import { InMemoryControlRepository } from "@space/db";
import { controlExecuteSchema } from "@space/contracts";
import { createSpaceControl } from "../src/space-control.js";
import { CliTaskNotResumableError } from "../src/unified-cli-task-registry.js";
const actor={id:"operator:one",role:"ADMIN" as const};
function fixture(){
 const store=new InMemorySpaceStore(),repository=new InMemoryControlRepository();
 const room=store.createRoom({name:"Control test",initialPaneCount:0,kind:"AGENT_PROOF"});
 const panes=store.createPanes(["C","A","B"].map(title=>({roomId:room.id,title,mode:"TERMINAL" as const,terminalRuntimeId:"cli:codex"})));
 const observation=(pane:any)=>({paneId:pane.id,title:pane.title,runtimeId:"cli:codex",sessionId:"session:one",state:"IDLE" as const,nativeTaskRef:"native:one",modelId:"test",nativeMode:"default",checkedAt:new Date().toISOString(),tasks:[]});
 const controller={catalog:vi.fn(async()=>({types:[],unavailable:[]})),inspect:vi.fn(async(p:any)=>observation(p)),configure:vi.fn(async()=>({})),command:vi.fn(async()=>({})),start:vi.fn(async()=>({})),resume:vi.fn(async()=>({})),interrupt:vi.fn(async()=>({}))};
 const send=vi.fn(async()=>({submitted:true}));
 const options={store,repository,controller,send,publish:vi.fn(async()=>{})};
 const service=createSpaceControl(options);
 const execute=(actions:unknown[],requestId="request:one",extra={})=>service.execute(actor,controlExecuteSchema.parse({roomId:room.id,requestId,actions,...extra}));
 return {store,repository,controller,send,options,service,room,panes,execute};
}
describe("Space control",()=>{
 it("passes the original HTTP request separately from the unchanged command idempotency id",async()=>{
  const c=fixture(), app=Fastify();
  app.addHook("onRequest",async request=>{request.user={id:actor.id,role:"ADMIN",email:"test@example.invalid"} as never;request.requestIdForSpace="req:http-original";});
  registerSpaceControlRoutes(app,c.service);
  try {
   const payload={roomId:c.room.id,requestId:"command:distinct",actions:[{kind:"pane",operation:"prompt",target:{paneIds:[c.panes[0]!.id]},text:"Fixed prompt",when:"NOW"}]};
   const response=await app.inject({method:"POST",url:"/api/control/v1/commands",payload});
   expect(response.statusCode).toBe(200);
   expect(response.json()).toMatchObject({requestId:"command:distinct",status:"COMPLETED",command:{requestId:"command:distinct"}});
   expect(c.send).toHaveBeenCalledWith(expect.objectContaining({id:c.panes[0]!.id}),"Fixed prompt","command:distinct","req:http-original");
   await app.inject({method:"POST",url:"/api/control/v1/commands",payload});
   expect(c.send).toHaveBeenCalledOnce();
  } finally {await app.close();}
 });
 it("OBS-006: a space_execute through the MCP endpoint passes its HTTP request id too",async()=>{
  const c=fixture(), app=Fastify();
  app.addHook("onRequest",async request=>{request.user={id:actor.id,role:"ADMIN",email:"test@example.invalid"} as never;request.requestIdForSpace="req:http-mcp";});
  registerSpaceControlRoutes(app,c.service);
  try {
   const command={roomId:c.room.id,requestId:"command:mcp",actions:[{kind:"pane",operation:"prompt",target:{paneIds:[c.panes[0]!.id]},text:"From an agent",when:"NOW"}]};
   const response=await app.inject({method:"POST",url:"/api/control/v1/mcp",payload:{jsonrpc:"2.0",id:1,method:"tools/call",params:{name:"space_execute",arguments:command}}});
   expect(response.statusCode).toBe(200);
   expect(response.json().error).toBeUndefined();
   expect(c.send).toHaveBeenCalledWith(expect.objectContaining({id:c.panes[0]!.id}),"From an agent","command:mcp","req:http-mcp");
  } finally {await app.close();}
 });

 it("OBS-006: a caller with no HTTP request (Space Autopilot, the Room Agent, Scheduled Tasks) names its command's own request id",async()=>{
  const c=fixture();
  await c.execute([{kind:"pane",operation:"prompt",target:{paneIds:[c.panes[0]!.id]},text:"From Autopilot",when:"NOW"}],"autopilot_cycle1");
  expect(c.send).toHaveBeenCalledWith(expect.objectContaining({id:c.panes[0]!.id}),"From Autopilot","autopilot_cycle1","autopilot_cycle1");
 });

 it("a prompt waiting for its CLI holds its pane's lock, not the room's: the operator's control of another pane goes on (R9-10)",async()=>{
  // 28/10: a Space Control prompt held room Bruno 30 s while its CLI took the text, and the operator's attach of Bob was aborted.
  const c=fixture();let taken!:()=>void;
  c.send.mockImplementation(async()=>{await new Promise<void>(resolve=>{taken=resolve;});return {submitted:true};});
  const prompting=c.execute([{kind:"pane",operation:"prompt",target:{paneIds:[c.panes[0]!.id]},text:"space-queue promote",when:"NOW"}],"request:prompt");
  await vi.waitFor(()=>expect(c.send).toHaveBeenCalledOnce());
  const control=vi.fn(async()=>"attached");
  expect(await c.service.withOperatorMutation(c.panes[1]!,control)).toBe("attached");
  // A second prompt to the same pane waits for the first: the pane's lock still orders its own prompts.
  const again=c.execute([{kind:"pane",operation:"prompt",target:{paneIds:[c.panes[0]!.id]},text:"status",when:"NOW"}],"request:again");
  await new Promise(resolve=>setTimeout(resolve,50));
  expect(c.send).toHaveBeenCalledOnce();
  taken();await prompting;
  await vi.waitFor(()=>expect(c.send).toHaveBeenCalledTimes(2));
  taken();await again;
 });
 it("the pane's watch tick goes on while a prompt to that pane waits for its CLI (R9-10, Alex/Emma 28/10 08:47 UTC)",async()=>{
  // Stable, before R9-10: Nous's prompt into busy Emma held room Alex 30 s and the watch tick of Emma's earlier prompt timed out (URGENT).
  const c=fixture(),pane=c.panes[0]!;
  await c.execute([{kind:"pane",operation:"prompt",target:{paneIds:[pane.id]},text:"First task"}]);
  let taken!:()=>void;
  c.send.mockImplementation(async()=>{await new Promise<void>(resolve=>{taken=resolve;});return {submitted:true};});
  const prompting=c.execute([{kind:"pane",operation:"prompt",target:{paneIds:[pane.id]},text:"Second task",when:"NOW"}],"request:held");
  await vi.waitFor(()=>expect(c.send).toHaveBeenCalledTimes(2));
  await c.service.tick();
  expect((await c.service.watches(actor,c.room.id,"list",{}) as any[]).some(w=>w.status==="RUNNING")).toBe(true);
  taken();await prompting;
 });
 it("a watch tick reads its pane before the room lock within a bound, and a slow pane stops no other watch (2/11 02:30 UTC)",async()=>{
  // Stable 2/11 02:30-02:55 UTC: watch ticks of busy Bruno/Leo, Alex/Hugo and Alex/Andy held their rooms 30 s each inside the pane
  // read (API event loop at 98 %), and each timeout ended the tick for every room.
  const c=fixture(),[slow,other,free]=c.panes as [any,any,any];
  await c.execute([{kind:"pane",operation:"prompt",target:{paneIds:[slow.id]},text:"Slow task"}],"request:slow");
  await c.execute([{kind:"pane",operation:"prompt",target:{paneIds:[other.id]},text:"Other task"}],"request:other");
  const base=await c.controller.inspect(other);
  let release!:(value:unknown)=>void;
  const hung=new Promise(resolve=>{release=resolve;});
  const running=(pane:any)=>({...base,paneId:pane.id,state:"RUNNING",tasks:[{taskId:`turn:${pane.title}`,title:pane.title,status:"RUNNING",timing:{source:"NATIVE",startedAt:new Date().toISOString(),completedAt:null,durationMs:null,observedAt:new Date().toISOString()},modelsUsed:[]}]});
  c.controller.inspect.mockImplementation(async(p:any)=>p.id===slow.id?hung as any:running(p));
  c.controller.inspect.mockClear();
  const service=createSpaceControl({...c.options,observeBudgetMs:50});
  const started=Date.now();
  await service.tick();
  expect(Date.now()-started).toBeLessThan(5_000);
  expect(await service.withOperatorMutation(free,async()=>"attached")).toBe("attached");
  const bound=async(pane:any)=>((await service.watches(actor,c.room.id,"list",{})) as any[]).find(w=>w.paneId===pane.id)?.targetTaskRef;
  expect(await bound(other)).toBe(`turn:${other.title}`);
  expect(await bound(slow)).toBeNull();
  // The next tick shares the read still running instead of stacking another on the busy pane.
  await service.tick();
  expect(c.controller.inspect.mock.calls.filter(([p])=>(p as any).id===slow.id)).toHaveLength(1);
  release(running(slow));
  await vi.waitFor(async()=>{await service.tick();expect(await bound(slow)).toBe(`turn:${slow.title}`);});
 });
 it("persists the exact watched native turn before another turn starts and notifies once",async()=>{
  const c=fixture(),pane=c.panes[0]!;
  await c.execute([{kind:"pane",operation:"prompt",target:{paneIds:[pane.id]},text:"First task"}]);
  const makeTask=(taskId:string,status:string)=>({taskId,title:taskId,status,timing:{source:"NATIVE",startedAt:new Date().toISOString(),completedAt:status==="COMPLETED"?new Date().toISOString():null,durationMs:null,observedAt:new Date().toISOString()},modelsUsed:[]});
  const base=await c.controller.inspect(pane);
  c.controller.inspect.mockResolvedValue({...base,state:"RUNNING",tasks:[makeTask("turn:first","RUNNING")]} as any);
  await c.service.tick();
  const bound=await c.service.watches(actor,c.room.id,"list",{}) as any[];
  expect(bound).toHaveLength(1);
  expect(bound[0]).toMatchObject({status:"RUNNING",targetTaskRef:"turn:first",submission:{turnId:"turn:first"}});
  // Reconstruct the service to prove the binding survives process state loss.
  const service=createSpaceControl(c.options);
  c.controller.inspect.mockResolvedValue({...base,state:"RUNNING",text:"Unrelated second task output",commands:["second command"],tasks:[makeTask("turn:first","COMPLETED"),makeTask("turn:second","RUNNING")]} as any);
  await service.tick();await service.tick();
  const pending=await service.pendingWatches(actor,c.room.id);
  expect(pending).toHaveLength(1);
  expect(pending[0]).toMatchObject({status:"VERIFIED",targetTaskRef:"turn:first",paneDetails:{nativeTaskRef:"turn:first",lastOutput:"",summary:"",commands:[]}});
  expect(pending[0]!.auditTrail.filter(x=>x.status==="VERIFIED")).toHaveLength(1);
  await service.watches(actor,c.room.id,"ack",{id:pending[0]!.id});
  expect(await service.pendingWatches(actor,c.room.id)).toEqual([]);
  expect(c.send).toHaveBeenCalledOnce();
 });
 it("confirms a stop on a fresh read and reads a scheduled prompt's id as its schedule (stable 2026-10-22)",async()=>{
  const c=fixture(),pane=c.panes[0]!;
  const base=await c.controller.inspect(pane);
  // The 15 s cached read still says RUNNING; only a fresh read sees the stopped turn.
  c.controller.inspect.mockImplementation(async(_p:any,freshness?:{fresh?:boolean})=>({...base,state:freshness?.fresh?"IDLE":"RUNNING"}) as any);
  const stopped=await c.execute([{kind:"pane",operation:"stop",target:{paneIds:[pane.id]}}],"stop-one");
  expect(stopped.results[0]).toMatchObject({status:"COMPLETED",detail:"Native execution stopped successfully."});
  c.controller.inspect.mockResolvedValue({...base,state:"RUNNING"} as any);
  const deferred=await c.execute([{kind:"pane",operation:"prompt",target:{paneIds:[pane.id]},text:"After the turn",when:"AFTER_TURN"}],"later-one");
  const scheduleId=(deferred.results[0]!.evidence as {scheduleId:string}).scheduleId;
  expect(scheduleId).toMatch(/^control_schedule:/);
  const read=await c.execute([{kind:"watch",operation:"status",id:scheduleId}],"read-one");
  expect(read.results[0]).toMatchObject({status:"COMPLETED",evidence:{result:{id:scheduleId,status:"SCHEDULED"}}});
 });
 it("reads a watch status with no id as the room's watches (12-13/11: 3 failed calls)",async()=>{
  const c=fixture(),pane=c.panes[0]!;
  const read=await c.execute([{kind:"watch",operation:"status",target:{paneIds:[pane.id]}}],"status-no-id");
  expect(read.results[0]).toMatchObject({status:"COMPLETED",evidence:{result:[]}});
  // 12/11 06:25: an unknown id names the room's watches.
  const unknown=await c.execute([{kind:"watch",operation:"status",id:"control_watch:gone",target:{paneIds:[pane.id]}}],"status-unknown");
  expect(JSON.stringify(unknown.results[0])).toContain("Watch not found: control_watch:gone. This room's watches: none (status with no id lists them).");
 });
 it("an omp stop whose first Escape ended only a pty:true command interrupts once more and confirms the turn's end (step 9, 3/11)",async()=>{
  const c=fixture(),pane=c.panes[0]!;
  const base={...await c.controller.inspect(pane),runtimeId:"cli:omp"};
  // omp's session says the turn goes on until the second interrupt.
  c.controller.inspect.mockImplementation(async()=>({...base,state:c.controller.interrupt.mock.calls.length<2?"RUNNING":"IDLE"}) as never);
  const stopped=await c.service.execute(actor,controlExecuteSchema.parse({roomId:c.room.id,requestId:"stop-omp",actions:[{kind:"pane",operation:"stop",target:{paneIds:[pane.id]},when:"NOW"}]}),true);
  expect(c.controller.interrupt).toHaveBeenCalledTimes(2);
  expect(stopped.results[0]).toMatchObject({status:"COMPLETED",detail:"Native execution stopped successfully."});
  // A turn that goes on after both is never reported stopped.
  c.controller.interrupt.mockClear();c.controller.inspect.mockResolvedValue({...base,state:"RUNNING"} as never);
  const going=await c.service.execute(actor,controlExecuteSchema.parse({roomId:c.room.id,requestId:"stop-omp-2",actions:[{kind:"pane",operation:"stop",target:{paneIds:[pane.id]},when:"NOW"}]}),true);
  expect(c.controller.interrupt).toHaveBeenCalledTimes(2);
  expect(going.results[0]).toMatchObject({status:"UNKNOWN"});
 },20_000);
 it("R65-1: an after-turn model switch waits for a draft to clear before applying",async()=>{
  const c=fixture(),pane=c.panes[0]!;
  const base=await c.controller.inspect(pane);
  let state="RUNNING",notReady:string|null="its composer holds text";
  c.controller.inspect.mockImplementation(async()=>({...base,state}) as never);
  const service=createSpaceControl({...c.options,promptNotReady:async()=>notReady,resolveActor:async()=>actor});
  const sent=await service.execute(actor,controlExecuteSchema.parse({roomId:c.room.id,requestId:"after-turn-model",actions:[
   {kind:"configure",target:{paneIds:[pane.id]},modelId:"gpt-6-astra",when:"AFTER_TURN"}]}),true);
  expect(sent.results[0]).toMatchObject({status:"PENDING"});
  state="IDLE";
  await service.tick();await service.tick();await service.tick();await service.tick();
  expect(c.controller.configure).not.toHaveBeenCalled();
  notReady=null;await service.tick();
  expect(c.controller.configure).toHaveBeenCalledOnce();
  expect(c.controller.configure.mock.calls[0]![1]).toMatchObject({modelId:"gpt-6-astra"});
 });
 it("an after-turn prompt waits for the pane's next empty prompt while its CLI still works, never typed now (31/10 Alex/Max)",async()=>{
  const c=fixture(),pane=c.panes[0]!;
  let notReady:string|null="its CLI is working";
  const promptNotReady=vi.fn(async()=>notReady);
  const service=createSpaceControl({...c.options,promptNotReady,resolveActor:async()=>actor});
  // The pane reads IDLE (Claude's own status) while its screen still shows the spinner.
  const sent=await service.execute(actor,controlExecuteSchema.parse({roomId:c.room.id,requestId:"after-turn",actions:[{kind:"pane",operation:"prompt",target:{paneIds:[pane.id]},text:"Next step",when:"AFTER_TURN"}]}),true,"req:http-deferred");
  expect(sent.results[0]).toMatchObject({status:"PENDING",detail:"Prompt scheduled for the pane's next empty prompt (its CLI is working)."});
  await service.tick();notReady="its composer holds text";await service.tick();
  expect(c.send).not.toHaveBeenCalled();
  notReady=null;await service.tick();
  expect(c.send).toHaveBeenCalledOnce();
  expect(c.send.mock.calls[0]![1]).toBe("Next step");
  // OBS-006: the prompt sent when the schedule fires still names the HTTP request that deferred it.
  expect(c.send.mock.calls[0]![3]).toBe("req:http-deferred");
  // A request moved to a new pane takes its after-turn text with it: the schedule's id cancels it (operator 31/10 «το πολύ 3 λεπτά»).
  notReady="its CLI is working";
  const moved=await service.execute(actor,controlExecuteSchema.parse({roomId:c.room.id,requestId:"after-turn-2",actions:[{kind:"pane",operation:"prompt",target:{paneIds:[pane.id]},text:"Moved step",when:"AFTER_TURN"}]}));
  const scheduleId=(moved.results[0]!.evidence as {scheduleId:string}).scheduleId;
  const cancelled=await service.execute(actor,controlExecuteSchema.parse({roomId:c.room.id,requestId:"cancel-2",actions:[{kind:"watch",operation:"cancel",id:scheduleId}]}));
  expect(cancelled.results[0]).toMatchObject({status:"COMPLETED",evidence:{result:{id:scheduleId,status:"CANCELLED"}}});
  notReady=null;await service.tick();
  expect(c.send).toHaveBeenCalledOnce();
 });
 it("persists voice completion only after matching client read-back and never repeats on retry",async()=>{
  const c=fixture();
  c.service.registerClient(actor,c.room.id,"voice-tab",[],{});
  const actions=[{kind:"resource",operation:"settings.update",input:{domain:"voice",patch:{language:"el",prewarm:false}}}];
  const pending=c.execute(actions,"voice-once");
  let commands:ReturnType<typeof c.service.registerClient>=[];
  await vi.waitFor(()=>{commands=c.service.registerClient(actor,c.room.id,"voice-tab",[],{});expect(commands).toHaveLength(1);});
  expect(commands[0]!.action).toMatchObject({operation:"settings.voice",input:{language:"el",prewarm:false}});
  expect(()=>c.service.acknowledge({...actor,id:"other-owner"},"voice-tab",commands[0]!.id,{ok:true,evidence:{}})).toThrow();
  c.service.acknowledge(actor,"voice-tab",commands[0]!.id,{ok:true,evidence:{applied:true,persisted:true,scope:"BROWSER_VOICE_COMPOSER",changesActiveLiveSession:false,preferences:{language:"el",prewarm:false}}});
  const result=await pending;
  expect(result.status).toBe("COMPLETED");
  const retry=await c.execute(actions,"voice-once");
  expect(retry.id).toBe(result.id);
  expect(c.service.registerClient(actor,c.room.id,"voice-tab",[],{})).toEqual([]);
  const reconstructed=createSpaceControl(c.options);
  expect((await reconstructed.execute(actor,controlExecuteSchema.parse({roomId:c.room.id,requestId:"voice-once",actions}))).id).toBe(result.id);
 });
 it.each([{}, {applied:true}, {applied:true,persisted:true,scope:"BROWSER_VOICE_COMPOSER",changesActiveLiveSession:false,preferences:{language:"en"}}])("does not accept generic or contradictory preference evidence %j",async evidence=>{
  const c=fixture();c.service.registerClient(actor,c.room.id,"voice-tab",[],{});
  const pending=c.execute([{kind:"resource",operation:"settings.voice",input:{language:"el"}},{kind:"room",operation:"rename",name:"Must not execute"}]);
  let commands:ReturnType<typeof c.service.registerClient>=[];
  await vi.waitFor(()=>{commands=c.service.registerClient(actor,c.room.id,"voice-tab",[],{});expect(commands).toHaveLength(1);});
  c.service.acknowledge(actor,"voice-tab",commands[0]!.id,{ok:true,evidence});
  expect((await pending).status).toBe("UNKNOWN");
  expect(c.store.getRoom(c.room.id).name).toBe("Control test");
 });
 it("requires one active client and validates voice patches without submitting dry runs",async()=>{
  const c=fixture();const action={kind:"resource",operation:"settings.voice",input:{language:"el"}};
  const missing=await c.execute([action],"voice-missing");expect(missing.status).toBe("RUNNING");
  expect(missing.results[0]).toMatchObject({status:"PENDING",evidence:{waitingForClient:true}});
  c.service.registerClient(actor,c.room.id,"tab1",[],{});c.service.registerClient(actor,c.room.id,"tab2",[],{});
  expect((await c.execute([action],"voice-ambiguous")).status).toBe("FAILED");
  c.service.unregisterClient(actor,"tab2");
  for (const input of [{}, {language:"el",extra:true}, {prewarm:"yes"}]) {
   expect((await c.execute([{...action,input}],`invalid:${JSON.stringify(input)}`)).status).toBe("FAILED");
  }
  const preflight=await c.execute([action],"voice-dry-run",{dryRun:true});expect(preflight.status).toBe("COMPLETED");
  expect(preflight.results[0]).toMatchObject({evidence:{dryRun:true,simulated:true,adapterValidated:true}});
  expect(c.service.registerClient(actor,c.room.id,"tab1",[],{})).toEqual([]);
 });
 it("sorts the real room and returns a durable receipt, including after service reconstruction",async()=>{
  const c=fixture();const cmd=[{kind:"layout",operation:"sort",sortBy:"title"}];
  const first=await c.execute(cmd);expect(first.status).toBe("COMPLETED");
  expect(c.store.listPanes(c.room.id).sort((a,b)=>a.order-b.order).map(p=>p.title)).toEqual(["A 2","B 3","C 1"]);
  const second=await createSpaceControl(c.options).execute(actor,controlExecuteSchema.parse({roomId:c.room.id,requestId:"request:one",actions:cmd}));
  expect(second).toEqual(first);
  await expect(c.execute([{kind:"room",operation:"rename",name:"Wrong"}])).rejects.toThrow("different payload");
 });
 it("rejects stale snapshots before mutation",async()=>{
  const c=fixture();const result=await c.execute([{kind:"room",operation:"rename",name:"Wrong"}],"stale",{expectedRevision:"0".repeat(64)});
  expect(result.status).toBe("FAILED");expect(c.store.getRoom(c.room.id).name).toBe("Control test");
 });
 it("refuses cross-room pane IDs without touching valid panes",async()=>{
  const c=fixture();const other=c.store.createRoom({name:"Other",initialPaneCount:1});const foreign=c.store.listPanes(other.id)[0]!;
  const result=await c.execute([{kind:"pane",operation:"close",target:{paneIds:[c.panes[0]!.id,foreign.id],state:"ALL"}}]);
  expect(result.status).toBe("FAILED");expect(c.controller.interrupt).not.toHaveBeenCalled();
 });
 it("only claims a duplicate prompt once across independent services",async()=>{
  const c=fixture();const input=controlExecuteSchema.parse({roomId:c.room.id,requestId:"prompt",actions:[{kind:"pane",operation:"prompt",text:"Continue the approved task",target:{paneIds:[c.panes[0]!.id]}}]});
  await Promise.all([c.service,createSpaceControl(c.options)].map(s=>s.execute(actor,input)));
  expect(c.send).toHaveBeenCalledTimes(1);
 });
 it("does not submit a second continue to productive panes",async()=>{
  const c=fixture();c.controller.inspect.mockImplementation(async(p:any)=>({...await Promise.resolve({paneId:p.id,title:p.title,runtimeId:"cli:codex",sessionId:"session:one",state:"RUNNING",nativeTaskRef:"native:one",modelId:"test",nativeMode:"default",checkedAt:new Date().toISOString(),tasks:[]})}) as any);
  const result=await c.execute([{kind:"pane",operation:"continue",target:{paneIds:[c.panes[0]!.id]}}]);
  expect(result.status).toBe("FAILED");expect(c.controller.resume).not.toHaveBeenCalled();
 });
 it("preserves partial failure and does not execute dependent actions",async()=>{
  const c=fixture();c.controller.interrupt.mockRejectedValueOnce(new Error("Native control unavailable"));
  const result=await c.execute([{kind:"pane",operation:"close",target:{state:"OPEN"}},{kind:"room",operation:"rename",name:"Never"}]);
  expect(result.status).toBe("PARTIAL");expect(c.store.getRoom(c.room.id).name).toBe("Control test");expect(result.results).toHaveLength(3);
 });
 it("saves and restores tree layouts without restarting native sessions",async()=>{
  const c=fixture();const saved=await c.execute([{kind:"layout",operation:"save"}],"save");const snapshotId=(saved.results[0]!.evidence.result as any).snapshotId;
  const tree=await c.execute([{kind:"layout",operation:"tree"}],"tree");expect(tree.status).toBe("COMPLETED");expect((await c.service.layout(c.room.id) as any).placements).toHaveLength(3);
  await c.execute([{kind:"layout",operation:"restore",snapshotId}],"restore");expect(await c.service.layout(c.room.id)).toBeNull();expect(c.controller.interrupt).not.toHaveBeenCalled();
 });
 it("requires an active client for media and never claims it played",async()=>{
  const c=fixture();const result=await c.execute([{kind:"playback",operation:"next"}]);expect(result.status).toBe("RUNNING");
  expect(result.results[0]).toMatchObject({status:"PENDING",evidence:{waitingForClient:true}});
 });
 it("keeps clipboard records private to the actor",async()=>{
  const c=fixture();await c.execute([{kind:"clipboard",operation:"save",text:"Private plan",source:"PLAN",minimumModel:"gpt-5.6-sol"}]);
  expect(c.store.listClipboardItems(actor.id).items).toHaveLength(1);expect(c.store.listClipboardItems("another").items).toHaveLength(0);
 });
 it("marks orphaned operations uncertain after restart without replay",async()=>{
  const c=fixture();const completed=await c.execute([{kind:"room",operation:"rename",name:"Saved"}]);
  const record=(await c.repository.get("operation",actor.id,completed.id))!;
  await c.repository.write({...record,value:{...completed,status:"RUNNING",results:[],nextIndex:0}},record.version);
  const done=await c.execute([{kind:"room",operation:"rename",name:"Kept"}],"kept");
  const doneVersion=(await c.repository.get("operation",actor.id,done.id))!.version;
  const restarted=createSpaceControl(c.options);await restarted.start();
  const list=await restarted.operations(actor,c.room.id) as any[];expect(list.find(o=>o.id===completed.id).status).toBe("UNKNOWN");
  expect((await c.repository.get("operation",actor.id,done.id))!.version).toBe(doneVersion);
  expect(c.store.getRoom(c.room.id).name).toBe("Kept");await restarted.close();
 });
 it("defers unsupported CLI adapters without sending input",async()=>{
  const c=fixture();c.store.updatePane(c.panes[0]!.id,{terminalRuntimeId:"cli:unsupported"});
  const result=await c.execute([{kind:"pane",operation:"prompt",text:"work",target:{paneIds:[c.panes[0]!.id]}}]);
  expect(result.status).toBe("FAILED");expect(c.send).not.toHaveBeenCalled();
 });
 it("reports broker rejection as failure, including HTTP-success payloads",async()=>{
  const c=fixture();const service=createSpaceControl({...c.options,integration:async()=>({status:"APPROVAL_REQUIRED"})});
  const result=await service.execute(actor,controlExecuteSchema.parse({roomId:c.room.id,requestId:"denied",actions:[{kind:"resource",operation:"ops.deploy",input:{}}]}));
  expect(result.status).toBe("FAILED");
 });
 it("serializes different commands across services using the shared repository",async()=>{
  const c=fixture();let release!:()=>void;const events:string[]=[];
  c.send.mockImplementationOnce(async()=>{events.push("first");await new Promise<void>(r=>release=r);events.push("first-finished");return {submitted:true};});
  const first=c.execute([{kind:"pane",operation:"prompt",text:"work",target:{paneIds:[c.panes[0]!.id]}}]);
  await vi.waitFor(()=>expect(c.send).toHaveBeenCalledOnce());
  const second=createSpaceControl(c.options).execute(actor,controlExecuteSchema.parse({roomId:c.room.id,requestId:"rename",actions:[{kind:"room",operation:"rename",name:"After"}]}));
  expect(c.store.getRoom(c.room.id).name).toBe("Control test");release();await Promise.all([first,second]);
  expect(events).toEqual(["first","first-finished"]);expect(c.store.getRoom(c.room.id).name).toBe("After");
 });
 it("waits for an active turn then applies dependent commands in order",async()=>{
  const c=fixture();let running=true;const original=c.controller.inspect.getMockImplementation()!;
  c.controller.inspect.mockImplementation(async p=>({...await original(p),state:running?"RUNNING":"IDLE"}));
  const service=createSpaceControl({...c.options,resolveActor:async()=>actor});
  const result=await service.execute(actor,controlExecuteSchema.parse({roomId:c.room.id,requestId:"deferred",actions:[
   {kind:"configure",target:{paneIds:[c.panes[0]!.id]},nativeMode:"plan"},
   {kind:"room",operation:"rename",name:"After turn"}]}));
  expect(result.status).toBe("RUNNING");expect(c.controller.configure).not.toHaveBeenCalled();
  expect(c.store.getRoom(c.room.id).name).toBe("Control test");running=false;
  await service.tick();await service.tick();
  expect(c.controller.configure).toHaveBeenCalledOnce();expect(c.store.getRoom(c.room.id).name).toBe("After turn");
  expect((await service.operations(actor,c.room.id,result.id) as any).status).toBe("COMPLETED");
 });
 it("a later stop invalidates a previously scheduled native continuation",async()=>{
  const c=fixture();const service=createSpaceControl({...c.options,resolveActor:async()=>actor,checkQuota:async()=>({allowed:true,reason:"available"})});
  const command=controlExecuteSchema.parse({roomId:c.room.id,requestId:"later",actions:[{kind:"pane",operation:"continue",target:{paneIds:[c.panes[0]!.id]}}]});
  const scheduled=await service.schedules(actor,c.room.id,"create",undefined,new Date(Date.now()+1000).toISOString(),command) as any;
  await service.rememberStop(c.panes[0]!);
  const saved=(await c.repository.get("schedule",actor.id,scheduled.id))!;
  await c.repository.write({...saved,value:{...scheduled,dueAt:new Date(Date.now()-100).toISOString()}},saved.version);
  await service.tick();expect(c.send).not.toHaveBeenCalled();
  expect((await service.schedules(actor,c.room.id,"list") as any[])[0].status).toBe("BLOCKED");
 });
 it("revalidates a claimed schedule after restart before submitting input",async()=>{
  const c=fixture();const service=createSpaceControl({...c.options,resolveActor:async()=>actor,checkQuota:async()=>({allowed:true,reason:"available"})});
  const command=controlExecuteSchema.parse({roomId:c.room.id,requestId:"restart",actions:[{kind:"pane",operation:"continue",target:{paneIds:[c.panes[0]!.id]}}]});
  const scheduled=await service.schedules(actor,c.room.id,"create",undefined,new Date(Date.now()+1000).toISOString(),command) as any;
  const saved=(await c.repository.get("schedule",actor.id,scheduled.id))!;
  await c.repository.write({...saved,value:{...scheduled,status:"RUNNING",dueAt:new Date(Date.now()-100).toISOString()}},saved.version);
  await service.rememberStop(c.panes[0]!);
  await service.tick();expect(c.send).not.toHaveBeenCalled();
  expect((await service.schedules(actor,c.room.id,"list") as any[])[0].status).toBe("BLOCKED");
 });
 it("does not race an authorized terminal stop with scheduled continuation",async()=>{
  const c=fixture();const service=createSpaceControl({...c.options,resolveActor:async()=>actor,checkQuota:async()=>({allowed:true,reason:"available"})});
  const command=controlExecuteSchema.parse({roomId:c.room.id,requestId:"race",actions:[{kind:"pane",operation:"continue",target:{paneIds:[c.panes[0]!.id]}}]});
  const scheduled=await service.schedules(actor,c.room.id,"create",undefined,new Date(Date.now()+1000).toISOString(),command) as any;
  const saved=(await c.repository.get("schedule",actor.id,scheduled.id))!;
  await c.repository.write({...saved,value:{...scheduled,dueAt:new Date(Date.now()-100).toISOString()}},saved.version);
  let release!:()=>void;
  const stop=vi.fn(async()=>new Promise<void>(resolve=>{release=resolve;}));
  const stopping=service.withOperatorMutation(c.panes[0]!,stop);
  await vi.waitFor(()=>expect(stop).toHaveBeenCalledOnce());
  const ticking=service.tick();expect(c.send).not.toHaveBeenCalled();
  release();await Promise.all([stopping,ticking]);expect(c.send).not.toHaveBeenCalled();
  expect((await service.schedules(actor,c.room.id,"list") as any[])[0].status).toBe("BLOCKED");
 });
 it("executes a due schedule once across independent scheduler instances",async()=>{
  const c=fixture();const options={...c.options,resolveActor:async()=>actor,checkQuota:async()=>({allowed:true,reason:"available"})};
  const service=createSpaceControl(options),other=createSpaceControl(options);
  const command=controlExecuteSchema.parse({roomId:c.room.id,requestId:"once",actions:[{kind:"pane",operation:"continue",target:{paneIds:[c.panes[0]!.id]}}]});
  const scheduled=await service.schedules(actor,c.room.id,"create",undefined,new Date(Date.now()+1000).toISOString(),command) as any;
  const saved=(await c.repository.get("schedule",actor.id,scheduled.id))!;
  const dueAt=new Date(Date.now()-100).toISOString();
  await c.repository.write({...saved,value:{...scheduled,dueAt}},saved.version);
  await Promise.all([service.tick(),other.tick()]);expect(c.send).toHaveBeenCalledOnce();
  // OBS-006: an AT_TIME schedule starts from no request; the send it fires names a server-minted id for the schedule and its due time.
  expect(c.send.mock.calls[0]![3]).toBe(`sched-${scheduled.id}-${dueAt}`);
  expect((await service.schedules(actor,c.room.id,"list") as any[])[0].status).toBe("COMPLETED");
 });
 it("refreshes native readiness after start instead of reusing the pre-start observation",async()=>{
  const c=fixture();let started=false;
  c.controller.start.mockImplementation(async()=>{started=true;return {};});
  c.controller.inspect.mockImplementation(async(p:any,freshness?:{fresh?:boolean})=>({paneId:p.id,title:p.title,runtimeId:"cli:gemini",sessionId:"session:one",state:started&&freshness?.fresh?"IDLE":"UNKNOWN",nativeTaskRef:null,modelId:null,nativeMode:null,checkedAt:new Date().toISOString(),tasks:[]}) as any);
  const result=await c.execute([{kind:"pane",operation:"start",target:{paneIds:[c.panes[0]!.id]}}]);
  expect(result.status).toBe("COMPLETED");expect(c.controller.start).toHaveBeenCalledOnce();
 });
 it("a start after the CLI exited is a new session, not an unconfirmed resume; a resume still needs the prior native task (EXT-G-6)",async()=>{
  // 2/11 dev: a Gemini pane's start after /quit answered UNKNOWN "The original native task has not been confirmed after resume."
  const c=fixture(),pane=c.panes[0]!;
  c.store.createPaneCliSession({paneId:pane.id,roomId:c.room.id,runtimeId:"cli:codex",providerId:"codex",agentId:"codex",modelId:"test",reasoningEffort:"low",launchMode:"FRESH",cwd:"/tmp",codexThreadId:"05644479-4762-4a1e-a376-f7f8569dd788",status:"EXITED"});
  let started=false;
  c.controller.start.mockImplementation(async()=>{started=true;return {};});
  c.controller.inspect.mockImplementation(async(p:any)=>({paneId:p.id,title:p.title,runtimeId:"cli:codex",sessionId:"session:one",state:started?"IDLE":"EXITED",nativeTaskRef:started?"native:new":null,modelId:null,nativeMode:null,checkedAt:new Date().toISOString(),tasks:[]}) as any);
  expect((await c.execute([{kind:"pane",operation:"start",target:{paneIds:[pane.id]}}],"request:start")).status).toBe("COMPLETED");
  const resumed=await c.execute([{kind:"pane",operation:"resume",target:{paneIds:[pane.id]}}],"request:resume");
  expect(resumed.status).toBe("UNKNOWN");expect(JSON.stringify(resumed)).toContain("original native task has not been confirmed");
 });
 it("restart and reopen of a CLI that never ran a command start a fresh session; resume still fails (SpaceApp Android, 2/11)",async()=>{
  // 2/11 Bruno/Iris: the phone's Restart of a Codex pane quit by Ctrl+C before any command failed "… has no resumable transcript".
  const c=fixture(),pane=c.panes[0]!;
  c.store.createPaneCliSession({paneId:pane.id,roomId:c.room.id,runtimeId:"cli:codex",providerId:"codex",agentId:"codex",modelId:"test",reasoningEffort:"low",launchMode:"FRESH",cwd:"/tmp",codexThreadId:"05644479-4762-4a1e-a376-f7f8569dd788",status:"EXITED"});
  c.controller.resume.mockRejectedValue(new CliTaskNotResumableError("Space CLI task cli_task:one has no resumable transcript."));
  c.controller.inspect.mockImplementation(async(p:any)=>({paneId:p.id,title:p.title,runtimeId:"cli:codex",sessionId:"session:two",state:"IDLE",nativeTaskRef:"native:new",modelId:null,nativeMode:null,checkedAt:new Date().toISOString(),tasks:[]}) as any);
  const restarted=await c.execute([{kind:"pane",operation:"restart",target:{paneIds:[pane.id]}}],"request:restart");
  expect(restarted.status).toBe("COMPLETED");expect(restarted.results[0]!.detail).toContain("a fresh CLI session started");
  expect(c.controller.start).toHaveBeenCalledOnce();
  c.store.updatePane(pane.id,{isClosed:true,status:"CLOSED"});
  expect((await c.execute([{kind:"pane",operation:"reopen",target:{paneIds:[pane.id],state:"CLOSED"}}],"request:reopen")).status).toBe("COMPLETED");
  expect(c.controller.start).toHaveBeenCalledTimes(2);
  const resumed=await c.execute([{kind:"pane",operation:"resume",target:{paneIds:[pane.id]}}],"request:resume");
  expect(resumed.status).toBe("FAILED");expect(JSON.stringify(resumed)).toContain("no resumable transcript");
  // Any other resume failure is still the answer, never a silent fresh start.
  c.controller.resume.mockRejectedValue(new Error("Room Agent can resume only tasks belonging to this room."));
  const other=await c.execute([{kind:"pane",operation:"restart",target:{paneIds:[pane.id]}}],"request:other");
  expect(other.status).toBe("FAILED");expect(c.controller.start).toHaveBeenCalledTimes(2);
 });
 it("reopens Chat without submitting a continuation prompt",async()=>{
  const c=fixture();c.store.updatePane(c.panes[0]!.id,{mode:"CHAT",isClosed:true,status:"CLOSED"});
  const result=await c.execute([{kind:"pane",operation:"reopen",target:{paneIds:[c.panes[0]!.id],state:"CLOSED"}}]);
  expect(result.status).toBe("COMPLETED");expect(c.controller.start).toHaveBeenCalledOnce();
  expect(c.controller.resume).not.toHaveBeenCalled();expect(c.send).not.toHaveBeenCalled();
 });
 it("executes cancel as an alias of stop and interrupts running pane",async()=>{
  const c=fixture();
  const result=await c.execute([{kind:"pane",operation:"cancel",target:{paneIds:[c.panes[0]!.id]}}]);
  expect(result.status).toBe("COMPLETED");
  expect(c.controller.interrupt).toHaveBeenCalledWith(expect.objectContaining({id:c.panes[0]!.id}),"request:one");
 });
 it("forwards accountProfileId during configure execution",async()=>{
  const c=fixture();
  const result=await c.execute([{kind:"configure",target:{paneIds:[c.panes[0]!.id]},accountProfileId:"google-4"}]);
  expect(result.status).toBe("COMPLETED");
  expect(c.controller.configure).toHaveBeenCalledWith(expect.objectContaining({id:c.panes[0]!.id}),expect.objectContaining({accountProfileId:"google-4"}),"request:one");
 });
 it("captures screenshot via server capture engine when no active client is connected",async()=>{
  const c=fixture();
  const captureScreenshot=vi.fn(async()=>({roomId:c.room.id,authenticated:true,captureSource:"AUTHENTICATED_APP",artifactId:"art_shot_1",width:1280,height:800}));
  const service=createSpaceControl({...c.options,captureScreenshot});
  const result=await service.execute(actor,controlExecuteSchema.parse({roomId:c.room.id,requestId:"shot:one",actions:[{kind:"screenshot",operation:"capture",target:"APP",format:"jpeg",quality:80}]}));
  expect(result.status).toBe("COMPLETED");
  expect(captureScreenshot).toHaveBeenCalledWith(actor,c.room.id,expect.objectContaining({format:"jpeg",quality:80}));
  expect((result.results[0]!.evidence.result as any).artifactId).toBe("art_shot_1");
 });
 it("fails screenshot execution when capture engine is unavailable and no client is connected",async()=>{
  const c=fixture();
  const result=await c.execute([{kind:"screenshot",operation:"capture",target:"APP"}]);
  expect(result.status).toBe("FAILED");
  expect(result.results[0]!.detail).toContain("Authenticated room screenshot capture is unavailable");
 });
 it("executes screenshot method directly and returns captured evidence",async()=>{
  const c=fixture();
  const captureScreenshot=vi.fn(async()=>({roomId:c.room.id,authenticated:true,captureSource:"AUTHENTICATED_APP",artifactId:"art_shot_2",width:1920,height:1080}));
  const service=createSpaceControl({...c.options,captureScreenshot});
  const result=await service.screenshot(actor,c.room.id,{format:"png",quality:90});
  expect(result.status).toBe("COMPLETED");
  expect(result.evidence.artifactId).toBe("art_shot_2");
 });
 it.each(["anonymous", "foreign-room", "schematic", "no-artifact"])("rejects %s capture evidence without queuing a fake client screenshot",async failure=>{
  const c=fixture();
  const captureScreenshot=vi.fn(async()=>({roomId:failure==="foreign-room"?"room:other":c.room.id,authenticated:failure!=="anonymous",captureSource:failure==="schematic"?"DOM_DRAWING":"AUTHENTICATED_APP",artifactId:failure==="no-artifact"?"":"artifact:test"}));
  const service=createSpaceControl({...c.options,captureScreenshot});
  service.registerClient(actor,c.room.id,"focused-tab",[],{});
  const result=await service.execute(actor,controlExecuteSchema.parse({roomId:c.room.id,requestId:"unverified-shot",actions:[{kind:"screenshot",operation:"capture",target:"APP"}]}));
  expect(result.status).toBe("FAILED");
  expect(service.registerClient(actor,c.room.id,"focused-tab",[],{})).toEqual([]);
 });
 it("rejects destructive clipboard deletion without explicit confirmation",async()=>{
  const c=fixture();
  const saved=await c.store.upsertClipboardItem({ownerUserId:actor.id,text:"Item to delete",source:"PLAN",minimumModel:"gpt-5.6-sol"});
  const result=await c.execute([{kind:"clipboard",operation:"delete",id:saved.id}]);
  expect(result.status).toBe("FAILED");
  expect(result.results[0]!.detail).toContain("Destructive clipboard delete requires explicit confirmation");
  expect(c.store.listClipboardItems(actor.id).items).toHaveLength(1);
 });
 it("allows destructive clipboard deletion with explicit confirmation",async()=>{
  const c=fixture();
  const saved=await c.store.upsertClipboardItem({ownerUserId:actor.id,text:"Item to delete confirmed",source:"PLAN",minimumModel:"gpt-5.6-sol"});
  const result=await c.execute([{kind:"clipboard",operation:"delete",id:saved.id,confirm:true}]);
  expect(result.status).toBe("COMPLETED");
  expect(c.store.listClipboardItems(actor.id).items).toHaveLength(0);
 });
 it("handles task resource operations with audit and destructive confirmation",async()=>{
  const integrationCalls: any[] = [];
  const integration = vi.fn(async (_actor, _roomId, action) => {
   integrationCalls.push(action);
   if (action.operation === "tasks.delete" && !action.input?.confirm) {
    return { isError: true, status: "APPROVAL_REQUIRED" };
   }
   return { ok: true, operation: action.operation };
  });
  const c = fixture();
  const service = createSpaceControl({ ...c.options, integration });
  const createRes = await service.execute(actor, controlExecuteSchema.parse({
   roomId: c.room.id,
   requestId: "task:create",
   actions: [{ kind: "resource", operation: "tasks.create", input: { title: "Fix swarm", objective: "Ship bugfix" } }]
  }));
  expect(createRes.status).toBe("COMPLETED");

  const unconfirmedDel = await service.execute(actor, controlExecuteSchema.parse({
   roomId: c.room.id,
   requestId: "task:del:unconfirmed",
   actions: [{ kind: "resource", operation: "tasks.delete", id: "task_1", input: {} }]
  }));
  expect(unconfirmedDel.status).toBe("FAILED");

  const confirmedDel = await service.execute(actor, controlExecuteSchema.parse({
   roomId: c.room.id,
   requestId: "task:del:confirmed",
   actions: [{ kind: "resource", operation: "tasks.delete", id: "task_1", input: { confirm: true } }]
  }));
  expect(confirmedDel.status).toBe("COMPLETED");
 });
 it("minimizes a pane and persists isMinimized in the store", async () => {
  const c = fixture();
  const pane = c.panes[0]!;
  expect(c.store.getPane(pane.id).isMinimized).toBe(false);
  const result = await c.execute([{ kind: "pane", operation: "minimize", target: { paneIds: [pane.id] } }]);
  expect(result.status).toBe("COMPLETED");
  expect(c.store.getPane(pane.id).isMinimized).toBe(true);
  expect(c.store.getPane(pane.id).isMaximized).toBe(false);
 });
 it("maximizes a pane and clears isMinimized", async () => {
  const c = fixture();
  const pane = c.panes[0]!;
  c.store.updatePane(pane.id, { isMinimized: true });
  const result = await c.execute([{ kind: "pane", operation: "maximize", target: { paneIds: [pane.id] } }], "max:one");
  expect(result.status).toBe("COMPLETED");
  expect(c.store.getPane(pane.id).isMaximized).toBe(true);
  expect(c.store.getPane(pane.id).isMinimized).toBe(false);
 });
 it("restores a pane clearing both isMinimized and isMaximized", async () => {
  const c = fixture();
  const pane = c.panes[0]!;
  c.store.updatePane(pane.id, { isMinimized: true });
  const result = await c.execute([{ kind: "pane", operation: "restore", target: { paneIds: [pane.id] } }], "restore:one");
  expect(result.status).toBe("COMPLETED");
  expect(c.store.getPane(pane.id).isMinimized).toBe(false);
  expect(c.store.getPane(pane.id).isMaximized).toBe(false);
 });
 it("idempotent double minimize does not fail", async () => {
  const c = fixture();
  const pane = c.panes[0]!;
  await c.execute([{ kind: "pane", operation: "minimize", target: { paneIds: [pane.id] } }]);
  const second = await c.execute([{ kind: "pane", operation: "minimize", target: { paneIds: [pane.id] } }], "min:dup");
  expect(second.status).toBe("COMPLETED");
  expect(c.store.getPane(pane.id).isMinimized).toBe(true);
 });
 it("minimize does not require runtime assertion and works on non-TERMINAL panes", async () => {
  const c = fixture();
  const pane = c.panes[0]!;
  c.store.updatePane(pane.id, { mode: "BROWSER", terminalRuntimeId: null as any });
  const result = await c.execute([{ kind: "pane", operation: "minimize", target: { paneIds: [pane.id] } }], "min:browser");
  expect(result.status).toBe("COMPLETED");
  expect(c.store.getPane(pane.id).isMinimized).toBe(true);
  expect(c.controller.inspect).not.toHaveBeenCalled();
 });
 it("minimize and restore work on multiple panes in a single batch", async () => {
  const c = fixture();
  const [p1, p2, p3] = c.panes;
  const result = await c.execute([
   { kind: "pane", operation: "minimize", target: { paneIds: [p1!.id, p2!.id] } },
   { kind: "pane", operation: "maximize", target: { paneIds: [p3!.id] } }
  ], "batch:minmax");
  expect(result.status).toBe("COMPLETED");
  expect(c.store.getPane(p1!.id).isMinimized).toBe(true);
  expect(c.store.getPane(p2!.id).isMinimized).toBe(true);
  expect(c.store.getPane(p3!.id).isMaximized).toBe(true);
  expect(c.store.getPane(p3!.id).isMinimized).toBe(false);
 });
 it("unminimizes a pane clearing isMinimized", async () => {
  const c = fixture();
  const pane = c.panes[0]!;
  c.store.updatePane(pane.id, { isMinimized: true });
  const result = await c.execute([{ kind: "pane", operation: "unminimize", target: { paneIds: [pane.id] } }], "unmin:one");
  expect(result.status).toBe("COMPLETED");
  expect(c.store.getPane(pane.id).isMinimized).toBe(false);
  expect(c.store.getPane(pane.id).isMaximized).toBe(false);
 });
 it("idempotent double restore on unminimized pane does not fail", async () => {
  const c = fixture();
  const pane = c.panes[0]!;
  expect(c.store.getPane(pane.id).isMinimized).toBe(false);
  const result = await c.execute([{ kind: "pane", operation: "restore", target: { paneIds: [pane.id] } }], "restore:noop");
  expect(result.status).toBe("COMPLETED");
  expect(c.store.getPane(pane.id).isMinimized).toBe(false);
 });
 it("inspect STATE reflects isMinimized and isMaximized accurately", async () => {
  const c = fixture();
  const pane = c.panes[1]!;
  c.store.updatePane(pane.id, { isMinimized: true });
  const state = await c.service.inspect(actor, { roomId: c.room.id, section: "STATE", offset: 0, limit: 25 }) as any;
  const entry = state.panes.find((p: any) => p.id === pane.id);
  expect(entry.isMinimized).toBe(true);
  expect(entry.isMaximized).toBe(false);
 });
 it("inspect STATE counts a pane whose prompt has left the transcript tail as used", async () => {
  const c = fixture();
  const [fresh, prompted] = c.panes;
  const append = (pane: { id: string }, sessionId: string, sequence: number, stream: "stdin" | "stdout", content: string) =>
   c.store.appendPaneCliTranscriptChunk({ sessionId, paneId: pane.id, roomId: c.room.id, sequence, stream, content, byteLength: content.length });
  for (const pane of [fresh!, prompted!]) {
   const { sessionId } = c.store.createPaneCliSession({ paneId: pane.id, roomId: c.room.id, runtimeId: "cli:codex", providerId: "openai",
    agentId: "codex", status: "RUNNING", modelId: "gpt-6-sol", reasoningEffort: "medium" });
   if (pane !== prompted) continue;
   // The prompt, then a long turn: retention keeps a session's newest 200 chunks, and the tail holds output only.
   append(pane, sessionId, 0, "stdin", "Check this pane\r");
   for (let sequence = 1; sequence <= 12; sequence++) append(pane, sessionId, sequence, "stdout", `step ${sequence}\n`);
   const now = new Date().toISOString();
   c.store.updatePane(pane.id, { taskMetadata: { taskKey: `cli:${sessionId}`, version: 1, description: "", steps: [], earlierWork: "",
    source: "local", generationStatus: "pending", nativeSyncStatus: "unsupported", providerId: null, modelId: null, topics: [], updatedAt: now } });
  }
  const state = await c.service.inspect(actor, { roomId: c.room.id, section: "STATE" }) as { panes: Array<{ id: string; hasUserInput: boolean; isUnused: boolean }> };
  const entry = (id: string) => state.panes.find((p) => p.id === id);
  expect(entry(prompted!.id)).toMatchObject({ hasUserInput: true, isUnused: false });
  expect(entry(fresh!.id)).toMatchObject({ hasUserInput: false, isUnused: true });
 });
 it("pane start starts a rail-tab CLI pane's CLI through startRailCli; restart and non-CLI panes stay as they were (Felix/Jack gap 4)", async () => {
  const c = fixture();
  const startRailCli = vi.fn(async () => ({ sessionId: "cli_session:rail" }));
  const service = createSpaceControl({ ...c.options, startRailCli });
  const studio = c.store.createPane({ roomId: c.room.id, title: "App Studio", mode: "APP_STUDIO", terminalRuntimeId: "cli:claude" });
  const browser = c.store.createPane({ roomId: c.room.id, title: "Browser", mode: "BROWSER" });
  const run = (operation: string, paneId: string, requestId: string) => service.execute(actor, controlExecuteSchema.parse({ roomId: c.room.id, requestId,
   actions: [{ kind: "pane", operation, target: { paneIds: [paneId] } }] }));
  const started = await run("start", studio.id, "rail-start");
  expect(started.results[0]).toMatchObject({ status: "COMPLETED", evidence: { result: { sessionId: "cli_session:rail" } } });
  expect(startRailCli).toHaveBeenCalledWith(actor, expect.objectContaining({ id: studio.id }), expect.any(String));
  await run("restart", studio.id, "rail-restart");
  await run("start", browser.id, "browser-start");
  expect(startRailCli).toHaveBeenCalledTimes(1);
  expect(c.controller.start).not.toHaveBeenCalled();
 });
 it("inspect STATE reports the CLI session of rail-tab CLI panes like a terminal's (Felix/Iris 2026-10-23)", async () => {
  const c = fixture();
  const modes = ["TERMINAL", "APP_STUDIO", "DESIGN", "VIDEO", "MAIL_COPILOT", "MARKETING_COPILOT", "FREELANCE_COPILOT", "JOB_APPLY"] as const;
  const sessions = new Map(modes.map((mode) => {
   const pane = c.store.createPane({ roomId: c.room.id, title: mode, mode, terminalRuntimeId: "cli:claude" });
   const session = c.store.createPaneCliSession({ paneId: pane.id, roomId: c.room.id, runtimeId: "cli:claude", providerId: "anthropic",
    agentId: "claude", purpose: "NORMAL", status: "RUNNING", modelId: "claude-opus-5-5" });
   return [pane.id, { mode, session }] as const;
  }));
  const state = await c.service.inspect(actor, { roomId: c.room.id, section: "STATE" }) as { panes: Array<Record<string, unknown> & { id: string }> };
  for (const [paneId, { mode, session }] of sessions) {
   expect({ mode, ...state.panes.find((p) => p.id === paneId) }).toMatchObject({ mode, status: "RUNNING", sessionId: session.sessionId,
    sessionStartedAt: session.startedAt, runtimeId: "cli:claude", configuredModelId: "claude-opus-5-5" });
  }
 });
 it("inspect STATE enriches panes with verified model and account fields", async () => {
  const c = fixture();
  const pane = c.panes[0]!;
  const inspectPaneState = vi.fn(async (p: any) => ({
   paneId: p.id,
   title: p.title,
   runtimeId: "cli:gemini",
   sessionId: "session:gemini-1",
   state: "RUNNING" as const,
   nativeTaskRef: "task:gemini-1",
   modelId: "gemini-3.8-flash-high",
   configuredModelId: "gemini-2.5-flash",
   effectiveModelId: "gemini-3.8-flash-high",
   modelVerificationStatus: "VERIFIED" as const,
   accountProfileId: "google-2",
   accountEmail: "profile2@example.com",
   accountVerificationStatus: "VERIFIED" as const,
   verificationEvidence: {
     processFound: true,
     pid: 12345,
     logEmail: "profile2@example.com",
     logModelLabel: "Gemini 3.8 Flash (High)",
     accountSource: "process_env" as const,
     modelSource: "cli_log" as const,
     accountVerified: true,
     modelVerified: true,
     details: "Live PID 12345, verified"
   },
   nativeMode: "default",
   checkedAt: new Date().toISOString(),
   tasks: []
  }));
  const service = createSpaceControl({ ...c.options, inspectPaneState });
  const state = await service.inspect(actor, { roomId: c.room.id, section: "STATE" }) as any;
  const entry = state.panes.find((p: any) => p.id === pane.id);
  expect(entry.configuredModelId).toBe("gemini-2.5-flash");
  expect(entry.effectiveModelId).toBe("gemini-3.8-flash-high");
  expect(entry.modelVerificationStatus).toBe("VERIFIED");
  expect(entry.accountProfileId).toBe("google-2");
  expect(entry.accountEmail).toBe("profile2@example.com");
  expect(entry.accountVerificationStatus).toBe("VERIFIED");
  expect(entry.verificationEvidence.modelVerified).toBe(true);
  expect(entry.verificationEvidence.accountVerified).toBe(true);
 });
 it("closes a pane whose CLI runtime has no native controls, like the UI's close button (27/10: Bruno/Leo)", async () => {
  const c = fixture();
  const shell = c.store.createPane({ roomId: c.room.id, title: "Leo", mode: "TERMINAL", terminalRuntimeId: "cli:harness" });
  const prompt = await c.execute([{ kind: "pane", operation: "prompt", target: { paneIds: [shell.id] }, text: "Hi" }], "request:prompt") as any;
  expect(JSON.stringify(prompt)).toContain("Native controls for this CLI runtime are not supported.");
  const dry = await c.execute([{ kind: "pane", operation: "close", target: { paneIds: [shell.id], state: "ALL" } }], "request:dry", { dryRun: true }) as any;
  expect(JSON.stringify(dry)).not.toContain("Native controls");
  expect(c.store.getPane(shell.id).isClosed).toBe(false);
  const closed = await c.execute([{ kind: "pane", operation: "close", target: { paneIds: [shell.id], state: "ALL" } }], "request:close") as any;
  expect(closed).toMatchObject({ status: "COMPLETED", results: [{ paneId: shell.id, status: "COMPLETED" }] });
  expect(c.store.getPane(shell.id)).toMatchObject({ isClosed: true, status: "CLOSED" });
  expect(c.controller.interrupt).toHaveBeenCalledWith(expect.objectContaining({ id: shell.id }), expect.any(String));
  // 27/10 22:08: a shell pane the operator started Codex in by hand has no runtime at all (terminal_runtime_id null).
  const bare = c.store.createPane({ roomId: c.room.id, title: "Leo", mode: "TERMINAL", terminalRuntimeId: null } as never);
  expect(await c.execute([{ kind: "pane", operation: "close", target: { paneIds: [bare.id], state: "ALL" } }], "request:bare"))
    .toMatchObject({ status: "COMPLETED", results: [{ paneId: bare.id, status: "COMPLETED" }] });
  expect(c.store.getPane(bare.id)).toMatchObject({ isClosed: true, status: "CLOSED" });
 });
 it("inspect CONTENT returns open panes before closed panes so open content is not starved by older closed panes", async () => {
  const c = fixture();
  // Close the first two panes so they become older closed panes
  await c.execute([{ kind: "pane", operation: "close", target: { paneIds: [c.panes[0]!.id, c.panes[1]!.id], state: "ALL" } }]);
  // The third pane c.panes[2] remains open
  const openPane = c.panes[2]!;
  c.controller.inspect.mockImplementation(async (p: any) => ({
    paneId: p.id,
    title: p.title,
    runtimeId: "cli:codex",
    sessionId: "session:open",
    state: p.isClosed ? "EXITED" : "RUNNING",
    text: p.isClosed ? "" : "Here is the story: Five tiny words written here.",
    checkedAt: new Date().toISOString(),
    tasks: []
  }));
  const content = await c.service.inspect(actor, { roomId: c.room.id, section: "CONTENT", offset: 0, limit: 1 }) as any[];
  expect(content).toHaveLength(1);
  expect(content[0].paneId).toBe(openPane.id);
  expect(content[0].closed).toBe(false);
  expect(content[0].text).toContain("Five tiny words");
 });
 it("inspect CONTENT reads a copilot pane's CLI like a terminal, and still refuses a pane without a CLI (SpaceApp Android, 31/10)", async () => {
  const c = fixture();
  const mail = c.store.createPane({ roomId: c.room.id, title: "Emma", mode: "MAIL_COPILOT" } as never);
  const web = c.store.createPane({ roomId: c.room.id, title: "Web", mode: "BROWSER" } as never);
  c.controller.inspect.mockImplementation(async (p: any) => ({ paneId: p.id, title: p.title, state: "IDLE", text: "Inbox: 3 new", checkedAt: new Date().toISOString(), tasks: [] }));
  const [copilot] = await c.service.inspect(actor, { roomId: c.room.id, paneId: mail.id, section: "CONTENT", offset: 0, limit: 1 }) as any[];
  expect(copilot).toMatchObject({ paneId: mail.id, text: "Inbox: 3 new" });
  expect(copilot.supported).toBeUndefined();
  const [browser] = await c.service.inspect(actor, { roomId: c.room.id, paneId: web.id, section: "CONTENT", offset: 0, limit: 1 }) as any[];
  expect(browser).toMatchObject({ paneId: web.id, supported: false, reason: "Native content adapter is unavailable for this pane type." });
 });
 it("inspect CONTENT asks the pane for its colour runs only when styled (SpaceApp Android R9)", async () => {
  const c = fixture(), pane = c.panes[0]!;
  await c.service.inspect(actor, { roomId: c.room.id, paneId: pane.id, section: "CONTENT", offset: 0, limit: 1 });
  expect(c.controller.inspect).toHaveBeenLastCalledWith(expect.objectContaining({ id: pane.id }));
  await c.service.inspect(actor, { roomId: c.room.id, paneId: pane.id, section: "CONTENT", offset: 0, limit: 1, styled: true });
  expect(c.controller.inspect).toHaveBeenLastCalledWith(expect.objectContaining({ id: pane.id }), { styled: true });
  await c.service.inspect(actor, { roomId: c.room.id, paneId: pane.id, section: "MODELS", offset: 0, limit: 1, styled: true });
  expect(c.controller.inspect).toHaveBeenLastCalledWith(expect.objectContaining({ id: pane.id }));
 });
 it("space_test_mcp_tools counts the room's open panes from the STATE answer",async()=>{
  const c=fixture();c.store.updatePane(c.panes[0]!.id,{isClosed:true,status:"CLOSED"});
  const report=await c.service.testMcpTools(actor,c.room.id,{tools:["space_inspect:STATE"]}) as any;
  expect(report.results[0]).toMatchObject({status:"PASS",details:{totalOpenPanes:2,paneCap:c.room.paneCap}});
 });
});
