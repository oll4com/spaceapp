import { auditTerminalRender, retainedTerminalRender } from "../terminal-render/terminal-render-sampler.js";
import { useEffect, useRef, useState } from "react";
import type { ControlAction, ControlLayout } from "@space/contracts";
import { getSpaceRuntime } from "../../runtime/SpaceRuntime.js";
import { inspectPlaybackTargets, runExtendedPlaybackCommand } from "./room-playback-control.js";
import { applyControlVoicePreferences } from "./control-voice-preferences.js";
import { readUiTheme, writeUiTheme, readModernAppearance, writeModernAppearance, UI_THEME_STORAGE_KEY, MODERN_APPEARANCE_STORAGE_KEY } from "../../ui-theme.js";
const TERMINAL_FONT_SIZE_STORAGE_KEY = "space.terminal.fontSize";
const UI_ZOOM_STORAGE_KEY = "space.ui.zoom.v1";
let csrfCache:{value:string;expiresAt:number}|null=null;
export async function controlRequest<T>(path:string,body?:unknown):Promise<T>{
 const runtime=getSpaceRuntime();
 if(runtime.kind!=="live")throw new Error("Space control is available in live mode only.");
 const headers:Record<string,string>={};
 if(body!==undefined){
  if(!csrfCache||csrfCache.expiresAt<Date.now()){
   const csrf=await runtime.platform.fetch("/api/auth/csrf",{credentials:"same-origin",signal:AbortSignal.timeout(5000)});
   if(!csrf.ok)throw new Error("Authentication is required.");
   csrfCache={value:(await csrf.json()).csrfToken,expiresAt:Date.now()+60_000};
  }
  headers["x-space-csrf-token"]=csrfCache.value;headers["content-type"]="application/json";
 }
 const response=await runtime.platform.fetch(`/api/control/v1/${path}`,{method:body===undefined?"GET":"POST",credentials:"same-origin",headers,signal:AbortSignal.timeout(8000),...(body===undefined?{}:{body:JSON.stringify(body)})});
 if(!response.ok){if(response.status===401||response.status===403)csrfCache=null;throw new Error("Space control request failed.");}
 return response.json();
}
async function waitForControlDom(check:()=>boolean){
 const until=Date.now()+3000;
 do{await new Promise(resolve=>setTimeout(resolve,50));if(check())return true;}while(Date.now()<until);
 return false;
}
export function paneElements(roomId:string){return [...document.querySelectorAll<HTMLElement>("[data-space-pane-id]")].filter(e=>e.dataset.spaceRoomId===roomId&&(e.offsetWidth>0||e.getBoundingClientRect().width>0));}
function applyControlAppearance(input: Record<string, unknown>): { ok: boolean; evidence: Record<string, unknown> } {
  const storage = getSpaceRuntime().platform.localStorage;
  const theme = input.theme;
  const appearance = input.appearance;
  const zoomLevel = input.zoomLevel;
  const terminalFontSize = input.terminalFontSize;
  if (theme !== undefined && (theme !== "classic" && theme !== "modern" && theme !== "codex" && theme !== "motion")) return { ok: false, evidence: { applied: false, reason: "Unsupported UI theme." } };
  if (appearance !== undefined && (appearance !== "system" && appearance !== "dark" && appearance !== "light")) return { ok: false, evidence: { applied: false, reason: "Unsupported color mode." } };
  if (zoomLevel !== undefined && (typeof zoomLevel !== "number" || zoomLevel < 50 || zoomLevel > 200)) return { ok: false, evidence: { applied: false, reason: "UI zoom must be between 50 and 200 percent." } };
  if (terminalFontSize !== undefined && (typeof terminalFontSize !== "number" || terminalFontSize < 8 || terminalFontSize > 32)) return { ok: false, evidence: { applied: false, reason: "Terminal font size must be between 8 and 32 pixels." } };
  try {
    if (theme !== undefined) writeUiTheme(storage, theme as "classic" | "modern" | "codex" | "motion");
    if (appearance !== undefined) writeModernAppearance(storage, appearance as "system" | "dark" | "light");
    if (zoomLevel !== undefined) storage.setItem(UI_ZOOM_STORAGE_KEY, String(zoomLevel));
    if (terminalFontSize !== undefined) storage.setItem(TERMINAL_FONT_SIZE_STORAGE_KEY, String(terminalFontSize));
    const observed = {
      theme: readUiTheme(storage),
      appearance: readModernAppearance(storage),
      zoomLevel: Number(storage.getItem(UI_ZOOM_STORAGE_KEY) ?? "100"),
      terminalFontSize: Number(storage.getItem(TERMINAL_FONT_SIZE_STORAGE_KEY) ?? "12")
    };
    if ((theme !== undefined && observed.theme !== theme) || (appearance !== undefined && observed.appearance !== appearance) || (zoomLevel !== undefined && observed.zoomLevel !== zoomLevel) || (terminalFontSize !== undefined && observed.terminalFontSize !== terminalFontSize)) {
      return { ok: false, evidence: { applied: false, persisted: false, observed } };
    }
    document.documentElement.dataset.uiTheme = observed.theme;
    document.documentElement.dataset.uiAppearance = observed.appearance;
    document.documentElement.style.zoom = `${observed.zoomLevel}%`;
    return { ok: true, evidence: { applied: true, persisted: true, adapter: "BROWSER_APPEARANCE", preferences: observed } };
  } catch (error) {
    return { ok: false, evidence: { applied: false, persisted: false, reason: error instanceof Error ? error.message : "Appearance preference storage failed." } };
  }
}
export function verifyControlLayout(roomId:string,layout:ControlLayout|null,order:string[]){
 const elements=paneElements(roomId);
 const byId=new Map(elements.map(e=>[e.dataset.spacePaneId!,e]));
 if(order.some(id=>!byId.has(id)))return false;
 if(layout?.mode==="CUSTOM")return layout.placements.filter(p=>order.includes(p.paneId)).every(p=>{
  const e=byId.get(p.paneId);if(!e)return false;
  const b=e.getBoundingClientRect(),parent=e.offsetParent?.getBoundingClientRect();if(!parent)return false;
  return Math.abs(b.left-parent.left-parent.width*p.x/100)<3&&Math.abs(b.top-parent.top-p.y*12)<3&&Math.abs(b.width-parent.width*p.width/100)<3&&Math.abs(b.height-p.height*12)<3;
 });
 const actual=elements.filter(e=>order.includes(e.dataset.spacePaneId!)).sort((a,b)=>{
  const x=a.getBoundingClientRect(),y=b.getBoundingClientRect();return Math.abs(x.top-y.top)>3?x.top-y.top:x.left-y.left;
 }).map(e=>e.dataset.spacePaneId!);
 return actual.join("|")===order.join("|");
}
export function useSpaceControlClient(roomId:string|null,enabled:boolean,activateRoom:(id:string)=>Promise<void>,focusPane:(id:string)=>void,pollIntervalMs=2500){
 const id=useRef(`control-client:${crypto.randomUUID()}`);
 const callbacks=useRef({activateRoom,focusPane});callbacks.current={activateRoom,focusPane};
 const applied=useRef(new Map<string,{promise:Promise<any>;settled:boolean}>());
 const [layouts,setLayouts]=useState<Record<string,ControlLayout|null>>({});
 useEffect(()=>{
  if(!roomId||!enabled||getSpaceRuntime().kind!=="live")return;
  let disposed=false,running=false;
  const isCurrent=(expiresAt:number)=>!disposed&&expiresAt>Date.now()&&document.visibilityState==="visible"&&document.hasFocus();
  const run=async(action:ControlAction,expiresAt:number):Promise<any>=>{
   if (!isCurrent(expiresAt)&&action.kind==="pane"&&action.operation==="visual_audit")return {ok:false,evidence:{observation:null,reason:"CLIENT_CHANGED",capture:action.captureScreenshot?"UNAVAILABLE":"NOT_REQUESTED"}};
   if (!isCurrent(expiresAt)) return { ok: false, evidence: { applied: false, reason: "The selected control client changed or the command expired." } };
   if(action.kind==="resource"&&action.operation==="settings.voice")return applyControlVoicePreferences(action.input,()=>isCurrent(expiresAt));
   if(action.kind==="resource"&&(action.operation==="ui.theme"||action.operation==="ui.scale"||action.operation==="settings.appearance")) {
    if(!isCurrent(expiresAt)) return { ok:false, evidence:{ applied:false, reason:"The selected control client changed or the command expired." } };
    const input = action.operation === "ui.theme" ? { theme: action.input.theme } : action.operation === "ui.scale" ? { zoomLevel: action.input.zoomLevel } : action.input;
    return applyControlAppearance(input);
   }
   if(action.kind==="pane"&&action.operation==="visual_audit") {
    const paneId=action.target.paneIds?.[0];
    if(!paneId) return {ok:false,evidence:{observation:null,reason:"UNMOUNTED",capture:"NOT_REQUESTED"}};
    const observation=auditTerminalRender(roomId,paneId);
    return {ok:true,evidence:{observation,capture:action.captureScreenshot?"UNAVAILABLE":"NOT_REQUESTED",
      ...(action.captureScreenshot?{reason:"CAPTURE_UNAVAILABLE"}:{})}};
   }
   if(action.kind==="playback")return runExtendedPlaybackCommand(roomId,action);
   if(action.kind==="room"&&action.operation==="activate"&&action.targetRoomId){
    await callbacks.current.activateRoom(action.targetRoomId);
    return waitForControlDom(()=>[...document.querySelectorAll<HTMLElement>("[data-room-runtime-id]")].some(e=>e.dataset.roomRuntimeId===action.targetRoomId&&e.dataset.presentationState==="displayed"));
   }
   if(action.kind==="pane"&&action.operation==="focus"){
    const paneId=action.target.paneIds?.[0];if(!paneId)return false;
    const element=paneElements(roomId).find(e=>e.dataset.spacePaneId===paneId);if(!element)return false;
    callbacks.current.focusPane(paneId);element.scrollIntoView({block:"nearest"});
    return waitForControlDom(()=>paneElements(roomId).some(e=>e.dataset.spacePaneId===paneId&&e.classList.contains("is-target")));
   }
   if(action.kind==="layout"){
    const snapshot=await controlRequest<{layout:ControlLayout|null;panes:Array<{id:string;order:number;isClosed:boolean;isMinimized:boolean}>}>("inspect",{roomId,section:"STATE"});
    setLayouts(old=>({...old,[roomId]:snapshot.layout}));
    const order=snapshot.panes.filter(p=>!p.isClosed&&!p.isMinimized).sort((a,b)=>a.order-b.order).map(p=>p.id);
    const until=Date.now()+3000;
    do{await new Promise(r=>setTimeout(r,50));if(verifyControlLayout(roomId,snapshot.layout,order))return true;}while(Date.now()<until&&!disposed);
   }
   if(action.kind==="screenshot"){
    return captureClientScreenshot(roomId, action);
   }
   return false;
  };
  const release=()=>{void controlRequest("client/release",{clientId:id.current}).catch(()=>{});};
  const poll=async()=>{
   if(disposed||running)return;
   if(document.visibilityState!=="visible"||!document.hasFocus()){release();return;}
   running=true;
   try{
    const geometry=paneElements(roomId).slice(0,64).map(e=>{const b=e.getBoundingClientRect();return {paneId:e.dataset.spacePaneId!,x:b.x,y:b.y,width:b.width,height:b.height};});
    const {commands,layout}=await controlRequest<{commands:Array<{id:string;roomId:string;expiresAt:number;action:ControlAction}>;layout:ControlLayout|null}>("client",{roomId,clientId:id.current,targets:inspectPlaybackTargets(roomId),geometry,...(retainedTerminalRender(roomId).length?{terminalRender:retainedTerminalRender(roomId)}:{})});
    if(disposed)return;
    setLayouts(old=>JSON.stringify(old[roomId])===JSON.stringify(layout)?old:{...old,[roomId]:layout});
    for(const command of commands){
     if(command.roomId!==roomId||!isCurrent(command.expiresAt))continue;
     let pending=applied.current.get(command.id);
     if(!pending){
      const entry={promise:run(command.action,command.expiresAt).catch(error=>({ok:false,evidence:{applied:false,reason:error instanceof Error?error.message:"Client control failed."}})),settled:false};
      void entry.promise.finally(()=>{entry.settled=true;});pending=entry;applied.current.set(command.id,entry);
     }
     void pending.promise.then(async res=>{
       const ok = typeof res === "boolean" ? res : Boolean(res?.ok);
       const evidence = typeof res === "object" && res && "evidence" in res && res.evidence ? res.evidence : { applied: ok };
       await controlRequest("client/ack",{clientId:id.current,id:command.id,ok,evidence});
     }).catch(()=>{});
    }
    for(const [key,value] of applied.current){if(applied.current.size<=256)break;if(value.settled)applied.current.delete(key);}
   }catch{/* Disconnected controls do not change terminal attachment or room lifecycle. */}
   finally{running=false;}
  };
  void poll();const timer=setInterval(()=>void poll(),pollIntervalMs);
  window.addEventListener("blur",release);
  return ()=>{disposed=true;clearInterval(timer);window.removeEventListener("blur",release);release();};
 },[roomId,enabled,pollIntervalMs]);
 return layouts;
}

export function captureClientScreenshot(_roomId: string, _action?: { format?: string; quality?: number; maxWidth?: number; maxHeight?: number }) {
  // Drawing DOM boxes/text on a canvas is not a capture of the screen. Browser
  // display capture requires an explicit user gesture and a browser permission.
  return { ok: false, evidence: { applied: false, reason: "No authenticated screen capture source is available to this control. Use the Live Screen button to share a real image." } };
}
