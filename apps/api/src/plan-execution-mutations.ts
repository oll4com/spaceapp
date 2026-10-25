import { randomUUID } from 'node:crypto';
import type { ManagedPlanExecution, StageModelSelection } from '@space/contracts';
import { SpaceConflictError, PlanExecutionConflictError, type SpaceStore, type ManagedPlanExecutionPatch } from '@space/runtime';
/** Retain START and its observer while a separate exact-turn interrupt is reconciled. */
function interrupt(execution: ManagedPlanExecution, reason: 'OVERRIDE' | 'PAUSE'): ManagedPlanExecutionPatch {
 const start=execution.pendingCommand;
 if(start?.type!=='START') return {pendingCommand:null,interruptCommand:null,interruptReason:null,
  status:reason==='PAUSE'?'PAUSED':execution.status==='PAUSED'?'PAUSED':'RESUMING_STAGE',nextRetryAt:null,statusReason:null};
 return {interruptReason:reason,status:'SWITCHING_MODEL',statusReason:reason==='PAUSE'?'Waiting for the native turn to stop.':'Switching the stage model after native interruption.',
  interruptCommand:execution.interruptCommand ?? (start.turnId?{...start,id:randomUUID(),type:'INTERRUPT',status:'PREPARED',preparedAt:new Date().toISOString()}:null)};
}
export function stageOverridePatch(execution:ManagedPlanExecution,stageId:string,selection:StageModelSelection|null):ManagedPlanExecutionPatch {
 if(['COMPLETED','FAILED'].includes(execution.status)||execution.completedStageIds.includes(stageId))throw new PlanExecutionConflictError('Completed stages are immutable.');
 const overrides={...execution.overrides};if(selection)overrides[stageId]=selection;else delete overrides[stageId];
 const active=execution.snapshot.stages[execution.activeStageIndex]?.id===stageId;
 // An override never revokes a deliberate pause or unblocks ambiguous acceptance.
 return {overrides,...(active&&execution.status!=='BLOCKED'?interrupt(execution,execution.interruptReason==='PAUSE'?'PAUSE':'OVERRIDE'):{})};
}
export function executionControlPatch(execution:ManagedPlanExecution,action:'pause'|'resume'):ManagedPlanExecutionPatch {
 if(['COMPLETED','FAILED'].includes(execution.status))throw new PlanExecutionConflictError('Finished executions cannot be controlled.');
 if(action==='pause')return interrupt(execution,'PAUSE');
 if(execution.pendingCommand?.type==='START'||execution.interruptCommand||execution.interruptReason)
  throw new PlanExecutionConflictError('Native command reconciliation must finish before resuming.');
 if(!['PAUSED','BLOCKED','WAITING_FOR_MODEL'].includes(execution.status))throw new PlanExecutionConflictError('This execution is not paused.');
 return {status:'RESUMING_STAGE',statusReason:null,nextRetryAt:null,interruptReason:null};
}

/** Room configuration and managed creation share one per-pane mutation boundary. */
const paneMutations = new WeakMap<SpaceStore, Map<string, Promise<void>>>();
export async function withPlanPaneMutation<T>(store: SpaceStore, paneId: string, operation: () => Promise<T>): Promise<T> {
 let panes=paneMutations.get(store);
 if(!panes){panes=new Map();paneMutations.set(store,panes);}
 const previous=panes.get(paneId) ?? Promise.resolve();
 let release!:()=>void;
 const current=new Promise<void>(resolve=>{release=resolve;});
 panes.set(paneId,current);
 await previous;
 try {return await operation();}
 finally {release();if(panes.get(paneId)===current)panes.delete(paneId);}
}
export async function assertUnmanagedPlanPane(store: SpaceStore, paneId: string): Promise<void> {
 if((await store.planExecutions.listActive()).some(execution=>execution.paneId===paneId))
  throw new SpaceConflictError('This pane has a managed plan execution. Change the exact stage through its override endpoint.');
}
export async function applyUnmanagedCodexModelSettings<T>(store: SpaceStore, paneId: string, options: {
 inspect():Promise<T>;
 assertCurrent(selection:T):Promise<void>;
 updateSettings(selection:T,beforeSend:()=>Promise<void>):Promise<void>;
 updateRouter(selection:T):Promise<void>;
 finish(selection:T):Promise<void>;
}):Promise<void> {
 await assertUnmanagedPlanPane(store,paneId);
 const selection=await options.inspect();
 await withPlanPaneMutation(store,paneId,async()=>{
  const fence=async()=>{await options.assertCurrent(selection);await assertUnmanagedPlanPane(store,paneId);};
  await fence();
  await options.updateSettings(selection,fence);
  await fence();
  // Retain ownership through the router's internal awaits. Managed creation
  // cannot take this pane until both native mutations and readback finish.
  await options.updateRouter(selection);
  await options.finish(selection);
 });
}
