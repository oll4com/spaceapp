import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { cliToggleRuntimeIdSchema, type ControlAction, type ControlInspect, type Pane } from "@space/contracts";
import type { ControlRepository } from "@space/db";
import { SpaceConflictError, makeSpaceId, type SpaceEventBus, type SpaceStore } from "@space/runtime";
import { z } from "zod";
import { safeBrowserObservationText, safeBrowserObservationUrl } from "./browser-observation.js";
import type { BrowserSessionManagerWithHostHealth } from "./browser-host-proxy.js";
import { persistAgentFile } from "./cli-agent-files.js";
import type { CliRuntimeVisibilityPolicy } from "./cli-runtime-visibility.js";
import type { SpaceApiConfig } from "./config.js";
import { withPersistedUpload, withStagedBufferUpload } from "./multipart-upload.js";
import { assertBrowserPaneCompatible } from "./pane-guards.js";
import { pluginsService } from "./plugins-service.js";
import { supportsControlRuntime } from "./space-control.js";
import type { createSpaceControlPanesOpen } from "./space-control-panes-open.js";
import { controlPublishInput, controlResourceRoutes, controlSkills } from "./space-control-resources.js";
import { captureControlSettingsSnapshot, executeControlPluginAction, restoreControlSettingsSnapshot, type ControlActor } from "./space-control-settings.js";
import { buildGenericUserUploadStorage, inferUploadMimeType, isVideoMimeType, sniffImageMime } from "./upload-media.js";
import { recordUploadedArtifact } from "./upload-record.js";
import type { VaultProtection } from "./vault/protection.js";

type SpaceControlIntegrationDeps = {
  store: SpaceStore;
  config: Pick<SpaceApiConfig, "browserEvidenceArtifactRoot">;
  eventBus: Pick<SpaceEventBus, "publish">;
  browserSessionManager: BrowserSessionManagerWithHostHealth;
  controlRepository: ControlRepository;
  cliRuntimeVisibility: Pick<CliRuntimeVisibilityPolicy, "createDisablePreview">;
  controlUser: (id: string) => Promise<unknown>;
  controlInvoke: (actorId: string, method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE", url: string, payload?: unknown) => Promise<unknown>;
  vault: { protection: Pick<VaultProtection, "ownerOf" | "release"> };
  spaceControl: { inspect(actor: ControlActor, input: ControlInspect): Promise<unknown> };
} & Pick<ReturnType<typeof createSpaceControlPanesOpen>, "openControlPanes">;

/** An artifact id inside a path or URL (/api/artifacts/artifact:x/preview), as file-mentions.ts writes one. */
const ARTIFACT_IN_PATH = /artifact:[A-Za-z0-9_-]{1,80}(?![A-Za-z0-9_-])/;

/**
 * Space Control's integration actions: resource operations (CLI access, split, browser navigation and page text under the Vault
 * fence, skills, panes.open, media and file publishing, protected ops tools, Asteroids, settings snapshots and plugins, then the
 * generic resource routes with their room, runtime and delete-confirmation checks), CLI runtime switches and VPN switches/rotation.
 */
export function createSpaceControlIntegration(deps: SpaceControlIntegrationDeps) {
  const { store, config, eventBus, browserSessionManager, controlRepository, cliRuntimeVisibility, controlUser, controlInvoke, vault,
    spaceControl, openControlPanes } = deps;
  async function controlIntegration(actor: ControlActor, roomId: string, action: ControlAction) {
    await controlUser(actor.id);
    if(action.kind==="resource"){
      if(action.operation==="access.cli")return controlInvoke(actor.id,"POST","/api/control/v1/grant",{roomId,enabled:z.boolean().parse(action.input.enabled)});
      if(action.operation==="panes.split"){
        const pane=await store.getPane(z.string().min(1).parse(action.id));
        if(pane.roomId!==roomId)throw new SpaceConflictError("Pane is outside this room.");
        const input=z.object({direction:z.enum(["horizontal","vertical"])}).strict().parse(action.input);
        return controlInvoke(actor.id,"POST","/api/panes",{roomId,title:pane.title,mode:pane.mode,
          terminalRuntimeId:pane.terminalRuntimeId,providerId:pane.providerId,modelId:pane.modelId,vncTarget:pane.vncTarget,
          split:{parentId:pane.id,direction:input.direction,size:50}});
      }
      if(["browser.back","browser.forward","browser.reload","browser.content"].includes(action.operation)){
        const pane=await store.getPane(z.string().min(1).parse(action.id));
        if(pane.roomId!==roomId)throw new SpaceConflictError("Pane is outside this room.");
        assertBrowserPaneCompatible(pane);
        const context={holderType:"OPERATOR" as const,holderId:actor.id};
        if(action.operation==="browser.content"){
          // The Vault fence covers in-process reads too (Room Agent, Nous): no page text while a fill is in the page.
          if(await vault.protection.ownerOf(pane.id)&&!(await vault.protection.release(pane.id)))throw new SpaceConflictError("This browser holds a Vault fill: its page is not read until it shows the next page.");
          const result=await browserSessionManager.action(pane,{type:"extract_text"},makeSpaceId("trace"),context);
          return {paneId:pane.id,text:safeBrowserObservationText(result.text),currentUrl:safeBrowserObservationUrl(result.session.currentUrl)};
        }
        if(!browserSessionManager.acquireControl||!browserSessionManager.input||!browserSessionManager.releaseControl)throw new SpaceConflictError("Browser navigation control is unavailable.");
        const session=await store.getActivePaneBrowserSession(pane.id);
        const existing=session?await store.getActiveBrowserControlLease(session.sessionId):null;
        const traceId=makeSpaceId("trace");
        const lease=await browserSessionManager.acquireControl(pane,{...context,ttlSeconds:30,reason:"Operator Space control"},traceId,context);
        try{
          const result=await browserSessionManager.input(pane,{type:"NAVIGATION",leaseId:lease.leaseId,action:action.operation.slice(8).toUpperCase() as "BACK"|"FORWARD"|"RELOAD"},traceId,context);
          return {paneId:pane.id,currentUrl:safeBrowserObservationUrl(result.session.currentUrl),state:result.session.status};
        }finally{if(existing?.leaseId!==lease.leaseId)await browserSessionManager.releaseControl(pane,{leaseId:lease.leaseId},traceId,context);}
      }
      if(action.operation==="skills.read")return controlSkills(action.id);
      if(action.operation==="panes.open")return openControlPanes(actor,roomId,action);
      if(action.operation==="media.publish" || action.operation==="files.publish"){
        const input=controlPublishInput.parse(action.input);
        const buffer=input.text!==undefined?Buffer.from(input.text):Buffer.from(input.base64!,"base64");
        return withStagedBufferUpload(config.browserEvidenceArtifactRoot, {buffer,filename:input.filename,mimeType:input.mimeType}, async upload => {
          if(action.operation==="files.publish"){
            const artifact=await persistAgentFile({store,artifactRoot:config.browserEvidenceArtifactRoot,roomId,paneId:null,cliSessionId:null,runtimeId:"space-control",originalFilename:input.filename,
              declaredMimeType:input.mimeType,sourcePath:upload.sourcePath,traceId:makeSpaceId("trace")});
            eventBus.publish(artifact.event); return {id:artifact.artifact.id,mimeType:artifact.artifact.mimeType};
          }
          const mimeType=sniffImageMime(upload.sample)??inferUploadMimeType(input.filename,input.mimeType);
          const storage=buildGenericUserUploadStorage({artifactRoot:config.browserEvidenceArtifactRoot,roomId,originalFilename:input.filename});
          const result=await withPersistedUpload(config.browserEvidenceArtifactRoot,upload,storage.filePath,pinnedPath =>
            recordUploadedArtifact(store,{roomId,paneId:null,kind:mimeType.startsWith("image/")?"IMAGE":isVideoMimeType(mimeType)?"VIDEO":"EXPORT",mimeType,
              storageUri:storage.storageUri,sha256:upload.sha256,byteSize:upload.byteSize,
              metadata:{source:"USER_UPLOAD",originalFilename:input.filename,storedFilename:storage.storedFilename,uploadedBy:actor.id}},makeSpaceId("trace"),pinnedPath));
          eventBus.publish(result.event);return {id:result.artifact.id,mimeType:result.artifact.mimeType};
        });
      }
      if(action.operation.startsWith("ops.")){
        const toolIds={"ops.status":"space-readonly:space_status","ops.logs":"space-readonly:space_logs","ops.test":"space_ops:space_scoped_test","ops.verify":"space_ops:space_live_verify","ops.proof":"space-readonly:space_authenticated_ui_proof"} as const; // The API's MCP registry (SPACE_MCP_SERVERS_JSON) serves the read-only ops tools as space-readonly.
        const toolId=toolIds[action.operation as keyof typeof toolIds];
        if(!toolId)throw new SpaceConflictError("Unknown protected operation.");
        const execution=await controlInvoke(actor.id,"POST","/api/mcp/tools/execute",{roomId,toolId,arguments:action.input,
          ...(action.approvalReason?{approvalReason:action.approvalReason}:{})}) as {artifact?:{metadata?:{localPath?:unknown}}|null}|null;
        // The executor answers with the artifact's path only; the caller (Nous's ops.logs) needs the tool's answer itself.
        const localPath=execution?.artifact?.metadata?.localPath;
        if(typeof localPath!=="string"||!resolve(localPath).startsWith(`${resolve(config.browserEvidenceArtifactRoot,"mcp-executions")}/`))return execution;
        return {...execution,output:(JSON.parse(await readFile(localPath,"utf8")) as {result?:unknown}).result??null};
      }
      if(action.operation==="asteroids.control"){
        const input=z.object({action:z.enum(["start","pause","reset","telemetry"]).default("telemetry"),modelId:z.string().trim().min(1).optional()}).strict().parse(action.input);
        if(input.action==="pause")throw new SpaceConflictError("Asteroids pause has no verified execution adapter; no game state was changed.");
        if(input.action==="reset")return controlInvoke(actor.id,"POST","/api/asteroids/benchmark/championship/reset");
        if(input.action==="start"){
          if(!input.modelId)throw new SpaceConflictError("Choose an explicit configured model before starting the Asteroids benchmark.");
          return controlInvoke(actor.id,"POST","/api/asteroids/benchmark/runs",{mode:"championship",contestants:[input.modelId,"baseline/scripted-pilot"],rounds:1});
        }
        return controlInvoke(actor.id,"GET","/api/asteroids/benchmark/championship");
      }
      if(action.operation==="settings.snapshot"){
        return captureControlSettingsSnapshot({actor,roomId,input:action.input,repository:controlRepository,
          inspect:()=>spaceControl.inspect(actor,{roomId,section:"SETTINGS",offset:0,limit:100})});
      }
      if(action.operation==="settings.rollback"){
        return restoreControlSettingsSnapshot({actor,roomId,input:action.input,repository:controlRepository,
          store,pluginsService});
      }
      if(action.operation==="settings.plugins"){
        return executeControlPluginAction({actor,roomId,input:action.input,repository:controlRepository,
          pluginsService});
      }
      const route=controlResourceRoutes[action.operation];
      if(!route)throw new SpaceConflictError("Resource operation has no available adapter.");
      if (["tasks.delete", "links.delete", "files.delete", "media.delete"].includes(action.operation)) {
        const isConfirmed = Boolean(
          action.input?.confirm === true ||
          action.input?.confirmed === true ||
          action.approvalReason
        );
        if (!isConfirmed) {
          throw new SpaceConflictError(`Destructive operation ${action.operation} requires explicit confirmation (confirm: true) or approvalReason.`);
        }
      }
      // The id may come as id, {id}, {paneId}/{artifactId} or a path naming artifact:… (files.preview "expected string" x11, 18/11).
      const input = { ...(action.input as Record<string, unknown>) };
      const fromInput = (key: string) => {
        const value = typeof input[key] === "string" ? (input[key] as string).trim() : "";
        if (!value || (key === "paneId" && route.scope !== "pane") || (key === "artifactId" && route.scope !== "artifact")) return undefined;
        return key === "path" ? (route.scope === "artifact" ? ARTIFACT_IN_PATH.exec(value)?.[0] : undefined) : value;
      };
      const idKey = action.id ? undefined : ["id", "paneId", "artifactId", "path"].find(fromInput);
      let effectiveId = action.id ?? (idKey ? fromInput(idKey) : undefined);
      if (idKey && route.path.includes(":id")) delete input[idKey];
      if (route.scope === "artifact" && effectiveId && ARTIFACT_IN_PATH.test(effectiveId)) effectiveId = ARTIFACT_IN_PATH.exec(effectiveId)![0];
      if(route.path.includes(":id")&&!effectiveId)throw new SpaceConflictError(`${action.operation} needs id: the ${route.scope === "artifact" ? "artifact id (artifact:...), not a file path (space_files_read reads a path)" : route.scope === "pane" ? "pane id, as id or input.paneId (inspect STATE or space_room_status lists each pane's id)" : "resource id"}.`);
      if(route.scope==="pane"){
        const pane=await store.getPane(effectiveId!);
        if(pane.roomId!==roomId)throw new SpaceConflictError("Pane is outside this room.");
        // Move, split and update are layout/metadata ops that never drive the CLI: a shell pane (no runtime) moves too (22/11).
        // Daily Nous errors (22/11 ×3, "already closed and cannot be moved"): a closed pane has no place to leave; a no-op naming why, for every caller.
        if(action.operation==="panes.move"&&pane.isClosed)return {ok:true,noop:`Pane ${pane.title} is closed: nothing moved. A closed pane needs no move; to have it in the other room, reopen it (space_execute {kind:"pane",operation:"reopen"}) and move it then.`};
        if(typeof input.terminalRuntimeId==="string"&&!supportsControlRuntime({mode:"TERMINAL",terminalRuntimeId:input.terminalRuntimeId} as Pane))throw new SpaceConflictError("Unsupported CLI runtime.");
      }
      if(route.scope==="artifact"){
        const item=await store.getArtifact(effectiveId!);
        if(item.roomId!==roomId)throw new SpaceConflictError("Artifact is outside this room.");
      }
      let targetUrl = route.path.replace(":id",encodeURIComponent(effectiveId??""));
      if (route.method === "GET" && Object.keys(input).length > 0) {
        const queryParams = new URLSearchParams();
        for (const [key, value] of Object.entries(input)) {
          if (value !== undefined && value !== null && !(effectiveId && value === effectiveId)) queryParams.set(key, String(value));
        }
        const qs = queryParams.toString();
        if (qs) targetUrl += (targetUrl.includes("?") ? "&" : "?") + qs;
      }
      const invokeBody = route.method === "GET" ? undefined : { ...input };
      if (action.operation === "panes.update" && invokeBody && "accountProfileId" in invokeBody && (await store.getPane(effectiveId!)).mode === "TERMINAL") {
        throw new SpaceConflictError("panes.update does not change a CLI pane's account: use configure with accountProfileId on the pane.");
      }
      if (invokeBody && route.path.includes(":id")) {
        delete invokeBody.id;
        for (const key of ["artifactId", "paneId"]) if (invokeBody[key] === effectiveId) delete invokeBody[key];
      }
      if (invokeBody && ("confirm" in invokeBody || "confirmed" in invokeBody)) {
        delete invokeBody.confirm;
        delete invokeBody.confirmed;
      }
      return controlInvoke(actor.id,route.method,targetUrl,invokeBody);
    }
    if(action.kind==="cli"){
      const runtimeId=cliToggleRuntimeIdSchema.parse(action.runtimeId);
      const preview=action.enabled?null:await cliRuntimeVisibility.createDisablePreview(runtimeId);
      return controlInvoke(actor.id,"PATCH",`/api/cli/runtime-settings/${encodeURIComponent(runtimeId)}`,
        {enabled:action.enabled,...(preview?{confirmationToken:preview.confirmationToken}:{})});
    }
    if(action.kind==="vpn"){
      if(action.operation==="rotate"){
        if(!action.profile)throw new SpaceConflictError("Choose an available VPN profile.");
        return controlInvoke(actor.id,"POST",`/api/cli/egress/profiles/${action.profile}/random-city`);
      }
      const runtimeId=cliToggleRuntimeIdSchema.parse(action.runtimeId);
      return controlInvoke(actor.id,"PATCH",`/api/cli/runtime-settings/${encodeURIComponent(runtimeId)}/vpn`,{enabled:action.enabled});
    }
    throw new SpaceConflictError("Unsupported integration action.");
  }
  return { controlIntegration };
}
