import { liveWatchedTask, liveWatchSubmission } from "./live-watch-identity.js";
import { terminalRenderAuditEvidenceSchema, terminalRenderBatchSchema, terminalRenderFreshnessMs, type TerminalRenderObservation } from "@space/contracts";
import { createHash } from "node:crypto";
import { appendFileSync, promises as fsPromises } from "node:fs";
import { AsyncLocalStorage } from "node:async_hooks";
import { z } from "zod";
import { controlExecuteSchema, controlLayoutSchema, controlOperationSchema, controlScheduleSchema, controlWatchSchema, controlToolSchemas, controlToolDescriptions, controlResourceOperations, controlInspectSections, SPACE_CONTROL_VERSION, cliToggleRuntimeIds,
  controlActionCatalog, controlInspectSectionCatalog, controlSecurityPolicy, controlUnavailableResources, controlVoicePreferencePatchSchema,
  type ControlAction, type ControlExecute, type ControlInspect, type ControlLayout, type ControlOperation, type ControlResult, type ControlTarget,
  type ControlSchedule, type ControlWatch, type Pane, type AuthUser, type Event } from "@space/contracts";
import type { ControlRecord, ControlRepository } from "@space/db";
import { makeSpaceId, nowIso, SpaceConflictError, redactMemoryText, type SpaceStore } from "@space/runtime";
import type { RoomPaneController, RoomPaneObservation } from "./room-pane-control.js";
import { resolveControlSettingsAction } from "./space-control-settings.js";
import type { DecisionsService } from "./decisions-service.js";

export interface ControlActor {id:string; role:AuthUser["role"]}
export interface ControlClientCommand {id:string; actorId:string; roomId:string; action:ControlAction; expiresAt:number; clientId:string; createdAt?:number; result?:{ok:boolean;evidence:Record<string,unknown>}}
function required<T>(value:T|undefined|null,message:string):T {if(value===undefined||value===null)throw new SpaceConflictError(message);return value;}
function hash(value:unknown){return createHash("sha256").update(JSON.stringify(value)).digest("hex");}
export function supportsControlRuntime(pane: Pane, phase: 1 | 2 = 2) {
  if (pane.mode !== "TERMINAL") return true;
  if (phase === 1) return pane.terminalRuntimeId === "cli:codex";
  return Boolean(pane.terminalRuntimeId && (cliToggleRuntimeIds as readonly string[]).includes(pane.terminalRuntimeId));
}
function assertControlRuntime(pane: Pane, p: 1 | 2 = 2) {
  if (!supportsControlRuntime(pane, p)) throw new SpaceConflictError("Native controls for this CLI runtime are not supported.");
}

const FORBIDDEN_SECURITY_PATTERNS = [
  /password/i,
  /secret/i,
  /api[_-]?key/i,
  /auth[_-]?token/i,
  /bearer/i,
  /credential/i,
  /private[_-]?key/i,
  /session[_-]?secret/i,
  /sudo/i,
  /shadow/i,
  /root/i,
  /ssh/i
];
export function assertSecurityPolicy(spec: ControlAction): void {
  if (spec.kind === "resource" && spec.input && typeof spec.input === "object") {
    const pending: unknown[] = [spec.input];
    const visited = new Set<object>();
    while (pending.length) {
     const value = pending.pop();
     if (!value || typeof value !== "object" || visited.has(value)) continue;
     visited.add(value);
     for (const [key, child] of Object.entries(value)) {
      for (const pattern of FORBIDDEN_SECURITY_PATTERNS) {
        if (pattern.test(key)) {
          throw new SpaceConflictError(`Security violation: Direct modification of '${key}' is forbidden. Credentials, secrets, and auth tokens cannot be modified via Space Control.`);
        }
      }
      pending.push(child);
     }
    }
  }
}
export function createSpaceControl(options:{store:SpaceStore;repository:ControlRepository;controller:RoomPaneController;
  phase?: 1 | 2;
  queueDisconnected?: boolean;
  publish(roomId:string):Promise<void>;
  publishEvent?: (event: Event) => void;
  send(pane:Pane,text:string,traceId:string):Promise<unknown>;
  closePane?(actor:ControlActor,pane:Pane,traceId:string):Promise<unknown>;
  resolveActor?(id:string):Promise<ControlActor>;
  checkQuota?(pane:Pane):Promise<{allowed:boolean;reason:string;resetAt?:string}>;
  requireClientAcknowledgement?:boolean;
  integration?(actor:ControlActor,roomId:string,action:ControlAction):Promise<unknown>;
  inspectExtra?(actor:ControlActor,input:ControlInspect):Promise<unknown>;
  inspectPaneState?(pane:Pane):Promise<Record<string,unknown>|null>;
  captureScreenshot?(actor:ControlActor,roomId:string,options?:{format?:string;quality?:number;maxWidth?:number;maxHeight?:number;query?:string}):Promise<Record<string,unknown>>;
  describePaneTypes?(roomId?:string):Promise<{types:Array<{typeId:string;label:string;kind:string;countsKey:string;available:boolean;reason?:string}>;roomCap:number|null}>;
  decisionsService?: DecisionsService;
}) {
 const {store,repository,controller}=options;
 const phase = options.phase ?? 1;
 const supportsRuntime = (p: Pane) => supportsControlRuntime(p, phase);
 const assertRuntime = (p: Pane) => assertControlRuntime(p, phase);
 const active=new Map<string,Promise<void>>();
 // Nested native adapters must share the same room critical section, including
 // authenticated internal HTTP calls. Expired contexts cannot bypass the lock.
 const roomContext=new AsyncLocalStorage<{roomId:string;held:boolean}>();
 async function withRoomLock<T>(roomId:string,work:()=>Promise<T>):Promise<T>{
  const context=roomContext.getStore();
  if(context?.held&&context.roomId===roomId)return work();
  try {
    return await repository.withLock(`room:${roomId}`,async()=>{
     const scope={roomId,held:true};
     try{return await roomContext.run(scope,work);}finally{scope.held=false;}
    }, 15000);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (msg.includes("timed out") || msg.includes("freeze")) {
      let panes: Pane[] = [];
      try { panes = await store.listPanes(roomId, true); } catch {}
      for (const pane of panes) {
        if (!pane.isClosed) {
          await controller.interrupt(pane, makeSpaceId("trace")).catch(() => {});
        }
      }
      const alertEvent: Event = {
        id: makeSpaceId("event"),
        roomId,
        paneId: panes[0]?.id ?? null,
        turnId: null,
        workflowId: null,
        traceId: makeSpaceId("trace"),
        type: "ROOM_WATCHDOG_ALERT",
        message: `Room watchdog detected lock timeout on room "${roomId}". Interrupted active processes to prevent room freeze.`,
        payload: {
          kind: "ROOM_LOCK_TIMEOUT_AUTO_KILL",
          roomId,
          interruptedPaneCount: panes.length,
          error: msg,
          killedAt: nowIso()
        },
        createdAt: nowIso()
      };
      try { await store.recordRoomEvent(alertEvent); } catch {}
      options.publishEvent?.(alertEvent);
      throw new SpaceConflictError(`Room watchdog prevented freeze on room "${roomId}": lock timed out and active tasks were interrupted.`);
    }
    throw error;
  }
 }
 async function withOperatorMutation<T>(pane:Pane,work:()=>Promise<T>):Promise<T>{
  return withRoomLock(pane.roomId,async()=>{await rememberStop(pane);return work();});
 }
 const clients=new Map<string,{actorId:string;roomId:string;lastSeen:number;targets:unknown[];geometry:unknown;terminalRender:TerminalRenderObservation[]}>();
 const clientCommands=new Map<string,ControlClientCommand>();
 type AuditEntry = {
   id: string;
   timestamp: string;
   actorId: string;
   roomId: string;
   requestId: string;
   kind: string;
   operation?: string;
   dryRun: boolean;
   status: "COMPLETED" | "FAILED" | "PENDING" | "CANCELLED" | "UNKNOWN";
   detail: string;
   evidence?: Record<string, unknown>;
 };
 async function recordAuditEntry(entry: AuditEntry) {
   if (!await repository.write({
     kind: "audit",
     actorId: entry.actorId,
     key: entry.id,
     roomId: entry.roomId,
     version: 0,
     value: entry
   }, 0)) throw new SpaceConflictError("Audit record was not persisted.");
 }
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
     if (pane.isClosed) {
       return {
         id: pane.id,
         title: pane.title,
         titleSource: pane.titleSource,
         mode: pane.mode,
         runtimeId: pane.terminalRuntimeId ?? pane.providerId,
         order: pane.order,
         columnSpan: pane.columnSpan,
         nativeControlSupported: supportsRuntime(pane),
         isClosed: true,
         isMinimized: false,
         isMaximized: false,
         createdAt: pane.createdAt,
         updatedAt: pane.updatedAt,
         sessionId: null,
         sessionStartedAt: null,
         nativeTaskRef: null,
         modelId: pane.modelId ?? null,
         configuredModelId: pane.modelId ?? null,
         effectiveModelId: null,
         status: "CLOSED",
         statusReason: null,
         hasUserInput: false,
         isUnused: false
       };
     }
    const cli=pane.mode==="TERMINAL"?await lastCli(pane):null;
    const chat=pane.mode==="CHAT"?await store.getActiveSpaceAgentSession(pane.id):null;
    const extraState = options.inspectPaneState
      ? await Promise.race([
          options.inspectPaneState(pane),
          new Promise<null>((r) => setTimeout(() => r(null), 3000))
        ]).catch(() => null)
      : null;
    const configuredModelId = (extraState?.configuredModelId as string | undefined) ?? cli?.modelId ?? chat?.selectedModelId ?? pane.modelId ?? null;
    const effectiveModelId = (extraState?.effectiveModelId as string | undefined) ?? null;
    const modelVerificationStatus = (extraState?.modelVerificationStatus as string | undefined) ?? (pane.terminalRuntimeId === "cli:gemini" ? "UNVERIFIED" : undefined);
    const accountProfileId = (extraState?.accountProfileId as string | undefined) ?? cli?.accountProfileId ?? null;
    const accountEmail = (extraState?.accountEmail as string | undefined) ?? null;
    const accountVerificationStatus = (extraState?.accountVerificationStatus as string | undefined) ?? (pane.terminalRuntimeId === "cli:gemini" ? (accountProfileId ? "UNVERIFIED" : "UNKNOWN") : undefined);
    const verificationEvidence = (extraState?.verificationEvidence as Record<string, unknown> | undefined) ?? undefined;

    let hasUserInput = false;
    if (cli?.sessionId) {
      try {
        const chunks = await store.listPaneCliTranscriptChunks(cli.sessionId, 100);
        hasUserInput = Array.isArray(chunks) && chunks.some((c: any) => c.stream === "stdin");
      } catch {
        hasUserInput = false;
      }
    }

    const defaultTitleRegex = /^(codex|gemini|antigravity|agy|opencode|terminal|claude|qwen|copilot|hermes|kimi|grok|deepseek|cursor|autohand|omp|oh my pi)\s*(cli|agent|code|build)*$/i;
    const isDefaultTitle = pane.titleSource === "auto" || defaultTitleRegex.test(pane.title.trim());
    const isLivePane = pane.mode === "LIVE" || pane.terminalRuntimeId === "LIVE" || pane.providerId === "LIVE";
    const hasTask = Boolean(cli?.codexThreadId || chat?.threadId || (pane.status === "RUNNING"));
    const isCliOrChat = pane.mode === "TERMINAL" || pane.mode === "CHAT";
    const isUnused = isCliOrChat && !isLivePane && !pane.isClosed && isDefaultTitle && !hasTask && !hasUserInput;
    const mediaTitle = (extraState?.mediaTitle as string | undefined) ?? null;
    const mediaVideoId = (extraState?.mediaVideoId as string | undefined) ?? null;

    return {id:pane.id,title:pane.title,titleSource:pane.titleSource,mode:pane.mode,runtimeId:pane.terminalRuntimeId??pane.providerId,order:pane.order,columnSpan:pane.columnSpan,
     categoryColor: pane.categoryColor ?? null,
     ...(mediaTitle ? { mediaTitle } : {}),
     ...(mediaVideoId ? { mediaVideoId } : {}),
     nativeControlSupported:supportsRuntime(pane),isClosed:pane.isClosed,isMinimized:pane.isMinimized,isMaximized:pane.isMaximized,createdAt:pane.createdAt,updatedAt:pane.updatedAt,
     sessionId:cli?.sessionId??chat?.sessionId??null,sessionStartedAt:cli?.startedAt??chat?.createdAt??null,
     nativeTaskRef:cli?.codexThreadId??chat?.threadId??null,
     modelId:effectiveModelId ?? configuredModelId,
     configuredModelId,
     effectiveModelId,
     ...(modelVerificationStatus ? { modelVerificationStatus } : {}),
     ...(accountProfileId ? { accountProfileId } : {}),
     ...(accountEmail ? { accountEmail } : {}),
     ...(accountVerificationStatus ? { accountVerificationStatus } : {}),
     ...(verificationEvidence ? { verificationEvidence } : {}),
     status:pane.isClosed?"CLOSED":(cli?.status??chat?.status??pane.status),statusReason:cli?.statusReason??null,
     hasUserInput,
     isUnused};
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
  async function inspect(actorOrInput: ControlActor | (Partial<ControlInspect> & { section?: (typeof controlInspectSections)[number] }), maybeInput?: ControlInspect): Promise<unknown> {
   let actor: ControlActor;
   let input: ControlInspect;
   if (maybeInput) {
     actor = actorOrInput as ControlActor;
     input = maybeInput;
   } else {
     actor = { id: "operator:system", role: "ADMIN" };
     input = (actorOrInput || {}) as ControlInspect;
   }
    const normalizedInput: ControlInspect = {
      ...input,
      section: input.section ?? "STATE",
      offset: input.offset ?? 0,
      limit: input.limit ?? 25
    };
   if (normalizedInput.roomId) {
     await activeRoom(normalizedInput.roomId);
   }
   if (normalizedInput.section === "TERMINAL_RENDER") {
    const roomId = required(normalizedInput.roomId, "Room ID is required for TERMINAL_RENDER inspection.");
    const room=await activeRoom(roomId);
    if(actor.role!=="ADMIN"&&room.ownerUserId!==actor.id)throw new SpaceConflictError("Render inspection is outside the actor room scope.");
    const panes = await select(roomId, {paneIds:normalizedInput.paneId?[normalizedInput.paneId]:undefined,state:"ALL"});
    const allowed = new Set(panes.filter(p=>p.mode==="TERMINAL").map(p=>p.id));
    const now = Date.now();
    const observations = [...clients.entries()].filter(([,c])=>c.actorId===actor.id&&c.roomId===roomId)
      .flatMap(([clientId,c])=>c.terminalRender.filter(s=>allowed.has(s.paneId)).map(observation=>({
        clientId, actorId:actor.id, source:"LIVE_CLIENT" as const, observation,
        sampleAgeMs:Math.max(0,now-observation.observedAt),
        availability:now-observation.observedAt<=terminalRenderFreshnessMs&&now-c.lastSeen<10000?"FRESH":"STALE"
      })));
    return {section:"TERMINAL_RENDER",scope:"OBSERVED_GEOMETRY_ONLY",roomId,
      availability:observations.some(s=>s.availability==="FRESH")?"FRESH":observations.length?"STALE":"UNAVAILABLE",
      reason:observations.length?undefined:"NO_CLIENT",observations:observations.slice(normalizedInput.offset,normalizedInput.offset+normalizedInput.limit)};
   }
   if (normalizedInput.section === "STATE") {
     if (!normalizedInput.roomId) throw new SpaceConflictError("Room ID is required for STATE inspection.");
     return { ...await state(normalizedInput.roomId), clients: [...clients.entries()].filter(([,c]) => c.actorId === actor.id && c.roomId === normalizedInput.roomId && c.lastSeen > Date.now() - 10000).map(([id,c]) => ({ id, targets: c.targets, geometry: c.geometry })) };
   }
   if (normalizedInput.section === "CLIPBOARD") {
     return store.listClipboardItems(actor.id, { page: Math.floor(normalizedInput.offset / normalizedInput.limit) + 1, pageSize: normalizedInput.limit, ...(normalizedInput.query ? { q: normalizedInput.query } : {}) });
   }
   if (normalizedInput.section === "AUDIT") {
    const roomEntries = (await repository.list("audit", actor.id, normalizedInput.roomId))
      .map(record => record.value as AuditEntry)
      .sort((a, b) => b.timestamp.localeCompare(a.timestamp));
    const entries = roomEntries.slice(normalizedInput.offset, normalizedInput.offset + normalizedInput.limit);
    return {
     section: "AUDIT",
     total: roomEntries.length,
     count: roomEntries.length,
     entries,
     data: {
      total: roomEntries.length,
      count: roomEntries.length,
      entries
     }
    };
   }
   if (normalizedInput.section === "CONTENT" || normalizedInput.section === "MODELS") {
    if (!normalizedInput.roomId) throw new SpaceConflictError(`Room ID is required for ${normalizedInput.section} inspection.`);
    const selectedPanes = await select(normalizedInput.roomId, { paneIds: normalizedInput.paneId ? [normalizedInput.paneId] : undefined, state: "ALL" });
    const panes = normalizedInput.paneId
      ? selectedPanes
      : [...selectedPanes].sort((a, b) => (a.isClosed === b.isClosed ? 0 : a.isClosed ? 1 : -1));
    return Promise.all(panes.slice(normalizedInput.offset, normalizedInput.offset + normalizedInput.limit).map(async pane => {
     if (!supportsRuntime(pane)) return { paneId: pane.id, title: pane.title, mode: pane.mode, closed: pane.isClosed, supported: false, reason: "CLI adapter deferred to phase two." };
     if (!["TERMINAL", "CHAT"].includes(pane.mode)) return { paneId: pane.id, title: pane.title, mode: pane.mode, closed: pane.isClosed, supported: false, reason: "Native content adapter is unavailable for this pane type." };
      try {
        const observation = await Promise.race([
          controller.inspect(pane),
          new Promise<any>((_, reject) => setTimeout(() => reject(new Error("Pane inspection timed out after 2500ms")), 2500))
        ]);
        if (normalizedInput.section === "MODELS") { const { text, ...metadata } = observation; return { closed: pane.isClosed, ...metadata }; }
        return { closed: pane.isClosed, ...observation };
      }
      catch (error) { return { paneId: pane.id, closed: pane.isClosed, state: "UNKNOWN", reason: message(error) }; }
    }));
   }
   if (options.inspectExtra) {
    const res = await (options.inspectExtra.length === 1 ? (options.inspectExtra as any)(normalizedInput) : options.inspectExtra(actor, normalizedInput));
    return {
     section: normalizedInput.section,
     data: res,
     ...(res && typeof res === "object" ? res : {})
    };
   }
   return { supported: false, section: normalizedInput.section, data: null };
  }
 function message(error:unknown){return redactMemoryText(error instanceof Error?error.message:"Control failed.").slice(0,2000);}
 function registerClient(actor:ControlActor,roomId:string,clientId:string,targets:unknown[],geometry:unknown,render:TerminalRenderObservation[]=[]){
  const existing=clients.get(clientId);if(existing&&existing.actorId!==actor.id)throw new SpaceConflictError("Client belongs to another actor.");
  const terminalRender=terminalRenderBatchSchema.parse(render);
  if(terminalRender.some(s=>s.roomId!==roomId||s.observedAt>Date.now()+1000||s.sessionId!==null||s.runtimeId!==null))throw new SpaceConflictError("Invalid render observation scope or timestamp.");
  clients.set(clientId,{actorId:actor.id,roomId,lastSeen:Date.now(),targets,geometry,terminalRender});
  for(const [id,c] of clients)if(c.lastSeen<Date.now()-60000)clients.delete(id);
  for(const cmd of clientCommands.values()){
    if(cmd.actorId===actor.id&&cmd.roomId===roomId&&(!cmd.clientId||cmd.clientId==="")&&cmd.expiresAt>Date.now()){
      cmd.clientId=clientId;
    }
  }
  return [...clientCommands.values()].filter(c=>c.actorId===actor.id&&c.roomId===roomId&&c.clientId===clientId&&!c.result&&c.expiresAt>Date.now()).map(({actorId,...c})=>c);
 }
 function unregisterClient(actor:ControlActor,clientId:string){if(clients.get(clientId)?.actorId===actor.id)clients.delete(clientId);return {released:true};}
 function acknowledge(actor:ControlActor,clientId:string,id:string,result:{ok:boolean;evidence:Record<string,unknown>}){
  const command=required(clientCommands.get(id),"Client command expired.");
  if(command.actorId!==actor.id||(command.clientId&&command.clientId!==clientId))throw new SpaceConflictError("Only the selected client can acknowledge this command.");
  if(command.action.kind==="pane"&&command.action.operation==="visual_audit") {
    const client=clients.get(clientId);
    if(!client||client.actorId!==actor.id||client.roomId!==command.roomId||command.expiresAt<=Date.now())throw new SpaceConflictError("Render client changed or command expired.");
    const evidence=terminalRenderAuditEvidenceSchema.parse(result.evidence), sample=evidence.observation;
    if(result.ok&&!sample)throw new SpaceConflictError("A successful audit requires an observation.");
    if(sample&&(sample.roomId!==command.roomId||sample.paneId!==command.action.target.paneIds?.[0]||sample.observedAt<(command.createdAt??0)||sample.observedAt>Date.now()+1000||sample.sessionId!==null||sample.runtimeId!==null))throw new SpaceConflictError("Render observation does not match the command.");
    result={ok:result.ok,evidence};
  }
  if(!command.result && command.expiresAt>Date.now())command.result=result;
  return {accepted:Boolean(command.result)};
 }
  async function clientAction(actor:ControlActor,roomId:string,action:ControlAction){
  const current=[...clients.entries()].filter(([,c])=>c.actorId===actor.id&&c.roomId===roomId&&c.lastSeen>Date.now()-2500);
  if(current.length>1)throw new SpaceConflictError("Multiple active clients; focus one Space tab to target its controls.");
  if(current.length===0){
    if(action.kind==="pane"&&action.operation==="visual_audit")return {status:"UNKNOWN" as const,detail:"No eligible client is available for a visual audit.",evidence:{availability:"UNAVAILABLE",reason:"NO_CLIENT"}};
    if (options.queueDisconnected) {
      const command: ControlClientCommand = { id: makeSpaceId("control_client"), actorId: actor.id, roomId, action, clientId: "", expiresAt: Date.now() + 60000 };
      clientCommands.set(command.id, command);
      return { status: "COMPLETED" as const, detail: "Command queued for disconnected client.", evidence: { queued: true, commandId: command.id, roomId } };
    }
    return {status:"PENDING" as const,detail:"Waiting for an authenticated Space client to reconnect; no browser command was queued.",evidence:{waitingForClient:true,roomId}};
  }
  if(action.kind==="pane"&&action.operation==="visual_audit"&&[...clientCommands.values()].some(c=>c.clientId===current[0]![0]&&c.action.kind==="pane"&&c.action.operation==="visual_audit"&&!c.result&&c.expiresAt>Date.now()))throw new SpaceConflictError("A visual audit is already pending for this client.");
  const command:ControlClientCommand={id:makeSpaceId("control_client"),actorId:actor.id,roomId,action,clientId:current[0]![0],createdAt:Date.now(),expiresAt:Date.now()+8000};
  clientCommands.set(command.id,command);
  try{
   while(Date.now()<command.expiresAt&&!command.result)await new Promise(r=>setTimeout(r,50));
   if(!command.result)return {status:"UNKNOWN" as const,detail:"Client acknowledgement was not received; the action will not be repeated.",evidence:{commandId:command.id}};
   if(action.kind==="pane"&&action.operation==="visual_audit") {
    const sample=terminalRenderAuditEvidenceSchema.parse(command.result.evidence).observation;
    const selectedClient=clients.get(command.clientId);
    if(sample&&selectedClient?.actorId===actor.id&&selectedClient.roomId===roomId) selectedClient.terminalRender=[...selectedClient.terminalRender.filter(s=>s.paneId!==sample.paneId),sample].slice(-64);
   }
   const evidence=action.kind==="pane"&&action.operation==="visual_audit" ? {...command.result.evidence,clientId:command.clientId,
     availability:command.result.ok?"FRESH":"UNAVAILABLE",sampleAgeMs:Math.max(0,Date.now()-(terminalRenderAuditEvidenceSchema.parse(command.result.evidence).observation?.observedAt??Date.now()))} : command.result.evidence;
   return {status:command.result.ok?"COMPLETED" as const:"FAILED" as const,detail:(command.result.evidence?.detail as string)||(command.result.ok?"Client confirmed the control.":"Client could not apply the control."),evidence};
  }finally{clientCommands.delete(command.id);}
 }
 async function saveLayout(roomId:string,value:unknown){const old=await layoutRecord(roomId);await writeValue("layout","shared",roomId,roomId,value,old?.version??0);await options.publish(roomId);}
 async function action(actor:ControlActor,command:ControlExecute,spec:ControlAction,index:number):Promise<ControlResult[]>{
  const roomId=command.roomId, traceId=command.requestId;
  const done=(evidence:unknown,detail="Control applied."):ControlResult[]=>[{index,status:"COMPLETED",detail,evidence:{result:evidence}}];

  assertSecurityPolicy(spec);
  if(spec.kind==="pane"&&spec.operation==="visual_audit") {
    const room=await activeRoom(roomId);
    if(actor.role!=="ADMIN"&&room.ownerUserId!==actor.id)throw new SpaceConflictError("Visual audit is outside the actor room scope.");
    const pane=required((await select(roomId,spec.target))[0],"Terminal pane is required.");
    if(pane.mode!=="TERMINAL"||pane.isClosed)throw new SpaceConflictError("Visual audit requires an open terminal pane.");
    if(command.dryRun)return [{index,paneId:pane.id,status:"UNKNOWN",detail:"Visual audit validated; no observation requested.",evidence:{dryRun:true}}];
    const before=await store.getActivePaneCliSession(pane.id);
    const result=await clientAction(actor,roomId,spec);
    const after=await store.getActivePaneCliSession(pane.id);
    if(before?.sessionId!==after?.sessionId){
      for(const client of clients.values())if(client.actorId===actor.id&&client.roomId===roomId)client.terminalRender=client.terminalRender.filter(s=>s.paneId!==pane.id);
      return [{index,paneId:pane.id,status:"UNKNOWN",detail:"Session changed during the visual audit.",evidence:{reason:"SESSION_CHANGED",availability:"UNAVAILABLE"}}];
    }
    return [{index,paneId:pane.id,...result,evidence:{...result.evidence,serverSessionId:after?.sessionId??null,runtimeId:pane.terminalRuntimeId,source:"LIVE_CLIENT",scope:"OBSERVED_GEOMETRY_ONLY"}}];
  }

  const isDestructive = (spec.kind === "clipboard" && spec.operation === "delete") ||
    (spec.kind === "resource" && ["tasks.delete", "links.delete", "files.delete", "media.delete", "settings.rollback"].includes(spec.operation));
  if (isDestructive) {
    const isConfirmed = Boolean(
      (spec as any).confirm === true ||
      (spec as any).confirmed === true ||
      ((spec as any).input && typeof (spec as any).input === "object" && ((spec as any).input.confirm === true || (spec as any).input.confirmed === true)) ||
      (spec as any).approvalReason
    );
    if (!isConfirmed) {
      if (spec.kind === "clipboard" && spec.operation === "delete") {
        throw new SpaceConflictError("Destructive clipboard delete requires explicit confirmation (confirm: true) or approvalReason.");
      }
      throw new SpaceConflictError(`Destructive operation '${spec.kind === "resource" ? spec.operation : `${spec.kind}.${(spec as any).operation}`}' requires explicit confirmation (confirm: true) or approvalReason.`);
    }
  }

  if (spec.kind === "resource") {
    spec = resolveControlSettingsAction(spec);
    const unavailable = controlUnavailableResources[spec.operation];
    if (unavailable) throw new SpaceConflictError(unavailable);
    if (spec.operation === "settings.voice") spec = { ...spec, input: controlVoicePreferencePatchSchema.parse(spec.input) };
    if (spec.operation === "ui.theme" || spec.operation === "ui.scale" || spec.operation === "settings.appearance") {
      const input = spec.input as Record<string, unknown>;
      if (spec.operation === "ui.theme" && (typeof input.theme !== "string" || !["classic", "modern", "codex"].includes(input.theme))) {
        throw new SpaceConflictError("Theme must be classic, modern, or codex.");
      }
      if (spec.operation === "ui.scale" && (typeof input.zoomLevel !== "number" || input.zoomLevel < 50 || input.zoomLevel > 200)) {
        throw new SpaceConflictError("UI scale must be between 50 and 200 percent.");
      }
      if (spec.operation === "settings.appearance") {
        if (input.theme !== undefined && (typeof input.theme !== "string" || !["classic", "modern", "codex"].includes(input.theme))) throw new SpaceConflictError("Theme must be classic, modern, or codex.");
        if (input.zoomLevel !== undefined && (typeof input.zoomLevel !== "number" || input.zoomLevel < 50 || input.zoomLevel > 200)) throw new SpaceConflictError("UI zoom must be between 50 and 200 percent.");
        if (input.terminalFontSize !== undefined && (typeof input.terminalFontSize !== "number" || input.terminalFontSize < 8 || input.terminalFontSize > 32)) throw new SpaceConflictError("Terminal font size must be between 8 and 32 pixels.");
        if (input.theme === undefined && input.zoomLevel === undefined && input.terminalFontSize === undefined) throw new SpaceConflictError("Appearance change requires theme, zoomLevel, or terminalFontSize.");
      }
    }
    if (spec.operation === "asteroids.control" && spec.input.action === "pause") {
      throw new SpaceConflictError("Asteroids pause has no verified execution adapter; no game state was changed.");
    }
  }

  const isDryRun = Boolean(command.dryRun || (spec as any).dryRun);
  if (isDryRun) {
    // Never call a mutating adapter to simulate it. Resolve known targets first,
    // and report incomplete validation explicitly for adapters without preflight.
    if (spec.kind === "pane" || spec.kind === "configure" || spec.kind === "native_command") {
      const panes = await select(roomId, spec.target);
      if (!panes.length) throw new SpaceConflictError("No panes match this selection.");
      if (spec.kind !== "pane" || !["rename", "minimize", "maximize", "restore", "unminimize", "focus", "color"].includes(spec.operation)) {
        for (const pane of panes) assertRuntime(pane);
      }
      if (spec.kind === "pane" && ["rename", "prompt"].includes(spec.operation)) required(spec.text, "Pane text is required.");
    }
    if (spec.kind === "room") {
      if (spec.operation === "activate") await activeRoom(required(spec.targetRoomId, "Target room ID is required."));
      else required(spec.name, "Room name is required.");
    }
    if (spec.kind === "playback") {
      if (spec.operation === "volume" && (spec.value === undefined || spec.value > 100)) throw new SpaceConflictError("Volume must be between 0 and 100.");
      if (spec.operation === "seek") required(spec.value, "Seek position is required.");
    }
    if (spec.kind === "resource" && spec.operation === "settings.voice") {
      const available = [...clients.entries()].filter(([, c]) => c.actorId === actor.id && c.roomId === roomId && c.lastSeen > Date.now() - 2500);
      if (available.length !== 1) throw new SpaceConflictError("Exactly one active Space client is required for voice preference preflight.");
      return [{ index, status: "COMPLETED", detail: "Voice preference schema and focused-client adapter preflight validated without mutations.", evidence: {
        dryRun: true, simulated: true, schemaValidated: true, adapterValidated: true,
        adapter: "BROWSER_VOICE_COMPOSER", clientId: available[0]![0], operation: spec.operation
      } }];
    }
    if (spec.kind === "playback" || (spec.kind === "room" && spec.operation === "activate") || (spec.kind === "pane" && spec.operation === "focus")) {
      const available = [...clients.values()].filter(c => c.actorId === actor.id && c.roomId === roomId && c.lastSeen > Date.now() - 2500);
      if (available.length !== 1) throw new SpaceConflictError("Exactly one active Space client is required.");
    }
    if (spec.kind === "resource" && ["ui.theme", "ui.scale", "settings.appearance"].includes(spec.operation)) {
      const available = [...clients.entries()].filter(([, c]) => c.actorId === actor.id && c.roomId === roomId && c.lastSeen > Date.now() - 2500);
      if (available.length !== 1) throw new SpaceConflictError("Exactly one active Space client is required for appearance preflight.");
      return [{ index, status: "COMPLETED", detail: "Appearance schema and focused-client adapter preflight validated without mutations.", evidence: {
        dryRun: true, simulated: true, schemaValidated: true, adapterValidated: true,
        adapter: "BROWSER_APPEARANCE", clientId: available[0]![0], operation: spec.operation
      } }];
    }
    if (["resource", "cli", "vpn", "watch", "layout", "clipboard", "screenshot"].includes(spec.kind)) {
      return [{ index, status: "UNKNOWN", detail: "Schema validated without mutations; adapter preflight is unavailable. Execution has not been validated.", evidence: { dryRun: true, schemaValidated: true, adapterValidated: false } }];
    }
    return [{
      index,
      status: "COMPLETED",
      detail: "Dry-run schema, scope and targets validated without mutations. This is not an execution receipt or a guarantee of runtime readiness.",
      evidence: {
        result: {
          dryRun: true,
          simulated: true,
          kind: spec.kind,
          operation: (spec as any).operation,
          target: (spec as any).target,
          input: (spec as any).input
        },
        dryRun: true,
        simulated: true,
        kind: spec.kind,
        operation: (spec as any).operation,
        target: (spec as any).target,
        input: (spec as any).input
      }
      }];
    }
  if (spec.kind === "resource" && spec.operation === "settings.voice") {
    const confirmation = await clientAction(actor, roomId, spec);
    if (confirmation.status !== "COMPLETED") return [{ index, ...confirmation }];
    const observed = confirmation.evidence as Record<string, unknown>;
    const preferences = observed.preferences as Record<string, unknown> | undefined;
    if (observed.scope !== "BROWSER_VOICE_COMPOSER" || observed.persisted !== true || observed.applied !== true || observed.changesActiveLiveSession !== false ||
      !preferences || Object.entries(spec.input).some(([key, value]) => preferences[key] !== value)) {
      return [{ index, status: "UNKNOWN", detail: "The client did not provide matching persisted voice preferences. Inspect before retrying.", evidence: observed }];
    }
    return [{ index, ...confirmation, detail: "Voice composer preferences persisted and verified in the selected Space tab. Existing Live audio sessions were not reconfigured." }];
  }

  if (spec.kind === "resource" && ["ui.theme", "ui.scale", "settings.appearance"].includes(spec.operation)) {
    if (options.integration) {
      try {
        const direct = await options.integration(actor, roomId, spec);
        if (direct !== undefined && direct !== null) {
          const outcome = direct as { status?: string; isError?: boolean; ok?: boolean } | null;
          if (!outcome?.isError && outcome?.ok !== false) {
            return done(direct);
          }
        }
      } catch {}
    }
    const confirmation = await clientAction(actor, roomId, spec);
    if (confirmation.status !== "COMPLETED") return [{ index, ...confirmation }];
    const observed = confirmation.evidence as Record<string, unknown>;
    const preferences = observed.preferences as Record<string, unknown> | undefined;
    if (observed.adapter !== "BROWSER_APPEARANCE" || observed.persisted !== true || observed.applied !== true || !preferences) {
      return [{ index, status: "UNKNOWN", detail: "The client did not provide matching persisted appearance preferences. Inspect before retrying.", evidence: observed }];
    }
    return [{ index, ...confirmation, detail: "Appearance preferences persisted and verified in the selected Space tab." }];
  }

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
   const isConfirmed = Boolean(spec.confirm === true || spec.confirmed === true);
   if(!isConfirmed) throw new SpaceConflictError("Destructive clipboard delete requires explicit confirmation (confirm: true).");
   return done(await store.deleteClipboardItem(actor.id,required(spec.id,"Clipboard ID is required.")));
  }
  if(spec.kind==="screenshot"){
   // Only an explicitly configured, authenticated capture adapter may provide
   // APP evidence. A client DOM drawing or anonymous login page is not a shot.
   if(!options.captureScreenshot)throw new SpaceConflictError("Authenticated room screenshot capture is unavailable. Use the Live Screen button to share a real image.");
   const evidence=await options.captureScreenshot(actor,roomId,{format:spec.format,quality:spec.quality,maxWidth:spec.maxWidth,maxHeight:spec.maxHeight});
   if(evidence.roomId!==roomId||evidence.authenticated!==true||evidence.captureSource!=="AUTHENTICATED_APP"||typeof evidence.artifactId!=="string"||!evidence.artifactId){
     throw new SpaceConflictError("Capture did not provide authenticated evidence for the requested room.");
   }
   return done(evidence,"Authenticated room screenshot captured.");
  }
  if(spec.kind==="layout"){
   const applied=async(evidence:unknown)=>{
    if(!options.requireClientAcknowledgement)return done(evidence,"Layout persisted.");
    const confirmation=await clientAction(actor,roomId,spec);
    return [{index,...confirmation,evidence:{...confirmation.evidence,persisted:evidence}}];
   };
   const before=await state(roomId),open=before.panes.filter(p=>!p.isClosed).sort((a,b)=>a.order-b.order);
   if(spec.operation==="save"){
    const id=makeSpaceId("layout_snapshot");
    await writeValue("snapshot",actor.id,id,roomId,{layout:before.layout,order:open.map(p=>p.id),columns:before.room.paneLayoutColumns},0);
    const oldLatest=await repository.get("snapshot",actor.id,`latest_${roomId}`);
    await writeValue("snapshot",actor.id,`latest_${roomId}`,roomId,{snapshotId:id,layout:before.layout,order:open.map(p=>p.id),columns:before.room.paneLayoutColumns},oldLatest?.version??0).catch(()=>{});
    return done({snapshotId:id});
   }
   if(spec.operation==="restore"){
    let targetSnapshotId=spec.snapshotId;
    if(!targetSnapshotId||targetSnapshotId==="LATEST"){
      const latest=await repository.get("snapshot",actor.id,`latest_${roomId}`);
      if(latest&&(latest.value as any)?.snapshotId)targetSnapshotId=(latest.value as any).snapshotId;
    }
    const snapshot=required(await repository.get("snapshot",actor.id,required(targetSnapshotId,"Snapshot ID is required.")),"Snapshot not found.");
    if(snapshot.roomId!==roomId)throw new SpaceConflictError("Snapshot belongs to another room.");
    const value=snapshot.value as {layout:ControlLayout|null;order:string[];columns:0|1|2|3|4|null};
    const allPanes=await store.listPanes(roomId,true);
    for(const id of value.order){
      const p=allPanes.find(x=>x.id===id);
      if(p&&p.isClosed){
        await store.updatePane(id,{isClosed:false,status:"IDLE"},traceId);
      }
    }
    const currentOpen=(await store.listPanes(roomId,true)).filter(p=>!p.isClosed);
    if(value.order.length!==currentOpen.length||value.order.some(id=>!currentOpen.some(p=>p.id===id)))throw new SpaceConflictError("Pane membership changed; snapshot cannot be applied.");
    await store.reorderPanes(roomId,value.order,traceId);await store.updateRoomPaneLayout(roomId,{paneLayoutColumns:value.columns},traceId);await saveLayout(roomId,value.layout);return applied({snapshotId:targetSnapshotId});
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
    const treeCols = (typeof (before.room as any)?.paneLayoutColumns === "number" && (before.room as any).paneLayoutColumns >= 1 && (before.room as any).paneLayoutColumns <= 4 ? (before.room as any).paneLayoutColumns : 2) as 1|2|3|4;
    layout={mode:"CUSTOM",columns:treeCols,placements};
   }else layout=controlLayoutSchema.parse(required(spec.layout,"Layout is required."));
   if(layout.mode==="CUSTOM"&&(layout.placements.length!==open.length||layout.placements.some(p=>!open.some(o=>o.id===p.paneId))))throw new SpaceConflictError("Custom layout must place every open pane exactly once.");
   if(layout.mode==="GRID"){
     await saveLayout(roomId, null);
     if(layout.columns !== undefined) await store.updateRoomPaneLayout(roomId, { paneLayoutColumns: layout.columns as 0|1|2|3|4|null }, traceId);
     return applied({ layout: null });
   }
   if(layout.columns !== undefined) await store.updateRoomPaneLayout(roomId, { paneLayoutColumns: layout.columns as 0|1|2|3|4|null }, traceId);
   await saveLayout(roomId, layout);
   return applied({ layout });
  }
  if(spec.kind==="cli"||spec.kind==="vpn"||spec.kind==="resource") {
   if ((spec.kind === "cli" || spec.kind === "vpn") && spec.runtimeId && !(cliToggleRuntimeIds as readonly string[]).includes(spec.runtimeId)) throw new SpaceConflictError("Runtime management targets supported CLIs only.");
   const result=await required(options.integration,"Runtime management is unavailable.")(actor,roomId,spec);
   const outcome=result as {status?:string;isError?:boolean;ok?:boolean}|null;
   if(outcome?.isError || outcome?.ok===false || ["BLOCKED","APPROVAL_REQUIRED","FAILED","ERROR","PARTIAL"].includes(outcome?.status??"")) {
    const errorMsg = (typeof (outcome as any)?.error === "string" && (outcome as any).error) ||
                     (typeof (outcome as any)?.detail === "string" && (outcome as any).detail) ||
                     (typeof (outcome as any)?.reason === "string" && (outcome as any).reason) ||
                     "The protected adapter did not complete this control.";
    return [{index,status:"FAILED",detail:errorMsg,error:errorMsg,evidence:{result}}];
   }
   if (["RUNNING", "PENDING", "QUEUED", "UNKNOWN", "CANCELLED"].includes(outcome?.status ?? "")) {
    return [{ index, status: outcome?.status === "CANCELLED" ? "CANCELLED" : "UNKNOWN", detail: "The adapter has not confirmed completion. Inspect its receipt before continuing; do not repeat the mutation.", evidence: { result, adapterStatus: outcome?.status } }];
   }
   return done(result);
  }
  if(spec.kind==="watch"){
   const pId=spec.paneId??spec.target?.paneIds?.[0];
   let result:unknown;
   if(spec.operation==="cancel")result=await watches(actor,roomId,"cancel",{id:spec.id});
   else if(spec.operation==="status")result=await watches(actor,roomId,"status",{id:spec.id});
   else if(spec.operation==="ack")result=await watches(actor,roomId,"ack",{id:spec.id});
   else result=await watches(actor,roomId,"register",{
     paneId:required(pId,"Pane target is required for watch registration."),
     targetTaskRef:spec.targetTaskRef,
     timeoutMs:spec.timeoutMs,
     maxRetries:spec.maxRetries,
     verificationPrompt:spec.verificationPrompt,
     remediationPrompt:spec.remediationPrompt
   });
   return [{index,paneId:pId,status:"COMPLETED",detail:"Watch operation applied.",evidence:{result}}];
  }
  const panes=await select(roomId,spec.target);
  if(!panes.length)throw new SpaceConflictError("No panes match this selection.");
  const results:ControlResult[]=[];
  for(let offset=0;offset<panes.length;offset+=4){
   results.push(...await Promise.all(panes.slice(offset,offset+4).map(async original=>{
    const paneId=original.id;
    try{
     let pane=await store.getPane(paneId);
     if(spec.kind!=="pane" || !["rename","minimize","maximize","restore","unminimize","focus","color"].includes(spec.operation))assertRuntime(pane);
     let evidence:unknown;
     if(spec.kind==="pane"&&["rename","minimize","maximize","restore","unminimize","color"].includes(spec.operation)){
      evidence=await store.updatePane(pane.id,spec.operation==="color"?{categoryColor:(spec as any).color??null}:spec.operation==="rename"?{title:required(spec.text,"Pane title is required.")}:
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
       else if(spec.operation==="start"){
        const observed=await controller.inspect(pane);
        if(["RUNNING","IDLE","WAITING_FOR_INPUT"].includes(observed.state)){
         evidence={status:"COMPLETED",detail:"Pane session is already active.",observation:observed};
        } else {
         evidence=await controller.start(pane,traceId);
        }
       }
       else if(spec.operation==="reopen"&&priorSession?.isActive&&!["ERROR","EXITED"].includes(priorSession.status))evidence=await controller.start(pane,traceId);
       else evidence=await controller.resume(pane,priorSession?.cliTaskId??undefined,traceId);
      if(pane.mode==="TERMINAL"){
       const observed=await controller.inspect(pane,{fresh:true});
       if(priorSession?.codexThreadId&&observed.nativeTaskRef!==priorSession.codexThreadId)
        return {index,paneId,status:"UNKNOWN" as const,detail:"The original native task has not been confirmed after resume.",evidence:{result:evidence}};
       if(["EXITED","ERROR","UNKNOWN"].includes(observed.state))return {index,paneId,status:"UNKNOWN" as const,detail:"CLI readiness has not been confirmed.",evidence:{result:evidence}};
      }
     }else{
      const observed=await controller.inspect(pane);
      if(spec.kind==="pane"&&(spec.operation==="stop"||spec.operation==="cancel")){
       await rememberStop(pane);evidence=await controller.interrupt(pane,traceId);
       let after=await controller.inspect(pane);
       if(after.state==="RUNNING"){
        for(let i=0;i<10;i++){
         await new Promise(r=>setTimeout(r,350));
         after=await controller.inspect(pane);
         if(after.state!=="RUNNING")break;
        }
       }
       if(after.state==="RUNNING")return {index,paneId,status:"UNKNOWN" as const,detail:"Native stop is not yet confirmed; process is still yielding.",evidence:{result:evidence}};
       return {index,paneId,status:"COMPLETED" as const,detail:"Native execution stopped successfully.",evidence:{result:evidence,state:after.state}};
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
       let readyObserved=observed;
       if(readyObserved.state!=="IDLE"&&readyObserved.state!=="WAITING_FOR_INPUT"){
        const session=pane.mode==="TERMINAL"?await lastCli(pane):null;
        if(!session||!session.isActive){
         try{await controller.start(pane,traceId);}catch{}
        }
        const deadline=Date.now()+3500;
        while(Date.now()<deadline){
         await new Promise(r=>setTimeout(r,250));
         readyObserved=await controller.inspect(pane,{fresh:true});
         if(readyObserved.state==="IDLE"||readyObserved.state==="WAITING_FOR_INPUT")break;
        }
       }
       if(readyObserved.state!=="IDLE"&&readyObserved.state!=="WAITING_FOR_INPUT")throw new SpaceConflictError("The pane is not confirmed ready for input.");
       const submittedAt = nowIso();
       evidence=await options.send(pane,required(spec.text,"Prompt text is required."),traceId);
       try {
         const autoTaskRef = (evidence as any)?.turnId ?? null;
         const autoWatchId = makeSpaceId("control_watch");
         const autoWatch = controlWatchSchema.parse({
           id: autoWatchId,
           actorId: actor.id,
           roomId,
           paneId,
           targetTaskRef: autoTaskRef,
           submission: liveWatchSubmission(readyObserved, evidence, submittedAt),
           status: "RUNNING",
           reason: null,
           taskState: "RUNNING",
           maxRetries: 0,
           retriesCount: 0,
           timeoutMs: 600_000,
           auditTrail: [{
             timestamp: nowIso(),
             status: "RUNNING",
             detail: `Auto-watch registered for prompt dispatch on pane ${paneId}.`,
             evidence: { prompt: spec.text?.slice(0, 200), traceId, nativeTaskRef: autoTaskRef }
           }],
           voiceDelivery: {
             queued: false,
             delivered: false,
             deliveredAt: null,
             acknowledged: false,
             acknowledgedAt: null
           },
           createdAt: nowIso(),
           updatedAt: nowIso()
         });
         await writeValue("watch", actor.id, autoWatch.id, roomId, autoWatch, 0);
         if (evidence && typeof evidence === "object") {
           (evidence as any).watchId = autoWatchId;
         }
       } catch {}
      }else{
       const when=spec.when;
       if(observed.state==="UNKNOWN"&&!(spec.kind==="configure"&&spec.accountProfileId))throw new SpaceConflictError("Native state is unknown.");
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
     }catch(error){const msg=message(error);return {index,paneId,status:"FAILED" as const,detail:msg,error:msg,evidence:{}};}
   })));
  }
  await options.publish(roomId);return results;
 }
 async function operation(actor:ControlActor,roomId:string,id:string){const record=required(await repository.get("operation",actor.id,id),"Operation not found.");if(record.roomId!==roomId)throw new SpaceConflictError("Operation belongs to another room.");return controlOperationSchema.parse(record.value);}
 async function execute(actor:ControlActor,raw:ControlExecute,waitForCompletion=false){
  const command=controlExecuteSchema.parse(raw);await activeRoom(command.roomId);
  if(actor.role!=="ADMIN"&&actor.role!=="USER")throw new SpaceConflictError("Space control requires an authorized user role.");
  const key=hash([command.roomId,command.requestId]),payloadHash=hash(command),previous=await repository.get("operation",actor.id,key);
  if(previous){const value=controlOperationSchema.parse(previous.value);if(value.payloadHash!==payloadHash)throw new SpaceConflictError("Request ID was reused with a different payload.");return value;}
  const initial:ControlOperation={id:key,actorId:actor.id,roomId:command.roomId,requestId:command.requestId,payloadHash,status:"RUNNING",createdAt:nowIso(),updatedAt:nowIso(),results:[],cancelRequested:false,command,nextIndex:0};
  if(!await repository.write({kind:"operation",actorId:actor.id,key,roomId:command.roomId,version:1,value:initial},0))return execute(actor,raw,waitForCompletion);
  return drive(actor,command,key,waitForCompletion);
 }
 async function drive(actor:ControlActor,command:ControlExecute,key:string,waitForCompletion=false){
  const readOnlyAudit=command.actions.length===1&&command.actions[0]?.kind==="pane"&&command.actions[0].operation==="visual_audit";
  // Diagnostics must never enter the room mutation watchdog (which can interrupt tasks).
  const run=readOnlyAudit ? <T>(work:()=>Promise<T>)=>work() : <T>(work:()=>Promise<T>)=>withRoomLock(command.roomId,work);
  const work=run(async()=>{
   try{
    const initial=await operation(actor,command.roomId,key);
    if(initial.status!=="RUNNING")return;
    // A PENDING result is a durable wait (for example, for the focused Space
    // client to reconnect). Re-run that exact action on the next drive rather
    // than treating it as a completed index or submitting a new operation.
    const pending=initial.results.filter(r=>r.status==="PENDING");
    // Scheduled actions have already been submitted. Only a wholly unsent
    // browser-client wait may be replayed; mixed target results are unsafe.
    if(pending.length && (pending.some(r=>r.evidence.waitingForClient!==true || r.evidence.scheduleId) ||
      initial.results.some(r=>r.status!=="PENDING" && pending.some(p=>p.index===r.index))))return;
    const pendingIndex=pending[0]?.index;
    if(options.resolveActor)await options.resolveActor(actor.id);
    if(initial.nextIndex===0&&command.expectedRevision&&(await state(command.roomId)).revision!==command.expectedRevision)throw new SpaceConflictError("Room state changed before execution.");
    for(const [index,spec] of command.actions.entries()){
     if(index<initial.nextIndex&&index!==pendingIndex)continue;
     const current=await operation(actor,command.roomId,key);if(current.cancelRequested)break;
      let results:ControlResult[] = [];
      let isHeldBySafety = false;
      if (!readOnlyAudit && options.decisionsService && !command.dryRun && !(spec as any).dryRun) {
        try {
          const guard = await options.decisionsService.evaluateDestructive(spec.kind, JSON.stringify(spec));
          if (guard.isDestructive && !(command as any).userExplicitlyAuthorized) {
            isHeldBySafety = true;
            results = [{
              index,
              status: "FAILED",
              detail: `Execution held by Jev Safety Guard: destructive operation detected (${Math.round(guard.confidence * 100)}% confidence). Operator authorization required.`,
              error: "DESTRUCTIVE_OPERATION_HELD",
              evidence: { safetyGuard: guard }
            }];
          }
        } catch {}
      }
      if (!isHeldBySafety) {
        try{results=await action(actor,command,spec,index);}catch(error){const msg=message(error);results=[{index,status:"FAILED",detail:msg,error:msg,evidence:{}}];}
      }
      if (!readOnlyAudit && options.decisionsService && !command.dryRun && !(spec as any).dryRun) {
        for (const r of results) {
          if (r.status === "COMPLETED") {
            const out = [
              r.detail,
              (r.evidence as any)?.output,
              (r.evidence as any)?.stdout,
              (r.evidence as any)?.result ? JSON.stringify((r.evidence as any)?.result) : ""
            ].filter(Boolean).join("\n");
            if (out.length > 20) {
              try {
                const sf = await options.decisionsService.evaluateSilentFailure(out);
                if (sf.hasSilentFailure) {
                  r.status = "FAILED";
                  r.detail = `Jev Silent Failure Detector identified unhandled error in output: ${r.detail}`;
                  r.error = "SILENT_FAILURE_DETECTED";
                  r.evidence = { ...r.evidence, silentFailure: sf };
                }
              } catch {}
            }
          }
        }
      }
      for(const r of results){
        try { await recordAuditEntry({
          id:makeSpaceId("audit"),
          timestamp:nowIso(),
          actorId:actor.id,
          roomId:command.roomId,
          requestId:command.requestId,
          kind:spec.kind,
          operation:(spec as any).operation,
          dryRun:Boolean(command.dryRun||(spec as any).dryRun),
          status:r.status,
          detail:r.detail,
          evidence:r.evidence as Record<string,unknown>
        }); } catch {
          r.evidence = { ...r.evidence, actionStatus: r.status, auditPersisted: false };
          r.status = "UNKNOWN";
          r.detail = "Action returned, but its audit record could not be persisted. Inspect before retrying.";
        }
      }
      await updateRecord("operation",actor.id,key,raw=>{
       const latest=controlOperationSchema.parse(raw);
       if(latest.status!=="RUNNING")return latest;
       latest.results=latest.results.filter(result=>result.index!==index);
       latest.results.push(...results);
       latest.nextIndex=results.some(result=>result.status==="PENDING"&&result.evidence.waitingForClient===true)?index:index+1;
       latest.updatedAt=nowIso();return latest;
      });
      if(results.some(r=>["FAILED","UNKNOWN","PENDING","CANCELLED"].includes(r.status)))break;
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
     const msg=message(error);value.results.push({index:value.results.length,status:"FAILED",detail:msg,error:msg,evidence:{}});value.updatedAt=nowIso();return value;
    });
   }
  });
  active.set(key,work);
  void work.finally(()=>active.delete(key)).catch(()=>{});
   if(waitForCompletion){
    let timeout:ReturnType<typeof setTimeout>|undefined;
    try{await Promise.race([work,new Promise(r=>{timeout=setTimeout(r,30000);})]);}finally{if(timeout)clearTimeout(timeout);}
    return operation(actor,command.roomId,key);
   }
   let timeout:ReturnType<typeof setTimeout>|undefined;
   try{await Promise.race([work,new Promise(r=>{timeout=setTimeout(r,6000);})]);}finally{if(timeout)clearTimeout(timeout);}
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
   // Only unsent browser waits can settle immediately. Take the execution
   // lock so a reconnect cannot dispatch between observation and cancellation.
   const cancelled=await operation(actor,roomId,id);
   if(cancelled.results.some(r=>r.status==="PENDING"&&r.evidence.waitingForClient===true)){
    await withRoomLock(roomId,()=>updateRecord("operation",actor.id,id,raw=>{
     const value=controlOperationSchema.parse(raw);
     const pending=value.results.filter(r=>r.status==="PENDING");
     if(value.status==="RUNNING"&&value.cancelRequested&&pending.length&&
       pending.every(r=>r.evidence.waitingForClient===true&&!r.evidence.scheduleId)){
      value.results=value.results.map(r=>r.status==="PENDING"?{...r,status:"CANCELLED" as const,detail:"Cancelled before browser dispatch."}:r);
      value.status="CANCELLED";value.updatedAt=nowIso();
     }
     return value;
    }));
   }
  }
  const latest=await operation(actor,roomId,id);
  // Reconnect-driven continuation: once a focused client is present, a
  // durable waiting-for-client operation is resumed under its original key.
  if(!cancel && !latest.cancelRequested && latest.status==="RUNNING" && latest.results.some(result=>result.status==="PENDING"&&result.evidence.waitingForClient===true) && !active.has(id)){
   const clientAvailable=[...clients.values()].filter(client=>client.actorId===actor.id&&client.roomId===roomId&&client.lastSeen>Date.now()-2500).length===1;
   if(clientAvailable && latest.command) void drive(actor,latest.command,id,false);
  }
  return latest;
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
    assertRuntime(pane);
    if(pane.mode!=="CHAT"&&(pane.mode!=="TERMINAL"||!supportsRuntime(pane)))throw new SpaceConflictError("Schedules require Chat or supported CLI panes.");
    const observed=await controller.inspect(pane);
    const taskRef=observed.nativeTaskRef||observed.sessionId;
    const modelId=observed.modelId||pane.modelId;
    if(!taskRef||!modelId)throw new SpaceConflictError("A native task and model must be confirmed before scheduling.");
    expectedTasks[pane.id]=taskRef;expectedModels[pane.id]=modelId;
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
   if(actor.role!=="ADMIN"&&actor.role!=="USER")throw new SpaceConflictError("User authorization was revoked.");
   // A crash after claiming a schedule but before creating its operation must
   // revalidate every binding. An existing receipt is observed, never replayed.
   const existing=await repository.get("operation",actor.id,hash([value.roomId,value.command.requestId]));
   if(!existing){
    for(const [paneId,nativeTask] of Object.entries(value.expectedTasks)){
     const pane=await store.getPane(paneId);
     if(pane.roomId!==value.roomId||pane.isClosed)throw new SpaceConflictError("Scheduled pane moved or was closed.");
     if(((await repository.get("pane_state","shared",paneId))?.version??0)!==value.stopVersions[paneId])throw new SpaceConflictError("A newer operator stop superseded this schedule.");
     const observed=await controller.inspect(pane);
     const taskRef=observed.nativeTaskRef||observed.sessionId;
     const modelId=observed.modelId||pane.modelId;
     if(taskRef!==nativeTask||modelId!==value.expectedModels[paneId])throw new SpaceConflictError("Scheduled native task or model changed.");
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
 
  async function watches(actor:ControlActor,roomId:string,op:string,params:{id?:string;paneId?:string;targetTaskRef?:string;timeoutMs?:number;maxRetries?:number;verificationPrompt?:string;remediationPrompt?:string}){
   await activeRoom(roomId);
   if(op==="list")return (await repository.list("watch",actor.id,roomId)).map(r=>r.value);
   if(op==="status"||op==="get"){
    const record=required(await repository.get("watch",actor.id,required(params.id,"Watch ID is required.")),"Watch not found.");
    if(record.roomId!==roomId)throw new SpaceConflictError("Watch belongs to another room.");
    return controlWatchSchema.parse(record.value);
   }
   if(op==="cancel"){
    const record=required(await repository.get("watch",actor.id,required(params.id,"Watch ID is required.")),"Watch not found.");
    if(record.roomId!==roomId)throw new SpaceConflictError("Watch belongs to another room.");
    return withRoomLock(roomId,()=>updateRecord("watch",actor.id,record.key,raw=>{
     const value=controlWatchSchema.parse(raw);
     if(["PENDING","RUNNING","VERIFYING"].includes(value.status)){
      value.status="CANCELLED";value.reason="Watch cancelled by operator.";value.updatedAt=nowIso();
      value.auditTrail.push({timestamp:nowIso(),status:"CANCELLED",detail:"Watch cancelled by operator.",evidence:{}});
     }
     return value;
    }));
   }
   if(op==="ack"){
    const record=required(await repository.get("watch",actor.id,required(params.id,"Watch ID is required.")),"Watch not found.");
    if(record.roomId!==roomId)throw new SpaceConflictError("Watch belongs to another room.");
    return withRoomLock(roomId,()=>updateRecord("watch",actor.id,record.key,raw=>{
     const value=controlWatchSchema.parse(raw);
     value.voiceDelivery.acknowledged=true;
     value.voiceDelivery.acknowledgedAt=nowIso();
     value.updatedAt=nowIso();
     return value;
    }));
   }
   if(op==="register"){
    const paneId=required(params.paneId,"Pane ID is required to register a watch.");
    const pane=await store.getPane(paneId);
    if(pane.roomId!==roomId)throw new SpaceConflictError("Pane belongs to another room.");
    assertRuntime(pane);
    const observed=await controller.inspect(pane);
    if(params.targetTaskRef && params.targetTaskRef !== observed.nativeTaskRef && !observed.tasks.some(t => t.taskId === params.targetTaskRef))
      throw new SpaceConflictError("The requested task identity was not observed in this pane. Refresh task state before registering a watch.");
    const targetTaskRef=params.targetTaskRef === observed.nativeTaskRef || !params.targetTaskRef ? observed.tasks.at(-1)?.taskId ?? null : params.targetTaskRef;
    if (!params.verificationPrompt && !params.remediationPrompt) {
      const existing = (await repository.list("watch", actor.id, roomId)).map(r => controlWatchSchema.parse(r.value)).reverse()
        .find(w => w.paneId === paneId && w.targetTaskRef === targetTaskRef && ["PENDING", "RUNNING", "VERIFYING"].includes(w.status));
      if (existing) return existing;
    }
    const watchId=makeSpaceId("control_watch");
    const matchedTask=observed.tasks.find(t=>t.taskId===targetTaskRef);
    const initialStatus=observed.state==="RUNNING" || (matchedTask && ["COMPLETED","FAILED","INTERRUPTED"].includes(matchedTask.status)) ? "RUNNING":"PENDING";
    const value=controlWatchSchema.parse({
     id:watchId,actorId:actor.id,roomId,paneId,targetTaskRef,status:initialStatus,reason:null,
     taskState:observed.state==="RUNNING"?"RUNNING":"UNKNOWN",
     maxRetries:params.maxRetries??1,retriesCount:0,timeoutMs:params.timeoutMs??300_000,
     verificationPrompt:params.verificationPrompt,remediationPrompt:params.remediationPrompt,
     auditTrail:[{timestamp:nowIso(),status:initialStatus,detail:`Watch registered for pane ${paneId}.`,evidence:{nativeTaskRef:targetTaskRef,initialState:observed.state,modelId:observed.modelId}}],
     voiceDelivery:{queued:false,delivered:false,deliveredAt:null,acknowledged:false,acknowledgedAt:null},
     createdAt:nowIso(),updatedAt:nowIso()
    });
    await writeValue("watch",actor.id,value.id,roomId,value,0);
    return value;
   }
   throw new SpaceConflictError("Unsupported watch operation.");
  }
  async function pendingWatches(actor:ControlActor,roomId?:string){
   const list=await repository.list("watch",actor.id,roomId);
   return list.map(r=>controlWatchSchema.parse(r.value)).filter(w=>w.voiceDelivery.queued&&!w.voiceDelivery.acknowledged);
  }
  async function advanceWatch(saved:ControlRecord){
   return withRoomLock(saved.roomId,async()=>{
    const record=required(await repository.get("watch",saved.actorId,saved.key),"Watch disappeared.");
    let value=controlWatchSchema.parse(record.value);
    if(!["PENDING","RUNNING","VERIFYING"].includes(value.status))return;
    const populatePaneDetails = (p?: Pane, obs?: RoomPaneObservation) => {
      const pId = p?.id || value.paneId;
      const title = p?.title || obs?.title || pId;
      const runtimeId = p?.terminalRuntimeId ?? obs?.runtimeId ?? null;
      const modelId = obs?.modelId ?? p?.modelId ?? null;
      const state = obs?.state ?? (value.taskState === "COMPLETED" ? "IDLE" : value.taskState);
      const watchedTask = obs ? liveWatchedTask(value, obs) : undefined;
      const durationMs = watchedTask?.timing.source === "NATIVE" && watchedTask.timing.durationMs != null
        ? watchedTask.timing.durationMs : Math.max(1, Date.now() - Date.parse(value.createdAt));
      const outputIsCurrent = obs?.state !== "RUNNING" && watchedTask?.taskId === obs?.tasks.at(-1)?.taskId;
      // Never announce a later turn's terminal output as this watch's result.
      const rawText = outputIsCurrent ? (obs?.text || "").trim() : "";
      const lastOutput = rawText ? rawText.slice(-1000) : "";
      const summary = rawText ? rawText.slice(-300) : "";
      value.paneDetails = {
        paneId: pId,
        title,
        runtimeId,
        modelId,
        state,
        status: value.status,
        statusReason: value.reason,
        durationMs,
        lastOutput,
        summary,
        commands: outputIsCurrent ? obs?.commands ?? [] : [],
        nativeTaskRef: value.targetTaskRef ?? obs?.nativeTaskRef ?? null
      };
    };
    const notifyQueued = async (roomId: string, watch: any) => {
      try {
        options.publishEvent?.({ type: "control.watch.queued", roomId, watch } as any);
        await options.publish(roomId);
      } catch {}
    };

    const elapsed=Date.now()-Date.parse(value.createdAt);
    if(elapsed>value.timeoutMs){
     value.status="FAILED";value.reason=`Watch timed out after ${value.timeoutMs}ms.`;value.taskState="TIMED_OUT";value.voiceDelivery.queued=true;value.updatedAt=nowIso();
     populatePaneDetails(undefined, undefined);
     value.auditTrail.push({timestamp:nowIso(),status:"FAILED",detail:value.reason,evidence:{elapsed,timeoutMs:value.timeoutMs}});
     await updateRecord("watch",record.actorId,record.key,()=>value);
     await notifyQueued(saved.roomId, value);
     return;
    }
    let pane:Pane;
    try{pane=await store.getPane(value.paneId);}catch{
     value.status="BLOCKED";value.reason="Target pane no longer exists.";value.voiceDelivery.queued=true;value.updatedAt=nowIso();
     populatePaneDetails(undefined, undefined);
     value.auditTrail.push({timestamp:nowIso(),status:"BLOCKED",detail:value.reason,evidence:{}});
     await updateRecord("watch",record.actorId,record.key,()=>value);
     await notifyQueued(saved.roomId, value);
     return;
    }
    if(pane.isClosed){
     value.status="CANCELLED";value.reason="Target pane was closed.";value.voiceDelivery.queued=true;value.updatedAt=nowIso();
     populatePaneDetails(pane, undefined);
     value.auditTrail.push({timestamp:nowIso(),status:"CANCELLED",detail:value.reason,evidence:{}});
     await updateRecord("watch",record.actorId,record.key,()=>value);
     await notifyQueued(saved.roomId, value);
     return;
    }
    const observed=await controller.inspect(pane);
    if(value.status==="PENDING"){
     if(observed.state==="RUNNING"){
      value.status="RUNNING";value.taskState="RUNNING";value.updatedAt=nowIso();
      value.auditTrail.push({timestamp:nowIso(),status:"RUNNING",detail:"Target pane started execution.",evidence:{state:observed.state}});
      await updateRecord("watch",record.actorId,record.key,()=>value);
     }
     return;
    }
    if(value.status==="RUNNING"){
     let taskCompleted=false;let taskFailed=false;let failureDetail="";
     const relevantTask=liveWatchedTask(value, observed);
     if(relevantTask){
      if(value.submission && !value.submission.turnId){
       value.submission.turnId=relevantTask.taskId;
       value.targetTaskRef=relevantTask.taskId;
       value.updatedAt=nowIso();
       value.auditTrail.push({timestamp:nowIso(),status:"RUNNING",detail:"Watch bound to the observed native turn.",evidence:{nativeTaskRef:relevantTask.taskId}});
       await updateRecord("watch",record.actorId,record.key,()=>value);
      }
      if(relevantTask.status==="COMPLETED")taskCompleted=true;
      else if(relevantTask.status==="INTERRUPTED"){
       value.status="CANCELLED";value.taskState="INTERRUPTED";value.reason="Agent turn was interrupted.";value.voiceDelivery.queued=true;value.updatedAt=nowIso();
       populatePaneDetails(pane, observed);
       value.auditTrail.push({timestamp:nowIso(),status:"CANCELLED",detail:value.reason,evidence:{relevantTask}});
       await updateRecord("watch",record.actorId,record.key,()=>value);
       await notifyQueued(saved.roomId, value);
       return;
      }else if(["FAILED","ERROR"].includes(relevantTask.status)){
       taskFailed=true;failureDetail="Task failed with error status.";
      }
     }
     if(!taskCompleted&&(observed.state==="ERROR"||observed.state==="EXITED")){taskFailed=true;failureDetail=failureDetail||`Pane state is ${observed.state}.`;}
     else if(observed.state==="WAITING_FOR_INPUT") value.taskState="WAITING_FOR_INPUT";
     // A quiet/idle terminal is not proof that the watched task completed.

     if(taskFailed){
      if(value.retriesCount<value.maxRetries&&value.remediationPrompt){
       value.retriesCount+=1;value.taskState="RUNNING";value.updatedAt=nowIso();
       const traceId=makeSpaceId("trace_remediation");
       const submittedAt = nowIso();
       const receipt = await options.send(pane,value.remediationPrompt,traceId);
       value.submission = liveWatchSubmission(observed, receipt, submittedAt);
       value.targetTaskRef = value.submission.turnId;
       value.auditTrail.push({timestamp:nowIso(),status:"RUNNING",detail:`Execution failure detected (${failureDetail}). Remediating (retry ${value.retriesCount}/${value.maxRetries}).`,evidence:{failureDetail,retriesCount:value.retriesCount,traceId}});
       await updateRecord("watch",record.actorId,record.key,()=>value);return;
      }else{
       value.status="FAILED";value.taskState="FAILED";value.reason=failureDetail||"Execution failed and retry limit reached.";value.voiceDelivery.queued=true;value.updatedAt=nowIso();
       populatePaneDetails(pane, observed);
       value.auditTrail.push({timestamp:nowIso(),status:"FAILED",detail:value.reason,evidence:{failureDetail,retriesCount:value.retriesCount,maxRetries:value.maxRetries}});
       await updateRecord("watch",record.actorId,record.key,()=>value);
       await notifyQueued(saved.roomId, value);
       return;
      }
     }
     if(taskCompleted){
      value.taskState=value.taskState==="WAITING_FOR_INPUT" ? "WAITING_FOR_INPUT" : "COMPLETED";
      if(value.verificationPrompt){
       value.status="VERIFYING";value.updatedAt=nowIso();
       const traceId=makeSpaceId("trace_verification");
       const submittedAt = nowIso();
       const receipt = await options.send(pane,value.verificationPrompt,traceId);
       value.submission = liveWatchSubmission(observed, receipt, submittedAt);
       value.targetTaskRef = value.submission.turnId;
       value.auditTrail.push({timestamp:nowIso(),status:"VERIFYING",detail:"Primary task completed. Running independent verification.",evidence:{traceId}});
       await updateRecord("watch",record.actorId,record.key,()=>value);return;
      }else{
       value.status="VERIFIED";value.voiceDelivery.queued=true;value.updatedAt=nowIso();
       populatePaneDetails(pane, observed);
       value.auditTrail.push({timestamp:nowIso(),status:"VERIFIED",detail:"Task completed successfully and verified.",evidence:{observedState:observed.state}});
       await updateRecord("watch",record.actorId,record.key,()=>value);
       await notifyQueued(saved.roomId, value);
       return;
      }
     }
    }
    if(value.status==="VERIFYING"){
     if(observed.state==="RUNNING")return;
     const verificationTask = liveWatchedTask(value, observed);
     if (!verificationTask || !["COMPLETED", "FAILED", "INTERRUPTED"].includes(verificationTask.status)) return;
     const verificationFailed=verificationTask.status !== "COMPLETED" || observed.state==="ERROR"||observed.state==="EXITED"||/fail|error|mismatch/i.test((observed.text || "").slice(-1000));
     if(verificationFailed){
      if(value.retriesCount<value.maxRetries&&value.remediationPrompt){
       value.retriesCount+=1;value.status="RUNNING";value.taskState="RUNNING";value.updatedAt=nowIso();
       const traceId=makeSpaceId("trace_remediation");
       const submittedAt = nowIso();
       const receipt = await options.send(pane,value.remediationPrompt,traceId);
       value.submission = liveWatchSubmission(observed, receipt, submittedAt);
       value.targetTaskRef = value.submission.turnId;
       value.auditTrail.push({timestamp:nowIso(),status:"RUNNING",detail:`Independent verification failed. Submitting remediation prompt (retry ${value.retriesCount}/${value.maxRetries}).`,evidence:{retriesCount:value.retriesCount,traceId}});
       await updateRecord("watch",record.actorId,record.key,()=>value);return;
      }else{
       value.status="FAILED";value.reason="Independent verification failed and retry limit reached.";value.voiceDelivery.queued=true;value.updatedAt=nowIso();
       populatePaneDetails(pane, observed);
       value.auditTrail.push({timestamp:nowIso(),status:"FAILED",detail:value.reason,evidence:{retriesCount:value.retriesCount,maxRetries:value.maxRetries}});
       await updateRecord("watch",record.actorId,record.key,()=>value);
       await notifyQueued(saved.roomId, value);
       return;
      }
     }else{
      value.status="VERIFIED";value.voiceDelivery.queued=true;value.updatedAt=nowIso();
      populatePaneDetails(pane, observed);
      value.auditTrail.push({timestamp:nowIso(),status:"VERIFIED",detail:"Independent verification passed.",evidence:{observedState:observed.state}});
      await updateRecord("watch",record.actorId,record.key,()=>value);
      await notifyQueued(saved.roomId, value);
      return;
     }
    }
   });
  }

 let ticking=false;
 async function tick(){
  if(ticking)return;ticking=true;
  try{
   for(const record of await repository.list("watch",null)){
    const val=controlWatchSchema.parse(record.value);
    if(["PENDING","RUNNING","VERIFYING"].includes(val.status)){
     const fresh=await repository.get("watch",record.actorId,record.key);if(fresh)await advanceWatch(fresh);
    }
   }
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
  async function screenshot(actor:ControlActor,roomId:string,params:{format?:"jpeg"|"png"|"webp";quality?:number;maxWidth?:number;maxHeight?:number;query?:string}){
   const spec:ControlAction={kind:"screenshot",operation:"capture",target:"APP",format:params.format??"jpeg",quality:params.quality??80,maxWidth:params.maxWidth,maxHeight:params.maxHeight};
   const op=await execute(actor,{roomId,requestId:makeSpaceId("control_shot"),actions:[spec]},true);
   const result=op.results[0];
   if(!result||result.status==="FAILED")throw new SpaceConflictError(result?.detail||"Screenshot capture failed.");
    return {status:result.status,detail:result.detail,evidence:(result.evidence?.result as Record<string,unknown>)||result.evidence||{}};
   }

  async function getCapabilities(roomId?: string) {
    const catalog = roomId ? (await activeRoom(roomId), await controller.catalog(roomId)) : { types: [], unavailable: [] };
    return {
      version: SPACE_CONTROL_VERSION,
      roomId: roomId ?? null,
      phase,
      nativeCliRuntimeIds: phase === 1 ? ["cli:codex"] : [...cliToggleRuntimeIds],
      types: catalog.types.filter(t => t.mode !== "TERMINAL" || supportsRuntime({ mode: "TERMINAL", terminalRuntimeId: t.terminalRuntimeId } as any)),
      unavailable: catalog.unavailable,
      tools: Object.entries(controlToolSchemas).map(([name, schema]) => ({
        name,
        description: controlToolDescriptions[name as keyof typeof controlToolDescriptions],
        inputSchema: z.toJSONSchema(schema)
      })),
      resourceOperations: controlResourceOperations,
      unavailableResources: controlUnavailableResources,
      conditionalLimitations: { "asteroids.control": { unsupportedActions: ["pause"] },
        "settings.voice": { requiresFocusedClient: true, scope: "BROWSER_VOICE_COMPOSER", changesActiveLiveSession: false },
        "screenshot.capture": { configured: Boolean(options.captureScreenshot), requiresAuthenticatedRoomEvidence: true } },
      actionCatalog: controlActionCatalog,
      inspectSections: controlInspectSectionCatalog,
      securityPolicy: controlSecurityPolicy,
      layoutUnits: { x: "percent of room canvas width", width: "percent of room canvas width", y: "12 CSS pixels", height: "12 CSS pixels" },
      schedulePolicy: "Explicit only. Native task, model, operator, stop and quota are rechecked. No automatic model or VPN switching."
    };
  }

  async function testMcpTools(actor: ControlActor, targetRoomId?: string, params?: { tools?: string[]; fast?: boolean }) {
    let effectiveRoomId = targetRoomId;
    if (!effectiveRoomId) {
      let roomList: any[] = [];
      try { roomList = (await store.listRooms()) as any[]; } catch {}
      effectiveRoomId = roomList[0]?.id;
    }

    const isFast = Boolean(params?.fast);
    const probes: Array<{
      name: string;
      domain: string;
      run: () => Promise<unknown>;
    }> = [
      {
        name: "space_capabilities",
        domain: "capabilities",
        run: async () => {
          const caps = await getCapabilities();
          if (!caps.version) throw new Error("Missing version in capabilities");
          return { version: caps.version, toolsCount: caps.tools.length, typesCount: caps.types.length };
        }
      },
      {
        name: "space_inspect:STATE",
        domain: "inspect",
        run: async () => {
          if (!effectiveRoomId) return { skipped: true, reason: "No active room" };
          const res = (await inspect(actor, { roomId: effectiveRoomId, section: "STATE", offset: 0, limit: 25 })) as any;
          return { totalOpenPanes: res.totalOpenPanes ?? res.openPanes?.length ?? 0, paneCap: res.paneCap ?? 16 };
        }
      },
      {
        name: "space_inspect:MODELS",
        domain: "inspect",
        run: async () => {
          if (!effectiveRoomId) return { skipped: true };
          const res = await inspect(actor, { roomId: effectiveRoomId, section: "MODELS", offset: 0, limit: isFast ? 2 : 25 });
          return { count: Array.isArray(res) ? res.length : 0 };
        }
      },
      {
        name: "space_inspect:QUOTA",
        domain: "inspect",
        run: async () => {
          const res = (await inspect(actor, { section: "QUOTA", offset: 0, limit: 25 })) as any;
          return { ok: Boolean(res.data || res.accounts || res.section) };
        }
      },
      {
        name: "space_inspect:RUNTIMES",
        domain: "inspect",
        run: async () => {
          const res = (await inspect(actor, { section: "RUNTIMES", offset: 0, limit: 25 })) as any;
          return { count: (res.data?.runtimes || res.runtimes || []).length };
        }
      },
      {
        name: "space_inspect:SYSTEM_HEALTH",
        domain: "inspect",
        run: async () => {
          const res = (await inspect(actor, { section: "SYSTEM_HEALTH", offset: 0, limit: 25 })) as any;
          return { uptime: res.data?.uptimeSeconds ?? res.uptimeSeconds };
        }
      },
      {
        name: "space_inspect:SKILLS",
        domain: "inspect",
        run: async () => {
          const res = (await inspect(actor, { section: "SKILLS", offset: 0, limit: 25 })) as any;
          return { count: (res.data?.installed?.skills || res.installed?.skills || []).length };
        }
      },
      {
        name: "space_inspect:SETTINGS",
        domain: "inspect",
        run: async () => {
          const res = (await inspect(actor, { section: "SETTINGS", offset: 0, limit: 25 })) as any;
          return { ok: Boolean(res.data || res.section) };
        }
      },
      {
        name: "space_inspect:VOICE",
        domain: "inspect",
        run: async () => {
          const res = (await inspect(actor, { section: "VOICE", offset: 0, limit: 25 })) as any;
          return { ok: Boolean(res.data || res.transcription) };
        }
      },
      {
        name: "space_inspect:PLUGINS",
        domain: "inspect",
        run: async () => {
          const res = (await inspect(actor, { section: "PLUGINS", offset: 0, limit: 25 })) as any;
          return { count: (res.data?.plugins || res.plugins || []).length };
        }
      },
      {
        name: "space_execute:validation",
        domain: "execute",
        run: async () => {
          if (!effectiveRoomId) return { skipped: true };
          const dryRunCmd: ControlExecute = {
            roomId: effectiveRoomId,
            requestId: makeSpaceId("probe_exec"),
            waitForCompletion: false,
            dryRun: true,
            actions: [
              { kind: "room", operation: "rename", name: "Dry-run validation probe" }
            ]
          };
          const res = await execute(actor, dryRunCmd, true);
          if (res.status !== "COMPLETED") throw new Error(`Dry-run validation returned ${res.status}`);
          return { status: res.status };
        }
      },
      {
        name: "space_operations",
        domain: "operations",
        run: async () => {
          if (!effectiveRoomId) return { skipped: true };
          const ops = await operations(actor, effectiveRoomId, undefined, false);
          return { count: Array.isArray(ops) ? ops.length : 0 };
        }
      },
      {
        name: "space_schedules",
        domain: "schedules",
        run: async () => {
          if (!effectiveRoomId) return { skipped: true };
          const scheds = await schedules(actor, effectiveRoomId, "list");
          return { count: Array.isArray(scheds) ? scheds.length : 0 };
        }
      },
      {
        name: "space_watches",
        domain: "watches",
        run: async () => {
          if (!effectiveRoomId) return { skipped: true };
          const w = await watches(actor, effectiveRoomId, "list", {});
          return { count: Array.isArray(w) ? w.length : 0 };
        }
      },
      {
        name: "space_screenshot:readiness",
        domain: "screenshot",
        run: async () => {
          return { skipped: true, configured: Boolean(options.captureScreenshot), reason: "Capture readiness requires an explicit isolated screenshot proof; no image was captured." };
        }
      },
      {
        name: "voice_youtube_search",
        domain: "voice",
        run: async () => {
          return { skipped: true, reason: "No YouTube endpoint probe is configured." };
        }
      }
    ];

    const filterList = params?.tools && params.tools.length > 0 ? params.tools : null;
    const selectedProbes = filterList
      ? probes.filter(p => filterList.some(item => p.name.toLowerCase().includes(item.toLowerCase())))
      : probes;

    const results: Array<{
      tool: string;
      domain: string;
      status: "PASS" | "FAIL" | "WARN";
      latencyMs: number;
      error?: string;
      details?: unknown;
    }> = [];

    let passedCount = 0;
    let failedCount = 0;
    const startedAll = Date.now();

    const probeTimeoutMs = isFast ? 8500 : 15000;

    const probePromises = selectedProbes.map(async (p) => {
      const pStart = Date.now();
      try {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeoutPromise = new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`Timeout after ${probeTimeoutMs}ms`)), probeTimeoutMs);
        });
        const details = await Promise.race([p.run(), timeoutPromise]).finally(() => {
          if (timer) clearTimeout(timer);
        });
        const latencyMs = Date.now() - pStart;
        const skipped = (details as { skipped?: boolean } | null)?.skipped === true;
        return { tool: p.name, domain: p.domain, status: skipped ? "WARN" as const : "PASS" as const, latencyMs, details };
      } catch (err: any) {
        const latencyMs = Date.now() - pStart;
        const errMsg = err?.message || String(err);
        return { tool: p.name, domain: p.domain, status: "FAIL" as const, latencyMs, error: errMsg };
      }
    });

    const settled = await Promise.all(probePromises);
    for (const r of settled) {
      results.push(r);
      if (r.status === "PASS") passedCount++;
      else if (r.status === "FAIL") failedCount++;
    }

    const totalDurationMs = Date.now() - startedAll;
    let incidentId: string | null = null;
    let agentHandoffPrompt: string | null = null;

    if (failedCount > 0) {
      incidentId = `dbg_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      const failedTools = results.filter(r => r.status === "FAIL");
      agentHandoffPrompt = `Space agent incident report ${incidentId}: ${failedCount} MCP tools failed verification in room ${effectiveRoomId || "global"}. Failed: ${failedTools.map(f => `${f.tool}: ${f.error}`).join("; ")}. Please investigate and fix.`;
      try {
        const line = JSON.stringify({
          incidentId,
          timestamp: new Date().toISOString(),
          operation: "space_test_mcp_tools",
          roomId: effectiveRoomId || null,
          failedCount,
          passedCount,
          failedTools: failedTools.map(f => ({ tool: f.tool, error: f.error })),
          agentHandoffPrompt
        }) + "\n";
        appendFileSync("/opt/spaceapp/var/live-voice-logs/debug-incidents.jsonl", line);
      } catch {}
    }

    return {
      status: failedCount === 0 && results.every(r => r.status === "PASS") ? "SUCCESS" : "PARTIAL",
      warnedCount: results.filter(r => r.status === "WARN").length,
      testedCount: results.length,
      passedCount,
      failedCount,
      totalDurationMs,
      results,
      incidentId,
      agentHandoffPrompt
    };
  }

  async function describePaneTypes(roomId?: string) {
    if (!options.describePaneTypes) throw new SpaceConflictError("Pane type catalog is unavailable.");
    return options.describePaneTypes(roomId);
  }

  function listMcpTools(category: "all" | "voice" | "mcp" | "resources" = "all") {
    const mcpToolsList = [
      { name: "space_capabilities", category: "mcp", description: "Discover Space room controls, limits, and runtime support." },
      { name: "space_inspect", category: "mcp", description: "Authoritative inspection across 19 domains (state, models, quota, runtimes, health, settings, etc.)." },
      { name: "space_execute", category: "mcp", description: "Apply atomic batches of controls (panes.open, pane close/prompt/color, layout, clipboard)." },
      { name: "space_screenshot", category: "mcp", description: "Full-screen capture and Vision AI analysis of the Space App." },
      { name: "space_operations", category: "mcp", description: "Inspect or cancel durable asynchronous operations." },
      { name: "space_schedules", category: "mcp", description: "Create or inspect deferred and one-shot schedules." },
      { name: "space_watches", category: "mcp", description: "Durable task completion monitoring with automatic assistant re-engagement." },
      { name: "space_test_mcp_tools", category: "mcp", description: "1-by-1 health and capability verification across all MCP tools and sections." },
      { name: "space_list_mcp_tools", category: "mcp", description: "List all Space Control tools and functions." },
      { name: "space_describe_pane_types", category: "mcp", description: "List pane types with open keys and live availability." },
      { name: "space_debug", category: "mcp", description: "Run diagnostics on any operation or pane, generating incident reports." }
    ];

    const voiceToolsList = [
      { name: "space_inspect_room", category: "voice", description: "Inspect room capacity, open panes, distinct types, and unused panes." },
      { name: "space_open_panes", category: "voice", description: "Open any available pane types (CLI, demos, browser, youtube, files, etc.), bulk fill, or distinct types." },
      { name: "space_send_prompt", category: "voice", description: "Send prompts, questions, stories or tasks to one, multiple, or all open CLI panes." },
      { name: "space_set_pane_model", category: "voice", description: "Change AI model or reasoning effort on CLI terminal panes." },
      { name: "space_run_cli_shortcut", category: "voice", description: "Execute common CLI shortcuts (continue, memory, plan, build, deploy, etc.)." },
      { name: "space_sort_panes", category: "voice", description: "Sort panes by title, runtime, or activity." },
      { name: "space_close_panes", category: "voice", description: "Close target panes, unused panes, or all non-live panes." },
      { name: "space_minimize_panes", category: "voice", description: "Minimize panes into floating circular icons." },
      { name: "space_maximize_panes", category: "voice", description: "Maximize a pane to full view." },
      { name: "space_restore_panes", category: "voice", description: "Restore minimized panes back to grid." },
      { name: "space_play_youtube", category: "voice", description: "Search and play YouTube videos directly in a YouTube pane." },
      { name: "space_set_pane_color", category: "voice", description: "Change pane category color (red, green, blue, etc.)." },
      { name: "space_inspect_cli_runtimes", category: "voice", description: "Check which CLI runtimes are working vs requiring login." },
      { name: "space_capture_screen", category: "voice", description: "Take a screenshot and explain screen contents via Vision AI." },
      { name: "space_test_mcp_tools", category: "voice", description: "Run 1-by-1 verification across all MCP tools." },
      { name: "space_list_mcp_tools", category: "voice", description: "List all voice and MCP tools." },
      { name: "space_set_pane_layout", category: "voice", description: "Change room pane layout matching the Pane layout menu (automatic, fullscreen, 1 column, 2 columns, 3 columns, 4 columns, next) and height presets." },
      { name: "space_describe_pane_types", category: "voice", description: "List pane types with open keys and live availability." },
      { name: "space_debug", category: "voice", description: "Run diagnostic checks on any pane or failure." }
    ];

    return {
      category,
      mcpTools: category === "voice" ? [] : mcpToolsList,
      voiceTools: category === "mcp" ? [] : voiceToolsList,
      resourceOperations: category === "resources" || category === "all" ? controlResourceOperations : [],
      unavailableResources: category === "resources" || category === "all" ? controlUnavailableResources : {}
    };
  }

  async function runDebug(actor: ControlActor, targetRoomId?: string, opName?: string, paneId?: string, query?: string) {
    let effectiveRoomId = targetRoomId;
    if (!effectiveRoomId) {
      let roomList: any[] = [];
      try { roomList = (await store.listRooms()) as any[]; } catch {}
      effectiveRoomId = roomList[0]?.id;
    }
    const incidentId = `dbg_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const timestamp = new Date().toISOString();

    const issues: string[] = [];
    let probableCause = "No critical system errors detected.";
    let recommendedFix = "All system checks completed normally.";

    let capacityInfo: any = null;
    if (effectiveRoomId) {
      try {
        const r = await store.getRoom(effectiveRoomId);
        const openCount = (await store.listPanes(effectiveRoomId, true)).filter((p: any) => !p.isClosed).length;
        capacityInfo = { openCount, cap: r.paneCap ?? 16 };
        if (openCount >= (r.paneCap ?? 16)) {
          issues.push(`Room has reached maximum capacity (${openCount}/${r.paneCap ?? 16} panes).`);
          probableCause = "Room capacity full. New panes cannot open without closing idle ones or increasing paneCap.";
          recommendedFix = "Close unused panes using space_close_panes(filter: 'unused') or increase room.paneCap.";
        }
      } catch {}
    }

    const disabledRuntimes: string[] = [];
    try {
      const settings = await store.listCliRuntimeSettings();
      for (const s of settings) {
        if (!s.enabled) disabledRuntimes.push(s.runtimeId);
      }
    } catch {}

    let recentIncidents: any[] = [];
    try {
      const content = await fsPromises.readFile("/opt/spaceapp/var/live-voice-logs/debug-incidents.jsonl", "utf8");
      recentIncidents = content.trim().split("\n").filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean).slice(-5);
    } catch {}

    const hasIssues = issues.length > 0;
    const agentHandoffPrompt = hasIssues
      ? `Space agent incident report ${incidentId}: Diagnosis in room ${effectiveRoomId || "global"} identified issues: ${issues.join("; ")}. Probable cause: ${probableCause}. Action: ${recommendedFix}.`
      : `Space agent debug check ${incidentId}: All diagnostic preflights passed in room ${effectiveRoomId || "global"}. No active blocking incidents found.`;

    return {
      status: hasIssues ? "WARNING" : "HEALTHY",
      incidentId,
      timestamp,
      operation: opName || "diagnostic_check",
      roomId: effectiveRoomId || null,
      paneId: paneId || null,
      capacityInfo,
      disabledRuntimes,
      recentIncidentsCount: recentIncidents.length,
      issues,
      probableCause,
      recommendedFix,
      agentHandoffPrompt
    };
  }

  return {
    state,
    inspect,
    execute,
    screenshot,
    operations,
    schedules,
    watches,
    pendingWatches,
    testMcpTools,
    listMcpTools,
    describePaneTypes,
    runDebug,
    tick,
    rememberStop,
    withOperatorMutation,
    registerClient,
    unregisterClient,
    acknowledge,
    layout: async (roomId: string) => (await layoutRecord(roomId))?.value ?? null,
    capabilities: getCapabilities,
    async start() { await recover(); timer = setInterval(() => void tick().catch(() => {}), 1000); timer.unref(); },
    async close() { if (timer) clearInterval(timer); await Promise.allSettled(active.values()); await repository.dispose(); }
  };
}
