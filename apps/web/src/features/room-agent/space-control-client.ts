import { useEffect, useRef, useState } from "react";
import type { ControlAction, ControlLayout } from "@space/contracts";
import { getSpaceRuntime } from "../../runtime/SpaceRuntime.js";
import { inspectPlaybackTargets, runExtendedPlaybackCommand } from "./room-playback-control.js";
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
export function paneElements(roomId:string){return [...document.querySelectorAll<HTMLElement>("[data-space-pane-id]")].filter(e=>e.dataset.spaceRoomId===roomId&&e.getBoundingClientRect().width>0);}
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
export function useSpaceControlClient(roomId:string|null,enabled:boolean,activateRoom:(id:string)=>Promise<void>,focusPane:(id:string)=>void){
 const id=useRef(`control-client:${crypto.randomUUID()}`);
 const callbacks=useRef({activateRoom,focusPane});callbacks.current={activateRoom,focusPane};
 const applied=useRef(new Map<string,{promise:Promise<boolean>;settled:boolean}>());
 const [layouts,setLayouts]=useState<Record<string,ControlLayout|null>>({});
 useEffect(()=>{
  if(!roomId||!enabled||getSpaceRuntime().kind!=="live")return;
  let disposed=false,running=false;
  const run=async(action:ControlAction):Promise<boolean>=>{
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
   return false;
  };
  const release=()=>{void controlRequest("client/release",{clientId:id.current}).catch(()=>{});};
  const poll=async()=>{
   if(disposed||running)return;
   if(document.visibilityState!=="visible"||!document.hasFocus()){release();return;}
   running=true;
   try{
    const geometry=paneElements(roomId).slice(0,64).map(e=>{const b=e.getBoundingClientRect();return {paneId:e.dataset.spacePaneId!,x:b.x,y:b.y,width:b.width,height:b.height};});
    const {commands,layout}=await controlRequest<{commands:Array<{id:string;roomId:string;expiresAt:number;action:ControlAction}>;layout:ControlLayout|null}>("client",{roomId,clientId:id.current,targets:inspectPlaybackTargets(roomId),geometry});
    if(disposed)return;
    setLayouts(old=>JSON.stringify(old[roomId])===JSON.stringify(layout)?old:{...old,[roomId]:layout});
    for(const command of commands){
     if(command.expiresAt<=Date.now())continue;
     let pending=applied.current.get(command.id);
     if(!pending){
      const entry={promise:run(command.action).catch(()=>false),settled:false};
      void entry.promise.finally(()=>{entry.settled=true;});pending=entry;applied.current.set(command.id,entry);
     }
     void pending.promise.then(async ok=>{await controlRequest("client/ack",{clientId:id.current,id:command.id,ok,evidence:{applied:ok}});}).catch(()=>{});
    }
    for(const [key,value] of applied.current){if(applied.current.size<=256)break;if(value.settled)applied.current.delete(key);}
   }catch{/* Disconnected controls do not change terminal attachment or room lifecycle. */}
   finally{running=false;}
  };
  void poll();const timer=setInterval(()=>void poll(),500);
  window.addEventListener("blur",release);
  return ()=>{disposed=true;clearInterval(timer);window.removeEventListener("blur",release);release();};
 },[roomId,enabled]);
 return layouts;
}
