import type { CliHostGateway } from "./cli-terminal.js";
import { CliHostClient, type CliHostIdentity } from "@space/cli-host";
import { SpaceConflictError, type SpaceStore } from "@space/runtime";
import type { Pane, PaneCliSession } from "@space/contracts";

export const warmCapacityProofDescription = "Fixed sixteen-terminal warm capacity fixture. [WARM_CAPACITY:v1]";
export const cliRenderProofDescription = "Fixed synthetic CLI render fixture. [CLI_RENDER:v1]";
export const cliRenderProofRuntimeIds = ["cli:codex", "cli:gemini", "cli:opencode"] as const;
export type CliRenderProofRuntimeId = typeof cliRenderProofRuntimeIds[number];
export const isCliRenderProofRuntimeId = (value:string|null|undefined): value is CliRenderProofRuntimeId => cliRenderProofRuntimeIds.includes(value as CliRenderProofRuntimeId);
export async function isCliRenderProofSession(store:SpaceStore,session:PaneCliSession):Promise<boolean> {
  if(session.purpose!=="NORMAL"||session.cwd!=="/tmp"||!isCliRenderProofRuntimeId(session.runtimeId))return false;
  const room=await store.getRoom(session.roomId);
  return room.kind==="AGENT_PROOF"&&[cliRenderProofDescription,warmCapacityProofDescription].includes(room.description??"");
}
const identity = (session: PaneCliSession): CliHostIdentity => ({cliSessionId:session.sessionId,paneId:session.paneId,roomId:session.roomId,runtimeId:session.runtimeId,codexThreadId:session.codexThreadId,modelId:session.modelId,reasoningEffort:session.reasoningEffort});
async function withHost<T>(socketPath:string, supplied:CliHostGateway|undefined, work:(host:CliHostGateway)=>Promise<T>) {
  const host=supplied??new CliHostClient({socketPath});
  try{return await work(host);}finally{if(!supplied)await host.close();}
}
export async function createCliRenderProofFixture(store:SpaceStore,pane:Pane,traceId:string,socketPath:string,host?:CliHostGateway) {
  const room=await store.getRoom(pane.roomId);
  if(room.kind!=="AGENT_PROOF"||![cliRenderProofDescription,warmCapacityProofDescription].includes(room.description??"")||!isCliRenderProofRuntimeId(pane.terminalRuntimeId))throw new SpaceConflictError("CLI render fixture requires an isolated allowlisted proof pane.");
  // Resolve from the versioned API bundle, never caller input or the current cwd.
  const fixtureUrl=new URL("../../../scripts/cli-render-fixture.mjs",import.meta.url);
  const {fixtureProgram}=await import(fixtureUrl.href) as {fixtureProgram:()=>string};
  const warmCapacity = room.description === warmCapacityProofDescription;
  if (warmCapacity && pane.terminalRuntimeId !== "cli:codex") throw new SpaceConflictError("Warm capacity runtime changed.");
  const runtimeName=pane.terminalRuntimeId.slice(4);
  const session=await store.createPaneCliSession({paneId:pane.id,roomId:pane.roomId,runtimeId:pane.terminalRuntimeId,providerId:runtimeName,agentId:runtimeName,modelId:null,reasoningEffort:"low",launchMode:"FRESH",cwd:"/tmp",codexThreadId:null,status:"IDLE",statusReason:"Fixed synthetic CLI render fixture; no AI provider task."},traceId);
  return withHost(socketPath,host,async client=>{
    const attached=await client.attach({identity:identity(session),spawn:{command:warmCapacity?"/bin/sh":process.execPath,args:warmCapacity?["-c","printf 'SPACE_WARM_READY\\r\\n'; exec /bin/sleep 240"]:["--input-type=module","-e",fixtureProgram()],cwd:"/tmp",env:{TERM:"xterm-256color",LANG:"C.UTF-8"},cols:100,rows:30}});
    try {
      if(attached.session.status!=="RUNNING")throw new SpaceConflictError("Synthetic CLI render process did not start.");
      return await store.updatePaneCliSession(session.sessionId,{status:"RUNNING",statusReason:"Fixed synthetic CLI render process is running; no AI provider task.",isActive:true},traceId);
    } finally {
      await client.detach(identity(session),attached.attachmentId);
    }
  });
}
export async function startCliRenderProofFixture(store:SpaceStore,roomId:string,socketPath:string,host?:CliHostGateway) {
  const room=await store.getRoom(roomId),panes=await store.listPanes(roomId);
  if(room.kind!=="AGENT_PROOF"||room.description!==cliRenderProofDescription||![1,3].includes(panes.length))throw new SpaceConflictError("CLI render fixture scope changed.");
  const sessions=await Promise.all(panes.map(pane=>store.getActivePaneCliSession(pane.id)));
  if(sessions.some((session,index)=>!session||session.status!=="RUNNING"||session.cwd!=="/tmp"||!isCliRenderProofRuntimeId(session.runtimeId)||session.runtimeId!==panes[index]!.terminalRuntimeId))throw new SpaceConflictError("CLI render fixture session unavailable.");
  return withHost(socketPath,host,async client=>{
    const started=[];
    for(const session of sessions) {
      if(!session||!await client.inspect(identity(session)))throw new SpaceConflictError("Fixture expired; it cannot be respawned by this control.");
      const attached=await client.attach({identity:identity(session),afterSequence:Number.MAX_SAFE_INTEGER});
      try{await client.input(identity(session),attached.attachmentId,"SPACE_RENDER_START\n","hidden",`cli-render:${session.sessionId}`);started.push({sessionId:session.sessionId,runtimeId:session.runtimeId});}
      finally{await client.detach(identity(session),attached.attachmentId);}
    }
    return {started:true,sessions:started};
  });
}
