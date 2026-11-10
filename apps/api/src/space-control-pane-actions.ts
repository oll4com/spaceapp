import { createHash } from "node:crypto";
import type { AntigravityUsageAccountList, Pane } from "@space/contracts";
import { fetchOpenCodeSessionIsTurnActive, readOpenCodeSessionTurnActive, sendOpenCodePrompt } from "@space/opencode-control";
import { SpaceConflictError, type SpaceStore } from "@space/runtime";
import { isCodexDirectParityRuntime, isOpenCodeDirectParityRuntime } from "./cli-parity.js";
import { COMPOSER_CHECKED_RUNTIMES, draftNoticeLine, isDraftError, submitCliPrompt } from "./cli-prompt-submit.js";
import type { CliTerminalManager } from "./cli-terminal.js";
import { verifyGeminiPaneSession } from "./gemini-session-verification.js";
import type { NousWiring } from "./nous/wiring.js";
import type { createOpenCodeServerControlResolver } from "./opencode-server-control.js";
import type { createPaneCliModel } from "./pane-cli-model.js";
import type { createRoomCliControl } from "./room-cli-control.js";
import { notePanePrompted } from "./room-agent-monitor.js";
import type { SpaceAgentAdapter } from "./space-agent.js";

type SpaceControlPaneActionDeps = {
  store: SpaceStore;
  cliTerminalManager: CliTerminalManager;
  spaceAgentAdapter: Pick<SpaceAgentAdapter, "sendMessage">;
  antigravityUsageProvider: () => Promise<AntigravityUsageAccountList>;
  dashboardAgentsCache: { delete(roomId: string): unknown };
  nousRef: { readonly current: Pick<NousWiring, "service"> | null };
  roomOwner: (roomId: string) => Promise<string | null>;
} & Pick<ReturnType<typeof createRoomCliControl>, "inspectRoomCli" | "roomCliSession" | "roomCliObservationCache">
  & Pick<ReturnType<typeof createPaneCliModel>, "readPaneCliModelSettings">
  & Pick<ReturnType<typeof createOpenCodeServerControlResolver>, "resolveOpenCodeServerControl">;

/**
 * Space Control's pane actions: a pane's native quota (a Gemini pane's verified Google account and its windows, a Codex pane's
 * rate limits) and a prompt sent to a Chat pane, an OpenCode pane through its server, a Codex pane as a turn on its live thread,
 * or any other CLI typed at its prompt; a draft left in a Claude composer tells Nous.
 */
export function createSpaceControlPaneActions(deps: SpaceControlPaneActionDeps) {
  const { store, cliTerminalManager, spaceAgentAdapter, antigravityUsageProvider, dashboardAgentsCache, nousRef, roomOwner, inspectRoomCli, roomCliSession,
    roomCliObservationCache, readPaneCliModelSettings, resolveOpenCodeServerControl } = deps;
  async function controlQuota(pane:Pane){
    if(pane.mode==="TERMINAL"&&pane.terminalRuntimeId==="cli:gemini"){
      const session=await store.getActivePaneCliSession(pane.id)??(await store.listPaneCliSessions(pane.id,1))[0];
      const pids = session ? await cliTerminalManager.activeSessionPids([session]).catch(() => null) : null;
      const rootPid = session ? (pids?.get(session.sessionId) ?? null) : null;
      const usageList = await antigravityUsageProvider().catch(() => ({ data: [] }));
      const verified = await verifyGeminiPaneSession({
        pane,
        session,
        rootPid,
        usageAccounts: usageList.data
      });

      const activeProfileId = verified.accountProfileId;
      const account = activeProfileId
        ? (usageList.data.find(a => a.id === activeProfileId) ||
           (verified.accountEmail ? usageList.data.find(a => a.email === verified.accountEmail) : undefined))
        : undefined;

      const windows: Array<{window:string; remainingPercent:number|null; resetAt:string|null}> = [];
      if(account?.gemini?.fiveHourRemainingPercent!==null&&account?.gemini?.fiveHourRemainingPercent!==undefined){
        windows.push({window:"5h",remainingPercent:account.gemini.fiveHourRemainingPercent,resetAt:account.gemini.fiveHourResetAt??null});
      }
      if(account?.gemini?.weeklyRemainingPercent!==null&&account?.gemini?.weeklyRemainingPercent!==undefined){
        windows.push({window:"weekly",remainingPercent:account.gemini.weeklyRemainingPercent,resetAt:account.gemini.weeklyResetAt??null});
      }
      const isConnected = account?.status === "CONNECTED";
      const hasQuota = (account?.gemini?.fiveHourRemainingPercent ?? 0) > 0;
      const isVerified = verified.accountVerificationStatus === "VERIFIED";
      const allowed = Boolean(activeProfileId) && isConnected && hasQuota;
      const reason = !activeProfileId
        ? "Google account profile is unknown."
        : !account
        ? `Google account profile "${activeProfileId}" has no quota data.`
        : account.status === "UNLICENSED"
        ? "Google account is unlicensed."
        : (account.gemini?.fiveHourRemainingPercent === 0)
        ? "Google Gemini 5-hour quota is exhausted."
        : !isVerified
        ? `Google account profile "${activeProfileId}" has available quota, but is unverified on live process.`
        : windows.length
        ? "Google account quota is available."
        : "Google account quota windows are unknown.";

      return {
        paneId: pane.id,
        sessionId: session?.sessionId ?? null,
        runtimeId: "cli:gemini",
        accountProfileId: activeProfileId,
        accountEmail: verified.accountEmail ?? account?.email ?? null,
        accountVerificationStatus: verified.accountVerificationStatus,
        configuredModelId: verified.configuredModelId,
        effectiveModelId: verified.effectiveModelId,
        modelVerificationStatus: verified.modelVerificationStatus,
        email: verified.accountEmail ?? account?.email ?? null,
        tier: account?.tier ?? null,
        status: account?.status ?? "UNKNOWN",
        gemini: account?.gemini ?? null,
        claude: account?.claude ?? null,
        windows,
        blocked: !allowed,
        allowed,
        reason,
        verificationEvidence: verified.verificationEvidence
      };
    }
    if(pane.mode!=="TERMINAL"||pane.terminalRuntimeId!=="cli:codex")throw new SpaceConflictError("Native quota requires a Codex or Gemini CLI pane.");
    const session=await store.getActivePaneCliSession(pane.id)??(await store.listPaneCliSessions(pane.id,1))[0];
    if(!session)throw new SpaceConflictError("Codex session identity is unavailable.");
    const observed=await readPaneCliModelSettings(pane,session,"control-quota");
    const quota=await observed.directControl.readRateLimits?.();
    if(!quota)throw new SpaceConflictError("Native quota source is unavailable for this runtime.");
    return {...quota,paneId:pane.id,sessionId:session.sessionId,nativeTaskRef:observed.settings.threadId,
      allowed:quota.windows.length>0&&!quota.blocked,reason:quota.blocked?"Native account quota is exhausted.":quota.windows.length?"Native account quota is available.":"Native quota windows are unknown."};
  }
  /** Every prompt Space types into a pane: a text still a draft after every Enter reaches Nous at once as pane-draft:<paneId> (31/10 Alex/Max; Codex too, 3/11 Bruno/Oscar). */
  const typePrompt=(pane:Pane,session:{sessionId:string;runtimeId:string},text:string,traceId:string,options:{gapMs?:number;requestId?:string}={})=>
    submitCliPrompt(cliTerminalManager,session.sessionId,text,traceId,`${traceId}:${pane.id}`,{waitForComposer:true,...options,paneId:pane.id,onlyWhenReady:COMPOSER_CHECKED_RUNTIMES.has(session.runtimeId)}).catch(async(error:unknown)=>{
      const owner=isDraftError(error)?await roomOwner(pane.roomId):null;
      if(owner)await nousRef.current?.service.notice(owner,`pane-draft:${pane.id}`,draftNoticeLine(pane.paneName??pane.title,text),undefined,{soonMs:5_000}).catch(()=>undefined);
      throw error;
    });
  const controlSend = async(pane: Pane, text: string, traceId: string, sourceRequestId?: string) => {
    roomCliObservationCache.delete(pane.id);
    // The Room Agent monitor reads the room at once and on every tick for a while, so a short turn files its turn-end report.
    notePanePrompted(pane.roomId);
    try {
    if(pane.mode==="CHAT"){
      // Control request IDs can occupy all 128 characters. The native Chat
      // workflow adds room/pane prefixes, so derive a bounded stable trace.
      const chatTraceId=createHash("sha256").update(JSON.stringify([traceId,pane.id])).digest("hex").slice(0,32);
      const result=await spaceAgentAdapter.sendMessage({pane,content:text,traceId:chatTraceId});
      return {sessionId:result.session.binding.sessionId,state:result.session.runStatus,submitted:true};
    }
    if(text.length>20_000)throw new SpaceConflictError("CLI prompts support at most 20,000 characters per turn.");
    const session=await roomCliSession(pane);
    const control=isOpenCodeDirectParityRuntime(session.runtimeId)?await resolveOpenCodeServerControl(session).catch(()=>null):null;
    if(control){// 2026-10-30 REVIEW (4 sends failed "Live OpenCode model control is unavailable"): a prompt needs no model control; without its server it is typed below.
      const turnActive=await readOpenCodeSessionTurnActive(control,control.nativeSessionId);if(turnActive!==false)throw new SpaceConflictError(turnActive?"OpenCode already has an active turn.":"OpenCode did not report whether a turn is running; try again.");
      if(!(await sendOpenCodePrompt(control,control.nativeSessionId,text)))throw new SpaceConflictError("OpenCode rejected prompt injection.");
      for(let attempt=0;attempt<2;attempt++){
        await new Promise(r=>setTimeout(r,30));
        if(await fetchOpenCodeSessionIsTurnActive(control,control.nativeSessionId)){
          return {sessionId:session.sessionId,nativeTaskRef:control.nativeSessionId,state:"RUNNING",submitted:true};
        }
      }
      return {sessionId:session.sessionId,nativeTaskRef:control.nativeSessionId,state:"RUNNING",submitted:true};
    }
    if(isCodexDirectParityRuntime(session.runtimeId)){
      return cliTerminalManager.runSerializedTerminalMutation(session.sessionId,async()=>{
        const before=await readPaneCliModelSettings(pane,session,traceId).catch(()=>null);
        if(before?.settings?.isTurnActive)throw new SpaceConflictError("Codex already has an active turn.");
        if(before?.settings?.threadId){
          const turn=await before.directControl.startTurn({threadId:before.settings.threadId,prompt:text,
            ...(before.settings.current?{model:before.settings.current.modelId,reasoningEffort:before.settings.current.reasoningEffort}:{}),
            clientUserMessageId:`space-control:${traceId}:${pane.id}`.slice(0,200), ...(sourceRequestId ? { sourceRequestId } : {})});
          return {sessionId:session.sessionId,nativeTaskRef:before.settings.threadId,turnId:turn.turnId,state:turn.status,submitted:true};
        }
        // OBS-006: a typed prompt names its request as the native turn's space_request_id does (an HTTP caller's id wins).
        await typePrompt(pane,session,text,traceId,{requestId:sourceRequestId??traceId});
        return {sessionId:session.sessionId,nativeTaskRef:before?.settings?.threadId??session.sessionId,state:"RUNNING",submitted:true,requestId:sourceRequestId??traceId};
      });
    }
    return cliTerminalManager.runSerializedTerminalMutation(session.sessionId,async()=>{
      const observed=await inspectRoomCli(pane);
      if(observed.state==="RUNNING")throw new SpaceConflictError("CLI already has an active turn.");
      await typePrompt(pane,session,text,traceId,{gapMs:40,requestId:sourceRequestId??traceId});
      return {sessionId:session.sessionId,nativeTaskRef:observed.nativeTaskRef??session.sessionId,state:"RUNNING",submitted:true,requestId:sourceRequestId??traceId};
    });
    } finally {
      roomCliObservationCache.delete(pane.id);
      dashboardAgentsCache.delete(pane.roomId);
    }
  };
  return { controlQuota, controlSend };
}
