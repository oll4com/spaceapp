import { createHash } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { z } from "zod";
import { controlExecuteSchema, controlLayoutSchema, controlOperationSchema, controlScheduleSchema, controlToolSchemas, controlToolDescriptions, controlResourceOperations, SPACE_CONTROL_VERSION,
  type ControlAction, type ControlExecute, type ControlInspect, type ControlLayout, type ControlOperation, type ControlResult, type ControlTarget,
  type ControlSchedule, type Pane, type AuthUser } from "@space/contracts";
import type { ControlRecord, ControlRepository } from "@space/db";
import { makeSpaceId, nowIso, SpaceConflictError, redactMemoryText, type SpaceStore } from "@space/runtime";
import type { RoomPaneController } from "./room-pane-control.js";

export interface ControlActor {id:string; role:AuthUser["role"]}
export interface ControlClientCommand {id:string; actorId:string; roomId:string; action:ControlAction; expiresAt:number; clientId:string; result?:{ok:boolean;evidence:Record<string,unknown>}}
function required<T>(value:T|undefined|null,message:string):T {if(value===undefined||value===null)throw new SpaceConflictError(message);return value;}
function hash(value:unknown){return createHash("sha256").update(JSON.stringify(value)).digest("hex");}
export function supportsControlRuntime(pane: Pane) { return pane.mode !== "TERMINAL" || pane.terminalRuntimeId === "cli:codex"; }
function assertControlRuntime(pane: Pane) {
 if (!supportsControlRuntime(pane)) throw new SpaceConflictError("Native controls for this CLI are scheduled for phase two. Phase one supports Codex CLI.");
}
export function createSpaceControl(options:{store:SpaceStore;repository:ControlRepository;controller:RoomPaneController;
  publish(roomId:string):Promise<void>;
  send(pane:Pane,text:string,traceId:string):Promise<unknown>;
  closePane?(actor:ControlActor,pane:Pane,traceId:string):Promise<unknown>;
  resolveActor?(id:string):Promise<ControlActor>;
  checkQuota?(pane:Pane):Promise<{allowed:boolean;reason:string;resetAt?:string}>;
  requireClientAcknowledgement?:boolean;
  integration?(actor:ControlActor,roomId:string,action:ControlAction):Promise<unknown>;
  inspectExtra?(actor:ControlActor,input:ControlInspect):Promise<unknown>;
}) {
 const {store,repository,controller}=options;
 const active=new Map<string,Promise<void>>();
 // Nested native adapters must share the same room critical section, including
 // authenticated internal HTTP calls. Expired contexts cannot bypass the lock.
 const roomContext=new AsyncLocalStorage<{roomId:string;held:boolean}>();
 async function withRoomLock<T>(roomId:string,work:()=>Promise<T>):Promise<T>{
  const context=roomContext.getStore();
  if(context?.held&&context.roomId===roomId)return work();
  return repository.withLock(`room:${roomId}`,async()=>{
   const scope={roomId,held:true};
   try{return await roomContext.run(scope,work);}finally{scope.held=false;}
  });
 }
 async function withOperatorMutation<T>(pane:Pane,work:()=>Promise<T>):Promise<T>{
  return withRoomLock(pane.roomId,async()=>{await rememberStop(pane);return work();});
 }
 const clients=new Map<string,{actorId:string;roomId:string;lastSeen:number;targets:unknown[];geometry:unknown}>();
 const clientCommands=new Map<string,ControlClientCommand>();
 let timer:ReturnType<typeof setInterval>|undefined;
 const activeRoom=(roomId:string)=>store.getRoom(roomId);
 const layoutRecord=(roomId:string)=>repository.get("layout","shared",roomId);
 const writeValue=async(kind:ControlRecord["kind"],actorId:string,key:string,roomId:string,value:unknown,version:number)=>{
   if(!await repository.write({kind,actorId,key,roomId,value,version:version+1},version))throw new SpaceConflictError("Control state changed; inspect again.");
 };
 async function updateRecord(kind:ControlRecord["kind"],actorId:string,key:string,change:(value:unknown)=>unknown){
  for(let attempt=0;attempt<16;attempt++){
   const old=required(await repository.get(kind,actorId,key),"Control record disappeared.");
   const next={...old,value:change(old.value)};
   if(await repository.write(next,old.version))return next.value;
  }
  throw new SpaceConflictError("Concurrent control updates did not settle.");
 }
 const lastCli=async(pane:Pane)=>await store.getActivePaneCliSession(pane.id)??(await store.listPaneCliSessions(pane.id,1))[0]??null;
 async function rememberStop(pane:Pane){
  await withRoomLock(pane.roomId,async()=>{
   const old=await repository.get("pane_state","shared",pane.id);
   await writeValue("pane_state","shared",pane.id,pane.roomId,{stoppedAt:nowIso()},old?.version??0);
  });
 }
 async function state(roomId:string){
  const [room,panes,saved]=await Promise.all([activeRoom(roomId),store.listPanes(roomId,true),layoutRecord(roomId)]);
  const entries=await Promise.all(panes.map(async pane=>{
   const cli=pane.mode==="TERMINAL"?await lastCli(pane):null;
   const chat=pane.mode==="CHAT"?await store.getActiveSpaceAgentSession(pane.id):null;
   return {id:pane.id,title:pane.title,mode:pane.mode,runtimeId:pane.terminalRuntimeId??pane.providerId,order:pane.order,columnSpan:pane.columnSpan,
    nativeControlSupported:supportsControlRuntime(pane),isClosed:pane.isClosed,isMinimized:pane.isMinimized,isMaximized:pane.isMaximized,createdAt:pane.createdAt,updatedAt:pane.updatedAt,
    sessionId:cli?.sessionId??chat?.sessionId??null,sessionStartedAt:cli?.startedAt??chat?.createdAt??null,
    nativeTaskRef:cli?.codexThreadId??chat?.threadId??null,modelId:cli?.modelId??chat?.selectedModelId??pane.modelId,
    status:cli?.status??chat?.status??pane.status,statusReason:cli?.statusReason??null};
  }));
  return {version:SPACE_CONTROL_VERSION,room,panes:entries,layout:saved?.value??null,
   revision:hash([room.updatedAt,entries,saved?.version??0]),checkedAt:nowIso()};
 }
 async function select(roomId:string,target:ControlTarget){
  const panes=await store.listPanes(roomId,true);
  if(target.paneIds && target.paneIds.some(id=>!panes.some(p=>p.id===id)))throw new SpaceConflictError("A selected pane is not in this room.");
  const selected=panes.filter(p=>(!target.paneIds||target.paneIds.includes(p.id))&&(!target.runtimeId||p.terminalRuntimeId===target.runtimeId)&&
   (target.state==="ALL"||target.state==="CLOSED"?target.state==="ALL"||p.isClosed:!p.isClosed));
  if(target.state!=="STOPPED"&&target.state!=="RUNNING")return selected;
  return (await Promise.all(selected.map(async p=>({p,s:await controller.inspect(p)})))).filter(({s})=>target.state==="RUNNING"?s.state==="RUNNING":["EXITED","ERROR","IDLE","WAITING_FOR_INPUT"].includes(s.state)).map(({p})=>p);
 }
 async function inspect(actor:ControlActor,input:ControlInspect):Promise<unknown>{
  await activeRoom(input.roomId);
  if(input.section==="STATE")return {...await state(input.roomId),clients:[...clients.entries()].filter(([,c])=>c.actorId===actor.id&&c.roomId===input.roomId&&c.lastSeen>Date.now()-10000).map(([id,c])=>({id,targets:c.targets,geometry:c.geometry}))};
  if(input.section==="CLIPBOARD")return store.listClipboardItems(actor.id,{page:Math.floor(input.offset/input.limit)+1,pageSize:input.limit,...(input.query?{q:input.query}:{})});
  if(input.section==="CONTENT"||input.section==="MODELS"){
   const panes=await select(input.roomId,{paneIds:input.paneId?[input.paneId]:undefined,state:"ALL"});
   return Promise.all(panes.slice(input.offset,input.offset+input.limit).map(async pane=>{
    if(!supportsControlRuntime(pane))return {paneId:pane.id,supported:false,reason:"CLI adapter deferred to phase two."};
    if(!["TERMINAL","CHAT"].includes(pane.mode))return {paneId:pane.id,supported:false,reason:"Native content adapter is unavailable for this pane type."};
    try{const observation=await controller.inspect(pane);if(input.section==="MODELS"){const {text,...metadata}=observation;return metadata;}return observation;}
    catch(error){return {paneId:pane.id,state:"UNKNOWN",reason:message(error)};}
   }));
  }
  return options.inspectExtra?options.inspectExtra(actor,input):{supported:false,section:input.section};
 }
 function message(error:unknown){return redactMemoryText(error instanceof Error?error.message:"Control failed.").slice(0,2000);}
 function registerClient(actor:ControlActor,roomId:string,clientId:string,targets:unknown[],geometry:unknown){
  const existing=clients.get(clientId);if(existing&&existing.actorId!==actor.id)throw new SpaceConflictError("Client belongs to another actor.");
  clients.set(clientId,{actorId:actor.id,roomId,lastSeen:Date.now(),targets,geometry});
  for(const [id,c] of clients)if(c.lastSeen<Date.now()-60000)clients.delete(id);
  return [...clientCommands.values()].filter(c=>c.actorId===actor.id&&c.roomId===roomId&&c.clientId===clientId&&!c.result&&c.expiresAt>Date.now()).map(({actorId,...c})=>c);
 }
 function unregisterClient(actor:ControlActor,clientId:string){if(clients.get(clientId)?.actorId===actor.id)clients.delete(clientId);return {released:true};}
 function acknowledge(actor:ControlActor,clientId:string,id:string,result:{ok:boolean;evidence:Record<string,unknown>}){
  const command=required(clientCommands.get(id),"Client command expired.");
  if(command.actorId!==actor.id||command.clientId!==clientId)throw new SpaceConflictError("Only the selected client can acknowledge this command.");
  if(!command.result && command.expiresAt>Date.now())command.result=result;
  return {accepted:Boolean(command.result)};
 }
 async function clientAction(actor:ControlActor,roomId:string,action:ControlAction){
  const current=[...clients.entries()].filter(([,c])=>c.actorId===actor.id&&c.roomId===roomId&&c.lastSeen>Date.now()-2500);
  if(current.length!==1)throw new SpaceConflictError(current.length?"Multiple active clients; focus one Space tab to target its controls.":"No active Space client is available.");
  const command:ControlClientCommand={id:makeSpaceId("control_client"),actorId:actor.id,roomId,action,clientId:current[0]![0],expiresAt:Date.now()+8000};
  clientCommands.set(command.id,command);
  try{
   while(Date.now()<command.expiresAt&&!command.result)await new Promise(r=>setTimeout(r,50));
   if(!command.result)return {status:"UNKNOWN" as const,detail:"Client acknowledgement was not received; the action will not be repeated.",evidence:{commandId:command.id}};
   return {status:command.result.ok?"COMPLETED" as const:"FAILED" as const,detail:command.result.ok?"Client confirmed the control.":"Client could not apply the control.",evidence:command.result.evidence};
  }finally{clientCommands.delete(command.id);}
 }
 async function saveLayout(roomId:string,value:unknown){const old=await layoutRecord(roomId);await writeValue("layout","shared",roomId,roomId,value,old?.version??0);await options.publish(roomId);}
 async function action(actor:ControlActor,command:ControlExecute,spec:ControlAction,index:number):Promise<ControlResult[]>{
  const roomId=command.roomId, traceId=command.requestId;
  const done=(evidence:unknown,detail="Control applied."):ControlResult[]=>[{index,status:"COMPLETED",detail,evidence:{result:evidence}}];
  if(spec.kind==="room"){
   if(spec.operation==="rename"){const result=await store.updateRoom(roomId,{name:required(spec.name,"Room name is required.")},traceId);await options.publish(roomId);return done(result);}
   if(spec.operation==="create")return done(await store.createRoom({name:required(spec.name,"Room name is required."),initialPaneCount:0},traceId));
   if(spec.operation==="activate")await activeRoom(required(spec.targetRoomId,"Target room ID is required."));
   return [{index,...await clientAction(actor,roomId,spec)}];
  }
  if(spec.kind==="playback"){
   if(spec.operation==="volume"&&(spec.value===undefined||spec.value>100))throw new SpaceConflictError("Volume must be between 0 and 100.");
   if(spec.operation==="seek")required(spec.value,"Seek position is required.");
   return [{index,...await clientAction(actor,roomId,spec)}];
  }
  if(spec.kind==="clipboard"){
   if(spec.operation==="save")return done(await store.upsertClipboardItem({ownerUserId:actor.id,text:required(spec.text,"Clipboard text is required."),source:spec.source,...(spec.title?{title:spec.title}:{})}));
   if(spec.operation==="complete")return done(await store.setClipboardItemCompleted(actor.id,required(spec.id,"Clipboard ID is required."),required(spec.completed,"Completion value is required.")));
   return done(await store.deleteClipboardItem(actor.id,required(spec.id,"Clipboard ID is required.")));
  }
  if(spec.kind==="layout"){
   const applied=async(evidence:unknown)=>{
    if(!options.requireClientAcknowledgement)return done(evidence,"Layout persisted.");
    const confirmation=await clientAction(actor,roomId,spec);
    return [{index,...confirmation,evidence:{...confirmation.evidence,persisted:evidence}}];
   };
   const before=await state(roomId),open=before.panes.filter(p=>!p.isClosed).sort((a,b)=>a.order-b.order);
   if(spec.operation==="save"){
    const id=makeSpaceId("layout_snapshot");await writeValue("snapshot",actor.id,id,roomId,{layout:before.layout,order:open.map(p=>p.id),columns:before.room.paneLayoutColumns},0);return done({snapshotId:id});
   }
   if(spec.operation==="restore"){
    const snapshot=required(await repository.get("snapshot",actor.id,required(spec.snapshotId,"Snapshot ID is required.")),"Snapshot not found.");
    if(snapshot.roomId!==roomId)throw new SpaceConflictError("Snapshot belongs to another room.");
    const value=snapshot.value as {layout:ControlLayout|null;order:string[];columns:1|2|3|4|null};
    if(value.order.length!==open.length||value.order.some(id=>!open.some(p=>p.id===id)))throw new SpaceConflictError("Pane membership changed; snapshot cannot be applied.");
    await store.reorderPanes(roomId,value.order,traceId);await store.updateRoomPaneLayout(roomId,{paneLayoutColumns:value.columns},traceId);await saveLayout(roomId,value.layout);return applied({snapshotId:spec.snapshotId});
   }
   if(spec.operation==="sort"){
    let values=new Map<string,string|null>();
    if(spec.sortBy==="taskStartedAt")for(const pane of await select(roomId,{state:"OPEN"})){try{const o=await controller.inspect(pane);values.set(pane.id,o.tasks.at(-1)?.timing.startedAt??null);}catch{values.set(pane.id,null);}}
    const key=(p:typeof open[number])=>spec.sortBy==="taskStartedAt"?values.get(p.id):p[spec.sortBy];
    open.sort((a,b)=>{const x=key(a),y=key(b);if(!x||!y)return x?-1:y?1:a.order-b.order;return (String(x).localeCompare(String(y))*(spec.direction==="asc"?1:-1))||a.order-b.order;});
    await store.reorderPanes(roomId,open.map(p=>p.id),traceId);await saveLayout(roomId,null);return applied({order:open.map(p=>p.id)});
   }
   let layout:ControlLayout;
   if(spec.operation==="tree"){
    let cursor=0,row=0;const placements:ControlLayout["placements"]=[];
    while(cursor<open.length){const count=Math.min(row+1,open.length-cursor);const width=Math.min(26,90/count);const start=(100-count*width)/2;
     for(let i=0;i<count;i++)placements.push({paneId:open[cursor++]!.id,x:start+i*width,y:row*28,width:width-1,height:27});row++;}
    layout={mode:"CUSTOM",columns:2,placements};
   }else layout=controlLayoutSchema.parse(required(spec.layout,"Layout is required."));
   if(layout.mode==="CUSTOM"&&(layout.placements.length!==open.length||layout.placements.some(p=>!open.some(o=>o.id===p.paneId))))throw new SpaceConflictError("Custom layout must place every open pane exactly once.");
   if(layout.mode==="GRID")await store.updateRoomPaneLayout(roomId,{paneLayoutColumns:layout.columns as 1|2|3|4},traceId);
   await saveLayout(roomId,layout);return applied({layout});
  }
  if(spec.kind==="cli"||spec.kind==="vpn"||spec.kind==="resource") {
   if ((spec.kind === "cli" || spec.kind === "vpn") && spec.runtimeId !== "cli:codex") throw new SpaceConflictError("Phase one runtime management targets cli:codex only.");
   const result=await required(options.integration,"Runtime management is unavailable.")(actor,roomId,spec);
   const outcome=result as {status?:string;isError?:boolean;ok?:boolean}|null;
   if(outcome?.isError || outcome?.ok===false || ["BLOCKED","APPROVAL_REQUIRED","FAILED","ERROR"].includes(outcome?.status??""))
    return [{index,status:"FAILED",detail:"The protected adapter did not complete this control.",evidence:{result}}];
   return done(result);
  }
  const panes=await select(roomId,spec.target);
  if(!panes.length)throw new SpaceConflictError("No panes match this selection.");
  const results:ControlResult[]=[];
  for(let offset=0;offset<panes.length;offset+=4){
   results.push(...await Promise.all(panes.slice(offset,offset+4).map(async original=>{
    const paneId=original.id;
    try{
     let pane=await store.getPane(paneId);
     if(spec.kind!=="pane" || !["rename","minimize","maximize","restore","focus"].includes(spec.operation))assertControlRuntime(pane);
     let evidence:unknown;
     if(spec.kind==="pane"&&["rename","minimize","maximize","restore"].includes(spec.operation)){
      evidence=await store.updatePane(pane.id,spec.operation==="rename"?{title:required(spec.text,"Pane title is required.")}:
       spec.operation==="minimize"?{isMinimized:true,isMaximized:false}:spec.operation==="maximize"?{isMaximized:true,isMinimized:false}:{isMinimized:false,isMaximized:false},traceId);
     }else if(spec.kind==="pane"&&spec.operation==="focus")return {index,paneId,...await clientAction(actor,roomId,{...spec,target:{paneIds:[paneId],state:"ALL"}})};
     else if(spec.kind==="pane"&&spec.operation==="close"){
      await rememberStop(pane);
      if(options.closePane)evidence=await options.closePane(actor,pane,traceId);
      else {
       if(["CHAT","TERMINAL"].includes(pane.mode))await controller.interrupt(pane,traceId);
       evidence=await store.updatePane(pane.id,{isClosed:true,status:"CLOSED"},traceId);
      }
     }else if(spec.kind==="pane"&&["reopen","restart","resume","start"].includes(spec.operation)){
      const priorSession=pane.mode==="TERMINAL"?await lastCli(pane):null;
      if(pane.isClosed)pane=await store.updatePane(pane.id,{isClosed:false,status:"IDLE"},traceId);
      if(!["TERMINAL","CHAT"].includes(pane.mode))evidence=pane;
      else if(pane.mode==="CHAT"&&["reopen","start"].includes(spec.operation))evidence=await controller.start(pane,traceId);
      else if(spec.operation==="start"&&!priorSession?.cliTaskId)evidence=await controller.start(pane,traceId);
      else if(spec.operation==="reopen"&&priorSession?.isActive&&!["ERROR","EXITED"].includes(priorSession.status))evidence=await controller.start(pane,traceId);
      else evidence=await controller.resume(pane,priorSession?.cliTaskId??undefined,traceId);
      if(pane.mode==="TERMINAL"){
       const observed=await controller.inspect(pane);
       if(priorSession?.codexThreadId&&observed.nativeTaskRef!==priorSession.codexThreadId)
        return {index,paneId,status:"UNKNOWN" as const,detail:"The original native task has not been confirmed after resume.",evidence:{result:evidence}};
       if(["EXITED","ERROR","UNKNOWN"].includes(observed.state))return {index,paneId,status:"UNKNOWN" as const,detail:"CLI readiness has not been confirmed.",evidence:{result:evidence}};
      }
     }else{
      const observed=await controller.inspect(pane);
      if(spec.kind==="pane"&&spec.operation==="stop"){
       await rememberStop(pane);evidence=await controller.interrupt(pane,traceId);
       const after=await controller.inspect(pane);
       if(after.state==="RUNNING"||after.state==="UNKNOWN")return {index,paneId,status:"UNKNOWN" as const,detail:"Native stop is not yet confirmed.",evidence:{result:evidence}};
      }
      else if(spec.kind==="pane"&&spec.operation==="continue"){
       if(observed.state==="RUNNING")throw new SpaceConflictError("The pane is already running; continue was not submitted twice.");
       if(observed.state==="UNKNOWN")throw new SpaceConflictError("Native state is unknown; inspect before continuing.");
       if(pane.mode==="TERMINAL"){
        if(["EXITED","ERROR"].includes(observed.state)){
         const previous=await lastCli(pane);if(!previous?.cliTaskId)throw new SpaceConflictError("Native task identity is unavailable.");
         await controller.resume(pane,previous.cliTaskId,traceId);
         const ready=await controller.inspect(pane);
         if(ready.nativeTaskRef!==previous.codexThreadId||ready.state!=="IDLE")throw new SpaceConflictError("The same native task is not ready to continue.");
        }
        evidence=await options.send(pane,spec.text??"Continue the existing approved task from its last completed step.",traceId);
       }else evidence=await controller.resume(pane,undefined,traceId);
      }else if(spec.kind==="pane"&&spec.operation==="prompt"){
       if(observed.state==="RUNNING"&&spec.when==="AFTER_TURN"){
        const scheduled=await defer(actor,command,{...spec,target:{paneIds:[paneId],state:"OPEN"},when:"NOW"});
        return {index,paneId,status:"PENDING" as const,detail:"Prompt scheduled after the current native turn.",evidence:{scheduleId:scheduled.id}};
       }
       if(observed.state!=="IDLE"&&observed.state!=="WAITING_FOR_INPUT")throw new SpaceConflictError("The pane is not confirmed ready for input.");
       evidence=await options.send(pane,required(spec.text,"Prompt text is required."),traceId);
      }else{
       const when=spec.when;
       if(observed.state==="UNKNOWN")throw new SpaceConflictError("Native state is unknown.");
       if(when==="AFTER_TURN"&&observed.state==="RUNNING"){
        const scheduled=await defer(actor,command,{...spec,target:{paneIds:[paneId],state:"OPEN"},when:"NOW"});
        return {index,paneId,status:"PENDING" as const,detail:"Change scheduled after the current native turn.",evidence:{scheduleId:scheduled.id}};
       }
       const expectedSessionId=required(observed.sessionId,"Pane has no active session.");
       if(spec.kind==="configure")evidence=await controller.configure(pane,{type:"configure_pane",paneId,expectedSessionId,...spec},traceId);
       else if(spec.kind==="native_command")evidence=await controller.command(pane,{type:"cli_command",paneId,expectedSessionId,command:spec.command,when},traceId);
       else throw new SpaceConflictError("Unsupported pane control.");
      }
     }
     if((evidence as {status?:string}|null)?.status==="UNKNOWN")return {index,paneId,status:"UNKNOWN" as const,detail:"The control was submitted but native execution is unconfirmed.",evidence:{result:evidence}};
     return {index,paneId,status:"COMPLETED" as const,detail:"Pane control applied.",evidence:{result:evidence}};
    }catch(error){return {index,paneId,status:"FAILED" as const,detail:message(error),evidence:{}};}
   })));
  }
  await options.publish(roomId);return results;
 }
 async function operation(actor:ControlActor,roomId:string,id:string){const record=required(await repository.get("operation",actor.id,id),"Operation not found.");if(record.roomId!==roomId)throw new SpaceConflictError("Operation belongs to another room.");return controlOperationSchema.parse(record.value);}
 async function execute(actor:ControlActor,raw:ControlExecute,waitForCompletion=false){
  const command=controlExecuteSchema.parse(raw);await activeRoom(command.roomId);
  if(actor.role!=="ADMIN")throw new SpaceConflictError("Space control requires the operator ADMIN role.");
  const key=hash([command.roomId,command.requestId]),payloadHash=hash(command),previous=await repository.get("operation",actor.id,key);
  if(previous){const value=controlOperationSchema.parse(previous.value);if(value.payloadHash!==payloadHash)throw new SpaceConflictError("Request ID was reused with a different payload.");return value;}
  const initial:ControlOperation={id:key,actorId:actor.id,roomId:command.roomId,requestId:command.requestId,payloadHash,status:"RUNNING",createdAt:nowIso(),updatedAt:nowIso(),results:[],cancelRequested:false,command,nextIndex:0};
  if(!await repository.write({kind:"operation",actorId:actor.id,key,roomId:command.roomId,version:1,value:initial},0))return execute(actor,raw,waitForCompletion);
  return drive(actor,command,key,waitForCompletion);
 }
 async function drive(actor:ControlActor,command:ControlExecute,key:string,waitForCompletion=false){
  const work=withRoomLock(command.roomId,async()=>{
   try{
    const initial=await operation(actor,command.roomId,key);
    if(initial.status!=="RUNNING"||initial.results.some(r=>r.status==="PENDING"))return;
    if(options.resolveActor)await options.resolveActor(actor.id);
    if(initial.nextIndex===0&&command.expectedRevision&&(await state(command.roomId)).revision!==command.expectedRevision)throw new SpaceConflictError("Room state changed before execution.");
    for(const [index,spec] of command.actions.entries()){
     if(index<initial.nextIndex)continue;
     const current=await operation(actor,command.roomId,key);if(current.cancelRequested)break;
     let results:ControlResult[];
     try{results=await action(actor,command,spec,index);}catch(error){results=[{index,status:"FAILED",detail:message(error),evidence:{}}];}
     await updateRecord("operation",actor.id,key,raw=>{
      const latest=controlOperationSchema.parse(raw);
      if(latest.status!=="RUNNING")return latest;
      latest.results.push(...results);latest.nextIndex=index+1;latest.updatedAt=nowIso();return latest;
     });
     if(results.some(r=>["FAILED","UNKNOWN","PENDING"].includes(r.status)))break;
    }
    await updateRecord("operation",actor.id,key,raw=>{
     const value=controlOperationSchema.parse(raw);
     if(value.status==="RUNNING"){value.status=outcome(value);value.updatedAt=nowIso();}return value;
    });
   }catch(error){
    await updateRecord("operation",actor.id,key,raw=>{
     const value=controlOperationSchema.parse(raw);
     if(value.status!=="RUNNING")return value;
     value.status=value.cancelRequested?"CANCELLED":"FAILED";
     value.results.push({index:value.results.length,status:"FAILED",detail:message(error),evidence:{}});value.updatedAt=nowIso();return value;
    });
   }
  });
  active.set(key,work);
  void work.finally(()=>active.delete(key)).catch(()=>{});
  if(waitForCompletion){await work;return operation(actor,command.roomId,key);}
  let timeout:ReturnType<typeof setTimeout>|undefined;
  try{await Promise.race([work,new Promise(r=>{timeout=setTimeout(r,2200);})]);}finally{if(timeout)clearTimeout(timeout);}
  return operation(actor,command.roomId,key);
 }
 function outcome(value:ControlOperation):ControlOperation["status"]{
  return value.cancelRequested?"CANCELLED":value.results.some(r=>r.status==="CANCELLED")?(value.results.some(r=>r.status==="COMPLETED")?"PARTIAL":"CANCELLED"):value.results.some(r=>r.status==="PENDING")?"RUNNING":
   value.results.some(r=>r.status==="UNKNOWN")?"UNKNOWN":value.results.some(r=>r.status==="FAILED")?
    value.results.some(r=>r.status==="COMPLETED")?"PARTIAL":"FAILED":value.command&&value.nextIndex<value.command.actions.length?"RUNNING":"COMPLETED";
 }
 async function operations(actor:ControlActor,roomId:string,id?:string,cancel=false){
  if(!id)return (await repository.list("operation",actor.id,roomId)).map(r=>r.value);
  await operation(actor,roomId,id);
  if(cancel){
   await updateRecord("operation",actor.id,id,raw=>{
    const value=controlOperationSchema.parse(raw);if(value.status==="RUNNING")value.cancelRequested=true;return value;
   });
   for(const record of await repository.list("schedule",actor.id,roomId)){
    const value=controlScheduleSchema.parse(record.value);
    if(value.parentOperationId===id&&value.status==="SCHEDULED")await schedules(actor,roomId,"cancel",value.id);
   }
  }
  return operation(actor,roomId,id);
 }
 async function createSchedule(actor:ControlActor,roomId:string,input:ControlExecute,dueAt:string,condition:"AT_TIME"|"AFTER_TURN",parentOperationId?:string){
  if(input.roomId!==roomId)throw new SpaceConflictError("Schedule room mismatch.");
  const expectedTasks:Record<string,string|null>={},expectedModels:Record<string,string|null>={},stopVersions:Record<string,number>={};
  const actions:ControlAction[]=[];
  for(const spec of input.actions){
   if(!("target" in spec)||typeof spec.target!=="object")throw new SpaceConflictError("Schedules require pane targets.");
   const panes=await select(roomId,spec.target);
   if(!panes.length)throw new SpaceConflictError("No panes match this schedule.");
   for(const pane of panes){
    assertControlRuntime(pane);
    if(pane.mode!=="CHAT"&&(pane.mode!=="TERMINAL"||pane.terminalRuntimeId!=="cli:codex"))throw new SpaceConflictError("Schedules require Chat or Codex CLI panes.");
    const observed=await controller.inspect(pane);
    if(!observed.nativeTaskRef||!observed.modelId)throw new SpaceConflictError("A native task and model must be confirmed before scheduling.");
    expectedTasks[pane.id]=observed.nativeTaskRef;expectedModels[pane.id]=observed.modelId;
    stopVersions[pane.id]=(await repository.get("pane_state","shared",pane.id))?.version??0;
   }
   actions.push({...spec,target:{paneIds:panes.map(p=>p.id),state:"ALL"}} as ControlAction);
  }
  const value=controlScheduleSchema.parse({id:makeSpaceId("control_schedule"),actorId:actor.id,roomId,dueAt,
   command:{...input,actions,expectedRevision:undefined},status:"SCHEDULED",condition,parentOperationId,expectedTasks,expectedModels,stopVersions,createdAt:nowIso()});
  value.command.requestId=`schedule:${value.id}`;
  await writeValue("schedule",actor.id,value.id,roomId,value,0);return value;
 }
 async function defer(actor:ControlActor,command:ControlExecute,spec:ControlAction){
  return createSchedule(actor,command.roomId,{...command,actions:[spec]},nowIso(),"AFTER_TURN",hash([command.roomId,command.requestId]));
 }
 async function schedules(actor:ControlActor,roomId:string,op:string,id?:string,dueAt?:string,command?:ControlExecute){
  await activeRoom(roomId);
  if(op==="list")return (await repository.list("schedule",actor.id,roomId)).map(r=>r.value);
  if(op==="cancel"){
   const record=required(await repository.get("schedule",actor.id,required(id,"Schedule ID is required.")),"Schedule not found.");
   if(record.roomId!==roomId)throw new SpaceConflictError("Schedule belongs to another room.");
   return withRoomLock(roomId,()=>updateRecord("schedule",actor.id,record.key,raw=>{
    const value=controlScheduleSchema.parse(raw);if(value.status==="SCHEDULED")value.status="CANCELLED";return value;
   }));
  }
  const input=controlExecuteSchema.parse(required(command,"Scheduled command is required."));
  if(input.actions.some(a=>a.kind!=="pane"||!["continue","resume"].includes(a.operation)))throw new SpaceConflictError("Explicit schedules accept native resume/continue actions only.");
  const time=required(dueAt,"Schedule time is required.");if(Date.parse(time)<=Date.now())throw new SpaceConflictError("Schedule must be in the future.");
  return withRoomLock(roomId,()=>createSchedule(actor,roomId,input,time,"AT_TIME"));
 }
 async function recover(){
  for(const record of await repository.list("operation",null)){
   await withRoomLock(record.roomId,async()=>{
    await updateRecord("operation",record.actorId,record.key,raw=>{
     const value=controlOperationSchema.parse(raw);
     if(value.status==="RUNNING"&&!value.results.some(r=>r.status==="PENDING")){
      value.status="UNKNOWN";value.updatedAt=nowIso();value.results.push({index:value.results.length,status:"UNKNOWN",detail:"Server restarted during execution. Inspect before issuing a new request; effects were not replayed.",evidence:{}});
     }
     return value;
    });
   });
  }
 }
 async function advanceSchedule(saved:ControlRecord){
  return withRoomLock(saved.roomId,async()=>{
  const record=required(await repository.get("schedule",saved.actorId,saved.key),"Schedule disappeared.");
  let value=controlScheduleSchema.parse(record.value);
  if(!["SCHEDULED","RUNNING"].includes(value.status)||Date.parse(value.dueAt)>Date.now())return;
  try{
   if(!options.resolveActor)throw new SpaceConflictError("Operator authorization cannot be refreshed.");
   const actor=await options.resolveActor(value.actorId);
   if(actor.role!=="ADMIN")throw new SpaceConflictError("Operator authorization was revoked.");
   // A crash after claiming a schedule but before creating its operation must
   // revalidate every binding. An existing receipt is observed, never replayed.
   const existing=await repository.get("operation",actor.id,hash([value.roomId,value.command.requestId]));
   if(!existing){
    for(const [paneId,nativeTask] of Object.entries(value.expectedTasks)){
     const pane=await store.getPane(paneId);
     if(pane.roomId!==value.roomId||pane.isClosed)throw new SpaceConflictError("Scheduled pane moved or was closed.");
     if(((await repository.get("pane_state","shared",paneId))?.version??0)!==value.stopVersions[paneId])throw new SpaceConflictError("A newer operator stop superseded this schedule.");
     const observed=await controller.inspect(pane);
     if(observed.nativeTaskRef!==nativeTask||observed.modelId!==value.expectedModels[paneId])throw new SpaceConflictError("Scheduled native task or model changed.");
     if(observed.state==="RUNNING")return;
     if(observed.state==="UNKNOWN"||observed.state==="WAITING_FOR_INPUT")throw new SpaceConflictError("Native task is not confirmed ready for scheduled continuation.");
     if(value.condition==="AT_TIME"){
      const quota=await options.checkQuota?.(pane);
      if(!quota?.allowed)throw new SpaceConflictError(quota?.reason??"Native quota evidence is unavailable; automatic continuation was withheld.");
     }
    }
    value.status="RUNNING";
    if(!await repository.write({...record,value},record.version))return;
   }
   const result=existing?controlOperationSchema.parse(existing.value):await execute(actor,value.command,true);
   value.operationId=result.id;
   value.status=result.status==="RUNNING"?"RUNNING":result.status==="COMPLETED"?"COMPLETED":result.status==="CANCELLED"?"CANCELLED":"BLOCKED";
   value.reason=value.status==="BLOCKED"?result.results.map(r=>r.detail).join("\n").slice(0,2000):null;
  }catch(error){value.status="BLOCKED";value.reason=message(error);}
  await updateRecord("schedule",record.actorId,record.key,raw=>{
   const latest=controlScheduleSchema.parse(raw);return latest.status==="CANCELLED"?latest:value;
  });
  });
 }
 let ticking=false;
 async function tick(){
  if(ticking)return;ticking=true;
  try{
   for(const record of await repository.list("schedule",null)){
    if(!["SCHEDULED","RUNNING"].includes(controlScheduleSchema.parse(record.value).status))continue;
    const fresh=await repository.get("schedule",record.actorId,record.key);if(fresh)await advanceSchedule(fresh);
   }
   for(const record of await repository.list("operation",null)){
    const value=controlOperationSchema.parse(record.value);if(value.status!=="RUNNING")continue;
    if(!value.results.some(r=>r.status==="PENDING")){
     if(value.command&&!active.has(value.id)&&options.resolveActor)await drive(await options.resolveActor(value.actorId),value.command,value.id);
     continue;
    }
    const resolved=new Map<string,ControlResult>();
    for(const result of value.results.filter(r=>r.status==="PENDING")){
     const id=result.evidence.scheduleId;if(typeof id!=="string")continue;
     const saved=await repository.get("schedule",record.actorId,id);if(!saved)continue;
     const schedule=controlScheduleSchema.parse(saved.value);
     if(["COMPLETED","CANCELLED","BLOCKED"].includes(schedule.status))resolved.set(id,{...result,status:schedule.status==="COMPLETED"?"COMPLETED":schedule.status==="CANCELLED"?"CANCELLED":"FAILED",detail:schedule.reason??"Scheduled control settled.",evidence:{...result.evidence,operationId:schedule.operationId}});
    }
    if(resolved.size)await updateRecord("operation",record.actorId,record.key,raw=>{
     const current=controlOperationSchema.parse(raw);current.results=current.results.map(r=>resolved.get(String(r.evidence.scheduleId))??r);current.status=outcome(current);current.updatedAt=nowIso();return current;
    });
   }
  }finally{ticking=false;}
 }
 return {state,inspect,execute,operations,schedules,tick,rememberStop,withOperatorMutation,registerClient,unregisterClient,acknowledge,layout:async(roomId:string)=>(await layoutRecord(roomId))?.value??null,
  capabilities:async(roomId:string)=>{
   await activeRoom(roomId);const catalog=await controller.catalog(roomId);
   return {version:SPACE_CONTROL_VERSION,roomId,phase:1,nativeCliRuntimeIds:["cli:codex"],
    types:catalog.types.filter(t=>t.mode!=="TERMINAL"||t.terminalRuntimeId==="cli:codex"),
    unavailable:[...catalog.unavailable,...catalog.types.filter(t=>t.mode==="TERMINAL"&&t.terminalRuntimeId!=="cli:codex").map(t=>({id:t.id,reason:"CLI adapter deferred to phase two."}))],
    tools:Object.entries(controlToolSchemas).map(([name,schema])=>({name,description:controlToolDescriptions[name as keyof typeof controlToolDescriptions],inputSchema:z.toJSONSchema(schema)})),
    resourceOperations:controlResourceOperations,
    layoutUnits:{x:"percent of room canvas width",width:"percent of room canvas width",y:"12 CSS pixels",height:"12 CSS pixels"},
    schedulePolicy:"Explicit only. Native task, model, operator, stop and quota are rechecked. No automatic model or VPN switching."};
  },
  async start(){await recover();timer=setInterval(()=>void tick().catch(()=>{}),1000);timer.unref();},
  async close(){if(timer)clearInterval(timer);await Promise.allSettled(active.values());await repository.dispose();}
 };
}
